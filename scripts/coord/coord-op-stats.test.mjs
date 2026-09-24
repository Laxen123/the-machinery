// scripts/coord/coord-op-stats.test.mjs — unit tests for coord-op-stats.mjs (plan 4087, T0).
//
// New file justified: coord-op-stats.mjs is a genuinely new module (a read-only journal-stats
// reader that did not exist before), so this is its name-paired test file per vetapp CLAUDE.md's
// new-test-file rule.
//
// No ambient machine state: every fixture below is a hand-built JSONL string fed straight to the
// pure functions (`parseJournalText`, `computeCoordOpStats`) — never a real journal file, never
// the real clock (the one age-based assertion checks `ageMs >= 0` against a start time computed
// relative to `Date.now()` at test time, not a hardcoded wall-clock value), never real git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJournalText,
  computeCoordOpStats,
  listArchiveJournalPaths,
  collectJournalEntries,
} from './coord-op-stats.mjs';

function line(obj) {
  return JSON.stringify(obj);
}

test('parseJournalText: skips unparseable lines and counts them, ignores blank lines', () => {
  const text = [
    line({ ts: '2026-09-22T10:00:00.000Z', tool: 'edit-plan', token: 't1', phase: 'start' }),
    'not json at all {{{',
    '',
    line({ ts: '2026-09-22T10:00:01.000Z', tool: 'edit-plan', token: 't1', phase: 'done' }),
  ].join('\n');
  const { entries, badLines } = parseJournalText(text);
  assert.equal(badLines, 1);
  assert.equal(entries.length, 2);
});

test('computeCoordOpStats: a matched start/done pair is one completed op with the right duration', () => {
  const entries = [
    {
      ts: '2026-09-22T10:00:00.000Z',
      pid: 100,
      host: 'H',
      tool: 'edit-plan',
      token: 't1',
      phase: 'start',
    },
    {
      ts: '2026-09-22T10:00:02.500Z',
      pid: 100,
      host: 'H',
      tool: 'edit-plan',
      token: 't1',
      phase: 'done',
    },
  ];
  const stats = computeCoordOpStats(entries);
  assert.equal(stats.tools.length, 1);
  const t = stats.tools[0];
  assert.equal(t.tool, 'edit-plan');
  assert.equal(t.completed, 1);
  assert.equal(t.p50Ms, 2500);
  assert.equal(t.maxMs, 2500);
  assert.equal(t.closedBy.done, 1);
  assert.equal(t.closedBy.error, 0);
  assert.equal(t.unmatchedCount, 0);
  assert.equal(stats.summary.completed, 1);
});

test('computeCoordOpStats: an unmatched start (no closing line) is reported as wedge evidence with age', () => {
  const nowMs = Date.parse('2026-09-22T12:00:00.000Z');
  const startTs = new Date(nowMs - 5 * 60 * 1000).toISOString(); // 5 minutes before the injected now
  const entries = [
    {
      ts: startTs,
      pid: 4242,
      host: 'WORKSTATION-X',
      tool: 'push-rebase',
      token: 'wedged-1',
      phase: 'start',
    },
  ];
  const stats = computeCoordOpStats(entries, { nowMs });
  assert.equal(stats.summary.completed, 0);
  assert.equal(stats.summary.unmatchedCount, 1);
  const u = stats.summary.unmatchedStarts[0];
  assert.equal(u.pid, 4242);
  assert.equal(u.host, 'WORKSTATION-X');
  assert.equal(u.token, 'wedged-1');
  assert.equal(u.ageMs, 5 * 60 * 1000, 'age is exact against the injected clock');
});

