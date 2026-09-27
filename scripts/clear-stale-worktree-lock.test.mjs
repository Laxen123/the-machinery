// scripts/clear-stale-worktree-lock.test.mjs — the worktree index.lock self-heal
// (plan 1100). Drives the script as a subprocess against REAL git repos + linked
// worktrees, so the production `git rev-parse` resolution path is the one under
// test (the script reads no GIT_* env — it resolves the git dir from cwd).
//
// Invariants under test:
//   - a STALE lock (mtime idle ≥ threshold) on a WORKTREE-private index is removed;
//   - a FRESH lock (a live op may hold it) is left untouched;
//   - the MAIN/shared `.git/index.lock` is NEVER touched (structural git-dir vs
//     git-common-dir gate, not a path substring) — explicitly out of scope;
//   - an explicit WORKTREE_LOCK_STALE_MS=0 is honoured (no falsy-zero coercion);
//   - no lock present is a clean no-op;
//   - the helper exits 0 even with no git context (never blocks the commit retry).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
// plan 2465 review fix: this fixture is shared with coord-git.test.mjs's
// healOwnWorktreeIndexLock suite — one copy in test-helpers/, not two near-identical ones.
import { makeRepoWithWorktree as makeRepoWithWorktreeShared } from './test-helpers/worktree-lock-repo.mjs';
import { makeNoRepoRoot } from './test-helpers/no-repo-root.mjs';

const SCRIPT = fileURLToPath(new URL('./clear-stale-worktree-lock.mjs', import.meta.url));
const roots = [];
const cleanups = [];
after(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
  for (const c of cleanups) {
    try {
      c();
    } catch {
      /* best-effort temp cleanup */
    }
  }
});

// Thin wrapper: this file's own tests rely on the module-level after()-hook sweep above
// (they never call the fixture's own `.cleanup()` per-test), so register it here instead.
function makeRepoWithWorktree() {
  const r = makeRepoWithWorktreeShared();
  cleanups.push(r.cleanup);
  return r;
}

function plantLock(lockPath, idleMs) {
  writeFileSync(lockPath, ''); // 0-byte, like git's lock
  const t = (Date.now() - idleMs) / 1000;
  utimesSync(lockPath, t, t);
}

// plan 4087 review follow-up (findings 1f2sscr / 17eeygq): the two failed-delete regression
// tests below used to guess a 700ms wall-clock delay for "long enough that PowerShell has
// probably opened its handle by now" — a real timer racing a real process, and exactly the
// ambient-load shape this repo's CLAUDE.md forbids (the correct wait is a property of the
// machine's current load, not of the code under test). Both tests need the identical
// PowerShell-holder + wait + kill sequence, so the fix folds dedup and the ambient-clock fix
// into one shared pair: `spawnLockHolder` writes a sentinel file the instant its handle is
// actually open, and `waitForFileSync` blocks on that sentinel appearing — the fixture's own
// signal — instead of a guessed duration.
function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFileSync(path, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`waitForFileSync: ${path} did not appear within ${timeoutMs}ms`);
    }
    syncSleep(intervalMs);
  }
}

// Spawns a short-lived PowerShell process that opens `lockPath` with FileShare.None (a genuine
// Windows delete-deny — see the header comment on the first regression test below for why a
// plain Node handle can't reproduce this), writes `readySentinel` the instant the handle is
// open, then holds it for `holdSeconds`. Callers block on `readySentinel` via
// `waitForFileSync` instead of guessing how long PowerShell needs to start and open the handle.
function spawnLockHolder(lockPath, readySentinel, holdSeconds = 6) {
  return spawn(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$fs = [System.IO.File]::Open('${lockPath.replace(/'/g, "''")}', 'Open', 'Read', 'None'); ` +
        `New-Item -Path '${readySentinel.replace(/'/g, "''")}' -ItemType File -Force | Out-Null; ` +
        `Start-Sleep -Seconds ${holdSeconds}; $fs.Close()`,
    ],
    { stdio: 'ignore' },
  );
}

