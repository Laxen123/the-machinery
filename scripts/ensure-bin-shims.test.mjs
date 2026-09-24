// scripts/ensure-bin-shims.test.mjs — unit + scripted-race tests for the plan-1874 reader-side
// .bin preflight. Every fixture is a synthetic temp tree; the install lock is exercised through
// the REAL install-lock primitives against an INSTALL_LOCK_DIR-isolated scratch dir (the
// TEST_QUEUE_DIR pattern) — nothing touches the real node_modules or the shared .git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shimPresent,
  missingShims,
  healLine,
  ensureShims,
  parseBackoffs,
  EXIT_TEAR,
} from './ensure-bin-shims.mjs';

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

function makeRoot({ shims = [], gitDir = true } = {}) {
  const root = tmp('ensure-bin-');
  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  for (const s of shims) writeFileSync(join(bin, s), '#!/bin/sh\n');
  if (gitDir === true) mkdirSync(join(root, '.git'));
  else if (gitDir === 'file') writeFileSync(join(root, '.git'), 'gitdir: ../..');
  return root;
}

// A fake lock world: _resolveLockPath returns a fixed path; the "install" is a JSON entry file
// the test creates/removes. readEntry semantics come from the real install-lock via the entry
// shape ensureShims consumes (undefined = free); we inject _readEntry directly for determinism.
function freshEntry(nowMs) {
  return { token: 't', label: 'install', iso: new Date(nowMs).toISOString(), pid: 1, host: 'h' };
}

test('shimPresent/missingShims: any extension form counts; all-forms-absent is missing', () => {
  const root = makeRoot({ shims: ['prettier.CMD'] });
  assert.equal(shimPresent(root, 'prettier'), true);
  assert.equal(shimPresent(root, 'lint-staged'), false);
  assert.deepEqual(missingShims(root, ['prettier', 'lint-staged']), ['lint-staged']);
  rmSync(root, { recursive: true, force: true });
});

test('healthy fast path: exit 0, lock never consulted', () => {
  const root = makeRoot({ shims: ['lint-staged'] });
  let lockResolved = false;
  const code = ensureShims({
    root,
    names: ['lint-staged'],
    _resolveLockPath: () => {
      lockResolved = true;
      return '/nowhere';
    },
    _sleep: () => {},
  });
  assert.equal(code, 0);
  assert.equal(lockResolved, false);
  rmSync(root, { recursive: true, force: true });
});

test('persistent tear, lock free: exit EXIT_TEAR with the install-main heal line (main checkout)', () => {
  const root = makeRoot({ shims: [] });
  const logs = [];
  const code = ensureShims({
    root,
    names: ['prettier'],
    backoffsMs: [0, 0],
    log: (m) => logs.push(m),
    _resolveLockPath: () => join(root, 'lock.json'),
    _readEntry: () => undefined, // free
    _sleep: () => {},
  });
  assert.equal(code, EXIT_TEAR);
  const heal = logs.join('\n');
  assert.match(heal, /install-main\.mjs/);
  assert.match(heal, /prettier/);
  rmSync(root, { recursive: true, force: true });
});

test('worktree root: heal line says pnpm install, not install-main (canonical discriminator injected)', () => {
  const root = makeRoot({ shims: [], gitDir: 'file' });
  const wk = (r) => healLine(r, ['lint-staged'], () => false); // canonical says: linked worktree
  assert.match(wk(root), /pnpm install/);
  assert.doesNotMatch(wk(root), /install-main\.mjs/);
  rmSync(root, { recursive: true, force: true });
});

test('parseBackoffs: default on unset, parses valid, throws loudly on NaN/negative (never reaches Atomics.wait)', () => {
  assert.deepEqual(parseBackoffs(undefined), [250, 750]);
  assert.deepEqual(parseBackoffs('0 100  250'), [0, 100, 250]);
  assert.throws(() => parseBackoffs('250 75O'), /bad ENSURE_BIN_BACKOFFS_MS/); // typo'd token → NaN
  assert.throws(() => parseBackoffs('-5'), /bad ENSURE_BIN_BACKOFFS_MS/);
  assert.throws(() => parseBackoffs('   '), /bad ENSURE_BIN_BACKOFFS_MS/);
});

