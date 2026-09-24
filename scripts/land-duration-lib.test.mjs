// scripts/land-duration-lib.test.mjs (plan 2443)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDiffShape,
  statsFor,
  summarizeByShape,
  NO_REBASE,
  attributeLands,
  fmtDuration,
  joinQueueDepth,
  parseCommitLog,
  parseQueueAudit,
  parseQueueDepth,
  percentile,
  slotAcquisitions,
  SKEW_TOLERANCE_SEC,
  summarize,
  summarizeByDepth,
} from './land-duration-lib.mjs';

// git log --format=%H|%ct|%P|%s, newest-first
const log = (rows) =>
  rows.map(([sha, ct, parents, subject]) => `${sha}|${ct}|${parents}|${subject}`).join('\n');

test('parseCommitLog keeps a subject containing pipes intact', () => {
  const [c] = parseCommitLog('abc|100|p1 p2|fix: a|b|c');
  assert.equal(c.sha, 'abc');
  assert.equal(c.ct, 100);
  assert.deepEqual(c.parents, ['p1', 'p2']);
  assert.equal(c.subject, 'fix: a|b|c');
});

test('parseCommitLog skips blank and malformed lines rather than throwing', () => {
  const out = parseCommitLog('\nabc|100|p|s\ngarbage\n\nx|notanumber|p|s\n');
  assert.equal(out.length, 1);
  assert.equal(out[0].sha, 'abc');
});

test('attributeLands brackets a land from its own coord markers', () => {
  const commits = parseCommitLog(
    log([
      ['deq', 1000, 'm', 'coord(queue): dequeue 900-Coord-thing'],
      ['m', 940, 'p1 tip', 'Merge worktree-900-Coord-thing: done 900-Coord-thing'],
      ['tip', 880, 'p0', '900: the actual work'],
      ['mil', 860, 'p', 'coord(queue): mark-in-land 900-Coord-thing'],
      ['enq', 800, 'p', 'coord(queue): enqueue 900-Coord-thing (🟩)'],
    ]),
  );
  const [land] = attributeLands(commits);
  assert.equal(land.slug, '900-Coord-thing');
  assert.equal(land.classification, null); // tip (880) >= enqueue (800) ⇒ the spine rebased it
  assert.equal(land.tipToMerge, 60); // 940 - 880: gate battery + ephemeral merge + push
  assert.equal(land.closeOut, 60); // 1000 - 940
  assert.equal(land.headHold, 140); // 1000 - 860
  assert.equal(land.enqueueToDequeue, 200); // 1000 - 800
});

test('a branch tip predating its own enqueue is classified out of tipToMerge, not truncated', () => {
  const commits = parseCommitLog(
    log([
      ['deq', 1000, 'm', 'coord(queue): dequeue 901-Coord-fast'],
      ['m', 940, 'p1 tip', 'Merge worktree-901-Coord-fast: done 901-Coord-fast'],
      ['enq', 800, 'p', 'coord(queue): enqueue 901-Coord-fast (🟩)'],
      ['tip', 100, 'p0', '901: work committed hours before the land'],
    ]),
  );
  const [land] = attributeLands(commits);
  assert.equal(land.classification, NO_REBASE);
  assert.equal(land.tipToMerge, null); // never 840 — that would measure idle time, not work
  assert.equal(land.closeOut, 60); // the other phases stay measurable
  assert.equal(summarize([land]).noRebase, 1);
});

test('a second parent outside the fetched window yields no tipToMerge and is counted', () => {
  const commits = parseCommitLog(
    log([
      ['deq', 1000, 'm', 'coord(queue): dequeue 902-Coord-shallow'],
      ['m', 940, 'p1 missingtip', 'Merge worktree-902-Coord-shallow: done 902-Coord-shallow'],
    ]),
  );
  const [land] = attributeLands(commits);
  assert.equal(land.tipAt, null);
  assert.equal(land.tipToMerge, null);
  assert.equal(land.classification, null);
  assert.equal(summarize([land]).tipUnknown, 1);
});

