// scripts/battery-lock.test.mjs — unit + CLI tests for the machine-wide pre-push battery mutex
// (plan 1673). Pure staleness/parse logic, fs acquire/release against an injectable temp path, and
// end-to-end CLI runs inside throwaway git repos (the lock rendezvous is `git rev-parse
// --git-common-dir`, so a real repo is needed for the CLI arm).
//
// The invariant every case defends: SERIALIZATION IS LOAD-SHEDDING, NEVER A TEST-SKIP. A queue-wait
// expiry must exit with the distinct EXIT_TIMEOUT so the hook runs the battery anyway. Nothing here
// may ever let a lock failure suppress a test run.
//
// Ownership is by TOKEN (a timed-out waiter holds none, so it cannot release the real holder's
// lock). Staleness (plan 2549): a SAME-HOST entry whose DECLARED `holderPid` is provably dead
// reaps immediately regardless of age; a FOREIGN host, an unprovable probe, a pid-reuse
// false-alive, and any entry WITHOUT the declaration all fall through to the original AGE rule
// (the `landing-lock.mjs` convention). `entry.pid` is NEVER probed — it is the short-lived
// acquire subprocess, dead in normal operation (see battery-lock.mjs's header).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve, posix } from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { cleanGitEnv } from '../test-helpers/clean-git-env.mjs';
import { scriptFile } from '../test-helpers/repo-script-path.mjs';
import {
  parseLockArgs,
  BATTERY_ARG_SPEC,
  numericFlag,
  assertFlagValue,
  ageMinutes,
  parseEntry,
  isStale,
  describeEntry,
  readEntry,
  tryCreate,
  reapStale,
  acquireOnce,
  holderProvedDead,
  releaseAt,
  resolveLockPath,
  resolveTierPaths,
  DEFAULT_STALE_MIN,
  EXIT_TIMEOUT,
  EXIT_ERROR,
  OVERFLOW_TEST_CONCURRENCY,
  // plan 2734: the progress-aware wait + two-tier admission replaced the flat DEFAULT_TIMEOUT_SEC.
  LOCK_TIERS,
  BATTERY_P95_SEC,
  LOAD_MULTIPLIER,
  LOADED_BATTERY_SEC,
  HOLDER_PATIENCE_SEC,
  HOLDER_PATIENCE_MARGIN_SEC,
  MAX_TOTAL_WAIT_SEC,
  ADMISSION_WAIT_SEC,
  holderAgeSec,
  holderStuck,
  holderPidTrustworthy,
  decideWaitStep,
  effectiveAdmissionWaitSec,
} from './battery-lock.mjs';

const CLI = resolve(import.meta.dirname, 'battery-lock.mjs');
const ISO = '2026-07-10T10:00:00.000Z';
const at = (min) => Date.parse(ISO) + min * 60000;

const tmpLock = () => join(mkdtempSync(join(tmpdir(), 'battery-lock-')), 'battery-lock.json');

function tmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'battery-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: cleanGitEnv() });
  return dir;
}

const runCli = (repo, args) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    env: cleanGitEnv(),
    encoding: 'utf8',
    // plan 4005 (round-2 finding f673a1): an outer bound, so a CLI that wedges fails its own test
    // rather than parking the battery until node --test's 900s per-test cap. Chosen well above the
    // longest window any caller here asks for (the clamp test's 60s ceiling), so it can never end a
    // run that would otherwise have passed.
    timeout: 300_000,
  });

// --- pure helpers -----------------------------------------------------------
// parseLockArgs + ageMinutes are landing-lock's, re-exported here rather than re-implemented.
// Since plan 1777 the parser is spec'd (coord-git parseFlags underneath): battery-lock's CLI
// passes its OWN flag surface (BATTERY_ARG_SPEC) — landing-lock's default spec would refuse
// `--label`/`--token`. These cases pin the shape battery-lock's CLI relies on.
test('parseLockArgs: command, valued flags, and the bare boolean --force (battery spec)', () => {
  const a = parseLockArgs(['acquire', '--label', 'prepush', '--stale-min', '60'], BATTERY_ARG_SPEC);
  assert.equal(a.cmd, 'acquire');
  assert.deepEqual(a.flags, { label: 'prepush', 'stale-min': '60' });
  const r = parseLockArgs(['release', '--token', 't', '--force'], BATTERY_ARG_SPEC);
  assert.equal(r.cmd, 'release');
  assert.deepEqual(r.flags, { token: 't', force: true });
});

test('parseLockArgs: battery spec refuses a landing-lock-only or unknown flag loudly', () => {
  assert.throws(
    () => parseLockArgs(['acquire', '--scope', '{"global":true}'], BATTERY_ARG_SPEC),
    /battery-lock: unknown flag --scope/,
  );
  assert.throws(
    () => parseLockArgs(['acquire', '--labell', 'x'], BATTERY_ARG_SPEC),
    /battery-lock: unknown flag --labell/,
  );
});

test('numericFlag: falls back when absent, coerces a number, THROWS on NaN/negative', () => {
  assert.equal(numericFlag(undefined, 60, 'stale-min'), 60);
  assert.equal(numericFlag('90', 60, 'stale-min'), 90);
  // The bug this guards: Number('5m') is NaN, and `Date.now() >= NaN` is always false, so an
  // unvalidated NaN timeout makes the bounded queue wait spin forever and hangs `git push`.
  assert.throws(() => numericFlag('5m', 60, 'timeout-sec'), /must be a non-negative number/);
  assert.throws(() => numericFlag('-1', 60, 'timeout-sec'), /must be a non-negative number/);
});

// Review finding [3] (delta round, plan 1869 install-lock delta): `Number('')` and `Number('   ')`
// are BOTH `0` — a JS coercion quirk the `Number.isFinite(n) && n >= 0` check alone does not catch,
// so a blank `--stale-min ''` on THIS file's own CLI used to silently become a valid 0-minute
// staleness that reaps every LIVE lock instantly, resurrecting the exact battery herd this lock
// exists to prevent. This bug used to be patched only in install-lock.mjs's own thin local wrapper
// around this function, leaving it live here in the shared helper (and in this file's own CLI,
// which calls numericFlag with no wrapper of its own).
test('numericFlag: an empty or whitespace-only string is REJECTED, never silently coerced to 0', () => {
  assert.throws(() => numericFlag('', 60, 'stale-min'), /must be a non-negative number/);
  assert.throws(() => numericFlag('   ', 60, 'stale-min'), /must be a non-negative number/);
  // Sanity: Number('') / Number('   ') really are 0 — the exact JS quirk this guards against.
  assert.equal(Number(''), 0);
  assert.equal(Number('   '), 0);
});

// Regression pin: the empty-string rejection must NEVER over-reach into rejecting a legitimate
// explicit zero — `--stale-min 0` is a real, meaningful value (immediate staleness) and must keep
// coercing to the number 0, not throw.
test('numericFlag: an explicit "0" string still coerces to the number 0, never rejected', () => {
  assert.equal(numericFlag('0', 60, 'stale-min'), 0);
  assert.equal(numericFlag(null, 60, 'stale-min'), 60);
  assert.equal(numericFlag('15', 60, 'stale-min'), 15);
});

test('assertFlagValue: a valued flag that swallowed the NEXT flag is surfaced, not acted on', () => {
  assert.equal(assertFlagValue('real-token', 'token'), 'real-token');
  // `release --token --force`: the parser consumed `--force` as the token value.
  assert.throws(() => assertFlagValue('--force', 'token'), /missing its value/);
});

test('ageMinutes: whole minutes, clamped ≥0, null on unparseable', () => {
  assert.equal(ageMinutes(ISO, at(20)), 20);
  assert.equal(ageMinutes(ISO, at(-5)), 0);
  assert.equal(ageMinutes('not-a-date', at(0)), null);
});

test('parseEntry: null on malformed JSON or a tokenless object', () => {
  assert.deepEqual(parseEntry('{"token":"t","iso":"x"}'), { token: 't', iso: 'x' });
  assert.equal(parseEntry('{ not json'), null);
  assert.equal(parseEntry('{"iso":"x"}'), null);
});

test('isStale: fresh holder blocks; past the ceiling reapable; UNKNOWN age is reapable', () => {
  const entry = { token: 't', iso: ISO };
  assert.equal(isStale(entry, at(DEFAULT_STALE_MIN), DEFAULT_STALE_MIN), false); // exactly at ceiling → fresh
  assert.equal(isStale(entry, at(DEFAULT_STALE_MIN + 1), DEFAULT_STALE_MIN), true);
  // A corrupt lock (null) or an unparseable timestamp must never wedge the machine forever.
  assert.equal(isStale(null, at(0)), true);
  assert.equal(isStale({ token: 't', iso: 'garbage' }, at(0)), true);
});

