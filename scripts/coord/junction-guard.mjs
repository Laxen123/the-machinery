// scripts/coord/junction-guard.mjs (plan 2697; mechanism found by plan 2401)
// ONE owner for the "unlink a node_modules junction before anything recursively deletes the
// directory holding it" hazard. Extracted from done-worktree.mjs so the OTHER recursive deleter
// in the land spine — sweep-deferred-worktrees.mjs — can arm the same guard without importing
// done-worktree.mjs (which imports the sweep: that direction is a cycle).
//
// THE HAZARD (plan 2401). The post-land close-out (plan 971) runs in an ephemeral finish
// worktree `.claude/worktrees/_finish-<slug>` whose `node_modules` is an NTFS junction to MAIN's
// real `node_modules` (plan 1509, so `pnpm exec prettier` resolves during close-out).
// git-for-windows treats a junction as a PLAIN DIRECTORY, so `git worktree remove --force`
// recurses THROUGH it and deletes MAIN's real files on the other side — the root cause of the
// recurring pnpm virtual-store tear (a stable 18-entry `pkg_json_missing` victim set + an emptied
// root `.bin`, healed 80+ times by install-main between 2026-07-21 and 2026-08-01). PowerShell's
// `Remove-Item -Recurse` has the same traversal behaviour on Windows PowerShell 5.1.
// Node's own `rmSync` does NOT traverse a junction (verified in the plan-2401 sandbox, and again
// in plan 2697's), so removing the LINK first makes the whole teardown safe.
//
// Re-verified by plan 2697 in an isolated sandbox (throwaway clone + real `pnpm install` +
// detached worktree + junction): `git worktree remove --force` with a live junction destroyed the
// parent's store every time (2 `.pnpm` entries deleted outright, 2 more stripped of their inner
// package.json, all 18 root `.bin` files gone), while `pnpm exec` / `pnpm ls` from inside the
// junction-armed worktree did NOTHING — so the deleters below are the whole hazard surface.

import { lstatSync, rmdirSync, unlinkSync } from 'node:fs';

/**
 * Unlink a `<dir>/node_modules` JUNCTION (Windows) / directory symlink (POSIX) so a later
 * recursive delete of `<dir>` cannot traverse it into the link target.
 *
 * rmdir-then-unlink covers both platforms: a Windows junction is removed by rmdir, a POSIX
 * dir-symlink by unlink. A REAL `node_modules` directory is never touched — only a link.
 *
 * @param {string} dir directory that may hold a `node_modules` link
 * @returns {'none'|'removed'|'failed'} `'none'` — no link, nothing to do (safe to delete);
 *   `'removed'` — the link is gone (safe to delete); `'failed'` — a link is PRESENT and could
 *   not be unlinked, so the caller MUST keep every traversing deleter away from `dir`.
 */
export function unlinkNodeModulesJunction(
  dir,
  { _lstat = lstatSync, _rmdir = rmdirSync, _unlink = unlinkSync } = {},
) {
  const dest = `${dir}/node_modules`;
  try {
    if (!_lstat(dest).isSymbolicLink()) return 'none'; // a REAL dir (or file) — not ours to touch
  } catch (e) {
    // ENOENT/ENOTDIR is POSITIVE evidence there is nothing to unlink → safe to delete.
    // ANY OTHER lstat error (EPERM, EBUSY, EIO, a filter-driver hiccup) tells us nothing about
    // whether a junction is there, and this is a safety guard: an unknown must read as "still
    // armed", never as "all clear". Returning 'none' here let the traversing deleters run against
    // a path we could not inspect — the exact fail-open shape this module exists to prevent
    // (gpt-review 283eb7/fdaae3/f8c4a6/89350d).
    const code = e && e.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'none' : 'failed';
  }
  try {
    _rmdir(dest);
    return 'removed';
  } catch {
    /* fall through to unlink (POSIX dir-symlink) */
  }
  try {
    _unlink(dest);
    return 'removed';
  } catch {
    return 'failed';
  }
}

/**
 * Same call, but never throws: an unexpected error counts as `'failed'` (fail toward safety —
 * the caller then keeps its traversing deleters away). Use this at every call site that is
 * about to recursively delete; the raw function stays exported for unit tests.
 *
 * @param {string} dir
 * @returns {'none'|'removed'|'failed'}
 */
export function disarmJunction(dir, deps) {
  try {
    return unlinkNodeModulesJunction(dir, deps);
  } catch {
    return 'failed';
  }
}
