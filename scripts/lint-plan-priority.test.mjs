// scripts/lint-plan-priority.test.mjs — unit tests for the pure findIllegalPriority
// selector (plan 2520 ruling 3: write-time hard-refuse of an unknown `priority:` value).
// Mirrors lint-filename-execmodel-drift.test.mjs (node:test, no fs/git).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findIllegalPriority,
  findUnbackedHigh,
  BARE_HIGH_GRANDFATHERED_2026_09_13,
} from './lint-plan-priority.mjs';
import { resolveLintChangeScope } from './coord/build-index-lib.mjs';

const PLANS_PREFIX = 'docs/superpowers/plans/';
const TOOLING_PATHS = [
  'scripts/lint-plan-priority.mjs',
  'scripts/read-plan-stamps.mjs',
  'scripts/coord/build-index-lib.mjs',
];
const scope = (rawStdin) =>
  resolveLintChangeScope(rawStdin, { plansPrefix: PLANS_PREFIX, toolingPaths: TOOLING_PATHS });

const entry = (status, basename, content) => ({
  path: `docs/superpowers/plans/${status}/${basename}`,
  content,
});

const FM = (priority) =>
  priority == null
    ? '---\nsummary: x\n---\n\n# T\n'
    : `---\nsummary: x\npriority: ${priority}\n---\n\n# T\n`;

test('no priority stamp at all is legal (defaults to medium)', () => {
  assert.deepEqual(findIllegalPriority([entry('ready', '1000-Other-foo.md', FM(null))]), []);
});

test('every legal value, case-insensitive, passes clean', () => {
  for (const v of ['high', 'HIGH', 'Medium', 'medium', 'low', 'LOW'])
    assert.deepEqual(
      findIllegalPriority([entry('ready', '1000-Other-foo.md', FM(v))]),
      [],
      `priority: ${v} should be legal`,
    );
});

test('the now-illegal "normal" is refused', () => {
  const problems = findIllegalPriority([entry('ready', '1000-Other-foo.md', FM('normal'))]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /priority: "normal" is not a legal value/);
  assert.match(problems[0].message, /high\|medium\|low/);
});

test('a typo is refused with the offending value quoted', () => {
  const problems = findIllegalPriority([entry('ready', '1000-Other-foo.md', FM('urgnet'))]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].value, 'urgnet');
  assert.match(problems[0].message, /node scripts\/edit-plan\.mjs 1000-Other-foo/);
});

test('every non-archive/parked status folder is gated', () => {
  for (const status of [
    'pending-approval',
    'ready',
    'in-progress',
    'waiting-blocked',
    'waiting-operator',
    'waiting-date',
    'waiting-trip',
  ]) {
    const problems = findIllegalPriority([entry(status, '1000-Other-foo.md', FM('urgent'))]);
    assert.equal(problems.length, 1, `expected a refusal in ${status}/`);
  }
});

test('archive/ and parked/ are skipped, even with a blatant illegal value', () => {
  assert.deepEqual(
    findIllegalPriority([
      entry('archive', '1000-Other-foo.md', FM('normal')),
      entry('parked', '1001-Other-bar.md', FM('urgnet')),
    ]),
    [],
  );
});

test('a mixed batch reports only the offending plans', () => {
  const problems = findIllegalPriority([
    entry('ready', '1000-Other-foo.md', FM('high')), // clean
    entry('ready', '1001-Other-bar.md', FM('normal')), // illegal
    entry('in-progress', '1002-Other-baz.md', FM(null)), // clean (absent)
    entry('archive', '1003-Other-qux.md', FM('urgnet')), // skipped
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].basename, '1001-Other-bar.md');
});

test('a trailing YAML inline comment (plan 1292 shape) is stripped before validation', () => {
  assert.deepEqual(
    findIllegalPriority([
      entry(
        'ready',
        '1000-Other-foo.md',
        '---\nsummary: x\npriority: high # stamped by board-pass 2026-07-24\n---\n\n# T\n',
      ),
    ]),
    [],
  );
});

// ── resolveLintChangeScope wired for lint-plan-priority (plan 2540 review fix) ──
test('a push touching only the lint tooling itself forces a full sweep (null)', () => {
  assert.equal(scope('scripts/lint-plan-priority.mjs\n'), null);
});

test('a push touching the tooling AND an unrelated plan still forces a full sweep', () => {
  // Regression: an earlier draft's stdin filter silently dropped the tooling-path
  // line before deciding scope, so this case wrongly narrowed to the one plan.
  assert.equal(
    scope('scripts/lint-plan-priority.mjs\ndocs/superpowers/plans/ready/1000-Other-foo.md\n'),
    null,
  );
});

test('a push touching build-index-lib.mjs (a rules dependency) also forces a full sweep', () => {
  assert.equal(scope('scripts/coord/build-index-lib.mjs\n'), null);
});

test('a push touching only an unrelated non-plan, non-tooling file yields no scope (empty)', () => {
  assert.equal(scope('frontend/src/App.tsx\n'), null);
});

