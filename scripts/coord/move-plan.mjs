#!/usr/bin/env node
// scripts/move-plan.mjs  (plan 249, Task 4)
// ONE-GO re-file of a plan between status subfolders. Replaces the multi-step
// ritual (git mv → hand-edit Blocked-by header → hand-edit INDEX → commit →
// push) with a single invocation = a single commit. Per the plan-249 one-go
// rule: known doc/git rituals run as ONE operation, never narrated step-by-step
// across many tool calls.
//
// What it does, atomically, against $MAIN (must be master):
//   1. git mv docs/superpowers/plans/<from>/<basename>  →  <target>/<basename>
//   2. rewrite the **Blocked-by:** header (required for a waiting-*/ target;
//      left as historical context when promoting to ready/in-progress/archive)
//   3. regenerate docs/INDEX.md via build-index.mjs (the bullet repaths itself)
//   4. commit the rename + INDEX in ONE commit, push, retry on non-ff
//
// Usage:
//   node scripts/move-plan.mjs <id|basename> <target-status> [--blocked-by "<text>"] [--dry] [--no-push] [--force]
//   node scripts/move-plan.mjs <id|basename> [target-status] --rename <new-basename> [--dry] [--no-push]
//   e.g.  node scripts/move-plan.mjs 134 ready
//         node scripts/move-plan.mjs 232-DQ-... waiting-blocked --blocked-by "plan 246 landing"
//         node scripts/move-plan.mjs 2713 --rename 2713-UI-se-basta-veterinar-ratings-landing.md
//
// plan 2719 addition: `--rename <new-basename>` is the sanctioned slug-rename path for an
// UNCLAIMED plan (the plan-2329 naming carve-out, previously executable only via a
// BOARD_GUARD_OVERRIDE=1 hand-commit pair). With no positional target it is a PURE rename —
// same lane, body byte-identical; with one it renames and re-files in the SAME commit. See
// the "plan 2719: the sanctioned slug-rename path" block above mainImpl for the gates.
//
// plan 2082 additions: (a) board-row path sync — a move rewrites any board
// Plan/claim cell still naming the old status subfolder, in the SAME commit, so a
// post-claim move can never strand BOARD_SUBFOLDER_DRIFT (the 2026-07-19 plan-2077
// incident: a fleet-wide push block until hand-healed); (b) claim-holder guard — a
// plan whose refs/claims/<id> is held by ANOTHER session refuses to move (--force
// is the operator-directed override; self-held and unheld proceed).

import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  resolveMain,
  gitWithLockRetry,
  git,
  withRetry,
  ffMasterFromOrigin,
  COORD_TRAILER,
  masterPushSpec,
  withCoordCheckout,
  deleteStaleArchiveDups,
  ensureMvDestDir,
  errText,
  isNonFastForward,
  assertOneOf,
  // plan 4136 E4: the lock-free preflight's ONE bounded git primitive — never a raw `git()`
  // call against the shared MAIN checkout outside the lock (a wedged fetch/show would hang
  // the preflight forever otherwise). See runLockFreePreflight's header.
  boundedGit,
} from './coord-git.mjs';
import { withBody, cellsOf, isSeparator } from './board-lib.mjs';
import { extractPlanRefs } from './lint-board.mjs';
// plan 2082 (review r3): the claim-holder guard reads the claim through claim-plan's
// OWN planStatus (ref read + message parse + youAreHolder in one shared place) rather
// than a re-rolled readRemoteRefCommit/parseClaimMessage copy. Cycle-safe: nothing in
// claim-plan's import graph imports move-plan (only batches-view/edit-plan/stamp-lib
// do, none of which claim-plan touches); the pre-existing claim-plan↔release-claim
// cycle is function-level-only and documented at its site.
// planStatus carries `ref` (the namespace a held claim was found under) on the same read
// that decides held/holder/youAreHolder (plan 3973 review rounds 3-4), so the claim-holder
// guard names the ACTUAL ref without a second read or a hand-built refs/claims/<id>.
import { planStatus } from './claim-plan.mjs';
// The ONE authority for a claim ref's name (plan 3973 round-2 review fix, finding
// 438030) — never a hand-built `refs/claims/<id>` string. Used only as the fallback when
// readClaimHolderStatus's `status.ref` is unset (see claimHolderError below); the actual
// namespace shown for a held claim always comes from that field.
import { claimRef } from './coord-refs.mjs';
import {
  STATUS_ORDER,
  specReviewGateError,
  idClaimPattern,
  claimedIdOfBasename,
  planNestingViolation,
  classifyPlanRel,
  PLAN_FILENAME_RX,
  SEED_BANNER_ANCHOR_RX,
  assertEvidenceFloorOk,
  cloudExecUnstampedWarning,
  // plan 3975 (T2b): the shared write-side frontmatter setter — --respec's stage:
  // specced -> stage: stub withdrawal reuses it rather than a third hand-rolled
  // frontmatter splice.
  upsertFrontmatterKey,
  IN_PROGRESS_FOLDER,
  READY_FOLDER,
  PENDING_APPROVAL_FOLDER,
  WAITING_BLOCKED_FOLDER,
  WAITING_OPERATOR_FOLDER,
  WAITING_GRILL_FOLDER,
  WAITING_TRIP_FOLDER,
  ARCHIVE_FOLDER,
  PARKED_FOLDER,
  // plan 3960 review fix: the shared configured-waiting-lane predicate — see its own comment
  // in build-index-lib.mjs. Replaces this module's own locally-built WAITING_FOLDERS Set below.
  isWaitingFolder,
} from './build-index-lib.mjs';
// Review fix round (2943+2944, R7): assertEvidenceFloorOk now lives in build-index-lib.mjs (this
// module's own readFrontmatterScalar source) — re-exported here so this module's existing export
// name (its own tests, and next-plan-id.mjs's prior direct import of this file) stays unaffected
// by the move. EVIDENCE_GATED_CATEGORIES (the module-level literal this used to also re-export)
// was removed by plan 4071 — the evidence-gated list now comes from coord.config.json's
// planCategories.evidenceGated, resolved by each caller and passed to assertEvidenceFloorOk.
export { assertEvidenceFloorOk };
// plan 2719: the rename gate validates the new slug tail with the SAME charset the
// worktree/queue slugs use (claim-plan-lib's SLUG_CHARSET_RX) rather than a stricter
// lowercase-kebab rule of its own — ~20 live plans legitimately carry camelCase code
// identifiers in the slug (`2234-Infra-centralize-findChrome-into-cdp-client`,
// `081-P12-agitura-serviceTreatments-multi-id`), so a narrower hard rule would refuse
// names the corpus proves are wanted. No cycle: claim-plan-lib imports build-index-lib,
// never move-plan.
import { SLUG_CHARSET_RX } from './claim-plan-lib.mjs';
// plan 926: regenerate docs/INDEX.md IN-PROCESS (no spawned build-index child) to close the
// wide clobber window, and heal any residual drift after the move so NO caller leaves a stale INDEX.
import { regenerateIndex, healIndexDrift } from './build-index.mjs';
import { assertBoardInvariants } from './board-write-gate.mjs';
import { loadCoordConfig } from './coord-config.mjs';
import {
  stampPromotedStatus,
  statusTokenForStage,
  stampArchivedStatus,
  hasTripCondition,
  hasGrillQuestions,
  hasOperatorRulings,
  // plan 4069 (task 1/2): the raw `## Grill questions` section text — the axis-tag scan and
  // the duplicate-re-park refusal both need the text itself, not just hasGrillQuestions' bit.
  grillQuestionsSection,
  getUnblock,
  setUnblock,
  VALID_UNBLOCK,
  // plan 3975 (T2b): --respec rewrites the Status line to the stub form directly — it is
  // neither a promotion (stampPromotedStatus) nor an archive (stampArchivedStatus), so it
  // calls the shared line-setter itself rather than force-fitting one of those two shapes.
  setStatusLine,
} from './plan-body-state.mjs';
import { readyCostBannerError } from './plan-cost-banner.mjs';
// plan 3111: the SHARED adopt-stamp authority — the same leaf next-plan-id --ready and
// done-worktree's promoteWaitingBlocked call, so no writer into ready/ can bypass the rule that a
// plan entering the drain's queue tells the truth about the execution branch it inherits (or does
// not). Same one-leaf-three-writers shape readyCostBannerError above already has. Never throws.
import {
  applyAdoptBranchStamp,
  resolveAdoptBranchNames,
  describeAdoptAction,
  planIdFromBasename,
  syncAdoptBranchStamp,
  // plan 3975 (T2b): the DELETE twin of upsertFrontmatterKey — --respec drops
  // specReview/specReviewBy outright rather than merely blanking them.
  removeFrontmatterKey,
} from './plan-adopt-branch.mjs';
// plan 3111: the --dry preview resolves origin for real rather than guessing — see its call site.
import { originExecutedPlanIds } from './queue-drain.mjs';
import {
  canRenameForStatus,
  stampedRelForExecModel,
  assertExecModelFilenameOk,
  ensureExecModelForExemptMechanical,
  EXEMPT_MECHANICAL_DEFAULT_LANE,
} from './exec-model-stamp.mjs';
// plan 3341 fix: LANE_SEGMENTS is the ONE table of lane/marker facts (fable/FABLE-,
// sol/SOL-, …) — the explicit --rename grammar below reads it instead of a second
// hardcoded `FABLE-` literal, so a future lane needs one new LANE_SEGMENTS row, not an
// edit here. readExecModel lets the rename-refusal messages name the plan's ACTUAL
// execModel instead of assuming "fable" (the pre-fix bug: those messages were literally
// wrong for an execModel: sol plan). No cycle: this module sits at the same layer as
// build-index-lib.mjs and lint-filename-execmodel-drift.mjs only imports FROM it, never
// the reverse.
import { LANE_SEGMENTS, readExecModel } from './lint-filename-execmodel-drift.mjs';
// plan 3341 delta-review follow-up (keys b72e03/519625): LANE_MARKER_ALTERNATION used to
// be RECOMPUTED locally here (`LANE_SEGMENTS.map((s) => s.marker).join('|')`) instead of
// importing the shared export plan-lane-segments.mjs already builds (escaped, per review
// key caed7c) — a future escaping/normalization change to that shared derivation would
// not reach this file, and this rename grammar could silently disagree with the
// evidence-floor (build-index-lib.mjs) parser, which already imports the shared export
// directly. Imported here instead of recomputed; no cycle (plan-lane-segments.mjs has zero
// imports).
import { LANE_MARKER_ALTERNATION, LANE_MARKER_DISPLAY } from './plan-lane-segments.mjs';
import { coordinationSessionId } from './coord-session-id.mjs';

// Exported (plan 1797) alongside statusOf below: stamp-lib.mjs builds stamp-target
// rels from it — one source of truth for the plans-folder prefix, never a re-rolled
// copy that could silently diverge.
export const PLANS_PREFIX = 'docs/superpowers/plans/';
// plan 1426: `parked` is a recognized-but-EXCLUDED target — a deliberate long-term
// freeze (alive, un-stamped, resurrectable), never a STATUS_ORDER member (it must not
// appear in docs/INDEX.md, the drain, claim, or board-pass). Unlike `archive` it gets NO
// terminal stamp/gitignore/prose treatment below — see the plain-move branches guarded
// by `target === 'parked'`.
export const VALID_TARGETS = [...STATUS_ORDER, ARCHIVE_FOLDER, PARKED_FOLDER];

// plan 2678: a move target may name an optional one-level category folder —
// `move-plan 2677 parked/denmark` files the plan at `parked/denmark/<basename>.md`.
// Bare `parked` keeps the flat default. Returns `{ status, category, path }`, where
// `path` is the status-rooted destination directory the rel is composed from; every
// gate downstream (`--blocked-by` rules, the promotion stamps, isWaitingFolder, the board
// row's own state) keys on `status` ONLY — a category carries no semantics.
//
// Validation is deliberately strict and LOCAL: an unknown status still fails
// assertOneOf with the full valid set, and a bad category fails here with its own
// message rather than being silently created as a folder nobody can lint.
export function parseMoveTarget(raw) {
  const segments = String(raw ?? '')
    .split('/')
    .filter(Boolean);
  const status = segments[0] ?? '';
  const categorySegments = segments.slice(1);
  const violation = planNestingViolation(status, categorySegments, String(raw ?? ''));
  if (violation) throw new Error(`move-plan: invalid target — ${violation}`);
  const category = categorySegments.length ? categorySegments[0] : null;
  return { status, category, path: category ? `${status}/${category}` : status };
}
// plan 3960 cluster-6 review fix: this used to be a literal `/^waiting-/` prefix TEST — a
// coord.config.json that renames a waiting-* lane to a folder not spelled "waiting-something"
// (nothing in coord-config.mjs's lane validation forbids that; a lane name is free-form) would
// silently stop needing --blocked-by / getting the operator-hold rewrite entirely, while the
// renamed folder is still, in every OTHER sense, a waiting lane. Reading the configured lane
// ROLES instead of the string prefix means the detector can never disagree with what
// coord.config.json actually calls a waiting lane, however it is spelled.
// plan 3960 review fix round: WAITING_FOLDERS/isWaitingFolder hoisted to build-index-lib.mjs
// (imported above) so done-worktree.mjs's batch close-out shares the SAME configured predicate
// instead of a second local copy or claim-plan-lib.mjs's hardcoded-prefix version.

// Kept exported (plan 3973, preserved through this plan's rebase) because stamp-lib.mjs's combined
// stamp+move classifies a move target with it in four places; dropping it here would break that
// module, which landed on master while this branch was in review. It agrees with the configured
// `isWaitingFolder` for every lane vetapp spells today (all five waiting lanes are `waiting-*`),
// so this is not a live divergence — but `isWaitingFolder` is the one that stays correct under a
// renamed lane, and stamp-lib.mjs should migrate onto it. Recorded in docs/handoff/infra-debt.md
// with the rest of the coord-core seam residue rather than widened into this plan's diff.
export const WAITING_RX = /^waiting-/;
// (The SEED-WRITE anchor banner regex moved to build-index-lib.mjs as
// SEED_BANNER_ANCHOR_RX — plan 2892 — so the pre-stamp promotability check can require
// the SAME shape this move demands. Used directly at its one call site below.)
const BLOCKED_RX = /^\*\*Blocked-by:\*\*.*$/m;
// plan 2818: the "terminal park" lanes for the self-held-claim warn below — a plan
// landing here is being handed off, not paused for a resume in the next few minutes.
const TERMINAL_PARK_TARGETS = new Set([
  WAITING_GRILL_FOLDER,
  WAITING_OPERATOR_FOLDER,
  WAITING_BLOCKED_FOLDER,
]);

// Insert/replace the Blocked-by header for a waiting-*/ target; leave the body
// unchanged for non-waiting targets (the existing line becomes historical).
//
// `seedLane` (default true): when false (config-less / non-vetapp repo), an absent
// SEED-WRITE banner is expected — anchor the Blocked-by line after the H1 instead
// of throwing. The seedLane=true throw path is byte-identical to the original
// behaviour (vetapp).
// The two arg-guards for a waiting-*/ move, in ONE place (plan 486) so main() can
// validate BEFORE the irreversible `git mv`, and rewriteBlockedByHeader reuses the
// exact same checks. No-op for a non-waiting (promotion) target. Throws on a missing
// reason, or a flag-shaped one — the parseArgs footgun where `--blocked-by --dry`
// swallows the next flag as the reason.
export function assertBlockedByOk(targetStatus, blockedBy) {
  if (!isWaitingFolder(targetStatus)) return; // promote → no --blocked-by needed
  if (!blockedBy)
    throw new Error(`move-plan: target ${targetStatus}/ requires --blocked-by "<reason>"`);
  if (blockedBy.startsWith('--'))
    throw new Error(
      `move-plan: --blocked-by got "${blockedBy}" — looks like a flag, not a reason. Quote the value: --blocked-by "<reason>"`,
    );
}

