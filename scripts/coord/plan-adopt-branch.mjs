#!/usr/bin/env node
// scripts/plan-adopt-branch.mjs — the SINGLE authority for a plan's `adoptBranch:` stamp
// (plan 3111).
//
// WHY the stamp exists. Plan 2863 taught `queue-drain.mjs --cloud` to EXCLUDE a plan whose
// execution branch already sits on origin (`already-on-origin`), because on 2026-08-05 four
// independent cloud firings each executed plan 2855 end-to-end inside ~70 minutes. That gate
// is correct and must not be weakened. But it cannot separate two states that look identical
// from origin:
//
//   • a RIVAL is executing right now — the branch is a live marker → exclude (correct today);
//   • a prior execution is DEAD and its branch is a HAND-OFF — the branch is inherited work
//     → must be SELECTED, with an adopt instruction (wrongly excluded before this plan).
//
// Nothing in the branch itself distinguishes them, so the discriminator has to be an explicit
// assertion by whoever declares the prior execution dead — which IS the act of re-filing the
// plan into `ready/`. `adoptBranch: <branch>` is that assertion, and this module is the one
// place that writes it.
//
// WHY a shared leaf rather than one command. There are THREE live writers into `ready/` —
// `move-plan.mjs` (target `ready`), `next-plan-id.mjs --ready`, and `promoteWaitingBlocked`
// in `done-worktree.mjs`. The repo already has the pattern for exactly this situation: a leaf
// all three import so no writer can bypass the rule (`plan-cost-banner.mjs`'s
// `readyCostBannerError`, plan 1276; `build-index-lib.mjs`'s evidence-floor gate, plan 2943
// F6). This module is that leaf for the adopt axis.
//
// THE FIVE ARMS (`syncAdoptBranchStamp`'s `action`):
//   'stamped'     — origin carries EXACTLY ONE execution branch for the id, and it differs
//                   from what the body says → write `adoptBranch: <branch>`.
//   'stripped'    — origin carries NONE and the body carries a stamp → delete the key. The
//                   branch landed and was torn down; the stamp is dead and would otherwise
//                   send a drain at `cut-worktree --adopt=<gone>`.
//   'noop'        — nothing to do (already correct, or nothing on either side).
//   'ambiguous'   — origin carries MORE THAN ONE branch for the id. Nothing is written and
//                   every branch is named: plan 2855 had three at once, and "which one do I
//                   continue" is a human call, never an unattended one.
//   'unavailable' — the origin read failed. Nothing is written, NOTHING IS STRIPPED, and a
//                   warning is logged. Fails OPEN, matching the oracle's own posture
//                   (`queue-drain.mjs`'s originExecutedPlanIds): a re-file must never be
//                   bricked — nor a live stamp silently deleted — by a transient network blip.
//                   Treating 'unavailable' as "no branches found" is the single most damaging
//                   confusion available here, which is why it returns before any read/write.
//
// Module layout: this is a non-test `.mjs` under `scripts/`, so it imports nothing outside
// `scripts/` (docs/coord/scripts-layout.md). It reuses `originExecutedPlanIds` from
// queue-drain.mjs rather than re-rolling the `ls-remote` — one definition of "what counts as
// an execution branch for a plan id", including its id-canonicalisation discipline.

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Review fix (plan 3111 round 2, findings 1/13): THE shared atomic replace — never a local
// temp+rename. See the write site for what the hand-rolled copy was missing.
import { atomicWriteTextSync } from './atomic-write.mjs';
import {
  claimedIdOfBasename,
  escapeRegex,
  frontmatterEnd,
  readFrontmatterScalar,
  upsertFrontmatterKey,
} from './build-index-lib.mjs';
import { canonicalPlanId } from './batch-paths.mjs';
import {
  originExecutedPlanIds,
  PLAN_BASENAME_ID_RX,
  collapseSameShaBranches,
} from './queue-drain.mjs';

export const ADOPT_BRANCH_KEY = 'adoptBranch';