test('computeCoordOpStats: start -> release -> start -> done folds as TWO completed windows for one token (mirrors openCoordOps)', () => {
  const entries = [
    {
      ts: '2026-09-22T10:00:00.000Z',
      pid: 1,
      host: 'H',
      tool: 'coordWrite',
      token: 't1',
      phase: 'start',
    },
    {
      ts: '2026-09-22T10:00:01.000Z',
      pid: 1,
      host: 'H',
      tool: 'coordWrite',
      token: 't1',
      phase: 'release',
    },
    {
      ts: '2026-09-22T10:00:03.000Z',
      pid: 1,
      host: 'H',
      tool: 'coordWrite',
      token: 't1',
      phase: 'start',
    },
    {
      ts: '2026-09-22T10:00:04.000Z',
      pid: 1,
      host: 'H',
      tool: 'coordWrite',
      token: 't1',
      phase: 'done',
    },
  ];
  const stats = computeCoordOpStats(entries);
  const t = stats.tools[0];
  assert.equal(t.completed, 2);
  assert.equal(t.closedBy.release, 1);
  assert.equal(t.closedBy.done, 1);
  assert.equal(t.unmatchedCount, 0);
  // durations: 1000ms (release) and 1000ms (done) -> p50/max both 1000ms
  assert.equal(t.p50Ms, 1000);
  assert.equal(t.maxMs, 1000);
});

test('computeCoordOpStats: a rotated-away start does not create a phantom unmatched start (rotation tolerance)', () => {
  // Only a closing line survives rotation; its start was truncated out of the file.
  const entries = [
    {
      ts: '2026-09-22T10:00:05.000Z',
      pid: 9,
      host: 'H',
      tool: 'edit-plan',
      token: 'rotated-away',
      phase: 'done',
    },
  ];
  const stats = computeCoordOpStats(entries);
  assert.equal(stats.summary.completed, 0);
  assert.equal(stats.summary.unmatchedCount, 0);
  assert.equal(stats.tools.length, 0); // the orphaned close never opens a bucket
});

test('computeCoordOpStats: a re-started token before any close overwrites the earlier start (no duration, no unmatched)', () => {
  const entries = [
    {
      ts: '2026-09-22T10:00:00.000Z',
      pid: 1,
      host: 'H',
      tool: 'claim-plan',
      token: 't1',
      phase: 'start',
    },
    {
      ts: '2026-09-22T10:00:05.000Z',
      pid: 1,
      host: 'H',
      tool: 'claim-plan',
      token: 't1',
      phase: 'start',
    },
    {
      ts: '2026-09-22T10:00:06.000Z',
      pid: 1,
      host: 'H',
      tool: 'claim-plan',
      token: 't1',
      phase: 'done',
    },
  ];
  const stats = computeCoordOpStats(entries);
  const t = stats.tools[0];
  assert.equal(t.completed, 1);
  assert.equal(t.p50Ms, 1000); // measured from the SECOND start, the first was overwritten
  assert.equal(t.unmatchedCount, 0);
});

test('computeCoordOpStats: tolerates a token-carrying healed phase as a distinct close reason (forward-compat)', () => {
  const entries = [
    {
      ts: '2026-09-22T10:00:00.000Z',
      pid: 1,
      host: 'H',
      tool: 'heal-main',
      token: 't1',
      phase: 'start',
    },
    {
      ts: '2026-09-22T10:00:01.000Z',
      pid: 1,
      host: 'H',
      tool: 'heal-main',
      token: 't1',
      phase: 'healed',
    },
  ];
  const stats = computeCoordOpStats(entries);
  const t = stats.tools[0];
  assert.equal(t.closedBy.healed, 1);
  assert.equal(t.completed, 1);
});

test('computeCoordOpStats: a REAL tokenless healed line (heal-main.mjs:1476-1480 shape) is counted separately, not as malformed or unmatched', () => {
  const entries = [
    {
      ts: '2026-09-22T10:00:00.000Z',
      pid: 1,
      host: 'H',
      tool: 'heal-main',
      phase: 'healed',
      steps: ['fast-forwarded master to origin (abc123)'],
    },
  ];
  const stats = computeCoordOpStats(entries);
  assert.equal(stats.standaloneHealedCount, 1);
  assert.equal(stats.skippedEntries, 0);
  assert.equal(stats.summary.unmatchedCount, 0);
  assert.equal(stats.tools.length, 0);
});

