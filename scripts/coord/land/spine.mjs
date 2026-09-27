// scripts/coord/land/spine.mjs — plan 4066: the land spine's own module. Task 2a moved in
// `phasePreflight` (the file header's five-phase landing sequence's FIRST phase — argv parsing,
// the MAIN chdir + coord-reroute install, worktree/batch resolution, the state object, the seed (core-noun-ok: names what this phase resolves, real field)
// scope/lane decision, the node-deps + memory-reclaim pre-checks, the context-extras/prep-gates
// registry run, and the review-marker/findings/seam-halt machinery leading up to the merge). Task
// 2b moved in the REST of the sequence — `main()` itself (the driver: calls all five phases in
// order, converts a mid-land coordContention throw into a clean seam, and classifies a late throw
// as a post-land teardown error vs a genuine crash) plus its three remaining thin phase wrappers,
// `phaseDeployCheck`/`phaseCloseOut`/`phaseTeardown` — see WHAT TASK 2B ADDED below for the full
// list. This module now holds the WHOLE five-phase landing sequence and its halt/seam protocol;
// scripts/done-worktree.mjs ends as boot, wiring, and the CLI entrypoint guard that calls the
// imported `main()` back.
//
// Both tasks moved their code out of scripts/done-worktree.mjs behaviour-identical (parity proven
// by this migration's parity-test suite's eight dry-run scenarios against committed goldens, plus
// the full legacy test suite, both unchanged in BEHAVIOUR by either move — several of
// its source-text pins needed REBINDING to this file, not a behaviour change; see their own
// commits).
//
// WHAT THIS MODULE OWNS. `phasePreflight` itself, plus the private helpers task 2a's own reference
// inventory (plan 4066 D-4066-4) found have ZERO production callers outside the moved block, so
// they travel bodily with no container indirection needed: `isBranchAlreadyLanded`,
// `resolveWorktree`, `planLandGateFor`, `readBatchManifest` (module-private here, exactly as they
// were in done-worktree.mjs), and `canonicalSlugFromBranch`/`landGateRoster`/`seedLaneInputs` (core-noun-ok: names the real functions this move carries)
// (exported — the legacy module's test suite / this module's own resolve-worktree test suite import each directly, so
// the `export` keyword and the test's import path are the only things that changed).
//
// WHAT TASK 2B ADDED. `main()` — the five-phase driver: calls all five phases in order inside a
// try/catch/finally, converts a mid-land `{ coordContention }` throw into a clean, slot-released
// COORD_CONTENTION seam, classifies a throw AFTER the merge fully landed as a post-land teardown
// error (falls through to the SUCCESS report) rather than a genuine crash, and records the
// terminal CRASH/CLOSEOUT_UNVERIFIED/SUCCESS sidecar. Every project-resident name it read from
// module scope now reaches it the same way every other function here does: `emitSeam` and
// `recoverLandedMergeSha` were ALREADY `spine` members (phasePreflight and teardown.mjs each
// already read one); `coordinationSessionId` was already reachable via the `coordSessionId`
// group (this file's own `phasePreflight` already calls `D.coordSessionId.coordinationSessionId`
// for its session banner); `landFullyCompleted`/`crashResultMergeSha`/`formatReport` are simply
// three more `L` group members (the whole `done-worktree-lib.mjs` namespace was already bound
// wholesale); `releaseHeldSlotBestEffort` reaches head-lock.mjs's own export directly, a sibling
// reach (it already exported the name for other core modules; this file just didn't need it
// before). `writeResultSidecar`/`clearLandAttempt`/`hhmmNow` are the only genuinely NEW `spine`
// members this move required — none had an outside caller until main() moved.
//
// Its three thin phase wrappers moved WITH it, each simply because main() is their only caller:
// `phaseDeployCheck` (the mandatory --deploy wall, via the postMerge registry — `runStepRegistry`
// joins `runContextExtras` as a plain sibling import from registry.mjs), `phaseCloseOut` (archive
// + INDEX regen + commit, via the ephemeral finish worktree DRY collapses around, plus the
// closeOutExtras registry run — `closeOut` joins the three close-out.mjs names task 2a already
// imported; `readCarryForwards`/`runCloseOutIsolated` were already `spine` members, read here for
// the first time by this file), and `phaseTeardown` (finish the worktree teardown via the
// `finishTeardown` closure phasePreflight's own move already put in `ctx`, plus the two
// `DW_TEST_THROW` fault-injection points main()'s own catch/fall-through logic exists to prove —
// a direct `process.env.DW_TEST_THROW` read, the same idiom lane-merge.mjs's own two injection
// points already use).
//
// WHAT STAYS BEHIND, ON PURPOSE, AND WHY.
//   - `maybeReexecSpineFromMain` (the plan-2697 MAIN re-exec guard) cannot MOVE here at all: it
//     spawns a child process, reads `import.meta.url`/`fileURLToPath`, and decides whether THIS
//     process should hand the land to MAIN's own copy of the driver — none of which a core module
//     may do (Rule 3, docs/coord/scripts-layout.md). It does not need to move to be
//     CALLED from here, though — it stays resident in done-worktree.mjs and joins the `spine`
//     group instead (a plain shorthand property, since its own signature already matches the
//     call), reached at its ORIGINAL call site inside this phase, unchanged.
//   - `landGateRosterFromRegistry` and `landRegistries` stay `spine` container members, not movers:
//     both have real callers OUTSIDE the moved block today (lane-merge.mjs's own
//     `D.spine.landGateRosterFromRegistry(landRegistry)` call, and landRegistries's many other
//     spine-group readers), so this move cannot take either with it. `landGateRoster` — the async
//     convenience wrapper around both, whose only OTHER caller is the test import above — reaches
//     both through the container instead (`D.spine.landGateRosterFromRegistry(await
//     D.spine.landRegistries(...))`).
//   - `spineBag` (the memoized project-injection bag) stays project-side: it has ten other call
//     sites in done-worktree.mjs besides this phase's one. The one in-block use —
//     `runNodeDepsPreflightStep(spineBag(), { wtPath, changed, state })` — becomes ONE new
//     container member, `D.spine.runNodeDepsPreflight`, wrapping both (the same shape
//     `preflightInterlude`'s `run: (ctx) => runPreBuildDiskHeadroomStep(spineBag(), {...})` already
//     uses in the same `bindLandDeps()` call — `runNodeDepsPreflightStep` lives in
//     `scripts/project/land-preflight-steps.mjs`, which a core module may not import either).
//   - The local `const PREP_EXIT = L.PREP_EXIT;` alias is simply DROPPED (not a new member) — its
//     two reads become plain `D.L.PREP_EXIT.*` through the already-bound `L` group.
//   - `stampStepLogClock()`/`setRetainedEntryHeartbeatDisarm(...)` (plan 4066 task 1's two
//     production setters for the module-private `_stepLogT0`/`_retainedEntryHeartbeatDisarm` lets)
//     join the `spine` group HERE, at this phase's move — task 1 deliberately left them unbound
//     (a container member ships WITH its adopter), and this phase is that adopter.
//
// HOW THIS MODULE REACHES THE REST OF THE WORLD. A non-test module under scripts/coord/ may import
// only scripts/coord/** and node: builtins (Rule 3) — so every plain scripts/*.mjs module this
// code used to reach directly is instead read off the bound dependency container, `landDeps()`
// (scripts/coord/land/deps.mjs), AT CALL TIME, inside each function that needs it — never at
// module top level. `D` (this module's convention: `const D = landDeps();` as the first line of
// every function that needs the container) is the same one-letter binding every other
// scripts/coord/land/*.mjs core module uses for the same reason. gates-runner.mjs
// (landSeamCheck, runLandSeamPhase, hydrateLandGatesProven, runPreflightGates), preflight.mjs
// (recordedReviewMarker, preflight, makeSeamTimeMarkerRepin, recordPreflightMarkers,
// armRetainedEntryHeartbeat, unpushedMasterRetryClears, runLandPrep, emitReworkHaltWithRelease,
// emitSeamWithMarkerTable, recordedFindings, makeSeedOnlyDelta, planExistsAtLand), teardown.mjs (core-noun-ok: names the real sibling functions imported below)
// (teardown, runFinishCloseOut), head-lock.mjs (acquireWorktreeBeforePreflight, dropWorktreeLock,
// releaseHeldSlotBestEffort), rebase-sync.mjs (changedFiles, worktreeHeadSha), queue-probe.mjs
// (unstackSpeculativeBase), lane-merge.mjs (phaseLaneMerge — plan 4066 task 2b, main()'s own
// call), registry.mjs (runContextExtras, runStepRegistry — the second one plan 4066 task 2b's,
// phaseDeployCheck's/phaseCloseOut's own registry runs), and close-out.mjs (readBoardFile,
// resolveBatchLandingRow, recoverBatchStateFromPriorSidecar, closeOut — the last one plan 4066
// task 2b's, phaseCloseOut's own DRY-collapse call) are all SIBLING core modules under
// scripts/coord/land/, so their names are imported from them directly, no container needed.
//
// A PURE MOVE. Every moved function is byte-identical to its done-worktree.mjs original apart from
// the mechanical container-access rewrites (`DRY`/`PREP_NO_REBASE`/`IS_PREP` → `D.env.*`, `L.foo(`
// → `D.L.foo(`, `PREP_EXIT.foo` → `D.L.PREP_EXIT.foo`, `run(` → `D.spawn.run(`, `gitMain(` →
// `D.spawn.gitMain(`, `newManifestRel(` → `D.batchPaths.newManifestRel(`, `resolveMain(` →
// `D.coordGit.resolveMain(`, `loadCoordConfig(` → `D.coordConfig.loadCoordConfig(`,
// `installCoordRerouteOnce(` → `D.ensureCoordReroute.installCoordRerouteOnce(`,
// `runSweepAndReport(` → `D.sweepDeferredWorktrees.runSweepAndReport(`, `coordinationSessionId(` →
// `D.coordSessionId.coordinationSessionId(`, `isBatchSlug(` → `D.claimPlanLib.isBatchSlug(`,
// `assertLandable(`/`rangePatchIdOnce(` → `D.landLib.*(`, `recordLandPrepOutcome(` →
// `D.coordMetrics.recordLandPrepOutcome(`, `slugFromBranch(` → `D.redgreenLib.slugFromBranch(`,
// `branchAlreadyLanded(` → `D.landLib.branchAlreadyLanded(`, `parseWorktreePorcelain(` →
// `D.worktreePorcelain.parseWorktreePorcelain(`, `readLandGate(` → `D.readPlanStamps.readLandGate(`,
// `resolveManifestRel(` → `D.batchPaths.resolveManifestRel(`, and every already-`spine`-resident
// name — `stepLog`/`emitSeam`/`readResultSidecar`/`landRegistries`/`tryStep`/
// `evaluateLandFastPath`/`resolvePlanRelForSlug`/`landGateRosterFromRegistry`/
// `maybeReexecSpineFromMain` (a NEW `spine` member as of this move, not a rewrite of a pre-existing
// bare call — see its own header bullet above) — → the matching
// `D.spine.*` prefix), the `export` keyword kept exactly where a caller outside this module already
// needed it, and the `const D = landDeps();` first line every function that needs the container
// gained — no renames, no reordering, no incidental fixes. Every comment moved with its function;
// they carry the plan history that explains the code. A rename inside a plain-English comment
// (prose mentioning `DRY`/`L.foo`/`PREP_EXIT.foo` in passing, never as executable code) was
// reverted back to the bare name it read as before this move — a comment is not a container read.

import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { landDeps } from './deps.mjs';
import {
  landSeamCheck,
  runLandSeamPhase,
  hydrateLandGatesProven,
  runPreflightGates,
} from './gates-runner.mjs';
import {
  runLandPrep,
  preflight,
  armRetainedEntryHeartbeat,
  unpushedMasterRetryClears,
  recordedReviewMarker,
  makeSeamTimeMarkerRepin,
  recordedFindings,
  planExistsAtLand,
  makeSeedOnlyDelta,
  recordPreflightMarkers,
  emitSeamWithMarkerTable,
  emitReworkHaltWithRelease,
} from './preflight.mjs';
import { teardown, runFinishCloseOut } from './teardown.mjs';
// plan 4066 task 2b: `releaseHeldSlotBestEffort` joins this import — main()'s own two crash-path/
// finally release calls — a sibling reach (head-lock.mjs already exported it for other core
// modules; this file just had no bare call site for it before main() moved).
import {
  acquireWorktreeBeforePreflight,
  dropWorktreeLock,
  releaseHeldSlotBestEffort,
} from './head-lock.mjs';
import { changedFiles, worktreeHeadSha } from './rebase-sync.mjs';
import { unstackSpeculativeBase } from './queue-probe.mjs';
// plan 4066 task 2b: `phaseLaneMerge` joins this import — main()'s own call, moved bodily from
// done-worktree.mjs (which no longer needs it, now that main() itself has moved here too).
import { phaseLaneMerge } from './lane-merge.mjs';
// plan 4066 task 2b: `runStepRegistry` joins `runContextExtras` — phaseDeployCheck's/
// phaseCloseOut's own postMerge/closeOutExtras registry runs, moved bodily alongside them.
import { runContextExtras, runStepRegistry } from './registry.mjs';
import {
  readBoardFile,
  resolveBatchLandingRow,
  recoverBatchStateFromPriorSidecar,
  // plan 4066 task 2b: `closeOut` joins the three names above — phaseCloseOut's own DRY-collapse
  // call, moved bodily alongside it.
  closeOut,
} from './close-out.mjs';

