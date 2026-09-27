#!/usr/bin/env node
// scripts/coord/reconcile-worktree-branches.mjs — read-only worktree/branch/claim-ref hygiene
// sweeper (plan 1473, the standing-tool follow-up to plan 1407's one-shot manual audit).
//
// 1407's audit found repeatable teardown-miss residue and traced it to TWO independent,
// non-overlapping gaps — neither a bug in done-worktree.mjs's own branch-delete path
// (which cleans up fine when it actually runs):
//   1. `move-plan`-mediated supersession bypasses teardown entirely (move-plan has zero
//      worktree/branch awareness), orphaning the branch by construction.
//   2. Windows empty-directory husks are already-recorded rmdir failures: done-worktree
//      cleanly DEREGISTERS the worktree from git (no `.git` pointer, no admin entry left),
//      but the forced directory removal can lose to a locked long-path handle — and that
//      teardownErrors entry is never revisited by anything.
// So the residue needs a periodic SWEEP, not a done-worktree patch (teaching move-plan to
// reach into worktree/branch state crosses a responsibility boundary it doesn't have, and
// retrying the Windows rmdir inside done-worktree just re-fights the same lock race).
//
// READ-ONLY / advisory by design, in the exact style of reconcile-board.mjs: it enumerates,
// classifies, and prints the exact remediation command for a human to run — it NEVER calls
// `git branch -D`, `git push --delete`, `rm -rf`, or `git update-ref -d` itself. Trigger
// doctrine (decided at spec-pass): operator-invoked only, no Stop-hook wiring — mirrors
// reconcile-board.mjs's invocation model.

import { pathToFileURL } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, resolveMain, isAncestorRef, deadSeedVerdict, lsRemoteTimed } from './coord-git.mjs';
import { planIdOf, parseLsRemote } from './claim-plan-lib.mjs';
// coord-refs.mjs imports nothing, so this adds no new cross-tree edge (plan 3756 step 2).
// Legacy constructors only — this step does not flip the namespace.
import { planIdFromClaimRef, claimRef, CLAIM_GLOB, LEGACY_CLAIM_GLOB } from './coord-refs.mjs';
import { heldClaimsMap } from './claim-plan.mjs';

const WORKTREES_DIR = '.claude/worktrees';
const PLANS_PREFIX = 'docs/superpowers/plans';
const BRANCH_PREFIX = 'worktree-';
const DRAIN_BRANCH_PREFIX = 'claude/drain-';
// origin/staging backs live Render infra (docs/coord/worktrees.md) — never a
// candidate for deletion. It can never actually reach classifyMergedBranches via the real
// gather path (listWorktreeBranches only enumerates `worktree-*` refs), but the guard stays
// explicit so the classifier is provably safe on its own, not merely safe-by-construction of
// its caller.
const STAGING_NAMES = new Set(['staging', 'origin/staging', 'refs/heads/staging']);

// --- pure classification -----------------------------------------------------------------

// Worktree DIR husks: entries under .claude/worktrees/ with NEITHER a `.git` pointer file NOR
// a registered git-worktree admin entry — git has completely forgotten them (the 1407 finding:
// a done-worktree teardown that deregistered the worktree cleanly but lost the Windows rmdir
// race on a locked long-path handle). A live OR parked worktree always has at least one of the
// two signals, so this can never mis-flag an active session's tree.
export function classifyHusks(entries) {
  return entries.filter((e) => !e.hasGitPointer && !e.hasAdminEntry).map((e) => e.name);
}

// The plan id embedded in a `worktree-<slug>` or `claude/drain-<slug>` short name, or null when
// the name has neither execution prefix or its slug isn't plan-id-prefixed.
export function planIdFromBranch(branchName) {
  const name = String(branchName);
  const prefix = [BRANCH_PREFIX, DRAIN_BRANCH_PREFIX].find((candidate) =>
    name.startsWith(candidate),
  );
  if (!prefix) return null;
  const slug = name.slice(prefix.length);
  try {
    return planIdOf(slug);
  } catch {
    return null;
  }
}

function isStagingBranch(name) {
  return STAGING_NAMES.has(String(name));
}