test('describeEntry: names the corrupt case rather than pretending it is free', () => {
  assert.match(describeEntry(null, at(0)), /corrupt/);
  assert.match(
    describeEntry({ token: 't', label: 'prepush-1', host: 'h', pid: 7, iso: ISO }, at(3)),
    /prepush-1.*3m/,
  );
});

// --- fs: create / read / reap / release -------------------------------------
test('readEntry: undefined when free (distinct from null = corrupt)', () => {
  const p = tmpLock();
  assert.equal(readEntry(p), undefined);
  writeFileSync(p, '{ not json');
  assert.equal(readEntry(p), null);
});

test('tryCreate: O_EXCL — the first caller wins, the second gets undefined', () => {
  const p = tmpLock();
  const mk = (token) => tryCreate(p, { token, label: 'l', nowIso: ISO, pid: 1, host: 'h' });
  assert.equal(mk('first'), 'first');
  assert.equal(mk('second'), undefined);
  assert.equal(readEntry(p).token, 'first'); // the loser did NOT overwrite the holder
});

test('reapStale: unique-target rename means only ONE of two racing reapers wins', () => {
  const p = tmpLock();
  tryCreate(p, { token: 'old', label: 'l', nowIso: ISO, pid: 1, host: 'h' });
  assert.equal(reapStale(p, 'reaper-a'), true);
  // The rival's rename now finds nothing. If reap were unlink-based, this second reaper would
  // delete whatever FRESH lock the winner has since created — the classic reap race.
  assert.equal(reapStale(p, 'reaper-b'), false);
  assert.equal(existsSync(p), false);
});

test('acquireOnce: free → ACQUIRED; held-and-fresh → BUSY; held-and-stale → REAPED', () => {
  const p = tmpLock();
  // This test is about the AGE rule specifically, so the holder is pinned ALIVE throughout —
  // the pid-liveness rule (plan 2549) gets its own dedicated cases below.
  const call = (token, nowMs) =>
    acquireOnce(p, { token, label: 'l', nowMs, pid: 1, host: 'h', _pidAlive: () => true });

  assert.equal(call('t1', at(0)).action, 'ACQUIRED');
  const busy = call('t2', at(1));
  assert.equal(busy.action, 'BUSY');
  assert.equal(busy.entry.token, 't1');
  // Past the 15-minute ceiling the holder is presumed wedged: reaped, and the NEXT loop iteration
  // takes the lock. acquireOnce itself only reports the reap.
  const reaped = call('t3', at(DEFAULT_STALE_MIN + 1));
  assert.equal(reaped.action, 'REAPED');
  assert.equal(reaped.reason, 'age');
  assert.equal(existsSync(p), false);
  assert.equal(call('t3', at(DEFAULT_STALE_MIN + 1)).action, 'ACQUIRED');
});

// --- holder-pid-proved staleness (plan 2549) --------------------------------
// The probe targets ONLY the entry's DECLARED `holderPid`, never `entry.pid`: pid is whichever
// process WROTE the file — for the hook that is the command-substitution acquire subprocess, dead
// milliseconds after every HEALTHY acquire. Probing it would reap every legitimately held lock
// (the execution finding that reshaped plan 2549's spec — see the module header).
test('acquireOnce: same-host + DEAD holderPid + fresh age → REAPED regardless of age, naming the reason', () => {
  const p = tmpLock();
  tryCreate(p, {
    token: 'dead-holder',
    label: 'l',
    nowIso: ISO,
    pid: 999,
    host: 'h',
    holderPid: 4242,
  });
  const probedWith = [];
  const r = acquireOnce(p, {
    token: 't2',
    label: 'l',
    nowMs: at(1), // fresh — age alone would say BUSY; the dead holder must reap it anyway
    pid: 1,
    host: 'h',
    _pidAlive: (x) => {
      probedWith.push(x);
      return false;
    },
  });
  assert.equal(r.action, 'REAPED');
  assert.equal(r.reason, 'dead-pid');
  assert.equal(r.entry.token, 'dead-holder');
  assert.deepEqual(probedWith, [4242], 'the probe must target holderPid, never entry.pid');
  assert.equal(existsSync(p), false);
});

test('acquireOnce: same-host + LIVE holderPid + fresh age → BUSY, never reaped early (negative control)', () => {
  const p = tmpLock();
  tryCreate(p, {
    token: 'live-holder',
    label: 'l',
    nowIso: ISO,
    pid: 999,
    host: 'h',
    holderPid: 4242,
  });
  const r = acquireOnce(p, {
    token: 't2',
    label: 'l',
    nowMs: at(1),
    pid: 1,
    host: 'h',
    _pidAlive: () => true,
  });
  assert.equal(r.action, 'BUSY');
  assert.equal(r.entry.token, 'live-holder');
});

test('acquireOnce: a FOREIGN host is never probed — fresh age still blocks (negative control)', () => {
  const p = tmpLock();
  tryCreate(p, {
    token: 'foreign-holder',
    label: 'l',
    nowIso: ISO,
    pid: 999,
    host: 'other-host',
    holderPid: 4242,
  });
  let probed = false;
  const r = acquireOnce(p, {
    token: 't2',
    label: 'l',
    nowMs: at(1), // fresh — a same-host dead holder would reap this immediately if the seam ran
    pid: 1,
    host: 'h',
    _pidAlive: () => {
      probed = true;
      return false;
    },
  });
  assert.equal(probed, false, '_pidAlive must never be invoked for a foreign host');
  assert.equal(r.action, 'BUSY'); // age-only, exactly as before this plan
});

test('acquireOnce: an entry WITHOUT a declared holderPid is never liveness-reaped — age-only, as before', () => {
  const p = tmpLock();
  // No holderPid: an older hook, a manual CLI acquire, or cloud-session-hygiene's delete lock
  // (which passes a MEANINGFUL long-lived pid as `pid` — but never declared it probeable). The
  // REAL pidAlive default runs here: pidAlive(undefined) → null → fall through to the age rule.
  // pid 999 does not exist on any sane test machine, so if the gate ever probed entry.pid this
  // would reap and fail loudly.
  tryCreate(p, { token: 'undeclared', label: 'l', nowIso: ISO, pid: 999, host: 'h' });
  const fresh = acquireOnce(p, { token: 't2', label: 'l', nowMs: at(1), pid: 1, host: 'h' });
  assert.equal(fresh.action, 'BUSY');
  const stale = acquireOnce(p, {
    token: 't3',
    label: 'l',
    nowMs: at(DEFAULT_STALE_MIN + 1),
    pid: 1,
    host: 'h',
  });
  assert.equal(stale.action, 'REAPED');
  assert.equal(stale.reason, 'age');
});

test('acquireOnce: pid-reuse false-alive degrades to age-only — never a reap it should not', () => {
  const p = tmpLock();
  tryCreate(p, {
    token: 'reused-pid',
    label: 'l',
    nowIso: ISO,
    pid: 999,
    host: 'h',
    holderPid: 4242,
  });
  // The original holder died; an unrelated process later took the same pid — the probe cannot
  // tell the difference and reports ALIVE. That must fall through to age, never a reap.
  const fresh = acquireOnce(p, {
    token: 't2',
    label: 'l',
    nowMs: at(1),
    pid: 1,
    host: 'h',
    _pidAlive: () => true,
  });
  assert.equal(fresh.action, 'BUSY');
  const stale = acquireOnce(p, {
    token: 't3',
    label: 'l',
    nowMs: at(DEFAULT_STALE_MIN + 1),
    pid: 1,
    host: 'h',
    _pidAlive: () => true,
  });
  assert.equal(stale.action, 'REAPED');
  assert.equal(stale.reason, 'age');
});

test('acquireOnce: a CORRUPT lock entry (null) is reaped, never a TypeError (review 2549 [0])', () => {
  const p = tmpLock();
  writeFileSync(p, '{ not json'); // readEntry → null: present-but-unparseable
  // The regression this pins: the first liveness-gate shape dereferenced entry.host before any
  // null check, so a corrupt lock THREW → main() → EXIT_ERROR → the hook ran the battery
  // UNSERIALIZED — silently re-opening the herd pathology. Pre-2549 behaviour (isStale treats
  // null as reapable) must survive the liveness gate.
  const r = acquireOnce(p, { token: 't1', label: 'l', nowMs: at(0), pid: 1, host: 'h' });
  assert.equal(r.action, 'REAPED');
  assert.equal(r.reason, 'age');
  assert.equal(existsSync(p), false);
});

