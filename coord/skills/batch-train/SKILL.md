---
name: batch-train
description: Use when 2-5 small SPECCED, SONNET-drainable plans should execute together to save land cycles — one worktree, one sequential mechanical train (fresh sub-agent per plan), one review, one land — while the plan files themselves stay separate. Triggers - "batch these plans", "run a batch lane on X/Y/Z", "these are all coord-machinery plans, batch them", "/batch-train", or a consolidate/spec-pass sweep proposing an execution-batch candidate ("would these share a land?").
---

# batch-train — N specced plans, one worktree, one mechanical train, one land

**Why batch: the land is where the tax lives, not the work.** Per-land fixed cost — freshen merge, gate-gauntlet rounds, a landing-queue slot, the review-marker cycle — was measured at ~20-24% of a session (plan 1307) on top of the ~8-10 coord commits each land emits to master. N small plans landed separately pay that tax N times. Batching collapses it to once **without** touching plan identity: the files stay separate (archive granularity, per-plan re-park, per-plan revert all still work) — only the _execution arrangement_ is shared. This is the load-bearing distinction from `consolidate`: consolidate folds plan **bodies**; batch-train shares only a **land**. See `references/share-a-land.md` for the full fold-vs-batch-vs-leave-separate test before reaching for either — don't re-derive it here.

The underlying claim (ref-CAS) and land (`done-worktree` deterministic spine) mechanics this skill's
steps 2 and 7 implement are documented once at `references/claim-land-spine.md` (also cited by
`pickup-plan`) — read it for the WHY; the steps below stay the batch-specific HOW (the all-or-release
claim across N plans, the single shared land at the end).

## Conductor is the heavy orchestrator archetype (Opus default) — cars stay Sonnet

**Session-archetype convergence (operator 2026-07-27, plan 2567 — supersedes the "Conductor is Sonnet" doctrine this section used to carry).** Every top-level execution session, batch-train conductors explicitly included, is the same archetype: a heavy thin-orchestrator (Opus 5 default per the Fable ≤50% rule). The CARS are unchanged — fresh Sonnet sub-agent per car, because batch eligibility still requires every member `stage: specced` + `execModel: sonnet` (no residual design calls in any member). What changed is the conductor's judgment surface, which was never really the single call the old doctrine claimed: it owns (1) the derailment rule (step 6), (2) the fix-now triage of every review finding the train's ONE review returns (plan 2531 — the conductor fixes what passes the (a)–(c) test instead of auto-filing plans), and (3) push verification — a car pushes in the FOREGROUND, never backgrounded (a dispatched subagent backgrounds nothing, per the binding rule in the project `CLAUDE.md` / `docs/runbooks/plans-workflow.md`, plan 3110): a car's own backgrounded gate-running `git push` was observed dying silently at the car's turn end twice in one train — exactly the failure that rule exists to prevent — so the conductor also verifies every car's push landed on origin (`git ls-remote` / `push-queue-status.mjs`) and re-pushes in foreground itself when it didn't. Contrast with `execModel: fable` (and, since plan 3341, `execModel: sol`) plans, which run under the thin-orchestrator doctrine (`references/thin-orchestrator.md`) with the conductor executing inline instead of dispatching cars — for `sol`, the delegated workers are `codex exec` dispatches rather than Sonnet subagents, but neither lane ever rides a batch-train.

## When to use

Full eligibility test (the batch outcome of the fold-vs-batch-vs-leave-separate fork): `references/share-a-land.md` — don't re-derive it here. Short form:

- 2-5 open plans, ALL `stage: specced` + `execModel: sonnet`, ALL the same seed-write mutex class (all `🟩`, or all `🟥` with overlapping data shard-sets — see the the project scoped-mutex rule), none stamped `loop: hitl` (plan 1668 — a hitl plan resolves only through a live operator exchange, which a mechanical train has no slot for; an absent `loop:` key is unconstrained), none operator-urgent, none likely to derail (a plan whose acceptance criteria feel shaky belongs back at spec-pass, not on a train).
- **Coordination-machinery plans should essentially always ride a batch** — they converge on the same handful of shared scripts, so landed separately they duplicate or conflict at merge time (the plan-1364 provenance case: two of four freshen conflicts were another session fixing the identical bug).
- A `consolidate` or `spec-pass` sweep flags a cluster as an **execution-batch candidate** rather than a fold candidate — this skill is what that recommendation hands off to.

