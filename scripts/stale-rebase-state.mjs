// scripts/stale-rebase-state.mjs — the provably-stale `rebase-merge` / `rebase-apply`
// clearer (plan 2398 item 5). The SECOND crash-leftover class on the shared checkout, sibling
// to the stale `index.lock` that `clear-stale-worktree-lock.mjs` owns.
//
// THE BUG. 2026-07-25, during a `/local-drain` bootstrap: a leftover `.git/rebase-merge`
// directory blocked `git rebase` for an unrelated session with "there is already a
// rebase-merge directory" — while HEAD was still a normal symbolic ref, i.e. NO rebase was
// actually in flight. Same Git-for-Windows `fork()`-crash class as the stale index.lock, same
// shared `.git`, same shape: the recovery cost lands on a session that did nothing wrong.
//
// WHY ITS OWN MODULE rather than living inside clear-stale-worktree-lock.mjs. That script's
// contract is "run me, I always exit 0" — it calls `process.exit(0)` at top level, so a test
// (or any caller) that merely IMPORTED it to reach this function would kill its own process.
// Adding an `import.meta.url === argv[1]` entry guard there would have changed a load-bearing
// script's invocation semantics for a reason unrelated to its own job. A separate module keeps
// clear-stale-worktree-lock.mjs byte-for-byte the runner it already was, and keeps this
// function directly importable + unit-testable. It is deliberately NOT in coord-git.mjs, which
// is byte-synced to sibling repos (coord.config.json) and must not grow vetapp-only surface.
//
// WHY IT IS OPT-IN AT THE CLI (`clear-stale-worktree-lock.mjs --rebase-state`). That script's
// default path is `&&`-chained in front of a raw `git commit`. Removing an EMPTY index.lock is
// non-destructive; discarding rebase state would throw away a real rebase's progress if the
// staleness test were ever wrong. So the default path never reaches this code.
//
// THE THREE GATES, all required:
//   1. `<git-dir>/rebase-merge` (or `rebase-apply`) exists;
//   2. `git symbolic-ref -q HEAD` SUCCEEDS ⇒ HEAD is attached ⇒ no rebase in flight. This is
//      the load-bearing gate, verified empirically on git 2.43: a genuine in-flight rebase
//      always DETACHES HEAD (rc=1), while the stale leftover leaves HEAD a symbolic ref (rc=0)
//      and still blocks `git rebase`. The two states are therefore distinguishable, exactly as
//      the 2026-07-25 observation reported;
//   3. the directory has been idle ≥ the caller's staleness threshold.
// And it MOVES the directory aside (`rebase-merge.stale-<ts>`) instead of deleting it, so even
// a wrong call loses nothing — `git rebase` unblocks immediately, the state stays recoverable.

import { execFileSync } from 'node:child_process';
import { existsSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// Is a rebase genuinely in flight in THIS worktree? Any failure to read HEAD is treated as
// "in flight" — the fail-safe direction, since the only cost of a false "in flight" is that
// the operator clears it by hand, as they did on 2026-07-25.
export function rebaseInFlight({ cwd } = {}) {
  try {
    execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return false; // HEAD attached → no rebase in flight
  } catch {
    return true; // detached (or unreadable) → assume a live rebase, leave it alone
  }
}

/**
 * Move a provably-stale rebase-state directory aside. NEVER deletes.
 *
 * @returns {Array<{from:string,to:string,idleMs:number}>} what was moved (empty = nothing done)
 */
export function clearStaleRebaseState(
  gitDir,
  { staleMs, now = Date.now(), cwd, _inFlight = rebaseInFlight } = {},
) {
  const present = ['rebase-merge', 'rebase-apply']
    // `join`, not a hand-built `${gitDir}/${n}`: on Windows that returns a
    // forward-slash path while every caller builds its own with `join` (backslash),
    // so the reported `from` never compares equal to the directory that was moved.
    // Windows-only, and it reddened the scripts node:test gate for every session on
    // this platform.
    .map((n) => ({ name: n, path: join(gitDir, n) }))
    .filter((d) => existsSync(d.path));
  if (!present.length) return [];

  if (_inFlight({ cwd })) {
    console.error(
      `[clear-stale-worktree-lock] ${present.map((d) => d.name).join(' + ')} present but HEAD is ` +
        `DETACHED — a rebase looks genuinely in flight. Left in place (finish it with ` +
        `\`git rebase --continue\` / \`--abort\`).`,
    );
    return [];
  }

  const moved = [];
  for (const d of present) {
    let idleMs;
    try {
      idleMs = now - statSync(d.path).mtimeMs;
    } catch {
      continue; // vanished under us / unreadable — nothing to do, and never a reason to throw
    }
    if (idleMs < staleMs) {
      console.error(
        `[clear-stale-worktree-lock] ${d.name} present but idle < ${staleMs}ms — left in place ` +
          `(a live op may hold it): ${d.path}`,
      );
      continue;
    }
    // Move aside, never delete: a wrong call must lose nothing. The timestamp keeps repeated
    // clears from colliding on one destination name.
    const dest = `${d.path}.stale-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
    try {
      renameSync(d.path, dest);
      moved.push({ from: d.path, to: dest, idleMs });
      console.error(
        `[clear-stale-worktree-lock] MOVED ASIDE stale ${d.name} (HEAD attached, idle ` +
          `${Math.round(idleMs / 1000)}s) → ${dest}. \`git rebase\` is unblocked; delete the ` +
          `moved dir once you are satisfied nothing was lost.`,
      );
    } catch (e) {
      console.error(
        `[clear-stale-worktree-lock] could not move ${d.path} aside: ${e?.message || e}`,
      );
    }
  }
  return moved;
}
