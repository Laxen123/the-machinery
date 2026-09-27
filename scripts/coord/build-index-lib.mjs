// scripts/coord/build-index-lib.mjs
// Pure, filesystem-free core for generating docs/INDEX.md's active plan-bullet
// region from per-plan metadata (plan 249). INDEX is 100% derived data — a
// listing of active plans by status folder + a one-line summary each — so the
// plan FILE is the single source and INDEX is GENERATED, killing the
// hand-edit contention that N parallel sessions used to thrash on.
//
// Division of ownership inside docs/INDEX.md:
//   • The prose conventions (seed-write legend, canonical-filename rules,
//     subfolder rules, blocked-by header, cross-plan ordering) — VERBATIM, never
//     touched by the generator.
//   • The active plan bullet list — OWNED by the generator, fenced between
//     INDEX_PLANS_START / INDEX_PLANS_END sentinels.
//   • The archive section ("Moved to `…/archive/` …") — VERBATIM time-batched
//     prose; never regenerated.
//
// The CLI (build-index.mjs) supplies real plan files from `git ls-files`; this
// module is the testable transform.
//
// ONE exception to "filesystem-free" (plan 3960, coord-core step 2): STATUS_ORDER /
// ALL_PLAN_FOLDERS / PLAN_FOLDER_ALT / the per-lane named constants are derived from
// coord.config.json's `lanes.*` key at module load, via coord-config.mjs's `loadCoordConfig`
// (one `existsSync` + one `readFileSync`, same as lint-board.mjs's pre-existing
// `loadCoordConfig(REPO_ROOT).paths.boardFile` module-scope read). This module is imported by
// nearly every coord tool, so that read is wrapped fail-open — see resolveLaneConfig's own
// comment — and every OTHER export here stays a total function of its inputs exactly as before.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChangedList } from './select-battery-tests.mjs';
// plan 3341 code-review follow-up: the marker vocabulary lives in a dependency-free leaf
// module (see its own header) precisely so THIS import is possible — importing FROM
// lint-filename-execmodel-drift.mjs instead would be a real two-file cycle, since that file
// already imports readFrontmatterScalar/resolveLintChangeScope from here.
import { LANE_MARKER_ALTERNATION } from './plan-lane-segments.mjs';
// plan 3999 review fix round 1 (key 488889): the ONE real-calendar-date check, shared with
// exec-model-default-lib.mjs's own `since:` validation — isValidPriorityByValue below used to
// carry a private re-implementation (isRealCalendarDate) instead of importing this. Both round-
// trip through `Date` to reject a value that is merely SHAPED like a date (`2026-13-45`,
// `2026-02-30`) without being one.
import { isCalendarDate } from './exec-model-default-lib.mjs';
// plan 3960: loadCoordConfig itself performs IO only inside its own function body (an
// `existsSync` + `readFileSync`, both synchronous and fast) — never at import — so importing it
// here does not turn this module's import into a graph that runs unbounded IO transitively; see
// resolveLaneConfig below for the one call site.
import { loadCoordConfig } from './coord-config.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';

// ── plan 3960 (coord-core step 2): lanes.* / mutationBanner.label from coord.config.json ─────
// STATUS_ORDER / ALL_PLAN_FOLDERS / PLAN_FOLDER_ALT / the per-lane named constants (below) and
// SEED_BANNER_ANCHOR_RX (further down) are DERIVED from these two config keys — this module is
// the ONE reader of `lanes.*` (coordinator correction, 2026-09-13: NOT board-lib.mjs, which
// carries no lane vocabulary at all). Every other lane-spelling site imports from here instead
// of repeating a literal, exactly as lint-board.mjs's PLAN_FOLDER_ALT consumer already does.
//
// This whole resolution sits HERE, right after the imports, so both consumers below — the
// STATUS_ORDER block (further down) and SEED_BANNER_ANCHOR_RX (which sits much earlier in the
// generated-file layout, near COST_BANNER_RX) — can reference the same already-computed
// `const`, which module evaluation order requires be initialized before either use.
//
// Fail-open, never throws at import: this module is imported by nearly every coord tool
// (claim-plan, move-plan, build-index, drain-run, …), so a repo-root resolution hiccup or a
// malformed coord.config.json here must not crash every one of them — same posture
// land-timeout-guard.mjs's config read uses. A MISSING coord.config.json is not an error case
// at all (loadCoordConfig already returns DEFAULTS for that — the isolated-plan-repo test
// scaffold hits exactly this path), so the catch below only ever fires on a genuinely
// malformed on-disk config or a repo-root surprise.
const FALLBACK_STATUS_ORDER = Object.freeze([
  'in-progress',
  'ready',
  'pending-approval',
  'waiting-blocked',
  'waiting-operator',
  'waiting-grill',
  'waiting-date',
  'waiting-trip',
]);
const FALLBACK_ARCHIVE = 'archive';
const FALLBACK_PARKED = 'parked';

// The by-ROLE fallback map (not just the rendered array) — needed so the per-lane named
// constants below can look a folder name up BY ROLE KEY (`inProgress`, `ready`, …) rather than
// by array position, which would silently reassign roles under a config that reorders
// `lanes.order`.
const FALLBACK_LANES_BY_KEY = Object.freeze({
  inProgress: 'in-progress',
  ready: 'ready',
  pendingApproval: 'pending-approval',
  waitingBlocked: 'waiting-blocked',
  waitingOperator: 'waiting-operator',
  waitingGrill: 'waiting-grill',
  waitingDate: 'waiting-date',
  waitingTrip: 'waiting-trip',
});

// vetapp's live coord.config.json default (checked in coord-config.mjs's `DEFAULT_MUTATION_BANNER`)
// — restated as a private fallback here for the identical fail-open reason as the lane fallbacks
// above: a genuinely malformed on-disk config must degrade to today's exact banner label, never
// crash every importer of this module.
const FALLBACK_MUTATION_BANNER_LABEL = 'SEED-WRITE';

// mutationBanner.flag (plan 3961 T3.1a) — same fail-open reason as FALLBACK_MUTATION_BANNER_LABEL
// just above: a genuinely malformed on-disk config must degrade to today's exact flag, never
// crash every importer of this module.
const FALLBACK_MUTATION_BANNER_FLAG = '--seed-write';

// ONE config read for both `lanes.*` and `mutationBanner.label` — see the block header comment
// above for the fail-open contract this whole function exists to uphold.
function resolveBuildIndexCoordConfig() {
  try {
    const repoRoot = repoRootFrom(dirname(fileURLToPath(import.meta.url)));
    const cfg = loadCoordConfig(repoRoot);
    const lanes = cfg && cfg.lanes;
    let laneResult = {
      statusOrder: FALLBACK_STATUS_ORDER,
      archive: FALLBACK_ARCHIVE,
      parked: FALLBACK_PARKED,
      byKey: FALLBACK_LANES_BY_KEY,
    };
    if (
      lanes &&
      Array.isArray(lanes.statusOrder) &&
      lanes.statusOrder.length > 0 &&
      typeof lanes.archive === 'string' &&
      lanes.archive &&
      typeof lanes.parked === 'string' &&
      lanes.parked
    ) {
      const byKey = {};
      for (const key of Object.keys(FALLBACK_LANES_BY_KEY)) {
        byKey[key] =
          typeof lanes[key] === 'string' && lanes[key] ? lanes[key] : FALLBACK_LANES_BY_KEY[key];
      }
      laneResult = {
        statusOrder: lanes.statusOrder,
        archive: lanes.archive,
        parked: lanes.parked,
        byKey,
      };
    }
    const label =
      cfg &&
      cfg.mutationBanner &&
      typeof cfg.mutationBanner.label === 'string' &&
      cfg.mutationBanner.label
        ? cfg.mutationBanner.label
        : FALLBACK_MUTATION_BANNER_LABEL;
    const flag =
      cfg &&
      cfg.mutationBanner &&
      typeof cfg.mutationBanner.flag === 'string' &&
      cfg.mutationBanner.flag
        ? cfg.mutationBanner.flag
        : FALLBACK_MUTATION_BANNER_FLAG;
    return { lane: laneResult, mutationBannerLabel: label, mutationBannerFlag: flag };
  } catch {
    // fail open — see header comment above
    return {
      lane: {
        statusOrder: FALLBACK_STATUS_ORDER,
        archive: FALLBACK_ARCHIVE,
        parked: FALLBACK_PARKED,
        byKey: FALLBACK_LANES_BY_KEY,
      },
      mutationBannerLabel: FALLBACK_MUTATION_BANNER_LABEL,
      mutationBannerFlag: FALLBACK_MUTATION_BANNER_FLAG,
    };
  }
}

const BUILD_INDEX_COORD_CONFIG = resolveBuildIndexCoordConfig();
const LANE_CONFIG = BUILD_INDEX_COORD_CONFIG.lane;

export const INDEX_PLANS_START =
  '<!-- INDEX:PLANS-START (generated by scripts/build-index.mjs — do not hand-edit between the sentinels) -->';
export const INDEX_PLANS_END = '<!-- INDEX:PLANS-END -->';

// The ONE shared "does this basename genuinely claim numeric id `id`" assertion
// (plan 2039), used by both next-plan-id.mjs's idTakenByOther (mint-time: is this
// candidate id already used?) and move-plan.mjs's resolvePlanRel (resolve-time:
// which file does this id mean?). Before plan 2039 each site hand-rolled its own
// regex with only a comment enforcing agreement — and the fix diff itself
// immediately drifted the two (the review that caught it: a letter-only anchor in
// one, a letter-or-full-date anchor in the other). One exported fragment closes
// that gap for good.
//
// A basename starting with `<id>-` counts as a real claim UNLESS what follows is
// itself just two more digit-groups (`MM-DD-`) — the shape of a pure
// `YYYY-MM-DD-slug.md` legacy archive basename that carries NO real id at all (its
// leading digits only accidentally read as a plausible id, e.g. `2026` matching
// the current year). Everything else — a letter category (`<id>-Infra-slug.md`),
// an older `<id>-YYYY-MM-DD-slug.md` archived-plan shape (whose FULL date sits one
// dash later, so its lookahead never matches the bare MM-DD exclusion), or even a
// malformed/hand-made basename nobody anticipated — still counts as a candidate.
// Excluding by pattern (not allow-listing known-good shapes) means an unrecognized
// basename is never silently dropped from an ambiguity check; only the one proven
// false-positive shape is excluded.
export function idClaimPattern(id) {
  return `${id}-(?!\\d{2}-\\d{2}-)`;
}

// The id a basename genuinely CLAIMS, or null (plan 2082, review r9) — the
// derive-from-basename twin of idClaimPattern's test-a-given-id fragment, factored
// here so move-plan's resolvePlanRel and its claim-holder guard share ONE copy of
// the "leading digits + date-exclusion test" wiring instead of each hand-rolling it
// (the plan-2039 drift class this module exists to close). A dateless legacy
// archive basename (`2026-05-17-x.md`) returns null; `2082-FABLE-x.md` → '2082'.
export function claimedIdOfBasename(basename) {
  const m = String(basename).match(/^(\d{3,})/);
  if (!m) return null;
  return new RegExp(`^${idClaimPattern(m[1])}`, 'u').test(String(basename)) ? m[1] : null;
}