**Do NOT use for:**

- A single plan — plain `pickup-plan`, no batch machinery needed.
- Any member not yet `stage: specced` (design judgment still owed) — send it through `spec-pass` first. Interleaved judgment in the middle of a mechanical train is exactly what the sonnet-conductor model forbids.
- True duplicates — two plans describing the same fix belong in `consolidate`'s body-merge, not a batch (batching duplicates just runs the same change twice under two ids).
- A mixed mutex class (some `🟩`, some `🟥`, or `🟥` members with disjoint record shards) — reconcile or split the group first; the batch claim script enforces homogeneity and will refuse.
- More than 5 members — split into two batches; a single sub-agent-per-car train that's still 6+ cars deep erodes the "fresh context per car" payoff into "one very long session anyway."

## Project conventions vary

This skill describes **the project** conventions (`claim-plan.mjs batch`, `cut-worktree.mjs`, `done-worktree.mjs`, the claim-ref CAS lock — `refs/heads/coord/claims/<id>` since plan 3756 — the scoped landing mutex). Adapt surface details to the project; keep the flow (select + risk-order → batch-claim → one worktree → sequential per-plan sub-agents with between-car gates → derail-and-continue on red → one review → one land).

---

## Steps

### FIRST ACTION — copy `/rename <batch-slug>` to the clipboard, before anything else

