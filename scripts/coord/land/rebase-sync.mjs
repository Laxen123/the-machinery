// scripts/coord/land/rebase-sync.mjs — plan 3961 T3.6: the land spine's worktree-HEAD
// reads (with their DRY fakes), the rebase / sync-skip / speculative-marker primitives, and the
// land-fast-path evaluation's own worktree-HEAD building blocks, moved out of
// scripts/done-worktree.mjs behaviour-identical (parity proven by
// scripts/coord/land/parity.test.mjs's 12 scenarios against committed goldens, plus the full
// 571-case scripts/done-worktree.test.mjs, both unchanged by this move).
//
// WHAT THIS MODULE OWNS. A worktree-HEAD-reading cluster three different destination modules
// (head-lock.mjs, queue.mjs, queue-probe.mjs — each already carved — and lane-merge.mjs, carved
// alongside this module in the same plan step) all need to import from: the DRY-fakeable HEAD/
// origin-master-tip readers (worktreeHeadSha, originMasterTip, and the private `let
// dryMidPassTip` the arm* hooks write and worktreeHeadSha/changedFiles read), the prep-gate-loop
// sha helpers that build on them (headShaAfterGate, prepPassEndSha, prepMarkerStampSha,
// armDryMidPassTip, armDryRebasedTip), the branch-sync primitives (tryRebase, trySkipSync,
// logSyncSkipped, and the SYNC_SITE/SYNC_SKIP_SUBJECTS_SHOWN constants they share), the two
// git-history primitives the speculative-stacking no-laundering guards need (isAncestor,
// commitParents), the remote-tip reads (remoteBranchTip, changedFiles, mergeBaseRef), and the
// slug-keyed land-prep/land-spec scratch-marker quartet (slugScratchMarker + its two constructed
// instances, landPrepMarker/landSpecMarker) — plus `worktreeMutationKind`, the orphaned-merge/
// rebase probe every preflight and pre-convergence check shares. This is the `rebase-sync.mjs`
// the T3.3 design note flagged as a real, cohesive module boundary (t3-6-map.md §4) once three
// separate carves each needed a slice of it.
//
// WHAT THIS MODULE DOES NOT OWN, ON PURPOSE. `worktreeHeadRef`, `attachmentRefusal`,
// `evaluateLandFastPath`, and `fakeHeadRef` all read or write the spine-private `let
// lastHeadRefError` (declared beside `WORKTREE_HEAD_UNREADABLE` in done-worktree.mjs) — and that
// `let` has OTHER readers (`assertStampAttachment`, `restorePrepAttachment`,
// `attemptSpeculativeStack`) that are not part of this move and are not small, self-contained
// accessors the way `recordPreflightMarkers` (below) is: they are large, multi-purpose functions
// whose own bodies have nothing to do with the worktree-HEAD cluster. An ES module's private
// binding is unreachable from another module, and this plan's own rule for that class of hazard
// (`t3-6-brief.md`, "THE RULE THIS STEP EXISTS TO RESPECT") is explicit: a `let` moves together
// with EVERY reader and writer, or the whole group stays — no exported `let`, no invented setter,
// when the entangled functions are too large to bring along without ballooning this step's scope
// well past "rebase/sync/repin primitives". So all four stay in done-worktree.mjs (imported back
// where this module's own moved code still needs them — it doesn't; only `repinAndReprove`,
// `attachmentRefusal`, and `evaluateLandFastPath` are already spine members other core modules
// reach via `D.spine.*`, unaffected by this move). `repinAndReprove`/`repinShaPinnedMarkers` stay
// for the same class of reason: they read the module-private `let preflightMarkers`, written only
// by `recordPreflightMarkers` (a STAYS phasePreflight helper) — but `reprovePreflightTip` (the
// private half `repinAndReprove` alone calls) ALSO calls three STAYS, multi-use functions
// (`recordedFindings`, `planExistsAtLand`, `makeSeedOnlyDelta` — core-noun-ok: the third is that
// project function's own name) that would each need a NEW spine
// group addition to reach back into — a materially larger, unverified moving set this step did not
// map. Reported rather than attempted; see this step's own execution report. `worktreeMutationInProgress`
// stays too: its only callers (`preflight`, `runLandPrepLocked`) are both STAYS functions, so
// nothing outside this module's own moved code needs it moved.
//
// HOW THIS MODULE REACHES THE REST OF THE WORLD. A non-test module under scripts/coord/ may
// import only scripts/coord/** and node: builtins (Rule 3, docs/runbooks/scripts-module-layout.md)
// — so every plain scripts/*.mjs module this code used to reach directly is instead read off the
// bound dependency container, `landDeps()` (scripts/coord/land/deps.mjs), AT CALL TIME, inside
// each function — never at module top level. `D` (this module's convention: `const D =
// landDeps();` as the first line of every function that needs it) is the same one-letter binding
// every other scripts/coord/land/*.mjs core module uses for the same reason.
//
// THE `spine` GROUP. `worktreeHeadSha` and `originMasterTip` LEAVE the `spine` deps-container
// group with this move (T3.3b added them there only so queue-probe.mjs/gates-runner.mjs could
// reach them before this module existed) — the sibling core modules that used to read them via
// `D.spine.worktreeHeadSha`/`D.spine.originMasterTip` now import them from here directly instead
// (a sibling-core-module reach, no container needed). `trySkipSync`, `tryRebase`,
// `repinAndReprove` (unaffected — see above), `worktreeMutationKind`, and `logSyncSkipped` LEAVE
// the `spine` group too (all five were T3.3 additions for queue.mjs's own sync/rebase call sites);
// queue.mjs now imports the four that actually moved (`trySkipSync`, `tryRebase`,
// `worktreeMutationKind`, `logSyncSkipped`) from here directly. `armDryMidPassTip` and
// `headShaAfterGate`/`prepPassEndSha` were T3.5 additions for gates-runner.mjs's own prep-gate
// loop; gates-runner.mjs now imports all three from here directly instead.
//
// A PURE MOVE. Every moved function is byte-identical to its done-worktree.mjs original apart
// from the mechanical container-access rewrites (`run(` → `D.spawn.run(`, `node(` →
// `D.spawn.node(`, `DRY` → `D.env.DRY`, `L.foo(` → `D.L.foo(`, `errText(` →
// `D.coordGit.errText(`, `lsRemoteTimed(` → `D.coordGit.lsRemoteTimed(`, `loadCoordConfig(` →
// `D.coordConfig.loadCoordConfig(`, `graftedForeignCommits(`/`mergeTreeWriteTree(`/
// `syncBranchOntoMaster(` → `D.landLib.*`, `gitMain(` → `D.spawn.gitMain(`, `stepLog(` →
// `D.spine.stepLog(`), the `export` keyword added where a caller outside this module needs it, and
// the `const D = landDeps();` first line every function that needs the container gained — no
// renames, no reordering, no incidental fixes. Every comment moved with its function; they carry
// the plan history that explains the code.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { landDeps } from './deps.mjs';

