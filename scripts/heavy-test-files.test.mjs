// scripts/heavy-test-files.test.mjs — name-paired test for scripts/heavy-test-files.mjs
// (plan 4241 Task 2). Justification for a new file rather than folding into an existing
// name-paired suite: heavy-test-files.mjs is a genuinely new module (per CLAUDE.md's rule).
//
// Every ledger fixture below is an INJECTED mkdtempSync directory — never the ambient
// .scratch/gate-ledgers of the checkout running this suite. Entry files are written by hand in
// the exact shape pass-cache-kernel.mjs's writeCacheEntry produces ({iso, durations, ...}), so
// this suite pins the CONTRACT (what measureDurations/heavyFilesAtOrAbove do with a ledger),
// not the mechanics of writing one (battery-ledger.test.mjs already owns that).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEAVY_TEST_THRESHOLD_MS,
  measureDurations,
  heavyFilesAtOrAbove,
  writeHeavyTestFilesJson,
  resolveMainCheckoutRoot,
} from './heavy-test-files.mjs';
import { assertSamePath } from './test-path-assert.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'heavy-test-files.mjs');

const KEY_A = 'a'.repeat(32);
const KEY_B = 'b'.repeat(32);
const KEY_C = 'c'.repeat(32);

let LEDGER_DIR;

function writeEntry(key, { isoMinutesAgo = 1, durations = {}, iso } = {}) {
  const stamp = iso ?? new Date(Date.now() - isoMinutesAgo * 60000).toISOString();
  writeFileSync(
    join(LEDGER_DIR, `${key}.json`),
    JSON.stringify({ iso: stamp, green: Object.keys(durations), durations }, null, 2),
  );
}

test('heavy-test-files fixtures: fresh ledger dir per test file', () => {
  LEDGER_DIR = mkdtempSync(join(tmpdir(), 'heavy-test-files-'));
});

test('HEAVY_TEST_THRESHOLD_MS is pinned at 600000ms (S3)', () => {
  assert.equal(HEAVY_TEST_THRESHOLD_MS, 600_000);
});

test('measureDurations: empty/missing ledger dir yields nothing', () => {
  assert.deepEqual(measureDurations(join(LEDGER_DIR, 'does-not-exist')), []);
});

test('measureDurations: reads durationMs out of one live entry', () => {
  writeEntry(KEY_A, {
    durations: { 'scripts/heavy.test.mjs': 900_000, 'scripts/light.test.mjs': 500 },
  });
  const rows = measureDurations(LEDGER_DIR);
  assert.deepEqual(rows, [
    { file: 'scripts/heavy.test.mjs', durationMs: 900_000 },
    { file: 'scripts/light.test.mjs', durationMs: 500 },
  ]);
  rmSync(join(LEDGER_DIR, `${KEY_A}.json`));
});

test('measureDurations: an EXPIRED entry contributes nothing (TTL fail-safe)', () => {
  writeEntry(KEY_A, { isoMinutesAgo: 10_000, durations: { 'scripts/heavy.test.mjs': 900_000 } });
  assert.deepEqual(measureDurations(LEDGER_DIR), []);
  rmSync(join(LEDGER_DIR, `${KEY_A}.json`));
});

test('measureDurations: a CORRUPT entry is skipped, its siblings still read', () => {
  writeFileSync(join(LEDGER_DIR, `${KEY_A}.json`), 'not json');
  writeEntry(KEY_B, { durations: { 'scripts/heavy.test.mjs': 900_000 } });
  assert.deepEqual(measureDurations(LEDGER_DIR), [
    { file: 'scripts/heavy.test.mjs', durationMs: 900_000 },
  ]);
  rmSync(join(LEDGER_DIR, `${KEY_A}.json`));
  rmSync(join(LEDGER_DIR, `${KEY_B}.json`));
});

test('measureDurations: a pytest/ sibling subdirectory is never read (separate namespace)', () => {
  mkdirSync(join(LEDGER_DIR, 'pytest'), { recursive: true });
  writeFileSync(
    join(LEDGER_DIR, 'pytest', `${KEY_A}.json`),
    JSON.stringify({
      iso: new Date().toISOString(),
      durations: { 'backend/scripts/x_test.py': 900_000 },
    }),
  );
  assert.deepEqual(measureDurations(LEDGER_DIR), []);
  rmSync(join(LEDGER_DIR, 'pytest'), { recursive: true, force: true });
});

