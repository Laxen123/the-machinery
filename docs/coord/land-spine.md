# Land spine

When several agents work in parallel, each producing its own branch, every one of those branches
eventually has to reach one shared trunk. If "is this safe to merge" is answered by whichever agent
happens to be doing the merging — its judgment, its checklist, its mood — then every session invents
its own bar for safe, the trunk accumulates states nobody actually verified, and two agents merging
in the same window can each undo the other's work without either one noticing. The land spine is the
fix: one deterministic, self-invoked program is the _only_ way a branch reaches the trunk. It never
asks anyone to judge whether a merge is safe; it runs a fixed sequence of checks and either
completes the merge or stops at a named, machine- readable reason. What it prevents is not "bugs" in
the ordinary sense — it prevents a landing procedure that varies by who runs it, races between two
agents merging into a target that moved under them, and a trunk that silently regresses because the
human or agent doing the merge had a plausible-sounding reason to skip a step just this once.

## The phase map

A land is one process with a small number of ordered phases. Each phase is a plain function that
takes a context object and returns it, possibly extended, to the next phase — the boundary between
phases is a function call, not a convention someone has to remember to respect.

| Phase               | Purpose                                                                                                                                                                                                                                   | Typical stop                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Preflight**       | Resolve which work item is being landed, confirm the trunk carries no wedge left by a prior failed land, run the fast checks (type-check, lint, a quick test pass), confirm any prior review verdict still applies to the current commit. | A dirty trunk, a stale or missing review, a failing fast check.      |
| **Gate battery**    | Run every registered slow, expensive check — a full test suite, a production build, a domain-specific correctness gate.                                                                                                                   | Any gate returns not-ok.                                             |
| **Queue admission** | Enter a FIFO queue for the merge slot itself. Only the merge step is serialized; development, review, and the gate battery all happen off the queue, in parallel across every agent.                                                      | The queue is occupied; this is a wait, not a failure.                |
| **Trunk merge**     | Perform the merge in an isolated, throwaway checkout built fresh off the trunk tip — never in a shared working tree — retrying on a race against a concurrent merge.                                                                      | A conflict, or the trunk moved out from under the merge attempt.     |
| **Bookkeeping**     | Update whatever generated records reflect the completed merge: an index, a status board, an archive of the completed work item.                                                                                                           | Rare; usually only on a genuinely ambiguous piece of bookkeeping.    |
| **Teardown**        | Remove the branch's working tree, kill any background process it started.                                                                                                                                                                 | Essentially never — teardown is designed not to be a judgment point. |

Preflight is where almost all of the interesting work happens — the gate battery and most of the
project-specific checks run inside it — while the remaining phases are comparatively short and
mechanical. The phase boundaries are also the natural extension seam: a project's own steps are
threaded into a phase rather than bolted onto the outside of the whole process (see § Extension
points below).

## Seams: a named-exit discipline

Every point where the spine can stop short of a completed merge is a **seam**: a stable name
(`REVIEW_NEEDED`, `QUEUE_WAIT`, `GATE_FAILED`, and so on) paired with a distinct process exit code.
This is the single most load-bearing property of the whole design. Without it, a caller — especially
an unattended agent with nobody to ask — has to infer what happened from free-text output or a bare
nonzero exit code, and "the merge didn't happen" collapses every possible reason into one
undifferentiated failure. With named seams, a caller reads the seam name, resolves the one concrete
thing it names (do the review, wait out the queue, fix the failing gate), and re-invokes the exact
same command. The spine resumes from where it stopped; it does not restart the sequence from the
top.

This also gives the design a vocabulary for partial progress. A seam that fires after three of five
gates already passed is not the same event as one that fires before any of them ran, and the caller
— or anything watching a log of these seam names over time — can tell the two apart without
re-deriving it from context.

## Chunked and resumable gates

