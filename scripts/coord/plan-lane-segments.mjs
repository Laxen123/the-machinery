// scripts/coord/plan-lane-segments.mjs — the plan-basename exec-model marker vocabulary
// (`FABLE-`/`SOL-`), extracted to a dependency-free LEAF module (plan 3341 code-review
// follow-up).
//
// WHY a separate leaf: this vocabulary used to live only in
// lint-filename-execmodel-drift.mjs, which imports `readFrontmatterScalar` /
// `resolveLintChangeScope` FROM build-index-lib.mjs. build-index-lib.mjs needs the SAME
// marker vocabulary to build its own basename-parsing regex —
// `EVIDENCE_FLOOR_BASENAME_RX` — but build-index-lib.mjs importing FROM
// lint-filename-execmodel-drift.mjs would be a genuine two-file import cycle
// (lint-filename-execmodel-drift.mjs → build-index-lib.mjs → lint-filename-execmodel-drift.mjs).
// Before this module existed, that cycle made the grammar fall back to a hand-written
// `(FABLE-)?` alternation that never learned about `SOL-` — a live fail-open: a plan whose
// category embeds the marker (`000-SOL-Pipe-slug.md`) mis-parsed as category "SOL"
// (ungated) instead of "Pipe" (gated).
//
// Zero imports, by design: this module carries only the marker facts and the pure
// predicates/fragments derived from them, so ANY module in this repo — including
// lint-filename-execmodel-drift.mjs itself — can depend on it with no risk of a cycle.
// A fourth segment-bearing lane is ONE new row in MARKERS below and nothing else
// changes anywhere in this file.
//
// SINGLE-SOURCE (plan 3341 delta-review follow-up, keys 1a6a94/2efcd2/caed7c): every
// marker string is spelled out exactly ONCE in this file — in MARKERS below. Before
// this fix, hasFableSegment/hasSolSegment each hardcoded their own `^\d{3,}-FABLE-` /
// `^\d{3,}-SOL-` regex literal, duplicating the SAME marker string MARKERS/
// LANE_MARKER_ALTERNATION already carried — a rename at one site (say, LANE_SEGMENTS'
// `marker` field) would leave the id-position regexes still matching the OLD literal:
// filename validation would accept the new marker while title-stripping and drift
// detection silently stopped recognising it. Every regex below (the two segment
// predicates AND the alternation fragment) is now BUILT from MARKERS via
// escapeRegExpLiteral + segmentRxFor, so a rename or a new lane is one edit to MARKERS
// and nothing else in this module (or anywhere downstream of LANE_SEGMENTS /
// LANE_MARKER_ALTERNATION) can disagree with it.

// Escape a literal string for safe embedding in regex source — the one place a marker
// string turns into regex syntax in this module. Every marker today is plain word
// characters plus a trailing hyphen (no regex metacharacter), so this changes no
// existing behavior; it is cheap insurance against a future marker (e.g. `OPUS+`) that
// would otherwise silently corrupt a derived pattern (review key caed7c).
function escapeRegExpLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ONE row per segment-bearing lane: the lane name and its basename marker. This is the
// single place a marker string is spelled out — every regex, predicate, and derived
// export in this module (LANE_SEGMENTS, LANE_MARKER_ALTERNATION, hasFableSegment,
// hasSolSegment) is generated FROM this list.
const MARKERS = Object.freeze([
  { lane: 'fable', marker: 'FABLE-' },
  { lane: 'sol', marker: 'SOL-' },
]);

// A segment sits directly after the numeric id, mirroring the id-parse lookahead
// `/^(\d{3,})-(?=[A-Za-z])/` (build-index-lib.mjs's planIdOf) — every marker starts
// with a letter, so it satisfies that lookahead exactly like any Category segment.
// Anchored at the IDENTICAL position for every marker. For markers where neither is a
// PREFIX of the other (today's `FABLE-` / `SOL-`) that makes them mutually exclusive:
// whatever text sits right after `\d{3,}-` can start with at most one of them.
//
// It does NOT hold for a prefix-related pair, and this comment used to claim it did
// (review keys 16ba39/04eebe/aed1f8/a1c267). These are PREFIX tests, not whole-segment
// ones, so a future `SOL-PLUS-` marker added alongside `SOL-` makes BOTH predicates match
// `123-SOL-PLUS-Foo.md`. Which one a `LANE_SEGMENTS.find(...)` consumer then gets is
// decided purely by table ORDER — so LANE_SEGMENTS below is sorted longest-marker-first,
// exactly like the alternation fragment, and for the same reason. Fixing only the
// alternation (the earlier round's key bdcbde) left every `.find` consumer exposed:
// parsePlanBasename would strip the wrong LENGTH, the drift lint would name the wrong
// lane and suggest the wrong remediation, and the batches view would route the plan to
// the wrong lane.
// THE ordering rule, in one place: longest marker first. Both the row table (LANE_SEGMENTS)
// and the string fragments (markerAlternationFragment / markerDisplayFragment) sort through
// this, so a `.find` consumer and a regex-alternation consumer can never disagree about which
// of two prefix-related markers wins (review keys bedd8d/fbfad5). Sorts by RAW marker length,
// before any escaping, so escaping can never change the order.
function markerRowsLongestFirst(rows) {
  return rows.slice().sort((a, b) => b.marker.length - a.marker.length);
}

function segmentRxFor(marker) {
  return new RegExp(`^\\d{3,}-${escapeRegExpLiteral(marker)}`);
}

