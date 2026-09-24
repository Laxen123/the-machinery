# Claims: claim-before-work

When several independent agents can start work on the same backlog item at the same moment, "check
if it's taken, then start" is not safe — both agents can check, both see it free, and both start,
because the check and the start are two separate operations with a gap between them that a rival can
win. The result is duplicated work at best and two conflicting sets of edits at worst. What is
needed is a single operation that is simultaneously the check and the take, evaluated by one
authority every agent already talks to, so that exactly one of two racing agents can ever win it —
including when the two agents are on entirely different machines with no shared memory, no shared
filesystem, and no way to phone each other directly.

## The lock is a git ref, and the push is the mutex

A claim is a named reference in the shared remote repository. Acquiring the claim means pushing a
small, uniquely-identified commit object to that ref with a **non-force** push. Git's own push
semantics do the rest:

- If the ref does not exist yet, a non-force push that _creates_ it always succeeds — there is
  nothing to conflict with.
- If a rival has already pushed to that ref, the ref has moved. A second push that still expects the
  _old_ state is rejected as **non-fast-forward** — git refuses it outright, without applying any
  partial effect.

That rejection _is_ the mutex. It is atomic, because a single push either lands completely or not at
all — there is no half-applied state to observe. It is evaluated **server-side**, by the remote the
push targets, not by comparing notes between clients, so it needs no separate lock service and no
clock synchronization between machines. And it is **cross-machine** for free: every agent, wherever
it runs, is pushing to the one remote that arbitrates the race, so two agents on two different
continents contend on exactly the same rule as two agents on the same box. The losing agent reads
who actually holds the ref, logs it, and exits cleanly — it never partially mutates anything,
because it never got as far as pushing.

Building this out of git rather than a bespoke lock service is deliberate: every agent already has
push access to the one shared remote and nothing else needs deploying, authenticating, or kept alive
as a separate process. The remote already enforces exactly the guarantee a lock needs — create, or
fast-forward, or refuse — so a purpose-built lock server would be re-implementing a guarantee that
already exists for free, with a strictly worse failure mode (a new single point of failure with its
own uptime story).

## Why the ref is branch-shaped, not a custom namespace

It is tempting to keep coordination refs out of the way, under some dedicated non-branch prefix, so
they never show up next to ordinary work branches. That is the wrong call whenever the path to the
remote runs through an intermediary — a mandatory proxy, a gateway, anything sitting between the
client and the real host — that only recognizes ordinary branch namespaces and refuses writes to
anything else outright. A claim ref that lives under an ordinary branch prefix passes through such
an intermediary exactly like any other push; a claim ref under a bespoke prefix simply never
arrives. The lesson generalizes beyond claim refs: never assume "any ref name is portable" — verify
what a mandatory intermediary in the actual deployment path will actually let through before
choosing a namespace, and prefer the boring, well-trodden shape when there is any doubt.

## Release is a tombstone, not a delete — and that changes what "the ref exists" means

The same kind of intermediary that restricts _which_ ref namespaces may be written often restricts
_which verbs_ may be used at all, refusing a DELETE outright — even against a perfectly ordinary
branch. That rules out the obvious release mechanism ("delete the ref when you're done"), so release
instead **appends another commit** to the same ref whose content marks it released — a tombstone.
The ref itself never goes away on the normal path; only its tip content changes.

This has one binding consequence every reader of a claim must internalize: **the ref existing is no
longer proof that the item is held.** The one new rule is — a claim is held unless its tip is a
recognized tombstone. An unparseable, malformed, or otherwise unrecognized tip is read as **still
held**, never as free: handing the same item to two workers is the one failure this entire mechanism
exists to prevent, so every ambiguous case resolves toward "locked," never toward "available."
Consequently, nothing may ever infer holder status from a raw listing of ref names — "does this ref
exist" and "is this item claimed" are different questions now, and only the claim tool (which reads
and interprets the tip content) can answer the second one. Actually deleting a long-tombstoned ref
is a separate, purely cosmetic garbage-collection chore that runs off the critical path — nothing
about claiming, releasing, or re-claiming depends on it ever running.

**Re-acquiring after a release** needs one more twist, because "the ref must be absent" is no longer
how emptiness is expressed. The acquiring push reads whatever is currently at the tip: absent → push
a fresh, parentless commit, exactly as the first-ever claim would; tombstone → push a commit whose
_parent_ is that tombstone, which git accepts as an ordinary fast-forward — unless a rival already
appended something first, in which case it is rejected non-fast-forward, exactly the same rejection
as an initial race; live (non-tombstone) tip → refuse immediately, without even attempting a push,
since the outcome is already known. The mutex behaves identically whether an item has never been
claimed or has been claimed-and-released a hundred times before.

## All-or-nothing for a multi-item claim

A worker that needs to claim several related items as one unit — because they are only meaningful
worked together — does not claim them one at a time and hope. It attempts every ref in the bundle,
and if any single one loses its race, every ref already won in that same attempt is released
immediately before reporting failure. That guarantee holds **on the success path**: the bundle is
acquire-then-compensate, not a true atomic multi-ref operation, because no single push can
atomically claim several refs at once. A compensating release is itself an ordinary push and can
fail — network trouble, a rejected write — leaving the bundle partially held: a leaked claim,
resolved the same way any other leaked claim is, through the force-release escape hatch described
further below. This is a known limit of building a lock out of per-ref pushes, not a gap specific to
bundles.

## Dead sessions: no liveness ping, so judge by staleness — carefully

There is no persistent process to ask "are you still alive" — a claim is just a commit on a ref, and
the agent that pushed it may have crashed, finished and forgotten to release, or simply be taking a
long time. Two things do **not** by themselves prove a claim is abandoned: a claim's _age_ alone
(slow, legitimate work looks identical to a stuck one for a while), and a claim whose recorded
origin happens to match the machine you are running on (a live sibling process on the same host is
not you). The only way to positively know a claim is _yours to resume_ is to have actually won the
acquire this session, or to have the tool confirm — by comparing the claim's recorded identity
against this session's own runtime identity — that you are the holder. Everything else is, at best,
evidence toward a judgment call a human still has to make.

A companion signal — a lightweight marker specifically for "is anything live on this lane at all" —
lets a reader distinguish "genuinely idle" from "a claim I just haven't refreshed my view of"
without needing to interpret claim internals at all.

## The escape hatch for a leaked claim

A claim left behind by a crashed or abandoned session is freed by an explicit, separate
**force-release** operation — never automatically. The force path exists precisely because age and
machine-identity heuristics cannot reliably distinguish "dead" from "just slow," so the actual
judgment — "I have confirmed the holder is gone" — is deliberately left outside the tool's reach, as
an operator decision rather than a mechanical sweep. A scheduled sweep may _surface_ a long-held
claim as worth a human look; it must never decide on its own that the human's answer would be yes.

## Releasing a claim never strands the work

The durable product of "an agent worked on this item" is whatever it actually produced and pushed —
a branch, a set of commits, an artifact — never the claim itself. The claim is a lock over **who is
currently allowed to work on this item right now**, not a lock over the existence of the work
already done. So releasing a claim — on ordinary completion, or forcibly after confirming the holder
is dead — never deletes, hides, or endangers anything already pushed: the next claimant simply picks
up from whatever state the pushed artifact is actually in, rather than starting over. This is what
makes force-release a safe operator action rather than a destructive one: it reassigns permission to
continue, and nothing more.

See also: `plan-lanes.md` (the claim is what moves an item into the in-progress lane),
`landing-queue.md` (the separate mutex that serializes merging finished work back to trunk),
`worktrees.md`, `cloud-drains.md`.