Same convention as pickup-plan (see its FIRST ACTION section for why `/rename` cannot be fired
programmatically — clipboard is the lowest-friction path). The moment this skill fires with a known
batch (named members or a roster row), copy the rename command and surface the paste nudge — BEFORE
the batch-claim, before any git command. If members aren't known at launch, fire as soon as step 1
resolves the roster row (that's the only thing allowed to come first).

```bash
# Windows (operator's platform; Set-Clipboard adds no trailing newline):
powershell -NoProfile -Command "Set-Clipboard -Value '/rename <batch-slug>'"
```

```
📋 Copied  /rename <batch-slug>  to your clipboard — paste (Ctrl+V) + Enter to rename this session.
```

`<batch-slug>` = the batch slug (e.g. `batch-2026-07-06-closures`); a shorter label like the theme
(`closures`) is fine if the slug is unwieldy. Must run from the user-facing orchestrator session —
never a dispatched car sub-agent. Skip ONLY if the operator already renamed the session, or when
running headless.

### 1. Select members + verify eligibility

**Check the roster FIRST** (the project, plan 1467: each batch is a FOLDER `docs/superpowers/batches/<slug>/` with a `batch.md` — frontmatter `slug` / `lane` / `members` / `gate` / `status: proposed|claimed|landed`; run `node scripts/batches-view.mjs` (`/batches`) for the rendered roster, which reads every `proposed` folder + the global `dependencies.md`, falling back to the retired `proposed.md` mega-table with a deprecation warning). The board-pass persists batches as `proposed` folders — auto-approved at proposal since the standing operator directive 2026-07-14 (operator veto runs through the board-pass report, not a per-batch go) — so an invocation naming a batch theme or no members at all resolves against them instead of re-deriving the grouping. **Claiming a batch STAMPS its `batch.md` `status: claimed`** (done for you by `claim-plan.mjs batch`, step 2) — you no longer hand-delete a roster row. No matching folder → select members yourself per the criteria below (an ad-hoc batch gets its folder created at claim).

Confirm every candidate meets `references/share-a-land.md`'s batch eligibility (frontmatter `stage: specced` + `execModel: sonnet`, homogeneous seed-write mutex class) — `execModel: fable` and `execModel: sol` (plan 3341) are both excluded by the same clause: neither ever rides a train, `sol` because it is a single Opus-orchestrated session by design, with no batch conductor for it. The batch-claim script re-enforces this — treat your own check as a fast fail, not the only gate.

**Risk-order the members.** The member most likely to derail (shakiest acceptance criteria, largest diff, least-exercised surface) runs **LAST**, unless another member structurally depends on it landing first. A derailed early car costs the least — nothing yet depends on it.

### 2. Batch-claim

```bash
node scripts/claim-plan.mjs batch <id1> <id2> [...≤5] --slug batch-<YYYY-MM-DD>-<theme>
```

All-or-release: every claim-ref lock (`refs/heads/coord/claims/<id>` since plan 3756) acquires or none do. On success this is ONE projection commit — all N plans → `in-progress/`, N board rows tagged with the batch slug, one session entry listing every member, the write-once manifest `docs/superpowers/batches/<batch-slug>/manifest.json` (moved into the batch folder by plan 1467; a grandfathered in-flight batch may still be at the legacy `docs/handoff/batches/<slug>.json` — the spine dual-reads), and the folder's `batch.md` stamped `status: claimed` (or a fresh `batch.md` synthesized for an ad-hoc batch). `--force` exists for an operator-confirmed override of the execModel/seed-homogeneity gate — never reach for it to route around a real mismatch without operator sign-off. **Since plan 1427 (Gate 2), `--force` no longer bypasses the `stage: specced` check**: a stub member needs `--stub-ok "<operator authorization note>"` (recorded in the projection), and a session must never `--stub-ok` its own fresh mint.

**Advisor (plan 1427, Gate 3).** Largely subsumed by the archetype convergence (2026-07-27): the conductor IS a heavy session now, so most adjudication forks are decided in-conductor. `--advisor fable` remains for the rare fork that genuinely earns a Fable-tier consult (per the ≤50% Fable rule); subagents inherit it. Name the fork list in dispatch prompts (provenance contradiction, demote-vs-backfill, evidence-reality verdict, gate-override temptation) — the canonical list lives in the project `docs/runbooks/plans-workflow.md` § Model allocation.

### 3. Cut the worktree

```bash
node scripts/cut-worktree.mjs <batch-slug>
cd .claude/worktrees/<batch-slug>
pnpm install     # never --ignore-scripts — see pickup-plan's hard stop, same rule applies here
```

One worktree for the whole train. Every car boards and disembarks from this same tree.

### 4. Run the train — one fresh sub-agent per car, IN RISK ORDER

For each member, in the order fixed at step 1:

- Dispatch a **fresh** Sonnet sub-agent (fresh context per car is the point — it dissolves the context ceiling that caps a single long session). The dispatch prompt carries a `## SCOPE — DO NOT EXCEED` block built from that plan's own body: (1) goal, one sentence; (2) the file allowlist from the plan; (3) files it MUST NOT touch, explicitly including every OTHER member's files; (4) report-don't-fix for anything out of scope; (5) the absolute-worktree-path warning — Read/Edit/Write need the full `.claude/worktrees/<batch-slug>/…` prefix, they do not follow the Bash cwd; (6) **the subject-context pointer** (plan 2883) — a binding "Read `<absolute path to the plan's subject wiki page(s)>` in full before your first edit" line, resolved from the plan body's own `> Read first` line or `wiki/index.md`. A POINTER, never a pasted page body. A car executing a plan is judgment-level, so it gets this line; a narrow mechanical seat does not (context is leveled per ROLE, and for those the level is deliberately low). Drop it when the member's subject has no wiki page, and for a price-pipeline member add the one-line duty: state which `docs/PIPELINE.md` stage the diff touches before editing.
- **Every car dispatch carries the self-yield block** (`references/thin-orchestrator.md` § "Self-yield contract", plan 2694), copied VERBATIM into the prompt text — a budget stated beside the prompt never reaches the car. Default: **20 minutes wall-clock or 5 distinct root-cause fixes, whichever first**; on breach the car commits + pushes its complete, internally-green work and returns a compact handoff (fixed / remaining / root-cause notes / files touched) instead of grinding on. This binds the car's INTERNAL fix loop — the failure mode it prevents is a single car burning the whole train's wall-clock at 400k context.
- **A car that YIELDS has not failed.** Re-dispatch a fresh sub-agent on the SAME member with the handoff and continue that car; only a car that returns RED after its fix attempt counts against step 6's bound.
- **Never two sub-agents writing in the tree at once.** One car boards, does its work, disembarks (commits + pushes), then the next car boards. This is the standing no-two-concurrent-writers rule, scoped to a train. It is also why a car's internal fix work is never fanned out across parallel agents in the shared tree — the burndown fan-out doctrine applies to a car's SUCCESSOR dispatches (sequential, fresh context each), not to concurrent writers.
- Every commit subject for that member's work starts with `<id>: ` (e.g. `1362: fix release-claim double-free`) — this is what makes a later derailment's commits identifiable and droppable. Push after every commit (same reason as `pickup-plan`: a parallel `done-worktree`/take-over must never lose pushed work).
- **After each car disembarks, the conductor VERIFIES its push reached origin** (`git ls-remote origin <branch>` tip matches local, or `node scripts/push-queue-status.mjs`) — a car pushes in the foreground, never backgrounded, precisely because a car's own backgrounded push has been observed to die silently when its turn ends; if the commit isn't on origin, the conductor re-pushes in FOREGROUND itself before boarding the next car.

### 5. Between cars — run the implicated gates

Before the next car boards, run whatever gates that car's diff touches (backend `tsc --noEmit`, scripts tests, frontend build — per the project's own pre-push gate list). **Green before boarding the next car.** Skipping this and only checking gates after the last car hides which car introduced a regression, and makes the derailment rule (step 6) unusable — you can't cleanly drop "the commits that broke it" if you don't know which car broke it.

### 6. Derailment rule — bounded fix attempts, then derail

The bound (archetype convergence, 2026-07-27): the car gets **ONE** fix attempt; if still red, the heavy conductor may take **ONE** bounded own-fix pass when the failure passes the plan-2531 fix-now test — matching the `/local-drain` fable-conductor precedent ("you are the tier the one-attempt cap existed to defer to"). A member still red after that (at most two attempts total, and the conductor's attempt is OPTIONAL — derailing straight after the car's failed attempt is always legitimate triage) is derailed:

1. Drop that member's commits from the branch — `git rebase --onto` removing the `<id>: ` commits (cleanly if they weren't interleaved with other cars' work; that's why step 4's one-car-at-a-time rule matters), or a revert if they were.
2. `node scripts/move-plan.mjs <id> <waiting-*>` with a note naming what broke.
3. `node scripts/claim-plan.mjs derail <id>` — the single coord reconcile: it drops `<id>` from the batch **manifest's `members`** (the step the old three-command sequence MISSED — a stale manifest still listed the derailed member, so `done-worktree` crashed at land resolving its removed board row for the 🟢 LANDING marker and lost its landing-queue slot; plan 1478), removes its board row, and releases its claim ref (a tombstone commit since plan 3756, not a delete), all in ONE atomic projection. Replaces the old separate `release-claim release <id>` + hand board-row removal. Idempotent, so a re-run is safe.
4. **Continue the train** with the remaining members — a derailment is triage, not a train-wide stop.

Past the two bounded attempts it's a design question for spec-pass, not train triage. Park it and move on.

**A self-yield is not an attempt (plan 2694), but it is capped.** A car that returns under its
budget with work remaining and a handoff has not spent the bound — verify its push reached
origin (step 4's rule applies to a yielded car too), confirm the tree is clean, then dispatch a
fresh sub-agent on that member with the handoff and let it continue. The derailment bound counts
only RED-after-fix returns. **The yield chain has its OWN cap** — the number and its rationale
are defined ONCE at `references/thin-orchestrator.md` § "Self-yield contract"; on breach, derail
that member. Without the cap, "a yield is not an attempt" makes a car unboundedly
re-dispatchable and one member can eat the whole train's window. Do not let the two rules cancel
each other out in either direction: a yielding car is not derailable on that ground alone, and a
genuinely red car is not rescuable by re-labelling its failure a yield.

### 7. After the last car — one review, one land

```bash
/sonnet-review <level per the project's review-calibration>
# disposition findings — fix-now FIRST (plan 2531): --fixed is the default for findings that
# pass the (a)-(c) test (docs/runbooks/plans-workflow.md § Disposition policy); a deferral
# names its failed clause and routes per the severity floor (debt list / grammar-debt line / plan)
node scripts/record-review.mjs <PASS|NITS|BUGS-FOUND> [--findings <json>]
node scripts/done-worktree.mjs <batch-slug>
```

ONE review covers every surviving member's diff; ONE `done-worktree` call archives all landed members, releases their claims, removes their board rows, and frees the ONE landing-queue slot the whole batch held. Never a per-member land.

**Fix-pass tripwire (plan 1704) — the bounded-attempts rule extends to this phase.** If the scoped re-review of a fix-pass delta (`/sonnet-review high <prev-sha>..HEAD`) returns ≥1 new CONFIRMED finding, the conductor STOPS writing fixes and treats the contested question as a design fork: decide it structurally yourself (you are the heavy tier the old advisor dispatch existed to reach — archetype convergence 2026-07-27) or park the finding on a fresh plan if the design is genuinely open. The discipline is model-independent — repeated fix rounds refuted by successive reviews were NOT a tier problem (plan-1869 evidence: heavy-model verification passed each broken round clean), so a heavier conductor does not license grinding more rounds. (Evidence: coord-spine5, 2026-07-10 — four conductor fix rounds on landing-lock failure semantics, each refuted by the next scoped review; the signal was present at round 2.)

---

## Common mistakes

| Mistake                                                                           | Why it bites                                                                                                                                                             |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Body-merging the members to "batch" them                                          | That's `consolidate`, not this skill — it destroys per-plan identity (archive granularity, independent re-park/revert) for no reason; batching needs only a shared land. |
| Two sub-agents writing in the tree concurrently                                   | Breaks the one-car-at-a-time model and makes a later derailment's commit-drop unclean (interleaved hunks can't be cleanly rebased away).                                 |
| A third fix attempt on a derailed member                                          | Past the car's attempt + the heavy conductor's ONE bounded own-fix (step 6), a stuck member is a design question — park it rather than keep the whole train waiting.     |
| Interleaving two members' commits                                                 | Breaks the derailment drop — you can no longer isolate "this member's commits" for `git rebase --onto`. Keep car N's commits contiguous before car N+1 boards.           |
| Claiming new members mid-train                                                    | Membership is fixed at the batch-claim (step 2). A mid-train add wasn't risk-ordered, wasn't eligibility-checked against the others, and the manifest is write-once.     |
| Skipping the between-cars gates ("the last car was green, so the train is green") | Earlier cars' regressions hide behind a later car's unrelated passing gate run. Gate every car, not just the last one.                                                   |
| Batching plans that are actually true duplicates                                  | Running the same change twice under two ids instead of folding — `consolidate`'s body-merge is what duplicates need.                                                     |

## Red flags — STOP

- "This member isn't `specced` yet but it's small, I'll just wing it" → No. Un-specced means a design call is still owed; send it to `spec-pass` first. A mechanical train has no slot for design judgment mid-run.
- "The gates were red twice, let me try once more" → That's the second-attempt trap. One fix attempt, then derail (step 6). Continuing to iterate on a stuck car is you doing spec-pass's job inside the wrong skill.
- "I'll land this member separately since it's ready first" → No per-member lands. The whole point is one land; landing early defeats the tax savings and desyncs the board/claim state for the rest of the train.
- "These are all `Infra`-tagged, that's eligible enough" → A shared tag is not a shared mutex class or a shared file-surface. Verify `specced` + `sonnet` + banner homogeneity per member; the claim script re-checks this but don't skip your own look.
- "I'll just `--force` past the eligibility gate, the operator probably wants this batched" → `--force` is for an operator-confirmed override, not a way to route around a real mismatch you noticed yourself. Surface the mismatch and get the go-ahead.