test('computeCoordOpStats: entries with no token/phase are skipped, not thrown on', () => {
  const entries = [null, {}, { ts: '2026-09-22T10:00:00.000Z', phase: 'start' }, { token: 't1' }];
  const stats = computeCoordOpStats(entries);
  assert.equal(stats.skippedEntries, 4);
  assert.equal(stats.tools.length, 0);
});

test('computeCoordOpStats: p50DoneMs/p95DoneMs/maxDoneMs exclude error/release closes, unlike the plain p50Ms/p95Ms/maxMs (plan 4087 T4 review fix 3qw0gd)', () => {
  const entries = [
    // A `done` close: fast, 100ms.
    { ts: '2026-09-22T10:00:00.000Z', pid: 1, host: 'H', tool: 'x', token: 'd1', phase: 'start' },
    { ts: '2026-09-22T10:00:00.100Z', pid: 1, host: 'H', tool: 'x', token: 'd1', phase: 'done' },
    // An `error` close: much faster (a quick reject) -- must NOT pull the done-only stats down.
    { ts: '2026-09-22T10:00:00.000Z', pid: 1, host: 'H', tool: 'x', token: 'e1', phase: 'start' },
    { ts: '2026-09-22T10:00:00.010Z', pid: 1, host: 'H', tool: 'x', token: 'e1', phase: 'error' },
    // A `release` close: much slower (a mid-op handoff spanning most of a coordWrite) -- must NOT
    // pull the done-only max up.
    { ts: '2026-09-22T10:00:00.000Z', pid: 1, host: 'H', tool: 'x', token: 'r1', phase: 'start' },
    { ts: '2026-09-22T10:00:09.000Z', pid: 1, host: 'H', tool: 'x', token: 'r1', phase: 'release' },
  ];
  const stats = computeCoordOpStats(entries);
  const t = stats.tools[0];
  assert.equal(t.completed, 3, 'all three windows still count toward completed/durationsMs');
  assert.equal(t.maxMs, 9000, 'the plain max is still pulled up by the release window');
  assert.equal(t.p50DoneMs, 100, 'the done-only population has exactly one member: the done close');
  assert.equal(t.maxDoneMs, 100, "the done-only max must not see the release window's 9000ms");
  assert.equal(stats.summary.p50DoneMs, 100);
  assert.equal(stats.summary.maxDoneMs, 100);
});

// plan 4087 round-4 review (keys d54f6a/12e2ce): `doneSampleCount` is the size of the population
// p50DoneMs/p95DoneMs are actually computed over — DISTINCT from closedBy.done, which counts every
// `done`-reason close regardless of whether its duration was usable. coord-git.mjs's
// readCoordOpJournalForStats reads THIS field to decide whether its archive window has enough data
// yet; it used to read closedBy.done, which could declare victory on a window with fewer real
// duration samples than the minimum called for.
test('computeCoordOpStats: doneSampleCount counts only done closes with a USABLE duration, unlike closedBy.done', () => {
  const entries = [
    // A normal done close: enters both closedBy.done and the duration sample.
    { ts: '2026-09-22T10:00:00.000Z', pid: 1, host: 'H', tool: 'x', token: 'd1', phase: 'start' },
    { ts: '2026-09-22T10:00:00.100Z', pid: 1, host: 'H', tool: 'x', token: 'd1', phase: 'done' },
    // A done close whose start ts is unparseable: closedBy.done still increments (the close itself
    // is well-formed), but no duration can be computed, so it must NOT count toward doneSampleCount.
    { ts: 'not-a-date', pid: 1, host: 'H', tool: 'x', token: 'd2', phase: 'start' },
    { ts: '2026-09-22T10:00:01.000Z', pid: 1, host: 'H', tool: 'x', token: 'd2', phase: 'done' },
    // A done close whose close precedes its start (inverted/bad clock): same story.
    { ts: '2026-09-22T10:00:05.000Z', pid: 1, host: 'H', tool: 'x', token: 'd3', phase: 'start' },
    { ts: '2026-09-22T10:00:04.000Z', pid: 1, host: 'H', tool: 'x', token: 'd3', phase: 'done' },
  ];
  const stats = computeCoordOpStats(entries);
  const t = stats.tools[0];
  assert.equal(t.closedBy.done, 3, 'all three are done-reason closes');
  assert.equal(t.doneSampleCount, 1, 'only d1 produced a usable duration');
  assert.equal(stats.summary.closedBy.done, 3);
  assert.equal(stats.summary.doneSampleCount, 1);
});