test('regression: a push touching plan X does not get blocked by an illegal value on untouched plan Y', () => {
  const entries = [
    entry('ready', '1000-Other-foo.md', FM('high')), // the touched plan X, clean
    entry('ready', '1001-Other-bar.md', FM('normal')), // untouched plan Y, illegal
  ];
  const changed = scope('docs/superpowers/plans/ready/1000-Other-foo.md\n');
  const scoped = entries.filter((e) => changed.includes(e.path));
  assert.deepEqual(findIllegalPriority(scoped), []);
});

test('regression: a push touching the plan carrying the illegal value itself is still blocked', () => {
  const entries = [
    entry('ready', '1000-Other-foo.md', FM('high')),
    entry('ready', '1001-Other-bar.md', FM('normal')), // touched, illegal
  ];
  const changed = scope('docs/superpowers/plans/ready/1001-Other-bar.md\n');
  const scoped = entries.filter((e) => changed.includes(e.path));
  const problems = findIllegalPriority(scoped);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].basename, '1001-Other-bar.md');
});

// ── findUnbackedHigh (plan 3999: `priority: high` needs a named authority) ─────────────────

// A `priority: <tier>` + optional `priorityBy: <by>` frontmatter body, same idiom as FM above.
const FMB = (priority, by) =>
  [
    '---',
    'summary: x',
    priority == null ? null : `priority: ${priority}`,
    by == null ? null : `priorityBy: ${by}`,
    '---',
    '',
    '# T',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');

test('a bare priority: high with no priorityBy is unbacked-high, exit-shaped 1', () => {
  const problems = findUnbackedHigh([entry('ready', '1000-Other-foo.md', FMB('high', null))]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].problem, 'unbacked-high');
  assert.match(problems[0].message, /priority: high with no legal `priorityBy:`/);
});

test('priority: high with priorityBy: directive 2141-critical-path is clean', () => {
  assert.deepEqual(
    findUnbackedHigh([
      entry('ready', '1000-Other-foo.md', FMB('high', 'directive 2141-critical-path')),
    ]),
    [],
  );
});

test('priority: high with priorityBy: operator <date> is clean', () => {
  assert.deepEqual(
    findUnbackedHigh([entry('ready', '1000-Other-foo.md', FMB('high', 'operator 2026-09-13'))]),
    [],
  );
});

test('priorityBy: on a medium plan is stale-priorityBy', () => {
  const problems = findUnbackedHigh([
    entry('ready', '1000-Other-foo.md', FMB('medium', 'operator 2026-09-13')),
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].problem, 'stale-priorityBy');
  assert.match(problems[0].message, /priorityBy:.*is present but priority is not high/);
});

test('priorityBy: on a plan with no priority stamp at all (medium default) is also stale-priorityBy', () => {
  const problems = findUnbackedHigh([
    entry('ready', '1000-Other-foo.md', FMB(null, 'operator 2026-09-13')),
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].problem, 'stale-priorityBy');
});

