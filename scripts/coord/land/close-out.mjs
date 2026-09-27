// scripts/coord/land/close-out.mjs — plan 3961 T3.1: the land spine's close-out phase, moved
// out of scripts/done-worktree.mjs behaviour-identical (parity proven by this migration's
// parity-test suite against committed goldens, plus the full legacy test suite, both unchanged
// by this move).
//
// WHAT THIS MODULE OWNS. The close-out phase of the file header's five-phase landing sequence:
// idempotent board-row removal (single-plan and batch), the plan-file archive move (or a
// plan-1329 heartbeat re-file to waiting-date/), the ONE close-out commit + push (single-plan and
// batch), waiting-blocked/ promotion of newly-unblocked dependents, `→ open new plan`
// carry-forward minting, and post-push verification that every removed board row / archived plan
// actually reached origin/master (plan 1508). It is generic — no project-specific vocabulary
// anywhere in this file. One comment below names a real drain-run.mjs function whose own name
// contains a listed word; it carries the gate's `core-noun-ok:` waiver with the reason.
//
// HOW THIS MODULE REACHES THE REST OF THE WORLD. A non-test module under scripts/coord/ may
// import only scripts/coord/** and node: builtins (Rule 3,
// docs/coord/scripts-layout.md) — so every one of the ~25 plain scripts/*.mjs modules
// this code used to reach directly is instead read off the bound dependency container,
// `landDeps()` (scripts/coord/land/deps.mjs), AT CALL TIME, inside each function — never at
// module top level. The container is bound once, by done-worktree.mjs's own `bindLandDeps({…})`
// call, before any land runs; reading it at module load here (rather than inside each function)
// would run before that bind and throw. `D` (this module's convention: `const D = landDeps();`
// as the first line of every function that needs it) is the same one-letter binding every other
// scripts/coord/land/*.mjs core module uses for the same reason.
//
// THE `spine` GROUP. A handful of functions Block A calls are NOT here, deliberately: `emitSeam`
// (process.exit + spine-wide mutex/queue mutation), `coordStep` (closes over private
// module-level test-fakery state), `findSessionFile` (closes over a private memoization
// cache), `tryStep` (shared with teardown/resume, not close-out's alone), `resolvePlanRelForSlug`
// (a small pure helper with an outside, non-close-out spine call site), and — close-out-only by
// call count but outside this move's audited contiguous block — `gateProbe`, `hasStagedChanges`,
// `closeOutCommitAtHead`, and `regenIndex`. `pushMaster` specifically cannot move at all:
// the legacy module's own test suite source-inspects it by literal text
// (`source.indexOf('function pushMaster(MAIN)')`). All of these stay in done-worktree.mjs and
// reach this module's callers through `D.spine.*`, exactly like `D.L.*` / `D.coordGit.*` / etc.
// `dequeueQueueIfHeld` — a T3.1-era member of this same NOT-here list — moved to
// scripts/coord/land/queue.mjs at plan 3961 T3.3 and is imported directly below (a
// sibling-core-module reach, needing no container): it never actually closed over the
// test-fakery state coordStep does, so it was misdescribed here even before it moved.
//
// EXPORTS. `closeOut`, `readBoardFile`, `resolveBatchLandingRow`, and
// `recoverBatchStateFromPriorSidecar` are called by the spine itself (runCloseOutIsolated /
// phaseCloseOut / phasePreflight in done-worktree.mjs) as well as by tests. `archiveBatchMembers`,
// `archiveBatchFolder`, `boardRemoveIdempotentBatch`, `boardHasRow`, `spineCarryForwardBody`,
// `verifyCloseOutOnOrigin`, and `promoteWaitingBlocked` have no spine caller outside this module —
// they are exported ONLY because the legacy module's own test suite imports them directly (a
// deliberate, temporary re-export from done-worktree.mjs; T4 moves those test cases into this
// module's own close-out.test.mjs and drops it). Everything else here is module-private.
//
// A PURE MOVE. Every moved function is byte-identical to its done-worktree.mjs original apart
// from the mechanical container-access rewrites (`L.foo(` → `D.L.foo(`, `DRY` → `D.env.DRY`,
// `emitSeam(` → `D.spine.emitSeam(`, and so on) — no renames, no reordering, no incidental
// fixes. Every comment moved with its function; they carry the plan history that explains the
// code.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { landDeps } from './deps.mjs';
// plan 3961 T3.3: dequeueQueueIfHeld moved to queue.mjs the same move that took it out of the
// `spine` group above — a sibling-core-module import, no container needed.
import { dequeueQueueIfHeld } from './queue.mjs';

// plan 4066 task 0: the member-level container-read manifest for this module — see
// preflight.mjs's own CONTAINER_READS comment for what asserts it and when, and
// container-manifest.mjs's header for the aggregator itself. Generated, not hand-typed;
// regenerate with the same scanner on a real change to this file's container reads.
export const CONTAINER_READS = Object.freeze({
  L: Object.freeze([
    'SEAM',
    'ambiguousCarryForwardMints',
    'archivePlanAction',
    'buildPlanIdIndex',
    'carryForwardAlreadyFiled',
    'carryForwardMints',
    'classifyBlocked',
    'classifyCarryForwards',
    'idempotentArchiveIndex',
    'isArchiveSessionPath',
    'isMvBadSource',
    'isNothingToCommit',
    'isRowAbsentError',
    'nextHeartbeatDate',
    'planIdForSlug',
    'planIdInTree',
    'planSummary',
    'readHeartbeatDays',
    'rowSlugFromIndex',
    'sessionNumFromSessionFile',
    'statusAlreadyCompleted',
  ]),
  atomicWrite: Object.freeze(['atomicWriteTextSync']),
  batchPaths: Object.freeze([
    'batchMdRel',
    'newManifestRel',
    'resolveManifestRel',
    'stampBatchStatus',
  ]),
  blockedByLib: Object.freeze([
    'makeArchiveIsShipped',
    'rewriteFirstBlockedByLine',
    'tailOnlyBlockedByLines',
  ]),
  boardLib: Object.freeze([
    'findRowLineIndex',
    'rowKeysForPlan',
    'rowSlugsForPlanIdLines',
    'splitBoard',
  ]),
  buildIndexLib: Object.freeze([
    'ARCHIVE_FOLDER',
    'MUTATION_BANNER_FLAG',
    'READY_FOLDER',
    'WAITING_BLOCKED_FOLDER',
    'WAITING_DATE_FOLDER',
    'assertEvidenceFloorOk',
    'cloudExecUnstampedWarning',
    'isWaitingFolder',
    'specReviewGateError',
  ]),
  coordConfig: Object.freeze(['loadCoordConfig']),
  coordGit: Object.freeze(['deleteStaleArchiveDups', 'ensureMvDestDir']),
  drainRun: Object.freeze(['carryForwardSlug']),
  env: Object.freeze(['DRY']),
  execModelStamp: Object.freeze(['ensureExecModelForExemptMechanical', 'stampedRelForExecModel']),
  indexLib: Object.freeze(['clampOverlongArchiveBullets']),
  planAdoptBranch: Object.freeze(['syncAdoptBranchStamp']),
  planBodyState: Object.freeze([
    'setStatusLine',
    'setUnblock',
    'stampArchivedStatus',
    'stampHeartbeatRun',
    'stampPromotedStatus',
    'stampWaitingOperatorStatus',
  ]),
  planCostBanner: Object.freeze(['readyCostBannerError']),
  queueDrain: Object.freeze(['originExecutedPlanIds']),
  spawn: Object.freeze(['gitMain', 'node', 'run']),
  spine: Object.freeze([
    'closeOutCommitAtHead',
    'coordStep',
    'emitSeam',
    'findSessionFile',
    'gateProbe',
    'hasStagedChanges',
    'pushMaster',
    'regenIndex',
    'resolvePlanRelForSlug',
    'tryStep',
  ]),
});

// plan 1364 review R2 (R2-2): the shared idempotent board-remove shape — swallow ONLY the
// benign "row not found" (L.isRowAbsentError), rethrow anything else. Parameterized on the
// row-slug list + coordStep log label so both boardRemoveIdempotent (single-plan, one slug)
// and boardRemoveIdempotentBatch (N slugs) drive the exact same try/catch instead of two
// hand-duplicated copies.
function boardRemoveIdempotentRows(state, rowSlugs, label) {
  const D = landDeps();
  try {
    D.spine.coordStep(state, () => D.spawn.node('board.mjs', 'remove', ...rowSlugs), label);
  } catch (e) {
    if (!D.L.isRowAbsentError(`${e.stderr || ''}${e.stdout || ''}${e.message || ''}`)) throw e;
  }
}

// plan 651: remove the board row idempotently. On a partial-run re-run the row is
// already gone (board.mjs remove self-pushes, so a crash AFTER it leaves origin
// row-less) and a second `board.mjs remove` throws `board-lib: row not found`. That is
// a benign already-removed, NOT a real failure — swallow ONLY it (mirrors
// releaseMutexIfHeld's set-state guard), rethrow anything else. DRY's node() never
// throws, so the greppable trace is unchanged.
//
// plan 665 G3 / plan 793: retry on a sibling's transient foreign-dirt — in --wait mode AND
// (via coordStep) unconditionally once the merge has landed, so the post-merge board-remove
// can't hard-crash and strand the queue head (the 2026-06-18 session-718 crash origin). A
// genuine row-absent error is NOT foreign-dirt, so coordRetry propagates it to the catch
// inside boardRemoveIdempotentRows (benign already-removed); a coordContention exhaustion
// propagates to main()'s seam.
function boardRemoveIdempotent(state) {
  boardRemoveIdempotentRows(state, [state.slug], `board remove ${state.slug}`);
}

// plan 651: stage the plan-file move to `dest` idempotently across whatever partial
// state a crashed prior run left behind (L.archivePlanAction decides). `src` is
// resolvePlanRel's result (null ⇒ already at `dest` ⇒ noop). The 'restore-move' path
// heals the "deletion unstaged + untracked dest copy" half-state the plan names: bring
// the tracked content back to src, then `git mv -f` it over the untracked dest copy.
// DRY keeps the plain `mv` trace greppable for the spine tests. `dest` is archive/<base>
// for a normal land and waiting-date/<base> for a plan-1329 heartbeat re-file — the
// move mechanics are identical, only the destination folder differs.
function movePlanFileIdempotent(MAIN, src, dest) {
  const D = landDeps();
  if (!src) return; // resolvePlanRel found it already at dest (or absent) — idempotent no-op
  // plan 1329: a heartbeat re-files INTO waiting-date/, a LIVE folder (unlike archive/, which
  // resolvePlanRel excludes → src null → the guard above). So on a heartbeat re-run after the
  // move already committed, resolvePlanRel resolves src = dest — `git mv a a` would error
  // "bad source". src === dest means the file is already where it belongs: idempotent no-op.
  if (src === dest) return;
  if (D.env.DRY) {
    D.spawn.gitMain(MAIN, ['mv', src, dest]);
    return;
  }
  const action = D.L.archivePlanAction(src, existsSync(`${MAIN}/${src}`));
  if (action === 'restore-move') {
    // tracked-but-missing working file: restore the committed content, then move it.
    D.spawn.gitMain(MAIN, ['checkout', 'HEAD', '--', src]);
  }
  if (action === 'move' || action === 'restore-move') {
    // plan 1452/1475 (item 2): git mv does NOT create the destination directory, and git cannot
    // track an empty one — so a status lane that has never held a file (a fresh archive/ on a
    // sibling with zero archived plans, a heartbeat's waiting-date/) is absent from the checkout
    // until the first file lands. coord-git's shared ensureMvDestDir mkdirs it (recursive,
    // idempotent) against the SAME tree the mv runs in — DRY already returned above, so this
    // branch is real-git only.
    D.coordGit.ensureMvDestDir(MAIN, dest);
    // -f tolerates a leftover untracked dest copy from a crashed prior run.
    try {
      D.spawn.gitMain(MAIN, ['mv', '-f', src, dest]);
    } catch (e) {
      // plan 960: `git mv` can rename the working-tree file (src→dest on disk) and THEN fail the
      // index write with the transient `unable to write new index file`. gitMain's retried
      // `git mv -f src dest` then dies "bad source" because src is already gone. Tolerate that ONLY
      // when the move demonstrably already happened (src absent, dest present): the lost index
      // update is recovered by the close-out `git add dest` + pathspec commit, which re-derive the
      // rename from the on-disk state. A "bad source" with src still present is a real error.
      const msg = `${e.stderr || ''}${e.message || ''}`;
      const moved = !existsSync(`${MAIN}/${src}`) && existsSync(`${MAIN}/${dest}`);
      if (!(D.L.isMvBadSource(msg) && moved)) throw e;
    }
  }
}

