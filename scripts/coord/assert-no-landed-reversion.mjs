#!/usr/bin/env node
// scripts/coord/assert-no-landed-reversion.mjs (plan 2274 Fix 2; rule REFORMULATED by plan 2585)
//
// THE INCIDENT. Plan 2233's LAND_BLOCKED_HOLDING recovery (2026-07-22) hit a REBASE_CONFLICT
// and the rebuild-from-evidence strategy was right in spirit — but the rebuild subagent
// resolved backend/scripts/_places_geo.py by restoring the branch's OLD, pre-fork whole-file
// copy instead of patch-replaying the plan's own diff onto current origin/master. Git never
// flagged this as a conflict (the "resolution" was accepted), so the land silently reverted
// 4 plans' worth of intervening work to that file — caught only ~66 minutes later by a
// 452-failure pre-push pytest gate.
//
// WHY THE FIRST RULE WAS REPLACED (plan 2585, established from the incident's own refs).
// The plan-2274 rule diffed base->origin/master and base->branch and flagged every master
// hunk the branch had no OVERLAPPING hunk for. Two things were wrong with it:
//
//   1. It reported STALENESS as REVERSION. Under a MERGE-based land — which is what
//      done-worktree performs — a region the branch never touched resolves to master's side
//      unconditionally, so nothing is lost. The old rule flagged exactly those regions, i.e.
//      every file master changed that the branch did not. Measured on
//      batch-2026-07-27-prepush-hook-train: 60+ phantom hunks across 14 files, against a
//      branch whose real diff was 5 files, with a `git merge-tree` dry run showing 13 of the
//      14 byte-identical to origin/master in the merged tree. Exposure scaled with master's
//      land rate — worst exactly on the busiest days — and a safety gate that cries wolf
//      teaches sessions to wave it through.
//   2. It never caught its own motivating case, and structurally could not. The 2233 rebuild
//      is commit 343467e2b7, whose SOLE parent a67a4906046d is a plain origin/master ancestor
//      (the branch was rebuilt ON fresh master). So merge-base(HEAD, origin/master) ==
//      origin/master, the base->master diff is EMPTY, and the old rule's loop never executed.
//      Zero findings on the very shape it was written for. (The heal is 8ee912385c, "restore
//      master's 4-plan additions to _places_geo.py"; the four victims are plans 2249, 2255,
//      2219, 2254.)
//
// THE CHECK (the rule this file now pins). The axis is INVERTED: stop asking "what did master
// change that the branch did not?" (a staleness question) and ask "what does this land REMOVE
// from origin/master?". That is answered exactly by materialising the tree the land would
// produce and diffing it against master:
//
//     T = git merge-tree --write-tree <masterRef> <branchRef>
//     candidates = the DELETIONS of `git diff <masterRef> T`
//
// Staleness immunity is now STRUCTURAL, not tuned: content the branch never absorbed is
// re-supplied by the 3-way merge, so it appears UNCHANGED in diff(masterRef, T) and can never
// become a finding — for a freshened branch, a stale-based one, and the resume paths alike
// (which plan 2433's masterRef pin deliberately leaves on live origin/master, and which is
// where the 2026-07-27 false positive came from).
//
// Deletion alone is NOT reversion — every refactor deletes lines — so the discriminator is
// ATTRIBUTION, not volume. For each file past the removal floor, walk the last
// ATTRIBUTION_HISTORY_DEPTH commits touching it on masterRef, keep the ones whose subject
// names an authoring plan id that is NOT one of this branch's own, and intersect the lines
// those commits ADDED with the lines this land REMOVES. MIN_ATTRIBUTED_LINES of overlap is
// the trip. Trivially short lines (`}`, blank, `)`) are excluded from both sides so
// boilerplate coincidence cannot accumulate a finding. Measured on the real incident
// (masterRef=a67a4906046d, branchRef=343467e2b7): 810 files changed, 3 past the removal floor,
// one of them a seed shard the exclusion below drops, and _places_geo.py reports 347 removed /
// 290 attributed to [2249, 2255, 2219, 2254] — the exact four plans the heal commit names,
// derived from content alone. Whole probe: ~276 ms.
//
// WHAT THIS DELIBERATELY DOES NOT COVER (named, not tuned away):
//   - Removals under MIN_ATTRIBUTED_LINES. Deletion alone cannot be flagged (every refactor
//     deletes), so a floor is structural, not a tuning knob: the old rule's any-size flagging is
//     exactly what made it fire on every busy-master branch. A revert smaller than the floor is
//     out of scope here and belongs to review, not to a deterministic gate. (Review F5.)
//   - Generated WHOLE-FILE-rewritten data trees: the sharded seed and the derived pipeline
//     data (coord.config.json's seedShardDir / seedLaneFile / derivedShardDirs /
//     derivedGlobalFiles). A shard is re-`json.dump`ed in full by every apply, so a legitimate
//     re-apply always removes lines another plan added — the same prototype run above flagged
//     clinic-2126.json (-46, 29 attributed to plan 2205) for precisely that reason. Those
//     trees have their own control: the plan-1300/1867 SCOPED LANDING MUTEX serialises
//     overlapping clinic shard-sets and forces rebase-then-re-apply. Including them here would
//     only manufacture the false-positive class this rule exists to end.
//   - A branch that deliberately deletes another plan's recently-landed code. That IS reported,
//     by design — the message names the culprit plans so the removal can be read and confirmed as
//     intentional. Since plan 3832 that report is ADVISORY (§ DEMOTED TO ADVISORY below), so
//     there is nothing to release and no hatch to reach for.
//
// FAIL-OPEN, unchanged from plan 2274: ANY git failure returns [] and never throws — an
// unresolvable ref, a git older than 2.38 (no `merge-tree --write-tree`), and, deliberately, a
// merge-tree CONFLICT exit. A conflict is not this lint's business: the spine's own
// rebase/merge surfaces it as REBASE_CONFLICT / LAND_BLOCKED_HOLDING, and a conflicted merge
// cannot silently drop anything. This is a diagnostic, not a content-correctness prover.
//
// PLAN 2908 T1/E2 — SHALLOW-HISTORY DOWNGRADE, in `detectLandedReversion`, BEFORE the
// attribution walk above ever runs on a candidate: on a shallow clone, `git log` for a
// path collapses to the graft boundary commit, which then appears to have ADDED every file in the
// repo — the walk above cannot distinguish that from genuine authorship and would confidently
// misattribute a land's removals to whatever plan the boundary commit happens to name. Such a
// candidate is reported `unsound: 'shallow-history'` instead — no plan ids, no `attributed` —
// never a confident, plan-named accusation built on an artifact of clone depth. No `git fetch` /
// `--unshallow` runs inside this file: a land preflight must stay offline and bounded. The signal
// becomes a loud WARN (`unsoundWarnBlock` below), never a halt, in BOTH callers — done-worktree's
// preflight and this file's own CLI.
//
// RULED OUT, 2026-08-07 (plan 2917) — do not resurrect: plan 2908's T2, a structural "master
// never touched this file since the branch diverged" exemption for the case a land LEGITIMATELY
// rewrites another plan's recently-landed lines (defect class 2). It was specified, then
// implemented and DISPROVEN on its own branch, on two independent grounds:
//
//   1. FORK-POINT COLLAPSE. 2908's E1 base — the threaded `base` opt, else
//      `git merge-base masterRef branchRef` — collapses to `masterRef` itself, because
//      done-worktree runs this lint POST-REBASE with `masterRef` pinned to the very sha it just
//      rebased HEAD onto (plan 2433). `diff(B, masterRef)` is then empty for every path and the
//      exemption fires universally: implementing E1 literally reds `acceptance 2`, both rename
//      cases, and F2 in this file's own suite — exactly the "residual still blocks" cases 2908's
//      AC3 required to stay green. Capturing the merge-base BEFORE the rebase (the 2026-08-06
//      cloud drain built it) only moves the collapse one step earlier: a branch rebuilt onto
//      fresh master — the standard LAND_BLOCKED_HOLDING recovery — and PRECISELY the plan-2585
//      incident shape, a branch cut fresh from the tip that then stale-restores a file, both
//      have merge-base == the master tip. Measured on the incident fixture: 0 findings with the
//      spine-realistic pre-rebase base, 1 (correct) finding without it. The grilling closed the
//      remaining escape: in that fixture the branch's TRUE fork point IS the master tip, so even
//      a perfectly captured, durably recorded fork point (stamped at cut-worktree time, say)
//      exempts a stale restore of work landed BEFORE the fork. ANY "since the branch diverged"
//      criterion is structurally blind to this guard's core case. The difference between a
//      deliberate rewrite and a stale copy is INTENT, not topology.
//   2. ENDPOINT EQUALITY IS NOT "UNTOUCHED". Master editing a file and later restoring the
//      original bytes diffs empty across the two endpoints while having genuinely touched it.
//
// So defect class 2 is ACCEPTED. Plan 2917's remedy was `ALLOW_LANDED_REVERSION=1`, made auditable
// by the message naming each attributed commit (short sha + subject); since plan 3832 the remedy
// is simply that nothing halts — the message is a report and the named commits are what you read. No base, fork point, or intervening-commit range is threaded into
// `detectLandedReversion` or through done-worktree; the landing spine is untouched. A future
// plan should NOT re-file a history-topology exemption in any form. The genuinely different
// direction this block once left open — a CONTENT-based stale-copy detector — is itself now
// RULED OUT, with measurements: see the next block.
//
// RULED OUT, 2026-08-16 (plan 3210) — do not resurrect: a CONTENT-based stale-copy detector
// (does this removal restore an older revision of the file verbatim?), the one direction the
// block above left open. Plan 3182 (2026-08-15) is what motivated building it: it halted while
// REWRITING 32 lines plan 3035 landed in `backend/scripts/apply-homepage-verdicts.py` with 254
// lines of new replacement code, released only after an operator manually reviewed the diff and
// set `ALLOW_LANDED_REVERSION=1`. Three independent formulations were built and measured
// 2026-08-15 against two controls — the gate suite's own `acceptance 2` incident fixture (must
// stay BLOCKED) and an in-place REWRITE of the same landed blocks (must be EXEMPTED) — plus
// plan 3182's real branch as a third, live rewrite case:
//
//   | Formulation                                                            | Incident (must BLOCK)                      | Rewrite (must EXEMPT)                      | Verdict                |
//   | ----------------------------------------------------------------------| ------------------------------------------- | ------------------------------------------- | ---------------------- |
//   | Resurrection — are the added lines ones master previously deleted?    | reads as novel ⇒ EXEMPT ❌                  | 254 novel vs 7 resurrected ⇒ EXEMPT ✅       | misses the incident     |
//   | Nearest-revision — is the content closer to an older rev than current?| d(older)=40 < d(current)=200 ⇒ BLOCK ✅     | d(older)=190 < d(current)=350 ⇒ BLOCK ❌    | halts the rewrite       |
//   | Successor-similarity — does each dropped line have a lookalike added? | 124/160 matched ⇒ reads as rewrite ❌       | 0/160 matched ⇒ reads as restore ❌         | inverted on both        |
//
// Why it cannot be repaired, as opposed to merely mis-tuned:
//
//   1. A STALE COPY IS AN OLDER VERSION OF THE SAME CODE, so it is MAXIMALLY similar to the
//      lines it replaces. Every "is the new text derived from the old text" measure therefore
//      scores a restore HIGHER than a genuine rewrite. The successor-similarity row is not a
//      threshold artifact; it is inverted.
//   2. SIZE DOMINATES ANY DISTANCE METRIC. Older revisions are usually smaller, so a branch that
//      adds substantial new code is "nearer" to any ancestor than to current master. The
//      nearest-revision row fails on exactly this.
//   3. LOCALITY IS UNAVAILABLE. Both controls collapse to a SINGLE diff hunk, so a per-hunk "were
//      these removals replaced in place" test has nothing to read.
//   4. GIT ITSELF CANNOT ARBITRATE. In both shapes only ONE side changed the file, so the
//      three-way merge is identical. There is no conflict to surface.
//
// The invariant behind all four: the difference is whether the author had master's current
// version in front of them when they wrote theirs. No tree records that. Extending the block
// above: intent is invisible to topology AND to content.
//
// So a future plan should NOT re-file a content-based stale-copy detector either. What DOES work
// is measuring CONSEQUENCE instead of intent: run the culprit plans' own test files against the
// merged tree — a restore deletes behaviour and reds them, a true rewrite keeps them green. That
// is `culpritTestTargets` / `runCulpritTests` / `culpritTestEvidence` below (plan 3210 Part 2),
// feeding a scope-pinned, reviewer-backed release (Part 3) rather than the bare env var alone.
//
// PLAN 3246, 2026-08-16 — THE THREE FALSE-POSITIVE / MISNAMING CLASSES, replayed then fixed.
//
// Six-plus hard-blocked lands (2853, 2875, 2855 x2, 2882, 2892, 2969) came from three shapes that
// are not reversions at all, or are reversions the refusal named the WRONG plan for. Each cost a
// re-queue from the head of the landing queue plus an override — and a guard that cries wolf is
// what teaches sessions to reach for the hatch, which is the expensive failure mode this file's
// own header argues against. All three predate the 2908/2917/3210 reworks, so step 0 was to
// REPLAY them against the reworked gate before touching anything. Measured 2026-08-16: all four
// fixture shapes still fired. Nothing had been closed; each fix below is against a reproduced
// defect, and each has its regression fixture in this file's suite.
//
//   CLASS 1 — the FRESHEN merge. `Merge origin/master into worktree-<id>` has the BRANCH as its
//     FIRST parent, so its first-parent patch is everything MASTER added since that branch
//     forked, while `authoringPlanId` reads the branch's own id out of the subject. Newer than
//     the real authoring commits, it won newest-wins and took their lines. The refusal then
//     named an INNOCENT plan (2404 on plan 2853's land; 2855 on 2875's — commits bd6656e29 and
//     f0f7392fa, both genuinely freshen merges). FIX: walk master's own first-parent SPINE
//     (`--first-parent` on the attribution log), which is the honest record of what master
//     gained and when. Land merges — the only plan-id carrier on a real land, per F4 — are ON
//     that spine and are kept; off-mainline branch bookkeeping is dropped. No attribution is
//     lost, only corrected: a branch's lines still reach master through its land merge.
//   CLASS 1 variant — a whole-file RE-ADD (firing 2892) was credited every line in the file
//     forever after. FIX is ORDERING, not exclusion: modifying commits are attributed first,
//     file-creations second, so a re-add claims only lines no author accounts for while a
//     genuinely new file still credits its creator. See `attributeRemovals`.
//   CLASS 2 — a table RE-PAD read as deletion. Plan 2882 proved this STRUCTURAL: adding the one
//     glossary row docs/PIPELINE.md's write-rule REQUIRES of a new-concept plan re-pads every
//     column, so every conforming land tripped the gate against a strict-superset table. FIX:
//     `netRemovedLines` — a removed line that survives in the SAME file's added set modulo
//     whitespace was never removed. Distinct from the ruled-out similarity detector above: this
//     is identity modulo formatting within one land's own two sides of one file, and it scores,
//     ranks and thresholds nothing.
//   CLASS 3 — a single-owner RELOCATION stays a HALT, deliberately (operator ruling R1 + the
//     3210 disproof forbid a content-based release). Only the REPORTING improved: `--explain`
//     now names the file a verbatim line moved to, where before every relocated line printed
//     "(no successor)" because survivors were read from its own file alone.
//
// REFUSED under this same plan, and NOT to be re-filed: its own work item 2, a "skip the report
// for any file master has not changed since the branch's merge-base" precondition, offered as
// "cheap, cannot false-negative". It is neither cheap-in-risk nor false-negative-free — it is
// plan 2908's T2 exemption in a thinner phrasing, which plan 2917 implemented, MEASURED, and
// disproved (the FORK-POINT COLLAPSE block above). done-worktree runs this lint POST-REBASE with
// masterRef pinned to the very sha it rebased onto, so the merge-base collapses to masterRef
// itself and "master has not changed since the merge-base" is TRUE FOR EVERY PATH: the exemption
// fires universally and reds `acceptance 2`, this file's own incident fixture. Capturing the base
// pre-rebase only moves the collapse one step earlier, since a branch rebuilt on fresh master —
// the standard LAND_BLOCKED_HOLDING recovery, and precisely the plan-2585 incident shape — also
// has merge-base == the master tip. The plan's own body anticipated this ("Check first whether
// 2917's pre-rebase base already implies this"); it does, and the answer is that the criterion is
// structurally blind to this guard's core case. Every "since the branch diverged" exemption stays
// ruled out, in any form.
// DEMOTED TO ADVISORY, 2026-09-08 (plan 3832) — this lint REPORTS; it does not halt a land.
// `done-worktree` prints its findings and merges. The `LANDED_REVERSION` seam and its exit 32,
// the `ALLOW_LANDED_REVERSION` env hatch, and plan 3210 Part 3's three scope-pinned
// `--allow-landed-reversion*` release flags are all retired together. Detection is UNCHANGED and
// still fully pinned by this file's suite, `acceptance 2` included — what changed is only what
// the land spine DOES with a finding.
//
// The plan asked first for a reshape: attribute only lines master gained AFTER the branch's fork
// point, the sub-class a merge can genuinely lose because the author never saw it. That is not
// implementable as a halt, measured three ways rather than argued:
//
//   1. THE REAL INCIDENT'S FORK POINT IS THE MASTER TIP. `git merge-base a67a4906046d 343467e2b7`
//      is `a67a4906046d` — the masterRef itself — because 343467e2b7's SOLE parent IS that ref
//      (the 2233 rebuild was built on fresh master). Every line it reverted, all four victim
//      plans' worth, landed BEFORE that point. So the post-fork attributed set is EMPTY and the
//      motivating incident yields ZERO findings under any fork-point rule, however durably the
//      fork point is recorded — stamped at cut-worktree time, captured pre-rebase, anything.
//      This is topology, not tuning: no threshold, depth, or line-versus-file granularity moves
//      it. (Plan 3832's task 1 differs from plan 2917's disproved T2 only in granularity — narrow
//      the attributed LINE set rather than skip the FILE — and on this fixture both are empty.)
//      This file's own `acceptance 2` is that shape and would go red: it cuts the branch AT
//      `masterTip`, so its four culprit commits are all pre-fork ancestors.
//   2. POST-REBASE THE COLLAPSE IS UNIVERSAL. done-worktree runs this lint AFTER the queue-head
//      rebase with masterRef pinned to the sha it just rebased onto, so merge-base(masterRef,
//      branchRef) == masterRef on EVERY branch. A fork-point rule computed at lint time is empty
//      for everyone — the gate would simply never fire again, which is this demotion's outcome
//      reached by an implementation that does not admit it. Worse than saying so plainly.
//   3. NO FIRING ON RECORD WAS A GENUINE ACCIDENTAL REVERSION. Plans 2853, 2875, 2855 (x2), 2882,
//      2892, 2969 were the three false-positive classes plan 3246 then fixed; plan 3182 was a
//      genuine in-place REWRITE, released after an operator read the diff; the plan-3732 land was
//      392 deliberate deletions (case-handling code plus the 31 test files that covered it plus
//      276 rerun-rewritten artefacts) and cost ~25 minutes of a land already three hours long.
//      45+ plan bodies carry the hatch. The motivating incident predates the gate entirely.
//
// WHY THE DEMOTION LOSES NO DETECTION, which is the part worth keeping in mind before anyone
// re-files a halt here. The `_places_geo.py` reversion was caught by the land's own 452-failure
// pre-push pytest gate. Every land still runs the full vitest, pytest-backend-scripts and
// scripts-battery suites before anything reaches master. A removal that costs behaviour reds
// them; a removal that reds nothing removed no behaviour. So the spine ALREADY detects the
// consequential class, and this lint only ever front-ran it — charging every refactor a halt for
// insurance against a class nothing has observed. That is the same "measure CONSEQUENCE, not
// intent" direction plan 3210 landed as `runCulpritTests`; the land's own suite IS that
// measurement, already paid for.
//
// So the three ruled-out directions now close a triangle, and a future plan should not re-file
// any corner of it: TOPOLOGY cannot see intent (plan 2917, and 1-2 above), CONTENT cannot see
// intent (plan 3210, three formulations measured against two controls), and CONSEQUENCE is
// already measured by the land's test gates. What survives here is the DIAGNOSTIC — which file,
// how much of master it drops, which plans landed those lines, and `--explain`'s dropped-line /
// successor pairing — printed where the operator is already reading. The diagnostic was never
// the problem; the halt was.
//
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { GIT_MAXBUFFER } from './coord-git.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';
import { loadCoordConfig } from './coord-config.mjs';
import { escapeRegex } from './build-index-lib.mjs';