// Execution branches (local + remote) whose tip is an ancestor of origin/master — fully
// merged, content-wise redundant. `branchFacts`: [{ name, local, remote, shape, merged, planId }]
// (merged/planId precomputed by the caller — see buildReport). Guards (never flagged even
// when merged): origin/staging (defensive — see STAGING_NAMES comment above); a branch
// currently checked out in ANY live worktree (`isCheckedOut` — this is the literal
// "this-session worktrees" guard from the plan's do-not-touch set, and it is the ONLY guard
// that protects a batch branch: `worktree-batch-<slug>` has no single owning plan id, so
// `planIdFromBranch` returns null for it and the plan-id guard below can never catch it —
// review finding, plan 1473); a branch whose plan currently holds a live claim ref on origin;
// a branch whose plan file sits in in-progress/ or waiting-operator/ (a deliberately parked
// worktree — the 890/1070 class, which can be technically merged into master yet still
// actively held).
export function classifyMergedBranches(
  branchFacts,
  {
    isProtectedPlanId,
    isCheckedOut = () => false,
    isArchived = () => false,
    deadSeed = () => ({ dead: false }),
  },
) {
  return branchFacts.flatMap((b) => {
    if (isStagingBranch(b.name)) return [];
    if (!b.merged) return [];
    if (isCheckedOut(b.name)) return [];
    if (b.planId && isProtectedPlanId(b.planId)) return [];
    if (b.shape !== 'drain') return [b];

    // A live plan-2863 marker is an empty drain branch staked by an unclaimed firing whose
    // plan remains ready/ with no claim ref. The age floor in deadSeedVerdict, rather than the
    // ordinary protected-plan guard, is therefore what keeps fresh/age-unknown markers safe.
    if (b.planId != null && isArchived(b.planId)) {
      return [{ ...b, deletionReason: 'archived-plan' }];
    }
    try {
      const verdict = deadSeed(b);
      return verdict?.dead ? [{ ...b, deletionReason: 'dead-seed', deadSeedVerdict: verdict }] : [];
    } catch {
      return []; // Fail toward keeping the branch.
    }
  });
}

// Diverged `worktree-*` branches whose plan is ARCHIVED — surfaced for an operator subsumption
// call, NEVER judged deletable outright (a diverged-but-archived branch may still carry content
// that never made it to master — the exact 1407 reasoning). A non-archived plan (still active,
// waiting, or unresolvable) never appears here, regardless of divergence.
export function classifyDivergedArchived(branchFacts, { isArchived }) {
  return branchFacts.filter((b) => !b.merged && b.planId != null && isArchived(b.planId));
}

// Local-only `refs/claims/<id>` (absent from `git ls-remote origin 'refs/claims/*'` — origin is
// the sole CAS authority, so a local-only ref is inert cache debris left by some earlier fetch)
// whose plan is ARCHIVED. A ref still held on origin (a live claim) can never be "local-only" in
// the first place — its id is present in `remoteClaimIds` too — so a genuinely live claim is
// excluded by construction, not by a bolted-on guard.
export function classifyStaleClaimRefs(localClaimIds, remoteClaimIds, { isArchived }) {
  const remoteSet = new Set(remoteClaimIds);
  return localClaimIds.filter((id) => !remoteSet.has(id) && isArchived(id));
}

// Any plan id currently protected from a merged-branch delete: held by a live origin claim ref,
// or parked in in-progress/ or waiting-operator/. A thin predicate-builder so classifyMergedBranches
// stays a pure filter over precomputed facts.
export function buildProtectedPlanIdChecker({ remoteClaimIds, planFolderOf }) {
  const remoteSet = new Set((remoteClaimIds || []).map(String));
  return (planId) => {
    if (remoteSet.has(String(planId))) return true;
    const folder = planFolderOf(planId);
    return folder === 'in-progress' || folder === 'waiting-operator';
  };
}

// --- remediation text (pure) ---------------------------------------------------------------

export function huskRemediation(mainDir, name) {
  const abs = join(mainDir, WORKTREES_DIR, name);
  return (
    `git worktree prune (usually a no-op here — git has already forgotten this dir); if it ` +
    `still remains, cd OUTSIDE it first, then remove it by hand: rm -rf "${abs}"`
  );
}

export function branchRemediation(b) {
  const cmds = [];
  if (b.local) cmds.push(`git branch -D ${b.name}`);
  if (b.remote) cmds.push(`git push origin --delete ${b.name}`);
  return cmds.join(' && ');
}

// `ref` is the ref that actually exists locally. plan 3756 review round 4: deriving it from the
// plan id instead would hand the operator a delete of the NEW namespace for a ref that is sitting
// in the RETIRED one — a command that silently does nothing while the debris stays.
export function staleClaimRemediation(planId, ref = claimRef(planId)) {
  return (
    `git update-ref -d ${ref}  ` +
    `# local-only cache debris — origin already has no such ref, so no push needed`
  );
}