// The archive header that marks the end of the active region — same anchor the
// legacy index-lib.mjs / lint use, so all three agree on where "active" stops.
export const ACTIVE_END_RX = /^\s*Moved to `docs\/superpowers\/plans\/archive\//m;

// ── The plan **Status:** BLOCK — ONE definition for every writer ──────────────
// A plan's status is a Status line PLUS the contiguous annotation lines directly
// beneath it, all stamped by the SAME transition. Rewriting Status therefore has to
// replace the whole block: an annotation left behind describes a transition that no
// longer happened (the plan-612 class — an archived body reading `READY` under a
// stale `Blocked-by:`).
//
// This lives here, in the module both writers already import, because it USED to be
// two independent definitions — plan-body-state.mjs's own STATUS_BLOCK_RX (promotion
// / archive) and claim-plan-lib.mjs's line-scoped STATUS_RX (claim / resume). They
// did not merely risk drift, they WERE already divergent: the claim path replaced
// only the Status LINE, so a re-claim stacked the previous transition's annotations
// beneath the new ones. Plan 2353's `--resume` takeover makes re-claiming a routine
// operation rather than a rarity, which is what turns that latent stacking into a
// real defect — and adding a THIRD annotation kind (`**Takeover:**`) to only one of
// two copies would have widened the split further. Add a new annotation kind to
// STATUS_ANNOTATION_KEYS and every writer picks it up.
export const STATUS_ANNOTATION_KEYS = ['Previous status', 'Override', 'Takeover'];
// The shared pattern TEXT for a bare Status line (no `^`/`$` anchors, no flags) —
// STATUS_LINE_RX and STATUS_BLOCK_RX both build from this one string constant so
// neither can drift from the other by an unnoticed edit to one's compiled flags
// (plan 2409 review finding: an earlier version derived STATUS_BLOCK_RX from
// STATUS_LINE_RX.source via string-slicing plus a separately hand-typed 'm' flag
// literal — exactly the "two copies, quietly diverging" failure mode this module
// exists to close).
const STATUS_LINE_SRC = '\\*\\*Status:\\*\\*.*';
// The bare Status LINE (no annotations) — exported so a caller that only needs a
// presence test (next-plan-id.mjs's ensureReadyStatusLine, plan 2409) shares this
// definition instead of hand-rolling a fourth copy of the same shape.
export const STATUS_LINE_RX = new RegExp(`^${STATUS_LINE_SRC}$`, 'm');
// `.` excludes `\n`, so each `.*` is exactly one line and the `(?:\n…)*` walks the
// contiguous annotation lines. Built from the same STATUS_LINE_SRC text plus the
// annotation-key list so the two can never disagree.
export const STATUS_BLOCK_RX = new RegExp(
  `^${STATUS_LINE_SRC}(?:\\n\\*\\*(?:${STATUS_ANNOTATION_KEYS.join('|')}):\\*\\*.*)*$`,
  'm',
);

// ── The Status-line INSERTION anchors — cost banner, SEED-WRITE banner, H1 ────
// When a plan body has no Status line at all, every writer (claim-plan-lib's
// flipStatusToInProgress, plan-body-state's setStatusLine, next-plan-id's
// ensureReadyStatusLine) splices one in after the first anchor that matches, in
// this preference order: cost-forecast banner, else SEED-WRITE banner, else the
// H1 — each writer keeps its own fallback-chain logic (and, for
// ensureReadyStatusLine, its own strict cost-banner shape), but all three anchor
// constants now live here. H1_RX was still hand-duplicated identically in all
// three writers even after this plan folded in the other two — the exact "one
// constant, several quietly-driftable copies" pattern this plan exists to close
// (review finding, plan 2409). A third near-twin, queue-drain.mjs's
// ANCHORED_COST_BANNER_RX, stays separate on purpose — it is a lane-admission VALUE
// parser tuned for maximum tolerance, the opposite job of an insertion anchor that
// must refuse anything that doesn't look like a banner.
//
// COST_BANNER_RX requires the 💰 glyph to lead the line (optionally after a `>` quote
// marker and/or `**` bold-open), not merely appear somewhere on it — plan 2360 round 4
// widened the anchor to match a 💰 glyph ANYWHERE on a line containing "Cost forecast",
// which let a prose sentence like "the previous 💰 cost forecast already covered this"
// hijack the anchor. Corpus-validated at plan 2409's spec-pass: this shape still
// matches every real banner in the corpus except two archived FUSED
// SEED-WRITE+cost-forecast lines where the 💰 sits mid-line — missing those is
// acceptable by construction (one still matches SEED_BANNER_RX on the same line, the
// other falls through to the H1 anchor; both are archived plans that already carry
// Status lines, so the anchor never runs for them).
export const COST_BANNER_RX = /^\s*>?\s*\*{0,2}💰.*Cost forecast.*$/im;
// plan 3960 review fix (findings 1/2/15/16): this used to be a literal `/^>.*\*\*SEED-WRITE.*$/m`
// even after mutationBanner.label became configurable — SEED_BANNER_ANCHOR_RX just below already
// read the configured label, but every consumer of THIS looser export (plan-body-state.mjs's
// Status-line inserter, claim-plan-lib.mjs's status/claim writers, next-plan-id.mjs,
// reconcile-drain-markers.mjs's Unclaimed-drain projector) kept searching for the default text —
// so a body carrying `> 🟩 **DATA-WRITE: NO**` under a configured `mutationBanner.label: DATA-WRITE`
// matched none of them, and each fell back to its next anchor (or, for the marker reconciler,
// projected nothing at all). Derived from the SAME BUILD_INDEX_COORD_CONFIG.mutationBannerLabel
// SEED_BANNER_ANCHOR_RX uses — byte-identical to the old literal for vetapp's own default label.
export const SEED_BANNER_RX = new RegExp(
  `^>.*\\*\\*${escapeRegex(BUILD_INDEX_COORD_CONFIG.mutationBannerLabel)}.*$`,
  'm',
);
// The STRICT variant (plan 2892, hoisted out of move-plan.mjs's local `BANNER_RX`): the
// full canonical banner, emoji and colon included. SEED_BANNER_RX above is deliberately
// loose because it only has to FIND an anchor line; this one is what `move-plan` requires
// to anchor a `**Blocked-by:**` header on a waiting-* move, and a body that matches the
// loose form but not this one is exactly the plan that passes a pre-move check and then
// hard-fails "no SEED-WRITE banner found to anchor…". Both live here so the two shapes
// are visibly one family rather than a regex in a CLI nobody else can see.
// plan 3960 (coord-core step 2): the label is `mutationBanner.label` (coord.config.json),
// defaulting to today's exact "SEED-WRITE" — see BUILD_INDEX_COORD_CONFIG above for the
// fail-open read.
export const SEED_BANNER_ANCHOR_RX = new RegExp(
  `^>\\s*(?:🟥|🟩)\\s*\\*\\*${escapeRegex(BUILD_INDEX_COORD_CONFIG.mutationBannerLabel)}:`,
  'm',
);
export const H1_RX = /^# .*$/m;

// plan 3960 cluster-2 review fix: the configured label, exported so the AUTHORITATIVE banner
// PARSER (readSeedWriteValue below) and every banner WRITER (done-worktree.mjs's
// spineCarryForwardBody, drain-run.mjs's stub-body renderer) drive off the SAME value
// SEED_BANNER_ANCHOR_RX above already does, instead of each hardcoding its own "SEED-WRITE"
// literal — mutationBanner.label was previously only half-applied (the anchor alone read it).
export const MUTATION_BANNER_LABEL = BUILD_INDEX_COORD_CONFIG.mutationBannerLabel;

// plan 3961 T3.1a: the configured mutation-flag counterpart to MUTATION_BANNER_LABEL just
// above — done-worktree.mjs's carry-forward minter passes this as the `next-plan-id.mjs
// claim` CLI flag instead of hardcoding vetapp's own "--seed-write" literal.
export const MUTATION_BANNER_FLAG = BUILD_INDEX_COORD_CONFIG.mutationBannerFlag;