// plan 3832: `ESCAPE_HATCH_ENV` ('ALLOW_LANDED_REVERSION') and its shared `escapeHatchWarning`
// body lived here. Both are RETIRED with the halt they released — this lint reports and never
// stops a land, so there is nothing to escape. See § DEMOTED TO ADVISORY in the header.

// How many of a candidate file's removed lines must be traceable to ANOTHER plan's recent
// commits before it is a finding. Calibrated on the incident (290 and 46 attributed on the two
// genuinely reverted files) against the ordinary shape of a plan diff, which removes its own
// prior lines or long-settled code rather than a sibling's fresh landing.
export const MIN_ATTRIBUTED_LINES = 25;
// How far back to walk a candidate file's master history when attributing. Doubles as the
// recency bound that keeps an ordinary refactor of long-settled code out of the finding set.
// Review finding (2585, F0+F9): at 25 this was a real blind spot — on a file hot enough that
// 25+ commits land between a plan's own landing and a later stale-copy restore, the culprit
// falls off the end of the walk and the finding silently disappears, which is precisely the
// `_places_geo.py` class. It is affordable to go much deeper now that the whole walk is ONE
// batched `git log -p` instead of one `git diff` subprocess per commit.
export const ATTRIBUTION_HISTORY_DEPTH = 150;
// plan 2917 T3′: how many attributed plans the finding MESSAGE names before it summarises the
// rest as a count. A render bound only — it never changes what is detected, what is attributed,
// or whether the land halts, and the finding object keeps every entry for programmatic callers.
// Five because `plans[]` is sorted by attributed lines desc and the incident's own worst case
// named four (2249, 2255, 2219, 2254): the head of that list is what an operator acts on, and a
// removal spread thinly across a dozen plans is a fact about the diff's SIZE, which the
// `drops N lines` count already carries.
export const MAX_RENDERED_PLANS = 5;
// Lines shorter than this (after trim) are ignored on BOTH sides of the intersection: `}`,
// `)`, `};`, blanks and other boilerplate repeat across unrelated commits, and counting them
// would let coincidence alone accumulate past MIN_ATTRIBUTED_LINES.
export const MIN_SIGNIFICANT_LINE_LENGTH = 3;