// --- IO gather (real git/fs) -----------------------------------------------------------------

// Every directory under .claude/worktrees/, each decorated with the two independent
// "does git still know about this?" signals. `_git` is the test seam.
export function listWorktreeDirEntries(mainDir, { _git = git } = {}) {
  const dirAbs = join(mainDir, WORKTREES_DIR);
  let names;
  try {
    names = readdirSync(dirAbs, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return []; // no .claude/worktrees/ at all — nothing to sweep
  }
  const norm = (p) => resolve(p).replace(/\\/g, '/').toLowerCase();
  let registered = new Set();
  try {
    const out = _git(mainDir, ['worktree', 'list', '--porcelain']);
    registered = new Set(
      out
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => norm(l.slice('worktree '.length).trim())),
    );
  } catch {
    /* best-effort — an unreadable worktree list just means every dir reads as un-admin-entered */
  }
  return names.map((name) => {
    const abs = join(dirAbs, name);
    return {
      name,
      hasGitPointer: existsSync(join(abs, '.git')),
      hasAdminEntry: registered.has(norm(abs)),
    };
  });
}

// Every branch short name currently checked out in ANY live worktree (the main checkout plus
// every linked worktree) — parsed from `git worktree list --porcelain`'s `branch refs/heads/…`
// lines. This is the "this-session worktrees" do-not-touch guard from the plan's own spec: a
// batch branch (`worktree-batch-<slug>`) has no single owning plan id (`planIdFromBranch`
// returns null for it), so it can ONLY be protected by this checked-out check, never by the
// plan-id-based `isProtectedPlanId` guard. `_git` is the test seam.
export function listCheckedOutBranches(mainDir, { _git = git } = {}) {
  let out;
  try {
    out = _git(mainDir, ['worktree', 'list', '--porcelain']);
  } catch {
    return new Set(); // best-effort — an unreadable worktree list protects nothing extra
  }
  const names = new Set();
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('branch ')) continue;
    const ref = line.slice('branch '.length).trim();
    if (ref.startsWith('refs/heads/')) names.add(ref.slice('refs/heads/'.length));
  }
  return names;
}

// Every `worktree-*` and `claude/drain-*` branch, local and/or remote, deduped by short name
// (the branch identity
// `done-worktree`'s delete path treats as one unit: `branch -d` → `-D` fallback → remote
// `push --delete`). `_git` is the test seam.
export function listWorktreeBranches(mainDir, { _git = git } = {}) {
  const local = _git(mainDir, [
    'for-each-ref',
    '--format=%(refname)',
    `refs/heads/${BRANCH_PREFIX}*`,
    `refs/heads/${DRAIN_BRANCH_PREFIX}*`,
  ])
    .split('\n')
    .filter(Boolean)
    .map((r) => r.slice('refs/heads/'.length));
  const remote = _git(mainDir, [
    'for-each-ref',
    '--format=%(refname)',
    `refs/remotes/origin/${BRANCH_PREFIX}*`,
    `refs/remotes/origin/${DRAIN_BRANCH_PREFIX}*`,
  ])
    .split('\n')
    .filter(Boolean)
    .map((r) => r.slice('refs/remotes/origin/'.length));
  const byName = new Map();
  const shapeOf = (name) => (name.startsWith(DRAIN_BRANCH_PREFIX) ? 'drain' : 'worktree');
  for (const name of local) {
    byName.set(name, { name, local: true, remote: false, shape: shapeOf(name) });
  }
  for (const name of remote) {
    const existing = byName.get(name);
    if (existing) existing.remote = true;
    else byName.set(name, { name, local: false, remote: true, shape: shapeOf(name) });
  }
  return [...byName.values()];
}

// Every LOCAL `refs/claims/<id>` currently in this repo's own ref namespace. `_git` is the test seam.
// id -> the LOCAL ref name it was found at, so a remediation can name the ref that exists
// rather than the namespace we happen to write today (plan 3756).
export function listLocalClaimRefs(mainDir, { _git = git } = {}) {
  const map = new Map();
  for (const line of _git(mainDir, [
    'for-each-ref',
    '--format=%(refname)',
    CLAIM_GLOB,
    LEGACY_CLAIM_GLOB,
  ]).split('\n')) {
    const ref = line.trim();
    const id = planIdFromClaimRef(ref);
    if (id && !map.has(id)) map.set(id, ref);
  }
  return map;
}