// plan 1508: verify the close-out ACTUALLY reached origin before the spine may report SUCCESS /
// closedOut:true. `board.mjs remove` pushes through its OWN disposable coord-checkout
// (withCoordCheckout resolves a SEPARATE clone directory) — a different process/tree from the
// close-out archive commit's pushMaster(MAIN) above, so a local git success on MAIN proves
// nothing about whether THAT push actually landed on origin. Plan 1384's land reported
// SUCCESS/closedOut:true while its board-row-removal push silently never reached origin for
// ~2.5h, hard-blocking every sibling's pre-push (ARCHIVED_PLAN_ACTIVE_ROW). Fetch origin FRESH
// (a push performed from a different checkout does not update THIS worktree's remote-tracking
// ref) and assert on origin/master: every board row this close-out believes it removed is gone,
// and every plan it believes it archived actually sits in its expected status folder. Throws
// (never returns a boolean) on any mismatch, tagged `.closeOutUnverified` so main()'s catch can
// record a distinct CLOSEOUT_UNVERIFIED sidecar (never SUCCESS) instead of the generic CRASH
// label. Covers BOTH lanes: single-plan (state.slug / state.planArchived) and batch
// (state.batch.rowSlugs / state.batch.dispositions, stamped by closeOutBatch). No-op under DRY
// (nothing was really pushed). Exported for a direct real-git-fixture test.
//
// plan 1578 (generalizing this fix into the shared seam, review finding 5): coordWrite itself
// now asserts (assertPushReachedOrigin, coord-git.mjs) that ITS push reached origin before
// returning success — so `board.mjs remove`'s specific push (the trigger case above) is now
// caught INSIDE board.mjs/coordWrite, before this function ever runs, and the board-row-removal
// half of the checks below is BELT-AND-SUSPENDERS for that lane, not the primary guard anymore.
// This function is KEPT, not shrunk: the close-out archive commit (the `git mv` into archive/ +
// pushMaster(MAIN) above) is a SEPARATE push path that does not route through coordWrite at all,
// so the archive-file-landed check below remains the ONLY guard against that push silently never
// reaching origin. (It also still re-verifies board-row-removal as a genuine end-to-end assert —
// harmless and cheap once already fetched — rather than trusting coordWrite's internal check by
// name alone.)
// plan 1508 review fix (cleanup 5): the recurring "read something from origin/master, tag ANY
// failure closeOutUnverified" shape (fetch / board show / board parse / ls-tree, below) factored
// into one wrapper — a future tag/message change edits ONE place instead of 4 near-identical
// try/catch blocks.
function readOrUnverified(state, desc, fn) {
  try {
    return fn();
  } catch (e) {
    throw closeOutUnverifiedError(state, `could not ${desc} (${e.message || e}).`);
  }
}

export function verifyCloseOutOnOrigin(MAIN, state) {
  const D = landDeps();
  if (D.env.DRY) return;
  const { paths } = D.coordConfig.loadCoordConfig(MAIN);
  // plan 1508 review fix (delta-review bugs 1+2): a batch retry whose manifest is already gone
  // (main()'s isBranchAlreadyLanded reentry) recovers its check-set from a PRIOR run's sidecar
  // (recoverBatchStateFromPriorSidecar). If that recovery found NOTHING usable — no sidecar at
  // all, because a prior writeResultSidecar write itself failed (best-effort, swallows errors) —
  // we have NO idea what to verify. FAIL CLOSED here rather than silently falling through to
  // empty rowSlugs/dispositions, which would make every check below trivially pass — the exact
  // plan-1384 bug, reproduced through this exact gap. `recovered` is set ONLY by
  // recoverBatchStateFromPriorSidecar (undefined on a normal, non-retry batch/single-plan run —
  // never mistaken for this failure signal).
  if (state.batch && state.batch.recovered === false) {
    throw closeOutUnverifiedError(
      state,
      `this is a retry whose batch manifest is already gone (a prior close-out's archive commit ` +
        `already reached origin) but no usable prior result sidecar was found at ` +
        `.scratch/done-worktree-${state.slug}.result.json to recover which board row(s) / ` +
        `archived plan(s) this land still needs to verify — cannot safely assume nothing is ` +
        `left. Manually check ${paths.boardFile} and docs/superpowers/plans/archive/ on ` +
        `origin/master for this batch's members before re-invoking.`,
    );
  }
  readOrUnverified(state, 'fetch origin/master to verify the close-out', () =>
    D.spawn.run('git', ['-C', MAIN, 'fetch', 'origin', 'master']),
  );
  const boardContent = readOrUnverified(
    state,
    `read ${paths.boardFile} at origin/master to verify the close-out`,
    () => D.spawn.run('git', ['-C', MAIN, 'show', `origin/master:${paths.boardFile}`]),
  );
  // plan 1508 review fix (F2): parse the board directly via splitBoard/findRowLineIndex — NOT
  // boardHasRow, whose catch-to-false is the right default for ITS other callers (fail toward
  // "no LANDING representative" / "not held"), but wrong here: a PARSE failure means we CANNOT
  // verify, not "the row is confirmed absent". A parse failure must throw closeOutUnverified,
  // never silently pass the leftover-row check.
  const boardLines = readOrUnverified(
    state,
    `parse ${paths.boardFile} at origin/master to verify board-row removal`,
    () => D.boardLib.splitBoard(boardContent).body.split('\n'),
  );
  const rowSlugs = state.batch ? state.batch.rowSlugs || [] : [state.slug];
  const leftoverRows = rowSlugs.filter((s) => D.boardLib.findRowLineIndex(boardLines, s) !== -1);

  // plan 1508 review fix (F4): a fresh POST-push read of origin — do NOT switch to the memoized
  // _planTreeCache/planTreeListing, which would read a PRE-push snapshot.
  const lsPlans = readOrUnverified(
    state,
    'list docs/superpowers/plans at origin/master to verify the archive move',
    () =>
      D.spawn.run('git', [
        '-C',
        MAIN,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans',
      ]),
  );

  // Batch: every member archiveBatchMembers dispositioned 'archived' / 'already-archived' must
  // sit in archive/ on origin (a 'reparked-skipped' member was deliberately NOT removed/archived
  // — not checked); each disposition carries the manifest member's numeric id. Single-plan:
  // state.planArchived, expected under waiting-date/ for a heartbeat re-file, else archive/; its
  // id is parsed off the archived basename via the SAME shared L.planIdForSlug direct-match
  // (mirrors closeOutSingle's own planId resolution — a basename and a modern plan slug share
  // the identical leading-digit shape, so reusing it here can't drift into a 3rd hand-rolled
  // regex). Presence is tested with the SAME L.planIdInTree basename-prefix matcher
  // record-review.mjs's advisory probe and this spine's own land-gate already use, so this check
  // can never quietly diverge into a different notion of "the plan exists" than the rest of the
  // spine — a hand-rolled exact-string check was the F4 finding here. A legacy date-prefixed
  // basename (no numeric id) falls back to an exact basename match, scoped to the same directory.
  const expectDir =
    !state.batch && state.heartbeatReparked
      ? D.buildIndexLib.WAITING_DATE_FOLDER
      : D.buildIndexLib.ARCHIVE_FOLDER;
  const checks = state.batch
    ? (state.batch.dispositions || [])
        .filter((d) => d.disposition === 'archived' || d.disposition === 'already-archived')
        .map((d) => ({ id: d.id != null ? String(d.id) : null, base: d.path.split('/').pop() }))
    : state.planArchived
      ? [{ id: D.L.planIdForSlug(state.planArchived, ''), base: state.planArchived }]
      : [];
  const dirPrefix = `docs/superpowers/plans/${expectDir}/`;
  // plan 1508 review fix (cleanup 4): split lsPlans ONCE into an array; derive both the
  // planIdInTree string view AND the exact-basename-fallback array from that SAME array, instead
  // of re-splitting a joined string per check inside landedInDir.
  const dirLines = lsPlans.split('\n').filter((p) => p.startsWith(dirPrefix));
  const dirListing = dirLines.join('\n');
  const landedInDir = (c) =>
    c.id
      ? D.L.planIdInTree(dirListing, c.id)
      : dirLines.some((p) => p.trim() && p.split('/').pop() === c.base);
  const missing = checks.filter((c) => !landedInDir(c)).map((c) => c.base);

  if (leftoverRows.length || missing.length) {
    throw closeOutUnverifiedError(
      state,
      `the local land believes it removed board row(s) [${rowSlugs.join(', ') || '(none)'}] and ` +
        `archived plan(s) [${checks.map((c) => c.base).join(', ') || '(none)'}], but origin/master still shows` +
        `${leftoverRows.length ? ` LEFTOVER board row(s) [${leftoverRows.join(', ')}]` : ''}` +
        `${leftoverRows.length && missing.length ? ' AND' : ''}` +
        `${missing.length ? ` MISSING archive file(s) [${missing.join(', ')}] under docs/superpowers/plans/${expectDir}/` : ''}.`,
    );
  }
}

// plan 1508 review fix (F1, delta-review bugs 1+2, then a 3rd-round tightening): pure recovery
// of a batch's dispositions/rowSlugs when the manifest is already gone (main()'s
// isBranchAlreadyLanded reentry branch) — see verifyCloseOutOnOrigin's call-site comment for the
// full "why" (the plan-1384 bug reproduced on a retry). `prior` is whatever
// readResultSidecar(MAIN, slug) returned (null when absent/unparseable — writeResultSidecar is
// best-effort and can silently fail to write). Accepts a prior sidecar for this slug carrying
// non-empty batch data for ANY FAILURE code (CRASH / CLOSEOUT_UNVERIFIED / a seam / …) —
// writeResultSidecar runs on EVERY exit path, so a generic CRASH that happened AFTER
// closeOutBatch captured rowSlugs carries perfectly valid data too; gating on
// code === 'CLOSEOUT_UNVERIFIED' (round 1) discarded exactly that case. But a `code === 'SUCCESS'`
// sidecar is REFUSED even if it carries rowSlugs: `.scratch/` is gitignored and never purged, so
// a reused/long-lived slug could carry a STALE completed-run sidecar from an unrelated earlier
// close-out — accepting it on a retry path would verify the WRONG batch's rows (round 2's
// too-loose "any code" widening). A completed run has nothing left to retry, so SUCCESS is
// inconsistent-by-definition on this path — treat it exactly like "no sidecar". `recovered: false`
// (no sidecar, empty batch data, or a SUCCESS-coded one) is the caller's signal to fail closed
// rather than run its checks against empty arrays; `recovered` is never set on a normal
// (non-retry) batch/single-plan run, so it can never be mistaken for "verified clean". No git/fs
// of its own — pure, directly testable.
export function recoverBatchStateFromPriorSidecar(prior) {
  const usable = prior && prior.code !== 'SUCCESS' ? prior.batch : null;
  const rowSlugs = (usable && usable.rowSlugs) || [];
  const dispositions = (usable && usable.dispositions) || [];
  return {
    manifest: null,
    dispositions,
    rowSlugs,
    recovered: rowSlugs.length > 0 || dispositions.length > 0,
  };
}

// Tag the error so main()'s catch can record CLOSEOUT_UNVERIFIED instead of the generic CRASH
// label, and carry a uniform recovery instruction (this is a bookkeeping-only gap — the merge
// already reached origin — re-invoking is safe/idempotent; a hand-merge is NEVER the recovery).
function closeOutUnverifiedError(state, detail) {
  const err = new Error(
    `done-worktree: close-out UNVERIFIED on origin/master for "${state.slug}" — ${detail} ` +
      `The merge already reached origin (mergeSha ${state.mergeSha}) — this is a bookkeeping-only ` +
      `gap; re-invoke done-worktree to retry the close-out push. Do NOT hand-merge.`,
  );
  err.closeOutUnverified = true;
  return err;
}

export function closeOut(MAIN, state, carryForwards) {
  const D = landDeps();
  D.spine.gateProbe(MAIN, state);

  // carry-forward gate: any ambiguous bullet with no --decision → seam, UNLESS
  // --carryforward-defer (the autonomous drain) is set, in which case we proceed and mint
  // each ambiguous bullet as its own pending-approval/ stub (plan 1419: every mint rests
  // there, uniformly with the decided bucket) — but LATER, alongside the decided cf.auto
  // bucket AFTER the parent's archive push (plan 629), so a follow-up is only opened once
  // the parent has genuinely landed (no orphan stub against an un-archived parent if the
  // close-out fails between here and the push).
  const cf = D.L.classifyCarryForwards(carryForwards || []);
  if (cf.ask.length && !state.decision && !state.carryforwardDefer) {
    D.spine.emitSeam(
      D.L.SEAM.CARRYFORWARD_AMBIGUOUS,
      `ambiguous carry-forwards: ${cf.ask.join(' | ')}`,
      state,
    );
  }

  // plan 1364 Ship 3: a batch land archives N members (board rows, plan files, session/INDEX
  // narrative) in ONE close-out instead of the single-plan flow below. Additive branch — the
  // single-plan path from here to the close-out commit is UNCHANGED.
  if (state.batch) {
    closeOutBatch(MAIN, state);
  } else {
    closeOutSingle(MAIN, state);
  }

  // plan 793: release the same-PC O_EXCL landing-lock UNCONDITIONALLY by slug (shared tail —
  // see the single-plan comment below for the full "why unconditional" rationale; identical for
  // batch mode since `state.slug` is the BATCH slug for the whole spine's lifetime, batch or not).
  try {
    D.spawn.node('landing-lock.mjs', 'release', state.slug);
    state.landingReleased = true;
  } catch (e) {
    (state.teardownErrors ||= []).push(`landing-lock release ${state.slug}: ${e.message || e}`);
  }
  dequeueQueueIfHeld(state);
  mintCarryForwards(MAIN, state, cf.auto);
  if (state.carryforwardDefer && cf.ask.length) {
    mintCarryForwardItems(MAIN, state, D.L.ambiguousCarryForwardMints(cf.ask));
  }
  // plan 1508: only NOW — after every close-out push above has run — verify on origin/master
  // that they actually landed. A throw here leaves state.closedOut false (landFullyCompleted
  // stays false too), so main()'s catch can never fall into the teardown-error/SUCCESS tolerance.
  verifyCloseOutOnOrigin(MAIN, state);
  state.closedOut = true;
}

// plan 665 G1.3: last-resort belt, shared by BOTH close-out paths (single + batch — plan 1364
// review R1 F7 dedup). `idempotentArchiveIndex` already clamps via clampArchiveNote, but the
// spine runs the WORKTREE's copy of these scripts — a worktree cut BEFORE the clamp landed
// (the 2026-06-15 646 land) writes an over-CAP bullet anyway. Hard-cap it HERE, before the
// close-out commit, so the pre-push lint-index-brevity can never REJECT the close-out push
// AFTER the merge already landed (merge + board-remove + dequeue done → an orphan worktree +
// half-archived master is the poison-pill this prevents). A non-empty `fixed` means the
// primary clamp didn't fire — surfaced as a WARNING, never a halt (the land must complete).
// No-op (and never called) under DRY — both callers gate on `!DRY` already.
function beltClampArchiveBullets(MAIN) {
  const D = landDeps();
  const indexAbs = `${MAIN}/docs/INDEX.md`;
  const belt = D.indexLib.clampOverlongArchiveBullets(readFileSync(indexAbs, 'utf8'));
  if (belt.fixed.length) {
    writeFileSync(indexAbs, belt.content);
    process.stderr.write(
      `done-worktree: WARNING — hard-capped ${belt.fixed.length} over-CAP archive bullet(s) at the ` +
        `G1.3 belt (${belt.fixed.map((f) => `${f.slug} ${f.before}→${f.after}`).join(', ')}). ` +
        `The primary clampArchiveNote did not fire — this worktree's scripts likely predate the clamp. ` +
        `Land proceeds; investigate the archive-write path.\n`,
    );
  }
  return belt;
}