test('an unparseable priorityBy value is bad-priorityBy-value, on a high plan', () => {
  const problems = findUnbackedHigh([entry('ready', '1000-Other-foo.md', FMB('high', 'vibes'))]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].problem, 'bad-priorityBy-value');
  assert.match(problems[0].message, /priorityBy: vibes` does not parse/);
});

test('an unparseable priorityBy value is bad-priorityBy-value even on a non-high plan (never waved through as merely stale)', () => {
  const problems = findUnbackedHigh([entry('ready', '1000-Other-foo.md', FMB('medium', 'vibes'))]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].problem, 'bad-priorityBy-value');
});

test('an impossible calendar date in priorityBy is bad-priorityBy-value', () => {
  const problems = findUnbackedHigh([
    entry('ready', '1000-Other-foo.md', FMB('high', 'operator 2026-13-45')),
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].problem, 'bad-priorityBy-value');
});

test('a medium/low plan with no priorityBy at all is clean', () => {
  assert.deepEqual(
    findUnbackedHigh([
      entry('ready', '1000-Other-foo.md', FMB('medium', null)),
      entry('ready', '1001-Other-bar.md', FMB('low', null)),
      entry('ready', '1002-Other-baz.md', FMB(null, null)),
    ]),
    [],
  );
});

test('archive/ and parked/ are skipped for findUnbackedHigh too, even with a blatant unbacked high', () => {
  assert.deepEqual(
    findUnbackedHigh([
      entry('archive', '1000-Other-foo.md', FMB('high', null)),
      entry('parked', '1001-Other-bar.md', FMB('high', null)),
    ]),
    [],
  );
});

// ── The grandfathering allowlist (plan 3999 § The corpus) ──────────────────────────────────

test('BARE_HIGH_GRANDFATHERED_2026_09_13 carries exactly the ten measured ids', () => {
  assert.deepEqual(
    [...BARE_HIGH_GRANDFATHERED_2026_09_13].sort(),
    ['1823', '3915', '3925', '3973', '3974', '3986', '4003', '4004', '4005', '4006'].sort(),
  );
});

test('a grandfathered id with a bare priority: high passes (default allowlist)', () => {
  assert.deepEqual(
    findUnbackedHigh([entry('in-progress', '3973-FABLE-Coord-thing.md', FMB('high', null))]),
    [],
  );
});

test('an injected grandfather set is honoured instead of the live default (tests drive their own set)', () => {
  assert.deepEqual(
    findUnbackedHigh([entry('ready', '9001-Other-foo.md', FMB('high', null))], {
      grandfathered: new Set(['9001']),
    }),
    [],
  );
  // The same id is refused with the default set, proving the injection actually took effect.
  const problems = findUnbackedHigh([entry('ready', '9001-Other-foo.md', FMB('high', null))]);
  assert.equal(problems.length, 1);
});

test('grandfathering is keyed by id, not basename — a retitled/moved grandfathered id still passes', () => {
  assert.deepEqual(
    findUnbackedHigh([
      entry(
        'waiting-operator',
        '3973-FABLE-Coord-a-totally-different-slug-now.md',
        FMB('high', null),
      ),
    ]),
    [],
  );
});

test('grandfathering exempts ONLY unbacked-high — a bad priorityBy VALUE on a grandfathered id still fails', () => {
  const problems = findUnbackedHigh([
    entry('in-progress', '3973-FABLE-Coord-thing.md', FMB('high', 'vibes')),
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].problem, 'bad-priorityBy-value');
});

test('grandfathering does not exempt a NON-grandfathered id sharing no relationship to the list', () => {
  const problems = findUnbackedHigh([entry('ready', '9999-Other-foo.md', FMB('high', null))]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].problem, 'unbacked-high');
});

test('a mixed batch reports only the offending plans, mirroring findIllegalPriority', () => {
  const problems = findUnbackedHigh([
    entry('ready', '1000-Other-foo.md', FMB('high', 'directive 2141-critical-path')), // clean
    entry('ready', '1001-Other-bar.md', FMB('high', null)), // unbacked
    entry('in-progress', '1002-Other-baz.md', FMB('medium', null)), // clean
    entry('archive', '1003-Other-qux.md', FMB('high', null)), // skipped
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].basename, '1001-Other-bar.md');
});

// review fix round 1 (keys 5898e9/711687): a PRESENT-but-EMPTY `priorityBy:` line reads
// identically to ABSENT under a plain frontmatter read, so it used to slip past this lint too. It
// is 'bad-priorityBy-value' on any tier.
test('a present but empty priorityBy: is bad-priorityBy-value, not silently accepted', () => {
  const content = [
    '---',
    'summary: x',
    'priority: medium',
    'priorityBy:',
    '---',
    '',
    '# T',
    '',
  ].join('\n');
  const problems = findUnbackedHigh([entry('ready', '1000-Other-foo.md', content)]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].problem, 'bad-priorityBy-value');
  assert.match(problems[0].message, /priorityBy:` is present but has no value/);
});

// review fix round 1 (key 32672c): the fix sentence is TIER-AWARE — a bad VALUE on a medium/low
// plan (its `priority:` stamp is fine, only the payload isn't) must never suggest demoting a
// `priority: high` line that does not exist.
test('the fix sentence for a bad priorityBy VALUE on a medium/low plan does not suggest demoting a nonexistent priority: high line', () => {
  const problems = findUnbackedHigh([entry('ready', '1000-Other-foo.md', FMB('medium', 'vibes'))]);
  assert.equal(problems.length, 1);
  assert.doesNotMatch(
    problems[0].message,
    /--find "priority: high"/,
    'no dangling demote suggestion when the plan carries no priority: high line',
  );
});

test('the fix sentence for a bad priorityBy VALUE on a HIGH plan DOES offer the demote-to-medium escape hatch', () => {
  const problems = findUnbackedHigh([entry('ready', '1000-Other-foo.md', FMB('high', 'vibes'))]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /--find "priority: high" --replace "priority: medium"/);
});

test('the fix sentence for unbacked-high always offers the demote-to-medium escape hatch', () => {
  const problems = findUnbackedHigh([entry('ready', '1001-Other-bar.md', FMB('high', null))]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /--find "priority: high" --replace "priority: medium"/);
});

// review fix round 1 (keys dbf9e7/2a0c54): a FUTURE operator date is bad-priorityBy-value too —
// the lint shares priorityStampProblem with the mint refusal, so this is the same defaulted-`now`
// path (real "today") rather than a pinned one; a date far enough in the future to be safe from
// ever becoming "today" during a test run.
test('a FUTURE operator date in priorityBy is bad-priorityBy-value', () => {
  const problems = findUnbackedHigh([
    entry('ready', '1000-Other-foo.md', FMB('high', 'operator 2099-01-01')),
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].problem, 'bad-priorityBy-value');
});
