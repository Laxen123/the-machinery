// scripts/coord/land/lane-merge.mjs — plan 3961 T3.6b: the land spine's lane-merge phase
// (merge to master, claim release, resume-graft holds), moved out of scripts/done-worktree.mjs
// behaviour-identical (parity proven by scripts/coord/land/parity.test.mjs's 12 scenarios against
// committed goldens, plus the full 571-case scripts/done-worktree.test.mjs, both unchanged by
// this move).
//
// WHAT THIS MODULE OWNS. `phaseLaneMerge` itself (the file header's five-phase landing sequence's
// third phase: the landing-queue enqueue-and-gate, the at-head worktree-lock acquire, the
// speculative-stack un-stack, the head-time fast-path re-check, the rebase/sync-skip, the
// force-push proof export, the ephemeral merge to master, and the same-PC landing-lock release) plus
// its lane-merge-private cluster: `holdOnResumeGraft`/`holdOnGraftPayload` (the plan-3080 held-seam
// conversion for a `--resume LAND_BLOCKED_HOLDING` re-entry that finds a foreign-master graft),
// `mergeToMaster` (the plan-495 guarded ephemeral-merge primitive phaseLaneMerge calls), and
// `releaseClaimAfterMerge` (the plan-399 claim-ref release once the merge has landed on
// origin/master — a stowaway physically stranded in the queue-lock zone of the pre-T3 spine,
// conceptually unrelated to it, the same pattern T3.1/T3.2 each found in their own zones).
//
// HOW THIS MODULE REACHES THE REST OF THE WORLD. A non-test module under scripts/coord/ may
// import only scripts/coord/** and node: builtins (Rule 3, docs/runbooks/scripts-module-layout.md)
// — so every one of the plain scripts/*.mjs modules this code used to reach directly is instead
// read off the bound dependency container, `landDeps()` (scripts/coord/land/deps.mjs), AT CALL
// TIME, inside each function — never at module top level. `D` (this module's convention: `const D
// = landDeps();` as the first line of every function that needs it) is the same one-letter
// binding every other scripts/coord/land/*.mjs core module uses for the same reason.
// rebase-sync.mjs (worktreeHeadSha, originMasterTip, tryRebase, trySkipSync, logSyncSkipped,
// SYNC_SITE, armDryRebasedTip, remoteBranchTip, landSpecMarker), queue.mjs (queueHeartbeat,
// tryReclaimStrandedLandLock, preQueueFreshen, queueEnqueueAndGate, requeueOnConflictOrReturn),
// head-lock.mjs (acquireWorktreeLockAtHead, rebaseHeadHoldClock), queue-probe.mjs
// (unstackSpeculativeBase, foreignStackedBranch), and gates-runner.mjs (prepGateRun) are all
// SIBLING core modules under scripts/coord/land/, so their names are imported from them directly,
// no container needed.
//
// THE `spine` GROUP. `repinAndReprove`, `attachmentRefusal`, and `evaluateLandFastPath` are
// already `spine` members (see deps.mjs's own T3.3/T3.4b/T3.6 comments) and are reached here the
// same way — none of the three can move: `repinAndReprove` reads a module-private `let` guarded
// by three other STAYS functions this step did not map (see rebase-sync.mjs's own header),
// `attachmentRefusal`/`evaluateLandFastPath` read/write the spine-private `let lastHeadRefError`,
// whose other readers/writers are large not-yet-carved functions unrelated to this move.
// `emitSeamWithMarkerTable` and `landGateRosterFromRegistry` join `spine` at this step: both are
// called by phasePreflight too (not yet carved), so neither can move with phaseLaneMerge alone.
//
// THE `_retainedEntryHeartbeatDisarm` `let`. phaseLaneMerge's two disarm call sites used to read
// the spine-private `let _retainedEntryHeartbeatDisarm` directly
// (`if (_retainedEntryHeartbeatDisarm) _retainedEntryHeartbeatDisarm();`) — an ES module's private
// binding is unreachable from another module, so both call sites now go through a tiny
// spine-resident accessor, `disarmRetainedEntryHeartbeat()` (added to the `spine` group in this
// same step, right beside the `let` it owns), which does the identical if-guarded call. The
// `let` itself, its writer (phasePreflight's `_retainedEntryHeartbeatDisarm = ...` assignment),
// and the exit-hook reader all stay in done-worktree.mjs, untouched.
//
// A PURE MOVE apart from the accessor substitution above. Every moved function is byte-identical
// to its done-worktree.mjs original apart from the mechanical container-access rewrites (`run(` →
// `D.spawn.run(`, `node(` → `D.spawn.node(`, `gitMain(` → `D.spawn.gitMain(`, `DRY` →
// `D.env.DRY`, `L.foo(` → `D.L.foo(`, `errText(` → `D.coordGit.errText(`, `mergeBranchToMaster(`
// → `D.landLib.mergeBranchToMaster(`, `graftedForeignCommits(` → `D.landLib.graftedForeignCommits(`,
// `recordLandPrepOutcome(` → `D.coordMetrics.recordLandPrepOutcome(`,
// `emitSeam(`/`emitSeamWithMarkerTable(`/`coordStep(`/`landingBoardSlug(`/`stepLog(`/
// `repinAndReprove(`/`attachmentRefusal(`/`evaluateLandFastPath(`/`landGateRosterFromRegistry(` →
// the matching `D.spine.*` prefix), the `export` keyword added where a caller outside this module
// needs it, and the `const D = landDeps();` first line every function that needs the container
// gained — no renames, no reordering, no incidental fixes beyond the accessor substitution above.
// Every comment moved with its function; they carry the plan history that explains the code.

import { landDeps } from './deps.mjs';
import {
  worktreeHeadSha,
  originMasterTip,
  tryRebase,
  trySkipSync,
  logSyncSkipped,
  SYNC_SITE,
  armDryRebasedTip,
  remoteBranchTip,
  landSpecMarker,
} from './rebase-sync.mjs';
import {
  queueHeartbeat,
  tryReclaimStrandedLandLock,
  preQueueFreshen,
  queueEnqueueAndGate,
  requeueOnConflictOrReturn,
} from './queue.mjs';
import { acquireWorktreeLockAtHead, rebaseHeadHoldClock } from './head-lock.mjs';
import { unstackSpeculativeBase, foreignStackedBranch } from './queue-probe.mjs';
import { prepGateRun } from './gates-runner.mjs';

// plan 4066 task 0: the member-level container-read manifest for this module — see
// preflight.mjs's own CONTAINER_READS comment for what asserts it and when, and
// container-manifest.mjs's header for the aggregator itself. Generated, not hand-typed;
// regenerate with the same scanner on a real change to this file's container reads.
export const CONTAINER_READS = Object.freeze({
  L: Object.freeze([
    'EXCLUSIVE_LANE',
    'SEAM',
    'branchTipMovedReason',
    'enqueueReadinessRefusal',
    'ephemeralMergeConflictReason',
    'ephemeralPushExhaustedReason',
    'holdingReason',
    'landGatesProvenPushEnv',
    'planIdForSlug',
    'preflightTipDriftReason',
    'pushNotVerifiedReason',
    'rebaseSeam',
  ]),
  assertNoLandedReversion: Object.freeze(['detectLandedReversion', 'reversionPreflightReason']),
  coordGit: Object.freeze(['errText']),
  coordMetrics: Object.freeze(['recordLandPrepOutcome']),
  env: Object.freeze(['DRY']),
  landLib: Object.freeze(['graftedForeignCommits', 'mergeBranchToMaster']),
  spawn: Object.freeze(['gitMain', 'node', 'run']),
  spine: Object.freeze([
    'attachmentRefusal',
    'coordStep',
    'disarmRetainedEntryHeartbeat',
    'emitSeam',
    'emitSeamWithMarkerTable',
    'evaluateLandFastPath',
    'landGateRosterFromRegistry',
    'landingBoardSlug',
    'repinAndReprove',
    'stepLog',
    'tallyLockRetry',
  ]),
});

