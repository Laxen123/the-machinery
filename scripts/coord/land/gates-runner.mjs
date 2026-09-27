// scripts/coord/land/gates-runner.mjs — plan 3961 T3.5: the land spine's gate-proof, cache, and
// registry-lookup machinery (Zone C, landed first) PLUS the scripts-battery gate internals, the
// build/prettier gate runners, and the chunk-round scoring machinery (Zone D, this commit),
// moved out of scripts/done-worktree.mjs behaviour-identical (parity proven by this migration's
// parity-test suite against committed goldens, plus the full legacy test suite, both unchanged
// by this move) and scripts/coord/land/registry.test.mjs's 51 cases.
//
// WHAT THIS MODULE OWNS. Two related layers of the once-per-land proof system (plan 3295 E2 /
// plan 3503 / plan 4003 T2), plus the heavy chunk-capped gates themselves (plan 3436 / 3274 /
// 2875 / 3827 / 4003):
//   * The ONE gates-running loop the `--prep` pre-pass calls twice per invocation (the plain pass,
//     then — via the not-yet-carved `attemptSpeculativeStack` — the speculative pass): runPrepGates,
//     which reads the land registry's ordered prepGates roster, runs whichever the carry-forward
//     cap says need it, and reconciles every green against the tree the WHOLE pass ended on.
//   * The proof/cache primitives both the `--prep` loop above and the land's own (not-yet-carved)
//     preflight blocks call through: the per-worktree `.scratch/land-gates-proven.json` sidecar
//     read/write (readLandGatesProven/writeLandGatesProven/hydrateLandGatesProven), the skip
//     decision for a gate with no diff-scoped variant (landGateProven/onceProvenSkip/
//     onceProvenClosureSkip) and its content-cache-closure/untracked-env-hash comparisons
//     (gateEnvUncacheableFiles/landGateEnvHash/prepGateCacheGate/gateEnvHashAt/shortEnvHash/
//     prepGateEnvDrift), the write side of a proof (persistLandGateProofState/
//     recordLandGateProven/recordLandGatePartialProven/flushLandGateProofBuffer), the
//     branch-vs-master-owned delta narrowing (landGateDeltaPaths/landGateBranchOwnedPaths/
//     landGateRemainderPaths), the one shared cache-CLI spawn+parse wrapper (cachedCliRun), and the
//     registry-lookup adapters every one of those addresses a gate or seam THROUGH
//     (registryEntry/landSeamCheck/prepGateRun/prepGateApplies).
//   * The generic diff-scoped selection helper both heavy suites' project modules call through
//     (scopedGateSelection/batteryUnprovenFiles/batteryScopedSelection/narrateScopedGate), the
//     scripts-battery gate's own internals end to end — its isolation recheck and load-flake
//     classifier, its selected/targeted preflight runners, its lock/ledger/no-start-tally
//     bookkeeping, its chunk-round scoring, and the full and cached preflight entries
//     (runFullBatteryPreflight/runFullBatteryPreflightCached) — and the build and prettier gates'
//     own runners (runBuildPreflight/runBuildPreflightCached/runPrettierDriftCheck), all of them
//     addressed by the registry through the SAME `run`/`applies`/`passCacheGate` shape
//     coreGateImpls() already builds for build/battery/prettier.
//
// WHAT THIS MODULE DOES NOT OWN. The registry BOOT wiring: the five registries themselves
// (landRegistries, its LAND_REGISTRY_CACHE, coreSeamImpls/coreGateImpls, and the async convenience
// landGateRoster/landGateRosterFromRegistry) and the `spineBag()` assembly they and every
// scripts/project/ factory read from stay in the spine, physically wedged between this move's
// clusters — see the STAYS BEHIND paragraph below. Nor a project's own UI-verification gate, per-file heavy suite,
// or data-trust seam — those are `scripts/project/*.mjs` modules (or not yet carved at all),
// reached the same way coreGateImpls() already reaches every gate: through the registry, never a
// direct import from here.
//
// HOW THIS MODULE REACHES THE REST OF THE WORLD. A non-test module under scripts/coord/ may
// import only scripts/coord/** and node: builtins (Rule 3, docs/coord/scripts-layout.md)
// — so every one of the plain scripts/*.mjs modules this code used to reach directly is instead
// read off the bound dependency container, `landDeps()` (scripts/coord/land/deps.mjs), AT CALL
// TIME, inside each function — never at module top level. `D` (this module's convention:
// `const D = landDeps();` as the first line of every function that needs it) is the same
// one-letter binding every other scripts/coord/land/*.mjs core module uses for the same reason.
// `chunk-gate.mjs`, `registry.mjs`, and `head-lock.mjs` are SIBLING core modules under
// scripts/coord/land/, so `chunkGateConfig`/`processChunkCapMsNow` (chunk-gate.mjs, already
// imported by the spine the same way), `selectPrepGates` (registry.mjs, likewise), and
// `renewOrAbort`/`WorktreeLockLost` (head-lock.mjs — already exported there and imported back by
// the spine's own not-yet-carved prep-gates machinery, per that module's own FORWARD DEPENDENCY
// paragraph) are imported from them directly, no container needed.
//
// `GATE_PASS_CACHE_GATES`/`pathCovers` — the spine's own aliased/bare names for `gate-pass-cache.mjs`
// exports — are the SAME class of rewrite as `L.foo` → `D.L.foo`: that module already has a whole-
// namespace container group (`gatePassCache`, bound from `import * as gatePassCache from
// './gate-pass-cache.mjs'`), so the two call sites that used it read `D.gatePassCache.GATES` and
// `D.gatePassCache.pathCovers` here instead of carrying a second, container-less import of a file
// outside scripts/coord/** (which Rule 3 forbids a core module from holding directly). `MOBILE_GATE`
// (core-noun-ok: names the actual imported constant, not project prose) stays a plain spine
// import — its own remaining call sites (the not-yet-carved project UI-gate block) are all
// outside this move's cluster — so the spine's own `import { GATES as GATE_PASS_CACHE_GATES,
// MOBILE_GATE, pathCovers } from './gate-pass-cache.mjs'` narrows to `import { MOBILE_GATE } from
// './gate-pass-cache.mjs'` in the same commit: the other two names have no remaining reader there (core-noun-ok: quotes the real import statement being narrowed).
//
// THE `spine` GROUP. Zone C added four names (landRegistries, armDryMidPassTip, headShaAfterGate,
// prepPassEndSha — see the T3.5 (Zone C) history below for why each cannot move); this Zone D
// commit adds three more, all for the SAME reason as `landRegistries` and `armDryMidPassTip`
// above — a value this module's code reads that cannot survive the move as a plain declaration,
// or a function whose one remaining call site outside this move's own cluster reaches it through
// the container:
//   * `toPosixPath` — `export const toPosixPath = normalizeTargetToPosix;` in the spine is a
//     MODULE-TOP-LEVEL alias of a `nightly-windows-suite.mjs` export, and `done-worktree.test.mjs`
//     pins that exact declaration text (`assert.match(allLandSource(), /export const toPosixPath =
//     normalizeTargetToPosix;/)`) — rewriting the RHS to a container read would break the pin, and
//     leaving it a bare `normalizeTargetToPosix` here would violate Rule 3 (nightly-windows-suite.mjs
//     is not scripts/coord/**). It stays in the spine unchanged; this module's readers
//     (batteryUnprovenFiles, runFullBatteryPreflight) reach it as `D.spine.toPosixPath`.
//   * `BATTERY_LOCK_ACQUIRE_TIMEOUT_MS` — an exported spine const `done-worktree.test.mjs` reads
//     directly as a plain NUMBER in arithmetic and comparisons (`BATTERY_LOCK_ACQUIRE_TIMEOUT_MS <
//     outerFloorMs`, `* 10`), so it cannot become a call-time function without breaking that
//     contract; its own derivation chain (`BATTERY_LOCK_ACQUIRE_GRACE_MS`/`BATTERY_LOCK_FULL_WAIT_MS`/
//     `OUTER_LOCK_FLOOR_MS`) stays with it for the same reason (that chain's own inputs,
//     `WORKTREE_LOCK_MAX_HOLD_MS`/`DEFAULT_STALE_MIN`, are themselves plain spine imports Rule 3
//     would otherwise require a container group for). This module's one reader
//     (`batteryLockAcquireTimeoutMs`) reaches it as `D.spine.BATTERY_LOCK_ACQUIRE_TIMEOUT_MS`.
//   * `clearNoStartRoundFor` — the ONE T2.2 chunk-cap/no-start bag member (a `spineBag()` resident,
//     staying spine-resident because the not-yet-carved project UI-gate block calls it directly
//     by bare name) that this move's `runBuildPreflightCached`/`runFullBatteryPreflight` also call
//     directly — the REVERSE direction of every other bridge in this file (this module calling
//     BACK into the spine, rather than the spine calling forward into this module). Its three
//     siblings — `chunkGateStartDecision`/`noStartGateResult`/`recordNoProgressRound`/
//     `activeChunkWallVar` — moved WITH this carve instead (see the moved-functions list further
//     down): none had a caller anywhere but this cluster except `chunkGateStartDecision`/
//     `noStartGateResult`, which head-lock.mjs's own `acquireWorktreeLockAtHead` already reaches
//     through `D.spine` (a T3.4 `spine` membership, unrelated to this move) — so those two STAY
//     `spine` members regardless, now resolving through the plain import of them this file's own
//     header, THE SPINE IMPORTS BACK paragraph, describes; `recordNoProgressRound`/
//     `activeChunkWallVar` needed no `spine` membership before this move and need none after it.
//
// A NON-MECHANICAL DEVIATION, NAMED HERE SO IT IS NEVER MISTAKEN FOR AN INCIDENTAL REWRITE.
// `LAND_GATE_TO_PREP_KEY` was a MODULE-TOP-LEVEL const in the spine, computed eagerly at import
// time from `L.PREP_GATE_TO_LAND_GATE` (done-worktree-lib.mjs — moved under scripts/coord/ itself
// by plan 4096 T2, but still reached only through `landDeps()`, never a plain top-level import).
// `const D = landDeps()` may never run at module top level (the container
// is bound by the command file at ITS boot, long after every core module has already finished
// loading), so the derived table cannot be a top-level const here the way it was in the spine.
// It becomes `landGateToPrepKey()`, a private function that reads `D.L.PREP_GATE_TO_LAND_GATE` at
// CALL time and recomputes the (tiny, few-entry) inverse map fresh — no memoization, since
// `runPrepGates` calls it at most once per invocation and `Object.entries` over a handful of keys
// costs nothing. Its own one call site (`LAND_GATE_TO_PREP_KEY[gate.name]`) becomes
// `landGateToPrepKey()[gate.name]`.
//
// TWO MORE NON-MECHANICAL DEVIATIONS, both added by this Zone D commit, same class as the one
// above (a module-top-level declaration that cannot survive the move as-is):
//   * `BATTERY_BATTERY` was `const BATTERY_BATTERY = BATTERIES.find((b) => b.key === 'battery');`
//     in the spine — eager, module-top-level, derived from `nightly-windows-suite.mjs`'s `BATTERIES`
//     (reached here as `D.scriptsBattery.BATTERIES`, so the same Rule-3 problem as
//     `LAND_GATE_TO_PREP_KEY` applies). It becomes `batteryBattery()`, a private function called
//     ONCE at the top of each of its three callers (batteryIsolationRecheck, runBatteryTargets,
//     runFullBatteryPreflight — never inside a loop or callback) into a local `battBattery`, and
//     every `BATTERY_BATTERY.` call site in their bodies becomes `battBattery.`.
//   * `filterToKnownBatteryFiles`'s injectable-collaborator default parameter,
//     `{ _listScriptsTestFiles = listScriptsTestFiles } = {}`, cannot become
//     `{ _listScriptsTestFiles = D.scriptsBattery.listScriptsTestFiles } = {}`: a default
//     parameter value is evaluated in the parameter list's OWN scope, before the function body
//     (and its `const D = landDeps();`) ever runs, so `D` is not in scope there. The default
//     becomes `landDeps().scriptsBattery.listScriptsTestFiles` instead — a second, harmless
//     call to the already-cheap `landDeps()` accessor, only at this one default-value position.
//
// STAYS BEHIND, PHYSICALLY WEDGED BETWEEN THIS MOVE'S CLUSTERS. `spineBag()`/`SPINE_BAG` (the D8
// boot wiring every scripts/project/ gate/seam factory receives — plain imports of every name it
// hands out that this move relocated, so it keeps working unchanged); the four spine-resident
// pre-binding shims for legacy call sites, `runMobilePreflight`/`pytestScopedSelection`/`runSelectedPytestPreflight`/`pytestRedIsFlake`
// core-noun-ok: names four identifiers by their own spelling, one of a project module's gate
// names spelled into it — the identifier IS the information, not a leaked noun.
// `coreSeamImpls`/`coreGateImpls` (the core landSeam/
// prepGate implementation bags `landRegistries` itself builds from, and which call this module's
// runBuildPreflightCached/runFullBatteryPreflightCached/runPrettierDriftCheck directly by name —
// this module has no reason to import THEM back, since it is the callee, not the caller);
// `LAND_REGISTRY_CACHE` and `landRegistries` (registry BOOT wiring, T3.8's — see the `spine`
// paragraph above); `landGateRosterFromRegistry`/`landGateRoster` (the async roster convenience —
// not called by anything this move relocates); `TRUST_GATE_PROOF_PREFIXES` and `gateProbe`
// (a project's data-trust gate's and close-out's own business respectively, pinned spine-side by their own
// prior-step header comments); `appendDeployGateOutcome` (a `spineBag()` member for
// `scripts/project/deploy.mjs`'s postMerge entry, not this module's — physically wedged inside
// what would otherwise be one contiguous Zone D cluster); `clearNoStartRoundFor` (the T2.2
// chunk-cap/no-start bag member named in the `spine` paragraph above, the project UI-gate block's
// own direct caller); and `BATTERY_LOCK_ACQUIRE_TIMEOUT_MS`'s own derivation chain
// (`BATTERY_LOCK_ACQUIRE_GRACE_MS`/`BATTERY_LOCK_FULL_WAIT_MS`/`OUTER_LOCK_FLOOR_MS`).
//
// THE SPINE IMPORTS BACK EVERY MOVED NAME IT STILL CALLS DIRECTLY. Zone C's own thirteen
// (unchanged by this commit): cachedCliRun, landGateProven, onceProvenSkip, onceProvenClosureSkip,
// gateEnvUncacheableFiles, landSeamCheck, prepGateRun, prepGateApplies, gateEnvHashAt,
// shortEnvHash, prepGateEnvDrift, recordLandGateProven, recordLandGatePartialProven,
// flushLandGateProofBuffer, landGateDeltaPaths, landGateRemainderPaths, runPrepGates, and
// hydrateLandGatesProven — the FIRST four in this sentence are the count, the rest keep the same
// list Zone C's own commit named. Zone D adds thirty more, called from the not-yet-carved
// `phasePreflight`'s diff-scoped arms, `spineBag()`, and `coreGateImpls()`: runViaTestQueue,
// scopedGateSelection, gateCacheCheck, gateCacheClose, resolveHeadOid, scoreChunkRound,
// clearChunkRoundsSafe, ledgerRemainderCount, ledgerSubprocessTimeoutMs, ledgerSalvageTimeoutMs,
// LEDGER_CLI, QUEUED_RUN_CLI, runFullBatteryPreflight, runBuildPreflight, runBuildPreflightCached,
// runFullBatteryPreflightCached, runPrettierDriftCheck, narrateScopedGate, batteryRedIsFlake,
// runSelectedBatteryPreflight, runBatteryTargets, batteryScopedSelection, readNoStartTally,
// writeNoStartTally, noStartTallyKey, noStartSidecarPath, chunkGateStartDecision, noStartGateResult,
// recordNoProgressRound, activeChunkWallVar. The last four moved WITH this carve (they used to be
// spine-resident T2.2 bag members) rather than staying behind: `chunkGateStartDecision`/
// `noStartGateResult` are read back because head-lock.mjs's own `acquireWorktreeLockAtHead` still
// reaches them via `D.spine` (a T3.4 membership this move does not touch), and
// `recordNoProgressRound`/`activeChunkWallVar` are read back because `spineBag()` still hands them
// to `scripts/project/` factories by the same bare name. Of the thirty, batteryLockAcquireTimeoutMs,
// LEDGER_SALVAGE_FLOOR_MS, formatGateOutcomeLine, batteryRoundGreen, batteryFailureReportFromEvents,
// BATTERY_ISOLATION_MAX_FILES, filterToKnownBatteryFiles, batteryIsolationRecheck, and
// batteryUnprovenFiles have no spine CALL site of their own but ARE re-exported (a bare
// `export { name };` in the spine, not `export { name } from` — they arrive via the same plain
// import as everything else in this paragraph) because `done-worktree.test.mjs` imports them
// directly from `./done-worktree.mjs`, the same bridge pattern Zone C's own commit used for
// close-out.mjs/teardown.mjs. `readLandGatesProven`, `writeLandGatesProven`, `landGateEnvHash`,
// `prepGateCacheGate`, `registryEntry`, `persistLandGateProofState`, `landGateBranchOwnedPaths`
// (Zone C), and `gateCacheRun`, `normalizeBatteryTestFile`, `pnpmPrettierCheckChunked`,
// `BATTERY_LOCK_CLI`, `acquireBatteryLock`, `releaseBatteryLock` (Zone D) have no caller anywhere
// outside this module's own cluster, so they stay unexported.
//
// A PURE MOVE apart from the three exceptions named above. Every moved function is byte-identical
// to its done-worktree.mjs original but for the mechanical container-access rewrites (`L.foo(` →
// `D.L.foo(`, `DRY` → `D.env.DRY`, `IS_PREP` → `D.env.IS_PREP`, `run(` → `D.spawn.run(`,
// `toPosixPath(` → `D.spine.toPosixPath(`,
// bare `BATTERY_LOCK_ACQUIRE_TIMEOUT_MS` → `D.spine.BATTERY_LOCK_ACQUIRE_TIMEOUT_MS`,
// `clearNoStartRoundFor(` → `D.spine.clearNoStartRoundFor(`, `landRegistries(` → `D.spine.landRegistries(`,
// `GATE_PASS_CACHE_GATES[` → `resolveGateRegistry(D)[` (plan 4071), `pathCovers(` → `D.gatePassCache.pathCovers(`,
// `LAND_GATE_TO_PREP_KEY[gate.name]` → `landGateToPrepKey()[gate.name]`, bare `BATTERIES` →
// `D.scriptsBattery.BATTERIES`, `listScriptsTestFiles(`/`boundedAppend(` →
// `D.scriptsBattery.listScriptsTestFiles(`/`D.scriptsBattery.boundedAppend(` (the group was
// named `nightlyWindowsSuite` until plan 4096 review b1f480, and `boundedAppend` has since left it
// for scripts/coord/bounded-append.mjs), the ten
// `battery-ledger.mjs` names (`REPORTER_SPECIFIER`/`readGreenSet(`/`readZeroRounds(`/
// `recordChunkRound(`/`clearChunkRounds(`/`parseLedgerEvents(`/`toPosixRelative(`/
// `remainingSelection(`/`resolveLedgerDir(`/`NON_CONVERGENT_ROUNDS`) → the same `D.batteryLedger.`
// prefix, `TEST_SLOT_ADMITTED_MARKER`/`slotAdmissionBackstopMs(` → `D.testQueue.`,
// `SELECT_BATTERY_EXIT_RUN_FULL` (the spine's own locally-aliased import) →
// `D.selectBatteryTests.EXIT_RUN_FULL` (its un-aliased original export name), `GIT_MAXBUFFER` →
// `D.coordGit.GIT_MAXBUFFER`, and `spawnWithTreeKill(`/`waitForExit(`/`killProcessTree(` → the same
// `D.killTree.` prefix), the `export` keyword added where a caller outside this module needs it,
// and the `const D = landDeps();` first line every function that needs the container gained — no
// renames beyond the three named deviations above, no reordering, no incidental fixes. Every
// comment moved with its function; they carry the plan history that explains the code. Relative
// order is preserved: Zone C's `runPrepGates`/proof-primitives cluster sat before Zone D's
// scripts-battery cluster in the spine, so it sits first here too; two small early strays
// (`BATTERY_NONCONVERGENT_REMEDY`, `GATE_CACHE_CLI` — module-top-level consts the spine declared
// well before their own cluster, each with no reader outside it) move with their sole readers and
// sit just ahead of them.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { landDeps } from './deps.mjs';
import { boundedAppend } from '../bounded-append.mjs';
import {
  chunkGateConfig,
  processChunkCapMsNow,
  monotonicNowMs,
  processChunkDeadlineEpoch,
  landPreflightChunkOptions,
  isSpawnTimeout,
  BUILD_GATE_TIMEOUT_MS,
  chunkCapDecision,
  chunkCapMsAfterElapsed,
  chunkReportDetail,
  nonConvergentReportDetail,
  roundProvedSomethingNew,
} from './chunk-gate.mjs';
import { selectPrepGates, landSeamApplies, prepGateStage } from './registry.mjs';
import { renewOrAbort, WorktreeLockLost } from './head-lock.mjs';
// plan 3961 T3.6: worktreeHeadSha/headShaAfterGate/armDryMidPassTip/prepPassEndSha moved to
// rebase-sync.mjs — a sibling-core-module reach, no container needed (they LEFT the `spine`
// deps-container group with that same move; see deps.mjs's own comment). This module's own
// `worktreeHeadSha(` etc. call sites became bare `worktreeHeadSha(` etc. with this move.
import {
  worktreeHeadSha,
  headShaAfterGate,
  armDryMidPassTip,
  prepPassEndSha,
} from './rebase-sync.mjs';
// plan 4042: the generic gate lifecycle's post-run ownership re-check (step 5) — a sibling-core-
// module reach, no container needed (see runPrepGateLifecycle's own header).
// plan 4056: the generic seam driver's two halt primitives (steps 6a/6b of runLandSeamStep).
// Same sibling-core reach, same reason — both already live in preflight.mjs, reach nothing
// spine-resident, and were extracted at plan 4042 precisely so their call sites could import
// them directly instead of hopping the dependency container.
import {
  assertWorktreeStillOurs,
  emitSeamWithMarkerTable,
  emitReworkHaltWithRelease,
  prepGatePredicates,
} from './preflight.mjs';

// plan 4066 task 0: the member-level container-read manifest for this module — see
// preflight.mjs's own CONTAINER_READS comment for what asserts it and when, and
// container-manifest.mjs's header for the aggregator itself. Generated, not hand-typed;
// regenerate with the same scanner on a real change to this file's container reads.
export const CONTAINER_READS = Object.freeze({
  L: Object.freeze([
    'MARKER_FAMILIES',
    'PREP_GATE_TO_LAND_GATE',
    'batteryLockAcquireOutcome',
    'branchOwnedRemainder',
    'bumpNoStartRound',
    'clearNoStartRound',
    'gatePartialProvenEntry',
    'gateProvenEntry',
    'isPartialGateProof',
    'landPrepGatesToRun',
    'ledgerActiveKey',
    'noStartExhaustedDetail',
    'parseLandGatesProven',
    'parseNoStartTally',
    'prettierArgChunks',
    'prettierDriftCandidates',
    'spawnEnv',
    'testQueueRunOutcome',
  ]),
  batteryLedger: Object.freeze([
    'NON_CONVERGENT_ROUNDS',
    'REPORTER_SPECIFIER',
    'clearChunkRounds',
    'parseLedgerEvents',
    'readGreenSet',
    'readZeroRounds',
    'recordChunkRound',
    'remainingSelection',
    'resolveLedgerDir',
    'toPosixRelative',
  ]),
  coordConfig: Object.freeze(['loadCoordConfig']),
  coordGit: Object.freeze(['GIT_MAXBUFFER']),
  env: Object.freeze(['DRY', 'IS_PREP']),
  // plan 4071 T4/D5: GATES is gone — gatesFrom(config) builds the registry, caller-injected.
  gatePassCache: Object.freeze(['gateKeyAtRev', 'gatesFrom', 'pathCovers']),
  killTree: Object.freeze(['killProcessTree', 'spawnWithTreeKill', 'waitForExit']),
  scriptsBattery: Object.freeze(['BATTERIES', 'batteryRunCapMs', 'listScriptsTestFiles']),
  selectBatteryTests: Object.freeze(['EXIT_RUN_FULL']),
  spawn: Object.freeze(['run']),
  spine: Object.freeze([
    'BATTERY_LOCK_ACQUIRE_TIMEOUT_MS',
    'appendDeployGateOutcome',
    'clearNoStartRoundFor',
    'emitSeam',
    'freeMemoryReading',
    'landCpuCount',
    'landRegistries',
    'preflightInterlude',
    'stepLog',
    'toPosixPath',
  ]),
  testQueue: Object.freeze([
    'makeAdmissionScanner',
    'perSlotWorkerBudget',
    'perSlotWorkerBudgetDetail',
    'slotAdmissionBackstopMs',
  ]),
});

// plan 2463 — see the call site in runLandPrepLocked for why this is unconditional. LOCAL only:
// it never pushes, because the plain prep's own rebase force-pushes moments later. Best-effort by
// construction — if the branch cannot be returned to its plain shape here, the marker is kept so
// the land-time `unstackSpeculativeBase` (which CAN push, and refuses to merge on failure) is the
// one that has to succeed, and the plain prep below simply rebases whatever it finds.
//
// ── plan 2528: the ONE land-prep gate-running loop ───────────────────────────────
// Both prep passes re-validate the heavy gates against a tree they just moved, and both must do it
// the same way; plan 2463 re-implemented plan 972's loop line-for-line inside
// `attemptSpeculativeStack`, so this factors it back to one owner. Two rules live here exactly
// once, and that is the point of the extraction:
//
//   1. **The carry-forward cap.** `landPrepGatesToRun` decides which gates the delta could have
//      invalidated; every gate it excludes keeps its PRIOR green, so `gateResults` is carried
//      forward from the previous pass rather than rebuilt from scratch. Each caller owns the
//      harder half of that judgment — WHICH delta, and whether a prior may be trusted at all — because the two
//      passes justify it from different evidence (a landed master delta vs the head's
//      not-yet-landed one) and their own comments carry the reasoning.
//   2. **Ownership re-proof AT each gate boundary.** The holder re-proves ownership after every
//      gate. A refused renewal means we were reaped and another writer now owns the worktree — the
//      two-writers corruption the lock exists to prevent (plan 2473 review [1]) — so this THROWS
//      `WorktreeLockLost` rather than returning a failure. That distinction is load-bearing for
//      the speculative caller, whose gate-failure arm does a `reset --hard`: a lost lock must
//      never reach it.
//      Since plan 4034 T1 this is a CHECK, no longer the only thing that keeps the lock fresh: a
//      process-wide heartbeat renews every held lock during a gate too (`armWorktreeLockRenewal`
//      in head-lock.mjs), and `renewOrAbort` consults the lost-set it maintains before trying its
//      own renewal. So a gate that legitimately runs longer than the staleness ceiling no longer
//      goes stale under itself, and this boundary check reports a loss the heartbeat already
//      detected rather than being the first to notice it. The old wording here — that a gate
//      blocks the event loop inside synchronous children for minutes — was the premise 4034 T1
//      overturned, and is left behind with it: heavy gates spawn asynchronously and await.
//
// Two per-caller flags, both preserving a difference the two passes already had:
//
//   * `stopOnFail` — the plain pass runs every applicable gate even after a red, so ONE prep round
//     surfaces ALL the breakage for the session to fix during the wait; the speculative pass
//     abandons on the first red, because it is purely opportunistic and its whole budget is "cost
//     nothing when it does not pay off".
//   * `narrateCache` — only the plain pass narrates a build-cache hit. Unifying the two would be a
//     defensible improvement (the speculative pass's silence on a hit looks like an oversight of
//     plan 2463's hand-copy, not a decision), but it is an OBSERVABLE output change and this plan's
//     acceptance criterion is explicitly "the refactor is behaviour-preserving" — so the difference
//     is preserved here and the unification left to the operator as a separate call (review [0]).
//   * `proofBuffer` — plan 3503 gpt-review round 2's speculative caller is the ONLY user. Its tree
//     may be discarded by this same invocation, and the worktree lock may be lost before rollback;
//     only a sidecar write that never happened is safe in both cases. Plain prep omits it and keeps
//     writing each fresh proof through immediately.
export async function runPrepGates({
  state,
  wtPath,
  changed,
  delta,
  hasPriorForCap,
  priorGateResults,
  lock,
  slug,
  label,
  stopOnFail,
  narrateCache,
  proofBuffer,
  onGateFail,
}) {
  const D = landDeps();
  // plan 3961 T3.5b: hoisted ahead of the reconcile loop below (which reads a per-gate cache-gate
  // pairing off the registry) from its old position further down this function — landRegistries()
  // memoizes per (MAIN, wtPath), so this adds no real work where a later call in the same pass
  // would have built it anyway.
  // plan 4096 T1/S9: and now hoisted above `toRun` too — the carry-forward cap's roster is the
  // registry's own (prepGatePredicates), no longer four gate names the lib spelled by hand.
  const registries = await D.spine.landRegistries(state?.main, wtPath);
  const predicates = prepGatePredicates(registries);
  const toRun = D.L.landPrepGatesToRun(changed, delta, hasPriorForCap, predicates);
  const gateResults = { ...(priorGateResults || {}) };
  const phase = label ? `${label} ` : '';
  let ok = true;
  // plan 3274 (D1, gap-2 follow-up): ONE deadline, shared across the WHOLE PROCESS — never a fresh
  // per-call wall (see processChunkDeadlineEpoch's own header for why: this function alone runs
  // TWICE inside a single --prep invocation — the plain pass here, then the speculative pass via
  // attemptSpeculativeStack — and the ordinary land path spends the same wall again at its own
  // heavy-gate preflight call sites in main()). `chunkCfg.enabled` false (the overwhelming local
  // case, D2) keeps the shared deadline null, which every downstream chunkCapMs computation below
  // reads as "chunking off" — byte-identical to before this plan. Each heavy gate's runner closure
  // derives ITS OWN remaining budget via `chunkCapMsNow()`, evaluated fresh immediately before that
  // gate starts (not once up front), so an earlier gate's real wall-clock spend — in this loop OR
  // anywhere else in the process — is reflected in a later gate's cap.
  const chunkCfg = chunkGateConfig();
  const chunkCapMsNow = () => processChunkCapMsNow(chunkCfg);
  // plan 3274 (review round, F1/CONFIRMED): whether ANY gate this pass came back not-ok, and
  // whether EVERY not-ok gate was CHUNKED (never a real failure) rather than a genuine break. A
  // pass that mixes a chunked gate with a real failure must still read as a real failure — the
  // whole point of the distinction is "is there a bug to go fix", and a mix means yes.
  let anyRealFailure = false;
  let anyChunked = false;
  // plan 3374: whether any not-ok gate this pass was NON-CONVERGENT (ran and proved zero new files
  // for NON_CONVERGENT_ROUNDS consecutive chunk-capped rounds). Tracked separately from
  // `anyChunked` because the two want OPPOSITE things from the watcher: a chunked prep asks to be
  // re-invoked against the same tip every poll, and a non-convergent one must never be — re-arming
  // the same tip is exactly the infinite loop the seam exists to break.
  let anyNonConvergent = false;
  // plan 3503 gpt-review round 3 (cluster 2): the tree this pass is ABOUT, read once before the
  // first gate can spend a minute. Two things key off it below.
  //
  //   * A CARRIED-FORWARD green (the `if (!need) continue` arm) is an assertion about THIS pass's
  //     tree: `landPrepGatesToRun` excluded the gate because the caller's delta proves the gate's
  //     inputs are byte-identical between the prior proof and the tree standing here at pass start.
  //     That is a content argument, the same one the plan-2462/2875 pass caches make, and it is
  //     exactly what plan 2528's rule 1 exists to carry — so the carried green's proven tree is the
  //     pass's START tree, not the prior marker's tip.
  //   * Which makes the reconcile after the loop a plain comparison: nothing may claim a tree the
  //     pass did not end on.
  //
  // REJECTED ALTERNATIVE — "a carried green's proven tree is the tip the PRIOR MARKER named".
  // It reads as the stricter, more honest rule, and it is wrong here: carry-forward and a
  // HEAD-MOVING REBASE always coincide, so it would falsify EVERY carried green on EVERY pass. The
  // plain path only reaches the cap when master moved (`landedDelta` requires `prior.baseSha !==
  // baseSha`), and moving master is exactly what makes it rebase into a new tip; the speculative
  // pass `rebase --onto`s the head's tip before its own gates run. That retires plan 2528's rule 1
  // outright and kills the plan-2463 speculative fast path — the marker would report only what THIS
  // pass re-ran, so the land re-runs everything the cap just declined to run, which is the opposite
  // of what prep exists for. It would also fire the falsification line below on every keep-hot prep
  // rather than on the rare race the finding describes. The defect being fixed is HEAD moving
  // DURING the pass; a rebase happens BEFORE it and is accounted for by the caller's delta.
  const passStartSha = worktreeHeadSha(wtPath);
  // Per-gate provenance, tracked so the reconcile below is a comparison and never a guess: which
  // tree each still-green gate was proven on, and which untracked-input digest it was proven under.
  const gateProvenSha = {};
  const gateProvenEnv = {};
  for (const key of Object.keys(gateResults)) {
    if (!gateResults[key]) continue;
    gateProvenSha[key] = passStartSha;
    gateProvenEnv[key] = gateEnvHashAt(
      wtPath,
      prepGateCacheGate(registries, key),
      'DW_FAKE_LAND_GATE_ENV_HASH_AT_GATE_START',
    );
  }
  // plan 2492 (finding `m21k4e`): the build re-validation goes through the SAME pass-cache pair the
  // pre-enqueue preflight in main() uses. The overwhelmingly common keep-hot requeue is a rebase
  // that moved master without touching a single build input — the branch push already proved that
  // exact content, so this is a millisecond probe instead of a repeated 1-2 min build. A miss (or
  // any cache trouble) runs the build exactly as before and records its own green.
  //
  // A project's own UI-verification gate is deliberately NOT cached — it is diff-scoped, not content-scoped, and exits
  // 0 both when T1-T7 passed and when it decided it was not required. Full rationale where the
  // `mobile-gate` entry would live in scripts/gate-pass-cache.mjs (re-adding it is plan 2491; core-noun-ok: names the actual gate-pass-cache.mjs registry key).
  //
  // plan 2875: the two other heavy suites are the third and fourth entries — the two heavy tiers the
  // retiered scripts/hooks/pre-push.sh no longer proves on every LOCAL push (operator decision,
  // docs/coord/hooks.md § Diff-scoping). Both cached exactly like BUILD (a
  // gate-pass-cache / battery-pass-cache pair, never hand-rolled), for the same reason: the
  // overwhelmingly common re-prep is a rebase that moved master without touching either tier's
  // inputs, so this is a millisecond probe instead of a repeated multi-minute run.
  // plan 3961 T1d: the ROSTER and its ORDER now come from the land registry, not from a literal
  // array here. Before this, the `--prep` pre-pass and the land's own phasePreflight blocks were
  // two independently hand-maintained lists of the same gates — so a gate could run at land but not
  // at prep, or in a different relative order, with nothing in the tree to catch it. Both sites
  // read this one registry now; that is the whole reason T1d wires two sites rather than one.
  //
  // What is NOT registry-owned here, deliberately (registry.mjs's selectPrepGates header states the
  // split): HOW a gate is run. The per-gate options below — the chunk budget, the cache-hit
  // narration, and the surrounding gatesProven capture/re-read proof — stay this site's business,
  // because the two sites genuinely differ in all three and a single generic runner would have to
  // re-grow every difference.
  //
  // `prepPassOnly: true` is what drops the one gate with no prep counterpart (2.59): it is the one
  // preflight gate this site never runs. That was previously expressed by its absence from this array
  // plus a comment on PREP_GATE_TO_LAND_GATE; it is now a field on the entry.
  //
  // NOTE the `applies` filter is redundant with `toRun` below and is kept anyway: `toRun` is the
  // carry-forward CAP (which gates the delta could have invalidated), `applies` is APPLICABILITY
  // (whether this diff needs the gate at all). They coincide today because landPrepGatesToRun
  // computes applicability from the same predicates the entries declare — and running both is what
  // will SHOW it if they ever stop coinciding, rather than silently preferring one.
  //
  // The per-gate OPTIONS below are unchanged from the literal `[key, need, runner]` array this
  // registry-driven loop replaced — same values, same `chunkCapMsNow()` fresh-at-call-time
  // evaluation (each is a thunk, called immediately before its own gate starts, never once up
  // front), same `narrateCache` conditional. `onCached` narration exists for three of the four; the
  // a project's own UI-verification gate has none because it is not content-cached at all.
  const cachedNarration = (message) =>
    narrateCache ? { onCached: () => console.log(message) } : {};
  const prepGateOpts = {
    build: () => ({
      // plan 3436 D1: the build is a PRE-GATE phase of the shared wall, not something outside
      // it — same fresh-at-call-time snapshot the two heavy gates below already take.
      chunkCapMs: chunkCapMsNow(),
      minChunkS: chunkCfg.minChunkS,
      ...cachedNarration(
        `done-worktree --prep: build gate — CACHED green for this exact content (plan 2462), skipping the rebuild.`,
      ),
    }),
    // (plan 556's 'artifact' freshness gate retired by plan 1024 — see done-worktree-lib.mjs.)
    // plan 3436 D1/D2: a project's own UI-verification gate is the UNCACHED gate — the one path where a slow gate re-burns the
    // same wall on every `--prep` invocation, which is exactly why the no-start tally inside
    // runMobilePreflightChunked matters more there than anywhere else (core-noun-ok: names the actual function this paragraph is about).
    mobile: () => ({ chunkCapMs: chunkCapMsNow(), minChunkS: chunkCfg.minChunkS }),
    pytest: () => ({
      // plan 3274: fresh snapshot at call time (D1) — null when chunking is off (D2), which
      // runPytestPreflightCached/runPytestPreflight both read as "no cap, natural timeout".
      // core-noun-ok: names two Zone D identifiers by their own spelling, one of which carries a
      // project gate name — the identifier IS the information, not a leaked noun.
      chunkCapMs: chunkCapMsNow(),
      minChunkS: chunkCfg.minChunkS,
      ...cachedNarration(
        `done-worktree --prep: pytest gate — CACHED green for this exact content (plan 2875), skipping the re-run.`,
      ),
    }),
    battery: () => ({
      chunkCapMs: chunkCapMsNow(),
      minChunkS: chunkCfg.minChunkS,
      ...cachedNarration(
        `done-worktree --prep: scripts battery gate — CACHED green for this exact content (plan 1824/2875), skipping the re-run.`,
      ),
    }),
  };
  // Built ONCE for the whole roster: landGateToPrepKey() rebuilds the reversed map on every call
  // (it reads D.L at call time rather than memoizing), so calling it inside the map callback would
  // rebuild it per gate for no reason.
  const prepKeyByLandGate = landGateToPrepKey();
  const prepRoster = selectPrepGates(
    registries.prepGates,
    changed,
    { state, wtPath },
    { stage: 'preflight', prepPassOnly: true },
  ).map((gate) => {
    const key = prepKeyByLandGate[gate.name];
    // A prep-pass gate whose name has no prep key would be dropped by parseLandGatesProven and by
    // `toRun` alike — a gate that appears to run and proves nothing (plan 3503's silent-no-op
    // class). Refuse rather than skip. Same for a key this site has no options thunk for.
    if (!key || !prepGateOpts[key]) {
      throw new Error(
        `done-worktree --prep: prepGates entry "${gate.name}" (${gate.where}) runs in the prep ` +
          `pass but this site cannot address it (${key ? `no options for prep key "${key}"` : 'no PREP_GATE_TO_LAND_GATE key'}) — ` +
          `either give it one, or set prepPass: false on the entry.`,
      );
    }
    // `toRun` is the carry-forward CAP, keyed by the same compact vocabulary. A registered gate
    // whose key is ABSENT from it reads `undefined` at the `if (!need) continue` below — i.e. a
    // registered gate silently never runs and the pass still reports success (gpt-review 8507ba).
    // Refuse instead.
    if (!(key in toRun)) {
      throw new Error(
        `done-worktree --prep: prepGates entry "${gate.name}" (${gate.where}) maps to prep key ` +
          `"${key}", which landPrepGatesToRun does not report on — it would be skipped silently. ` +
          `The two rosters must name the same gates.`,
      );
    }
    // plan 4056 (finding `lgmdvs`): the ENTRY rides along, because the proof predicate below is the
    // entry's own declared `provesGate`, not a list of result-flag names this module keeps.
    return [key, toRun[key], (p) => gate.run({ wtPath: p, opts: prepGateOpts[key]() }), gate];
  });
  // …and the two APPLICABILITY answers must agree (gpt-review 5e88af). The comment above says
  // running both predicates "will SHOW it if they ever stop coinciding" — which was not true as
  // written: selectPrepGates drops a non-applying gate BEFORE the loop, so a registry `applies`
  // that disagreed with landPrepGatesToRun would have removed the gate in silence, which is the
  // failure this file keeps closing. This assertion is what makes the claim true. `hasPrior=false`
  // asks the pure applicability question, with the carry-forward cap deliberately out of it.
  const applicableNow = D.L.landPrepGatesToRun(changed, null, false, predicates);
  const selectedKeys = prepRoster.map(([key]) => key).sort();
  const applicableKeys = Object.keys(applicableNow)
    .filter((k) => applicableNow[k])
    .sort();
  if (selectedKeys.join(',') !== applicableKeys.join(',')) {
    throw new Error(
      `done-worktree --prep: the land registry and landPrepGatesToRun disagree on which gates ` +
        `apply to this diff — registry says [${selectedKeys.join(', ') || 'none'}], ` +
        `landPrepGatesToRun says [${applicableKeys.join(', ') || 'none'}]. One of the two has ` +
        `drifted; a silent divergence here is a gate that stops running.`,
    );
  }
  for (const [key, need, runner, entry] of prepRoster) {
    if (!need) continue; // not re-run this pass — keep the carried-forward result
    // plan 3503 (confirmed a9d62f/9bb369/06189d/18c7e8): the proof belongs to the tree the gate
    // STARTED on, never whatever HEAD happens to name after a 20-minute child returns. A session
    // may commit a review fix while `--prep --no-rebase` is running; stamping that later sha would
    // let the land skip a fix the gate never saw. DW_FAKE_BRANCH_TIP_AFTER_GATE is dry-only and
    // exists solely to make that race deterministic in the spine harness.
    const gateStartSha = worktreeHeadSha(wtPath);
    const landGate = D.L.PREP_GATE_TO_LAND_GATE[key];
    const cacheGate = prepGateCacheGate(registries, key);
    // plan 3503 gpt-review round 2 (dec45d/b6ff53): capture untracked gate inputs beside the START
    // sha, before the child can spend minutes running. The second dry hook lets the harness make
    // record-time content differ and prove the old post-gate hash can no longer leak into a proof.
    const gateStartEnvHash = gateEnvHashAt(
      wtPath,
      cacheGate,
      'DW_FAKE_LAND_GATE_ENV_HASH_AT_GATE_START',
    );
    const r = await runner(wtPath); // runners may be sync or async (runMobilePreflight, plan 1291; core-noun-ok: names the actual function example)
    // plan 3503 gpt-review round 3 (cluster 1): and re-read it immediately after the gate returns.
    // A start-only capture proves as little as the record-time one round 2 replaced, just in the
    // other direction: an untracked gate input edited to B for the gate's duration and reverted to
    // A leaves the stored A hash matching the file at the NEXT land, so the land skips a gate that
    // never ran under A. Same treatment as the sha — prove both ends, or prove nothing.
    const gateEndEnvHash = gateEnvHashAt(
      wtPath,
      cacheGate,
      'DW_FAKE_LAND_GATE_ENV_HASH_AFTER_GATE',
    );
    const gateEndSha = headShaAfterGate(wtPath);
    if (!renewOrAbort(lock, slug, `after the ${phase}${key} gate`))
      throw new WorktreeLockLost(slug);
    // plan 3318 (gpt-review r3, angle-A `49c073`): a gate that PASSED but proved less than it was
    // asked to is not a recorded proof. Without this, `--prep` stamps that gate's key `true` into
    // the prep marker and a LATER land takes that fast path and merges without ever running the
    // work. `r.ok` still drives the failure branch below, so such a pass is NOT reported as a gate
    // failure — it simply does not count as proof, and the land re-runs.
    //
    // plan 4056 (finding `lgmdvs`): WHICH greens are of that shape is the ENTRY's own declaration
    // now — `prepGateProofClassification` consults its `provesGate` hook — where this line used to
    // hand-write the two result flags the gates of the day happened to set. See that function's own
    // header for both halves of why: an entry whose hook was ignored here had an unearned proof
    // banked, and the flag names were a project gate's vocabulary living in a core module. A
    // chunked or non-convergent run arrives with `r.ok === false` and classifies as such, so the
    // behaviour for every existing gate is unchanged.
    const wholeGateGreen = prepGateProofClassification(entry, r) === 'pass';
    const sameTree = gateStartSha === gateEndSha;
    // plan 3503 gpt-review round 3 (cluster 1): the environment dimension of the same idea.
    const sameEnv = gateStartEnvHash === gateEndEnvHash;
    // plan 3503 gpt-review round 2 (71906f/fe11d0/2398ad): ONE predicate feeds both proof
    // channels. A moved-HEAD pass is operationally green (`r.ok` remains true below) but proves
    // neither the sidecar nor the marker, so the land simply re-runs it.
    // plan 3503 gpt-review round 3: that one predicate now covers BOTH dimensions — a gate proves
    // its tree AND its environment, or it proves nothing.
    gateResults[key] = wholeGateGreen && sameTree && sameEnv;
    gateProvenSha[key] = gateStartSha;
    gateProvenEnv[key] = gateStartEnvHash;
    // plan 3503 D1: this exact assignment is the only honest proof seam. The `if (!need) continue`
    // above excludes carried-forward marker results before they can reach it, and `wholeGateGreen`
    // already means "freshly ran to whole-gate green in THIS invocation": chunked/non-convergent
    // runs arrive with `r.ok === false`, while a green the entry's own `provesGate` rejects
    // classifies `unproven` and is explicitly false here (plan 4056). Never record from
    // marker stamping — a marker may contain carried-forward results. A plan-2462/2875
    // content-cache HIT DOES record: its key covers the gate's whole declared input closure by
    // CONTENT, so the hit proves exactly this tree, matching the land path where `b.ok` (including
    // `b.cached`) already records a green.
    if (gateResults[key]) {
      // A future prep gate must join the pure map before it may write. Passing `undefined` would
      // produce the plan-3503 silent-no-op failure: parseLandGatesProven drops unknown names.
      if (landGate) {
        recordLandGateProven(registries, state, wtPath, landGate, {
          fromFreshPrepGreen: true,
          sha: gateStartSha,
          envHash: gateStartEnvHash,
          proofBuffer,
        });
      }
    } else if (wholeGateGreen && !sameTree) {
      console.log(
        `done-worktree --prep: ${key} proof withheld because HEAD moved under the gate ` +
          `(${gateStartSha.slice(0, 9)} -> ${gateEndSha.slice(0, 9)}).`,
      );
    } else if (wholeGateGreen && !sameEnv) {
      // plan 3503 gpt-review round 3 (cluster 1): the same shape and the same rule as the moved-HEAD
      // line above — a withheld proof is NOT a gate failure, so `r.ok` alone still drives the
      // failure branch below and the land simply re-runs this gate.
      console.log(
        `done-worktree --prep: ${key} proof withheld because an untracked gate input ` +
          `(${gateEnvUncacheableFiles(cacheGate).join(', ')}) changed under the gate ` +
          `(${shortEnvHash(gateStartEnvHash)} -> ${shortEnvHash(gateEndEnvHash)}).`,
      );
    }
    armDryMidPassTip(key); // dry-run only (no-op unless DW_FAKE_BRANCH_TIP_MOVES_AFTER names `key`)
    if (!r.ok) {
      ok = false;
      // plan 3274 (review round, F1/CONFIRMED): a chunked gate is out of cloud-chunk budget, never
      // a real branch defect, so the two must stay distinguishable end to end.
      //
      // plan 3436 D1 [comment corrected]: this used to read "only the two heavy suites ever set
      // `r.chunked` — build and a project's own UI gate always report a real pass/fail". That is no longer true: both
      // pre-gate phases now derive their timeout from the same shared wall and report `chunked` on
      // their own no-start / cap-fired arms (runBuildPreflightCached, runMobilePreflightChunked; core-noun-ok: names the actual functions).
      // The loop needed no change — it already routed `r.chunked` correctly — but a comment
      // asserting the opposite is how the next reader concludes a build can never chunk here.
      if (r.chunked) anyChunked = true;
      else anyRealFailure = true;
      // plan 3374: a non-convergent gate is a chunked gate too (`chunked: true` rides both), so the
      // line above already counted it — this only records WHICH kind of chunked it was, so the
      // caller can pick the prep exit code that does not re-arm the same tip forever.
      if (r.nonConvergent) anyNonConvergent = true;
      onGateFail(key, r.detail, {
        chunked: Boolean(r.chunked),
        nonConvergent: Boolean(r.nonConvergent),
      });
      if (stopOnFail) break;
    }
  }
  // plan 3503 gpt-review round 2 (182771): marker writers compare their fresh stamp-tip read to
  // the tree at this pass's END. Per-gate disagreement is already false in gateResults above.
  const gatedSha = prepPassEndSha(wtPath);
  // plan 3503 gpt-review round 3 (cluster 2): EVERY green in a pass must agree on ONE tree. The
  // per-gate start/end check above closes movement UNDER a gate and round 2's stamp seams close
  // movement AFTER the last one, but neither closes movement BETWEEN gates: build passes on A, a
  // commit touching frontend inputs arrives, a project's own UI gate passes on B, `gatedSha` is B — and the marker
  // recorded BOTH true at B, so the land accepted a build that never ran on B. The carried-forward
  // greens ride the same hole: their claim is about `passStartSha`, which a mid-pass commit makes a
  // tree nobody gated. Falsify, never fail: `ok` is untouched, so a moved tree is not a gate break
  // and the land simply runs the gate itself.
  //
  // Only the whole-pass MARKER needs this. The plan-3295 sidecar is already safe — each entry
  // carries its own sha and the land delta-scopes the remainder from it — which is why the
  // withheld-proof arms above and this reconcile are separate mechanisms rather than one.
  for (const [key, green] of Object.entries(gateResults)) {
    if (!green) continue;
    const provenOn = gateProvenSha[key];
    if (provenOn === gatedSha) continue;
    gateResults[key] = false;
    console.log(
      `done-worktree --prep: ${phase}${key} green falsified in the marker — it was proven on ` +
        `${provenOn ? provenOn.slice(0, 9) : 'an unrecorded tree'} but this pass ended on ` +
        `${gatedSha.slice(0, 9)} (plan 3503, gpt-review round 3).`,
    );
  }
  // The untracked-input digest each SURVIVING green was proven under, for the stamp seams'
  // environment refusal (cluster 3 — see prepGateEnvDrift).
  const gateEnvProven = {};
  for (const [key, green] of Object.entries(gateResults)) {
    if (green) gateEnvProven[key] = gateProvenEnv[key];
  }
  // `chunked` is true only when this pass has at least one not-ok gate AND every one of them was
  // chunked — never when the pass is fully green (nothing to distinguish) and never when a real
  // failure sits alongside a chunked one (that pass is a real failure, full stop).
  //
  // plan 3374: `nonConvergent` narrows that further — the same "no real failure alongside it" rule,
  // because a pass that also broke a gate for real is a real failure whose fix comes first.
  return {
    ok,
    gateResults,
    gatedSha,
    gateEnvProven,
    chunked: !ok && anyChunked && !anyRealFailure,
    nonConvergent: !ok && anyNonConvergent && !anyRealFailure,
  };
}

// The ONE spawn behind every cache-CLI call (plan 2492, finding `7d5bw7`: `gateCacheCheck` used to
// hand-roll its own spawnSync + exit-code + stdout parsing beside this; plan 2875 cluster 6, finding
// `432a35`: `batteryCacheRun` below independently re-hand-rolled the SAME wrapper a second time —
// this is now the one spawn+parse shape both cache CLIs share, parameterized on the one thing that
// actually differs between them: whether stdin carries the selection). Returns `{ status, out }`,
// with `status: null` when the spawn itself failed (missing CLI, timeout, crash) — the caller reads
// that as "no cached verdict", never as a hit. Note the exit code is LOAD-BEARING here: 0 = HIT,
// 2 = MISS (and MISS still prints a usable key on stdout), so this must not throw the way
// execFileSync does on a non-zero exit.
export function cachedCliRun(wtPath, cliPath, args, { input, timeoutMs = 60_000 } = {}) {
  const D = landDeps();
  try {
    const r = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: wtPath,
      ...(input === undefined ? {} : { input }),
      encoding: 'utf8',
      stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: D.L.spawnEnv(), // plan 2604: no child inherits implicitly
    });
    if (r.error || typeof r.status !== 'number') return { status: null, out: '' };
    return { status: r.status, out: (r.stdout || '').trim() };
  } catch {
    return { status: null, out: '' };
  }
}

// ── plan 3295 E2: the per-land `gatesProven` sidecar ─────────────────────────────────────────
//
// Operator ruling 2026-08-19, verbatim: "Once per land period." A slow pre-queue part that has
// gone green once inside a land is never re-run in that land. See LAND_GATE_NAMES in
// done-worktree-lib.mjs for the full rationale and the safety envelope; this half is the storage.
//
// WHERE IT LIVES, and why NOT beside the slugScratchMarker quartet in `MAIN/.scratch`: E3's
// post-rebase push has to prove the `LAND_ID` it exports belongs to the repo actually being
// pushed, and `scripts/hooks/pre-push.sh` is a POSIX shell script running INSIDE the worktree
// with no notion of a slug or a MAIN checkout. A WORKTREE-local sidecar is self-locating (`git
// rev-parse --show-toplevel`), so the hook reads it in one line — and reads the PROOFS themselves
// out of it too, never off the env, so a `LAND_ID` leaking in from an unrelated shell finds no
// matching sidecar and authorizes nothing. `.scratch/` is gitignored repo-wide (a project's own
// data-trust gate already writes its own worktree-local scratch file there), and
// teardown removes the whole worktree — so the sidecar cannot outlive the land it describes.
//
// LAND LIFETIME = WORKTREE LIFETIME. The sidecar is created by the first invocation that proves a
// part and read by every later one for the same worktree, including a `--prep`, `--resume <CODE>`,
// or bare re-invoke after a paperwork stop. A prep is merely an EARLIER INVOCATION in that same
// worktree; hydrateLandGatesProven adopts the sidecar's `landId`, so the lifetime model already
// covers it. A genuinely NEW land starts from a fresh worktree, hence a fresh (absent) sidecar.
// Deliberately NOT a wall-clock stamp: the operator ruled that shape out explicitly ("Once per
// land period", not "once per 24 h"). Plan 3503 supersedes plan 3295 E2 / commit fbedcddde5's
// blanket claim that prep children never participate.
const LAND_GATES_SIDECAR_REL = '.scratch/land-gates-proven.json';
const landGatesSidecarPath = (wtPath) => `${wtPath}/${LAND_GATES_SIDECAR_REL}`;

// DRY hook: DW_FAKE_LAND_GATES_PROVEN injects the sidecar JSON, so the skip wiring is provable
// from a --dry-run subprocess without a scratch worktree (mirrors DW_FAKE_LAND_PREP). Honoured
// ONLY under --dry-run — a leaked env var must never authorize a skip in a production land.
function readLandGatesProven(wtPath, gateRoster) {
  const D = landDeps();
  if (D.env.DRY) {
    const raw = process.env.DW_FAKE_LAND_GATES_PROVEN;
    return raw === undefined ? null : D.L.parseLandGatesProven(raw, gateRoster);
  }
  try {
    return D.L.parseLandGatesProven(readFileSync(landGatesSidecarPath(wtPath), 'utf8'), gateRoster);
  } catch {
    return null; // absent / unreadable ⇒ nothing proven ⇒ every gate runs (the safe direction)
  }
}

function writeLandGatesProven(wtPath, payload) {
  const D = landDeps();
  if (D.env.DRY) return; // dry trace only — never touch a real worktree's `.scratch`
  try {
    mkdirSync(`${wtPath}/.scratch`, { recursive: true });
    writeFileSync(landGatesSidecarPath(wtPath), JSON.stringify(payload, null, 2));
  } catch {
    /* best-effort: a stamp failure only means the next invocation re-proves the part */
  }
}

// Adopt (or open) this worktree's land. `state.landId` stays exactly what plan 2473 made it — a
// PER-INVOCATION telemetry group id, deliberately re-minted every run so the land-prep series
// stays comparable with its pre-2473 baseline. The once-per-land proof needs the opposite: an id
// that SURVIVES a re-invocation, so it gets its own field rather than redefining that one.
export function hydrateLandGatesProven(state, wtPath, gateRoster) {
  const sidecar = readLandGatesProven(wtPath, gateRoster);
  state.landGateId = sidecar?.landId || state.landId;
  state.gatesProven = sidecar?.gatesProven || {};
}

// The entry authorizing a skip for `gate`, or null.
//
// CLOUD LANDS NEVER SKIP THROUGH THIS (operator ruling: cloud default = full every land, chunked
// per plan 3274). The entry is still WRITTEN there — so a cloud sidecar reads the same as a local
// one and a later local invocation on the same worktree is not confused by a hole — only the skip
// is withheld. ONE carve-out, and it does not live here: the two gates with no diff-scoped variant
// (`build` and a project's own UI gate) may reuse a proof earned in the SAME cloud land over the
// SAME closure content — operator ruling 2026-09-25, plan 4192: "full every land" means a new land
// never inherits an earlier land's results, not that one land re-proves unchanged content on every
// chunk re-invoke. That reading is `landGateSameLandClosureProof` below, reached only from
// `onceProvenClosureSkip`; every gate that reads THIS function stays full on cloud. Plan 3503 supersedes plan 3295 E2 / commit fbedcddde5's claim that `--prep` children
// never participate because they may run on a tree the land process never sees: that is exactly
// what the delta-scoped envelope is for. A prep entry authorizes only the remainder since ITS OWN
// sha, and a remainder touching a gate's closure re-runs that gate. Prep still may not record a
// carried-forward gateResults entry, a chunk-resume, or a slowDeselected narrowed pass.
// The land-gate tier's own cloud test, and the ONE spelling of it (plan 4004, gpt-review r2
// 3e2ed2 / 388298): ANY non-empty `CLAUDE_CODE_REMOTE` is a cloud land. Deliberately NOT
// `L.isCloudLand()`, which is strict `=== 'true'` — this repo's own cloud sandboxes and tests
// spell the marker `'1'`, and on THIS decision surface a missed cloud land buys LESS verification
// (a skip, or a diff-scoped selection, in place of the full suite CLAUDE.md requires of every
// cloud land), so the wider reading is the safe one. Both consumers — landGateProven's skip
// refusal and scopedGateSelection's default-tier refusal — go through here, so the two can never
// drift apart the way they did before r2. `isCloudLand()` keeps its own strict meaning for the
// prune/cleanup call sites it already serves; reconciling THOSE is not this plan's surface.
function landGateIsCloud(env = process.env) {
  return Boolean(env.CLAUDE_CODE_REMOTE);
}

export function landGateProven(state, gate) {
  if (landGateIsCloud()) return null;
  const entry = state?.gatesProven?.[gate];
  return entry && entry.sha ? entry : null;
}

// plan 4192 (operator ruling 2026-09-25): the cloud half of the closure-gate proof. Returns the
// entry only when it can be judged by content AND belongs to THIS land — a `closureKey` to compare
// and a `landId` equal to the land this invocation adopted (`state.landGateId`, the sidecar's own
// id, which survives every re-invoke of one land and is fresh for a new one: a new land means a
// new worktree, so a new sidecar). A pre-4192 entry carries neither and is refused, exactly as
// every cloud proof was before. The CALLER still has to show the key matches the tree it is
// standing on; this only decides which entries may be asked.
export function landGateSameLandClosureProof(state, gate) {
  const entry = state?.gatesProven?.[gate];
  if (!entry || !entry.sha || !entry.closureKey || !entry.landId) return null;
  return state?.landGateId && entry.landId === state.landGateId ? entry : null;
}

// plan 4192: the gate-pass-cache content key of `cacheGate`'s closure at the committed revision
// `rev` in this worktree — the same `computeGateKey` the pre-push probe keys its cache on, so the
// land and the hook agree on what "the build's content" is. Null on ANY doubt (a git error, a
// closure path absent at `rev`, a registry that cannot key the gate): every caller reads null as
// "cannot judge by content", which is always the run-the-gate direction on cloud and the
// fall-back-to-the-delta direction locally. DRY hook: DW_FAKE_LAND_GATE_CLOSURE_KEY stands in for
// the live read (the key a --dry-run's tree has, for every rev), honoured only under --dry-run.
export function landGateClosureKey(wtPath, cacheGate, rev) {
  const D = landDeps();
  if (D.env.DRY) {
    const raw = process.env.DW_FAKE_LAND_GATE_CLOSURE_KEY;
    return raw ? raw : null;
  }
  if (!cacheGate || !rev) return null;
  try {
    const git = (args, input) =>
      D.spawn.run(
        'git',
        ['-C', wtPath, ...args],
        input === undefined ? {} : { input, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    const key = D.gatePassCache.gateKeyAtRev(git, resolveGateRegistry(D), cacheGate, rev);
    return typeof key === 'string' && key ? key : null;
  } catch {
    return null;
  }
}

// The one combinator the 2.5x/2.6x step conditions read: returns the proving entry (truthy ⇒ the
// step is skipped) and narrates it in the same breath, so a skip can never happen silently.
//
// `console.log`, not stepLog: this is an audit line about work the land DID NOT DO, so it belongs
// on the durable land output (and shows in --dry-run) exactly like the review-seam-cleared notice.
// Called from inside the step conditions, AFTER the content gate — a gate that was never going to
// run for this diff must not print a skip line claiming otherwise.
export function onceProvenSkip(state, gate, extra = '') {
  const D = landDeps();
  const entry = landGateProven(state, gate);
  if (!entry) return null;
  // plan 4003 T2: a PARTIAL entry never authorizes a skip — it narrows a run. Say which one this
  // is, because the two lines describe opposite amounts of work and an audit line that called a
  // partial proof "proven green" would be the most misleading sentence in the land log.
  if (D.L.isPartialGateProof(entry)) {
    console.log(
      `done-worktree: once-per-land: ${gate} was PARTIALLY proven at ${entry.sha.slice(0, 7)} in ` +
        `this land — ${entry.provenFiles.length} file(s) already passed before the run was killed; ` +
        `the rest still runs (plan 4003 T2)${extra}`,
    );
    return entry;
  }
  console.log(
    `done-worktree: once-per-land: ${gate} proven green at ${entry.sha.slice(0, 7)} in this ` +
      `land — skipped (plan 3295)${extra}`,
  );
  return entry;
}

// The once-per-land decision for a gate that has NO diff-scoped variant (`build`, a project's own UI gate).
// Returns true ⇒ skip the whole step; false ⇒ run the step as usual.
//
// The naive form ("proven once ⇒ skip for the rest of the land") blinded the plan-2462
// content-keyed cache: a commit touching one gate's own closure made LATER in the same land was
// then build-verified by nothing at all — not by this step (skipped), not by the cache (never
// reached), not by the daily routine (which runs tests, not the production build) — gpt-review
// ea1746. So the proof only authorizes a skip while the delta since the proven tree stays OUTSIDE
// that gate's key closure: the exact path set `scripts/gate-pass-cache.mjs` keys the gate on.
// Anything inside it falls THROUGH to the normal cached path, where the content cache decides
// whether the change actually moved a build input (a reordered import that re-serializes to the
// same tree is still a cheap hit). The proven sha is refreshed at the step's own green exit, so
// the next re-entry measures its delta from the newest proof rather than the first one.
//
// A docs-only or otherwise-outside-the-closure delta still skips outright — the wall-time win the
// ruling exists for (a project's underlying data root can sit INSIDE both closures, so a data
// heal legitimately re-enters the cache).
//
// The closure is not the whole story: both gates also declare `envUncacheable` inputs — gitignored
// files whose very PRESENCE makes `gateVerdict` refuse to serve a cached
// green, because their content shapes the build / WebKit run and git cannot key them. A git delta
// is blind to them by construction, so the proof carries an `envHash` of exactly those files and
// this check compares it (gpt-review r2 2f9fb2 / 97c100 / 41a726).
//
// plan 4192: the CONTENT arm, checked first. A proof carrying a `closureKey` is compared with the
// key of the tree this invocation stands on: equal means every closure path (and the gate's own
// definition, node major and git version) is byte-identical to what the gate verified, so a
// head-of-queue rebase that moved master without touching the closure keeps the proof; unequal
// means something the gate reads changed, and the gate re-enters the cache instead. On a CLOUD
// land this is the ONLY arm (and only for a proof earned in this same land — see
// `landGateSameLandClosureProof`): the sha-delta arm below stays local-only, so a cloud land never
// skips on anything weaker than a content match. Locally a proof without a key, or a key that
// cannot be computed now, falls through to the delta arm exactly as before.
export function onceProvenClosureSkip(state, wtPath, gate, cacheGate) {
  const D = landDeps();
  const cloud = landGateIsCloud();
  const entry = cloud ? landGateSameLandClosureProof(state, gate) : landGateProven(state, gate);
  if (!entry) return false;
  // plan 4003 T2: `build` and a project's own UI gate have no per-file vocabulary and are never recorded partial,
  // so this can only fire on a corrupted or hand-edited sidecar. Refuse anyway — this function's
  // whole output is an AUTHORIZED SKIP, and a partial proof is by construction not one.
  if (D.L.isPartialGateProof(entry)) return false;
  const keyNow = entry.closureKey ? landGateClosureKey(wtPath, cacheGate, 'HEAD') : null;
  if (entry.closureKey && keyNow && keyNow !== entry.closureKey) {
    console.log(
      `done-worktree: once-per-land: ${gate} was proven green at ${entry.sha.slice(0, 7)}, but its ` +
        `closure content key changed since (${entry.closureKey.slice(0, 8)} -> ${keyNow.slice(0, 8)}) ` +
        `— re-entering the gate through the content cache (plan 4192)`,
    );
    return false;
  }
  if (cloud && !keyNow) {
    console.log(
      `done-worktree: once-per-land: ${gate} was proven green at ${entry.sha.slice(0, 7)} in this ` +
        `land, but its closure content key could not be computed now — running the gate (plan ` +
        `4192, a cloud land skips only on a content match)`,
    );
    return false;
  }
  if (keyNow) return onceProvenEnvCheckedSkip(entry, wtPath, gate, cacheGate, 'closure-key');
  const closure = resolveGateRegistry(D)[cacheGate]?.paths ?? [];
  const delta = landGateDeltaPaths(wtPath, entry.sha, []);
  if (delta === null) {
    console.log(
      `done-worktree: once-per-land: ${gate} was proven green at ${entry.sha.slice(0, 7)}, but the ` +
        `delta since it could not be computed — running the gate (plan 3295, fail-safe)`,
    );
    return false;
  }
  const touched = delta.filter((p) => closure.some((c) => D.gatePassCache.pathCovers(c, p)));
  if (touched.length) {
    console.log(
      `done-worktree: once-per-land: ${gate} was proven green at ${entry.sha.slice(0, 7)}, but ` +
        `${touched.length} path(s) since then are inside its key closure (e.g. ${touched[0]}) — ` +
        `re-entering the gate through the content cache (plan 3295, finding ea1746)`,
    );
    return false;
  }
  return onceProvenEnvCheckedSkip(entry, wtPath, gate, cacheGate, 'delta');
}

// The shared tail of both arms of `onceProvenClosureSkip`: the committed closure is known to be
// what the proof verified; the untracked inputs decide the rest. `arm` only picks the audit line.
function onceProvenEnvCheckedSkip(entry, wtPath, gate, cacheGate, arm) {
  // The UNTRACKED half. A proof written before this check existed carries no `envHash`; comparing
  // it against the all-absent baseline is the honest reading of what such a proof witnessed, so a
  // gate whose env file exists now correctly falls through instead of riding an unverified skip.
  const envNow = landGateEnvHash(wtPath, cacheGate);
  const envThen =
    typeof entry.envHash === 'string'
      ? entry.envHash
      : landGateEnvHash(wtPath, cacheGate, { assumeAbsent: true });
  if (envNow !== envThen) {
    console.log(
      `done-worktree: once-per-land: ${gate} was proven green at ${entry.sha.slice(0, 7)}, but an ` +
        `untracked input the gate cannot cache across (${gateEnvUncacheableFiles(cacheGate).join(', ')}) ` +
        `changed since — re-entering the gate (plan 3295, gpt-review r2 41a726)`,
    );
    return false;
  }
  console.log(
    arm === 'closure-key'
      ? `done-worktree: once-per-land: ${gate} proven green at ${entry.sha.slice(0, 7)} in this land ` +
          `and its closure content key ${entry.closureKey.slice(0, 8)} is unchanged — skipped (plan 4192)`
      : `done-worktree: once-per-land: ${gate} proven green at ${entry.sha.slice(0, 7)} in this land ` +
          `and nothing in its key closure changed since — skipped (plan 3295)`,
  );
  return true;
}

// The `envUncacheable` files a cache gate declares — read from the registry, never a second copy of
// the filename (a new entry there must reach this check automatically).
export function gateEnvUncacheableFiles(cacheGate) {
  const D = landDeps();
  return resolveGateRegistry(D)[cacheGate]?.envUncacheable ?? [];
}

// A stable digest of those files' CONTENT — `<rel>=<sha256>` per file, or `<rel>=absent`, joined.
// `''` for a gate that declares none (nothing to compare, so every such gate's proof stays sha-only).
// `assumeAbsent` builds the baseline an entry with no recorded hash is compared against.
// DRY hook: DW_FAKE_LAND_GATE_ENV_HASH stands in for the live read, honoured only under --dry-run
// (a dry worktree path has no real files to hash), never for the assumeAbsent baseline — a test
// that faked both sides would prove nothing.
function landGateEnvHash(wtPath, cacheGate, { assumeAbsent = false } = {}) {
  const D = landDeps();
  const files = gateEnvUncacheableFiles(cacheGate);
  if (!files.length) return '';
  if (D.env.DRY && !assumeAbsent && process.env.DW_FAKE_LAND_GATE_ENV_HASH !== undefined) {
    return process.env.DW_FAKE_LAND_GATE_ENV_HASH;
  }
  return files
    .map((rel) => {
      if (assumeAbsent) return `${rel}=absent`;
      try {
        return `${rel}=${createHash('sha256')
          .update(readFileSync(`${wtPath}/${rel}`))
          .digest('hex')}`;
      } catch {
        return `${rel}=absent`; // missing / unreadable — the same state the pass cache calls "no env file"
      }
    })
    .join('\n');
}

// plan 3961 T3.5b: which pass-cache entry (and therefore which closure + untracked inputs) each
// once-per-land gate is keyed against USED TO BE a spine-local map, `LAND_GATE_CACHE_GATE`, keyed
// by land-gate name and consulted from three separate readers — a second, driftable copy of the
// exact same pairing each gate's OWN registry entry already carries as its `passCacheGate` field
// (build's declared in coreGateImpls() below, a project's own UI gate's on scripts/project/land-gate-mobile.mjs's
// own entry; core-noun-ok: names the actual project module file). Reading the registry directly, once, removes the copy: the entry IS the pairing, and
// a gate that declares no `passCacheGate` (every gate WITH a diff-
// scoped variant) reads back `undefined` exactly as a missing map key used to.
//
// The same lookup keyed by `runPrepGates`' own compact PREP vocabulary (its own short per-gate
// keys), which has to go through PREP_GATE_TO_LAND_GATE first. One place, so the prep loop and the
// stamp seams cannot drift on which gates even have untracked inputs to compare.
function prepGateCacheGate(registries, prepKey) {
  const D = landDeps();
  const landGate = D.L.PREP_GATE_TO_LAND_GATE[prepKey];
  return landGate ? registryEntry(registries, 'prepGates', landGate).passCacheGate : undefined;
}

// The inverse of L.PREP_GATE_TO_LAND_GATE: registry gate name -> the compact key `runPrepGates`
// names its results, its carry-forward cap and its marker with. Derived, never hand-listed, so the
// two vocabularies cannot drift.
//
// plan 3961 T3.5: was a module-level const in the spine, computed eagerly at import time — the
// value lives behind `landDeps()`'s container, which cannot be resolved at module-load time (it is
// bound by the command file at its own boot, long after this module has already loaded), so this
// reads `D.L` at CALL time instead, recomputed fresh rather than memoized (see this module's own
// header, "A NON-MECHANICAL DEVIATION").
function landGateToPrepKey() {
  const D = landDeps();
  return Object.freeze(
    Object.fromEntries(
      Object.entries(D.L.PREP_GATE_TO_LAND_GATE).map(([prep, land]) => [land, prep]),
    ),
  );
}

/**
 * Look one entry up by name, REFUSING when it is absent.
 *
 * A missing registration must never read as "this step does not apply" — that is the exact
 * silent-skip failure the registry exists to make impossible, and on the land spine it means a gate
 * or a seam quietly stops running with a green land to show for it. The error names the point and
 * everything that IS registered, because the cause is always either a typo'd name at the call site
 * or a `plugins.*` module that did not load what its host expected.
 */
function registryEntry(registries, point, name) {
  const found = registries[point].find((e) => e.name === name);
  if (!found) {
    throw new Error(
      `done-worktree: no ${point} entry registered as "${name}" — the spine asked for it by name, ` +
        `so a land would silently skip it. Registered ${point}: ` +
        `${registries[point].map((e) => `${e.name} (${e.where})`).join(', ') || '(none)'}.`,
    );
  }
  return found;
}

/**
 * Ask a registered landSeam for its verdict, handing back the spine's OWN convention —
 * `null` for cleared, `{ code, reason, … }` for halt — so a call site reads exactly as it did when
 * it called the seam function directly. The registry's `{ ok, seam, message }` shape is what
 * crosses the extension-point boundary; this unwraps it again on the inside.
 *
 * The seam is looked up BY NAME and a missing one throws (see registryEntry). That is the point of
 * routing through here rather than keeping the direct call: after T2 moves these implementations
 * into scripts/project/, a project that fails to register one gets an error at the seam it was
 * supposed to guard, not a land that sails past it.
 */
export function landSeamCheck(registries, name, ctx) {
  const r = registryEntry(registries, 'landSeams', name).check(ctx);
  // The SAME strictness runLandSeams applies, and for the same reason (gpt-review acb447): this
  // adapter used to unwrap a private `raw` field the registry's contract does not mention, so a
  // seam returning the DOCUMENTED `{ ok, seam, message }` — which is what a plugin-registered seam
  // will return — yielded `undefined` here, and every call site spells its halt as `if (seam)`.
  // The result was a registered land seam silently reading as CLEARED. There is now exactly one
  // shape crossing the boundary and it is reconstructed here, so that class cannot recur.
  if (!r || typeof r !== 'object') {
    throw new Error(
      `done-worktree: landSeams entry "${name}" returned no result object — a seam must return ` +
        `{ ok, seam, message }`,
    );
  }
  if (typeof r.ok !== 'boolean') {
    throw new Error(
      `done-worktree: landSeams entry "${name}" returned a non-boolean "ok" ` +
        `(${JSON.stringify(r.ok)}) — a seam result must be exactly true or false`,
    );
  }
  if (r.ok) return null;
  if (!r.seam) {
    throw new Error(
      `done-worktree: landSeams entry "${name}" reported a failure with no "seam" code`,
    );
  }
  // The spine's own shape: `{ code, reason }`, which is all any consumer of these reads
  // (emitSeam, emitSeamWithMarkerTable, and emitReworkHaltWithRelease, which takes the object and
  // uses exactly those two fields).
  return { code: r.seam, reason: r.message ?? '' };
}

/**
 * Refuse a `markerFamily.key` that names no real marker family (plan 4056).
 *
 * registry.mjs validates the field's SHAPE and stops there — it is import-free by Rule 3, so it
 * cannot know which keys exist. This module can, so the membership half lands here. It matters
 * because a typo'd key is otherwise silent twice over: the rework halt shows no label, and the
 * preflight-marker record gets no slot for that family, so a later spine-owned re-sha never asks
 * it to re-pin. Both failures look like "nothing happened".
 */
function assertKnownMarkerFamily(name, entry) {
  const D = landDeps();
  const key = entry.markerFamily.key;
  if (!Object.prototype.hasOwnProperty.call(D.L.MARKER_FAMILIES, key)) {
    throw new Error(
      `land-seam driver: landSeams entry "${name}" (${entry.where}) declares markerFamily.key ` +
        `${JSON.stringify(key)}, which is not a known marker family — valid keys: ` +
        `${Object.keys(D.L.MARKER_FAMILIES).join(', ')}`,
    );
  }
}

/**
 * Run a registered landSeam end to end: the ONE generic driver for the seven-step shape three
 * hand-written wrappers used to spell separately (plan 4056, finding `elukwb`).
 *
 * The steps, in the order they have always run:
 *   1. applicability — the entry's own `applies(diff, ctx)`, through the shared reader.
 *   2. the marker LOOKUP, deliberately OUTSIDE the `--resume` guard below (plan 3972): a marker
 *      that exists arms the preflight-tip re-proof even on a waived run, so the lookup follows
 *      applicability, never the resume decision.
 *   3. the `--resume <seamCode>` skip.
 *   4. the seam's own `check(ctx)`, via landSeamCheck.
 *   5. on a hold with NO marker in hand, one mechanical re-pin through the family's recorder
 *      script (plan 1528: a marker stale only because a pure rebase re-sha'd the branch heals
 *      itself), then a fresh lookup and a fresh check; a re-pin REFUSED on non-identical
 *      patch-ids is the rework signal.
 *   6. the halt: a proven-rework hold releases the queue slot first (plan 2170 Ship 2), then the
 *      seam is emitted with the marker-status table (plan 2086).
 *   7. the found marker goes back to the caller, which is what the preflight-marker record reads.
 *
 * A seam declaring NO `markerFamily` runs the degenerate case — no lookup, no re-pin, no rework
 * release, and a BARE `emitSeam` rather than the marker table — which is exactly what a seam with
 * no marker to be satisfied by does today. A seam declaring no `seamCode` has no resume valve.
 *
 * `ctx` is the whole land ctx. The entry's own `check` does its own projection out of it, and the
 * marker found at step 2 is published on `ctx.seamMarker` for the check to read — so no
 * projection field is needed on the entry, which is what keeps this fold to the two fields the
 * registry now declares rather than three.
 *
 * Returns `{ applicable, resumed, marker }`. Steps 5 and 6 exit the process on a halt, so a
 * return always means this seam CLEARED (or never applied, or was waived).
 */
export function runLandSeamStep(registries, name, ctx) {
  const D = landDeps();
  const entry = registryEntry(registries, 'landSeams', name);
  // Validated BEFORE the applicability guard on purpose: a land where this seam does not apply
  // would otherwise sail past a typo'd family key and only fail on some later land whose diff
  // happens to trigger it.
  if (entry.markerFamily) assertKnownMarkerFamily(name, entry);

  const { state, MAIN, slug, wtPath, handoffLayout, resumedPast, seamTimeRepin, changed } = ctx;
  if (!landSeamApplies(entry, changed ?? null, ctx)) {
    return { applicable: false, resumed: false, marker: null };
  }

  const fam = entry.markerFamily ?? null;
  let marker = fam ? fam.lookup(ctx) : null;
  if (entry.seamCode && resumedPast(entry.seamCode)) {
    return { applicable: true, resumed: true, marker };
  }

  const check = () => landSeamCheck(registries, name, { ...ctx, seamMarker: marker });
  let seam = check();

  // The re-pin arm is entered only with a marker-backed seam that found NO marker — the same
  // `if (seam && !marker)` the hand-written wrappers spelled. With a marker already in hand the
  // hold is a real verdict problem, not a stale pin, and re-pinning would say nothing.
  let rework = false;
  if (seam && fam && !marker) {
    const rp = seamTimeRepin(fam.recorder); // plan 3972 F3: the shared one-fetch instance
    if (rp.repinned) {
      marker = fam.lookup(ctx);
      seam = check();
      if (!seam) {
        const label = D.L.MARKER_FAMILIES[fam.key].label.toLowerCase();
        console.log(
          `done-worktree: stale ${label} marker auto re-pinned to HEAD (patch-id-identical ` +
            `rebase, plan 1528) — ${name} seam cleared.`,
        );
      }
    }
    rework = rp.rework === true;
  }

  if (seam) {
    if (!fam) {
      D.spine.emitSeam(seam.code, seam.reason, state);
    } else {
      // ALWAYS emits and process-exits; the marker-table halt below is the non-rework path.
      if (rework) {
        emitReworkHaltWithRelease(
          state,
          D.L.MARKER_FAMILIES[fam.key].label,
          seam,
          MAIN,
          slug,
          wtPath,
          handoffLayout,
        );
      }
      emitSeamWithMarkerTable(seam.code, seam.reason, MAIN, slug, wtPath, handoffLayout, state);
    }
  }
  return { applicable: true, resumed: false, marker };
}

/**
 * Run every registered landSeam that opts into the step-lifecycle shape `runLandSeamStep` drives —
 * declared by carrying a `seamCode` — in the registry's own order (finding `92nebq`, plan 4066 T3).
 *
 * The spine used to NAME its three step-driven seams (status-flip, conclusion-review, and
 * wiki-checkpoint) at three near-identical call sites instead of iterating the registry, which is (core-noun-ok: names the real registered seam this driver replaces three call sites for)
 * exactly the duplication `runPreflightGates` already removed for prepGates (plan 4056, finding
 * `elukwb`) — this is that same fold, one extension point over.
 *
 * `seamCode` is the predicate rather than, say, a new registry field, because it already says what
 * this driver needs to know: a seam with none has no `--resume` valve, so `runLandSeamStep`'s own
 * step 3 could never skip it, and a hand-driven caller could never waive it either — there is
 * nothing left for a generic loop to add. Every seam this driver runs declares one; the two that do
 * not (`review-marker`, `findings-open`) are refused this driver on purpose and stay hand-called,
 * for two DIFFERENT reasons, neither of them incidental:
 *   - `review-marker` attempts its marker re-pin unconditionally, deliberately INCLUDING under
 *     `--resume` (the plan-2170 hoist), while `runLandSeamStep` checks `resumedPast` FIRST and
 *     returns before `check()` runs at all. Driving it through here would invert this driver's own
 *     contract and change the OTHER three seams' repin-under-resume behaviour along with it.
 *   - `findings-open` simply is not this shape: it declares no `applies` and no `markerFamily`
 *     either, and its check reads ctx fields the shared seam ctx does not carry at all, so there is
 *     no uniform call for it to be folded into.
 *
 * Same order, same conditions, same seam codes/message text, same --resume vocabulary as the
 * three hand-written calls this replaces — every driven entry's own `applies`/`check` is
 * unchanged, only the call is now generic.
 *
 * Returns `{ ran, markers }`: `ran` is the driven entries' names, in the order run; `markers` maps
 * each of those names to the marker `runLandSeamStep` found for it (`null` for a seam that found
 * none, or applied but declared no `markerFamily`). That map is the route D-4066-7 found already
 * open — the caller folds exactly the families it already fed into `recordPreflightMarkers` out of
 * it, by name, instead of out of three separately-named locals.
 */
export function runLandSeamPhase(registries, ctx) {
  const driven = registries.landSeams.filter((s) => typeof s.seamCode === 'string');
  const ran = [];
  const markers = {};
  for (const entry of driven) {
    const { marker } = runLandSeamStep(registries, entry.name, ctx);
    ran.push(entry.name);
    markers[entry.name] = marker;
  }
  return { ran, markers };
}

/** Run a registered prepGate's implementation. Sync or async, per the gate (plan 1291). */
export function prepGateRun(registries, name, ctx) {
  return registryEntry(registries, 'prepGates', name).run(ctx);
}

/**
 * Does a registered prepGate apply to this diff?
 *
 * The land site's membership question, and the twin of the `selectPrepGates` call runPrepGates
 * makes — asked per gate here rather than as one ordered selection because the land's gate blocks
 * are straight-line code interleaved with work that is not a gate at all (a project-owned gate's
 * own view hoist, the cloud-only disk prune, the landGate tier resolve). Reordering them into a generic
 * loop is T3's carve, not this step's; what T1d fixes is that both sites now read ONE roster for
 * whether a gate exists and whether it applies.
 */
export function prepGateApplies(registries, name, diff, ctx) {
  const gate = registryEntry(registries, 'prepGates', name);
  return selectPrepGates([gate], diff, ctx, { stage: gate.stage }).length === 1;
}

// plan 3503 gpt-review round 3 (cluster 1): ONE reader for both ends of a gate's untracked-input
// window, so "capture before" and "re-read after" cannot be written two different ways. `dryVar`
// names that end's dry-only override (the DW_FAKE_* family, honoured only under --dry-run, so a
// leaked variable can never reach production); every other path takes the live read.
// `undefined` ⇒ this gate declares no untracked inputs, exactly as `recordLandGateProven` means it.
export function gateEnvHashAt(wtPath, cacheGate, dryVar) {
  const D = landDeps();
  if (!cacheGate) return undefined;
  if (D.env.DRY && dryVar && process.env[dryVar] !== undefined)
    return process.env[dryVar] || undefined;
  return landGateEnvHash(wtPath, cacheGate) || undefined;
}

// The digest is `<rel>=<sha256>` per file — a log line wants the short form, not 64 hex characters.
export function shortEnvHash(hash) {
  return hash === undefined ? 'absent' : hash.replace(/=([0-9a-f]{9})[0-9a-f]*/g, '=$1');
}

// plan 3503 gpt-review round 3 (cluster 3): the prep MARKER has no environment dimension —
// `landPrepValid` compares shas only. So an untracked gate input can change after the last gate and
// before the stamp, HEAD unchanged, the marker is stamped green, and the NEXT land's fast path
// skips build and a project's own UI gate for an environment neither was ever run under — contradicting the standing
// rule that those two skip only while their input closure is unchanged.
//
// The fix reuses round 2's refusal rather than extending the format: a new marker field would need
// a compatibility story for markers written by older builds, and `landPrepValid` is on this plan's
// do-not-touch list. Refusing to stamp degrades cleanly to today's behaviour — the land runs its
// own gates. Returns the first drifted gate (name + both digests) or null.
export function prepGateEnvDrift(registries, wtPath, gateResults, gateEnvProven) {
  for (const [key, green] of Object.entries(gateResults || {})) {
    if (!green) continue;
    const cacheGate = prepGateCacheGate(registries, key);
    if (!cacheGate) continue;
    const provenUnder = gateEnvProven?.[key];
    if (provenUnder === undefined) continue; // no untracked inputs declared ⇒ nothing can drift
    const now = landGateEnvHash(wtPath, cacheGate) || undefined;
    if (now !== provenUnder) return { key, cacheGate, provenUnder, now };
  }
  return null;
}

function persistLandGateProofState(state, wtPath) {
  const D = landDeps();
  const payload = {
    landId: state.landGateId || state.landId,
    slug: state.slug,
    gatesProven: state.gatesProven,
  };
  // plan 3503 D1: the existing --dry-run subprocess harness cannot inspect a child's `.scratch`
  // write (and dry runs must never perform one), so narrate the exact would-be payload there. This
  // is a trace, not a second proof channel; production still writes only the canonical sidecar.
  if (D.env.DRY)
    console.log(`done-worktree --dry-run: gatesProven sidecar ${JSON.stringify(payload)}`);
  writeLandGatesProven(wtPath, payload);
}

export function recordLandGateProven(registries, state, wtPath, gate, opts = {}) {
  const D = landDeps();
  // plan 3503 D1: prep remains fail-closed unless the one fresh-whole-green seam opts in. This
  // prevents a future marker/carry-forward path from accidentally laundering an old result into
  // the worktree-lifetime sidecar merely because it also executes under `--prep`.
  if (D.env.IS_PREP && !opts.fromFreshPrepGreen) return;
  // A gate with untracked inputs records their digest ALONGSIDE the sha, so the skip check can see
  // a change git never will (gpt-review r2 41a726). Gates without any get `undefined` and stay
  // sha-only, exactly as before.
  // plan 3961 T3.5b: reads the registry entry's own `passCacheGate` — see prepGateCacheGate's
  // header for why this replaced the spine-local LAND_GATE_CACHE_GATE map.
  const cacheGate = registryEntry(registries, 'prepGates', gate).passCacheGate;
  const envHash = Object.prototype.hasOwnProperty.call(opts, 'envHash')
    ? opts.envHash
    : cacheGate
      ? landGateEnvHash(wtPath, cacheGate) || undefined
      : undefined;
  // plan 4192: a gate with a pass-cache closure also records that closure's content key at the
  // proven tree, plus the land that earned it — what lets the proof survive a rebase and, on a
  // cloud land, a chunk re-invoke (see onceProvenClosureSkip). A key that cannot be computed is
  // simply left off: the entry then behaves exactly as a pre-4192 sha-only proof.
  const provenSha = opts.sha ?? worktreeHeadSha(wtPath);
  const closureKey = cacheGate ? landGateClosureKey(wtPath, cacheGate, provenSha) : null;
  const entry = D.L.gateProvenEntry(provenSha, new Date(), envHash, {
    closureKey: closureKey ?? undefined,
    landId: state.landGateId || state.landId || undefined,
  });
  if (!entry) return; // no verifiable tree ⇒ no proof (see gateProvenEntry)
  if (opts.proofBuffer) {
    // plan 3503 gpt-review round 2 (fe75fd/f6d4d8/82ea78): speculation writes NOWHERE until its
    // exact-tree marker exists. A failed stack or lost lock then discards this Map in memory; no
    // rollback can fail open and no stale process needs permission to repair the sidecar.
    opts.proofBuffer.set(gate, entry);
    return;
  }
  state.gatesProven = { ...(state.gatesProven || {}), [gate]: entry };
  persistLandGateProofState(state, wtPath);
}

// ── plan 4003 T2: bank what a KILLED gate already proved ──────────────────────────────────────
//
// Called on a battery run that timed out (or whose termination could not be proven) but whose
// per-file ledger names files that passed first. Writes a PARTIAL entry: the next invocation of
// this same land runs the remainder instead of restarting from file one.
//
// REPLACE, never merge-with-a-whole-entry. A partial entry carries its OWN sha and its own file
// list, and `(universe - provenFiles) ∪ (delta since that sha)` covers every unproven path
// regardless of what an older whole proof said — so composing the two would add precision nothing
// needs and a case nothing tests. Two partials at the SAME sha DO accumulate: that is the
// attempt-after-attempt case this exists for.
//
// Fail-closed under `--prep`, exactly like `recordLandGateProven`: plan 3503 ruled that the prep
// path may not launder results into the worktree-lifetime sidecar, and a partial proof is a result.
export function recordLandGatePartialProven(state, wtPath, gate, { sha, files } = {}) {
  const D = landDeps();
  if (D.env.IS_PREP) return;
  if (!sha || !Array.isArray(files) || files.length === 0) return;
  const prior = state?.gatesProven?.[gate];
  const carried =
    D.L.isPartialGateProof(prior) && prior.sha === sha ? [...prior.provenFiles, ...files] : files;
  const entry = D.L.gatePartialProvenEntry(sha, carried, new Date());
  if (!entry) return; // nothing normalizes to a usable set ⇒ no proof, next run is the full one
  state.gatesProven = { ...(state.gatesProven || {}), [gate]: entry };
  persistLandGateProofState(state, wtPath);
  console.log(
    `done-worktree: once-per-land: banked a PARTIAL ${gate} proof at ${String(sha).slice(0, 7)} — ` +
      `${entry.provenFiles.length} file(s) passed before the run was killed, so the next ` +
      `invocation of this land runs only the remainder (plan 4003 T2)`,
  );
}

export function flushLandGateProofBuffer(state, wtPath, proofBuffer) {
  if (!proofBuffer?.size) return;
  state.gatesProven = {
    ...(state.gatesProven || {}),
    ...Object.fromEntries(proofBuffer),
  };
  proofBuffer.clear(); // makes a second call a no-op: one speculative pass, one sidecar write
  persistLandGateProofState(state, wtPath);
}

// ── plan 4042 (D-M7/D-M8/D-M9): the generic prepGate lifecycle ────────────────────────────────
//
// Every land-time prepGate call site used to hand-write the SAME ten-step sequence around its own
// `prepGateRun` call: applicability, a once-per-land proof check, a scoped-or-full selection, the
// run itself, a post-run ownership re-check, classifying the result, an optional reclassification,
// a telemetry write, recording (or withholding) the proof, and finally turning a bad outcome into
// a halt. Five of those ten steps are measured IDENTICAL across every gate that has one; this
// function is the one place that sequence now lives, with the other three as named, defaulted
// hooks on the registry ENTRY (never on this function) for the variance that is genuine.

// Base outcome classes a run() result sorts into, BEFORE the entry's own `reclassify` hook (if
// any) gets a look. Order matters and is not arbitrary: a non-convergent round always also carries
// `chunked: true` (a stuck, no-forward-progress chunk series is still chunked), so testing it
// first is what keeps a terminal stuck gate from being recorded as ordinary resumable progress —
// the exact ordering bug a prior review round caught and fixed at each hand-written call site
// separately. "starved" is this function's name for that non-convergent case; a DIFFERENTLY
// caused starvation reading (a gate's own reason a round produced nothing) reaches the same slot
// through the entry's `reclassify` hook instead of a second base class here.
// The four base classes this function can return. Declared as data so the `reclassify` hook's
// return can be checked against it: an entry that returns something outside this set has a typo,
// not a new outcome, and every downstream step tests for specific names, so an unvalidated stray
// value would mean no proof, no seam and no telemetry naming a problem.
//
// `unproven` is deliberately NOT in this set (gpt-review round 2, CONFIRMED). It is RUNNER-owned:
// `withUnprovenClassification` derives it, one step later, from the entry's own `provesGate`. An
// entry that could name it directly from `reclassify` would be reaching past that derivation to
// assert "green but proves nothing" without answering the question `provesGate` exists to ask —
// and the whole point of D-M12 was that an unearned proof must be impossible to produce by
// accident rather than merely discouraged.
const PREP_GATE_RECLASSIFY_RESULTS = Object.freeze(
  new Set(['pass', 'failed', 'chunked', 'starved']),
);

function classifyPrepGateOutcome(result) {
  if (result.nonConvergent) return 'starved';
  if (result.chunked) return 'chunked';
  if (!result.ok) return 'failed';
  return 'pass';
}

// plan 4042 (D-M12): a fifth classification, sitting beside `pass` rather than inside `failed`,
// `chunked` or `starved`. A run can come back green having verified nothing — an escape hatch
// that returns success without exercising the thing the gate exists to check. Recording a proof
// for that outcome would let a LATER land skip the real check on a banked green it never earned,
// which is a correctness hazard, not a cosmetic one — so a green of that shape must classify
// differently from an ordinary pass, even though nothing about the raw result (not failed, not
// chunked, not non-convergent) would otherwise mark it as such.
//
// `provesGate(result)` is the entry's own answer to "did this run actually verify my subject?" —
// optional, defaulting to always-true, so a host that never has this shape of green declares
// nothing and every existing entry keeps classifying exactly as it does today. It is consulted
// only once the base classification (after reclassify) has already settled on `pass`: a failed,
// chunked or starved outcome is not a green of any shape, so the question does not apply, and an
// entry's own `reclassify` hook still gets the first word on whether this run is a pass at all.
function withUnprovenClassification(classification, result, entry) {
  if (classification !== 'pass') return classification;
  if (typeof entry.provesGate !== 'function') return classification;
  return entry.provesGate(result) ? classification : 'unproven';
}

/**
 * Pure: the classification a run() result earns for `entry`, WITHOUT the entry's own `reclassify`
 * hook — i.e. the base outcome plus the D-M12 unproven derivation. `'pass'` is the one value that
 * authorizes a whole-gate proof; every other value withholds it.
 *
 * ── plan 4056 (plan 4042 review finding `lgmdvs`) ──────────────────────────────────────────────
 * This exists because TWO call sites answer "did this green earn a proof?" and only one of them
 * used to ask the entry. The land-time lifecycle below derives it from the entry's own declared
 * `provesGate`; the `--prep` pre-pass (`runPrepGates`) tested `r.ok` against a hardcoded pair of
 * result-flag names instead — the two flags whichever gates existed at the time happened to set.
 * That was wrong in both directions:
 *
 *   * CORRECTNESS. An entry declaring `provesGate` had its answer ignored by the pre-pass, so a
 *     green that verified nothing was still banked into the once-per-land sidecar. A LATER land
 *     then takes the fast path on that proof and merges without ever running the gate. D-M12's
 *     whole point was that an unearned proof must be impossible to produce by accident, and a
 *     second site deriving the same question by hand is exactly how one gets produced.
 *   * LAYERING. Those flag names were a HOST gate's own vocabulary, hardcoded in a core module.
 *     Each such gate now declares its own answer on its own entry, and this module names none of
 *     them — which is also what let the pre-pass loop below stop spelling them out.
 *
 * `reclassify` is deliberately NOT applied here, so the two sites keep their one real difference:
 * the lifecycle can let an entry turn a red into a flake pass (or a differently-caused starve),
 * while the pre-pass reads `r.ok` itself to decide whether the PASS failed and reports that through
 * its own `onGateFail`/`stopOnFail` protocol. Folding reclassify in would let a hook flip a
 * pre-pass gate to green while that protocol still reported it red — two answers to one question,
 * which is the defect class this helper closes rather than a second instance of it. No entry
 * declares `reclassify` today, so this is a stated boundary, not a live divergence.
 *
 * `select` needs no treatment here either: the pre-pass never narrows a run (it calls `run` with a
 * full ctx and no `selection`), so its green genuinely covers the whole gate. The lifecycle's own
 * scoped-run withholding stays where it is, on the site that can actually narrow.
 */
export function prepGateProofClassification(entry, result) {
  return withUnprovenClassification(classifyPrepGateOutcome(result), result, entry);
}

// The telemetry vocabulary is a SEPARATE axis from the seam classification above (also measured
// identical across every gate that writes one): a non-convergent round is telemetered as a plain
// `fail`, never `chunked`, because the round proved nothing worth calling partial progress — even
// though classifyPrepGateOutcome above folds the SAME round into its own `starved` seam slot,
// which is a genuinely different question (which halt fits, not how to summarize the attempt).
// `classification` is the FINAL one (after reclassify and the unproven check above), read here
// instead of re-deriving `pass`/`chunked`/`starved` from the raw result a second time — the two
// axes shared their own hand-rolled copy of that derivation before this change, which is exactly
// the kind of drift a single source of truth is supposed to make impossible. `cached` and
// `timedOut` stay read off the raw result because neither has a classification of its own: a
// cache hit and a cap-kill are refinements of an ordinary pass/fail, not additional slots in the
// five-way split above. An "unproven" classification telemeters with the SAME string an existing
// bypass (a verification gate skipped outright) already uses for a green that verified nothing —
// see the shared string literal's own call sites.
function telemetryResultForPrepGate(classification, result) {
  if (result.cached) return 'cache-hit';
  if (classification === 'pass') return 'pass';
  if (classification === 'unproven') return 'skipped';
  if (classification === 'starved') return 'fail';
  if (classification === 'chunked') return 'chunked';
  if (result.timedOut) return 'cap-kill';
  return 'fail';
}

/**
 * Run a registered prepGate through the full ten-step lifecycle: applicability, the once-per-land
 * proof check, selection, the run itself, the post-run ownership re-check, classification,
 * reclassification, telemetry, proof recording, and seam emission — see this section's own header
 * for which of those are pure runner logic and which read an entry-supplied hook.
 *
 * `ctx` is the ONE shape every one of the entry's own hooks sees (D-M9): `{ wtPath, opts, state,
 * diff }`. `applies(diff, ctx)` (already the existing `prepGateApplies` reader), `select(diff,
 * ctx)`, `run(ctx)` and `reclassify(classification, result, ctx)` are all handed this same object,
 * so none of the four can be given a narrower or differently-shaped view than the others.
 *
 * Returns one of three shapes:
 *   { applicable: false }                                — the diff does not touch this gate's surface
 *   { applicable: true, provenSkip: true }                — a once-per-land proof authorized a skip
 *   { applicable: true, provenSkip: false, classification, result, proofRecorded, proofWithheldReason }
 * `classification` is one of `pass` / `failed` / `chunked` / `starved` / `unproven` (plan 4042
 * D-M12) — the last one a green that the entry's own `provesGate(result)` says verified nothing,
 * so it records no proof and emits no seam even though it is not a failure of any kind. An entry
 * that declares `seams` has ALREADY had its seam emitted (which exits the process, so a
 * `failed`/`chunked`/`starved` classification is never actually observed by such a caller) by the
 * time this returns. An entry that does not — see step 10's own note on today's one real gap —
 * returns normally on every classification, and the CALLER is the one that must still turn a
 * non-`pass` (and non-`unproven`) classification into a halt, exactly as it did before this
 * function existed.
 */
export async function runPrepGateLifecycle(registries, name, ctx) {
  const D = landDeps();
  const { wtPath, diff, state } = ctx;
  const entry = registryEntry(registries, 'prepGates', name);

  // 1. applicability — the entry's own applies(diff, ctx), via the existing shared reader.
  if (!prepGateApplies(registries, name, diff, ctx)) return { applicable: false };

  // 2. once-per-land proof check, including the closure-based skip. A gate with no declared
  // `passCacheGate` has no once-per-land vocabulary to check against and never skips here.
  const provenSkip = entry.passCacheGate
    ? onceProvenClosureSkip(state, wtPath, name, entry.passCacheGate)
    : false;
  if (provenSkip) {
    if (!D.env.DRY) {
      D.spine.appendDeployGateOutcome(wtPath, {
        branch: state.branch,
        gate: entry.passCacheGate ?? name,
        result: 'cache-hit',
        durS: 0,
        sel: 'gates-proven',
        phase: 'land',
      });
    }
    return { applicable: true, provenSkip: true };
  }

  // 3. selection (scoped or full) — the entry's own select(diff, ctx); no adopter declares one
  // yet, so this defaults to a full run and `ctx` reaches run() unchanged in that case (byte-
  // identical to what a gate with no lifecycle received before this function existed).
  const selection = typeof entry.select === 'function' ? entry.select(diff, ctx) : undefined;
  const runCtx = selection === undefined ? ctx : { ...ctx, selection };

  // 4. run(ctx)
  const shaBefore = worktreeHeadSha(wtPath);
  const envBefore = gateEnvHashAt(
    wtPath,
    entry.passCacheGate,
    'DW_FAKE_LAND_GATE_ENV_HASH_AT_GATE_START',
  );
  const gateStartMs = Date.now(); // telemetry's own dur_s clock for this attempt
  const result = await prepGateRun(registries, name, runCtx);

  // 5. assertWorktreeStillOurs — measured IDENTICAL across every gate, so it is runner-owned and
  // no entry supplies it.
  assertWorktreeStillOurs(state, name);

  // 6. result classification (pure; see classifyPrepGateOutcome's own header for the ordering).
  let classification = classifyPrepGateOutcome(result);

  // 7. reclassify hook — default identity. Lets an entry turn a base `failed` into its own
  // differently-caused `starved` reading, or into a flake `pass`, without this function knowing
  // what that cause is.
  //
  // It receives `runCtx`, NOT `ctx` (gpt-review, CONFIRMED). Step 4 runs the gate against
  // `runCtx`; handing the hook the pre-selection `ctx` would let it reason about a run that did
  // not happen the moment any entry declares `select`. The two are the same object while no
  // adopter declares one, so this is latent today and wrong the day it stops being latent —
  // exactly the shape this plan keeps closing rather than leaving for the adopter to trip over.
  //
  // The return is VALIDATED. An unrecognised value is not a new classification, it is a typo, and
  // an unvalidated one would fall through every `=== 'pass'` test below: no proof, no seam, no
  // telemetry that names a problem — a gate that appears to run and reports nothing. That is the
  // silent-skip class this plan's own carve rules require to be a hard error naming the entry.
  if (typeof entry.reclassify === 'function') {
    const reclassified = entry.reclassify(classification, result, runCtx);
    if (!PREP_GATE_RECLASSIFY_RESULTS.has(reclassified)) {
      // Described, never JSON.stringify'd (gpt-review round 2, CONFIRMED): a BigInt throws and a
      // circular object throws, and this is the ERROR path — a formatter that can itself throw
      // would replace a precise "your hook returned the wrong thing" with an unrelated
      // TypeError from deep inside the runner, on the one code path whose entire job is to say
      // clearly what went wrong.
      const described =
        typeof reclassified === 'string' ? `"${reclassified}"` : `${typeof reclassified} value`;
      throw new Error(
        `land-gate lifecycle: prepGates entry "${name}" reclassify() returned ${described}, ` +
          `which is not a classification — expected one of ` +
          `${[...PREP_GATE_RECLASSIFY_RESULTS].join(', ')}. Returning the classification ` +
          `unchanged is how a hook declines to reclassify, and "unproven" is not available here: ` +
          `it is derived from this entry's own provesGate() one step later.`,
      );
    }
    classification = reclassified;
  }

  // 7b. provesGate hook (plan 4042 D-M12) — default always-true, so an entry that declares none
  // keeps classifying exactly as it did before this hook existed. Consulted only when the base
  // classification (post-reclassify) already reads `pass`: see withUnprovenClassification's own
  // header for why a failed/chunked/starved outcome never reaches this question at all.
  classification = withUnprovenClassification(classification, result, entry);

  // 8. telemetry write — pure shape, parameterised only by the entry's own cache-gate name. Reads
  // off the FINAL classification (post-reclassify, post-unproven), never re-derives one from the
  // raw result — see telemetryResultForPrepGate's own header.
  if (!D.env.DRY) {
    D.spine.appendDeployGateOutcome(wtPath, {
      branch: state.branch,
      gate: entry.passCacheGate ?? name,
      result: telemetryResultForPrepGate(classification, result),
      durS: result.cached ? 0 : Math.round((Date.now() - gateStartMs) / 1000),
      sel: selection === undefined ? 'full' : 'scoped',
      phase: 'land',
    });
  }

  // 9. proof recording — the SAME capture-before/re-read-after predicate every adopter's call
  // site used to spell by hand: a proof is recorded only when BOTH the tree and this gate's own
  // untracked-input digest are unchanged from the instant the gate started, otherwise it is
  // withheld (never failed) and this gate simply re-runs later in this land.
  //
  // A SCOPED run never records one (gpt-review, CONFIRMED). `recordLandGateProven` banks a proof
  // for the WHOLE gate under this gate's name; a run the entry narrowed through `select` verified
  // less than that, so banking it would let a later land skip work this land never did. That is
  // D-M12's unearned-proof hazard one layer up, and the same answer applies: make it structurally
  // impossible here rather than a rule each future adopter has to remember. Latent today — no
  // entry declares `select` — and the first one to do so would otherwise inherit the bug silently.
  // A narrowed green is still a real pass for seams and telemetry; it just proves less, so the
  // gate simply runs again later in this land.
  let proofRecorded = false;
  let proofWithheldReason = null;
  if (classification === 'pass' && selection !== undefined) {
    proofWithheldReason =
      'the run was narrowed by this entry’s own select(), so it proves a subset of the gate, not the gate';
    console.log(`done-worktree: ${name} proof withheld because ${proofWithheldReason}.`);
  } else if (classification === 'pass') {
    const shaAfter = headShaAfterGate(wtPath);
    const envAfter = gateEnvHashAt(
      wtPath,
      entry.passCacheGate,
      'DW_FAKE_LAND_GATE_ENV_HASH_AFTER_GATE',
    );
    if (shaAfter === shaBefore && envAfter === envBefore) {
      recordLandGateProven(registries, state, wtPath, name, { sha: shaBefore, envHash: envBefore });
      proofRecorded = true;
    } else {
      proofWithheldReason =
        shaAfter === shaBefore
          ? `an untracked gate input (${gateEnvUncacheableFiles(entry.passCacheGate).join(', ')}) ` +
            `changed under the gate (${shortEnvHash(envBefore)} -> ${shortEnvHash(envAfter)})`
          : `HEAD moved under the gate (${String(shaBefore).slice(0, 9)} -> ${String(shaAfter).slice(0, 9)})`;
      console.log(
        `done-worktree: ${name} proof withheld because ${proofWithheldReason} — plan 3503, ` +
          `gpt-review round 3.`,
      );
    }
  }

  // 10. seam emission and exit code — taken from the ENTRY's own declared `seams` metadata
  // (registry.mjs's own note on this field), never a hardcoded SEAM/EXIT link, WHEN an entry
  // actually reaches the registry with `seams` populated. `emitSeam` itself resolves the exit code
  // from the host's SEAM/EXIT enum, keyed by the code named here — this plan leaves that enum in
  // place and only removes the by-hand link to it.
  //
  // THIS STEP IS NOW UNIVERSAL for any entry declaring `seams`, not opt-in: the core roster
  // builder between an entry's registration site and this registry relays every optional field
  // this registry recognizes onto the entry it builds, `seams` included, so a registered entry's
  // own `seams` map reaches here exactly as declared. Three other gates have not migrated their
  // own call-site seam emission onto this shared step yet, and for those an absent `seams` stays
  // silent here — the call site still does the emitting for them. A declared-but-incomplete map
  // is different: that is a real bug in the entry, never a "not migrated yet" signal, which is
  // exactly why it throws below while an absent `seams` does not.
  if (entry.seams) {
    if (classification === 'chunked' || classification === 'starved') {
      const code = entry.seams[classification];
      if (!code) {
        throw new Error(
          `done-worktree: prepGates entry "${name}" (${entry.where}) went ${classification} but ` +
            `declares no seams.${classification}`,
        );
      }
      D.spine.emitSeam(code, result.detail, state);
    } else if (classification === 'failed') {
      if (!entry.seams.failed) {
        throw new Error(
          `done-worktree: prepGates entry "${name}" (${entry.where}) FAILED but declares no ` +
            `seams.failed`,
        );
      }
      D.spine.emitSeam(entry.seams.failed, result.detail, state);
    }
  }

  return {
    applicable: true,
    provenSkip: false,
    classification,
    result,
    proofRecorded,
    proofWithheldReason,
  };
}

/**
 * Run the preflight-stage prepGates, in registry order, by executing each entry's own `step`
 * (plan 4056, the gate fold). The ONE thing that was blocking a generic spine: before this, the
 * preflight phase called five gate steps and one non-gate step BY NAME, all of them project
 * functions, so the phase could not move under scripts/coord/ however generic the rest of it read
 * (Rule 3, docs/coord/scripts-layout.md).
 *
 * WHAT THE DRIVER DECIDES, and it is exactly one thing: what an entry's `step` receives as its
 * second argument.
 *
 *   lifecycle: 'generic' — a prepared runner, already closed over this registry and this entry's
 *                          name. The step calls it with its own `{ wtPath, diff, state, opts }`
 *                          and reads the outcome (`applicable`, `classification`, `result`).
 *   lifecycle: 'custom'  — `null`. The gate owns its whole protocol; plan 4042's D-M14 measured
 *                          what the shared lifecycle would need to absorb a fixed multi-way
 *                          outcome precedence plus a partial-proof recording, and ruled those
 *                          hooks out. A step handed `null` is being told so, rather than being
 *                          left to know it.
 *
 * The declaration is therefore LOAD-BEARING rather than a label: it selects what the step is
 * handed, and a test can drive both arms. It is also what lets a `generic` step stop naming the
 * registry and its own gate name — the coupling this fold exists to delete, one level down from
 * the phase.
 *
 * WHAT THE DRIVER DOES NOT DECIDE: applicability, the resume/fast-path guard, and each gate's
 * options bag all stay inside the step, exactly where they are today. Hoisting the guards into
 * `applies` would put resume state into a predicate the `--prep` pre-pass also evaluates, on a ctx
 * that carries none of it.
 *
 * `ctx` is the whole preflight ctx, built once and shared by every step — the same shape (and the
 * same reason) as the seam driver's: no step may be handed a narrower view of the land than its
 * siblings, and each projects what it needs out of it.
 *
 * THE INTERLUDE. One project step is not a gate and still has a fixed position among them: a
 * pre-build filesystem prune whose churn must land before the build gate's proof window opens.
 * The host declares it as `D.spine.preflightInterlude = { order, run(ctx) }` and this driver runs
 * it when the ordered walk first crosses that `order` (flushed after the loop if it never does),
 * so the POSITION is declared by whoever owns the step rather than by the core naming a gate.
 * Deliberately not a registry entry: it proves nothing, banks nothing, and joining `prepGates`
 * would put a name that never proves anything into the once-per-land proof roster. Deliberately
 * singular: exactly one exists, and a field arrives with its adopter (D-M14).
 *
 * Returns the entry names it ran, in order, so a caller can assert coverage.
 */
export async function runPreflightGates(registries, ctx) {
  const D = landDeps();
  const gates = registries.prepGates.filter((g) => prepGateStage(g) === 'preflight');
  const interlude = D.spine.preflightInterlude ?? null;
  // Validated BEFORE the walk, and loudly, for the same reason registry.mjs validates an entry:
  // a non-numeric `order` would make every `order > before` comparison `undefined > n` — false —
  // so the interlude would silently run ahead of the FIRST gate instead of at its declared
  // position, which for a filesystem prune means running under a gate's proof window rather than
  // before it. That is a behaviour change with no symptom, which is the class this module refuses.
  if (interlude) {
    if (!Number.isFinite(interlude.order) || typeof interlude.run !== 'function') {
      throw new Error(
        `preflight driver: spine.preflightInterlude must be { order: <finite number>, ` +
          `run(ctx) } — got order=${JSON.stringify(interlude.order)}, run=${typeof interlude.run}`,
      );
    }
  }
  let interludeDone = false;
  // `before === null` is the post-loop flush: an interlude ordered after every gate still runs.
  // AWAITED, though today's one step is synchronous: this driver is async, so an async interlude
  // that was merely called would have the next gate start underneath it — the precise hazard the
  // interlude's own position exists to prevent.
  const runInterludeBefore = async (before) => {
    if (interludeDone || !interlude) return;
    if (before !== null && interlude.order > before) return;
    interludeDone = true;
    await interlude.run(ctx);
  };

  const ran = [];
  for (const entry of gates) {
    await runInterludeBefore(entry.order);
    const lifecycle =
      entry.lifecycle === 'generic'
        ? (lifecycleCtx) => runPrepGateLifecycle(registries, entry.name, lifecycleCtx)
        : null;
    await entry.step(ctx, lifecycle);
    ran.push(entry.name);
  }
  await runInterludeBefore(null);
  return ran;
}

// The paths under any of `prefixes` that changed between the proven tree and HEAD (an empty /
// omitted list means EVERY path — the shape the build and UI-gate closure check below needs). `null`
// means "could not compute" — the caller must then fall through to the ordinary (full) gate rather
// than guess. DRY hook: DW_FAKE_LAND_GATE_DELTA is a comma-separated path list.
//
// `prefixes` is a LIST because one heavy gate's surface is not one tree: its own file-selector
// script maps both its primary source root and a configured second data root (plan 3295 R2 → a
// small always-run subset for that root), and filtering to the primary root alone handed the
// selector an empty list for a remainder confined to that second root, so the small subset never
// ran (gpt-review findings 3f34c2 / 511472 / 20bde5 / af0705 / 980215 / 5da098).
export function landGateDeltaPaths(wtPath, sinceSha, prefixes = []) {
  const D = landDeps();
  const list = (Array.isArray(prefixes) ? prefixes : [prefixes]).filter(Boolean);
  const underAny = (p) => list.length === 0 || list.some((x) => p === x || p.startsWith(`${x}/`));
  if (D.env.DRY) {
    // DW_FAKE_LAND_GATE_DELTA_UNCOMPUTABLE forces the `null` arm (a rewritten history, a pruned
    // sha) so the fail-safe — every caller falls back to the FULL gate — is provable from a dry run
    // instead of only being asserted about by reading this file.
    if (process.env.DW_FAKE_LAND_GATE_DELTA_UNCOMPUTABLE === '1') return null;
    const raw = process.env.DW_FAKE_LAND_GATE_DELTA;
    if (raw === undefined) return [];
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && underAny(s));
  }
  try {
    return D.spawn
      .run('git', [
        '-C',
        wtPath,
        'diff',
        '--name-only',
        `${sinceSha}..HEAD`,
        '--',
        ...(list.length ? list : []),
      ])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

// plan 3422 D6: the paths THIS BRANCH owns, relative to the master baseline it currently sits on
// (`git diff <merge-base(HEAD, origin/master)>..HEAD`). Everything else in a since-proof delta is
// master-sourced — a sibling's already-gated land the branch merely took on board. See
// `branchOwnedRemainder` in done-worktree-lib.mjs for the full rule and its case analysis.
//
// `null` on ANY failure (no origin/master, a merge-base that cannot be resolved, a git error), so
// the intersection degrades to "keep the whole delta" — the wider, safe direction.
function landGateBranchOwnedPaths(wtPath, prefixes = []) {
  const D = landDeps();
  const list = (Array.isArray(prefixes) ? prefixes : [prefixes]).filter(Boolean);
  if (D.env.DRY) {
    if (process.env.DW_FAKE_LAND_GATE_BRANCH_OWNED_UNCOMPUTABLE === '1') return null;
    const raw = process.env.DW_FAKE_LAND_GATE_BRANCH_OWNED;
    if (raw === undefined) return null;
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  try {
    const base = D.spawn.run('git', ['-C', wtPath, 'merge-base', 'HEAD', 'origin/master']).trim();
    if (!base) return null;
    // The `<sha>..HEAD --name-only` read itself is landGateDeltaPaths' job — reused rather than a
    // second copy of the same git invocation and output parsing (gpt-review 1079b1). Only the
    // BASELINE differs: the proof sha there, the current master merge-base here.
    return landGateDeltaPaths(wtPath, base, list);
  } catch {
    return null;
  }
}

// plan 3422 D6: the once-per-land remainder, narrowed to what the BRANCH owns. This is the one
// choke point every diff-scoped consumer goes through; `onceProvenClosureSkip` (build / a project's own UI gate)
// deliberately stays on the raw `landGateDeltaPaths` — see branchOwnedRemainder's SCOPE note.
// Narrates only when the narrowing actually removed something, so a land with no sibling churn
// reads exactly as it did before this plan.
export function landGateRemainderPaths(wtPath, sinceSha, prefixes, { label = 'gate' } = {}) {
  const D = landDeps();
  const proofDelta = landGateDeltaPaths(wtPath, sinceSha, prefixes);
  if (proofDelta === null) return null;
  const owned = landGateBranchOwnedPaths(wtPath, prefixes);
  const remainder = D.L.branchOwnedRemainder(proofDelta, owned);
  if (owned === null && proofDelta.length) {
    console.log(
      `done-worktree: once-per-land: could not attribute the ${label} remainder to branch-vs-master — ` +
        `keeping all ${proofDelta.length} path(s) (plan 3422 D6, fail-safe)`,
    );
    return proofDelta;
  }
  if (remainder.length < proofDelta.length) {
    console.log(
      `done-worktree: once-per-land: ${label} remainder since ${String(sinceSha).slice(0, 7)} is ` +
        `${remainder.length} branch-owned path(s); ${proofDelta.length - remainder.length} ` +
        `master-sourced path(s) from concurrently-landed siblings excluded — their content landed ` +
        `green through its own land's gates (plan 3422 D6)`,
    );
  }
  return remainder;
}

// ── plan 3961 T3.5 (Zone D): the scripts-battery gate internals, the build and prettier
// gates, and the chunk-round scoring machinery ─────────────────────────────────────────
const BATTERY_NONCONVERGENT_REMEDY =
  'split the file so no single one exceeds the chunk wall, or fix the hotspot that makes it ' +
  'slow (there is no `slow` marker for the node battery — the split IS the remedy)';

// Resolved against THIS file's own directory (not the main checkout) so the cache
// CLI always matches the spine version actually executing — and so that a checkout
// predating plan 2462 simply has no such file, the spawn fails, and every preflight
// runs exactly as before.
//
// plan 3961 T3.5c: every *_CLI constant below (this one and its four siblings further down)
// spawns a sibling scripts/*.mjs CLI. In the spine each was a bare `${import.meta.dirname}/…`,
// because the spine lives directly in scripts/; this module lives two directories deeper
// (scripts/coord/land/), so a bare `${import.meta.dirname}/…` here would silently resolve to a
// non-existent scripts/coord/land/<file>. SCRIPTS_DIR strips that `/coord/land` suffix back off —
// the "whichever checkout this file loaded from" semantics every one of these constants' own
// comments describes is unchanged (gates-runner.mjs is always imported by done-worktree.mjs from
// the SAME checkout, so this still climbs to that same checkout's scripts/) — rather than a plain
// `${import.meta.dirname}/../../` climb, which resolves identically on disk but leaves a literal
// "../../" in the string, and several DRY-trace golden fixtures print these constants verbatim.
const SCRIPTS_DIR = import.meta.dirname.replace(/[\\/]coord[\\/]land$/, '');

// The checkout that owns THIS MODULE — the root its own coord.config.json sits at. Code and
// configuration are siblings in one tree and version together, so a step whose DEFINITION is
// configuration (land.buildCommand) reads it from here rather than from resolveMain(): the two
// are the same path in every production land, and where they differ (a worktree running its own
// copy of the spine) the branch's own declared command is the honest answer.
const COORD_CONFIG_ROOT = joinPath(SCRIPTS_DIR, '..');

const GATE_CACHE_CLI = `${SCRIPTS_DIR}/gate-pass-cache.mjs`;

// plan 4071 T4/D5: the gate registry is caller-injected (`D.gatePassCache.gatesFrom(config)`),
// never a module-level GATES.
//
// plan 4071 review round 1 (finding 16cb17): memoized per BOUND CONTAINER, not resolved fresh on
// every call. `onceProvenClosureSkip` and `gateEnvUncacheableFiles` (its own `envHash` log-message
// branch included) can each call this several times across the gates a single land preflight
// checks, and every call used to re-read + re-parse coord.config.json and re-normalize the whole
// registry from scratch — a synchronous disk read plus a registry clone per lookup, in a land's
// hot path. `D` (from `landDeps()`) is bound exactly ONCE per process (see deps.mjs's own
// `bindLandDeps`/`landDeps` docs) and is the SAME frozen reference for the life of a land, so a
// WeakMap keyed on `D` resolves this exactly once per land and reuses it thereafter — without
// reintroducing module-load self-resolution (nothing runs until the first real call) and without
// changing WHICH checkout it reads (still `COORD_CONFIG_ROOT`, still resolved through `D`). A test
// file that binds its own fake `D` (deps.mjs refuses a second real bind, but a fresh test process
// or a fresh fake object is a different key) gets its own independent cache entry, so this never
// leaks a stale registry across differently-configured containers.
const gateRegistryByDeps = new WeakMap();
function resolveGateRegistry(D) {
  if (!gateRegistryByDeps.has(D)) {
    gateRegistryByDeps.set(
      D,
      D.gatePassCache.gatesFrom(D.coordConfig.loadCoordConfig(COORD_CONFIG_ROOT)),
    );
  }
  return gateRegistryByDeps.get(D);
}

// Decide whether one of the two heavy suites owes only a DIFF-SCOPED selection this invocation,
// and against WHICH path set. `null` ⇒ run the gate exactly as before this plan.
//
// Two independent triggers, checked in this order:
//   1. ONCE-PER-LAND (E2). The suite already went green in this land, so only what changed since
//      that proven tree is unproven. A delta that cannot be computed (a rewritten history, a
//      pruned sha) falls back to the FULL gate — doubt always runs more, never less.
//   2. `landGate: selective` (E5). The plan opted the whole land into the diff-scoped tier, so the
//      selection is the land diff itself (the branch vs origin/master — the `changed` list every
//      other gate already keys on).
// Trigger 1 wins when both apply: its baseline is strictly newer, so its path set is a subset.
//
// `prefixes` is the gate's SURFACE — every tree the gate's selector can map, not just its primary
// one. A sibling per-file gate can have MORE than one such tree (its code subtree AND a
// configured non-code data root): a data-only remainder still reaches that gate's own
// narrow-subset selector (core-noun-ok: the illustrative file/const names belong to the sibling
// gate's own module, not this one, and naming them is the precise cross-reference) instead of
// nothing. That supersedes E2's parenthetical "a data-only or docs-only delta runs nothing" —
// docs-only still runs nothing, data-only now runs that gate's own cheap narrow subset.
// The `kind` tag distinguishes the TWO callers that produce a "diff-scoped" selection so the
// consumer can react to a FULL selector verdict correctly (plan 3335, 2026-08-20 incident):
//   'remainder' — the once-per-land (E2) skip triggered. The suite went green in this land at a
//                 baseline sha, and only what changed since THAT sha is unproven. A FULL verdict on
//                 this remainder means the proof does not cover it, so the consumer MUST fall
//                 through to a real full run — otherwise the empty subset stamps the gate green
//                 over an untested remainder (the 2026-08-20 posture reversal).
//   'selective' — the plan is stamped `landGate: selective` (E5). That tier's contract is "never
//                 the full suite, ever" by construction — a FULL verdict here stays the ruled "run
//                 nothing" posture; the 2026-08-20 incident did not falsify that arm.
export function scopedGateSelection(
  state,
  wtPath,
  changed,
  { gate, prefixes, label, unprovenFiles, defaultScoped = false },
) {
  const D = landDeps();
  const proven = onceProvenSkip(state, gate);
  if (proven) {
    // plan 4003 T4: a PARTIAL proof composes with the remainder rather than replacing it. The
    // remainder machinery below already answers "what changed since the proven tree"; a partial
    // proof adds the orthogonal half — "what this gate's own universe never got to at all". The
    // union is what has to run, and it is threaded out as `extraTests` (test files, already in the
    // gate's own vocabulary) alongside `paths` (changed paths, which still go through the gate's
    // selector). NOT a second cache beside `gatesProven` — the same entry, read one level deeper,
    // which is the drift plan 3335 paid for once already.
    //
    // `unprovenFiles` is the gate's own resolver (only the battery has one; the sibling gate's per-file
    // vocabulary belongs to `_gate_ledger.py` and is out of this plan's scope). `null` from it, or
    // no resolver at all, means "nothing extra" and every branch below behaves exactly as before.
    //
    // gpt-review r4 (82beb3/00e360/eac157/e14c99 — four finders): "this gate has no per-file
    // resolver at all" and "the resolver ran and could not read the universe" are DIFFERENT facts,
    // and r3 collapsed both into `null`. Only the second is an unknown worth overriding a tier for;
    // the first is the sibling gate's ordinary shape (its per-file vocabulary lives in
    // `_gate_ledger.py` and is out of this plan's scope), and forcing a full suite for it would be
    // a skip-refusal aimed at a gate that never claimed to have one. `hasResolver` separates them.
    const hasResolver = D.L.isPartialGateProof(proven) && typeof unprovenFiles === 'function';
    const extra = hasResolver ? unprovenFiles(proven) : undefined;
    const extraTests = Array.isArray(extra) && extra.length ? extra : null;
    const universeUnreadable = hasResolver && extra === null;
    const isSelectiveTier = state.landGate === 'selective';
    // gpt-review r1 (529902/7efdd1/5d5f67/27432b/c9906a/8df841/2e5818 — seven finders, one defect):
    // a PARTIAL proof with no usable remainder must not fall through into the branches below, every
    // one of which can end in a SKIP. Two distinct states reach here and BOTH did:
    //   · `null` — the universe could not be read at all, so nothing is known. Skipping on that is
    //     unsound outright.
    //   · `[]` — every file in the CURRENT universe is named in the proof. Sound-looking, but it
    //     would make a partial entry authorize exactly the skip this plan's own invariant says it
    //     never does, on a path no test covers.
    // One rule, no case analysis: a partial proof ALWAYS runs something. `null` here sends the
    // caller to the full cached preflight — the wider answer, which the ledger then narrows on its
    // own terms — rather than to a skip.
    //
    // gpt-review r2 (4fbfc2/4991a0/07f446/ae24e8 — four finders): this fail-safe is SCOPED TO THE
    // DEFAULT TIER. `null` here means "run the full gate", and on a plan stamped
    // `landGate: selective` that is precisely the one thing the tier forbids — an operator opt-in
    // that predates this plan and that the r1 fix would have overridden on a path nobody asked for.
    // A selective plan falls through to the tier's own branches below instead, where the proof
    // still narrows the scope; it simply never buys the full suite to recover from a partial proof
    // it cannot use. Said plainly, because it IS a hole in the invariant one tier wide: on a
    // selective plan a partial proof with no usable remainder can end in an empty selection and run
    // nothing. That is the tier's own ruled posture for an empty diff-scoped selection (plan 3335),
    // backstopped by the daily full-suite cloud routine — not a new licence this plan adds.
    //
    // gpt-review r3 (b989ff/c887dc/cbc135 — three finders) split what r2 had merged. The two states
    // are NOT equally safe and the tier does not answer them the same way:
    //
    //   · `[]` — every file in the current universe is named in the proof, so there IS nothing
    //     unproven. A selective plan may honour its tier here; nothing is at risk either way. (The
    //     default tier still buys the full gate: over-conservative, and cheap enough to keep the
    //     "a partial proof always runs something" invariant absolute where it costs nothing.)
    //   · `null` — the universe could not be read, so what is unproven is UNKNOWN. r2 let this fall
    //     into the selective branch, where an empty selection then ran nothing and the land
    //     proceeded over a killed run's unproven files. The tier is an opt-in to trusting a
    //     diff-scoped selection, never a licence to land what nothing has looked at, so it is
    //     overridden here — loudly, and only for this one state.
    if (hasResolver && !extraTests && (universeUnreadable || !isSelectiveTier)) {
      const why = universeUnreadable
        ? `the gate universe could not be read, so what the killed run left unproven is UNKNOWN`
        : `every current file is already named in the proof`;
      const tierNote =
        universeUnreadable && isSelectiveTier
          ? ' — landGate: selective is deliberately overridden for this one state (gpt-review r3): ' +
            'the tier trusts a diff-scoped selection, it does not authorize landing what nothing ran'
          : '';
      console.log(
        `done-worktree: once-per-land: ${gate} has a PARTIAL proof at ${proven.sha.slice(0, 7)} but ` +
          `no usable remainder could be derived from it (${why}) — running the full ${label} ` +
          `rather than skipping on a partial proof (plan 4003 T4)${tierNote}`,
      );
      return null;
    }
    if (extraTests) {
      console.log(
        `done-worktree: once-per-land: ${gate} composes its partial proof with the remainder — ` +
          `${extraTests.length} file(s) the killed run never proved, plus whatever changed since ` +
          `${proven.sha.slice(0, 7)} (plan 4003 T4)`,
      );
    }
    // plan 3335 review round 2 (gpt-review d60a3c/69c873/d84e59/83a917 — CONFIRMED across four
    // angles): the E5 selective-tier guard runs BEFORE the delta-null fallthrough, not after.
    // The uncomputable-delta arm below returns `null` — which the caller reads as "no scoped
    // selection", falling through to the FULL cached preflight — but on a `landGate: selective`
    // plan the tier's whole contract is "never the full suite, ever" (an operator opt-in,
    // pre-existing this plan). Preserve that contract on the uncomputable arm too: on a
    // selective plan, the paths are the branch's diff (the E5 tier's own baseline, computed
    // below when no proof exists) rather than a remainder we cannot narrow.
    if (state.landGate === 'selective') {
      // plan 3335 review r3 (gpt-review 8d6c45, CONFIRMED): tier wins over the proof BUT the proof
      // still narrows the scope — CLAUDE.md's own rule is "the two suites run the diff-scoped
      // REMAINDER since the proven sha". The pre-r3 draft filtered `changed` (the whole branch
      // diff) unconditionally, discarding the remainder narrowing for selective plans — a real
      // regression against the pre-plan behaviour on the computable arm. Compose them: prefer the
      // proof-tree delta when computable, keep 'selective' as the kind so the FULL-verdict caller
      // still runs nothing (never falls through to a full run), fall back to the branch diff only
      // when the delta is uncomputable.
      const proofDelta = landGateRemainderPaths(wtPath, proven.sha, prefixes, { label: gate });
      if (proofDelta !== null) {
        console.log(
          `done-worktree: landGate: selective — ${gate} runs the diff-scoped REMAINDER since ` +
            `${proven.sha.slice(0, 7)} (${proofDelta.length} path(s)), never the full suite ` +
            `(plan 3295 / plan 3335 review r3: the tier's opt-in and the proof compose — ` +
            `remainder-since-proof narrows further, tier keeps the "never full suite" invariant).`,
        );
        return {
          kind: 'selective',
          paths: proofDelta,
          reason: `landGate: selective (remainder since ${proven.sha.slice(0, 7)})`,
          extraTests,
        };
      }
      // Uncomputable delta on a selective plan: can't fall back to the full suite (tier opt-in),
      // so widen to the branch's diff-scoped selection — the E5 tier's own baseline when no proof
      // applies. Every LOCAL-branch narration for E5 goes through this same shape.
      const branchPaths = changed.filter((p) =>
        prefixes.some((x) => p === x || p.startsWith(`${x}/`)),
      );
      console.log(
        `done-worktree: landGate: selective — could not compute the remainder since ` +
          `${proven.sha.slice(0, 7)} (rewritten history / pruned sha), falling back to the ` +
          `branch's diff-scoped selection of ${branchPaths.length} path(s) rather than the full ` +
          `suite (plan 3335 review r2/r3: the tier decides, not trigger order — the proof's ` +
          `absent baseline never authorizes buying what the tier opts out of).`,
      );
      return {
        kind: 'selective',
        paths: branchPaths,
        reason: `landGate: selective (proof delta uncomputable at ${proven.sha.slice(0, 7)})`,
        extraTests,
      };
    }
    const delta = landGateRemainderPaths(wtPath, proven.sha, prefixes, { label });
    if (delta === null) {
      // plan 4003 T4: unchanged for a partial proof too. Falling through to the FULL gate is the
      // WIDER answer, and a partial proof's whole point is that running more is always allowed —
      // the ledger inside the full preflight still subtracts whatever it can.
      console.log(
        `done-worktree: once-per-land: could not compute the ${prefixes.join(' / ')} delta since ` +
          `${proven.sha.slice(0, 7)} — running the full ${label} (plan 3295, fail-safe)`,
      );
      return null;
    }
    // plan 3335 (gpt-review 799a8e, CONFIRMED): the tier decides the kind, not the trigger order.
    // (This branch is now reached ONLY when the plan is NOT stamped `landGate: selective` — the
    // selective guard above handles that tier for both the delta-computable AND uncomputable
    // arms. The remainder tag applies to ordinary once-per-land plans only.)
    //
    // plan 3827 T5 (2026-09-09, corrected review round 3, F4, CONFIRMED): `delta` above is ALREADY
    // narrowed to this gate's own `prefixes` by `landGateRemainderPaths` → `landGateDeltaPaths`'s own
    // git pathspec — a second `.filter` here re-applying the SAME `prefixes` predicate can never
    // remove anything from an already-scoped list, so it was dead code advertising a capability it
    // did not add (an earlier draft of this comment claimed it did; it does not — do not restore it).
    // An EMPTY `delta` therefore already means the once-per-land proof covers every path that could
    // affect this gate — T5's actual contribution is just the distinct audit line naming that reason
    // on `onceProvenSkip`'s own `console.log` channel, in place of the generic "nothing to re-run for
    // this delta" the caller printed before.
    if (delta.length === 0 && !extraTests) {
      console.log(
        `done-worktree: once-per-land: ${gate} proven green at ${proven.sha.slice(0, 7)} in this ` +
          `land — no path since then is inside its closure, skipped (plan 3827 T5)`,
      );
      return {
        kind: 'remainder',
        paths: [],
        reason: `remainder since ${proven.sha.slice(0, 7)} (no path inside closure)`,
        // plan 3827 fix pass 2 (G3, finding :8220): this branch already narrated the skip above
        // (naming the proving sha) — tells narrateScopedGate's own `selection === 'none'` arm not
        // to print its generic "nothing to re-run for this delta" line for the SAME empty
        // selection right after it.
        provenSkipNarrated: true,
      };
    }
    // plan 4003 T4: with a partial proof this is reachable on an EMPTY `delta` too — nothing
    // changed since the kill, but files the kill never reached still have to run. The empty-and-
    // nothing-extra case above keeps the plan-3827 T5 skip verbatim; this one deliberately does
    // not take it.
    return {
      kind: 'remainder',
      paths: delta,
      reason: extraTests
        ? `remainder since ${proven.sha.slice(0, 7)} + ${extraTests.length} unproven file(s) from a killed run`
        : `remainder since ${proven.sha.slice(0, 7)}`,
      extraTests,
    };
  }
  if (state.landGate !== 'selective') {
    // plan 4004: the battery-only default tier — a LOCAL land's pre-queue battery preflight runs
    // the diff-scoped selection by default now, the way the push-side selector already does,
    // instead of buying the full 282-file battery for a diff that touched three scripts. Opted in
    // ONLY by batteryScopedSelection's `defaultScoped: true` (the sibling heavy gate's own
    // selection helper never passes it, so that gate's tail is byte-identical to before this
    // plan — it is a host module's, and this default is the battery's alone). CLOUD stays on the
    // full battery every land — CLAUDE.md's standing rule — so this tier is LOCAL-only, which is
    // also the whole scope of this plan's title.
    //
    // gpt-review r1 (509b90 / 8de547 / 09131d / b98b9c / e46383 — five finders, one defect): the
    // cloud test is `landGateIsCloud()` — the land-gate tier's OWN predicate, shared with
    // `landGateProven`'s cloud refusal on this same decision surface — and NOT `L.isCloudLand()`.
    // They disagree: `isCloudLand()` is strict `=== 'true'`, the land-gate one takes ANY non-empty
    // value, which is how this repo's own cloud tests and sandboxes spell the marker (`'1'`).
    // Under `isCloudLand()` a cloud land marked `'1'` was refused the once-per-land skip
    // (correctly, as cloud) and then handed this LOCAL tier (incorrectly), landing after a
    // selected subset instead of the mandatory full battery — and the land's own master push is
    // `--no-verify`, so nothing downstream repairs it. Two cloud predicates on one decision was
    // the bug; r2 (3e2ed2 / 388298) then made the surviving one a single named helper rather than
    // a second copy of its expression.
    if (defaultScoped && !landGateIsCloud()) {
      // gpt-review r1 (96767b, CONFIRMED): the selector gets the WHOLE land diff, NOT the
      // `prefixes`-filtered subset the `landGate: selective` tail below hands it. That is the
      // contract this plan's T1 names — "the same contract the pre-push hook feeds it" — and the
      // hook passes its entire BATTERY_DELTA. `select-battery-tests.mjs` treats paths OUTSIDE
      // `scripts/` as FULL triggers (its EXTERNAL_TREE_PREFIX set: `package.json`, the hook, and
      // the host project's own source and doc trees — files battery tests read from the real
      // tree), so filtering them out first
      // would hide exactly the evidence that forces a full run, and this tier could then select a
      // NARROWER set than the push already did off the identical diff — on the last gate before
      // master. The narration counts the same list the selector receives.
      console.log(
        `done-worktree: ${gate} runs the diff-scoped selection of ${changed.length} changed ` +
          `path(s) vs origin/master by DEFAULT on a local land (plan 4004) — an unselectable diff ` +
          `still falls through to the full ${label}, and the run log says why.`,
      );
      return { kind: 'default', paths: changed, reason: 'diff-scoped by default (plan 4004)' };
    }
    return null;
  }
  const paths = changed.filter((p) => prefixes.some((x) => p === x || p.startsWith(`${x}/`)));
  console.log(
    `done-worktree: landGate: selective — ${gate} runs only the diff-scoped selection of ` +
      `${paths.length} changed path(s) vs origin/master, never the full suite (plan 3295)`,
  );
  return { kind: 'selective', paths, reason: 'landGate: selective' };
}

// plan 4003 T4: the battery's own "what did a killed run never prove" answer. The universe is
// `listScriptsTestFiles` — the SAME list `runFullBatteryPreflight` builds and the same repo-relative
// vocabulary the ledger and the partial proof store — so the subtraction needs no translation
// layer. Recomputed from the CURRENT tree rather than stored, so a test file added since the kill
// is unproven by construction and a deleted one simply disappears.
//
// `null` (not `[]`) whenever the universe cannot be read: an empty list would read as "everything
// is proven" and skip the gate, which is the one answer this must never give.
// Exported for plan 4003 T4's tests: the subtraction is the whole mechanism, and a test that
// re-implemented it would prove only that it agrees with itself.
export function batteryUnprovenFiles(wtPath, entry) {
  const D = landDeps();
  if (!D.L.isPartialGateProof(entry)) return null;
  let universe;
  try {
    universe = D.scriptsBattery.listScriptsTestFiles(wtPath);
  } catch {
    return null;
  }
  if (!Array.isArray(universe) || universe.length === 0) return null;
  // POSIX on BOTH sides. `listScriptsTestFiles` builds its entries with `path.join`, which spells
  // them `scripts\x.test.mjs` on Windows, while every path the ledger reporter records goes
  // through `toPosixRelative` — so a raw comparison would match NOTHING on Windows and hand back
  // the whole universe as "unproven" while claiming to have narrowed it. `node --test` accepts a
  // forward-slash target on Windows, so normalizing is free at the run end too.
  // platform-assert-ok: normalizes rather than branching — correct on both platforms by construction.
  //
  // gpt-review r1 (1901ef): the subtraction itself is the ledger's own `remainingSelection`.
  const proven = new Set(entry.provenFiles.map(D.spine.toPosixPath));
  return D.batteryLedger.remainingSelection(universe.map(D.spine.toPosixPath), proven);
}

export const batteryScopedSelection = (state, wtPath, changed) =>
  scopedGateSelection(state, wtPath, changed, {
    gate: 'scripts-battery',
    prefixes: ['scripts'],
    label: 'scripts battery preflight',
    unprovenFiles: (entry) => batteryUnprovenFiles(wtPath, entry),
    // plan 4004: the ONLY caller that opts into the new battery-only default tier — see
    // scopedGateSelection's own tail comment for the local/cloud split.
    defaultScoped: true,
  });

// One narration for both scoped gates. The no-run outcomes are the ones worth being loud
// about, and they are NOT the same thing (gpt-review findings c7aad1 / f49c77; plan 3335 split
// on the 2026-08-20 incident):
//
//   `full` + kind='remainder'  — a HEALTHY selector said "this remainder cannot be narrowed"
//                                 (e.g. a root-level `_*.py` shared helper is in the remainder,
//                                 which triggers _select_tests.py's FULL-without-walking arm).
//                                 The proof does NOT cover this remainder, so the caller MUST
//                                 fall through to a real full run — plan 3335 reverses the
//                                 empty-subset-stamps-green posture on the 2026-08-20 incident
//                                 (23 red tests shipped to master, ~2h red, two blocked lands).
//   `full` + kind='selective'  — the plan opted the whole land into the E5 diff-scoped tier,
//                                 whose contract is "never the full suite, ever" by construction.
//                                 The 2026-08-20 incident did not falsify that arm, so nothing
//                                 runs and the daily full-suite cloud routine remains the backstop.
//                                 This is the ruled posture for E5 ONLY.
//   `selector-failed`          — the selector itself did not run (python missing, import error,
//                                 timeout, non-zero exit). That is not a verdict about the delta
//                                 and can never authorize skipping: the caller falls back to the
//                                 gate exactly as it would behave without this plan — the FULL
//                                 cached preflight — the same fail-safe `landGateDeltaPaths`
//                                 applies to an uncomputable delta and `pre-push.sh` applies to
//                                 its own selector ("FULL selector failed (treating as
//                                 full-suite)").
export function narrateScopedGate(state, label, scoped, sel) {
  const D = landDeps();
  if (sel.selection === 'none') {
    // plan 3827 fix pass 2 (G3, finding :8220): the T5 once-per-land-closure skip in
    // scopedGateSelection already printed its own line naming the proving sha for this exact
    // empty selection — printing the generic line too is two lines for one event. Suppress ONLY
    // for that branch (`scoped.provenSkipNarrated`); every other `selection === 'none'` case
    // (e.g. an ordinary `landGate: selective` empty selection) is unaffected.
    if (scoped.provenSkipNarrated) return;
    D.spine.stepLog(
      state,
      `${label}: nothing to re-run for this delta (${scoped.reason}) — skipped`,
    );
    return;
  }
  if (sel.selection === 'selector-failed') {
    console.log(
      `done-worktree: ${label}: the SELECTOR ITSELF FAILED for ${scoped.paths.length} path(s) ` +
        `(${scoped.reason}) — no selection could be computed, so this gate falls back to the FULL ` +
        `run (plan 3295, fail-safe: a selector crash never authorizes a skip). Selector said: ` +
        `${sel.detail || 'n/a'}`,
    );
    return;
  }
  if (sel.selection === 'full') {
    if (scoped.kind === 'remainder') {
      console.log(
        `done-worktree: ${label}: the selector returned FULL for ` +
          `${scoped.paths.length} path(s) (${scoped.reason}) — the once-per-land proof does NOT ` +
          `cover this remainder (plan 3335, reversing the earlier empty-subset-stamps-green ` +
          `posture on the 2026-08-20 incident: 23 red tests shipped to master, ~2h red, two ` +
          `blocked lands). Falling through to the FULL cached preflight. Selector said: ` +
          `${sel.detail || 'n/a'}`,
      );
      return;
    }
    if (scoped.kind === 'default') {
      // plan 4004: the default battery-only tier's own FULL arm — must NOT reach the E5 "nothing
      // ran" line just below, which would be a lie here: the full cached preflight runs right
      // after this narration (the caller's `runFullBattery = true`, mirroring the 'remainder' arm
      // above), so an unselectable diff still runs the full battery and the run log says why.
      console.log(
        `done-worktree: ${label}: the selector returned FULL for ` +
          `${scoped.paths.length} path(s) (${scoped.reason}) — an unselectable diff still runs the ` +
          `FULL cached preflight (plan 4004: the local land's default diff-scoped tier falls ` +
          `through here exactly as the once-per-land remainder arm does above). Selector said: ` +
          `${sel.detail || 'n/a'}`,
      );
      return;
    }
    console.log(
      `done-worktree: ${label}: the selector returned FULL for ` +
        `${scoped.paths.length} path(s) (${scoped.reason}) — landGate: selective opts this land ` +
        `out of the full suite by construction, so nothing ran (plan 3295; the daily full-suite ` +
        `cloud routine is the backstop). Selector said: ${sel.detail || 'n/a'}`,
    );
    return;
  }
  if (sel.ok) D.spine.stepLog(state, `${label}: diff-scoped selection passed (${sel.ran} file(s))`);
}

// ── plan 3827: the scripts-battery isolation recheck — the battery twin of the sibling gate's isolation
// recheck immediately above (plan 3422 D2) ──────────────────────────────────────────────────
//
// The battery preflight had no isolate-and-retry at all until this plan, even though its own load
// flake is the SAME measured class as the sibling gate's (plan 2853: four consecutive full battery runs
// under parallel-session load went red with a DIFFERENT failing set each time, every one green
// alone). The 2026-09-08 plan-3732 land (branch
// worktree-3548-FABLE-Pipe-price-v3-fork-backtest-baseline-optionb-read2-bakeoff — core-noun-ok:
// cites the actual historical branch name of the incident) is the measured
// incident this plan exists to fix: BATTERY_FAILED on one project test file
// (`true !== false`) and another project test file's isolated temp-repo `git checkout`
// failing under load — both green alone, 199/199, moments later.
//
// plan 3827 operator ruling R1 (2026-09-09): the branch's original approach — reconstructing the
// failing-file set from `node --test`'s own TAP/spec TEXT output via three overlapping grammars
// (`SPEC_FAILING_TEST_AT_RE`, `BATTERY_STACK_FRAME_RE`, and `parseNodeTestFailures`) — is DELETED,
// not fixed. Seven review rounds each closed one localization hole and opened another (finding
// `0910d6`: an indented stack frame "localized" a real failure onto an unrelated file, so the
// recheck re-ran the wrong file, passed, and the land proceeded over a genuine failure — a FALSE
// HEAL through a fail-closed gate). The structural cause was three inconsistent grammars feeding
// one computation; patching one more regex moves the defect, it does not remove it. The fix that
// ends the class: the failing file arrives as a FIELD off node's own structured test-event stream
// (`event.data.file`, via the SAME reporter/parser pair the sibling gate's ledger half already uses —
// `REPORTER_SPECIFIER`/`parseLedgerEvents`/`toPosixRelative`, imported above), so `0910d6` and
// every sibling "which grammar do we trust" finding become UNREPRESENTABLE rather than merely
// harder to trigger.
const BATTERY_ISOLATION_TIMEOUT_MS = 10 * 60 * 1000; // mirrors the sibling gate's own isolation timeout above (core-noun-ok: PYTEST_ISOLATION_TIMEOUT_MS is that module's own constant name)

// The cap. Mirrors the sibling gate's own isolation-cap constant (10) exactly, for the same reason: a load flake
// (core-noun-ok: RLT.PYTEST_ISOLATION_MAX_FILES is that module's own name, cited for the exact cross-reference)
// under the parallel-session herd hits a handful of files; more than that is a real break, not a
// herd-flake shape, and past the cap the caller BLOCKS without a recheck.
// Exported (mirrors the sibling gate's own isolation-cap testability via run-land-tests.test.mjs) so
// (core-noun-ok: PYTEST_ISOLATION_MAX_FILES is that module's own constant name)
// the cap is directly unit-testable without a subprocess DRY run.
export const BATTERY_ISOLATION_MAX_FILES = 10;

// plan 3827 review round 1 (Fix C, CONFIRMED): matches ANY nested `.../scripts/x.test.mjs` — a
// node_modules copy, or a path from an entirely different checkout, is indistinguishable from this
// worktree's own file once the suffix shape matches. Used both by `batteryFailureReportFromEvents`
// below (to keep only the reporter's own events that name a real battery file) and by
// `filterToKnownBatteryFiles` further down (to normalize the worktree's own glob into the same
// POSIX convention before comparing).
// plan 3971 (land-time fix-now): the battery's target list comes from `listTestFiles`, which
// WALKS scripts/ (scripts/coord/*, scripts/fb-responder/*, scripts/lib/**), so a battery file may
// sit in a subdirectory. The old flat `scripts/<name>.test.mjs` shape normalized every nested
// target to null, which `batteryFailureReportFromEvents` counted as "never reported a terminal
// event" — so `complete` was false on EVERY full battery and the isolation recheck could never
// run: one load-flake in any file blocked the land with no self-heal (three consecutive 3971
// lands, each red on a different file that passed alone). Nested segments are accepted; a
// node_modules segment is still refused.
function normalizeBatteryTestFile(raw) {
  const posix = String(raw || '')
    .trim()
    .replace(/\\/g, '/');
  if (/(?:^|\/)node_modules\//.test(posix)) return null;
  const m = /(?:^|\/)(scripts\/(?:[^/]+\/)*[^/]+\.test\.mjs)$/.exec(posix);
  return m ? m[1] : null;
}

// plan 3827 operator ruling R1: the structured-reporter twin of the three text grammars deleted
// above (2026-09-09) — `SPEC_FAILING_TEST_AT_RE`, `BATTERY_STACK_FRAME_RE`, and this gate's use of
// `parseNodeTestFailures`. Those grammars reconstructed a failing file from prose; this reads it
// off the reporter's own per-file JSONL event (`{"file":"<abs path>","passed":<bool>}`, emitted by
// `scripts/battery-ledger-reporter.mjs`, one line per COMPLETED test file), via the same
// `parseLedgerEvents`/`toPosixRelative` pair the sibling gate's ledger half already uses — so the failing
// file arrives as `event.data.file`, a field, not something to reconstruct. Finding `0910d6` (an
// indented stack frame "localizing" a real failure onto an unrelated file) is unrepresentable here:
// there is no stack-frame text for this function to misread in the first place.
//
// `eventsText` is the reporter destination file's content — `''`/null when there is none (no
// reporter ran, or the file could not be read; the caller fails closed in that case, never here).
// `targetFiles` is the list of files THIS run was asked to run — `reported` below is its length,
// `null` when the caller does not know it (an outcome built outside the real seam, e.g. a bare DRY
// hook that never threads one through).
//
// `complete` is the structural completeness proof: node's reporter emits exactly ONE terminal event
// (`passed` or `failed`) per test FILE, never more, never fewer — so "every target file reported a
// terminal event" is proof the failing set is whole. That check is by IDENTITY, not by count (plan
// 3827 review round 3, F1, CONFIRMED across angle-A/angle-C/altitude): a plain `seen >= reported`
// count comparison can reach the target COUNT while a real target reported NOTHING — as long as some
// OTHER, unrequested path reported in its place — so a run that never reported one of its own target
// files could still read as whole. Fixed by checking each requested target's presence in the set of
// files that actually reported (`reportedRel`), never by comparing sizes: `missing` names exactly the
// targets absent from that set, and `complete` is true only when `missing` is empty. Both the target
// vocabulary and the reporter vocabulary route through the SAME `normalizeBatteryTestFile` grammar
// (also folds in F3 — this function no longer hand-rolls its own copy of that regex), so the two
// sides cannot silently disagree on what counts as a name. A run killed mid-battery (a timeout, a
// tree-kill escalation) is SHORT on events for exactly the files it never reached, so it reads as
// incomplete and refuses — the correct, conservative outcome — rather than healing on whatever
// partial set it happened to observe.
// plan 4003, gpt-review r3 (22050f) / r4 (216436 + four finders): `events` is an OPTIONAL
// already-parsed stream. Every pre-4003 caller omits it and gets the identical parse this function
// always did; a caller that ALSO needs the raw passed/failed sets (the scoped arm, for its partial
// proof) parses once and hands the result to both consumers.
//
// The r3 round added the ARGUMENT at the call site and — through an edit that silently did not
// apply — never added this PARAMETER, so the argument was dropped, the stream was parsed twice
// anyway, and the comment claiming otherwise was simply false. Five finders caught it, a sixth
// (51b75f) caught that the test meant to pin the invariant only grepped the caller's own body and
// so could not see the second parse inside here. Both are why the test below now asserts the
// signature, not the call.
export function batteryFailureReportFromEvents(wtPath, eventsText, targetFiles, events = null) {
  const D = landDeps();
  const { passed, failed } = events || D.batteryLedger.parseLedgerEvents(eventsText || '');
  // plan 3827 fix pass 2 (G1, findings :8693/:8702, CONFIRMED across angle-A/angle-B/angle-C): a
  // reporter path OUTSIDE the worktree must never satisfy a target. `toPosixRelative` yields
  // `../../elsewhere/scripts/<name>.test.mjs` for a path outside `wtPath`, and
  // normalizeBatteryTestFile's `(?:^|\/)` suffix match then collapses that to
  // `scripts/<name>.test.mjs` — a foreign checkout's (or a nested node_modules/second worktree's)
  // event would otherwise be credited as this worktree's own target, the false-heal direction this
  // plan exists to close. Containment is enforced HERE, not inside normalizeBatteryTestFile itself
  // — that function's suffix match is deliberately lenient for its OTHER consumer
  // (filterToKnownBatteryFiles), per this plan's own scope note.
  const relInsideWorktree = (abs) => {
    const rel = D.batteryLedger.toPosixRelative(wtPath, abs);
    if (
      !rel ||
      rel === '..' ||
      rel.startsWith('../') ||
      rel.startsWith('/') ||
      /^[A-Za-z]:\//.test(rel)
    ) {
      return null;
    }
    // plan 3989 (gpt-review e3c52e/8f4d2a, CONFIRMED): being inside the worktree is not enough —
    // the event must name a file in the BATTERY's own tree. normalizeBatteryTestFile is a
    // deliberately non-containment-aware SUFFIX match, so an in-worktree path outside `scripts/`
    // normalizes onto the identically-named real target. Plan 3971's fix-now closed the
    // `node_modules/` spelling of that inside normalizeBatteryTestFile, but a sibling source tree
    // is still wide open: an event for a path like `a/b/coord/<name>.test.mjs` collapses to
    // `scripts/coord/<name>.test.mjs`, so `reportedRel` credits the genuine target and `complete`
    // can go true on a run that never touched it — the false-heal plan 3827 closed, re-opened one
    // level deeper by the nested widening. (The test above only ever exercised
    // `a/b/unrelated.py`, which drops on its EXTENSION, not on containment — so the
    // gap read as covered.) Anchoring the RELATIVE path here, never the regex, is the containment
    // half that belongs on this side; filterToKnownBatteryFiles still owns the cross-check against
    // the worktree's actual glob.
    if (!rel.startsWith('scripts/')) return null;
    return normalizeBatteryTestFile(rel);
  };
  const seenFiles = new Set();
  const files = [];
  for (const abs of failed) {
    const rel = relInsideWorktree(abs);
    if (!rel) continue;
    if (seenFiles.has(rel)) continue;
    seenFiles.add(rel);
    files.push(rel);
  }
  files.sort();
  const reportedRel = new Set();
  for (const abs of [...passed, ...failed]) {
    const rel = relInsideWorktree(abs);
    if (rel) reportedRel.add(rel);
  }
  // plan 3827 fix pass 2 (G2, finding :8706, CONFIRMED): fail CLOSED instead of dropping a target
  // that does not normalize. The old `.filter(Boolean)` shrank `reported` on a malformed/unexpected
  // target, so `complete` could go true on a set that never actually covered it. Now every target
  // counts toward `reported` — one that fails to normalize is named, raw, in `missing`, and the
  // existing `missing.length === 0` rule keeps `complete` false through it. Never throws.
  const targets = Array.isArray(targetFiles)
    ? targetFiles.map((f) => ({ raw: f, norm: normalizeBatteryTestFile(f) }))
    : null;
  const reported = targets ? targets.length : null;
  const missing = targets
    ? targets.filter((t) => !t.norm || !reportedRel.has(t.norm)).map((t) => t.norm || t.raw)
    : [];
  const seen = targets ? targets.length - missing.length : 0;
  const complete = reported !== null && reported > 0 && missing.length === 0;
  return { files, complete, seen, reported, missing };
}

// plan 3827 review round 1 (Fix C, CONFIRMED): normalizeBatteryTestFile's regex alone matches ANY
// nested `.../scripts/x.test.mjs` — a node_modules copy, or a path from an entirely different
// checkout, is indistinguishable from this worktree's own file once the suffix shape matches.
// Cross-checked here against THIS worktree's ACTUAL battery glob — listScriptsTestFiles(wtPath),
// the SAME enumerator the real full-battery run elsewhere in this file already uses (plan 2875
// cluster 6) — before the isolation recheck trusts a single one of these event-sourced names.
// Exported for direct unit-test coverage (mirrors batteryFailureReportFromEvents's own testability
// just above): a live wtPath read makes this unsuitable for the --dry-run subprocess harness the rest of the
// isolation-recheck tests use, since DRY's own `wtPath` is the `<dry:slug>` placeholder
// (resolveWorktree's own DRY branch), never a real directory — batteryIsolationRecheck below skips
// this call entirely under DRY for exactly that reason.
//
// plan 3827 review round 2 (P0, CONFIRMED x3): listScriptsTestFiles joins with the PLATFORM'S OWN
// path.join separator — `join('scripts', name)` is `scripts\x.test.mjs` on win32 — while every
// parsed name reaching this function has already been normalized to POSIX by
// normalizeBatteryTestFile. Comparing them RAW made `known.has(f)` false for EVERY file on Windows,
// silently disabling this whole recheck exactly on the platform this plan exists for (a LOCAL land,
// and the pre-push gate, both run on Windows) while leaving it working only on the Linux cloud
// drains. Fix: run the glob's own output back through normalizeBatteryTestFile too — the SAME
// function, not a second hand-rolled separator swap — so both sides of the comparison land on the
// identical POSIX convention regardless of which platform produced them.
//
// plan 3827 review round 2 (P1, CONFIRMED): a parsed name that fails validation used to be
// silently FILTERED OUT and the recheck proceeded on the remainder — the same unsound shape as the
// original 40-line truncation hole this plan closes: a name the worktree does not actually carry is
// EVIDENCE the parse itself is wrong, not proof the rest of the set is trustworthy. This now reports
// the unknown names instead of dropping them, so the caller (batteryIsolationRecheck) can refuse the
// whole recheck rather than heal on a possibly-wrong remainder.
//
// `_listScriptsTestFiles` is injectable (mirrors listScriptsTestFiles's own `{ _stat }` seam) so the
// Windows/POSIX separator parity above is unit-testable from either platform WITHOUT faking
// `process.platform` — this repo's own rule (CLAUDE.md, `assert-posix-path-assertions.mjs`) is that
// a platform-specific test must supply that platform's SYMBOLS, and there is no clean way to fake
// `path.join`'s separator choice short of an injectable seam like this one.
export function filterToKnownBatteryFiles(
  wtPath,
  files,
  { _listScriptsTestFiles = landDeps().scriptsBattery.listScriptsTestFiles } = {},
) {
  let known;
  try {
    known = new Set(
      _listScriptsTestFiles(wtPath)
        .map((f) => normalizeBatteryTestFile(f))
        .filter(Boolean),
    );
  } catch {
    // A read failure (raced delete, permission blip, an unreadable wtPath) must fail CLOSED to
    // "nothing validated" rather than trust the unfiltered parse — every parsed name then reports as
    // unknown, which flows into the SAME "unknown parsed file(s)" refusal below a genuinely-unknown
    // name does, never into a widened re-run.
    known = new Set();
  }
  const unknown = files.filter((f) => !known.has(f));
  return { files, unknown };
}

// plan 4006 review round 3 (finding f70e3a): the two isolation-recheck classifiers — this gate's
// own `classifyBatteryIsolationOutcome` below and the sibling heavy gate's twin in its host module
// — were two hand-copied closures that had ALREADY drifted once. The battery copy dropped the
// OOM-`starved` branch its twin has, so a recheck killed by a Windows spawn-init signature fell
// through to "red in isolation — a real failure" and was emitted as BATTERY_FAILED (whose
// `--resume BATTERY_FAILED` then skips the battery step outright). Sharing ONE implementation,
// parameterised by the caller's own healed-files list and isolation timeout (the only two things
// that differ between the two call sites), closes the class rather than patching the missing
// branch back in as a second copy that can drift again.
//
// plan 3961 adaptation: upstream read the free-memory line by calling a host helper directly. This
// is a core module and cannot import that helper, so the reading arrives as `freeMemReading`, a
// zero-argument function each caller supplies — the same "the caller's own reading, threaded in"
// shape done-worktree-lib.mjs's starved-seam builders already take, kept as a FUNCTION so the
// reading is still taken at classification time and only on the branch that needs it.
//
// `starvedCause` (plan 4006 review round 3, finding f705c6/a3f5ba/3c7871) rides alongside
// `starved` on both starved-classifying branches — 'queue' for a recheck never admitted to the
// shared heavy-test queue (testQueueRunOutcome's own `slotStarved`), 'spawn' for the recheck's own
// process dying with a spawn-init NTSTATUS signature (testQueueRunOutcome's OOM-`starved` shape,
// which may itself carry a `starvedCause` already — forwarded, defaulting to 'spawn' for a
// synthetic/dry-hook outcome that predates the field). The two causes narrate DIFFERENT diagnoses
// (a busy queue vs. an out-of-memory box) and must stay distinguishable all the way to the seam
// message, not just at this classification point.
export function classifyIsolationRecheckOutcome({
  outcome,
  healedFiles,
  isolationTimeoutMs,
  freeMemReading,
}) {
  if (outcome.ok) {
    return { ok: true, healedFiles, files: healedFiles };
  }
  if (outcome.slotStarved) {
    return {
      ok: false,
      starved: true,
      starvedCause: 'queue',
      reason:
        'the isolation recheck was never admitted to the shared heavy-test queue (plan 4006) — ' +
        `unproven either way, not this recheck's own ${Math.round(isolationTimeoutMs / 1000)}s cap: ${outcome.detail}`,
      healedFiles,
      files: healedFiles,
      detail: outcome.detail,
    };
  }
  // Mirrors the sibling gate's recheck's own `outcome.timedOut` handling (plan 3781 T2): a
  // TIMED-OUT recheck is unproven either way, distinct from a recheck that actually ran and
  // exited non-zero.
  if (outcome.timedOut) {
    return {
      ok: false,
      reason:
        `isolation recheck TIMED OUT after ${Math.round(isolationTimeoutMs / 1000)}s ` +
        // plan 4006 review round 1 (stale-claim retire-back): "includes" was true before plan 4003 T1
        // gave this call `slotWaitOutsideCap: true` — the cap now bounds only the run itself,
        // never the queue-ticket wait spent before admission.
        '(the cap excludes queue-ticket wait — plan 4003 T1) — unproven either way, blocking',
      healedFiles,
      files: healedFiles,
      timedOut: true,
      detail: outcome.detail,
    };
  }
  // plan 3954 T2 (code-review finding 059a81) / plan 4006 review round 3 (finding f70e3a — the
  // branch the battery copy of this classifier was missing): the RECHECK's own process died the
  // same way (a signature exit code with no captured output — outcome.starved, set by
  // testQueueRunOutcome). Deliberately NOT `|| originalTailStarved` for the sibling gate's caller —
  // see that recheck's own early-return comment: that shape is handled entirely before the
  // recheck ever runs, so `originalTailStarved` is always false by the time execution reaches
  // here. This is NOT proof the recheck itself is clean (RED-IN-ISOLATION IS NEVER SELF-HEALED
  // still holds: this returns `ok: false`, same as the branch below, just with a different label
  // and no --resume skip).
  if (outcome.starved) {
    return {
      ok: false,
      starved: true,
      starvedCause: outcome.starvedCause || 'spawn',
      reason:
        `the box was out of memory at spawn time (${freeMemReading()}), a Windows spawn-init ` +
        'NTSTATUS signature, not a real test failure — re-invoke when the box has headroom',
      healedFiles,
      files: healedFiles,
      detail: outcome.detail,
    };
  }
  return {
    ok: false,
    reason: 'red in isolation — a real failure, not a herd flake',
    healedFiles,
    files: healedFiles,
    detail: outcome.detail,
  };
}

export async function batteryIsolationRecheck(wtPath, originalOutcome, { onRun } = {}) {
  const D = landDeps();
  const battBattery = batteryBattery();
  // plan 3827 review round 1, Fix B (CONFIRMED): an ORIGINAL battery run that itself TIMED OUT
  // never proves it even reached every file — the failing-file set it happens to report (if any)
  // says nothing about the files it never got to, so re-running only the reported ones and healing
  // on green would prove nothing about the rest. Checked FIRST, before the failureFiles/cap/
  // localization checks below, and distinct from THIS RECHECK's own BATTERY_ISOLATION_TIMEOUT_MS
  // arm further down — that one is about the recheck's own run; this is about whether the ORIGINAL
  // run even qualifies for one.
  //
  // plan 4003 T5 corrects the REASONING, not the behaviour. Fix B's original wording was "which
  // files it never reached is unknown"; since plan 3223's per-file ledger that has not been true,
  // and plan 4003 T2 now banks exactly that set as a partial land-gate proof. The refusal stands on
  // the sounder half of the argument: those files are known AND UNPROVEN, so a recheck of only the
  // reported failures still cannot make this gate green. Proving them is the NEXT invocation's job
  // (T4 runs the remainder), never a heal's. Do not re-derive a heal from the ledger here.
  if (originalOutcome?.timedOut) {
    return {
      ok: false,
      reason:
        'the original battery run TIMED OUT — the files it never reached are unproven, so ' +
        're-running only the ones it happened to report cannot prove the rest (plan 3827 review ' +
        'round 1, Fix B; plan 4003 T2 banks those files instead, and the next invocation runs them)',
      files: [],
    };
  }
  // plan 3827 review round 2 (angle-B/C, CONFIRMED): `timedOut` above only catches OUR OWN timeout
  // kill. A battery run that died for any OTHER reason never proved it reached every file either —
  // a spawn failure (the child never started), the tree-kill escalation path, or the hang-guard
  // collapsing to `code: null` after both escalation grace periods elapse. `terminationUnproven`
  // (set additively on the outcome by runViaTestQueue, mirroring `failureFiles`/`timedOut`'s own
  // shape) is true for exactly those non-genuine-exit shapes — a real, completed test-process exit
  // (pass OR fail) always sets it false. Refused here, unconditionally, the SAME way a timed-out
  // original run is refused above: unproven, so healing on whatever `failureFiles` happened to
  // parse from an empty/partial capture would be unsound.
  if (originalOutcome?.terminationUnproven) {
    return {
      ok: false,
      reason:
        'the original battery run did not end in a genuine test-process exit (a spawn failure, ' +
        'the tree-kill escalation path, or a hang-guard collapse) — which files it reached is ' +
        'unproven, so healing on its reported failureFiles would be unsound (plan 3827 review ' +
        'round 2)',
      files: [],
    };
  }
  // plan 3827 review round 2 (5-angle finding, CONFIRMED): the 4 MiB capture cap (boundedAppend)
  // keeps only the TAIL once the combined stdout+stderr exceeds it — a much weaker version of the
  // original 40-line truncation hole this plan closes, but the same unsound shape: a battery whose
  // real failure summary printed BEFORE the point the buffer started dropping its front could still
  // parse to an incomplete (or entirely wrong) `failureFiles` set. `captureTruncated` (additive on
  // the outcome, same pattern as `timedOut`/`failureFiles`) is true whenever ANY append to that
  // buffer actually sliced something off the front — refused unconditionally, same as a timed-out
  // or unproven-termination original run: the failing-file set built from a truncated buffer is
  // never provably complete.
  if (originalOutcome?.captureTruncated) {
    return {
      ok: false,
      reason:
        'the captured output was truncated at its 4 MiB cap — the failing-file set parsed from it ' +
        'is not provably complete, so healing on it would be unsound (plan 3827 review round 2)',
      files: [],
    };
  }
  // plan 3827 operator ruling R1: the failing-file list comes from the outcome's OWN
  // `failureFiles` — attached by the call site (runFullBatteryPreflight / runSelectedBatteryPreflight)
  // from `batteryFailureReportFromEvents`, read off the reporter's own destination file, never
  // reconstructed from `detail` text (which is only the last 40 lines and can under-report a real
  // multi-file failure). `undefined` (as opposed to `[]`) means this outcome never carried the
  // field at all — e.g. it did not come through that seam — and absent evidence must never
  // authorize a heal, so this refuses outright.
  if (originalOutcome?.failureFiles === undefined) {
    return {
      ok: false,
      reason:
        'the failing-file set could not be established for this run (no failureFiles on the ' +
        'outcome) — refusing to recheck without evidence (plan 3827 review round 1, Fix A)',
      files: [],
    };
  }
  // plan 3827 operator ruling R1: `failureFiles` alone proves a failure was OBSERVED, never that
  // EVERY file the run was asked to run reported a terminal event. `failureComplete` (additive on
  // the outcome, from `batteryFailureReportFromEvents` — the SAME single read the call site already
  // did, never re-derived here) is the structural cross-check: node's reporter emits exactly one
  // terminal event per test FILE, so "every target file reported one" is proof the failing set is
  // whole, not merely a count that happens to line up. Anything other than exactly `true` — `false`
  // (a proven gap, e.g. a killed run that never reached every file) OR `undefined` (an outcome that
  // never carried the field, e.g. one built outside the real seam) — refuses, mirroring the
  // `failureFiles === undefined` arm immediately above: absent evidence never authorizes a heal.
  if (originalOutcome?.failureComplete !== true) {
    const seen = originalOutcome?.failureSeen ?? 0;
    const reported = originalOutcome?.failureReported ?? null;
    // plan 3827 F1: name the target file(s) that never reported, when the outcome carries them
    // (`failureMissing`, additive off batteryFailureReportFromEvents' own `missing` field) — purely
    // cosmetic, capped so a large gap does not spam the land log.
    const missing = Array.isArray(originalOutcome?.failureMissing)
      ? originalOutcome.failureMissing
      : [];
    const missingNote = missing.length
      ? `; missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`
      : '';
    return {
      ok: false,
      reason:
        `the reporter's per-file event stream is not provably whole (${seen} of ` +
        `${reported === null ? 'an unknown number of' : reported} target file(s) reported a ` +
        `terminal event${missingNote}) — refusing to recheck a partial failure set`,
      files: [],
    };
  }
  // plan 3827 review round 1, Fix C: cross-check against the worktree's real battery glob before
  // trusting a single name normalizeBatteryTestFile's regex accepted — see
  // filterToKnownBatteryFiles's own header. Skipped under --dry-run, which never performs a live
  // read of wtPath (see runFullBatteryPreflight's own DRY block) and whose fixture tails already
  // name this repo's real files to exercise the wiring without one.
  //
  // plan 3827 review round 2 (P1, CONFIRMED): a name that fails this cross-check is EVIDENCE the
  // parse produced something this worktree does not actually carry — filtering it out and healing
  // on the remainder used to be the behaviour here, which is the same unsound "shrink the set and
  // proceed" shape as the original truncation hole. Any unknown name now refuses the WHOLE recheck,
  // naming the offending path(s), rather than silently narrowing to what did validate.
  let files;
  if (D.env.DRY) {
    files = originalOutcome.failureFiles;
  } else {
    const { unknown } = filterToKnownBatteryFiles(wtPath, originalOutcome.failureFiles);
    if (unknown.length) {
      return {
        ok: false,
        reason:
          `parsed failing file(s) not found in this worktree's battery glob: ${unknown.join(', ')} ` +
          '— refusing the recheck rather than healing on a possibly-wrong remainder (plan 3827 ' +
          'review round 2)',
        files: unknown,
      };
    }
    files = originalOutcome.failureFiles;
  }
  if (files.length > BATTERY_ISOLATION_MAX_FILES) {
    return {
      ok: false,
      reason: `${files.length} failing file(s) exceeds the ${BATTERY_ISOLATION_MAX_FILES}-file isolation cap — not a load-flake shape`,
      files,
    };
  }
  if (!files.length) {
    return {
      ok: false,
      reason: 'the failure could not be localized to any test file',
      files,
    };
  }
  // Deliberately NO battery-lock mutex acquisition here (mirrors the sibling gate's recheck immediately
  // above, which likewise takes no extra lock of its own): this recheck runs ONLY the small
  // failing-file set once, bounded by BATTERY_ISOLATION_TIMEOUT_MS, at the head slot the land
  // already holds — serializing it behind the machine-wide battery-lock mutex would risk the
  // recheck itself queueing behind an unrelated sibling's full battery run, defeating the whole
  // point of a bounded, fast recheck. The ordinary full/scoped battery runs still take the mutex
  // exactly as before; only this one-shot recheck does not.
  //
  // plan 4006 review round 1 (findings ab9ea5/4a76e3): shared by the real (non-DRY) call below AND
  // the 'never-admitted' dry-run hook — the sibling gate's own classifier header explains the
  // ordering requirement (`outcome.slotStarved` checked BEFORE the generic `outcome.timedOut`
  // branch) in full; this is the battery half of the identical fix.
  // plan 4006 review round 3 (finding f70e3a): this used to be a SECOND hand-copy of that
  // classifier's branches and had already drifted (it was missing the OOM-`starved` branch its
  // twin has) — now a thin binding of the shared classifyIsolationRecheckOutcome (see its own
  // header) to this recheck's own healed-files list and isolation timeout, so the two classifiers
  // cannot drift apart again.
  const classifyBatteryIsolationOutcome = (outcome) =>
    classifyIsolationRecheckOutcome({
      outcome,
      healedFiles: files,
      isolationTimeoutMs: BATTERY_ISOLATION_TIMEOUT_MS,
      freeMemReading: D.spine.freeMemoryReading,
    });
  if (D.env.DRY) {
    // Trace the real subprocess the same way runFullBatteryPreflight's DRY branch does, so a
    // --dry-run test can assert the wiring without a real node --test invocation. A third
    // DW_FAKE_BATTERY_ISOLATION value, 'timeout', mirrors the real runViaTestQueue timeout shape
    // (plan 3781 T2's sibling-gate twin) so the narration is testable without a real 10-minute wait.
    const [dcmd, dargs] = battBattery.buildArgs(files);
    D.spawn.run(dcmd, dargs);
    if (process.env.DW_FAKE_BATTERY_ISOLATION === 'green') {
      return { ok: true, healedFiles: files, files };
    }
    if (process.env.DW_FAKE_BATTERY_ISOLATION === 'timeout') {
      return {
        ok: false,
        reason:
          `isolation recheck TIMED OUT after ${BATTERY_ISOLATION_TIMEOUT_MS / 1000}s ` +
          '(the cap excludes queue-ticket wait — plan 4003 T1) — unproven either way, blocking',
        healedFiles: files,
        files,
        timedOut: true,
        detail: 'isolation recheck TIMED OUT (dry hook, DW_FAKE_BATTERY_ISOLATION=timeout)',
      };
    }
    // plan 4006 review round 3 (finding f70e3a): mirrors the sibling gate's isolation recheck's own
    // 'starved' dry hook — the RECHECK's own process exits with a spawn-init signature and no
    // captured output (testQueueRunOutcome's OOM-`starved` shape, distinct from
    // slotStarved/never-admitted below), routed through classifyBatteryIsolationOutcome so the
    // previously-missing outcome.starved branch is exercised by a --dry-run test rather than
    // merely asserted about.
    if (process.env.DW_FAKE_BATTERY_ISOLATION === 'starved') {
      return classifyBatteryIsolationOutcome({
        ok: false,
        starved: true,
        starvedCause: 'spawn',
        detail:
          'isolation recheck exited with a spawn-init signature (dry hook, ' +
          'DW_FAKE_BATTERY_ISOLATION=starved)',
      });
    }
    // plan 4006 review round 1 (findings ab9ea5/4a76e3): a FOURTH value, 'never-admitted', feeds a
    // synthetic outcome carrying BOTH `timedOut: true` AND `slotStarved: true` — exactly the shape
    // testQueueRunOutcome's own never-admitted branch produces — through the SAME
    // classifyBatteryIsolationOutcome the real (non-DRY) call below uses, so the ordering fix is
    // exercised by a --dry-run test rather than merely asserted about.
    if (process.env.DW_FAKE_BATTERY_ISOLATION === 'never-admitted') {
      return classifyBatteryIsolationOutcome({
        ok: false,
        timedOut: true,
        slotStarved: true,
        detail:
          'isolation recheck was never admitted to the shared heavy-test queue — killed after ' +
          '90s by the 90s pre-admission backstop (plan 4006), not by its own 600s cap (dry hook, ' +
          'DW_FAKE_BATTERY_ISOLATION=never-admitted)',
      });
    }
    return {
      ok: false,
      reason: 'red in isolation (dry hook)',
      healedFiles: files,
      files,
    };
  }
  onRun?.(files);
  // plan 4236 T1: capped from the per-slot CPU budget like every other battery run.
  const [cmd, cmdArgs] = battBattery.buildArgs([...landBatteryConcArgs(), ...files]);
  const outcome = await runViaTestQueue(wtPath, {
    cmd,
    cmdArgs,
    label: `done-worktree scripts battery (isolation recheck, ${files.length} file(s))`,
    timeoutMs: BATTERY_ISOLATION_TIMEOUT_MS,
    // plan 4003 T1: same reasoning as the sibling gate's isolation recheck above — the bound is on the
    // recheck's own RUN, never on how long the shared queue took to admit it.
    slotWaitOutsideCap: true,
  });
  return classifyBatteryIsolationOutcome(outcome);
}

// The one place both battery red arms (full and diff-scoped) funnel through — the battery twin of
// the sibling gate's own isolation-recheck twin immediately above (core-noun-ok: pytestRedIsFlake
// is that module's own function name). Returns true when the red was proven a load flake and the
// land may proceed. `state.failingFiles`/`state.isolationTimedOut` are the SAME state fields the
// sibling-gate recheck writes (plan 3781 T3) — reused rather than a second parallel pair, since a single
// land can only be blocked by one gate's seam at a time and the sidecar/seam-state JSON they feed
// has no need to distinguish which gate wrote them.
export async function batteryRedIsFlake(
  wtPath,
  originalOutcome,
  state,
  label,
  { originalStarved = false, originalStarvedCause } = {},
) {
  const D = landDeps();
  // plan 4006 review round 1 (finding 4a76e3): reset on EVERY call, mirroring the sibling gate's
  // own starved-flag reset — this function has multiple call sites sharing one `state` (the
  // extras-only, diff-scoped, and full-suite arms), and a stale `true` from an earlier call in the
  // same land must never leak into a later, unrelated red.
  state.batteryStarved = false;
  state.batteryStarvedCause = undefined;
  // plan 4006 review round 3 (findings f914d4/c989af/743a55/bc1f69/e59297/2c8424/ac908e — seven
  // findings, one defect): mirrors the sibling gate's own `originalStarved` shortcut. The
  // ORIGINAL battery run's own process can be killed before it ever gets a queue slot (or die with
  // a spawn-init signature and no captured output) — testQueueRunOutcome already classified that
  // directly (the caller's own `bat.starved`/`sel.starved`/`extraOnly.starved`, threaded in here as
  // `originalStarved`). `batteryIsolationRecheck` refuses a TIMED-OUT original (its own Fix-B
  // guard, unconditional) BEFORE it ever looks at `starved` — and a never-admitted original always
  // carries `timedOut: true` alongside `starved` (testQueueRunOutcome's own never-admitted branch,
  // needed for the cloud-chunking path) — so without this shortcut a never-admitted ORIGINAL run
  // is refused by that guard and its starvation is silently discarded, never reaching a recheck
  // that could have told a consumer otherwise. Trust the caller's own classification directly and
  // skip the recheck entirely — there is nothing to localize a recheck against, and a recheck
  // against a still-starved queue/box proves nothing either way.
  if (originalStarved) {
    state.batteryStarved = true;
    state.batteryStarvedCause = originalStarvedCause || 'spawn';
    D.spine.stepLog(
      state,
      state.batteryStarvedCause === 'queue'
        ? `${label}: the run itself was never admitted to the shared heavy-test queue — starved, ` +
            'not rechecked (a recheck cannot run until the queue is free).'
        : `${label}: the run itself exited with a spawn-init NTSTATUS signature and produced no ` +
            `captured output at all (${D.spine.freeMemoryReading()}) — starved, not rechecked.`,
    );
    return false;
  }
  const rc = await batteryIsolationRecheck(wtPath, originalOutcome, {
    onRun: (files) =>
      D.spine.stepLog(
        state,
        `${label}: RED — re-running ${files.length} failing file(s) in isolation once before ` +
          'surrendering the slot (plan 3827)',
      ),
  });
  if (rc.ok) {
    D.spine.stepLog(
      state,
      `${label}: the isolated re-run of ${rc.healedFiles.join(' ')} PASSED — classified a herd ` +
        'load flake, proceeding (plan 3827). The slot is kept.',
    );
    return true;
  }
  D.spine.stepLog(state, `${label}: isolation recheck did not clear the red — ${rc.reason}`);
  if (rc.files && rc.files.length) {
    D.spine.stepLog(state, `${label}: failing file(s): ${rc.files.join(' ')}`);
  }
  if (rc.detail) {
    const tail = String(rc.detail).split('\n').slice(-15).join('\n');
    D.spine.stepLog(state, `${label}: --- isolation recheck tail ---\n${tail}`);
  }
  // plan 3781 T3's contract, reused verbatim: `undefined` (never `[]`/`false`) when nothing was
  // learned, so "we did not learn it" stays distinguishable from "there were none".
  if (rc.files && rc.files.length) state.failingFiles = rc.files;
  if (rc.timedOut) state.isolationTimedOut = true;
  if (rc.starved) {
    state.batteryStarved = true; // plan 4006 review round 1 (finding 4a76e3)
    state.batteryStarvedCause = rc.starvedCause || 'spawn'; // plan 4006 review round 3
  }
  return false;
}

// The battery's twin of the above, through `scripts/select-battery-tests.mjs` — the SAME delta
// selector the hook's own `scripts-battery` gate uses. An unscopable delta (the selector claims the
// whole glob) reports `full` and the caller dispositions by kind (see the sibling gate's own
// selected-preflight entry's own header for the parallel arm; core-noun-ok: runSelectedPytestPreflight
// is that module's own function name)
// own header and narrateScopedGate for the plan-3335 split — kind='remainder' falls through to the
// full run, kind='selective' runs nothing); a selector that could not RUN at all reports
// `selector-failed` and sends the caller to the full preflight regardless of kind.
// plan 4003 T4: `extraTests` are test files the caller ALREADY knows must run — the remainder a
// partial land-gate proof leaves behind — in the selector's own output vocabulary. They bypass the
// selector (there is nothing to map: they are already targets) and are unioned with whatever the
// selector derives from `paths`. Default `[]` keeps every pre-4003 caller byte-identical, including
// the `!paths.length` short-circuit, which now only fires when there is nothing to run from EITHER
// source.
export async function runSelectedBatteryPreflight(
  wtPath,
  paths,
  { onRun, reason, extraTests = [] } = {},
) {
  const D = landDeps();
  const extra = Array.isArray(extraTests) ? extraTests.filter(Boolean) : [];
  if (!paths.length && !extra.length) return { ok: true, ran: 0, selection: 'none' };
  if (D.env.DRY) {
    if (paths.length) D.spawn.run('node', ['scripts/select-battery-tests.mjs', ...paths]);
    // plan 3335 test hook: DW_FAKE_SELECTED_BATTERY_VERDICT=full|selector-failed injects a fake
    // selector VERDICT — twin of the sibling gate's own selected-verdict test hook for the battery
    // gate (core-noun-ok: DW_FAKE_SELECTED_PYTEST_VERDICT is that module's own env-var name). Honoured
    // ONLY under --dry-run; default `subset` keeps every existing test's shape unchanged.
    const forced = process.env.DW_FAKE_SELECTED_BATTERY_VERDICT;
    if (forced === 'full') {
      return {
        ok: true,
        ran: 0,
        selection: 'full',
        detail: 'DW_FAKE_SELECTED_BATTERY_VERDICT=full (dry-run injected)',
      };
    }
    if (forced === 'selector-failed') {
      return {
        ok: true,
        ran: 0,
        selection: 'selector-failed',
        detail: 'DW_FAKE_SELECTED_BATTERY_VERDICT=selector-failed (dry-run injected)',
      };
    }
    // plan 4006 review round 3 (finding 2c8424): DW_FAKE_BATTERY=starved/never-admitted mirror
    // testQueueRunOutcome's own two starvation shapes for the ORIGINAL diff-scoped run itself (not
    // its isolation recheck — the recheck's own DW_FAKE_BATTERY_ISOLATION hooks are separate), so a
    // --dry-run test can drive `batteryRedIsFlake`'s `originalStarved` parameter for the
    // diff-scoped arm without a real spawn or a real queue wait. Checked BEFORE the generic
    // DW_FAKE_BATTERY truthy check below, exactly like the forced-verdict checks above.
    if (process.env.DW_FAKE_BATTERY === 'starved') {
      return {
        ok: false,
        starved: true,
        starvedCause: 'spawn',
        ran: paths.length + extra.length,
        selection: 'subset',
        detail: '',
      };
    }
    if (process.env.DW_FAKE_BATTERY === 'never-admitted') {
      return {
        ok: false,
        starved: true,
        slotStarved: true,
        starvedCause: 'queue',
        timedOut: true,
        ran: paths.length + extra.length,
        selection: 'subset',
        detail: 'DW_FAKE_BATTERY=never-admitted (dry-run injected)',
      };
    }
    D.spawn.run('node', [
      QUEUED_RUN_CLI,
      '--label',
      `done-worktree battery (${reason || 'diff-scoped'})`,
    ]);
    // plan 3827 operator ruling R1 (2026-09-09): DW_FAKE_BATTERY_EVENTS is the raw JSONL text the
    // fake reporter "wrote" — run through the REAL batteryFailureReportFromEvents helper (never a
    // hand-typed fake report), so a --dry-run test exercises the actual events-parsing and
    // completeness wiring. DW_FAKE_BATTERY_TARGETS (comma-separated repo-relative paths) supplies
    // the fake `reported` target list; omitted, it defaults to the events' own failing files, so a
    // simple one-file fixture is `complete` by construction. DW_FAKE_BATTERY_TAIL no longer feeds
    // any parser (that role is deleted along with the text grammars) — it survives only as the
    // narration `detail` string a --dry-run test can assert on.
    const fakeEventsText = process.env.DW_FAKE_BATTERY_EVENTS || '';
    const fakeParsedFiles = batteryFailureReportFromEvents(wtPath, fakeEventsText, null).files;
    const fakeTargets = process.env.DW_FAKE_BATTERY_TARGETS
      ? process.env.DW_FAKE_BATTERY_TARGETS.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : fakeParsedFiles;
    const fakeReport = batteryFailureReportFromEvents(wtPath, fakeEventsText, fakeTargets);
    return {
      ok: process.env.DW_FAKE_BATTERY !== 'fail',
      // plan 4003 T4: the extras are real targets of this run, so a dry trace that reported only
      // `paths.length` would understate a partial-proof composition as zero.
      ran: paths.length + extra.length,
      selection: 'subset',
      detail: process.env.DW_FAKE_BATTERY_TAIL || 'DW_FAKE_BATTERY',
      failureFiles: fakeReport.files,
      failureComplete: fakeReport.complete,
      failureSeen: fakeReport.seen,
      failureReported: fakeReport.reported,
      failureMissing: fakeReport.missing,
    };
  }
  let out = '';
  // plan 4003 T4: with no changed paths to map there is nothing for the selector to do — running
  // it on an empty stdin would only invite a FULL verdict over a selection the caller already
  // computed itself. The `extra` targets alone are the run.
  if (!paths.length) return runBatteryTargets(wtPath, extra, { onRun, reason });
  try {
    // plan 3335 (gpt-review 422a75, CONFIRMED): use the WORKTREE's copy of the selector, not
    // MAIN's. `import.meta.dirname` here is whatever spine actually loaded — and the spine
    // re-execs from `${MAIN}/scripts/done-worktree.mjs` when the worktree's own copy differs
    // (`:11441`, `:11530`), so `import.meta.dirname` becomes MAIN's `scripts/` after the re-exec.
    // A branch that modifies `select-battery-tests.mjs` (e.g. adds a new FULL-trigger path) would
    // then execute MAIN's stale selector against the worktree's tests — the exact stale-selector
    // gap that motivated `dispatchLandPrep` to spell out `${state.wtPath}/scripts/done-worktree.mjs`
    // (`:2018-2019`, comment ID (2)). Mirror that here: the worktree owns its own selector.
    out = execFileSync(process.execPath, [`${wtPath}/scripts/select-battery-tests.mjs`], {
      cwd: wtPath,
      encoding: 'utf8',
      input: paths.join('\n') + '\n',
      timeout: 120_000,
      maxBuffer: D.coordGit.GIT_MAXBUFFER,
      env: D.L.spawnEnv(),
    });
  } catch (e) {
    // EXIT_RUN_FULL (3) is select-battery-tests.mjs's own "this delta cannot be narrowed" VERDICT,
    // not a failure — the same value scripts/hooks/pre-push.sh reads off this CLI. Every other
    // non-zero exit (and a spawn error, which carries no status at all) is the selector failing to
    // run, which falls back to the FULL battery rather than to "nothing ran".
    const verdictFull = e?.status === D.selectBatteryTests.EXIT_RUN_FULL;
    return {
      ok: true,
      ran: 0,
      selection: verdictFull ? 'full' : 'selector-failed',
      detail: String(e?.message || e),
    };
  }
  const selected = out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  // plan 4003 T4: the union, deduped, selector-derived targets first so the ordinary (no partial
  // proof) case is byte-identical to before.
  const seen = new Set(selected);
  const tests = [...selected, ...extra.filter((f) => !seen.has(f))];
  return runBatteryTargets(wtPath, tests, { onRun, reason });
}

// The battery half of `runSelectedBatteryPreflight`, split out by plan 4003 T4 so a caller with a
// target list already in hand (a partial proof's unproven remainder) reaches the identical run,
// reporter wiring, events parse and cleanup rather than a second copy of them.
export async function runBatteryTargets(wtPath, tests, { onRun, reason } = {}) {
  const D = landDeps();
  const battBattery = batteryBattery();
  if (!tests.length) return { ok: true, ran: 0, selection: 'none' };
  // gpt-review r2 (f14595 / b26035): the sha these greens are attributed to is resolved BEFORE the
  // spawn, exactly as `runFullBatteryPreflight`'s `headAtStart` is. Reading HEAD afterwards would
  // stamp the proof with whatever the tree moved to during a run that can take tens of minutes, and
  // a partial proof's sha is the BASELINE its remainder is computed from — a wrong one silently
  // narrows the next run against a tree these files were never proved on.
  const headAtStart = resolveHeadOid(wtPath);
  // gpt-review r3 (2d0e47): the DRY guard used to live only in `runSelectedBatteryPreflight`'s own
  // block, which every pre-4003 caller went through. The selective extras-only arm calls THIS
  // function directly, so without a guard here a `--dry-run` would spawn a real battery — a dry run
  // that mutates nothing is the whole contract of that flag, and the spine's subprocess test
  // harness runs on it. Mirrors the DRY shape of the caller it was split out of.
  if (D.env.DRY) {
    onRun?.(tests.length);
    // plan 4006 review round 3 (finding 2c8424): DW_FAKE_BATTERY=starved/never-admitted mirror
    // testQueueRunOutcome's own two starvation shapes for the ORIGINAL run itself, for this arm
    // (the partial proof's unproven remainder) exactly as the diff-scoped arm's own copy of this
    // hook does — see runSelectedBatteryPreflight's identical hook for the full rationale. Checked
    // BEFORE the unconditional queued-run.mjs trace below so a --dry-run test can drive
    // `batteryRedIsFlake`'s `originalStarved` parameter for THIS arm too.
    if (process.env.DW_FAKE_BATTERY === 'starved') {
      return {
        ok: false,
        starved: true,
        starvedCause: 'spawn',
        ran: tests.length,
        selection: 'subset',
        detail: '',
      };
    }
    if (process.env.DW_FAKE_BATTERY === 'never-admitted') {
      return {
        ok: false,
        starved: true,
        slotStarved: true,
        starvedCause: 'queue',
        timedOut: true,
        ran: tests.length,
        selection: 'subset',
        detail: 'DW_FAKE_BATTERY=never-admitted (dry-run injected)',
      };
    }
    D.spawn.run('node', [
      QUEUED_RUN_CLI,
      '--label',
      `done-worktree battery (${reason || 'targets'})`,
    ]);
    // gpt-review r4 (a7338c / 596305 / e9408b — three finders): the first cut returned a hollow
    // shape with `failureFiles: []`, which is not "no evidence" to this function's consumers — it
    // is the POSITIVE claim that nothing failed, and it would have let a dry-run test of the
    // extras-only arm exercise a flake recheck that can never fire. Reuse the SAME
    // DW_FAKE_BATTERY_EVENTS → `batteryFailureReportFromEvents` wiring the sibling dry-run arms
    // use, so a dry run here exercises the real parser rather than a hand-typed fake report, and
    // the partial proof comes from the same events through the same `batteryRoundGreen`.
    const fakeEventsText = process.env.DW_FAKE_BATTERY_EVENTS || '';
    const fakeEvents = D.batteryLedger.parseLedgerEvents(fakeEventsText);
    const fakeTargets = process.env.DW_FAKE_BATTERY_TARGETS
      ? process.env.DW_FAKE_BATTERY_TARGETS.split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : tests;
    const fakeReport = batteryFailureReportFromEvents(
      wtPath,
      fakeEventsText,
      fakeTargets,
      fakeEvents,
    );
    const fakeGreen = batteryRoundGreen(fakeEvents, wtPath);
    return {
      ok: process.env.DW_FAKE_BATTERY !== 'fail',
      ran: tests.length,
      selection: 'subset',
      detail: process.env.DW_FAKE_BATTERY_TAIL || 'DW_FAKE_BATTERY',
      failureFiles: fakeReport.files,
      failureComplete: fakeReport.complete,
      failureSeen: fakeReport.seen,
      failureReported: fakeReport.reported,
      failureMissing: fakeReport.missing,
      provenFiles: fakeGreen ? [...fakeGreen] : [],
      provenSha: headAtStart,
    };
  }
  onRun?.(tests.length);
  // plan 3827 operator ruling R1 (2026-09-09): this arm wires NO reporter before this plan — mint
  // an events path the SAME way runFullBatteryPreflight does (a private tmp file under the OS tmp
  // dir, never a shared/ledger one: this is a one-off diff-scoped run, not a ledger participant)
  // and splice the SAME two-reporter pair in front of the targets — the human-readable reporter
  // stays on stdout (this run's own `detail`/land log is unaffected), the structured one lands in
  // this file, read back AFTER the run and BEFORE the `finally` cleanup removes it.
  const eventsPath = joinPath(tmpdir(), `dw-battery-events-${process.pid}-${Date.now()}.jsonl`);
  const reporterArgs = [
    `--test-reporter=${D.batteryLedger.defaultNonTtyReporter()}`,
    '--test-reporter-destination=stdout',
    `--test-reporter=${D.batteryLedger.REPORTER_SPECIFIER}`,
    `--test-reporter-destination=${eventsPath}`,
  ];
  // plan 4236 T1: this arm used to pass NO concurrency at all — capped from the per-slot budget.
  const [cmd, cmdArgs] = battBattery.buildArgs([
    ...reporterArgs,
    ...landBatteryConcArgs(),
    ...tests,
  ]);
  try {
    const outcome = await runViaTestQueue(wtPath, {
      cmd,
      cmdArgs,
      label: `done-worktree battery (${reason || 'diff-scoped'}, ${tests.length} file(s))`,
      // plan 4034 T4 (re-shipping plan 4003 T3): derived like the full preflight's, off THIS run's
      // own selected file count — a diff-scoped selection of a handful of files sits on the floor,
      // a large one earns more. `battBattery.timeoutMs` is the NIGHTLY run's number and is no
      // longer read here. `perSlotWorkerBudget` declares NO default for its cpu argument (a bare
      // call computes NaN and the cap sanitises that to the ONE-worker, largest cap), so the count
      // is always passed explicitly — the same rule the full preflight's own derivation follows.
      timeoutMs: D.scriptsBattery.batteryRunCapMs(
        tests.length,
        D.testQueue.perSlotWorkerBudget(D.spine.landCpuCount()),
      ),
      // plan 4003 T1: no chunk cap reaches this arm, so the cap bounds the RUN.
      slotWaitOutsideCap: true,
    });
    let eventsText = '';
    if (existsSync(eventsPath)) {
      try {
        eventsText = readFileSync(eventsPath, 'utf8');
      } catch {
        eventsText = '';
      }
    }
    // gpt-review r3 (22050f): ONE parse, both consumers — the failure report AND the partial proof.
    let parsedEvents = null;
    try {
      parsedEvents = D.batteryLedger.parseLedgerEvents(eventsText || '');
    } catch {
      parsedEvents = null; // unparseable ⇒ both consumers fall back to their own empty handling
    }
    const report = batteryFailureReportFromEvents(wtPath, eventsText, tests, parsedEvents);
    // plan 4003, gpt-review r1 (98d910 / 845e95 / 6a57dd — three finders): this arm must return the
    // SAME per-file proof data the full preflight does, or a killed scoped run (a once-per-land
    // remainder, or a `landGate: selective` land) banks nothing and the next invocation re-runs the
    // whole selection from the top — the very failure this plan removes for the full run, left in
    // place for the narrowed one. The reporter's own events already name the passed files; the
    // parse is `parseLedgerEvents`, the same one the full path uses, and the paths come back
    // absolute so they go through `toPosixRelative` into the ledger's vocabulary.
    //
    // gpt-review r2 (99ca50 / 917074): the parse and the containment check are `batteryRoundGreen`
    // — the SAME helper the full preflight's own round scoring uses, which already relativizes
    // against `wtPath` and already refuses a path that escapes it on either platform's spelling.
    // The first cut re-implemented both beside it, which is how the two would have drifted the next
    // time either rule moved. `null` from it means this round's paths cannot be compared to the
    // ledger's vocabulary at all, which is exactly "nothing proven that we can name".
    let provenFiles = [];
    try {
      const green = parsedEvents ? batteryRoundGreen(parsedEvents, wtPath) : null;
      provenFiles = green ? [...green] : [];
    } catch {
      /* unparseable events ⇒ nothing proven by this run's own evidence; the caller banks nothing */
    }
    return {
      ...outcome,
      ran: tests.length,
      selection: 'subset',
      failureFiles: report.files,
      failureComplete: report.complete,
      failureSeen: report.seen,
      failureReported: report.reported,
      failureMissing: report.missing,
      provenFiles,
      provenSha: headAtStart,
    };
  } finally {
    // Best-effort, mirroring runFullBatteryPreflight's own `finally` cleanup of its
    // `ledgerEventsPath` — this arm's `eventsPath` is a private tmp file of its own.
    try {
      rmSync(eventsPath, { force: true });
    } catch {
      /* best-effort cleanup only */
    }
  }
}

function gateCacheRun(wtPath, args) {
  return cachedCliRun(wtPath, GATE_CACHE_CLI, args, { timeoutMs: 60_000 });
}

// Returns { hit: boolean, key: string|null }. `hit` true ⇒ skip the gate.
export function gateCacheCheck(wtPath, gate) {
  const D = landDeps();
  if (D.env.DRY) {
    // A dry run must never consult or mutate the REAL cache — but the WIRING (does a hit skip the
    // gate?) still has to be provable. DW_FAKE_GATE_CACHE is a comma-separated list of gate names
    // to report as HIT, honoured ONLY under --dry-run exactly like DW_FAKE_BUILD/DW_FAKE_MOBILE (core-noun-ok: names the actual env vars):
    // a leaked env var must never fake a cache hit in a production land. No key on a fake hit —
    // a hit never closes out, so none is needed.
    const fake = String(process.env.DW_FAKE_GATE_CACHE || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return { hit: fake.includes(gate), key: null };
  }
  const r = gateCacheRun(wtPath, ['check', '--gate', gate]);
  if (!/^[0-9a-f]{32}$/.test(r.out)) return { hit: false, key: null };
  if (r.status === 0) return { hit: true, key: r.out };
  if (r.status === 2) return { hit: false, key: r.out };
  return { hit: false, key: null }; // UNCACHEABLE / crash / anything unexpected ⇒ run it
}

export function gateCacheClose(wtPath, gate, key, passed) {
  const D = landDeps();
  if (D.env.DRY || !key) return;
  gateCacheRun(
    wtPath,
    passed
      ? ['record', '--gate', gate, '--key', key, '--label', 'done-worktree']
      : ['invalidate', '--key', key],
  );
}

// The `next-build` gate THROUGH the pass-cache — the single wiring both callers use (plan 2492,
// finding `m21k4e`). Before this, only the pre-enqueue preflight in main() consulted the cache;
// runLandPrep's keep-hot re-validation called runBuildPreflight directly, so a requeue paid the
// full 1-2 min build again even when the rebase left every build input byte-identical. That errs
// toward re-running (never a stale green) but directly undercuts 2462's own rationale — a
// multi-minute build must never hold, nor be repeated for, the head slot.
//
// Returns runBuildPreflight's own shape, plus `cached: true` on a hit. `onRun` fires only when
// the build actually runs, so each caller narrates in its own voice.
// plan 3436 D1: `chunkCapMs`/`minChunkS` are the same pair every heavy gate already takes (null /
// omitted ⇒ chunking off ⇒ the natural 600s cap and no tally, i.e. byte-identical to before this
// plan). The cache is consulted FIRST and unconditionally: a content hit costs nothing and must
// never be withheld because the budget is low — a hit is exactly what makes the re-invoke after a
// chunked round cheap.
export function runBuildPreflightCached(
  wtPath,
  {
    onRun,
    onCached,
    onChunked,
    chunkCapMs = null,
    minChunkS = 0,
    // plan 3436 (gpt-review a9d1f5 / 25710e): when the caller snapshotted `chunkCapMs`. The
    // `gateCacheCheck` probe below spawns a subprocess and spends real wall-clock, so the caller's
    // snapshot is already stale by the time the decision runs — the identical "stale-initial-cap"
    // class plan 3274 fixed for the sibling gate and battery, arriving at the gate this plan newly capped. Same
    // remedy and the same idiom: `chunkCapMsAfterElapsed` against a monotonic capture instant.
    capturedAtMs = monotonicNowMs(),
  } = {},
) {
  const D = landDeps();
  const c = gateCacheCheck(wtPath, 'next-build');
  if (c.hit) {
    // A content-cache HIT is the strongest "this gate is proven" signal there is, so it ENDS any
    // no-start series (gpt-review 9e864e / 25a9ce / 12639d). This return happens before the chunk
    // decision, so it is the only place that clear can be written.
    D.spine.clearNoStartRoundFor(wtPath, 'build');
    onCached?.();
    return { ok: true, cached: true };
  }
  const decision = chunkGateStartDecision(wtPath, 'build', {
    chunkCapMs: chunkCapMsAfterElapsed(chunkCapMs, monotonicNowMs() - capturedAtMs),
    minChunkS,
    naturalTimeoutMs: BUILD_GATE_TIMEOUT_MS,
    // The tally is settled below, once this round's outcome is known — a round that STARTS but is
    // chunk-killed proved nothing and must still count (gpt-review 20477a / d22336 / afa3b3).
    clearOnStart: false,
  });
  if (!decision.shouldRun) {
    // Nothing ran, so NOTHING is recorded — not a green, and deliberately not a red either: a red
    // would teach the content cache a build failure that never happened.
    const r = noStartGateResult('build', decision, minChunkS);
    onChunked?.(r.detail);
    return r;
  }
  onRun?.();
  const r = runBuildPreflight(wtPath, { timeoutMs: decision.effectiveTimeoutMs });
  // Our cap firing is partial progress, never a gate regression — and, like the no-start arm above,
  // records nothing. `usingChunkCap` is what makes this safe: a timeout at the FULL natural cap is
  // the build's own ceiling and stays a genuine BUILD_FAILED.
  if (!r.ok && r.timedOut && decision.usingChunkCap) {
    // This round retired nothing, so it counts toward the same bound a no-start round does: the
    // build has no per-file ledger, and a build whose wall-clock exceeds one chunk would otherwise
    // restart from scratch forever while reporting healthy CHUNKED.
    const progress = recordNoProgressRound(wtPath, 'build');
    const chunked = progress.exhausted
      ? {
          ok: false,
          chunked: true,
          nonConvergent: true,
          detail: D.L.noStartExhaustedDetail({
            gate: 'build',
            rounds: progress.noStartRounds,
            secondsLeft: decision.secondsLeft,
            minChunkS,
            wallVar: activeChunkWallVar(),
          }),
        }
      : {
          ok: false,
          chunked: true,
          detail: chunkReportDetail({
            gate: 'build',
            secondsLeft: decision.secondsLeft,
            minChunkS,
          }),
        };
    onChunked?.(chunked.detail);
    return chunked;
  }
  // A real verdict — green or a genuine failure — ends the series either way.
  D.spine.clearNoStartRoundFor(wtPath, 'build');
  gateCacheClose(wtPath, 'next-build', c.key, r.ok);
  return r;
}

export function runBuildPreflight(wtPath, { timeoutMs = BUILD_GATE_TIMEOUT_MS } = {}) {
  const D = landDeps();
  // test hook honoured ONLY under --dry-run (like DW_FAKE_REBASE) — a leaked
  // env var must never bypass the real build gate in a production land.
  if (D.env.DRY && process.env.DW_FAKE_BUILD) {
    return { ok: process.env.DW_FAKE_BUILD !== 'fail', detail: 'DW_FAKE_BUILD' };
  }
  // plan 3961 review fix: WHAT this gate runs is configuration — `land.buildCommand`, carrying
  // the whole invocation as `{ command, args }` so a project that does not build with pnpm at
  // all is still expressible — never a project package name spelled in the generic core. `null`
  // (the CORE default) means this project has no build step: skip with a real green rather than
  // a caller-visible failure the pass-cache would read as a break.
  //
  // ONE resolution for both arms, deliberately: a dry run that narrated a different command
  // from the one a real land would execute would make every ordering assertion built on that
  // narration prove the wrong thing.
  const configured = D.coordConfig.loadCoordConfig(COORD_CONFIG_ROOT).land.buildCommand;
  if (configured === null) return { ok: true, detail: 'no land.buildCommand configured' };
  if (D.env.DRY) {
    D.spawn.run(configured.command, configured.args);
    return { ok: true };
  }
  try {
    execFileSync(configured.command, configured.args, {
      cwd: wtPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // plan 3436 D1: the caller's effective cap — the natural BUILD_GATE_TIMEOUT_MS unless the
      // shared chunk wall has less than that left. It was a bare 600_000 literal, which is why a
      // slow build could spend the whole wall (and then some) with nothing to stop it.
      timeout: timeoutMs,
      shell: process.platform === 'win32', // the configured command may be a .cmd on Windows (pnpm is)
      env: D.L.spawnEnv(), // plan 2604: no child inherits implicitly
    });
    return { ok: true };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    return {
      ok: false,
      timedOut: isSpawnTimeout(e),
      detail: out.split('\n').slice(-30).join('\n'),
    };
  }
}

// plan 3172: format ONE gate-outcome-telemetry.log line, byte-compatible with the pre-push
// hook's gate_outcome() (scripts/hooks/pre-push.sh) so both writers' lines parse identically for
// the plan-2530 Phase-2 cost/catch analysis. Pure (nowMs injectable) so done-worktree.test.mjs can
// pin the ISO second-precision timestamp and the dur_s clamp with no clock and no real gate. The
// dur_s clamp mirrors gate_outcome's: a non-integer, negative, or >86400 s value (a broken clock
// read) becomes the literal "unknown" rather than poisoning the Phase-2 wall-time ranking.
// plan 3997: two new OPTIONAL fields, both absent by default so every existing (push-shaped)
// caller's line stays byte-identical to before this plan. `phase` rides between `sel=` and the
// optional `failed=` (the position pre-push.sh's own header comment now documents) — its one value
// today is the literal `land`, marking a record one of this file's own land-preflight gate call
// sites wrote, as opposed to the pre-push hook. `failed` was previously never emitted by this
// formatter (only pre-push.sh's own gate_outcome() wrote it); it is accepted here too, strictly
// optional, so a land-phase starved-child record can carry `failed=PYTEST_STARVED` exactly as
// the plan's execution notes specify (core-noun-ok: PYTEST_STARVED is the shared verdict-enum
// member's own spelling, cited for the exact cross-reference).
// plan 4034 T3: a THIRD optional field, `workers`, rides strictly LAST — after `failed=` — so no
// existing field's position moves and every pre-existing (push-shaped) caller's line stays
// byte-identical. Its one writer today is the sibling heavy gate's full-suite land arm, whose
// whole-run cap is now derived from the admitted xdist worker count (that gate's own cap
// derivation): without it the telemetry
// records a `cap-kill` whose cap the reader cannot reconstruct, which is precisely what left the
// 2026-09-14 kill un-diagnosable. Only a positive integer is emitted — a null/NaN/0 reading is
// dropped rather than written as `workers=null`, so a consumer never has to parse a non-count.
export function formatGateOutcomeLine({
  branch,
  gate,
  result,
  durS,
  sel,
  nowMs = Date.now(),
  phase,
  failed,
  workers,
}) {
  const ts = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const dur = Number.isInteger(durS) && durS >= 0 && durS <= 86400 ? String(durS) : 'unknown';
  let line = `${ts} branch=${branch || 'unknown'} gate=${gate} result=${result} dur_s=${dur} sel=${sel || 'n/a'}`;
  if (phase) line += ` phase=${phase}`;
  if (failed) line += ` failed=${failed}`;
  if (Number.isInteger(workers) && workers > 0) line += ` workers=${workers}`;
  return line;
}

// ── prettier-drift check (plan 1723 E3) ──────────────────────────────
// Runs post-rebase, pre-merge. done-worktree rebases the branch onto the latest origin/master
// before merging; if master advanced to a NEWER prettier config (e.g. a different printWidth)
// the rebased tree can now FAIL `prettier --check` on files the worker's pre-rebase in-worktree
// check passed — surfacing today only as an ugly `pre-push: prettier --check FAILED` at the
// ephemeral merge (the 1710/1711 lands, 2026-07-11). This proactive CHECK converts that into a
// clean PRETTIER_DRIFT seam with the exact scoped fix. It is a CHECK ONLY — NEVER an auto-fix
// commit: an auto-commit changes the branch patch-id, so tryMarkerRepin (plan 1528 A1) would
// classify the land as rework regardless; auto-fixing would only turn a bookkeeping failure into
// a silent review-marker bypass (see the PRETTIER_DRIFT seam comment in done-worktree-lib.mjs).
// Scoped to the POST-rebase `git diff --name-only origin/master...HEAD` (prettier-relevant
// extensions, existing paths only); prettier applies .prettierignore to the paths it is handed.
// DW_FAKE_PRETTIER (drift|ok) is the test hook — honoured ONLY under --dry-run (a leaked env var
// must never bypass the real check in a production land, mirroring DW_FAKE_BUILD/DW_FAKE_MOBILE (core-noun-ok: names the actual env vars).
// plan 1723 review (F3/F4): run `pnpm exec prettier --check` over `files` in as many length-
// BOUNDED chunks as the count needs (via L.prettierArgChunks — the twin of scripts/hooks/pre-push.sh's
// `xargs -s 6000`), so a wide land can't overflow cmd.exe's command line into a spurious
// PRETTIER_DRIFT. Throws (like execFileSync) on the FIRST failing chunk so the caller's try/catch
// turns it into the seam. `pnpm exec prettier` needs node_modules — the caller guards its presence
// BEFORE calling this (F5).
function pnpmPrettierCheckChunked(cwd, files, { timeout } = {}) {
  const D = landDeps();
  const win = process.platform === 'win32';
  for (const chunk of D.L.prettierArgChunks(files, { win })) {
    execFileSync('pnpm', ['exec', 'prettier', '--check', ...chunk], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      shell: win, // pnpm is pnpm.cmd on Windows
      env: D.L.spawnEnv(), // plan 2604: no child inherits implicitly
    });
  }
}

export function runPrettierDriftCheck(wtPath) {
  const D = landDeps();
  if (D.env.DRY) {
    if (process.env.DW_FAKE_PRETTIER) {
      if (process.env.DW_FAKE_PRETTIER === 'deps-missing')
        return { ok: false, depsMissing: true, files: ['fake-drift.ts'] };
      const drift = process.env.DW_FAKE_PRETTIER === 'drift';
      return { ok: !drift, detail: 'DW_FAKE_PRETTIER', files: drift ? ['fake-drift.ts'] : [] };
    }
    return { ok: true, files: [] };
  }
  // The branch is linear on top of origin/master here (post-rebase), so three-dot == two-dot.
  // NB: this deliberately does NOT reuse changedFiles(wtPath) (which runs the same diff) — the two
  // want OPPOSITE failure behavior. changedFiles has no try/catch and MUST throw on a diff failure
  // (a silently-empty list would corrupt lane/content-scope, see its header comment); this gate must
  // DEGRADE to skip (the merge-push scripts/hooks/pre-push.sh prettier gate is the hard backstop), exactly the
  // split its own diff-on-worktree-branch documentation for the same reason (F11)
  // (core-noun-ok: wikiDiffOnWorktreeBranch is that project module's own function name).
  let diffOut = '';
  try {
    diffOut = D.spawn.run('git', ['-C', wtPath, 'diff', '--name-only', 'origin/master...HEAD']);
  } catch (e) {
    process.stderr.write(
      `done-worktree: prettier-drift check could not compute the post-rebase diff — ${e?.message || e}; ` +
        `skipping the proactive check (the merge-push .husky/pre-push prettier gate is the backstop).\n`,
    );
    return { ok: true, files: [] };
  }
  const candidates = D.L.prettierDriftCandidates(String(diffOut).split('\n').filter(Boolean));
  // Drop paths that no longer exist on disk (deleted / renamed-away) — prettier errors on a
  // missing path (mirrors the pre-push hook's existence filter).
  const files = candidates.filter((f) => existsSync(`${wtPath}/${f}`));
  if (!files.length) return { ok: true, files: [] };
  // F5: a MISSING node_modules (a docs-only-plus-non-code-data land whose cut-time install failed — E2's app-
  // source gate never fired, but the diff still has prettier-relevant .md files) would make
  // `pnpm exec prettier` fail with ENOENT, which the catch below would mis-report as PRETTIER_DRIFT
  // and send the session chasing a `prettier --write` fix that CANNOT clear the halt. Detect it
  // FIRST and signal it distinctly so the caller seams "run pnpm install", not a formatting fix.
  if (!existsSync(`${wtPath}/node_modules`)) return { ok: false, depsMissing: true, files };
  try {
    pnpmPrettierCheckChunked(wtPath, files, { timeout: 120_000 });
    return { ok: true, files };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    return { ok: false, detail: out.split('\n').slice(-30).join('\n'), files };
  }
}

// ── full scripts battery — shared by the land-time preflight (Part A, plan 2875 task 4) and
// the mandatory pre-deploy gate (Part B, plan 2875 task 4) ────────────────────────────────────
// The FLAT top-level `scripts/*.test.mjs` set — nightly-windows-suite.mjs's listScriptsTestFiles,
// imported directly (see the import comment above for why the old private copy of its isFile()
// guard is gone).
const BATTERY_LOCK_CLI = `${SCRIPTS_DIR}/battery-lock.mjs`;

// plan 2875 delta round 2 (cluster E, review fix): moved up from the sibling-gate section below —
// the battery preflight now ALSO routes its run through queued-run.mjs (see runFullBatteryPreflight),
// so both consumers need this constant. Resolved against THIS file's own directory (not wtPath),
// same reason as every other *_CLI constant in this section.
export const QUEUED_RUN_CLI = `${SCRIPTS_DIR}/queued-run.mjs`;

// plan 2875 cluster G (review fix): the battery's own nightly-windows-suite.mjs BATTERIES entry —
// reused for its `timeoutMs` (runFullBatteryPreflight) instead of a hand-copied literal, mirroring
// the sibling gate's own canonical-entry constant existing use below for the exact same reason
// (core-noun-ok: PYTEST_BATTERY is that module's own constant name) (a future retune of either number
// now reaches this preflight automatically instead of silently diverging from it). See
// `batteryBattery()` near the end of this file — plan 3961 T3.5c's non-mechanical deviation note —
// for why this cannot stay a module-top-level const.

// plan 2875 delta round 2 (cluster D, review fix): the spawnSync-result → { token, concArgs }
// decision itself is L.batteryLockAcquireOutcome (done-worktree-lib.mjs, pure) — extracted so the
// ETIMEDOUT-clamps-not-bypasses behavior is directly unit-testable without mocking spawnSync or
// waiting out a real multi-minute timeout. See its own comment for the full "why" (mirrored from
// the inline version this replaced).
// plan 3274 (review round, F2/CONFIRMED [lock-not-deadline-bounded]): acquireBatteryLock's own
// spawnSync `timeout` used to be a flat BATTERY_LOCK_ACQUIRE_TIMEOUT_MS regardless of the shared
// per-process chunk deadline — under chunking, the acquire wait could itself outlast most of the
// remaining budget (this constant is on the order of 30 minutes; a chunk wall can be as small as
// PREPUSH_MIN_CHUNK_S), only for the post-acquire recheck a few lines below to then discover there
// was nothing left to run. Pulled out pure so the clamp is directly unit-testable without spawning
// the real battery-lock CLI. `chunkCapMs === null` (chunking off) keeps the existing ceiling,
// byte-identical to before this fix — the same off-sentinel every other chunkCapMs consumer here
// already uses. Floored at 1ms, never 0: spawnSync's own `timeout` option treats `0` as "no
// timeout" (disabled) rather than "expire immediately", which would invert the intent for an
// already-exhausted budget. A timeout this short still resolves soundly either way — on our own
// ETIMEDOUT, `L.batteryLockAcquireOutcome` clamps to reduced concurrency rather than refusing
// outright (see that function's own header), so a tight clamp degrades gracefully instead of
// failing the acquire.
export function batteryLockAcquireTimeoutMs(chunkCapMs) {
  const D = landDeps();
  return chunkCapMs === null
    ? D.spine.BATTERY_LOCK_ACQUIRE_TIMEOUT_MS
    : Math.max(1, Math.min(D.spine.BATTERY_LOCK_ACQUIRE_TIMEOUT_MS, chunkCapMs));
}

// plan 3274 (review round, F1/CONFIRMED [ledger-subprocess-unbounded]): the battery and sibling-gate ledger
// helper subprocesses (carry-forward, remainder) used to run on a flat fixed `timeout` (180s for
// carry-forward, 60s for remainder) regardless of the shared per-process chunk deadline — under
// chunking, a single carry-forward call could burn up to 180s of e.g. a 480s budget BEFORE the
// initial chunk decision (battCap/its sibling-gate twin) is even consulted, silently spending real wall-clock
// time the shared deadline never gets credited for (the whole point of ONE process-wide deadline is
// that every consumer inside the process draws from the SAME well — see processChunkDeadlineEpoch's
// own header). Same clamp SHAPE as batteryLockAcquireTimeoutMs just above (same 1ms floor, same
// off-sentinel: spawnSync's own `timeout` option treats `0` as "no timeout" (disabled) rather than
// "expire immediately", which would invert the intent for an already-exhausted budget) —
// generalized over the fixed ceiling since each of the three call sites below has its own
// (180_000 for carry-forward and its sibling-gate twin, 60_000 for remainder). `chunkCapMs === null`
// (chunking off) keeps the existing fixed value as the ceiling, byte-identical to before this fix.
export function ledgerSubprocessTimeoutMs(fixedMs, chunkCapMs) {
  return chunkCapMs === null ? fixedMs : Math.max(1, Math.min(fixedMs, chunkCapMs));
}

// plan 3274 (final round, findings 003aa8/52183d/CONFIRMED): the clamp above is RIGHT for a query
// and WRONG for a salvage WRITE, and the difference is what the 1ms floor buys in each case.
//
// The floor exists so a spent budget cannot become spawnSync's `timeout: 0`, which means "no
// timeout" and would invert the intent. For the remainder QUERY that is fine: a killed query
// yields no counts, chunkReportDetail degrades to a countless banner, nothing is lost. For the
// ledger MERGE it is not, because the `finally` further down unconditionally `rmSync`s the events
// file — so a merge killed at 1ms does not cost "only re-work" (as this file's own earlier comment
// claimed), it PERMANENTLY discards the files that run just proved green. That is the exact
// scenario chunking exists for — a gate that exhausts the shared deadline — so the previous
// round's clamp made the plan's core mechanism non-converging precisely where it has to work:
// every re-push would re-run the same files forever and never bank progress.
//
// So a salvage WRITE gets a guaranteed floor: still bounded (never the flat 60s overrun the
// previous round correctly removed) but never so small it cannot start. Same reasoning already
// recorded on releaseBatteryLock — losing the subprocess costs more than overrunning it — applied
// where it was missed. `Math.min(fixedMs, …)` on the floor keeps the caller's own ceiling
// authoritative, so this can only ever RAISE a clamped value toward it, never past it. Chunking
// off keeps the fixed ceiling, byte-identical.
export const LEDGER_SALVAGE_FLOOR_MS = 5_000;

export function ledgerSalvageTimeoutMs(fixedMs, chunkCapMs) {
  if (chunkCapMs === null) return fixedMs;
  return Math.max(Math.min(fixedMs, LEDGER_SALVAGE_FLOOR_MS), Math.min(fixedMs, chunkCapMs));
}

// plan 4236 T1 (H1): the land's scripts battery was the ONE heavy runner that never asked the
// per-slot budget — the sibling gate's worker policy and both vitest configs already size
// themselves from perSlotWorkerBudgetDetail, while `node --test` fell back to its own default of
// `availableParallelism() - 1` (19 on the 20-thread dev box), so a single battery was sized to the
// whole machine and the queue's two slots could never make two of anything fit (2026-09-26
// incident: CPU 99%, three full-box jobs at once). The cap reads the CPU axis (`.cpuBudget`), never
// `.workers`: the memory axis is the sibling gate's measured per-worker peak and says nothing about
// `node --test` (decision S1) — hence `budget: null`, which also keeps this call free of the
// budget-file read and the live freemem() probe. An explicit `--test-concurrency` already in
// `concArgs` (the plan-1795 overflow clamp from batteryLockAcquireOutcome, 2) always wins — it is
// the smaller number by construction, and appending a second flag would leave node's own
// last-wins parsing to decide. Pure so a test pins it with an injected CPU count / env / budget
// function, never the real box's CPU (the land's call sites below pass landCpuCount()).
export function batteryConcurrencyArgs(concArgs, cpu, env, budgetDetail) {
  const base = Array.isArray(concArgs) ? [...concArgs] : [];
  if (base.some((a) => /^--test-concurrency(=|$)/.test(String(a)))) return base;
  const { cpuBudget } = budgetDetail(cpu, env, { budget: null });
  return [...base, `--test-concurrency=${Math.max(1, Math.floor(cpuBudget))}`];
}

function landBatteryConcArgs(concArgs = []) {
  const D = landDeps();
  return batteryConcurrencyArgs(
    concArgs,
    D.spine.landCpuCount(),
    process.env,
    D.testQueue.perSlotWorkerBudgetDetail,
  );
}

// plan 4236 T3(c): the acquire CLI writes its reap verdict (`battery-lock: reaped … — reason: …`)
// and its holder-pid refusal to STDERR, which acquireBatteryLock pipes and batteryLockAcquireOutcome
// never reads — so every land swallowed the one line that would have said WHY a sibling's battery
// lock was taken (the 2026-09-26 127-min age reap left no trace anywhere). Echo exactly those lines
// into the land log. Pure over its inputs (`log` injected) so a test pins it without a real CLI.
export function surfaceBatteryLockDiagnostics(stderr, log = console.log) {
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .filter((l) => /^battery-lock: (reaped|IGNORING --holder-pid)/.test(l));
  for (const l of lines) log(`done-worktree: ${l}`);
  return lines.length;
}

// plan 4236 T3(a): the land declares ITS OWN pid as the lock's long-lived holder (`--holder-pid`,
// the shape pre-push-core.sh already uses). done-worktree is the process that spans the whole
// battery run, so a crashed land is reaped on the next poll (dead-pid) and a live one is protected
// past the 120-min age gate up to battery-lock's HARD_STALE_MIN, identity-checked. On Linux and
// native Windows node, process.pid is the OS pid `process.kill` probes — no MSYS translation.
export function batteryLockAcquireArgs(cliPath, label, holderPid = process.pid) {
  return [cliPath, 'acquire', '--label', label, '--holder-pid', String(holderPid)];
}

function acquireBatteryLock(wtPath, label, chunkCapMs = null) {
  const D = landDeps();
  try {
    const r = spawnSync(process.execPath, batteryLockAcquireArgs(BATTERY_LOCK_CLI, label), {
      cwd: wtPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: batteryLockAcquireTimeoutMs(chunkCapMs),
      env: D.L.spawnEnv(), // plan 2604: no child inherits implicitly
    });
    surfaceBatteryLockDiagnostics(r?.stderr);
    return D.L.batteryLockAcquireOutcome(r);
  } catch {
    return { token: null, concArgs: [] };
  }
}

// plan 3274 (land-side ledger clamps round): this release is DELIBERATELY not clamped to the
// shared chunk budget, unlike every ledger subprocess above it. The clamp helpers floor at 1ms
// once the budget is spent (see ledgerSubprocessTimeoutMs), which is right for the ledger calls
// — they are pure salvage, and losing one costs only re-work on the next chunk — but wrong here:
// a 1ms kill would abort a HEALTHY release and strand the battery lock, which blocks every OTHER
// session until the lock goes stale on its own. A hung release costs this land up to 60s past the
// wall; a stranded lock costs siblings much more. So the asymmetry is the point, not an oversight
// — do not "finish the clamp" here without first giving the lock CLI a release path that cannot
// be lost.
function releaseBatteryLock(wtPath, token) {
  const D = landDeps();
  if (!token) return;
  try {
    spawnSync(process.execPath, [BATTERY_LOCK_CLI, 'release', '--token', token], {
      cwd: wtPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      env: D.L.spawnEnv(),
    });
  } catch {
    /* best-effort close-out only — a release failure must never fail the land (mirrors the
       hook's own `|| true` on its release call) */
  }
}

// plan 2875 delta round 2 (cluster D/E/G, review fix): the ONE safe spawn+timeout+tree-kill seam
// for a heavy command run THROUGH queued-run.mjs's shared heavy-test ticket — shared by the sibling
// preflight and (as of this fix) the scripts battery preflight, so a hardening to one can never
// silently miss the other (the exact drift class kill-tree.mjs's own header warns about).
//
// WHY NOT execFileSync's `timeout` option (what the sibling gate's preflight used before this fix, finding
// f2c688): on a timeout, execFileSync's own kill reaches ONLY the direct child (queued-run.mjs) —
// and on Windows `child.kill()` is an unconditional TerminateProcess, not a catchable signal, so
// queued-run.mjs's OWN SIGTERM handler (test-queue.mjs's tree-kill-then-release-slot) never runs.
// The heavy command it spawned (the sibling suite / node --test) is orphaned, still holding the queue slot
// until its own stale reap. spawnWithTreeKill + an EXPLICIT killProcessTree on OUR OWN timeout
// reaches the whole descendant tree directly (taskkill /pid <pid> /T /F on Windows — kill-tree.mjs's
// own documented contract), never relying on a signal Windows will not deliver.
//
// plan 2875 delta round 3 (review fix): output capture goes through boundedAppend (finding
// b8d981/d83dbb — the SAME cap nightly-windows-suite.mjs's own spawnQueuedCommand uses, reused
// rather than a second unbounded `out += d`), and the {code, error, timedOut} → outcome decision is
// delegated to L.testQueueRunOutcome (finding 8e5a63/c9d050 — pure, unit-tested there; see its own
// header for why `timedOut` must be checked before `code`).
//
// plan 2875 delta round 4 (finding 5598, review fix): the two grace periods below bound the
// timeout's OWN kill escalation. killProcessTree is best-effort by contract (its own header:
// "already dead / permission blip — best-effort") — a signal that never reaches every descendant
// (EPERM, an uninterruptible-sleep grandchild, a stuck taskkill) used to leave the `await
// waitForExit(child)` below waiting on a 'close' that might never fire, turning "the gate times
// out" into "the gate wedges forever" — strictly worse than the timeout it exists to enforce.
// Mirrors PREEMPT_GRACE_MS's SIGTERM→SIGKILL escalation shape (the worktree-lock preempt path,
// above) rather than inventing a new one: first SIGTERM (already sent below), then SIGKILL after
// a grace period, then — if 'close' STILL never fires — give up waiting and return a verdict
// anyway rather than hang. `killProcessTree` is never touched here; only how long this function
// is willing to wait on it changes.
const BATTERY_KILL_ESCALATE_GRACE_MS = 5_000;

const BATTERY_KILL_HANG_GUARD_MS = 5_000;

// plan 3223 (review round: finding 6/PLAUSIBLE, agreed): `env` is an OPTIONAL extra layer, merged
// over `process.env` by `L.spawnEnv()` exactly the way every other caller's own layer already is
// (spawnEnv's own contract: "later wins", a `null`/`undefined` layer skipped) — additive by
// construction, so a caller that omits it (runFullBatteryPreflight, unchanged) gets
// `L.spawnEnv(undefined)`, which `spawnEnv`'s own `layers.filter(Boolean)` collapses to exactly
// `L.spawnEnv()` — BYTE-IDENTICAL to before this parameter existed. This replaces
// the sibling gate's own preflight's own prior mechanism (core-noun-ok: runPytestPreflight is
// that module's own function name) (temporarily mutating global `process.env` and
// restoring it in a `finally`) with the explicit-layer shape spawnEnv was already built for,
// closing the race that mutation risked: a concurrent `runViaTestQueue` call in this SAME process
// (nothing in this function's own contract forbids one) could otherwise inherit a
// GATE_LEDGER_KEY/GATE_LEDGER_EVENTS_FILE pair an unrelated caller never derived, activating
// the sibling suite's own conftest ledger plugin (core-noun-ok: backend/scripts/conftest.py names
// the real external file this pin is about) under a key that caller's own spawn never asked for.
//
// ── plan 4003 T1: `timeoutMs` caps the RUN, not the queue wait ────────────────────────────────
//
// `slotWaitOutsideCap` opts this call into starting its kill timer at the moment `queued-run.mjs`
// prints TEST_SLOT_ADMITTED_MARKER — the wrapped command starting NOW, whether the queue awarded
// it a genuine slot or fail-opened (`TEST_QUEUE_DISABLE=1`, a queue I/O error, or max-wait expiry:
// `queued-run.mjs` emits the same marker on those paths too, immediately before running the
// command unserialized — plan 4006 review round 1, finding 0cb34c). A fail-open is deliberately
// NOT starvation: the command really is starting immediately, which is exactly the moment this
// cap must begin bounding it. Instead of at spawn: before this fix, one timer covered the slot
// wait AND the run — five local land batteries on 2026-09-13 were tree-killed at the 2400s cap
// with no failing test in any of them, because measured slot waits that day ran 38s–902s and came
// straight out of the run's budget.
//
// DEFAULT `false` — byte-identical to before this plan for any caller that omits it. The two
// chunk-capable gates pass `!runCap.usingChunkCap`, and that exception is the whole reason this is
// a parameter rather than unconditional: under cloud chunking the cap is NOT the gate's own
// natural cap, it is this process's slice of a wall that must be respected whatever the time went
// on. A chunk-capped run that donated its slot wait back to itself would overshoot the 600s Bash
// wall and be killed from outside, losing the very CHUNKED report that makes the next invocation
// resume. So under chunking the wait keeps counting, exactly as today, and the gate reports
// CHUNKED — which is already the designed, non-destructive outcome there.
//
// Until the marker arrives the timer is armed at `slotAdmissionBackstopMs()` — test-queue's own
// fail-open ceiling plus a grace — so a child that never reaches its slot at all is still bounded.
// `acquire` itself bails and proceeds unserialized at that ceiling, so in a healthy queue this
// backstop is unreachable; it exists for a child wedged BEFORE the wait (a hung git read in the
// scheduling-class probe, say), which no other timer covers.
// Exported for plan 4003 T1's acceptance test only: the admission contract is a real interaction
// between three processes (this timer, `queued-run.mjs`'s marker, `test-queue.mjs`'s award), and
// the only honest proof is to drive it through the real wrapper against a real (scratch) queue.
// Nothing in production imports it.
export async function runViaTestQueue(
  wtPath,
  // plan 4034 T3: `workers` is narration ONLY — the admitted xdist worker count the caller derived
  // this run's `timeoutMs` from, so the cap line below says WHY the cap is the number it is. It
  // never changes what is spawned; omitted (every caller but that one) keeps the line
  // byte-identical.
  { cmd, cmdArgs, label, timeoutMs, env, slotWaitOutsideCap = false, workers = null },
) {
  const D = landDeps();
  const queuedArgs = [QUEUED_RUN_CLI, '--label', label, '--', cmd, ...cmdArgs];
  const child = D.killTree.spawnWithTreeKill(process.execPath, queuedArgs, {
    cwd: wtPath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: D.L.spawnEnv(env), // plan 2604: no child inherits implicitly; `env` is this call's own extra layer
  });
  let out = '';
  // plan 3827 review round 2 (5-angle finding, CONFIRMED): boundedAppend keeps only the TAIL once
  // the combined capture exceeds its 4 MiB cap — detected here WITHOUT re-deriving that cap value
  // (nightly-windows-suite.mjs's own MAX_CAPTURED_OUTPUT_CHARS is not exported, and is out of scope
  // to change) by comparing boundedAppend's own result length against what the unbounded
  // concatenation's length WOULD have been: any time they differ, boundedAppend actually sliced
  // something off the front, which is the ONE fact this needs. plan 3827 F5 (efficiency, PLAUSIBLE,
  // accepted): that comparison used to materialize the unbounded concatenation itself (`out + chunk`)
  // just to read its `.length` — a second full copy of a capture that can reach several megabytes,
  // every single chunk. String concatenation length is exactly the sum of the two operands' lengths,
  // so `out.length + chunk.length` is the same number without allocating the string at all.
  let captureTruncated = false;
  let timedOut = false;
  const extraTimers = [];
  let hangGuardResolve;
  const hangGuard = new Promise((resolve) => {
    hangGuardResolve = resolve;
  });
  let timer = null;
  const onDeadline = () => {
    timedOut = true;
    D.killTree.killProcessTree(child, { signal: 'SIGTERM', force: true });
    extraTimers.push(
      setTimeout(() => {
        // SIGTERM's own grace period elapsed with no 'close' — escalate to SIGKILL over the whole
        // tree (plan 2738's escalation contract, the same one terminateWorktreeLockHolder uses).
        D.killTree.killProcessTree(child, { signal: 'SIGKILL', force: true });
        extraTimers.push(
          setTimeout(() => {
            // Both escalation grace periods elapsed with no 'close'/'error' — resolve anyway.
            // `error: null` keeps this in testQueueRunOutcome's ordinary `timedOut` branch rather
            // than its "failed to spawn" one (that branch is reserved for a process that never
            // started at all, per waitForExit's own doc comment — this one very much started).
            hangGuardResolve({ code: null, error: null });
          }, BATTERY_KILL_HANG_GUARD_MS),
        );
      }, BATTERY_KILL_ESCALATE_GRACE_MS),
    );
  };
  // plan 4003 T1: ONE re-armable deadline, never two live timers — admission REPLACES the
  // pre-admission backstop rather than adding to it, so a run can only ever be killed by the cap
  // that is currently in force. Declared BEFORE the stream handlers below purely for reading
  // order: `noteAdmission` calls it, and a reader should not have to prove that no `data` event
  // can fire before this line runs (none can — the whole body up to the `await` is synchronous).
  const armDeadline = (ms) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onDeadline, ms);
  };
  // plan 4003 T1: the admission scan. Carries at most one marker's worth of trailing bytes between
  // chunks, so a marker split across two `data` events is still seen, and the scan costs O(1)
  // memory rather than growing with the capture. It stops the moment admission is recorded — after
  // that the marker is ordinary captured output like any other line.
  //
  // plan 4006: `makeAdmissionScanner` itself moved to test-queue.mjs — the SAME scanner
  // nightly-windows-suite.mjs's own spawnQueuedCommand now reuses, rather than a second hand-typed
  // copy beside the marker it recognizes. A core module may not import scripts/coord/test-queue.mjs
  // directly (Rule 3), so it arrives through the container's `testQueue` group; the local binding
  // below is a plain read of that member, never a re-definition of the scanner.
  const spawnedAtMs = monotonicNowMs();
  let admittedAtMs = null;
  // gpt-review r1 (6e5e23): ONE SCANNER PER STREAM. A single shared buffer fed by both `data`
  // callbacks can be poisoned by interleaving — stderr delivers the marker's first bytes, a stdout
  // chunk lands between, and the marker is no longer contiguous in the buffer, so it is never
  // recognized. The run then stays bound by the ~22-minute pre-admission backstop instead of its
  // own cap and is killed for taking longer than that, silently reintroducing exactly the
  // false-kill this plan exists to remove. Two independent scanners cannot interleave with each
  // other, and either one firing is proof of admission — which also keeps this correct if the
  // marker ever moves back to stdout.
  const { makeAdmissionScanner } = D.testQueue;
  const scanOut = makeAdmissionScanner();
  const scanErr = makeAdmissionScanner();
  const noteAdmission = (scan, chunk) => {
    if (admittedAtMs !== null) return;
    if (!scan(chunk)) return;
    admittedAtMs = monotonicNowMs();
    // The run's own clock starts HERE, replacing the pre-admission backstop.
    armDeadline(timeoutMs);
  };
  const appendOut = (chunk, scan) => {
    if (slotWaitOutsideCap && scan) noteAdmission(scan, chunk);
    const capped = boundedAppend(out, chunk);
    if (capped.length < out.length + chunk.length) captureTruncated = true;
    out = capped;
  };
  child.stdout?.on('data', (d) => appendOut(String(d), scanOut));
  child.stderr?.on('data', (d) => appendOut(String(d), scanErr));
  armDeadline(slotWaitOutsideCap ? D.testQueue.slotAdmissionBackstopMs() : timeoutMs);
  const { code, error } = await Promise.race([D.killTree.waitForExit(child), hangGuard]);
  clearTimeout(timer);
  for (const t of extraTimers) clearTimeout(t);
  const tail = out.split('\n').slice(-40).join('\n');
  // gpt-review r1 (d62c6c): SURFACE the slot wait rather than only returning it. "Was that gate
  // slow, or merely queued?" is the exact question the 2026-09-13 post-mortem could not answer from
  // a land log, and the answer is now known here. Narrated only when the wait was long enough to
  // matter (a sub-minute wait is noise) or when the run was killed anyway (where it is the first
  // thing a reader needs), so a healthy land gains at most one line.
  if (slotWaitOutsideCap && admittedAtMs !== null) {
    const waitMs = Math.max(0, admittedAtMs - spawnedAtMs);
    if (waitMs >= 60_000 || timedOut) {
      console.log(
        `done-worktree: ${label}: waited ${Math.round(waitMs / 1000)}s in the shared heavy-test ` +
          `queue before it was admitted; the ${Math.round(timeoutMs / 1000)}s cap covers only the ` +
          `run itself (plan 4003 T1)` +
          // plan 4034 T3: for the one caller that passes `workers` the cap is no longer a flat
          // literal — it is derived from the
          // worker count the run was ACTUALLY admitted with, so the line that names the cap must
          // also name that count, or the next re-derivation is back to guessing (the 2026-09-14
          // kill's own log had the worker count and the cap in two unrelated lines).
          (Number.isFinite(workers) ? `, derived for ${workers} admitted worker(s)` : ''),
      );
    }
  } else if (slotWaitOutsideCap && admittedAtMs === null) {
    // The marker never arrived, so this run was bounded by the pre-admission backstop rather than
    // by its own cap. Never silent: that is a protocol break between this spine and
    // `queued-run.mjs`, and it degrades to the pre-4003 behaviour with no other trace.
    console.log(
      `done-worktree: ${label}: the queued-run slot-admission marker never arrived — this run was ` +
        `bounded by the pre-admission backstop, not by its own cap (plan 4003 T1; check that ` +
        `scripts/queued-run.mjs still announces the slot-admission marker)`,
    );
  }
  // plan 4006: a run whose slot was NEVER granted is not a genuine cap-kill — nothing this run's
  // own timeoutMs bounds ever ran at all, so a caller's `ok:false` must not read as "the tests
  // failed" the way a real timedOut-with-admission does. `neverAdmitted` is TRUE only when this
  // call opted into the admission scan (`slotWaitOutsideCap`) AND the marker never arrived.
  //
  // plan 3961 review (rev-telemetry): this comment used to go on to claim `neverAdmitted` is
  // ALWAYS paired with `timedOut`, on the reasoning that until admission `armDeadline` is counting
  // down the pre-admission backstop, so only that backstop can end the run. THAT IS FALSE, and the
  // consumer had been written to trust it (`if (timedOut && neverAdmitted)`), which silently
  // discarded the unpaired case. The wrapper can also end on its OWN before admission: the marker
  // is printed from inside `withTestSlot`'s callback, which never runs if the slot acquire
  // rejects, and queued-run then exits 1 by an ordinary child exit no deadline timer fired for.
  // The classifier now keys on `neverAdmitted` alone and tells the two apart by `timedOut` for the
  // message only. `admissionMeasuredWaitMs` is the
  // actual elapsed time from spawn to the moment this call resolved (kill included), for the
  // honest "killed after Ns" message `testQueueRunOutcome` builds — never `timeoutMs`, which this
  // run's own cap never got the chance to bound.
  const neverAdmitted = slotWaitOutsideCap && admittedAtMs === null;
  const admissionBackstopMs = slotWaitOutsideCap
    ? D.testQueue.slotAdmissionBackstopMs()
    : undefined;
  const admissionMeasuredWaitMs = neverAdmitted
    ? Math.max(0, monotonicNowMs() - spawnedAtMs)
    : undefined;
  // plan 3274: `timedOut` rides along on the outcome (additive — every existing caller reads only
  // `.ok`/`.detail`) so a chunk-capped caller can tell "this run hit ITS cap" from "this run failed
  // for a real reason" without re-deriving the distinction from `outcome.detail`'s prose.
  //
  // plan 3827 review round 2 (angle-B/C, CONFIRMED): `terminationUnproven` — true whenever this run
  // did NOT end in a genuine, complete test-process exit: a spawn failure (`error` set, `code` never
  // assigned), or the tree-kill/hang-guard collapse (`code: null` with no `error`, from the timeout
  // arm above). A real exit — pass OR fail — always yields a numeric `code` here, so this is exactly
  // "code is not a real exit code, and not because we already know why (timedOut, checked
  // separately by batteryIsolationRecheck)". Purely additive, same as `timedOut`.
  //
  // `captureTruncated` (see appendOut above) rides along the same way — true whenever ANY append
  // truncated the buffer.
  //
  // plan 3827 operator ruling R1 (2026-09-09): this function no longer computes a failing-file
  // report at all — the text-parsing grammars that used to feed one (`parseBatteryFailureReport`
  // via `batteryDetailAndFailureFiles`) are deleted. The battery call sites that need one
  // (`runFullBatteryPreflight`, `runSelectedBatteryPreflight`) read it from the reporter's own
  // destination file via `batteryFailureReportFromEvents` and attach it to their own returned
  // outcome — this function stays the one shared spawn+capture seam for BOTH the sibling and
  // battery halves, and neither ever read `failureFiles`/`failureComplete` off it directly.
  //
  // plan 4003 T1: `slotWaitMs` is how long this invocation sat in the shared heavy-test queue
  // before `queued-run.mjs` announced its slot — additive, read by nobody's verdict, and the one
  // number that tells a post-mortem whether a slow gate was slow or merely queued. `null` when the
  // marker was never scanned for (`slotWaitOutsideCap` false — today's chunked path) or never
  // arrived.
  return {
    ...D.L.testQueueRunOutcome({
      code,
      error,
      timedOut,
      tail,
      label,
      timeoutMs,
      // plan 4006: threaded through so testQueueRunOutcome can classify a never-admitted kill as
      // STARVED (its own `starved: true` branch) rather than an ordinary cap-kill — see that
      // function's own header for why this must be checked before the generic `timedOut` branch.
      neverAdmitted,
      admissionMeasuredWaitMs,
      admissionBackstopMs,
    }),
    timedOut,
    terminationUnproven: error != null || typeof code !== 'number',
    captureTruncated,
    slotWaitMs: admittedAtMs === null ? null : Math.max(0, admittedAtMs - spawnedAtMs),
  };
}

// `node --test scripts/*.test.mjs` — the WHOLE battery, never diff-scoped and never pass-cached
// (unlike runBuildPreflightCached/a project's own UI gate's gateCacheCheck above): this is the plan's
// "non-negotiable … regardless of per-push tiering" hard wall, so it must physically re-run every
// time `--deploy` fires rather than trust a prior content-identical green. Its run cap is DERIVED
// (plan 4034 T4): `batteryRunCapMs(runFiles.length, perSlotWorkerBudget(landCpuCount()))` — the
// suite-runner module's own derivation beside the number it is floored at (2400s, that module's
// 'battery' entry), reused rather than a hand-copied literal that could silently drift from it.
// DW_FAKE_BATTERY (ok|fail) is the test hook (honoured ONLY under --dry-run, like every
// other DW_FAKE_* preflight override in this file).
// plan 3223 (scoped fix round): `useLedger` is an EXPLICIT opt-in parameter, defaulting to OFF
// (mirroring RBR_LEDGER's own per-caller opt-in shape in the shell half, plan E3) — replacing an
// earlier version that inferred ledger participation by string-matching `wtPath` against the
// deploy-gate marker `deployGateWorktreePath` mints elsewhere. That inference was a brittle
// coupling to a path literal minted in a different function, and existed only because this
// function's caller sites weren't yet in scope to receive an explicit flag. They are now: the
// ordinary land-preflight caller (runFullBatteryPreflightCached) opts IN; the `--deploy`
// pre-deploy wall's own direct call passes nothing and gets the safe default, OFF — that wall's
// charter ("must physically re-run every time --deploy fires", plan E5) is non-negotiable, and
// the default-off direction means a future caller that forgets to pass the flag degrades to
// "ledger never engages" (today's behavior) rather than silently trusting a cached partial
// result on a hard wall that must never trust one.
//
// plan 3223 (review round: finding 9/CONFIRMED): ONE module-level constant, reused by BOTH the
// battery half below and the sibling gate's half further down (see that section's own comment). Before
// this fix, runFullBatteryPreflight declared this same path as a function-local `LEDGER_CLI`, and
// the sibling gate's half separately declared it again, module-level, under its own name — two names
// (core-noun-ok: PYTEST_LEDGER_CLI is that module's own constant name)
// for one path. One name, one declaration.
export const LEDGER_CLI = `${SCRIPTS_DIR}/battery-ledger.mjs`;

// ── plan 3436 D2: the no-start tally's storage ────────────────────────────────────────────────
//
// Worktree-local, exactly like plan 3295's `land-gates-proven.json` sidecar beside it, and for the
// same lifetime reasons (`.scratch/` is gitignored repo-wide; teardown removes the whole worktree,
// so the file cannot outlive the land it describes; a re-invocation and a `--prep` child both see
// it). It is a SEPARATE file from that one deliberately — see the pure helpers' header in
// done-worktree-lib.mjs for why neither of the plan's two proposed homes works.
//
// Unlike `recordLandGateProven`, these writes carry NO `IS_PREP` guard: the `--prep` path is
// precisely the one this bound exists to cover (its own UI-verification gate runs uncached, so it re-burns the
// same wall every invocation and `GATE_NON_CONVERGENT` can never fire there).
const NO_START_SIDECAR_REL = '.scratch/land-chunk-nostart.json';

export const noStartSidecarPath = (wtPath) => `${wtPath}/${NO_START_SIDECAR_REL}`;

// DRY hook: DW_FAKE_NO_START_TALLY injects the sidecar JSON so the bound is provable from a
// --dry-run subprocess with no scratch worktree (mirrors DW_FAKE_LAND_GATES_PROVEN). Honoured ONLY
// under --dry-run — a leaked env var must never fabricate a stop in a production land.
export function readNoStartTally(wtPath) {
  const D = landDeps();
  if (D.env.DRY) {
    const raw = process.env.DW_FAKE_NO_START_TALLY;
    return raw === undefined ? null : D.L.parseNoStartTally(raw);
  }
  try {
    return D.L.parseNoStartTally(readFileSync(noStartSidecarPath(wtPath), 'utf8'));
  } catch {
    return null; // absent / unreadable ⇒ no rounds counted ⇒ one extra round, never a false stop
  }
}

// Best-effort, but NEVER silent (gpt-review 800aae / 5e31e7 / 557e57 / 6ecc7e — four finders, one
// defect). A land must not fail because a `.scratch` write did, so this still swallows the error —
// but a write that always fails means the bound this plan exists to add never trips, and the
// original catch made that indistinguishable from a healthy run. The warning is the difference
// between "no bound, and you can see why" and "no bound, silently".
export function writeNoStartTally(wtPath, payload) {
  const D = landDeps();
  if (D.env.DRY) return; // dry trace only — never touch a real worktree's `.scratch`
  try {
    mkdirSync(`${wtPath}/.scratch`, { recursive: true });
    writeFileSync(noStartSidecarPath(wtPath), JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error(
      `done-worktree: could not persist the chunk no-start tally (${e.message || e}) — the land ` +
        `continues, but the two-strikes did-not-start bound (plan 3436 D2) cannot fire while this ` +
        `write keeps failing, so watch for a gate reporting CHUNKED round after round.`,
    );
  }
}

// The series key the tally is counted under. Plan 3436 keyed it on the head sha (read through
// `resolveHeadOid`, gpt-review 7e571d, so it honours `DW_FAKE_BRANCH_TIP` under DRY); that read
// survives only for a legacy sha-keyed tally below.
//
// plan 4192: the key is the LAND, from the very first round — never the head sha. A head-of-queue
// rebase moves HEAD without changing the land, and keying on the sha handed every post-rebase round
// a fresh tally, so the two-strikes bound never fired on a land that kept not starting. In order:
//   1. the key the tally file already carries, when it is a land key — a series never switches
//      keys mid-land, whatever gets written beside it later;
//   2. the land id of this worktree's `gatesProven` sidecar (`land:<landId>`), when one exists;
//   3. a freshly minted `land:wt-<uuid>` — the case gpt-review ffef29/9e14be caught: a gate that
//      never starts proves nothing, so no sidecar exists yet, and a sha fallback there reset the
//      count at every rebase. The first bump persists this key in the tally file, so (1) returns
//      it from then on. Lifetime = the worktree's, exactly like the gates sidecar's own land id.
// A legacy tally keyed on a sha still counts while HEAD has not moved (the plan-3436 series it
// was written under); once HEAD moves it is replaced by a land series.
// The sidecar's `landId` is read raw (no roster needed: only the id matters here), off
// DW_FAKE_LAND_GATES_PROVEN under --dry-run exactly like `readLandGatesProven`.
export function noStartTallyKey(wtPath) {
  const stored = readNoStartTally(wtPath)?.sha;
  if (typeof stored === 'string' && stored.startsWith('land:')) return stored;
  if (typeof stored === 'string' && stored && stored === resolveHeadOid(wtPath)) return stored;
  const landId = landGatesSidecarLandId(wtPath);
  return landId ? `land:${landId}` : `land:wt-${randomUUID()}`;
}

function landGatesSidecarLandId(wtPath) {
  const D = landDeps();
  let raw;
  if (D.env.DRY) raw = process.env.DW_FAKE_LAND_GATES_PROVEN;
  else {
    try {
      raw = readFileSync(landGatesSidecarPath(wtPath), 'utf8');
    } catch {
      return '';
    }
  }
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const id = JSON.parse(raw)?.landId;
    return typeof id === 'string' && /^\S+$/.test(id) ? id : '';
  } catch {
    return '';
  }
}

// plan 3961 T3.5c: recordNoProgressRound/chunkGateStartDecision/activeChunkWallVar/
// noStartGateResult moved here WITH the no-start-tally trio above (readNoStartTally/
// writeNoStartTally/noStartTallyKey) rather than staying spine-resident T2.2 bag members: none of
// the four has a call site anywhere outside this file's own battery/build cluster (checked by a
// full-file grep before this move) — only `clearNoStartRoundFor` does (the not-yet-carved project
// UI-gate block calls it directly), which is why THAT one alone stays behind, reached from here as
// `D.spine.clearNoStartRoundFor`. Moving these four keeps every one of their bare call sites (in
// runBuildPreflightCached/runFullBatteryPreflight, and in `spineBag()` back in the spine) exactly
// as their own tests already pin them, with no container prefix to grow around.

// Record one round that retired NOTHING for `gate` and return the resulting count/verdict.
//
// gpt-review 20477a / d22336 / afa3b3 (three finders, one defect): the bound cannot key on
// "did not start" alone. `build` and a project's own UI gate have no per-file ledger, so a round the chunk cap
// KILLED MID-RUN proves exactly as much as a round that never started — nothing — and plan 3374's
// convergence counter cannot see it either (that one is measured against the ledger these two gates
// do not have). Without counting it, a build whose wall-clock simply exceeds one chunk restarts from
// scratch forever while reporting healthy CHUNKED every round. The two heavy gates do NOT call this
// on a started round: their chunk-killed rounds are plan 3374's business, scored against real green
// counts, and double-counting them here would fire this bound on a gate that is making progress.
export function recordNoProgressRound(wtPath, gate) {
  const D = landDeps();
  const sha = noStartTallyKey(wtPath);
  if (!sha) return { noStartRounds: 0, exhausted: false };
  const bumped = D.L.bumpNoStartRound(
    readNoStartTally(wtPath),
    sha,
    gate,
    D.batteryLedger.NON_CONVERGENT_ROUNDS,
  );
  writeNoStartTally(wtPath, bumped.tally);
  return { noStartRounds: bumped.rounds, exhausted: bumped.exhausted };
}

// ── plan 3436 D1+D2: the ONE decision every chunk-capped gate makes ───────────────────────────
//
// Wraps `chunkCapDecision` with the no-start bookkeeping, so the "did it start?" verdict and the
// tally can never disagree — a gate that consults one without the other is exactly how a bound
// silently stops applying. Every chunk-capped gate in this file goes through it: the two pre-gate
// phases D1 adds (build, a project's own UI gate) and the two heavy gates that already chunked (the sibling suite,
// battery).
//
// Returns `chunkCapDecision`'s own shape plus:
//   `noStartRounds`  — consecutive did-not-start rounds INCLUDING this one (0 when it started)
//   `exhausted`      — that count has reached NON_CONVERGENT_ROUNDS ⇒ report NON-CONVERGENT
//   `secondsLeft`    — what was actually left, for the report (never re-derived by the caller)
//
// A gate that STARTS clears its own counter here, whatever the run then does: the bound is on
// rounds that observed nothing, never on rounds that ran (a round that ran and proved nothing is
// plan 3374's job, measured against the ledger).
//
// `clearOnStart: false` is for a gate that decides MORE THAN ONCE per invocation, and it is what
// keeps the bound from being silently defeated. The two heavy gates re-derive the cap immediately
// before the run (after the mutex wait / the ledger carry-forward, each of which can itself eat the
// remaining budget), so a round can pass the FIRST decision and still never start. If that first
// decision cleared, every round would go clear→bump→clear→bump and the counter could never reach 2
// — the gate would report "did not start" forever while the bound sat at 1. Only the LAST decision
// before the run — the one whose `shouldRun: true` actually means "we are running now" — clears.
export function chunkGateStartDecision(
  wtPath,
  gate,
  { chunkCapMs, minChunkS, naturalTimeoutMs, clearOnStart = true },
) {
  const D = landDeps();
  const decision = chunkCapDecision({ chunkCapMs, minChunkS, naturalTimeoutMs });
  const secondsLeft = (chunkCapMs ?? 0) / 1000;
  // Chunking off ⇒ no wall ⇒ nothing to tally. Keeps the local path byte-identical: it never reads
  // or writes the sidecar at all.
  //
  // The test is "is there a wall at all" (`chunkCapMs == null`, chunkCapDecision's own off-sentinel)
  // and NOT `!usingChunkCap`. Those two look interchangeable — with the 480s default wall against a
  // 600s+ natural cap, `usingChunkCap` is always true when chunking is on — but they come apart on
  // exactly the configuration this plan's own runbook recommends as the remedy for a stalled gate: a
  // RAISED `PREPUSH_WALL_S`, where the remainder can exceed a gate's natural cap. There the gate
  // RUNS while `usingChunkCap` is false, and shortcutting would skip the clear, leaving a stale
  // no-start round on record so the next did-not-start round reported a FALSE NON-CONVERGENT.
  if (chunkCapMs === null || chunkCapMs === undefined)
    return { ...decision, noStartRounds: 0, exhausted: false, secondsLeft };
  const sha = noStartTallyKey(wtPath);
  if (!sha) return { ...decision, noStartRounds: 0, exhausted: false, secondsLeft };
  const tally = readNoStartTally(wtPath);
  if (decision.shouldRun) {
    if (clearOnStart) writeNoStartTally(wtPath, D.L.clearNoStartRound(tally, sha, gate));
    return { ...decision, noStartRounds: 0, exhausted: false, secondsLeft };
  }
  const bumped = D.L.bumpNoStartRound(tally, sha, gate, D.batteryLedger.NON_CONVERGENT_ROUNDS);
  writeNoStartTally(wtPath, bumped.tally);
  return {
    ...decision,
    noStartRounds: bumped.rounds,
    exhausted: bumped.exhausted,
    secondsLeft,
  };
}

// plan 3436: WHICH wall variable is actually in force. `chunkGateConfig` decides it (gpt-review r3
// 556f27 / a573cf — it already read the env, so nothing here re-reads it), which also means the
// answer can never disagree with the wall the gates are actually being capped against.
// `PREPUSH_GATE_CHUNK_S` overrides the wall only when it parses as a positive SAFE integer;
// anything else (0, a non-numeric string, a digit run past 2^53) falls through to
// `PREPUSH_WALL_S`, and the remediation text must say so or it names a knob that does nothing.
export function activeChunkWallVar(env = process.env) {
  return chunkGateConfig(env).wallVar;
}

// The report a refused-to-start gate returns: ordinary CHUNKED while rounds remain, NON-CONVERGENT
// once the tally is out. One builder so the two arms cannot drift on which report goes with which
// verdict.
export function noStartGateResult(gate, decision, minChunkS) {
  const D = landDeps();
  if (decision.exhausted) {
    return {
      ok: false,
      chunked: true,
      nonConvergent: true,
      detail: D.L.noStartExhaustedDetail({
        gate,
        rounds: decision.noStartRounds,
        secondsLeft: decision.secondsLeft,
        minChunkS,
        wallVar: activeChunkWallVar(),
      }),
    };
  }
  return {
    ok: false,
    chunked: true,
    detail: chunkReportDetail({
      gate,
      started: false,
      secondsLeft: decision.secondsLeft,
      minChunkS,
    }),
  };
}

// The one place a chunk-capped round that ACTUALLY RAN is scored, shared by both heavy gates so
// they cannot drift on the rule. Returns the consecutive zero-progress count after recording this
// round, and whether that count has reached the non-convergence threshold.
//
// `progressed` is decided by the GREEN COUNT for this key before the run vs after the merge (the
// plan's own execution note: the count, never the ledger timestamp — a timestamp moves for reasons
// that have nothing to do with new files being proven).
//
// `healthyZero` is the guard the plan calls for: a round that legitimately proved zero and is still
// converging must stay CHUNKED. For the sibling gate that is its own slow-deselect signal
// (core-noun-ok: slowDeselected is that project module's own field name) — a chunk-capped run that
// dropped `slow`-marked files covered the gate minus those files, which is exactly the healthy
// shape plan 3318 engineered. That flag already fails PESSIMISTIC (it defaults to
// `runCap.usingChunkCap` whenever the events file is missing or the parse is not provably live), so
// on ANY doubt this returns "not non-convergent" and the caller reports today's CHUNKED outcome.
// Doubt never fires the new seam — acceptance 4's "no change to what counts as PROVEN".
//
// ONLY rounds that actually started and were killed by OUR OWN chunk cap reach here (decision D2):
// the `started: false` early exits prove zero too, but they observed nothing about convergence —
// this invocation simply arrived with no budget left — so they leave the counter untouched rather
// than incrementing it toward a false accusation.
// Did THIS round prove at least one file that was not already green under this key?
//
// Delta-review cluster A (eleven findings, one claim): the first cut answered this by comparing the
// ledger's green COUNT before the run against the count after the merge — which silently trusts the
// merge to have landed. It does not: `battery-ledger.mjs merge` and the sibling gate's own merge
// subcommand CATCH their own fs
// failures, log "merge write failed (ignored)" and still exit 0, because they are close-out
// bookkeeping that must never block a verdict the gate already reached. A silently-failed merge
// therefore left the count unmoved and read as a zero-progress round no matter what the round had
// actually proven — and two of those in a row would have fired the seam at a gate that was making
// progress the whole time.
//
// So progress is read off the round's OWN events instead, which is exactly the set a successful
// merge would have unioned in: no subprocess is trusted, and the answer is identical whether the
// merge landed, failed, or was never attempted. `roundGreen` null/undefined (events absent or
// unparseable) is "no evidence of progress"; the `ranProven` gate in scoreChunkRound separately
// refuses to score such a round at all, so this never stands alone as an accusation.
// The battery reporter's own green set, in the SAME vocabulary the ledger stores.
//
// Delta-review round 2 (eight findings, one defect — angle-A/B/C/P, efficiency, altitude,
// guard-fires, writer-trace, plus the claude arm): node:test's reporter keys its events by RESOLVED
// ABSOLUTE path (battery-ledger.mjs's `toPosixRelative` says so in its own header), while every
// green set the ledger stores is repo-RELATIVE. `battery-ledger.mjs merge` converts before writing;
// the first cut of this comparison did not, so every file the round proved looked absent from
// `greenBefore` and EVERY battery round scored as progress — which silently cleared the tally on
// each pass and made the seam unreachable for this gate. It failed safe (never a false accusation)
// but the battery half was dead. Reusing the SAME converter the merge CLI uses is what keeps the
// two definitions from drifting again; the sibling gate's half needs none of this, because
// `_gate_ledger.py` already emits repo-relative strings.
export function batteryRoundGreen(ev, wtPath) {
  const D = landDeps();
  const passedAbs = ev?.passed || [];
  const passedSet = passedAbs instanceof Set ? passedAbs : new Set(passedAbs);
  const out = new Set();
  // EVERY path this round reported is validated, passed and failed alike (delta-review r4,
  // c882cd/4a2154/1a4ee9): the question the guard answers is "do this round's paths and the
  // ledger's speak the same vocabulary", and a failed event proves the roots disagree just as well
  // as a passed one. Only the PASSED set is returned as green — validating more never claims more.
  for (const abs of [...passedAbs, ...(ev?.failed || [])]) {
    const rel = D.batteryLedger.toPosixRelative(wtPath, abs);
    // Delta-review r3 (ce529c): the merge CLI relativizes against ITS OWN `process.cwd()`, which
    // this spine sets to `wtPath` on every spawn — so the two roots agree by construction, and the
    // existing remainder subtraction has always depended on that same agreement. A path that does
    // NOT resolve under `wtPath` is the one shape where they could have diverged (a symlinked or
    // differently-spelled worktree, where node:test's resolved absolutes and this string disagree).
    // `relative()` answers that with a `../…` escape, which would compare as a brand-new file
    // forever and — worse — silently clear the tally on every round, leaving exactly the infinite
    // land this seam exists to end. Refuse to guess: `null` means "this round is not scoreable",
    // and the call site turns it into "not proven to have run", so the gate reports today's
    // ordinary CHUNKED instead of either accusing or exonerating on garbage.
    // A `..` escape is the POSIX answer for "not under this root". On Windows, `relative()` across
    // VOLUMES cannot express an escape at all and returns the target as a DRIVE-QUALIFIED ABSOLUTE
    // (`D:\\x` → `D:/x` after the POSIX split), which no `../` test would ever catch — the partial
    // guard would then have implied a coverage it did not have (delta-review r4, seven findings:
    // 3e0e3b/da8e1e/57da4a/0b8a48/bf32c6/124396/f99146). Both shapes are rejected here, so the
    // check is total rather than POSIX-only. Deliberately NOT install-main.mjs's `isPathContained`:
    // that helper belongs to the pnpm-store healer and pulls `install-lock.mjs` in with it, so
    // reusing it would couple the landing spine to an unrelated subsystem for a four-token test.
    // platform-assert-ok: this rejects BOTH platforms' escape spellings rather than branching on one.
    if (
      !rel ||
      rel === '..' ||
      rel.startsWith('../') ||
      /^[A-Za-z]:/.test(rel) ||
      rel.startsWith('/')
    )
      return null;
    if (passedSet.has(abs)) out.add(rel);
  }
  return out;
}

export function scoreChunkRound({ ledgerDir, key, progressed, healthyZero, ranProven }) {
  const D = landDeps();
  // gpt-review a1eca9/594b17/998ec9/813b6c (four finders, one defect): WITHOUT this gate the scorer
  // could not tell a round that ran and proved nothing from a round that never ran at all.
  // `outcome.timedOut` covers the WHOLE `queued-run.mjs` invocation — the shared heavy-test TICKET
  // WAIT included — so a round that spent its entire budget queueing, executing not one test,
  // arrived here looking exactly like a non-convergent one; two of those in a row would have
  // accused a gate that was never given a chance. `ranProven` is the caller's positive evidence
  // that the gate really executed (its own collection/report events), and every doubt lands here,
  // on the side that reports today's ordinary CHUNKED outcome.
  if (!ranProven || !key) return { rounds: 0, nonConvergent: false };
  // A healthy zero neither increments NOR clears: the round proved nothing, so it is no evidence
  // of convergence either, and clearing would let a gate alternate slow-deselect/stall forever
  // without ever reaching the threshold.
  if (healthyZero && !progressed) {
    return { rounds: readZeroRoundsSafe(ledgerDir, key), nonConvergent: false };
  }
  const rounds = recordChunkRoundSafe(ledgerDir, key, progressed);
  return { rounds, nonConvergent: rounds >= D.batteryLedger.NON_CONVERGENT_ROUNDS };
}

// Delta-review cluster B (findings 7/8/12/13/14/15): every OTHER ledger consultation in this file
// is wrapped exactly like this, and for exactly this reason — the ledger is close-out bookkeeping,
// so an unwritable dir, a full disk, or a corrupt entry must degrade to "no tally" and NEVER
// propagate out to change a verdict the gate has already reached. Without these wrappers a readonly
// mount could turn a GREEN preflight into a thrown land.
function readZeroRoundsSafe(ledgerDir, key) {
  const D = landDeps();
  try {
    return D.batteryLedger.readZeroRounds(ledgerDir, key, Date.now());
  } catch {
    return 0;
  }
}

function recordChunkRoundSafe(ledgerDir, key, progressed) {
  const D = landDeps();
  try {
    return D.batteryLedger.recordChunkRound(ledgerDir, key, progressed, Date.now());
  } catch {
    return 0; // unrecordable ⇒ no tally ⇒ ordinary CHUNKED, today's behaviour
  }
}

// The green-path clear, same fail-safe contract: a gate that just went GREEN must not be turned
// into a failure by a bookkeeping write.
export function clearChunkRoundsSafe(ledgerDir, key) {
  const D = landDeps();
  try {
    D.batteryLedger.clearChunkRounds(ledgerDir, key);
  } catch {
    /* an unwritable ledger only means a stale tally survives — never a failed preflight */
  }
}

// plan 3225 (Fix A, decision D3): the worktree's HEAD commit oid, resolved BEFORE a gate spawns so
// `battery-ledger merge --head` can re-verify it did not move across the run. '' on ANY git trouble
// — the ledger entry then carries no delta baseline and simply never becomes one, which is the
// fail direction every other ledger consultation in this file already takes.
//
// Delegates to `worktreeHeadSha` rather than re-rolling the same rev-parse (review finding): that
// helper additionally honors `DW_FAKE_BRANCH_TIP` under DRY, which is how every other HEAD read in
// this spine gets a pinnable sha in the dry-run fixtures. A second, convention-blind copy would
// have made this ONE path disagree with the rest of the run. Only the `''`-on-failure wrapper is
// this function's own — `worktreeHeadSha` throws, and here a failure must merely mean "no baseline".
export function resolveHeadOid(wtPath) {
  const D = landDeps();
  try {
    return String(worktreeHeadSha(wtPath)).trim();
  } catch {
    return '';
  }
}

// plan 3274: "how many of `universe` are already proven green under `key`" — the SAME
// `remainder` and the sibling gate's own remainder subcommand the pre-run subtraction below already calls for the
// battery half, reused here rather than re-derived a second way (this module's own reuse-not-
// rederive convention for content keys). Exported so a test can prime a tiny ledger via the real
// CLI (`merge` and the sibling gate's own merge subcommand) and assert the count directly, without spawning a real sibling-suite/node
// --test run. Returns null on any doubt (no key, empty universe, a CLI/spawn failure) — the chunk
// report then degrades to chunkReportDetail's "counts could not be determined" branch rather than
// printing a fabricated number.
//
// plan 3274 (land-side ledger clamps round, findings fbb8de/490e59/CONFIRMED): `timeoutMs`
// defaults to the pre-existing 60_000 literal (byte-identical for any caller that omits it), but
// the two POST-TIMEOUT callers below now pass their own ledgerSubprocessTimeoutMs(60_000,
// freshChunkCapMs()) clamp — this function must not decide its own fixed timeout when the caller
// already knows the remaining shared chunk budget, or a hung ledger CLI here could add up to
// another 60s past the shared chunk deadline exactly like the pre-run carry-forward/remainder
// calls above used to (F1's original finding, fixed for those two call sites already).
export function ledgerRemainderCount(wtPath, cmd, key, universe, timeoutMs = 60_000) {
  const D = landDeps();
  if (!key || !Array.isArray(universe) || universe.length === 0) return null;
  try {
    const out = D.spawn.run(process.execPath, [LEDGER_CLI, cmd, '--key', key], {
      cwd: wtPath,
      input: `${universe.join('\n')}\n`,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: timeoutMs,
    });
    // plan 3374 (gpt-review 4dbf30): keep the remainder FILE LIST, not just its length. The CLI
    // already prints it and this function was discarding it — and when the remainder is down to one
    // file, that name IS the answer to "what is absorbing every chunk", which the non-convergence
    // report exists to state. `remainingFiles` is additive: every pre-3374 caller reads only
    // total/remaining/proven, and `chunkReportDetail` takes named params so a spread carrying one
    // extra key reaches nothing.
    const remainingFiles = out ? out.split('\n').filter(Boolean) : [];
    const remaining = remainingFiles.length;
    return {
      total: universe.length,
      remaining,
      proven: universe.length - remaining,
      remainingFiles,
    };
  } catch {
    return null;
  }
}

// plan 3274: `chunkCapMs`/`minChunkS` are the D1/D2 chunk-cap threading — `null`/`0` (the default)
// keeps this byte-identical to before the plan (see chunkCapDecision's own header). Only
// runFullBatteryPreflightCached's ordinary land-preflight callers (runPrepGates, via
// runFullBatteryPreflightCached) ever pass a non-null chunkCapMs; the --deploy pre-deploy wall's
// direct call passes neither `useLedger`/`ledgerKey` nor these — same safe-default shape.
export async function runFullBatteryPreflight(
  wtPath,
  {
    useLedger = false,
    ledgerKey = '',
    chunkCapMs = null,
    minChunkS = 0,
    // plan 3274 (review round, F2/CONFIRMED [clock-start]): defaults to THIS function's own entry
    // — a safe fallback for the pre-deploy wall's direct, uncached call (chunkCapMs stays null
    // there, per this function's own top-of-function header, so capturedAtMs is moot regardless of
    // its value) and for any test that constructs options directly. The ordinary land-preflight
    // path always gets an EARLIER, explicit value from runFullBatteryPreflightCached (see its own
    // comment) — captured before that wrapper's own cache check, not this function's entry — so
    // this default is never what actually runs on the hot path.
    capturedAtMs = monotonicNowMs(),
  } = {},
) {
  const D = landDeps();
  const battBattery = batteryBattery();
  if (D.env.DRY) {
    // plan 3274: test-only hook for the CHUNKED (partial-progress) outcome. The real chunk-cap
    // branches below (`battCap.shouldRun` false / `battCap.usingChunkCap && outcome.timedOut`) are
    // unreachable from --dry-run — this whole DRY block returns before `battCap` is ever computed —
    // so this is the one way an out-of-process (subprocess, --dry-run) test can drive the land
    // path's BATTERY_CHUNKED branch without a real multi-minute battery run. Checked BEFORE the
    // plain DW_FAKE_BATTERY truthy check below (a bare 'chunked' string would otherwise read as
    // `!== 'fail'` -> ok: true, the wrong outcome). Reuses chunkReportDetail — the SAME builder the
    // real chunk-cap path calls — rather than a hand-typed second copy of the "CHUNKED (not a test
    // failure)" message shape.
    if (process.env.DW_FAKE_BATTERY === 'chunked') {
      return {
        ok: false,
        chunked: true,
        detail: chunkReportDetail({
          gate: 'battery',
          started: false,
          secondsLeft: 0,
          minChunkS: 60,
        }),
      };
    }
    // plan 3374: the battery twin of the sibling gate's own preflight's own `non-convergent` DRY hook
    // (core-noun-ok: runPytestPreflight is that module's own function name) — see that
    // block for why this is the only way a --dry-run subprocess test can drive the branch.
    if (process.env.DW_FAKE_BATTERY === 'non-convergent') {
      return {
        ok: false,
        chunked: true,
        nonConvergent: true,
        detail: nonConvergentReportDetail({
          gate: 'battery',
          key: '(dry-run)',
          rounds: D.batteryLedger.NON_CONVERGENT_ROUNDS,
          headFile: 'scripts/<name>.test.mjs',
          remaining: 1,
          remedy: BATTERY_NONCONVERGENT_REMEDY,
        }),
      };
    }
    // plan 4006 review round 3 (finding 2c8424): DW_FAKE_BATTERY=starved/never-admitted mirror
    // testQueueRunOutcome's own two starvation shapes for the ORIGINAL full-suite run itself (not
    // its isolation recheck — the recheck's own DW_FAKE_BATTERY_ISOLATION hooks are separate), so
    // a --dry-run test can drive `batteryRedIsFlake`'s `originalStarved` parameter for the
    // full-suite arm without a real spawn or a real queue wait. Checked BEFORE the generic
    // DW_FAKE_BATTERY truthy check below (a bare 'starved'/'never-admitted' string would otherwise
    // read as `!== 'fail'` -> ok: true, the wrong outcome) — mirrors the sibling gate's own
    // `starved` dry hook.
    if (process.env.DW_FAKE_BATTERY === 'starved') {
      return { ok: false, starved: true, starvedCause: 'spawn', detail: '' };
    }
    if (process.env.DW_FAKE_BATTERY === 'never-admitted') {
      return {
        ok: false,
        starved: true,
        slotStarved: true,
        starvedCause: 'queue',
        timedOut: true,
        detail: 'DW_FAKE_BATTERY=never-admitted (dry-run injected)',
      };
    }
    if (process.env.DW_FAKE_BATTERY) {
      // plan 3827 operator ruling R1 (2026-09-09): DW_FAKE_BATTERY_EVENTS is the raw JSONL text
      // the fake reporter "wrote" — run through the REAL batteryFailureReportFromEvents helper
      // (never a hand-typed fake report), so a --dry-run test exercises the actual events-parsing
      // and completeness wiring, mirroring runSelectedBatteryPreflight's own DRY hook above.
      // DW_FAKE_BATTERY_TARGETS (comma-separated repo-relative paths) supplies the fake `reported`
      // target list; omitted, it defaults to the events' own failing files, so a simple one-file
      // fixture is `complete` by construction. DW_FAKE_BATTERY_TAIL no longer feeds any parser
      // (that role is deleted along with the text grammars) — it survives only as the narration
      // `detail` string a --dry-run test can assert on.
      const fakeEventsText = process.env.DW_FAKE_BATTERY_EVENTS || '';
      const fakeParsedFiles = batteryFailureReportFromEvents(wtPath, fakeEventsText, null).files;
      const fakeTargets = process.env.DW_FAKE_BATTERY_TARGETS
        ? process.env.DW_FAKE_BATTERY_TARGETS.split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : fakeParsedFiles;
      const fakeReport = batteryFailureReportFromEvents(wtPath, fakeEventsText, fakeTargets);
      return {
        ok: process.env.DW_FAKE_BATTERY !== 'fail',
        detail: process.env.DW_FAKE_BATTERY_TAIL || 'DW_FAKE_BATTERY',
        failureFiles: fakeReport.files,
        failureComplete: fakeReport.complete,
        failureSeen: fakeReport.seen,
        failureReported: fakeReport.reported,
        failureMissing: fakeReport.missing,
      };
    }
    // plan 2875 cluster 1 / delta round 2 cluster E: the DRY trace shows the REAL shape — the
    // mutex acquire, the battery now taking its OWN queued-run.mjs ticket for the (possibly
    // clamped) node --test invocation, the mutex release — so a dry-run test can prove the wiring
    // order without spawning any of it for real. The mutex is still acquired FIRST and released
    // LAST (see runFullBatteryPreflight's real-path comment below for why that ordering is the
    // deadlock-safe one).
    // plan 2875 delta round 4 (finding 5661/5629, review fix): the command below used to be a
    // second, hand-typed copy of `node --test scripts/*.test.mjs` — the real path builds its
    // command through battBattery.buildArgs (see below), so a future flag/target change to
    // the canonical 'battery' BATTERIES entry reached the real run but silently NOT this DRY
    // trace, which is how nearly every test in this file exercises this preflight. Deriving from
    // the SAME buildArgs closes that: only the TARGET differs (a fixed symbolic
    // 'scripts/*.test.mjs' here, since DRY never lists real files off wtPath — the real path's
    // `[...concArgs, ...files]` below is a live filesystem read this trace deliberately avoids),
    // the command SHAPE (executable, flag order) is the builder's, not a hand-rolled copy.
    const [dryBattCmd, dryBattArgs] = battBattery.buildArgs(['scripts/*.test.mjs']);
    const label = `dw-battery-${process.pid}`;
    D.spawn.run('node', batteryLockAcquireArgs(BATTERY_LOCK_CLI, label));
    D.spawn.run('node', [
      QUEUED_RUN_CLI,
      '--label',
      'done-worktree scripts battery',
      '--',
      dryBattCmd,
      ...dryBattArgs,
    ]);
    D.spawn.run('node', [BATTERY_LOCK_CLI, 'release', '--token', '<token>']);
    return { ok: true };
  }
  // plan 3274 (review round, F3/CONFIRMED [prior round]): `chunkCapMs` is a snapshot the CALLER
  // took (via chunkCapMsNow()/landPreflightChunkOptions()) an instant before invoking this
  // function — `capturedAtMs` pins that same instant. Everything below spends real wall-clock time
  // before the actual battery run gets to start (the ledger carry-forward/remainder subtraction,
  // then acquireBatteryLock's mutex wait and the queued-run.mjs ticket wait inside
  // runViaTestQueue), and none of that belongs to the run's own budget. `freshChunkCapMs()`
  // re-derives "how much is really left RIGHT NOW" by subtracting elapsed time since capture —
  // exact, since `chunkCapMs` IS `deadlineEpoch - captureTime`, so `deadlineEpoch - now` equals
  // `chunkCapMs - (now - captureTime)`.
  //
  // plan 3274 (review round, F2/CONFIRMED [clock-start]): `capturedAtMs` is now a PARAMETER
  // (default: this function's own entry — see the signature's own comment), not a self-stamp here.
  // Before this fix it WAS stamped here, at THIS function's entry — which is already after
  // runFullBatteryPreflightCached's own `batteryCacheCheck` call had already spent real time, so
  // that cache-check work was never charged against the shared deadline and every consumer below
  // believed it had more budget than the process really did. The Cached wrapper now stamps
  // `capturedAtMs` at ITS OWN entry, before the cache check, and threads it through — so the clock
  // starts where the work actually begins.
  const freshChunkCapMs = () => chunkCapMsAfterElapsed(chunkCapMs, monotonicNowMs() - capturedAtMs);
  // plan 4003, gpt-review r1 (bfe435): POSIX at the SOURCE, not at each comparison. The ledger
  // stores every green through `toPosixRelative`, while `listScriptsTestFiles` builds its entries
  // with `path.join` — `scripts\x.test.mjs` on Windows. The selection handed to
  // `battery-ledger.mjs`'s `carry-forward`/`remainder` was therefore in a different vocabulary from
  // the green set they subtract against, so on Windows the subtraction matched NOTHING: the ledger
  // silently returned the whole selection every time and every resumed land re-ran the full
  // battery. (Pre-existing since plan 3223; fixed here rather than routed to a plan, because this
  // plan's partial proof derives from exactly that subtraction and would inherit the same blindness.)
  // Normalizing at the source fixes it once for the stdin selection, the `runFiles` targets — POSIX
  // is a valid `node --test` target on Windows — and the proof derived from them.
  // platform-assert-ok: normalizes rather than branching — one vocabulary on both platforms.
  const files = D.scriptsBattery.listScriptsTestFiles(wtPath).map(D.spine.toPosixPath);
  const label = `dw-battery-${process.pid}`;

  // plan 3223 (review round: finding 7/CONFIRMED): the ledger key is NOT derived here — it is the
  // SAME content key `batteryCacheCheck(wtPath)` already computed for the whole-gate pass-cache
  // moments earlier, threaded through as the `ledgerKey` parameter by runFullBatteryPreflightCached
  // below (mirrors the sibling gate's own preflight's own `ledgerKey` parameter and its header comment for why
  // (core-noun-ok: runPytestPreflight is that module's own function name)
  // reusing — never re-deriving — is the sound choice here: this preflight always runs the
  // UNIVERSAL/full-glob selection (`files` above is never a subset the way the pre-push hook's own
  // per-selected-file ledger key can be), so "which files does THIS exact content already have
  // proven green" is exactly the same question the whole-gate cache key already answers. Deriving
  // a SECOND key via a second `battery-ledger.mjs key` subprocess (the pre-fix shape) paid an extra
  // multi-subprocess git-state-gathering spawn AND risked landing a DIFFERENT key on a racy tree (a
  // second git read moments after batteryCacheCheck's own) for zero benefit — the same race
  // that same sibling preflight's own header comment already names for its own half
  // (core-noun-ok: runPytestPreflight is that module's own function name). Wired into this SAME
  // raw runner the `--deploy` pre-deploy wall also calls directly (that call passes no `useLedger`/
  // `ledgerKey` and gets the safe defaults, OFF — see this function's own top-of-function header).
  // Imported from the ledger module rather than rebuilt from this file's dirname — one spelling for
  // production and its tests, so relocating the reporter cannot leave the tests green against a
  // path this preflight no longer passes. It is a file:// URL because `--test-reporter` is imported
  // as an ESM module SPECIFIER and a Windows absolute path is not one
  // (`ERR_UNSUPPORTED_ESM_URL_SCHEME … Received protocol 'c:'`): with a bare path this preflight's
  // battery died at node's harness startup — exit 7, zero tests run, empty ledger — and surfaced as
  // a BATTERY_FAILED land block with no failing test to point at. It only ever worked because the
  // Linux cloud drains, where a POSIX absolute path IS a valid specifier, are where it was proven.
  // `scripts/hooks/pre-push.sh` passes the RELATIVE `./scripts/battery-ledger-reporter.mjs`, which
  // is platform-independent already. Full history: REPORTER_SPECIFIER in battery-ledger.mjs.
  const LEDGER_REPORTER = D.batteryLedger.REPORTER_SPECIFIER;

  // Validated, not trusted blindly — the same 32-lowercase-hex-char shape battery-pass-cache.mjs's
  // computeKey emits. `useLedger` false, or a caller-supplied key that came up empty/malformed (a
  // MISS whose batteryCacheCheck couldn't even mint a key, e.g. an uncacheable/dirty tree), both
  // land here as "not that shape" — ledger stays off for this run, the fail-safe direction.
  // plan 3225: the ONE shared decider (done-worktree-lib.mjs) — see its header for why the
  // `--deploy` pre-deploy wall's guarantee rests on this returning '' for a no-flag caller.
  const key = D.L.ledgerActiveKey({ useLedger, ledgerKey });
  let resolvedLedgerKey = '';
  let runFiles = files;
  // plan 3225 (Fix A): the HEAD this run's greens will be attributed to, resolved BEFORE the gate
  // spawns and re-verified by `battery-ledger merge --head` afterwards (see verifiedHead). Empty on
  // any git trouble, which simply leaves the entry without a delta baseline.
  const headAtStart = key ? resolveHeadOid(wtPath) : '';
  if (key && files.length > 0) {
    // plan 3225 (Fix A): before subtracting, let the ledger carry forward whatever a PREVIOUS live
    // green already proved and the delta since it provably cannot reach. Primes THIS key's ledger,
    // so the `remainder` call below — and every downstream rule, including the "full coverage of
    // the original selection ⇒ gate green" one — is untouched. Best-effort in both directions: a
    // failure here primes nothing, i.e. exactly today's full run.
    try {
      D.spawn.run(process.execPath, [LEDGER_CLI, 'carry-forward', '--key', key], {
        cwd: wtPath,
        input: `${files.join('\n')}\n`,
        // Nothing useful on stdout; stderr INHERITED so the ledger's one carry-forward/refusal
        // line reaches the land log. (`run` tolerates a discarded stdout — see its own header.)
        stdio: ['pipe', 'ignore', 'inherit'],
        // plan 3274 (review round, F1/CONFIRMED [ledger-subprocess-unbounded]): clamped to the
        // remaining shared chunk budget — see ledgerSubprocessTimeoutMs's own header for the "why".
        timeout: ledgerSubprocessTimeoutMs(180_000, freshChunkCapMs()),
      });
    } catch {
      /* no carry-forward this run — the remainder below then subtracts only same-key greens */
    }
    try {
      // Same content-addressing the pre-push hook's own ledger wiring uses, via the SAME CLI
      // (scripts/battery-ledger.mjs) — one implementation, two thin callers, per the plan's E1.
      const remOut = D.spawn.run(process.execPath, [LEDGER_CLI, 'remainder', '--key', key], {
        cwd: wtPath,
        input: `${files.join('\n')}\n`,
        stdio: ['pipe', 'pipe', 'ignore'],
        // plan 3274 (review round, F1/CONFIRMED [ledger-subprocess-unbounded]): same clamp as the
        // carry-forward call just above.
        timeout: ledgerSubprocessTimeoutMs(60_000, freshChunkCapMs()),
      });
      resolvedLedgerKey = key;
      runFiles = remOut ? remOut.split('\n').filter(Boolean) : [];
    } catch {
      // git trouble, a malformed repo, an fs error — MISS ⇒ run everything (unchanged today).
      resolvedLedgerKey = '';
      runFiles = files;
    }
  }

  // plan 3374: the green count this round STARTS from — read after the carry-forward/remainder pair
  // above, so it measures this RUN's own contribution rather than a baseline primed from another
  // key. Mirrors that same sibling preflight's own `greenBefore` exactly; see scoreChunkRound for
  // the rule (core-noun-ok: runPytestPreflight is that module's own function name).
  const batteryLedgerDir = D.batteryLedger.resolveLedgerDir(wtPath);

  if (resolvedLedgerKey && runFiles.length === 0) {
    // Every file this preflight would have run already proved green under this exact content
    // key (a killed prior attempt, or an unchanged re-run of the same worktree) — nothing left
    // to prove. Skip the mutex/queue entirely, mirroring the pre-push hook's own short-circuit.
    //
    // Delta-review finding 9: this GREEN return is reached before the ok-path clear far below, so
    // without its own clear a tally from earlier zero rounds would outlive the very round that
    // proves the gate converged — exactly the stale-count hazard review C3 closed on the other
    // green paths.
    clearChunkRoundsSafe(batteryLedgerDir, resolvedLedgerKey);
    // plan 3436 (gpt-review 7df7f9): the NO-START tally is a second, independent counter and this
    // early GREEN return skips the ok-path clear far below, so it needs its own — same reasoning as
    // the plan-3374 clear on the line above, applied to the other tally.
    D.spine.clearNoStartRoundFor(wtPath, 'battery');
    return {
      ok: true,
      detail: 'battery-ledger: fully green under this content key, nothing to run',
    };
  }

  // plan 3274 (D1): less than minChunkS left this invocation ⇒ do not even acquire the
  // battery-lock mutex or a queue ticket for a run with no realistic chance of finishing before
  // the deadline. `files`/`runFiles` (M/R) are already known for free at this point — no extra
  // ledger subprocess needed to report the CURRENT state honestly.
  //
  // plan 3274 (review round, F2/CONFIRMED [stale-initial-cap]): `freshChunkCapMs()`, not the raw
  // `chunkCapMs` parameter — the ledger carry-forward/remainder calls just above (up to 180s +
  // 60s) already spent real time since `capturedAtMs`, so the raw snapshot is stale by the time
  // THIS decision runs. Using it directly made the FIRST start decision believe it had more budget
  // than the process really did — exactly the class of bug the post-lock `runCap` recheck further
  // below already guards against, just one decision point earlier.
  // plan 3436 D2: the no-start tally rides the same decision. `clearOnStart: false` — this is the
  // FIRST of two decisions this function makes (the post-mutex `runCap` below is the one that
  // actually means "we are running"), and a clear here would let clear→bump→clear→bump defeat the
  // bound forever. See chunkGateStartDecision's own header.
  // plan 4034 T4 (re-shipping plan 4003 T3): the gate's own NATURAL cap is not a flat literal —
  // it is derived from what this run actually has to do (`runFiles`, already narrowed by the ledger
  // remainder above) under the worker budget one queue slot gets, floored at the battery
  // definition's own timeout. Computed ONCE here and reused by both chunk decisions and the run
  // itself, so the two decisions and the spawned cap can never disagree about what "natural" means
  // for this invocation. `perSlotWorkerBudget` declares NO default for its cpu argument — a bare
  // call computes NaN and the cap sanitises that to the ONE-worker (largest) cap, which is the
  // whole defect plan 4034 r1 closed — so the count is always passed explicitly. How it opened is
  // worth keeping: plan 4003's own T3 diff avoided it by moving the CPU probe next to the budget,
  // and the revert took that move with it, so re-shipping only the call site reopened the gap. A
  // call site and the default it relied on are one change, not two.
  const batteryNaturalCapMs = D.scriptsBattery.batteryRunCapMs(
    runFiles.length,
    D.testQueue.perSlotWorkerBudget(D.spine.landCpuCount()),
  );
  const battCap = chunkGateStartDecision(wtPath, 'battery', {
    chunkCapMs: freshChunkCapMs(),
    minChunkS,
    naturalTimeoutMs: batteryNaturalCapMs,
    clearOnStart: false,
  });
  if (!battCap.shouldRun) {
    // plan 3436 D2: the tally is out — this gate has declined to start NON_CONVERGENT_ROUNDS times
    // on the same commit, so the pre-gate phases are eating the wall and another round cannot help.
    if (battCap.exhausted) return noStartGateResult('battery', battCap, minChunkS);
    return {
      ok: false,
      chunked: true,
      detail: resolvedLedgerKey
        ? chunkReportDetail({
            gate: 'battery',
            key: resolvedLedgerKey,
            proven: files.length - runFiles.length,
            total: files.length,
            remaining: runFiles.length,
          })
        : chunkReportDetail({
            gate: 'battery',
            started: false,
            // plan 3274 (F2 review fix [stale-initial-cap]): fresh, matching the decision above —
            // was the stale `chunkCapMs ?? 0`, which could report MORE seconds left than the
            // decision that just refused to run actually had.
            // plan 3436: now the decision's OWN reading rather than a second `freshChunkCapMs()`
            // call — 3274 wanted this to match the decision, and re-reading the clock could only
            // ever drift back below it again.
            secondsLeft: battCap.secondsLeft,
            minChunkS,
          }),
    };
  }

  // plan 2875 delta round 2 (cluster D/E, review fix): lock-then-ticket ordering, deliberately in
  // THIS order and never the reverse. The battery-lock mutex is acquired FIRST and held for the
  // ENTIRE queue wait + run below — nothing else in this codebase acquires the ticket before the
  // battery-lock (the sibling gate's own queued run never touches battery-lock at all; the merge-push hook's own
  // battery gate never touches the ticket queue at all), so every process that ever takes both of
  // these resources takes them in the SAME order — the one thing that provably rules out a
  // lock-ordering deadlock between two processes each holding one and waiting on the other. Holding
  // the mutex through the ticket wait is also STRICTER than either mechanism alone: at most one
  // battery attempt can be admitted to (or even queued for) a ticket at a time.
  // plan 3274 (F2 review fix [lock-not-deadline-bounded]): the acquire wait itself is now clamped
  // to the remaining chunk budget (freshChunkCapMs — see acquireBatteryLock's own header) rather
  // than only being re-checked AFTER the wait completes.
  const { token, concArgs } = acquireBatteryLock(wtPath, label, freshChunkCapMs());
  let ledgerEventsPath = '';
  try {
    // plan 3274 (review round, F3/CONFIRMED): acquireBatteryLock above can itself block for real
    // wall-clock minutes under contention (BATTERY_LOCK_ACQUIRE_GRACE_MS / BATTERY_LOCK_FULL_WAIT_MS)
    // — re-derive the cap FRESH here, immediately before the run, rather than trust `battCap` (a
    // snapshot from before the mutex wait). The queued-run.mjs ticket wait inside runViaTestQueue
    // below is already inside whatever timeoutMs this run passes, so this one re-snapshot is enough
    // to cover both "mutex and queue acquisition" (the finding's own wording).
    // The SET, not its size — see that same sibling preflight's own `greenBefore` and
    // (core-noun-ok: runPytestPreflight is that module's own function name)
    // roundProvedSomethingNew's header for why a count delta around the merge is not trustworthy.
    //
    // Read HERE — inside the battery mutex, and BEFORE `runCap` (delta-review r2 finding 0 and r3
    // finding 1b6668). Inside the mutex because `acquireBatteryLock` can block for real minutes
    // under contention, and a sibling merging into this same content key during that wait would
    // leave an earlier snapshot stale, crediting THIS round with files it never proved. Before
    // `runCap` because this is a synchronous cache-file read: taken afterwards, its cost would be
    // spent but not subtracted, letting the run start on a stale budget and overshoot the wall.
    const greenBefore = resolvedLedgerKey
      ? D.batteryLedger.readGreenSet(batteryLedgerDir, resolvedLedgerKey, Date.now())
      : new Set();
    // plan 3436 D2: the LAST decision before the run, so this is the one that clears the no-start
    // tally on a real start (default `clearOnStart`) — see the battCap decision above.
    const runCap = chunkGateStartDecision(wtPath, 'battery', {
      chunkCapMs: freshChunkCapMs(),
      minChunkS,
      // plan 4034 T4: the SAME derived cap the battCap decision above used — computed once, never
      // re-derived here, so the two decisions cannot disagree about this run's natural cap.
      naturalTimeoutMs: batteryNaturalCapMs,
    });
    if (!runCap.shouldRun) {
      // The mutex wait alone ate the remaining budget — report CHUNKED without spending a real
      // run on 0 realistic seconds, mirroring the pre-acquisition early exit above verbatim.
      if (runCap.exhausted) return noStartGateResult('battery', runCap, minChunkS);
      return {
        ok: false,
        chunked: true,
        detail: resolvedLedgerKey
          ? chunkReportDetail({
              gate: 'battery',
              key: resolvedLedgerKey,
              proven: files.length - runFiles.length,
              total: files.length,
              remaining: runFiles.length,
            })
          : chunkReportDetail({
              gate: 'battery',
              started: false,
              // plan 3436: the decision's own reading — see the battCap twin above.
              secondsLeft: runCap.secondsLeft,
              minChunkS,
            }),
      };
    }
    // plan 3223 (review round: finding 3/CONFIRMED): an explicit `tap`-to-stdout pair is added
    // ALONGSIDE the ledger reporter whenever ledger participation is active — node SUPPRESSES its
    // own implicit default reporter entirely once ANY `--test-reporter` is given explicitly
    // (verified), and this preflight's diagnostic `out`/`tail` capture (testQueueRunOutcome,
    // above) depends on that implicit default today. `runViaTestQueue` always spawns with
    // `stdio: ['ignore', 'pipe', 'pipe']` — a non-TTY piped stdout — and which reporter node picks
    // for that shape is NODE-VERSION dependent: `tap` up to node 22, `spec` from node 23 on. This
    // was a hard-coded 'tap' literal, verified on node v22.22.2 (the cloud drains) and silently
    // wrong on the local node 24 — see batteryLedger.defaultNonTtyReporter's own comment for the full history,
    // including the pinning test that consequently failed every local battery run. Omitted
    // entirely when the ledger is inert (useLedger false, or no key resolved) — the pre-deploy
    // wall's invocation stays byte-for-byte what it always was.
    const reporterArgs = [];
    if (resolvedLedgerKey) {
      ledgerEventsPath = joinPath(tmpdir(), `dw-battery-ledger-${process.pid}-${Date.now()}.jsonl`);
      reporterArgs.push(
        `--test-reporter=${D.batteryLedger.defaultNonTtyReporter()}`,
        '--test-reporter-destination=stdout',
        `--test-reporter=${LEDGER_REPORTER}`,
        `--test-reporter-destination=${ledgerEventsPath}`,
      );
    }
    // plan 2875 delta round 3 (finding 433430/0e279f, review fix): the command is
    // battBattery.buildArgs' own construction, not a second hand-spelled copy of `--test` +
    // the file list — concArgs (the lock's own concurrency clamp, if any) is just another element
    // of the `targets` array buildArgs already splices after '--test', so this composes with the
    // canonical definition instead of re-deriving it. A future flag/target change to the 'battery'
    // BATTERIES entry now reaches this preflight automatically instead of silently diverging from
    // it, the same reason the sibling gate's own canonical-entry constant's own buildArgs call above
    // is used rather than a literal (core-noun-ok: PYTEST_BATTERY is that module's own constant name).
    // The hang backstop (`--test-timeout=900000 --test-force-exit`, plan 3235 + this land) lives in
    // that shared BATTERIES entry rather than being spliced in here. Plan 3235 spliced it at this
    // ONE caller, which left the same object's other two real consumers — nightly-windows-suite's
    // runBatteryReal and its isolated confirmation re-run — building a bare `node --test`, and left
    // the DRY trace a few hundred lines above printing an argv this path no longer runs. Putting it
    // on the definition makes every present and future caller inherit it, which is the whole reason
    // this call site uses buildArgs instead of a hand-spelled copy in the first place.
    // plan 4236 T1: the per-slot CPU cap rides concArgs unless the lock's overflow clamp is there.
    const [battCmd, battArgs] = battBattery.buildArgs([
      ...reporterArgs,
      ...landBatteryConcArgs(concArgs),
      ...runFiles,
    ]);
    const outcome = await runViaTestQueue(wtPath, {
      cmd: battCmd,
      cmdArgs: battArgs,
      label: 'done-worktree scripts battery',
      // plan 3274 (F3 fix): runCap.effectiveTimeoutMs === the gate's own natural cap whenever
      // chunking is off (chunkCapMs null). Since plan 4034 T4 that natural cap is the DERIVED
      // `batteryNaturalCapMs`, not the flat BATTERIES literal. `runCap` (not `battCap`) so the
      // mutex-wait time above is charged to the wall, never donated to the run.
      timeoutMs: runCap.effectiveTimeoutMs,
      // plan 4003 T1: ONLY when our chunk cap is not the binding constraint. Under chunking the
      // cap is this process's slice of a 600s Bash wall, not the gate's own cap, so the queue wait
      // must keep counting or the run overshoots the wall and is killed from outside — losing the
      // CHUNKED report that makes the next invocation resume. See runViaTestQueue's own header.
      slotWaitOutsideCap: !runCap.usingChunkCap,
    });
    // plan 3827 operator ruling R1 (2026-09-09): attach the structured failure report read from
    // the reporter's own destination file — BEFORE the `finally` below deletes it. Fail-closed
    // when no reporter ran this round at all (`resolvedLedgerKey` falsy, so `reporterArgs`/
    // `ledgerEventsPath` were never minted above): `{ files: [], complete: false, seen: 0,
    // reported: null }` refuses any isolation recheck exactly like today's block-on-red behaviour
    // (batteryIsolationRecheck's own `failureComplete !== true` arm). The ledger-inert
    // (`resolvedLedgerKey` falsy) path — the `--deploy` pre-deploy wall's direct, non-cached call —
    // never reaches the reporter args above, so its invocation stays byte-for-byte unchanged; only
    // the OUTCOME it returns now additionally carries this fail-closed report.
    // plan 3827 F2 (efficiency, CONFIRMED): the destination file is read into text ONCE here and
    // reused by BOTH consumers below — this failure report AND the ranProven/ledger-merge parse a
    // little further down, which used to independently readFileSync + parse the same file a second
    // time. `ledgerEventsReadable` is the shared existence guard both consumers used to compute
    // separately; `ledgerEventsText` is the shared content.
    let battFailureReport = { files: [], complete: false, seen: 0, reported: null, missing: [] };
    const ledgerEventsReadable = Boolean(
      resolvedLedgerKey && ledgerEventsPath && existsSync(ledgerEventsPath),
    );
    let ledgerEventsText = '';
    if (resolvedLedgerKey) {
      if (ledgerEventsReadable) {
        try {
          ledgerEventsText = readFileSync(ledgerEventsPath, 'utf8');
        } catch {
          ledgerEventsText = '';
        }
      }
      battFailureReport = batteryFailureReportFromEvents(wtPath, ledgerEventsText, runFiles);
    }
    Object.assign(outcome, {
      failureFiles: battFailureReport.files,
      failureComplete: battFailureReport.complete,
      failureSeen: battFailureReport.seen,
      failureReported: battFailureReport.reported,
      failureMissing: battFailureReport.missing,
    });
    // plan 3223: fold whatever the reporter flushed into the persistent ledger REGARDLESS of
    // outcome.ok — a failing/timed-out run may still have proven SOME files green before it
    // died, and those must survive to the next attempt exactly like the pre-push hook's own
    // merge-on-both-branches does. Best-effort: a ledger write must never override the verdict
    // `runViaTestQueue` already decided.
    // plan 3374 (review C1/C2): the battery's own `ranProven` evidence. `battRanProven` requires
    // that the reporter actually wrote at least one file-level event — proof `node --test` got past
    // the shared heavy-test TICKET WAIT and executed, since a round killed while still queueing
    // writes none — AND that the merge subprocess returned, without which `greenAfter` says nothing
    // about what this round proved. See scoreChunkRound's header for why doubt lands on CHUNKED.
    //
    // RESIDUAL, DELIBERATE GAP: a battery round killed inside its very FIRST file writes no event
    // either, so the purest single-over-wall-file battery case reports ordinary CHUNKED rather than
    // firing the seam. That is the conservative direction — today's behaviour, never a false
    // accusation — and the sibling gate's half (the measured plan-3284 incident, and this plan's actual
    // target) has no such gap, because collection emits before any test body runs.
    let battRanProven = false;
    let battRoundGreen = null;
    if (ledgerEventsReadable) {
      try {
        // ONE parse, both answers (delta review, efficiency finding: this file was being read and
        // parsed twice per chunk timeout — plan 3827 F2 took that one step further: it was still
        // being READ twice too, off the SAME destination file, just to feed two separate parses;
        // `ledgerEventsText` above is now the single read both this block and battFailureReport
        // share). PASSED **or** FAILED proves node --test executed a file to completion, which is
        // what `ranProven` asks; counting only `passed` would be circular, making "this round ran"
        // synonymous with "this round made progress" so that a zero-progress round could never be
        // scored at all. `passed` alone is what the round PROVED — the same set `battery-ledger.mjs
        // merge` would have unioned in.
        const ev = D.batteryLedger.parseLedgerEvents(ledgerEventsText);
        battRoundGreen = batteryRoundGreen(ev, wtPath);
        // `null` (a reporter path that does not resolve under wtPath — see batteryRoundGreen) means
        // this round's evidence cannot be compared against the ledger at all, so it is no evidence
        // either way and must not be scored.
        battRanProven = battRoundGreen !== null && ev.passed.size + ev.failed.size > 0;
      } catch {
        /* unreadable/unparseable events — no proof this round executed, so it is not scored */
      }
      try {
        D.spawn.run(
          process.execPath,
          [
            LEDGER_CLI,
            'merge',
            '--key',
            resolvedLedgerKey,
            '--file',
            ledgerEventsPath,
            // plan 3225: the delta baseline this run's greens may later be carried from. Omitted
            // when HEAD could not be resolved; re-verified inside the CLI either way.
            ...(headAtStart ? ['--head', headAtStart] : []),
          ],
          {
            cwd: wtPath,
            stdio: 'ignore',
            // plan 3274 (land-side ledger clamps round, finding 0b68af/0ec4f1/CONFIRMED): this
            // merge runs AFTER the shared chunk gate has already timed out — a fixed 60_000 here
            // regardless of the shared deadline could burn most (or all) of another 60s past that
            // deadline before the land even learns the outcome was CHUNKED, on top of whatever the
            // remainder query below then also spends. Same clamp shape as the pre-run carry-
            // forward/remainder calls above — see ledgerSubprocessTimeoutMs's own header.
            timeout: ledgerSalvageTimeoutMs(60_000, freshChunkCapMs()),
          },
        );
      } catch {
        /* best-effort close-out — a ledger write failure must never fail an otherwise-decided preflight */
      }
    }
    // plan 3274 (D3): a timeout that fired because OUR chunk cap was the binding constraint
    // (`runCap.usingChunkCap`) is a CHUNKED outcome, never a plain FAILED one — re-query the
    // now-just-merged ledger for the freshest proven/remaining split. A timeout that fired at the
    // gate's own NATURAL cap (chunking off, or a wallS generous enough it was never the binding
    // constraint) falls through unchanged to `return outcome` below — a real failure, exactly as
    // before this plan.
    if (runCap.usingChunkCap && outcome.timedOut) {
      // plan 3274 (land-side ledger clamps round, finding fbb8de/490e59/CONFIRMED): same clamp as
      // the merge call just above, threaded into ledgerRemainderCount's own `timeoutMs` param —
      // this remainder query is ALSO a post-timeout, best-effort call, and used to run on a bare
      // fixed 60_000 regardless of how little shared chunk budget was left.
      const counts = resolvedLedgerKey
        ? ledgerRemainderCount(
            wtPath,
            'remainder',
            resolvedLedgerKey,
            files,
            ledgerSubprocessTimeoutMs(60_000, freshChunkCapMs()),
          )
        : null;
      // plan 3374: score THIS round now that the merge above has folded in whatever it proved —
      // same rule and same ordering as the sibling gate's half. `healthyZero: false`: the battery has no
      // slow-deselect (that is the sibling suite's own ledger-side mechanism, core-noun-ok:
      // _gate_ledger.py names the real external file this pin is about), so a chunk-capped
      // `node --test` round that proved nothing has no benign explanation available to it.
      const { rounds, nonConvergent } = scoreChunkRound({
        ledgerDir: batteryLedgerDir,
        key: resolvedLedgerKey,
        progressed: roundProvedSomethingNew(battRoundGreen, greenBefore),
        healthyZero: false,
        // plan 3374 (review C1): node --test provably executed a file to completion. See this
        // gate's own `battRanProven` comment above for the one deliberate gap this leaves (a round
        // killed inside its very first file).
        ranProven: battRanProven,
      });
      if (nonConvergent) {
        // gpt-review 4dbf30: name the blocking file whenever the evidence actually identifies one,
        // rather than only in the `runFiles.length === 1` case the first cut checked. The remainder
        // AFTER this round is the sharper signal — a non-convergent gate has by definition retired
        // everything it can, so a one-file remainder names the absorbing file exactly, and it stays
        // right even when the round STARTED with many files. `runFiles` is the fallback for a
        // remainder query that could not run (post-timeout, best-effort). With neither, the report
        // says so honestly instead of guessing — the seam still fires, because the zero-progress
        // evidence is what fires it, not the name.
        const remainderHead =
          counts && counts.remaining === 1 && Array.isArray(counts.remainingFiles)
            ? counts.remainingFiles[0]
            : null;
        return {
          ok: false,
          chunked: true,
          nonConvergent: true,
          detail: nonConvergentReportDetail({
            gate: 'battery',
            key: resolvedLedgerKey,
            rounds,
            headFile: remainderHead ?? (runFiles.length === 1 ? runFiles[0] : null),
            remaining: counts?.remaining,
            remedy: BATTERY_NONCONVERGENT_REMEDY,
          }),
        };
      }
      return {
        ok: false,
        chunked: true,
        detail: chunkReportDetail(
          counts
            ? { gate: 'battery', key: resolvedLedgerKey, ...counts }
            : { gate: 'battery', key: resolvedLedgerKey || '(no key)' },
        ),
      };
    }
    // ── plan 4003 T2: what this invocation PROVED, for the land's own sha-keyed partial proof ──
    //
    // Two disjoint sources, unioned:
    //   · `files` minus `runFiles` — exactly what the ledger's own `remainder` subtraction removed
    //     before the run, i.e. what an EARLIER attempt under this content key had already proved.
    //     Taken from the subtraction rather than from `greenBefore` because it is by construction a
    //     subset of this gate's real universe, where the raw green set can carry paths that are no
    //     longer test files at all.
    //   · `battRoundGreen` — what THIS round proved before it was killed.
    //
    // Attached to the outcome rather than recorded here: this function has no `state`, and the
    // sidecar is the LAND's object, not the preflight's. The call site decides — and only records
    // on a killed run, never on a red one, where "which files passed" is not the question.
    //
    // `headAtStart` is the sha these greens are attributed to: resolved BEFORE the gate spawned,
    // the same baseline `battery-ledger merge --head` re-verifies. Empty (no key, or git trouble)
    // leaves the outcome with no `provenSha`, and the recorder then refuses.
    //
    // Every input here is already POSIX: `files` is normalized at its source (see the
    // `listScriptsTestFiles` call above), `runFiles` is the ledger CLI echoing that same selection,
    // and `battRoundGreen` is `toPosixRelative` output. One vocabulary, so the union cannot store
    // the same file under two spellings.
    //
    // gpt-review r1 (1901ef): the subtraction is `battery-ledger.mjs`'s own `remainingSelection` —
    // the canonical "this selection minus that set", imported rather than re-rolled, so a later
    // change to its normalization or dedup semantics reaches this path too. Read the second
    // argument as what it is here: the files STILL TO RUN, so what remains of the selection after
    // subtracting them is precisely what the ledger had already proved before this round.
    const stillToRun = new Set(runFiles);
    const provenBefore = D.batteryLedger.remainingSelection(files, stillToRun);
    const provenNow = battRoundGreen ? [...battRoundGreen] : [];
    Object.assign(outcome, {
      provenFiles: [...new Set([...provenBefore, ...provenNow])],
      provenSha: headAtStart,
    });
    // plan 3374 (review C3): the battery twin of the sibling gate's half's own green-clear — a gate that
    // came back GREEN proves it converges, so a tally left standing must not be inherited by a
    // later chunked land under this same content key. No-ops when there is no tally.
    if (outcome.ok && resolvedLedgerKey) clearChunkRoundsSafe(batteryLedgerDir, resolvedLedgerKey);
    // plan 3436: the no-start tally's twin of the clear above — a gate that reached a real verdict
    // this round ends its no-start series, whatever that verdict was.
    D.spine.clearNoStartRoundFor(wtPath, 'battery');
    return outcome;
  } finally {
    if (ledgerEventsPath) {
      try {
        rmSync(ledgerEventsPath, { force: true });
      } catch {
        /* best-effort cleanup only */
      }
    }
    releaseBatteryLock(wtPath, token);
  }
}

// Through the battery's own content-addressed cache (plan 1824, scripts/battery-pass-cache.mjs)
// — the SAME store scripts/hooks/pre-push.sh's scripts-battery gate reads/writes on a full-glob
// push — reused via its CLI exactly as GATE_CACHE_CLI/gateCacheRun above reuse gate-pass-cache.mjs
// (team-lead review, plan 2875: "prefer the existing content-addressed pass-cache … over
// inventing a skip condition"). Always the UNIVERSAL (full-glob) selection: this preflight never
// runs a selected subset, so `scripts/*.test.mjs` — battery-pass-cache.mjs's own
// UNIVERSAL_SELECTION literal — is the one shape it ever keys or records.
//
// The `--merge-base-out` / `--merge-base` handoff mirrors the hook's own dance (pre-push.sh, the
// BATTERY_CACHE_MERGE_BASE_FILE comment): `check` pins the merge-base it resolved to a scratch
// file so the LATER `record` call — after a run that can take up to 2400s — reuses that EXACT
// baseline instead of re-asking origin/master, which a sibling session's fetch may have moved in
// the meantime (measured key-drift on the hook's own instance of this pattern, 8/218 records over
// 3.1 days). A missing/unwritable scratch file just leaves mergeBase empty, which `record`
// treats exactly like "not provided" — re-resolve fresh; never a correctness issue, only a
// possibly-missed cache write.
const BATTERY_CACHE_CLI = `${SCRIPTS_DIR}/battery-pass-cache.mjs`;

function batteryCacheRun(wtPath, args, mergeBaseOutFile) {
  const fullArgs = mergeBaseOutFile ? [...args, '--merge-base-out', mergeBaseOutFile] : args;
  return cachedCliRun(wtPath, BATTERY_CACHE_CLI, fullArgs, {
    input: 'scripts/*.test.mjs\n',
    timeoutMs: 120_000,
  });
}

// Returns { hit, key, mergeBase }. `hit` true ⇒ skip the battery run.
function batteryCacheCheck(wtPath) {
  const D = landDeps();
  if (D.env.DRY) {
    // Same DW_FAKE_GATE_CACHE convention gateCacheCheck uses above — one pseudo-gate name
    // ('scripts-battery') in the same comma-separated list, not a second env var.
    const fake = String(process.env.DW_FAKE_GATE_CACHE || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return { hit: fake.includes('scripts-battery'), key: null, mergeBase: '' };
  }
  const mergeBaseOutFile = joinPath(tmpdir(), `dw-battery-mb-${randomUUID()}.txt`);
  const r = batteryCacheRun(wtPath, ['check'], mergeBaseOutFile);
  let mergeBase = '';
  try {
    mergeBase = readFileSync(mergeBaseOutFile, 'utf8').trim();
  } catch {
    /* no scratch file written — mergeBase stays '', record() re-resolves fresh */
  }
  try {
    rmSync(mergeBaseOutFile, { force: true });
  } catch {
    /* best-effort cleanup only */
  }
  if (!/^[0-9a-f]{32,}$/i.test(r.out)) return { hit: false, key: null, mergeBase: '' };
  if (r.status === 0) return { hit: true, key: r.out, mergeBase };
  if (r.status === 2) return { hit: false, key: r.out, mergeBase };
  return { hit: false, key: null, mergeBase: '' }; // uncacheable / crash ⇒ run it
}

function batteryCacheClose(wtPath, key, mergeBase, passed) {
  const D = landDeps();
  if (D.env.DRY || !key) return;
  if (passed) {
    batteryCacheRun(wtPath, [
      'record',
      '--key',
      key,
      '--merge-base',
      mergeBase || '',
      '--label',
      'done-worktree',
    ]);
  } else {
    batteryCacheRun(wtPath, ['invalidate', '--key', key]);
  }
}

// The `scripts-battery` gate THROUGH the pass-cache — the land-time (Part A) wiring. Part B's
// pre-deploy gate deliberately calls runFullBatteryPreflight directly, UNCACHED (its own header
// comment explains why: a hard wall must physically re-run). Returns runFullBatteryPreflight's
// own shape, plus `cached: true` on a hit.
// plan 3223 (scoped fix round): this is the ordinary land-preflight path, so it opts INTO the
// ledger explicitly (`useLedger: true`) — the deploy wall's own direct call further below passes
// nothing and keeps the safe default, OFF.
// plan 3274: `chunkCapMs`/`minChunkS` pass straight through to runFullBatteryPreflight — this
// wrapper adds no chunking logic of its own, only the existing cache-check/close bracketing. A
// CHUNKED result carries `r.ok === false`, so `batteryCacheClose`'s existing `passed` branch
// already does the right thing (invalidate, never record) — a partial run must NEVER record the
// whole-gate pass-cache key, and no special-casing is needed here for that soundness rule to hold.
export async function runFullBatteryPreflightCached(
  wtPath,
  {
    onRun,
    onCached,
    chunkCapMs = null,
    minChunkS = 0,
    // plan 3274 (review round, F2/CONFIRMED [clock-start]): captured HERE, at THIS wrapper's own
    // entry — BEFORE `batteryCacheCheck` below spends any real time — and threaded through into
    // runFullBatteryPreflight. Before this fix, the raw preflight self-stamped its OWN
    // `capturedAtMs` at ITS entry instead, which is after `batteryCacheCheck` already ran: that
    // cache-check time was never charged against the shared per-process chunk deadline, so a gate
    // believed it had more budget than the process really did. The clock now starts where the
    // work actually begins.
    capturedAtMs = monotonicNowMs(),
  } = {},
) {
  const D = landDeps();
  const c = batteryCacheCheck(wtPath);
  if (c.hit) {
    // plan 3436 (gpt-review 9e864e class): a content-cache HIT proves the gate — it ends any
    // no-start series, and this return is before any chunk decision, so it must say so itself.
    D.spine.clearNoStartRoundFor(wtPath, 'battery');
    onCached?.();
    return { ok: true, cached: true };
  }
  onRun?.();
  // plan 3223 (review round: finding 7/CONFIRMED): pass THIS SAME `batteryCacheCheck` call's own
  // `c.key` straight through as `ledgerKey` — the one content-key derivation this whole preflight
  // needs (see runFullBatteryPreflight's own header comment for why reusing it, rather than
  // minting a second one, is the sound choice here).
  const r = await runFullBatteryPreflight(wtPath, {
    useLedger: true,
    ledgerKey: c.key || '',
    chunkCapMs,
    minChunkS,
    capturedAtMs,
  });
  batteryCacheClose(wtPath, c.key, c.mergeBase, r.ok);
  return r;
}

// plan 3961 T3.5c: BATTERY_BATTERY was a module-top-level const in the spine, computed
// eagerly from BATTERIES (nightly-windows-suite.mjs). `const D = landDeps()` may never run
// at module top level (Rule 3), so this becomes a private function each caller builds ONCE
// from at the top of its own body — no memoization needed since BATTERIES is a small fixed
// array and each caller reads it at most a handful of times per invocation.
function batteryBattery() {
  const D = landDeps();
  return D.scriptsBattery.BATTERIES.find((b) => b.key === 'battery');
}
