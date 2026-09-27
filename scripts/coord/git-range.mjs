// scripts/coord/git-range.mjs — the ONE git range/end-ref parser (plan 3618, finding d6a14d).
//
// Moved out of the frozen-evidence gate (a project-side script), which owned it first (plan 3306) and
// re-exports it unchanged below for its own existing callers/tests. scripts/coord/review-round-cap.mjs
// needed the exact same "which ref does this range actually land on" logic (a `..`/`...` range
// is charged to its END ref) and importing assert-frozen-evidence.mjs directly would have pulled
// an unrelated push-gate module (compute-push-diff.mjs, node:crypto) into the review-cap ledger
// for one four-line function — the wrong dependency direction. This module has zero imports of
// its own, matching scripts/coord/worktree-porcelain.mjs's precedent for a shared leaf helper.
//
// Both callers must stay byte-identical: a malformed trailing range (`abc..`) resolves to
// `HEAD`, never the pre-range text — the bug scripts/coord/review-round-cap.mjs's own `rangeEndRef`
// had before this move (finding d6a14d: it returned the whole malformed token, which then
// happened to still parse as a plan branch and charged the WRONG plan).

/** The end ref of a git range (`A..B` / `A...B` → `B`); a bare ref is its own end. */
export function endRefOf(range) {
  if (typeof range !== 'string' || !range) return null;
  const m = range.match(/\.{2,3}/);
  if (!m) return range.trim() || null;
  const tail = range.slice(m.index + m[0].length).trim();
  return tail || 'HEAD';
}

/**
 * Every pushed range's end ref, de-duplicated in order. A multi-ref push resolves to
 * several ranges; judging only the last one's tree would let a clobber on any earlier
 * pushed ref through while the scope gate had already unioned its files.
 */
export function endRefsOf(ranges) {
  const out = [];
  for (const r of ranges || []) {
    const ref = endRefOf(r);
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}
