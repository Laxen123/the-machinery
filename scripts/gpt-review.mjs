#!/usr/bin/env node
// scripts/gpt-review.mjs — the /gpt-review runner (plan 2663).
//
// A codex-CLI GPT review lane for LOCAL sessions: Luna (gpt-6-luna, effort
// high) finds candidates across 11 angles, Luna verifies them grouped by
// (file,line), and any REFUTED-or-failed group escalates to Sol
// (gpt-6-sol, effort high) rather than being silently dropped. Mirrors the
// mechanics of `.claude/workflows/sonnet-review.js` (scope → find → group →
// verify → escalate-on-refute) but calls `codex exec` subprocesses instead of
// the Workflow tool's `agent()`, so a plain CLI process — including a
// dispatched subagent with no Workflow tool — can run it.
//
// Angle texts (correctness A/B/C/P + cleanup reuse/simplification/efficiency/
// altitude/conventions, byte-ported from .claude/workflows/sonnet-review.js;
// guard-fires/writer-trace byte-ported from
// output/reports/gpt56terra-finder-bakeoff-2026-07-30/run_gpt_dgv_arm.py) and
// the codex transport shape (`codex exec -m <model> -s read-only -c
// model_reasoning_effort="high" --output-schema <file> -o <out> -`, prompt on
// stdin, schema-enforced JSON out, "tokens used" parsed from stdout) are
// PORTED, not re-derived — see output/reports/gpt56terra-finder-bakeoff-2026-07-30/
// run_gpt_arm.py + run_sol_adjudicator.py, the proven transport this plan is built on.
//
// Usage:
//   node scripts/gpt-review.mjs [--range <git range>] [--end-ref <ref>]
//                               [--concurrency 4] [--out <dir>] [--repo <path>]
//                               [--paths <glob,...>] [--exclude-paths <glob,...>]
//                               [--no-gate-prep] [--past-cap <reason>]
//
// plan 3966 — no per-call wall-clock kill. Every codex call (finder, verify,
// summary) and the parallel Claude data-grounding arm used to be tree-killed at a
// fixed 15-minute ceiling (`CALL_TIMEOUT_S`, raisable via the now-deleted
// `GPT_REVIEW_CALL_TIMEOUT_S` env knob). Operator ruling, 2026-09-12 (paraphrased,
// confirmed the same sitting): a fixed time limit is not a safeguard unless there
// is evidence that the thing it guards against actually happens; the finder
// timeout had no such evidence, so it goes. What may stay is a check that the
// call is still alive, beginning only after a generous 30 minutes, killing only a
// call that is demonstrably dead, never one that is merely slow. The record
// behind that ruling — every measured firing of the old kill was a healthy call,
// never a stuck one:
//
//   case                                          healthy killed   stuck caught
//   plan 3309, 2026-08-26, 2.8 MB diff             4 (one angle,4x)   0
//   plan 3941 round 4, 2026-09-12, 117 KB diff     10 (7 + 3)          0
//
// And the T0 measurement this plan built the replacement probe on: one real
// `codex exec` finder call (gpt-5.6-luna, effort high, long-reasoning prompt) ran
// to a healthy exit-0 completion in 301 s. New bytes on the child's stdout+stderr
// arrived 64 times, first at 1.4 s, last at 301.1 s, with a max silent gap of 83 s
// (progress goes to STDERR — 63 of 64 chunks — so a probe must watch both
// streams, never stdout alone). Process-tree CPU time was unusable as a signal:
// `ps` TIME is 1-second granular and the call is network-bound, so it read an
// identical "2s → 4s total" across five consecutive 30 s samples. The liveness
// probe below (`armLivenessProbe`, `LIVENESS_START_AFTER_S` = 1800,
// `LIVENESS_WINDOW_S` = 600) is built on stdout+stderr byte progress, arms only
// after 30 minutes, and kills only a call silent for a full 10-minute window
// after that mark — 7.2x the measured worst-case healthy gap.
//
// --repo names the checkout to review; without it the cwd's repo is used (the
// historical behaviour). Every git call and every finder dispatch here already
// runs with `cwd: repoRoot`, so the flag is a one-line substitution — and it is
// what lets a session review a worktree it is not sitting in, WITHOUT a `cd`.
//
// --range defaults to `origin/master...HEAD` of the cwd repo. --end-ref marks
// the range as a HISTORICAL commit (the smoke-test replay of a frozen
// bake-off case): it injects the hist-note instructing finders to read via
// `git show <ref>:<path>` instead of the working tree, which may carry LATER
// fixes to the same files. --out defaults to `.scratch/gpt-review/<timestamp>`
// under the CURRENT cwd (gitignored) — never the main checkout's .scratch/ if
// cwd is a worktree.
//
// --paths / --exclude-paths (plan 3369, task 3): comma-separated glob(s), applied
// as git pathspec magic (`:(top,glob)…` / `:(top,glob,exclude)…`) ON TOP OF the
// review-diff-scope.mjs built-in data-tree excludes (review-diff-scope.mjs owns
// THAT list; this file never re-declares it — see the scopedPathspecs import
// above). When neither flag is given AND the already-scoped diff still exceeds
// FINDER_CONTEXT_BUDGET_CHARS (the measured codex per-call read ceiling —
// docs/handoff/infra-debt.md gpt-review-has-no-path-scope-so-a-data-heavy-land-
// cannot-be-reviewed: 2,943,677 chars measured against codex's 1,048,576-char
// limit on plan 2840), DEFAULT_DATA_EXCLUDE_GLOBS is applied automatically —
// named in a printed line and in stats.json's `scope` field either way, never a
// silent drop (see applyPathScope / buildPathScopeNote).
//
// Every codex call pins `-c model_reasoning_effort="high"` explicitly — codex
// silently defaults to MEDIUM when the flag is omitted (bake-off finding).
//
// Claude data-grounding arm (plan 2766): ONE `claude -p --model sonnet --effort
// high` call runs beside the 11 codex finders, covering BOTH data-grounding
// mandates (guard-fires + writer-trace) in a single dispatch — a real end-to-end
// replay of the shipped lane against a frozen bug case found the two codex
// data-grounding angles did not reproduce their isolated measurement
// (output/reports/2766-c3-shipped-lane-replay/verdict.md), and Sonnet-5 is
// measurably better on exactly this class (wiki/concepts/bake-offs.md
// codereview-finder-gpt56terra-2026-07-30). Its candidates join the SAME verify
// stage as codex candidates, tagged `finder:claude-data-grounding`. Unlike a
// codex finder failure (fatal — an angle at zero coverage must not read as
// clean), a Claude-arm transport failure SOFT-FAILS: the review continues on
// codex-only coverage (the pre-2766 status quo), naming the degradation in
// `stats.json`'s `claudeArm` field and in `summary.md` — this arm exists to
// relieve Claude-quota pressure the gpt-review lane was adopted to escape, so
// it must never make the whole review depend on that same quota. Disable with
// `--no-claude-arm` (default ON). Claude token usage is tracked in a SEPARATE
// bucket from the codex total — the two bill different subscriptions and are
// not the same currency.
//
// Checkpointing: every codex call result (success or error) is written to
// <out>/checkpoint.json immediately via a temp-file + atomic rename (plan 3369,
// task 4 — a kill mid-write can no longer tear it), keyed by a stable tag; a
// rerun with the same --out resumes (only errored/missing tags are retried). A
// checkpoint that IS torn (an all-NUL or truncated file from a kill BEFORE this
// plan, or one inherited from elsewhere) is quarantined to
// `checkpoint.torn-<n>.json`, logged, and treated as absent — the run starts
// that resume fresh rather than aborting (see quarantineTornCheckpoint /
// the Checkpoint constructor). Only completed calls are lost; angles with no
// completed raw/*.json still re-run from scratch, same as any other resume.
//
// ─── Exit codes (plan 3369, task 5 — every code this runner emits, documented
// in ONE place; docs/coord/review.md § The calibration ladder carries the same table for
// operator-facing recovery) ─────────────────────────────────────────────────
//   0  — the review ran to completion (findings or not — findings are the
//        point, not a failure — including the artifacts-only / path-scoped-to-
//        nothing PASS). stats.json is written; record-review.mjs may adopt it.
//   2  — the review is UNTRUSTED, from three families that want DIFFERENT
//        recoveries, all beating a false-clean review:
//          • transport — codex unusable (binary unresolved, or the FIRST call
//            spawn-fails outright). RETRYABLE: re-run with the same --out, or
//            fall back to /sonnet-review.
//          • finders exhausted after retry — one or more of the 11 finder
//            angles still failed after MAX_FINDER_RETRIES backoff rounds (task
//            2); the failed angle(s) are named, each has a persisted
//            <out>/finders/<angle>.stderr.txt (task 1). Deliberately the SAME
//            code as plain transport failure above, not a new one (execution
//            note (a)) — both mean "this run cannot be trusted," and both
//            RETRY the same way: re-run with the same --out (only the still-
//            failed calls, if any, re-run) or fall back to /sonnet-review.
//          • range resolution — the diff scoping call failed, the landed-range
//            containment test threw, or the range has no resolvable merge base
//            ("could not resolve the commit set …"). NOT retryable: the same
//            command fails identically, so fix the --range/--repo instead of
//            re-running.
//        Range-resolution failures clear the stale artifacts in --out;
//        transport/finder-retry failures deliberately do not, because their
//        recovery resumes from checkpoint.json (see clearStaleReviewArtifacts).
//   3  — EXIT_EMPTY_RANGE: the range resolved to ZERO changed files, i.e. you
//        pointed it at nothing — almost always the wrong checkout. No
//        stats.json is written, and a stale one from an earlier run in a
//        reused --out is DELETED, so this can never be recorded as a PASS.
//        SAME exit (plan 3369 fix round 1, ac45fd/bc6b9c/26e27a): this run's
//        OWN --paths/--exclude-paths (or the auto-budget layer) narrowing
//        every remaining file away — almost always a typo in the scope
//        flags, not a genuinely empty diff. Distinguished from the
//        wrong-checkout case by the printed message naming the scope, never
//        by exit code — both are "you pointed it at nothing", just at a
//        different layer. The genuinely-correct PASS case (every changed
//        file was ALREADY a built-in-excluded data artifact, before any
//        --paths/--exclude-paths of this run's own) stays exit 0.
//   4  — EXIT_LANDED_RANGE: the range resolves to include commits ALREADY in
//        origin/master (most often a rebase that rewrote the commit a --range
//        was built from), silently widening the range to cover another
//        session's already-landed work. Pass --end-ref to opt in when
//        reviewing landed history is genuinely what you want. No stats.json,
//        same reason as exit 3.
//   5  — EXIT_REVIEW_ROUND_CAP: this plan's local launch ledger is already at
//        the sanctioned cap. The launch is recorded, but no review subprocess
//        starts and no token is spent.
//   6  — EXIT_WAIT_STILL_RUNNING: --wait reached its bounded timeout while the
//        detached review is still alive. Re-invoke --wait with the same --out.
//   7  — EXIT_DETACHED_GONE: a detached run's process is gone without producing
//        findings.json. Inspect detached.log, then resume with the same --out.
//   1  — NEVER emitted by this script. If you observe it, the WRAPPER around
//        this process died externally (killed, OOM, a shell that itself
//        exited 1 before this ever ran) — it is not this runner's own verdict.
//
// RECOVERY RULE for any of the above, and doubly for an UNDOCUMENTED exit this
// header does not name: before re-running (which re-spends real codex/Claude
// quota), check the --out directory on disk FIRST — findings.json/summary.md
// complete and stats.json present means the review DID finish; adopt it rather
// than paying for a second run. Only re-run when those are genuinely absent or
// incomplete.
//
// Output (in --out):
//   findings.json    — [{key,file,line,summary,failure_scenario,angle,verdict,evidence}]
//                       verdict ∈ CONFIRMED | PLAUSIBLE | UNVERIFIED (REFUTED dropped)
//   refuted.json      — dropped candidates, logged (never silently discarded from the record)
//   stats.json        — { stats: { finders, candidates, verifierAgents, escalated, reported },
//                       finderStatus: [{angle, status}], scope?: {...} } — the
//                       record-review.mjs --review-stats shape (fills f=/v=/adj=); `scope` is
//                       present only when --paths/--exclude-paths or the auto data-tree
//                       exclusion narrowed the diff (task 3).
//   summary.md        — counts + token totals, human-readable
//   checkpoint.json    — every call's raw result, for resume (atomic writes; see above)
//   checkpoint.torn-N.json — a quarantined torn checkpoint from an earlier kill (task 4)
//   raw/*.json         — each codex call's --output-schema output file, for debugging
//   finders/<angle>.stderr.txt — a failed finder call's captured stderr (task 1)

import {
  existsSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { spawnWithTreeKill, killProcessTree, waitForExit } from './coord/kill-tree.mjs';
import { warnIfReviewRoundCapReached } from './record-review.mjs';
import { gitRepoIsolatedEnv, GIT_REPO_SELECTOR_VARS } from './coord/child-env.mjs';
// plan 2840: the ONE git stdout ceiling the landing spine already shares. Its own comment
// names this exact failure — "a large-data land (the multi-page render store, 11k+ changed
// files) makes `git diff --name-only` … exceed execFileSync's 1MB default → ENOBUFS". The
// fix existed since plan 844/850; this runner just never imported it.
import { GIT_MAXBUFFER, GIT_NONINTERACTIVE_ENV, sleepSync } from './coord/coord-git.mjs';
// plan 3093: the ONE exclude list, shared with the .claude/workflows/sonnet-review.js lane
// (which reaches it through the module's CLI, since the Workflow runtime cannot import).
// scopedPathspecs (plan 3369, task 3): the built-in exclude list AS git pathspecs, reused
// (not re-declared) so a --paths/--exclude-paths-scoped diff still drops the same data trees.
import {
  changedFilePartition,
  writeScopedPatch,
  excludedNote,
  scopedPathspecs,
  CORE_REVIEW_DIFF_EXCLUDES,
  reviewDiffExcludesFor,
} from './coord/review-diff-scope.mjs';
// plan 3369 fix round 1 (351a8f/562162/374712): the ONE crash-safe replace, shared with
// landing-lock.mjs/test-queue.mjs/git-metadata-heal.mjs — never a fourth hand-rolled copy of
// the same temp-file+fsync+rename shape.
import { atomicWriteTextSync } from './coord/atomic-write.mjs';
// plan 3380: the GIT_*-scrubbed, Windows-shape-normalizing common-dir resolver the codex
// trust key is derived from — never a local re-roll of the same git call.
import { resolveCommonDirPath } from './coord/lock-path.mjs';
// Account-hygiene reuse: strips CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY before spawning
// `claude -p`, so the Claude arm bills this session's own CLAUDE_CONFIG_DIR account rather than a
// foreign token some imported module's dotenv load dragged into process.env. Imported from
// scripts/coord/claude-env.mjs directly (plan 3959 T2 repointed this from
// fb-responder/classify.mjs, which only re-exports it now) — this import no longer drags the
// Facebook price-complaint classifier's closure into a code-review run.
import { cleanClaudeEnv } from './coord/claude-env.mjs';
// plan 2936 T1 — prior-round dispositions. `planSlugFromBranch` is the shared execution-branch
// parser; `loadCoordConfig`
// resolves docs/handoff/sessions/'s actual configured path rather than a hand-rolled literal;
// `readSidecarOrRefuse` is the ONE findings-sidecar read policy (plan 2936 lifted it out of
// record-review.mjs into its own module so this file can share it without importing
// record-review.mjs's write/repin machinery).
// The ONE lazy-memoized range-patch-id thunk (plan 2743) — never a hand-rolled second copy.
import { rangePatchIdOnce } from './coord/land-lib.mjs';
import { loadCoordConfig, DEFAULT_CODEX_AUTH_ENV_VAR } from './coord/coord-config.mjs';
import { readSidecarOrRefuse, parseSidecarOrRefuse } from './coord/findings-sidecar-io.mjs';
// The canonical ORIGIN-FIRST session-entry resolver + the sidecar path derivation, rather than a
// second hand-rolled walk of docs/handoff/sessions/ (review round 1: the hand-rolled one could
// not see a sidecar written through the routed coord-checkout, which is where they normally land).
import { findSessionFile, ORIGIN_FIRST_REFS } from './coord/record-marker-cli.mjs';
// plan 3959 T2: the review-marker cluster moved to scripts/coord/review-markers.mjs;
// samePathForPlatform stays in done-worktree-lib.mjs.
import {
  findingsSidecarPath,
  normalizeDisposition,
  markerIdentityMatch,
} from './coord/review-markers.mjs';
import { samePathForPlatform } from './coord/done-worktree-lib.mjs';
// THE ONE `git worktree list --porcelain` parser (plan 2058) — never a second copy here.
import { parseWorktreePorcelain } from './coord/worktree-porcelain.mjs';
import { pidAlive, resolveWorktreeLockPath, worktreeLockIsLive } from './coord/worktree-lock.mjs';
import { spawnDetachedWorktreeChild } from './coord/spawn-detached-worktree-child.mjs';
import { rotateIfOver } from './coord/coord-metrics.mjs';
import {
  capDenialMessage,
  fixBriefCandidates,
  fixBriefDenialMessage,
  fixBriefRequired,
  fixDeltaChangedLines,
  hasTrackedChanges,
  isPastCap,
  planSlugFromBranch,
  planIdFromSlug,
  recordLaunch,
  resolveReviewTargetBranch,
  validatePastCapReason,
} from './coord/review-round-cap.mjs';
// plan 3967 fix round 2 (findings 8/9/11): `reviewLaunchCapDecision` itself must read the plan's
// `lane: fast` stamp — the PreToolUse hook closes the Workflow/Bash-guard path, but a dispatched
// subagent (or any direct `node scripts/gpt-review.mjs` invocation) never passes through that
// hook, so this runner's own cap decision was still silently applying the default cap. Fails open
// to `null` on any lookup error by its own contract — never turn a read failure into a denial.
import { readLaneById } from './coord/read-plan-stamps.mjs';
// plan 4019: validate the codex-auth secret at consumption time and name a codex failure class instead
// of a bare 401 / bare non-zero exit — reused here, never re-rolled at either call site.
// `authPayloadReason` is the ONE shape+expiry helper `decodeAuthB64`, `fleetVsLocal`'s local
// check, and this file's own `validateExistingAuth` all call (fix round 2, H1) — importing it
// directly here retires this file's own hand-rolled copy of the same two checks.
// Plan 4096 T3: from the core lib, not from codex-auth-check.mjs. Same three functions — that
// file re-exports them — but reaching them through the COMMAND dragged in its `98 Hobby/`
// walk-up (hobby-env.mjs), mint-codex-auth-b64.mjs and sol-cloud-probe.mjs, and that closure is
// what blocked `gpt-review` (and scripts/hooks/review-round-cap-guard.mjs through it) at the
// coord-kit gate.
import { decodeAuthB64, codexFailureClass, authPayloadReason } from './coord/codex-auth-lib.mjs';

// The prep log cap, byte-identical to done-worktree.mjs's own PREP_LOG_MAX_BYTES: both write the
// SAME .scratch/land-prep-<slug>.log, so one ceiling has to govern all three dispatch seams
// (plan 3503, reversion-review advisory 2).
const PREP_LOG_MAX_BYTES = 4 * 1024 * 1024;
// THE ONE shared value-aware flag parser (plans 1769/1777) — likewise never a second copy.
import { parseFlags } from './coord/parse-flags.mjs';

// plan 3279: these six were plain module-private consts. The copy-review lane
// (a project-side sibling tool) runs the SAME transport, models and effort against a
// translation bundle instead of a diff, and the plan's standing instruction for it is
// "reuse, don't fork" — so they are exported rather than re-declared there, where a
// second copy of the Luna model id would drift the day either model id rolls. The
// export keyword is the whole change: no value, no consumer inside this file moves.
export const MODEL_LUNA = 'gpt-6-luna';
export const MODEL_SOL = 'gpt-6-sol';
export const EFFORT = 'high'; // shared by codex (-c model_reasoning_effort) and the claude -p arm (--effort)
export const PER_ANGLE = 6;
const DIFF_SUMMARY_CAP = 60000;
// Derived from homedir() rather than a hardcoded profile path — npm's global-install location
// on win32 is always <home>\AppData\Roaming\npm.
const WIN32_FALLBACK_CODEX = join(homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd');

// ─── plan 3369, task 3 — path scope ─────────────────────────────────────────
// The measured codex per-call read ceiling (docs/handoff/infra-debt.md
// gpt-review-has-no-path-scope-so-a-data-heavy-land-cannot-be-reviewed: a
// 2,943,677-char diff failed every finder against codex's own 1,048,576-char
// limit, plan 2840). Crossing this on the ALREADY built-in-excluded diff
// (review-diff-scope.mjs's REVIEW_DIFF_EXCLUDES) auto-applies
// DEFAULT_DATA_EXCLUDE_GLOBS below — see applyPathScope.
export const FINDER_CONTEXT_BUDGET_CHARS = 1_048_576;
// plan 3369 fix round 1 (1522de/46279f/4fd40f): the FIRST version of this list hand-copied
// (not derived from) review-diff-scope.mjs's own REVIEW_DIFF_EXCLUDES entries —
// `backend/src/data/seed` verbatim, plus a `**/render-store/**` / `**/render-fingerprints/**`
// pair aimed at the SAME `backend/data/data-pipeline/` trees `REVIEW_DIFF_EXCLUDES`'s
// `backend/data` member already covers. But applyPathScope's `basePathspecs` already applies
// `scopedPathspecs()` (== REVIEW_DIFF_EXCLUDES) UNCONDITIONALLY, before this budget-triggered
// layer ever runs — so on THIS repo's real layout, none of those three hand-copied entries
// could ever exclude a file the built-in layer had not already dropped for free (verified:
// `backend/data` already contains every render-store/render-fingerprints path that exists, and
// the seed entry is a REVIEW_DIFF_EXCLUDES member byte-for-byte). They were dead weight AND a
// drift risk on their own terms (4fd40f) — a later edit to REVIEW_DIFF_EXCLUDES would not touch
// this copy, silently reopening the gap the copy was meant to close.
//
// Fixed by DERIVING this list from the project's own review-diff excludes (plan 4071 T2:
// review-diff-scope.mjs's excludes are caller-injected, never a module-load constant here —
// `applyPathScope` resolves them once from the repo under review and passes them in) plus the
// ONE entry that genuinely adds coverage beyond them: a `.jsonl` file OUTSIDE
// `backend/data`/`output` — this repo's real ones live under `docs/superpowers/audits/**`,
// which the review-diff excludes do not touch. The `**/` prefix is still required: git glob
// pathspecs set FNM_PATHNAME, so a bare `*.jsonl` matches only a ROOT-level file, never one
// nested under a directory. Re-including the review-diff excludes here is a no-op TODAY (they
// are already unconditionally excluded before this layer runs) — but it is now a no-op that
// tracks them automatically instead of one that can silently go stale the way the hand-copied
// version already had.
export function defaultDataExcludeGlobsFor(excludes) {
  return [...excludes, '**/*.jsonl'];
}

// ─── plan 3369, task 1 — finder stderr persistence ──────────────────────────
// The pinned filename convention (task 1 requires picking ONE and using it
// everywhere): <out>/finders/<angle>.stderr.txt.
export const FINDER_STDERR_DIRNAME = 'finders';
export const STDERR_INLINE_LINES = 20;

// ─── plan 3369, task 2 — bounded backoff retry ──────────────────────────────
// "up to 3 attempts, exponential backoff (5s/15s/45s)" (the plan's task 2) is
// read here as 3 RETRY ROUNDS beyond the initial attempt (4 tries total, one
// backoff per retry) — the plan does not disambiguate "3 attempts" from "3
// retries", and 3 distinct backoff values only make sense paired with 3
// distinct retry rounds. GPT_REVIEW_TEST_RETRY_BACKOFF_MS is a TEST-ONLY
// override (comma-separated ms) so gpt-review.test.mjs can exercise a full
// exhaustion in milliseconds rather than the real 65s — nothing in a real
// invocation ever sets it.
export const RETRY_BACKOFF_MS = (() => {
  const override = process.env.GPT_REVIEW_TEST_RETRY_BACKOFF_MS;
  if (override) {
    const parsed = override.split(',').map((s) => Number(s.trim()));
    if (parsed.length > 0 && parsed.every((n) => Number.isFinite(n) && n >= 0)) return parsed;
  }
  return [5000, 15000, 45000];
})();
export const MAX_FINDER_RETRIES = RETRY_BACKOFF_MS.length;

// ─── Claude data-grounding arm (plan 2766) — constants ──────────────────────
export const CLAUDE_MODEL = 'sonnet'; // bare alias, deliberately never a dated id (alias-roll policy)
export const CLAUDE_ARM_LABEL = 'claude-data-grounding';
export const CLAUDE_ARM_TAG = `finder:${CLAUDE_ARM_LABEL}`;
// One call covers BOTH data-grounding mandates, so its cap is 2x a single
// codex angle's PER_ANGLE — it is doing the work of two angles in one dispatch.
export const CLAUDE_ARM_CAP = PER_ANGLE * 2;
// Runaway-cost cap for the arm's agentic loop (read/grep/git-show tool calls
// inside one `claude -p` turn). CORRECTION: an earlier version of this file
// claimed `--max-turns` doesn't exist on the installed CLI, based only on its
// ABSENCE from `claude -p --help`'s printed text — that was wrong. Empirically
// probed (zero-cost: an unrecognized flag errors instantly before any API
// call, `claude -p --max-turns notanumber --bogus-flag` reports "argument
// 'notanumber' is invalid. must be a number" for --max-turns specifically,
// proving the CLI validates it as a real option; only --bogus-flag was
// "unknown option"): `--max-turns <N>` IS real, just undocumented/hidden from
// --help. It is also this repo's ESTABLISHED cap mechanism —
// backend/scripts/data-pipeline/lib_claude_transport.py's run_claude_p()
// already takes it as a required parameter, with existing callers ranging
// from "6" (lib_pre_review.py's skeptic role) to "30" (its hunter/WebFetch
// role). Using it here (instead of the --max-budget-usd this file used
// before) is the same "don't invent a bespoke mechanism" call as
// disableAllHooks below. Value: 40, grounded in measurement rather than in
// repo precedent. Every real attempt on the frozen c3 diff (5 files) has
// needed at or above 25 turns: 24 to a complete (if unformatted) answer with
// repo cwd and no friction, capped at 25 twice more once the scratch-cwd +
// `git -C` indirection added real steps. The only datum for a FINISHED answer
// is 34 turns, so a cap below that is tuned under the observed cost of the
// work and only manufactures `error_max_turns` — which is exactly what
// happened twice, and it confounded the measurement each time (a capped run
// returns no answer, so it cannot tell you whether the answer would have been
// well-formed). 40 sits above the observed 34 with headroom for a larger
// diff, and still bounds a true runaway tool-call loop well short of
// "unbounded". An earlier 25 was picked from `lib_pre_review.py`'s 6-30 role
// range before any completion had been measured; prefer the measurement.
export const CLAUDE_ARM_MAX_TURNS = 40;

// ─── Angle texts — byte-ported, do not re-derive ──────────────────────────
// (sonnet-review.js CORRECTNESS_ANGLES[0..2] + angle-P, verbatim)
// Exported so gpt-review.test.mjs can assert byte-parity against
// .claude/workflows/sonnet-review.js — the workflow sandbox has no module
// imports, so a shared module is impossible; the drift test is the guard.
export const CORRECTNESS_ANGLES = [
  {
    label: 'angle-A',
    text: '### Angle A — line-by-line diff scan\n\nRead every hunk in the diff, line by line. Then Read the enclosing function for\neach hunk — bugs in unchanged lines of a touched function are in scope (the PR\nre-exposes or fails to fix them). For every line ask: what input, state, timing,\nor platform makes this line wrong? Look for inverted/wrong conditions,\noff-by-one, null/undefined deref, missing `await`, falsy-zero checks,\nwrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.\n',
  },
  {
    label: 'angle-B',
    text: "### Angle B — removed-behavior auditor\n\nFor every line the diff DELETES or replaces, name the invariant or behavior it\nenforced, then search the new code for where that invariant is re-established.\nIf you can't find it, that's a candidate: a removed guard, a dropped error\npath, a narrowed validation, a deleted test that was covering a real case.\n",
  },
  {
    label: 'angle-C',
    text: '### Angle C — cross-file tracer\n\nFor each function the diff changes, find its callers (Grep for the symbol) and\ncheck whether the change breaks any call site: a new precondition, a changed\nreturn shape, a new exception, a timing/ordering dependency. Also check callees:\ndoes a parallel change in the same PR make a call unsafe?\n',
  },
  {
    label: 'angle-P',
    text: "### Angle P — pre-existing-line auditor\n\nTreat every hunk in the diff as CORRECT — do not re-review added or changed\nlines (other angles own them). Instead, for each function or method the diff\ntouches, read the ENTIRE post-change function and audit ONLY the lines the\ndiff did NOT touch. Shipping this PR re-exposes those lines: a latent bug\namong them ships with the change.\n\nFor each untouched line ask the line-by-line questions (inverted/wrong\ncondition, off-by-one, null/undefined deref, missing await, swallowed error,\nwrong variable). Give special weight to operations whose correctness depends\non WHICH BASE or TARGET they act against — a diff applied or checked against\nthe working tree vs HEAD vs the index, a path resolved against cwd vs repo\nroot, a comparison against a cached/stale snapshot vs the live value. For\neach such operation, name the base the code actually uses and the base the\nfunction's stated purpose implies; a mismatch is a candidate.\n\nTwo rules while auditing:\n1. Comments are CLAIMS, not evidence. A header or inline comment describing\n   what a call does (or why it is safe) proves nothing — verify the claim\n   against the call's actual semantics and the surrounding code. A line whose\n   comment says the safe thing while the code does the unsafe thing is the\n   highest-value candidate there is.\n2. For EVERY external command, library call, or API call, name the implicit\n   DEFAULT it operates on — which base, ref, directory, file set, encoding,\n   or point in time — and check that default against what the enclosing\n   function's contract requires. A call whose default target is mutable or\n   volatile state (the working tree, cwd, wall-clock now, a cache) where the\n   contract implies a committed or stable base (HEAD, the repo root, a\n   snapshot) is a candidate even when every comment says it is fine.\n\nReport candidates ONLY at lines the diff did not add or modify; if a\ncandidate sits on a hunk line, drop it.\n",
  },
];
export const CLEANUP_ANGLES = [
  {
    label: 'reuse',
    text: '### Reuse\n\nFlag new code that re-implements something the codebase\nalready has — Grep shared/utility modules and files adjacent to the change,\nand name the existing helper to call instead.\n',
  },
  {
    label: 'simplification',
    text: '### Simplification\n\nFlag unnecessary complexity the diff adds: redundant or derivable state,\ncopy-paste with slight variation, deep nesting, dead code left behind. Name\nthe simpler form that does the same job.\n',
  },
  {
    label: 'efficiency',
    text: "### Efficiency\n\nFlag wasted work the diff introduces: redundant computation or repeated I/O,\nindependent operations run sequentially, blocking work added to startup or\nhot paths. Also flag long-lived objects built from closures or captured\nenvironments — they keep the entire enclosing scope alive for the object's\nlifetime (a memory leak when that scope holds large values); prefer a\nclass/struct that copies only the fields it needs. Name the cheaper\nalternative.\n",
  },
  {
    label: 'altitude',
    text: "### Altitude\n\nCheck that each change is implemented at the right depth, not as a fragile\nbandaid. Special cases layered on shared infrastructure are a sign the fix\nisn't deep enough — prefer generalizing the underlying mechanism over adding\nspecial cases.\n",
  },
  {
    label: 'conventions',
    text: '### Conventions (CLAUDE.md)\n\nFind the CLAUDE.md files that govern the changed code: the user-level\n~/.claude/CLAUDE.md, the repo-root CLAUDE.md, plus any CLAUDE.md or\nCLAUDE.local.md in a directory that is an ancestor of a changed file (a\ndirectory\'s CLAUDE.md only applies to files at or below it). Read each one\nthat exists, then check the diff for clear violations of the rules they state.\n\nOnly flag a violation when you can quote the exact rule and the exact line\nthat breaks it — no style preferences, no vague "spirit of the doc"\ninferences. In the finding, name the CLAUDE.md path and quote the rule so the\nreport can cite it. If no CLAUDE.md applies, return nothing for this angle.\n\nKnown non-finding (do not re-raise; wontfixed 3x in 2026-07/08 reviews): the\nuser-level CLAUDE.md rule "Full URLs / paths — always" governs operator-facing\nOUTPUT (chat, commits, messages addressed to the operator), NOT tracked repo\nfiles. Repo-relative paths inside tracked docs and code are this repo\'s\nconvention — never flag a tracked file for using them.\n',
  },
];
// (run_gpt_dgv_arm.py VARIANTS[1..2] — guard-fires + writer-trace, verbatim)
export const DATA_GROUNDING_ANGLES = [
  {
    label: 'guard-fires',
    text: "### Guard effectiveness — prove each guard can fire\n\nFor every guard, exemption, filter, or special-case branch the diff adds or\nchanges, PROVE it can actually fire on production data: find one REAL,\ncommitted data row (seed shard, fixture generated from production, pipeline\nartifact) or one writer code path whose output satisfies the guard's\npredicate. Name the file and row/line as evidence.\n\nIf you cannot find any real satisfier, that IS a finding: a guard that only\nfires on hand-constructed inputs protects nothing — it silently no-ops on the\nexact data class it was written for, and its tests (which build the input by\nhand) stay green while production behavior is unchanged. Report the guard,\nits predicate, where you searched, and why no real input satisfies it.\n",
  },
  {
    label: 'writer-trace',
    text: "### Writer trace — values read vs values written\n\nFor each field the diff's new or changed conditions READ, trace every WRITER\nof that field in the codebase: the serializers, extractors, ingest scripts,\nand defaults that populate it in committed data. Build the set of values each\nwriter actually emits (including 'field omitted entirely' as a value). Then\ncompare: does the condition key on a value inside that emitted set?\n\nFlag every condition that expects a value OUTSIDE the emitted set — e.g. a\ndefault that exists only in reader code and is never serialized, so committed\nrows carry an empty/absent field and the condition never matches. State the\nexpected value, the emitted set, and the writers you traced as evidence.\n",
  },
];
export const CLEANUP_PRECEDENCE =
  'Cleanup, altitude, and conventions candidates use the same\n`file`/`line`/`summary` shape; in `failure_scenario`, state the concrete\ncost (what is duplicated, wasted, harder to maintain, or which CLAUDE.md rule\nis broken) instead of a crash. Correctness bugs always outrank cleanup,\naltitude, and conventions findings when the output cap forces a cut.\n';
export const VERDICT_LADDER =
  "- **CONFIRMED** — can name the inputs/state that trigger it and the wrong\n  output or crash. Quote the line.\n- **PLAUSIBLE** — mechanism is real, trigger is uncertain (timing, env,\n  config). State what would confirm it.\n- **REFUTED** — factually wrong (code doesn't say that) or guarded elsewhere.\n  Quote the line that proves it.";
export const VERDICT_LADDER_RECALL =
  '**PLAUSIBLE by default** — do not refute a candidate for being "speculative" or\n"depends on runtime state" when the state is realistic: concurrency races,\nnil/undefined on a rare-but-reachable path (error handler, cold cache, missing\noptional field), falsy-zero treated as missing, off-by-one on a boundary the\ncode does not exclude, retry storms / partial failures, regex/allowlist that\nlost an anchor. These are PLAUSIBLE.\n\n**REFUTED** only when constructible from the code: factually wrong (quote the\nactual line); provably impossible (type/constant/invariant — show it); already\nhandled in this diff (cite the guard); or pure style with no observable effect.';

// The 11-angle finder roster (plan 2663): the sonnet-review 8 (3 correctness +
// 5 cleanup) + angle-P (correctness) + the 2 data-grounding angles (correctness).
export const FINDERS = [
  ...CORRECTNESS_ANGLES.map((a) => ({ ...a, kind: 'correctness' })),
  ...CLEANUP_ANGLES.map((a) => ({ ...a, kind: 'cleanup' })),
  ...DATA_GROUNDING_ANGLES.map((a) => ({ ...a, kind: 'correctness' })),
];

// Plan 3500: a pool of 4 made the finder roster take three waves and roughly two
// thirds of the run wall clock. Deriving this keeps a future angle in one wave too.
export const DEFAULT_CONCURRENCY = FINDERS.length;

// ─── Schemas (written to disk per run for --output-schema) ──────────────────
export const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: { summary: { type: 'string' } },
};
export const CANDIDATES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'summary', 'failure_scenario'],
        properties: {
          file: { type: 'string' },
          line: { type: ['number', 'null'] },
          summary: { type: 'string' },
          failure_scenario: { type: 'string' },
        },
      },
    },
  },
};
// VENDORED byte-identically into the import-free sonnet-review Workflow. The full-string drift
// assertion below catches changes to every keyword and nested value without parsing source text.
// plan 3623 finding cf8d04: `index` is `integer`, not `number` — Number.isInteger(v.index) is
// what verifyOnce actually enforces (below), so a schema that admitted a fractional index was
// schema-valid but verifier-rejected, silently escalating and risking an UNVERIFIED land block
// over a contract mismatch rather than a real defect. Kept in sync with the vendored copy in
// .claude/workflows/sonnet-review.js by the drift assertion in gpt-review.test.mjs.
export const GROUP_VERDICT_SCHEMA_JSON =
  '{"type":"object","additionalProperties":false,"required":["verdicts"],"properties":{"verdicts":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["index","verdict","evidence","preExisting","preExistingWhy","blocksLand","blocksLandWhy"],"properties":{"index":{"type":"integer"},"verdict":{"enum":["CONFIRMED","PLAUSIBLE","REFUTED"]},"evidence":{"type":"string"},"preExisting":{"type":"boolean"},"preExistingWhy":{"type":"string","pattern":"^[^\\\\r\\\\n]+$"},"blocksLand":{"type":"boolean"},"blocksLandWhy":{"type":"string","pattern":"^[^\\\\r\\\\n]+$"}}}}}}';
