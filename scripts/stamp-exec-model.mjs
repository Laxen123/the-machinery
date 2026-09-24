#!/usr/bin/env node
// scripts/stamp-exec-model.mjs  (plan 1292, work item 4a/4c)
//
// Stamp a plan's `execModel:` frontmatter (sonnet|fable|sol) — and, when the plan is
// routed to fable or sol, keep the operator-visible filename marker in sync. Plan 1292's
// work item 4 replaced the (same-day-superseded) INDEX-chip idea with a `FABLE-`
// segment in the basename (`NNNN-FABLE-Category-slug.md`) right after the numeric
// id, because the VS Code file tree — not INDEX/board — is what the operator
// actually reads. The frontmatter `execModel:` field stays the single source of
// truth the orchestrator drain reads; the filename segment is a DISPLAY mirror of
// it, kept honest by this tool (write path) and lint-filename-execmodel-drift.mjs
// (drift detector).
//
// Usage:
//   node scripts/stamp-exec-model.mjs <id|basename> <fable|sonnet|sol> \
//        [--spec-review <sha|exempt-mechanical>] [--dry]
//   e.g.  node scripts/stamp-exec-model.mjs 1209 fable
//         node scripts/stamp-exec-model.mjs 1209-FABLE-Other-foo.md sonnet
//         node scripts/stamp-exec-model.mjs 1298 sonnet --spec-review a1b2c3d
//         node scripts/stamp-exec-model.mjs 3341 sol
//
// What it does, atomically, against $MAIN (must be master):
//   1. Locate the plan by id or basename among pending-approval/, ready/, waiting-*/
//      (in-progress/ and archive/ are REFUSED — see assertStampableStatus).
//   2. Rename (git mv) to add/remove/swap the `FABLE-`/`SOL-` basename segment as
//      needed — a no-op when the segment already matches the target model
//      (idempotent); the two segments are mutually exclusive (plan 3341).
//   3. Merge `execModel: <target>` into the frontmatter block (never clobbering
//      other keys); with --spec-review, also merge `specReview: <value>`, flip
//      `stage: specced`, and complete the `**Status:**` prose that flip invalidates
//      (plan 2892) — after REFUSING, before any write, a body whose 💰 / SEED-WRITE
//      banners are non-canonical. See plan-promotable-lib.mjs for why the refusal has
//      to land before the stamp rather than after it.
//   4. Regenerate docs/INDEX.md in-process, commit both paths + INDEX by explicit
//      pathspec with the `Coord-Write: stamp-exec-model` trailer, push (retry on
//      non-ff), and roll back any attempt that throws before that push becomes durable.
//
// The atomic core (withCoordCheckout isolation, ffMasterFromOrigin sync, snapshot →
// commit → push → path-scoped rollback with non-ff detection) lives in the shared
// stamp-lib.mjs (plan 1797 — one spine for every stamp-<axis> tool, never a second
// copy); this file keeps only the execModel-specific closures: the FABLE- rename,
// the frontmatter merge (+ --spec-review), and the INDEX regen/heal opt-in.
//
// `--dry` prints the planned ops without mutating anything.

