// scripts/lint-filename-execmodel-drift.test.mjs — unit tests for the pure
// findExecModelDrift selector (+ its two small predicates). Mirrors
// lint-plan-cost-forecast.test.mjs (node:test, no fs/git).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findExecModelDrift,
  hasFableSegment,
  hasSolSegment,
  readExecModel,
} from './lint-filename-execmodel-drift.mjs';
import { resolveLintChangeScope } from './build-index-lib.mjs';
// plan 3341 delta-review follow-up (keys 1a6a94/2efcd2/caed7c): imported straight from the
// leaf module (not re-derived here) so this test reads the SAME single source LANE_SEGMENTS
// and its predicates are built from.
import { LANE_SEGMENTS, LANE_MARKER_ALTERNATION } from './plan-lane-segments.mjs';

const PLANS_PREFIX = 'docs/superpowers/plans/';
const TOOLING_PATHS = ['scripts/lint-filename-execmodel-drift.mjs', 'scripts/stamp-exec-model.mjs'];
const scope = (rawStdin) =>
  resolveLintChangeScope(rawStdin, { plansPrefix: PLANS_PREFIX, toolingPaths: TOOLING_PATHS });

const entry = (status, basename, content) => ({
  path: `docs/superpowers/plans/${status}/${basename}`,
  content,
});

const FM = (execModel) =>
  execModel == null
    ? '---\nsummary: x\n---\n\n# T\n'
    : `---\nsummary: x\nexecModel: ${execModel}\n---\n\n# T\n`;

test('hasFableSegment: true only for a FABLE- segment right after the numeric id', () => {
  assert.equal(hasFableSegment('1015-FABLE-DQ-foo.md'), true);
  assert.equal(hasFableSegment('1015-DQ-foo.md'), false);
  assert.equal(hasFableSegment('1015-FABLEX-DQ-foo.md'), false); // not the literal "FABLE-" segment
});

// plan 3341: the `sol` twin — same shape, different literal.
test('hasSolSegment: true only for a SOL- segment right after the numeric id', () => {
  assert.equal(hasSolSegment('3341-SOL-Infra-foo.md'), true);
  assert.equal(hasSolSegment('3341-Infra-foo.md'), false);
  assert.equal(hasSolSegment('3341-SOLO-Infra-foo.md'), false); // not the literal "SOL-" segment
});

// The structural guarantee findExecModelDrift's header/body comments rely on instead of a
// runtime "carries both markers" check: both regexes are anchored at the SAME position
// (right after `\d{3,}-`) and demand a DIFFERENT literal there, so no basename — however
// it's constructed — can ever satisfy both at once. Pinned directly here rather than via
// findExecModelDrift, since there is no `entries` input that could exercise a branch this
// invariant makes unreachable.
test('hasFableSegment/hasSolSegment: structurally mutually exclusive — no basename satisfies both', () => {
  for (const base of [
    '1000-FABLE-Other-foo.md',
    '1000-SOL-Other-foo.md',
    '1000-Other-foo.md',
    '1000-FABLE-SOL-Other-foo.md', // "SOL-" here is just part of the category tail, not a marker
    '1000-SOL-FABLE-Other-foo.md', // same, the other way round
  ]) {
    assert.notEqual(
      hasFableSegment(base) && hasSolSegment(base),
      true,
      `both matched for "${base}"`,
    );
  }
});

// plan 3341 delta-review follow-up (keys 1a6a94/2efcd2): each LANE_SEGMENTS predicate
// must be DERIVED from that same row's `marker` field, not a second hand-typed literal
// that happens to read the same today. Table-driven over LANE_SEGMENTS itself (never
// hardcoding "FABLE-"/"SOL-" as literals here) so this test cannot pass merely because
// today's marker text is unchanged from what a hardcoded regex would have hand-typed —
// it exercises the row's OWN marker string, whatever it is.
test("plan-lane-segments: every LANE_SEGMENTS predicate matches its OWN marker and no other row's", () => {
  assert.ok(LANE_SEGMENTS.length >= 2, 'expected at least fable/sol rows to exercise this');
  for (const { marker, test: segTest } of LANE_SEGMENTS) {
    assert.equal(
      segTest(`1000-${marker}Other-foo.md`),
      true,
      `"${marker}" must match its own basename`,
    );
    for (const other of LANE_SEGMENTS) {
      if (other.marker === marker) continue;
      assert.equal(
        segTest(`1000-${other.marker}Other-foo.md`),
        false,
        `"${marker}"'s predicate must not match "${other.marker}"'s basename`,
      );
    }
  }
});