export const GROUP_VERDICT_SCHEMA = JSON.parse(GROUP_VERDICT_SCHEMA_JSON);

// ─── Historical-range note (run_gpt_arm.py hist_note(), byte-ported) ────────
export function histNote(endRef) {
  return (
    "IMPORTANT: this is a HISTORICAL commit range — the code under review is the '+' side at commit " +
    endRef +
    '. ' +
    'The working-tree copy of the touched files contains LATER changes (subsequent fixes) and must NOT be used. ' +
    'Read file contents ONLY via `git show ' +
    endRef +
    ':<path>`; when tracing callers/consumers in other files, ' +
    'prefer `git grep <symbol> ' +
    endRef +
    " -- '<pathspec>'` / `git show " +
    endRef +
    ':<other path>` over the current tree. ' +
    'If a `git show` unexpectedly returns empty on this Windows/MSYS platform, retry with the env var MSYS_NO_PATHCONV=1. ' +
    'Judge everything against the ' +
    endRef +
    ' state, not the working tree.'
  );
}

// plan 2936 T3 — the disposition policy's severity floor, stated in the FINDER prompts so
// sub-floor noise dies at the source instead of costing a disposition at land time. This copy is
// VENDORED: `.claude/workflows/sonnet-review.js` carries a byte-identical copy in its own
// SCOPE_BLOCK (the Workflow sandbox has no module imports, so a shared module is impossible
// there) and `scripts/gpt-review.test.mjs` reads THAT file and asserts the exact string is
// present, so the two lanes cannot drift. Edit both or neither — the drift check fails the push
// otherwise.
export const SEVERITY_FLOOR_NOTE =
  '### Severity floor (docs/coord/review.md § Disposition policy) — Do not report perf micro-optimizations or one-line infra/tooling-debt observations that neither affect correctness nor block lands nor corrupt data; policy declines them by rule, so they only cost a disposition. A genuine defect of any size is still in scope.';

// VENDORED byte-identically into the import-free sonnet-review Workflow. Edit both or neither.
export const FINDING_TAG_NOTE =
  "### Required finding tags\n- `preExisting` — TRUE when the defect would still be present with this plan's diff removed. Answer it by checking whether the flagged line or behaviour is INSIDE the reviewed range's `+` side. Return `preExistingWhy` as one line.\n- `blocksLand` — TRUE only when the finding is a correctness defect on the plan's OWN target surface whose residual cost is data corruption, a wrong user-facing value, a blocked land or push, or a broken contract another module relies on. FALSE for: a wrong or missing warning/log line; a perf or tidiness change; a theoretical input no caller produces; an edge case on a warn-only, report-builder or docs-generator surface (the blast-radius floor); and anything whose fix would change the land's risk class. Return `blocksLandWhy` as one line.\n- A re-raise of a finding already dispositioned `wontfix`, with no new evidence, is `blocksLand: false`.";

// ─── plan 2936 T1 — prior-round dispositions ────────────────────────────────
// The 2026-08-06 review-round-accuracy study's #1 finding: 82% of later-round findings in
// multi-round reviews were carried re-reports of issues already found — dominated by findings
// already dispositioned `wontfix`, with the reason on record in the findings sidecar the finder
// lanes never saw. This section locates that sidecar for the CURRENT plan, extracts the
// wontfix/plan-dispositioned subset, and renders it as a scope-block section every finder (and
// the Claude data-grounding arm) reads via buildScopeBlock — ONE injection, no per-finder
// suffix, matching the sibling .claude/workflows/sonnet-review.js lane's own scope-block
// section (its SCOPE_SCHEMA.priorDispositions / SCOPE_BLOCK "Already dispositioned" block).

const DISPOSITION_REASON_TRUNCATE = 200;
const DISPOSITION_CAP = 120;

// Read the findings sidecar for `slug`, ORIGIN-FIRST, and hand back the {rec}/{refuse} shape
// resolveDispositionsBlock consumes (or null when there is genuinely nothing to read).
//
// The origin-first part is the whole point, and round 1 of this plan's own review is what
// proved it: an earlier draft searched only the WORKING TREE, and the sidecar this very session
// had just recorded was invisible to it (worktree 1181 sidecars vs origin/master 1188;
// the lookup returned null for this plan's own slug). record-review.mjs's default write path
// lands the sidecar on origin/master through a disposable coord-checkout (plan 1286/2042) that
// never touches the calling worktree's checked-out files — so on a worktree branch, the sidecar
// for the CURRENT plan is routinely on origin and NOT on disk. A working-tree-only reader
// therefore returns "no prior dispositions" in exactly the re-review case T1 exists to fix,
// i.e. it is a silent no-op precisely when it matters.
//
// Both halves reuse the machinery that already solved this: `findSessionFile` with
// ORIGIN_FIRST_REFS resolves the session `.md` entry (it walks origin/master then HEAD, and
// carries the ambiguity + owner-conflict refusals), `findingsSidecarPath` derives the sidecar
// sibling, and the content read mirrors `readSessionCandidates`' origin-then-worktree order for
// the same stated reason — a `--no-push` / offline record writes ONLY the working tree, so
// origin alone is not sufficient either. Nothing here re-rolls a session resolver.
export function readSidecarForSlug(
  repoRoot,
  slug,
  paths,
  { headSha = null, headPatchId = null } = {},
) {
  const sf = findSessionFile(repoRoot, slug, paths, 'gpt-review', { refs: ORIGIN_FIRST_REFS });
  if (!sf) return null;
  const sidecarRel = findingsSidecarPath(sf);
  // BOTH candidates, then pick the freshest. Neither one may pre-empt the other: round 3 of this
  // plan's review flagged (8 angles) that round 2's early `return {refuse}` on any origin-side
  // problem discarded a perfectly good working-tree sidecar — and a checkout with no
  // `origin/master` ref at all is a SUPPORTED shape, since findSessionFile itself falls back to
  // HEAD. So an origin problem becomes a refusal CANDIDATE, and pickFreshestSidecar prefers any
  // parseable record over it — while still LOGGING it either way (as the result when nothing else
  // parsed, as `suppressedRefusal` when something did, round-4 cleanup). That keeps the
  // plan's hard rule #1 (an IO failure is never silently "absent") without letting it veto a
  // readable local record.
  const candidates = [];
  const origin = readSidecarFromRef(repoRoot, 'origin/master', sidecarRel);
  if (origin) candidates.push(origin);
  // readSidecarOrRefuse keeps the errno split: ENOENT is the ONLY "genuinely absent" outcome,
  // every other errno REFUSES rather than silently reading as "no prior dispositions".
  const local = readSidecarOrRefuse(repoRoot, sidecarRel);
  if (!local.absent) candidates.push(local);

  return pickFreshestSidecar(candidates, headSha, headPatchId);
}

// One ref's sidecar candidate: `{rec}` / `{refuse}` / null when this ref simply has nothing to
// offer. The two "nothing to offer" cases are deliberately NOT refusals — an absent ref (a
// checkout that never fetched origin/master) and a ref that does not carry the file are both
// ordinary, and the working-tree read is the sanctioned fallback for each. Everything else IS a
// refusal: `ls-tree`/`show` failing on a ref that exists and lists the path means git itself
// failed, and reading that as "no prior dispositions" would silently re-report the whole
// already-dispositioned set.
function readSidecarFromRef(repoRoot, ref, sidecarRel) {
  // plan 3503, review round 3: `-C repoRoot` names the repo, but an inherited GIT_DIR/GIT_WORK_TREE
  // still overrides it and would silently point these reads at the launcher's checkout instead of
  // the reviewed one. gitRepoIsolatedEnv(), not gitIsolatedEnv(): these reads (rev-parse/ls-tree/
  // show) never touch the network, but the narrower helper is still correct here — there is simply
  // no transport/credential variable for it to need to preserve.
  const g = (args) =>
    execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      maxBuffer: GIT_MAXBUFFER,
      env: gitRepoIsolatedEnv(),
    });
  try {
    // --verify --quiet: exit 1 (no stderr noise) when the ref is simply not present here.
    g(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    return null; // ref absent — a supported checkout shape, not an error
  }
  let listed;
  try {
    listed = g(['ls-tree', '-r', '--name-only', ref, '--', sidecarRel]);
  } catch (e) {
    return {
      refuse:
        `REFUSED — could not determine whether ${sidecarRel} exists on ${ref} ` +
        `(${e?.message || e}). Falling back to the working tree; if that is absent too, nothing ` +
        `was injected and every already-dispositioned finding may be re-reported.`,
    };
  }
  if (listed.trim().length === 0) return null; // not on this ref
  try {
    return parseSidecarOrRefuse(g(['show', `${ref}:${sidecarRel}`]), sidecarRel);
  } catch (e) {
    return {
      refuse:
        `REFUSED — ${sidecarRel} EXISTS on ${ref} but could not be read (${e?.message || e}). ` +
        `Falling back to the working tree.`,
    };
  }
}

// Pure: pick among ordered {rec}/{refuse} candidates. The rule is pickFreshestMarker's, spelled
// for sidecars — a record that still describes HEAD is CURRENT, and current beats stale wherever
// it sits; with nothing current, the first parseable one wins (the prior behaviour, so a
// genuinely stale branch reads exactly as it used to).
//
// Identity comes from `markerIdentityMatch` (the shared "does this record still describe
// currentSha?" predicate that done-worktree-lib's own findingsRecordIsCurrent wraps), NOT a raw
// `sha ===`. Round 3 caught the raw comparison from six angles, and the sharpest version is
// worth recording: `rec.sha` is stamped ONCE at record time and disposition edits never bump it,
// so on any real re-review — where HEAD has advanced past the recorded round — a raw equality
// test can essentially never fire, silently degrading this whole function back to
// first-candidate-wins. markerIdentityMatch also accepts the patch-id identity, which is what
// keeps a sidecar current across a pure rebase.
//
// plan 2936 round-4 cleanup: when a parseable record wins over a refusal, the refusal is no
// longer thrown away silently — it rides out on `suppressedRefusal` so the caller can LOG it.
// A refused origin read beside a readable working-tree sidecar is not nothing: the record that
// was actually injected may be the STALER of the two, and the run should say so rather than look
// like a clean read. It stays advisory (the winner is unchanged) — the plan's hard rule is only
// that an IO failure is never read as "absent".
export function pickFreshestSidecar(candidates, headSha, headPatchId = null) {
  let firstParseable = null;
  let firstRefusal = null;
  let current = null;
  for (const c of candidates) {
    if (!c) continue;
    if (c.refuse) {
      if (!firstRefusal) firstRefusal = c;
      continue;
    }
    if (
      !current &&
      headSha &&
      markerIdentityMatch(c.rec?.sha, c.rec?.patchId, headSha, headPatchId)
    )
      current = c;
    if (!firstParseable) firstParseable = c;
  }
  const winner = current || firstParseable || firstRefusal || null;
  // Only annotate when a refusal actually lost — never wrap the refusal in itself.
  if (winner && firstRefusal && winner !== firstRefusal) {
    return { ...winner, suppressedRefusal: firstRefusal.refuse };
  }
  return winner;
}

// Pure: which findings from an already-parsed sidecar record are worth telling the finder
// lanes about. Three types are admitted: `wontfix` (declined with a reason), `plan` (deferred to
// a follow-up plan), and `deferred-by-tag` (plan 3623 item 3 — auto-dispositioned by
// `isMustFixFinding`'s tag axis; without this, every advisory finding auto-cleared in round N was
// invisible to round N+1's finders and got re-found and re-verified from scratch — 33 findings on
// plan 3545's own round 3). `fixed` is deliberately left OUT of this function's output (never
// injected as "already handled"): a `fixed` finding reappearing is a REGRESSION signal (the
// study's "valuable 12%"), not noise to suppress. Cap at 120, "newest rounds kept first":
// `buildFindingsRecord` REBUILDS `findings` from that round's own returned candidates on every
// record (not an append-only log), so array order already IS that round's ordering; capping
// keeps the entries closest to the END of that set.
export function extractDispositionedFindings(rec, { cap = DISPOSITION_CAP } = {}) {
  const all = Array.isArray(rec?.findings) ? rec.findings : [];
  // Route through the CANONICAL validator (done-worktree-lib's normalizeDisposition — the same
  // one the land gate's classifyFinding uses) rather than trusting `disposition.type` on sight.
  // A malformed disposition — `wontfix` with no reason, `plan` with no planId — normalizes to
  // null and is skipped, instead of being injected as an authoritative "already declined" line
  // with an empty reason. Telling a finder an issue was declined, but not why, is strictly worse
  // than not mentioning it: it suppresses a re-report and supplies nothing to re-judge against.
  const filtered = all
    .map((f) => ({ f, d: normalizeDisposition(f?.disposition) }))
    .filter(
      ({ d }) => d && (d.type === 'wontfix' || d.type === 'plan' || d.type === 'deferred-by-tag'),
    );
  const dropped = Math.max(0, filtered.length - cap);
  const kept = dropped > 0 ? filtered.slice(filtered.length - cap) : filtered;
  const entries = kept.map(({ f, d }) => {
    // The scope-schema convention this mirrors (sonnet-review.js SCOPE_SCHEMA.priorDispositions)
    // uses ONE `reason` field across all three dispositions. Explicit per type, not a ternary:
    // `wontfix` and `deferred-by-tag` both carry their own `reason` string already (the latter's
    // built by done-worktree-lib's deferredByTagDisposition, e.g. "preExisting=true: ...;
    // blocksLand=false: ..."); only `plan` has no `reason` field and reads its target plan id
    // instead.
    let raw;
    if (d.type === 'plan') raw = d.planId;
    else raw = d.reason;
    const reason = String(raw || '');
    return {
      file: f.file,
      line: f.line ?? null,
      summary: f.summary,
      type: d.type,
      reason:
        reason.length > DISPOSITION_REASON_TRUNCATE
          ? reason.slice(0, DISPOSITION_REASON_TRUNCATE)
          : reason,
    };
  });
  return { entries, dropped };
}

// Pure: render the extracted entries as the scope-block section. Wording pinned to match
// .claude/workflows/sonnet-review.js's own "Already dispositioned" block (not T3's byte-identical
// requirement, but the same instruction — a reviewer reading both lanes' output should not see
// the two disagree on what this section is asking for).
export function buildDispositionsBlock(entries) {
  if (!entries || entries.length === 0) return '';
  return (
    '\n## Already dispositioned in earlier review rounds\n' +
    'Do not re-report these unless the diff since the recorded review sha changed the relevant facts; a changed-facts re-report must state what changed.\n' +
    entries
      .map(
        (d) =>
          '  - ' +
          d.file +
          (typeof d.line === 'number' ? ':' + d.line : '') +
          ' — ' +
          d.summary +
          ' [' +
          d.type +
          (d.reason ? ': ' + d.reason : '') +
          ']',
      )
      .join('\n') +
    '\n'
  );
}

// Pure orchestration over an ALREADY-RESOLVED sidecar read (the {absent}/{rec}/{refuse} shape
// readSidecarOrRefuse returns) — kept separate from the git-dependent locate step above so the
// two hard rules from measured incidents are unit-testable without a real sidecar file:
//   1. A PARSE/IO failure on an EXISTING sidecar (`refuse`) is WARNED, never treated as absent —
//      `{absent: true}` is the ONLY "no sidecar" outcome (readSidecarOrRefuse already encodes
//      this split; this just never collapses it back down).
//   2. The sidecar's OWN `slug` stamp must equal the CURRENT slug or injection is SKIPPED with a
//      warning (the plan-2838 sibling-sidecar incident) — deliberately stricter than
//      done-worktree-lib's `sidecarOwnedBy` (which treats an absent/legacy owner as "not a
//      conflict", the right call for THAT function's write-guard use). This is a pure read into
//      another agent's prompt: an unstamped/legacy sidecar gets no benefit of the doubt here.
// Never throws — every failure mode degrades to injecting nothing.
export function resolveDispositionsBlock(read, slug, { cap = DISPOSITION_CAP, logFn = log } = {}) {
  if (!read || read.absent) return '';
  // A refusal that LOST to a parseable record is still surfaced (plan 2936 round-4 cleanup) —
  // the injected record may be the staler of the two, so a silent success would misreport the run.
  if (read.suppressedRefusal) {
    logFn(`prior-dispositions: a candidate was unreadable — ${read.suppressedRefusal}`);
  }
  if (read.refuse) {
    logFn(`prior-dispositions: ${read.refuse}`);
    return '';
  }
  const rec = read.rec;
  if (String(rec?.slug || '') !== slug) {
    logFn(
      `prior-dispositions: sidecar slug "${rec?.slug || '(none)'}" != current slug "${slug}" — ` +
        `skipping injection (plan-2838 sibling-sidecar guard).`,
    );
    return '';
  }
  const { entries, dropped } = extractDispositionedFindings(rec, { cap });
  if (dropped > 0) {
    logFn(`prior-dispositions: capped at ${cap} — dropped ${dropped} older entrie(s).`);
  }
  if (entries.length > 0) {
    logFn(
      `prior-dispositions: carrying ${entries.length} prior disposition(s) into the finder prompts`,
    );
  }
  return buildDispositionsBlock(entries);
}

export function dispositionsBlockForSlug(
  repoRoot,
  slug,
  {
    headSha = null,
    mergeBase = null,
    warn = console.error,
    loadCoordConfigFn = loadCoordConfig,
    readSidecarFn = readSidecarForSlug,
  } = {},
) {
  let paths;
  try {
    paths = loadCoordConfigFn(repoRoot).paths;
  } catch (error) {
    warn(
      `prior-dispositions warning: could not read coord.config.json for ${slug} ` +
        `(${error?.message || error}); skipping prior dispositions and continuing the review.`,
    );
    return '';
  }
  const read = readSidecarFn(repoRoot, slug, paths, {
    headSha,
    headPatchId: headSha && mergeBase ? rangePatchIdOnce(repoRoot, headSha, mergeBase) : null,
  });
  return read ? resolveDispositionsBlock(read, slug) : '';
}

// ─── Scope block assembly (sonnet-review.js SCOPE_BLOCK shape, byte-similar) ─
export function buildScopeBlock({
  diffPatchPath,
  headSha,
  files,
  claudeMdFiles,
  summary,
  conventions,
  target,
  dispositionsBlock = '',
  excludedNote: excluded = '',
  pathScopeNote = '',
}) {
  return (
    '## Review scope\n' +
    'Diff file (read this — do not run `git diff` yourself): ' +
    diffPatchPath +
    '\n' +
    'Lines beginning `+` are the code under review (branch tip ' +
    headSha +
    '); lines beginning `-` are the pre-change base.\n' +
    // plan 3093: no silent truncation — when the data-artifact exclusion dropped files,
    // the count and the excluded paths are stated here, right beside the file list, so a
    // finder can tell "data moved but is out of scope" from "data did not change".
    (excluded ? excluded + '\n' : '') +
    // plan 3369, task 3: the SECOND, --paths/--exclude-paths/auto-budget layer — kept as
    // its own sentence rather than folded into `excluded` above, because that string's
    // wording is review-diff-scope.mjs's own (a fixed built-in-list sentence this file
    // must not misattribute to a user-chosen or budget-triggered exclusion).
    (pathScopeNote ? pathScopeNote + '\n' : '') +
    'Changed files (' +
    files.length +
    '):\n' +
    files.map((f) => '  - ' + f).join('\n') +
    '\n' +
    'Applicable CLAUDE.md files (' +
    claudeMdFiles.length +
    '):\n' +
    (claudeMdFiles.length > 0 ? claudeMdFiles.map((f) => '  - ' + f).join('\n') : '  (none)') +
    '\n\n' +
    '## What changed\n' +
    summary +
    '\n\n' +
    '## Conventions\n' +
    (conventions || '(none noted)') +
    '\n' +
    (target
      ? '\n## User instructions (verbatim)\n' +
        target +
        "\nHonor any scope restrictions or focus areas stated above — they take precedence over your angle's default breadth. Do not surface findings the instructions ask to skip.\n"
      : '') +
    dispositionsBlock +
    '\n' +
    SEVERITY_FLOOR_NOTE +
    '\n'
  );
}

export function finderPrompt(scopeBlock, f) {
  return (
    '## Code-review finder — ' +
    f.label +
    '\n\n' +
    scopeBlock +
    '\n' +
    'Read the diff file named in the scope block above (do not run `git diff` yourself) and review ONLY through the lens of your assigned angle:\n\n' +
    f.text +
    '\n' +
    (f.kind === 'cleanup' ? CLEANUP_PRECEDENCE + '\n' : '') +
    'Surface up to ' +
    PER_ANGLE +
    ' candidate findings, each with file, line, a one-line summary, and a concrete failure_scenario — the user-visible consequence (error, wrong output, data loss), not an intermediate state (value stale, set grows). ' +
    'Pass every candidate with a nameable failure scenario through — do not silently drop half-believed candidates; an independent verifier judges them next. ' +
    'If nothing qualifies, return an empty list.\n\nStructured output only.'
  );
}

/** Fingerprint the prompt-side inputs that determine a cached model answer. Non-strings are
 *  serialized rather than coerced so schemas with different structure cannot collapse onto the
 *  same digest accidentally. */
export function promptFingerprint(parts) {
  const body = parts
    .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
    .join('\0');
  return createHash('sha1').update(body).digest('hex').slice(0, 8);
}

/** The one builder for cached Codex-call tags. `-` is deliberate: sanitizeTag preserves it,
 *  whereas `@` is rewritten to `_` and could collide with a base tag that already contains `_`. */
export function callTag(base, digest) {
  return typeof digest === 'string' && digest.length > 0 ? `${base}-${digest}` : base;
}

export function promptCallDigest({ prompt, schema, model }) {
  return promptFingerprint([prompt, schema, model]);
}

// ─── plan 3369, task 3 — path scope (--paths / --exclude-paths / auto-budget) ──
// git pathspec MAGIC does the glob matching (`:(top,glob)…`), not a hand-rolled
// glob-to-regex — the same primitive review-diff-scope.mjs's own built-in
// `:(top,exclude)…` list already relies on (verified live: an all-exclusion
// pathspec list means "everything except", and a positive `:(top,glob)…`
// pathspec combined with an `:(top,glob,exclude)…` one subtracts correctly —
// git handles the OR-then-subtract semantics natively). A user-supplied glob
// and the built-in exclude list therefore agree on what e.g. `backend/data/**`
// means; there is no second, JS-side glob dialect to keep in sync.
export function userPathspecs(paths, excludePaths) {
  return [
    ...(paths || []).map((p) => `:(top,glob)${p}`),
    ...(excludePaths || []).map((p) => `:(top,glob,exclude)${p}`),
  ];
}

// One scoped `git diff` + `git diff --name-only`, sharing the pathspec list — the
// SAME shape review-diff-scope.mjs's writeScopedPatch/changedFilePartition
// return, but parameterized over an ARBITRARY pathspec list (that module's own
// functions hard-code REVIEW_DIFF_EXCLUDES only, so they cannot take --paths/
// --exclude-paths/the auto-budget list — and review-diff-scope.mjs is out of
// this plan's file allowlist). Kept intentionally small: the two git calls and
// the write are the whole of writeScopedPatch's own non-worktree path.
function diffWithPathspecs(targets, pathspecs, outPath, repoRoot) {
  const nameOnlyOut = execFileSync('git', ['diff', '--name-only', ...targets, '--', ...pathspecs], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: GIT_MAXBUFFER,
  });
  const files = nameOnlyOut
    .split(/\r?\n/)
    .map((f) => f.replace(/\\/g, '/'))
    .filter(Boolean);
  const patch = execFileSync('git', ['diff', ...targets, '--', ...pathspecs], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: GIT_MAXBUFFER,
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, patch);
  return { files, patch };
}

// A `git diff --name-only` probe with no patch write — used only to measure ONE additive glob's
// own effect on the file list (additiveGlobsThatDropped below), never to produce output this
// run's finders will read. Deliberately does not share diffWithPathspecs's shape: writing a
// throwaway patch to `outPath` on every probe would repeatedly clobber the file the caller is
// about to overwrite for real anyway.
function nameOnlyForPathspecs(targets, pathspecs, repoRoot) {
  const nameOnlyOut = execFileSync('git', ['diff', '--name-only', ...targets, '--', ...pathspecs], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: GIT_MAXBUFFER,
  });
  return nameOnlyOut
    .split(/\r?\n/)
    .map((f) => f.replace(/\\/g, '/'))
    .filter(Boolean);
}

// plan 3369 fix round 3 (f8c8df): which of `additiveGlobs` ACTUALLY dropped a file from this
// diff, one glob at a time — never the whole set just because ONE of them fired. Round 2's
// all-or-nothing report (every additive glob named whenever ANY of them dropped something) is
// the same false-provenance class rounds 1 and 2 both had to fix one layer up
// (buildScopeStatsField's own "fired but dropped nothing -> []" contract): if a SECOND additive
// glob is ever added to DEFAULT_DATA_EXCLUDE_GLOBS and it matches nothing in a given diff while
// the first one does, the report must not claim that second tree was excluded too. One extra
// `--name-only` probe per additive glob, only on this already-rare over-budget path. Exported and
// pure-of-side-effects (only reads via git, writes nothing) so it is independently testable
// without waiting for a real second additive glob to exist.
export function additiveGlobsThatDropped({
  diffTargets,
  basePathspecs,
  additiveGlobs,
  beforeFileCount,
  repoRoot,
}) {
  return additiveGlobs.filter((g) => {
    const withOne = nameOnlyForPathspecs(
      diffTargets,
      [...basePathspecs, ...userPathspecs([], [g])],
      repoRoot,
    );
    return withOne.length < beforeFileCount;
  });
}

// Layers --paths/--exclude-paths and (when still over budget) the auto data-tree
// exclusion on TOP OF the already built-in-excluded diff — never called at all
// when neither applies and the diff is under budget (main() gates the call), so
// the common review pays no extra git spawn for this. Returns the NARROWED
// files/patch and which auto-excluded globs (if any) fired, so the caller can
// build the no-silent-truncation note and the stats.json `scope` record.
export function applyPathScope({
  diffTargets,
  outPath,
  repoRoot,
  paths = [],
  excludePaths = [],
  budgetChars = FINDER_CONTEXT_BUDGET_CHARS,
  // plan 4071 T2: the caller resolves the project's review-diff excludes (from the repo
  // under review — `main()` reads `loadCoordConfig(repoRoot)`, never this checkout's own
  // coord.config.json, since `--repo` can point elsewhere) and passes them in. The
  // CORE-only default keeps every existing direct caller (tests included) working exactly
  // as before this plan on a repo with no coord.config.json row of its own.
  excludes = CORE_REVIEW_DIFF_EXCLUDES,
}) {
  const basePathspecs = [...scopedPathspecs(excludes), ...userPathspecs(paths, excludePaths)];
  let { files, patch } = diffWithPathspecs(diffTargets, basePathspecs, outPath, repoRoot);
  let autoExcludedGlobs = [];
  if (patch.length > budgetChars) {
    // plan 3369 fix round 2 (374430/3952c1): `basePathspecs` above already applies
    // scopedPathspecs(excludes) UNCONDITIONALLY, before this layer ever runs — so
    // re-adding those SAME members here (defaultDataExcludeGlobsFor's own header comment
    // calls this out as a proven no-op) can never be what THIS pass excluded. Only the
    // genuinely-additive globs — defaultDataExcludeGlobsFor(excludes) minus excludes itself —
    // can ever drop a NEW file here; re-deriving that set structurally (not hand-copied) means
    // a future review-diff-excludes addition stays correctly excluded from this provenance too.
    const additiveGlobs = defaultDataExcludeGlobsFor(excludes).filter((g) => !excludes.includes(g));
    const withAuto = diffWithPathspecs(
      diffTargets,
      [...basePathspecs, ...userPathspecs([], additiveGlobs)],
      outPath,
      repoRoot,
    );
    // plan 3369 fix round 3 (f8c8df): derived PER GLOB now (additiveGlobsThatDropped above),
    // never all-or-nothing off `withAuto.files.length < files.length` — that combined check
    // (round 2) already closed the "fired but dropped NOTHING at all" false-narrowing case, but
    // still named every additive glob whenever ANY of them dropped something. Only claim
    // provenance for the glob(s) that actually removed a file from THIS diff.
    autoExcludedGlobs = additiveGlobsThatDropped({
      diffTargets,
      basePathspecs,
      additiveGlobs,
      beforeFileCount: files.length,
      repoRoot,
    });
    files = withAuto.files;
    patch = withAuto.patch;
  }
  return { files, patch, autoExcludedGlobs };
}

// The no-silent-truncation sentence for the SECOND (--paths/--exclude-paths/
// auto-budget) exclusion layer — pure, so it is unit-testable without a repo.
// Empty string when nothing was dropped by THIS layer, mirroring
// review-diff-scope.mjs's own excludedNote() contract for its layer.
export function buildPathScopeNote({
  paths = [],
  excludePaths = [],
  autoExcludedGlobs = [],
  droppedCount,
}) {
  if (!droppedCount) return '';
  const parts = [];
  if (paths.length) parts.push(`--paths ${paths.join(',')}`);
  if (excludePaths.length) parts.push(`--exclude-paths ${excludePaths.join(',')}`);
  if (autoExcludedGlobs.length)
    parts.push(
      `auto-excluded over the ${FINDER_CONTEXT_BUDGET_CHARS}-char finder context budget: ${autoExcludedGlobs.join(', ')}`,
    );
  return (
    `Additionally excluded from this diff by path scope (${parts.join('; ')}): ${droppedCount} ` +
    'changed file(s). Do not report findings against them and do not run `git diff` yourself to ' +
    'recover them.'
  );
}

// plan 3369 fix round 1 (b65c47/3e458e): the stats.json `scope` field, factored out so its
// gating is unit-testable without running main()'s full finder/verify pipeline (which needs a
// real codex transport). Present ONLY when the path-scope layer actually EXCLUDED a file
// (`droppedCount > 0`) — a `--paths` glob that matches every changed file, or an auto-budget
// check that fires but drops nothing, must never announce a narrowing that did not happen; that
// is the same false-record class as a false PASS. `{}` (not merely an empty `scope`) when
// nothing was dropped, so stats.json stays byte-identical to before this plan on the common,
// unscoped path when spread into the surrounding object.
export function buildScopeStatsField(
  droppedCount,
  { userPaths, userExcludePaths, autoExcludedGlobs },
) {
  if (!(droppedCount > 0)) return {};
  return {
    scope: {
      userPaths,
      userExcludePaths,
      autoExcludedGlobs,
      excludedFileCount: droppedCount,
    },
  };
}

// ─── Claude data-grounding arm — prompt + result parsing (pure) ─────────────
// Reuses DATA_GROUNDING_ANGLES verbatim (byte-ported from run_gpt_dgv_arm.py,
// see above) — do not rewrite the angle prompts here.
//
// Delimiter contract, round 4 (post real-data validation): the round-3 real
// run proved the arm's grounding work (it found the target defect, grep-the-
// seed reasoning the 11 codex finders have never once performed) but never
// emitted the delimiter pair at all — it answered in unwrapped prose, so
// extractDelimitedCandidatesJson correctly returned null and the call
// soft-failed with real recall already in hand. Root cause (from that
// transcript): the round-3 prompt's FIRST line ever said was the model
// deciding to WRITE ITS ANSWER TO A FILE ("Node runs under Windows and can't
// see /tmp. Let me write the file into the working directory instead.") — it
// believed file output was expected. Two fixes, both in THIS prompt only
// (nothing about the transport or the extractor changed — those are proven on
// real data, see runClaudeArm/extractDelimitedCandidatesJson):
//   1. The round-3 prompt's "your response may be followed by additional
//      unrelated turns you do not control" warning is REMOVED. It was written
//      for the pre-disableAllHooks world (survive an appended epilogue) and is
//      now both stale (disableAllHooks means there is no reopened turn to
//      survive) and the likely source of the file-output confusion — telling
//      a model its answer "may not be the final word" is exactly the kind of
//      hint that nudges toward a more "durable" hand-off like a file.
//   2. The format contract is now explicit about NOT writing a file, and
//      appears TWICE: once up front (so it isn't buried after two long angle
//      texts — the round-3 answer took 24 turns to arrive at prose, evidence
//      the contract was easy to lose track of), and once more as the FINAL
//      instruction with the literal delimited template as the prompt's last
//      content — nothing about "answer" is ambiguous between those two points.
export const CLAUDE_ARM_DELIM_START = '<<<GPT_REVIEW_CANDIDATES>>>';
export const CLAUDE_ARM_DELIM_END = '<<<END_GPT_REVIEW_CANDIDATES>>>';

export function claudeArmPrompt(scopeBlock, { repoRoot } = {}) {
  return (
    '## Code-review finder — ' +
    CLAUDE_ARM_LABEL +
    ' (Sonnet-high hybrid arm, plan 2766)\n\n' +
    'OUTPUT FORMAT — read this first, it governs your entire reply: your answer ' +
    'is a single JSON object wrapped between ' +
    CLAUDE_ARM_DELIM_START +
    ' and ' +
    CLAUDE_ARM_DELIM_END +
    ', emitted INLINE as your reply text in this turn. Do not write it to a ' +
    'file, do not save it to disk, do not create any file at all — answer ' +
    'directly in the conversation. Nothing outside that delimited block is ' +
    'read; any prose before or after it is discarded.\n\n' +
    (repoRoot
      ? 'WORKING DIRECTORY: your current working directory is a disposable ' +
        'scratch folder, NOT this repository — it is discarded after this ' +
        'call. You have read access to the repository at "' +
        repoRoot +
        '" via the Read/Grep/Glob tools and via git, but you MUST prefix ' +
        'every git command you run with `-C ' +
        repoRoot +
        '` (so "git diff ..." becomes "git -C ' +
        repoRoot +
        ' diff ...", likewise for show/log/grep/ls-files/blame). Do not ' +
        '`cd` anywhere. You never have a reason to write, save, or create ' +
        'any file for any purpose in this task — your only output is the ' +
        'delimited answer described above, said directly in your reply ' +
        'text.\n\n'
      : '') +
    scopeBlock +
    '\n' +
    'Read the diff file named in the scope block above (do not run `git diff` yourself) ' +
    'and review through BOTH of the following ' +
    'data-grounding lenses. Apply each one independently — a candidate may come ' +
    'from either lens or both:\n\n' +
    DATA_GROUNDING_ANGLES.map((a) => a.text).join('\n') +
    '\n' +
    'Surface up to ' +
    CLAUDE_ARM_CAP +
    ' candidate findings total across both lenses, each with file, line, a ' +
    'one-line summary, and a concrete failure_scenario — the user-visible ' +
    'consequence (error, wrong output, data loss), not an intermediate state ' +
    '(value stale, set grows). Pass every candidate with a nameable failure ' +
    'scenario through — do not silently drop half-believed candidates; an ' +
    'independent verifier judges them next. If nothing qualifies, use an ' +
    'empty candidates list — never skip the delimited block itself.\n\n' +
    'FINAL INSTRUCTION — this is the ONLY output that counts: reply with ' +
    'ONLY the JSON object below, wrapped EXACTLY between the two delimiter ' +
    'lines, nothing else between them, no markdown code fence, no prose ' +
    'before or after the delimiters. Emit it directly as your reply text — ' +
    'never write it to a file or any other location:\n' +
    CLAUDE_ARM_DELIM_START +
    '\n' +
    '{"candidates": [{"file": "<path>", "line": <number|null>, "summary": ' +
    '"<one-line>", "failure_scenario": "<concrete consequence>"}]}\n' +
    CLAUDE_ARM_DELIM_END +
    '\n'
  );
}

// Takes an array of candidate text blocks (in practice a ONE-element array —
// `[envelope.result]`, the single `--output-format json` envelope's final
// message — kept general because it was written for, and is still correct
// for, a multi-block stream) and returns the raw text found inside the LAST
// delimiter-wrapped span across the WHOLE array, or null if no block contains
// a complete pair.
//
// Scope of what this defends against, stated precisely (findings 2766-round-3
// review): the arm's PRIMARY defense against a Stop-hook epilogue clobbering
// the answer is now `--settings '{"disableAllHooks":true}'` on the transport
// (see runClaudeArm) — that is what stops the turn from being reopened at
// all. This function is the SECONDARY, cheaper-than-free layer on top: within
// the ONE final message `--output-format json` reports, it is still tolerant
// of the model wrapping its JSON in a little surrounding prose ("Here is my
// analysis: <<<...>>> Let me know if you want more."), and it costs nothing
// to keep. It CANNOT recover an answer that a reopened turn has structurally
// REPLACED — `envelope.result` is only ever the LAST message's text, so if
// disableAllHooks does not suppress a Stop hook, the real delimited answer is
// simply gone from the envelope, not just harder to find in it. That is
// exactly the question the plan-2766 smoke run empirically answers.
export function extractDelimitedCandidatesJson(assistantTexts) {
  let found = null;
  for (const text of assistantTexts || []) {
    if (typeof text !== 'string') continue;
    const startIdx = text.lastIndexOf(CLAUDE_ARM_DELIM_START);
    if (startIdx === -1) continue;
    const endIdx = text.indexOf(CLAUDE_ARM_DELIM_END, startIdx + CLAUDE_ARM_DELIM_START.length);
    if (endIdx === -1) continue;
    found = text.slice(startIdx + CLAUDE_ARM_DELIM_START.length, endIdx).trim();
  }
  return found;
}

