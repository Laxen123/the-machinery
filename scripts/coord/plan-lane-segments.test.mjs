// scripts/plan-lane-segments.test.mjs — the plan-basename exec-model marker vocabulary
// (plan 3341 code-review follow-up). No prior dedicated test file existed for this leaf
// module before this one; scripts/exec-model-stamp.test.mjs and
// scripts/lint-filename-execmodel-drift.test.mjs already exercise LANE_SEGMENTS /
// LANE_MARKER_ALTERNATION indirectly through their own modules' re-exports — this file
// covers the leaf's OWN exports and derivation logic directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANE_SEGMENTS,
  hasFableSegment,
  hasSolSegment,
  LANE_MARKER_ALTERNATION,
  LANE_MARKER_DISPLAY,
  markerAlternationFragment,
  markerDisplayFragment,
} from './plan-lane-segments.mjs';

// Review keys da94be/623b6a/b610dd/1b0cfc: this used to `deepEqual` the WHOLE table against a
// hardcoded two-row list, which contradicted the module's own central claim that a further
// segment-bearing lane is ONE new MARKERS row and no other edit — adding one would have failed
// this assertion before exercising any behaviour, forcing a test edit to land the extension and
// letting the expectation drift from the table it is supposed to describe. Structural instead:
// the two lanes that must exist are pinned by name, and every row (however many there are) is
// required to be well-formed and correctly ordered.
test('LANE_SEGMENTS: carries the required fable/sol rows, every row well-formed and longest-marker-first', () => {
  const byLane = new Map(LANE_SEGMENTS.map((row) => [row.lane, row]));
  assert.equal(byLane.get('fable')?.marker, 'FABLE-');
  assert.equal(byLane.get('sol')?.marker, 'SOL-');
  assert.equal(byLane.get('fable').test('123-FABLE-Pipe-x.md'), true);
  assert.equal(byLane.get('sol').test('123-SOL-Pipe-x.md'), true);

  // Every row, not just today's two: a non-empty marker, a predicate that matches its OWN
  // marker at the anchored position and rejects a markerless basename.
  for (const { lane, marker, test: matches } of LANE_SEGMENTS) {
    assert.ok(marker.length > 0, `${lane} has an empty marker`);
    assert.equal(matches(`123-${marker}Pipe-x.md`), true, `${lane} rejects its own marker`);
    assert.equal(matches('123-Pipe-x.md'), false, `${lane} matches a markerless basename`);
  }

  // Sorted longest-marker-first, so a `.find` consumer resolves a prefix-colliding basename to
  // the LONGEST match rather than to whichever row happened to be declared first.
  const lengths = LANE_SEGMENTS.map(({ marker }) => marker.length);
  assert.deepEqual(
    lengths,
    [...lengths].sort((a, b) => b - a),
    'LANE_SEGMENTS is not sorted longest-marker-first',
  );
});

test('hasFableSegment/hasSolSegment: anchored right after the numeric id, mutually exclusive', () => {
  assert.equal(hasFableSegment('123-FABLE-Pipe-x.md'), true);
  assert.equal(hasFableSegment('123-SOL-Pipe-x.md'), false);
  assert.equal(hasSolSegment('123-SOL-Pipe-x.md'), true);
  assert.equal(hasSolSegment('123-FABLE-Pipe-x.md'), false);
  assert.equal(hasFableSegment('123-Pipe-x.md'), false);
  assert.equal(hasSolSegment('123-Pipe-x.md'), false);
});

test('LANE_MARKER_ALTERNATION/LANE_MARKER_DISPLAY: derived from the same real markers, escaped vs raw', () => {
  // Today's real markers have no regex metacharacters, so escaped and raw forms read
  // identically — this pins that both exports actually contain fable/sol, in SOME order.
  assert.equal(new RegExp(`^(?:${LANE_MARKER_ALTERNATION})$`).test('FABLE-'), true);
  assert.equal(new RegExp(`^(?:${LANE_MARKER_ALTERNATION})$`).test('SOL-'), true);
  assert.equal(LANE_MARKER_DISPLAY.includes('FABLE-'), true);
  assert.equal(LANE_MARKER_DISPLAY.includes('SOL-'), true);
  // No backslash anywhere in the display form — it is never regex-escaped.
  assert.equal(LANE_MARKER_DISPLAY.includes('\\'), false);
});

// ── review finding bdcbde: alternation order must not depend on MARKERS' declaration
// order — regex alternation (`A|B`) takes the FIRST alternative that fits, not the
// longest, so a marker that is a PREFIX of another must always lose the race regardless
// of which one was declared first. Today's real table (FABLE-/SOL-) has no prefix
// relationship, so this can only be proven with a synthetic pair — hence testing
// markerAlternationFragment directly rather than the real LANE_MARKER_ALTERNATION.
test('markerAlternationFragment: a marker that PREFIXES another still loses to the longer one, in EITHER declaration order (plan 3341 review bdcbde)', () => {
  const shortFirst = markerAlternationFragment(['SOL-', 'SOL-PLUS-']);
  const longFirst = markerAlternationFragment(['SOL-PLUS-', 'SOL-']);
  for (const [label, fragment] of [
    ['SOL- declared first', shortFirst],
    ['SOL-PLUS- declared first', longFirst],
  ]) {
    const rx = new RegExp(`^\\d+-(${fragment})`);
    const m = rx.exec('123-SOL-PLUS-Foo.md');
    assert.ok(m, `${label}: must match at all`);
    assert.equal(m[1], 'SOL-PLUS-', `${label}: must capture the LONGER marker, not the prefix`);
  }
});

test('markerAlternationFragment: escapes a marker containing a regex metacharacter', () => {
  const fragment = markerAlternationFragment(['OPUS+']);
  assert.equal(fragment, 'OPUS\\+');
  // And the escaped form still matches the LITERAL marker text, not "OPUS" one-or-more.
  assert.equal(new RegExp(`^${fragment}$`).test('OPUS+'), true);
  assert.equal(new RegExp(`^${fragment}$`).test('OPUSSSS'), false);
});

// ── review finding 9b9b78: a human-facing hint must never show escaped regex syntax.
test('markerDisplayFragment: same longest-first order as markerAlternationFragment, but UNESCAPED', () => {
  assert.equal(markerDisplayFragment(['SOL-', 'SOL-PLUS-']), 'SOL-PLUS-|SOL-');
  assert.equal(markerDisplayFragment(['SOL-PLUS-', 'SOL-']), 'SOL-PLUS-|SOL-');
  // The metacharacter-bearing case: display must carry the RAW marker, no backslash.
  const display = markerDisplayFragment(['OPUS+']);
  assert.equal(display, 'OPUS+');
  assert.equal(display.includes('\\'), false);
});
