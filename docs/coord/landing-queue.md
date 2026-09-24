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
