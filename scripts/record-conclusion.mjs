#!/usr/bin/env node
// scripts/record-conclusion.mjs  (plan 2033)
// Record the adversarial conclusion-review verdict in the worktree branch's handoff
// SESSION entry, so a later `node scripts/done-worktree.mjs <slug>` land clears the
// CONCLUSION_REVIEW seam instead of halting at it.
//
// The review is MANDATORY when the land's seed diff OVERWRITES an established
// world-claim field — the configured `land.worldClaimFields` set in coord.config.json
// (today: operationalStatus, clinicConfirmation, chainId, bookingPlatform, externalId).
// Conclusion-review is a CORE landSeam since plan 3961 T2.6 (scripts/coord/land/seams-core.mjs):
// the seam's mechanism is generic over sharded record files, and only this field list is project
// vocabulary, read as a parameter rather than a hardcoded constant — this script (still project-
// specific in its own right, since it drives the plan-767 refuter workflow) is core-adjacent
// tooling for that same seam, not the seam's owner. Before recording, run
// ONE adversarial refuter (Sonnet-tier) over the plan body + the seed diff + the
// verification note, prompted to REFUTE the conclusion — name a source that could
// contradict the claim; state what question the gathered evidence does NOT answer
// (the plan-767 template: sources proved the named brand absent, not the premises
// empty). Three honest verdicts:
//   UPHELD         — the refuter failed to refute; the conclusion stands. Clears the gate.
//   REFUTED        — the refuter found a contradicting source / fatal gap. Recorded
//                    visibly; the gate still halts (fix the seed rows, re-review).
//   UNDERDETERMINED — the evidence doesn't answer the question; the missing source is
//                    named in the detail. The gate still halts (chase the source, or
//                    the operator waives via --resume CONCLUSION_REVIEW).
// The detail — the missing-source / unanswered-question line — is MANDATORY for every
// verdict: it IS the audit-trail artifact the gate exists to produce (plan 2033 item 4;
// recorded in the session entry, never in seed verifications[] — a gate must not write
// the data it audits).
//
// The marker — `Conclusion: <VERDICT>[:detail] @ <sha>` — is honored by the spine ONLY
// while <sha> is the current branch HEAD (done-worktree-lib.parseConclusionMarker's
// staleness guard). So run this AFTER your final commit; if you push more commits
// afterwards, re-run it (the old marker goes stale and the land re-checks).
//
// Usage (run from INSIDE the worktree, after the refuter's verdict):
//   node scripts/record-conclusion.mjs <UPHELD|REFUTED|UNDERDETERMINED> "detail" [--slug <slug>] [--no-push] [--dry]
//   node scripts/record-conclusion.mjs repin [--slug <slug>] [--no-push] [--no-fetch] [--dry]
//
// Since plan 2042 the record-CLI protocol (session-file resolution, plan-1105
// branch-refuse guard, plan-1286 coord-checkout routed write, plan-1528 repin) lives in
// scripts/coord/record-marker-cli.mjs, shared with record-review.mjs and record-wiki.mjs —
// this file is the conclusion-family descriptor plus the commitConclusionMarker wrapper
// the tests exercise.

import { fileURLToPath } from 'node:url';
// plan 3959 T2: MARKER_FAMILIES moved to scripts/coord/review-markers.mjs.
import { MARKER_FAMILIES } from './coord/review-markers.mjs';
import { makeCommitMarker, runRecordMain } from './coord/record-marker-cli.mjs';

export const DESC = {
  tool: 'record-conclusion',
  scope: 'conclusion',
  family: MARKER_FAMILIES.conclusion,
  nothingHint: 'review + record first',
  // Unlike record-wiki (where only SKIP needs a reason), EVERY verdict carries the
  // missing-source / unanswered-question line — it is the artifact the gate exists
  // to produce, for UPHELD as much as the others ("what source could contradict this,
  // and what question does the evidence not answer").
  detailRequired: (_verdict, detail) =>
    detail
      ? null
      : 'record-conclusion: a detail line is required for every verdict — the missing-source / ' +
        'unanswered-question line the refuter produced, e.g.: node scripts/record-conclusion.mjs ' +
        'UPHELD "refuter checked bolagsverket + the premises\' new-tenant angle; no contradicting source found"',
};

// Commit the conclusion marker for `slug` into the session file `sf` under MAIN — the
// conclusion-family instance of the shared commit engine (record-marker-cli.
// makeCommitMarker; seams _git/_gitRetry/_push/retryOpts are injectable for tests).
// Signature: (MAIN, sf, { slug, verdict, detail?, sha, noPush?, commitMsg?, seams… }).
export const commitConclusionMarker = makeCommitMarker('conclusion');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(runRecordMain(DESC, process.argv.slice(2)));
  } catch (e) {
    console.error('record-conclusion:', e.message);
    process.exit(1);
  }
}
