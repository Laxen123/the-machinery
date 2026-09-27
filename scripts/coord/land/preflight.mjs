// scripts/coord/land/preflight.mjs — plan 4042: the land spine's keep-hot `--prep` orchestration
// cluster, moved out of scripts/done-worktree.mjs behaviour-identical (parity proven by this
// migration's parity-test suite against committed goldens, plus the full legacy test suite,
// both unchanged by this move).
//
// WHAT THIS MODULE OWNS. The whole `--prep` entrypoint main() calls (runLandPrep), its two
// sub-modes (runLandPrepNoRebase for the review-time no-rebase proof, runLandPrepLocked for the
// rebasing keep-hot pass), the exit-time attachment-heal invariant (restorePrepAttachment, plan
// 2654), and the speculative-stacking pair the rebasing pass runs after its own plain prep
// (clearSpeculativeStackForPrep's undo-before-re-prep, attemptSpeculativeStack's opportunistic
// stack-onto-the-head-slot pass). Only `runLandPrep` is exported — main()'s `--prep` branch is its
// one outside caller; every other name here is called only from within this same cluster.
//
// WHAT STAYS BEHIND, ON PURPOSE, AND WHY. This move's boundary is exactly `runLandPrep` through the
// end of `runLandPrepLocked` — nothing declared earlier in done-worktree.mjs moves with it, the
// same rule every other scripts/coord/land/*.mjs carve follows. A handful of names this cluster
// calls are declared there, before this cluster's old location, and stay for real reasons:
//   - `worktreeHeadRef`, `fakeHeadRef`, and `assertStampAttachment` are the exact cluster
//     rebase-sync.mjs's own header already names as blocked from moving (T3.6): all three read or
//     write the module-private `let lastHeadRefError`, and an ES module private binding has no
//     cross-module reach other than an exported accessor — none of the three can move without the
//     others, and none of the others is this move's to take. This cluster only ever READS the
//     diagnostic text `lastHeadRefError` carries (never writes it), so it reaches that text through
//     a new one-line accessor, `lastHeadRefErrorText` (added beside the `let` itself in
//     done-worktree.mjs, and to the `spine` deps-container group) — the same pattern
//     `stepLog`/`readResultSidecar` already use for a private-state read from outside the module.
//   - `gitDeltaFiles` has a call site outside this cluster too (the preflight remainder-envelope
//     computation), so it cannot move with it regardless of where its declaration sits.
//   - `remoteTrackingTip`, `repinShaPinnedMarkers`, and `restorePrepBranchTip` happen to have NO
//     caller left outside this cluster after the move — but their declarations sit before
//     `runLandPrep`, so the "nothing before runLandPrep moves" boundary keeps them in
//     done-worktree.mjs regardless; they are simply reachable only through the container now.
//   - `WORKTREE_HEAD_UNREADABLE` is the sentinel `worktreeHeadRef`/`fakeHeadRef` return on an
//     unreadable HEAD — it needs referential (`===`) identity with what those STAYS functions
//     return, so it travels through the container as a plain value, not a re-declared symbol.
// All nine (`worktreeHeadRef`, `fakeHeadRef`, `assertStampAttachment`, `lastHeadRefErrorText`,
// `gitDeltaFiles`, `remoteTrackingTip`, `repinShaPinnedMarkers`, `restorePrepBranchTip`,
// `WORKTREE_HEAD_UNREADABLE`) are NEW additions to the already-bound `spine` deps-container group
// (done-worktree.mjs's own `bindLandDeps({ spine: {...} })` call) — no new GROUP, since deps.mjs
// checks group presence only, never membership (see that file's own header).
//
// Everything else this cluster calls was ALREADY reachable from a sibling scripts/coord/land/*.mjs
// module before this move — imported directly below, a sibling-core-module reach that needs no
// container: head-lock.mjs's `renewOrAbort`/`WorktreeLockLost`; queue-probe.mjs's
// `speculationQueueView`/`foreignStackedBranch`; gates-runner.mjs's
// `gateEnvUncacheableFiles`/`shortEnvHash`/`prepGateEnvDrift`/`flushLandGateProofBuffer`/
// `runPrepGates`; rebase-sync.mjs's `tryRebase`/`landPrepMarker`/`landSpecMarker`/`isAncestor`/
// `originMasterTip`/`worktreeHeadSha`/`prepMarkerStampSha`. `nowIso`, `restoreOffSpeculativeBase`,
// `worktreeMutationInProgress`, `attachmentRefusal`, `landRegistries`, and `tallyLockRetry` were
// ALREADY `spine` members before this move (added by earlier carves for their own other call
// sites); this move adds no new reasoning for them, just a new reader.
//
// HOW THIS MODULE REACHES THE REST OF THE WORLD. A non-test module under scripts/coord/ may
// import only scripts/coord/** and node: builtins (Rule 3, docs/coord/scripts-layout.md)
// — so every plain scripts/*.mjs module this code used to reach directly (battery-ledger.mjs's
// `NON_CONVERGENT_ROUNDS`, done-worktree-lib.mjs's `L`, and the argv-derived `DRY`/`PREP_NO_REBASE`
// boot flags) is instead read off the bound dependency container, `landDeps()`
// (scripts/coord/land/deps.mjs), AT CALL TIME, inside each function — never at module top level.
// `D` (this module's convention: `const D = landDeps();` as the first line of every function that
// needs the container) is the same one-letter binding every other scripts/coord/land/*.mjs core
// module uses for the same reason.
//
// A PURE MOVE. Every moved function is byte-identical to its done-worktree.mjs original apart from
// the mechanical container-access rewrites (`DRY` → `D.env.DRY`, `PREP_NO_REBASE` →
// `D.env.PREP_NO_REBASE`, `PREP_EXIT` → `D.L.PREP_EXIT`, `L.foo(` → `D.L.foo(`, `run(` →
// `D.spawn.run(`, `NON_CONVERGENT_ROUNDS` → `D.batteryLedger.NON_CONVERGENT_ROUNDS`, and each of the
// nine names above gaining a `D.spine.` prefix, `lastHeadRefError` becoming
// `D.spine.lastHeadRefErrorText()`), the `export` keyword added to `runLandPrep` (the one name a
// caller outside this module needs), and the `const D = landDeps();` first line every function that
// needs the container gained — no renames, no reordering, no incidental fixes. Every comment moved
// with its function; they carry the plan history that explains the code.

import { readFileSync, lstatSync, existsSync } from 'node:fs';
import { basename as basenamePath, join as joinPath } from 'node:path';
import { landDeps } from './deps.mjs';
import { renewOrAbort, WorktreeLockLost } from './head-lock.mjs';
import { speculationQueueView, foreignStackedBranch } from './queue-probe.mjs';
// plan 4042 T2 (the preflight-markers/state-machine carve): heartbeatDiscoveredQueueSlot is
// armRetainedEntryHeartbeat's default heartbeat collaborator — a sibling core-module reach, same
// pattern as the queue-probe.mjs / gates-runner.mjs / rebase-sync.mjs imports around it.
import { heartbeatDiscoveredQueueSlot, dequeueForRework } from './queue.mjs';
import {
  gateEnvUncacheableFiles,
  shortEnvHash,
  prepGateEnvDrift,
  flushLandGateProofBuffer,
  runPrepGates,
} from './gates-runner.mjs';
import {
  tryRebase,
  landPrepMarker,
  landSpecMarker,
  isAncestor,
  originMasterTip,
  worktreeHeadSha,
  prepMarkerStampSha,
  // plan 4042 T2: worktreeMutationKind (preflight()'s orphan-mutation probe) and changedFiles
  // (repinAndReprove's re-read of the branch's own file list) join this same sibling import.
  worktreeMutationKind,
  changedFiles,
} from './rebase-sync.mjs';
// plan 4042 T2: markerSourceEntry's pure selection and sessionDocCandidates' origin-first read
// reach scripts/coord/review-markers.mjs directly — a coord/** sibling one level up, same rule
// (Rule 3) as every other direct import in this file.
import { pickMarkerSourceEntry, originFirstCandidates } from '../review-markers.mjs';
import { selectPrepGates, prepGateStage, prepGateRunsInPrepPass } from './registry.mjs';

// plan 4066 task 0: the member-level container-read manifest for this module — every
// `D.<group>.<member>` / `landDeps().<group>.<member>` read this file makes, grouped and sorted.
// Nothing in this file asserts it: container-manifest.mjs imports it alongside its eight siblings
// and asserts all nine, ONCE, from done-worktree.mjs right after bindLandDeps() binds the real
// container — see that aggregator's own header for why the assertion lives there instead of here
// (an entry-point assertion in each module would import deps.mjs's own landDeps()/requireDeps()
// back into a module deps.mjs itself has no knowledge of needing, which is fine, but gains nothing
// nine separate call sites don't already get from one). container-manifest.test.mjs's parity test
// keeps this manifest honest against the source below — a manifest can neither lag a new read nor
// carry a stale one. Generated, not hand-typed (a hand copy drifts silently): regenerate with the
// same scanner on a real change to this file's container reads.
export const CONTAINER_READS = Object.freeze({
  L: Object.freeze([
    'EXIT',
    'MARKER_FAMILIES',
    'PREP_EXIT',
    'PREP_GATE_TO_LAND_GATE',
    'SEAM',
    'enqueueReadinessRefusal',
    'filterPreflightDirty',
    'findingsGate',
    'findingsSidecarPath',
    'isSeedOnlyDelta',
    'landPrepValid',
    'parseConclusionMarker',
    'parseFindingsRecord',
    'parseMarkerAny',
    'parseMarkerCurrent',
    'parseReviewMarkerFull',
    'parseWikiMarker',
    'planIdInTree',
    'rebaseSeam',
    'reworkDequeuedNote',
    'shouldSpeculate',
    'sidecarOwnedBy',
    'speculativeRollbackAllowed',
  ]),
  coordGit: Object.freeze(['healOwnWorktreeIndexLock', 'sleepSync']),
  env: Object.freeze(['DRY', 'PREP_NO_REBASE']),
  landLib: Object.freeze([
    'assertLandable',
    'clearSpineRebaseMarker',
    'inspectRebasedUnpushed',
    'rangePatchIdOnce',
    'readSpineRebaseMarker',
    'rebaseStateDir',
    'rebaseStateKnownAbsent',
    'recoverRebasedUnpushed',
  ]),
  landingLock: Object.freeze(['ageMinutes']),
  landingQueueLib: Object.freeze(['DEFAULT_DEMOTE_STALE_MIN']),
  spawn: Object.freeze(['node', 'run']),
  spine: Object.freeze([
    'LEDGER_FILES_ON_WORKTREE_BRANCH',
    'WIKI_DIFF_RETRY_EXHAUSTED',
    'WORKTREE_HEAD_UNREADABLE',
    'assertStampAttachment',
    'attachmentRefusal',
    'emitSeam',
    'fakeHeadRef',
    'findSessionFile',
    'gitDeltaFiles',
    'landRegistries',
    'nowIso',
    'remoteTrackingTip',
    'resolveSeedShardDirAtMergeBase',
    'resolveSessionEntryChain',
    'restoreOffSpeculativeBase',
    'restorePrepBranchTip',
    'stepLog',
    'sweepCheckpointOnWorktreeBranch',
    'tallyLockRetry',
    'wikiDiffOnWorktreeBranch',
    'worktreeHeadRef',
  ]),
});

/**
 * plan 4096 T1/S9: the carry-forward cap's gate roster, DERIVED from the land registry — the one
 * builder of the `predicates` table `L.landPrepGatesToRun` / `L.gateInputsTouched` /
 * `L.landPrepValid` / `L.landSpecPrepValid` take (see gateInputsTouched's own header in
 * done-worktree-lib.mjs). Membership is exactly the gates the `--prep` pre-pass runs: registered
 * prepGates of stage 'preflight' that do not decline the pre-pass — the same two filters
 * `runPrepGates` applies through `selectPrepGates`, so the cap and the pass cannot disagree on
 * which gates exist. Each predicate IS that entry's own `applies` (through selectPrepGates's
 * thenable-refusing reader), so a gate's trigger surface is declared once, on its entry.
 *
 * Keyed by the compact prep vocabulary (PREP_GATE_TO_LAND_GATE's left column), because that is
 * what the marker's `gateResults` and the cap's result are keyed by. A pre-pass gate with no prep
 * key is REFUSED, the same refusal runPrepGates' own roster makes: it would be dropped by the cap
 * and by parseLandGatesProven alike, a gate that runs and proves nothing.
 *
 * With no project layer loaded the table is empty (the core registers no preflight-stage gate),
 * and an empty table is an honest answer there: no gate can be required of a marker.
 */
export function prepGatePredicates(registries) {
  const D = landDeps();
  const prepKeyByLandGate = Object.fromEntries(
    Object.entries(D.L.PREP_GATE_TO_LAND_GATE).map(([prep, land]) => [land, prep]),
  );
  const predicates = {};
  for (const gate of registries.prepGates) {
    if (prepGateStage(gate) !== 'preflight' || !prepGateRunsInPrepPass(gate)) continue;
    const key = prepKeyByLandGate[gate.name];
    if (!key) {
      throw new Error(
        `done-worktree: prepGates entry "${gate.name}" (${gate.where}) runs in the --prep pre-pass ` +
          `but has no PREP_GATE_TO_LAND_GATE key, so the carry-forward cap could not name it — ` +
          `give it one, or set prepPass: false on the entry (plan 4096 S9).`,
      );
    }
    predicates[key] = (files) =>
      selectPrepGates([gate], files || [], {}, { stage: 'preflight', prepPassOnly: true })
        .length === 1;
  }
  return Object.freeze(predicates);
}

// plan 2992: how often the pre-queue gate phase's heartbeat tick fires. Cheap by design
// (a flagless `heartbeat <slug>` has been a git-ref stamp — no coord lock, no commit —
// since plan 2603), so a 5-min cadence during a ~20-min gate run is safe under parallel-
// session load.
export const PREFLIGHT_HEARTBEAT_TICK_MS = 5 * 60 * 1000;

// plan 4057 defect 5: how many FURTHER `landing-queue.mjs status` attempts the arm-time query
// gets, one per tick, before the heartbeat gives up and disarms itself. This is a RETRY POLICY,
// stated deliberately rather than inherited: previously a single throw returned a permanent
// no-op, so one transient status failure disabled the retained-slot heartbeat for the rest of
// the land and the slot could then go stale and be demoted or taken mid-land.
//
// THREE, and the two review rounds that argued this out are worth recording because they pull in
// opposite directions. r1 (f4e0da) objected that three retries at the 5-min tick spend exactly 15
// minutes — DEFAULT_DEMOTE_STALE_MIN — so a give-up WARNING at the end arrives no earlier than the
// demotion it describes. Dropping to two then drew r2 (a76002): a query that fails at arm time and
// at 5 and 10 minutes but recovers at 11 now finds the tick already disarmed, so the slot is never
// refreshed again even though the land is healthy and still running.
//
// Three is the right side of that trade, and r3 re-raised r1's objection (4ccd7c / 2a3685 /
// 3a0a60 / fd8df8: the third retry lands at ~15 min and can lose a race to the demoter), so the
// reasoning is recorded here rather than re-litigated a fourth time.
//
// The race those findings describe is real but is not a REGRESSION, because both branches of it
// end identically. If the status query never recovers before the threshold, the slot is
// demotable whether or not a retry was still pending — retrying later cannot cause the demotion,
// it can only fail to prevent it. So a retry that might not win the race is strictly weakly
// better than no retry at all, while giving up EARLIER (the r2 shape) removes the only chance of
// recovery in minutes 10–15 and guarantees the outcome. The thing being protected is the
// HEARTBEAT; the warning is only a diagnostic explaining why beating stopped, so "the warning
// cannot pre-announce the demotion" is a cost worth paying for one more chance to avoid it.
//
// What WOULD dominate both: a denser retry cadence (retry the unconfirmed query every minute or
// two rather than on the 5-minute beat tick), which is bounded, expires strictly inside the
// window, AND gets more attempts. That needs the unconfirmed phase to own a second interval, is
// outside this plan's five defects, and is filed as a debt line rather than done here.
export const RETAINED_HEARTBEAT_QUERY_RETRIES = 3;

