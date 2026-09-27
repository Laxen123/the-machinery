// scripts/orchestrator-journal.test.mjs — unit tests for the orchestrator run
// journal. Pure state functions only (no fs): emptyState / recordOutcome /
// parkQuestion / recordPendingDeploy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState,
  recordOutcome,
  parkQuestion,
  recordPendingDeploy,
  summarize,
} from './orchestrator-journal.mjs';

const BUCKETS = [
  'plans_completed',
  'plans_quarantined',
  'plans_blocked',
  'plans_skipped',
  'plans_landed',
  'lands_parked',
  'parked_questions',
  'carry_forwards',
  'carry_forwards_filed',
  'pending_deploy',
  'in_flight',
  'window_snapshots',
];

test('emptyState has every bucket empty + iterations 0', () => {
  const s = emptyState();
  for (const k of BUCKETS) assert.deepEqual(s[k], [], `${k} should start empty`);
  assert.equal(s.iterations, 0);
});

test('recordOutcome routes each kind to its bucket and strips kind', () => {
  let s = emptyState();
  s = recordOutcome(s, { kind: 'completed', slug: 'a' });
  s = recordOutcome(s, { kind: 'quarantined', slug: 'b', reason: 'gate' });
  s = recordOutcome(s, { kind: 'landed', slug: 'c', mergeSha: 'deadbeef' });
  assert.deepEqual(s.plans_completed, [{ slug: 'a' }]);
  assert.deepEqual(s.plans_quarantined, [{ slug: 'b', reason: 'gate' }]);
  assert.deepEqual(s.plans_landed, [{ slug: 'c', mergeSha: 'deadbeef' }]);
});

test('recordOutcome is immutable — input state untouched', () => {
  const s0 = emptyState();
  const s1 = recordOutcome(s0, { kind: 'completed', slug: 'a' });
  assert.equal(s0.plans_completed.length, 0);
  assert.equal(s1.plans_completed.length, 1);
  assert.notEqual(s0, s1);
});

test('recordOutcome throws on an unknown kind', () => {
  assert.throws(
    () => recordOutcome(emptyState(), { kind: 'bogus', slug: 'x' }),
    /unknown outcome kind "bogus"/,
  );
});

test('every documented kind fills exactly one bucket', () => {
  const outcomeBuckets = [
    'plans_completed',
    'plans_quarantined',
    'plans_blocked',
    'plans_skipped',
    'plans_landed',
    'lands_parked',
  ];
  for (const kind of ['completed', 'quarantined', 'blocked', 'skipped', 'landed', 'land_parked']) {
    const s = recordOutcome(emptyState(), { kind, slug: 'x' });
    const total = outcomeBuckets.reduce((n, b) => n + s[b].length, 0);
    assert.equal(total, 1, `kind ${kind} should fill exactly one bucket`);
  }
});

test('parkQuestion appends to parked_questions', () => {
  const s = parkQuestion(emptyState(), { slug: 'a', question: 'which lane?' });
  assert.deepEqual(s.parked_questions, [{ slug: 'a', question: 'which lane?' }]);
});

test('recordPendingDeploy appends staged-not-live lands', () => {
  const s = recordPendingDeploy(emptyState(), { slug: 'a', mergeSha: 'abc123' });
  assert.deepEqual(s.pending_deploy, [{ slug: 'a', mergeSha: 'abc123' }]);
});

test('summarize renders a parked question with real plan id + ask text, no "undefined"', () => {
  const s = parkQuestion(emptyState(), {
    plan: '2208',
    ask: 'Create a Companies House developer account and mint COMPANIES_HOUSE_API_KEY.',
  });
  const out = summarize(s);
  assert.match(out, /\[2208\] Create a Companies House developer account/);
  assert.doesNotMatch(out, /undefined/);
});

test('summarize falls back to the legacy { slug, question } shape without printing "undefined"', () => {
  const s = parkQuestion(emptyState(), { slug: 'legacy-plan', question: 'which lane?' });
  const out = summarize(s);
  assert.match(out, /\[legacy-plan\] which lane\?/);
  assert.doesNotMatch(out, /undefined/);
});