test('markers are anchored to THIS merge, so a slug landing twice does not cross-contaminate', () => {
  // the same plan re-parked and re-claimed later: two enqueue/merge/dequeue triples, one slug
  const commits = parseCommitLog(
    log([
      ['deq2', 3000, 'm2', 'coord(queue): dequeue 903-Coord-twice'],
      ['m2', 2900, 'q1 tip2', 'Merge worktree-903-Coord-twice: done 903-Coord-twice'],
      ['tip2', 2800, 'q0', '903: second run'],
      ['enq2', 2700, 'p', 'coord(queue): enqueue 903-Coord-twice (🟩)'],
      ['deq1', 1000, 'm1', 'coord(queue): dequeue 903-Coord-twice'],
      ['m1', 900, 'p1 tip1', 'Merge worktree-903-Coord-twice: done 903-Coord-twice'],
      ['tip1', 800, 'p0', '903: first run'],
      ['enq1', 700, 'p', 'coord(queue): enqueue 903-Coord-twice (🟩)'],
    ]),
  );
  const lands = attributeLands(commits);
  assert.equal(lands.length, 2);
  const [second, first] = lands; // newest-first
  assert.equal(second.enqueueToDequeue, 300); // 3000 - 2700, NOT 3000 - 700
  assert.equal(first.enqueueToDequeue, 300); // 1000 - 700, NOT the later dequeue
  assert.equal(first.closeOut, 100); // pairs with m1's own dequeue, not deq2
});

test('a merge with no dequeue yet (land still closing out) leaves those phases null', () => {
  const commits = parseCommitLog(
    log([
      ['m', 940, 'p1 tip', 'Merge worktree-904-Coord-open: done 904-Coord-open'],
      ['tip', 880, 'p0', '904: work'],
      ['enq', 800, 'p', 'coord(queue): enqueue 904-Coord-open (🟩)'],
    ]),
  );
  const [land] = attributeLands(commits);
  assert.equal(land.tipToMerge, 60);
  assert.equal(land.closeOut, null);
  assert.equal(land.headHold, null);
  assert.equal(land.enqueueToDequeue, null);
});

test('non-land merges and unrelated coord commits are ignored', () => {
  const commits = parseCommitLog(
    log([
      ['x', 500, 'a b', "Merge branch 'main' of github.com:user/repo"],
      ['y', 400, 'a', 'coord(queue): heartbeat 905-Coord-thing'],
      ['z', 300, 'a', 'docs(plans): move 905-Coord-thing.md ready/ → in-progress/'],
    ]),
  );
  assert.deepEqual(attributeLands(commits), []);
});

test('percentile is nearest-rank and null-safe on an empty sample', () => {
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
  assert.equal(percentile([10, 20, 30, 40], 0.9), 40);
  assert.equal(percentile([5], 0.5), 5);
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([1, null, undefined, NaN, 3], 0.5), 1); // non-finite entries dropped
});

test('summarize reports n per phase independently — a null phase shrinks only its own sample', () => {
  const lands = attributeLands(
    parseCommitLog(
      log([
        ['deq', 1000, 'm', 'coord(queue): dequeue 906-Coord-a'],
        ['m', 940, 'p1 tip', 'Merge worktree-906-Coord-a: done 906-Coord-a'],
        ['tip', 880, 'p0', '906: work'],
        ['enq', 800, 'p', 'coord(queue): enqueue 906-Coord-a (🟩)'],
      ]),
    ),
  );
  const s = summarize(lands);
  assert.equal(s.lands, 1);
  assert.equal(s.phases.tipToMerge.n, 1);
  assert.equal(s.phases.headHold.n, 0); // no mark-in-land marker in this sample
  assert.equal(s.phases.headHold.p50, null);
  assert.equal(s.phases.closeOut.p50, 60);
});

test('fmtDuration renders sub-minute, exact-minute and mixed values', () => {
  assert.equal(fmtDuration(45), '45s');
  assert.equal(fmtDuration(60), '1m');
  assert.equal(fmtDuration(366), '6m06s');
  assert.equal(fmtDuration(null), '—');
  assert.equal(fmtDuration(undefined), '—');
});

