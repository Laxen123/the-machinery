// scripts/worktree-lock.test.mjs — unit tests for the worktree-scoped prep ⇄ land handshake
// (plan 2473).
//
// The invariant every case defends: TWO PROCESSES MUST NEVER REBASE ONE WORKING TREE. A prep child
// and the head-time land both `git rebase` + `git push --force-with-lease` the same branch, and an
// overlap risks an index.lock collision, corrupted rebase state, or one force-push silently losing
// to the other — a worktree needing manual recovery, in a repo with 5-7 concurrent sessions.
//
// Two properties get the most attention because they are the ones a naive lock gets wrong:
//   * A LIVE holder is never reaped (a `rm -f`-style lock would be worse than no lock — it would
//     grant the very concurrency it claims to prevent). Staleness is PID-PROVED first.
//   * A process that never held the lock can never release it (token ownership), so a head-time
//     land that timed out waiting cannot unlock a prep that is still running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostname } from 'node:os';
import {
  worktreeLockPath,
  pidAlive,
  parseWorktreeLockEntry,
  worktreeLockVerdict,
  acquireWorktreeLock,
  renewWorktreeLock,
  releaseWorktreeLock,
  readWorktreeLockEntry,
  worktreeLockIsLive,
  terminateWorktreeLockHolder,
  describeWorktreeLockHolder,
  WORKTREE_LOCK_MAX_HOLD_MS,
  // plan 4034 T1: the heartbeat cadence the land spine now actually holds this lock at.
  WORKTREE_LOCK_RENEW_MS,
  processStartToken,
  holderIdentity,
} from './worktree-lock.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'wtlock-'));
const lockIn = (dir) => worktreeLockPath(dir, '2473-Infra-x');

// ── the pure verdict ────────────────────────────────────────────────

test('verdict: FREE when nothing holds it', () => {
  assert.equal(worktreeLockVerdict(undefined, { nowMs: 0, alive: null }), 'FREE');
});

test('verdict: CORRUPT when the file is present but not a JSON object', () => {
  assert.equal(parseWorktreeLockEntry('not json'), null);
  assert.equal(parseWorktreeLockEntry('[1,2]'), null);
  assert.equal(worktreeLockVerdict(null, { nowMs: 0, alive: null }), 'CORRUPT');
});

test('verdict: a DEAD pid is STALE immediately — no waiting out the age ceiling', () => {
  // The crash case, and the whole reason this lock is pid-proved rather than age-only: a prep
  // child that died 2 seconds ago must not hold a land hostage for the 40-minute ceiling sized
  // for the gate battery.
  const entry = { pid: 4242, host: hostname(), heartbeatIso: new Date(1000).toISOString() };
  assert.equal(worktreeLockVerdict(entry, { nowMs: 2000, alive: false }), 'STALE');
});

test('verdict: a LIVE pid whose heartbeat is stale-but-inside-the-ceiling stays LIVE', () => {
  // runLandPrep blocks the event loop inside synchronous git/gate children for minutes, so a long
  // heartbeat gap is NORMAL for a healthy holder. Reaping on it would be the concurrency bug.
  const entry = { pid: 1, host: hostname(), heartbeatIso: new Date(0).toISOString() };
  const nowMs = WORKTREE_LOCK_MAX_HOLD_MS - 1;
  assert.equal(worktreeLockVerdict(entry, { nowMs, alive: true }), 'LIVE');
});

test('verdict: a LIVE pid past the hold ceiling is STALE (the wedged holder)', () => {
  const entry = { pid: 1, host: hostname(), heartbeatIso: new Date(0).toISOString() };
  const nowMs = WORKTREE_LOCK_MAX_HOLD_MS + 1;
  assert.equal(worktreeLockVerdict(entry, { nowMs, alive: true }), 'STALE');
});

test('verdict: an unprovable pid (foreign host) falls back to the age gate alone', () => {
  const entry = { pid: 9, host: 'some-other-box', heartbeatIso: new Date(0).toISOString() };
  assert.equal(worktreeLockVerdict(entry, { nowMs: 5, alive: null }), 'LIVE');
  assert.equal(
    worktreeLockVerdict(entry, { nowMs: WORKTREE_LOCK_MAX_HOLD_MS + 1, alive: null }),
    'STALE',
  );
});

test('verdict: an unreadable timestamp with no death proof fails CLOSED (LIVE)', () => {
  const entry = { pid: 1, host: hostname(), heartbeatIso: 'not-a-date' };
  assert.equal(worktreeLockVerdict(entry, { nowMs: 1e12, alive: true }), 'LIVE');
  // …but a proved-dead pid still wins over an unreadable stamp.
  assert.equal(worktreeLockVerdict(entry, { nowMs: 1e12, alive: false }), 'STALE');
});

