// scripts/pass-cache-kernel.test.mjs — the storage/TTL/telemetry kernel shared by
// battery-pass-cache.mjs (plan 1824) and gate-pass-cache.mjs (plan 2462), extracted by plan 2492
// (xhigh review finding `11yvngr`).
//
// Two things this suite defends, and they are different in kind:
//   1. The KERNEL's own contract — the fail directions both caches inherit (corrupt ⇒ absent,
//      future stamp ⇒ not live, fs trouble ⇒ MISS, telemetry/prune never throw), the atomic
//      entry write (finding `1y80hun`), and the prune throttle (finding `1x7e82r`).
//   2. The EXTRACTION ITSELF — that there is exactly ONE implementation reachable from both
//      siblings (plan 2492 acceptance 2). A re-inlined copy in either module is the whole debt
//      coming back, and only a structural assertion catches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_TTL_MIN,
  EXIT_HIT,
  EXIT_MISS,
  EXIT_UNCACHEABLE,
  PRUNE_MIN_ENTRIES,
  entryPath,
  isLive,
  logTelemetry,
  makeGit,
  parseEntry,
  pruneExpired,
  readCacheEntry,
  removeCacheEntry,
  resolveCacheDir,
  writeCacheEntry,
} from './pass-cache-kernel.mjs';
import { TMP_SEP } from './atomic-write.mjs';
import * as gateCache from './gate-pass-cache.mjs';
import * as batteryCache from './battery-pass-cache.mjs';

const ISO = '2026-07-26T10:00:00.000Z';
const at = (min) => Date.parse(ISO) + min * 60000;
const KEY = 'a'.repeat(32);
const KEY2 = 'b'.repeat(32);
const tmpCacheDir = () => join(mkdtempSync(join(tmpdir(), 'pass-cache-kernel-')), 'cache');

// --- the extraction invariant (plan 2492 acceptance 2) -----------------------

test('plan 2492: ONE kernel implementation is reachable from BOTH cache modules', () => {
  // Identity, not shape: `===` on the function objects proves both siblings resolve to the same
  // module instance, which a re-inlined private copy could never satisfy.
  for (const name of [
    'entryPath',
    'readCacheEntry',
    'writeCacheEntry',
    'removeCacheEntry',
    'pruneExpired',
    'logTelemetry',
    'isLive',
    'parseEntry',
    'makeGit',
  ]) {
    assert.equal(
      gateCache[name],
      batteryCache[name],
      `${name} must be the ONE kernel implementation in both caches, not a re-inlined copy`,
    );
  }
  assert.equal(gateCache.DEFAULT_TTL_MIN, batteryCache.DEFAULT_TTL_MIN);
  assert.equal(gateCache.DEFAULT_TTL_MIN, DEFAULT_TTL_MIN);
});

test('plan 2492: the KEY derivation stays sibling-separate (the extraction boundary)', () => {
  // The constraint plan 2462's module header pins and 2492 must not violate: only the mechanics
  // are shared. Neither key-derivation surface may appear in the kernel…
  const kernelSrc = readFileSync(resolve(import.meta.dirname, 'pass-cache-kernel.mjs'), 'utf8');
  for (const forbidden of ['computeKey', 'computeGateKey', 'selectionCovers', 'GATES']) {
    assert.ok(
      !new RegExp(`(export function|export const) ${forbidden}\\b`).test(kernelSrc),
      `${forbidden} is KEY derivation — it must stay in its own cache module, never in the kernel`,
    );
  }
  // …and each cache still owns its own.
  assert.equal(typeof gateCache.computeGateKey, 'function');
  assert.equal(typeof batteryCache.computeKey, 'function');
  // plan 4071 T4/D5: GATE_NAMES is gone — the registry is caller-injected (built by
  // `gatesFrom(config)`), so the sibling-separateness this case pins is `gatesFrom` itself.
  assert.equal(typeof gateCache.gatesFrom, 'function');
  assert.notEqual(batteryCache.UNIVERSAL_SELECTION, undefined);
});

