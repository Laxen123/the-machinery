---
name: done-worktree
description: Use when a worktree's plan is complete and the branch should land on master for good. Merges the worktree branch into master, verifies the deploy if the project auto-deploys, archives the plan, extracts any remaining carry-forwards into NEW plans (per the "no perpetual deferral" rule), updates the project's handoff active-worktree board, then tears down the worktree directory + branch (local + remote). Trigger when the user says "done with X", "/done-worktree", "finish the worktree", "wrap X plan", "complete X worktree", or otherwise signals that a worktree should be closed for good rather than merely paused. NOT for end-of-day pauses — leave the worktree as-is and run `node scripts/board.mjs set-state <slug> PAUSED` instead.
---

# done-worktree — close out a worktree for good

The companion to `pickup-plan`. `pickup-plan` claims a plan in `handoff.md` and creates a worktree; `done-worktree` lands the work on master, satisfies the "no perpetual deferral" rule for carry-forwards, and tears down the worktree so `/state` no longer surfaces it.

> **NEVER run `done-worktree --wait` DETACHED (background / piped / non-TTY) — foreground only (the project plan 665 G4).** A detached `--wait` polls in-process and can be KILLED after the land already completed, reporting **exit 255 with empty output** — a false-failure that nearly drove a clobbering hand-merge. The the project spine now refuses `--wait` when stdout is not a TTY (override `DW_ALLOW_DETACHED_WAIT=1`); for unattended landing, drop `--wait` and let the `QUEUE_WAIT` seam retain the slot, then re-invoke when near the head. Every exit writes `.scratch/done-worktree-<slug>.result.json` — read its `mergeSha` (and **verify patch-ids**, since a re-applied-SHA merge makes `merge-base --is-ancestor` a false negative) to know whether a land actually completed BEFORE any hand-merge recovery.

**Everything this skill knows is in THIS file.** It previously advertised three sibling references — `race-safety.md`, `incident-history.md`, and a "full 28-row mistake catalog" `common-mistakes.md` — none of which has ever existed in git history. The content they promised is inline and stays inline: the LANDING-mutex and push-rejection rationale lives with steps 3, 4 and 9; the incidents that motivated each rule are cited in place, with their dates and plan ids; the mistake catalog is § Critical mistakes below. When you learn a new one, add it there rather than reintroducing a sibling file.

## When to use vs pausing for the day

| Intent                                                         | Use                                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| You're done with this work — merge it and delete the worktree  | `done-worktree`                                                            |
| You're pausing for the day; will resume later in same worktree | Leave the worktree as-is; `node scripts/board.mjs set-state <slug> PAUSED` |

**Do NOT use `done-worktree` when:**

- Work on the plan is still active
- Another agent or operator is mid-action in the worktree
- The worktree has uncommitted experiments you haven't decided about
- The branch is diverged from master in conflicting ways — resolve first

## Plan-state subfolder convention

`pickup-plan` step 4d moves the plan into `plans/in-progress/` on projects using the convention; older / flat projects keep it at `plans/` root. Step 6 below uses an `ls` probe to find the plan wherever it actually is.

Carry-forwards extracted as NEW plans (step 5) file by readiness:

