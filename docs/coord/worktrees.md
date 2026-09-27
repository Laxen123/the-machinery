# Worktrees

When more than one agent works against the same repository at the same time, each one needs its own
place to make changes without stepping on the others. A single shared checkout cannot do this
safely: switching that one checkout between branches is a global operation — the moment agent A
checks out branch A, every file on disk reflects branch A, including for agent B, who was mid-edit
on branch B. Two agents branch-switching one shared working tree do not merely slow each other down;
they actively overwrite each other's uncommitted work, and the failure is silent — nothing errors,
files just quietly hold the wrong content. The fix is structural rather than a discipline everyone
has to remember: give every concurrent piece of work its own working tree, cut from the trunk tip,
so that "whose files are these" is answered by which directory you are in, never by which command
ran most recently.

## One writer per tree

The rule this whole design serves is simple: **exactly one agent writes to any given working tree,
ever.** A working tree is not a scratch space two agents share by turns — it belongs to whichever
agent claimed the underlying unit of work, for the whole lifetime of that unit of work. This is
stronger than "don't edit the same file at the same time"; it holds even for files neither agent is
currently touching, because the danger is not a content conflict on one file, it is a structural
operation — a checkout, a reset, a branch switch — performed by one agent while another agent's
edits sit uncommitted in the same tree.

A repository's version-control tooling typically supports exactly this: several working trees, all
attached to one underlying repository, each an independent checkout with its own files and its own
index, but sharing the repository's object store and branch namespace underneath. That shared layer
is what makes the trees cheap to create (no need to re-clone the whole history each time) and what
makes "one writer per tree" sufficient — because the trees themselves never collide, the only
remaining collisions are over the parts that are genuinely shared, and those are few and enumerable
(see § Lock contention below).

## What is genuinely shared, and what has to be guarded

Every working tree cut this way still shares, with its siblings, one repository underneath: the same
object database (every commit, tree, and blob any tree can see), the same branch and tag namespace,
and the same small set of repository-level lock files a version-control tool uses to protect its own
metadata during a write. None of that is duplicated per tree. The consequence is that an operation
confined to one tree's own files and its own index — editing, staging, committing on that tree's own
branch — never touches a sibling tree at all, but an operation that reaches into the shared layer —
writing a ref, mutating shared repository metadata, running whole-repository maintenance — can
collide with a sibling tree doing the same thing at the same moment, regardless of which files
either tree has open. Structural safety at the file level does not, by itself, make every
shared-metadata write safe; it narrows the hazard down to a small, identifiable set of operations,
which is exactly what the guard layer in [`hooks.md`](hooks.md) targets.

## Never add a working tree by hand

Because a working tree is tied to a specific unit of work for its whole lifetime, creating one is
coupled to _claiming_ that unit of work — recording, in whatever coordination store the system uses,
that this agent and no other now owns it. A raw "create a new working tree" command skips that claim
entirely: it produces a tree with no owner recorded anywhere, which means a second agent can
legitimately believe the same unit of work is still unclaimed and start on it too — the exact
double-work race the claim exists to prevent. This is why the cutting step is always a purpose-built
tool rather than the raw underlying command: the tool claims the work item and cuts the tree as one
atomic step, and a bare invocation of the underlying command is flagged precisely because it cannot
make that same guarantee.

An **ownership guard** enforces the "one writer" rule at the tool layer rather than only in process:
the first agent to write into a freshly cut tree is recorded as its owner, and a later write attempt
by a _different_ agent identity into the same tree is denied outright, not merely discouraged. This
closes the gap every softer guard leaves open — an advisory claim record, a staleness heuristic —
all of which only matter if the acting agent actually reads and respects them. An ownership guard
that denies the write at the tool layer removes that dependency: a cross-owner write becomes
structurally impossible rather than merely against the rules. A dispatched helper working on behalf
of the tree's owner is not a different owner and is exempted from this check; the guard is aimed at
a second, independent top-level agent mistakenly entering a tree it does not own.

A companion guard keeps the _shared_ checkout — the one nothing is supposed to write into directly —
clean: an edit to a non-scratch, non-allowlisted path in that checkout is denied, forcing the edit
into a proper working tree instead. Loose, uncommitted dirt sitting in the one checkout every
coordination and merge operation depends on is exactly the kind of wedge that blocks every other
agent's merge attempt, so keeping that checkout provably clean is worth enforcing even though it
costs an extra tree for what might otherwise have been a two-line fix.

## Sparse checkouts as the default

