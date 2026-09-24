// scripts/coord/install-lock.test.mjs — unit + integration tests for the machine-wide `pnpm install`
// mutex (plan 1869). Pure key-hashing/staleness/parse logic, fs acquire/release against an
// injectable temp path, and an in-process concurrency test via INSTALL_LOCK_DIR isolation (never
// the real shared `.git` common dir, and never a real `pnpm install`).
//
// The invariant every case defends: FAIL-OPEN, NEVER WEDGE. A queue-wait expiry must exit/return
// with the distinct EXIT_TIMEOUT so the caller (install-main.mjs) proceeds unserialized rather than
// blocking an install forever. Ownership is by TOKEN (a timed-out waiter holds none, so it cannot
// release the install that is actually running); staleness is by AGE, not pid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  INSTALL_ARG_SPEC,
  parseLockArgs,
  numericFlag,
  assertFlagValue,
  ageMinutes,
  parseEntry,
  isStale,
  describeEntry,
  normalizeInstallRoot,
  hashInstallRoot,
  assertRootExists,
  requireRootIfNeeded,
  readEntry,
  tryCreate,
  reapStale,
  acquireOnce,
  releaseAt,
  resolveLockPath,
  safeCwd,
  runAcquireLoop,
  DEFAULT_STALE_MIN,
  DEFAULT_TIMEOUT_SEC,
  EXIT_TIMEOUT,
  EXIT_ERROR,
} from './install-lock.mjs';
import { withEnvVar } from '../test-helpers/with-env-var.mjs';
import { trackedMkdtempSync } from '../test-helpers/tracked-tmpdir.mjs';

const CLI = resolve(import.meta.dirname, 'install-lock.mjs');
const ISO = '2026-07-10T10:00:00.000Z';
const at = (min) => Date.parse(ISO) + min * 60000;

// Plan 2365 T4: this file has ~15 direct `mkdtempSync(join(tmpdir(), 'install-lock-*'))` call
// sites (not one shared helper) and NOTHING ever removed the dirs they created — confirmed via
// the operator's real TEMP: 3772 leaked `install-lock-*` dirs, some still holding a stray
// `install-lock.json`. Rather than touch every call site (risking a test-logic change), the name
// `mkdtempSync` is SHADOWED by the tracking wrapper and dropped from the `node:fs` import above, so
// every EXISTING call — including `tmpLock()`'s `join(mkdtempSync(...), 'install-lock.json')`, whose
// tracked path is the DIRECTORY mkdtempSync returned, not the joined file path — is captured with no
// opt-in, and a future call site cannot escape tracking because the raw symbol is no longer in
// scope. Review finding [5]: the wrapper itself now lives in ONE place (see the helper's header for
// why a per-file copy was the wrong shape) rather than being near-duplicated in
// install-main.test.mjs.
const mkdtempSync = trackedMkdtempSync();

const tmpLock = () => join(mkdtempSync(join(tmpdir(), 'install-lock-')), 'install-lock.json');

// --- the shared tracked-tmpdir helper itself (plan 2365 T4 / review finding [5]) ---------------

// Tested here rather than in a fourth file: this suite is where the leak was first measured, and the
// helper's injectable seams mean these cases create no real directories and register no real hook.
test('trackedMkdtempSync: every call is tracked and swept, whether or not the caller opts in', () => {
  const made = [];
  const removed = [];
  let hook = null;
  const tracked = trackedMkdtempSync({
    _mkdtempSync: (p) => {
      const d = `${p}XXXX${made.length}`;
      made.push(d);
      return d;
    },
    _rmSync: (d) => removed.push(d),
    _after: (fn) => (hook = fn),
  });

  assert.equal(tracked('/tmp/a-'), '/tmp/a-XXXX0');
  assert.equal(tracked('/tmp/b-'), '/tmp/b-XXXX1');
  assert.deepEqual(tracked.created, made);

  assert.equal(typeof hook, 'function'); // the sweep is registered, not left to the caller
  hook();
  assert.deepEqual(removed.sort(), made.slice().sort()); // BOTH dirs swept, none skipped
  assert.deepEqual(tracked.created, []); // and the ledger is drained, so a second sweep is a no-op
});

test('trackedMkdtempSync: a removal that throws (locked dir on Windows) never fails the suite, and the rest are still swept', () => {
  const removed = [];
  let hook = null;
  const tracked = trackedMkdtempSync({
    _mkdtempSync: (p) => p,
    _rmSync: (d) => {
      if (d === '/tmp/locked-') throw new Error('EBUSY');
      removed.push(d);
    },
    _after: (fn) => (hook = fn),
  });
  tracked('/tmp/first-');
  tracked('/tmp/locked-');
  tracked('/tmp/last-');
  assert.doesNotThrow(() => hook());
  assert.deepEqual(removed.sort(), ['/tmp/first-', '/tmp/last-']);
});