export function listLocalClaimIds(mainDir, { _git = git } = {}) {
  return _git(mainDir, ['for-each-ref', '--format=%(refname)', CLAIM_GLOB, LEGACY_CLAIM_GLOB])
    .split('\n')
    .map((r) => planIdFromClaimRef(r.trim()))
    .filter(Boolean);
}

// Every `refs/claims/<id>` currently held on origin (the CAS authority). Shares the same
// 5s-capped `lsRemoteTimed` every refs/claims consumer uses (reconcile-board's fetchClaimsMap,
// post-checkout-claim-guard, sweep-acquire-residue) so an unreachable origin fails fast rather
// than hanging this read-only reporter.
export function listRemoteClaimIds(mainDir, { _git = git } = {}) {
  // plan 3756 review: a claim ref outliving its claim (the release tombstone) means ref
  // EXISTENCE is no longer holding. heldClaimsMap resolves the tips — one capped fetch for
  // the whole namespace, both namespaces covered — so a landed plan stops reading as claimed.
  //
  // Here the cost of getting it wrong is a branch protected forever by a claim nobody holds.
  return Object.keys(heldClaimsMap(mainDir, { _git }));
}

// Every tracked path under docs/superpowers/plans/ AS OF origin/master's tree — deliberately
// `ls-tree origin/master`, NOT `ls-files` (the local working copy). This tool's other freshness-
// critical judgment (isAncestorRef against origin/master in buildReport) already requires a
// fetched remote-tracking ref; reading plan-folder membership from that SAME origin/master tree
// means both judgments reason about one consistent, fetched snapshot rather than mixing a fresh
// remote ref with a possibly-stale local checkout (CLAUDE.md: "reason about origin/master, not
// drifting local refs"). One shell-out regardless of how many plan ids get resolved against it —
// replaces an O(ids × ALL_PLAN_FOLDERS.length) `ls-files` loop (review finding, plan 1473).
// `_git` is the test seam.
export function listPlanPathsAtOriginMaster(mainDir, { _git = git } = {}) {
  return _git(mainDir, ['ls-tree', '-r', '--name-only', 'origin/master', '--', PLANS_PREFIX]);
}

// The plan-path parser moved to scripts/coord/build-index-lib.mjs (plan 4125) so a light consumer can
// reuse it without this module's claim-CAS dependency graph. Re-exported here: every existing
// caller and this file's own tests keep importing it from the name they always used.
import { buildPlanFolderIndex } from './build-index-lib.mjs';
export { PLAN_PATH_RX, buildPlanFolderIndex } from './build-index-lib.mjs';

// --- orchestration (IO + pure classification, in one report) --------------------------------

