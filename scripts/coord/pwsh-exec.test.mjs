// scripts/pwsh-exec.test.mjs — unit tests for the shared PowerShell resolver seam (plan 2405).
// Every case injects `_execFileSync` — nothing here spawns a real shell.
//
// plan 4061 T3 moved the CANDIDATE LIST from an import (`pwshCandidates` out of the vetapp land
// spine) to a required parameter, and this test moved with it. That removes the two
// `skip: process.platform !== 'win32'` guards these cases used to carry: the win32 candidate list
// was previously only reachable by RUNNING on win32, because `pwshExe()` read `process.platform`
// itself. Now the platform is an input, so both lists are exercised on every host — which is the
// repo's own rule about environment-specific branches (CLAUDE.md: make the environment a
// PARAMETER, and supply that platform's symbols with it). `pwshCandidates` is used here only
// to pin that the real orderings are what these cases assert; `pwshExe`/`pwshCommand` never see it
// directly — plan 3962 Decision 5 relocated `pwshCandidates()` itself into THIS module (it used to
// live in the vetapp land spine), so the pure-mapping tests below moved from
// done-worktree-lib.test.mjs alongside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pwshExe, pwshCommand, pwshCandidates, resetPwshExeCache } from './pwsh-exec.mjs';

const WIN32 = pwshCandidates('win32'); // ['pwsh', 'powershell']
const POSIX = pwshCandidates('linux'); // ['pwsh']

test('the candidate orderings these cases pin are the real ones', () => {
  assert.deepEqual(WIN32, ['pwsh', 'powershell']);
  assert.deepEqual(POSIX, ['pwsh']);
});

// ── plan 389: PowerShell exe resolution order (carry-forward from 378); relocated here from
// done-worktree-lib.test.mjs by plan 3962 Decision 5 alongside pwshCandidates() itself ──────
test('pwshCandidates: win32 prefers pwsh then falls back to powershell 5.1', () => {
  assert.deepEqual(pwshCandidates('win32'), ['pwsh', 'powershell']);
});
test('pwshCandidates: non-Windows has pwsh only (no powershell.exe fallback)', () => {
  assert.deepEqual(pwshCandidates('linux'), ['pwsh']);
  assert.deepEqual(pwshCandidates('darwin'), ['pwsh']);
});
test('pwshCandidates: pwsh is always first so PS7 wins when both are installed', () => {
  assert.equal(pwshCandidates('win32')[0], 'pwsh');
});

test('pwshExe: first candidate wins when it launches', () => {
  resetPwshExeCache();
  const calls = [];
  const _execFileSync = (cmd) => {
    calls.push(cmd);
    return '';
  };
  const exe = pwshExe({ candidates: WIN32, _execFileSync });
  assert.equal(exe, 'pwsh');
  assert.deepEqual(calls, ['pwsh']);
});

test('pwshExe: first candidate fails, second wins (win32 candidate list)', () => {
  resetPwshExeCache();
  const calls = [];
  const _execFileSync = (cmd) => {
    calls.push(cmd);
    if (cmd === 'pwsh') throw new Error('ENOENT');
    return '';
  };
  const exe = pwshExe({ candidates: WIN32, _execFileSync });
  assert.equal(exe, 'powershell');
  assert.deepEqual(calls, ['pwsh', 'powershell']);
});

test('pwshExe: all candidates fail -> falls back to cands[0], never throws', () => {
  resetPwshExeCache();
  const _execFileSync = () => {
    throw new Error('ENOENT');
  };
  const exe = pwshExe({ candidates: WIN32, _execFileSync });
  assert.equal(exe, 'pwsh');
});

test('pwshExe: memoized across calls (probes only once)', () => {
  resetPwshExeCache();
  let calls = 0;
  const _execFileSync = () => {
    calls += 1;
    return '';
  };
  const first = pwshExe({ candidates: WIN32, _execFileSync });
  const second = pwshExe({ candidates: WIN32, _execFileSync });
  assert.equal(first, 'pwsh');
  assert.equal(second, 'pwsh');
  assert.equal(calls, 1);
});