// `claude -p --json-schema` does NOT enforce structure (pinned decision — codex's
// --output-schema is the only ENFORCED shape in this file). Operates on text
// ALREADY isolated by extractDelimitedCandidatesJson — still tolerant of a
// stray ```json fence inside the delimiters, mirroring the extraction
// convention every other `claude -p` call site in this repo already uses
// (a project-side classifier's parseClassifyResponse; backend/scripts/
// closure-sweep/interpret-lib.mjs's parseWindows). Returns `candidates: null`
// (with a `parseError` reason) on anything unparseable — never throws.
export function parseClaudeArmCandidates(resultText) {
  if (typeof resultText !== 'string' || !resultText.trim()) {
    return { candidates: null, parseError: 'empty' };
  }
  const fenced = resultText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const unfenced = (fenced ? fenced[1] : resultText).trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return { candidates: null, parseError: 'no_json_object' };
  }
  let parsed;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch (e) {
    return { candidates: null, parseError: `json: ${e.message}` };
  }
  if (!parsed || !Array.isArray(parsed.candidates)) {
    return { candidates: null, parseError: 'missing_candidates_array' };
  }
  return { candidates: parsed.candidates, parseError: null };
}

// Resolved-model provenance (wiki/concepts/bake-offs.md "Artifacts now NAME the
// resolved model" policy), ported at reduced generality from
// backend/scripts/lib/claude_hooks.py's resolved_model_stamp: `requested` is the
// bare alias the call site asked for (kept separately by the caller); this reads
// back what the harness actually BILLED from the `--output-format json`
// envelope's `modelUsage`. `claude --version` (probed by the caller, not here —
// this stays a pure function) is the ONLY fallback source; a date table is never
// a source. Never throws on data: an unreadable/empty `modelUsage` degrades to
// `unavailable` rather than guessing.
export function resolveClaudeModelStamp(envelope, requested = CLAUDE_MODEL) {
  const usage = envelope && typeof envelope === 'object' ? envelope.modelUsage : null;
  if (!usage || typeof usage !== 'object' || Object.keys(usage).length === 0) {
    return { resolvedModel: null, resolvedVia: 'unavailable' };
  }
  const ids = Object.keys(usage);
  const outputTokens = (id) => {
    const e = usage[id];
    return e && typeof e.outputTokens === 'number' ? e.outputTokens : 0;
  };
  const family = ids.filter((id) => id.toLowerCase().includes(String(requested).toLowerCase()));
  const pool = family.length > 0 ? family : ids;
  const picked = pool.reduce(
    (best, id) => (outputTokens(id) > outputTokens(best) ? id : best),
    pool[0],
  );
  return {
    resolvedModel: picked,
    resolvedVia: family.length > 0 ? 'output-json' : 'output-json-family-mismatch',
  };
}

// Total token accounting for one envelope's modelUsage — its OWN bucket,
// never summed into the codex token total (different subscriptions, not the
// same currency; see the file header).
export function sumModelUsageTokens(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return 0;
  let total = 0;
  for (const entry of Object.values(modelUsage)) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cacheReadInputTokens',
      'cacheCreationInputTokens',
    ]) {
      if (typeof entry[key] === 'number') total += entry[key];
    }
  }
  return total;
}

// ─── Claude data-grounding arm — soft-fail classification (pure) ───────────
// The ONE place in this file a call error is not fatal. A codex finder failure
// process.exit(2)s the whole review (an angle at zero coverage must not read as
// clean); this arm instead degrades the review to codex-only coverage — the
// recorded status quo for every review before plan 2766 — because the arm exists
// to RELIEVE Claude-quota pressure the gpt-review lane was adopted to escape, so
// it must never make the whole review depend on that same quota.
//
// `raw` is runClaudeArm()'s return shape: `{ error, wallS }` on any transport
// failure (spawn/timeout/non-zero-exit/bad envelope JSON), or `{ envelope,
// wallS }` on a completed call — the single `--output-format json` envelope
// (round-3 revert: NOT the stream-json shape an earlier version of this file
// built — the arm's primary defense against a Stop-hook epilogue is now
// `--settings disableAllHooks` on the transport, per repo precedent; see
// runClaudeArm's header comment) — same shape a test double can construct
// without spawning anything.
//
// status is exactly one of:
//   'ok'            — a candidates array (possibly empty — "nothing qualifies"
//                      is a legitimate outcome) was extracted from the
//                      envelope's `result` text (delimiter-wrapped span
//                      preferred via extractDelimitedCandidatesJson, falling
//                      back to prose-tolerant brace extraction).
//   'failed: <why>' — transport error, OR the envelope parsed but no
//                      candidates JSON could be extracted from its `result`
//                      text. Either way this arm produced NO coverage this
//                      run. `costUsd`/`turns` are still populated when the
//                      envelope carries them — a failed call can still have
//                      burned real quota (the incident that motivated the
//                      delimiter fix: $1.78 / 34 turns on a call whose answer
//                      got clobbered) and that must stay visible even when
//                      there's no coverage to show for it.
// Never returns anything else — a caller can safely branch on
// `status === 'ok'` vs `status.startsWith('failed')` and nothing in between.
export function classifyClaudeArmResult(raw, { files = [], model = CLAUDE_MODEL } = {}) {
  if (!raw || raw.error) {
    return {
      status: `failed: ${raw?.error || 'unknown error'}`,
      candidates: [],
      tokens: 0,
      resolvedModel: null,
      resolvedVia: 'unavailable',
      costUsd: null,
      turns: null,
    };
  }
  const envelope = raw.envelope;
  const resultText = envelope && typeof envelope.result === 'string' ? envelope.result : '';
  const { resolvedModel, resolvedVia } = resolveClaudeModelStamp(envelope, model);
  const tokens = sumModelUsageTokens(envelope?.modelUsage);
  const costUsd = typeof envelope?.total_cost_usd === 'number' ? envelope.total_cost_usd : null;
  const turns = typeof envelope?.num_turns === 'number' ? envelope.num_turns : null;
  // A non-success terminal subtype (`error_max_turns`, `error_during_execution`)
  // means the call never reached its own answer — whatever sits in `result` is
  // a truncated mid-thought, not a finding set. Fail on it BY NAME rather than
  // letting it fall through to a "candidates JSON unparseable" that hides which
  // limit was hit: a turn-cap exhaustion is fixed by raising the cap, and it
  // cost two measurement runs in plan 2766 to learn that from a generic parse
  // error. `undefined` subtype (older CLI shape) stays permissive.
  if (envelope?.subtype != null && envelope.subtype !== 'success') {
    return {
      status: `failed: terminal subtype ${envelope.subtype}`,
      candidates: [],
      tokens,
      resolvedModel,
      resolvedVia,
      costUsd,
      turns,
    };
  }
  // Delimiter-wrapped span preferred (cheap prose-tolerance insurance, see
  // extractDelimitedCandidatesJson's header comment); a response that never
  // used the delimiters at all still gets a fair parse via the raw text.
  const delimited = extractDelimitedCandidatesJson([resultText]);
  const candidateText = delimited !== null ? delimited : resultText;
  const { candidates, parseError } = parseClaudeArmCandidates(candidateText);
  if (candidates === null) {
    return {
      status: `failed: candidates JSON unparseable (${parseError})`,
      candidates: [],
      tokens,
      resolvedModel,
      resolvedVia,
      costUsd,
      turns,
    };
  }
  // The JSON parsed, but nothing guarantees its ELEMENTS are candidate objects
  // — a model can emit `"candidates": ["..."]` or slip a null into the list.
  // Dereferencing those (`c.file`) threw and took the whole review down with
  // it, which defeats the arm's entire soft-fail contract: a malformed extra
  // arm candidate must never cost the 11 codex angles their run.
  const usable = [];
  let malformed = 0;
  for (const c of candidates) {
    if (c && typeof c === 'object' && !Array.isArray(c) && typeof c.summary === 'string') {
      usable.push(c);
    } else {
      malformed++;
    }
  }
  if (usable.length === 0 && malformed > 0) {
    return {
      status: `failed: ${malformed} candidate(s), none well-formed`,
      candidates: [],
      malformed,
      tokens,
      resolvedModel,
      resolvedVia,
      costUsd,
      turns,
    };
  }
  const shaped = usable.slice(0, CLAUDE_ARM_CAP).map((c) => ({
    file: canonFile(c.file, files),
    line: c.line ?? null,
    summary: c.summary,
    failure_scenario: typeof c.failure_scenario === 'string' ? c.failure_scenario : '',
    angle: CLAUDE_ARM_LABEL,
    kind: 'correctness',
  }));
  return {
    status: 'ok',
    candidates: shaped,
    malformed,
    tokens,
    resolvedModel,
    resolvedVia,
    costUsd,
    turns,
  };
}

// Finders may return absolute/backslash paths for the same changed file —
// normalize by suffix-matching against the scope's file list (longest match
// wins), same rule sonnet-review.js's canonFile uses.
export function canonFile(raw, files) {
  if (!raw) return '';
  const p = String(raw).replace(/\\/g, '/');
  let best = '';
  for (const sf of files) {
    // Template, not `'/' + sf`: that literal-slash concat matches select-battery-tests.mjs's
    // CONCAT_PATH_RX, which reads it as an unresolvable computed script path and widens the
    // pass-cache key for every selection whose closure reaches this file (plan 3380 — adding
    // the lock-path import below put gpt-review.mjs in that closure and turned this
    // long-standing false positive into a red battery). Behaviour is identical.
    if ((p === sf || p.endsWith(`/${sf}`)) && sf.length > best.length) best = sf;
  }
  return best || p;
}

export function locKey(c) {
  return c.file + (c.line != null ? ':' + c.line : '');
}

export function groupByLoc(candidates) {
  const byLoc = Object.create(null);
  for (const c of candidates) (byLoc[locKey(c)] ||= []).push(c);
  return Object.values(byLoc);
}

export function groupVerifierPrompt(scopeBlock, group) {
  return (
    '## Code-review verifier\n\n' +
    scopeBlock +
    '\n' +
    '## Candidate findings at ' +
    locKey(group[0]) +
    '\n' +
    group
      .map(
        (c, i) =>
          '[' +
          i +
          '] Summary: ' +
          c.summary +
          '\n' +
          '    Failure scenario: ' +
          c.failure_scenario,
      )
      .join('\n') +
    '\n\n' +
    'Read the diff file named in the scope block above (do not run `git diff` yourself), read the relevant file(s), and return one verdict per candidate. ' +
    'Judge EACH candidate independently on its own claim — candidates at the same location may describe distinct issues, the same issue, or a mix. ' +
    'Reference each by its [i] index.\n\n' +
    VERDICT_LADDER +
    '\n\n' +
    VERDICT_LADDER_RECALL +
    '\n\n' +
    FINDING_TAG_NOTE +
    '\n\n' +
    'Structured output only. Evidence must quote or cite the relevant line(s).'
  );
}

// ─── Round-1/escalation classification (pure) ───────────────────────────────
// A round-1 verifier result per candidate carries either a real verdict or
// `__needsEscalation: true` (the whole group's verifier call failed, or the
// call succeeded but omitted this candidate's index) — never a silent drop
// (the c4 defect this plan must not reintroduce). `settled` are kept as-is;
// `toEscalate` (REFUTED + needsEscalation) go to the Sol adjudicator.
export function classifyRound1(round1Candidates) {
  const settled = [];
  const toEscalate = [];
  for (const c of round1Candidates) {
    if (!c.__needsEscalation && (c.verdict === 'CONFIRMED' || c.verdict === 'PLAUSIBLE'))
      settled.push(c);
    else toEscalate.push(c);
  }
  return { settled, toEscalate };
}

// A round-2 (Sol) result per candidate: CONFIRMED/PLAUSIBLE kept, REFUTED
// dropped (logged), needsEscalation (Sol call ALSO failed / omitted the
// index) marked UNVERIFIED and kept — never dropped silently.
export function classifyRound2(round2Candidates) {
  const kept = [];
  const refuted = [];
  for (const c of round2Candidates) {
    if (c.__needsEscalation) {
      kept.push({
        ...c,
        verdict: 'UNVERIFIED',
        evidence:
          c.evidence ||
          'Sol adjudicator unavailable — kept unverified rather than silently dropped.',
      });
    } else if (c.verdict === 'REFUTED') {
      refuted.push(c);
    } else {
      kept.push(c);
    }
  }
  return { kept, refuted };
}

export function shortKey(...parts) {
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 6);
}

export function structuredKey(parts) {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 6);
}

// Build the findings.json shape from the final kept candidates. Extra fields are opt-in because
// gpt-review dispositions are keyed on the legacy joined file/line/summary hash, so that encoding
// is frozen. Copy-review opts proposed_fix in because it is part of that finding's identity; its
// structured array encoding keeps adversarial summary text from forging an extras boundary.
export function shapeFindings(kept, { extraFields = [] } = {}) {
  return kept.map((c) => {
    const extras = {};
    const adjudicatorTags = {};
    const presentExtraValues = [];
    for (const name of ['preExisting', 'preExistingWhy', 'blocksLand', 'blocksLandWhy']) {
      if (c[name] !== undefined) adjudicatorTags[name] = c[name];
    }
    for (const name of extraFields) {
      if (c[name] === undefined || c[name] === null) continue;
      extras[name] = c[name];
      presentExtraValues.push(c[name]);
    }
    return {
      key: presentExtraValues.length
        ? structuredKey([c.file, String(c.line ?? ''), c.summary, presentExtraValues])
        : shortKey(c.file, String(c.line ?? ''), c.summary),
      file: c.file,
      line: c.line ?? null,
      summary: c.summary,
      failure_scenario: c.failure_scenario,
      angle: c.angle,
      verdict: c.verdict,
      ...(c.kind !== undefined ? { kind: c.kind } : {}),
      evidence: c.evidence || '',
      ...adjudicatorTags,
      ...extras,
    };
  });
}

// Same shape minus failure_scenario — derived, so the key/fields can't drift.
export function shapeRefuted(refuted, opts = {}) {
  return shapeFindings(refuted, opts).map(({ failure_scenario, ...rest }) => rest);
}

// Parse codex's "tokens used\n<N>" trailer out of its combined stdout/stderr.
export function parseTokensUsed(stdout) {
  const m = String(stdout || '').match(/tokens used\s*\n\s*([\d\s.,]+)/);
  if (!m) return null;
  const digits = m[1].replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : null;
}

// Walk up from repoRoot (Hobby-level ancestors) plus the user-level
// ~/.claude/CLAUDE.md, plus any CLAUDE.md/CLAUDE.local.md that is an ancestor
// (within the repo) of a changed file — the same set sonnet-review.js's
// conventions angle enumerates.
export function findClaudeMdFiles(repoRoot, files) {
  const found = new Set();
  const homeMd = join(homedir(), '.claude', 'CLAUDE.md');
  if (existsSync(homeMd)) found.add(homeMd);
  let dir = dirname(repoRoot);
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'CLAUDE.md');
    if (existsSync(p)) found.add(p);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const f of files) {
    let d = dirname(join(repoRoot, f));
    while (d.length >= repoRoot.length && d !== dirname(d)) {
      for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
        const p = join(d, name);
        if (existsSync(p)) found.add(p);
      }
      if (d === repoRoot) break;
      d = dirname(d);
    }
  }
  return [...found];
}