// Mark a validation error fatal so the top-level handler exits 2 (usage error), not 1.
const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });

// A waiting-trip/ target needs a concrete revival trip-condition in the BODY (the
// half waiting-blocked enforces via --blocked-by). Fail-fast — like assertBlockedByOk
// but body-dependent, so it runs in the producer BEFORE the irreversible `git mv`.
// No-op for any non-waiting-trip target.
export function assertTripConditionOk(targetStatus, content) {
  if (targetStatus !== WAITING_TRIP_FOLDER) return;
  if (!hasTripCondition(content))
    throw fatal(
      'move-plan: target waiting-trip/ requires a trip-condition in the body ' +
        '(a "## Trip-condition" heading or a "Trip-condition:" line stating what revives the plan). ' +
        'Add one first:  node scripts/edit-plan.mjs <id> --find "<anchor>" --replace "<anchor>\\n\\n## Trip-condition\\n\\n<what revives it>"',
    );
}

// The unblock values that are a GENUINE operator hold. `cost` is deliberately
// excluded (plan 1065): cost is never a blocker — spend is governed by the 💰
// Cost-forecast banner + the drain's pause-on->$5, so a cost-gated plan is safe in
// ready/ (the drain stops before spending). Only manual / decision are operator holds.
const OPERATOR_UNBLOCK = VALID_UNBLOCK.filter((u) => u !== 'cost'); // ['manual','decision']
const COST_NOT_OPERATOR =
  'move-plan: cost is not an operator hold — the drain gates spend (pause-on->$5), so a ' +
  'cost-gated plan is safe in ready/. Route it there: node scripts/move-plan.mjs <id> ready ' +
  '(cost is never a blocker, plan 1065).';

// A waiting-operator/ target needs an `unblock: manual|decision` frontmatter field
// (cost is rejected — see OPERATOR_UNBLOCK / plan 1065). Accept it via --unblock <value>
// (then setUnblock writes it), else require an existing valid field. Fail-fast in the
// producer before the `git mv`. No-op for any non-waiting-operator target. (The standalone
// `--unblock cost` case never reaches here: main() auto-redirects it to ready/ first; this
// is the backstop for a cost value arriving via a plan body's existing frontmatter.)
export function assertUnblockOk(targetStatus, content, unblockFlag) {
  if (targetStatus !== WAITING_OPERATOR_FOLDER) return;
  if (unblockFlag !== undefined) {
    if (unblockFlag === 'cost') throw fatal(COST_NOT_OPERATOR);
    if (!OPERATOR_UNBLOCK.includes(unblockFlag))
      throw fatal(
        `move-plan: --unblock must be one of ${OPERATOR_UNBLOCK.join('|')} for waiting-operator/ (got "${unblockFlag}").`,
      );
    return; // valid flag → setUnblock inserts/replaces it in the body rewrite
  }
  const existing = getUnblock(content);
  if (!existing)
    throw fatal(
      `move-plan: target waiting-operator/ requires an "unblock: ${OPERATOR_UNBLOCK.join('|')}" ` +
        'frontmatter field. Supply --unblock <manual|decision>, or add it first with edit-plan.mjs.',
    );
  if (existing === 'cost') throw fatal(COST_NOT_OPERATOR);
  if (!OPERATOR_UNBLOCK.includes(existing))
    throw fatal(
      `move-plan: existing "unblock: ${existing}" is invalid for waiting-operator/ — must be one of ${OPERATOR_UNBLOCK.join('|')}.`,
    );
}

// plan 4069 (task 1); review round 2 (R2-9, key 79 efficiency): the axis vocabulary — AXIS_TAGS,
// AXIS_TAGS_BY_UNBLOCK, GRILL_AXIS_TAGS, and the `[axis: …]` marker regex — now lives in the
// zero-import leaf module scripts/coord/axis-tags.mjs, so a consumer that needs only this DATA
// (drain-run.mjs's park writers) never has to import this whole CLI module (node:fs,
// child_process, ~15 coordination modules) for three constants + one regex. Imported here and
// RE-EXPORTED under their existing names so every pre-existing consumer/test keeps working
// unchanged.
import { AXIS_TAGS, AXIS_TAGS_BY_UNBLOCK, GRILL_AXIS_TAGS, AXIS_TAG_RX } from './axis-tags.mjs';
export { AXIS_TAGS, AXIS_TAGS_BY_UNBLOCK, GRILL_AXIS_TAGS };

// plan 4069 (task 1): the waiting-operator/ entry gate's axis-tag half, alongside
// assertUnblockOk's `unblock:` gate. `unblockValue` is the EFFECTIVE value (the --unblock flag
// if supplied, else the body's own `unblock:` field) — assertUnblockOk has already validated it
// is `manual` or `decision` by the time this runs (same producer, called right after it), so the
// two can never disagree about which axis subset applies. No-op for a non-waiting-operator
// target. Fail-CLOSED on a missing/unrecognised tag, same posture as every sibling entry gate —
// never judges the reason's CONTENT, only that it declares an axis from the fixed list.
export function assertBlockedByAxisTagOk(targetStatus, blockedBy, unblockValue) {
  if (targetStatus !== WAITING_OPERATOR_FOLDER) return;
  const allowed = AXIS_TAGS_BY_UNBLOCK[unblockValue] ?? AXIS_TAGS_BY_UNBLOCK.decision;
  const m = String(blockedBy ?? '').match(AXIS_TAG_RX);
  const tag = m ? m[1].toLowerCase() : null;
  if (!tag || !AXIS_TAGS.includes(tag))
    throw fatal(
      `move-plan: --blocked-by must carry an [axis: <tag>] marker from {${AXIS_TAGS.join('|')}} ` +
        `(got "${blockedBy ?? ''}"). A question that fits no axis is a session decision — write ` +
        'it under "## Session decisions" with the chosen option and proceed, rather than parking it.',
    );
  if (!allowed.includes(tag))
    throw fatal(
      `move-plan: --blocked-by axis "${tag}" is not valid for unblock: ${unblockValue} — allowed ` +
        `here: {${allowed.join('|')}}.`,
    );
}

// A ready/ target must carry a parseable 💰 Cost forecast banner (plan 1260). The
// autonomous drain PAUSES on a ready/ plan whose banner is missing/unparseable, and the
// pre-push lint (lint-plan-cost-forecast) then HARD-BLOCKS every session's next push
// repo-wide until it is fixed — so the cost of a promoter's forgotten banner lands on the
// NEXT (unrelated) pusher. Validate it HERE, at promotion time, via the SHARED gate the
// lint's predicate + next-plan-id's --ready mint also use (readyCostBannerError, plan-cost-
// banner.mjs), so the movers and the lint can never disagree and the promoter fixes it in
// the same motion. Fail-fast in the producer BEFORE the irreversible `git mv` (the plan-486
// discipline). No-op for any non-ready target.
export function assertCostBannerOk(targetStatus, content, basename) {
  if (targetStatus !== READY_FOLDER) return;
  const msg = readyCostBannerError(
    basename,
    content,
    `move-plan: cannot promote ${basename} to ready/ — it has no parseable 💰 Cost forecast ` +
      `banner. The autonomous drain PAUSES on it and lint-plan-cost-forecast then blocks every ` +
      `session's next push until it is fixed. Add one, then re-run the move:`,
  );
  if (msg) throw fatal(msg);
}

// plan 2034 (R3b): --blocked-by is OPTIONAL for the waiting-grill/ lane — the reason is
// always the same (the plan awaits a batch grilling session), so forcing the parker to
// invent prose is friction that discourages parking. mainImpl defaults an omitted flag
// to this text; an explicit --blocked-by still wins. Exported for the tests.
export const GRILL_BLOCKED_BY_DEFAULT = 'operator grilling — see ## Grill questions';

// plan 2034 (R3a): a waiting-grill/ target must carry a `## Grill questions` section
// with at least one non-empty content line — presence + substance, never a machine-parse
// of question structure (numbered items with context + the parker's recommended answer
// are runbook CONVENTION, not code). Fail-fast in the producer BEFORE the irreversible
// `git mv`, same discipline as assertTripConditionOk. No-op for any other target.
export function assertGrillQuestionsOk(targetStatus, content) {
  if (targetStatus !== WAITING_GRILL_FOLDER) return;
  if (!hasGrillQuestions(content))
    throw fatal(
      'move-plan: target waiting-grill/ requires a non-empty "## Grill questions" section ' +
        'in the body (numbered questions, each with enough context to answer cold plus the ' +
        "parker's recommended answer). Add one first with edit-plan.mjs, then re-run the move.",
    );
}

// plan 4069 session decision S1: `## Grill questions` stops trying to INFER question structure
// from free-form Markdown prose. Three bounded `/gpt-review` rounds could not converge two
// regexes built on that inference — one deciding which lines were questions at all
// (ENTRY_OPENER_RX, now deleted), one deciding whether a question was already answered
// (STALE_GRILL_ITEM_RX, now deleted) — because free-form prose has no single grammar that
// satisfies every existing shape in the corpus AND every new one; round 3's own re-review asked
// for both a broader and a narrower opener in the same report. The fix is to stop inferring and
// REQUIRE a structured form instead: the section is a NUMBERED LIST ONLY. Every item opens with
// `N. ` at column 0; an indented line under it is a continuation (its content is never scanned —
// only the item's own opening-line text is, by every gate below); anything else — a bullet, a
// bold line, a sub-heading, an unindented fence delimiter, bare unindented prose — is refused
// outright by assertGrillQuestionsStructureOk. No fence-tracking is needed any more: an indented
// line is a continuation regardless of what it contains, and an unindented non-item line is
// refused whether or not it happens to sit inside something that looks like a fenced example.
const GRILL_ITEM_RX = /^(\d+)\.[ \t]+(.*)$/;

// plan 4069 session decision S1: the ONE scan of `## Grill questions`, replacing the old
// prose-inferring `grillQuestionEntries` (ENTRY_OPENER_RX/ENTRY_MARKER_RX/STALE_GRILL_ITEM_RX,
// all deleted). Returns `{ items, offenders }`: `items` are well-formed numbered entries
// (`{ opener, text }`, `text` = capture group 2 — the item's own opening-line text with the
// `N. ` marker already stripped, so no second marker-stripping helper is needed); `offenders`
// are the raw lines that fit neither shape, for assertGrillQuestionsStructureOk to quote. A
// blank line is always ignored — never an opener, never a continuation, never an offender. An
// indented line is a continuation of the item above it (accepted purely by being indented, its
// content unread); an indented line with nothing open yet is itself an offender.
function grillQuestionEntries(content) {
  const items = [];
  const offenders = [];
  for (const rawLine of grillQuestionsSection(content).split(/\r?\n/)) {
    if (!rawLine.trim()) continue; // blank — ignored entirely
    const opener = rawLine.match(GRILL_ITEM_RX);
    if (opener) {
      items.push({ opener: rawLine.trim(), text: opener[2] });
      continue;
    }
    if (/^\s/.test(rawLine)) {
      if (items.length) continue; // an indented continuation of the item above it
      offenders.push(rawLine.trim()); // indented with no item open yet — nothing to continue
      continue;
    }
    offenders.push(rawLine.trim()); // unindented, not a numbered item — bullet/bold/heading/prose
  }
  return { items, offenders };
}

// plan 4069 session decision S1: the structure gate — refuses a `## Grill questions` section
// that is not the numbered-list-only shape above. Runs AFTER assertGrillQuestionsOk (presence +
// substance) and BEFORE assertGrillQuestionAxisTagsOk, so a malformed section gets the
// structural error rather than a confusing axis-tag one (every offender here would otherwise
// also fail the axis check, for the wrong reason). No-op for any other target.
export function assertGrillQuestionsStructureOk(targetStatus, content) {
  if (targetStatus !== WAITING_GRILL_FOLDER) return;
  const { offenders } = grillQuestionEntries(content);
  if (offenders.length)
    throw fatal(
      'move-plan: "## Grill questions" must be a NUMBERED LIST ONLY — every item opens with ' +
        '"N. " at column 0 and carries its own [axis: <tag>] marker; any context or ' +
        'recommendation prose for that item goes INDENTED underneath it, not as a separate ' +
        `unindented line. Offending line(s): ${offenders.map((o) => `"${o}"`).join(', ')}. ` +
        'Rewrite the section as a numbered list, re-indenting any context prose under its own ' +
        'item, then re-run the move.',
    );
}

// Fix round 3 (item 13), unchanged by S1: the SAME `[axis: <tag>]` marker grammar as
// assertBlockedByAxisTagOk's AXIS_TAG_RX above, anchored to an item's own opening-line text
// rather than re-declared here — a second hand-rolled copy of the marker shape is exactly how
// the two could silently drift onto two different grammars.
const LEADING_AXIS_TAG_RX = new RegExp(`^${AXIS_TAG_RX.source}`, AXIS_TAG_RX.flags);

// plan 4069 (task 1); plan 4069 session decision S1: now runs strictly AFTER
// assertGrillQuestionsStructureOk, so every `item` it sees is already well-formed — it anchors
// the axis-tag check to `item.text` (the item's own opening-line text, marker already stripped
// by grillQuestionEntries) rather than a marker-stripped opener of unknown shape. Fail-CLOSED on
// a missing/unrecognised tag; deliberately does not judge the question's CONTENT — the tag is
// the session's own declaration, reviewed later by a human at /grill-lane, never by this script.
export function assertGrillQuestionAxisTagsOk(targetStatus, content) {
  if (targetStatus !== WAITING_GRILL_FOLDER) return;
  const offenders = [];
  for (const item of grillQuestionEntries(content).items) {
    const leading = item.text.match(LEADING_AXIS_TAG_RX);
    if (!leading || !GRILL_AXIS_TAGS.includes(leading[1].toLowerCase()))
      offenders.push(item.opener);
  }
  if (offenders.length)
    throw fatal(
      'move-plan: every question in "## Grill questions" must OPEN with an [axis: <tag>] marker ' +
        `from {${GRILL_AXIS_TAGS.join('|')}} — untagged/unrecognised: ${offenders.map((o) => `"${o}"`).join(', ')}. ` +
        'A question that fits no axis is a session decision — write it under "## Session decisions" ' +
        'with the chosen option and proceed, rather than parking it.',
    );
}

// plan 4069 session decision S1: the accepted "already answered" vocabulary, as DATA rather than
// a hand-typed alternation — assertGrillQuestionsNotStaleOk below builds its recogniser from this
// list, so a new accepted token is one array entry, never a second place to keep in sync.
export const GRILL_ANSWERED_MARKERS = ['RESOLVED', 'RULED', 'ANSWERED'];

