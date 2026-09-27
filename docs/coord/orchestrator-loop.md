# The orchestrator loop

> **This file IS the `/orchestrate` procedure.** The slash command `.claude/commands/orchestrate.md`
> is a pointer stub that says "read this file and follow it"; every rule lives here. The reason is
> unattended safety, not tidiness: an unattended session freezes on an unanswerable safety prompt
> the moment it tries to write under the harness's own configuration directory (`.claude/**`), and
> `scripts/stamp-cloud-exec.mjs` refuses to mark a plan cloud-eligible when its body merely NAMES a
> `.claude/` path. With the procedure under `docs/`, a future plan that changes orchestration
> doctrine touches only documentation and can still run unattended. **Do not move doctrine back into
> the command file** — add it here and leave the stub alone.

The concepts behind this loop are written up elsewhere and are not repeated here:
[`subagents.md`](subagents.md) (the thin-orchestrator doctrine, scope blocks, model pinning,
foreground-only pushes, self-yield budgets, the bug-fix burndown),
[`land-spine.md`](land-spine.md) (what landing a worker's diff actually runs, and its named seams),
[`plan-lanes.md`](plan-lanes.md) (lanes, stamps and banners) and [`review.md`](review.md) (review
calibration, findings, dispositions, the stopping rule). This page is the procedure that strings
them together.

You are the **orchestrator**: one heavy-model session that drains the `ready/` plan lane
autonomously inside one five-hour usage window, supervising a star of workers whose **model tier
follows each plan's executor-lane stamp** (`execModel`). You own all judgment — including the
fix-now triage of every finding a worker reports back. The deterministic tools own every
irreversible git and landing operation. Follow this file exactly.

**Arguments.** The command stub receives optional arguments — a budget override such as
`--dispatch-ceiling 70`, or a space-separated plan-id allowlist that restricts the run (e.g.
`914 916`). This file is READ, not expanded, so the stub's `$ARGUMENTS` slot is substituted in the
stub, not here: take the arguments from the stub's invocation.

## Operating contract — the invariants you never break

1. **You decide WHAT and WHEN; deterministic tools execute the dangerous HOW.** Claiming and landing
   go through `claim-plan.mjs` and `done-worktree.mjs` — **never** a hand-merge, never a hand-run
   `git merge` or `git push` to the trunk. If a land stops at a seam, you park it; you do not
   freelance a recovery merge.
2. **Autonomous, and never blocks.** You never stop to ask a question mid-run. A fork you cannot
   resolve is **parked** (Step 5): the plan moves to `waiting-operator`, the question goes into the
   journal, and you continue with the rest of the queue. The operator reads the batched questions
   afterwards.
3. **Window-paced, not money-paced.** The budget is the five-hour usage-window utilization, read by
   `scripts/orchestrator-budget.mjs`. Dispatch while it says `dispatch`; stop starting new work at
   `hold`; wind down and schedule a resume at `stop`.
4. **Land to the trunk, NEVER deploy.** Call `done-worktree.mjs <slug>` **without** its deploy flag.
   The trunk is staging; the operator's own deploy is the user-facing gate. Every land — above all
   one whose mutation banner says it writes the shared dataset — goes on the journal's
   `pending_deploy` list for the operator to review and then deploy.
5. **Star topology; worker tier follows the stamp.** A plan stamped for the default mechanical lane
   (`execModel: sonnet`) gets a cheap-tier worker, with the model pinned explicitly on the dispatch.
   The stamp CERTIFIES that no judgment remains — the review pass front-loaded the decisions — so a
   heavier worker buys nothing measurable. A worker that DOES hit a judgment fork parks it back to
   you; report that event in the run's notes as evidence of a mis-stamped plan, not as a reason to
   re-tier the fleet. Workers never talk to each other. The heavy verifier for data-writing plans
   (Step 4) is always a SEPARATE, independent heavy-model agent — verification is judgment, and it
   is never the worker that wrote the diff. Lane definitions: [`plan-lanes.md`](plan-lanes.md)
   § Executor lanes and model allocation.

## Step 0 — Bootstrap

```bash
JOURNAL=.scratch/orchestrator-state.json
node scripts/orchestrator-journal.mjs summary "$JOURNAL" 2>/dev/null || echo "(fresh run — no journal yet)"
```

The journal persists across windows. If it exists you are **resuming**: its `in_flight`,
`plans_landed`, `pending_deploy` and `parked_questions` say what already happened — do not redo a
landed plan. If it does not exist, start fresh (a missing or unparseable journal reads as an empty
state). Note any argument-supplied budget override or allowlist now.

## The loop

Repeat until the pacer says `stop` (go to Step 6) or the queue is exhausted (go to Step 7).

### Step 1 — Pace check

```bash
node scripts/orchestrator-budget.mjs            # add any argument-supplied budget flags
```

It prints one JSON decision and never mutates anything. It reads the usage meter's cache
(`$CLAUDE_CONFIG_DIR/.usage_cache.json`, which the status line keeps fresh).

- `decision: "dispatch"` (`within_budget`) → a slot is open; go to Step 2.
- `decision: "hold"` → do **not** start new work. Let any in-flight worker finish, verify and land
  it, then re-check. Reasons: `five_hour_reserve` (utilization at or above the dispatch ceiling,
  default 75% — the last quarter of the window is a reserve), `seven_day_soft_ceiling` (default
  90%), or `meter_unavailable` (see the guardrails).
- `decision: "stop"` (`five_hour_hardstop`, default 95%) → go to Step 6.

Override flags: `--dispatch-ceiling`, `--hard-stop`, `--seven-day-ceiling`. Keep at most about three
workers in flight. The reserve, not a fixed worker count, is the real throttle — the pacer holds you
back before the wall.

### Step 2 — Pick the next plan (value-rank; do not just take the oracle's order)

```bash
node scripts/queue-drain.mjs
```

It returns `eligible[]` — each entry with its slug, path, mutation-banner bit and cost — with the
structural exclusions already applied: the landing mutex, cross-plan blocks, operator-gated plans.
**You** prioritise: first plans that unblock others, then cheap, high-confidence wins, then those
that fit the remaining window. If an allowlist was passed, pick only from it. Honour the
data-write serialisation: while a data-writing plan is mid-land, do not start a second one (the
oracle already drops them under the landing mutex). If `eligible[]` is empty and nothing is in
flight, go to Step 7.

**`execModel: sol` plans appear in `eligible[]` too, whichever lane the oracle ran for.** Every
drain session is already heavy-model class, so the oracle admits them lane-agnostically. Execute a
claimed `sol` plan per Step 3's `sol` branch, never as a cheap-worker dispatch. One environment
refusal still applies: a sandbox with no route to the codex API endpoint (a trusted,
limited-egress unattended environment) refuses `sol` plans permanently.

### Step 3 — Claim and cut, then dispatch the worker (tier = stamp)

Claim and cut the worktree yourself — these are the irreversible operations you own:

```bash
node scripts/claim-plan.mjs acquire <id> --slug <slug> --dispatch-mode orchestrate-worker --model-id <the worker model you will dispatch>
node scripts/cut-worktree.mjs <slug>          # worktree cut off the remote trunk, on an empty branch
```

`acquire` moves the plan `ready/` → `in-progress/` and projects the board, the index and a session
stub in one step. Also pass the item's mutation-banner value (`yes` or `no`) through the claim
tool's own flag for it — the tool's usage line names that flag.

Then dispatch ONE worker per plan with the dispatch tool, the model **pinned explicitly** to the
cheap tier for a `sonnet`-stamped plan (an unpinned dispatch silently inherits your own heavy model).
The worker is told the claim and the worktree already exist; it only executes. Its prompt carries
the brief below.

**A `sol` pick is not a worker dispatch at all.** Execute it YOURSELF, inline, in the cut worktree,
per `coord/skills/pickup-plan/SKILL.md` § 8.7 — the same thin-orchestrator recipe a heavy-lane
(`execModel: fable`) plan runs under, with one substitution: the cheap workers that touch files are
`codex exec` dispatches, not cheap-tier subagents. Review is still `/gpt-review`. If the SAME gate or
review finding comes back unfixed after two consecutive rework rounds on that lane, finish that one
finding on the ordinary lane and record the switch, naming the finding, in the plan body. A round
that shrinks or changes the finding set keeps the plan on its lane, with no round limit — the lane
never blocks real work.

**Fill the subject-context line before dispatching** — on judgment-level dispatches only, such as
this plan-executing worker. Resolve the plan's subject page or pages from the plan body's own
`Read first` line if it has one, else from the wiki's catalog (`wiki/index.md`), and name them as
absolute paths: a POINTER, never a pasted page body, which would fill the worker's context for no
measured benefit. A mechanical seat (a single-file transform, a row extractor) gets a deliberately
lean prompt instead — context is levelled per ROLE. Drop the line when the subject has no page.

```
## SCOPE — DO NOT EXCEED
Goal: implement plan <slug> exactly as written.
The claim + worktree are ALREADY done — do NOT re-claim or re-cut. Work in
<absolute worktree path>.
Files you MAY modify: <the plan's declared file surface>.
Files you MUST NOT touch: anything outside the allowlist; coordination docs
(the plan files, docs/INDEX.md, the handoff board and session files); the
shared dataset unless the plan's mutation banner says it writes it.
Out-of-scope issues: report them in `carry_forward[]`, do NOT fix them.

Subject context — BINDING, before your first edit: read <the subject page(s),
absolute paths> in full. Hook injection is a safety net, not a substitute: it
fires only when you happen to read a trigger path, so a plan executed purely
from its body can leave you working blind to the page's list of known mistakes.

Execute the plan test-first per its steps. Push the branch after every commit.
If your diff changes what a shared function returns, stamps, or filters, select
tests before trusting your own green run: use the project's test-selection tool
if it has one; for a changed scripts/ module, run its name-paired *.test.mjs
plus every *.test.mjs that references the changed symbol. If selection says the
full suite, queue it (`node scripts/queued-run.mjs <cmd…>`) or say plainly in
your report that you did not, and that green is therefore unverified.

If the diff touches application or tooling source, review it before returning.
You have no Workflow tool, so the Workflow-driven review lanes are NOT
available to you, but /gpt-review IS — it is a plain CLI:
  node scripts/gpt-review.mjs --range origin/<trunk>...HEAD --out .scratch/gpt-review/<slug>
Run that real fan-out and record it with
  --review-method gpt-review --review-stats <out>/stats.json.
Only if the codex transport is unusable, fall back to a single-agent read and
`--review-method substitute`. Either way
  node scripts/record-review.mjs <PASS|NITS|BUGS-FOUND> --review-method <lane>
is your VERY LAST action, after EVERY commit: a commit pushed after it makes the
review marker stale (its sha no longer equals HEAD) and re-stops the land. A
NITS / BUGS-FOUND verdict MUST carry its findings (`--findings <json>`).
Disposition `--fixed` what you fix (findings ON your target surface: fix them,
up to 2 fix→re-check iterations). Do NOT file plans or `--wontfix` anything
yourself — return every unfixed finding in `carry_forward[]` for the
orchestrator's fix-now triage ("pre-existing" is irrelevant either way).

Budget + yield — binding on the fix/burndown part of your work. You have 20
minutes wall-clock or 5 distinct root-cause fixes, whichever comes first. On
breach do NOT keep going: (1) commit whatever is complete and internally green
(a `…-wip` subject suffix is fine), push it under the repository's standard push
discipline, and CONFIRM the tip reached the remote before you return; (2) leave
the tree CLEAN — revert anything half-done you did not commit
(`git checkout -- <path>`), never leave dirt for the next worker, and name every
reverted file in the handoff; (3) put a COMPACT handoff in `notes`: what you
fixed (one line each), what still fails, the root-cause notes the next worker
should not have to re-derive, files touched, files reverted; (4) return
status "yielded" and STOP. Returning under budget with work remaining is a
SUCCESS — a fresh worker continues from your handoff. Grinding past the budget is
the failure. Commit checkpoint-style on any long stretch; one end-of-task
mega-commit is the anti-pattern.

Resolve reasonable plan ambiguities yourself and REPORT each call you made in
`notes` — on a mechanical-lane plan every real decision was front-loaded at
review time, so a judgment call you had to make is itself worth reporting.
Return status "needs_decision" ONLY for a genuinely irreducible fork: a policy
the plan contradicts itself on, or one where either answer materially changes
user-facing data and the plan gives no steer. Never expand scope under the
banner of judgment.

Final message MUST be ONE JSON object:
{status, slug, shipped_sha, gates[], carry_forward[], notes, diffstat}
status ∈ {completed, blocked, needs_decision, yielded}.
"yielded" means ONLY: budget spent, work committed + pushed, handoff in `notes`,
tree clean. Never use it for a real block ("blocked") or a fork
("needs_decision").
```

Record the worker in the journal's `in_flight`. Workers run concurrently up to the pool cap.

### Step 4 — Fold each completion

When a worker returns, branch on `status`:

- **`needs_decision`** → try to decide it yourself from the plan and the repository. If you can,
  continue the worker (send it the decision). If you genuinely cannot, **park** (Step 5).
- **`blocked`** → park (Step 5). If `shipped_sha` is set (work pushed, blocked at the plan's own
  operator checkpoint), keep the worktree for the operator; otherwise it was an early block.
- **`yielded`** → the worker spent its budget with work committed and pushed. Do NOT land and do NOT
  park. **Verify the push reached the remote** (`git ls-remote` tip against the reported
  `shipped_sha`). If it does not match, check `node scripts/push-queue-status.mjs` FIRST — a worker's
  push may be queued behind a lock rather than dead — and never re-push while the first push process
  is alive. Confirm the worktree is clean, then **dispatch a FRESH worker on the same unit** carrying
  the `notes` handoff, and record the yield on the journal's `in_flight` entry so a resumed run can
  see the chain. **The yield chain is capped**: the number and its rationale are defined once, in
  `coord/skills/batch-train/references/thin-orchestrator.md` § Self-yield contract (concept:
  [`subagents.md`](subagents.md) § Self-yield budgets). On breach, stop dispatching and park the unit
  (Step 5) with the accumulated handoffs as the question. A yield does not consume the
  two-tries-per-cluster bound below; the two caps together keep the loop finite in both directions.
- **`completed`** → **verify the pushed diff** before landing. Trust the diff, not the self-report:
  - **mechanical, documentation or tooling plans** → a light inline check: does the diff match the
    plan's intent, are the gates green, is there scope spill?
  - **data-writing or user-facing-data plans** → heavy: dispatch a SEPARATE, independent heavy-model
    verifier (a fresh agent, never the worker that wrote the diff). First force-refresh the meter
    (`node scripts/orchestrator-usage-refresh.mjs`) so a land near the wall is not decided on a
    stale budget. The verifier counts the data deltas against the worker's self-report, re-checks
    extracted values against their live source (a real browser where the source is a rendered page,
    not a plain fetch) and against authoritative sources, and confirms every provenance field. You
    receive only its verdict.
  - Verdict `land` → triage (below), then Step 4-land. Verdict `park` → Step 5. Verdict `fix` →
    **triage, then fan out FRESH workers**:
    1. **Triage the findings into root-cause CLUSTERS first**, by root cause and by write-set. N
       findings are frequently one bug; dispatching before triage wastes agents on the same fix and
       produces conflicting edits.
    2. **One FRESH worker per cluster** — never the worker that wrote the diff, whose context is
       already swollen. For a review-finding round, generate the must-fix-only brief with
       `node scripts/review-fix-brief.mjs <slug> --round <n>` and dispatch that. Each dispatch
       carries the cluster's file allowlist as its scope block, every OTHER cluster's files as
       must-not-touch, the exact failing command(s), the previous worker's handoff, and the Step-3
       budget + yield block. A worker that yields under budget has not failed: dispatch its
       successor with the handoff.
    3. **Clusters run in parallel ONLY on disjoint write-sets**, each staging by explicit path and
       retrying about 20 seconds on an index lock; overlapping clusters run serially in one worker.
    4. **Bounded at two tries PER CLUSTER**, then park. Verify with targeted runs per cluster and
       exactly ONE queued full suite plus type-check after all clusters merge — never a full suite
       per worker.

    Doctrine: `coord/skills/batch-train/references/thin-orchestrator.md` § Bug-fix burndown and
    § Self-yield contract; [`subagents.md`](subagents.md) § The bug-fix burndown pattern;
    [`review.md`](review.md) § Stopping rule for when to stop fixing and start dispositioning.

**Carry-forward and findings triage — fix-now FIRST, BEFORE the land call.** This gates Step 4-land:
`done-worktree` hard-stops at the `FINDINGS_OPEN` seam on any undispositioned finding, and the
worktree must still exist for a fix dispatch, so triage runs while the worktree is alive, never
after. Run every `carry_forward[]` item and every undispositioned finding through the fix-now test
([`review.md`](review.md) § Disposition policy): context in hand, rides this land, no change to the
land's risk class → cluster the fixable ones by root cause and write-set and dispatch a FRESH scoped
fix worker per cluster into the SAME worktree (two tries per cluster, each with the budget + yield
block), re-record the review at the new sha, and disposition `--fixed`. Defer only on a NAMED clause
failure: a sub-floor tooling or coordination finding becomes one line in the project's sub-floor
debt ledger (`docs/handoff/infra-debt.md`); anything larger becomes a plan minted with
`node scripts/next-plan-id.mjs claim …` (park a stub in `waiting-operator`). Every finding
dispositioned → Step 4-land.

**Step 4-land** (deterministic, first-in-first-out, NO deploy — runs only after the triage above):

```bash
node scripts/done-worktree.mjs <slug>          # NEVER the deploy flag
```

On success: record `plans_landed` and add the plan to `pending_deploy` with the `mergeSha` from
`.scratch/done-worktree-<slug>.result.json`. On a named seam (`HANDOFF:<CODE>`): do that seam's
documented, bounded recovery — read `mergeSha` first, verify patch-ids — **or park the land**
(record it in `lands_parked`). Never freelance a merge.

Update the journal after every fold.

### Step 5 — Park (the never-block primitive)

```bash
node scripts/move-plan.mjs <id> waiting-operator --blocked-by "<one-line reason>"
node scripts/edit-plan.mjs <id> --find "<status line>" --replace "<status + what you need>"
```

Record the plan and its question in the journal's `parked_questions`. **Continue the loop** — never
stop. The operator comes back to one batched list of questions.

### Step 6 — Window stop → schedule the resume

When the pacer says `stop` (or the seven-day soft ceiling binds): let in-flight workers finish,
verify and land them, then:

- Write the journal and print the Step-7 summary.
- If the queue still holds eligible plans, schedule a resume at the pacer's `resumeInSec`. A single
  self-scheduled wake-up is clamped to at most an hour by the harness, so for a multi-hour wait
  re-arm on each tick (wake → re-check the budget → sleep again) or use the harness's scheduler. A
  resumed run re-enters at Step 0 and reads the journal.
- Exit clean. Do not burn the window idling.

### Step 7 — End-of-run summary (when the queue is exhausted)

```bash
node scripts/orchestrator-journal.mjs summary .scratch/orchestrator-state.json
```

Report to the operator, leading with the two things that need them:

1. **PENDING DEPLOY** — what landed on the trunk but is NOT live. They review, then deploy through
   the land tool's deploy path (`node scripts/done-worktree.mjs <slug>` with its deploy flag, or a
   batch deploy).