// plan 3943: the ONE spec-pass-verdict marker regex, shared by board-write-gate.mjs's
// Check B (which scopes its stamp-contradiction scan to this region) and
// plan-promotable-lib.mjs's `stage: specced` blocker (which requires the region to carry
// a REAL verdict, not merely announce one). Hoisted here from board-write-gate.mjs's
// original `SPEC_VERDICT_PARAGRAPH_RX` — the plan-promotable-lib.mjs header explicitly
// forbids importing board-write-gate.mjs (import-cycle risk), and this module is a leaf
// both callers already import from, so ONE copy serves both without a new file.
//
// Two forms are accepted: the current canonical `## Spec-pass verdict` H2 heading, and
// the legacy `**Spec-pass verdict**` bold-paragraph form every pre-3943 specced plan
// carries — narrowing to the heading alone would retroactively "un-mark" every already-
// specced plan's verdict prose for Check B's purposes. `[- ]` after `Spec` accepts both
// "Spec-pass" and "Spec pass"; `(?:pass )?` makes the bare "Spec verdict" form optional
// too (both pre-existing tolerances, unchanged by the widening). Multiline (`m`) so `^`
// anchors to the START OF ANY LINE when this runs against a whole document (as
// plan-promotable-lib.mjs's blocker does); board-write-gate.mjs's per-paragraph
// `.test(para.trim())` usage is unaffected by the flag (its subject is always a single,
// pre-trimmed string).
export const SPEC_VERDICT_MARKER_RX = /^(?:##\s+|\*\*)Spec[- ](?:pass )?verdict\b/im;

// plan 3943: the shared LOCATOR for that marker's regions, so neither caller hand-rolls the
// "where does the verdict text start and stop" half. Review rounds 1 and 2 both landed here,
// and their findings pull in different directions, which is why ONE function owns all of it:
//
//   (a) Fence-awareness, OUTSIDE and INSIDE. A plan that DOCUMENTS the required shape — this
//       repo's own 3943 body and the spec-pass skill both do — must not thereby satisfy the
//       requirement (round 1: a fenced ```md heading was read as the real section), and the
//       tokens inside a real section must be real too (round 2: C1-C5 tags living only in a
//       fenced illustration under a genuine heading). The scan below skips fenced marker
//       lines; `stripFencedBlocks` below is how callers drop fenced text from a region's
//       CONTENT before judging it.
//   (b) Region SHAPE differs per form, and must. A canonical `## Spec-pass verdict` section
//       is a heading, a BLANK LINE, then bullets — so the paragraph containing the heading is
//       the heading ALONE, and board-write-gate's old paragraph-scoped collection would have
//       scanned nothing at all for the very form it was widened to recognize (the widening
//       would have silently disabled Check B there). A heading's region therefore runs from
//       the line AFTER the heading to the next same-or-shallower heading. The LEGACY
//       `**Spec-pass verdict**` form has no heading to bound it and its marker and tokens are
//       fused into one paragraph, so it stays PARAGRAPH-scoped and INCLUDES its marker line —
//       widening it too would change what Check B warns on for every pre-3943 plan, a
//       behaviour change nothing asked for.
//   (c) EVERY marker, not the first (round 2). Check B's pre-3943 loop pushed one region per
//       matching paragraph; a plan re-verdicted by a later pass carries two verdict blocks,
//       and collapsing to the first would stop scanning the current one.
//
// Tolerances carried over from the paragraph loop this replaced, both round-2 findings: the
// marker line may be INDENTED (the old caller tested `para.trim()`), and a CRLF blank line
// ends a legacy paragraph exactly as an LF one does.
//
// Returns `{ start, end, heading }` in document order — indices into `content`, `heading`
// true for the H2 form. `start` is where the VALIDATED TEXT begins: after the heading's own
// line for the H2 form (so a word like PASS in the heading's parenthetical cannot satisfy a
// check), at the marker line's start for the legacy fused form.
export function specVerdictRegions(content) {
  const src = String(content);
  const lines = src.split('\n');
  const regions = [];
  let pos = 0;
  let inFence = false;
  let skipUntil = 0;
  for (const line of lines) {
    const lineStart = pos;
    pos += line.length + 1; // +1 for the '\n' this split consumed
    if (FENCE_DELIM_RX.test(line)) {
      inFence = !inFence;
      continue; // a fence delimiter line is never itself a marker
    }
    if (inFence) continue;
    // The leading-whitespace tolerance is for the LEGACY bold form ONLY — the pre-3943
    // caller tested `para.trim()`, so an indented `  **Spec-pass verdict**` matched. An
    // indented `##` is not a markdown heading at all, and admitting one would let a
    // four-space-indented code block masquerade as a verdict section (review round 3), so
    // the heading branch is tested against the RAW line, at column zero, exactly as
    // HEADING_LEVEL_RX is everywhere else in this family.
    if (lineStart < skipUntil) continue;
    const bare = line.replace(/^[ \t]+/, '');
    if (!SPEC_VERDICT_MARKER_RX.test(bare)) continue;
    const headingLike = /^##\s/.test(bare);
    // An INDENTED `##` is not a markdown heading at all, so it is skipped outright rather
    // than falling through to the legacy branch — otherwise a four-space-indented code
    // block could masquerade as a verdict region (review round 3). `bare === line` is the
    // whole test: the marker already matched `bare`, so the only question left is whether
    // the line carried leading whitespace.
    if (headingLike && bare !== line) continue;
    if (headingLike) {
      // Bound at the next same-or-shallower heading. nextHeadingBoundary restarts its own
      // fence tracking from index 0 by contract, so it is handed the true document and an
      // offset — never a pre-sliced tail (its header documents why).
      regions.push({ start: pos, end: nextHeadingBoundary(src, pos, 2), heading: true });
      continue;
    }
    // Legacy bold-paragraph form: end at the blank line that closes this paragraph — or, if
    // none follows, at the next heading rather than at EOF (review round 4). Falling back to
    // EOF made `skipUntil` below swallow every later marker, so a legacy line immediately
    // followed by a real `## Spec-pass verdict` hid the real one entirely.
    const rest = src.slice(lineStart);
    const blank = rest.search(/\r?\n[ \t]*\r?\n/);
    const end =
      blank === -1
        ? nextHeadingBoundary(src, pos, 6)
        : Math.min(lineStart + blank, nextHeadingBoundary(src, pos, 6));
    regions.push({ start: lineStart, end, heading: false });
    // A legacy region is a PARAGRAPH, so a second marker line inside that same paragraph
    // must not open a second, overlapping region (review round 3).
    skipUntil = end;
  }
  return regions;
}

// The single-region convenience: the FIRST verdict region, or null. Kept for callers that
// only need "is there a verdict at all"; anything that SCANS verdict text wants the full
// list above, since a re-verdicted plan carries more than one.
export function specVerdictRegion(content) {
  return specVerdictRegions(content)[0] ?? null;
}

// Fenced blocks blanked out, line count preserved so any index/line arithmetic a caller does
// against the result still lines up with the original. An UNCLOSED fence strips to the end:
// a caller judging whether text is REAL content must never be handed the tail of a block the
// author never closed. Shared by the two plan-3943 checks that judge a section's contents
// (the verdict-token scan, the inherited-premises non-empty test) — round 2 found both
// counting fenced illustrations as the real thing.
export function stripFencedBlocks(text) {
  let inFence = false;
  return String(text)
    .split('\n')
    .map((line) => {
      if (FENCE_DELIM_RX.test(line)) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line;
    })
    .join('\n');
}

// Status subfolders that hold ACTIVE plans, in the order they render. `archive/`
// is deliberately absent — archived plans are summarised as time-batched prose
// below the sentinels, not as generated bullets. `parked/` (plan 1426) is ALSO
// deliberately absent — a parked plan is a long-term freeze, not archived and not
// active: it gets no generated bullet AND no separate "Parked" section (renderPlansBlock
// below silently drops any record whose status isn't in this list — see its own comment).
//
// Members, in today's default order (see coord-config.mjs's `lanes.*` DEFAULTS for the
// per-lane rationale — pending-approval's minted-but-unreviewed resting spot, plan 1371;
// waiting-grill's batched operator-grilling lane, plan 2034; the rest self-describing):
// in-progress, ready, pending-approval, waiting-blocked, waiting-operator, waiting-grill,
// waiting-date, waiting-trip.
export const STATUS_ORDER = LANE_CONFIG.statusOrder;

// ALL_PLAN_FOLDERS / PLAN_FOLDER_ALT (plan 1447): the ONE source array/string every
// hand-duplicated status-folder regex or group literal now derives from — lint-board.mjs's
// PLAN_REF_RX, index-lib.mjs's STATUS_SUBFOLDER_RX, drain-run.mjs's BOARD_SUBFOLDER_GROUP, and
// move-plan.mjs's VALID_TARGETS all build off this instead of hand-listing folder names, so the
// next status folder (or a future frozen lane) is a ONE-LINE change here instead of the
// plan-1426 experience of silently missing one of 3+ hand-edited literals. `archive`/`parked`
// are appended AFTER STATUS_ORDER — both are recognized path segments these regexes/lists must
// still parse, but neither is a STATUS_ORDER member (see that array's own comment for why).
//
// Order here is canonical (STATUS_ORDER, then archive, then parked). The three regex literals
// this replaces each hand-rolled their OWN alternation order (none of which agreed with each
// other OR with STATUS_ORDER) — harmless, since every alternative here is a fixed,
// mutually-non-prefixing string, so alternation ORDER never changes which strings a regex built
// from it matches. Each site's own test hard-codes the OLD literal for a BEHAVIORAL (not
// textual) drift guard — see lint-board.test.mjs / index-lib.test.mjs / drain-run.test.mjs.
export const ALL_PLAN_FOLDERS = [...STATUS_ORDER, LANE_CONFIG.archive, LANE_CONFIG.parked];

// plan 2678: admits the optional one-level lowercase category folder between the status and
// the file. Group 1 stays the STATUS — the only thing buildPlanFolderIndex records. Without
// it a categorised plan never entered the index, so buildReport read its live worktree/branch/
// claim as having no plan file behind it and proposed cleaning them up.
// Lives HERE rather than in reconcile-worktree-branches.mjs (plan 4125): it is the one parser
// for a plan path's status and a second consumer appeared (wiki-coverage-sweep), which must not
// drag that module's claim-CAS dependency graph in just to read a folder name.
export const PLAN_PATH_RX =
  /^docs\/superpowers\/plans\/([^/]+)\/(?:[a-z0-9-]+\/)?(\d{3,})-[^/]*\.md$/;

// planId -> folder Map built from ONE path listing — the pure counterpart to
// done-worktree-lib.mjs's buildPlanIdIndex (same batching idea, applied to folder NAME rather
// than a live/archived boolean).
export function buildPlanFolderIndex(lsTreeOutput) {
  const index = new Map();
  for (const raw of String(lsTreeOutput || '').split('\n')) {
    const m = raw.trim().match(PLAN_PATH_RX);
    if (!m) continue;
    const [, folder, id] = m;
    if (!index.has(id)) index.set(id, folder); // first hit wins — an id lives in exactly one folder
  }
  return index;
}
// plan 3960 cluster-6 review fix: each folder name is escaped before joining into the
// alternation — a configured lane name is FREE-FORM text (coord-config.mjs's lane validation
// only requires non-empty + no duplicates), so an unescaped regex-metacharacter in a renamed
// lane (e.g. "review.pending") would silently change what every regex BUILT from this
// alternation matches (a bare `.` matches any character) instead of the literal folder name.
// escapeRegex is a hoisted function declaration (defined further below in this file), so calling
// it here at module-eval time is safe.
export const PLAN_FOLDER_ALT = ALL_PLAN_FOLDERS.map(escapeRegex).join('|');

// Per-lane named constants (plan 3960 T2) — for a consumer that names ONE specific folder
// (`status === 'in-progress'`, lint-filename-execmodel-drift.mjs:152's model case) rather than
// enumerating the whole set. Keyed by ROLE (`lanes.inProgress`, …), not by position in
// STATUS_ORDER — a config that reorders `lanes.order` still names the SAME lane by role.
export const IN_PROGRESS_FOLDER = LANE_CONFIG.byKey.inProgress;
export const READY_FOLDER = LANE_CONFIG.byKey.ready;
export const PENDING_APPROVAL_FOLDER = LANE_CONFIG.byKey.pendingApproval;
export const WAITING_BLOCKED_FOLDER = LANE_CONFIG.byKey.waitingBlocked;
export const WAITING_OPERATOR_FOLDER = LANE_CONFIG.byKey.waitingOperator;
export const WAITING_GRILL_FOLDER = LANE_CONFIG.byKey.waitingGrill;
export const WAITING_DATE_FOLDER = LANE_CONFIG.byKey.waitingDate;
export const WAITING_TRIP_FOLDER = LANE_CONFIG.byKey.waitingTrip;
export const ARCHIVE_FOLDER = LANE_CONFIG.archive;
export const PARKED_FOLDER = LANE_CONFIG.parked;

// plan 3960 review fix: the ONE configured-waiting-lane predicate, so a renamed
// `lanes.waiting*` folder is recognized identically everywhere a caller needs "is this a
// waiting-state folder" instead of each site re-deriving its own answer. move-plan.mjs
// previously built this Set locally from the same five per-lane constants above (byte-identical
// membership); it and done-worktree.mjs's batch close-out (archiveBatchMembers, which used to
// test the literal `startsWith('waiting-')` or import claim-plan-lib.mjs's own hardcoded-prefix
// isWaitingFolder) now both read this export.
export const WAITING_FOLDERS = new Set([
  WAITING_BLOCKED_FOLDER,
  WAITING_OPERATOR_FOLDER,
  WAITING_GRILL_FOLDER,
  WAITING_DATE_FOLDER,
  WAITING_TRIP_FOLDER,
]);
export const isWaitingFolder = (status) => WAITING_FOLDERS.has(status);

// ── Category subfolders (plan 2678) ─────────────────────────────────────────
// THE rule: a plan's STATUS is the FIRST path segment under docs/superpowers/plans/,
// and an OPTIONAL single category folder may sit between the status and the file:
//
//   docs/superpowers/plans/<status>/[<category>/]<NNN-Category-slug>.md
//
// Categories are an operator BROWSING affordance only (clump `parked/denmark/`,
// `parked/norway/`, `ready/infra/` in Explorer) — they carry NO semantics, are never
// required, and are never auto-assigned: a fresh mint still lands FLAT in
// `pending-approval/`, and grouping only ever happens on an explicit operator-requested
// `git mv` / `move-plan <id> <status>/<category>`.
//
// WHY THIS LIVES HERE, AND WHY EVERY CONSUMER MUST ROUTE THROUGH IT: before this plan
// the filesystem-based enumerators (read-plan-stamps, queue-drain, lint-board,
// cloud-session-hygiene) each hand-rolled a NON-RECURSIVE `readdirSync(statusDir)` +
// `isFile()` filter, and build-index parsed the plans-relative path as exactly
// `"<status>/<basename>"`. A plan moved one level down therefore did not error — it
// silently VANISHED from the INDEX, the board, the lints, and the drain oracle, which
// is the worst possible failure mode for a coordination surface (plan 1928's
// silent-INDEX-drop incident, one level up). One walker, one classifier, so a consumer
// left behind is a grep-able `readdirSync` rather than an invisible dropout.
//
// This module is deliberately FILESYSTEM-FREE (see the header), so `walkPlanTree` takes
// an injected `readdir` seam instead of importing node:fs. Every caller already imports
// node:fs anyway, and the seam is what makes the nested-tree cases unit-testable without
// a fixture repo.

// A category folder name: lowercase-only, `[a-z0-9-]+`. The lowercase restriction is
// deliberate — it keeps the folder visually distinct from the Uppercase-led Category TAG
// inside a plan filename (`2678-Coord-…`), so `parked/denmark/` never reads as a second
// spelling of the filename taxonomy.
export const PLAN_CATEGORY_RX = /^[a-z0-9-]+$/;

// Status folders that must stay FLAT (spec-pass decision, 2026-08-01). `archive/` is the
// only member: `done-worktree`'s close-out always targets `archive/<basename>`, so a
// category folder there could only ever be created by hand and would immediately diverge
// from where the spine puts the next archived plan. Verified 2026-08-01 — archive holds
// 2,543 files and zero subdirectories, so the rule costs nothing today.
export const FLAT_ONLY_PLAN_FOLDERS = ['archive'];

// The lint verdict for one plan path's nesting, or null when it is legal. Exported so
// lint-plan-index.mjs (the full-corpus sweep that runs from pre-push) and the walker
// raise the SAME self-explaining message rather than two drifting restatements.
export function planNestingViolation(statusFolder, categorySegments, rel) {
  const segs = categorySegments.filter(Boolean);
  if (segs.length === 0) return null;
  if (segs.length > 1) {
    return (
      `${rel} — plan status folders nest EXACTLY one optional category level ` +
      `(<status>/<category>/<file>.md); this path nests ${segs.length}. ` +
      `Flatten it to \`${statusFolder}/${segs[0]}/\` or move it back to \`${statusFolder}/\`.`
    );
  }
  const [category] = segs;
  if (FLAT_ONLY_PLAN_FOLDERS.includes(statusFolder)) {
    return (
      `${rel} — \`${statusFolder}/\` stays FLAT (no category subfolders): the landing ` +
      `spine always archives to \`${statusFolder}/<basename>\`, so a category folder here ` +
      `immediately diverges from where the next land puts its plan. Move it to \`${statusFolder}/\`.`
    );
  }
  if (!PLAN_CATEGORY_RX.test(category)) {
    return (
      `${rel} — category folder "${category}" must be lowercase \`[a-z0-9-]+\` ` +
      `(e.g. "denmark", "data-pipeline"); uppercase is reserved for the Category TAG ` +
      `inside a plan filename.`
    );
  }
  return null;
}

// Classify ONE plans-root-relative path (`ready/2678-Coord-x.md`, `parked/denmark/9-X-y.md`)
// into the record every consumer keys on. `statusFolder` is ALWAYS the first segment — a
// root-level file (`_dashboard.base`, `FOG.md`) has no status and reports `''`, which every
// caller already rejects via its own STATUS_ORDER / ALL_PLAN_FOLDERS check. `category` is
// null when flat. `violation` is non-null for an illegal shape; enumeration still RETURNS
// the entry (a mis-filed plan must be visible and loudly wrong, never silently dropped).
export function classifyPlanRel(rel) {
  const segments = String(rel).split('/').filter(Boolean);
  const basename = segments.length ? segments[segments.length - 1] : '';
  const statusFolder = segments.length > 1 ? segments[0] : '';
  const categorySegments = segments.slice(1, -1);
  const normalized = segments.join('/');
  return {
    statusFolder,
    category: categorySegments.length ? categorySegments.join('/') : null,
    basename,
    rel: normalized,
    violation: planNestingViolation(statusFolder, categorySegments, normalized),
  };
}

// The inverse of classifyPlanRel — the ONE place a plans-relative path is composed, so a
// consumer can never re-derive `<status>/<basename>` and drop the category on a rewrite.
export function planRelFor({ statusFolder, status, category, basename }) {
  const s = statusFolder ?? status;
  return category ? `${s}/${category}/${basename}` : `${s}/${basename}`;
}

// Classify a list of REPO-relative paths (the `git ls-files docs/superpowers/plans/*.md`
// shape — already recursive, since git's `*` crosses `/`). Non-plans paths are dropped.
export function classifyPlanPaths(paths, { plansPrefix = 'docs/superpowers/plans/' } = {}) {
  const out = [];
  for (const p of paths) {
    const rel = String(p ?? '').trim();
    if (!rel.startsWith(plansPrefix)) continue;
    out.push(classifyPlanRel(rel.slice(plansPrefix.length)));
  }
  return out;
}

// Recursively walk a plans ROOT and yield one classifyPlanRel record per plan file.
//
// `readdir(segments)` is the injected seam: it receives the path segments BELOW the root
// (`[]` for the root itself, `['ready']`, `['parked','denmark']`) and must return
// Dirent-like objects (`.name`, `.isFile()`, `.isDirectory()`). Segments rather than a
// joined string so this module never has to know the host path separator.
//
// Ordering is fully sorted (directories then files, at every level) for the same reason
// read-plan-stamps.mjs sorted before this fold: a plan id transiently present in two
// folders — a parallel session mid-`move-plan` — must resolve REPRODUCIBLY across
// filesystems, not by readdir order.
//
// `includeArchive: false` (the default) skips `archive/` at the top level: every
// active-board consumer asks "which lane can take this plan", and archive is ~10x the
// file count.
export function walkPlanTree({
  readdir,
  includeArchive = false,
  isPlanFile = DEFAULT_IS_PLAN_FILE,
} = {}) {
  assertReaddirSeam(readdir, 'walkPlanTree');
  const out = [];
  const top = readdir([])
    .filter((e) => e.isDirectory() && (includeArchive || e.name !== 'archive'))
    .map((e) => e.name)
    .sort();
  // Root-level files are deliberately NOT walked: `plans/` itself holds no plans, only
  // `_dashboard.base` / `FOG.md` and the status folders.
  for (const status of top) descendPlanDir(out, [status], readdir, isPlanFile);
  return out;
}

// Walk ONE status folder — its flat plan files plus any one-level category subfolder —
// for the consumers that already hold a per-status directory rather than the plans root
// (queue-drain's ready/ + archive/ scans, cloud-session-hygiene's per-folder sweep).
// `readdir(segments)` here receives segments relative to THAT FOLDER (`[]` is the folder
// itself, `['denmark']` a category inside it); records come back with `statusFolder`
// already set, so the caller never re-derives it. `rel` stays plans-root-relative
// (`parked/denmark/9-X-y.md`) for uniformity with walkPlanTree; `relInStatus` is the
// folder-relative path a caller joins onto its own directory handle.
export function walkPlanStatusDir({ statusFolder, readdir, isPlanFile = DEFAULT_IS_PLAN_FILE }) {
  assertReaddirSeam(readdir, 'walkPlanStatusDir');
  // A NAME, not a path: `rel` is composed from it, so a caller that passes its absolute
  // directory handle here would silently produce nonsense rels (caught in this plan's own
  // first cut, where queue-drain passed `dir`).
  if (typeof statusFolder !== 'string' || !statusFolder || statusFolder.includes('/')) {
    throw new Error(
      `walkPlanStatusDir: statusFolder must be a bare folder NAME (e.g. "ready"), got ${JSON.stringify(statusFolder)}.`,
    );
  }
  const out = [];
  descendPlanDir(out, [statusFolder], (segments) => readdir(segments.slice(1)), isPlanFile);
  return out.map((e) => ({ ...e, relInStatus: e.rel.split('/').slice(1).join('/') }));
}

const DEFAULT_IS_PLAN_FILE = (name) => name.endsWith('.md');

function assertReaddirSeam(readdir, fn) {
  if (typeof readdir !== 'function') {
    throw new Error(
      `${fn}: a \`readdir(segments)\` seam is required — build-index-lib.mjs stays filesystem-free.`,
    );
  }
}

// Files before directories at every level, each sorted — see walkPlanTree's ordering note.
function descendPlanDir(out, segments, readdir, isPlanFile) {
  const entries = readdir(segments);
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile() && isPlanFile(e.name)) files.push(e.name);
  }
  for (const name of files.sort()) out.push(classifyPlanRel([...segments, name].join('/')));
  for (const name of dirs.sort()) descendPlanDir(out, [...segments, name], readdir, isPlanFile);
}

