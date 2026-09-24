// Pure, git-free logic for the `redgreen` session-close check (plan 649).
//
// Answers ONE question for the operator piloting ~7 parallel sessions: "can I
// close this session?" 🟢 GREEN = yes (work landed / nothing in flight); 🔴 RED
// = no (uncommitted work, unlanded branch, queued for a land slot, or an
// ACTIVE/PAUSED/LANDING board row). All git/IO lives in redgreen.mjs; this file
// is pure so the verdict rule is unit-testable without a repo.
//
// The four close-signals (calibrated with the operator 2026-06-15):
//   1. working tree clean (no uncommitted changes)
//   2. branch commits are on origin/master (landed) — or this is a main checkout
//   3. slug NOT in the landing queue doc (not waiting for a land slot; on the
//      coord ref refs/heads/coord/landing-queue since plan 3973)
//   4. no 🔄 ACTIVE / ⏸ PAUSED / 🟢 LANDING board row for the slug

import { parseQueue } from './landing-queue-lib.mjs';
import { splitBoard, cellsOf, isSeparator, IN_FLIGHT_STATES } from './board-lib.mjs';

// Board state-column values (cell 2) that mean "this worktree is still in
// flight" — work is parked or mid-merge, so the session is NOT closeable.
// plan 2818: board-state vocabulary has ONE home (board-lib.mjs) — this used to be a
// second hand-copied literal array that could silently drift from
// `reconcile-board.mjs`'s own copy; both now import/re-export the same constant so this
// module's own computeVerdict below and every external consumer stay in sync with it.
export { IN_FLIGHT_STATES };

// `worktree-<slug>` → `<slug>`. Any other branch (master, a detached HEAD, an
// ad-hoc branch) → null, meaning "no worktree row to look up" — the session is
// treated as a main checkout where only the clean-tree signal applies.
export function slugFromBranch(branch) {
  const m = /^worktree-(.+)$/.exec((branch || '').trim());
  return m ? m[1] : null;
}

// Is `slug` present anywhere in the landing queue? (waiting for / holding a land
// slot). Returns false for a null slug or unparseable content.
//
// Takes the document TEXT or the parse `readQueueDoc` already produced: the accessor validates
// (and therefore parses) every doc it returns, so a caller holding that result would otherwise
// parse the same text a second time on every statusline tick (plan 3973 review round 3, key
// 603f09).
export function queueHasSlug(queueContentOrParsed, slug) {
  if (!slug || !queueContentOrParsed) return false;
  try {
    const parsed =
      typeof queueContentOrParsed === 'string'
        ? parseQueue(queueContentOrParsed)
        : queueContentOrParsed;
    return parsed.entries.some((e) => e.slug === slug);
  } catch {
    return false;
  }
}

// The board row's state column (cell 2) for `slug`, or null if there is no row
// (post-land, or never claimed). Column-aware (not a substring scan) so resume
// prose mentioning another row's state can't false-match.
export function boardStateForSlug(boardContent, slug) {
  if (!slug || !boardContent) return null;
  let body;
  try {
    ({ body } = splitBoard(boardContent));
  } catch {
    return null;
  }
  let seenHeader = false;
  for (const line of body.split('\n')) {
    const cells = cellsOf(line);
    if (!cells || cells.length < 3 || isSeparator(line)) continue;
    if (!seenHeader) {
      seenHeader = true; // first table row = header
      continue;
    }
    if (cells[0] === slug) return cells[2];
  }
  return null;
}

// Can this tick's queue snapshot be trusted to say "not queued"? Pure, so the rule is testable
// without a repo (plan 3973 review round 2, keys 38da97 / c9673a / a4bb60). Inputs are what
// redgreen.mjs already knows after its ONE combined fetch:
//   queueFetched  the combined `master + queue refspec` fetch succeeded, so the tracking ref is
//                 as fresh as the board
//   masterFetched the master-only fallback fetch succeeded (implied by queueFetched)
//   source/fault  the accessor's own answer for this read
// The dangerous direction is a GREEN close light over a live queue slot, so anything short of a
// proven-fresh view is "unverified" — including the post-cut-over shape where the tracking ref is
// missing and the master doc is the tombstone, which reads as an empty queue and is not one.
export function queueSnapshotUnverified({ queueFetched, masterFetched, source, fault }) {
  if (fault) return true;
  if (queueFetched) return false; // this tick refreshed the ref itself
  // Pre-cut-over the ref legitimately does not exist and the live table is origin/master's — the
  // fallback fetch refreshed that, so the snapshot is as good as the board's.
  if (source === 'master') return !masterFetched;
  return true;
}

// The verdict. Inputs are already-resolved booleans/strings (git + IO done by
// the caller):
//   slug            — worktree slug, or null for a main checkout
//   dirty           — uncommitted changes in the working tree
//   landed          — HEAD is an ancestor of origin/master (only meaningful when slug)
//   inQueue         — slug present in the landing queue doc
//   queueUnverified — the queue snapshot could not be refreshed this tick (see above), so
//                     `inQueue: false` is unproven rather than a fact
//   boardState      — board row state cell, or null
//   boardUnverified — the board text is not provably current: it did not come from origin/master
//                     (a HEAD fallback, an empty read, a coordination lookup that threw) or that
//                     ref itself was never refreshed this tick, so the row state read off it —
//                     `null` or a terminal value alike — is unproven. Same fail-safe direction as
//                     queueUnverified
// Returns { light: 'green'|'red', reasons: string[], slug }.
export function computeVerdict({
  slug,
  dirty,
  landed,
  inQueue,
  queueUnverified,
  boardState,
  boardUnverified,
}) {
  const reasons = [];
  if (dirty) reasons.push('uncommitted changes in the working tree');
  if (slug) {
    if (!landed) reasons.push('branch has commits not yet on origin/master (unlanded)');
    if (inQueue) reasons.push('in the landing queue (waiting for a land slot)');
    else if (queueUnverified)
      reasons.push(
        'the landing queue could not be refreshed this tick — "not queued" may be stale ' +
          '(check with `node scripts/landing-queue.mjs status`)',
      );
    if (boardState && IN_FLIGHT_STATES.includes(boardState))
      reasons.push(`board row is ${boardState}`);
    // An unverified board is reported whether or not a row was FOUND (plan 3973 review round 4,
    // key 693dc8): a stale copy can carry a terminal row (`✅ DONE`) for a slug the current board
    // has flipped back to 🔄 ACTIVE, and gating the warning on `!boardState` printed a green
    // close light over exactly that.
    else if (boardUnverified)
      reasons.push(
        'the board could not be read from origin/master this tick — this slug’s row state may be ' +
          'stale (check `docs/handoff/board.md`)',
      );
  }
  return { light: reasons.length ? 'red' : 'green', reasons, slug: slug || null };
}