test('computeCoordOpStats: p95DoneMs is null (not the all-reasons p95Ms) when a tool has zero `done` closes', () => {
  const entries = [
    { ts: '2026-09-22T10:00:00.000Z', pid: 1, host: 'H', tool: 'x', token: 'r1', phase: 'start' },
    { ts: '2026-09-22T10:00:01.000Z', pid: 1, host: 'H', tool: 'x', token: 'r1', phase: 'release' },
  ];
  const stats = computeCoordOpStats(entries);
  const t = stats.tools[0];
  assert.equal(t.p50Ms, 1000, 'the plain population is non-empty');
  assert.equal(
    t.p50DoneMs,
    null,
    'the done-only population is empty for a tool with no done closes',
  );
  assert.equal(t.p95DoneMs, null);
  assert.equal(t.maxDoneMs, null);
});

// ── plan 4136 E2: lock-acquire wait time (start.waitMs) and the ops-level view ────────────────

test('computeCoordOpStats: wait.p50/p95/max are computed from start.waitMs only', () => {
  const entries = [
    {
      ts: '2026-09-22T10:00:00.000Z',
      pid: 1,
      host: 'H',
      tool: 'x',
      token: 'w1',
      phase: 'start',
      waitMs: 10,
    },
    { ts: '2026-09-22T10:00:00.100Z', pid: 1, host: 'H', tool: 'x', token: 'w1', phase: 'done' },
    {
      ts: '2026-09-22T10:00:01.000Z',
      pid: 1,
      host: 'H',
      tool: 'x',
      token: 'w2',
      phase: 'start',
      waitMs: 20,
    },
    { ts: '2026-09-22T10:00:01.100Z', pid: 1, host: 'H', tool: 'x', token: 'w2', phase: 'done' },
    {
      ts: '2026-09-22T10:00:02.000Z',
      pid: 1,
      host: 'H',
      tool: 'x',
      token: 'w3',
      phase: 'start',
      waitMs: 30,
    },
    { ts: '2026-09-22T10:00:02.100Z', pid: 1, host: 'H', tool: 'x', token: 'w3', phase: 'done' },
  ];
  const stats = computeCoordOpStats(entries);
  const t = stats.tools[0];
  assert.equal(t.wait.sampleCount, 3);
  assert.equal(t.wait.maxMs, 30);
  assert.equal(t.wait.p50Ms, 20, 'nearest-rank over [10,20,30] at p50 picks index 1 -> 20');
  assert.equal(stats.summary.wait.sampleCount, 3);
  assert.equal(stats.summary.wait.maxMs, 30);
});

test('computeCoordOpStats: wait stats are a zero-sample/null population when no start line carries waitMs (pre-plan-4136 lines)', () => {
  const entries = [
    {
      ts: '2026-09-22T10:00:00.000Z',
      pid: 1,
      host: 'H',
      tool: 'edit-plan',
      token: 't1',
      phase: 'start',
    },
    {
      ts: '2026-09-22T10:00:00.500Z',
      pid: 1,
      host: 'H',
      tool: 'edit-plan',
      token: 't1',
      phase: 'done',
    },
  ];
  const stats = computeCoordOpStats(entries);
  const t = stats.tools[0];
  assert.equal(
    t.wait.sampleCount,
    0,
    'no waitMs on any start line -- zero samples, never a fake 0ms',
  );
  assert.equal(t.wait.p50Ms, null);
  assert.equal(t.wait.p95Ms, null);
  assert.equal(t.wait.maxMs, null);
});