Some gates are expensive enough that a single invocation of the whole spine can exceed whatever
wall-clock budget the _caller_ is working under — a background job's own execution cap, or an
interactive session's patience. A **chunkable** gate is written to cap its own run below that
external limit, persist what it has proven so far, and report a distinct "chunked" outcome rather
than either silently truncating or blowing through the caller's limit uninstructively. Re-invoking
the identical command resumes the gate from its persisted state instead of starting over — a large
gate becomes a sequence of bounded chunks glued together by the same seam-and- resume mechanism used
everywhere else in the spine, rather than a special case.

This needs one hard rule to stay safe: **a chunk that proves nothing new twice in a row is a hard
stop, never a third round.** A gate that keeps reporting "chunked" while its proven set stops
growing is not making progress — it is hung, or its own bookkeeping is broken — and an unbounded
retry loop on that condition is indistinguishable, to anything watching for forward motion, from a
process that is quietly stuck forever. Two flat attempts is enough signal; a third is not "one more
try," it is refusing to notice.

## The once-per-land proof cache

A single landing _attempt_ can span many process invocations — a paperwork stop here, a queue- head
rebase there, a gate re-entered after an unrelated fix — all against the same underlying piece of
work. Re-running every slow gate from scratch at every one of those re-entries would make resuming
as expensive as never having made progress. So the spine tracks, per landing attempt, the set of
gates that have already gone green against a checkpointed state. Re-entering a step whose gate
already proved _on this attempt_ is skipped, not re-run — but only for what the proof still covers:
what changed since the checkpoint decides how much of the skip is honest. A gate whose true inputs
are narrow (say, one package's source plus its lock file and build configuration) is cached against
exactly that closure, so a change anywhere else in the tree never invalidates it, while any change
that could plausibly matter always does. A gate over a broader, delta-shaped concern re-runs only
over what changed since the checkpoint rather than the whole thing. A fresh landing attempt starts
with an empty proof set — the cache lives and dies with the attempt, never crossing to a different
piece of work.

## Extension points and the registry contract

The spine's own code should never contain a fact about any particular project. Everything
project-specific is supplied as **data**, through five registries the core spine consults at the
matching phase boundary:

| Registry           | Runs                                                         | Shape                                                                                            |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `contextExtras[]`  | Before any gate, once the changed-file set is resolved       | `{ name, run(ctx) → object }`, merged into the shared context                                    |
| `prepGates[]`      | Inside preflight, before the merge is attempted              | `{ name, stage, applies(diff, ctx), run(ctx) → { ok, seam, detail }, cacheKey(ctx), chunkable }` |
| `landSeams[]`      | Inside preflight, alongside the gates, in a documented order | `{ name, check(ctx) → { ok, seam, message } }`                                                   |
| `postMerge[]`      | After the merge is confirmed on the trunk                    | `{ name, run(ctx) }`                                                                             |
| `closeOutExtras[]` | After bookkeeping is complete                                | `{ name, run(ctx) }`                                                                             |

`contextExtras[]` exists because not every project-specific need is a gate or a seam. A project
often has to compute some scoping value — which slice of a shared dataset this change touches, say —
that several later gates all read. Without a registry for it, that computation has only two homes,
and both are wrong: inside the core (a project fact in generic code) or recomputed independently
inside each gate that needs it (three copies that drift). A context registry gives it one home on
the project's side of the line.

`prepGates[]` is the one registry where **membership is separated from running**. The registry owns
which gates exist, which phase stage each belongs to, and whether each applies to this diff; it does
not own how each one is executed, because a full test suite, a production build and a domain
correctness check differ too much in output handling, caching and telemetry for one generic runner
to serve all three honestly. The other four registries do get uniform runners — their entries are
shaped alike enough for that to be true rather than merely convenient.

A gate is a correctness question about the _code_ ("does the build pass"); a seam is a readiness
question about the _land itself_ ("has this been reviewed, are there open findings") — the two
registries exist separately because they fail differently and a caller needs to tell them apart by
name. Each registered entry carries its own ordering value, so a project's step can be slotted
between two core steps without the core needing to know the project's step exists at all — the core
iterates the registry in order; it never branches on what is in it.

A project adopting this design writes its own entries in its own module, exports them, and points
the spine's configuration at that module — a map from registry name to module path, so an
unrecognised registry name is a configuration error caught at load rather than a silently ignored
key. Nothing in the generic core is edited to add a step: if adding a step required editing the
core, the step would be in the wrong place. A useful corollary is that the roster a progress display
or a proof cache iterates should be **derived** from the registry rather than configured beside it —
two hand-maintained lists of the same gates will disagree eventually, and the one nobody looks at
will be the stale one.

## Why the merge is never done by hand

Everything above only holds if the merge genuinely happens exactly one way, every time. A hand merge
— "just this once, I can see it's fine" — bypasses the proof cache (nothing was ever checkpointed),
the seam discipline (nothing records what was skipped or why), and the queue (nothing serializes it
against a concurrent land). The moments when skipping the spine feels most justified — a
trivial-looking change, time pressure, a queue that looks quiet — are exactly the moments a silent
trunk regression gets through, because the whole point of the spine is to be the one place that
check happens regardless of how the moment feels. See [`worktrees.md`](worktrees.md) for the
working-tree hygiene the merge step itself depends on, and [`hooks.md`](hooks.md) for how a hand
merge is blocked at the tool layer rather than only discouraged in prose.

## What this costs

This is materially more machinery than a plain merge command: a registry loader, named seams, a
chunk-and-resume protocol, a proof cache with its own key-derivation rules. A small team merging a
handful of branches a week may find the ceremony out of proportion to the risk it removes — the
design earns its cost at the scale of many agents landing continuously, not at the scale of one
person merging occasionally.

The proof cache buys speed at a real, accepted risk: two lands proceeding in parallel each prove
their own gates independently, so a combination the cache never tested together — this land's change
interacting badly with a sibling's change that landed in between — is not caught at land time.
Systems that adopt this design typically accept that risk deliberately and backstop it with a
periodic full run outside the landing path, rather than trying to eliminate the gap at land time
(the tradeoff is discussed further in [`cloud-drains.md`](cloud-drains.md)).

The spine can only serialize what actually calls it. A merge performed by some other path entirely
bypasses every guarantee described here; that hole is closed, to the extent it can be, at the
guard-hook layer rather than inside the spine itself (see [`hooks.md`](hooks.md)).

Finally, determinism has an authoring cost of its own: every new project-specific step has to be
written as a pure function matching the registry's contract — `{ ok, seam, detail }` out, no hidden
side effects on failure — rather than as an ad hoc `if` branch dropped into the sequence. That is a
real interface to learn and keep stable, and it is deliberately less convenient than the alternative
it replaces.

## Commands

A land is one call. It runs every phase in order and either completes or halts, printing the seam
name and a nonzero exit code:

```bash
node scripts/done-worktree.mjs <slug>
```

Resolving a halt and continuing is the same command with the seam named back to it — the spine picks
up from its checkpoint rather than re-running what already proved:

```bash
node scripts/done-worktree.mjs <slug> --resume <SEAM_CODE>
```

A dry run prints the phase sequence and every gate/seam the spine would consult, without touching
git or running anything expensive — useful for checking that a newly registered project step lands
where it was meant to:

```bash
node scripts/done-worktree.mjs <slug> --dry-run
```

The merge-slot queue is inspectable and, while waiting in it, leavable independently of the spine
itself:

```bash
node scripts/landing-queue.mjs status
node scripts/landing-queue.mjs dequeue <slug>
```

See [`landing-queue.md`](landing-queue.md) for the queue's own admission and fairness rules,
[`review.md`](review.md) for what a review-shaped seam expects before it clears, and
[`plan-lanes.md`](plan-lanes.md) for how a work item arrives at the spine in the first place.