// plan 4066 task 0: the member-level container-read manifest for this module — see
// preflight.mjs's own CONTAINER_READS comment for what asserts it and when, and
// container-manifest.mjs's header for the aggregator itself. Generated, not hand-typed;
// regenerate with the same scanner on a real change to this file's container reads.
export const CONTAINER_READS = Object.freeze({
  L: Object.freeze(['masterDeltaIsCoordinationOnly', 'parseLandPrepMarker', 'parseLandSpecMarker']),
  coordConfig: Object.freeze(['loadCoordConfig']),
  coordGit: Object.freeze(['lsRemoteTimed']),
  env: Object.freeze(['DRY']),
  landLib: Object.freeze([
    'graftedForeignCommits',
    'mergeHeadExists',
    'mergeTreeWriteTree',
    'rebaseStateDir',
    'syncBranchOntoMaster',
  ]),
  spawn: Object.freeze(['gitMain', 'run']),
  spine: Object.freeze(['stepLog']),
});

// plan 3961 T3.4: worktreeLockFor (+ its private _worktreeLockPathCache), takeWorktreeLock,
// dropWorktreeLock, acquireWorktreeBeforePreflight, rebaseHeadHoldClock, renewOrAbort, and
// WorktreeLockLost moved to scripts/coord/land/head-lock.mjs (imported back above) — see that
// file's own header. `worktreeLockFor` also LEAVES the `spine` deps-container group with this
// move (see deps.mjs's own comment); queue.mjs's dispatchLandPrep now imports it from
// head-lock.mjs directly instead.

// plan 3961 T3.4: acquireWorktreeLockAtHead (+ nested readLockEntryChecked, attemptPreemption)
// moved to scripts/coord/land/head-lock.mjs (imported back above) — see that file's own header.

// plan 3961 T3.3: the speculative background dispatch (dispatchLandPrep,
// autoSpawnQueueWatcher) moved to scripts/coord/land/queue.mjs — see that file's own header.

// Is another process (a live keep-hot --prep watcher on the same slug, or leftover state
// from a crashed attempt) mid-mutation in this worktree? Pre-1805 the --wait waiter never
// mutated the worktree, so no such collision existed — this guard keeps it that way: a
// busy worktree skips the round instead of starting a SECOND rebase into someone else's
// rebase-merge state (review 1805 [3]). Best-effort/fail-open — a probe failure reads as
// not-busy, and the tiny check→rebase window stays (documented in the runbook).
// plan 3422 D4: the NAMING twin of worktreeMutationInProgress below — same probe, but it returns
// WHICH mutation ('rebase' | 'merge' | null) instead of a bare boolean, because the preflight seam
// has to print the right two-command remedy (`git rebase --continue/--abort` vs `git
// merge --abort`). worktreeMutationInProgress delegates to it so the two can never disagree about
// what counts as "mid-mutation" — the pre-convergence busy-check and the preflight halt must see
// exactly the same states.
export function worktreeMutationKind(wtPath) {
  const D = landDeps();
  if (D.env.DRY) {
    if (process.env.DW_FAKE_ORPHANED_MERGE) return process.env.DW_FAKE_ORPHANED_MERGE;
    return process.env.DW_FAKE_PRECONVERGE_BUSY === '1' ? 'rebase' : null;
  }
  try {
    // plan 3974 fix (gpt-review j0j1ng/6wn6nm): the state-dir probe itself is shared with
    // land-lib.mjs's own rebase retry loop via its exported `rebaseStateDir` — this used to be a
    // hand-rolled duplicate of the exact same `rev-parse --git-path` loop.
    //
    // NOTE `rebase-apply` is also where `git am` keeps its state (gpt-review 84be27), so an
    // interrupted `git am` reports as 'rebase' here. That is the right refusal either way — a
    // land cannot proceed over one — and the seam text names the `git am` verbs alongside the
    // rebase ones rather than pretending to tell the two apart at THIS layer (resumableSpineRebase
    // is the one caller that genuinely needs to, for the preflight resume decision, and it
    // makes that call itself off the same shared probe).
    if (D.landLib.rebaseStateDir(wtPath) !== null) return 'rebase';
    if (D.landLib.mergeHeadExists(wtPath)) return 'merge';
    return null;
  } catch {
    return null;
  }
}