// Review finding [3] (round 3): pins the guard in scripts/test-helpers/with-env-var.mjs (plan 2309
// moved withEnvVar there) — an async (thenable-returning) callback must throw LOUDLY, and the env
// must still be correctly restored despite the throw (the `finally` runs regardless of which branch
// threw).
test('withEnvVar: an async (thenable-returning) callback throws loudly, never silently mishandled', () => {
  const before = process.env.INSTALL_LOCK_DIR;
  assert.throws(
    () => withEnvVar({ INSTALL_LOCK_DIR: '/tmp/whatever' }, () => Promise.resolve('ignored')),
    /withEnvVar is sync-only/,
  );
  assert.equal(process.env.INSTALL_LOCK_DIR, before); // still restored, despite the throw
});

test('withEnvVar: a genuinely synchronous callback still restores env and returns its value, unaffected', () => {
  const before = process.env.INSTALL_LOCK_DIR;
  const result = withEnvVar({ INSTALL_LOCK_DIR: '/tmp/whatever' }, () => {
    assert.equal(process.env.INSTALL_LOCK_DIR, '/tmp/whatever');
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(process.env.INSTALL_LOCK_DIR, before);
});

// CLI runs always go through INSTALL_LOCK_DIR — a fresh temp dir per test — never the real shared
// `.git` common dir, and never a real `pnpm install` (this file only ever spawns install-lock.mjs
// itself, never install-main.mjs).
function newLockDirEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'install-lock-dir-'));
  return { dir, env: { ...process.env, INSTALL_LOCK_DIR: dir } };
}
const runCli = (env, args) =>
  spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });

// --- arg parsing -------------------------------------------------------------

test('parseLockArgs: install-lock spec accepts --root, refuses a landing/battery-only flag', () => {
  const a = parseLockArgs(['acquire', '--root', 'C:/repo', '--stale-min', '5'], INSTALL_ARG_SPEC);
  assert.equal(a.cmd, 'acquire');
  assert.deepEqual(a.flags, { root: 'C:/repo', 'stale-min': '5' });
  assert.throws(
    () => parseLockArgs(['acquire', '--scope', '{"global":true}'], INSTALL_ARG_SPEC),
    /install-lock: unknown flag --scope/,
  );
});

test('numericFlag: falls back when absent, coerces a number, THROWS on NaN/negative', () => {
  assert.equal(numericFlag(undefined, 900, 'timeout-sec'), 900);
  assert.equal(numericFlag('60', 900, 'timeout-sec'), 60);
  assert.throws(() => numericFlag('5m', 900, 'timeout-sec'), /must be a non-negative number/);
  assert.throws(() => numericFlag('-1', 900, 'timeout-sec'), /must be a non-negative number/);
});

// Review finding [7]: `Number('')` and `Number('   ')` are BOTH 0 — a bare `Number.isFinite(n) && n
// >= 0` check (battery-lock's own numericFlag, imported here) does NOT catch this, so an empty
// `--stale-min ''` used to silently become a valid 0-minute staleness (reaping every live lock
// instantly) instead of throwing. install-lock's numericFlag wraps battery-lock's with an explicit
// empty/whitespace rejection BEFORE delegating.
test('numericFlag: an empty or whitespace-only string is REJECTED, never silently coerced to 0', () => {
  assert.throws(() => numericFlag('', 900, 'stale-min'), /must be a non-negative number/);
  assert.throws(() => numericFlag('   ', 900, 'stale-min'), /must be a non-negative number/);
  // Sanity: Number('') / Number('   ') really are 0 — the exact JS quirk this guards against.
  assert.equal(Number(''), 0);
  assert.equal(Number('   '), 0);
});

test('assertFlagValue: a valued flag that swallowed the NEXT flag is surfaced, not acted on', () => {
  assert.equal(assertFlagValue('real-token', 'token'), 'real-token');
  assert.throws(() => assertFlagValue('--force', 'token'), /missing its value/);
});

// --- key hashing / normalization ---------------------------------------------

test('normalizeInstallRoot: on win32, case AND separator differences collapse to the same key', () => {
  if (process.platform !== 'win32') return; // POSIX stays case-sensitive by design
  const a = normalizeInstallRoot('C:\\Repo\\vetapp');
  const b = normalizeInstallRoot('c:/repo/VETAPP');
  assert.equal(a, b);
});

