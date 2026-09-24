// scripts/coord/plan-promotable-lib.mjs — "is this plan body ready to be stamped specced?"
// (plan 2892).
//
// THE DEADLOCK THIS EXISTS TO PREVENT. `stamp-exec-model --spec-review` flips
// `stage: specced` while the plan still rests in `pending-approval/`, and until plan 2892
// it did so WITHOUT looking at the body at all. Any body defect the next tool checks then
// wedged the plan between two gates: `edit-plan` refused every write (specced-in-
// pending-approval), `move-plan <id> ready` refused on the body defect, and each tool's
// fix menu prescribed the other. It fired at least 7 times across 2026-07-30..08-04
// (sessions 2639/2645, plans 2722, 2732, 2778, 2820, 2821); the worst recovery needed a
// `BOARD_GUARD_OVERRIDE=1` hand-move plus a `--no-verify` push.
//
// TWO HALVES, and the split between them is the whole design:
//
//   findPromotionBlockers()      — what the stamp CANNOT fix for you. The stamp refuses
//                                  BEFORE writing anything, so the plan stays at
//                                  `stage: stub` where `edit-plan` still works and the
//                                  refusal's fix menu is actually executable. A refusal
//                                  that stamped first would just be the deadlock again.
//   completeSpeccedStatusProse() — what the stamp CAN fix, and therefore must: the
//                                  `**Status:** … STUB …` token, rewritten to the specced
//                                  form in the SAME commit. This is the single most
//                                  common tripwire of the four absorbed entries, and the
//                                  stamp is the authority that made the prose stale.
//
// NO SECOND COPY OF ANY PREDICATE (spec-pass ruling: "the deadlock class exists because
// three tools each reasoned about promotability separately"). Every check below is the
// EXACT function the tool that would otherwise refuse already calls:
//
//   Status prose  → findStageStatusProseViolations (plan-body-state.mjs) — the same
//                   predicate board-write-gate's Check A refuses with, asked in advance.
//   💰 banner     → hasParseableCostBanner (plan-cost-banner.mjs), the plan-1260 SINGLE
//                   authority the pre-push lint and both movers already share.
//   SEED-WRITE    → SEED_BANNER_ANCHOR_RX (build-index-lib.mjs) — the STRICT banner shape,
//                   which is move-plan's own anchor regex, not the loose value parser.
//                   That distinction is the whole check: `readSeedWriteValue` matches a
//                   SEED-WRITE mention anywhere in the body, so a plan merely DISCUSSING
//                   the banner would pass here and then hard-fail move-plan's waiting-*
//                   move with "no SEED-WRITE banner found to anchor the Blocked-by
//                   header" — i.e. exactly the strand this check exists to prevent
//                   (review finding, plan 2892 round 1).
//
// This module imports only LEAF modules — never board-write-gate — so no import cycle is
// possible in either direction, and the gate's own module graph stays free of the
// cost-banner/queue-drain chain.

import { hasParseableCostBanner, costBannerHelp } from './plan-cost-banner.mjs';
import {
  SEED_BANNER_ANCHOR_RX,
  specVerdictRegions,
  stripFencedBlocks,
  PENDING_APPROVAL_FOLDER,
  READY_FOLDER,
} from './build-index-lib.mjs';
import {
  findStageStatusProseViolations,
  readStatusToken,
  setStatusToken,
  statusTokenForStage,
} from './plan-body-state.mjs';

// The folders in which `📋 READY` is the TRUTHFUL Status token for a specced plan, and
// therefore the only ones whose STUB prose the stamp may complete on its own. A plan
// stamped while it sits in a waiting lane is still waiting: rewriting its token to READY
// would present a blocked plan as takeable to every operator and board tool (review
// finding, plan 2892 round 1 — `assertStampableStatus` permits waiting-* stamps, and
// stamp-lib leaves the plan in its folder). Those bodies are REFUSED instead, with Check
// A naming the contradiction, so a human writes the waiting token that is actually true.
const READY_TOKEN_FOLDERS = new Set([PENDING_APPROVAL_FOLDER, READY_FOLDER]);

/**
 * Rewrite a `**Status:** … STUB …` line to the specced form, leaving the author's
 * `— …` remainder byte-for-byte (setStatusToken splices only the state token).
 *
 * Deliberately conditional on the token being exactly `STUB`. The live token vocabulary
 * has many legitimate pairings with `stage: specced` — `WAITING-TRIP`, `WAITING-DATE`,
 * `BLOCKED` — and a specced plan parked on a trip condition must keep saying so. STUB is
 * the ONE token the stamp itself invalidates, and the only one board-write-gate's Check A
 * refuses alongside a specced stamp, so it is the only one rewritten. A body with no
 * Status line at all is returned unchanged: inventing one is move-plan's job on promotion
 * (`stampPromotedStatus`), not the stamp's.
 *
 * `status` is the plan's CURRENT status folder — the completion is skipped outside
 * READY_TOKEN_FOLDERS (see above), leaving the contradiction for Check A to refuse rather
 * than guessing which waiting token a waiting-lane plan should carry.
 */