// plan 1364 review R2 (R2-3): the shared archive-note prefix — both closeOutSingle and
// closeOutBatch build the string "archived DATE (session N), merged SHA."; closeOutBatch
// appends its own trailing "— batch <slug> (N members)." tag after calling this. Extracted so
// the two note-building sites can't drift on the shared shape. Plan 3971: the row is
// prefix-only now — the plan's summary lives in the archived plan file, the INDEX row
// is a pointer — so this takes no summary argument.
function archiveNotePrefix(state) {
  return `archived ${state.date} (session ${state.sessionN ?? '?'}), merged \`${state.mergeSha}\`.`;
}

// The single-plan close-out (steps 3-15 of the original closeOut, extracted verbatim under
// plan 1364 Ship 3 so the batch branch above can sit beside it without duplicating the shared
// tail — landing-lock release / dequeue / carry-forward minting / `state.closedOut = true`,
// all now hoisted into closeOut itself). Behavior is BYTE-FOR-BYTE identical to before this
// extraction; only the enclosing function boundary moved.
function closeOutSingle(MAIN, state) {
  const D = landDeps();
  // SUCCESS: remove the board row outright (the lane's mutex marker), self-pushed.
  // Idempotent (plan 651): a re-run after a partial close-out finds the row already
  // gone — `row not found` is a benign no-op, not a crash.
  boardRemoveIdempotent(state);

  // plan 822: resolve the plan file by its numeric ID (case-free), NOT the claimed slug.
  // The slug can lowercase the `NNN-PX-` category tag (`811-infra-…`) while the tracked file
  // keeps its mixed case (`811-Infra-…`); a slug-derived basename then mismatches the
  // case-sensitive ls-files match → src=null → the archive `git mv` no-ops and the close-out
  // `git add archive/<lowercase>.md` throws AFTER the merge landed, stranding the land at the
  // archive tail (2026-06-19, plan 811). Deriving base/arch from the REAL tracked basename
  // keeps the mv + add in case-lockstep — exactly what move-plan.mjs already does.
  // Modern-vs-legacy slug resolution now lives in resolvePlanRelForSlug (shared with
  // planPriorityFor — review 2328 reuse extraction); the plan-822 rationale is on it.
  const planId = (state.slug.match(/^(\d{3,})-(?![0-9])/) || [])[1];
  const lsPlans = D.env.DRY
    ? ''
    : D.spawn.run('git', ['-C', MAIN, 'ls-files', 'docs/superpowers/plans']);
  // null = the file is already in archive/ (a partial-crash re-run) → movePlanFileIdempotent no-ops
  // idempotently below. In --dry-run keep the deterministic in-progress/ fixture.
  // Both exclude archive/ → null when the plan is not in a LIVE status folder.
  const resolveLive = (opts) => D.spine.resolvePlanRelForSlug(lsPlans, state.slug, opts);
  const src = D.env.DRY ? `docs/superpowers/plans/in-progress/${state.slug}.md` : resolveLive();
  // When src is null the plan EITHER already moved to archive/ (idempotent re-run) OR is
  // genuinely missing. Resolve the archived copy to tell them apart AND recover the REAL
  // archived basename — otherwise base would fall back to the (possibly lowercase) slug and
  // idempotentArchiveIndex's exact-string key would miss the real-cased bullet → DUPLICATE.
  const archivedRel = !D.env.DRY && !src ? resolveLive({ archived: true }) : null;
  // Bug C (plan 822): src is null in TWO cases — (a) already in archive/ (a partial-crash
  // re-run → idempotent no-op, the normal path) and (b) the plan file is genuinely missing
  // from every status folder. Only (b) is broken; falling through would `git add` a
  // non-existent archive path AFTER the merge landed (the opaque crash this plan fixes).
  // `archivedRel` distinguishes them; seam cleanly on (b) — never crash. Covers BOTH modern
  // and legacy slugs (the seam is NOT gated on planId — the crash class is identical).
  if (!D.env.DRY && !src && !archivedRel) {
    D.spine.emitSeam(
      D.L.SEAM.ARCHIVE_UNRESOLVED,
      `cannot resolve plan file for ${planId ? `id ${planId}` : `slug ${state.slug}`} under ` +
        `docs/superpowers/plans/ — not in any live status folder nor archive/. The merge ` +
        `already landed; locate/restore the plan file, then re-invoke done-worktree.`,
      state,
    );
  }
  // Derive base/arch from the REAL tracked basename (case-preserving): from src (normal
  // land), else the already-archived file (idempotent re-run). The slug fallback is reached
  // only under DRY (where src is the deterministic fixture) — a non-DRY null/null seamed above.
  const base = src || archivedRel ? (src || archivedRel).split('/').pop() : `${state.slug}.md`;
  state.planArchived = base;

  // plan 1329: a recurring "heartbeat" plan (frontmatter `heartbeat: <days>`) NEVER
  // archives — running it IS the deliverable. Instead of the archive close-out below it
  // is RE-FILED to waiting-date/ +<days>, so it stays in the GENERATED active region and
  // never enters the hand-maintained archive narrative — whose consistency lint tripped
  // on every re-file before this plan (the per-cycle manual-reword toil, 1078 W27).
  // Detection reads the `heartbeat:` key off the resolved LIVE plan file (src); under DRY
  // it is injected via DW_FAKE_HEARTBEAT_DAYS so the spine test exercises the re-file
  // trace. A re-run after the plan already moved back to waiting-date/ still resolves it
  // via src (waiting-date/ is a live folder) and reads the same key → idempotent.
  // Route the DRY test hook through the SAME L.readHeartbeatDays parser as the real path (by
  // wrapping the injected value in a one-key frontmatter string) so the two can never diverge
  // on what counts as a valid heartbeat — and so `readHeartbeatDays` stays the single source of
  // truth (it already returns null-or-positive-int, so no follow-on re-check is needed).
  const heartbeatDays = D.env.DRY
    ? D.L.readHeartbeatDays(`---\nheartbeat: ${process.env.DW_FAKE_HEARTBEAT_DAYS ?? ''}\n---\n`)
    : src && existsSync(`${MAIN}/${src}`)
      ? D.L.readHeartbeatDays(readFileSync(`${MAIN}/${src}`, 'utf8'))
      : null;
  const heartbeat = heartbeatDays != null;
  // Mark the outcome so formatReport says "re-filed to waiting-date/", not "archived" — set
  // regardless of whether the stamp below runs, so the report is honest even on an edge where
  // the moved file is momentarily absent.
  if (heartbeat) state.heartbeatReparked = base;

  // ── ATOMIC CLOSE-OUT MOVE (plan 399; heartbeat re-file plan 1329) ─────
  // The plan-file `git mv` AND the docs/INDEX.md mutation land in ONE close-out
  // commit/push — never two separate pushes. Before plan 399, the INDEX archive
  // SELF-PUSHED via `index.mjs archive` BEFORE the `git mv`, so a failed / raced
  // close-out push froze origin half-archived (INDEX says archived, file still tracked
  // in in-progress/) → lint-plan-index rejected every re-push and recovery was manual
  // (plan 396, session 343). Now: move the file (staged) → regenerate INDEX from
  // ls-files (which already reflects the staged move) → stage + commit + push together,
  // so origin/master is self-consistent at every observable point.
  //
  // Bug A (plan 367): resolve the plan's ACTUAL status folder — it is NOT always
  // in-progress/ (a drain operator-checkpoint block lands from waiting-operator/).
  // `src` (resolved by ID above, plan 822) carries the real status folder + casing.
  // `dest` = archive/<base> for a normal land, waiting-date/<base> for a heartbeat.
  // plan 3960 cluster-3 review fix: this write used to hardcode the literal folder names while
  // the VERIFY step a few hundred lines below (`expectDir`, ~13439) already read them through
  // ARCHIVE_FOLDER / WAITING_DATE_FOLDER — a renamed lane would break the two asymmetrically
  // (the write would land in the OLD name, the verify would look for the NEW one).
  const dest = heartbeat
    ? `docs/superpowers/plans/${D.buildIndexLib.WAITING_DATE_FOLDER}/${base}`
    : `docs/superpowers/plans/${D.buildIndexLib.ARCHIVE_FOLDER}/${base}`;
  // plan 651: idempotent across a crashed prior run's half-staged move (the bare
  // `if (src) git mv` used to crash on a leftover untracked dest copy / missing src).
  movePlanFileIdempotent(MAIN, src, dest);
  // plan 1175/1184: after the move, remove any stale UNTRACKED same-basename copy that remained
  // in another (non-archive/) plan subfolder — the auto-heal Stop-hook would re-track it and
  // trip archive-consistency next push. This is a GENERAL duplicate safety net (any non-archive/
  // folder), not archive-specific, so it runs on the heartbeat re-file too; it only removes
  // UNtracked dups, so the freshly-tracked waiting-date/ copy is never touched.
  if (!D.env.DRY && base) {
    D.coordGit.deleteStaleArchiveDups(MAIN, base);
  }

  // Resolve the session file + number up-front — a heartbeat body stamp records the
  // session that ran, so sessionN must be known BEFORE the stamp. An archive stamp
  // doesn't use it, but sharing the resolution keeps one code path (plan 427: sessionN
  // ← the resolved session-file name; the board row that also carried it was removed
  // above). DRY leaves sessionN null so the dry-run note is byte-for-byte unchanged.
  const closeCfg = D.coordConfig.loadCoordConfig(MAIN);
  const sf = D.spine.findSessionFile(MAIN, state.slug, closeCfg.handoffLayout);
  state.sessionN = D.L.sessionNumFromSessionFile(sf);

  // Body stamp on the moved file at `dest` (re-staged into the one close-out commit;
  // plan 651: gate on the moved file existing, NOT `src`, so a re-run that already moved
  // it — src null — still stamps). A heartbeat re-file re-dates Blocked-by/Trip-date
  // +<days> and records the run (stampHeartbeatRun KEEPS the trip marker, deterministic
  // for the same run/next dates → idempotent re-run). A normal land stamps ✅ COMPLETED
  // + drops any stale Blocked-by/LAND_BLOCKED note (plan 619 — the 2026-06-14 plan-612
  // false-alarm where an archived body read READY + Blocked-by though the code shipped).
  if (!D.env.DRY) {
    const planAbs = `${MAIN}/${dest}`;
    if (existsSync(planAbs)) {
      const body = readFileSync(planAbs, 'utf8');
      if (heartbeat) {
        // Idempotency guard: if the body already records THIS land (its mergeSha, stable
        // across retries), skip re-stamping. Without it, a crash-retry on a LATER calendar
        // day would recompute nextDate/Last-run from the retry's wall-clock `state.date` and
        // drift the recurring cadence forward. (A crash BEFORE this stamp, retried a later
        // day, can still re-date by the retry-gap — self-correcting next cycle, matching the
        // archive path's own statusAlreadyCompleted tolerance.)
        if (!(state.mergeSha && body.includes(`landed \`${state.mergeSha}\``))) {
          writeFileSync(
            planAbs,
            D.planBodyState.stampHeartbeatRun(body, {
              runDate: state.date,
              nextDate: D.L.nextHeartbeatDate(state.date, heartbeatDays),
              sessionN: state.sessionN,
              mergeSha: state.mergeSha,
            }),
          );
        }
      } else if (!D.L.statusAlreadyCompleted(body)) {
        writeFileSync(
          planAbs,
          D.planBodyState.stampArchivedStatus(body, { date: state.date, via: 'done-worktree' }),
        );
      }
    }
  }

  // 6b: promote any waiting-blocked/ dependents whose only blocker was this plan. A
  // heartbeat never archives, so nothing is unblocked BY it — skip (no promotions).
  const promotedMoves = heartbeat ? [] : promoteWaitingBlocked(MAIN, base, state);

  // flip the session entry to ✅ COMPLETED (deterministic; edited on $MAIN's copy).
  // Kept tight against the INDEX write so the docs/INDEX.md edit→commit window is as
  // small as possible: docs/INDEX.md is one of gateProbe's shared-path sentinels, so a
  // crash that leaves it dirty would make a retry's gateProbe (or a parallel free-lane
  // session) STOP — keeping the dirty window to write→regen→add→commit minimises that
  // exposure (recovery if it crashes: `git -C <MAIN> checkout -- docs/INDEX.md`, then
  // re-invoke; the archive/re-file is regenerated deterministically).
  if (sf && !D.env.DRY) flipSessionCompleted(MAIN, sf, state);
  else if (!sf && !D.env.DRY) reportUnflippedSessionEntry(state); // plan 2891 T7

  // plan 427: populate the summary the archive note + commit subject interpolate (from
  // the moved plan's frontmatter, now at `dest`). DRY leaves it null → dry-run note
  // unchanged.
  if (!D.env.DRY) {
    const planAbs = `${MAIN}/${dest}`;
    if (existsSync(planAbs)) state.summary = D.L.planSummary(readFileSync(planAbs, 'utf8'));
  }

  // ATOMIC INDEX: a normal land writes the archive narrative line LOCALLY (idempotent
  // for a re-run), then regenerates the active region from ls-files. A HEARTBEAT writes
  // NO narrative line — the plan stays in a LIVE folder (waiting-date/), so regenIndex
  // simply repaths its existing active bullet and nothing enters the archive narrative
  // (the whole point of plan 1329: no archive note → no archive-consistency trip).
  if (!D.env.DRY && !heartbeat) {
    const note = archiveNotePrefix(state);
    const indexAbs = `${MAIN}/docs/INDEX.md`;
    writeFileSync(indexAbs, D.L.idempotentArchiveIndex(readFileSync(indexAbs, 'utf8'), base, note));
  }
  D.spine.regenIndex(MAIN);

  // plan 665 G1.3 belt — only meaningful when an archive note was written (a heartbeat
  // writes none). shared helper, plan 1364 review R1 F7.
  if (!D.env.DRY && !heartbeat) beltClampArchiveBullets(MAIN);

  // close-out commit (session flip + archive rename + INDEX + promotions) + push.
  // NOTE (plan 406): the carry-forward `→ open new plan` plans are NOT staged here.
  // They are minted AFTER this commit via `next-plan-id.mjs claim` (mintCarryForwards
  // below), which self-commits + self-pushes each new plan file (+ its INDEX bullet)
  // race-safely — so by the time `state.newPlans` is populated the files are already
  // on master, nothing left to stage. (The earlier `ready/${p}` staging assumed a
  // locally-written untracked file, which the race-safe claim path doesn't produce.)
  const stage = [sf, dest, 'docs/INDEX.md', ...promotedMoves].filter(Boolean);
  // Bug #2 (plan 378): the commit MUST be pathspec-scoped. A bare `git commit`
  // sweeps the WHOLE staged index — on the shared .git a sibling session's staged
  // file would be swept into THIS master push (the pushMaster doc-comment's
  // "explicit pathspec" safety premise was false until now). The pathspec also
  // has to carry the rename OLD-paths: the close-out `git mv src dest` and each
  // promotion `git mv rel dest` stage a deletion at the source that is NOT in
  // `stage`; omit it and the deletion is stranded (left uncommitted).
  const renameOldPaths = [src, ...(state.promotedOldPaths || [])].filter(Boolean);
  const commitPaths = [...stage, ...renameOldPaths];
  D.spawn.gitMain(MAIN, ['add', ...stage]);
  // plan 651: a fully-completed-then-interrupted re-run (e.g. a crash during teardown
  // AFTER the close-out already committed+pushed) re-reaches here with everything already
  // on origin/master — every step above no-op'd, so `git add` staged nothing and a bare
  // `git commit` would exit 1 "nothing to commit" → gitMain rethrows → the re-run crashes
  // before the teardown that still needed finishing. Skip the commit+push when nothing in
  // the close-out pathspec is staged; the lock release + mint + teardown below still run.
  // DRY always commits so the greppable spine-test trace is unchanged.
  if (D.env.DRY || D.spine.hasStagedChanges(MAIN, commitPaths)) {
    // The close-out commit edits docs/INDEX.md's GENERATED region (regenIndex drops
    // the archived plan's bullet), so the plan-421 lint-coord-trailer guard requires
    // a `Coord-Write:` trailer here — closeOut IS a sanctioned coord write, like
    // move-plan. Without it the pre-push hook (pushMaster does NOT set HUSKY=0)
    // rejects every landing — including this plan's own.
    // plan 983: run the COMMIT with HUSKY=0 so the pre-commit lint-staged does NOT run
    // mid-commit ("Updating Git index again"), which on the shared .git WIDENS the window
    // between this commit's HEAD-read and its ref-write where a sibling can move HEAD and
    // trip `cannot lock ref 'HEAD'` (the 2026-06-22 plan-977 land crash). The plan files +
    // INDEX are .prettierignore'd so lint-staged was pure overhead here anyway; the same
    // `HUSKY=0`-on-commit that coordWrite already uses. The PUSH (pushMaster) keeps husky,
    // so the pre-PUSH lint-coord-trailer / lint-plan-index guards still run — the trailer
    // above satisfies them. gitMain also now RETRIES the ref-lock race as a backstop.
    try {
      D.spawn.gitMain(
        MAIN,
        [
          'commit',
          '-m',
          `docs(plans): done ${state.slug} — ${D.L.clampSubject(state.summary) ?? 'closed via spine'}`,
          '-m',
          `${D.coordGit.COORD_TRAILER}: done-worktree`, // second -m → own paragraph → guard's ^Coord-Write: line
          '--',
          ...commitPaths,
        ],
        { env: { HUSKY: '0' } },
      );
    } catch (e) {
      // plan 960: gitMain retries a transient `unable to write new index file`. But git's
      // "repository has been updated, but …" means the commit object + ref move ALREADY happened
      // before the index write failed — so the retried `git commit` finds nothing staged and
      // reports "nothing to commit". That is NOT a failure: the close-out commit landed (locally;
      // it was never pushed — the pre-960 throw unwound before pushMaster). Tolerate it ONLY once
      // closeOutCommitAtHead CONFIRMS the close-out commit is genuinely at HEAD (the authoritative
      // half-land signal — NOT merely "nothing staged", which a hypothetical staged drain could
      // also produce, silently pushing a land missing its archive/INDEX commit). DRY trusts the
      // injected signal. Then fall through to pushMaster to publish the locally-created commit;
      // anything else (real hook/auth failure, exhaustion, a never-landed commit) surfaces honestly.
      const msg = `${e.stderr || ''}${e.message || ''}`;
      if (
        !(
          D.L.isNothingToCommit(msg) &&
          (D.env.DRY || D.spine.closeOutCommitAtHead(MAIN, state.slug))
        )
      )
        throw e;
    }
    D.spine.pushMaster(MAIN); // non-ff retry; releases the cross-PC mutex (mergeSha stays the merge commit)
  }
  // NOTE: the refs/claims/<id> lock is released in main() the MOMENT the merge
  // lands (releaseClaimAfterMerge) — NOT here — so a close-out push failure or
  // crash can never orphan it (plan 399). By the time control reaches this point
  // the claim is already released.
  // plan 1364 Ship 3: the landing-lock release / FIFO dequeue / carry-forward minting /
  // `state.closedOut = true` tail that used to end HERE is now shared with the batch branch —
  // hoisted into the enclosing closeOut() (see above), unchanged in behavior.
}