test('computeCoordOpStats: a mix of legacy (no waitMs) and new start lines counts only the ones carrying it', () => {
  const entries = [
    {
      ts: '2026-09-22T10:00:00.000Z',
      pid: 1,
      host: 'H',
      tool: 'x',
      token: 'legacy',
      phase: 'start',
    },
    {
      ts: '2026-09-22T10:00:00.100Z',
      pid: 1,
      host: 'H',
      tool: 'x',
      token: 'legacy',
      phase: 'done',
    },
    {
      ts: '2026-09-22T10:00:01.000Z',
      pid: 1,
      host: 'H',
      tool: 'x',
      token: 'new',
      phase: 'start',
      waitMs: 40,
    },
    { ts: '2026-09-22T10:00:01.100Z', pid: 1, host: 'H', tool: 'x', token: 'new', phase: 'done' },
  ];
  const stats = computeCoordOpStats(entries);
  const t = stats.tools[0];
  assert.equal(
    t.wait.sampleCount,
    1,
    'the legacy start line without waitMs never enters the sample',
  );
  assert.equal(t.wait.maxMs, 40);
});

test('computeCoordOpStats: ops view -- start,release,done is ONE op with a single start, NOT reacquired', () => {
  const entries = [
    {
      ts: '2026-09-22T10:00:00.000Z',
      pid: 1,
      host: 'H',
      tool: 'coordWrite',
      token: 't1',
      phase: 'start',
    },
    {
      ts: '2026-09-22T10:00:01.000Z',
      pid: 1,
      host: 'H',
      tool: 'coordWrite',
      token: 't1',
      phase: 'release',
    },
    {
      ts: '2026-09-22T10:00:04.000Z',
      pid: 1,
      host: 'H',
      tool: 'coordWrite',
      token: 't1',
      phase: 'done',
    },
  ];
  const stats = computeCoordOpStats(entries);
  const t = stats.tools[0];
  assert.equal(t.ops.count, 1);
  assert.equal(
    t.ops.reacquiredCount,
    0,
    'a single start, even with a mid-op release in between, is not a reacquire',
  );
  assert.equal(t.ops.openCount, 0);
  assert.equal(
    t.ops.wallP50Ms,
    4000,
    'op wall time spans the FIRST start to the terminal close (0 -> 4000ms), not the release-reopened window',
  );
  assert.equal(stats.summary.ops.reacquiredCount, 0);
});

test('computeCoordOpStats: ops view -- start,release,start,release,done counts as reacquired (two start lines)', () => {
  const entries = [
    {
      ts: '2026-09-22T10:00:00.000Z',
      pid: 1,
      host: 'H',
      tool: 'coordWrite',
      token: 't1',
      phase: 'start',
    },
    {
      ts: '2026-09-22T10:00:01.000Z',
      pid: 1,
      host: 'H',
      tool: 'coordWrite',
      token: 't1',
      phase: 'release',
    },
    {
      ts: '2026-09-22T10:00:03.000Z',
      pid: 1,
      host: 'H',
      tool: 'coordWrite',
      token: 't1',
      phase: 'start',
    },
    {
      ts: '2026-09-22T10:00:03.500Z',
      pid: 1,
      host: 'H',
      tool: 'coordWrite',
      token: 't1',
      phase: 'release',
    },
    {
      ts: '2026-09-22T10:00:06.000Z',
      pid: 1,
      host: 'H',
      tool: 'coordWrite',
      token: 't1',
      phase: 'done',
    },
  ];
  const stats = computeCoordOpStats(entries);
  const t = stats.tools[0];
  assert.equal(t.ops.count, 1, 'still ONE logical op -- one token');
  assert.equal(t.ops.reacquiredCount, 1, 'two start lines for the same token IS a reacquire');
  assert.equal(
    t.ops.wallP50Ms,
    6000,
    'wall time is first start (t=0) to the terminal done (t=6000)',
  );
});

