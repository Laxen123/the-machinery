# Thin-orchestrator doctrine — heavy model decides, cheap subagents touch files

**Canonical source for this doctrine.** Lifted from the retired `orchestrated-execution` skill
(2026-07-05, plan 1373 D6) when that skill folded from an invokable peer into a shared reference.
Cited by `orchestrate` (the autonomous drain orchestrator) and by any plan executed under
`execModel: fable` — the mode a heavy model (Fable/Opus) runs in whenever a plan's judgment is
interleaved with its execution, rather than fully front-loaded (contrast: `execModel: sonnet`, which
runs through `batch-train`'s deterministic conductor instead — no doctrine needed there because no
judgment is left to protect). **A second trigger since plan 3341 (operator ruling 2026-08-20):
`execModel: sol`** binds the SAME doctrine, with one substitution — the cheap workers that touch
files are `codex exec` dispatches (Sol, `gpt-6-sol`) instead of Sonnet subagents, and the heavy
decision layer is an Opus session. `sol` differs from `fable` in WHY a plan lands here: it is
elected by MECHANICAL eligibility rather than judgment shape, on whatever cadence the executor-lane
toggle currently sets (`scripts/exec-model-default.json`, read with `node scripts/exec-model-default.mjs`
— the project `docs/coord/plan-lanes.md` § Executor lanes and model allocation carries the live value and its
history) for any plan whose criterion is statable now and is not on the coord-spine hard gate — see
rule 4's carve-out below for the consequence. Any legacy reference to an
"orchestrated-execution skill" — old plan bodies, runbooks, drain messages — means THIS file; there
is no invokable skill to search for (plan 1559 closed the stale-reference residue).

## Overview

The heavy model makes the calls; cheap subagents touch the files. The economics only work if **bulk
content never enters the orchestrator's context** — every rule below exists to protect that invariant.
Review fix rounds follow `docs/coord/review.md` § Stopping rule: generate `scripts/review-fix-brief.mjs` and dispatch that must-fix-only brief in a fresh worker context, never fix inline.

Vendor measurement of exactly this shape (Anthropic, BrowseComp benchmark on Claude Managed
Agents, 2026-07): a **Fable 5 orchestrator + Sonnet 5 workers scored 96% of pure-Fable-5
performance at 46% of the price** (https://x.com/ClaudeDevs/status/2074606063509528855; cookbook
https://github.com/anthropics/claude-cookbooks/blob/main/managed_agents/CMA_plan_big_execute_small.ipynb;
docs https://platform.claude.com/docs/en/managed-agents/multi-agent).

> **Keep-in-sync note (plan 1627, extended by plan 2694):** a condensed copy of the mode test +
> rules 1–4 + § "Bug-fix burndown" + § "Self-yield contract" + the model-pin rule prints at claim
> time from the project `scripts/claim-plan.mjs` (`acquire` on an `execModel: fable` or `execModel: sol`
> plan). When editing any of those here, update that printed block in the same change — the claim-time print
> is the only copy a plan-executing session reliably sees. **That print is the ONLY sanctioned
> restatement** (it must stand alone in a sibling repo where this file may not exist); every other
> surface points here. The yield-chain cap's number lives in § "Self-yield contract" and in that
> print — nowhere else.

## Inline vs orchestrated — size the mode to the plan

`execModel: fable` says WHO makes the calls (a heavy model), not HOW MANY subagents to spawn.
Pick the mode by whether there is bulk to protect the orchestrator's context from. `execModel: sol`
picks its mode the same way — the only difference is that the delegated workers are `codex exec`
dispatches rather than Sonnet subagents (§ Overview above).

- **Small plan (~1 day, one surface, judgment dense at every step) → execute INLINE.** The heavy
  session just does the work itself. Dispatching Sonnet workers here adds spin-up latency and
  prompt overhead with no bulk to amortize — and the judgment IS the work, so there is nothing to
  delegate. Precedent: plan 1532 (session 1418, 2026-07-07) ran a one-day schema-axis plan fully
  inline and it was the right call. Rule 3 (write each decision into the plan body as it is made)
  and the mandatory review gate still bind; rules 1–2 simply have no bulk to apply to.
- **Real bulk (multi-file sweeps, many independent workers, corpus passes) → orchestrate.** The
  rules below exist for this mode. Precedent: plan 1251 (session 1264, 2026-07-02) — Fable
  decision layer over 8 Sonnet workers.
- **The sizing is re-checked MID-FLIGHT, not just at plan start (plan 2694).** This test fires
  once, before work begins; the classic miss is a burndown that starts as "one worker fixes the
  red tests" and turns out to hold several independent root causes. When that shows up, resize —
  see § "Bug-fix burndown" and § "Self-yield contract" below, which are this test applied to a
  fix loop already in progress.

## Rules

1. **Never bulk-read or bulk-edit yourself.** Subagents (explicit `model: "sonnet"` on every call —
   never inherited) do the reads, searches, and edits; you consume conclusions and decide.
2. **Verify through gates, not eyes.** Tests, build, the review fan-out — never by reading subagent
   diffs. The moment you read diffs to trust them, you pay double and the mode is pointless. No gate
   covers the risk? Add the gate — cheaper and permanent. **When a worker's diff changes what a
   shared function returns, stamps, or filters, run `python -X utf8 backend/scripts/_select_tests.py
--changed-file <path to a file listing the changed repo-relative paths>` before trusting its green
   report.** `SUBSET <n> test files` means run every file it lists. `FULL <reason>` means you may not
   narrow by judgment at all — queue the full suite (`node scripts/queued-run.mjs <cmd…>`), or say
   plainly in your report that you did not and that green is therefore unverified; guessing at
   "related tests" yourself is exactly the gap this closes. A changed `scripts/**` `.mjs` module has
   no such selector — run its name-paired `*.test.mjs` plus every `*.test.mjs` that greps for the
   changed symbol. Observed, not theoretical: plan 3858 (2026-09-11) left two tests red through four
   rounds where each worker picked "related" tests by judgment and reported green.
3. **Write each decision into the plan body as it is made** (edit-plan / same-session commit). The
   session dying must lose nothing: the refined plan is the durable artifact, the orchestrator context
   is disposable.
4. **Downgrade tripwire:** three consecutive delegations that needed no judgment call from you → the
   plan was mis-routed. Set `execModel: sonnet`, hand it back to the drain, stop paying heavy-model
   prices on mechanical work. **Carve-out for `execModel: sol` (plan 3341, reaffirmed by plan 3461):**
   this tripwire does NOT apply — a mechanical-looking stretch of delegations is the POINT of the sol
   lane, not evidence of mis-routing (a sol plan is stamped precisely BECAUSE the work is
   mechanical, whether that stamp came from the executor-lane default in `scripts/exec-model-default.json`
   or from an explicit operator instruction while a Claude lane held the default — neither changes
   this carve-out). That lane's own escape valve is the repeated-finding rework rule instead (operator ruling
   2026-08-29, replacing the fixed 2-round cap): the SAME gate/review finding comes back unfixed
   after two consecutive Sol rework rounds, and the orchestrator finishes that finding on the normal
   Claude lane and records the switch naming the finding; a round that shrinks or changes the
   finding set keeps Sol, no round limit. Rule text: `docs/coord/plan-lanes.md` § Executor lanes
   and model allocation.
