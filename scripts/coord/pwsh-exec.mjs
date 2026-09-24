// scripts/coord/pwsh-exec.mjs — shared PowerShell resolver seam (plan 2405).
//
// Three scripts (`done-worktree.mjs`, `sweep-deferred-worktrees.mjs`, and
// `store-tear-watch.mjs`) each hand-copied the same "try each PowerShell candidate until
// one runs, remember the winner" loop, because the candidate ORDER lived in
// `pwshCandidates()`, which was deliberately `child_process`-free so it stays
// unit-testable without spawning a real shell — so none of the three copies could put the
// resolution loop there either, and none exported it for the others to share. This module
// is the one place the resolution itself lives: it owns the pure candidate order AND adds
// the impure probe/memoize/fallback on top, with an injectable spawn seam none of the
// three copies had.

// ── plan 4061 T3, then plan 3962 Decision 5: the candidate list is a PARAMETER again, now
// supplied by THIS module's own local `pwshCandidates()` ──────────────────────────────────
// 4061 T3 made `candidates` a caller-supplied PARAMETER rather than an import, because
// operator decision 2 (2026-09-19) chose uniform parameter passing over relocating
// `pwshCandidates()` out of the 5,900-line vetapp land spine (`done-worktree-lib.mjs`) into
// core — every caller ended up importing it FROM THE SPINE anyway (`push-queue-status.mjs`,
// `win-cpu-cap.mjs`, `sweep-deferred-worktrees.mjs`, `store-tear-watch.mjs`,
// `measure-pytest-memory.mjs`, `hooks/apply-session-cpu-class.mjs`, `done-worktree.mjs`), so
// the core→project edge relocated instead of closing. Plan 3962 Decision 5 (2026-09-20)
// narrows decision 2 for exactly this one pure, platform-keyed, vetapp-free value: it
// relocates here instead, making this module symmetric with `scripts/coord/sh-exec.mjs`, which
// already owns its own POSIX candidate order (`shCandidates()`) locally. `candidates`
// stays a required, explicit parameter to `pwshExe()`/`pwshCommand()` — decision 2's rule
// that the CALLER supplies what the resolver needs is unchanged; only WHERE the value they
// supply is defined has moved, so no core module needs to import the spine for it any more.
import { execFileSync } from 'node:child_process';

/**
 * Ordered PowerShell executables for the teardown shell-outs, most-preferred first.
 * PowerShell 7+ (`pwsh`) is preferred; on Windows we fall back to Windows PowerShell 5.1
 * (`powershell.exe`) for hosts that never installed pwsh — the teardown ENOENT'd on those
 * before this fix (plan 389, carry-forward from 378). Non-Windows only has `pwsh` (when
 * present at all). Pure so the ordering is unit-tested here; the actual on-PATH probe
 * lives in `pwshExe()` below.
 * @param {NodeJS.Platform} platform `process.platform`
 * @returns {string[]}
 */
export function pwshCandidates(platform) {
  return platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh'];
}

// Memo keyed BY CANDIDATE LIST, not a single global (gpt-review round 1). Once the ordering became
// a per-caller parameter, one memo for the whole process was wrong in two ways: a second caller
// with a DIFFERENT list was served the first list's answer, and — because the memo was read before
// the list was validated — a caller that forgot the parameter entirely got a silent success
// instead of the throw below. `win-cpu-cap.mjs` passes its own INJECTED platform's list, so two
// legitimately different lists in one process is a real case, not a hypothetical.
const _pwshExeByCandidates = new Map();

// pwshExe — probe each candidate (in the caller's order) with a no-op `-Command 'exit 0'`,
// memoize the first that launches, and fall back to the first candidate (unprobed) if none work,
// so a caller sees an honest ENOENT from its own invocation rather than a silently swallowed
// resolution failure. `_execFileSync` is the injectable spawn seam.
export function pwshExe({ candidates, _execFileSync = execFileSync } = {}) {
  // Validation FIRST, before any cache lookup: a caller that forgot the parameter must fail the
  // same way whether or not some earlier call already warmed a memo.
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error(
      'pwsh-exec: pwshExe() needs a non-empty `candidates` array — pass ' +
        '`pwshCandidates(process.platform)` from this module (plan 4061 T3: the ordering ' +
        'policy belongs to the caller, not to this resolver)',
    );
  }
  const cands = candidates;
  const key = cands.join('\u0000');
  if (_pwshExeByCandidates.has(key)) return _pwshExeByCandidates.get(key);
  const remember = (exe) => {
    _pwshExeByCandidates.set(key, exe);
    return exe;
  };
  for (const cand of cands) {
    try {
      _execFileSync(cand, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
      return remember(cand);
    } catch {
      /* not on PATH / failed to launch — try the next candidate */
    }
  }
  return remember(cands[0]);
}

// pwshCommand — the `execFileSync(pwshExe(), ['-NoProfile', '-Command', cmd], …)` wrapper
// every call site built by hand. Options match what store-tear-watch.mjs's original
// defaultExec passed (the only site with a `-Command cmd` + captured-output shape — the
// other two sites need per-call argv, not a single cmd string, so they call pwshExe()
// directly instead of through this wrapper).
export function pwshCommand(cmd, { candidates, encoding = 'utf8', windowsHide = true } = {}) {
  return execFileSync(pwshExe({ candidates }), ['-NoProfile', '-Command', cmd], {
    encoding,
    windowsHide,
  });
}

// resetPwshExeCache — test hook: the memo above is module-level state.
export function resetPwshExeCache() {
  _pwshExeByCandidates.clear();
}