test('holderProvedDead: true ONLY for same-host + declared + provably-dead; false for every other shape', () => {
  const dead = () => false;
  const base = { token: 't', iso: ISO, pid: 1, host: 'h', holderPid: 42 };
  assert.equal(holderProvedDead(base, { host: 'h', _pidAlive: dead }), true);
  assert.equal(holderProvedDead(null, { host: 'h', _pidAlive: dead }), false); // corrupt
  assert.equal(holderProvedDead(undefined, { host: 'h', _pidAlive: dead }), false); // free
  assert.equal(holderProvedDead({ ...base, host: 'other' }, { host: 'h', _pidAlive: dead }), false); // foreign
  assert.equal(holderProvedDead(base, { host: 'h', _pidAlive: () => true }), false); // alive
  assert.equal(holderProvedDead(base, { host: 'h', _pidAlive: () => null }), false); // unprovable
  // Undeclared: the real pidAlive gets undefined → null → false.
  const { holderPid: _omit, ...undeclared } = base;
  assert.equal(holderProvedDead(undeclared, { host: 'h' }), false);
});

test('acquireOnce: an unprovable probe (null) degrades to age-only, never a reap', () => {
  const p = tmpLock();
  tryCreate(p, {
    token: 'unprovable',
    label: 'l',
    nowIso: ISO,
    pid: 999,
    host: 'h',
    holderPid: 4242,
  });
  const r = acquireOnce(p, {
    token: 't2',
    label: 'l',
    nowMs: at(1),
    pid: 1,
    host: 'h',
    _pidAlive: () => null,
  });
  assert.equal(r.action, 'BUSY');
});