import { fileURLToPath } from 'node:url';
// parseFlags comes from the ADOPTED module, NOT coord-git: this file is byte-synced to
// siblings whose coord-git.mjs is a slim local shim without it (plan 1777).
import { parseFlags, assertOneOf } from './coord/parse-flags.mjs';
import {
  upsertFrontmatterKey,
  cloudExecUnstampedWarning,
  PENDING_APPROVAL_FOLDER,
} from './coord/build-index-lib.mjs';
import { gitWithLockRetry, lsRemoteTimed } from './coord/coord-git.mjs';
import { planStatus } from './coord/claim-plan.mjs';
import {
  applyAdoptBranchStamp,
  planIdFromBasename,
  removeFrontmatterKey,
} from './coord/plan-adopt-branch.mjs';
import { collapseSameShaBranches, originExecutedPlanIds } from './coord/queue-drain.mjs';
import {
  stampFrontmatterAxis,
  resolveSpecPassCost,
  specCostFrontmatterValue,
} from './coord/stamp-lib.mjs';
// plan 3973 (T2): the combined `--cloud-exec`/`--env` form reuses stamp-cloud-exec.mjs's
// OWN axis-building/validation core rather than re-deriving the gated-path/browser-
// downgrade/trueOnly/false-requires-reason rules a second time — see that module's header
// comment on buildCloudExecAxis for the exact contract (throws a plain Error on any
// validation failure, with the same message text stamp-cloud-exec.mjs's own CLI prints).
import { buildCloudExecAxis } from './stamp-cloud-exec.mjs';
// plan 3973 (T2): the `--move` companion's argv-shape check. stamp-lib.mjs's own header
// comment is explicit that this is the CALLER's job (a pure argv validation, not a
// body-dependent gate) — mirroring move-plan.mjs's own mainImpl, which runs it before
// resolveMain() even.
import { assertBlockedByOk, GRILL_BLOCKED_BY_DEFAULT } from './coord/move-plan.mjs';
// plan 3341 review: VALID_EXEC_MODELS below used to be a second, hand-maintained lane list —
// claim-plan-lib.mjs's EXEC_LANE_TABLE is the authoritative lane vocabulary, so a fourth lane
// is now one edit there, not two that can drift. No cycle: claim-plan-lib.mjs imports nothing
// from this file (nor from stamp-lib.mjs/exec-model-stamp.mjs/plan-promotable-lib.mjs).
import { EXEC_LANE_TABLE } from './coord/claim-plan-lib.mjs';
// plan 1362: the rename shape (BASENAME_RX/renameForExecModel) and the in-progress/
// archive restriction (assertStampableStatus) now live in the shared lib every
// auto-stamping writer imports too (D4 — never a second copy). Re-exported here so
// this file's existing test/CLI surface (renameForExecModel, assertStampableStatus)
// is unchanged.
import {
  renameForExecModel,
  assertStampableStatus,
  applyExecutionBranchRename,
  planExecutionBranchRename,
} from './coord/exec-model-stamp.mjs';
// plan 2892: the --spec-review stamp validates the whole promotable state BEFORE writing,
// and completes the one part of it a stamp is the authority for (the Status token). Both
// live in the shared lib so this tool, board-write-gate and the movers can never disagree
// about what "promotable" means — see that module's header for the deadlock class.
import {
  completeSpeccedStatusProse,
  findPromotionBlockers,
  promotionBlockerMessage,
} from './coord/plan-promotable-lib.mjs';

export { renameForExecModel, assertStampableStatus };

// plan 3341: `sol` is a third executor lane — Opus-orchestrated, codex-transport-backed
// (claim-plan-lib.mjs's EXEC_LANE_TABLE carries the full shape). Per an explicit operator
// ruling recorded in the plan body, adding it here does NOT grow a SEED-WRITE banner check:
// a 🟥 SEED-WRITE plan is `sol`-taggable exactly like a 🟩 one, same as `fable`/`sonnet`.
//
// Derived from EXEC_LANE_TABLE's keys, never a second hand-typed literal array — see the
// import comment above. Exported name unchanged (`VALID_EXEC_MODELS`): edit-plan.mjs and
// next-plan-id.mjs import it by this name and are outside this fix's allowlist.
export const VALID_EXEC_MODELS = Object.keys(EXEC_LANE_TABLE);

// The effort half of a `--provenance <model>/<effort>` value (plan 3004). The model half is
// deliberately free-form (model names churn; a new one must not wedge the stamp), but effort
// is a closed harness enum — a typo'd tier recorded with true-value confidence is exactly the
// inferred-wrong-value dishonesty the self-declared flag exists to avoid, so it IS validated.
export const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Merge a single `key: value` scalar into a leading `---` YAML frontmatter block.
// The implementation (including the plan-1292 comment-preservation semantics this
// file pioneered) moved to the shared upsertFrontmatterKey in build-index-lib.mjs
// (plan 1304); this stays exported as the historical public name for this script's
// callers and tests.
export function setFrontmatterKey(content, key, value) {
  return upsertFrontmatterKey(content, key, value);
}

