#!/usr/bin/env node
// scripts/done-worktree.mjs (plan 333)
// Single-call deterministic spine for done-worktree. One invocation runs
// preflight → lane merge → deploy check → close-out → teardown in ONE process
// and prints the step-12 report. It HALTS with `HANDOFF:<CODE>` + a nonzero
// exit ONLY at a genuine judgment fork (see done-worktree-lib.mjs SEAM/EXIT);
// the agent resolves that one thing and re-invokes with `--resume <CODE>`.
//
// Lanes (done-worktree-lib.detectLane):
//   free  (no seed)  → NO landing-lock, NO 🟢 LANDING row; merge via
//                      pull --ff-only + merge --no-ff + push, retry on non-ff.
//   seed  (touches the sharded seed data) → full mutex: landing-lock acquire →
//                      board LANDING → rebase → merge → push.
//
// HARD SAFETY INVARIANT (the "finally"): any exit while the seed mutex is held
// — success, seam, or throw — first demotes the board row + releases the lock,
// then surfaces. Never leave 🟢 LANDING on origin. See lib.mutexHeld.
//
// --dry-run prints the command sequence it WOULD run without touching git.
// Test-only diff override: DW_FAKE_DIFF=a,b,c sets the changed-files list so
// the dry-run is deterministic without a scratch repo (see done-worktree.test.mjs).

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { pwshExe as sharedPwshExe, pwshCandidates } from './coord/pwsh-exec.mjs';
import { unlinkNodeModulesJunction, disarmJunction } from './coord/junction-guard.mjs';
import { extractLocalImportTargets } from './coord/coord-share-lib.mjs';
import {
  readFileSync,
  lstatSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  openSync,
  closeSync,
  appendFileSync,
} from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  resolve as resolvePath,
  dirname as dirnamePath,
  basename as basenamePath,
  join as joinPath,
} from 'node:path';
// plan 2875 task 4 / cluster 6 (review fix): the land-time preflight and the mandatory
// pre-deploy gate's full-battery file list reuse nightly-windows-suite.mjs's listScriptsTestFiles
// (listTestFiles + its isFile() guard) directly rather than re-rolling a third private copy of
// "what counts as a battery test file" — the original plan-2875 header here explained that copy
// as avoiding a mid-flight coupling to a sibling worker's file on the SAME plan (task 3, then in
// progress concurrently); that file is done now, so the coupling this comment used to warn about
// no longer applies, and the two enumerators can drift no further apart than importing one of them
// allows.
// plan 2875 delta round 3 (finding b8d981/d83dbb): boundedAppend joins the existing import — the
// SAME cap nightly-windows-suite.mjs's own spawnQueuedCommand keys its output capture to, reused
// directly rather than a second hand-rolled unbounded `out += d`. Call-INTO only.
// plan 3827 operator ruling R1 (2026-09-09): `parseNodeTestFailures` no longer joins this import —
// the battery isolation recheck's failing-file localization now reads a structured reporter event
// stream (battery-ledger.mjs's `parseLedgerEvents`, imported below) instead of reconstructing a
// file from `node --test`'s own TAP/spec TEXT via this module's id-level grammar. It remains
// `nightly-windows-suite.mjs`'s own internal helper — R3 hands its follow-on plan the job of
// moving THAT module onto the same structured reporter and retiring it there.
// plan 4034 T3/T4: the two LAND gates' whole-run caps are derived, not the flat BATTERIES literals
// — `pytestRunCapMs` off the admitted xdist worker count, `batteryRunCapMs` off this run's own file
// count under one queue slot's worker budget. Both live beside the numbers they are derived from
// (see that module's own "the LAND gates' whole-run caps are DERIVED" note), never re-rolled here.
// Neither is imported HERE any more: the plan-3961 carve moved both derivations out with the gates
// that spend them, so this file names them only in prose. The two gates reach them DIFFERENTLY,
// and the difference is Rule 3, not taste — scripts/project/land-gate-pytest.mjs is a project
// module and imports `pytestRunCapMs` directly; scripts/coord/land/gates-runner.mjs is a CORE
// module, may import only scripts/coord/** and node: builtins, and so reads
// `D.scriptsBattery.batteryRunCapMs` off the container instead. Do not "restore" a direct
// import there: it loads fine locally and dies in the isolated-plan-repo scaffold, which runs a
// copy of this tree.
// plan 4096 T1: none of those three are imported here any more — the land spine is core and may
// not reach nightly-windows-suite.mjs (this repo's battery tooling). `listScriptsTestFiles` /
// `BATTERIES` reach the core as the project plugin's `scriptsBattery` container group (with a
// no-battery default in deps.mjs; named `nightlyWindowsSuite` until plan 4096 review b1f480),
// `boundedAppend` moved to scripts/coord/bounded-append.mjs, and the one name this file still
// reads, `normalizeTargetToPosix`, moved to scripts/coord/posix-target.mjs
// (nightly-windows-suite.mjs re-exports both).
import { normalizeTargetToPosix } from './coord/posix-target.mjs';
// plan 4003 T1: the queue's own admission contract — `runViaTestQueue` scans for the marker
// `queued-run.mjs` writes, `TEST_SLOT_ADMITTED_MARKER`, one spelling, defined once in the queue
// module. Its own name stays only in prose here, never re-imported as a value this file no longer
// reads directly: since the plan-3961 carve `runViaTestQueue` lives in
// scripts/coord/land/gates-runner.mjs, and a core module may not import scripts/coord/test-queue.mjs, so
// it reads both the marker and the scanner off the container's `testQueue` group (the whole
// namespace bound below) rather than through this import. plan 4006: the scanner that recognizes
// it moved to the same module (`makeAdmissionScanner`) so a second call site
// (nightly-windows-suite.mjs's spawnQueuedCommand) reuses it instead of a second hand-typed copy.
// plan 4034 T4: `perSlotWorkerBudget` joins it — the battery's derived land cap is sized off the
// worker budget ONE queue slot actually gets (plan 4003 T3's own choice, re-shipped here).
//
// plan 3961 review (rev-caps): the NAMED import that used to sit here is gone, which is what the
// paragraph above already claimed. All three of `slotAdmissionBackstopMs`, `makeAdmissionScanner`
// and `perSlotWorkerBudget` left this file with the gates that spend them, and every one of their
// call sites now reads `D.testQueue.<name>` off the container; the module itself is still loaded,
// by the `import * as testQueue` below that binds that very group. Carve residue, not a dependency.
// plan 4034 T4 (gpt-review r2): the ONE CPU probe. `perSlotWorkerBudget` declares no default for
// its `cpu`, and this is the same question pytest-workers.mjs already answers for the runner — a
// second copy here would let the cap and the run disagree about the box.
import { detectedCpuCount } from './coord/cpu-budget.mjs';
// plan 4034 T4: the battery cap's worker budget reads the box through THIS name. It survives the
// plan-3961 carve in the command file (rather than moving with the battery preflight) because
// `perSlotWorkerBudget` declares no default for its `cpu` and the carved gate runner reaches it
// through the deps container's `spine` group — one probe, one answer, whichever side asks.
export const landCpuCount = detectedCpuCount;
// plan 2875 delta round 2 (cluster D/E/G): the same whole-descendant-tree kill primitives
// nightly-windows-suite.mjs's own spawnQueuedCommand and queued-run.mjs's runQueued already use —
// reused directly rather than a third hand-rolled spawn+timeout+cleanup copy (the exact drift class
// this file's own kill-tree.mjs header warns about). Call-INTO only: this file never edits
// kill-tree.mjs.
import { spawnWithTreeKill, waitForExit, killProcessTree } from './coord/kill-tree.mjs';
import { resolveCommonDirPath } from './coord/lock-path.mjs';
// The one spelling of the ledger reporter's `--test-reporter` specifier, shared with its tests.
// plan 3374: the zero-progress trio — `readGreenSet` is how a round learns whether it proved
// anything NEW (the green count before the run vs after the merge, per the plan's own execution
// note: the COUNT, never the timestamp), and `readZeroRounds`/`recordChunkRound` persist the
// consecutive-zero tally on the same per-key ledger record, since each chunk round is a separate
// process and nothing in memory survives between them. `resolveLedgerDir` is imported rather than
// rebuilt from this file's dirname so the direct reads below can never address a different
// directory than the CLI subprocesses do. (plan 3961 T2.3: the pytest-only half of this import —
// resolvePytestLedgerEventSources/readPytestLedgerEventSources/parsePytestLedgerEventSources/
// stalledPytestFiles/slowDeselectedPytestFiles/greenPytestFiles/resolvePytestLedgerDir — moved
// with the pytest gate to land-gate-pytest.mjs, which imports them directly.)
import {
  REPORTER_SPECIFIER,
  readGreenSet,
  readZeroRounds,
  recordChunkRound,
  clearChunkRounds,
  parseLedgerEvents,
  toPosixRelative,
  // plan 4003, gpt-review r1 (1901ef): the ledger's own canonical set subtraction, reused by the
  // partial-proof derivation rather than hand-rolled beside it.
  remainingSelection,
  resolveLedgerDir,
  NON_CONVERGENT_ROUNDS,
} from './coord/battery-ledger.mjs';
// plan 2875 delta round 2 (cluster D): battery-lock's OWN wait ceiling — acquireBatteryLock's
// spawnSync timeout must clear it with headroom (see the constant's own comment). Call-INTO only.
// plan 2875 delta round 3 (finding 7884b6): effectiveAdmissionWaitSec joins the import — the
// CANONICAL admission-window clamp (see BATTERY_LOCK_ACQUIRE_TIMEOUT_MS's own comment), reused
// instead of a hand-copied "+600" that could silently fall behind a future retune of either the
// wait ceiling or the admission window.
import {
  MAX_TOTAL_WAIT_SEC as BATTERY_LOCK_MAX_TOTAL_WAIT_SEC,
  effectiveAdmissionWaitSec,
} from './coord/battery-lock.mjs';
import {
  resolveMain,
  sleepSync,
  coordRetry,
  GIT_NONINTERACTIVE_ENV,
  GIT_MAXBUFFER,
  masterPushSpec,
  reattachMainToMaster,
  probeIdentityFallbackEnv,
  lsRemoteTimed,
  healOwnWorktreeIndexLock,
  // plan 4042 (D-A tail, land-step carve): `errText` no longer has a bare call site in this file —
  // its only two call sites (the pre-build disk-headroom prune, the post-build `.next` cleanup)
  // moved to land-preflight-steps.mjs/land-gate-build.mjs, which import it directly from this
  // module instead.
} from './coord/coord-git.mjs';
import { installCoordRerouteOnce } from './coord/ensure-coord-reroute.mjs';
// plan 2218: teardown defers a LOCKED worktree dir to the idle sweep instead of
// retry-storming it (plan 2198 correlated the storms with the main-checkout store tears).
import { recordDeferredRemoval, runSweepAndReport } from './coord/sweep-deferred-worktrees.mjs';
import { loadCoordConfig, normalizeConfig } from './coord/coord-config.mjs';
// plan 3961 T1d: the land spine's extension-point registries. These three are PURE modules under
// scripts/coord/land/ with resolvable closures, so importing them here costs nothing.
//
// The `plugins.*` loader is deliberately NOT among them — see landRegistries() below for the
// measured reason and the decision it forced.
//
// ⚠ AND NOTE HOW THAT LOADER IS NAMED THROUGHOUT THIS FILE — as `scripts/land-plugins` with NO
// extension, never as the full filename. That is not style. `closurePathsForSelection` treats a
// quoted `<name>.mjs` token as a possible spawn target (plan 2578's library-held-CLI-constant
// rule), including one sitting in a COMMENT, so merely naming a file whose own closure is
// unresolvable widens this file's pass-cache key — and the spine's closure is 173 files deep into
// unrelated selections. Writing the loader's full filename in a comment here is enough, on its
// own, to turn the battery pass-cache's own name-paired test red and block the push. The same
// applies to that test file, which is why it too is named without its extension below.
import {
  buildRegistries,
  selectPrepGates,
  prepGateStage,
  // plan 4066 task 2a: `runContextExtras` is GONE — its only call site (the former "SEED GATE
  // VIEWS" block) was inside phasePreflight, which moved whole to spine.mjs; spine.mjs imports
  // it directly from this same module. plan 4066 task 2b: `runStepRegistry` is GONE too — its
  // only call sites (phaseDeployCheck's postMerge run, phaseCloseOut's closeOutExtras run) moved
  // whole to spine.mjs alongside them; spine.mjs imports it directly from this same module too.
} from './coord/land/registry.mjs';
import { coreGates } from './coord/land/gates-core.mjs';
import { coreSeams, seamResult } from './coord/land/seams-core.mjs';
// plan 3961 T3.1: the close-out phase — see close-out.mjs's own header for what moved and why.
// `closeOut` is called by this file itself (below); the other ten names this carve moved
// (archiveBatchMembers, archiveBatchFolder, boardRemoveIdempotentBatch, boardHasRow,
// spineCarryForwardBody, verifyCloseOutOnOrigin, promoteWaitingBlocked, and — plan 4066 task 2a —
// `readBoardFile`/`resolveBatchLandingRow`/`recoverBatchStateFromPriorSidecar`, whose only call
// sites were inside phasePreflight, now moved whole to spine.mjs) have no caller left in this
// file, so plan 3961 T4 dropped this file's re-export bridge for them — done-worktree.test.mjs
// now imports all ten directly from close-out.mjs, and spine.mjs imports the three phasePreflight
// used directly from close-out.mjs too.
import { closeOut } from './coord/land/close-out.mjs';
// plan 1455 review-fix: rowSlugFromIndex moved to done-worktree-lib.mjs (next to its sole input
// buildPlanIdIndex) so claim-plan.mjs's derail can reuse it without importing this heavy module.
// Re-exported here so existing importers (done-worktree.test.mjs) keep resolving it from this
// file. plan 3961 T3.1: this line itself stays here rather than moving with the rest of the
// close-out phase to close-out.mjs — a core module under scripts/coord/ may import only
// scripts/coord/** and node: builtins (Rule 3), so it cannot re-export directly from
// done-worktree-lib.mjs the way this command file can; close-out.mjs's own code already reaches
// it as `D.L.rowSlugFromIndex`.
export { rowSlugFromIndex } from './coord/done-worktree-lib.mjs';
// plan 3961 T3.2: the teardown phase (+ the --finish-close-out resume path) — see teardown.mjs's
// own header for what moved and why. `gatherCloseOutFacts` has no call site left in this file,
// only in done-worktree.test.mjs, but stays a plain import here rather than moving to a bare
// "export ... from" re-export the way the other four carves' test-only names did — plan 3961 T4
// dropped this file's re-export bridge for `gatherCloseOutFacts`/`runFinishCloseOut` regardless;
// done-worktree.test.mjs now imports both directly from teardown.mjs. plan 4066 task 2a: `teardown`
// and `runFinishCloseOut` are GONE from this import too — their only call sites were inside
// phasePreflight (the `finishTeardown` closure, and the `--finish-close-out` early return), both
// moved whole to spine.mjs (imported back below); spine.mjs imports `teardown` directly from this
// same module, and `runFinishCloseOut` is a plain sibling-core reach it already needed too.
import { gatherCloseOutFacts } from './coord/land/teardown.mjs';
// plan 3961 T3.3: the queue lifecycle (enqueue, heartbeat, recovery ladder, prep dispatch,
// requeue, rework, the land-attempt sidecar) — see queue.mjs's own header for the full list
// and why each piece moved. tryReclaimStrandedLandLock, dequeueQueueIfHeld, queueHeartbeat,
// heartbeatDiscoveredQueueSlot, markQueueHolding, preQueueFreshen, queueEnqueueAndGate,
// readLandAttempt, landAttemptPath, queueStatusView and
// requeueOnConflictOrReturn are called by this file itself (main() and its helpers, still in this
// file; `writeLandAttempt` is read by this file's own `tallyLockRetry`).
// makeQueueHeartbeatStamper has no call site left in this file, only in
// done-worktree.test.mjs, but stays a plain import here too — plan 3961 T4 dropped this
// file's re-export bridge for it and writeLandAttempt plus queueViewShowsRealSlot, recentEnqueueAttempt,
// RECOVERY_VERBS, and recoveryLadderForTick (which this file never imported at all);
// done-worktree.test.mjs now imports all six directly from queue.mjs, alongside landAttemptPath
// which it always could have (this file's own plain import already covers it).
import {
  tryReclaimStrandedLandLock,
  dequeueQueueIfHeld,
  queueHeartbeat,
  heartbeatDiscoveredQueueSlot,
  makeQueueHeartbeatStamper,
  markQueueHolding,
  preQueueFreshen,
  queueEnqueueAndGate,
  landAttemptPath,
  readLandAttempt,
  writeLandAttempt,
  queueStatusView,
  requeueOnConflictOrReturn,
} from './coord/land/queue.mjs';
// plan 3961 T3.4: the head-lock mechanics (worktree lock take/renew/drop, the at-head acquire
// with preemption, the wait tally, the same-PC mutex release) — see head-lock.mjs's own header
// for the full list and why each piece moved. Every name below is called by this file itself
// (renewOrAbort/WorktreeLockLost — the not-yet-carved prep-gates machinery — plus
// releaseMutexIfHeld's own two remaining call sites elsewhere in this file); none of these has a
// done-worktree.test.mjs direct-import case, so this move needs no re-export bridge (see
// head-lock.mjs's header, EXPORTS paragraph).
import {
  releaseMutexIfHeld,
  worktreeLockFor,
  takeWorktreeLock,
  // plan 4066 task 2a: `dropWorktreeLock`/`acquireWorktreeBeforePreflight` are GONE — their only
  // call sites were inside phasePreflight, which moved whole to spine.mjs; spine.mjs now imports
  // both directly from this same module. plan 4066 task 2b: `releaseHeldSlotBestEffort` is GONE
  // too — its only call sites were inside main(), which moved whole to spine.mjs alongside
  // phasePreflight; spine.mjs now imports it directly from head-lock.mjs itself instead (a
  // sibling reach — head-lock.mjs already exported the name for other core modules).
  rebaseHeadHoldClock,
  renewOrAbort,
  WorktreeLockLost,
  acquireWorktreeLockAtHead,
} from './coord/land/head-lock.mjs';
// plan 3961 T3.4b: the queue-waiter pre-convergence probe (preconvergeProbe, attemptPreconverge)
// and the plan-2463 speculative-stacking no-laundering guards (speculationQueueView,
// unstackSpeculativeBase, foreignStackedBranch) — see queue-probe.mjs's own header for the full
// list and why each piece moved. `speculationQueueView` is called by this file itself
// (attemptSpeculativeStack's own read); preconvergeProbe and attemptPreconverge are called only by
// queue.mjs's queueEnqueueAndGate (a sibling-to-sibling import there), so neither is imported
// here. plan 4066 task 2a: `unstackSpeculativeBase` is GONE — its only call site was inside
// phasePreflight, which moved whole to spine.mjs (imported back below); spine.mjs imports it
// directly from this same module. `foreignStackedBranch` stays imported though this file has no
// bare call site for it either (pre-existing, not this move's to touch).
import { speculationQueueView, foreignStackedBranch } from './coord/land/queue-probe.mjs';
// plan 3961 T3.5: the gate-proof/cache/registry-lookup machinery (Zone C) plus the
// scripts-battery/build/prettier gate internals and chunk-round scoring (Zone D) — see
// gates-runner.mjs's own header for the full list and why each piece moved. Every name below is
// called by this file itself (the not-yet-carved phasePreflight/main()/attemptSpeculativeStack/
// runLandPrepLocked machinery, spineBag(), coreGateImpls(), or the T2.2 no-start cluster) — plan
// 3961 T4 dropped the eight Zone D names that were NOT (batteryLockAcquireTimeoutMs,
// LEDGER_SALVAGE_FLOOR_MS, batteryRoundGreen, batteryFailureReportFromEvents,
// BATTERY_ISOLATION_MAX_FILES, filterToKnownBatteryFiles, batteryIsolationRecheck,
// batteryUnprovenFiles) from this import entirely, along with the bare re-export bridge that used
// to stand just after it — done-worktree.test.mjs now imports those eight, plus the thirteen
// Zone D names this file DOES still call, directly from gates-runner.mjs.
import {
  cachedCliRun,
  landGateProven,
  onceProvenSkip,
  // plan 4066 task 2a: `hydrateLandGatesProven`, `landSeamCheck`, `runLandSeamStep`, and
  // `runPreflightGates` are GONE from this import — their only call sites were inside
  // phasePreflight, which moved whole to scripts/coord/land/spine.mjs (imported back below via
  // the `phasePreflight` import); spine.mjs now imports all four directly from this same module.
  // plan 4042 (D-A tail, land-step carve): `prepGateRun` stays — spineBag() still hands it to the
  // deploy postMerge entry's own market-copy prepGate call (see that group's own comment below).
  // `prepGateApplies`/`recordLandGateProven`/`recordLandGatePartialProven` are gone: their only
  // call sites were inside the pytest/battery land steps, which now import all three directly from
  // their own project modules instead. `runPrepGateLifecycle` is gone too: its only two call sites
  // (the build/mobile land steps) moved to land-gate-build.mjs/land-gate-mobile.mjs, which import
  // it directly from this same module instead.
  prepGateRun,
  prepGateEnvDrift,
  flushLandGateProofBuffer,
  landGateDeltaPaths,
  landGateRemainderPaths,
  runPrepGates,
  runViaTestQueue,
  scopedGateSelection,
  gateCacheCheck,
  gateCacheClose,
  resolveHeadOid,
  scoreChunkRound,
  clearChunkRoundsSafe,
  ledgerRemainderCount,
  ledgerSubprocessTimeoutMs,
  ledgerSalvageTimeoutMs,
  LEDGER_CLI,
  QUEUED_RUN_CLI,
  runFullBatteryPreflight,
  runBuildPreflight,
  runBuildPreflightCached,
  runFullBatteryPreflightCached,
  runPrettierDriftCheck,
  readNoStartTally,
  writeNoStartTally,
  noStartTallyKey,
  noStartSidecarPath,
  formatGateOutcomeLine,
  chunkGateStartDecision,
  noStartGateResult,
  recordNoProgressRound,
  activeChunkWallVar,
} from './coord/land/gates-runner.mjs';
// plan 3961 T3.6: the worktree-HEAD reads (with their DRY fakes), the rebase/sync-skip
// primitives, the land-prep/land-spec scratch-marker quartet, and the two speculative-stacking
// git-history primitives moved to scripts/coord/land/rebase-sync.mjs — see that file's own
// header for the full list and why each piece moved. Every name below is still called by this
// file itself (phasePreflight/phaseLaneMerge/main and their not-yet-carved helpers —
// evaluateLandFastPath, attachmentRefusal, clearSpeculativeStackForPrep, attemptSpeculativeStack,
// runLandPrepLocked, isBranchAlreadyLanded, spineBag(), and phaseLaneMerge itself, until T3.6b
// carves it out too); `armDryMidPassTip` is the one exported name with no caller left in this
// file (only gates-runner.mjs's runPrepGates calls it, a sibling-core-module reach that needs no
// re-import here), so it is not imported back. `worktreeMutationKind` was also re-exported below
// for done-worktree.test.mjs, until plan 3961 T4 dropped that bridge — done-worktree.test.mjs now
// imports it directly from rebase-sync.mjs, the same module this file's own import already reads
// it from.
import {
  worktreeMutationKind,
  // plan 4042 (seed-gate-views contextExtras entry): `mergeBaseRef`'s one call site in this file
  // moved to land-gate-seed.mjs's `runSeedGateViewsContextExtra`, which imports this same name
  // directly from rebase-sync.mjs (pure, no spine dependency) — so it is no longer imported here.
  // plan 4066 task 2a: `changedFiles`/`worktreeHeadSha` stay imported here too — spineBag()'s own
  // bag (read by project modules through the injection bag, not the container) still carries both
  // as members, so this file needs its own binding even though phasePreflight's/
  // isBranchAlreadyLanded's bare call sites moved with them to spine.mjs (which imports both
  // directly from this same module for its own separate use).
  changedFiles,
  tryRebase,
  SYNC_SITE,
  trySkipSync,
  logSyncSkipped,
  landPrepMarker,
  landSpecMarker,
  isAncestor,
  commitParents,
  originMasterTip,
  worktreeHeadSha,
  armDryRebasedTip,
  headShaAfterGate,
  prepPassEndSha,
  prepMarkerStampSha,
  remoteBranchTip,
} from './coord/land/rebase-sync.mjs';
// plan 3961 T3.6b: the lane-merge phase (merge to master, claim release, resume-graft holds)
// moved to scripts/coord/land/lane-merge.mjs — see that file's own header for the full list and
// why each piece moved. plan 4066 task 2a: the preflight phase (argv parsing through the
// context-extras/prep-gates registry run) moved to scripts/coord/land/spine.mjs — see that
// file's own header for the full list of what moved and what stayed behind; its private helpers
// (`canonicalSlugFromBranch`/`landGateRoster`/`seedLaneInputs`) reach each other same-module
// there, so none of the three is imported back — done-worktree.test.mjs /
// the worktree-resolve test import each directly from spine.mjs instead. plan 4066 task
// 2b: `main()` itself — the five-phase driver, plus the deploy-check/close-out/teardown phases —
// moved to spine.mjs too, so `phasePreflight` and `phaseLaneMerge` are GONE from this file's own
// imports: main() now calls both same-module, inside spine.mjs, exactly as it already reached
// phasePreflight there. Only `main` is imported back, for the entrypoint guard's own call.
import { main } from './coord/land/spine.mjs';
// plan 4042: the keep-hot `--prep` orchestration cluster (runLandPrep, runLandPrepNoRebase,
// restorePrepAttachment, clearSpeculativeStackForPrep, attemptSpeculativeStack, runLandPrepLocked)
// moved to scripts/coord/land/preflight.mjs — see that file's own header for the full list and why
// each piece moved. `runLandPrep` is called by this file's own main() (imported back); none of its
// private cluster has a done-worktree.test.mjs direct-import case, so this move needs no re-export
// bridge.
// plan 4042 T2: the preflight-markers/repin cluster and the `preflight()` state machine itself
// joined the same module (see preflight.mjs's own header). plan 4066 task 2a: every name this
// import used to carry for phasePreflight's/main()'s own bare call sites (`runLandPrep`,
// `preflight`, `armRetainedEntryHeartbeat`, `unpushedMasterRetryClears`, `recordedReviewMarker`,
// `makeSeamTimeMarkerRepin`, `recordedFindings`, `planExistsAtLand`, `makeSeedOnlyDelta`,
// `recordPreflightMarkers`, `emitReworkHaltWithRelease`) is GONE — phasePreflight moved whole to
// spine.mjs (imported back below), which imports every one of them directly from this same
// module instead. Three remain, none for a bare call site of their own:
// `recordedConclusionVerdict` (the conclusion-review marker reader, declared as that seam's own
// `markerFamily.lookup` in coreSeamImpls() below), and `repinAndReprove`/`worktreeMutationInProgress`
// (the bindLandDeps() call below still needs a local binding to pass into the `spine` group for
// their OUTSIDE consumers — lane-merge.mjs/queue.mjs/queue-probe.mjs for `repinAndReprove`,
// queue-probe.mjs for `worktreeMutationInProgress`). `emitSeamWithMarkerTable` stays too, for the
// SAME reason (lane-merge.mjs's two outside call sites through the `spine` group) — spine.mjs
// imports it again directly, for its own now-only remaining bare call site (the review marker).
import {
  recordedConclusionVerdict,
  repinAndReprove,
  worktreeMutationInProgress,
  emitSeamWithMarkerTable,
  prepGatePredicates,
} from './coord/land/preflight.mjs';
// plan 4066 task 2a: `isBatchSlug` (owned by claim-plan-lib.mjs, single "batch-" prefix
// authority) is GONE from this file's own imports — its only call site was inside phasePreflight,
// which moved whole to spine.mjs (imported back below); spine.mjs imports it directly.
// plan 3961 T3.1: makeArchiveIsShipped / tailOnlyBlockedByLines / rewriteFirstBlockedByLine (all
// promoteWaitingBlocked's) moved off this plain import with the close-out phase itself — they now
// reach it via the `blockedByLib` namespace import + dependency container (D.blockedByLib.*).
// plan 4066 task 2a: `resolveManifestRel`/`newManifestRel` (batch-paths.mjs) are GONE from this
// file's own imports — their only call sites were inside readBatchManifest/phasePreflight, both
// moved whole to spine.mjs (imported back below); spine.mjs reaches both through the
// `batchPaths` container group (the namespace import below still binds it for that).
import { splitBoard, findRowLineIndex } from './coord/board-lib.mjs';
import { slugFromBranch } from './coord/redgreen-lib.mjs';
// plan 3295 E5: the ONE normalizing reader for the per-plan `landGate:` tier (see its own header
// for why it is narrower than the raw STAMP_KEYS scalar beside it). plan 4066 task 2a:
// `readLandGate` (read-plan-stamps.mjs) is GONE from this file's own imports — its only call site
// was inside planLandGateFor, which moved whole to spine.mjs; spine.mjs reaches it through the
// `readPlanStamps` container group (the namespace import below still binds it for that).
// plan 3295 (review fix): the battery selector's own "run FULL" exit code, imported rather than
// restated — the spine has to tell that VERDICT apart from the selector failing to run at all.
// Import-safe: the CLI half of that module is behind a `process.argv[1]` main guard.
import { EXIT_RUN_FULL as SELECT_BATTERY_EXIT_RUN_FULL } from './coord/select-battery-tests.mjs';
// plan 2328: the priority feed-through reads the plan's `priority: high` frontmatter
// stamp at enqueue time — the ONE shared frontmatter parser (same as queue-drain's).
// plan 3961 T3.1: assertEvidenceFloorOk / cloudExecUnstampedWarning / specReviewGateError /
// READY_FOLDER / WAITING_DATE_FOLDER / WAITING_BLOCKED_FOLDER / MUTATION_BANNER_LABEL /
// MUTATION_BANNER_FLAG / isWaitingFolder moved off this plain import — the close-out phase that
// used them now reaches them via the `buildIndexLib` namespace import + dependency container
// (D.buildIndexLib.*) instead. ARCHIVE_FOLDER and isHighPriorityTier stay: both are still used
// directly elsewhere in this file.
import { isHighPriorityTier, ARCHIVE_FOLDER } from './coord/build-index-lib.mjs';
// plan 3832: the landed-reversion lint is ADVISORY here — it names what a land removes from
// master, and never halts. So the spine imports the DETECTOR and its two renderers, and nothing
// else: plan 3210's culprit-test evidence gatherer and the whole scope-pinned release apparatus
// (`ESCAPE_HATCH_ENV`, `computeReversionRelease`, the three `--allow-landed-reversion*` flags and
// their argv scanner, the override trailer) were retired with the halt they existed to release.
import {
  detectLandedReversion,
  reversionPreflightReason,
  unsoundWarnBlock,
} from './coord/assert-no-landed-reversion.mjs';
import {
  landBranchViaEphemeral,
  mergeTreeWriteTree, // plan 3972: the clean-merge half of the coordination-only sync skip
  assertLandable,
  mergeBranchToMaster,
  syncBranchOntoMaster,
  branchAlreadyLanded,
  landedMergeSha,
  recoverRebasedUnpushed,
  inspectRebasedUnpushed,
  rangePatchIdOnce,
  graftedForeignCommits,
  isRetryablePushFailure,
  // plan 3974 fix (gpt-review j0j1ng/6wn6nm): the ONE shared rebase/am/merge state probe —
  // land-lib.mjs is the correct home (done-worktree-lib.mjs already imports it, so a shared probe
  // has to live on this side of that edge). Replaces the hand-rolled duplicate below.
  rebaseStateDir,
  mergeHeadExists,
  // plan 3974 round 2 (gpt-review 69df5c/bb3c7a/a0f071/a400a4/9d27ba/382952/ffe707): the
  // provenance marker syncBranchOntoMaster writes right before its own `git rebase <onto>` and
  // clears on every classified exit — resumableSpineRebase below reads it as the proof a leftover
  // rebase-merge belongs to the spine, and preflight clears a stale one (marker present, no
  // rebase state left) on its way through.
  readSpineRebaseMarker,
  clearSpineRebaseMarker,
  // plan 3974 round 3 (gpt-review c8c57e): the stale-marker sweep in preflight must delete a
  // marker only on POSITIVE proof no rebase state exists — `rebaseStateDir(...) === null` is
  // fail-open (also what a failed `rev-parse --git-path` probe returns) and must never drive a
  // delete.
  rebaseStateKnownAbsent,
  // plan 3974 round 4 (gpt-review 98caaf/25c270/246be0/2974e2/ba4258): the pre-queue freshen's
  // own "is anything already in progress" gate must be fail-CLOSED (stand down on "unknown"), not
  // fail-open like `worktreeMutationKind` — see preQueueFreshen's own comment for why.
  mutationKnownAbsent,
} from './coord/land-lib.mjs';
import * as L from './coord/done-worktree-lib.mjs';
// plan 4021: imported straight from its home module (not re-exported through done-worktree-lib).
import {
  pickMarkerSourceEntry,
  resolveSessionChainOverRefs,
  originFirstCandidates,
  grepOrNoMatch,
  isFsPathAbsentError,
} from './coord/review-markers.mjs';
// plan 3961 T2.0a: the PURE half of the chunk-gate timing subsystem, moved out behaviour-identical
// — see chunk-gate.mjs's own header for what stayed behind and why (the impure no-start/ledger
// half needs run/DRY/worktreeHeadSha, which are spine globals until T3).
// plan 4042 (D-A tail, land-step carve): `monotonicNowMs`/`landPreflightChunkOptions` no longer
// have a bare call site in this file — their only call sites (the build/mobile land steps) moved
// to land-gate-build.mjs/land-gate-mobile.mjs, which import both directly from this module instead
// (land-gate-mobile.mjs already imported `monotonicNowMs` for its own chunked wrapper).
import {
  chunkGateConfig,
  preQueueFreshenStandDown,
  processChunkDeadlineEpoch,
  processChunkCapMsNow,
  resetProcessChunkDeadlineForTest,
  isSpawnTimeout,
  BUILD_GATE_TIMEOUT_MS,
  chunkCapDecision,
  chunkCapMsAfterElapsed,
  chunkReportDetail,
  nonConvergentReportDetail,
  roundProvedSomethingNew,
  parsePrepushPositiveInt,
} from './coord/land/chunk-gate.mjs';
// plan 4096 T1: every `./project/*` import that used to stand here — the prepGate roster
// (land-gates.mjs), the mobile/build/battery/pytest gate modules, the two preflight steps, the
// seed-gate context extra, the status-flip/wiki-checkpoint seams, the deploy wall and the wiki
// coverage sweep — is GONE. The project layer is an optional plugin now: ONE module,
// scripts/project/land-plugin.mjs, loaded by a guarded dynamic import beside landRegistries()
// below, returns those registrations as data and its container groups for bindLandDeps(). The
// run-land-tests.mjs import that sat here had no call site left in this file (its PYTEST_FAILED
// parsing moved with the pytest gate), so it went too.
// plan 3815: the disk-headroom module's IO exports. done-worktree.mjs already performs IO
// everywhere, so importing these here (rather than into done-worktree-lib.mjs, which stays
// pure/IO-free per its own header) is the correct seam — see disk-headroom.mjs's own header for
// why the module itself stays dependency-free.
// plan 4042 (D-A tail, land-step carve): `pruneNext`/`checkFreeBytes`/`formatBytes` no longer have
// a bare call site in this file — their only call sites (the pre-build prune's floor check, the
// build gate's post-green `.next` cleanup) moved to land-preflight-steps.mjs/land-gate-build.mjs,
// which import them directly from this module instead. `prune` stays: `pruneCloudDiskHeadroom`
// below (the one function this carve could NOT move — see land-preflight-steps.mjs's own header
// for why) still calls it.
import { prune as diskHeadroomPrune } from './coord/disk-headroom.mjs';
// plan 2654 review [14]: resolveWorktree parses the porcelain once and hands the entries to both
// resolvers. plan 4066 task 2a: `parseWorktreePorcelain`'s own plain import is GONE — resolveWorktree
// moved whole to spine.mjs, which reaches it through the `worktreePorcelain` container group (the
// namespace import below still binds it for that).
import { spawnDetachedWorktreeChild } from './coord/spawn-detached-worktree-child.mjs';
// plan 3375: --finish-close-out reuses reconcile-worktree-branches' READ-ONLY detectors as its
// state oracle rather than re-deriving "which folder is this plan in / is this claim still held"
// a second time (the spec-pass ruling on this plan). Import-safe: that module only runs its CLI
// under the standard entrypoint guard.
import {
  buildPlanFolderIndex,
  listPlanPathsAtOriginMaster,
  listRemoteClaimIds,
} from './coord/reconcile-worktree-branches.mjs';
// plan 2085 r2 [6]: the near-head sleep clamp derives from the demote threshold itself.
import {
  DEFAULT_DEMOTE_STALE_MIN,
  stealLocallyEligible,
  // plan 2334: the local pre-checks for the other three ladder rows — the heartbeat-age twins
  // of stealLocallyEligible, plus overtake's state/lane predicate (review [1]: every row's
  // rule lives in the lib, so none is the odd one out). See the RECOVERY_VERBS table.
  demoteLocallyEligible,
  overtakeLocallyEligible,
  reapLocallyEligible,
  HOLDING_STATE,
  IN_LAND_STATE,
  parseQueue, // plan 3375: --finish-close-out reads the FIFO doc to see its slot
} from './coord/landing-queue-lib.mjs';
// plan 3973: the queue doc lives on the coord ref refs/heads/coord/landing-queue; the ONE reader
// is this accessor (no fetch here — mirrors the previous origin/master read, which relied on the
// fetch the close-out already ran).
import { readQueueDoc } from './coord/landing-queue-ref.mjs';
// plan 3961 T3.1: clampOverlongArchiveBullets / stampArchivedStatus / stampHeartbeatRun /
// stampPromotedStatus / stampWaitingOperatorStatus / setStatusLine / setUnblock / carryForwardSlug
// moved off these plain imports with the close-out phase — they now reach it via the
// `indexLib` / `planBodyState` / `drainRun` namespace imports + dependency container
// (D.indexLib.*, D.planBodyState.*, D.drainRun.*).
// plan 1011 Phase 0: telemetry-only recorder for the plan-972 fast-path outcome (never throws).
import { recordLandPrepOutcome, rotateIfOver } from './coord/coord-metrics.mjs';
// plan 2875 delta round 3 (finding aa5711/e6c44f): DEFAULT_STALE_MIN joins the import — the seed
// landing lock's own stale-reclaim threshold, one of the two outer windows
// BATTERY_LOCK_ACQUIRE_TIMEOUT_MS is reconciled against below (its own comment explains why).
import { ageMinutes, DEFAULT_STALE_MIN } from './coord/landing-lock.mjs';
// plan 3961 T3.1: readyCostBannerError / describeAdoptAction / syncAdoptBranchStamp /
// originExecutedPlanIds / ensureExecModelForExemptMechanical / stampedRelForExecModel moved off
// these plain imports with promoteWaitingBlocked — they now reach it via the `planCostBanner` /
// `planAdoptBranch` / `queueDrain` / `execModelStamp` namespace imports + dependency container.
// Review fix (plan 3111 round 3, finding 1): the promoted plan body is replaced ATOMICALLY —
// a truncating write inside the close-out spine can land a torn plan in ready/.
import { atomicWriteTextSync } from './coord/atomic-write.mjs';
// Review fix round (2943+2944, F6): the SAME shared evidence-floor gate move-plan → ready/ and
// next-plan-id --ready (F5) use, so this THIRD live writer into ready/ (promoteWaitingBlocked's
// auto-promotion) cannot bypass 2943's acceptance either. assertEvidenceFloorOk throws on a
// violation; promoteWaitingBlocked converts that into a WARN-and-leave-parked, mirroring the
// bannerErr arm immediately above its call site — never a throw (a throw here would abort the
// close-out spine mid-land, the failure mode the bannerErr arm was written to avoid).
// Review fix round (2943+2944, R9/C2): imported directly from build-index-lib.mjs (the leaf that
// actually OWNS the predicate, per R7) rather than through move-plan.mjs — a heavyweight command
// module this file has no other reason to import. See the `isHighPriorityTier` import above,
// which already reaches the same leaf.
import { sanctionedRebaseEnv } from './coord/pre-rebase-main-guard.mjs'; // plan 2933
// plan 2473: the worktree-scoped ownership handshake that makes a spine-side land-prep dispatch
// safe — the prep child and the head-time rebase/merge can no longer operate on one working tree
// at the same time. See scripts/coord/worktree-lock.mjs's header for the model.
// plan 2875 delta round 3 (finding aa5711/e6c44f): WORKTREE_LOCK_MAX_HOLD_MS joins the import — the
// worktree lock's own staleness ceiling, the other outer window BATTERY_LOCK_ACQUIRE_TIMEOUT_MS is
// reconciled against below.
// plan 3961 T3.4: resolveWorktreeLockPath/acquireWorktreeLock/renewWorktreeLock/
// releaseWorktreeLock/readWorktreeLockEntry/terminateWorktreeLockHolder dropped off this plain
// import with the head-lock.mjs carve — that module already had the WHOLE namespace via the
// `worktreeLock` deps-container group (`import * as worktreeLock from './worktree-lock.mjs'`
// below), so its own six became `D.worktreeLock.<name>` with no new group needed.
// `describeWorktreeLockHolder` stays here for now: `attemptPreconverge` (queue-probe.mjs, T3.4b)
// still calls it directly from this file. `worktreeLockIsLive` is unreferenced anywhere in this
// file (pre-existing, out of this move's scope).
import {
  worktreeLockIsLive,
  describeWorktreeLockHolder,
  WORKTREE_LOCK_MAX_HOLD_MS,
} from './coord/worktree-lock.mjs';
// plan 4066 task 2b: the bare `import { coordinationSessionId } from './coord/coord-session-id.mjs'`
// that used to sit here is GONE — its only call site was main()'s own nested-runtime-ownership
// refusal, which moved whole to spine.mjs; that module already reaches the same function via
// `D.coordSessionId.coordinationSessionId()`, the plain container-group shorthand this file's
// own `import * as coordSessionId from './coord/coord-session-id.mjs'` below still provides.
// plan 4096 T1: the hobby-env load (plan 2955) moved into scripts/project/land-plugin.mjs.