// plan 1616 item 4 (dedupe pass): considered deriving a sibling worktree-branch content guard's
// (core-noun-ok: wikiDiffOnWorktreeBranch is that project module's own function name)
// narrower-scoped hit from THIS function's unscoped result instead of a second overlapping `git
// diff origin/master...HEAD` call (the narrower-scoped result is a strict subset). Decided NOT
// to: that guard runs inside preflight() (step 1, BEFORE assertLandable/step 1b), while
// changedFiles() is first called only at step 1b's diff-scope/lane computation — merging them
// means either (a) hoisting this call to run before the dirty-check/unpushed-check inside
// preflight(), moving a new git subprocess ahead of checks that today run git-free-first, or
// (b) leaving the call sites apart but sharing a value threaded through, which still requires
// the hoist. Either way changes what a diff failure does: that guard's try/catch degrades a diff
// failure to "no hit found" (a deliberate land-time-convenience decision — the pre-push hook is
// the hard block); changedFiles() has NO try/catch, so its failure throws and crashes the
// process — correct HERE because a silently-empty changed-file list would let the state's own
// diff-scope/lane classification proceed on wrong data (a landing-mutex-scope bug, not a
// convenience skip). Sharing one diff result would force both call sites onto the SAME failure
// behavior, silently changing one of the two on a diff error. Left as two separate calls.
// plan 3972 DRY extension of the same fake: once the DRY tip has been moved by a re-sha hook
// (armDryRebasedTip / armDryMidPassTip), DW_FAKE_DIFF_AT_HEAD, when set, is the list AT that
// moved head — how a test models a foreign commit adding a reviewable path after preflight.
// Unset ⇒ the moved head reads DW_FAKE_DIFF like every read before it.
export function changedFiles(wtPath) {
  const D = landDeps();
  if (D.env.DRY && dryMidPassTip && process.env.DW_FAKE_DIFF_AT_HEAD !== undefined) {
    return process.env.DW_FAKE_DIFF_AT_HEAD.split(',').filter(Boolean);
  }
  // plan 3961 T2 review round 3 (fix 2, key c1bade): this hook was missing the `DRY &&` guard
  // the sibling branch above carries — a leaked/stray `DW_FAKE_DIFF` in a REAL land's
  // environment would silently classify the actual changed-file list as whatever the env var
  // says (e.g. one docs-only path), dropping the true diff scope and every gate it drives. The
  // file header already documents this as a test-only dry-run override; the code now matches.
  if (D.env.DRY && process.env.DW_FAKE_DIFF !== undefined) {
    return process.env.DW_FAKE_DIFF.split(',').filter(Boolean);
  }
  return D.spawn
    .run('git', ['-C', wtPath, 'diff', '--name-only', 'origin/master...HEAD'])
    .split('\n')
    .filter(Boolean);
}

// plan 1074: the merge-base of the branch with origin/master — the fork point, so a
// diff against it is exactly THIS branch's changes (independent of how far
// origin/master has advanced; the spine rebases onto it later). Best-effort fetch
// refreshes the ref first; on any failure return null (plan 3282: the caller refuses via a
// documented seam — the fail-open this null used to produce is closed at the call site).
export function mergeBaseRef(wtPath) {
  const D = landDeps();
  try {
    try {
      D.spawn.run('git', ['-C', wtPath, 'fetch', 'origin', 'master']);
    } catch {
      /* a stale origin/master is still a usable base — don't fail the gate on a fetch hiccup */
    }
    return D.spawn.run('git', ['-C', wtPath, 'merge-base', 'origin/master', 'HEAD']).trim() || null;
  } catch {
    return null;
  }
}