test('plan 2492: the two caches still rendezvous in SEPARATE dirs', () => {
  // This site deliberately KEEPS a drive-LESS git() output, and is the one place in the corpus
  // plan 2552 did NOT migrate to the anchor idiom. The drive-less string is not incidental
  // fixture shape here — it IS the coverage. `git --git-common-dir` really can return a rooted
  // but drive-less path on Windows, and feeding one through resolveCacheDir is what exercises the
  // drive-PREPENDING branch inside resolveCommonDirPath (`resolve(anchor, common)`). Anchoring
  // the input to a drive-qualified value would make that resolve() a no-op short-circuit and
  // silently delete the only end-to-end test of the exact composition whose breakage caused
  // incidents #1-#3 (plans 2501, 2503, and the 2026-07-27 red).
  //
  // What made the ORIGINAL fixture fragile was never the drive-less input — it was hand-building
  // the EXPECTATION with `join`, a different primitive than the implementation's. The 2026-07-27
  // hotfix corrected exactly that by deriving the expectation through `resolve`, the same
  // primitive resolveCacheDir routes through (plan 2507's resolveCommonDirPath). That is the
  // gate's own prescribed shape-(1) fix ("derive the expectation the same way the actual is
  // derived") and its documented KNOWN BOUND: a resolve()-rooted expectation is not flagged,
  // because flagging it would indict the remedy.
  const git = () => '/repo/.git\n';
  assert.equal(resolveCacheDir(git, 'gate-pass-cache'), resolve('/repo/.git', 'gate-pass-cache'));
  assert.notEqual(gateCache.resolveCacheDir(git), batteryCache.resolveCacheDir(git));
});

// plan 2507: resolveCacheDir used to resolve the common dir via its own UNSCRUBBED `git()`
// rev-parse + `isAbsolute(common) ? common : resolve(...)` ternary instead of the shared
// resolveCommonDirPath (lock-path.mjs, plan 2478/2489) -- a poisoned GIT_DIR (a git hook exports
// it into every child, sometimes pointing at a worktree gitdir mid-operation) could redirect the
// cache dir onto a FOREIGN repo's common dir. This pins the migration with a REAL poisoned
// GIT_DIR (mirrors the coord-git.test.mjs / heal-main.test.mjs 2493 precedent): resolution must
// land in the SAME place with or without the poison, proving resolveCommonDirPath's scrub is
// actually reached rather than a fixture that merely echoes back a fixed string.
test('resolveCacheDir: a poisoned GIT_DIR does not divert resolution away from process.cwd()', () => {
  const git = makeGit();
  const clean = resolveCacheDir(git, 'gate-pass-cache');
  const foreign = mkdtempSync(join(tmpdir(), 'pass-cache-kernel-foreign-'));
  execFileSync('git', ['init', '--quiet'], { cwd: foreign });
  const priorGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = join(foreign, '.git');
  try {
    assert.equal(resolveCacheDir(git, 'gate-pass-cache'), clean);
  } finally {
    if (priorGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = priorGitDir;
    rmSync(foreign, { recursive: true, force: true });
  }
});

// --- the shared fail directions ----------------------------------------------

test('parseEntry: corrupt JSON and shapeless objects read as absent', () => {
  assert.equal(parseEntry('{not json'), null);
  assert.equal(parseEntry('{"no":"iso"}'), null);
  assert.equal(parseEntry('[1,2]'), null);
  assert.deepEqual(parseEntry(`{"iso":"${ISO}"}`), { iso: ISO });
});

test('isLive: fresh yes, expired no, unparseable no, FUTURE no', () => {
  assert.equal(isLive({ iso: ISO }, at(10)), true);
  assert.equal(isLive({ iso: ISO }, at(DEFAULT_TTL_MIN + 1)), false);
  assert.equal(isLive({ iso: 'nonsense' }, at(1)), false);
  assert.equal(isLive({ iso: ISO }, at(-60)), false, 'a future stamp must never read as fresh');
  assert.equal(isLive(null, at(1)), false);
});

test('entryPath rejects a malformed key rather than escaping the cache dir', () => {
  // Drive-QUALIFIED anchor (plan 2552) — see the note on the resolveCacheDir case above: a bare
  // '/c' is rooted but drive-less, so a join-built expectation only matches while entryPath itself
  // joins. Anchoring both sides survives a future migration to resolve().
  const anchor = resolve('/c');
  assert.throws(() => entryPath(anchor, '../../etc/passwd'), /malformed cache key/);
  assert.throws(() => entryPath(anchor, 'A'.repeat(32)), /malformed cache key/);
  assert.equal(entryPath(anchor, KEY), join(anchor, `${KEY}.json`));
});

test('write → read → remove round trip; a corrupt entry reads as absent', () => {
  const dir = tmpCacheDir();
  writeCacheEntry(dir, KEY, { iso: ISO, label: 'x' });
  assert.equal(readCacheEntry(dir, KEY).label, 'x');
  assert.equal(readCacheEntry(dir, KEY2), null, 'an absent entry is a MISS, never a throw');
  writeFileSync(entryPath(dir, KEY2), '{oops');
  assert.equal(readCacheEntry(dir, KEY2), null, 'a corrupt entry is a MISS, never a throw');
  assert.equal(removeCacheEntry(dir, KEY), true);
  assert.equal(removeCacheEntry(dir, KEY), false, 'removing an absent entry is false, not a throw');
  rmSync(dir, { recursive: true, force: true });
});

// --- finding 1y80hun: the entry write is ATOMIC -------------------------------

test('plan 2492 (1y80hun): writeCacheEntry replaces atomically — no truncated target, no temp left', () => {
  const dir = tmpCacheDir();
  writeCacheEntry(dir, KEY, { iso: ISO, label: 'first' });
  writeCacheEntry(dir, KEY, { iso: ISO, label: 'second' });
  assert.equal(readCacheEntry(dir, KEY).label, 'second');
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.includes(TMP_SEP)),
    [],
    'a successful write leaves no staging temp behind',
  );
  // The rename target is the entry path itself — a reader can only ever see one COMPLETE version.
  assert.ok(existsSync(entryPath(dir, KEY)));
  rmSync(dir, { recursive: true, force: true });
});

