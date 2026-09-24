// scripts/coord/smoke.test.mjs — name-pair of smoke.mjs (plan 3958).
//
// Unit-tests the PURE step runner (`runSteps`) with fake step functions — no git, no npm, no
// subprocess — for the three run-shape assertions the build brief calls for: stop-at-first-
// missing-command (exit 3), stop-at-first-failure (exit 1), and all-pass (exit 0). A fourth test
// spawns the REAL CLI once, against a tiny fake kit (a stub coord-init.mjs that writes nothing),
// to prove the end-to-end wiring — argument parsing, scratch-dir setup, the mint step's
// "not shipped" detection, --json output shape — without needing any OTHER command shipped.
//
// Deliberately does NOT drive the real seven-step sequence against a real kit here — that is
// exactly what running `node scripts/coord/smoke.mjs` itself is for; a test suite re-doing that
// (network-free but still git/npm-heavy, and slow) would just be a slower, harder-to-debug copy
// of the tool it's testing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync as fsMkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedMkdtempSync } from '../test-helpers/tracked-tmpdir.mjs';
import { runSteps } from './smoke.mjs';

const mkdtempSync = trackedMkdtempSync({ _mkdtempSync: fsMkdtempSync });

const SMOKE_MJS = fileURLToPath(new URL('./smoke.mjs', import.meta.url));

// A fake step whose `run` is a plain fixed-result function, for building a canned sequence
// without any of the real mint/claim/cut/... logic.
function fakeStep(name, result) {
  return { name, run: () => result };
}

test('runSteps: stops at the first command not shipped, records BLOCKED, exit 3', async () => {
  const steps = [
    fakeStep('mint', {
      ok: false,
      exitCode: null,
      blocked: true,
      note: 'command not shipped: next-plan-id',
    }),
    fakeStep('claim', { ok: true, exitCode: 0, note: 'never reached' }),
  ];
  const { records, exitCode } = await runSteps(steps, {});
  assert.equal(exitCode, 3);
  assert.deepEqual(records, [
    { step: 'mint', ok: false, exitCode: null, note: 'command not shipped: next-plan-id' },
  ]);
});

test('runSteps: a shipped step that fails stops the run, exit 1, later steps not run', async () => {
  const steps = [
    fakeStep('mint', { ok: true, exitCode: 0, note: 'minted 1' }),
    fakeStep('claim', { ok: false, exitCode: 1, note: 'claim did not win' }),
    fakeStep('cut', { ok: true, exitCode: 0, note: 'never reached' }),
  ];
  const { records, exitCode } = await runSteps(steps, {});
  assert.equal(exitCode, 1);
  assert.deepEqual(records, [
    { step: 'mint', ok: true, exitCode: 0, note: 'minted 1' },
    { step: 'claim', ok: false, exitCode: 1, note: 'claim did not win' },
  ]);
});

test('runSteps: all seven pass -> exit 0, seven records', async () => {
  const names = ['mint', 'claim', 'cut', 'commit', 'review', 'land', 'assert'];
  const steps = names.map((name) => fakeStep(name, { ok: true, exitCode: 0, note: `${name} ok` }));
  const { records, exitCode } = await runSteps(steps, {});
  assert.equal(exitCode, 0);
  assert.equal(records.length, 7);
  assert.deepEqual(
    records.map((r) => r.step),
    names,
  );
  assert.ok(records.every((r) => r.ok === true));
});

test('runSteps: ctx is shared and mutable across steps (later steps see earlier writes)', async () => {
  const steps = [
    fakeStep('mint', {}), // placeholder result object below overridden by run()
    fakeStep('claim', { ok: true, exitCode: 0, note: 'ok' }),
  ];
  // Re-wire step 1's run to actually mutate ctx and return ok, proving runSteps passes the SAME
  // ctx object through in order rather than a fresh one per step.
  steps[0].run = (ctx) => {
    ctx.planId = '9001';
    return { ok: true, exitCode: 0, note: 'minted 9001' };
  };
  steps[1].run = (ctx) => ({
    ok: ctx.planId === '9001',
    exitCode: 0,
    note: `saw planId=${ctx.planId}`,
  });
  const ctx = {};
  const { records, exitCode } = await runSteps(steps, ctx);
  assert.equal(exitCode, 0);
  assert.equal(records[1].note, 'saw planId=9001');
});

// ── CLI end-to-end (real subprocess), against a fake kit with only a coord-init STUB ───────────

function writeCoordInitStub(kitDir) {
  const initPath = join(kitDir, 'scripts', 'coord', 'coord-init.mjs');
  mkdirSync(join(kitDir, 'scripts', 'coord'), { recursive: true });
  // Writes nothing into the target, just exits 0 — the smoke CLI must still produce a valid
  // scratch demo repo (it writes its own marker file so the initial commit is never empty) and
  // correctly report the FIRST real command (next-plan-id, never copied by this stub) as not
  // shipped.
  writeFileSync(
    initPath,
    [
      '#!/usr/bin/env node',
      '// stub coord-init for smoke.test.mjs — writes nothing, exits 0.',
      '',
    ].join('\n'),
  );
  return initPath;
}

test('CLI: --kit <fake> --no-install --json against a stub coord-init -> BLOCKED at mint, exit 3', () => {
  const kitDir = mkdtempSync(join(tmpdir(), 'coord-kit-smoke-fixture-'));
  writeCoordInitStub(kitDir);

  const res = spawnSync(process.execPath, [SMOKE_MJS, '--kit', kitDir, '--no-install', '--json'], {
    encoding: 'utf8',
    timeout: 120_000,
  });

  assert.equal(res.status, 3, res.stderr);
  const out = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(out.kit, kitDir);
  assert.ok(typeof out.demo === 'string' && out.demo.length > 0);
  assert.equal(out.exitCode, 3);
  assert.deepEqual(out.records, [
    { step: 'mint', ok: false, exitCode: null, note: 'command not shipped: next-plan-id' },
  ]);
});
