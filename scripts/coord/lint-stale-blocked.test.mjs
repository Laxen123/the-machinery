// scripts/lint-stale-blocked.test.mjs — unit tests for the pure findStaleBlocked
// selector. node:test, no fs/git; corpus injected as an id→folder map. The Blocked-by
// parsing itself is covered by blocked-by-lib.test.mjs — here we assert the flag set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findStaleBlocked,
  findCostMisfiledOperator,
  findStrikethroughBlocked,
  findBlockedByInActiveFolder,
  findTailBlockedBy,
} from './lint-stale-blocked.mjs';

const corpus = (map) => (id) => map[id] ?? null;

// isShipped stub for tests exercising the pre-1836 "archive/ = cleared" shape — every
// archived id in this test's corpus is treated as shipped, isolating the test's intent
// (blocked vs. archived) from the separate shipped-vs-closed axis (plan 1836).
const shippedAll = () => true;

const wb = (basename, blockedBy) => ({
  basename,
  content: `# ${basename}\n\n**Blocked-by:** ${blockedBy}\n`,
});

test('flags a plan whose every named blocker has archived-and-shipped → promotable', () => {
  const entries = [
    wb('484-INTL-x.md', 'plan 477 and the 474 family. Revive when BOTH have landed.'),
  ];
  const found = findStaleBlocked(entries, corpus({ 474: 'archive', 477: 'archive' }), shippedAll);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'promotable');
  assert.deepEqual(found[0].ids, ['474', '477']);
});

test('does NOT flag a plan with a still-open blocker', () => {
  const entries = [wb('484-INTL-x.md', 'plan 477 and the 474 family.')];
  assert.deepEqual(
    findStaleBlocked(entries, corpus({ 474: 'in-progress', 477: 'archive' }), shippedAll),
    [],
  );
});

test('flags all-archived-and-shipped-plus-gate as REVIEW (not auto-promotable)', () => {
  const entries = [wb('305-x.md', 'plan 479 + operator green-light to promote')];
  const found = findStaleBlocked(entries, corpus({ 479: 'archive' }), shippedAll);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'review');
  assert.equal(found[0].gate, true);
});

test('does NOT flag a pure trip/calendar gate (no plan-id blocker)', () => {
  const entries = [
    wb('213-P07-x.md', 'first natural price-page change — cron surfaces ≥1 changed clinic'),
  ];
  assert.deepEqual(findStaleBlocked(entries, corpus({}), shippedAll), []);
});

test('reports only the stale plans in a mixed batch', () => {
  const entries = [
    wb('400-a.md', 'plan 300'), // 300 archived-and-shipped → stale
    wb('401-b.md', 'plan 301'), // 301 still ready → blocked
  ];
  const found = findStaleBlocked(entries, corpus({ 300: 'archive', 301: 'ready' }), shippedAll);
  assert.deepEqual(
    found.map((f) => f.basename),
    ['400-a.md'],
  );
});

// ── plan 1836: shipped-vs-closed — archive/ presence alone does not prove the
// blocking work landed. Mirrors the queue-drain.test.mjs cases plan 1819 added.

test('isShipped omitted (default) → an archived blocker does NOT clear (fail-safe strict default)', () => {
  const entries = [wb('484-INTL-x.md', 'plan 477')];
  assert.deepEqual(findStaleBlocked(entries, corpus({ 477: 'archive' })), []);
});

test('a blocker archived but NOT shipped (SUPERSEDED) is NOT flagged — the plan stays genuinely blocked', () => {
  const entries = [wb('602-Infra-x.md', 'plan 500')];
  const isShipped = () => false; // 500 archived SUPERSEDED, never shipped
  assert.deepEqual(findStaleBlocked(entries, corpus({ 500: 'archive' }), isShipped), []);
});