// Release the refs/claims/<id> lock the moment the merge has landed on
// origin/master (plan 399). Routed through the CLI (not a direct import) so it is
// greppable under --dry-run and consistent with board/index/landing-lock calls.
// Best-effort + --force + exit-0 (release-claim never blocks a land); a leaked ref
// is healed by reconcile-board. Idempotent via state.claimReleased.
function releaseClaimAfterMerge(MAIN, state) {
  const D = landDeps();
  if (state.claimReleased) return;
  // plan 1364 Ship 3: batch mode — there is no single derivable pid (every member WON its own
  // refs/claims/<id> independently in claim-plan.mjs batch's all-or-release loop). Loop the
  // manifest's member ids and release each with the SAME best-effort + --force call the
  // single-plan path uses (release-claim.mjs is idempotent/never-blocking) so ONE member's
  // release failure can never strand the rest of the batch's post-merge close-out — errors
  // collect into teardownErrors (a leaked ref self-heals via reconcile-board), never a throw.
  if (state.batch) {
    if (!state.batch.manifest) {
      // Manifest already gone (see main()'s batch detection): a PRIOR successful close-out
      // commit released every member's claim ref in that same run — idempotent no-op here.
      state.claimReleased = true;
      return;
    }
    for (const id of state.batch.manifest.members) {
      try {
        D.spawn.node('release-claim.mjs', 'release', id, '--force');
      } catch (e) {
        (state.teardownErrors ||= []).push(`claim-release (batch member ${id}): ${e.message || e}`);
      }
    }
    state.claimReleased = true;
    return;
  }
  // plan 872: derive the plan id ROBUSTLY — never `planIdOf(state.slug)` directly. A
  // bare / prefix-less slug (a plan claimed before the claim-time guard existed, e.g.
  // plan 869's own bare slug) makes planIdOf THROW, and this runs POST-merge, so the
  // throw stranded the whole spine (claim ref leaked, plan un-archived, board row +
  // worktree orphaned). planIdForSlug falls back to the LIVE plan file (which always
  // carries the id) for a bare slug; a genuinely unresolvable id logs + skips (the ref
  // leak is healed by reconcile-board) rather than crashing the landing.
  // The derivation must NEVER throw — this runs post-merge and claim-release must
  // never block a land. A bare slug (planIdForSlug → null) AND a failed `git ls-files`
  // both fall into the same log-and-skip path below; reconcile-board heals the leak.
  let pid = null;
  try {
    pid = D.env.DRY
      ? '<id>'
      : D.L.planIdForSlug(
          state.slug,
          D.spawn.run('git', ['-C', MAIN, 'ls-files', 'docs/superpowers/plans']),
        );
  } catch {
    /* git ls-files failed — pid stays null, handled uniformly below */
  }
  if (!pid) {
    (state.teardownErrors ||= []).push(
      `claim-release: cannot derive a plan id from slug "${state.slug}" — claim ref left ` +
        `unreleased; reconcile-board will surface/heal the leak`,
    );
    return;
  }
  try {
    D.spawn.node('release-claim.mjs', 'release', pid, '--force');
    state.claimReleased = true;
  } catch (e) {
    (state.teardownErrors ||= []).push(`claim-release: ${e.message || e}`);
  }
}

// The ONE hold-or-requeue sequence for a conflict halt site (review 1528 [10] — the rebase
// and ephemeral-merge sites shared this verbatim). Burns one event on the matching attempt
// tally, and when the trip fires emits LAND_BLOCKED_REQUEUED (which process.exit()s);
// returning at all means "not requeued — proceed with the HOLDING halt".
// plan 2453: the caller passes the DISCRIMINATED seam reason it already holds (the rebase
// site's synthetic 'rebase-conflict', or `e.reason` at the ephemeral site) — no boolean
// flag, and no hand-computed mutual exclusion at the call site. The reason→kind→tally
// routing is one registry lookup (L.eventKindForReason); an unregistered reason resolves to
// null, which maybeRequeueToTail reports and declines to count, holding the slot as today.
// plan 3080 (gpt-review round 3, 903b1a): ONE conversion from a graft result to the held seam,
// shared by the resume arm's two exits. They differ only in which fields the payload carries, and
// two hand-copies of a seam emission is exactly how the "found" and "unevaluable" arms drift into
// telling a session two different stories about the same guard.
function holdOnResumeGraft(wtPath, state) {
  const D = landDeps();
  let graft;
  try {
    D.spawn.run('git', ['-C', wtPath, 'fetch', 'origin', 'master']);
    graft = D.landLib.graftedForeignCommits(wtPath, originMasterTip(wtPath));
  } catch (e) {
    // Fail closed, exactly as the sync path does — an unevaluable guard is not a pass.
    return holdOnGraftPayload(state, {
      graftUnverifiable: true,
      graftCommits: [],
      graftDetail: D.coordGit.errText(e) || String(e),
    });
  }
  if (!graft.commits.length) return;
  return holdOnGraftPayload(state, {
    graftCommits: graft.commits,
    graftCleanCutoff: graft.cleanCutoff,
    graftOwnAbove: graft.ownAbove,
    graftMergeBearing: graft.mergeBearing,
  });
}

function holdOnGraftPayload(state, extra) {
  const D = landDeps();
  queueHeartbeat(state);
  D.spine.emitSeam(
    D.L.SEAM.LAND_BLOCKED_HOLDING,
    D.L.holdingReason(
      D.L.rebaseSeam({
        conflicted: false,
        conflictCommits: 0,
        abortedOnce: false,
        graftBlocked: true,
        ...extra,
      }),
      state.lane,
    ),
    state,
    { keepQueue: true, holding: true },
  );
}

// ── merge to master via an EPHEMERAL worktree (plan 355) ─────────────
// The merge+push happens in a throwaway detached worktree checked out off
// origin/master — NEVER in the shared main tree, NEVER with autostash. That
// removes the only structural path to the 2026-06-04 autostash-pop wedge. After
// the land we fast-forward MAIN's local master up to the just-pushed origin/master
// so the subsequent close-out doc commit sits on top of the merge (not a stale
// base). The ff-only never conflicts; it fails loudly if MAIN's tree blocks it
// (same contract as the old `pull --ff-only`).
// plan 3972: `expectedHead` is the tip the spine reviewed, queued and gated (the worktree's HEAD);
// land-lib refuses to merge any other `origin/<branch>` (typed `branch-tip-moved`). The DRY trace
// carries it as its own line so a spine test can see the pin without a real repo.
function mergeToMaster(MAIN, branch, summary, { expectedHead = null } = {}) {
  const D = landDeps();
  if (D.env.DRY) {
    if (expectedHead) process.stdout.write(`D.env.DRY merge pin expectedHead=${expectedHead}\n`);
    // DW_FAKE_MERGE=tip-moved (honoured ONLY under --dry-run): the typed land-lib refusal, so the
    // slot-RELEASING seam it routes to is provable without a racing sibling push.
    if (process.env.DW_FAKE_MERGE === 'tip-moved') {
      const err = new Error('DW_FAKE_MERGE injected branch-tip-moved');
      err.reason = 'branch-tip-moved';
      err.branch = branch;
      err.expectedHead = expectedHead || '<expected>';
      err.actualHead = '<moved>';
      throw err;
    }
    // plan 2432 test hook, honoured ONLY under --dry-run (like DW_FAKE_REBASE): inject the
    // two TYPED merge-phase failures the halt site discriminates, so the requeue-trip
    // behaviour of a CONTENT conflict vs a plan-2411 push storm is provable end-to-end.
    if (
      process.env.DW_FAKE_MERGE === 'conflict' ||
      process.env.DW_FAKE_MERGE === 'push-exhausted'
    ) {
      const err = new Error(`DW_FAKE_MERGE ${process.env.DW_FAKE_MERGE}`);
      // review 2432 [1]: populate ONLY the detail field that matches the injected reason —
      // a real error carries one or the other, never both, and a fixture that stamps both
      // would train a consumer to read the wrong field and mask a reason/detail mismatch.
      if (process.env.DW_FAKE_MERGE === 'conflict') {
        err.reason = 'ephemeral-merge-conflict';
        err.conflictDetail = 'DW_FAKE_MERGE injected conflict';
      } else {
        err.reason = 'ephemeral-push-nonff-exhausted';
        err.pushDetail = 'DW_FAKE_MERGE injected non-ff exhaustion';
      }
      throw err;
    }
    // representative dry trace (keeps `merge --no-ff` greppable for the spine tests)
    D.spawn.run('git', [
      '-C',
      `<ephemeral:${branch}>`,
      'merge',
      '--no-ff',
      `origin/${branch}`,
      '-m',
      `Merge ${branch}: ${summary}`,
    ]);
    D.spawn.run('git', ['-C', `<ephemeral:${branch}>`, 'push', 'origin', 'HEAD:master']);
    D.spawn.run('git', ['-C', MAIN, 'switch', 'master']);
    D.spawn.run('git', ['-C', MAIN, 'merge', '--ff-only', 'origin/master']);
    return '<dry-sha>';
  }
  // plan 495: delegate to the guarded primitive — it re-asserts landability at the
  // LAST safe moment (before the ephemeral merge), so a sibling commit that landed on
  // the SHARED local master AFTER preflight's assertLandable (during tryRebase / the
  // same-PC landing-lock --wait) halts cleanly with the branch UN-merged.
  // The injected runner is gitMain so the guard's MAIN ops keep index.lock retry.
  // plan 971: syncMain:false — do NOT advance the shared local master here. The whole
  // post-merge close-out runs in the ephemeral finish worktree (runCloseOutIsolated), so
  // MAIN's local master is never a push source; it is fast-forwarded OPPORTUNISTICALLY
  // afterward (opportunisticFfMain, skipped if dirty). This removes the last way a
  // sibling commit / foreign dirt on the shared main checkout could block a completed land.
  return D.landLib.mergeBranchToMaster(MAIN, branch, summary, {
    run: (cwd, args) => D.spawn.gitMain(cwd, args),
    syncMain: false,
    expectedHead,
  });
}

