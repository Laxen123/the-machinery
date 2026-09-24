// scripts/coord/worktree-porcelain.mjs (plan 2058)
// THE ONE `git worktree list --porcelain` block parser. Zero-dependency (no imports at
// all) so it can be pulled in BEFORE `pnpm install` by cloud-boot scripts — see
// cloud-checkout-preflight.mjs's own header for why it may not import coord-git.mjs.
// land-lib.mjs re-exports parseWorktreePorcelain from here (plan 1663 designated it "THE
// one parser"); cloud-checkout-preflight.mjs (guard 4) imports it directly. Keeping a
// single implementation means the two enumeration paths cannot silently drift on what
// counts as a live/prunable/branchless worktree.
//
// Block separator is `\n\s*\n+` (review [0], sonnet-review high @ ea069240ed), not the
// stricter `\n\n+` land-lib.mjs used pre-extraction: cloud-checkout-preflight.mjs's own
// prior parser tolerated a whitespace-only blank line (e.g. a stray `\r` before the
// second `\n`), and a stricter split would merge two blocks together — silently
// dropping every worktree entry after the first from guard 4's live-worktree count.
function flagLine(lines, keyword) {
  const line = lines.find((l) => l === keyword || l.startsWith(`${keyword} `));
  return {
    present: !!line,
    reason: line?.startsWith(`${keyword} `) ? line.slice(keyword.length + 1).trim() : null,
  };
}

export function parseWorktreePorcelain(out) {
  const entries = [];
  for (const block of (out || '').split(/\n\s*\n+/)) {
    const lines = block.split('\n');
    const wtLine = lines.find((l) => l.startsWith('worktree '));
    if (!wtLine) continue;
    const branchLine = lines.find((l) => l.startsWith('branch '));
    // plan 2654: git emits `HEAD <sha>` for EVERY entry (attached or not). Captured so the
    // detached-worktree diagnostic can name the sha the tree is stranded at without a second
    // git spawn — a bare "it is detached" leaves the reader unable to tell whether the
    // detached tip carries commits the branch ref lacks.
    const headLine = lines.find((l) => l.startsWith('HEAD '));
    const locked = flagLine(lines, 'locked');
    const prunable = flagLine(lines, 'prunable');
    entries.push({
      path: wtLine.slice('worktree '.length).trim(),
      branch: branchLine
        ? branchLine
            .slice('branch '.length)
            .trim()
            .replace(/^refs\/heads\//, '')
        : null,
      head: headLine ? headLine.slice('HEAD '.length).trim() : null,
      detached: lines.includes('detached'),
      locked: locked.present,
      lockReason: locked.reason,
      prunable: prunable.present,
      prunableReason: prunable.reason,
    });
  }
  return entries;
}