// plan 2992: arm a periodic heartbeat tick for the WHOLE pre-queue gate phase (every heavy,
// potentially slow gate this checkout's coord.config.json registers) when this
// invocation RETAINS an existing landing-queue entry (a requeue/resume re-invocation).
//
// Why this is needed: during the pre-queue gate phase state.queued is still FALSE —
// queueEnqueueAndGate (which flips it true) runs strictly AFTER this phase — so a
// RETAINED entry from a prior invocation is a slot this session did not itself create
// THIS run. Exactly the same shape heartbeatDiscoveredQueueSlot (~:972) exists for: we
// heartbeat it through queueHeartbeat's own arg-building via a SHALLOW CLONE with
// `queued:true`, never by flipping the real state.queued — that flag doubles as
// crash-path dequeue OWNERSHIP (dequeueQueueIfHeld, main()'s unconditional catch-block
// release), and mutating it from mere discovery would make an unrelated later throw in
// THIS process dequeue a slot a prep child (or a genuinely foreign invocation) is still
// legitimately using. See the ~:966 comment — same contract, reused here rather than
// re-derived.
//
// One query decides everything: `landing-queue.mjs status <slug> --json` returns THIS
// slug's own {position, heartbeatIso, ...} — position 0 means no entry (nothing to arm),
// position >= 1 means retained (arm + heartbeat immediately + tick). We only ever query
// and heartbeat OUR OWN state.slug, never a foreign slug — there is no "someone else's
// entry" case here at all.
//
// Coverage limitation (honest, not fixed here — out of scope per plan 2992): a gate that
// runs via runViaTestQueue (spawnWithTreeKill + await
// waitForExit) is genuinely async, so a setInterval fires DURING it. A gate that runs via
// blocking execFileSync with a 600s ceiling instead leaves the interval
// unable to fire INSIDE it — only BETWEEN gates. Worst case, a single blocking
// gate leaves the entry's heartbeat as old as its own ceiling (~10 min), still under the
// 15-min DEFAULT_DEMOTE_STALE_MIN. Restructuring those gates to be interruptible is out
// of scope for this plan.
//
// The options arg mirrors makeQueueHeartbeatStamper's injection style (defaults are the
// real I/O; a test overrides every field to prove the behavior without a live
// landing-queue.mjs subprocess or a real timer).
export function armRetainedEntryHeartbeat(
  state,
  {
    queryStatus = (st) =>
      JSON.parse(landDeps().spawn.node('landing-queue.mjs', 'status', st.slug, '--json')),
    heartbeat = heartbeatDiscoveredQueueSlot,
    warn = (msg) => process.stderr.write(msg + '\n'),
    nowMs = Date.now,
    tickMs = PREFLIGHT_HEARTBEAT_TICK_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {},
) {
  const D = landDeps();
  const noop = () => {};
  let st = null;
  // plan 4057 defect 5: a throw here used to `return noop`, which disabled the heartbeat for the
  // REST OF THE LAND on one transient `landing-queue.mjs status` failure — the retained slot then
  // aged past the demote threshold and could be taken while the land was still running. A failed
  // query is not evidence about whether this session holds an entry, so it is now a RETRYABLE tick
  // (see RETAINED_HEARTBEAT_QUERY_RETRIES for the bound and the rationale) rather than a terminal
  // decision. A CONCLUSIVE answer is still terminal: `!st || position < 1` means this session owns
  // no entry, and there is genuinely nothing to arm.
  let entryConfirmed = false;
  try {
    st = queryStatus(state);
    if (!st || !(st.position >= 1)) return noop; // no entry this session holds — nothing to arm
    entryConfirmed = true;
  } catch {
    st = null; // unknown, not "not retained" — the tick below re-asks
  }

  // plan 2517 (entry-time twin of the exit-side warning at ~:2586-2606): this run is
  // STARTING a long pre-queue gate phase while already holding a stale-ish entry. Unlike
  // the exit copy, this plan's tick IS about to start refreshing it — so the wording says
  // that, instead of the exit copy's now-inapplicable "a flagless poll loop like this one
  // never refreshes it" sentence.
  const ageMin = st ? D.landingLock.ageMinutes(st.heartbeatIso || '', nowMs()) : null;
  if (ageMin !== null && ageMin > D.landingQueueLib.DEFAULT_DEMOTE_STALE_MIN / 2) {
    warn(
      `\n⚠ STALE HEARTBEAT (plan 2517): this run is starting its pre-queue gate phase ` +
        `holding a RETAINED landing-queue entry whose OWN heartbeat is already ~${ageMin} ` +
        `min old — over half the ${D.landingQueueLib.DEFAULT_DEMOTE_STALE_MIN}-min demote threshold. Plan ` +
        `2992's preflight heartbeat tick is now arming and will refresh it every ` +
        `${Math.round(PREFLIGHT_HEARTBEAT_TICK_MS / 60000)} min for the rest of this phase.`,
    );
  }

  const safeHeartbeat = () => {
    try {
      heartbeat(state);
    } catch {
      /* a dropped tick only risks demotion (status quo) — never fatal to the land */
    }
  };

  let disarmed = false;
  let timer = null;
  const disarm = () => {
    if (disarmed) return;
    disarmed = true;
    if (timer !== null) clearIntervalFn(timer);
  };

  // plan 4057 defect 5: when the arm-time query did NOT confirm an entry, the tick's first job is
  // to re-ask. It beats only once a query has actually confirmed this session holds a retained
  // entry — beating blind would refresh a slot we may not own, which is exactly what the
  // `position >= 1` check exists to prevent. The retry budget is bounded and, once spent, the tick
  // warns once and disarms ITSELF rather than spinning on a dead queue ref for the whole land.
  let retriesLeft = RETAINED_HEARTBEAT_QUERY_RETRIES;
  const tick = () => {
    if (!entryConfirmed) {
      let retryStatus;
      try {
        retryStatus = queryStatus(state);
      } catch {
        if (--retriesLeft <= 0) {
          warn(
            `\n⚠ RETAINED-SLOT HEARTBEAT DISABLED (plan 4057): \`landing-queue.mjs status\` for ` +
              `"${state?.slug}" failed on every one of ${RETAINED_HEARTBEAT_QUERY_RETRIES + 1} ` +
              `attempts, so this land cannot confirm it holds a retained queue entry and has ` +
              `stopped trying to refresh one. If it DOES hold a slot, that slot will now age ` +
              `normally and may be demoted after ` +
              `${D.landingQueueLib.DEFAULT_DEMOTE_STALE_MIN} min.`,
          );
          disarm();
        }
        return;
      }
      if (!retryStatus || !(retryStatus.position >= 1)) {
        disarm(); // a CONCLUSIVE "not retained" — same terminal answer as at arm time
        return;
      }
      entryConfirmed = true;
    }
    safeHeartbeat();
  };

  // One immediate beat — don't wait a full tick to refresh a possibly-stale entry. Only when the
  // entry is already confirmed; an unconfirmed one beats from the tick that confirms it.
  if (entryConfirmed) safeHeartbeat();
  timer = setIntervalFn(tick, tickMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return disarm;
}

// plan 2497: `unpushed-master` (the assertLandable reason a LIVE PEER's own unpushed commit
// trips) is a third-party, typically self-clearing condition — the plan-2353 incident cleared
// in ~6 min. Dequeuing on the very first throw pays a full FIFO-queue traversal for something
// this session neither caused nor can fix, so the health-guard below re-checks a bounded number
// of times before giving up. 7 probes x 60s (~7 min) covers that one measured clear with margin
// while staying under the plan-1528 8-min head-hold arm.
const UNPUSHED_MASTER_RETRY_PROBES = 7;
const UNPUSHED_MASTER_RETRY_INTERVAL_MS = 60_000;

// plan 2497: bounded in-place re-check for assertLandable's 'unpushed-master' reason. Returns
// `null` once the tree is landable again, or the most recent reasoned error if the window runs
// out. Standalone (sonnet-review high [3]: a named function, not ~55 lines inlined into main(),
// is independently reasoned about and keeps the retry policy in one place).
//
// Each real probe re-runs assertLandable ITSELF (sonnet-review high [1]) rather than a raw
// `origin/master..master` ahead-count: a raw count can't tell an EXEMPT ahead commit (a
// sibling's sanctioned doc/config commit, per assertLandable's own classifyAheadCommit) from a
// genuine remnant, so it could stay "uncleared" long after assertLandable itself would pass.
// Each probe is also its own try/catch (sonnet-review high [0]): an unrelated transient
// git/network hiccup during a probe must not crash the land — it only makes THIS probe
// inconclusive. Only a DIFFERENT reasoned error replaces the one eventually reported; an
// unreasoned (transient) probe failure never does, so a give-up always reports a genuine,
// well-formed assertLandable verdict, never a raw crash.
//
// DW_FAKE_UNPUSHED_MASTER_CLEAR_AT (honoured ONLY under --dry-run): the 1-based probe attempt
// at which the fake ahead-count hits zero; unset/'never' never clears.
export function unpushedMasterRetryClears(MAIN, firstErr) {
  const D = landDeps();
  let landableErr = firstErr;
  const fakeClearAt = D.env.DRY ? process.env.DW_FAKE_UNPUSHED_MASTER_CLEAR_AT : undefined;
  for (let attempt = 1; attempt <= UNPUSHED_MASTER_RETRY_PROBES && landableErr; attempt++) {
    D.coordGit.sleepSync(D.env.DRY ? 0 : UNPUSHED_MASTER_RETRY_INTERVAL_MS);
    if (D.env.DRY) {
      const cleared = fakeClearAt !== undefined && Number(fakeClearAt) === attempt;
      // DRY trace goes to STDOUT (mirrors the `run()`/DW_FAKE_REF_LOCK convention) — a
      // stderr-only (stepLog) trace is invisible to a test on a SUCCESSFUL exit, since
      // execFileSync does not capture stderr in that case.
      process.stdout.write(
        `DRY unpushed-master probe ${attempt}/${UNPUSHED_MASTER_RETRY_PROBES}: ` +
          `${cleared ? 'cleared' : 'still ahead'}\n`,
      );
      if (cleared) landableErr = null;
      continue;
    }
    try {
      D.landLib.assertLandable(MAIN);
      landableErr = null;
    } catch (e) {
      if (e && e.reason) landableErr = e; // a genuine (possibly DIFFERENT) reasoned verdict
      // else: an unreasoned/transient probe failure — inconclusive, keep the last known verdict
    }
  }
  return landableErr;
}

// ── plan 4034 T2: the PLAIN land path's post-gate ownership check ─────────────────────────────
//
// `runPrepGates` has always renewed after each gate and thrown `WorktreeLockLost` when the renewal
// refused. The plain land (`node scripts/done-worktree.mjs <slug>`) had NO equivalent: it took the
// lock once before preflight and dropped it after the battery, so a reap that happened mid-gate was
// discovered by nothing — and the gate's verdict was then recorded as a `gatesProven` entry, and
// its telemetry written, for a tree another process had already rebased under us. That proof
// authorizes a LATER step of the same land to SKIP the gate, so a stale one is not merely noise.
//
// Called immediately after each pre-enqueue heavy gate returns and BEFORE `recordLandGateProven` /
// `appendDeployGateOutcome` — placement is the whole point, not a detail. The check is OWNERSHIP
// (is our token still in the file), never liveness.
//
// It exits through QUEUE_WAIT rather than a new seam, for the reason `acquireWorktreeBeforePreflight`
// already uses it on this same path: the honest statement is "another cooperating process owns this
// tree, come back", the land has not enqueued and holds nothing it must give up, and every caller
// — the cloud drain above all — already handles QUEUE_WAIT as "not your turn yet". `keepQueue: true`
// mirrors that sibling: a re-invoked land that RETAINED a slot across a CHUNKED seam must not lose
// it for a reason that is not about its own work.
//
// `state.worktreeLock` is null whenever the lock was never resolvable (`worktreeLockFor` returned
// null) or under `--dry-run`; `renewOrAbort` returns true for both, so this degrades to exactly
// pre-4034 behaviour instead of blocking a land the interlock cannot cover.
export function assertWorktreeStillOurs(state, gateLabel) {
  const D = landDeps();
  if (renewOrAbort(state.worktreeLock, state.slug, `after the ${gateLabel} gate`)) return;
  state.queuePosition = null;
  D.spine.emitSeam(
    D.L.SEAM.QUEUE_WAIT,
    `this land's worktree lock was REAPED while the ${gateLabel} gate ran, and another process ` +
      `now owns ${state.slug}'s worktree (plan 4034 T2). Nothing about that gate's result is ` +
      `trustworthy any more — it ran against a tree that may since have been rebased — so no proof ` +
      `was recorded for it. This land has NOT merged anything; re-invoke done-worktree (bare — ` +
      `same slug) once the other process is done and the gates will re-run against the tree as it ` +
      `then stands.`,
    state,
    { keepQueue: true },
  );
}

export function worktreeMutationInProgress(wtPath) {
  const D = landDeps();
  // The DRY hook stays keyed on DW_FAKE_PRECONVERGE_BUSY ALONE (not worktreeMutationKind's wider
  // dry surface): this predicate drives the pre-convergence busy-check, whose existing tests stage
  // exactly that variable, and DW_FAKE_ORPHANED_MERGE is the preflight halt's own hook.
  if (D.env.DRY) return process.env.DW_FAKE_PRECONVERGE_BUSY === '1';
  return worktreeMutationKind(wtPath) !== null;
}

// plan 3974 T2b hardening (gpt-review f33dfb/166ca5/8302eb/fb2938/54c5e5): the preflight resume
// below must fire ONLY for a leftover rebase the land spine itself produced — never a human's
// paused `git rebase -i`, never a `git am` session, and never during an invocation that has
// promised not to mutate the worktree. Two things were empirically checked (scratch repos under
// E:\Temp, 2026-09-13) before writing this:
//
//   1. `rebase-merge/interactive` does NOT distinguish "launched with -i" from "git's own
//      merge-backend sequencer" — a bare `git rebase <sha>` (no -i, no -x — exactly land-lib.mjs's
//      `tryRun(wtPath, ['rebase', rebasedOntoSha])`) stamps that file too, on this box's git
//      2.53.0 (the merge backend has been the sole default for a plain rebase for years; the old
//      apply-backend survives only via an explicit `--apply`/`git am`). So it is USELESS as a
//      discriminator and is deliberately NOT used below — the lead did not survive verification.
//   2. `git rebase --continue` on a `rebase-apply` directory (where an interrupted `git am` — or
//      the rare explicit `--apply` rebase this codebase never issues — keeps its state) does not
//      silently do the wrong thing: git itself refuses outright ("fatal: It looks like 'git am'
//      is in progress. Cannot rebase.", exit 128). So the risk there was never data loss, only a
//      wasted subprocess call and a state re-probe that still correctly falls through to the
//      halt — but resumableSpineRebase() below skips it explicitly, in the same code path that
//      now also disambiguates it for `L.SEAM.PREFLIGHT_FAIL`'s remedy text.
//
// What DOES hold on every git version this spine runs on: land-lib.mjs's own rebase calls (a bare
// `git rebase <sha>` to start, `git rebase --continue` to resume) never queue anything but a plain
// `pick` — no `-i`, no `-x`/exec, no reword/edit/squash/fixup/drop/label/reset/merge/update-ref.
// A human's `git rebase -i` pause (edit/break/reword) or a deliberate `--exec` ALWAYS leaves at
// least one non-pick verb in the todo, either already consumed (in `done`) or still queued (in
// `git-rebase-todo`) — so scanning both for anything but `pick`/`p` is a discriminator that is
// TRUE for every state the spine can leave and FALSE for every state a human's interactive
// session can leave, verified against the exact fixtures reproduced below in the test file.
const REBASE_TODO_NON_PICK_VERB =
  /^\s*(?:e|edit|b|break|x|exec|r|reword|s|squash|f|fixup|d|drop|l|label|t|reset|m|merge|u|update-ref)\b/i;
export function rebaseMergeTodoIsPickOnly(rebaseMergeDir) {
  // An `edit`/`reword` step also writes an `amend` scratch file the moment git starts
  // processing it (verified empirically) — a cheap belt-and-braces check ahead of the todo scan.
  if (existsSync(joinPath(rebaseMergeDir, 'amend'))) return false;
  for (const f of ['done', 'git-rebase-todo']) {
    let content;
    try {
      content = readFileSync(joinPath(rebaseMergeDir, f), 'utf8');
    } catch {
      return false; // unreadable — conservative: never resume on an unknown state
    }
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (REBASE_TODO_NON_PICK_VERB.test(line)) return false;
      if (!/^(?:pick|p)\b/i.test(line)) return false; // any other/unknown verb — conservative halt
    }
  }
  return true;
}

// The ONE gate the preflight resume block below is allowed to trust. `wtPath` must have a real
// `rebase-merge` (not `rebase-apply` — see point 2 above) whose todo is provably pick-only.
// plan 3974 fix (gpt-review j0j1ng/6wn6nm): built on the SAME shared `rebaseStateDir` probe
// worktreeMutationKind uses above, rather than a second hand-rolled `rev-parse --git-path` pair —
// ONE definition of "where is the rebase state" for the whole repo. `rebaseStateDir` returns
// whichever of `rebase-merge`/`rebase-apply` exists, so its basename says which one it is: an
// interrupted `git am` (or the rare explicit `--apply` rebase this codebase never issues) keeps
// its state under `rebase-apply`, and `git rebase --continue` refuses that outright ("fatal: It
// looks like 'git am' is in progress. Cannot rebase.", exit 128, verified empirically) — never
// worth attempting.
//
// plan 3974 round 2 (gpt-review 69df5c/bb3c7a/a0f071/a400a4/9d27ba/382952/ffe707): a pick-only
// todo does NOT prove the land spine created this rebase — a human's plain `git rebase <sha>` (no
// `-i`, no `-x`) leaves the exact same shape. The actual provenance is land-lib.mjs's own marker
// (`readSpineRebaseMarker`), written right before its `git rebase <onto>` call and cleared on
// EVERY classified exit of `syncBranchOntoMaster` — only a spine process KILLED mid-rebase leaves
// both the marker AND the rebase-merge dir behind.
//
// plan 3974 round 3 (gpt-review 9e9c0e/fbf68e/c0c94a/a8b176/7489e0/c19015/c8c57e/bc9cfb): `onto`
// alone under-specifies the rebase — the marker must match the leftover's WHOLE identity: the
// destination (`rebase-merge/onto`), the pre-rebase tip (`rebase-merge/orig-head`, matched against
// the marker's `origHead`), and the branch being rebased (`rebase-merge/head-name`, matched against
// `refs/heads/<marker.branch>`). Any of the three files being unreadable is treated the same as a
// mismatch — never resume on an unknown state. The one shape that remains genuinely
// indistinguishable from here — a human aborting the killed spine rebase and then starting a NEW
// plain rebase of the SAME tip onto the SAME commit — is also semantically identical to it: same
// picks in the same order, same destination, clean tree, so `git rebase --continue` produces
// exactly what that human's own `--continue` would. Interactive verbs and conflict-stop residue
// still refuse below, belt-and-braces on top of the identity match.
export function resumableSpineRebase(wtPath) {
  const D = landDeps();
  const dir = D.landLib.rebaseStateDir(wtPath);
  if (!dir || basenamePath(dir) === 'rebase-apply') return false;
  const marker = D.landLib.readSpineRebaseMarker(wtPath);
  if (!marker) return false;
  let onto, origHead, headName;
  try {
    onto = readFileSync(joinPath(dir, 'onto'), 'utf8').trim();
    origHead = readFileSync(joinPath(dir, 'orig-head'), 'utf8').trim();
    headName = readFileSync(joinPath(dir, 'head-name'), 'utf8').trim();
  } catch {
    return false; // unreadable — conservative: never resume on an unknown state
  }
  if (!onto || onto !== marker.onto) return false;
  if (!origHead || origHead !== marker.origHead) return false;
  if (!headName || headName !== `refs/heads/${marker.branch}`) return false;
  // gpt-review dc2f34: conflict-stop residue — `stopped-sha` (the pick that halted), plus the
  // `message`/`patch` files git writes alongside it for the same stop — means a human is
  // mid-resolve regardless of what the todo scan below finds (verified empirically: none of the
  // three exists in the spine's own clean, between-picks leftover shape, only after a real
  // conflict). Refuse on any of them, belt-and-braces alongside the pick-only scan.
  for (const f of ['stopped-sha', 'message', 'patch']) {
    if (existsSync(joinPath(dir, f))) return false;
  }
  return rebaseMergeTodoIsPickOnly(dir);
}

// The sha-pinned marker set that re-pins together after ANY pure re-sha of the branch
// (plan 1528 A1; repin carries dispositions on a patch-identical re-sha, plan 1775). One
// helper shared by the keep-hot --prep path and the pre-convergence path so the set can
// never drift apart between the two rebase-during-wait sites (review 1805 [9]).
// plan 2042: ONE origin fetch here for all three families — each repin subprocess then
// runs --no-fetch instead of independently fetching the same ref on the landing queue's
// serialized critical path (the worktree shares the repo's refs, so one fetch freshens
// origin/master for every subprocess). Best-effort like the repins themselves: a stale
// ref only ever REFUSES a re-pin, never accepts one.
// plan 3972 (round 2): returns `{ rework }` — true when ANY family refused because the patch-id
// DIFFERS. Round 3 stopped keying the preflight tip on it: `{ rework: false }` also covers a repin
// that failed for an I/O reason, so the tip is re-proven from the markers themselves instead
// (repinAndReprove); the return stays for the other callers' classification.
function repinShaPinnedMarkers(wtPath) {
  fetchOriginMasterForRepin(wtPath); // best-effort; a miss just leaves the stricter stale-ref view
  const r1 = tryMarkerRepin(wtPath, 'record-review.mjs', { noFetch: true });
  const r2 = tryMarkerRepin(wtPath, 'record-wiki.mjs', { noFetch: true });
  const r3 = tryMarkerRepin(wtPath, 'record-conclusion.mjs', { noFetch: true }); // plan 2033
  return { rework: r1.rework === true || r2.rework === true || r3.rework === true };
}

// gpt-review 3972 r2 findings 69a219 / 7b4d9e: the merge's `expectedHead` used to be read
// from the LIVE worktree HEAD at merge time, so a commit made after preflight would have become
// its own expectation. `state.preflightTip` is the tip preflight actually validated (captured at
// the 2.5 review seam, after the hoisted repin). The merge site compares the live HEAD against it
// and seams REVIEW_NEEDED on any drift, so nothing but the validated content can be pinned.
//
// gpt-review 3972 r3 findings e25078 / 8a3415 / 6b6eaa / 224129 / cb36d5 / 5c77cd / db891c /
// 4e7c14: the tip may only ever ADVANCE on POSITIVE proof. Round 2 advanced it on the absence of
// a signal (no `rework` from the repin, or no repin at all on the plain fast-path arm), so a repin
// that failed for an I/O reason and a commit that reached the worktree before the carry both
// became "validated" and were merged.
//
// gpt-review 3972 r4 findings d6a349 / 6b3093 / 619344 / 661bfa / 4632cf / 8f8d75: round 3
// re-proved the tip by RE-IMPLEMENTING a subset of preflight's gates against the new HEAD, and
// every gate it omitted (the findings sidecar, a `--resume`-disarmed seam, the frozen file list,
// the stale conclusion base) was a hole. The proof is now the ONE the spine already owns and the
// pre-3972 rebase path already relied on: PATCH-ID IDENTITY via the marker repin. After a
// spine-owned re-sha the content is unchanged iff every marker family preflight FOUND for the
// old tip re-pins with `repinned: true` — `record-marker-cli.mjs repin` exits 0 only when the
// recorded tip's range patch-id equals HEAD's (or the marker already pins HEAD, the fast-path
// case), 4 when they differ (rework), 3 when no marker exists, and 1/2/5 on anything else; every
// non-zero exit reads as `repinned: false` here. Every gate preflight passed (review verdict,
// findings dispositions, conclusion, wiki — core-noun-ok: the MARKER_FAMILIES keys, generic by
// this module's own contract) then carries by construction, because each is
// content-keyed. The findings sidecar is the one extra read: `findingsGate` (the same call the
// 2.55 gate makes) must be clear for the new HEAD, since a NITS/BUGS-FOUND verdict is only as
// good as its dispositioned, sha-or-patch-id-current sidecar.
//
// Which families are ARMED comes from the marker LOOKUPS preflight already does — the review
// verdict (computed for the plan-2170 enqueue refusal regardless of `--resume`), the conclusion
// verdict and the wiki decision (core-noun-ok: the generic MARKER_FAMILIES keys again), each
// hoisted out of its seam's `--resume` guard so a waived seam
// still arms a marker that exists — never from "the seam ran". An unarmed family is never asked
// (so its exit 3 can never be mistaken for a failure), and an armed family's failure of any kind
// (rework OR I/O) leaves the tip where it was and names the family in the step log; the
// merge-site drift check then seams REVIEW_NEEDED. A HEAD that has not moved needs no re-proof.
//
// Module-level rather than on `state` because `state` is serialized whole into every seam dump
// and the result sidecar. Written once by phasePreflight (recordPreflightMarkers) after the last
// marker seam; null until then, which the reproof treats as "cannot prove".
let preflightMarkers = null;
export function recordPreflightMarkers(found) {
  preflightMarkers = found;
}

const REPIN_FAMILIES = Object.freeze([
  { key: 'review', script: 'record-review.mjs' },
  { key: 'conclusion', script: 'record-conclusion.mjs' },
  { key: 'wiki', script: 'record-wiki.mjs' },
]);

// The decision half: given the per-family repin results for the ARMED families (`repins`, keyed
// like REPIN_FAMILIES, each the {repinned, rework} shape tryMarkerRepin returns) and the branch's
// file list recomputed at `head` (`changedNow`), advance the tip to `head` or explain why not.
// Split from the repin half so the proof rule is one readable function and the subprocess
// fan-out is another.
function reprovePreflightTip(state, wtPath, head, repins, changedNow) {
  const D = landDeps();
  const found = preflightMarkers;
  const { main: MAIN, slug } = state;
  const stale = [];
  for (const fam of REPIN_FAMILIES) {
    if (!found[fam.key]) continue;
    const rp = repins[fam.key];
    if (!rp || !rp.repinned)
      stale.push(`${fam.key} (${rp && rp.rework ? 'patch-id differs' : 'repin failed'})`);
  }
  const reviewCurrent = found.review && !stale.some((s) => s.startsWith('review'));
  // The zero-armed case: a land whose preflight diff armed no family (docs-only, no marker of
  // any kind) has nothing to re-pin, so the repins above prove nothing — and a foreign commit
  // that reached the worktree since preflight could have added reviewable paths. Ask the SAME
  // question the plan-2170 enqueue gate asks, of the diff as it stands at `head`: reviewable
  // paths with no current verdict is a refusal. With a family armed this is redundant (the
  // repin's patch-id gate already proved the diff unchanged); with none it is the whole proof.
  const refusal = D.L.enqueueReadinessRefusal(
    changedNow,
    reviewCurrent ? found.review : null,
    found.handoffLayout,
  );
  if (refusal) stale.push('review (reviewable paths at HEAD with no current verdict)');
  if (reviewCurrent) {
    // The 2.55 findings gate, re-asked for the new HEAD: the verdict carried over unchanged by
    // the repin, the sidecar re-read (a NITS/BUGS-FOUND sidecar the repin also re-pins, sha-current
    // or patch-id-current; a legacy sha-only sidecar that did not follow halts here). DRY mirrors
    // the 2.55 site's pseudo-sha and null identity thunks.
    const headSha = D.env.DRY ? 'dryhead' : head;
    const fg = D.L.findingsGate(
      found.review,
      recordedFindings(MAIN, slug, wtPath, found.handoffLayout),
      headSha,
      (id) => planExistsAtLand(wtPath, id),
      D.env.DRY ? null : D.landLib.rangePatchIdOnce(wtPath, headSha),
      D.env.DRY ? null : makeSeedOnlyDelta(wtPath),
    );
    if (fg) stale.push(`findings (${fg.code})`);
  }
  if (stale.length) {
    const message =
      `preflight tip: ${stale.join(' + ')} — the re-sha'd HEAD ${head.slice(0, 9)} is not proven ` +
      `to be the reviewed content; tip stays ${String(state.preflightTip || '').slice(0, 9)} and ` +
      'the merge will seam REVIEW_NEEDED (plan 3972)';
    D.spine.stepLog(state, message);
    if (D.env.DRY) process.stdout.write(`${message}\n`); // stepLog is silent under --dry-run
    return false;
  }
  D.spine.stepLog(
    state,
    `preflight tip: re-proven at ${head.slice(0, 9)} by marker repin (was ${String(state.preflightTip || '').slice(0, 9)})`,
  );
  state.preflightTip = head;
  return true;
}

// plan 4021: the reproof twin of markerSourceEntry — a subprocess-free FAST PATH for a family whose
// marker is read from an OLDER owned entry (an adopting session's marker-less claim entry sits on
// top). The proof is the read side itself, re-run against the new HEAD with the plain family
// parser: it accepts exactly when the CLI's markerPreCheck would exit 0 WITHOUT writing (the
// marker's sha pins HEAD, or its patch-id equals HEAD's range patch-id). No seed-only carry here
// (core-noun-ok: the real makeSeedOnlyDelta fallback this sentence contrasts with),
// matching that CLI check. Nothing is written. Review fb94f6: `repin` now CARRIES such a marker
// forward into the newest entry before re-pinning it, so a marker that needs a real re-pin write
// (legacy sha-only across a pure rebase) returns null here and is handed to the CLI, which can now
// advance it. Returns tryMarkerRepin's {repinned, rework} shape, or null (the caller then asks the
// CLI exactly as before). DRY never takes it: there are no real session entries.
function fallbackMarkerReproof(state, wtPath, key) {
  const D = landDeps();
  if (D.env.DRY) return null;
  const layout = preflightMarkers?.handoffLayout;
  const family = D.L.MARKER_FAMILIES[key];
  if (!family || layout !== 'sessions') return null;
  const { main: MAIN, slug } = state;
  let src;
  try {
    src = markerSourceEntry(MAIN, slug, layout, family);
  } catch {
    return null;
  }
  if (!src?.fallback) return null;
  const current = recordedMarker(MAIN, slug, wtPath, layout, family, (c, headSha, headPatchId) =>
    D.L.parseMarkerCurrent(family, c, headSha, headPatchId),
  );
  return current ? { repinned: true, rework: false } : null;
}

// The ONE re-sha follow-up every spine-owned re-sha site calls (gpt-review 3972 r4 finding
// 8f8d75: the pre-convergence rebase re-pinned without re-proving, so a later sync-skip at the
// head carried a stale tip into the drift check). Sites: the pre-queue freshen, the `--wait`
// pre-convergence rebase, the at-head rebase, a fast-path hit (both arms) and a speculative
// un-stack. The repin half: ONE origin/master fetch for the family set, then `--no-fetch` per
// child (plan 2042 / 3447 — a miss only makes each repin stricter), asked of the ARMED families
// only; the results feed reprovePreflightTip. Returns true iff the tip now pins HEAD.
export function repinAndReprove(state, wtPath) {
  const D = landDeps();
  let head = null;
  try {
    head = worktreeHeadSha(wtPath) || null;
  } catch {
    head = null;
  }
  if (!head) {
    D.spine.stepLog(
      state,
      'preflight tip: HEAD unreadable — tip NOT advanced (merge will refuse drift)',
    );
    return false;
  }
  if (head === state.preflightTip) return true; // nothing moved: the proof still stands
  if (!preflightMarkers) {
    D.spine.stepLog(
      state,
      `preflight tip: no preflight marker record to re-prove ${head.slice(0, 9)} against — tip NOT advanced`,
    );
    return false;
  }
  fetchOriginMasterForRepin(wtPath);
  const repins = {};
  for (const fam of REPIN_FAMILIES) {
    if (!preflightMarkers[fam.key]) continue; // never ask an unarmed family
    repins[fam.key] =
      fallbackMarkerReproof(state, wtPath, fam.key) ||
      tryMarkerRepin(wtPath, fam.script, { noFetch: true });
  }
  // The branch's own file list at the NEW head — the same `origin/master...HEAD` derivation
  // preflight's `changed` came from, re-read rather than reused because a foreign commit is
  // exactly what could have changed it.
  return reprovePreflightTip(state, wtPath, head, repins, changedFiles(wtPath));
}

// The ONE best-effort origin/master fetch a marker re-pin set shares (plan 2042 / 3447), factored
// out (plan 3972 F3) so the SEAM-TIME repin sites in phasePreflight (the 2.5 review seam, the
// 2.67 conclusion gate, the 2.68 wiki checkpoint — core-noun-ok: the three real marker-family
// seam sites this closure serves) can take the same one-fetch-then-`--no-fetch`
// shape instead of each child fetching the same ref on its own. Offline ⇒ each repin degrades to
// its stricter stale-ref view (a stale ref only ever REFUSES a re-pin, never accepts one).
// Returns true when the ref was actually refreshed (DRY counts as refreshed: there is nothing to
// fetch), false on a failed fetch — so a memoizing caller can retry rather than remember a miss.
export function fetchOriginMasterForRepin(
  wtPath,
  { run: _run = landDeps().spawn.run, dry = landDeps().env.DRY } = {},
) {
  if (dry) return true;
  try {
    _run('git', ['-C', wtPath, 'fetch', '--quiet', 'origin', 'master']);
    return true;
  } catch {
    return false; // offline — each repin degrades to its stricter stale-ref view
  }
}

// plan 3972 F3: a lazily-fetching repin for the seam-time sites. The three seams run in ONE
// synchronous preflight span with nothing moving origin/master between them that a second fetch
// would need to see, so the FIRST seam that actually attempts a repin pays the one fetch and the
// rest reuse it; a preflight where no marker is stale fetches nothing at all. Returns the same
// {repinned, rework} shape as tryMarkerRepin.
// Only a SUCCESSFUL fetch is memoized (gpt-review 3972 r1 finding ae368a): a transient miss at the 2.5
// seam must not leave the 2.67 / 2.68 seams reading the stale ref with no retry — a stale ref only
// ever REFUSES a re-pin, but three needless refusals from one blip is the halt this closure
// exists to avoid. Exported with its collaborators injectable so the memo is unit-testable.
export function makeSeamTimeMarkerRepin(
  wtPath,
  { fetch = fetchOriginMasterForRepin, repin = tryMarkerRepin } = {},
) {
  let fetched = false;
  return (script) => {
    if (!fetched) fetched = fetch(wtPath) === true;
    return repin(wtPath, script, { noFetch: true });
  };
}

// recordedVerdict (plan 337): the worktree's handoff session entry may carry a
// `Review: PASS|NITS|BUGS-FOUND @ <sha>` marker written at review time. Honor it ONLY
// when the marker's <sha> is the CURRENT branch HEAD — parseReviewMarker's staleness
// guard — so a clean review recorded earlier lets the land skip the REVIEW_NEEDED
// seam, while a review of an older tip (commits added since) still re-reviews.
// Returns 'PASS'|'NITS'|'BUGS-FOUND'|null; null (no marker / stale / unreadable /
// single-file layout) ⇒ reviewSeam decides (today's halt-then-/code-review path).
// plan 1286: candidate contents of a session doc, freshest-first — the fetched origin ref
// (record-review's routed default lands there without necessarily advancing MAIN), then MAIN's
// working tree (--no-push / offline records exist only there). Callers try each candidate and
// keep the first that yields a valid (sha-current) parse, so neither source can shadow a
// current marker recorded via the other.
// plan 4021 review round 2 (4dbea7): the shared originFirstCandidates. `strict` (marker SOURCE
// selection only) throws on any failure other than a genuine absence, so the picker halts on it.
function sessionDocCandidates(MAIN, rel, { strict = false } = {}) {
  const D = landDeps();
  return originFirstCandidates(
    () => D.spawn.run('git', ['-C', MAIN, 'show', `origin/master:${rel}`]),
    () => readFileSync(`${MAIN}/${rel}`, 'utf8'),
    // review round 3 (4fcf38/2a36b2): the lstat tells a missing file from a dangling symlink
    { strict, probeTree: () => lstatSync(`${MAIN}/${rel}`) },
  );
}

// plan 1528 A1: mechanize the marker re-pin after a pure rebase. A rebase re-shas the
// branch tip, so the sha-pinned Review/Wiki markers go stale (core-noun-ok: the real family
// names) and the next invocation
// halts (REVIEW_NEEDED / WIKI_CHECKPOINT — core-noun-ok: the real seam names this cites) for
// what is pure bookkeeping —
// the plan-1450 incident halted for it TWICE in one land. record-review/record-wiki `repin` own the
// gate (core-noun-ok: record-wiki.mjs is the real sibling script named alongside record-review.mjs)
// (patch-id-identical vs origin/master ⇒ re-record mechanically; differ ⇒ refuse):
// this wrapper just shells them from INSIDE the worktree (their plan-1105 branch guard
// requires it) and classifies the outcome. Returns:
//   { repinned: true }                 marker now pins HEAD (or already did)
//   { repinned: false, rework: true }  patch-ids DIFFER — the branch content changed
//                                      (Phase B's requeue trip reads this arm)
//   { repinned: false, rework: false } nothing to re-pin / gate uncomputable / error —
//                                      fall through to today's halt
// Best-effort by design: ANY failure degrades to the pre-1528 behavior (halt to session).
function tryMarkerRepin(wtPath, script, { noFetch = false } = {}) {
  const D = landDeps();
  // DRY test hook (mirrors DW_FAKE_DIFF): DW_FAKE_REPIN=ok|rework drives the two
  // interesting arms deterministically; unset ⇒ plain not-repinned (today's behavior).
  if (D.env.DRY) {
    if (process.env.DW_FAKE_REPIN === 'ok') return { repinned: true };
    return { repinned: false, rework: process.env.DW_FAKE_REPIN === 'rework' };
  }
  try {
    // noFetch: the caller (repinShaPinnedMarkers, or the plan-3972 seam-time closure from
    // makeSeamTimeMarkerRepin) already freshened origin/master once for the whole marker set
    // (plan 2042) — skip the per-subprocess best-effort fetch.
    D.spawn.run('node', [`scripts/${script}`, 'repin', ...(noFetch ? ['--no-fetch'] : [])], {
      cwd: wtPath,
    });
    return { repinned: true };
  } catch (e) {
    return { repinned: false, rework: e && e.status === 4 };
  }
}

// `seedShardDir` defaults to that configured value (core-noun-ok: names the real parameter below),
// so this predicate uses the SAME vocabulary as every other seed matcher instead of its own
// literal (core-noun-ok: names the real, project-configured coord.config.json key every caller
// keys on; gpt-review 9bd383). See resolveSeedShardDir's header (core-noun-ok: names the real
// function) for the null-disables contract.
// plan 4057 defect 4: the default is the MERGE-BASE read, not the branch checkout's own
// coord.config.json. Both call sites below (the marker-status table and the review-carry decision
// it predicts) take this default deliberately — a table that predicted the gate against a
// different shard root (core-noun-ok: `seedShardDir` is the real parameter below) than the gate
// itself uses would announce a carry the gate then refuses, or the reverse. The branch-config
// reader (core-noun-ok: `resolveSeedShardDir` is the real sibling function) stays exported for any
// caller that genuinely wants the BRANCH's own configured value; at the time of this change the
// review carry was its only consumer.
export function makeSeedOnlyDelta(
  wtPath,
  seedShardDir = landDeps().spine.resolveSeedShardDirAtMergeBase(wtPath),
) {
  const D = landDeps();
  const cache = new Map();
  const compute = (recordedSha, currentSha) => {
    const key = `${recordedSha}..${currentSha}`;
    if (cache.has(key)) return cache.get(key);
    // The EXISTING X..Y reader (gpt-review c8392e) — not a second `git diff --name-only` shell with
    // its own error/DRY handling. It returns null on a failed diff, which isSeedOnlyDelta reads as
    // "not seed-only" (core-noun-ok: isSeedOnlyDelta is the real exported predicate this sentence
    // describes) (the strict sha/patch-id rule stands), and honours DW_FAKE_LANDED_DELTA under
    // --dry-run exactly as the land-delta callers do.
    const paths = D.spine.gitDeltaFiles(wtPath, recordedSha, currentSha);
    const result = {
      ok: D.L.isSeedOnlyDelta(paths, seedShardDir),
      count: Array.isArray(paths) ? paths.length : 0,
    };
    cache.set(key, result);
    return result;
  };
  const predicate = (recordedSha, currentSha) => compute(recordedSha, currentSha).ok;
  predicate.describe = (recordedSha, currentSha) => compute(recordedSha, currentSha);
  return predicate;
}

// plan 2042: ONE reader for every sha-pinned session-entry marker — resolve the newest
// session file referencing the slug, then walk sessionDocCandidates ORIGIN-FIRST with a
// working-tree fallback (plans 1403/1286: the record CLIs land markers via the disposable
// coord-checkout push, so MAIN's working tree can lag origin/master by exactly the
// marker-adding commit and would falsely re-trip the gate on a freshly-recorded verdict);
// the first candidate carrying a CURRENT marker wins, so neither source can shadow it.
// `parse(content, headSha)` is the family adapter (L.parseReviewMarker / parseWikiMarker /
// parseConclusionMarker — core-noun-ok: the three real per-family parser exports) — its return
// shape is that family's historical contract.
//
// plan 4021: `family` (an L.MARKER_FAMILIES entry) picks WHICH owned session entry is read —
// markerSourceEntry: the newest owned entry, unless it carries no marker of this family at all,
// in which case the newest OLDER owned entry that does. Validity is still decided below by the
// family parser against the current tip, so an older marker only counts while it pins this diff.
function recordedMarker(MAIN, slug, wtPath, handoffLayout, family, parse) {
  const D = landDeps();
  if (handoffLayout !== 'sessions') return null; // the marker convention is per-session-file
  const src = markerSourceEntry(MAIN, slug, handoffLayout, family);
  if (!src) return null;
  try {
    const headSha = D.spawn.run('git', ['-C', wtPath, 'rev-parse', 'HEAD']).trim();
    // plan 2743: HEAD's rebase-stable range patch-id, for the read-side fallback that lets a
    // marker survive a pure rebase without a re-pin commit. LAZY + memoized on purpose: a
    // marker whose sha already pins HEAD (the overwhelmingly common case) never calls this, so
    // the fast path spawns no extra git; a stale-sha marker computes it at most ONCE across
    // both session-doc candidates rather than per candidate.
    const headPatchId = D.landLib.rangePatchIdOnce(wtPath, headSha);
    for (const content of src.contents) {
      const v = parse(content, headSha, headPatchId);
      if (v) return v;
    }
    return null;
  } catch {
    return null; // rev-parse failure → fall through to the seam
  }
}

// plan 2086: staleness-blind read of every sha-pinned marker family (Review/Wiki/Conclusion;
// core-noun-ok: the three real MARKER_FAMILIES keys this module's own header declares generic)
// for `slug`, formatted as a small table naming each marker's own pinned sha and whether it
// currently matches HEAD — printed on a repin-refused halt so the session sees WHICH marker(s)
// are stale + their shas in one place, instead of the ambiguous "some marker needs a repin"
// the seam reasons gave before (the plan-1450/2086 hand-grep incident: two land attempts
// requeued with an identical arm string before the stale marker was found by hand-grepping
// the session file for `@ <sha>` lines). Best-effort: any read failure shows as "unknown"
// rather than throwing — this is diagnostic text, never a gate. Reads HEAD once and the
// session file's candidates (origin-first, working-tree fallback) once, reused across all
// three families — the pre-fix version called recordedMarker() per family, each paying its
// OWN redundant `git rev-parse HEAD` + `git show origin/master:…` + readFileSync (review
// finding: 4 rev-parse + 3 show + 3 read spawned to build a 3-line table). Row formatting
// is L.markerStatusRow — shared with record-marker.mjs's `check` so the two never disagree.
// plan 4021: the owned session entry a READ of ONE marker family consults — the pure selection
// is pickMarkerSourceEntry (scripts/coord/review-markers.mjs), fed the resolution chain and the
// origin-first session-doc view. Writes never come through here: record-*/repin keep targeting
// the newest owned entry. `read` is injectable so a multi-family caller can share one memo.
// Returns { path, contents, fallback } or null (single layout / no owned entry).
function markerSourceEntry(
  MAIN,
  slug,
  handoffLayout,
  family,
  read = (p) => sessionDocCandidates(MAIN, p, { strict: true }),
) {
  const D = landDeps();
  if (handoffLayout !== 'sessions') return null;
  const { sf, entries, anchored } = D.spine.resolveSessionEntryChain(MAIN, slug, handoffLayout);
  if (!sf) return null;
  // review 321957/0b3b0d: `anchored` tells the picker which ownership rule the newest copy must
  // meet; an unreadable or contested entry halts the family to "no marker" (the pre-4021 halt).
  // Review round 2: `entries` also carries the candidates the resolver dropped, as halt states.
  return pickMarkerSourceEntry(family, slug, entries, read, { anchored });
}

function markerStatusTable(MAIN, slug, wtPath, handoffLayout) {
  const D = landDeps();
  if (handoffLayout !== 'sessions') return '';
  let headSha;
  try {
    headSha = D.spawn.run('git', ['-C', wtPath, 'rev-parse', 'HEAD']).trim();
  } catch {
    return 'marker status: unknown (HEAD unresolvable)';
  }
  const sf = D.spine.findSessionFile(MAIN, slug, handoffLayout);
  if (!sf) return `marker status for ${slug}: unknown (no session entry found)`;
  // plan 4021: one memoized session-doc read per entry, shared by all three family rows (each
  // family may resolve to a different owned entry, but none is read twice).
  const docCache = new Map();
  const readDoc = (p) => {
    if (!docCache.has(p)) {
      try {
        docCache.set(p, sessionDocCandidates(MAIN, p, { strict: true }));
      } catch (e) {
        docCache.set(p, e); // memoize the failure too; the picker halts on the rethrow
      }
    }
    const got = docCache.get(p);
    if (got instanceof Error) throw got;
    return got;
  };
  // plan 2743: shared across all three family rows (and lazy), so the table costs at most one
  // `git patch-id` — and none at all when every marker already pins HEAD.
  const headPatchId = D.landLib.rangePatchIdOnce(wtPath, headSha);
  // plan 3295: computed once, passed only for the review row (wiki/conclusion never take it — core-noun-ok:
  // the real MARKER_FAMILIES keys — see markerIdentityMatch's contract note) so this table can't
  // accidentally seed-only-carry (core-noun-ok: names the real makeSeedOnlyDelta mechanism)
  // a wiki or conclusion marker (core-noun-ok: the real MARKER_FAMILIES keys again).
  const seedOnlyDelta = makeSeedOnlyDelta(wtPath);
  const rows = Object.values(D.L.MARKER_FAMILIES).map((family) => {
    const src = markerSourceEntry(MAIN, slug, handoffLayout, family, readDoc);
    let marker = null;
    for (const content of src ? src.contents : []) {
      marker = D.L.parseMarkerAny(family, content);
      if (marker) break;
    }
    const forThisFamily = family === D.L.MARKER_FAMILIES.review ? seedOnlyDelta : null;
    const from = src?.fallback
      ? ` (read from older owned entry ${src.path})`
      : src?.halted
        ? ` (not read: ${src.halted.reason === 'owner' ? 'another owner declared in' : 'could not read'} ${src.halted.path})`
        : '';
    return `  ${D.L.markerStatusRow(family, marker, headSha, headPatchId, forThisFamily)}${from}`;
  });
  return `marker status for ${slug}:\n${rows.join('\n')}`;
}

// plan 2086: emitSeam + the marker-status-table append, in one place — the halt reason at
// every review/wiki/conclusion repin-refused seam (core-noun-ok: the three real MARKER_FAMILIES
// keys) wants the exact same
// `${reason}\n\n${markerStatusTable(...)}` shape; six hand-inlined copies of that
// concatenation is what the reviewer flagged as a drift risk (a future tweak to how the
// table is appended would need identical hand-edits at all six sites).
export function emitSeamWithMarkerTable(code, reason, MAIN, slug, wtPath, handoffLayout, state) {
  const D = landDeps();
  D.spine.emitSeam(
    code,
    `${reason}\n\n${markerStatusTable(MAIN, slug, wtPath, handoffLayout)}`,
    state,
  );
}

// review 2170 [7]: the ONE rework-halt wrapper for every marker family — release the slot if
// possible, then halt with the family's own seam, the released variant carrying the release note
// (plan 2517: TAIL re-entry, no preserved position). Extracted so a future marker family cannot
// adopt the halt but miss the release half (which would silently bring the plan-1219/2150
// head-hold back for just that family). ALWAYS emits (and process-exits via emitSeam) — call only
// on a proven-rework halt.
//
// plan 4042 (D-M15): moved here from the command file, where it had been left purely because
// nothing forced it out. Its body reaches NOTHING spine-resident — `dequeueForRework` and
// `emitSeamWithMarkerTable` are both core siblings and the note builder is a pure lib call — so
// it never needed a dependency-container hop, and its three call sites can import it directly
// once they follow it out. This is the shape the carve is supposed to produce: a function leaving
// the command file SHRINKS the injection container rather than growing it.
export function emitReworkHaltWithRelease(
  state,
  family,
  seamObj,
  MAIN,
  slug,
  wtPath,
  handoffLayout,
) {
  const D = landDeps();
  const dq = dequeueForRework(state, family);
  emitSeamWithMarkerTable(
    seamObj.code,
    seamObj.reason + (dq.dequeued ? D.L.reworkDequeuedNote() : ''),
    MAIN,
    slug,
    wtPath,
    handoffLayout,
    state,
  );
}

export function recordedReviewMarker(MAIN, slug, wtPath, handoffLayout) {
  const D = landDeps();
  if (D.env.DRY) {
    // test hook (mirrors DW_FAKE_DIFF): a fake verdict projects a marker, with optional provenance.
    return process.env.DW_FAKE_REVIEW_VERDICT
      ? {
          verdict: process.env.DW_FAKE_REVIEW_VERDICT,
          detail: process.env.DW_FAKE_REVIEW_PROVENANCE || '',
        }
      : null;
  }
  // plan 3295: the seed-only carry (core-noun-ok: names the real makeSeedOnlyDelta mechanism) —
  // REVIEW ONLY (recordedWikiDecision / recordedConclusionVerdict below never pass a
  // seedOnlyDelta predicate; core-noun-ok: names the two real sibling functions and the real
  // predicate parameter). Logged once, exactly when the marker was actually
  // honored via the seed-only fallback (core-noun-ok: same mechanism again) rather than a fresh
  // sha or a rebase-stable patch-id.
  const seedOnlyDelta = makeSeedOnlyDelta(wtPath);
  const family = D.L.MARKER_FAMILIES.review;
  return recordedMarker(
    MAIN,
    slug,
    wtPath,
    handoffLayout,
    family,
    (content, headSha, headPatchId) => {
      const marker = D.L.parseReviewMarkerFull(content, headSha, headPatchId, seedOnlyDelta);
      if (marker?.seedOnlyCarried) {
        const { count } = seedOnlyDelta.describe(marker.sha, headSha);
        console.log(
          `review-carry: seed-only delta ${marker.sha.slice(0, 7)}..${headSha.slice(0, 7)} ` +
            `(${count} files) — marker honoured (plan 3295)`,
        );
      }
      return marker;
    },
  );
}

// recordedWikiDecision (core-noun-ok: this comment documents that real exported function; plan
// 1074): the worktree handoff session entry may carry a
// `Wiki: WROTE|SKIP @ <sha>` marker written by scripts/record-wiki.mjs (core-noun-ok: the real
// literal marker text and its real writer script). Returns
// 'WROTE'|'SKIP'|null (null ⇒ wikiCheckpointSeam decides — core-noun-ok: names the real seam
// function) — the shared recordedMarker
// reader with the wiki family adapter (core-noun-ok: the real MARKER_FAMILIES.wiki adapter).
export function recordedWikiDecision(MAIN, slug, wtPath, handoffLayout) {
  const D = landDeps();
  if (D.env.DRY) return process.env.DW_FAKE_WIKI_DECISION || null; // test hook (mirrors DW_FAKE_REVIEW_VERDICT)
  return recordedMarker(
    MAIN,
    slug,
    wtPath,
    handoffLayout,
    D.L.MARKER_FAMILIES.wiki,
    (content, headSha, headPatchId) =>
      D.L.parseWikiMarker(content, headSha, headPatchId)?.decision ?? null,
  );
}

// recordedFamilyMarker (plan 4219): the family-generic reader behind a project landSeam's
// `markerFamily.lookup` — the staleness-guarded, patch-id-aware marker of `familyKey` (an
// L.MARKER_FAMILIES key) as parseMarkerCurrent returns it, or null. The three readers above and
// below keep their own historical return shapes; a new family reads through this one instead of
// adding a fourth hand-written copy.
export function recordedFamilyMarker(MAIN, slug, wtPath, handoffLayout, familyKey) {
  const D = landDeps();
  const family = D.L.MARKER_FAMILIES[familyKey];
  if (!family)
    throw new Error(`recordedFamilyMarker: unknown marker family ${JSON.stringify(familyKey)}`);
  return recordedMarker(
    MAIN,
    slug,
    wtPath,
    handoffLayout,
    family,
    (content, headSha, headPatchId) =>
      D.L.parseMarkerCurrent(family, content, headSha, headPatchId),
  );
}

// recordedConclusionVerdict (plan 2033): the session entry may carry a
// `Conclusion: <UPHELD|REFUTED|UNDERDETERMINED>:<detail> @ <sha>` marker written by
// scripts/record-conclusion.mjs. Returns { verdict, detail } or null — the shared
// recordedMarker reader with the conclusion family adapter.
// Deliberately NO DW_FAKE_* DRY hook: the sole caller (gate 2.672) sits inside the
// !DRY seed-views block (core-noun-ok: names the real seed-shard-scoped gate grouping this sits
// in) — like STATUS_FLIP, this gate is exercised at the lib level
// (conclusionReviewSeam tests), never via DRY-mode integration hooks; a documented
// hook that can never fire would only invite false test confidence (review 2033 [1]).
export function recordedConclusionVerdict(MAIN, slug, wtPath, handoffLayout) {
  const D = landDeps();
  return recordedMarker(
    MAIN,
    slug,
    wtPath,
    handoffLayout,
    D.L.MARKER_FAMILIES.conclusion,
    D.L.parseConclusionMarker,
  );
}

// recordedFindings (plan 1205): the worktree handoff session entry's findings sidecar
// (docs/handoff/sessions/<base>.findings.json, written by record-review --findings), parsed.
// Returns the record or null (no sidecar / unreadable / single-file layout). The sha-pin is
// enforced by findingsGate, not here. DRY hook: DW_FAKE_FINDINGS = the sidecar JSON (mirrors
// DW_FAKE_REVIEW_VERDICT).
export function recordedFindings(MAIN, slug, wtPath, handoffLayout) {
  const D = landDeps();
  if (D.env.DRY)
    return process.env.DW_FAKE_FINDINGS
      ? D.L.parseFindingsRecord(process.env.DW_FAKE_FINDINGS)
      : null;
  if (handoffLayout !== 'sessions') return null;
  // plan 4021: findings FOLLOW the review marker — the sidecar beside the SAME owned entry the
  // review read resolves to (markerSourceEntry, review family), never a sibling entry's. When an
  // adopting session's newer entry carries no Review marker, that is the older entry holding it.
  const src = markerSourceEntry(MAIN, slug, handoffLayout, D.L.MARKER_FAMILIES.review);
  // review round 2: a halted review source has no marker, so there is no sidecar to follow either
  if (!src || src.halted) return null;
  try {
    // Derive the sidecar via the ONE shared helper so writer (record-review) and reader can't drift.
    const sidecarRel = D.L.findingsSidecarPath(src.path);
    // plan 1286: origin-first with a working-tree fallback (see sessionDocCandidates); prefer
    // the record pinned to the CURRENT worktree HEAD — the one findingsGate will honor — and
    // only fall back to any parseable record (the gate then reports its staleness honestly).
    const headSha = D.spawn.run('git', ['-C', wtPath, 'rev-parse', 'HEAD']).trim();
    // review round 3 (8a3528): the STRICT read. A copy that fails for any reason but absence (it
    // throws into the catch below), will not parse, or names another owner halts the whole read —
    // null, so the gate halts — instead of being skipped so an older readable copy is consumed.
    // plan 2838 (review [13]): a stamped sidecar naming ANOTHER plan is never consumed, so plan A's
    // dispositioned record can never satisfy plan B's FINDINGS_OPEN gate. An unstamped legacy
    // sidecar has no owner to disagree with and still rides.
    const parsed = [];
    for (const c of sessionDocCandidates(MAIN, sidecarRel, { strict: true })) {
      const rec = D.L.parseFindingsRecord(c);
      if (!rec || !D.L.sidecarOwnedBy(rec, slug)) return null;
      parsed.push(rec);
    }
    return parsed.find((r) => r.sha === headSha) || parsed[0] || null;
  } catch {
    return null;
  }
}

// planExistsAtLand (plan 1205): the AUTHORITATIVE plan-existence check for a finding's
// `--plan <id>` disposition — does a plan file `<id>-*.md` exist under docs/superpowers/plans/
// on a FRESH origin/master (a one-time fetch, since a disposition often names a plan filed
// AFTER this worktree was cut)? Falls back to the worktree HEAD tree. DRY → always true (no
// real plans in the fixture). The dangling-plan branch of findingsGate rides on this. The
// fetch AND the per-ref plan listings are memoized (a land with N plan-dispositioned findings
// re-asked the same listing N times — plan 1205 review [13]); the tree→id match is the shared
// L.planIdInTree (same matcher record-review's advisory probe uses, so they can't drift).
let _planFetchDone = false;
const _planTreeCache = new Map(); // ref → ls-tree output (or null on failure)
function planTreeListing(wtPath, ref) {
  const D = landDeps();
  if (_planTreeCache.has(ref)) return _planTreeCache.get(ref);
  let out = null;
  try {
    out = D.spawn.run('git', [
      '-C',
      wtPath,
      'ls-tree',
      '-r',
      '--name-only',
      ref,
      '--',
      'docs/superpowers/plans/',
    ]);
  } catch {
    /* ref absent → cache the null so we don't re-spawn it per finding */
  }
  _planTreeCache.set(ref, out);
  return out;
}
export function planExistsAtLand(wtPath, id) {
  const D = landDeps();
  if (D.env.DRY) return true;
  if (!String(id || '').trim()) return false;
  if (!_planFetchDone) {
    try {
      D.spawn.run('git', ['-C', wtPath, 'fetch', 'origin', 'master']);
    } catch {
      /* a stale origin/master still answers most cases; the worktree HEAD fallback covers the rest */
    }
    _planFetchDone = true;
  }
  for (const ref of ['origin/master', 'HEAD']) {
    if (D.L.planIdInTree(planTreeListing(wtPath, ref), id)) return true;
  }
  return false;
}

// plan 1573: win32-only preflight for the ephemeral land checkout's Windows MAX_PATH (260)
// hazard. Session 1436 (2026-07-07) hit `fatal: … Filename too long` mid-land — the ephemeral
// dir name plus a sufficiently deep committed path (a large generated-data subtree, in that
// incident) overflowed
// MAX_PATH with `core.longpaths` unset — and unblocked it with a one-off repo-local
// `git config core.longpaths true`. land-lib's dir-name truncation (this same plan) removes
// most of the overflow, but a sufficiently deep committed path can still exceed MAX_PATH on a
// `core.longpaths`-unset checkout, so both fixes ship together. Spec verdict (board-pass
// 2026-07-07 evening): SET-SILENTLY when unset, not assert-and-instruct — self-healing matches
// done-worktree's style, the setting is safe on any Git-for-Windows this repo supports, and
// assert-and-instruct only turns a one-line fixable condition into an avoidable operator
// round-trip. Repo-local (`--local`), so it is shared by every worktree of this .git (confirmed
// by the session-1436 mitigation) — set once here, never re-asked.
// Exported for direct unit testing (done-worktree.test.mjs) — this shells out to REAL git
// (`run` is not mockable here), so tests drive it against a real temp repo.
export function ensureLongpathsWin32(MAIN) {
  const D = landDeps();
  if (process.platform !== 'win32' || D.env.DRY) return;
  let unset = false;
  try {
    D.spawn.run('git', ['-C', MAIN, 'config', '--get', 'core.longpaths']);
  } catch {
    unset = true; // `git config --get` exits non-zero only when the key is unset
  }
  // review fix: `current` not-'true' collapses BOTH "unset" and "explicitly false" into the same
  // branch — only genuinely UNSET may be silently set; an operator's deliberate `false` (e.g.
  // working around a tool that mishandles long-path-enabled repos) must never be clobbered.
  if (!unset) return;
  D.spawn.run('git', ['-C', MAIN, 'config', '--local', 'core.longpaths', 'true']);
  process.stdout.write(
    'done-worktree: core.longpaths was unset — set true repo-local (win32 MAX_PATH preflight, plan 1573)\n',
  );
}

// ── preflight (returns a seam or null) ───────────────────────────────
// Exported for direct unit testing (done-worktree.test.mjs) — like ensureLongpathsWin32
// above, this shells out to REAL git via `run()`, so tests drive it against a real repo.
export function preflight(wtPath, branch, state) {
  const D = landDeps();
  // plan 3503 (confirmed 11e76f/a332f4): `--prep --no-rebase` is the review-time READ-ONLY
  // contract. Of the preflight steps below, ensureLongpathsWin32 (repo config only) and
  // healOwnWorktreeIndexLock (stale lock-file cleanup only) preserve HEAD and every ref; the
  // orphan-state, cleanliness and worktree-branch content-guard checks are reads. recoverRebasedUnpushed is the sole
  // exception: it fetches (moving remote-tracking refs) and can `reset --hard` (moving HEAD and
  // discarding the reviewed tree). That step is therefore replaced in no-rebase mode by the
  // read-only classification below, and the exact state it would heal is refused rather than
  // proved. DW_FAKE_REBASED_UNPUSHED makes that refusal reachable in the dry spine only.
  if (D.env.DRY) {
    if (D.env.PREP_NO_REBASE && process.env.DW_FAKE_REBASED_UNPUSHED === '1') {
      return {
        code: D.L.SEAM.PREFLIGHT_FAIL,
        reason:
          `rebased-but-unpushed recovery state: --prep --no-rebase will not fetch or reset the ` +
          `reviewed branch. Run the ordinary rebasing \`--prep\` (without \`--no-rebase\`) or ` +
          `the land to heal it before banking proofs.`,
      };
    }
    return null;
  }
  ensureLongpathsWin32(state.main);
  // plan 2465: best-effort self-heal of THIS worktree's own orphaned index.lock, before
  // the first worktree-index git op below. A resume re-run passes through preflight
  // again, so a seam-recovery retry gets the heal too. Never throws (see
  // healOwnWorktreeIndexLock's own try/catch) — a failed heal must never block a land.
  D.coordGit.healOwnWorktreeIndexLock(wtPath, state.main);
  // plan 3422 D4: an ORPHANED in-progress merge/rebase left in the worktree, caught HERE rather
  // than several steps later. Plan 1917 arrived at the queue head carrying an unfinished
  // MERGE_HEAD with 32 unresolved conflicts and spent 11 minutes of HEAD time on cleanup that
  // belonged pre-queue (2026-08-24 audit, class 3).
  //
  // Two shapes, and the old code caught only one of them badly:
  //   · conflicted (unmerged paths) — the clean-check below DID fail, but with a bare "worktree
  //     not clean" listing UU paths, which names the symptom and not the state;
  //   · fully resolved but UNCOMMITTED — `git status --porcelain` is CLEAN, so preflight passed
  //     and the orphan survived all the way to the at-head rebase.
  // Both now stop here, with the state named and the exact remedy printed.
  //
  // It HALTS, it does not auto-abort. `git rebase --abort` here would silently destroy a
  // deliberate hold: the plan-1805 pre-convergence path leaves a genuinely-conflicted rebase in
  // the worktree ON PURPOSE for the attended session to resolve, and that work can be hours old.
  // Naming it and handing over the two-command fix is the honest move; discarding a peer's
  // conflict resolution to save a preflight is not.
  let mut = worktreeMutationKind(wtPath);
  // plan 3974 round 2 (gpt-review 69df5c/bb3c7a/a0f071/a400a4/9d27ba/382952/ffe707): stale-marker
  // hygiene — a spine-written marker with NO rebase state left at all means a run was killed
  // between writing the marker and the `git rebase <onto>` call actually starting, or a prior
  // conclusion path somehow left it behind. Clear it here so it can never be mistaken for
  // provenance of a LATER, unrelated leftover rebase in this same worktree. A marker that fails
  // resumableSpineRebase's OTHER checks (identity mismatch, conflict residue, non-pick todo) is
  // left untouched — the halt below owns that state, not this cleanup.
  //
  // plan 3974 round 3 (gpt-review c8c57e): `rebaseStateKnownAbsent`, NOT `rebaseStateDir(...) ===
  // null` — the latter is what a FAILED `rev-parse --git-path` probe also returns (best-effort by
  // design), so it is fail-OPEN and must never gate a delete. A probe failure here just means the
  // marker survives to be re-judged next preflight, exactly like an unreadable rebase-merge file
  // elsewhere in this same discriminator.
  if (D.landLib.rebaseStateKnownAbsent(wtPath) && D.landLib.readSpineRebaseMarker(wtPath)) {
    D.landLib.clearSpineRebaseMarker(wtPath);
  }
  // plan 3974 T2b (narrowed post-gpt-review, findings f33dfb/166ca5/8302eb/fb2938/54c5e5): a
  // leftover `rebase` with a CLEAN tree and NO unmerged paths is not the plan-1805 deliberate
  // hold above (that shape always carries unmerged paths or uncommitted resolution work waiting
  // on a human) — it MAY be git simply waiting on `--continue` (e.g. the rescheduled-pick residue
  // land-lib's own retry, T2a, usually resumes inline, left sticky here only because nothing
  // continued it before THIS invocation started — a killed --prep, or a crash between the
  // reschedule and the next poll). Resume it ONCE, before reporting it as stuck — but ONLY when
  // ALL of the following hold, each guarding a real misfire the review caught:
  //   · `!DRY` — a resume is a real git mutation; nothing here is meaningful against a fake path.
  //   · `!PREP_NO_REBASE` — `--prep --no-rebase` is a promise not to move HEAD (plan 3503); a
  //     resume here would break that promise before its own read-only gates even run.
  //   · `resumableSpineRebase(wtPath)` — provably a `rebase-merge` (not `rebase-apply`, where an
  //     interrupted `git am` keeps its state and `git rebase --continue` would just fail) whose
  //     todo is pick-only end to end, i.e. the ONLY shape land-lib.mjs's own rebase calls (a bare
  //     `git rebase <sha>` / `git rebase --continue`, never `-i`/`-x`) can leave. A human's
  //     `git rebase -i` pause (edit/break/reword) or a deliberate `--exec` always leaves a
  //     non-pick verb somewhere in the todo and is refused here, never auto-continued.
  // If the continue does not conclude (a real conflict surfaces, or another failure), fall
  // straight through to the halt below UNCHANGED — this never weakens it for a genuinely
  // conflicted, dirty, interactive, am, or merge (not rebase) leftover.
  if (mut === 'rebase' && !D.env.DRY && !D.env.PREP_NO_REBASE && resumableSpineRebase(wtPath)) {
    // plan 3974 T0: a bare `git status` is itself a lock-taking WRITER (it refreshes the
    // worktree's private index even with zero changes), so the one read that decides whether
    // to resume must not be able to take the very lock a resumed rebase then needs.
    // plan 3974 round 2 (gpt-review d86e46): this read must never THROW out of preflight — a
    // failure here (a transient lock, an unreadable index) reads as "not resumable" and falls
    // straight through to the ordinary halt below, exactly like an unreadable rebase-merge file
    // does elsewhere in this same discriminator.
    let preResumeStatus = null;
    try {
      preResumeStatus = D.spawn.run('git', [
        '--no-optional-locks',
        '-C',
        wtPath,
        'status',
        '--porcelain',
      ]);
    } catch {
      preResumeStatus = null;
    }
    if (preResumeStatus !== null && D.L.filterPreflightDirty(preResumeStatus).length === 0) {
      try {
        D.spawn.run('git', ['-C', wtPath, 'rebase', '--continue']);
        // plan 3974 round 2: the spine's rebase concluded for real — its provenance marker has
        // done its job and must not outlive the rebase it described.
        D.landLib.clearSpineRebaseMarker(wtPath);
      } catch {
        /* did not conclude — re-probe below and report whatever state it left behind */
      }
      mut = worktreeMutationKind(wtPath);
    }
  }
  if (mut)
    return {
      code: D.L.SEAM.PREFLIGHT_FAIL,
      reason:
        `orphaned-merge-in-progress: this worktree has an unfinished ${mut} (plan 3422 D4). A land ` +
        `cannot rebase or merge over one, and carrying it to the queue head burns the slot on ` +
        `cleanup (plan 1917 lost 11 min of head time to exactly this). Finish it or discard it in ` +
        `the worktree FIRST, then re-invoke:\n` +
        `  finish:  resolve the conflicts, then ` +
        `${mut === 'merge' ? '`git commit`' : '`git rebase --continue`  (or `git am --continue`)'}\n` +
        `  discard: ${mut === 'merge' ? '`git merge --abort`' : '`git rebase --abort`  (or `git am --abort`)'}\n` +
        `This is NOT auto-aborted on purpose — a pre-convergence hold (plan 1805) leaves a ` +
        `conflicted rebase here deliberately, and discarding it would throw away real resolution ` +
        `work. 🟥 seed shards resolve with \`git checkout --ours\` + a re-run of the plan's apply ` +
        `script, never a hand-merge (branch-hygiene runbook).`,
    };
  // plan 3974 T0: same reasoning as the pre-resume read above — this is the ordinary
  // preflight clean-check, not a poller, but it is still a bare `git status` that would
  // otherwise refresh (write) the worktree's private index right before a possible resume.
  const dirty = D.spawn.run('git', ['--no-optional-locks', '-C', wtPath, 'status', '--porcelain']);
  // plan 985: tolerate the lone cut-worktree `.owner` marker (see L.filterPreflightDirty) —
  // any OTHER dirty path still fails the clean-check.
  const meaningful = D.L.filterPreflightDirty(dirty);
  if (meaningful.length)
    return (
      D.L.EXIT && {
        code: D.L.SEAM.PREFLIGHT_FAIL,
        reason: `worktree not clean:\n${meaningful.join('\n')}`,
      }
    );
  // plan 988: a crashed prior land can leave the branch rebased-but-unpushed (the SAME
  // reviewed diff on a newer base) — `origin/<branch>..<branch>` is then non-empty though
  // it is NOT new un-reviewed work. recoverRebasedUnpushed (fetch → range-diff classify)
  // self-heals that false positive by resetting to origin/<branch>, so the branch-sync
  // step redoes the rebase + force-push and a plain re-run lands. Genuinely-new/changed
  // unpushed work is NOT a pure rebase → recovered:false → still fails preflight.
  let rec;
  if (D.env.PREP_NO_REBASE) {
    // plan 3503 gpt-review round 2 (84f6f3): no fetch is deliberate. A stale tracking ref can only
    // produce a refusal here, which is the safe direction for the contract that this prep must not
    // move refs or HEAD; the ordinary recovery path calls the SAME classifier with mayFetch=true.
    const inspection = D.landLib.inspectRebasedUnpushed(wtPath, branch, { mayFetch: false });
    if (!inspection.ahead) rec = { ahead: false };
    else {
      if (inspection.classification === 'rebase-unpushed') {
        return {
          code: D.L.SEAM.PREFLIGHT_FAIL,
          reason:
            `rebased-but-unpushed recovery state: --prep --no-rebase will not fetch or reset the ` +
            `reviewed branch. Run the ordinary rebasing \`--prep\` (without \`--no-rebase\`) or ` +
            `the land to heal it before banking proofs.`,
        };
      }
      rec = { ahead: true, recovered: false, aheadShas: inspection.aheadShas };
    }
  } else rec = D.landLib.recoverRebasedUnpushed(wtPath, branch);
  if (rec.ahead && !rec.recovered)
    return {
      code: D.L.SEAM.PREFLIGHT_FAIL,
      reason: `branch has unpushed commits: ${rec.aheadShas}`,
    };
  // plan 1604: worktree branches must never carry wiki/** commits (core-noun-ok: the real
  // committed-path pattern the guard below matches) — see
  // wikiDiffOnWorktreeBranch's header comment (core-noun-ok: names the real exported guard this
  // paragraph is about) for the incident this closes. plan 3944
  // extended the SAME guard to the two hand-edited debt ledgers (LEDGER_FILES_ON_WORKTREE_BRANCH
  // — docs/handoff/infra-debt.md and its sibling domain ledger), which share that guard's
  // failure shape (a branch-carried commit colliding at the landing-queue head) but have an
  // OPPOSITE fix (wiki-commit.mjs vs a hand-edit-on-master-and-push; core-noun-ok: names the real
  // remedy script), so the reason text below
  // branches per file CLASS rather than pointing every hit at the same remedy — an operator
  // hitting only the ledger case should not have to read past wiki-commit.mjs instructions
  // (core-noun-ok: names the real remedy script again)
  // that do not apply to them to find the one line that does. plan 1639: a diff failure
  // surviving the retry budget is ALSO a hard PREFLIGHT_FAIL now (fail-closed), never the old
  // silent "no violation" — see WIKI_DIFF_RETRY_EXHAUSTED's own comment (core-noun-ok: names the
  // real exported sentinel this refers to).
  const wikiHit = D.spine.wikiDiffOnWorktreeBranch(wtPath, branch);
  if (wikiHit === D.spine.WIKI_DIFF_RETRY_EXHAUSTED)
    return {
      code: D.L.SEAM.PREFLIGHT_FAIL,
      reason:
        `worktree-branch wiki/ledger-diff guard could not compute the diff after 3 retries ` +
        `(plan 1639 fail-closed; ~250ms/750ms/1500ms backoff) — transient shared-.git ref-lock ` +
        `churn during a parallel-session herd, or a genuinely broken origin/master ref. ` +
        `.husky/pre-push degrades the SAME way at push time (same retry schedule, then ` +
        `BLOCKED) — a correlated failure at both seats must never silently let a worktree-` +
        `branch wiki or debt-ledger commit through undetected (the plan-1536 incident class). ` +
        `Investigate (stale/locked refs, an unreachable origin/master, network), then re-run.`,
    };
  if (wikiHit) {
    const ledgerFiles = wikiHit.filter((f) => D.spine.LEDGER_FILES_ON_WORKTREE_BRANCH.includes(f));
    const wikiFiles = wikiHit.filter((f) => !D.spine.LEDGER_FILES_ON_WORKTREE_BRANCH.includes(f));
    const remedies = [];
    if (wikiFiles.length)
      remedies.push(
        `wiki content (${wikiFiles.join(', ')}): wiki write-back must land straight to ` +
          `master, never ride a worktree branch (plan 1604; hot wiki pages conflict on every ` +
          `parallel land). Fix: from inside this worktree, push the page content to master ` +
          `with \`node scripts/wiki-commit.mjs <pages…> -m "chore(wiki): …"\` (it auto-detects ` +
          `this worktree checkout and routes via the disposable coord-checkout, never ` +
          `committing here), then drop the wiki commit(s) from this branch (\`git rebase -i\` ` +
          `and drop them, or reset before them) and re-run.`,
      );
    if (ledgerFiles.length)
      remedies.push(
        `debt ledger(s) (${ledgerFiles.join(', ')}): these are CLAUDE.md § Coordination's ` +
          `plain-doc carve-outs from coordWrite, hand-edited on MASTER only, never on a ` +
          `worktree branch (plan 3944; plan 3495 is the incident — a dispatch was told to ` +
          `delete an infra-debt line on a branch). Fix: hand-edit the ledger on the MAIN ` +
          `checkout's master, \`git commit -m "…" -- <ledger path>\`, push via ` +
          `pushMasterWithRebase (scripts/coord/coord-git.mjs), then drop the ledger commit(s) from ` +
          `this branch (\`git rebase -i\` and drop them, or reset before them) and re-run.`,
      );
    return {
      code: D.L.SEAM.PREFLIGHT_FAIL,
      reason: `worktree branch carries content that must never ride a worktree branch: ${remedies.join(' ALSO — ')}`,
    };
  }
  // plan 3682: a worktree branch must never carry a committed sweep-checkpoint file (see
  // sweepCheckpointOnWorktreeBranch's header comment). A thrown diff failure is a hard
  // PREFLIGHT_FAIL here too, same fail-closed direction as the content guard above — just
  // via a try/catch instead of a sentinel return value (see that function's header for why
  // this guard is simpler and doesn't need the retry ladder).
  let sweepCheckpointHit;
  try {
    // plan 4057 defect 3: the base is resolved to a SHA here, inside this fail-closed try, rather
    // than left to the guard's own re-read of the mutable `origin/master` ref. On the ordinary
    // path the recovery step above already ran `git fetch origin` (inspectRebasedUnpushed), so
    // this reads the freshly-fetched tip; `--prep --no-rebase` deliberately does not fetch and is
    // unchanged by this. Pinning to a sha also stops a concurrent fetch from moving the base
    // between this guard and the rest of the preflight.
    //
    // Deliberately NOT wrapped in its own catch with an `'origin/master'` fallback (gpt-review r1
    // 6096d3/5c922a/3c1f24): that would hand the guard back the very mutable ref this pins, so a
    // transient rev-parse failure followed by ref churn could compare against a different base
    // than the preflight intended. A failure here belongs to the same PREFLIGHT_FAIL below as a
    // failed diff — the fail-closed direction this guard already takes.
    sweepCheckpointHit = D.spine.sweepCheckpointOnWorktreeBranch(
      wtPath,
      branch,
      originMasterTip(wtPath),
    );
  } catch (err) {
    return {
      code: D.L.SEAM.PREFLIGHT_FAIL,
      reason:
        `sweep-checkpoint worktree-branch diff guard failed (plan 3682, fail-closed): ` +
        `${err.message || err}. Investigate (stale/locked refs, an unreachable origin/master, ` +
        `network), then re-run.`,
    };
  }
  if (sweepCheckpointHit)
    return {
      code: D.L.SEAM.PREFLIGHT_FAIL,
      reason:
        `worktree branch carries a committed weekly-sweep checkpoint file (plan 3682): ` +
        `${sweepCheckpointHit.join(', ')}. The sweep deletes this file on a COMPLETED pass, so ` +
        `a branch still carrying one means the render pass did NOT finish. Either finish it ` +
        `(pull this branch and re-run weekly-price-sweep.py with --resume --checkpoint-push ` +
        `until it completes and deletes the file) or drop it before landing ` +
        `(\`git rm ${sweepCheckpointHit.join(' ')}\` + commit).`,
    };
  return null;
}

// plan 972 Tier 1/2: the keep-hot --prep orchestration. Rebase the QUEUED worktree branch onto
// the live origin/master, re-validate the applicable gates against the rebased tree, and stamp
// the land-prep marker so the head-of-queue land fast-paths past the rebase + gate re-runs.
// Idempotent: a no-op when the marker already covers the live tip+branch (avoids thrash on a
// poll where nothing moved). Returns a PREP_EXIT code; NEVER merges.
export async function runLandPrep(MAIN, wtPath, branch, slug, changed, state) {
  const D = landDeps();
  // plan 2473: the worktree lock is ALREADY held — `acquireWorktreeBeforePreflight` took it for
  // this whole `--prep` invocation (and exited BUSY if someone else owned it), because preflight
  // itself can `git reset --hard` the branch and so must run under the lock too. Acquiring a
  // second time here would deadlock against ourselves.
  const lock = state?.worktreeLock || { path: null, token: null };
  if (!D.env.DRY) {
    // The lock excludes concurrent PROCESSES; it says nothing about state a CRASHED one left
    // behind (a half-finished rebase outlives its holder). Rebasing into someone else's
    // rebase-merge state is the same corruption class, so refuse on that too — the same guard
    // `attemptPreconverge` applies, and the reason its 'conflict' arm can release the lock while
    // deliberately leaving a rebase in progress.
    if (worktreeMutationInProgress(wtPath)) {
      console.error(
        `done-worktree --prep: a rebase/merge is already in progress in ${slug}'s worktree ` +
          `(leftover state needing \`git rebase --abort\`, or a session mid-resolve) — skipping.`,
      );
      return D.L.PREP_EXIT.BUSY;
    }
  }
  // plan 2654 guardrail 2 (the no-detached-exit invariant): remember whether we came in attached,
  // so the finally below can tell "the prep detached this tree" from "it was already detached"
  // (the latter is guardrail 1's abort, which never gets this far).
  const enteredAttached = D.spine.worktreeHeadRef(wtPath, branch) === `refs/heads/${branch}`;
  let outcome = null; // the PREP_EXIT this invocation returns; read by the finally (review [2])
  // No try/finally release OF THE LOCK: the lock is owned by the INVOCATION (taken before
  // preflight), and the process exits immediately after this returns — the `exit` hook is its
  // single release point, the same one every seam halt relies on. The finally here is narrower:
  // it only restores HEAD attachment, and never touches the lock.
  try {
    console.log(
      D.env.PREP_NO_REBASE
        ? `done-worktree --prep: mode no-rebase for ${slug} — proving the current worktree HEAD without moving it.`
        : `done-worktree --prep: mode rebase for ${slug} — refreshing against origin/master and maintaining the land-prep marker.`,
    );
    outcome = D.env.PREP_NO_REBASE
      ? await runLandPrepNoRebase(wtPath, branch, slug, changed, lock, state)
      : await runLandPrepLocked(MAIN, wtPath, branch, slug, changed, lock, state);
    return outcome;
  } catch (e) {
    if (e instanceof WorktreeLockLost) {
      outcome = D.L.PREP_EXIT.BUSY; // renewOrAbort already explained it
      return outcome;
    }
    throw e;
  } finally {
    // Covers EVERY exit path of the prep at once — the plain rebase, the idempotent fast-skip, the
    // conflict arm, the gate-failure arm, and both speculative-stack arms (clearSpeculative-
    // StackForPrep's restore and attemptSpeculativeStack) — including the ones that throw. Placing
    // it per-arm would have to be re-placed every time an arm is added, which is how the class
    // came back.
    //
    // plan 2654 review [2]: EXCEPT on BUSY, which is precisely "the worktree lock was reaped and
    // another process owns this tree now" (renewOrAbort's direct return, or the WorktreeLockLost
    // throw above). Healing there would put a second writer on one tree — the exact corruption the
    // lock exists to prevent — and the new owner may be mid-write with no rebase-merge marker yet
    // for worktreeMutationInProgress to see. The new owner runs this same invariant for itself.
    // A THROWN failure (outcome still null) does keep the heal: we still hold the lock, and a crash
    // mid-prep is exactly when a stranded detached HEAD needs re-attaching.
    if (enteredAttached && outcome !== D.L.PREP_EXIT.BUSY)
      restorePrepAttachment(wtPath, branch, slug);
  }
}

// plan 3503: review-time prep proves the tree the review is reading, so it must not fetch,
// rebase, move HEAD/refs, clear or create either prep marker, speculate, or push. Moving HEAD
// underneath the review and a possibly mid-edit session is the failure mode this mode exists to
// prevent; plan 3295's sha-keyed remainder envelope makes rebasing unnecessary for the proof.
async function runLandPrepNoRebase(wtPath, branch, slug, changed, lock, state) {
  const D = landDeps();
  // A detached HEAD would prove a sha the named worktree branch does not own. Keep the same cheap
  // plan-2654 attachment refusal as the rebasing prep even though this path performs no git write.
  const attach = D.spine.attachmentRefusal(wtPath, branch, slug, 'prep');
  if (attach) {
    console.error(attach);
    return D.L.PREP_EXIT.ERROR;
  }

  // plan 3503: a previous speculative prep may have left the branch stacked. Do NOT un-stack or
  // refuse it here: current HEAD is the tree being reviewed, its proof is keyed to that exact sha,
  // and a later un-stack is safely treated as an ordinary delta-scoped remainder by gatesProven.
  const {
    ok: gatesOk,
    chunked: gatesChunked,
    nonConvergent: gatesNonConvergent,
  } = await runPrepGates({
    state,
    wtPath,
    changed,
    delta: null,
    hasPriorForCap: false,
    priorGateResults: undefined,
    lock,
    slug,
    label: 'no-rebase',
    stopOnFail: false,
    narrateCache: true,
    onGateFail: (key, detail, { chunked, nonConvergent } = {}) =>
      console.error(
        nonConvergent
          ? `done-worktree --prep --no-rebase: ${key} gate NON-CONVERGENT on current HEAD — ` +
              `further attempts cannot help; fix the named file and commit — ${detail}`
          : chunked
            ? `done-worktree --prep --no-rebase: ${key} gate CHUNKED (not failed) on current ` +
              `HEAD — out of cloud-chunk budget this attempt, not a real break — ${detail}`
            : `done-worktree --prep --no-rebase: ${key} gate FAILED on current HEAD — ${detail}`,
      ),
  });
  if (!gatesOk) {
    return gatesNonConvergent
      ? D.L.PREP_EXIT.GATE_NON_CONVERGENT
      : gatesChunked
        ? D.L.PREP_EXIT.GATE_CHUNKED
        : D.L.PREP_EXIT.GATE_FAILED;
  }
  console.log(
    `done-worktree --prep --no-rebase: current HEAD proven for ${slug}; no land-prep marker was written.`,
  );
  return D.L.PREP_EXIT.OK;
}

// plan 2654 guardrail 2: no `--prep` exit path may leave a worktree detached that entered attached.
//
// Deliberately CONSERVATIVE about which direction it heals, and the test is ANCESTRY, not sha
// equality. Re-attaching is safe exactly when the detached tip is already CONTAINED in
// refs/heads/<branch> (same commit, or an ancestor of it) — then `checkout <branch>` cannot lose a
// commit, because the branch already has everything the detached HEAD had. That covers the real
// plan-2644 shape, where HEAD sat detached at the branch tip's PARENT: sha equality would have
// refused a heal that was provably lossless.
//
// When the detached tip is NOT contained in the branch it carries commits refs/heads/<branch> does
// not, and choosing between abandoning them and moving the branch onto them is a content decision
// this function must not make silently: it reports both shas and the recovery instead. Losing a
// review-fix commit that way is the correctness half of the plan-2644 incident.
function restorePrepAttachment(wtPath, branch, slug) {
  const D = landDeps();
  // plan 2654 review [6]: DW_FAKE_HEAD_REF_AT_EXIT accepts the SAME vocabulary as
  // DW_FAKE_HEAD_REF — 'detached', or any literal ref name — so the exit-time WRONG_BRANCH arm is
  // reachable under --dry-run too. The old `=== 'detached'` ternary silently mapped every other
  // value to "still correctly attached", making that arm both untestable and invisible.
  // gpt-review 2940 [d54989]: shares `fakeHeadRef` with the stamp seam — one decoder, so the
  // 'unreadable' arm can never again set its diagnostic in one copy and not the other.
  const headRef = D.env.DRY
    ? D.spine.fakeHeadRef('DW_FAKE_HEAD_REF_AT_EXIT', branch)
    : D.spine.worktreeHeadRef(wtPath, branch);
  if (headRef === `refs/heads/${branch}`) return; // still attached — the normal path, silent
  if (headRef === D.spine.WORKTREE_HEAD_UNREADABLE) {
    console.error(
      `done-worktree --prep: cannot read which ref ${slug}'s worktree HEAD is attached to at exit ` +
        `(${D.spine.lastHeadRefErrorText()}) — NOT touching it. plan 2654.`,
    );
    return;
  }
  if (headRef !== null) {
    // Attached, but to the WRONG branch. Never `checkout` out of it: another session may be using
    // this tree for that branch, and the commits it holds are not ours to move.
    console.error(
      `done-worktree --prep: ${slug}'s worktree exited attached to ` +
        `"${String(headRef).replace(/^refs\/heads\//, '')}", not "${branch}" — NOT re-attaching, ` +
        `since something outside this prep switched it and may be mid-work. Check ` +
        `\`git -C "${wtPath}" status\` before touching it. plan 2654.`,
    );
    return;
  }

  // A rebase/merge in flight IS a detached HEAD by construction, and the conflict arm leaves that
  // state DELIBERATELY for a session to resolve (see the rebase-CONFLICT seam). Checking out the
  // branch here would destroy the conflict a human is about to fix.
  if (!D.env.DRY && worktreeMutationInProgress(wtPath)) {
    console.error(
      `done-worktree --prep: ${slug}'s worktree is left mid-rebase/merge (detached by ` +
        `construction) — NOT re-attaching, that state is deliberate. Resolve it in the worktree ` +
        `(\`git -C "${wtPath}" rebase --abort\` to discard), then the next prep runs normally.`,
    );
    return;
  }

  let headSha = null;
  let branchSha = null;
  let shaReadError = null;
  if (D.env.DRY) {
    branchSha = process.env.DW_FAKE_BRANCH_TIP || null;
    headSha = process.env.DW_FAKE_DETACHED_SHA || branchSha;
  } else {
    try {
      // plan 2654 review [13]: ONE spawn. `rev-parse A B` prints both shas, one per line — two
      // sequential spawns paid a second process for nothing (and this runs in a finally, on a
      // machine that routinely has several sessions' git children in flight).
      [headSha, branchSha] = D.spawn
        .run('git', ['-C', wtPath, 'rev-parse', 'HEAD', `refs/heads/${branch}`])
        .trim()
        .split('\n')
        .map((s) => s.trim());
    } catch (e) {
      // plan 2654 review [5]: KEEP the reason. The report below can only say '(unreadable)', which
      // leaves the operator unable to tell benign divergence from "this worktree is gone".
      shaReadError = e?.message || String(e);
    }
  }

  const contained =
    Boolean(headSha) && (headSha === branchSha || isAncestor(wtPath, headSha, branchSha));
  if (contained) {
    try {
      if (!D.env.DRY) D.spawn.run('git', ['-C', wtPath, 'checkout', branch]);
      console.error(
        `done-worktree --prep: ${slug}'s worktree exited DETACHED at ${headSha.slice(0, 9)} — ` +
          `re-attached it to ${branch}, which already contains that commit, so nothing was lost. ` +
          `plan 2654 invariant.`,
      );
      return;
    } catch (e) {
      console.error(
        `done-worktree --prep: ${slug}'s worktree exited DETACHED at ${headSha.slice(0, 9)} and ` +
          `re-attaching to ${branch} FAILED (${e.message || e}) — fix by hand: ` +
          `\`git -C "${wtPath}" checkout ${branch}\`.`,
      );
      return;
    }
  }

  const unreadable = shaReadError ? `(unreadable: ${shaReadError})` : '(unreadable)';
  console.error(
    `done-worktree --prep: ${slug}'s worktree exited DETACHED at ` +
      `${headSha ? headSha.slice(0, 9) : unreadable} while refs/heads/${branch} is at ` +
      `${branchSha ? branchSha.slice(0, 9) : unreadable} — they DIVERGE (the detached tip is ` +
      `NOT contained in the branch, so it carries commits the branch does not). NOT ` +
      `auto-attaching: that choice would either ` +
      `abandon those commits or move the branch onto an unreviewed tip (plan 2654). Inspect ` +
      `\`git -C "${wtPath}" log --oneline ${branch}..HEAD\`, then either ` +
      `\`git -C "${wtPath}" checkout ${branch}\` (discard the detached tip) or reset the branch ` +
      `onto it deliberately. Until then every done-worktree call on ${slug} refuses.`,
  );
}

// plan 2463 — see the call site in runLandPrepLocked for why this is unconditional. LOCAL only:
// it never pushes, because the plain prep's own rebase force-pushes moments later. Best-effort by
// construction — if the branch cannot be returned to its plain shape here, the marker is kept so
// the land-time `unstackSpeculativeBase` (which CAN push, and refuses to merge on failure) is the
// one that has to succeed, and the plain prep below simply rebases whatever it finds.
function clearSpeculativeStackForPrep(MAIN, wtPath, branch, slug) {
  const D = landDeps();
  const spec = landSpecMarker.read(MAIN, slug);
  if (!spec) return;
  const branchTip = worktreeHeadSha(wtPath);
  if (!isAncestor(wtPath, spec.specBase, branchTip)) {
    landSpecMarker.clear(MAIN, slug); // the branch already moved off the stack — nothing to undo
    return;
  }
  try {
    D.spine.restoreOffSpeculativeBase(wtPath, branch, spec, branchTip);
  } catch (e) {
    console.error(
      `done-worktree --prep: could not undo ${slug}'s previous speculative stack ` +
        `(${e.message || e}) — leaving the marker for the land-time un-stack to resolve.`,
    );
    return;
  }
  landSpecMarker.clear(MAIN, slug);
  console.log(
    `done-worktree --prep: undid the previous speculative stack for ${slug} (base ` +
      `${spec.specBase.slice(0, 9)}) before re-prepping.`,
  );
}

// plan 2463 — the speculative pass. Runs AFTER the plain prep has rebased the branch onto
// origin/master and stamped its marker, so `plain.baseSha` is the live master tip and the branch is
// linear on top of it. Stacks the branch onto the head slot's branch tip (decision D1), re-runs
// only the gates the head's own diff could have invalidated, publishes (the push is what pays the
// `scripts/hooks/pre-push.sh` battery OFF the head slot), and stamps the speculative marker.
//
// EVERY failure arm restores the plain-prepped tip and returns without a marker: the plain marker
// stays valid, origin still carries the plain tip, and the land behaves exactly as it does today.
// That is the plan's "never block on the speculative pass — it is purely opportunistic".
//
// Returns undefined on all of those arms (the caller keeps its own PREP_EXIT). plan 2940 adds the
// ONE arm that is not opportunistic and does propagate: a detached HEAD at the stamp seam is an
// invariant breach about the whole worktree, not "speculation didn't pan out", so it returns
// PREP_EXIT.DETACHED_STAMP and the caller surfaces it as the prep's exit code.
async function attemptSpeculativeStack(MAIN, wtPath, branch, slug, changed, lock, state, plain) {
  const D = landDeps();
  const view = speculationQueueView(slug);
  if (!view) return;
  const headSlug = view.head;
  const headBranch = headSlug && headSlug !== slug ? `worktree-${headSlug}` : null;
  if (headBranch && !D.env.DRY) {
    try {
      D.spawn.run('git', ['-C', wtPath, 'fetch', 'origin', headBranch]);
    } catch {
      return; // the head's branch is unreachable (deleted mid-land, network) — no speculation
    }
  }
  const headBranchTip = headBranch ? D.spine.remoteTrackingTip(wtPath, headBranch) : null;
  if (
    !D.L.shouldSpeculate({
      position: view.position,
      headSlug,
      ownSlug: slug,
      headBranchTip,
      masterTip: plain.baseSha,
      headContainsMaster: isAncestor(wtPath, plain.baseSha, headBranchTip),
    })
  )
    return;

  // plan 507: a MERGE-BEARING branch is deliberately synced by a final freshen-merge, never a
  // linearizing replay, precisely so its author's prior conflict resolutions are not re-fought.
  // `rebase --onto` is exactly that replay, so speculation declines rather than flattening it.
  if (!D.env.DRY) {
    let merges = '';
    try {
      merges = D.spawn
        .run('git', ['-C', wtPath, 'rev-list', '--merges', 'origin/master..HEAD'])
        .trim();
    } catch {
      return; // cannot prove it is linear → do not speculate
    }
    if (merges) {
      console.log(
        `done-worktree --prep: ${slug} is merge-bearing (plan 507) — skipping speculative ` +
          `stacking, which would linearize it. The plain-master prep stands.`,
      );
      return;
    }
  }

  const preSpecBranchSha = worktreeHeadSha(wtPath);
  // plan 3503 gpt-review round 2 (fe75fd/f6d4d8/82ea78): speculative greens live only here until
  // the exact-tree marker is stamped. Every abandon/throw/lock-loss arm drops this Map naturally;
  // unlike the deleted rollback design, no stale process ever needs a sidecar write to undo them.
  const speculativeProofBuffer = new Map();
  // plan 3503 gpt-review round 3 (cluster 4): `restore()` REPORTS what it did. Its silent return
  // could not be told apart from a completed rollback, so a process that had LOST the worktree lock
  // fell through to an ordinary "speculation did not pan out" success — and `runLandPrep`'s finally,
  // which skips the attachment heal only on BUSY, then reattached a worktree a successor owned.
  // Three outcomes, because two of them are not the same refusal:
  //   * LOCK_LOST — we no longer own the tree. BUSY dominates (the established rule in this file):
  //     the caller must return PREP_EXIT.BUSY so the finally touches nothing.
  //   * NOT_OURS — we still hold the lock, but HEAD is attached elsewhere / unreadable, so a
  //     `reset --hard` would move a ref that is not ours. The heal IS legitimate here (it is exactly
  //     the invariant restorePrepAttachment exists for), so this stays an ordinary abandon.
  //   * DONE — rolled back, or the best-effort reset failed with the land-time un-stack as backstop.
  const RESTORE_DONE = 'restored';
  const RESTORE_LOCK_LOST = 'lock-lost';
  const RESTORE_NOT_OURS = 'not-ours';
  const restore = () => {
    // gpt-review 2940 round 2 [c7044f/c4a65e/bead3c/f02d76]: `reset --hard` moves whatever ref HEAD
    // points at. Every arm below calls this on a failure, and the failures that matter most are
    // exactly the ones where HEAD may no longer be OUR branch — so prove attachment before moving
    // anything, or a rollback meant to undo our speculation rewinds another session's branch
    // instead. See speculativeRollbackAllowed.
    // Re-prove ownership before touching the branch. Speculative proofs are still memory-only here,
    // so a lost lock drops them without attempting a successor-owned sidecar write (plan 3503 R2).
    // gpt-review 2940 round 3 [b2cabd/c75569]: attachment is necessary but not sufficient. A
    // SUCCESSOR prep that took this worktree after our lock was reaped is attached to the very same
    // branch ref, so the check above cannot see it — and `reset --hard preSpecBranchSha` would then
    // rewind ITS commits. Ownership is the question the lock answers, so ask the lock.
    if (!renewOrAbort(lock, slug, 'before rolling back the speculative stack')) {
      console.error(
        `done-worktree --prep: NOT rolling ${slug}'s speculative stack back — this process no ` +
          `longer owns the worktree lock, so another writer is on this tree and the reset would ` +
          `rewind ITS work (plan 2940).`,
      );
      return RESTORE_LOCK_LOST;
    }
    const rollbackHeadRef = D.spine.worktreeHeadRef(wtPath, branch);
    if (!D.L.speculativeRollbackAllowed(rollbackHeadRef, branch)) {
      // gpt-review 2940 round 4 [909092/a6cca3]: name the state. The predicate refuses TWO inputs
      // and they want different recoveries — a foreign branch is someone else's work, an unreadable
      // ref is an unknown we must not guess at (the distinction worktreeHeadRef's own sentinel
      // exists to carry, and that this message flattened).
      console.error(
        `done-worktree --prep: NOT rolling ${slug}'s speculative stack back to ` +
          `${preSpecBranchSha.slice(0, 9)} — ` +
          (rollbackHeadRef === D.spine.WORKTREE_HEAD_UNREADABLE
            ? `its worktree HEAD ref is UNREADABLE (${D.spine.lastHeadRefErrorText()}), so we cannot show what ` +
              `\`reset --hard\` would move`
            : `its worktree HEAD is attached to ` +
              `"${String(rollbackHeadRef).replace(/^refs\/heads\//, '')}", not "${branch}", so ` +
              `\`reset --hard\` would move a branch that is not ours`) +
          `. Left as-is; the land-time un-stack and the foreignStackedBranch backstop cover the ` +
          `local residue (plan 2940).`,
      );
      return RESTORE_NOT_OURS;
    }
    try {
      D.spawn.run('git', ['-C', wtPath, 'reset', '--hard', preSpecBranchSha]);
    } catch {
      /* best-effort — the land-time un-stack is the hard guard, and no marker was stamped */
    }
    return RESTORE_DONE;
  };

  // gpt-review 2940 round 3 [b7b07b/6d73d3/7b334b]: ONE exit for every speculative attachment
  // refusal, because the three of them must agree on two things the first cut got inconsistent.
  //   * BUSY DOMINATES. runLandPrep's finally skips the attachment heal only on BUSY, so returning
  //     DETACHED_STAMP while the lock has actually been reaped sends restorePrepAttachment into a
  //     worktree another process now owns. It also stops us clearing a SUCCESSOR's marker, which is
  //     no longer ours to clear. Ask the lock first, every time — the post-rebase check in the
  //     plain path already did, and these did not.
  //   * Both markers are cleared, never one. Once something has moved HEAD off the branch mid-pass,
  //     the plain marker's own branchSha — read from that same HEAD moments earlier — cannot be
  //     attributed either.
  // `rollback` is the arm-specific `restore` (or null once the branch is already published).
  const refuseSpeculativeStamp = (rollback) => {
    if (!renewOrAbort(lock, slug, 'at a speculative attachment refusal')) return D.L.PREP_EXIT.BUSY;
    // plan 3503 gpt-review round 3 (cluster 4): the rollback re-proves ownership of its own, and the
    // window between the renewal above and that re-proof is real. A lock lost inside it means the
    // two marker clears below are no longer ours to make — BUSY dominates, exactly as it does for
    // the renewal on the line above.
    if (rollback && rollback() === RESTORE_LOCK_LOST) return D.L.PREP_EXIT.BUSY;
    // A RESTORE_NOT_OURS rollback (HEAD attached elsewhere / unreadable, lock still ours) falls
    // through to the two clears BY DESIGN, and that is deliberate rather than an oversight: this
    // seam fires precisely because something detached this tree mid-pass, which is the state that
    // makes the plain marker's own branchSha — read from that same HEAD moments earlier —
    // unattributable. Clearing both is the only claim still defensible; a rollback that could not
    // move the branch does not make the stale markers any more trustworthy. The lock is still ours,
    // so these clears are ours to make (the LOCK_LOST arm above is the case where they are not).
    landSpecMarker.clear(MAIN, slug);
    landPrepMarker.clear(MAIN, slug);
    return D.L.PREP_EXIT.DETACHED_STAMP;
  };

  // Replay our own commits (everything in origin/master..HEAD — the plain rebase above guarantees
  // that is exactly ours) onto the head's tip. A conflict here is a legitimate "cannot speculate":
  // our diff and the head's genuinely disagree, and resolving it is session judgment work that the
  // detached prep must never attempt (the same rule the plain prep's conflict arm follows).
  try {
    D.spawn.run('git', ['-C', wtPath, 'rebase', '--onto', headBranchTip, 'origin/master']);
  } catch (e) {
    try {
      D.spawn.run('git', ['-C', wtPath, 'rebase', '--abort']);
    } catch {
      /* nothing to abort */
    }
    const rolled = restore();
    console.error(
      `done-worktree --prep: speculative stack for ${slug} onto ${headSlug} CONFLICTS ` +
        `(${e.message || e}) — keeping the plain-master prep. It re-surfaces at head as usual.`,
    );
    // plan 3503 gpt-review round 3 (cluster 4): a rollback refused for LOST OWNERSHIP is not an
    // ordinary abandon — reporting prep success here lets the finally heal a successor's worktree.
    if (rolled === RESTORE_LOCK_LOST) return D.L.PREP_EXIT.BUSY;
    return;
  }

  // gpt-review 2940 [e81a37/63df6d]: the speculative `rebase --onto` is a SECOND, independent way
  // to strand HEAD, and everything below it is expensive or externally visible — the speculative
  // gate battery, then a `push --force-with-lease` that publishes `refs/heads/<branch>`. That push
  // is the one that matters: from a detached HEAD it pushes the BRANCH ref, so a branch pointing at
  // an ungated tip would reach origin BEFORE the stamp seam refuses to certify anything. Assert
  // here, before either. `restore()` first, so a refusal leaves the plain-prepped tip in place
  // exactly as every other speculative failure arm does.
  // gpt-review 2940 round 3 [429381/dec6c9]: read the stacked tip ONCE and reuse it for every
  // refusal diagnostic below. It is only ever used to NAME the sha in a message, so a re-read per
  // check bought nothing and spent a synchronous `rev-parse` on the queue-head hot path — and the
  // one immediately before the publish could itself throw on a worktree that had gone away, after
  // the force-push had already happened.
  const specTip = worktreeHeadSha(wtPath);
  const postSpecRebaseRef = D.spine.assertStampAttachment(
    wtPath,
    branch,
    slug,
    'SPECULATIVE land-prep',
    specTip,
    {
      phase: 'post-rebase',
    },
  );
  if (!postSpecRebaseRef) return refuseSpeculativeStamp(restore);

  // Re-run only what the head's OWN diff could have invalidated, carrying the plain pass's greens
  // forward — the same landed-delta cap the plain re-prep uses, with the head's not-yet-landed
  // delta standing in for a landed sibling's.
  const specDelta = D.spine.gitDeltaFiles(wtPath, plain.baseSha, headBranchTip);
  // A lost lock propagates out of runPrepGates as WorktreeLockLost and is deliberately NOT
  // `restore()`d — it means another process owns this worktree, so a `reset --hard` here would be
  // the two-writers corruption the lock exists to prevent. It throws exactly as the plain path
  // does; `runLandPrep` converts it to PREP_EXIT.BUSY. The branch is still only stacked LOCALLY at
  // this point (the publish is below), so origin keeps the plain tip and the land-time backstop
  // covers the local residue. `stopOnFail` because speculation is opportunistic: the first red
  // ends the attempt rather than paying for the remaining gates on a tree we are abandoning.
  const spec = await runPrepGates({
    state,
    wtPath,
    changed,
    delta: specDelta,
    hasPriorForCap: specDelta !== null,
    priorGateResults: plain.gateResults,
    lock,
    slug,
    label: 'speculative',
    stopOnFail: true,
    proofBuffer: speculativeProofBuffer,
    // plan 3274 (review round, F1/CONFIRMED): a CHUNKED gate here is out of budget, not broken —
    // say so, rather than reporting "FAILED" for the same partial-progress outcome the land-path
    // preflight's own per-gate CHUNKED/NON-CONVERGENT seams already distinguish. This pass never
    // surfaces an exit code either way (speculation is opportunistic — see the header above), so
    // the fix here is purely about not misleading whoever reads the log.
    // plan 3374: the third narration, same reasoning as the plain pass's own. This pass surfaces no
    // exit code either way (speculation is opportunistic), so the fix here is purely about the log
    // not claiming "out of budget this attempt" for a gate that will never converge.
    onGateFail: (key, detail, { chunked, nonConvergent } = {}) =>
      console.error(
        nonConvergent
          ? `done-worktree --prep: ${key} gate NON-CONVERGENT against ${slug}'s speculative stack ` +
              `on ${headSlug} — ZERO new files for ${D.batteryLedger.NON_CONVERGENT_ROUNDS} consecutive chunk-` +
              `capped rounds, so further attempts cannot help — ${detail}. Keeping the plain-` +
              `master prep.`
          : chunked
            ? `done-worktree --prep: ${key} gate CHUNKED (not failed) against ${slug}'s speculative ` +
              `stack on ${headSlug} — out of cloud-chunk budget this attempt, not a real break — ` +
              `${detail}. Keeping the plain-master prep.`
            : `done-worktree --prep: ${key} gate FAILED against ${slug}'s speculative stack on ` +
              `${headSlug} — ${detail}. Keeping the plain-master prep.`,
      ),
  });
  const gateResults = spec.gateResults;
  if (!spec.ok) {
    // plan 3503 gpt-review round 3 (cluster 4): the arm the finding names. A gate red whose
    // rollback was refused because the worktree lock is GONE must not return ordinary prep success:
    // `runLandPrep`'s finally skips the attachment heal only on PREP_EXIT.BUSY, so anything else
    // here lets a process that no longer owns this tree reattach a successor's worktree.
    if (restore() === RESTORE_LOCK_LOST) return D.L.PREP_EXIT.BUSY;
    return;
  }

  // gpt-review 2940 round 2 [d632d0]: the gates above run git in this worktree for minutes, so the
  // post-rebase assert is no longer current by the time we publish. This push is the LAST point at
  // which a wrong-ref state is still private: from a detached HEAD `push … origin <branch>` pushes
  // refs/heads/<branch>, so an ungated tip would reach origin and the stamp refusal below could not
  // take it back. Assert once more, immediately before the only externally-visible write.
  const prePublishRef = D.spine.assertStampAttachment(
    wtPath,
    branch,
    slug,
    'SPECULATIVE land-prep',
    specTip,
    {
      phase: 'pre-publish',
    },
  );
  if (!prePublishRef) return refuseSpeculativeStamp(restore);

  // Publish. This push runs the full `scripts/hooks/pre-push.sh` battery against the tree that will actually
  // land — the single thing that makes the head-time fast path honest rather than a gate skip.
  try {
    D.spawn.run('git', ['-C', wtPath, 'push', '--force-with-lease', 'origin', branch]);
  } catch (e) {
    // review [3]: a rejected --force-with-lease means origin/<branch> moved under us, so restoring
    // the local tip is only half the job — local and origin must be RECONCILED, or a later step
    // that trusts the local tip acts on a branch state origin does not share (and a subsequent
    // lease, once refreshed, could overwrite whoever legitimately moved it). Re-fetch and report
    // the divergence explicitly rather than leaving it silent.
    const rolled = restore();
    let remote = null;
    try {
      D.spawn.run('git', ['-C', wtPath, 'fetch', 'origin', branch]);
      remote = D.spine.remoteTrackingTip(wtPath, branch);
    } catch {
      /* leave `remote` null — the warning below says so rather than claiming agreement */
    }
    console.error(
      `done-worktree --prep: publishing ${slug}'s speculative stack was REJECTED ` +
        `(${e.message || e}) — restored the local tip to ${preSpecBranchSha.slice(0, 9)}; no ` +
        `speculative marker stamped. origin/${branch} is now ` +
        `${remote ? remote.slice(0, 9) : 'UNREADABLE'}` +
        (remote && remote !== preSpecBranchSha
          ? ` — which DIVERGES from the restored local tip; the next land rebases onto it as usual.`
          : `.`),
    );
    // plan 3503 gpt-review round 3 (cluster 4): same rule as the conflict arm above — a rollback
    // refused for lost ownership is BUSY, never success.
    if (rolled === RESTORE_LOCK_LOST) return D.L.PREP_EXIT.BUSY;
    return;
  }

  const branchSha = prepMarkerStampSha(wtPath);
  // plan 3503 gpt-review round 2 (182771): the push/stamp window cannot rename an ungated commit
  // into a proof. Do not stamp a degraded marker and do not flush the buffer; the ordinary land
  // path will un-stack/re-run its gates, while prep itself keeps its normal successful outcome.
  if (branchSha !== spec.gatedSha) {
    console.log(
      `done-worktree --prep: NOT stamping SPECULATIVE land-prep for ${slug} because the marker tip ` +
        `${branchSha.slice(0, 9)} differs from the gated tip ${spec.gatedSha.slice(0, 9)}; a prep ` +
        `proof only covers the exact tree its gates ran on (plan 3503 gpt-review round 2).`,
    );
    return;
  }
  // plan 3503 gpt-review round 3 (cluster 3): the speculative twin of the plain stamp's env
  // refusal. Same reasoning, same outcome — no marker, no buffer flush, prep's own exit unchanged.
  // plan 3961 T3.5b: landRegistries() memoizes per (MAIN, wtPath) — runPrepGates above already
  // built this exact registry for this pass, so this is a cache hit, not a second build.
  const specEnvDrift = prepGateEnvDrift(
    await D.spine.landRegistries(MAIN, wtPath),
    wtPath,
    gateResults,
    spec.gateEnvProven,
  );
  if (specEnvDrift) {
    console.log(
      `done-worktree --prep: NOT stamping SPECULATIVE land-prep for ${slug} because an untracked ` +
        `input of the ${specEnvDrift.key} gate ` +
        `(${gateEnvUncacheableFiles(specEnvDrift.cacheGate).join(', ')}) changed after it was ` +
        `proven (${shortEnvHash(specEnvDrift.provenUnder)} -> ${shortEnvHash(specEnvDrift.now)}); ` +
        `the marker has no environment dimension, so no marker at all is the honest outcome ` +
        `(plan 3503 gpt-review round 3).`,
    );
    return;
  }
  // plan 2940: the speculative stamp seam — the same assert as the plain writer, because this
  // path's own `rebase --onto` is a second, independent way to strand HEAD, and the gates above
  // ran on whatever tree it left. Refusing here clears the PLAIN marker too, which the plain
  // writer stamped moments ago: it certifies a `branchSha` read from the same HEAD, and once we
  // know something detached this tree mid-pass we can no longer say which sha that read returned
  // (the force-push above pushes refs/heads/<branch>, so a detached HEAD means even origin and the
  // local branch may disagree). Clearing both is the only claim still defensible; the cost is one
  // full battery at head, the alternative is certifying a tree nobody gated.
  const specStampRef = D.spine.assertStampAttachment(
    wtPath,
    branch,
    slug,
    'SPECULATIVE land-prep',
    branchSha,
  );
  // no `restore()` here: the branch is already PUBLISHED at this point, so rolling the local tip
  // back would only put local and origin out of step. The land-time un-stack owns that reconcile.
  if (!specStampRef) return refuseSpeculativeStamp(null);
  landSpecMarker.write(MAIN, slug, {
    baseSha: plain.baseSha,
    specBase: headBranchTip,
    headSlug,
    preSpecBranchSha,
    branchSha,
    branchRef: specStampRef, // plan 2940 — see the plain writer
    gateResults,
    ts: D.spine.nowIso(),
  });
  // plan 3503 gpt-review round 2 (fe75fd/f6d4d8/82ea78): flush only after the exact-tree marker
  // exists and ownership has just been re-proven. A refusal returns BUSY and drops the still-local
  // buffer; it never attempts the rollback write that the lost lock forbids.
  if (!renewOrAbort(lock, slug, 'after stamping speculative land-prep, before proof flush')) {
    return D.L.PREP_EXIT.BUSY;
  }
  flushLandGateProofBuffer(state, wtPath, speculativeProofBuffer);
  // NOT repinned here, deliberately — unlike the plain rebase. `record-review repin` proves a pure
  // re-sha by patch-id against merge-base(HEAD, origin/master), and while the head is still
  // UNLANDED this branch's diff vs master legitimately includes the head's whole diff, so the proof
  // must fail. Repinning is done at head instead (where origin/master HAS absorbed the head, making
  // the diff ours alone and the proof exact); attempting it here would only log a spurious refusal.
  console.log(
    `done-worktree --prep: stamped SPECULATIVE land-prep for ${slug} (plan 2463) — stacked on ` +
      `${headSlug}'s branch ${headBranchTip.slice(0, 9)} over master ${plain.baseSha.slice(0, 9)}, ` +
      `branch ${branchSha.slice(0, 9)}, gates ${JSON.stringify(gateResults)}. If that head lands ` +
      `cleanly this land skips the head-time rebase + battery entirely.`,
  );
}

async function runLandPrepLocked(MAIN, wtPath, branch, slug, changed, lock, state) {
  const D = landDeps();
  if (!D.env.DRY) {
    try {
      D.spawn.run('git', ['-C', wtPath, 'fetch', 'origin', 'master']);
    } catch (e) {
      console.error(`done-worktree --prep: fetch failed for ${slug} — ${e.message || e}`);
      return D.L.PREP_EXIT.ERROR;
    }
  }

  // plan 2654 guardrail 1 (PRIMARY): assert HEAD is attached to worktree-<slug> BEFORE the first
  // git WRITE of the prep. Placed above clearSpeculativeStackForPrep rather than immediately above
  // tryRebase, because the speculative undo (`reset --hard` / `rebase --onto`) and the idempotent
  // fast-skip's attemptSpeculativeStack both mutate the tree too — all three are cwd-scoped and so
  // all three would move a detached HEAD instead of the branch. One check here dominates all of
  // them, and nothing above this line has written anything, so aborting leaves the tree exactly as
  // found. A `fetch` is the only thing that ran, and it touches no worktree state.
  //
  // This is a belt to resolveWorktree's braces: that refusal already covers a tree detached before
  // the process started, but the prep child re-resolves in its own process, so an attachment lost
  // BETWEEN resolution and here (a crashed sibling, a session's manual checkout) still lands on
  // this check.
  const attach = D.spine.attachmentRefusal(wtPath, branch, slug, 'prep');
  if (attach) {
    console.error(attach);
    return D.L.PREP_EXIT.ERROR;
  }

  // plan 2463: a prep round always starts from the PLAIN branch. A stack the PREVIOUS round left
  // is anchored to a head slot that may since have landed, failed out, or been replaced, so
  // re-prepping on top of it would replay another plan's commits (or stack a second time). Undo it
  // LOCALLY only — the plain pass below force-pushes, so a separate publish here would just pay the
  // gate battery twice — and drop the marker; speculation is re-established at the end of this pass
  // if it still applies. Deliberately unconditional, unlike the land-time `unstackSpeculativeBase`:
  // there, a stack whose base HAS landed is legitimate and must be preserved for the fast path;
  // here it is stale by definition, because this pass is about to re-anchor everything anyway.
  clearSpeculativeStackForPrep(MAIN, wtPath, branch, slug);

  // gpt-review 2940 round 2 [5847d3/b309ef]: the fetch above is guarded, this read was not. A
  // `rev-parse origin/master` that fails on its own (ref churn under a concurrent gc/repack on this
  // shared `.git`) threw straight out of runLandPrep — which only catches WorktreeLockLost — so
  // `--prep` died on an uncaught exception instead of the named ERROR the watcher classifies and
  // retries. Same fix, same reason, as the fast-path evaluator's.
  let baseSha;
  try {
    baseSha = originMasterTip(wtPath);
  } catch (e) {
    console.error(
      `done-worktree --prep: cannot resolve origin/master for ${slug} after a successful fetch ` +
        `(${e.message || e}) — nothing to prep against. plan 2940.`,
    );
    return D.L.PREP_EXIT.ERROR;
  }
  const prior = landPrepMarker.read(MAIN, slug);
  const branchBefore = worktreeHeadSha(wtPath);

  // idempotent: the marker already covers this exact tip + branch ⇒ no rebase to do. NOT a return
  // (plan 2463): "nothing moved while we wait at position 2" is the single most common prep shape,
  // and it is EXACTLY when speculation is worth attempting — returning here would leave the feature
  // firing only on the rarer poll where master happened to move first.
  // plan 2940: `refs/heads/${branch}` is the 5th argument everywhere landPrepValid is called — the
  // marker must have been read off THIS branch. Safe to assert unconditionally here: guardrail 1
  // above already refused unless HEAD is attached to exactly that ref.
  if (
    D.L.landPrepValid(
      prior,
      baseSha,
      branchBefore,
      changed,
      `refs/heads/${branch}`,
      prepGatePredicates(await D.spine.landRegistries(MAIN, wtPath)),
    )
  ) {
    console.log(
      `done-worktree --prep: land-prep already current for ${slug} (base ${baseSha.slice(0, 9)}) — no rebase needed.`,
    );
    const specOutcome = await attemptSpeculativeStack(
      MAIN,
      wtPath,
      branch,
      slug,
      changed,
      lock,
      state,
      {
        baseSha,
        gateResults: prior.gateResults || {},
      },
    );
    return specOutcome ?? D.L.PREP_EXIT.OK;
  }

  // rebase onto origin/master (rerere auto-resolves known conflicts; tryRebase force-pushes the
  // branch on success — already the spine's post-rebase behavior, plan 355/502).
  const reb = tryRebase(wtPath, branch);
  D.spine.tallyLockRetry(MAIN, slug, reb); // plan 3974 T2c — this IS the path plan 3941's evidence log fired on
  const cs = D.L.rebaseSeam(reb);
  if (cs) {
    // a genuinely-new conflict the DETACHED driver can't resolve — restore a clean branch, drop
    // any stale marker, and surface. The session (woken by the watcher) resolves DURING the wait;
    // otherwise the conflict re-surfaces at head as LAND_BLOCKED_HOLDING (today's behavior).
    if (!D.env.DRY) {
      // plan 3394 (ledger line `keep-hot-prep-rebased-a-worktree-branch-onto-another-plans-branch-tip`).
      // The comment above says "restore a clean branch", and until now nothing checked that it
      // happened: `rebase --abort` is best-effort and its failure was SWALLOWED, so a failed abort
      // left the branch on whatever the interrupted rebase last resolved to and this function
      // returned a plain CONFLICT as if the tree were clean. That is the observed incident's most
      // likely mechanism — plan 3284's branch came out of a conflicted prep sitting on
      // `origin/worktree-3361-…` with 3361's 19 commits underneath its own 6, and NOTHING in the
      // prep or watcher output flagged it; it was caught only because a later land happened to
      // list 25 shas where 6 were expected. Verify the restore, and repair it if the abort did not
      // take.
      //
      // THE LOCK CHECK COMES FIRST, before the abort (gpt-review 3394 round 2, findings 5/6/7/8 —
      // four independent finders, and round 1's placement AFTER the abort was wrong). Round 1
      // reasoned that `rebase --abort` is our own bounded undo, so refusing it would strand a
      // rebase for the next owner. That weighs the wrong two outcomes. If the token is gone the
      // tree ALREADY belongs to another writer, and the abort would reset THEIR working tree —
      // silent cross-writer corruption. The stranded-rebase case is not silent and not ours to
      // fix: `runLandPrep`'s own `worktreeMutationInProgress` guard detects leftover rebase state
      // at entry and returns BUSY rather than proceeding, so the next prep handles it safely. A
      // detected refusal beats an undetected clobber.
      if (!renewOrAbort(lock, slug, 'before recovering the worktree from a conflicted rebase')) {
        return D.L.PREP_EXIT.BUSY;
      }
      try {
        D.spawn.run('git', ['-C', wtPath, 'rebase', '--abort']);
      } catch {
        /* nothing to abort (a merge-bearing freshen leaves a merge, not a rebase, in progress) */
      }
      // AGAIN, after the abort (gpt-review 3394 round 3, findings 1/2/3/4/7 — five finders). The
      // check above gates the abort; this one gates `restorePrepBranchTip`, which is the truly
      // destructive write (`checkout --force -B` moves a branch ref AND discards a working tree).
      // `rebase --abort` on a large tree is not instantaneous, and the lock's age ceiling can pass
      // inside it, so one check cannot cover both. Renewing is cheap; a clobbered sibling is not.
      if (!renewOrAbort(lock, slug, 'before force-restoring the branch tip')) {
        return D.L.PREP_EXIT.BUSY;
      }
      const afterAbort = D.spine.restorePrepBranchTip(wtPath, branch, branchBefore, slug);
      if (afterAbort !== branchBefore) {
        // Two failed restores means this is not a plain conflict any more: the branch ref is
        // somewhere neither we nor the session put it. Returning CONFLICT here would tell the woken
        // session "go resolve the conflict" while the branch silently sits on a foreign base — the
        // exact silence this ledger line is about. ERROR instead, naming both shas.
        console.error(
          `done-worktree --prep: CANNOT RESTORE ${branch} for ${slug} after a conflicted rebase — ` +
            `the branch is at ${String(afterAbort).slice(0, 9)}, not its pre-rebase tip ` +
            `${branchBefore.slice(0, 9)}, and \`git rebase --abort\` did not take. Do NOT push this ` +
            `branch. Restore it by hand (\`git -C <worktree> checkout --force -B ${branch} ` +
            `${branchBefore}\`) and re-check \`git log --oneline origin/master..HEAD\` before landing.`,
        );
        landPrepMarker.clear(MAIN, slug);
        return D.L.PREP_EXIT.ERROR;
      }
    }
    landPrepMarker.clear(MAIN, slug);
    // plan 3080: a graft refusal is NOT a conflict — nothing needs resolving, the branch needs
    // un-grafting, and the recovery recipe is in the seam reason. Saying "rebase CONFLICT" here
    // would send the woken session looking for conflict markers that do not exist. It still exits
    // CONFLICT so the watcher wakes the session exactly as it does for a real conflict.
    console.error(
      reb.graftBlocked
        ? `done-worktree --prep: FOREIGN-COMMIT GRAFT for ${slug} (${cs.code}) — the prep did NOT ` +
            `publish the branch. ${cs.reason}`
        : `done-worktree --prep: rebase CONFLICT for ${slug} (${cs.code}: ${cs.reason}) — keep-hot can't ` +
            `auto-resolve a detached conflict. Resolve in the worktree during the wait, or it surfaces at head.`,
    );
    return D.L.PREP_EXIT.CONFLICT;
  }

  const branchAfter = worktreeHeadSha(wtPath);
  // plan 3394 — POST-REBASE FOREIGN-COMMIT ASSERT (ledger line
  // `keep-hot-prep-rebased-a-worktree-branch-onto-another-plans-branch-tip`).
  //
  // The pre-rebase graft check inside syncBranchOntoMaster (plan 3080) cannot see this shape: it
  // enumerates commits carried by the shared LOCAL master ref, and the observed incident's foreign
  // commits came from `origin/worktree-3361-…` — the ledger entry is explicit that the shared local
  // master never contained them. So the branch came out of a prep with another plan's 19 commits
  // under its own 6 and every command in the path exited 0. The land-time `foreignStackedBranch`
  // scan is the check that DOES see it, and it already runs on exactly this question ("is a live
  // sibling worktree tip sitting in our unlanded history?") — it was simply never asked at prep
  // time, which is where the damage is done and where it is still cheap to refuse. `speculated` is
  // false here: this is the plain prep, before any stacking, so the free local scan is the right
  // one and no network round-trip is added to the keep-hot loop.
  //
  // Refuse without restoring. `branchBefore` is NOT a safe target: in the incident the bad base was
  // laid down by an EARLIER prep on the same slug, so the pre-rebase tip was already grafted and
  // "restoring" would re-bless it. Clear the marker so nothing downstream trusts this tree, and
  // exit CONFLICT — the same exit plan 3080's graft refusal uses, so the watcher wakes the session
  // — with the un-graft recipe rather than conflict-resolution wording.
  const prepForeign = foreignStackedBranch(wtPath, branch, { refresh: true });
  if (prepForeign) {
    // gpt-review 3394 round 2 (findings 3/10): the refresh above is a network round-trip, so renew
    // before the marker write that follows it — same rule as every other phase boundary in this
    // function. A reaped token means another writer owns this slug's marker too.
    if (!renewOrAbort(lock, slug, 'at the prep-time foreign-graft check'))
      return D.L.PREP_EXIT.BUSY;
    landPrepMarker.clear(MAIN, slug);
    console.error(
      `done-worktree --prep: FOREIGN-COMMIT GRAFT for ${slug} — ${branch} descends from ` +
        `${prepForeign}, a sibling worktree branch that origin/master does NOT contain. Landing ` +
        `this would carry that plan's unlanded, unreviewed commits onto master under this plan's ` +
        `merge. The prep did NOT stamp. Un-graft before landing: ` +
        `\`git -C <worktree> rebase --onto origin/master ${prepForeign}\` + force-push, then ` +
        `check \`git log --oneline origin/master..HEAD\` shows only this plan's commits.`,
    );
    return D.L.PREP_EXIT.CONFLICT;
  }
  // gpt-review 2940 [deb8b0]: assert attachment RIGHT HERE, the instant the rebase returns, not
  // only at the stamp seam below. The rebase is what detaches HEAD in the measured incident, and
  // between it and the stamp sit the repin plus the full gate battery — 15-27 minutes of work
  // against a tree that is already known to be uncertifiable. Refusing here spends none of it. The
  // stamp-seam assert STAYS: this one closes the cost, that one closes the invariant (a gate can
  // itself run git in this worktree, and the marker must never be written unchecked).
  const postRebaseRef = D.spine.assertStampAttachment(
    wtPath,
    branch,
    slug,
    'land-prep',
    branchAfter,
    {
      phase: 'post-rebase',
    },
  );
  if (!postRebaseRef) {
    // gpt-review 2940 round 2 [aa5d59]: BUSY dominates. runLandPrep's finally skips the attachment
    // heal only on BUSY, so returning DETACHED_STAMP while the lock has actually been reaped would
    // send restorePrepAttachment into a worktree another process now owns — the two-writers
    // corruption the lock exists to prevent. Ask first; a lost lock is the more urgent truth.
    if (!renewOrAbort(lock, slug, 'at the post-rebase attachment check')) return D.L.PREP_EXIT.BUSY;
    landPrepMarker.clear(MAIN, slug);
    return D.L.PREP_EXIT.DETACHED_STAMP;
  }
  // plan 2473: renew at the phase boundary. No timer could keep this current — `runLandPrep`
  // blocks the event loop inside synchronous git/gate children for minutes at a time — which is
  // exactly why the lock's PRIMARY staleness proof is pid-liveness and the heartbeat is only the
  // ceiling for an alive-but-wedged holder.
  //
  // review 2473 [1]: a REFUSED renewal is not cosmetic — it means our token no longer matches, i.e.
  // we were reaped (age ceiling passed while a gate blocked the loop) and another writer has taken
  // the worktree. Continuing would put two processes on one tree, the precise corruption this whole
  // module prevents. Abort instead; the marker is not stamped, so nothing downstream trusts a tree
  // we no longer own.
  if (!renewOrAbort(lock, slug, 'after the rebase')) return D.L.PREP_EXIT.BUSY;

  // plan 1528 A1: the keep-hot rebase re-sha'd the branch during the WAIT — re-pin the
  // sha-pinned review/wiki markers now (core-noun-ok: the real MARKER_FAMILIES keys; patch-id
  // gate inside record-*/repin) so the
  // head-time land never seams REVIEW_NEEDED / WIKI_CHECKPOINT (core-noun-ok: names the real
  // seams) for pure bookkeeping
  // (the plan-1450 incident's two marker halts). Best-effort: a refusal only means the
  // halt surfaces at head as before.
  if (!D.env.DRY && branchAfter !== branchBefore) repinShaPinnedMarkers(wtPath);

  // re-validate only the heavy gates the LANDED master delta could have invalidated; carry the
  // rest of the prior gateResults forward. The carry-forward cap is sound ONLY when the BRANCH is
  // unchanged since the last prep: a new worktree commit (branchBefore !== prior.branchSha — the
  // worktree-branch push runs NONE of the heavy pre-queue gates, so a gate-breaking commit can land there)
  // changes the tree the gates must validate in a way the master delta can't account for, so we
  // must re-run ALL applicable gates then. A null delta (tip unchanged → only the branch moved, or
  // a compute failure) likewise re-runs all — never trust a carry-forward we can't justify.
  const branchUnchanged = Boolean(prior) && prior.branchSha === branchBefore;
  const landedDelta =
    prior && prior.baseSha !== baseSha
      ? D.spine.gitDeltaFiles(wtPath, prior.baseSha, baseSha)
      : null;
  const hasPriorForCap = branchUnchanged && landedDelta !== null;
  // No `stopOnFail`: the plain pass runs EVERY applicable gate even after a red, so one prep round
  // reports all the breakage the session then fixes during the wait (front-loading, gap #2 below).
  // `narrateCache` because this pass — and only this pass — has always narrated a build-cache hit.
  const {
    ok: gatesOk,
    gateResults,
    gatedSha,
    gateEnvProven,
    chunked: gatesChunked,
    nonConvergent: gatesNonConvergent,
  } = await runPrepGates({
    state,
    wtPath,
    changed,
    delta: landedDelta,
    hasPriorForCap,
    priorGateResults: prior?.gateResults,
    lock,
    slug,
    narrateCache: true,
    // plan 3274 (review round, F1/CONFIRMED): a CHUNKED gate is out-of-budget partial progress,
    // never a real break — say so, matching the land-path preflight's own per-gate CHUNKED
    // wording, instead of the misleading generic "FAILED" this pass used before.
    // plan 3374: three narrations now, not two — a NON-CONVERGENT gate must not read as ordinary
    // "out of budget this attempt" chunking, since the honest summary is the opposite ("more
    // attempts will not help").
    onGateFail: (key, detail, { chunked, nonConvergent } = {}) =>
      console.error(
        nonConvergent
          ? `done-worktree --prep: ${key} gate NON-CONVERGENT after rebase — it has now proven ` +
              `ZERO new files for ${D.batteryLedger.NON_CONVERGENT_ROUNDS} consecutive chunk-capped rounds, so ` +
              `further attempts cannot help; fix the named file and commit — ${detail}`
          : chunked
            ? `done-worktree --prep: ${key} gate CHUNKED (not failed) after rebase — out of cloud-` +
              `chunk budget this attempt, not a real break — ${detail}`
            : `done-worktree --prep: ${key} gate FAILED after rebase — ${detail}`,
      ),
  });
  if (!gatesOk) {
    // a gate broke (or ran out of chunk budget) against the rebased tree — DON'T stamp a fast-path
    // marker either way; surface so it is fixed (or simply re-invoked) during the wait rather than
    // at head (front-loads the outcome, fixing gap #2).
    landPrepMarker.clear(MAIN, slug);
    // plan 3274 (review round, F1/CONFIRMED): distinguish "out of cloud-chunk budget, re-invoke to
    // continue" from "a real gate broke, go fix it" end to end — the same defect the land-path
    // preflight's own per-gate CHUNKED seams exist to fix, just on the --prep exit
    // code rather than a land seam.
    // plan 3374: non-convergence is checked FIRST — it is a strict subset of `gatesChunked`, and
    // reporting it as GATE_CHUNKED would hand the watcher the `retry: true` row that re-arms this
    // same tip on every poll, which is the infinite loop this seam exists to break.
    return gatesNonConvergent
      ? D.L.PREP_EXIT.GATE_NON_CONVERGENT
      : gatesChunked
        ? D.L.PREP_EXIT.GATE_CHUNKED
        : D.L.PREP_EXIT.GATE_FAILED;
  }

  // plan 2940: the stamp seam. Everything above — the rebase, the repin, the multi-minute gate
  // battery — ran cwd-scoped in this worktree, any of which can leave HEAD detached (the rebase
  // that stops mid-replay is the measured shape). Re-assert attachment before recording a verdict
  // ABOUT the branch, and refuse rather than certify a sha the branch may never have reached.
  const markerSha = prepMarkerStampSha(wtPath);
  // plan 3503 gpt-review round 2 (182771): close the last-gate→marker window. The marker's contract
  // is strict-sha, so a new tip gets NO marker rather than a partially-false one; this is not a gate
  // failure and prep exits normally, leaving the land to run its ordinary gates.
  if (markerSha !== gatedSha) {
    console.log(
      `done-worktree --prep: NOT stamping land-prep for ${slug} because the marker tip ` +
        `${markerSha.slice(0, 9)} differs from the gated tip ${gatedSha.slice(0, 9)}; a prep proof ` +
        `only covers the exact tree its gates ran on (plan 3503 gpt-review round 2).`,
    );
    return D.L.PREP_EXIT.OK;
  }
  // plan 3503 gpt-review round 3 (cluster 3): the same window in the ENVIRONMENT dimension. The
  // marker format carries no env hash, so an untracked gate input that moved between the last gate
  // and this stamp can only be answered by NOT stamping — a proof the land re-earns for itself.
  // plan 3961 T3.5b: landRegistries() memoizes per (MAIN, wtPath) — runPrepGates already built
  // this exact registry for this pass, so this is a cache hit, not a second build.
  const envDrift = prepGateEnvDrift(
    await D.spine.landRegistries(MAIN, wtPath),
    wtPath,
    gateResults,
    gateEnvProven,
  );
  if (envDrift) {
    console.log(
      `done-worktree --prep: NOT stamping land-prep for ${slug} because an untracked input of the ` +
        `${envDrift.key} gate (${gateEnvUncacheableFiles(envDrift.cacheGate).join(', ')}) changed ` +
        `after it was proven (${shortEnvHash(envDrift.provenUnder)} -> ${shortEnvHash(envDrift.now)}); ` +
        `the marker has no environment dimension, so no marker at all is the honest outcome ` +
        `(plan 3503 gpt-review round 3).`,
    );
    return D.L.PREP_EXIT.OK;
  }
  const stampRef = D.spine.assertStampAttachment(wtPath, branch, slug, 'land-prep', markerSha);
  if (!stampRef) {
    // gpt-review 2940 round 3 [b7b07b/6d73d3]: BUSY dominates here for the same reason it does at
    // the post-rebase check — the gate battery above runs for minutes, which is exactly the window
    // in which this process can lose the lock, and a DETACHED_STAMP return would then both clear a
    // SUCCESSOR's marker and let the finally heal ITS worktree.
    if (!renewOrAbort(lock, slug, 'at the land-prep stamp seam')) return D.L.PREP_EXIT.BUSY;
    landPrepMarker.clear(MAIN, slug);
    return D.L.PREP_EXIT.DETACHED_STAMP;
  }
  landPrepMarker.write(MAIN, slug, {
    branchSha: markerSha,
    branchRef: stampRef, // plan 2940: which ref branchSha was read from — the consume side re-checks it
    baseSha,
    gateResults,
    ts: D.spine.nowIso(),
  });
  console.log(
    `done-worktree --prep: stamped land-prep for ${slug} — base ${baseSha.slice(0, 9)}, branch ` +
      `${markerSha.slice(0, 9)}, gates ${JSON.stringify(gateResults)}.`,
  );

  // plan 2463: the plain marker just stamped is anchored to THIS master tip — which the head
  // slot's own land is about to invalidate, which is why it fires ~0% of the time. Now try the
  // speculative pass on top. It never fails the prep: any doubt (not at position 2, the head not
  // yet rebased, a conflict against its tree, a gate red, a rejected push) leaves the plain marker
  // and the plain branch exactly as they are, which is today's behaviour.
  const specOutcome = await attemptSpeculativeStack(
    MAIN,
    wtPath,
    branch,
    slug,
    changed,
    lock,
    state,
    {
      baseSha,
      gateResults,
    },
  );
  return specOutcome ?? D.L.PREP_EXIT.OK;
}
