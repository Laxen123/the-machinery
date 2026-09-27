#!/usr/bin/env node
// scripts/coord/drain-run.mjs — the autonomous `ready/`-queue drain driver (plan 231).
//
// DETERMINISTIC CODE, NOT an LLM session. The driver itself never reasons; it
// loops, and on each iteration spawns a FRESH `claude -p` subprocess that runs
// the full pickup-plan → execute → verify protocol in a clean context, then
// exits returning a compact JSON result. The driver's memory therefore grows by
// ONE summary per plan — never a full transcript — which is what keeps a long
// unattended run from bloating / triggering summarization (plan 231
// "Architecture — thin code driver + fresh per-plan context").
//
// Serial by design: one plan at a time. No concurrent plan execution → no
// index.lock collisions WITHIN the drain (only one git op ever in flight).
//
// Cost circuit-breakers (the human kill-switch — plan 231 "Cost circuit-breakers"):
//   - DRAIN_SPEND_CEILING_USD (default $10/run): a HARD stop, never auto-raised.
//   - Quarantine, never retry: a gate failure moves the plan to waiting-operator/
//     (Blocked-by: gate failure in drain <date>). 2 quarantines halt the loop.
//     Blind retry is the $100-Opus failure mode — excluded.
//   - Pause-and-ask before any plan declaring Cost forecast > $5 or with no cost
//     section (the one place the drain blocks for input).
//   - The driver NEVER auto-dispatches a claude -p fan-out (price pipeline,
//     profile inspector). If a plan needs one, that surfaces at the cost-pause.
//
// Phase 2 (this build): stops SHORT of landing — execute + verify, then leave
// the worktree on its pushed branch and pause for operator confirm before
// done-worktree. Phase 3 enables auto-land for `Cost forecast: $0` plans only.
//
// Driver default (operator decision 2026-05-30): `claude -p` per plan, with
// subagent-per-plan kept as the documented fallback if claude -p re-auth proves
// fragile (swap `makeClaudeRunner` for an Agent-dispatch runner — see the
// `drain` skill). Spend ceiling: $10/run, no per-plan cap.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';

const execFileP = promisify(execFileCb);
import {
  resolveMain,
  gitWithLockRetry,
  git,
  abortRebaseAndDiagnose,
  captureRebaseBaseline,
  verifyRebaseReplay,
  gitMoveCommit,
  isNonFastForward,
  isForeignDirtRefusal,
  pushMasterWithRebase,
  coordWrite,
  backoffMs,
  retryOnForeignDirt,
  withCoordLock,
  readTrackedFileFresh,
} from './coord-git.mjs';
// normalizeConfig (review fix, finding 429f60): readOperatorSpendCeilingUsd's malformed-config
// fallback delegates to it (fed ONLY the one field it cares about) instead of re-implementing
// normalizeConfig's own operatorSpendCeilingUsd acceptance predicate a second time. derivePaths
// (review round 2, R2-3): boardFileRelOf's own narrow-field fallback below mirrors that same
// pattern for the board path.
import { loadCoordConfig, normalizeConfig, derivePaths } from './coord-config.mjs';
import { splitBoard, findRowLineIndex, cellsOf } from './board-lib.mjs';
import { planBasenameMap, validateRowInContent } from './lint-board.mjs';
import {
  EXIT as SPINE_EXIT,
  landSeamDisposition,
  landResumeCommand,
} from './done-worktree-lib.mjs';
import {
  stampWaitingOperatorStatus,
  stampLandBlockedResume,
  getUnblock,
  setUnblock,
} from './plan-body-state.mjs';
// review round 2 (R2-9, key 79 efficiency): the canonical axis vocabulary + the `[axis: …]`
// marker regex now live in the zero-import leaf module scripts/coord/axis-tags.mjs (move-plan.mjs
// imports and re-exports the same bindings under these names) instead of coming from
// move-plan.mjs directly — importing that module pulled in its whole heavyweight CLI surface
// (node:fs, child_process, ~15 coordination modules) for three constants + one regex.
import { AXIS_TAGS_BY_UNBLOCK, AXIS_TAG_RX } from './axis-tags.mjs';
// blocked-by-lib.mjs (review round 2, R2-1): the ONE canonical Blocked-by matcher/rewriter,
// already shared by close-out.mjs, done-worktree-lib.mjs, lint-stale-blocked.mjs and
// plan-body-state.mjs — parkToWaitingOperator below is now a CONSUMER, never a second
// hand-rolled detector/replacer over the same convention.
import { blockedByLines, rewriteFirstBlockedByLine } from './blocked-by-lib.mjs';
import { flipStatusToInProgress } from './claim-plan-lib.mjs';
// plan 2426: the write-time board gate. The drain is the OTHER unwired path plan 2378's
// review fan-out found — `movePlanOnMaster` is a second, parallel `HUSKY=0` implementation
// of the same ready/ → in-progress/ folder crossing, on the SHARED MAIN checkout.
import {
  assertBoardInvariantsForPending,
  blockedViewFor,
  gateAppliesToFolder,
  loadCorpusView,
  BoardInvariantError,
} from './board-write-gate.mjs';
import {
  escapeRegex,
  PLAN_FOLDER_ALT,
  IN_PROGRESS_FOLDER,
  READY_FOLDER,
  WAITING_OPERATOR_FOLDER,
  // plan 3960 cluster-2 review fix: the configured SEED-WRITE label — see
  // renderCarryForwardPlanBody's own comment.
  MUTATION_BANNER_LABEL,
  // plan 4069 (task 5): classifyPlanSpend's own two reads — the durable `spendClass:`
  // frontmatter stamp, and the `## Tasks` section text the path-heuristic fallback scans.
  readFrontmatterScalar,
  sectionBounds,
  // Review round 2 (R2-1): insertBlockedByLine's anchor chain — the SAME primitives
  // plan-body-state.mjs's setStatusLine already composes for "banner, else H1, else right
  // after frontmatter, else prepend" — never a fresh regex over plan-body Markdown.
  SEED_BANNER_RX,
  H1_RX,
  splitFrontmatter,
  spliceAtMatch,
  insertAfterFrontmatterOrPrepend,
} from './build-index-lib.mjs';
import { worktreePathFor } from './cut-worktree.mjs';
import { sanctionedRebaseEnv } from './pre-rebase-main-guard.mjs'; // plan 2933
import { findScriptsDir } from './scripts-anchor.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';

// retryOnForeignDirt moved to coord-git.mjs (plan 665) so the done-worktree --wait spine
// reuses the SAME implementation as the drain (it lives with isForeignDirtRefusal + backoffMs,
// its only deps). Re-exported here so existing drain imports/tests keep their import path.
// NOTE: the drain's internal call sites don't pass a `log`, so their foreign-dirt retry-progress
// lines now print under the new default `[coord]` prefix instead of `[drain]` (cosmetic only —
// no code or test depends on the prefix). Imported below for drain-internal use AND re-exported.
export { retryOnForeignDirt };

// Classify a board.mjs write-time cell-lint refusal (board.mjs assertCellLintClean,
// plan 511): board.mjs refused to write a worker's "Plan / claim" cell because it
// fails lint-board with NO_PLAN_REF — the plan's basename category segment is not the
// required `NNN-[A-Z]…` shape (e.g. a lowercase category like `811-price-…`), so
// lint-board's PLAN_REF_RX never matches and the cell would block every sibling push.
// Unlike a foreign-dirt refusal (isForeignDirtRefusal — TRANSIENT, retry-and-clear),
// this is DETERMINISTIC: the slug is structurally un-claimable until its basename is
// hand-fixed, so retrying never helps. The driver parks the offending plan to
// waiting-operator/ and CONTINUES the FILL loop (plan 817) rather than letting the
// refusal crash the whole run and abandon the in-flight workers (the 2026-06-18 drain
// crash on 811's slug, exit 2). Matched on two stable anchors — board.mjs's refusal
// wording ("lint-poisoned" at write time / "fails lint-board" via verifyBoardRowLintClean)
// AND the NO_PLAN_REF kind — surviving a subprocess round-trip via e.stderr.
export function isBoardLintRefusal(e) {
  const out = `${e?.stdout || ''}${e?.stderr || ''}${e?.message || ''}`;
  return /lint-poisoned|fails lint-board/.test(out) && /NO_PLAN_REF/.test(out);
}

// plan 4096 T2: anchored on the `scripts/` directory NAME (scripts-anchor.mjs), not on this file's
// own depth — every spawn target below (board.mjs, done-worktree.mjs, queue-drain.mjs, …) is a
// top-level scripts/ command, and this module now lives one level down in scripts/coord/.
const HERE_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = findScriptsDir(HERE_DIR) ?? HERE_DIR;
export const DEFAULT_CEILING_USD = 10;
export const MAX_QUARANTINES = 2;
export const PAUSE_COST_THRESHOLD_USD = 5;

// plan 4069 (task 5, R1; review round 2 keys 6a70ae/853db6/066a1a; review round 3 item 7): the
// operator's own per-plan spend ceiling — read through the canonical `loadCoordConfig()` seam
// instead of a second hand-rolled `fs`/`JSON.parse` read of `coord.config.json`. coord-config.mjs's
// `normalizeConfig` carries `operatorSpendCeilingUsd` as a normalized field (accepting only a
// finite positive number; anything else — absent, malformed, zero, negative, wrong type — falls
// back to DEFAULT_OPERATOR_SPEND_CEILING_USD there, which is the same $5 as PAUSE_COST_THRESHOLD_USD
// here), so the happy path is a thin read of that already-normalized value.
//
// Round 2's bare `catch { return PAUSE_COST_THRESHOLD_USD }` was too blunt: `normalizeConfig`
// throws on ANY invalid field in the whole file (e.g. a malformed `shardIdPattern` or
// `scopeMaxKeys`), not just an invalid `operatorSpendCeilingUsd` — so an unrelated config-
// authoring mistake elsewhere silently collapsed the money ceiling to $5, tightening the drain's
// spend gate for a reason that has nothing to do with money. On a throw, fall back to a TARGETED
// raw read of just the one key this function cares about (mirroring
// coord-config.mjs's own `normalizeOperatorSpendCeilingUsd` acceptance rule — finite, positive,
// numeric — without going through the rest of normalizeConfig's validation), and only THEN give up
// to the $5 default (a second throw here means the file itself is unreadable/malformed JSON, the
// same total-failure case round 2 already covered).
export function readOperatorSpendCeilingUsd(mainDir) {
  try {
    return loadCoordConfig(mainDir).operatorSpendCeilingUsd;
  } catch {
    // Review fix (finding 429f60): delegate to the ONE canonical acceptance rule
    // (normalizeConfig's own normalizeOperatorSpendCeilingUsd) instead of re-implementing its
    // predicate here a second time, where the two could silently diverge. Feeding normalizeConfig
    // ONLY the raw ceiling value (never the rest of `raw`) means every OTHER field sits at its own
    // DEFAULTS value — always valid — so this call can never itself throw on the SAME unrelated
    // field that made the loadCoordConfig() call above throw.
    try {
      const raw = JSON.parse(readFileSync(join(mainDir, 'coord.config.json'), 'utf8'));
      return normalizeConfig({ operatorSpendCeilingUsd: raw && raw.operatorSpendCeilingUsd })
        .operatorSpendCeilingUsd;
    } catch {
      return PAUSE_COST_THRESHOLD_USD;
    }
  }
}