test('releaseAt: only the token holder releases; a mismatch is FOREIGN and leaves the lock', () => {
  const p = tmpLock();
  tryCreate(p, { token: 'mine', label: 'l', nowIso: ISO, pid: 1, host: 'h' });
  // This is the case that matters: a session that TIMED OUT holds no token and must not be able to
  // release the battery that is actually running.
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

// --- lock path rendezvous ---------------------------------------------------
test('resolveLockPath: lands in the shared .git common dir, GIT_* env scrubbed', () => {
  const repo = tmpRepo();
  const out = runCli(repo, ['path']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout.trim().replaceAll('\\', '/'), /\.git\/battery-lock\.json$/);
  // The scrub is what makes the path deterministic from cwd even inside a hook.
  // `_path: posix` is explicit here (plan 2503, restoring plan 2501's never-landed fix — the same
  // pin plan 2489 applied to the sibling in lock-path.test.mjs). This fixture's anchor and expected
  // output are both drive-less POSIX paths, so running it through the UN-injected platform-native
  // default made win32.resolve drive-relativize it to `C:/somewhere/.git` and the assertion could
  // only pass on Linux. Pinning the flavour makes it platform-independent rather than green on the
  // cloud and red on the operator's Windows host.
  const stray = resolveLockPath({ _exec: () => '/somewhere/.git\n', _path: posix });
  assert.equal(stray, '/somewhere/.git/battery-lock.json');
});

// --- CLI end-to-end ---------------------------------------------------------
test('CLI acquire: exit 0, token on stdout ONLY, lockfile written', () => {
  const repo = tmpRepo();
  const out = runCli(repo, ['acquire', '--label', 'prepush-test']);
  assert.equal(out.status, 0, out.stderr);
  const token = out.stdout.trim();
  assert.match(token, /^[0-9a-f-]{36}$/); // the hook captures stdout verbatim as the token
  const lock = JSON.parse(readFileSync(join(repo, '.git', 'battery-lock.json'), 'utf8'));
  assert.equal(lock.token, token);
  assert.equal(lock.label, 'prepush-test');

  // plan 2734: `status` reports BOTH tiers, one line each — a report naming only the serialized
  // lock says "free" on a machine that is running an admitted overflow battery.
  assert.match(runCli(repo, ['status']).stdout, /^serialized: held /m);
  assert.match(runCli(repo, ['status']).stdout, /^overflow: free$/m);
  assert.equal(runCli(repo, ['release', '--token', token]).status, 0);
  assert.match(runCli(repo, ['status']).stdout, /^serialized: free$/m);
});

test('CLI acquire: leaving the serialized wait exits EXIT_TIMEOUT with the REDUCED-parallelism contract', () => {
  const repo = tmpRepo();
  assert.equal(runCli(repo, ['acquire']).status, 0);
  // --timeout-sec is the anti-hang TOTAL ceiling since plan 2734, so 1s expires it immediately.
  const out = runCli(repo, ['acquire', '--timeout-sec', '1', '--poll-sec', '1']);
  // NOT exit 1, NOT exit 0 — the hook branches on this to run the battery at reduced parallelism.
  assert.equal(out.status, EXIT_TIMEOUT);
  assert.notEqual(EXIT_TIMEOUT, 0);
  assert.match(out.stderr, /REDUCED parallelism/);
  assert.match(out.stderr, new RegExp(`--test-concurrency=${OVERFLOW_TEST_CONCURRENCY}\\b`));
  // plan 2734: with the overflow slot FREE the waiter is ADMITTED to it instead of joining the
  // machine unaccounted, and it PRINTS that slot's token — holding the slot is precisely what stops
  // a second timed-out waiter from running beside it. (Pre-2734 this asserted an EMPTY stdout; that
  // contract is what let N expired waiters all run at once — the measured 2026-08-02 herd.)
  assert.match(out.stderr, /ADMITTED to the overflow slot/);
  const token = out.stdout.trim();
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.equal(
    JSON.parse(readFileSync(join(repo, '.git', LOCK_TIERS.overflow), 'utf8')).token,
    token,
  );
});

test('plan 2734: the overflow budget is ONE — a third battery runs UNADMITTED, slot untouched', () => {
  const repo = tmpRepo();
  assert.equal(runCli(repo, ['acquire', '--label', 'tier1']).status, 0);
  const slot = runCli(repo, [
    'acquire',
    '--label',
    'tier2',
    '--timeout-sec',
    '1',
    '--poll-sec',
    '1',
  ]);
  assert.equal(slot.status, EXIT_TIMEOUT);
  const slotToken = slot.stdout.trim();
  assert.match(slotToken, /^[0-9a-f-]{36}$/);

  const third = runCli(repo, [
    'acquire',
    '--label',
    'tier3',
    '--timeout-sec',
    '1',
    '--poll-sec',
    '1',
    '--admission-wait-sec',
    '1',
  ]);
  // It still RUNS the battery (never a test-skip) and still clamps — it just holds nothing.
  assert.equal(third.status, EXIT_TIMEOUT);
  assert.equal(third.stdout.trim(), ''); // no token → the hook will not attempt a release
  assert.match(third.stderr, /TIMEOUT/);
  assert.match(third.stderr, /never a test-skip/);
  assert.equal(
    JSON.parse(readFileSync(join(repo, '.git', LOCK_TIERS.overflow), 'utf8')).token,
    slotToken,
    'an unadmitted waiter must never steal or rewrite the overflow slot',
  );
});

test('plan 2734: a STUCK holder ends the wait — the waiter own elapsed clock does not', () => {
  const repo = tmpRepo();
  const lockPath = join(repo, '.git', LOCK_TIERS.serialized);
  // A holder 5 minutes in, judged against a 60s patience: STUCK by the holder-age rule while the
  // total-wait ceiling (600s) is nowhere near expiry — so only the patience rule can end this wait.
  // host is foreign so the dead-pid reap cannot fire and the entry survives to be judged.
  writeFileSync(
    lockPath,
    JSON.stringify({
      token: 'slow-holder',
      label: 'holder',
      iso: new Date(Date.now() - 5 * 60000).toISOString(),
      pid: 1,
      host: 'another-host',
    }),
  );
  const out = runCli(repo, [
    'acquire',
    '--holder-patience-sec',
    '60',
    '--timeout-sec',
    '600',
    '--poll-sec',
    '1',
  ]);
  assert.equal(out.status, EXIT_TIMEOUT);
  assert.match(out.stderr, /STUCK/);
  assert.match(out.stderr, /has held past 60s/);
  // Giving up is NOT reaping: the holder's entry is left strictly alone.
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'slow-holder');
});

test('plan 2734: release probes BOTH tiers, so the hook never learns which one granted its token', () => {
  const repo = tmpRepo();
  const t1 = runCli(repo, ['acquire', '--label', 'tier1']).stdout.trim();
  const t2 = runCli(repo, [
    'acquire',
    '--label',
    'tier2',
    '--timeout-sec',
    '1',
    '--poll-sec',
    '1',
  ]).stdout.trim();
  // The SAME single-argument release call the hook makes — here it frees the overflow entry.
  const rel = runCli(repo, ['release', '--token', t2]);
  assert.equal(rel.status, 0);
  assert.match(rel.stderr, /released \(overflow\)/);
  assert.equal(existsSync(join(repo, '.git', LOCK_TIERS.overflow)), false);
  assert.equal(existsSync(join(repo, '.git', LOCK_TIERS.serialized)), true);
  assert.equal(runCli(repo, ['release', '--token', t1]).status, 0);
  assert.equal(existsSync(join(repo, '.git', LOCK_TIERS.serialized)), false);
});

test('CLI acquire: a >stale-min lock entry is reaped and the waiter takes it', () => {
  const repo = tmpRepo();
  const lockPath = join(repo, '.git', 'battery-lock.json');
  const old = new Date(Date.now() - (DEFAULT_STALE_MIN + 5) * 60000).toISOString();
  writeFileSync(
    lockPath,
    JSON.stringify({ token: 'dead', label: 'crashed', iso: old, pid: 1, host: 'h' }),
  );

  const out = runCli(repo, ['acquire', '--timeout-sec', '5']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /reaped/);
  assert.notEqual(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'dead');
});

test('CLI acquire: a same-host DEAD-holderPid lock is reaped immediately, dead-pid named (plan 2549)', () => {
  const repo = tmpRepo();
  const lockPath = join(repo, '.git', 'battery-lock.json');
  // A provably-dead pid: spawn a real process, let it exit synchronously, use its pid. (The
  // residual pid-reuse window between exit and probe is the design's benign direction anyway.)
  const deadPid = spawnSync(process.execPath, ['-e', ''], { env: cleanGitEnv() }).pid;
  writeFileSync(
    lockPath,
    JSON.stringify({
      token: 'orphan',
      label: 'crashed-hook',
      iso: new Date().toISOString(), // FRESH — age alone would make the waiter wait out its timeout
      pid: 1,
      host: hostname(),
      holderPid: deadPid,
    }),
  );
  const out = runCli(repo, ['acquire', '--timeout-sec', '5']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /reaped .*crashed-hook.*dead-pid/);
  assert.notEqual(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'orphan');
});

test('CLI acquire: --holder-pid of a LIVE process blocks a waiter for its full timeout (negative control)', () => {
  const repo = tmpRepo();
  // process.pid here is THIS test-runner node — alive for the whole test, and same host. The
  // waiter must get BUSY → EXIT_TIMEOUT, exactly the pre-2549 contract, never an early reap.
  const held = runCli(repo, ['acquire', '--holder-pid', String(process.pid)]);
  assert.equal(held.status, 0, held.stderr);
  const lock = JSON.parse(readFileSync(join(repo, '.git', 'battery-lock.json'), 'utf8'));
  assert.equal(lock.holderPid, process.pid);
  const out = runCli(repo, ['acquire', '--timeout-sec', '1', '--poll-sec', '1']);
  assert.equal(out.status, EXIT_TIMEOUT, out.stderr);
});

test('CLI acquire: a malformed --holder-pid exits EXIT_ERROR loudly (fail-safe: unserialized run)', () => {
  const repo = tmpRepo();
  const out = runCli(repo, ['acquire', '--holder-pid', 'abc']);
  assert.equal(out.status, EXIT_ERROR);
  assert.match(out.stderr, /holder-pid/);
});

test('plan 2549: the hook declares its own long-lived shell pid via --holder-pid, winpid-translated', () => {
  // Without this wiring the liveness reap silently never fires (an undeclared entry is age-only
  // by design), so the hook text is pinned here — the DEFAULT_STALE_MIN derivation pattern. The
  // winpid translation is load-bearing: on Git-for-Windows sh, `$$` is an MSYS-namespace pid that
  // process.kill cannot probe, and probing it could read a LIVE holder as DEAD — the one error
  // direction the design forbids.
  // plan 3963: scripts/hooks/pre-push.sh is now a thin dispatcher — the scripts-battery gate
  // text every `scriptFile('hooks/pre-push-core.sh', …)` read in this file pins now lives in
  // the GENERIC half of the split, pre-push-core.sh (the battery lock/gate is coordination
  // infra, not a vetapp product concern). Every occurrence below was repointed the same way.
  const hookText = readFileSync(scriptFile('hooks/pre-push-core.sh', import.meta.dirname), 'utf8');
  assert.match(
    hookText,
    /BATTERY_HOLDER_PID=\$\(cat \/proc\/\$\$\/winpid 2>\/dev\/null \|\| true\)/,
    'the hook no longer winpid-translates the holder pid — see battery-lock.mjs header (plan 2549)',
  );
  // The flag is passed ONLY when a pid was resolved (plan-2734 review): `${VAR:+ --holder-pid $VAR}`.
  // A bare `--holder-pid $BATTERY_HOLDER_PID` would emit the flag with an EMPTY value on the MSYS
  // no-winpid path, and an unconditional `|| echo $$` fallback would hand over an MSYS pid that can
  // collide with a live unrelated Windows pid — passing battery-lock's self-check and letting a
  // waiter reap this lock the moment that stranger exits.
  assert.match(
    hookText,
    /BATTERY_ACQUIRE_ARGS="--label prepush-\$\$\$\{BATTERY_HOLDER_PID:\+ --holder-pid \$BATTERY_HOLDER_PID\}"/,
    'the hook no longer passes --holder-pid conditionally — see the plan-2734 review note above it',
  );
  // The fallback must be an ALLOWLIST of platforms where `$$` is probeable, with everything else
  // (MSYS, Cygwin, an unknown or failed uname) declaring nothing. A denylist keyed on `$OSTYPE` was
  // the first cut and was wrong twice over (review round 4): OSTYPE is a bash-ism and this file
  // declares `#!/usr/bin/env sh`, so under dash it is unset and falls through to the `$$` branch on
  // the one platform that branch must never run on.
  assert.match(
    hookText,
    /case "\$\(uname -s 2>\/dev\/null\)" in/,
    'the holder-pid fallback no longer detects the platform with uname — see the note above it',
  );
  // A DENYLIST of the Windows-emulation platforms (plus an unusable uname), not an allowlist of
  // named Unixes: MSYS and Cygwin both self-identify, so the denylist declines exactly where `$$`
  // is unprobeable and leaves every other real Unix (Solaris, AIX) with its fast reap.
  assert.match(
    hookText,
    /MINGW\* \| MSYS\* \| CYGWIN\* \| ''\) BATTERY_HOLDER_PID="" ;;/,
    'the holder-pid fallback no longer declines on MSYS/Cygwin — an untranslated `$$` reaches the lock',
  );
  assert.match(
    hookText,
    /\*\) BATTERY_HOLDER_PID=\$\$ ;;/,
    'the $$ fallback no longer covers non-Windows platforms — they lose the dead-holder fast reap',
  );
  // The EXPANSION, not the word — the comment above the fix names OSTYPE to explain why it is gone.
  assert.doesNotMatch(
    hookText,
    /\$\{?OSTYPE/,
    'OSTYPE is a bash-ism and this hook declares `#!/usr/bin/env sh` — under dash it is unset',
  );
});

test('CLI release: a foreign token never unlinks, and still exits 0 (close-out never blocks a push)', () => {
  const repo = tmpRepo();
  const token = runCli(repo, ['acquire']).stdout.trim();
  const out = runCli(repo, ['release', '--token', 'not-the-token']);
  assert.equal(out.status, 0);
  assert.match(out.stderr, /NOT releasing/);
  assert.equal(existsSync(join(repo, '.git', 'battery-lock.json')), true);
  assert.equal(runCli(repo, ['release', '--token', token]).status, 0);
});

test('CLI: unknown command exits EXIT_ERROR, not 0', () => {
  assert.equal(runCli(tmpRepo(), ['frobnicate']).status, EXIT_ERROR);
});