// plan 2585: the generated, whole-file-rewritten data trees this rule cannot speak about (see
// the header's "does not cover" list). Sourced from the SAME coord.config.json keys the
// landing mutex scopes on, so the exclusion can never drift from what the mutex protects. A
// config-less repo declares none of them and gets a regex that matches nothing.
const MATCHES_NOTHING = /(?!)/;
export function buildGeneratedDataRx(config) {
  const dirs = [
    ...(config?.seedShardDir ? [config.seedShardDir] : []),
    ...(config?.derivedShardDirs || []),
  ];
  const files = [
    ...(config?.seedLaneFile ? [config.seedLaneFile] : []),
    ...(config?.derivedGlobalFiles || []),
  ];
  const alts = [
    ...dirs.map((d) => `${escapeRegex(d)}/`),
    ...files.map((f) => `${escapeRegex(f)}$`),
  ];
  return alts.length ? new RegExp(`^(${alts.join('|')})`) : MATCHES_NOTHING;
}

export function isGeneratedDataPath(path, dataRx = MATCHES_NOTHING) {
  return dataRx.test(path);
}

// plan 2274 review fix (round 2), carried forward: resolved FRESH from `wtPath` on every call
// (never at module import time) — two defects this closes: (1) an eager `loadCoordConfig` at
// import time did a synchronous unguarded JSON.parse of coord.config.json, contradicting this
// whole file's documented fail-open contract (a malformed config would crash done-worktree.mjs's
// static import of this module, not just this one advisory check); (2) resolving the config from
// wherever THIS script itself happened to be loaded from (its own import.meta.url) rather
// than from the WORKTREE actually being checked created a TOCTOU-style mismatch in
// orchestrator-driven invocations where the importing process's own root can differ from
// wtPath. Fail-open: any read/parse failure falls back to matching nothing (never throws).
function generatedDataRxFor(wtPath) {
  try {
    return buildGeneratedDataRx(loadCoordConfig(wtPath));
  } catch {
    return MATCHES_NOTHING; // no further IO — a pure literal fallback
  }
}

// --- pure ----------------------------------------------------------------------

// The `worktree-<id>` branch-name form, in ONE place. Anchored at a token boundary so it cannot
// bite a truncated prefix out of a longer digit run (review finding F6), and UNCAPPED on the
// right like `claim-plan-lib.mjs`'s own `planIdOf` — that file's comment records that plan ids
// already crossed 3→4 digits once, so a width cap here is a latent silent-miss (F7). Both
// `authoringPlanId` and `ownPlanIds` read this constant rather than re-inlining the pattern.
export const WORKTREE_BRANCH_ID_RX = /(?:^|[^\w-])worktree-(\d{3,})(?![\d])/;

// The plan id a commit was AUTHORED under, from its subject, or null.
//
// Review finding F1: the first cut recognised only three forms, and a survey of this repo's real
// `git log` shows that silently excluded a large share of landed commits — a commit whose subject
// does not claim a plan id is skipped WHOLE from the attribution walk, so a genuine revert of its
// lines can never clear the floor. The forms below are the ones this repo actually uses:
//   "2255: dedup Nordic-fold table …"                       leading id
//   "feat(2261): secondary-phone axis …"                    conventional scope IS the id
//   "fix(scripts): 2233 rebuild fix — restore …"            id opens the description
//   "Merge branch 'worktree-2233-FABLE-DQ-…' …"             the land merge
//   "fix(places): review-round fixes (plan 2205, …)"        parenthesised, with the word
//   "fix(test): address review findings on the plan-2575 …" hyphenated, mid-sentence
//   "de-freeze the gate surface — … (2576)"                 bare trailing parenthesis
//
// Order matters: the most explicit claims are tried first. A bare id anywhere ELSE in the subject
// stays a REFERENCE, not authorship — 343467e2b7's real subject is "data(seed): 2233 rebuild on
// fresh master — reconciles with plans 2208/2221/2242", which must resolve to 2233 (the author)
// and never to 2208/2221/2242 (what it reconciled against). Counting a referenced id as
// authorship would let a reverting commit exempt its own victims simply by naming them, so there
// is deliberately NO catch-all "any number in the subject" arm.
//
// The bare-trailing-parenthesis form is the one genuinely ambiguous shape (it could be a count or
// a year), so it alone requires 4+ digits — every live plan id is 4 digits and the 3-digit ids
// are long archived, whereas "(600)" as a timeout or size is entirely plausible.
const AUTHORING_PATTERNS = [
  /^(\d{3,}):/, // "2255: …"
  /^\w+\((\d{3,})\):/, // "feat(2261): …"
  WORKTREE_BRANCH_ID_RX, // "Merge branch 'worktree-2233-…'"
  /\(plan[ -](\d{3,})[,)\s]/, // "(plan 2205, …)"
  /\bplan[ -](\d{3,})\b/, // "the plan-2575 env scrub"
  /^\w+\([^)]*\):\s*(\d{3,})\b/, // "fix(scripts): 2233 rebuild fix …"
  /\((\d{4,})\)\s*$/, // "… (2576)"
];
export function authoringPlanId(subject) {
  for (const rx of AUTHORING_PATTERNS) {
    const m = String(subject || '').match(rx);
    if (m) return m[1];
  }
  return null;
}

// Split `git diff -U0` output into per-file added/removed line SETS (content, trimmed).
// Keyed by the new-side path (falling back to the old side for a deletion), which is what the
// finding reports. Lines shorter than MIN_SIGNIFICANT_LINE_LENGTH are dropped on both sides —
// see the constant's own comment. Pure; malformed/empty input yields an empty Map.
//
// plan 3394 CLASS 2b — each entry ALSO carries `addedRaw`/`removedRaw`: the same bodies with
// their INDENTATION intact. The trimmed sets stay exactly as they were, because attribution
// (attributeRemovals, below) matches them against `git log -p`-derived commit lines that are
// trimmed the same way — re-keying those would silently zero every attribution. The raw sets
// exist for netRemovedLines alone, which cannot otherwise tell a re-indent from a real removal:
// `.trim()` here makes `    foo` and `        foo` the SAME string, so a re-indented line lands
// in `added` and `removed` simultaneously and hits netRemovedLines' never-excuse-an-exact-match
// branch. See that function's own plan-3394 note for the full trace.
export function diffLineSets(diffText) {
  const out = new Map();
  const text = String(diffText || '');
  if (!text.trim()) return out;
  const blocks = text.split(/(?=^diff --git )/m).filter((b) => b.startsWith('diff --git '));
  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0].match(/^diff --git a\/(.*) b\/(.*)$/);
    let oldPath = header ? header[1] : null;
    let newPath = header ? header[2] : null;
    const added = new Set();
    const removed = new Set();
    const addedRaw = new Set();
    const removedRaw = new Set();
    for (const ln of lines) {
      const mMinus = ln.match(/^--- (?:a\/(.+)|(\/dev\/null))$/);
      if (mMinus) {
        oldPath = mMinus[1] ?? null;
        continue;
      }
      const mPlus = ln.match(/^\+\+\+ (?:b\/(.+)|(\/dev\/null))$/);
      if (mPlus) {
        newPath = mPlus[1] ?? null;
        continue;
      }
      if (ln.startsWith('+') || ln.startsWith('-')) {
        const raw = ln.slice(1);
        const body = raw.trim();
        // The significance floor stays keyed on the TRIMMED length, so which lines participate
        // at all is byte-identical to before this change — indentation must not be able to lift
        // a sub-floor line over the bar.
        if (body.length < MIN_SIGNIFICANT_LINE_LENGTH) continue;
        const plus = ln[0] === '+';
        (plus ? added : removed).add(body);
        (plus ? addedRaw : removedRaw).add(raw);
      }
    }
    const key = newPath || oldPath;
    if (!key) continue;
    const prev = out.get(key);
    if (prev) {
      for (const a of added) prev.added.add(a);
      for (const r of removed) prev.removed.add(r);
      for (const a of addedRaw) prev.addedRaw.add(a);
      for (const r of removedRaw) prev.removedRaw.add(r);
    } else {
      out.set(key, { added, removed, addedRaw, removedRaw, oldPath, newPath });
    }
  }
  return out;
}

// plan 3246 CLASS 2 — a line whose only change is WHITESPACE was never removed.
//
// The firing (fixture F3; live on plans 2855, 2882 and 2969) is a markdown table re-pad. Cells
// in `docs/PIPELINE.md` § The glossary are padded to the widest row, so adding the ONE glossary
// row that doc's own write-rule REQUIRES of any new-concept plan re-pads every column: ~60
// rows read as deletions against a branch table that is a strict SUPERSET of master's. Plan
// 2882 proved the trigger is STRUCTURAL, so EVERY conforming new-concept land trips it — which
// is how `ALLOW_LANDED_REVERSION=1` became the routine move for an ordinary row addition, the
// exact reflex this guard's own header argues is the expensive failure mode. The same shape
// arrives from any pre-push prettier reflow.
//
// Collapsing internal whitespace runs is enough to pair a re-padded row with its survivor, and
// is deliberately the WEAKEST possible normalization: it never crosses files, never compares
// unequal text, and decides nothing about intent.
//
// This is NOT the content-similarity release plan 3210 measured and ruled out (see the module
// header's RULED OUT block, and the plan-3246 bound that forbids re-litigating it). That
// disproof is about judging whether NEW text is derived from OLD text — a similarity question,
// inverted on both controls. This is identity modulo formatting between the SAME land's own two
// sides of one file: the line is still there, re-spaced. Nothing here scores, ranks, or thresholds.
export function normalizeWhitespace(line) {
  return String(line).replace(/\s+/g, ' ').trim();
}