A repository that has accumulated a large volume of committed data — generated artifacts, large
fixture sets, anything whose size is disproportionate to how often any given piece of work actually
touches it — pays that size cost on _every_ working tree cut from it, whether that unit of work
needs the data or not. A full checkout of such a repository can be gigabytes and tens of thousands
of files larger than the code most units of work actually change, and every file-system walk a
version-control command performs — status, add, commit, merge, reset, clean — scales with what is on
disk, not with what changed. At a large enough gap between "what's committed" and "what a typical
unit of work touches," that becomes the dominant cost of every routine operation in every tree.

The fix is to make the _default_ cut a **sparse** checkout: the tree is created without populating
its working directory in full, narrowed instead to a cone that excludes the small number of large,
rarely-needed directories, while everything a typical unit of work actually reads or writes stays on
disk exactly as before. The underlying object database and index still track every file — nothing is
actually missing from the tree's history or its ability to commit — only what is materialized to
disk changes. A unit of work whose SCOPE is known in advance to need one of the excluded areas is
cut dense instead, by the same tool, so the sparse default never forces an awkward workaround on the
work that genuinely needs the full tree.

**Widen in place, never re-cut.** When a sparse tree turns out to need one of the excluded areas
after all — a rebase brings in a change under it, or a check the tree is running turns out to read
it — the fix is a single, idempotent widen command that materializes everything, never a fresh cut
of a new tree (which would lose whatever uncommitted state the tree already held). Any check that
reads the excluded areas by design widens itself automatically before it runs, rather than trusting
every caller to remember to widen first. The reverse operation — narrowing a tree that no longer
needs the wide state, most usefully right before a build or another disk-hungry step near the end of
a unit of work's lifecycle — exists too, and refuses rather than silently discarding anything: it
checks for uncommitted changes under the areas it would remove and stops, naming the path, instead
of deleting work that exists nowhere else. Narrowing frees tracked files only: untracked output
written under an excluded area survives it, so the command reports what it freed and what remains,
measured from the file system rather than from the index.

All of these doors are one tool: `node scripts/cut-worktree.mjs <slug>` cuts (sparse unless a rule
says dense, `--dense` to force it), `--widen` and `--narrow` move an existing tree in either
direction, and `--widen --dir <path>` serves a caller that holds a checkout but no slug — it needs no
shared checkout at all, so it still works while that checkout is mid-merge.

**Exclude the heavy stores, not the folder that holds them.** The large directories rarely sit
alone: their parent usually also holds small contract files — schemas, thresholds, policy tables —
that code reads by path at import time. Excluding the whole parent takes those with it, and the
first symptom is not a clean "file not found" but an entire test collection failing to start. Name
the heavy stores individually instead; cone mode materializes an included directory's ancestors'
own files, so keeping the small siblings in the cone keeps the contracts on disk too.

**The dense-or-sparse decision is biased toward dense, and it says why.** The cut goes dense
whenever the unit of work's description names one of the excluded areas, whenever its
classification says it may write the large data, and whenever that classification is missing or the
description cannot be read at all — unknown is treated as the expensive case, never the cheap one.
The decision prints which rule fired, so a surprising dense cut is explainable without reading the
tool's source.

**Staging inside an excluded area needs the tree widened first.** In cone mode an ordinary `git add`
refuses a path outside the cone, so a script that writes and stages under an excluded store widens
before it runs. A rebase conflict inside an excluded store is the one exception git handles for
you: it materializes the conflicted file for resolution, the resolution is staged with
`git add --sparse <path>`, and `git sparse-checkout reapply` drops it off disk again.

**Only a tree the tooling cut sparse is ever widened by a gate.** A marker in the tree's private
admin directory, together with git's own worktree-scoped sparse flag, is the positive identity of
"this tree was cut sparse by the tool"; a hand-narrowed checkout, or any other sparse tree, is left
alone. A cone whose marker cannot be written is forced dense on the spot, so there is no
sparse-but-unmarked state for a gate to miss. The marker is a cache, not the truth: every call also
compares git's actual pattern list against the wanted one, so an interrupted apply or a hand edit of
the cone is repaired on the next call rather than trusted forever.

**A check that reads an excluded area widens up front, before it runs — never "run a subset, widen
and retry on red".** A test that skips when its data is absent passes green without testing
anything, and re-running on any red masks a genuine or flaky failure alike. The widen costs minutes
once per tree, and is paid only by work whose change can reach that check.

With the large-repository mode described below turned on, each tree runs its own file-system-watcher
daemon; one daemon per live tree is normal, not a leaked process, and a forced tree removal stops it.

## The finishing sequence