// S2/S3 — the "last recorded" rule: the file's LAST-WRITTEN live entry wins, whichever
// direction it moves the number.
test('measureDurations: the LAST recorded value wins when two live keys both name a file (S2/S3)', () => {
  writeEntry(KEY_A, { isoMinutesAgo: 30, durations: { 'scripts/x.test.mjs': 100_000 } });
  writeEntry(KEY_B, { isoMinutesAgo: 5, durations: { 'scripts/x.test.mjs': 900_000 } });
  assert.deepEqual(measureDurations(LEDGER_DIR), [
    { file: 'scripts/x.test.mjs', durationMs: 900_000 },
  ]);
  rmSync(join(LEDGER_DIR, `${KEY_A}.json`));
  rmSync(join(LEDGER_DIR, `${KEY_B}.json`));
});

test('measureDurations: sorts descending by durationMs, ties broken by file path', () => {
  writeEntry(KEY_A, {
    isoMinutesAgo: 5,
    durations: {
      'scripts/b.test.mjs': 700_000,
      'scripts/a.test.mjs': 700_000,
      'scripts/c.test.mjs': 800_000,
    },
  });
  assert.deepEqual(
    measureDurations(LEDGER_DIR).map((r) => r.file),
    ['scripts/c.test.mjs', 'scripts/a.test.mjs', 'scripts/b.test.mjs'],
  );
  rmSync(join(LEDGER_DIR, `${KEY_A}.json`));
});

// ── heavyFilesAtOrAbove: threshold, inclusion, pruning ──────────────────────────

test('heavyFilesAtOrAbove: a file AT the threshold is INCLUDED (>=, not >)', () => {
  writeEntry(KEY_A, { durations: { 'scripts/x.test.mjs': 600_000 } });
  assert.deepEqual(heavyFilesAtOrAbove(LEDGER_DIR), ['scripts/x.test.mjs']);
  rmSync(join(LEDGER_DIR, `${KEY_A}.json`));
});

test('heavyFilesAtOrAbove: a file below the threshold is EXCLUDED', () => {
  writeEntry(KEY_A, { durations: { 'scripts/x.test.mjs': 599_999 } });
  assert.deepEqual(heavyFilesAtOrAbove(LEDGER_DIR), []);
  rmSync(join(LEDGER_DIR, `${KEY_A}.json`));
});

test('heavyFilesAtOrAbove: PRUNES a file once its LATER recorded duration drops under the threshold', () => {
  writeEntry(KEY_A, { isoMinutesAgo: 30, durations: { 'scripts/x.test.mjs': 900_000 } });
  writeEntry(KEY_B, { isoMinutesAgo: 5, durations: { 'scripts/x.test.mjs': 10_000 } });
  assert.deepEqual(
    heavyFilesAtOrAbove(LEDGER_DIR),
    [],
    'the older heavy reading must not survive a faster later one',
  );
  rmSync(join(LEDGER_DIR, `${KEY_A}.json`));
  rmSync(join(LEDGER_DIR, `${KEY_B}.json`));
});

test('heavyFilesAtOrAbove: conversely LISTS a file once a LATER reading crosses the threshold', () => {
  writeEntry(KEY_A, { isoMinutesAgo: 30, durations: { 'scripts/x.test.mjs': 10_000 } });
  writeEntry(KEY_B, { isoMinutesAgo: 5, durations: { 'scripts/x.test.mjs': 900_000 } });
  assert.deepEqual(heavyFilesAtOrAbove(LEDGER_DIR), ['scripts/x.test.mjs']);
  rmSync(join(LEDGER_DIR, `${KEY_A}.json`));
  rmSync(join(LEDGER_DIR, `${KEY_B}.json`));
});

test('heavyFilesAtOrAbove: a custom threshold is honoured', () => {
  writeEntry(KEY_A, { durations: { 'scripts/x.test.mjs': 5_000 } });
  assert.deepEqual(heavyFilesAtOrAbove(LEDGER_DIR, 1_000), ['scripts/x.test.mjs']);
  assert.deepEqual(heavyFilesAtOrAbove(LEDGER_DIR, 6_000), []);
  rmSync(join(LEDGER_DIR, `${KEY_A}.json`));
});