// plan 4069 (task 5, R2/R3): a plan's own `## Tasks` section, for the path-heuristic half of
// classifyPlanSpend below. Level-aware, fence-aware — the shared build-index-lib scanner, not a
// re-rolled one.
// Review fix (finding ef209c): singular OR plural — real plans overwhelmingly use singular
// per-item headings ("## Task 1 — …", "## Task 1: Spike …"), and the old plural-only literal
// made those plans fall through to the uncertain⇒data-pass branch, defeating R1's ceiling on
// the exact shape it was meant to gate. Still anchored to a heading line, never widened to scan
// the whole body (see classifyPlanSpend's own comment on why that direction was reverted).
//
// Review round 2 (R2-4, key 185 altitude): `.*\btasks?\b` matched a heading merely CONTAINING
// the word anywhere ("## Task-force notes" — "Task" bounded by the following hyphen). Anchored to
// a genuine Tasks-section heading instead: "Task"/"Tasks" must be the FIRST word after the
// hashes — round 2 then enumerated an allowed-suffix punctuation set (colon, em/en dash), which
// over-corrected: it went right back to rejecting real committed plans' heading shapes, e.g.
// `## Tasks (sketch)` and `## Tasks, in stage order` (round 3, key 209, six finders including the
// corpus-grounded Claude arm). Fixed at the PREDICATE instead of the suffix list — the second
// swing of this pendulum is the last: "Task"/"Tasks" is the first word, and after it, anything
// may follow EXCEPT a word character or hyphen (which would mean "task" merely began a longer
// word — "Task-force", "Tasking", "Subtasks"). `## Tasks`, `## Tasks (sketch)`,
// `## Tasks, in stage order`, `## Task 1 — …`, `### Tasks:`, `## Task 1: Spike` all match;
// `## Task-force notes`, `## Tasking`, `## Subtasks deferred` still do not.
// Round-3 re-review (keys 1o88dsp/6cl5x6): the lookahead was `(?![\w-])`, and `\w` is ASCII-only —
// so a NON-ASCII letter glued on ("## Tasksé", "## Tasksåäö", in a Swedish repo) slipped through as
// the Tasks section and could flip a genuine data pass to `code-change`, skipping ruling R2's
// mandatory ask. Unicode-aware now (`\p{L}\p{N}_` under `u`), which is the same predicate — "Task"
// or "Tasks" is the whole first word — expressed over all letters instead of only ASCII ones.
const TASKS_HEADING_RX = /^#{1,6}\s+Tasks?(?![\p{L}\p{N}_-])/iu;
// A file under one of the code roots — the deterministic test R2/R3 specify: does the plan's
// diff touch code, or is it only a data pass (seed/store/observation writes, no code)? Fix round
// 1 (finding E) fixed four defects here:
//   1. backend/src/data/seed/** is record DATA, not code (excluded via the negative lookahead
//      on the `backend/src/` alternative — every OTHER backend/src/** path still matches).
//   2. `frontend/src/**` was missing from the roots — added.
//   3. `(?<![\w/])` anchors each root to a real path start, not a NESTED occurrence — a doc
//      path that happens to carry a `scripts/` segment further in no longer matches on that
//      trailing occurrence.
//   4. classifyPlanSpend below used to fall back to scanning the WHOLE body — REVERTED in round 3
//      (item 1 below); see classifyPlanSpend's own comment.
// Fix round 3 (items 3+4) fixed two more:
//   5. The seed exclusion only excluded DESCENDANTS written with a trailing slash
//      (`data/seed/…`) — a bare mention of the seed ROOT itself (`backend/src/data/seed`, no
//      trailing slash) still fell through to the `backend/src/` alternative and matched as code.
//      `(?!data\/seed(?![\w-]))` excludes both: it fails to exclude only when "data/seed" is
//      immediately followed by a further word/hyphen char (a genuinely different, longer path
//      segment, e.g. a hypothetical `data/seedling/`), which is deliberately still code.
//   6. `(?<![\w/])` let a root match after ANY non-word/non-slash punctuation, including a
//      nested/mid-word occurrence like `x.scripts/foo.mjs` (preceded by `.`, which is neither a
//      word char nor `/`, so the old lookbehind admitted it). A root must now start at a REAL
//      path start — the very beginning of the plan body, or right after whitespace or an opening
//      quote/backtick/paren — never after arbitrary punctuation like a bare dot.
// Review round 2 (R2-5, key 208 angle-A): the lookbehind admitted a preceding backtick or `(`
// (so `` `scripts/<name>.mjs` `` and a markdown link's TARGET, `[the runner](scripts/<name>.mjs)`,
// already counted) but not a preceding `[` — so a path named as a link's own TEXT
// (`[scripts/<name>.mjs](docs/<page>.md)`) fell through uncounted. Added to the class.
const CODE_CHANGE_PATH_RX =
  /(?<=^|[\s"'`([])(?:backend\/scripts\/|backend\/src\/(?!data\/seed(?![\w-]))|frontend\/src\/|shared\/src\/|scripts\/)/;

// plan 4069 (task 5): "does this plan CHANGE the pipeline / fix a bug, including the rerun that
// proves the fix" (code-change — the full ceiling applies) vs "is this plan's work a bulk data
// pass over records with no code change behind it" (data-pass — R2's "always asks" applies
// regardless of the ceiling). `spendClass:` frontmatter is the DURABLE form and is checked
// FIRST (a plan's own explicit self-classification always wins); the path heuristic — does the
// `## Tasks` section name a file under `backend/scripts/**`, `backend/src/**`, `shared/src/**`,
// or `scripts/**` — is the fallback when the key is absent. Reads the plan's OWN file straight
// off `mainDir`: the oracle's `plan` object (queue-drain.mjs's `parsePlanMeta` return shape)
// carries slug/path/cost, never frontmatter or task text, so this is a second, targeted read of
// the one plan actually sitting at the spend gate — not a second full-`ready/`-corpus scan.
//
// Fix round 3 (item 1, REVERTS round 1 finding E.4): a plan with no `## Tasks` heading used to
// fall back to scanning the WHOLE body for a code-root mention. That let incidental narrative
// prose ("this fixes a bug in `scripts/<name>.mjs`") flip a genuine data-only rerun to code-change
// and skip R2's cash-forecast pause — the governing principle for this whole function is that an
// AMBIGUOUS case always resolves to data-pass (ask), never to code-change, because a false ask
// costs one operator click and a false code-change costs up to the ceiling in unapproved spend. No
// `## Tasks` section ⇒ 'data-pass' unconditionally; a plan that genuinely wants the full ceiling
// declares `spendClass: code-change` explicitly in frontmatter (checked above, first).
//
// Fix round 3 (item 2, REVERTS the R1-era rule below): an unreadable plan file used to classify as
// 'code-change' on the theory that it was a genuine anomaly, not a data-pass signal. Under the same
// governing principle that is backwards — an unreadable plan is MAXIMAL uncertainty, not a hint
// toward the less-restrictive branch, so it now returns 'data-pass' (ask) like every other
// ambiguous case.
export function classifyPlanSpend(mainDir, planPath) {
  let content;
  try {
    content = readFileSync(join(mainDir, planPath), 'utf8');
  } catch {
    return 'data-pass';
  }
  const spendClass = readFrontmatterScalar(content, 'spendClass').toLowerCase();
  if (spendClass === 'code-change') return 'code-change';
  if (spendClass === 'data-pass') return 'data-pass';
  const bounds = sectionBounds(content, TASKS_HEADING_RX);
  if (!bounds) return 'data-pass';
  const tasksText = content.slice(bounds.start, bounds.end);
  return CODE_CHANGE_PATH_RX.test(tasksText) ? 'code-change' : 'data-pass';
}
// Per-in-flight-worker spend reserve for the dispatcher pool's spawn gate
// (plan 518). The Cost-forecast banner forecasts the PLAN's own fan-out spend,
// not the worker session's claude -p cost, so the reserve is a flat empirical
// headroom figure, overridable via --reserve / DRAIN_RESERVE_USD.
export const DEFAULT_RESERVE_USD = 2.5;

// --- pure: the per-plan protocol prompt --------------------------------------

// The instruction handed to each fresh `claude -p` context. Workers NEVER land
// (plan 518): every worker — regardless of drain phase — builds, pushes,
// records its code review, and returns the JSON manifest; the DRIVER lands $0
// plans serially via the done-worktree spine. Phase semantics live entirely in
// the driver now, so `phase` is gone from this prompt.
export function buildPlanPrompt(plan) {
  const landRule =
    'DO NOT run done-worktree. DO NOT merge to master. Leave the worktree on its branch, ' +
    'pushed — the DRIVER lands it (or the operator does). If your diff touches application ' +
    'source (frontend/src/**, backend/src/**, shared/src/**, scripts/**), run /sonnet-review, ' +
    'fix the significant findings, then run `node scripts/record-review.mjs <PASS|NITS|BUGS-FOUND>` ' +
    'from the worktree AFTER your final commit — the sha-pinned marker is what lets the driver-side ' +
    "landing pass the spine's review seam without halting. CRITICAL (plan 1205): a NITS or " +
    'BUGS-FOUND verdict MUST also carry its findings, or the driver land HALTS at FINDINGS_OPEN ' +
    "with no worker left to clear it. So for a non-PASS verdict: write /sonnet-review's findings[] " +
    'array to a JSON file and pass `--findings <file>`, then disposition EVERY finding before you ' +
    'stop — `record-review.mjs disposition <key> --fixed` for ones you fixed in-diff, or file a ' +
    'plan (`next-plan-id.mjs claim …`) and `disposition <key> --plan <id>` for any you are deferring ' +
    '("pre-existing" is NOT an exemption). Record PASS (no findings) only if the review was clean.';
  // plan 3111: the oracle carries `adoptBranch` on a plan whose ready/ re-file declared that a
  // PREVIOUS execution's branch is dead work this plan INHERITS (a cap-killed cloud session, body
  // saying CONTINUE IT). This is the same continuation shape buildContinuationPrompt below already
  // uses for the granted-checkpoint case — the difference is only which branch is being resumed and
  // why. Without it the worker cuts a fresh empty branch off origin/master and redoes work that is
  // already committed and pushed.
  //
  // The stale-stamp fallback is spelled out rather than assumed: the field can legitimately be
  // present while origin no longer carries the branch (the plan landed and was torn down between
  // the stamp and this dispatch). `cut-worktree --adopt=<gone>` refuses loudly in that case, and
  // the right recovery is a normal cut, not a stall.
  const adopt = plan.adoptBranch || null;
  const adoptSuffix = adopt ? ` --adopt=${adopt}` : '';
  const adoptCutSource = adopt ? `\`origin/${adopt}\` (ADOPT MODE, see below)` : 'origin/master';
  // Review fix (plan 3111, findings 2/3 — CONFIRMED): the inspection command names
  // `origin/<adoptBranch>`, NOT the bare branch. `cut-worktree --adopt=claude/drain-<slug>`
  // creates the LOCAL branch `worktree-<slug>` from the remote override — it never creates a
  // local `claude/drain-<slug>` — so `git log origin/master..claude/drain-<slug>` dies with an
  // unknown-revision error and the worker cannot read the work it is supposed to inherit.
  // `origin/<branch>` is the one spelling that resolves for BOTH branch shapes.
  const adoptLines = adopt
    ? [
        `ADOPT MODE — this plan carries \`adoptBranch: ${adopt}\`. A PREVIOUS execution's work is ` +
          `already committed and pushed on that branch, and this plan was re-filed to ready/ ` +
          `expecting the next taker to CONTINUE it. Do NOT restart the plan from scratch and do ` +
          `NOT re-do steps the branch already contains: read its log/diff first ` +
          `(\`git fetch origin master && git log --oneline origin/master..origin/${adopt}\` — the ` +
          `fetch matters because in adopt mode cut-worktree fetches only the ADOPTED branch, so ` +
          `a stale local origin/master would make that range list already-landed commits; and the ` +
          `right-hand side is the REMOTE-tracking ref, because ` +
          `\`cut-worktree --adopt\` checks the work out onto the local branch worktree-${plan.slug}, ` +
          `so a bare "${adopt}" may not resolve locally), re-derive which of the plan's steps and ` +
          `gates are already done FROM THE BRANCH, and carry on from there. If the ` +
          `\`--adopt=${adopt}\` cut is REFUSED because origin no longer carries that branch, the ` +
          `stamp is stale (the work landed): cut normally with ` +
          `\`node scripts/cut-worktree.mjs ${plan.slug}\` and execute the plan as usual.`,
      ]
    : [];
  // Review fix (plan 3111, finding 17 — CONFIRMED): in adopt mode cut-worktree fetches the
  // ADOPTED branch, not master (`exec(['fetch','origin', adopt ? srcBranch : 'master'])`), so the
  // stock "it fetches origin master first" clause was a false statement about the very command
  // the worker is told to run. Say what each mode actually does.
  const adoptFetchClause = adopt
    ? `it fetches \`${adopt}\` from origin first, then cuts`
    : 'it fetches origin master first, then cuts';
  return [
    'You are a deterministic plan-execution worker invoked by the autonomous ready/-queue drain (plan 231).',
    'Execute EXACTLY ONE plan, then STOP. Never pick up a second plan.',
    '',
    `Plan: ${plan.slug}  (file: ${plan.path})`,
    '',
    'Protocol:',
    '1. CLAIM IS ALREADY DONE BY THE DRIVER. The drain driver has already claimed this plan: it ' +
      '`git mv`-ed it to `docs/superpowers/plans/in-progress/' +
      `${plan.slug}.md\` on master AND wrote your ACTIVE board row on the coordination board (with a ` +
      'lint-clean "Plan / claim" cell) — that is YOUR claim, not a foreign one. Do NOT invoke ' +
      "pickup-plan's identify/claim gate, do NOT treat the in-progress location or the existing " +
      "board row as someone else's lock, and do NOT move the plan file again. NEVER compose or " +
      'rewrite the board row\'s "Plan / claim" cell — a free-formed cell with no plan filename ' +
      'fails lint-board (NO_PLAN_REF) and blocks every sibling push. To touch your row, use ONLY ' +
      `\`node scripts/board.mjs set-state ${plan.slug} <STATE>\` for state flips and ` +
      `\`node scripts/board.mjs update ${plan.slug}\` with --tip/--touched/--resume (never --plan-claim). ` +
      'Instead: create your worktree off the FRESH origin tip with ' +
      `\`node scripts/cut-worktree.mjs ${plan.slug}${adoptSuffix}\` (${adoptFetchClause} ` +
      `from ${adoptCutSource} and publishes the empty branch — never a stale local baseline), ` +
      '`pnpm install`, write your handoff session entry, then proceed.',
    ...adoptLines,
    '2. Execute the plan per its own steps (use test-driven-development / executing-plans as the plan dictates).',
    "3. Verify per verification-before-completion: run the plan's gates, capture each result with evidence.",
    `4. ${landRule}`,
    '5. Your FINAL message must be ONLY one JSON object (no prose, no code fence), matching exactly:',
    '   {"status":"completed"|"gate_failed"|"blocked","slug":"<slug>",',
    '    "shipped_sha":"<worktree branch tip sha>",',
    '    "gates":[{"name":"...","passed":true|false,"detail":"..."}],',
    '    "carry_forward":[{"kind":"open-new-plan"|"waiting-operator"|"wont-fix","title":"...","blurb":"...","seed_write":"yes"|"no"}],',
    '    "notes":"<one-line summary>"}',
    'If a gate fails, set status "gate_failed" and STOP — do not retry blindly (the drain quarantines instead).',
    'There are TWO kinds of "blocked", and shipped_sha is how the drain tells them apart:',
    '  (a) SKETCH / FAN-OUT block — you shipped NOTHING (no worktree built; e.g. the plan needs a ' +
      'claude -p fan-out like the price pipeline / profile inspector). Set status "blocked", LEAVE ' +
      'shipped_sha EMPTY, explain in notes — do NOT auto-dispatch the fan-out. The drain reverts the ' +
      'plan to ready/ for operator triage.',
    "  (b) WORK-PUSHED block — you BUILT + PUSHED your worktree branch but are blocked at the plan's " +
      'OWN operator checkpoint (e.g. a seed `--apply` approval the drain cannot grant). Set status ' +
      '"blocked", set shipped_sha to your pushed branch tip, and flip your board row to ⏸ PAUSED ' +
      `(\`node scripts/board.mjs set-state ${plan.slug} PAUSED\`) before ` +
      'returning. The drain files the plan to waiting-operator/ and KEEPS your worktree for the operator ' +
      'to land — a non-empty shipped_sha is what tells it your work exists. NEVER report a fabricated sha.',
  ].join('\n');
}

// The instruction for a CONTINUATION worker (plan 518 interactive blocked-plan
// triage): the operator granted the plan's own operator checkpoint at the
// 'blocked_triage' prompt, so a fresh context resumes the FIRST worker's pushed
// branch and finishes the plan. The plan file is still in in-progress/ — a
// granted block is never parked.
export function buildContinuationPrompt(plan, shippedSha) {
  return [
    'You are a deterministic plan-execution worker invoked by the autonomous ready/-queue drain (plan 231).',
    "CONTINUATION RUN: the OPERATOR has GRANTED this plan's own operator checkpoint (the gate a previous",
    'worker blocked at). Resume and finish EXACTLY ONE plan, then STOP.',
    '',
    `Plan: ${plan.slug}  (file: docs/superpowers/plans/in-progress/${plan.slug}.md)`,
    `Existing work: branch \`worktree-${plan.slug}\` is already pushed @ ${shippedSha}.`,
    '',
    'Protocol:',
    `1. Do NOT re-claim and do NOT recreate the worktree if ${worktreePathFor(plan.slug)} exists — ` +
      '`git fetch origin` and continue on the existing branch. Only if the directory is missing, ' +
      `recreate it from the pushed branch: \`git worktree add ${worktreePathFor(plan.slug)} worktree-${plan.slug}\`.`,
    `2. Flip your board row back to ACTIVE: \`node scripts/board.mjs set-state ${plan.slug} ACTIVE\`.`,
    '3. The checkpoint is GRANTED — proceed THROUGH it (e.g. run the gated `--apply` step) and complete ' +
      "the plan's remaining steps + gates per verification-before-completion.",
    '4. DO NOT run done-worktree. DO NOT merge to master. Push your commits; if the diff touches ' +
      'application source (frontend/src/**, backend/src/**, shared/src/**, scripts/**), run /sonnet-review ' +
      'and `node scripts/record-review.mjs <PASS|NITS|BUGS-FOUND>` AFTER your final commit. A non-PASS ' +
      'verdict MUST carry findings (`--findings <file>`) AND have every finding dispositioned ' +
      '(`disposition <key> --fixed|--plan <id>`) or the driver land halts at FINDINGS_OPEN (plan 1205).',
    '5. Your FINAL message must be ONLY one JSON object (no prose, no code fence), matching exactly:',
    '   {"status":"completed"|"gate_failed"|"blocked","slug":"<slug>",',
    '    "shipped_sha":"<worktree branch tip sha>",',
    '    "gates":[{"name":"...","passed":true|false,"detail":"..."}],',
    '    "carry_forward":[{"kind":"open-new-plan"|"waiting-operator"|"wont-fix","title":"...","blurb":"...","seed_write":"yes"|"no"}],',
    '    "notes":"<one-line summary>"}',
  ].join('\n');
}

// --- pure: result parsing ----------------------------------------------------

// Extract the worker's JSON manifest from the `result` text of a `claude -p
// --output-format json` envelope. The worker is told to emit ONLY JSON, but we
// tolerate a surrounding code fence / leading prose by grabbing the last
// balanced {...} block.
export function parsePlanResult(resultText) {
  if (!resultText || typeof resultText !== 'string') {
    throw new Error('drain-run: empty worker result');
  }
  const start = resultText.indexOf('{');
  const end = resultText.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('drain-run: no JSON object in worker result');
  }
  let obj;
  try {
    obj = JSON.parse(resultText.slice(start, end + 1));
  } catch (e) {
    throw new Error(`drain-run: worker result is not valid JSON: ${e.message}`);
  }
  if (!obj.status) throw new Error('drain-run: worker result missing status');
  return obj;
}

// completed | gate_failed | blocked | error (parse/spawn failure)
export function classifyOutcome(result) {
  if (!result || result.error) return 'error';
  const s = result.status;
  if (s === 'completed' || s === 'gate_failed' || s === 'blocked') return s;
  return 'error';
}

// Distinguish a WORK-PUSHED block from a sketch/fan-out block. A `blocked` result
// that carries a real shipped_sha means the worker BUILT and PUSHED a worktree
// branch before blocking on the plan's own operator checkpoint (e.g. an A4 seed
// `--apply` gate the drain can't grant) — that work must be PRESERVED (→
// waiting-operator/, worktree kept), not reverted to ready/ where the next pass
// rebuilds it (the pass-3 / plan-354 fallout). An empty/absent value, the dry-run
// sentinel, or a freeform placeholder ("none"/"n/a") means nothing shipped →
// revert to ready/ as before. We require a git-sha shape (7–40 hex) so a worker's
// placeholder can never masquerade as shipped work.
export function blockedHasShippedWork(result) {
  const sha = result && typeof result.shipped_sha === 'string' ? result.shipped_sha.trim() : '';
  return /^[0-9a-f]{7,40}$/i.test(sha);
}

// Round-robin the account profile for iteration N (0-based). Returns null when
// --accounts wasn't given (single-account default → spend on one subscription).
export function pickAccount(accounts, iteration) {
  if (!accounts || accounts.length === 0) return null;
  return accounts[iteration % accounts.length];
}

// Pause-and-ask gate: unknown cost (no cost section) OR a declared figure over the ceiling.
//
// plan 4069 (task 5) extends the fixed $5 threshold with the operator's own spend ceiling plus
// the code-change/data-pass split (R1-R3), WITHOUT breaking the pre-4069 call shape: `opts` is
// optional and `opts.ceilingUsd` defaults to the legacy `PAUSE_COST_THRESHOLD_USD` ($5), so a
// caller that passes no second argument (every pre-4069 call site and test) behaves
// byte-identically to before this plan. `opts.spendClass` is `'code-change' | 'data-pass' |
// undefined`; `undefined` (the plan was never classified — the caller genuinely doesn't know)
// keeps the OLD single-threshold rule unchanged — R2's "any non-zero cash always asks" side
// only ever applies once a plan has actually been run through `classifyPlanSpend`, never as a
// silent default for a cost object nothing classified. Unknown/absent cost still pauses
// unconditionally either way, exactly as it always has.
export function shouldPauseForCost(
  cost,
  { spendClass, ceilingUsd = PAUSE_COST_THRESHOLD_USD } = {},
) {
  if (!cost) return true;
  if (cost.unknown) return true;
  // Fix round 3 (item 6, REGRESSION): the R2 data-pass rule used to read `cost.usd != null &&
  // cost.usd > 0` alone, which misses a forecast like "Cash > $0" (`{ usd: 0, over: true }`) — an
  // explicitly-over figure at $0 let a paid data pass run unasked. Under the governing principle
  // (an ambiguous/declared-over figure always asks) a data pass now pauses on any positive OR
  // explicitly-over cash; absent/unknown cost still pauses unconditionally via the two checks above.
  if (spendClass === 'data-pass') return (cost.usd != null && cost.usd > 0) || !!cost.over;
  // Fix round 1 (finding D): `cost.over` (queue-drain.mjs's parsePlanCost) marks a figure that
  // came from a CEILING match — "Cash > $100" parses as `{ usd: 100, over: true }`, so a bare
  // `usd > ceilingUsd` compare (100 > 100) misses it. Honour the flag explicitly rather than
  // only the numeric compare.
  //
  // Fix round 3 (item 5, REGRESSION): round 1's fix honoured `cost.over` UNCONDITIONALLY,
  // regardless of which threshold produced it — "Cash > $10" parses as `{ usd: 10, over: true }`,
  // and that `over` flag then forced a pause against a $100 ceiling even though $10 is nowhere
  // near it (10 is nothing like over $100). `over` may only force the pause when the FIGURE IT
  // CAME FROM is itself at or above the ACTIVE ceiling — otherwise it is over some OTHER,
  // unrelated threshold (the banner's own ">", not this ceiling) and must not force anything.
  if (cost.usd != null && (cost.usd > ceilingUsd || (cost.over && cost.usd >= ceilingUsd)))
    return true;
  return false;
}

// --- pure: carry-forward extraction (plan 388) -------------------------------

// The worker returns a carry_forward[] manifest of follow-ups it found while
// executing the plan, each { kind, title, blurb, seed_write }. On a Phase-3
// auto-land the DRIVER mints the open-new-plan items (the deterministic spine
// done-worktree.mjs merges/archives/tears-down but never mints — state.newPlans
// is plumbed into its close-out commit yet nothing populates it, so every Phase-3
// drain silently dropped follow-ups; plan 388). Disposition by kind:
//   open-new-plan    → mint a real plan file (mintableCarryForwards selects these)
//   waiting-operator → ALREADY filed: it IS the block (a work-pushed block files
//                      the PARENT plan to waiting-operator/), so no new plan
//   wont-fix         → closed explicitly, no plan
// An item missing a kind/title, or carrying an unknown kind, is ignored (and
// surfaced by classifyCarryForwardKinds so it shows up in the run log).
export function mintableCarryForwards(carryForward) {
  return (carryForward || []).filter((c) => c && c.kind === 'open-new-plan' && c.title);
}

// Bucket a manifest by disposition for the audit log, so a non-minted item is
// visible in the run output rather than silently swallowed.
export function classifyCarryForwardKinds(carryForward) {
  const out = { mint: [], alreadyFiled: [], wontFix: [], ignored: [] };
  for (const c of carryForward || []) {
    if (c && c.kind === 'open-new-plan' && c.title) out.mint.push(c);
    else if (c && c.kind === 'waiting-operator') out.alreadyFiled.push(c);
    else if (c && c.kind === 'wont-fix') out.wontFix.push(c);
    else out.ignored.push(c);
  }
  return out;
}

// Derive a kebab-case slug from a carry-forward title, sanitised + length-bounded
// so it forms a valid plan-filename segment. Filename uniqueness across a batch is
// guaranteed by the distinct NNN- id prefix each minted plan gets, so two items
// with identical titles (same slug) still produce distinct files — no dedup here.
export function carryForwardSlug(title) {
  return (
    String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '') || 'carry-forward'
  );
}

// Render the markdown body for a minted carry-forward plan. The body is a STUB:
// it carries the follow-up's intent + provenance + a trip-condition, NOT vetted
// steps or a real cost forecast (the worker emitted a one-line manifest, not a
// plan). It is minted into ready/ (race-safe id via next-plan-id.mjs) then parked
// in waiting-operator/ so the drain's oracle never auto-executes an unreviewed
// stub. Banners: SEED-WRITE from the manifest's seed_write; a parseable $0 Cost
// forecast (the lint needs a parseable banner for the brief ready/ window; the
// real forecast is set by the operator at triage, and waiting-operator/ is not
// drained so the $0 never triggers an auto-land). The body also carries an
// "operator green-light" gate phrase so queue-drain's OPERATOR_GATE_RX excludes
// it — defense-in-depth: if the ready/→waiting-operator/ move ever half-fails and
// strands the stub in ready/, the oracle still refuses to auto-execute it (a $0
// stub with no gate would otherwise be picked up as a real plan).
export function renderCarryForwardPlanBody(item, { parentSlug, date } = {}) {
  const seedYes = String(item.seed_write || '').toLowerCase() === 'yes';
  // plan 3960 cluster-2 review fix: drive off the configured label (coord.config.json's
  // mutationBanner.label) instead of a hardcoded "SEED-WRITE" literal — matches
  // build-index-lib.mjs's parser/anchor and done-worktree.mjs's own stub-body writer.
  const banner = seedYes
    ? `> 🟥 **${MUTATION_BANNER_LABEL}: YES** — auto-extracted stub; confirm the real seed-write status at triage.`
    : `> 🟩 **${MUTATION_BANNER_LABEL}: NO** — auto-extracted stub; confirm the real seed-write status at triage.`;
  const oneLine = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim();
  const summary = oneLine(item.blurb || item.title) || 'auto-extracted drain carry-forward';
  const blurb = oneLine(item.blurb);
  return [
    '---',
    `summary: ${summary}`,
    'unblock: decision',
    '---',
    '',
    banner,
    '> 💰 **Cost forecast:** $0 (stub — scoping only). Operator sets the real forecast at triage, before promoting to ready/.',
    '',
    `# ${oneLine(item.title)}`,
    '',
    // plan 2587: `📋 STUB`, not `📋 READY`. This body carries its own `**Status:**` line, so
    // next-plan-id's `ensureReadyStatusLine` heal leaves it alone while
    // `ensureStageFrontmatter` still stamps `stage: stub` — the same
    // `stage: stub` / `**Status:** READY` contradiction board-write-gate's
    // `stage-status-prose` check now refuses. The prose already calls this a **stub**
    // twice below; the token now agrees with the stamp and with that prose.
    `**Status:** 📋 STUB — auto-extracted by the autonomous drain on ${date}.`,
    '',
    'Auto-extracted `open-new-plan` carry-forward from the autonomous ready/-queue drain ' +
      `(plan 231), emitted by the worker while executing \`${parentSlug}\`. This is a **stub**: ` +
      "it carries the follow-up's intent, not vetted steps or a real cost forecast. Parked in " +
      "`waiting-operator/` so the drain's oracle never auto-executes it before an operator scopes it.",
    ...(blurb ? ['', `**Follow-up:** ${blurb}`] : []),
    '',
    '## Trip-condition',
    '',
    'Needs an operator green-light before it runs — confirm scope, write executable steps, ' +
      `set the real ${MUTATION_BANNER_LABEL} + Cost-forecast banners, then \`node scripts/move-plan.mjs <id> ready\`. ` +
      'Until then it stays out of the drain queue: waiting-operator/ is not scanned by the oracle, and ' +
      'this operator-gate line keeps it excluded even if a mint half-fails and strands it in ready/.',
    '',
  ].join('\n');
}