// THE plan-filename TAG shape (plan 1945): `<id>-<Category>-`, where Category starts
// with an uppercase letter. Before this plan the shape was hand-duplicated three times
// — build-index.mjs:47's PLAN_FILENAME_RX, lint-board.mjs:52's byte-identical restatement
// (unused — dead code), and a THIRD near-copy baked inline into lint-board.mjs's
// PLAN_REF_RX (`\d{3,}-[A-Z][A-Za-z0-9]+-`) — none of which could ever be proven to
// agree except by eyeball. Every consumer of the shape now derives from this ONE
// literal: PLAN_FILENAME_RX below, lint-board.mjs's PLAN_REF_RX, and next-plan-id's
// mint-time gate (buildClaimOps).
export const PLAN_TAG_SOURCE = '\\d{3,}-[A-Z][A-Za-z0-9]+-';

// Canonical plan filename — NNN-Category-slug.md. `\d{3,}` covers 4-digit ids (plan
// 1000+); the loose `.+` after the category tag is the slug + extension. A lowercase
// (or otherwise non-uppercase-led) category tag fails this — e.g. `1928-tooling-…md`
// (plan 1928's silent-INDEX-drop incident) — and must be rejected at mint time
// (next-plan-id.mjs) or flagged loudly by build-index.mjs, never silently skipped.
export const PLAN_FILENAME_RX = new RegExp(`^${PLAN_TAG_SOURCE}.+\\.md$`);

// The plan-naming category taxonomy (plan 2329) USED TO be a module-level literal here.
// Plan 4071 (T2/D2) moved it to `coord.config.json`'s `planCategories.allowlist` (core
// default `[]`, read as "no category gate" — D1) — this leaf stays a zero-import module,
// so every consumer of the taxonomy now takes the allowlist as a PARAMETER: buildClaimOps
// (next-plan-id.mjs, mint time) and planRenameGrammar (move-plan.mjs, rename time) each
// resolve `loadCoordConfig(mainDir).planCategories.allowlist` once at their CLI entry and
// pass it down. The country-token + uk-not-gb conventions neither gate CAN verify (scope,
// not shape) live in docs/coord/plan-lanes.md § Plan naming and the spec-pass/
// board-pass checklists.

// Basename grammar for a rename/mint target: `<id>-[FABLE-|SOL-]<Category>-<slug>.md`. A
// private copy of move-plan.mjs's own RENAME_BASENAME_RX (kept there for its rename-specific
// error messaging) — this leaf only needs the CATEGORY capture group, and both this module and
// move-plan.mjs already sit at the SAME layer (move-plan.mjs imports FROM here, never the
// reverse), so duplicating the tiny regex rather than importing move-plan.mjs back keeps that
// one-directional dependency intact. The optional marker group (capture 2) is DERIVED from
// LANE_MARKER_ALTERNATION (plan 3341 code-review follow-up) rather than a hand-written
// `(FABLE-)?` — a hardcoded FABLE-only alternation mis-parsed `000-SOL-Pipe-<slug>.md` as
// category "SOL" instead of "Pipe", silently defeating the evidence-floor gate below for any
// SOL-embedded category. Capture-group POSITIONS are unchanged (2 = marker, 3 = category, 4 =
// slug), so assertEvidenceFloorOk's `m[3]` read below still means the same thing.
const EVIDENCE_FLOOR_BASENAME_RX = new RegExp(
  `^(\\d{3,})-(${LANE_MARKER_ALTERNATION})?([A-Za-z][A-Za-z0-9]*)-(.+)\\.md$`,
);

// Review fix round (2943+2944, R7): lifted from move-plan.mjs (plan 2943's original home) so
// next-plan-id.mjs can call the SAME predicate at mint time without importing the whole
// move-plan.mjs command module for one gate function (the layering smell F7 flagged) — this
// leaf module is the natural shared home, already owning readFrontmatterScalar.
// move-plan.mjs re-exports it so its own tests/callers are unaffected.
//
// The evidence-floor gate — a `ready/` target refuses a PRODUCT-FAMILY plan (Pipe/DQ/App/UI on
// vetapp — Infra/Coord run their own, stricter severity floor and are exempt here; SEO/Biz/Other
// are deliberately ungated for now, docs/coord/plan-lanes.md § The evidence floor) stamped
// `evidence: latent`: a latent finding (review/audit/code-reading "could go wrong", nothing
// observed wrong) is never its own plan — it folds to a line, or the class gets upgraded by a
// fresh observation. Category comes from EVIDENCE_FLOOR_BASENAME_RX above, with the optional
// leading `FABLE-` exec-model segment stripped by the regex's own capture group before matching
// — a `FABLE-DQ` plan is category `DQ` routed to the fable lane, not a distinct category. A
// basename that doesn't fit the `<id>-[FABLE-]<Category>-<slug>.md` shape is a DIFFERENT
// problem this gate doesn't own, so it no-ops rather than refusing on an unrelated malformed
// name. A MISSING `evidence:` key NEVER refuses (forward-only stamping, the grandfathered-pool
// precedent `loop:`/`bulkShaped:` already set) — only an explicit `latent` value does.
//
// `evidenceGatedCategories` used to be a module-level literal (`EVIDENCE_GATED_CATEGORIES`,
// `['Pipe','DQ','App','UI']` on vetapp). Plan 4071 (T2/D1/D2) moved it to `coord.config.json`'s
// `planCategories.evidenceGated` (core default `[]` — a config-less repo gates no category) and
// made it a PARAMETER here, so this leaf carries no project taxonomy at all. Defaults to `[]`
// (no gate) when a caller omits it, matching the seam's own degrade direction. `label` names the
// caller in the refusal message (defaults to `move-plan`, this predicate's original home, so
// that caller's message stays byte-identical). Review fix round (2943+2944, R9/C3): this
// predicate has three real callers (move-plan.mjs, next-plan-id.mjs, the done-worktree land
// spine's close-out.mjs) plus stamp-lib.mjs's combined stamp+move preflight — hard-coding the
// `move-plan:` prefix made the message misleading for the others, so each passes its own label
// and its own resolved `evidenceGatedCategories`.
// The category segment of a plan basename (`3956-FABLE-Infra-x.md` → `Infra`; the optional lane
// marker is stripped by the regex's own capture group), or null for a malformed / legacy name.
// plan 3956 lifted this out of assertEvidenceFloorOk so cut-worktree.mjs's dense-by-class rule
// reads the category through the SAME grammar the evidence floor and the mint gate use.
export function planCategoryOf(basename) {
  const m = EVIDENCE_FLOOR_BASENAME_RX.exec(String(basename));
  return m ? m[3] : null;
}

export function assertEvidenceFloorOk(
  targetStatus,
  content,
  basename,
  evidenceGatedCategories = [],
  label = 'move-plan',
) {
  if (targetStatus !== READY_FOLDER) return;
  const category = planCategoryOf(basename);
  if (!category) return; // malformed/legacy basename — not this gate's problem
  if (!evidenceGatedCategories.includes(category)) return;
  const evidence = readFrontmatterScalar(content, 'evidence');
  if (!evidence || evidence.toLowerCase() !== 'latent') return;
  throw Object.assign(
    new Error(
      `${label}: cannot promote to ready/ — ${basename} is stamped evidence: latent and category ` +
        `"${category}" is a product family the evidence floor gates (docs/coord/plan-lanes.md ` +
        '§ The evidence floor). A latent finding is never its own plan — return it by ONE of two paths: ' +
        '(1) fold it to a line (a domain debt ledger the project keeps for its own edge cases, or ' +
        'docs/handoff/infra-debt.md for everything else) and archive/park this plan, or (2) upgrade ' +
        'the class once a fresh observation supports it: node scripts/stamp-evidence.mjs ' +
        `${basename} observed-wave|observed-live|observed-measured|operator, then re-run this move. ` +
        'Infra/Coord plans are exempt (their own severity floor governs); SEO/Biz/Other are ' +
        'deliberately ungated for now.',
    ),
    { fatal: true },
  );
}

// Plan 2973: a plan that enters `ready/` — or gets exec-model-stamped — without a `cloudExec:`
// frontmatter key is silently excluded from every cloud drain, forever. `queue-drain.mjs
// --cloud` only admits an explicit `cloudExec: true`; `false` and absent both read as "not
// cloud-eligible" there, but only absence is a MISTAKE — an explicit `false` is a deliberate,
// correct verdict nobody needs telling twice. Root cause (2874/2964, 2026-08-08): the spec-pass
// 4c tool order made `stamp-cloud-exec` a detachable TAIL step after `move-plan`, so a verdict
// routing straight to a `waiting-*` lane occasionally dropped it, and the OBJECTIVE promoters
// into `ready/` (done-worktree's 6b close-out promoter, board-pass promotions) stamp nothing and
// warn about nothing. The skill-side fix (2026-08-08, master `d94e7f7324`) moved the cloud-exec
// stamp EARLIER in the 4c order so it precedes both the exec-model stamp and the route on every
// NEW plan — this composer is the tooling backstop for a session that still skips the step
// outright. ONE composer, called from THREE independent sites (move-plan.mjs's `ready/` promote
// path, done-worktree.mjs's 6b close-out promoter, stamp-exec-model.mjs's post-stamp check) so
// the wording can never drift between them — the same "never drift from the movers' rejection"
// reasoning `readyCostBannerError` already documents for the cost-banner rejection, and
// `assertEvidenceFloorOk` above it for the evidence floor.
//
// WARN, never refuse or throw: unlike the two gates above, an absent cloudExec stamp breaks
// NOTHING about the plan itself — it just silently opts it out of cloud drains, a fact that is
// fully recoverable at any later moment with one stamp command. Turning that into a promotion
// blocker (or, worse, an abort mid-land at the done-worktree call site) would make an inert
// bookkeeping gap a bigger failure than the one it exists to catch — see each call site's own
// comment for why THAT site is warn-only, never a hold.
//
// Detection mirrors `readCloudExecStamp` (local-drain-filter.mjs:64) rather than importing it:
// local-drain-filter.mjs already imports FROM this module, so importing it back would close a
// module cycle — the same reasoning the `PRIORITY_VALUES` comment above documents for
// read-plan-stamps.mjs. No frontmatter at all is definitely unstamped (`frontmatterEnd` returns
// -1); a real frontmatter block with no `cloudExec:` key reads '' from `readFrontmatterScalar`,
// same as an explicitly empty value would — both count as unstamped/absent for the SILENCE
// decision below (neither is `true`/`false`, so both still warn). Review fix round (2973,
// post-land): ONLY the exact strings `true`/`false` (case-insensitive) count as a deliberate
// stamp — `queue-drain.mjs:1078` admits nothing but the literal `cloudExec === 'true'`, so a
// typo'd value (`cloudExec: yes`, `cloudExec: tru`) is exactly as cloud-invisible as no key at
// all, and treating it as "stamped, stay silent" would defeat this composer's one job.
//
// FIX ROUND 2 (plan 2973): the lead sentence used to collapse "key absent" and "key present but
// empty" to the same wording ("has no cloudExec: frontmatter key") because readFrontmatterScalar
// can't distinguish them — but a plan that visibly HAS a `cloudExec:` line (just an empty one)
// is not missing the key, and telling the reader it is sends them looking in the wrong place.
// hasFrontmatterKey (above) reads the frontmatter block a second, cheap time to separate the two
// causes, giving a THREE-way lead: absent key, present-but-empty value, present-but-invalid
// value. Still ONE composer (a lead-sentence branch, not a second function) since every call
// site still wants a single string-or-null result.
export function cloudExecUnstampedWarning(basename, content) {
  const hasFrontmatter = frontmatterEnd(String(content).split(/\r?\n/)) !== -1;
  const raw = hasFrontmatter ? readFrontmatterScalar(content, 'cloudExec') : '';
  if (['true', 'false'].includes(raw.toLowerCase())) return null;
  const keyPresent = hasFrontmatter && hasFrontmatterKey(content, 'cloudExec');
  // Remediation id: reuse claimedIdOfBasename (exported above, this same file) instead of a
  // hand-rolled `^(\d{3,})` regex — the hand-rolled version mis-parsed a legacy date-prefixed
  // basename (`2026-05-17-legacy.md` → id `2026`), pointing the operator at an unrelated plan.
  // claimedIdOfBasename correctly rejects that shape via idClaimPattern's `YYYY-MM-DD-` exclusion
  // and returns null, so we fall back to the whole basename — stamp-cloud-exec.mjs resolves an
  // `idOrName`, so a bare basename is a valid argument to it too, and this is a WARN path that
  // must never itself throw on an odd basename.
  const id = claimedIdOfBasename(basename) || basename;
  const remediation =
    `Stamp it: node scripts/stamp-cloud-exec.mjs ${id} true — or, if it genuinely cannot run in ` +
    `the cloud: node scripts/stamp-cloud-exec.mjs ${id} false --reason "<why not cloud-safe>"`;
  const lead = !keyPresent
    ? `${basename} has no cloudExec: frontmatter key`
    : !raw
      ? `${basename} has an empty cloudExec: value`
      : `${basename} has an invalid cloudExec: value "${raw}" (expected true or false)`;
  return (
    `${lead} — it will be silently excluded from every cloud drain (queue-drain.mjs --cloud only ` +
    `admits an explicit cloudExec: true stamp). ${remediation}`
  );
}