// --- finding 1x7e82r: the prune sweep is THROTTLED ---------------------------

test('pruneExpired drops expired and corrupt entries, keeps live ones', () => {
  const dir = tmpCacheDir();
  writeCacheEntry(dir, KEY, { iso: ISO, label: 'live' });
  writeCacheEntry(dir, KEY2, { iso: '2026-07-25T00:00:00.000Z' }); // > TTL older than ISO
  writeFileSync(join(dir, `${'c'.repeat(32)}.json`), '{corrupt');
  writeFileSync(join(dir, 'telemetry.log'), 'not an entry\n');
  assert.equal(pruneExpired(dir, at(0)), 2);
  assert.ok(readCacheEntry(dir, KEY), 'the live entry survives');
  assert.ok(existsSync(join(dir, 'telemetry.log')), 'the telemetry log is not an entry');
  rmSync(dir, { recursive: true, force: true });
});

test('plan 2492 (1x7e82r): the sweep is SKIPPED below minEntries — the hot record path stays cheap', () => {
  const dir = tmpCacheDir();
  writeCacheEntry(dir, KEY, { iso: '2026-07-25T00:00:00.000Z' }); // expired
  assert.equal(
    pruneExpired(dir, at(0), DEFAULT_TTL_MIN, { minEntries: PRUNE_MIN_ENTRIES }),
    0,
    'a dir with one entry has nothing worth a parse-every-file sweep',
  );
  assert.ok(
    existsSync(entryPath(dir, KEY)),
    'the expired entry is left in place (inert — isLive gates every read)',
  );
  // …and once the dir has actually accumulated, the sweep fires and reclaims it.
  for (let i = 0; i < PRUNE_MIN_ENTRIES; i += 1)
    writeCacheEntry(dir, `${i}`.padStart(32, 'd'), { iso: '2026-07-25T00:00:00.000Z' });
  assert.ok(
    pruneExpired(dir, at(0), DEFAULT_TTL_MIN, { minEntries: PRUNE_MIN_ENTRIES }) > 0,
    'crossing the threshold sweeps',
  );
  assert.equal(readCacheEntry(dir, KEY), null);
  rmSync(dir, { recursive: true, force: true });
});

