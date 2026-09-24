// scripts/coord/mint-lines.mjs — the SINGLE authority for the claim lines
// next-plan-id.mjs prints on a successful mint (plan 1324, folding 1298).
//
// WHY one module: these lines used to live as string literals scattered
// across next-plan-id.mjs (and, historically, a now-retired Stop guard that
// scraped them from the session transcript). Keeping the templates HERE,
// adjacent to each other, means a reword updates every print site from one
// place instead of drifting out of sync (the plan-1293 /sonnet-review
// CONFIRMED finding).

import { PENDING_APPROVAL_FOLDER } from './build-index-lib.mjs';

// "next-plan-id: claimed 1293 (1 attempt)" — printed once per successful claim.
export const CLAIMED_LINE = (id, attempts) =>
  `next-plan-id: claimed ${id} (${attempts} attempt${attempts > 1 ? 's' : ''})`;

// The id-bearing line of the default-mint banner (mintBanner renders it with
// a leading space inside the box; the guard matches unanchored, so the space
// stays a print-site concern). Plan 1371: the default mint target moved from
// `drafting/` to `pending-approval/` — the wording still says "NOT
// auto-drainable" (still true: the ready/-queue drain reads ready/ only) but
// no longer implies the minting session must route it same-session (D4).
export const MINT_BANNER_LINE = (id) =>
  `next-plan-id: plan ${id} minted into ${PENDING_APPROVAL_FOLDER}/ — NOT auto-drainable.`;