// Fix round 1 (finding F — REGRESSION, key b7f489): mintCarryForwardPlans below shells out to
// `move-plan.mjs <id> waiting-operator --blocked-by <this text>`. The stub body itself carries
// `unblock: decision` (renderCarryForwardPlanBody above), so that CLI call runs through the new
// `assertBlockedByAxisTagOk` gate (move-plan.mjs), which refuses a `--blocked-by` with no
// `[axis: …]` marker — a mint that had already claimed and pushed the stub to `ready/` then threw
// here, leaving an untracked stub stranded (never moved to waiting-operator/, never recorded).
// `[axis: hold]` fits the text's own shape: an auto-extracted stub is a blanket hold pending
// operator scoping, not a specific product/policy/money/access/data-ruling call. Exported (pure)
// so the fix can be tested directly against the real gate, not a hand-copied string.
export function carryForwardBlockedByText(plan, dateStr) {
  return (
    `[axis: hold] operator triage — auto-extracted carry-forward stub from drain ${dateStr} ` +
    `(parent ${plan.slug}); scope + set the real Cost-forecast before promoting to ready/.`
  );
}

// Record the filed carry-forward plan basenames in run state (audit; immutable).
export function recordFiledCarryForwards(state, mintedSlugs) {
  return {
    ...state,
    carry_forwards_filed: [...(state.carry_forwards_filed || []), ...(mintedSlugs || [])],
  };
}

// --- pure: state accumulation ------------------------------------------------

export function emptyState() {
  return {
    plans_completed: [],
    plans_quarantined: [],
    plans_blocked: [],
    carry_forwards: [], // audit: { plan, kind, title } — every item the worker returned
    carry_forwards_filed: [], // basenames the driver minted → waiting-operator/ (plan 388)
    plans_skipped: [], // [{ slug, exclude, reason }] — plans the oracle excluded (operator-input / blocked); listed at closing (plan 443)
    plans_landed: [], // slugs the DRIVER landed via the done-worktree spine (plan 518)
    lands_parked: [], // [{ slug, seam, reason }] — lands that hit a non-retryable spine seam (plan 518)
    in_flight: [], // [{ slug, spawned_at_iteration }] — live workers, crash forensics (plan 518)
    run_config: null, // { workers, reserve, interactive, phase, ceiling } recorded at run start (plan 518)
    cumulative_spend_usd: 0,
    iterations: 0,
  };
}

// Fold a successful driver-side land / a parked land into run state (immutable;
// tolerant of legacy drain-state.json files that predate the keys).
export function recordLanded(state, slug) {
  return { ...state, plans_landed: [...(state.plans_landed || []), slug] };
}

// plan 629: `disposition` distinguishes a land-stuck plan HELD in in-progress/ (with a
// RESUME-NEEDED marker — 'resume') from one genuinely parked to waiting-operator/ for a
// human ('operator'), so finish() can report each honestly. Legacy records (no field)
// read as 'operator', the pre-629 behaviour.
export function recordLandParked(state, { slug, seam, reason, disposition = 'operator' }) {
  return {
    ...state,
    lands_parked: [
      ...(state.lands_parked || []),
      { slug, seam, reason: reason ?? null, disposition },
    ],
  };
}

// Fold the oracle's `excluded` set into run state (immutable, dedupe by slug).
// The same operator-input plan re-appears in EVERY iteration's excluded list, so
// we keep one entry per slug with its latest reason. Surfaced in the closing DONE
// log + persisted to drain-state.json so the handoff shows what was skipped and
// why (plan 443).
export function recordSkipped(state, excluded) {
  if (!excluded || excluded.length === 0) return state;
  const bySlug = new Map((state.plans_skipped || []).map((s) => [s.slug, s]));
  for (const e of excluded) {
    bySlug.set(e.slug, { slug: e.slug, exclude: e.exclude, reason: e.reason ?? null });
  }
  return { ...state, plans_skipped: [...bySlug.values()] };
}

// plan 2426 (operator ruling Q3): pick the first oracle candidate this run has NOT already
// had refused by the write-time board gate.
//
// This exists because the gate's refusal is deliberately NON-MUTATING: the plan stays in
// `ready/`, untouched, so the very next `oracle()` call offers it again. Without this filter
// the FILL loop's `attempted` guard would see the repeat and HALT the whole run with
// `plan_not_advancing` — one disagreement between the oracle's own blocked-plan regex and
// the gate's classifier would take the entire drain down instead of costing it one plan.
// (The mirror-image of the dry-run oracle's `dryClaimed` filter, and the same reason: a
// non-mutating "claim" leaves the queue looking unchanged.)
//
// `pick.next` is normally `pick.eligible[0]`, so it leads the scan and the de-dupe keeps a
// single pass; falling through to the rest of `eligible` preserves the oracle's own
// priority ordering. null = every eligible candidate has been refused.
export function selectNextCandidate(pick, refusedSlugs) {
  const seen = new Set();
  for (const p of [pick?.next, ...(pick?.eligible || [])]) {
    if (!p || !p.slug || seen.has(p.slug)) continue;
    seen.add(p.slug);
    if (!refusedSlugs.has(p.slug)) return p;
  }
  return null;
}

// Fold one iteration's outcome into the run state (immutable). `spendUsd` is the
// claude -p envelope's total_cost_usd for this plan. `carryForward` is the
// worker's manifest — RECORDED for audit, not acted on (done-worktree files it).
export function nextState(state, { slug, outcome, spendUsd = 0, carryForward = [] }) {
  const s = {
    ...state,
    plans_completed: [...state.plans_completed],
    plans_quarantined: [...state.plans_quarantined],
    plans_blocked: [...state.plans_blocked],
    carry_forwards: [...(state.carry_forwards || [])],
    cumulative_spend_usd: round2(state.cumulative_spend_usd + (Number(spendUsd) || 0)),
    iterations: state.iterations + 1,
  };
  if (outcome === 'completed') s.plans_completed.push(slug);
  else if (outcome === 'gate_failed' || outcome === 'error') s.plans_quarantined.push(slug);
  // blocked dedupes by slug: a granted continuation that blocks AGAIN folds a
  // second 'blocked' for the same plan (plan 518 triage) — one audit entry.
  else if (outcome === 'blocked' && !s.plans_blocked.includes(slug)) s.plans_blocked.push(slug);
  for (const c of carryForward || []) {
    s.carry_forwards.push({ plan: slug, kind: c.kind, title: c.title });
  }
  return s;
}

// Spawn gate for the dispatcher pool (plan 518): may ANOTHER worker spawn given
// what is already settled and how many workers are still running? Each in-flight
// worker holds a flat `reserve` of headroom so N concurrent workers can't
// overshoot the ceiling by N × worst-plan before any spend settles. With zero
// in-flight this degenerates to `settled ≤ ceiling` — serial behavior unchanged
// (shouldHalt's `settled ≥ ceiling` check still fires first at the boundary).
export function spawnGateOpen({
  settled = 0,
  inFlight = 0,
  reserve = DEFAULT_RESERVE_USD,
  ceiling = DEFAULT_CEILING_USD,
}) {
  return settled + inFlight * reserve <= ceiling;
}

// Classify a done-worktree.mjs spine exit (plan 518). Exit 0 = landed. Otherwise
// the first `HANDOFF:<CODE>` stdout line is authoritative (the spine prints it
// before its JSON payload); fall back to reverse-mapping the distinct exit code
// (done-worktree-lib EXIT). Only QUEUE_WAIT is retryable — another session holds
// the landing queue and will release it; every other seam is a judgment fork
// that parks the plan for the operator.
export function classifySpineExit({ code, stdout = '' }) {
  if (code === 0) return { landed: true };
  const m = String(stdout).match(/^HANDOFF:([A-Z_]+)/m);
  const seam =
    (m && m[1]) || Object.keys(SPINE_EXIT).find((k) => SPINE_EXIT[k] === code) || 'UNKNOWN';
  return { landed: false, seam, retryable: seam === 'QUEUE_WAIT' };
}

// Halt the loop BEFORE spawning the next plan? Spend ceiling reached, or the
// quarantine count hit the limit. `quarantineLimit` is overridable so the
// interactive 'quarantine_limit' prompt can extend the budget for one run
// (plan 518); the default keeps the historic 2-quarantine breaker.
export function shouldHalt(
  state,
  ceiling = DEFAULT_CEILING_USD,
  quarantineLimit = MAX_QUARANTINES,
) {
  if (state.cumulative_spend_usd >= ceiling) {
    return { halt: true, reason: 'spend_ceiling' };
  }
  if (state.plans_quarantined.length >= quarantineLimit) {
    return { halt: true, reason: 'quarantine_limit' };
  }
  return { halt: false };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// --- prompter (plan 518: interactive vs non-interactive modes) ----------------
//
// Contract: prompter(kind, payload) → Promise<answer>.
//   cost_pause       {plan, why}      → true (run it) / false (park it)
//   ceiling          {spent, ceiling} → false (stop) | number (new ceiling, THIS run only)
//   quarantine_limit {count}          → true (continue) / false (stop)
//   blocked_triage   {plan, result}   → 'grant' | 'park'
// Non-interactive mode passes prompter = null; every null-path is
// decide-or-park-and-continue — the null prompter never terminates the run by
// itself (spec 2026-06-10-parallel-drain-design.md). While a prompt is open the
// FILL stage pauses (no new spawns) but in-flight workers keep running.

// Readline prompter on the controlling TTY (--interactive). Questions go to
// stderr so stdout piping stays clean. Untested I/O shim — the loop tests
// inject fake prompters.
export function makeTtyPrompter() {
  return async (kind, payload = {}) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      if (kind === 'cost_pause') {
        const a = await rl.question(
          `[drain] COST PAUSE: ${payload.plan?.slug} — ${payload.why ?? 'cost gate'} ` +
            `(${payload.plan?.cost?.raw ?? 'no cost line'}). Run it anyway? [y/N] `,
        );
        return /^y(es)?$/i.test(a.trim());
      }
      if (kind === 'ceiling') {
        const suggested = round2((payload.ceiling ?? DEFAULT_CEILING_USD) + 5);
        const a = await rl.question(
          `[drain] SPEND CEILING: $${payload.spent} settled of $${payload.ceiling}. ` +
            `Enter a new ceiling to continue (e.g. ${suggested}) or empty/n to stop: `,
        );
        const t = a.trim();
        if (!t || /^n(o)?$/i.test(t)) return false;
        const n = Number(t);
        return Number.isFinite(n) && n > (payload.ceiling ?? 0) ? n : false;
      }
      if (kind === 'quarantine_limit') {
        const a = await rl.question(
          `[drain] QUARANTINE LIMIT: ${payload.count} plan(s) quarantined (gate failures). ` +
            'Continue anyway? [y/N] ',
        );
        return /^y(es)?$/i.test(a.trim());
      }
      if (kind === 'blocked_triage') {
        const a = await rl.question(
          `[drain] BLOCKED: ${payload.plan?.slug} at its own operator checkpoint ` +
            `(${payload.result?.notes ?? 'no notes'}). Grant the checkpoint and resume? [g]rant / [P]ark: `,
        );
        return /^g(rant)?$/i.test(a.trim()) ? 'grant' : 'park';
      }
      return null; // unknown kind → caller treats as decline/park (conservative)
    } finally {
      rl.close();
    }
  };
}

// --- impure: oracle + claude -p runner + state file --------------------------

// Ask queue-drain.mjs for the next eligible plan. Returns { next, eligible } or
// { reason }.
function runOracle(scriptsDir = SCRIPTS_DIR) {
  try {
    const out = execFileSync('node', [join(scriptsDir, 'queue-drain.mjs')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return JSON.parse(out);
  } catch (e) {
    // exit 1 = a reason was emitted on stdout; parse it.
    if (e.stdout) {
      try {
        return JSON.parse(e.stdout);
      } catch {
        /* fall through */
      }
    }
    throw new Error(`drain-run: oracle failed: ${e.message}`);
  }
}

// Default runner: spawn a fresh `claude -p` for one plan, parse the JSON
// envelope.
//
// SAFE BY DEFAULT. An unattended worker needs --dangerously-skip-permissions to
// edit files + run git/bash without prompting — but baking that bypass in as a
// default would mean merely *shipping* this file creates permission-bypassing
// agents. So the bypass is gated behind an explicit per-invocation opt-in
// (`--allow-dangerous` / DRAIN_ALLOW_DANGEROUS=1): without it, the runner throws
// before spawning anything. The bypass is therefore always a conscious operator
// choice, never a silent default. Use --dry-run for a no-spend smoke. Swap this
// runner for an Agent-dispatch fallback (plan 231 driver decision) if claude -p
// re-auth proves fragile.
// plan 1427 Gate 3 — point-escalation: append the native advisor flag so a drain
// worker's Sonnet session auto-consults a heavy-model advisor at decision forks
// (provenance contradiction, demote-vs-backfill, evidence-reality verdict, gate-
// override temptation — see the drain skill's standing fork-list). The model comes
// from DRAIN_ADVISOR (default 'fable'); an EXPLICITLY EMPTY DRAIN_ADVISOR='' disables
// the flag entirely (opt-out, not just unset). Subagents a worker spawns inherit the
// advisor — documented Claude Code behavior, not this script's doing. Pulled into its
// own pure function so the arg-building logic is unit-testable without spawning.
export function buildClaudeArgs(prompt, { extraArgs = [] } = {}) {
  const args = ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions'];
  const advisor = process.env.DRAIN_ADVISOR ?? 'fable';
  if (advisor !== '') args.push('--advisor', advisor);
  args.push(...extraArgs);
  return args;
}

export function makeClaudeRunner({ extraArgs = [], allowDangerous = false } = {}) {
  return (plan, { account, promptOverride } = {}) => {
    if (!allowDangerous) {
      throw new Error(
        'drain-run: real claude -p execution is gated. The unattended worker requires ' +
          '--dangerously-skip-permissions to edit files + run git/bash without prompting; that bypass ' +
          'is opt-in via --allow-dangerous (CLI) or DRAIN_ALLOW_DANGEROUS=1 so it is never a silent ' +
          'default. Re-run with that flag to authorise spend, or use --dry-run for a no-spend smoke.',
      );
    }
    // promptOverride carries the continuation-worker protocol (blocked-plan
    // triage, plan 518); the default is the standard per-plan protocol.
    const prompt = promptOverride ?? buildPlanPrompt(plan);
    const args = buildClaudeArgs(prompt, { extraArgs });
    const env = { ...process.env };
    // Round-robin auth: point claude at a per-account config dir. The mapping is
    // environment-specific; documented in the `drain` skill. Off unless --accounts.
    if (account) env.CLAUDE_CONFIG_DIR = account;
    // Async spawn (promisified execFile) so the dispatcher pool can run up to
    // --workers of these concurrently; the no-opt-in throw above stays
    // synchronous (fires at call time, before any child process exists).
    return execFileP('claude', args, {
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024 * 1024,
    }).then(
      ({ stdout }) => {
        let envelope;
        try {
          envelope = JSON.parse(stdout);
        } catch (e) {
          return { result: { error: true, status: 'error', notes: e.message }, spendUsd: 0 };
        }
        const spendUsd = Number(envelope.total_cost_usd) || 0;
        let result;
        try {
          result = parsePlanResult(envelope.result);
        } catch (e) {
          result = { error: true, status: 'error', notes: e.message };
        }
        return { result, spendUsd };
      },
      (e) => ({ result: { error: true, status: 'error', notes: e.message }, spendUsd: 0 }),
    );
  };
}

// Dry-run runner: no spend, no spawn. Reports each plan as completed so the
// operator can watch the loop drive the REAL oracle + state file end-to-end
// before authorising real claude -p spend. `latencyMs` simulates worker
// wall-clock so a --workers N dry run visibly overlaps spawns.
export function dryRunner({ latencyMs = 0 } = {}) {
  return async (plan) => {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    return {
      result: {
        status: 'completed',
        slug: plan.slug,
        shipped_sha: 'DRYRUN',
        gates: [{ name: 'dry-run', passed: true, detail: 'no execution' }],
        carry_forward: [],
        notes: 'dry-run: would execute via claude -p',
      },
      spendUsd: 0,
    };
  };
}

function statePath(mainDir) {
  // .scratch/ (gitignored, agent-only) — NOT review-only output/ (plan 430).
  return join(mainDir, '.scratch', 'drain-state.json');
}

function loadState(mainDir) {
  const p = statePath(mainDir);
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      /* corrupt → fresh */
    }
  }
  return emptyState();
}

function saveState(mainDir, state) {
  const p = statePath(mainDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2));
}

// Review fix (finding bcaf8e): AXIS_TAG_PRESENT_RX (a presence-only check that treated ANY
// `[axis: …]`-shaped text — even a bogus tag, or a stale marker from an earlier, different park —
// as "fine" and left it untouched) is DELETED. parkToWaitingOperator now REPLACES the whole
// Blocked-by line on every park (see its own comment), so there is nothing left to validate an
// EXISTING marker against — the new line, built from THIS park's own canonically-tagged
// `blockedBy` text, is always valid by construction.

function axisTagFromBlockedBy(blockedBy) {
  const m = String(blockedBy ?? '').match(AXIS_TAG_RX);
  return m ? m[1].toLowerCase() : null;
}

// The `unblock:` value THIS park's own axis implies — reusing move-plan.mjs's canonical
// AXIS_TAGS_BY_UNBLOCK mapping (imported above) rather than re-deriving it. `decision` covers
// every axis except `manual` itself (AXIS_TAGS_BY_UNBLOCK.decision — "every axis except manual" —
// already includes 'access', the mapping's other manual-lane member), so `tag === 'manual'` is
// the only case that needs its own branch; every other tag, recognised or not, resolves to
// 'decision'.
//
// Fix (R3-5, key 1032 simplification): a third branch (`AXIS_TAGS_BY_UNBLOCK.manual.includes(tag)`
// ⇒ 'manual') used to sit between the decision check and the default, on the theory that it gave
// `access` the "more specific" manual semantics. It never ran: 'manual' is caught by the first
// `if`, and 'access' — the only other member of AXIS_TAGS_BY_UNBLOCK.manual — is already caught
// by the decision-list `if` immediately above it, since that list contains every axis but
// 'manual'. Removed; no behaviour change (both the dead branch and the trailing default returned
// 'decision').
function unblockValueForAxisTag(tag) {
  return tag === 'manual' ? 'manual' : 'decision';
}

// Review round 2 (R2-3, key 1036): flipBoardPaused/repathBoardRow's ONE need from
// coord.config.json is the board file's repo-relative path — pure data derived from
// `handoffDir` (coord-config.mjs's derivePaths). Round 1's loadCoordConfigOrDefault (now
// deleted) guarded the WHOLE config object: on ANY malformed field — even one with nothing to
// do with paths, e.g. a bad `scopeMaxKeys` — it substituted normalizeConfig(null)'s LEGACY
// defaults, silently reading/writing the WRONG board file whenever a repo configures a REAL,
// non-default `handoffDir`. Fixed the same narrow way readOperatorSpendCeilingUsd above already
// guards ITS one field: on a throw, re-derive JUST the field this needs from the raw JSON's own
// `handoffDir` (never the rest of the file's validated fields, and never a fabricated path
// substituted for a real configured one), and only fall back to the true LEGACY path when the
// config file itself is unreadable/malformed JSON — the same total-failure floor the ceiling
// read shares.
//
// Fix (R3-3, key 1054 angle-A): this raw re-derivation used to hand `raw.handoffDir` to
// derivePaths with NO type check — a non-string value (a number, an object, an array) is truthy,
// so it skipped derivePaths' own `!handoffDir` early-return and got `String()`-coerced into a
// garbage path segment ("42/board.md", "[object Object]/board.md") instead of degrading to the
// LEGACY default the way an absent/empty handoffDir correctly does. Validated here instead: only
// a genuinely non-empty STRING is handed through; anything else reads as "no handoffDir".
function boardFileRelOf(mainDir) {
  try {
    return loadCoordConfig(mainDir).paths.boardFile;
  } catch {
    try {
      const raw = JSON.parse(readFileSync(join(mainDir, 'coord.config.json'), 'utf8'));
      const rawHandoffDir =
        typeof raw?.handoffDir === 'string' && raw.handoffDir ? raw.handoffDir : null;
      return derivePaths(rawHandoffDir).boardFile;
    } catch {
      return derivePaths(null).boardFile;
    }
  }
}