// ── branch sync (returns {conflicted, conflictCommits, abortedOnce, mergeBearing}) ──
// plan 507: the real path delegates to land-lib's syncBranchOntoMaster — a linear
// branch keeps the plain rebase; a MERGE-BEARING branch (it freshen-merged
// origin/master mid-flight) is synced with one final freshen-merge instead, so the
// author's prior conflict resolutions are never re-fought by a linearizing replay.
export function tryRebase(wtPath, branch) {
  const D = landDeps();
  if (D.env.DRY) {
    D.spawn.run('git', ['-C', wtPath, 'fetch', 'origin']);
    // plan 2433: mirror syncBranchOntoMaster's real capture — resolve right after the fetch,
    // before the rebase call below — so DRY-mode spine tests can pin DW_FAKE_ORIGIN_TIP and
    // exercise the same masterRef-threading the production path uses.
    const rebasedOntoSha = originMasterTip(wtPath);
    D.spawn.run('git', ['-C', wtPath, 'rebase', 'origin/master']);
    // test-only conflict injection (plan 504, mirrors DW_FAKE_DIFF): prove the
    // hold-through-conflict seam deterministically without a scratch repo.
    if (process.env.DW_FAKE_REBASE === 'conflict') {
      return { conflicted: true, conflictCommits: 1, abortedOnce: false };
    }
    if (process.env.DW_FAKE_REBASE === 'ugly') {
      return { conflicted: true, conflictCommits: 5, abortedOnce: false };
    }
    // plan 507: a conflicted FRESHEN-MERGE on a merge-bearing branch (one pass,
    // author-resolvable — the holding text must say merge, not rebase)
    if (process.env.DW_FAKE_REBASE === 'merge-conflict') {
      return { conflicted: true, conflictCommits: 1, abortedOnce: false, mergeBearing: true };
    }
    // plan 1805: the rebase concluded clean but the branch publish was hook-rejected
    // (rebaseSeam → LAND_BLOCKED) — drives the pre-convergence pushBlocked-≠-conflict arm.
    if (process.env.DW_FAKE_REBASE === 'push-blocked') {
      return {
        conflicted: false,
        conflictCommits: 0,
        abortedOnce: false,
        pushBlocked: true,
        pushDetail: 'DW_FAKE push rejected',
      };
    }
    D.spawn.run('git', ['-C', wtPath, 'push', '--force-with-lease', 'origin', branch]);
    return { conflicted: false, conflictCommits: 0, abortedOnce: false, rebasedOntoSha };
  }
  return D.landLib.syncBranchOntoMaster(wtPath, branch);
}

// ── plan 3972: skip the branch sync on a coordination-only master delta ──────────────────────
//
// Both sync sites (the plan-3422 D4 pre-queue freshen and the at-head rebase) decided by a RAW
// count — `rev-list --count HEAD..origin/master` — so master moving by ANY commit bought a full
// rebase + marker re-pin + gated force-push. On 2026-09-12 the plan-3941 land paid that ~9 minutes
// for 22 commits that were entirely the queue's own bookkeeping and other sessions' review
// records (plan body, "The defect, measured"): the spine was partly chasing itself.
//
// ONE helper for both sites so they cannot drift. It says "skip" only when EVERY clause holds:
//   1. the master delta since `merge-base HEAD origin/master` touches ONLY coordination paths
//      (L.masterDeltaIsCoordinationOnly — PATHS are the criterion, subjects are logged only);
//   2. the branch carries no commit grafted from LOCAL master (graftedForeignCommits, plan 3080 —
//      the sync path runs this guard inside syncBranchOntoMaster, and the --resume arm re-runs it
//      because it skips the sync; this skip is a third door and gets the same guard);
//   3. the branch tip is PUBLISHED (origin/<branch> === HEAD) — the merge lands origin/<branch>,
//      and the force-push this skip removes is what used to guarantee they agree;
//   4. `git merge-tree --write-tree origin/master <tip>` yields a tree (mergeTreeWriteTree — its
//      header explains why the EXIT CODE, not the printed oid, is the conflict signal).
// Any clause false, and ANY git error, ⇒ `skipped: false` and the existing rebase path runs
// byte-for-byte (a real conflict still halts LAND_BLOCKED_HOLDING for the author). On a skip the
// caller does NOT rebase, does NOT re-pin (HEAD did not move, so the sha-pinned markers stay
// valid by construction) and does NOT push; `landBranchViaEphemeral` then performs the real
// three-way merge it always performed — a behind-but-clean branch is exactly what merge-tree
// already handles, linear or merge-bearing (plan 507) alike.
//
// It never trusts a tracking ref it did not refresh (gpt-review 3972 r1 finding ff84fb: the at-head
// fast-path re-check swallows a failed fetch into `fetchedOk=false`, so a stale `origin/master`
// showing only coordination paths could have satisfied the skip while remote master had gained
// code). By default it runs its own `fetch origin master` FIRST and a fetch failure is
// `skipped: false` (fail closed — the rebase path's own sync fetches and fails loudly). The
// pre-queue freshen passes `noFetch: true` because it fetched the same ref two lines earlier.
// `masterTip` is returned so the at-head site can pin the landed-reversion lint's masterRef to
// the tip this probe was made against (the same reason tryRebase returns rebasedOntoSha, plan 2433).
//
// DRY seam: DW_FAKE_SYNC_SKIP=1 forces `skipped: true` at BOTH sites, `=preQueue` / `=atHead` at
// that one site only (so a pre-queue skip followed by a real at-head rebase is drivable — the
// shape the sidecar's FINAL `syncSkipped` must report as false). Mirrors DW_FAKE_REBASE: honoured
// ONLY under --dry-run, a leaked env var must never skip a real sync; unset ⇒ `skipped: false`, so
// every existing DW_FAKE_REBASE spine test still reaches tryRebase's DRY trace unchanged.
const SYNC_SKIP_SUBJECTS_SHOWN = 6;

