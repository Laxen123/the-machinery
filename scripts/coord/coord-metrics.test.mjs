// scripts/coord-metrics.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordLandPrepOutcome,
  parseLandPrepMetrics,
  summarizeLandPrepMetrics,
  landPrepMetricsPath,
} from './coord-metrics.mjs';

test('recordLandPrepOutcome appends one JSONL line with the outcome (injected seams)', () => {
  const appended = [];
  const ok = recordLandPrepOutcome(
    '/main',
    { slug: 'p1', fastPath: false, hadMarker: true, fetchedOk: true },
    { _now: () => 'T0', _append: (p, line) => appended.push([p, line]), _mkdir: () => {} },
  );
  assert.equal(ok, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0][0], landPrepMetricsPath('/main'));
  const rec = JSON.parse(appended[0][1]);
  assert.deepEqual(rec, {
    ts: 'T0',
    event: 'head-land',
    slug: 'p1',
    fastPath: false,
    hadMarker: true,
    fetchedOk: true,
  });
});

test('recordLandPrepOutcome NEVER throws — a write failure returns false, does not propagate', () => {
  const ok = recordLandPrepOutcome(
    '/main',
    { slug: 'p', fastPath: true },
    {
      _mkdir: () => {},
      _append: () => {
        throw new Error('disk full');
      },
    },
  );
  assert.equal(ok, false); // swallowed — telemetry must not break a land
});

test('parseLandPrepMetrics tolerates blank and corrupt lines', () => {
  const text =
    '{"event":"head-land","fastPath":true}\n\n{bad json\n{"event":"head-land","fastPath":false}\n';
  const recs = parseLandPrepMetrics(text);
  assert.equal(recs.length, 2);
});

test('summarizeLandPrepMetrics: the plan-1011 prediction shape (markers present, rarely fire)', () => {
  // 10 head lands: 8 had a marker (--prep ran) but only 1 fired (tip moved on the other 7).
  const recs = [
    { event: 'head-land', fastPath: true, hadMarker: true },
    ...Array.from({ length: 7 }, () => ({ event: 'head-land', fastPath: false, hadMarker: true })),
    ...Array.from({ length: 2 }, () => ({ event: 'head-land', fastPath: false, hadMarker: false })),
    { event: 'something-else', fastPath: true }, // ignored — not a head-land
  ];
  const s = summarizeLandPrepMetrics(recs);
  assert.equal(s.total, 10);
  assert.equal(s.fired, 1);
  assert.equal(s.fellBack, 9);
  assert.equal(s.hadMarker, 8);
  assert.equal(s.firedPct, 10);
  assert.equal(s.firedWhenMarkerPresentPct, 13); // 1/8 = 12.5 → 13: keep-hot ran but rarely paid off
});

test('summarizeLandPrepMetrics: empty input yields null rates, never divide-by-zero', () => {
  const s = summarizeLandPrepMetrics([]);
  assert.equal(s.total, 0);
  assert.equal(s.firedPct, null);
  assert.equal(s.firedWhenMarkerPresentPct, null);
});

// --- plan 2473: the FINAL verdict per land ------------------------------------
// A land emits its fast-path verdict twice — once before the enqueue (kept, so an early-seaming
// land is still sampled and the series stays comparable with the pre-2473 baseline) and once at
// head after the plan-2458 re-check, tagged `final`. The pre-enqueue verdict is wrong for exactly
// the two cases that matter, so where both exist the summary must count the final one.

import { foldLandPrepRecords } from './coord-metrics.mjs';

test('plan 2473: a land prepped DURING the wait counts as FIRED, not as a fall-back', () => {
  // The pre-enqueue check ran before this land waited at all, so it saw no marker; keep-hot (or
  // the spine's own dispatch) stamped one during the wait and the at-head re-check granted the
  // fast path. Counting the pre-enqueue verdict would under-report coverage — the exact blindness
  // this plan closes.
  const recs = [
    { event: 'head-land', landId: 'A', fastPath: false, hadMarker: false },
    { event: 'head-land', landId: 'A', final: true, fastPath: true, hadMarker: true },
  ];
  const s = summarizeLandPrepMetrics(recs);
  assert.equal(s.total, 1);
  assert.equal(s.fired, 1);
  assert.equal(s.hadMarker, 1);
  assert.equal(s.finalVerdicts, 1);
});

test('plan 2473: a land whose marker LAPSED counts as a fall-back, not as fired', () => {
  const recs = [
    { event: 'head-land', landId: 'B', fastPath: true, hadMarker: true },
    { event: 'head-land', landId: 'B', final: true, fastPath: false, hadMarker: true },
  ];
  const s = summarizeLandPrepMetrics(recs);
  assert.equal(s.total, 1);
  assert.equal(s.fired, 0);
  assert.equal(s.fellBack, 1);
});