// ── plan 1065: cost is never an operator hold ────────────────────────────────
test('findCostMisfiledOperator: flags a waiting-operator plan with unblock: cost', () => {
  const entries = [
    { basename: '1062-DQ-x.md', content: '---\nsummary: x\nunblock: cost\n---\n# x\n' },
    { basename: '1063-DQ-y.md', content: '---\nunblock: decision\n---\n# y\n' },
    { basename: '1064-DQ-z.md', content: '# z (no frontmatter)\n' },
  ];
  const found = findCostMisfiledOperator(entries);
  assert.deepEqual(
    found.map((f) => f.basename),
    ['1062-DQ-x.md'],
  );
  assert.equal(found[0].id, '1062');
});

// ── plan 2174: flag the strikethrough/CLEARED Blocked-by idiom at write time in ANY
// active status folder ("(iv)" of the plan's acceptance criteria) ─────────────────

test('findStrikethroughBlocked: flags a struck-then-CLEARED Blocked-by line', () => {
  const entries = [
    wb('2142-DQ-x.md', '~~2123~~ CLEARED (spec-sweep) — 2123 landed. Executable now.'),
  ];
  const found = findStrikethroughBlocked(entries);
  assert.equal(found.length, 1);
  assert.equal(found[0].basename, '2142-DQ-x.md');
  assert.equal(found[0].id, '2142');
  assert.deepEqual(found[0].lines, [
    '~~2123~~ CLEARED (spec-sweep) — 2123 landed. Executable now.',
  ]);
});

test('findStrikethroughBlocked: flags a bare "cleared" token even without `~~`', () => {
  const entries = [wb('2145-DQ-y.md', 'cleared — 2096 landed 2026-07-20 (build log).')];
  const found = findStrikethroughBlocked(entries);
  assert.deepEqual(
    found.map((f) => f.basename),
    ['2145-DQ-y.md'],
  );
});

test('findStrikethroughBlocked: does NOT flag a plain "none — <id> landed" line', () => {
  const entries = [wb('2145-DQ-y.md', 'none — 2096 landed 2026-07-20 (build log).')];
  assert.deepEqual(findStrikethroughBlocked(entries), []);
});

test('findStrikethroughBlocked: does NOT flag an ordinary still-open blocker', () => {
  const entries = [wb('484-INTL-x.md', 'plan 477 and the 474 family.')];
  assert.deepEqual(findStrikethroughBlocked(entries), []);
});

// --- plan 2446: findTailBlockedBy — a Blocked-by line parked in a close-out tail ------

test('findTailBlockedBy: flags a Blocked-by line that sits inside a close-out tail', () => {
  const content = [
    '# 3000-Other-x',
    '',
    '## Scope',
    '',
    'No real blockers in the body.',
    '',
    "## Close-out follow-up (operator-local tail — split-don't-sink)",
    '',
    '**Blocked-by:** plan 9000 (operator-local follow-up dependency only)',
    '',
    '## Verification',
    '',
    'node --test scripts/…',
  ].join('\n');
  const found = findTailBlockedBy([{ basename: '3000-Other-x.md', content }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].basename, '3000-Other-x.md');
  assert.equal(found[0].id, '3000');
  assert.deepEqual(found[0].lines, ['plan 9000 (operator-local follow-up dependency only)']);
});

test('findTailBlockedBy: does NOT flag a Blocked-by line in the drainable body', () => {
  const entries = [wb('484-INTL-x.md', 'plan 477 and the 474 family.')];
  assert.deepEqual(findTailBlockedBy(entries), []);
});

test('findTailBlockedBy: does NOT flag a close-out tail with no Blocked-by line at all', () => {
  const content = [
    '# 3001-Other-x',
    '',
    "## Close-out follow-up (operator-local tail — split-don't-sink)",
    '',
    'purely descriptive prose, no blocker.',
  ].join('\n');
  assert.deepEqual(findTailBlockedBy([{ basename: '3001-Other-x.md', content }]), []);
});

test('findCostMisfiledOperator: clean when no waiting-operator plan is cost-gated', () => {
  const entries = [
    { basename: '1063-DQ-y.md', content: '---\nunblock: manual\n---\n# y\n' },
    { basename: '1064-DQ-z.md', content: '---\nunblock: decision\n---\n# z\n' },
  ];
  assert.deepEqual(findCostMisfiledOperator(entries), []);
});