// The lines a land genuinely takes off master for one file: `removed`, less every line that
// survives in that same file's ADDED set modulo whitespace. Returns the net set plus the count
// excluded, so a finding can report honestly how much of its raw deletion count was reformatting.
export function netRemovedLines(removed, added, opts = {}) {
  // Review finding (plan 3246 round 1, CONFIRMED): the first cut tested membership modulo
  // whitespace ONLY, which excluded a removed line whenever ANY added line in the file carried
  // the same text — including a literal duplicate that has nothing to do with a re-pad (a
  // repeated `except Exception:`, a table separator, any boilerplate past
  // MIN_SIGNIFICANT_LINE_LENGTH). Enough such coincidences on a genuine 25+ line revert could
  // push `removed` under MIN_ATTRIBUTED_LINES and silently suppress the finding — a FALSE
  // NEGATIVE, the one direction this plan's own bound forbids ("can only remove provably-wrong
  // firings").
  //
  // So an EXACT textual match is no longer an exclusion: it keeps the pre-3246 count verbatim.
  // Only a line that has NO exact counterpart but DOES have a whitespace-normalized one is
  // excluded — which is precisely a re-pad, the same tokens re-spaced. That makes the filter a
  // strict narrowing of the pre-3246 removed set in exactly one provable case, and leaves every
  // literal-duplicate shape behaving as it always did.
  // Review finding (plan 3246 round 2, CONFIRMED): plain Set membership has no MULTIPLICITY, so
  // one added line could excuse ANY number of removed lines that normalize to it. Two genuinely
  // distinct removals differing only in indentation (`    return None` and `        return None`)
  // were both excused by a single unrelated reformat of `return None` elsewhere — and typical code
  // is full of such near-duplicates, so a real 25+ line revert could still slip under the floor.
  // Matching is therefore PAIRED: each added line excuses AT MOST ONE removed line, tracked as a
  // budget that is consumed. Excused count can never exceed the number of added lines that could
  // have produced it, which is what makes the exclusion provable rather than merely plausible.
  // plan 3394 CLASS 2b (OBSERVED, plan 3321's land) — the exact-vs-normalized split above is
  // only meaningful on lines that still carry their INDENTATION, and diffLineSets used to trim
  // it off before this function ever saw them. Trace: wrapping a `<tr>` in a `<Fragment>`
  // re-indents the block by two spaces and prettier owns that formatting, so it cannot be
  // avoided. After `.trim()` the old and new bodies of every re-indented line are the SAME
  // string, so each one lands in `added` and `removed` at once, hits `exact.has(line)` — the
  // round-1 rule that an exact match is NEVER excused — and is counted as genuinely removed.
  // 38 of 50 such lines were then attributed to plans 2728 / 339 / 700 / 297 / 274 and halted
  // the land at exit 32, against a `git diff -w` showing five real removals. The round-1 and
  // round-2 properties are both PRESERVED, just evaluated where the evidence still exists:
  // a RAW-exact match is still never excused (an unrelated `except Exception:` at the same
  // indent still counts, which is round 1's whole point), and pairing is still budgeted per
  // added line (round 2). Only "same tokens, different leading whitespace" — which is what a
  // re-indent IS and what a real removal is not — newly pairs off.
  //
  // THE COST, stated (gpt-review 3394, finding 1). This does open a narrow new false-negative:
  // a line genuinely deleted at one indent, paired off by an unrelated line of identical text
  // ADDED at a different indent. Three things bound it, and they are why the trade is worth
  // taking. The pairing is BUDGETED, so N such removals need N such additions. The same-indent
  // coincidence — much the likelier one, since real code repeats boilerplate at a consistent
  // depth — is still RAW-exact and still never excused. And the finding needs
  // MIN_ATTRIBUTED_LINES (25) attributed lines to fire at all, so isolated coincidences cannot
  // flip a verdict. Against that: without this, EVERY prettier-owned re-indent is a false
  // positive, which is what made ALLOW_LANDED_REVERSION=1 the routine move — a reflex that
  // releases every finding, including the true ones. Pairing by CONTENT rather than by position
  // is plan 3246's ruled design (whole-file Sets, no line numbers); this changes which
  // representation is compared, not that model.
  //
  // `net` is returned in TRIMMED space regardless of which arm ran: attributeRemovals matches it
  // against trimmed `git log -p` bodies, so returning raw lines here would zero every
  // attribution (a false NEGATIVE, the direction plan 3246's bound forbids). Callers that pass
  // no raw sets — older callers, and the pure-function tests that drive this with string
  // literals — take the pre-3394 path byte-for-byte.
  const removedRaw = opts.removedRaw;
  const addedRaw = opts.addedRaw;
  const haveRaw = Boolean(removedRaw && addedRaw);
  const removedIn = haveRaw ? removedRaw : removed;
  const addedIn = haveRaw ? addedRaw : added;
  const exact = new Set(addedIn || []);
  const budget = new Map();
  for (const line of addedIn || []) {
    const key = normalizeWhitespace(line);
    budget.set(key, (budget.get(key) || 0) + 1);
  }
  const net = new Set();
  let reformatted = 0;
  for (const line of removedIn || []) {
    // Trimmed on the raw arm so `net` stays in the space attribution reads; a no-op otherwise,
    // since the non-raw arm's inputs are already trimmed.
    const asNet = haveRaw ? String(line).trim() : line;
    if (exact.has(line)) {
      net.add(asNet); // same literal text on both sides — never a reformat
      continue;
    }
    const key = normalizeWhitespace(line);
    const left = budget.get(key) || 0;
    if (left > 0) {
      budget.set(key, left - 1);
      reformatted++;
    } else net.add(asNet);
  }
  return { net, reformatted };
}

// The pinned judgement (plan 2585). `removed` is the set of lines this land takes off
// masterRef for one file; `history` is that file's recent masterRef commits, NEWEST FIRST, as
// [{ sha, subject, added: Set }]. A commit counts only if it was authored under a plan id NOT
// in `ownPlanIds` — a branch removing its own earlier lines is ordinary rework, not reversion.
//
// Each removed line is attributed to AT MOST ONE commit — the newest one that added it. Without
// that, a line added, later removed, and later re-added (or simply touched by two commits, which
// is routine on a hot file) would be counted once per commit and could carry a file past
// MIN_ATTRIBUTED_LINES on churn alone. `attributed` is therefore |the set of removed lines
// traceable to another plan|, never a sum of overlapping per-commit tallies.
//
// Returns { attributed, plans: [{ id, sha, subject, lines }] } sorted by lines desc.
//
// `opts.withLines` (plan 3210, --explain) opts each plan entry into a `claimedLines: string[]`
// array of the ACTUAL removed-line text it claimed — needed to pair a dropped line with its
// nearest surviving successor for a human to read. Off by default so the shape callers already
// deepEqual against (`{ attributed, plans: [{ id, sha, subject, lines }] }`) stays byte-identical
// for every existing caller that omits the 4th argument.
export function attributeRemovals(removed, history, ownPlanIds = new Set(), opts = {}) {
  const withLines = Boolean(opts.withLines);
  const byPlan = new Map();
  const claimed = new Set();
  // plan 3246 CLASS 1 (variant, firing 2892): a commit that RE-ADDS a whole file was being
  // credited every line in it forever after, masking whoever actually wrote them — replayed
  // 2026-08-16 as fixture F2, where a mechanical "restore shared.py unchanged after the
  // restructure" commit took all 40 lines plan 1111 had authored.
  //
  // The fix is ORDERING, not exclusion: run every MODIFYING commit first (newest-first, the
  // rule below), then the file-creation commits (also newest-first). Newest-wins is unchanged
  // WITHIN each group; a creation now only claims lines no modification accounts for. So a
  // delete-then-re-add credits the original author, while a genuinely new file — whose only
  // commit is its creation — still credits its creator and still clears the floor. Nothing is
  // dropped from the walk, so this can never turn a finding into a miss: every line attributable
  // before is attributable now, just possibly to a different (correct) plan.
  const ordered = [
    ...(history || []).filter((c) => !c.fileCreation),
    ...(history || []).filter((c) => c.fileCreation),
  ];
  for (const commit of ordered) {
    const id = authoringPlanId(commit.subject);
    if (!id || ownPlanIds.has(id)) continue;
    let lines = 0;
    const claimedNow = withLines ? [] : null;
    for (const line of commit.added || []) {
      if (!removed.has(line) || claimed.has(line)) continue;
      claimed.add(line);
      lines++;
      if (withLines) claimedNow.push(line);
    }
    if (!lines) continue;
    const prev = byPlan.get(id);
    // The first commit to claim a plan id in ITERATION order is the one reported for it.
    //
    // Review finding (plan 3246 round 1): that order is no longer plain newest-first — it is
    // modifications newest-first, THEN creations newest-first (see `ordered` above). The cited
    // sha/subject for a plan that both modified and created the file is therefore its
    // MODIFYING commit, which is the correct citation: the modification is where the content
    // was authored, and the creation only re-placed it. The one shape that could reorder a
    // plan's citation across the two buckets — a creation NEWER than a modification of the same
    // file — requires master to have DELETED and RECREATED that file, in which case crediting
    // the earlier modification is exactly the 2892 fix working, not a regression of it.
    if (prev) {
      prev.lines += lines;
      if (withLines) prev.claimedLines.push(...claimedNow);
    } else {
      const entry = { id, sha: commit.sha, subject: commit.subject, lines };
      if (withLines) entry.claimedLines = claimedNow;
      byPlan.set(id, entry);
    }
  }
  const plans = [...byPlan.values()].sort((a, b) => b.lines - a.lines);
  return { attributed: plans.reduce((n, p) => n + p.lines, 0), plans };
}

// A rename is the branch's doing, so masterRef still knows the file by its OLD name: the
// per-file diff needs BOTH sides of the pathspec to see it at all, and the attribution history
// has to be walked under the name master actually has.
//
// ONE definition, consumed by both `detectLandedReversion` (which has the numstat row in hand
// already) and `explainDroppedLines` (which looks one up) — review finding (plan 3246 round 3):
// the two had hand-mirrored copies of this four-line rule, and a later change to the rename
// heuristic applied to only one of them would silently reintroduce the round-2 bug in the other,
// with no test able to see it. Pure: it takes a numstat-shaped `{ path, oldPath }` row, never a
// git call, so neither caller pays for the other's IO strategy.
export function renamePathsFor(row) {
  const path = row?.path;
  const oldPath = row?.oldPath || null;
  return {
    masterPath: oldPath || path,
    pathspec: oldPath ? [oldPath, path] : [path],
  };
}

// Parse `git diff --numstat -M -z` into [{ added, deleted, path, oldPath }]. The NUL form is
// used deliberately over plain `--numstat`, which is ambiguous in two ways this check would
// otherwise get wrong:
//   - A RENAME prints as one field "a\td\told => new" (or a brace-compacted form), so a naive
//     tab split yields the pathspec-invalid "old => new" as the path. Under -z the counts field
//     ends with an EMPTY third column and the old and new paths follow as their own NUL-
//     terminated tokens, so the pairing is unambiguous.
//   - A BINARY file prints "-\t-\tpath". `Number('-')` is NaN and `NaN < N` is FALSE, so a bare
//     `<` threshold admits every binary file as a candidate; they are dropped explicitly here.
// Pure; malformed/empty input yields [].
export function parseNumstatZ(out) {
  const tokens = String(out || '').split('\0');
  const rows = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const parts = token.split('\t');
    if (parts.length < 3) continue;
    const [rawAdded, rawDeleted, inlinePath] = parts;
    let path = inlinePath;
    let oldPath = null;
    if (path === '') {
      // rename/copy: the next two tokens are the old and new paths
      oldPath = tokens[++i] ?? null;
      path = tokens[++i] ?? '';
    }
    if (!path) continue;
    const added = Number(rawAdded);
    const deleted = Number(rawDeleted);
    if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue; // binary ("-\t-\t…")
    rows.push({ added, deleted, path, oldPath });
  }
  return rows;
}

// Record separator for the batched attribution log. NUL cannot occur in a text patch, so it
// delimits commits unambiguously without escaping.
export const LOG_RECORD_SEP = '\0';
// The `--format` argument that PRODUCES that separator. It must carry the LITERAL four
// characters "%x00" — git expands them to a NUL, whereas passing a real NUL here makes Node's
// child_process throw ERR_INVALID_ARG_VALUE ("must be a string without null bytes"), which
// fail-open would then swallow into a silently empty finding set. land-lib.mjs's
// attributeConflict carries the same warning for the same reason.
export const ATTRIBUTION_LOG_FORMAT = '--format=%x00%H%x1f%s';