test('hashInstallRoot: same root (any spelling) hashes identically; different roots differ', () => {
  const h1 = hashInstallRoot(resolve('.', 'root-a'));
  const h2 = hashInstallRoot(resolve('.', 'root-a') + (process.platform === 'win32' ? '\\' : '/'));
  const h3 = hashInstallRoot(resolve('.', 'root-b'));
  assert.match(h1, /^[0-9a-f]{12}$/);
  assert.notEqual(h1, h3);
  // A trailing separator resolves away via node:path.resolve, so both spellings of root-a match.
  assert.equal(h1, h2);
});

// --- root validation (review finding [1], delta round) -----------------------

test('assertRootExists: a real directory passes silently; a nonexistent path throws a clean message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-lock-root-'));
  assert.doesNotThrow(() => assertRootExists(dir));
  assert.throws(
    () => assertRootExists(resolve(dir, 'does-not-exist')),
    /install root does not exist/,
  );
});

// Review finding [4] (round 3): requireRootIfNeeded is the ONE shared, exported decision both
// install-lock.mjs's own CLI (`cmd === 'acquire'`) and install-main.mjs's CLI (always `true`) call,
// instead of each deciding ad hoc whether a real root is required.
test('requireRootIfNeeded: gates ONLY when needsRoot is true', () => {
  const badRoot = resolve(mkdtempSync(join(tmpdir(), 'install-lock-need-root-')), 'gone');
  assert.doesNotThrow(() => requireRootIfNeeded(badRoot, false));
  assert.throws(() => requireRootIfNeeded(badRoot, true), /install root does not exist/);
  const realDir = mkdtempSync(join(tmpdir(), 'install-lock-need-root-real-'));
  assert.doesNotThrow(() => requireRootIfNeeded(realDir, true));
});

// --- pure helpers -------------------------------------------------------------

test('ageMinutes: whole minutes, clamped ≥0, null on unparseable (re-exported from landing-lock)', () => {
  assert.equal(ageMinutes(ISO, at(20)), 20);
  assert.equal(ageMinutes(ISO, at(-5)), 0);
  assert.equal(ageMinutes('not-a-date', at(0)), null);
});

test('parseEntry: null on malformed JSON or a tokenless object', () => {
  assert.deepEqual(parseEntry('{"token":"t","iso":"x"}'), { token: 't', iso: 'x' });
  assert.equal(parseEntry('{ not json'), null);
  assert.equal(parseEntry('{"iso":"x"}'), null);
});

test('isStale: fresh holder blocks; past the 15m ceiling reapable; UNKNOWN age is reapable', () => {
  const entry = { token: 't', iso: ISO };
  assert.equal(isStale(entry, at(DEFAULT_STALE_MIN), DEFAULT_STALE_MIN), false); // at the ceiling → fresh
  assert.equal(isStale(entry, at(DEFAULT_STALE_MIN + 1), DEFAULT_STALE_MIN), true);
  assert.equal(isStale(null, at(0)), true);
  assert.equal(isStale({ token: 't', iso: 'garbage' }, at(0)), true);
});

test('describeEntry: names the corrupt case rather than pretending it is free', () => {
  assert.match(describeEntry(null, at(0)), /corrupt/);
  assert.match(
    describeEntry({ token: 't', label: 'install-main', host: 'h', pid: 7, iso: ISO }, at(3)),
    /install-main.*3m/,
  );
});

test('DEFAULT_TIMEOUT_SEC matches DEFAULT_STALE_MIN in seconds (a waiter waits as long as a holder may legitimately run)', () => {
  assert.equal(DEFAULT_TIMEOUT_SEC, DEFAULT_STALE_MIN * 60);
});

// --- fs: create / read / reap / release (token ownership) --------------------

test('readEntry: undefined when free (distinct from null = corrupt)', () => {
  const p = tmpLock();
  assert.equal(readEntry(p), undefined);
  writeFileSync(p, '{ not json');
  assert.equal(readEntry(p), null);
});

test('tryCreate: O_EXCL — the first caller wins, the second gets undefined', () => {
  const p = tmpLock();
  const mk = (token) =>
    tryCreate(p, { token, label: 'l', nowIso: ISO, pid: 1, host: 'h', rootHash: 'abc123' });
  assert.equal(mk('first'), 'first');
  assert.equal(mk('second'), undefined);
  assert.equal(readEntry(p).token, 'first'); // the loser did NOT overwrite the holder
});

test('reapStale: unique-target rename means only ONE of two racing reapers wins', () => {
  const p = tmpLock();
  tryCreate(p, { token: 'old', label: 'l', nowIso: ISO, pid: 1, host: 'h', rootHash: 'x' });
  assert.equal(reapStale(p, 'reaper-a'), true);
  assert.equal(reapStale(p, 'reaper-b'), false);
  assert.equal(existsSync(p), false);
});