// plan 3341 delta-review follow-up (key caed7c): LANE_MARKER_ALTERNATION must be the
// ESCAPED join of LANE_SEGMENTS' own markers — pinned by reconstructing it from the same
// live table with the standard MDN escape, rather than asserting a hardcoded "FABLE-|SOL-"
// string that would pass whether or not escaping actually happened (today's markers have
// no metacharacters to escape).
test("plan-lane-segments: LANE_MARKER_ALTERNATION is the escaped join of LANE_SEGMENTS' markers", () => {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.equal(LANE_MARKER_ALTERNATION, LANE_SEGMENTS.map((s) => escape(s.marker)).join('|'));
});

test('readExecModel: strips a trailing YAML comment and lowercases', () => {
  assert.equal(
    readExecModel('---\nexecModel: fable # umbrella tracker — NOT drain-eligible\n---\n'),
    'fable',
  );
  assert.equal(readExecModel('---\nexecModel: SONNET\n---\n'), 'sonnet');
  assert.equal(readExecModel('---\nsummary: x\n---\n'), '');
  assert.equal(readExecModel('# no frontmatter'), '');
});

// ── two-way (pending-approval/, ready/, waiting-*/) ───────────────────────────
test('ready/: FABLE- segment without execModel: fable is an error', () => {
  const problems = findExecModelDrift([entry('ready', '1000-FABLE-Other-foo.md', FM('sonnet'))]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /filename carries a FABLE- segment but frontmatter/);
});

test('ready/: execModel: fable without a FABLE- segment is an error', () => {
  const problems = findExecModelDrift([entry('ready', '1000-Other-foo.md', FM('fable'))]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /frontmatter execModel: fable but the filename carries no/);
});

test('ready/: agreement (both or neither) passes clean', () => {
  assert.deepEqual(
    findExecModelDrift([
      entry('ready', '1000-FABLE-Other-foo.md', FM('fable')),
      entry('ready', '1001-Other-bar.md', FM('sonnet')),
      entry('ready', '1002-Other-baz.md', FM(null)), // no execModel at all, no segment
    ]),
    [],
  );
});

test('pending-approval/ and waiting-*/ are also two-way', () => {
  for (const status of [
    'pending-approval',
    'waiting-blocked',
    'waiting-operator',
    'waiting-date',
    'waiting-trip',
  ]) {
    const problems = findExecModelDrift([entry(status, '1000-FABLE-Other-foo.md', FM('sonnet'))]);
    assert.equal(problems.length, 1, `expected a drift error in ${status}/`);
  }
});

// ── one-way (in-progress/) ─────────────────────────────────────────────────────
test('in-progress/: FABLE- segment requires execModel: fable (error when it disagrees)', () => {
  const problems = findExecModelDrift([
    entry('in-progress', '1000-FABLE-Other-foo.md', FM('sonnet')),
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /in-progress\/.*FABLE- segment but frontmatter/);
});

test('in-progress/: execModel: fable WITHOUT a FABLE- segment is ALLOWED (passes)', () => {
  assert.deepEqual(
    findExecModelDrift([entry('in-progress', '1000-Other-foo.md', FM('fable'))]),
    [],
  );
});

test('in-progress/: agreement (FABLE- segment + execModel: fable) passes', () => {
  assert.deepEqual(
    findExecModelDrift([entry('in-progress', '1000-FABLE-Other-foo.md', FM('fable'))]),
    [],
  );
});

// ── sol parity (plan 3341): same rules, SOL- segment / execModel: sol ────────────
test('ready/: SOL- segment without execModel: sol is an error', () => {
  const problems = findExecModelDrift([entry('ready', '1000-SOL-Other-foo.md', FM('sonnet'))]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /filename carries a SOL- segment but frontmatter/);
});

test('ready/: execModel: sol without a SOL- segment is an error', () => {
  const problems = findExecModelDrift([entry('ready', '1000-Other-foo.md', FM('sol'))]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /frontmatter execModel: sol but the filename carries no/);
});

test('ready/: a FABLE- segment with execModel: sol is an error naming fable as the fix (filename wins the "what to fix" call)', () => {
  const problems = findExecModelDrift([entry('ready', '1000-FABLE-Other-foo.md', FM('sol'))]);
  assert.equal(problems.length, 1);
  assert.match(
    problems[0].message,
    /FABLE- segment but frontmatter execModel is "sol", not "fable"/,
  );
  assert.match(problems[0].message, /stamp-exec-model\.mjs 1000-FABLE-Other-foo\.md fable/);
});

test('ready/: sol agreement (segment + execModel) passes, alongside a clean fable/sonnet mix', () => {
  assert.deepEqual(
    findExecModelDrift([
      entry('ready', '1000-SOL-Other-foo.md', FM('sol')),
      entry('ready', '1001-FABLE-Other-bar.md', FM('fable')),
      entry('ready', '1002-Other-baz.md', FM('sonnet')),
    ]),
    [],
  );
});

// plan 3341 delta-review follow-up (key bfefd8): the wanted-segment lookup used to be a
// bare `SEGMENT_FOR_LANE[execModel]` index into a plain object literal — `execModel:
// constructor` resolved through Object.prototype to the Object constructor FUNCTION
// (truthy) instead of `undefined`, so a plan with NO marker segment and that poisoned
// execModel got reported as drifted, with the function's own source text
// (`function Object() { [native code] }`) printed into the message and a remediation
// command (`stamp-exec-model.mjs <base> constructor`) the stamping tool itself refuses.
test('ready/: an unrecognized execModel (including a JS-prototype property name) with NO marker segment is clean, never a false drift', () => {
  for (const execModel of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'bogus-lane']) {
    assert.deepEqual(
      findExecModelDrift([entry('ready', '1000-Other-foo.md', FM(execModel))]),
      [],
      `expected no drift for execModel: ${execModel}`,
    );
  }
});