// plan 4066 task 2a: the member-level container-read manifest for this module — every
// `D.<group>.<member>` / `landDeps().<group>.<member>` read this file makes, grouped and sorted.
// Nothing in this file asserts it: container-manifest.mjs imports it alongside its siblings and
// asserts all of them, ONCE, from done-worktree.mjs right after bindLandDeps() binds the real
// container — see that aggregator's own header for why the assertion lives there instead of here.
// container-manifest.test.mjs's parity test keeps this manifest honest against the source below —
// a manifest can neither lag a new read nor carry a stale one. Generated, not hand-typed (a hand
// copy drifts silently): regenerate with the same scanner on a real change to this file's reads.
export const CONTAINER_READS = Object.freeze({
  L: Object.freeze([
    'EXCLUSIVE_LANE',
    'FREE_LANE',
    'MARKER_FAMILIES',
    'PREP_EXIT',
    'SEAM',
    'ambiguousDetachedWorktreeMessage',
    'buildPlanIdIndex',
    'crashResultMergeSha',
    'detachedWaitRefusal',
    'detachedWorktreeCandidates',
    'detachedWorktreeMessage',
    'formatReport',
    'landFullyCompleted',
    'parseDoneArgs',
    'readHeartbeatDays',
    'resolveWorktreeFromPorcelain',
    'seedScopeOf',
    'staleHaltResumeNag',
  ]),
  batchPaths: Object.freeze(['parseBatchManifest', 'resolveManifestRel']),
  claimPlanLib: Object.freeze(['isBatchSlug']),
  coordConfig: Object.freeze(['loadCoordConfig']),
  coordGit: Object.freeze(['resolveMain']),
  coordMetrics: Object.freeze(['recordLandPrepOutcome']),
  coordSessionId: Object.freeze(['coordinationSessionId']),
  ensureCoordReroute: Object.freeze(['installCoordRerouteOnce']),
  env: Object.freeze(['DRY', 'IS_PREP', 'PREP_NO_REBASE']),
  landLib: Object.freeze(['assertLandable', 'branchAlreadyLanded', 'rangePatchIdOnce']),
  readPlanStamps: Object.freeze(['readLandGate']),
  redgreenLib: Object.freeze(['slugFromBranch']),
  spawn: Object.freeze(['gitMain', 'run']),
  spine: Object.freeze([
    'clearLandAttempt',
    'emitSeam',
    'evaluateLandFastPath',
    'hhmmNow',
    'landGateRosterFromRegistry',
    'landRegistries',
    'maybeReexecSpineFromMain',
    'readCarryForwards',
    'readResultSidecar',
    'recoverLandedMergeSha',
    'resolvePlanRelForSlug',
    'runCloseOutIsolated',
    'runNodeDepsPreflight',
    'setRetainedEntryHeartbeatDisarm',
    'stampStepLogClock',
    'stepLog',
    'tryStep',
    'writeResultSidecar',
  ]),
  sweepDeferredWorktrees: Object.freeze(['runSweepAndReport']),
  worktreePorcelain: Object.freeze(['parseWorktreePorcelain']),
});

// plan 1605: derive the CANONICAL board/plan slug from a resolved worktree BRANCH name
// (`worktree-<slug>`), never from the raw CLI argument. On Windows, cut-worktree.mjs truncates
// the worktree DIRECTORY name to 40 chars (plan 909, MAX_PATH headroom), and the operator/agent
// `cd`s into (and later invokes done-worktree with) that truncated name — but the branch name
// and every board/plan-file/INDEX/landing-queue/teardown lookup key off the FULL untruncated
// slug. resolveWorktree() already resolves the truncated form via resolveWorktreeFromPorcelain's
// path-ends-with/branch-name fallback (unchanged here), so `branch` is always the full-length
// source of truth once resolution succeeds. Exported standalone so it's unit-testable without a
// real git worktree (see this module's own resolve-worktree test suite's "canonical slug
// derivation" cases).
//
// Reuses redgreen-lib's slugFromBranch (the existing worktree-<slug> extractor) rather than a
// bare .replace: a bare strip silently returns a NON-worktree branch (or undefined, from
// resolveWorktree's detached-HEAD legacy fallback) UNCHANGED instead of failing loudly — every
// downstream board/plan-file/manifest/landing-queue lookup would then key off the wrong string.
// Throwing here turns that into a diagnosable error at the point of derivation instead of a
// TypeError (or silent wrong-slug corruption) several call sites downstream (/sonnet-review xhigh
// on this same batch, 2026-07-08).
//
// `extract` is injected with a lazy container-read default (the same shape as
// fetchOriginMasterForRepin's `run`/`dry` params in preflight.mjs), so a production caller keeps
// reading the bound container while a standalone unit test (this module's own resolve-worktree
// test suite) can inject redgreen-lib's slugFromBranch directly and never touch landDeps() — a default
// parameter initializer only evaluates when the caller omits the argument. gpt-review round 2
// (e75b9f): taken as a PLAIN second parameter rather than an options bag, so the obvious call
// `canonicalSlugFromBranch(branch, slugFromBranch)` works; wrapped in `{ extract }` it would have
// been ignored and silently fallen back to the container, which is the footgun the injection
// exists to remove. The one-dependency case needs no bag — preflight.mjs's two-dependency
// `fetchOriginMasterForRepin` is where a bag earns itself.
export function canonicalSlugFromBranch(branch, extract = landDeps().redgreenLib.slugFromBranch) {
  const slug = extract(branch);
  if (slug == null) {
    throw new Error(
      `canonicalSlugFromBranch: branch ${JSON.stringify(branch)} does not match worktree-<slug> ` +
        `(undefined/detached-HEAD or a non-worktree branch) — cannot derive a canonical slug for board/plan lookups`,
    );
  }
  return slug;
}

// ── git read helpers (faked under --dry-run) ─────────────────────────
function resolveWorktree(slug) {
  const D = landDeps();
  if (D.env.DRY) {
    // plan 2654: DRY used to hardcode an ATTACHED result, so no test could reach the
    // detached-worktree refusal below. DW_FAKE_DETACHED=1 is that hook.
    if (process.env.DW_FAKE_DETACHED === '1') {
      throw new Error(
        D.L.detachedWorktreeMessage({
          slug,
          wtPath: `<dry:${slug}>`,
          head: process.env.DW_FAKE_BRANCH_TIP || null,
        }),
      );
    }
    return { wtPath: `<dry:${slug}>`, branch: `worktree-${slug}`, detached: false, head: null };
  }
  // resolve by branch name first (handles hobby-root siblings whose path does
  // NOT end in /<slug>), path-ends-with fallback — see lib.resolveWorktreeFromPorcelain.
  // plan 2654 review [14]: parse the porcelain ONCE and hand the entries to both resolvers — the
  // detached path called two functions that each re-parsed the same text.
  const entries = D.worktreePorcelain.parseWorktreePorcelain(
    D.spawn.run('git', ['worktree', 'list', '--porcelain']),
  );
  const hit = D.L.resolveWorktreeFromPorcelain(entries, slug);
  if (hit && !hit.detached) return hit;
  // plan 2654: DEGRADE a detached worktree into a diagnosable refusal instead of the bare
  // `not found in git worktree list` (which is what the plan-2644 wedge actually printed — the
  // worktree existed, it was just unattached, and for a >40-char slug neither resolution key can
  // see it: see detachedWorktreeCandidates' header). Returning it would be worse than throwing —
  // `branch: null` flows straight into rebase/push paths that mutate the wrong ref.
  const candidates = hit?.detached
    ? [{ wtPath: hit.wtPath, head: hit.head }]
    : D.L.detachedWorktreeCandidates(entries, slug);
  if (candidates.length === 1) {
    throw new Error(
      D.L.detachedWorktreeMessage({ slug, wtPath: candidates[0].wtPath, head: candidates[0].head }),
    );
  }
  // review [3]: more than one detached worktree prefix-matches — refuse WITHOUT naming one, or the
  // operator "recovers" an unrelated plan's worktree.
  if (candidates.length > 1) {
    throw new Error(D.L.ambiguousDetachedWorktreeMessage({ slug, candidates }));
  }
  throw new Error(`worktree for slug "${slug}" not found in git worktree list`);
}

// gpt-review 3972 r2 findings 0c0a29 / ee86ea / e204d3: the probe asks whether THIS worktree's HEAD —
// the content this land means — is on origin/master, not whether `origin/<branch>` is. A branch
// rewound on origin to an already-landed commit would otherwise read as "landed" and skip the
// merge (and its expectedHead refusal) for content that never reached master. It runs before
// preflight, so HEAD is the honest "this branch's content"; an unreadable HEAD falls back to the
// ref (the pre-3972 question). gpt-review 3972 r3 finding bd650b: a HEAD on master while
// `origin/<branch>` points elsewhere is NOT "landed" either — branchAlreadyLanded requires the
// remote branch to equal the tip it is asked about, so the merge (and its branch-tip-moved
// refusal) is reached instead of a close-out that discards the moved branch.
function isBranchAlreadyLanded(MAIN, branch, wtPath = null) {
  const D = landDeps();
  if (D.env.DRY) return process.env.DW_FAKE_ALREADY_LANDED === '1';
  try {
    let tip = null;
    if (wtPath) {
      try {
        tip = worktreeHeadSha(wtPath) || null;
      } catch {
        tip = null;
      }
    }
    return D.landLib.branchAlreadyLanded(MAIN, branch, {
      run: (cwd, args) => D.spawn.gitMain(cwd, args),
      tip,
    });
  } catch {
    return false; // any probe failure → take the normal land path (it fails loudly on a real problem)
  }
}

// plan 3295 E5: the per-plan `landGate:` tier, read the SAME way planPriorityFor reads
// `priority:` — resolve the plan file(s) for this slug (or every member of a batch manifest), then
// ask the ONE contracted reader. `'selective'` from ANY member wins for a batch: the tier is an
// opt-out of the full suite, and a batch that mixes tiers has already accepted the loosest one for
// the commits it carries. Absent ⇒ null ⇒ the environment default (LOCAL once-per-land, cloud
// full-every-land). Best-effort by construction: an unreadable plan file reads as "no tier",
// which is the MORE testing direction.
function planLandGateFor(main, slug, manifest) {
  const D = landDeps();
  const lsPlans = D.spawn.run('git', ['-C', main, 'ls-files', 'docs/superpowers/plans']);
  const rels = [];
  if (manifest) {
    const idx = D.L.buildPlanIdIndex(lsPlans, manifest.members);
    for (const rec of idx.values()) if (rec.live) rels.push(rec.live);
  } else {
    const rel = D.spine.resolvePlanRelForSlug(lsPlans, slug);
    if (rel) rels.push(rel);
  }
  for (const rel of rels) {
    try {
      if (D.readPlanStamps.readLandGate(readFileSync(`${main}/${rel}`, 'utf8')) === 'selective')
        return 'selective';
    } catch {
      /* unreadable ⇒ no tier ⇒ the environment default */
    }
  }
  return null;
}

