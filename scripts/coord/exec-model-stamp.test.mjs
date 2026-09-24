// scripts/exec-model-stamp.test.mjs — pure-function tests for the shared FABLE-
// filename auto-stamp lib (plan 1362). renameForExecModel's own transform tests
// already live in stamp-exec-model.test.mjs (this file re-exports it for back-compat);
// this file covers the NEW auto-stamp surface — stampedRelForExecModel,
// canRenameForStatus, assertExecModelFilenameOk — that next-plan-id.mjs / edit-plan.mjs
// / move-plan.mjs call, no fs/git needed (pure string transforms + one shared lint fn).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canRenameForStatus,
  stampedRelForExecModel,
  assertExecModelFilenameOk,
  categoryCarriesFableSegment,
  categoryCarriesSolSegment,
  stripSolSegment,
  stripExecModelSegment,
  ensureExecModelForCategory,
  ensureExecModelForExemptMechanical,
  EXEMPT_MECHANICAL_DEFAULT_LANE,
  renameForExecModel,
  BASENAME_RX,
} from './exec-model-stamp.mjs';
// plan 3341 delta-review follow-up (key 4fb6b9): BASENAME_RX's marker group must be
// DERIVED from this same shared alternation, not a second hand-typed `(FABLE-|SOL-)?`
// literal — imported directly so this test pins the derivation against the actual
// single source, not a copy of today's marker text.
import { LANE_SEGMENTS, LANE_MARKER_ALTERNATION } from './plan-lane-segments.mjs';
import { KNOWN_EXEC_LANES, readExecModelDefault } from './exec-model-default-lib.mjs';

test('canRenameForStatus: refuses in-progress/, archive/ and parked/, allows everything else', () => {
  assert.equal(canRenameForStatus('in-progress'), false);
  assert.equal(canRenameForStatus('archive'), false);
  assert.equal(canRenameForStatus('parked'), false);
  for (const s of [
    'pending-approval',
    'ready',
    'waiting-blocked',
    'waiting-operator',
    'waiting-date',
  ])
    assert.equal(canRenameForStatus(s), true);
});

const fmFable = '---\nexecModel: fable\n---\n\n# T\n';
const fmSonnet = '---\nexecModel: sonnet\n---\n\n# T\n';
const fmSol = '---\nexecModel: sol\n---\n\n# T\n'; // plan 3341
const fmNone = '# T\n\nbody\n';

// Plan 3656 supersedes plan 3617's pinned-literal test. That test asserted
// `EXEMPT_MECHANICAL_DEFAULT_LANE === 'sonnet'` so a silent flip to 'sol' would fail
// loudly — correct while the lane was a literal in a `scripts/**` module, but it also
// meant every legitimate operator flip broke the suite and needed a code diff. The
// default is config now (`scripts/exec-model-default.json`, flipped by
// `exec-model-default.mjs`), so the property worth pinning changed: not WHICH lane, but
// that the constant is genuinely the toggle's value and that the toggle is well-formed.
// A corrupt or unknown-lane toggle still fails loudly — readExecModelDefault throws,
// which surfaces here as a failing import-time read.
test('EXEMPT_MECHANICAL_DEFAULT_LANE is whatever the toggle says (plan 3656)', () => {
  const { defaultLane } = readExecModelDefault();
  assert.equal(EXEMPT_MECHANICAL_DEFAULT_LANE, defaultLane);
  assert.ok(
    KNOWN_EXEC_LANES.includes(EXEMPT_MECHANICAL_DEFAULT_LANE),
    `default lane ${EXEMPT_MECHANICAL_DEFAULT_LANE} is not a known lane`,
  );
});

test('ensureExecModelForExemptMechanical: backfills the default lane only for an unstamped exempt-mechanical plan', () => {
  const lane = EXEMPT_MECHANICAL_DEFAULT_LANE;
  const exempt = '---\nspecReview: exempt-mechanical\n---\n\n# T\n';
  assert.match(ensureExecModelForExemptMechanical(exempt), new RegExp(`^execModel: ${lane}$`, 'm'));
  assert.equal(ensureExecModelForExemptMechanical(fmNone), fmNone);
  const reviewed = '---\nspecReview: abc123\n---\n\n# T\n';
  assert.equal(ensureExecModelForExemptMechanical(reviewed), reviewed);
});