// ─── Codex transport ─────────────────────────────────────────────────────────
export function resolveCodexBin() {
  if (process.env.GPT_REVIEW_CODEX_BIN)
    return existsSync(process.env.GPT_REVIEW_CODEX_BIN) ? process.env.GPT_REVIEW_CODEX_BIN : null;
  if (process.platform !== 'win32') return 'codex';
  try {
    const out = execFileSync('where', ['codex.cmd'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    if (out && existsSync(out)) return out;
  } catch {
    /* where failed — fall through to the known-good literal path */
  }
  return existsSync(WIN32_FALLBACK_CODEX) ? WIN32_FALLBACK_CODEX : null;
}

// plan 2665 — cloud self-bootstrap. A cloud sandbox starts with neither the codex
// CLI nor ~/.codex/auth.json; the full-egress envs carry the ChatGPT login as an
// env secret instead, under the name coord.config.json's `codexAuthEnvVar` names
// (recipe proven by the 2026-07-31 zed smoke,
// report branch claude/codex-cloud-smoke-report: npm install -g @openai/codex ~8s,
// decode secret → auth.json chmod 600). BOTH steps gate on the secret being
// present — a local machine never carries it, so this never installs
// or writes anything locally. The secret's value is never logged. Failures are
// non-fatal here: the run proceeds and the normal transport-failure exit (2)
// triggers the /sonnet-review fallback.
// plan 3380 — the MAIN checkout, which is what codex keys project/hook trust on
// (never the worktree: `~/.codex/config.toml` carries no worktree entries at all,
// codex resolves the project layer through the shared Git directory, so every
// `.claude/worktrees/<slug>` inherits the main checkout's trusted layer — see
// docs/coord/rule-tiers.md § The multi-runtime mirroring problem). Derived, never hardcoded to the
// sandbox's `/home/user/vetapp`, so the same seam is correct on a local checkout.
// Returns null on any git failure; every caller treats that as "seed nothing".
//
// The common-dir resolution itself is `resolveCommonDirPath` (scripts/coord/lock-path.mjs), not a
// local re-roll: that helper already scrubs every `GIT_*` env var before the child runs (a
// stray ambient `GIT_DIR` would otherwise resolve some OTHER checkout and we would trust the
// wrong project) and already normalizes the absolute-from-a-worktree vs. relative-`.git`-from-
// the-main-checkout shapes git returns on Windows. Both were bugs it was written to fix.
export function resolveCodexTrustRoot(anchor) {
  try {
    return dirname(resolveCommonDirPath({ anchor }));
  } catch {
    return null;
  }
}

// plan 3380 — cloud hook-trust seeding. A full-egress sandbox has NO
// `~/.codex/config.toml` at all (measured plan 3377, re-measured 3380), so it holds
// zero `[projects...]` trust entries — and an UNTRUSTED project never loads
// `.codex/hooks.json`, so every context-injection hook fires SILENTLY dark. Measured
// 3380: project trust is the gating layer, and `--dangerously-bypass-hook-trust`
// ALONE does not lift it (bypass acknowledged, still zero hooks fired); project trust
// alone fires zero hooks too. BOTH halves are required — this function writes the
// persisted half, codexHookTrustArgs() below passes the per-invocation half.
//
// Persisted, not `-c projects…` on the CLI: measured 3380 that a CLI override of the
// projects table does NOT establish trust (still zero hooks) — codex reads project
// trust from the config FILE only.
//
// Two hard safety gates, both deliberate:
//  - the configured codex-auth env var gates the whole thing, exactly like the auth write
//    above, so a LOCAL machine (which never carries the secret) is never touched. The operator's
//    real `~/.codex/config.toml` carries their genuine per-event `trusted_hash`
//    entries; clobbering it would take the LOCAL /gpt-review lane silently dark —
//    the precise hazard this whole line of work exists to prevent.
//  - Existing content is always carried over VERBATIM. A config.toml that already trusts this
//    project is left byte-identical; one that does not yet mention it gets our table added
//    after its existing bytes; one that mentions it WITHOUT trusting it is left alone and
//    logged (an explicit `trust_level = "untrusted"` is a decision, not a gap to overwrite).
//    Adding rather than skipping is what keeps the "already dark" case recoverable: an early
//    version skipped seeding entirely whenever any config.toml existed, which meant a sandbox
//    where anything had written one for any reason stayed silently uninjected forever — the
//    exact failure this whole plan closes (review 3380, five finders).
//
// `trustAnchor` is the checkout being REVIEWED (`--repo`), not `process.cwd()`. Trust must key
// on the main checkout of the repo whose hooks will fire; resolving from the launcher's cwd
// trusted whatever repo the operator happened to be standing in, which is a different project
// whenever `--repo` points elsewhere — the flag's entire purpose (review 3380, five finders).
// plan 3380 — is `root` already present in this config, and is it actually TRUSTED?
// Returns 'trusted' | 'present' | 'absent'.
//
// Line-anchored, not a substring scan: `current.includes('[projects."…"]')` also matched the
// table name inside a COMMENT (or any other prose), which would read as "already trusted" and
// skip seeding forever. And presence alone is not trust — a table carrying
// `trust_level = "untrusted"` is an explicit decision, so it is reported as 'present' and left
// alone rather than silently counted as good (review 3380 round 2, five finders).
//
// Both quote spellings are recognized: codex writes `[projects.'<path>']` (a TOML literal
// string), we write the basic-string form. Missing one would append a duplicate table for a
// path already present, and duplicate TOML tables are a parse error.
export function projectTrustState(configText, root, key = root) {
  const headers = [`[projects."${key}"]`, `[projects.'${root}']`];
  const lines = configText.split(/\r?\n/);
  // A header may carry a trailing inline comment (`[projects."/x"]  # note`). Since every
  // header string ends in `]`, anything following it can only be whitespace or a comment, so
  // "equals, or starts-with followed by space/tab/#" is exact without parsing TOML. Matching
  // the trimmed line alone missed those and reported 'absent' — which would append a SECOND
  // table for a path already present, and a duplicate TOML table is a parse error that bricks
  // the entire config rather than merely leaving it un-seeded (review 3380 round 3).
  const isHeader = (line) =>
    headers.some((h) => line === h || (line.startsWith(h) && /^[ \t#]/.test(line.slice(h.length))));
  for (let i = 0; i < lines.length; i++) {
    if (!isHeader(lines[i].trim())) continue;
    // Scan this table's body — up to the next table header — for a trusted trust_level.
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (line.startsWith('[')) break;
      if (/^trust_level\s*=\s*['"]trusted['"]\s*$/.test(line)) return 'trusted';
    }
    return 'present';
  }
  return 'absent';
}

export function ensureCodexProjectTrust({
  env = process.env,
  configPath = join(homedir(), '.codex', 'config.toml'),
  trustAnchor = process.cwd(),
  trustRoot,
  logFn = log,
  authEnvVar = DEFAULT_CODEX_AUTH_ENV_VAR,
} = {}) {
  if (!env[authEnvVar]) return { wroteTrust: false };
  const root = trustRoot === undefined ? resolveCodexTrustRoot(trustAnchor) : trustRoot;
  if (!root) {
    logFn('codex bootstrap: could not resolve the main checkout — hook trust not seeded');
    return { wroteTrust: false };
  }
  // A control character in the path cannot be represented in a TOML basic string, so writing
  // it would produce a config codex refuses to parse — which takes out every setting in the
  // file, not just ours. Refuse to seed instead.
  if (/[\u0000-\u001f\u007f]/.test(root)) {
    logFn('codex bootstrap: main checkout path has a control character — hook trust not seeded');
    return { wroteTrust: false };
  }
  // TOML basic-string escaping for the path key: backslash first, then quote.
  const key = root.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const table = `[projects."${key}"]`;
  const block =
    '# Added by scripts/gpt-review.mjs (plan 3380): a cloud sandbox starts with no\n' +
    '# ~/.codex/config.toml, and without a trusted project codex never loads .codex/hooks.json,\n' +
    '# so every context-injection hook fires SILENTLY dark. Never written on a local machine.\n' +
    `${table}\ntrust_level = "trusted"\n`;
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    if (existsSync(configPath)) {
      const current = readFileSync(configPath, 'utf8');
      const state = projectTrustState(current, root, key);
      if (state === 'trusted') return { wroteTrust: false };
      if (state === 'present') {
        // The table exists but does not say trusted. Appending a second table for the same
        // path is a TOML duplicate-key parse error, and REWRITING someone's explicit
        // `trust_level = "untrusted"` would override a deliberate decision — so do neither,
        // and say why injection will be dark instead of failing silently.
        logFn(
          `codex bootstrap: ${configPath} already has a [projects] entry for ${root} that is ` +
            'not trust_level = "trusted" — leaving it alone; codex hooks stay untrusted',
        );
        return { wroteTrust: false };
      }
      // Read-concat-atomic-replace rather than appendFileSync: the whole file lands in one
      // rename, so a mid-write failure can never leave a half-appended table behind (which
      // would be unparseable TOML, taking out every setting in the file, not just ours).
      // Existing bytes are carried over verbatim. Cross-PROCESS races are out of scope by
      // construction — the bootstrap runs once per process, before any finder spawns.
      atomicWriteTextSync(configPath, `${current}${current.endsWith('\n') ? '' : '\n'}\n${block}`);
      logFn(`codex bootstrap: appended ~/.codex/config.toml project trust for ${root}`);
      return { wroteTrust: true };
    }
    // atomicWriteTextSync (scripts/coord/atomic-write.mjs) rather than another hand-rolled
    // temp-write/rename: it fsyncs and cleans up its temp on failure, so a mid-write error
    // cannot leave a torn config that the existsSync branch above would then treat as real.
    atomicWriteTextSync(configPath, block);
    logFn(`codex bootstrap: seeded ~/.codex/config.toml project trust for ${root}`);
    return { wroteTrust: true };
  } catch (e) {
    // Non-fatal, like every other bootstrap step: the run proceeds with injection dark
    // rather than failing the review outright.
    logFn(`codex bootstrap: hook-trust seeding failed (${e.message}) — continuing uninjected`);
    return { wroteTrust: false };
  }
}

// plan 3380 — the per-invocation half of the trust fix, cloud-lane only.
//
// `--dangerously-bypass-hook-trust`: codex trusts hooks by a per-event content hash it
// computes itself, recorded only by the interactive `/hooks` flow — there is no
// non-interactive command that grants hook trust (checked: `codex debug`, `codex doctor`,
// 0.149.0), so an unattended sandbox cannot earn one. Synthesizing the hash ourselves was
// rejected: the rule is not documented and not guessable (measured 3380 — sha256 of the
// command string and of the serialized handler object both fire zero hooks), it lives in a
// stripped Rust binary and can change on any codex release, it would fail SILENTLY DARK when
// it does, and a hash we compute from the very file it attests is self-signing that proves
// nothing an attacker who can edit that file could not equally forge. The bypass is the
// honest form of the same trust decision, and codex prints a warning on every use.
//
// The vetted-source argument the flag's own docs ask for: this sandbox is ephemeral,
// single-tenant, and clones exactly one repo from one known remote — and it ALREADY executes
// that repo's code by design (pnpm lifecycle scripts, the husky hooks, the test batteries,
// the land spine). Hook trust guards an interactive user against a repo they have not read;
// it is not a boundary in an automation sandbox whose entire purpose is running this repo.
//
// `approval_policy="never"`: trusting the project activates the repo's own
// `.codex/config.toml`, whose `approval_policy = "on-request"` would newly let an unattended
// finder BLOCK on an escalation prompt (an untrusted project ran at `approval: never`;
// measured 3380 that a trusted one reports `approval: on-request`). Pinning it back keeps
// this change scoped to context injection and nothing else.
//
// plan 3958 review (key 10k7z8u): `authEnvVar` used to default to the neutral literal
// DEFAULT_CODEX_AUTH_ENV_VAR ('CODEX_LOGIN_B64'), so a caller that omitted the override (as
// sol-run.mjs and geo-engines/chatgpt.mjs both do) silently read the WRONG env var whenever a
// project's coord.config.json sets its own `codexAuthEnvVar` name (a real project does — see
// that project's own coord.config.json, never spelled out here so this file stays free of any
// one project's naming). The default now comes from the loaded coord config for `repoRoot` (the checkout whose
// coord.config.json governs this run), so every caller is right without passing anything; the
// explicit `authEnvVar` param remains for callers/tests that need a different name than
// `repoRoot`'s own config resolves to.
export function codexHookTrustArgs(
  env = process.env,
  repoRoot = process.cwd(),
  authEnvVar = loadCoordConfig(repoRoot).codexAuthEnvVar,
) {
  return env[authEnvVar]
    ? ['--dangerously-bypass-hook-trust', '-c', 'approval_policy="never"']
    : [];
}

export function ensureCodexBootstrap({
  env = process.env,
  authPath = join(homedir(), '.codex', 'auth.json'),
  installFn,
  probeFn = codexAvailable,
  logFn = log,
  trustFn = ensureCodexProjectTrust,
  // The checkout being REVIEWED (`--repo`), which is what the trust key must derive from —
  // not the launcher's cwd. Defaults to cwd only for callers that have no repo of their own.
  trustAnchor = process.cwd(),
  // Ambient-clock rule (vetapp CLAUDE.md): the instant is a PARAMETER, never a bare `Date.now()`
  // read inline where a test's expectation would have to race the real clock. Defaults to the
  // real clock for every production caller.
  now = Date.now(),
  // Same DI pattern as installFn/probeFn/trustFn above, defaulting to the real fs call. This is
  // ALSO the one seam a test has for driving the G3 race deterministically: the directory-create
  // is the only real side effect between the initial validation and the pre-rename recheck, so a
  // test's `mkdirFn` can create the dir for real AND then write a fresh valid login to `authPath`
  // to simulate "codex refreshed it in place while we were mid-repair" — no sleep, no thread.
  mkdirFn = mkdirSync,
  // plan 3958 review (key 10k7z8u): default from the loaded coord config for `trustAnchor` (the
  // checkout under review), not a neutral literal — see codexHookTrustArgs's own comment above
  // for the full rationale. `trustAnchor` is bound earlier in this same destructuring, so its
  // default (or an override) is already resolved by the time this expression runs.
  authEnvVar = loadCoordConfig(trustAnchor).codexAuthEnvVar,
} = {}) {
  const b64 = env[authEnvVar];
  if (!b64) return { wroteAuth: false, installed: false, wroteTrust: false };

  // plan 4019: validate BEFORE the write, so a garbage auth secret is refused with a named
  // reason here rather than a bare 401 three minutes later (`Buffer.from(b64, 'base64')`
  // essentially never throws, so garbage decodes "successfully" without this check). fix round
  // 2, H1 (findings 7a1326/468217/d7fb7b — three angles, one root cause): round 1 checked the
  // env value's SHAPE only, while `validateExistingAuth` below checks shape PLUS expiry — so an
  // expired-but-well-formed auth secret failed to REPLACE an expired existing file (shape
  // alone made `initialCheck.valid` for the OLD file `false`, fine) but then passed `envCheck.ok`
  // and got WRITTEN — the exact "looks fine, 401s three minutes later" outcome plan 4019 exists
  // to prevent, arrived at by a longer road. `now` is passed through so the env check applies the
  // SAME expiry rule (and the same `exp: null`-is-unknown semantics) `validateExistingAuth` does
  // — one shared helper (`authPayloadReason`, codex-auth-check.mjs), never two copies that drift.
  const envCheck = decodeAuthB64(b64, now);

  // An EXISTING file is no longer trusted blindly — the old `if (!existsSync(authPath))` gate
  // meant a sandbox whose auth.json was already truncated or torn (by anything else) skipped
  // repair forever, because the gate that would have fired never sees a file that already
  // exists. Validate whatever is there: same shape check as the env value, PLUS expiry (fix
  // round 1, G2) — shape alone let an EXPIRED but well-formed token pass as "valid" and be kept,
  // reproducing the original bug one level up (the file looks fine and codex 401s three minutes
  // later). `exp: null` (an opaque, non-JWT token) is UNKNOWN, not expired, per
  // `accessTokenExpiry`'s own contract — unknown stays unknown and is not treated as a failure.
  // Factored into a closure (rather than inlined once) because G3 below needs the exact same
  // check re-run immediately before the replacement, and a second hand-rolled copy is the exact
  // way the two would drift apart.
  function validateExistingAuth() {
    if (!existsSync(authPath)) return { valid: null, reason: null };
    let reason;
    try {
      reason = authPayloadReason(JSON.parse(readFileSync(authPath, 'utf8')), now);
    } catch (e) {
      reason = `not valid JSON (${e.message})`;
    }
    return { valid: reason == null, reason };
  }

  const initialCheck = validateExistingAuth();
  const existingValid = initialCheck.valid === true;
  if (initialCheck.valid === false) {
    logFn(
      `codex bootstrap: existing ~/.codex/auth.json failed validation (${initialCheck.reason})`,
    );
  }

  let wroteAuth = false;
  if (!existingValid) {
    // Replace ONLY when the existing file is invalid AND the env value is valid — replacing an
    // existing file unconditionally would overwrite a sandbox whose codex CLI has already
    // REFRESHED the file in place with the OLDER env copy, which is the rotation bug in reverse
    // (see the module header). A valid existing file is left alone below regardless of what the
    // env carries — the one case that was already fine (`existingValid` true) never reaches here.
    if (envCheck.ok) {
      try {
        mkdirFn(dirname(authPath), { recursive: true });
        // fix round 1, G3: re-validate the target IMMEDIATELY before the rename. Between the
        // check above and here, another process (the codex CLI itself refreshes this file in
        // place on token rotation) can have written a good login, which an unconditional
        // replace would then clobber with the older env copy. This narrows the race window, it
        // does not close it — closing it fully would need a lock this path does not justify:
        // the rename below is already atomic, so the residual worst case is one redundant
        // overwrite by an equally-valid credential, never a torn file.
        const recheck = validateExistingAuth();
        if (recheck.valid === true) {
          logFn(
            'codex bootstrap: ~/.codex/auth.json became valid since the check above ' +
              '(a concurrent refresh) — skipping the replacement to avoid clobbering it',
          );
        } else {
          // Write-then-rename so a concurrent session (or a kill mid-write) can never
          // observe a truncated auth.json — the existsSync gate above would then skip
          // repair forever (review 2665 findings 4fd69c/42c0c8). rename is atomic on
          // the same filesystem on both POSIX and NTFS.
          const tmpPath = `${authPath}.tmp-${process.pid}`;
          writeFileSync(tmpPath, Buffer.from(b64, 'base64'), { mode: 0o600 });
          renameSync(tmpPath, authPath);
          wroteAuth = true;
          logFn(
            `codex bootstrap: wrote ~/.codex/auth.json from the configured auth secret (${authEnvVar})`,
          );
        }
      } catch (e) {
        logFn(`codex bootstrap: auth decode failed (${e.message}) — continuing, codex may 401`);
      }
    } else {
      logFn(
        `codex bootstrap: ${authEnvVar} failed validation (${envCheck.reason}) — ` +
          `neither the existing auth.json nor the env value is usable; continuing, codex may 401`,
      );
    }
  }
  let installed = false;
  if (!probeFn()) {
    const install =
      installFn ??
      (() =>
        execFileSync(
          process.platform === 'win32' ? 'npm.cmd' : 'npm',
          ['install', '-g', '@openai/codex'],
          // A hung registry/DNS/lock must not hang the whole runner past the
          // documented exit-2 → /sonnet-review fallback (findings 8c86b1/b30c10).
          { timeout: 300_000, stdio: 'pipe' },
        ));
    try {
      install();
      installed = true;
      logFn('codex bootstrap: installed @openai/codex globally');
    } catch (e) {
      logFn(`codex bootstrap: npm install -g @openai/codex failed (${e.message})`);
    }
  }
  // plan 3380: seed project trust LAST — it is the only step that is useless without a
  // working codex, and keeping it after the install means a bootstrap that fails to install
  // still leaves no stray config behind.
  const { wroteTrust } = trustFn({ env, logFn, trustAnchor, authEnvVar });
  return { wroteAuth, installed, wroteTrust };
}

// resolveCodexBin() answers "which binary name to spawn", not "is it runnable" —
// on non-win32 it unconditionally returns 'codex'. This probes actual runnability
// (the signal the bootstrap's install step needs in a fresh cloud sandbox).
// shell:true on win32: Node refuses to execFile a .cmd shim directly (EINVAL),
// which misread an installed CLI as absent (finding 022e16). timeout: a wedged
// first-run wrapper must not hang the bootstrap (finding db3cca).
function codexAvailable() {
  const bin = resolveCodexBin();
  if (!bin) return false;
  try {
    execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30_000,
      shell: process.platform === 'win32',
    });
    return true;
  } catch {
    return false;
  }
}

// plan 3637 — render an exit code for a human, keeping the SIGNAL case honest.
// `waitForExit` reports a signal death as `code: null` (Node emits close with a null
// code and the signal name, which waitForExit does not carry), so a bare `${code}`
// would read "null" — the one shape a reader is most likely to misfile as a missing
// value rather than as a killed process.
//
// The phrasing is a dash rather than parentheses so it reads correctly in ALL THREE
// slots that use it, the third of which is already parenthesised:
//   `codex exit null — killed by signal`
//   `exit null — killed by signal`
//   `no output file (rc=null — killed by signal)`
//
// Review round 1 (findings 845458 / 79c886 / ebd813 / 7a9483 et al., 8 angles on the
// same root cause): "code === null" alone does NOT mean a signal death. waitForExit
// resolves `{ code: null, error }` for an ASYNC SPAWN failure too (kill-tree.mjs's own
// doc comment says so), and the liveness probe's kill (plan 3966, replacing the old
// fixed-timeout kill) sends the child into a null code as well. Both are disambiguated
// at the ONE call site that could confuse them — the log line below is guarded on
// `!error && !dead` — rather than by widening this renderer, which has no access to
// either fact. Exported for the test that pins it.
export function describeExit(code) {
  return code === null || code === undefined ? 'null — killed by signal' : String(code);
}

// ─── plan 3966 — the liveness probe that replaced the fixed wall-clock kill ──
// See the file header for the ruling and the evidence table this is built on.
// `LIVENESS_START_AFTER_S`/`LIVENESS_WINDOW_S` are exported so a test and a
// reader can both cite them rather than re-typing the numbers.
export const LIVENESS_START_AFTER_S = 1800; // 30 minutes — the ruling's "generous period"
// windowS: 600 (ten minutes of silence after the half-hour mark) is a SPEC-PASS
// default, not an operator ruling — chosen against T0's measured worst-case
// healthy gap of 83 s (stdout+stderr, one real 301 s finder call), 7.2x headroom.
export const LIVENESS_WINDOW_S = 600;

// The probe's clock is MONOTONIC, never `Date.now()` (review round 1, findings
// 6071d1 / 3861b7). Every number this probe compares is a DURATION, and
// `Date.now()` is wall-clock: an NTP correction, a DST shift or a manual clock
// set jumps it, and a forward jump alone can satisfy both thresholds and kill a
// perfectly healthy call, while a backward jump postpones killing a genuinely
// dead one. `process.hrtime.bigint()` cannot jump. Injectable so the tests can
// drive the condition at exact fake instants instead of sleeping.
function defaultMonotonicNowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

// armLivenessProbe({ child, startAfterS, windowS, tickMs, onDead, nowMs })
//   -> { bump(), disarm(), tick() }
//
// Shared by runCodex and runClaudeArm (one helper, not two copies). `bump()` is
// called from each function's existing stdout/stderr `data` listeners — the ones
// that already accumulate the call's output — so only real child output counts
// as progress; the runner's own polling never bumps it. A repeating tick (every
// `tickMs`, derived from `windowS` when not given so a seconds-scale test still
// has resolution) kills the process tree the instant BOTH hold: the call has run
// at least `startAfterS + windowS` in total, AND no progress has been seen for a
// full `windowS`. That conjunction is what makes a slow-but-progressing call
// immune at any wall time, a call that goes silent after the start mark die
// after exactly one window from its last output, and a call that goes silent
// before the start mark survive until the mark plus one window — never earlier.
// `disarm()` clears the timer (called wherever the old `clearTimeout(timer)` ran,
// right after `waitForExit`); the timer is `unref()`'d so a finished child never
// keeps the runner process alive on its own.
//
// `tick()` runs ONE evaluation and is what the interval calls. It is returned so
// a test can drive the predicate deterministically against an injected `nowMs`
// rather than asserting on real elapsed time — the flake class that made three
// of this round's findings (6d074e / b766cb / c9f6f7) and that the repo has
// measured before on this very battery (CLAUDE.md § Conventions).
//
// `onDead({ childAlreadyExited })` reports whether the child had ALREADY exited
// when the condition fired, so the caller can withhold the `dead` LABEL from a
// child that exited on its own — its own exit code is the truthful outcome, not
// "dead". The tick deliberately does NOT bail out on an exited child (an earlier
// draft of this probe did), because bailing means never disarming and never
// reporting anything at all.
//
// What this probe CANNOT do, stated plainly so the next reader does not assume
// otherwise (review rounds 1-2, findings 4a1f17 then a42a1d / af37e0 / d1c4fc /
// cbb84e / ae23a2 / 2ae76b / 5fe9e8 — seven angles on one root cause, and the
// correction of round 1's own reasoning): when the direct child has already
// exited while a GRANDCHILD inherits its stdout/stderr and holds them open,
// nothing here can release that tree. `waitForExit` resolves on 'close', not
// 'exit', so it stays pending; and `killProcessTree(child)` is a documented
// no-op on an exited root (`kill-tree.mjs:375`) — a guard `force: true`
// deliberately does not relax, because a pid the OS may have recycled must
// never be signalled. Once the direct child is gone its descendants have been
// re-parented away, so its pid no longer reaches them by any tree walk either.
//
// That exposure is PRE-EXISTING and unchanged by this plan: the fixed 900s
// timeout this probe replaced called the very same `killProcessTree(child)` and
// no-opped identically in exactly this case. Round 1 of this plan's review
// asserted the opposite ("a hang the old fixed timeout did not have") and that
// claim was wrong. Fixing it for real means changing the `waitForExit` /
// `killProcessTree` contract in `kill-tree.mjs`, a seam the land spine shares
// with `run-land-tests` and `queued-run` — out of this plan's file surface and a
// different risk class — so it is recorded in `docs/handoff/infra-debt.md`
// rather than fixed here: the entry is
// `codex-child-that-exits-while-a-grandchild-holds-its-stdio-hangs-gpt-review-forever`,
// filed on master at `19634957a3` (round 3 finding 1eaa68 correctly noted that
// this pointer named no findable entry while the line sat on master and not yet
// in this branch's own tree — hence the sha and the slug, so it is checkable
// either way). The kill call below is kept as honest best effort: it releases a
// still-running child, and is a harmless no-op otherwise.
export function armLivenessProbe({
  child,
  startAfterS = LIVENESS_START_AFTER_S,
  windowS = LIVENESS_WINDOW_S,
  tickMs = Math.min(30_000, Math.max(100, Math.round((windowS * 1000) / 10))),
  onDead,
  nowMs = defaultMonotonicNowMs,
}) {
  const start = nowMs();
  let lastProgressAt = start;
  let fired = false;
  const tick = () => {
    if (fired) return;
    const now = nowMs();
    if (now - start >= (startAfterS + windowS) * 1000 && now - lastProgressAt >= windowS * 1000) {
      fired = true;
      clearInterval(timer);
      onDead({
        childAlreadyExited: Boolean(
          child && (child.exitCode !== null || child.signalCode !== null),
        ),
      });
    }
  };
  const timer = setInterval(tick, tickMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    bump() {
      lastProgressAt = nowMs();
    },
    disarm() {
      fired = true;
      clearInterval(timer);
    },
    tick,
  };
}

// plan 4019 fix round 1, G1: the ONE place `runCodex` folds a codex failure's transcript into a
// named class — called from BOTH non-zero-exit return sites below, so a third one can never drift
// away from the classifier the way the first attempt did (five review angles, keys fa2c93/5c2bd1/
// 2bcec7/556147/c9f9eb, all found the same root cause: the classifier was wired only into the
// `code !== 0` branch reached AFTER the no-output-file branch already returned, and the no-output
// shape is the PRIMARY one — measured, every rc=1 401/usage-limit failure in the 3982 incident
// produced no output file at all). `code` alone never discriminates: codex returns rc=1 for auth,
// quota and bad-args alike, so both captured streams are the classifier's input. Only the two
// classes that are genuinely actionable (`usage-limit`/`token-rotten`) are folded into a suffix —
// the generic `transport` class returns an empty suffix so the existing exact-match `error: "exit
// N"` / `"no output file (rc=N)"` strings (and every caller/test pinned to them) are untouched.
function classifyCodexFailure(stderr, stdout, code) {
  const cls = codexFailureClass(`${stderr}\n${stdout}`, code);
  const suffix =
    cls.class === 'usage-limit'
      ? ` [usage-limit${cls.reportedResetAt ? `, reported reset ${cls.reportedResetAt}` : ''}]`
      : cls.class === 'token-rotten'
        ? ' [token-rotten]'
        : '';
  return { failureClass: cls.class, failureClassReportedResetAt: cls.reportedResetAt, suffix };
}

// One codex call: spawn, feed the prompt on stdin, watch it via a liveness
// probe (armLivenessProbe, above — no fixed wall-clock kill since plan 3966),
// parse tokens-used, read the --output-schema JSON. Returns { data, tokens,
// wallS } on success or { error, tokens?, wallS, tail? }.
// Exported since plan 3279 — the copy-review lane needs the identical transport
// (same argv, same read-only sandbox, same liveness probe, same "never throws"
// contract); copying ~70 lines of process handling into a sibling is exactly the
// fork the "reuse, don't fork" instruction rules out.
export async function runCodex({
  codexBin,
  model,
  prompt,
  schemaPath,
  outFile,
  cwd,
  // Passing a falsy `liveness` disables the probe entirely — the seam the
  // fake-codex test harness uses. Defaults to the two exported constants.
  liveness = { startAfterS: LIVENESS_START_AFTER_S, windowS: LIVENESS_WINDOW_S },
}) {
  const t0 = Date.now();
  const args = [
    'exec',
    '-m',
    model,
    '-s',
    'read-only',
    '-c',
    `model_reasoning_effort="${EFFORT}"`,
    // plan 3380: cloud-only, and a no-op array on a local machine (see codexHookTrustArgs).
    // Without these the finders run with hook-driven context injection SILENTLY dark — which
    // is how the cloud lane had been reviewing since plan 2665. `cwd` (the repo under review)
    // is passed through so codexHookTrustArgs' own default resolves the configured codex-auth
    // env var name for THIS repo (plan 3958 review, key 10k7z8u) rather than a neutral literal.
    ...codexHookTrustArgs(process.env, cwd),
    '--output-schema',
    schemaPath,
    '-o',
    outFile,
    '-',
  ];
  // Delete any output file a PREVIOUS call left at this path before spawning. Tags are stable
  // across runs, so on a resume the raw file from an earlier attempt is still sitting there — and
  // a call that exits non-zero without timing out then passes the existsSync check below and gets
  // its predecessor's JSON parsed and checkpointed as this call's success. The failure is silent
  // and looks exactly like coverage.
  //
  // A FAILED unlink is fatal, not best-effort. Swallowing it (the first version of this guard did)
  // leaves the exact hole the guard exists to close, only now behind a comment claiming it is
  // closed — and a locked or permission-denied file is precisely when a subsequent call is most
  // likely to fail without replacing it. `recursive` covers the pathological case of a DIRECTORY
  // sitting at the output path, which a plain unlink would refuse forever.
  // NOT `recursive`: this path is a FILE by construction, and a recursive force-delete pointed at
  // a generated path is a tree-deleting primitive nobody asked for. If a directory somehow sits
  // here, the unlink fails and the call errors out — which is exactly the outcome wanted.
  try {
    rmSync(outFile, { force: true });
  } catch (e) {
    return { error: `stale output not removable: ${e.message}`, wallS: 0 };
  }
  if (existsSync(outFile)) return { error: 'stale output still present after removal', wallS: 0 };
  let child;
  try {
    child = spawnWithTreeKill(codexBin, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    return { error: `spawn: ${e.message}`, wallS: 0 };
  }
  // plan 3369, task 1: stdout and stderr are now captured SEPARATELY (they used to be merged
  // into one `stdout` buffer) so a failed finder's stderr can be persisted verbatim rather than
  // interleaved with whatever codex wrote to stdout — the root cause the debt entries name
  // (docs/handoff/infra-debt.md gpt-review-9-of-11-codex-finders-fail-no-output-file and its two
  // corroborating sightings: "stderr of the codex exec child is not persisted on failure").
  // `tokens` is still parsed from the COMBINED text, matching the pre-3369 behaviour exactly —
  // codex's own "tokens used" trailer has been observed on either stream and this file has never
  // had to distinguish which.
  //
  // plan 3369 fix round 1 (0d4d1b): every error return below now carries BOTH streams in
  // full — `stderr` AND `stdout` (previously only a 500-char `tail` of stdout, and only on the
  // "no output file" branch). "Separately captured" (task 1's own fix) is not the same claim as
  // "the actionable explanation always lands on stderr" — a real failure was observed writing
  // its diagnosis to stdout while stderr carried only a generic "exit 1", so callFinderAngle
  // (below) must have BOTH to build a complete diagnostic, never pick one stream and drop the
  // other.
  let stdout = '';
  let stderr = '';
  let dead = false;
  const probe = liveness
    ? armLivenessProbe({
        child,
        startAfterS: liveness.startAfterS,
        windowS: liveness.windowS,
        tickMs: liveness.tickMs,
        // Best-effort kill: it releases a still-running child, and is a
        // documented no-op on one that already exited (see armLivenessProbe's
        // "what this probe CANNOT do" note — that descendant-held-stdio hang is
        // pre-existing and tracked in infra-debt, not fixed here). The `dead`
        // LABEL is the part that matters: an already-exited child reports its
        // own exit code, never 'dead'.
        onDead: ({ childAlreadyExited }) => {
          if (!childAlreadyExited) dead = true;
          killProcessTree(child);
        },
      })
    : null;
  child.stdout?.on('data', (d) => {
    stdout += d;
    probe?.bump();
  });
  child.stderr?.on('data', (d) => {
    stderr += d;
    probe?.bump();
  });
  // stdin errors arrive as an async 'error' EVENT (EPIPE when the process died
  // instantly) — without a listener Node escalates it to an uncaught exception
  // that kills the whole run; waitForExit below reports the process failure.
  child.stdin?.on('error', () => {});
  try {
    child.stdin.write(prompt);
    child.stdin.end();
  } catch {
    /* synchronous throw when stdin is already destroyed — waitForExit below reports it */
  }
  const { code, error } = await waitForExit(child);
  probe?.disarm();
  const wallS = Math.round((Date.now() - t0) / 1000);
  // plan 3637, the instrumentation half: `code` now rides EVERY return (it used to be
  // readable only from the interpolated "no output file (rc=…)" string, and not at all
  // on any other path), and a non-zero exit gets one log line wherever it happens. Both
  // exist so the rule chosen below can be re-judged later against what codex actually
  // returned in production, rather than re-derived from a code reading.
  //
  // The guard is `!error && !dead`, not a bare `code !== 0` (review round 1, findings
  // 845458 / ac65a4 / 45ab22 / 4c4b58 / 883e81 / 79c886 / ebd813 / 7a9483 — eight angles on
  // one root cause). waitForExit returns `code: null` for THREE different things: a signal
  // death, an async spawn failure (ENOENT/EACCES on codexBin — kill-tree.mjs documents this
  // explicitly), and the liveness probe's own kill (plan 3966, replacing the old fixed-timeout
  // kill this guard originally excluded). Logging on `code !== 0` alone fired before the
  // `if (error)` and `if (dead)` branches below, so a missing binary announced itself as
  // `codex exit null — killed by signal` and sent the reader off after an OOM killer.
  // Excluding both leaves exactly the case this line is for — the child ran, and exited
  // badly on its own — and costs no coverage: those two paths return `spawn: …` and
  // `dead`, which say more than this line ever could, and `code` still rides both returns.
  if (!error && !dead && code !== 0) log(`codex exit ${describeExit(code)}`);
  if (error)
    return {
      error: `spawn: ${error.message}`,
      code,
      stderr: stderr || undefined,
      stdout: stdout || undefined,
      wallS,
    };
  if (dead)
    return {
      error: 'dead',
      code,
      stderr: stderr || undefined,
      stdout: stdout || undefined,
      wallS,
    };
  const tokens = parseTokensUsed(stdout + stderr);
  if (!existsSync(outFile)) {
    // fix round 1, G1: this is the PRIMARY failure shape the classifier exists for — measured,
    // every rc=1 401/usage-limit failure in the 3982 incident produced no output file, and the
    // classifier was originally wired only into the `code !== 0` branch below, which this early
    // return never reaches (five review angles, one root cause). Classified only when the exit
    // was actually non-zero: `code === 0` with no output file is its own known-benign shape
    // (measured: `-o` pointing into a directory that does not exist) and classifying a clean
    // exit would be meaningless.
    //
    // fix round 2, H6 (finding 5af7ea): `code !== 0` is also true when `code === null` — a
    // signal death from OUTSIDE our own watchdog (an OOM kill, an operator `taskkill`; the
    // liveness probe's own kill and a spawn failure are already excluded above via `dead` and
    // `error`). That transcript can legitimately contain "401" or a usage-limit marker left over
    // from whatever the child was doing when it died, which then invented a `[token-rotten]` /
    // `[usage-limit]` class for a process nobody asked to classify — sending the reader toward
    // re-minting or waiting instead of diagnosing why the process was killed. A signal death gets
    // NO class: `describeExit` already renders it honestly as "killed by signal", and "we do not
    // know why" is the correct answer here, not a guessed one. `code === null` means a signal
    // death and carries no transcript to classify — the identical guard sits at the OTHER
    // non-zero-exit return site below (fix round 3, J2); a later reader must not "simplify"
    // either one back to a bare `code !== 0`.
    const cls = code !== 0 && code !== null ? classifyCodexFailure(stderr, stdout, code) : null;
    return {
      // Review round 1 (findings 117e00 / 6eb952 / fabdc8 / ba25d3 / a54e23 / 0676f1, six
      // angles): this message interpolated the raw `code`, so the SAME signal death the new
      // renderer exists for read as `no output file (rc=null)` one branch over — the exact
      // "null reads as a missing value" misfiling, left standing in the branch a killed
      // child is most likely to reach. callFinderAngle persists this string into the
      // per-finder artifact and the retry summary, so the ambiguity was durable, not just
      // on-screen. The message's INFORMATIVE core is untouched (plan step 3) — the class is
      // ADDED as a suffix, never substituted for it.
      error: `no output file (rc=${describeExit(code)})${cls ? cls.suffix : ''}`,
      code,
      ...(cls
        ? {
            failureClass: cls.failureClass,
            failureClassReportedResetAt: cls.failureClassReportedResetAt,
          }
        : {}),
      stderr: stderr || undefined,
      stdout: stdout || undefined,
      tokens,
      wallS,
    };
  }
  // plan 3637 — the hole this plan exists to close. `code` was captured above and then
  // never consulted on the success path, so a non-zero exit that still left a
  // syntactically valid output file was returned as a SUCCESS, checkpointed as final by
  // callCachedArray, and settled into verdicts by verifyOnce. That is a pass-shaped
  // review — an angle or a verify group that silently under-reports, indistinguishable
  // from a clean one — which is the exact failure this lane fails closed on everywhere
  // else (a failed finder exits 2 rather than reading as a clean angle; a failed verify
  // group escalates rather than dropping).
  //
  // The rule is "non-zero is an error", chosen on MEASUREMENT rather than on the code
  // reading alone (codex-cli 0.152.1, gpt-5.6-luna, 2026-09-02; 14 probes, full table in
  // the plan body). Across every failure mode probed, a non-zero exit NEVER co-occurred
  // with an output file at all, let alone a complete one:
  //   rc=1  bad model id / missing --output-schema file / malformed schema / 401 auth /
  //         a -c value the API rejects          → no output file (5 probes)
  //   rc=2  an argv codex refuses to parse      → no output file (1 probe)
  // And every benign non-fatal condition the plan's risk paragraph named — the ones that
  // would turn this check into a spurious exit-2 storm — exits ZERO with a complete
  // answer: an exec denied by the read-only sandbox, a hook exiting 1 at SessionStart, at
  // Stop and at SessionEnd, and an MCP server whose command does not exist (5 probes, all
  // rc=0, file present, schema key present). So plan option 2 (allowlist benign codes) has
  // nothing to allowlist, and option 3 (validate the answer instead) was not needed to
  // replace an unreliable signal — the exit code is reliable in BOTH directions here.
  //
  // Placed AFTER the existsSync check on purpose, and that placement is the whole of the
  // widening: the far more common "died without writing anything" case keeps its strictly
  // more informative `no output file (rc=N)` message, which already carried the code. This
  // branch therefore fires only in genuinely new territory — a file exists AND the process
  // exited non-zero — which no probe reproduced and which was, until now, silently a pass.
  // (rc=0 with NO output file IS reachable — measured: `-o` pointing into a directory that
  // does not exist — and stays the existsSync branch's business, unchanged.)
  if (code !== 0) {
    // plan 4019: name the failure class instead of leaving a bare "exit N" for a human to
    // diagnose by opening finders/*.stderr.txt. Delegates to the SAME `classifyCodexFailure`
    // helper the no-output branch above uses (fix round 1, G1) — a second hand-rolled copy here
    // is exactly how a third path could drift away from the classifier again. The generic
    // `transport` class deliberately leaves `error` unchanged: "exit N" already says everything a
    // generic failure has to say, and every existing exact-match caller (and test) depends on
    // that string staying exactly `exit ${code}`.
    //
    // `reportedResetAt` is what codex PRINTED, never an authoritative schedule — measured
    // 2026-09-14, the same session that hit "try again at Oct 14th, 2026" was usable again the
    // same afternoon. Folded in as "reported reset" (not "resets") so the string never reads as a
    // promise; a caller must not treat it as "do not retry until then".
    //
    // fix round 3, J2 (findings 9d0237/bd8419/a8946f/19df10/610519 — five angles): the no-output
    // branch above got the `code !== null` exclusion in fix round 2, H6 (a signal death carries
    // no transcript worth classifying — leftover "401" or usage-limit text from whatever the
    // child was doing when it died can fabricate a `[token-rotten]`/`[usage-limit]` label). This
    // branch is the identical shape one call site over — reached whenever `code !== 0`, which is
    // true for `null` too — and had the identical gap. The ENTRY condition stays `code !== 0` on
    // purpose (a signal-killed process must still be reported as an error here, never fall
    // through to the success-parse path below just because it left a syntactically valid file
    // behind); only the CLASSIFICATION is skipped for a signal death. `code === null` means a
    // signal death and carries no transcript to classify — a later reader must not "simplify"
    // either this guard or the no-output branch's back to a bare `code !== 0`.
    const cls = code !== null ? classifyCodexFailure(stderr, stdout, code) : null;
    return {
      error: `exit ${describeExit(code)}${cls ? cls.suffix : ''}`,
      code,
      ...(cls
        ? {
            failureClass: cls.failureClass,
            failureClassReportedResetAt: cls.failureClassReportedResetAt,
          }
        : {}),
      stderr: stderr || undefined,
      stdout: stdout || undefined,
      tokens,
      wallS,
    };
  }
  try {
    const data = JSON.parse(readFileSync(outFile, 'utf8'));
    return { data, code, tokens, wallS };
  } catch (e) {
    return {
      error: `bad json: ${e.message}`,
      code,
      stderr: stderr || undefined,
      stdout: stdout || undefined,
      tokens,
      wallS,
    };
  }
}

// One `claude -p` call for the data-grounding hybrid arm: spawn via
// spawnWithTreeKill (same tree-kill parity as runCodex — a subprocess timeout
// can wedge if a grandchild holds the pipe, so tree-kill is not optional here
// either), the prompt as a positional arg (this repo's established `claude -p`
// convention — see a project-side classifier / backend/scripts/
// closure-sweep/interpret-lib.mjs — not stdin; scope-block prompts stay well
// under the Windows command-line length limit since they carry file lists +a
// short summary, never the full diff text). Read-only posture: `--allowedTools`
// is narrowed to Read/Grep/Glob plus the specific read-only `git` subcommands a
// historical (`--end-ref`) replay needs (`git show <ref>:<path>` etc.), and
// `--disallowedTools` explicitly blocks the write-capable built-ins
// (Write/Edit/MultiEdit/NotebookEdit). Claude Code has no single flag
// equivalent to codex's `-s read-only` sandbox — this is the closest the CLI
// flag surface allows, not an OS-level sandbox.
//
// ROUND 3 (post-incident): `--settings '{"disableAllHooks":true}'` — this
// repo's ESTABLISHED defense against a hook reopening a `claude -p` turn and
// clobbering its answer, home-owned by `backend/scripts/lib/claude_hooks.py`'s
// `DISABLE_HOOKS_ARGS` (~15 production extraction arms already use it against
// SessionStart/UserPromptSubmit contamination). Proven empirically (round-3
// smoke, real data). `--max-turns <N>` (CLAUDE_ARM_MAX_TURNS — see its own
// comment for why this file no longer claims the flag doesn't exist) bounds a
// runaway agentic loop, this repo's established mechanism for that too
// (lib_claude_transport.run_claude_p's `max_turns` parameter). The single
// `--output-format json` envelope and its `result` string — NOT the
// stream-json/NDJSON rework an earlier version of this file built (this repo
// already has a standard mechanism for hook suppression, so a bespoke
// multi-event parser was the wrong tool). The delimiter contract stays in the
// prompt as a cheap secondary defense (see extractDelimitedCandidatesJson's
// header comment for the PRECISE scope of what it can and cannot recover).
//
// ROUND 5 (write containment — a DIFFERENT problem from disableAllHooks
// above, do not conflate the two): the round-4 residual-risk warning ("a
// model-issued `Bash(git show:*)` call whose argument smuggles a shell
// metacharacter is a risk this flag combination does not close") turned out
// to be exactly right, and it happened for real. `--allowedTools` is a
// COMMAND-PREFIX match, not a read-only sandbox: `git show <ref>:<path> >
// somefile.json` still matches `Bash(git show:*)` and the shell redirect
// still writes — no Write/Edit tool is ever invoked, so `--disallowedTools`
// never sees it. A real run confirmed this by writing a 34MB materialized
// copy of the RETIRED monolithic seed file (the pre-sharding one CLAUDE.md
// says must never be recreated) straight into the worktree root. Its literal
// filename is deliberately NOT written here: `assert-seed-io-seam` treats any
// quoted occurrence as a direct-open and blocks the push, and adding a comment
// to the seam allowlist would weaken a gate that is doing its job.
// `--disallowedTools`
// cannot close a filesystem-level gap; the fix is filesystem containment, not
// a wider or narrower tool allowlist: the child process's cwd is now a FRESH,
// DISPOSABLE scratch directory OUTSIDE the repo (`mkdtempSync`), so whatever
// the model writes lands there and is deleted after the call, never in the
// worktree. `--add-dir <repoRoot>` restores Read/Grep/Glob access to the real
// repo from that foreign cwd (those tools sandbox by directory independently
// of the `--allowedTools` tool-name grant). Since the scratch cwd is not a
// git repository at all, a bare `git show`/`diff`/etc. would fail outright
// ("fatal: not a git repository") — so the git patterns are rewritten to
// `git -C <repoRoot> <subcommand>`, and the prompt is told to always use that
// prefix (see claudeArmPrompt's WORKING DIRECTORY paragraph); the allowlist
// bakes in the CONCRETE repoRoot path (known at call time, never user input),
// so this stays a real prefix match, not a wildcard-in-the-middle pattern the
// CLI's permission syntax doesn't support.
//
// Returns `{ envelope, wallS }` on a completed call or `{ error, wallS }` on
// any transport failure — the shape classifyClaudeArmResult() consumes.
//
// Exported (round 4) so an out-of-repo smoke harness can exercise the arm
// alone — the SAME transport main() dispatches — without spending an 11-finder
// codex fan-out per verification attempt.
export async function runClaudeArm({
  claudeBin,
  model,
  effort,
  prompt,
  repoRoot,
  env,
  // Passing a falsy `liveness` disables the probe entirely — the seam a test
  // double uses. Defaults to the two exported constants (see armLivenessProbe).
  liveness = { startAfterS: LIVENESS_START_AFTER_S, windowS: LIVENESS_WINDOW_S },
  maxTurns = CLAUDE_ARM_MAX_TURNS,
  // plan 3369, task 5: called with the spawned ChildProcess the instant spawn
  // succeeds, so a caller can tree-kill it EARLY (before the liveness probe
  // would) on a fatal codex finder failure elsewhere — see main()'s
  // finderRun.finderErrors branch. Optional and side-effect-only: every
  // existing caller (this file's own main(), the test double) omits it and
  // behaves exactly as before.
  onChild,
}) {
  const t0 = Date.now();
  let scratchDir;
  try {
    scratchDir = mkdtempSync(join(tmpdir(), 'gpt-review-claude-arm-'));
  } catch (e) {
    return { error: `scratch dir: ${e.message}`, wallS: 0 };
  }
  try {
    const args = [
      '-p',
      prompt,
      '--model',
      model,
      '--effort',
      effort,
      '--output-format',
      'json',
      '--settings',
      '{"disableAllHooks":true}', // Stop-hook suppression (proven) — NOT write containment; scratchDir above is
      '--max-turns',
      String(maxTurns),
      '--add-dir',
      repoRoot,
      // `--allowedTools` AUTO-APPROVES these; it is not a sandbox, and the
      // `Bash(git -C …:*)` patterns in particular are prefix matches, so a
      // shell redirect appended to an approved prefix still writes (that is
      // exactly how an earlier build of this arm dropped a 34 MB file into
      // the worktree). The write containment is the disposable scratch cwd
      // above plus --disallowedTools below — never this list.
      '--allowedTools',
      'Read',
      'Grep',
      'Glob',
      `Bash(git -C ${repoRoot} show:*)`,
      `Bash(git -C ${repoRoot} diff:*)`,
      `Bash(git -C ${repoRoot} log:*)`,
      `Bash(git -C ${repoRoot} grep:*)`,
      `Bash(git -C ${repoRoot} ls-files:*)`,
      `Bash(git -C ${repoRoot} blame:*)`,
      '--disallowedTools',
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
    ];
    let child;
    try {
      child = spawnWithTreeKill(claudeBin, args, {
        cwd: scratchDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      return { error: `spawn: ${e.message}`, wallS: 0 };
    }
    if (typeof onChild === 'function') onChild(child);
    let stdout = '';
    let stderr = '';
    let dead = false;
    const probe = liveness
      ? armLivenessProbe({
          child,
          startAfterS: liveness.startAfterS,
          windowS: liveness.windowS,
          tickMs: liveness.tickMs,
          // Same split as runCodex's: best-effort kill, and the 'dead' label
          // withheld when the child itself already exited.
          onDead: ({ childAlreadyExited }) => {
            if (!childAlreadyExited) dead = true;
            killProcessTree(child);
          },
        })
      : null;
    child.stdout?.on('data', (d) => {
      stdout += d;
      probe?.bump();
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
      probe?.bump();
    });
    const { code, error } = await waitForExit(child);
    probe?.disarm();
    const wallS = Math.round((Date.now() - t0) / 1000);
    if (error) return { error: `spawn: ${error.message}`, wallS };
    if (dead) return { error: 'dead', wallS };
    // Parse stdout REGARDLESS of exit code — an in-band stop condition (hitting
    // --max-turns or any other CLI-enforced cap) still writes a fully-formed
    // --output-format json envelope to stdout, WITH a non-zero
    // exit code (round-4 smoke finding: --max-turns exhaustion exits 1,
    // `subtype: "error_max_turns"`, full envelope incl. real total_cost_usd/
    // num_turns/modelUsage present). Discarding it on `code !== 0` alone — the
    // round-3 behavior — would silently lose costUsd/turns exactly on the run
    // most likely to need them reported (a real, possibly-large spend for
    // no delivered coverage). Only a stdout that ISN'T even valid JSON falls
    // back to naming the exit code (mirrors runCodex's own non-zero-exit
    // handling above: try the output first, name the exit code only if that
    // fails too).
    try {
      const envelope = JSON.parse(stdout);
      return { envelope, wallS };
    } catch (e) {
      return {
        error:
          code === 0
            ? `bad envelope json: ${e.message}`
            : `exit ${code}: ${(stderr || stdout).slice(-500)}`,
        wallS,
      };
    }
  } finally {
    // Best-effort cleanup — whatever the model wrote here (if anything) is
    // discarded, but a cleanup failure must never mask the real call result
    // above (the try/finally's return value is untouched by this).
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* best-effort — a locked/already-gone temp dir is not this call's problem */
    }
  }
}

// Fallback resolution source when the envelope carries no `modelUsage` (see
// resolveClaudeModelStamp) — `claude --version`, per the pinned policy, is the
// ONLY fallback; never a date table. Best-effort: a probe failure yields null,
// never throws (an artifact write must not fail over lost provenance).
function probeClaudeVersion(claudeBin) {
  try {
    return execFileSync(claudeBin, ['--version'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30_000,
    }).trim();
  } catch {
    return null;
  }
}

// ─── Checkpoint (resume-on-rerun) ────────────────────────────────────────────
// Checkpoint / callCached / pMap / sanitizeTag are exported since plan 3279 for the
// copy-review lane: resume-on-rerun and bounded concurrency are properties of the
// codex transport, not of code review, and a second implementation of "an errored
// call is never cached as final" is precisely the subtle divergence to avoid.

// plan 3369, task 4: move a torn (unparseable) checkpoint OUT OF THE WAY rather than
// overwriting it — `checkpoint.torn-<n>.json` beside the original, `<n>` bumped past
// whatever quarantine files already exist so a SECOND tear (or a resume that tears the
// checkpoint again before this bug's root cause — a kill mid-write — is fully gone via
// the atomic `set()` below) never clobbers the first quarantined copy. Best-effort: if
// even the rename fails (permissions, a read-only mount), fall back to deleting the torn
// file outright — either way the constructor's `this.data = {calls:{}}` default already
// covers "start fresh," so a failed quarantine degrades the DIAGNOSTIC, never the run.
// Returns the quarantine path, or null if quarantining itself failed.
export function quarantineTornCheckpoint(path) {
  const base = path.replace(/\.json$/i, '');
  let n = 1;
  let dest = `${base}.torn-${n}.json`;
  while (existsSync(dest)) {
    n++;
    dest = `${base}.torn-${n}.json`;
  }
  try {
    renameSync(path, dest);
    return dest;
  } catch {
    try {
      rmSync(path, { force: true });
    } catch {
      /* best-effort — nothing more this function can do; the caller still starts fresh */
    }
    return null;
  }
}

// plan 4071: a real 30-minute Windows run died with `EPERM: operation not permitted, rename
// '<out>\checkpoint.json.tmp.<pid>' -> '<out>\checkpoint.json'` thrown out of
// atomicWriteTextSync's renameSync. Cause: a concurrent READER of checkpoint.json — the
// `--wait` poller's own `detachedRunProgress` (readFileSync, brief but real) or an AV
// on-access scanner — holds the destination open without FILE_SHARE_DELETE for a few
// milliseconds, so Windows's MoveFileEx(REPLACE_EXISTING) fails transiently; the very next
// attempt normally succeeds. atomic-write.mjs deliberately carries no retry layer (concurrent
// writers are the caller's problem, per its own header) — this is a concurrent READER, and the
// retry belongs to this caller. Bounded and narrow: only the Windows file-lock error class
// (EPERM/EBUSY/EACCES) is retried; any other error, or exhaustion, rethrows the LAST error
// unchanged so a genuine failure still surfaces with its real message.
const PERSIST_RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const PERSIST_RETRY_ATTEMPTS = 8;
const PERSIST_RETRY_BASE_MS = 20;
const PERSIST_RETRY_MAX_MS = 300;

export class Checkpoint {
  // `_write`/`_sleep` are test seams (plan 4071) — default to the real atomic writer and the
  // real synchronous sleep so every existing call site (`new Checkpoint(path)`) is unaffected.
  constructor(path, { _write = atomicWriteTextSync, _sleep = sleepSync } = {}) {
    this.path = path;
    this._write = _write;
    this._sleep = _sleep;
    // A checkpoint is rewritten in full on every call, so an interrupt mid-write leaves truncated
    // JSON. Throwing here would abort the very resume the file exists to enable — and would keep
    // aborting, since nothing ever repairs it. Starting fresh costs a re-run of completed calls;
    // refusing to start costs the run. `set()` below now writes via temp-file + atomic rename
    // (task 4), so a NEW tear should no longer happen — this branch is the recovery for one that
    // already existed (a kill from before this plan, or a checkpoint inherited from elsewhere).
    this.data = { calls: {} };
    // plan 3369 fix round 2 (c3e304 et al.): captured at LOAD time, not read off `this.data.calls`
    // later — bindFingerprint's "unknown identity" check needs to know whether cached calls came
    // from a checkpoint FILE that existed before this process touched it (the legacy-checkpoint
    // risk the fix closes) versus calls this same in-process instance already `.set()` before its
    // own first bindFingerprint call (main() never does that — it binds before the first
    // callCached — but the unit tests below construct exactly that ordering, and it is not the
    // unknown-identity case: nothing on disk could have been computed for a different scope).
    this._loadedWithCalls = false;
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (
          parsed &&
          typeof parsed === 'object' &&
          parsed.calls &&
          typeof parsed.calls === 'object'
        ) {
          this.data = parsed;
          this._loadedWithCalls = Object.keys(parsed.calls).length > 0;
        } else log(`checkpoint at ${path} has no calls map — starting a fresh one`);
      } catch (e) {
        // plan 3369, task 4: quarantine, don't just log-and-overwrite — the torn file survives
        // (renamed aside) for post-mortem instead of being silently clobbered by the next set().
        const quarantined = quarantineTornCheckpoint(path);
        log(
          `checkpoint at ${path} is unreadable (${e.message}) — ` +
            (quarantined
              ? `quarantined to ${quarantined} and starting fresh`
              : `could not be quarantined either — starting fresh anyway`),
        );
      }
    }
  }
  get(tag) {
    const r = this.data.calls[tag];
    return r && !r.error ? r : null; // errored calls are retried, never cached as final
  }
  set(tag, result) {
    this.data.calls[tag] = result;
    this._persist();
  }
  // plan 3369, task 4 / fix round 1 (351a8f/562162/374712): the shared crash-safe
  // temp-file+fsync+rename helper (scripts/coord/atomic-write.mjs), not a fourth hand-rolled copy
  // of the same shape — it also fixes what the hand-rolled version got wrong: Node's
  // Windows renameSync does NOT replace an existing destination (374712 — the second and
  // every later write for this checkpoint hits exactly that, since checkpoint.json exists
  // after the first), and a kill mid-write left the temp file (`.tmp.<pid>`) behind forever
  // (562162) — atomicWriteTextSync cleans its own temp up on a failed write, and its rename
  // is a Windows-safe MoveFileEx replace. Shared by set() and bindFingerprint() below — both
  // write the SAME `this.data` shape, just triggered by a different mutation.
  _persist() {
    const payload = JSON.stringify(this.data, null, 1);
    for (let attempt = 1; ; attempt++) {
      try {
        this._write(this.path, payload);
        return;
      } catch (e) {
        if (!PERSIST_RETRYABLE_CODES.has(e.code) || attempt >= PERSIST_RETRY_ATTEMPTS) throw e;
        const delayMs = Math.min(PERSIST_RETRY_BASE_MS * 2 ** (attempt - 1), PERSIST_RETRY_MAX_MS);
        this._sleep(delayMs);
      }
    }
  }
  // plan 3369 fix round 1 (f2481e/c1b242/9cb459/055dc7): bind this resume to the REVIEW
  // IDENTITY it is being run for — the reviewed range plus the full path scope (explicit
  // --paths/--exclude-paths AND whichever auto-budget globs actually fired). Call once, after
  // main() knows the final scope, before the first callCached(). A checkpoint on disk computed
  // for a DIFFERENT identity is not "partially reusable" — a scope-summary or finder result
  // cached under a stable tag carries no record of what range/scope it was computed FOR, so
  // trusting it call-by-call is exactly the false-coverage class this whole plan exists to
  // close (a resumed `--paths scripts/**` run silently reusing `--paths backend/**` results).
  // The fix is coarse on purpose: a fingerprint mismatch discards EVERY cached call and starts
  // this resume fresh, loudly logged — never a silent partial reuse.
  //
  // plan 3757: `{ base, endSha }` is optional and additive — every existing caller/test that
  // calls `bindFingerprint(fp)` alone is unaffected (both default to null, same as before this
  // pair existed). See the persisted-pin comment at the bottom of this method.
  bindFingerprint(fp, { base = null, endSha = null, components = null } = {}, logFn = log) {
    const prior = this.data.fingerprint;
    const componentRecordChanged =
      components !== null &&
      JSON.stringify(this.data.identityComponents) !== JSON.stringify(components);
    // Deliberately `!==` against `fp` directly (not just "was there a prior value at all"):
    // the FIRST bind of a brand-new checkpoint (prior === undefined) must still PERSIST the
    // fingerprint to disk immediately — round-1 of this fix left it attached to `this.data`
    // in memory only, so a checkpoint that happened to receive no further `.set()` call this
    // run (an all-cached-already resume) never wrote its fingerprint at all, and a LATER
    // process invocation against the same --out read `prior === undefined` again and could
    // never detect a real mismatch. Persisting on every actual change — first bind included —
    // closes that gap.
    const changed = prior !== fp;
    // plan 3369 fix round 2 (c3e304/a84062/2ca244/34a666/2f11a3/4f1ba2): `prior === undefined`
    // is NOT always "first bind of a brand-new checkpoint" — a checkpoint written by the
    // PRE-round-1 runner (Checkpoint.set() never stamped a `fingerprint` field) reads exactly
    // the same way, and if it already holds cached calls, that is an UNKNOWN identity, not a
    // fresh one: resuming it for a different range/scope silently reused those stale results,
    // exactly the false-coverage class this whole mechanism exists to close (see the committed
    // output/reports/2766-c3-shipped-lane-replay/runs/rep0/checkpoint.json — real cached calls,
    // no fingerprint key at all). A GENUINE first bind (no fingerprint AND no calls yet) is
    // unaffected — it still just persists the fingerprint silently below.
    const mismatched = prior !== undefined && prior !== fp;
    // `this._loadedWithCalls` (set once, in the constructor, from what was on disk BEFORE this
    // process touched the file) — not a live read of `this.data.calls` — so a same-process
    // `.set()` before the FIRST bindFingerprint call (never main()'s own order, but exercised by
    // the unit tests) is not mistaken for a legacy on-disk checkpoint.
    const unknownIdentity = prior === undefined && this._loadedWithCalls;
    if (mismatched || unknownIdentity) {
      const componentChanges =
        mismatched && this.data.identityComponents && components
          ? formatIdentityComponentChanges(this.data.identityComponents, components)
          : null;
      logFn(
        mismatched
          ? `checkpoint at ${this.path} was computed for a different range/path-scope identity ` +
              `(prior=${prior} now=${fp}) — discarding ${Object.keys(this.data.calls).length} ` +
              `cached call(s) and starting this resume fresh rather than risk reporting coverage ` +
              `this run never had.` +
              (componentChanges ? ` Changed component(s): ${componentChanges}.` : '')
          : `checkpoint at ${this.path} holds ${Object.keys(this.data.calls).length} cached ` +
              `call(s) but no recorded fingerprint — an UNKNOWN identity (a legacy checkpoint ` +
              `written before this identity check existed), not a fresh one. Discarding it and ` +
              `starting this resume fresh rather than risk reporting coverage this run never had.`,
      );
      // plan 3369 fix round 3 (cc13c0): a MISMATCH — the identity genuinely changed underneath
      // this --out — must also clear the PRIOR identity's stats.json/findings.json/summary.md/
      // diff.patch/finders (clearStaleReviewArtifacts, same list every early-exit path already
      // uses). Discarding only the cached calls left those artifacts standing: if the resumed
      // run then exits 2 (a finder/transport failure) before writing a new stats.json,
      // record-review --review-stats could adopt the STALE one and stamp a PASS for a review
      // that, for this new identity, never actually ran. A mismatch already means resume is
      // impossible (every cached call is being thrown away below), so there is nothing this
      // clear could break — unlike the codex-transport exit-2 paths (deliberately NOT cleared;
      // see clearStaleReviewArtifacts's own header), a mismatch has no checkpoint-based recovery
      // to preserve. this.path's directory is always `outDir` (checkpoint.json's own parent).
      //
      // TWO corrections from the round-3 delta re-review, both on this one line:
      //   • it runs for `unknownIdentity` TOO, not `mismatched` only. Round 3 scoped it to the
      //     mismatch on the grounds that a legacy no-fingerprint checkpoint was "a distinct,
      //     narrower case" — the re-review raised the identical false-PASS risk against the
      //     legacy branch from four angles (40ff5d / 89b503 / 4de673 / 7bb04d) and is right:
      //     both branches discard every cached call, so both leave the prior run's pass-shaped
      //     stats.json standing for a later exit-2 to have record-review adopt. Same risk, same
      //     remedy — and the `if` guarded a branch both conditions had already entered anyway.
      //   • it uses the IDENTITY-RESET list, which keeps `diff.patch`. The exit-path list
      //     deleted THIS run's freshly materialized patch; see
      //     clearStaleReviewArtifactsForIdentityReset's header for why the two lists differ.
      clearStaleReviewArtifactsForIdentityReset(dirname(this.path));
      this.data = { calls: {} };
    }
    this.data.fingerprint = fp;
    this.data.identityComponents = components;
    // plan 3757: persist the (base, endSha) pair THIS run is bound to, alongside the
    // fingerprint — the resume pin `readCheckpointBasePin` reads back on a LATER process's
    // early startup, before this checkpoint is even constructed. `base` is the merge-base
    // main() actually used to build diffTargets/rangeLabel/diffText (already the pinned value
    // on a resume that adopted one — see resolveResumeMergeBase), and `endSha` is the reviewed
    // branch tip; together they are what a later resume compares its own fresh values against.
    const basePinChanged = this.data.base !== base || this.data.endSha !== endSha;
    this.data.base = base;
    this.data.endSha = endSha;
    if (changed || basePinChanged || componentRecordChanged) this._persist();
  }
}

function formatIdentityComponentChanges(prior, current) {
  const truncate = (value) => {
    const encoded = JSON.stringify(value);
    const text = encoded === undefined ? 'undefined' : encoded;
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  };
  const keys = [...new Set([...Object.keys(prior), ...Object.keys(current)])].sort();
  return keys
    .filter((key) => JSON.stringify(prior[key]) !== JSON.stringify(current[key]))
    .map((key) => `${key}: prior=${truncate(prior[key])} now=${truncate(current[key])}`)
    .join('; ');
}

// plan 3757: a fail-open reader of the resume pin recorded in `<outDir>/checkpoint.json` — the
// (base, endSha) pair `Checkpoint.bindFingerprint` persists for a run. Deliberately independent
// of the `Checkpoint` class: main() needs this BEFORE the empty-range guard, and the real
// `Checkpoint` is constructed deliberately LATE (~after that guard) precisely because a torn
// checkpoint.json used to throw there (see the constructor's own header) — this reader must
// never reintroduce that crash. ANY error at all — missing file, malformed JSON, a checkpoint
// with no base/endSha keys (every checkpoint minted before this plan) — returns null.
// plan 3757 fix round 1 (gpt-review key 721bd7): the pin is VALIDATED, never coerced. A blind
// `String(base)` turns `{}` into the non-empty string '[object Object]', which passes a
// truthiness check and is then handed to git as a merge-base — so a torn or hand-edited
// checkpoint.json could steer the reviewed range instead of being ignored. Both fields must be
// sha-SHAPED strings (git's own object-name charset, abbreviated shas included); anything else
// degrades to "no pin", which is exactly this reader's fail-open contract.
// 4 is git's own minimum abbreviation length (`core.abbrev`), 64 the width of a SHA-256 object
// name — deliberately permissive at both ends, because the job here is to reject values that are
// not object names at all ('[object Object]', '12345' as a number, free-form prose), not to
// second-guess how short a legitimately abbreviated sha may be.
const CHECKPOINT_PIN_SHA_RX = /^[0-9a-f]{4,64}$/;

function checkpointPinSha(value) {
  return typeof value === 'string' && CHECKPOINT_PIN_SHA_RX.test(value) ? value : null;
}

export function readCheckpointBasePin(outDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(outDir, 'checkpoint.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const base = checkpointPinSha(parsed.base);
    const endSha = checkpointPinSha(parsed.endSha);
    if (!base || !endSha) return null;
    return { base, endSha };
  } catch {
    return null;
  }
}

// plan 3757: the ONE decision for "should this resume ADOPT the recorded merge-base instead of
// a freshly recomputed one" — pure (no git, no fs), so it is directly unit-testable. Pinning is
// safe exactly when the reviewed tip (`endSha`) is unchanged from the recorded run: an
// upstream-only `origin/master` move is then informational, not identity-breaking, because the
// diff actually being read is still bounded by the SAME two endpoints as the recorded run. A
// changed tip must NEVER pin — that is the plan-3369 false-coverage hole this must not reopen
// (a different tip means a genuinely different diff, however the base moved).
export function resolveResumeMergeBase({ recorded, currentEndSha, freshBase }) {
  if (!recorded) {
    return { base: freshBase, pinned: false, reason: 'no recorded pin' };
  }
  if (!recorded.endSha) {
    return { base: freshBase, pinned: false, reason: 'recorded pin has no endSha' };
  }
  if (recorded.endSha !== currentEndSha) {
    return {
      base: freshBase,
      pinned: false,
      reason: 'reviewed tip changed since the recorded pin',
    };
  }
  if (!recorded.base) {
    return { base: freshBase, pinned: false, reason: 'recorded pin has no base' };
  }
  if (recorded.base === freshBase) {
    return {
      base: freshBase,
      pinned: false,
      reason: 'recorded base already matches the fresh base',
    };
  }
  return {
    base: recorded.base,
    pinned: true,
    reason: 'reviewed tip unchanged; adopting the recorded base over upstream-only drift',
  };
}

// plan 3369 fix round 2 (2a4d68/b786c7/331b91/8aed81/5f31de): resolve diffTargets down to
// concrete commit shas for fingerprinting — a literal range STRING ("origin/master...HEAD",
// "HEAD~1..HEAD") is a stable LABEL whose resolved commits move as refs advance, so hashing the
// label alone let an interrupted-then-resumed run silently reuse cached results for a DIFFERENT
// diff after a fetch/rebase/new commit (the same false-coverage class the checkpoint-fingerprint
// mechanism as a whole exists to close). The default path's diffTargets are already a resolved
// (mergeBase, headSha) PAIR — this only does real work for an explicit --range/--end-ref, where
// diffTargets is a single range-STRING element. Never throws: main() has already used these same
// refs successfully to materialize the diff moments earlier, so a NEW resolution failure here is
// exactly a ref moving mid-run, not a broken repo.
//
// plan 3369 fix round 3 (ad5632/da8bc1): round 2 degraded a failed rev-parse to the RAW REF
// TEXT — but that made a resolution FAILURE itself a STABLE identity. If the same ref fails to
// resolve on both the original run and a later resume (the exact shape a moved-then-deleted ref
// or a recurring transient git error produces), the fingerprint was UNCHANGED and the whole
// moved-ref invalidation this mechanism exists for was silently defeated — "I could not resolve
// this" was being read back as "this did not move". Fixed by minting an ALWAYS-DISTINCT marker
// on every failure (never the raw ref, never derived only from it) — one run's failure can never
// equal ANY other run's, this run's own retry included, so `bindFingerprint` treats it as a
// mismatch every single time a resolution fails, which is the safe direction (a spurious
// re-review costs a re-run; a false match costs reporting on the wrong diff). Logged via `logFn`
// (defaulting to this module's own `log`) so a human sees the degraded resolution rather than a
// silent pass-through.
export function resolveDiffTargetShas(
  diffTargets,
  repoRoot,
  runGit = (args) =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: GIT_MAXBUFFER }),
  logFn = log,
) {
  const shas = [];
  for (const target of diffTargets) {
    const refs = String(target)
      .split(/\.\.\.|\.\./)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const ref of refs.length ? refs : [String(target)]) {
      try {
        shas.push(String(runGit(['rev-parse', ref])).trim());
      } catch (e) {
        logFn(
          `resolveDiffTargetShas: git rev-parse ${JSON.stringify(ref)} failed (${e.message}) — ` +
            `fingerprinting an always-distinct unresolved marker instead of the raw ref text, so ` +
            `a moved-then-still-unresolvable ref can never be silently read back as unmoved.`,
        );
        shas.push(`unresolved:${ref}:${randomUUID()}`);
      }
    }
  }
  return shas;
}

