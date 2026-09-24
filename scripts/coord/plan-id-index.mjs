// scripts/coord/plan-id-index.mjs — moved from scripts/done-worktree-lib.mjs (plan 3959 T2).
//
// Generic plan-file lookup: given a `git ls-files docs/superpowers/plans` listing and a set of
// plan ids, resolve each id's live and/or archived path in ONE pass. No fs, no git, no
// vetapp-specific vocabulary — pure string/regex work over an already-read listing, Rule 3
// compliant (docs/runbooks/scripts-module-layout.md § Rule 3): no import at all, in fact.

// plan 1364 review R1 (F6, CONFIRMED): resolvePlanRelById re-splits + re-scans the ENTIRE
// `git ls-files docs/superpowers/plans` listing (1300+ files in this repo) on every call —
// done-worktree.mjs's batch close-out called it up to 4x per member (rowSlugOf's live+archived
// lookups, then archiveBatchMembers' own live+archived lookups), repeating the full scan up to
// 20x for a 5-member batch. This resolves EVERY member id against lsFiles in exactly ONE pass,
// building a `Map<id, {live, archived}>` both call sites can share. Matching rule + first-hit
// semantics are byte-identical to calling resolvePlanRelById per id per side — this is purely a
// batching optimization, not a behavior change. `ids` may contain ids not present in lsFiles;
// their map entries stay `{live: null, archived: null}`.
export function buildPlanIdIndex(lsFiles, ids) {
  const wanted = new Set((ids || []).map((id) => String(id)));
  const index = new Map();
  for (const id of wanted) index.set(id, { live: null, archived: null });
  const re = /(^|\/)(\d{3,})-[^/]*\.md$/;
  for (const raw of String(lsFiles || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(re);
    if (!m) continue;
    const id = m[2];
    if (!wanted.has(id)) continue;
    const rec = index.get(id);
    if (line.includes('/archive/')) {
      if (rec.archived == null) rec.archived = line;
    } else if (rec.live == null) {
      rec.live = line;
    }
  }
  return index;
}

// plan 1364/1454: a batch member's BOARD row slug is its plan BASENAME (claim-plan.mjs batch's
// `rowSlug`, NOT the plan id), recovered from the buildPlanIdIndex map (live folder, else
// archive/). Lives here next to buildPlanIdIndex — its sole input — so done-worktree.mjs's
// close-out AND claim-plan.mjs's derail reconcile derive the basename through ONE primitive
// instead of two drifting scans (plan 1455 review-fix; was defined in done-worktree.mjs, whose
// heavy import graph claim-plan.mjs cannot safely pull in). Pure.
export function rowSlugFromIndex(planIndex, id) {
  const rec = planIndex.get(String(id));
  const rel = rec ? rec.live || rec.archived : null;
  return rel ? rel.split('/').pop().replace(/\.md$/, '') : null;
}