/**
 * The `stage: specced` half of a `--spec-review` stamp (plan 2892): flip the stamp AND
 * complete the `**Status:**` prose the stamp itself invalidates.
 *
 * ONE function, called from BOTH the preflight (which judges the projected body) and
 * `mutateBody` (which writes it), so "what the gate was shown" and "what the stamp wrote"
 * are the same transform by construction. Two expressions of it would reproduce, one
 * function apart, the exact stamp-vs-checker divergence this plan closes.
 */
export function specSpeccedBody(content, { status = PENDING_APPROVAL_FOLDER } = {}) {
  return completeSpeccedStatusProse(setFrontmatterKey(content, 'stage', 'specced'), { status });
}

const USAGE =
  'usage: stamp-exec-model.mjs <id|basename> <fable|sonnet|sol> ' +
  '[--spec-review <sha|exempt-mechanical> [--provenance "<model>/<effort>"]] ' +
  '[--cloud-exec true|false [--env trusted|full|webkit|browser] [--reason "..."]] ' +
  '[--move ready|<waiting-state> [--blocked-by "<text>"] [--unblock <manual|decision>]] [--dry]';

/**
 * The argv checks `parseFlags` cannot make for us (plan 2892, review rounds 2-3). Returns
 * an error string, or null when the invocation is well-formed. Pure and exported so the
 * cases are unit-testable without building an isolated repo per malformed argument.
 *
 * `requireValues` (plan 2734) covers a MISSING and an EMPTY `--spec-review`. What it does
 * not cover is a FLAG-SHAPED value: parseFlags consumes the next token greedily, so
 * `--spec-review --dry` (or `-d`) parses as the VALUE with the flag itself never set — an
 * operator asking for a dry run would get a REAL stamp carrying a garbage `specReview`,
 * and downstream gates treat any non-empty specReview as a valid review marker. A
 * spec-review value is a sha or the literal `exempt-mechanical`; neither can start with a
 * dash, so ANY leading `-` is rejected (round 3: checking only `--` let `-d` through).
 * Widening the shared parser instead would be a repo-scale change — this refuses where
 * the consequence lives.
 */