test('ensureShims: a non-finite backoff smuggled in programmatically degrades to a 0ms probe, never a hang', () => {
  const root = makeRoot({ shims: [] });
  const slept = [];
  const code = ensureShims({
    root,
    names: ['prettier'],
    backoffsMs: [NaN],
    log: () => {},
    _resolveLockPath: () => join(root, 'lock.json'),
    _readEntry: () => undefined,
    _sleep: (ms) => slept.push(ms),
  });
  assert.equal(code, EXIT_TEAR);
  assert.deepEqual(slept, [0]); // the NaN was clamped before reaching sleepSync/Atomics.wait
  rmSync(root, { recursive: true, force: true });
});

test('scripted race: reader waits out a HELD lock, sees the shim reappear, exits 0', () => {
  const root = makeRoot({ shims: [] });
  const bin = join(root, 'node_modules', '.bin');
  let now = 1_000_000;
  let polls = 0;
  const code = ensureShims({
    root,
    names: ['prettier'],
    waitSec: 900,
    log: () => {},
    _now: () => now,
    _sleep: (ms) => {
      now += ms;
      polls++;
      // The "install" finishes on the 3rd poll: rewrites the shim, releases the lock.
      if (polls === 3) writeFileSync(join(bin, 'prettier'), '#!/bin/sh\n');
    },
    _resolveLockPath: () => join(root, 'lock.json'),
    // Held (fresh entry) until the 3rd poll has fired, then free.
    _readEntry: () => (polls >= 3 ? undefined : freshEntry(now)),
  });
  assert.equal(code, 0);
  assert.ok(polls >= 3);
  rmSync(root, { recursive: true, force: true });
});

test('release micro-race: lock free but shim appears during backoff re-probe — exit 0', () => {
  const root = makeRoot({ shims: [] });
  const bin = join(root, 'node_modules', '.bin');
  let backoffs = 0;
  const code = ensureShims({
    root,
    names: ['prettier'],
    backoffsMs: [0, 0],
    log: () => {},
    _resolveLockPath: () => join(root, 'lock.json'),
    _readEntry: () => undefined,
    _sleep: () => {
      backoffs++;
      if (backoffs === 2) writeFileSync(join(bin, 'prettier'), '#!/bin/sh\n');
    },
  });
  assert.equal(code, 0);
  rmSync(root, { recursive: true, force: true });
});

test('FAIL-OPEN: lock held past the wait ceiling — exit 0 (proceed), never a block', () => {
  const root = makeRoot({ shims: [] });
  let now = 0;
  const logs = [];
  const code = ensureShims({
    root,
    names: ['prettier'],
    waitSec: 10,
    log: (m) => logs.push(m),
    _now: () => now,
    _sleep: (ms) => {
      now += ms;
    },
    _resolveLockPath: () => join(root, 'lock.json'),
    _readEntry: () => freshEntry(now), // held forever (always fresh)
  });
  assert.equal(code, 0);
  assert.match(logs.join('\n'), /fail-open/);
  rmSync(root, { recursive: true, force: true });
});

test('FAIL-OPEN: unresolvable lock path degrades to backoff probes, then the deterministic tear exit', () => {
  const root = makeRoot({ shims: [] });
  const logs = [];
  const code = ensureShims({
    root,
    names: ['prettier'],
    backoffsMs: [0],
    log: (m) => logs.push(m),
    _resolveLockPath: () => {
      throw new Error('no git here');
    },
    _sleep: () => {},
  });
  assert.equal(code, EXIT_TEAR);
  assert.match(logs.join('\n'), /skipping the wait/);
  rmSync(root, { recursive: true, force: true });
});

test('stale lock entry counts as free (a crashed installer never wedges the reader wait)', () => {
  const root = makeRoot({ shims: [] });
  const staleIso = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h old >> 15min ceiling
  const code = ensureShims({
    root,
    names: ['prettier'],
    backoffsMs: [],
    log: () => {},
    _resolveLockPath: () => join(root, 'lock.json'),
    _readEntry: () => ({ token: 't', label: 'install', iso: staleIso, pid: 1, host: 'h' }),
    _sleep: () => {},
  });
  assert.equal(code, EXIT_TEAR); // falls through the (stale ⇒ not held) gate to the tear verdict
  rmSync(root, { recursive: true, force: true });
});