test('classifyDiffShape: a gate-heavy path wins over every other prefix in the same diff', () => {
  assert.equal(classifyDiffShape(['backend/src/x.ts', 'docs/y.md']), 'gateHeavy');
  assert.equal(classifyDiffShape(['frontend/src/a.tsx']), 'gateHeavy');
  assert.equal(classifyDiffShape(['shared/src/schemas.ts', 'scripts/z.mjs']), 'gateHeavy');
  // backend/tests fires the tier-2 FULL backend suite exactly like backend/src does
  // (.husky/pre-push "Tier 2"), so it is gate-heavy too — bucketing it as `other` filed those
  // lands as cheap when they are not (sonnet-review high, CONFIRMED)
  assert.equal(classifyDiffShape(['backend/tests/foo.test.ts']), 'gateHeavy');
  // a path merely CONTAINING the prefix elsewhere is not gate-heavy
  assert.equal(classifyDiffShape(['output/backend/src/x.ts']), 'other');
});

test('classifyDiffShape: docs/scripts buckets require EVERY path to match', () => {
  assert.equal(classifyDiffShape(['docs/a.md', 'wiki/b.md']), 'docsOnly');
  assert.equal(classifyDiffShape(['scripts/a.mjs', 'docs/b.md', '.husky/pre-push']), 'scriptsOnly');
  // one stray path outside the set drops it to `other`, never a cheaper bucket
  assert.equal(classifyDiffShape(['scripts/a.mjs', 'backend/tests/t.ts']), 'gateHeavy');
  assert.equal(classifyDiffShape(['scripts/a.mjs', 'backend/data/x.json']), 'other');
  assert.equal(classifyDiffShape(['docs/a.md', 'package.json']), 'other');
  assert.equal(classifyDiffShape([]), 'other');
  assert.equal(classifyDiffShape(null), 'other');
});

test('summarizeByShape buckets a phase and drops unclassifiable lands without crashing', () => {
  const lands = [
    { mergeSha: 'a', tipToMerge: 100 },
    { mergeSha: 'b', tipToMerge: 300 },
    { mergeSha: 'c', tipToMerge: 50 },
    { mergeSha: 'd', tipToMerge: null }, // no measurable phase → not counted anywhere
    { mergeSha: 'e', tipToMerge: 999 }, // shapeOf returns null (unreachable parent) → dropped
  ];
  const shapes = { a: 'gateHeavy', b: 'gateHeavy', c: 'docsOnly', e: null };
  const out = summarizeByShape(lands, (l) => shapes[l.mergeSha]);
  assert.equal(out.gateHeavy.n, 2);
  assert.equal(out.gateHeavy.p50, 100);
  assert.equal(out.gateHeavy.max, 300, 'per-shape stats carry max, like summarize()');
  assert.equal(out.docsOnly.n, 1);
  assert.equal(out.scriptsOnly.n, 0);
  assert.equal(out.scriptsOnly.p50, null);
  assert.equal(out.other.n, 0);
});

test('statsFor is the ONE aggregation summarize and summarizeByShape share', () => {
  assert.deepEqual(statsFor([10, 20, 30, 40]), { n: 4, p50: 20, p90: 40, max: 40 });
  assert.deepEqual(statsFor([]), { n: 0, p50: null, p90: null, max: null });
  assert.deepEqual(statsFor([5, null, NaN, undefined]), { n: 1, p50: 5, p90: 5, max: 5 });
  // the drift this replaced: `max` was in one copy and missing from the other
  const viaSummarize = summarize([{ closeOut: 10 }, { closeOut: 90 }]).phases.closeOut;
  const viaShape = summarizeByShape(
    [
      { mergeSha: 'x', tipToMerge: 10 },
      { mergeSha: 'y', tipToMerge: 90 },
    ],
    () => 'gateHeavy',
  ).gateHeavy;
  assert.deepEqual(Object.keys(viaSummarize).sort(), Object.keys(viaShape).sort());
});

// --- depth-at-enqueue (plan 2467) ------------------------------------------------------------

// Carries BOTH sentinel regions, because parseQueueDepth/parseQueueAudit delegate to
// landing-queue-lib.mjs's parseQueue — which owns the format and requires both.
const queueDoc = (slugs, auditLines = []) =>
  [
    '# Landing queue',
    '',
    '<!-- QUEUE-START -->',
    '| slug | lane | session | host | enqueued | heartbeat | pid | state | reap-armed | priority |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...slugs.map((s) => `| ${s} | 🟩 | 1 | h | t | t | 1 | QUEUED |  |  |`),
    '<!-- QUEUE-END -->',
    '',
    '## Audit (steals)',
    '<!-- AUDIT-START -->',
    ...auditLines,
    '<!-- AUDIT-END -->',
    '| not-the-queue | this row lives outside the sentinels |',
  ].join('\n');