test('computeCoordOpStats: ops view -- a token with a start but no terminal close is an OPEN op, excluded from the wall-time sample', () => {
  const entries = [
    {
      ts: '2026-09-22T10:00:00.000Z',
      pid: 1,
      host: 'H',
      tool: 'push-rebase',
      token: 'wedged',
      phase: 'start',
    },
  ];
  const stats = computeCoordOpStats(entries);
  const t = stats.tools[0];
  assert.equal(t.ops.count, 1);
  assert.equal(t.ops.openCount, 1);
  assert.equal(t.ops.wallSampleCount, 0);
  assert.equal(t.ops.wallP50Ms, null);
});

test('computeCoordOpStats: p95 over a larger sample sits above p50 and at/near the max', () => {
  const entries = [];
  // 20 ops of tool 'x': 19 fast (100ms) + 1 slow outlier (10000ms).
  for (let i = 0; i < 19; i++) {
    entries.push({
      ts: '2026-09-22T10:00:00.000Z',
      pid: 1,
      host: 'H',
      tool: 'x',
      token: `f${i}`,
      phase: 'start',
    });
    entries.push({
      ts: '2026-09-22T10:00:00.100Z',
      pid: 1,
      host: 'H',
      tool: 'x',
      token: `f${i}`,
      phase: 'done',
    });
  }
  entries.push({
    ts: '2026-09-22T10:00:00.000Z',
    pid: 1,
    host: 'H',
    tool: 'x',
    token: 'slow',
    phase: 'start',
  });
  entries.push({
    ts: '2026-09-22T10:00:10.000Z',
    pid: 1,
    host: 'H',
    tool: 'x',
    token: 'slow',
    phase: 'done',
  });
  const stats = computeCoordOpStats(entries);
  const t = stats.tools[0];
  assert.equal(t.completed, 20);
  assert.equal(t.p50Ms, 100);
  assert.equal(t.maxMs, 10000);
  assert.ok(t.p95Ms >= t.p50Ms);
});

// ── plan 4087 T4: quantile nearest-rank alignment (review key 328vcu) ────────────────────────
// land-duration-lib.mjs's `percentile()` (nearest-rank: idx = min(n-1, max(0, ceil(p*n)-1))) is
// the repo's other percentile helper; coord-op-stats.mjs's `quantile()` used to use a DIFFERENT
// (floor-based) rank that disagrees with it at exactly this boundary. Pinning this shape as a
// test means a future accidental revert back to floor-based ranking is caught here, not just by
// re-reading the source.
test('computeCoordOpStats: p50 uses nearest-rank (ceil(p*n)-1), matching land-duration-lib.percentile — not the old floor(p*n) rank (plan 4087 T4 review fix 328vcu)', () => {
  const entries = [];
  // 20 completed `done` ops, durations 0..19 (ms) in order -- sorted they are exactly [0..19].
  for (let i = 0; i < 20; i++) {
    entries.push({
      ts: '2026-09-22T10:00:00.000Z',
      pid: 1,
      host: 'H',
      tool: 'x',
      token: `t${i}`,
      phase: 'start',
    });
    entries.push({
      ts: `2026-09-22T10:00:00.${String(i).padStart(3, '0')}Z`,
      pid: 1,
      host: 'H',
      tool: 'x',
      token: `t${i}`,
      phase: 'done',
    });
  }
  const stats = computeCoordOpStats(entries);
  const t = stats.tools[0];
  // n=20, p=0.5: nearest-rank picks index ceil(0.5*20)-1 = 9 -> value 9. The old floor-based rank
  // picked index floor(0.5*20) = 10 -> value 10. This is the exact boundary the two ranks disagree
  // on (coord-op-stats.mjs's own quantile() header comment names it).
  assert.equal(t.p50Ms, 9, 'p50 must use nearest-rank (index 9), not the old floor-based index 10');
});

// ── plan 4087 T4: archive discovery + merge (review key ezbmqk) ───────────────────────────────
// listArchiveJournalPaths / collectJournalEntries are the fix for "the stats reader only ever
// looked at the live journal file, so rotateCoordOpJournal's daily archives were invisible to any
// derived percentile or printed report." Exercised here with injected fs seams — no real journal
// file, no real coordOpJournalPath resolution.