// Parse ONE batched `git log -p -U0 --format=<SEP>%H%x1f%s` into the [{ sha, subject, added }]
// shape attributeRemovals consumes. Review finding F9: this replaces one `git diff` subprocess
// PER COMMIT (up to ATTRIBUTION_HISTORY_DEPTH of them, per candidate file, inside done-worktree's
// preflight while an operator waits) with a single invocation — which is also what makes the
// deeper history bound in F0 affordable. Commits whose subject claims no plan id are dropped
// here rather than by the caller, since only attributable commits can ever contribute.
// Pure; malformed/empty input yields [].
export function parseAttributionLog(out) {
  const records = String(out || '').split(LOG_RECORD_SEP);
  const history = [];
  for (const record of records) {
    if (!record.trim()) continue;
    const nl = record.indexOf('\n');
    const headline = nl === -1 ? record : record.slice(0, nl);
    const sep = headline.indexOf('\x1f');
    if (sep === -1) continue;
    const sha = headline.slice(0, sep).trim();
    const subject = headline.slice(sep + 1);
    if (!sha || !authoringPlanId(subject)) continue;
    const added = new Set();
    // plan 3246 CLASS 1 (variant): is this commit's patch for the path a pure FILE CREATION
    // (`--- /dev/null`)? diffLineSets records that as `oldPath === null`. A creation is a
    // WEAKER authorship claim than a modification — a delete-then-re-add, a restore, or a
    // relocation re-adds text somebody else wrote — so attributeRemovals credits it only the
    // lines no modifying commit in the walk accounts for. A genuinely new file has no such
    // commit, so its creator is still named. See that function for the ordering rule.
    let entries = 0;
    let creations = 0;
    for (const entry of diffLineSets(nl === -1 ? '' : record.slice(nl + 1)).values()) {
      entries++;
      if (entry.oldPath === null) creations++;
      for (const line of entry.added) added.add(line);
    }
    history.push({ sha, subject, added, fileCreation: entries > 0 && creations === entries });
  }
  return history;
}

// --- IO ----------------------------------------------------------------------

function git(wtPath, args) {
  return execFileSync('git', ['-C', wtPath, ...args], {
    encoding: 'utf8',
    // plan 844/850's shared cap — a land can carry a corpus-scale diff (the >500-clinic
    // rebaseline shape), and a smaller cap here would silently fail-open exactly when the
    // check matters most. The merge-tree call itself needs no cap (it prints one OID).
    maxBuffer: GIT_MAXBUFFER,
    // plan 4096: an ambient GIT_DIR/GIT_WORK_TREE could otherwise override the explicit
    // `-C wtPath` above and redirect this read at the wrong repo (see
    // scripts/coord/child-env.mjs gitRepoIsolatedEnv()). This is a local, network-free read
    // (merge-tree / log / diff against an already-checked-out worktree), so the repo-selector
    // strip is enough — no transport/credential vars to preserve.
    env: gitRepoIsolatedEnv(),
  });
}

// The tree the land would actually produce. `base` (mainly for tests, and threaded by
// done-worktree from its own already-resolved merge-base) pins the 3-way base explicitly;
// without it git computes the same merge-base itself. Returns null on ANY failure, including
// a CONFLICT exit — see the header's fail-open paragraph for why a conflict is not ours.
export function mergedTreeOid(wtPath, masterRef, branchRef, { base } = {}) {
  const attempt = (args) => git(wtPath, ['merge-tree', '--write-tree', ...args]).trim() || null;
  try {
    return attempt(base ? [`--merge-base=${base}`, masterRef, branchRef] : [masterRef, branchRef]);
  } catch (err) {
    // Review finding F3: the retry below exists ONLY for the git window that has
    // `merge-tree --write-tree` (>= 2.38) but not `--merge-base` (< 2.40). Retrying on ANY
    // failure conflated that with a genuine CONFLICT at the pinned base — and since the retry
    // lets git pick its own merge-base, a conflict at the intended base could resolve cleanly at
    // a different one and return a tree that does not represent the land at all. That is worse
    // than the documented fail-open (no findings). So the retry now fires only when git actually
    // says it did not understand the option; every other failure, conflicts included, is null.
    if (!base || !isUnknownOptionError(err)) return null;
    try {
      return attempt([masterRef, branchRef]);
    } catch {
      return null;
    }
  }
}

// Does this execFileSync failure mean git rejected `--merge-base` as an option it does not know?
// git prints "error: unknown option `merge-base=…'" (plus the usage block) to stderr and exits 129
// for an unrecognised flag, whereas a merge CONFLICT exits 1 with the conflicted-file report on
// stdout. Both stderr and the joined message are checked because execFileSync's `stderr` is a
// Buffer here and callers have been known to strip it.
function isUnknownOptionError(err) {
  const text = `${err?.stderr ?? ''}${err?.message ?? ''}`;
  return /unknown option|unrecognized option|is not a git command|usage: git merge-tree/i.test(
    text,
  );
}