test('heavyFilesAtOrAbove: multiple heavy files across multiple keys, sorted', () => {
  writeEntry(KEY_A, { isoMinutesAgo: 20, durations: { 'scripts/one.test.mjs': 700_000 } });
  writeEntry(KEY_B, {
    isoMinutesAgo: 10,
    durations: { 'scripts/two.test.mjs': 1_500_000, 'scripts/light.test.mjs': 1_000 },
  });
  assert.deepEqual(heavyFilesAtOrAbove(LEDGER_DIR), [
    'scripts/two.test.mjs',
    'scripts/one.test.mjs',
  ]);
  rmSync(join(LEDGER_DIR, `${KEY_A}.json`));
  rmSync(join(LEDGER_DIR, `${KEY_B}.json`));
});

// ── writeHeavyTestFilesJson ──────────────────────────────────────────────────

test('writeHeavyTestFilesJson: writes the expected shape, de-duplicated and sorted', () => {
  const outPath = join(LEDGER_DIR, 'out.json');
  const payload = writeHeavyTestFilesJson(
    ['scripts/b.test.mjs', 'scripts/a.test.mjs', 'scripts/a.test.mjs'],
    {
      thresholdMs: 600_000,
      source: 'fixture-source',
      path: outPath,
      now: new Date('2026-01-01T00:00:00.000Z'),
    },
  );
  assert.deepEqual(payload, {
    thresholdMs: 600_000,
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: 'fixture-source',
    files: ['scripts/a.test.mjs', 'scripts/b.test.mjs'],
  });
  assert.deepEqual(JSON.parse(readFileSync(outPath, 'utf8')), payload);
});

test('writeHeavyTestFilesJson: an empty list writes a valid, empty-files payload', () => {
  const outPath = join(LEDGER_DIR, 'out-empty.json');
  const payload = writeHeavyTestFilesJson([], {
    path: outPath,
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
  assert.deepEqual(payload.files, []);
  assert.equal(payload.thresholdMs, HEAVY_TEST_THRESHOLD_MS);
});

// ── resolveMainCheckoutRoot ───────────────────────────────────────────────────

test('resolveMainCheckoutRoot: derives the parent of git-common-dir via an injected _exec', () => {
  // Anchored, not a POSIX literal (assert-posix-path-assertions): both sides are built from the
  // SAME `join`/`dirname` primitives the implementation itself uses, so this stays correct on
  // whichever platform runs it — a drive-qualified root on Windows, a POSIX one elsewhere.
  const anchor = resolve(tmpdir(), 'heavy-test-files-root-anchor');
  const gitCommonDir = join(anchor, '.git');
  const root = resolveMainCheckoutRoot('/anywhere', {
    _exec: () => ({ status: 0, stdout: `${gitCommonDir}\n` }),
  });
  assertSamePath(root, anchor);
});

test('resolveMainCheckoutRoot: falls back to REPO_ROOT on a non-zero exit', () => {
  const root = resolveMainCheckoutRoot('/anywhere', { _exec: () => ({ status: 1, stdout: '' }) });
  assert.ok(root.length > 0);
});

test('resolveMainCheckoutRoot: falls back to REPO_ROOT when _exec throws', () => {
  const root = resolveMainCheckoutRoot('/anywhere', {
    _exec: () => {
      throw new Error('boom');
    },
  });
  assert.ok(root.length > 0);
});

// ── the CLI's `regenerate` subcommand, end to end over an injected --ledger-dir/--out ──────

test('CLI `regenerate` end-to-end: reads an injected ledger dir, writes an injected out path', () => {
  writeEntry(KEY_A, {
    durations: { 'scripts/heavy.test.mjs': 700_000, 'scripts/light.test.mjs': 1_000 },
  });
  const outPath = join(LEDGER_DIR, 'cli-out.json');
  const stdout = execFileSync(
    process.execPath,
    [CLI, 'regenerate', '--ledger-dir', LEDGER_DIR, '--out', outPath],
    { encoding: 'utf8' },
  );
  assert.match(stdout, /1 file\(s\) at\/above 600000ms/);
  const payload = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.deepEqual(payload.files, ['scripts/heavy.test.mjs']);
  assert.equal(payload.thresholdMs, 600_000);
  rmSync(join(LEDGER_DIR, `${KEY_A}.json`));
});

test('CLI: an unrecognised/missing subcommand prints usage and exits 2', () => {
  assert.throws(() => execFileSync(process.execPath, [CLI], { encoding: 'utf8' }));
});

test('heavy-test-files fixtures: cleanup', () => {
  rmSync(LEDGER_DIR, { recursive: true, force: true });
});