test('pidAlive: this process is alive; a non-pid is unprovable (null)', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(undefined), null);
  assert.equal(pidAlive(0), null);
  assert.equal(pidAlive(-3), null);
  assert.equal(
    pidAlive(7, {
      _kill: () => {
        const e = new Error('no');
        e.code = 'ESRCH';
        throw e;
      },
    }),
    false,
  );
  // EPERM means the process EXISTS and belongs to another user — alive, never reapable.
  assert.equal(
    pidAlive(7, {
      _kill: () => {
        const e = new Error('no');
        e.code = 'EPERM';
        throw e;
      },
    }),
    true,
  );
  // Review 2549 [2]: ONLY a clean ESRCH proves death. Any other/unknown error shape (an exotic
  // process.kill failure under a sandboxed or restricted-token context) must fail toward ALIVE —
  // this predicate is reap-load-bearing (battery-lock's dead-holder reap), and its safety argument
  // is "a probe can never produce a false DEAD"; the age ceiling bounds a false alive.
  assert.equal(
    pidAlive(7, {
      _kill: () => {
        const e = new Error('weird');
        e.code = 'EUNKNOWN';
        throw e;
      },
    }),
    true,
  );
  assert.equal(
    pidAlive(7, {
      _kill: () => {
        throw new Error('codeless');
      },
    }),
    true,
  );
});

// ── acquire / renew / release against a real temp dir ───────────────

test('acquire: takes a free lock and writes an owner-tagged, pid-stamped record', () => {
  const path = lockIn(tmp());
  const r = acquireWorktreeLock(path, { owner: 'prep', slug: 's' });
  assert.equal(r.ok, true);
  assert.ok(r.token);
  const entry = readWorktreeLockEntry(path);
  assert.equal(entry.owner, 'prep');
  assert.equal(entry.slug, 's');
  assert.equal(entry.pid, process.pid);
  assert.equal(entry.host, hostname());
  assert.equal(entry.token, r.token);
});

test('acquire: REFUSES a live holder — the core mutual-exclusion property', () => {
  const path = lockIn(tmp());
  const first = acquireWorktreeLock(path, { owner: 'prep', slug: 's' });
  assert.equal(first.ok, true);
  // Same-process pid, so the holder is provably alive.
  const second = acquireWorktreeLock(path, { owner: 'land', slug: 's' });
  assert.equal(second.ok, false);
  assert.equal(second.verdict, 'LIVE');
  assert.equal(second.holder.owner, 'prep');
  // …and the refusal did NOT disturb the holder's record.
  assert.equal(readWorktreeLockEntry(path).token, first.token);
});

test('acquire: reaps a provably-dead holder and takes the lock', () => {
  const path = lockIn(tmp());
  writeFileSync(
    path,
    JSON.stringify({
      token: 'ghost',
      owner: 'prep',
      slug: 's',
      pid: 4242,
      host: hostname(),
      heartbeatIso: new Date().toISOString(), // FRESH heartbeat — only the pid proves it dead
    }),
  );
  const r = acquireWorktreeLock(path, { owner: 'land', slug: 's', _pidAlive: () => false });
  assert.equal(r.ok, true);
  assert.equal(r.reaped, true);
  assert.equal(readWorktreeLockEntry(path).owner, 'land');
});

test('acquire: reaps a CORRUPT lock (nobody can prove ownership of garbage)', () => {
  const path = lockIn(tmp());
  writeFileSync(path, '{{{ truncated');
  const r = acquireWorktreeLock(path, { owner: 'land', slug: 's' });
  assert.equal(r.ok, true);
  assert.equal(r.reaped, true);
});

test('renew: bumps the heartbeat for the owner, and REFUSES a foreign token', () => {
  const path = lockIn(tmp());
  const r = acquireWorktreeLock(path, { owner: 'prep', slug: 's', _now: () => 1000 });
  const before = readWorktreeLockEntry(path);
  assert.equal(renewWorktreeLock(path, r.token, { _now: () => 60_000 }), true);
  const after = readWorktreeLockEntry(path);
  assert.notEqual(after.heartbeatIso, before.heartbeatIso);
  assert.equal(after.startedIso, before.startedIso); // start time is history, not state
  assert.equal(after.token, r.token);
  assert.equal(renewWorktreeLock(path, 'someone-elses-token'), false);
});

test('renew: on a vanished lock returns false instead of resurrecting it', () => {
  const path = lockIn(tmp());
  const r = acquireWorktreeLock(path, { owner: 'prep', slug: 's' });
  releaseWorktreeLock(path, r.token);
  assert.equal(renewWorktreeLock(path, r.token), false);
  assert.equal(existsSync(path), false);
});

test('release: token ownership — a waiter that never held it cannot free the holder', () => {
  // This is what stops a head-time land whose bounded wait expired from unlocking a prep that is
  // still mid-rebase, which would hand it exactly the concurrency the lock exists to prevent.
  const path = lockIn(tmp());
  const held = acquireWorktreeLock(path, { owner: 'prep', slug: 's' });
  assert.equal(releaseWorktreeLock(path, 'not-my-token'), 'FOREIGN');
  assert.equal(existsSync(path), true);
  assert.equal(releaseWorktreeLock(path, held.token), 'RELEASED');
  assert.equal(existsSync(path), false);
});