/** Lane-merge phase in the file header's five-phase landing sequence. */
export async function phaseLaneMerge(ctx) {
  const D = landDeps();
  const {
    a,
    MAIN,
    wtPath,
    branch,
    slug,
    state,
    changed,
    cfg,
    resumedPast,
    alreadyLanded,
    recordedVerdict,
    landRegistry,
  } = ctx;
  let { landFastPath, reversionMasterRef } = ctx;

  // plan 3961 T2.7a: derived once from the `landRegistry` this phase already carries in `ctx`
  // (built once in phasePreflight, above every seam and gate — see that call site's own
  // comment), so both once-per-land gateRoster consumers below read the identical roster without
  // a second landRegistries() call.
  const gateRoster = D.spine.landGateRosterFromRegistry(landRegistry);

  // 2.7 LANDING QUEUE (plan 504) — ALL lanes enqueue; proceed only at head.
  // Inside the try so a throw mid-gate still hits the finally's dequeue.
  // Skipped when resuming a POST-MERGE seam (deploy / carry-forward / promote):
  // the branch is already on origin/master and only doc-only close-out pushes
  // remain — re-enqueueing at the tail would block bookkeeping behind
  // unrelated lands for zero correctness gain (review fix, plan 504).
  const postMergeResume = [
    D.L.SEAM.DEPLOY_FAILED,
    D.L.SEAM.CARRYFORWARD_AMBIGUOUS,
    D.L.SEAM.PROMOTE_AMBIGUOUS,
  ].includes(a.resume);
  // Read again by phaseDeployCheck; publish as soon as it exists (plan 3598).
  ctx.postMergeResume = postMergeResume;
  // plan 651: an already-landed re-run also skips the queue — re-enqueueing at the
  // tail would block pure bookkeeping behind unrelated lands for zero correctness gain
  // (same rationale as postMergeResume; the merge is already on origin/master).
  if (!postMergeResume && !alreadyLanded) {
    // plan 2170 Ship 1 (upgrades plan 1240's WARN): queue position ≠ readiness — REFUSE
    // the enqueue when the land diff is reviewable but carries no CURRENT sha-pinned
    // review verdict for HEAD (no marker, or a stale marker = reworked-after-review).
    // The slot must mean "reviewed, done, merge NOW" (the plan-1219/2150 head holds).
    // recordedVerdict was computed against HEAD at 2.5 — WITH the repin attempt hoisted
    // ahead of it, so a pure keep-hot/--prep re-sha self-heals before this gate; and
    // deliberately NOT resume-guarded — `--resume REVIEW_NEEDED` skipping the 2.5 seam
    // and enqueueing verdict-less IS the 2150 hole this closes. The findings twin (every
    // finding dispositioned) is already enforced pre-queue by the 2.55 findings gate.
    // A clean, current verdict emits nothing (sha-pin honored, no redundant re-fan-out).
    const enqRefusal = D.L.enqueueReadinessRefusal(changed, recordedVerdict, cfg.handoffLayout);
    if (enqRefusal) {
      // Release any slot left over from a PRIOR residency (idempotent, exit 0) — a
      // not-land-ready plan must not keep a queue position either.
      try {
        D.spawn.node('landing-queue.mjs', 'dequeue', slug);
      } catch {
        /* best-effort — no slot to release is the normal case */
      }
      D.spine.emitSeamWithMarkerTable(
        D.L.SEAM.REVIEW_NEEDED,
        enqRefusal,
        MAIN,
        slug,
        wtPath,
        cfg.handoffLayout,
        state,
      );
    }
    preQueueFreshen(state, wtPath, branch, gateRoster);
    D.spine.disarmRetainedEntryHeartbeat(); // plan 2992
    queueEnqueueAndGate(state, a.wait, a.resume, a.waitChunk);
  }
  // plan 2992 (review a1ffdb/87c9ae/18faac): the disarm above sits INSIDE the queue block,
  // which an `alreadyLanded` / `postMergeResume` run skips entirely — so on those paths the
  // interval survived the whole post-merge phase (deploy gates, close-out) and kept
  // refreshing a RETAINED, possibly already-orphaned entry. `state.queued` is false on those
  // paths, so dequeueQueueIfHeld never releases that entry either — the tick would make a
  // dead slot look alive to demote/steal/reap and stall unrelated lands, the exact inversion
  // of this plan's goal. Unconditional and idempotent, so the normal path (already disarmed
  // above) pays nothing.
  D.spine.disarmRetainedEntryHeartbeat();

  // plan 2473: we are at the head of the FIFO — take the worktree before anything else in this
  // land touches it. Deliberately BEFORE the same-PC landing-lock acquire below (never hold the
  // cross-session landing mutex while waiting on a same-worktree interlock) and before the at-head
  // fast-path re-check (waiting out a prep child is what LETS that re-check see a fresh marker
  // and skip the battery — the coverage this plan exists to buy). Held through the rebase and
  // the merge; released by the exit hook, which is the only release point every seam halt and
  // crash share.
  if (!alreadyLanded && !postMergeResume) {
    const t0 = Date.now();
    acquireWorktreeLockAtHead(state);
    // review 2473 [3]: markHeadAcquired stamped headAcquiredIso BEFORE this wait, and
    // maybeRequeueToTail/requeueTrip read that stamp as "how long has this land been grinding at
    // head" to detect heavy rework (REQUEUE_HOLD_MIN = 8 min). Waiting for a prep is not
    // grinding — it is the opposite, the land deliberately idling so the prep can finish and pay
    // its battery — but the clock could not tell the difference, so a wait longer than 8 minutes
    // made the land requeue itself to the TAIL on its very FIRST conflict, against requeueTrip's
    // own documented intent that a first conflict stays HOLDING. Re-stamp so the budget measures
    // work, not waiting. Threshold, not unconditional: a sub-minute wait is noise, and a
    // needless coordWrite on the serialized head path is not free.
    if (Date.now() - t0 >= 60_000) rebaseHeadHoldClock(state, t0);
  }

  if (state.lane === D.L.EXCLUSIVE_LANE && !alreadyLanded) {
    // landing-lock exits 2=BUSY / 3=STALE → execFileSync throws. Convert that
    // to a clean PREFLIGHT_FAIL seam (with a resume path) instead of a raw
    // crash; landingClaimed is still false so the finally correctly no-ops.
    // --scope (plan 1300): the lock blocks only on an OVERLAPPING holder, so
    // two disjoint-scope 🟥 lands acquire concurrently.
    const scopeArg = JSON.stringify(state.seedScope ?? { global: true });
    D.spine.stepLog(state, `seed landing-lock: acquiring (scope=${scopeArg})`);
    try {
      D.spawn.node('landing-lock.mjs', 'acquire', slug, '--wait', '--scope', scopeArg);
    } catch (e) {
      // plan 665 G4.2: before giving up, try to reclaim a lock STRANDED by a detached land
      // whose sidecar proves it already merged (same host) — then retry the acquire once.
      // GATE ON STALE (landing-lock exit 3 — holder > stale-min): a live merge is never
      // 35 min old, so a STALE lock can't be a live re-land mid-merge. A BUSY lock (exit 2,
      // < stale-min) MIGHT be a live re-land holding a fresh lock — NEVER steal it (else a
      // persisted prior-land sidecar would authorise force-releasing a live merge → the
      // double-merge race; review finding). e.status carries the child's exit code.
      const stale = Boolean(e && e.status === 3);
      if (!D.env.DRY && stale && tryReclaimStrandedLandLock(state)) {
        try {
          D.spawn.node('landing-lock.mjs', 'acquire', slug, '--wait', '--scope', scopeArg);
        } catch (e2) {
          D.spine.emitSeam(
            D.L.SEAM.PREFLIGHT_FAIL,
            `landing-lock acquire failed even after reclaiming a stranded lock: ${e2.message || e2}`,
            state,
          );
        }
      } else {
        D.spine.emitSeam(
          D.L.SEAM.PREFLIGHT_FAIL,
          `landing-lock acquire failed (BUSY/STALE) — another landing holds the same-PC mutex: ${e.message || e}`,
          state,
        );
      }
    }
    // plan 810: mark the mutex HELD the instant the acquire succeeds — reaching here means it
    // did (every acquire-failure path above emitSeam → process.exit). Previously landingClaimed
    // was set AFTER the LANDING set-state below, so a sibling's TRANSIENT foreign-dirt on that
    // set-state (default non-`--wait` mode → coordRetry doesn't retry → it throws) propagated
    // with landingClaimed still false → the finally's releaseMutexIfHeld no-oped (mutexHeld
    // gates on landingClaimed) → the acquired same-PC lock was ORPHANED, wedging a sibling
    // 🟥 land until the ~35-min stale auto-reclaim (the pre-merge twin of the plan-793 post-merge
    // strand). Setting it HERE means the finally always frees a lock that was actually acquired,
    // regardless of where a later throw lands.
    state.landingClaimed = true;
    D.spine.stepLog(state, 'seed landing-lock: acquired');
    // plan 810: route the LANDING set-state through coordStep (the single coord-write choke
    // point) for parity with every other bookkeeping shell-out — it retries a sibling's transient
    // foreign-dirt in --wait mode, preserves coordWrite's immediate hard-stop in the default mode
    // (a pre-merge foreign-dirt is usually the operator's own uncommitted edit), and applies the
    // dry-run backoff shrink. Pre-merge (no mergeSha) its wait-gating equals the old coordRetry(a.wait).
    D.spine.coordStep(
      state,
      () => D.spawn.node('board.mjs', 'set-state', D.spine.landingBoardSlug(state), 'LANDING'),
      `board LANDING ${D.spine.landingBoardSlug(state)}`,
    );
  }
  // test-only fault injection: prove the finally demotes+releases on a throw
  // between LANDING-claim and release. Guarded by env; never set in prod.
  if (process.env.DW_TEST_THROW === '1') throw new Error('DW_TEST_THROW injected');
  // 3b REBASE (rerere auto-resolves known conflicts). Skipped on resume —
  // the agent already resolved + `git rebase --continue`d the branch.
  // plan 504 hold-through-conflict: a conflict no longer releases the claim.
  // The seam is LAND_BLOCKED_HOLDING (REBASE_CONFLICT/REBASE_UGLY ride in the
  // reason): the landing mutex + 🟢 LANDING row + queue head slot all stay HELD, the
  // session resolves, then --resume LAND_BLOCKED_HOLDING re-enters the merge.
  // (--resume REBASE_CONFLICT is honoured too — pre-504 muscle memory.)
  // plan 651: an already-landed re-run skips the rebase too — the branch is already an
  // ancestor of origin/master, so the rebase+force-push is a pointless no-op.
  // plan 972: the head fast-path skips it too — landFastPath PROVES (marker baseSha === the
  // live origin/master tip AND branchSha === the branch tip, re-checked after a SUCCESSFUL fetch
  // above) the branch is already rebased onto the current tip, so the rebase is a guaranteed
  // no-op. Residual-window safety does NOT come from this skipped rebase: mergeToMaster lands via
  // an ephemeral worktree that itself fetches origin/master and pushes ff-only, so a sibling tip
  // that moves between the fast-path check and the push is rejected as non-ff → a recoverable
  // LAND_BLOCKED seam, never a silent bad merge.
  // plan 2458: RE-EVALUATE the fast path now that the queue wait is over. The pre-enqueue
  // evaluation above ran before this land had waited at all, so it could not see a marker
  // stamped DURING the wait — by the keep-hot watcher, or by the enqueue-time prep this plan
  // added. Without this second look, a single blocking `--wait` invocation always arrived at
  // head with the pre-wait verdict and paid the full ~15-27 min battery while HOLDING the FIFO
  // head, no matter how well-prepped the branch actually was. The re-check is the same STRICT
  // proof (fresh fetch + sha equality on both tips), so it can only ever turn a false into a
  // true when the branch is genuinely already rebased onto the live tip with its gates paid.
  // Runs in BOTH directions, deliberately: it can turn a false into a true (a marker stamped
  // during the wait), and equally a stale true back into a false. The pre-enqueue verdict was
  // computed before this land waited, so a marker that was valid THEN can have been invalidated
  // by master advancing during a long queue wait — re-proving it here is what stops a
  // fast-path skip from resting on a verdict older than the wait itself.
  // plan 2463 D5: the head we speculatively stacked on may have failed out, been overtaken, or
  // been re-parked DURING our wait — in which case its commits are on our branch and NOT on
  // master. Un-stack before the fast-path proof so nothing downstream can merge them, and so the
  // proof itself runs against the branch we will actually land.
  if (!alreadyLanded && !a.resume && unstackSpeculativeBase(MAIN, wtPath, branch, slug)) {
    state.unstackedSpeculative = true; // the marker is gone now — remember, for the backstop
    // gpt-review 3972 r3 finding 4e7c14: the un-stack is a spine-owned reset of HEAD to the
    // plain-prepped tip, which is not the tip preflight captured. Re-prove the markers against it
    // NOW, or the merge-site drift check would refuse a legitimate un-stack as an unreviewed commit.
    D.spine.repinAndReprove(state, wtPath);
  }

  if (!alreadyLanded && !a.resume) {
    const wasFastPath = landFastPath;
    const ev = D.spine.evaluateLandFastPath(MAIN, wtPath, branch, slug, changed, true);
    landFastPath = ev.fastPath;
    // plan 2473: THE FINAL VERDICT. Emitted here, at the decision that actually governs whether
    // the battery runs, and tagged `final` + the same `landId` as the pre-enqueue record above
    // — so the summary can prefer this one per land without dropping the early-halt lands that
    // never reach this point (the regression that made 2458 revert its telemetry move).
    if (!D.env.DRY) {
      D.coordMetrics.recordLandPrepOutcome(MAIN, {
        slug,
        landId: state.landId,
        final: true,
        fastPath: landFastPath,
        hadMarker: !!ev.marker,
        fetchedOk: ev.fetchedOk,
        speculative: ev.speculative, // plan 2463: which marker earned the fire
        hadSpecMarker: !!ev.specMarker, // …and whether one merely existed (review [1])
      });
    }
    if (landFastPath) {
      reversionMasterRef = ev.liveTip;
      // plan 2463: a speculative hit reaches the merge with a branch tip the prep re-sha'd during
      // the wait, so the sha-pinned review/recorded markers still name the pre-stack tip. NOW the
      // patch-id proof holds (origin/master has absorbed the head, so the branch's diff vs master
      // is ours alone and identical to the reviewed one) — repin, exactly as the plain rebase path
      // does after its own re-sha. Best-effort: a refusal just leaves today's behaviour.
      // gpt-review 3972 r3 findings e25078 / 8a3415: a fast-path hit lands the tip the prep
      // re-sha'd during the wait. The preflight tip follows it ONLY on the markers' own repin
      // proof, on BOTH arms (round 2 passed the plain arm a null repin result and carried the
      // live HEAD unproven, so a commit made during the wait became its own expectation).
      D.spine.repinAndReprove(state, wtPath);
      if (!wasFastPath) {
        console.log(
          ev.speculative
            ? `done-worktree: plan-2463 SPECULATIVE land-prep fast-path (at head) — the head ` +
                `slot landed exactly as speculated (origin/master is the merge of the base we ` +
                `prepped against and the branch we stacked on), so this branch is already the ` +
                `tree that was gated DURING the wait; skipping the head-time rebase + battery.`
            : `done-worktree: plan-972 land-prep fast-path (re-checked at head, plan 2458) — the ` +
                `branch was rebased onto the live origin/master tip and its gates re-validated ` +
                `DURING the wait; skipping the head-time rebase + gate re-runs.`,
        );
      }
    } else if (wasFastPath) {
      reversionMasterRef = null;
      console.log(
        `done-worktree: the pre-enqueue land-prep fast-path LAPSED during the queue wait ` +
          `(plan 2458 re-check) — running the full rebase + gate battery at head.`,
      );
    }
  }
  if (
    !alreadyLanded &&
    !landFastPath &&
    !resumedPast(D.L.SEAM.REBASE_CONFLICT) &&
    !resumedPast(D.L.SEAM.LAND_BLOCKED_HOLDING)
  ) {
    const headBefore = worktreeHeadSha(wtPath);
    // plan 2443: the ONLY unlabelled step in the land, and the measured-dominant one — the
    // force-with-lease branch push inside syncBranchOntoMaster runs the FULL `scripts/hooks/pre-push.sh`
    // battery. Bracketing it with stepLog gives the sidecar's phases[] a `sincePrevMs` for the
    // gate term, which is what separates it from the ephemeral merge worktree one step down
    // (commit timestamps bundle the two — see land-duration-lib.mjs's tip→merge caveat).
    // plan 2654 review [1]: THE load-bearing one. This is the head-time rebase + force-push, and
    // this process may have been polling the queue for hours since its single startup
    // resolveWorktree, dispatching detached `--prep` children the whole time — one of which can
    // legitimately leave the tree detached (the divergent arm refuses to guess, and logs only to
    // its own log file, which this process never reads). Rebasing a detached HEAD here advances
    // the loose tip, leaves refs/heads/<branch> untouched, and the force-with-lease push then
    // republishes the STALE tip — so the land merges a tree the recorded review does not cover.
    // Unlike the prep, this PUBLISHES, so it seams out rather than skipping.
    const landAttach = D.spine.attachmentRefusal(wtPath, branch, slug, 'land');
    if (landAttach) {
      console.error(landAttach);
      D.spine.emitSeam(D.L.SEAM.PREFLIGHT_FAIL, 'worktree HEAD not attached to its branch', state);
    }
    // plan 3295 E3: hand this land's proven set to the post-rebase force-push. That push runs
    // the FULL `scripts/hooks/pre-push.sh` battery — the single measured-dominant step of a land
    // (plan 2443) — and the ruling covers it: a part already proven green in this land is not
    // re-proven there either. The channel is plain env — but it carries ONE fact, `LAND_ID`
    // (landGatesProvenPushEnv): the hook reads WHICH gates and WHICH baseline shas out of this
    // worktree's own sidecar, so the id only attributes that file rather than duplicating its
    // contents (gpt-review a5db89 / eda9b2 / 11844d). Env at all because the hook is a POSIX
    // shell script that cannot import this module — the same wire the plan-3223 GATE_LEDGER_KEY
    // consult already rides.
    //
    // Set on `process.env` rather than passed as a spawn option deliberately: the push itself is
    // three call layers down inside land-lib's syncBranchOntoMaster, and every layer builds its
    // child env over `process.env`. Nothing needs to unset it afterwards — the hook refuses the
    // export unless `LAND_ID` matches the sidecar of the repo BEING PUSHED, so the later
    // master push from MAIN (no sidecar there) ignores it on its own.
    Object.assign(
      process.env,
      D.L.landGatesProvenPushEnv(
        {
          landId: state.landGateId, // the LAND id (survives a re-invoke), never the per-invocation one
          gatesProven: state.gatesProven,
        },
        // plan 3960 review fix (finding 20), now plan 3961 T2.7a: this is the measured-dominant
        // push of the whole land — pass the REGISTERED roster (computed once above as
        // `gateRoster`), not a re-derivation, so this push and the pre-queue one above it can
        // never authorize a skip against two different rosters.
        gateRoster,
      ),
    );
    // plan 3972: AFTER the worktree lock (acquireWorktreeLockAtHead above — a prep may have been
    // mid-rebase until then) and the attachment refusal, BEFORE any rebase starts. A
    // coordination-only master delta with a clean merge-tree needs no sync at all: no rebase, no
    // re-pin (HEAD does not move, so the sha-pinned markers stay valid), no gated force-push —
    // the ephemeral merge below is a real three-way merge and takes the branch as it stands. The
    // landed-reversion lint's masterRef is still pinned, to the tip this probe was made against,
    // for the same reason the rebase path pins `rebasedOntoSha` (plan 2433).
    // The probe fetches origin/master itself (gpt-review 3972 r3 findings 68e100 / fc1440: round 2 reused
    // the fast-path re-check's fetch, which reopened a window for a sibling's code commit to land
    // between that fetch and this decision and read as coordination-only; on the serialized head
    // path correctness wins over one saved fetch).
    const skip = trySkipSync(state, wtPath, branch, { site: SYNC_SITE.atHead });
    if (skip.skipped) {
      logSyncSkipped(state, skip, SYNC_SITE.atHead);
      if (skip.masterTip) reversionMasterRef = skip.masterTip;
    } else {
      // The real sync runs: whatever the pre-queue freshen decided, the land's FINAL answer is
      // "not skipped" (the sidecar field means the final decision; the per-site record stays).
      state.syncSkipped = false;
      D.spine.stepLog(
        state,
        'rebase: syncing branch onto the master tip (its push runs the full gate battery)' +
          (skip.reason && skip.behind ? ` [sync not skipped: ${skip.reason}]` : ''),
      );
      const reb = tryRebase(wtPath, branch);
      D.spine.tallyLockRetry(MAIN, slug, reb); // plan 3974 T2c
      const cs = D.L.rebaseSeam(reb);
      if (cs) {
        queueHeartbeat(state); // stamp liveness — the 45-min steal clock starts here
        // plan 1528 Phase B arm (a): a SECOND conflict in this land attempt (or the >8-min
        // head-hold arm) with waiters behind releases the head to the tail instead of
        // grinding the rework under the mutex. First conflict stays HOLDING (normal, fast).
        // plan 2453: this site has no typed throw to read a reason off — it names its own
        // registered reason, so the routing is the same one lookup as the ephemeral site.
        // plan 3080: a graft refusal is NOT a rebase conflict and must not be tallied as one
        // (gpt-review e436d1/53e66b/1aed9c). Tallying it would spend this land's REQUEUE_MAX
        // budget on an event no amount of requeueing can clear — the branch carries another
        // plan's commits until a HUMAN takes them off, so bouncing it to the tail just re-runs
        // the same refusal from a colder slot. Hold instead, exactly as a first conflict does.
        if (!reb.graftBlocked) requeueOnConflictOrReturn(state, { reason: 'rebase-conflict' });
        D.spine.emitSeam(D.L.SEAM.LAND_BLOCKED_HOLDING, D.L.holdingReason(cs, state.lane), state, {
          keepQueue: true,
          holding: true,
        });
      }
      // plan 2433: reaching here means tryRebase completed with no conflict/pushBlocked seam
      // (emitSeam above would have exited otherwise) — record the tip it just rebased onto
      // (resolved inside tryRebase/syncBranchOntoMaster right after ITS fetch, never
      // re-resolved since) as the lint's pinned masterRef, so a sibling land that completes
      // during this rebase's own push-gate window can't false-flag files it never touched.
      D.spine.stepLog(state, 'rebase: branch synced + force-pushed (gate battery done)'); // plan 2443
      if (reb.rebasedOntoSha) reversionMasterRef = reb.rebasedOntoSha;
      // plan 1528 A1: the spine's own clean rebase re-sha'd the branch — re-pin the
      // sha-pinned markers NOW (patch-id-identical by the repin's own gate) so a later
      // halt + re-invocation never re-seams REVIEW_NEEDED / WIKI_CHECKPOINT (core-noun-ok:
      // that project seam's own enum member name) for pure bookkeeping. Best-effort: a
      // refusal just means the halt surfaces as before.
      // plan 3972: the preflight tip then follows the re-sha ONLY on the repin's positive proof
      // (repinAndReprove) — never on its silence, which also covers an I/O failure. DRY:
      // DW_FAKE_REBASED_TIP stands in for the re-sha (armDryRebasedTip).
      if (D.env.DRY) armDryRebasedTip();
      if (worktreeHeadSha(wtPath) !== headBefore) D.spine.repinAndReprove(state, wtPath);
    }
  } else if (
    !alreadyLanded &&
    !landFastPath &&
    (resumedPast(D.L.SEAM.REBASE_CONFLICT) || resumedPast(D.L.SEAM.LAND_BLOCKED_HOLDING))
  ) {
    // plan 2274 Fix 4: spine-owned post-rebuild push verification. This branch is reached
    // ONLY on a --resume past a held conflict — the rebase above is skipped because the
    // session claims to have already resolved + pushed. Verify that BEFORE re-entering the
    // merge: `git ls-remote` reads origin LIVE (never a possibly-stale local
    // remote-tracking ref), closing the plan-2233 post-mortem's "a backgrounded force-push
    // that failed its OWN pre-push gate was reported completed" leak. A THROWN verification
    // (network/proxy blip) is caught here rather than left to unwind through the outer
    // try/finally — that finally unconditionally releases the landing mutex + queue slot, which
    // would silently break this seam's own "held" guarantee on a transient hiccup instead of
    // a real problem with the branch (review fix: an unverifiable push must hold, never crash).
    const localSha = worktreeHeadSha(wtPath);
    let remoteSha;
    let verifyError = null;
    try {
      remoteSha = remoteBranchTip(wtPath, branch);
    } catch (e) {
      verifyError = e.message;
      remoteSha = undefined;
    }
    if (verifyError || remoteSha !== localSha) {
      queueHeartbeat(state);
      D.spine.emitSeam(
        D.L.SEAM.LAND_BLOCKED_HOLDING,
        D.L.pushNotVerifiedReason(branch, localSha, remoteSha, verifyError),
        state,
        {
          keepQueue: true,
          holding: true,
        },
      );
    }
    // plan 3080 (gpt-review round 2, 40ffb6): this arm SKIPS the rebase, and the graft check
    // lives inside syncBranchOntoMaster — so without this, `--resume LAND_BLOCKED_HOLDING`
    // walked straight past the guard into the merge. That matters most for the graft hold
    // itself, whose own holding text tells the session to resume this way: the branch it
    // refused to publish would come back through a door with no guard on it. Re-run the check
    // here against the same freshly-resolved origin/master the merge is about to use.
    if (!D.env.DRY) holdOnResumeGraft(wtPath, state);
  }
  // 3b.5 PRETTIER-DRIFT CHECK (plan 1723 E3) — post-rebase, PRE-merge. Deliberately OUTSIDE the
  // rebase block above so it also covers the keep-hot FAST-PATH land (which skips the rebase
  // because --prep already rebased + stamped the marker, but --prep runs no prettier gate — so a
  // --prep rebase that pulled a newer prettier config would otherwise reach the ephemeral merge
  // and fail scripts/hooks/pre-push.sh uglily). Skipped only when the branch already landed (empty diff).
  if (!alreadyLanded) {
    const pd = prepGateRun(landRegistry, 'prettier-drift', { wtPath });
    if (pd.depsMissing) {
      // plan 1723 review (F5): the check needs node_modules and it's absent (a docs-only
      // land whose cut-time install failed — E2's app-source gate never fired). This is NOT
      // formatting drift; steer at `pnpm install`, not `prettier --write` (which can't clear it).
      D.spine.emitSeam(
        D.L.SEAM.PREFLIGHT_FAIL,
        `the post-rebase prettier-drift check needs node_modules to run \`pnpm exec prettier\`, but ` +
          `"${wtPath}/node_modules" is MISSING (a fresh worktree's deps are gitignored; cut-worktree's ` +
          `automatic install must have failed — plan 1723 E1). This is NOT a formatting problem. Fix: ` +
          `run \`pnpm install\` in the worktree, then re-invoke done-worktree.`,
        state,
      );
    }
    if (!pd.ok) {
      const fileList = (pd.files || []).join(' ');
      // plan 1723 review (F2): a drift here RELEASES the queue slot + landing mutex (default
      // emitSeam), UNLIKE the REBASE_CONFLICT seam one step up which HOLDS them. That is
      // correct-by-design, not a weakened invariant: the fix is a NEW commit (prettier --write +
      // commit), so the reviewed diff changes and EVERY gate must re-run — there is nothing to
      // "resume at the merge" for (which is exactly what the hold-through-conflict slot-retain is
      // for). So this behaves like BUILD_FAILED or its device-preview-gate twin (fix + re-run
      // from scratch), it just
      // fires post-queue because drift can only appear after the rebase. Releasing keeps the FIFO
      // head short (the plan-1536 head-hold class) instead of holding it through a full re-gate.
      D.spine.emitSeam(
        D.L.SEAM.PRETTIER_DRIFT,
        `the land rebase onto the latest origin/master produced PRETTIER DRIFT — files the ` +
          `worker's pre-rebase in-worktree prettier check passed now FAIL \`prettier --check\` ` +
          `against the rebased tree (master advanced to a newer prettier config, e.g. a different ` +
          `printWidth). Fix, in the worktree, in this order:\n` +
          `  1. pnpm exec prettier --write ${fileList}\n` +
          `  2. git commit -am "style: prettier --write for post-rebase config drift" && git push\n` +
          `  3. re-record the review — a prettier-only delta is "no new logic" (self-read + ` +
          `\`node scripts/record-review.mjs PASS\`, per docs/runbooks/review-calibration.md)\n` +
          `  4. re-run done-worktree (bare — the new commit re-runs every gate; there is no --resume ` +
          `skip for this seam).\n` +
          `(NEVER auto-fixed in-spine: an auto-commit would change the patch-id and bypass the ` +
          `sha-pinned review marker — plan 1528 A1.)\n` +
          `--- prettier --check tail ---\n${pd.detail || ''}`,
        state,
      );
    }
    // plan 2274 Fix 2: landed-work-reversion lint — ADVISORY since plan 3832 (it reports, it
    // does not halt; the `LANDED_REVERSION` seam and exit 32 are retired). Still POST-rebase,
    // PRE-merge, like the prettier-drift check above and deliberately AFTER the
    // rebase/fast-path/resume step: pre-rebase it would false-positive on every routine
    // coord-doc edit. Resolve the merge-base ONCE and thread it into the call below (review
    // finding: two independent resolutions can silently diverge if origin/master advances
    // between them, and are wasted duplicate work).
    // plan 3832: there is no escape hatch here any more, because there is nothing to escape —
    // the block below REPORTS and never halts. `ALLOW_LANDED_REVERSION` and the three
    // `--allow-landed-reversion*` release flags were retired with the halt (see this file's
    // import comment and the guard's own header, § DEMOTED TO ADVISORY).
    {
      // test-only fake hook (mirrors DW_FAKE_PRECONVERGE): a comma-separated path list
      // stands in for detectLandedReversion's findings, so the seam's WIRING (fires
      // POST-rebase, not pre-rebase) is exercisable without a scratch repo. '' → clean.
      let reversions;
      // plan 2433: pin masterRef to the sha this land's own rebase/fast-path already proved
      // current (reversionMasterRef) rather than the LIVE origin/master — a sibling land
      // completing during the rebase's push-gate window (~15-27 min) would otherwise move
      // that live ref out from under this check and false-flag files this branch never
      // touched (the plan-2391 incident). No recorded sha (a --resume past a held conflict,
      // or alreadyLanded) falls back to live origin/master — today's behavior, needed
      // because those paths have no fresh rebase target to pin to.
      const masterRef = reversionMasterRef || 'origin/master';
      let revBase = null;
      if (D.env.DRY && process.env.DW_FAKE_LANDED_REVERSION !== undefined) {
        const fake = process.env.DW_FAKE_LANDED_REVERSION;
        reversions = fake
          ? fake.split(',').map((path) => ({ path, oldPath: path, oldStart: 1, oldLines: 1 }))
          : [];
      } else {
        try {
          revBase =
            D.spawn.run('git', ['-C', wtPath, 'merge-base', 'HEAD', masterRef]).trim() || null;
        } catch {
          revBase = null; // fail-open — same posture as detectLandedReversion's own internal resolution
        }
        reversions = D.assertNoLandedReversion.detectLandedReversion(wtPath, {
          base: revBase || undefined,
          masterRef,
        });
      }
      if (reversions.length) {
        // plan 2908 T1/T3 (E3): split by soundness. A `shallow-history` finding names no
        // culprits — the attribution walk that would have named them is unsound on a graft
        // boundary (see the guard's own header). Since plan 3832 NEITHER kind halts, so the
        // split is now purely about what the operator is told: an unsound finding cannot name
        // plans, so it keeps its own WARN wording (the guard's shared `unsoundWarnBlock`, so
        // this preflight and the guard's CLI can never drift apart on the same condition),
        // while a sound one gets the plan-named advisory below.
        //
        // E3's OTHER half — appending each sound file's intervening `revBase..masterRef`
        // commits — is deliberately NOT here, and plan 2917 CLOSED that question rather than
        // deferring it: `revBase` is `merge-base(HEAD, masterRef)` taken AFTER the rebase
        // pinned `masterRef` to the sha HEAD was just rebased onto, so it always resolves to
        // masterRef itself and that range is empty on every normal land. A PRE-rebase base
        // does not rescue it — on a fresh-cut or rebuilt branch that base collapses to the
        // master tip too (see the guard's header, § RULED OUT). What ships instead is the
        // ATTRIBUTED commits, which the walk already computes base-free and the printout below
        // names. No base is threaded into the guard from here; the spine stays untouched.
        const sound = reversions.filter((f) => !f.unsound);
        const unsound = reversions.filter((f) => f.unsound);
        if (unsound.length) {
          // gpt-review 3832 (findings angle-A / angle-P / claude-data-grounding): STDOUT and
          // stepLog, for the same reason the sound branch below moved — and this branch needs it
          // MORE, not less. It was stderr-only and never stepLog'd back when its land could still
          // halt on the sibling seam; now that no landed-reversion finding stops anything, a
          // shallow-clone "could not judge" note left on stderr of a SUCCEEDING land is dropped by
          // every caller that captures stdout, and never reaches the result sidecar at all. Fixing
          // the sound branch and leaving this one would have re-created the exact silent drop one
          // `if` away.
          process.stdout.write(
            `done-worktree: WARNING — ${D.assertNoLandedReversion.unsoundWarnBlock(unsound, { masterRef })}\n`,
          );
          D.spine.stepLog(
            state,
            `landed-reversion advisory UNSOUND (shallow clone, no culprits nameable): ` +
              `${unsound.length} file(s) — ${unsound.map((f) => f.path).join(', ')}`,
          );
        }
        if (sound.length) {
          // plan 3832: ADVISORY, never a halt. The land spine already runs the full backend AND
          // frontend vitest suites (`vitest-backend-full`, `vitest-frontend-full`), plus
          // Python-backend-scripts and scripts-battery, before anything reaches master —
          // which is exactly what caught the `_places_geo.py` reversion in the first place — so
          // a removal that actually costs behaviour reds those gates on its own. What this
          // block adds is the NAMES: which file, how much of master it drops, and the culprit
          // plans with their shas, printed where the operator is already reading the land log.
          //
          // Deliberately NOT gathered here any more: plan 3210's culprit-test EVIDENCE. Its
          // whole purpose was to inform a human RELEASE decision on a halt (VOUCHED → set the
          // scope-pinned flag), and with no halt there is no release to inform — running the
          // culprit plans' tests a second time would be pure cost on a path that now only
          // prints. `culpritTestTargets` / `runCulpritTests` / `culpritTestEvidence` stay in
          // the guard module, exercised by its own suite and gathered by its CLI's ordinary
          // (non---explain) run — `--explain` is a separate DISPLAY mode that returns before any
          // evidence is gathered, so a human who wants the VOUCHED table runs the bare CLI, and
          // uses `--explain <path>` for the dropped-line/successor pairing instead.
          //
          // plan 2917 T3′ (kept): pass the SAME pinned ref the probe compared against — plan
          // 2433's pin means this is usually a bare sha, and a message saying `origin/master`
          // would name a ref a sibling land may already have moved past.
          // STDOUT, not stderr, and that is load-bearing rather than stylistic: this is now
          // ordinary output of a SUCCEEDING land, and a land that succeeds is exactly where
          // stderr gets dropped — the seam it replaced was only ever read because a non-zero
          // exit made callers capture both streams (done-worktree.test.mjs's own `dryRunEnv`
          // merges stderr solely on the catch path, which is how this surfaced). An advisory
          // nobody reads is the same as no advisory.
          const advisory = D.assertNoLandedReversion.reversionPreflightReason(sound, { masterRef });
          process.stdout.write(`done-worktree: ADVISORY — ${advisory}\n`);
          D.spine.stepLog(
            state,
            `landed-reversion advisory (not a halt): ${sound.length} file(s) — ` +
              sound.map((f) => f.path).join(', '),
          );
        }
      }
    }
  }
  // plan 504: post-rebase spine step. plan 2485: a genuine PROGRESS stamp — the rebase
  // and its full pre-push gate battery are done and the merge is next, which is the
  // single largest real step this land takes. This is also the stamp that carries the
  // convergence clock across the merge window itself.
  queueHeartbeat(state, undefined, { progress: true });
  // plan 2463 D5 — the state-free backstop for the no-laundering invariant, at the LAST moment
  // before anything reaches master. `unstackSpeculativeBase` above is marker-driven and so is
  // blind to a stack whose marker was cleared, lost with MAIN/.scratch, or written by a re-cut
  // worktree; this asks git directly. Reaching here with a live sibling branch as an ancestor
  // that master does not contain means we are about to merge another plan's unlanded, unreviewed
  // work — refuse, loudly, rather than land it.
  if (!alreadyLanded) {
    const foreign = foreignStackedBranch(wtPath, branch, {
      speculated: Boolean(landSpecMarker.read(MAIN, slug)) || state.unstackedSpeculative === true,
    });
    if (foreign)
      throw new Error(
        `done-worktree: REFUSING to merge ${branch} — it descends from ${foreign}, a sibling ` +
          `worktree branch that origin/master does NOT contain (plan 2463 no-laundering ` +
          `invariant). Landing would carry that plan's unlanded, unreviewed commits onto ` +
          `master. Rebase this branch off it (\`git rebase --onto origin/master ${foreign}\`) ` +
          `+ force-push, then re-invoke.`,
      );
  }
  // 3c MERGE
  D.spine.stepLog(state, `merge: landing branch ${branch} onto master via an ephemeral worktree`);
  // plan 495: mergeToMaster re-asserts landability and wraps the post-merge ff-only.
  // A diverged SHARED local master (a sibling's commit appearing after preflight's
  // assertLandable) makes it throw a TYPED (.reason) error — convert it to a
  // recoverable LAND_BLOCKED seam instead of letting it escape to main() as a raw
  // stack trace. `unpushed-master` throws BEFORE the branch lands (no half-land);
  // `master-diverged-post-land` throws AFTER (branch already on origin — its message
  // carries the rebase-then-finish recovery). Untyped errors are genuine bugs → rethrow.
  try {
    // plan 3832: plan 3210 Part 3's "record stamp" (a granted LANDED_REVERSION release threaded
    // into the merge commit's own summary) is retired with the release it recorded — the lint
    // no longer halts, so no land is ever released past it and there is no justification to
    // preserve in git history. The merge summary is unconditional again.
    // plan 3972: pin the merge to the tip this land reviewed and gated — the worktree's HEAD,
    // which every marker and gate proof in this land keys on (the rebase path force-pushed it,
    // the fast path proved it, the sync skip verified origin/<branch> equals it). A branch tip
    // that moved on origin after that point is refused by land-lib, never merged `--no-verify`.
    // gpt-review 3972 r2 findings 69a219 / 7b4d9e: the pin is the tip PREFLIGHT validated
    // (state.preflightTip, re-proven at each spine-owned re-sha), never the live HEAD read
    // here — a commit made after preflight must not become its own expectation. Any drift is
    // the review seam: the new tip has to pass the marker preflight from the top.
    // DW_FAKE_HEAD_MOVED=1 (dry-run only) stands in for such a commit.
    const headNow =
      D.env.DRY && process.env.DW_FAKE_HEAD_MOVED === '1'
        ? '<moved-after-preflight>'
        : worktreeHeadSha(wtPath);
    if (state.preflightTip && headNow !== state.preflightTip) {
      D.spine.emitSeamWithMarkerTable(
        D.L.SEAM.REVIEW_NEEDED,
        D.L.preflightTipDriftReason(branch, slug, state.preflightTip, headNow),
        MAIN,
        slug,
        wtPath,
        cfg.handoffLayout,
        state,
      );
    }
    state.mergeSha = mergeToMaster(MAIN, branch, `done ${slug}`, {
      expectedHead: state.preflightTip || headNow,
    });
    D.spine.stepLog(state, `merge: landed as ${state.mergeSha}`);
  } catch (e) {
    // plan 1239: an ephemeral-merge CONFLICT (a whole-file data-file rewrite vs a sibling
    // data-file land, or a Fix-2 add/add batch-dir collision) is RECOVERABLE and must RETAIN the
    // slot — mirror the rebase seam's hold-through-conflict (LAND_BLOCKED_HOLDING), NOT the
    // generic LAND_BLOCKED below (which releases the slot). Left a raw throw it escaped to
    // main()'s finally → dequeueQueueIfHeld → the head slot was lost (the plan-1174 ~4× slot
    // loss). NAME the content-conflict recovery so the session resolves the CONTENT instead of
    // chasing the queue/
    // spine layer (the plan-1174 ~1h misdiagnosis). emitSeam(holding) process.exits without
    // demoting/dequeuing, so the LANDING mutex + board row + head slot all stay HELD.
    // plan 1239 (ephemeral-merge-conflict) and plan 2411 (ephemeral-push-nonff-exhausted, the
    // push-retry-loop twin) both seam LAND_BLOCKED_HOLDING (slot HELD) for the same underlying
    // reason: the branch is NOT on origin/master, so a raw crash here would release the slot
    // for no reason. MUST sit before the generic `e.reason` fall-through below: that branch
    // emits the slot-RELEASING LAND_BLOCKED seam, which is wrong for both these recoverable
    // cases. ONE shared dispatch (review fix, sonnet-review high, CONFIRMED — the two branches
    // were near-identical copies differing only in the reason-message call, which would have
    // silently drifted on any future change to the shared heartbeat/requeue/seam sequencing)
    // selects the reason text by e.reason; the sequencing itself is identical for both.
    if (
      e &&
      (e.reason === 'ephemeral-merge-conflict' || e.reason === 'ephemeral-push-nonff-exhausted')
    ) {
      queueHeartbeat(state); // stamp liveness — the 45-min steal clock keeps running
      // plan 1528 Phase B arm (a): an ephemeral-merge CONTENT conflict counts on the same
      // per-attempt conflict counter as the rebase seam — a second one (or the >8-min
      // head-hold arm) with waiters behind releases the head to the tail. plan 2432: the
      // push-EXHAUSTION twin does NOT — it burns a separate tally that feeds no conflict
      // arm (only the head-hold arm, via the time it actually costs the queue), because a
      // lost ff-only push race says nothing about this branch's content. plan 2453: the
      // discriminated reason IS the routing key — no boolean inversion at the call site.
      requeueOnConflictOrReturn(state, { reason: e.reason });
      const holdingReason =
        e.reason === 'ephemeral-merge-conflict'
          ? D.L.ephemeralMergeConflictReason(
              branch,
              state.lane,
              e.conflictDetail,
              e.culprits,
              e.conflictedPaths,
            )
          : D.L.ephemeralPushExhaustedReason(branch, state.lane, e.pushDetail);
      D.spine.emitSeam(D.L.SEAM.LAND_BLOCKED_HOLDING, holdingReason, state, {
        keepQueue: true,
        holding: true,
      });
    }
    // plan 3972: origin/<branch> no longer carries the tip this land reviewed — someone pushed
    // the branch after review. The branch is NOT on master, but this is not a hold-and-resume
    // case either: a `--resume LAND_BLOCKED_HOLDING` re-enters at the merge and would skip the
    // review/marker preflight the NEW tip needs, so the slot is RELEASED (plain LAND_BLOCKED) and
    // the session re-runs the land from the top, which re-judges the markers against the new tip.
    if (e && e.reason === 'branch-tip-moved') {
      D.spine.emitSeam(
        D.L.SEAM.LAND_BLOCKED,
        D.L.branchTipMovedReason(branch, slug, e.expectedHead, e.actualHead),
        state,
      );
    }
    // plan 495: unpushed-master / master-diverged-post-land are typed too (branch state per
    // their messages) — these keep the existing LAND_BLOCKED (slot-releasing) behaviour.
    if (e && e.reason) D.spine.emitSeam(D.L.SEAM.LAND_BLOCKED, `${e.reason}: ${e.message}`, state);
    throw e;
  }
  // 3d RELEASE CLAIM (plan 399) — the code is now on origin/master, so the
  // refs/claims/<id> lock has served its purpose. Release it HERE, before the
  // deploy-check / close-out, so a later seam, close-out push failure, or crash
  // can NEVER orphan the ref (the pre-399 release ran only after the close-out
  // push, leaking the lock on any failure between merge and push).
  releaseClaimAfterMerge(MAIN, state);
  // test-only fault injection (plan 399): a throw AFTER the merge+claim-release
  // but during the close-out — proves a post-merge failure can never orphan the
  // claim (it is already released) nor leave a half-archived INDEX on origin
  // (the archive is one atomic commit, not yet pushed at this point). Guarded by
  // env; never set in prod.
  if (process.env.DW_TEST_THROW === 'closeout') throw new Error('DW_TEST_THROW closeout injected');
}