test('ensureExecModelForExemptMechanical: matches exempt-mechanical case-insensitively', () => {
  const lane = EXEMPT_MECHANICAL_DEFAULT_LANE;
  for (const specReview of ['EXEMPT-MECHANICAL', 'Exempt-Mechanical']) {
    const body = `---\nspecReview: ${specReview}\n---\n\n# T\n`;
    assert.match(ensureExecModelForExemptMechanical(body), new RegExp(`^execModel: ${lane}$`, 'm'));
  }
});

test('ensureExecModelForExemptMechanical: preserves every explicit execModel value', () => {
  for (const lane of ['sonnet', 'fable', 'sol']) {
    const body = `---\nspecReview: exempt-mechanical\nexecModel: ${lane}\n---\n\n# T\n`;
    assert.equal(ensureExecModelForExemptMechanical(body), body);
  }
});

test('stampedRelForExecModel: fable + no segment → stamps the FABLE- segment, same folder', () => {
  assert.equal(
    stampedRelForExecModel('docs/superpowers/plans/ready/1000-Other-foo.md', fmFable),
    'docs/superpowers/plans/ready/1000-FABLE-Other-foo.md',
  );
});

test('stampedRelForExecModel: already stamped → null (no double segment)', () => {
  assert.equal(
    stampedRelForExecModel('docs/superpowers/plans/ready/1000-FABLE-Other-foo.md', fmFable),
    null,
  );
});

test('stampedRelForExecModel: execModel sonnet or absent → null', () => {
  assert.equal(
    stampedRelForExecModel('docs/superpowers/plans/ready/1000-Other-foo.md', fmSonnet),
    null,
  );
  assert.equal(
    stampedRelForExecModel('docs/superpowers/plans/ready/1000-Other-foo.md', fmNone),
    null,
  );
});

test("stampedRelForExecModel: a malformed basename returns null (not this lib's job to fix)", () => {
  assert.equal(stampedRelForExecModel('docs/superpowers/plans/ready/not-a-plan.md', fmFable), null);
});

// plan 3341 review round 3 (key 2d6c4b, CONFIRMED crash): `execModel` comes straight from
// UNTRUSTED plan frontmatter. A bare `SEGMENT_CHECK_FOR_EXEC_MODEL[execModel]` lookup used to
// resolve `execModel: __proto__`/`constructor` to an inherited, truthy Object.prototype value
// — the `!hasSegmentCheck` guard didn't catch it, and calling that value as a function a few
// lines later threw `TypeError: hasSegmentCheck is not a function`, aborting the write instead
// of returning null for an unrecognized lane. `readExecModel` lowercases the frontmatter value
// before this lookup, so only an ALREADY-all-lowercase inherited property name is reachable
// through this path — `__proto__` and `constructor` both are; `toString`/`hasOwnProperty`
// lower-case to `tostring`/`hasownproperty`, which are not inherited property names at all
// (verified: `'tostring' in {}` is false, `'toString' in {}` is true) and so were never
// actually exploitable via plan frontmatter specifically — covered instead by the
// renameForExecModel hardening test below, where the (unlowercased) value goes straight in.
test('stampedRelForExecModel: a prototype-pollution-shaped execModel returns null, never throws (plan 3341 review r3, key 2d6c4b)', () => {
  const fmProto = '---\nexecModel: __proto__\n---\n\n# T\n';
  const fmCtor = '---\nexecModel: constructor\n---\n\n# T\n';
  for (const fm of [fmProto, fmCtor]) {
    assert.doesNotThrow(() =>
      stampedRelForExecModel('docs/superpowers/plans/ready/1000-Other-foo.md', fm),
    );
    assert.equal(
      stampedRelForExecModel('docs/superpowers/plans/ready/1000-Other-foo.md', fm),
      null,
    );
  }
});

