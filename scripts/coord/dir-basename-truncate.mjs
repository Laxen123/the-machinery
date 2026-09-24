// scripts/coord/dir-basename-truncate.mjs — shared MAX_PATH-headroom truncation primitive (plan 1597).
//
// cut-worktree.mjs's worktreePathFor() (plan 909) and land-lib.mjs's landDirBaseFor() (plan 1573)
// independently re-implemented the identical "cap the DIRECTORY basename length, trim a trailing
// hyphen left by a mid-word clip" pattern — same MAX_DIR_SLUG/MAX_LAND_DIR_SLUG = 40 constant,
// same `.slice(0, N).replace(/-+$/, '')` shape (flagged by `/sonnet-review high` on
// batch-2026-07-07-coord-spine, 2 independent finders, both CONFIRMED). A future change to the
// Windows MAX_PATH (260) headroom budget now only has to be applied here, once, instead of
// hunted down in both call sites.
//
// Both callers cap only the throwaway/worktree DIRECTORY basename — never the git BRANCH name,
// which the spine (done-worktree's resolveWorktreeFromPorcelain) resolves by first, so a short
// dir is invisible to it.
//
// plan 1616: the Windows MAX_PATH-headroom LIMIT itself (40) was still independently declared as
// cut-worktree.mjs's MAX_DIR_SLUG and land-lib.mjs's MAX_LAND_DIR_SLUG — plan 1597 centralized the
// cap-and-trim ALGORITHM here but left the budget number duplicated at both call sites. Exporting
// it here makes a future MAX_PATH budget change a one-line edit instead of a hunt across callers.
export const MAX_PATH_HEADROOM_DIR_SLUG = 40;

export function truncateDirBasename(name, { maxLen, suffix = '' } = {}) {
  if (!Number.isInteger(maxLen) || maxLen <= 0) {
    throw new Error('truncateDirBasename: maxLen must be a positive integer');
  }
  if (suffix.length >= maxLen) {
    // A negative clipLen makes String.slice(0, clipLen) count from the END of `name` (JS slice
    // semantics), silently producing a nonsensical fragment AND a result LONGER than maxLen —
    // defeating the exact MAX_PATH-headroom guarantee this helper centralizes (/sonnet-review
    // xhigh on this same batch, 2026-07-08; unreached by today's two callers, but latent).
    // suffix.length === maxLen is rejected too: it leaves zero room for any of `name`, which is
    // equally a caller error, not a valid "clip everything" request.
    throw new Error(
      `truncateDirBasename: suffix (${suffix.length} chars) must not exceed maxLen (${maxLen}) — ` +
        `must leave room for at least 1 character of name`,
    );
  }
  // String(name).slice(...) returns the full string when name.length ≤ the slice length, so no
  // separate length guard is needed for the "already short enough" case.
  const clipLen = maxLen - suffix.length;
  return String(name).slice(0, clipLen).replace(/-+$/, '') + suffix;
}
