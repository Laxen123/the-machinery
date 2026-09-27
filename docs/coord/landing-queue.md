# The landing queue

Work can be executed in parallel — many agents, many branches, no contention — right up until it has
to be merged back into one shared trunk. Merging is where parallelism stops being free: a merge
typically rebases the branch onto the trunk's current tip, and if a second merge changes that tip
while the first merge's rebase is still in flight, the first rebase is now stale against a trunk
that moved out from under it. Two sessions convinced they are both about to land cleanly can
leapfrog each other indefinitely — each one's merge invalidates the other's, both keep re-rebasing,
and no work actually lands while wall-clock burns. The failure this queue exists to prevent is
exactly that livelock: uncoordinated parallel merges racing each other into one trunk, with no
natural way for either side to notice it lost until it has already redone the work.

## FIFO ticketing

Every agent that wants to merge first gets in line. The line is written with the same
compare-and-swap discipline described in `claims.md`: an enqueue operation appends an entry by
pushing a commit to a shared queue ref, and if a rival's append lands first, the loser's append is
rejected, re-read, and re-applied on top of the winner's — so queue order simply _is_ push order on
the shared remote, without any separate ordering field to keep consistent. Only the entry at
position one — the head — is admitted to the merge window **by default**; everyone else waits. The
one documented exception is a head that is legitimately parked mid-conflict-resolution, which a
waiter whose data footprint cannot collide with it may pass — the scoped mutex described in the next
section is what decides "cannot collide," and "Stale head vs. live head" below covers the passing
mechanics in full.

**What it costs:** every merge waits its turn, including a merge that touches nothing another
in-flight merge could conflict with. This looks wasteful for the "obviously safe" cases, and it is
tempting to exempt them. It doesn't work: exempting any class of merge from the queue means the
trunk can advance while a queued mutating merge is mid-rebase, which reproduces the exact livelock
the queue exists to prevent — the whole point is that _any_ trunk advance invalidates an in-flight
rebase, not just an advance from another mutating merge. The queue's cost is therefore a floor, not
a tunable: every merge, without exception, enters the queue and pays for the ordering guarantee.

Note what that "without exception" does and does not say. It is about **admission**: no class of
merge is exempt from queueing, however obviously safe it looks. It is not about **order within the
queue** — the parked-head exception above moves a waiter's position, it does not let that waiter
merge outside the queue. Those are different guarantees, and only the first one is absolute.

**What it buys:** no two sessions ever rebase onto each other's moving target. A merge either fully
lands or is cleanly rejected before it starts mutating the trunk; there is no partially-applied,
half-rebased state for anyone to inherit.

## A second, scoped mutex on top of FIFO

FIFO order answers "whose turn is it to merge." It does not, by itself, answer a narrower and more
valuable question: when a merge mutates a large shared dataset that many items write into, do two
such merges actually _need_ to serialize against each other, or only against the ones touching the
same slice of that data? A dataset that can be sharded — split into disjoint regions that never
overlap in normal use — lets a second, scoped lock answer that question precisely: two merges whose
write footprints fall into entirely disjoint shards are conflict-free by construction and never
contend, while two merges touching the _same_ shard still serialize exactly as if there were only
one lock. A merge whose footprint cannot be computed cleanly (or that touches something outside the
sharded structure entirely) falls back to treating itself as touching everything, which is always
safe, merely conservative.

The two mechanisms answer different questions and compose rather than substitute for each other:
FIFO decides who advances to the head of the queue next; the scoped mutex decides, once something is
trying to actually run its merge, whether it truly needs to wait for another live merge or can
proceed because their data footprints cannot possibly collide. A design that only had the scoped
mutex would still livelock on the ordering question above; a design that only had FIFO would waste
real wall-clock serializing merges that could safely run together.

## Queue slot = readiness

**A queue slot means "reviewed, done, merge now" — not "I have started landing".** The failure this
rule exists for: an item enqueues after a review, reaches the head, and then runs another review,
fixes a newly found bug and commits new code while still holding the head — every item behind it
waits on work that was not ready when it took the slot. Queue position is not readiness.

- **Enqueue only at true finality:** after the final review verdict, with every finding
  dispositioned and every pre-queue gate green. The land spine orders every gate before its own
  enqueue, so an item that follows the spine cannot enqueue early by accident; do not enqueue
  intending to keep working.