export function completeSpeccedStatusProse(content, { status = PENDING_APPROVAL_FOLDER } = {}) {
  if (readStatusToken(content) !== 'STUB') return content;
  if (!READY_TOKEN_FOLDERS.has(status)) return content;
  // statusTokenForStage reads the body's OWN `stage:` stamp — already flipped to `specced`
  // by the projection this runs inside — rather than a token literal duplicated here, so
  // the stamp and every mover share ONE stage→token mapping (review finding, round 1).
  return setStatusToken(content, statusTokenForStage(content));
}

// plan 3943: the five spec-pass check letters a `## Spec-pass verdict` section must name,
// each with a PASS/FAIL/PARTIAL tag ON ITS OWN LINE — the mechanical, non-semantic proof
// that a real spec-pass ran rather than a Status line merely asserting one did. Sourced
// from coord/skills/spec-pass/SKILL.md step 1 (C1 premises, C2 not-shipped, C3 deps/
// overlap, C4 consistency, C5 banners/cost) — a literal list here, not derived from the
// skill doc, because the skill is prose a human/session reads, not a machine-parseable
// contract; if the skill ever renumbers its checks this list is the one place to update.
const SPEC_VERDICT_CHECK_LETTERS = ['C1', 'C2', 'C3', 'C4', 'C5'];

/**
 * What's missing from a verdict section's TEXT, as a list of human-readable fragments —
 * empty when every required token is present. Nothing semantic is judged (plan 3943 body,
 * "What the blocker checks, mechanically"): a PASS tag next to a check letter is trusted
 * at face value, never re-derived from the plan's own claims.
 */
function verdictSectionMissingParts(sectionText) {
  const missing = [];
  for (const c of SPEC_VERDICT_CHECK_LETTERS) {
    // "each followed on its line by one of PASS/FAIL/PARTIAL". Two bounds, both deliberate:
    // `[^\n]*` stays within ONE line, so a tag two lines below a bare "C1" does not count;
    // and `(?:(?!\bC\d\b)[^\n])*` stops at the NEXT check letter on that line, so
    // "C3: still open, see below. C4: PASS" cannot let C3 borrow C4's tag (plan 3943
    // review round 1, CONFIRMED). Still purely mechanical — a tag is trusted at face
    // value, never re-derived from the plan's own claims.
    const rx = new RegExp(`\\b${c}\\b(?:(?!\\bC\\d\\b)[^\\n])*\\b(PASS|FAIL|PARTIAL)\\b`, 'i');
    if (!rx.test(sectionText)) missing.push(`\`${c}\` (with a PASS/FAIL/PARTIAL tag on its line)`);
  }
  if (!/\blitmus\b/i.test(sectionText)) missing.push('an execModel "litmus" line');
  if (!/\bexit test\b/i.test(sectionText)) missing.push('an "exit test" line');
  return missing;
}

/**
 * The plan 3943 blocker: a `stage: specced` stamp requires a written verdict, not just a
 * Status line saying spec-pass happened. `specReview` is the value THIS stamp invocation
 * is about to write (passed through by the caller, stamp-exec-model.mjs, which already
 * has it in scope) — `exempt-mechanical` skips the check entirely, because that path
 * means no judgment pass happened at all (Tier-0; the tool already stamps no
 * `specReviewBy` there either, plan 3004's same carve-out).
 *
 * Locating the region is `specVerdictRegion`'s job (build-index-lib.mjs), shared with
 * board-write-gate.mjs's Check B so neither hand-rolls it: it is FENCE-AWARE (a plan that
 * documents the required shape in a ```md block — this repo's own 3943 body does — must
 * not thereby satisfy the requirement, plan 3943 review round 1) and it shapes the region
 * per form (an H2 heading owns everything up to the next same-or-shallower heading; the
 * legacy `**Spec-pass verdict**` form owns its own paragraph, since its marker and its
 * C1-C5 tokens are fused onto one line and there is no heading to bound).
 */
function findVerdictSectionBlocker(basename, content, { specReview } = {}) {
  if (specReview === 'exempt-mechanical') return null;
  const regions = specVerdictRegions(content);
  if (!regions.length) {
    return {
      kind: 'spec-verdict-missing',
      detail:
        `${basename}: no \`## Spec-pass verdict\` section. A \`stage: specced\` stamp ` +
        `requires a written verdict — add a section naming each check C1-C5 with a ` +
        `PASS/FAIL/PARTIAL tag, an execModel litmus line, and an exit-test line ` +
        `(coord/skills/spec-pass/SKILL.md step 4), then re-run this stamp.`,
    };
  }
  // A plan re-verdicted by a later pass carries MORE THAN ONE verdict block (review round
  // 2): any complete one satisfies the stamp. When none is complete the message describes
  // the LAST — the most recent verdict, the one the author is actually working on.
  let missing = null;
  for (const region of regions) {
    // Fenced text inside an otherwise-real section is an ILLUSTRATION, not a verdict
    // (review round 2) — stripped before any token is counted.
    const text = stripFencedBlocks(content.slice(region.start, region.end));
    const gaps = verdictSectionMissingParts(text);
    if (!gaps.length) return null;
    missing = gaps;
  }
  if (missing.length) {
    return {
      kind: 'spec-verdict-incomplete',
      detail:
        `${basename}: the \`## Spec-pass verdict\` section is missing ${missing.join(', ')}. ` +
        `Every check C1-C5 needs a PASS/FAIL/PARTIAL tag on its own line, plus an ` +
        `execModel litmus line and an exit-test line (coord/skills/spec-pass/SKILL.md step 4).`,
    };
  }
  return null;
}