test('two CONCURRENT acquires: exactly one wins, the other is told to proceed unserialized', async () => {
  const repo = tmpRepo();
  const launch = () =>
    new Promise((res) => {
      const c = spawn(process.execPath, [CLI, 'acquire', '--timeout-sec', '2', '--poll-sec', '1'], {
        cwd: repo,
        env: cleanGitEnv(),
      });
      let stdout = '';
      c.stdout.on('data', (d) => (stdout += d));
      c.on('close', (status) => res({ status, stdout: stdout.trim() }));
    });

  const [a, b] = await Promise.all([launch(), launch()]);
  const winners = [a, b].filter((r) => r.status === 0);
  assert.equal(winners.length, 1, `expected exactly one winner, got ${JSON.stringify([a, b])}`);
  assert.equal([a, b].filter((r) => r.status === EXIT_TIMEOUT).length, 1);
  // The battery never runs twice at once — and the loser still runs it, just unserialized.
  assert.equal(
    JSON.parse(readFileSync(join(repo, '.git', 'battery-lock.json'), 'utf8')).token,
    winners[0].stdout,
  );
});

test('CLI acquire: a non-numeric --timeout-sec EXITs rather than spinning forever', () => {
  const repo = tmpRepo();
  runCli(repo, ['acquire']); // hold it, so the waiter would otherwise loop
  const out = runCli(repo, ['acquire', '--timeout-sec', '5m']);
  // Fail-safe direction: a lock ERROR is non-zero, so the hook runs the battery unserialized.
  // The bug it replaces was an infinite poll loop that hung the whole `git push`.
  assert.equal(out.status, EXIT_ERROR);
  assert.match(out.stderr, /must be a non-negative number/);
});

test('DEFAULT_STALE_MIN exceeds the worst-case battery runtime it guards', () => {
  // The worst case is DERIVED FROM THE REAL HOOK TEXT, not hand-copied (a round-6 review
  // find: three hand-maintained copies of this number had already drifted). Per attempt
  // the battery is bounded by max(wrapper backstop deadline, inner timeout cap +
  // kill-after grace), and the hook's retry-once loop (plan 984) can run it twice — a
  // still-LIVE (double-wedged, not crashed) run can hold the lock that long. A ceiling
  // inside that window makes a waiter reap a LIVE battery and start a second one — the
  // exact concurrency bug this lock exists to prevent. A future cap raise in the hook
  // now fails HERE unless DEFAULT_STALE_MIN keeps clearing it.
  const hookText = readFileSync(scriptFile('hooks/pre-push-core.sh', import.meta.dirname), 'utf8');
  // plan 1715: the battery's layered bound is now the shared run_bounded() — derive the three
  // numbers from BOTH the battery's own cap and run_bounded's definition (the kill-after grace +
  // the +N wrapper-deadline offset it adds to the cap). plan 1795: the cap is no longer a literal
  // in the invocation — it is the $BATTERY_CAP variable (1200s normal, a LARGER cap on the
  // reduced-parallelism overflow path, where a clamped full-glob run is slow by design). A
  // still-LIVE double-wedged holder can run two attempts at the LARGEST cap, so the worst case
  // derives from max over every BATTERY_CAP assignment in the hook.
  // plan 2176: the invocation moved into the shared run_battery_with_retry() function, which
  // takes the cap as a PARAMETER — so the chain is now two links and both are pinned here: the
  // function bounds `node --test` by its own $_rbr_cap argument, and the scripts battery's call
  // site passes $BATTERY_CAP into it. A refactor that broke either link would silently decouple
  // this stale-ceiling derivation from the cap the battery actually runs under.
  // plan 2875: the invocation gained explicit `--test-reporter` pairs (spec to stdout, tap to a
  // dedicated harvest file — see the hook's own comment for why node's default could not be
  // relied on). Those flags are irrelevant to THIS derivation, which only cares that
  // run_bounded still bounds `node --test` by $_rbr_cap and still passes the conc args + file
  // list. The `.*` sits BETWEEN two pinned anchors and spans only the reporter flags — it is
  // deliberately not a loosening of what this assertion proves: drop either anchor and the
  // stale-ceiling derivation silently decouples from the cap the battery actually runs under,
  // which is the failure this pin exists to catch.
  assert.match(
    hookText,
    /run_bounded "\$_rbr_cap" node --test .*\$_rbr_conc "\$@"/,
    'run_battery_with_retry run_bounded invocation not found — update this derivation to the new shape',
  );
  assert.match(
    hookText,
    /run_battery_with_retry "scripts" "\$BATTERY_CAP" "\$BATTERY_CONC_ARGS" \$BATTERY_FILES/,
    'battery call site no longer passes $BATTERY_CAP — update this derivation to the new shape',
  );
  const caps = [...hookText.matchAll(/^\s*BATTERY_CAP=(\d+)$/gm)].map((m) => Number(m[1]));
  assert.ok(
    caps.length >= 2,
    `expected the normal + overflow BATTERY_CAP assignments in the hook, found ${caps.length} — ` +
      'update this derivation to the new shape',
  );
  const innerCap = Math.max(...caps);
  const defM =
    /-File "\$PP_WRAPPER" \$\(\(_rb_cap \+ (\d+)\)\) timeout --kill-after=(\d+) "\$_rb_cap"/.exec(
      hookText,
    );
  assert.ok(
    defM,
    "run_bounded's wrapper-outermost definition not found — update this derivation to the new shape",
  );
  const wrapperDeadline = innerCap + Number(defM[1]);
  const killAfter = Number(defM[2]);
  const worstCaseMin = Math.ceil((2 * Math.max(wrapperDeadline, innerCap + killAfter)) / 60);
  assert.ok(
    DEFAULT_STALE_MIN > worstCaseMin,
    `stale ceiling ${DEFAULT_STALE_MIN}m must exceed the hook-derived double-attempt worst case (${worstCaseMin}m)`,
  );
  // plan 2734: the bound a waiter can actually reach is now the anti-hang TOTAL-wait ceiling —
  // patience is PER HOLDER and resets on handover, so it is not itself an upper bound on the wait.
  assert.ok(
    DEFAULT_STALE_MIN * 60 > MAX_TOTAL_WAIT_SEC,
    'a waiter must give up long before it may reap',
  );
});

test('plan 1795: the hook overflow branch keys on EXIT_TIMEOUT and mirrors OVERFLOW_TEST_CONCURRENCY', () => {
  // A sh hook cannot import a JS constant, so .husky/pre-push hardcodes both the exit code it
  // branches on and the --test-concurrency clamp. This derivation reads the REAL hook text (the
  // DEFAULT_STALE_MIN pattern above) so a drift in either literal fails HERE, loudly.
  const hookText = readFileSync(scriptFile('hooks/pre-push-core.sh', import.meta.dirname), 'utf8');
  // The clamp fires ONLY on the distinct queue-wait-expiry code — exit 5 (a lock ERROR) is not a
  // load signal and must keep the full-parallelism unserialized run.
  assert.match(
    hookText,
    new RegExp(`\\[ "\\$BATTERY_ACQ_STATUS" = ${EXIT_TIMEOUT} \\]`),
    `the hook no longer branches its overflow clamp on EXIT_TIMEOUT (${EXIT_TIMEOUT}) — ` +
      'the reduced-parallelism path must key on the queue-wait-expiry code, not any non-zero',
  );
  const clampM = /BATTERY_CONC_ARGS="--test-concurrency=(\d+)"/.exec(hookText);
  assert.ok(clampM, 'the hook no longer sets the overflow --test-concurrency clamp');
  assert.equal(
    Number(clampM[1]),
    OVERFLOW_TEST_CONCURRENCY,
    'the hook clamp literal drifted from OVERFLOW_TEST_CONCURRENCY (battery-lock.mjs is canonical)',
  );
});

// ── plan 2734: the progress-aware wait + two-tier admission ──────────────────────────────────
// The invariant these defend: a waiter gives up because the HOLDER IS STUCK, never because the
// holder is slow — and giving up does not mean running immediately, it means being ADMITTED.