// Review round 2 (R2-1, the serious defect): parkToWaitingOperator's frontmatter-safe fallback
// for inserting a Blocked-by line into a body that carries no LIVE one yet. Composed only from
// build-index-lib.mjs's existing anchor primitives — the SAME "banner, else H1, else right after
// frontmatter" chain plan-body-state.mjs's own setStatusLine already uses — never a fresh regex
// over plan-body Markdown. Round 1's fallback (`h1 ? … : \`${line}\n\n${body}\``) operated on the
// RAW body and, with no H1 and no banner, PREPENDED at byte 0 — landing the Blocked-by line ABOVE
// a leading `---` YAML fence and corrupting it (frontmatterEnd's own `isFenceLine(lines[0])` check
// then no longer recognises ANY frontmatter at all). Here the anchor search runs on the
// frontmatter-STRIPPED body only, and the frontmatter prefix is always reattached untouched.
// Exported for a direct unit test (drain-run.test.mjs).
export function insertBlockedByLine(content, line) {
  const { prefix, body } = splitFrontmatter(content);
  const anchorMatch = body.match(SEED_BANNER_RX) || body.match(H1_RX);
  if (anchorMatch) {
    return prefix + spliceAtMatch(body, anchorMatch, `${anchorMatch[0]}\n\n${line}`);
  }
  return insertAfterFrontmatterOrPrepend(content, line);
}

// Shared mover for every park/quarantine path: file a plan into
// waiting-operator/ with a Blocked-by line (inserted under the SEED-WRITE
// banner when the seed lane is active and none exists yet — config-less repos
// have no banner to anchor on, so the guard keeps the intent explicit), then
// movePlanOnMaster (divergence-tolerant). The four callers differ only in
// source folder + Blocked-by text + commit message; the guard/regex/seedLane
// logic lives once here (plan 518 review).
function parkToWaitingOperator(
  mainDir,
  scriptsDir,
  plan,
  { fromSubfolder, blockedBy, commitMsg, missingLabel, date, statusReason },
) {
  const from = `docs/superpowers/plans/${fromSubfolder}/${plan.slug}.md`;
  // plan 3960 review fix: WAITING_OPERATOR_FOLDER (configured), not a literal 'waiting-operator' —
  // a renamed lanes.waitingOperator used to park the plan file outside every configured scanner.
  const to = `docs/superpowers/plans/${WAITING_OPERATOR_FOLDER}/${plan.slug}.md`;
  const abs = join(mainDir, from);
  if (!existsSync(abs)) {
    console.error(
      `drain-run: cannot ${missingLabel} ${plan.slug} — ${from} not found (already moved?)`,
    );
    return;
  }
  // Insert/replace the Blocked-by line so the parked body ALWAYS states the CURRENT park's own
  // reason (review findings ce8ec7 / 866415 / 11f9ab / 7c83d6, one fix): an existing LIVE line —
  // bold, unbolded, or blockquoted, per the repo's ONE canonical matcher (blocked-by-lib.mjs's
  // BLOCKED_BY_LINE_RE, via blockedByLines/rewriteFirstBlockedByLine, review round 2 R2-1) — is
  // REPLACED wholesale with this park's text, whatever it carried before (a stale-but-valid marker
  // from an earlier, different park; a bogus one; or none at all) — a stale marker must never
  // survive a re-park and mask the CURRENT reason. A missing line is INSERTED via
  // insertBlockedByLine's frontmatter-safe anchor chain above (finding 703f27 — the old insertion
  // path only ever fired when a banner both was configured AND present in the body, silently
  // omitting the line otherwise).
  let body = readFileSync(abs, 'utf8');
  const newBlockedByLine = `**Blocked-by:** ${blockedBy}`;
  body =
    blockedByLines(body).length > 0
      ? rewriteFirstBlockedByLine(body, () => newBlockedByLine)
      : insertBlockedByLine(body, newBlockedByLine);
  // Fix (finding 969306): stamp the unblock: value THIS park's own axis implies, when the body
  // doesn't already declare one. Review round 2 (R2-2, key 1102): an EXISTING value is preserved
  // only when it is both a valid operator lane (manual/decision — the legacy `cost` value is
  // never valid here) AND compatible with the axis THIS park is about to declare
  // (AXIS_TAGS_BY_UNBLOCK[existing] admits the tag) — otherwise it is overwritten with the value
  // this park's own axis implies. Blindly preserving (round 1) let a park write e.g.
  // `[axis: money]` onto a plan still carrying `unblock: manual` — a pair move-plan's own
  // assertBlockedByAxisTagOk refuses outright — or leave a legacy `unblock: cost` (never a valid
  // operator value at all) standing untouched.
  const parkAxisTag = axisTagFromBlockedBy(blockedBy);
  const existingUnblock = getUnblock(body);
  const existingUnblockCompatible =
    existingUnblock != null &&
    (AXIS_TAGS_BY_UNBLOCK[existingUnblock]?.includes(parkAxisTag) ?? false);
  if (!existingUnblockCompatible) {
    body = setUnblock(body, unblockValueForAxisTag(parkAxisTag));
  }
  // plan 629 Task 2: rewrite the body Status line to match the destination folder, so a
  // parked plan never reads its authoring-time 📋 READY (the 2026-06-15 audit's core
  // unreadability). Always stamped — unlike the seedLane-gated Blocked-by anchor above.
  body = stampWaitingOperatorStatus(body, { date, reason: statusReason || blockedBy });
  // PLAN 3371 task 5 — PAUSE BEFORE REPATH. These are two independent pushes and nothing can make
  // them one commit (the row lives in the board file, the plan in its own; `board.mjs set-state`
  // pushes `[boardFile]` alone), so the only thing under our control is WHICH half-finished state a
  // crash between them leaves behind. Repath-then-pause left the strictly worse one: a pushed
  // `🔄 ACTIVE` row pointing at a waiting-lane plan, which `lint-board.mjs`'s WAITING_PLAN_ACTIVE_ROW
  // then HARD-BLOCKS on every sibling session's push until a human flips it by hand — the residue
  // plan 2929 was minted to find (2917/2909/2888 were three live instances) and infra-debt
  // `drain-park-repath-then-pause-is-not-atomic` records. `orderedPlanMove`'s rollback covered the
  // repath step only, so it could not undo this.
  //
  // Pausing first inverts the failure window into a benign one: a crash after the pause leaves a
  // `⏸ PAUSED` row on a plan still sitting in its ORIGINAL folder. Nothing lints that — a paused row
  // on an in-progress plan is an ordinary, legitimate state (it is exactly what a worker parking
  // itself writes) — and the next drain simply re-parks. A parked plan's row is never legitimately
  // ACTIVE, so the pause is safe to publish before the move is certain, which is not true in reverse.
  //
  // `fetch: true` restores what the ordering took away: `flipBoardPaused`'s F-003 read is authoritative
  // only against a current tracking ref, and it used to get one for free from the move's own push
  // landing immediately before it. With no push ahead of it here, it must fetch — a stale read could
  // otherwise pause a row that is 🟢 LANDING on origin and desync the landing-queue steal protocol.
  flipBoardPaused(mainDir, scriptsDir, plan.slug, { fetch: true });
  // The body edit is written AFTER the pause (delta round, cf229d), not before it. It is a
  // working-tree write that nothing commits until the move, so authoring it first meant a failing
  // pause left the shared main checkout DIRTY with a waiting-lane Status stamp on a plan that is
  // still in-progress and whose row is still ACTIVE — dirt that later coordination writes on that
  // checkout then have to step around. Composed in memory above, landed on disk only after the
  // pause step has RETURNED (which is not the same as proving the row is now PAUSED — see below).
  //
  // Both the write and the move sit INSIDE the recovery handler (round 3, f341d1 / 82b52a): a
  // `writeFileSync` that throws on the shared checkout is the same half-finished park as a move that
  // throws — row published, plan un-repathed — and leaving it outside meant that one threw bare,
  // with none of the location reporting the case needs.
  //
  // Pass the body we just wrote (plan 2426): the gate at movePlanOnMaster's head needs it,
  // and re-reading the file we authored one line above is a pointless syscall on the shared
  // main checkout's hot path. A park targets a waiting lane, so the gate no-ops regardless.
  //
  // NAME the half-finished state if the move fails (gpt-review 12c1f3). A failed move leaves the
  // plan in its source folder under BOTH orderings — `orderedPlanMove` rolls the file move back, and
  // nothing re-invokes a park (the drain oracle reads `ready/` only) — so this is not a regression
  // the reorder introduced. What the reorder DOES change is that the row now reads ⏸ PAUSED, which
  // is quiet by design: no lint fires, no sibling push is blocked. Quiet is right for the board and
  // wrong for the operator, so say exactly what is true and what the one-line recovery is, then
  // rethrow untouched — swallowing it here would turn a failed park into a silent success.
  try {
    writeFileSync(abs, body);
    movePlanOnMaster(mainDir, scriptsDir, plan, from, to, commitMsg, body);
  } catch (e) {
    // Report where the plan file ACTUALLY is, never where the happy path assumed it would be
    // (delta round, 7d243b / 85d9bd). `orderedPlanMove` compensates a failed repath by undoing the
    // file move, but that rollback can itself fail and its error is swallowed — so "the plan is
    // still in <from>/" was an assumption stated as a fact, and the recovery command it printed
    // would then fail too. Both paths are cheap to just LOOK at.
    // Four states, each named explicitly rather than folded into a chain of ternaries (round 3,
    // 8a04d3): BOTH files present is a real outcome — a rollback that re-created the source without
    // removing the destination — and collapsing it into "rolled back" would print a recovery command
    // that then fails against the existing destination. Each branch carries the action that is
    // actually correct for it, or says plainly that there isn't one.
    const atSource = existsSync(abs);
    const atDest = existsSync(join(mainDir, to));
    // Fix (finding 54dced): carry --unblock matching THIS park's own axis — without it,
    // move-plan.mjs's assertUnblockOk gate refuses the recovery command outright on a plan
    // carrying `unblock: decision` or none (e.g. every [axis: manual] quarantine), stranding the
    // plan in its source lane instead of recovering it.
    const unblockValue = unblockValueForAxisTag(axisTagFromBlockedBy(blockedBy));
    // Fix (R3-4, key 1206 angle-P): WAITING_OPERATOR_FOLDER (configured), not a literal
    // 'waiting-operator' — mirrors the `to` destination above (plan 3960's fix). A renamed
    // lanes.waitingOperator must reach the printed recovery command too, or it fails against
    // the real (renamed) destination and strands the plan right where this command exists to
    // rescue it from.
    // Round-3 re-review (keys 1t1imp0/1nq4koi/irfsdw): QUOTED, not bare. The folder is
    // repo-controlled (coord.config.json), so nothing untrusted reaches it — but a renamed lane
    // carrying a space would split into two argv entries and the pasted recovery command would
    // fail against the very plan it exists to rescue.
    const moveCmd = `node scripts/move-plan.mjs ${plan.slug} "${WAITING_OPERATOR_FOLDER}" --blocked-by "${blockedBy}" --unblock ${unblockValue}`;
    let where;
    let recovery;
    if (atSource && atDest) {
      where = `in BOTH ${fromSubfolder}/ and waiting-operator/ (a rollback re-created the source without removing the destination)`;
      recovery = `Delete whichever copy is wrong on the main checkout FIRST — do not run move-plan over a duplicated plan file.`;
    } else if (atSource) {
      where = `still in ${fromSubfolder}/ (the file move rolled back)`;
      recovery = `Recover with: ${moveCmd}`;
    } else if (atDest) {
      where = `ALREADY in waiting-operator/ (the file moved; the rollback did not run or failed) — the repath/board half is what is unfinished`;
      recovery = `The plan file needs no move. Reconcile the board row against it: node scripts/reconcile-board.mjs`;
    } else {
      where = `in NEITHER ${fromSubfolder}/ nor waiting-operator/`;
      recovery = `Inspect \`git status\` on the main checkout before doing anything else.`;
    }
    // "PAUSED" is what the pause step ATTEMPTED, not a proven fact (round 3, 20e3b3):
    // `flipBoardPaused` returns nothing and silently no-ops when the authoritative read fails, when
    // the row is absent, or when the row is not ACTIVE (a held 🟢 LANDING marker it must never
    // clobber). So describe the intent and tell the operator to look, rather than asserting a state
    // this function never received confirmation of.
    console.error(
      `drain-run: ${plan.slug} — park FAILED after the board-pause step (${e?.message || e}). ` +
        `The plan is ${where}, and still claim-held. Its row was sent to ⏸ PAUSED, but the pause is ` +
        `best-effort and reports nothing back, so CHECK the row: if it is still 🔄 ACTIVE over a ` +
        `waiting-lane plan, the board lint will block sibling pushes until it is flipped. ${recovery}`,
    );
    throw e;
  }
}

// plan 629 Task 4: flip a dead worker's stale 🔄 ACTIVE board row to ⏸ PAUSED.
// ONLY an ACTIVE row is flipped — a 🟢 LANDING row is a HELD mutex/queue marker (a
// seed-lane LAND_BLOCKED_HOLDING seam keeps the LANDING row + landing-lock + FIFO head
// slot all held on purpose so a --resume re-enters the merge with the slot intact);
// clobbering it to PAUSED would desync the landing-queue steal protocol, which keys on
// the LANDING row to tell a live land from an abandoned one (review finding). Wrapped in
// retryOnForeignDirt and tolerant of the row-vanish race — both benign no-ops.
//
// `fetch` (plan 3371 task 5): whether the authoritative board read fetches first. Defaults false —
// the F-003 comment below explains why that was safe for every ORIGINAL caller, each of which runs
// straight after its own successful push. `parkToWaitingOperator` no longer does (it pauses BEFORE
// its move now), so it passes `fetch: true` to buy back the currency the ordering gave up.
function flipBoardPaused(mainDir, scriptsDir, slug, { fetch = false } = {}) {
  // Review round 2 (R2-3): boardFileRelOf (above) — an unrelated malformed config field
  // elsewhere in coord.config.json must not abort the park, but the fix is a narrow, targeted
  // re-derivation of the one field this needs, never a fabricated whole-config substitute.
  const boardRel = boardFileRelOf(mainDir);
  const boardPath = join(mainDir, boardRel);
  // F-003 (plan 1312 review follow-up): read the AUTHORITATIVE board, not MAIN's stale
  // working-tree copy. A stale read here fails BOTH ways: a row missing locally but 🔄 ACTIVE
  // on origin → the flip is silently skipped and a dead worker's plan keeps reading as a live
  // session; a row 🔄 ACTIVE locally but 🟢 LANDING on origin → we would pause a HELD landing
  // mutex row and desync the steal protocol. fetch defaults false — `resumeInProgressLandSeam` runs
  // right after its own successful push updated the tracking ref; `parkToWaitingOperator` no longer
  // does (plan 3371 reordered it to pause FIRST) and passes fetch:true instead.
  const content = readBoardAuthoritative(mainDir, boardRel, boardPath, { fetch });
  if (content == null) return;
  let boardBody;
  try {
    ({ body: boardBody } = splitBoard(content));
  } catch {
    return; // no sentinels → nothing to flip
  }
  const lines = boardBody.split('\n');
  const idx = findRowLineIndex(lines, slug);
  if (idx === -1) return; // row already gone — benign
  const stateCell = (cellsOf(lines[idx])[2] || '').trim();
  if (!/ACTIVE/i.test(stateCell)) return; // only a live ACTIVE row; never a held LANDING / already-PAUSED
  try {
    retryOnForeignDirt(
      () =>
        execFileSync('node', [join(scriptsDir, 'board.mjs'), 'set-state', slug, 'PAUSED'], {
          cwd: mainDir,
          encoding: 'utf8',
          stdio: ['ignore', 'inherit', 'pipe'],
        }),
      { label: `board set-state ${slug} PAUSED` },
    );
  } catch (e) {
    if (/row not found/i.test(`${e.stderr || ''} ${e.message || ''}`)) return; // row gone — benign
    throw e;
  }
}

// plan 629 Task 1: is the worker's branch ALREADY merged to master (code shipped)?
// `git merge-base --is-ancestor worktree-<slug> origin/master` exits 0 when the branch
// tip is in origin/master's history — true after a successful spine merge (the merge
// commit has the branch as a parent), so a POST-merge seam is distinguishable from a
// never-landed one. origin/master is current here: the spine subprocess's merge push
// updated this shared .git's remote-tracking ref. Any non-zero/non-error exit → false.
function isBranchMergedToMaster(mainDir, slug) {
  try {
    execFileSync(
      'git',
      ['-C', mainDir, 'merge-base', '--is-ancestor', `worktree-${slug}`, 'origin/master'],
      {
        stdio: 'ignore',
        // plan 4096: an ambient GIT_DIR/GIT_WORK_TREE could otherwise override the explicit
        // `-C mainDir` and redirect this local, network-free ancestry check at the wrong repo
        // (see scripts/coord/child-env.mjs gitRepoIsolatedEnv()).
        env: gitRepoIsolatedEnv(),
      },
    );
    return true;
  } catch {
    return false;
  }
}

// plan 629 Task 3: a LAND-STUCK seam keeps the plan in in-progress/ — the worktree
// branch is alive, mid-land (Option A of the operator's 2026-06-15 taxonomy). Stamp a
// RESUME-NEEDED:<CODE> marker into the body (committed on master via coordWrite, which
// stamps the Coord-Write trailer + freshens) and flip the board row to ⏸ PAUSED. The
// plan file does NOT move; the worktree is KEPT for the operator/agent to resolve +
// re-invoke done-worktree. Foreign-dirt-retried like every other drain coord write.
function resumeInProgressLandSeam(mainDir, scriptsDir, plan, dateStr, seam) {
  const rel = `docs/superpowers/plans/${IN_PROGRESS_FOLDER}/${plan.slug}.md`;
  if (!existsSync(join(mainDir, rel))) {
    console.error(
      `drain-run: cannot mark land-blocked ${plan.slug} — ${rel} not found (already moved?)`,
    );
    return;
  }
  const resumeCmd = landResumeCommand(plan.slug, seam);
  retryOnForeignDirt(
    () =>
      coordWrite(mainDir, {
        relPaths: [rel],
        mutate: () => {
          const abs = join(mainDir, rel);
          writeFileSync(
            abs,
            stampLandBlockedResume(readFileSync(abs, 'utf8'), { seam, date: dateStr, resumeCmd }),
          );
        },
        message: `drain: ${plan.slug} land-blocked (${seam}) — RESUME-NEEDED marker, held in in-progress/ (${dateStr})`,
        tool: 'drain-run',
      }),
    { label: `land-blocked stamp ${plan.slug}` },
  );
  flipBoardPaused(mainDir, scriptsDir, plan.slug);
}

// Quarantine a plan (gate failure): in-progress/ → waiting-operator/. Sources
// from in-progress/ because the driver claims every plan (ready/ → in-progress/)
// before the worker runs (see claimPlan).
function quarantinePlan(mainDir, scriptsDir, plan, dateStr) {
  parkToWaitingOperator(mainDir, scriptsDir, plan, {
    fromSubfolder: IN_PROGRESS_FOLDER,
    // Fix round 3 (item 11): `[axis: manual]` — a gate failure needs an out-of-band operator
    // look, the same shape every other direct-git park writer already tags (quarantineBlockedToOperator
    // / parkLandSeamPlan / parkBoardLintPlan). This text had no marker at all, which meant BOTH the
    // park's own Blocked-by line AND the recovery command parkToWaitingOperator prints on a failed
    // move (it interpolates this SAME `blockedBy` string) were refused by move-plan.mjs's own
    // assertBlockedByAxisTagOk gate if a human ever ran that printed recovery command by hand.
    blockedBy: `[axis: manual] gate failure in drain ${dateStr} — operator triage required.`,
    commitMsg: `drain: quarantine ${plan.slug} → waiting-operator (gate failure ${dateStr})`,
    missingLabel: 'quarantine',
    date: dateStr,
    statusReason: 'gate failure in drain — operator triage required',
  });
}

// Regenerate docs/INDEX.md from the current plan tree (no git — pure write).
function runBuildIndex(mainDir, scriptsDir) {
  execFileSync('node', [join(scriptsDir, 'build-index.mjs')], { cwd: mainDir, stdio: 'inherit' });
}