// --- plan 2378: Blocked-by in an ACTIVE, NON-waiting folder -------------------------
// Acceptance criteria 1-4 from the plan body, each as its own case. `folder` is the
// third field the loader tags every active entry with (see loadCorpus).

const inFolder = (basename, folder, blockedBy) => ({
  basename,
  folder,
  content:
    blockedBy === null
      ? `# ${basename}\n\nNo blocker line here.\n`
      : `# ${basename}\n\n**Blocked-by:** ${blockedBy}\n`,
});

test('2378 A1: ready/ + LIVE blocker → LIVE bucket', () => {
  const { live, stale } = findBlockedByInActiveFolder(
    [inFolder('2358-Pipe-x.md', 'ready', 'plan 2357 — the serial family lands first')],
    corpus({ 2357: 'in-progress' }),
    shippedAll,
  );
  assert.equal(stale.length, 0);
  assert.equal(live.length, 1);
  assert.equal(live[0].kind, 'blocked');
  assert.equal(live[0].folder, 'ready');
  assert.deepEqual(live[0].ids, ['2357']);
});

test('2378 A1 (negative): the SAME body in waiting-blocked/ is not reported at all', () => {
  const { live, stale } = findBlockedByInActiveFolder(
    [inFolder('2358-Pipe-x.md', 'waiting-blocked', 'plan 2357 — the serial family lands first')],
    corpus({ 2357: 'in-progress' }),
    shippedAll,
  );
  assert.deepEqual(live, []);
  assert.deepEqual(stale, []);
});

test('2378 A2: ready/ + every blocker archived-and-shipped → STALE bucket, not LIVE', () => {
  const { live, stale } = findBlockedByInActiveFolder(
    [inFolder('2358-Pipe-x.md', 'ready', 'plan 2357 — lands first')],
    corpus({ 2357: 'archive' }),
    shippedAll,
  );
  assert.equal(live.length, 0);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].kind, 'promotable');
  assert.deepEqual(stale[0].ids, ['2357']);
});

test('2378 A3: a struck-through Blocked-by is left to findStrikethroughBlocked (no double-report)', () => {
  const entries = [inFolder('2367-Pipe-x.md', 'ready', '~~2357~~ CLEARED — landed 2026-07-25.')];
  const { live, stale } = findBlockedByInActiveFolder(
    entries,
    corpus({ 2357: 'archive' }),
    shippedAll,
  );
  assert.deepEqual(live, []);
  assert.deepEqual(stale, []);
  // ...and the OTHER bucket does own it, so the line is still surfaced exactly once.
  assert.equal(findStrikethroughBlocked(entries).length, 1);
});

test('2378 A3b: the leading-`CLEARED` idiom (no ~~) is likewise left to the strikethrough bucket', () => {
  const entries = [
    inFolder('2407-Pipe-x.md', 'ready', 'CLEARED 2026-07-25 (spec-sweep) — plan 2367 archived.'),
  ];
  const { live, stale } = findBlockedByInActiveFolder(
    entries,
    corpus({ 2367: 'archive' }),
    shippedAll,
  );
  assert.deepEqual(live, []);
  assert.deepEqual(stale, []);
  assert.equal(findStrikethroughBlocked(entries).length, 1);
});

test('2378 A4: a cost-only rationale is not reported (cost is never a blocker, plan 1065)', () => {
  const { live, stale } = findBlockedByInActiveFolder(
    [inFolder('999-Other-x.md', 'ready', 'operator-gated on the ~$8-10 claude -p spend')],
    corpus({}),
    shippedAll,
  );
  assert.deepEqual(live, []);
  assert.deepEqual(stale, []);
});

test('2378: a genuine non-plan gate in ready/ is LIVE (kind "review"), not STALE', () => {
  const { live, stale } = findBlockedByInActiveFolder(
    [
      inFolder(
        '999-Other-x.md',
        'ready',
        'plan 2357 landed, but the operator must approve the new scope',
      ),
    ],
    corpus({ 2357: 'archive' }),
    shippedAll,
  );
  assert.deepEqual(stale, []);
  assert.equal(live.length, 1);
  assert.equal(live[0].kind, 'review');
});