// plan 3961 T3.0: namespace imports of the plain scripts/*.mjs modules above, ADDED alongside the
// existing named imports (never swapped in — every current call site keeps reading its own named
// binding, byte-identical). These namespaces are the dependency-container groups bindLandDeps()
// assembles below: a core module under scripts/coord/land/ may import only scripts/coord/** and
// node: builtins (Rule 3), so it reaches these plain modules only by reading them off the bound
// container at call time, never by importing them directly. Group keys are the mechanical
// camelCase of each module's basename (`coord-git.mjs` → `coordGit`); `done-worktree-lib.mjs` is
// the one exception, staying `L` — it is already namespace-imported above (import * as L …), and
// 389 existing `L.x` call sites make `L` a rename target for later T3 steps, not a fresh name.
import * as pwshExec from './coord/pwsh-exec.mjs';
import * as junctionGuard from './coord/junction-guard.mjs';
import * as coordShareLib from './coord/coord-share-lib.mjs';
import * as testQueue from './coord/test-queue.mjs';
import * as killTree from './coord/kill-tree.mjs';
import * as lockPath from './coord/lock-path.mjs';
import * as batteryLedger from './coord/battery-ledger.mjs';
import * as batteryLock from './coord/battery-lock.mjs';
import * as coordGit from './coord/coord-git.mjs';
import * as ensureCoordReroute from './coord/ensure-coord-reroute.mjs';
import * as sweepDeferredWorktrees from './coord/sweep-deferred-worktrees.mjs';
import * as coordConfig from './coord/coord-config.mjs';
import * as claimPlanLib from './coord/claim-plan-lib.mjs';
import * as blockedByLib from './coord/blocked-by-lib.mjs';
import * as batchPaths from './coord/batch-paths.mjs';
import * as boardLib from './coord/board-lib.mjs';
import * as redgreenLib from './coord/redgreen-lib.mjs';
import * as readPlanStamps from './coord/read-plan-stamps.mjs';
import * as selectBatteryTests from './coord/select-battery-tests.mjs';
import * as gatePassCache from './coord/gate-pass-cache.mjs';
import * as buildIndexLib from './coord/build-index-lib.mjs';
import * as assertNoLandedReversion from './coord/assert-no-landed-reversion.mjs';
import * as landLib from './coord/land-lib.mjs';
import * as diskHeadroom from './coord/disk-headroom.mjs';
import * as worktreePorcelain from './coord/worktree-porcelain.mjs';
// aliased: the named import above already binds `spawnDetachedWorktreeChild` at module scope.
import * as spawnDetachedWorktreeChildNs from './coord/spawn-detached-worktree-child.mjs';
import * as reconcileWorktreeBranches from './coord/reconcile-worktree-branches.mjs';
import * as landingQueueLib from './coord/landing-queue-lib.mjs';
import * as landingQueueRef from './coord/landing-queue-ref.mjs';
import * as indexLib from './coord/index-lib.mjs';
import * as planBodyState from './coord/plan-body-state.mjs';
import * as drainRun from './coord/drain-run.mjs';
import * as coordMetrics from './coord/coord-metrics.mjs';
import * as landingLock from './coord/landing-lock.mjs';
import * as landingQueueWatch from './coord/landing-queue-watch.mjs';
import * as planCostBanner from './coord/plan-cost-banner.mjs';
import * as planAdoptBranch from './coord/plan-adopt-branch.mjs';
import * as queueDrain from './coord/queue-drain.mjs';
import * as atomicWrite from './coord/atomic-write.mjs';
import * as execModelStamp from './coord/exec-model-stamp.mjs';
import * as preRebaseMainGuard from './coord/pre-rebase-main-guard.mjs';
import * as worktreeLock from './coord/worktree-lock.mjs';
import * as coordSessionId from './coord/coord-session-id.mjs';
import { bindLandDeps, landDeps, withProjectGroups } from './coord/land/deps.mjs';
// plan 4096 T1: the guarded optional-import seam the project plugin is loaded through.
import { importOptional } from './coord/optional-import.mjs';
// plan 4066 task 0: the member-level container net — asserted right after bindLandDeps() below
// binds the real container, so a mis-named container member throws a named refusal at boot,
// before any land phase runs, instead of surfacing as a plain `undefined` deep inside a gate or a
// halt seam. See container-manifest.mjs's own header for why the assertion lives in one
// aggregator rather than inside each core module.
import { assertContainerManifests } from './coord/land/container-manifest.mjs';

const DRY = process.argv.includes('--dry-run');
// plan 2473: this invocation is a `--prep` pass, not a land. Read from argv (not the parsed args)
// because the guards that need it — writeResultSidecar above all — run outside main()'s scope.
const IS_PREP = process.argv.includes('--prep');
// plan 3503: this is deliberately read beside IS_PREP rather than through main()'s parsed args.
// The no-rebase prep mode changes orchestration helpers outside main's local argument scope.
const PREP_NO_REBASE = process.argv.includes('--no-rebase');

// EXPORTED for tests (plan 3225 review round 2): the null-return coercion below is a real
// contract several best-effort callers depend on, and a test that re-implements it in a probe
// script guards a copy rather than this function. done-worktree.mjs already exports ~25 internals
// for exactly this reason.
export function run(cmd, args = [], opts = {}) {
  if (DRY) {
    process.stdout.write(`DRY ${[cmd, ...args].join(' ')}\n`);
    return '';
  }
  const { env, ...rest } = opts;
  const out = execFileSync(cmd, args, {
    encoding: 'utf8',
    // plan 844/850: a large-data land (the multi-page render store, 11k+ changed files) makes
    // `git diff --name-only` etc. exceed execFileSync's 1MB default stdout buffer → ENOBUFS crash
    // mid-spine. Use the shared GIT_MAXBUFFER; a caller can still override via opts (spread below).
    maxBuffer: GIT_MAXBUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...rest,
    // plan 810: suppress the GCM interactive credential dialog on every child the spine spawns —
    // git children pop it (the plan-774 mid-merge crash class); harmless on node/pwsh/hostname.
    // Spread LAST so the suppression is forced regardless of a caller-supplied env.
    // plan 2604: spawnEnv merges the layers over process.env and scrubs the RESULT, so the
    // in-process-only hatches (CHILD_ENV_STRIP) cannot be re-supplied by a later layer.
    env: L.spawnEnv(env, GIT_NONINTERACTIVE_ENV),
  });
  // plan 3225 (review finding, class fix): execFileSync returns NULL — not a string — whenever the
  // caller's own `stdio` (spread above, so it wins) does not CAPTURE stdout: `stdio: 'ignore'`, or
  // an explicit slot 1 of 'ignore'/'inherit'. The previous unconditional `.trim()` therefore threw
  // a TypeError on every such call. That failure is pathologically quiet: execFileSync has already
  // run the child to completion before returning, so the command's real work is done and only the
  // return value is lost — and every one of these callers wraps the call in a best-effort
  // `try/catch`, which then swallows the throw. It looks exactly like success.
  //
  // Found on plan 3225's own new carry-forward call sites, but plan 3223's `merge`/`pytest-merge`
  // calls (`stdio: 'ignore'`, this file) were silently doing it too. Fixing the ONE helper is what
  // makes the class go away instead of the two instances a reviewer happened to look at; a caller
  // that deliberately discards output now gets '' — the honest value — rather than a crash.
  return typeof out === 'string' ? out.trim() : '';
}

// plan 810: the child env for the spine's index.lock-retrying direct git spawns (gitMain /
// pushMaster / hasStagedChanges, which bypass run()). Carries the GCM-dialog suppression so a
// land's fetch/push can never pop the interactive credential dialog (the plan-774 crash class).
// plan 2604: this is the seam the DETACHED LAND-PREP child and the head-time push both use —
// the two children whose `.husky/pre-push` battery the inherited hatch would poison. (The
// spec-pass listed a third seam that turned out, with the file open, to be `detachedWaitRefusal`
// reading env as DATA for a usage refusal, not a spawn; gitEnv() is the real one.) Why the scrub
// belongs at the seam and matches case-insensitively: scripts/coord/child-env.mjs.
const gitEnv = () => L.spawnEnv(GIT_NONINTERACTIVE_ENV);

// PowerShell executable resolution (plan 389, carry-forward from 378). The teardown shells
// out to PowerShell for process-kill, memory-reclaim and the forced dir-removal — it
// hardcoded `pwsh` (PowerShell 7+), which ENOENTs on hosts that only ship Windows
// PowerShell 5.1 (`powershell.exe`). Resolution + memoization live in the shared
// scripts/coord/pwsh-exec.mjs seam (plan 2405); the DRY short-circuit stays here since DRY is
// this file's own module state.
// plan 4061 T3: the candidate ORDER is supplied by this caller rather than imported by the
// resolver. Plan 3962 Decision 5 relocated `pwshCandidates()` itself out of the land spine
// (`L`) into `pwsh-exec.mjs`, where it now lives beside `pwshExe()` — this caller still
// supplies the value explicitly, it just imports it from its new home.
function pwshExe() {
  if (DRY) return 'pwsh'; // dry-run: keep the greppable label, never probe
  return sharedPwshExe({ candidates: pwshCandidates(process.platform) });
}

// plan 793 test hook: DW_FAKE_FOREIGN_DIRT="<prefix>:<n>" makes the first <n> node() calls
// whose "script args…" join STARTS WITH <prefix> throw a coordWrite foreign-dirt-shaped refusal,
// then succeed — so the dry-run suite exercises the post-merge retry/seam without a real sibling
// edit in the shared main checkout. e.g. "board.mjs remove:2" (retry-then-succeed) or
// "board.mjs remove:999" (exhaust → clean COORD_CONTENTION seam). Per-process counter.
// Honoured ONLY under --dry-run (like DW_FAKE_REBASE/BUILD/MOBILE) — a leaked env var must NEVER
// inject fake foreign-dirt into a real production land.
const _fakeForeignDirt = (() => {
  if (!DRY) return null;
  const m = process.env.DW_FAKE_FOREIGN_DIRT?.match(/^(.*):(\d+)$/);
  return m ? { prefix: m[1], remaining: Number(m[2]) } : null;
})();

// plan 971: while the post-merge close-out runs in the ephemeral finish worktree, every
// coord subprocess (board/queue/mint/move-plan) must mutate THAT worktree, not the shared
// main checkout — set via COORD_MAIN_DIR (resolveMain honours it). Null outside the
// close-out phase (and always in DRY, where the finish worktree collapses to <main>), so
// the dry-run trace is byte-identical to before.
let _coordMainDir = null;

// node helper for our own scripts/*.mjs (keeps the strings greppable in dry-run)
const node = (script, ...args) => {
  if (_fakeForeignDirt && _fakeForeignDirt.remaining > 0) {
    if ([script, ...args].join(' ').startsWith(_fakeForeignDirt.prefix)) {
      _fakeForeignDirt.remaining--;
      throw new Error(
        `coordWrite(fake): refusing to run — the main checkout has uncommitted changes to ` +
          `tracked file(s) OUTSIDE this tool's pathspec:  M handoff/sessions/fake-sibling.md`,
      );
    }
  }
  const opts = _coordMainDir ? { env: { COORD_MAIN_DIR: _coordMainDir } } : {};
  return run('node', [`scripts/${script}`, ...args], opts);
};