test('pwshExe: non-win32 candidate list is just ["pwsh"] (only candidate ever probed)', () => {
  resetPwshExeCache();
  const calls = [];
  const _execFileSync = (cmd) => {
    calls.push(cmd);
    throw new Error('ENOENT');
  };
  const exe = pwshExe({ candidates: POSIX, _execFileSync });
  assert.equal(exe, 'pwsh');
  assert.deepEqual(calls, ['pwsh']);
});

// The parameter is REQUIRED, not defaulted (plan 4061 T3): a default would be the relocation
// operator decision 2 declined, and a silently-wrong second copy of the ordering. A caller that
// forgets it must fail loudly rather than resolve against some built-in guess.
test('pwshExe: a missing or empty candidate list throws, naming the fix', () => {
  resetPwshExeCache();
  const _execFileSync = () => '';
  for (const bad of [undefined, [], null, 'pwsh']) {
    assert.throws(
      () => pwshExe(bad === undefined ? { _execFileSync } : { candidates: bad, _execFileSync }),
      /pwsh-exec: pwshExe\(\) needs a non-empty `candidates` array/,
      `expected a throw for candidates=${JSON.stringify(bad)}`,
    );
  }
});

test('pwshExe: no candidates call reaches the spawn seam when the list is bad', () => {
  resetPwshExeCache();
  let calls = 0;
  const _execFileSync = () => {
    calls += 1;
    return '';
  };
  assert.throws(() => pwshExe({ candidates: [], _execFileSync }));
  assert.equal(calls, 0, 'a bad candidate list must be refused before anything is probed');
});

// gpt-review round 1 (angle-A / simplification / altitude, same root cause): the memo is read
// BEFORE `candidates` is validated and is not keyed to the list, so once any call has resolved,
// a later call with a bad list silently succeeds and a later call with a DIFFERENT list silently
// gets the first list's answer. Both matter here: the whole point of plan 4061 T3 is that the
// ordering is now per-caller, and `win-cpu-cap.mjs` deliberately passes an INJECTED platform's
// list — so two callers in one process legitimately differ.
test('pwshExe: a bad candidate list is refused even after a successful resolve', () => {
  resetPwshExeCache();
  const _execFileSync = () => '';
  assert.equal(pwshExe({ candidates: WIN32, _execFileSync }), 'pwsh');
  assert.throws(
    () => pwshExe({ _execFileSync }),
    /needs a non-empty `candidates` array/,
    'validation must not be short-circuited by the memo',
  );
});

test('pwshExe: the memo is keyed to the candidate list, not global', () => {
  resetPwshExeCache();
  // A host where `pwsh` is absent but `powershell` runs: the win32 list resolves to powershell,
  // the posix list has no second candidate and honestly falls back to its own cands[0].
  const _execFileSync = (cmd) => {
    if (cmd === 'pwsh') throw new Error('ENOENT');
    return '';
  };
  assert.equal(pwshExe({ candidates: WIN32, _execFileSync }), 'powershell');
  assert.equal(
    pwshExe({ candidates: POSIX, _execFileSync }),
    'pwsh',
    'a different candidate list must not be served the previous list’s memo',
  );
  // …and the first list is still memoized, not clobbered by the second.
  assert.equal(pwshExe({ candidates: WIN32, _execFileSync }), 'powershell');
});

test('pwshExe: still probes only once PER candidate list', () => {
  resetPwshExeCache();
  let calls = 0;
  const _execFileSync = () => {
    calls += 1;
    return '';
  };
  pwshExe({ candidates: WIN32, _execFileSync });
  pwshExe({ candidates: WIN32, _execFileSync });
  assert.equal(calls, 1, 'same list must stay memoized');
});

test('pwshCommand: is exported as a function alongside pwshExe/resetPwshExeCache', () => {
  assert.equal(typeof pwshCommand, 'function');
  assert.equal(typeof pwshExe, 'function');
  assert.equal(typeof resetPwshExeCache, 'function');
});