test('acquireOnce: free → ACQUIRED; held-and-fresh → BUSY; held-and-stale → REAPED', () => {
  const p = tmpLock();
  const call = (token, nowMs) =>
    acquireOnce(p, { token, label: 'l', nowMs, pid: 1, host: 'h', rootHash: 'x' });

  assert.equal(call('t1', at(0)).action, 'ACQUIRED');
  const busy = call('t2', at(1));
  assert.equal(busy.action, 'BUSY');
  assert.equal(busy.entry.token, 't1');
  assert.equal(call('t3', at(DEFAULT_STALE_MIN + 1)).action, 'REAPED');
  assert.equal(existsSync(p), false);
  assert.equal(call('t3', at(DEFAULT_STALE_MIN + 1)).action, 'ACQUIRED');
});

test('releaseAt: only the token holder releases — a MISMATCHED token is FOREIGN and leaves the lock', () => {
  const p = tmpLock();
  tryCreate(p, { token: 'mine', label: 'l', nowIso: ISO, pid: 1, host: 'h', rootHash: 'x' });
  // The case that matters: a session that TIMED OUT holds no token and must not be able to release
  // the install that is actually running.
  assert.equal(releaseAt(p, { token: 'theirs' }).action, 'FOREIGN');
  assert.equal(existsSync(p), true);
  assert.equal(releaseAt(p, { token: 'mine' }).action, 'RELEASED');
  assert.equal(existsSync(p), false);
  assert.equal(releaseAt(p, { token: 'mine' }).action, 'NOOP'); // idempotent
});

test('releaseAt --force clears a corrupt lock a token can never match', () => {
  const p = tmpLock();
  writeFileSync(p, '{ not json');
  assert.equal(releaseAt(p, { token: 'any' }).action, 'FOREIGN');
  assert.equal(releaseAt(p, { token: 'any', force: true }).action, 'RELEASED');
});

// --- lock path resolution: keyed by root, INSTALL_LOCK_DIR redirect -----------

test('resolveLockPath: INSTALL_LOCK_DIR redirects the rendezvous dir without touching real git', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-lock-dir-'));
  withEnvVar({ INSTALL_LOCK_DIR: dir }, () => {
    const p1 = resolveLockPath({ root: resolve(dir, 'root-a') });
    const p2 = resolveLockPath({ root: resolve(dir, 'root-b') });
    assert.equal(p1.startsWith(dir), true);
    assert.notEqual(p1, p2); // different roots → different lock files, never contending
    assert.equal(
      resolveLockPath({ root: resolve(dir, 'root-a') }),
      p1, // same root, same file, deterministically
    );
  });
});

test('resolveLockPath: falls back to the real shared .git common dir when unset', () => {
  withEnvVar({ INSTALL_LOCK_DIR: undefined }, () => {
    const p = resolveLockPath({ root: process.cwd() }).replaceAll('\\', '/');
    assert.match(p, /\.git\/install-lock-[0-9a-f]{12}\.json$/);
  });
});

// Review finding [5]: INSTALL_LOCK_DIR set-but-EMPTY ('') must be REJECTED, never silently fall
// through to the real shared .git common dir the way `envDir || (...)` used to.
test('resolveLockPath: a set-but-EMPTY INSTALL_LOCK_DIR is rejected, never falls back to real .git', () => {
  withEnvVar({ INSTALL_LOCK_DIR: '' }, () => {
    assert.throws(() => resolveLockPath({ root: process.cwd() }), /set but empty/);
  });
});

// Review finding [3]: the git-common-dir probe must be ANCHORED at the RESOLVED install root, not
// the process's own cwd — a caller resolving a path for a root other than its own cwd (e.g. a
// worktree install invoked from elsewhere) would otherwise key the rendezvous DIRECTORY to the
// wrong repo (only the filename hash was ever root-correct). `root` is a REAL directory here
// (finding [2], round 3: resolveLockPath now falls back to process.cwd() for a root that doesn't
// exist — see the dedicated test below — so this test must use one that does exist to still pin
// the "a real root is probed from ITSELF" invariant). Since plan 2483 the probe delegates to the
// shared `resolveCommonDirPath` helper (lock-path.mjs), which anchors via `-C <anchor>` rather
// than an execFileSync `cwd` option — pin the anchor arg instead of an `opts.cwd`.
test('resolveLockPath: the git-common-dir probe is anchored at the install root, not process cwd', () => {
  withEnvVar({ INSTALL_LOCK_DIR: undefined }, () => {
    const root = mkdtempSync(join(tmpdir(), 'install-lock-cwd-probe-'));
    let seenArgs;
    const _exec = (cmd, args) => {
      seenArgs = args;
      return '/fake/.git';
    };
    resolveLockPath({ root, _exec });
    assert.deepEqual(seenArgs.slice(0, 2), ['-C', root]);
  });
});