// plan 3341 review round 3 (key 2d6c4b sweep, hardening not a reachable bug today): every
// CURRENT caller validates `target` against VALID_EXEC_MODELS before calling
// renameForExecModel (stamp-exec-model.mjs's CLI via assertOneOf, next-plan-id.mjs's onPick
// via an EXEC_MODELS_WITH_SEGMENT membership check) — so this pins the DEFENSIVE fallback for
// any future/unvalidated caller, not a fix for something reachable now. Unlike
// stampedRelForExecModel above, `target` here is used AS-IS (no lowercasing), so the
// mixed-case inherited names (`toString`, `hasOwnProperty`) are live probes too.
test('renameForExecModel: a prototype-pollution-shaped target degrades to no rename, never corrupts the filename', () => {
  for (const target of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(renameForExecModel('1000-Other-foo.md', target), '1000-Other-foo.md');
  }
});

// plan 3341: the `sol` twin of the fable cases above.
test('stampedRelForExecModel: sol + no segment → stamps the SOL- segment, same folder', () => {
  assert.equal(
    stampedRelForExecModel('docs/superpowers/plans/ready/1000-Other-foo.md', fmSol),
    'docs/superpowers/plans/ready/1000-SOL-Other-foo.md',
  );
});

test('stampedRelForExecModel: sol already stamped → null (no double segment)', () => {
  assert.equal(
    stampedRelForExecModel('docs/superpowers/plans/ready/1000-SOL-Other-foo.md', fmSol),
    null,
  );
});

test('stampedRelForExecModel: sol + an existing FABLE- segment SWAPS to SOL- (mutually exclusive)', () => {
  assert.equal(
    stampedRelForExecModel('docs/superpowers/plans/ready/1000-FABLE-Other-foo.md', fmSol),
    'docs/superpowers/plans/ready/1000-SOL-Other-foo.md',
  );
});

// plan 3341 delta-review follow-up (key 4fb6b9): BASENAME_RX's marker capture group used
// to be a SEPARATELY hand-typed `(FABLE-|SOL-)?` literal rather than derived from
// LANE_MARKER_ALTERNATION — so a future lane's marker could be GENERATED into
// plan-lane-segments.mjs's table while this basename grammar stayed unaware of it,
// leaving an already-marked basename for that lane unparseable here (the marker text
// would fall entirely into the trailing `rest` capture instead of its own group).
test('BASENAME_RX: the marker capture group is the SAME alternation LANE_MARKER_ALTERNATION exports', () => {
  assert.equal(BASENAME_RX.source, `^(\\d{3,})-(${LANE_MARKER_ALTERNATION})?(.+)$`);
});

// Table-driven over LANE_SEGMENTS (never hardcoding "FABLE-"/"SOL-" literally here) so this
// pins BASENAME_RX against whatever markers the shared table actually carries: each row's
// OWN marker must land in capture group 2, not spill into the trailing `rest` (group 3).
test('BASENAME_RX: every LANE_SEGMENTS marker parses into its own capture group, never into `rest`', () => {
  for (const { marker } of LANE_SEGMENTS) {
    const m = BASENAME_RX.exec(`3341-${marker}Infra-foo.md`);
    assert.ok(m, `"${marker}" basename failed to match BASENAME_RX at all`);
    assert.equal(
      m[2],
      marker,
      `expected "${marker}" captured in group 2, got ${JSON.stringify(m[2])}`,
    );
    assert.equal(m[3], 'Infra-foo.md');
  }
});

test('assertExecModelFilenameOk: agreeing filename/frontmatter never throws', () => {
  assert.doesNotThrow(() =>
    assertExecModelFilenameOk('docs/superpowers/plans/ready/1000-FABLE-Other-foo.md', fmFable),
  );
  assert.doesNotThrow(() =>
    assertExecModelFilenameOk('docs/superpowers/plans/ready/1000-Other-foo.md', fmSonnet),
  );
});