A unit of work's tree exists for exactly as long as the work is unfinished. The end-of-life sequence
is: verify every commit on the tree's branch is actually pushed somewhere durable, hand the branch
to the land spine (see [`land-spine.md`](land-spine.md)) to merge it into the trunk, and only then
tear the tree down. **A tree is never torn down while it holds unpushed commits** — doing so would
delete the only copy of that work, since the tree's branch, unlike the trunk, typically has no other
durable home until it lands. Automated teardown tooling checks for this before removing anything; a
tree that fails the check is left in place with the reason surfaced, never silently force-removed.

## Landed-work-reversion lint

The quietest way to lose landed work is a conflict "resolution" that is really a restore. A branch
that waited while siblings landed hits a conflict in a shared file; the resolver takes the branch's
own old copy of the whole file; git accepts it, because a resolution is whatever the resolver says
it is — and the siblings' changes to that file are gone from the trunk with no conflict ever shown.

The land spine runs an **advisory** lint for this, after its rebase and before the merge:

- **It asks what the land REMOVES from the trunk, not what the branch failed to absorb.** It builds
  the tree the merge would produce (`git merge-tree --write-tree <trunk> <branch>`) and takes the
  deletions of the trunk-to-that-tree diff. The obvious alternative — "what did the trunk change that
  the branch did not?" — is a staleness question, and under a merge-based land it is the wrong one:
  a region the branch never touched resolves to the trunk's side automatically, so that rule flags
  phantom hunks by the dozen, while it can miss the real case entirely (a branch rebuilt on the
  fresh trunk tip with an old whole-file copy has an empty base-to-trunk diff). Content the branch
  never absorbed is re-supplied by the three-way merge and can never be reported by the removal
  axis.
- **Attribution is the discriminator.** Every refactor deletes lines, so deletions alone mean
  nothing. For each file past a removal floor, the lint walks that file's recent trunk history,
  keeps the commits authored under a _different_ unit of work, and intersects the lines they added
  with the lines this land removes; only a substantial attributed overlap (tens of lines) is
  reported. A line that survives modulo whitespace — a wide table re-padded because one row was
  added — is discounted, so a reflow is not reported as lost work.