// Review finding [2] (round 3): a NONEXISTENT root can never be cd'd into (execFileSync's cwd
// option throws before git even runs — verified empirically), which broke status/path for a root
// that's already gone.
//
// Round 4 finding [0] — REGRESSION FIXED (three rounds in a row got this probe wrong): round 3's own
// fix fell back to the CALLING PROCESS's own cwd, which is an arbitrary, caller-dependent guess — it
// could be a SIBLING clone entirely (silent wrong-lock no-op) or the just-deleted root itself
// (throws — see the next test). The fix: fall back to THIS SCRIPT's own directory instead (computed
// once from `import.meta.url`, never `process.cwd()`) — deterministic, always inside THIS clone,
// immune to both failure modes. Every worktree of one clone shares the SAME .git common dir, so this
// still resolves correctly for the real use case (a teardown script querying a deleted worktree's
// lock), without regressing the real-root case pinned by the test above.
test("resolveLockPath: a NONEXISTENT root falls back to THIS SCRIPT's own directory, never process.cwd() (round 4 fix)", () => {
  withEnvVar({ INSTALL_LOCK_DIR: undefined }, () => {
    const parent = mkdtempSync(join(tmpdir(), 'install-lock-noroot-probe-'));
    const badRoot = resolve(parent, 'gone');
    let seenArgs;
    const _exec = (cmd, args) => {
      seenArgs = args;
      return '/fake/.git';
    };
    resolveLockPath({ root: badRoot, _exec });
    // scripts/coord/install-lock.test.mjs lives in the SAME directory as scripts/coord/install-lock.mjs, so this
    // test file's own `import.meta.dirname` IS install-lock.mjs's SCRIPT_DIR.
    assert.equal(seenArgs[1], import.meta.dirname);
    assert.notEqual(seenArgs[1], process.cwd()); // proves it did NOT fall back to the calling process's cwd
  });
});

// Round 4 regression test (the one four review rounds kept missing): resolve the SAME nonexistent
// root from a cwd OUTSIDE this repo entirely and assert the identical real path comes back. Unlike
// the mocked-_exec test above, this exercises the REAL git-common-dir probe end to end — proof that
// the calling process's cwd has ZERO influence on the result once `root` doesn't exist.
test("resolveLockPath: cwd-independence — a NONEXISTENT --root resolves to THIS clone's .git regardless of the calling process's cwd (round 4 regression test)", () => {
  withEnvVar({ INSTALL_LOCK_DIR: undefined }, () => {
    const parent = mkdtempSync(join(tmpdir(), 'install-lock-noroot-real-'));
    const badRoot = resolve(parent, 'gone');

    const fromInside = resolveLockPath({ root: badRoot });

    const prevCwd = process.cwd();
    process.chdir(tmpdir()); // a directory guaranteed OUTSIDE this repo's working tree
    let fromOutside;
    try {
      fromOutside = resolveLockPath({ root: badRoot });
    } finally {
      process.chdir(prevCwd);
    }

    assert.equal(fromOutside, fromInside);
    assert.match(fromOutside.replaceAll('\\', '/'), /\.git\/install-lock-[0-9a-f]{12}\.json$/);
  });
});

// Round 4 finding [5]: `rootExists: true` lets a caller that already verified `root` (runAcquireLoop,
// after requireRootIfNeeded) skip a redundant existsSync of the identical path. Pinned here by
// ROUND 5 REGRESSION TEST — the inverse of the test that used to live here.
// Round 4 added a `rootExists: true` hint so the acquire path could skip a "redundant" existsSync,
// and the test here PINNED that trust. Round 5 found the hint was a fail-CLOSED bug: a root deleted
// between the caller's check and this call (a done-worktree teardown of the worktree being
// installed into) left the hint stale, so resolveLockPath probed a vanished path and THREW from a
// call site with no try/catch above it — killing the install without ever running pnpm, violating
// the FAIL-OPEN contract. The check is now always fresh, and this test pins that: a nonexistent
// root MUST degrade to SCRIPT_DIR no matter what any caller claims.
test('resolveLockPath: a vanished root ALWAYS degrades to SCRIPT_DIR — no caller hint can make it probe a path that does not exist (round 5 regression test)', () => {
  withEnvVar({ INSTALL_LOCK_DIR: undefined }, () => {
    const parent = mkdtempSync(join(tmpdir(), 'install-lock-vanished-'));
    const badRoot = resolve(parent, 'not-really-there');
    let seenArgs;
    const _exec = (cmd, args) => {
      seenArgs = args;
      return '/fake/.git';
    };
    // Pass the old hint name too: even if a stale caller still sends it, it must be inert now.
    resolveLockPath({ root: badRoot, rootExists: true, _exec });
    assert.notEqual(seenArgs[1], badRoot); // must NOT probe the vanished root
    assert.equal(seenArgs[1], import.meta.dirname); // fell back to SCRIPT_DIR — fail-open preserved
  });
});