test('release: idempotent — a second release is NOOP, never an error', () => {
  const path = lockIn(tmp());
  const held = acquireWorktreeLock(path, { owner: 'land', slug: 's' });
  assert.equal(releaseWorktreeLock(path, held.token), 'RELEASED');
  assert.equal(releaseWorktreeLock(path, held.token), 'NOOP');
});

test('release --force frees a lock whose token we lost (the preempt path)', () => {
  const path = lockIn(tmp());
  acquireWorktreeLock(path, { owner: 'prep', slug: 's' });
  assert.equal(releaseWorktreeLock(path, null, { force: true }), 'RELEASED');
});

// ── the full prep ⇄ land handshake ─────────────────────────────────

test('handshake: prep holds → land refused → prep releases → land acquires', () => {
  const path = lockIn(tmp());
  const prep = acquireWorktreeLock(path, { owner: 'prep', slug: 's' });
  assert.equal(prep.ok, true);
  assert.equal(acquireWorktreeLock(path, { owner: 'land', slug: 's' }).ok, false);
  assert.equal(releaseWorktreeLock(path, prep.token), 'RELEASED');
  const land = acquireWorktreeLock(path, { owner: 'land', slug: 's' });
  assert.equal(land.ok, true);
  assert.equal(readWorktreeLockEntry(path).owner, 'land');
});

test('handshake: a crashed prep never wedges the land (no wait, no operator step)', () => {
  const path = lockIn(tmp());
  writeFileSync(
    path,
    JSON.stringify({
      token: 'crashed',
      owner: 'prep',
      slug: 's',
      pid: 999_999,
      host: hostname(),
      startedIso: new Date().toISOString(),
      heartbeatIso: new Date().toISOString(),
    }),
  );
  const land = acquireWorktreeLock(path, { owner: 'land', slug: 's', _pidAlive: () => false });
  assert.equal(land.ok, true);
  assert.equal(land.reaped, true);
});

// ── preemption ─────────────────────────────────────────────────────