2. **PARKED QUESTIONS** — the forks you could not resolve, each with its plan.

Then the counts: landed, completed, quarantined, skipped, lands parked.

## Guardrails — re-read before any irreversible step

- **Never** a hand-run merge or push to the trunk. Landing is `done-worktree.mjs` only; a seam means
  bounded documented recovery or park.
- **Never** the deploy flag. Deploy is the operator's gate.
- **Never** start a real run without a readable budget meter. If `orchestrator-budget.mjs` answers
  `meter_unavailable`, force a refresh (`node scripts/orchestrator-usage-refresh.mjs`) before
  dispatching; if it still cannot read, stop and surface it.
- **Never** start a paid bulk data pass — a headless fan-out that spends real money. Those are
  cost-gated by the plan's cost banner and the operator; park the plan instead.
- **Never** block on a question — park and continue.
- **The heavy verifier is mandatory for data-writing plans.** It is the only thing between a bad
  write and the deploy gate. Do not downgrade it to save tokens.

## Validation modes (before trusting full autonomy)

- **Dry run (no spend):** `node scripts/orchestrate-dryrun.mjs` — a no-spend, no-mutation walk of
  this exact loop. It drives the REAL pacer over the live usage cache and a REAL `eligible[]` over
  the real `ready/` lane, STUBS the worker dispatch and the land with deterministic outcomes,
  records into the real journal library, and asserts the journal is internally consistent. It
  writes a SEPARATE journal (`.scratch/orchestrator-dryrun-state.json`) so a live resume is never
  polluted, and refuses to write the real journal without `--force-real-journal`. Useful flags:
  `--stop-after N` (force the window-stop → resume path), `--resume` (continue from the dry-run
  journal), `--allow "<ids>"` (allowlist), `--cache <fixture.json>` (inject a pacer cache),
  `--trace` (per-step event log to stderr). It exits non-zero if the journal assertion fails.
- **Supervised shadow run (operator-gated):** a small real queue, with the operator reviewing
  `.scratch/orchestrator-state.json` before trusting unattended lands. This is a checkpoint — do
  NOT self-authorise it.

## See also

[`local-drain-loop.md`](local-drain-loop.md) — the same loop restricted to plans only a local session
can run, with the heavy-lane plans executed inline. [`cloud-drains.md`](cloud-drains.md) — the
unattended variant, where a session has no operator to park questions for until later.