test('listArchiveJournalPaths: matches only same-basename, dated siblings, sorted chronologically, ignores the live file and unrelated names', () => {
  const names = [
    'coord-op-journal-2026-09-20.jsonl',
    'coord-op-journal.jsonl', // the live file itself -- must not be treated as an archive
    'coord-op-journal-2026-09-05.jsonl',
    'coord-op-journal-2026-09-20.jsonl.bak', // wrong extension -- must not match
    'coord-op-journal-not-a-date.jsonl', // malformed date -- must not match
    'other-file.jsonl',
    'coord-op-journal-2026-09-21.jsonl',
  ];
  const paths = listArchiveJournalPaths('C:/repo/.git/coord-op-journal.jsonl', {
    _readdirSync: () => names,
  });
  assert.deepEqual(
    paths.map((p) => p.replaceAll('\\', '/')),
    [
      'C:/repo/.git/coord-op-journal-2026-09-05.jsonl',
      'C:/repo/.git/coord-op-journal-2026-09-20.jsonl',
      'C:/repo/.git/coord-op-journal-2026-09-21.jsonl',
    ],
  );
});

test('listArchiveJournalPaths: an unreadable/missing directory degrades to no archives, never throws', () => {
  const paths = listArchiveJournalPaths('C:/repo/.git/coord-op-journal.jsonl', {
    _readdirSync: () => {
      throw new Error('ENOENT');
    },
  });
  assert.deepEqual(paths, []);
});

test('collectJournalEntries: merges archives OLDEST-FIRST with the live file LAST, so a start/close pair rotation split across the boundary re-pairs correctly', () => {
  // The `start` for token t1 lives in the older archive; its `done` close was appended to the
  // live file after rotation truncated it -- exactly the split rotateCoordOpJournal can produce.
  const files = {
    'C:/repo/.git/coord-op-journal-2026-09-05.jsonl':
      JSON.stringify({
        ts: '2026-09-05T10:00:00.000Z',
        pid: 1,
        host: 'H',
        tool: 'x',
        token: 't1',
        phase: 'start',
      }) + '\n',
    'C:/repo/.git/coord-op-journal-2026-09-20.jsonl':
      JSON.stringify({
        ts: '2026-09-20T10:00:00.000Z',
        pid: 2,
        host: 'H',
        tool: 'y',
        token: 't2',
        phase: 'start',
      }) + '\n',
    'C:/repo/.git/coord-op-journal.jsonl':
      JSON.stringify({
        ts: '2026-09-21T10:00:05.000Z',
        pid: 1,
        host: 'H',
        tool: 'x',
        token: 't1',
        phase: 'done',
      }) + '\n',
  };
  const result = collectJournalEntries('C:/repo/.git/coord-op-journal.jsonl', {
    _readdirSync: () => ['coord-op-journal-2026-09-05.jsonl', 'coord-op-journal-2026-09-20.jsonl'],
    _readFileSync: (p) => {
      const key = p.replaceAll('\\', '/');
      if (!(key in files)) throw new Error(`ENOENT: ${key}`);
      return files[key];
    },
  });
  assert.equal(result.archivePaths.length, 2);
  assert.equal(result.totalEntries, 3);
  assert.equal(result.badLines, 0);
  const stats = computeCoordOpStats(result.entries);
  const t1 = stats.tools.find((t) => t.tool === 'x');
  assert.equal(
    t1.completed,
    1,
    'the start (archived) and its close (live) must re-pair across the archive/live boundary',
  );
  assert.equal(t1.closedBy.done, 1);
  assert.equal(
    stats.tools.find((t) => t.tool === 'y').unmatchedCount,
    1,
    'the still-open t2 start is unmatched',
  );
});

test('collectJournalEntries: a missing/unreadable file (live journal not yet created) degrades to empty text, never throws', () => {
  const result = collectJournalEntries('C:/repo/.git/coord-op-journal.jsonl', {
    _readdirSync: () => [],
    _readFileSync: () => {
      throw new Error('ENOENT');
    },
  });
  assert.deepEqual(result.entries, []);
  assert.equal(result.totalEntries, 0);
  assert.equal(result.archivePaths.length, 0);
});