test('parseQueueDepth counts only the rows between the sentinels, skipping header + separator', () => {
  assert.deepEqual(parseQueueDepth(queueDoc(['a', 'b', 'c']), 'b'), { depth: 3, position: 2 });
  assert.deepEqual(parseQueueDepth(queueDoc(['only']), 'only'), { depth: 1, position: 1 });
  // an empty table is depth 0, and a slug that is not in it gets position 0 — never a crash
  assert.deepEqual(parseQueueDepth(queueDoc([]), 'x'), { depth: 0, position: 0 });
  assert.deepEqual(parseQueueDepth(queueDoc(['a']), 'x'), { depth: 1, position: 0 });
});

test('parseQueueDepth returns null when the sentinels are missing — not a zero-depth queue', () => {
  // a snapshot predating the queue table must never read as "the queue was empty"
  assert.equal(parseQueueDepth('# Landing queue\n\nno sentinels here\n', 'a'), null);
  assert.equal(parseQueueDepth('<!-- QUEUE-END -->\n<!-- QUEUE-START -->', 'a'), null);
  assert.equal(parseQueueDepth('', 'a'), null);
  assert.equal(parseQueueDepth(null, 'a'), null);
  // parseQueue requires BOTH regions, so a QUEUE-only snapshot also reads as "unknown" rather
  // than "empty" — the conservative direction, and why measureDepth reports an `unresolved`
  // count instead of folding such lands into the empty bucket.
  assert.equal(
    parseQueueDepth('<!-- QUEUE-START -->\n| slug | a | b | c | d | e |\n<!-- QUEUE-END -->', 'a'),
    null,
  );
});

test('slotAcquisitions picks up enqueue AND reenter, ascending, ignoring requeue/demote', () => {
  const commits = parseCommitLog(
    log([
      ['s4', 400, 'p', 'coord(queue): reenter 900-Coord-thing (🟩)'],
      [
        's3',
        300,
        'p',
        'coord(queue): demote stale not-landing head to tail — waiter 900-Coord-thing',
      ],
      ['s2', 200, 'p', 'coord(queue): requeue 900-Coord-thing to tail'],
      ['s1', 100, 'p', 'coord(queue): enqueue 900-Coord-thing (🟩)'],
      ['s0', 90, 'p', 'coord(queue): dequeue 901-Other-thing'],
    ]),
  );
  const acqs = slotAcquisitions(commits);
  assert.deepEqual(
    acqs.map((a) => [a.kind, a.slug, a.ct, a.sha]),
    [
      ['enqueue', '900-Coord-thing', 100, 's1'],
      ['reenter', '900-Coord-thing', 400, 's4'],
    ],
    'requeue/demote MOVE an existing entry — they are not slot acquisitions',
  );
});

test('joinQueueDepth rides the LATEST acquisition before the merge, so a reenter supersedes', () => {
  const lands = [{ slug: 'x', mergeSha: 'm', mergeAt: 500, dequeueAt: 600 }];
  const acqs = [
    { kind: 'enqueue', slug: 'x', ct: 100, sha: 'e1' },
    { kind: 'reenter', slug: 'x', ct: 400, sha: 'r1' },
    { kind: 'enqueue', slug: 'x', ct: 900, sha: 'e2' }, // AFTER the merge — a later, different land
  ];
  const depths = { e1: { depth: 4, position: 4 }, r1: { depth: 1, position: 1 } };
  const [out] = joinQueueDepth(lands, acqs, (sha) => depths[sha] ?? null);
  assert.equal(out.acquireSha, 'r1');
  assert.equal(out.acquireKind, 'reenter');
  assert.equal(out.depthAtEnqueue, 1, 'the stale pre-rework depth of 4 must not be read');
  assert.equal(out.slotWindow, 200, 'slot window is acquisition → dequeue');
});