// plan 665 G4.1: the terminal-result sidecar. Written on EVERY real exit path (seam,
// success, GATE-abort, crash) to a deterministic `.scratch/done-worktree-<slug>.result.json`
// BEFORE any process.exit, so a DETACHED caller can read the TRUE outcome regardless of the
// process exit code / stdout capture (the plan-662 false-failure: a killed --wait reported exit
// 255 with empty output though the land had completed). A recorded `mergeSha` is the proof that
// the branch reached master — consumed by the G4.2 stale-lock reclaim. Best-effort: a write
// failure never blocks/aborts the land. No-op in --dry-run (a real-run diagnostic only).
function writeResultSidecar(state, { code, exitCode }) {
  // plan 2473: a `--prep` pass is NOT a land and must never write the land's terminal sidecar.
  // Both processes key on the same slug, so a prep child that seams before reaching the `--prep`
  // return (a PREFLIGHT_FAIL, an assertLandable stop) would stamp `done-worktree-<slug>.result.json`
  // with ITS outcome — and that file is exactly what a detached caller reads to learn the TRUE
  // result of the LAND (plan 665 G4.1), regardless of the exit code it saw. The hazard predates
  // this plan (the keep-hot watcher spawns the same child), but this plan takes prep dispatch from
  // ~never to ~every waiting land, which is what turns a latent mislabel into a live one. The
  // prep's own outcome is its exit code plus its per-slug log; it needs no sidecar.
  if (IS_PREP || DRY || !state || !state.slug || !state.main) return;
  try {
    mkdirSync(`${state.main}/.scratch`, { recursive: true });
    writeFileSync(
      `${state.main}/.scratch/done-worktree-${state.slug}.result.json`,
      JSON.stringify(
        {
          slug: state.slug,
          code: code ?? null, // seam code, or 'SUCCESS' / 'CRASH'
          exitCode: exitCode ?? 0,
          lane: state.lane,
          mergeSha: state.mergeSha, // non-null ⇒ the land reached/passed the merge
          landingClaimed: state.landingClaimed,
          landingReleased: state.landingReleased,
          // plan 850: the per-step booleans let a recovery reader see HOW FAR a CRASH got — a
          // crash with mergeSha+planArchived+closedOut but a teardown error reads as "landed,
          // teardown incomplete" (re-run finishes it), never "nothing merged" (hand-merge).
          claimReleased: state.claimReleased,
          planArchived: state.planArchived, // archive basename once the plan file was git-mv'd to archive/
          // plan 1364 Ship 3: member ids + per-member disposition for a batch land, so a resumed
          // session (or a human reading the sidecar) can see what the close-out actually did without
          // re-deriving it — null for a single-plan land.
          batch: state.batch
            ? {
                members: (state.batch.manifest && state.batch.manifest.members) || [],
                dispositions: state.batch.dispositions || [],
                // plan 1508 review fix (F1): the board row slugs THIS close-out believed it removed
                // — recovered on a bare re-invoke whose manifest is already git-rm'd (see main()'s
                // batch detection), so a retry after CLOSEOUT_UNVERIFIED can still verify the SAME
                // rows instead of silently computing an empty check set.
                rowSlugs: state.batch.rowSlugs || [],
              }
            : null,
          closedOut: state.closedOut, // close-out commit on origin/master
          dequeued: state.dequeued, // FIFO landing-queue slot released
          deployStatus: state.deployStatus,
          // plan 3781 T3: the pytest isolation recheck's own findings, when it ran and had
          // something to report — see pytestRedIsFlake. `undefined` (dropped by
          // JSON.stringify, not `[]`/`false`) when no gate produced a file list, so "we did
          // not learn it" stays distinguishable from "there were none".
          failingFiles: state.failingFiles,
          isolationTimedOut: state.isolationTimedOut,
          // plan 3972: true when a branch sync was skipped on a coordination-only master delta —
          // read together with phases[] (no `rebase:` line, a `sync: skipped` one instead).
          syncSkipped: state.syncSkipped === true, // the FINAL decision (an at-head rebase resets it)
          syncSkipSites: state.syncSkipSites || { preQueue: false, atHead: false },
          // plan 2443: ordered step boundaries with per-step wall-clock. `elapsedMs` is the
          // whole invocation; each phase's `sincePrevMs` is the cost of the step that ENDED at
          // it. The two that plan 2443 measured for: `rebase: branch synced …` (the .husky
          // pre-push gate battery) and `merge: landed as …` (the ephemeral merge worktree's
          // full-tree checkout + merge + push). Read them with
          // a project-side land-duration measurement tool for the history side, this for the split.
          elapsedMs: _stepLogT0 == null ? null : Date.now() - _stepLogT0,
          phases: _stepPhases,
          host: state.host,
          pid: process.pid,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch {
    /* sidecar is best-effort diagnostics — never block/abort the land on a write failure */
  }
}

// Read another land's terminal sidecar (the G4.2 stale-lock reclaim proof). null when absent
// or unparseable — the caller then treats the holder's completion as UNproven and does not steal.
function readResultSidecar(main, slug) {
  try {
    const p = `${main}/.scratch/done-worktree-${slug}.result.json`;
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
}

// plan 3961 T3.3: tryReclaimStrandedLandLock (the stranded-landing-lock reclaim) moved to
// scripts/coord/land/queue.mjs — see that file's own header for what moved and why.

// Regenerate docs/INDEX.md's GENERATED active region from `git ls-files` (plan
// 399). Run AFTER the plan-file `git mv` is staged so ls-files already reflects
// the move (the now-archived plan drops out of the active region), and the result
// is staged into the SAME close-out commit — so INDEX can never be stale relative
// to the file location at push time. build-index resolves its repo root from its
// OWN file location, so invoke MAIN's copy explicitly (cwd-independent); the dry
// label stays greppable for the spine tests.
function regenIndex(MAIN) {
  run('node', [DRY ? 'scripts/build-index.mjs' : `${MAIN}/scripts/build-index.mjs`]);
}

// plan 3961 T3.6b: releaseClaimAfterMerge moved to scripts/coord/land/lane-merge.mjs
// (module-private there — its only caller, phaseLaneMerge, moved with it) — see that file's
// own header.

// plan 960 test hook: DW_FAKE_INDEX_WRITE="<prefix>:<spec>" makes gitMain ops whose
// "args…" join STARTS WITH <prefix> inject a TRANSIENT index-write failure, so the dry-run
// suite exercises gitMain's retry + the close-out half-land tolerance without a real disk fault.
//   "<prefix>:<n>"     → throw the transient on the first <n> matching ops, then succeed
//                        (retry-then-clear: proves gitMain rides through the transient).
//   "<prefix>:halfland"→ throw the transient ONCE, then throw "nothing to commit" forever
//                        (models a `git commit` that half-landed: commit object created, index
//                        unwritten → the retried commit finds nothing staged; the close-out
//                        commit catch must tolerate it and push the locally-created commit).
// Honoured ONLY under --dry-run (like DW_FAKE_FOREIGN_DIRT) — a leaked env var must NEVER inject
// a fake fault into a real production land. Per-process counter.
const _fakeIndexWrite = (() => {
  if (!DRY) return null;
  const m = process.env.DW_FAKE_INDEX_WRITE?.match(/^(.*):(\d+|halfland)$/);
  if (!m) return null;
  const numeric = /^\d+$/.test(m[2]);
  // numeric mode: `remaining` transients then succeed. halfland mode: `step` counts the two
  // halfland events (1 = transient, 2 = "nothing to commit"), then it stays a no-op forever — so a
  // later same-prefix gitMain call in the same run is NOT spuriously failed (it models exactly ONE
  // half-landed commit, not a permanently-armed fault).
  return { prefix: m[1], halfland: !numeric, remaining: numeric ? Number(m[2]) : 0, step: 0 };
})();
const TRANSIENT_INDEX_WRITE_MSG =
  'fatal: repository has been updated, but unable to write new index file.\n' +
  'Check that disk is not full and quota is not exceeded, and then "git restore --staged :/" to recover.';
function maybeFakeIndexWrite(args) {
  const f = _fakeIndexWrite;
  if (!f || !args.join(' ').startsWith(f.prefix)) return;
  if (f.halfland) {
    f.step++;
    if (f.step === 1) throw new Error(TRANSIENT_INDEX_WRITE_MSG); // the half-land transient
    if (f.step === 2) throw new Error('nothing to commit, working tree clean'); // retried commit: already landed
    return; // both halfland events fired → no-op (don't stay armed for unrelated later ops)
  }
  if (f.remaining > 0) {
    f.remaining--;
    throw new Error(TRANSIENT_INDEX_WRITE_MSG);
  }
}

// plan 983 test hook: DW_FAKE_REF_LOCK="<prefix>:<n>" makes gitMain ops whose "args…" join STARTS
// WITH <prefix> inject the ref-lock race (`cannot lock ref 'HEAD': is at X but expected Y`) on the
// first <n> matching ops, then succeed — modelling a sibling moving local HEAD during the close-out
// commit's ref-write, so the dry-run suite exercises gitMain's ref-lock retry without two real
// concurrent processes. No "halfland" mode: a ref-lock failure means the commit did NOT land (the
// CAS failed), so there is nothing already-committed to tolerate — the retry simply re-commits on the
// now-current HEAD. Honoured ONLY under --dry-run; per-process counter.
const _fakeRefLock = (() => {
  if (!DRY) return null;
  const m = process.env.DW_FAKE_REF_LOCK?.match(/^(.*):(\d+)$/);
  if (!m) return null;
  return { prefix: m[1], remaining: Number(m[2]) };
})();
const REF_LOCK_RACE_MSG =
  "fatal: cannot lock ref 'HEAD': is at fc5b3e209abc but expected 2d025363cdef";
function maybeFakeRefLock(args) {
  const f = _fakeRefLock;
  if (!f || !args.join(' ').startsWith(f.prefix)) return;
  if (f.remaining > 0) {
    f.remaining--;
    // Emit an observable marker so the spine test can assert the fault ACTUALLY fired the expected
    // number of times — guarding against a silent no-op (null _fakeRefLock from a !DRY regression, or
    // a prefix that stops matching) turning the ref-lock retry test into a false green.
    process.stdout.write('DRY DW_FAKE_REF_LOCK injected on close-out commit\n');
    throw new Error(REF_LOCK_RACE_MSG);
  }
}

// $MAIN git mutation with index.lock retry — this repo is worked from ~5-7
// parallel sessions sharing one .git, so a bare `git add/commit` can lose the
// per-repo index.lock race (observed repeatedly). Mirrors scripts/coord/git-safe.mjs.
// plan 502: exponential backoff (~24s total, lib schedule) — the old flat 9×300ms
// (2.7s) budget was routinely exhausted at peak 6–7-session contention, and the
// raw throw escaped main() as a stack trace. Exhaustion is now a TYPED (.reason)
// error so the merge step's typed-error catch seams (LAND_BLOCKED) instead.
// plan 960: also retry a TRANSIENT index-WRITE failure (`unable to write new index file`) on the
// SAME backoff — git acquired the lock fine and DID the work, only the final `.git/index` write
// failed (a brief Windows AV/file-lock on the index). Pre-960 this escaped gitMain immediately and
// crashed the close-out AFTER the merge had landed, leaking the worktree (the 2026-06-22 plan-948/
// 959 crashes). The two non-idempotent ops it can hit — the close-out `git commit` and the archive
// `git mv` — tolerate their post-retry "already done" signal at their call sites (isNothingToCommit
// / isMvBadSource); idempotent ops (`git add`) simply re-run. The DRY echo lives INSIDE the loop so
// the dry-run fault-injection above can drive the retry path deterministically.
// plan 983: ALSO retry a TRANSIENT ref-lock race (`cannot lock ref 'HEAD': is at X but expected Y`)
// — a sibling session moved local HEAD between this commit's HEAD-read and its ref-write, so the
// commit did NOT land; the retry re-reads the now-current HEAD and succeeds (the ref-write analogue
// of the index.lock retry). plan 2471: ALSO retry the fetch-side analogue (`fetching ref … failed:
// incorrect old value provided`) — a sibling advanced origin/master between gitMain's fetch's read
// and write of the remote-tracking ref; the retry re-fetches against the now-current value. The
// optional `opts.env` merges over gitEnv() so a caller can add
// `HUSKY: '0'` to a specific commit (the close-out) — keeping lint-staged from running mid-commit and
// WIDENING that very race window — without disabling the GCM-suppression env or affecting other ops.
export function gitMain(MAIN, args, { env: extraEnv } = {}) {
  for (let i = 0; ; i++) {
    try {
      maybeFakeIndexWrite(args); // dry-run only (no-op unless DW_FAKE_INDEX_WRITE is set)
      maybeFakeRefLock(args); // dry-run only (no-op unless DW_FAKE_REF_LOCK is set)
      if (DRY) {
        // plan 983: surface opt-in env (e.g. HUSKY=0 on the close-out commit) in the dry-run trace
        // so the spine test + an operator reading the trace can SEE which commit suppresses husky.
        // The `git -C <MAIN> <args>` tail stays byte-identical to run()'s echo (empty prefix → no
        // change), so the existing trace-matching tests are unaffected.
        const envPrefix = extraEnv
          ? Object.entries(extraEnv)
              .map(([k, v]) => `${k}=${v} `)
              .join('')
          : '';
        process.stdout.write(`DRY ${envPrefix}git -C ${MAIN} ${args.join(' ')}\n`);
        return '';
      }
      // plan 1455 review-fix: inject the coord-git identity fallback on an identity-less host so the
      // land's merge + close-out commits (both routed through gitMain, not coord-git's git()) SUCCEED
      // instead of `fatal: empty ident name`. probeIdentityFallbackEnv returns null when a real
      // user.name/user.email is configured — then this spreads nothing and authorship is untouched.
      // Precedence mirrors coord-git.git(): process.env < fallback < extraEnv (a caller that supplies
      // its own GIT_AUTHOR_* still wins) < GIT_NONINTERACTIVE_ENV (forced last).
      const identityFallback = DRY ? null : probeIdentityFallbackEnv(MAIN);
      return execFileSync('git', ['-C', MAIN, ...args], {
        encoding: 'utf8',
        maxBuffer: GIT_MAXBUFFER, // plan 844/850: large-data lands overflow the 1MB default
        stdio: ['ignore', 'pipe', 'pipe'],
        // plan 810: GCM-dialog suppression; plan 983: opt-in extraEnv (HUSKY=0 on the close-out).
        // GIT_NONINTERACTIVE_ENV is LAST so the dialog suppression is FORCED regardless of a
        // caller's extraEnv (matches coord-git's git() discipline — a future caller can't re-enable
        // the GCM prompt by accident); extraEnv still wins over the earlier layers.
        // plan 2604 round-3 review: this used to spread `...gitEnv()` and then layer extraEnv on
        // top — a scrubbed object used as a BASE, which is the same defect as the two earlier cuts
        // and left extraEnv able to re-supply the hatch. spawnEnv takes the LAYERS, so that
        // mistake is not expressible here.
        env: L.spawnEnv(identityFallback, extraEnv, GIT_NONINTERACTIVE_ENV),
      }).trim();
    } catch (e) {
      const msg = `${e.stderr || ''}${e.message || ''}`;
      if (
        L.isIndexLockContention(msg) ||
        L.isTransientIndexWrite(msg) ||
        L.isRefLockRace(msg) ||
        L.isRefUpdateRace(msg)
      ) {
        if (i < L.LOCK_RETRY_DELAYS_MS.length) {
          if (!DRY) sleepSync(L.LOCK_RETRY_DELAYS_MS[i]); // dry-run injection clears instantly
          continue;
        }
        throw L.markLockExhausted(e, msg);
      }
      throw e;
    }
  }
}

// Push master with a non-fast-forward retry. Since plan 355 the actual branch
// MERGE happens in an ephemeral worktree (landBranchViaEphemeral); pushMaster is
// now called ONLY by closeOut for the doc-only close-out commit (archive rename +
// INDEX + session flip — all auto-allowed paths). On rejection (a parallel session
// pushed first) replay our doc commit onto the moved tip with a PLAIN rebase —
// NO autostash. closeOut commits its doc files via explicit pathspec, and the
// preflight assertLandable guard guarantees the tree carries no foreign unmerged
// paths, so a plain rebase cannot hit the autostash-pop wedge (the 2026-06-04
// failure class). A genuinely dirty tree makes the rebase refuse loudly — which
// is the intended behaviour: a residual wedge becomes a visible stop, never a
// silent compound. Returns master's tip sha.
function pushMaster(MAIN) {
  if (DRY) {
    run('git', ['-C', MAIN, 'push', 'origin', 'master']);
    return '<dry-sha>';
  }
  // plan 971: when the close-out runs in the ephemeral detached finish worktree, HEAD is
  // detached → push `HEAD:master` (a bare `push origin master` would push the shared local
  // master ref, not our commit). On the main checkout this is exactly `master` — unchanged.
  const spec = masterPushSpec(MAIN, gitEnv());
  for (let i = 0; ; i++) {
    try {
      execFileSync('git', ['-C', MAIN, 'push', 'origin', spec], {
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: GIT_MAXBUFFER, // plan 850: a large push's progress on stderr can overflow the 1MB default
        env: gitEnv(), // plan 810: GCM-dialog suppression on the close-out push
      });
      return execFileSync('git', ['-C', MAIN, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        maxBuffer: GIT_MAXBUFFER, // plan 850: uniform with the rest of the spine's git runners
        env: gitEnv(),
      }).trim();
    } catch (e) {
      if (i < 4 && isRetryablePushFailure(e)) {
        execFileSync('git', ['-C', MAIN, 'fetch', 'origin', 'master'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: GIT_MAXBUFFER, // plan 850: a large fetch's progress on stderr can overflow the 1MB default
          env: gitEnv(), // plan 810: GCM-dialog suppression on the non-ff re-fetch
        });
        execFileSync('git', ['-C', MAIN, 'rebase', 'origin/master'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: GIT_MAXBUFFER, // plan 850
          // plan 2933: the THIRD sanctioned rebase-retry loop on the shared MAIN checkout —
          // missed by the first pass's grep because it spawns execFileSync directly instead of
          // going through gitWithLockRetry, and found by review. Without the exemption the
          // pre-rebase guard fires on every done-worktree non-ff retry.
          //
          // Composed THROUGH spawnEnv, not `{ ...gitEnv(), ...extra }` — spreading the RESULT
          // of a scrub leaves whatever is layered on afterwards unscrubbed, which is the
          // plan-2604 round-3 gitMain bug verbatim and is banned by name in
          // done-worktree.test.mjs's env-composition guard (it caught this exact shape here).
          // GIT_NONINTERACTIVE_ENV stays LAST so the dialog suppression is forced, matching
          // the identityFallback call site above.
          env: L.spawnEnv(sanctionedRebaseEnv(), GIT_NONINTERACTIVE_ENV),
        });
        continue;
      }
      throw e;
    }
  }
}

// plan 651: are any of `paths` staged in MAIN's index? `git diff --cached --quiet`
// exits 0 (clean) / 1 (staged diffs present). On a FULLY-completed-then-interrupted
// re-run (crash during teardown after the close-out already committed+pushed) every
// close-out step is a no-op, so the pathspec-scoped close-out commit would have nothing
// staged → a bare `git commit` exits 1 "nothing to commit" → gitMain rethrows → the
// re-run crashes before teardown (the step that still needed finishing). closeOut uses
// this to SKIP the commit+push when nothing is staged. Conservative on any non-clean
// exit (treat as "has changes" → commit), so a genuine problem still surfaces normally.
function hasStagedChanges(MAIN, paths) {
  try {
    execFileSync('git', ['-C', MAIN, 'diff', '--cached', '--quiet', '--', ...paths], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: gitEnv(), // plan 810: uniform GCM-dialog suppression on every git child
    });
    return false; // exit 0 → nothing staged in these paths
  } catch {
    return true; // exit 1 (staged diffs) or any other error → commit (fail-safe)
  }
}

// plan 960: is THIS plan's close-out commit at HEAD? The AUTHORITATIVE signal that the close-out
// `git commit` half-landed (commit object created, then the transient index-write failed). The
// close-out commit subject is `docs(plans): done <slug> — …`; the merge commit's is `done <slug>`
// (mergeToMaster) — distinct prefixes, so this never mistakes the merge for the close-out commit.
// Used to GATE the isNothingToCommit tolerance: "nothing to commit" + commit-at-HEAD ⇒ a genuine
// half-land (push the locally-created commit); "nothing to commit" WITHOUT the commit at HEAD ⇒ the
// commit never landed (e.g. a hypothetical staged drain) → surface the error, never silently push a
// land that is missing its archive/INDEX/session close-out commit. Conservative: any git failure
// reading HEAD → false → the caller rethrows (the safe direction).
function closeOutCommitAtHead(MAIN, slug) {
  try {
    const subj = execFileSync('git', ['-C', MAIN, 'log', '-1', '--format=%s'], {
      encoding: 'utf8',
      maxBuffer: GIT_MAXBUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnv(),
    }).trim();
    return subj.startsWith(`docs(plans): done ${slug}`);
  } catch {
    return false;
  }
}

// plan 793: the ONE choke point for every coordWrite-backed bookkeeping shell-out on the
// post-merge / mutex-release path (board remove, board demote, queue dequeue). The `wait` it
// hands coordRetry is forced TRUE once the merge has landed (state.mergeSha): post-merge the
// land is IRREVERSIBLE, so a sibling session's TRANSIENT foreign-dirt in the shared main
// checkout MUST be retried through (it clears in seconds when the sibling commits) — never a
// hard crash that strands the FIFO queue head + seed mutex + board LANDING row (the 2026-06-18
// session-718 strand of plan 788). PRE-merge it preserves the --wait gating: there a foreign-
// dirt refusal is most often the OPERATOR's own uncommitted edit, where coordWrite's immediate
// hard-stop ("commit/stash, then re-run") is correct. On the retry budget being exhausted
// (a sibling genuinely left an edit uncommitted) coordRetry throws { coordContention } → main()'s
// catch converts it to a CLEAN, resumable COORD_CONTENTION seam (disposition 'archive' once
// merged — the branch is on origin, only bookkeeping remains). DW_FAKE_FOREIGN_DIRT shrinks the
// backoff so the dry-run suite exercises retry+exhaust in milliseconds, not the ~20s real budget.
function coordStep(state, fn, label) {
  const wait = Boolean(state.wait) || Boolean(state.mergeSha);
  const opts = { label };
  if (_fakeForeignDirt) {
    // dry-run only (_fakeForeignDirt is null unless --dry-run): shrink the backoff so the
    // node:test suite exercises retry+exhaust in ms, not the ~20s real budget.
    opts.sleep = () => {};
    opts.attempts = 3;
  }
  return coordRetry(wait, fn, opts);
}

// plan 1454: the board slug the 🟢 LANDING marker is set/demoted on. A single-plan land
// uses its own row (state.slug === the plan slug). A BATCH land has no batch-slug board row —
// its members are member-keyed rows — so it uses the representative member row resolved at
// batch setup (state.batch.landingRowSlug); the batch-slug fallback preserves the prior
// (crashing-then-tolerated) behaviour only if no member row could be resolved.
export function landingBoardSlug(state) {
  return (state.batch && state.batch.landingRowSlug) || state.slug;
}

// plan 3961 T3.4: releaseMutexIfHeld moved to scripts/coord/land/head-lock.mjs (imported back
// above) — see head-lock.mjs's own header.

// plan 3961 T3.3: dequeueQueueIfHeld moved to scripts/coord/land/queue.mjs (imported back
// below, and imported directly by close-out.mjs) — see queue.mjs's own header.

// plan 3961 T3.4: releaseHeldSlotBestEffort moved to scripts/coord/land/head-lock.mjs (imported
// back above) — see head-lock.mjs's own header.

// plan 3961 T3.3: the queue-heartbeat subsystem (bestEffortQueueCall, queueHeartbeat,
// queueViewShowsRealSlot, heartbeatDiscoveredQueueSlot, recentEnqueueAttempt,
// makeQueueHeartbeatStamper, and their private budgets) moved to
// scripts/coord/land/queue.mjs — see that file's own header.

// plan 3961 T3.3: the waiter-side auto-recovery ladder (markQueueHolding, markQueueInLand,
// attemptClearHolding, attemptAutoRecovery, RECOVERY_VERBS, recoveryLadderForTick) moved to
// scripts/coord/land/queue.mjs — see that file's own header.

// plan 3961 T3.4b: preconvergeProbe (+ its private `_preconvergeCache`) moved to
// scripts/coord/land/queue-probe.mjs — see that file's own header.

// plan 3961 T3.4: the worktree-scoped prep ⇄ land ownership handshake (HEAD_LOCK_WAIT_MS,
// HEAD_LOCK_POLL_MS, PREEMPT_GRACE_MS, HEAD_LOCK_PREEMPT_RESERVE_MS,
// HEAD_LOCK_INDETERMINATE_POLLS, the head-lock-wait sidecar constants,
// readHeadLockWaitTally/writeHeadLockWaitTally) moved to scripts/coord/land/head-lock.mjs — see
// that file's own header.

// plan 3961 T3.4: heldWorktreeLocks (the const Map, mutated never reassigned) and the
// lock-release half of the exit hook below moved to scripts/coord/land/head-lock.mjs, which now
// registers its OWN `process.on('exit', …)` listener for that half at import time — see that
// file's own header, "THE EXIT-HOOK SPLIT" paragraph, for the registration-order reasoning.
// plan 2992: the disarm function for armRetainedEntryHeartbeat's interval, if armed this
// invocation — cleared here for the exact same reason heldWorktreeLocks (now head-lock.mjs's)
// was: a seam halt / crash / PREFLIGHT_FAIL calls process.exit() directly (skipping any
// `finally`), so this exit hook is the one place guaranteed to run before the process actually
// dies. Without it, an orphaned interval could keep ticking a dead land's queue entry looking
// alive, defeating demote/steal/reap on a genuinely dead head — the opposite of this plan's goal.
let _retainedEntryHeartbeatDisarm = null;
process.on('exit', () => {
  if (_retainedEntryHeartbeatDisarm) {
    try {
      _retainedEntryHeartbeatDisarm();
    } catch {
      /* best-effort — never mask an exit */
    }
  }
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
// plan 3961 T3.6b: phaseLaneMerge's two disarm call sites move to scripts/coord/land/lane-merge.mjs
// with it, but a private `let` is unreachable across a module boundary — this tiny accessor owns
// the if-guard so the moved phase calls a normal exported function (reached via the `spine`
// deps-container group) instead of reaching into `_retainedEntryHeartbeatDisarm` directly.
// plan 4066 task 1: the arming twin of disarmRetainedEntryHeartbeat just below — same reason
// (plan 3961 T3.6b's), the other direction. phasePreflight assigns this private `let` directly
// today; when that phase moves to scripts/coord/land/spine.mjs the assignment is unreachable, so
// this owns it. Takes the already-built disarm handle rather than building it, so the moved phase
// keeps calling armRetainedEntryHeartbeat (a sibling core module's export it can simply import)
// and this stays a pure write with no duplicated arming logic.
function setRetainedEntryHeartbeatDisarm(disarm) {
  _retainedEntryHeartbeatDisarm = disarm;
}

function disarmRetainedEntryHeartbeat() {
  if (_retainedEntryHeartbeatDisarm) _retainedEntryHeartbeatDisarm();
}

// plan 3961 T3.6: worktreeMutationKind moved to scripts/coord/land/rebase-sync.mjs
// (imported back below) — see that file's own header.

// plan 3961 T3.4b: attemptPreconverge moved to scripts/coord/land/queue-probe.mjs, alongside
// preconvergeProbe above. Its only caller (queueEnqueueAndGate) lives in queue.mjs, a sibling
// core module, so neither name is imported back into this file — see queue-probe.mjs's own header.

// Enqueue (ALL lanes — exempting 🟩 reintroduces the livelock: any master
// advance invalidates the head 🟥's in-flight rebase) and proceed only when
// head-of-queue. Non-head: default = seam out QUEUE_WAIT (slot RETAINED;
// re-invoking keeps the position since enqueue is idempotent); --wait = poll
// in-process every ~260 s (attended/TTY, plan 665 G4.3); --wait-chunk (plan
// 2170) = the UNATTENDED bounded twin — block in-process up to chunkSec
// (≤ L.WAIT_CHUNK_MAX_SEC, under the 600s Bash tool ceiling), then seam
// QUEUE_WAIT for a same-turn re-invoke; WAIT-ONLY (at head it seams instead
// of landing — the plan-662 detached-kill class must never reach a merge) and
// probe-only on conflicts (the plan-1805 pin: an unattended waiter NEVER
// auto-resolves; a conflicted probe seams out immediately). A slug that
// vanished from the queue mid-wait (stale-head steal while we slept) is
// re-enqueued at the tail. DW_FAKE_QUEUE_POS injects a status payload for
// deterministic tests (mirrors DW_FAKE_DIFF). Called from INSIDE main()'s
// try/finally so a throw here (status fetch failure, JSON parse) still hits
// the finally's dequeue — never an orphaned slot (review fix, plan 504).
// The ONE slug→plan-file resolver (extracted per review 2328 — planPriorityFor had
// copied closeOutSingle's inline pattern, and two drifting copies of the plan-822
// case-sensitivity dance is exactly how an edge-case fix lands in one and rots in
// the other): resolve by numeric ID for modern slugs (case-free — the slug can
// lowercase the category tag while the tracked file keeps mixed case); fall back to
// the basename-keyed resolvePlanRel for legacy date-prefixed slugs (`2026-05-17-…`,
// whose digits-after-dash fail the modern-id lookahead; all-lowercase, so no case
// bug). `opts` passes through ({ archived: true } resolves the archive/ copy).
function resolvePlanRelForSlug(lsPlans, slug, opts) {
  const planId = (slug.match(/^(\d{3,})-(?![0-9])/) || [])[1];
  return planId
    ? L.resolvePlanRelById(lsPlans, planId, opts)
    : L.resolvePlanRel(lsPlans, `${slug}.md`, opts);
}

// plan 3961 T3.3: planPriorityFor moved to scripts/coord/land/queue.mjs (its only caller,
// queueEnqueueAndGate, moved with it) — see that file's own header.

// plan 3295 E5: the per-plan `landGate:` tier, read the SAME way planPriorityFor above reads
// `priority:`. plan 4066 task 2a: planLandGateFor moved whole to scripts/coord/land/spine.mjs
// (imported back above) — see that file's own header.

// plan 3961 T3.3: queueEnqueueAndGate (the FIFO enqueue-and-wait loop) moved to
// scripts/coord/land/queue.mjs (imported back below) — see that file's own header.

// plan 692: the close-safety banner. hhmmNow is the local HH:MM stamped at emit time
// (a `<hh:mm>` placeholder under --dry-run keeps the spine-test output deterministic);
// emitDoNotClose writes the 🔴 "<short why> · HH:MM" line — the LAST stdout line of a
// halt — AFTER the HANDOFF + JSON, so the drain's `^HANDOFF:` parser is untouched.
function hhmmNow() {
  return DRY ? '<hh:mm>' : new Date().toTimeString().slice(0, 5);
}
function emitDoNotClose(code, state) {
  process.stdout.write(L.doNotCloseBanner(code, state, hhmmNow()) + '\n');
}

// plan 1653: land-progress visibility. A real (non --dry-run) run is otherwise silent
// on stdout/stderr for the ENTIRE spine — every child this file spawns has its stdio
// piped/ignored (see run()/gitMain() above) — except at a HANDOFF halt or the final
// step-12 report, so a multi-minute land (build preflight, WebKit mobile gate, a FIFO
// queue wait, the seed mutex, the merge, the deploy check, close-out, teardown) looks
// IDENTICAL on the terminal whether it's progressing normally or hung (operator report,
// 2026-07-10). stepLog prints a bracketed step-boundary line to stderr so a watching
// session sees forward motion; it never touches stdout, so it can't interleave with the
// HANDOFF/JSON machine-readable lines emitSeam writes there. The clock is a MODULE-level
// var, deliberately NOT a field on `state` — emitSeam does a bare `JSON.stringify({ …,
// state })`, so anything hung on `state` leaks into every HANDOFF's machine-readable
// payload; this stays a pure side-channel. `_stepLogT0` is set ONLY under `!DRY` (see
// main()), so the single null-check below is the one source of truth for "are we in a
// real run" — no separate `DRY` disjunct to keep in sync. No-ops under --dry-run so the
// existing dry-run trace-matching tests are untouched.
let _stepLogT0 = null;
// plan 2443: the same step boundaries stepLog already prints, CAPTURED as structured phase
// timings for the terminal sidecar. Two symptom fixes (plans 2414, 2433) fired in one afternoon
// on assumptions about how long a land takes, and nothing owned the DURATION — because nothing
// recorded it. `measure-land-duration.mjs` mines the queue-side phases out of pushed history,
// but commit timestamps CANNOT split the one window that matters (the post-rebase force-push's
// gate battery vs the ephemeral merge worktree's checkout: both sit between the branch tip and
// the merge commit). These boundaries split it: `sincePrevMs` on `rebase: branch synced` is the
// gate-battery term, and on `merge: landed as …` the ephemeral-worktree term.
//
// MODULE-level, deliberately — same reason as `_stepLogT0` above: emitSeam does a bare
// `JSON.stringify({ …, state })`, so anything hung on `state` leaks into every HANDOFF payload.
// Bounded so a retry loop that logs per attempt can never bloat the sidecar.
export const STEP_PHASE_CAP = 200;
let _stepPhases = [];

// Append one boundary to `buf`, in place. `sincePrevMs` is the cost of the step that ENDED at
// this boundary — measured from the previous boundary, or from t0 for the first one. Past
// STEP_PHASE_CAP entries the append is dropped rather than growing without bound; the cap is
// far above a real land's ~15 boundaries and exists only so a retrying non-fatal step (see
// bestEffortQueueCall, which stepLogs per failed attempt) can never bloat the sidecar.
export function appendPhase(buf, step, nowMs) {
  if (buf.length >= STEP_PHASE_CAP) return buf;
  const prev = buf.length ? buf[buf.length - 1].atMs : 0;
  buf.push({ step, atMs: nowMs, sincePrevMs: nowMs - prev });
  return buf;
}

function stepLog(state, msg) {
  if (_stepLogT0 == null) return;
  const nowMs = Date.now() - _stepLogT0;
  appendPhase(_stepPhases, msg, nowMs);
  process.stderr.write(`[done-worktree ${state.slug}] ${msg} (+${(nowMs / 1000).toFixed(0)}s)\n`);
}

// plan 4066 task 1: the PRODUCTION setter for `_stepLogT0`. The heartbeat clock is stamped once,
// at the top of the preflight phase; when that phase moves to scripts/coord/land/spine.mjs the
// private `let` becomes unreachable across the module boundary, and the only existing setter
// (stepLogT0ForTest, just below) is contractually test-only. A pure write, deliberately: the
// `!DRY` decision is phase policy and stays at the call site, exactly as it reads today.
function stampStepLogClock() {
  _stepLogT0 = Date.now();
}

// Test-only hook (plan 3827 fix pass 2, G3 verification), mirrors resetProcessChunkDeadlineForTest's
// own contract just below in this file. This file's own name-paired test imports this module directly
// rather than through a --dry-run subprocess, so the module-level `DRY` const stepLog's own gate
// depends on is computed from the TEST RUNNER's argv, never the child CLI's `--dry-run` flag — and
// `_stepLogT0` is set ONLY under `!DRY` inside the real land flow (see main()), so a direct call to
// narrateScopedGate from a unit test would otherwise hit stepLog's `_stepLogT0 == null` guard and
// silently produce no stderr line at all, regardless of which branch narrateScopedGate took. `undefined`
// (the default) clears the stamp; an explicit epoch arms it. Never called outside
// this file's own name-paired test.
export function stepLogT0ForTest(epoch = undefined) {
  _stepLogT0 = epoch;
}

// opts (plan 504): keepQueue — the queue slot survives this halt (QUEUE_WAIT);
// holding — hold-through-conflict: keep the seed mutex + board LANDING row + queue
// head slot (LAND_BLOCKED_HOLDING). Default halt releases both (abort path).
function emitSeam(code, reason, state, { keepQueue = false, holding = false } = {}) {
  // the "finally" also runs on the way out, but demote+release HERE first so the
  // HANDOFF the agent reads is already mutex-clean. (process.exit skips finally —
  // which is exactly what lets the holding/keepQueue variants retain their slots.)
  if (!holding) {
    releaseMutexIfHeld(state);
    if (!keepQueue) dequeueQueueIfHeld(state);
  } else {
    // plan 2275: the holding variant retains mutex + row + slot AND advertises the park
    // cross-PC — the HOLDING stamp is what lets a disjoint 🟩 waiter overtake this head
    // instead of wedging behind its rework (best-effort; see markQueueHolding).
    markQueueHolding(state);
  }
  process.stdout.write(`HANDOFF:${code}\n`);
  process.stdout.write(JSON.stringify({ code, reason, state }, null, 2) + '\n');
  emitDoNotClose(code, state); // plan 692: 🔴 close-safety banner — the last line a halt prints
  writeResultSidecar(state, { code, exitCode: L.EXIT[code] }); // plan 665 G4.1: record before exit
  process.exit(L.EXIT[code]);
}

// plan 1605: derive the CANONICAL board/plan slug from a resolved worktree BRANCH name. plan 4066
// task 2a: canonicalSlugFromBranch AND resolveWorktree (the "── git read helpers" section they
// used to open) both moved whole to scripts/coord/land/spine.mjs (imported back above) — see that
// file's own header for the truncated-slug/detached-worktree history this comment used to carry.
// The worktree-resolve test's "canonical slug derivation" cases now import
// canonicalSlugFromBranch from spine.mjs instead of this file.

// plan 3961 T3.6: changedFiles moved to scripts/coord/land/rebase-sync.mjs (imported
// back below) — see that file's own header.

// plan 3961 T2.5: wikiOnWorktreeBranchViolation, WIKI_DIFF_RETRY_BACKOFFS_MS,
// LEDGER_FILES_ON_WORKTREE_BRANCH, and wikiDiffOnWorktreeBranch itself all moved to
// scripts/project/land-seams.mjs -- see that module's own header for the full move rationale.
// The shim below keeps this call site, and every existing importer of the name
// 'wikiDiffOnWorktreeBranch' from THIS module, byte-identical -- it pre-binds the spine bag,
// exactly like runMobilePreflight above (plan 4042 D-A tail: the pytestScopedSelection shim this
// comment used to also cite is gone — see land-gate-pytest.mjs's own header).
// plan 4096 T1: the guard now reaches this file as the project plugin's `spine.wikiDiffOnWorktreeBranch`
// container member (core default: no violation, in a checkout without a project layer), so this
// export reads it off the bound container.
export function wikiDiffOnWorktreeBranch(...args) {
  return landDeps().spine.wikiDiffOnWorktreeBranch(...args);
}

// plan 3682: a worktree branch must never carry a committed sweep-checkpoint file. The
// checkpoint (`backend/data/data-pipeline/sweep-checkpoints/<date>.json`) is COMMITTED (not
// gitignored) precisely so `--checkpoint-push` can survive a dead cloud sandbox — but the
// sweep's own completed-pass DELETION is what removes it again once the render pass actually
// finishes (weekly-price-sweep.py, ~ its main()'s `_checkpoint_path(sweep_date).unlink()`
// call). A branch reaching master while STILL carrying a checkpoint file at HEAD therefore
// means the pass did not complete — either finish it (`--resume`) or drop the file before
// landing. Diffed the same way as wikiDiffOnWorktreeBranch above (origin/master...HEAD,
// scoped by pathspec) and gated the same way on being a worktree-* branch (slugFromBranch).
//
// Deliberately SIMPLER than wikiDiffOnWorktreeBranch: ONE diff attempt, no retry ladder. The
// wiki guard's retry-then-fail-closed schedule (plan 1639) exists because a real correlated
// incident (a shared-.git ref-lock blip hitting BOTH the push-time and land-time wiki guards
// at once) let a wiki commit through undetected on a worktree branch — this checkpoint guard
// has no comparable incident history, is lower-frequency (checkpoints are rare relative to
// wiki edits), and the surface is purely additive (plan 3682 is new), so the extra retry
// machinery would be speculative complexity rather than a fix for an observed failure mode.
// The fail-CLOSED direction is kept without it: a diff failure here THROWS (propagates to the
// caller) rather than resolving to `null` ("no violation") — preflight()'s call site converts
// that thrown error into a hard PREFLIGHT_FAIL, never a silent pass-through.
// plan 4057 defect 3: the base is a PARAMETER now, not a re-read of `origin/master` at call time.
// That remote-tracking ref is mutable, and on the `--prep --no-rebase` path it is deliberately NOT
// refreshed (inspectRebasedUnpushed runs with `mayFetch: false`), so this guard could resolve its
// merge base against a STALE tip while the rest of the preflight used a fresher one. Measured
// direction (done-worktree.test.mjs, "plan 4057 defect 3"): a three-dot diff from an OLDER base
// WIDENS the range, so a stale ref makes the guard report checkpoint files that other people's
// already-landed commits introduced — a false positive that blocks a clean branch, not a missed
// detection. preflight() therefore passes the one master tip it resolved for the whole run. The
// default keeps the previous literal so existing direct callers and tests are unchanged.
export function sweepCheckpointOnWorktreeBranch(wtPath, branch, baseSha = 'origin/master') {
  if (slugFromBranch(branch) == null) return null;
  // plan 4096 T1: the checkpoint path is the project's (the plugin's `spine.SWEEP_CHECKPOINT_PATHSPEC`);
  // with none there is nothing to guard — and an EMPTY pathspec must never reach `git diff --`, where
  // it would mean "every file".
  const pathspec = landDeps().spine.SWEEP_CHECKPOINT_PATHSPEC;
  if (!pathspec.length) return null;
  let files;
  try {
    files = run('git', [
      '-C',
      wtPath,
      'diff',
      '--name-only',
      `${baseSha}...HEAD`,
      '--',
      ...pathspec,
    ])
      .split('\n')
      .filter(Boolean);
  } catch (err) {
    throw new Error(
      `sweep-checkpoint worktree-branch diff could not be computed (plan 3682): ${err.message || err}`,
    );
  }
  return files.length ? files : null;
}

// plan 3295: the REVIEW-only seed-only-delta predicate, `git diff --name-only`'s IO shell for
// L.isSeedOnlyDelta (the pure path-list check lives in done-worktree-lib.mjs, which is
// fs-/git-free by contract). Lazy + memoized on `<recordedSha>..<currentSha>` the same way
// rangePatchIdOnce memoizes the patch-id: markerIdentityMatch only ever calls this AFTER both
// the sha fast path and the patch-id fallback have already failed, so a fresh marker (the
// overwhelmingly common case) never spawns this git call at all. `.describe()` re-exposes the
// same cached result with the file count, for the `review-carry:` log line below.
// The checkout's CONFIGURED seed root (`coord.config.json` → `seedShardDir`, the value every other
// seed matcher in this spine keys on), honouring main()'s own DW_FAKE_SEED_SHARD_DIR test hook so
// the two can never disagree about which tree is "seed". Null (a repo with no sharded seed layout)
// turns the review carry OFF — the same `Boolean(seedShardDir)` posture every seed gate takes in
// the isolated plan-repo scaffold, and the safe direction here (the strict sha/patch-id rule).
// plan 4057 defects 1+2: the seed LANE inputs. plan 4066 task 2a: seedLaneInputs moved whole to
// scripts/coord/land/spine.mjs (imported back above) — see that file's own header for the
// DW_FAKE_*-leak-hazard history this comment used to carry.

// plan 4057 defect 2: the DW_FAKE_SEED_SHARD_DIR read is `DRY &&`-gated now, exactly like every
// sibling test hook in this spine (DW_FAKE_FOREIGN_DIRT, DW_FAKE_INDEX_WRITE, DW_FAKE_REF_LOCK,
// DW_FAKE_UNPUSHED_MASTER, DW_FAKE_HANDOFF_LAYOUT, DW_FAKE_LAND_GATE). It was the one that was
// not, and it decides which tree counts as "seed" for the review carry — so a leaked value could
// steer a real land's review-carry classification at a directory the land is not touching. Every
// key in the cloud-drain env file is exported in every cloud sandbox, which is exactly how a
// value leaks into a process that never meant to read it. Exported so the gate itself is
// unit-testable without performing a real land.
export function resolveSeedShardDir(wtPath) {
  if (DRY && process.env.DW_FAKE_SEED_SHARD_DIR) return process.env.DW_FAKE_SEED_SHARD_DIR;
  try {
    return loadCoordConfig(wtPath).seedShardDir;
  } catch {
    return null;
  }
}

// plan 4057 defect 4: the MERGE-BASE twin of resolveSeedShardDir, for the review-carry
// classification. resolveSeedShardDir reads the BRANCH checkout's coord.config.json — the branch
// under review therefore gets to choose the value that decides which of its own files count as
// "seed", and so whether its diff is seed-only and may CARRY a stale review marker forward
// instead of being re-reviewed. Widening `seedShardDir` on the branch would let arbitrary changes
// classify as seed-only and skip the review gate. The classification is read from the merge base
// with origin/master instead: config the branch has not modified reads identically, and a branch
// that DID modify it is judged by the value master already agreed to.
//
// The value is run through `normalizeConfig` (gpt-review r1 e31197/b6c3cf/1c309b/60fd02): a
// committed `seedShardDir` spelled with backslashes or a trailing slash is normalized by every
// other reader in this spine, and a raw `JSON.parse` result is not — so `isSeedOnlyDelta`'s POSIX
// prefix test could never match git's slash-separated paths, and a genuinely seed-only delta
// would be classified non-seed and the land blocked for an unnecessary fresh review.
//
// It calls `normalizeConfig` directly rather than the `loadCoordConfigAtOrigin` seam, even though
// that seam pairs the same read with the same normalization (gpt-review r2 740569/871146/a8417f/
// da280a/1f4276/dc0bda — six finders, independently). That seam falls back to the LOCAL read when
// coord.config.json is absent at the requested sha, which here means the BRANCH's own config: a
// branch whose merge base predates the file could add one naming `seedShardDir: "scripts"`, have
// its own `scripts/**` changes classified seed-only, and carry a stale review marker past the
// review gate — precisely the hole this function exists to close, reintroduced through the
// fallback. An absent config at the merge base is therefore null (carry OFF), never the branch's.
//
// Under --dry-run this defers to resolveSeedShardDir entirely (gpt-review r1 1604ec/0fc1f9): DRY
// stubs `run`, so reaching for git here would both emit a stray `DRY git …` trace line into the
// output the parity goldens pin AND resolve no sha, silently turning the review carry off in every
// dry-run. The dry-run path keeps exactly the behaviour it had before this function existed.
//
// EVERY failure — no merge base, no config at that commit, unreadable, unparseable — yields null,
// which turns the review carry OFF. That is the safe direction (the strict sha/patch-id rule
// stands and the marker is simply not carried), the same posture as resolveSeedShardDir's own
// catch, and the reason this function can treat "absent" and "broken" identically instead of
// needing to tell them apart.
export function resolveSeedShardDirAtMergeBase(wtPath) {
  if (DRY) return resolveSeedShardDir(wtPath);
  try {
    const base = run('git', ['-C', wtPath, 'merge-base', 'origin/master', 'HEAD']).trim();
    if (!base) return null; // no sha to pin against — never fall back to the branch's own config
    const raw = run('git', ['-C', wtPath, 'show', `${base}:coord.config.json`]);
    return normalizeConfig(JSON.parse(raw)).seedShardDir ?? null;
  } catch {
    return null;
  }
}

// plan 1300: the sharded-layout analogue of the retired monolith-ref seed reader (deleted,
// plan 3078 — its one call site was the monolith arm below, now a loud MONOLITH_RESURRECTED
// refusal instead of a gate-view read) for the pre-merge seed gates
// (status-flip / price-trust / chains + paged-record wiki checkpoint). Those gates
// compare base↔head PER RECORD ID (statusFlipSeam / changedPriceClinics /
// pagedClinicChanged all map by id), so a view holding ONLY the records whose shard
// files are in the diff is semantically identical to the full corpus — an unchanged
// record contributes nothing on either side — and costs a handful of `git show`s
// instead of assembling ~2k shards at a ref. chains[] is read only when chains.json
// itself changed; unchanged ⇒ both sides see [] ⇒ chainsChanged stays false.
function readShardGateViews(wtPath, baseRef, changed, seedShardDir, shardIdPattern) {
  // One layout encoding for all gates: L.shardFileRx (plan-1300 review finding 9).
  // plan 3960 review fix: `shardIdPattern` (cfg.shardIdPattern) now reaches this reader too — a
  // configured non-default pattern used to recognize a changed custom shard only in seedScopeOf's
  // mutex scoping (L.seedScopeOf below), while this reader stayed on the default record regex and
  // silently produced empty gate views for it.
  const shardRx = shardIdPattern
    ? L.shardFileRx(seedShardDir, L.deriveShardPatterns(shardIdPattern).shardRelSrc)
    : L.shardFileRx(seedShardDir);
  const shardPaths = changed.filter((f) => shardRx.test(f));
  const chainsPath = `${seedShardDir}/chains.json`;
  const chainsInDiff = changed.includes(chainsPath);
  const readAt = (ref, p) => {
    try {
      return JSON.parse(
        ref === 'WORKTREE'
          ? readFileSync(`${wtPath}/${p}`, 'utf8')
          : run('git', ['-C', wtPath, 'show', `${ref}:${p}`]),
      );
    } catch {
      return null; // added-at-head (no base version) / deleted-at-head — absent from that side
    }
  };
  const view = (ref) => {
    const records = [];
    for (const p of shardPaths) {
      const c = readAt(ref, p);
      if (c) records.push(c);
    }
    return { records, chains: (chainsInDiff && readAt(ref, chainsPath)) || [] };
  };
  return { base: baseRef ? view(baseRef) : null, head: view('WORKTREE') };
}

// plan 3295 (review fix f3106d / 13f188): the records whose prices[] changed since a PROVEN price
// trust gate run — i.e. the rows this land has not yet had checked. `deltaPaths` is the seed delta
// since `sinceSha`; the views are built with that sha as the base instead of the merge-base, so the
// gate re-runs over the remainder rows only and never re-proves what it already passed.
//
// null ⇒ the remainder could not be determined — the caller must run the FULL gate then. Doubt
// always checks MORE.
//
// The proven sha is verified RESOLVABLE first (gpt-review r2 25449f). `readShardGateViews` swallows
// a per-file `git show` failure into "absent on that side, i.e. added at head", which is right for a
// merge-base view but wrong here: if the proven commit itself is gone from this checkout (the
// rebase/squash-at-queue-head shape this design exists to survive) every base read fails, the base
// view comes back empty, and EVERY changed record reads as newly added — a silently wrong remainder
// that a green would then stamp as proof. `cat-file -e` makes that case take the documented
// full-gate fallback instead. The `!base` check below cannot catch it (base is null only for a
// falsy baseRef, which this function never passes) and is kept only as a signature-contract guard.
function priceTrustRemainderClinics(wtPath, sinceSha, deltaPaths, seedShardDir, shardIdPattern) {
  if (!seedShardDir) return null;
  try {
    run('git', ['-C', wtPath, 'cat-file', '-e', `${sinceSha}^{commit}`]);
  } catch {
    return null; // the proven tree is unreadable here — nothing can be a remainder OF it
  }
  try {
    const { base, head } = readShardGateViews(
      wtPath,
      sinceSha,
      deltaPaths,
      seedShardDir,
      shardIdPattern,
    );
    if (!base) return null;
    return landDeps().spine.changedPriceClinics(base.records, head.records);
  } catch {
    return null;
  }
}

// plan 3961 T3.6: mergeBaseRef moved to scripts/coord/land/rebase-sync.mjs — see that file's own
// header. Plan 4042 (T1 tail): its one remaining call site in this file (the SEED GATE VIEWS
// block) moved to land-gate-seed.mjs's `runSeedGateViewsContextExtra`, which imports this name
// directly from rebase-sync.mjs instead, so it is no longer imported back into this file at all.

// plan 3961 T3.6: tryRebase, the sync-skip primitives (SYNC_SKIP_SUBJECTS_SHOWN, SYNC_SITE,
// trySkipSync, logSyncSkipped), the land-prep/land-spec scratch-marker quartet
// (slugScratchMarker, landPrepMarker, landSpecMarker), and the speculative-stacking
// git-history primitives (isAncestor, commitParents) all moved to
// scripts/coord/land/rebase-sync.mjs (imported back below where still needed) — see that
// file's own header.

// Resolve a remote-tracking tip, or null. Used for the head slot's branch (the speculative base).
function remoteTrackingTip(wtPath, branch) {
  if (DRY) return process.env.DW_FAKE_HEAD_BRANCH_TIP || null;
  try {
    return run('git', ['-C', wtPath, 'rev-parse', `origin/${branch}`]).trim() || null;
  } catch {
    return null;
  }
}

// plan 3961 T3.4b: speculationQueueView moved to scripts/coord/land/queue-probe.mjs (imported
// back above) — see that file's own header.

// plan 2458: the marker→fast-path proof, extracted so it can be evaluated at BOTH points that
// matter, instead of only once. It is called
//   (1) BEFORE the enqueue — so a branch a prior prep already covers skips the pre-enqueue
//       build/mobile preflights, and
//   (2) again AFTER the queue wait, immediately before the head-time rebase.
// (2) is the point of the extraction. The pre-enqueue call necessarily runs before this land has
// waited at ALL, so a marker stamped DURING the wait — by keep-hot, or by this plan's own
// enqueue-time prep — was invisible to a single blocking `--wait` invocation: `landFastPath` was
// decided before the enqueue and never revisited, so the fast path could only ever fire on a
// FRESH re-invocation after a QUEUE_WAIT seam (the pre-2458 log line even claimed the gates were
// "re-validated during the wait", describing a state this code had not yet reached). That is a
// large part of the measured ~0% fire rate (1/1704 head lands, 2026-06-23→07-25).
// STRICT in both places, unchanged: the fetch is mandatory (a failed fetch means the local
// origin/master ref can't be trusted, so no fast-path), and landPrepValid is sha equality on BOTH
// tips, so any movement of master or the branch invalidates the marker and the full rebase +
// gate battery runs. Never a silent skip.
// plan 2940: `branch` joins the signature so both proofs can check the ref the marker's branchSha
// was read from (see markerReadFromBranch). It is NOT derivable from `slug` here — the caller
// resolved it, and re-deriving `worktree-<slug>` would re-introduce by hand exactly the
// "assume the ref" step this plan removes.
function evaluateLandFastPath(MAIN, wtPath, branch, slug, changed, atHead = false) {
  const branchRef = `refs/heads/${branch}`;
  let fetchedOk = true;
  if (!DRY) {
    try {
      run('git', ['-C', wtPath, 'fetch', 'origin', 'master']);
    } catch {
      fetchedOk = false; // can't trust the local ref → no fast-path this pass
    }
  }
  const marker = fetchedOk ? landPrepMarker.read(MAIN, slug, atHead) : null;
  // capture the just-fetched live tip ONCE (plan 2433) and reuse it both for the marker proof
  // and, on a hit, as the landed-reversion advisory's pinned masterRef.
  // gpt-review 2940 [c0c4fd]: the try/catch above covers only the FETCH. `rev-parse origin/master`
  // can fail on its own (the ref deleted or transiently unreadable under a concurrent gc/repack on
  // this shared `.git`), and an escaping throw here does not degrade to the safe full-rebase path —
  // it crashes the spine, because `--prep` runs as `process.exit(await runLandPrep(…))`. Every
  // other unknown in this function already fails closed to "no fast path"; this one now does too.
  let liveTip = null;
  if (fetchedOk) {
    try {
      liveTip = originMasterTip(wtPath);
    } catch {
      fetchedOk = false; // cannot resolve the tip ⇒ nothing to prove a marker against
    }
  }
  const branchTip = worktreeHeadSha(wtPath);
  // gpt-review 2940 [9426c6/007dcb/009dbc/8c6820]: THE READER-SIDE TWIN of the stamp assert, and
  // the half the first cut was missing. `branchTip` is `git rev-parse HEAD` — the same read that
  // makes a detached worktree indistinguishable from an attached one — so on a tree left detached
  // AT the marker's sha while refs/heads/<branch> has since advanced, both sha equality and the
  // recorded `branchRef` still hold and the marker validates. That is not a stale-marker miss: a
  // fast-path HIT skips the head-time `attachmentRefusal` (it lives inside the `!landFastPath`
  // arm) and the rebase + battery, and `mergeToMaster` then merges `origin/<branch>` — the NEWER,
  // ungated tip. Checking the marker's recorded ref proves where the sha CAME FROM; only this
  // proves the sha we are reading NOW is the branch's. Both, or the class is only half closed.
  //
  // gpt-review 2940 round 2 [ed88c0]: LAZY. A land with no marker at all — the overwhelming
  // majority — can never fast-path whatever HEAD says, so probing it would spend a `symbolic-ref`
  // subprocess per evaluation (two per land, both inside the pre-enqueue/head-time hot path) to
  // learn something that cannot change the answer. Probe only once a marker exists to be trusted.
  let attachedMemo = null;
  const isAttached = () => {
    if (attachedMemo !== null) return attachedMemo;
    const headRef = worktreeHeadRef(wtPath, branch);
    attachedMemo = headRef === branchRef;
    if (!attachedMemo) {
      console.error(
        `done-worktree: NOT taking the land-prep fast path for ${slug} — its worktree HEAD is ` +
          `${headRef === WORKTREE_HEAD_UNREADABLE ? `UNREADABLE (${lastHeadRefError})` : headRef === null ? 'DETACHED' : `attached to "${String(headRef).replace(/^refs\/heads\//, '')}"`}` +
          `, not ${branchRef}, so ${branchTip.slice(0, 9)} cannot be proven to be ${branch}'s tip. ` +
          // gpt-review 2940 round 2 [de2f1b]: do NOT promise the battery here. The very next thing
          // an attachment fault meets is `attachmentRefusal`, which seams PREFLIGHT_FAIL — so an
          // operator told "the full rebase + battery runs instead" would wait for work that cannot
          // start, and miss that the tree needs recovery first.
          `This land takes the full (non-fast) path, which will itself refuse until the worktree ` +
          `is re-attached (plan 2940).`,
      );
    }
    return attachedMemo;
  };
  // plan 2875 cluster 3: `changed` lets landPrepValid prove the marker's gateResults actually
  // cover every gate THIS diff requires (not just that the tree matches) — see its own comment.
  // plan 4096 T1/S9: WHICH gates it may require is the registry's roster (prepGatePredicates), read
  // through the synchronous registry builder because this evaluator is synchronous; memoized so
  // the plain and the speculative proof below share one table.
  let predicatesMemo = null;
  const predicates = () =>
    (predicatesMemo ??= prepGatePredicates(landRegistriesSync(MAIN, wtPath)));
  let fastPath =
    fetchedOk &&
    L.landPrepValid(marker, liveTip, branchTip, changed, branchRef, predicates()) &&
    isAttached();
  // plan 2463: the SPECULATIVE marker is the second, weaker-keyed proof — consulted only when the
  // plain one has already failed, which for a waiter that reached head from position 2 is the
  // overwhelmingly common case (the head's own land moved master, so strict sha equality cannot
  // hold). It is not weaker in what it PROVES: `landSpecPrepValid` demands the live tip be a merge
  // of exactly (the master we prepped against, the head branch we stacked onto), i.e. master moved
  // by exactly that one land — the same "nothing else changed" guarantee, keyed on parentage
  // instead of a sha nobody could predict.
  const spec = !fastPath && fetchedOk ? landSpecMarker.read(MAIN, slug) : null;
  // review [9]: `commitParents` spawns a `rev-list` even with no speculative marker to check it
  // against — which is every land that never speculated. Only pay it when there is a marker.
  // gpt-review 2940 round 3 [ebca67/f0f5a1]: `isAttached()` FIRST — it is memoized and local,
  // while `commitParents` spawns a `rev-list`. A detached worktree that still has a speculative
  // marker would otherwise pay that subprocess on every poll to reach a refusal already decided.
  const speculative = spec
    ? isAttached() &&
      L.landSpecPrepValid(
        spec,
        commitParents(wtPath, liveTip),
        branchTip,
        changed,
        branchRef,
        predicates(),
      )
    : false;
  if (speculative) fastPath = true;
  // review [1]: `marker` stays the PLAIN marker, deliberately. `hadMarker` feeds coord-metrics'
  // pre-existing `firedWhenMarkerPresentPct` ("of the lands where a marker existed, how often did
  // it still validate — low ⇒ the tip kept moving"), which is a statement about the PLAIN marker's
  // sha-equality proof. Folding a stale speculative marker into it would blend two different proofs
  // into one ratio and silently deflate a number whose own comment says it means something else.
  // The speculative side is reported separately (`hadSpecMarker` / `speculative`).
  return { fastPath, marker, specMarker: spec, liveTip, fetchedOk, speculative };
}

// plan 2463 decision D5 — THE no-laundering invariant, run before anything can merge.
//
// A speculating prep stacks this branch onto the head slot's branch tip and force-pushes it, which
// is what pays the full `scripts/hooks/pre-push.sh` battery OFF the head slot (the whole point of the plan).
// The cost is that between that push and our own land, the branch carries commits that belong to
// ANOTHER plan and have not landed. If that head then fails out — derails, is overtaken, is
// re-parked — merging our branch would carry its unlanded, unreviewed work onto master. That is
// strictly worse than any latency this plan saves, so it is enforced HARD rather than trusted to
// the fast-path proof: whenever the branch still descends from a specBase origin/master does NOT
// contain, un-stack it and continue on the normal (full-battery) path.
//
// The un-stack is a `reset --hard` to `preSpecBranchSha` — the PLAIN-prepped tip, recorded by the
// same prep that stacked. That is what makes the plan's step-3 fallback literal rather than
// approximate: the branch returns to the exact sha the plain marker pins, so a head that failed out
// costs the speculation and nothing else. A branch that has since moved on (a new worktree commit)
// is NOT reset — its own tip is authoritative and the speculative commits are dropped by rebasing
// off the stale base instead, so no work can be lost either way.
//
// Returns true when it changed the branch (the caller must re-read tips).
// plan 2463 — THE un-stack primitive, shared by the prep-side reset and the land-side one
// (review [6]: this reset-vs-rebase rule is a correctness decision — never drop a commit authored
// on TOP of the stack — and a second hand-copy is exactly how the two arms drift apart).
//   * branch untouched since the stack ⇒ restore the exact recorded plain-prepped tip, which keeps
//     the PLAIN marker valid (the plan's step-3 fallback).
//   * branch moved on ⇒ replay everything above the speculative base onto origin/master, dropping
//     only the base's commits.
// Throws on failure; callers decide whether that is fatal (land-side) or best-effort (prep-side).
/**
 * plan 3394 — put `branch` back on `wantSha` after a conflicted `--prep` rebase, and REPORT where
 * it actually ended up. Returns the branch's sha after the attempt (=== `wantSha` on success).
 *
 * `git rebase --abort` is the normal restore and usually suffices; this is the check that it did,
 * plus one explicit repair when it did not. The repair has to cope with a HEAD left DETACHED
 * mid-rebase — a plain `reset --hard` there moves nothing (it moves the detached HEAD, not the
 * branch ref), which is precisely how a branch can be left pointing at a foreign base while every
 * command in the recovery path exits 0. `checkout --force -B` re-points the ref and re-attaches in
 * one step, and is only ever reached when the tree is already known to be in a state we are
 * discarding. Never throws: a repair that cannot run returns the observed sha and lets the caller
 * refuse loudly, which is strictly better than an exception from inside a recovery path.
 */
function restorePrepBranchTip(wtPath, branch, wantSha, slug) {
  const now = () => {
    try {
      return run('git', ['-C', wtPath, 'rev-parse', `refs/heads/${branch}`]);
    } catch {
      return null;
    }
  };
  if (!wantSha) return now();
  if (now() === wantSha) return wantSha;
  console.error(
    `done-worktree --prep: \`git rebase --abort\` left ${branch} (${slug}) off its pre-rebase ` +
      `tip — restoring it to ${wantSha.slice(0, 9)} explicitly (plan 3394).`,
  );
  try {
    run('git', ['-C', wtPath, 'checkout', '--force', '-B', branch, wantSha]);
  } catch (e) {
    console.error(`done-worktree --prep: restore of ${branch} failed — ${e.message || e}`);
  }
  return now();
}

function restoreOffSpeculativeBase(wtPath, branch, spec, branchTip) {
  if (branchTip === spec.branchSha) {
    run('git', ['-C', wtPath, 'reset', '--hard', spec.preSpecBranchSha]);
  } else {
    run('git', ['-C', wtPath, 'rebase', '--onto', 'origin/master', spec.specBase, branch]);
  }
}

// plan 3961 T3.4b: unstackSpeculativeBase and foreignStackedBranch moved to
// scripts/coord/land/queue-probe.mjs (imported back above) — see that file's own header.
// `restoreOffSpeculativeBase` above stays here: `clearSpeculativeStackForPrep` (prep-gates
// territory, not yet carved) calls it too, so it joined the `spine` deps-container group instead
// of moving (see deps.mjs's own comment).

// plan 3961 T3.3: the land-attempt sidecar (landAttemptPath, migrateLandAttempt,
// readLandAttempt, writeLandAttempt, and the private max-age constant) moved to
// scripts/coord/land/queue.mjs (readLandAttempt/writeLandAttempt/landAttemptPath imported
// back below) — see that file's own header.

function clearLandAttempt(main, slug) {
  if (DRY) return;
  try {
    rmSync(landAttemptPath(main, slug), { force: true });
  } catch {
    /* ignore */
  }
}

// plan 3974 T2c: fold a `tryRebase`/`syncBranchOntoMaster` result's `lockRetry` count (T2a's
// bounded index.lock/rescheduled-pick retry, fired inside land-lib.mjs) into the land-attempt
// sidecar so acceptance can measure it landing-wide instead of only per-invocation. RUNNING total
// across the sidecar's own lifetime (a fresh attempt after `clearLandAttempt` — a landed/tail-
// requeued slug — starts back at zero, same as every other counter this sidecar carries), so a
// slug that resumes across several `--prep` polls and the eventual at-head land accumulates ONE
// number covering the whole attempt, not just its last call. Best-effort and silent on any
// failure (mirrors writeLandAttempt's own contract): a lost tally only weakens T4's measurement,
// it must never block or perturb the land itself. No-op when nothing retried (the overwhelmingly
// common case) — avoids a sidecar write on every ordinary, lock-free rebase.
// plan 3974 fix (gpt-review 11rxd7l/54ab2a): exported so the non-DRY write branch is directly
// unit-testable — every spine test drives the land spine via `--dry-run` subprocesses, under
// which `writeLandAttempt` no-ops before this function's own merge logic ever runs, so that
// merge (the spread-and-add, not-clobber contract) had no test reaching it at all.
export function tallyLockRetry(main, slug, reb) {
  if (DRY || !reb || !reb.lockRetry) return;
  try {
    const prior = readLandAttempt(main, slug) || {};
    writeLandAttempt(main, slug, {
      ...prior,
      slug,
      lockRetry: (prior.lockRetry || 0) + reb.lockRetry,
    });
  } catch {
    /* best-effort — see header comment */
  }
}

// review fix (plan 2505 sonnet-review round 4 [1]): the raw query+parse core, shared by
// queueStatusView below (which swallows every failure into null — its established contract,
// several OTHER callers rely on that) and makeQueueHeartbeatStamper's discovery (which needs
// the opposite: a thrown failure it can retry, vs. a clean result — positive or negative — it
// can trust as definitive). One body, two callers wrapping it differently, instead of two
// hand-copied bodies drifting apart on a future landing-queue.mjs shape change.
// plan 3961 T3.3: the queue-status/head-acquisition/requeue cluster (queueStatusRawQuery,
// queueStatusView, markHeadAcquired, releaseHeadTenureAfterRequeue, maybeRequeueToTail,
// dequeueForRework) moved to scripts/coord/land/queue.mjs (queueStatusView imported back below;
// dequeueForRework's last caller here followed it into the core at plan 4042, so this file no
// longer imports it at all) — see that file's own header.

// plan 4042 (D-M15): emitReworkHaltWithRelease moved to scripts/coord/land/preflight.mjs and is
// imported back for phasePreflight's own call site (the review marker — its
// status-flip/conclusion-review/wiki-checkpoint siblings moved to land-gate-seed.mjs in the
// D-A tail, which imports this same name directly from that module too). Its body reached
// nothing spine-resident, so it never needed a dependency-container hop — see that file's own
// header.

// plan 3961 T3.6b: holdOnResumeGraft and holdOnGraftPayload moved to
// scripts/coord/land/lane-merge.mjs (module-private there — their only caller, phaseLaneMerge,
// moved with them) — see that file's own header.

// plan 3961 T3.3: requeueOnConflictOrReturn moved to scripts/coord/land/queue.mjs (imported
// back below) — see that file's own header.

// plan 1364 Ship 3 / plan 1467: read a batch manifest. plan 4066 task 2a: readBatchManifest moved
// whole to scripts/coord/land/spine.mjs (imported back above) — see that file's own header for
// the manifest-path history this comment used to carry.

// plan 3961 T3.6: the worktree-HEAD reads (originMasterTip, worktreeHeadSha, the private
// `let dryMidPassTip` and its arm* hooks) and the prep-gate sha helpers built on them
// (headShaAfterGate, prepPassEndSha, prepMarkerStampSha) all moved to
// scripts/coord/land/rebase-sync.mjs (imported back below) — see that file's own header.

// plan 2654: which ref, if any, HEAD is attached to in `wtPath`. null ⇒ DETACHED.
//
// `git symbolic-ref -q HEAD` is the primitive: rc=0 + the ref name when attached, rc=1 + empty
// when detached (verified on git 2.43 — the same behaviour stale-rebase-state.mjs's
// rebaseInFlight() already relies on; that one only checks the rc, so it cannot tell WHICH branch,
// which is why this returns the name).
//
// plan 2654 review [4]: rc=1 is the ONLY exit status that means "detached". Anything else — a
// deleted worktree dir (git exits 128), a failure to spawn git at all (no `status`, `e.code` is
// ENOENT), a transient lock — is a DIFFERENT problem, and reporting it as "your worktree is on a
// DETACHED HEAD" sends the operator to a `checkout` recovery for a fault that is not detachment
// while hiding the real error. Those return the WORKTREE_HEAD_UNREADABLE sentinel instead, which
// callers refuse on with the underlying message attached.
//
// DRY: defaults to ATTACHED to `branch`, matching resolveWorktree's DRY fake. DW_FAKE_HEAD_REF
// overrides — 'detached' ⇒ null, 'unreadable' ⇒ the sentinel, anything else ⇒ that literal ref name.
const WORKTREE_HEAD_UNREADABLE = Symbol('worktree-head-unreadable');
let lastHeadRefError = null; // the real error behind the most recent sentinel, for the diagnostic
// plan 4042: the preflight.mjs carve only ever READS this text (never writes it) from outside this
// module — an ES module private `let` has no cross-module reach other than an exported accessor,
// the same pattern `stepLog`/`readResultSidecar` already use for a private-state read from outside
// the module. Added to the `spine` deps-container group below (bindLandDeps's own call site).
const lastHeadRefErrorText = () => lastHeadRefError;
function worktreeHeadRef(wtPath, branch) {
  // gpt-review 2940 round 2 [76c4cd/63ab8b/9e9c2a]: ONE decoder for all three hooks (see
  // `fakeHeadRef`). This arm used to carry its own copy, which is how the stamp seam's copy came to
  // exist and then diverged; a fake state added to one and not the other makes dry-run entry checks
  // and stamp/exit checks disagree, which is misleading green coverage rather than a caught bug.
  if (DRY) return fakeHeadRef('DW_FAKE_HEAD_REF', branch);
  try {
    return run('git', ['-C', wtPath, 'symbolic-ref', '-q', 'HEAD']).trim() || null;
  } catch (e) {
    if (e?.status === 1) return null; // rc=1 ⇒ genuinely detached HEAD
    lastHeadRefError = e?.message || String(e);
    return WORKTREE_HEAD_UNREADABLE;
  }
}

// plan 2654 review [1] + [4]: the ONE attachment gate every cwd-scoped rebase site goes through.
// Returns a refusal message, or null when it is safe to proceed.
//
// Why this exists beyond the prep's own guardrail: the `--wait` parent resolves the worktree ONCE at
// startup and then runs for hours, fire-and-forget dispatching `--prep` children at each queue
// poll. A child that ends detached-and-diverged deliberately STAYS detached (restorePrepAttachment
// refuses to choose between abandoning commits and moving the branch) and logs only to its own log
// file, which the parent never reads. So the parent could reach its head-time rebase on a tree that
// went detached under it — the same silent wrong-ref force-push, at the one moment it PUBLISHES.
function attachmentRefusal(wtPath, branch, slug, action) {
  const headRef = worktreeHeadRef(wtPath, branch);
  if (headRef === WORKTREE_HEAD_UNREADABLE) {
    return (
      `done-worktree ${action === 'land' ? '(land)' : '--prep'}: cannot read which ref ${slug}'s ` +
      `worktree HEAD is attached to (${lastHeadRefError}) — REFUSING to rebase rather than ` +
      `assuming it is attached. This is NOT a detached HEAD; fix the underlying fault first ` +
      `(is "${wtPath}" still present?). plan 2654.`
    );
  }
  return L.worktreeAttachmentSeam({ headRef, branch, slug, wtPath, action })?.message ?? null;
}

// plan 2940 (writer half of ruling 1): THE STAMP-SEAM attachment assert. Returns the ref name to
// record in the marker when HEAD is attached to refs/heads/<branch>, or null after explaining the
// refusal — in which case the caller MUST clear the marker it was about to overwrite and return
// PREP_EXIT.DETACHED_STAMP.
//
// Why a fifth guard, when plan 2654 already shipped four: every one of those is placed at a git
// WRITE (or at process entry/exit), and none of them re-checks at the moment the prep records a
// verdict. The measured 2026-08-06 timeline (plan 2933's land) runs straight between them —
// guardrail 1 passes on an attached tree at 21:52:24; the prep's own rebase creates a commit and
// stops mid-replay at 21:52:32, leaving HEAD detached; the gates then run for MINUTES against that
// stranded tree; the marker is stamped at 21:59:15 recording `{branchSha: <stranded>,
// gateResults:{battery:true}}`; and restorePrepAttachment — the exit-time restore that would have
// caught it — only runs AFTER, in runLandPrep's finally. The certification is written before the
// only guard that could have refused it. Hence: assert HERE, at the seam that writes the claim.
//
// `worktreeHeadSha` is deliberately NOT re-read as a branch-ref lookup (ruling 2): the plain path
// legitimately means "the tip after MY rebase", and reading refs/heads/<branch> while detached
// would paper over exactly this state. The fix is to refuse, not to look somewhere else.
//
// The refusal NAMES the sha that was about to be certified — without it the operator sees only
// "detached" and has to go find which commit the gates actually ran against, which is the single
// most useful fact in the incident.
//
// DRY: DW_FAKE_HEAD_REF_AT_STAMP reuses DW_FAKE_HEAD_REF's exact vocabulary ('detached' ⇒ null,
// 'unreadable' ⇒ the sentinel, any other value ⇒ that literal ref name), the same way
// DW_FAKE_HEAD_REF_AT_EXIT already does for the exit-time restore. A separate variable rather than
// a shared one because the whole point is a tree that was ATTACHED at guardrail 1 and detached by
// the prep's own rebase — with one variable that state is unreachable, since DW_FAKE_HEAD_REF
// would abort at entry and never reach a stamp. DW_FAKE_DETACHED_SHA (the restore path's existing
// hook) supplies the stranded sha for the message.
// gpt-review 2940 [d54989]: ONE decoder for the DRY head-ref fakes, shared by this seam and the
// exit-time restore. The first cut inlined a second copy here and forgot `lastHeadRefError`, so
// `DW_FAKE_HEAD_REF_AT_STAMP=unreadable` printed "UNREADABLE (null)" — the copy's whole failure
// mode, and the reason it is a function now. `envVar` names which hook this caller reads; the
// vocabulary is identical everywhere ('detached' ⇒ null, 'unreadable' ⇒ the sentinel, anything
// else ⇒ that literal ref name, unset ⇒ attached to `branch`).
function fakeHeadRef(envVar, branch) {
  const v = process.env[envVar];
  if (!v) return `refs/heads/${branch}`;
  if (v === 'detached') return null;
  if (v === 'unreadable') {
    lastHeadRefError = `${envVar}=unreadable`;
    return WORKTREE_HEAD_UNREADABLE;
  }
  return v;
}

// The three seams this assert is placed at, and the DRY hook each reads. Live behaviour is
// identical at all three — they differ only in wording and in which hook they consult, which is
// what lets a test exercise ONE of them alone. That matters because they run in sequence: with a
// shared hook the earliest would always fire first and the later two would have no coverage at all
// (gpt-review round 3 [c2c2db] on the pre-publish one, which is the guard standing between a
// wrong-ref state and an ungated tip on ORIGIN — the least testable and the most consequential).
const STAMP_PHASE_ENV = {
  'post-rebase': 'DW_FAKE_HEAD_REF_AT_POST_REBASE', // the cheap early refusal, right after a rebase
  'pre-publish': 'DW_FAKE_HEAD_REF_AT_PRE_PUBLISH', // the last private moment before a force-push
  stamp: 'DW_FAKE_HEAD_REF_AT_STAMP', // the invariant, immediately before the marker write
};
// gpt-review 2940 round 2 [842c1b/29073e]: the STATE classification comes from the shared
// `L.worktreeAttachmentSeam` code (DETACHED / WRONG_BRANCH), never re-derived here — that helper is
// where "which attachment fault is this" is decided repo-wide. Only the MESSAGE is local, and
// deliberately so: the shared one is about refusing to REBASE, this one about refusing to CERTIFY,
// and it must name the sha the gates ran against (the acceptance's own requirement), which the
// shared wording has no slot for. `null` ⇒ attached, and the ref name is returned to the caller.
function stampAttachmentState(wtPath, branch, slug, phase) {
  const want = `refs/heads/${branch}`;
  const headRef = DRY
    ? fakeHeadRef(STAMP_PHASE_ENV[phase] ?? 'DW_FAKE_HEAD_REF_AT_STAMP', branch)
    : worktreeHeadRef(wtPath, branch);
  if (headRef === want) return { ok: true, ref: want };
  if (headRef === WORKTREE_HEAD_UNREADABLE) return { ok: false, code: 'UNREADABLE', headRef };
  const seam = L.worktreeAttachmentSeam({ headRef, branch, slug, wtPath, action: 'prep' });
  return { ok: false, code: seam?.code ?? 'DETACHED', headRef };
}

function assertStampAttachment(wtPath, branch, slug, label, stampedSha, { phase = 'stamp' } = {}) {
  const state = stampAttachmentState(wtPath, branch, slug, phase);
  if (state.ok) return state.ref;
  const { code, headRef } = state;

  const detachedSha = (DRY ? process.env.DW_FAKE_DETACHED_SHA || stampedSha : stampedSha) || null;
  // gpt-review 2940 [216def/65a844]: name the state that ACTUALLY holds. Exit 5 covers all three,
  // and telling an operator "detached" when the worktree is on another branch sends them to a
  // `checkout` recovery for a fault that is not detachment — the same mistake worktreeHeadRef's own
  // UNREADABLE sentinel exists to prevent one layer down.
  const where =
    code === 'UNREADABLE'
      ? `its HEAD ref is UNREADABLE (${lastHeadRefError})`
      : code === 'DETACHED'
        ? `its HEAD is DETACHED`
        : `its HEAD is attached to "${String(headRef).replace(/^refs\/heads\//, '')}", not "${branch}"`;
  // gpt-review 2940 [6e45db] + round 2 [a39dad]: the recovery is state-specific, all THREE ways.
  // Telling the operator to `checkout <branch>` out of a worktree ANOTHER session has attached to
  // its own branch is the exact move restorePrepAttachment's WRONG_BRANCH arm refuses to make
  // ("another session may be using this tree for that branch, and the commits it holds are not ours
  // to move"); and handing the same advice out for an UNREADABLE ref is worse still, because we do
  // not know what state we would be clobbering — `attachmentRefusal` already says exactly that one
  // layer down ("This is NOT a detached HEAD; fix the underlying fault first").
  const recovery =
    code === 'UNREADABLE'
      ? `Do NOT check out anything here — this is NOT a detached HEAD, and the state being ` +
        `recovered from is unknown. Fix the underlying fault first (is "${wtPath}" still present?).`
      : code === 'DETACHED'
        ? `Recover with \`git -C "${wtPath}" status\` — a stopped rebase needs \`rebase --abort\` ` +
          `(or --continue), then re-attach with \`git -C "${wtPath}" checkout ${branch}\`.`
        : `Do NOT check out "${branch}" here — something outside this prep switched the tree and ` +
          `may be mid-work. Inspect \`git -C "${wtPath}" status\` and resolve with whoever owns it.`;
  console.error(
    `done-worktree --prep: REFUSING to stamp the ${label} marker for ${slug} — ${where}, so ` +
      `${detachedSha ? detachedSha.slice(0, 9) : 'the sha'} is NOT ${branch}'s tip and the gates ` +
      `${phase === 'post-rebase' ? 'would run' : 'just ran'} against a tree the branch may never ` +
      `have reached. Certifying it would let the head-time fast path skip the battery for commits ` +
      `that were never gated (plan 2940; the 2026-08-06 incident stamped battery:true for a sha ` +
      `holding 1 of the branch's 2 commits). Any prior marker has been CLEARED, so the next land ` +
      `runs the full rebase + battery. ${recovery}`,
  );
  return null;
}
// plan 3961 T3.6: remoteBranchTip moved to scripts/coord/land/rebase-sync.mjs
// (imported back below) — see that file's own header.
// The files origin/master gained between two shas (the LANDED delta) — feeds the gate-re-run cap.
// DRY honours DW_FAKE_LANDED_DELTA. null on a compute failure ⇒ caller re-runs all applicable
// gates (never trusts a carry-forward it can't justify).
function gitDeltaFiles(wtPath, fromSha, toSha) {
  if (DRY) return (process.env.DW_FAKE_LANDED_DELTA || '').split(',').filter(Boolean);
  try {
    return run('git', ['-C', wtPath, 'diff', '--name-only', `${fromSha}..${toSha}`])
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
}
const nowIso = () => (DRY ? '<ts>' : new Date().toISOString());

// plan 972: prep-mode exit codes — a DIFFERENT process-exit-code namespace than the land SEAM/EXIT
// map (`L.EXIT`). Moved to done-worktree-lib.mjs (plan 3274, F3 review fix), beside `EXIT`/`SEAM`
// — the map it must never collide with — so this file re-exports the SAME object rather than
// carrying a second, drifting literal; landing-queue-watch.mjs's own PREP_EXITS report table keys
// its GATE_CHUNKED row off this same reference. See PREP_EXIT's own header in
// done-worktree-lib.mjs for the full numbering rationale (the BUSY=6 band, the GATE_CHUNKED=10->40
// renumber, done-worktree.test.mjs's own collision-guard test).
export const PREP_EXIT = L.PREP_EXIT;

// plan 4042: runLandPrep, runLandPrepNoRebase, restorePrepAttachment,
// clearSpeculativeStackForPrep, attemptSpeculativeStack, and runLandPrepLocked moved to
// scripts/coord/land/preflight.mjs (runLandPrep imported back above, called from main()'s
// `--prep` branch) — see that file's own header for what stayed behind and why.

// plan 3961 T3.6b: mergeToMaster moved to scripts/coord/land/lane-merge.mjs
// (module-private there — its only caller, phaseLaneMerge, moved with it) — see that file's
// own header.

// plan 651: is this branch's merge ALREADY on origin/master (a prior partial/interrupted
// close-out landed it and only bookkeeping remains)? When true, main() skips the whole
// pre-merge prep — review/build/artifact seams, the FIFO queue enqueue, the seed
// landing-lock, the rebase — so a bare `done-worktree <slug>` re-run goes straight to the
// merge step (mergeBranchToMaster re-detects this and skips the re-merge) + close-out,
// instead of re-enqueueing at the BACK of the landing queue for pure bookkeeping (the 642
// land: head slot lost, ETA ~64 min). plan 4066 task 2a: isBranchAlreadyLanded moved whole to
// scripts/coord/land/spine.mjs (imported back above) — see that file's own header for the
// gpt-review 3972 probe-shape history this comment used to carry.

// plan 850: a crash with state.mergeSha still null may have happened AFTER the ephemeral push
// reached origin/master but BEFORE mergeToMaster's return-value assignment (a post-push fetch/sync
// throw). Probe origin for the real merge sha so the CRASH sidecar is honest — "landed (teardown
// incomplete)" rather than "nothing merged" (the plan-844 false-null that invites a clobbering
// hand-merge). Best-effort and fully guarded: it must NEVER throw and mask the original crash.
function recoverLandedMergeSha(MAIN, branch) {
  if (DRY || !MAIN || !branch) return null;
  try {
    const run = (cwd, args) => gitMain(cwd, args);
    if (branchAlreadyLanded(MAIN, branch, { run })) {
      return landedMergeSha(MAIN, branch, { run }) || null;
    }
  } catch {
    /* probe failed — leave mergeSha null (genuinely unproven) */
  }
  return null;
}

// ── build preflight (plan 504 Task 5) ────────────────────────────────
// `pnpm --filter @vetapp/frontend build` in the worktree when the land diff
// touches frontend/src/** — next build's strict TS pass catches what vitest,
// dev mode AND the mobile gate all miss (the gate whose manual-path skip broke
// the master frontend deploy 10:40–12:00 on 2026-06-10). Runs BEFORE the queue
// enqueue so a multi-minute build never holds the head slot. DW_FAKE_BUILD
// (ok|fail) is the test hook.
// --- per-gate pass-cache seam (plan 2462 task 3) ------------------------------
// The pre-enqueue preflights below (`next build`, the WebKit mobile gate) are the
// two expensive gates that live HERE rather than in scripts/hooks/pre-push.sh, so the hook's
// own wiring cannot reach them. Same contract as there: a gate is skipped only when
// this exact content already ran it green inside the TTL; ANY doubt runs the gate.
// The mobile gate carries ONE extra step (plan 2491): `check` runs its required-vs-not
// probe before it will hand back a key at all, so a run the probe did not call required
// is uncacheable at check AND refused at record — see gate-pass-cache.mjs's probe section.
//
// The CLI is invoked with cwd = the landing worktree, because the key is derived
// from that tree's HEAD content. The cache dir itself resolves via
// `git rev-parse --git-common-dir`, i.e. the shared main .git — which is exactly
// what makes this a lever-1 win: the branch push proves the build, and this
// preflight (or a later re-prep after master moves) hits the entry it recorded.
//
// Every call is best-effort: a throw, a non-zero exit, a missing key ⇒ treated as
// "no cached verdict" ⇒ the gate runs. A cache problem must never skip a preflight
// and must never fail a land.
//

// ── plan 3961 T1d: the land spine's extension-point registries ────────────────────────────────
//
// T1a-c built the registry (scripts/coord/land/registry.mjs), the `plugins.*` config key and its
// loader (scripts/land-plugins), and the core rosters (gates-core.mjs / seams-core.mjs). Every
// one of those was ADDITIVE by design — nothing consulted them. This is the wiring: the spine
// builds the five registries ONCE and then addresses each gate and seam through them instead of by
// direct call.
//
// WHY BOTH ROSTERS ARE NOW FULLY T2-MOVED. prepGates moved into scripts/project/land-gates.mjs
// (`vetappPrepGateEntries`); landSeams moved into scripts/coord/land/seams-core.mjs (core:
// review-marker, findings-open, conclusion-review — the last joined at T2.6, plan 3961 D2) and
// scripts/project/land-seams.mjs (status-flip, wiki-checkpoint, T2.5). "Every existing gate still
// runs through its old code path at this point (registered as a thin wrapper)" — the plan's own
// T1 wording: this step changed the ADDRESSING of a gate/seam, never its behaviour, which is what
// let the parity harness stay green with no golden re-record across every T2 sub-step.
//
// WHY BOTH SITES MUST READ THIS. There are TWO places that run prep gates, not one: the land's own
// phasePreflight blocks, and `runPrepGates` feeding the out-of-band `--prep` pre-pass. They were
// two independent hand-maintained lists, so a gate could run at land but not at prep — or in a
// different order — with nothing to catch it. One registry is what closes that; it is the whole
// reason this step wires two sites rather than the obvious one.
//
// `where` strings are deliberately distinct per source so registry.mjs's validation errors name the
// file that produced a bad entry.

/**
 * The ONE frozen bag every scripts/project/ gate/seam factory receives (plan 3961 D4), because a
 * project module cannot import done-worktree.mjs (the CLI entry, and a cycle) — so any
 * spine-internal helper a moved function used in place has to arrive as a parameter instead of a
 * static import. Memoized: one bag per process, not rebuilt per registry build.
 *
 * SHRINKS over T2/T3, MOSTLY: as `run`/`DRY`/`emitSeam`/... move under scripts/coord/land/, a
 * project module imports them directly and the member leaves this bag. Today it carries what
 * land-gates.mjs's market-copy gate needs (T2.1), the mobile gate's impure chunk-gate/ledger
 * helpers (T2.2, D6-resolved — see land-gate-mobile.mjs's own header for why those five stay
 * spine-only until T3), the pytest gate's own twelve (T2.3 — see land-gate-pytest.mjs's own
 * header), and the price-trust gate's `changedFiles` (T2.4 — the land's own diff reader, itself
 * spine-internal because it reads `run` and the DRY re-sha hook state; `DRY` is already shared
 * with market-copy, so price-trust adds only this one new member). Plan 4042 (D-A tail) is the one
 * place it GREW instead: `pruneCloudDiskHeadroom` joined for land-preflight-steps.mjs's
 * `runPreBuildDiskHeadroomStep` — see that function's own comment on the member for why (it is
 * ALSO reached by this file's own `bindLandDeps({ spine: { ... } })` group, for
 * scripts/coord/land/teardown.mjs's close-out call site, so it cannot move to either side).
 */
let SPINE_BAG = null;
function spineBag() {
  if (!SPINE_BAG) {
    SPINE_BAG = Object.freeze({
      DRY,
      run,
      chunkGateStartDecision,
      noStartGateResult,
      recordNoProgressRound,
      clearNoStartRoundFor,
      activeChunkWallVar,
      runViaTestQueue,
      stepLog,
      scopedGateSelection,
      gateCacheCheck,
      gateCacheClose,
      resolveHeadOid,
      scoreChunkRound,
      clearChunkRoundsSafe,
      ledgerRemainderCount,
      ledgerSubprocessTimeoutMs,
      ledgerSalvageTimeoutMs,
      LEDGER_CLI,
      QUEUED_RUN_CLI,
      changedFiles,
      // plan 3961 T2.8: the `deploy` postMerge entry's own members (land-gates.mjs's
      // `SPINE_MEMBERS_DEPLOY` in scripts/project/deploy.mjs names the full "why" per member) —
      // emitSeam/stepLog are the land's narration/halt primitives (stepLog already above);
      // runFullBatteryPreflight/runBuildPreflight are the UNCACHED variants the --deploy wall must
      // physically re-run (see resolveDeployGateTree's own header, moved with it); prepGateRun
      // addresses the market-copy prepGate through the registry; appendDeployGateOutcome is the
      // market-copy telemetry write; removeFinishWorktree is the ephemeral deploy-gate checkout's
      // teardown/self-heal; originMasterTip/worktreeHeadSha are resolveDeployGateTree's own
      // fetch-and-compare reads.
      emitSeam,
      runFullBatteryPreflight,
      runBuildPreflight,
      prepGateRun,
      appendDeployGateOutcome,
      removeFinishWorktree,
      originMasterTip,
      worktreeHeadSha,
      // plan 4042 (runPriceTrustGateStep's own move, land-gate-price-trust.mjs's
      // SPINE_MEMBERS_PRICE_TRUST): spine-resident because it lives, unexported, in this file
      // (readShardGateViews's own caller, shared with the status-flip/wiki-checkpoint gates —
      // see priceTrustRemainderClinics's own header for why it did not move with the step).
      priceTrustRemainderClinics,
      // plan 4042 (T1 tail, land-gate-seed.mjs's SPINE_MEMBERS_SEED_GATE): the seed-gate-views
      // contextExtras entry's own reader — spine-resident for the same reason as
      // priceTrustRemainderClinics just above, it lives, unexported, in this file and is ALSO
      // reached by that function, so it cannot move without stranding that other consumer.
      readShardGateViews,
      // plan 4042 (D-A tail, land-preflight-steps.mjs's `runPreBuildDiskHeadroomStep`): the ONE
      // place in this carve the bag GROWS rather than shrinks — a genuine constraint, not a
      // mistake. `pruneCloudDiskHeadroom` reads the module-private `DRY` flag directly and is
      // ALREADY spine-resident on this file's own `bindLandDeps({ spine: { ... } })` group (for
      // scripts/coord/land/teardown.mjs's close-out call site) — a project module may not import
      // done-worktree.mjs (the CLI entry point, a cycle), so it cannot move here, and it cannot
      // move to a project module either without stranding that OTHER, already-existing core
      // consumer. It stays exactly where it is and joins this bag as a second, independent
      // injection point instead. See land-preflight-steps.mjs's own header for the full account.
      pruneCloudDiskHeadroom,
    });
  }
  return SPINE_BAG;
}

// plan 4096 T1: the `runMobilePreflight` pre-binding shim that stood here had no caller left — the
// --deploy wall it served moved to scripts/project/deploy.mjs, which imports the gate directly.

// plan 3961 T2.3 / plan 4042 (D-A tail, land-step carve): the three pre-binding shims that used to
// live here (`pytestScopedSelection`/`runSelectedPytestPreflight`/`pytestRedIsFlake`) are gone —
// their only call sites were the pytest land step's diff-scoped E2/E5 arm, which now lives inside
// land-gate-pytest.mjs itself (`runPytestGateStep`) and calls this module's own sibling exports
// directly, passing `spine` straight through instead of needing a spine-bag pre-bind at the call
// site.

/**
 * The core landSeam implementations, in the `{ check }` bag shape coreSeams() takes.
 *
 * `conclusion` (plan 3961 T2.6/D2): joined the core roster here, alongside review/findings — the
 * seam's MECHANISM is generic over sharded record files, and only its guarded field list is
 * project vocabulary, so it takes `c.worldClaimFields` (sourced from `coord.config.json ->
 * land.worldClaimFields`) as a parameter rather than reading a hardcoded constant. Was previously
 * registered by this module's own (now-deleted) `vetappLandSeamEntries()` under
 * `where: 'spine (vetapp, pre-T2)'` — see the § landRegistries() header above for the history.
 */
function coreSeamImpls() {
  return {
    review: { check: (c) => seamResult(L.reviewSeam(c.changed, c.recordedVerdict)) },
    findings: {
      check: (c) =>
        seamResult(
          L.findingsGate(
            c.recordedVerdict,
            c.record,
            c.headSha,
            c.planExists,
            c.headPatchId,
            c.seedOnlyDelta,
          ),
        ),
    },
    // plan 4056 (the seam fold): the one CORE-registered adopter of the three new landSeams
    // fields. Its guard, its --resume code and its marker family were all spelled inline by
    // `runStatusFlipAndConclusionReviewGates`; they are declared here instead, and
    // `runLandSeamStep` runs them. The guard is verbatim — the same
    // !DRY/!alreadyLanded/shardsInDiff outer condition the wrapper shared with status-flip, PLUS
    // the handoff-layout condition only this seam carried (its marker can live ONLY in a session
    // entry, so a 'single'-layout consumer could never satisfy it and the gate would be
    // unwinnable).
    conclusion: {
      applies: (_diff, c) =>
        !c.DRY && !c.alreadyLanded && c.shardsInDiff && c.handoffLayout === 'sessions',
      seamCode: L.SEAM.CONCLUSION_REVIEW,
      markerFamily: {
        key: 'conclusion',
        lookup: (c) => recordedConclusionVerdict(c.MAIN, c.slug, c.wtPath, c.handoffLayout),
        recorder: 'record-conclusion.mjs',
      },
      check: (c) =>
        seamResult(
          L.conclusionReviewSeam(
            c.changed,
            c.seedGateBase?.records ?? null,
            c.seedGateHead?.records ?? null,
            c.seamMarker,
            c.shardIdPattern,
            c.worldClaimFields,
            c.seedLaneFile,
          ),
        ),
    },
  };
}

/**
 * The core prepGate implementations, in the `{ run, applies? }` bag shape coreGates() takes.
 *
 * plan 4096 T1: `prettier-drift` only. The `build` and `scripts-battery` implementations moved into
 * scripts/project/land-plugin.mjs — each wraps this repo's own tooling (a `next build`, the
 * `scripts/*.test.mjs` battery) — and still register through coreGates() there, from the same
 * CORE_PREP_GATE_SPECS rows, so their name/order/stage are unchanged.
 */
function coreGateImpls() {
  return {
    prettier: { run: (c) => runPrettierDriftCheck(c.wtPath) },
  };
}

// Memoized per MAIN. A land is one repo root, but keying on it rather than using a single slot
// keeps the test harness (which drives several sandboxes in one process) honest.
const LAND_REGISTRY_CACHE = new Map();

/**
 * Build (or return the memoized) five land registries for this checkout.
 *
 * ── WHY THIS DOES NOT LOAD `coord.config.json -> plugins.*` YET (plan 3961 T1d decision) ───────
 * T1b's handoff said to import `scripts/land-plugins` "from the SPINE and from tests only",
 * reasoning that its computed-specifier `import()` would then widen only the spine's own
 * pass-cache closure. THAT PREMISE IS FALSE, and this step measured it: `done-worktree.mjs` sits
 * INSIDE the closure of unrelated selections — a battery pass-cache test's closure is
 * 173 files and the spine is one of them — so a static import here widened the battery pass-cache
 * for a large fraction of the tree and turned `the battery pass-cache's own name-paired test` red
 * ("expected a narrowed key, got widen: dynamic-import:<the loader>"). The spine is the widest
 * closure in the tree, not a leaf of it; there is no "stops here".
 *
 * The widening is not a bug in the pass cache, either — it is CORRECT. A spine that can import
 * modules named by configuration genuinely has an unknowable gate closure, and the key must then
 * cover the whole tree. So the real question is whether to pay that repo-wide cost NOW, for a
 * capability with zero configured plugins in any checkout (`DEFAULT_PLUGINS` is empty and
 * coord.config.json carries no `plugins` key).
 *
 * The answer here is no, and the refusal below is LOUD rather than silent: a checkout that does
 * configure plugins gets an error naming the trade-off instead of gates that quietly never
 * register. T2 — which moves the vetapp gates into `scripts/project/land-gates.mjs` and is the
 * first step with a real module to load — owns the decision between (a) paying the widen, and
 * (b) a plain static import of the project module, which separates the code exactly as well and
 * keeps the closure resolvable, leaving `plugins.*` for a genuine third-party consumer.
 * `scripts/land-plugins` and its name-paired tests stand unchanged in the meantime.
 *
 * Async because that decision is T2's to reverse, and because the four `postMerge`/`closeOutExtras`
 * runners the registry exposes are async — a sync signature here would have to be rewritten then.
 */
async function landRegistries(mainDir, wtPath = null) {
  return landRegistriesSync(mainDir, wtPath);
}

// plan 4096 T1: the project layer, loaded ONCE per process as an OPTIONAL plugin. The specifier is
// a LITERAL on purpose (select-battery-tests.mjs's pass-cache and module-graph.mjs's closure read a
// literal dynamic import as an ordinary edge; only a computed one forces the repo-wide widen this
// file's landRegistries() header refuses `plugins.*` over). `importOptional` returns null ONLY when
// scripts/project/land-plugin.mjs itself is absent — core only; a plugin that exists but throws,
// or whose own import is missing, fails the boot here rather than degrading into a core-only land.
// Top-level await: this module's remaining top-level code — the bindLandDeps() call below — runs
// after it, so the plugin's container groups are in hand for the ONE bind.
const LAND_PLUGIN = await importOptional(
  new URL('./project/land-plugin.mjs', import.meta.url),
  () => import('./project/land-plugin.mjs'),
);

// plan 4096 T1/S9: the body of landRegistries(), unchanged, as a synchronous builder — nothing in
// it awaits (the project plugin is loaded ONCE at boot, before bindLandDeps), and the land
// fast-path evaluator, which is synchronous, needs the registry's prep-gate roster.
function landRegistriesSync(mainDir, wtPath = null) {
  const MAIN = mainDir || resolveMain();
  const key = `${MAIN}\u0000${wtPath ?? ''}`;
  const hit = LAND_REGISTRY_CACHE.get(key);
  if (hit) return hit;
  // BOTH configs are inspected, not just MAIN's (gpt-review 8429f3). The rest of the spine reads
  // MAIN's coord.config.json and that convention is unchanged — but the refusal below is a SAFETY
  // guard about the branch being landed, and a branch that adds `plugins.*` to its own
  // coord.config.json would be invisible to a MAIN-only read: the registry would build core and
  // spine entries alone and silently omit the gate the branch configured. Reading both means a
  // configured gate can never be skipped in silence, whichever side names it.
  const configuredPoints = [];
  for (const [label, root] of [
    ['the main checkout', MAIN],
    ...(wtPath && wtPath !== MAIN ? [['the worktree being landed', wtPath]] : []),
  ]) {
    for (const [point, paths] of Object.entries(loadCoordConfig(root).plugins ?? {})) {
      if (paths?.length) configuredPoints.push(`${label} — ${point}: ${paths.join(', ')}`);
    }
  }
  if (configuredPoints.length) {
    throw new Error(
      `done-worktree: coord.config.json configures land plugins (${configuredPoints.join('; ')}) ` +
        `but the spine does not load them yet (plan 3961 T1d — see landRegistries()'s header). ` +
        `Wiring scripts/land-plugins into the spine widens the battery pass-cache repo-wide, ` +
        `which the battery pass-cache's own name-paired test proves; plan 3961 T2 decides whether to pay ` +
        `that or to import project modules statically. Refusing rather than silently registering ` +
        `nothing, which would be gates that never run with a green land to show for it.`,
    );
  }
  // plan 4096 T1: the project's registrations come from the optional plugin (LAND_PLUGIN, loaded
  // above); absent, the core rosters stand alone. Called per build, so each registry gets freshly
  // constructed entries exactly as the inline factory calls this replaces did.
  const plugin = LAND_PLUGIN ? LAND_PLUGIN.landPlugin(spineBag) : null;
  const built = buildRegistries({
    prepGates: [
      { where: 'core', entries: coreGates(coreGateImpls()) },
      ...(plugin?.prepGates ?? []),
    ],
    landSeams: [
      // core: review-marker (2.5), findings-open (2.55), conclusion-review (2.672 — joined at
      // T2.6, plan 3961 D2).
      { where: 'core', entries: coreSeams(coreSeamImpls()) },
      // plan 3961 T2.5: status-flip (2.67) + wiki-checkpoint (2.68), from the plugin — order values
      // are unchanged, so the merged, sorted landSeams order is identical to before this split.
      ...(plugin?.landSeams ?? []),
    ],
    // plan 3961 T2.8: postMerge gains its first (and today only) entry — the `deploy` wall,
    // moved from the spine's own phaseDeployCheck into scripts/project/deploy.mjs. The core
    // still registers none (the § Design table's own "Core default: none").
    postMerge: plugin?.postMerge ?? [],
    // plan 3961 T2.9a: closeOutExtras gains its first (and today only) entry — the wiki coverage
    // sweep, moved from the spine's own phaseCloseOut into scripts/project/land-closeout.mjs.
    // The core still registers none.
    closeOutExtras: plugin?.closeOutExtras ?? [],
    // plan 4042 (T1 tail): contextExtras gains its first (and today only) entry — the
    // `seed-gate-views` hoist, moved from phasePreflight()'s own "SEED GATE VIEWS" block into
    // scripts/project/land-gate-seed.mjs. The core still registers none.
    contextExtras: plugin?.contextExtras ?? [],
  });
  LAND_REGISTRY_CACHE.set(key, built);
  return built;
}

/**
 * The once-per-land gate roster (plan 3961 T2.7a): DERIVED from the registry instead of a
 * separate `coord.config.json -> land.gateRoster` key. Exactly the registered prepGates whose
 * stage is 'preflight', in registry order.
 *
 * Membership only — unlike selectPrepGates, this does NOT filter by entryApplies. gatesProven's
 * sidecar parser and push-env writer (parseLandGatesProven / landGatesProvenPushEnv) need the
 * full set of names they may ever see on a sidecar, not just the ones today's diff happens to
 * trigger: a gate that skipped this land's diff but was proven by an EARLIER invocation in the
 * same worktree (a `--prep`, a prior push) still has to be a name the parser recognizes.
 *
 * Exported for done-worktree.test.mjs, which pins the exact roster (membership AND order) this
 * repo's registry produces — a unit-testable guarantee a source-inspection regex could not give.
 */
export function landGateRosterFromRegistry(registry) {
  return registry.prepGates.filter((g) => prepGateStage(g) === 'preflight').map((g) => g.name);
}

// plan 4066 task 2a: the async convenience wrapper, landGateRoster, moved whole to
// scripts/coord/land/spine.mjs (imported back above) — see that file's own header. This function
// (landGateRosterFromRegistry) stays: lane-merge.mjs calls it through the `spine` container group
// from OUTSIDE this file, so it cannot move with its wrapper.

// plan 4003, gpt-review r1 (bfe435) + r2 (e74e66): ONE spelling of "make this path POSIX", and it
// is `nightly-windows-suite.mjs`'s own `normalizeTargetToPosix` — the rule already applied to the
// target side of that module's completeness comparison, for exactly this reason. The battery's two
// vocabularies (`path.join` output from `listScriptsTestFiles`, `toPosixRelative` output from the
// ledger reporter) meet in three places here, and a second copy of the rule beside the first is the
// drift this repo's reuse convention exists to prevent.
// platform-assert-ok: a normalizer, not a platform branch.
export const toPosixPath = normalizeTargetToPosix;

// plan 3172: append that line to the shared `.git` gate-outcome-telemetry.log (resolved via the
// same git-common-dir rendezvous every lock uses). Best-effort in the EXACT style of gate_outcome():
// it NEVER throws, delays, or fails a land — a telemetry write must never be why a deploy gate that
// PASSED does not ship. Appends the line only (no header block): the log is created with its header
// by the pre-push hook long before any --deploy runs, and the Phase-2 consumer skips `#` comment
// lines regardless.
// plan 3997: EXPORTED (was module-private) and now ALSO the writer every land-preflight gate call
// site in phasePreflight() uses, passing `phase: 'land'` in `fields` — still the ONE appender, ONE
// format plan 3172 established; land call sites never hand-roll a second write path. Exported so
// done-worktree.test.mjs can drive the real guarded try/catch directly (a no-repo root via
// test-helpers/no-repo-root.mjs) rather than re-implementing the swallow it asserts.
export function appendDeployGateOutcome(wtPath, fields) {
  try {
    const commonDir = resolveCommonDirPath({ anchor: wtPath });
    const logPath = joinPath(commonDir, 'gate-outcome-telemetry.log');
    appendFileSync(logPath, formatGateOutcomeLine(fields) + '\n');
  } catch {
    // best-effort telemetry — swallow (unresolved common dir, EACCES, a transiently-locked .git)
  }
}

// (plan 556's runArtifactFreshnessPreflight — the generated-artifact freshness
//  land-time gate that ran a generated-artifact freshness checker in the
//  worktree — was REMOVED by plan 1024. the generated public search index is now
//  build-generated + gitignored, so there is no committed artifact to regenerate-and-
//  diff before the ephemeral merge. The non-vet leak guard it sat beside still runs at
//  the worktree-branch push (scripts/hooks/pre-push.sh regenerates the index, then checks).)

// plan 2875 cluster 1 (review fix): acquire the SAME machine-wide scripts-battery mutex
// scripts/hooks/pre-push.sh's own scripts-battery gate takes (battery-lock.mjs, plan 1673/2734) —
// mirrored here rather than invented afresh. Before this fix the land-time/deploy-gate battery ran
// `node --test` directly, unserialized: several land/deploy preflights on the shared 5-7-session
// machine could launch the full battery at once, exactly the process-storm plan 1673's mutex
// exists to prevent (the review's angle-B finding). Best-effort throughout: any acquire trouble
// (a lock error, a queue-wait expiry) degrades to the hook's own documented fallback — the battery
// still runs, UNSERIALIZED, never skipped (serialization is load-shedding, never a test-skip), at
// the hook's own reduced `--test-concurrency=2` clamp on the overflow/timeout path
// (battery-lock.mjs's EXIT_TIMEOUT=4). Deliberately NOT the hook's full retry-once/TAP-harvest
// machinery (run_battery_with_retry) — that is push-time robustness for a gate that already ran
// once per push; this preflight's own timeout/DW_FAKE_BATTERY handling is unchanged.
// plan 2875 delta round 2 (cluster D, review fix — findings d08b59/7157d9/89c720): the acquire's
// own spawnSync `timeout` must clear battery-lock's OWN wait ceiling (MAX_TOTAL_WAIT_SEC, imported
// as BATTERY_LOCK_MAX_TOTAL_WAIT_SEC) WITH HEADROOM — round 1's 300_000ms value sat UNDER that
// 4409s ceiling, so a legitimately-waiting acquire behind a healthy holder could be killed by THIS
// spawnSync before battery-lock.mjs itself ever gave up, and the kill was then folded into the
// generic "lock ERROR, run unserialized at full width" branch below: the exact plan-2734 thundering
// herd this mutex exists to prevent, reintroduced through the backstop meant only as a sanity net.
// Round 2's fix was two-part: raise THIS timeout well above the ceiling, AND (done-worktree-lib's
// batteryLockAcquireOutcome, its own comment) make our own ETIMEDOUT clamp exactly like
// battery-lock's EXIT_TIMEOUT rather than falling through to that "full width" branch — the second
// part is what actually closed the regression; the first was a belt-and-suspenders margin.
//
// BATTERY_LOCK_FULL_WAIT_MS below is that margin, derived rather than hand-copied (round 3 finding
// 7884b6): battery-lock.mjs's own worst-case wall time for its `acquire` CLI is the serialized wait
// (MAX_TOTAL_WAIT_SEC) PLUS the admission phase that follows it on the ceiling/stuck path
// (effectiveAdmissionWaitSec, battery-lock.mjs's own clamp of its admission window to that same
// ceiling) — not a flat "+600" that silently stops covering the real shape if either constant is
// ever retuned. BATTERY_LOCK_ACQUIRE_GRACE_MS on top is process overhead (mktemp/tee/write, OS
// scheduling delay under load) — same magnitude and reasoning as battery-lock.mjs's own
// HOLDER_PATIENCE_MARGIN_SEC idiom for the identical class of slop.
//
// plan 2875 delta round 3 (findings aa5711/e6c44f): that "belt-and-suspenders" candidate is no
// longer the whole story — because the ETIMEDOUT clamp above makes an early kill SAFE (it only ever
// degrades to reduced concurrency, never a skip), this timeout no longer needs to clear
// battery-lock's own ceiling to avoid the round-1 regression, which frees it to also respect a
// SECOND constraint the round-2 value ignored: it must not let the acquire wait alone outlive the
// locks THIS gate itself runs under. An acquire wait long enough can make a sibling see this
// holder as stale and reap it while we still believe we own the tree, which is worse than the
// premature-kill problem round 2 was solving (team-lead review: "reap a lock we still hold as
// stale ... worse than the timeout it fixed").
//
// plan 4034 T1 weakened — but did not remove — the premise underneath that. The WORKTREE lock is
// now renewed on a 30s heartbeat DURING a gate (`armWorktreeLockRenewal` above), so it no longer
// goes stale merely because a gate is slow; the LANDING lock (`landing-lock.mjs`, the other
// candidate below) still has no heartbeat at all. This floor is therefore kept as a
// belt-and-braces bound rather than tightened or dropped: it costs nothing on a healthy run, it is
// the only bound for the un-renewed lock, and a heartbeat that stops (a wedged parent) leaves the
// stale window exactly as it was. OUTER_LOCK_FLOOR_MS is the tighter of the two locks
// in play — WORKTREE_LOCK_MAX_HOLD_MS (worktree-lock.mjs, 40 min) and DEFAULT_STALE_MIN
// (landing-lock.mjs, 35 min — the seed land lock's own reclaim threshold, relevant on a combined
// seed `--deploy` land) — with the SAME grace subtracted as headroom for the renewal that follows
// this gate and for scheduling jitter. Whichever candidate is smaller wins: today that is always
// the outer-lock-derived one (35 min - 5 min = 30 min, comfortably under both the 4409s+300s
// battery-lock shape AND the 40/35-minute outer ceilings), but the `Math.min` keeps this correct
// automatically if either battery-lock's own ceiling is ever tuned down, or the outer locks are
// ever tuned up, without anyone having to remember to revisit this constant.
//
// This does NOT bound the battery RUN itself against the same outer floor, and since plan 4034 T4
// it deliberately must not: the land battery's run cap is DERIVED (`batteryRunCapMs`) and can
// legitimately exceed 40 minutes on a large selection under few workers. That is sound precisely
// because T1 renews the worktree lock while the gate runs — the gap this comment used to flag was
// closed by fixing the renewal, not by clamping the cap.
const BATTERY_LOCK_ACQUIRE_GRACE_MS = 5 * 60 * 1000; // 5 min — HOLDER_PATIENCE_MARGIN_SEC's own magnitude
const BATTERY_LOCK_FULL_WAIT_MS =
  (BATTERY_LOCK_MAX_TOTAL_WAIT_SEC + effectiveAdmissionWaitSec(BATTERY_LOCK_MAX_TOTAL_WAIT_SEC)) *
    1000 +
  BATTERY_LOCK_ACQUIRE_GRACE_MS;
const OUTER_LOCK_FLOOR_MS = Math.min(WORKTREE_LOCK_MAX_HOLD_MS, DEFAULT_STALE_MIN * 60 * 1000);
export const BATTERY_LOCK_ACQUIRE_TIMEOUT_MS = Math.min(
  BATTERY_LOCK_FULL_WAIT_MS,
  OUTER_LOCK_FLOOR_MS - BATTERY_LOCK_ACQUIRE_GRACE_MS,
);

// End `gate`'s no-start series: it reached a real verdict this round (ran to completion, failed for
// real, or was proven by a content-cache HIT).
//
// gpt-review 9e864e / 25a9ce / 12639d (three finders, one defect): the cache-hit path returns from
// `runBuildPreflightCached` BEFORE any chunk decision, so nothing else on it can do this — and a
// cache hit is the strongest "this gate is proven" signal there is. Leaving a stale round on record
// there meant a cached-green land carried it forward and the next genuinely tight round reported
// NON-CONVERGENT against a gate that was already green. Same reasoning for the battery's
// fully-green ledger fast path.
export function clearNoStartRoundFor(wtPath, gate) {
  // gpt-review r2 3d795e: cheapest check FIRST. This runs on every cache hit and every real verdict
  // — including the overwhelmingly common land where chunking is off and no tally was ever written —
  // and `noStartTallyKey` spawns a `git rev-parse`. Paying a subprocess to discover there is nothing
  // to clear would spend the very budget this plan exists to protect. An absent sidecar is a `stat`.
  if (!DRY && !existsSync(noStartSidecarPath(wtPath))) return;
  const sha = noStartTallyKey(wtPath);
  if (!sha) return;
  const tally = readNoStartTally(wtPath);
  if (!L.noStartRoundsFor(tally, sha, gate)) return; // nothing on record ⇒ no write at all
  writeNoStartTally(wtPath, L.clearNoStartRound(tally, sha, gate));
}

// plan 3961 T2.8: the Render/Railway IO shell (latestDeployStatus/serviceAutoDeploy/
// triggerManualDeploy/manualDeployBody/railwayGqlCurl/parseRailwayCurlResponse/
// railwayLatestDeployStatus/railwayTriggerManualDeploy/railwayPreflightDeployTargets) and
// checkDeploy itself moved to scripts/project/deploy.mjs's `deploy` postMerge entry — see
// that module's own header for the full move and land-gates.mjs's `SPINE_MEMBERS_DEPLOY`
// discipline this move follows.

// ── close-out (success path) ─────────────────────────────────────────
// GATE probe → board.mjs remove (NOT demote — this is success) → git mv +
// promotions → session-entry flip → atomic INDEX archive (local edit + build-index
// regen, all staged) → ONE close-out commit + push → seed-lock release. The
// refs/claims/<id> lock is released earlier, right after the merge (main()'s
// releaseClaimAfterMerge) — NOT here — so a close-out failure can't orphan it.
function gateProbe(MAIN, state) {
  if (DRY) return;
  const { paths } = loadCoordConfig(MAIN);
  const dirty = run('git', [
    '-C',
    MAIN,
    'status',
    '--porcelain',
    '--',
    paths.rollingHandoffFile,
    paths.boardFile,
    'docs/INDEX.md',
  ])
    .split('\n')
    .filter((l) => l && !l.startsWith('??'));
  if (dirty.length) {
    process.stdout.write(
      'done-worktree close-out: GATE probe found foreign modifications on shared paths:\n',
    );
    process.stdout.write(dirty.join('\n') + '\nAnother session is mid-flight. STOP.\n');
    releaseMutexIfHeld(state);
    dequeueQueueIfHeld(state); // plan 504: abort path — free the FIFO slot
    emitDoNotClose(L.SEAM.PREFLIGHT_FAIL, state); // plan 692: 🔴 close-safety banner
    writeResultSidecar(state, {
      code: L.SEAM.PREFLIGHT_FAIL,
      exitCode: L.EXIT[L.SEAM.PREFLIGHT_FAIL],
    }); // plan 665 G4.1
    process.exit(L.EXIT[L.SEAM.PREFLIGHT_FAIL]);
  }
}

// plan 1286: memoized per (MAIN, slug, layout) — one done-worktree run asks this identical
// question from 5+ sites, and the origin-first probe can now cost two `git grep` spawns per
// ask. The resolved PATH is stable for the whole run (the close-out edits the file's content,
// never its name), so caching is safe; a null (not found) is cached too — the session entry
// is written before any land reaches these readers.
// plan 4021: the cache holds the whole resolution CHAIN, `{ sf, older }` — `sf` the newest owned
// entry (the write target, what findSessionFile has always returned) and `older` the remaining
// anchored candidates NEWEST-first, which only the per-family marker READS consult
// (markerSourceEntry). Legacy / single-layout / DRY resolutions have no older entries.
// plan 4021 review round 3 (6b4c33): the path is stable for a run, but the CHAIN is not — a
// freshen or retry that fetches a newer claim entry changes which entry is newest. The chain is a
// pure function of the two refs it greps, so the cache key carries their tips and any ref move
// re-resolves. A tip that cannot be read (anything but "ref absent") skips the cache, and a refused
// resolution (lookup error, ambiguity, owner conflict) is never cached.
const _sessionFileCache = new Map();
function sessionChainRefTips(MAIN) {
  const tips = [];
  for (const ref of ['origin/master', 'HEAD']) {
    try {
      tips.push(
        run('git', ['-C', MAIN, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim(),
      );
    } catch (e) {
      if (e?.status !== 1) return null;
      tips.push('-'); // --verify --quiet exits 1, silently, only for a ref that does not exist
    }
  }
  return tips.join(' ');
}

function resolveSessionEntryChain(MAIN, slug, handoffLayout = 'sessions') {
  // Cache lookup FIRST — a hit must not re-pay the loadCoordConfig disk read either
  // (review 2026-07-02: the config load sat ahead of the cache check, so hits still parsed
  // coord.config.json every time).
  const live = handoffLayout !== 'single' && !DRY;
  const tips = live ? sessionChainRefTips(MAIN) : '';
  const cacheKey = tips === null ? null : `${MAIN}|${slug}|${handoffLayout}|${tips}`;
  if (cacheKey && _sessionFileCache.has(cacheKey)) return _sessionFileCache.get(cacheKey);
  const { paths } = loadCoordConfig(MAIN);
  let refused = false;
  const chain =
    handoffLayout === 'single'
      ? {
          sf: paths.rollingHandoffFile,
          entries: [paths.rollingHandoffFile],
          anchored: false,
          ref: null,
        }
      : DRY
        ? (() => {
            const sf = `${paths.sessionsDir}/<session>.md`;
            return { sf, entries: [sf], anchored: false, ref: null };
          })()
        : findSessionFileUncached(MAIN, slug, paths, () => {
            refused = true;
          });
  if (cacheKey && !refused) _sessionFileCache.set(cacheKey, chain);
  return chain;
}

function findSessionFile(MAIN, slug, handoffLayout = 'sessions') {
  return resolveSessionEntryChain(MAIN, slug, handoffLayout).sf;
}

function findSessionFileUncached(MAIN, slug, paths, onRefused = () => {}) {
  const none = { sf: null, entries: [], anchored: false, ref: null };
  // plan 1286: record-review lands the marker/sidecar via the coord-checkout push, so
  // origin/master is the source of truth and MAIN's HEAD may lag (its ff is opportunistic).
  // Grep the fetched origin ref FIRST (the preflight already fetched), then MAIN's HEAD
  // (--no-push / offline records exist only there).
  //
  // plan 2838: the SAME shared protocol record-marker-cli.findSessionFile drives
  // (L.resolveSessionEntry) — `*.md` entries only, the frozen pre-205 archive excluded at the
  // git level AND in the ranker, the anchored `**Branch:**` ownership line preferred over a
  // bare mention, an un-disambiguatable legacy match refused. This half is the one that
  // matters most: the writer's mis-resolve clobbers a record, but a mis-resolve HERE lets the
  // reviewSeam / FINDINGS_OPEN land gates pass a land on a stranger's verdict and dispositions.
  //
  // Fail CLOSED: a null here reads to every caller as "no session entry", which halts the
  // review/findings gates rather than passing them — the safe side of an ambiguity. That is also
  // why neither refusal falls through to the next ref. plan 4021 review round 2 (ae1b7d): the
  // ref walk itself is the ONE shared L-free helper record-marker-cli also drives.
  const chain = resolveSessionChainOverRefs({
    refs: ['origin/master', 'HEAD'],
    slug,
    paths,
    tool: 'done-worktree',
    report: (msg) => {
      onRefused();
      process.stdout.write(msg + '\n');
    },
    // review round 3 (5ffd98): only "no match" or a missing ref is an empty answer; any other grep
    // failure throws, and the shared resolver refuses (fail closed) rather than reading HEAD.
    grepFor: (ref) => (pattern, pathspec, mode) =>
      grepOrNoMatch(() =>
        run('git', [
          '-C',
          MAIN,
          'grep',
          '-l',
          mode === 'regex' ? '-E' : '-F',
          pattern,
          ref,
          '--',
          ...pathspec,
        ]),
      ),
    readEntryFor: (ref) => (p) => run('git', ['-C', MAIN, 'show', `${ref}:${p}`]),
  });
  return chain || none;
}

// best-effort; a failure is recorded, never thrown.
function tryStep(state, label, fn) {
  try {
    return fn();
  } catch (e) {
    (state.teardownErrors ||= []).push(`${label}: ${e.message || e}`);
    return null;
  }
}

// ── plan 971: post-merge close-out in an EPHEMERAL worktree off origin/master ──
// The branch MERGE already landed on origin (mergeToMaster → land-lib's ephemeral lander).
// The remaining bookkeeping — the archive/INDEX/session close-out commit + the board/queue/
// mint coordWrites — used to run against the SHARED main checkout, so a sibling's uncommitted
// dirt there REFUSED the coordWrites (coordWrite's assertCleanOutsidePathspec) and blocked a
// completed land (the 956 44-min double-block). Run it in a freshly-checked-out detached
// worktree instead: zero foreign dirt, so coordWrite never refuses and its ff-only freshen
// always advances. The shared main checkout is fast-forwarded OPPORTUNISTICALLY afterward
// (best-effort, skipped if dirty) — it is never the source of any push, so its cleanliness no
// longer gates a land. DRY skips all of this (main() calls closeOut(MAIN) directly), so the
// dry-run command trace is byte-identical to pre-971.
const finishWorktreePath = (MAIN, slug) =>
  // bounded like cut-worktree's MAX_DIR_SLUG; the finish worktree runs only git + file IO
  // (no turbopack build), so the Windows MAX_PATH artifact-tail concern does not apply, but a
  // short, plan-id-prefixed name stays unique + tidy.
  `${MAIN}/.claude/worktrees/_finish-${String(slug).slice(0, 32)}`;

// plan 2401 — unlink the finish worktree's node_modules JUNCTION (created by
// linkNodeModulesIntoFinishWorktree below) before anything recursively deletes the finish
// worktree. Plan 2697 moved the implementation to scripts/coord/junction-guard.mjs (its header carries
// the full hazard write-up + both sandbox reproductions) so the OTHER recursive deleter in the
// spine — sweep-deferred-worktrees.mjs — can arm the same guard without an import cycle. The
// re-export keeps this module's public surface unchanged for its callers and unit tests.
export { unlinkNodeModulesJunction };

// Idempotent teardown of a finish worktree (mirrors land-lib's _land-* lifecycle): junction
// unlink FIRST (see above — MUST precede the git call), then git-remove, then a force rmdir +
// prune backstop. Run at the START of every isolated close-out too, so a finish worktree leaked
// by a prior run's emitSeam (process.exit bypasses the finally) is healed on the next
// invocation of the same slug.
function removeFinishWorktree(MAIN, eph) {
  // disarmJunction IS the never-throws wrapper (an unexpected throw counts as "still armed" —
  // fail toward safety); re-rolling that try/catch here would be a second copy of the policy
  // (gpt-review e1177f).
  const junction = disarmJunction(eph);
  if (junction === 'failed') {
    // Review round 1: the git call is the TRAVERSING deleter, so it must never run while a
    // junction is still in place — skip it entirely. The rmSync below does not traverse (it
    // unlinks the junction or fails on it), and a surviving dir is picked up by the
    // deferred-removal sweep; `git worktree prune` clears the admin entry once the dir is gone.
    console.error(
      `done-worktree: finish-worktree node_modules junction could NOT be unlinked at ${eph} — ` +
        `SKIPPING the git-level removal (it would delete MAIN's real node_modules through the ` +
        `junction); falling back to rmSync + prune.`,
    );
  } else {
    try {
      run('git', ['-C', MAIN, 'worktree', 'remove', '--force', eph]);
    } catch {
      /* fall through to prune + rmdir */
    }
  }
  if (existsSync(eph)) {
    try {
      rmSync(eph, { recursive: true, force: true });
    } catch {
      /* honest — a residual dir is surfaced by the prune below / next-run cleanup */
    }
  }
  try {
    run('git', ['-C', MAIN, 'worktree', 'prune']);
  } catch {
    /* best-effort */
  }
}

// Opportunistically advance the shared main checkout's local master to the just-landed origin
// tip. PURE CONVENIENCE: the land is already complete on origin and the close-out was pushed
// from the finish worktree, so this MUST NEVER fail a land. Skipped + recorded when the main
// checkout is dirty (foreign sibling work) or diverged — precisely the state plan 971 makes
// non-blocking. A clean fast-forward also lets teardown's `git branch -d` see the merge.
//
// plan 1286: the ATTACHMENT step is NOT opportunistic — it always runs, ff or no ff. During
// the 2026-07-02 incident a clean exit-0 land skipped the ff (foreign dirt) and ended with
// MAIN still DETACHED (left by a sibling's killed rebase), which broke resolveMain's
// on-master assert for every subsequent coord writer. reattachMainToMaster moves only the
// symbolic ref when the detached commit holds no unique work (ancestor of origin/master);
// anything unsafe is recorded, never forced.
function opportunisticFfMain(MAIN, state) {
  try {
    const res = reattachMainToMaster(MAIN);
    if (res.reattached) {
      (state.teardownErrors ||= []).push(
        `main-checkout HEAD was detached at ${String(res.from).slice(0, 9)} — reattached to master (plan 1286 post-land hygiene; informational).`,
      );
    }
  } catch (e) {
    (state.teardownErrors ||= []).push(
      `main-checkout reattach skipped (land already complete on origin): ${e.message || e}`,
    );
  }
  try {
    run('git', ['-C', MAIN, 'fetch', 'origin', 'master']);
    const dirty = run('git', ['-C', MAIN, 'status', '--porcelain']);
    if (dirty) {
      (state.teardownErrors ||= []).push(
        'opportunistic main-checkout fast-forward skipped — the shared main checkout is dirty ' +
          '(foreign sibling work); origin/master is the source of truth and the land is complete.',
      );
      return;
    }
    run('git', ['-C', MAIN, 'merge', '--ff-only', 'origin/master']);
  } catch (e) {
    (state.teardownErrors ||= []).push(
      `opportunistic main-checkout fast-forward (land already complete on origin): ${e.message || e}`,
    );
  }
}

function linkNodeModulesIntoFinishWorktree(MAIN, eph) {
  const src = `${MAIN}/node_modules`;
  const dest = `${eph}/node_modules`;
  if (existsSync(dest) || !existsSync(src)) return;
  try {
    symlinkSync(src, dest, 'junction');
  } catch {
    /* best-effort — see comment above */
  }
}

// plan 3961 T3.2 (fix-now, same defect class T3.1 found once already): this comment used to sit
// above linkNodeModulesIntoFinishWorktree, a smaller unrelated helper two functions above it — it
// actually describes runCloseOutIsolated's whole job, so it moves here, with it.
//
// Create the ephemeral finish worktree off origin/master, run closeOut against it (every coord
// subprocess routed to it via COORD_MAIN_DIR — see the node() helper), tear it down, then
// opportunistically sync the main checkout. A seam inside closeOut (emitSeam → process.exit)
// bypasses the finally; the leading removeFinishWorktree on the operator's re-run is the backstop
// (same self-healing contract as land-lib's stale _land-* cleanup).
// The finish worktree is a bare `git worktree add` — no `pnpm install`, ever (it only ever
// does git + file IO, per the comment above finishWorktreePath). That was fine until the
// close-out commit started touching prettier-relevant paths (archived plan .md files,
// INDEX.md): `scripts/hooks/pre-push.sh`'s `pnpm exec prettier --check` then fails with "'prettier' is
// not recognized" because there is no node_modules to resolve it from (observed 2026-07-06,
// batch-2026-07-06-seed-dq). A real `pnpm install` here would cost real time for a worktree
// that is deleted moments later; a Windows directory junction of MAIN's already-installed
// node_modules is near-instant and sufficient — `pnpm exec` only needs to resolve the bin,
// it never modifies node_modules from this worktree. Best-effort: a missing/unusual MAIN
// node_modules (a sibling project adopting this script pre-`pnpm install`) must not break the
// close-out, so failures here are swallowed, not surfaced — the pre-push prettier step simply
// fails again with the same actionable error if the junction didn't help.
// ⚠ TEARDOWN HAZARD (plan 2401): this junction MUST be unlinked before any recursive delete of
// the finish worktree — see unlinkNodeModulesJunction above for the store-tear incident it caused.
// plan 2912: this junction is right for the CLOSE-OUT worktree (git + file IO + `pnpm exec prettier`,
// all served by the root `.bin`) and deliberately stays root-only. It is NOT enough for the plan-2875
// pre-deploy gate's ephemeral checkout, which runs `pnpm --filter @vetapp/frontend build` — see
// installDepsForDeployGate below for why that one gets a real install instead.
function runCloseOutIsolated(MAIN, state, carryForwards) {
  const eph = finishWorktreePath(MAIN, state.slug);
  removeFinishWorktree(MAIN, eph); // heal a leaked finish worktree from a crashed/seamed prior run
  run('git', ['-C', MAIN, 'fetch', 'origin', 'master']);
  run('git', ['-C', MAIN, 'worktree', 'add', '--detach', eph, 'origin/master']);
  linkNodeModulesIntoFinishWorktree(MAIN, eph);
  _coordMainDir = eph;
  try {
    closeOut(eph, state, carryForwards);
  } finally {
    _coordMainDir = null;
    removeFinishWorktree(MAIN, eph);
  }
  opportunisticFfMain(MAIN, state);
}

// plan 3961 T2.8: resolveDeployGateTree (and installDepsForDeployGate/DEPLOY_GATE_INSTALL_TIMEOUT_MS/
// deployGateWorktreePath above it) moved to scripts/project/deploy.mjs — see that module's own
// header for the full move.

// plan 3961 T2.9a: the decoupled wiki coverage sweep (plan 1082) moved to
// scripts/project/land-closeout.mjs as the vetapp `closeOutExtras` registry entry
// (`wiki-coverage-sweep`) — see that module's own header for the full move.

// plan 2697 — hand the land over to MAIN's copy of the spine when this process loaded a
// different one (the normal case: the session self-invokes from inside its worktree, so Node
// loaded THAT checkout's spine, frozen at whatever commit the branch was cut from). See
// done-worktree-lib.mjs § "run the land spine from MAIN" for the incident this closes.
//
// Contract, precisely (gpt-review 4a4a81 sharpened this): the guard itself can only REDIRECT a
// land, never block one — an unreadable file, a missing MAIN copy, a MAIN copy that does not even
// parse, or a spawn that never starts all fall through to the copy already loaded, exactly as
// before this guard existed. But once MAIN's spine HAS STARTED it IS the land, so its exit code is
// the land's; re-running the land here after a started child failed would double-run it. The
// realistic "MAIN is broken" case — a truncated or half-written file — is caught by the
// `node --check` preflight below, BEFORE anything is handed over.
// Returns the child's exit code to propagate, or null to continue in THIS process.
//
// Freshness is keyed to the whole local import CLOSURE, not just this file: a safety fix landing
// only in done-worktree-lib.mjs or junction-guard.mjs leaves the entry byte-identical, so an
// entry-only check would fire no handoff and the stale LIBRARY would keep running - this same bug
// one level down. Plan 2401's own fix would have been missed once it moved into junction-guard.mjs.
//
// The scanner is `extractLocalImportTargets` from coord-share-lib.mjs - the repo's ONE local-import
// scanner (plan 2160 hoisted it there so the coord-sync gate and adoptClosureGaps share it). It
// already handles `from '...'`, bare `import '...'` and dynamic `import('...')`, and it returns
// dir-relative posix paths, which is exactly the key this digest needs.
//
// Returns { digest, members } - members are scripts-relative posix paths, used by the parse
// preflight below. Never throws; `digest` is null only when the ENTRY itself is unreadable.
function spineClosureDigest(scriptsDir, entryRel) {
  const parts = [];
  const members = new Map(); // scripts-relative posix path -> sha256 of its source
  const seen = new Set();
  const stack = [entryRel];
  let entryReadable = false;
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src = null;
    try {
      src = readFileSync(resolvePath(scriptsDir, rel), 'utf8');
    } catch {
      /* handled below */
    }
    if (src === null) {
      // The scanner over-reports on purpose (see extractLocalImportTargets), so a target that
      // does not resolve to a readable file is usually import-shaped prose inside a string, and
      // occasionally a genuinely missing module. Either way: record the absence in the digest and
      // CONTINUE. Nulling the whole digest here would make the guard skip the handoff, i.e. fail
      // OPEN into exactly the stale-spine execution it exists to prevent (gpt-review round 2),
      // and REFUSING on it made a phantom silently do the same (round 6). Recording it is safe
      // because the file that IMPORTED it is itself hashed, so a real deletion still shows up.
      parts.push(`${rel} <unreadable>`);
      continue;
    }
    if (rel === entryRel) entryReadable = true;
    members.set(rel, createHash('sha256').update(src).digest('hex'));
    // Per-file digest computed as we read: retaining every source (~2 MB across the closure)
    // only to re-scan it at the end was pure peak heap for no gain (gpt-review round 2).
    parts.push(`${rel} ${members.get(rel)}`);
    // The scanner blanks comments AND rejects import-shaped text inside strings, so every target
    // it returns is a real dependency (plan 2697 moved that into the shared extractor, where it
    // also fixes adoptClosureGaps). That is what lets a missing member below mean "MAIN really is
    // missing a module" instead of "someone wrote an import in a comment".
    for (const t of extractLocalImportTargets(src, rel)) stack.push(t);
  }
  if (!entryReadable) return { digest: null, members: new Map() };
  const h = createHash('sha256');
  // Keyed by scripts-RELATIVE path, not basename: absolute paths differ between the two trees
  // (they live at different roots) and would make every land look stale, while a basename can
  // collide across subdirectories (`test-helpers/`) and let two swapped modules hash equal
  // (gpt-review round 2). The separator is the ESCAPE \u0000, never a raw NUL byte in this
  // source - a literal NUL makes ripgrep classify the file as binary and skip it entirely.
  for (const p of parts.sort()) h.update(p).update('\u0000');
  return { digest: h.digest('hex'), members };
}

function maybeReexecSpineFromMain(MAIN, argv = process.argv.slice(2)) {
  if (DRY) return null; // keep the dry-run command trace byte-identical
  // gpt-review 15b6b0: --prep re-validates a QUEUED branch's gates and stamps a pass marker the
  // head fast path trusts. A plan whose whole subject is changing prep/gate logic must have that
  // validated by ITS OWN copy, or MAIN's older logic stamps a pass the plan never earned. The
  // store tear lives in the land/teardown path, which --prep never reaches, so excluding it costs
  // this fix nothing.
  if (argv.includes('--prep')) return null;
  let decision;
  let mainFile;
  let mainScripts;
  let run = null;
  let main = null;
  try {
    const runningFile = fileURLToPath(import.meta.url);
    mainScripts = `${MAIN}/scripts`;
    // Spelled `${MAIN}/scripts/<name>.mjs` — the repo's dominant idiom (see build-index.mjs and
    // wiki-coverage-sweep.mjs above) — and NOT `${mainScripts}/done-worktree.mjs`, which is the
    // same path but unreadable to `unresolvedScriptRefReason`: that classifier blanks a literal
    // `scripts/<name>.mjs` before asking whether anything path-shaped survives, so the
    // mainScripts form leaves an interpolation-then-basename residue and classifies as
    // `template-path`. That widens the battery pass-cache key for THIS file from its own import
    // closure back to the whole `scripts/` tree — sound, but a real regression in the cache's hit
    // rate, and pinned by "the pass-cache own-closure selection NARROWS on real sources" in
    // battery-pass-cache.test.mjs (which is how it was caught: the pre-push battery, not review).
    mainFile = `${MAIN}/scripts/done-worktree.mjs`;
    const alreadyReexeced = process.env[L.SPINE_REEXEC_ENV] === '1';
    // Settle the no-op cases BEFORE reading anything, so the common path (a land launched from
    // MAIN itself) touches no files at all (gpt-review 65eb73). These are checked INLINE rather
    // than by calling the decider with sentinel hashes and pattern-matching its prose: keying
    // control flow on a human-readable reason string means renaming that string silently changes
    // behaviour (gpt-review round 2). spineReexecDecision below re-checks them and stays the one
    // authority; this is a cheap pre-filter, not a second opinion.
    if (alreadyReexeced) return null;
    if (L.samePathForPlatform(runningFile, mainFile)) return null;
    if (!existsSync(mainFile)) return null;
    // Both closures, walked once. An earlier cut hashed the entry files first and skipped the
    // walk when they already differed, but the parse preflight below needs the member lists on
    // exactly that path, so the "saved" walk was immediately re-done (gpt-review round 3). One
    // walk each, reused for the decision AND the preflight, is both simpler and cheaper.
    run = spineClosureDigest(dirnamePath(runningFile), basenamePath(runningFile));
    main = spineClosureDigest(mainScripts, 'done-worktree.mjs');
    decision = L.spineReexecDecision({
      runningFile,
      mainFile,
      runningSha: run.digest,
      mainSha: main.digest,
      alreadyReexeced,
    });
  } catch {
    return null; // never let the guard itself fail a land
  }
  if (!decision.reexec) return null;
  // Do not hand a land to a MAIN copy that cannot PARSE: a truncated or half-written file, or one
  // carrying conflict markers, would abort the land when the copy in hand is fine. Checking only
  // the ENTRY was not enough - a malformed IMPORTED module still parses the entry, then kills the
  // child at module-load time (gpt-review round 2).
  //
  // Only members whose CONTENT DIFFERS are checked. Everything else is byte-identical to a file
  // this very process already imported successfully, so it is proven loadable; re-checking the
  // whole ~50-file closure spawned ~50 node processes per handoff for no information
  // (gpt-review round 3). The entry is deduplicated - it is already a member.
  //
  // A member the scanner named but could NOT read is deliberately NOT treated as a broken MAIN.
  // Earlier revisions did exactly that, and it cost two rounds: the scanner over-reports (see
  // extractLocalImportTargets), so a phantom in MAIN made the guard refuse a legitimate handoff
  // and SILENTLY run the stale spine - the failure this whole plan exists to eliminate. Trying to
  // make the scanner exact instead traded that for dropping real imports, which is worse. So the
  // guard no longer depends on scanner precision at all: an actually-missing module in MAIN means
  // MAIN's master is broken for every tool, and it fails LOUDLY (the child dies at module load,
  // the land aborts visibly, nothing is silently corrupted) - the same trade already accepted for
  // the shared-checkout TOCTOU, which every child `scripts/...` spawn in this spine has always had.
  try {
    const childEnv = L.spawnEnv(); // plan 2604: no child inherits implicitly; built once
    let bad = null;
    for (const rel of main.members.keys()) {
      if (run.members.get(rel) === main.members.get(rel)) continue;
      const abs = resolvePath(mainScripts, rel);
      const chk = spawnSync(process.execPath, ['--check', abs], { stdio: 'ignore', env: childEnv });
      if (!chk || chk.error || chk.status !== 0) {
        bad = abs;
        break; // the first failure decides it; resolving the rest is wasted work
      }
    }
    if (bad) {
      console.error(
        `done-worktree: MAIN's spine does not parse (${bad}). Continuing with the copy ` +
          'already loaded (pre-plan-2697 behaviour).',
      );
      return null;
    }
  } catch {
    return null;
  }
  console.error(`done-worktree: ${decision.reason}`);
  let r;
  try {
    // plan 2604: the shared seam merges the layer over process.env and scrubs the RESULT — never
    // a bare `...process.env` spread (done-worktree.test.mjs guards this file for it).
    const childEnvVars = L.spawnEnv({ [L.SPINE_REEXEC_ENV]: '1' });
    // plan 3832: plan 2697's narrow re-add of ALLOW_LANDED_REVERSION after `spawnEnv`'s scrub
    // (so a land-time override survived the MAIN re-exec) is retired with the override itself —
    // the landed-reversion lint no longer halts, so there is nothing for the spawned MAIN copy
    // to be released from. `spawnEnv`'s no-opt-out scrub contract is left exactly as it was.
    r = spawnSync(process.execPath, [mainFile, ...argv], {
      stdio: 'inherit',
      cwd: MAIN,
      env: childEnvVars,
    });
  } catch {
    r = null;
  }
  // A spawn that never started (ENOENT/EACCES) must NOT silently end the land as a success —
  // fall through and run here instead, which is strictly the pre-2697 behaviour.
  if (!r || r.error || (r.status === null && !r.signal)) {
    console.error(
      'done-worktree: re-exec from MAIN could not start. Continuing with the copy already ' +
        'loaded (pre-plan-2697 behaviour).',
    );
    return null;
  }
  if (r.signal) {
    console.error(`done-worktree: re-execed spine was killed by ${r.signal}`);
    return 1;
  }
  return r.status;
}

// plan 3832: two helpers lived here and are gone with the halt they served —
// `stripReversionReleaseFlags` (which pre-scrubbed the three `--allow-landed-reversion*` flags out
// of argv so `L.parseDoneArgs` could not mistake a release REASON for the slug) and
// `culpritTestRunnerWithPreflightReuse` (which let plan 3210's culprit-test evidence reuse the
// backend/scripts pytest preflight when the head-time rebase had not moved HEAD). With no halt
// there are no release flags to strip and no release decision to gather evidence for. The
// underlying `defaultCulpritTestRunner` / `culpritTestEvidence` stay in the guard module for its
// own `--explain` CLI and suite.

// plan 3815 gpt-review round 3 (findings aba3d8 / 922202, both CONFIRMED): the ONE place the
// disk-headroom prune() call is made, shared by the pre-build preflight call site (phasePreflight,
// below) and the --finish-close-out recovery call site (runFinishCloseOut, immediately below) —
// same real IO, same DRY echo convention (`DRY disk-headroom prune --keep <path> --root <MAIN>`,
// unchanged from round 1/2 when `keep` is passed), same freed-bytes/deleted-count return shape.
// `keep` is OPTIONAL and every caller with no build left to protect omits it: an alreadyLanded
// close-out retry and --finish-close-out (whose state.wtPath is null BY CONSTRUCTION — see
// finishCloseOutState's own comment, there is no worktree at all on that path) both reclaim the
// merged worktree's OWN caches too, not only its siblings' — no build is going to run on either
// path, so nothing is worth preserving there (finding 922202). A normal pre-merge cloud land is
// unchanged: its caller still passes `keep: wtPath` (round 1/2 behavior, mandatory).
// `env` is the caller's environment, defaulting to the real one. Only the DRY fake-accounting
// below reads it, but it is a parameter for the same reason the rest of the disk-headroom lane
// became one (gpt-review round 4, plan 4042): the preflight step now resolves its cloud branch,
// its free-space reading and its floor from an injected env, and a prune whose accounting stayed
// ambient would report 0 bytes / 0 directories into that step's DISK_HEADROOM_LOW message — an
// operator reading that seam would be told nothing was reclaimed while the injected run says
// otherwise. A half-injected lane is the defect, not a milder version of it. The close-out caller
// in scripts/coord/land/teardown.mjs passes nothing and is unchanged.
function pruneCloudDiskHeadroom(MAIN, keep, env = process.env) {
  if (DRY) {
    process.stdout.write(
      `DRY disk-headroom prune${keep ? ` --keep ${keep}` : ''} --root ${MAIN}\n`,
    );
    return {
      freedBytes: Number(env.DW_FAKE_DISK_PRUNE_FREED_BYTES ?? 0),
      deletedCount: Number(env.DW_FAKE_DISK_PRUNE_COUNT ?? 0),
    };
  }
  return diskHeadroomPrune({
    mainCheckoutPath: MAIN,
    worktreesRoot: joinPath(MAIN, '.claude', 'worktrees'),
    keep,
  });
}

/** Preflight phase in the file header's five-phase landing sequence.
 * plan 4066 task 2a: moved to scripts/coord/land/spine.mjs — see that file's own header. */

/** Lane-merge phase in the file header's five-phase landing sequence.
 * plan 3961 T3.6b: moved to scripts/coord/land/lane-merge.mjs — see that file's own header. */

/** Deploy-check phase in the file header's five-phase landing sequence.
 * plan 4066 task 2b: moved to scripts/coord/land/spine.mjs, alongside phasePreflight and main()
 * — see that file's own header. No caller left in this file; main() (also moved) calls it
 * same-module there, exactly as it already called phasePreflight. */

/** Close-out phase in the file header's five-phase landing sequence.
 * plan 4066 task 2b: moved to scripts/coord/land/spine.mjs, alongside phasePreflight and main()
 * — see that file's own header. No caller left in this file; main() (also moved) calls it
 * same-module there, exactly as it already called phasePreflight. */

/** Teardown phase in the file header's five-phase landing sequence.
 * plan 4066 task 2b: moved to scripts/coord/land/spine.mjs, alongside phasePreflight and main()
 * — see that file's own header. No caller left in this file; main() (also moved) calls it
 * same-module there, exactly as it already called phasePreflight. */

/** The five-phase driver.
 * plan 4066 task 2b: moved to scripts/coord/land/spine.mjs (imported back below) — see that
 * file's own header. Called only from the entrypoint guard at the bottom of this file. */

// Read the "Carry-forward" / "What's left" bullets from this session's handoff
// entry. Empty (→ no ambiguity) when not found; disposition-named bullets
// auto-execute, bare ones raise CARRYFORWARD_AMBIGUOUS (classifyCarryForwards).
function readCarryForwards(wtPath, state) {
  // test-only hook (mirrors DW_FAKE_DIFF): `|`-separated bullets so the dry-run can
  // exercise the close-out carry-forward classify + mint without a scratch handoff.
  // Honoured ONLY under --dry-run (like DW_FAKE_FOREIGN_DIRT/DW_FAKE_INDEX_WRITE) — a leaked env
  // var must NEVER inject fake carry-forwards into a real production land's close-out (gpt-review
  // 4066 finding b4cbf8: this read used to run unconditionally, before the DRY check below, so an
  // ambient DW_FAKE_CARRYFORWARDS — every key in `98 Hobby/.env_cloud_drain` is exported in every
  // cloud sandbox — could make a real close-out classify/mint the injected bullets instead of the
  // actual handoff). Every DW_FAKE_CARRYFORWARDS test case (done-worktree.test.mjs's dryRunCF /
  // dryRunEnv) spawns a real `node … --dry-run` subprocess, so DRY there is computed from that
  // child's own argv and is genuinely true — this gate changes no test's outcome.
  if (DRY && process.env.DW_FAKE_CARRYFORWARDS !== undefined) {
    return process.env.DW_FAKE_CARRYFORWARDS.split('|').filter(Boolean);
  }
  if (DRY) return [];
  try {
    const main = resolveMain();
    const cfg = loadCoordConfig(main);
    // plan 4075: resolveSessionEntryChain resolves the entry over git REFS
    // (origin/master first — record-review lands there and MAIN's HEAD may lag by design,
    // plan 1286), so the read below must follow the SAME ref, not the working tree the
    // resolver never consulted. `sf === null` is the real, expected "no session entry" case
    // (including a fail-closed refusal, which never falls through per plans 1286/2838/4021);
    // it is NOT the same as a resolved entry that then fails to read.
    const chain = resolveSessionEntryChain(main, state.slug, cfg.handoffLayout);
    const sf = chain.sf;
    if (!sf) return [];
    let txt;
    if (chain.ref) {
      // A ref won resolution: read the entry from THAT ref and no other source. A failure here
      // is a real post-resolution read failure — never silently substitute a different source
      // (that reintroduces the exact "parse an unpinned, possibly-stale source" bug class this
      // plan exists to kill, one layer down: review-fix round 1, findings
      // 2c3905/a238fb/978f7b/127dbf/f9b1a8/8d2139).
      try {
        txt = run('git', ['-C', main, 'show', `${chain.ref}:${sf}`]);
      } catch (e) {
        const msg = `readCarryForwards: session entry "${sf}" resolved on ${chain.ref} but could not be read: ${e.message || e}`;
        (state.teardownErrors ||= []).push(msg);
        process.stdout.write(msg + '\n');
        return [];
      }
    } else {
      // No ref won: the `single`/DRY layouts synthesize a STATIC, never-resolved path
      // (paths.rollingHandoffFile) with no I/O. A missing file there is the expected "nothing
      // recorded yet" case, not a failure — keep the pre-4075 silent empty return. But that is
      // ONLY genuine absence per the repo's one strict read classification
      // (scripts/coord/review-markers.mjs's isFsPathAbsentError, lines 385-429): ENOENT on the
      // read AND an lstat of the same path also finds nothing. Anything else — EACCES, EISDIR, a
      // dangling symlink, a spawn/IO failure — is a real read failure and must surface exactly
      // like the ref-won branch above, never be swallowed as "nothing recorded" (review-fix
      // round 2, findings e9a726/4e9589/f969ac/c2d91e/ba9d40 — round 1 left this branch's bare
      // `catch { return []; }` in place while fixing the sibling branch above).
      const sfPath = `${main}/${sf}`;
      try {
        txt = readFileSync(sfPath, 'utf8');
      } catch (e) {
        if (isFsPathAbsentError(e, () => lstatSync(sfPath))) return [];
        const msg = `readCarryForwards: session entry "${sf}" could not be read: ${e.message || e}`;
        (state.teardownErrors ||= []).push(msg);
        process.stdout.write(msg + '\n');
        return [];
      }
    }
    const m = txt.match(/##\s*(Carry-forward|What'?s left|Remaining)[\s\S]*?(?=\n##\s|$)/i);
    if (!m) return [];
    return m[0].split('\n').filter((l) => /^\s*[-*]\s+/.test(l));
  } catch (e) {
    // review-fix round 3 (finding d39244): this used to be a bare `catch { return []; }`,
    // swallowing ANY unexpected throw from this whole block — resolveMain() failing,
    // loadCoordConfig() throwing on malformed config content, a spawn error the resolver
    // rethrows — as though the session had nothing left over, reporting close-out success on a
    // real failure. That is the same silent-swallowing bug class plan 4075 exists to kill, one
    // layer above the two inner branches (ref-won / no-ref-won) that already surface their own
    // read failures instead of eating them. Surface it the same way: push onto
    // state.teardownErrors and stdout, then return []. `sf === null` and the DRY /
    // DW_FAKE_CARRYFORWARDS early returns above are untouched — they stay silent by design.
    // The push+write is wrapped in its OWN try so a throw this early (before `state` is known to
    // have the shape the rest of the function assumes) can never cascade into a second, unhandled
    // throw out of this catch block.
    try {
      const msg = `readCarryForwards: unexpected failure: ${e?.message || e}`;
      (state.teardownErrors ||= []).push(msg);
      process.stdout.write(msg + '\n');
    } catch {
      // never let error-reporting itself throw out of the outer catch.
    }
    return [];
  }
}

// plan 3961 T3.0: bind the land dependency container. Pure object assembly, no side effects —
// every value read here (the namespace imports above, node/run/gitEnv, DRY/IS_PREP/
// PREP_NO_REBASE) is already defined by this point in the module, so a test that imports this
// file for one export still sees no behaviour change. Nothing reads landDeps() yet; that is T3.0's
// whole point (see deps.mjs's own header). `spawn` and `env` are the two synthetic groups:
// `spawn` because `node`/`run`/`gitEnv` reach the do-not-edit scripts BY NAME and so stay in this
// command file; `env` for the argv-derived boot-time flags. `MAIN` is deliberately NOT in `env` —
// it is resolved inside phasePreflight(), long after boot, so binding it here would freeze
// `undefined` into the container; it stays a phase-local value passed as an argument, as today.
//
// plan 3961 T3.1: `gitMain` joins `spawn` (same category as node/run/gitEnv — a git primitive
// with ~28 spine-wide call sites, most outside the close-out phase, so it stays in this command
// file rather than moving). The new `spine` group carries every function
// scripts/coord/land/close-out.mjs's first move calls that is NOT moving here: `emitSeam`
// (process.exit + mutex/queue mutation), `coordStep`/`dequeueQueueIfHeld` (close over the private
// `_fakeForeignDirt` test-fakery state), `findSessionFile` (closes over the private
// `_sessionFileCache`), `tryStep` (shared with teardown/resume — see its own header), `gateProbe`/
// `hasStagedChanges`/`closeOutCommitAtHead`/`regenIndex` (close-out-only by call count, but
// outside T3.1's audited contiguous block, so left for a later cleanup rather than folded in
// here), `resolvePlanRelForSlug` (a small pure helper with an outside, non-close-out spine call
// site), and `pushMaster` (done-worktree.test.mjs source-inspects it by literal text — it cannot
// move to any other file). See close-out.mjs's own header for the full rationale.
//
// plan 3961 T3.2: `pwshExe` joins `spawn` — teardown() and finishRemoveWorktreeDir shell out
// through it exactly the way they already shell out through `run`/`gitMain`, so it belongs beside
// those spawn-target primitives rather than beside `spine`'s control-flow policy functions.
// `runCloseOutIsolated`, `pruneCloudDiskHeadroom`, `recoverLandedMergeSha`, and
// `readCarryForwards` join `spine`: each is called from teardown.mjs's runFinishCloseOut or
// finishCloseOutState but stays in this command file for its own already-documented reason (see
// each one's own comment above). See teardown.mjs's own header for the full rationale. plan 4066
// task 2b: `runCloseOutIsolated`, `recoverLandedMergeSha`, and `readCarryForwards` gained a
// SECOND reader with this move — phaseCloseOut/main(), now resident in spine.mjs alongside
// phasePreflight — but need no new membership of their own; the group they already joined for
// teardown.mjs covers this reach too.
// plan 4096 T1: the project plugin's `containerGroups` merge into this ONE bind through deps.mjs's
// withProjectGroups — the core-read, project-supplied group (`scriptsBattery`), the
// project-implemented `spine` members, and any project-private group the plugin adds — over the
// core defaults declared beside the group list, so with no plugin the container still binds and
// still passes the member net below.
bindLandDeps(
  withProjectGroups(
    {
      pwshExec,
      junctionGuard,
      coordShareLib,
      testQueue,
      killTree,
      lockPath,
      batteryLedger,
      batteryLock,
      coordGit,
      ensureCoordReroute,
      sweepDeferredWorktrees,
      coordConfig,
      claimPlanLib,
      blockedByLib,
      batchPaths,
      boardLib,
      redgreenLib,
      readPlanStamps,
      selectBatteryTests,
      gatePassCache,
      buildIndexLib,
      assertNoLandedReversion,
      landLib,
      L,
      diskHeadroom,
      worktreePorcelain,
      spawnDetachedWorktreeChild: spawnDetachedWorktreeChildNs,
      reconcileWorktreeBranches,
      landingQueueLib,
      landingQueueRef,
      indexLib,
      planBodyState,
      drainRun,
      coordMetrics,
      landingLock,
      landingQueueWatch,
      planCostBanner,
      planAdoptBranch,
      queueDrain,
      atomicWrite,
      execModelStamp,
      preRebaseMainGuard,
      worktreeLock,
      coordSessionId,
      spawn: { node, run, gitEnv, gitMain, pwshExe },
      env: { DRY, IS_PREP, PREP_NO_REBASE },
      spine: {
        emitSeam,
        // plan 4042: the generic gate lifecycle (gates-runner.mjs's runPrepGateLifecycle, step 8)
        // writes per-gate telemetry through this resident function — a core module cannot import it
        // directly (Rule 3: it lives here, not under scripts/coord/land/), so it reaches it through
        // this group exactly as it already does for emitSeam/stepLog above it.
        appendDeployGateOutcome,
        landCpuCount,
        coordStep,
        findSessionFile,
        tryStep,
        gateProbe,
        hasStagedChanges,
        closeOutCommitAtHead,
        regenIndex,
        pushMaster,
        resolvePlanRelForSlug,
        runCloseOutIsolated,
        pruneCloudDiskHeadroom,
        recoverLandedMergeSha,
        readCarryForwards,
        // plan 3961 T3.3b: `stepLog` closes over the private module-level `_stepPhases`/`_stepLogT0`
        // timing state, so it stays a spine-resident helper other core modules reach via `D.spine`.
        // (`worktreeHeadSha`/`originMasterTip` joined this group too at T3.3b, for the worktree-HEAD
        // reads other core modules needed before scripts/coord/land/rebase-sync.mjs existed — both
        // LEFT at T3.6, once that move gave the whole worktree-HEAD-reading cluster, `let
        // dryMidPassTip` included, a single home; sibling core modules now import them from there
        // directly. `worktreeLockFor` joined this group too at T3.3b, for queue.mjs's
        // dispatchLandPrep to reach it — it LEFT again at T3.4, once that move carved worktreeLockFor
        // itself into head-lock.mjs; queue.mjs now imports it from there directly instead.)
        stepLog,
        // plan 3961 T3.4: two more, added for the head-lock.mjs carve — neither can move with it,
        // each simply because it has a call site OUTSIDE this move's cluster too (the build gate and
        // the pytest/battery gates each have their own chunkGateStartDecision/noStartGateResult call
        // sites, the same chunk-cap/no-start-gate composition acquireWorktreeLockAtHead uses).
        chunkGateStartDecision,
        noStartGateResult,
        // plan 3961 T3.3: `readResultSidecar` (tryReclaimStrandedLandLock's own staleness-reclaim
        // status read, plus two main() call sites — batch land + preflight abort sidecar) and
        // `nowIso` (a trivial DRY-aware timestamp, read at two unrelated spine sites besides
        // queueEnqueueAndGate's own enq()) stay: neither can move with the queue.mjs carve, each
        // simply because it has a call site outside that cluster too. `tryRebase` / `trySkipSync` /
        // `logSyncSkipped` / `worktreeMutationKind` LEFT this group at T3.6 (all four moved to
        // scripts/coord/land/rebase-sync.mjs alongside the worktree-HEAD cluster above); queue.mjs
        // now imports all four from there directly instead. `repinAndReprove` stays a `spine` member
        // for a DIFFERENT reason (plan 4042 T2, superseding the old T3.6 note here): it moved to
        // scripts/coord/land/preflight.mjs along with `reprovePreflightTip`'s module-private `let
        // preflightMarkers` and the whole marker/repin cluster it used to be blocked on
        // (`recordedFindings`, `planExistsAtLand`, `makeSeedOnlyDelta` moved WITH it, so it now reaches
        // them bare, same-module) — but lane-merge.mjs, queue.mjs, and queue-probe.mjs each still call
        // `D.spine.repinAndReprove` from OUTSIDE preflight.mjs, so it stays in this group regardless.
        // `landingBoardSlug`: releaseHeadTenureAfterRequeue's board-row-slug resolver, ALSO
        // called by releaseMutexIfHeld's own board-demote and by main()'s LANDING stamp.
        readResultSidecar,
        nowIso,
        repinAndReprove,
        landingBoardSlug,
        // plan 3961 T3.4b: `restoreOffSpeculativeBase` (unstackSpeculativeBase's reset-vs-rebase
        // primitive, shared with `clearSpeculativeStackForPrep`'s own prep-side undo),
        // `worktreeMutationInProgress` (attemptPreconverge's busy-check — now queue-probe.mjs's, and
        // also `preflight`'s/`runLandPrepLocked`'s own call sites, both since moved to preflight.mjs
        // and reaching it bare, same-module — it stays a `spine` member only because queue-probe.mjs
        // still calls `D.spine.worktreeMutationInProgress` from outside that file, plan 4042 T2) and
        // `attachmentRefusal` (attemptPreconverge's attachment guard, but with its own 'land'-action call site in
        // phaseLaneMerge, and a dependency on the spine-private `let lastHeadRefError` that blocks it
        // from moving — plan 3961 T3.6) all stay, each for its own other call site.
        // `landSpecMarker` and `isAncestor` LEFT this group at T3.6: both moved to
        // scripts/coord/land/rebase-sync.mjs alongside the worktree-HEAD cluster above; queue-probe.mjs
        // now imports both from there directly instead.
        restoreOffSpeculativeBase,
        worktreeMutationInProgress,
        attachmentRefusal,
        // plan 3961 T3.5: `landRegistries` is registry BOOT wiring (T3.8's, alongside `spineBag()`),
        // not a gate implementation, so it stays behind; runPrepGates (now gates-runner.mjs's)
        // reaches it through the container instead of importing it. `armDryMidPassTip` /
        // `headShaAfterGate` / `prepPassEndSha` LEFT this group at T3.6: all three moved to
        // scripts/coord/land/rebase-sync.mjs alongside the rest of the worktree-HEAD cluster;
        // gates-runner.mjs now imports all three from there directly instead.
        landRegistries,
        // plan 3961 T3.5 (Zone D): three more, added for the gates-runner.mjs battery/build/prettier
        // carve — see that file's own header, THE `spine` GROUP paragraph, for why each cannot move.
        // `toPosixPath` is a module-top-level alias done-worktree.test.mjs pins by exact declaration
        // text; `BATTERY_LOCK_ACQUIRE_TIMEOUT_MS` (plus its own derivation chain) is read by the test
        // as a plain number in arithmetic/comparisons; `clearNoStartRoundFor` is a T2.2 chunk-cap/
        // no-start bag member called directly by two of the moved functions (the one place in this
        // whole plan where a core module calls BACK into the spine, rather than the other way
        // around) — its own three siblings (chunkGateStartDecision/noStartGateResult already `spine`
        // members since T3.4, for head-lock.mjs's OWN direct call; recordNoProgressRound/
        // activeChunkWallVar needing no `spine` membership at all) moved WITH this carve instead,
        // reached bare (same-module) from gates-runner.mjs's own code now, and still reached via
        // `spine` from head-lock.mjs / spineBag() through the plain import right above this call.
        toPosixPath,
        BATTERY_LOCK_ACQUIRE_TIMEOUT_MS,
        clearNoStartRoundFor,
        // plan 3961 T3.6b: four more, added for the lane-merge.mjs carve — none for a private-state
        // reason of their own, each simply because phaseLaneMerge (now lane-merge.mjs's) calls it and
        // it stays resident here. `evaluateLandFastPath` is called by phasePreflight too (not yet
        // carved) and is itself blocked from moving by the spine-private `let lastHeadRefError` (see
        // the T3.4b paragraph above, `attachmentRefusal`'s own entry). `emitSeamWithMarkerTable` moved
        // to preflight.mjs at plan 4042 T2 (imported back for phasePreflight's own remaining call
        // site, the review marker — its status-flip/conclusion-review/wiki-checkpoint siblings moved
        // to land-gate-seed.mjs at the D-A tail) but stays a `spine` member too, for lane-merge.mjs's
        // two OUTSIDE call sites.
        // `landGateRosterFromRegistry` is exported and
        // done-worktree.test.mjs imports it directly from this file (unaffected by this addition).
        // `disarmRetainedEntryHeartbeat` is the tiny accessor phaseLaneMerge's two disarm call sites
        // now go through instead of reaching into the private `let _retainedEntryHeartbeatDisarm`
        // directly (see that `let`'s own declaration for why a core module cannot touch it any other
        // way).
        evaluateLandFastPath,
        emitSeamWithMarkerTable,
        landGateRosterFromRegistry,
        disarmRetainedEntryHeartbeat,
        // plan 3974 T2c, re-homed after the T3.6b carve: `tallyLockRetry` folds a rebase result's
        // `lockRetry` count into the land-attempt sidecar, and BOTH its call sites matter — the
        // prep-lock one resident here, and phaseLaneMerge's (now lane-merge.mjs's), which is the
        // at-head rebase the acceptance measurement is actually about. It does not move with that
        // carve: it reads the module-private `DRY` flag and is exported from this file for its own
        // direct unit test, so lane-merge.mjs reaches it through this group instead.
        tallyLockRetry,
        // plan 4096 T1: `freeMemoryReading` (plan 4006 r3) is a project-plugin member now — see
        // scripts/project/land-plugin.mjs.
        // plan 4042: eight more, added for the preflight.mjs carve (the keep-hot `--prep`
        // orchestration cluster) — see that file's own header, WHAT STAYS BEHIND paragraph, for why
        // each cannot move. `worktreeHeadRef`, `fakeHeadRef`, and `assertStampAttachment` all read or
        // write the module-private `let lastHeadRefError` (rebase-sync.mjs's own T3.6 header already
        // names this trio as blocked from moving for the same reason); `lastHeadRefErrorText` is a new
        // one-line accessor beside that `let`, added so preflight.mjs's read-only uses of the
        // diagnostic text it carries can reach it from outside the module. `gitDeltaFiles` has a call
        // site outside this cluster too (the preflight remainder-envelope computation). `WORKTREE_HEAD_
        // UNREADABLE` is the sentinel those STAYS functions return and needs referential identity with
        // it, so it travels as a plain value. `remoteTrackingTip` and `restorePrepBranchTip` have no
        // caller left outside this cluster after the move, but their declarations sit before
        // `runLandPrep`, so the "nothing before runLandPrep moves" boundary every scripts/coord/land/
        // *.mjs carve follows keeps them here regardless. `repinShaPinnedMarkers` LEFT this group at
        // plan 4042 T2: it moved to preflight.mjs alongside its only two callers (`runLandPrepLocked`,
        // resident there since T2's own earlier step), so it now reaches it bare, same-module, with no
        // outside consumer left to justify a container entry.
        worktreeHeadRef,
        fakeHeadRef,
        assertStampAttachment,
        lastHeadRefErrorText,
        gitDeltaFiles,
        WORKTREE_HEAD_UNREADABLE,
        remoteTrackingTip,
        restorePrepBranchTip,
        // plan 4042 T2: six more, added for the preflight-markers/state-machine carve — the moved
        // `preflight()` function (and `makeSeedOnlyDelta`/`markerSourceEntry`, moved alongside it)
        // call each of these, and each is on the DO-NOT-MOVE list in preflight.mjs's own header
        // (`wikiDiffOnWorktreeBranch`/`sweepCheckpointOnWorktreeBranch` are project-module shims tied
        // to `spineBag()`; `WIKI_DIFF_RETRY_EXHAUSTED`/`LEDGER_FILES_ON_WORKTREE_BRANCH` are the pure
        // values their callers branch on, `WIKI_DIFF_RETRY_EXHAUSTED` needing the same referential
        // (`===`) identity `WORKTREE_HEAD_UNREADABLE` above does; `resolveSeedShardDir` reads
        // `coord.config.json` via `loadCoordConfig`, a plain top-level import a core module may not
        // make; `resolveSessionEntryChain` is the session-file resolution chain `findSessionFile`
        // (already a `spine` member) is itself part of) — so each reaches this file's own local
        // declaration through the container instead.
        // plan 4096 T1: `wikiDiffOnWorktreeBranch` / `WIKI_DIFF_RETRY_EXHAUSTED` /
        // `LEDGER_FILES_ON_WORKTREE_BRANCH` are project-plugin members now (core defaults in deps.mjs).
        sweepCheckpointOnWorktreeBranch,
        resolveSeedShardDir,
        // plan 4057 defect 4: the merge-base twin, which is what makeSeedOnlyDelta now defaults to —
        // the branch's own config must not decide which of the branch's files need review.
        resolveSeedShardDirAtMergeBase,
        resolveSessionEntryChain,
        // plan 4056 (the gate fold): the ONE project step in the preflight gate sequence that is not
        // a gate — the cloud-only pre-build disk-headroom prune plus its free-space floor refusal.
        // It has a FIXED position (before the build gate, so that gate's proof window never has to
        // account for this prune's filesystem churn under it) and no registry identity of its own, so
        // it reaches the core driver as a `{ order, run }` pair: the ORDER, like every registered
        // entry's, is declared by the side that owns the step, and the core places it without naming
        // it. 2.595 sits between price-trust (2.59) and build (2.6), which is exactly where the five
        // hand-written call sites used to put it.
        //
        // NOT a `prepGates` entry, deliberately: it classifies nothing, proves nothing and banks
        // nothing, and `landGateRosterFromRegistry` builds the once-per-land `gatesProven` roster
        // from every preflight-stage prepGates name — so registering it would put a name that can
        // never be proven into the roster of things a land may skip on a proof.
        //
        // SINGULAR rather than a list, per D-M14 (a field arrives with its adopter): exactly one such
        // step exists. A second one is that plan's widening, not a shape to build ahead of.
        //
        // plan 4066 task 1: the two production setters for the module-private `_stepLogT0`/
        // `_retainedEntryHeartbeatDisarm` lets — a core module cannot assign a `let` in another file
        // at all, so each owns its own if-guarded write and reaches this group's readers
        // (`stepLog`/`disarmRetainedEntryHeartbeat`) the same way they already did. Neither joined
        // this group when task 1 landed them (a container member ships WITH its adopter, D-M14) —
        // task 2a's move of phasePreflight, the two lets' only writer, is that adopter.
        stampStepLogClock,
        setRetainedEntryHeartbeatDisarm,
        // plan 4096 T1: `runNodeDepsPreflight` (plan 4066 task 2a) is a project-plugin member now.
        // plan 4066 task 2a: maybeReexecSpineFromMain (the plan-2697 MAIN re-exec guard) cannot MOVE
        // into a core module — it spawns a child process and reads import.meta.url/fileURLToPath,
        // neither of which a core module may do (Rule 3) — but it does not need to move to be CALLED
        // from one, which is exactly what this group is for. Stays resident here, reached through the
        // container instead of imported, at its ORIGINAL call site inside phasePreflight (now
        // spine.mjs) — a shorthand property, since the function's own signature (`MAIN, argv =
        // process.argv.slice(2)`) already matches the call unchanged.
        maybeReexecSpineFromMain,
        // plan 4066 task 2b: three NEW spine members, added for main()'s own move — none had an
        // outside caller until main() moved whole to spine.mjs (readCarryForwards/recoverLandedMergeSha/
        // runCloseOutIsolated above already carried a spine membership of their own, for
        // teardown.mjs's OTHER reach into this file; main() simply reads them too now, from its new
        // home). `writeResultSidecar` (the terminal CRASH/CLOSEOUT_UNVERIFIED/SUCCESS sidecar write)
        // and `hhmmNow` (the close-safety banner's local HH:MM stamp) each stay resident here for
        // their own OTHER call sites (writeResultSidecar: the halt-seam `emitSeam`/`gateProbe` writes
        // above; hhmmNow: `emitDoNotClose`'s own banner). `clearLandAttempt` has no other call site
        // left in this file at all — it stays resident anyway, matching every other name in this
        // list, not because it needs to.
        writeResultSidecar,
        clearLandAttempt,
        hhmmNow,
        // plan 4096 T1: `preflightInterlude` (plan 4056's pre-build disk-headroom step) is a
        // project-plugin member now; the core default is `null` (no interlude).
      },
    },
    LAND_PLUGIN ? LAND_PLUGIN.landPlugin(spineBag).containerGroups : null,
  ),
);
// plan 4066 task 0: assert every core module's declared container-read manifest against the REAL
// container this call just bound — immediately after the bind, before main() (or any `--prep` /
// `--finish-close-out` / test entry point) reaches a single phase. A mis-named or missing member
// throws here, naming both the member and the reading module, instead of surfacing as a silent
// `undefined` wherever that member is first read — which, per this task's own motivating measurement
// (D-4056-19 / plan 4066 § Task 0), could otherwise be inside a failure-path seam no dry-run
// scenario ever reaches.
assertContainerManifests();

// plan 692: an uncaught crash means the land did not cleanly finish → 🔴 red light.
// emitSeam / gateProbe call process.exit directly, so ONLY genuine throws reach here
// (a post-land best-effort throw is already absorbed into the SUCCESS report by main()'s
// catch). The CRASH result-sidecar was already written inside main()'s catch; this only
// adds the operator-facing banner and preserves the original stack on stderr.
// plan 1276: run main() ONLY when invoked as the CLI entrypoint (the spine always
// spawns `node scripts/done-worktree.mjs …`, never imports it), so a test can
// `import { promoteWaitingBlocked }` without triggering a real land. Standard idiom,
// matching board.mjs / cut-worktree.mjs / claim-plan.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    try {
      emitDoNotClose('CRASH', {});
    } catch {
      /* never let banner emission mask the original crash */
    }
    process.stderr.write(String((e && e.stack) || e) + '\n');
    process.exit(1);
  });
}