test('plan 2734: holderAgeSec/holderStuck — null-safe, and a null age is NOT stuck', () => {
  const now = at(0);
  assert.equal(holderAgeSec(null, now), null); // no entry at all
  assert.equal(holderAgeSec({ token: 't' }, now), null); // no iso
  assert.equal(holderAgeSec({ token: 't', iso: 'not-a-date' }, now), null);
  assert.equal(holderAgeSec({ token: 't', iso: ISO }, at(2)), 120);

  // A null age must NOT read as 0 (a brand-new holder) and must NOT read as stuck: an entry with no
  // readable timestamp is already reapable via isStale, and classifying it here too would race that
  // reap — two code paths acting on one corrupt entry.
  assert.equal(holderStuck(null, now, 1), false);
  assert.equal(holderStuck({ token: 't', iso: 'garbage' }, now, 1), false);
  assert.equal(isStale({ token: 't', iso: 'garbage' }, now), true, 'the reap path owns that entry');

  // Strictly greater-than at the boundary, so patience N means "N seconds are still allowed".
  assert.equal(holderStuck({ token: 't', iso: ISO }, at(1), 60), false);
  assert.equal(holderStuck({ token: 't', iso: ISO }, at(1) + 1000, 60), true);
});

test('plan 2734: decideWaitStep — WAIT while the holder progresses, ADMIT when stuck or at the ceiling', () => {
  const now = at(10);
  const young = { token: 'h', iso: new Date(now - 5000).toISOString() };
  const ancient = { token: 'h', iso: new Date(now - 4_000_000).toISOString() };
  const base = { nowMs: now, waitStartedMs: now - 5000 };

  assert.equal(decideWaitStep({ ...base, entry: young }), 'WAIT');
  assert.equal(decideWaitStep({ ...base, entry: ancient }), 'ADMIT-STUCK');
  // A young holder + an expired TOTAL wait is the churn case: the queue kept moving and handed over,
  // so nobody is stuck, but the waiter must not hang forever.
  assert.equal(
    decideWaitStep({
      entry: young,
      nowMs: now,
      waitStartedMs: now - (MAX_TOTAL_WAIT_SEC + 1) * 1000,
    }),
    'ADMIT-CEILING',
  );
  // Once in admission, the only remaining transition is out of it — and only on ITS window.
  assert.equal(
    decideWaitStep({ ...base, entry: ancient, admissionStartedMs: now - 1000 }),
    'WAIT',
    'admission must not re-fire the stuck verdict it was entered on',
  );
  assert.equal(
    decideWaitStep({
      ...base,
      entry: young,
      admissionStartedMs: now - (ADMISSION_WAIT_SEC + 1) * 1000,
    }),
    'UNADMITTED',
  );
});

test('plan 2734: a HANDOVER resets patience by construction — a slow convoy is waited out, not stampeded', () => {
  // The whole point of keying on the HOLDER'S age rather than the waiter's: each handover writes a
  // fresh iso, so a waiter behind a moving queue never reaches the stuck verdict. Simulated as three
  // successive holders, each of them individually healthy, spanning far more than one patience
  // window in total.
  const patience = 100;
  let nowMs = at(0);
  const waitStartedMs = nowMs;
  for (const holderStartedMs of [nowMs, nowMs + 90_000, nowMs + 180_000]) {
    nowMs = holderStartedMs + 90_000; // this holder is 90s old: under patience, still healthy
    const step = decideWaitStep({
      entry: { token: 'h', iso: new Date(holderStartedMs).toISOString() },
      nowMs,
      waitStartedMs,
      patienceSec: patience,
      maxTotalWaitSec: 10_000, // ceiling deliberately out of reach: isolate the patience axis
    });
    assert.equal(step, 'WAIT', `handover at ${holderStartedMs} must not read as stuck`);
  }
  assert.ok(
    nowMs - waitStartedMs > patience * 1000,
    'the total wait did exceed one patience window',
  );
});

test('plan 2734: the wait constants derive from the measured base numbers, not hand-typed literals', () => {
  // A future edit that "rounds" one of these must fail HERE rather than silently re-opening the
  // plan-1679 bug (a cap BELOW a healthy loaded battery, which fires on healthy runs).
  assert.equal(LOADED_BATTERY_SEC, Math.ceil(BATTERY_P95_SEC * LOAD_MULTIPLIER));
  // Patience is deliberately NOT LOADED_BATTERY_SEC * 2 any more (plan-2734 review, 2026-08-02): an
  // average-based threshold cannot bound a worst case, and the first cut's 2218s sat BELOW the hook's
  // own two-attempt bound, so it fired on HEALTHY holders — this plan's own defect at a higher
  // number. The binding relationship is pinned against the real hook text in its own test below.
  assert.equal(MAX_TOTAL_WAIT_SEC, HOLDER_PATIENCE_SEC + LOADED_BATTERY_SEC);
  // The property that actually matters: patience must outlast a HEALTHY loaded battery, or the
  // give-up test fires on slow-but-fine holders — which is the entire defect plan 2734 fixes.
  assert.ok(
    HOLDER_PATIENCE_SEC > LOADED_BATTERY_SEC,
    'patience must exceed one loaded battery run or it fires on healthy holders',
  );
  assert.ok(
    MAX_TOTAL_WAIT_SEC > HOLDER_PATIENCE_SEC,
    'the ceiling must be reachable after patience',
  );
});

test('plan 2734: the admission window never exceeds the caller own total-wait ceiling', () => {
  // plan 1679's size-gated `--timeout-sec 30` (a <=5-file selection, explicitly not the load
  // problem) must not inherit the full admission window and turn a 30s wait into a 330s one.
  assert.equal(effectiveAdmissionWaitSec(30), 30);
  assert.equal(effectiveAdmissionWaitSec(MAX_TOTAL_WAIT_SEC), ADMISSION_WAIT_SEC);
  assert.equal(effectiveAdmissionWaitSec(ADMISSION_WAIT_SEC), ADMISSION_WAIT_SEC);
  // An EXPLICIT window is clamped by the same rule, not just the default (review finding: a caller
  // passing `--timeout-sec 30 --admission-wait-sec 300` really did wait ~330s, contradicting the
  // documented bound). "Total wait <= ceiling + one admission window" must hold for every flag combo.
  assert.equal(effectiveAdmissionWaitSec(30, 300), 30);
  assert.equal(effectiveAdmissionWaitSec(600, 45), 45);
});

test('plan 2734: resolveLockPath is tier-addressed, and an unknown tier THROWS (never silently tier 1)', () => {
  assert.equal(
    resolveLockPath({ tier: 'serialized', _exec: () => '/r/.git\n', _path: posix }),
    '/r/.git/' + LOCK_TIERS.serialized,
  );
  assert.equal(
    resolveLockPath({ tier: 'overflow', _exec: () => '/r/.git\n', _path: posix }),
    '/r/.git/' + LOCK_TIERS.overflow,
  );
  assert.notEqual(LOCK_TIERS.serialized, LOCK_TIERS.overflow);
  // A typo must not resolve to the serialized lock: an overflow acquire contending on tier 1 would
  // silently delete the admission control this plan exists to add.
  assert.throws(
    () => resolveLockPath({ tier: 'overfow', _exec: () => '/r/.git\n', _path: posix }),
    /unknown lock tier/,
  );
  // Prototype keys must not be mistaken for tiers (hasOwnProperty, not a bare lookup).
  assert.throws(() => resolveLockPath({ tier: 'constructor' }), /unknown lock tier/);
});

test('plan 2734: a waiter behind a PROGRESSING holder does not bypass — proven by it still running', async () => {
  // The acceptance criterion in its integration form: with a live, young holder and the real
  // defaults, no waiter may exit to run unserialized. Bounded and non-flaky in the direction that
  // matters — the only way this child can exit inside the window is the bug coming back (default
  // patience is 2218s and the default ceiling 3327s, so a correct waiter CANNOT be done in 3s).
  const repo = tmpRepo();
  assert.equal(runCli(repo, ['acquire', '--label', 'healthy-holder']).status, 0);
  const child = spawn(process.execPath, [CLI, 'acquire', '--poll-sec', '1'], {
    cwd: repo,
    env: cleanGitEnv(),
  });
  let exited = null;
  child.on('close', (code) => (exited = code));
  await new Promise((r) => setTimeout(r, 3000));
  const stillWaiting = exited === null;
  child.kill('SIGKILL');
  assert.equal(
    stillWaiting,
    true,
    `the waiter exited ${exited} while the holder was young — the flat-timer bypass is back`,
  );
  // And it never took the overflow slot either: admission is only reachable past the give-up test.
  assert.equal(existsSync(join(repo, '.git', LOCK_TIERS.overflow)), false);
});