export function argvUsageError({
  positionals,
  specReview,
  provenance,
  cloudExec,
  cloudEnv,
  moveTarget,
  blockedBy,
  unblock,
  cloudReason,
}) {
  const [idOrName, target] = positionals;
  if (!idOrName || !target) return USAGE;
  // A stray third positional (a typo, a misplaced flag value) must not be silently
  // dropped: `stamp-exec-model 1000 sonnet 1001` would otherwise stamp plan 1000 while
  // the operator was looking at 1001.
  if (positionals.length > 2)
    return `stamp-exec-model: unexpected extra argument(s) ${positionals
      .slice(2)
      .map((p) => `"${p}"`)
      .join(', ')} — this tool stamps exactly ONE plan.\n${USAGE}`;
  // `/^\s*-/`, not startsWith('-'): a quoted value like " -d" is still flag-shaped, just
  // whitespace-padded (gpt-review 3004 finding 1rs7lce).
  if (typeof specReview === 'string' && /^\s*-/.test(specReview))
    return (
      `stamp-exec-model: --spec-review got the flag "${specReview}" as its value — it needs ` +
      'a spec-review sha, or the literal `exempt-mechanical`. (A flag directly after ' +
      '--spec-review is consumed as its value, so the flag you meant would be silently lost.)'
    );
  if (typeof provenance === 'string') {
    if (/^\s*-/.test(provenance))
      return (
        `stamp-exec-model: --provenance got the flag "${provenance}" as its value — it needs ` +
        '"<model>/<effort>", e.g. "fable-5/xhigh". (A flag directly after --provenance is ' +
        'consumed as its value, so the flag you meant would be silently lost.)'
      );
    // Provenance records WHO produced the spec-pass verdict; without --spec-review there is
    // no verdict being stamped to attribute. Refusing (rather than silently dropping the
    // value) keeps a mis-ordered invocation from recording nothing while looking recorded.
    if (!specReview)
      return (
        'stamp-exec-model: --provenance only makes sense together with --spec-review — it ' +
        'records which model/effort produced the spec-pass verdict being stamped.'
      );
    // exempt-mechanical MEANS no spec-pass judgment happened (Tier-0, plan-triage's own
    // definition) — attaching a model/effort review provenance to it would record a review
    // that explicitly did not occur (gpt-review 3004 finding 912c0b).
    if (specReview === 'exempt-mechanical')
      return (
        'stamp-exec-model: --provenance cannot accompany --spec-review exempt-mechanical — ' +
        'exempt-mechanical means NO spec-pass judgment happened, so there is no model/effort ' +
        'review to attribute.'
      );
    // ONE anchored regex is the whole shape check — it forbids whitespace, control
    // characters (a newline in the model half would inject extra frontmatter lines via
    // setFrontmatterKey's raw `key: value` write — gpt-review 3004 findings df96e9/cb3ba3),
    // and a second `/`. The matched value is stored verbatim, so validate-what-you-store
    // holds by construction (no trim-then-store-raw drift — finding e057d1).
    const m = /^([A-Za-z0-9._-]+)\/([A-Za-z]+)$/.exec(provenance);
    if (!m)
      return (
        `stamp-exec-model: --provenance "${provenance}" — expected "<model>/<effort>", e.g. ` +
        '"fable-5/xhigh" (model half: letters/digits/._- only; no spaces, no extra slashes).'
      );
    if (!VALID_EFFORTS.includes(m[2]))
      return (
        `stamp-exec-model: --provenance effort "${m[2]}" is not one of ` +
        `${VALID_EFFORTS.join('|')}. A mistyped tier recorded as truth is worse than none — ` +
        'fix the value (the model half is free-form; the effort half is the harness enum).'
      );
  }
  // plan 3973 (T2): the combined-form flags share the same parseFlags footgun as
  // --spec-review/--provenance above — a flag directly after a value flag is consumed as
  // its value, so any of these getting a flag-shaped string means the flag the caller
  // meant was silently swallowed. One shape check, run for all five.
  const flagShaped = [
    ['--cloud-exec', cloudExec],
    ['--env', cloudEnv],
    ['--move', moveTarget],
    ['--blocked-by', blockedBy],
    ['--unblock', unblock],
    ['--reason', cloudReason],
  ];
  for (const [name, value] of flagShaped) {
    if (typeof value === 'string' && /^\s*-/.test(value))
      return (
        `stamp-exec-model: ${name} got the flag "${value}" as its value — a flag directly ` +
        `after ${name} is consumed as its value, so the flag you meant would be silently lost.`
      );
  }
  // Ordering: --env/--reason answer a question --cloud-exec asks; without it there is no
  // cloudExec stamp for them to modify. --blocked-by/--unblock answer a question --move
  // asks (which lane, and — for waiting-operator/ — which unblock kind); without --move
  // there is no lane change for them to describe. Mirrors the --provenance-needs-
  // --spec-review ordering check above.
  if (cloudEnv !== undefined && cloudExec === undefined)
    return (
      'stamp-exec-model: --env only makes sense together with --cloud-exec — it routes which ' +
      'cloud lane may pick up this plan, and there is no cloudExec stamp here to route.'
    );
  if (cloudReason !== undefined && cloudExec === undefined)
    return (
      'stamp-exec-model: --reason only makes sense together with --cloud-exec false — it ' +
      'records why this plan is not cloud-runnable, and there is no cloudExec stamp here to attach it to.'
    );
  if ((blockedBy !== undefined || unblock !== undefined) && moveTarget === undefined)
    return (
      'stamp-exec-model: --blocked-by/--unblock only make sense together with --move — they ' +
      'describe the lane a --move is routing this plan into, and there is no --move here.'
    );
  return null;
}