- **Enqueueing without a current review is refused, not warned.** A reviewable diff whose HEAD
  carries no current sha-pinned review verdict — none at all, or one pinned to an older sha, meaning
  the item was reworked after review — is refused a slot and stops at the review seam. The
  mechanical re-pin of a verdict after a pure rebase (same content, new base) runs before this
  check, so a rebase alone never trips it.
- **Release on reopen: dequeue, not requeue; re-entry is always at the tail.** If, while queued or at
  the head, the item is reworked — a new commit changes its content, or it is reviewed again — it
  releases its slot (`node scripts/landing-queue.mjs dequeue <slug>`), does the rework outside the
  queue, and re-enters when actually ready. The head is the land mutex, not a waiting room, and an
  item carries no priority: if it was not ready when its turn came, it has no claim on the place it
  lost, so re-entry is a plain tail enqueue whether the slot was given up voluntarily or taken away
  for going stale. The spine automates the release when it detects rework (a verdict re-pin refused
  because the content changed); a rework re-entry still writes a distinct audit line, but it carries
  no position. `requeue` is not a release — into an empty queue it is a no-op, which lets an unready
  item drain straight back to the head — and belongs to the spine's own bounded in-attempt conflict
  handling, not to open-ended rework. After releasing, wait like any other waiter: attended, with
  `node scripts/landing-queue-watch.mjs <slug>`; unattended, with
  `node scripts/done-worktree.mjs <slug> --wait-chunk`.
- **Waiters demote a stale head mechanically.** Both wait loops try `demote` against a head that is
  hogging the slot, and the queue takes it only when every condition holds: the demoter is queued
  behind the head, the head's heartbeat is older than a fixed threshold (the spine refreshes the
  heartbeat at every step, so an active land stays fresh), the head is not actually merging, and the
  same item has not already been demoted more than a small number of times in the last day (past
  that cap, the stronger, human-confirmed removal is the recourse). A demote moves the entry to the
  tail in one atomic write and can never remove it, so a false demote costs position, never work.
- **Eviction does not need a live waiter.** Demotion and reaping otherwise fire only from inside a
  waiter's own loop, so a queue whose head and waiters are all dead sessions has nobody left to run
  them. Two closures reuse the same verdicts unchanged: every queue mutation (an enqueue always, a
  heartbeat at most every few minutes) evaluates the head after its own write, so a fresh arrival
  behind a dead head evicts it immediately; and `node scripts/landing-queue.mjs sweep [--json]` is a
  caller that is not a queue member at all — it prunes entries whose work already landed, then asks
  demote and reap _as if_ from a hypothetical tail waiter. The membership check is satisfied, never
  weakened: the ghost waiter is added to the verdict's view only, and every other condition still
  runs on the real entries. The sweep never steals (a steal needs a holder-gone assertion an
  unattended process cannot make), is idempotent and safe from any checkout, exits 0 when there is
  nothing to do and 2 only when it cannot read enough to judge. Run it on a short schedule on an
  always-on host.
- **The branch meets the trunk before it takes a slot.** The spine rebases onto the trunk and
  re-pins its sha-pinned markers in the last step before the enqueue, so the head visit is
  merge-only instead of a conflict-resolution session that stales the review and costs the slot.
  The freshen is opportunistic: already current is a silent no-op, and a conflict aborts its own
  rebase and enqueues unfreshened rather than losing the land a place it never had.
- **No sync at all for a coordination-only trunk delta.** When every path the trunk moved since the
  merge base sits under a configured coordination root (`land.coordinationOnlyPathPrefixes`), the
  branch carries no commit grafted from a local trunk, its tip is published, and a dry-run merge is
  clean, both the pre-queue freshen and the at-head rebase are skipped, with one log line saying
  why — otherwise a land ends up chasing the queue's own bookkeeping commits. Paths decide, never
  commit subjects. The merge itself stays pinned to the tip the land validated: after every
  spine-owned re-sha that tip is re-proven (every marker family re-pins with a content-identity
  proof and the findings gate is still clear) rather than carried, and a remote branch that moved
  past the validated tip — a force-push after review — is refused at the merge and restarts the
  land from the top.
- **A gate proof survives a sibling's land.** The once-per-land remainder a re-entered gate re-runs
  over is intersected with what the branch itself changed, so paths a sibling moved — already gated
  by that sibling's own land — never force a re-proof (see `land-spine.md` § The once-per-land proof
  cache).
