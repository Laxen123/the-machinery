// scripts/coord/plan-cost-banner.mjs — the SINGLE authority for "does a plan carry a
// parseable 💰 Cost forecast banner?" (plan 1260).
//
// WHY one helper: the pre-push lint (lint-plan-cost-forecast.mjs) hard-blocks EVERY
// session's next push repo-wide until every ready/ plan carries a parseable banner —
// but the *movers* that put a plan INTO ready/ (move-plan.mjs → ready/, next-plan-id.mjs
// claim --ready) did NOT check the banner at promotion time. So a promotion of a
// pre-banner-era plan passed the mover, then blocked unrelated pushes for ALL sessions
// until a third party hand-fixed it (bit 3× on 2026-07-01/02: plans 1222, 286, 1228 —
// each promoted, each blocking, the next pusher not the promoter paying). The structural
// fix is to validate at promotion time with the EXACT predicate the lint uses — so the
// mover and the lint can never disagree about what counts as a valid banner. This module
// is that predicate + the shared help text; the lint AND the movers all call it.
//
// The parse itself is parsePlanMeta().cost.unknown from queue-drain.mjs — the exact
// signal the autonomous drain pauses on — so "banner OK here" means EXACTLY "the drain
// won't pause this plan for cost.unknown" and "the lint won't block a push over it."

import { parsePlanMeta } from './queue-drain.mjs';

// The example banners shown in every "missing/unparseable banner" rejection, so the
// fixer sees the shape in the same message that rejected them. ONE copy — reused by the
// lint and by both movers, so the guidance can never drift between them.
//
// plan 3748: the first three lines are the split `Cash … · Claude …` grammar
// — Cash is real money out (Google Places/Geocoding, Nimble, Apify, …) and
// gates the drain; Claude is model spend and is informational only. The
// fourth line keeps the ORIGINAL legacy single-figure form (unsplit,
// still-valid) so the reader sees both grammars accepted side by side.
export const COST_BANNER_EXAMPLES = [
  '> 💰 **Cost forecast:** Cash $0 · Claude $0 — frontend-only; no spend of either kind.',
  '> 💰 **Cost forecast:** Cash ~$2 · Claude ~$1 — Google Geocoding (low-hundreds reqs).',
  '> 💰 **Cost forecast:** Cash $0 · Claude ~$85 — a claude -p fan-out; no money leaves an account.',
  '> 💰 **Cost forecast:** ~$85 — needs a claude -p fan-out; operator-scoped.',
];

// true iff `content` (a plan body) carries a parseable Cost forecast banner. `basename`
// is the plan's file basename (e.g. "1260-Infra-….md"); it only feeds parsePlanMeta's
// id/slug fields, not the cost parse (cost is content-only), so a placeholder is fine
// when the id is not yet assigned (the next-plan-id mint path).
export function hasParseableCostBanner(basename, content) {
  return !parsePlanMeta(basename, content).cost.unknown;
}

// The shared ready/-banner GATE used by BOTH movers (move-plan → ready/, next-plan-id
// --ready), so the gate — not just the predicate — is one authority (plan 1260; the
// plan-1240 "never two diverging copies of one predicate" rule applied to the wrapper too).
// Returns the assembled rejection message when `content` lacks a parseable banner, or null
// when it's OK. `intro` is the caller-specific first sentence; the shared help block is
// always appended. The caller throws with ITS OWN error type — the only thing that
// legitimately differs between the two sites (move-plan: a fatal exit-2 usage error;
// next-plan-id: a plain exit-1 Error).
export function readyCostBannerError(basename, content, intro) {
  if (hasParseableCostBanner(basename, content)) return null;
  return `${intro}\n${costBannerHelp()}`;
}

// The actionable help block appended to both the lint's and the movers' rejection —
// the example banners + where to read more. Returned as a string (already indented) so
// each caller can prepend its own one-line header.
export function costBannerHelp() {
  return [
    '  Add a banner the autonomous drain can read (just below the SEED-WRITE banner):',
    ...COST_BANNER_EXAMPLES.map((e) => `    ${e}`),
    '',
    '  Cash is the axis the drain gates on (real money out); Claude (model spend) is',
    '  informational only and never pauses the drain. Both grammars above are parseable.',
    '',
    '  Without it the drain PAUSES on this plan (cost.unknown) and lint-plan-cost-forecast',
    "  then blocks every session's next push until it is fixed. See",
    '  docs/coord/plan-lanes.md § The two mandatory banners.',
  ].join('\n');
}