export const SYNC_SITE = Object.freeze({
  preQueue: { key: 'preQueue', label: 'pre-queue freshen' },
  atHead: { key: 'atHead', label: 'at head' },
});

export function trySkipSync(state, wtPath, branch, { noFetch = false, site = null } = {}) {
  const D = landDeps();
  if (D.env.DRY) {
    const want = process.env.DW_FAKE_SYNC_SKIP;
    const skipped = want === '1' || (Boolean(site) && want === site.key);
    return {
      skipped,
      behind: skipped ? 3 : 0,
      // Resolved only on a skip: an unset seam must add NOTHING to the DRY trace the existing
      // spine tests match against.
      masterTip: skipped ? originMasterTip(wtPath) || null : null,
      subjects: skipped ? ['chore(handoff): DW_FAKE_SYNC_SKIP row', 'docs(plans): DW_FAKE'] : [],
      reason: skipped ? 'DW_FAKE_SYNC_SKIP=1' : 'DW_FAKE_SYNC_SKIP unset',
    };
  }
  const lines = (s) =>
    String(s || '')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
  let masterTip = null;
  if (!noFetch) {
    try {
      D.spawn.run('git', ['-C', wtPath, 'fetch', '--quiet', 'origin', 'master']);
    } catch (e) {
      return {
        skipped: false,
        behind: null,
        masterTip,
        reason: `fetch failed: ${D.coordGit.errText(e) || e}`,
      };
    }
  }
  try {
    masterTip = originMasterTip(wtPath);
    const branchTip = worktreeHeadSha(wtPath);
    const base = D.spawn.run('git', ['-C', wtPath, 'merge-base', 'HEAD', masterTip]).trim();
    if (!base) return { skipped: false, behind: null, masterTip, reason: 'no merge-base' };
    const behind = Number(
      D.spawn.run('git', ['-C', wtPath, 'rev-list', '--count', `${base}..${masterTip}`]),
    );
    if (!Number.isFinite(behind) || behind <= 0)
      return { skipped: false, behind: behind || 0, masterTip, reason: 'master has not moved' };
    const paths = lines(
      D.spawn.run('git', ['-C', wtPath, 'diff', '--name-only', `${base}..${masterTip}`]),
    );
    const subjects = lines(
      D.spawn.run('git', ['-C', wtPath, 'log', '--format=%s', `${base}..${masterTip}`]),
    );
    // plan 3961 T2 review round 2: the required `prefixes` argument comes from the MAIN
    // checkout's coord.config.json, never the branch under land — same reason as phasePreflight's
    // `cfg` read above (a branch must not choose the policy that gates its own land).
    const prefixes = D.coordConfig.loadCoordConfig(state.main).land.coordinationOnlyPathPrefixes;
    if (!D.L.masterDeltaIsCoordinationOnly(paths, prefixes)) {
      const offenders = paths.filter((p) => !D.L.masterDeltaIsCoordinationOnly([p], prefixes));
      return {
        skipped: false,
        behind,
        masterTip,
        subjects,
        reason:
          `master delta carries ${offenders.length} non-coordination path(s): ` +
          `${offenders.slice(0, 3).join(', ')}${offenders.length > 3 ? ', …' : ''}`,
      };
    }
    const graft = D.landLib.graftedForeignCommits(wtPath, masterTip);
    if (graft.commits.length)
      return {
        skipped: false,
        behind,
        masterTip,
        subjects,
        reason: `branch carries ${graft.commits.length} commit(s) grafted from local master (plan 3080)`,
      };
    const remoteTip = remoteBranchTip(wtPath, branch);
    if (remoteTip !== branchTip)
      return {
        skipped: false,
        behind,
        masterTip,
        subjects,
        reason: `origin/${branch} (${remoteTip || 'absent'}) ≠ HEAD (${branchTip}) — tip not published`,
      };
    // MAIN shares this worktree's object database, and the merge itself runs from MAIN (plan 2466),
    // so probe from there with the same lock-retrying runner the merge uses.
    const tree = D.landLib.mergeTreeWriteTree(state.main, masterTip, branchTip, {
      run: (cwd, args) => D.spawn.gitMain(cwd, args),
    });
    if (!tree)
      return { skipped: false, behind, masterTip, subjects, reason: 'merge-tree is not clean' };
    return { skipped: true, behind, masterTip, subjects, tree, reason: null };
  } catch (e) {
    return {
      skipped: false,
      behind: null,
      masterTip,
      reason: `probe failed: ${D.coordGit.errText(e) || e}`,
    };
  }
}