- **Out of scope by design:** coordination-only paths, and generated data trees that are rewritten
  whole-file by every legitimate update (every such rewrite removes another unit's lines); those
  trees are protected by the landing queue's scoped mutex instead. It fails open on any git error,
  including a conflicting `merge-tree`: a conflict is surfaced by the spine's own rebase and merge,
  and a conflicted merge cannot silently drop anything.

**Why it reports and never halts.** A halt needs a rule that separates an accidental restore from a
deliberate removal, and three families of rule fail at it. Topology cannot see intent: after the
spine's own rebase the merge base _is_ the trunk tip, so a "only lines added after the fork point"
rule attributes nothing on every branch. Content cannot see intent: every recorded firing of the
halting version was a deliberate rewrite or deletion that a person then had to release by hand. And
consequence is already measured: the land runs the full test suites before anything reaches the
trunk, so a removal that costs behaviour turns them red, and a removal that turns nothing red
removed no behaviour. The lint therefore front-runs the test gates with a receipt, where the person
reading the land log will see it.

**Reading an advisory.** A deliberate removal — a refactor, a regenerated artifact, code deleted
together with the tests that covered it — needs nothing. If a named line was _not_ meant to go, do
not restore a whole file the unit of work does not exclusively own: patch-replay the branch's own
diff onto the current trunk (`git apply --3way`, or cherry-pick its commits), and splice the needed
hunks into a shared file by hand when that does not apply cleanly. The same discipline governs any
post-conflict rebuild: start from the current trunk and re-apply the patch; never check out an old
copy of a shared file as a "resolution". To tell a rewrite from a restore by eye,
`node scripts/coord/assert-no-landed-reversion.mjs --explain <path>` pairs each dropped line with its
nearest surviving successor and names the file a relocated line moved to. Run bare, the same script
is a probe that exits non-zero on a sound finding; no land calls it that way.

A related, equally advisory probe runs while a land is still queued: whenever the trunk advances,
the queue watcher dry-runs the merge at any queue position and prints the conflicted paths and the
units of work that landed them, so reconciliation can happen during the wait instead of at the
head.

## Lock contention as a first-class hazard

Because the shared metadata layer described above is genuinely shared, **any** operation that reads
or writes it can collide with a concurrent write from a sibling tree — including an operation that
looks entirely read-only from the outside. A routine status check, for instance, still advances the
tree's own private bookkeeping as a side effect and briefly takes the same lock a write would; run
that status check from an automated poller on a tight interval, and it can collide with a
concurrent, tree-scoped operation like a rebase in that same tree, producing a spurious lock
contention error that has nothing to do with either operation's actual correctness. A read-only
poller that must run repeatedly and cheaply, without ever contributing to this contention, is
therefore built to pass a lock-free flag or use a lock-free code path rather than the tool's default
behavior — treating "this call must never block a concurrent write" as a first-class requirement of
the poller's design, not an incidental nicety.

The shared repository layer itself benefits from being told, up front, that it will hold an
unusually large number of tracked files and an unusually high rate of small metadata writes: a
large-repository mode that trades a small amount of per-command bookkeeping (a file-system watcher
that caches what changed since the last check, an index format that skips redundant integrity work
on every write) for a large reduction in the cost of every routine operation across every tree
sharing that repository. Combined with the sparse-checkout default above, the two levers address
different things — the large-repository settings cut the _per-command_ cost on a tree that is
already materialized, the sparse cone cuts the _file-count_ cost of materializing and walking the
tree in the first place — and a design that pays only one of these costs while ignoring the other
typically still pays for slow routine operations it did not have to.

## The coord-write critical section

Coordination writes — status-board rows, queue entries, work-item moves, review records — all go
through one disposable **coordination checkout** under one machine-wide coord-write lock, so the
shared checkout's HEAD never moves during a coordination write, and loose dirt in the shared
checkout can never refuse a sanctioned write. That lock is what every agent queues on, so how long
it is held matters more than almost anything else in the write path.

**The lock protects the coordination checkout, not the remote.** Measured on a busy machine, most of
a typical hold was network round-trip — the remote's ref listing and the fetch — spent inside the
mutex, and the pain was concentrated in bursts where dozens of writes chained back to back, not in
mean load. So a write now **hands the lock back after its commit** and spends the push and the
post-push verification unserialized. Inside the lock: freshen (fetch plus a fast-forward-only
merge), mutate, stage, commit, and — through a re-acquire — the rollback pair if the push is
rejected. Three invariants make the early release safe, and a change here must keep all three:

1. **The push names an immutable sha, never a symbol.** Once the lock is released, a sibling's next
   write resets that same coordination checkout to the remote tip, so pushing `HEAD` would push
   whatever landed there instead. The pushspec is `<pinned-sha>:refs/heads/<trunk>`; the object
   lives in the shared store and is pushable whatever HEAD now says, and ordinary ref-update rules
   still reject a stale base as non-fast-forward.
2. **The post-push check verifies the pinned sha reached the remote,** not `HEAD`. Checking `HEAD`
   would verify a sibling's tip the remote legitimately contains — a false pass while this write's
   own commit never landed. A failed verification throws to the caller as a non-zero exit, never a
   logged warning.
3. **The rollback is skipped when HEAD moved under it.** Undoing the commit (`reset --soft HEAD~1`)
   is only this write's to do while HEAD is still its commit; after a sibling's reset, the orphaned
   commit is an unreferenced object the next default-expiry garbage collection removes, and
   resetting would amputate the _sibling's_ commit. Skipping is safe either way, because the next
   attempt re-freshens onto the remote tip.

The early release is **opt-in per caller**: the checkout wrapper passes a lock handle as its
callback's second argument, and a caller forwards it to the write only when that write is the
callback's last mutation of the coordination checkout — anything that touches the tree afterwards
must keep the lock. A caller that ignores the handle keeps the whole-operation hold unchanged.

Every mutating coordination operation journals its phases (`start → release → start → done`), and
the recovery tooling closes an operation on any non-start line and reopens it on a fresh `start`. So
a crash inside the released window correctly reports nothing to heal — no lock is held, and the
orphan commit is collectable — while an interrupted operation is still told apart from one that
never ran.

**Trip conditions.** Re-read the journal before assuming the early release still pays. If rebases
forced by the push rise to more than a few percent of coordination writes, remote contention has
overtaken mutex contention and the push belongs back under the lock. If the median hold does not
fall, the hold was never network-dominated, and the local cost of many trees sharing one repository
is the real target.

## Stale index.lock self-heal

A tree's **own** index lock is a different contention class from the shared repository's lock. It
has two causes, and they need opposite handling:

- **A live holder from the same tree.** A plain `git status --porcelain` is itself a lock-taking
  writer, even with nothing changed, because it refreshes the tree's private index. A per-directory
  poller — a status indicator, a pre-tool-call guard — can therefore collide with a rebase running
  in that same tree and leave a lock that a live operation still owns. That lock must not be cleared;
  it is handled on the rebase side instead. The land's own rebase treats any lock-shaped failure as
  retriable (bounded, jittered, a handful of tries): it **resumes** with `git rebase --continue`
  when leftover rebase state survives on disk (a plain rebase with nothing unmerged) and **restarts**
  from scratch when it does not. The choice is keyed on the leftover state, never on git's hint
  text, which appears for only some of these collisions. A real merge conflict is never retried, and
  every retry is tallied in the land's attempt record.
- **A crash leftover.** An index write killed mid-flight — by a session stop, a tool-call timeout,
  or machine load — after the exclusive create made the empty lock but before the index was written
  and the lock renamed away. The next commit or rebase step in that tree dies with
  `Unable to create '…/index.lock': File exists`.

The reflex for the crash leftover is a **sanctioned stale-lock helper, then retry**, never a blind
`rm`. The helper removes the lock only when it is provably stale: its modification time has been
idle for a short threshold — a few seconds for a tree-private index, against a much longer window
for the shared index, because a live index write rewrites the lock in well under a second. It logs
loudly, never touches a lock that is being rewritten, sweeps every linked tree's lock when run from
the shared checkout, and never clears the shared checkout's own index lock — a wedge there is the
job of the one recovery path, `node scripts/heal-main.mjs`.

A hand-rolled `rm` of a lock under a tree's admin directory is **denied at the tool layer** (see
[`hooks.md`](hooks.md)), for two reasons. A blind delete also removes a live lock. And a hand-rolled
command can never match a permission allow-list entry the way the sanctioned helper does, so an
unattended session that reaches for it parks on a permission prompt nobody is there to answer.

