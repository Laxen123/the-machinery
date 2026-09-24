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
of deleting work that exists nowhere else.

## The finishing sequence

A unit of work's tree exists for exactly as long as the work is unfinished. The end-of-life sequence
is: verify every commit on the tree's branch is actually pushed somewhere durable, hand the branch
to the land spine (see [`land-spine.md`](land-spine.md)) to merge it into the trunk, and only then
tear the tree down. **A tree is never torn down while it holds unpushed commits** — doing so would
delete the only copy of that work, since the tree's branch, unlike the trunk, typically has no other
durable home until it lands. Automated teardown tooling checks for this before removing anything; a
tree that fails the check is left in place with the reason surfaced, never silently force-removed.

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