// plan 3369 fix round 1 (f2481e/c1b242/9cb459/055dc7), round 2 (2a4d68 et al. — `resolvedShas`),
// round 3 (6b3b47/f3ffa5 — `diffDigest`): the stable identity a checkpoint resume is bound to —
// a hash of the reviewed range's RESOLVED commits (resolveDiffTargetShas above), never the
// literal range string alone, plus the full path scope, plus a digest of the diff.patch bytes
// actually materialized. `rangeLabel`/`endRef` still ride along for a human-readable identity in
// logs. `resolvedShas` alone detects a moved ref — but for an explicit mutable range
// (`HEAD~1..HEAD`, `origin/master...HEAD`), diff.patch is written BEFORE resolveDiffTargetShas
// runs, and a ref can advance in that gap (another commit landing, the landed-range guard's own
// `git fetch`), so `resolvedShas` alone could stamp the checkpoint with a NEWER identity than the
// OLDER patch its cached results actually describe — and a later run genuinely reviewing that
// newer range could then see a matching fingerprint and wrongly reuse them. `diffDigest` closes
// that gap: it binds the identity to the bytes actually read, independent of what the refs
// happened to resolve to by the time resolution ran. Pure (no git, no fs) so it is unit-testable
// directly; sorted arrays (except `resolvedShas`, whose ORDER is meaningful — which endpoint is
// which) so key order in --paths/--exclude-paths never changes the fingerprint, only their
// CONTENT does. `diffDigest` defaults to '' — every caller that omits it still gets a fingerprint
// that is stable for identical inputs and unique across differing ones, exactly as before this
// field existed (only the literal hash VALUE shifts, which no caller or test pins).
export function reviewIdentityComponents({
  rangeLabel,
  endRef,
  resolvedShas = [],
  paths = [],
  excludePaths = [],
  autoExcludedGlobs = [],
  diffDigest = '',
}) {
  return {
    rangeLabel: rangeLabel || null,
    endRef: endRef || null,
    resolvedShas: [...resolvedShas],
    paths: [...paths].sort(),
    excludePaths: [...excludePaths].sort(),
    autoExcludedGlobs: [...autoExcludedGlobs].sort(),
    diffDigest: diffDigest || null,
  };
}