test('ready/: a FABLE- segment with a JS-prototype-named execModel is still reported cleanly — never "[native code]", never a command the stamping tool would reject', () => {
  for (const execModel of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const problems = findExecModelDrift([entry('ready', '1000-FABLE-Other-foo.md', FM(execModel))]);
    assert.equal(problems.length, 1);
    assert.doesNotMatch(problems[0].message, /\[native code\]/);
    assert.match(
      problems[0].message,
      new RegExp(`frontmatter execModel is "${execModel.toLowerCase()}", not "fable"`),
    );
    // The remediation command always names a REAL stampable target derived from the
    // filename's actual marker (fable/sol), never the raw unrecognized execModel value.
    assert.match(problems[0].message, /stamp-exec-model\.mjs 1000-FABLE-Other-foo\.md fable/);
  }
});

test('in-progress/: SOL- segment requires execModel: sol (error when it disagrees)', () => {
  const problems = findExecModelDrift([
    entry('in-progress', '1000-SOL-Other-foo.md', FM('sonnet')),
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /in-progress\/.*SOL- segment but frontmatter/);
});

test('in-progress/: execModel: sol WITHOUT a SOL- segment is ALLOWED (passes)', () => {
  assert.deepEqual(findExecModelDrift([entry('in-progress', '1000-Other-foo.md', FM('sol'))]), []);
});

test('in-progress/: agreement (SOL- segment + execModel: sol) passes', () => {
  assert.deepEqual(
    findExecModelDrift([entry('in-progress', '1000-SOL-Other-foo.md', FM('sol'))]),
    [],
  );
});

// ── plan 3341 review round 3 (keys 48ff8d/4a7d7a) ─────────────────────────────
// findExecModelDrift's "which model does this marker want?" used to be a hardcoded
// `actualSegment === 'FABLE-' ? 'fable' : 'sol'` binary instead of reading `matchedSegment.lane`
// off the LANE_SEGMENTS row that ALREADY matched. With exactly two lanes today that binary is
// accidentally correct in every case below — a third segment-bearing lane (one new
// LANE_SEGMENTS row, nothing else) is what would make it wrong (a correctly-`OPUS-`-marked
// plan reported as wanting "sol"). These two tests are therefore an INVARIANT PIN, not a
// bug-catcher, against TODAY's two-lane table: they do not fail on the pre-fix code (verified —
// see the report), but because they are driven by LANE_SEGMENTS itself rather than by two
// hardcoded literal markers, they will automatically start exercising a third lane the moment
// one is added to plan-lane-segments.mjs, with no edit needed here.
test("ready/: for EVERY LANE_SEGMENTS row, a wrong-marker segment names THAT row's own lane as the fix (never a hardcoded fable/sol guess)", () => {
  for (const row of LANE_SEGMENTS) {
    const base = `1000-${row.marker}Other-foo.md`;
    // execModel: sonnet never carries a segment (LANE_SEGMENTS has no row for it), so this is
    // guaranteed to disagree with whatever row.marker actually is.
    const problems = findExecModelDrift([entry('ready', base, FM('sonnet'))]);
    assert.equal(problems.length, 1, `expected a drift error for marker "${row.marker}"`);
    assert.match(
      problems[0].message,
      new RegExp(`frontmatter execModel is "sonnet", not "${row.lane}"`),
      `expected the fix to name lane "${row.lane}", read off the matched row — not re-derived`,
    );
    assert.match(
      problems[0].message,
      new RegExp(`stamp-exec-model\\.mjs ${base.replace(/[.]/g, '\\.')} ${row.lane}`),
    );
  }
});

test("in-progress/: for EVERY LANE_SEGMENTS row, a segment/execModel mismatch names THAT row's own lane (never a hardcoded fable/sol guess)", () => {
  for (const row of LANE_SEGMENTS) {
    const base = `1000-${row.marker}Other-foo.md`;
    const problems = findExecModelDrift([entry('in-progress', base, FM('sonnet'))]);
    assert.equal(problems.length, 1, `expected a drift error for marker "${row.marker}"`);
    assert.match(
      problems[0].message,
      new RegExp(`frontmatter execModel is "sonnet", not "${row.lane}"`),
      `expected the fix to name lane "${row.lane}", read off the matched row — not re-derived`,
    );
    assert.match(problems[0].message, new RegExp(`execModel: ${row.lane}\\)\\.$`));
  }
});

// ── archive/ ───────────────────────────────────────────────────────────────────
test('archive/ is skipped entirely, even with a blatant drift', () => {
  assert.deepEqual(
    findExecModelDrift([entry('archive', '1000-FABLE-Other-foo.md', FM('sonnet'))]),
    [],
  );
});

test('a mixed batch reports only the offending plans', () => {
  const problems = findExecModelDrift([
    entry('ready', '1000-FABLE-Other-foo.md', FM('fable')), // clean
    entry('ready', '1001-FABLE-Other-bar.md', FM('sonnet')), // drift
    entry('in-progress', '1002-Other-baz.md', FM('fable')), // allowed
    entry('archive', '1003-FABLE-Other-qux.md', FM(null)), // skipped
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].basename, '1001-FABLE-Other-bar.md');
});

// ── resolveLintChangeScope wired for lint-filename-execmodel-drift (plan 2540 review fix) ──
test('a push touching only the lint tooling itself forces a full sweep (null)', () => {
  assert.equal(scope('scripts/lint-filename-execmodel-drift.mjs\n'), null);
});

test('a push touching the tooling AND an unrelated plan still forces a full sweep', () => {
  // Regression: an earlier draft's stdin filter silently dropped the tooling-path
  // line before deciding scope, so this case wrongly narrowed to the one plan.
  assert.equal(
    scope(
      'scripts/lint-filename-execmodel-drift.mjs\ndocs/superpowers/plans/ready/1000-Other-foo.md\n',
    ),
    null,
  );
});

test('a push touching stamp-exec-model.mjs (a rules dependency) also forces a full sweep', () => {
  assert.equal(scope('scripts/stamp-exec-model.mjs\n'), null);
});

test('a push touching only an unrelated non-plan, non-tooling file yields no scope (empty)', () => {
  assert.equal(scope('frontend/src/App.tsx\n'), null);
});

test('regression: a push touching plan X does not get blocked by drift on untouched plan Y', () => {
  const entries = [
    entry('ready', '1000-Other-foo.md', FM(null)), // touched plan X, clean
    entry('ready', '1001-FABLE-Other-bar.md', FM('sonnet')), // untouched plan Y, drifted
  ];
  const changed = scope('docs/superpowers/plans/ready/1000-Other-foo.md\n');
  const scoped = entries.filter((e) => changed.includes(e.path));
  assert.deepEqual(findExecModelDrift(scoped), []);
});

test('regression: a push touching the drifted plan itself is still blocked', () => {
  const entries = [
    entry('ready', '1000-Other-foo.md', FM(null)),
    entry('ready', '1001-FABLE-Other-bar.md', FM('sonnet')), // touched, drifted
  ];
  const changed = scope('docs/superpowers/plans/ready/1001-FABLE-Other-bar.md\n');
  const scoped = entries.filter((e) => changed.includes(e.path));
  const problems = findExecModelDrift(scoped);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].basename, '1001-FABLE-Other-bar.md');
});
