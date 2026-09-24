// scripts/push-telemetry-lib.test.mjs (plan 1731)
//
// plan-1731 review finding 1 (CRITICAL): every test in this file passes an EXPLICIT env
// object to markPushTelemetryHit — NEVER the implicit process.env default. This test
// file's own scripts/*.test.mjs battery runs as PART of the real .husky/pre-push node:test
// gate, which by then has exported the REAL, LIVE COORD_PUSH_TELEMETRY_HITS_FILE for the
// push in progress — a test that called markPushTelemetryHit('x') with no second arg would
// inherit that live env var and append a spurious marker into the actual push's own
// telemetry line. (Defense in depth: .husky/pre-push's node:test battery subshell now also
// unsets COORD_PUSH_TELEMETRY_HITS_FILE before running — but this file must not rely on
// that alone.) The process.env-default code path itself is pinned structurally below
// (source-level regex), never via a live call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { markPushTelemetryHit } from './push-telemetry-lib.mjs';

const LIB_PATH = fileURLToPath(new URL('./push-telemetry-lib.mjs', import.meta.url));

test('markPushTelemetryHit: no-op (no file created) when COORD_PUSH_TELEMETRY_HITS_FILE is unset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-telem-'));
  const file = join(dir, 'hits.txt'); // never created by this call
  try {
    markPushTelemetryHit('index', {});
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markPushTelemetryHit: appends one marker line per call to the configured file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-telem-'));
  const file = join(dir, 'hits.txt');
  try {
    markPushTelemetryHit('index', { COORD_PUSH_TELEMETRY_HITS_FILE: file });
    markPushTelemetryHit('board', { COORD_PUSH_TELEMETRY_HITS_FILE: file });
    assert.equal(readFileSync(file, 'utf8'), 'index\nboard\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markPushTelemetryHit: swallows an append failure (unwritable/nonexistent directory) without throwing', () => {
  const unwritable = join(tmpdir(), 'push-telem-definitely-absent-dir-xyz', 'hits.txt');
  assert.doesNotThrow(() => {
    markPushTelemetryHit('index', { COORD_PUSH_TELEMETRY_HITS_FILE: unwritable });
  });
  assert.equal(existsSync(unwritable), false);
});

test('markPushTelemetryHit: swallows a null env without throwing (plan-1731 review finding 4)', () => {
  // `null` (unlike `undefined`) does NOT trigger the `env = process.env` default — it is
  // passed through as-is, so this exercises finding 4's fix (the env read moved inside
  // the try/catch) without ever touching the real ambient process.env. `undefined` is
  // deliberately NOT tested here via a live call — passing it explicitly WOULD trigger
  // the process.env default, i.e. exactly the live-ambient-env call finding 1 forbids in
  // this file; that path is pinned structurally in the next test instead.
  assert.doesNotThrow(() => markPushTelemetryHit('index', null));
});

test('markPushTelemetryHit: signature still defaults env to process.env — checked STRUCTURALLY, never by an actual live call (plan-1731 review finding 1)', () => {
  // A real call with no second arg would read the CALLING process's ambient env — safe
  // here, but this suite's own file runs as part of the real .husky/pre-push node:test
  // battery, which by then has exported the LIVE COORD_PUSH_TELEMETRY_HITS_FILE for the
  // push in progress. A live no-arg call in this test would append a spurious marker
  // into that real push's own telemetry line. So the default is pinned by reading the
  // source instead of ever invoking it ambiently.
  const src = readFileSync(LIB_PATH, 'utf8');
  assert.match(
    src,
    /env\s*=\s*process\.env/,
    'markPushTelemetryHit must keep defaulting env to process.env — the real gates rely on being able to call it with just a marker',
  );
});