// plan 1455 review-fix: rowSlugFromIndex moved to done-worktree-lib.mjs (next to its sole input
// buildPlanIdIndex) so claim-plan.mjs's derail can reuse it without importing this heavy module.
// plan 3961 T3.1: its re-export for done-worktree.test.mjs stays in done-worktree.mjs, not here —
// a core module under scripts/coord/ may import only scripts/coord/** and node: builtins (Rule 3),
// so it cannot re-export directly from done-worktree-lib.mjs the way the command file could. This
// module's own code already reaches it as `D.L.rowSlugFromIndex`.

// plan 1478: does the board actually carry a row for `slug`? The plan-1478 crash is
// specifically a strict `board.mjs set-state <slug> LANDING` on a row that a mid-train
// derail already REMOVED — so gating on real row PRESENCE, not merely on the plan FILE
// resolving, is the fix. resolveBatchLandingRow below re-implements this same check inline
// against a pre-split board instead of calling this (review-fix: one parse instead of one
// per member), so this function itself has no runtime caller; it stays exported purely so
// done-worktree.test.mjs can exercise the row-presence logic directly. Malformed /
// sentinel-less board → false (treat as absent; a land can't stamp LANDING on a board it
// can't parse anyway).
export function boardHasRow(boardContent, slug) {
  const D = landDeps();
  try {
    return (
      D.boardLib.findRowLineIndex(D.boardLib.splitBoard(boardContent).body.split('\n'), slug) !== -1
    );
  } catch {
    return false;
  }
}

// plan 1801 (review-fix): the ONE board-file read idiom — resolve the configured board path
// and read it, a missing/unreadable board yielding '' (fail-closed, matching boardHasRow).
// Shared by main()'s LANDING-representative resolution and closeOutBatch's row-key assembly,
// which had each hand-rolled the same loadCoordConfig+readFileSync try/catch.
export function readBoardFile(MAIN) {
  const D = landDeps();
  const rel = D.coordConfig.loadCoordConfig(MAIN).paths.boardFile;
  let content = '';
  try {
    content = readFileSync(`${MAIN}/${rel}`, 'utf8');
  } catch {
    // missing/unreadable board → ''
  }
  return { rel, content };
}

// plan 1478 (belt-and-suspenders): pick the batch's 🟢 LANDING representative — the FIRST
// manifest member whose board row is genuinely PRESENT — and surface every member that
// resolves a row slug but has NO board row (a mid-train derail that did NOT reconcile the
// manifest via `claim-plan.mjs derail`). plan 1801: row presence is checked under BOTH keys —
// the basename-derived slug AND the stable planId — so a member renamed while claimed (its
// row still carrying the claim-time slug) counts as present, not stale. Pure (git-/fs-free)
// so it is directly unit-testable; main() feeds it the pre-built id→path index + the board
// content. Returns { landingRowSlug: string|null, staleMembers: [{ id, rowSlug }] }.
export function resolveBatchLandingRow(members, planIndex, boardContent) {
  const D = landDeps();
  const staleMembers = [];
  let landingRowSlug = null;
  // Parse/split the board ONCE up front, then test each member against the parsed lines — instead
  // of boardHasRow re-splitting the whole board per member (review-fix, mirrors landing-queue-lib's
  // batchMemberLandingRows). An unparseable board → no lines → every member counts as row-absent,
  // exactly matching boardHasRow's own fail-closed catch.
  let boardLines = null;
  try {
    boardLines = D.boardLib.splitBoard(boardContent).body.split('\n');
  } catch {
    boardLines = null;
  }
  for (const id of members) {
    const rs = D.L.rowSlugFromIndex(planIndex, id);
    if (!rs) continue; // no plan file resolves at all — archiveBatchMembers' ARCHIVE_UNRESOLVED seam owns it
    if (boardLines && D.boardLib.findRowLineIndex(boardLines, rs) !== -1) {
      if (!landingRowSlug) landingRowSlug = rs;
    } else {
      // plan 1801: before declaring the member stale, try the STABLE planId key — a plan
      // renamed while claimed (the execModel Infra↔FABLE stamp) desyncs the row's claim-time
      // slug from the current basename, but the row is genuinely PRESENT and perfectly valid
      // as the 🟢 LANDING representative. Only a member with no row under EITHER key is a
      // real unreconciled derail.
      const byId = boardLines ? D.boardLib.rowSlugsForPlanIdLines(boardLines, id) : [];
      if (byId.length) {
        if (!landingRowSlug) landingRowSlug = byId[0];
      } else {
        staleMembers.push({ id, rowSlug: rs });
      }
    }
  }
  return { landingRowSlug, staleMembers };
}

// plan 1364 Ship 3: batch analogue of boardRemoveIdempotent. ONE multi-remove coordWrite
// (`board.mjs remove <slug1> <slug2> …`) instead of N single-slug calls — one commit for the
// whole batch's board cleanup. board.mjs's multi-remove (board-lib.removeRows) never throws
// "row not found" — it removes whichever rows are present and tolerates the rest (a batch
// close-out re-invoke after a partial prior run finds some/all rows already gone) — so this
// wrapper only needs coordStep's retry-on-foreign-dirt / coordContention-propagation, the SAME
// choke point every other bookkeeping shell-out in this file uses. `rowSlugs` is the list of
// board row slugs (basename-derived, NOT plan ids — see closeOutBatch) for every member still
// resolvable; a member that resolves to nothing (genuinely missing plan file) contributes no
// row slug — its ARCHIVE_UNRESOLVED seam fires later, in the archive loop.
// plan 1364 review R1 (F2, CONFIRMED): board.mjs's tolerant multi-remove (removeRows) only
// engages when MORE than one slug is passed on the CLI — exactly ONE remaining member routes
// to board.mjs's single-slug branch (the original `removeRow`, which THROWS on an
// already-removed row). A 2-member batch close-out that halts mid-run (e.g. one member trips
// ARCHIVE_UNRESOLVED right after both board rows were already removed+committed) then has
// exactly one resolvable row slug on re-invoke — crashing here instead of completing the
// halt-recovery cleanly. Mirror boardRemoveIdempotent's (single-plan) own fix via the SHARED
// boardRemoveIdempotentRows helper (plan 1364 review R2, R2-2): swallow ONLY the benign "row
// not found" via the SAME isRowAbsentError semantic, rethrow anything else. board.mjs's own
// external contract is UNCHANGED — a bare `board.mjs remove <slug>` from any OTHER caller
// still throws on an unknown slug; this catch lives here, in the caller, not there.
// Exported for a direct real-git-fixture test (mirrors archiveBatchMembers).
export function boardRemoveIdempotentBatch(state, rowSlugs) {
  if (!rowSlugs.length) return;
  boardRemoveIdempotentRows(
    state,
    rowSlugs,
    `board remove batch ${state.slug} (${rowSlugs.length} rows)`,
  );
}