// safeCwd (round 5, finding [1]): process.cwd() throws uv_cwd when the process's own working dir has
// been deleted — the teardown case. safeCwd must swallow that and yield SCRIPT_DIR rather than let
// an unhandled exception escape before any fallback logic runs.
test('safeCwd: returns SCRIPT_DIR instead of throwing when process.cwd() blows up', () => {
  const realCwd = process.cwd;
  try {
    process.cwd = () => {
      const e = new Error('ENOENT: uv_cwd');
      e.code = 'ENOENT';
      throw e;
    };
    assert.equal(safeCwd(), import.meta.dirname);
  } finally {
    process.cwd = realCwd;
  }
});

// Review finding [12]: resolveLockPath accepts a precomputed rootHash and must not recompute it —
// a bogus rootHash passed in must be trusted (and land in the filename) rather than silently
// ignored/recomputed, proving the parameter is actually load-bearing.
test('resolveLockPath: a precomputed rootHash is used verbatim, never recomputed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-lock-dir-'));
  withEnvVar({ INSTALL_LOCK_DIR: dir }, () => {
    const root = resolve(dir, 'some-root');
    const p = resolveLockPath({ root, rootHash: 'deadbeefcafe' });
    assert.match(p.replaceAll('\\', '/'), /install-lock-deadbeefcafe\.json$/);
  });
});

// Review finding [1] (delta round): the raw execFileSync throw used to escape as an unhandled,
// confusing error ("spawnSync git ENOENT" blames git for what is really a bad cwd/repo). ANY git
// failure must now surface as ONE clean wrapped message instead.
test('resolveLockPath: a failing git-common-dir probe surfaces as ONE clean wrapped message, never the raw exec error', () => {
  withEnvVar({ INSTALL_LOCK_DIR: undefined }, () => {
    const root = mkdtempSync(join(tmpdir(), 'install-lock-gitfail-'));
    const _exec = () => {
      const e = new Error('raw spawnSync noise nobody should see verbatim');
      e.code = 'ENOENT';
      throw e;
    };
    let thrown;
    try {
      resolveLockPath({ root, _exec });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'expected resolveLockPath to throw');
    assert.match(thrown.message, /cannot resolve the shared \.git common dir/);
    assert.match(thrown.message, /is this root a git repository/);
    assert.doesNotMatch(thrown.message, /raw spawnSync noise/);
  });
});

// --- runAcquireLoop: bypass hatch, and the acceptance test --------------------

test('runAcquireLoop: INSTALL_LOCK_DISABLE=1 bypasses entirely — no lockfile touched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-lock-dir-'));
  withEnvVar({ INSTALL_LOCK_DIR: dir, INSTALL_LOCK_DISABLE: '1' }, () => {
    const r = runAcquireLoop({ root: resolve(dir, 'root-x'), log: () => {} });
    assert.equal(r.code, 0);
    assert.equal(typeof r.token, 'string'); // a token still comes back so a caller has SOMETHING
    assert.equal(r.lockPath, null);
    assert.equal(r.bypassed, true);
  });
});

// ACCEPTANCE TEST 1 (the plan's own criterion): two simultaneous acquires against the SAME install
// root serialize — the second must WAIT (not silently hold) while the first holds the lock.
// INSTALL_LOCK_DIR isolates this from the real shared `.git` common dir.
test('acceptance: two concurrent acquires against the SAME root serialize (one holds, one waits then times out)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-lock-dir-'));
  withEnvVar({ INSTALL_LOCK_DIR: dir }, () => {
    const root = resolve(dir, 'shared-root');
    const first = runAcquireLoop({ root, log: () => {} });
    assert.equal(first.code, 0);
    assert.equal(typeof first.token, 'string');

    // The second acquire, while the first still holds the lock, must NOT acquire — it must wait
    // out a short bounded timeout and report EXIT_TIMEOUT (fail-open: never wedge), never silently
    // co-hold the same root's install.
    const second = runAcquireLoop({
      root,
      timeoutSec: 1,
      pollSec: 0.2,
      log: () => {},
    });
    assert.equal(second.code, EXIT_TIMEOUT);
    assert.equal(second.token, null);

    // The lock file on disk still names the FIRST holder's token — the second never overwrote it.
    const lockText = readFileSync(first.lockPath, 'utf8');
    assert.equal(JSON.parse(lockText).token, first.token);

    // A DIFFERENT root, meanwhile, is never blocked by the first root's holder.
    const other = runAcquireLoop({ root: resolve(dir, 'other-root'), log: () => {} });
    assert.equal(other.code, 0);
    assert.notEqual(other.lockPath, first.lockPath);

    releaseAt(first.lockPath, { token: first.token });
    releaseAt(other.lockPath, { token: other.token });
  });
});