test('2378 folder scope: pending-approval/ is EXEMPT from LIVE but included in STALE', () => {
  const liveShape = findBlockedByInActiveFolder(
    [inFolder('999-Other-x.md', 'pending-approval', 'plan 2357 — a known upstream, not yet filed')],
    corpus({ 2357: 'in-progress' }),
    shippedAll,
  );
  assert.deepEqual(liveShape.live, [], 'a stub noting a known upstream pre-filing is legitimate');
  assert.deepEqual(liveShape.stale, []);

  const staleShape = findBlockedByInActiveFolder(
    [inFolder('999-Other-x.md', 'pending-approval', 'plan 2357 — landed')],
    corpus({ 2357: 'archive' }),
    shippedAll,
  );
  assert.equal(staleShape.stale.length, 1, 'a dead line is noise wherever it survives');
});

test('2378 folder scope: in-progress/ IS in the LIVE bucket', () => {
  const { live } = findBlockedByInActiveFolder(
    [inFolder('2141-DQ-x.md', 'in-progress', 'plans 2201+2202+2203 must land on master')],
    corpus({ 2201: 'ready', 2202: 'ready', 2203: 'ready' }),
    shippedAll,
  );
  assert.equal(live.length, 1);
  assert.equal(live[0].folder, 'in-progress');
});

test('2378 folder scope: waiting-*/ and archive/ are never bucketed', () => {
  for (const folder of ['waiting-operator', 'waiting-date', 'waiting-trip', 'waiting-grill']) {
    const { live, stale } = findBlockedByInActiveFolder(
      [inFolder('999-Other-x.md', folder, 'plan 2357 — open')],
      corpus({ 2357: 'ready' }),
      shippedAll,
    );
    assert.deepEqual(live, [], `${folder} must not be bucketed`);
    assert.deepEqual(stale, [], `${folder} must not be bucketed`);
  }
});

test('2378: a plan with no Blocked-by line at all is never bucketed', () => {
  const { live, stale } = findBlockedByInActiveFolder(
    [inFolder('999-Other-x.md', 'ready', null)],
    corpus({}),
    shippedAll,
  );
  assert.deepEqual(live, []);
  assert.deepEqual(stale, []);
});

test('2378: the runbook`s OWN cleared template is not reported (else the lint is loudest at plans that followed its advice)', () => {
  // `**Blocked-by:** none — <id> landed <date> (<evidence>).` is the exact replacement
  // this same script recommends in its strikethrough bucket.
  const { live, stale } = findBlockedByInActiveFolder(
    [inFolder('999-Other-x.md', 'ready', 'none — 2096 landed 2026-07-20 (verified on master).')],
    corpus({ 2096: 'archive' }),
    shippedAll,
  );
  assert.deepEqual(live, []);
  assert.deepEqual(stale, []);
});

test('2378: a leading `RESOLVED` declaration is not reported (live shape from plan 2403)', () => {
  const { live, stale } = findBlockedByInActiveFolder(
    [
      inFolder(
        '2403-Infra-x.md',
        'ready',
        'RESOLVED — plan 2382 archived 2026-07-25; verified landed on master (`wake-stalls.mjs:327`).',
      ),
    ],
    // The date fragment and the line number both ground to real archived plan ids in the
    // live corpus (2026-FABLE-Price-…, 327-Other-…), which is precisely how this line
    // reported five phantom "open blockers" before the skip existed.
    corpus({ 2382: 'archive', 2026: 'archive', 327: 'archive' }),
    (id) => id === '2382',
  );
  assert.deepEqual(live, []);
  assert.deepEqual(stale, []);
});

test('2378: a body stacking a cleared line AND a live one is still classified (the live line is the point)', () => {
  const content =
    '# x\n\n**Blocked-by:** none — 2096 landed.\n**Blocked-by:** plan 2357 — still open\n';
  const { live } = findBlockedByInActiveFolder(
    [{ basename: '999-Other-x.md', folder: 'ready', content }],
    corpus({ 2096: 'archive', 2357: 'ready' }),
    shippedAll,
  );
  assert.equal(live.length, 1);
  assert.ok(live[0].ids.includes('2357'));
});