// Re-derive docs/INDEX.md from the (current) plan tree and commit+push it,
// surviving concurrent pushes. INDEX is FULLY GENERATED, so on a non-ff we drop
// our own INDEX commit, rebase to origin, and regenerate from the merged tree —
// we never *merge* INDEX (which would conflict, since every session edits it),
// we re-*derive* it. No-op when INDEX already matches the tree (a sibling's
// regen already covered it). `reset --hard HEAD~1` only ever drops OUR just-made
// INDEX commit (never a sibling's work), so it is safe on the shared main tree.
// Exported (plan 4237 review finding 4153a4) so a test drives the replay guard through this loop.
export function syncIndexOnMaster(mainDir, scriptsDir, commitMsg, { retries = 8 } = {}) {
  const env = { ...process.env, HUSKY: '0' };
  for (let i = 0; ; i++) {
    runBuildIndex(mainDir, scriptsDir);
    if (!gitWithLockRetry(mainDir, ['status', '--porcelain', '--', 'docs/INDEX.md']).trim()) return;
    gitWithLockRetry(mainDir, ['add', '--', 'docs/INDEX.md']);
    gitWithLockRetry(mainDir, ['commit', '-m', commitMsg, '--', 'docs/INDEX.md'], { env });
    try {
      git(mainDir, ['push', 'origin', 'master'], { env });
      return;
    } catch (e) {
      if (!isNonFastForward(e) || i >= retries) throw e;
      gitWithLockRetry(mainDir, ['reset', '--hard', 'HEAD~1']); // drop our regenerable INDEX commit
      gitWithLockRetry(mainDir, ['fetch', 'origin', 'master']);
      // plan 4237: the same replay guard pushMasterWithRebase carries — any OTHER local commit
      // this rebase replays must not come out carrying a clobbered index.
      const baseline = captureRebaseBaseline(mainDir);
      try {
        // plan 2933: the SECOND sanctioned rebase-retry loop on the shared main checkout
        // (the one coord-git.mjs's abortRebaseAndDiagnose comment names). Same exemption as
        // pushMasterWithRebase — mark it sanctioned so .husky/pre-rebase's guard stays
        // silent here and keeps its meaning for genuinely hand-rolled rebases.
        //
        // NOT `{ ...env, … }`: `env` is the push env carrying `HUSKY: '0'`, and spreading it
        // would disable every hook on this rebase rather than just this guard.
        gitWithLockRetry(mainDir, ['rebase', 'origin/master'], { env: sanctionedRebaseEnv() });
      } catch (re) {
        // plan 2391 (review finding 18b60jb): this loop used to swallow the `rebase --abort`
        // failure exactly like pushMasterWithRebase did — same anti-pattern, same blast radius
        // (a DETACHED shared main checkout that silently eats the next commit), and `mainDir`
        // here IS the shared main checkout. Both now route through the ONE coord-git primitive.
        throw abortRebaseAndDiagnose(mainDir, re, { env });
      }
      verifyRebaseReplay(mainDir, {
        ...baseline,
        token: `index-sync-rebase-${process.pid}-${Math.floor(Math.random() * 1e9)}`,
        env,
      });
    }
  }
}

// F-003 (plan 1312): the one authoritative board read for the drain's row verify/repath —
// coord-git's readTrackedFileFresh (fetch + `git show origin/master:<boardFile>`, local-file
// fallback when offline), with BOTH-reads-failed mapped to the null "no board" sentinel the
// callers already understand (legacy board-less repos).
// `fetch: false` skips the network fetch and reads the local remote-tracking ref — used by
// the call sites that run immediately after THIS process's own successful push (which already
// moved refs/remotes/origin/master in the shared .git), so the view is current without a
// round-trip on the drain's hottest path.
function readBoardAuthoritative(mainDir, boardRel, boardPath, { fetch = true } = {}) {
  try {
    return readTrackedFileFresh(mainDir, boardRel, boardPath, { fetch });
  } catch {
    return null; // neither origin/master nor the working tree has a board file
  }
}

// The status subfolders a plan file can live in (mirrors lint-board.mjs's
// PLAN_REF_RX subfolder group). Used to swap the subfolder token in a board
// row's "Plan / claim" cell when the plan file moves. `parked` (plan 1426) is
// included for the same reason lint-board's PLAN_REF_RX includes it — a plan can be
// parked/un-parked, and a stale board row pointing at its old subfolder must repath —
// even though the drain itself never claims or drains a parked/ plan.
// Derived from build-index-lib's PLAN_FOLDER_ALT (plan 1447) — never hand-list folder
// names here again; add a folder to STATUS_ORDER/ALL_PLAN_FOLDERS there and every site
// (this one included) picks it up.
const BOARD_SUBFOLDER_GROUP = PLAN_FOLDER_ALT;

// Rewrite the subfolder token of `<slug>.md` inside a board "Plan / claim" cell
// so it tracks `toSubfolder`. Two cases: (1) the cell already carries a
// subfolder-prefixed path (`in-progress/<slug>.md`) — swap the prefix; (2) the
// cell carries a bare `<slug>.md` (no prefix) — add the prefix so the lint's
// strict-subfolder check has a target. Returns the cell unchanged when neither
// token is present or the subfolder already matches. Pure string→string.
export function repathPlanClaimCell(cell, slug, toSubfolder) {
  const esc = escapeRegex(String(slug));
  const prefixed = new RegExp(`(?:${BOARD_SUBFOLDER_GROUP})/(${esc}\\.md)`, 'g');
  const swapped = cell.replace(prefixed, `${toSubfolder}/$1`);
  if (swapped !== cell) return swapped;
  // No known subfolder prefix — prefix a bare `<slug>.md` token, leaving any
  // other text untouched. The lookbehind excludes a preceding path/word char
  // AND a dot, so a dotted prose mention (`…foo.<slug>.md`) is never mangled
  // mid-token; a leading backtick is allowed (`` `<slug>.md` `` → `` `sub/<slug>.md` ``).
  const bare = new RegExp(`(?<![\\w/.-])(${esc}\\.md)`, 'g');
  return cell.replace(bare, `${toSubfolder}/$1`);
}

// Repath the worker's board row (handoff-board.md) so its "Plan / claim" cell
// subfolder token follows the plan file into `toSubfolder`. Without this, a drain
// that moves a plan between status folders (claim / quarantine / work-pushed
// block / revert) leaves the row pointing at the OLD subfolder → lint-board's
// BOARD_SUBFOLDER_DRIFT rejects every session's push until hand-fixed (hit live
// 2026-06-06, plan 398 → plan 422). No-op (returns a reason) when: there is no
// board file (legacy project), no board sentinels, no row for this slug (the
// case during the claim's own move — the driver writes the row AFTER the plan
// file lands in in-progress/, plan 506; also legacy rows removed by a parallel
// done-worktree), or the cell already names the right subfolder. Only when a real repath is needed do we invoke the atomic
// board.mjs update (its own pull→commit→push). `runUpdate` is injectable for
// tests. A benign row-vanish race (the row existed in our local read but a
// parallel done-worktree removed it before board.mjs's fresh pull) is
// swallowed — there is nothing left to repath, and crashing here would abort the
// drain AFTER the plan-file move + INDEX sync already pushed. Any OTHER board.mjs
// failure (e.g. a real push error) re-throws like any drain git failure.
export function repathBoardRow(
  mainDir,
  scriptsDir,
  slug,
  toSubfolder,
  { readBoard, runUpdate } = {},
) {
  // Review round 2 (R2-3): boardFileRelOf (above) — reached from movePlanOnMaster's
  // orderedPlanMove during a park's own move (repath: (sub) => repathBoardRow(...)), so an
  // unrelated malformed config field here must not abort the park either, without ever
  // substituting a fabricated whole-config default for the real configured paths.
  const boardRel = boardFileRelOf(mainDir);
  const boardPath = join(mainDir, boardRel);
  // F-003 (plan 1312): read the AUTHORITATIVE board (origin/master), never MAIN's working-tree
  // copy — since plan 989, board.mjs writes rows only via the coord-checkout, so MAIN's
  // board.md structurally drifts behind origin and can be missing a row that exists.
  // fetch:false — repathBoardRow's one caller (movePlanOnMaster's orderedPlanMove) runs right
  // after renameMoveSync's own successful push updated the remote-tracking ref, so the local
  // origin/master view is already current; skipping the fetch keeps the drain's per-claim
  // no-row probe off the network (review finding, plan 1312).
  const read =
    readBoard || (() => readBoardAuthoritative(mainDir, boardRel, boardPath, { fetch: false }));
  const content = read();
  if (content == null) return { repathed: false, reason: 'no-board' };
  let body;
  try {
    ({ body } = splitBoard(content));
  } catch {
    return { repathed: false, reason: 'no-sentinels' };
  }
  const lines = body.split('\n');
  const idx = findRowLineIndex(lines, slug);
  if (idx === -1) return { repathed: false, reason: 'no-row' };
  const cells = cellsOf(lines[idx]);
  const oldCell = cells[3] ?? '';
  const newCell = repathPlanClaimCell(oldCell, slug, toSubfolder);
  if (newCell === oldCell) return { repathed: false, reason: 'already-correct' };
  const update =
    runUpdate ||
    ((s, c) =>
      retryOnForeignDirt(
        () =>
          execFileSync('node', [join(scriptsDir, 'board.mjs'), 'update', s, '--plan-claim', c], {
            cwd: mainDir,
            encoding: 'utf8',
            stdio: ['ignore', 'inherit', 'pipe'],
          }),
        { label: `board update ${s}` },
      ));
  try {
    update(slug, newCell);
  } catch (e) {
    // Row-vanish race: board.mjs's fresh pull no longer sees the row our local
    // read found (a parallel done-worktree removed it) → nothing left to
    // repath. Benign; swallow. Re-throw any OTHER failure.
    if (/row not found/i.test(`${e.stderr || ''} ${e.message || ''}`)) {
      return { repathed: false, reason: 'row-vanished' };
    }
    throw e;
  }
  return { repathed: true, newCell };
}

// --- driver-side board row at claim time (plan 506) ---------------------------

// The fixed, lint-clean "Plan / claim" cell for a drain claim. lint-board.mjs
// requires a recognisable `<status-dir>/NNN-….md` reference in this cell
// (NO_PLAN_REF otherwise) and the named subfolder must match where the file
// actually lives — which at claim time is in-progress/ (claimPlan moves it there
// first). Free-forming this cell is exactly what poisoned the board in the
// 2026-06-10 plan-479 incident: the worker wrote "<slug> (drain worker, host X)"
// with no filename, lint-board rejected the row, and every sibling push/landing
// was blocked until hand-fixed. So the cell is a driver-owned template now; the
// worker never composes it (see buildPlanPrompt). Seed marker: 🟩 only for an
// explicit seedWrite 'no' — 'yes'/'unknown'/missing renders 🟥 (conservative,
// the same rule as queue-drain's isSeedWrite).
export function buildClaimPlanCell(plan, host) {
  const seedMark =
    String(plan.seedWrite || '').toLowerCase() === 'no' ? '🟩 NON-SEED' : '🟥 SEED-WRITE';
  // plan 3960 review fix: IN_PROGRESS_FOLDER (configured), not a literal 'in-progress' — claimPlan
  // (line ~1559) moves the file to this SAME configured folder, so a renamed lanes.inProgress used
  // to make this board cell name a path the file was never moved to, tripping the immediate
  // Plan/claim-cell lint on every claim.
  return `\`${IN_PROGRESS_FOLDER}/${plan.slug}.md\` · drain worker (plan-231) · host=\`${host}\` · ${seedMark}`;
}

// Row-level lint of ONE just-written board row: lint-board.mjs's
// validateRowInContent scoped to this slug, against the real plan tree
// (planBasenameMap — both shared with board.mjs's write-time lint since plan
// 511) — so a sibling's pre-existing drift can't fail OUR write (the full-board
// lint still gates every push). Throws on any finding; the caller decides the
// cleanup. Seams (readBoard / basenames) are injectable for tests.
export function verifyBoardRowLintClean(mainDir, slug, { readBoard, basenames } = {}) {
  const boardRel = loadCoordConfig(mainDir).paths.boardFile;
  const boardPath = join(mainDir, boardRel);
  // F-003 (plan 1312, plan-989 regression): board.mjs claim just committed+pushed the row via
  // the DISPOSABLE coord-checkout — MAIN's working-tree board.md was NOT freshened and is
  // structurally missing it. Reading MAIN here made every real (non-test-seamed) drain claim
  // fail ROW_NOT_FOUND deterministically, and the catch in writeClaimBoardRow then REMOVED the
  // freshly-written good row after the plan file had already moved to in-progress/ — stranding
  // the plan unowned. Verify against the authoritative origin/master view instead.
  const read = readBoard || (() => readBoardAuthoritative(mainDir, boardRel, boardPath));
  const content = read();
  if (content == null) {
    throw new Error('drain-run: board file not found after board write');
  }
  const byBasename = basenames || planBasenameMap(join(mainDir, 'docs', 'superpowers', 'plans'));
  const errors = validateRowInContent(content, slug, byBasename);
  if (errors.some((e) => e.kind === 'ROW_NOT_FOUND')) {
    throw new Error(`drain-run: board row for ${slug} not found after board write`);
  }
  if (errors.length > 0) {
    const detail = errors.map((e) => `[${e.kind}] ${e.hint}`).join('; ');
    throw new Error(`drain-run: just-written board row for ${slug} fails lint-board: ${detail}`);
  }
}

// Write the worker's ACTIVE board row at claim time — DRIVER-side (plan 506).
// The driver knows the exact in-progress/ path (it just moved the file there),
// so it owns the lint-sensitive "Plan / claim" cell; the worker only flips
// state. Lint-at-write-time (T2): the row is re-read and validated immediately
// after board.mjs claim; a poisoned row is best-effort REMOVED before the throw,
// so it is never left blocking siblings' pushes. No-op on a board-less repo
// (legacy single-write project — mirrors lint-board's bootstrap safety and
// repathBoardRow's 'no-board'). Seams (runClaim / runRemove / verify / host /
// hasBoard) are injectable for tests; the defaults shell out to board.mjs, whose
// coordWrite handles fresh-base + non-ff retry.
export function writeClaimBoardRow(
  mainDir,
  scriptsDir,
  plan,
  dateStr,
  { host = hostname(), hasBoard, runClaim, runRemove, verify } = {},
) {
  const boardExists =
    hasBoard ?? existsSync(join(mainDir, loadCoordConfig(mainDir).paths.boardFile));
  if (!boardExists) return { written: false, reason: 'no-board' };
  const cell = buildClaimPlanCell(plan, host);
  const boardCmd = (args) =>
    retryOnForeignDirt(
      () =>
        execFileSync('node', [join(scriptsDir, 'board.mjs'), ...args], {
          cwd: mainDir,
          encoding: 'utf8',
          stdio: ['ignore', 'inherit', 'pipe'],
        }),
      { label: `board ${args[0]} ${plan.slug}` },
    );
  const claim =
    runClaim ||
    ((slug, planClaim) =>
      boardCmd([
        'claim',
        slug,
        '--state',
        'ACTIVE',
        '--plan-claim',
        planClaim,
        '--touched',
        dateStr,
        '--resume',
        `drain worker (plan-231) executing on host \`${host}\``,
      ]));
  claim(plan.slug, cell);
  try {
    (verify || (() => verifyBoardRowLintClean(mainDir, plan.slug)))();
  } catch (e) {
    // T2's "never leave a poisoned row": best-effort remove before failing loudly.
    const remove = runRemove || ((slug) => boardCmd(['remove', slug]));
    try {
      remove(plan.slug);
    } catch {
      /* removal is best-effort — the throw below still halts the drain */
    }
    throw e;
  }
  return { written: true, cell };
}

// Derive the status subfolder ("in-progress", "waiting-operator", …) from a plan
// path like docs/superpowers/plans/<subfolder>/<slug>.md. null if not matched.
// Backslashes are normalised first so a Windows-style path still matches.
function planSubfolder(planPath) {
  const m = String(planPath)
    .replace(/\\/g, '/')
    // plan 2678: tolerate the optional one-level category folder between the status and the
    // file. Every path this is called with TODAY is one this file composed flat, so the old
    // shape never misfired — but it returned a silent `null` (not an error) for a real
    // on-disk categorised path, which is the trap the shared classifier exists to close.
    .match(/plans\/([^/]+)\/(?:[a-z0-9-]+\/)?[^/]+\.md$/);
  return m ? m[1] : null;
}

// Coordinate a plan-file status move + its board-row repath so a foreign-dirt
// exhaustion can NEVER leave a BOARD_SUBFOLDER_DRIFT (plan 622 finding 1). The
// pre-622 order moved the file FIRST and repathed the board row LAST, then STOPPED on
// a repath foreign-dirt exhaustion — leaving the file moved while the row still named
// the OLD subfolder → lint-board's full-board BOARD_SUBFOLDER_DRIFT blocked EVERY
// sibling's push until hand-fixed. We KEEP the file move first (it is what commits the
// park's pending `**Blocked-by:**` body edit via gitMoveCommit, leaving a CLEAN tree —
// repathing FIRST would run the board coordWrite against that uncommitted edit and
// self-trip its own foreign-dirt guard on every park) and instead COMPENSATE: if the
// post-move repath exhausts its budget against GENUINE sibling dirt, UNDO the file move
// via `unmoveFile` — raw git (a rename push, NOT a coordWrite), so the sibling dirt that
// blocks the repath does not block the rollback. Net result: row + file both back at the
// source subfolder → no drift. A no-op repath (no board row — the claim-time case, plan
// 506) needs no rollback. Seams (moveFile / unmoveFile / repath) are injectable for
// tests. Returns the repath result.
export function orderedPlanMove({ moveFile, unmoveFile, repath, toSubfolder }) {
  // Move the file first: gitMoveCommit commits the pending body edit + the rename,
  // leaving a clean tree the repath's coordWrite can run against without self-tripping.
  moveFile();
  if (!toSubfolder) return { repathed: false, reason: 'no-target' };
  try {
    return repath(toSubfolder);
  } catch (e) {
    // The file moved + pushed but the board row did NOT repath → a drift would be left.
    // Roll the file move back so row + file agree again. The rollback is raw git, so the
    // foreign dirt that blocked the coordWrite repath does not block it.
    if (unmoveFile) {
      try {
        unmoveFile();
      } catch {
        /* best-effort rollback — the repath error below is the one that matters */
      }
    }
    throw e;
  }
}

// F-002 (plan 1312, 2026-07-02 coord audit): the drain's rename+push+INDEX window runs UNDER
// the coord-write lock. pushMasterWithRebase and syncIndexOnMaster both run
// `git rebase origin/master` retry loops DIRECTLY on the shared MAIN checkout; without the
// lock, heal-main (auto-mode, any of the ~5-7 sessions) could observe the transient
// rebase-merge/rebase-apply state mid-flight and `git rebase --abort` a LIVE operation.
// heal-main's own steps 1-4 take this same lock, so holding it here makes the two mutually
// exclusive. The lock must NOT extend to the board repath (orderedPlanMove's `repath`) —
// that shells board.mjs, which acquires this same lock in a subprocess and would deadlock
// against us until the 240s timeout. Exported as a factory (with `_syncIndex` seamed) so the
// lock wrap is testable against a real repo without build-index's repo-root machinery.
export function makeRenameMoveSync(mainDir, scriptsDir, idxMsg, { _syncIndex } = {}) {
  const syncIndex = _syncIndex || syncIndexOnMaster;
  return (a, b, msg) =>
    withCoordLock(
      mainDir,
      () => {
        gitMoveCommit(mainDir, a, b, msg);
        pushMasterWithRebase(mainDir);
        syncIndex(mainDir, scriptsDir, idxMsg);
      },
      { tool: 'drain-move' },
    );
}