// Parse a plan file's text into the bits the index bullet needs.
//   summary — from YAML frontmatter `summary:` (the INDEX one-liner). Falls back
//             to the H1 title when frontmatter is absent, so build-index works on
//             un-migrated / foreign plans (warn upstream, never crash a push).
//   marker  — 🟥 / 🟩 derived from the SEED-WRITE banner (single source of truth
//             for seed-write stays the banner, not a duplicated frontmatter key).
//             plan 2328: a `priority: high` frontmatter stamp prefixes ⚡ (one
//             token, no space — `⚡🟥`), so a priority plan is visible on the
//             board/INDEX without opening the file; index-lib's bullet regexes
//             admit the prefix. Riding the marker (not a separate field) means
//             edit-plan's marker/summary drift check refreshes the bullet
//             automatically when the stamp is added or removed.
//   h1      — first `# ` heading, used as the fallback summary + as link text.
export function parsePlanMeta(content, { seedLane = true } = {}) {
  const summaryFm = readFrontmatterSummary(content);
  const h1 = readH1(content);
  // readFrontmatterScalar, NOT readFrontmatterKey — a hand-stamp often carries a
  // trailing `# comment` (the plan-1292 execModel lesson), and every other reader
  // of this field (queue-drain, done-worktree, claim-plan) strips it; a raw read
  // here would render the INDEX bullet ⚡-less while the queue/board treat the
  // plan as priority (sonnet-review 2328 CONFIRMED finding).
  // plan 2520: routed through the ONE shared tier reader below — the ⚡ marker stays a
  // `high`-only flag (byte-identical to pre-2520), it just can no longer drift from what
  // queue-drain/claim-plan/done-worktree call "high" for the same stamp.
  const priority = isHighPriorityTier(content);
  const marker = `${priority ? '⚡' : ''}${readSeedMarker(content, { seedLane })}`;
  const summary = summaryFm || h1 || '(no summary)';
  return { summary, marker, h1, priority, hasFrontmatterSummary: Boolean(summaryFm) };
}

// Read `summary:` from a leading `---` YAML frontmatter block. Minimal parser —
// we only ever store a single-line scalar, optionally quoted. Returns '' if no
// frontmatter or no summary key.
export function readFrontmatterSummary(content) {
  return readFrontmatterKey(content, 'summary');
}

// Read a single-line `<key>:` scalar from a leading `---` YAML frontmatter block.
// Generalises readFrontmatterSummary so the specs generator (plan 856) can read
// `title:` with the same quoting rules. Returns '' if there is no frontmatter or
// the key is absent.
//
// CRLF-safe split (plan 1650 root cause): a bare split('\n') leaves each line ending
// in '\r' for CRLF content, and the `^key:\s*(.*)$` match below then FAILS outright —
// in JS regex, `.` never matches '\r' and a non-multiline `$` only matches at the very
// end of the string, so no backtracking can bridge a trailing '\r'. Every frontmatter
// key of a CRLF body was therefore invisible (summary → silent H1 fallback in the
// INDEX bullet, stage/specReview → gates waved through), while the SAME body parsed
// fine once git's `eol=lf` normalization committed it — which is how the 1647 mint
// committed a plan file and a bullet that disagreed ATOMICALLY in one commit, wedging
// every other session's pre-push lint. Split on /\r?\n/ (as upsertFrontmatterKey
// already does) so byte-variant EOLs parse identically to the committed blob.
export function readFrontmatterKey(content, key) {
  const lines = content.split(/\r?\n/);
  const end = frontmatterEnd(lines);
  if (end === -1) return '';
  const rx = new RegExp(`^${escapeRegex(key)}:\\s*(.*)$`);
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(rx);
    if (m) return unquoteYaml(m[1].trim());
  }
  return '';
}

// FIX ROUND 2 (plan 2973): whether `key` is PRESENT in the frontmatter block at all, regardless
// of its value. Exists because readFrontmatterKey/readFrontmatterScalar both collapse "key
// absent" and "key present but empty/comment-only" to the same '' return — a caller that needs
// to tell those two causes apart (cloudExecUnstampedWarning's three-way lead sentence, below)
// can't do it off readFrontmatterKey's return alone. Mirrors readFrontmatterKey's exact scan
// shape (frontmatterEnd, the same `^key:` line match, the same `for (let i = 1; i < end; i++)`
// bounds) so the two readers can never disagree on which line counts as "the key's line".
export function hasFrontmatterKey(content, key) {
  const lines = content.split(/\r?\n/);
  const end = frontmatterEnd(lines);
  if (end === -1) return false;
  const rx = new RegExp(`^${escapeRegex(key)}:`);
  for (let i = 1; i < end; i++) {
    if (rx.test(lines[i])) return true;
  }
  return false;
}

// Read a frontmatter scalar and strip a trailing YAML inline comment (plan 1292
// bugfix). Several hand-stamped values carry an explanatory comment after the
// value (e.g. `execModel: fable # umbrella tracker — NOT drain-eligible`,
// plan 1015) — a bare readFrontmatterKey compares the WHOLE raw value
// (`"fable # umbrella tracker…"`), which never equals the bare string `'fable'`
// a caller compares against, silently defeating any gate keyed on this field.
// Mirrors what lint-filename-execmodel-drift.mjs's readExecModel already did
// ad hoc; every frontmatter-scalar reader used for a gate/comparison should go
// through this shared helper instead of re-deriving the strip. Returns '' when
// readFrontmatterKey does (no frontmatter / key absent).
//
// Quoting note (plan 1292 bugfix): readFrontmatterKey already runs unquoteYaml
// on its match, but that pass sees the RAW value including the trailing
// comment (e.g. `"stub" # awaiting spec-pass`) — the last character is the
// comment text, not a closing quote, so the quote-strip's start/end check
// fails and the quotes survive. Stripping the comment can therefore UNMASK a
// still-quoted scalar (`"stub"`), so we must unquote again after the strip —
// otherwise a gate comparing against the bare string `'stub'` never matches
// and silently waves the plan through.
export function readFrontmatterScalar(content, key) {
  return unquoteYaml(
    readFrontmatterKey(content, key)
      .replace(/\s+#.*$/, '')
      .trim(),
  );
}

// plan 2520: the ruled three-tier `priority:` vocabulary. Was FOUR values in the wild
// (`high`/`medium`/`normal`/`low`) collapsed by every consumer to a `=== 'high'` boolean — so
// `medium`/`normal`/`low` all silently read as "absent". The operator-ruled fix: three legal
// tiers, `medium` the DEFAULT (byte-equivalent to unstamped — an explicit `medium` stamp and no
// stamp at all normalize identically), `normal` is NOT a synonym for anything, it is illegal.
// Sort order (queue-drain's comparator only): `high` > `medium`/unstamped > `low`.
//
// Canonical home: HERE, not read-plan-stamps.mjs, even though read-plan-stamps.mjs is the
// contracted stamp reader that surfaces `priority` in its map. read-plan-stamps.mjs already
// imports `readFrontmatterScalar` FROM this module, so defining the normalization there and
// importing it back here would be a cycle. Mirrors the existing `cloudExec` precedent: that
// normalization's canonical home is local-drain-filter.mjs (the ONE module queue-drain.mjs
// itself derives its own `cloudExec` value from) — read-plan-stamps.mjs is a CONSUMER of the
// canonical normalization there too, never its owner.
export const PRIORITY_VALUES = ['high', 'medium', 'low'];
export const PRIORITY_DEFAULT = 'medium';
// Sort weight for queue-drain's comparator ONLY — every other consumer (INDEX ⚡ marker, board
// row flag, done-worktree's queue-priority check) stays a `high`-only boolean via
// isHighPriorityTier below; they never read this map.
export const PRIORITY_SORT_WEIGHT = { high: 0, medium: 1, low: 2 };

// WRITE-TIME gate (plan 2520 ruling 3): true iff `raw` (a frontmatter scalar, or '' / null /
// undefined for absent) is a legal priority value. Absent is always legal — it defaults to
// `medium` — this only refuses an EXPLICIT bad stamp (a typo, or the now-illegal `normal`).
// Case-insensitive, matching every other stamp's normalization convention in this file.
export function isValidPriorityValue(raw) {
  if (!raw) return true;
  return PRIORITY_VALUES.includes(String(raw).trim().toLowerCase());
}

// READ-TIME normalization (plan 2520 ruling 3): absent OR an unrecognized value both resolve to
// `medium` — the unrecognized branch additionally WARNS (to stderr by default) rather than
// crashing, because a drain/INDEX build must survive one plan's escaped bad stamp. The write-time
// gate (isValidPriorityValue, wired into lint-plan-priority.mjs) is what is supposed to keep a
// bad value from reaching here in the first place; this is the soft-fail backstop for whatever
// slips past it (a plan authored before the lint existed, a --no-verify push).
export function normalizePriorityTier(
  raw,
  { warn = (msg) => console.error(msg), context = '' } = {},
) {
  if (!raw) return PRIORITY_DEFAULT;
  const v = String(raw).trim().toLowerCase();
  if (PRIORITY_VALUES.includes(v)) return v;
  warn(
    `priority: unrecognized value "${raw}"${context ? ` (${context})` : ''} — treating as ${PRIORITY_DEFAULT}`,
  );
  return PRIORITY_DEFAULT;
}

// Read + normalize a plan's `priority:` tier straight from its content — the ONE call every
// consumer (queue-drain's sort, build-index-lib's own ⚡ marker below, claim-plan's board row,
// done-worktree's queue-priority check, read-plan-stamps' contract map) makes instead of a raw
// scalar-read-then-equality-check re-derived independently a sixth time.
export function readPriorityTier(content, opts) {
  return normalizePriorityTier(readFrontmatterScalar(content, 'priority'), opts);
}

// The boolean the flag-only sites need (INDEX ⚡ marker, board row flag, done-worktree
// queue-priority check, queue-drain's own oracle-JSON `priority` field) — byte-identical to the
// pre-2520 `=== 'high'` check for `high` and for absent; only what a `low`/`medium` stamp FEEDS
// (queue-drain's sort tier, nothing else) changed.
export function isHighPriorityTier(content, opts) {
  return readPriorityTier(content, opts) === 'high';
}

// plan 3999: `priorityBy:` — the provenance stamp required whenever `priority: high` is
// present, forbidden otherwise. `high` had drifted into the default a session reaches for
// whenever it feels its own work is urgent; the operator wants it back to rare and
// operator-set. Legal values, exactly two shapes (case-insensitive on the keyword and on the
// directive name — matching every other stamp's normalization convention in this file):
//   `operator <YYYY-MM-DD>` — the operator said so in a sitting on that date; the date must be
//     a REAL calendar date, not merely shaped like one (`2026-13-45` is refused).
//   `directive <name>` — a standing class the runbook already grants `high` to. The set of
//     legal names is DATA (PRIORITY_BY_DIRECTIVES below), so adding a class is one row plus
//     its runbook sentence, never prose-only.
//
// Canonical home: HERE, not read-plan-stamps.mjs — mirroring PRIORITY_VALUES above (see its
// "Canonical home" comment). read-plan-stamps.mjs already imports `readFrontmatterScalar` FROM
// this module, so defining this array/reader/validator there and importing back here would be
// an import CYCLE. read-plan-stamps.mjs re-exports PRIORITY_BY_DIRECTIVES and surfaces
// `priorityBy` in its STAMP_KEYS contract map; it stays a CONSUMER of this normalization,
// never its owner — same split PRIORITY_VALUES/readPriorityTier already established.
// 'grammar-omnibus-carryforward' was a standing directive for the done-worktree auto-minted
// grammar-omnibus successor; the omnibus carry-forward machinery (including
// buildOmnibusSuccessorBody) was retired by plan 3961 (operator, 2026-09-14) — grammar/extraction
// edge cases now route to a one-line entry in the project's domain debt ledger instead. The directive
// name is removed rather than kept as a dead legal value.
export const PRIORITY_BY_DIRECTIVES = ['2141-critical-path'];

// The date is captured as ONE `YYYY-MM-DD` group (not y/m/d separately) so it can be handed
// straight to the shared `isCalendarDate` (exec-model-default-lib.mjs) without re-assembling it.
const PRIORITY_BY_OPERATOR_RX = /^operator\s+(\d{4}-\d{2}-\d{2})$/;
const PRIORITY_BY_DIRECTIVE_RX = /^directive\s+(\S+)$/;

// review fix round 1 (key dbf9e7/2a0c54): an operator sitting cannot have happened on a date
// that hasn't occurred yet — `priorityBy: operator 2099-01-01` must be refused the same way an
// impossible calendar date is. Compared at UTC-calendar-day granularity (matching
// isCalendarDate's own Date.UTC construction, the ambient-environment rule: the verdict must not
// depend on the host TZ) so a same-day stamp — the operator stamping TODAY's date, the normal
// case — stays valid: `stamped > today` is strictly greater, never `>=`.  `now` is a plain `Date`
// (defaults to `new Date()`), injected so a test pins "today" instead of depending on the machine
// clock.
function isFutureOperatorDate(dateStr, now) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const stamped = new Date(`${dateStr}T00:00:00Z`).getTime();
  return stamped > today;
}

// WRITE-TIME validator (plan 3999, mirroring isValidPriorityValue's shape): true iff `raw` (a
// frontmatter scalar, or '' / null / undefined for absent) is a legal `priorityBy:` value in
// ISOLATION — absent is always legal here; whether a `priorityBy:` is REQUIRED (because
// `priority: high` is present) or FORBIDDEN (because it isn't) is a different question,
// answered by priorityStampProblem below, not by this function.
//
// review fix round 1 (key 488889): the calendar-date check is the shared `isCalendarDate`
// (exec-model-default-lib.mjs) rather than a private re-implementation — it round-trips through
// `Date` the same way (rejects `2026-13-45` / `2026-02-30`), so one bug fix in either place now
// covers both callers. `now` (default `new Date()`) is threaded through for the future-date check
// above; callers that need a pinned "today" (tests) pass it through priorityStampProblem below.
export function isValidPriorityByValue(raw, { now = new Date() } = {}) {
  if (!raw) return true;
  const v = String(raw).trim().toLowerCase();
  const opMatch = v.match(PRIORITY_BY_OPERATOR_RX);
  if (opMatch) {
    const dateStr = opMatch[1];
    if (!isCalendarDate(dateStr)) return false;
    return !isFutureOperatorDate(dateStr, now);
  }
  const dirMatch = v.match(PRIORITY_BY_DIRECTIVE_RX);
  if (dirMatch) {
    return PRIORITY_BY_DIRECTIVES.some((name) => name.toLowerCase() === dirMatch[1]);
  }
  return false;
}

// Read the raw `priorityBy:` frontmatter scalar straight off plan content — comment-stripped,
// trimmed (via readFrontmatterScalar), but deliberately NOT lower-cased: this is the value an
// error message quotes back at the author, so it should read as written. `''` collapses to
// `null`, matching every other null-means-absent stamp in this file. Validation
// (isValidPriorityByValue) lower-cases internally, so case never affects whether a value is
// legal — only how it is echoed back.
export function readPriorityBy(content) {
  return readFrontmatterScalar(content, 'priorityBy') || null;
}