**Why a helper and not a git hook.** git acquires the tree's index lock _before_ it runs the
pre-commit hook: with a lock planted, the commit dies with `File exists` and the hook never runs. No
commit hook can clear a pre-existing stale lock; the clear has to happen before `git commit` is
invoked. Scripted coordination and land commits already wait out a lock through their own retry
wrapper, so the helper exists for the one path that bypasses that machinery — an agent's raw commit
in its own tree.

## The install lock

**The failure signature.** A gate dies with its formatter or linter reported as "command not found"
because the package manager's executable shims are gone, or an install hard-fails with `ENOENT` on
one entry of the package store and keeps failing until that entry is deleted. Neither is a missing
dependency: it is a **torn package store**, and the remedy is the healer below — never skipping the
hooks, never a hand delete of the whole dependency directory.

**Why it happens.** Test runs and pushes are serialized by their own locks; installs on the shared
checkout were not, so two agents that each hit a missing-dependency failure could rebuild one
dependency tree at the same time. Long-lived open file handles (dev servers, watchers, leftover test
workers) make the package manager's relink fail halfway on some platforms, and an install killed by a
short tool-call timeout leaves the same half-written state.

**The rules:**

- **Installs on the shared checkout go through one wrapper:** resolve the root, acquire the install
  mutex, heal torn entries, install, verify, release. Never a bare install there. Installs inside a
  tree stay lock-free on purpose — each tree has its own dependency directory, so there is nothing to
  contend over. Give installs a long tool-call timeout (ten minutes or more); a short default is
  itself a source of tears.
- **A single-holder write mutex, not the test queue.** The test queue is a multi-holder FIFO
  semaphore: it caps a CPU herd but does not exclude, so wrapping an install in it would still admit
  two concurrent installs into one tree. The install lock is its own lock family over the shared
  exclusive-create primitive, `node scripts/coord/install-lock.mjs`, with the verbs `acquire`,
  `release --token <t>`, and the read-only `status` and `path`.
- **Keyed by install root, anchored to the script's own directory.** The lock file name embeds a
  hash of the resolved root, so a tree's install never contends with the shared checkout's. Which
  repository's lock directory is the rendezvous is decided from the script's own location, never
  the current working directory: for a root that no longer exists (a teardown releasing a tree it
  just deleted), the working directory may be a different clone — where release silently no-ops and
  status reports "free" while a lock is held — or may be the deleted root itself. The regression test
  resolves the same missing root from inside and outside the repository and asserts one path; tests
  run only from inside are exactly where the right and wrong answers coincide.
- **Token ownership, age staleness, fail-open.** `acquire` prints an opaque token and `release`
  unlinks only on a match, so a waiter that timed out — and never held the lock — cannot release the
  install that is running. The staleness ceiling must exceed the worst-case runtime of the thing it
  guards, or a waiter reaps a live holder. A queue-wait timeout is not a failure: the install runs
  anyway, unserialized, with a loud warning. Queue machinery must never wedge the work it guards.