- **A gate that goes red at the head gets one isolated re-run before the slot is surrendered.**
  Bounded in files and minutes, refused outright when the failure set cannot be proven whole, and
  red-in-isolation is never self-healed. Without it, a pure load flake costs a dequeue and a full
  re-wait at the tail for a merge that then takes two minutes.
- **A long quiet wait does not go stale.** The watcher refreshes the heartbeat at every queue
  position, not only near the head, so an item that waited a long time at a deep position is not
  demoted just as it arrives.
- **For a batch slot, "done" means the whole batch is done** — every riding member green under the
  one review, any derailed member already dropped from the batch — never a batch with a member still
  running.

## Leaving the queue on rework, re-entering at the back

An item that needs more work before it can actually merge — a review finding to address, a conflict
to resolve from scratch — should not sit in the queue holding its slot while that work happens. It
leaves the queue (a deliberate dequeue) and re-enters, once ready, at the **back** — never at its
old position. Holding a slot is an implicit promise: "I am at or near the front of the line and
about to merge." Rework breaks that promise, and keeping the slot anyway means everyone behind waits
on work that has not even started yet. There is exactly one exception in the other direction: never
dequeue a slot that is actively merging, or one that is legitimately paused mid-merge waiting on a
conflict resolution — those states are owned by whatever process put them there, and only that
process (or its successor, on an explicit takeover) may resolve them.

## Holding the head while idle is the worst failure

Every other failure mode in this design costs the _item_ that failed something — a wasted rebase, a
slot lost, a rework cycle. A head that stops making progress without releasing its slot costs
**everyone behind it**: nothing can advance until that slot clears, so one dead session can freeze
the entire queue. Every design choice downstream follows from taking that asymmetry seriously:

- Every exit path — success, failure, a deliberate hand-off, a session ending mid-task — dequeues
  before it ends the run, unless the run is actually still merging. An "I'm done, nothing more to do
  here" exit that forgets to dequeue is indistinguishable, from the outside, from a session that is
  still working; it leaves a headless slot that will eventually be promoted to head and then simply
  sits there, dead, until something notices.
- A head is judged alive or dead by an explicit **heartbeat** — a timestamp it refreshes as it makes
  real progress — never by mere elapsed time. A merge that is legitimately deep in conflict
  resolution can hold the head for a long time and still be perfectly healthy, as long as it keeps
  refreshing the heartbeat; only a heartbeat that goes stale past a defined threshold makes that
  slot eligible for someone else to act on.
- Recovery from a stuck or dead head is **not** one blunt "kill it" verb. A live-but-off-to-the-side
  head (not currently merging) can be nondestructively moved to the tail — cheap, reversible, and
  safe to do without much ceremony. A head that appears fully dead needs a stronger action —
  actually removing its slot — which is why that action is bounded by a stricter liveness check and,
  on the path where liveness truly cannot be proven mechanically, a human confirmation that the
  holder really is gone. A head that is alive and legitimately parked mid-conflict-resolution is
  protected from both of those and can only be passed, not evicted — and even that passing is
  limited to compatible, non-conflicting waiters, so a parked head never loses more than its
  position, never its work.

## Chunked, resumable waiting

Waiting for a turn should never cost the resource that makes an agent expensive to run in the first
place. A synchronous block — an agent that just sits there, actively "thinking," until it is finally
head — burns real compute for the entire wait, and a cold, uncached wait can be an order of
magnitude more expensive to resume than a warm one. Instead, waiting is delegated to a lightweight,
external, mostly-idle poller: it checks queue status on a modest cadence (backing off further while
far from the head, tightening as the wait nears its end), and only wakes the actual reasoning agent
when something has genuinely changed — it became head, it was displaced, or the whole wait finally
timed out. A hard ceiling on total wait time exists so this never becomes an unbounded hang; past
that ceiling, the waiting agent is told plainly that it is still not head, rather than left to
guess.

Because the wait is externalized, a failure of the _poller itself_ — a crash, a sleeping machine, a
restart — can silently produce no signal at all, and an agent that "should have been woken by now"
cannot tell that apart from a legitimately long queue from the inside. The mitigation is always the
same: the queue's own status is the ground truth, resolved fresh against the shared remote
regardless of whether any particular poller is still alive, so a session that suspects it was never
woken re-checks status directly rather than trusting silence as "still queued."

## Queue-waiter pre-convergence