// Move a plan between status subfolders on master, surviving concurrent pushes. Two
// divergence-tolerant file steps (NOT index.mjs — its internal `git pull --ff-only`
// aborts the moment a parallel session has pushed, which wedged the drain mid-iteration):
// (1) commit the plan-file rename and push with rebase-retry — unique paths, so a rebase
// ~never conflicts; (2) re-derive INDEX from the merged tree and push
// (drop-rebase-regenerate on non-ff). Then repath the worker's board row (plan 422) so
// its subfolder token tracks the move — a no-op when no row exists (the usual case at
// claim time — the driver writes the row AFTER this move, plan 506). orderedPlanMove
// rolls the rename back (`unmoveFile`) if that repath can't complete, so a foreign-dirt
// exhaustion never strands a BOARD_SUBFOLDER_DRIFT (plan 622 finding 1).
function movePlanOnMaster(
  mainDir,
  scriptsDir,
  plan,
  from,
  to,
  commitMsg,
  pendingBody = null,
  corpus = null,
  // Test-only seam (plan 2500): substitutes the real board gate so a test can force the
  // "gate throws something unexpected" branch below without having to smuggle a poisoned
  // corpus through claimPlan's earlier dropStaleBlockedBy call (which would trip on the
  // very same statusOf/isShipped before movePlanOnMaster is ever reached). Every real
  // caller leaves this null, so production always calls the real
  // `assertBoardInvariantsForPending` below — the board-write-gate.test.mjs "every
  // plan-mutating write path calls the board gate" source-scan depends on that literal
  // call staying present, not just imported.
  gateOverride = null,
) {
  // plan 2426 (operator ruling Q3): the write-time board gate, at the drain's SINGLE
  // folder-crossing choke point. Every caller inherits it, so a future fifth park/claim
  // path cannot re-open the hole this plan closes.
  //
  // In practice only the CLAIM caller can ever trip it, and that is by construction, not by
  // luck: the stage/folder invariant is scoped to `pending-approval/` (which no caller here
  // targets), and the live-Blocked-by check only fires in `ready/`/`in-progress/` — so the
  // four `parkToWaitingOperator` callers, whose destination is a waiting lane, no-op through
  // it. The remaining caller is `claimPlan`.
  //
  // Judged against the DESTINATION path — exactly the state the `git mv` is about to
  // commit. `pendingBody` is the body the caller ALREADY has in hand (the claim flip, or the
  // park's Blocked-by insert, both written to `from` moments ago); it is re-read from disk
  // only for a caller that did not pass one. Refusing here, before `orderedPlanMove` runs,
  // means nothing has been committed or pushed; `claimPlan` additionally restores its own
  // working-tree edit so a refusal leaves the shared MAIN checkout byte-clean for every
  // parallel session's coord writes.
  //
  // ERROR POSTURE — three distinct outcomes, none of them "swallow" and none of them
  // "crash the run" (both review rounds landed on this line; round 1 killed the original
  // fail-OPEN, round 2 caught that a bare uncaught throw fails LOUD but UNCONTAINED —
  // movePlanOnMaster has five callers and the four park paths have no try/catch at all, so
  // one library-level bug would take down a multi-hour, multi-worker unattended run and
  // abandon every in-flight worker):
  //
  //   1. Destination outside the gate's scope  -> DON'T CALL IT. A park targets a waiting
  //      lane where both invariants are provably inert, so the drain's own recovery routes
  //      never even enter the gate's blast radius.
  //   2. Source file unreadable                -> nothing to judge; the move reports it.
  //   3. Gate throws something unexpected      -> FAIL CLOSED, CONTAINED: re-raise it as a
  //      BoardInvariantError. "The gate could not run" must never read as "the gate
  //      passed", and the FILL loop already knows how to handle that type — skip this plan,
  //      record it, keep draining — so one bad plan body costs one plan, not the run.
  const toSubfolder = planSubfolder(to);
  if (gateAppliesToFolder(toSubfolder)) {
    let body = pendingBody;
    if (body == null) {
      try {
        body = readFileSync(join(mainDir, from), 'utf8');
      } catch {
        body = null; // vanished under us — nothing to gate; the move reports it
      }
    }
    if (body != null) {
      try {
        if (gateOverride) {
          gateOverride(mainDir, [{ path: to, content: body }], {
            tool: `drain-run (${plan.slug})`,
            corpus,
          });
        } else {
          assertBoardInvariantsForPending(mainDir, [{ path: to, content: body }], {
            tool: `drain-run (${plan.slug})`,
            corpus, // reuse the caller's view — see claimPlan; null falls back to a rebuild
          });
        }
      } catch (e) {
        if (e instanceof BoardInvariantError) throw e;
        throw new BoardInvariantError(
          `drain-run (${plan.slug}): REFUSING this move — the board-invariant gate itself ` +
            `failed to run (${e && e.message ? e.message : e}). Treating an unrunnable gate ` +
            `as a refusal, never as a pass.`,
          [{ kind: 'gate-error', detail: `gate threw: ${e && e.message ? e.message : e}` }],
        );
      }
    }
  }
  const idxMsg = `docs(plans): sync INDEX — ${plan.slug} move (drain)`;
  // The rename step is the shared `gitMoveCommit` primitive (coord-git.mjs): `git mv` +
  // `git commit -- from to` by pathspec, never `git add <from>` (the source is gone from
  // disk post-mv — that fatal is the foot-gun plan 363 closes). The body edit a park made
  // before the move rides along in the same commit.
  const renameMoveSync = makeRenameMoveSync(mainDir, scriptsDir, idxMsg);
  orderedPlanMove({
    moveFile: () => renameMoveSync(from, to, commitMsg),
    // Reverse the rename if the post-move board repath can't complete (plan 622).
    unmoveFile: () =>
      renameMoveSync(to, from, `drain: roll back ${plan.slug} move — board repath blocked (drain)`),
    // The repath shells board.mjs through coordWrite (foreign-dirt-retried).
    repath: (sub) => repathBoardRow(mainDir, scriptsDir, plan.slug, sub),
    toSubfolder,
  });
}

// Claim a plan deterministically BEFORE the worker runs: git mv ready/ →
// in-progress/ on master + push. This is the folder-level lock the pickup ritual
// (step 5d) mandates: until the plan leaves ready/, the oracle — and any parallel
// session — can re-pick a plan that is already being worked. Moving it to
// in-progress/ also means (a) a completed-but-unlanded plan (e.g. a dogfood-caution
// plan the worker builds but won't auto-land) no longer re-appears in ready/ to
// trip plan_not_advancing, and (b) the worker's done-worktree close-out finds the
// plan exactly where it expects it (in-progress/), not stranded in ready/. The
// DRIVER also writes the worker's ACTIVE board row (plan 506) — AFTER the move,
// so the cell's in-progress/ path matches where the file now lives, and lint-
// checked at write time so a poisoned row is never left for siblings to discover.
// The worker writes only its handoff session entry and flips its row's STATE
// (board.mjs set-state) — it never composes the Plan/claim cell (the plan-479
// NO_PLAN_REF incident). No-op (logs) if the plan isn't in ready/ — mirrors
// quarantinePlan's missing-file guard.
// Stamp a ready/ plan's body 🔄 IN PROGRESS at claim time (plan 619, the upstream
// half of the body-state-sync fix). The drain claim historically moved
// ready/→in-progress/ but left the body frozen at authoring-time `📋 READY` —
// only the ref-CAS `claim-plan.mjs` / manual pickup flipped it. Reuse that same
// helper (srcFolder 'ready' → no Override line) so a drain-run plan's body tracks
// its folder. Pure transform; the git-mv that follows carries the working-tree edit
// into the committed rename (the parkToWaitingOperator mechanism).
// plan 2426 (operator ruling Q2): `blockedView` rides through to the shared
// flipStatusToInProgress seam, so the drain's claim drops a STALE Blocked-by line exactly
// like `claim-plan`'s does — ONE implementation of the rule, covering BOTH claim paths.
// Deliberately no `blockedOk` counterpart: ruling Q3 gives the unattended drain no override
// at all, so there is nothing here that could carry one.
export function stampClaimInProgress(body, { host, slug, date, blockedView = null }) {
  return flipStatusToInProgress(body, { host, slug, date, srcFolder: READY_FOLDER, blockedView });
}

// Exported for the plan-2426 real-repo test: the board gate lives at the movePlanOnMaster
// choke point, and the ONLY way to prove the refusal leaves the SHARED main checkout
// byte-clean is to drive this function against a real tree (the runDrain loop tests inject
// a `claim` seam and would never exercise it). `_gate` (plan 2500) is the same test-only
// override movePlanOnMaster accepts — threaded through so a test can force the gate's
// "threw something unexpected" branch without a real caller ever setting it.
export function claimPlan(mainDir, scriptsDir, plan, dateStr, { _gate = null } = {}) {
  // plan 3960 cluster-3 review fix: these two used to hardcode the literal folder names while
  // other drain-run.mjs call sites already read READY_FOLDER / IN_PROGRESS_FOLDER — a renamed
  // lane would break the claim move asymmetrically against whatever reads the configured names.
  const from = `docs/superpowers/plans/${READY_FOLDER}/${plan.slug}.md`;
  const to = `docs/superpowers/plans/${IN_PROGRESS_FOLDER}/${plan.slug}.md`;
  const absFrom = join(mainDir, from);
  if (!existsSync(absFrom)) {
    console.error(`drain-run: cannot claim ${plan.slug} — ${from} not found (not in ready/?)`);
    return;
  }
  mkdirSync(join(mainDir, `docs/superpowers/plans/${IN_PROGRESS_FOLDER}`), { recursive: true });
  // Flip the body to 🔄 IN PROGRESS BEFORE the `git mv` so the move carries the edit
  // into the claim commit (plan 619). Without this the body read 📋 READY all the way
  // through execution AND into archive/ — the staleness the move-plan fix closes.
  const originalBody = readFileSync(absFrom, 'utf8');
  const corpus = loadCorpusView(mainDir, [to]);
  const flipped = stampClaimInProgress(originalBody, {
    host: hostname(),
    slug: plan.slug,
    date: dateStr,
    blockedView: blockedViewFor(corpus, `${plan.slug}.md`),
  });
  writeFileSync(absFrom, flipped);
  try {
    movePlanOnMaster(
      mainDir,
      scriptsDir,
      plan,
      from,
      to,
      `drain: claim ${plan.slug} → in-progress (${dateStr})`,
      flipped, // already in hand — no re-read of the file we just wrote
      corpus, // already built for the flip above — one corpus load per claim, not two
      _gate,
    );
  } catch (e) {
    // plan 2426 (ruling Q3): "the plan file is left untouched in ready/". The flip above is
    // an UNCOMMITTED working-tree edit on the SHARED main checkout, so leaving it behind on
    // a refusal would hand every parallel session's next coord write a foreign-dirt refusal
    // — the drain would break siblings by declining to claim. Restore it.
    //
    // Scoped to BoardInvariantError on purpose: that is raised at the top of
    // movePlanOnMaster, before any git op, so the file is provably still at `from`. A later
    // failure (mid-`git mv`, mid-push) may have already renamed it, where re-writing `from`
    // would materialize a spurious duplicate at the old path.
    if (e instanceof BoardInvariantError) {
      try {
        writeFileSync(absFrom, originalBody);
      } catch {
        /* best-effort — the refusal below is the outcome that matters */
      }
    }
    throw e;
  }
  writeClaimBoardRow(mainDir, scriptsDir, plan, dateStr);
}

// File a `blocked` plan: in-progress/ → waiting-operator/ on master, with an
// operator-approval Blocked-by note (naming the pushed sha when there is one).
// Used for BOTH block kinds since plan 444 (the loop continues past either):
//   - WORK-PUSHED (`shippedSha` a real sha): the note says "land after approval"
//     and the worker's pushed worktree is KEPT for the operator to land.
//   - SKETCH / fan-out (`shippedSha` empty): nothing was built; the plan still
//     files here (NOT back to ready/ — that would let the oracle re-pick it and
//     trip plan_not_advancing) for operator triage.
// Unlike quarantinePlan (a gate FAILURE, which counts toward the 2-quarantine
// HALT), a block does NOT halt the run. The worktree is NOT torn down (the driver
// never tears worktrees down — that's done-worktree's job). The board row's STATE
// stays the WORKER's to flip to ⏸ PAUSED via board.mjs set-state (the Plan/claim
// cell itself is driver-owned since plan 506 — see buildPlanPrompt); the driver
// owns the folder lock. No-op (logs) if the plan isn't in in-progress/ —
// mirrors the other move helpers' missing-file guard.
export function quarantineBlockedToOperator(mainDir, scriptsDir, plan, dateStr, shippedSha) {
  const shaNote = shippedSha
    ? ` Worker built + pushed \`${shippedSha}\` — land after approval.`
    : '';
  parkToWaitingOperator(mainDir, scriptsDir, plan, {
    fromSubfolder: IN_PROGRESS_FOLDER,
    // Fix round 1 (finding G, key 818ed3): `[axis: manual]` — the plan's own checkpoint is an
    // out-of-band operator action the drain cannot grant, the same shape `unblock: manual`
    // already names. Textual only — this direct-write park does not route through move-plan.mjs's
    // CLI gate (see parkCostPausePlan's own comment above).
    blockedBy: `[axis: manual] operator approval — blocked at the plan's own operator checkpoint in drain ${dateStr} (the drain can't grant it).${shaNote}`,
    commitMsg: `drain: ${plan.slug} → waiting-operator (work-pushed block, operator checkpoint ${dateStr})`,
    missingLabel: 'file (blocked)',
    date: dateStr,
    statusReason: "blocked at the plan's own operator checkpoint (drain can't grant it)",
  });
}

// Park a plan that failed the cost gate (plan 518): ready/ → waiting-operator/
// with a cost-pause Blocked-by line. Unlike quarantineBlockedToOperator this
// sources from ready/ — the plan was never claimed (the cost gate runs BEFORE
// the claim). Non-interactive runs park-and-continue here instead of
// terminating the whole run (the retired `cost_pause` termination reason);
// interactive runs park only when the operator declines the prompt. Parking
// (not leaving in ready/) is required under a continuing loop — a plan left in
// ready/ would be re-picked and trip plan_not_advancing (plan 444 reasoning).
// `why` (fix, finding 7f22d1): the SPECIFIC predicate that fired at the cost gate — the caller
// (runDrain's FILL loop) already computes this to build its log line / prompter payload, and
// passes the SAME text here so the parked Blocked-by states it too, instead of the old
// unconditional "declares over the spend ceiling" claim, which was FALSE for a data-pass pause
// (R2's "any non-zero cash always asks" applies regardless of the ceiling — the plan need not be
// anywhere near it). Defaults to the pre-fix generic wording only when no `why` is supplied, so
// every pre-4069 direct call (this file's own PARK_HELPER_CASES fixtures included) stays
// behaviourally unchanged.
export function parkCostPausePlan(mainDir, scriptsDir, plan, dateStr, why) {
  const reason = why || 'declares over the spend ceiling or no parseable cost';
  parkToWaitingOperator(mainDir, scriptsDir, plan, {
    fromSubfolder: READY_FOLDER,
    // plan 4069 (task 1): an `[axis: money]` marker, consistent with every other
    // waiting-operator/ park, even though this direct git-level write does not route through
    // move-plan.mjs's CLI gate (drain-run.mjs's own park primitive, not a `move-plan.mjs`
    // subprocess call — see parkToWaitingOperator above).
    blockedBy: `[axis: money] cost-pause in drain ${dateStr} — ${reason}; operator approves the spend (or runs it by hand), then promotes back to ready/.`,
    commitMsg: `drain: ${plan.slug} → waiting-operator (cost-pause ${dateStr})`,
    missingLabel: 'cost-park',
    date: dateStr,
    statusReason: `cost-pause (${reason}) — operator approves the spend`,
  });
}

// Park a plan whose driver-side land hit a non-retryable spine seam (plan 518):
// in-progress/ → waiting-operator/ with a seam-naming Blocked-by line. The
// worktree is KEPT — the operator resumes the land via done-worktree (--resume
// for seam-specific recovery). Mirrors quarantineBlockedToOperator's shape.
export function parkLandSeamPlan(mainDir, scriptsDir, plan, dateStr, seam, reason) {
  parkToWaitingOperator(mainDir, scriptsDir, plan, {
    fromSubfolder: IN_PROGRESS_FOLDER,
    // Fix round 1 (finding G, key 34aae6): `[axis: manual]` — resuming a stuck land via
    // done-worktree is an out-of-band operator action, textual only (see above).
    blockedBy: `[axis: manual] drain land seam ${seam} ${dateStr} — ${reason ?? 'driver-side land halted'}; worktree kept, operator resumes via done-worktree.`,
    commitMsg: `drain: ${plan.slug} → waiting-operator (land seam ${seam} ${dateStr})`,
    missingLabel: 'land-park',
    date: dateStr,
    statusReason: `unclassified land seam ${seam} — operator looks (worktree kept)`,
  });
}

// Park a plan whose driver-side claim hit a board-lint refusal (plan 817): its
// basename category segment is malformed (e.g. lowercase `811-price-…`), so board.mjs's
// write-time cell lint refused the "Plan / claim" cell with NO_PLAN_REF (isBoardLintRefusal).
// The claim already moved the file ready/ → in-progress/ BEFORE the board write threw, so
// this sources from in-progress/ (mirrors quarantineBlockedToOperator / parkLandSeamPlan).
// Unlike a foreign-dirt refusal this is DETERMINISTIC — retrying never helps — so the run
// parks the plan for an operator to fix the basename, then CONTINUES the FILL loop instead
// of crashing and abandoning the in-flight workers. The worktree, if any, is left as-is
// (the claim failed before a worker spawned, so usually there is none).
export function parkBoardLintPlan(mainDir, scriptsDir, plan, dateStr) {
  parkToWaitingOperator(mainDir, scriptsDir, plan, {
    fromSubfolder: IN_PROGRESS_FOLDER,
    // Fix round 1 (finding G, key 34aae6): `[axis: manual]` — hand-fixing a malformed basename
    // is an out-of-band operator action, textual only (see above).
    blockedBy: `[axis: manual] malformed slug — board lint NO_PLAN_REF in drain ${dateStr}; fix the basename category segment to \`NNN-[A-Z]…\` (e.g. \`price\` → \`Price\`), then \`node scripts/move-plan.mjs <id> ready\`.`,
    commitMsg: `drain: ${plan.slug} → waiting-operator (board lint NO_PLAN_REF ${dateStr})`,
    missingLabel: 'board-lint-park',
    date: dateStr,
    statusReason:
      'malformed slug — board lint NO_PLAN_REF; fix the basename category, then promote back to ready/',
  });
}

// Land one plan via the deterministic done-worktree spine (plan 518): the
// driver — never the worker — runs `node scripts/done-worktree.mjs <slug>`.
// Resolves with {code, stdout} and never rejects; classifySpineExit interprets
// the HANDOFF:<CODE> line / distinct exit code. Wired as runDrain's `land`
// seam by the CLI for phase-3 runs (unit tests inject fakes; --dry-run stubs).
// plan 629: --carryforward-defer so a post-merge ambiguous carry-forward NEVER halts
// the autonomous land — the parent archives, each undecided bullet becomes its own
// waiting-operator/ stub (instead of parking the whole shipped plan with a stale body).
export function makeSpineLander({ mainDir = resolveMain(), scriptsDir = SCRIPTS_DIR } = {}) {
  return (plan) =>
    spineExit(
      execFileP(
        'node',
        [join(scriptsDir, 'done-worktree.mjs'), plan.slug, '--carryforward-defer'],
        {
          cwd: mainDir,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        },
      ),
    );
}

// plan 629 Task 1: finish a POST-merge-seam'd land whose code ALREADY shipped (branch
// is an ancestor of origin/master). Re-invoke the spine with `--resume <seam>` to skip
// the post-merge fork (deploy / promote) and `--carryforward-defer` to auto-file any
// ambiguous carry-forward — so the close-out ARCHIVES the parent + removes the board
// row + tears down, never leaving the shipped plan in waiting-operator/. Same
// {code, stdout} contract as makeSpineLander; injected as runDrain's `finishLand`.
export function makeSpineFinisher({ mainDir = resolveMain(), scriptsDir = SCRIPTS_DIR } = {}) {
  return (plan, seam) =>
    spineExit(
      execFileP(
        'node',
        [
          join(scriptsDir, 'done-worktree.mjs'),
          plan.slug,
          '--resume',
          seam,
          '--carryforward-defer',
        ],
        { cwd: mainDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      ),
    );
}

// Shared {code, stdout}-never-rejects adapter for a spine execFileP promise.
function spineExit(p) {
  return p.then(
    ({ stdout }) => ({ code: 0, stdout: String(stdout ?? '') }),
    // Non-exit failures (ENOENT, maxBuffer, …) have no numeric code and often no
    // stdout — fall back to the error message so the UNKNOWN-seam park reason carries
    // a diagnostic instead of being a dead end.
    (e) => ({
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: `${e.stdout ?? ''}` || `${e.message ?? ''}`,
    }),
  );
}

// Claim a fresh plan id for a carry-forward stub via next-plan-id.mjs, retrying on
// a TRANSIENT foreign-dirt refusal (plan 622 finding 2). next-plan-id.mjs claim
// routes through coordWrite, which throws the assertCleanOutsidePathspec refusal when
// a sibling session holds a brief uncommitted edit in the shared main checkout — the
// SAME condition the rest of the drain now rides out (claim / board / fold paths all
// wrap their coord shell-outs in retryOnForeignDirt). Without this retry that refusal
// fell straight into mintCarryForwardPlans's per-item catch and SILENTLY DROPPED the
// stub (only the drain-state.json manifest survived). On budget exhaustion it still
// throws coordContention, which the per-item catch logs+skips — "a flaky mint
// degrades, not destroys." `claimExec(args) => stdout` is the injectable subprocess
// seam. Scans stdout for the bare id line (next-plan-id prints the id to stdout, its
// message to inherited stderr); \d{3,} (not exactly 3) future-proofs past plan 999.
export function claimCarryForwardId(claimExec, claimArgs, { label, retryOpts = {} } = {}) {
  const out = retryOnForeignDirt(() => claimExec(claimArgs), {
    label: label || 'carry-forward claim',
    ...retryOpts, // tests inject { sleep, backoff } to skip the real backoff
  });
  const id = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d{3,}$/.test(l))
    .pop();
  if (!id) {
    throw new Error(
      `next-plan-id claim returned no id (stdout: ${JSON.stringify(String(out).trim())})`,
    );
  }
  return id;
}

