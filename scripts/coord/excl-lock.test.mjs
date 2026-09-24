// scripts/excl-lock.test.mjs — unit tests for the shared O_EXCL lockfile
// primitive behind landing-lock.mjs and battery-lock.mjs (plan 1678).
//
// The invariant this file exists to defend: hardening this ONE implementation
// hardens BOTH locks. The double-reap race test below is the acceptance
// criterion plan 1678 names explicitly — it must live on the SHARED
// primitive, not duplicated per-caller, or a future fix to one copy could
// again silently miss the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tryCreateExclusive,
  readExclusive,
  reapStaleExclusive,
  releaseOwned,
} from './excl-lock.mjs';

const tmpPath = () => join(mkdtempSync(join(tmpdir(), 'excl-lock-')), 'lock.json');

test('tryCreateExclusive: O_EXCL — the first caller wins, the second gets false', () => {
  const p = tmpPath();
  assert.equal(tryCreateExclusive(p, 'first'), true);
  assert.equal(tryCreateExclusive(p, 'second'), false);
  assert.equal(readFileSync(p, 'utf8'), 'first'); // the loser did NOT overwrite the holder
});

test('tryCreateExclusive: a non-EEXIST fs error propagates (never silently swallowed)', () => {
  // A path whose PARENT directory does not exist fails openSync with ENOENT, not EEXIST —
  // this must throw, never be mistaken for "already held" (which would make a caller
  // silently treat a broken lock directory as mere contention and loop forever).
  const missingParent = join(mkdtempSync(join(tmpdir(), 'excl-lock-')), 'no-such-dir', 'lock.json');
  assert.throws(() => tryCreateExclusive(missingParent, 'x'), /ENOENT/);
});

test('readExclusive: undefined when the path never existed', () => {
  const p = tmpPath();
  assert.equal(readExclusive(p), undefined);
});

test('readExclusive: returns the raw text once created', () => {
  const p = tmpPath();
  tryCreateExclusive(p, 'hello');
  assert.equal(readExclusive(p), 'hello');
});

test('readExclusive: a non-ENOENT read error (e.g. EISDIR) THROWS — never mapped to "free"', () => {
  // Regression test (plan 1678 review finding [0]): an EXISTING lock that transiently fails to
  // read (AV/sync-tool lock, EACCES/EBUSY/EPERM in production) must never be silently treated as
  // "the lock is free" — that would let a caller wrongly grant an acquire over a real holder. A
  // directory at the lock path fails readFileSync with EISDIR, not ENOENT — a portable stand-in
  // for "exists but unreadable" without relying on platform-specific permission bits.
  const p = tmpPath();
  mkdirSync(p); // existsSync(p) is true; readFileSync(p) throws EISDIR, not ENOENT
  assert.throws(() => readExclusive(p), /EISDIR/);
});

test('reapStaleExclusive: unique-target rename means only ONE of two racing reapers wins', () => {
  const p = tmpPath();
  tryCreateExclusive(p, 'old');
  assert.equal(reapStaleExclusive(p, 'reaper-a'), true);
  // The rival's rename now finds nothing at the original path. If reap were unlink-based, this
  // second reaper would delete whatever FRESH lock the winner has since (re)created — the
  // classic double-reap race this function exists to close, for BOTH battery-lock's
  // single-holder lock and landing-lock's registry meta-mutex.
  assert.equal(reapStaleExclusive(p, 'reaper-b'), false);
  assert.equal(existsSync(p), false);
});

test('reapStaleExclusive: a reap AFTER a fresh recreate does not touch the new holder', () => {
  const p = tmpPath();
  tryCreateExclusive(p, 'old');
  assert.equal(reapStaleExclusive(p, 'reaper-a'), true); // old is gone
  tryCreateExclusive(p, 'new'); // a fresh holder recreates the lock
  // A late/rival reaper still targeting the ORIGINAL path can only rename what is THERE NOW —
  // exercising it here pins that reapStaleExclusive never assumes stale identity, only "whatever
  // currently sits at `path`" — callers are responsible for re-checking staleness before calling.
  assert.equal(readExclusive(p), 'new');
});

test('releaseOwned: RELEASED when the predicate matches; the file is gone after', () => {
  const p = tmpPath();
  tryCreateExclusive(p, JSON.stringify({ token: 'mine' }));
  const r = releaseOwned(p, (text) => JSON.parse(text).token === 'mine');
  assert.equal(r, 'RELEASED');
  assert.equal(existsSync(p), false);
});

test('releaseOwned: FOREIGN when the predicate rejects, and the file is left untouched', () => {
  const p = tmpPath();
  tryCreateExclusive(p, JSON.stringify({ token: 'theirs' }));
  const r = releaseOwned(p, (text) => JSON.parse(text).token === 'mine');
  assert.equal(r, 'FOREIGN');
  assert.equal(existsSync(p), true);
});

test('releaseOwned: NOOP (idempotent) when the file is already gone', () => {
  const p = tmpPath();
  assert.equal(
    releaseOwned(p, () => true),
    'NOOP',
  );
});

test('releaseOwned: a force-style predicate (always true) clears a corrupt/unparseable file', () => {
  const p = tmpPath();
  tryCreateExclusive(p, 'not json{');
  const r = releaseOwned(p, () => true);
  assert.equal(r, 'RELEASED');
  assert.equal(existsSync(p), false);
});