// plan 4069 (task 2); plan 4069 session decision S1: the "already answered" signal is now a
// LITERAL bracket token in a FIXED position — immediately after the item's own [axis: <tag>]
// marker (backticks optional either side, case-insensitive) — rather than something inferred
// from prose anywhere in the item. Anchored to `item.text` (the same opening-line text the axis
// check anchors to); no continuation line is ever scanned. The writer DECLARES an item answered
// by emitting the token right after its tag; the script does not judge prose — "→ RULED, see R1
// below", "Status: RESOLVED" on a continuation line, or "not yet answered" all now PASS, on
// purpose, because none of them is the declared literal token in the declared position.
const GRILL_ANSWERED_RX = new RegExp(
  `^${AXIS_TAG_RX.source}\\s*\`?\\[(?:${GRILL_ANSWERED_MARKERS.join('|')})\\]\`?`,
  'i',
);
export function assertGrillQuestionsNotStaleOk(targetStatus, content) {
  if (targetStatus !== WAITING_GRILL_FOLDER) return;
  const stale = [];
  for (const item of grillQuestionEntries(content).items) {
    if (GRILL_ANSWERED_RX.test(item.text)) stale.push(item.opener);
  }
  if (stale.length)
    throw fatal(
      'move-plan: "## Grill questions" carries an item already marked ' +
        `${GRILL_ANSWERED_MARKERS.map((m) => `[${m}]`).join('/')} immediately after its axis tag — ` +
        'move it to "## Operator rulings" or "## Session decisions" instead of re-parking it: ' +
        `${stale.map((o) => `"${o}"`).join(', ')}.`,
    );
}