test('joinQueueDepth counts waiters inside the slot window, padded OUTWARD for skew', () => {
  // Window is 10_000 → 20_000; the padding is SKEW_TOLERANCE_SEC on each side, and it widens
  // deliberately so the waiter count is an UPPER bound (see § CLOCK SKEW).
  const lands = [{ slug: 'head', mergeSha: 'm', mergeAt: 19_000, dequeueAt: 20_000 }];
  const acqs = [
    { kind: 'enqueue', slug: 'wayBefore', ct: 10_000 - SKEW_TOLERANCE_SEC - 1, sha: 'b' },
    { kind: 'enqueue', slug: 'head', ct: 10_000, sha: 'h' },
    { kind: 'enqueue', slug: 'w1', ct: 12_000, sha: 'w1' }, // 8000s of this land's window left
    { kind: 'enqueue', slug: 'w2', ct: 19_500, sha: 'w2' }, // 500s left
    { kind: 'enqueue', slug: 'wayAfter', ct: 20_000 + SKEW_TOLERANCE_SEC + 1, sha: 'a' },
  ];
  const [out] = joinQueueDepth(lands, acqs, () => ({ depth: 1, position: 1 }));
  assert.equal(out.waiters, 2, 'events beyond the tolerance on either side are excluded');
  assert.deepEqual(out.waiterDelays, [8000, 500]);
  // a waiter just inside the tolerance IS counted — biasing the cost UP, against the
  // "empty-queue lands block nobody" reading this measurement is used to support
  const [padded] = joinQueueDepth(
    lands,
    [...acqs, { kind: 'enqueue', slug: 'skewed', ct: 10_000 - 60, sha: 's' }],
    () => ({ depth: 1, position: 1 }),
  );
  assert.equal(padded.waiters, 3);
});

test('joinQueueDepth nulls the depth fields rather than dropping an unmeasurable land', () => {
  const acqs = [{ kind: 'enqueue', slug: 'x', ct: 100, sha: 'e1' }];
  // no acquisition for this slug at all
  const [noAcq] = joinQueueDepth([{ slug: 'y', mergeSha: 'm', mergeAt: 500 }], acqs, () => null);
  assert.equal(noAcq.slug, 'y', 'the land survives the join');
  assert.equal(noAcq.depthAtEnqueue, null);
  assert.equal(noAcq.waiters, null);
  // an acquisition whose snapshot has no sentinels → depth null, but the window still resolves
  const [noDepth] = joinQueueDepth(
    [{ slug: 'x', mergeSha: 'm', mergeAt: 500, dequeueAt: 600 }],
    acqs,
    () => null,
  );
  assert.equal(noDepth.acquireSha, 'e1');
  assert.equal(noDepth.depthAtEnqueue, null);
  assert.equal(noDepth.slotWindow, 500);
  // and a land still closing out (no dequeue) has no window to measure waiters against
  const [noDeq] = joinQueueDepth([{ slug: 'x', mergeSha: 'm', mergeAt: 500 }], acqs, () => ({
    depth: 2,
    position: 2,
  }));
  assert.equal(noDeq.depthAtEnqueue, 2);
  assert.equal(noDeq.slotWindow, null);
  assert.equal(noDeq.waiters, null);
});

test('summarizeByDepth splits empty (depth 1) from busy (depth > 1) and sizes waiter arrival', () => {
  const lands = [
    { depthAtEnqueue: 1, tipToMerge: 100, slotWindow: 120, waiters: 0, waiterDelays: [] },
    { depthAtEnqueue: 1, tipToMerge: 300, slotWindow: 400, waiters: 2, waiterDelays: [60, 30] },
    { depthAtEnqueue: 3, tipToMerge: 200, slotWindow: 900, waiters: 1, waiterDelays: [500] },
    { depthAtEnqueue: null, tipToMerge: 999, slotWindow: 1, waiters: 9, waiterDelays: [9] },
  ];
  const out = summarizeByDepth(lands);
  assert.equal(out.empty.lands, 2);
  assert.equal(out.empty.n, 2);
  assert.equal(out.empty.withWaiter, 1, 'half the empty-queue lands never saw a waiter');
  assert.equal(out.empty.aggregateWaitSec, 90);
  assert.equal(out.empty.waiterDelay.n, 2, 'both delays from the one land with waiters');
  assert.equal(out.empty.waiterDelay.p50, 30, 'nearest-rank p50 of [30, 60]');
  assert.equal(out.empty.waiterDelay.max, 60);
  assert.equal(out.busy.lands, 1);
  assert.equal(out.busy.aggregateWaitSec, 500);
  assert.equal(out.busy.slotWindow.p50, 900);
  // depth 0 is not a bucket: an unresolvable land belongs to neither, never silently to "empty"
  assert.equal(out.empty.lands + out.busy.lands, 3);
});