async function main() {
  // plan 1777: the shared spec'd parser (coord-git parseFlags, plan 1769) replaces the
  // value-only parseArgs + its `--dry` argv pre-strip — `--dry` is a real boolean now,
  // position-independent, and an unknown flag (`--spec-reviw`) throws instead of being
  // silently swallowed as data.
  let parsed;
  try {
    parsed = parseFlags(process.argv.slice(2), {
      label: 'stamp-exec-model',
      // plan 3973 (T2): the combined stamp+move form's own flags. `cloud-exec`/`env`/
      // `reason` feed buildCloudExecAxis (stamp-cloud-exec.mjs's own validation, reused
      // verbatim); `move`/`blocked-by`/`unblock` fold a lane move into the same commit
      // (stampFrontmatterAxis's `opts.move`, plan 3973 T2).
      value: [
        'spec-review',
        'provenance',
        'cloud-exec',
        'env',
        'reason',
        'move',
        'blocked-by',
        'unblock',
      ],
      boolean: ['dry'],
      // plan 2892 (review round 2): parseFlags DROPS a value flag given no value, so a bare
      // `--spec-review` used to run as a plain execModel stamp — silently skipping the stage
      // flip the operator asked for AND the promotability gate below. `requireValues` (plan
      // 2734) is the shared strict mode for exactly that.
      requireValues: true,
    });
  } catch (e) {
    // requireValues THROWS, and it throws before this function's own `return 2` paths — so
    // without this catch a malformed flag would exit 1 through the top-level rejection
    // handler instead of 2, reclassifying a usage refusal as an operational failure that
    // automation may retry (review round 3, CONFIRMED). Every malformed invocation exits 2.
    console.error(e.message);
    return 2;
  }
  const { positionals, flags } = parsed;
  const dry = flags.dry === true;
  const [idOrName, target] = positionals;
  const specReview = flags['spec-review'];
  const provenance = flags.provenance;
  // plan 3973 (T2): the combined form's own flags — undefined when not given, same
  // "absent means don't touch this axis" contract every other optional flag here uses.
  const cloudExec = flags['cloud-exec'];
  const cloudEnv = flags.env;
  const cloudReason = flags.reason;
  const moveTarget = flags.move;
  let blockedBy = flags['blocked-by'];
  const unblock = flags.unblock;

  const usageError = argvUsageError({
    positionals,
    specReview,
    provenance,
    cloudExec,
    cloudEnv,
    moveTarget,
    blockedBy,
    unblock,
    cloudReason,
  });
  if (usageError) {
    console.error(usageError);
    return 2;
  }
  try {
    assertOneOf(target, VALID_EXEC_MODELS, { label: 'exec model', prefix: 'stamp-exec-model' });
  } catch (e) {
    console.error(e.message);
    return 2;
  }

  // plan 3973 (T2): build the cloud-exec axis (if `--cloud-exec` was given) BEFORE
  // entering stampFrontmatterAxis — same "validate before any coord lock" discipline the
  // rest of this file already follows. Reuses stamp-cloud-exec.mjs's own validation
  // verbatim (no gated-path override flags in this combined form — that escape hatch
  // stays on the standalone tool).
  let cloudAxis = null;
  let cloudDescribe = null;
  if (cloudExec !== undefined) {
    try {
      const built = buildCloudExecAxis(cloudExec, { env: cloudEnv, reason: cloudReason });
      cloudAxis = built.axis;
      cloudDescribe = built.describe;
    } catch (e) {
      console.error(e.message);
      return 2;
    }
  }

  // plan 3973 (T2): the --move companion. assertBlockedByOk is the pure argv-shape check
  // stamp-lib.mjs's header names as the CALLER's job (mirrors move-plan.mjs's own
  // mainImpl, which runs it before resolveMain() even) — a waiting-*/ target with no
  // --blocked-by refuses HERE, before any coord lock, rather than deep inside stampImpl.
  let move;
  if (moveTarget !== undefined) {
    // plan 2034 (R3b), mirrored here (plan 3973 review fix, findings 8b2c92/071ab9):
    // default the waiting-grill/ reason BEFORE the blocked-by gate — move-plan.mjs
    // applies this same default before its own assertBlockedByOk call, so the
    // combined form must too, or the documented `--move waiting-grill` route (no
    // --blocked-by) refuses here even though the standalone move-plan.mjs accepts it.
    // An explicit --blocked-by wins (this no-ops when already set).
    if (moveTarget === 'waiting-grill' && !blockedBy) blockedBy = GRILL_BLOCKED_BY_DEFAULT;
    try {
      assertBlockedByOk(moveTarget, blockedBy);
    } catch (e) {
      console.error(e.message);
      return 2;
    }
    move = { target: moveTarget, blockedBy, unblock };
  }

  // Plan 2973: captured inside `mutateBody` below (the incoming, pre-mutation body is what
  // matters — we're asking "did the SESSION stamp cloudExec before reaching here", not "does
  // this tool's own execModel write happen to touch it"). `mutateBody` is only called on a
  // REAL run, never on `--dry` (stampFrontmatterAxis's dry branch never reaches it) — so a
  // `--dry` invocation leaves this null and emits nothing below. That is correct and intended:
  // a dry run stamps nothing, so warning about a stamp gap it hasn't caused yet would be noise.
  let cloudExecWarn = null;
  let renamePlan = null;
  // Resolve once per invocation. Preflight can re-run on a non-ff, but raw existence is read on
  // every plan pass while this liveness oracle snapshot remains the invocation's one authority.
  let executionBranchMap = null;

  // Plan 3609 (E1/E2): the session's cumulative transcript cost, resolved ONCE per invocation
  // — not inside mutateBody, which withRetry can call more than once on a non-ff race. Resolving
  // it there would (a) risk more than the ONE warn line E1 promises on a failed resolution, and
  // (b) let the recorded value drift between retries of what is logically the same stamp. A
  // session's spend only grows monotonically anyway, so "once, up front" is also the more
  // representative reading, not merely the simpler one.
  //
  // Scoped to a REAL spec-pass exactly like specReviewBy below: never a plain execModel-only
  // stamp (no --spec-review at all — nothing to cost), never `exempt-mechanical` (E4(a): no
  // judgment pass happened, so there is no spec-pass cost to attribute — mirrors why that path
  // gets no specReviewBy either).
  const specCostLiteral =
    specReview && specReview !== 'exempt-mechanical'
      ? specCostFrontmatterValue(resolveSpecPassCost())
      : null;

  // plan 3973 (T2): the execModel axis, unchanged in every field — only its container
  // changed (an object literal handed straight to stampFrontmatterAxis before this plan;
  // now a named `execModelAxis` folded into `opts.axes` alongside an optional cloud-exec
  // axis, so a combined `--cloud-exec`/`--move` invocation lands both in ONE commit).
  const execModelAxis = {
    tool: 'stamp-exec-model',
    renameFor: (basename) => renameForExecModel(basename, target),
    // plan 2892 — the pre-stamp promotability gate. A stamp-lib preflight, NOT a check out
    // here, for the same reason stamp-cloud-exec's gates are: only the lib can hand us the
    // ff-synced body from inside the coord checkout, and only AFTER assertStampableStatus
    // has refused an in-progress/ or archive/ plan. It runs identically on --dry.
    //
    // Scoped to --spec-review because that flag is what flips `stage: specced`; a plain
    // execModel re-stamp changes no stage and must not start refusing the older,
    // non-canonical bodies it has always been able to re-route.
    preflight: (body, ctx) => {
      // withRetry re-derives ctx after a non-ff. Never let a prior attempt's rename decision
      // survive when the ff-synced basename now makes this attempt a no-op rename.
      renamePlan = null;
      if (specReview) {
        // Judge the body AS IT WILL BE WRITTEN: the stage flip plus the Status-token
        // completion below. Judging the raw body would report the very STUB token this
        // stamp is about to fix as a blocker the operator must fix first.
        const projected = specSpeccedBody(body, { status: ctx.status });
        // plan 3943: `specReview` (this invocation's own flag value, already in scope) is
        // threaded through so the blocker can skip the verdict-section requirement for
        // `exempt-mechanical` — no judgment pass happened there, so there is no verdict to
        // require. The verdict CHECK ITSELF stays entirely inside findPromotionBlockers;
        // this is passing data the caller already has, not a second check out here.
        const blockers = findPromotionBlockers(ctx.newBasename, projected, {
          status: ctx.status,
          specReview,
        });
        if (blockers.length)
          throw Object.assign(new Error(promotionBlockerMessage(ctx.newBasename, blockers)), {
            fatal: true,
          });
      }
      if (ctx.renamed) {
        const planId = planIdFromBasename(ctx.basename);
        // A legacy date-slugged plan has no execution namespace. Still carry the planner's
        // noop-idless action through postPush, where the applier returns before every authority
        // read; an unreachable origin therefore cannot block its otherwise-valid stamp.
        if (planId && executionBranchMap === null)
          executionBranchMap = originExecutedPlanIds(process.env.COORD_MAIN_DIR);
        if (planId && !executionBranchMap)
          throw Object.assign(
            new Error('stamp-exec-model: origin execution branches are unavailable; retry later'),
            { fatal: true },
          );
        renamePlan = planExecutionBranchRename({
          mainDir: process.env.COORD_MAIN_DIR,
          planId,
          oldBasename: ctx.basename,
          newBasename: ctx.newBasename,
          body,
          branchMap: executionBranchMap,
          lsRemote: (dir, refs) => lsRemoteTimed(dir, refs),
          claimStatus: planStatus,
          collapse: collapseSameShaBranches,
          applyAdopt: applyAdoptBranchStamp,
        });
      }
    },
    mutateBody: (body, ctx) => {
      // Plan 2973: judged against the body AS IT ARRIVED (before this tool's own
      // execModel/specReview writes below) and using ctx.newBasename — the basename this
      // plan will actually carry on disk once the rename (if any) lands, so the printed
      // remediation command names the same id an operator sees in the tree.
      cloudExecWarn = cloudExecUnstampedWarning(ctx.newBasename, body);
      body = setFrontmatterKey(body, 'execModel', target);
      if (renamePlan?.adoptAction === 'stripped') body = removeFrontmatterKey(body, 'adoptBranch');
      else if (renamePlan?.adoptBranch)
        body = setFrontmatterKey(body, 'adoptBranch', renamePlan.adoptBranch);
      if (specReview) {
        body = setFrontmatterKey(body, 'specReview', specReview);
        // Plan 3004: the spec-pass provenance stamp. `undeclared` is a real recorded value,
        // not a skipped write — it separates "this caller predates the flag" (every cloud
        // sweep until its routine prompt is updated) from a plan never spec-passed at all,
        // and mirrors record-review.mjs's provenance-undeclared precedent. The value is a
        // labeled SELF-REPORT of the stamping session's model/effort, never harvested or
        // inferred (plan 3004's A1-over-A2 ruling: a wrong inferred value carries
        // true-value confidence; a self-report is at least labeled as one).
        // exempt-mechanical gets NO specReviewBy at all: there was no judgment pass to
        // attribute, and `undeclared` there would read as a real-but-unlabeled pass.
        if (specReview !== 'exempt-mechanical') {
          body = setFrontmatterKey(body, 'specReviewBy', provenance || 'undeclared');
          // Plan 3609 (E2): the session-cumulative cost captured above, or the literal `null`
          // when it could not be resolved — NEVER a silently-zeroed value. No key at all on
          // exempt-mechanical (E4(a), same line this block is already scoped by).
          body = setFrontmatterKey(body, 'specCost', specCostLiteral);
        }
        body = specSpeccedBody(body, { status: ctx.status });
      }
      return body;
    },
    postPush: (ctx) => {
      void ctx;
      if (!renamePlan) return;
      const applied = applyExecutionBranchRename({
        mainDir: process.env.COORD_MAIN_DIR,
        plan: renamePlan,
        gitImpl: (dir, args) => gitWithLockRetry(dir, args),
        lsRemote: (dir, refs) => lsRemoteTimed(dir, refs),
        claimStatus: planStatus,
        log: console.error,
      });
      if (applied.mutated)
        console.error(
          `stamp-exec-model: execution branch → ${applied.destination.name}` +
            (applied.leftovers.length
              ? `; leftover ref(s): ${applied.leftovers.join(', ')}`
              : '; source ref(s) retired'),
        );
      else
        console.error(
          `stamp-exec-model: execution branch unchanged (${applied.action})` +
            (applied.destination ? ` → ${applied.destination.name}` : ''),
        );
    },
    commitSubject: ({ basename, newBasename, renamed }) =>
      renamed
        ? `docs(plans): stamp ${basename} execModel: ${target} (rename → ${newBasename})`
        : `docs(plans): stamp ${basename} execModel: ${target}`,
    dryPreview: ({ oldRel, newRel, renamed }) => {
      const lines = [`[dry] set execModel: ${target}`];
      if (specReview)
        lines.push(
          specReview === 'exempt-mechanical'
            ? `[dry] set specReview: ${specReview}; stage: specced (no specReviewBy/specCost — nothing to attribute)`
            : `[dry] set specReview: ${specReview}; specReviewBy: ${provenance || 'undeclared'}; specCost: ${specCostLiteral}; stage: specced`,
          `[dry] rewrite a **Status:** STUB token to the specced form (no-op if it carries none)`,
        );
      lines.push(
        renamed
          ? `[dry] git mv ${oldRel} ${newRel}`
          : `[dry] no rename needed (basename marker already agrees with execModel: ${target})`,
      );
      if (renamed && renamePlan) {
        const sourceNames = renamePlan.sourceRefs.map((entry) => entry.name).join(', ');
        if (renamePlan.action === 'rename')
          lines.push(
            `[dry] after master push, lease-copy ${sourceNames} → ${renamePlan.destination.name} ` +
              `and best-effort retire ${sourceNames}`,
          );
        else if (renamePlan.action === 'finish-delete')
          lines.push(
            `[dry] destination ${renamePlan.destination.name} already exists; after master push, ` +
              `best-effort retire ${sourceNames}`,
          );
        else if (renamePlan.action === 'already-new')
          lines.push(
            `[dry] execution branch is already ${renamePlan.destination.name}; no ref mutation`,
          );
        else if (renamePlan.action === 'none')
          lines.push('[dry] no execution branch exists; no ref mutation');
      }
      return lines;
    },
    // execModel/specReview/stage don't feed the INDEX bullet, but the FABLE- rename
    // moves its path token — regen in-commit + heal after push (plan 926 semantics).
    regenIndex: true,
    healLabel: ({ basename }) => `stamp ${basename} execModel: ${target}`,
  };

  // plan 3973 (T2): the multi-axis form — `axes: [execModelAxis, cloudAxis?]` — is
  // BYTE-IDENTICAL, with no `move`, to the pre-3973 single-axis call (stamp-lib.mjs's
  // buildCommitSubject collapses to that one axis's own commitSubject(ctx) when
  // `axes.length === 1`), so an invocation with neither --cloud-exec nor --move behaves
  // exactly as before this plan.
  const axes = cloudAxis ? [execModelAxis, cloudAxis] : [execModelAxis];
  const result = await stampFrontmatterAxis({ idOrName, dry, axes, move });

  if (result.dry) {
    console.log(
      `stamp-exec-model: [dry] ${result.basename} → execModel: ${target}` +
        (cloudDescribe ? `; ${cloudDescribe}` : '') +
        (move ? `; move ${result.status}/ → ${result.move.targetPath}/` : '') +
        ' (no changes made)',
    );
  } else {
    console.log(
      `stamp-exec-model: ${result.basename} → execModel: ${target}` +
        (result.newBasename !== result.basename ? ` (renamed to ${result.newBasename})` : '') +
        (cloudDescribe ? `; ${cloudDescribe}` : '') +
        (move ? `; moved ${result.status}/ → ${result.move.targetPath}/` : '') +
        ' — committed + pushed',
    );
    // Plan 2973: WARN-only, printed after the success log so the operator sees the stamp
    // succeeded before the follow-up nudge. Never on --dry (cloudExecWarn stays null there —
    // see the comment where it's declared).
    if (cloudExecWarn) console.error(`stamp-exec-model: WARN — ${cloudExecWarn}`);
    // Plan 3004: WARN-only, same never-refuse rationale as the plan body records — a hard
    // refusal would wedge every existing --spec-review caller (the cloud sweep included)
    // until its prompt learns the flag. The stamp itself already wrote `undeclared`.
    if (specReview && specReview !== 'exempt-mechanical' && !provenance)
      console.error(
        'stamp-exec-model: WARN — no --provenance given; stamped `specReviewBy: undeclared`. ' +
          'Declare the spec-pass model/effort next time: --provenance "<model>/<effort>" ' +
          '(e.g. "fable-5/xhigh").',
      );
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error('stamp-exec-model:', e.message);
      process.exit(e.fatal ? 2 : 1);
    },
  );
}