// THE shared validator (plan 3999 § Design point 1): both the push-time lint
// (lint-plan-priority.mjs's findUnbackedHigh) and the mint-time refusal (next-plan-id.mjs)
// import THIS, so their rules and their fix messages can never drift apart. Given one plan's
// raw text, returns the problem it has, or `null` when it has none:
//   'unbacked-high'        — `priority: high` with no legal `priorityBy:` at all.
//   'stale-priorityBy'     — a `priorityBy:` present on a plan whose priority is NOT high (a
//                            leftover from a since-demoted plan).
//   'bad-priorityBy-value' — a `priorityBy:` that is present but does not parse (wrong shape,
//                            an unlisted directive name, or an impossible calendar date).
// A present-but-unparseable value is reported BEFORE "stale" so a bad value on a medium/low
// plan is never silently waved through as "merely stale, ignore the payload" — the lint's
// grandfathering allowlist (BARE_HIGH_GRANDFATHERED_2026_09_13, lint-plan-priority.mjs) relies
// on exactly this ordering: it exempts a plan ONLY from 'unbacked-high', and a bad VALUE on a
// grandfathered plan reaches 'bad-priorityBy-value' first, so the allowlist never has to
// special-case it.
// review fix round 1 (keys 5898e9/711687): an explicitly empty `priorityBy:` (the key present,
// no value — a stray `priorityBy:` line with nothing after the colon, or comment-only) used to
// read identically to ABSENT, because readPriorityBy/readFrontmatterScalar collapse both to
// `null` — so it silently passed on a medium/low plan instead of being flagged. `hasFrontmatterKey`
// tells the two apart; a present-but-empty key is 'bad-priorityBy-value' on ANY tier (a key that
// exists must carry a real value, whether or not priority is high).
//
// `now` (default `new Date()`, threaded through to isValidPriorityByValue's future-date check) is
// injectable so a test pins "today" instead of depending on the machine clock (the CLAUDE.md
// ambient-environment rule).
export function priorityStampProblem(content, { now } = {}) {
  const tier = readPriorityTier(content);
  const rawBy = readPriorityBy(content);
  if (hasFrontmatterKey(content, 'priorityBy') && !rawBy) return 'bad-priorityBy-value';
  if (rawBy && !isValidPriorityByValue(rawBy, { now })) return 'bad-priorityBy-value';
  if (tier === 'high' && !rawBy) return 'unbacked-high';
  if (tier !== 'high' && rawBy) return 'stale-priorityBy';
  return null;
}

// review fix round 1 (key 32672c): the fix sentence for a priorityBy: problem must be
// TIER-AWARE. `problem` is 'unbacked-high' (tier is always 'high' by priorityStampProblem's own
// contract) or 'bad-priorityBy-value' (tier can be anything — a bad VALUE can land on a
// medium/low plan whose `priority:` stamp itself is fine). Suggesting `--find "priority: high"
// --replace "priority: medium"` on a plan that has no `priority: high` line to find is nonsense,
// so the demote suggestion is offered ONLY when tier is actually 'high'. Shared by BOTH callers
// (lint-plan-priority.mjs's findUnbackedHigh, next-plan-id.mjs's mint refusal) so the guidance —
// and the tier branch — can never drift apart between the push-time and mint-time gates.
// Returns `{ guidance, demoteApplicable }`: `guidance` is a bare clause (no leading "Fix with:",
// no trailing period — callers compose their own sentence around it, since next-plan-id's mint
// refusal and the lint's push-time message are worded in different voices), `demoteApplicable`
// tells the caller whether ITS OWN demote-suggestion mechanics (an `edit-plan.mjs --find/--replace`
// command for the lint, a bare "drop back to priority: medium" for the mint refusal) apply.
export function priorityStampFixHint(problem, tier) {
  const priorityByShapes =
    '`operator <YYYY-MM-DD>` for an explicit operator go that day (not a future date), or ' +
    `\`directive <name>\` for a standing class — today only ${PRIORITY_BY_DIRECTIVES.join(', ')}`;
  if (problem === 'unbacked-high') {
    return {
      guidance: `add a legal \`priorityBy:\` line (${priorityByShapes})`,
      demoteApplicable: true,
    };
  }
  if (problem === 'bad-priorityBy-value') {
    if (tier === 'high') {
      return {
        guidance: `fix the \`priorityBy:\` value (must be ${priorityByShapes})`,
        demoteApplicable: true,
      };
    }
    return {
      guidance:
        `correct the \`priorityBy:\` value (must be ${priorityByShapes}), or remove the ` +
        '`priorityBy:` line entirely — priority is not high, so none is required',
      demoteApplicable: false,
    };
  }
  return null;
}