function segmentTestFor(marker) {
  const rx = segmentRxFor(marker);
  return (base) => rx.test(base);
}

// ONE ordered table carrying all three facts per segment-bearing lane: the lane name, its
// basename marker, and the canonical predicate that detects it. Exported because a
// consumer that must STRIP a segment rather than merely detect one needs the marker's
// LENGTH, which the hasXSegment predicates alone do not expose.
// Sorted longest-marker-first (NOT in MARKERS' declaration order) so a `.find` consumer
// resolves a prefix-colliding basename to the LONGEST matching marker — see the anchoring
// comment above. `hasFableSegment`/`hasSolSegment` below look their rows up BY LANE, so
// they are unaffected by this ordering; only positional/`find` access depends on it.
export const LANE_SEGMENTS = Object.freeze(
  markerRowsLongestFirst(MARKERS).map(({ lane, marker }) =>
    Object.freeze({ lane, marker, test: segmentTestFor(marker) }),
  ),
);

// hasFableSegment/hasSolSegment stay named exports (every existing importer across the
// repo — lint-filename-execmodel-drift.mjs, batches-view.mjs, done-worktree.mjs —
// references them by name) but are now DERIVED from LANE_SEGMENTS (itself derived from
// MARKERS) rather than each hand-typing its own `^\d{3,}-FABLE-`/`^\d{3,}-SOL-` literal.
// Mutually exclusive by construction: both predicates test the identical anchored
// position for a DIFFERENT literal, so whatever text actually sits there can match at
// most one of them.
export const hasFableSegment = LANE_SEGMENTS.find((s) => s.lane === 'fable').test;
export const hasSolSegment = LANE_SEGMENTS.find((s) => s.lane === 'sol').test;

// Sort markers LONGEST-FIRST — critical because regex alternation (`A|B`) matches the
// FIRST alternative that fits at a position, never the longest, so declaration order in
// MARKERS must never be load-bearing for a consumer that builds a regex from the joined
// fragment (review key bdcbde). A future row appended AFTER an existing one whose marker
// it happens to PREFIX — e.g. `{ lane: 'sol-plus', marker: 'SOL-PLUS-' }` added after the
// `sol`/`SOL-` row above — would otherwise produce the alternation `FABLE-|SOL-|SOL-PLUS-`,
// which matches `"123-SOL-PLUS-Foo.md"` as `SOL-` (leaving `"PLUS-Foo.md"` as the parsed
// remainder in every consumer built on this alternation) instead of the correct
// `SOL-PLUS-`. Sorting by raw (pre-escape) marker length, independent of MARKERS' own
// row order, makes the alternation immune to that regardless of where a new row lands.
function markersLongestFirst(markers) {
  return markerRowsLongestFirst(markers.map((marker) => ({ marker }))).map((r) => r.marker);
}

// Pure helper: raw marker strings (any order) -> a REGEX-safe alternation fragment,
// escaped and sorted longest-first. Exported so a test can exercise the ordering logic
// directly against a synthetic prefix-colliding pair (e.g. `SOL-` / `SOL-PLUS-` in BOTH
// declaration orders) — today's real MARKERS table has no prefix relationship between
// `FABLE-` and `SOL-`, so a test against LANE_MARKER_ALTERNATION itself could never prove
// the sort does anything. LANE_MARKER_ALTERNATION below calls this with the real markers,
// so production code and that test exercise the identical logic.
export function markerAlternationFragment(markers) {
  return markersLongestFirst(markers).map(escapeRegExpLiteral).join('|');
}

// Pure helper: the RAW (unescaped) twin of markerAlternationFragment above — same
// longest-first order, no escaping. For a consumer that must SHOW markers to a human (an
// "expected shape" hint, a rename-error message) rather than embed them in a regex:
// LANE_MARKER_ALTERNATION is regex-safe but not human-safe — a future marker containing a
// regex metacharacter (the header comment's own `OPUS+` example) would render inside
// LANE_MARKER_ALTERNATION as `OPUS\+`, a literal backslash an operator would then be told
// to type into a filename (review key 9b9b78). Same markers, same order, no escaping.
export function markerDisplayFragment(markers) {
  return markersLongestFirst(markers).join('|');
}

const RAW_MARKERS = MARKERS.map(({ marker }) => marker);

// A derived alternation fragment for a consumer that builds a REGEX out of the marker
// vocabulary rather than calling a predicate — e.g. `(${LANE_MARKER_ALTERNATION})?` as the
// optional marker group in a basename-parsing grammar (build-index-lib.mjs's
// EVIDENCE_FLOOR_BASENAME_RX). Longest-marker-
// first and escaped (review keys bdcbde/caed7c) — both are no-ops for today's plain-word-
// plus-hyphen, non-prefixing markers, but keep this a safe derivation regardless of what a
// future lane's marker turns out to be or where its MARKERS row lands.
export const LANE_MARKER_ALTERNATION = markerAlternationFragment(RAW_MARKERS);

// A derived, UNESCAPED marker listing for a consumer that shows markers to a human instead
// of building a regex from them — see markerDisplayFragment above (review key 9b9b78).
// e.g. move-plan.mjs's operator-facing rename-error hint should read from THIS export, not
// LANE_MARKER_ALTERNATION, so a future metacharacter-bearing marker never surfaces an
// escaped backslash in text the operator is told to copy into a filename.
export const LANE_MARKER_DISPLAY = markerDisplayFragment(RAW_MARKERS);