// The plan id a basename declares, canonicalised, or null.
//
// Review fix (plan 3111, findings 11/12 — CONFIRMED): this was a hand-rolled
// `/^(\d{3,})-(?=[A-Za-z])/`, a SECOND parser for a rule the repo already owns exactly once.
// `claimedIdOfBasename` (build-index-lib.mjs, plan 2082 review r9) is the canonical
// "leading digits + date-exclusion" wiring that `move-plan`'s resolvePlanRel and its
// claim-holder guard already share; the two regexes accept different basename shapes, so a
// plan `move-plan` recognises could have returned no id HERE — leaving its ready/-writer
// silently unstamped and the drain excluding its preserved branch forever. Delegate, then
// canonicalise (that module returns the raw digits, and every plan-id comparison in this
// toolchain is canonical so `0912` and `912` cannot miss each other).
// Review fix (plan 3111 round 2, findings 6/8/15; then round 3, findings 4/5/6 — all CONFIRMED):
// the two rules are INTERSECTED, and the oracle's half is IMPORTED, never re-spelled.
//
// Round 1 delegated to `claimedIdOfBasename` alone, which is LOOSER than the origin-branch parser
// this id is compared against: it excludes only a `NNNN-DD-DD-` date shape, so
// `3073-123-followup.md` and `3073-2026-05-17-x.md` both yielded an id here while
// `ORIGIN_EXECUTED_BRANCH_RXS` and `parsePlanMeta` require a LETTER after the id and see none for
// the matching branch — this module would stamp (or strip) against a map that structurally cannot
// contain that branch. Round 2 fixed the asymmetry with a LOCAL copy of the oracle's regex, which
// three separate round-3 angles flagged as the same drift one layer down; round 3 exported it
// (`PLAN_BASENAME_ID_RX`) so there is exactly one spelling for both sides of the comparison.
//
// Both halves are load-bearing: the oracle's shape makes this id set exactly the one the origin
// map can represent, and `claimedIdOfBasename` keeps the shared claim-parser's date-exclusion
// (and is the rule `move-plan`'s resolver uses, so a plan it can resolve is a plan we can stamp).
export function planIdFromBasename(basename) {
  const name = String(basename ?? '');
  if (!PLAN_BASENAME_ID_RX.test(name)) return null;
  const raw = claimedIdOfBasename(name);
  return raw ? canonicalPlanId(raw) : null;
}

// The DELETE twin of build-index-lib's `upsertFrontmatterKey`, written here rather than there
// because this axis is its only consumer today (promote it to the shared module the moment a
// second one appears). It reuses that module's OWN fence rule (`frontmatterEnd`) and key regex
// shape (`^key:`, so a no-space `key:value` line is matched) instead of a second literal — the
// exact drift `stripFrontmatter`'s header documents as bug 2 of plan 2368. Removes the FIRST
// matching line only, mirroring upsert's own first-match semantics; EOL-aware for the same
// reason (plan 1328's CRLF round-trip).
export function removeFrontmatterKey(content, key) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const end = frontmatterEnd(lines);
  if (end === -1) return content;
  const rxKey = new RegExp(`^${escapeRegex(key)}:`);
  for (let i = 1; i < end; i++) {
    if (!rxKey.test(lines[i])) continue;
    lines.splice(i, 1);
    return lines.join(eol);
  }
  return content;
}

// The stamp decision, PURE: plan body + the execution branches origin carries for its id →
// { content, action, branch, branches }. `branches` is the caller's already-resolved list, so
// this function never touches the network or the filesystem and every arm is unit-testable.
// The 'unavailable' arm is deliberately NOT reachable from here — an absent list and a FAILED
// read are the same value (`[]`) at this layer, so the distinction is made one level up, in
// syncAdoptBranchStamp, before this is ever called.
export function applyAdoptBranchStamp(content, branches) {
  const existing = readFrontmatterScalar(content, ADOPT_BRANCH_KEY) || null;
  const list = (Array.isArray(branches) ? branches : []).filter(Boolean);
  if (list.length > 1) return { content, action: 'ambiguous', branch: existing, branches: list };
  if (list.length === 0) {
    if (!existing) return { content, action: 'noop', branch: null, branches: [] };
    return {
      content: removeFrontmatterKey(content, ADOPT_BRANCH_KEY),
      action: 'stripped',
      branch: existing,
      branches: [],
    };
  }
  const branch = list[0];
  if (existing === branch) return { content, action: 'noop', branch, branches: list };
  return {
    content: upsertFrontmatterKey(content, ADOPT_BRANCH_KEY, branch),
    action: 'stamped',
    branch,
    branches: list,
  };
}