- **Heal only while holding the lock.** A wait timeout is positive evidence that a rival install is
  live; healing without exclusivity would delete the rival's in-flight entry and cause the very
  corruption it is fixing. A timeout skips the heal (loudly) and still installs; a heal that throws
  never blocks the install. A killed install needs no special handling: the next wrapped install
  heals before it installs.
- **The healer's predicate is structural, not name-based.** A store entry's directory name is not a
  reliable package name (long names are truncated to a hash). What holds: each entry links every
  _other_ dependency and keeps exactly its _own_ package as a real directory. Corrupt means that real
  directory exists with its manifest file missing; an entry with no real directory at all is left
  alone, because under-healing is recoverable and deleting a good tree is not.
- **Verify after install, retry once, and never exit 0 torn.** A successful install exit is not
  proof of a healthy store. The wrapper re-scans the store and the shim directory, heals and
  reinstalls once on a failure, and exits non-zero if the store is still torn. The retry is skipped
  once the lock has been held close to its staleness ceiling, since a retry running into that window
  invites a waiter to reap the lock mid-write. Every heal and verification appends a line to a heal
  journal — read that journal first when a tear recurs.
- **A blank flag value is rejected, not coerced.** `Number('')` is `0`, which a "finite and
  non-negative" check accepts, so an empty staleness flag used to mean a zero-minute ceiling that
  reaps every live lock instantly.

**The reader side takes no lock.** A gate about to call a shim first checks that it exists
(`node scripts/ensure-bin-shims.mjs`, behind a zero-cost shell fast path). On a miss it consults the
install lock read-only: a held lock means a live install, so it waits that out and re-probes, and
only a shim missing with no install running is reported, with the one-line heal. A reader-writer
lock would add machinery to the hottest gate path for no case the read-only probe misses.

**Two root-cause lessons worth keeping.** First, a teardown that force-removes a tree containing a
**directory junction** into the shared dependency directory can delete the shared files _through_
the junction — some git builds treat a junction as a plain directory and recurse into it — so any
teardown unlinks such junctions before any recursive delete. Second, a safety fix to the land
program is inert while a land runs from a tree's own frozen copy of that program: the program
content-hashes itself against the shared checkout's copy and, on a mismatch, re-executes the shared
copy with the same arguments, so a fix is live for every tree the moment it is on the trunk.

## Machine-global git maintenance

`git gc`, `repack` and `prune` mutate the object store and refs every linked tree shares, so their
blast radius is every live session, not the one running them. Measured rather than assumed,
concurrent `gc` **at its defaults is safe** for everything a coordination system like this does: a
linked tree's detached HEAD and its index are both collection roots; coordination refs survive
`pack-refs` like any other ref; a reflog-only object survives until reflog expiry is itself forced;
a live tree's admin directory is never pruned, and `git worktree add` holds a lock marker through
its whole checkout phase; a second concurrent `gc` is refused by git's own `gc.pid` mutex; and
concurrent full object-graph reads during a collection see no errors.

**Exactly one thing is unsafe: an immediate prune.** `git gc --prune=now`, `-c gc.pruneExpire=now`
(which also drives `git maintenance run --task=gc`), and bare `git prune` (which has no grace period
at all) delete any loose object nothing references _yet_. A coordination system enters exactly that
window on every write it makes by compare-and-swap: it builds an object with `git commit-tree` or
`git hash-object` and only then pushes it to a ref, so the object is unreferenced locally in
between. A land that merges inside the object database (`git merge-tree --write-tree` plus
`git commit-tree`, then a push) has the same window, and registers no tree that could stand in as a
liveness signal. `git gc --force` is the other dangerous form: it bypasses `gc.pid`, the one
gc-versus-gc mutex git provides.

**The guard:** `node scripts/coord/git-maintenance-guard.mjs run -- git gc …` (`check --` for a
verdict only, `probe` for the liveness read, `--json` on all three). It refuses an immediate-prune
command while other sessions may be live and passes everything else straight through — plain
`gc`, `gc --aggressive` (a repack-depth flag, not a prune axis), `repack`, `pack-refs`, `fsck`,
`prune --expire=<date>`. Its classifier is deliberately not a string match: the **last** `--prune`
wins, as in git itself; an expiry is resolved through `git rev-parse --since=<value>` rather than
matched against a list, so `--prune=0.seconds.ago` counts as immediate, anything within an hour of
now counts, and an expiry the resolver cannot evaluate fails closed; and `gc --prune` takes its
value only in the `=`-joined form. Liveness is the push-queue probe plus every registered linked
tree, stale husks included (refusing on a husk costs one `git worktree prune`; allowing beside a
live compare-and-swap costs a lost coordination object). The liveness read is lazy — a safe command
never pays for it — and a liveness read that errors refuses rather than permits. The escape hatch is
`GIT_MAINTENANCE_GUARD_OVERRIDE=1`, which allows with a loud line. Exit codes: 0 allowed, 1
refused, 2 usage (a mistyped verb is never a silent pass).