// plan 1364 Ship 3: resolve + archive EVERY manifest member (or disposition it
// already-archived / reparked-skipped), promoting each archived member's waiting-blocked/
// dependents — PURELY local git (movePlanFileIdempotent / promoteWaitingBlocked never push), no
// other-script subprocess. Extracted out of closeOutBatch so it is directly unit-testable
// against a plain local temp repo (mirrors the promoteWaitingBlocked idiom exactly — no bare
// origin needed). A genuinely-missing member fires the SAME ARCHIVE_UNRESOLVED seam the
// single-plan path uses (emitSeam → process.exit), named per-member — NOT covered by a direct
// unit test for that reason (see done-worktree.test.mjs). Exported.
// plan 1364 review R1 (F6): `planIndex` is the OPTIONAL pre-built `L.buildPlanIdIndex(lsPlans,
// members)` map — closeOutBatch builds it ONCE and passes it here (and reuses it for
// rowSlugOf) instead of each call site independently re-scanning the whole `lsPlans` listing
// via resolvePlanRelById. Falls back to building it locally (from `lsPlans`) so the direct
// unit tests below — which call this with only 3 args — are unaffected.
// @returns {{dispositions: object[], archivedBases: string[], archivedSrcs: string[], promotedMoves: string[]}}
export function archiveBatchMembers(MAIN, state, lsPlans, planIndex) {
  const D = landDeps();
  const index = planIndex || D.L.buildPlanIdIndex(lsPlans, state.batch.manifest.members);
  const dispositions = [];
  const archivedBases = [];
  const archivedSrcs = [];
  const promotedMoves = [];

  for (const id of state.batch.manifest.members) {
    const rec = index.get(String(id));
    const src = rec ? rec.live : null;
    if (src) {
      const srcFolder = src.split('/')[3]; // docs/superpowers/plans/<folder>/<basename>
      // plan 3960 review fix: the CONFIGURED-lane predicate (build-index-lib.mjs's isWaitingFolder)
      // — a renamed lanes.waiting* folder used to fail this literal `startsWith('waiting-')` test
      // and be archived here instead of skipped as reparked-skipped.
      if (typeof srcFolder === 'string' && D.buildIndexLib.isWaitingFolder(srcFolder)) {
        // Re-parked mid-train (an operator/reviewer moved it back to a waiting-* gate after
        // the batch claim projected it into in-progress/) — do NOT archive it; the close-out
        // for the REST of the batch still proceeds. Its claim ref should already be released
        // (release-claim runs for every member in releaseClaimAfterMerge regardless); surface
        // a warning so a genuinely-leaked ref is visible without blocking the land.
        dispositions.push({ id, disposition: 'reparked-skipped', path: src });
        (state.teardownErrors ||= []).push(
          `batch member ${id}: re-parked in ${srcFolder}/ mid-train — NOT archived by this close-out. ` +
            `Verify its refs/claims/${id} lock is released (reconcile-board heals a leak).`,
        );
        continue;
      }
      // plan 1364 review R2 (R2-5): `base` is `src.split('/').pop()` where `src` is already
      // confirmed truthy (the `if (src)` a few lines up) and never ends in a trailing slash —
      // it is always a non-empty string, so the `if (base)` guards on both call sites below
      // were dead (always true, added on this branch in Ship 3). Removed; both calls now run
      // unconditionally.
      const base = src.split('/').pop();
      // plan 3960 review fix: ARCHIVE_FOLDER (configured), not a literal 'archive' — matches the
      // single-plan close-out's own dest at closeOutSingle above.
      const arch = `docs/superpowers/plans/${D.buildIndexLib.ARCHIVE_FOLDER}/${base}`;
      // Batch members always archive: a heartbeat plan can never reach here because main()'s
      // batch-detection guard (plan 1329) REFUSES the land before the merge if any member is a
      // heartbeat. So the single-plan closeOutSingle re-file branch is the only heartbeat path.
      movePlanFileIdempotent(MAIN, src, arch);
      D.coordGit.deleteStaleArchiveDups(MAIN, base);
      const planAbs = `${MAIN}/${arch}`;
      if (existsSync(planAbs)) {
        // plan 3971 review r1 (D): the note built below no longer folds in a per-member
        // summary (archiveNotePrefix(state) is prefix-only) — `body` is read for the
        // ✅ COMPLETED stamp only now.
        const body = readFileSync(planAbs, 'utf8');
        if (!D.L.statusAlreadyCompleted(body)) {
          writeFileSync(
            planAbs,
            D.planBodyState.stampArchivedStatus(body, { date: state.date, via: 'done-worktree' }),
          );
        }
      }
      const moves = promoteWaitingBlocked(MAIN, base, state);
      promotedMoves.push(...moves);
      archivedBases.push(base);
      archivedSrcs.push(src);
      dispositions.push({ id, disposition: 'archived', path: arch });
      continue;
    }
    // src is null: either already archived (idempotent re-invoke of an earlier partial run
    // that landed THIS member's rename but crashed before the whole batch committed — cannot
    // happen for a genuinely atomic commit, but resolvable per-member for defense-in-depth) or
    // genuinely missing. resolvedRel distinguishes them, exactly like the single-plan path.
    const archivedRel = rec ? rec.archived : null;
    if (archivedRel) {
      dispositions.push({ id, disposition: 'already-archived', path: archivedRel });
      continue;
    }
    D.spine.emitSeam(
      D.L.SEAM.ARCHIVE_UNRESOLVED,
      `batch ${state.slug}: cannot resolve plan file for member id ${id} under ` +
        `docs/superpowers/plans/ — not in any live status folder nor archive/. The merge already ` +
        `landed; locate/restore the plan file, then re-invoke done-worktree.`,
      state,
    );
  }

  return { dispositions, archivedBases, archivedSrcs, promotedMoves };
}

// plan 1364 Ship 3: the batch close-out — the batch analogue of closeOutSingle above. Every
// manifest member is resolved, archived (or dispositioned already-archived / reparked-skipped),
// its waiting-blocked/ dependents promoted (via archiveBatchMembers), ALL folded into ONE
// close-out commit (one INDEX regen, one manifest delete). Exported (mirrors the
// promoteWaitingBlocked idiom) so a real-git-fixture test can call it directly without driving
// the whole spine.
// plan 1467 archive-on-land (plan 1455 review-fix): stamp a landed batch's batch.md status→landed
// and git-mv it into docs/superpowers/batches/archive/<slug>/batch.md so the batch drops off the
// live roster (batches-view's loadBatchFolders AND claim-plan's candidateBatchSlugs both exclude
// archive/). closeOutBatch deletes the folder's manifest.json separately (git rm), so batch.md is
// all that remains to move. Returns { movedNew, movedOld } (repo-relative paths) for the caller to
// fold into its commit pathspec, or { movedNew: null, movedOld: null } for a grandfathered LEGACY
// batch (manifest at docs/handoff/batches/<slug>.json, no folder) — a graceful no-op. Exported for a
// direct real-git-fixture test (mirrors archiveBatchMembers); real-git only (the DRY close-out
// returns before reaching it).
export function archiveBatchFolder(MAIN, slug) {
  const D = landDeps();
  const src = D.batchPaths.batchMdRel(slug);
  if (!existsSync(`${MAIN}/${src}`)) return { movedNew: null, movedOld: null };
  writeFileSync(
    `${MAIN}/${src}`,
    D.batchPaths.stampBatchStatus(readFileSync(`${MAIN}/${src}`, 'utf8'), 'landed'),
  );
  const dest = `${D.batchPaths.batchArchiveDirRel(slug)}/batch.md`;
  D.coordGit.ensureMvDestDir(MAIN, dest);
  D.spawn.gitMain(MAIN, ['mv', '-f', src, dest]);
  return { movedNew: dest, movedOld: src };
}

function closeOutBatch(MAIN, state) {
  const D = landDeps();
  // `state.batch.manifest === null` means a PRIOR successful close-out commit already deleted
  // the manifest (see main()'s batch detection, which only allows this when the branch is
  // ALREADY LANDED) — every member is archived, every board row gone, INDEX/session already
  // updated. Nothing left to stage; idempotent no-op so a bare re-invoke that crashed only
  // during TEARDOWN can still reach it cleanly.
  if (!state.batch.manifest) {
    state.batch.dispositions = state.batch.dispositions || [];
    return;
  }

  const lsPlans = D.env.DRY
    ? ''
    : D.spawn.run('git', ['-C', MAIN, 'ls-files', 'docs/superpowers/plans']);
  // plan 1364 review R1 (F6): ONE pass over lsPlans building an id→path index, shared by
  // BOTH rowSlugOf (below) and archiveBatchMembers — replaces up to 4 independent
  // resolvePlanRelById re-scans of the full plans listing PER MEMBER with exactly one.
  const planIndex = D.env.DRY ? null : D.L.buildPlanIdIndex(lsPlans, state.batch.manifest.members);
  // Board row slugs are basename-derived (claim-plan.mjs batch's `rowSlug`), NOT plan ids —
  // resolve each member's CURRENT basename (live folder, else archive/) to recover it.
  // plan 1801: ALSO collect each member's planId-keyed board rows — a member renamed while
  // claimed (the execModel Infra↔FABLE stamp) has a row still carrying its claim-time slug,
  // which a basename-only removal misses (tolerant remove → silent orphan row that
  // verifyCloseOutOnOrigin, checking only these slugs, would never catch). Union both keys;
  // removeRows tolerates whichever are absent.
  const rowSlugOf = (id) => D.L.rowSlugFromIndex(planIndex, id);
  // Parse the board ONCE, not per member (review-fix): rowKeysForPlan works on the pre-split
  // lines, mirroring resolveBatchLandingRow's one-time split. Unparseable board → no planId
  // keys (fail-closed); the basename-derived slugs still flow through.
  let boardRowLines = [];
  if (!D.env.DRY) {
    try {
      boardRowLines = D.boardLib.splitBoard(readBoardFile(MAIN).content).body.split('\n');
    } catch {
      boardRowLines = [];
    }
  }
  const rowSlugs = D.env.DRY
    ? state.batch.manifest.members.map((id) => `${id}-batch-member`)
    : [
        ...new Set(
          state.batch.manifest.members.flatMap((id) =>
            D.boardLib.rowKeysForPlan(boardRowLines, id, rowSlugOf(id)),
          ),
        ),
      ];
  // plan 1508: stash the exact row-slug list this close-out believes it removed — closeOut()'s
  // post-push verifyCloseOutOnOrigin reuses it (recomputing from a possibly-already-deleted
  // manifest would not work; this runs BEFORE the manifest is git-rm'd below).
  state.batch.rowSlugs = rowSlugs;

  boardRemoveIdempotentBatch(state, rowSlugs);

  if (D.env.DRY) {
    // Minimal deterministic dry fixture (mirrors the single-plan DRY path's fixed
    // `docs/superpowers/plans/in-progress/${slug}.md` stand-in): every manifest member is
    // treated as a normal in-progress/ archive. Mixed-disposition / idempotent-reinvoke
    // behavior is covered by the real-git closeOutBatch tests, not the dry trace.
    const archivedBases = state.batch.manifest.members.map((id) => `${id}-Batch-member.md`);
    for (const base of archivedBases) {
      D.spawn.gitMain(MAIN, [
        'mv',
        `docs/superpowers/plans/in-progress/${base}`,
        `docs/superpowers/plans/archive/${base}`,
      ]);
    }
    state.planArchived = archivedBases.join(', ');
    state.batch.dispositions = state.batch.manifest.members.map((id) => ({
      id,
      disposition: 'archived',
    }));
    D.spine.regenIndex(MAIN);
    const sf = D.spine.findSessionFile(
      MAIN,
      state.slug,
      D.coordConfig.loadCoordConfig(MAIN).handoffLayout,
    );
    state.sessionN = D.L.sessionNumFromSessionFile(sf);
    // plan 1467: manifest now lives in the batch folder; the DRY fixture has no files on
    // disk (resolveManifestRel would find none), so name the new canonical path for the trace.
    D.spawn.gitMain(MAIN, ['rm', D.batchPaths.newManifestRel(state.slug)]);
    D.spawn.gitMain(MAIN, [
      'commit',
      '-m',
      `docs(plans): done ${state.slug} — batch close-out (${archivedBases.length} members)`,
      '-m',
      `${D.coordGit.COORD_TRAILER}: done-worktree`,
    ]);
    D.spine.pushMaster(MAIN);
    return;
  }

  const batchResult = archiveBatchMembers(MAIN, state, lsPlans, planIndex);
  const { dispositions, archivedBases, archivedSrcs, promotedMoves } = batchResult;
  state.batch.dispositions = dispositions;
  state.planArchived = archivedBases.length ? archivedBases.join(', ') : null;

  // ONE session-entry flip for the whole batch — found via state.slug (the BATCH slug), which
  // batchSessionEntryStub's header + Branch line both carry, so the SAME findSessionFile grep
  // that resolves a single plan's entry resolves the batch's one shared stub.
  const closeCfg = D.coordConfig.loadCoordConfig(MAIN);
  const sf = D.spine.findSessionFile(MAIN, state.slug, closeCfg.handoffLayout);
  if (sf) flipSessionCompleted(MAIN, sf, state);
  else reportUnflippedSessionEntry(state); // plan 2891 T7 — same hand-off as the single-plan path
  state.sessionN = D.L.sessionNumFromSessionFile(sf);

  // ONE INDEX narrative line PER archived member, ONE regen. Plan 3971: the note is
  // prefix-only (archiveNotePrefix(state) — no per-member summary; the archived plan file
  // is where that lives now) with the trailing `— batch <slug> (N members)` tag kept so the
  // batch grouping is still visible from the INDEX row alone.
  const indexAbs = `${MAIN}/docs/INDEX.md`;
  let indexTxt = readFileSync(indexAbs, 'utf8');
  for (const base of archivedBases) {
    const note =
      `${archiveNotePrefix(state)} — batch ${state.slug} ` +
      `(${state.batch.manifest.members.length} members).`;
    indexTxt = D.L.idempotentArchiveIndex(indexTxt, base, note);
  }
  writeFileSync(indexAbs, indexTxt);
  D.spine.regenIndex(MAIN);

  // plan 665 G1.3 belt — same hard-cap-over-CAP-bullets backstop as the single-plan path
  // (shared helper, plan 1364 review R1 F7).
  beltClampArchiveBullets(MAIN);

  // Delete the manifest in the SAME close-out commit (idempotent: absent → nothing to stage).
  // plan 1467: resolve the live path (new folder manifest, or a grandfathered legacy one) so
  // the delete targets wherever the manifest actually is; rel === null ⇒ already gone.
  const { rel: manifestRel } = D.batchPaths.resolveManifestRel(MAIN, state.slug);
  let manifestStaged = false;
  if (manifestRel) {
    D.spawn.gitMain(MAIN, ['rm', '--', manifestRel]);
    manifestStaged = true;
  }

  // plan 1467 archive-on-land (plan 1455 review-fix): stamp a NEW-format batch's batch.md
  // status → landed and git-mv the folder into the archive subtree, IN THIS SAME close-out commit,
  // so the landed batch leaves the live roster (see archiveBatchFolder). The `git add` of the NEW
  // path (in `stage`) captures the stamped content on top of the rename; the OLD path rides
  // `renameOldPaths` as the rename's deletion side. A grandfathered LEGACY batch has no folder → a
  // graceful no-op (both null).
  const { movedNew: batchMdMovedNew, movedOld: batchMdMovedOld } = archiveBatchFolder(
    MAIN,
    state.slug,
  );

  const archivedArchPaths = archivedBases.map((b) => `docs/superpowers/plans/archive/${b}`);
  const stage = [
    sf,
    ...archivedArchPaths,
    'docs/INDEX.md',
    ...promotedMoves,
    batchMdMovedNew,
  ].filter(Boolean);
  // The pathspec also carries the rename OLD-paths (each archived `git mv` + each promotion
  // `git mv` + the batch.md archive `git mv` stages a deletion at the source, not present in
  // `stage`) AND the manifest's own path (already staged as a deletion by `git rm` above, not by
  // `git add`).
  const renameOldPaths = [
    ...archivedSrcs,
    ...(state.promotedOldPaths || []),
    ...(manifestStaged ? [manifestRel] : []),
    batchMdMovedOld,
  ].filter(Boolean);
  const commitPaths = [...stage, ...renameOldPaths];
  D.spawn.gitMain(MAIN, ['add', ...stage]);
  // Idempotent re-invoke tolerance — same "nothing staged" skip as the single-plan path.
  if (D.spine.hasStagedChanges(MAIN, commitPaths)) {
    const archivedCount = dispositions.filter((d) => d.disposition === 'archived').length;
    try {
      D.spawn.gitMain(
        MAIN,
        [
          'commit',
          '-m',
          `docs(plans): done ${state.slug} — batch close-out (${archivedCount} archived, ${state.batch.manifest.members.length} members)`,
          '-m',
          `${D.coordGit.COORD_TRAILER}: done-worktree`,
          '--',
          ...commitPaths,
        ],
        { env: { HUSKY: '0' } },
      );
    } catch (e) {
      const msg = `${e.stderr || ''}${e.message || ''}`;
      if (!(D.L.isNothingToCommit(msg) && D.spine.closeOutCommitAtHead(MAIN, state.slug))) throw e;
    }
    D.spine.pushMaster(MAIN);
  }
}