/**
 * Everything that would block this body from being stamped `stage: specced`, as
 * `{ kind, detail }` — empty when the body is canonical.
 *
 * `content` is the PROJECTED body (the stamp's own mutation already applied, including
 * `completeSpeccedStatusProse` above), never the raw pre-stamp one: the caller must be
 * judged on what it is actually about to write, or the STUB token it is about to fix
 * would be reported as a blocker it cannot clear.
 *
 * Both banners are required regardless of which folder the plan is stamped in — every
 * plan carries both (vetapp CLAUDE.md), a spec-pass stamp is the review moment where that
 * ought to be true, and the two later failures they prevent live in different lanes (the
 * 💰 banner gates the ready/ promotion, the SEED-WRITE banner anchors a waiting-* move).
 *
 * `specReview` (plan 3943, optional): the `--spec-review` value THIS stamp invocation is
 * about to write, threaded through to findVerdictSectionBlocker above. Absent (a plain
 * execModel-only stamp with no `--spec-review`) never triggers the verdict check —
 * stamp-exec-model.mjs's own preflight only calls this function at all when `specReview`
 * is set, so an absent value here only matters to a direct test/caller of this function.
 */
export function findPromotionBlockers(
  basename,
  content,
  { status = PENDING_APPROVAL_FOLDER, specReview } = {},
) {
  const blockers = [];

  const verdictBlocker = findVerdictSectionBlocker(basename, content, { specReview });
  if (verdictBlocker) blockers.push(verdictBlocker);

  if (!SEED_BANNER_ANCHOR_RX.test(content)) {
    blockers.push({
      kind: 'seed-write-banner',
      detail:
        `${basename}: no canonical SEED-WRITE banner line. Every plan carries one, and a ` +
        `later waiting-* move has nothing to anchor its **Blocked-by:** header to without ` +
        `it. Add one as the first body line, exactly:\n` +
        `      > 🟩 **SEED-WRITE: NO** — <why it touches no seed shard>\n` +
        `      > 🟥 **SEED-WRITE: YES** — <which clinics/shards it writes>\n` +
        `    (A SEED-WRITE mention elsewhere in the prose does NOT count — move-plan anchors ` +
        `on this exact line shape.)`,
    });
  }

  if (!hasParseableCostBanner(basename, content)) {
    blockers.push({
      kind: 'cost-banner',
      detail: `${basename}: no parseable 💰 **Cost forecast:** banner.`,
      help: costBannerHelp(),
    });
  }

  const entry = {
    path: `docs/superpowers/plans/${status}/${basename}`,
    content,
    basename,
    folder: status,
  };
  for (const detail of findStageStatusProseViolations([entry])) {
    blockers.push({ kind: 'stage-status-prose', detail });
  }

  return blockers;
}

/**
 * The refusal text. Names every blocker, then the fix menu — which is executable
 * PRECISELY BECAUSE nothing has been stamped yet: the plan is still `stage: stub`, so
 * `edit-plan` accepts the body fix and the stamp can simply be re-run afterwards.
 *
 * Carries NO tool-name prefix, matching stamp-cloud-exec's `gateRefusalMessage`: the
 * throwing CLI's own top-level catch prefixes it, and repeating it here printed the tool
 * name twice.
 */
export function promotionBlockerMessage(basename, blockers) {
  const lines = [
    `REFUSING to stamp ${basename} \`stage: specced\` — its body is not in a ` +
      `promotable state, and stamping first would wedge it (plan 2892):`,
    '',
    ...blockers.map((b) => `  • ${b.detail}`),
  ];
  for (const b of blockers) if (b.help) lines.push('', b.help);
  lines.push(
    '',
    '  NOTHING HAS BEEN WRITTEN — the plan is still `stage: stub`, so this is fixable now:',
    `    1. node scripts/edit-plan.mjs ${basename.replace(/^(\d+)-.*/, '$1')} --find … --replace …`,
    '    2. re-run this stamp.',
    '',
    '  (Stamping first is what produced the specced-in-pending-approval deadlock this',
    '   check exists to prevent: edit-plan then refuses the body fix, and move-plan',
    '   refuses the route-out, each prescribing the other.)',
  );
  return lines.join('\n');
}
