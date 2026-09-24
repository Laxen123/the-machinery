// scripts/atomic-write.test.mjs — unit tests for the shared fsync+tmp-then-rename
// write behind landing-lock.mjs and test-queue.mjs (plan 1761).
//
// The invariant this file defends (the excl-lock.test.mjs twin): hardening this
// ONE implementation hardens BOTH callers. landing-lock.test.mjs keeps its own
// writeRegistry suite (exercised through acquireAt/releaseAt — the caller-policy
// layer: orphan sweep, release-to-zero, mutex exclusion); THIS file owns the
// primitive's own contract so a future caller can rely on it without re-testing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteJsonSync, atomicWriteTextSync, rmTempPath, TMP_SEP } from './atomic-write.mjs';

const freshDir = () => mkdtempSync(join(tmpdir(), 'atomic-write-'));
const target = (dir) => join(dir, 'target.json');

test('atomicWriteJsonSync: creates the target with exact JSON.stringify bytes', () => {
  const p = target(freshDir());
  atomicWriteJsonSync(p, { v: 2, holders: [{ slug: 'a' }] });
  assert.equal(readFileSync(p, 'utf8'), JSON.stringify({ v: 2, holders: [{ slug: 'a' }] }));
});

test('atomicWriteJsonSync: replaces an existing target (the heartbeat/registry refresh path)', () => {
  const p = target(freshDir());
  atomicWriteJsonSync(p, { beat: 1 });
  atomicWriteJsonSync(p, { beat: 2 });
  assert.equal(readFileSync(p, 'utf8'), JSON.stringify({ beat: 2 }));
});

test('atomicWriteJsonSync: leaves no temp file behind on success', () => {
  const dir = freshDir();
  atomicWriteJsonSync(target(dir), { ok: true });
  assert.deepEqual(readdirSync(dir), ['target.json']);
});

test('atomicWriteJsonSync: tmp naming is `<path>${TMP_SEP}<pid>` — the sweep-scan contract', () => {
  // landing-lock's reapOrphanRegistryTemps scans for `${basename(path)}${TMP_SEP}`;
  // this pins the naming so a rename here can never silently strand its sweep.
  assert.equal(TMP_SEP, '.tmp.');
});

test('atomicWriteJsonSync: a mid-write failure leaves the OLD target fully intact and rethrows', () => {
  const dir = freshDir();
  const p = target(dir);
  atomicWriteJsonSync(p, { old: true });
  // Inject: a squatter DIRECTORY at the temp path that CONTAINS a file. openSync
  // fails (EISDIR/EACCES) before the target is touched. The non-empty squatter
  // also defeats a plain-unlink cleanup, exercising the rmSync (recursive) path.
  const tmpPath = `${p}${TMP_SEP}${process.pid}`;
  mkdirSync(tmpPath);
  writeFileSync(join(tmpPath, 'occupant'), 'x');
  assert.throws(() => atomicWriteJsonSync(p, { new: true }));
  assert.equal(readFileSync(p, 'utf8'), JSON.stringify({ old: true })); // old content untouched
  assert.equal(existsSync(tmpPath), false); // the squatter was reaped by the error-path cleanup
  // And the write succeeds once the obstruction is gone (self-heal on retry).
  atomicWriteJsonSync(p, { new: true });
  assert.equal(readFileSync(p, 'utf8'), JSON.stringify({ new: true }));
});

test('atomicWriteJsonSync: failure on a FIRST write (no prior target) creates nothing', () => {
  const dir = freshDir();
  const p = target(dir);
  const tmpPath = `${p}${TMP_SEP}${process.pid}`;
  mkdirSync(tmpPath); // squatter dir → openSync fails
  assert.throws(() => atomicWriteJsonSync(p, { first: true }));
  assert.equal(existsSync(p), false); // a torn/partial target must never appear
});

test('rmTempPath: removes a plain file, a directory, and tolerates absence (force)', () => {
  const dir = freshDir();
  const f = join(dir, 'file');
  writeFileSync(f, 'x');
  rmTempPath(f);
  assert.equal(existsSync(f), false);
  const d = join(dir, 'squatter');
  mkdirSync(d);
  writeFileSync(join(d, 'occupant'), 'x');
  rmTempPath(d);
  assert.equal(existsSync(d), false);
  rmTempPath(join(dir, 'never-existed')); // force:true — no throw
});

// ── plan 1778: the text-mode core (extracted from git-metadata-heal's plan-1771 mirror) ──

test('atomicWriteTextSync: writes exact text bytes (no JSON quoting)', () => {
  const p = target(freshDir());
  atomicWriteTextSync(p, '[core]\n\tbare = false\n');
  assert.equal(readFileSync(p, 'utf8'), '[core]\n\tbare = false\n');
});

test('atomicWriteTextSync: replaces an existing target (the config-rebuild path)', () => {
  const p = target(freshDir());
  atomicWriteTextSync(p, 'old');
  atomicWriteTextSync(p, 'new content');
  assert.equal(readFileSync(p, 'utf8'), 'new content');
});

test('atomicWriteTextSync: leaves no temp file behind on success', () => {
  const dir = freshDir();
  atomicWriteTextSync(target(dir), 'x');
  assert.deepEqual(readdirSync(dir), ['target.json']);
});

test('atomicWriteJsonSync is a thin wrapper over the text core (same bytes as stringify)', () => {
  const dir = freshDir();
  const viaJson = join(dir, 'a.json');
  const viaText = join(dir, 'b.json');
  atomicWriteJsonSync(viaJson, { v: 1 });
  atomicWriteTextSync(viaText, JSON.stringify({ v: 1 }));
  assert.equal(readFileSync(viaJson, 'utf8'), readFileSync(viaText, 'utf8'));
});