test('runAcquireLoop: a stale (>15m old) holder is reaped and the waiter takes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-lock-dir-'));
  withEnvVar({ INSTALL_LOCK_DIR: dir }, () => {
    const root = resolve(dir, 'stale-root');
    const lockPath = resolveLockPath({ root });
    const old = new Date(Date.now() - (DEFAULT_STALE_MIN + 5) * 60000).toISOString();
    writeFileSync(
      lockPath,
      JSON.stringify({ token: 'dead', label: 'crashed', iso: old, pid: 1, host: 'h' }),
    );
    const messages = [];
    const r = runAcquireLoop({ root, timeoutSec: 5, log: (m) => messages.push(m) });
    assert.equal(r.code, 0);
    assert.notEqual(r.token, 'dead');
    assert.ok(messages.some((m) => /reaped/.test(m)));
  });
});

// --- CLI end-to-end (spawnSync, INSTALL_LOCK_DIR-isolated) --------------------

test('CLI acquire/status/release round-trip: exit 0, token on stdout ONLY, lockfile written', () => {
  const { dir, env } = newLockDirEnv();
  const root = resolve(dir, 'cli-root');
  const out = runCli(env, ['acquire', '--root', root, '--label', 'install-main-test']);
  assert.equal(out.status, 0, out.stderr);
  const token = out.stdout.trim();
  assert.match(token, /^[0-9a-f-]{36}$/);
  const p = runCli(env, ['path', '--root', root]).stdout.trim();
  const lock = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(lock.token, token);
  assert.equal(lock.label, 'install-main-test');

  assert.equal(runCli(env, ['status', '--root', root]).stdout.trim().startsWith('held'), true);
  assert.equal(runCli(env, ['release', '--root', root, '--token', token]).status, 0);
  assert.equal(runCli(env, ['status', '--root', root]).stdout.trim(), 'free');
});

test('CLI acquire: a held lock times out with EXIT_TIMEOUT, proceed-unserialized wording, no stdout token', () => {
  const { env } = newLockDirEnv();
  const root = resolve(env.INSTALL_LOCK_DIR, 'cli-root-2');
  assert.equal(runCli(env, ['acquire', '--root', root]).status, 0);
  const out = runCli(env, ['acquire', '--root', root, '--timeout-sec', '1', '--poll-sec', '1']);
  assert.equal(out.status, EXIT_TIMEOUT);
  assert.match(out.stderr, /TIMEOUT/);
  assert.match(out.stderr, /UNSERIALIZED/);
  assert.equal(out.stdout.trim(), ''); // no token → no release should ever be attempted with it
});

test('CLI release: a foreign token never unlinks, and still exits 0 (close-out never blocks)', () => {
  const { env } = newLockDirEnv();
  const root = resolve(env.INSTALL_LOCK_DIR, 'cli-root-3');
  const token = runCli(env, ['acquire', '--root', root]).stdout.trim();
  const out = runCli(env, ['release', '--root', root, '--token', 'not-the-token']);
  assert.equal(out.status, 0);
  assert.match(out.stderr, /NOT releasing/);
  assert.equal(runCli(env, ['status', '--root', root]).stdout.trim().startsWith('held'), true);
  assert.equal(runCli(env, ['release', '--root', root, '--token', token]).status, 0);
});

// Review finding [6]: --root, unlike --label/--token, was read raw with no assertFlagValue guard,
// so `acquire --root --dry` silently swallowed `--dry` as the root VALUE (and `--dry` itself
// vanishes from flags, since parseFlags's value-flag consumption is unconditional). The CLI must
// now surface this loudly instead of silently acting on a garbage root.
test('CLI acquire: --root immediately followed by another flag is REJECTED, not silently swallowed', () => {
  const { env } = newLockDirEnv();
  const out = runCli(env, ['acquire', '--root', '--force']);
  assert.equal(out.status, EXIT_ERROR);
  assert.match(out.stderr, /--root is missing its value/);
});