test('assertExecModelFilenameOk: a drifted (FABLE- segment, non-fable frontmatter) file throws', () => {
  assert.throws(
    () =>
      assertExecModelFilenameOk('docs/superpowers/plans/ready/1000-FABLE-Other-foo.md', fmSonnet),
    /internal — .* still drifted/,
  );
});

// plan 3341: the `sol` twins of the two checks above.
test('assertExecModelFilenameOk: agreeing SOL-/execModel: sol never throws', () => {
  assert.doesNotThrow(() =>
    assertExecModelFilenameOk('docs/superpowers/plans/ready/1000-SOL-Other-foo.md', fmSol),
  );
});

test('assertExecModelFilenameOk: a drifted (SOL- segment, non-sol frontmatter) file throws', () => {
  assert.throws(
    () => assertExecModelFilenameOk('docs/superpowers/plans/ready/1000-SOL-Other-foo.md', fmSonnet),
    /internal — .* still drifted/,
  );
});

// plan 3341: a basename carrying the FABLE- segment reads as fable, never as sol — even
// when the frontmatter says sol — because renameForExecModel REPLACES a marker rather
// than stacking a second one, so "FABLE-...SOL-..." never arises from this tool's own
// writes; lint-filename-execmodel-drift.test.mjs pins the structural reason (the two
// segment regexes can never both match one basename) directly.
test('assertExecModelFilenameOk: a FABLE- basename with execModel: sol is drifted (frontmatter disagrees with the filename)', () => {
  assert.throws(
    () => assertExecModelFilenameOk('docs/superpowers/plans/ready/1000-FABLE-Other-foo.md', fmSol),
    /internal — .* still drifted/,
  );
});

// plan 1561: --category FABLE-DQ bakes the segment into the category itself (the
// REVERSE of the frontmatter-driven rename above) — a real mint shape, not just a
// malformed input (batches-view.mjs's own parser treats a category-embedded FABLE-
// segment the same way).
test('categoryCarriesFableSegment: true only for a category starting with FABLE-', () => {
  assert.equal(categoryCarriesFableSegment('FABLE-DQ'), true);
  assert.equal(categoryCarriesFableSegment('DQ'), false);
  assert.equal(categoryCarriesFableSegment('Other'), false);
  // "FABLE" alone (no trailing dash) isn't the segment shape.
  assert.equal(categoryCarriesFableSegment('FABLEISH'), false);
});

// plan 3341: the `sol` twin — same shape, different literal, and never confused with the
// fable check (a category starting with FABLE- is never also reported as SOL-, and vice
// versa, for the same structural reason findExecModelDrift's basenames can't be both).
test('categoryCarriesSolSegment: true only for a category starting with SOL-', () => {
  assert.equal(categoryCarriesSolSegment('SOL-DQ'), true);
  assert.equal(categoryCarriesSolSegment('DQ'), false);
  assert.equal(categoryCarriesSolSegment('Other'), false);
  assert.equal(categoryCarriesSolSegment('SOLITARY'), false);
  // never cross-detected as the other lane's marker
  assert.equal(categoryCarriesSolSegment('FABLE-DQ'), false);
  assert.equal(categoryCarriesFableSegment('SOL-DQ'), false);
});

test('stripSolSegment: strips SOL- when present, else unchanged', () => {
  assert.equal(stripSolSegment('SOL-DQ'), 'DQ');
  assert.equal(stripSolSegment('DQ'), 'DQ');
  assert.equal(stripSolSegment('FABLE-DQ'), 'FABLE-DQ'); // not this lane's marker
});

// plan 3341: the table-driven combinator next-plan-id.mjs's category-allowlist gate uses
// instead of chaining stripFableSegment/stripSolSegment by hand.
test('stripExecModelSegment: strips whichever marker (if any) is present', () => {
  assert.equal(stripExecModelSegment('FABLE-DQ'), 'DQ');
  assert.equal(stripExecModelSegment('SOL-DQ'), 'DQ');
  assert.equal(stripExecModelSegment('DQ'), 'DQ');
  assert.equal(stripExecModelSegment('Other'), 'Other');
});