// The full sweep: gather every raw signal from git/fs, classify the four categories, and
// decorate each kill-list item with per-item evidence + the exact remediation command. Never
// mutates anything (a `fetch` refreshes remote-tracking refs so "merged into origin/master" and
// "which folder is this plan in" both reason from the SAME current origin state — CLAUDE.md's
// "fetch before judging" rule — it does not touch `worktree-*`/`refs/claims/*` themselves). `_git`
// is the test seam threaded through every gather call.
export function buildReport(mainDir, { _git = git } = {}) {
  try {
    _git(mainDir, ['fetch', '--quiet', 'origin']);
  } catch {
    /* best-effort — an unreachable origin just means every judgment below falls back to
       whatever remote-tracking state this checkout already had */
  }

  const huskEntries = listWorktreeDirEntries(mainDir, { _git });
  const husks = classifyHusks(huskEntries).map((name) => ({
    name,
    evidence: `.claude/worktrees/${name} has no .git pointer and no registered worktree admin entry`,
    remediation: huskRemediation(mainDir, name),
  }));

  // Deliberately NOT wrapped: if the claim namespace cannot be read, this whole report must
  // fail rather than continue. Its output is a list of branches an operator is invited to
  // DELETE, and an empty claim set silently turns every claimed branch into a deletable one
  // (plan 3756 review — heldClaimsMap throws instead of returning a partial map for exactly
  // this reason).
  const remoteClaimIds = listRemoteClaimIds(mainDir, { _git });
  const planFolderIndex = buildPlanFolderIndex(listPlanPathsAtOriginMaster(mainDir, { _git }));
  const planFolderOf = (id) => planFolderIndex.get(String(id)) ?? null;
  const isProtectedPlanId = buildProtectedPlanIdChecker({ remoteClaimIds, planFolderOf });
  const isArchived = (id) => planFolderOf(id) === 'archive';
  const checkedOutBranches = listCheckedOutBranches(mainDir, { _git });
  const isCheckedOut = (name) => checkedOutBranches.has(name);

  const branchFacts = listWorktreeBranches(mainDir, { _git }).map((b) => {
    const planId = planIdFromBranch(b.name);
    const ref = b.local ? `refs/heads/${b.name}` : `refs/remotes/origin/${b.name}`;
    return { ...b, planId, merged: isAncestorRef(mainDir, ref, 'origin/master', { _git }) };
  });

  const mergedBranches = classifyMergedBranches(branchFacts, {
    isProtectedPlanId,
    isCheckedOut,
    isArchived,
    deadSeed: (b) => {
      // Unlike the merged check above, judge the ref an origin-delete remediation would destroy.
      const ref = b.remote ? `refs/remotes/origin/${b.name}` : `refs/heads/${b.name}`;
      const sha = _git(mainDir, ['rev-parse', ref]).trim();
      return deadSeedVerdict(mainDir, sha, { _git });
    },
  }).map((b) => ({
    ...b,
    evidence:
      `${b.name} (${[b.local && 'local', b.remote && 'remote'].filter(Boolean).join('+')}) is an ancestor of origin/master` +
      (b.shape === 'drain'
        ? b.deletionReason === 'archived-plan'
          ? `, and plan ${b.planId} is in plans/archive/`
          : ', and its empty execution marker is a provably old dead seed'
        : ''),
    remediation: branchRemediation(b),
  }));

  const divergedArchivedBranches = classifyDivergedArchived(branchFacts, { isArchived }).map(
    (b) => ({
      ...b,
      evidence: `${b.name} is NOT an ancestor of origin/master, and plan ${b.planId} is in plans/archive/ — needs an operator subsumption call, not an auto-delete`,
      remediation: null,
    }),
  );

  const localClaimIds = listLocalClaimIds(mainDir, { _git });
  const localClaimRefById = listLocalClaimRefs(mainDir, { _git });
  const staleClaimRefs = classifyStaleClaimRefs(localClaimIds, remoteClaimIds, { isArchived }).map(
    (planId) => ({
      planId,
      evidence: `refs/claims/${planId} exists locally but not on origin, and plan ${planId} is in plans/archive/`,
      remediation: staleClaimRemediation(planId, localClaimRefById.get(String(planId))),
    }),
  );

  return { husks, mergedBranches, divergedArchivedBranches, staleClaimRefs };
}

// --- CLI (integration) -----------------------------------------------------------------------

function main() {
  const mainDir = resolveMain();
  const report = buildReport(mainDir);
  const total =
    report.husks.length +
    report.mergedBranches.length +
    report.divergedArchivedBranches.length +
    report.staleClaimRefs.length;

  console.log(
    `reconcile-worktree-branches: ${report.husks.length} husk dir(s), ${report.mergedBranches.length} ` +
      `merged branch(es), ${report.divergedArchivedBranches.length} diverged-archived branch(es), ` +
      `${report.staleClaimRefs.length} stale claim ref(s) — READ-ONLY, nothing was changed.`,
  );

  for (const h of report.husks) {
    console.log(`  HUSK-DIR ${h.name} — ${h.evidence}`);
    console.log(`    → ${h.remediation}`);
  }
  for (const b of report.mergedBranches) {
    console.log(`  MERGED-BRANCH ${b.name} — ${b.evidence}`);
    console.log(`    → ${b.remediation}`);
  }
  for (const b of report.divergedArchivedBranches) {
    console.log(`  DIVERGED-ARCHIVED-BRANCH ${b.name} — ${b.evidence}`);
    console.log(
      `    → operator subsumption call required (compare against master by hand; never auto-delete)`,
    );
  }
  for (const s of report.staleClaimRefs) {
    console.log(`  STALE-CLAIM-REF refs/claims/${s.planId} — ${s.evidence}`);
    console.log(`    → ${s.remediation}`);
  }
  if (total === 0) console.log('  (nothing to report)');
  return 0; // report-only, never gates a push
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    console.error('reconcile-worktree-branches:', e.message);
    process.exit(2);
  }
}