export function reviewIdentityFingerprint(inputs) {
  const canonical = JSON.stringify(reviewIdentityComponents(inputs));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// plan 3369 fix round 2 (b66790): a failed codex call retains its FULL stdout/stderr, and
// callCached persists whatever it returns to checkpoint.json — rewritten in FULL on EVERY later
// `.set()` call, for every OTHER tag too, not just this one. A verbose failure across a few
// angles could therefore make each subsequent checkpoint rewrite duplicate several MB of dead
// diagnostic text. `CHECKPOINT_DIAG_CAP_CHARS` is deliberately SMALL — this is what every future
// rewrite repeats, so nothing here needs to stay generously readable; that job belongs to the
// per-finder `.stderr.txt` file (persistFinderStderr, its own generous cap below).
export const CHECKPOINT_DIAG_CAP_CHARS = 4_000;

// Bounded head+tail with an explicit elision marker naming the omitted count — never a silent
// truncation. `capChars` splits evenly between head and tail (rounding the head down), so a
// caller reading the result sees both WHERE a diagnostic started and how it ended, which is
// usually where the actionable detail lives (an error banner up top, a stack-trace tail).
export function capDiagnosticText(text, capChars = CHECKPOINT_DIAG_CAP_CHARS) {
  if (typeof text !== 'string' || text.length <= capChars) return text;
  const head = Math.floor(capChars / 2);
  const tail = capChars - head;
  const omitted = text.length - capChars;
  return `${text.slice(0, head)}\n…[elided ${omitted} chars]…\n${text.slice(text.length - tail)}`;
}

// A codex call that TRANSPORTED fine but answered with the wrong SHAPE is a failed call, and it
// has to be turned into one BEFORE `callCached` sees it. `Checkpoint.get` refuses to serve an
// entry carrying `.error`, which is the single mechanism every retry and every documented
// same-`--out` resume rides on; a result validated only AFTER `callCached` is persisted as a
// SUCCESS, so the malformed payload is replayed on every later attempt and a transient
// wrong-shape response becomes permanent for that output directory (found by the plan-3508
// round-2 re-review, 14 findings on this one seam — the guard was correct and in the wrong place).
//
// Wrap the call, never the result — use `callCachedArray` below rather than calling this directly.
//
// "A record" means a plain object: `typeof [] === 'object'`, so an `Array.isArray` exclusion is
// load-bearing rather than pedantic. A `[[]]` element passed a bare `typeof t === 'object'` check
// and reached `renderTermsDoc`, which wrote a committed termbase row of `undefined` fields.
export function isPlainRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// `elements` is opt-in but every current caller passes it: a container check alone still lets
// `[null]` through, and the very next line in each consumer dereferences `c.file` / `v.index` /
// a term's fields — so "the array arrived" was never the property any of them actually needed.
export function requireArrayPayload(result, field, { elements = false } = {}) {
  // A checkpoint can hold a JSON value that is not an object at all (hand-edited, or written by a
  // different tool). It has no `.error`, so `Checkpoint.get` serves it, and returning it unchanged
  // hands the caller something whose `.data` dereference throws.
  if (!isPlainRecord(result))
    return {
      error: `unusable cached result: expected an object, received ${result === null ? 'null' : typeof result}`,
    };
  if (result.error) return result;
  const value = result.data?.[field];
  if (!Array.isArray(value)) {
    const received = value === null ? 'null' : typeof value;
    return { ...result, error: `invalid ${field} payload: expected array, received ${received}` };
  }
  if (elements && !value.every(isPlainRecord))
    return { ...result, error: `invalid ${field} payload: every entry must be an object` };
  return result;
}

// The cached-call seam for every codex call whose payload is an ARRAY, validating on BOTH sides of
// the cache — which is the whole point, and why this is one function rather than a convention:
//   - INSIDE, so a fresh malformed answer is checkpointed as an error and stays retryable;
//   - OUTSIDE, because a checkpoint written by an EARLIER version of this file (or by hand) can
//     still hold a malformed payload with no `error`, and serving that back unchecked is exactly
//     the `for (const v of r.data.verdicts)` throw the inner guard was added to prevent.
// Both are cheap: `requireArrayPayload` is pure and returns its input unchanged on the happy path.
//
// The outer check also REWRITES the entry when it fires. Detecting a malformed cached success and
// only returning an in-memory error would leave the bad entry on disk, so `callCached` would keep
// serving it and every later run would recompute the same error without ever calling the model —
// the exact permanent wedge the inner check exists to prevent, just reached from a legacy
// checkpoint instead of a fresh call. Persisting the error makes the next attempt a real retry.
export async function callCachedArray(ckpt, tag, field, fn, { elements = true } = {}) {
  const validate = (r) => requireArrayPayload(r, field, { elements });
  const r = validate(await callCached(ckpt, tag, async () => validate(await fn())));
  // `ckpt.get` returns null for an entry carrying `.error`, so this is true only on a cache HIT
  // that the validator just rejected — a fresh rejection was already persisted by callCached.
  if (r.error && ckpt.get(tag)) ckpt.set(tag, r);
  return r;
}

// Returns a shallow copy of `result` with any oversized `stdout`/`stderr` STRING field bounded —
// used ONLY for what gets written to checkpoint.json; the object callCached hands back to its
// immediate caller (below) is always the untouched original, so callFinderAngle can still build
// a full, generously-capped per-finder file from it. A successful call never carries these
// fields (runCodex only sets them on an error return), so this is a no-op on the common path.
function capResultForCheckpoint(result) {
  if (!result || typeof result !== 'object') return result;
  const stdoutOversized =
    typeof result.stdout === 'string' && result.stdout.length > CHECKPOINT_DIAG_CAP_CHARS;
  const stderrOversized =
    typeof result.stderr === 'string' && result.stderr.length > CHECKPOINT_DIAG_CAP_CHARS;
  if (!stdoutOversized && !stderrOversized) return result;
  const capped = { ...result };
  if (stdoutOversized) capped.stdout = capDiagnosticText(capped.stdout);
  if (stderrOversized) capped.stderr = capDiagnosticText(capped.stderr);
  return capped;
}

export async function callCached(ckpt, tag, fn) {
  const cached = ckpt.get(tag);
  if (cached) return cached;
  const result = await fn();
  ckpt.set(tag, capResultForCheckpoint(result));
  return result;
}

// Bounded-concurrency map — a simple worker pool (no external dep).
export async function pMap(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function run() {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    run,
  );
  await Promise.all(workers);
  return results;
}

export function sanitizeTag(tag) {
  const safe = tag.replace(/[^A-Za-z0-9_-]+/g, '_');
  if (safe.length <= 120) return safe;
  const fullTagDigest = createHash('sha1').update(tag).digest('hex').slice(0, 8);
  return `${safe.slice(0, 120 - fullTagDigest.length - 1)}-${fullTagDigest}`;
}

function log(msg) {
  console.log(`[gpt-review] ${msg}`);
}

// ─── plan 3369, tasks 1+2 — finder stderr persistence + bounded backoff retry ──

// Task 1: persist a failed finder's captured diagnostic (runCodex's `stderr`, falling back to
// its `tail` slice of merged stdout on the "no output file" branch, falling back to the bare
// error string when neither exists) to the pinned convention
// `<out>/FINDER_STDERR_DIRNAME/<angle>.stderr.txt`. Overwrites on every failed ATTEMPT (not just
// the final one), so a resumed/retried run's file always reflects the LATEST diagnostic. Never
// throws over a write failure (a disk-full/permission blip must not mask the real call error).
//
// plan 3369 fix round 2 (b66790): this file is a HUMAN-facing artifact (unlike checkpoint.json,
// it is never re-read/re-written by this runner), so it stays genuinely useful — bounded, but
// GENEROUSLY, far above CHECKPOINT_DIAG_CAP_CHARS — with the same explicit elision marker on the
// rare truly-huge diagnostic that still exceeds it.
export const FINDER_STDERR_FILE_CAP_CHARS = 200_000;

export function persistFinderStderr(outDir, angleLabel, text) {
  try {
    const dir = join(outDir, FINDER_STDERR_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sanitizeTag(angleLabel)}.stderr.txt`);
    const body = text && text.length ? text : '(no stderr captured)\n';
    writeFileSync(file, capDiagnosticText(body, FINDER_STDERR_FILE_CAP_CHARS));
    return file;
  } catch (e) {
    log(`${angleLabel}: could not persist stderr (${e.message})`);
    return null;
  }
}

// Test-only fault injection (execution note (d)): GPT_REVIEW_FORCE_FINDER_FAIL='all' or a
// comma-list of angle labels forces THIS angle's call to fail WITHOUT ever spawning codex — so
// gpt-review.test.mjs can exercise the stderr-capture and retry-exhaustion paths with no codex
// transport and no network, per the plan's own constraint on this test suite. Nothing in a real
// invocation ever sets this env var.
export function matchesForceFail(label) {
  const spec = process.env.GPT_REVIEW_FORCE_FINDER_FAIL;
  if (!spec) return false;
  if (spec === 'all') return true;
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(label);
}

// One finder angle, ONE attempt — goes through the SAME callCached seam every other codex call
// in this file uses (an errored call is never cached as final, so a later retry round's
// callCached call for the SAME tag naturally re-attempts it; no separate "is this a retry" branch
// needed here). On failure, persists + inline-logs the diagnostic (task 1).
export async function callFinderAngle({
  ckpt,
  outDir,
  repoRoot,
  codexBin,
  scopeBlock,
  files,
  f,
  runCodexFn = runCodex,
}) {
  const prompt = finderPrompt(scopeBlock, f);
  const tag = callTag(
    `finder:${f.label}`,
    promptCallDigest({ prompt, schema: CANDIDATES_SCHEMA, model: MODEL_LUNA }),
  );
  const outFile = join(outDir, 'raw', `${sanitizeTag(tag)}.json`);
  const r = await callCachedArray(ckpt, tag, 'candidates', async () => {
    if (matchesForceFail(f.label)) {
      return {
        error: `forced failure (GPT_REVIEW_FORCE_FINDER_FAIL=${process.env.GPT_REVIEW_FORCE_FINDER_FAIL})`,
        stderr: `codex-fake: simulated failure for angle ${f.label} (test-only GPT_REVIEW_FORCE_FINDER_FAIL knob)\n`,
        wallS: 0,
      };
    }
    return runCodexFn({
      codexBin,
      model: MODEL_LUNA,
      prompt,
      schemaPath: join(outDir, 'schema-candidates.json'),
      outFile,
      cwd: repoRoot,
    });
  });
  if (r.error) {
    // plan 3369 fix round 1 (0d4d1b): BOTH streams, never a `stderr || stdout` pick — a real
    // codex failure was observed writing its actionable diagnosis to stdout while stderr
    // carried only a generic "exit 1", so a first-match-wins choice silently dropped the part
    // that mattered. `r.error` is the last resort, only when the child never captured any
    // output at all (e.g. a spawn failure before either stream existed).
    const parts = [];
    if (r.stderr) parts.push(r.stderr);
    if (r.stdout) parts.push(r.stdout);
    const diag = parts.length ? parts.join('\n') : r.error;
    const file = persistFinderStderr(outDir, f.label, String(diag));
    const head = String(diag).split(/\r?\n/).slice(0, STDERR_INLINE_LINES).join('\n');
    log(
      `${f.label}: ERROR ${r.error}` +
        (file ? ` — stderr saved to ${file}` : '') +
        (head ? `\n${head}` : ''),
    );
    return { label: f.label, error: r.error, candidates: [], tokens: r.tokens || 0 };
  }
  const cands = r.data.candidates
    .slice(0, PER_ANGLE)
    .map((c) => ({ ...c, file: canonFile(c.file, files), angle: f.label, kind: f.kind }));
  log(`${f.label}: ${cands.length} candidate(s) (${r.tokens ?? '?'} tok, ${r.wallS}s)`);
  return { label: f.label, error: null, candidates: cands, tokens: r.tokens || 0 };
}

// Task 2: up to MAX_FINDER_RETRIES retry rounds beyond the initial attempt, each preceded by
// RETRY_BACKOFF_MS[round] of backoff and run at a concurrency ONE LOWER than the previous round
// (never below 1, "the default self-lowers on a second failure wave") — contention-shaped finder
// failures (docs/handoff/infra-debt.md gpt-review-9-of-11-codex-finders-fail-no-output-file,
// corroborated on cloud FULL, third sighting) do not reliably clear within the single retry this
// runner had before. A finder still failing after every round lands in the returned
// `finderErrors` (`"<angle>: <error>"`, matching the pre-3369 message shape) — the caller
// (main()) turns a non-empty list into the existing untrusted exit 2, never a pass-shaped record.
//
// Per-angle `status` (ok | failed | retried-ok | retried-failed — the stats.json shape task 1
// adds) is returned alongside the candidates. `failed`/`retried-failed` can only appear on THIS
// return value — a finderErrors-non-empty run never reaches the stats.json write (unchanged
// plan-3193 "never a false-clean review" contract), so a written stats.json only ever shows
// ok/retried-ok.
//
// `runCodexFn`/`sleepFn` are injected (default the real runCodex / a real setTimeout-based delay)
// so this is unit-testable at full retry depth with NO real time elapsed and NO codex transport —
// matching this test file's stated philosophy of never spawning a real codex subprocess.
export async function runFindersWithRetry({
  ckpt,
  outDir,
  repoRoot,
  codexBin,
  scopeBlock,
  files,
  concurrency,
  runCodexFn = runCodex,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  finders = FINDERS,
}) {
  const statusByLabel = {};
  const resultsByLabel = {};
  const lastErrorByLabel = {};
  let pending = finders;
  let round = 0;
  let finalFailed = [];
  for (;;) {
    const roundConcurrency = Math.max(1, concurrency - round);
    const outs = await pMap(
      pending,
      (f) =>
        callFinderAngle({ ckpt, outDir, repoRoot, codexBin, scopeBlock, files, f, runCodexFn }),
      roundConcurrency,
    );
    const stillFailing = [];
    outs.forEach((r, i) => {
      const f = pending[i];
      if (r.error) {
        stillFailing.push(f);
        lastErrorByLabel[f.label] = r.error;
      } else {
        resultsByLabel[f.label] = { candidates: r.candidates, tokens: r.tokens || 0 };
        statusByLabel[f.label] = round === 0 ? 'ok' : 'retried-ok';
      }
    });
    if (stillFailing.length === 0) break;
    if (round >= MAX_FINDER_RETRIES) {
      for (const f of stillFailing)
        statusByLabel[f.label] = round === 0 ? 'failed' : 'retried-failed';
      finalFailed = stillFailing.map((f) => `${f.label}: ${lastErrorByLabel[f.label]}`);
      break;
    }
    log(
      `${stillFailing.length} finder(s) failed (round ${round + 1}/${MAX_FINDER_RETRIES}) — ` +
        `retrying ${stillFailing.map((f) => f.label).join(', ')} in ${RETRY_BACKOFF_MS[round]}ms ` +
        `at concurrency ${Math.max(1, concurrency - round - 1)}`,
    );
    await sleepFn(RETRY_BACKOFF_MS[round]);
    pending = stillFailing;
    round++;
  }
  const candidates = [];
  let tokensTotal = 0;
  for (const f of finders) {
    const r = resultsByLabel[f.label];
    if (r) {
      candidates.push(...r.candidates);
      tokensTotal += r.tokens;
    }
  }
  const angleStatus = finders.map((f) => ({
    angle: f.label,
    status: statusByLabel[f.label] || 'failed',
  }));
  return { candidates, finderErrors: finalFailed, angleStatus, tokens: tokensTotal };
}

// ─── Verify (round 1 Luna → escalate REFUTED/failed to round 2 Sol) ─────────
async function verifyOnce(
  ckpt,
  outDir,
  repoRoot,
  codexBin,
  scopeBlock,
  candidates,
  {
    model,
    tagPrefix,
    tokenBucket,
    concurrency,
    promptFn = groupVerifierPrompt,
    // plan 3623 item 1 fix-A: a SEAM, exactly like `promptFn` above, not a hardcoded import.
    // The digest IS the checkpoint cache key, and `schema-verdict.json` on disk (what
    // `runCodex` below actually hands the model) is written by `verifyGroups` — the ONE seam
    // that owns this file (plan 3623 finding 7f43f4) — from this SAME value, before round 1, so
    // the digest and the file on disk can never disagree. Defaults to GROUP_VERDICT_SCHEMA so
    // every existing (code-review) caller stays byte-identical.
    schema = GROUP_VERDICT_SCHEMA,
  },
) {
  const groups = groupByLoc(candidates);
  const outs = await pMap(
    groups,
    async (g) => {
      const prompt = promptFn(scopeBlock, g);
      // Deliberately per group: hashing a few KB is negligible beside a model call, and the
      // candidate payload is part of what was asked, so a run-level digest cannot cover it.
      const tag = callTag(
        `${tagPrefix}:${locKey(g[0])}`,
        promptCallDigest({ prompt, schema, model }),
      );
      const outFile = join(outDir, 'raw', `${sanitizeTag(tag)}.json`);
      const schemaPath = join(outDir, 'schema-verdict.json');
      const r = await callCachedArray(ckpt, tag, 'verdicts', () =>
        runCodex({ codexBin, model, prompt, schemaPath, outFile, cwd: repoRoot }),
      );
      if (r.error) {
        log(`${tag}: ERROR ${r.error} — escalating whole group rather than dropping`);
        return g.map((c) => ({ ...c, __needsEscalation: true }));
      }
      tokenBucket.total += r.tokens || 0;
      const byIdx = {};
      for (const v of r.data.verdicts) {
        // The container being an array says nothing about its ELEMENTS: a `null` entry would
        // throw on `v.index` and reject the whole verification instead of escalating.
        if (!v || typeof v !== 'object') continue;
        if (!Number.isInteger(v.index) || v.index < 0 || v.index >= g.length) continue;
        // FIRST verdict per index wins. A response repeating an index is malformed, and letting
        // the last one overwrite let an arbitrary verdict settle a candidate; the candidate whose
        // index the duplicate displaced simply has no verdict and escalates below, which is the
        // same safe path a missing index already takes.
        if (byIdx[v.index] === undefined) byIdx[v.index] = v;
      }
      return g.map((c, i) =>
        byIdx[i]
          ? {
              ...c,
              verdict: byIdx[i].verdict,
              evidence: byIdx[i].evidence,
              preExisting: byIdx[i].preExisting,
              preExistingWhy: byIdx[i].preExistingWhy,
              blocksLand: byIdx[i].blocksLand,
              blocksLandWhy: byIdx[i].blocksLandWhy,
            }
          : { ...c, __needsEscalation: true },
      );
    },
    concurrency,
  );
  // groupCount is the single source for the round's agent count — callers must
  // not re-derive it via groupByLoc (a key-logic change would silently desync).
  return { candidates: outs.flat(), groupCount: groups.length };
}

// The escalate-on-refute ladder: round 1 Luna over each (file,line) group, then any
// REFUTED-or-failed group re-judged by Sol, REFUTED-again dropped, still-unresolved kept
// as UNVERIFIED. Exported since plan 3279 — the copy-review lane runs the SAME ladder over
// translation rows, and re-implementing it would be a second place for "a failed verify
// call escalates rather than drops" to silently diverge. `promptFn` is one seam that lane
// needs; `schema` (plan 3623 item 1 fix-A) is the other — both default to the code-review
// values, so every existing caller stays byte-identical.
export async function verifyGroups(
  ckpt,
  outDir,
  repoRoot,
  codexBin,
  scopeBlock,
  candidates,
  tokens,
  concurrency,
  { promptFn = groupVerifierPrompt, schema = GROUP_VERDICT_SCHEMA } = {},
) {
  // plan 3623 finding 7f43f4: this seam OWNS schema-verdict.json — write it ONCE here, from the
  // exact `schema` value verifyOnce digests into the checkpoint cache key, before either round
  // runs (round 1 and round 2 share the file). A caller must not also hand-roll its own write of
  // this path: two writers of the same file is exactly how the digest and the on-disk contract
  // drifted apart before this fix (copy-review.mjs wrote its own copy; a caller that forgot to
  // would get a digest that didn't match what codex was actually shown).
  writeFileSync(join(outDir, 'schema-verdict.json'), JSON.stringify(schema, null, 2));
  const round1 = await verifyOnce(ckpt, outDir, repoRoot, codexBin, scopeBlock, candidates, {
    model: MODEL_LUNA,
    tagPrefix: 'verify',
    tokenBucket: tokens.verify,
    concurrency,
    promptFn,
    schema,
  });
  const verifierAgents = round1.groupCount;
  const { settled, toEscalate } = classifyRound1(round1.candidates);
  if (toEscalate.length === 0)
    return { kept: settled, refuted: [], stats: { verifierAgents, escalated: 0 } };
  log(`escalating ${toEscalate.length} candidate(s) to Sol`);
  const stripped = toEscalate.map(({ __needsEscalation, verdict, evidence, ...rest }) => rest);
  const round2 = await verifyOnce(ckpt, outDir, repoRoot, codexBin, scopeBlock, stripped, {
    model: MODEL_SOL,
    tagPrefix: 'adjudicate',
    tokenBucket: tokens.adjudicate,
    concurrency,
    promptFn,
    schema,
  });
  const { kept: kept2, refuted } = classifyRound2(round2.candidates);
  return {
    kept: settled.concat(kept2),
    refuted,
    stats: { verifierAgents, escalated: round2.groupCount },
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
// The spec handed to the ONE shared value-aware flag parser (plan 1769/1777). Not a
// hand-rolled loop: this file grew one in plan-3193 round 5 and the round-6 reuse finding
// was right — `requireValues` (plan 2734) and the loud unknown-flag throw are exactly the
// two refusals that round wanted, already written and already tested there.
//
// Both refusals matter here specifically because of `--repo`: a mistyped `--rep <path>` or
// a valueless `--repo` would otherwise leave repo unset and send the review at the CWD's
// checkout instead of the one the caller named — the silent-wrong-target failure this whole
// plan exists to stop, reached by a typo rather than a wrong cwd.
export const ARG_SPEC = {
  label: 'gpt-review',
  value: ['range', 'end-ref', 'concurrency', 'out', 'repo', 'paths', 'exclude-paths', 'past-cap'],
  boolean: ['no-claude-arm', 'no-gate-prep', 'detach', 'no-detach', 'status', 'wait'],
  positionals: false,
  requireValues: true,
};

// Comma-separated glob list -> array, trimmed, empties dropped. '' / undefined -> [].
function parseCsvGlobs(v) {
  return v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

// Throws (loudly, with the offending token) on an unknown flag, a positional, or a
// value-taking flag with no usable value. main() catches and exits 2 — see its call site.
export function parseArgs(argv) {
  const { flags } = parseFlags(argv, ARG_SPEC);
  const n = flags.concurrency === undefined ? NaN : parseInt(flags.concurrency, 10);
  const pastCapReason = flags['past-cap'] ?? null;
  if (pastCapReason !== null) {
    const validation = validatePastCapReason(pastCapReason);
    if (!validation.accepted) throw new Error(validation.message);
  }
  return {
    range: flags.range ?? 'origin/master...HEAD',
    // plan 2936 T2: distinguishes "the default range string" from "the caller explicitly asked
    // for this range" — main() resolves the default path to a fixed (mergeBase, headSha) PAIR
    // once, rather than handing every finder the RANGE STRING to re-resolve itself; an explicit
    // --range keeps its current string-range semantics untouched.
    rangeExplicit: flags.range !== undefined,
    endRef: flags['end-ref'] ?? null,
    // clamp to >=1 (a 0-worker pool would hang); non-numeric falls to the default
    concurrency: Number.isInteger(n) ? Math.max(1, n) : DEFAULT_CONCURRENCY,
    out: flags.out ?? null,
    // plan 3193: the checkout to review. null = the cwd's repo (the historical behaviour).
    repo: flags.repo ?? null,
    claudeArm: !flags['no-claude-arm'], // default ON (plan 2766); --no-claude-arm for A/B replays
    gatePrep: !flags['no-gate-prep'], // default ON (plan 3503); explicit opt-out for local reviews
    detachFlag: Boolean(flags.detach),
    noDetachFlag: Boolean(flags['no-detach']),
    status: Boolean(flags.status),
    wait: Boolean(flags.wait),
    // plan 3369, task 3: --paths narrows the reviewed diff to these globs; --exclude-paths drops
    // these globs ON TOP of the built-in data-tree excludes. Both default to [] (no narrowing).
    paths: parseCsvGlobs(flags.paths),
    excludePaths: parseCsvGlobs(flags['exclude-paths']),
    // Validation trims only to prove content exists. The value written to the launch ref and
    // stats.json remains exactly what the caller supplied.
    pastCapReason,
  };
}

// plan 3872: local reviews routinely exceed the harness's 600 s Bash cap, while cloud
// backgrounding is a measured session-stall class. Keep that environment policy in a pure
// decision seam so tests supply the environment rather than mutating ambient process state.
export function reviewDetachDecision({ detachFlag, noDetachFlag, remote }) {
  if (detachFlag && noDetachFlag)
    return { action: 'error', message: '--detach and --no-detach are mutually exclusive' };
  if (remote && detachFlag)
    return {
      action: 'error',
      message:
        '--detach is forbidden when CLAUDE_CODE_REMOTE is set; cloud review children must run foreground-only',
    };
  if (remote || noDetachFlag) return { action: 'foreground' };
  return { action: 'detach' };
}

export const REVIEW_WAIT_TIMEOUT_MS = 540_000;
export const REVIEW_WAIT_POLL_MS = 3_000;
export const REVIEW_LAUNCH_GRACE_MS = 60_000;

export function isClaudeCodeRemote(value) {
  return value === 'true';
}

// plan 3872: status is reconstructed only from durable artifacts and checkpoint tags; polling
// must never dispatch work or let a malformed file turn into a false success.
export function classifyRunProgress({
  checkpointCalls,
  finderCount,
  hasFindings,
  hasSummary,
  findingsFresh = hasFindings,
  pidAlive,
  pidPresent = pidAlive !== null,
  metadataPresent,
  metadataAgeMs = 0,
}) {
  // A foreground review has no detached metadata; a detached replacement only owns findings
  // written after its recorded start, so an older completed review remains preserved but stale.
  if (hasFindings && (!metadataPresent || findingsFresh))
    return {
      stage: 'done',
      done: true,
      failed: false,
      label: hasSummary ? 'done' : 'done (summary pending)',
    };
  if (!metadataPresent)
    return {
      // This deliberately reverses plan 3872 F6: F8 now publishes metadata before spawn, so the
      // former race no longer exists and an unrecorded run is terminal for --wait.
      stage: 'not-started',
      done: false,
      failed: true,
      label: 'no detached run recorded',
    };
  if (!pidPresent) {
    if (metadataAgeMs < REVIEW_LAUNCH_GRACE_MS)
      return { stage: 'launching', done: false, failed: false, label: 'launching' };
    return {
      stage: 'launch-failed',
      done: false,
      failed: true,
      label: 'launch failed (pid not recorded)',
    };
  }
  if (pidAlive === false)
    return { stage: 'dead', done: false, failed: true, label: 'dead (no findings)' };
  const keys = Object.keys(
    checkpointCalls && typeof checkpointCalls === 'object' ? checkpointCalls : {},
  );
  const completedFinders = keys.filter(
    (key) => key.startsWith('finder:') && !checkpointCalls[key]?.error,
  ).length;
  if (keys.some((key) => key.startsWith('adjudicate:')))
    return { stage: 'adjudicate', done: false, failed: false, label: 'adjudicate' };
  if (
    keys.some((key) => key.startsWith('verify:')) ||
    (finderCount > 0 && completedFinders >= finderCount)
  )
    return { stage: 'verify', done: false, failed: false, label: 'verify' };
  return {
    stage: 'finders',
    done: false,
    failed: false,
    label: `finders ${Math.min(completedFinders, finderCount)}/${finderCount}`,
  };
}

export function shouldLogProgressObservation(previousLoggedLabel, label, terminal) {
  return previousLoggedLabel === null || previousLoggedLabel !== label || terminal;
}

export function progressCommandExitCode({ progress, wait, timedOut }) {
  if (progress.done || !wait) return 0;
  if (progress.failed) return EXIT_DETACHED_GONE;
  if (timedOut) return EXIT_WAIT_STILL_RUNNING;
  return null;
}

// plan 3503: the IO wrapper below must remain fire-and-forget, so its five-way spawn decision is
// pure and directly testable without ever creating a real detached process in node:test.
export function gatePrepSpawnDecision({ gatePrep, remote, slug, cliExists, lockHeld }) {
  if (!gatePrep) return { spawn: false, log: 'gate-prep declined: disabled by --no-gate-prep' };
  if (remote)
    return {
      spawn: false,
      log: 'gate-prep declined: CLAUDE_CODE_REMOTE is set (cloud sessions run children foreground-only)',
    };
  if (!slug)
    return {
      spawn: false,
      log: 'gate-prep declined: the reviewed checkout is not on a worktree-<slug> branch',
    };
  if (!cliExists)
    return {
      spawn: false,
      log: 'gate-prep declined: the reviewed worktree has no scripts/done-worktree.mjs',
    };
  if (lockHeld)
    return {
      spawn: false,
      log: 'gate-prep declined: a prep is already running in this worktree',
    };
  return { spawn: true, log: null };
}

// plans 2604/3503: the detached prep can outlive this review process, so leaking an in-process
// hatch into it is worse than an ordinary child leak: the stale authority survives after its
// intended owner exits. Three review rounds on this one seam:
//   - round 1: a raw `{ ...process.env }` spread into the detached child → spawnEnv(), which
//     applies CHILD_ENV_STRIP (drops the in-process hatches) but deliberately preserves inherited
//     GIT_* settings.
//   - round 2 (finding 84b237): spawnEnv() not dropping GIT_* meant an ambient GIT_DIR could
//     redirect both the `git -C repoRoot` reads below AND the detached `--prep` child at the
//     LAUNCHER's checkout instead of the repo this review names — banking a proof for the wrong
//     worktree. Fixed by routing through gitIsolatedEnv(), which strips the whole GIT_* namespace.
//   - round 3: gitIsolatedEnv()'s blanket strip took transport/credential variables
//     (GIT_SSH_COMMAND, GIT_HTTP_PROXY, GIT_CONFIG_*) down with GIT_DIR, so the detached
//     `--prep` child — which pushes/fetches — silently lost its network access the same way.
//     gitRepoIsolatedEnv() drops only the repo-selection vars (see GIT_REPO_SELECTOR_VARS in
//     child-env.mjs) and leaves transport/credentials untouched: this child needs BOTH properties
//     at once, blind to the ambient repo but sighted to however this machine reaches its remote.
export function gatePrepChildEnv() {
  return gitRepoIsolatedEnv(GIT_NONINTERACTIVE_ENV);
}

function spawnReviewGatePrep(repoRoot, args) {
  // plan 3503: cheap policy declines happen before any git/lock IO. Each refused condition emits
  // one line, because a silent optimization skip is indistinguishable from a broken trigger.
  let decision = gatePrepSpawnDecision({
    gatePrep: args.gatePrep,
    remote: isClaudeCodeRemote(process.env.CLAUDE_CODE_REMOTE),
    slug: '<pending>',
    cliExists: true,
    lockHeld: false,
  });
  if (!decision.spawn) {
    log(decision.log);
    return;
  }

  const childEnv = gatePrepChildEnv();
  let branch;
  try {
    branch = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      maxBuffer: GIT_MAXBUFFER,
      env: childEnv,
    }).trim();
  } catch (error) {
    log(`gate-prep declined: could not resolve the reviewed checkout branch (${error.message})`);
    return;
  }
  const slug = planSlugFromBranch(branch);
  const cli = join(repoRoot, 'scripts', 'done-worktree.mjs');
  const cliExists = existsSync(cli);
  if (!slug || !cliExists) {
    decision = gatePrepSpawnDecision({
      gatePrep: true,
      remote: false,
      slug,
      cliExists,
      lockHeld: false,
    });
    log(decision.log);
    return;
  }

  let lockHeld;
  try {
    lockHeld = worktreeLockIsLive(resolveWorktreeLockPath(repoRoot, slug));
  } catch (error) {
    // plan 3503: this is an optimization; an unreadable lock declines the spawn and never makes
    // the review fail or guesses that a concurrent worktree writer is absent.
    log(`gate-prep declined: could not read the worktree lock (${error.message})`);
    return;
  }
  decision = gatePrepSpawnDecision({
    gatePrep: true,
    remote: false,
    slug,
    cliExists,
    lockHeld,
  });
  if (!decision.spawn) {
    log(decision.log);
    return;
  }

  let fd = null;
  try {
    const entries = parseWorktreePorcelain(
      execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf8',
        maxBuffer: GIT_MAXBUFFER,
        env: childEnv,
      }),
    );
    const MAIN = entries[0]?.path;
    if (!MAIN) {
      log('gate-prep declined: git worktree list did not identify the main checkout');
      return;
    }
    const scratch = join(MAIN, '.scratch');
    const logPath = join(scratch, `land-prep-${slug}.log`);
    mkdirSync(scratch, { recursive: true });
    // Same file done-worktree's own two prep dispatches append to, so it takes the same cap
    // (plan 3503, reversion-review advisory 2). A prep emits full `next build` / WebKit-gate
    // output and this seam fires once per review launch, so without the rotation the review lane
    // would be the one writer growing a shared log without bound between lands.
    rotateIfOver(logPath, PREP_LOG_MAX_BYTES);
    fd = openSync(logPath, 'a');
    const child = spawnDetachedWorktreeChild({
      MAIN,
      cli,
      slug,
      wtPath: repoRoot,
      childArgs: ['--prep', '--no-rebase'],
      shimLabel: 'gpt-review gate-prep shim: --prep --no-rebase',
      fd,
      env: childEnv,
    });
    // plan 3503: spawn errors are asynchronous and fatal when unheard. The review must never
    // await or inherit this child's exit: that would recreate plan 3110's stall class, a review
    // whose own outcome depends on a background child surviving after the launcher returns.
    child.on('error', (error) => {
      console.error(
        `[gpt-review] gate-prep failed to spawn for ${slug} (${error.message || error}); ` +
          `the review continues and the land may run the gates at head.`,
      );
    });
    child.unref();
    log(`gate-prep spawned: done-worktree ${slug} --prep --no-rebase (log ${logPath})`);
  } catch (error) {
    // plan 3503: every setup/spawn failure is a logged optimization miss, never a review result.
    log(`gate-prep declined: detached prep setup failed (${error.message || error})`);
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* the detached child owns its duplicated descriptor; close failure cannot affect review */
      }
    }
  }
}

// plan 3618 round 3 finding 3fe0f1: resolving the launch's plan branch must stay inside the SAME
// fail-open contract `warnBeforeReviewLaunch`'s own git lookup already has (see its `branch ===
// undefined` try/catch below) — a transient git failure on an otherwise-valid checkout must
// degrade to that pre-existing advisory fallback (branchName left undefined, which
// warnBeforeReviewLaunch resolves itself, with its OWN try/catch), never crash `main()` before a
// single finder runs. Exported as its own function — rather than an inline try/catch at the call
// site — so a unit test can inject a throwing `resolveFn` without needing to break the real repo
// `main()` already validated earlier in its own run (repoRoot, the diff range, the landed-range
// guard's fetch all already succeeded by the time this runs).
//
// plan 3618 round 4 finding 2bf5f2: fail-open means "do not block", never "charge someone else".
// With NO explicit target, falling back to `branchName: undefined` (the current checkout) is
// correct — that is what a bare launch would have resolved to anyway. But with an EXPLICIT
// target (an `--range` naming another plan) a throwing resolver must NOT silently fall back to
// the current checkout: that would charge (or cap-deny) a DIFFERENT plan than the one requested.
// Returning `{ branch: null }` instead makes `planSlugFromBranch(null)` → no slug → no plan id →
// `reviewLaunchCapDecision` treats the launch as ad-hoc (uncharged, never denied) rather than
// misattributed.
export function resolveLaunchTargetBranch({
  args,
  repoRoot,
  warn = log,
  resolveFn = resolveReviewTargetBranch,
} = {}) {
  const hasExplicitTarget = Boolean(args.rangeExplicit);
  try {
    return resolveFn({
      tokens: hasExplicitTarget ? [args.range] : [],
      cwd: repoRoot,
      allowSiblingHunt: false,
    });
  } catch (error) {
    warn(
      `plan-branch resolution failed (${error?.message || error}); ` +
        (hasExplicitTarget
          ? `an explicit target was given, so this launch is treated as ad-hoc (uncharged) ` +
            `rather than risking a charge to the wrong plan.`
          : `falling back to the current checkout branch via the pre-existing advisory path.`),
    );
    return hasExplicitTarget ? { branch: null } : null;
  }
}

/** Resolve the current plan from the checkout branch and ask record-review's marker-backed counter
 * whether the next launch is at/beyond the cap. Refresh origin/master first because record-review's
 * routed write normally lands there without touching this worktree. This intentionally has no
 * output-directory input: default timestamped output and reused `--out` directories have identical
 * round semantics. */
export function warnBeforeReviewLaunch(
  repoRoot,
  {
    warn = console.error,
    branchName,
    paths,
    findSessionFn,
    readCandidatesFn,
    refreshFn,
    refreshBeforeRead = true,
    reviewOutDir,
    previousRoundOutDirFn,
    existsFn,
    returnContext = false,
  } = {},
) {
  let branch = branchName;
  if (branch === undefined) {
    try {
      branch = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        env: gitRepoIsolatedEnv(),
      }).trim();
    } catch {
      return returnContext
        ? { branch: null, slug: null, rounds: 1, markerRoundFloor: 0, markerSha: null }
        : 1;
    }
  }
  const slug = planSlugFromBranch(branch);
  if (!slug)
    return returnContext
      ? { branch, slug: null, rounds: 1, markerRoundFloor: 0, markerSha: null }
      : 1;
  // plan 3395 review r3 (findings 11/15): reuse the landed-guard fetch rather than a second,
  // BARE `git fetch origin`. That helper is master-scoped, timeout-bounded and non-interactive;
  // a bare fetch drags every one of the 5-7 parallel sessions' in-flight worktree branches and
  // coordination refs down on EVERY review launch, which its own header warns against.
  const refresh = refreshFn ?? ((root) => fetchOriginForLandedGuard(root));
  // plan 3395 review r4: fetchOriginForLandedGuard REPORTS failure as { ok:false, error } and
  // never throws, so a catch alone would silently swallow every fetch failure and read a stale
  // tracking ref with no warning. Handle both shapes: the returned result AND a throw from an
  // injected refreshFn that does throw.
  if (refreshBeforeRead) {
    try {
      const result = refresh(repoRoot);
      if (result && result.ok === false) {
        warn(
          `review-round warning: could not refresh origin/master before reading ${slug}'s session ` +
            `record (${result.error || 'unknown fetch failure'}); using the local tracking ref, ` +
            `which may be stale.`,
        );
      }
    } catch (error) {
      warn(
        `review-round warning: could not refresh origin/master before reading ${slug}'s session ` +
          `record (${error?.message || error}); using the local tracking ref, which may be stale.`,
      );
    }
  }
  // plan 3415 finding e33d8b: loadCoordConfig fail-loud validates coord.config.json (an invalid
  // handoffLayout, an empty seedShardDir, unparsable JSON, …) — unlike the refresh() above, that
  // throw used to escape uncaught and crash the whole gpt-review launch before a single finder
  // ran. This function's own contract is "Advisory only; absent/unreadable means round 1." (see
  // warnIfReviewRoundCapReached's header), and that function already degrades gracefully on a
  // falsy `paths` (`if (!repoRoot || !slug || !paths) return 1;`) — so a config read failure here
  // warns and falls through to that same degrade instead of aborting the review.
  let resolvedPaths = paths;
  if (resolvedPaths === undefined) {
    try {
      resolvedPaths = loadCoordConfig(repoRoot).paths;
    } catch (error) {
      warn(
        `review-round warning: could not read coord.config.json to resolve ${slug}'s session ` +
          `path (${error?.message || error}); treating this launch as round 1.`,
      );
      resolvedPaths = null;
    }
  }
  const roundContext = warnIfReviewRoundCapReached(repoRoot, slug, resolvedPaths, {
    warn,
    findSessionFn,
    readCandidatesFn,
    reviewOutDir,
    previousRoundOutDirFn,
    existsFn,
    returnContext: true,
  });
  return returnContext
    ? {
        branch,
        slug,
        rounds: roundContext.rounds,
        markerRoundFloor: roundContext.markerFound ? roundContext.rounds : 0,
        // plan 4078 T1: the previous reviewed tip — the `@ <sha>` of the marker that produced
        // `rounds` above — threaded through so reviewLaunchCapDecision can diff the fix delta
        // from it. Never a second, independent marker parse (see warnIfReviewRoundCapReached).
        markerSha: roundContext.markerSha ?? null,
      }
    : roundContext.rounds;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ─── Empty-range guard (plan 3193) ─────────────────────────────────────────
// The most common way to launch this review WRONG is to run it from the MAIN
// checkout while the branch under review lives in `.claude/worktrees/<slug>`.
// The main checkout sits on `master`, so `origin/master...HEAD` there is empty
// by construction. Before plan 3193 that exited 0 with a pass-shaped
// findings.json/stats.json — byte-indistinguishable from a genuinely clean
// review, and exactly the input the /gpt-review record step hands to
// `record-review.mjs PASS --review-stats`. The visible symptom was a wasted
// run (operator-reported 2026-08-15: "This is quite often"); the latent one was
// a sha-pinned PASS marker clearing the done-worktree REVIEW_NEEDED gate on a
// diff no reviewer ever read.
//
// So a GENUINELY empty range is now a hard failure: exit 3 (distinct from 2 =
// the review broke, so a caller can tell "you pointed me at nothing" apart from
// a transport/operational failure) and NO stats.json is written — the missing
// file is what stops the record step from stamping a PASS off a non-review.
// The one legitimate empty case (every changed file is an excluded data
// artifact) keeps its exit-0 PASS; those paths carry no reviewable source and
// have their own seed-diff gates.
export const EXIT_EMPTY_RANGE = 3;

// ─── Landed-range guard (plan 3213) ────────────────────────────────────────
// The sibling misfire to the empty-range one above: a --range built from a
// commit sha read BEFORE a rebase silently widens after the rebase rewrites
// that sha, because the OLD sha still resolves — as an ancestor now sitting on
// origin/master. The range quietly grows to cover whatever another session
// landed in the meantime, and nothing about the run says so: 11 finders, N
// verifiers, real findings, all about code the session never touched, all
// recorded as a review of the diff it thought it asked for. One real run cost
// $1.30 and 4.6M tokens finding this out the hard way (plan 3213's motivating
// incident).
//
// So a range containing ANY commit already reachable from origin/master is now
// a hard failure: exit 4 (distinct from 3 = the range was empty, so a caller
// can tell "you're reviewing nothing" apart from "you're reviewing the WRONG
// thing") and, like exit 3, NO stats.json is written — the missing file is
// what stops the record step from stamping a PASS off a review of someone
// else's landed history. --end-ref is the one recognized opt-out: it already
// marks a range as a deliberate historical replay, so a range built from it is
// EXPECTED to be landed history, not a misfire.
export const EXIT_LANDED_RANGE = 4;

// Distinct from every existing runner meaning (2 transport/range, 3 empty, 4 landed). A cap
// denial is a deliberate policy refusal, not an untrusted review or malformed range.
export const EXIT_REVIEW_ROUND_CAP = 5;

// Detached polling has two recovery meanings distinct from every review verdict above.
export const EXIT_WAIT_STILL_RUNNING = 6;
export const EXIT_DETACHED_GONE = 7;

// plan 3757: the round-cap ledger's identity key — (resolved range label, end sha), the SAME
// two review-defining values `reviewIdentityFingerprint` binds the checkpoint to, never
// wall-clock or an invocation ordinal. Pure (no git) so it is directly unit-testable. Kept
// deliberately narrower than `reviewIdentityFingerprint` itself (which also folds in
// resolvedShas/paths/diffDigest) — the round cap only needs to answer "is this the SAME review
// resuming", not "is this byte-identical to the diff last read".
//
// plan 3757 fix round 1 (gpt-review keys 41ed57 / 838938 / e50513 / a61c5d / d945eb): the PATH
// SCOPE is part of the identity too. `reviewIdentityFingerprint` already folds it in, because a
// differently-scoped review reads a different diff; without it here, two genuinely different
// reviews against the same branch tip (`--paths scripts/**` then `--paths backend/**`) collapse
// into ONE ledger round and the second is never charged — the cap silently weakens. Sorted, so
// only the scope's CONTENT matters and never the order it was typed in; an omitted scope hashes
// identically to an explicitly empty one.
// plan 3757 fix round 2 (gpt-review keys b3c753 / e11f2d / 3d1089 / 9f68c9 / 6b25fb / 41d409 /
// 58c70c): key on the RESOLVED SHA TUPLE, not on a range label plus its end sha. Round 1 kept
// `rangeLabel` — which for an explicit `--range origin/master..HEAD` is a literal STRING — and
// resolved only the LAST endpoint, so a moved BASE left both inputs unchanged and a genuinely
// different review silently reused the round. The tuple carries both endpoints already, so the
// label adds nothing an identity needs: two labels resolving to the same tuple ARE the same
// review. Order is meaningful (which endpoint is which) and so is preserved, exactly as
// `reviewIdentityFingerprint` treats its own `resolvedShas`; only the path scope is sorted,
// because a scope is a set.
//
// plan 3757 fix round 3 (gpt-review keys 6dd9f7 / fa651b / 93802a / 29ecef): `rangeLabel` rides
// along AGAIN, but now BESIDE the tuple rather than instead of it. `A..B` and `A...B` resolve to
// the same endpoint pair yet are different diffs (three-dot is merge-base-based), and the tuple
// alone cannot tell them apart — the label carries the operator. This cannot reopen the round-2
// hole: the base is in the tuple, so the label can only ADD specificity. Where it does, two
// labels resolving to one tuple are charged separate rounds — the safe direction for a cap. The
// label is stable across the resumes that matter: on the default path it is built from the
// pinned base, and on an explicit range it is the user's own unchanged argument.
export function reviewRoundIdentityKey({
  rangeLabel,
  resolvedShas = [],
  paths = [],
  excludePaths = [],
}) {
  const canonical = JSON.stringify({
    rangeLabel: rangeLabel || null,
    resolvedShas: [...resolvedShas],
    paths: [...paths].sort(),
    excludePaths: [...excludePaths].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// The ref mutation + policy decision in one seam. Tests exercise this against their own temp
// repo, while main owns the exit and all later subprocess work. A null plan id is deliberately a
// pure no-op: ad-hoc reviews neither write a ref nor acquire cap semantics.
export function reviewLaunchCapDecision(
  repoRoot,
  {
    slug,
    branch,
    markerRoundFloor = 0,
    pastCapReason = null,
    identityKey = null,
    // plan 4078 T1: `markerSha` is the previous reviewed tip (warnBeforeReviewLaunch's own
    // context field, spread straight through by main()'s `...launchContext`) and `reviewOutDir`
    // is this run's `--out` — both feed the fix-brief gate below. Neither is a round-cap identity
    // input (see the do-not-touch list: resolveDiffTargetShas/reviewRoundIdentityKey stay a
    // separate axis) — they only decide whether a brief was owed, never whose round this is.
    markerSha = null,
    reviewOutDir = null,
  },
  { recordLaunchFn = recordLaunch, readLaneByIdFn = readLaneById, existsFn = existsSync } = {},
) {
  const planId = planIdFromSlug(slug);
  if (!planId) return { planId: null, launchOrdinal: null, denied: false };
  // plan 3967 fix round 2 (findings 8/9/11): thread the plan's own `lane: fast` stamp into THIS
  // runner's cap decision, not just the PreToolUse hook's — a dispatched subagent or a direct CLI
  // invocation never passes through that hook. `readLaneByIdFn` fails open to `null` on any lookup
  // error (its own contract), so a read failure here can only ever fall back to the default cap.
  const lane = readLaneByIdFn(repoRoot, planId);
  // plan 3618 finding D2: `recordLaunchFn` itself decides the second-consecutive-`run:` denial
  // ATOMICALLY, from the SAME CAS-loop snapshot it commits (or doesn't) against — never a
  // separate pre-read here, which could race a concurrent launch on this repo's shared `.git`
  // (5-7 parallel sessions is the norm). A plain integer means the launch was recorded; an
  // object means it was NOT (that specific denial writes nothing to the ledger).
  //
  // plan 3757: `identityKey` rides along unchanged — `recordLaunchFn` (recordLaunch) is the one
  // place that decides a same-identity resume is not a new round; this seam just passes it
  // through.
  const result = recordLaunchFn(repoRoot, planId, {
    branch,
    launchFloor: markerRoundFloor,
    pastCapReason,
    identityKey,
    lane,
  });
  // plan 3757 fix round 1 (gpt-review key d95e77): `recordLaunch` now has THREE shapes, so this
  // seam reads the RESUME one before the positional "an object means denied" rule below. A
  // same-identity resume is not a launch — the review it resumes was authorised when its round
  // was minted, and any real code change moves the tip, which changes the identity and mints a
  // fresh round the cap does govern — so it must never be denied. Denying it would send main()
  // down the cap-denial path, which calls `clearStaleReviewArtifacts(outDir)` and destroys
  // checkpoint.json + raw/: precisely the progress-wipe this plan exists to close, reintroduced
  // through the cap instead of through the fingerprint.
  if (result && typeof result === 'object' && result.resumed) {
    return { planId, launchOrdinal: result.ordinal, denied: false, resumed: true };
  }
  if (result && typeof result === 'object') {
    // plan 3967 fix round 4 (defect F, second denial path — findings af6eda/828d4f/597d76): this
    // is `recordLaunch`'s own atomic consecutive-`run:`-escape denial, and it is the denial a
    // fastlane plan hits MOST often, since its cap is round 1. Round 3 carried `lane` out on the
    // isPastCap path below but not here, so this branch still handed main()'s `capDenialMessage`
    // an undefined lane and printed the generic default-cap guidance — the exact message defect F
    // exists to fix. Same `lane ? …` spread as below; no lane still means byte-identical shape.
    return {
      planId,
      launchOrdinal: result.ordinal,
      denied: true,
      consecutiveEscapes: result.consecutiveEscapes,
      ...(lane ? { lane } : {}),
    };
  }
  const launchOrdinal = result;
  const denied = isPastCap(launchOrdinal, lane) && pastCapReason === null;
  // plan 4078 T1: the fix-brief gate is evaluated ONLY here — after the cap's own decision has
  // already allowed this launch — never before it (a brief denial must not mask an at-cap
  // denial, which would show main() the wrong fix menu). `fixDeltaChangedLines` and
  // `fixBriefRequired` are both pure fail-open predicates (a git failure, a null marker sha, or
  // any other resolution gap reports `changedLines: null`, which is never denied), so no
  // additional try/catch is needed here to keep this addition from turning into a crash.
  if (!denied && launchOrdinal >= 2) {
    const changedLines = fixDeltaChangedLines(repoRoot, markerSha, branch);
    const briefExists = fixBriefCandidates({ repoRoot, slug, reviewOutDir }).some(existsFn);
    if (fixBriefRequired({ launchOrdinal, changedLines, briefExists })) {
      return { planId, launchOrdinal, denied: true, deniedReason: 'fix-brief-missing' };
    }
  }
  // plan 3967 fix round 3 (defect F, findings ee26d4/49bd4d/ed9cc7/70e2cf): `lane` rides out on
  // the DENIED path — included ONLY when denied AND truthy, so an ALLOWED decision's shape stays
  // byte-identical to every pre-round-3 caller (pinned by this file's own "denies its SECOND
  // launch" test's `deepEqual` on launch 1's `{ planId, launchOrdinal, denied: false }`), exactly
  // mirroring the guard hook's own `...(planLane ? { planLane } : {})` (scripts/hooks/review-round-
  // cap-guard.mjs). Without it main()'s `capDenialMessage({ ... })` call below had no lane to pass,
  // so a fastlane plan's second-launch denial printed the generic default-cap guidance instead of
  // naming the fastlane and the review-findings parking tool.
  return {
    planId,
    launchOrdinal,
    denied,
    ...(denied && lane ? { lane } : {}),
  };
}

export function buildPastCapStatsField(pastCapReason) {
  return pastCapReason === null || pastCapReason === undefined
    ? {}
    : { pastCap: { reason: pastCapReason } };
}

// The landed-guard fetch is the ONLY network call in main(), and it sits in front of the
// mandatory pre-land review — so it gets an explicit wall clock like every other subprocess
// in this file (runCodex/spawnWithTreeKill). Without one, a wedged proxy (this repo's cloud
// lanes route HTTPS through an agent proxy that can hang rather than refuse) would park the
// whole review with no error and no exit code, which is strictly worse than the stale-ref
// degradation the non-fatal catch below is designed for.
export const LANDED_GUARD_FETCH_TIMEOUT_MS = 30_000;

// Fetches origin/master before the containment test below — a stale local origin/master ref
// would make the guard lie in both directions (missing a real landed-range misfire, or
// flagging one that fetch would have resolved). Scoped to `master` on purpose: that is the
// ONLY ref detectLandedRange consults, and a bare `git fetch origin` in this repo drags down
// every one of the 5-7 parallel sessions' in-flight worktree branches and coordination refs
// on EVERY review call. Injectable so a unit test never shells out; NON-FATAL on failure
// (offline, no configured remote, sandboxed test fixture with no real 'origin') — this guard
// degrades to whatever origin/master the local refs already carry rather than crash a run
// over a network hiccup. A test fixture that sets `refs/remotes/origin/master` directly (as
// the empty-range fixtures above already do) never configures a real remote named 'origin',
// so the fetch there fails FAST with no network attempt at all — that is what keeps the
// integration tests below off the network without a separate flag.
export function fetchOriginForLandedGuard(
  repoRoot,
  runGit = (args) =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: GIT_MAXBUFFER,
      timeout: LANDED_GUARD_FETCH_TIMEOUT_MS,
      // A fetch that stops to ask for credentials would block until the timeout above with
      // nothing on stdout to explain why. Fail it immediately instead — this guard treats an
      // unavailable remote as a degraded diagnosis, never as something to prompt about.
      // The shared constant, NOT a local GIT_TERMINAL_PROMPT: coord-git probed this on a
      // Windows/Credential-Manager host and found GIT_TERMINAL_PROMPT alone still let GCM
      // hang on a re-prompt — GCM_INTERACTIVE is the half a hand-rolled copy forgets.
      // plan 3503, review round 2 finding 84b237: cwd names the repo whose origin/master guards
      // this review. An inherited GIT_DIR/GIT_WORK_TREE can override cwd and fetch into the
      // launcher's checkout, so this named-repo git child must be blind to the ambient repo.
      // Review round 3: gitIsolatedEnv()'s blanket GIT_* strip took GIT_HTTP_PROXY/GIT_CONFIG_*
      // down with GIT_DIR, so on a checkout that gets its remote access through any of them this
      // FETCH — the one call in this function that actually needs the network — failed, and
      // failure here is deliberately non-fatal, so the guard silently fell back to a stale
      // origin/master instead of erroring. gitRepoIsolatedEnv() drops only the repo-selection
      // vars (see GIT_REPO_SELECTOR_VARS in child-env.mjs) and leaves transport/credentials
      // alone, so this fetch stays blind to the ambient repo without going blind to the network.
      env: gitRepoIsolatedEnv(GIT_NONINTERACTIVE_ENV),
    }),
) {
  try {
    // --no-tags: tags are never consulted here and are pure transfer cost.
    runGit(['fetch', '--no-tags', 'origin', 'master']);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Normalizes a range expression to the commit set `git diff` would actually review, so the
// containment test below counts THE REVIEWED COMMITS and nothing else.
//
// This exists because `...` means two DIFFERENT things in the two git commands this guard
// straddles. `git diff A...B` is merge-base-based: it diffs `merge-base(A,B)` → B, i.e. B's
// own commits only. `git rev-list A...B` is the SYMMETRIC DIFFERENCE: commits reachable from
// either side but not both — which INCLUDES everything A has that B does not. The documented
// standard invocation (`.claude/commands/gpt-review.md`: `--range "origin/master...HEAD"`)
// is a triple-dot range, so counting it with rev-list charges the caller for every commit
// any OTHER session has landed to origin/master since the branch point. In a repo with 5-7
// parallel sessions landing constantly, origin/master having moved is the NORMAL case, so an
// un-normalized guard would refuse essentially every ordinary review — with a diagnosis
// naming commits the reviewed diff never touches. Verified as a live repro at spec-fix time:
// stranger lands 1 commit, `rev-list --count origin/master...HEAD` = 2 while
// `diff --name-only origin/master...HEAD` shows only the caller's own file.
//
// Double-dot ranges (`A..B`, including the default path's resolved `${mergeBase}..${headSha}`)
// already mean the same thing to both commands and pass through untouched — which is what
// keeps the plan-3213 misfire itself (a stale pre-rebase sha in a `A..B` range) detected.
// Returns null when the merge base cannot be resolved, rather than guessing a range — a wrong
// answer here hard-refuses legitimate work. Null means "undeterminable", NOT "clean": main()
// turns it into an exit-2 operational failure, never a silent pass.
export function containmentRange(
  rangeLabel,
  runGit = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: GIT_MAXBUFFER }),
) {
  const m = /^(.*?)\.\.\.(.*)$/.exec(String(rangeLabel));
  if (!m) return String(rangeLabel);
  const left = m[1].trim() || 'HEAD';
  const right = m[2].trim() || 'HEAD';
  try {
    const mergeBase = String(runGit(['merge-base', left, right])).trim();
    if (!mergeBase) return null;
    return `${mergeBase}..${right}`;
  } catch {
    return null;
  }
}

// Counts total vs. already-landed commits in the resolved range. `runGit` is injected for the
// same reason as `collectAheadWorktrees`'s — testable without a repo on disk. `rangeLabel` is
// exactly what main() already computes: `${mergeBase}..${headSha}` on the default path, or the
// caller's own --range string on the explicit path — normalized through containmentRange above
// so the commits counted here are exactly the commits the diff under review contains.
// Returns null when the range cannot be normalized (see containmentRange) — the containment
// test could not be computed, which main() treats as an exit-2 failure. Do NOT reintroduce a
// skip-on-null caller: a guard that quietly does not run is the bug this exists to prevent.
export function detectLandedRange(
  repoRoot,
  rangeLabel,
  runGit = (args) =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: GIT_MAXBUFFER }),
) {
  const testRange = containmentRange(rangeLabel, runGit);
  if (testRange == null) return null;
  const total = parseInt(String(runGit(['rev-list', '--count', testRange])).trim(), 10);
  const unlanded = parseInt(
    String(runGit(['rev-list', '--count', testRange, '^origin/master'])).trim(),
    10,
  );
  return { total, unlanded, landed: total - unlanded, testRange };
}

// The worktrees that DO carry commits ahead of origin/master — i.e. the ones the
// caller probably meant. `runGit` is injected so this is testable without a repo.
// Never throws: an unreadable worktree list or a failing rev-list degrades to a
// shorter (possibly empty) candidate list. The diagnosis may degrade; the exit
// code never does.
export function collectAheadWorktrees(
  repoRoot,
  runGit = (args) =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: GIT_MAXBUFFER }),
  // The platform is a PARAMETER (repo rule) because the path compare below is
  // platform-dependent: win32 folds separators + case, POSIX compares verbatim.
  platform = process.platform,
) {
  let entries;
  try {
    entries = parseWorktreePorcelain(runGit(['worktree', 'list', '--porcelain']));
  } catch {
    return [];
  }
  // plan 3618 round 3 finding f146f0: the SAME candidacy predicate `hasTrackedChanges`
  // (scripts/coord/review-round-cap.mjs) uses for its own sibling hunt — a `-C <cwd>` adapter around
  // this function's existing ONE-ARG `runGit(args)` convention (cwd fixed to `repoRoot` by the
  // default), since `hasTrackedChanges(cwd, runGitFn)` expects a `runGitFn(cwd, args)` call and
  // this collector's `runGit` has no cwd parameter of its own to give it. Sharing the predicate
  // (rather than this diagnostic staying commit-count-only) is what stops the two paths from
  // disagreeing about which siblings qualify — a sibling with only tracked uncommitted changes
  // and zero committed commits ahead used to be dropped here while `resolveReviewTargetBranch`'s
  // own hunt still found it.
  const trackedChangesRunGitFn = (cwd, gitArgs) => runGit(['-C', cwd, ...gitArgs]);
  const out = [];
  for (const e of entries) {
    if (!e.branch) continue; // detached — nothing to name
    // samePathForPlatform, not a local normalizer: on POSIX a case-folding compare would
    // collapse `/repo` and `/Repo` — two different worktrees — and silently drop a real
    // candidate from the diagnosis (gpt-review 4ec033/5b2331).
    if (samePathForPlatform(e.path, repoRoot, platform)) continue; // the one we already looked at
    let ahead;
    try {
      ahead = parseInt(
        String(runGit(['rev-list', '--count', `origin/master..${e.branch}`])).trim(),
        10,
      );
    } catch {
      continue; // e.g. a branch origin/master can't reach — not a candidate we can rank
    }
    if (!Number.isInteger(ahead)) continue;
    if (ahead <= 0) {
      if (!hasTrackedChanges(e.path, trackedChangesRunGitFn)) continue;
      ahead = 0; // real work, but none of it is a committed "ahead" count to report
    }
    out.push({ path: e.path, branch: e.branch, ahead });
  }
  out.sort((a, b) => b.ahead - a.ahead || a.branch.localeCompare(b.branch));
  return out;
}