test('ensureExecModelForCategory: frontmatter-less body + FABLE- category → creates the block with execModel: fable', () => {
  const out = ensureExecModelForCategory(fmNone, 'FABLE-DQ');
  assert.match(out, /^---\r?\nexecModel: fable\r?\n---/);
  assert.match(out, /# T/); // original body preserved after the new block
});

test('ensureExecModelForCategory: existing frontmatter without execModel + FABLE- category → merges the key in', () => {
  const withSummary = "---\nsummary: 'x'\n---\n\n# T\n";
  const out = ensureExecModelForCategory(withSummary, 'FABLE-DQ');
  assert.match(out, /summary: 'x'/);
  assert.match(out, /execModel: fable/);
});

test('ensureExecModelForCategory: non-FABLE- category → content unchanged', () => {
  assert.equal(ensureExecModelForCategory(fmNone, 'DQ'), fmNone);
  assert.equal(ensureExecModelForCategory(fmNone, 'Other'), fmNone);
});

// plan 3341: ensureExecModelForCategory is now table-driven (SEGMENT_CHECK_FOR_EXEC_MODEL)
// and backfills `sol` exactly the way it always backfilled `fable` — a `--category
// SOL-Pipe` mint used to get the `-SOL-` filename segment with NO execModel backfill,
// which the drift lint (extended to sol in this same plan) would then hard-block at push
// time. These four mirror the FABLE- cases above, one lane over.
test('ensureExecModelForCategory: frontmatter-less body + SOL- category → creates the block with execModel: sol', () => {
  const out = ensureExecModelForCategory(fmNone, 'SOL-DQ');
  assert.match(out, /^---\r?\nexecModel: sol\r?\n---/);
  assert.match(out, /# T/); // original body preserved after the new block
});

test('ensureExecModelForCategory: existing frontmatter without execModel + SOL- category → merges the key in', () => {
  const withSummary = "---\nsummary: 'x'\n---\n\n# T\n";
  const out = ensureExecModelForCategory(withSummary, 'SOL-DQ');
  assert.match(out, /summary: 'x'/);
  assert.match(out, /execModel: sol/);
});

test('ensureExecModelForCategory: already execModel: sol → content unchanged (idempotent)', () => {
  assert.equal(ensureExecModelForCategory(fmSol, 'SOL-DQ'), fmSol);
});

test('ensureExecModelForCategory result (sol) satisfies assertExecModelFilenameOk (no drift left behind)', () => {
  const stamped = ensureExecModelForCategory(fmNone, 'SOL-DQ');
  assert.doesNotThrow(() =>
    assertExecModelFilenameOk(
      'docs/superpowers/plans/pending-approval/1000-SOL-DQ-foo.md',
      stamped,
    ),
  );
});

test('ensureExecModelForCategory: already execModel: fable → content unchanged (idempotent)', () => {
  assert.equal(ensureExecModelForCategory(fmFable, 'FABLE-DQ'), fmFable);
});

test('ensureExecModelForCategory: an explicit conflicting execModel is never overwritten', () => {
  // keepExisting semantics — an author's own value always wins; the residual
  // filename/frontmatter conflict is a real authoring error, not this helper's job.
  assert.equal(ensureExecModelForCategory(fmSonnet, 'FABLE-DQ'), fmSonnet);
  assert.equal(ensureExecModelForCategory(fmFable, 'SOL-DQ'), fmFable);
});

test('ensureExecModelForCategory result satisfies assertExecModelFilenameOk (no drift left behind)', () => {
  const stamped = ensureExecModelForCategory(fmNone, 'FABLE-DQ');
  assert.doesNotThrow(() =>
    assertExecModelFilenameOk(
      'docs/superpowers/plans/pending-approval/1000-FABLE-DQ-foo.md',
      stamped,
    ),
  );
});