// Run the helper with cwd set to a real worktree/checkout; the script resolves
// the git dir from cwd via `git rev-parse`. execFileSync throws on a non-zero
// exit, so a clean return also asserts the always-exit-0 invariant.
function runHelper(cwd, env = {}) {
  execFileSync('node', [SCRIPT], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// plan 4087 T4-C: same shape as runHelper, but captures stderr text instead of only
// asserting the exit-0 contract — the reproduction below needs the actual reported reason.
function runHelperCaptureStderr(cwd, env = {}) {
  const r = spawnSync('node', [SCRIPT], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return r.stderr || '';
}

// plan 4087 T4-C: the 2026-09-01 ledger incident
// (clear-stale-worktree-lock-reports-a-failed-delete-as-a-fresh-lock). coord-git.mjs's
// `clearStaleIndexLock` returns a bare `false` for THREE different reasons — no lock, a lock
// too FRESH to touch, and a lock old enough to clear whose `rmSync` itself THREW (EPERM/EBUSY)
// — and this script's caller (clear-stale-worktree-lock.mjs:150-155) reports every `false` as
// "idle < Nms — left in place (a live op may hold it)", which is only true for the middle
// case. A STALE lock that genuinely failed to delete is misreported as merely fresh.
//
// Forces the delete to fail with a REAL (not simulated) EBUSY/EPERM on a PROVABLY-STALE lock
// (WORKTREE_LOCK_STALE_MS=0, so age can never be the reported reason). A plain Node
// `fs.openSync` does NOT reproduce this — libuv opens files with FILE_SHARE_DELETE on Windows
// by default, so Node's own rmSync can delete a file another Node handle has open. A foreign
// .NET FileStream opened with FileShare.None genuinely denies the delete, so this spawns a
// short-lived PowerShell holder (platform-assert-ok: this reproduces a Windows-only failure
// mode by construction — clear-stale-worktree-lock.mjs's whole reason to exist, per its own
// header, is a Windows/Git-for-Windows crash-leftover class; no cross-platform equivalent
// exists to inject instead). No `_rmSync` double: clearStaleIndexLock has no injectable seam
// and coord-git.mjs is out of this worker's scope, so the failure must be genuine.
test(
  'plan 4087 T4-C: reproduces clear-stale-worktree-lock-reports-a-failed-delete-as-a-fresh-lock',
  // plan 4135: the lock holder is a PowerShell process, so this runs on win32 only.
  { skip: process.platform !== 'win32' },
  () => {
    const { wtDir, wtLock } = makeRepoWithWorktree();
    plantLock(wtLock, 0);
    const readySentinel = `${wtLock}.holder-ready`;
    const holder = spawnLockHolder(wtLock, readySentinel);
    try {
      // Block on the holder's OWN signal that its handle is actually open, not a guessed delay.
      waitForFileSync(readySentinel);
      // WORKTREE_LOCK_STALE_MS=0 forces the "provably stale, clear unconditionally" branch —
      // age can never be the reason a delete fails here.
      const stderr = runHelperCaptureStderr(wtDir, { WORKTREE_LOCK_STALE_MS: '0' });
      assert.ok(
        existsSync(wtLock),
        'the lock genuinely could not be removed (precondition of this test)',
      );
      // CORRECT behaviour, asserted so this test fails now (reproduction) and turns green once
      // the fix lands: a delete FAILURE must never be reported with the "idle < Nms" (fresh-lock)
      // wording — that phrase asserts a specific, false reason for a stale lock's survival.
      assert.doesNotMatch(
        stderr,
        /idle < 0ms/,
        `a failed delete of a provably-stale lock was reported as merely fresh. stderr: ${stderr}`,
      );
    } finally {
      try {
        holder.kill();
      } catch {
        /* best-effort */
      }
    }
  },
);

// plan 4087 T4-C (sweep branch): the identical conflation lives in the OTHER caller —
// clear-stale-worktree-lock.mjs's MAIN-checkout sweep branch (~lines 123-130), which reads
// `sweepWorktreeIndexLocks`'s own `s.removed` and reported every `false` the same false way.
// Fixing only the single-worktree branch above would be the one-row patch the repo's
// structural-fix rule forbids — this is the SAME defect at the second caller, same fixture,
// run from `mainDir` so the structural gate (`git-dir === git-common-dir`) selects the sweep
// path instead.
test(
  'plan 4087 T4-C (sweep branch): reproduces a failed delete as fresh via the MAIN-checkout sweep',
  // plan 4135: the lock holder is a PowerShell process, so this runs on win32 only.
  { skip: process.platform !== 'win32' },
  () => {
    const { mainDir, wtLock } = makeRepoWithWorktree();
    plantLock(wtLock, 0);
    const readySentinel = `${wtLock}.holder-ready`;
    const holder = spawnLockHolder(wtLock, readySentinel);
    try {
      waitForFileSync(readySentinel);
      const stderr = runHelperCaptureStderr(mainDir, { WORKTREE_LOCK_STALE_MS: '0' });
      assert.ok(
        existsSync(wtLock),
        'the lock genuinely could not be removed (precondition of this test)',
      );
      assert.doesNotMatch(
        stderr,
        /idle < 0ms/,
        `a failed delete of a provably-stale lock was reported as merely fresh (sweep branch). stderr: ${stderr}`,
      );
    } finally {
      try {
        holder.kill();
      } catch {
        /* best-effort */
      }
    }
  },
);

test('removes a STALE lock on a worktree-private index (real rev-parse path)', () => {
  const { wtDir, wtLock } = makeRepoWithWorktree();
  plantLock(wtLock, 60_000);
  assert.ok(existsSync(wtLock), 'precondition: worktree lock present');
  runHelper(wtDir); // no GIT_* — exercises the production cwd→git-dir resolution
  assert.equal(existsSync(wtLock), false, 'stale worktree lock should be removed');
});

test('leaves a FRESH lock untouched (a live op may hold it)', () => {
  const { wtDir, wtLock } = makeRepoWithWorktree();
  plantLock(wtLock, 0);
  // Huge threshold so "fresh" is decoupled from node spawn latency.
  runHelper(wtDir, { WORKTREE_LOCK_STALE_MS: '600000' });
  assert.equal(existsSync(wtLock), true, 'fresh worktree lock must be preserved');
});

// plan 4087 review round 2 (finding clear-stale-worktree-lock.mjs:133 — the main-checkout sweep
// conflates an absent-lock race with a fresh lock): run the SAME fresh-lock scenario through
// the MAIN-checkout SWEEP branch (not the single-worktree branch the test above exercises) and
// assert the reported reason is the FRESH wording, never the "appeared after the staleness
// check found none" (absent) wording — proving the sweep branch's outcome classification is
// correct for the deterministically-reachable case. The genuinely-racy 'absent' outcome itself
// (the lock vanishing in the few-microsecond window between sweepWorktreeIndexLocks' own
// presence check and clearStaleIndexLockDetailed's internal stat) has no seam to force
// deterministically from outside the subprocess — coord-git.mjs (which owns that internal
// timing) is out of this worker's edit scope — so this test proves the FIX is correct on the
// reachable branch rather than reproducing the unreachable race itself.
test('MAIN-checkout sweep: a FRESH lock is reported fresh, never as an absent-lock race', () => {
  const { mainDir, wtLock } = makeRepoWithWorktree();
  plantLock(wtLock, 0);
  const stderr = runHelperCaptureStderr(mainDir, { WORKTREE_LOCK_STALE_MS: '600000' });
  assert.equal(existsSync(wtLock), true, 'fresh worktree lock must be preserved');
  assert.match(stderr, /idle < 600000ms — left in place/, `stderr: ${stderr}`);
  assert.doesNotMatch(
    stderr,
    /appeared after the staleness check found none/,
    `a lock that is genuinely still present must never be reported as an absent-lock race. stderr: ${stderr}`,
  );
});

test('NEVER touches the MAIN/shared index lock (structural scope gate)', () => {
  const { mainDir, mainLock } = makeRepoWithWorktree();
  plantLock(mainLock, 600_000); // very stale, yet out of scope
  runHelper(mainDir); // run from the MAIN checkout: git-dir === git-common-dir
  assert.equal(existsSync(mainLock), true, 'shared main index lock must never be cleared');
});

test('honours WORKTREE_LOCK_STALE_MS=0 (no falsy-zero coercion)', () => {
  const { wtDir, wtLock } = makeRepoWithWorktree();
  plantLock(wtLock, 0); // age ~0
  runHelper(wtDir, { WORKTREE_LOCK_STALE_MS: '0' }); // 0 ⇒ clear regardless of idle age
  assert.equal(existsSync(wtLock), false, '0 override must clear even a fresh lock');
});

test('no lock present is a clean no-op', () => {
  const { wtDir, wtLock } = makeRepoWithWorktree();
  assert.equal(existsSync(wtLock), false, 'precondition: no lock');
  runHelper(wtDir);
  assert.equal(existsSync(wtLock), false, 'no lock → still no lock');
});

test('exits 0 outside any git repo (never blocks a commit retry)', () => {
  // The outside-a-repo condition is BUILT, not hoped for (plan 3622): a bare
  // `mkdtempSync(join(tmpdir(), …))` is outside a repo only while the machine has no repo above
  // tmpdir(). With one there this test still PASSED — the helper exits 0 either way — while
  // silently exercising the has-a-git-context path instead, so the no-git-context invariant this
  // test is named for had no coverage at all. `makeNoRepoRoot` plants the barrier and asserts it.
  const root = makeNoRepoRoot('cswl-nogit-');
  roots.push(root);
  // No throw ⇒ exit 0 even with no git context (the safety-critical invariant).
  assert.doesNotThrow(() => runHelper(root));
});