// The one log shape for a taken skip, shared by both sites (the plan's own wording, so the
// sidecar's phases[] and a log grep find the same line at either site). `state.syncSkipped` is the
// FINAL decision of the land (gpt-review 3972 r1 findings 589d09 / e06a8f: a pre-queue skip followed by a
// code commit during the wait runs the real at-head rebase, and that arm resets it to false), and
// `state.syncSkipSites` keeps the per-site record; the subjects line is telemetry only.
export function logSyncSkipped(state, res, site) {
  const D = landDeps();
  state.syncSkipped = true;
  state.syncSkipSites = { ...(state.syncSkipSites || {}), [site.key]: true };
  const message =
    `sync: skipped — master moved by ${res.behind} coordination-only commit(s), merge-tree clean ` +
    `(${site.label}, plan 3972)`;
  D.spine.stepLog(state, message);
  if (D.env.DRY) process.stdout.write(`${message}\n`);
  const subjects = res.subjects || [];
  if (subjects.length) {
    const shown = subjects.slice(0, SYNC_SKIP_SUBJECTS_SHOWN).map((s) => `  · ${s}`);
    if (subjects.length > SYNC_SKIP_SUBJECTS_SHOWN)
      shown.push(`  · … ${subjects.length - SYNC_SKIP_SUBJECTS_SHOWN} more`);
    process.stderr.write(
      `[done-worktree ${state.slug}] sync: master delta subjects (telemetry only, paths decided):\n${shown.join('\n')}\n`,
    );
  }
}

// plan 3961 T3.3: preQueueFreshen (the opportunistic pre-queue rebase/re-pin) moved to
// scripts/coord/land/queue.mjs (imported back below) — see that file's own header.