**What was deliberately not built:** a lock, a queue or a board row for maintenance. When the honest
finding is "modern git is safe and the only real risk is an immediate prune", the guard is scoped
down to that one risk. A repository that turns automatic collection off accumulates loose objects
fast under coordination churn, which slows every git command and widens every lock window; a
scheduled plain `gc` through the guard fixes that, and an ad-hoc guarded `gc` is always safe.

## Kill-safety rules

Tool-call timeouts kill git mid-flight. The rules below make those kills harmless rather than trying
to make them rare.

- **One fixed inner cap for every backgrounded long-running git job, never a per-job choice.** A
  gate-running push or a land started in the background on a shared local checkout carries the same
  inner `timeout` — four hours, `timeout 14400` — whatever the job looks like. The two errors are not
  symmetric: too long costs nothing (the command exits when it finishes; the inner cap exists only
  so the shell wrapper terminates on its own, because a harness-level kill can miss it), while too
  short kills a job mid-gate and burns everything already spent — and how long the job queues behind
  other sessions first is not under the caller's control. The cap is enforced by a guard hook that
  denies a land with any other cap or none on a local top-level session, denies an inner cap on an
  unattended cloud land (which runs in the foreground instead), and denies a backgrounded push with
  a different cap; equivalent spellings of the same cap pass, dispatched helpers are graded by their
  own guard, and the hook fails open on any internal error. A killed push is dead (push again); a
  killed land resumes from its gate ledger.
- **Keep the whole land log.** The canonical local land invocation tees its full output to a log
  file, because the machine-readable seam state a red gate prints sits above any short live tail
  view.
- **Locks renew while a gate runs.** A tree lock has a hold ceiling after which it is reaped as
  wedged even with a live holder. The land arms one process-wide heartbeat that renews every lock it
  holds, and re-proves ownership at each gate boundary **before** recording that gate's proof; a lost
  lock stops the land at a queue-wait seam, banks nothing and merges nothing. A genuinely wedged
  parent stops renewing and is still reaped; a hung child is still bounded by its gate's own cap.
- **Never chain `git commit && git push` in one tool call.** A kill leaves the outcome ambiguous —
  committed? pushed? hook half-run? Commit in one call, push in the next.
- **Give hook-heavy pushes a long timeout, or run them in the background and judge by repo state.**
  Pre-push gates can run for many minutes under load, and a short default timeout kills git inside
  the hook, leaving locks and rebase residue behind.
- **Every mutating coordination operation journals `start` and `done`,** so the recovery tooling can
  tell an interrupted operation from one that never ran.
- **A wedged shared checkout has one recovery path:** `node scripts/heal-main.mjs`, and nothing else
  — no ad-hoc `pull --rebase`, `rebase --abort`, lock delete or merge on the shared checkout.
  Improvised recovery is itself a wedge source. The healer is idempotent (`--dry` previews, `--json`
  for machines), runs single-actor under the coordination lock, and journals what it fixed. Never
  commit a sibling's stray staged file "in passing" to unblock yourself: it steals attribution and
  races the owner's own rollback.

## Push retry discipline

**Run the formatter check across the whole branch diff before pushing.** The formatter gate runs
last in the pre-push battery, after every slow gate, so a one-character formatting nit found there
costs a second full battery run. Drift can arrive through a rebase too, so a file you never edited
is not exempt.

**A push that has printed nothing for minutes is presumed queued, not dead.** Under many parallel
sessions every push's gate battery waits behind the battery lock and the machine-wide test queue,
and all of that waiting is silent from the pushing side. The failure mode this rule exists for is
not a lock failing; it is sessions watching a silent push through a short tool timeout, concluding
"failed", and firing blind retries that each add another battery to an already saturated machine.

- **Before any retry, probe:** `node scripts/push-queue-status.mjs` (`--json` for machines) — one
  read-only, always-exit-0 view of both battery-lock tiers, the test queue, and live gate processes,
  with a BUSY or QUIET verdict. BUSY: your push is presumed alive; wait and re-probe, do not push
  again. QUIET: the queues do not explain the silence, so look at the push itself (network,
  credentials) before retrying.