// Resolve origin's execution branches for `planPath`'s id and bring its `adoptBranch:` stamp
// into agreement, IN PLACE. Returns `{ action, branch, branches }` — see the five arms in this
// file's header.
//
// `planPath` may be absolute or relative to `mainDir`. `lsRemote` is the origin-heads reader
// (`(repoRoot) => Map<id, {name: string, fresh: boolean}[]> | null`), defaulting to queue-drain's
// `originExecutedPlanIds`
// and injectable so every test runs without a remote — the same seam that function already
// offers its own callers.
//
// CALLER CONTRACT: this WRITES the file but never commits it. Every one of the three `ready/`
// writers calls it while its own commit is still being assembled, so the frontmatter change
// rides that commit. It NEVER throws for a missing/unparseable id or an unreachable origin —
// one of its call sites is inside the done-worktree close-out spine, where a throw would abort
// a land mid-flight.
// plan 3767: the ONE place origin's execution heads for an id become the NAME list
// `applyAdoptBranchStamp` takes — shared by `syncAdoptBranchStamp` and the CLI's `main()`.
//
// It exists as a shared export because the first cut of this plan wired the collapse into
// `syncAdoptBranchStamp` only, and five review angles landed on the same consequence: the CLI kept
// its own `(map.get(id) || []).map((b) => b.name)`, so `node scripts/plan-adopt-branch.mjs <id>` —
// the DOCUMENTED repair command for precisely this deadlock — still reported `ambiguous` and wrote
// no stamp. Two callers, one rule, and the rule is unit-testable in its own right (the CLI has no
// test seam of its own).
//
// N execution branches sitting at ONE tip are one finished branch, not an unresolved rival: an
// override adopt's normalization push leaves its source on origin whenever the retirement delete is
// refused (the cloud proxy 403s DELETEs by verb, plan 3756). `collapseSameShaBranches` leaves a
// genuinely divergent list — different shas, any missing sha, or any FRESH (live) head — unchanged,
// so the `ambiguous` arm still guards the case it exists for (plan 2855: three tips, a human call).
//
// `keepStamp` is the one case the caller must handle before stamping: the body already names one of
// the duplicates the collapse just folded away (the exact plan-3652 shape — `adoptBranch:
// claude/drain-3652-…` while origin ALSO carries `worktree-3652-…` at the same tip). A match
// against EITHER same-tip name is a match, so the answer is 'noop' — re-stamping onto the preferred
// name would be a commit with no functional effect, not a correctness fix.
export function resolveAdoptBranchNames(entries, content) {
  const { branches: collapsed, duplicates } = collapseSameShaBranches(entries || []);
  const names = collapsed.map((b) => b.name);
  const dupNames = duplicates.map((b) => b.name);
  const existingStamp = readFrontmatterScalar(content, ADOPT_BRANCH_KEY) || null;
  return {
    names,
    duplicates: dupNames,
    keepStamp: existingStamp && dupNames.includes(existingStamp) ? existingStamp : null,
  };
}