// Escape regex metacharacters in an arbitrary string used to build a RegExp — a
// public param (a frontmatter key, a slug, a filename) would otherwise silently
// match the wrong thing if it happened to contain one. Shared by the read side
// (readFrontmatterKey) and the write side (upsertFrontmatterKey) so the two can
// never disagree on which keys match, AND by every other script in `scripts/`
// that used to carry its own copy of this identical one-liner (plan 1328 folded
// next-plan-id.mjs's `escapeRe`, drain-run.mjs's `repathPlanClaimCell` helper,
// done-worktree-lib.mjs's four call sites, and check-coordination-branch.mjs's
// `coordinationRx` helper into this single export).
export function escapeRegex(key) {
  return key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Locate a terminated leading `---` frontmatter block in `lines` (content split on
// '\n'). A fence is a line that is EXACTLY `---` at column 0 (trailing whitespace
// tolerated, LEADING whitespace NOT) — a `----` dash rule, a `---text` line, or an
// INDENTED `  ---` is NOT a fence. Returns the index of the CLOSING fence line, or
// -1 when there is no leading block or it is unterminated. THE single fence rule,
// shared by the read side (readFrontmatterKey), the write side
// (upsertFrontmatterKey), and plan-body-state's status-line insertion — the 1304
// review found the rule drifting across hand-rolled scans (loose
// `startsWith('---')`/`indexOf('\n---')` variants corrupted bodies whose prose
// contains dash lines), so it lives here once. The leading-whitespace exclusion
// (plan 1328 sonnet-review finding) matters specifically for a YAML block-scalar
// value (`summary: |`) whose indented body happens to contain a markdown rule —
// trimming leading space would misdetect that indented `---` as the real closing
// fence and splice a merged key into the middle of the value, corrupting it.
const isFenceLine = (line) => (line ?? '').replace(/\s+$/, '') === '---';
export function frontmatterEnd(lines) {
  if (!isFenceLine(lines[0])) return -1;
  for (let i = 1; i < lines.length; i++) {
    if (isFenceLine(lines[i])) return i;
  }
  return -1;
}

// Merge a single `key: value` scalar into a leading `---` YAML frontmatter block —
// replacing an existing `key:` line in place, appending inside an existing block
// (never clobbering sibling keys), or creating a fresh block when the body has
// none. A fence is a line that is EXACTLY `---` (modulo surrounding whitespace) —
// a `----` dash rule or `---text` first line is NOT frontmatter, and an
// unterminated opening fence isn't either → a new block is prepended above it.
// (The 1304 review confirmed the looser `startsWith('---')` check corrupted a
// minted body that opened with a dash rule and used a later `---` divider —
// frontmatter got spliced into prose. Exact line-fences, both ends, as
// readFrontmatterKey already required.)
//
// This is THE shared write-side twin of readFrontmatterKey (plan 1304):
// plan-body-state's setUnblock, next-plan-id's ensure*Frontmatter, and
// stamp-exec-model's setFrontmatterKey all delegate here, so edge-case fixes
// (comment handling, colon-in-value, unterminated block) land once instead of
// drifting across four hand-rolled copies (the plan-1292 review, finding 7).
// stamp-plan-seedwrite.mjs exports a same-NAMED upsertFrontmatterKey with a
// DIFFERENT contract — { content, changed, noFrontmatter }, never fabricates a
// block — but since plan 1328 it's a thin wrapper delegating to THIS function;
// don't import the wrong one when only a bare string result is wanted.
//
// Options:
//   preserveComment (default true) — plan-1292 semantics: a trailing YAML inline
//     comment on the replaced line (e.g. plan 1015's `execModel: fable # umbrella
//     tracker — NOT drain-eligible`) is the operator's guard annotation. Keep it
//     ONLY when the new value equals the old (an idempotent re-stamp); a genuine
//     value change drops the now-stale annotation rather than stapling it onto a
//     value it no longer describes.
//   keepExisting (default false) — "ensure" semantics (next-plan-id's mint-time
//     stamps): when the key already exists in the block, return the body
//     unchanged — an author's hand-written value always wins over the stamp.
export function upsertFrontmatterKey(
  content,
  key,
  value,
  { preserveComment = true, keepExisting = false } = {},
) {
  // EOL-aware wholesale (plan 1328): split on \r?\n and re-join with the file's
  // OWN line ending, so a CRLF plan round-trips CRLF and a spliced-in key line
  // never ends up LF-only inside an otherwise-CRLF file (the bug a per-line `\r`
  // slice/re-append dance would leave behind).
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const line = `${key}: ${value}`;
  const lines = content.split(/\r?\n/);
  const end = frontmatterEnd(lines);
  if (end !== -1) {
    // `^key:` (not `^key: `) so a no-space `key:value` line is replaced, not
    // duplicated — the same lines readFrontmatterKey's `^key:\s*(.*)$` matches.
    const rxKey = new RegExp(`^${escapeRegex(key)}:`);
    for (let i = 1; i < end; i++) {
      if (!rxKey.test(lines[i])) continue;
      if (keepExisting) return content;
      const commentM = preserveComment ? lines[i].match(/\s+#.*$/) : null;
      const oldValue = lines[i]
        .slice(key.length + 1)
        .replace(/\s+#.*$/, '')
        .trim();
      const unchanged = oldValue === String(value).trim();
      lines[i] = commentM && unchanged ? `${line}${commentM[0]}` : line;
      return lines.join(eol);
    }
    // Key absent → merge in just before the closing fence, preserving siblings.
    lines.splice(end, 0, line);
    return lines.join(eol);
  }
  return `---${eol}${line}${eol}---${eol}${eol}${content}`;
}

// plan 4202: the ONE reason sentence for a real specReview sha stamped with an undeclared
// provenance. Plan 3943 introduced this refusal only at claim time (checkStubClaimGate,
// claim-plan-lib.mjs) — every other lifecycle surface kept reading the OLDER, narrower gate
// below (which only ever looked at `stage`/`specReview`, never `specReviewBy`), so a plan
// the board/oracle/move-plan/next-plan-id promised as eligible was hard-refused the moment
// it was actually claimed. `lead` is the caller's own sentence-subject: checkStubClaimGate
// (the one surface with an operator-override lane) passes the bare word 'plan' and sets
// `stubOkHint`; every other caller goes through specReviewGateErrorFromValues below, which
// builds `lead` as `${context} ${basename}` and never sets the hint (design: "the oracle/
// move-plan messages do NOT offer --stub-ok").
export function undeclaredProvenanceReason(lead, specReview, { stubOkHint = false } = {}) {
  return (
    `${lead} has specReview: ${specReview} but specReviewBy: undeclared — a spec-pass of ` +
    `unknown provenance cannot be drained (plan 3943, closing the same gap plan 1427 Gate 2 ` +
    `closed for a bare stub; plan 4202 hoisted the check into this shared core). Run a real ` +
    `spec-pass and stamp --provenance "<model>/<effort>" (/spec-pass)` +
    (stubOkHint ? `, or claim with --stub-ok "<authorization note>".` : `.`)
  );
}

// plan 4202: classifies which (if either) of the two lifecycle gates a plan trips, so a
// caller that needs the EXCLUDE CODE — not just a human-readable message — can tell "no
// spec-pass ran at all" (a bare stub) apart from "a spec-pass ran, but of undeclared
// provenance" (queue-drain.mjs's oracle reports these as distinct codes, 'stub' vs
// 'provenance', so the board and the drain routine point the operator at the right fix).
// specReviewGateErrorFromValues below is built ON TOP of this — the two can never drift.
//
// Order (case-INSENSITIVE on stage/specReview/specReviewBy):
//   1. specReview: exempt-mechanical (any case) → null, always — a self-declared no-judgment
//      exemption is never gated on provenance (checkStubClaimGate's own 🟥 pipelineFields
//      narrowing over exempt-mechanical stays claim-only, plan 4202 design 5).
//   2. a real (non-exempt) specReview value stamped with specReviewBy: undeclared → 'provenance',
//      checked BEFORE the stage gate below so it fires on `stage: specced` too, not only `stub`.
//   3. stage absent/empty or not 'stub' → null (legacy grandfather / already past stub).
//   4. stage: stub with any other specReview value (a sha, or an absent specReviewBy — the
//      grandfathered legacy shape for every plan stamped before plan 3004) → null.
//   5. stage: stub with no specReview at all → 'stub'.
export function specReviewGateCode(stage, specReview, specReviewBy) {
  if (specReview && String(specReview).toLowerCase() === 'exempt-mechanical') return null;
  if (specReview && String(specReviewBy || '').toLowerCase() === 'undeclared') return 'provenance';
  if (!stage || stage.toLowerCase() !== 'stub') return null;
  if (specReview) return null;
  return 'stub';
}

// Shared plan-lifecycle spec-pass gate (plan 1292 bugfix — previously
// duplicated, case-sensitively and without comment-stripping, at both call
// sites below). Pure core: takes already-normalized `stage`/`specReview`
// scalars (as `readFrontmatterScalar` returns them) so a caller that already
// parsed the frontmatter for its own purposes (e.g. queue-drain's
// parsePlanMeta) doesn't have to re-parse the same content a second time just
// to run the gate. `context` is a caller-supplied lead-in sentence (ending
// short of the basename) so each caller's message stays in its own voice;
// `basename` is the plan's filename. Returns an actionable error string when
// stage is `stub` with no specReview stamp, OR when a real specReview is
// stamped with specReviewBy: undeclared (plan 4202 hoist — see
// specReviewGateCode above for the full rule and order), else null.
//
// Rule (case-INSENSITIVE on stage, per plan 1292 Conventions):
//   - stage absent/empty (legacy plan, minted before this gate landed) → null.
//   - stage present but not 'stub' (already past stub, e.g. 'specced') → null,
//     UNLESS a real specReview carries specReviewBy: undeclared (plan 4202).
//   - stage: stub WITH any specReview value (a sha, or the self-declared
//     'exempt-mechanical' for a no-judgment mechanical plan) → null, again
//     unless that sha's specReviewBy is undeclared.
//   - stage: stub WITHOUT a specReview stamp → the actionable message.
// `options.specReviewBy` is OPTIONAL (a 5th, options-shaped argument — every
// pre-4202 caller passes only 4 positional args and keeps its old behaviour
// untouched: an absent specReviewBy can never read as 'undeclared').
export function specReviewGateErrorFromValues(
  stage,
  specReview,
  basename,
  context,
  { specReviewBy } = {},
) {
  const code = specReviewGateCode(stage, specReview, specReviewBy);
  if (code === 'provenance') {
    return undeclaredProvenanceReason(`${context} ${basename}`, specReview);
  }
  if (code === 'stub') {
    return (
      `${context} ${basename} — stage: stub without a specReview stamp. Run /spec-pass (then ` +
      `scripts/stamp-exec-model.mjs) or stamp 'specReview: exempt-mechanical' for a no-judgment ` +
      `mechanical plan.`
    );
  }
  return null;
}

// Thin wrapper over specReviewGateErrorFromValues for callers that only have
// raw plan `content` on hand (move-plan.mjs, next-plan-id.mjs) — reads the
// three scalars via readFrontmatterScalar (comment-stripped + unquoted) then
// delegates. Callers that already derived stage/specReview for their own use
// (queue-drain's parsePlanMeta) should call specReviewGateErrorFromValues
// directly instead of re-parsing content here.
export function specReviewGateError(basename, content, context) {
  const stage = readFrontmatterScalar(content, 'stage');
  const specReview = readFrontmatterScalar(content, 'specReview');
  const specReviewBy = readFrontmatterScalar(content, 'specReviewBy');
  return specReviewGateErrorFromValues(stage, specReview, basename, context, { specReviewBy });
}

// Return content with a leading `---`…`---` YAML frontmatter block removed, so
// banner/marker scanning stays out of metadata (a plan's `summary:` may quote a
// SEED-WRITE banner verbatim — plan 723). No leading frontmatter, or an
// unterminated one, ⇒ content returned unchanged. Exported (plan 2360) so the
// cost-banner parser (queue-drain.mjs's parsePlanMeta) can apply the SAME
// frontmatter-shadow guard readSeedWriteValue already uses below, rather than
// a second, independently-drifting technique.
//
// Fence detection is `isFenceLine`/`frontmatterEnd` above — THE single fence rule
// (plan 2368). This function used to carry its own second literal that trimmed BOTH
// ends of a candidate fence, so an INDENTED `---` closed the block here while
// `isFenceLine` (trailing whitespace only, since plan 1328) said it did not. That
// drift is bug 2 of plan 2368: a YAML block scalar (`summary: |` / `summary: >`)
// whose indented content contains a `---` line ended the frontmatter early, and
// everything after it — still frontmatter — was handed back as "body", so a banner
// quoted inside the scalar could parse as the real one. Block-scalar content is
// always indented relative to its key, which is exactly why plan 1328 excluded
// leading whitespace on the write side; reusing that rule here closes the read side
// without a second, independently-drifting literal (and without a YAML parser).
//
// Consequence, intended: a file with an indented closing fence now reads as having
// NO frontmatter in EVERY consumer (it already did in readFrontmatterKey /
// upsertFrontmatterKey / frontmatterEnd — this was the outlier), so the detectors
// can no longer disagree with each other. Verified byte-identical against the old
// implementation over all 2414 tracked plan files: no real plan relies on the
// leading-indent tolerance.
export function stripFrontmatter(content) {
  const lines = content.split('\n');
  const end = frontmatterEnd(lines);
  return end === -1 ? content : lines.slice(end + 1).join('\n');
}

// Split `content` into its leading frontmatter block (verbatim, including the
// closing fence) and the remainder — the shared form of the `stripFrontmatter` +
// length-diff-slice pattern that used to be copy-pasted (and independently
// hand-derived) across claim-plan-lib.mjs's flipStatusToInProgress and
// plan-body-state.mjs's setStatusLine (plan 2392). `prefix` is `''` when there is
// no leading frontmatter block (or it is unterminated) — `stripFrontmatter`
// returns `content` unchanged in that case, so `prefix` falls out to `''` and
// `body` to the original `content`, exactly like each cousin's own derivation.
export function splitFrontmatter(content) {
  const body = stripFrontmatter(content);
  const prefix = content.slice(0, content.length - body.length);
  return { prefix, body };
}

// Replace exactly the substring `match` (a regex match object, so it carries
// both `.index` and `.length` via `match[0]`) within `text` with `replacement`
// — the shared "splice at a known position" primitive behind every
// match.index-based splice in claim-plan-lib.mjs's flipStatusToInProgress and
// plan-body-state.mjs's setStatusLine (plan 2392 review finding 5). Splicing
// by position rather than `text.replace(match[0], replacement)` is what
// guarantees a SECOND, stale occurrence of the same matched text elsewhere in
// `text` can never mis-target the splice (finding 3's fix) — this helper just
// gives that one line of arithmetic a single name instead of four
// independently re-derived copies.
export function spliceAtMatch(text, match, replacement) {
  return text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
}

// Insert `insertion` right after a leading frontmatter block, or prepend it
// when there is none — the shared "no anchor" fallback for claim-plan-lib.mjs's
// flipStatusToInProgress and plan-body-state.mjs's setStatusLine (plan 2392
// round-6 review, findings 2/3/4/5). Both cousins used to independently
// re-derive "is there a frontmatter block, and where does it end" for this one
// fallback branch via a SEPARATE frontmatterEnd() line-array scan, even though
// every OTHER branch in the same function already answers that from
// splitFrontmatter. Routing both cousins through splitFrontmatter here means
// every branch of both functions agrees on what counts as frontmatter, always —
// and it closes the redundant second scan (finding 3) and the copy-pasted
// fallback (finding 4) in the same move.
//
// The two detectors used to be able to DISAGREE (frontmatterEnd's isFenceLine
// trims only trailing whitespace off a candidate fence; stripFrontmatter carried
// its own literal that trimmed both ends), which is why plan 2392 insisted on the
// splitFrontmatter route. Plan 2368 removed the second literal — stripFrontmatter
// now delegates to frontmatterEnd — so there is ONE fence rule and the
// disagreement is gone at the source. Keeping this helper on splitFrontmatter is
// still right (one call, one answer, both cousins), it just no longer papers over
// a divergence.
export function insertAfterFrontmatterOrPrepend(content, insertion) {
  const { prefix, body } = splitFrontmatter(content);
  return prefix ? `${prefix}${insertion}\n\n${body}` : `${insertion}\n\n${body}`;
}

// Unquote a single-line YAML scalar the way prettier emits it. Prettier picks
// double- vs single-quotes per string to minimise escaping, so the parser must
// handle BOTH or build-index drifts the moment lint-staged reformats a plan's
// frontmatter (the 2026-05-31 single-quote drift). YAML rules: in "double" a
// backslash escapes; in 'single' a doubled '' is one literal quote.
// Exported (plan 2679 review) so a reader that must NOT strip trailing inline
// comments — trip-status.mjs, whose `tripCheck:` values legitimately contain a
// literal `#` inside quotes — can still share the ONE quote-unescape rule
// instead of re-deriving it. readFrontmatterScalar's comment-strip is the part
// that reader opts out of; the unquoting below is not.
export function unquoteYaml(s) {
  if (s.length >= 2 && s[0] === '"' && s.at(-1) === '"') {
    return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (s.length >= 2 && s[0] === "'" && s.at(-1) === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

export function readH1(content) {
  // First markdown H1, skipping any frontmatter block.
  const m = content.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : '';
}

// One markdown "find a heading, take everything to the next heading" scanner
// (plan 2052), shared by plan-body-state's sectionHasContent, batches-view's
// sliceAfterHeading, and lint-plan-index's archive-narrative region bound —
// those three were hand-rolled independently with three different boundary
// rules that already disagreed (level-aware vs exactly-one-level vs
// level-blind).
//
// The rule, unified (ruling R1): a heading of the SAME OR SHALLOWER level ends
// the section (a DEEPER sub-heading is content, not a boundary — plan 2034's
// finding: a naturally-structured `## Grill questions` body whose first line
// is a `### Fork: …` sub-heading must not read as empty); AND heading
// detection is fence-aware — a line inside a ``` fenced code block is never a
// heading, even one starting with `#`. Fence-awareness is load-bearing, not
// cosmetic: `docs/superpowers/batches/dependencies.md` carries a
// ` ```dependencies ` fence whose interior board-pass comment lines start
// `# Reconciled …`; a level-aware scan WITHOUT fence-awareness misreads those
// as H1 section terminators and truncates the fence, silently emptying every
// parsed cross-batch dependency edge.
//
// The one heading-level literal both functions below key off — kept as a
// single constant so the two can never again drift the way the pre-2052
// three copies did (review finding, plan 2052). Exported since plan 2368 for
// the same reason: queue-drain.mjs's close-out-tail scan needs BOTH literals
// (heading depth + fence state), and a third hand-rolled copy there would
// re-open the fenced-heading hazard this pair exists to close.
export const HEADING_LEVEL_RX = /^(#{1,6})\s/;
export const FENCE_DELIM_RX = /^```/;

// Fence state is tracked from the START of `text` (index 0), never from
// `fromIndex` — a fence opened before `fromIndex` can still be open AT
// `fromIndex`, and scanning only the tail would lose that context. A caller
// that pre-slices `text` before calling this (rather than passing the true
// document and an offset into it) reintroduces exactly the bug this contract
// exists to prevent — see lint-plan-index.mjs's boundArchiveRegion for the
// one call site that must honor it.
export function nextHeadingBoundary(text, fromIndex, level) {
  const src = String(text);
  const lines = src.split('\n');
  let pos = 0;
  let inFence = false;
  for (const line of lines) {
    const lineStart = pos;
    pos += line.length + 1; // +1 for the '\n' this split consumed
    if (FENCE_DELIM_RX.test(line)) {
      inFence = !inFence;
      continue; // a fence delimiter line is never itself a heading
    }
    if (inFence || lineStart < fromIndex) continue;
    const m = HEADING_LEVEL_RX.exec(line);
    if (m && m[1].length <= level) return lineStart;
  }
  return src.length;
}

// Heading-anchored sibling of nextHeadingBoundary: finds the first line
// matching `headingRx`, then bounds the section that follows it at that
// heading's own level. `start` is the index right after the heading's own
// line (its content begins there, leading with the '\n' the line consumed —
// matching the pre-extraction per-site convention); `end` is the section
// boundary; `level` is the matched heading's depth. Returns null when no
// heading matches `headingRx`.
//
// Fence-aware for BOTH halves of the job — finding the anchor and finding
// the end boundary — in one shared pass (review finding, plan 2052: an
// earlier version anchored with a plain per-line `.test()` with no fence
// tracking at all, so a heading-shaped line inside a fenced doc example
// could be matched as the section start; delegating the end-boundary half to
// nextHeadingBoundary would also double-scan the whole document, since that
// function always restarts from index 0 to keep its own fence tracking
// honest). The scan itself lives in multiSectionBounds below (plan 2083,
// the general N-heading form) — this is a thin single-regex delegate, kept
// so the two can never again drift apart the way the pre-2052 three copies
// did (review finding, plan 2083).
export function sectionBounds(content, headingRx) {
  return multiSectionBounds(content, [headingRx]).get(headingRx) ?? null;
}

// Multi-heading sibling of sectionBounds (plan 2083): resolves bounds for SEVERAL
// heading regexes from ONE fence-aware pass over `content`, instead of a caller
// running sectionBounds once per regex — each of which re-scans the whole
// document from scratch (batches-view's parseProposedMd was doing exactly that,
// four times over the same proposed.md text). Per-regex semantics are identical
// to sectionBounds: the first line matching a given headingRx anchors that
// section, which ends at the next heading of the same-or-shallower level (any
// heading, not just ones matching the same regex) or EOF.
//
// Returns a Map keyed by the input regex objects (by reference) to their
// `{start, end, level}` bounds; a regex with no matching heading is simply
// absent from the map (mirrors sectionBounds' `null` return, without a
// hole-y array).
export function multiSectionBounds(content, headingRxList) {
  const text = String(content);
  const lines = text.split('\n');
  const boundaryHeadings = []; // every HEADING_LEVEL_RX line, fence-aware — boundary candidates
  const anchors = new Map(); // headingRx -> first matching line's {lineStart, lineEnd, level}
  let pos = 0;
  let inFence = false;
  for (const line of lines) {
    const lineStart = pos;
    const lineEnd = lineStart + line.length;
    pos += line.length + 1;
    if (FENCE_DELIM_RX.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const levelMatch = HEADING_LEVEL_RX.exec(line);
    if (levelMatch) boundaryHeadings.push({ lineStart, level: levelMatch[1].length });
    for (const headingRx of headingRxList) {
      if (anchors.has(headingRx) || !headingRx.test(line)) continue;
      anchors.set(headingRx, { lineStart, lineEnd, level: levelMatch ? levelMatch[1].length : 1 });
    }
  }
  const result = new Map();
  for (const headingRx of headingRxList) {
    const anchor = anchors.get(headingRx);
    if (!anchor) continue;
    let end = text.length;
    for (const b of boundaryHeadings) {
      if (b.lineStart <= anchor.lineStart || b.level > anchor.level) continue;
      end = b.lineStart;
      break;
    }
    result.set(headingRx, { start: anchor.lineEnd, end, level: anchor.level });
  }
  return result;
}

// THE single seed-banner parse (plan 1324, folding 1288). Every consumer of a
// plan's SEED-WRITE banner — readSeedMarker below (docs/INDEX.md bullets, the
// stamp-plan-seedwrite frontmatter mirror) AND queue-drain's parsePlanMeta (the
// LANDING mutex / drain sort) — routes through this one function, so the two
// surfaces can never again disagree about what a banner says (the 2026-07-02
// plans-1278/1282 drift: `SEED-WRITE: conditional` / `: MAYBE` rendered 🟩 in
// INDEX while the drain mutexed them as 🟥). Follows the plan-1260 cost-banner
// "SINGLE authority" precedent.
//
// Returns 'yes' | 'no' | 'maybe' | null (null = no banner found). Precedence:
//   1. explicit machine-readable value `SEED-WRITE: YES|NO|MAYBE` — wins over
//      any banner emoji (plan 362). The colon is REQUIRED (the match is
//      first-anywhere-in-body, and prose like "the SEED-WRITE yes/no forms"
//      ahead of the real banner must not override it — review finding, plan
//      1324; the colon-less live form `🟥 SEED-WRITE yes` still parses via its
//      emoji below). Emphasis runs (`**`/`***`) may fall on EITHER side of the
//      colon, unbounded (plan 723; queue-drain's old parser took `***…***` —
//      capping at 2 would silently regress it), and the `\b` guard keeps
//      `SEED-WRITE: nothing` from half-matching as NO. Authors keep inventing
//      other values (`conditional`, `possibly`) — those deliberately do NOT
//      match and fall through to the emoji.
//   2. the 🟥/🟩 emoji on ANY line mentioning SEED-WRITE, bold-banner form
//      first (the documented bare form `> 🟥/🟩 **SEED-WRITE**`), then a loose
//      match regardless of bold/colon placement — so an unparseable value like
//      `> 🟥 **SEED-WRITE: conditional**` classifies by its emoji instead of
//      silently falling to the 🟩 default. A 🟥-emoji banner must never parse
//      as merges-freely.
// `body`, when supplied, is a pre-stripped `stripFrontmatter(content)` result
// the caller already computed (plan 2360: queue-drain's parsePlanMeta strips
// once and reuses it for BOTH the SEED-WRITE and cost-banner parses, rather
// than re-splitting the same content twice per plan scanned). Omitting it
// (every other call site) computes it fresh, unchanged from before.
export function readSeedWriteValue(content, body = stripFrontmatter(content)) {
  // Scan only the plan BODY, never the leading YAML frontmatter: a plan whose
  // `summary:` quotes a SEED-WRITE banner verbatim (plan 723 itself describes
  // the `**SEED-WRITE:** yes/no` form) would otherwise have its metadata text
  // mistaken for the banner. The real banner is always a top-of-body line, so
  // the first body match is authoritative.
  // plan 3960 cluster-2 review fix: the label is now MUTATION_BANNER_LABEL
  // (coord.config.json's mutationBanner.label, defaulting to today's exact "SEED-WRITE") —
  // this was the "authoritative banner PARSER" the review named as still hardcoding the
  // literal while SEED_BANNER_ANCHOR_RX alone had been made configurable.
  const label = escapeRegex(MUTATION_BANNER_LABEL);
  const explicit = body.match(new RegExp(`${label}\\**:\\**\\s*(YES|NO|MAYBE)\\b`, 'i'));
  if (explicit) return explicit[1].toLowerCase();
  const banner =
    body.match(new RegExp(`(🟥|🟩)[^\\n]*\\*\\*${label}\\*\\*`, 'u')) ??
    body.match(new RegExp(`(🟥|🟩)[^\\n]*${label}`, 'u'));
  if (banner) return banner[1] === '🟥' ? 'yes' : 'no';
  return null;
}

// 🟥 when the plan writes seed, 🟩 when it merges freely — the INDEX-bullet /
// Bases-mirror rendering of readSeedWriteValue above. MAYBE renders 🟥 (an
// unsure plan must show as seed-lane, matching the drain's conservative mutex).
// No banner at all defaults 🟩 (plan 362 — the merges-freely assumption; caller
// may warn). That default is display-side ONLY: queue-drain keeps treating a
// missing banner as seed-write for mutex purposes (unknown must not land during
// a LANDING) — the one deliberate, documented divergence.
export function readSeedMarker(content, { seedLane = true } = {}) {
  if (!seedLane) return '🟩'; // no seed lane ⇒ every plan merges freely
  const value = readSeedWriteValue(content);
  if (value === null) return '🟩';
  return value === 'no' ? '🟩' : '🟥';
}

// Numeric plan id from a basename like "007-P07-foo.md" → 7. `\d{3,}` covers 4-digit
// ids (plan 1000+); the `(?=[A-Za-z])` lookahead requires a letter-category after the
// dash so a legacy date-prefixed name ("2026-05-17-...", where `\d{2}` follows) still
// falls through to Infinity and sorts after numeric ids.
export function planIdOf(basename) {
  const m = basename.match(/^(\d{3,})-(?=[A-Za-z])/);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

// Render one bullet in the canonical shape the existing index-lib.mjs already
// parses (`- <marker> <text> → \`<status>/<basename>\``), so index.mjs
// get/move/archive stay compatible through the transition.
//
// plan 2678: a categorised plan renders its REAL relative path
// (`- 🟩 … → \`parked/denmark/9-X-y.md\``) rather than a flattened `<status>/<basename>`.
// That was the explicit decision: INDEX/board refs are links an operator clicks in
// Obsidian or an editor, so a ref that doesn't resolve on disk is worse than a longer
// one — and every ref CONSUMER derives status from segment 0 anyway (classifyPlanRel).
// `category` is absent/null for the flat default, which keeps this byte-identical.
export function renderBullet({ marker, summary, status, category, basename }) {
  return `- ${marker} ${summary} → \`${planRelFor({ status, category, basename })}\``;
}

// Build the full generated block (sentinels + grouped bullets) from a flat list
// of plan records: { status, category?, basename, marker, summary }. Grouped by
// STATUS_ORDER, sorted by numeric plan id ascending within each group. Unknown
// statuses are dropped (archive/ and anything off-convention).
//
// plan 2678: grouping stays by STATUS ONLY — a category folder is a filesystem
// browsing affordance, not an INDEX section. Sub-grouping by category would split
// each status group's id ordering (the one thing the operator scans this list by)
// across sub-headings for no gain; the category is visible in each bullet's own path.
export function renderPlansBlock(plans) {
  const byStatus = new Map(STATUS_ORDER.map((s) => [s, []]));
  for (const p of plans) {
    if (!byStatus.has(p.status)) continue;
    byStatus.get(p.status).push(p);
  }
  const out = [INDEX_PLANS_START, ''];
  for (const status of STATUS_ORDER) {
    const group = byStatus.get(status);
    if (group.length === 0) continue;
    group.sort(
      (a, b) => planIdOf(a.basename) - planIdOf(b.basename) || a.basename.localeCompare(b.basename),
    );
    out.push(`**${status}/**`, '');
    for (const p of group) out.push(renderBullet(p));
    out.push('');
  }
  out.push(INDEX_PLANS_END);
  return out.join('\n');
}

// Splice the generated block into existing INDEX content. If the sentinels are
// present, replace everything between them (inclusive). Otherwise insert the
// block at `fallbackInsert(lines)` — by default just before the archive header.
export function splicePlansBlock(indexContent, block, fallbackInsert = defaultInsertIndex) {
  const lines = indexContent.split('\n');
  const startIdx = lines.findIndex((l) => l.includes(INDEX_PLANS_START));
  const endIdx = lines.findIndex((l) => l.includes(INDEX_PLANS_END));
  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    const before = lines.slice(0, startIdx);
    const after = lines.slice(endIdx + 1);
    return [...before, block, ...after].join('\n');
  }
  // First-time insertion: place the block just before the archive header.
  const at = fallbackInsert(lines);
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  return [...before, block, '', ...after].join('\n');
}

function defaultInsertIndex(lines) {
  const i = lines.findIndex((l) => ACTIVE_END_RX.test(l));
  return i === -1 ? lines.length : i;
}

// ── Specs region (plan 856) ─────────────────────────────────────────────────
// docs/INDEX.md's spec list was hand-maintained ABOVE the plans region and drifted
// silently — 13 specs dated 2026-06-09…06-19 were missing at the 2026-06-19 audit.
// It is now GENERATED the same way the plans region is: every tracked file under
// docs/superpowers/specs/ becomes a bullet — split Active (top-level) vs Archive
// (archive/…) — with a blurb pulled from frontmatter `summary:` / `title:` / the
// first `# ` H1. The hand-curated prose that ISN'T per-spec enumeration (the
// intro + the "scheduled as a plan" note) stays OUTSIDE the sentinels.
export const INDEX_SPECS_START =
  '<!-- INDEX:SPECS-START (generated by scripts/build-index.mjs — do not hand-edit between the sentinels) -->';
export const INDEX_SPECS_END = '<!-- INDEX:SPECS-END -->';

export const SPECS_PREFIX = 'docs/superpowers/specs/';

// First-time-insertion anchor: the "## Plans" header that follows the specs
// section. Mirrors ACTIVE_END_RX's role for the plans block.
const SPECS_FALLBACK_RX = /^## Plans\b/;

// Blurb for one spec bullet. Frontmatter `summary:` (parity with the plans parser;
// no spec carries one today) → frontmatter `title:` → first `# ` H1 → '(no summary)'.
// `source` lets the CLI warn on a spec with no usable blurb.
export function parseSpecMeta(content) {
  const summary = readFrontmatterSummary(content);
  if (summary) return { blurb: summary, source: 'summary' };
  const title = readFrontmatterKey(content, 'title');
  if (title) return { blurb: title, source: 'title' };
  const h1 = readH1(content);
  if (h1) return { blurb: h1, source: 'h1' };
  return { blurb: '(no summary)', source: 'none' };
}

// active = directly under specs/; archive = anywhere under specs/archive/.
// `displayPath` is the path relative to docs/superpowers/specs/.
export function specBucket(displayPath) {
  return displayPath.startsWith('archive/') ? 'archive' : 'active';
}

// Build the generated specs block (sentinels + two grouped lists) from a flat list
// of records { displayPath, blurb }. Sorted by displayPath within each group, which
// — given the YYYY-MM-DD filename prefix — renders chronologically.
export function renderSpecsBlock(specs) {
  const byBucket = { active: [], archive: [] };
  for (const s of specs) byBucket[specBucket(s.displayPath)].push(s);
  // Codepoint sort (NOT localeCompare): deterministic across platforms/ICU, so the
  // generated order is byte-identical on a Windows author machine and CI Linux —
  // otherwise `build-index --check` could drift on CI over the ~74-item list.
  for (const group of Object.values(byBucket))
    group.sort((a, b) =>
      a.displayPath < b.displayPath ? -1 : a.displayPath > b.displayPath ? 1 : 0,
    );
  const out = [INDEX_SPECS_START, '', '**Active** (`docs/superpowers/specs/`)', ''];
  for (const s of byBucket.active) out.push(`- \`${s.displayPath}\` — ${s.blurb}`);
  out.push('', '**Archive** (`docs/superpowers/specs/archive/`)', '');
  for (const s of byBucket.archive) out.push(`- \`${s.displayPath}\` — ${s.blurb}`);
  out.push('', INDEX_SPECS_END);
  return out.join('\n');
}

// Splice the generated specs block into INDEX content. Mirrors splicePlansBlock:
// replace between existing sentinels, else first-time-insert just before "## Plans".
export function spliceSpecsBlock(indexContent, block, fallbackInsert = defaultSpecsInsertIndex) {
  const lines = indexContent.split('\n');
  const startIdx = lines.findIndex((l) => l.includes(INDEX_SPECS_START));
  const endIdx = lines.findIndex((l) => l.includes(INDEX_SPECS_END));
  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    const before = lines.slice(0, startIdx);
    const after = lines.slice(endIdx + 1);
    return [...before, block, ...after].join('\n');
  }
  const at = fallbackInsert(lines);
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  return [...before, block, '', ...after].join('\n');
}

function defaultSpecsInsertIndex(lines) {
  const i = lines.findIndex((l) => SPECS_FALLBACK_RX.test(l));
  return i === -1 ? lines.length : i;
}

// ── pre-push plan-lint diff-scoping (plan 2540) ─────────────────────────────
//
// lint-plan-priority.mjs and lint-filename-execmodel-drift.mjs both need to scope their
// scan to the pushed diff instead of the whole tracked plan corpus. The function below is
// the ONE shared copy (a first draft duplicated it verbatim per file — the exact "each
// consumer rediscovers the same bugs independently" drift class read-plan-stamps.mjs's own
// header names as the reason cross-lint-script plan helpers live here, alongside
// readFrontmatterScalar/isValidPriorityValue that both files already import from this
// module).

// Resolves a pre-push hook's piped `$CHANGED` list (one repo-relative path per line — the
// same contract select-battery-tests.mjs's parseChangedList already owns, reused here
// rather than re-parsed by hand) to either `null` (the caller should run its full corpus
// sweep) or the subset of changed paths under `plansPrefix` ending in `.md` to scope a
// plan lint's scan to. Pure — TTY detection (an interactive manual run, where reading fd 0
// would hang) is the caller's job; this only ever sees `rawStdin` already read.
//
// Full sweep is forced (`null`) in TWO cases, each fail-SAFE — never a silent under-scan:
//   1. `rawStdin` is malformed (parseChangedList throws) — a shell-mangled or NUL-joined
//      `$CHANGED` must never silently narrow the scan.
//   2. any changed path matches one of `toolingPaths` — the lint script's own source, or
//      a shared module it reads its rules from. A push that changes the lint's OWN logic
//      must re-validate the WHOLE corpus against that new logic, not just whatever plan
//      happened to ride along in the same push — narrowing to the touched plan alone
//      would let a regressed lint ship silently past every pre-existing violation.
export function resolveLintChangeScope(rawStdin, { plansPrefix, toolingPaths = [] }) {
  let paths;
  try {
    paths = parseChangedList(rawStdin);
  } catch {
    return null;
  }
  if (paths.some((p) => toolingPaths.includes(p))) return null;
  const planPaths = paths.filter((p) => p.startsWith(plansPrefix) && p.endsWith('.md'));
  return planPaths.length ? planPaths : null;
}