// Pinned to an explicit non-win32 `_platform` (plan 2515) rather than the ambient
// `process.platform` default: these assert the POSIX group-kill path specifically, and that path
// must be exercised deterministically regardless of which OS actually runs this suite (including
// this repo's own Windows dev boxes).
test('terminate: signals the process GROUP first (kills git grandchildren too)', () => {
  const calls = [];
  const ok = terminateWorktreeLockHolder({ pid: 321, host: hostname() }, 'SIGTERM', {
    _platform: 'linux',
    _kill: (pid, sig) => calls.push([pid, sig]),
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [[-321, 'SIGTERM']]);
});

test('terminate: falls back to the bare pid where process groups do not exist', () => {
  const calls = [];
  const ok = terminateWorktreeLockHolder({ pid: 321, host: hostname() }, 'SIGKILL', {
    _platform: 'linux',
    _kill: (pid, sig) => {
      calls.push([pid, sig]);
      if (pid < 0) throw new Error('ESRCH'); // no such group
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [
    [-321, 'SIGKILL'],
    [321, 'SIGKILL'],
  ]);
});

// ── win32 tree-kill (plan 2515) ─────────────────────────────────────
// On win32 there are no process groups, so a bare pid-kill orphans any git grandchild the prep is
// blocked in (e.g. `git push --force-with-lease`) — the exact racing-writer bug this module exists
// to exclude. The win32 arm must tree-kill via `taskkill /T` instead of ever attempting the
// POSIX group-kill (which does not exist there).

test('terminate: win32 tree-kills via taskkill /T and never attempts a group kill', () => {
  const calls = [];
  const ok = terminateWorktreeLockHolder({ pid: 4242, host: hostname() }, 'SIGTERM', {
    _platform: 'win32',
    _execFileSync: (cmd, args) => calls.push([cmd, args]),
    _kill: () => {
      throw new Error('should not be called — taskkill succeeded');
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [['taskkill', ['/PID', '4242', '/T', '/F']]]);
});

test('terminate: win32 falls back to bare _kill(pid) when taskkill throws', () => {
  const killCalls = [];
  const ok = terminateWorktreeLockHolder({ pid: 4242, host: hostname() }, 'SIGKILL', {
    _platform: 'win32',
    _execFileSync: () => {
      throw new Error('taskkill: process not found');
    },
    _kill: (pid, sig) => killCalls.push([pid, sig]),
  });
  assert.equal(ok, true);
  // bare pid, not the group form — win32 has no process groups.
  assert.deepEqual(killCalls, [[4242, 'SIGKILL']]);
});

test('terminate: win32 returns false only when both taskkill AND the bare-pid fallback fail', () => {
  const ok = terminateWorktreeLockHolder({ pid: 4242, host: hostname() }, 'SIGTERM', {
    _platform: 'win32',
    _execFileSync: () => {
      throw new Error('taskkill: process not found');
    },
    _kill: () => {
      throw new Error('ESRCH');
    },
  });
  assert.equal(ok, false);
});

test('terminate: NEVER signals a pid recorded on another host', () => {
  let called = false;
  const ok = terminateWorktreeLockHolder({ pid: 321, host: 'other-box' }, 'SIGTERM', {
    _kill: () => {
      called = true;
    },
  });
  assert.equal(ok, false);
  assert.equal(called, false);
});

test('terminate: a record with no usable pid is a no-op, not a throw', () => {
  assert.equal(terminateWorktreeLockHolder(null), false);
  assert.equal(terminateWorktreeLockHolder({ host: hostname() }), false);
});

test('describe: names the owner kind, pid and host for the operator-facing log', () => {
  const s = describeWorktreeLockHolder({ owner: 'prep', pid: 7, host: 'box', heartbeatIso: 'T' });
  assert.match(s, /prep/);
  assert.match(s, /pid 7/);
  assert.match(s, /box/);
  assert.equal(describeWorktreeLockHolder(null), 'an unreadable lock record');
});

test('the lock file is JSON on disk (readable by an operator mid-incident)', () => {
  const path = lockIn(tmp());
  acquireWorktreeLock(path, { owner: 'prep', slug: '2473-Infra-x' });
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(parsed.slug, '2473-Infra-x');
});

// ── review 2473 [5]: worktreeLockIsLive — presence is NOT ownership ──
// dispatchLandPrep gates on this. A bare `existsSync` would treat a crashed prep's leftover as
// busy, so ONE crash would suppress every future dispatch for that slug and silently switch the
// whole optimization off.

test('worktreeLockIsLive: false when nothing holds it', () => {
  assert.equal(worktreeLockIsLive(lockIn(tmp())), false);
});

test('worktreeLockIsLive: true for a live holder', () => {
  const path = lockIn(tmp());
  acquireWorktreeLock(path, { owner: 'prep', slug: 's' }); // our own pid ⇒ provably alive
  assert.equal(worktreeLockIsLive(path), true);
});

test('worktreeLockIsLive: FALSE for a crashed holder — a stale lock never blocks dispatch', () => {
  const path = lockIn(tmp());
  writeFileSync(
    path,
    JSON.stringify({
      token: 'ghost',
      owner: 'prep',
      slug: 's',
      pid: 4242,
      host: hostname(),
      heartbeatIso: new Date().toISOString(), // fresh stamp; only the pid proves it dead
    }),
  );
  assert.equal(worktreeLockIsLive(path, { _pidAlive: () => false }), false);
});

test('worktreeLockIsLive: FALSE past the hold ceiling (the wedged holder)', () => {
  const path = lockIn(tmp());
  acquireWorktreeLock(path, { owner: 'prep', slug: 's', _now: () => 0 });
  assert.equal(
    worktreeLockIsLive(path, { _now: () => WORKTREE_LOCK_MAX_HOLD_MS + 1, _pidAlive: () => true }),
    false,
  );
});

test('worktreeLockIsLive: a CORRUPT lock is not live (acquire would reap it)', () => {
  const path = lockIn(tmp());
  writeFileSync(path, 'not json at all');
  assert.equal(worktreeLockIsLive(path), false);
});

// ── plan 2738: PID RECYCLING — existence is not identity ────────────────────────────────────
//
// THE INCIDENT these cases pin (2026-08-02, plan 2718's land). A prep holder — pid 50384 — was
// verifiably DEAD, yet every keep-hot pass for ~36 minutes exited BUSY against its lock. Both STALE
// arms missed it: the age gate because 36 min sits inside the 40-min ceiling, and the pid gate
// because `kill(50384, 0)` did not throw ESRCH — the OS had reassigned that NUMBER. A pid probe
// proves that SOMETHING owns the number, never that it is still our holder, and on this host a
// merely-alive pid is usually a recycled one (the tab-light work measured 119 "alive" pids for 12
// real sessions). The start-time token is the identity half the pid probe structurally cannot give.

test('plan 2738 verdict: a RECYCLED pid is STALE even while alive with a fresh stamp — the incident', () => {
  // Exactly the 2026-08-02 shape: the pid probes ALIVE (someone else owns the number now) and the
  // frozen heartbeat is still inside the ceiling. Pre-2738 this read LIVE and pinned keep-hot off
  // for the rest of the wait; the identity proof reaps it on the very next poll.
  const entry = {
    pid: 50384,
    host: hostname(),
    heartbeatIso: new Date(1000).toISOString(),
    startToken: 'started-when-the-prep-began',
  };
  assert.equal(
    worktreeLockVerdict(entry, { nowMs: 1000 + 36 * 60_000, alive: true, identity: 'UNPROVEN' }),
    'LIVE',
    'the pre-2738 behaviour, reproduced: alive pid + inside the ceiling ⇒ LIVE',
  );
  assert.equal(
    worktreeLockVerdict(entry, { nowMs: 1000 + 36 * 60_000, alive: true, identity: 'RECYCLED' }),
    'STALE',
  );
});

test('plan 2738 verdict: identity SAME / UNPROVEN never weakens a LIVE holder', () => {
  // The safety direction: the probe may only ever ADD a reap, never remove one and never
  // manufacture a false STALE for a holder that is genuinely working.
  const entry = { pid: 4242, host: hostname(), heartbeatIso: new Date(1000).toISOString() };
  for (const identity of ['SAME', 'UNPROVEN']) {
    assert.equal(worktreeLockVerdict(entry, { nowMs: 2000, alive: true, identity }), 'LIVE');
    // a dead pid and the age ceiling still reap regardless of what identity says
    assert.equal(worktreeLockVerdict(entry, { nowMs: 2000, alive: false, identity }), 'STALE');
    assert.equal(
      worktreeLockVerdict(entry, {
        nowMs: 1000 + WORKTREE_LOCK_MAX_HOLD_MS + 1,
        alive: true,
        identity,
      }),
      'STALE',
    );
  }
});

test('plan 2738 verdict: identity defaults to UNPROVEN — every pre-2738 caller keeps its meaning', () => {
  const entry = { pid: 4242, host: hostname(), heartbeatIso: new Date(1000).toISOString() };
  assert.equal(worktreeLockVerdict(entry, { nowMs: 2000, alive: true }), 'LIVE');
});

test('plan 2738 holderIdentity: SAME on a matching token, RECYCLED on a mismatch', () => {
  const entry = { pid: 4242, host: hostname(), startToken: 'T1' };
  assert.equal(holderIdentity(entry, { _startToken: () => 'T1' }), 'SAME');
  assert.equal(holderIdentity(entry, { _startToken: () => 'T2' }), 'RECYCLED');
});

test('plan 2738 holderIdentity: UNPROVEN whenever identity cannot be established', () => {
  // Every one of these must fall back to the pre-2738 pid+age gates rather than guess — the probe
  // may never be the reason a live holder is reaped.
  const probe = () => 'T1';
  // a lock written by a pre-2738 checkout carries no token
  assert.equal(holderIdentity({ pid: 4242, host: hostname() }, { _startToken: probe }), 'UNPROVEN');
  assert.equal(
    holderIdentity({ pid: 4242, host: hostname(), startToken: '' }, { _startToken: probe }),
    'UNPROVEN',
  );
  // the query itself failed (access denied, no such process, unparseable output)
  assert.equal(
    holderIdentity({ pid: 4242, host: hostname(), startToken: 'T1' }, { _startToken: () => null }),
    'UNPROVEN',
  );
  // an unusable pid is unprovable, never RECYCLED
  assert.equal(holderIdentity({ pid: 0, startToken: 'T1' }, { _startToken: probe }), 'UNPROVEN');
  assert.equal(holderIdentity(null, { _startToken: probe }), 'UNPROVEN');
});

test('plan 2738 processStartToken: trims the platform query, and null on any failure', () => {
  assert.equal(
    processStartToken(4242, { _platform: 'win32', _exec: () => '133700000000000000\r\n' }),
    '133700000000000000',
  );
  // POSIX reads `ps -o lstart=` — an ABSOLUTE start time. (etimes is relative, so two readings of
  // one live process would differ and read as recycled: never use it here.)
  // `_procStatFields` MUST be stubbed alongside `_platform` (the CLAUDE.md half-injection rule):
  // the POSIX path reads /proc/<pid>/stat FIRST and only falls back to `ps`, so naming the
  // platform without supplying its symbols leaves the real reader in place — and on any Linux
  // host where pid 4242 happens to exist (every cloud drain container) this returned that
  // process's real starttime ticks instead of the injected `ps` output. Returning null here is
  // what actually reaches the `ps` fallback this assertion is about.
  assert.equal(
    processStartToken(4242, {
      _platform: 'linux',
      _procStatFields: () => null,
      _exec: () => 'Sat Aug  2 20:25:28 2026\n',
    }),
    'Sat Aug  2 20:25:28 2026',
  );
  // no such process ⇒ empty output ⇒ unprovable, NOT a false "dead"
  assert.equal(processStartToken(4242, { _platform: 'win32', _exec: () => '  \n' }), null);
  // the query threw (access denied, powershell missing) ⇒ unprovable
  assert.equal(
    processStartToken(4242, {
      _platform: 'win32',
      _exec: () => {
        throw new Error('access denied');
      },
    }),
    null,
  );
  assert.equal(processStartToken(0, { _platform: 'win32', _exec: () => '1' }), null);
});

test('plan 2738 acquire: stamps our own start token into the lock record', () => {
  const path = lockIn(tmp());
  assert.equal(acquireWorktreeLock(path, { owner: 'prep', slug: 's', startToken: 'T1' }).ok, true);
  assert.equal(readWorktreeLockEntry(path).startToken, 'T1');
});

test('plan 2738 acquire: an unprovable own token omits the field rather than writing a fake one', () => {
  // A holder whose start time we cannot read must leave later probers on the pid+age gates, not
  // hand them a token that can never match and would make every prober call it RECYCLED.
  const path = lockIn(tmp());
  acquireWorktreeLock(path, { owner: 'prep', slug: 's', startToken: null });
  assert.equal('startToken' in readWorktreeLockEntry(path), false);
});

test('plan 2738 acquire: REAPS a recycled-pid holder instead of standing down for 40 minutes', () => {
  // The end-to-end incident: a live-looking pid, a stamp well inside the ceiling, and a token that
  // proves the recorded holder is gone. Pre-2738 this returned {ok:false} on every attempt.
  const path = lockIn(tmp());
  acquireWorktreeLock(path, {
    owner: 'prep',
    slug: 's',
    pid: 50384,
    startToken: 'the-dead-prep',
    _now: () => 1000,
  });
  const r = acquireWorktreeLock(path, {
    owner: 'land',
    slug: 's',
    _now: () => 1000 + 36 * 60_000,
    _pidAlive: () => true, // the number is owned — by somebody else
    _holderIdentity: () => 'RECYCLED',
    startToken: 'the-live-land',
  });
  assert.equal(r.ok, true);
  assert.equal(r.reaped, true);
  assert.equal(readWorktreeLockEntry(path).startToken, 'the-live-land');
});

test('plan 2738 acquire: identity is NOT probed for a holder already decided by pid or host', () => {
  // Cost guard. The probe is a subprocess; asking for it when the cheap gates have already answered
  // would put one on every poll of done-worktree's pre-preflight wait loop for no new information.
  const dead = lockIn(tmp());
  let probes = 0;
  const counting = () => {
    probes++;
    return 'SAME';
  };
  acquireWorktreeLock(dead, { owner: 'prep', slug: 's', startToken: 'T1' });
  acquireWorktreeLock(dead, {
    owner: 'land',
    slug: 's',
    _pidAlive: () => false, // pid-proved dead — already STALE, nothing to ask
    _holderIdentity: counting,
  });
  assert.equal(probes, 0, 'a pid-proved-dead holder is decided without a subprocess');

  const foreign = lockIn(tmp());
  writeFileSync(
    foreign,
    JSON.stringify({
      token: 'x',
      pid: 4242,
      host: 'some-other-box',
      startToken: 'T1',
      heartbeatIso: new Date().toISOString(),
    }),
  );
  acquireWorktreeLock(foreign, { owner: 'land', slug: 's', _holderIdentity: counting });
  assert.equal(probes, 0, "another host's pid number is meaningless — never probed locally");
});

test('plan 2738 worktreeLockIsLive: FALSE for a recycled holder — the read-only twin agrees', () => {
  // The two verdicts route through one classifier precisely so they cannot drift; this pins that
  // the read-only side learned the new arm too.
  const path = lockIn(tmp());
  acquireWorktreeLock(path, { owner: 'prep', slug: 's', pid: 50384, startToken: 'the-dead-prep' });
  assert.equal(
    worktreeLockIsLive(path, { _pidAlive: () => true, _holderIdentity: () => 'RECYCLED' }),
    false,
  );
  assert.equal(
    worktreeLockIsLive(path, { _pidAlive: () => true, _holderIdentity: () => 'SAME' }),
    true,
  );
});

test('plan 2738 classifyHolder: the age gate decides WITHOUT paying for an identity probe', () => {
  // Review finding. Everything except LIVE is already settled by the cheap gates, and identity
  // cannot change any of them — so probing first spent a PowerShell/`ps` spawn (up to its 10 s
  // timeout) on locks the age rule had already condemned, once per poll of done-worktree's
  // pre-preflight wait loop.
  const path = lockIn(tmp());
  let probes = 0;
  const counting = () => {
    probes++;
    return 'SAME';
  };
  acquireWorktreeLock(path, { owner: 'prep', slug: 's', startToken: 'T1', _now: () => 0 });
  assert.equal(
    worktreeLockIsLive(path, {
      _now: () => WORKTREE_LOCK_MAX_HOLD_MS + 1,
      _pidAlive: () => true,
      _holderIdentity: counting,
    }),
    false,
    'past the ceiling ⇒ STALE on the cheap gate alone',
  );
  assert.equal(probes, 0);
  // Inside the ceiling the cheap gate says LIVE and cannot settle it — NOW the probe earns its cost.
  assert.equal(
    worktreeLockIsLive(path, { _now: () => 1, _pidAlive: () => true, _holderIdentity: counting }),
    true,
  );
  assert.equal(probes, 1);
});

test('plan 2738 processStartToken: POSIX reads /proc starttime, and falls back to ps without it', () => {
  // /proc field 22 (`starttime`, clock ticks since boot) resolves far finer than `ps -o lstart=`'s
  // one SECOND — which cannot tell a pid recycled inside the same second from the original holder,
  // the exact false-alive this mechanism exists to remove. It also costs no subprocess at all.
  // procStatFields slices off pid+comm, so /proc field N is index N-3 ⇒ 22 → 19.
  const fields = Array.from({ length: 25 }, (_, i) => `f${i}`);
  fields[19] = '904138';
  assert.equal(
    processStartToken(4242, {
      _platform: 'linux',
      _procStatFields: () => fields,
      _exec: () => {
        throw new Error('ps must not be spawned when /proc answered');
      },
    }),
    '904138',
  );
  // macOS/BSD: no /proc ⇒ the portable ps fallback still answers.
  assert.equal(
    processStartToken(4242, {
      _platform: 'darwin',
      _procStatFields: () => null,
      _exec: () => 'Sat Aug  2 20:25:28 2026\n',
    }),
    'Sat Aug  2 20:25:28 2026',
  );
  // neither source usable ⇒ unprovable, never a false "dead"
  assert.equal(
    processStartToken(4242, {
      _platform: 'linux',
      _procStatFields: () => null,
      _exec: () => '',
    }),
    null,
  );
});

test('plan 2738 terminate: REFUSES to signal a recycled pid — never kill a stranger', () => {
  // Review finding. This arm force-kills a whole process TREE, so signalling a number the OS has
  // reassigned kills an unrelated process — and on this host a merely-alive pid is usually recycled.
  // A proven mismatch means nothing of ours is left to kill; the caller's reap takes the lock
  // without any kill at all (a RECYCLED holder is STALE).
  let killed = 0;
  const spy = () => {
    killed++;
    return true;
  };
  const entry = { pid: 50384, host: hostname(), startToken: 'the-dead-prep' };
  assert.equal(
    terminateWorktreeLockHolder(entry, 'SIGTERM', {
      _kill: spy,
      _execFileSync: spy,
      _holderIdentity: () => 'RECYCLED',
    }),
    false,
    'false is also the right answer: the caller only escalates to SIGKILL after a DELIVERED SIGTERM',
  );
  assert.equal(killed, 0);
  // SAME and UNPROVEN (a legacy record, an unreadable start time) behave exactly as before 2738.
  for (const identity of ['SAME', 'UNPROVEN']) {
    killed = 0;
    assert.equal(
      terminateWorktreeLockHolder(entry, 'SIGTERM', {
        _kill: spy,
        _platform: 'linux',
        _holderIdentity: () => identity,
      }),
      true,
    );
    assert.ok(killed > 0);
  }
});

test('plan 2738 renew: preserves the start token across a heartbeat bump', () => {
  // renewWorktreeLock rewrites the whole record; dropping the token would silently demote a
  // long-running holder back to the pre-2738 gates exactly when the wait is longest.
  const path = lockIn(tmp());
  const held = acquireWorktreeLock(path, { owner: 'prep', slug: 's', startToken: 'T1' });
  assert.equal(renewWorktreeLock(path, held.token), true);
  assert.equal(readWorktreeLockEntry(path).startToken, 'T1');
});

// ── plan 4034 T1: a heartbeat keeps a long gate's lock LIVE past the staleness ceiling ─────────
//
// The property the land spine now depends on: a gate that legitimately runs longer than
// WORKTREE_LOCK_MAX_HOLD_MS no longer goes stale under itself, because its holder renews on a
// timer. Driven with an INJECTED clock and explicit `renewWorktreeLock` calls standing in for the
// timer's ticks — never a real interval racing a real ceiling (the ambient-load rule, plan 4005):
// what is being proved is that a renewal moves the verdict, not that node fires timers on time.
test('plan 4034 T1: a renewed holder stays LIVE past maxHoldMs; the same holder un-renewed goes STALE', () => {
  const maxHoldMs = 10_000; // shrunk ceiling — the real 40 min would only slow the arithmetic
  const path = lockIn(tmp());
  let now = 1_000_000;
  const r = acquireWorktreeLock(path, { owner: 'land', slug: 's', _now: () => now });
  assert.equal(r.ok, true);

  // A gate running 4x the ceiling, with a renewal every ~quarter-ceiling — the shape
  // `armWorktreeLockRenewal` produces (30s ticks under a 40-minute ceiling), scaled down.
  for (let elapsed = 0; elapsed < maxHoldMs * 4; elapsed += maxHoldMs / 4) {
    now += maxHoldMs / 4;
    assert.equal(renewWorktreeLock(path, r.token, { _now: () => now }), true, `tick at ${elapsed}`);
    // A SIBLING acquire must be refused for the whole run — this is the actual safety property:
    // nobody may reap and start rebasing this tree while our gate is still reading it.
    const sibling = acquireWorktreeLock(path, {
      owner: 'prep',
      slug: 's',
      maxHoldMs,
      _now: () => now,
      // The holder is this very process, so the real pid probe would say ALIVE and short-circuit
      // the age gate that is under test. Force the age gate to be the deciding one.
      _pidAlive: () => null,
    });
    assert.equal(sibling.ok, false, `a sibling must not take a renewed lock (at ${elapsed})`);
    assert.equal(sibling.verdict, 'LIVE');
  }
  assert.equal(readWorktreeLockEntry(path).token, r.token, 'still ours after the whole run');

  // Same holder, same elapsed time, NO renewal: the ceiling reaps it. This is the pre-4034
  // behaviour, and it is what made the land gates' caps the lock's hold limit.
  const path2 = lockIn(tmp());
  let now2 = 1_000_000;
  const r2 = acquireWorktreeLock(path2, { owner: 'land', slug: 's', _now: () => now2 });
  now2 += maxHoldMs * 4;
  const taken = acquireWorktreeLock(path2, {
    owner: 'prep',
    slug: 's',
    maxHoldMs,
    _now: () => now2,
    _pidAlive: () => null,
  });
  assert.equal(taken.ok, true, 'an un-renewed holder past the ceiling IS reapable');
  assert.equal(taken.reaped, true);
  assert.notEqual(taken.token, r2.token);
});

test('plan 4034 T1: WORKTREE_LOCK_RENEW_MS leaves real headroom under the staleness ceiling', () => {
  // The heartbeat is only a safety property if many ticks can be missed and the holder still
  // survives — a synchronous execFileSync git call pauses the timer for a minute or two by design.
  assert.ok(WORKTREE_LOCK_RENEW_MS > 0);
  assert.ok(
    WORKTREE_LOCK_MAX_HOLD_MS / WORKTREE_LOCK_RENEW_MS >= 20,
    'at least ~20 consecutive missed ticks must be survivable',
  );
});

// ── plan 4034, gpt-review round 1 (2 finders, BLOCKING): renewal is not ownership proof ────────
//
// `renewWorktreeLock` validated the token from a READ and then wrote the file in a separate step.
// A sibling that reaps and re-creates the lock between those two operations gets its own record
// overwritten by our write, and the renewal still returns true — so BOTH processes then believe
// they own the worktree, which is the exact two-writers-one-tree corruption this module exists to
// prevent. It was reachable before plan 4034 too, but the T1 heartbeat turns a handful of renewals
// per land into one every 30 s for the whole preflight, so the exposure is no longer negligible.
//
// The window is driven deterministically through the injected writer — never by racing a real
// second process, which could not fail reproducibly (the ambient-load rule, plan 4005).
test('plan 4034 (r1 fix): a renewal that is reaped-and-retaken mid-write reports FALSE, not success', () => {
  const path = lockIn(tmp());
  const mine = acquireWorktreeLock(path, { owner: 'land', slug: 's' });
  assert.equal(mine.ok, true);

  let siblingToken = null;
  // The sibling reaps our (from its point of view, stale) lock and takes the worktree — after our
  // token check has already passed, before our bytes land. This is the ONLY window that matters,
  // and it is driven from the seam rather than by racing a real process.
  const stealMidWrite = (p) => {
    rmSync(p, { force: true });
    siblingToken = acquireWorktreeLock(p, { owner: 'prep', slug: 's' }).token;
  };

  const renewed = renewWorktreeLock(path, mine.token, { _beforeWrite: stealMidWrite });
  assert.equal(renewed, false, 'a renewal that lost the lock mid-write must NOT report success');
  assert.equal(
    readWorktreeLockEntry(path).token,
    siblingToken,
    "and must never leave OUR token over the sibling's — that is the two-writers state itself",
  );
});

test('plan 4034 (r1 fix): an ordinary renewal is unaffected — still true, still ours, heartbeat moved', () => {
  const path = lockIn(tmp());
  const r = acquireWorktreeLock(path, { owner: 'land', slug: 's', _now: () => 1000 });
  const before = readWorktreeLockEntry(path);
  assert.equal(renewWorktreeLock(path, r.token, { _now: () => 60_000 }), true);
  const after = readWorktreeLockEntry(path);
  assert.equal(after.token, r.token);
  assert.notEqual(after.heartbeatIso, before.heartbeatIso);
  assert.equal(after.startedIso, before.startedIso);
  // No trailing residue from the in-place write — the record must still parse exactly.
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
});

test('plan 4034 (r1 fix): a renewal after the lock is GONE stays false and does not recreate it', () => {
  const path = lockIn(tmp());
  const r = acquireWorktreeLock(path, { owner: 'land', slug: 's' });
  releaseWorktreeLock(path, r.token);
  assert.equal(renewWorktreeLock(path, r.token), false);
  assert.equal(existsSync(path), false, 'a renewal must never resurrect a released lock');
});