test('plan 2734 arm D: the hook re-runs an UNSERIALIZED battery under the lock when it can', () => {
  // A sh hook cannot import a JS constant, so these wirings are derived from the REAL hook text
  // (the DEFAULT_STALE_MIN pattern). Each assertion pins one thing that would silently stop working.
  const hookText = readFileSync(scriptFile('hooks/pre-push-core.sh', import.meta.dirname), 'utf8');

  // 1. The re-run acquire exists, is opt-in, and only fires after attempt 1.
  assert.match(
    hookText,
    /\[ "\$\{RBR_RERUN_LOCK:-0\}" = 1 \] && \[ "\$_rbr_attempt" = 1 \]/,
    'the re-run lock attempt is no longer gated on RBR_RERUN_LOCK + attempt 1',
  );
  // 2. It is armed ONLY on the unserialized path, i.e. inside the EXIT_TIMEOUT branch.
  const exit4Branch = hookText.slice(
    hookText.indexOf(`[ "$BATTERY_ACQ_STATUS" = ${EXIT_TIMEOUT} ]`),
  );
  // Compared against the CALL SITE literal, not the bare function name — the arming line's own
  // comment names the function, so a bare-name search finds the comment first and the ordering
  // check becomes vacuous (caught by this test failing on its first cut).
  assert.ok(
    exit4Branch.indexOf('RBR_RERUN_LOCK=1') > -1 &&
      exit4Branch.indexOf('RBR_RERUN_LOCK=1') <
        exit4Branch.indexOf('run_battery_with_retry "scripts"'),
    'RBR_RERUN_LOCK=1 must be set inside the EXIT_TIMEOUT branch, before the battery runs',
  );
  // 3. It is DISARMED after the battery gate, or it would leak into the data-dependency gate's own
  //    call to the same shared function (whose behaviour must stay byte-identical).
  assert.match(
    hookText,
    /run_battery_with_retry "scripts"[\s\S]{0,900}?^\s*RBR_RERUN_LOCK=0$/m,
    'RBR_RERUN_LOCK is not reset after the scripts battery — it would arm the next gate too',
  );
  // 4. An exit-4 acquire's token is KEPT and released. Blanking it (the pre-2734 shape) would leak
  //    the overflow slot until its reap and silently re-open the admission control.
  assert.match(
    hookText,
    /for BATTERY_RELEASE_TOKEN in "\$BATTERY_TOKEN" "\$RUN_BATTERY_RERUN_TOKEN"/,
    'the hook no longer releases both outstanding tokens',
  );
  assert.equal(
    /\[ "\$BATTERY_ACQ_STATUS" = 4 \][\s\S]{0,400}?BATTERY_TOKEN=""/.test(hookText),
    false,
    'the hook still blanks BATTERY_TOKEN on exit 4 — an admitted overflow slot would leak',
  );
});

// ── plan 2734: the declared-holder-pid SELF-CHECK ─────────────────────────────────────────────
// The hole this closes: the dead-holder fast reap rests on "a probe can never produce a false DEAD",
// which is true only while the declared pid is in `process.kill`'s namespace. A raw Git Bash `$$` on
// Windows is a valid positive integer that does not exist to process.kill → ESRCH → "provably dead"
// → the next waiter reaps a LIVE holder and the concurrent-battery herd returns. Prose alone did not
// hold the line (a plan-2734 scratch test tripped it minutes after the warning was read), so the
// precondition is now enforced at declaration time.

test('plan 2734: holderPidTrustworthy refuses ONLY a provably-dead declaration', () => {
  // The declared holder is the process blocked on this acquire, so "provably dead" cannot mean the
  // holder died — it means the pid is not the holder's. That is the one verdict worth refusing.
  assert.equal(holderPidTrustworthy(123, { _pidAlive: () => false }), false);
  assert.equal(holderPidTrustworthy(123, { _pidAlive: () => true }), true);
  // null = unprovable (EPERM under another user, or a non-numeric pid): recording it is harmless
  // because the probe at REAP time degrades to the age gate anyway, and refusing it would drop a
  // legitimate declaration on a hardened host.
  assert.equal(holderPidTrustworthy(123, { _pidAlive: () => null }), true);
});

test('plan 2734: a WRONG-namespace --holder-pid degrades to age-only instead of poisoning the lock', () => {
  const repo = tmpRepo();
  // A provably-dead pid stands in for the real trap (an MSYS `$$` that process.kill cannot see):
  // spawn a process, let it exit, reuse its pid — the same technique the plan-2549 reap test uses.
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.ok(dead.pid > 0);

  const out = runCli(repo, ['acquire', '--label', 'holder', '--holder-pid', String(dead.pid)]);
  // The push must NOT fail for a bad declaration — a lock hint is never worth blocking a push over.
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /IGNORING --holder-pid/);
  assert.match(out.stderr, /MSYS-namespace pid/); // names the actual cause, not just "invalid"
  assert.match(out.stderr, /AGE-ONLY/);

  // The field is DROPPED, so the entry is byte-shaped exactly like a pre-2549 undeclaring caller's.
  const lockPath = join(repo, '.git', LOCK_TIERS.serialized);
  const entry = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal('holderPid' in entry, false, 'a refused declaration must not be recorded at all');
  assert.equal(entry.label, 'holder');

  // THE BEHAVIOURAL PROOF, and the whole point of the guard: a waiter must NOT instantly reap this
  // fresh lock. Before the guard, the poisoned pid made the very next acquire reap a LIVE holder.
  const waiter = runCli(repo, [
    'acquire',
    '--timeout-sec',
    '1',
    '--poll-sec',
    '1',
    '--admission-wait-sec',
    '1',
  ]);
  assert.equal(waiter.status, EXIT_TIMEOUT, waiter.stderr);
  assert.doesNotMatch(waiter.stderr, /reaped/);
  assert.equal(
    JSON.parse(readFileSync(lockPath, 'utf8')).label,
    'holder',
    'the live holder must still own the serialized lock',
  );
});

test('plan 2734: a LIVE --holder-pid is still recorded — the guard must not over-reach', () => {
  // Negative control: the guard may only ever refuse the provably-dead case. Our own pid is alive by
  // definition, so it must be recorded and the plan-2549 fast reap must stay armed.
  const repo = tmpRepo();
  const out = runCli(repo, ['acquire', '--label', 'holder', '--holder-pid', String(process.pid)]);
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stderr, /IGNORING --holder-pid/);
  const entry = JSON.parse(readFileSync(join(repo, '.git', LOCK_TIERS.serialized), 'utf8'));
  assert.equal(entry.holderPid, process.pid);
});

// ── plan 2734 review follow-ups (2026-08-02) ─────────────────────────────────────────────────
// Two finders independently caught the same real defect: the first cut derived patience from a
// cross-suite LOAD AVERAGE (2218s) while a healthy tier-1 holder is bounded by the HOOK at 2x1500s.
// A give-up test below the holder's legitimate maximum fires on healthy holders — the exact defect
// this plan set out to fix, merely at a higher threshold. Pin the relationship, not the number.

test('plan 2734: HOLDER_PATIENCE_SEC clears the hook-derived TIER-1 double-attempt bound', () => {
  const hookText = readFileSync(scriptFile('hooks/pre-push-core.sh', import.meta.dirname), 'utf8');
  // The NORMAL (unclamped) per-attempt cap is what bounds a tier-1 holder: a clamped battery never
  // holds tier 1 — running unserialized is what earned it the clamp — so the larger overflow cap is
  // deliberately excluded here. That is the one difference from DEFAULT_STALE_MIN's derivation above,
  // which must cover the WORST case across every path and therefore takes the max.
  const caps = [...hookText.matchAll(/^\s*BATTERY_CAP=(\d+)$/gm)].map((m) => Number(m[1]));
  assert.ok(
    caps.length >= 2,
    `expected the normal + overflow BATTERY_CAP assignments, got ${caps}`,
  );
  const normalCap = Math.min(...caps);
  const defM =
    /-File "\$PP_WRAPPER" \$\(\(_rb_cap \+ (\d+)\)\) timeout --kill-after=(\d+) "\$_rb_cap"/.exec(
      hookText,
    );
  assert.ok(defM, "run_bounded's wrapper-outermost definition not found — update this derivation");
  const perAttempt = Math.max(normalCap + Number(defM[1]), normalCap + Number(defM[2]));
  const tier1Bound = 2 * perAttempt; // plan 984 retry-once, both attempts inside ONE acquire
  assert.ok(
    HOLDER_PATIENCE_SEC >= tier1Bound,
    `patience ${HOLDER_PATIENCE_SEC}s must clear the hook-derived tier-1 bound (${tier1Bound}s), or a ` +
      'HEALTHY two-attempt holder is declared stuck and a second battery is admitted beside it',
  );
  // And the ceiling must still sit under the reap ceiling, or a waiter could outlive its own lock.
  assert.ok(DEFAULT_STALE_MIN * 60 > MAX_TOTAL_WAIT_SEC);
});