- **The probe names a live push for your branch, orphans included.** A timeout kill can sever a
  running push from its session: the harness reports the task failed while git lives on, still
  holding its queue slot. A failed task report is therefore not proof the push died; if the probe
  shows it orphaned and provably stuck, kill that process deliberately before any retry.
- **The probe reports only what its data supports.** Live test runners while neither lock tier is
  held is the signature of a run outside the mutex and gets its own line; when a tier is held, or a
  tier could not be read, it says so and ties no process to the holder rather than guessing.
- **Never fire a second push while the first is alive.** A duplicate push slows the machine enough
  to push the next waiter past its own queue patience, which is how one retry becomes a storm.
- **On a shared local checkout, run gate-running pushes in the background with the fixed inner cap**
  (§ Kill-safety rules) and judge the outcome by repository state — the remote branch tip, the
  hook's output file — never by the completion notification alone.
- **In an unattended cloud session, push in the foreground and never background-and-block.**
  Handing a push or a land to a background task and then blocking on it is the shape that has been
  seen to end cloud sessions silently, leaving claims held by dead sessions for hours. When a push
  does not confirm within one foreground call, verify instead of retrying:
  `git ls-remote origin <branch>` against `git rev-parse HEAD`, plus the probe. A match means the
  push completed. No match, and dead-versus-alive cannot be told apart: stop, keep the claim, do not
  dequeue, report the push as unconfirmed, and end the turn. Once the push is confirmed, the
  hand-back order matters: record the review, dequeue, write a note into the work item naming the
  built branch, and only then release the claim and return the item to the ready lane — releasing
  first opens a window where another drain picks up the item with no note saying a branch exists.
  Never re-issue a blocking wait after one has timed out; fall through to the hand-back.
- **One exception to "presumed queued": a foreground push you ran that hit the tool timeout is
  dead.** The harness killed it, so there is nothing left to collide with. On a local checkout, push
  again (backgrounded this time); in an unattended session, verify with the two checks above first.
- **A queued push resolves the branch ref when it sends, not when it was invoked,** so commits made
  while its gates ran can ship with it, and the printed range understates what landed. Verify with
  `git ls-remote`, and never commit anything mid-gate you are not ready to land.
- **A queued push's gates test the working tree, not the sha you pushed,** so do not edit files while
  your own push waits for a slot. Tests that introspect source, resolve paths, hash files, or
  re-execute a module from disk will read the edited file and go red for no real reason. The tell:
  the failures sit in files your diff never touched, and pass standalone.
- **Never retry with `git pull --rebase origin <trunk>` on the shared checkout;** use
  `git fetch origin` then `git rebase origin/<trunk>`. The pull form resolves its target through
  `FETCH_HEAD`, which every peer's own fetch rewrites, and dies intermittently with
  `Cannot rebase onto multiple branches`. Also: a push piped into `tail` reports the pipe's exit
  code, not git's — redirect to a file and check `$?`, or verify ancestry on the remote.
- **A commit that dies with `unable to write new index file` already landed.** Check
  `git log --oneline -1` first; the path is left staged against a stale blob, so clear it with a
  path-scoped `git restore --staged <path>`, never the `:/` form git suggests, which would also
  unstage a peer's work. A retry loop that treats this as "commit failed" spins its whole budget.
- **A chunked gate is not a failed push.** When a heavy gate self-chunks under a per-push deadline
  and prints that it stopped short, push the same commit again — no rebase, no hook bypass, no
  diagnosis. Its ledger already holds what it proved, and the next push resumes from there.

## What this costs

Sparse-by-default is a real complexity tax: a check that forgets to widen before reading an excluded
area fails in a way that is easy to misdiagnose as a genuine data problem rather than a missing
materialize step, and every new check that touches a large excluded area has to remember to widen
itself. A merge or rebase that introduces a _new_ large directory under an already-excluded area
arrives skip-worktree by default — present in the tree's history, absent from disk — which is
correct but easy to be surprised by the first time it happens.

The ownership and clean-checkout guards trade a small amount of friction (an extra tree for a change
that would have been trivial to make directly in the shared checkout) for removing an entire class
of silent cross-agent data loss. That trade is worth making at the scale of many concurrent agents;
a single agent working alone pays the friction with none of the corresponding benefit.

See [`hooks.md`](hooks.md) for how the ownership and clean-checkout rules above are actually
enforced at the tool-call layer, and [`land-spine.md`](land-spine.md) for what happens to a tree's
branch once its work is finished.