test('collectJournalEntries: maxArchives bounds the read to the N most-recently-dated archives (plus the live file), dropping older ones', () => {
  const files = {
    'C:/repo/.git/coord-op-journal-2026-09-05.jsonl':
      line({
        ts: '2026-09-05T10:00:00.000Z',
        pid: 1,
        host: 'H',
        tool: 'x',
        token: 'old',
        phase: 'start',
      }) +
      '\n' +
      line({
        ts: '2026-09-05T10:00:01.000Z',
        pid: 1,
        host: 'H',
        tool: 'x',
        token: 'old',
        phase: 'done',
      }) +
      '\n',
    'C:/repo/.git/coord-op-journal-2026-09-20.jsonl':
      line({
        ts: '2026-09-20T10:00:00.000Z',
        pid: 1,
        host: 'H',
        tool: 'x',
        token: 'mid',
        phase: 'start',
      }) +
      '\n' +
      line({
        ts: '2026-09-20T10:00:01.000Z',
        pid: 1,
        host: 'H',
        tool: 'x',
        token: 'mid',
        phase: 'done',
      }) +
      '\n',
    'C:/repo/.git/coord-op-journal-2026-09-21.jsonl':
      line({
        ts: '2026-09-21T10:00:00.000Z',
        pid: 1,
        host: 'H',
        tool: 'x',
        token: 'recent',
        phase: 'start',
      }) +
      '\n' +
      line({
        ts: '2026-09-21T10:00:01.000Z',
        pid: 1,
        host: 'H',
        tool: 'x',
        token: 'recent',
        phase: 'done',
      }) +
      '\n',
    'C:/repo/.git/coord-op-journal.jsonl':
      line({
        ts: '2026-09-22T10:00:00.000Z',
        pid: 1,
        host: 'H',
        tool: 'x',
        token: 'live',
        phase: 'start',
      }) +
      '\n' +
      line({
        ts: '2026-09-22T10:00:01.000Z',
        pid: 1,
        host: 'H',
        tool: 'x',
        token: 'live',
        phase: 'done',
      }) +
      '\n',
  };
  const readdir = () => [
    'coord-op-journal-2026-09-05.jsonl',
    'coord-op-journal-2026-09-20.jsonl',
    'coord-op-journal-2026-09-21.jsonl',
  ];
  const readFile = (p) => {
    const key = p.replaceAll('\\', '/');
    if (!(key in files)) throw new Error(`ENOENT: ${key}`);
    return files[key];
  };

  const unbounded = collectJournalEntries('C:/repo/.git/coord-op-journal.jsonl', {
    _readdirSync: readdir,
    _readFileSync: readFile,
  });
  assert.equal(unbounded.archivePaths.length, 3, 'no maxArchives -- every archive is read');
  assert.equal(unbounded.totalEntries, 8);

  const bounded = collectJournalEntries('C:/repo/.git/coord-op-journal.jsonl', {
    _readdirSync: readdir,
    _readFileSync: readFile,
    maxArchives: 2,
  });
  assert.equal(
    bounded.archivePaths.length,
    2,
    'maxArchives=2 keeps only the 2 most recent archives',
  );
  assert.deepEqual(
    bounded.archivePaths.map((p) => p.replaceAll('\\', '/')),
    [
      'C:/repo/.git/coord-op-journal-2026-09-20.jsonl',
      'C:/repo/.git/coord-op-journal-2026-09-21.jsonl',
    ],
    'the OLDEST archive (09-05) is the one dropped, not the newest',
  );
  assert.equal(bounded.totalEntries, 6, 'old (2 lines) dropped, mid+recent+live (6 lines) kept');
  const boundedStats = computeCoordOpStats(bounded.entries);
  assert.equal(boundedStats.tools.find((t) => t.tool === 'x').unmatchedCount, 0);
  assert.equal(
    boundedStats.summary.completed,
    3,
    'mid, recent, live are all present and complete; old is excluded by the bound',
  );
});