test('plan 2492: prune reaps an ORPHANED atomic-write temp, but never a fresh one', () => {
  // atomicWriteTextSync cleans up its own temp on failure — but a killed process (the hook wraps
  // every cache call in `timeout --kill-after`) can leave one, and nothing else looks at that name.
  const dir = tmpCacheDir();
  writeCacheEntry(dir, KEY, { iso: ISO, label: 'live' });
  const orphan = join(dir, `${KEY2}.json${TMP_SEP}9999`);
  writeFileSync(orphan, '{"iso":"whatever"');
  assert.equal(
    pruneExpired(dir, at(1)),
    0,
    'a temp younger than the TTL may be a CONCURRENT writer mid-flight — never reap it',
  );
  assert.ok(existsSync(orphan));
  // Far enough forward that the temp is past the TTL (the live entry ages out here too — this
  // asserts the TEMP arm, so count both).
  assert.equal(pruneExpired(dir, Date.now() + (DEFAULT_TTL_MIN + 1) * 60000), 2);
  assert.ok(!existsSync(orphan), 'an aged-out temp is reclaimed');
  rmSync(dir, { recursive: true, force: true });
});

test('pruneExpired on a missing dir is 0, never a throw (hygiene is never load-bearing)', () => {
  assert.equal(pruneExpired(join(tmpdir(), 'pass-cache-kernel-no-such-dir'), at(0)), 0);
});

// --- telemetry ---------------------------------------------------------------

test('logTelemetry appends one timestamped line and never throws', () => {
  const dir = tmpCacheDir();
  logTelemetry(dir, 'HIT gate=x');
  logTelemetry(dir, 'MISS gate=y');
  const lines = readFileSync(join(dir, 'telemetry.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z HIT gate=x$/);
  // An unwritable target must be swallowed — telemetry can never fail or delay a push.
  assert.doesNotThrow(() => logTelemetry(join(dir, 'telemetry.log', 'nested'), 'x'));
  rmSync(dir, { recursive: true, force: true });
});

// --- the git seam ------------------------------------------------------------

test('makeGit scrubs inherited GIT_* env, pins GIT_OPTIONAL_LOCKS=0, and forwards stdin', () => {
  const calls = [];
  const git = makeGit({
    _exec: (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return 'out\n';
    },
    cwd: '/wt',
  });
  process.env.GIT_DIR = '/somewhere/.git';
  process.env.GIT_INDEX_FILE = '/somewhere/index';
  try {
    assert.equal(git(['version']), 'out\n');
    git(['cat-file', '--batch-check'], 'HEAD:backend\n');
  } finally {
    delete process.env.GIT_DIR;
    delete process.env.GIT_INDEX_FILE;
  }
  assert.equal(calls[0].opts.env.GIT_DIR, undefined, 'an inherited GIT_DIR would hijack the repo');
  assert.equal(calls[0].opts.env.GIT_INDEX_FILE, undefined);
  assert.equal(calls[0].opts.env.GIT_OPTIONAL_LOCKS, '0', 'a probe must never take index.lock');
  assert.equal(calls[0].opts.cwd, '/wt');
  assert.equal(calls[0].opts.input, undefined, 'no stdin unless the caller passes one');
  assert.equal(calls[1].opts.input, 'HEAD:backend\n');
});

test('the exit-code contract is the one both CLIs branch on', () => {
  assert.deepEqual([EXIT_HIT, EXIT_MISS, EXIT_UNCACHEABLE], [0, 2, 3]);
  assert.equal(gateCache.EXIT_MISS, batteryCache.EXIT_MISS);
});
