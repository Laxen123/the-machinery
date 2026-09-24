# Coordinating many agents on one repository

Put more than one autonomous agent to work on the same repository and the hard problems stop being
about code. They become about who is allowed to touch what, how two agents avoid doing the same job
twice, how finished work reaches the trunk without two merges racing each other into a livelock, and
how anyone — human or machine — finds out what state anything is in without asking the agent that
last touched it. None of those are model problems. They are ordinary distributed- systems problems
wearing unfamiliar clothes, and they have ordinary answers: a lock, a queue, a state machine, a
gate.

This directory is the answer set, written once, generically. Every document here describes a
mechanism that works in any repository with any set of agents — none of it is specific to the
project these documents were extracted from, and a lint enforces that by blocking any push that puts
a domain noun in this tree. The project-specific version of the same facts — the actual service
names, the actual incident history, the actual thresholds — lives in `../runbooks/`, and each
document here points at its counterpart there.

## What this system is, in one paragraph

A unit of work is a file in a directory, and the directory it sits in **is** its state. An agent
takes a unit of work by winning a compare-and-swap against a shared git reference — the claim. It
then works in its own dedicated working tree, so no two agents ever write to the same files. When
the work is done and reviewed, it enters a FIFO queue for the right to merge, and the merge itself
is performed by one deterministic program that either completes or stops at a named,
machine-readable reason. Guard hooks make the rules that matter deterministic rather than
remembered, and a knowledge vault beside the code holds the reasoning that neither the data nor the
procedures can carry. Everything above is built from git primitives and plain files: there is no
coordination server to deploy, authenticate, or keep alive.

## The layers

Read them in this order if you are new to the design. Each one is readable alone, but each assumes
the one above it exists.

| Layer            | Document                               | The question it answers                                           |
| ---------------- | -------------------------------------- | ----------------------------------------------------------------- |
| **State**        | [`plan-lanes.md`](plan-lanes.md)       | Where does work live, and how does anyone know its state?         |
| **Exclusion**    | [`claims.md`](claims.md)               | How does exactly one agent get a unit of work, across machines?   |
| **Isolation**    | [`worktrees.md`](worktrees.md)         | Where does each agent actually write, without colliding?          |
| **Admission**    | [`landing-queue.md`](landing-queue.md) | Who is allowed to merge right now, and in what order?             |
| **Execution**    | [`land-spine.md`](land-spine.md)       | What actually performs a merge, and how does it fail legibly?     |
| **Enforcement**  | [`hooks.md`](hooks.md)                 | Which rules are enforced by code rather than by memory?           |
| **Quality**      | [`review.md`](review.md)               | How is a change reviewed at a cost proportional to its risk?      |
| **Delegation**   | [`subagents.md`](subagents.md)         | How does an expensive agent hand bulk work to a cheap one safely? |
| **Autonomy**     | [`cloud-drains.md`](cloud-drains.md)   | How does an agent run with nobody watching, and fail visibly?     |
| **Knowledge**    | [`wiki.md`](wiki.md)                   | Where does durable reasoning live, and how does it stay true?     |
| **Evidence**     | [`bake-offs.md`](bake-offs.md)         | How do you run a comparison you will still trust in six months?   |
| **Instructions** | [`rule-tiers.md`](rule-tiers.md)       | Which rules go in which instruction file, and why so few?         |

## How the pieces fit

A unit of work moves through the layers in a fixed order, and each layer hands the next one a
guarantee it can rely on.

It starts as a file in a resting lane — authored, but not yet reviewed for framing or scope. A
review pass reads it, verifies its claims against the repository as it is _now_ rather than as it
was when the item was written, and either routes it onward or sends it back. Once it is in the ready
lane, any agent may take it, and taking it means winning the **claim**: a non-force push to a shared
reference, where git's own non-fast-forward rejection is the mutex. The loser of that race exits
clean, having mutated nothing.

The winner gets a **working tree** of its own, cut from the trunk tip. One writer per tree, for the
whole lifetime of the unit of work. Everything the agent does happens there — including delegating
bulk work to cheaper **subagents**, each of which is handed an explicit scope it may not exceed, and
whose returned changes the orchestrator diffs against that scope before accepting them.

When the work is done it is **reviewed** at a tier proportional to its risk, and the verdict is
recorded as data — the outcome, the commit it was taken against, which review lane actually ran — so
that "was this reviewed" is a query rather than a memory. Every finding gets an explicit
disposition, and the merge is blocked while any remains open.