test('summarizeByDepth counts a land with a depth but no measurable phase', () => {
  const out = summarizeByDepth([
    { depthAtEnqueue: 1, tipToMerge: null, slotWindow: 60, waiters: 1, waiterDelays: [10] },
  ]);
  assert.equal(out.empty.lands, 1, 'the land is in the bucket');
  assert.equal(out.empty.n, 0, 'but contributes no tip→merge sample');
  assert.equal(out.empty.withWaiter, 1);
});

const auditDoc = (lines) =>
  `${queueDoc([], lines)}\n- 2026-01-01T00:00:00.000Z — outside the region, must be ignored`;

test('parseQueueAudit names the DISPLACED entry for every head-release verb', () => {
  const out = parseQueueAudit(
    auditDoc([
      '- 2026-07-11T10:59:44.022Z — auto-demote: 1711-DQ-thing → tail (heartbeat age 18m > 15m, not landing) by 1649-DQ-other',
      '- 2026-07-09T22:53:05.002Z — batch-2026-07-08-coord-spine3 requeued to tail — heavy head rework: source-edit rework',
      '- 2026-07-06T12:56:30.609Z — batch-2026-07-06-seed-dq stole the head slot from 1496-Infra-roster (heartbeat stale 147m)',
    ]),
  );
  assert.deepEqual(
    out.map((e) => [e.verb, e.slug]),
    [
      // ascending by the audit line's own stamp, NOT the order they appear
      ['steal', '1496-Infra-roster'], // the VICTIM, not the thief
      ['requeue', 'batch-2026-07-08-coord-spine3'],
      ['demote', '1711-DQ-thing'], // the DEMOTED head, not the waiter that demoted it
    ],
    'the commit subject for a demote names the demoter — only the audit line names the demoted',
  );
  assert.equal(out[0].ct, Math.floor(Date.parse('2026-07-06T12:56:30.609Z') / 1000));
});

test('parseQueueAudit skips unparseable and unstamped lines instead of guessing', () => {
  assert.deepEqual(
    parseQueueAudit(auditDoc(['- not a known verb at all', '- — auto-demote: x → tail'])),
    [],
  );
  assert.deepEqual(parseQueueAudit(auditDoc(['- notadate — auto-demote: x → tail'])), []);
  assert.deepEqual(parseQueueAudit('no sentinels'), []);
  assert.deepEqual(parseQueueAudit(null), []);
});

test('joinQueueDepth flags a land that lost the head inside its own slot window', () => {
  const lands = [{ slug: 'x', mergeSha: 'm', mergeAt: 900, dequeueAt: 1000 }];
  const acqs = [{ kind: 'enqueue', slug: 'x', ct: 100, sha: 'e' }];
  const depth = () => ({ depth: 1, position: 1 });
  const inside = joinQueueDepth(lands, acqs, depth, {
    audit: [{ ct: 500, slug: 'x', verb: 'requeue' }],
  });
  assert.equal(inside[0].releasedHead, true);
  // an event for a DIFFERENT slug, or well outside the window, must not flag this land.
  // "well outside" = beyond SKEW_TOLERANCE_SEC — the boundary itself is padded on purpose, and
  // that padding has its own test below.
  const outside = joinQueueDepth(lands, acqs, depth, {
    audit: [
      { ct: 500, slug: 'other', verb: 'demote' },
      { ct: 100 - SKEW_TOLERANCE_SEC - 1, slug: 'x', verb: 'demote' },
      { ct: 1000 + SKEW_TOLERANCE_SEC + 1, slug: 'x', verb: 'demote' },
    ],
  });
  assert.equal(outside[0].releasedHead, false);
  // no audit supplied at all → nothing is flagged, never null-crashes downstream
  assert.equal(joinQueueDepth(lands, acqs, depth)[0].releasedHead, false);
});