5. **Zero-dispatch tripwire (mirror of rule 4; plan 1747).** Rule 4 catches over-delegation; the
   opposite failure — a bulk-shaped `execModel: fable` plan that never delegates at all — is caught
   deterministically by a WARN-only Stop hook (`scripts/hooks/bulk-fable-zero-dispatch-tripwire-stop.mjs`).
   It fires when a session on a standard `worktree-<id>-<slug>` branch is executing a fable plan whose
   `summary`/H1 matches bulk-shape language ("batch", digit+item/record/holdout/battery, "corpus",
   "sweep"), has crossed ~40 inline Bash/Read/Edit/Write ops, and has made zero Agent/Task dispatches —
   mirroring the plan-1629 finding on plans 1707 and 1674. Advisory only (a `systemMessage`, never a
   block); does not fire on batch-train branches or non-fable sessions. (Detection-quality and
   efficiency refinements tracked in the project plans 1753/1754.) **Carve-out for `execModel: sol` (plan
   3341, decided this session):** this tripwire stays fable-ONLY and deliberately never fires on a
   `sol` plan. A `sol` plan's cheap workers are `codex exec` dispatches, not Task/Agent subagents, so
   zero Sonnet-subagent dispatches is the EXPECTED steady state on that lane — admitting `sol` here
   would fire the tripwire on every `sol` plan that ran exactly as intended. That lane's escape valve
   is the rework cap (rule 4's carve-out above), not this hook.

## Worker sizing & checkpoint commits (operator ruling 2026-08-01, plan 2683)

A big work wave dispatched to ONE worker serializes independent file clusters and risks the
worst-case loss: the worker dies at its context limit with the whole diff uncommitted. Observed
same session: a 21-item review fix wave in one Sonnet worker ran 45+ minutes to ~500k context with
an 18-file/1000-line diff sitting uncommitted; three other workers that session stalled at large
context without even sending their report (work done, report lost).

- **Split by disjoint FILE CLUSTER when a wave exceeds ~8 items or ~3 clusters.** Parallel workers
  in one shared worktree are safe iff their allowlists don't overlap: each stages by explicit path
  (`git add <file>…`, never a directory) and retries ~20s on an `index.lock` collision. One
  worker per cluster (e.g. driver files / batch+apply files / study+tools files), each with its
  own SCOPE block and its own commit.
- **Checkpoint commits are mandatory on long dispatches.** Instruct every worker on a >~30-min task
  to commit completed, internally-green work BEFORE continuing (`…-checkpoint` suffix is fine); a
  single end-of-task mega-commit is the anti-pattern. The orchestrator owns pushes either way.
- **Expect the silent-stall shape:** a worker that goes idle without a report has usually FINISHED
  and failed to send (context exhaustion at the finish line). Before re-dispatching, check the
  worktree for its commit/diff — verify through gates, don't re-run the work.
- Single-worker remains right when items share deep sequential dependencies on the same files —
  then sequence phases, don't parallelize the collision.

## Bug-fix burndown — triage into clusters, THEN fan out (plan 2694)

§ Worker sizing above is the general wave-splitting rule; this is its fix-loop specialization,
and it is where the shape bites hardest. A red-test / review-finding burndown handed to ONE
worker is serial by construction — fix → re-run tests → read output → next failure, with every
test dump and file read staying resident — and a dispatched worker **cannot** fan out its way
back (subagents have no Workflow tool, the project `CLAUDE.md`). So it degrades superlinearly: the
last bugs cost far more than the first. Measured: plan 2683's execution session (2026-08-01), one
fix worker at 45+ minutes and ~500k context, still not done.

- **Triage FIRST, always — never fan out on a raw failure list.** Group the failing tests /
  findings by ROOT CAUSE and by write-set before dispatching any fix work (a cheap Sonnet triage
  dispatch, or an inline read of the failure list when it is short). N failures are frequently 1
  bug; fanning out before triage wastes N−1 agents on the same fix and produces conflicting edits
  to the same file. The triage output IS the unit of dispatch: a cluster = one root cause plus
  the files it touches.
- **Fan out per CLUSTER, not per failure**, once triage shows ≥2 independent clusters. One scoped
  fix agent per cluster: fresh context, `model` pinned EXPLICITLY (sonnet default), a
  `## SCOPE — DO NOT EXCEED` block whose allowlist is that cluster's files and whose
  must-not-touch names every OTHER cluster's files, and the exact failing test command(s) written
  into the prompt. One cluster → one agent, no ceremony; the fan-out is not the goal, the context
  split is.
- **Disjoint write-sets are a HARD precondition** — the same constraint
  `docs/coord/subagents.md` § Worker sizing — split a big wave by disjoint file cluster already states for batch lanes.
  Clusters whose files overlap stay SERIAL inside one agent, or take worktree isolation with an
  explicit merge step. Each parallel agent stages by explicit path (`git add <file>…`, never a
  directory) and retries ~20s on an `index.lock` collision, exactly as § Worker sizing requires.
  **This is the sanctioned carve-out to "no two write-capable sessions on one working tree", not
  an exception someone forgot** (operator ruling 2026-08-01, plan 2683 — see § Worker sizing).
  The umbrella rule governs independent SESSIONS, which have no shared owner; here ONE
  orchestrator owns the tree and hands each agent a provably disjoint slice of it. Two things
  keep that honest and neither is optional: allowlists that genuinely do not overlap, and
  explicit-path staging so the shared git index is never asked to guess. Lose either and you are
  back to the failure the umbrella rule exists to stop — so if you cannot prove disjointness,
  run the clusters serially. **`batch-train` cars are NOT covered by this carve-out**: that
  skill's one-car-at-a-time rule is about members of a train, and it stands unchanged.
- **Verification split: targeted per agent, ONE full suite at the end.** Each fix agent verifies
  with single-file / targeted runs only (ticket-free per the queued-run rule); exactly ONE queued
  full-suite + typecheck runs after all clusters have merged. Per-agent full-suite runs thrash
  the serialized test queue and are the fastest way to turn a fan-out win back into a loss.
- **The invariant does not relax because the work is "just fixing".** The orchestrator owns
  pushes, verifies through gates rather than by reading each agent's diff (rule 2), and consumes
  each agent's handoff — not its transcript.

## Self-yield contract — a dispatched worker bounds ITSELF (plan 2694)

Hang detection is not a budget. The only worker-liveness trigger that exists anywhere is _silent
hang_ (output-file mtime staleness → `TaskStop`, per the project's own orchestrator design spec
§ Error handling); a worker that is still actively working — just slower and worse at 400k
context than it was at 40k — trips nothing. So the bound goes INSIDE the dispatch, and the worker
enforces it on itself.

Every fix-loop / burndown dispatch prompt carries this block **verbatim, inside the prompt text**.
A budget stated NEXT to the prompt never reaches the worker:

> **Budget + yield.** You have **20 minutes wall-clock or 5 distinct root-cause fixes, whichever
> comes first**. On breach do NOT keep going: (1) commit whatever is complete and internally
> green (a `…-wip` subject suffix is fine) and push it under the repo's standard push discipline
> — do NOT invent a push shape here — then confirm the tip reached origin; (2) leave the tree
> CLEAN — revert (`git checkout -- <path>`) anything half-done you did not commit, never leave
> uncommitted dirt for the next worker to inherit; (3) return `status: "yielded"` with a COMPACT
> handoff — `fixed[]` (one line each), `remaining[]` (the still-failing tests / findings),
> `root_cause_notes` (what you learned that the next worker should not have to re-derive),
> `files_touched[]`, `files_reverted[]`; (4) STOP. Returning under budget with work remaining is
> a SUCCESS, not a failure. Grinding past it is the failure.

The orchestrator then **verifies the push actually reached origin** (a worker's own push can die
silently at its turn end — the worker's own push attempt is belt-and-suspenders, never a transfer
of ownership; the orchestrator owns pushes and owns the recovery, which follows the project's
existing push-retry rule rather than anything invented here: the project `CLAUDE.md` § Push retry
discipline — probe `push-queue-status.mjs` before ANY retry, because a silent push is presumed
QUEUED, not dead), confirms the tree is clean, and dispatches a **FRESH** worker on the same
cluster with that handoff — new context, work already committed — repeating until the cluster is
green or a bound is spent.

- **The yield chain is capped: 3 consecutive yields on one unit, then park it.**
  **This is the ONE definition of the cap** — every other surface (the drain runbooks,
  `batch-train`'s derailment rule, `claim-plan.mjs`'s claim-time print) points here rather than
  restating the number, so retuning it is a single edit plus the keep-in-sync note above. Without
  the cap, "a yield is not an attempt" makes the fix loop unbounded — a worker that yields forever
  never spends the 2-tries-per-cluster bound. A 4th yield means the unit is bigger than the
  burndown model can absorb or the budget is mis-sized for it; either way that is a decision, not
  more dispatching. Park with the accumulated handoffs as the question.

- **This is a graceful yield, not a kill.** Nothing is terminated mid-flight, so it does not
  collide with the project's own parallel-drain design spec's never-kill-in-flight
  rule: the task is bounded at dispatch time and the worker returns of its own accord with its
  work committed. It generalizes the continuation-worker pattern already in that spec
  (§ Blocked-plan triage) — a handoff plus a fresh worker resuming the existing pushed branch.
- **The numbers are defaults, not physics.** 20 min / 5 fixes are the pinned starting values;
  tune them per dispatch when the work's shape justifies it. The CONTRACT — declared budget, WIP
  commit, compact handoff, fresh re-dispatch — is what binds.
- **Do not conflate it with the session-level window wip-push** (an inline fable plan pushing WIP
  because the 5-hour usage window closed, `docs/coord/local-drain-loop.md` § Modification 2).
  That is an orchestrator saving its own run; this is one dispatched worker bounding its own
  context. Both can be in play at once and neither implies the other.

## Red flags — you are about to break the invariant

| Thought                                   | Reality                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| "Faster to read/edit it myself"           | Each such read is bulk content at heavy-model prices, resident in context for the rest of the session. Delegate. |
| "I need to see the diff to trust it"      | That's what gates are for (rule 2).                                                                              |
| "Writing subagent prompts takes too long" | A good prompt is your decision made explicit — that IS the judgment work you're here for.                        |
| "I'll record decisions at the end"        | Sessions die mid-work. Rule 3 is per-decision, not per-session.                                                  |
| "12 tests are red — 12 fix agents"        | Triage first. N failures are frequently 1 bug; un-triaged fan-out means N−1 agents editing the same file.        |
| "It's still making progress, let it run"  | Progress at 400k context is not progress at 40k. The budget is the point — yield and re-dispatch fresh.          |

## Common mistakes

- Letting subagents inherit the orchestrator's model — pass `model` explicitly on every dispatch.
  Claude Code's `Task`/`Agent` dispatches and `Workflow` `agent()` stages ALL inherit the session
  model unless overridden, so in a Fable session an unpinned dispatch is silently a Fable worker
  at Fable prices (observed: the plan-1592 session's unpinned Explore agent, 2026-07-08).
- Delegating the _judgment_ along with the bulk work: the subagent reports findings, the orchestrator
  decides. If a subagent prompt contains "decide whether…", reconsider it.
- Holding scope debates in conversation instead of amending the plan body (that's just spec-pass done
  late — do it in the artifact).