test('plan 2734: an explicit --admission-wait-sec cannot exceed the total-wait ceiling', () => {
  // End-to-end proof of the clamp fix: 1s ceiling + a 300s explicit window must NOT wait ~301s.
  const repo = tmpRepo();
  assert.equal(runCli(repo, ['acquire', '--label', 'tier1']).status, 0);
  assert.equal(
    runCli(repo, ['acquire', '--label', 'tier2', '--timeout-sec', '1', '--poll-sec', '1']).status,
    EXIT_TIMEOUT,
  ); // takes the overflow slot, so the next waiter must reach the UNADMITTED path
  const started = Date.now();
  const out = runCli(repo, [
    'acquire',
    '--label',
    'tier3',
    '--timeout-sec',
    '1',
    '--poll-sec',
    '1',
    '--admission-wait-sec',
    '300',
  ]);
  const elapsedSec = (Date.now() - started) / 1000;
  assert.equal(out.status, EXIT_TIMEOUT);
  assert.ok(
    // ambient-load-ok: duration is the ONLY thing that discriminates here, so this ceiling is the
    // functional proof and cannot be replaced by an exit-code check. An UNCLAMPED run reaches the
    // same EXIT_TIMEOUT the assertion above pins — it just gets there after ~300s instead of ~1s —
    // so status proves the timeout path ran, never that the 300s window was clamped to the 1s
    // ceiling. (An earlier revision of this comment claimed status alone proved the clamp; review
    // finding 62167c showed that is false.) 60s is chosen to sit ~60x above the 1s ceiling and ~5x
    // below the 300s window it must reject, which is the widest margin the two bounds allow.
    elapsedSec < 60,
    `an explicit 300s admission window under a 1s ceiling must be clamped, waited ${elapsedSec}s`,
  );
});

test('plan 2734: resolveTierPaths resolves the common dir ONCE for both tiers', () => {
  // Review finding: resolveLockPath per tier spawned a `git rev-parse --git-common-dir` per tier on
  // every acquire/status/release. Counting the injected exec calls is the drift-proof assertion —
  // an added tier must not add a spawn.
  let execCalls = 0;
  const paths = resolveTierPaths({
    _exec: () => {
      execCalls++;
      return '/r/.git\n';
    },
    _path: posix,
  });
  assert.equal(execCalls, 1, 'both tier paths must come from ONE common-dir resolution');
  assert.deepEqual(paths, {
    serialized: '/r/.git/' + LOCK_TIERS.serialized,
    overflow: '/r/.git/' + LOCK_TIERS.overflow,
  });
  // Same answers as the per-tier helper, so the two cannot drift apart.
  for (const tier of Object.keys(LOCK_TIERS)) {
    assert.equal(paths[tier], resolveLockPath({ tier, _exec: () => '/r/.git\n', _path: posix }));
  }
});

test('plan 2734: the hook bounds its re-run lock attempt tightly (review finding)', () => {
  // The win case costs nothing (tier 1 is taken on the first poll if free), so the wait exists only
  // to lose slowly. A 120s ceiling that inherited a 120s admission window could poll ~240s before
  // re-running a battery that had ALREADY failed once. Pin both flags.
  const hookText = readFileSync(scriptFile('hooks/pre-push-core.sh', import.meta.dirname), 'utf8');
  const m = /--timeout-sec "\$\{RBR_RERUN_LOCK_WAIT_SEC:-(\d+)\}" --admission-wait-sec (\d+)/.exec(
    hookText,
  );
  assert.ok(m, 'the re-run acquire no longer passes a bounded ceiling + admission window');
  const [ceiling, admission] = [Number(m[1]), Number(m[2])];
  assert.ok(
    ceiling + admission <= 60,
    `the re-run must not stall a failing push: ${ceiling}s + ${admission}s exceeds the 60s budget`,
  );
});

// ── plan 2734 second review round (2026-08-02) ────────────────────────────────────────────────
// Three footguns the correctly-scoped review surfaced in this branch's own diff.

test('plan 2734: patience clears the hook bound WITH margin for what the two attempts exclude', () => {
  // Round 1 pinned patience >= the hook's two-attempt bound. Round 2: covering it EXACTLY left zero
  // headroom for lock setup, per-attempt mktemp/tee plumbing, the TAP harvest between attempts, the
  // release, and OS scheduling delay on a saturated box — so a healthy holder could cross the
  // threshold on overhead alone, the same false-stuck verdict one step smaller.
  assert.ok(HOLDER_PATIENCE_MARGIN_SEC > 0, 'the margin must be real, not decorative');
  assert.equal(HOLDER_PATIENCE_SEC, 2 * (1200 + 300) + HOLDER_PATIENCE_MARGIN_SEC);
  const hookText = readFileSync(scriptFile('hooks/pre-push-core.sh', import.meta.dirname), 'utf8');
  const caps = [...hookText.matchAll(/^\s*BATTERY_CAP=(\d+)$/gm)].map((m) => Number(m[1]));
  const normalCap = Math.min(...caps);
  const defM =
    /-File "\$PP_WRAPPER" \$\(\(_rb_cap \+ (\d+)\)\) timeout --kill-after=(\d+) "\$_rb_cap"/.exec(
      hookText,
    );
  assert.ok(defM, "run_bounded's definition not found — update this derivation");
  const tier1Bound = 2 * Math.max(normalCap + Number(defM[1]), normalCap + Number(defM[2]));
  assert.ok(
    HOLDER_PATIENCE_SEC > tier1Bound,
    `patience ${HOLDER_PATIENCE_SEC}s must exceed the hook bound ${tier1Bound}s STRICTLY (margin for ` +
      'setup/teardown/scheduling), not merely equal it',
  );
});

test('plan 2734: --poll-sec 0 is refused instead of busy-spinning the queue wait', () => {
  // numericFlag cannot reject 0 (an explicit `--stale-min 0` is legitimate), so sleepSync(0) turned a
  // blocked wait into a filesystem-hammering spin — burning the CPU this lock exists to protect, on
  // the machine it protects. Fail-safe direction: EXIT_ERROR ⇒ the hook runs the battery unserialized.
  const repo = tmpRepo();
  runCli(repo, ['acquire', '--label', 'holder']); // hold it so a waiter would otherwise spin
  const out = runCli(repo, ['acquire', '--poll-sec', '0']);
  assert.equal(out.status, EXIT_ERROR);
  assert.match(out.stderr, /--poll-sec must be greater than 0/);
});

test('plan 2734: --tier is refused where it cannot be honoured, never silently ignored', () => {
  // `acquire --tier overflow` looks like a request for the bounded slot but used to hand back the
  // SERIALIZED lock at full parallelism — bypassing the very admission control it appears to ask for.
  const repo = tmpRepo();
  for (const cmd of ['acquire', 'status', 'release']) {
    const out = runCli(repo, [
      cmd,
      '--tier',
      'overflow',
      ...(cmd === 'release' ? ['--token', 'x'] : []),
    ]);
    assert.equal(out.status, EXIT_ERROR, `${cmd} --tier must be refused, got ${out.status}`);
    assert.match(out.stderr, /--tier is only valid for `path`/);
  }
  // `path` still honours it — that is the one command where addressing one tier is meaningful.
  const p = runCli(repo, ['path', '--tier', 'overflow']);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout.trim(), new RegExp(`[/\\\\]${LOCK_TIERS.overflow}$`));
  // A VALUELESS `--tier` slipped straight past the guard above (delta review): the parser stores
  // `undefined` under the key, `flags.tier != null` read that as "flag absent", and the malformed
  // request quietly printed the SERIALIZED path — the exact wrong-tier footgun this guard exists to
  // stop, reached by a typo instead of a mistake. Fixed HERE, not in the shared parser: parseFlags
  // deliberately sets the key so `Object.hasOwn` can tell absent from valueless, and a first cut
  // that made the parser throw for every caller broke that pinned contract (coord-git.test.mjs).
  const bare = runCli(repo, ['path', '--tier']);
  assert.equal(bare.status, EXIT_ERROR, `a valueless --tier must be refused, got ${bare.status}`);
  assert.match(bare.stderr, /--tier is missing its value \(end of arguments\)/);
  assert.doesNotMatch(bare.stdout, new RegExp(LOCK_TIERS.serialized));
});