test('summarizeByDepth excludes head-released lands from waiter stats and REPORTS the count', () => {
  const out = summarizeByDepth([
    // a genuine empty-queue head that blocked one waiter for 100s
    { depthAtEnqueue: 1, tipToMerge: 100, slotWindow: 200, waiters: 1, waiterDelays: [100] },
    // the wedge shape: it stepped off the head, so its 3 "waiters" are NOT its doing
    {
      depthAtEnqueue: 1,
      tipToMerge: 200,
      slotWindow: 9000,
      waiters: 3,
      waiterDelays: [8000, 7000, 6000],
      releasedHead: true,
    },
  ]);
  assert.equal(out.empty.lands, 2, 'both lands stay in the bucket');
  assert.equal(out.empty.n, 2, 'and both contribute a tip→merge sample');
  assert.equal(out.empty.headReleased, 1);
  assert.equal(out.empty.withWaiter, 1, 'only the attributable land counts as having a waiter');
  assert.equal(out.empty.aggregateWaitSec, 100, '21000s of unattributable waiting is excluded');
  assert.equal(out.empty.waiterDelay.max, 100);
  assert.equal(out.empty.slotWindow.max, 9000, 'slot window still describes both lands');
});

test('releasedHead is padded by SKEW_TOLERANCE_SEC so inter-machine skew cannot hide a wedge', () => {
  const lands = [{ slug: 'x', mergeSha: 'm', mergeAt: 9000, dequeueAt: 10000 }];
  const acqs = [{ kind: 'enqueue', slug: 'x', ct: 1000, sha: 'e' }];
  const depth = () => ({ depth: 1, position: 1 });
  const at = (ct) =>
    joinQueueDepth(lands, acqs, depth, { audit: [{ ct, slug: 'x', verb: 'demote' }] })[0]
      .releasedHead;
  // a release recorded by a skewed clock, just OUTSIDE the raw window, is still caught: missing
  // it would re-admit that land's unattributable waiters into the headline aggregate
  assert.equal(at(1000 - 60), true, 'up to the tolerance before acquisition');
  assert.equal(at(10000 + 60), true, 'up to the tolerance after dequeue');
  // and the padding is bounded — it does not swallow arbitrarily distant events
  assert.equal(at(1000 - SKEW_TOLERANCE_SEC - 1), false);
  assert.equal(at(10000 + SKEW_TOLERANCE_SEC + 1), false);
  assert.ok(SKEW_TOLERANCE_SEC > 55 * 2, 'tolerance must exceed 2x the measured 55s worst case');
});

// The audit-line GRAMMAR is written by landing-queue-lib.mjs / landing-queue.mjs and read here.
// sonnet-review high CONFIRMED that this is now the third independent regex derivation of those
// literal strings (landing-queue-lib's own demoteAuditCount matcher and
// mine-sonnet-lane-executor-telemetry's mineQueueContention are the other two), and that a
// wording change would make an unmatched line read as merely "skip" — silent under-counting.
// Consolidating all three onto one owner is filed separately; THIS test removes the silence for
// this consumer by feeding parseQueueAudit the real producers' actual output.
test('parseQueueAudit matches the audit lines the real producers emit (drift tripwire)', async () => {
  const { applyDemote, applySteal } = await import('./coord/landing-queue-lib.mjs');
  const iso = '2026-07-26T12:00:00.000Z';
  const entries = [
    { slug: 'head-slug', lane: '🟩', session: '1', host: 'h', enqueuedIso: iso, heartbeatIso: iso },
    {
      slug: 'waiter-slug',
      lane: '🟩',
      session: '2',
      host: 'h',
      enqueuedIso: iso,
      heartbeatIso: iso,
    },
  ];
  const demote = applyDemote(entries, 'waiter-slug', iso, 18, 15);
  const steal = applySteal(entries, 'stealer-slug', iso, 147);
  // landing-queue.mjs's requeue verb builds its line inline (not via the lib), so it is pinned
  // here as the literal template that file emits.
  const requeueLine = `- ${iso} — head-slug requeued to tail — heavy head rework`;

  const parsed = parseQueueAudit(queueDoc([], [demote.auditLine, steal.auditLine, requeueLine]));
  const byVerb = Object.fromEntries(parsed.map((e) => [e.verb, e.slug]));
  assert.equal(byVerb.demote, 'head-slug', 'the DEMOTED head, not the waiter that demoted it');
  assert.equal(byVerb.steal, 'head-slug', 'the VICTIM, not the stealer');
  assert.equal(byVerb.requeue, 'head-slug');
  assert.equal(parsed.length, 3, 'every producer line parsed — an unmatched one would be skipped');
});