Then the unit of work enters the **landing queue**. Only the head may merge. The merge is performed
by the **land spine**: one deterministic program that runs a fixed sequence of phases, and at every
point where it can stop short of a completed merge, stops at a _named_ seam with its own exit code —
so a caller, especially an unattended one, resolves the single thing that seam names and re-invokes
the identical command, resuming rather than restarting.

Underneath all of it, **guard hooks** deny the tool calls that would break these rules — a
hand-rolled worktree that skips the claim, a write into another agent's tree, a commit that would
put vault content on a work branch — because a rule enforced only in prose is a rule that holds
until the first agent in a hurry. And beside all of it, the **knowledge vault** holds the prose
layer: why a decision went the way it did, what was tried and rejected, what a subsystem actually
does. It is written back to in the same session something durable is learned, and — the harder half
— pruned in the same session a change makes one of its claims false.

## The design commitments

Five ideas recur in every document here. They are the actual content of the design; the mechanisms
are just how each one is paid for.

**The state is the artifact, not a record of the artifact.** A directory listing is the board. A git
reference is the lock. A file's own frontmatter is its metadata. Nothing is mirrored into a second
store that can drift, because every drift bug this design has avoided is a bug about two records of
the same fact disagreeing.

**Every stop has a name.** A process that fails gives its caller a machine-readable reason, not a
nonzero exit code and some prose. This matters far more with agents than with humans: a human reads
the output and infers; an agent needs to branch, and "something went wrong" collapses every possible
cause into one undifferentiated failure it cannot act on.

**Structure over discipline.** Where a rule can be made structurally impossible to break, it is — an
ownership guard that denies the write beats a convention that asks agents to check first. Discipline
degrades under time pressure, and an agent in a loop is always under time pressure.

**Cost is a first-class input.** Review depth, model tier, whether a wait burns tokens, whether a
gate re-runs — all of these are decided by explicit, recorded policy rather than by whatever the
acting agent felt like. An agent that decides its own spending decides it differently every time.

**Failing visibly beats failing safely.** An agent that stops and says exactly what it is blocked
on, with its work pushed and a hand-off written down, is a success. An agent that quietly does
nothing is the expensive failure — indistinguishable from one that never started, and eventually
someone redoes its work.

## What this costs, honestly

This is a lot of machinery for a small team. A single developer merging a handful of branches a week
gets essentially none of the benefit and all of the ceremony: the queue is a pure tax when there is
never contention, the claim is a lock nobody else was going to take, and the guard hooks mostly deny
things that would have been fine. The design earns its cost at the scale of several agents working
continuously against one trunk, where the failures it prevents — duplicated work, silent cross-agent
overwrites, a trunk that regressed because one merge skipped a step, a blocked session nobody
noticed for hours — stop being hypothetical and start happening weekly.

It also has real limits, stated plainly in the documents that own them: the proof cache buys speed
at the accepted risk of never testing two parallel lands _together_; liveness across machines cannot
be proven mechanically, so some recovery actions deliberately require a human's word; a guard that
fails open reduces the rate of a mistake rather than eliminating it; and no lint can tell whether
prose is _correct_, only whether it broke a mechanical rule. Where a mechanism cannot guarantee
something, the document says so rather than implying coverage it does not have.

## Adopting a piece of it

The layers are separable, and the ones with the best ratio of benefit to machinery come first:

1. **[`claims.md`](claims.md)** — the highest value for the least code. It is a few dozen lines
   built entirely on git push semantics, it needs no server, and it eliminates the worst failure in
   the whole space (two agents doing the same work, or worse, clobbering each other).
2. **[`plan-lanes.md`](plan-lanes.md)** — directories as state. Nearly free, and every later
   mechanism reads from it.
3. **[`worktrees.md`](worktrees.md)** — one writer per tree. Mostly a tooling and habit change.
4. **[`landing-queue.md`](landing-queue.md)** and **[`land-spine.md`](land-spine.md)** — worth it
   once merge contention is real, not before.
5. **[`hooks.md`](hooks.md)**, **[`review.md`](review.md)**,
   **[`cloud-drains.md`](cloud-drains.md)** — each addresses a failure you will recognise when you
   have had it, and will over-engineer if you adopt it before then.

[`rule-tiers.md`](rule-tiers.md), [`wiki.md`](wiki.md) and [`bake-offs.md`](bake-offs.md) are
orthogonal to the rest and can be adopted at any point, in any order.