// plan 2908 T1/E2: is this checkout a SHALLOW clone — so that `git log` for a path stops at the
// graft boundary rather than at the file's real first commit? On such a repo the boundary commit
// appears to have ADDED every file in it, and the attribution walk below cannot tell that from a
// genuine authoring commit: it would confidently misattribute a land's removals to whatever plan
// the boundary commit happens to name. Fail-open: any git failure ⇒ false (assume full history —
// today's behavior, unchanged).
//
// SHALLOW ONLY, deliberately — the exact mechanism plan 2908's E2 pins. The other two ways a git
// history can be truncated (`.git/info/grafts`, `refs/replace/*`) are NOT probed: this repo has
// no writer that produces either, and a cheap existence-test for them is over-broad in a way that
// matters — an empty grafts file, or a replace ref that only rewrites a commit MESSAGE, truncates
// nothing, yet would downgrade every candidate in the repo and turn this blocking gate into a
// warning. Detecting them soundly means comparing each replacement's parent list against the
// original's, which is a different (and unmotivated) piece of work. Tracked as one line in
// docs/handoff/infra-debt.md (2026-08-06 `landed-reversion-truncation-probe-is-shallow-only`)
// rather than guessed at here; revisit if a real truncated-but-not-shallow checkout appears.
function isShallowRepo(wtPath) {
  try {
    return git(wtPath, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
  } catch {
    return false;
  }
}

// The plan ids this branch is itself working: every authoring id claimed by its own commits
// (which covers a batch train, whose every member prefixes its commits `<id>: `), plus the leading
// id of the `worktree-<id>-…` branch name when one is resolvable.
export function ownPlanIds(wtPath, masterRef, branchRef) {
  const ids = new Set();
  try {
    for (const subject of git(wtPath, ['log', '--format=%s', `${masterRef}..${branchRef}`]).split(
      '\n',
    )) {
      const id = authoringPlanId(subject);
      if (id) ids.add(id);
    }
  } catch {
    /* fail-open: an unresolvable range just means no ids from this source */
  }
  try {
    const name = git(wtPath, ['rev-parse', '--abbrev-ref', branchRef]).trim();
    const m = name.match(WORKTREE_BRANCH_ID_RX); // one shared, uncapped pattern (review F7)
    if (m) ids.add(m[1]);
  } catch {
    /* same */
  }
  return ids;
}

// The attribution history walk, factored out of detectLandedReversion (plan 3210) so
// --explain's display-only successor pairing can walk the SAME commits the real detector
// attributes against, rather than a second, driftable re-implementation of these exact flags.
function attributionHistoryFor(wtPath, masterRef, path) {
  return parseAttributionLog(
    git(wtPath, [
      'log',
      // review (plan 2908 r3): the patch this parses must be git's OWN format — a
      // user-configured `diff.external` would substitute a third-party tool's output and
      // silently yield zero attributed lines. Same reason as the two `git diff` calls above.
      '--no-ext-diff',
      '-p',
      '-U0',
      '-M',
      // plan 3246 CLASS 1 — walk master's own MAINLINE, not everything reachable from it.
      //
      // The measured firing (fixture F1 below; real culprits bd6656e29 on plan 2853's land and
      // f0f7392fa on plan 2875's) is a FRESHEN merge — `Merge origin/master into worktree-<id>`,
      // whose FIRST parent is the BRANCH and whose second is master. Its first-parent patch is
      // therefore everything MASTER added since that branch forked, and `authoringPlanId` reads
      // the branch's own id out of the merge subject: the walk credits master's work to the
      // branch's (innocent) plan. Because such a merge is NEWER than the commits that really
      // authored those lines, attributeRemovals's newest-wins rule hands it the whole block and
      // the real authors vanish from the refusal. Replayed 2026-08-16: 40 of 80 dropped lines
      // credited to plan 2404, which had never touched the file.
      //
      // A freshen merge is reachable from master (its branch landed) but is NOT on master's
      // first-parent chain. `--first-parent` walks exactly that chain, which is the honest
      // record of "what master gained, and when": a direct push, or a land merge whose
      // first-parent patch IS the landed branch's whole contribution for this path.
      //
      // This does NOT revert the first-parent DIFF design (the plan-3246 bound, and F4 below):
      // land merges stay in the walk and keep supplying the plan id — on a land merge the merge
      // subject is still the only plan-id carrier, and `--first-parent` keeps merges that
      // changed the path relative to their first parent, which is precisely those. What it drops
      // is off-mainline bookkeeping: a branch's internal commits and its freshen merges. No
      // attribution is LOST by that — a branch's own lines reach master through its land merge,
      // which names the same plan, so the culprit is still named, just by the commit that
      // actually put the lines on master.
      '--first-parent',
      // Review finding F4: `--full-history` is what land-lib.mjs's own attributeConflict
      // passes, and for the same reason — default history simplification can prune the
      // landing MERGE for a path, and on a land merge only the merge subject carries the
      // plan id. Without it a whole plan can be invisible to attribution.
      '--full-history',
      // …and with merges kept, they must still produce a patch: `git log -p` shows nothing
      // for a merge by default, which would silently drop exactly the commits --full-history
      // was added to keep. First-parent is the same diff the previous per-commit
      // `git diff <sha>^ <sha>` produced.
      '--diff-merges=first-parent',
      ATTRIBUTION_LOG_FORMAT,
      '-n',
      String(ATTRIBUTION_HISTORY_DEPTH),
      masterRef,
      '--',
      path,
    ]),
  );
}

// The end-to-end probe. Fail-open — ANY git failure returns [] rather than throwing, so a
// diagnostic step never itself takes down an otherwise-good land.
export function detectLandedReversion(
  wtPath,
  { base, masterRef = 'origin/master', branchRef = 'HEAD' } = {},
) {
  try {
    const tree = mergedTreeOid(wtPath, masterRef, branchRef, { base });
    if (!tree) return [];
    const dataRx = generatedDataRxFor(wtPath);
    // Cheap first pass: only files that actually LOSE enough lines can ever be a finding, so
    // the expensive per-file attribution walk below runs on (normally) zero files.
    const candidates = [];
    for (const row of parseNumstatZ(
      git(wtPath, ['diff', '--no-ext-diff', '--numstat', '-M', '-z', masterRef, tree]),
    )) {
      if (row.deleted < MIN_ATTRIBUTED_LINES) continue;
      if (isGeneratedDataPath(row.path, dataRx)) continue;
      candidates.push({ path: row.path, oldPath: row.oldPath, removedLines: row.deleted });
    }
    if (!candidates.length) return [];
    const own = ownPlanIds(wtPath, masterRef, branchRef);
    // plan 2908 T1/E2: shallow-ness is a property of the WHOLE checkout, so it is resolved once,
    // outside the loop.
    const shallow = isShallowRepo(wtPath);
    const findings = [];
    for (const c of candidates) {
      const { masterPath, pathspec } = renamePathsFor(c);
      const sets = diffLineSets(
        git(wtPath, ['diff', '--no-ext-diff', '-U0', '-M', masterRef, tree, '--', ...pathspec]),
      );
      const entry = sets.get(c.path);
      // plan 3246 CLASS 2: count only lines this land genuinely takes off master — a row the
      // branch merely re-padded is still there. Applied BEFORE the floor, because the whole
      // firing is a file whose real removal count is zero.
      // plan 3394: the raw (indentation-bearing) sets ride alongside so a pure re-indent pairs
      // off instead of reading as 38 removed lines — see netRemovedLines' own CLASS 2b note.
      const { net: removed, reformatted } = netRemovedLines(entry?.removed, entry?.added, {
        removedRaw: entry?.removedRaw,
        addedRaw: entry?.addedRaw,
      });
      if (!removed.size || removed.size < MIN_ATTRIBUTED_LINES) continue;
      // plan 2908 T1/E2: on a SHALLOW history the attribution walk below cannot be
      // trusted — the graft boundary commit appears to have added every file in the repo, so it
      // swallows whatever the walk should have found and confidently misattributes it to
      // whatever plan that boundary commit happens to name. Report the removal as UNSOUND
      // instead of running (and trusting) that walk: no plan ids, no `attributed` — the signal
      // is preserved as a fact ("this much was removed, we cannot judge it"), never a confident
      // accusation.
      if (shallow) {
        findings.push({
          path: c.path,
          oldPath: c.oldPath,
          removedLines: c.removedLines,
          unsound: 'shallow-history',
        });
        continue;
      }
      const history = attributionHistoryFor(wtPath, masterRef, masterPath);
      const { attributed, plans } = attributeRemovals(removed, history, own);
      if (attributed >= MIN_ATTRIBUTED_LINES) {
        findings.push({
          path: c.path,
          oldPath: c.oldPath,
          removedLines: c.removedLines,
          attributed,
          plans,
          // Only when non-zero, so the finding shape every existing caller and test deepEquals
          // against is byte-identical on a file with no reformatting (plan 3246).
          ...(reformatted ? { reformatted } : {}),
        });
      }
    }
    return findings;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// PLAN 3210 PART 2 — the discriminator that DOES work: run the culprit plans' OWN tests against
// the merged tree. Intent is invisible (Part 1's RULED OUT block, immediately above), but
// CONSEQUENCE is measurable — a reversion deletes behaviour and reds a victim's tests; a true
// rewrite keeps the behaviour under new code and they stay green. Since plan 3832 there is no
// release decision left for it to inform, so it is gathered by the CLI (and its own suite) and
// NOT by the land spine — see § DEMOTED TO ADVISORY. Read it as what it says and no more: it
// proves the behaviour those tests COVER survives, never that no reversion happened.
// ---------------------------------------------------------------------------------------------

// The bound `runCulpritTests`'s default runner enforces per invocation. A land preflight has an
// operator waiting on it, and a hung `python -m pytest` / `node --test` (a test that spins up a
// server and never tears it down, say) must not park the whole land — fail-closed on timeout,
// same posture as every other failure mode this function recognises.
export const CULPRIT_TEST_TIMEOUT_MS = 120_000;

// The primary glob: this repo names a plan's own Python test file `test_<planId>_*.py` under
// `backend/scripts/__tests__/` — see docs/PIPELINE.md and the many `test_3xxx_*.py` files
// already there. Returns paths sorted for determinism; [] on a missing dir or no match (never
// throws — this is advisory evidence-gathering, not a load-bearing git call).
function globCulpritTestFiles(wtPath, planId) {
  const dir = join(wtPath, 'backend', 'scripts', '__tests__');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const rx = new RegExp(`^test_${escapeRegex(String(planId))}_.*\\.py$`);
  return names
    .filter((n) => rx.test(n))
    .sort()
    .map((n) => `backend/scripts/__tests__/${n}`);
}

// The fallback, used only when the primary glob above is empty: the name-paired sibling of the
// FINDING's own path (not the plan's) — `scripts/X.mjs` -> `scripts/X.test.mjs`;
// `backend/scripts/X.py` -> `backend/scripts/__tests__/test_X.py`. This is a weaker signal (it
// covers the module the finding touched, not necessarily everything the culprit plan landed),
// which is exactly why it is the fallback and not the primary.
function siblingTestTargetFor(findingPath, wtPath) {
  const path = String(findingPath || '');
  let candidate = null;
  if (path.startsWith('scripts/') && path.endsWith('.mjs') && !path.endsWith('.test.mjs')) {
    // CONCATENATED, deliberately — NOT the equivalent `` `${path.slice(…)}.test.mjs` ``.
    // `unresolvedScriptRefReason` (select-battery-tests.mjs) classifies an interpolation followed
    // by a `.mjs` basename as `template-path` and, unable to resolve it, widens the battery
    // pass-cache key for THIS file from its own import closure to the whole `scripts/` tree —
    // sound but a real cache-hit-rate regression, and pinned by "the pass-cache own-closure
    // selection NARROWS on real sources" in battery-pass-cache.test.mjs (which is exactly how the
    // template form was caught here: the land-time battery, not review). `+ '.test.mjs'` leaves no
    // `${…}`-then-basename residue, and does not trip CONCAT_PATH_RX either — that rule keys on a
    // bare `'.mjs'` literal, not a longer suffix. Same trap, same fix as the `mainFile` spelling
    // in done-worktree.mjs; see its comment for the fuller account.
    candidate = path.slice(0, -'.mjs'.length) + '.test.mjs';
  } else if (path.startsWith('backend/scripts/') && path.endsWith('.py')) {
    // Review finding [3]: this repo's real `test_<name>.py` siblings use UNDERSCORES even for a
    // hyphenated script (`apply-homepage-verdicts.py` -> `test_apply_homepage_verdicts.py`) — a
    // raw-hyphenated candidate can never exist on disk, so the fallback silently found nothing
    // for every hyphenated `.py` finding.
    const base = path.slice(0, -'.py'.length).split('/').pop().replace(/-/g, '_');
    candidate = `backend/scripts/__tests__/test_${base}.py`;
  }
  if (!candidate) return null;
  try {
    return existsSync(join(wtPath, candidate)) ? candidate : null;
  } catch {
    return null;
  }
}

// One entry per attributed culprit plan on the finding: `{ planId, targets }`, `targets` being
// repo-relative paths that EXIST in `wtPath`. A plan with neither the primary nor the fallback
// gets `targets: []` — never thrown, since "no test file" is an ordinary, expected outcome this
// discriminator must handle (it is what keeps the halt standing for an unvouchable plan).
export function culpritTestTargets(wtPath, finding) {
  const plans = finding?.plans || [];
  return plans.map((p) => {
    const primary = globCulpritTestFiles(wtPath, p.id);
    if (primary.length) return { planId: p.id, targets: primary };
    const fallback = siblingTestTargetFor(finding.path, wtPath);
    return { planId: p.id, targets: fallback ? [fallback] : [] };
  });
}

// The default test-runner: `.py` targets under `python -m pytest … -q -p no:cacheprovider`,
// `.mjs` targets under `node --test`, both run with cwd `wtPath` and CULPRIT_TEST_TIMEOUT_MS.
// Exported (review fix [4]) so a caller can wrap it with a reuse fast-path. done-worktree used to
// be that caller; since plan 3832 it gathers no evidence at all (nothing to release), so the wrap
// lives with whoever runs this module's CLI — `runCulpritTests`'s `runner` opt remains the seam this
// file's own suite uses to exercise green/red/timeout without ever spawning a real process.
export function defaultCulpritTestRunner(wtPath, targets) {
  const pyTargets = targets.filter((t) => t.endsWith('.py'));
  const mjsTargets = targets.filter((t) => t.endsWith('.mjs'));
  const unknown = targets.filter((t) => !t.endsWith('.py') && !t.endsWith('.mjs'));
  if (unknown.length) {
    return {
      ok: false,
      detail: `unsupported culprit-test target extension: ${unknown.join(', ')}`,
    };
  }
  const runs = [];
  if (pyTargets.length)
    runs.push(['python', ['-m', 'pytest', ...pyTargets, '-q', '-p', 'no:cacheprovider']]);
  if (mjsTargets.length) runs.push(['node', ['--test', ...mjsTargets]]);
  // When THIS module's own caller is itself running under `node --test` (which is exactly the
  // case for this file's own test suite, and plausibly for a caller that shells out to
  // `pnpm test` internals), node stamps `NODE_TEST_CONTEXT=child-v8` into process.env — and a
  // child `node --test` that inherits it treats itself as a RECURSIVE nested run and silently
  // SKIPS running any files at all, exiting 0 no matter what the target actually does (Node
  // prints "run() is being called recursively within a test file. skipping running files.").
  // That would read a genuinely RED culprit test as a false green vouch, so it is stripped from
  // the child's env here rather than trusting a bare `{...process.env}` spread.
  //
  // Review finding [7] (PLAUSIBLE): this is the THIRD independent copy of this exact hazard fix —
  // wiki-commit.mjs's checkWikiLoaderCoverageOrThrow (`delete env.NODE_TEST_CONTEXT`) and
  // scripts/hooks/pre-push.sh's own defensive unset are the other two. A shared spawn-env helper
  // would close the drift risk, but every existing copy lives OUTSIDE this file (wiki-commit.mjs
  // is not on this plan's file allowlist, and pre-push.sh is bash, not an importable module) —
  // extracting one now would mean editing a file this fix is not permitted to touch, so this stays
  // a documented, cross-referenced local copy rather than a silent fourth divergence risk.
  const { NODE_TEST_CONTEXT: _dropNodeTestContext, ...spawnEnv } = process.env;
  let detail = '';
  for (const [cmd, args] of runs) {
    try {
      detail += execFileSync(cmd, args, {
        cwd: wtPath,
        encoding: 'utf8',
        timeout: CULPRIT_TEST_TIMEOUT_MS,
        maxBuffer: GIT_MAXBUFFER,
        env: spawnEnv,
      });
    } catch (err) {
      // Fail-closed on EVERYTHING: a non-zero exit, a timeout (execFileSync sets `err.signal` to
      // SIGTERM and `err.killed` true), or a spawn error (ENOENT — python/node missing) all land
      // here and all mean the same thing to a release decision: this plan is NOT vouched.
      detail += `${err?.stdout ?? ''}${err?.stderr ?? ''}${err?.message ?? ''}`;
      return { ok: false, detail };
    }
  }
  return { ok: true, detail };
}

// Runs `targets` (already-resolved repo-relative paths) against the merged tree via an
// INJECTABLE runner seam — the module never spawns a real test process itself when a test
// double is supplied, which is what lets the suite below prove green/red/timeout behaviour
// deterministically. Fail-closed: no targets, a malformed runner result, or a thrown runner all
// return `ok:false` — never let an evidence-gathering bug read as a green vouch.
export function runCulpritTests(wtPath, targets, { runner = defaultCulpritTestRunner } = {}) {
  if (!targets || !targets.length) return { ok: false, detail: 'no test targets to run' };
  try {
    const result = runner(wtPath, targets);
    if (!result || typeof result.ok !== 'boolean') {
      return { ok: false, detail: 'runCulpritTests: runner returned a malformed result' };
    }
    return result;
  } catch (err) {
    return { ok: false, detail: err?.message || String(err) };
  }
}

// Per finding: `{ path, plans: [{ id, targets, status }], vouched }`. `status` is 'missing' (no
// test target found — culpritTestTargets returned []), 'red' (targets found but the run did not
// come back ok), or 'green'. `vouched` is true IFF every culprit plan has >=1 target AND every
// one of them ran green — a single missing or red plan, or a run error, drops it to false. Never
// called for an `unsound` (shallow-history) finding: that finding names no culprit plans to run
// tests FOR, and it already has its own WARN-only path (see the header's plan-2908 T1/E2 note)
// that this function must not disturb.
export function culpritTestEvidence(wtPath, findings, { runner } = {}) {
  const out = [];
  // Review finding [5]: the SAME culprit plan commonly names the SAME target set on more than
  // one finding (one plan's landed change touched several files this land reverts lines in), and
  // without memoization each finding re-ran that plan's tests from scratch — up to
  // CULPRIT_TEST_TIMEOUT_MS PER extra finding, purely to re-derive a result already in hand.
  // Keyed on the SORTED target list (not planId): what actually varies the cost is the targets
  // actually spawned, and two different plans that happen to share a target set (an edge case,
  // but a real one for the fallback sibling-test path) are just as safe to fold together.
  const ranByTargetKey = new Map();
  const runOnce = (targets) => {
    const key = [...targets].sort().join(' ');
    if (ranByTargetKey.has(key)) return ranByTargetKey.get(key);
    const result = runCulpritTests(wtPath, targets, { runner });
    ranByTargetKey.set(key, result);
    return result;
  };
  for (const f of findings || []) {
    if (f.unsound) continue;
    const byPlan = culpritTestTargets(wtPath, f);
    const plans = byPlan.map(({ planId, targets }) => {
      if (!targets.length) return { id: planId, targets, status: 'missing' };
      const { ok } = runOnce(targets);
      return { id: planId, targets, status: ok ? 'green' : 'red' };
    });
    const vouched = plans.length > 0 && plans.every((p) => p.status === 'green');
    out.push({ path: f.path, plans, vouched });
  }
  return out;
}

// Render the advisory (plan 3832; this was the LANDED_REVERSION seam reason): names the file,
// how much of master it drops, and
// the plan(s) whose landed lines those are — line-level attribution derived from the finding
// itself, which is strictly sharper than the plan-1000 path-level attributeConflict the old
// rule borrowed. Defensive on shape: done-worktree's DRY-run fake supplies bare `{path}`
// objects to exercise the seam's wiring, and this must render those without throwing.
//
// `masterRef` (plan 2917 T3′, review finding ucq7li) is the ONE opt, and it is read — this is
// not a reversal of plan 2585's review finding F8, which deleted a `(wtPath, findings, opts)`
// signature whose body never touched either extra parameter. Naming the ref matters precisely
// because done-worktree does NOT pass the string `origin/master`: plan 2433 pins the check to
// the exact sha the rebase proved current, so a message hard-coding `origin/master` names a
// ref that may already have moved past the thing actually compared. The default keeps the
// standalone CLI and the older two-arg call shape rendering exactly as before.
//
// `evidence` (plan 3210 Part 2/3) is `culpritTestEvidence`'s output, OPTIONAL and byte-compatible
// when omitted — every existing caller and test that calls this with only `findings` (or
// `{masterRef}`) renders EXACTLY as before. When supplied, a `vouched` finding gets an appended
// block that (a) names the plans and exact test targets that vouched, (b) is honest about what
// that proves — tests passing, NOT "no reversion": an uncovered helper is invisible to it — and
// (c) — until plan 3832 — stated the R1 release path plus a ready-to-run
// `--allow-landed-reversion` invocation. That half is GONE with the halt it released: there is
// no exit for tests-green to change any more, because this renderer's output is a report.
export function reversionPreflightReason(findings, { masterRef = 'origin/master', evidence } = {}) {
  const evByPath = new Map((evidence || []).map((e) => [e.path, e]));
  const lines = (findings || [])
    .map((f) => {
      // plan 2917 T3′: cap the named culprits. The attribution walk can legitimately spread a
      // large stale-copy restore across many plans (the incident named four; a whole-file
      // restore of a hot file can name far more), and an unbounded list buries the actionable
      // head of it — `plans[]` arrives sorted by attributed lines desc, so the first few ARE
      // the ones worth reading. Purely a render cap over data already in hand: no new git
      // spawns, and the finding object itself is left whole for programmatic callers.
      const all = f.plans || [];
      const who = all
        .slice(0, MAX_RENDERED_PLANS)
        .map((p) => `plan ${p.id} (${String(p.sha).slice(0, 9)} "${p.subject}", ${p.lines} lines)`)
        .join(', ');
      const omitted = Math.max(0, all.length - MAX_RENDERED_PLANS);
      const culprits =
        (who || 'another plan') +
        (omitted ? ` (+${omitted} more plan${omitted === 1 ? '' : 's'} not shown)` : '');
      // plan 2908 (review 28e99e): an UNSOUND finding names no culprits by construction, but it
      // still knows HOW MUCH was removed — and that count is the whole of what the operator can
      // act on, so it must not be dropped just because `attributed` is absent.
      // plan 3246 CLASS 2: `removedLines` is git's raw numstat deletion count, which on a
      // reformatted file overstates what was actually taken off master. Name the excluded
      // remainder rather than quietly printing a number the attribution no longer agrees with.
      const repad = f.reformatted
        ? ` (${f.reformatted} further deleted line${f.reformatted === 1 ? '' : 's'} ` +
          `whitespace-only reformats, excluded)`
        : '';
      const scale =
        f.attributed != null
          ? ` — drops ${f.removedLines} lines from ${masterRef}${repad}, ${f.attributed} of them landed by ${culprits}`
          : f.removedLines != null
            ? ` — drops ${f.removedLines} lines from ${masterRef}` +
              (f.unsound ? ` (attribution unsound: ${f.unsound} — no culprits can be named)` : '')
            : '';
      const base = `  - ${f.path}${scale}`;
      const ev = evByPath.get(f.path);
      if (!ev || !ev.vouched) return base;
      const who2 = ev.plans.map((p) => `plan ${p.id}'s tests (${p.targets.join(', ')})`).join(', ');
      // Honest naming (plan 3210 design note): this proves the BEHAVIOUR THOSE TESTS COVER
      // survives, never "no reversion" — an uncovered helper is invisible to it.
      return (
        `${base}\n` +
        `      VOUCHED: ${who2} PASS on the merged tree, so the behaviour those tests cover ` +
        `survives this land. This does NOT prove no reversion — an uncovered helper is invisible ` +
        `to it.`
      );
    })
    .join('\n');
  return (
    `landed-work-reversion lint (plan 2274, rule reformulated by plan 2585; ADVISORY since plan ` +
    `3832): merging this branch REMOVES lines from ${masterRef} that another plan landed there — ` +
    `the _places_geo.py near-miss class (a whole-file/stale-copy restore silently reverting ` +
    `intervening plans). This is the merged tree vs ${masterRef}, so it is NOT branch staleness: ` +
    `content this branch simply never absorbed is re-supplied by the merge and is never reported ` +
    `here.\n` +
    `${lines}\n` +
    // plan 3832: this is a REPORT, so it says what was found and what to check — it no longer
    // ends in a remedy-plus-override menu, because there is no halt to be released from. If the
    // removals below are deliberate (a refactor, a rerun rewriting generated artefacts, code
    // deleted with the tests that covered it), nothing is required of the reader at all.
    `If any line above was NOT meant to go, patch-replay the branch's OWN diff onto CURRENT ` +
    `origin/master (git apply --3way / cherry-pick) — never a whole-file restore for a file not ` +
    `exclusively owned by this plan; diff-and-splice shared files instead ` +
    `(docs/runbooks/branch-hygiene.md § Landed-work-reversion lint). ` +
    `\`node scripts/coord/assert-no-landed-reversion.mjs --explain <path>\` pairs each dropped line ` +
    `with its nearest surviving successor, which is the fastest way to tell a rewrite from a ` +
    `restore by eye.`
  );
}

// plan 2908 T1/E2: the WARN an UNSOUND finding becomes. Shared by done-worktree's preflight and
// the CLI below so the two can never drift into telling an operator different things about the
// same condition. Deliberately NOT phrased as "unshallow for a real verdict": unshallowing buys a
// SOUND attribution, which is a different thing from a clean verdict — a land that legitimately
// rewrites another plan's lines still trips the rule afterwards (plan 2908 defect class 2, now
// ACCEPTED rather than pending: plan 2917 ruled its exemption out, see the header's § RULED OUT;
// review e497f1 caught the original wording promising otherwise).
//
// `masterRef` (plan 2917 T3′ round 2) is threaded for the SAME reason as in
// reversionPreflightReason above, and by the same callers: this renderer and that one describe
// the SAME run, so naming different refs for it is a drift of exactly the kind this function was
// shared to prevent. The default reproduces the pre-2917 string byte-for-byte, so the shallow
// downgrade plan 2908 shipped is unchanged for every caller that omits the opt.
export function unsoundWarnBlock(findings, { masterRef = 'origin/master' } = {}) {
  const rows = (findings || [])
    .map((f) => `  - ${f.path} (${f.removedLines ?? '?'} lines removed from ${masterRef})`)
    .join('\n');
  return (
    `landed-work-reversion lint: could NOT judge ${(findings || []).length} file(s) — this is a ` +
    `SHALLOW clone, so the attribution walk would name whichever plan the graft boundary commit ` +
    `happens to mention rather than the real author. Removed-line counts below; no culprits ` +
    `named. Nothing here blocks the land (plan 3832) — this note exists so a shallow clone's ` +
    `silence is not mistaken for a clean verdict.\n` +
    `${rows}\n` +
    `To get a SOUND attribution for these files, deepen the clone (\`git fetch --unshallow\`) and ` +
    `re-run. Note that a sound run can still legitimately flag a diff that deliberately rewrites ` +
    `another plan's lines — read the attribution before acting on it.`
  );
}

// plan 3832: the scope-pinned RELEASE apparatus lived here — `assertReleaseFlagOk`,
// `parseReversionScope`, `reviewerVerdictUpheld`, `releasedFindings`, `computeReversionRelease`,
// `REVERSION_RELEASE_FLAGS_WITH_VALUE`, `parseReversionCliArgs`, `validateReleaseFlags` and
// `landedReversionOverrideTrailer` (plan 3210 Part 3, under the R1 operator ruling of
// 2026-08-16). All retired together, because a "release" is only meaningful against a gate that
// STOPS a land, and this one no longer does: done-worktree prints its findings and merges. The
// R1 ceremony it encoded — dispatch an independent adversarial reviewer before overriding — is
// not lost, it simply has no gate to be the price of; a reader who wants that analysis runs
// `--explain` below and asks for it.
//
// The CLI's own `--explain <path>` flag is parsed inline in `main()` now, since it was the only
// survivor of the four-flag scanner those two entry points used to share.

// --- --explain: DISPLAY-only dropped-line/successor pairing (plan 3210) ----------------------
//
// Cheap token-overlap similarity (Jaccard over \W-delimited tokens) — good enough to pick the
// most-alike surviving line for a human to eyeball, and DELIBERATELY simpler than the
// (disproven, see the RULED OUT block above) nearest-revision distance metric from Part 1. This
// is NOT a resurrection of that detector: nothing here judges intent or decides release: a
// human reads the pairing this prints and decides, per the R1 release path.
function explainTokenize(line) {
  return new Set(
    String(line)
      .split(/[^a-zA-Z0-9_]+/)
      .filter(Boolean),
  );
}
function explainSimilarity(a, b) {
  const ta = explainTokenize(a);
  const tb = explainTokenize(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}
// A generous-but-not-silly floor: below this the "nearest" line is noise, not a successor.
const EXPLAIN_SIMILARITY_FLOOR = 0.3;
function nearestSuccessorLine(line, candidates) {
  let best = null;
  let bestScore = EXPLAIN_SIMILARITY_FLOOR;
  for (const cand of candidates) {
    const score = explainSimilarity(line, cand);
    if (score >= bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best;
}

// `{ path, pairs: [{ dropped, planId, successor }] }` for one file, or null on any git failure
// (same fail-open posture as the rest of this module — --explain is a DISPLAY aid, never a gate).
// `successor` is `null` when nothing in the merged tree clears EXPLAIN_SIMILARITY_FLOOR — printed
// as "(no successor)" by the CLI below.
export function explainDroppedLines(
  wtPath,
  path,
  { masterRef = 'origin/master', branchRef = 'HEAD', base } = {},
) {
  try {
    const tree = mergedTreeOid(wtPath, masterRef, branchRef, { base });
    if (!tree) return null;
    // Review finding (plan 3246 round 2, CONFIRMED): resolve a RENAME exactly as
    // detectLandedReversion does (`masterPath = oldPath || path`). Master still knows a renamed
    // file by its OLD name, so a walk under the new name surfaces none of the commits that
    // authored its lines — and --explain then printed "no dropped attributed line found" for a
    // halt that was real and correctly attributed, telling the R1 reviewer the opposite of the
    // truth. numstat is the cheap side of git's rename detection; the -U0 patch below needs BOTH
    // names in its pathspec to see the file at all.
    //
    // GATED on a cheap existence probe (review finding, plan 3246 round 3): a rename means
    // masterRef does NOT know this name, so if `masterRef:path` resolves there is nothing to
    // resolve and the whole-tree numstat is skipped. Running it unconditionally reintroduced
    // exactly the O(whole-land-diff) cost the lazy `elsewhere` lookup below exists to avoid —
    // on a >500-file seed land, every --explain of an ordinary file paid a full rename-detection
    // pass for nothing.
    let renameRow = null;
    let mightBeRenamed = false;
    try {
      git(wtPath, ['cat-file', '-e', `${masterRef}:${path}`]);
    } catch {
      mightBeRenamed = true; // absent from master under this name — a rename or a new file
    }
    if (mightBeRenamed) {
      try {
        renameRow =
          parseNumstatZ(
            git(wtPath, ['diff', '--no-ext-diff', '--numstat', '-M', '-z', masterRef, tree]),
          ).find((row) => row.path === path && row.oldPath) || null;
      } catch {
        /* fail-open: no rename resolved just means the current name is used, as before */
      }
    }
    const { masterPath, pathspec } = renamePathsFor(renameRow || { path });
    const sets = diffLineSets(
      git(wtPath, ['diff', '--no-ext-diff', '-U0', '-M', masterRef, tree, '--', ...pathspec]),
    ).get(path);
    // Review finding (plan 3246 round 1, CONFIRMED): --explain must describe the SAME land the
    // halt describes, so it applies the CLASS-2 reformat filter `detectLandedReversion` applies.
    // Without it, a land that both re-pads a table and genuinely reverts something listed the
    // re-padded rows as extra "dropped" lines — inflating exactly the table the R1 reviewer is
    // told to read before deciding whether to UPHOLD a release.
    // plan 3394 (gpt-review findings 3/22, CONFIRMED): the raw sets ride here too, for the very
    // reason the round-1 comment above gives. --explain must describe the SAME land the halt
    // describes; left on the trimmed-only call it would list every re-indented line as "dropped"
    // in exactly the table the R1 reviewer is told to read, while the halt itself no longer counts
    // them — the two disagreeing is worse than either being wrong alone.
    const { net: removed } = netRemovedLines(sets?.removed, sets?.added, {
      removedRaw: sets?.removedRaw,
      addedRaw: sets?.addedRaw,
    });
    if (!removed.size) return { path, pairs: [] };
    const own = ownPlanIds(wtPath, masterRef, branchRef);
    const history = attributionHistoryFor(wtPath, masterRef, masterPath);
    const { plans } = attributeRemovals(removed, history, own, { withLines: true });
    let survivorLines = [];
    try {
      survivorLines = git(wtPath, ['show', `${tree}:${path}`]).split('\n');
    } catch {
      survivorLines = []; // file gone in the merged tree — every dropped line reports no successor
    }
    // plan 3246 CLASS 3 — the RELOCATION shape the table could not previously show.
    //
    // Firings 2855 (inline strings moved into a new lib_incomplete_reasons.py; the gate named
    // SEVEN plans as reverted while every removed string existed in the new module) and 2892
    // (a function moved to its owner module, re-exported; 55 of 71 "dropped" lines reappear
    // verbatim elsewhere in the branch diff). Both are single-owner refactors, and both were
    // invisible here: survivors were read from THIS file alone, so every dropped line printed
    // "(no successor)" — the one reading that would have told the reviewer at a glance that the
    // content moved rather than died.
    //
    // Strictly REPORTING, per the plan-3246 bound and 3210's operator ruling R1: a cross-file
    // successor never releases a finding, never lowers the count, and never reaches
    // detectLandedReversion. It is a line on a table a human reads before deciding.
    //
    // Review finding (plan 3246 round 1, CONFIRMED — efficiency): built LAZILY, on the first
    // dropped line that has no same-file successor. The whole-tree diff scales with the entire
    // land, not with the one file being explained, and this repo's lands routinely carry >500
    // sharded seed files — so paying it unconditionally turned a cheap single-file question into
    // an O(whole-land-diff) one on every invocation. A file whose dropped lines all have
    // same-file successors (and the common no-relocation case) never spawns it at all.
    let elsewhere = null;
    const relocatedPathFor = (line) => {
      if (elsewhere === null) {
        elsewhere = new Map();
        try {
          for (const [otherPath, other] of diffLineSets(
            git(wtPath, ['diff', '--no-ext-diff', '-U0', '-M', masterRef, tree]),
          )) {
            if (otherPath === path) continue;
            for (const l of other.added) if (!elsewhere.has(l)) elsewhere.set(l, otherPath);
          }
        } catch {
          /* display aid: a failed whole-tree diff just means no cross-file successors are offered */
        }
      }
      return elsewhere.get(line) || null;
    };
    const pairs = [];
    for (const p of plans) {
      for (const line of p.claimedLines || []) {
        const sameFile = nearestSuccessorLine(line, survivorLines);
        // Same-file first — a line still in its own file is the stronger reading. Only when
        // nothing there clears the floor is the verbatim relocation elsewhere offered.
        const movedTo = sameFile ? null : relocatedPathFor(line);
        pairs.push({
          dropped: line,
          planId: p.id,
          successor: sameFile ?? (movedTo ? line : null),
          successorPath: movedTo,
        });
      }
    }
    return { path, pairs };
  } catch {
    return null;
  }
}

// --- CLI (standalone use / manual invocation — done-worktree.mjs imports the functions above
// directly and merely PRINTS what they return; this entry point is the one place a landed-work
// reversion still produces a non-zero exit, and nothing in the land spine calls it) ---
export async function main(argv) {
  // plan 3832: no `ALLOW_LANDED_REVERSION` bypass any more. It existed so a blocked LAND could
  // proceed; this CLI blocks nothing but its own exit code, and a caller that does not want a
  // non-zero exit on findings simply does not run it. `--explain <path>` is now the only flag,
  // parsed inline (it was the sole survivor of the four-flag scanner this file used to share
  // with done-worktree.mjs).
  const list = argv || [];
  const positional = [];
  let explainPath = null;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '--explain') explainPath = list[++i] ?? null;
    else positional.push(list[i]);
  }
  const wtPath = positional[0] || process.cwd();
  // One name for the compared ref, resolved once and threaded into both the probe and the
  // render (plan 2917 T3′) — two independent literals could drift into telling an operator the
  // finding is against a ref the walk never used. The CLI has no rebase to pin to, so this is
  // the guard's documented default: live origin/master.
  const masterRef = 'origin/master';

  // plan 3210 Part 3: --explain <path> is a standalone DISPLAY mode — it never runs the halt
  // logic below, and it is available even with no other flags.
  if (explainPath) {
    const result = explainDroppedLines(wtPath, explainPath, { masterRef });
    if (!result || !result.pairs.length) {
      console.log(
        `assert-no-landed-reversion --explain: no dropped attributed line found for ${explainPath}`,
      );
      return 0;
    }
    console.log(
      `assert-no-landed-reversion --explain ${explainPath} — each dropped attributed line beside ` +
        `its nearest surviving successor in the merged tree (DISPLAY AID ONLY — nothing here ` +
        `judges intent; a human reads the pairing and decides):`,
    );
    for (const { dropped, planId, successor, successorPath } of result.pairs) {
      console.log(`  [plan ${planId}] - ${dropped}`);
      // plan 3246: name the file a relocated line moved TO — without it a verbatim move read
      // identically to a deletion, which is what made the two relocation firings unreadable.
      const where = successorPath ? `   [relocated to ${successorPath}]` : '';
      console.log(`               + ${successor ?? '(no successor)'}${where}`);
    }
    return 0;
  }

  const findings = detectLandedReversion(wtPath, { masterRef });
  // plan 2908 T1/E2 (review db9384): the CLI splits exactly as done-worktree's preflight does —
  // an unsound finding is a WARN on stderr, never a non-zero exit. Exiting 1 on "cannot judge"
  // would recreate, in the standalone entry point, the cry-wolf habit plan 2908 set out to end
  // (and plan 3832 finished, by taking the halt off the land spine entirely).
  const unsound = findings.filter((f) => f.unsound);
  const sound = findings.filter((f) => !f.unsound);
  if (unsound.length)
    console.error(
      `assert-no-landed-reversion: WARNING — ${unsoundWarnBlock(unsound, { masterRef })}`,
    );
  if (sound.length) {
    // plan 3210 Part 2: gather culprit-test evidence for every sound finding, so the message can
    // name which culprit plans' tests still pass on the merged tree. plan 3832 kept this on the
    // CLI — a human running this probe deliberately is exactly who that evidence is for — while
    // dropping it from the land spine, where it only ever fed a release decision that no longer
    // exists.
    const evidence = culpritTestEvidence(wtPath, sound);
    console.error(reversionPreflightReason(sound, { masterRef, evidence }));
    // A non-zero exit is this CLI's whole output contract for a deliberate probe. It halts no
    // land: done-worktree imports the functions above and prints, it does not shell out here.
    return 1;
  }
  if (unsound.length) return 0;
  console.log(
    'assert-no-landed-reversion: clean — merging this branch drops no landed work from origin/master',
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error('assert-no-landed-reversion:', e.message);
      process.exit(1);
    },
  );
}