The head slot is the serialization bottleneck, yet a naive queue defers all rebase-conflict work to
it: a conflict that has been on the trunk for hours is only discovered, and only resolved, once the
item finally reaches the head — burning the one slot nobody else can use. Pre-convergence moves that
work into the wait.

While an item waits at **position two or better**, the spine probes its branch against the fresh
trunk tip each poll with a non-mutating dry-run merge (`git merge-tree --write-tree`), cached by the
pair of trunk tip and branch tip. The probe is a trigger only — its report can differ from a real
rebase on renames and per-commit replay. What a conflicted probe does depends on who is waiting:

- **An attended waiter** (the foreground `--wait` mode) attempts the real rebase in its tree right
  away: heartbeat, rebase — recorded or trivial conflicts may replay with no session involvement,
  after which it force-pushes with lease and re-pins the review markers, carrying finding
  dispositions across the patch-identical re-sha — then heartbeat again. A **genuine** judgment
  conflict stops at the queue-wait seam with the slot **kept** and the conflicted rebase **left in
  progress** in the tree, mirroring the at-head holding contract. At most two such rounds per queue
  residency: the trunk can keep moving, and a late conflict still takes the at-head path.
- **Probe-only paths** (a non-waiting invocation near the head; unattended waiters never
  auto-resolve) attach the conflicted file list to the queue-wait seam as an advisory note.
  Resolution stays the session's judgment.

**The recipe when the seam fires:** resolve the conflicts in the tree; conclude
(`git rebase --continue`) and re-run the item's targeted tests; `git push --force-with-lease`; re-pin
the review record (automatic on a patch-identical re-sha, an explicit carry-forward of dispositions
after a content change); re-invoke the land — the kept slot means the head rebase then replays
clean.

**Why the slot is kept.** This is land mechanics, not review rework, so it is a deliberate carve-out
from "rework happens outside the queue". The stale-head demotion still runs on its own clock: a
resolution that leaves the entry silent past the threshold once it reaches the head can still be
moved to the tail, which costs position, never work.

**Composition with keep-hot preparation.** The detached queue watcher, by default, rebases a waiting
branch on any trunk advance at any position and re-validates its gates — and aborts on a genuine
conflict, because no session is present to conclude one. Pre-convergence is the conflict-focused,
near-head step, and leaves a genuine conflict in progress for an attended session. The two agree on
state (a pre-converged branch makes the next preparation a no-op and vice versa), but **never pair a
live watcher with an attended `--wait` session on the same item**: both mutate the same tree, and two
concurrent rebases collide on its index lock and rebase state. The waiter skips its round when it
finds a rebase already in progress, but that check-then-act window is not a mutex — pick one wait
mechanism per item.

## Stale head vs. live head, and why stealing is never automatic

The queue distinguishes "no news" from "dead" using exactly the heartbeat mechanism above, and
different recovery actions require different strengths of proof precisely because they cost
different amounts to get wrong:

- **Moving a live-but-idle head to the tail** costs that head nothing but its place in line — it can
  requeue immediately — so this can fire on a fairly generous, mechanical staleness threshold, no
  human needed.
- **Removing a slot outright** is a stronger, less easily undone action — potentially releasing
  other resources that slot was holding — so it requires clearer proof that the head is truly gone,
  not merely slow, and the strongest form of removal (displacing a head that shows every other sign
  of being mid-merge) deliberately still requires an explicit human confirmation that the holder is
  actually gone. Liveness across independent machines cannot always be proven mechanically — there
  is no universal way to reach out and ask a remote process "are you still there" — so where the
  mechanism cannot prove death, the design refuses to guess, and hands the call to a human instead.
- A softer, fully mechanical, first-line recourse exists for a head that is simply gone with no
  trace and past every other cap: it removes only the queue _entry_, nothing else, and is
  deliberately non-destructive — a head that was actually alive but merely wedged loses nothing but
  its place, exactly as if it had voluntarily left and requeued.

The general shape is: the cheaper and more reversible an action is, the more willing the design is
to let a mechanical clock trigger it automatically; the more expensive and irreversible an action
is, the more it insists on a human's explicit word that the irreversible step is actually safe.

See also: `claims.md` (the compare-and-swap discipline the queue itself is built from),
`plan-lanes.md` (the state an item is in before and after its landing), `land-spine.md`,
`worktrees.md`, `cloud-drains.md`.