// This machine routinely carries 15+ live worktrees, so the candidate list is capped —
// but NEVER silently: the overflow is stated with the command that shows the rest.
export const EMPTY_RANGE_CANDIDATE_CAP = 10;

// Artifacts a PREVIOUS successful run may have left in a reused --out directory. The
// empty-range path deletes them (gpt-review d2be8a + 6 siblings): writing no NEW stats.json
// is not enough — `--out .scratch/gpt-review/<slug>` is the documented, slug-keyed shape, so
// a re-run of the same plan lands in a directory that can still hold a pass-shaped
// stats.json from the earlier clean run. Left in place, that file is exactly what
// `record-review.mjs --review-stats` would read, re-creating the fake PASS this guard exists
// to prevent.
// checkpoint.json + raw/ are in the list for a SECOND reason (gpt-review round 2, c/f the
// `angle-A`/`writer-trace` findings at :1933): this runner RESUMES from checkpoint.json,
// keyed by angle tag — a key that says nothing about the range. Leaving an earlier run's
// checkpoint behind means the corrected re-run (right cwd this time) replays that run's
// cached finder answers for a DIFFERENT diff and reports them as its own.
// summary.md is in the list for a THIRD reason: it is the HUMAN-facing artifact. The two
// refusal exits overwrite it with their own FAILED write immediately after clearing (clear
// then write, in that order), but the exit-2 failure paths clear WITHOUT writing one — so
// without this entry a reused --out keeps the earlier clean run's pass-shaped summary.md
// sitting next to a now-absent stats.json, and a human reading the folder sees a PASS report
// for a run that hard-failed. Same "silent about what it did not look at" class as the
// machine-read case above, just aimed at the reader instead of the record step.
// `diff.patch` is in the list for a FOURTH reason (round 3, item A — d46a23/c1488d/6f8195/
// 660452): it is a human-facing artifact too, same as summary.md above, and the SAME reused
// --out can still hold the PREVIOUS run's materialized patch. Left behind, an operator (or a
// fallback review) inspecting a failed run's directory can read that stale patch as though it
// described the CURRENT (failed) range — a mixed-generation directory presenting old evidence
// as current. `finders/` (FINDER_STDERR_DIRNAME) joins EMPTY_RANGE_STALE_DIRS for the same
// reason: a prior run's per-finder stderr diagnostics (persistFinderStderr) are just as capable
// of being mistaken for this run's own failure.
export const EMPTY_RANGE_STALE_ARTIFACTS = [
  'stats.json',
  'findings.json',
  'refuted.json',
  'checkpoint.json',
  'summary.md',
  'diff.patch',
];
export const EMPTY_RANGE_STALE_DIRS = ['raw', FINDER_STDERR_DIRNAME];

// Called by the exits that decide the RANGE is unreviewable and will never retry into this
// same directory: the two hard refusals (3 = empty range, 4 = landed range) and the three
// range-resolution failures that exit 2 (diff scoping, the containment test throwing, and an
// undeterminable merge base). Each writes no new stats.json, so a stale pass-shaped one a
// reused --out still holds has to go.
//
// Deliberately NOT called by the codex-transport exit-2 paths (codex missing, first-call
// spawn failure, finder errors). Those print "re-run with --out <dir> to retry only the failed
// calls" and that resume READS checkpoint.json + raw/ back — clearing them there would delete
// the very state the documented recovery depends on. The distinction is retryability, not exit
// code: a run that can resume into this directory keeps its artifacts.
//
// ONE function, because the two lists above are the contract and a second copy of the loop is
// a second place to forget a newly-added artifact.
export function clearStaleReviewArtifacts(outDir) {
  for (const name of EMPTY_RANGE_STALE_ARTIFACTS) {
    rmSync(join(outDir, name), { force: true });
  }
  for (const name of EMPTY_RANGE_STALE_DIRS) {
    rmSync(join(outDir, name), { recursive: true, force: true });
  }
}

// The IDENTITY-RESET variant of the list above, and the reason the two differ by exactly one
// entry. `clearStaleReviewArtifacts` is called by paths that have decided the RANGE is
// unreviewable and are about to EXIT — nothing in --out is current, so everything goes,
// diff.patch included. `bindFingerprint`'s identity reset is the opposite situation: it runs
// MID-RUN, after main() has already materialized THIS run's diff.patch (round 3's own item-D
// fix hashes those very bytes into the fingerprint), and the run then carries on to review it.
// Reusing the exit-path list there deleted the current run's patch out from under it — the
// round-3 delta re-review raised that from eight independent angles (36c20c / 1ae738 / a390e8 /
// 90431b / 422d64 / 72f226 …), a regression introduced by the round-3 fix itself.
//
// So: derived by SUBTRACTION from the one list, never a second hand-maintained copy — a future
// artifact added to EMPTY_RANGE_STALE_ARTIFACTS is covered here automatically, and `diff.patch`
// is the single, named exception. `raw/` and `finders/` DO go: both are written only AFTER the
// bind, so at reset time they can hold nothing but the prior identity's output.
//
// One more difference from the exit-path twin, and the reason THIS variant also RECREATES the
// directories it just removed while `clearStaleReviewArtifacts` recreates nothing (plan 3451,
// measured live 2026-08-25): the exit variant is called immediately before `process.exit` — an
// empty --out is the correct end state, nothing downstream ever looks at it again. This variant
// runs mid-run and the run then CARRIES ON to review the current diff, exactly like main()'s own
// startup does with `mkdirSync(join(outDir, 'raw'), { recursive: true })`. Left un-recreated,
// every finder dispatched after the reset tried to persist its result into a `raw/` that no
// longer existed and died with an ENOENT write failure — the finders had genuinely done their
// work (their candidate JSON was sitting right there in the `finders/*.stderr.txt` transcripts),
// only the write failed, so the run reported "N finder(s) failed", retried all of them, and they
// failed again the same way: a live review silently voided by a directory it deleted out from
// under itself. Recreating by iterating EMPTY_RANGE_STALE_DIRS (not by hardcoding 'raw') keeps
// the same derived-not-duplicated property this function already has for the file list — a
// future directory added there is covered on both ends automatically.
export const IDENTITY_RESET_STALE_ARTIFACTS = EMPTY_RANGE_STALE_ARTIFACTS.filter(
  (name) => name !== 'diff.patch',
);

export function clearStaleReviewArtifactsForIdentityReset(outDir) {
  for (const name of IDENTITY_RESET_STALE_ARTIFACTS) {
    rmSync(join(outDir, name), { force: true });
  }
  for (const name of EMPTY_RANGE_STALE_DIRS) {
    rmSync(join(outDir, name), { recursive: true, force: true });
    // …and immediately RECREATED, which is the whole difference between this reset and the
    // exit-path clear above. That one runs as the process is leaving, so a deleted directory
    // harms nobody; THIS one runs mid-run, and `raw/` is not just an artifact — it is the
    // directory every codex call after the bind writes its `--output-schema` result into.
    // main()'s only mkdirSync for it already ran before bindFingerprint, so deleting without
    // recreating left every finder writing to a path that no longer existed. codex reports
    // that as `Failed to write last message file … (os error 3)` and still EXITS 0, so the
    // runner saw `no output file (rc=0)` on all 11 finders and emitted a zero-finding,
    // pass-shaped review — silently, and again on every resume whose fingerprint had moved.
    // Cost six dead review rounds on 2026-08-25 (plans 3450 + 3451) before it was traced.
    mkdirSync(join(outDir, name), { recursive: true });
  }
}

// The current branch name, or `fallback` when HEAD is detached / git fails. The callers want
// different fallbacks — a diagnosis prints '(unknown)', while the sidecar lookup wants null so
// `planSlugFromBranch` sees no branch at all — so the fallback is the parameter and the try/catch
// is written once.
export function currentBranchLabel(repoRoot, fallback = '(unknown)') {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: gitRepoIsolatedEnv(),
    }).trim();
  } catch {
    return fallback;
  }
}

// The absolute path of THIS runner — the copy the recovery hint invokes, because it is the
// only one certain to support --repo (see recoveryCommand).
export const SELF_PATH = fileURLToPath(import.meta.url);

// Quote ONE argument for the copy-paste recovery line, for a POSIX shell (bash/sh — the
// Bash tool on this machine is Git Bash, and that is where the hint is pasted). Single
// quotes, not double: double quotes interpolate `$VAR`, and a real worktree path may
// legally contain one (gpt-review round 3).
//
// The embedded-apostrophe escape `'\''` is POSIX-specific — PowerShell doubles (`''`)
// instead, and no single string satisfies both, so this deliberately targets one shell
// rather than claiming a portability it cannot have (gpt-review round 4). A worktree path
// containing an apostrophe is the only case that needs hand-adjusting for PowerShell.
export function shellQuoteArg(s) {
  const v = String(s);
  return `'${v.split("'").join("'\\''")}'`;
}

// The recovery line must RECOVER, and must be a command this machine can actually run.
// Round 2 killed the version that reran in the same wrong cwd; round 3 killed the `cd … &&`
// version, because a Git-Bash command that OPENS with `cd` is never handed to the
// auto-approval classifier on this machine (the operator's global CLAUDE.md) — an agent
// pasting it stalls on a manual prompt. `--repo` is the answer to both: it names the
// checkout, so no cwd change is needed at all.
//
// It invokes THIS runner, not the candidate worktree's copy (gpt-review round 4): every
// worktree cut before this change lands carries a `scripts/gpt-review.mjs` with no --repo,
// and an unknown flag was silently ignored — so the hint would have reviewed the WRONG
// checkout, and an old enough copy would have called that empty result a PASS. The running
// copy is the only one guaranteed to understand the flag it is being handed.
// The one builder both refusal diagnoses print their recovery line with. `stripFlags` is the
// only thing that differs between them: the empty-range hint re-points an otherwise-identical
// command at another checkout (drop --out/--repo, re-add --repo), while the landed-range hint
// additionally drops --range so the re-run falls back to the rebase-proof default instead of
// replaying the very range that misfired.
function buildRerunCommand(repoPath, argv, selfPath, stripFlags) {
  const extra = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (stripFlags.includes(a)) {
      i++; // drop the flag AND its value
      continue;
    }
    // The `--name=value` form too (the shared parser accepts it): a surviving `--out=…`
    // would point the re-run back at THIS failed run's directory, and a surviving
    // `--repo=…` would put two --repo values on one command line (gpt-review round 7).
    if (stripFlags.some((f) => a.startsWith(`${f}=`))) continue;
    extra.push(shellQuoteArg(a));
  }
  const repo = String(repoPath).replace(/\\/g, '/');
  return `node ${shellQuoteArg(String(selfPath).replace(/\\/g, '/'))} --repo ${shellQuoteArg(repo)}${
    extra.length ? ` ${extra.join(' ')}` : ''
  }`;
}

export function recoveryCommand(candidate, argv = [], selfPath = SELF_PATH) {
  return buildRerunCommand(candidate.path, argv, selfPath, ['--out', '--repo']);
}

export function formatEmptyRangeError({
  repoRoot,
  rangeLabel,
  headLabel,
  candidates = [],
  rangeExplicit = false,
  cap = EMPTY_RANGE_CANDIDATE_CAP,
  argv = [],
}) {
  const lines = [
    `[gpt-review] EMPTY RANGE — refusing to report a review of nothing.`,
    ``,
    `  checkout: ${repoRoot}`,
    `  HEAD:     ${headLabel}`,
    `  range:    ${rangeLabel}`,
    ``,
    `The range resolved to zero changed files, so no reviewer read anything. This is`,
    `NOT a PASS: no stats.json is left here (a stale one from an earlier run in this same`,
    `--out directory is removed, along with its checkpoint), so this run cannot be recorded`,
    `as one.`,
    ``,
  ];
  if (candidates.length > 0) {
    lines.push(
      // plan 3618 round 4 finding 566eb0: since finding f146f0's fix, a tracked-only sibling
      // (real uncommitted work, zero committed commits) can appear with `ahead: 0` — the old
      // "DO carry commits ahead" header + a bare "0 commit(s)" row read as noise to discount,
      // defeating the exact fix that surfaces it.
      `Worktrees that carry commits OR tracked changes ahead of origin/master — re-run from the right one:`,
      ``,
      ...candidates
        .slice(0, cap)
        .map(
          (c) =>
            `  ${c.ahead > 0 ? `${c.ahead} commit(s)` : 'tracked changes'}  ${c.branch}\n      ${c.path}`,
        ),
    );
    if (candidates.length > cap) {
      lines.push(
        `  … and ${candidates.length - cap} more (\`git worktree list\` for the full set)`,
      );
    }
    // A runnable command for the FIRST-RANKED candidate. Ranking is by commits-ahead, which
    // is a heuristic, not knowledge of what you meant — so say so, and give the substitution
    // rule rather than implying the top row is the answer.
    lines.push(
      ``,
      `Re-run with --repo naming the right one (no cd needed). For the first-ranked one:`,
      ``,
      `  ${recoveryCommand(candidates[0], argv)}`,
      ``,
      `Ranking is by commits-ahead only — if that is not your branch, swap the --repo value`,
      `above for the right path from the list. Leave the script path alone: it must stay this`,
      `runner, the only copy certain to understand --repo.`,
      ``,
    );
  } else {
    lines.push(
      `No worktree in this repo carries commits ahead of origin/master either, so there`,
      `is nothing here to review at all. Check you are in the right repo and on the`,
      `right branch.`,
      ``,
    );
  }
  if (rangeExplicit) {
    lines.push(
      `The range was passed explicitly, so double-check the --range/--end-ref value too`,
      `— an empty range is never reviewable, however it was specified.`,
      ``,
    );
  }
  return lines.join('\n');
}

// The likely-intended range for the landed-range guard, as a runnable command: this SAME repo
// (--repo repoRoot, no cd needed, matching the empty-range hint's reasoning), with --range and
// --out stripped from the caller's argv so the printed command falls back to the rebase-proof
// default (`origin/master...HEAD`) instead of replaying the very range that misfired. --repo is
// stripped and re-added for the same reason recoveryCommand does it: exactly one, the correct
// one, never two competing values on one command line.
export function landedRangeRecoveryCommand(repoRoot, argv = [], selfPath = SELF_PATH) {
  // --range is stripped doubly so: it is the thing that misfired.
  return buildRerunCommand(repoRoot, argv, selfPath, ['--out', '--repo', '--range']);
}

// Pure formatter (plan 3213, mirroring formatEmptyRangeError above) — unit-testable without a
// repo. Names the landed/unlanded split, explains the rebase-sha mechanism so the message
// teaches the fix rather than just refusing, and prints the runnable recovery command.
export function formatLandedRangeError({
  repoRoot,
  rangeLabel,
  headLabel,
  landedCount,
  unlandedCount,
  argv = [],
  selfPath = SELF_PATH,
}) {
  return [
    `[gpt-review] RANGE COVERS ALREADY-LANDED COMMITS — refusing to report a review of ` +
      `someone else's landed history as your own diff.`,
    ``,
    `  checkout: ${repoRoot}`,
    `  HEAD:     ${headLabel}`,
    `  range:    ${rangeLabel}`,
    ``,
    `${landedCount} commit(s) in this range are already in origin/master; ${unlandedCount} are not.`,
    ``,
    `This is NOT a PASS: no stats.json is left here (a stale one from an earlier run in this`,
    `same --out directory is removed, along with its checkpoint), so this run cannot be`,
    `recorded as one.`,
    ``,
    `The most common cause is a stale sha: a rebase rewrote a commit this range was built`,
    `from, so the OLD sha now only resolves as an ancestor sitting on origin/master, and the`,
    `range silently widened to cover whatever another session landed in between.`,
    ``,
    `Re-run with the default range (this checkout's own commits vs origin/master):`,
    ``,
    `  ${landedRangeRecoveryCommand(repoRoot, argv, selfPath)}`,
    ``,
    `If reviewing landed history is genuinely what you want, pass --end-ref to mark this as`,
    `a deliberate historical replay — that is the one recognized opt-out.`,
    ``,
  ].join('\n');
}

