// scripts/orchestrator-budget.test.mjs — unit tests for the 5-hour-window pacer.
// Pure paceDecision only (no fs/clock): mocked cache objects + a fixed `now`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paceDecision, DEFAULTS } from './orchestrator-budget.mjs';

const NOW = Date.parse('2026-06-21T12:00:00Z');

// A cache fixture in the real .usage_cache.json shape.
function cache({ five = 46, seven = 33, resetsAt = '2026-06-21T14:30:00Z' } = {}) {
  return {
    five_hour: { utilization: five, resets_at: resetsAt },
    seven_day: { utilization: seven, resets_at: '2026-06-23T17:00:00Z' },
  };
}

test('dispatch when five-hour < 75 and seven-day < 90', () => {
  const r = paceDecision(cache({ five: 46 }), { now: NOW });
  assert.equal(r.decision, 'dispatch');
  assert.equal(r.reason, 'within_budget');
  assert.equal(r.utilization, 46);
});

test('hold (reserve) when five-hour in [75, 95)', () => {
  const r = paceDecision(cache({ five: 82 }), { now: NOW });
  assert.equal(r.decision, 'hold');
  assert.equal(r.reason, 'five_hour_reserve');
});

test('stop when five-hour >= 95', () => {
  const r = paceDecision(cache({ five: 96 }), { now: NOW });
  assert.equal(r.decision, 'stop');
  assert.equal(r.reason, 'five_hour_hardstop');
});

test('hold (seven-day soft ceiling) even when five-hour is low', () => {
  const r = paceDecision(cache({ five: 40, seven: 92 }), { now: NOW });
  assert.equal(r.decision, 'hold');
  assert.equal(r.reason, 'seven_day_soft_ceiling');
});

test('boundary: exactly 75 holds, 74.9 dispatches', () => {
  assert.equal(paceDecision(cache({ five: 75 }), { now: NOW }).decision, 'hold');
  assert.equal(paceDecision(cache({ five: 74.9 }), { now: NOW }).decision, 'dispatch');
  // plan 2412 regression guard: the OLD 80 line must no longer dispatch at 79.9.
  assert.equal(paceDecision(cache({ five: 79.9 }), { now: NOW }).decision, 'hold');
});

test('missing / empty meter → fail-safe HOLD', () => {
  assert.equal(paceDecision(null, { now: NOW }).decision, 'hold');
  assert.equal(paceDecision({}, { now: NOW }).reason, 'meter_unavailable');
  assert.equal(paceDecision({ five_hour: {} }, { now: NOW }).decision, 'hold');
});

test('resumeInSec = seconds until resets_at, floored at 0', () => {
  // reset 2.5h after NOW → 9000s
  const r = paceDecision(cache({ five: 96, resetsAt: '2026-06-21T14:30:00Z' }), { now: NOW });
  assert.equal(r.resumeInSec, 9000);
  // a reset already in the past → 0, never negative
  const past = paceDecision(cache({ five: 96, resetsAt: '2026-06-21T11:00:00Z' }), { now: NOW });
  assert.equal(past.resumeInSec, 0);
});

test('resetsAt missing / unparseable → resumeInSec null', () => {
  const r = paceDecision({ five_hour: { utilization: 50 } }, { now: NOW });
  assert.equal(r.resumeInSec, null);
});

test('resumeInSec null when `now` is omitted (defensive guard, not NaN)', () => {
  const r = paceDecision(cache({ five: 96 }), {}); // no `now` in opts
  assert.equal(r.resumeInSec, null);
});

test('custom thresholds via opts', () => {
  const r = paceDecision(cache({ five: 70 }), { now: NOW, dispatchCeiling: 60 });
  assert.equal(r.decision, 'hold'); // 70 >= 60 custom ceiling
});

test('DEFAULTS exported for reuse by the --no-brain fallback', () => {
  assert.equal(DEFAULTS.dispatchCeiling, 75); // plan 2412 (was 80)
  assert.equal(DEFAULTS.hardStop, 95);
  assert.equal(DEFAULTS.sevenDayCeiling, 90);
});