test('plan 2473: a land that SEAMS EARLY still counts, on its pre-enqueue verdict', () => {
  // REVIEW_NEEDED / BUILD_FAILED / MOBILE_FAILED / FINDINGS_OPEN never reach the at-head check.
  // Dropping those records is what made plan 2458 revert its telemetry move.
  const s = summarizeLandPrepMetrics([
    { event: 'head-land', landId: 'C', fastPath: false, hadMarker: false },
  ]);
  assert.equal(s.total, 1);
  assert.equal(s.fellBack, 1);
  assert.equal(s.finalVerdicts, 0);
});

test('plan 2473: pre-2473 records (no landId) are each their own land — baseline preserved', () => {
  const recs = Array.from({ length: 5 }, () => ({ event: 'head-land', fastPath: false }));
  assert.equal(summarizeLandPrepMetrics(recs).total, 5);
});

test('plan 2473: the fold is order-independent and keeps the LAST final record', () => {
  const early = foldLandPrepRecords([
    { event: 'head-land', landId: 'D', final: true, fastPath: true },
    { event: 'head-land', landId: 'D', fastPath: false },
  ]);
  assert.equal(early.length, 1);
  assert.equal(early[0].fastPath, true); // the pre-enqueue record never overwrites a final one
  const dup = foldLandPrepRecords([
    { event: 'head-land', landId: 'E', fastPath: false },
    { event: 'head-land', landId: 'E', final: true, fastPath: true },
    { event: 'head-land', landId: 'E', final: true, fastPath: false },
  ]);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].fastPath, false); // a resumed invocation's later decision wins
});

test('plan 2473: the fold still drops non-head-land events', () => {
  assert.equal(foldLandPrepRecords([{ event: 'something-else', landId: 'F' }]).length, 0);
});

// --- appendJsonl (plan 2198 — the shared journal writer) -----------------------

import { appendJsonl } from './coord-metrics.mjs';
import { mkdtempSync, readFileSync as rfs, writeFileSync as wfs, existsSync as exs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';

test('appendJsonl: stamps ts, creates the parent dir, appends one line, returns true', () => {
  const p = pjoin(mkdtempSync(pjoin(tmpdir(), 'ajl-')), 'nested', 'j.jsonl');
  assert.equal(appendJsonl(p, { a: 1 }, { _now: () => 'T' }), true);
  assert.equal(appendJsonl(p, { a: 2 }, { _now: () => 'T' }), true);
  const lines = rfs(p, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines, [
    { ts: 'T', a: 1 },
    { ts: 'T', a: 2 },
  ]);
});

test('appendJsonl: rotates once to <path>.1 when the file exceeds maxBytes, then keeps appending', () => {
  const dir = mkdtempSync(pjoin(tmpdir(), 'ajl-rot-'));
  const p = pjoin(dir, 'j.jsonl');
  wfs(p, 'x'.repeat(100));
  assert.equal(appendJsonl(p, { a: 1 }, { _now: () => 'T', maxBytes: 50 }), true);
  assert.equal(exs(`${p}.1`), true, 'oversized file rotated aside');
  assert.equal(rfs(`${p}.1`, 'utf8'), 'x'.repeat(100));
  assert.equal(JSON.parse(rfs(p, 'utf8').trim()).a, 1, 'fresh file holds only the new line');
});

test('appendJsonl: NEVER throws — a failing append returns false', () => {
  const ok = appendJsonl(
    'X:\nope\j.jsonl',
    { a: 1 },
    {
      _mkdir: () => {},
      _append: () => {
        throw new Error('EACCES');
      },
    },
  );
  assert.equal(ok, false);
});

// --- plan 2473 review [8]: rotateIfOver, the extracted rotation primitive ------
import { rotateIfOver } from './coord-metrics.mjs';

test('rotateIfOver: rotates once past the ceiling, bounding the file at ~2x on disk', () => {
  const dir = mkdtempSync(pjoin(tmpdir(), 'rot-'));
  const p = pjoin(dir, 'big.log');
  wfs(p, 'x'.repeat(100));
  assert.equal(rotateIfOver(p, 50), true);
  assert.equal(exs(`${p}.1`), true);
  assert.equal(exs(p), false); // the caller re-creates it on append
});

test('rotateIfOver: leaves a file under the ceiling alone', () => {
  const dir = mkdtempSync(pjoin(tmpdir(), 'rot-'));
  const p = pjoin(dir, 'small.log');
  wfs(p, 'x'.repeat(10));
  assert.equal(rotateIfOver(p, 1000), false);
  assert.equal(rfs(p, 'utf8').length, 10);
});

test('rotateIfOver: a missing file (or maxBytes null) is a no-op, never a throw', () => {
  const dir = mkdtempSync(pjoin(tmpdir(), 'rot-'));
  assert.equal(rotateIfOver(pjoin(dir, 'nope.log'), 10), false);
  assert.equal(rotateIfOver(pjoin(dir, 'nope.log'), null), false);
});

test('rotateIfOver: maxBytes 0 means ALWAYS rotate, not never (review 2473-r2 [9])', () => {
  const dir = mkdtempSync(pjoin(tmpdir(), 'rot-'));
  const p = pjoin(dir, 'z.log');
  wfs(p, 'x');
  assert.equal(rotateIfOver(p, 0), true);
  assert.equal(exs(`${p}.1`), true);
});