export function syncAdoptBranchStamp(
  mainDir,
  planPath,
  { lsRemote = originExecutedPlanIds, log = console.error } = {},
) {
  const basename = String(planPath).split(/[\\/]/).pop();
  const id = planIdFromBasename(basename);
  // A legacy date-slugged or otherwise id-less plan has no execution-branch namespace to
  // compare against — silently nothing to do, exactly as the oracle's own gate treats it.
  if (!id) return { action: 'noop', branch: null, branches: [] };

  // Review fix (plan 3111, round-1 finding 18 then round-2 finding 14 — both CONFIRMED):
  // a caller that syncs SEVERAL plans in one pass (done-worktree's promoteWaitingBlocked can
  // promote N plans in one close-out, and one blocking `ls-remote` per plan at 20s each puts
  // minutes of redundant network wait inside the land spine) shares ONE resolve by passing
  // `lsRemote: () => cachedMap`. Round 1 added a SECOND `branchMap` option for this; round 2
  // removed it — two inputs for one value meant a caller supplying both got silent precedence,
  // and a stale snapshot could then stamp the wrong branch. ONE seam, and `null` from it still
  // means "origin unreadable" (change nothing), never "no branches found".
  let map = null;
  try {
    map = lsRemote(mainDir);
  } catch (e) {
    map = null;
    log(`plan-adopt-branch: WARNING — origin read threw (${e?.message || e}).`);
  }
  if (!map) {
    log(
      `plan-adopt-branch: WARNING — could not read origin's execution branches, so ${basename}'s ` +
        `adoptBranch stamp is left EXACTLY as it is (nothing stamped, nothing stripped). Re-run ` +
        `\`node scripts/plan-adopt-branch.mjs ${id}\` once connectivity is back.`,
    );
    return { action: 'unavailable', branch: null, branches: [] };
  }

  const abs = isAbsolute(planPath) ? planPath : join(mainDir, planPath);
  let content;
  try {
    content = readFileSync(abs, 'utf8');
  } catch (e) {
    log(`plan-adopt-branch: WARNING — could not read ${planPath} (${e?.message || e}).`);
    return { action: 'unavailable', branch: null, branches: [] };
  }

  const { names: branches, duplicates, keepStamp } = resolveAdoptBranchNames(map.get(id), content);
  if (keepStamp) return { action: 'noop', branch: keepStamp, branches };
  if (duplicates.length > 0)
    log(
      `plan-adopt-branch: collapsed ${duplicates.length} same-sha branch(es) for plan ${id} ` +
        `(${duplicates.join(', ')}) → adoptBranch: ${branches[0]}`,
    );
  const r = applyAdoptBranchStamp(content, branches);
  if (r.action === 'ambiguous') {
    log(
      `plan-adopt-branch: AMBIGUOUS — origin carries ${branches.length} execution branches for ` +
        `plan ${id} (${branches.join(', ')}). No adoptBranch stamp was written: which one a taker ` +
        `should continue is a human call. Fold or delete the extras, then re-run.`,
    );
    return { action: 'ambiguous', branch: r.branch, branches };
  }
  if (r.content !== content) {
    // Review fix (plan 3111, round-1 finding 14 then round-2 findings 1/13 — both CONFIRMED):
    // the write must be atomic (a plain writeFileSync opens O_TRUNC, so an ENOSPC/EIO partway
    // through leaves a TORN plan body that every caller here — all mid-commit — would then
    // commit while this function only reports 'unavailable'), and the atomicity must come from
    // the SHARED primitive, not a local temp+rename. Round 1 hand-rolled it; `atomic-write.mjs`
    // (plan 1778, itself extracted from a local mirror "before it could drift") already owns
    // fsync, close-error handling, the pid-scoped temp name landing-lock's orphan sweep knows,
    // and rmTempPath's recursive reap — every one of which the local copy omitted.
    try {
      atomicWriteTextSync(abs, r.content);
    } catch (e) {
      log(`plan-adopt-branch: WARNING — could not write ${planPath} (${e?.message || e}).`);
      return { action: 'unavailable', branch: r.branch, branches };
    }
  }
  return { action: r.action, branch: r.branch, branches };
}

// One human-readable line per action, shared by the CLI and by the three writers' warnings so
// the vocabulary can never drift between them.
export function describeAdoptAction(basename, { action, branch, branches }) {
  switch (action) {
    case 'stamped':
      return `${basename} → adoptBranch: ${branch}`;
    case 'stripped':
      return `${basename} → adoptBranch stripped (was ${branch}; origin no longer carries it)`;
    case 'ambiguous':
      return `${basename} → NOT stamped: origin carries ${branches.length} execution branches (${branches.join(', ')})`;
    case 'unavailable':
      return `${basename} → unchanged: origin's execution branches could not be read`;
    default:
      return `${basename} → no change needed`;
  }
}

// --- CLI ---------------------------------------------------------------------
//
// `node scripts/plan-adopt-branch.mjs <id|basename> [--dry]` runs the same sync on a plan IN
// PLACE — the path by which a plan already resting in `ready/` gets its stamp without a
// spurious `move-plan` round trip. The write lands through the shared coord spine
// (`stamp-lib.mjs`'s stampFrontmatterAxis: disposable coord-checkout → pathspec commit with
// the Coord-Write trailer → push → path-scoped rollback), never a hand commit, because plan
// bodies are coordination state.
//
// stamp-lib.mjs imports move-plan.mjs, and move-plan.mjs imports THIS module — so the import
// is deliberately DYNAMIC, inside main(). A static edge would make the cycle
// move-plan → plan-adopt-branch → stamp-lib → move-plan real at module-evaluation time; the
// repo tolerates such cycles when neither side is used at load (claim-plan ↔ release-claim),
// but move-plan sits under every coord tool in the repo and a load-order surprise there is not
// worth saving one line. Nothing else in this file reaches stamp-lib, so the leaf the three
// writers import stays cycle-free.
const USAGE = 'usage: plan-adopt-branch.mjs <id|basename> [--dry]';