// plan 1364 Ship 3 / plan 1467: read a batch manifest. Since 1467 the manifest lives at
// docs/superpowers/batches/<slug>/manifest.json (written by claim-plan.mjs batch, deleted by
// THIS spine's batch close-out in the same commit that archives every member); an in-flight
// batch grandfathered before the migration is still at the legacy docs/handoff/batches/
// <slug>.json. resolveManifestRel (batch-paths.mjs) reads new-first/legacy-second. The IO
// shell for batchPaths.parseBatchManifest (which stays fs-free per batch-paths.mjs's contract) —
// mirrors the landPrepMarker.read / L.parseLandPrepMarker split. Returns the parsed
// manifest or null (absent / unreadable / corrupt — the caller decides what null means: a
// genuine integrity problem, or proof the batch already landed).
function readBatchManifest(main, slug) {
  const D = landDeps();
  // DRY test hook: DW_FAKE_BATCH_MANIFEST injects a manifest JSON (mirrors DW_FAKE_LAND_PREP).
  if (D.env.DRY) {
    return process.env.DW_FAKE_BATCH_MANIFEST !== undefined
      ? D.batchPaths.parseBatchManifest(process.env.DW_FAKE_BATCH_MANIFEST)
      : null;
  }
  const { rel } = D.batchPaths.resolveManifestRel(main, slug);
  if (!rel) return null; // absent at both paths → caller's ground-truth check decides what that means
  try {
    return D.batchPaths.parseBatchManifest(readFileSync(`${main}/${rel}`, 'utf8'));
  } catch {
    return null; // unreadable / corrupt → same degrade
  }
}

// plan 3961 T2.7a: the once-per-land gate roster, DERIVED from the registry instead of a separate
// `coord.config.json -> land.gateRoster` key — see landGateRosterFromRegistry's own header
// (done-worktree.mjs) for the full contract. `landGateRosterFromRegistry` itself, and
// `landRegistries`, stay `spine` container members rather than moving here: both have real callers
// OUTSIDE this phase (lane-merge.mjs's own `D.spine.landGateRosterFromRegistry(landRegistry)` call,
// and landRegistries's many other spine-group readers), so this async convenience wrapper — whose
// only OTHER caller is the direct test import above — is what reaches both through the container.
//
// Exported for done-worktree.test.mjs, which pins the exact roster (membership AND order) this
// repo's registry produces — a unit-testable guarantee a source-inspection regex could not give.
export async function landGateRoster(mainDir, wtPath = null) {
  const D = landDeps();
  return D.spine.landGateRosterFromRegistry(await D.spine.landRegistries(mainDir, wtPath));
}

// plan 4057 defects 1+2: the seed LANE inputs. These two DW_FAKE_* hooks were the only pair in (core-noun-ok: names the real DW_FAKE_* test hooks below)
// this spine read with NO --dry-run guard — every sibling (DW_FAKE_FOREIGN_DIRT,
// DW_FAKE_INDEX_WRITE, DW_FAKE_REF_LOCK, DW_FAKE_UNPUSHED_MASTER, DW_FAKE_HANDOFF_LAYOUT,
// DW_FAKE_LAND_GATE) is gated, and each says in its own comment that a leaked variable must never
// reach a real land. These two are the load-bearing case: they feed seedScopeOf, whose result (core-noun-ok: names the real function this data feeds)
// decides `state.lane`, which decides whether the land takes the shard-scoped EXCLUSIVE landing
// mutex or runs free. A leaked value could therefore make a genuine seed land resolve FREE-lane (core-noun-ok: names the real mutex-scope concept it feeds)
// and run concurrently with an overlapping seed land — the exact serialization the mutex exists (core-noun-ok: names the real mutex-scope concept it feeds)
// to provide. Every key in `98 Hobby/.env_cloud_drain` is exported in every cloud sandbox, and
// this repo has already been bitten once by a test that assumed an ambient variable was unset.
//
// `dry` is a PARAMETER rather than a read of the module-level DRY: that is what makes the gate
// itself assertable without performing a real land and without mutating ambient state, which is
// the repo's own environment-as-a-parameter rule. The reads keep their name, their order, their
// `??` fallback and their position in main() — only their spelling moved into this named gate.
export function seedLaneInputs(cfg, dry) {
  return {
    seedLaneFile: (dry ? process.env.DW_FAKE_SEED_PATH : undefined) ?? cfg.seedLaneFile,
    seedShardDir: (dry ? process.env.DW_FAKE_SEED_SHARD_DIR : undefined) ?? cfg.seedShardDir,
  };
}

// plan 4066 task 2b: the five-phase driver, moved bodily from scripts/done-worktree.mjs — see
// this file's own header, WHAT TASK 2B ADDED, for the container-access rewrites. Sited ahead of
// phasePreflight (still this file's LAST declaration, unchanged by this move) rather than after
// it, so phasePreflight's own done-worktree.test.mjs pin — which slices its body to this file's
// END — keeps working with no change of its own.
export async function main() {
  const D = landDeps();
  // Refuse ambiguous nested-runtime ownership before preflight mutates queue state.
  D.coordSessionId.coordinationSessionId();
  const ctx = await phasePreflight();
  const { MAIN, branch, finishTeardown, slug, state } = ctx;
  try {
    await phaseLaneMerge(ctx);
    await phaseDeployCheck(ctx);
    await phaseCloseOut(ctx);
    await phaseTeardown(ctx);
  } catch (e) {
    // plan 665 G3: a --wait coordWrite step (enqueue / board) that stayed blocked by a
    // sibling's foreign-dirt for the whole retryOnForeignDirt budget throws { coordContention }.
    // Convert it to a CLEAN, slot-released COORD_CONTENTION seam (emitSeam demotes the mutex +
    // dequeues, then process.exit) instead of a stack trace — transient, so a bare re-invoke
    // re-checks once the sibling commits. Any other throw still hits the finally + propagates.
    // plan 674: guard on !landFullyCompleted — every coordContention source is PRE-merge today,
    // so this is a no-op now, but it keeps the invariant robust: once the land is irreversibly
    // complete, NO throw (even a future post-close-out coordRetry) may exit nonzero — it must
    // fall through to the success-with-teardown-errors report below.
    if (e && e.coordContention && !D.L.landFullyCompleted(state))
      D.spine.emitSeam(D.L.SEAM.COORD_CONTENTION, e.message, state);
    // plan 674: a throw AFTER the land fully completed (merge on origin/master + close-out
    // committed+pushed + mutex released) is NOT a crash — the code shipped and only a best-effort
    // tail/teardown step failed (classically: on Windows the worktree dir could not be removed
    // because it was this process's cwd, then an op on it threw). Record it as a teardown error
    // and fall through to the SUCCESS report + exit 0, instead of a CRASH sidecar / nonzero exit
    // — the false-failure that reads as a failed land and can drive a clobbering hand-merge
    // (plan 665 G4). A PRE-completion throw (merge not landed, OR close-out half-done) still
    // crashes honestly so the operator re-runs (the already-landed re-run finishes the rest).
    if (D.L.landFullyCompleted(state)) {
      (state.teardownErrors ||= []).push(`post-land (best-effort) failure: ${e.message || e}`);
      // plan 1866: the merge is irreversible-forward — a throw that preempted teardown must
      // not strand the worktree dir/branch (the plan-1839 land left the dir for a manual
      // prune + rm). teardown is idempotent (every step is tryStep/soft), so finishing it
      // here is safe; a failure inside it only adds more teardownErrors, never a crash.
      if (!state.toreDown) finishTeardown({ viaCatch: true });
    } else {
      // plan 665 G4.1: an uncaught crash still records the terminal result (state.mergeSha tells
      // a detached caller whether the merge had already landed before the throw).
      // plan 850: if state.mergeSha is still null, the throw may have come AFTER the ephemeral push
      // reached origin/master but BEFORE mergeToMaster's return-value assignment — so the merge
      // demonstrably landed yet state.mergeSha never got set. Probe origin and record the REAL sha,
      // so the sidecar reads "landed (teardown incomplete)" instead of the false "nothing merged"
      // that drives a clobbering hand-merge. Recovery is best-effort and never masks the crash.
      if (!state.mergeSha) {
        state.mergeSha = D.L.crashResultMergeSha(
          state,
          D.spine.recoverLandedMergeSha(MAIN, branch),
        );
      }
      // plan 2411 D3: release the slot/mutex BEFORE writing the sidecar. Previously the sidecar
      // was written HERE (recording `dequeued: false`, `landingReleased: false`) and only the
      // FINALLY below actually let the slot go moments later — so the CRASH sidecar always lied
      // about a slot that was, by construction, about to be released. Both calls are
      // state-guarded idempotent (state.dequeued / state.landingReleased), so running them here
      // makes the finally's calls no-op backstops instead of the sole release point, and the
      // sidecar reflects the TRUE terminal state instead of a stale mid-crash snapshot.
      releaseHeldSlotBestEffort(state, 'crash path');
      // plan 1508: verifyCloseOutOnOrigin throws a distinctly-tagged error when the close-out
      // committed locally but origin/master doesn't yet prove it landed (state.closedOut is
      // still false, so landFullyCompleted() above is already false) — record a CLOSEOUT_UNVERIFIED
      // sidecar instead of the generic CRASH label, so a reader (or a recovery script) can tell
      // "re-invoke, it's a bookkeeping gap" apart from a genuine bug.
      D.spine.writeResultSidecar(state, {
        code: e && e.closeOutUnverified ? 'CLOSEOUT_UNVERIFIED' : 'CRASH',
        exitCode: 1,
      });
      throw e;
    }
  } finally {
    // plan 810: releaseMutexIfHeld frees the HARD lock FIRST, then runs the ADVISORY board demote
    // — and that demote RETHROWS a genuine (non-row-absent) pre-merge board error by design (so the
    // emitSeam call-path can surface a COORD_CONTENTION seam). Group A now makes this path reachable
    // from THIS finally: landingClaimed is set right after the acquire, so a foreign-dirt that breaks
    // the LANDING set-state AND persists through the demote makes releaseMutexIfHeld throw HERE. A
    // throw in a finally would skip dequeueQueueIfHeld (violating its own "a raw throw must never
    // leave a dead FIFO entry" invariant) and MASK the original error. The lock is already freed by
    // then, so record the demote failure and continue — the dequeue must still run and the original
    // throw must still surface.
    releaseHeldSlotBestEffort(state, 'lock already freed'); // covers throw between claim and release; a raw throw must never leave a dead FIFO entry (plan 504)
  }

  D.spine.clearLandAttempt(MAIN, slug); // plan 1528: the land attempt is over — drop its requeue/conflict counters
  D.spine.writeResultSidecar(state, { code: 'SUCCESS', exitCode: 0 }); // plan 665 G4.1: terminal record on the clean land
  state.bannerTime = D.spine.hhmmNow(); // plan 692: local HH:MM for the 🟢 close-safety banner formatReport appends
  process.stdout.write('\n' + D.L.formatReport(state) + '\n');
}

/** Deploy-check phase in the file header's five-phase landing sequence. */
// plan 3961 T2.8: the mandatory --deploy wall (the hosting-provider IO, resolveDeployGateTree,
// checkDeploy) moved to scripts/project/deploy.mjs as the ONE `postMerge` registry entry
// (`deploy`, order 4) — see that module's own header for the full move. This phase now just
// runs the postMerge registry; NOT bestEffort, so a failing wall still aborts the land exactly
// as before, via the entry's own emitSeam call (emitSeam process.exits, so the abort happens
// regardless of runStepRegistry's own try/catch shape).
async function phaseDeployCheck(ctx) {
  await runStepRegistry(ctx.landRegistry.postMerge, ctx);
}

/** Close-out phase in the file header's five-phase landing sequence. */
async function phaseCloseOut(ctx) {
  const D = landDeps();
  const { MAIN, wtPath, state } = ctx;

  // 5 + 6
  // plan 971: run the close-out in an ephemeral worktree off origin/master so foreign dirt
  // on the shared main checkout can never block a completed land. DRY collapses to a direct
  // closeOut(MAIN) so the dry-run trace is unchanged (the finish worktree is a real-git-only
  // construct, covered by the real-git integration tests).
  const carryForwards = D.spine.readCarryForwards(wtPath, state);
  D.spine.stepLog(state, 'close-out: archiving plan + regenerating INDEX + committing');
  if (D.env.DRY) closeOut(MAIN, state, carryForwards);
  else D.spine.runCloseOutIsolated(MAIN, state, carryForwards);
  D.spine.stepLog(state, 'close-out: committed + pushed');
  // plan 3961 T2.9a: a decoupled coverage-sweep step (plan 1082) moved to
  // scripts/project/land-closeout.mjs as a closeOutExtras registry entry — this phase now just
  // runs the registry, exactly as phaseDeployCheck runs `postMerge`. Runs HERE — after the land
  // is fully complete + `_coordMainDir` reset + MAIN fast-forwarded by runCloseOutIsolated, but
  // BEFORE teardown removes the cwd — so it operates on the settled real main checkout via the
  // normal coordWrite path (NOT the ephemeral finish worktree). `bestEffort: true` is this call's
  // own contract (unchanged from before the move): a failing sweep must never fail a land.
  await runStepRegistry(ctx.landRegistry.closeOutExtras, ctx, { bestEffort: true });
}