// The pass-shaped exit-0 write for "nothing reviewable remains" — the ONE real, correct PASS
// case: every changed file was already an excluded data artifact under review-diff-scope.mjs's
// BUILT-IN excludes alone (seed rows have their own seed-diff gates; the rest carries no
// reviewable source). stats.json must exist on EVERY exit-0 path — the /gpt-review record step
// unconditionally passes it to record-review --review-stats — so this caller reaches it, never
// a bare `process.exit(0)`.
//
// plan 3369 fix round 1 (ac45fd/bc6b9c/26e27a): the SECOND case this used to also serve — the
// user's OWN --paths/--exclude-paths (or the auto-budget layer) narrowing what was left down to
// zero — is no longer a PASS at all. That is "you pointed the scope at nothing", the same hard-
// failure class CLAUDE.md's zero-changed-files rule names, and now exits EXIT_EMPTY_RANGE (see
// the needsPathScope block below) instead of calling this function. `scope` stays a parameter
// (rather than being deleted) only because a FUTURE real-PASS case narrowed by path scope is not
// ruled out by anything above; today's one caller passes null and the ternary below evaluates to
// `{}`, byte-identical to before this plan.
function writeEmptyScopePass(outDir, message, scope = null, identity = null, pastCapReason = null) {
  log(message);
  writeFileSync(join(outDir, 'findings.json'), '[]\n');
  writeFileSync(join(outDir, 'refuted.json'), '[]\n');
  writeFileSync(
    join(outDir, 'stats.json'),
    JSON.stringify(
      {
        identity,
        stats: { finders: 0, candidates: 0, verifierAgents: 0, escalated: 0, reported: 0 },
        // claudeArm is present on EVERY exit-0 stats.json (see the note at the main
        // write below) — 'not-run' distinguishes an empty-diff short-circuit (this
        // path never dispatches anything) from an explicit --no-claude-arm 'disabled'.
        claudeArm: {
          status: 'not-run',
          model: CLAUDE_MODEL,
          resolvedModel: null,
          resolvedVia: 'not-run',
          candidates: 0,
          tokens: 0,
          costUsd: null,
          turns: null,
        },
        ...(scope ? { scope } : {}),
        ...buildPastCapStatsField(pastCapReason),
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(outDir, 'summary.md'), `# gpt-review\n\n${message}\n`);
  process.exit(0);
}

function readJsonFailSoft(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export function defaultReviewOutDir(cwd = process.cwd(), stamp = timestamp()) {
  return join(cwd, '.scratch', 'gpt-review', stamp);
}

export function rewriteDetachedChildArgs(argv, { outDir, repoRoot }) {
  const rewritten = [];
  let sawOut = false;
  let sawRepo = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--detach' || arg === '--no-detach') continue;
    if (arg === '--out' || arg === '--repo') {
      const value = arg === '--out' ? outDir : repoRoot;
      if (arg === '--out') sawOut = true;
      else sawRepo = true;
      rewritten.push(arg, value);
      i++;
      continue;
    }
    if (arg.startsWith('--out=')) {
      sawOut = true;
      rewritten.push(`--out=${outDir}`);
      continue;
    }
    if (arg.startsWith('--repo=')) {
      sawRepo = true;
      rewritten.push(`--repo=${repoRoot}`);
      continue;
    }
    rewritten.push(arg);
  }
  if (!sawOut) rewritten.push('--out', outDir);
  if (!sawRepo) rewritten.push('--repo', repoRoot);
  return rewritten;
}

export function probeFindingsFreshness(findingsPath, startedAtMs, stat = statSync) {
  try {
    const { mtimeMs } = stat(findingsPath);
    return {
      hasFindings: true,
      findingsFresh: Number.isFinite(startedAtMs) && mtimeMs >= startedAtMs,
    };
  } catch {
    return { hasFindings: false, findingsFresh: false };
  }
}

function detachedRunProgress(outDir) {
  const detached = readJsonFailSoft(join(outDir, 'detached.json'));
  const checkpoint = readJsonFailSoft(join(outDir, 'checkpoint.json'));
  const pid = Number.isInteger(detached?.pid) && detached.pid > 0 ? detached.pid : null;
  const findingsPath = join(outDir, 'findings.json');
  const startedAtMs = Date.parse(detached?.startedAt);
  const metadataAgeMs = Number.isFinite(startedAtMs)
    ? Math.max(0, Date.now() - startedAtMs)
    : Infinity;
  const { hasFindings, findingsFresh } = probeFindingsFreshness(findingsPath, startedAtMs);
  const progress = classifyRunProgress({
    checkpointCalls: checkpoint?.calls,
    finderCount:
      Number.isInteger(detached?.finderCount) && detached.finderCount >= 0
        ? detached.finderCount
        : FINDERS.length,
    hasFindings,
    hasSummary: existsSync(join(outDir, 'summary.md')),
    findingsFresh,
    pidAlive: pidAlive(pid),
    pidPresent: pid !== null,
    metadataPresent: detached !== null,
    metadataAgeMs,
  });
  return progress.stage === 'not-started'
    ? { ...progress, label: `no detached run recorded in ${outDir}` }
    : progress;
}

export function handleDetachedSpawnResult({
  child,
  fd,
  writeSyncFn = writeSync,
  exit = (code) => process.exit(code),
}) {
  // This listener only prevents an asynchronous spawn error from being thrown by a listener-less
  // ChildProcess. It does not promise durable logging: the detached launcher may exit before the
  // event arrives, which is expected; the poller's launch grace handles that case.
  child.on('error', (error) => {
    try {
      writeSyncFn(fd, `[gpt-review] detached review spawn error: ${error.message || error}\n`);
    } catch {
      /* best-effort diagnostic only */
    }
  });
  if (child.pid) return true;
  const message = '[gpt-review] detached review failed to spawn (pid not recorded)\n';
  writeSyncFn(fd, message);
  writeSyncFn(2, message);
  exit(EXIT_DETACHED_GONE);
  return false;
}

export function detachedPollCommand(outDir, selfPath = SELF_PATH) {
  return `node ${shellQuoteArg(String(selfPath).replace(/\\/g, '/'))} --wait --out ${shellQuoteArg(outDir)}`;
}

async function runProgressCommand(args) {
  if (!args.out) {
    console.error('[gpt-review] --status and --wait require --out <dir>');
    process.exit(2);
    return;
  }
  const outDir = resolvePath(args.out);
  const deadline = Date.now() + REVIEW_WAIT_TIMEOUT_MS;
  let previousLoggedLabel = null;
  for (;;) {
    const progress = detachedRunProgress(outDir);
    const terminal = progress.done || !args.wait || progress.failed || Date.now() >= deadline;
    if (shouldLogProgressObservation(previousLoggedLabel, progress.label, terminal)) {
      console.log(`[gpt-review] ${progress.label}`);
      previousLoggedLabel = progress.label;
    }
    const exitCode = progressCommandExitCode({
      progress,
      wait: args.wait,
      timedOut: Date.now() >= deadline,
    });
    if (exitCode !== null) {
      process.exit(exitCode);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, REVIEW_WAIT_POLL_MS));
  }
}

function spawnDetachedReview({ repoRoot, outDir, argv, finderCount }) {
  const childEnv = gatePrepChildEnv();
  const entries = parseWorktreePorcelain(
    execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      maxBuffer: GIT_MAXBUFFER,
      env: childEnv,
    }),
  );
  const MAIN = entries[0]?.path;
  if (!MAIN) throw new Error('git worktree list did not identify the main checkout');
  mkdirSync(outDir, { recursive: true });
  const logPath = join(outDir, 'detached.log');
  rotateIfOver(logPath, PREP_LOG_MAX_BYTES);
  const fd = openSync(logPath, 'a');
  const childArgs = rewriteDetachedChildArgs(argv, { outDir, repoRoot });
  const startedAt = new Date().toISOString();
  const metadataPath = join(outDir, 'detached.json');
  // Publish addressable launch metadata before spawning: a launcher death cannot orphan an
  // unobservable child. The pid is filled in atomically immediately after spawn.
  atomicWriteTextSync(
    metadataPath,
    JSON.stringify(
      { pid: null, logPath, startedAt, argv: ['--no-detach', ...childArgs], finderCount },
      null,
      2,
    ) + '\n',
  );
  let child;
  try {
    // plan 3872: the helper makes `slug` the first argv token, so `--no-detach` is both a valid
    // flag and an honest structural guard against the detached child recursively re-spawning.
    child = spawnDetachedWorktreeChild({
      MAIN,
      cli: fileURLToPath(import.meta.url),
      slug: '--no-detach',
      wtPath: repoRoot,
      childArgs,
      shimLabel: 'gpt-review detached review shim',
      fd,
      // plan 3872: scrub only repo-selection Git variables here too; auth and proxy state must
      // survive because the detached review still needs the caller's codex transport credentials.
      env: childEnv,
    });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  if (!handleDetachedSpawnResult({ child, fd })) return;
  // The child owns review artifacts and bindFingerprint already clears them on an identity
  // mismatch. Clearing here would either race the new child or destroy a legitimate prior review.
  // An asynchronous spawn failure cannot be awaited without defeating prompt return. In that
  // case detached.json keeps pid:null; the poller applies REVIEW_LAUNCH_GRACE_MS and then reports
  // EXIT_DETACHED_GONE. The launcher handles only the reachable synchronous no-pid result here.
  child.unref();
  atomicWriteTextSync(
    metadataPath,
    JSON.stringify(
      {
        pid: child.pid,
        logPath,
        startedAt,
        argv: ['--no-detach', ...childArgs],
        finderCount,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `[gpt-review] DETACHED\n` +
      `pid: ${child.pid}\n` +
      `log: ${logPath}\n` +
      `poll: ${detachedPollCommand(outDir)}`,
  );
  process.exit(0);
}

async function main() {
  // parseFlags throws on an unknown flag, a positional, or a value-taking flag with no
  // usable value. All three are refusals, never defaults: silently dropping a mistyped or
  // valueless --repo would send the review at the CWD's checkout while the caller reads the
  // result as the answer for the one they named.
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(
      `[gpt-review] ${e.message}\n` +
        `Known flags: --range <git range> | --end-ref <ref> | --concurrency <n> | ` +
        `--out <dir> | --repo <path> | --no-claude-arm | --paths <glob,...> | ` +
        `--exclude-paths <glob,...> | --no-gate-prep | --past-cap <reason> | ` +
        `--detach | --no-detach | --status | --wait`,
    );
    process.exit(2);
    return;
  }

  if (args.status || args.wait) {
    if (args.status && args.wait) {
      console.error('[gpt-review] --status and --wait are mutually exclusive');
      process.exit(2);
      return;
    }
    await runProgressCommand(args);
    return;
  }

  // The shared diff-scope helpers own their Git spawns and accept a cwd but no env. Scrub only
  // repository selectors from this runner after --repo resolution so every later Git child,
  // including those delegated calls, stays bound to repoRoot.
  const repoIsolatedEnv = gitRepoIsolatedEnv();
  for (const name of GIT_REPO_SELECTOR_VARS) {
    if (repoIsolatedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = repoIsolatedEnv[name];
  }

  // plan 3500: `spawnWithTreeKill` registers one `process` 'exit' listener per live child
  // (kill-tree.mjs — it is removed again on the child's close/error, so this is a ceiling,
  // not a leak). Node's default ceiling is 10, and the finder pool now runs the whole
  // 11-angle roster at once, so every run printed a MaxListenersExceededWarning before this
  // line existed. Raise the ceiling to the pool plus the out-of-pool children (the Claude
  // data-grounding arm and the scope-summary call) and never lower an already-higher one.
  process.setMaxListeners(Math.max(process.getMaxListeners(), args.concurrency + 4));

  // --repo names the checkout to review, so the caller never has to BE in it (plan 3193).
  // Every git call and every codex/claude dispatch below already runs with `cwd: repoRoot`,
  // so this flag is the whole mechanism: it is what makes the empty-range recovery hint a
  // command an agent can actually run, rather than a `cd …` a Windows Git-Bash session
  // cannot open a command with (the operator's global CLAUDE.md).
  let repoRoot;
  try {
    repoRoot = execFileSync(
      'git',
      args.repo
        ? ['-C', resolvePath(args.repo), 'rev-parse', '--show-toplevel']
        : ['rev-parse', '--show-toplevel'],
      { encoding: 'utf8', env: gitRepoIsolatedEnv() },
    ).trim();
  } catch (e) {
    console.error(
      args.repo
        ? `[gpt-review] --repo ${args.repo} is not a git checkout (git rev-parse failed: ${e.message})`
        : `[gpt-review] not a git repo (git rev-parse failed: ${e.message})`,
    );
    process.exit(2);
    return;
  }

  // plan 4071 T2: resolve the review-diff excludes ONCE, from the repo under review
  // (`repoRoot`, never this checkout — `--repo` can point somewhere else entirely), and
  // thread the merged list to every consumer below. This is the CLI-entry resolution the
  // plan's Rule 1 carves out for a chain that terminates at a shell-invoked command.
  const reviewExcludes = reviewDiffExcludesFor(loadCoordConfig(repoRoot).reviewDiffExcludes);

  const detachDecision = reviewDetachDecision({
    detachFlag: args.detachFlag,
    noDetachFlag: args.noDetachFlag,
    remote: isClaudeCodeRemote(process.env.CLAUDE_CODE_REMOTE),
  });
  if (detachDecision.action === 'error') {
    console.error(`[gpt-review] ${detachDecision.message}`);
    process.exit(2);
    return;
  }
  if (detachDecision.action === 'detach') {
    const detachedOutDir = args.out ? resolvePath(args.out) : defaultReviewOutDir();
    try {
      spawnDetachedReview({
        repoRoot,
        outDir: detachedOutDir,
        argv: process.argv.slice(2),
        finderCount: FINDERS.length + (args.claudeArm ? 1 : 0),
      });
    } catch (error) {
      console.error(`[gpt-review] could not detach review (${error.message || error})`);
      process.exit(2);
    }
    return;
  }

  const outDir = resolvePath(args.out || defaultReviewOutDir());
  mkdirSync(join(outDir, 'raw'), { recursive: true });
  writeFileSync(join(outDir, 'schema-summary.json'), JSON.stringify(SUMMARY_SCHEMA, null, 1));
  writeFileSync(join(outDir, 'schema-candidates.json'), JSON.stringify(CANDIDATES_SCHEMA, null, 1));
  writeFileSync(join(outDir, 'schema-verdict.json'), JSON.stringify(GROUP_VERDICT_SCHEMA, null, 1));
  log(`out dir: ${outDir}`);

  // plan 2936 T2: resolve the review range ONCE, as a fixed (mergeBase, headSha) PAIR, rather
  // than a range STRING every finder would otherwise re-resolve itself via its OWN `git diff`
  // call — refs moving mid-review (a fetch advancing origin/master, a commit moving HEAD) then
  // gave different finders different diffs (the `reversed-diff-misread` finding class had no
  // single stated diff to check itself against). Default path ONLY (no explicit --range, no
  // --end-ref, per parseArgs' `rangeExplicit`): the resolved pair is used for BOTH the
  // --name-only call below and the full diff further down, so every consumer in this run sees
  // identical bytes. An explicit --range/--end-ref keeps its CURRENT string-range semantics
  // untouched (histNote's wording and the --end-ref historical path are do-not-touch, plan 2936)
  // — it still gets materialized to a file below, just from that one range string.
  let mergeBase = null;
  let headSha = null;
  if (!args.rangeExplicit && !args.endRef) {
    try {
      mergeBase = execFileSync('git', ['merge-base', 'origin/master', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: GIT_MAXBUFFER,
        env: gitRepoIsolatedEnv(),
      }).trim();
      headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: gitRepoIsolatedEnv(),
      }).trim();
    } catch (e) {
      // plan 3369 fix round 2 (74a7c9): same stale-artifact hazard as every other
      // range-resolution failure below — this path writes no new stats.json, so a reused
      // --out's earlier pass-shaped one must not survive to be adopted by record-review.
      clearStaleReviewArtifacts(outDir);
      console.error(
        `[gpt-review] failed to resolve the default review range (merge-base origin/master HEAD): ${e.message}`,
      );
      process.exit(2);
      return;
    }

    // plan 3757: pin the merge-base EARLY — before diffTargets/rangeLabel are derived from it,
    // and long before the landed-range guard's own `git fetch` runs — never by recomputing a
    // fresh base and comparing it against the recorded one later (that reintroduces the exact
    // race this closes: another session's land moving origin/master in the gap). A resume into
    // this SAME --out whose reviewed tip (headSha) is unchanged from a prior run treats that
    // prior run's recorded base as authoritative; only origin/master moved, which is
    // informational, not identity-breaking. Everything downstream (diffTargets, rangeLabel, the
    // materialized diff, resolvedShas, diffDigest, stats.json, summary.md) then flows from this
    // SAME pinned base, so the fingerprint `bindFingerprint` computes further down matches
    // naturally — no special case there. An explicit --range/--end-ref never reaches this block
    // at all (today's behaviour is untouched on that path).
    const pinDecision = resolveResumeMergeBase({
      recorded: readCheckpointBasePin(outDir),
      currentEndSha: headSha,
      freshBase: mergeBase,
    });
    if (pinDecision.pinned) {
      log(
        `resuming into ${outDir}: origin/master moved but the reviewed tip (${headSha}) is ` +
          `unchanged, so the recorded merge-base ${pinDecision.base} is adopted over the freshly ` +
          `recomputed ${mergeBase} (${pinDecision.reason}).`,
      );
      mergeBase = pinDecision.base;
    }
  }
  const diffTargets = mergeBase != null ? [mergeBase, headSha] : [args.range];
  const rangeLabel = mergeBase != null ? `${mergeBase}..${headSha}` : args.range;
  // plan 3757: hoisted from further down (was computed just before its one prior use) so the
  // reporting sites further down share one value instead of re-deriving it. Unchanged expression.
  // NOTE it is a LABEL, not necessarily a sha: on an explicit --range/--end-ref it is the literal
  // ref/range string. Neither the round-cap identity key nor the persisted resume pin may use it
  // for that reason — both resolve the end sha instead (plan 3757 fix round 1, keys 318c41 /
  // bbfaa9 / dc0de4 / 76477b); it is for human-facing orientation text only.
  const headShaLabel = mergeBase != null ? headSha : args.endRef || args.range;

  let files;
  let excludedCount = 0;
  try {
    // plan 3093: ONE unscoped `--name-only`, partitioned in JS by the shared module —
    // same answer as a second scoped git call, one spawn, and the excluded COUNT falls
    // out exactly. `files` is the scoped list from here on, so the scope block, the
    // CLAUDE.md discovery, and the Claude arm's file validation all agree with the bytes
    // in diff.patch. (The module's runner keeps the GIT_MAXBUFFER this call has always
    // needed: plan 2840's corpus re-render changes ~6,100 paths, ~800 KB of names, and
    // Node's 1 MB default died ENOBUFS on the PATH LIST alone — surfacing as a transport
    // error that routed to the /sonnet-review fallback instead of naming the size limit.)
    const split = changedFilePartition({
      targets: diffTargets,
      cwd: repoRoot,
      excludes: reviewExcludes,
    });
    files = split.included;
    excludedCount = split.excluded.length;
  } catch (e) {
    // Same stale-artifact hazard as the refusal exits below: no new stats.json is written
    // here, so an earlier run's pass-shaped one in a reused --out must not survive.
    clearStaleReviewArtifacts(outDir);
    console.error(
      `[gpt-review] git diff --name-only failed for range "${rangeLabel}": ${e.message}`,
    );
    process.exit(2);
    return;
  }
  // plan 3369, task 3: a SNAPSHOT of the built-in-only count, taken before any later --paths/
  // --exclude-paths/auto-budget narrowing can add to `excludedCount` — review-diff-scope.mjs's
  // excludedNote() wording describes ONLY its own built-in list, so it must always read this
  // frozen count, never the combined one (see the buildScopeBlock call site below).
  const builtInExcludedCount = excludedCount;
  if (files.length === 0 && excludedCount === 0) {
    // GENUINELY empty range (plan 3193) — almost always the wrong checkout: the review was
    // launched from the main tree (on master) while the diff lives on a worktree branch.
    // Hard-fail with a diagnosis, and write NO stats.json, so this can never be recorded
    // as a PASS. See EXIT_EMPTY_RANGE above for the full rationale.
    const msg = formatEmptyRangeError({
      repoRoot,
      rangeLabel,
      headLabel: currentBranchLabel(repoRoot),
      candidates: collectAheadWorktrees(repoRoot),
      rangeExplicit: Boolean(args.rangeExplicit || args.endRef),
      argv: process.argv.slice(2),
    });
    // Delete, don't merely decline to write: a reused --out (the documented slug-keyed
    // `.scratch/gpt-review/<slug>` shape) can still hold a pass-shaped stats.json from an
    // earlier clean run, which is exactly what record-review --review-stats would read.
    clearStaleReviewArtifacts(outDir);
    console.error(msg);
    writeFileSync(join(outDir, 'summary.md'), `# gpt-review — FAILED (empty range)\n\n${msg}\n`);
    process.exit(EXIT_EMPTY_RANGE);
    return;
  }

  let ckpt = null;
  let diffText = '';
  let diffPatchPath;
  let pathScopeNote = '';
  let autoExcludedGlobs = [];
  let pathScopeDroppedCount = 0;

  if (files.length > 0) {
    // Constructed AFTER the empty-range guard (gpt-review round 3): the constructor JSON.parses
    // an existing checkpoint.json, so a malformed/half-written one from an earlier run threw
    // here and the cleanup below it never ran — the guard was unreachable in exactly the state
    // it exists to clean up.
    ckpt = new Checkpoint(join(outDir, 'checkpoint.json'));
    log(
      `${files.length} changed file(s) in range ${rangeLabel}` +
        (excludedCount > 0 ? ` (${excludedCount} data-artifact file(s) excluded)` : ''),
    );

    // plan 2936 T2: materialize the diff ONCE — every finder (and the verifiers/Claude arm, via
    // the same scopeBlock) reads THIS file instead of each running its own `git diff`. The
    // returned `patch` is reused for the summary call below rather than shelling out again.
    //
    // plan 3093: assembly is the SHARED writer, not a hand-rolled `git diff` + write beside the
    // module's own (round-1 review, altitude angle). The exclusion is applied at ASSEMBLY, so an
    // excluded hunk never exists in diff.patch at any point — post-filtering a 19.5 MB patch
    // would still have cost the 19.5 MB read and the oversized file list that killed the
    // Claude arm. No `includeWorktree` here: this lane reviews a committed range only, and the
    // file list above was partitioned on the same targets, so patch and list cannot disagree.
    try {
      const written = writeScopedPatch({
        targets: diffTargets,
        outPath: join(outDir, 'diff.patch'),
        cwd: repoRoot,
        excludes: reviewExcludes,
      });
      diffText = written.patch;
      diffPatchPath = written.outPath;
    } catch (e) {
      // plan 3369 fix round 2 (1507e0/c1c033): same stale-artifact hazard as the path-scoped
      // diff failure below — this INITIAL unscoped diff-write path also writes no new
      // stats.json, so a reused --out's earlier pass-shaped one must not survive to be adopted
      // by record-review.
      clearStaleReviewArtifacts(outDir);
      console.error(`[gpt-review] git diff failed for range "${rangeLabel}": ${e.message}`);
      process.exit(2);
      return;
    }

    // ─── plan 3369, task 3 — --paths/--exclude-paths + auto data-tree exclusion ─────────────
    // Layered ONTO the already built-in-excluded diff just materialized above, and skipped
    // entirely (no extra git spawn) unless the caller asked for it OR the diff is still over
    // budget — the overwhelmingly common review pays nothing extra for this. `files`/`diffText`/
    // `diffPatchPath` are reassigned in place so every consumer below (claudeMdFiles, the finder
    // fan-out, the Claude arm) sees the FINAL narrowed scope; the empty/landed-range guards above
    // already ran on the true, unnarrowed diff and are unaffected.
    // plan 3369 fix round 1 (b65c47/3e458e): tracks what THIS layer actually dropped, separately
    // from `excludedCount` (which also carries the built-in layer's count) — the stats.json
    // `scope` write below gates on THIS being > 0, never on a flag merely being present or the
    // budget layer merely having fired.
    const needsPathScope =
      args.paths.length > 0 ||
      args.excludePaths.length > 0 ||
      diffText.length > FINDER_CONTEXT_BUDGET_CHARS;
    if (needsPathScope) {
      let scoped;
      try {
        scoped = applyPathScope({
          diffTargets,
          outPath: diffPatchPath,
          repoRoot,
          paths: args.paths,
          excludePaths: args.excludePaths,
          excludes: reviewExcludes,
        });
      } catch (e) {
        // plan 3369 fix round 1 (58023b/cb7bdb): same stale-artifact hazard as every other
        // range-resolution failure above — this path writes no new stats.json, so a reused
        // --out's earlier pass-shaped one must not survive to be adopted by record-review.
        clearStaleReviewArtifacts(outDir);
        console.error(
          `[gpt-review] path-scoped git diff failed for range "${rangeLabel}": ${e.message}`,
        );
        process.exit(2);
        return;
      }
      const droppedCount = files.length - scoped.files.length;
      pathScopeDroppedCount = droppedCount;
      autoExcludedGlobs = scoped.autoExcludedGlobs;
      pathScopeNote = buildPathScopeNote({
        paths: args.paths,
        excludePaths: args.excludePaths,
        autoExcludedGlobs,
        droppedCount,
      });
      if (pathScopeNote) log(pathScopeNote);
      files = scoped.files;
      diffText = scoped.patch;
      excludedCount += droppedCount;
      if (files.length === 0) {
        // plan 3369 fix round 1 (ac45fd/bc6b9c/26e27a): this run's OWN scope (--paths/
        // --exclude-paths, or the auto-budget layer) narrowed every changed file away — the SAME
        // "you pointed it at nothing" class CLAUDE.md's zero-changed-files rule names (a hard
        // failure, never a PASS), NOT the genuinely-correct "every changed file was already a
        // built-in-excluded data artifact" PASS the guard above still returns. Routed through the
        // SAME EXIT_EMPTY_RANGE contract as the top-of-file empty-range guard — exit 3, no
        // stats.json written, a stale one in a reused --out deleted — rather than a new exit code
        // or a new "reviewable" vocabulary (see the exit-code table at the top of this file). The
        // message says SCOPE, never "wrong checkout", so it reads as a distinguishable failure
        // from the genuinely-empty-range guard above; it is also almost always a typo, so it says
        // that too.
        const msg =
          `[gpt-review] EMPTY RANGE after path scoping — this run's own scope narrowed every ` +
          `changed file away.\n` +
          `  range: ${rangeLabel}\n` +
          (args.paths.length ? `  --paths ${args.paths.join(',')}\n` : '') +
          (args.excludePaths.length ? `  --exclude-paths ${args.excludePaths.join(',')}\n` : '') +
          (autoExcludedGlobs.length
            ? `  auto-excluded over the ${FINDER_CONTEXT_BUDGET_CHARS}-char finder context budget: ${autoExcludedGlobs.join(', ')}\n`
            : '') +
          `  ${excludedCount} changed file(s) total excluded (built-in data-tree excludes plus ` +
          `this run's path scope).\n` +
          `This is almost always a typo in --paths/--exclude-paths, not a genuinely empty diff — ` +
          `narrow less, or drop the flag(s) to review the full range.`;
        clearStaleReviewArtifacts(outDir);
        console.error(msg);
        writeFileSync(
          join(outDir, 'summary.md'),
          `# gpt-review — FAILED (empty after path scoping)\n\n${msg}\n`,
        );
        process.exit(EXIT_EMPTY_RANGE);
        return;
      }
    }
  }

  // ─── Landed-range guard (plan 3213) ──────────────────────────────────────

  // --end-ref already marks this range as a deliberate historical replay, so a range built
  // from one is EXPECTED to cover landed history — that is the one recognized opt-out, and the
  // guard does not even run the containment test in that case.
  let landedGuardRefreshedOrigin = false;
  if (!args.endRef) {
    // Non-fatal on purpose (see fetchOriginForLandedGuard's header comment): a stale local
    // origin/master ref makes the guard lie in both directions, but a network hiccup must
    // degrade the diagnosis, not crash a review that was otherwise fine to run.
    const fetchResult = fetchOriginForLandedGuard(repoRoot);
    landedGuardRefreshedOrigin = fetchResult.ok;
    if (!fetchResult.ok) {
      log(
        `git fetch --no-tags origin master failed (${fetchResult.error}) — checking the ` +
          `range against the local origin/master ref as-is.`,
      );
    }
    let counts;
    try {
      counts = detectLandedRange(repoRoot, rangeLabel);
    } catch (e) {
      // A git failure here is operational, not a verdict — exit 2, and clear the stale
      // artifacts for the same reason the two refusal exits do: this path writes no new
      // stats.json, so an earlier run's pass-shaped one must not survive in a reused --out.
      clearStaleReviewArtifacts(outDir);
      console.error(
        `[gpt-review] failed to check range "${rangeLabel}" against origin/master: ${e.message}`,
      );
      process.exit(2);
      return;
    }
    if (counts == null) {
      // The range could not be normalized to the commit set the diff actually covers (no
      // resolvable merge base). This is a FAILURE, not a pass: silently continuing would let
      // a run whose containment test never executed be recorded as a clean review — the exact
      // "confidently silent about what it did not look at" class both this guard and plan
      // 3193's exist to close. It routes to 2 (the review BROKE) rather than 4 (the range is
      // landed) because we could not determine whether it is landed at all. Reaching here is
      // anomalous by construction: `git diff A...B` needs the same merge base and already ran
      // above, so a failure now means the repo changed underneath the run.
      clearStaleReviewArtifacts(outDir);
      console.error(
        `[gpt-review] could not resolve the commit set for range "${rangeLabel}" (no merge ` +
          `base) — refusing to skip the landed-range check silently.`,
      );
      process.exit(2);
      return;
    }
    const { landed, unlanded } = counts;
    if (landed > 0) {
      const msg = formatLandedRangeError({
        repoRoot,
        rangeLabel,
        headLabel: currentBranchLabel(repoRoot),
        landedCount: landed,
        unlandedCount: unlanded,
        argv: process.argv.slice(2),
      });
      // Same hazard as the empty-range guard, same fix: this exit also writes no NEW
      // stats.json, so a stale pass-shaped one from an earlier run in a reused --out must
      // not survive to be read by record-review --review-stats.
      clearStaleReviewArtifacts(outDir);
      console.error(msg);
      writeFileSync(
        join(outDir, 'summary.md'),
        `# gpt-review — FAILED (range covers landed commits)\n\n${msg}\n`,
      );
      process.exit(EXIT_LANDED_RANGE);
      return;
    }
  }

  // Resolve the branch and marker floor only after every exit that reviews nothing: both
  // empty-range exits and the landed-range exit. The marker is a floor even when a local ledger
  // already exists, so every decision uses the same refresh-backed reader.
  // Reuse the landed-range guard's fetch only when it actually succeeded; otherwise refresh here
  // so the marker floor gets a retry after a failed guard fetch (or its first fetch with --end-ref).
  //
  // plan 3618 round 2 (findings de1870/2ca846/61967c/a79b9f/2a8432/153a5b/37e077/5475c1): resolve
  // the plan branch through the SAME resolver the guard hook uses, fed the SAME token this
  // runner's own parsed args carry — an explicit --range value, or nothing. --end-ref is NEVER a
  // target selector in either lane (it marks a deliberate historical replay, not "review this
  // other plan"; it still only affects the diff bounds via args.endRef elsewhere in this file).
  // `warnBeforeReviewLaunch` and `reviewLaunchCapDecision` below both consume this ONE
  // resolution — neither re-derives the branch from `git rev-parse --abbrev-ref HEAD` on its
  // own, which is what let a `--range a..b` launch charge the WRONG plan (the current checkout's
  // branch) while the guard, taught in round 1 to charge the range's end ref, charged the RIGHT
  // one. `allowSiblingHunt: false` matches the Bash lane's own guard call: this runner always
  // reviews the CURRENT checkout (or an explicit --range's end ref), never a guessed sibling.
  //
  // plan 3618 round 3 finding 3fe0f1: the resolution itself is wrapped in `resolveLaunchTargetBranch`'s
  // own fail-open — see its header — so a transient git failure here degrades to the pre-existing
  // advisory fallback instead of crashing main() before a single finder runs.
  const launchTarget = resolveLaunchTargetBranch({ args, repoRoot });
  const launchContext = warnBeforeReviewLaunch(repoRoot, {
    returnContext: true,
    branchName: launchTarget?.branch,
    refreshBeforeRead: !landedGuardRefreshedOrigin,
    reviewOutDir: outDir,
  });
  // plan 3757: charge the round-cap ledger against the REVIEW IDENTITY (resolved range + end
  // sha) rather than this invocation — a resume that lands on the identical identity reuses the
  // existing round's ordinal instead of minting a new one (see recordLaunch/reviewLaunchCapDecision
  // in scripts/coord/review-round-cap.mjs).
  //
  // plan 3757 fix round 1 (gpt-review keys 318c41 / bbfaa9 / dc0de4 / 76477b), round 2 (b3c753
  // et al.): the endpoints are RESOLVED here, never `headShaLabel` and never `rangeLabel`. On the
  // default path `diffTargets` is already a concrete (mergeBase, headSha) pair so this is a
  // no-op; for an explicit `--range HEAD~1..HEAD` / `--end-ref <branch>` those labels are stable
  // STRINGS whose commits move as refs advance (the same trap plan 3369 round 2 fixed for the
  // checkpoint fingerprint), so keying the ledger on them let two genuinely different reviews
  // share one round and the second was never charged. `resolveDiffTargetShas` mints an
  // always-distinct marker when a ref will not resolve, which errs toward charging a fresh round
  // rather than silently reusing one — the safe direction for a cap.
  const launchDecision = reviewLaunchCapDecision(repoRoot, {
    ...launchContext,
    // plan 4078 T1: this run's --out (`outDir` — always resolved by this point, default or
    // explicit) is the one location the RUNNER can additionally check the fix brief against; the
    // guard hook (which fires before outDir exists) checks only the slug-keyed default.
    reviewOutDir: outDir,
    pastCapReason: args.pastCapReason,
    identityKey: reviewRoundIdentityKey({
      rangeLabel,
      resolvedShas: resolveDiffTargetShas(diffTargets, repoRoot),
      paths: args.paths,
      excludePaths: args.excludePaths,
    }),
  });
  if (launchDecision.denied) {
    clearStaleReviewArtifacts(outDir);
    console.error(
      launchDecision.deniedReason === 'fix-brief-missing'
        ? fixBriefDenialMessage({
            planId: launchDecision.planId,
            slug: launchContext.slug,
            launchOrdinal: launchDecision.launchOrdinal,
            candidates: fixBriefCandidates({
              repoRoot,
              slug: launchContext.slug,
              reviewOutDir: outDir,
            }),
          })
        : capDenialMessage({
            planId: launchDecision.planId,
            launchOrdinal: launchDecision.launchOrdinal,
            pastCapFlagName: '--past-cap',
            consecutiveEscapes: launchDecision.consecutiveEscapes,
            // plan 3967 fix round 3 (defect F): absent on every pre-fastlane decision shape (see
            // reviewLaunchCapDecision's own `...(denied && lane ? { lane } : {})` guard above) —
            // capDenialMessage's own `lane = null` default then renders the exact byte-identical
            // message it always has.
            lane: launchDecision.lane,
          }),
    );
    process.exit(EXIT_REVIEW_ROUND_CAP);
    return;
  }

  if (files.length === 0) {
    // Every changed file is an excluded data artifact. This IS a real, correct PASS — those
    // paths carry no reviewable source and seed rows have their own seed-diff gates — but it
    // must SAY so rather than read as "nothing changed", which would misdescribe a 700-file
    // land. (The genuinely-empty case is handled above and never reaches here.)
    writeEmptyScopePass(
      outDir,
      `No reviewable changes in range — all ${excludedCount} changed file(s) are excluded data artifacts.`,
      null,
      {
        fingerprint: null,
        endSha: resolveDiffTargetShas(diffTargets, repoRoot).at(-1),
        rangeLabel,
        writtenAt: new Date().toISOString(),
      },
      args.pastCapReason,
    );
    return; // writeEmptyScopePass always process.exit()s; unreachable, kept for clarity/testability
  }

  // plan 3369 fix round 1 (f2481e/c1b242/9cb459/055dc7), round 2 (2a4d68 et al.): bind this
  // resume's checkpoint to the now-FINAL review identity (RESOLVED commits + full path scope,
  // including whichever auto-budget globs actually fired) BEFORE the first callCached() call
  // below — a mismatch discards every cached result and starts this resume fresh rather than
  // silently reusing a different diff's finder/scope-summary results. `resolveDiffTargetShas`
  // over `diffTargets` (not `rangeLabel` alone) — an explicit --range/--end-ref's literal string
  // is a stable label whose resolved commits move as refs advance, so hashing the label alone let
  // an interrupted-then-resumed run keep an identical fingerprint after a fetch/rebase/new commit.
  //
  // plan 3369 fix round 3 (6b3b47/f3ffa5): `resolveDiffTargetShas` runs HERE, after `diffText`
  // was already materialized above (and, for the default path, after the landed-range guard's own
  // `git fetch`) — a ref can advance in that gap, so resolvedShas alone could describe a NEWER
  // range than the OLDER patch `diffText` actually holds. `diffDigest` binds the identity to the
  // bytes this run actually read, independent of what the refs resolved to by the time this line
  // runs — `diffText` here is the FINAL narrowed text (post path-scope, when that layer ran), the
  // same bytes just written to `diffPatchPath` and handed to every finder below.
  // Plan 3507 keeps this block above codex bootstrap because an unusable codex exits 2 below, and
  // a foreign artifact set must already have been cleared by then.
  const resolvedShas = resolveDiffTargetShas(diffTargets, repoRoot);
  const identityComponents = reviewIdentityComponents({
    rangeLabel,
    endRef: args.endRef,
    resolvedShas,
    paths: args.paths,
    excludePaths: args.excludePaths,
    autoExcludedGlobs,
    diffDigest: createHash('sha256').update(diffText).digest('hex'),
  });
  const reviewIdentity = reviewIdentityFingerprint(identityComponents);
  // plan 3757: persist (base, endSha) alongside the fingerprint — `mergeBase` here is already
  // the PINNED value when this run adopted a resume pin above, so what gets recorded for a
  // FUTURE resume to read is the same base this run's own diffTargets/rangeLabel/diffText/
  // stats.json/summary.md all describe, never a value that could disagree with them.
  // plan 3757 fix round 1 (key 721bd7's sibling): the RESOLVED end sha, not `headShaLabel` —
  // that is a display label which, on an explicit --range/--end-ref, is a ref/range STRING. The
  // pin is compared as an object name by a later resume (and `readCheckpointBasePin` now
  // validates the shape), so recording a label there would write a field no reader can use.
  // `resolvedShas` is the same array the fingerprint above was built from, so the pin can never
  // disagree with the identity it is stored beside.
  ckpt.bindFingerprint(reviewIdentity, {
    base: mergeBase,
    endSha: resolvedShas.at(-1),
    components: identityComponents,
  });

  // plan 3369 fix round 1 (bc6b9c/26e27a): moved here from BEFORE diff materialization / path
  // scoping — a run whose scope narrows to nothing must exit 3 above without ever writing
  // codex credentials or resolving the binary. Nothing between the old position and here reads
  // `codexBin`; its first real use is the scope-summary call below.
  // plan 3380: anchor the codex trust key on the checkout under review (`--repo`), not on
  // whatever directory this process was launched from. `authEnvVar` is no longer threaded
  // explicitly (plan 3958 review, key 10k7z8u) — ensureCodexBootstrap's own default now
  // resolves it from `trustAnchor`'s coord config.
  ensureCodexBootstrap({ trustAnchor: repoRoot });
  const codexBin = resolveCodexBin();
  if (!codexBin) {
    console.error(
      '[gpt-review] codex.cmd not found on PATH and the known fallback path is missing — codex CLI is unusable. ' +
        'Fall back to /sonnet-review.',
    );
    process.exit(2);
    return;
  }

  const claudeMdFiles = findClaudeMdFiles(repoRoot, files);
  const cappedDiff =
    diffText.length > DIFF_SUMMARY_CAP
      ? diffText.slice(0, DIFF_SUMMARY_CAP) +
        '\n...[diff truncated at ' +
        DIFF_SUMMARY_CAP +
        ' chars for the summary call]...'
      : diffText;

  const target = args.endRef ? histNote(args.endRef) : '';
  // headShaLabel (the orientation sentence's '+' side label: the real resolved sha on the
  // default path; the --end-ref value, or lacking that, the literal range string on an explicit
  // --range with no --end-ref) is computed once, earlier, right after mergeBase/headSha — see
  // that declaration's comment.

  const tokens = { scope: 0, finders: 0, verify: { total: 0 }, adjudicate: { total: 0 } };

  const summaryPrompt =
    'Write a 2-3 sentence summary of what the following diff changes (the "What changed" section of a code-review scope block). ' +
    (target ? target + '\n\n' : '') +
    'Changed files (' +
    files.length +
    '):\n' +
    files.map((f) => '  - ' + f).join('\n') +
    '\n\n## Diff\n```\n' +
    cappedDiff +
    '\n```\n\nStructured output only.';
  const summaryTag = callTag(
    'scope-summary',
    promptCallDigest({ prompt: summaryPrompt, schema: SUMMARY_SCHEMA, model: MODEL_LUNA }),
  );
  const summaryRes = await callCached(ckpt, summaryTag, () =>
    runCodex({
      codexBin,
      model: MODEL_LUNA,
      prompt: summaryPrompt,
      schemaPath: join(outDir, 'schema-summary.json'),
      outFile: join(outDir, 'raw', `${sanitizeTag(summaryTag)}.json`),
      cwd: repoRoot,
    }),
  );
  let summary;
  if (summaryRes.error) {
    log(`scope-summary: ERROR ${summaryRes.error}`);
    if (String(summaryRes.error).startsWith('spawn:')) {
      console.error(
        '[gpt-review] codex failed to spawn on the very first call — treating as a transport failure.',
      );
      process.exit(2);
      return;
    }
    summary = `(summary unavailable — codex call failed: ${summaryRes.error}; see the diff file above)`;
  } else {
    summary = summaryRes.data?.summary || '(empty summary returned)';
    tokens.scope += summaryRes.tokens || 0;
  }
  log(`scope-summary: ${summaryRes.tokens ?? '?'} tok, ${summaryRes.wallS}s`);

  const conventions =
    claudeMdFiles.length > 0
      ? "Read the Applicable CLAUDE.md files listed above directly before applying the Conventions angle — quote exact rules from them, don't paraphrase from memory."
      : '(no applicable CLAUDE.md files found)';

  // plan 2936 T1: load the findings sidecar for THIS plan (if any) before the finder fan-out —
  // one injection into the shared scope block covers every finder AND the Claude data-grounding
  // arm (buildScopeBlock flows into both). A branch that isn't `worktree-<slug>` (e.g. a bare
  // `--range`/`--end-ref` smoke replay run off some other branch) has no slug and therefore no
  // sidecar to carry — that is a normal, silent no-op, not a warning.
  let dispositionsBlock = '';
  {
    // null fallback, not '(unknown)': detached HEAD or similar means no slug and no
    // injection, which planSlugFromBranch already reads off a null branch. Not an error.
    const branch = currentBranchLabel(repoRoot, null);
    const slug = planSlugFromBranch(branch);
    if (slug) {
      // headSha is the review snapshot's OWN resolved tip where T2 resolved one, not a fresh
      // rev-parse: sidecar freshness must be judged against the commit the finders are actually
      // reviewing. Null on the explicit-range path, where freshness degrades to first-parseable.
      // plan 2936 round-4 cleanup: HEAD's rebase-stable range patch-id rides along with the sha.
      // Without it `markerIdentityMatch`'s patch-id branch inside pickFreshestSidecar can never
      // fire, which is exactly the case that matters — a sidecar recorded before a pure rebase
      // still describes this content, and sha equality alone calls it stale. LAZY (the canonical
      // memoized thunk, land-lib.rangePatchIdOnce): the common case, where a candidate's sha
      // already pins headSha, never spawns `git diff | git patch-id` at all.
      //
      // The base is T2's CAPTURED `mergeBase`, not rangePatchIdOnce's live `origin/master`
      // default (round-4 review, angle-A + altitude): the thunk fires minutes into the run, and
      // a fetch advancing origin/master in the meantime would make it describe a range the
      // finders never reviewed. Passing the snapshot's own base is the same T2 property — the
      // review's endpoints are resolved ONCE — applied to the identity token.
      dispositionsBlock = dispositionsBlockForSlug(repoRoot, slug, { headSha, mergeBase });
    }
  }

  const scopeBlock = buildScopeBlock({
    diffPatchPath,
    headSha: headShaLabel,
    files,
    claudeMdFiles,
    summary,
    conventions,
    target,
    dispositionsBlock,
    // plan 3369, task 3: review-diff-scope.mjs's excludedNote() wording is fixed to describe
    // ITS OWN built-in list — `builtInExcludedCount`, not the combined `excludedCount` (which
    // may also carry --paths/--exclude-paths/auto-budget drops by the time we reach here), so
    // this sentence never misattributes a user/auto exclusion to the built-in one. The SECOND
    // layer gets its own sentence via `pathScopeNote` below.
    excludedNote: excludedNote(builtInExcludedCount, reviewExcludes),
    pathScopeNote,
  });

  // plan 3503: placement is a contract — AFTER the last refusal and BEFORE the first finder.
  // Empty/landed ranges, path-scope failures, an unusable codex binary, and a summary transport
  // refusal must not burn a detached full gate battery for a review already certain to abort.
  // The prep remains fire-and-forget and never contributes to the review exit status.
  spawnReviewGatePrep(repoRoot, args);

  // ─── Finders — codex's 11-angle roster, dispatched alongside the Claude
  // data-grounding hybrid arm (plan 2766, sibling to runCodex — see the file
  // header). The two transports run concurrently; the arm's checkpoint tag
  // (CLAUDE_ARM_TAG) is namespace-distinct from every codex `finder:<angle>`
  // tag, including the codex `guard-fires`/`writer-trace` angles it overlaps
  // in mandate — a resume never conflates the two transports' cached results.
  //
  // plan 3369, task 5: the Claude arm's spawned child is captured here (via
  // runClaudeArm's onChild hook) so a fatal finder failure below can tree-kill
  // it EARLY rather than letting it run until it finishes on its own or the
  // liveness probe (plan 3966) eventually kills it — the actual bug the debt
  // entry named (gpt-review-claude-arm-not-cancelled-
  // on-fatal-codex-finder) was never a missing kill primitive (killProcessTree
  // already exists and spawnWithTreeKill already tree-kills on process.exit),
  // it was that the OLD code `await Promise.all([finders, claudeArmPromise])`
  // never REACHED the exit(2) branch until the arm had already finished
  // naturally. Awaiting the finders first (below) fixes that.
  let claudeArmChild = null;
  const claudeArmPromise = args.claudeArm
    ? (async () => {
        const prompt = claudeArmPrompt(scopeBlock, { repoRoot });
        const tag = callTag(
          CLAUDE_ARM_TAG,
          promptCallDigest({ prompt, schema: null, model: CLAUDE_MODEL }),
        );
        const raw = await callCached(ckpt, tag, () =>
          runClaudeArm({
            claudeBin: 'claude',
            model: CLAUDE_MODEL,
            effort: EFFORT,
            prompt,
            repoRoot,
            env: cleanClaudeEnv(),
            onChild: (child) => {
              claudeArmChild = child;
            },
          }),
        );
        let classified = classifyClaudeArmResult(raw, { files, model: CLAUDE_MODEL });
        // No modelUsage in the envelope (older CLI / shape change) — the ONE
        // pinned fallback source (never a date table).
        if (classified.status === 'ok' && classified.resolvedVia === 'unavailable') {
          const version = probeClaudeVersion('claude');
          if (version) {
            classified = { ...classified, resolvedVia: 'harness-version', harnessVersion: version };
          }
        }
        // costUsd/turns are logged on BOTH branches — a failed call can still
        // have burned real quota (the incident that motivated the delimiter
        // fix billed $1.78 / 34 turns for zero coverage) and that must never
        // be invisible just because there's no candidate to show for it.
        const costNote =
          classified.costUsd != null || classified.turns != null
            ? ` [$${classified.costUsd ?? '?'}, ${classified.turns ?? '?'} turns]`
            : '';
        if (classified.status.startsWith('failed')) {
          log(
            `claude-arm: ${classified.status} — SOFT-FAIL, review CONTINUES on codex-only coverage${costNote}`,
          );
        } else {
          log(
            `claude-arm: ${classified.candidates.length} candidate(s) ` +
              `(${classified.tokens} tok, resolved ${classified.resolvedModel ?? '?'})${costNote}`,
          );
        }
        return classified;
      })()
    : (log('claude-arm: disabled (--no-claude-arm)'),
      Promise.resolve({
        status: 'disabled',
        candidates: [],
        tokens: 0,
        resolvedModel: null,
        resolvedVia: 'disabled',
        costUsd: null,
        turns: null,
      }));

  // claudeArmPromise (above) is already RUNNING in the background by this point (its async
  // IIFE started executing, and spawned its child, the instant it was constructed). Awaiting
  // the finders FIRST — not `Promise.all([finders, claudeArmPromise])` — is what makes the
  // task-5 cancellation below reachable while the arm may still be running, while the SUCCESS
  // path stays exactly as concurrent as before (by the time the 11-angle+retries fan-out
  // finishes, the arm's single call has almost always already settled in the background).
  const finderRun = await runFindersWithRetry({
    ckpt,
    outDir,
    repoRoot,
    codexBin,
    scopeBlock,
    files,
    concurrency: args.concurrency,
  });
  tokens.finders += finderRun.tokens;

  // A failed finder means an angle produced ZERO coverage even after retry — proceeding would
  // let record-review stamp a PASS over an unreviewed diff (the false-clean outcome the exit-2
  // contract exists to prevent). Errored calls are never checkpointed as final, so a rerun with
  // the same --out retries ONLY these.
  if (finderRun.finderErrors.length > 0) {
    // plan 3369, task 5: cancel the sibling Claude arm — this review will never be reported, so
    // an in-flight (or not-yet-started) arm call has nothing left to contribute, and left alone
    // it would run until it finishes on its own or the liveness probe (plan 3966) eventually
    // kills it, all the while billing real Claude quota. Best-effort: null when the arm is
    // disabled, already finished, or never got far enough to spawn (nothing to kill).
    if (claudeArmChild) killProcessTree(claudeArmChild);
    console.error(
      `[gpt-review] ${finderRun.finderErrors.length} finder call(s) failed after ${MAX_FINDER_RETRIES} ` +
        `retry round(s) — incomplete coverage, refusing to report a review:\n` +
        finderRun.finderErrors.map((e) => `  - ${e}`).join('\n') +
        `\n[gpt-review] re-run with --out ${outDir} to retry only the failed calls, or fall back to /sonnet-review.`,
    );
    process.exit(2);
    return;
  }

  const claudeArm = await claudeArmPromise;
  const allCandidates = finderRun.candidates.concat(claudeArm.candidates);
  log(
    `finders done: ${allCandidates.length} total candidate(s) ` +
      `(codex ${finderRun.candidates.length} + claude-arm ${claudeArm.candidates.length})`,
  );

  let kept = [];
  let refuted = [];
  let verifyStats = { verifierAgents: 0, escalated: 0 };
  if (allCandidates.length > 0) {
    const verified = await verifyGroups(
      ckpt,
      outDir,
      repoRoot,
      codexBin,
      scopeBlock,
      allCandidates,
      tokens,
      args.concurrency,
    );
    kept = verified.kept;
    refuted = verified.refuted;
    verifyStats = verified.stats;
  }

  const findings = shapeFindings(kept);
  const refutedShaped = shapeRefuted(refuted);
  writeFileSync(join(outDir, 'findings.json'), JSON.stringify(findings, null, 2) + '\n');
  writeFileSync(join(outDir, 'refuted.json'), JSON.stringify(refutedShaped, null, 2) + '\n');
  // record-review.mjs --review-stats shape (stats.finders / verifierAgents / escalated) —
  // `stats` stays codex-angle-only (unchanged meaning: FINDERS.length is the codex
  // roster, not codex+claude); the Claude arm gets its OWN top-level key rather than
  // being folded into `stats`, so record-review's f=/v=/adj= counts keep meaning
  // exactly what they meant before plan 2766. record-review.mjs reads named fields
  // (not additionalProperties:false), so this sibling key is inert to every existing
  // reader and simply available to a future one.
  writeFileSync(
    join(outDir, 'stats.json'),
    JSON.stringify(
      {
        identity: {
          fingerprint: reviewIdentity,
          endSha: resolvedShas.at(-1),
          rangeLabel,
          writtenAt: new Date().toISOString(),
        },
        stats: {
          finders: FINDERS.length,
          candidates: allCandidates.length,
          verifierAgents: verifyStats.verifierAgents,
          escalated: verifyStats.escalated,
          reported: findings.length,
        },
        // plan 3369, task 1: per-angle status — a finderErrors-non-empty run never reaches
        // this write (see the exit-2 branch above), so every row here is 'ok' or 'retried-ok'
        // in practice; the enum still documents all four for a future reader of this field.
        finderStatus: finderRun.angleStatus,
        // plan 3369, task 3 / fix round 1 (b65c47/3e458e): buildScopeStatsField gates on
        // `pathScopeDroppedCount > 0` — see its own header for the false-record rationale.
        // `excludedFileCount` is THIS layer's own drop count (matching pathScopeNote's own
        // number above), not the combined built-in+layer total — review-diff-scope.mjs's own
        // `excludedNote()` already describes the built-in layer's count separately.
        // record-review.mjs surfaces this to a later reader (its own console output AND, since
        // fix round 1, the recorded review marker's provenance), so a narrowed review is never
        // silently indistinguishable from a full one.
        ...buildScopeStatsField(pathScopeDroppedCount, {
          userPaths: args.paths,
          userExcludePaths: args.excludePaths,
          autoExcludedGlobs,
        }),
        claudeArm: {
          status: claudeArm.status, // 'ok' | 'disabled' | 'failed: <reason>'
          model: CLAUDE_MODEL,
          resolvedModel: claudeArm.resolvedModel,
          resolvedVia: claudeArm.resolvedVia,
          candidates: claudeArm.candidates.length,
          tokens: claudeArm.tokens,
          // Real operator-facing spend, present even on a FAILED run — a call
          // can burn quota and turns before its answer is lost (the incident
          // that motivated the delimiter fix: $1.78 / 34 turns, 0 coverage).
          costUsd: claudeArm.costUsd,
          turns: claudeArm.turns,
          // Only set when the envelope carried no modelUsage and the version
          // probe supplied the stamp instead. Written so the fallback leaves
          // committed evidence: without it the branch below (resolvedVia
          // 'harness-version') computes a value that reaches no surface at
          // all, so nobody can tell a probe-stamped run from a normal one.
          ...(claudeArm.harnessVersion ? { harnessVersion: claudeArm.harnessVersion } : {}),
          // Non-object entries dropped from the candidates array (0 on every
          // healthy run); a non-zero value here means the arm's JSON shape is
          // drifting and the prompt contract needs a look.
          ...(claudeArm.malformed ? { malformedCandidates: claudeArm.malformed } : {}),
        },
        ...buildPastCapStatsField(args.pastCapReason),
      },
      null,
      2,
    ) + '\n',
  );

  // Codex total ONLY — the Claude arm's tokens are a SEPARATE bucket (different
  // subscription, not the same currency; see the file header) and are reported
  // in their own summary section below, never summed in here.
  const totalTokens = tokens.scope + tokens.finders + tokens.verify.total + tokens.adjudicate.total;
  const byVerdict = { CONFIRMED: 0, PLAUSIBLE: 0, UNVERIFIED: 0 };
  for (const f of findings) byVerdict[f.verdict] = (byVerdict[f.verdict] || 0) + 1;
  // Cost/turns are a real per-review number the operator has to weigh — shown
  // whenever the terminal result event carried them, on BOTH the ok and
  // failed branches (a failed call can still have burned real spend; see the
  // costUsd/turns comment on the stats.json write above).
  const claudeArmSpend =
    claudeArm.costUsd != null || claudeArm.turns != null
      ? ` [$${claudeArm.costUsd ?? '?'}, ${claudeArm.turns ?? '?'} turns]`
      : '';
  const claudeArmLine =
    claudeArm.status === 'disabled'
      ? 'DISABLED (--no-claude-arm)'
      : claudeArm.status === 'ok'
        ? `OK — ${claudeArm.candidates.length} candidate(s), ${claudeArm.tokens} tok ` +
          `(claude-sonnet quota — SEPARATE from the codex tokens below, not the same currency), ` +
          `resolved model ${claudeArm.resolvedModel ?? '(unavailable)'} via ${claudeArm.resolvedVia}${claudeArmSpend}`
        : `FAILED — ${claudeArm.status.replace(/^failed:\s*/, '')} — review CONTINUED on codex-only ` +
          `coverage (the pre-2766 status quo); this is a degradation, not a clean review${claudeArmSpend}`;
  const summaryMd =
    `# gpt-review\n\n` +
    // rangeLabel, not args.range: on the default path the review is pinned to a RESOLVED
    // (mergeBase, headSha) pair, and printing the symbolic `origin/master...HEAD` instead
    // described a range that may already have moved by the time the summary is read
    // (gpt-review round 4). An explicit --range prints verbatim — rangeLabel IS that string.
    `Range: \`${rangeLabel}\`${args.endRef ? ` (historical, end-ref \`${args.endRef}\`)` : ''}\n` +
    `Files changed: ${files.length}\n` +
    // plan 3369, task 3: named here too (not only in stats.json's `scope`), so a human
    // reading the artifact directly sees that a data tree was out of the reviewed set.
    (pathScopeNote ? `${pathScopeNote}\n` : '') +
    // Byte-identical to the pre-2766 line when the arm didn't contribute
    // (disabled/failed/not-run) — only an 'ok' run appends the extra clause.
    `Finders: ${FINDERS.length} angles${claudeArm.status === 'ok' ? ' + 1 claude-arm' : ''}, ${allCandidates.length} candidates surfaced\n` +
    `Findings kept: ${findings.length} (CONFIRMED ${byVerdict.CONFIRMED}, PLAUSIBLE ${byVerdict.PLAUSIBLE}, UNVERIFIED ${byVerdict.UNVERIFIED})\n` +
    `Refuted (dropped): ${refutedShaped.length}\n\n` +
    `## Claude data-grounding arm (plan 2766)\n` +
    `${claudeArmLine}\n\n` +
    `## Tokens (codex only — see the Claude arm section above for its separate total)\n` +
    `- scope-summary: ${tokens.scope}\n` +
    `- finders: ${tokens.finders}\n` +
    `- verify (Luna): ${tokens.verify.total}\n` +
    `- adjudicate (Sol): ${tokens.adjudicate.total}\n` +
    `- total: ${totalTokens}\n\n` +
    (findings.length > 0
      ? '## Findings\n\n' +
        findings
          .map((f) => `- [${f.verdict}] ${f.file}:${f.line ?? '?'} (${f.angle}) — ${f.summary}`)
          .join('\n') +
        '\n'
      : '## Findings\n\n(none survived verification)\n');
  writeFileSync(join(outDir, 'summary.md'), summaryMd);

  log(
    `DONE. ${findings.length} finding(s) kept, ${refutedShaped.length} refuted, ${totalTokens} total tokens.`,
  );
  log(`findings: ${join(outDir, 'findings.json')}`);
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`[gpt-review] fatal: ${e.stack || e.message}`);
    process.exit(2);
  });
}