export async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const dry = argv.includes('--dry');
  const idOrName = argv.filter((a) => !a.startsWith('--'))[0];
  if (!idOrName) {
    console.error(USAGE);
    return 2;
  }

  const { resolveMain } = await import('./coord-git.mjs');
  const { lsPlans, resolvePlanRel } = await import('./move-plan.mjs');
  const { stampFrontmatterAxis } = await import('./stamp-lib.mjs');

  const mainDir = resolveMain();
  const rel = resolvePlanRel(lsPlans(mainDir), idOrName);
  const basename = rel.split('/').pop();
  const id = planIdFromBasename(basename);
  if (!id) {
    console.error(`plan-adopt-branch: ${basename} has no parseable plan id — nothing to stamp.`);
    return 2;
  }

  // Resolve origin ONCE, here, so the closure below stays a pure string→string mutation (what
  // stampFrontmatterAxis's contract requires) and a dry run costs the same one round trip a
  // real one does.
  const map = originExecutedPlanIds(mainDir);
  if (!map) {
    console.error(describeAdoptAction(basename, { action: 'unavailable', branches: [] }));
    return 1;
  }
  // plan 3767 (gpt-review fix): the SAME resolver `syncAdoptBranchStamp` uses — never a second
  // map-to-names of its own. This is the operator's documented repair command for the very
  // deadlock the collapse exists to clear, so a CLI that skipped it would answer `ambiguous` on
  // exactly the input the plan was written to fix.
  const mainContent = readFileSync(join(mainDir, rel), 'utf8');
  const { names: branches, keepStamp } = resolveAdoptBranchNames(map.get(id), mainContent);
  if (keepStamp) {
    // The stamp already names one of the same-tip branches — nothing to write, and (as with
    // every other write-nothing arm here) no coord lock is taken.
    console.log(
      `plan-adopt-branch: ${describeAdoptAction(basename, {
        action: 'noop',
        branch: keepStamp,
        branches,
      })}`,
    );
    return 0;
  }
  const preview = applyAdoptBranchStamp(mainContent, branches);
  if (preview.action !== 'stamped' && preview.action !== 'stripped') {
    // 'noop' and 'ambiguous' both write nothing — report and stop WITHOUT taking the coord
    // lock. (A commit with an empty diff would fail anyway; not taking the lock is the point.)
    console.log(`plan-adopt-branch: ${describeAdoptAction(basename, preview)}`);
    return preview.action === 'ambiguous' ? 1 : 0;
  }

  const verb =
    preview.action === 'stamped'
      ? `set ${ADOPT_BRANCH_KEY}: ${preview.branch}`
      : `remove ${ADOPT_BRANCH_KEY} (was ${preview.branch})`;
  // Review fix (plan 3111, finding 13 — CONFIRMED): the preview is decided against MAIN's copy
  // but the COMMIT is decided against the coord checkout's ff-synced bytes, so the two can
  // legitimately differ (a sibling session moved or re-stamped the plan in between). Reporting
  // the PREVIEW as if it were what happened would tell an operator a plan was repaired when the
  // committed bytes say otherwise. Capture what `mutateBody` actually decided and report THAT;
  // the preview keeps its one remaining job — deciding whether to take the coord lock at all.
  let applied = null;
  const result = await stampFrontmatterAxis({
    tool: 'plan-adopt-branch',
    idOrName,
    dry,
    // Re-decides against the coord checkout's ff-synced bytes rather than reusing `preview`'s
    // content: MAIN's working copy can be a commit or two behind, and the committed body must
    // be derived from what is actually being committed.
    mutateBody: (body) => {
      applied = applyAdoptBranchStamp(body, branches);
      return applied.content;
    },
    // Review fix (plan 3111 round 2, finding 12 — CONFIRMED): the subject is ACTION-NEUTRAL.
    // stamp-lib computes it BEFORE mutateBody runs, so it can only be built from the MAIN-side
    // preview — and if the coord checkout's bytes differ, an action-specific subject ("stamp X"
    // / "strip X") would title a commit with something the committed body contradicts, leaving
    // git history asserting a branch was stamped when it was not. Naming the axis instead of
    // the outcome is true under every arm; the committed frontmatter is the record of which.
    commitSubject: ({ basename: b }) => `docs(plans): sync ${b} adoptBranch against origin`,
    dryPreview: () => [`[dry] ${verb}`],
  });

  // `applied` is null on the --dry path (mutateBody never runs), where the preview IS the report.
  const reported = applied ?? preview;
  if (applied && applied.action !== preview.action)
    console.error(
      `plan-adopt-branch: NOTE — the coord checkout's copy differed from MAIN's, so the committed ` +
        `action is "${applied.action}", not the previewed "${preview.action}".`,
    );
  console.log(
    result.dry
      ? `plan-adopt-branch: [dry] ${describeAdoptAction(basename, reported)} (no changes made)`
      : `plan-adopt-branch: ${describeAdoptAction(basename, reported)} — committed + pushed`,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error('plan-adopt-branch:', e.message);
      process.exit(e.fatal ? 2 : 1);
    },
  );
}