// Review finding [1] (delta round): `node scripts/coord/install-lock.mjs acquire --root <bad>` used to
// die with a raw "spawnSync git ENOENT" — this pins the clean, one-line, non-zero-exit replacement.
// Runs WITHOUT INSTALL_LOCK_DIR (the real path) — the check is skipped under test isolation, where
// root is a bare hashing key that need not exist on disk.
//
// Review finding [2] (round 3): this test used to run against `status`, not `acquire` — but status
// is a pure read-only query that must NOT hard-fail on a missing root (see the dedicated test
// below). Only `acquire` genuinely needs a real root, so it's the one this test now exercises.
test('CLI acquire: a nonexistent --root fails fast with ONE clean line, never a raw git/stack error', () => {
  const env = { ...process.env };
  delete env.INSTALL_LOCK_DIR;
  const parent = mkdtempSync(join(tmpdir(), 'install-lock-noroot-'));
  const badRoot = resolve(parent, 'does-not-exist');
  const out = runCli(env, ['acquire', '--root', badRoot]);
  assert.equal(out.status, EXIT_ERROR);
  assert.match(out.stderr, /install-lock: install root does not exist/);
  assert.equal(out.stderr.trim().split('\n').length, 1); // ONE line, no stack
});

// Review finding [2] (round 3) — REGRESSION FIXED: status/path are pure read-only lockfile queries
// that never touch `root` on disk — a teardown script probing "is any lock outstanding for the
// worktree I just deleted?" must keep working. Runs WITHOUT INSTALL_LOCK_DIR (the real path).
test('CLI status/path: succeed (do not hard-fail) on a nonexistent --root', () => {
  const env = { ...process.env };
  delete env.INSTALL_LOCK_DIR;
  const parent = mkdtempSync(join(tmpdir(), 'install-lock-noroot-ro-'));
  const badRoot = resolve(parent, 'does-not-exist');

  const statusOut = runCli(env, ['status', '--root', badRoot]);
  assert.equal(statusOut.status, 0, statusOut.stderr);
  assert.equal(statusOut.stdout.trim(), 'free');

  const pathOut = runCli(env, ['path', '--root', badRoot]);
  assert.equal(pathOut.status, 0, pathOut.stderr);
  assert.match(pathOut.stdout.trim().replaceAll('\\', '/'), /install-lock-[0-9a-f]{12}\.json$/);
});

test('CLI: unknown command exits EXIT_ERROR, not 0', () => {
  const { env } = newLockDirEnv();
  assert.equal(runCli(env, ['frobnicate']).status, EXIT_ERROR);
});

test('CLI: a non-numeric --timeout-sec EXITs rather than spinning forever', () => {
  const { env } = newLockDirEnv();
  const root = resolve(env.INSTALL_LOCK_DIR, 'cli-root-4');
  runCli(env, ['acquire', '--root', root]); // hold it, so the waiter would otherwise loop
  const out = runCli(env, ['acquire', '--root', root, '--timeout-sec', '5m']);
  assert.equal(out.status, EXIT_ERROR);
  assert.match(out.stderr, /must be a non-negative number/);
});

// ACCEPTANCE TEST 1, true concurrency variant: two REAL, simultaneously-spawned CLI processes
// racing for the SAME root's lock — exactly one wins, mirroring battery-lock.test.mjs's own
// two-concurrent-process case for the sibling lock.
test('two CONCURRENT CLI acquires against the SAME root: exactly one wins', async () => {
  const { dir, env } = newLockDirEnv();
  const root = resolve(dir, 'race-root');
  const launch = () =>
    new Promise((res) => {
      const c = spawn(
        process.execPath,
        [CLI, 'acquire', '--root', root, '--timeout-sec', '2', '--poll-sec', '1'],
        { env },
      );
      let stdout = '';
      c.stdout.on('data', (d) => (stdout += d));
      c.on('close', (status) => res({ status, stdout: stdout.trim() }));
    });

  const [a, b] = await Promise.all([launch(), launch()]);
  const winners = [a, b].filter((r) => r.status === 0);
  assert.equal(winners.length, 1, `expected exactly one winner, got ${JSON.stringify([a, b])}`);
  assert.equal([a, b].filter((r) => r.status === EXIT_TIMEOUT).length, 1);
  const lockPath = runCli(env, ['path', '--root', root]).stdout.trim();
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, winners[0].stdout);
});

// A DIFFERENT root's concurrent acquire must never contend with the race-root pair above —
// the root-keying is what makes a worktree install and the main-checkout install independent.
test('two concurrent CLI acquires against DIFFERENT roots never contend', async () => {
  const { dir, env } = newLockDirEnv();
  const launch = (root) =>
    new Promise((res) => {
      const c = spawn(process.execPath, [CLI, 'acquire', '--root', root], { env });
      let stdout = '';
      c.stdout.on('data', (d) => (stdout += d));
      c.on('close', (status) => res({ status, stdout: stdout.trim() }));
    });
  const [a, b] = await Promise.all([
    launch(resolve(dir, 'root-1')),
    launch(resolve(dir, 'root-2')),
  ]);
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.notEqual(a.stdout, b.stdout); // distinct tokens, distinct locks, both acquired immediately
});