/** Teardown phase in the file header's five-phase landing sequence. */
async function phaseTeardown(ctx) {
  const D = landDeps();
  const { finishTeardown, state } = ctx;

  // test-only fault injection (plan 1866): a throw AFTER the land fully completed but
  // BEFORE teardown — proves the catch below still finishes teardown (the merge is
  // irreversible-forward, so a late-step throw must never strand the worktree dir).
  // Guarded by env; never set in prod.
  if (process.env.DW_TEST_THROW === 'preteardown')
    throw new Error('DW_TEST_THROW preteardown injected');
  finishTeardown();
  D.spine.stepLog(state, 'teardown: complete — land finished');
  // test-only fault injection (plan 674): a throw AFTER the land fully completed (merge +
  // close-out + teardown) must be reported as SUCCESS (exit 0, errors surfaced), never a
  // CRASH / exit 255. Guarded by env; never set in prod.
  if (process.env.DW_TEST_THROW === 'postland') throw new Error('DW_TEST_THROW postland injected');
}

export async function phasePreflight() {
  const D = landDeps();
  // plan 3832 (gpt-review findings 541110 / 690fee): REFUSE the retired release flags by name.
  // They cannot simply be ignored: `L.parseDoneArgs` takes the first non-`--` token as the slug,
  // so a stale flags-then-slug invocation — plans 3747 and 3748 each still carry one, written to
  // be pasted — would make the free-text release REASON the slug and either die with a baffling
  // worktree-not-found or land a different worktree whose slug coincidentally matched. The old
  // `stripReversionReleaseFlags` dropped the flag and its value token to avoid exactly that; a
  // refusal is the better successor, because whoever runs such a command still believes a halt
  // exists and is owed the news that it does not.
  const retiredFlag = process.argv
    .slice(2)
    .find((t) => t === '--allow-landed-reversion' || t.startsWith('--allow-landed-reversion-'));
  if (retiredFlag) {
    process.stderr.write(
      `done-worktree: ${retiredFlag} is RETIRED (plan 3832). The landed-work-reversion lint no ` +
        `longer halts a land — it prints what the merge removes from master and the land ` +
        `proceeds — so there is nothing to release. Re-run with the slug alone:\n` +
        `  node scripts/done-worktree.mjs <slug>\n` +
        `(docs/coord/worktrees.md § Landed-work-reversion lint.)\n`,
    );
    process.exit(2);
  }
  const a = D.L.parseDoneArgs(process.argv.slice(2).filter((t) => t !== '--dry-run'));
  // plan 3503: silently accepting --no-rebase on a land would make an operator believe HEAD was
  // protected from movement while the ordinary landing spine remained free to rebase it.
  if (D.env.PREP_NO_REBASE && !D.env.IS_PREP) {
    process.stderr.write('done-worktree: --no-rebase is only valid together with --prep\n');
    process.exit(2);
  }
  if (!a.slug) {
    process.stderr.write('done-worktree: missing <slug>\n');
    process.exit(2);
  }
  // plan 3832: plan 3210 Part 3's three scope-pinned `--allow-landed-reversion*` release flags
  // were parsed and validated here. They are RETIRED with the halt they released — a release is
  // only meaningful against a gate that stops the land, and the landed-reversion lint now only
  // reports (see its call site below). Nothing to parse, nothing to validate, and no override
  // trailer to thread into the merge-commit summary.
  // plan 665 G4.3: refuse a DETACHED --wait (non-TTY) before any work — it can complete the
  // land yet report a false exit-255 failure that drives a dangerous hand-merge (plan 662).
  // Pre-work usage refusal: no land started → nothing to record/recover.
  const waitRefusal = D.L.detachedWaitRefusal({
    wait: a.wait,
    isTTY: Boolean(process.stdout.isTTY),
    dry: D.env.DRY,
    env: process.env,
  });
  if (waitRefusal) {
    process.stderr.write(`done-worktree: ${waitRefusal}\n`);
    process.exit(2);
  }
  // plan 2170: --wait (attended, unbounded, TTY-gated) and --wait-chunk (unattended,
  // bounded) are mutually exclusive wait modes — combining them has no coherent meaning.
  if (a.wait && a.waitChunk > 0) {
    process.stderr.write(
      'done-worktree: --wait and --wait-chunk are mutually exclusive — pick one ' +
        '(--wait for an attended foreground TTY, --wait-chunk for an unattended bounded wait).\n',
    );
    process.exit(2);
  }
  const MAIN = D.env.DRY ? '<main>' : D.coordGit.resolveMain();
  // plan 2697: BEFORE any land work, make sure the spine running this land is MAIN's copy and
  // not the (possibly months-old) one checked out in the worktree we were invoked from. plan
  // 4066 task 2a: maybeReexecSpineFromMain cannot MOVE into this module (Rule 3 — it spawns a
  // child process and reads import.meta.url/fileURLToPath), so it stays resident in
  // done-worktree.mjs and is reached through the container instead, at this same original call
  // site.
  const reexecStatus = D.spine.maybeReexecSpineFromMain(MAIN);
  if (reexecStatus !== null) process.exit(reexecStatus);
  // plan 3225 (Fix B): a FRESH invocation whose slug's terminal sidecar shows a RECENT resumable
  // halt gets one loud, early line naming the exact `--resume <CODE>` it probably should have been.
  // Placed AFTER the plan-2697 re-exec deliberately: when a worktree's own spine copy re-execs
  // MAIN's, BOTH processes run this function, so nagging before the re-exec prints the same
  // paragraph twice (observed live while building this). It still lands well before any land work,
  // which is all the timing this needs. Warn-only and best-effort in every direction: the decider
  // is pure (staleHaltResumeNag), the sidecar read already fails safe to null, and nothing
  // downstream branches on it.
  if (!D.env.DRY) {
    const nag = D.L.staleHaltResumeNag({
      sidecar: D.spine.readResultSidecar(MAIN, a.slug),
      slug: a.slug,
      nowMs: Date.now(),
      resume: a.resume,
      prep: a.prep,
    });
    if (nag) process.stderr.write(`${nag}\n`);
  }
  // plan 674: chdir to MAIN before any further work. pickup-plan step 7 cd's the session INTO
  // .claude/worktrees/<slug>, and a session that then self-invokes the spine inherits that cwd.
  // On Windows a live process's cwd dir CANNOT be removed, so teardown step 3 left the worktree
  // dir behind AND something on the path then threw on the doomed cwd → the land COMPLETED but
  // the process exited 255 with a CRASH sidecar (the plan-665 G4 false-failure that can drive a
  // clobbering hand-merge; the 2026-06-15 plan-657 land). Running from MAIN, the worktree is
  // never this process's cwd: teardown removes it cleanly and no child spawn inherits a
  // to-be-deleted cwd. Every later step uses `-C MAIN` / `-C wtPath` / an explicit `cwd:` or a
  // MAIN-relative `scripts/…` (which resolves against MAIN's master copy — always the landed
  // version, never a stale worktree copy), so the chdir is safe. DRY's MAIN is a placeholder.
  if (!D.env.DRY) process.chdir(MAIN);
  // plan 1770: install the cloud coord-push reroute UP FRONT, before any push in the land. The spine's
  // OWN push paths — pushMaster, the worktree-branch force-push, the remote-branch delete at teardown —
  // use execFileSync/run() directly and bypass coord-git's git() reroute hook, so on a cloud checkout
  // they would still 403 on the proxy (branch deletes especially). Because the reroute installs GLOBAL
  // git config, one early call makes every subsequent push in this process (seam-routed or not) reach
  // github. Shares the SAME once-per-process latch + inner retry as the git() seam
  // (installCoordRerouteOnce), so this and the later seam-routed coord pushes neither double-install
  // nor re-probe. No-op off-cloud; never throws. Uses the shared default logger (console.error →
  // stderr), not a second copy.
  if (!D.env.DRY) D.ensureCoordReroute.installCoordRerouteOnce(MAIN);
  // plan 2218: idle sweep — retry (once each, no storm) any worktree dirs a prior
  // teardown deferred as locked. Runs BEFORE this land's own gates, at a natural
  // idle-ish moment when the prior locker (a dead session's handles) is normally gone.
  // Best-effort (runSweepAndReport never throws). The worktree being landed here is
  // protected by the sweep's RECREATED=LIVE age check — and the one same-slug marker
  // case (a prior COMPLETED land whose teardown deferred this very dir) is exactly a
  // removal that SHOULD finish, after which resolveWorktree's "not found" correctly
  // routes to the already-landed recovery path.
  // plan 3375: --finish-close-out returns HERE, one line before resolveWorktree — which is the
  // exact call that makes a bare re-invoke impossible once the worktree is gone (it reads this
  // checkout's `git worktree list` and throws `worktree for slug "…" not found`). A resumed
  // close-out needs no worktree, runs no gate, and never merges; everything it needs it reads
  // from origin. DRY has no real origin to read, so the mode is a non-dry path only.
  if (a.finishCloseOut) {
    if (D.env.DRY) {
      process.stderr.write('done-worktree: --finish-close-out is not available under --dry-run\n');
      process.exit(2);
    }
    process.exit(runFinishCloseOut(MAIN, a.slug));
  }
  // Deliberately AFTER the --finish-close-out return: the deferred-worktree sweep removes
  // worktree dirs and prunes registrations, i.e. it MUTATES exactly the local state
  // gatherCloseOutFacts is about to read. A resume must observe where the dead land actually
  // stopped, not a state this invocation just changed underneath it (gpt-review).
  if (!D.env.DRY) D.sweepDeferredWorktrees.runSweepAndReport(MAIN, 'done-worktree');
  const { wtPath, branch } = resolveWorktree(a.slug);
  // plan 1605: canonicalSlugFromBranch (defined above resolveWorktree) is the fix — every
  // consumer below MUST use `slug`, never `a.slug` (the raw, possibly Windows-truncated CLI
  // argument); a single missed consumer reproduces the "row not found" crash one layer deeper
  // (plan 1278 landing incident).
  const slug = canonicalSlugFromBranch(branch);
  const state = {
    slug,
    branch,
    main: MAIN, // plan 665 G4: resolve the `.scratch` sidecar dir without re-resolving in helpers
    wtPath, // named in formatReport's honest-teardown line when teardown is incomplete
    // plan 2473: groups THIS invocation's land-prep telemetry records (the pre-enqueue verdict and
    // the at-head final one) so the summary can prefer the final verdict per land. Per-INVOCATION,
    // not per-plan: a seam-out + re-invoke is two separate samples today and stays two, which is
    // what keeps the series comparable with the pre-2473 baseline.
    landId: randomUUID(),
    prepDispatched: false, // plan 2473: at most one detached --prep dispatch per invocation
    prepDispatchedSpeculative: false, // plan 2463: …plus one at the speculative position
    // plan 3972: a branch sync (pre-queue freshen or at-head rebase) was SKIPPED this invocation
    // because the master delta was coordination-only and merge-tree clean — the acceptance reads
    // it off the terminal sidecar (writeResultSidecar) next to the phases[] that prove no
    // `rebase:` / push line ran.
    syncSkipped: false,
    syncSkipSites: { preQueue: false, atHead: false }, // plan 3972: the per-site record
    // plan 2473: the worktree lock this invocation owns, {path, token}. Taken before preflight,
    // released before the queue wait, re-taken at head. Null while deliberately not held.
    worktreeLock: null,
    lane: null,
    landingClaimed: false,
    landingReleased: false,
    queued: false, // plan 504: holds a FIFO landing-queue slot
    dequeued: false,
    claimReleased: false,
    closedOut: false, // plan 674: close-out committed+pushed → land irreversibly complete (landFullyCompleted)
    mergeSha: null,
    deployStatus: null,
    planArchived: null,
    heartbeatReparked: null, // plan 1329: basename of a heartbeat plan re-filed to waiting-date/ (not archived)
    promoted: [],
    promotedToPending: [], // plan 3975: unblocked but not specced — parked in pending-approval/
    promotedToOperator: [], // plan 3975: specced but a ready/ gate failed — parked in waiting-operator/
    newPlans: [],
    legacyReadyMints: [], // plan 1419: titles carrying a retired legacy (ready) bullet token
    carryForwardsSkipped: [], // plan 665 G2: carry-forwards a prior interrupted close-out already filed
    killed: 0,
    memory: { moved: 0, dup: 0, diverged: 0 },
    toreDown: false, // plan 1866: teardown ran (normal path) — the catch must not re-run it

    decision: a.decision,
    wait: a.wait, // plan 665 G3: gate coordRetry — retry coord steps on foreign-dirt only in --wait mode
    carryforwardDefer: a.carryforwardDefer, // plan 629: auto-defer ambiguous carry-forwards (drain)
    date: D.env.DRY
      ? '<date>'
      : D.spawn.run('node', ['-e', 'process.stdout.write(new Date().toISOString().slice(0,10))']),
    host: D.env.DRY ? '<host>' : D.spawn.run('hostname'),
    // plan 2414: the queue's `session` cell was never actually stamped by the spine
    // (every real enqueue omitted `--session`, defaulting to the CLI's own `?`
    // placeholder) — which meant demoteVerdict's self-demote refusal could never tell
    // two DIFFERENT sessions' entries apart, or worse, would have false-matched two
    // unrelated `?`-defaulted entries had it not excluded the placeholder. Wire the
    // real identity through: the same shared resolver claim-plan.mjs uses for its
    // session identity (`buildClaimMessage`), so "the demoter and the
    // head belong to the same session" means the same live agent session, not a
    // coincidence. Absent (headless invocation) → the CLI's own `?` sentinel,
    // which demoteVerdict never treats as a match.
    session: D.env.DRY ? '<session>' : D.coordSessionId.coordinationSessionId() || '?',
    batch: null, // plan 1364 Ship 3: { manifest, dispositions? } for a batch land; null = single-plan
    // plan 3295 E2: the per-LAND proof set + the land id that survives a re-invocation. Filled by
    // hydrateLandGatesProven immediately below, off this worktree's own sidecar. Deliberately NOT
    // folded into `landId` above — that one is per-INVOCATION by plan-2473 contract (telemetry
    // comparability), and the once-per-land proof needs exactly the opposite lifetime.
    landGateId: null,
    gatesProven: {},
    // plan 3295 E5: the per-plan `landGate:` tier (`'selective'` or null = the environment
    // default). Resolved lazily at the preflight, where the plan file is cheap to reach.
    landGate: null,
  };
  // plan 3960 review fix (finding 20), now plan 3961 T2.7a: read the REGISTERED roster here
  // (ahead of this function's own later `cfg` binding, which this call sits before) so a sidecar
  // proof for a gate the registry does not register is never adopted as authorizing a skip. This
  // is the one call site that has no `landRegistry` handle yet — the spine's own is built later in
  // this function — so it asks landGateRoster() for its own; landRegistries()'s memoization means
  // that later build is a cache hit, not a second one.
  hydrateLandGatesProven(state, wtPath, await landGateRoster(MAIN, wtPath));
  if (!D.env.DRY) D.spine.stampStepLogClock(); // plan 1653: land-progress heartbeat clock (see stepLog)

  // plan 1866: the ONE teardown-completion sequence (narrate → teardown → toreDown flag),
  // shared by the normal path and the catch's post-land-failure recovery so the two call
  // sites can never drift (review finding on this plan's own diff). The recovery variant
  // is tryStep-wrapped: by then an error is already recorded and a second failure must
  // only add a teardownError, never crash the SUCCESS fall-through.
  const finishTeardown = ({ viaCatch = false } = {}) => {
    D.spine.stepLog(
      state,
      viaCatch
        ? 'teardown (after post-land failure): killing dev servers + removing the worktree'
        : 'teardown: killing dev servers + removing the worktree',
    );
    if (viaCatch)
      D.spine.tryStep(state, 'teardown-after-post-land-failure', () =>
        teardown(MAIN, wtPath, branch, state),
      );
    else teardown(MAIN, wtPath, branch, state);
    state.toreDown = true;
  };

  // plan 1364 Ship 3 / plan 1467: batch detection — by MANIFEST PRESENCE (new path
  // docs/superpowers/batches/<slug>/manifest.json, legacy docs/handoff/batches/<slug>.json;
  // readBatchManifest resolves new-first/legacy-second), never slug-parsing alone. A
  // `batch-`-prefixed slug with a readable manifest is a batch land;
  // one with NO manifest is either (a) a genuine integrity problem (a batch claim always writes
  // the manifest — hard error naming the path) or (b) a bare re-invoke of an ALREADY-LANDED batch
  // whose close-out already deleted the manifest in the same atomic commit that archived every
  // member (see closeOutBatch) — proven via isBranchAlreadyLanded, the SAME ground-truth probe
  // the rest of main() uses for the single-plan "only bookkeeping remains" fast path. (b) must
  // NOT hard-error: a re-invoke that crashed only during teardown has to reach it cleanly.
  if (D.claimPlanLib.isBatchSlug(slug)) {
    const manifest = readBatchManifest(MAIN, slug);
    if (manifest) {
      state.batch = { manifest };
      // plan 1329: refuse a batch land whose manifest contains a heartbeat plan. The batch
      // close-out archives EVERY member (archiveBatchMembers), and the plan-1329 re-file branch
      // lives ONLY in the single-plan closeOutSingle path — so a batched heartbeat would be
      // permanently archived, silently killing its recurring cadence and reintroducing the exact
      // archive-consistency-lint bug this plan fixes. Fail HERE, before the merge (no stranding);
      // land the heartbeat singly. DRY has no real plan files to read, so skip (guarded below).
      if (!D.env.DRY) {
        const lsPlans = D.spawn.run('git', ['-C', MAIN, 'ls-files', 'docs/superpowers/plans']);
        const idx = D.L.buildPlanIdIndex(lsPlans, manifest.members);
        // plan 1454: the batch's LANDING board marker must live on a representative
        // MEMBER row — claim-plan.mjs batch creates member-keyed rows (never a batch-slug
        // row) and board.mjs's LANDING set-state is deliberately strict (throws "row not
        // found" rather than silently drop the cross-session mutex marker). Resolve the first
        // member whose board row slug is recoverable; the LANDING acquire + its demote twin
        // target it (landingBoardSlug), falling back to the batch slug only if none resolves.
        //
        // plan 1478 (belt-and-suspenders): gate the representative on real board-row PRESENCE,
        // not merely on the plan FILE resolving. `claim-plan.mjs derail` is now the source-of-
        // truth reconcile that drops a mid-train derailed member from the manifest — so a
        // reconciled derail never reaches here. But if a derail bug elsewhere ever leaves a
        // member in the manifest whose board row was already removed, the pre-1478 code picked
        // that member (its re-parked file still resolves a slug) and fed the strict LANDING
        // set-state a rowless slug → the "row not found" crash that lost the queue slot. Skip
        // such stale members here + warn LOUDLY (the mismatch is a derail that did not reconcile
        // the manifest); the close-out's archiveBatchMembers then dispositions them
        // (reparked-skipped). This is a cheap guard, NOT full Option B — the real fix is derail.
        // loadCoordConfig(MAIN) cannot change within one done-worktree invocation — resolve the
        // board path ONCE and reuse it below (both here and the all-rowless error message).
        const { rel: boardFileRel, content: boardContent } = readBoardFile(MAIN);
        const { landingRowSlug, staleMembers } = resolveBatchLandingRow(
          manifest.members,
          idx,
          boardContent,
        );
        state.batch.landingRowSlug = landingRowSlug;
        if (staleMembers.length) {
          const detail = staleMembers.map((m) => `${m.id} (row ${m.rowSlug})`).join(', ');
          process.stderr.write(
            `done-worktree: WARNING — batch "${slug}": ${staleMembers.length} manifest member(s) ` +
              `[${detail}] are LISTED in the manifest but have NO board row under their current ` +
              `basename slug OR their plan id (a rename-desynced row would have matched by id, ` +
              `plan 1801). This is a mid-train derail that did NOT reconcile the manifest — run ` +
              `\`node scripts/claim-plan.mjs derail <id>\` for each (plan 1478; derail removes ` +
              `board rows by plan id, so it works even on a plan renamed while claimed). Skipping ` +
              `them for the LANDING representative and letting the close-out disposition them; ` +
              `the land proceeds for the surviving members.\n`,
          );
          (state.teardownErrors ||= []).push(
            `batch ${slug}: manifest member(s) [${detail}] had no board row under basename slug ` +
              `or plan id (unreconciled derail — \`claim-plan.mjs derail <id>\`, plan 1478/1801); ` +
              `skipped for LANDING + left to the close-out.`,
          );
        }
        // plan 1454 review F4 / plan 1478: fail LOUD + NAMED if NO member has a present board
        // row — otherwise landingBoardSlug's batch-slug fallback would feed the strict LANDING
        // set-state a slug with no row and reproduce the exact crash this plan fixes. A real
        // claimed batch always has ≥1 member with a live ACTIVE row; an all-rowless manifest
        // means every member derailed (the batch should be CLOSED, not landed) or manifest drift.
        if (!state.batch.landingRowSlug) {
          throw new Error(
            `done-worktree: batch "${slug}" — none of its manifest members ` +
              `(${manifest.members.join(', ')}) resolve to a PRESENT board row in ` +
              `${boardFileRel}. The LANDING mutex marker is stamped on a ` +
              `representative member row, so an all-unresolvable manifest cannot land — every member ` +
              `looks derailed; close the batch rather than land it, or investigate the manifest / ` +
              `member ids in ${D.batchPaths.newManifestRel(slug)}.`,
          );
        }
        const hb = manifest.members.filter((id) => {
          const rec = idx.get(String(id));
          const rel = rec && rec.live;
          return (
            rel &&
            existsSync(`${MAIN}/${rel}`) &&
            D.L.readHeartbeatDays(readFileSync(`${MAIN}/${rel}`, 'utf8'))
          );
        });
        if (hb.length) {
          throw new Error(
            `done-worktree: batch "${slug}" contains heartbeat plan(s) ${hb.join(', ')} — a heartbeat ` +
              `(frontmatter \`heartbeat: <days>\`) re-files to waiting-date/ on land and must NOT be batched ` +
              `(the batch close-out would archive it, killing its recurring cadence — plan 1329). Remove it ` +
              `from ${D.batchPaths.newManifestRel(slug)} and land it singly.`,
          );
        }
      }
    } else if (isBranchAlreadyLanded(MAIN, branch, wtPath)) {
      // plan 1508 review fix (F1): a bare re-invoke after a PRIOR run's close-out committed +
      // pushed the manifest-delete/archive commit (proving isBranchAlreadyLanded) but then hit
      // CLOSEOUT_UNVERIFIED on the board-row-removal push — there is no manifest left to
      // re-derive member ids / row slugs from (git rm already landed it), so leaving
      // dispositions/rowSlugs empty here would make verifyCloseOutOnOrigin's checks trivially
      // pass (rowSlugs=[] / bases=[]), reporting SUCCESS with the stale row still on origin —
      // the exact plan-1384 bug, on the exact retry path this plan exists to close. Recover them
      // from the PRIOR run's own CLOSEOUT_UNVERIFIED sidecar so the retry re-verifies the SAME
      // rows/archives instead of silently skipping the check.
      state.batch = recoverBatchStateFromPriorSidecar(D.spine.readResultSidecar(MAIN, slug));
    } else {
      throw new Error(
        `done-worktree: batch slug "${slug}" has no manifest at ` +
          `${D.batchPaths.newManifestRel(slug)} (nor the legacy docs/handoff/batches/${slug}.json) — a batch ` +
          `claim (\`claim-plan.mjs batch\`) always writes this file. This branch is also NOT yet merged ` +
          `to origin/master, so the manifest's absence is not explained by an already-completed ` +
          `close-out; investigate before proceeding.`,
      );
    }
  }

  // plan 2473 (review [0]): own the worktree BEFORE preflight — preflight can `git reset --hard`
  // the branch (see acquireWorktreeBeforePreflight's header), so it must never run while a prep
  // child is mid-rebase in this same tree. review 2473-r2 [6]: the return value IS the channel —
  // a `--prep` invocation that must stand down comes back as L.PREP_EXIT.BUSY and exits through the
  // same funnel as every other prep outcome, rather than the helper exiting the process itself.
  const preLock = acquireWorktreeBeforePreflight(state, a);
  if (preLock === D.L.PREP_EXIT.BUSY) process.exit(D.L.PREP_EXIT.BUSY);

  // plan 2992: arm the retained-entry heartbeat tick for the WHOLE pre-queue gate phase
  // that follows (pytest gate, scripts-battery gate, production build, mobile preflight), (core-noun-ok: names the real registered gate this arms for)
  // BEFORE any of those steps run. Never on --prep: a prep child does not own the queue
  // entry, the land invocation does (armRetainedEntryHeartbeat would find no owned entry
  // for a prep-only worktree anyway in the common case, but a --prep re-invocation of a
  // slug that ALSO happens to hold a real queue entry must still not double-arm this —
  // that liveness story belongs to the land invocation alone). Never in DRY — no real
  // queue, no real timer, byte-identical dry-run trace. Disarmed explicitly right before
  // queueEnqueueAndGate below (from there its own plan-2085/2414 machinery owns
  // liveness) and, as a backstop, from the process 'exit' hook above.
  if (!D.env.DRY && !a.prep) {
    D.spine.setRetainedEntryHeartbeatDisarm(armRetainedEntryHeartbeat(state));
  }

  // 1. PREFLIGHT
  D.spine.stepLog(state, 'preflight: checking the worktree branch is landable');
  const pf = preflight(wtPath, branch, state);
  if (pf) D.spine.emitSeam(pf.code, pf.reason, state);

  // 1b. LAND HEALTH-GUARD (plan 355) — turn a residual wedge on the SHARED main
  // tree (orphan autostash / unmerged paths / unpushed master left by a prior
  // failed landing) into a loud, named stop BEFORE any merge, instead of silently
  // compounding it. Skipped in DRY (no real tree to inspect) UNLESS the
  // DW_FAKE_UNPUSHED_MASTER test hook is set (mirrors DW_FAKE_LANDED_REVERSION — exercises the
  // plan-2497 bounded retry below without a real diverged main tree).
  if (!D.env.DRY || process.env.DW_FAKE_UNPUSHED_MASTER !== undefined) {
    D.spine.stepLog(state, 'land health-guard: checking the shared main tree for residual wedges');
    let landableErr = null;
    if (D.env.DRY) {
      // DW_FAKE_UNPUSHED_MASTER (honoured ONLY under --dry-run): simulates assertLandable's
      // FIRST throw as 'unpushed-master' so the retry loop below is exercisable without a real
      // git tree — a leaked env var can never fire this in a real run (the `!DRY ||` above is
      // moot once DRY is false, so the fake branch itself never runs outside --dry-run).
      landableErr = new Error('DRY fake unpushed-master (DW_FAKE_UNPUSHED_MASTER test hook)');
      landableErr.reason = 'unpushed-master';
    } else {
      try {
        D.landLib.assertLandable(MAIN);
      } catch (e) {
        landableErr = e;
      }
    }
    // plan 2497: bounded in-place re-check, ONLY for the 'unpushed-master' reason (a live
    // peer's own unpushed commit) — every OTHER assertLandable reason (orphan-autostash,
    // unmerged-paths, an empty/opaque ahead commit) falls straight through to the unchanged
    // LAND_BLOCKED seam below, unretried, exactly as before this plan.
    if (landableErr && landableErr.reason === 'unpushed-master') {
      landableErr = unpushedMasterRetryClears(MAIN, landableErr);
    }
    if (landableErr) {
      D.spine.emitSeam(
        D.L.SEAM.LAND_BLOCKED,
        `${landableErr.reason}: ${landableErr.message} — resolve on the shared main tree per ` +
          `docs/coord/land-spine.md (the pre-land guard, \`assertLandable\`) ` +
          `(\`git stash drop\` / resolve+commit / push master), then re-invoke done-worktree.`,
        state,
      );
    }
  }

  // lane + seed scope (plan 1300: the landing-lock serializes on SCOPE — global (core-noun-ok: names the real config-seam concept — seedShardDir/seedLaneFile — this locks on)
  // for a monolith/manifest touch, the exact record shard set otherwise — so (core-noun-ok: names the real config-seam concept — seedShardDir/seedLaneFile — this locks on)
  // disjoint-record seed-write lands stop contending while same-record ones still do; (core-noun-ok: names the real mutationBanner label this mutex gates on)
  // plan 1867: record-sharded derived data (render-fingerprints / render-store) (core-noun-ok: names the real derivedShardDirs store basenames this scope covers)
  // joins the same scope, and the append-only observations logs are global-on-touch)
  const changed = changedFiles(wtPath);
  // plan 3961 T2 review round 2 (90ea7b reversed / 12tht80 / 1obyck3 / 1ndzjh3 / e8d5pn): land
  // policy is read from the MAIN checkout, never from the branch under land — a branch that ships
  // its own `land.*` policy (e.g. handoffLayout, which decides whether the mandatory
  // CONCLUSION_REVIEW / WIKI_CHECKPOINT seams run at all) must not get to choose the gates that (core-noun-ok: names the real registered seam codes)
  // judge it. The round-1 worktree-first read let it do exactly that, and its `existsSync(wtPath)`
  // fallback tested the DIRECTORY, not whether a coord.config.json lived in it, and was captured
  // before the queue-head rebase and reused unchanged. Accepted consequence: a branch that ADDS
  // new land policy does not see that policy on its own land — it applies from the next land
  // onward. That is the safe direction.
  const cfg = D.coordConfig.loadCoordConfig(MAIN);
  // DRY's synthetic `<main>` has no coord.config.json, so its layout falls back to 'single' and
  // cannot reach layout-gated seams (2.672 CONCLUSION_REVIEW / 2.68 WIKI_CHECKPOINT). The `DRY &&` (core-noun-ok: names the real registered seam codes)
  // guard is load-bearing: this variable disables both land gates, so it must be unreachable on a
  // real land.
  if (D.env.DRY && process.env.DW_FAKE_HANDOFF_LAYOUT !== undefined) {
    cfg.handoffLayout = process.env.DW_FAKE_HANDOFF_LAYOUT;
  }
  // plan 4071 wave 2.0: `shardIdPattern` has the SAME "DRY's synthetic `<main>` has no
  // coord.config.json" problem as handoffLayout just above, but plan 4071 makes it bite for the
  // first time — before this plan, coord-config.mjs's DEFAULTS.shardIdPattern WAS the project's
  // literal, so the bare-defaults fallback under DRY happened to already carry the right value.
  // Now that the core default is project-neutral (null), a DRY land needs the REAL project's row
  // to recognize a sharded data file at all (the scope, status-flip and review seams below
  // all key off `cfg.shardIdPattern`). Two layers, same shape as DW_FAKE_HANDOFF_LAYOUT +
  // the worktreeMemoryReclaimScript precedent below:
  //   1. DW_FAKE_SHARD_ID_PATTERN, when set, wins outright — a test fixture that wants full
  //      hermeticity (never depending on whatever a real MAIN checkout's coord.config.json
  //      happens to carry at the moment the test runs — e.g. a plan not yet landed to master)
  //      states its own pattern explicitly, exactly like the sibling DW_FAKE_SEED_SHARD_DIR
  //      override already does for the sibling key (core-noun-ok: names the real env-var
  //      identifier, which is the whole point of the cross-reference).
  //   2. Otherwise it reads through the ACTUAL resolveMain() — a real git sandbox built with its
  //      own coord.config.json (the land-parity harness) or, once this plan lands, the real MAIN
  //      — swallowed to null on any resolution failure (a detached/non-git MAIN) rather than
  //      failing preflight, the same safe-null posture worktreeMemoryReclaimScript already uses.
  if (D.env.DRY && process.env.DW_FAKE_SHARD_ID_PATTERN !== undefined) {
    cfg.shardIdPattern = process.env.DW_FAKE_SHARD_ID_PATTERN;
  } else if (D.env.DRY) {
    try {
      cfg.shardIdPattern = D.coordConfig.loadCoordConfig(D.coordGit.resolveMain()).shardIdPattern;
    } catch {
      cfg.shardIdPattern = null;
    }
  }
  // plan 3961 T2 review round 3 (fix 1a, keys af2308/816457/a6cc84): the memory-reclaim
  // teardown step used to re-resolve `resolveMain()` + `loadCoordConfig()` for itself, INSIDE
  // teardown() — which runs after opportunisticFfMain has already fast-forwarded MAIN over the
  // just-merged branch, so that read picked up the BRANCH's own coord.config.json, not the
  // pre-land one, defeating the round-2 rule right above (same rule, different site). Resolve
  // the value ONCE here — this is that same round-2 pre-land `cfg`, read before any merge — and
  // carry it on `state` for teardown to read back. Under `--dry-run`, `cfg` above came from the
  // `'<main>'` sentinel (no coord.config.json on disk), but the parity goldens DO carry this
  // step's real script path (`DRY pwsh -NoProfile -File <home>/.claude/scripts/
  // reclaim-worktree-memory.ps1 …`), so DRY reads through a FRESH resolveMain() instead of
  // `cfg` to keep them byte-identical. A throw either way (a detached MAIN, which
  // resolveMain() rejects — the second defect this fix closes: the step used to go silently
  // missing there via tryStep's swallow) yields null rather than failing preflight — the
  // reclaim step has always been best-effort.
  // plan 3961 T2 review round 4: ONE `Object.defineProperty` call at the real computed value,
  // not a placeholder-then-assign pair (a fragile earlier shape whose non-enumerability only
  // survived because a later plain `=` assignment to an existing property inherits the
  // property's own descriptor — a future edit that dropped the placeholder as "inert init"
  // would have turned this field ordinary-enumerable with nothing to catch it). Declared
  // NON-ENUMERABLE deliberately: emitSeam's seam-halt dump (`JSON.stringify({ code, reason,
  // state })`, what every parity golden's `"state": {...}` block captures) walks state's OWN
  // ENUMERABLE keys, so an enumerable field here would appear in goldens that have nothing to
  // do with teardown or the reclaim step.
  Object.defineProperty(state, 'worktreeMemoryReclaimScript', {
    value: (() => {
      try {
        return D.env.DRY
          ? D.coordConfig.loadCoordConfig(D.coordGit.resolveMain()).land.worktreeMemoryReclaimScript
          : cfg.land.worktreeMemoryReclaimScript;
      } catch {
        return null;
      }
    })(),
    writable: true,
    enumerable: false,
    configurable: true,
  });
  // plan 3961 T1d: the SECOND gate-running site's handle on the registries (the first is
  // runPrepGates, feeding `--prep`). Built once here, above every seam and gate below, so the land
  // path and the prep pass address the same roster — the divergence this step exists to close.
  const landRegistry = await D.spine.landRegistries(MAIN, wtPath);
  const { seedLaneFile, seedShardDir } = seedLaneInputs(cfg, D.env.DRY);
  state.seedScope = D.L.seedScopeOf(changed, seedLaneFile, seedShardDir, {
    shardDirs: cfg.derivedShardDirs,
    globalFiles: cfg.derivedGlobalFiles,
    // plan 3960 cluster-1 review fix: without these two, seedScopeOf silently fell back to its (core-noun-ok: names the real function this config feeds)
    // own module-load-time defaults (coord-config.mjs's static DEFAULTS, never this repo's
    // loaded coord.config.json) for shardIdPattern/scopeMaxKeys — the seam those two config keys
    // exist for was inert. cfg is the ACTUAL loaded config a few lines above; vetapp's own (core-noun-ok: names the real function this config feeds)
    // coord.config.json sets neither key, so this is byte-identical to before this fix.
    maxRecords: cfg.scopeMaxKeys,
    shardIdPattern: cfg.shardIdPattern,
  });
  state.lane = state.seedScope === null ? D.L.FREE_LANE : D.L.EXCLUSIVE_LANE;

  // 1b.5 NODE-DEPS PREFLIGHT (plan 1723 E2) — moved whole to land-preflight-steps.mjs's
  // `runNodeDepsPreflightStep` at plan 4042 (D-A tail); see that function's own header for the
  // full move. Same guard, same seam code/message text, same exit code.
  D.spine.runNodeDepsPreflight({ wtPath, changed, state });

  // plan 972: --prep (keep-hot) is a STANDALONE mode — rebase the queued branch onto the live
  // origin/master, re-validate the applicable gates, and stamp the land-prep marker, then RETURN
  // before the land flow (it never merges). Driven by the 969 watcher while the plan waits for
  // its FIFO slot, so the head-of-queue land can fast-path past the rebase + gate re-runs.
  if (a.prep) {
    process.exit(await runLandPrep(MAIN, wtPath, branch, slug, changed, state));
  }

  // A seam is skipped when the agent re-invokes `--resume <CODE>` for it — i.e.
  // it already did the human/LLM thing (ran review, resolved a conflict, took an
  // operator decision) and is continuing past that exact fork.
  const resumedPast = (code) => a.resume === code;

  // plan 651: a bare re-run after a partial/interrupted close-out — the merge ALREADY
  // landed (branch is an ancestor of origin/master) and only bookkeeping remains. Skip
  // the WHOLE pre-merge prep (review/build/artifact seams, the FIFO queue enqueue, the
  // seed landing-lock, the rebase) so the re-run goes straight to the merge step (which (core-noun-ok: names the real mutex-scope concept this locks on)
  // re-detects the landed branch and skips the re-merge) + close-out, instead of
  // re-enqueueing at the BACK of the landing queue for pure bookkeeping (the 642 land:
  // head slot lost, ETA ~64 min). Probed AFTER preflight + assertLandable so those
  // structural safety checks still run. The pre-merge GATES are all moot post-merge —
  // their purpose is to vet the diff BEFORE it reaches master, and it already has.
  const alreadyLanded = isBranchAlreadyLanded(MAIN, branch, wtPath);

  // plan 972 Tier 3: head-of-queue FAST-PATH. If the keep-hot driver (--prep) already rebased
  // this branch onto the live origin/master and re-validated its gates — a land-prep marker that
  // still covers the live tree — the head-time rebase is provably a no-op and the gates already
  // passed against this exact tree. Skip BOTH so the mutex-held window collapses to merge+push.
  // STRICT: any movement of either tip invalidates the marker (landPrepValid) and we fall back to
  // the full rebase + gate path — never a silent skip. Inert until --prep stamps a marker (no
  // marker ⇒ false ⇒ today's behavior), and only on a fresh (non-resume) head invocation.
  let landFastPath = false;
  // plan 2433: the sha the landed-reversion advisory (see its own block further down) pins its
  // masterRef/base to — set from whichever path actually re-checked origin/master's live tip
  // (the fast-path proof here, or the clean-rebase capture further down), never re-resolved
  // afterward. Stays null on the alreadyLanded/resume paths, which keep the live-ref read.
  let reversionMasterRef = null;
  // plan 2473: the worktree is ALREADY held — acquireWorktreeBeforePreflight took it above, and it
  // stays held across this whole pre-enqueue preflight span. That matters because `next build` and
  // the WebKit gate read the source tree and write build output into it, so a prep rebasing
  // underneath them could fail an honest gate against a tree that never existed as a commit.
  // Hoisting the acquire to before preflight (review [0]) subsumed the separate, weaker
  // NON-BLOCKING take that used to sit here: back then this span could run alongside a prep and
  // only logged the fact. It cannot now — anyone reaching this line owns the worktree.

  // plan 2463 D5: BEFORE any fast-path proof or gate decision, make sure this branch is not still
  // stacked on a speculative base that never landed. Running it here (pre-enqueue) means the
  // un-stack's own force-push pays its battery off the queue entirely; the twin call at head
  // catches a head that failed out DURING our wait.
  if (!alreadyLanded && !a.resume) unstackSpeculativeBase(MAIN, wtPath, branch, slug);

  if (!alreadyLanded && !a.resume) {
    const ev = D.spine.evaluateLandFastPath(MAIN, wtPath, branch, slug, changed);
    landFastPath = ev.fastPath;
    // plan 1011 Phase 0: record the fast-path outcome so its hit-rate is measurable. Deliberately
    // still HERE, before any gate can halt the land: plan 2458 briefly moved it to the at-head
    // decision, which silently dropped a record for every land that seams early (REVIEW_NEEDED,
    // BUILD_FAILED, MOBILE_FAILED, …) and broke comparability with the historical sample this (core-noun-ok: names the real seam/gate outcome constants)
    // plan's own baseline was measured over. Telemetry-only — recordLandPrepOutcome never throws.
    // Skipped in DRY so test runs don't pollute the real sample.
    // plan 2473: the record now carries `landId`, so the at-head re-check can emit a SECOND,
    // FINAL record for the SAME land instead of this pre-enqueue verdict being the only one ever
    // written. That verdict is wrong for exactly the two cases that matter: a land prepped DURING
    // the wait is logged `fastPath:false` though it skipped the rebase, and one whose marker
    // LAPSED is logged `true` though it paid the full battery. KEEPING this record rather than
    // moving it (2458 tried moving it and reverted) is what preserves both the early-halt sample
    // and comparability with the historical baseline; `summarizeLandPrepMetrics` folds a landId's
    // records down to its final one, and a record with no landId — every historical line — stays
    // its own land exactly as before.
    if (!D.env.DRY) {
      D.coordMetrics.recordLandPrepOutcome(MAIN, {
        slug,
        landId: state.landId,
        fastPath: landFastPath,
        hadMarker: !!ev.marker,
        fetchedOk: ev.fetchedOk,
        speculative: ev.speculative, // plan 2463: which marker earned the fire
        hadSpecMarker: !!ev.specMarker, // …and whether one merely existed (review [1])
      });
    }
    if (landFastPath) {
      reversionMasterRef = ev.liveTip;
      console.log(
        ev.speculative
          ? `done-worktree: plan-2463 SPECULATIVE land-prep fast-path — this branch was stacked ` +
              `on the head slot's branch during the wait and its gates paid against that tree; ` +
              `origin/master is now exactly that land, so the head-time rebase + battery are ` +
              `provably redundant.`
          : `done-worktree: plan-972 land-prep fast-path — branch already rebased onto the live ` +
              `origin/master tip and its gates already re-validated against this exact tree; ` +
              `skipping the pre-enqueue preflights and the head-time rebase + gate re-runs.`,
      );
    }
  }

  // 2.5 REVIEW SEAM (pre-mutex — halting here costs nothing). The full marker (verdict + the
  // plan-2162 provenance detail) is read ONCE here: recordedVerdict feeds this seam, the
  // findings gate (2.55) AND the plan-2170 enqueue-readiness refusal (2.7); reviewMarker.detail
  // feeds the provenance log line below.
  let reviewMarker = !alreadyLanded
    ? recordedReviewMarker(MAIN, slug, wtPath, cfg.handoffLayout)
    : null;
  let recordedVerdict = reviewMarker ? reviewMarker.verdict : null;
  // plan 1528 A1: a marker stale only because a pure rebase re-sha'd the branch
  // (patch-id-identical) re-records itself mechanically; the session sees no halt (the
  // plan-1450 incident halted for this TWICE). A refusal on non-identical patch-ids is
  // the REWORK signal for the dequeue-on-rework below. plan 2170: the repin attempt is
  // hoisted OUT of the !resumedPast branch — the enqueue-readiness refusal at 2.7 fires
  // on --resume runs too, so a purely-rebased marker must self-heal on those runs as
  // well (never false-refuse a keep-hot/--prep re-sha).
  let reviewRework = false;
  // plan 3972 F3: the three seam-time repins below (2.5 / 2.67 / 2.68) share ONE lazy
  // origin/master fetch — the plan-3447 one-fetch-then-`--no-fetch` shape repinShaPinnedMarkers
  // already uses — instead of each child fetching the same ref on the preflight path.
  const seamTimeRepin = makeSeamTimeMarkerRepin(wtPath);
  if (
    !alreadyLanded &&
    landSeamCheck(landRegistry, 'review-marker', { changed, recordedVerdict })
  ) {
    const rp = seamTimeRepin('record-review.mjs');
    if (rp.repinned) {
      reviewMarker = recordedReviewMarker(MAIN, slug, wtPath, cfg.handoffLayout);
      recordedVerdict = reviewMarker ? reviewMarker.verdict : null;
      if (!landSeamCheck(landRegistry, 'review-marker', { changed, recordedVerdict }))
        console.log(
          'done-worktree: stale review marker auto re-pinned to HEAD (patch-id-identical rebase, plan 1528) — review seam cleared.',
        );
    }
    reviewRework = rp.rework === true;
  }
  // plan 3972 (round 2): THE tip preflight validates — captured unconditionally, right after the
  // hoisted repin (which is the last thing above that can move a marker, never HEAD). Every
  // spine-owned re-sha below advances it only through repinAndReprove; the merge site refuses
  // any other HEAD (REVIEW_NEEDED), so a commit made after this point can never pin itself.
  state.preflightTip = worktreeHeadSha(wtPath) || null;
  // plan 2170 Ship 2 (supersedes plan 1528's requeue-to-tail for the REWORK arm): a
  // proven-rework halt (re-pin refused on non-identical patch-ids) releases the queue slot
  // entirely and reworks OUT of the lane (the plan-1219/2150 head-hold pattern); the
  // post-rework re-invoke re-enters at the ORIGINAL position (the preserved-iso ticket
  // dequeueForRework stamps). Deliberately OUTSIDE the resumedPast guard (review 2170 [3]):
  // a queued, reworked land re-invoking with `--resume REVIEW_NEEDED` would otherwise skip
  // this release and fall through to the enqueue refusal's plain dequeue — losing exactly
  // the position Ship 2 preserves. emitReworkHaltWithRelease always emits (and exits).
  if (!alreadyLanded && reviewRework) {
    const rs = landSeamCheck(landRegistry, 'review-marker', { changed, recordedVerdict });
    if (rs) {
      emitReworkHaltWithRelease(
        state,
        D.L.MARKER_FAMILIES.review.label,
        rs,
        MAIN,
        slug,
        wtPath,
        cfg.handoffLayout,
      );
    }
  }
  if (!alreadyLanded && !resumedPast(D.L.SEAM.REVIEW_NEEDED)) {
    D.spine.stepLog(state, 'review seam: checking the recorded review verdict');
    const rs = landSeamCheck(landRegistry, 'review-marker', { changed, recordedVerdict });
    if (rs) {
      // plan 2086: a repin was attempted (above) and still didn't clear the seam — name every
      // marker's own state, not just this family's, so a session sees the whole picture at once.
      emitSeamWithMarkerTable(rs.code, rs.reason, MAIN, slug, wtPath, cfg.handoffLayout, state);
    }
    // plan 2162: seam CLEARED with a recorded verdict — surface HOW the review ran so a
    // substitute pass (or an undeclared-provenance record) is visible in the land log, not
    // silently accepted as if it were a full /sonnet-review fan-out. Never gates — visibility
    // only. console.log (like the re-pin notice above), NOT stepLog, so it lands on the durable
    // land output and shows in --dry-run (stepLog is stderr + dry-noop).
    if (!rs && recordedVerdict) {
      const prov = reviewMarker && reviewMarker.detail;
      console.log(
        `done-worktree: review seam cleared — verdict ${recordedVerdict}, ${prov ? `provenance ${prov}` : D.L.REVIEW_PROVENANCE_UNDECLARED}`,
      );
    }
  }

  // 2.55 FINDINGS GATE (plan 1205) — pre-merge, pre-mutex. A review recorded as NITS/BUGS-FOUND
  // for HEAD must carry an attached findings record with EVERY finding dispositioned — filed as
  // a plan (machine-verified against a fresh origin/master), fixed in-diff, or consciously waved
  // (--wontfix, reason required). Closes the "pre-existing, I'll skip it" escape (operator
  // directive 2026-06-30): a known bug CAN land, but only once a plan is filed for it. There is
  // NO --resume skip — the way through is to disposition each finding (record-review disposition
  // …) then re-invoke (bare); the gate re-reads the sidecar. The per-finding --wontfix is the
  // conscious, reason-stamped override valve. Only fires when a verdict is recorded for THIS sha,
  // so an in-flight session is not retroactively broken until it next records a non-PASS verdict.
  // No handoffLayout guard: in a single-file-layout repo recordedReviewMarker is null (the
  // marker convention is sessions-only), so recordedVerdict is null and findingsGate no-ops —
  // the layout filter is already implicit. DRY uses a fixed pseudo-sha; a DW_FAKE_FINDINGS
  // fixture sets its record `sha` to match so the sha-pin treats it as current.
  if (!alreadyLanded) {
    D.spine.stepLog(state, 'findings gate: checking findings dispositions');
    const headSha = D.env.DRY
      ? 'dryhead'
      : D.spawn.run('git', ['-C', wtPath, 'rev-parse', 'HEAD']).trim();
    const fr = recordedFindings(MAIN, slug, wtPath, cfg.handoffLayout);
    // plan 2743: the sidecar gets the same rebase-stable second chance as the review marker —
    // otherwise a NITS/BUGS-FOUND branch whose marker survived a pure rebase still halts here.
    // Lazy: only consulted if the sidecar's sha does not already pin HEAD. DRY's pseudo-sha has
    // no real tip to diff, so no thunk is passed there (the fixture pins `sha` directly).
    const fg = landSeamCheck(landRegistry, 'findings-open', {
      recordedVerdict,
      record: fr,
      headSha,
      planExists: (id) => planExistsAtLand(wtPath, id),
      headPatchId: D.env.DRY ? null : D.landLib.rangePatchIdOnce(wtPath, headSha),
      // plan 3295: the findings sidecar gets the SAME seed-only carry as the review marker (core-noun-ok: names the real function this carries feed)
      // ("dispositions ride along, no re-disposition") — a fresh IO shell here (rather than
      // reaching for the review call site's instance, which isn't in scope at this line) since
      // makeSeedOnlyDelta is cheap to construct and lazy/memoized internally; it spawns no git (core-noun-ok: names the real function being described)
      // at all unless this gate actually needs the seed-only fallback. (core-noun-ok: names the real function being described)
      seedOnlyDelta: D.env.DRY ? null : makeSeedOnlyDelta(wtPath),
    });
    if (fg) D.spine.emitSeam(fg.code, fg.reason, state);
  }

  // plan 3295 E5: resolve the per-plan `landGate:` tier ONCE, here, where both heavy-suite steps
  // below can read it off `state`. Lazy for planPriorityFor's reason (a git ls-files + a plan-body
  // read is not free) but eager enough that the first gate that needs it already has it. DRY hook:
  // DW_FAKE_LAND_GATE mirrors DW_FAKE_PRIORITY — honoured only under --dry-run.
  state.landGate = D.env.DRY
    ? process.env.DW_FAKE_LAND_GATE === 'selective'
      ? 'selective'
      : null
    : planLandGateFor(MAIN, slug, state.batch?.manifest ?? null);

  // ── SEED GATE VIEWS (contextExtras registry entry, plan 4042 T1 tail) ───────────────────── (core-noun-ok: is the real contextExtras entry name this describes)
  // These three reads — the seed-gate surface detector, the merge-base resolve, and the two (core-noun-ok: names the real reads this entry hoists)
  // shard views — used to sit down at 2.67, immediately above the gates that consume them
  // (STATUS_FLIP, CONCLUSION_REVIEW, PRICE_GATE_FAILED, and the chains[]/paged-record signals
  // 2.68 needs). Plan 3295 (E1) hoisted them here, ahead of the PRICE TRUST GATE it moved ahead (core-noun-ok: names the real registered gate this precedes)
  // of build/pytest/battery (cheap-fails-first, R3). Plan 4042 moves the block's BODY out whole — (core-noun-ok: names the real registered gate this precedes)
  // the FIRST production `contextExtras` entry (scripts/coord/land/registry.mjs's fifth extension
  // point, built and tested at plan 3961 T1, never adopted until now) — to
  // land-gate-seed.mjs's `runSeedGateViewsContextExtra`; this call site is left with the merge (core-noun-ok: names the real sibling function this call reaches)
  // into ctx. Same order, same conditions, same seam codes/message text, same --resume
  // vocabulary, still ONE readShardGateViews call, not two. Registered at `order: 2.58` — before
  // every consumer (price-trust 2.59, status-flip 2.67, conclusion-review 2.672, (core-noun-ok: names the real registered gate/seam order)
  // wiki-checkpoint 2.68) — but nothing dispatches off that order today (registry.mjs's own (core-noun-ok: names the real registered seam code)
  // header); this call site is what actually places the entry here, in the exact spot the moved
  // block used to occupy.
  const { shardsInDiff, seedGateBase, seedGateHead, seedGateBaseRef } = runContextExtras(
    landRegistry.contextExtras,
    {
      DRY: D.env.DRY,
      changed,
      seedShardDir,
      seedLaneFile,
      alreadyLanded,
      resumedPast,
      state,
      wtPath,
      shardIdPattern: cfg.shardIdPattern,
    },
    changed,
  );

  // NOTE (plan 3499 D0): these seam NUMBERS (2.67 / 2.672 / 2.68) are NAMES, not an execution
  // order — they are the --resume <CODE> vocabulary and appear in the runbooks. They deliberately
  // run HERE, before the minute-scale gates 2.59-2.662, because they are sub-second read-only
  // checks: a land that is going to halt on paperwork must halt in seconds, not after a 12-50
  // minute pytest run (the plan-3476 shape). (core-noun-ok: names the real gate this seam runs ahead of)
  // plan 4056's SEAM FOLD. The three paperwork seams below used to be run by hand-written
  // orchestration (land-gate-seed.mjs's `runStatusFlipAndConclusionReviewGates` and (core-noun-ok: names the real (now-deleted) functions this replaced)
  // `runWikiGrowthCheckpointGate`, both now deleted) that re-spelled the same seven-step shape (core-noun-ok: names the real (now-deleted) functions this replaced)
  // around a registered seam's one-line `check`. That shape is `runLandSeamStep`, and each seam
  // declares what it used to have spelled for it: its guard (`applies`), its `--resume` code
  // (`seamCode`) and, where a recorded marker can satisfy it, its `markerFamily`. Same order, same
  // conditions, same seam codes/message text, same --resume vocabulary.
  //
  // ONE ctx, built once and shared by all three, so no seam can be handed a narrower view of the
  // land than its siblings; each entry's own `check` projects what it needs out of it, and the
  // driver publishes the marker it found on `ctx.seamMarker` for that check to read.
  // `seamTimeRepin` is the SAME plan-3972-F3 shared-fetch instance built above, threaded through
  // rather than reconstructed (a fresh instance per seam would double the origin/master fetch on
  // a land where more than one marker needs repinning).
  //
  // plan 4066 task 3 (finding `92nebq`): the THREE calls below into `runLandSeamStep`, one per
  // seam, are now ONE call into `runLandSeamPhase`, which iterates the registry instead of naming
  // each seam here — done-worktree.test.mjs's cross-point execution-order pin now reads that one
  // call site instead of three (see its own header for the migration).
  const seamStepCtx = {
    DRY: D.env.DRY,
    alreadyLanded,
    shardsInDiff,
    resumedPast,
    state,
    wtPath,
    MAIN,
    slug,
    changed,
    seedGateBase,
    seedGateHead,
    shardIdPattern: cfg.shardIdPattern,
    seedLaneFile,
    handoffLayout: cfg.handoffLayout,
    worldClaimFields: cfg.land.worldClaimFields,
    seamTimeRepin,
  };

  // plan 4066 task 3 (finding `92nebq`): the SEAM FOLD, one extension point further than plan
  // 4056's gate fold below it — the three paperwork seams below used to be three near-identical
  // NAMED calls here, exactly the duplication `runPreflightGates` already removed for prepGates.
  // `runLandSeamPhase` drives every registered seam that declares a `seamCode` (see its own header
  // for that predicate and for why `review-marker`/`findings-open` above are NOT admitted here),
  // in the registry's own order:
  //
  // 2.67 STATUS-FLIP CONSISTENCY GATE (plan 1074) — a seed diff that flips a record across the (core-noun-ok: is the real registered seam name and step number)
  //   active/closed line must carry the rationale the provenance rule demands. The degenerate
  //   member of the fold: no marker satisfies it, so it halts bare.
  // 2.672 CONCLUSION-REVIEW GATE (plan 2033) — a seed diff that OVERWRITES an established (core-noun-ok: is the real registered seam name and step number)
  //   world-claim field must carry a fresh `Conclusion: UPHELD @ <sha>` adversarial-review verdict.
  // 2.68 WIKI GROWTH CHECKPOINT (plan 1074) — a diff touching a subject the wiki owns must carry a (core-noun-ok: is the real registered seam name and step number)
  //   recorded `Wiki: WROTE|SKIP @ <sha>` decision. (core-noun-ok: names the real marker value this seam records)
  //
  // Same order, same conditions, same seam codes/message text, same --resume vocabulary as the
  // three hand-written calls this replaces — every seam's own `applies`/`check` is unchanged, only
  // the call is now generic.
  const { markers: seamMarkers } = runLandSeamPhase(landRegistry, seamStepCtx);

  // plan 3972: every marker LOOKUP preflight makes has run for the tip captured at 2.5 — record
  // which families were FOUND (the review verdict as recorded, the conclusion verdict and wiki (core-noun-ok: names the real marker families this records)
  // decision as booleans; each lookup hoisted out of its seam's `--resume` guard above), so a
  // later spine-owned re-sha (freshen, pre-convergence, at-head rebase, fast-path prep, un-stack)
  // asks exactly those families to re-pin before the tip may follow it (repinAndReprove). A
  // family with no marker has nothing to prove with, and is never asked. Read off `seamMarkers` —
  // the name-keyed map `runLandSeamPhase` returns — rather than off three separately-named locals
  // (D-4066-7: the route out was already open; this fold just uses it).
  recordPreflightMarkers({
    handoffLayout: cfg.handoffLayout,
    review: recordedVerdict || null,
    conclusion: Boolean(seamMarkers['conclusion-review']),
    wiki: Boolean(seamMarkers['wiki-checkpoint']),
  });

  // plan 4056's GATE FOLD. The five preflight gates below used to be five calls here, each
  // NAMING a project step function (`runPriceTrustGateStep`, `runBuildGateStep`, (core-noun-ok: names the real (now-inlined) step functions)
  // `runMobileGateStep`, `runPytestGateStep`, `runBatteryGateStep`) plus a sixth for the (core-noun-ok: names the real (now-inlined) step functions)
  // cloud-only pre-build prune. That is what stopped this phase moving under scripts/coord/
  // however generic the rest of it reads (Rule 3, docs/coord/scripts-layout.md). Each
  // step is now declared BY ITS OWN ENTRY (`step`, alongside `lifecycle`), and the core's
  // `runPreflightGates` executes whatever is registered, in `order`:
  //
  //   2.59  price-trust            (custom  — its own once-per-land proof/remainder protocol) (core-noun-ok: is the real registered gate name and step number)
  //   ——    the pre-build prune    (the interlude; see below)
  //   2.6   build                  (generic — the shared ten-step lifecycle)
  //   2.66  mobile                 (generic) (core-noun-ok: is the real registered gate name and step number)
  //   2.661 pytest-backend-scripts (custom  — a fixed four-way outcome precedence) (core-noun-ok: is the real registered gate name and step number)
  //   2.662 scripts-battery        (custom  — likewise)
  //
  // Same order, same conditions, same seam codes/message text, same exit codes, same step-log
  // lines, same proof recording: every one of those lives inside the step that already owned it,
  // and the fold moved the CALL, not the body.
  //
  // (2.65 GENERATED-ARTIFACT FRESHNESS PREFLIGHT (plan 556) was RETIRED by plan 1024: the
  //  generated record-index artifact it checked is now build-generated + gitignored, so there is
  //  no committed artifact that could be stale vs its seed at land time. The non-vet leak (core-noun-ok: names the real seed-lane concept this note explains)
  //  guard that shared its trigger still runs at the worktree-branch push, where the
  //  scripts/hooks/pre-push.sh regenerates the index off the current seed and checks it.) (core-noun-ok: names the real script this note explains)
  //
  // ONE ctx, built once and shared by every step — the same shape, and the same reason, as the
  // seam fold's `seamStepCtx` right above: no step may be handed a narrower view of the land than
  // its siblings, and each projects what it needs out of it. `landRegistry` rides it for the
  // three `custom` steps, which address their own gate through `prepGateApplies`/`prepGateRun`; a
  // `generic` step needs neither, because the driver hands it a lifecycle runner already bound to
  // both. The cloud-only pre-build prune is the registered INTERLUDE (`preflightInterlude` on the
  // spine deps group, ordered 2.595) rather than a call here — it is not a gate, proves nothing,
  // and banks nothing, so joining `prepGates` would put a name that proves nothing into the
  // once-per-land proof roster.
  await runPreflightGates(landRegistry, {
    state,
    wtPath,
    MAIN,
    landRegistry,
    changed,
    alreadyLanded,
    landFastPath,
    shardsInDiff,
    resumedPast,
    seedGateBase,
    seedGateHead,
    seedGateBaseRef,
    seedShardDir,
    branch,
    shardIdPattern: cfg.shardIdPattern,
  });

  // plan 2473: the pre-enqueue preflights are done — hand the worktree back BEFORE the queue wait,
  // which is precisely the window the prep is supposed to use. Re-acquired at head by
  // acquireWorktreeLockAtHead. (Held past a seam? The exit hook drops it — see heldWorktreeLocks.)
  dropWorktreeLock(state.worktreeLock?.path, state.worktreeLock?.token);
  state.worktreeLock = null;

  // plan 3961 T1d: `landRegistry` joins the ctx here because the later phases address their gates
  // by name too — prettier-drift at 3b.5 in phaseLaneMerge, market-copy at the --deploy wall in (core-noun-ok: names the real sibling phase/gate this ctx feeds)
  // phaseDeployCheck. (Keep this note OUTSIDE the literal: plan 3598's guard parses the returned
  // object line-by-line and understands plain shorthand keys only.)
  return {
    a,
    MAIN,
    wtPath,
    branch,
    slug,
    state,
    finishTeardown,
    changed,
    cfg,
    resumedPast,
    alreadyLanded,
    landFastPath,
    reversionMasterRef,
    recordedVerdict,
    landRegistry,
  };
}
