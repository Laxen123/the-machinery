#!/usr/bin/env node
// scripts/record-wiki.mjs  (plan 1074)
// Record the wiki growth-checkpoint decision in the worktree branch's handoff
// SESSION entry, so a later `node scripts/done-worktree.mjs <slug>` land auto-skips
// the WIKI_CHECKPOINT seam instead of halting at it.
//
// The decision is MANDATORY when the land diff touches a subject the wiki owns (a
// platform adapter, the price-pipeline inspectors, a pricing-concept module, or the
// seed chains[] registry). Two honest answers:
//   WROTE  — you folded the durable learning into the matching wiki/ page (bumped its
//            `updated:`, appended to wiki/log.md). Detail = the page(s).
//   SKIP   — this plan taught the wiki nothing durable. Detail = WHY (recorded
//            VISIBLY in the session entry, so a silent always-skip can't quietly
//            decay the checkpoint to a toothless advisory — the plan-1074 caveat).
//
// The marker — `Wiki: <WROTE|SKIP>[:detail] @ <sha>` — is honored by the spine ONLY
// while <sha> is the current branch HEAD (done-worktree-lib.parseWikiMarker's
// staleness guard). So run this AFTER your final commit; if you push more commits
// afterwards, re-run it (the old marker goes stale and the land re-checks).
//
// Usage (run from INSIDE the worktree, after deciding):
//   node scripts/record-wiki.mjs <WROTE|SKIP> ["detail / pages / reason"] [--slug <slug>] [--no-push] [--dry]
//   node scripts/record-wiki.mjs repin [--slug <slug>] [--no-push] [--no-fetch] [--dry]
//   <slug> defaults to the current branch with the `worktree-` prefix stripped; if given explicitly
//   it must name THIS worktree's slug — like record-review, plan 1105 REFUSES (exit 2) when invoked
//   from a checkout other than worktree-<slug> (ambient HEAD would otherwise pin a sha the land rejects).
//
// Since plan 2042 the record-CLI protocol (session-file resolution, plan-1105
// branch-refuse guard, plan-1286 coord-checkout routed write, plan-1528 repin) lives in
// scripts/coord/record-marker-cli.mjs, shared with record-review.mjs and
// record-conclusion.mjs — this file is the wiki-family descriptor plus the
// commitWikiMarker wrapper the tests exercise.

import { fileURLToPath } from 'node:url';
// plan 3959 T2: MARKER_FAMILIES moved to scripts/coord/review-markers.mjs.
import { MARKER_FAMILIES } from './coord/review-markers.mjs';
import { makeCommitMarker, runRecordMain } from './coord/record-marker-cli.mjs';

export const DESC = {
  tool: 'record-wiki',
  scope: 'wiki',
  family: MARKER_FAMILIES.wiki,
  nothingHint: 'decide + record first',
  detailRequired: (decision, detail) =>
    decision === 'SKIP' && !detail
      ? 'record-wiki: SKIP requires a reason (recorded visibly so the checkpoint keeps its teeth): ' +
        'node scripts/record-wiki.mjs SKIP "why this plan taught the wiki nothing durable"'
      : null,
};

// Commit the wiki marker for `slug` into the session file `sf` under MAIN — the
// wiki-family instance of the shared commit engine (record-marker-cli.makeCommitMarker:
// lock-retry add/commit, porcelain no-op short-circuit, half-land tolerance, push via
// pushMasterWithRebase unless noPush; `commitMsg` overrides the subject for repin).
// Signature: (MAIN, sf, { slug, decision, detail?, sha, noPush?, commitMsg?, seams… }).
export const commitWikiMarker = makeCommitMarker('wiki', { verdictKey: 'decision' });

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(runRecordMain(DESC, process.argv.slice(2)));
  } catch (e) {
    console.error('record-wiki:', e.message);
    process.exit(1);
  }
}