// Mint each `→ open new plan` carry-forward bullet as a real plan via the SAME
// race-safe two-step the drain uses (plan 388): `next-plan-id.mjs claim` reserves
// an id + writes the file to pending-approval/ (the default — and, since plan 1419,
// ONLY — mint target; no `--ready` flag is ever passed here, plan 1371 D2 forbids an
// unspecced `--ready` mint) + adds the INDEX bullet + commits + pushes. EVERY mint
// rests in pending-approval/ now — a legacy `(ready)` bullet token no longer parks
// the stub anywhere else or skips anything; it only earns a one-line land-report
// warning (state.legacyReadyMints) that the flag is retired. next-plan-id.mjs
// self-pushes with non-ff recovery, so this carries no bespoke git. A failure to
// mint ONE bullet is recorded + skipped — it NEVER throws (the bullets survive in
// the handoff entry for manual recovery, so a flaky mint degrades, it doesn't abort
// the land). Populates state.newPlans (consumed by formatReport's "New plans
// opened:" line).
function mintCarryForwards(MAIN, state, autoBullets) {
  const D = landDeps();
  mintCarryForwardItems(MAIN, state, D.L.carryForwardMints(autoBullets));
}

// plan 629: the minting loop, factored out of mintCarryForwards so BOTH the decided
// `→ open new plan` bucket (carryForwardMints) and the auto-deferred ambiguous bucket
// (ambiguousCarryForwardMints, --carryforward-defer) file stubs through the same
// race-safe two-step. `mints` is the pre-formed {title, mutation, ready} list.
function mintCarryForwardItems(MAIN, state, mints) {
  const D = landDeps();
  if (!mints.length) return;
  const tmpDir = `${MAIN}/output`;
  if (!D.env.DRY) mkdirSync(tmpDir, { recursive: true }); // once, not per-bullet
  // plan 665 G2: snapshot the tracked plan files ONCE so the per-item idempotency check
  // (carryForwardAlreadyFiled) doesn't re-shell `git ls-files` per bullet. A stub minted
  // earlier in THIS loop is absent from the snapshot, but each item has a distinct slug so
  // it can never false-match a later item; the snapshot's only job is detecting stubs filed
  // by a PRIOR (interrupted) close-out run.
  const planFiles = D.env.DRY
    ? []
    : D.spawn
        .run('git', ['-C', MAIN, 'ls-files', 'docs/superpowers/plans'])
        .split('\n')
        .filter(Boolean);
  for (let i = 0; i < mints.length; i++) {
    const item = mints[i];
    const slug = D.drainRun.carryForwardSlug(item.title);
    const blurb = item.title.replace(/\s+/g, ' ').trim().slice(0, 160) || 'carry-forward';
    // plan 665 G2: skip a (parent, title) carry-forward a prior interrupted close-out
    // already filed — re-running closeOut must file the un-minted remainder, never a duplicate.
    if (
      !D.env.DRY &&
      D.L.carryForwardAlreadyFiled({
        files: planFiles,
        readBody: (rel) => readFileSync(`${MAIN}/${rel}`, 'utf8'),
        parentSlug: state.slug,
        itemSlug: slug,
      })
    ) {
      (state.carryForwardsSkipped ||= []).push(item.title);
      continue;
    }
    if (D.env.DRY) {
      // representative dry trace — keeps next-plan-id claim greppable. Plan 1419: no
      // move-plan park call — every mint rests where the claim above already put it
      // (pending-approval/); a legacy `(ready)` token only earns a report warning below.
      D.spawn.node(
        'next-plan-id.mjs',
        'claim',
        '--category',
        'Other',
        '--slug',
        slug,
        '--body',
        `<tmp:${slug}>`,
        '--blurb',
        blurb,
        D.buildIndexLib.MUTATION_BANNER_FLAG,
        item.mutation,
        '--date',
        state.date,
      );
      if (item.ready) (state.legacyReadyMints ||= []).push(item.title);
      state.newPlans.push(`<id>-Other-${slug}.md`);
      continue;
    }
    const tmpFile = `${tmpDir}/.spine-carryforward-${state.slug}-${i}.md`;
    try {
      writeFileSync(tmpFile, spineCarryForwardBody(blurb, item, state));
      const out = D.spawn.node(
        'next-plan-id.mjs',
        'claim',
        '--category',
        'Other',
        '--slug',
        slug,
        '--body',
        tmpFile,
        '--blurb',
        blurb,
        D.buildIndexLib.MUTATION_BANNER_FLAG,
        item.mutation,
        '--date',
        state.date,
      );
      // next-plan-id prints the bare id to stdout (its message goes to stderr). SCAN
      // for the id line (not blindly the last line); \d{3,} future-proofs past 999.
      const id = out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^\d{3,}$/.test(l))
        .pop();
      if (!id)
        throw new Error(
          `next-plan-id claim returned no id (stdout: ${JSON.stringify(out.trim())})`,
        );
      // plan 1419: no move-plan park call — the claim above already left the stub
      // resting in pending-approval/, which is where EVERY mint now rests. A legacy
      // `(ready)` bullet token no longer moves it; it only earns a report warning.
      if (item.ready) (state.legacyReadyMints ||= []).push(item.title);
      state.newPlans.push(`${id}-Other-${slug}.md`);
    } catch (e) {
      (state.mintErrors ||= []).push(`mint "${item.title}": ${e.message || e}`);
    } finally {
      try {
        if (existsSync(tmpFile)) rmSync(tmpFile, { force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
}

// The minted stub body. Mirrors the drain's renderCarryForwardPlanBody (plan 388)
// core-noun-ok: names a drain-run.mjs function this module cannot rename from core
// but is local so the spine owns its own provenance prose. `summary:` frontmatter is
// the EXACT `--blurb` passed to claim (the INDEX bullet is derived from it — they
// must match or build-index --check breaks). Carries parseable mutation (under the
// configured banner label, not a hardcoded name) + $0 Cost banners (so a later
// `move-plan <id> ready` release stays lint-clean) and an honest
// pending-approval/ Status line + trip-condition. Plan 1419: EVERY carry-forward
// mint rests here now — there is no waiting-operator park branch, and a legacy
// `(ready)` bullet token no longer changes the Status line, the trip-condition, or
// `dest` (only mintCarryForwardItems' land-report warning notices the token). Exported
// (plan 1419) so tests can assert on the produced body text directly, the same
// direct-import pattern archiveBatchMembers/boardRemoveIdempotentBatch already use.
export function spineCarryForwardBody(blurb, item, state) {
  const D = landDeps();
  const banner =
    item.mutation === 'yes'
      ? `> 🟥 **${D.buildIndexLib.MUTATION_BANNER_LABEL}: YES** — auto-extracted stub; confirm the real ${D.buildIndexLib.MUTATION_BANNER_LABEL} status at triage.`
      : `> 🟩 **${D.buildIndexLib.MUTATION_BANNER_LABEL}: NO** — auto-extracted stub; confirm the real ${D.buildIndexLib.MUTATION_BANNER_LABEL} status at triage.`;
  // plan 1419: `dest` is now a constant — next-plan-id.mjs claim (no --ready flag is
  // ever passed here) always leaves the stub resting in pending-approval/, a
  // legitimate resting spot per plan 1371 D4, not a stranding.
  const dest = 'pending-approval/';
  const trip =
    'Confirm scope, run a spec-pass (or board-pass) to promote it, then ' +
    '`node scripts/move-plan.mjs <id> ready` to release it to the drain.';
  return [
    '---',
    `summary: ${blurb}`,
    '---',
    '',
    banner,
    '> 💰 **Cost forecast:** $0 (stub — scoping only). Operator sets the real forecast at triage.',
    '',
    `# ${blurb}`,
    '',
    `**Status:** 🧺 PENDING-APPROVAL — auto-extracted by the done-worktree landing spine on ${state.date}.`,
    '',
    'Auto-extracted `→ open new plan` carry-forward from the done-worktree landing spine ' +
      `(plan 406), emitted in the worktree handoff entry while landing \`${state.slug}\`. This is a ` +
      "**stub**: it carries the follow-up's intent, not vetted steps or a real cost forecast. " +
      `Filed to \`${dest}\`.`,
    '',
    '## Trip-condition',
    '',
    trip,
    '',
    // plan 665 G2: idempotency provenance. A close-out interrupted after the merge push
    // but before/during the mint re-runs the WHOLE close-out; this marker (parent slug)
    // lets carryForwardAlreadyFiled detect an already-filed stub and skip re-minting it.
    // An HTML comment so it is invisible to build-index / lint-board / the banners and
    // survives verbatim into archive/. Keyed (parentSlug, itemSlug) — see the helper.
    `<!-- ${D.L.CARRY_FORWARD_MARKER}: ${state.slug} -->`,
    '',
  ].join('\n');
}

// 6b: scan waiting-blocked/ for plans now unblocked by THIS land — every named
// plan-blocker (by bare id, the real `**Blocked-by:**` convention) has archived.
// `promotable` (no other gate) → git mv to ready/; `review` (a non-plan gate also
// remains) → surfaced in the report, not moved. Returns the staged ready/ paths
// (folded into the close-out commit). plan 569: the prior full-filename grep +
// `Blocked-by-plan:` regex never matched a real plan, so this never fired (484).
export function promoteWaitingBlocked(MAIN, archivedBase, state, { writeText } = {}) {
  const D = landDeps();
  // plan 3961 T3.1: the default can no longer sit in the parameter list itself — default
  // parameter expressions evaluate before the function body runs, and `D` (from `landDeps()`)
  // does not exist yet at that point. Resolved here instead, immediately after `D` is bound;
  // behavior is unchanged (a caller-supplied `writeText` still wins, exactly as before).
  if (writeText === undefined) writeText = D.atomicWrite.atomicWriteTextSync;
  if (D.env.DRY) return [];
  // `\d{3,}` throughout this fn so a 4-digit plan id (1000+) is parsed in full, not
  // truncated to its first 3 digits — else landing a 4-digit plan computes a wrong
  // archivedId and skips 4-digit waiting-blocked plans from auto-promotion (plan 1002).
  const archivedId = (archivedBase.match(/^(\d{3,})/) || [])[1];
  if (!archivedId) return [];

  // id → status-folder map from the (staged) index. The just-archived plan's
  // `git mv … archive/` was staged above, so statusOf(archivedId) === 'archive' here.
  let tracked;
  try {
    tracked = D.spawn
      .run('git', ['-C', MAIN, 'ls-files', 'docs/superpowers/plans'])
      .split('\n')
      .filter(Boolean);
  } catch {
    return []; // no plans tree
  }
  const statusMap = new Map();
  // plan 1836: id -> tracked rel path, so an id that resolves to 'archive' can have its
  // content lazily read (via isShipped below) without a second corpus scan.
  const relById = new Map();
  for (const rel of tracked) {
    // `(?=[A-Za-z])`: only an `NNN-Category-…` plan mints an id key, so a legacy full-date
    // plan (`2026-05-17-…`) does not create a phantom "2026" key that would ground a bare
    // year in a Blocked-by line as a real blocker (plan 1002).
    const m = rel.match(/^docs\/superpowers\/plans\/([^/]+)\/(\d{3,})-(?=[A-Za-z])[^/]*\.md$/);
    if (m) {
      statusMap.set(m[2], m[1]);
      relById.set(m[2], rel);
    }
  }
  const statusOf = (id) => statusMap.get(id) ?? null;
  // plan 1836: an archived blocker only counts as CLEARED when its body carries the
  // ✅ COMPLETED stamp (archive/ alone holds "shipped OR closed" plans — see
  // blocked-by-lib.mjs's classifyBlocked doc). Lazy + memoized: reads at most one file
  // per referenced-and-archived blocker id, not the whole archive/ tree.
  const isShipped = D.blockedByLib.makeArchiveIsShipped(relById, (rel) =>
    readFileSync(`${MAIN}/${rel}`, 'utf8'),
  );

  const candidates = tracked.filter(
    (r) => r.startsWith('docs/superpowers/plans/waiting-blocked/') && /\/\d{3,}-[^/]*\.md$/.test(r),
  );

  // Review fix (plan 3111, round-1 finding 18 then round-2 findings 4/14 — all CONFIRMED):
  // resolve origin's execution branches ONCE for the whole promotion pass, not once per
  // promoted plan (N blocking `ls-remote` calls at a 20s timeout each, inside the close-out
  // spine), and resolve them LAZILY — on the first plan that actually reaches the promotion,
  // not merely because `waiting-blocked/` is non-empty. Round 1 keyed on `candidates.length`,
  // which made every land with ANY waiting-blocked file pay the round trip even when each one
  // is unrelated to the archived plan, review-held or banner-held and nothing is promoted.
  //
  // Memoized across the loop via `resolved`, so a pass that promotes several plans still reads
  // origin once. Shared with syncAdoptBranchStamp through its ONE `lsRemote` seam (round-2
  // finding 14 removed the second `branchMap` input). A throw can never reach the spine:
  // `null` propagates as "origin unreadable", which STRIPS NOTHING.
  let adoptBranchMap = null;
  let adoptBranchResolved = false;
  const adoptBranchLsRemote = () => {
    if (!adoptBranchResolved) {
      adoptBranchResolved = true;
      try {
        adoptBranchMap = D.queueDrain.originExecutedPlanIds(MAIN);
      } catch (e) {
        adoptBranchMap = null;
        process.stderr.write(
          `done-worktree: WARNING — could not read origin's execution branches for the ` +
            `adoptBranch sync (${e.message || e}); promoted plans keep their stamps as-is.\n`,
        );
      }
    }
    return adoptBranchMap;
  };

  const moved = [];
  for (const rel of candidates) {
    let baseName = rel.split('/').pop();
    const selfId = (baseName.match(/^(\d{3,})/) || [])[1] || null;
    const body =
      D.spine.tryStep(state, `read ${rel}`, () => readFileSync(`${MAIN}/${rel}`, 'utf8')) || '';
    // plan 2446: a **Blocked-by:** line parked inside a close-out tail is never
    // counted toward classifyBlocked's blocker set below (the tail rule is skip,
    // not gate) — but the unsafe direction (an author mistakenly parking the plan's
    // REAL blocker there) must not be silent. Printed on every pass this plan is
    // still in waiting-blocked/, regardless of which blocker this particular land
    // just archived, so it keeps surfacing until the author fixes it.
    const tailSkipped = D.blockedByLib.tailOnlyBlockedByLines(body);
    if (tailSkipped.length) {
      (state.tailBlockedBySkipped ||= []).push(baseName);
      process.stderr.write(
        `done-worktree: NOTE — ${baseName} has a **Blocked-by:** line inside a close-out-tail ` +
          `section, NOT counted toward its drainable body's blocker set (plan 2446): ` +
          `${tailSkipped.join('; ')}\n`,
      );
    }
    const c = D.L.classifyBlocked(body, statusOf, selfId, isShipped);
    // only act on a plan whose dependency set actually INCLUDES the plan we just
    // archived — otherwise an unrelated land would re-promote it on every pass.
    if (!c.ids.includes(archivedId)) continue;
    // plan 3975 ruling (operator, 2026-09-12): "unblocked" is kind 'review' OR
    // 'promotable' — both mean every named plan-blocker is archived-and-shipped
    // (classifyBlocked's own doc). Neither kind sleeps in waiting-blocked/ any longer;
    // where it goes next depends on ONE thing — is it specced? — never on `c.gate`
    // (a non-plan gate word surviving in the Blocked-by line no longer parks a
    // SPECCED plan here at all; see the ready/-gate branch below).
    if (c.kind !== 'review' && c.kind !== 'promotable') continue;
    // "Specced" is the SAME predicate move-plan <id> ready's own promotion gate uses
    // (specReviewGateError): `stage: specced` passes, `specReview: exempt-mechanical`
    // passes, a missing `stage:` key at all passes (the grandfather clause for a
    // legacy pre-plan-1292 plan), and only an explicit `stage: stub` with no
    // specReview stamp fails. A non-null return here means NOT specced.
    if (D.buildIndexLib.specReviewGateError(baseName, body, 'done-worktree')) {
      // plan 1371 D7: pending-approval/ is the folder an un-reviewed stub rests in —
      // not another sleep in waiting-blocked/. A spec-pass or the operator's approval
      // is this plan's exit from here, same as a fresh mint. Strike the stale
      // Blocked-by line through IN PLACE (never drop it outright — the struck line is
      // the audit trail of what this plan was waiting on) and note the clearance.
      const paDest = `docs/superpowers/plans/pending-approval/${baseName}`;
      D.spine.tryStep(state, `park ${baseName} in pending-approval`, () => {
        // Review round 2: this arm deliberately matches the sibling ready/ arm's move
        // idiom below (plain ensureMvDestDir + gitMain(['mv', …]), no `-f`) instead of
        // movePlanFileIdempotent — that helper's `-f` is documented (its own header
        // comment) as the archive/heartbeat mover's tolerance for a leftover UNTRACKED
        // destination copy from a crashed prior run, with a restore-move half-state
        // healer this route does not need. Worse, `-f` would silently OVERWRITE a
        // TRACKED file already at the destination, where a plain `git mv` fails safely
        // — and a tracked file already at pending-approval/<baseName> here means a
        // duplicate-plan board violation that must fail loudly, not be clobbered.
        //
        // review fix F4: the Status line must be rewritten too, same as the sibling
        // --respec feature (move-plan.mjs's respecToPendingApproval) — otherwise the
        // moved file still reads its stale waiting-blocked **Status:** line after
        // landing in pending-approval/, leaving the branch internally inconsistent.
        //
        // Review round 2 (R2-3): the new body is computed HERE, before the move — pure
        // string work, so a throw during computation aborts this whole tryStep callback
        // (nothing below it runs: no move, no `moved.push`) rather than leaving the plan
        // already re-filed with a stale or half-written body. The disk WRITE stays AFTER
        // the move (same as the sibling ready/ arm, and for the same reason: it must land
        // at `paDest`, which the pathspec-scoped close-out commit already names) — only a
        // genuine disk-write failure can still fall in that post-move window.
        const newBody = D.planBodyState.setStatusLine(
          D.blockedByLib.rewriteFirstBlockedByLine(
            body,
            (oldLine) =>
              `~~${oldLine}~~ CLEARED ${state.date} — last plan-blocker ${archivedId} ` +
              `landed (\`${state.mergeSha}\`); awaiting spec-pass`,
          ),
          `**Status:** 📋 STUB — re-filed waiting-blocked→pending-approval ${state.date} ` +
            `(last plan-blocker ${archivedId} landed).`,
        );
        if (!D.env.DRY) D.coordGit.ensureMvDestDir(MAIN, paDest);
        D.spawn.gitMain(MAIN, ['mv', rel, paDest]);
        if (!D.env.DRY) {
          try {
            writeText(`${MAIN}/${paDest}`, newBody);
          } catch (e) {
            process.stderr.write(
              `done-worktree: WARNING — moved ${baseName} to pending-approval/ but could not ` +
                `rewrite its Blocked-by line (stale line may survive): ${e.message || e}\n`,
            );
          }
        }
        moved.push(paDest);
        (state.promotedOldPaths ||= []).push(rel);
        (state.promotedToPending ||= []).push(baseName);
        // Review round 2 (R2-4): printed on the SUCCESS path only, from inside the
        // tryStep callback — it used to sit OUTSIDE tryStep and fire unconditionally,
        // announcing a completed move even when tryStep had swallowed a failure above.
        process.stderr.write(
          `done-worktree: unblocked but not specced — moved ${baseName} from waiting-blocked/ ` +
            `to pending-approval/ (last plan-blocker ${archivedId} landed); awaiting a spec-pass.\n`,
        );
      });
      continue;
    }
    // Specced (or exempt-mechanical): run the SAME two ready/ gates move-plan <id>
    // ready enforces — unchanged from before this plan (plan 1276 / 2943+2944 F6) —
    // just gated on being SPECCED now, rather than on `c.kind` alone (the looseness
    // the defect this plan fixes calls out: this close-out path used to promote a
    // `stage: stub` plan straight to ready/ with no spec-review check at all).
    //
    // plan 1276: a plan lacking a parseable 💰 Cost forecast banner is STILL not
    // ready/. Promoting a bannerless plan here re-arms the exact incident plan 1260
    // was filed to kill: the autonomous drain then PAUSES on it (cost.unknown) and
    // lint-plan-cost-forecast hard-blocks the NEXT session's push — a session that
    // neither authored nor promoted it (bit 3× on 2026-07-01/02: plans 1222 / 286 /
    // 1228). Route it through the SAME shared readyCostBannerError composer (intro +
    // help) so this warning can never drift from the movers' rejection. WARN, never
    // THROW: a throw here would abort the done-worktree close-out spine MID-LAND (the
    // failure mode this must avoid).
    const bannerErr = D.planCostBanner.readyCostBannerError(
      baseName,
      body,
      `done-worktree: WARNING — NOT auto-promoting ${baseName} from waiting-blocked/ to ready/: ` +
        `its last plan-blocker archived, but it carries no parseable 💰 Cost forecast banner.`,
    );
    // Review fix round (2943+2944, F6): mirrors the bannerErr check immediately above —
    // a Pipe/DQ/App/UI plan stamped `evidence: latent` must not be auto-promoted to
    // ready/ here either (2943's acceptance names this gate for EVERY route into
    // ready/, and this close-out promoter is one). WARN, never THROW:
    // assertEvidenceFloorOk throws a `fatal`-tagged Error on a violation; caught and
    // downgraded to a warning so a held promotion can never abort the close-out spine
    // mid-land.
    //
    // Review fix F5: evaluated UNCONDITIONALLY — never short-circuited behind `!bannerErr`
    // — so a plan failing BOTH gates has both named below, instead of the evidence-floor
    // failure being silently swallowed whenever the banner also happened to be missing.
    let evidenceErr = null;
    try {
      // plan 4071 (T2/D1): evidenceGated now comes from coord.config.json's
      // planCategories.evidenceGated (the removed EVIDENCE_GATED_CATEGORIES literal) —
      // resolved here so this close-out promoter stays byte-identical to before the move.
      D.buildIndexLib.assertEvidenceFloorOk(
        D.buildIndexLib.READY_FOLDER,
        body,
        baseName,
        D.coordConfig.loadCoordConfig(MAIN).planCategories.evidenceGated,
        'done-worktree',
      );
    } catch (e) {
      evidenceErr = e.message || String(e);
    }
    if (bannerErr || evidenceErr) {
      // plan 3975 ruling: either ready/-gate failing on a SPECCED plan is an operator
      // matter, not a reason to leave it asleep in waiting-blocked/ — park it in
      // waiting-operator/ instead, naming the failed gate right in the Blocked-by line
      // so the next look explains itself without re-deriving it from stderr history.
      if (bannerErr) process.stderr.write(`${bannerErr}\n`);
      if (evidenceErr)
        process.stderr.write(
          `done-worktree: WARNING — NOT auto-promoting ${baseName} from waiting-blocked/ to ` +
            `ready/: ${evidenceErr}\n`,
        );
      // Review fix F5: name EVERY failed gate, not just whichever was checked first.
      const gateParts = [];
      if (bannerErr) gateParts.push('missing a parseable 💰 Cost forecast banner');
      if (evidenceErr) gateParts.push('evidence: latent (evidence-floor gate)');
      const gateText = gateParts.join(' AND ');
      // Review fix F1 (the strongest signal, 7 of 22 findings): move-plan.mjs
      // HARD-REFUSES a waiting-operator/ target with no `unblock: manual|decision`
      // frontmatter field (its OPERATOR_UNBLOCK gate), and waiting-operator-status.mjs
      // buckets an unmarked plan as ❓ — this park must stamp the marker in the SAME
      // write, using the shared setUnblock (plan-body-state.mjs), rather than produce
      // the exact misfile move-plan.mjs's own gate exists to refuse. `manual` for a
      // purely mechanical cost-banner gap (someone just has to add a banner); `decision`
      // for the evidence-floor gate, a genuine judgment call (fold to a line vs. upgrade
      // the class) — and `decision` DOMINATES when both gates fail, since the judgment
      // call is the harder of the two holds.
      const unblockValue = evidenceErr ? 'decision' : 'manual';
      const opDest = `docs/superpowers/plans/waiting-operator/${baseName}`;
      D.spine.tryStep(state, `park ${baseName} in waiting-operator`, () => {
        // Review round 2: this arm deliberately matches the sibling ready/ arm's move
        // idiom below (plain ensureMvDestDir + gitMain(['mv', …]), no `-f`) instead of
        // movePlanFileIdempotent — that helper's `-f` is documented (its own header
        // comment) as the archive/heartbeat mover's tolerance for a leftover UNTRACKED
        // destination copy from a crashed prior run, with a restore-move half-state
        // healer this route does not need. Worse, `-f` would silently OVERWRITE a
        // TRACKED file already at the destination, where a plain `git mv` fails safely
        // — and a tracked file already at waiting-operator/<baseName> here means a
        // duplicate-plan board violation that must fail loudly, not be clobbered.
        //
        // Review round 2 (R2-2): stamp the Status line via the SAME shared helper
        // drain-run.mjs's parkToWaitingOperator already uses for this exact purpose
        // (plan-body-state's stampWaitingOperatorStatus) — otherwise this park leaves
        // the moved body's Status line stale, unlike the sibling pending-approval arm
        // above, which already rewrites its own Status line via setStatusLine.
        //
        // Review round 2 (R2-3): the new body is computed HERE, before the move — pure
        // string work, so a throw during computation aborts this whole tryStep callback
        // (nothing below it runs: no move, no `moved.push`) rather than leaving the plan
        // already re-filed WITHOUT the mandatory `unblock:` marker waiting-operator/
        // requires. The disk WRITE stays AFTER the move (same as the sibling ready/ arm,
        // and for the same reason: it must land at `opDest`, which the pathspec-scoped
        // close-out commit already names) — only a genuine disk-write failure can still
        // fall in that post-move window.
        const newBody = D.planBodyState.setUnblock(
          D.planBodyState.stampWaitingOperatorStatus(
            D.blockedByLib.rewriteFirstBlockedByLine(
              body,
              () =>
                `**Blocked-by:** ${gateText} (last plan-blocker ${archivedId} landed ${state.date})`,
            ),
            { date: state.date, reason: gateText },
          ),
          unblockValue,
        );
        if (!D.env.DRY) D.coordGit.ensureMvDestDir(MAIN, opDest);
        D.spawn.gitMain(MAIN, ['mv', rel, opDest]);
        if (!D.env.DRY) {
          try {
            writeText(`${MAIN}/${opDest}`, newBody);
          } catch (e) {
            process.stderr.write(
              `done-worktree: WARNING — moved ${baseName} to waiting-operator/ but could not ` +
                `rewrite its Blocked-by line (stale line may survive): ${e.message || e}\n`,
            );
          }
        }
        moved.push(opDest);
        (state.promotedOldPaths ||= []).push(rel);
        (state.promotedToOperator ||= []).push(baseName);
        // Review round 2 (R2-4): printed on the SUCCESS path only, from inside the
        // tryStep callback — it used to sit OUTSIDE tryStep and fire unconditionally,
        // announcing a completed move even when tryStep had swallowed a failure above.
        process.stderr.write(
          `done-worktree: WARNING — moved ${baseName} from waiting-blocked/ to waiting-operator/ ` +
            `instead of ready/: ${gateText}.\n`,
        );
      });
      continue;
    }
    // Plan 2973: THIRD arm, deliberately WARN-AND-PROMOTE — unlike the two arms above, this
    // one never parks the plan. An absent `cloudExec:` stamp breaks nothing downstream (the
    // plan still drains locally, queue-drain.mjs --cloud simply excludes it), whereas a throw
    // here — or holding it back like the banner/evidence arms — would abort a LAND MID-FLIGHT
    // over a bookkeeping gap that costs nothing to fix later with one stamp command. So: print
    // the same shared warning to stderr, do NOT push to a `state.promote*Pending` list, do NOT
    // `continue` — execution falls straight through to the promotion below.
    const cloudExecWarn = D.buildIndexLib.cloudExecUnstampedWarning(baseName, body);
    if (cloudExecWarn) process.stderr.write(`done-worktree: WARNING — ${cloudExecWarn}\n`);
    // plan 3468: writer 3 of 3 into ready/ must apply plan 3461's Sol-default ruling too;
    // plan 3463 closed the two interactive writers, while this close-out path still let an
    // exempt-mechanical plan enter ready/ without either half of the body/filename pairing.
    const promotedBody = D.execModelStamp.ensureExecModelForExemptMechanical(body);
    const unstampedDest = `docs/superpowers/plans/ready/${baseName}`;
    let dest = unstampedDest;
    try {
      dest = D.execModelStamp.stampedRelForExecModel(unstampedDest, promotedBody) || unstampedDest;
    } catch (e) {
      process.stderr.write(
        `done-worktree: WARNING — could not stamp the promoted filename for ${baseName}; ` +
          `using its unstamped ready/ destination (${e.message || e}).\n`,
      );
    }
    baseName = dest.split('/').pop();
    D.spine.tryStep(state, `promote ${baseName}`, () => {
      // plan 1452/1475 (item 2): git mv does NOT create the destination directory; a status lane
      // with zero files in it (a fresh sibling's ready/) is absent from the checkout. coord-git's
      // shared ensureMvDestDir mkdirs it first (recursive, idempotent) — no-op in DRY mode since
      // gitMain's own DRY branch never touches the real filesystem there.
      if (!D.env.DRY) D.coordGit.ensureMvDestDir(MAIN, dest);
      D.spawn.gitMain(MAIN, ['mv', rel, dest]);
      // plan 2378 step 4: apply the SAME body treatment move-plan's promote path applies
      // (plan-body-state's stampPromotedStatus → dropBlockedBy + a promoted Status line).
      // Until now this close-out promoter re-filed a waiting-blocked/ dependent as a pure
      // R100 rename with no body rewrite, so the two promotion paths disagreed about body
      // hygiene and a plan promoted THIS way kept a now-dead **Blocked-by:** line in
      // ready/ — 2358 after 2357 archived, same day (2026-07-25). Functionally tolerated
      // (queue-drain's staleBlockedBy path still lets such a plan through) but the body
      // lies, and a stale Blocked-by in ready/ is exactly what the new lint bucket in
      // lint-stale-blocked.mjs reports. Fixing it at the source leaves that lint nothing
      // to find rather than teaching it to tolerate the shape.
      //
      // Written AFTER the `git mv` so the content lands at `dest`, which the pathspec-
      // scoped close-out commit already names (via `moved`). Best-effort by design: this
      // runs inside the close-out spine, where a throw would abort a land MID-FLIGHT for a
      // cosmetic body fix — the same WARN-AND-CONTINUE contract as the cost-banner arm
      // above. The promotion itself (the part that matters) is already staged.
      if (!D.env.DRY) {
        try {
          // Reuse `body` — already read from `rel` at the top of this iteration, and
          // `git mv` moves bytes without changing them, so a second readFileSync of the
          // destination would return the identical content (review finding: redundant
          // re-read). One read per candidate, not two.
          //
          // Review fix (plan 3111 round 3, finding 1 — CONFIRMED): ATOMIC replace, not a
          // truncating writeFileSync. Pre-existing line, but the identical failure class the
          // adopt-stamp write immediately below was just hardened against, in the same function
          // and on the same file: a plain write opens O_TRUNC, so an ENOSPC/EIO partway through
          // leaves a TORN plan body — and the catch below only WARNS, so the close-out commit a
          // few lines later stages that truncated body and lands a corrupted plan in ready/.
          writeText(
            `${MAIN}/${dest}`,
            D.planBodyState.stampPromotedStatus(promotedBody, {
              target: D.buildIndexLib.READY_FOLDER,
              fromStatus: D.buildIndexLib.WAITING_BLOCKED_FOLDER,
              date: state.date,
            }),
          );
        } catch (e) {
          if (dest !== unstampedDest && promotedBody !== body) {
            try {
              // A stamp invented alongside the exempt-mechanical backfill promises bytes that
              // only this failed rewrite would have delivered, so restore the honest unstamped
              // name. When the body already carried an explicit lane, however, the stamp merely
              // caught the filename up to those existing bytes and must survive a later status
              // rewrite failure; rolling that case back would create the very drift we avoid.
              movePlanFileIdempotent(MAIN, dest, unstampedDest);
              dest = unstampedDest;
              baseName = dest.split('/').pop();
              process.stderr.write(
                `done-worktree: WARNING — promoted-body rewrite failed, so ${baseName} was ` +
                  `promoted under its unstamped name and still needs its execModel stamp: ` +
                  `${e.message || e}\n`,
              );
            } catch (recoveryError) {
              process.stderr.write(
                `done-worktree: WARNING — promoted ${baseName} to ready/ but could not rewrite ` +
                  `its body or restore its unstamped name; it still needs its execModel stamp: ` +
                  `${e.message || e}; recovery failed: ${recoveryError.message || recoveryError}\n`,
              );
            }
          } else {
            process.stderr.write(
              `done-worktree: WARNING — promoted ${baseName} to ready/ but could not rewrite its ` +
                `body (stale Blocked-by line may survive): ${e.message || e}\n`,
            );
          }
        }
        // plan 3111: writer 3 of 3 into ready/. Bring the promoted plan's `adoptBranch:` stamp
        // into agreement with what origin carries, in the same close-out commit that promotes it —
        // otherwise a plan auto-promoted here can enter the drain's queue carrying a dead pointer,
        // or (the case this plan exists for) WITHOUT the stamp its preserved branch needs, and be
        // excluded by the plan-2863 gate forever.
        //
        // BEST-EFFORT, NEVER THROWS — the same contract as the body rewrite immediately above and
        // the bannerErr arm earlier: this is a NETWORK call newly entering the land close-out
        // spine, and the failure mode to avoid is a transient `ls-remote` blip aborting an
        // otherwise-successful land. The authority already converts every failure into
        // 'unavailable' + a warning (which STRIPS NOTHING — an unreadable origin must never be
        // mistaken for "no branches found"); the try/catch is the belt-and-suspenders that makes
        // "cannot throw" true by construction rather than by the callee's good behaviour.
        // Ordering: AFTER the stampPromotedStatus write, because both mutate the same file and the
        // authority reads it from disk.
        try {
          const adopt = D.planAdoptBranch.syncAdoptBranchStamp(MAIN, dest, {
            lsRemote: adoptBranchLsRemote,
          });
          if (adopt.action !== 'noop')
            process.stderr.write(
              `done-worktree: adopt stamp — ${D.planAdoptBranch.describeAdoptAction(baseName, adopt)}\n`,
            );
        } catch (e) {
          process.stderr.write(
            `done-worktree: WARNING — promoted ${baseName} to ready/ but its adoptBranch stamp ` +
              `could not be synced (left as-is): ${e.message || e}\n`,
          );
        }
      }
      // plan 399: do NOT self-push the bullet repath via `index.mjs move` here —
      // that lands an INDEX whose bullet points to ready/ while the file move is
      // still only staged for the (later) close-out commit, the SAME half-state
      // bug class as the archive. The single regenIndex() pass below rebuilds the
      // whole active region from ls-files (which already reflects this staged mv),
      // so the promotion lands atomically inside the close-out commit instead.
      moved.push(dest);
      // `git mv` also stages the deletion of the OLD path (`rel`); the pathspec-
      // scoped close-out commit must name it too or the deletion is stranded
      // (plan 378). Mirrors move-plan.mjs committing both oldRel + newRel.
      (state.promotedOldPaths ||= []).push(rel);
      state.promoted.push(baseName);
    });
  }
  return moved;
}

// plan 2891 T7: the close-out guards its session-entry flip with `if (sf)`, so an entry that
// findSessionFile could not resolve — an AMBIGUOUS legacy match, where several entries mention
// the slug and none carries the anchored `**Branch:**` line — archives and pushes while the
// handoff entry stays 🔄 IN PROGRESS. Keeping the skip is SETTLED (spec-pass 2026-08-05): halting
// a close-out on bookkeeping is the wrong trade, and flipping a stranger's entry is the very
// corruption plan 2838's refusal exists to prevent (session 555 once marked an unrelated archived
// plan ✅ COMPLETED that way).
//
// What was missing is the hand-off. findSessionFile has already PRINTED the candidate list by the
// time we get here; this adds the one thing that block did not carry — the exact command that
// finishes the job. The edit still LANDS through the sanctioned coord path, never a hand commit:
// docs/handoff/** is coord-write-only, and coord-edit.mjs is precisely the tool for a
// hand-AUTHORED edit to a shared doc (it captures the working-tree change and replays it onto the
// freshened base under coordWrite's contract). An operator who reaches for `git commit` instead
// gets their hunks swept into some sibling coord tool's commit — which is why the command is
// spelled out rather than left as "fix it up yourself".
function reportUnflippedSessionEntry(state) {
  process.stdout.write(
    `done-worktree: the session entry for "${state.slug}" could not be resolved (see the block ` +
      `above), so its **Status:** line was NOT flipped — the land itself is complete. To finish ` +
      `the bookkeeping, edit the entry in the MAIN checkout and land it with coord-edit (never a ` +
      `raw git commit — docs/handoff/** is coord-write-only):\n` +
      `  1. set the **Status:** line of the entry that owns this slug to:\n` +
      `     **Status:** ✅ COMPLETED — closed via done-worktree on ${state.date} from host \`${state.host}\`.\n` +
      `  2. node scripts/coord-edit.mjs --paths <that-entry-path> --message "docs(handoff): flip ${state.slug} session entry to COMPLETED"\n` +
      `While there, add a \`**Branch:** \\\`worktree-${state.slug}\\\`\` line to that entry so the ` +
      `resolver can never be ambiguous about it again.\n`,
  );
}

function flipSessionCompleted(MAIN, relPath, state) {
  const D = landDeps();
  // plan 642: hard guard (belt-and-suspenders for the resolver fix). NEVER write
  // status into the frozen pre-205 archive — even if findSessionFile ever regresses.
  // The 738 KB pre-205 history under the sessions archive once won the
  // lexical hits[last] and this flip falsely marked an unrelated archived plan
  // ✅ COMPLETED (134 land, session 555). Throw loudly rather than corrupt history.
  const { paths } = D.coordConfig.loadCoordConfig(MAIN);
  if (D.L.isArchiveSessionPath(relPath, paths)) {
    throw new Error(
      `done-worktree: refusing to flip session status under ${paths.sessionsDir}/archive/ (${relPath}) — frozen history must never be written. ` +
        `This should be unreachable (findSessionFile excludes the archive); if you hit it, findSessionFile has regressed. ` +
        `The board row + plan git mv are already staged on master — re-run the land after fixing the resolver to finish the close-out.`,
    );
  }
  const abs = `${MAIN}/${relPath}`;
  let txt = readFileSync(abs, 'utf8');
  // plan 651: idempotent — a partial-run re-run finds the entry already ✅ COMPLETED;
  // skip the rewrite so the re-run neither churns the file nor re-dates the close.
  if (D.L.statusAlreadyCompleted(txt)) return;
  txt = txt.replace(
    /^\*\*Status:\*\*.*$/m,
    `**Status:** ✅ COMPLETED — closed via done-worktree on ${state.date} from host \`${state.host}\`.`,
  );
  writeFileSync(abs, txt);
}