// Collapse-whitespace-and-compare normalisation for the duplicate-re-park check below — the same
// question text re-wrapped or re-indented at a later park must still compare equal.
function normalizeSectionText(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

// plan 4069 (task 2): the most recent commit this plan's file passed through waiting-grill/ —
// walked via `git log --follow` on its CURRENT path (git mv renames are exactly what --follow is
// for), reading the first post-image path that landed under waiting-grill/. Returns
// `{ sha, content }`, or null when the plan has never parked there before (nothing to compare a
// fresh park against). A `git`/`show` failure on any one candidate is treated as unreadable and
// the walk continues further back rather than refusing the move outright — this check is a
// courtesy against an exact duplicate, not a hard dependency of the move succeeding.
function previousGrillPark(mainDir, currentRel) {
  let log;
  try {
    log = git(mainDir, [
      'log',
      '--follow',
      '--name-status',
      '--format=commit %H',
      '--',
      currentRel,
    ]);
  } catch {
    return null;
  }
  let sha = null;
  for (const raw of log.split('\n')) {
    const commitMatch = raw.match(/^commit ([0-9a-f]{7,40})$/);
    if (commitMatch) {
      sha = commitMatch[1];
      continue;
    }
    if (!sha || !raw.trim()) continue;
    const parts = raw.split('\t').filter(Boolean);
    const newPath = parts[parts.length - 1];
    if (!newPath || !newPath.startsWith(`${PLANS_PREFIX}${WAITING_GRILL_FOLDER}/`)) continue;
    try {
      return { sha, content: git(mainDir, ['show', `${sha}:${newPath}`]) };
    } catch {
      continue; // unreadable at that sha — keep walking further back in the log
    }
  }
  return null;
}

// plan 4069 (task 2): refuses a move into waiting-grill/ whose "## Grill questions" section is
// byte-identical (whitespace aside) to the section at the plan's PREVIOUS park — the same
// questions parked again teach nothing new and just re-ask something a prior session (or the
// operator) already saw. Unguarded when the plan has never parked in this lane before.
export function assertGrillQuestionsNotDuplicateOk(mainDir, currentRel, content, targetStatus) {
  if (targetStatus !== WAITING_GRILL_FOLDER) return;
  const prev = previousGrillPark(mainDir, currentRel);
  if (!prev) return;
  const prevSection = normalizeSectionText(grillQuestionsSection(prev.content));
  const nextSection = normalizeSectionText(grillQuestionsSection(content));
  if (prevSection && prevSection === nextSection)
    throw fatal(
      'move-plan: "## Grill questions" is byte-identical (whitespace aside) to the section at ' +
        `the plan's previous park, commit ${prev.sha} — nothing new to ask. Update the section ` +
        '(or, if the questions are actually answered, record "## Operator rulings" / ' +
        '"## Session decisions" and route elsewhere instead of re-parking).',
    );
}

// plan 2034 (R4b): the EXIT guard — a plan carrying unanswered grill questions must not
// reach `ready/`, where the autonomous drain would execute it with the operator-judgment
// calls still open.
//
// Keyed on plan CONTENT, not on the (fromStatus, target) pair. The 2034 review found the
// folder-pair form (`fromStatus === 'waiting-grill' && target === 'ready'`) trivially
// bypassable by an intermediate hop: park in waiting-grill/, move to waiting-blocked/ for
// an unrelated blocker (a deliberately UNGUARDED exit), then promote from THERE — the
// guard no-ops and the plan lands in ready/ with its questions never answered, which is
// exactly what its own contract promises to prevent. The two sibling guards in this file,
// assertSpecReviewOk and assertCostBannerOk, already gate every ready/ promotion on
// content regardless of origin folder; this now matches that established pattern.
//
// Consequence, and intended: ANY promotion to ready/ is refused while the body has a
// non-empty `## Grill questions` section and no `## Operator rulings` — including a plan
// that never passed through the lane at all. That is the correct reading of the
// invariant: the questions, not the folder, are what make a plan un-drainable. Exits to
// pending-approval/, any waiting-*/, parked/, and archive/ stay unguarded, and the
// dissolution path (a one-line `dissolved: superseded by plan NNNN` ruling) satisfies it
// without a grilling session.
export function assertGrillExitOk(targetStatus, content) {
  if (targetStatus !== READY_FOLDER) return;
  if (!hasGrillQuestions(content)) return; // no questions ⇒ nothing to answer
  if (hasOperatorRulings(content)) return;
  throw fatal(
    'move-plan: cannot promote to ready/ — the body has a non-empty "## Grill questions" ' +
      'section and no "## Operator rulings", so the operator-judgment calls are still open ' +
      'and the drain must not execute it. Record rulings (a /grill-lane session, or a ' +
      'one-line "dissolved: …" ruling for questions gone moot), then re-run the move. ' +
      'Exits to pending-approval/, any waiting-*/, parked/, or archive/ are unguarded.',
  );
}

// A ready/ target must have cleared spec-pass (plan 1292): `stage: stub` without a
// `specReview` stamp means no heavy-model spec-pass has yet challenged the plan's framing,
// so the autonomous drain would execute an unreviewed stub. Grandfather clauses (Conventions,
// plan 1292): a missing/empty `stage` (legacy plans, minted before this gate landed) always
// passes; `stage: stub` WITH any `specReview` value — a sha, or the self-declared
// `exempt-mechanical` for no-judgment mechanical plans — also passes. No-op for any non-ready
// target. Fail-fast in the producer BEFORE the irreversible `git mv`, same discipline as
// assertCostBannerOk above. Delegates the actual rule (case-insensitive stage compare,
// comment-stripped specReview read) to the shared specReviewGateError (build-index-lib.mjs;
// plan 1292 bugfix — this used to be a raw, case-sensitive, comment-blind inline compare).
export function assertSpecReviewOk(targetStatus, content, basename) {
  if (targetStatus !== READY_FOLDER) return;
  const msg = specReviewGateError(basename, content, 'move-plan: cannot promote to ready/ —');
  if (msg) throw fatal(msg);
}

// plan 3975 (T2b): --respec "<reason>" is the sanctioned way to send a SPECCED plan back
// to pending-approval/ for a fresh spec-pass — content-independent (target + flag only),
// so it validates in the same early, before-any-mutation block as assertBlockedByOk
// rather than deep in the producer. Two refusals: the flag only means anything against a
// pending-approval/ target (every other target ignores spec-review state entirely, so a
// --respec elsewhere is very likely a typo'd target, not a real request), and the reason
// is required and must not itself look like a swallowed flag (the same parseArgs footgun
// --blocked-by and --rename already guard). WITHOUT this flag, sending a specced plan to
// pending-approval/ still hits the existing plan-1371 D7 refusal (assertBoardInvariants,
// in the producer below) — --respec is the escape hatch that pairs a body rewrite with
// the move, not a bypass of the invariant it lives beside.
export function assertRespecOk(targetStatus, respecFlag) {
  if (respecFlag === undefined) return;
  if (targetStatus !== PENDING_APPROVAL_FOLDER)
    throw fatal(
      `move-plan: --respec only applies to a pending-approval/ target (got "${targetStatus}").`,
    );
  if (!String(respecFlag).trim() || String(respecFlag).startsWith('--'))
    throw fatal(
      `move-plan: --respec got "${respecFlag}" — looks like a flag, not a reason. Quote the ` +
        'value: --respec "<reason>"',
    );
}

// plan 3975 (T2b): the body-rewrite half of --respec — withdraws a specced plan's
// spec-pass stamps and resets it to the fresh-mint shape a spec-pass expects, in ONE
// write alongside the `git mv` (never a separate edit-plan follow-up, which would split
// an atomic re-spec into two commits and two chances for a partial state to reach
// origin). `stage: specced` -> `stage: stub` via the shared upsertFrontmatterKey (the
// same D7 predicate specReviewGateError reads, so the post-state this produces is
// EXACTLY what pending-approval/'s stage/folder invariant admits); `specReview` and
// `specReviewBy` are dropped outright via the shared removeFrontmatterKey — a stale sha
// or model pin describing a review this plan no longer carries is worse than none, not
// a harmless leftover. The Status line is rewritten to name the respec (mirrors
// stampPromotedStatus/stampArchivedStatus's own "one line names what just happened"
// shape) rather than reusing next-plan-id's bare fresh-mint line, so the audit trail
// says WHY this specced plan is back in the stub pen. Blocked-by (if any) is left
// untouched — a respec changes review state, not blocking relationships, and dropping it
// here would silently discard a genuine open dependency.
function respecToPendingApproval(content, { fromStatus, date, reason }) {
  let body = upsertFrontmatterKey(content, 'stage', 'stub');
  body = removeFrontmatterKey(body, 'specReview');
  body = removeFrontmatterKey(body, 'specReviewBy');
  const line =
    `**Status:** 📋 STUB — re-filed ${fromStatus}→pending-approval ${date} ` +
    `(--respec: ${reason}).`;
  return setStatusLine(body, line);
}

// Splice `line` in after the anchor line starting at `anchorIndex`.
//
// The `indexOf('\n', …) === -1` branch is the fix for a real bug (plan 2892 review round
// 2, CONFIRMED): when the anchor is the LAST line of an unterminated body, indexOf returns
// -1, `slice(0, -1 + 1)` is the EMPTY string, and the whole body is discarded down to a
// bare Blocked-by line prepended to the remainder — i.e. the header lands at offset zero
// and the plan body is mangled. Both anchor branches (SEED-WRITE banner and the seedLane-off
// H1 fallback) went through that arithmetic.
function insertAfterAnchorLine(content, anchorIndex, line) {
  const end = content.indexOf('\n', anchorIndex);
  if (end === -1) return `${content}\n\n${line}\n`; // anchor is the final, unterminated line
  return content.slice(0, end + 1) + `\n${line}\n` + content.slice(end + 1);
}

export function rewriteBlockedByHeader(content, targetStatus, blockedBy, { seedLane = true } = {}) {
  if (!isWaitingFolder(targetStatus)) return content; // promote → keep as-is
  assertBlockedByOk(targetStatus, blockedBy);
  const line = `**Blocked-by:** ${blockedBy}`;
  if (BLOCKED_RX.test(content)) return content.replace(BLOCKED_RX, line);
  const m = SEED_BANNER_ANCHOR_RX.exec(content);
  if (m) return insertAfterAnchorLine(content, m.index, line);
  // No SEED-WRITE banner present:
  if (seedLane)
    throw new Error('move-plan: no SEED-WRITE banner found to anchor the Blocked-by header');
  // seedLane off ⇒ no banner is expected; anchor the Blocked-by line right after
  // the H1 (or at top if none).
  const h1 = content.match(/^#\s+.+$/m);
  if (h1) return insertAfterAnchorLine(content, h1.index, line);
  return `${line}\n\n${content}`;
}

// Exported so edit-plan.mjs (plan 533) shares the exact same plan-listing as the
// resolvePlanRel matcher it already imports — one source of truth for PLANS_PREFIX.
export function lsPlans(mainDir) {
  return git(mainDir, ['ls-files', `${PLANS_PREFIX}*.md`])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// Resolve a plan by exact basename or by NNN id, to its current rel path.
export function resolvePlanRel(plans, idOrName) {
  const byExact = plans.find(
    (p) => p.split('/').pop() === idOrName || p.split('/').pop() === `${idOrName}.md`,
  );
  if (byExact) return byExact;
  // `\d{3,}` (not `\d{3}`) so a 4-digit id (plan 1000+) captures its full id, not a
  // truncated 3-digit prefix that collides with an unrelated 100-* plan (plan 1002).
  const idMatch = String(idOrName).match(/^(\d{3,})/);
  if (idMatch) {
    // idClaimPattern (build-index-lib.mjs) is the ONE shared "does this basename
    // genuinely claim this id" assertion, also used by next-plan-id.mjs's
    // idTakenByOther and (via claimedIdOfBasename, the derive-direction twin) the
    // claim-holder guard below — plan 2039/2082. Compiled ONCE here and reused
    // across the whole filter (review r13 — a per-basename claimedIdOfBasename call
    // recompiled ~2000 throwaway RegExps per lookup). Excludes only a dateless
    // legacy archive basename (`archive/2026-05-17-x.md`) whose leading digits
    // merely READ as a plausible id; a malformed/unrecognized basename otherwise
    // still counts as a candidate. claim-plan.mjs:708 is a separate, inverted
    // given-slug-vs-given-id check — no change needed there, but worth re-checking
    // whenever idClaimPattern changes.
    const idRx = new RegExp(`^${idClaimPattern(idMatch[1])}`, 'u');
    const hits = plans.filter((p) => idRx.test(p.split('/').pop()));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1)
      throw new Error(`move-plan: id ${idMatch[1]} is ambiguous: ${hits.join(', ')}`);
  }
  throw new Error(`move-plan: no plan matches "${idOrName}"`);
}

// Exported (plan 1362) so edit-plan.mjs shares the exact same status-folder read
// as move-plan's own gates — one source of truth for "which folder is this path in".
export function statusOf(rel) {
  return classifyPlanRel(rel.slice(PLANS_PREFIX.length)).statusFolder;
}

// plan 2678: the status-rooted directory a plan currently sits in — `ready` when flat,
// `parked/denmark` when categorised. This, not `statusOf`, is what a move compares
// against its TARGET path: re-clumping a plan inside the SAME status (`ready` →
// `ready/infra`) is a legitimate move, so the already-in-that-folder refusal has to key
// on the full location, not the status alone.
export function statusPathOf(rel) {
  const { statusFolder, category } = classifyPlanRel(rel.slice(PLANS_PREFIX.length));
  return category ? `${statusFolder}/${category}` : statusFolder;
}

// plan 2082: rewrite the subfolder segment (and, on a same-move FABLE-stamp rename,
// the basename) of every board-row Plan/claim ref pointing at the moved plan, so a
// move can never strand a stale `<old-folder>/<basename>` path in the board — the
// BOARD_SUBFOLDER_DRIFT class that lint-board raises from `.husky/pre-push` on EVERY
// master push, fleet-wide, until healed (the plan-2077 incident, commit 61c08cf29:
// a claimed plan moved in-progress/ → ready/ while its 🔄 ACTIVE row kept the
// in-progress/ path).
//
// Pure + git-free (the board-lib discipline). Matching is by ref FILENAME via the
// same extractPlanRefs the lint itself uses, so the two can never disagree about
// what constitutes a plan ref. A subfolder-less (bare) ref is rewritten only on a
// rename — the lint never flags bare refs for subfolder drift, so adding a folder
// segment would be a gratuitous diff. Replacements apply longest-ref-first so a
// bare-ref rename can never corrupt an already-rewritten subfoldered occurrence of
// the same file in one cell. No matching row → { changed: false } with the input
// content returned byte-identical.
//
// Deliberately NOT called for archive/parked targets (mainImpl guards): a frozen
// plan must not keep a board row at all, so the correct heal there is row REMOVAL
// (the close-out ritual / recovery checklist), and lint's ARCHIVED_PLAN_ACTIVE_ROW /
// PARKED_PLAN_ACTIVE_ROW hints already say exactly that — repointing the path would
// only trade one accurate error for another.
export function syncBoardPlanRefs(content, { oldBasename, newBasename, target }) {
  let rows = 0;
  let next;
  // board-lib's shared withBody (exported for this, plan 2082) owns the
  // splitBoard → per-line transform → reassembly contract — same code path as
  // board.mjs's five mutators, so the two write paths can never drift. The catch
  // is NARROW (review r8/r12): only splitBoard's typed sentinel-miss is the benign
  // "nothing to sync" no-op; any other throw (a future transform bug — today's loop
  // is total over strings) rethrows LOUDLY instead of silently stranding the stale
  // row this function exists to fix.
  try {
    next = withBody(content, (lines) => {
      for (let i = 0; i < lines.length; i++) {
        const cells = cellsOf(lines[i]);
        if (!cells || cells.length < 4 || isSeparator(lines[i])) continue;
        const cell = cells[3];
        const repl = new Map();
        for (const ref of extractPlanRefs(cell)) {
          if (ref.filename !== oldBasename) continue;
          const to = ref.subfolder ? `${target}/${newBasename}` : newBasename;
          if (ref.full !== to) repl.set(ref.full, to);
        }
        if (repl.size === 0) continue;
        let cellNext = cell;
        for (const [from, to] of [...repl.entries()].sort((a, b) => b[0].length - a[0].length))
          cellNext = cellNext.split(from).join(to);
        if (cellNext === cell) continue;
        cells[3] = cellNext;
        lines[i] = `| ${cells.join(' | ')} |`;
        rows++;
      }
    });
  } catch (e) {
    if (e?.code !== 'NO_BOARD_SENTINELS') throw e;
    return { content, changed: false, rows: 0 }; // sentinel-less board — nothing to sync
  }
  if (rows === 0) return { content, changed: false, rows: 0 };
  return { content: next, changed: true, rows };
}

// plan 2082: claim-holder guard — pure verdict half over claim-plan's planStatus
// result ({ planId, held, holder|null, youAreHolder }; holder is null for a held ref
// whose claim message failed to parse — treated as held-by-unknown → refuse, since
// self-hold cannot be proven). Returns null (proceed) for unheld or self-held, else
// the refusal message naming the holder identity and the sanctioned ways forward.
// Moving a plan claimed by ANOTHER session re-files it out from under the holder —
// the coordination error this guard surfaces; a SELF-held move stays allowed (the
// plan-2077 session moved its own claimed plan; whether that workflow is wise is
// explicitly out of scope — mainImpl prints an advisory note for it instead).
// `selfIdKnown=false` (no coordination identity in the environment — a bare shell
// or headless run) cannot distinguish self from foreign, so it refuses CONSERVATIVELY
// and says so: fail-open here would disarm the guard in exactly the unattended runs
// it protects, and --force is the deliberate, visible override for that case.
// The holder-identity string, in ONE place (plan 2719 review, finding [6]): the rename
// claim gate needs the identical phrasing, and two hand-kept copies of a message about the
// same claim state is exactly the drift a future edit to one would leave silently in the
// other. Also used for a claim whose message failed to parse (holder null).
export function describeClaimHolder(status) {
  const h = status?.holder;
  return h
    ? `session ${h.sessionUuid} (host ${h.host ?? '?'}, since ${h.iso ?? '?'})`
    : 'an UNPARSEABLE claim record (holder unknown)';
}

// The truncated one-line form of a thrown git/coord error, shared by both claim reads
// (plan 2719 review, finding [6] — the second half of the same duplication).
const shortErr = (e) => (errText(e) || e.message || '').trim().slice(0, 200);

// Round-3 review fix (finding e91eef): parameterized so stamp-lib.mjs's combined
// stamp+move guard can reuse this ONE formatter instead of keeping a second copy
// (the retired combinedMoveClaimHolderError) — `tool` swaps the "move-plan:" brand,
// `hasForceOverride` drops the "--force is the sanctioned way through" tail for a
// caller with no override flag of its own, and `guidance` swaps the whole remediation
// sentence for one naming that caller's actual escape hatch. The ref text itself
// (round-3 findings f4c9b3/12ef2c/06453e) now names whichever namespace the dual-read
// ACTUALLY found the claim under — `status.ref`, set by readClaimHolderStatus below —
// rather than a hardcoded `refs/claims/<id>` (always wrong once a claim moves to the
// branch-shaped namespace) or a hardcoded `claimRef(...)` (always wrong for a claim
// still held in the legacy namespace during the migration window). The `?? claimRef(...)`
// fallback only matters for direct unit-test fixtures that omit `ref`.
export function claimHolderError(
  status,
  { basename, selfIdKnown = true, tool = 'move-plan', hasForceOverride = true, guidance } = {},
) {
  if (!status?.held) return null; // unheld
  if (status.youAreHolder) return null; // self-held
  const who = describeClaimHolder(status);
  const unprovable = selfIdKnown
    ? ''
    : ` NOTE: this environment has no coordination session identity, so a self-held claim cannot be proven yours${
        hasForceOverride ? ' — if you are the holder, --force is the sanctioned way through.' : '.'
      }`;
  const ref = status.ref ?? claimRef(status.planId);
  const remedy =
    guidance ??
    `If the move is operator-directed, re-run with --force; otherwise coordinate with the holder, or ` +
      `release a dead session's claim first: node scripts/release-claim.mjs release ${status.planId} --force`;
  return (
    `${tool}: ${basename} is CLAIMED by ${who} — refusing to move a plan out from under ` +
    `its holder (plan 2082; ${ref}).${unprovable} ${remedy}`
  );
}

// plan 3973 review fix (round 2, R1 — findings e5c145/c6fc99): the claim-holder READ
// sequence — resolve the plan's claim id (if any) via claimedIdOfBasename, then read its
// status via claim-plan's planStatus — shared by this module's own move guard (mainImpl,
// below) AND stamp-lib.mjs's combined stamp+move guard, so the two paths can never read a
// claim differently (the pre-fix duplication these findings flagged). A read failure calls
// the caller's own `warn(e, claimsId)` — each tool keeps its own WARN wording/ref-name
// spelling, never a re-rolled copy — and returns `readFailed: true`: fail-open, the exact
// contract both callers already relied on before this extraction.
//
// Message-building is deliberately NOT done here: both callers pass their own `tool`/
// `hasForceOverride`/`guidance` into the now-shared claimHolderError (round-3 review fix,
// finding e91eef) rather than this function picking a brand or a remediation sentence.
//
// Round-3 review fix (findings f4c9b3/12ef2c/06453e): this resolves which ref namespace
// actually holds the claim (`status.ref`) for every caller's message text, instead of each
// caller hand-guessing a namespace.
//
// Round-4 review (findings 6d352f/abb120/9b9f9b): `planStatus` now returns `ref` on the
// same result that decided `held`/`youAreHolder`, so this helper makes ONE read — the
// earlier second `readHolder` call (and the race between the two reads) is gone.
export function readClaimHolderStatus(mainDir, basename, { selfId, warn } = {}) {
  const claimsId = claimedIdOfBasename(basename);
  if (!claimsId) return { claimsId: null, status: null, readFailed: false };
  let status;
  try {
    status = planStatus(mainDir, claimsId, { selfId });
  } catch (e) {
    warn?.(e, claimsId);
    return { claimsId, status: null, readFailed: true };
  }
  // `status.ref` (the namespace the claim was actually found in) rides on the SAME read that
  // decided held/youAreHolder — planStatus carries it since plan 3973 review round 4 — so
  // there is exactly one remote read here and no window between a verdict and its ref.
  return { claimsId, status, readFailed: false };
}

// ── plan 2719: the sanctioned slug-rename path ────────────────────────────────
//
// The plan-2329 naming rules explicitly authorize sweep-time renames of UNCLAIMED
// plans (the operator-approved carve-out, 2026-07-24) — but until this flag every
// write path refused the operation: edit-plan renames only the FABLE- segment,
// move-plan only the status folder + category, coord-edit rejects the rename's
// untracked new path, and a hand `git mv` + INDEX resync dies on the plan-1279
// coord-doc pre-commit guard (the de-facto escape was a BOARD_GUARD_OVERRIDE=1
// hand commit pair, undocumented and unaudited). So the carve-out was dead policy.
//
// It lands as a FLAG on move-plan rather than a sibling rename-plan.mjs because
// move-plan ALREADY performs a basename rename inside the very same `git mv` (the
// plan-1362 FABLE- auto-stamp at `stampedRelForExecModel`), and its hardened
// commit/rollback loop (plans 478/486/492/819/868/2082) already restores BOTH sides
// of a renamed path and syncs board rows by old→new basename. A separate module
// would have had to duplicate that loop — which the plan itself named as the
// delicate part — for no reuse gain.
//
// Two shapes, one code path:
//   move-plan <id> --rename <new-basename>            pure rename, stays in its lane
//   move-plan <id> <target> --rename <new-basename>   move AND rename in one commit
// A pure rename carries the body over BYTE-IDENTICAL (the `parked` plain-move branch's
// discipline): the plan is not changing lanes, so it must not collect a promotion
// stamp, a rewritten Blocked-by header, or a newly-enforced lane gate.

// The lanes a rename may touch — exactly the set the plan-2329 carve-out authorizes
// ("UNCLAIMED plans (pending-approval/ready/waiting-*) MAY be renamed to conformance").
// The three excluded folders each have their own concrete reason, not squeamishness:
//   in-progress/ — the branch, worktree dir, landing-queue slug and board row all key
//                  on the basename; renaming under a live worktree breaks all four.
//   archive/     — docs/INDEX.md's archive-narrative region is HAND-written prose, NOT
//                  regenerated, and it references archived plans by basename; a rename
//                  would strand those references with nothing to resync them.
//   parked/      — absent from STATUS_ORDER, so it has no INDEX bullet to resync and is
//                  excluded from every scan; un-park it, rename, re-park.
export const RENAMEABLE_STATUSES = STATUS_ORDER.filter((s) => s !== IN_PROGRESS_FOLDER);

// Soft-only conventions (see planRenameGrammar) — the country-token hints and the Pipe-stage
// vocabulary USED TO be module literals here (`COUNTRY_TOKEN_HINTS`, `PIPE_STAGE_TOKENS`).
// Plan 4071 (T2/D2) moved both into `coord.config.json`'s `planNaming` key (core default
// `{ countryTokenHints: [], stageTokens: { category: null, tokens: [] } }` — empty/null means
// the lint never fires) and made planRenameGrammar take them as parameters; mainImpl below
// resolves `loadCoordConfig(mainDir).planNaming` once and passes it through.

// The bracket hint used in operator-facing "expected shape" messages below, e.g.
// `[FABLE-|SOL-]` — also derived, so a fourth lane's marker shows up here for free.
// plan 3341 review round 3 (key 9b9b78): this hint is OPERATOR-FACING text, so it must use the
// RAW marker fragment, never the escaped one the regexes are built from. With today's markers the
// two are identical, but a future marker containing a regex metacharacter (say `OPUS+`) would be
// escaped to `OPUS\+` — and an operator who copied the expected shape out of the error message
// below would then submit a filename the rename grammar rejects. `LANE_MARKER_ALTERNATION` stays
// the source for RENAME_BASENAME_RX just below; only the human-readable hint changes.
const LANE_MARKER_HINT = `[${LANE_MARKER_DISPLAY}]`;

// Basename grammar for a rename target: `<id>-[FABLE-|SOL-]<Category>-<slug>.md`.
const RENAME_BASENAME_RX = new RegExp(
  `^(\\d{3,})-(${LANE_MARKER_ALTERNATION})?([A-Za-z][A-Za-z0-9]*)-(.+)\\.md$`,
);

// Pure verdict on a proposed new basename: `{ errors, warnings }`, both arrays of
// self-explaining strings. A non-empty `errors` refuses the rename; `warnings` are
// printed and the rename proceeds.
//
// What is HARD (shape the tooling actually keys on): the `.md` extension, no path
// separator (--rename takes a basename, the folder is the positional target), the
// id/category/slug shape, an id that still matches the plan being renamed (a rename
// never re-mints an id — the claim ref, INDEX bullet and every cross-reference key on
// it), a category inside the plan-2329 taxonomy, and the shared slug charset.
//
// What is SOFT, deliberately (plan 2719 judgment call): the country token and the
// `Pipe` stage token. Neither is machine-verifiable as a RULE — the runbook itself says
// the mint gate "cannot verify country scope" (only a human knows whether a plan is
// single-country), and the stage-token rule is widely unenforced in the live corpus
// (2626/2632/2666/2705 all lack it). A hard gate on either would refuse renames that
// FIX the country token while tripping over an orthogonal convention — the exact
// opposite of this tool's purpose, which is to make names MORE conformant. What can be
// judged from the string alone is a token that is definitely the wrong SPELLING of a
// country (`gb`, `sweden`) — that warns, with the code to use.
export function planRenameGrammar(
  newBasename,
  {
    expectedId,
    allowlist = [],
    countryTokenHints = [],
    stageTokens = { category: null, tokens: [] },
  } = {},
) {
  // countryTokenHints arrives as coord.config.json's array-of-rows shape (`{ token, code }`) —
  // JSON has no Map literal — rebuilt into a Map here for the same O(1) lookup the old module
  // literal gave for free.
  const countryHintMap = new Map(countryTokenHints.map((row) => [row.token, row.code]));
  const errors = [];
  const warnings = [];
  const name = String(newBasename ?? '');
  if (!name.trim()) {
    errors.push('--rename got an empty name');
    return { errors, warnings };
  }
  if (/[\\/]/.test(name))
    errors.push(
      `"${name}" contains a path separator — --rename takes a BASENAME, not a path ` +
        "(the destination folder is the positional <target-status[/category]>, or the plan's current lane).",
    );
  if (!name.endsWith('.md')) errors.push(`"${name}" must end in .md`);
  const m = RENAME_BASENAME_RX.exec(name);
  if (!m) {
    errors.push(
      `"${name}" is not a plan basename — expected <id>-${LANE_MARKER_HINT}<Category>-<slug>.md ` +
        '(plan 2329; docs/coord/plan-lanes.md § Plan naming).',
    );
    return { errors, warnings };
  }
  const [, id, , category, slug] = m;
  if (expectedId != null && id !== String(expectedId))
    errors.push(
      `"${name}" claims plan id ${id}, but the plan being renamed is ${expectedId} — a rename ` +
        'changes the SLUG, never the id (the claim ref, INDEX bullet and every cross-reference key on it).',
    );
  // plan 4071 D1: an EMPTY allowlist means "no category gate" — same degrade direction as
  // next-plan-id.mjs's mint-time check.
  if (allowlist.length && !allowlist.includes(category))
    errors.push(
      `category "${category}" is not in the plan-2329 taxonomy. ` +
        `Valid categories: ${allowlist.join(', ')} (case-sensitive).`,
    );
  if (!SLUG_CHARSET_RX.test(slug))
    errors.push(
      `slug "${slug}" must match ${SLUG_CHARSET_RX} — start alphanumeric, then ` +
        'alphanumerics/dot/underscore/hyphen only.',
    );
  const firstToken = slug.split('-')[0].toLowerCase();
  const hint = countryHintMap.get(firstToken);
  if (hint)
    warnings.push(
      `first slug token "${firstToken}" — the country token is always the CODE: use "${hint}". ` +
        '(uk, not gb, in plan names and operator-facing prose; GB survives only in machine/ISO contexts.)',
    );
  if (
    stageTokens.category &&
    category === stageTokens.category &&
    !stageTokens.tokens.includes(firstToken)
  )
    warnings.push(
      `a ${stageTokens.category} plan's FIRST slug token should be the pipeline stage ` +
        `(${stageTokens.tokens.join(' / ')}), got "${firstToken}". Advisory only — the ` +
        'convention is widely unenforced in the live corpus, so it never refuses a rename.',
    );
  // Belt-and-suspenders (plan 2719 review, finding [9]): RENAME_BASENAME_RX exists to
  // CAPTURE the four parts, which the canonical PLAN_FILENAME_RX cannot do — but the two must
  // never disagree about what a plan filename IS, or the gate could land a basename
  // build-index.mjs / lint-board.mjs refuse to SEE (the plan-1928 silent-INDEX-drop class
  // PLAN_TAG_SOURCE was consolidated to prevent). Checked LAST and only when nothing more
  // specific fired, so it stays a backstop: the taxonomy/charset messages tell the operator
  // what to change, this one only catches a future divergence between the two shapes.
  if (!errors.length && !PLAN_FILENAME_RX.test(name))
    errors.push(
      `"${name}" does not match the canonical plan-filename shape (PLAN_FILENAME_RX, ` +
        'build-index-lib.mjs) — build-index and lint-board would not recognise it as a plan.',
    );
  return { errors, warnings };
}

// The lane half of the rename gate: pure, over the source and destination statuses.
// Returns a refusal message or null. Both ends are checked — a rename that MOVES a plan
// into in-progress/ is as broken as one that renames a plan already sitting there.
export function renameLaneError(fromStatus, targetStatus, basename) {
  const bad = [
    ['source', fromStatus],
    ['destination', targetStatus],
  ].find(([, s]) => !RENAMEABLE_STATUSES.includes(s));
  if (!bad) return null;
  const [side, status] = bad;
  const why = {
    [IN_PROGRESS_FOLDER]:
      'the branch, worktree directory, landing-queue slug and board row all key on the basename',
    [ARCHIVE_FOLDER]:
      "docs/INDEX.md's archive-narrative region is hand-written prose that references archived plans " +
      'by basename and is never regenerated',
    [PARKED_FOLDER]:
      'parked/ is absent from STATUS_ORDER, so it has no INDEX bullet to resync — un-park it, rename, re-park',
  };
  return (
    `--rename refuses ${basename} — its ${side} lane is ${status}/, and a rename is ` +
    `only sanctioned for ${RENAMEABLE_STATUSES.join(' / ')} (plan 2329's unclaimed-plan carve-out). ` +
    `Reason: ${why[status] ?? 'that lane is outside the carve-out'}.`
  );
}

// plan 4136 E4: the argument-only half of mainImpl's pre-mutation validation, extracted so
// main()'s lock-free preflight (runLockFreePreflight, below main()) and mainImpl itself run the
// EXACT SAME checks with identical messages/exit codes — never a second hand-copied parse.
// Reads only `argv`; every refusal is unconditional console.error (an arg-only refusal means
// mainImpl never runs, so this is the ONLY place that prints it) — except the ready/ cost-redirect
// notice (console.log), which is gated on `quiet` alone: the caller that already printed it (the
// preflight, when it ran) passes `quiet: true` into mainImpl's own re-parse so the notice is never
// printed twice; the caller-owned COORD_MAIN_DIR path (done-worktree), which skips the preflight
// entirely, gets `quiet: false` from mainImpl and so prints it exactly as before this change (see
// main()'s header comment for the full contract). Returns `{ exitCode }` on any refusal — 2,
// matching every pre-existing usage-error exit here — else the parsed/validated state both
// callers need. `target`/`targetCategory` are undefined for a pure rename (renameOnly) — same as
// the pre-extraction inline code: the producer fills them in once the plan's current location is
// resolved.
function parseAndValidateArgs(argv, { quiet = false } = {}) {
  const { cmd: idOrName, positionals, flags } = parseArgs(argv);
  const rawTarget = positionals[0];
  const dry = argv.includes('--dry');
  const noPush = argv.includes('--no-push');
  // plan 2082: --force is the operator-directed override of the claim-holder guard.
  // Read positionally-blind like --dry (parseArgs would swallow the next token as a value).
  const force = argv.includes('--force');
  // plan 2719: --rename <new-basename>. With NO positional target it is a PURE rename —
  // the plan stays in its current lane and its body is carried over byte-identical.
  const renameRaw = flags.rename;
  const renameRequested = renameRaw !== undefined;
  const renameOnly = renameRequested && !rawTarget;
  // plan 3975 (T2b): --respec "<reason>" — see assertRespecOk's header for the contract.
  const respecRaw = flags.respec;
  const respecRequested = respecRaw !== undefined;
  if (!idOrName || (!rawTarget && !renameRequested)) {
    console.error(
      'usage: move-plan.mjs <id|basename> <target-status[/category]> [--blocked-by "<text>"] [--dry] [--no-push] [--force]\n' +
        '       move-plan.mjs <id|basename> [target-status[/category]] --rename <new-basename> [--dry] [--no-push]\n' +
        '       move-plan.mjs <id|basename> pending-approval --respec "<reason>" [--dry] [--no-push]',
    );
    return { exitCode: 2 };
  }
  // The parseArgs footgun assertBlockedByOk guards for --blocked-by: `--rename --dry`
  // swallows the next flag as the value. Catch it before anything else looks at the name.
  if (renameRequested && (!String(renameRaw).trim() || String(renameRaw).startsWith('--'))) {
    console.error(
      `move-plan: --rename got "${renameRaw ?? ''}" — looks like a flag, not a basename. ` +
        'Pass the full new basename: --rename <id>-<Category>-<slug>.md',
    );
    return { exitCode: 2 };
  }
  // plan 2678: `<status>[/<category>]`. `target` stays the STATUS for every gate, stamp
  // and message below (a category carries no lifecycle semantics); `targetCategory` only
  // ever affects where the file lands and which path the board ref/INDEX bullet names.
  // plan 2719: in --rename-only mode both stay undefined here and are filled in from the
  // plan's CURRENT location inside the producer (the plan must be resolved first). Every
  // consumer below reads them through the `targetPath()` closure or after the producer ran.
  let target;
  let targetCategory;
  try {
    if (!renameOnly) {
      const parsed = parseMoveTarget(rawTarget);
      target = parsed.status;
      targetCategory = parsed.category;
      assertOneOf(target, VALID_TARGETS, { label: 'target', prefix: 'move-plan' });
    }
  } catch (e) {
    console.error(e.message);
    return { exitCode: 2 };
  }
  // Cost is never a blocker (plan 1065): an explicit `--unblock cost` into
  // waiting-operator/ is auto-routed to ready/ — spend is governed by the drain's
  // pause-on->$5, so a cost-gated plan is safe in ready/, never an operator hold.
  // (An existing `unblock: cost` body frontmatter arriving without the flag is rejected
  // by assertUnblockOk, which points the operator here.) The redirect drops the now-moot
  // --unblock so the ready/ promotion never tries to stamp it.
  if (target === WAITING_OPERATOR_FOLDER && flags.unblock?.toLowerCase() === 'cost') {
    let notice =
      'move-plan: cost is not an operator hold — the drain gates spend (pause-on->$5). ' +
      'Routing to ready/ instead of waiting-operator/ (cost is never a blocker, plan 1065). ' +
      // plan 1260: a ready/ plan MUST carry a parseable 💰 Cost forecast banner, so if this
      // plan lacks one the ready/ promotion below will refuse it — flagged here so the notice
      // and any subsequent banner refusal read as one coherent story, not a contradiction.
      'Note: a ready/ plan must carry a 💰 Cost forecast banner.';
    // A ready/ promotion drops the Blocked-by line, so a co-supplied --blocked-by would be
    // silently lost — say so rather than discarding the operator's rationale quietly.
    if (flags['blocked-by'])
      notice += ` (The supplied --blocked-by "${flags['blocked-by']}" is dropped — a ready/ plan carries no Blocked-by line.)`;
    // plan 4136 E4: printed at most once — see this function's header for the quiet contract.
    if (!quiet) console.log(notice);
    target = READY_FOLDER;
    delete flags.unblock;
  }
  // plan 2034 (R3b): default the waiting-grill/ reason BEFORE the blocked-by gate —
  // the lane's reason is always the same, so an omitted flag is filled in rather than
  // refused. An explicit --blocked-by wins (it is already set, so this no-ops).
  if (target === WAITING_GRILL_FOLDER && !flags['blocked-by'])
    flags['blocked-by'] = GRILL_BLOCKED_BY_DEFAULT;
  // Validate the move can COMPLETE before ANY filesystem mutation (plan 486): a
  // waiting-*/ target needs a --blocked-by reason. Without this fail-fast the
  // `git mv` ran first and the downstream header-rewrite throw stranded a
  // half-applied rename (and the retry then refused "already in <target>/").
  // plan 2719: a PURE rename never touches the Blocked-by header — the plan is not
  // changing lanes, so re-supplying the reason for a lane it already rests in would be
  // pure friction (and rewriting the header a body-mutation nobody asked for).
  try {
    if (!renameOnly) {
      assertBlockedByOk(target, flags['blocked-by']);
      assertRespecOk(target, respecRaw);
    }
  } catch (e) {
    console.error(e.message);
    return { exitCode: 2 };
  }
  return {
    idOrName,
    rawTarget,
    dry,
    noPush,
    force,
    renameRaw,
    renameRequested,
    renameOnly,
    respecRaw,
    respecRequested,
    target,
    targetCategory,
    flags,
  };
}

// plan 4136 E4 (widened same-plan follow-up): the ONE list of content-only ENTRY gates,
// called from BOTH runLockFreePreflight (below) and mainImpl's in-lock producer — previously
// the producer carried its own inline copy of this same call sequence, which is exactly the
// drift the repo's minimum-tech-debt rule forbids (a gate added to one list and not the other
// silently skips the fail-fast). Every ENTRY gate that reads `(target, body, …)` is called
// with the SAME arguments and in the SAME order both callers need. Deliberately EXCLUDES the
// claim-holder guard, every --rename gate, and assertBoardInvariants — all race-sensitive or
// in-lock-only by the plan 4136 scope. `flags` is the SAME (already cost-redirect-resolved)
// flags object parseAndValidateArgs returned. Throws the SAME `fatal`-tagged Error its callee
// throws; each caller decides how to report it.
//
// Two gates the two call sites do NOT share are threaded through as options rather than
// hoisted unconditionally, so the preflight's behavior stays byte-identical to before this
// widening:
//   - `duplicateCheck`: assertGrillQuestionsNotDuplicateOk needs git history — a bounded git
//     call is fine for the fetch/show the preflight already did, but walking `git log
//     --follow` on every preflight call is a heavier ask than this gate earns, so the
//     preflight passes no callback and the check is skipped there. The producer passes
//     `() => assertGrillQuestionsNotDuplicateOk(mainDir, oldRel, body, target)`, invoked at
//     its original slot between the stale check and grill-exit.
//   - `warnCloudExec`: the READY_FOLDER-only cloudExec WARN is diagnostic stderr output the
//     producer prints once per real attempt (plan 2973) — the preflight must never print it
//     (it would fire on every lock-free pre-check, not just the attempt that proceeds), so it
//     defaults to false and only the producer opts in.
function assertContentEntryGatesOk(
  target,
  body,
  basename,
  cfg,
  flags,
  { duplicateCheck, warnCloudExec = false } = {},
) {
  assertTripConditionOk(target, body);
  assertUnblockOk(target, body, flags.unblock);
  assertBlockedByAxisTagOk(
    target,
    flags['blocked-by'],
    (flags.unblock ?? getUnblock(body) ?? '').toLowerCase(),
  );
  assertCostBannerOk(target, body, basename);
  assertSpecReviewOk(target, body, basename);
  assertEvidenceFloorOk(target, body, basename, cfg.planCategories.evidenceGated);
  // Plan 2973: WARN-only, never a refusal — see cloudExecUnstampedWarning's header for why an
  // absent cloudExec stamp is never a promotion blocker. Only on a `ready/` route: a
  // `waiting-*` park with the stamp still pending is the NORMAL mid-4c state (the spec-pass
  // now stamps cloudExec BEFORE the route), and warning there would train sessions to ignore
  // the warn.
  if (warnCloudExec && target === READY_FOLDER) {
    const cloudExecWarn = cloudExecUnstampedWarning(basename, body);
    if (cloudExecWarn) console.error(`move-plan: WARN — ${cloudExecWarn}`);
  }
  assertGrillQuestionsOk(target, body);
  assertGrillQuestionsStructureOk(target, body);
  assertGrillQuestionAxisTagsOk(target, body);
  assertGrillQuestionsNotStaleOk(target, body);
  if (duplicateCheck) duplicateCheck();
  assertGrillExitOk(target, body);
}

async function mainImpl({ quietArgParse = false } = {}) {
  const parsed = parseAndValidateArgs(process.argv.slice(2), { quiet: quietArgParse });
  if (parsed.exitCode !== undefined) return parsed.exitCode;
  const {
    idOrName,
    dry,
    noPush,
    force,
    renameRaw,
    renameRequested,
    renameOnly,
    respecRaw,
    respecRequested,
    flags,
  } = parsed;
  let target = parsed.target;
  let targetCategory = parsed.targetCategory;
  // Validate before any move, including --force. Resolving inside the claim-read catch
  // would incorrectly downgrade ambiguity to “proceeding unguarded”.
  const coordinationId = coordinationSessionId();
  // The status-rooted destination directory — recomputed rather than captured, because
  // the cost redirect (inside parseAndValidateArgs) can reassign `target`, and the
  // renameOnly branch in the producer below reassigns it again once resolved.
  const targetPath = () => (targetCategory ? `${target}/${targetCategory}` : target);

  const mainDir = resolveMain();
  const cfg = loadCoordConfig(mainDir);
  const date = new Date().toISOString().slice(0, 10);

  // plan 2082: the claim-holder guard runs at most once per invocation (see its
  // comment in the producer below) — withRetry re-enters the producer on non-ff races.
  let claimGuardChecked = false;
  // plan 2719: the rename claim gate's own latch. Separate from claimGuardChecked because
  // the two gates ask different questions (any hold vs a FOREIGN hold) and latch on
  // different outcomes — this one only latches on a proven-free ref, so a failed read is
  // re-attempted rather than treated as settled.
  // plan 2082 (review r6): ONE computation of the board-row sync, shared by the --dry
  // preview and the real run, so the preview can never diverge from what the run does.
  // Returns null when the board is untouched (frozen target / no board file / no
  // matching row), else { content, rows, abs }.
  const boardSyncFor = ({ basename, newRel }) => {
    if (target === ARCHIVE_FOLDER || target === PARKED_FOLDER) return null;
    const abs = join(mainDir, cfg.paths.boardFile);
    if (!existsSync(abs)) return null;
    const s = syncBoardPlanRefs(readFileSync(abs, 'utf8'), {
      oldBasename: basename,
      newBasename: newRel.split('/').pop(),
      // plan 2678: the FULL destination path (`parked/denmark`), not the bare status —
      // a board ref must name the file an operator can actually open, and lint-board's
      // BOARD_SUBFOLDER_DRIFT compares it against the real on-disk location.
      target: targetPath(),
    });
    return s.changed ? { ...s, abs } : null;
  };

  const result = await withRetry(
    () => {
      // ff-sync resilient to the transient "Cannot fast-forward to multiple branches"
      // FETCH_HEAD race (plan 868) — fetch + `merge --ff-only origin/master`, retried.
      ffMasterFromOrigin(mainDir);
      const plans = lsPlans(mainDir);
      const oldRel = resolvePlanRel(plans, idOrName);
      const basename = oldRel.split('/').pop();
      const fromStatus = statusOf(oldRel);
      // plan 2719: a pure rename's destination IS the plan's current location — derived
      // here, after resolution, because nothing before this point knows where it sits.
      if (renameOnly) {
        const here = classifyPlanRel(oldRel.slice(PLANS_PREFIX.length));
        target = here.statusFolder;
        targetCategory = here.category;
      }
      let newRel = `${PLANS_PREFIX}${targetPath()}/${basename}`;
      // plan 2678: compare the FULL location, not just the status — re-clumping inside
      // one status (`ready/` → `ready/infra/`, or `parked/denmark/` → `parked/`) is a
      // legitimate move that a status-only check would refuse as a no-op.
      // plan 2719: exempt when a rename is requested — the file IS changing name, so
      // same-folder is the normal case, not a no-op (the no-op rename is caught below).
      if (!renameRequested && statusPathOf(oldRel) === targetPath())
        throw Object.assign(new Error(`move-plan: ${basename} is already in ${targetPath()}/`), {
          fatal: true,
        });
      // Body-state gates (plan 619) — run in the producer, BEFORE the irreversible
      // `git mv` in the pushFn, so a missing trip-condition / unblock field never
      // strands a half-applied rename (the plan-486 fail-before-mv discipline,
      // extended to the body-dependent checks). The folder is the state machine; the
      // body must be able to agree with it before we commit to the move.
      let body = readFileSync(join(mainDir, oldRel), 'utf8');
      // plan 2719: a PURE rename runs none of them. Each is an ENTRY gate on a lane the
      // plan is not entering — it already rests there — so firing them here would turn a
      // naming fix into a retroactive lane audit and refuse, say, renaming a ready/ plan
      // whose cost banner predates that gate. A move+rename (an explicit target) is an
      // ordinary move and runs every gate unchanged.
      if (!renameOnly) {
        // plan 4136 (widened): routed through the SAME assertContentEntryGatesOk the
        // lock-free preflight calls above — this used to be a second inline copy of the
        // same 11-gate sequence, which is exactly the drift the repo's minimum-tech-debt
        // rule forbids (a gate added to one list and not the other silently skips the
        // fail-fast). `duplicateCheck` threads assertGrillQuestionsNotDuplicateOk in at its
        // original slot (needs `mainDir`/`oldRel` git history, unlike its content-only
        // siblings, so it can't be a plain unconditional call inside the shared helper).
        // `warnCloudExec` opts this call site into the READY_FOLDER-only cloudExec WARN
        // (plan 2973) — runs on every retry attempt inside this producer (withRetry
        // re-enters on a non-ff race), a harmless duplicate stderr line on the rare race,
        // never a correctness issue since this never gates anything; the preflight passes
        // neither option, so it stays silent and skips the duplicate check exactly as
        // before this change.
        assertContentEntryGatesOk(target, body, basename, cfg, flags, {
          duplicateCheck: () => assertGrillQuestionsNotDuplicateOk(mainDir, oldRel, body, target),
          warnCloudExec: true,
        });
      }
      // The producer must see the same ready-only Tier-0 backfill as the consumer
      // below: this copy determines newRel before git mv and records whether the dry
      // preview should describe the backfill, while the second copy writes the matching
      // frontmatter. The pure keepExisting helper is intentionally idempotent, so
      // applying it at both call sites keeps rename and body atomic.
      let exemptSolBackfill = false;
      if (target === READY_FOLDER && !renameOnly) {
        const backfilled = ensureExecModelForExemptMechanical(body);
        exemptSolBackfill = backfilled !== body;
        body = backfilled;
      }
      // plan 2082: claim-holder guard — refuse to move a plan whose refs/claims/<id>
      // is held by ANOTHER session (see claimHolderError above). Runs in the producer,
      // AFTER the cheap body gates (their failures shouldn't cost a remote read) and
      // BEFORE the irreversible `git mv`. At most one SUCCESSFUL read per invocation:
      // the flag latches only after planStatus returns (review r4/r7 — withRetry
      // re-runs the producer on every non-ff race and the verdict from a good read
      // stays valid, while a FAILED read leaves the flag unset so the next attempt
      // re-tries the guard instead of staying disarmed). The id derives via the SAME
      // shared claimedIdOfBasename resolvePlanRel uses (review r3/r9 — never a
      // re-rolled copy of the date-exclusion). A transient claim-read failure WARNS
      // and proceeds (fail-open): the guard is coordination defense-in-depth, and a
      // genuinely dead remote fails the push right after. --dry still READS (the dry
      // producer already fetches via ffMasterFromOrigin, so dry was never
      // network-free) but reports a would-refuse as a loud preview line instead of a
      // fatal throw — a preview must neither refuse nor false-clean (review r5/r10).
      if (!force && !claimGuardChecked) {
        // plan 3973 review fix (round 2, R1): the read half now lives in the shared
        // readClaimHolderStatus (see its header) — this block keeps only what was always
        // move-plan-specific: the --force skip above, the latch, and the message/dry/
        // self-held/terminal-park handling below. Byte-identical behaviour to pre-fix.
        const { claimsId, status, readFailed } = readClaimHolderStatus(mainDir, basename, {
          selfId: coordinationId,
          // Round-4 review (finding 63afe7): WONTFIX — this fires only from the read-FAILURE
          // branch (planStatus itself threw), where which namespace holds the claim is
          // unknown by construction (the read that would have told us is exactly what
          // failed). `claimRef(id)` — the canonical new-namespace spelling — is the right
          // name to print here, unlike the held-claim message above, which now has a real
          // verdict (`status.ref`) to name instead.
          warn: (e, id) =>
            console.error(
              `move-plan: WARN — claim-holder read failed for ${claimRef(id)} ` +
                `(${shortErr(e)}); proceeding unguarded.`,
            ),
        });
        if (!claimsId) {
          claimGuardChecked = true; // no claimable id (legacy dated basename) — nothing to guard
        } else if (!readFailed) {
          claimGuardChecked = true;
          const err = claimHolderError(status, {
            basename,
            selfIdKnown: Boolean(coordinationId),
          });
          if (err) {
            if (dry) console.error(`[dry] claim guard: the real run would REFUSE — ${err}`);
            else throw fatal(err);
          } else if (status.held && status.youAreHolder && !renameRequested) {
            // plan 2719 review, finding [3]: SUPPRESSED for a rename. This note promises
            // "the move proceeds", but the stricter rename claim gate below refuses a
            // self-held claim outright — printing both produced a contradictory stderr
            // that read as success-then-failure. The rename gate owns the verdict there.
            // [dry]-prefixed in preview mode (review r11) so a scraped stderr can
            // never mistake the preview's advisory for a real move's confirmation.
            console.error(
              // Round-3 review fix (finding 06453e): name the ref namespace the dual-read
              // ACTUALLY found (status.ref, set by readClaimHolderStatus above), never a
              // hardcoded refs/claims/<id> — wrong once a self-held claim has moved to the
              // branch-shaped namespace.
              `${dry ? '[dry] ' : ''}move-plan: note — you hold ${status.ref ?? claimRef(claimsId)} yourself; ` +
                `the move ${dry ? 'would proceed' : 'proceeds'} and the claim stays held ` +
                `(release it separately if the plan is leaving your hands).`,
            );
            // plan 2818: additive WARN-only nudge, self-held claim moving into a TERMINAL
            // park lane specifically — a held claim there does not help the eventual
            // adopter (cut-worktree.mjs's --adopt gate refuses a claim held by another
            // session at any age regardless), it only leaves the plan reading 🔒 CLAIMED
            // to every drain and forces every later body edit through --claimed-override.
            // stderr only; exit code and every behavioural path stay unchanged — move-plan
            // is coordination machinery and a new failure mode here is out of scope.
            if (TERMINAL_PARK_TARGETS.has(target)) {
              console.error(
                `${dry ? '[dry] ' : ''}move-plan: WARN (plan 2818) — this is a terminal park ` +
                  `into ${target}/; a terminal park releases its claim so the plan does not ` +
                  `read 🔒 CLAIMED to every drain and the adopter does not need --force: ` +
                  `run \`node scripts/release-claim.mjs release ${claimsId}\`.`,
              );
            }
          }
        }
      }
      // plan 1362 (D2): auto-stamp the FABLE- filename segment as PART of this same
      // move when the plan's execModel is fable and the basename doesn't already
      // carry it (a legacy plan, or one whose spec-pass ran post-mint) — never for
      // an in-progress/archive target (canRenameForStatus mirrors stamp-exec-model's
      // restriction). Folded into `newRel` itself so the single `git mv` below
      // performs BOTH the status move and the stamp in one rename.
      // plan 2719: the rename gates. All four run BEFORE the irreversible `git mv` (the
      // plan-486 fail-before-mv discipline) and are NOT waivable by --force: unlike the
      // claim-holder guard above (a coordination judgment an operator may legitimately
      // override), each of these is a mechanical breakage — a rename that lands anyway
      // leaves a branch/queue/claim keyed on a filename that no longer exists, an INDEX
      // reference nothing resyncs, or two plans fighting over one basename.
      if (renameRequested) {
        const newBasename = String(renameRaw).trim();
        const laneErr = renameLaneError(fromStatus, target, basename);
        if (laneErr) throw fatal(laneErr);
        if (newBasename === basename)
          throw fatal(
            `--rename is a no-op — ${basename} already has that name.` +
              (renameOnly ? '' : ' Drop --rename to move it without renaming.'),
          );
        // plan 2719 review, finding [2]: claimedIdOfBasename ONLY — no `/^(\d{3,})/` fallback.
        // That fallback defeated the very exclusion the helper exists to encode: a dateless
        // legacy basename like `2026-05-17-legacy-note.md` has NO plan id, and the fallback
        // read its YEAR as one, then probed the unrelated `refs/claims/2026`. A null verdict
        // here is the honest answer, and it is exactly what the message below already promised.
        const oldId = claimedIdOfBasename(basename);
        if (!oldId)
          throw fatal(
            `--rename cannot determine the plan id of "${basename}" (a legacy dated ` +
              'basename has none) — rename it by hand or leave it as historical.',
          );
        const { errors, warnings } = planRenameGrammar(newBasename, {
          expectedId: oldId,
          allowlist: cfg.planCategories.allowlist,
          countryTokenHints: cfg.planNaming.countryTokenHints,
          stageTokens: cfg.planNaming.stageTokens,
        });
        for (const w of warnings) console.error(`move-plan: WARN — ${w}`);
        if (errors.length)
          throw fatal(
            `--rename refused, the new name violates the plan-2329 naming grammar:\n` +
              errors.map((e) => `  - ${e}`).join('\n'),
          );
        const collision = plans.find((p) => p.split('/').pop() === newBasename);
        if (collision)
          throw fatal(`--rename refused — ${newBasename} already exists at ${collision}.`);
        // plan 2719 review, findings [0] + [4]: the supplied basename must ALREADY agree with
        // the plan's execModel, checked pre-flight against the same two helpers the write path
        // uses. Without this the plan-1362 FABLE- auto-stamp a few lines below silently
        // rewrote the destination away from the name the operator typed and this gate had just
        // validated ([0]), and the reverse mismatch — a FABLE- segment typed onto a non-fable
        // plan — sailed past the grammar and died AFTER the `git mv` on
        // assertExecModelFilenameOk's "should be unreachable" internal error, exit 1 ([4]).
        // A rename is an explicit naming act: what you type is what lands, or you are told the
        // exact string to type instead. (Both refusals name it, so the fix is one copy-paste.)
        const candidateRel = `${PLANS_PREFIX}${targetPath()}/${newBasename}`;
        const wouldStamp = canRenameForStatus(target)
          ? stampedRelForExecModel(candidateRel, body)
          : null;
        if (wouldStamp) {
          // plan 3341 fix: name the plan's ACTUAL execModel/marker instead of assuming
          // "fable" — this used to say "execModel: fable" even for a sol plan.
          const wantLane = readExecModel(body);
          const wantSeg = LANE_SEGMENTS.find((s) => s.lane === wantLane);
          throw fatal(
            `--rename refused — this plan is execModel: ${wantLane}, so its basename carries the ` +
              `${wantSeg?.marker ?? ''} segment. Pass ${wouldStamp.split('/').pop()} instead of ${newBasename}.`,
          );
        }
        try {
          assertExecModelFilenameOk(candidateRel, body);
        } catch {
          // plan 3341 fix: report WHICHEVER marker the offered basename actually carries
          // (FABLE- or SOL-) rather than assuming FABLE- — the two are mutually exclusive
          // by construction (lint-filename-execmodel-drift.mjs), so at most one matches.
          const gotSeg = LANE_SEGMENTS.find((s) => s.test(newBasename));
          throw fatal(
            `--rename refused — ${newBasename} carries a ${gotSeg?.marker ?? '(unrecognized)'} ` +
              `exec-model segment, but this plan's frontmatter execModel is not ` +
              `${gotSeg?.lane ?? '(that lane)'}. Drop the segment (or fix execModel ` +
              `first with edit-plan.mjs) — the filename segment and the frontmatter must agree.`,
          );
        }
        // The claim gate is STRICTER than the claim-holder guard above and fails CLOSED.
        // Stricter: ANY held claim refuses, self-held included — a claim you hold yourself
        // still means a live worktree, branch and queue slug keyed on this basename, which
        // a rename would orphan (the holder-guard's self-held carve-out is about re-filing,
        // which keeps the filename intact). Fail-closed: an unreadable claim ref cannot be
        // treated as "probably free" when the cost of being wrong is another session's
        // wedged worktree, so a failed read refuses instead of warning through.
        // In --dry this reports rather than throws, matching the holder guard's r5/r10
        // contract (a preview of REMOTE state must neither refuse nor false-clean); the
        // three gates above are argument-shaped and refuse in --dry too, because there is
        // no coherent preview to print for a malformed rename.
        // DELIBERATELY UN-LATCHED, unlike the holder guard above — this block re-reads the
        // ref on EVERY producer attempt. Two review rounds landed on that: reusing the holder
        // guard's earlier result (round 2, finding [7]) and then latching after the first
        // successful read (round 3, finding [0]) each reopened the same window. withRetry
        // re-enters the producer on a non-ff push, so a latch means attempt 2 does the
        // irreversible `git mv` on attempt 1's verdict — and in between, a sibling
        // `pickup-plan` can have stood up a worktree, branch and landing-queue slug keyed on
        // the OLD basename, which the rename then silently orphans. "Immediately before the
        // mv" is the whole property; one extra ls-remote per attempt on a rare,
        // operator-driven command is its correct price. Do not add a latch back.
        {
          // Round-4 review fix (findings 60d384/052190/fb3ed5/f0edad/780ab4/92e4dc): read via
          // the shared dual-read helper (same one the holder guard above uses) instead of a
          // bare `planStatus`, so this refusal can name `st.ref` — whichever namespace the
          // read ACTUALLY found the claim under — rather than hardcoding `claimRef(oldId)`
          // (always the new `refs/heads/coord/claims/<id>` spelling, wrong for a legacy
          // `refs/claims/<id>` claim). Still a fresh call every producer attempt (the
          // DELIBERATELY-UN-LATCHED property above is about WHEN this reads, not which
          // function it calls) and still fails CLOSED on a read failure — `readFailed` maps
          // to the same refusal the old catch produced. A read-FAILURE's namespace is unknown
          // by construction (round-4 finding 63afe7's WONTFIX applies here too), so that branch
          // keeps naming the canonical `claimRef(oldId)`.
          let heldErr = null;
          let readErr = null;
          const { status: st, readFailed } = readClaimHolderStatus(mainDir, basename, {
            selfId: coordinationId,
            warn: (e) => {
              readErr = e;
            },
          });
          if (readFailed) {
            heldErr =
              `--rename cannot read ${claimRef(oldId)} ` +
              `(${shortErr(readErr)}) — refusing rather than ` +
              'renaming a possibly-claimed plan out from under its holder. Retry when the remote is reachable.';
          } else if (st.held) {
            const who = describeClaimHolder(st);
            const self = st.youAreHolder
              ? ' — that is YOU, and it still refuses: the worktree, branch and landing-queue ' +
                'slug all key on the basename'
              : '';
            const ref = st.ref ?? claimRef(oldId);
            heldErr =
              `--rename refuses ${basename} — ${ref} is HELD by ${who}${self}. ` +
              "Rename an UNCLAIMED plan (plan 2329's carve-out); release a dead session's claim first: " +
              `node scripts/release-claim.mjs release ${oldId} --force`;
          }
          if (heldErr) {
            if (dry)
              console.error(`[dry] rename claim gate: the real run would REFUSE — ${heldErr}`);
            else throw fatal(heldErr);
          }
        }
        newRel = candidateRel;
      }
      // plan 2719 fix-pass re-review, finding [1]: skipped for a rename — the block above
      // already proved stampedRelForExecModel returns null for this exact rel (it refuses
      // otherwise), so re-running it here is a guaranteed no-op and a second place to keep
      // in step with the first.
      if (!renameRequested && canRenameForStatus(target)) {
        const stamped = stampedRelForExecModel(newRel, body);
        if (stamped) newRel = stamped;
      }
      // plan 2587 re-review finding: carry the body the producer ALREADY read (and ran five
      // asserts against) through to the consumer, so the --dry preview below reads the same
      // bytes the real write will stamp instead of taking a second, independent read off disk.
      return { oldRel, newRel, basename, fromStatus, body, exemptSolBackfill };
    },
    (plan) => {
      const { oldRel, newRel, basename, fromStatus, body: srcBody, exemptSolBackfill } = plan;
      const env = { ...process.env, HUSKY: '0' };
      const absOld = join(mainDir, oldRel);
      const absNew = join(mainDir, newRel);
      const renamedTo = newRel.split('/').pop();
      // plan 2719: a pure rename's subject says what actually happened — "move X ready/ →
      // ready/" would read as a no-op in the log. A move+rename keeps the move subject and
      // names the rename in parentheses.
      const msg = renameOnly
        ? `docs(plans): rename ${basename} → ${renamedTo} (${targetPath()}/)`
        : `docs(plans): move ${basename} ${statusPathOf(oldRel)}/ → ${targetPath()}/` +
          (renamedTo === basename ? '' : ` (renamed to ${renamedTo})`);
      // Stamp the Coord-Write trailer so lint-coord-trailer.mjs (plan 421) accepts
      // this INDEX-regenerating commit. move-plan keeps its own rename-aware
      // commit/rollback (a deleted source + gitignored archive/ dest don't fit
      // coordWrite's generic add/restore — verified), but it IS a sanctioned coord
      // tool, so it carries the trailer like the coordWrite-routed tools.
      const commitMsg = `${msg}\n\n${COORD_TRAILER}: move-plan`;

      if (dry) {
        console.log(`[dry] git mv ${oldRel} ${newRel}`);
        let bodyDesc;
        if (renameOnly) {
          // plan 2719: same branch order as the real write below — a pure rename is a
          // plain move, so the preview must not promise any stamp.
          bodyDesc = 'body untouched (pure rename — the plan does not change lane)';
        } else if (isWaitingFolder(target)) {
          bodyDesc = `set Blocked-by: "${flags['blocked-by']}"`;
          if (target === WAITING_OPERATOR_FOLDER && flags.unblock)
            bodyDesc += ` + set unblock: ${flags.unblock}`;
        } else if (target === ARCHIVE_FOLDER) {
          bodyDesc = 'Status → ✅ COMPLETED, drop stale Blocked-by';
        } else if (target === PARKED_FOLDER) {
          bodyDesc = 'body untouched (plain move — parked/ is a freeze, not a stamp)';
        } else if (target === PENDING_APPROVAL_FOLDER && respecRequested) {
          bodyDesc =
            `Status → 📋 STUB re-spec stamp; withdraw stage: specced + specReview + ` +
            `specReviewBy (--respec: "${respecRaw}")`;
        } else {
          // plan 2587 review finding (CONFIRMED): this preview used to hardcode `📋 READY`
          // while the real write below calls the now stage-aware stampPromotedStatus, so a
          // `stage: stub` + `specReview: exempt-mechanical` promotion (which assertSpecReviewOk
          // legitimately permits) was previewed as READY and then written as STUB. Derive the
          // token from the SAME shared helper the real write uses so the two cannot diverge.
          const dryToken =
            target === IN_PROGRESS_FOLDER ? '🔄 IN PROGRESS' : statusTokenForStage(srcBody);
          bodyDesc = `Status → ${dryToken} promotion stamp, drop stale Blocked-by`;
        }
        console.log(`[dry] rewrite body: ${bodyDesc}`);
        if (exemptSolBackfill)
          console.log(
            `[dry] rewrite body: backfill execModel: ${EXEMPT_MECHANICAL_DEFAULT_LANE} for exempt-mechanical`,
          );
        // plan 3111: the preview must name the adopt-stamp sync for the same reason the board-row
        // preview below does — a preview that silently omits a body write the real run performs is
        // the plan-2587 divergence class. Resolved for REAL here (one `ls-remote`), not guessed:
        // a dry run that reported "would stamp" while the real run finds nothing on origin (or vice
        // versa) would be exactly the wrong kind of preview.
        if (!renameOnly && target === READY_FOLDER) {
          const dryId = planIdFromBasename(basename);
          const dryMap = dryId ? originExecutedPlanIds(mainDir) : new Map();
          // An UNREADABLE origin (null) is previewed as 'unavailable', never as "no branches
          // found" — the same distinction the real path is built around. Collapsing the two here
          // would preview a STRIP of a live hand-off stamp that the real run would never perform.
          // plan 3767 (gpt-review round 2): resolve through the SHARED resolver, exactly as
          // syncAdoptBranchStamp (the real run, below) does — a local map-to-names here would
          // skip the same-sha collapse and preview `ambiguous` for a pair the real run resolves,
          // which is precisely the divergence this block's own comment forbids.
          // plan 3767 (gpt-review round 3): an id-less plan (a legacy date-slugged basename) is a
          // 'noop', never an empty branch list. The real run reaches `syncAdoptBranchStamp`,
          // which has no id to look up and changes nothing — while previewing `[]` here would
          // report a STRIP of an existing `adoptBranch:` stamp that the real run never performs.
          // Same divergence this block's own comment forbids, one case further out.
          const dryResolved =
            dryMap && dryId ? resolveAdoptBranchNames(dryMap.get(dryId) ?? [], srcBody) : null;
          const dryAdopt = !dryMap
            ? { action: 'unavailable', branch: null, branches: [] }
            : !dryResolved
              ? { action: 'noop', branch: null, branches: [] }
              : dryResolved.keepStamp
                ? { action: 'noop', branch: dryResolved.keepStamp, branches: dryResolved.names }
                : applyAdoptBranchStamp(srcBody, dryResolved.names);
          console.log(`[dry] adopt stamp: ${describeAdoptAction(basename, dryAdopt)}`);
        }
        // plan 2082: preview the board-row path sync — same computation as the real
        // run (boardSyncFor), so the preview can never diverge from what the run does.
        const dryBoardSync = boardSyncFor(plan);
        if (dryBoardSync)
          console.log(
            `[dry] board row sync: ${dryBoardSync.rows} row(s) in ${cfg.paths.boardFile} → ${targetPath()}/${newRel.split('/').pop()}`,
          );
        console.log(`[dry] regenerate docs/INDEX.md (in-process)`);
        console.log(`[dry] commit: ${msg}`);
        console.log(`[dry] ${noPush ? 'skip push' : 'git push origin master'}`);
        return { ...plan, dry: true };
      }

      // Snapshot oldRel's WORKING-TREE bytes BEFORE the `git mv` removes it from disk
      // (plan 492). `git mv` carries any uncommitted edit on the plan body into newRel,
      // but the non-ff rollback below must NOT `checkout HEAD -- oldRel` (that overwrites
      // the working tree with HEAD, discarding the edit — the true plan-478 data loss).
      // We restore these exact bytes instead, so the retry's `git mv` re-carries the edit.
      const oldBytes = readFileSync(absOld);
      // plan 1452/1475 (item 2): git mv does NOT create the destination directory, and git
      // cannot track an empty one — so a status lane that has never held a file (a fresh
      // parked/, a sibling's still-empty archive/) is absent from the checkout until the first
      // file lands. coord-git's shared ensureMvDestDir mkdirs it (recursive, idempotent) against
      // the SAME tree the mv runs in (mainDir — the disposable coord-checkout in the standalone
      // path, or done-worktree's ephemeral worktree via COORD_MAIN_DIR).
      ensureMvDestDir(mainDir, newRel);
      gitWithLockRetry(mainDir, ['mv', oldRel, newRel]);
      // plan 1175/1184: after archiving, remove any stale untracked same-basename copy
      // that remained in a non-archive subfolder (shared helper — plan 1184 extraction).
      if (target === ARCHIVE_FOLDER) {
        deleteStaleArchiveDups(mainDir, basename);
      }
      // Belt-and-suspenders (plan 486): wrap the WHOLE post-`git mv` body so ANY
      // throw — header rewrite, build-index, add, commit, OR push — runs the
      // path-scoped rollback. Before this, only a push failure rolled back, so a
      // downstream throw stranded the staged rename in the shared $MAIN tree.
      let committed = false;
      // plan 2082: whether THIS attempt rewrote the board file (drives the commit
      // pathspec + the rollback below). Declared out here so the catch can see it.
      let boardTouched = false;
      const boardRel = cfg.paths.boardFile;
      try {
        // Body-state rewrite (plan 619): make the BODY agree with the destination
        // folder, not just the path. waiting-*/ keeps its narrative + gets the
        // Blocked-by line (+ unblock for waiting-operator); a promotion drops the
        // stale Blocked-by and stamps a fresh Status; archive stamps ✅ COMPLETED.
        let body = readFileSync(absNew, 'utf8');
        if (renameOnly) {
          // plan 2719: a PURE rename is a plain move (the parked/ branch's discipline) —
          // the plan is not changing lane, so it collects no promotion stamp, no rewritten
          // Blocked-by header, nothing. Body carried over byte-identical.
        } else if (isWaitingFolder(target)) {
          body = rewriteBlockedByHeader(body, target, flags['blocked-by'], {
            seedLane: cfg.seedLane,
          });
          if (target === WAITING_OPERATOR_FOLDER && flags.unblock !== undefined)
            body = setUnblock(body, flags.unblock);
        } else if (target === ARCHIVE_FOLDER) {
          body = stampArchivedStatus(body, { date, via: 'move-plan' });
        } else if (target === PARKED_FOLDER) {
          // plain move (plan 1426): parked/ is a deliberate long-term freeze, not a
          // promotion/demotion — never adopt archive's ✅-COMPLETED stamp or any other
          // terminal treatment. Body is carried over byte-identical.
        } else if (target === PENDING_APPROVAL_FOLDER && respecRequested) {
          // plan 3975 (T2b): --respec — withdraw the spec-pass stamps and reset to the
          // stub shape D7 admits, in the SAME write as the move. See respecToPendingApproval's
          // header for why this is neither a promotion nor a plain move.
          body = respecToPendingApproval(body, { fromStatus, date, reason: respecRaw });
        } else {
          body = stampPromotedStatus(body, { target, fromStatus, date });
        }
        // See the producer comment above: this is the write-side half of the same
        // ready-promotion transform; the producer's flag also drives the dry preview.
        // This remains a no-op after the producer backfill.
        if (target === READY_FOLDER && !renameOnly) body = ensureExecModelForExemptMechanical(body);
        writeFileSync(absNew, body);
        // plan 3111: writer 1 of 3 into ready/. Bring the `adoptBranch:` stamp into agreement with
        // what origin actually carries, in the SAME commit as the move — so a plan re-filed to
        // ready/ with a live unfinished branch is selectable by a cloud drain (stamped), and a plan
        // whose branch has since landed does not carry a dead pointer (stripped). Runs AFTER the
        // body write above because the authority mutates the FILE, and its change must be the one
        // the pathspec commit below captures.
        //
        // Deliberately NOT latched across withRetry attempts (unlike the claim-holder guard below):
        // a non-ff retry re-runs `git mv` from the freshened base, so the file is rebuilt and the
        // stamp would be LOST if this were skipped. One `ls-remote` per attempt is the same order
        // of cost as the claim read that already runs here.
        //
        // Never gates: an unreachable origin returns 'unavailable' and changes nothing (a re-file
        // must not be bricked by a blip), and the authority itself never throws.
        if (!renameOnly && target === READY_FOLDER) {
          const adopt = syncAdoptBranchStamp(mainDir, newRel);
          if (adopt.action !== 'noop')
            console.error(`move-plan: adopt stamp — ${describeAdoptAction(basename, adopt)}`);
        }
        // Belt-and-suspenders (plan 1362, D2): the FABLE- stamp (if any) was already
        // folded into `newRel` above — re-confirm the written file agrees, via the
        // SAME check the pre-push lint runs. Should be unreachable.
        assertExecModelFilenameOk(newRel, body);
        // plan 2082: board-row path sync — rewrite any board-row Plan/claim ref still
        // pointing at the plan's OLD subfolder (or old basename, on a same-move FABLE
        // rename) so this ONE move commit leaves board ↔ plans consistent, instead of
        // manufacturing the BOARD_SUBFOLDER_DRIFT that blocks every session's push
        // (the plan-2077 incident). Skipped for archive/parked — a frozen plan's row
        // must be REMOVED (the close-out ritual), not repointed; see syncBoardPlanRefs.
        // No board file / no matching row → byte-identical no-op. Shared computation
        // with the --dry preview (boardSyncFor).
        const synced = boardSyncFor(plan);
        if (synced) {
          writeFileSync(synced.abs, synced.content);
          boardTouched = true;
          console.log(
            `move-plan: board row sync — ${synced.rows} row(s) in ${boardRel} repathed to ${targetPath()}/`,
          );
        }
        // Regenerate docs/INDEX.md IN-PROCESS (plan 926) — NOT by spawning `node build-index.mjs`.
        // The spawn opened a WIDE window (a full child-process lifetime) between build-index's
        // writeFileSync and the pathspec commit below — which re-reads the WORKING TREE for
        // docs/INDEX.md — during which a parallel coord process on the shared main checkout could
        // forcibly overwrite the working-tree docs/INDEX.md (a sibling coordWrite rollback's
        // `git restore`, a sibling build-index's writeFileSync, a sibling move-plan rollback's
        // `git checkout`), so the commit captured a STALE INDEX (the moved file in its new folder
        // but its bullet in the old). In-process regen shrinks the window to consecutive
        // synchronous git calls; the post-move healIndexDrift (in main(), below) is the backstop
        // that closes the microsecond residual for ALL callers.
        //
        // Why not stage the exact bytes via `git hash-object | git update-index` (plan 926's
        // candidate approach 2)? The commit below is INTENTIONALLY a pathspec commit
        // (`commit -- oldRel newRel docs/INDEX.md`) so it never sweeps a parallel session's
        // unrelated staged work into this move. A pathspec commit RE-READS THE WORKING TREE for
        // its paths — so a staged blob would be overridden by the working-tree file anyway, and
        // committing the staged blob instead would mean dropping the pathspec (committing the
        // whole index, foreign staged changes included) or rebuilding the commit from an explicit
        // tree — both of which would require rewriting move-plan's hardened rename
        // commit/rollback flow (plans 478/486/492/819/868). In-process regen + the bounded,
        // idempotent post-move heal gets the same guarantee at far lower blast radius.
        writeFileSync(join(mainDir, 'docs/INDEX.md'), regenerateIndex(mainDir));
        // -f: HISTORICAL — the `archive/` .gitignore rule used to be unanchored and
        // matched plans/archive/ at any depth, so a plain `git add` of the moved file
        // was rejected ("paths ignored by one of your .gitignore files; Use -f") and
        // the whole re-file bailed, silently stranding the doc in its old folder (what
        // left plan 256 in in-progress/ after its 2026-05-31 done-worktree). The rule
        // is root-anchored (`/archive/`) now, so nothing under docs/ is ignored — the
        // -f stays as harmless belt-and-suspenders for any future ignore-rule drift.
        // This add also re-stages the rename after the Blocked-by rewrite and stages
        // the regenerated INDEX.
        // plan 2082: the board file joins the add + pathspec commit ONLY when this
        // attempt actually rewrote it — the one-invocation-one-commit ritual now
        // carries plan file + INDEX + board row atomically.
        // plan 2378 step 2: board invariants against the post-mutation tree, BEFORE the
        // add/commit/push — this tool's push runs no git hooks either (it pushes from the
        // disposable coord-checkout; mechanism in board-write-gate.mjs's header). A throw
        // here lands in the catch below, which rolls the tree back path-scoped and
        // surfaces the message verbatim, so a refused move leaves nothing half-applied.
        //
        // This never fights move-plan's own repair role: a move INTO a waiting-*/ lane is
        // out of the LIVE bucket's folder scope by construction, and a promotion into
        // ready//in-progress/ has already run stampPromotedStatus → dropBlockedBy a few
        // lines above, so the line the gate would object to is gone before it looks. What
        // it DOES catch is a move that would park a `stage: specced` plan in
        // pending-approval/ — the same invariant the pre-push lint checks, applied here at
        // the moment the state is written instead of to whoever pushes next.
        assertBoardInvariants(mainDir, [newRel], { tool: 'move-plan' });
        const extraPaths = boardTouched ? [boardRel] : [];
        gitWithLockRetry(mainDir, ['add', '-f', '--', newRel, 'docs/INDEX.md', ...extraPaths]);
        gitWithLockRetry(
          mainDir,
          ['commit', '-m', commitMsg, '--', oldRel, newRel, 'docs/INDEX.md', ...extraPaths],
          {
            env,
          },
        );
        committed = true;

        if (noPush) return { ...plan, pushed: false };
        // plan 971: 'master' on the main checkout, 'HEAD:master' when move-plan runs in
        // done-worktree's detached finish worktree (COORD_MAIN_DIR — the ambiguous
        // carry-forward → waiting-operator mint path on the post-merge close-out).
        git(mainDir, ['push', 'origin', masterPushSpec(mainDir, env)], { env });
        return { ...plan, pushed: true };
      } catch (e) {
        const out = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
        // Path-scoped rollback (never nukes a sibling session's uncommitted work).
        // Commit-aware: only undo OUR commit when we actually made one — a blind
        // `reset --soft HEAD~1` on a pre-commit throw would discard a sibling's
        // commit / the pull's merge that legitimately advanced HEAD.
        if (committed) gitWithLockRetry(mainDir, ['reset', '--soft', 'HEAD~1']);
        // Restore oldRel's INDEX entry to HEAD (un-stage the rename's delete side) WITHOUT
        // touching its working tree, then write back the snapshot bytes — preserving any
        // uncommitted edit `git mv` had carried (plan 492). A blanket `checkout HEAD --
        // oldRel` here is what silently dropped the plan-478 scope note: it overwrote the
        // working tree with HEAD content. docs/INDEX.md is regenerated each attempt, so
        // reverting IT to HEAD is correct (and necessary to leave a clean-enough tree for
        // the next attempt's `pull --ff-only`).
        gitWithLockRetry(mainDir, ['reset', '-q', '--', oldRel]);
        gitWithLockRetry(mainDir, ['reset', '-q', '--', newRel]);
        rmSync(absNew, { force: true });
        writeFileSync(absOld, oldBytes);
        gitWithLockRetry(mainDir, ['checkout', 'HEAD', '--', 'docs/INDEX.md']);
        // plan 2082: the board rewrite is deterministic from HEAD content (this tool
        // runs in a clean coord-checkout / ephemeral worktree), so HEAD-restore is the
        // correct undo — same rationale as docs/INDEX.md above. Guarded: only when THIS
        // attempt actually wrote it.
        if (boardTouched) gitWithLockRetry(mainDir, ['checkout', 'HEAD', '--', boardRel]);
        // A throw AFTER the commit can only be the push → preserve the original
        // non-ff (retried by withRetry) vs pre-push-hook (surfaced) disambiguation.
        if (committed) {
          if (isNonFastForward(e))
            throw Object.assign(new Error('non-ff'), { nonFastForward: true });
          throw new Error(
            `move-plan: push rejected (not non-ff — likely a pre-push hook):\n${out.trim()}`,
          );
        }
        // A throw BEFORE the commit (header rewrite / build-index / add / commit):
        // the tree is rolled back clean; surface the original error verbatim.
        throw e;
      }
    },
  );

  // plan 926: even with in-process regen the residual clobber window is non-zero, and the
  // non-claim callers (promotions, demotions, archive-via-move) get NO per-claim heal. Run the
  // shared heal here so NO move-plan caller ever leaves a drifted INDEX on master. Idempotent +
  // best-effort: a ZERO-commit no-op when the INDEX is already consistent (the common case); on
  // the rare residual clobber it re-commits the correct INDEX. It must NOT fail the
  // already-committed(+pushed) move — the pre-push lint-plan-index --check is the final backstop.
  // Skipped on --dry (nothing committed) and --no-push (the no-push caller owns its own push/heal).
  if (!result.dry && result.pushed) {
    try {
      healIndexDrift(mainDir, { label: `move ${result.basename} → ${targetPath()}/` });
    } catch (e) {
      console.error(`move-plan: WARN — INDEX heal after move did not converge: ${e.message}`);
    }
  }

  const newBasename = result.newRel.split('/').pop();
  const renameNote = newBasename !== result.basename ? ` (renamed to ${newBasename})` : '';
  // plan 2719: a pure rename never left its lane, so the `from/ → to/` shape would read as
  // a no-op move. Report the rename itself.
  if (renameOnly) {
    console.log(
      result.dry
        ? `move-plan: [dry] rename ${result.basename} → ${newBasename} in ${targetPath()}/ (no changes made)`
        : `move-plan: renamed ${result.basename} → ${newBasename} in ${targetPath()}/ — committed${result.pushed ? ' + pushed' : ' (push skipped)'}`,
    );
    return 0;
  }
  if (result.dry)
    console.log(
      `move-plan: [dry] ${result.basename} ${result.fromStatus}/ → ${targetPath()}/${renameNote} (no changes made)`,
    );
  else
    console.log(
      `move-plan: ${result.basename} ${result.fromStatus}/ → ${targetPath()}/${renameNote} — committed${result.pushed ? ' + pushed' : ' (push skipped)'}`,
    );
  return 0;
}

// plan 4136 E4: runs in main() BEFORE withCoordCheckout — a validation-only failure (a bad
// argument, or a content-entry-gate refusal readable straight off origin/master) must refuse
// WITHOUT ever queuing for the coord-write lock (operators were seeing 20–230s to report a
// usage error). Everything here is READ-ONLY against the shared MAIN checkout: `boundedGit`
// fetch/ls-tree/show never touch `mainDir`'s working tree or HEAD (a `merge`/`reset`, which
// DOES mutate it, is never called here — that stays inside withCoordCheckout's own disposable,
// lock-held checkout, unchanged). This function may only REFUSE early: a `null` return always
// falls through to the real, in-lock producer, which re-runs every one of these gates again
// (and the rest it doesn't run here — the claim-holder guard, the --rename gates, board
// invariants) exactly as before this change — a pass here changes nothing about what runs next.
//
// Fails OPEN (returns null, proceed to the lock) whenever it cannot safely judge: a pure
// --rename (renameOnly — the rename gates and claim-holder guard are race-sensitive and stay
// in-lock only, per the plan 4136 scope), the fetch itself fails, the plan can't be resolved
// against origin/master, its body can't be read there, or coord.config.json can't be loaded —
// in every one of those cases the SAME in-lock gate a few seconds later is the backstop, same
// as before this preflight existed.
//
// `argv` is passed through the SAME parseAndValidateArgs mainImpl uses (never a second parse),
// with `quiet: false` — this call is the one that prints the ready/ cost-redirect notice, since
// it runs first; see that function's header for the full no-double-print contract with
// mainImpl's own (quiet) re-parse.
function runLockFreePreflight(mainDir, argv) {
  const parsed = parseAndValidateArgs(argv);
  if (parsed.exitCode !== undefined) return parsed.exitCode;
  const { idOrName, target, flags, renameOnly } = parsed;
  if (renameOnly) return null;

  try {
    boundedGit(mainDir, ['fetch', '--quiet', 'origin', 'master']);
  } catch {
    return null; // origin unreachable/wedged — let the in-lock producer's own fetch surface it
  }

  let oldRel;
  try {
    const plans = boundedGit(mainDir, [
      'ls-tree',
      '-r',
      '--name-only',
      'origin/master',
      '--',
      PLANS_PREFIX,
    ])
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('.md'));
    oldRel = resolvePlanRel(plans, idOrName);
  } catch {
    return null; // not found / ambiguous against origin/master — the in-lock resolve decides
  }
  const basename = oldRel.split('/').pop();

  let body;
  try {
    body = boundedGit(mainDir, ['show', `origin/master:${oldRel}`]);
  } catch {
    return null; // unreadable at origin/master — nothing safe to judge
  }

  let cfg;
  try {
    cfg = loadCoordConfig(mainDir);
  } catch {
    return null;
  }

  try {
    assertContentEntryGatesOk(target, body, basename, cfg, flags);
  } catch (e) {
    console.error('move-plan:', e.message);
    return e.fatal ? 2 : 1;
  }
  return null; // pass — every gate re-runs again inside the lock, unchanged
}

// Isolate the standalone re-file (an operator `move-plan <id> <target>`, or a
// `move-plan <id> ready` heal) from the shared MAIN tree — the same coord-checkout
// shadow plan 989 gave the coordWrite tools + claim-plan's projection. Without this,
// the re-file mutate-commit-pushes the MAIN checkout, so a sibling session's transient
// coord dirt there can trip mainImpl's freshen-abort / foreign-dirt class.
//
// withCoordCheckout acquires the coord-write lock + resolves the disposable
// `.claude/coord-worktree` (reset to the fresh origin/master tip), then runs `fn(cdir)`.
// We point COORD_MAIN_DIR at that dir so mainImpl's resolveMain()/masterPushSpec()/
// ffMasterFromOrigin() (already COORD_MAIN_DIR-aware, plan 971) operate on the isolated
// tree → the move lands in the coord-checkout and pushes to origin, never touching MAIN.
// withCoordCheckout is promise-aware (plan 989), so the lock is held across the async
// mainImpl until withRetry settles.
//
// done-worktree's post-merge spine ALREADY sets COORD_MAIN_DIR (its own per-land
// ephemeral worktree + landing-lock): withCoordCheckout short-circuits to fn(mainDir) —
// no nested checkout, no second lock — and we re-set COORD_MAIN_DIR to the same value
// (a no-op), preserving that path byte-for-byte.
//
// plan 4136 E4: the lock-free preflight above runs HERE, before withCoordCheckout, and ONLY
// when COORD_MAIN_DIR is not already set by a caller — a caller that owns COORD_MAIN_DIR
// (done-worktree's own ephemeral worktree + landing-lock) is already serialized by ITS lock,
// so a second, unserialized preflight fetch/read against a dir a landing spine is actively
// mutating would be a race, not a courtesy; that path is unchanged byte-for-byte (`quietArgParse:
// false`, exactly the pre-4136 inline parse). When the preflight DOES run and PASSES, mainImpl's
// own re-parse is told `quiet: true` so the cost-redirect notice (if any) — already printed once
// by the preflight — is never printed a second time.
export async function main() {
  // plan 995: --no-push is incompatible with the disposable coord-checkout. A standalone
  // (COORD_MAIN_DIR-unset) move runs in .claude/coord-worktree, which the NEXT coord op
  // `reset --hard`s — so a committed-but-unpushed move would be SILENTLY DISCARDED. Fail
  // fast instead of losing the move; --dry is the preview path. (When COORD_MAIN_DIR is
  // set — done-worktree's caller-owned ephemeral worktree — --no-push still lands in that
  // tree for the caller to push, so the guard is scoped to the standalone path only.)
  if (process.argv.includes('--no-push') && !process.env.COORD_MAIN_DIR) {
    console.error(
      'move-plan: --no-push is not supported for a standalone re-file — the move runs in a ' +
        'disposable coord-checkout that is discarded unless pushed (plan 995). ' +
        'Omit --no-push to land on origin, or use --dry to preview.',
    );
    return 2;
  }
  const mainDir = resolveMain();
  const preflightRan = !process.env.COORD_MAIN_DIR;
  if (preflightRan) {
    const preflightExit = runLockFreePreflight(mainDir, process.argv.slice(2));
    if (preflightExit !== null) return preflightExit;
  }
  return withCoordCheckout(mainDir, async (cdir) => {
    // async + await: the finally must run only AFTER mainImpl's promise settles. A
    // non-async `return mainImpl()` would fire the finally synchronously (restoring
    // COORD_MAIN_DIR before the awaited withRetry work runs).
    const prev = process.env.COORD_MAIN_DIR;
    process.env.COORD_MAIN_DIR = cdir;
    try {
      return await mainImpl({ quietArgParse: preflightRan });
    } finally {
      if (prev === undefined) delete process.env.COORD_MAIN_DIR;
      else process.env.COORD_MAIN_DIR = prev;
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error('move-plan:', e.message);
      process.exit(e.fatal ? 2 : 1);
    },
  );
}