- `plans/ready/` if it exists, else `plans/` root — READY-TO-START
- `plans/waiting-blocked/` — blocked on a not-yet-archived plan (body MUST name the blocker — step 6b's grep keys off it)
- `plans/waiting-date/` — calendar trip
- `plans/waiting-trip/` — external condition trip (may never fire)

Detect via `[ -d plans/ready ]` and `[ -d plans/waiting-blocked ]`; if absent, file at root and skip step 6b's promotion.

## Pre-reqs

- Inside the repo (any worktree)
- The worktree's branch is pushed to origin
- The worktree's claim entry exists (in `docs/handoff/sessions/` for the project, or `handoff.md` for legacy projects)
- Review verdict AND wiki decision recorded for HEAD (`record-review.mjs`, then `record-wiki.mjs` if it says one is due)

## Execution — call the spine (the project), one invocation

For the project (where `scripts/done-worktree.mjs` exists), the deterministic spine is **ONE call** — not the ~30 agent-narrated steps below:

```bash
node scripts/done-worktree.mjs <slug>
```

It runs preflight → lane merge → deploy check → close-out → teardown in a single process and prints the step-12 report.

### The invocation shape is FIXED — never choose a timeout per session

Operator ruling 2026-08-24, verbatim: **"I don't want random choices for the timeout."** Use the row
for your environment exactly as written. The numbers below are the contract, not a starting point.
`14400` is `land.localTimeoutSeconds` in `coord.config.json` (plan 3960), read by
`scripts/hooks/land-timeout-guard.mjs`; this repo's config sets no override, so today's value is
exactly the number below.

| Where you are                                         | Shape                           | Inner `timeout`           | Tool timeout |
| ----------------------------------------------------- | ------------------------------- | ------------------------- | ------------ |
| **LOCAL top-level session** (shared Windows checkout) | `run_in_background: true`       | **`timeout 14400`** (4 h) | n/a          |
| **CLOUD drain sandbox**                               | FOREGROUND, always              | none                      | `600000`     |
| **Dispatched subagent** (any environment)             | FOREGROUND, backgrounds NOTHING | none                      | `≥ 600000`   |

```bash
# LOCAL top-level, the only correct form — plan 3781: tees the full run to
# .scratch/land-<slug>.log so the failure report above the seam `state` JSON is
# never cut by `tail -60` (the JSON alone runs ~45 lines):
timeout 14400 node scripts/done-worktree.mjs <slug> 2>&1 | tee .scratch/land-<slug>.log | tail -60; echo "LAND_EXIT=$?"
```

**Why 4 h and not "about right": the two errors do not cost the same.** A cap set too long costs
NOTHING — the land exits by itself the moment it finishes, and the inner `timeout` exists only so the
MSYS bash wrapper terminates on its own (the harness's Windows kill misses those wrappers, which is
the whole reason a backgrounded command needs one). A cap set too SHORT kills a land mid-gate and
burns the wall-clock already spent plus the queue slot's turn. The distribution is fat-tailed and not
under your control: a land behind two other sessions' full suites routinely exceeds an hour of
QUEUE-WAIT before its own gates even start. So the cap is set once, high, and never re-derived.

⚠️ **Do not carry a timeout over from another command.** A `git push` cap (sized against that gate's
1500 s queue-wait) is not a land cap; reusing it is how this rule got written — a 2026-08-24 land was
SIGTERM'd at 56 min by a number copied from the session's previous push, costing an hour and a
re-queue. If you find yourself picking a number, you are already wrong: read the row above.

**A killed land is not lost work.** `done-worktree` is idempotent on re-invoke, retains the queue slot
(`state=HOLDING`), and persists per-gate progress in `<worktree>/.scratch/gate-ledgers/` +
`.scratch/land-gates-proven.json`. Re-invoke BARE and it resumes from the ledger rather than restarting.
That is recovery, not a reason to shorten the cap.

**Lane detection is `seedScopeOf()` over the diff's PATHS — not one file.** (The old `backend/src/data/seed-records.json` monolith it used to watch is retired.) Per-record shards `<data-dir>/records/<CC>/record-<id>.json`, and the record-sharded DERIVED trees (`render-fingerprints/`, `render-store/`), resolve to a `{records:[ids]}` scope. It escalates to `{global:true}` on anything under the seed root that is NOT a per-data shard (a `record-order.json` manifest rewrite, `chains.json`), on an append-only `observations/*.jsonl` touch, or when the touched-record count exceeds 500. Touching no seed or derived surface at all is the free lane — no lock.

**The LANDING mutex is record-shard-SCOPED, not binary** (plan 1300). 🟩 non-seed lands take no lock. A 🟥 seed land acquires `landing-lock` with the scope above and blocks **only on an OVERLAPPING holder** — two 🟥 lands over disjoint record sets acquire concurrently; a `{global:true}` scope serializes against every other seed land. The `🟢 LANDING` board row is still the cross-PC marker. A resurrected monolith is NOT part of this scoping: it is a separate pre-emptive halt (`MONOLITH_RESURRECTED`, below) that exists because the deleted monolith reader used to make the `STATUS_FLIP` / `PRICE_GATE_FAILED` gates silently no-op on such a diff.

The script HALTS with `HANDOFF:<CODE>` + a nonzero exit at a seam. Do the one thing, then re-invoke `node scripts/done-worktree.mjs <slug> --resume <CODE> [--decision …]` — **or bare, where the row says so** (a gate that re-reads state on its own has no `--resume` alias, and passing one is an error, not a shortcut).

The table below is the WHOLE enum — all **27** codes in `SEAM` / `EXIT` in `scripts/coord/done-worktree-lib.mjs`, regenerated from the source at 2026-08-16. Codes split three ways, and knowing which you are looking at is most of the recovery: a **halt-and-fix** is an engineering failure (fix it, re-run — no decision to make), a **judgment fork** genuinely needs a session or the operator to decide, and a handful are **operational waits** that resolve by re-invoking. If you add a seam, add its row here in the same change.

| HANDOFF code             | exit | What you do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PREFLIGHT_FAIL`         | 10   | **Halt-and-fix.** A structural/env precondition: worktree HEAD not attached to its branch, `node_modules` missing for a gated app-source diff (or for the post-rebase prettier check), or the seed landing-lock still BUSY/STALE after the stranded-lock reclaim. Fix the named condition and re-invoke **bare** — there is no `--resume PREFLIGHT_FAIL`; a fresh run re-checks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `REVIEW_NEEDED`          | 11   | **Judgment fork.** No sha-pinned review verdict for HEAD. Run the review on `origin/master...HEAD` in this session's lane: **`/gpt-review` on a LOCAL session or a FULL-EGRESS cloud env** (the default — codex-CLI Luna finders + Sol adjudicator, plans 2663/2665), **`/sonnet-review` on a trusted/limited-egress cloud env** (also the universal fallback when codex transport fails); Opus-xhigh `/code-review` only for the rare highest-stakes diff. **Avoid this halt entirely:** record at review time with `node scripts/record-review.mjs <PASS\|NITS\|BUGS-FOUND> --review-method <lane>` — it writes the sha-pinned `Review: <verdict> @ <HEAD>` marker `recordedReviewVerdict()` honors (command-agnostic), so a clean PASS land skips this seam with no `--resume` (plans 337/493; re-run after further pushes — the marker goes stale with the sha). A `NITS`/`BUGS-FOUND` verdict clears _this_ seam too but must carry `--findings <json>`; `FINDINGS_OPEN` then takes over. `PASS` needs no findings. |
| `REBASE_CONFLICT`        | 12   | **Judgment fork — but dormant at HEAD.** `rebaseSeam()` still returns it (freshen-merge conflict, or a rebase conflict spanning ≤3 replayed commits), yet its one call site re-codes the whole rebase family to `LAND_BLOCKED_HOLDING`, so what you actually see is exit 19 carrying this name in its reason text. It survives as a legacy `--resume` alias. Recovery either way: resolve in the worktree, `git rebase --continue`, resume.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `REBASE_UGLY`            | 13   | **Judgment fork — dormant at HEAD, same re-coding as 12.** Fires when the conflict spans >3 replayed commits or the rebase was already aborted once. Surface to the operator — the branch may be too divergent to land (the `009-common-services` pattern).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DEPLOY_FAILED`          | 14   | **Halt-and-fix.** A prod service's latest deploy is a confirmed failure at post-merge deploy-check. Surface to the operator; the script already demoted the row and released the mutex before halting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `CARRYFORWARD_AMBIGUOUS` | 15   | **Judgment fork.** An ambiguous carry-forward bullet in the plan body with no `--decision` and no `--carryforward-defer`. Ask the operator the ≤2-option question per listed bullet, resume with `--decision`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PROMOTE_AMBIGUOUS`      | 16   | **Reserved — cannot fire at HEAD.** The code exists in `SEAM`/`EXIT` and in `seamShortReason`, but no `emitSeam` call site references it. Seeing it in the wild would be a spine bug to report, not a decision to make.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `LAND_BLOCKED`           | 17   | **Halt-and-fix.** The shared MAIN tree is unlandable (unpushed master, orphan autostash, unmerged paths), or the ephemeral merge threw a typed non-conflict error (`unpushed-master` / `master-diverged-post-land`). Fix the shared tree, then re-invoke; the queue slot is already released.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `QUEUE_WAIT`             | 18   | **Operational wait, not a fork.** Your branch is not at the FIFO head yet. Re-invoke; unattended, use `--wait-chunk` in the SAME turn (~8 min in-process per call, zero model tokens) until it reports AT HEAD. Never `--wait` detached, and never hand-roll a model-turn polling loop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `LAND_BLOCKED_HOLDING`   | 19   | **Mixed — read the reason text.** The umbrella hold-through-conflict seam: rebase/freshen-merge conflict, graft refusal, hook-rejected push, sync-lock race, an ephemeral-merge content conflict, push non-ff exhausted, or a `--resume`-past-conflict push-verification mismatch. A genuine content conflict is a judgment fork; the push-block and lock-race variants are halt-and-fix. **This row holds the queue head** — do not dequeue it from another session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `BUILD_FAILED`           | 20   | **Halt-and-fix.** The diff touches `frontend/src/**` and `pnpm --filter @<project>/frontend build` failed. Fix and re-run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| _(21)_                   | 21   | Intentional gap — the retired `ARTIFACT_STALE` seam (plan 1024). Kept empty so no exit code is ever renumbered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `COORD_CONTENTION`       | 22   | **Halt-and-fix / transient.** A `--wait` land's coordWrite stayed blocked by a sibling's foreign dirt for the whole retry budget. Usually clears on a bare re-invoke once the sibling commits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `MOBILE_FAILED`          | 23   | **Halt-and-fix.** The diff touches a watched landing/composer/mobile surface and the WebKit T1–T7 gate failed. Fix and re-run. (A dedicated-port collision is excluded and does not raise this.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ARCHIVE_UNRESOLVED`     | 24   | **Judgment fork, post-merge.** Close-out cannot find the plan file in any live status folder and it is not already archived. A human must locate or restore it — the branch has already merged, which is why `landSeamDisposition` routes this to the operator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `STATUS_FLIP`            | 25   | **Judgment fork.** The seed diff flips a record's `operationalStatus` across active/closed without the required rationale (`statusNote` / `verifications[]` / `closedAt`). Supply it, or resume with the conscious operator waiver.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `WIKI_CHECKPOINT`        | 26   | **Judgment fork.** The diff touches a wiki-owned subject with no fresh `Wiki: WROTE\|SKIP @ <sha>` decision recorded. Decide and record it — write-back is the default, SKIP is a real answer you must state. **Avoid this halt entirely:** record the wiki decision right after the review — `record-review.mjs` now prints the command when it is due; `node scripts/record-wiki.mjs WROTE "<pages>"` or `SKIP "<why>"` writes the sha-pinned marker the seam honors, so the land skips this seam with no `--resume`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PRICE_GATE_FAILED`      | 27   | **Halt-and-fix, absolute.** The diff changes a record's `prices[]` and that record fails the extraction-trust gate. There is no override valve — fix the rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `FINDINGS_OPEN`          | 28   | **Judgment fork — findings-as-data land gate (plan 1205).** A recorded `NITS`/`BUGS-FOUND` blocks the land until **every** finding in the sidecar is dispositioned: `node scripts/record-review.mjs disposition <key> --plan <id>`, `--fixed` (the fix-now-first default), or `--wontfix "<reason>"`. **No `--resume FINDINGS_OPEN` exists** — disposition each, then re-invoke **bare**; the gate re-reads the record. `BUGS-FOUND` no longer hard-blocks — a known bug lands once its plan is filed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `LAND_BLOCKED_REQUEUED`  | 29   | **Spine self-defense, no decision.** As head-holder your recovery escalated to heavy rework (a second conflict, a non-identical-patch-id rework, or a >8 min head-hold) while a waiter was queued, so the spine auto-released you to the tail. Finish the rework during the tail wait and let the queue come back around.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PRETTIER_DRIFT`         | 30   | **Halt-and-fix.** Files that passed the worker's own prettier check now fail against the rebased tree — master's prettier config advanced under you. Re-format and re-run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `CONCLUSION_REVIEW`      | 31   | **Judgment fork.** The seed diff overwrites a field named in `land.worldClaimFields` (`coord.config.json`) with no fresh `Conclusion: UPHELD @ <sha>` verdict. Run the adversarial refuter review and record it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ~~`LANDED_REVERSION`~~   | —    | **RETIRED (plan 3832, 2026-09-08).** The landed-work-reversion lint is ADVISORY: `done-worktree` PRINTS what the merge removes from master (file, line count, the plans that landed those lines) and proceeds to the merge. No seam, no exit 32, no `ALLOW_LANDED_REVERSION=1`, no `--allow-landed-reversion*` flags — nothing to resume past and nothing to release. Detection is unchanged; only the halt is gone. Read the advisory, and if a named line was not meant to go, patch-replay rather than whole-file-restore (`docs/coord/worktrees.md` § Landed-work-reversion lint).                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DEPLOY_GATE_FAILED`     | 33   | **Halt-and-fix.** `--deploy`'s mandatory pre-POST wall failed: missing `RENDER_API_KEY`, a deploy-tree fetch/build failure, or one of the battery / build / mobile / market-copy gates. Un-prunable by design (plan 2875) and never runs on a plain land.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PYTEST_FAILED`          | 34   | **Halt-and-fix.** The diff touches `backend/scripts/**` or `shared/src/**` and the full pytest suite failed. A `ModuleNotFoundError` here is a missing dep, not a broken test — install and re-run, never `--no-verify`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `BATTERY_FAILED`         | 35   | **Halt-and-fix — UNLESS the seam says the run was KILLED.** The diff touches `scripts/**/*.mjs` and `node --test` failed — the diff-scoped selection on a LOCAL land by default (plan 4004; an unselectable diff falls through to the full battery, and the seam says so), or the full battery on a cloud land / a fall-through / a `landGate: selective` plan. Under parallel-session load a battery red with a shifting failure set is load flake — re-run the named files ALONE before believing it. Since plan 4003 the seam distinguishes a REJECTION from a KILL (its cap fired, or its termination could not be proven): a killed run has nothing to fix, banks whatever it had already proved as a partial land-gate proof, and continues from the remainder on a BARE re-invoke — same slug, no rebase, and specifically NOT `--resume BATTERY_FAILED`, which skips the battery outright and would land the unproven remainder unverified.                                                                      |
| `MONOLITH_RESURRECTED`   | 37   | **Judgment fork.** The diff reintroduces the retired `backend/src/data/seed-records.json` monolith. Checked pre-merge on changed files alone, because the deleted monolith reader used to make `STATUS_FLIP` / `PRICE_GATE_FAILED` silently no-op on such a diff. Almost always: drop the file. Has an explicit conscious operator-waiver `--resume`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `BATTERY_STARVED`        | 49   | **Pre-merge/resumable, same family as `BATTERY_CHUNKED` — nothing to fix.** The scripts-battery preflight (full, diff-scoped, or a partial proof's unproven remainder) — or its plan-3827 isolation recheck — was never admitted to the shared heavy-test queue, or itself died with a Windows spawn-init/OOM signature (plan 4006; the seam message names which). Never auto-greens (still blocks the land), but carries **no `--resume` skip code**: `--resume BATTERY_FAILED` would skip the battery step outright and land the unproven remainder unverified, so the recovery is a BARE re-invoke — same slug, no rebase — once the shared queue is free or the box has headroom. (`PYTEST_STARVED`, exit 48, is this seam's pytest twin and is not itself in this table — a pre-existing gap, not introduced by this plan.)                                                                                                                                                                                         |

**For a clean docs-only land there are NO seams → one invocation, done.** The `HARD SAFETY INVARIANT` (every halt between LANDING-claim and release demotes the row + releases the same-PC lock) is enforced inside the script's `try/finally` (`done-worktree-lib.mutexHeld`), and is covered by its name-paired test.

### Close-safety banner — relay it as the LAST line of your message (the project, plan 692)

The spine prints a deterministic **close-safety banner** as the FINAL stdout line of every exit. **End your operator-facing message with that exact banner line**, so the operator — piloting ~7 parallel sessions — gets an unmistakable 🟢/🔴 "can I close this session?" verdict without reading the whole report:

- **Clean land (exit 0):** `🟢 Safe to close · HH:MM` — the work is on master and the worktree is torn down; nothing left to do here. (A best-effort teardown that left residue still lands green, with `— teardown incomplete, see notes above`.)
- **Any seam / pause (nonzero exit):** `🔴 <very short why> · HH:MM` — e.g. `🔴 Waiting in queue (position 3) · 14:32`, `🔴 Needs code review · 14:32`, `🔴 Rebase conflict · 14:32`, `🔴 Build failed · 14:32`. The land is **NOT** complete; resolve the named thing and re-invoke. Do **not** tell the operator the session is safe to close.

Echo the banner **verbatim** — it already carries the reason, the queue position, and the local HH:MM. Never paraphrase a spine 🔴 into a 🟢 (or vice-versa): the emoji is the operator's go/no-go signal.

### Dispatching the spine from a heavy-model orchestrator (the project — courier pattern)

The twin of pickup-plan's Sonnet-dispatch section, with a different split: landing on the project is already ONE deterministic call, so the win is not step-collapse but keeping the spine's long report (and repeated queue-wait re-invocations) out of the expensive context. On a heavy-model session (Fable/Opus), dispatch a **Haiku courier** to run the call and bring back a structured result. (Micro-tested 2026-07-22, Haiku: 5/5 compliant with the prompt below; the no-guidance control arm reproduced the exact failure this guards against — a subagent "helpfully" recording a fake `PASS` review marker and self-resuming the land.)

**Dispatch WHEN:** the review verdict is already recorded (sha-pinned marker at current HEAD) and you expect a clean or merely queued/gated land. **Run inline WHEN:** a seam is likely (unrecorded review, known rebase conflict, ambiguous carry-forwards) — each seam round-trip costs a fresh subagent spin-up, and every seam is orchestrator judgment anyway. The courier NEVER substitutes for the review: a subagent has no Workflow tool, so a Claude-lane review it ran would be substitute-tier provenance (plan 2162) — `/sonnet-review` runs from the top-level session, before the dispatch. (`/gpt-review` is the exception a subagent CAN run, being a plain-CLI runner rather than a Workflow fan-out; it is also the default lane locally and on full-egress cloud.)

**Courier prompt (tested form — keep this shape):**

```
Agent({ subagent_type: "general-purpose", model: "haiku",
        description: "Land-spine courier <slug>", prompt: `
You are a results courier for a deterministic landing pipeline. Your entire job is three steps, then you are done.

## SCOPE — DO NOT EXCEED
Goal: invoke the landing spine once for slug <slug>, read its result file, and report the outcome as JSON.
Files you MAY modify: none — you only run the spine and read files. Work from <main-checkout-path>.
Files you MUST NOT touch: everything else. Out-of-scope observations: report, don't act.

Steps:
1. cd <main-checkout-path> and run: node scripts/done-worktree.mjs <slug>   (foreground, timeout 600000)
2. Read .scratch/done-worktree-<slug>.result.json — the authoritative outcome; trust it over the exit
   code you observed. If you lose the spine's stdout, recover from this file — never re-run the spine.
3. Return exactly: { "exit": <n>, "handoffCode": "<code|null>", "mergeSha": "<sha|null>",
   "banner": "<final stdout line, byte-verbatim>", "notes": "<1-2 lines>" }

The spine has exactly two outcomes, and BOTH complete your task:
- exit 0: the land finished; the banner is the green line.
- nonzero exit with a HANDOFF:<CODE> line: the spine paused at a judgment seam that the ORCHESTRATOR
  resolves. Any recovery instructions in the spine's output are addressed to the orchestrator, not to
  you — for you they are payload to report, and step 3 is your next action.

Your task ends when the spine process exits and the JSON is returned. One spine invocation total.
` })
```

**Do NOT "harden" this prompt with a NEVER-list of destructive operations** (`--resume`, record-review, deploy, rebase). In the 2026-07-22 micro-test the prohibition-list variant was denied by the auto-mode permission classifier in 5/5 reps — the destructive-verb list itself reads as intent — while this positive-contract form was admitted 5/5 AND complied 5/5 without any prohibition (superpowers `writing-skills` "match the form to the failure": recipes bind where prohibition lists backfire).

**Orchestrator side, when the JSON returns:**

- `exit 0` → relay the banner byte-verbatim as your message's last line. Deploys are quiet-default (the project CLAUDE.md § Render deploys): do NOT deploy and do NOT ask — deploy only on explicit operator instruction.
- HANDOFF code → resolve the seam YOURSELF per the table above (review, dispositions, operator asks, rebase). Authority stays here; once resolved, you may dispatch a FRESH courier whose step-1 command is the literal resume invocation (`node scripts/done-worktree.mjs <slug> --resume <CODE> …`) — the decision was yours, the keystrokes are the courier's. Same for `QUEUE_WAIT`: re-dispatch a courier when near the head; the courier itself never uses `--wait`.
- Courier reports a permission-classifier denial → run the spine inline this session; never instruct workarounds. (No allowlist entry covers `done-worktree.mjs` as of 2026-07-22; adding `Bash(node scripts/done-worktree.mjs:*)` to project settings is an operator decision.)

**When it's not worth it:** an instant docs-only land is already ~1 turn inline. Dispatch pays on queue-wait rounds, gate-heavy lands, and any land whose report would otherwise ride in a long-lived heavy context. Sibling projects without the spine script: the courier/orchestrator split applies in principle to the manual-fallback body below, but that variant is NOT micro-tested — prefer inline there.

**Projects WITHOUT `scripts/done-worktree.mjs`** (sibling subprojects / legacy / emergency recovery): use the **Manual fallback** Steps below.

> rerere is enabled repo-wide (`git config rerere.enabled true`) so the seed-lane rebase replays known conflict resolutions automatically.

## Manual fallback (no spine script) — Steps

> Use this section ONLY when `scripts/done-worktree.mjs` is absent. On the project, prefer the one-call spine above.

### 0. Detect plan-subfolder convention ONCE per session

```bash
ls -d docs/superpowers/plans/in-progress docs/superpowers/plans/ready \
       docs/superpowers/plans/waiting-blocked docs/superpowers/plans/waiting-date \
       docs/superpowers/plans/waiting-trip docs/superpowers/plans/archive 2>/dev/null
```

Cache mentally for the rest of the session — DON'T re-run at every subfolder-touching step. Audit of 20 sessions: this orientation `ls` fired ~55× per session because the body re-prompts it at every gate. Branch your downstream flow on the result:

- `in-progress/` exists → step 6's archive sources from there (or wherever the plan lives now)
- `ready/` exists → step 5's carry-forward plans land in `ready/`, else `plans/` root
- `waiting-blocked/` exists → step 6b's promotion grep runs, else skip

### 1. Identify the target worktree

If named by the user, match against `git worktree list`. Otherwise default to the worktree containing the current cwd. Otherwise ask.

Capture: slug, branch name (`worktree-<slug>`), branch tip SHA, worktree dir path, plan file path (read claim entry in `handoff.md`), most recent handoff entry for this worktree.

### 2. Pre-flight check

```bash
# (a) Worktree exists on THIS machine?
git worktree list | grep -F "<worktree-path>"
# If absent + board row's host != $(hostname): STOP — wrong PC (2026-05-18 incident).

# (b) Working tree clean?
git -C <worktree-path> status --porcelain

# (c) Branch pushed up to date with origin?
git -C <worktree-path> fetch origin
git -C <worktree-path> rev-list origin/<branch>..<branch>   # must be empty

# (d) Mergeable into CURRENT origin/master? (advisory only — conflicts here are rebased out in 3b)
git -C <main-worktree> merge-tree $(git merge-base origin/master <branch>) origin/master <branch>
```

Any (a)/(b)/(c) failure → bail with the specific reason. Also confirm the handoff entry is in `⏸ PAUSED` or `🔄 IN PROGRESS` — already-COMPLETED or absent means something else may have closed this out.

### 2.5. Pre-merge code review (content-gated)

Auto-fires when the diff touches source-code paths; skips silently on docs/plans/seed-only worktrees. Runs BEFORE step 3 so a fix loop never requires demoting the LANDING mutex.

**Trigger probe** — does the diff touch anything review-worthy?

```bash
git -C <worktree-path> diff --name-only origin/master...HEAD \
  | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb)$' \
  | grep -vE '(\.test\.|\.spec\.|/tests?/|/__tests__/|/fixtures/|/node_modules/|/seed-[^/]*\.json)' \
  | head -1
```

Empty → **skip step 2.5 entirely** (silent). Note in step 12 as `Review: skipped (no source-code paths in diff)`.

Non-empty → run review.

**Default: orchestrator runs it directly** via `Skill('code-review')` against `origin/master...HEAD`. The orchestrator already has the worktree path, branch name, and diff scope in context from step 1 — a subagent would have to re-discover all of it, and findings will need to drive the next decision either way.

**Escalation to subagent** when the diff is large enough to blow context budget:

```bash
git -C <worktree-path> diff --shortstat origin/master...HEAD
# >500 changed lines OR >10 source files → dispatch a subagent instead
```

Subagent form (only when escalated): `general-purpose`, `model: "sonnet"`, effort high. Brief it self-contained (branch name, base ref, worktree path) and require it to return ONLY a structured verdict:

```
Verdict: PASS | NITS | BUGS-FOUND
Files reviewed: N
Findings:
  - [path:line] one-line description (severity: high/medium/low)
  - ...
```

Whether orchestrator or subagent, the verdict shape is the same. A single Sonnet subagent is well under the >3-parallel / >50-unit cost-flag threshold — no pre-flag required.

**Branch the workflow on the verdict:**

| Verdict                                  | Next                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PASS**                                 | Note in step 12 (`Review: PASS, N files`), proceed to step 3                                                                                                                    |
| **NITS only** (low-severity style/reuse) | Note in step 12, proceed to step 3                                                                                                                                              |
| **BUGS-FOUND** (any medium/high)         | **HALT before step 3a.** Present findings + ask the operator: "Fix in worktree now / open follow-up plan / merge anyway with note in archive prose?" Wait for explicit decision |

"Merge anyway" is the operator's call — record the decision in the per-session handoff entry (step 7) and the archive execution note (step 6), naming each accepted-with-caveat finding. Silence is not consent here either.

**Why before LANDING:** halting in 2.5 costs nothing — no mutex held, no master commit to demote. Halting after 3a requires the full demote-LANDING dance from step 4. Keep review strictly pre-mutex.

### 3. Merge to master — race-safe

The rationale for each guard is stated with the step it protects. The procedure:

**3a. Claim LANDING on origin** (cross-PC mutex — commit + push, NOT a local file edit). The board lives only in `docs/handoff/board.md` (relocated under `docs/handoff/` by plan 857; it was extracted to a dedicated board file at the 2026-05-28 plan-171 cutover).

If `scripts/board.mjs` exists (the project post-plan-205), it owns the atomic pull→mutate→commit→push→retry of the board — one call replaces the whole switch/pull/grep/probe/edit/add/commit/push sequence:

```bash
# (plan 234) Same-PC O_EXCL mutex FIRST — closes the advisory-marker TOCTOU window
# (two same-PC sessions both reading "no LANDING held" before either pushes its row).
# Guarded on the script's existence so sibling projects without it are unaffected.
# One-shot (mirrors the board.mjs landing-held bail pattern below — no long blocking
# Bash call): exit 2 = BUSY (bail, wait ~30s, re-run step 3a), exit 3 = STALE.
if [ -f scripts/landing-lock.mjs ]; then
  node scripts/landing-lock.mjs acquire <slug>; rc=$?
  if [ $rc -eq 2 ]; then echo "landing-lock BUSY — a same-PC sibling holds the landing mutex. Bail, wait ~30s, re-run step 3a (do NOT proceed)."; exit 1; fi
  if [ $rc -eq 3 ]; then echo "landing-lock STALE — a prior landing died holding it. Confirm it is truly dead, then reclaim with: node scripts/landing-lock.mjs acquire <slug> --force-stale. STOP and surface to operator."; exit 1; fi
fi
# Refuse if ANOTHER slug already holds LANDING (exit 0 = held → bail and wait ~30s):
node scripts/board.mjs landing-held --except <slug> && { echo "another slug holds LANDING — wait"; exit 1; } || true
node scripts/board.mjs set-state <slug> LANDING
```

`board.mjs set-state` re-pulls and retries on a non-ff rejection internally, so a parallel claim inside your window is handled automatically (the push-rejection is still the real mutex enforcer). No manual GATE probe is needed — board.mjs only ever touches the single board row. **The O_EXCL `landing-lock.mjs` is the same-PC enforcement layer ON TOP of the cross-PC board marker + push-rejection guard — it does not replace them; cross-PC sessions still serialize on the non-ff push refusal.** It must be RELEASED in step 9 (after the master push) and on every demote/halt between here and there — that's the "finally" (see below).

Fallback (no `board.mjs` — legacy / sibling subprojects, or board still in `handoff.md`):

```bash
git -C <main-worktree> switch master
git -C <main-worktree> pull --ff-only origin master
grep -n "🟢 LANDING" docs/handoff/board.md 2>/dev/null   # if another slug holds LANDING, WAIT (poll ~30s)
# GATE probe: BEFORE editing, confirm no parallel session has any modifications on the board.
# At probe time we have made NO edits yet — any status code other than `??` (untracked) is
# from another session, staged OR unstaged. The old `[AM]M?` filter incorrectly passed staged
# modifications (`M `) through as "our own staged"; fixed to `^\?\?`.
DIRTY=$(git -C <main-worktree> status --porcelain -- docs/handoff/board.md 2>/dev/null | grep -vE '^\?\?' | head -5)
if [ -n "$DIRTY" ]; then
  echo "done-worktree LANDING claim: GATE probe found modifications on docs/handoff/board.md owned by another session:"
  echo "$DIRTY"
  echo "Another session is mid-flight. STOP — surface to operator before claiming LANDING."
  exit 1
fi
# edit docs/handoff/board.md → flip this worktree's row State to 🟢 LANDING
git -C <main-worktree> add docs/handoff/board.md
git -C <main-worktree> commit -m "chore(handoff): claim LANDING <slug>"
git -C <main-worktree> push origin master
```

If the project hasn't extracted the board yet (legacy / pre-extraction projects where the board still lives in `handoff.md`), edit + stage `handoff.md` instead.

Push rejected (fallback path) → another session claimed inside your window. `pull --ff-only` again, see their LANDING row, wait for it to clear, retry. The push-rejection is the actual mutex enforcer. **Never `--amend` after a rejection** (that rewrites a commit another session may already be using as a base); **never `--force` master.** Make a fresh commit if needed.

For an ad-hoc same-session worktree with no board row: still check for other `🟢 LANDING` rows, but skip claiming.

**3b. Rebase the feature branch on current master, in the worktree:**

```bash
git -C <worktree-path> fetch origin
git -C <worktree-path> rebase origin/master
# resolve conflicts here, where this session has context
git -C <worktree-path> push --force-with-lease origin <branch>   # never plain --force
```

Conflicts at this step are expected under parallelism — pre-flight (d) was against a now-stale master. **The rebase is mandatory even if the feature branch looks "only a few commits behind"** — audit of 20 sessions: skipping the rebase produced 24 git stash/reset/abort operations in the worst case, all clustered at the merge step where conflict resolution lacks worktree-author context. Rebase early, resolve in the worktree, push.

If the rebase gets ugly (>3 conflicting commits, or you've already done `rebase --abort` once), **stop and surface** rather than continuing to fight it — a long-divergent branch may need operator review of whether the work is still mergeable (the project 2026-05-27 `009-common-services-backfill-phase2` worktree was declared SUPERSEDED for exactly this reason).

**3c. Merge with `--ff-only` pull as the race guard:**

```bash
git -C <main-worktree> switch master
git -C <main-worktree> pull --ff-only origin master
git -C <main-worktree> merge --no-ff <branch> -m "Merge <branch>: <one-line summary>"
git -C <main-worktree> push origin master
```

Summary format matches the project's recent `Merge worktree-*` commit. Rejected `pull --ff-only` or `push` → re-run 3b + 3c. **Never `--force` master.**

### 4. Verify auto-deploy (project-specific)

If the project auto-deploys (Render, Vercel, etc.), **fire ONE check, then decide**. Do NOT poll in-conversation — every poll burns a full Opus cache-read cycle (parent CLAUDE.md "render-deploys.md" rule; the rationale lived in that runbook but the skill body contradicted it). Vetapp pattern:

```bash
source ~/.bashrc
curl -s -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/<srv-id>/deploys?limit=1"
```

Branch on the single response:

- **`live`** → proceed to step 5.
- **`build_failed` / `deploy_failed`** → HALT (and demote LANDING — see below).
- **`queued` / `building`** → output the merge SHA and one line `Deploy still building at <sha> — re-check on next handoff; not polling in-context.` Then **proceed to steps 5-11 anyway** (the deploy will finish on its own; halting here just leaves a stuck mutex). If the deploy is critical-path for follow-up work in this session, use `ScheduleWakeup` 1200s with a single re-check, NOT a sleep loop.

Auto-mode: per parent CLAUDE.md, prefer batched end-of-session sweep over per-merge polling. The audit found 11+ curl calls per done-worktree session — kill that pattern by exiting step 4 fast.

**Deploy failed → HALT** _and_ demote the LANDING row before halting (in `docs/handoff/board.md`).

If `scripts/board.mjs` exists (the project post-plan-205):

```bash
node scripts/board.mjs set-state <slug> IN-PROGRESS
```

Fallback (no `board.mjs`):

```bash
# edit docs/handoff/board.md → 🟢 LANDING → 🔄 IN PROGRESS, note "deploy-fail @ <merge-sha>"
git -C <main-worktree> add docs/handoff/board.md
git -C <main-worktree> commit -m "chore(handoff): demote LANDING <slug> — deploy-fail"
git -C <main-worktree> push origin master
```

Same demote-before-halt rule for **any** reason you halt between step 3a and step 9. Never leave a stale `🟢 LANDING` row on origin. **And release the same-PC O_EXCL mutex on every such halt** — otherwise a same-PC sibling blocks until it ages past `--stale-min` (35 min):

```bash
[ -f scripts/landing-lock.mjs ] && node scripts/landing-lock.mjs release <slug>   # idempotent
```

No obvious deploy target → report "Auto-deploy verification: skipped" and proceed.

### 5. Extract carry-forwards to new plans

Read the worktree's handoff entry (the most recent `## YYYY-MM-DD (... <slug> ...)` block). Find its "Carry-forward" / "What's left" / "Remaining" section.

**Speed rule (saves an AskUserQuestion round-trip on every done):** if a carry-forward bullet already names its disposition explicitly — `→ open new plan X`, `→ won't fix`, `→ shipped in <sha>`, `→ folded into <plan>.md` — **execute it silently**. The operator already decided when they wrote the bullet. Do not re-ask. Only ask on genuinely ambiguous items.

For each item, pick exactly one bucket — **no "deferred with rationale"**:

| Bucket                                                                                                      | Action                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Already done elsewhere**                                                                                  | Strike-through, note where it landed                                                                                                                                                                                                                                                                                               |
| **Trivially small + clearly scoped** (one-line CLAUDE.md tightening, single env-var flip, FEATURES.md note) | **Just do it inline before step 9's commit** — same commit, no asking                                                                                                                                                                                                                                                              |
| **Borderline**                                                                                              | **ASK in ONE compact message before step 9** — ≤2 options each, ≤80 words total per question, no preamble. Skip the question entirely if the carry-forward bullet already names a disposition (see "Speed rule" above). Declined items go in "won't-fix per operator" archive prose; the rest get done inline                      |
| **Won't fix**                                                                                               | ONLY when the operator explicitly says no. Document as "won't-fix per operator YYYY-MM-DD."                                                                                                                                                                                                                                        |
| **Needs its own session later**                                                                             | Open a NEW plan with: scope, **trip-condition** for revival, back-link to this plan. File by readiness (`ready/` if `[ -d plans/ready ]` else root, or `waiting-blocked/` / `waiting-date/` / `waiting-trip/`). Blocked plans MUST name the blocker as `Blocked-by-plan: <blocker>.md` in the body — step 6b's grep keys off this. |
| **Operator decision pending**                                                                               | Resolve in conversation or escalate to a new plan with choices spelled out                                                                                                                                                                                                                                                         |

**Hard rule:** every carry-forward in archive-prose traces to "shipped this session" / "shipped in new plan N" / "operator explicitly declined." Silence is not consent (the 2026-05-24 calibration incident).

New plans get added to the project's `docs/INDEX.md` Active section in the same commit that archives the parent plan.

### 6. Archive the plan

```bash
# Locate the plan (may be in root or any in-flight subfolder)
ls docs/superpowers/plans/<plan>.md \
   docs/superpowers/plans/in-progress/<plan>.md \
   docs/superpowers/plans/waiting-*/<plan>.md 2>/dev/null

git -C <main-worktree> mv docs/superpowers/plans/<wherever>/<plan>.md \
                          docs/superpowers/plans/archive/<plan>.md
```

If found in `waiting-*/` rather than `in-progress/` (or root), that's a `pickup-plan` step 4d skip — note it in the report but archive normally.

Update `docs/INDEX.md`. If `scripts/index.mjs` exists (the project post-plan-206), archive the INDEX bullet atomically (its own commit+push) BEFORE the docs(plans) close-out commit:

```bash
node scripts/index.mjs archive <plan-basename>.md --note "archived YYYY-MM-DD (session N), merged \`<sha>\`."
```

Then the docs(plans) commit (step 9) does NOT touch `docs/INDEX.md`. Fallback (no index.mjs): hand-edit INDEX (remove active bullet + add archive one-liner under the archive header) and fold it into the step-9 commit.

### 6b. Promote `waiting-blocked/` dependents (if any)

```bash
ARCHIVED=$(basename <plan>.md)
PLANS_DIR="docs/superpowers/plans"
[ -d "$PLANS_DIR/waiting-blocked" ] || echo "(no waiting-blocked/ — skipping)"
grep -l "$ARCHIVED" "$PLANS_DIR/waiting-blocked"/*.md 2>/dev/null
```

For each match, verify both:

1. **Named as blocker** (vs context-only reference) — look for `Blocked-by-plan:`, `Blocked by:`, "must ship first", "pre-revival dependency". A plain wikilink doesn't count.
2. **No other open blockers** — scan body for other `<filename>.md` references to plans still in `plans/`, `waiting-blocked/`, `waiting-trip/`, or `waiting-date/`.

Both pass → promote (pick `ready/` if it exists, else root):

```bash
[ -d "$PLANS_DIR/ready" ] && DEST="$PLANS_DIR/ready" || DEST="$PLANS_DIR"
git -C <main-worktree> mv "$PLANS_DIR/waiting-blocked/<plan>.md" "$DEST/<plan>.md"
```

Also update `docs/INDEX.md` path token: if `scripts/index.mjs` exists, use `node scripts/index.mjs move <plan-basename>.md ready/<plan-basename>.md` (fallback: manual). Optionally reframe trip-condition language in the bullet blurb. Include a "Promoted from waiting-blocked/" line in step 12's report.

Edge cases: ambiguous detection → ask before promoting; multiple blockers with only one shipped → leave in `waiting-blocked/`, surface "still blocked by <other>.md" in report.

### 7. Flip the per-session handoff entry to ✅ COMPLETED

Locate this session's existing entry and flip `**Status:**` to `✅ COMPLETED` if not already, adding "Closed via done-worktree on YYYY-MM-DD from host `<hostname>`."

- **post-plan-205 (`docs/handoff/sessions/` exists):** edit this session's file `$MAIN/docs/handoff/sessions/YYYY-MM-DD-session-<N>.md`.
- **legacy:** edit the `## YYYY-MM-DD (... <slug> ...)` block in `$MAIN/handoff.md`.

(Either way this is a coordination path on master — edit `$MAIN`'s copy, staged in step 9.)

**Do NOT remove the worktree's `🟢 LANDING` row here** — that's bundled into step 9's commit so the mutex stays present on origin through the main-worktree-busy window. Removing it now opens a same-PC race — see step 3a.

### 8. cd OUT of the worktree if currently inside it

```bash
cd <main-worktree-root>
```

Step 9's commit uses `git -C <main-worktree>` and doesn't depend on cwd; cd-out before the commit is fine. If `EnterWorktree` was used (not just `cd`), call `ExitWorktree` with `action: "keep"` first (only `keep` — this skill does the actual teardown).

### 9. Commit + push docs(plans) — releases LANDING

Atomic landing-window close: stages plan archive (step 6), INDEX update, any `waiting-blocked/` promotions (step 6b), and the per-session entry flip (step 7). **The `🟢 LANDING` board-row removal is handled separately:**

- If `scripts/board.mjs` exists (the project post-plan-205): remove the row with its own atomic commit+push **BEFORE** the docs(plans) commit — `node scripts/board.mjs remove <slug>`. The docs(plans) close-out commit then does NOT touch `docs/handoff/board.md` at all.
- Fallback (no `board.mjs`): the board-row removal is folded into the docs(plans) commit by editing + staging `docs/handoff/board.md` (or `handoff-board.md` on legacy projects — the single source of truth since the 2026-05-28 plan-171 cutover).

The per-session entry flip writes the session entry either way. If `index.mjs` was used in step 6, `docs/INDEX.md` is already committed — step 9's close-out commit stages only the session entry + archive rename + carry-forward plans (NOT `docs/INDEX.md`).

> **Edit master's copies, never the worktree's.** The coordination files (`handoff.md`, `docs/handoff/board.md`, `docs/handoff/sessions/**`, `docs/INDEX.md`) and the plan-folder state are read off **master** by `/state` and every parallel session. From inside a worktree, resolve the main checkout once and operate there exclusively:
>
> ```bash
> MAIN=$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -1)   # first entry = main checkout
> git -C "$MAIN" rev-parse --abbrev-ref HEAD     # MUST print: master — bail if not
> ```
>
> Then every edit below targets `$MAIN/handoff.md`, `$MAIN/docs/handoff/board.md`, `$MAIN/docs/INDEX.md`, and `git -C "$MAIN" mv` for plan-folder moves. **The Edit/Write tool writes to whatever path you give it** — editing the worktree's own copy silently commits to the wrong branch and `/state` never sees it. `git -C "$MAIN"` only controls where the _commit_ lands; the absolute `$MAIN/…` path is the other half.

```bash
# (1) GATE probe — BEFORE editing the board / archiving / updating INDEX. At probe time we have
# made NO edits yet — any status code other than `??` (untracked) is from another session,
# staged OR unstaged. The old `[AM]M?` filter incorrectly passed staged mods (`M `) through.
DIRTY=$(git -C <main-worktree> status --porcelain -- handoff.md docs/handoff/board.md docs/INDEX.md 2>/dev/null | grep -vE '^\?\?' | head -5)
if [ -n "$DIRTY" ]; then
  echo "done-worktree close-out: GATE probe found modifications on shared paths owned by another session:"
  echo "$DIRTY"
  echo "Another session is mid-flight. STOP — surface to operator before committing close-out."
  exit 1
fi
# (1b) Remove the 🟢 LANDING board row.
#   board.mjs present → its OWN atomic commit+push, do NOT stage docs/handoff/board.md below:
#       node scripts/board.mjs remove <slug>
#   board.mjs absent → edit docs/handoff/board.md to REMOVE the row, and DO stage it below.
# (the per-session entry stays — that's the audit trail; the board row lives in docs/handoff/board.md, the dedicated board file, and is removed separately)
# (2) Catch INDEX.md drift NOW, before the push-side hook does
node scripts/lint-plan-index.mjs --check   # skip if the script doesn't exist in this project
# (3) Stage by EXPLICIT path — NEVER `git add <dir>`. Steps 6/6b's `git -C <main-worktree> mv`
# already staged the archive move + any waiting-blocked promotions in $MAIN's index; a broad
# `git add docs/superpowers/plans` would ALSO consume a parallel session's uncommitted plan rename
# in that dir (the 2026-05-28 race — a `git add docs/superpowers/plans` ate a sibling's claim mv).
# Add only this session's own files, by name. The step-7 entry flip is in:
#   - post-plan-205: docs/handoff/sessions/YYYY-MM-DD-session-<N>.md  (this session's file)
#   - legacy:        handoff.md
# If you used `index.mjs` in step 6, docs/INDEX.md is ALREADY committed — do NOT re-stage it.
# Fallback (no index.mjs): add `git -C <main-worktree> add docs/INDEX.md` before the commit.
git -C <main-worktree> add docs/handoff/sessions/YYYY-MM-DD-session-<N>.md   # post-plan-205; OR `handoff.md` (legacy)
# board.mjs ABSENT (manual fallback) ONLY — board.mjs already committed the removal itself:
# [ -f <main-worktree>/docs/handoff/board.md ] && git -C <main-worktree> add docs/handoff/board.md
# Plus each NEW carry-forward plan created in step 5 (untracked — the git mv staging above misses them):
#   git -C <main-worktree> add docs/superpowers/plans/ready/<new-plan>.md   # one per new plan
git -C <main-worktree> commit -m "docs(plans): done <plan-slug> — <one-line summary>"
git -C <main-worktree> push origin master
# (plan 234) Release the same-PC O_EXCL mutex — the "finally". The cross-PC mutex
# released on the push above; this releases the same-PC layer claimed in step 3a.
# Idempotent (NOOP if absent / not held by this slug); never blocks the close-out.
[ -f scripts/landing-lock.mjs ] && node scripts/landing-lock.mjs release <slug>
```

- Steps 6/6b run `git -C <main-worktree> mv …`, which **stages the rename in `$MAIN`'s index immediately** — so the archive move + any `waiting-blocked/` promotions are already staged before step 9. Do NOT re-stage them with a directory `git add`; that would also sweep in a sibling session's uncommitted rename living in the same dir. NEW carry-forward plans created in step 5 are untracked and DO need an explicit `git add <path>`.
- Push rejected → `pull --ff-only`, re-run lint, resolve, retry. Never `--amend` (rewrites a commit a sibling session may use as a base). Never `--force` master.
- **After this push the cross-PC mutex is released.** Steps 10-11 are best-effort cleanup; failures there don't block other sessions.

### 10. Kill processes spawned in this worktree

Scope: **this worktree's path only** (path heuristic on cmdline/exe). Machine-wide orphan cleanup is the `zombies` skill — don't conflate.

Filter `Win32_Process` (Windows) or `lsof +D` (mac/Linux) on the worktree path, then `Stop-Process -Force` / `kill -9` the matches.

Surface kill count in the step 12 report.

### 10b. Reclaim the worktree's auto-memory

Worktree memory lives at `%USERPROFILE%\.claude\projects\<encoded-cwd>\memory\` — keyed by cwd, NOT deleted by step 11.

Run dry, then apply:

```powershell
pwsh -NoProfile -File "$env:USERPROFILE\.claude\scripts\reclaim-worktree-memory.ps1" -WorktreePath "<absolute-worktree-path>"
pwsh -NoProfile -File "$env:USERPROFILE\.claude\scripts\reclaim-worktree-memory.ps1" -WorktreePath "<absolute-worktree-path>" -Apply
```

NEW → moves; DUP → deletes; **DIVERGED → left in place, never auto-resolved** (surface diff to operator) — a DIVERGED file is the one case where the automation cannot know which side is current, so it never guesses.

### 11. Tear down the worktree

```powershell
# Windows — \\?\ prefix is required for nested node_modules MAX_PATH paths
Remove-Item -LiteralPath "\\?\<absolute-path-to-worktree>" -Recurse -Force -ErrorAction SilentlyContinue
```

```bash
# macOS / Linux
rm -rf <worktree-path>
```

Then:

```bash
git -C <main-worktree> worktree prune -v
git -C <main-worktree> branch -d <branch>             # plain -d; must be merged
git -C <main-worktree> push origin --delete <branch>
```

Failures here (locked files, stale lock, deleted-elsewhere) → surface in the report but do NOT halt. The mutex is already released; the operator can clean up later.

### 12. Report

```
Closed from host: <hostname>
Merged: <branch> → master at <merge-sha>
Live: <service> at <commit-sha> (or "skipped" / "failed — halted")
Plan archived: <plan-file>.md → archive/
Promoted from waiting-blocked/: <list> (omit line if none)
New plans opened: <list with trip-conditions, or "none">
Killed: N processes (or "none found")
Memory reclaimed: N moved, N dup deleted, N diverged left for review (or "none — worktree wrote no memories")
Removed: worktree dir, local branch, remote branch
/state delta: active-worktree row for <slug> removed
🟢 Safe to close · HH:MM
```

The final `🟢 Safe to close · HH:MM` line (plan 692) is the close-safety banner — relay it verbatim as the last line of your message (see "Close-safety banner" above).

## Critical mistakes

| Mistake                                                                                   | Why it bites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Use `done-worktree` for an end-of-day pause                                               | This skill DELETES the worktree. For a pause, leave the worktree and run `node scripts/board.mjs set-state <slug> PAUSED` instead.                                                                                                                                                                                                                                                                                                                                                                          |
| Claim LANDING as a local-only file edit (no commit + push)                                | Other PCs can't see it; cross-PC race. Must be commit + push.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Reorder teardown (10-11) before LANDING release (9)                                       | Teardown failure leaves `🟢 LANDING` set on origin, blocking every other session indefinitely.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Halt without demoting `🟢 LANDING` to `🔄 IN PROGRESS`                                    | Same blocking outcome; always demote + push before halting.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--force` master after a rejected push                                                    | Silently drops another session's work. Rebase + retry instead.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Park a carry-forward as "won't-fix as a plan, just a doc edit" without doing it OR asking | Silence is not consent. Do it inline, or ask "Should I do A, B, C now?" before step 9.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Run `done-worktree` from a PC where the worktree doesn't exist                            | Pre-flight (a) catches it via `host=` mismatch — bail and send operator to the right machine.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Skip step 10b — tear down without reclaiming memory                                       | Worktree memory is keyed by cwd, invisible to parent. Every insight stranded.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Stage cross-session paths without a pre-stage probe                                       | Race: a parallel session mid-`/pickup-plan` has staged OR unstaged modifications on the same shared paths (`handoff.md` / `docs/handoff/board.md` / `docs/INDEX.md`); broad `git add` in step 3a (LANDING) or step 9 (close-out) consumes them under THIS session's commit message. Attribution silently breaks. The probe (`git status --porcelain` on target paths → bail on anything except `??` via `grep -vE '^\?\?'`) catches it BEFORE `git add`. Recurring race shape (4+ incidents, see plan 173). |
| Run the manual 30-step body when `scripts/done-worktree.mjs` exists (the project)              | Wastes ~30 Opus round-trips the spine collapses to ONE call. Use `node scripts/done-worktree.mjs <slug>`; the manual Steps are the no-script fallback only (plan 333).                                                                                                                                                                                                                                                                                                                                      |

## Reference — example completion summary

```
Merged: worktree-vetpris-targeted-retry → master at 70b3491
Live: vetchecker (frontend) + vetchecker-api (backend) on 70b3491 (Render)
Plan archived: 2026-05-17-vetpris-targeted-retry.md → archive/
New plans opened:
  - 2026-05-18-data-pipeline-vetpris-cohort.md (Track 1C, $0, ~4-5 hr wall)
Removed: .claude/worktrees/vetpris-phase4/, branch worktree-vetpris-phase4 (local + origin)
Active worktrees board: row removed.
```