// Mint the worker's open-new-plan carry-forwards as real plans, parked in
// waiting-operator/ for operator triage (plan 388 — closes the Phase-3 drop). Two
// tested sub-tools do the git work, so this helper carries no bespoke push logic:
//   next-plan-id.mjs claim        — race-safe id + plan file in ready/ + INDEX
//                                   bullet + commit + push (non-ff recovery).
//   move-plan.mjs <id> waiting-operator — git mv ready/→waiting-operator/ + a
//                                   Blocked-by header + INDEX regen + commit + push.
// Returns the minted plan basenames (no .md). A failure to mint ONE item is
// recorded + skipped — it NEVER aborts the drain (the manifest is still in
// drain-state.json for manual recovery, so a flaky mint degrades, not destroys).
function mintCarryForwardPlans(mainDir, scriptsDir, plan, carryForward, dateStr) {
  const mintable = mintableCarryForwards(carryForward);
  if (mintable.length === 0) return [];
  const minted = [];
  // .scratch/ (gitignored, agent-only) — NOT review-only output/ (plan 430).
  const tmpDir = join(mainDir, '.scratch');
  mkdirSync(tmpDir, { recursive: true });
  // claim prints the message to stderr (inherited) and the bare id to stdout.
  const claimExec = (args) =>
    execFileSync('node', [join(scriptsDir, 'next-plan-id.mjs'), ...args], {
      cwd: mainDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  for (let i = 0; i < mintable.length; i++) {
    const item = mintable[i];
    const slug = carryForwardSlug(item.title);
    const seedWrite = String(item.seed_write || '').toLowerCase() === 'yes' ? 'yes' : 'no';
    const tmpFile = join(tmpDir, `.drain-carryforward-${plan.slug}-${i}.md`);
    try {
      writeFileSync(
        tmpFile,
        renderCarryForwardPlanBody(item, { parentSlug: plan.slug, date: dateStr }),
      );
      // No --blurb: renderCarryForwardPlanBody always writes a `summary:` frontmatter, and
      // since plan 990 the INDEX bullet is derived from that body summary, not from --blurb.
      // A --blurb here would only differ from the body summary (the title-vs-blurb precedence
      // mismatch) and trip claim's advisory WARN without changing the bullet.
      // The claim routes through coordWrite — retry it on transient sibling foreign-dirt
      // instead of silently dropping the stub (plan 622 finding 2). (move-plan.mjs below
      // is NOT on the coordWrite path — it uses `pull --ff-only` — so its failure shape
      // differs and stays in the per-item catch.)
      const id = claimCarryForwardId(
        claimExec,
        [
          'claim',
          '--category',
          'Other',
          '--slug',
          slug,
          '--body',
          tmpFile,
          '--seed-write',
          seedWrite,
          '--date',
          dateStr,
        ],
        { label: `carry-forward claim ${slug}` },
      );
      const basename = `${id}-Other-${slug}`;
      execFileSync(
        'node',
        [
          join(scriptsDir, 'move-plan.mjs'),
          id,
          WAITING_OPERATOR_FOLDER,
          '--blocked-by',
          carryForwardBlockedByText(plan, dateStr),
        ],
        { cwd: mainDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
      );
      minted.push(basename);
    } catch (e) {
      console.error(
        `drain-run: failed to mint carry-forward "${item.title}" from ${plan.slug}: ${e.message}`,
      );
    } finally {
      try {
        rmSync(tmpFile, { force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
  return minted;
}

// --- driver loop -------------------------------------------------------------

export async function runDrain({
  ceiling = DEFAULT_CEILING_USD,
  accounts = null,
  phase = 2,
  workers = 1, // dispatcher-pool size (plan 518); 1 = serial, behavior-compatible
  reserve = DEFAULT_RESERVE_USD, // per-in-flight spend headroom for the spawn gate
  runner,
  prompter = null, // (kind, payload) => Promise<answer> — makeTtyPrompter; null = non-interactive (decide-or-park, never blocks)
  scriptsDir = SCRIPTS_DIR,
  mainDir = resolveMain(),
  dateStr = isoDate(),
  maxIterations = 100, // backstop against a runaway loop — bounds SPAWNS
  // Seams (default to the real impls; injected by the loop-level unit tests).
  oracle = () => runOracle(scriptsDir),
  claim = (plan) => claimPlan(mainDir, scriptsDir, plan, dateStr),
  quarantine = (plan) => quarantinePlan(mainDir, scriptsDir, plan, dateStr),
  quarantineToOperator = (plan, shippedSha) =>
    quarantineBlockedToOperator(mainDir, scriptsDir, plan, dateStr, shippedSha),
  // `why` (fix, finding 7f22d1): the caller passes the SAME branch-specific reason it already
  // computed for the log line / prompter payload, so the parked Blocked-by states the real
  // predicate (data-pass vs. genuinely over-ceiling) instead of a one-size-fits-all "over the
  // ceiling" claim. Every pre-4069 call site (and this file's own PARK_HELPER_CASES fixtures)
  // omits it, which parkCostPausePlan's own default covers unchanged.
  parkCostPause = (plan, why) => parkCostPausePlan(mainDir, scriptsDir, plan, dateStr, why),
  parkBoardLint = (plan) => parkBoardLintPlan(mainDir, scriptsDir, plan, dateStr),
  // Fix (finding c01265/3cc803, F7): read the operator's spend ceiling ONCE per drain run,
  // injectable so the loop-level tests can observe the call count directly.
  readCeiling = () => readOperatorSpendCeilingUsd(mainDir),
  mintCarryForwards = (plan, carryForward) =>
    mintCarryForwardPlans(mainDir, scriptsDir, plan, carryForward, dateStr),
  // Driver-side landing seam (plan 518): (plan) => Promise<{code, stdout}> over
  // the done-worktree spine. null DISABLES driver landing (unit-test default;
  // the CLI wires the real spine for a phase-3 run). Workers never land.
  land = null,
  landRetries = 5, // QUEUE_WAIT retry budget (another session holds the landing queue)
  landSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  parkLandSeam = (plan, seam, reason) =>
    parkLandSeamPlan(mainDir, scriptsDir, plan, dateStr, seam, reason),
  // plan 629 land-seam destination taxonomy seams (injected by the unit tests).
  // finishLand: re-invoke the spine to complete a POST-merge-seam'd close-out (archive);
  // null DISABLES the archive path (falls back to an operator park — wired by the CLI
  // alongside `land`). isBranchMerged / resumeInProgress have real defaults.
  finishLand = null,
  isBranchMerged = (slug) => isBranchMergedToMaster(mainDir, slug),
  resumeInProgress = (plan, seam) =>
    resumeInProgressLandSeam(mainDir, scriptsDir, plan, dateStr, seam),
  persist = (s) => saveState(mainDir, s),
} = {}) {
  runner = runner || makeClaudeRunner();
  let state = loadState(mainDir);
  // Record how this run was configured (audit; overwritten per run — the state
  // file accumulates outcomes across launches, but the config is per-launch).
  state = {
    ...state,
    run_config: { workers, reserve, interactive: !!prompter, phase, ceiling },
  };
  persist(state);
  const log = (m) => console.error(`[drain] ${m}`);
  const attempted = new Set(); // plans we've already run this session
  // plan 2426: slugs the write-time board gate refused at claim. They stay in ready/ (the
  // gate never mutates board state unattended), so the oracle keeps offering them — this
  // set is what stops the FILL loop re-picking them. See selectNextCandidate.
  const gateRefused = new Set();

  // --- dispatcher pool (plan 518) -------------------------------------------
  // FILL spawns workers until slots / budget / queue stop it, then ONE
  // completion is awaited (Promise.race) and folded; repeat. Claims are
  // synchronous (execFileSync) and happen inside FILL, so they serialize on the
  // event loop — the oracle can never hand two slots the same plan (the claim
  // moves it out of ready/ before the next oracle call). In-flight workers are
  // NEVER killed: every breaker stops *spawning* and drains what is running.
  // Keys are pool keys: the plan slug for a first run, `<slug>#cont` for a
  // continuation worker (blocked-plan triage) — distinct keys so a continuation
  // never collides with its parent's bookkeeping.
  const inFlight = new Map(); // poolKey → Promise<{key, plan, result, spendUsd}> (never rejects)
  const spawnedAt = new Map(); // poolKey → spawn ordinal (state.in_flight forensics)
  const triaged = new Set(); // slugs already offered a blocked_triage prompt (one grant per plan)
  let spawns = 0;
  let ceilingNow = ceiling; // raisable for THIS run via the interactive 'ceiling' prompt
  let quarantineLimit = MAX_QUARANTINES; // extendable via 'quarantine_limit' prompt
  let terminal = null; // sticky termination reason; once set, FILL stops
  // Fix (finding c01265/3cc803, F7): the operator's OWN per-plan spend ceiling
  // (coord.config.json's operatorSpendCeilingUsd — distinct from `ceilingNow`, this run's own
  // spend breaker) resolved ONCE for the whole run, not re-read per candidate plan: a large drain
  // otherwise does hundreds of synchronous config reads, and a config edit mid-run would make
  // otherwise-identical plans see different ceilings.
  const operatorCeilingUsd = readCeiling();

  const snapshotInFlight = () =>
    [...inFlight.keys()].map((key) => ({
      slug: key,
      spawned_at_iteration: spawnedAt.get(key) ?? null,
    }));
  const syncInFlight = () => {
    state = { ...state, in_flight: snapshotInFlight() };
    persist(state);
  };

  // Spawn one worker into the pool. Used by FILL (key = slug, default protocol)
  // and by the blocked-triage grant path (key = `<slug>#cont`, continuation
  // protocol via promptOverride). The wrapped promise NEVER rejects — the
  // runner already catches its own failures, and the .catch is belt-and-braces
  // so one bad worker can't tear down Promise.race for the whole pool.
  const spawnWorker = (plan, key, promptOverride = undefined) => {
    const account = pickAccount(accounts, spawns);
    spawnedAt.set(key, spawns);
    spawns++;
    inFlight.set(
      key,
      Promise.resolve()
        .then(() => runner(plan, { account, promptOverride }))
        .then(({ result, spendUsd }) => ({ key, plan, result, spendUsd }))
        .catch((e) => ({
          key,
          plan,
          result: { error: true, status: 'error', notes: e.message },
          spendUsd: 0,
        })),
    );
    syncInFlight();
  };

  // Serial landing chain: enqueued completions land strictly one at a time —
  // landing never blocks FILL/fold (execution and landing overlap; only
  // land-vs-land serializes). finish() awaits the chain.
  let landingChain = Promise.resolve();
  const enqueueLand = (plan, result) => {
    if (!land) {
      log(`  driver-landing disabled (no land seam) — ${plan.slug} stays in in-progress/`);
      return;
    }
    landingChain = landingChain
      .then(() => landOne(plan, result))
      .catch((e) => log(`  LAND ERROR ${plan.slug}: ${e.message} (drain continues)`));
  };

  async function landOne(plan, result) {
    for (let attempt = 0; ; attempt++) {
      log(`  land: ${plan.slug} via done-worktree spine (attempt ${attempt + 1})`);
      const exit = await land(plan);
      const verdict = classifySpineExit(exit);
      if (verdict.landed) {
        state = recordLanded(state, plan.slug);
        persist(state);
        log(`  landed: ${plan.slug}`);
        // Mint open-new-plan carry-forwards ONLY after a successful land (plan
        // 388 machinery; a parked land keeps its manifest in drain-state.json
        // and the operator files follow-ups when they land it by hand).
        const minted = mintCarryForwards(plan, result.carry_forward || []);
        if (minted && minted.length) {
          state = recordFiledCarryForwards(state, minted);
          persist(state);
          log(
            `  filed ${minted.length} carry-forward plan(s) → waiting-operator/: ${minted.join(', ')}`,
          );
        }
        return;
      }
      if (verdict.retryable && attempt < landRetries) {
        // QUEUE_WAIT: another session holds the landing queue — transient.
        const backoffMs = 30_000 + Math.floor(Math.random() * 30_000);
        log(
          `  land seam ${verdict.seam} — landing queue held elsewhere; retry in ${Math.round(backoffMs / 1000)}s (${attempt + 1}/${landRetries})`,
        );
        await landSleep(backoffMs);
        continue;
      }
      // plan 629: a halted land has three honest destinations, not one
      // waiting-operator/ park (the 2026-06-15 audit). branchMerged = "code already on
      // master" (a POST-merge seam); otherwise the seam decides land-stuck vs unknown.
      const detail =
        verdict.seam === 'UNKNOWN'
          ? ` — ${
              String(exit.stdout || '')
                .slice(0, 200)
                .trim() || 'no spine output'
            }`
          : '';
      const reason = `spine seam ${verdict.seam} after ${attempt + 1} attempt(s)${detail}`;
      const branchMerged = isBranchMerged(plan.slug);
      const disposition = landSeamDisposition(verdict.seam, branchMerged);

      if (disposition === 'archive' && finishLand) {
        // The merge landed (branch ⊑ origin/master) — a post-merge seam. The COMMON one,
        // CARRYFORWARD_AMBIGUOUS, never reaches here: makeSpineLander passes
        // --carryforward-defer so the FIRST land already archived + filed the stub. So
        // this re-invoke is the rarer DEPLOY_FAILED / PROMOTE_AMBIGUOUS — --resume <seam>
        // skips the fork and completes the close-out (archive + board-remove + teardown).
        log(
          `  land seam ${verdict.seam} but branch ALREADY merged — finishing close-out (archive)`,
        );
        const fin = classifySpineExit(await finishLand(plan, verdict.seam));
        if (fin.landed) {
          state = recordLanded(state, plan.slug);
          persist(state);
          log(`  landed (post-merge close-out completed): ${plan.slug}`);
          const minted = mintCarryForwards(plan, result.carry_forward || []);
          if (minted && minted.length) {
            state = recordFiledCarryForwards(state, minted);
            persist(state);
            log(
              `  filed ${minted.length} carry-forward plan(s) → waiting-operator/: ${minted.join(', ')}`,
            );
          }
          return;
        }
        // The finish re-invoke ITSELF re-seam'd. The code IS on master, so this is STILL
        // land-completion (re-run done-worktree to finish the bookkeeping), NOT an operator
        // decision — route it to the same HELD-in-in-progress resume path with a
        // RESUME-NEEDED marker (never park a shipped plan to waiting-operator/, the exact
        // pre-629 outcome). resumeInProgress no-ops cleanly if the partial close-out already
        // moved the file out of in-progress/.
        log(
          `  post-merge close-out re-seam'd (${fin.seam}) — held in in-progress/ to finish the land`,
        );
        resumeInProgress(plan, fin.seam);
        state = recordLandParked(state, {
          slug: plan.slug,
          seam: fin.seam,
          reason: `${reason}; post-merge close-out re-seam'd (${fin.seam}) — re-run done-worktree`,
          disposition: 'resume',
        });
        persist(state);
        return;
      }

      if (disposition === 'resume') {
        // Land-stuck (rebase/build/artifact/review/preflight): the land didn't complete.
        // KEEP the plan in in-progress/ with a RESUME-NEEDED marker + ⏸ PAUSED board row
        // (Option A, operator taxonomy 2026-06-15) — it's land-completion, not a decision.
        log(
          `  land held: ${plan.slug} — ${reason} (land-stuck; in-progress/ + RESUME-NEEDED, worktree kept)`,
        );
        resumeInProgress(plan, verdict.seam);
        state = recordLandParked(state, {
          slug: plan.slug,
          seam: verdict.seam,
          reason,
          disposition: 'resume',
        });
        persist(state);
        return;
      }

      // operator (UNKNOWN): genuinely unclear — park to waiting-operator/ for a human.
      log(`  land parked: ${plan.slug} — ${reason} (worktree kept)`);
      parkLandSeam(plan, verdict.seam, reason);
      state = recordLandParked(state, {
        slug: plan.slug,
        seam: verdict.seam,
        reason,
        disposition: 'operator',
      });
      persist(state);
      return;
    }
  }

  async function foldOutcome({ plan, result, spendUsd }) {
    const outcome = classifyOutcome(result);
    // One persist captures both the outcome fold AND the post-delete pool
    // snapshot (the caller deletes the key before folding) — the old separate
    // syncInFlight after every fold double-wrote the state file per fold.
    state = {
      ...nextState(state, {
        slug: plan.slug,
        outcome,
        spendUsd,
        carryForward: result.carry_forward,
      }),
      in_flight: snapshotInFlight(),
    };
    persist(state);
    log(`  → ${outcome}  (+$${round2(spendUsd)}, total $${state.cumulative_spend_usd})`);

    // plan 622 finding 3: once a PRIOR fold's (or claim's) park exhausted the
    // foreign-dirt budget and latched coord_contention terminal, the same sibling
    // dirt is still un-cleared. Re-running THIS worker's PARK (quarantine /
    // operator-file) would just re-thrash the full ~15-25s/6-attempt budget against
    // it — K×~20s of doomed shutdown retries. The outcome is already recorded above
    // for audit; SKIP the park. (A completed plan has no park; we skip its enqueueLand
    // too — not for thrash, but because starting a fresh done-worktree land while a
    // sibling holds the checkout dirty would likely fail as well. The plan is left in
    // in-progress/ with its worktree pushed, recoverable on a re-run.)
    if (terminal === 'coord_contention') {
      log(
        `  coord_contention already terminal — skipping ${plan.slug}'s park/land (left in place for a re-run)`,
      );
      return;
    }

    if (outcome === 'gate_failed' || outcome === 'error') {
      quarantine(plan);
      log(`  quarantined ${plan.slug}`);
    } else if (outcome === 'blocked') {
      // A blocked plan is PARKED for the operator and the loop CONTINUES (plan 444)
      // — a block no longer halts the run, so one launch drains a whole queue of
      // 🟥 apply-gated plans (407→432→442 used to need a launch each). Both kinds
      // file to waiting-operator/ so the oracle can't re-pick them (which would trip
      // plan_not_advancing); the only difference is the work-pushed kind KEEPS its
      // worktree for the operator to land. nextState already recorded the slug in
      // state.plans_blocked; finish() lists them at closing. Breakers (spend ceiling,
      // 2-quarantine for gate FAILURES, cost-pause) are unchanged — a block is not a
      // gate failure and the spend ceiling bounds how many apply-gated plans one run
      // builds.
      if (blockedHasShippedWork(result)) {
        // WORK-PUSHED block: the worker BUILT + PUSHED a worktree branch, then
        // blocked at the plan's own operator checkpoint (e.g. an A4 seed `--apply`
        // gate the drain can't grant).
        // Interactive triage (plan 518): offer the operator a live grant — a
        // 'grant' answer spawns a CONTINUATION worker on the pushed branch (the
        // plan stays in in-progress/, nothing is parked) whose completion flows
        // into the normal landing queue. One triage offer per slug — a
        // continuation that blocks AGAIN parks without re-prompting, so a
        // stuck plan can't ping-pong the operator forever.
        if (prompter && !triaged.has(plan.slug)) {
          triaged.add(plan.slug);
          const ans = await prompter('blocked_triage', { plan, result });
          // A grant still respects the spawn backstop — a continuation is a
          // spawn like any other (review finding: granting at the cap would
          // exceed maxIterations).
          if (ans === 'grant' && spawns < maxIterations) {
            log(
              `  operator GRANTED ${plan.slug}'s checkpoint — continuation worker resumes ${result.shipped_sha}`,
            );
            spawnWorker(
              plan,
              `${plan.slug}#cont`,
              buildContinuationPrompt(plan, result.shipped_sha),
            );
            return;
          }
          if (ans === 'grant') {
            log(
              `  grant for ${plan.slug} ignored — spawn backstop (max_iterations ${maxIterations}) reached; parking instead`,
            );
          }
        }
        // PRESERVE the work — file in-progress/ → waiting-operator/ and KEEP
        // the worktree; the operator grants the checkpoint and lands it.
        log(
          `  blocked at operator checkpoint — work pushed @ ${result.shipped_sha} → waiting-operator (worktree kept), continuing: ${result.notes ?? ''}`,
        );
        quarantineToOperator(plan, result.shipped_sha);
      } else {
        // SKETCH / FAN-OUT block: the worker made no worktree and shipped nothing.
        // File to waiting-operator/ (NOT back to ready/) — continuing with it in
        // ready/ would let the oracle re-pick it next iteration and trip
        // plan_not_advancing. This supersedes plan 363's revert-to-ready/, which was
        // correct only while a block HALTED the loop; with continue, ready/ loops.
        log(
          `  blocked (needs operator / fan-out, nothing shipped) → waiting-operator, continuing: ${result.notes ?? ''}`,
        );
        quarantineToOperator(plan, '');
      }
      // fall through → the pool keeps draining (the oracle picks the next eligible plan).
    } else {
      // completed. The full manifest is RECORDED in drain-state.json for audit
      // (nextState above).
      const cls = classifyCarryForwardKinds(result.carry_forward || []);
      const cf = (result.carry_forward || []).length;
      log(
        `  completed: ${plan.slug} @ ${result.shipped_sha ?? '?'} (${cf} carry-forward${cf === 1 ? '' : 's'})`,
      );
      if (phase < 3) {
        // Phase 2 leaves the worktree pushed; the operator lands it later and
        // files its carry-forwards then. Serial (--workers 1) keeps the legacy
        // stop-on-first-completion; a pool drains the whole queue and reports
        // phase2_paused_before_land at the end (plan 518 semantics change).
        if (workers === 1) terminal = terminal ?? 'phase2_paused_before_land';
        return;
      }
      // Phase 3 (plan 518): the WORKER no longer lands — the driver lands $0
      // plans serially via the done-worktree spine, and carry-forwards mint
      // after a successful land (landOne). A non-$0 completed plan stays in
      // in-progress/ with its worktree pushed for the operator to land.
      if (cf > 0) {
        log(
          `  carry-forward kinds: ${cls.mint.length} open-new-plan, ${cls.alreadyFiled.length} already-filed (waiting-operator), ${cls.wontFix.length} won't-fix, ${cls.ignored.length} ignored`,
        );
      }
      if (plan.cost && plan.cost.unknown === false && plan.cost.usd === 0) {
        enqueueLand(plan, result);
      } else {
        log('  non-$0 completed — left in in-progress/ (worktree pushed) for operator landing');
      }
    }
  }

  while (true) {
    // FILL — synchronous claims ⇒ serialized; stops on slots / breaker / queue.
    while (!terminal && inFlight.size < workers) {
      if (spawns >= maxIterations) {
        terminal = 'max_iterations';
        break;
      }
      const halt = shouldHalt(state, ceilingNow, quarantineLimit);
      if (halt.halt) {
        if (inFlight.size > 0) break; // stop spawning; drain in-flight first
        // Pool is empty: interactive mode may lift the breaker, otherwise finish.
        if (prompter && halt.reason === 'spend_ceiling') {
          const ans = await prompter('ceiling', {
            spent: state.cumulative_spend_usd,
            ceiling: ceilingNow,
          });
          if (typeof ans === 'number' && ans > ceilingNow) {
            log(`ceiling raised $${ceilingNow} → $${ans} (this run only)`);
            ceilingNow = ans;
            continue;
          }
        } else if (prompter && halt.reason === 'quarantine_limit') {
          const ans = await prompter('quarantine_limit', {
            count: state.plans_quarantined.length,
          });
          if (ans === true) {
            quarantineLimit = state.plans_quarantined.length + MAX_QUARANTINES;
            log(`quarantine limit extended to ${quarantineLimit} (operator continue)`);
            continue;
          }
        }
        log(
          `HALT: ${halt.reason} (spend $${state.cumulative_spend_usd}, quarantined ${state.plans_quarantined.length})`,
        );
        terminal = halt.reason;
        break;
      }
      if (
        !spawnGateOpen({
          settled: state.cumulative_spend_usd,
          inFlight: inFlight.size,
          reserve,
          ceiling: ceilingNow,
        })
      ) {
        // Reserve-blocked: more in-flight headroom would overshoot the ceiling.
        // Wait for a settle. (With zero in-flight the gate degenerates to the
        // halt check above, so this break always has something to drain.)
        break;
      }
      const pick = oracle();
      // Accumulate the oracle's excluded set (operator-input / blocked plans it
      // skipped) so the closing summary lists what was NOT touched and why
      // (plan 443) — excluded plans never become pick.next.
      state = recordSkipped(state, pick.excluded);
      if (pick.reason) {
        persist(state); // flush the skipped-list even when we go drain in-flight first
        if (inFlight.size > 0) break; // queue momentarily empty; re-check after the next fold
        log(`queue: ${pick.reason}`);
        terminal = pick.reason;
        break;
      }
      // plan 2426: skip past anything the board gate already refused this run (those plans
      // are still sitting in ready/, so the oracle keeps offering them).
      const plan = selectNextCandidate(pick, gateRefused);
      if (!plan) {
        persist(state);
        if (inFlight.size > 0) break; // let the pool drain; re-check after the next fold
        log('queue: every eligible plan was refused by the write-time board gate');
        terminal = 'all_gate_refused';
        break;
      }

      // Safety: the oracle handed back a plan we already ran this session. That
      // means landing or quarantine did NOT remove it from ready/, so re-running
      // it would loop forever. Halt loudly instead (in-flight still drains).
      if (attempted.has(plan.slug)) {
        log(`STOP: ${plan.slug} re-appeared in ready/ after an attempt — queue not advancing.`);
        terminal = 'plan_not_advancing';
        break;
      }

      // plan 4069 (task 5): classify THIS plan — a cheap, single-plan read (never a corpus scan).
      // The ceiling itself is `operatorCeilingUsd`, resolved ONCE above (fix, finding c01265/
      // 3cc803) rather than re-read per candidate — it comes from a config file, not from
      // anything that changes mid-plan, so a per-run constant is the correct scope for it.
      const spendClass = classifyPlanSpend(mainDir, plan.path);
      const ceilingUsd = operatorCeilingUsd;
      if (shouldPauseForCost(plan.cost, { spendClass, ceilingUsd })) {
        // Fix (finding 7f22d1): branch the reason on which predicate actually fired, naming the
        // plan's own declared amount alongside the ceiling for a genuine over-ceiling pause — an
        // operator reading this must never be told "over the ceiling" when the real reason is R2's
        // "a data pass always asks", which is a false statement about the decision at hand.
        //
        // Review round 2 (R2-6, key 2668 guard-fires): the data-pass branch itself covers TWO
        // distinct predicates (shouldPauseForCost's own comment) — a genuinely positive figure
        // (`cost.usd > 0`), or an explicit "over" bound at ANY figure including $0 (`cost.over`,
        // e.g. "Cash > $0"). The old text unconditionally said "non-zero cash forecast", which is
        // FALSE for the second predicate — a plan declaring exactly $0 with an explicit ">" bound
        // has no non-zero figure at all. Say what actually fired.
        const why = plan.cost?.unknown
          ? 'no parseable cost forecast'
          : spendClass === 'data-pass'
            ? plan.cost?.usd != null && plan.cost.usd > 0
              ? 'a data pass with a non-zero cash forecast — R2 requires an explicit go regardless of amount'
              : 'a data pass with an explicit "over" cash bound — R2 requires an explicit go regardless of amount'
            : `declares $${plan.cost?.usd ?? '?'}, over the $${ceilingUsd} ceiling`;
        log(`COST GATE: ${plan.slug} ${why} (${plan.cost?.raw ?? 'n/a'})`);
        const approved = prompter ? await prompter('cost_pause', { plan, why }) : false;
        if (!approved) {
          // Park-and-continue (plan 518 — supersedes the serial driver's
          // run-terminating `cost_pause`): interactive decline and
          // non-interactive both file the plan for operator triage and the
          // run keeps draining. The closing SKIPPED list names it.
          parkCostPause(plan, why);
          state = recordSkipped(state, [
            { slug: plan.slug, exclude: 'cost_pause', reason: `cost-pause parked (${why})` },
          ]);
          persist(state);
          log('  parked (cost-pause) → waiting-operator, continuing');
          continue;
        }
        log(`  operator approved the cost gate for ${plan.slug}`);
      }

      log(`run: ${plan.slug} (phase ${phase}, slot ${inFlight.size + 1}/${workers})`);
      attempted.add(plan.slug);
      // Folder-lock the plan on master (ready/ → in-progress/) BEFORE spawning the
      // worker — so it can't be double-picked, won't re-trip plan_not_advancing if
      // unlanded, and the worker's done-worktree close-out finds it where it expects.
      try {
        claim(plan);
      } catch (e) {
        if (e instanceof BoardInvariantError) {
          // plan 2426 (operator ruling Q3) — the write-time board gate refused this claim:
          // the plan carries a LIVE **Blocked-by:** line while heading for in-progress/.
          //
          // HARD REFUSE, RECORD, TAKE THE NEXT PLAN — and leave the plan file exactly where
          // it is. The drain gets no `--blocked-ok` counterpart and does NOT auto-route the
          // plan to waiting-blocked/, deliberately: `queue-drain.mjs` already excludes
          // blocked plans at SELECTION time with its own blocked-line extractor, so the gate
          // firing here means the two classifiers DISAGREE (or a sibling edited the body
          // mid-run) — precisely the moment an unattended actor must not rewrite board
          // state. A gate false-positive would otherwise misfile a genuinely-ready plan with
          // nobody watching; the operator sees it in the closing SKIPPED list instead.
          //
          // THE KNOWN DISAGREEMENT CLASS, so nobody has to rediscover it from a skip line:
          // the oracle resolves a blocker against `archivedIds` — archive/ PRESENCE alone
          // (queue-drain.mjs, plan 1819) — while this gate additionally requires the
          // `**Status:** ✅ COMPLETED` shipped stamp (blocked-by-lib's `makeArchiveIsShipped`,
          // plan 1836). So a plan whose blocker was archived WITHOUT shipping (superseded,
          // abandoned) is offered as eligible and refused here, every run, deterministically.
          // That is the safe direction — the stricter classifier wins and nothing is written
          // — but it is a standing skip, not a transient race. Reconciling the two extractors
          // is filed separately; it lives in queue-drain's selection gate, not here.
          gateRefused.add(plan.slug);
          state = recordSkipped(state, [
            {
              slug: plan.slug,
              exclude: 'board_invariant',
              reason: `write-time board gate refused the claim: ${(e.boardInvariantViolations || [])
                .map((v) => v.detail)
                .join(' | ')}`,
            },
          ]);
          persist(state);
          log(`  BOARD GATE refused ${plan.slug} — left in ready/, taking the next plan`);
          continue;
        }
        if (isBoardLintRefusal(e)) {
          // The plan's basename category segment is malformed (lowercase, e.g.
          // `811-price-…`), so board.mjs's write-time cell lint REFUSED the claim cell
          // with NO_PLAN_REF. The claim already moved the file ready/ → in-progress/
          // before the board write threw. This is DETERMINISTIC (retrying never helps —
          // the slug is structurally un-claimable until its basename is hand-fixed), so
          // PARK it to waiting-operator/ and CONTINUE the FILL loop — never crash the
          // whole run + abandon the in-flight workers (the 2026-06-18 drain crash on 811,
          // plan 817). The closing SKIPPED list names it with the board_lint reason.
          parkBoardLint(plan);
          state = recordSkipped(state, [
            {
              slug: plan.slug,
              exclude: 'board_lint',
              reason: 'board lint NO_PLAN_REF (malformed slug) — parked to waiting-operator',
            },
          ]);
          persist(state);
          log('  parked (board lint NO_PLAN_REF — malformed slug) → waiting-operator, continuing');
          continue;
        }
        if (!e.coordContention) throw e;
        // A sibling session held an uncommitted edit in the shared main checkout for
        // the WHOLE retry budget (plan 618). Stop CLEANLY instead of crashing with
        // exit 2 + abandoned in-flight workers: the workers below drain, and the
        // queue is left intact for a later run. (The plan may be half-claimed — moved
        // to in-progress/ before the board write failed — which a re-run / hand
        // recovery resolves; this is the rare exhaustion case, not the norm — the
        // retry clears transient dirt without ever reaching here.)
        log(
          `COORD CONTENTION: ${plan.slug} claim blocked by a foreign uncommitted edit after retries — stopping cleanly (in-flight workers drain).`,
        );
        terminal = 'coord_contention';
        break;
      }
      spawnWorker(plan, plan.slug);
    }

    if (inFlight.size === 0) break;

    const done = await Promise.race(inFlight.values());
    inFlight.delete(done.key);
    try {
      await foldOutcome(done); // persists outcome + pool snapshot in one write
    } catch (e) {
      if (!e.coordContention) throw e;
      // A park's board repath inside the fold exhausted the foreign-dirt retry budget
      // (plan 618). Don't crash — stop cleanly; any remaining in-flight workers still
      // drain on the subsequent Promise.race passes, and finding 3's foldOutcome guard
      // skips THEIR park so they don't re-thrash the same dirt. No drift is left: since
      // plan 622 orderedPlanMove rolls the plan-file move BACK when the board repath
      // can't complete, so a coordContention here means the file was returned to its
      // source subfolder — row + file still agree, lint-board stays clean. (618→622:
      // pre-618 the same dirt crashed AND left a drift; 618 made it a clean stop but the
      // latent move-then-repath ordering could still strand a drift; 622's rollback
      // closes that.)
      log(
        `COORD CONTENTION folding ${done.key} after retries — stopping cleanly ` +
          `(file move rolled back, so no BOARD_SUBFOLDER_DRIFT left). Remaining in-flight workers drain.`,
      );
      terminal = terminal ?? 'coord_contention';
    }
  }

  await landingChain; // every enqueued land settles before the closing report
  let reason = terminal ?? 'empty';
  // Phase-2 pool drains the whole queue; when at least one plan completed, the
  // honest closing reason is still "paused before land" — the operator lands
  // those pushed worktrees (plan 518 semantics change, --workers ≥ 2 only).
  const queueReasons = new Set([
    'empty',
    'all_blocked',
    'all_need_operator',
    'all_fable_or_stub', // plan 1292: same "queue exhausted, nothing runnable" family
    'all_batch_held', // plan 2459: ditto — every remaining plan is held by a runnable batch
    // plan 2863: ditto again — every remaining plan already has an execution branch on origin, so
    // the queue is exhausted of work that is not already done. Omitting it would make a phase-2 pool
    // run that DID complete a plan close on 'all_already_on_origin' instead of
    // 'phase2_paused_before_land', hiding the land its completed worktree is still waiting for.
    // (Pre-existing gap, NOT introduced here: 'all_not_cloud_eligible' and
    // 'all_batch_held_none_runnable' are the same family and are still missing from this set.)
    'all_already_on_origin',
    // Review fix (plan 3111, findings 7/15 — CONFIRMED): the new sibling of the reason directly
    // above joins the same family for the same reason. Every remaining plan carries an
    // `adoptBranch` stamp that origin cannot disambiguate, so the queue is exhausted of runnable
    // work; without this row, a phase-2 pool that DID complete a plan would close on
    // 'all_adopt_ambiguous' instead of 'phase2_paused_before_land' and strand the pushed
    // worktree it never handed to landing.
    'all_adopt_ambiguous',
    'landing_mutex_active',
    // plan 2426: same family again — every remaining candidate was refused by the
    // write-time board gate, so the queue is exhausted of RUNNABLE work. Omitting it here
    // would make a phase-2 pool run that DID complete a plan close on 'all_gate_refused'
    // instead of 'phase2_paused_before_land', hiding the land the completed worktree is
    // still waiting for from whoever reads the terminal reason.
    'all_gate_refused',
  ]);
  if (phase < 3 && workers > 1 && state.plans_completed.length > 0 && queueReasons.has(reason)) {
    reason = 'phase2_paused_before_land';
  }
  return finish(state, reason);
}

function finish(state, reason) {
  const skipped = state.plans_skipped || [];
  const landed = state.plans_landed || [];
  const landsParked = state.lands_parked || [];
  console.error(
    `[drain] DONE: ${reason} — ${state.plans_completed.length} completed, ${landed.length} landed, ${state.plans_quarantined.length} quarantined, ${state.plans_blocked.length} blocked, ${landsParked.length} land-parked, ${skipped.length} skipped, $${state.cumulative_spend_usd} spent over ${state.iterations} iteration(s).`,
  );
  if (landed.length) {
    console.error('[drain] LANDED (driver-side via the done-worktree spine):');
    for (const slug of landed) {
      console.error(`[drain]   - ${slug}`);
    }
  }
  // plan 629: split land-stuck (HELD in in-progress/ with a RESUME-NEEDED marker) from
  // genuinely operator-parked (waiting-operator/) so the closing report is honest.
  const landsHeld = landsParked.filter((l) => l.disposition === 'resume');
  const landsForOperator = landsParked.filter((l) => l.disposition !== 'resume');
  if (landsHeld.length) {
    console.error(
      '[drain] LAND-STUCK, HELD in in-progress/ (RESUME-NEEDED marker — finish the land, NOT an operator decision):',
    );
    for (const l of landsHeld) {
      console.error(`[drain]   - ${l.slug}: ${l.seam}${l.reason ? ` — ${l.reason}` : ''}`);
    }
  }
  if (landsForOperator.length) {
    console.error(
      '[drain] LAND PARKED for operator (unknown seam — worktree kept, see waiting-operator/):',
    );
    for (const l of landsForOperator) {
      console.error(`[drain]   - ${l.slug}: ${l.seam}${l.reason ? ` — ${l.reason}` : ''}`);
    }
  }
  if (skipped.length) {
    console.error(
      '[drain] SKIPPED (operator-input / cost-pause / blocked upfront — not auto-drainable, parked or left in place):',
    );
    for (const s of skipped) {
      console.error(`[drain]   - ${s.slug}: ${s.reason || s.exclude}`);
    }
  }
  if (state.plans_blocked.length) {
    console.error(
      '[drain] PARKED for operator (built + pushed, blocked at their own apply/checkpoint gate — see waiting-operator/):',
    );
    for (const slug of state.plans_blocked) {
      console.error(`[drain]   - ${slug}`);
    }
  }
  return { reason, state };
}

function isoDate() {
  // Date.* is fine here (CLI, not a resumable workflow script).
  return new Date().toISOString().slice(0, 10);
}

// --- CLI ---------------------------------------------------------------------

export function main(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[k] = v;
    }
  }
  const ceiling = flags.ceiling
    ? Number(flags.ceiling)
    : Number(process.env.DRAIN_SPEND_CEILING_USD) || DEFAULT_CEILING_USD;
  const accounts = flags.accounts
    ? String(flags.accounts)
        .split(',')
        .map((s) => s.trim())
    : null;
  const phase = flags.phase ? Number(flags.phase) : 2;
  const allowDangerous = !!flags['allow-dangerous'] || process.env.DRAIN_ALLOW_DANGEROUS === '1';
  const dryRun = !!flags['dry-run'];
  // Pool size (plan 518): --workers N / DRAIN_WORKERS, default 1 (serial).
  const workers = Math.max(1, Number(flags.workers ?? process.env.DRAIN_WORKERS ?? 1) || 1);
  const reserve =
    flags.reserve != null
      ? Number(flags.reserve)
      : Number(process.env.DRAIN_RESERVE_USD) || DEFAULT_RESERVE_USD;
  const interactive = !!flags.interactive;
  const prompter = interactive ? makeTtyPrompter() : null;
  const runner = dryRun
    ? dryRunner({ latencyMs: workers > 1 ? 50 : 0 }) // visible overlap in a pooled dry run
    : makeClaudeRunner({ allowDangerous });
  // Driver-side landing (plan 518): the real spine is wired ONLY for a real
  // phase-3 run — phase 2 never lands and --dry-run must not mutate anything.
  const landSeam =
    phase >= 3 && !dryRun ? { land: makeSpineLander(), finishLand: makeSpineFinisher() } : {};
  // --dry-run must not mutate master: stub the claim/mint/park seams (which git
  // mv + push). The real run uses runDrain's defaults. The dry-run runner only
  // ever reports `completed`, so quarantine/blocked-park seams are never
  // reached and need no stub; the cost-park seam IS reachable (cost gate fires
  // before the runner) and gets a logging stub. Because the stubbed claim
  // leaves plans in ready/, the raw oracle would re-pick a "claimed" plan on
  // the next FILL pass and trip plan_not_advancing — so the dry-run oracle
  // filters the session's pretend-claims out of the eligible list itself.
  const dryClaimed = new Set();
  const seams = dryRun
    ? {
        claim: (p) => dryClaimed.add(p.slug),
        oracle: () => {
          const pick = runOracle();
          if (pick.reason) return pick;
          const remaining = (pick.eligible || [pick.next]).filter(
            (p) => p && !dryClaimed.has(p.slug),
          );
          if (remaining.length === 0) return { reason: 'empty', excluded: pick.excluded };
          return { ...pick, next: remaining[0] };
        },
        mintCarryForwards: () => [],
        parkCostPause: (p) => console.error(`[drain] (dry-run) would cost-park ${p.slug}`),
      }
    : {};

  return runDrain({
    ceiling,
    accounts,
    phase,
    workers,
    reserve,
    prompter,
    runner,
    ...landSeam,
    ...seams,
  }).then(() => 0);
}

// plan 4096 T2: the CLI entry lives in ONE exported function so the path-compat shim at
// scripts/drain-run.mjs runs exactly what this file's own guard runs (move-to-coord.mjs's cliMain
// convention) — including the process.exit on settle and the exit-2 crash arm.
export function cliMain(argv = process.argv.slice(2)) {
  return main(argv).then(
    (c) => process.exit(c ?? 0),
    (e) => {
      console.error('drain-run:', e.message);
      process.exit(2);
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cliMain(process.argv.slice(2));
}