// ── plan 972 / 2463 / 2528: the ONE slug-keyed scratch-marker quartet ────────────
// Both land-prep markers share a single storage contract, so they share a single implementation
// (plan 2528, factoring out plan 2463's hand-copy of plan 972's four functions — the copies were
// faithful, so the risk they carried was DRIFT: a fix to one arm silently not reaching the other).
// The contract: stored beside the terminal sidecar (MAIN/.scratch, gitignored, slug-keyed) so the
// detached `--prep` WRITER and the head-time READER resolve the SAME path without committing it;
// an untracked file also survives the very rebase/force-push it records. Every arm swallows its
// own errors — a marker is a fast-path HINT, and its absence must always degrade to the safe full
// rebase+gate path rather than fail a land.
//
// `parse` is the marker-specific validator (`L.parseLandPrepMarker` / `L.parseLandSpecMarker`),
// `env` the DRY injection hook, and `atHeadEnv` the OPTIONAL second hook a marker may expose for
// the at-head re-evaluation (plan 2458 — only the plain marker has one; a marker without it
// ignores the `atHead` argument entirely).
function slugScratchMarker({ prefix, env, atHeadEnv, parse }) {
  // Private to the quartet: no caller resolves a marker path itself (review [2]), so exposing it
  // would be dead public surface on a contract two markers share.
  const path = (main, slug) => `${main}/.scratch/${prefix}-${slug}.json`;
  return {
    read(main, slug, atHead = false) {
      const D = landDeps();
      // DRY test hook: <env> injects a marker JSON (mirrors DW_FAKE_DIFF) so the fast-path /
      // --prep-idempotent branches are exercisable without a scratch repo.
      // plan 2458: <atHeadEnv> injects a DIFFERENT marker for the at-head re-evaluation only,
      // modelling the marker that appears DURING the wait (stamped by keep-hot or by the
      // enqueue-time prep). That is precisely the state the pre-2458 code could never observe,
      // since it decided the fast path before the enqueue and never looked again.
      if (D.env.DRY) {
        const raw =
          atHead && atHeadEnv && process.env[atHeadEnv] !== undefined
            ? process.env[atHeadEnv]
            : process.env[env];
        return raw !== undefined ? parse(raw) : null;
      }
      try {
        return parse(readFileSync(path(main, slug), 'utf8'));
      } catch {
        return null; // absent / unreadable → no fast-path (safe full rebase)
      }
    },
    write(main, slug, marker) {
      const D = landDeps();
      if (D.env.DRY) return; // dry trace only — never touch a real `<main>/.scratch`
      try {
        mkdirSync(`${main}/.scratch`, { recursive: true });
        writeFileSync(path(main, slug), JSON.stringify(marker, null, 2));
      } catch {
        /* best-effort: a stamp failure just means the next head runs the full rebase+gate path */
      }
    },
    clear(main, slug) {
      const D = landDeps();
      if (D.env.DRY) return;
      try {
        rmSync(path(main, slug), { force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

// plan 972: the PLAIN land-prep marker (keep-hot / head fast-path). The keep-hot driver
// (`--prep`, fired by the 969 watcher while the plan waits) records that THIS branch was rebased
// onto a specific origin/master tip and its gates re-validated against that tree.
export const landPrepMarker = slugScratchMarker({
  prefix: 'land-prep',
  env: 'DW_FAKE_LAND_PREP',
  atHeadEnv: 'DW_FAKE_LAND_PREP_AT_HEAD',
  // plan 3961 T3.6: `landDeps()` is called lazily, at marker-read time, rather than binding
  // `D.L.parseLandPrepMarker` at this const's own module-evaluation time — done-worktree.mjs
  // imports this module BEFORE it calls bindLandDeps(), so a bare `D.L.parseLandPrepMarker` read
  // here would throw "landDeps() called before bindLandDeps()" the instant this file loads.
  parse: (text) => landDeps().L.parseLandPrepMarker(text),
});

// plan 2463: the SPECULATIVE marker — same storage contract, recording a branch stacked on the
// head slot's branch tip rather than on origin/master. (The ancestry probes it rests on follow.)
export const landSpecMarker = slugScratchMarker({
  prefix: 'land-spec',
  env: 'DW_FAKE_LAND_SPEC',
  parse: (text) => landDeps().L.parseLandSpecMarker(text),
});

// `git merge-base --is-ancestor`, as a boolean. Fails CLOSED (false) on any git error: every
// caller treats false as "cannot prove it landed", which routes to the safe arm (no fast path, or
// an un-stack) rather than to a merge we could not justify.
// DRY: DW_FAKE_ANCESTORS is a comma-separated list of "<ancestor>:<descendant>" pairs that answer
// true — everything else answers false, so a test spells out exactly the graph it means.
export function isAncestor(wtPath, ancestor, descendant) {
  const D = landDeps();
  if (!ancestor || !descendant) return false;
  if (D.env.DRY) {
    return (process.env.DW_FAKE_ANCESTORS || '')
      .split(',')
      .filter(Boolean)
      .includes(`${ancestor}:${descendant}`);
  }
  try {
    D.spawn.run('git', ['-C', wtPath, 'merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

// The parent shas of <rev>, in order. `[]` when the commit is not a merge or the read fails —
// which invalidates a speculative marker by construction (landSpecPrepValid demands exactly two).
// DRY: DW_FAKE_MASTER_PARENTS is a comma-separated list.
export function commitParents(wtPath, rev) {
  const D = landDeps();
  if (D.env.DRY) {
    return (process.env.DW_FAKE_MASTER_PARENTS || '').split(',').filter(Boolean);
  }
  if (!rev) return [];
  try {
    return D.spawn
      .run('git', ['-C', wtPath, 'rev-list', '--parents', '-n', '1', rev])
      .trim()
      .split(/\s+/)
      .slice(1);
  } catch {
    return [];
  }
}

// The live tips the fast-path / --prep compares against the marker. DRY honours
// DW_FAKE_ORIGIN_TIP / DW_FAKE_BRANCH_TIP (mirrors DW_FAKE_REBASE — only under --dry-run).
export function originMasterTip(wtPath) {
  const D = landDeps();
  // gpt-review 2940 round 2 [5847d3/b309ef/535842]: '__ERROR__' simulates a rev-parse that fails on
  // its own AFTER a successful fetch — ref churn under a concurrent gc/repack on this shared
  // `.git`. Same vocabulary DW_FAKE_REMOTE_BRANCH_TIP already uses for the same purpose, and the
  // only way to exercise the two catches that keep such a failure from crashing the spine (DRY
  // stubs `run`, so a real rev-parse cannot be made to throw here).
  if (D.env.DRY && process.env.DW_FAKE_ORIGIN_TIP === '__ERROR__') {
    throw new Error('DW_FAKE_ORIGIN_TIP: simulated rev-parse failure');
  }
  if (D.env.DRY && process.env.DW_FAKE_ORIGIN_TIP) return process.env.DW_FAKE_ORIGIN_TIP;
  return D.spawn.run('git', ['-C', wtPath, 'rev-parse', 'origin/master']).trim();
}

// plan 3503 gpt-review round 3 (cluster 2) dry-only race hook:
// DW_FAKE_BRANCH_TIP_MOVES_AFTER="<prep gate key>:<sha>" makes every HEAD read AFTER that gate's
// result was recorded return <sha> — the commit that arrives BETWEEN two gates, which no per-gate
// start/end pair can see (each gate agrees with itself) and which the post-loop reconcile in
// runPrepGates exists to catch. Module-level rather than local to that loop because the STAMP
// seam's own reads must move with it too, exactly as they would in production. Honoured ONLY under
// --dry-run, like every DW_FAKE_*: a leaked variable must never reach a real prep.
let dryMidPassTip = null;

// NOTE (plan 2654): this reads HEAD, and most callers treat the result as "the branch tip" —
// which is only true while HEAD is ATTACHED to worktree-<slug>. That equivalence is ENFORCED
// rather than assumed, by four guards, none of them named `assertPrepAttachment` (plan 2940: the
// comment used to cite that name; no such function has ever existed anywhere in the repo):
//   * resolveWorktree refuses a detached worktree outright, before anything runs;
//   * `enteredAttached` + `attachmentRefusal(…, 'prep')` in runLandPrepLocked — plan 2654
//     guardrail 1, above the prep's FIRST git write;
//   * `attachmentRefusal(…, 'prep')` in the `--wait` loop's pre-convergence check, and its
//     `'land'` twin at the head-time rebase;
//   * restorePrepAttachment — the no-detached-exit invariant, in runLandPrep's finally.
// plan 2940 added the fifth and the one the list above was missing: the prep's own mid-run rebase
// can detach HEAD AFTER guardrail 1 has passed, and the exit-time restore runs only after the
// marker is already stamped — so both marker writers now assert attachment at the STAMP SEAM
// itself (see assertStampAttachment).
//
// Do not "fix" this to rev-parse refs/heads/<branch> — reading the branch ref while HEAD is
// detached would paper over exactly the state the guards exist to refuse, and the rebase would
// still move the wrong thing. The name says `worktreeHeadSha` (plan 2940 ruling 2, renamed from
// `worktreeHeadSha`) precisely so no future caller mistakes it for a branch-ref read.
export function worktreeHeadSha(wtPath) {
  const D = landDeps();
  if (D.env.DRY && dryMidPassTip) return dryMidPassTip;
  if (D.env.DRY && process.env.DW_FAKE_BRANCH_TIP) return process.env.DW_FAKE_BRANCH_TIP;
  return D.spawn.run('git', ['-C', wtPath, 'rev-parse', 'HEAD']).trim();
}

export function armDryMidPassTip(prepGateKey) {
  const D = landDeps();
  if (!D.env.DRY) return;
  const m = (process.env.DW_FAKE_BRANCH_TIP_MOVES_AFTER || '').match(/^([a-z-]+):([0-9a-f]{40})$/);
  if (m && m[1] === prepGateKey) dryMidPassTip = m[2];
}

// plan 3972 round 3 dry-only hook: DW_FAKE_REBASED_TIP=<sha> makes every HEAD read AFTER the
// at-head DRY rebase return <sha> — the re-sha a real `rebase origin/master` performs, which the
// fixed DW_FAKE_BRANCH_TIP cannot model. Drives repinAndReprove through the moved-HEAD arm so
// a test can show the tip advancing only on DW_FAKE_REPIN=ok and the merge seaming REVIEW_NEEDED
// otherwise. Same module-level slot as the prep hook above; honoured ONLY under --dry-run.
export function armDryRebasedTip() {
  const D = landDeps();
  if (!D.env.DRY) return;
  const sha = process.env.DW_FAKE_REBASED_TIP || '';
  if (/^[0-9a-f]{40}$/.test(sha)) dryMidPassTip = sha;
}

// plan 3503 gpt-review round 2 (71906f/182771): dry-only race hooks for the two distinct windows.
// AFTER_GATE models a commit that arrived while a gate ran and remains HEAD at pass end; AT_STAMP
// models the narrower commit after the last gate returned. Production always re-reads live HEAD.
// plan 3503 gpt-review round 3: the post-gate HEAD read, shared by the prep loop and by both LAND
// gate sites, so "did the tree move under this gate" is asked exactly one way everywhere.
export function headShaAfterGate(wtPath) {
  const D = landDeps();
  if (D.env.DRY && process.env.DW_FAKE_BRANCH_TIP_AFTER_GATE) {
    return process.env.DW_FAKE_BRANCH_TIP_AFTER_GATE;
  }
  return worktreeHeadSha(wtPath);
}

export function prepPassEndSha(wtPath) {
  return headShaAfterGate(wtPath);
}

export function prepMarkerStampSha(wtPath) {
  const D = landDeps();
  if (D.env.DRY && process.env.DW_FAKE_BRANCH_TIP_AT_PREP_STAMP) {
    return process.env.DW_FAKE_BRANCH_TIP_AT_PREP_STAMP;
  }
  return prepPassEndSha(wtPath);
}

// plan 2274 Fix 4: the LIVE remote tip of <branch> via a TIMED `git ls-remote` (coord-git.mjs's
// lsRemoteTimed — plan 1475's shared 5s-cap helper; an untimed ls-remote here would hang the
// whole spine, holding the landing-queue head slot + same-PC landing mutex, on a slow/unreachable origin —
// exactly the wedge class lsRemoteTimed exists to prevent). Reads origin directly (no local
// remote-tracking-ref staleness), so a gate-failed background push that reported "completed"
// cannot masquerade as done. THROWS on any ls-remote failure (network blip, timeout) — the
// caller decides how to treat that (never silently treated as "matches" here). null when the
// branch has no ref on origin at all. DW_FAKE_REMOTE_BRANCH_TIP injects a value under
// --dry-run: unset defaults to "matches the local tip" (today's assumed-good behavior, so
// existing --resume tests that never set this hook are unaffected); '' simulates the branch
// being absent on origin; '__ERROR__' simulates a transient ls-remote failure (throws).
export function remoteBranchTip(wtPath, branch) {
  const D = landDeps();
  if (D.env.DRY) {
    if (process.env.DW_FAKE_REMOTE_BRANCH_TIP === undefined) return worktreeHeadSha(wtPath);
    if (process.env.DW_FAKE_REMOTE_BRANCH_TIP === '__ERROR__') {
      throw new Error('DW_FAKE_REMOTE_BRANCH_TIP: simulated ls-remote failure');
    }
    return process.env.DW_FAKE_REMOTE_BRANCH_TIP || null;
  }
  const out = D.coordGit.lsRemoteTimed(wtPath, `refs/heads/${branch}`).trim();
  if (!out) return null;
  return out.split(/\s+/)[0];
}
