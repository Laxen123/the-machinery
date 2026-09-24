// scripts/coord/land/queue.mjs — plan 3961 T3.3: the land spine's queue lifecycle, moved out
// of scripts/done-worktree.mjs behaviour-identical (parity proven by
// scripts/coord/land/parity.test.mjs's 12 scenarios against committed goldens, plus the full
// 571-case scripts/done-worktree.test.mjs, both unchanged by this move).
//
// WHAT THIS MODULE OWNS. The landing-queue lifecycle: the FIFO enqueue-and-wait loop
// (queueEnqueueAndGate) and its heartbeat/discovery helpers, the waiter-side auto-recovery
// ladder (demote/steal/overtake/reap, as data in RECOVERY_VERBS + the pure
// recoveryLadderForTick), the speculative background dispatch a waiting land fires while it
// waits (dispatchLandPrep, autoSpawnQueueWatcher), the pre-queue opportunistic freshen
// (preQueueFreshen), the requeue-to-tail / dequeue-for-rework halts and their shared
// land-attempt sidecar (landAttemptPath / readLandAttempt / writeLandAttempt and the
// migration/holding/mark-in-land bookkeeping around them), and the at-head acquisition stamp
// (markHeadAcquired). It is generic — no project-specific vocabulary anywhere in this file.
//
// HOW THIS MODULE REACHES THE REST OF THE WORLD. A non-test module under scripts/coord/ may
// import only scripts/coord/** and node: builtins (Rule 3,
// docs/runbooks/scripts-module-layout.md) — so every one of the plain scripts/*.mjs modules
// this code used to reach directly is instead read off the bound dependency container,
// `landDeps()` (scripts/coord/land/deps.mjs), AT CALL TIME, inside each function — never at
// module top level. `D` (this module's convention: `const D = landDeps();` as the first line of
// every function that needs it) is the same one-letter binding every other
// scripts/coord/land/*.mjs core module uses for the same reason. `chunk-gate.mjs` is a SIBLING
// core module under scripts/coord/land/ (moved there at T2.0a), so `chunkGateConfig` /
// `preQueueFreshenStandDown` are imported from it directly, no container needed.
//
// THE `spine` GROUP. Ten functions this move's cluster calls join `spine` here, none of them
// for the private-state reason T3.1/T3.2's own spine members carry — each is simply a spine-
// resident helper with a call site OUTSIDE this move's cluster too, so it cannot move with it:
// `readResultSidecar` (tryReclaimStrandedLandLock's own caller — the staleness-reclaim status
// read — plus two main() call sites); `nowIso` (a trivial DRY-aware timestamp, but read at two
// unrelated spine sites besides this move's enq()); `logSyncSkipped`, `repinAndReprove`,
// `tryRebase`, `trySkipSync`, and `worktreeMutationKind` (preQueueFreshen's own sync/rebase
// helpers — every one of them is ALSO the at-head rebase's own machinery, called from main()
// well outside this cluster); and `landingBoardSlug` (releaseHeadTenureAfterRequeue's
// board-row-slug resolver, ALSO called by `releaseMutexIfHeld`'s own board-demote and by
// main()'s LANDING stamp). None of these move to a core module: they are added to the container
// so a core module can still call them, at call time, without importing done-worktree.mjs.
//
// Two of those ten LEFT the group again one step later: plan 3961 T3.4b carved
// `preconvergeProbe` and `attemptPreconverge` into queue-probe.mjs together with the private
// `_preconvergeCache` the probe closes over, so queueEnqueueAndGate reaches both as SIBLING
// imports now rather than through the container.
//
// `PREP_LOG_MAX_BYTES` and `SYNC_SITE` are NOT added to any group: they are
// small literal constants dispatchLandPrep/autoSpawnQueueWatcher and preQueueFreshen read
// structurally (by member, never by reference identity), so plan 3961 T3.1's own precedent
// (scripts/gpt-review.mjs ~290) applies — duplicate the literal here with a comment naming the
// spine constant it must stay byte-identical to, rather than thread it through the container.
//
// A MODULE-LEVEL EXCEPTION TO THE `const D` CONVENTION. `RECOVERY_VERBS` is data — a
// module-level `const`, not a function — so there is no enclosing function body for a
// `const D = landDeps();` to live in. Its four `localEligible` predicates call `landDeps()`
// inline instead (`landDeps().landingQueueLib.demoteLocallyEligible(…)` and its three
// siblings); each predicate only actually RUNS at poll time, long after done-worktree.mjs's
// own `bindLandDeps()` call, so the lazy read is exactly as safe as the usual `const D` idiom —
// it just cannot borrow that idiom's name.
//
// EXPORTS. `tryReclaimStrandedLandLock`, `dequeueQueueIfHeld`, `queueHeartbeat`,
// `heartbeatDiscoveredQueueSlot`, `makeQueueHeartbeatStamper`, `markQueueHolding`,
// `preQueueFreshen`, `queueEnqueueAndGate`, `landAttemptPath`, `readLandAttempt`,
// `writeLandAttempt`, `queueStatusView`, `dequeueForRework`, and `requeueOnConflictOrReturn`
// are called by done-worktree.mjs itself (imported back below its own `spine` group). Ten of
// these (`tryReclaimStrandedLandLock`, `dequeueQueueIfHeld`, `queueHeartbeat`,
// `heartbeatDiscoveredQueueSlot`, `markQueueHolding`, `queueEnqueueAndGate`, `preQueueFreshen`,
// `queueStatusView`, `dequeueForRework`, `requeueOnConflictOrReturn`) were NOT exported in the
// spine (plain module-private functions with an external caller elsewhere in the same file);
// `export` is added to each as the one mechanical exception the "byte-identical except…" rule
// below already names. `queueViewShowsRealSlot`, `recentEnqueueAttempt`,
// `RECOVERY_VERBS`, and `recoveryLadderForTick` have NO spine caller of their own — they are
// exported ONLY because scripts/done-worktree.test.mjs imports them directly (a deliberate,
// temporary re-export from done-worktree.mjs; T4 moves those test cases into this module's own
// queue.test.mjs and drops it). `dequeueQueueIfHeld` is ALSO imported directly by
// scripts/coord/land/close-out.mjs (a sibling core module reaching another core module's export
// — no container needed for that reach). Everything else here is module-private.
//
// A PURE MOVE. Every moved function is byte-identical to its done-worktree.mjs original apart
// from the mechanical container-access rewrites (`L.foo(` → `D.L.foo(`, `DRY` → `D.env.DRY`,
// `node(` → `D.spawn.node(`, and so on), the `export` keyword added to the ten functions named
// above, and the `const D = landDeps();` first line every function that needs the container
// gained — no renames, no reordering, no incidental fixes. Every comment moved with its
// function; they carry the plan history that explains the code.

import { existsSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { landDeps } from './deps.mjs';
import { chunkGateConfig, preQueueFreshenStandDown } from './chunk-gate.mjs';
// plan 3961 T3.4: worktreeLockFor moved to head-lock.mjs — a sibling-core-module reach, no
// container needed (it LEFT the `spine` deps-container group with that same move; see deps.mjs's
// own comment).
import { worktreeLockFor } from './head-lock.mjs';
// plan 3961 T3.4b: preconvergeProbe/attemptPreconverge moved to queue-probe.mjs — a
// sibling-core-module reach, no container needed (they LEFT the `spine` deps-container group with
// that same move; see deps.mjs's own comment).
import { preconvergeProbe, attemptPreconverge } from './queue-probe.mjs';
// plan 3961 T3.6: trySkipSync/tryRebase/worktreeMutationKind/logSyncSkipped moved to
// rebase-sync.mjs — a sibling-core-module reach, no container needed (they LEFT the `spine`
// deps-container group with that same move; see deps.mjs's own comment).
import { trySkipSync, tryRebase, worktreeMutationKind, logSyncSkipped } from './rebase-sync.mjs';

// plan 4066 task 0: the member-level container-read manifest for this module — see
// preflight.mjs's own CONTAINER_READS comment for what asserts it and when, and
// container-manifest.mjs's header for the aggregator itself. Generated, not hand-typed;
// regenerate with the same scanner on a real change to this file's container reads.
export const CONTAINER_READS = Object.freeze({
  L: Object.freeze([
    'EXCLUSIVE_LANE',
    'LAND_EVENT_KINDS',
    'PRECONVERGE_POS',
    'REQUEUE_MAX',
    'SEAM',
    'SPECULATIVE_POS',
    'buildPlanIdIndex',
    'conflictTallyTotal',
    'eventKindForReason',
    'freshTallies',
    'isRowAbsentError',
    'landGatesProvenPushEnv',
    'normalizeTallies',
    'parseLockStatusLine',
    'preconvergeConflictNote',
    'preconvergeConflictReason',
    'queueWaitAtHeadReason',
    'queueWaitChunkConflictReason',
    'queueWaitChunkReason',
    'queueWaitReason',
    'rebaseSeam',
    'requeueTrip',
    'requeuedReason',
    'shouldAutoSpawnWatcher',
    'shouldDispatchLandPrep',
    'staleLandLockReclaimable',
  ]),
  buildIndexLib: Object.freeze(['isHighPriorityTier']),
  coordGit: Object.freeze(['coordRetry', 'resolveMain', 'sleepSync']),
  coordMetrics: Object.freeze(['rotateIfOver']),
  env: Object.freeze(['DRY']),
  landLib: Object.freeze(['mutationKnownAbsent']),
  landingLock: Object.freeze(['ageMinutes']),
  landingQueueLib: Object.freeze([
    'DEFAULT_DEMOTE_STALE_MIN',
    'HOLDING_STATE',
    'IN_LAND_STATE',
    'demoteLocallyEligible',
    'overtakeLocallyEligible',
    'reapLocallyEligible',
    'stealLocallyEligible',
  ]),
  landingQueueWatch: Object.freeze(['watcherIsLive']),
  spawn: Object.freeze(['gitEnv', 'node', 'run']),
  spawnDetachedWorktreeChild: Object.freeze(['spawnDetachedWorktreeChild']),
  spine: Object.freeze([
    'coordStep',
    'emitSeam',
    'landingBoardSlug',
    'nowIso',
    'readResultSidecar',
    'repinAndReprove',
    'resolvePlanRelForSlug',
    'stepLog',
  ]),
  worktreeLock: Object.freeze(['worktreeLockIsLive']),
});

// plan 3961 T3.3: duplicated from done-worktree.mjs's own `const PREP_LOG_MAX_BYTES` (that
// spine copy is removed by this same move — dispatchLandPrep/autoSpawnQueueWatcher were its
// only readers) — mirrors the plan 3961 T3.1 precedent at scripts/gpt-review.mjs ~290. MUST
// stay byte-identical to the value a prep log rotates at.
const PREP_LOG_MAX_BYTES = 4 * 1024 * 1024;

// plan 3961 T3.3: duplicated from done-worktree.mjs's own `const SYNC_SITE` — preQueueFreshen
// reads it structurally (`.key`, `.label`; never by reference identity, so a duplicate object is
// safe), but the at-head rebase path (main(), not moving) reads the spine's own copy for its own
// `trySkipSync`/`logSyncSkipped` calls. MUST stay byte-identical to the spine's SYNC_SITE.
const SYNC_SITE = Object.freeze({
  preQueue: { key: 'preQueue', label: 'pre-queue freshen' },
  atHead: { key: 'atHead', label: 'at head' },
});

// plan 665 G4.2: an exclusive-lane landing-lock acquire failed STALE (the CALLER gates on exit 3 — holder
// > stale-min, so NOT a live merge). Before giving up, reclaim it IFF the holder's terminal
// sidecar PROVES its land completed (a recorded mergeSha) on THIS host — the 2026-06-15 strand
// where 643's lock blocked 633 until a manual --force. The decision is the pure
// staleLandLockReclaimable (which documents the STALE precondition that makes the steal safe);
// only the IO (status read, force-release) is here.
export function tryReclaimStrandedLandLock(state) {
  const D = landDeps();
  let statusOut;
  try {
    statusOut = D.spawn.node('landing-lock.mjs', 'status');
  } catch {
    return false;
  }
  // plan 1300: the lock is a scoped multi-holder registry — status prints one
  // line per holder. Reclaim EVERY stranded holder that can be proven done (the
  // pure verdict runs per holder); one successful reclaim is enough to retry.
  let reclaimedAny = false;
  for (const line of String(statusOut).split('\n')) {
    const holder = D.L.parseLockStatusLine(line);
    if (!holder) continue;
    const verdict = D.L.staleLandLockReclaimable({
      holder,
      ourHost: state.host,
      readSidecar: (slug) => D.spine.readResultSidecar(state.main, slug),
      // plan 675: the durable git-state fallback when no sidecar proves completion. A holder slug
      // whose plan now lives in docs/superpowers/plans/archive/<slug>.md has finished its land
      // (close-out / supersede both end the branch). Mirrors closeOut's archive path (archive/<slug>.md).
      isHolderPlanArchived: (slug) =>
        existsSync(
          `${state.main}/docs/superpowers/plans/${D.buildIndexLib.ARCHIVE_FOLDER}/${slug}.md`,
        ),
    });
    if (!verdict.reclaim) continue;
    try {
      D.spawn.node('landing-lock.mjs', 'release', verdict.holderSlug, '--force');
    } catch {
      continue;
    }
    reclaimedAny = true;
    // plan 675: name the proof path so the steal is auditable — the durable archive fallback gets
    // a distinct honest line (no sidecar / no mergeSha to quote), the sidecar path the original.
    if (verdict.via === 'archive') {
      process.stderr.write(
        `done-worktree: reclaimed a stranded landing-lock held by ${verdict.holderSlug} — its plan is ` +
          `archived (land completed) and no terminal sidecar was present (hard kill / crash before the ` +
          `sidecar write). Forced release + retrying acquire.\n`,
      );
    } else {
      process.stderr.write(
        `done-worktree: reclaimed a stranded landing-lock held by ${verdict.holderSlug} — its sidecar proves ` +
          `the land completed (merged ${verdict.mergeSha}) but a detached --wait skipped the lock release. ` +
          `Forced release + retrying acquire.\n`,
      );
    }
  }
  return reclaimedAny;
}

// plan 504: FIFO landing-queue bookkeeping. The slot is released on success and
// on every abort path — but HELD across QUEUE_WAIT (the whole point of queueing)
// and LAND_BLOCKED_HOLDING (hold-through-conflict). Best-effort: a flaky dequeue
// is recorded, never thrown — a dead entry is healed by the staleness steal.
export function dequeueQueueIfHeld(state) {
  const D = landDeps();
  // plan 1528: a requeued-to-tail land MOVED its entry (it must survive the halt) — never
  // dequeue it here. A distinct flag from state.dequeued so the terminal sidecar stays honest.
  if (!state.queued || state.dequeued || state.requeuedToTail) return;
  try {
    // plan 665 G3 / plan 793: retry on a sibling's transient foreign-dirt — in --wait mode AND
    // (via coordStep) unconditionally once the merge has landed, so a post-merge dequeue completes
    // rather than leaving the FIFO head held. The existing catch still swallows a genuine
    // exhaustion (a dead entry is healed by the staleness steal).
    D.spine.coordStep(
      state,
      () => D.spawn.node('landing-queue.mjs', 'dequeue', state.slug),
      `dequeue ${state.slug}`,
    );
    state.dequeued = true;
  } catch (e) {
    (state.teardownErrors ||= []).push(`queue-dequeue: ${e.message || e}`);
  }
}

// review fix (plan 2414): the ONE shared shape every best-effort spine→queue call uses
// (queueHeartbeat, markQueueHolding, markQueueInLand below) — a failed queue-bookkeeping
// call must NEVER block the land, but silently swallowing every failure identically
// hides exactly the class of bug plan 2414's own review caught (a persistent mark-in-land
// failure silently reopening the free-lane demote hole with no distinguishing symptom).
// `label` names what was being stamped, for the one stderr line on failure.
function bestEffortQueueCall(state, args, label) {
  const D = landDeps();
  if (!state.queued) return;
  try {
    D.spawn.node('landing-queue.mjs', ...args);
  } catch (e) {
    D.spine.stepLog(state, `landing queue: ${label} failed (non-fatal): ${e.message || e}`);
  }
}

// Refresh the head's heartbeat-at on spine steps (plan 504): a head silent
// > 45 min is steal-eligible, so each completed step stamps liveness. `pid` (plan
// 2266) is optional — every ordinary liveness call omits it (heartbeatEntry leaves
// an existing pid untouched); only the at-head call site passes THIS process's pid.
// plan 2485: `progress` splits this one call into the two signals the demote gate needs
// apart. `true` — a COMPLETED SPINE STEP, i.e. this land actually moved toward merge —
// additionally stamps the queue entry's progressIso, the only thing that resets the
// convergence clock demoteVerdict now reads. `false` (the default) is liveness ONLY, and is
// what every wait/poll/pre-convergence site must pass: those are the ticks that kept a
// non-converging head looking healthy for hours, and stamping progress from them would
// rebuild the overloaded signal plan 2485 exists to split. Rule of thumb for a new call
// site: "did something finish that gets this branch closer to being merged?" — a rebase, a
// gate battery, a push, taking the head. Waiting for a lock, polling a queue position, or
// probing a merge from position 2 is not progress, however much work the process did.
export function queueHeartbeat(state, pid = undefined, { progress = false } = {}) {
  bestEffortQueueCall(
    state,
    [
      'heartbeat',
      state.slug,
      ...(pid != null ? ['--pid', String(pid)] : []),
      ...(progress ? ['--progress'] : []),
    ],
    'heartbeat',
  );
}

// Pure: does a queueStatusView() result prove this slug already holds a REAL landing-queue
// slot? Factored out so the pre-enqueue-wait discovery below (which the blanket `if (DRY)
// return` at acquireWorktreeBeforePreflight's own top makes otherwise unreachable via the CLI
// dry-run harness) keeps a unit-testable core.
export function queueViewShowsRealSlot(view) {
  return Boolean(view?.mine);
}

// review fix (plan 2505 sonnet-review round 3 [1]): heartbeat a discovered-but-not-owned slot
// through queueHeartbeat itself — the higher-level helper whose default (no pid, no progress)
// arg-building already produces ['heartbeat', state.slug] — instead of hand-duplicating that
// arg array at a second call site (round 2's bestEffortQueueCall-direct version drifted from
// queueHeartbeat the moment a future change, like plan 2485's `progress` flag, touched only
// one of the two). A slot DISCOVERED via queueStatusRawQuery (below) was NOT created by this
// invocation, so heartbeating it must never route through the REAL state.queued — that flag
// doubles as crash-path dequeue OWNERSHIP (dequeueQueueIfHeld, line ~758; also main()'s
// unconditional catch-block release), and flipping it true from mere discovery would make an
// unrelated later throw in THIS process dequeue a slot a prep child is still legitimately
// using. The shallow clone satisfies queueHeartbeat's (via bestEffortQueueCall's) own gate for
// this ONE call without ever mutating the real state.
export function heartbeatDiscoveredQueueSlot(state) {
  queueHeartbeat({ ...state, queued: true });
}

// Bounded discovery retry budget: a query FAILURE (queueStatusRawQuery threw) self-heals
// within a few ticks rather than permanently latching the wait heartbeat-silent for the rest of
// a possibly-unbounded `--wait` prep. A clean result never consumes this budget (see below) —
// it is spent only on genuine transient failures.
const DISCOVERY_ATTEMPT_BUDGET = 3;

// plan 2538: queueStatusRawQuery is NOT a purely-local read — landing-queue.mjs's
// `status` verb goes through readFresh (`git fetch --quiet origin master` then
// `git show origin/master:<queueRel>`, falling back to the local copy only on
// fetch/show failure), so in principle a clean result could race a just-created
// remote entry. Investigation (this plan) found that race is narrower than that: the
// enqueue/reenter subprocess's own coordWrite push is SYNCHRONOUS and is verified
// against origin (assertPushReachedOrigin ls-remotes origin directly — never trusts a
// local success) before it returns, so by the time a PRIOR invocation of the same land
// has actually exited, its slot is provably already on origin — no staleness window.
// The one window that survives is a crash of the invoking process WHILE that
// subprocess is still mid-flight (an orphaned child can outlive a killed parent, and
// coordWrite's freshen/commit/push/verify loop can itself retry for a while under
// contention). recentEnqueueAttempt below detects exactly that narrow case via the
// plan-1528 land-attempt sidecar's `enqueueAttemptedIso` (stamped by `enq()` in
// queueEnqueueAndGate immediately BEFORE the subprocess runs, so it survives a crash
// mid-push) — a SEPARATE small budget (STALE_NEGATIVE_RETRY_BUDGET) retries a clean
// negative ONLY when that signal says a same-slug enqueue attempt is still recent.
// The ordinary "no prior attempt at all" negative never has that signal, so it still
// finalizes on the very first clean query — round 3's efficiency fix stays intact.
const STALE_NEGATIVE_RETRY_BUDGET = 3;

// Comfortably above coordWrite's worst-case attempt loop (up to its own `attempts`
// budget, each round paying a fetch + merge + commit + push + ls-remote verify under
// contention) without reopening round 1's "hammer the shared remote" finding — this
// bound only ever applies to the narrow crash-mid-push case above, never the ordinary
// no-prior-slot case (which has no `enqueueAttemptedIso` signal to match against).
const RECENT_ENQUEUE_ATTEMPT_WINDOW_MS = 3 * 60 * 1000;

// The real "did a PRIOR invocation of THIS SAME land recently start a real enqueue
// that might still be mid-push?" signal — see the plan-2538 comment above. Absent /
// stale / unreadable sidecar all read as false, matching every other land-attempt
// reader's fail-open handling (a lost signal only forgoes the bounded retry, it never
// produces a wrong verdict — the ordinary DISCOVERY_ATTEMPT_BUDGET/definitive-negative
// behavior is exactly what ran before this plan).
export function recentEnqueueAttempt(state) {
  const D = landDeps();
  try {
    const main = state.main || D.coordGit.resolveMain();
    const stampedIso = readLandAttempt(main, state.slug)?.enqueueAttemptedIso;
    if (!stampedIso) return false;
    const ageMs = Date.now() - Date.parse(stampedIso);
    return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= RECENT_ENQUEUE_ATTEMPT_WINDOW_MS;
  } catch {
    return false;
  }
}

// plan 2505: acquireWorktreeBeforePreflight's own state.queued stays false for the WHOLE
// pre-enqueue wait — queueEnqueueAndGate (which flips it true) runs strictly AFTER this
// function returns. A land re-invoked while its own prep child still holds the worktree lock
// already has a REAL slot from a PRIOR invocation, though: queueHeartbeat's bestEffortQueueCall
// gate would silently no-op on state.queued=false, leaving that slot's liveness stamp silent
// for the prep's whole duration (the d7e661baf-class steal-window this plan closes).
//
// Returns a closure over per-invocation discovery state so the CALLER (the wait loop) controls
// exactly when it runs:
// - review fix [0]: discovery does a real query (a blocking `git fetch` in the non-DRY path) —
//   NEVER on a zero-budget plain invocation (budgetMs===0), which plan 2458 protects as a
//   near-instant probe; that path stands down without a heartbeat, same as before this plan.
// - review fix [1]/[3]/round-3[0]: a single CLEAN POSITIVE result is always definitive and
//   ends discovery for the whole invocation immediately. A clean NEGATIVE is definitive too,
//   UNLESS recentEnqueueAttempt(state) says a same-slug enqueue attempt is still recent — plan
//   2538: that narrow case gets a SEPARATE, small bounded retry (STALE_NEGATIVE_RETRY_BUDGET)
//   instead of latching a possibly-stale negative for the rest of a possibly-unbounded `--wait`.
//   The ordinary not-queued-yet case (no recent attempt) is still definitive on the FIRST clean
//   query, so a `--wait` prep-wait never hammers the shared git remote the repo's own
//   queue-discipline rules (plan 1750/1795/2038) exist to avoid.
// - genuine query FAILURES (queueStatusRawQuery threw) spend a THIRD, independent budget
//   (DISCOVERY_ATTEMPT_BUDGET) and gate whether a query is attempted at all this tick — a
//   negative-but-recent retry never counts against it, and exhausting it (repeated failures)
//   stops querying without ever setting `done`, same as before this plan.
// The second arg's four fields default to the real I/O; a test overrides them to prove the
// review-fixed invariants above without a live landing-queue.mjs subprocess or the DRY guard
// that makes the enclosing wait loop itself unreachable from the CLI dry-run harness.
export function makeQueueHeartbeatStamper(
  budgetMs,
  {
    fetchView = queueStatusRawQuery,
    ownedHeartbeat = queueHeartbeat,
    unownedHeartbeat = heartbeatDiscoveredQueueSlot,
    recentAttempt = recentEnqueueAttempt,
  } = {},
) {
  const zeroBudget = budgetMs === 0;
  let queryAttemptsLeft = zeroBudget ? 0 : DISCOVERY_ATTEMPT_BUDGET;
  let staleNegativeAttemptsLeft = zeroBudget ? 0 : STALE_NEGATIVE_RETRY_BUDGET;
  let done = false; // a TRUSTED clean result was obtained — never query again this invocation
  let discovered = false;
  return (state) => {
    // Gated on queryAttemptsLeft ONLY (never staleNegativeAttemptsLeft): a repeated genuine
    // FAILURE must still stop after DISCOVERY_ATTEMPT_BUDGET tries regardless of how much
    // stale-negative budget remains unspent (that budget is only ever consumed by a CLEAN
    // negative result, never by a throw) — see the "repeated query FAILURES are BOUNDED" test.
    if (!done && !state.queued && queryAttemptsLeft > 0) {
      try {
        discovered = queueViewShowsRealSlot(fetchView(state));
        if (discovered) {
          done = true; // a positive is always definitive, immediately
        } else if (staleNegativeAttemptsLeft > 0 && recentAttempt(state)) {
          staleNegativeAttemptsLeft--; // spend the targeted budget, keep querying next tick
        } else {
          done = true; // definitive negative: no recent attempt to race, or that budget is spent
        }
      } catch {
        queryAttemptsLeft--; // only a genuine query FAILURE spends this budget
      }
    }
    if (state.queued) ownedHeartbeat(state);
    else if (discovered) unownedHeartbeat(state);
  };
}

// plan 2275: stamp the queue entry HOLDING at the LAND_BLOCKED_HOLDING seam — the
// cross-PC signal that keys the bounded overtake (a HOLDING head is provably not in
// the merge window: the stamp is written only here, after the merge attempt aborted,
// and cleared only by the resume's position-1-verdicted `mark-holding off`; see the
// landing-queue.mjs header). Best-effort like queueHeartbeat: the seam must never be
// blocked by queue bookkeeping — a failed stamp only means no overtake is possible
// (status quo), never a wrong overtake. The CLI's own head-gate makes a stamp under
// a raced-away head slot refuse harmlessly into the catch.
export function markQueueHolding(state) {
  bestEffortQueueCall(state, ['mark-holding', state.slug, 'on'], 'mark-holding');
}

// plan 2414: stamp the queue entry IN_LAND at head-acquisition — the free-lane
// liveness token demote's IN_LAND immunity keys on (a 🟩 land never sets the 🟢
// LANDING board row `markQueueHolding`'s exclusive-lane sibling relies on, so without this
// the whole free lane was demote-eligible on heartbeat age alone the moment a long
// gate-phase battery outlived the last spine heartbeat — the 2026-07-25 incident).
// Called every time `queueEnqueueAndGate` reaches position 1 — including a resume
// past a cleared HOLDING stamp, which is exactly right: that head is back inside the
// merge window and needs the token re-stamped (mark-holding's own `on` overwrites
// IN_LAND in the same trailing-state column, so the two are naturally mutually
// exclusive with no separate clear needed here). Best-effort like queueHeartbeat /
// markQueueHolding: a failed stamp only means no IN_LAND immunity is available for
// this residency — never a wrong immunity (but IS logged — see bestEffortQueueCall's
// header for why a silent failure here specifically is worse than its siblings').
function markQueueInLand(state) {
  bestEffortQueueCall(state, ['mark-in-land', state.slug], 'mark-in-land');
}

// plan 2275: the resume-side settlement clear — `mark-holding off` REFUSES unless the
// slug is at position 1 on the freshened base, so an overtake that committed first
// turns this into false and the caller re-polls (falling back into the wait path
// instead of merging past a mid-land overtaker). Transient coord failures also return
// false — the caller retries bounded.
function attemptClearHolding(state) {
  const D = landDeps();
  try {
    D.spawn.node('landing-queue.mjs', 'mark-holding', state.slug, 'off');
    return true;
  } catch {
    return false;
  }
}

// plan 1682 / plan 2266: the ONE waiter-side auto-recovery skeleton — demote and the
// mechanical steal are both "run this landing-queue.mjs subcommand against our own slug;
// a refusal (or any transient failure) just means keep waiting; a success means we may be
// head now" (see the call sites in queueEnqueueAndGate for the per-verb gate details this
// deliberately does not re-derive). Extracted so the throttle/try-catch shape can't drift
// between the two verbs (review 1682 [3]'s lesson, applied to this newer pair). Returns
// true only on a taken action — the caller's own `continue` re-polls immediately.
function attemptAutoRecovery(state, { subcommand, successLog }) {
  const D = landDeps();
  try {
    D.spawn.node('landing-queue.mjs', subcommand, state.slug);
  } catch {
    return false; // refused (gate-specific) or transient — keep waiting
  }
  D.spine.stepLog(state, successLog);
  return true;
}

// ── plan 2334: the waiter-side recovery LADDER, as data ────────────────────────────
// attemptAutoRecovery above already shared the dispatch half; each new verb (demote 1682,
// steal 2266, overtake 2275, reap 2331) nonetheless bolted another near-identical
// `if (st.position > 1 && !fake && (wait || chunk || !xAttempted)) { xAttempted = true;
// if (localGate && attemptAutoRecovery(...)) continue; }` block onto the wait loop — the
// FOURTH copy of one throttle-and-gate skeleton, and exactly the anti-pattern this file's
// own demote/steal comment names (review 1682 [3]: twin hand-rolled skeletons on a
// coord-mutex surface are where a fix lands in one verb and stays a hole in the other —
// which is precisely how reap inherited demote's missing local pre-check). The outer
// gating now lives ONCE, here, as a loop over the table below.
//
// Per-row `localEligible` is the verb's LOCAL shortcut: a predicate over this tick's
// already-paid-for `status --json` payload that proves the CLI would only refuse anyway,
// so the spawn (and the `git fetch origin master` inside it) is skipped. Every row's real
// gates stay in the CLI — a refusal here is always harmless, and any input the payload
// does NOT carry must fail OPEN (spawn and let the CLI decide). A row with no
// `localEligible` always spawns.
export const RECOVERY_VERBS = [
  {
    // plan 1682: a stale, NOT-landing head reworking OUTSIDE the spine (the 1674 hog).
    // CLI gates: heartbeat age > DEFAULT_DEMOTE_STALE_MIN, no 🟢 LANDING board row, and the
    // 2-per-24h starvation cap. Only the age gate is payload-knowable (plan 2334 closed the
    // gap reap inherited from this block).
    subcommand: 'demote',
    successLog: 'landing queue: stale not-landing head demoted to the tail (plan 1682)',
    // plan 2485: the head's state + progress stamp ride the pre-check too, or the
    // alive-but-not-converging class is filtered out HERE — one layer above the gate that
    // was just fixed to catch it — because its heartbeat is fresh by definition. A pre-2485
    // payload has neither field; both default to null and the axis abstains, i.e. the
    // pre-check falls back to the heartbeat answer.
    localEligible: ({ st, nowMs }) =>
      landDeps().landingQueueLib.demoteLocallyEligible({
        headHeartbeatIso: st.headHeartbeatIso,
        headState: st.headState ?? null,
        headProgressIso: st.headProgressIso ?? null,
        nowMs,
      }),
  },
  {
    // plan 2266: a head whose recorded {host, pid} proves the holder verifiably gone. No
    // --confirm-holder-gone is ever passed here, so a live/foreign-host/pid-less head is
    // refused harmlessly; the human-asserted steal stays a manual, out-of-band recourse.
    // plan 2280: the cross-host / pid-less refusals are payload-knowable.
    subcommand: 'steal',
    successLog: 'landing queue: dead head mechanically reaped (plan 2266)',
    localEligible: ({ st, host }) =>
      landDeps().landingQueueLib.stealLocallyEligible({
        headHost: st.headHost,
        headPid: st.headPid,
        probingHost: host,
      }),
  },
  {
    // plan 2275: overtake a head parked at LAND_BLOCKED_HOLDING (live + on-spine, so demote
    // refuses on its 🟢 LANDING row and steal refuses while its session works — the designed
    // gap the first two verbs leave). CLI gates: the verdict re-run inside the mutate, the
    // path-disjointness probe, the 2-per-holder/24h cap. Payload-knowable: our own lane must
    // be 🟩 free and the head's state cell must read HOLDING.
    subcommand: 'overtake',
    successLog:
      'landing queue: overtook a parked LAND_BLOCKED_HOLDING head — disjoint 🟩 fast-path (plan 2275)',
    localEligible: ({ st, lane }) =>
      landDeps().landingQueueLib.overtakeLocallyEligible({ lane, headState: st.headState }),
  },
  {
    // plan 2331: a DEAD, not-landing head — the gap the first three leave: demote's
    // starvation cap exhausts on a head that keeps cycling back stale-but-alive-elsewhere,
    // and the mechanical steal can never verify a cross-host/cloud head (no same-host pid to
    // probe) — the 2306 incident shape. CLI gates: heartbeat > DEFAULT_REAP_STALE_MIN, board
    // row not LANDING, queue state not HOLDING, and the arm-then-fire grace (default 10m).
    // Payload-knowable: the HOLDING state cell (the inverse of overtake's own shortcut) and
    // — since plan 2334 — the heartbeat age, so the arm-then-fire grace no longer plays out
    // as a spawn+fetch on EVERY poll tick. The grace itself needs `reapArmedIso`, which the
    // payload does not carry, so an armed-and-waiting head still spawns (a fast, no-write
    // refusal) and the 260s poll cadence composes with the grace window as designed.
    subcommand: 'reap',
    successLog: 'landing queue: dead not-landing head auto-reaped (plan 2331)',
    localEligible: ({ st, nowMs }) =>
      landDeps().landingQueueLib.reapLocallyEligible({
        headState: st.headState,
        headHeartbeatIso: st.headHeartbeatIso,
        nowMs,
      }),
  },
];

// Which recovery verbs this poll tick should consider, in ladder order — pure, so the
// throttle/gate semantics the four hand-rolled blocks encoded are unit-testable rather
// than only observable in a live queue race (the blocks sat behind `!fake`, i.e. outside
// every existing spine test). Returns `[{ subcommand, successLog, eligible }]`; the caller
// spawns the eligible ones and marks ONLY those attempted.
//
// Throttle (review 1682 [2]): the default non-`--wait` invocation stays a near-instant
// position probe — each verb gets ONE attempt per invocation, then the loop falls through
// to the QUEUE_WAIT seam and the watcher owns the long wait. `--wait`/`--wait-chunk` may
// attempt every poll, whose 260s cadence is already the same order as the watcher's own
// 4-min demote-retry throttle.
//
// plan 2334 review [0]: the one-shot is spent on a SPAWN, never on mere consideration. A
// bare invocation is not always single-tick — a successful recovery `continue`s the wait
// loop, so the head can change under us — and the pre-2334 overtake/reap blocks carried
// their state gate INSIDE the `if`, i.e. never burned their flag on a head their shortcut
// ruled out. Marking on consideration would let a verb that was locally ineligible on tick
// 1 (say reap, against a then-HOLDING head) be skipped on tick 2 once that head resumed and
// went stale — reintroducing, in the unification itself, exactly the missed-recovery hole it
// exists to close. Spending on the spawn keeps the bound (one CLI call per verb per
// invocation) while making the flag mean what it says.
export function recoveryLadderForTick({
  st,
  fake = false,
  wait = false,
  chunk = false,
  attempted = new Set(),
  host,
  lane,
  nowMs,
  verbs = RECOVERY_VERBS,
}) {
  // position 1 is head (nothing to recover FROM); a faked queue position drives the
  // spine tests and must never spawn a real coord mutation.
  if (fake || !st || !(st.position > 1)) return [];
  const out = [];
  for (const v of verbs) {
    if (!wait && !chunk && attempted.has(v.subcommand)) continue;
    out.push({
      subcommand: v.subcommand,
      successLog: v.successLog,
      eligible: v.localEligible ? Boolean(v.localEligible({ st, host, lane, nowMs })) : true,
    });
  }
  return out;
}

// Fire ONE detached `done-worktree <slug> --prep` for a land that is WAITING (position ≥ 2).
// This is the dispatch plan 2458 built, reverted, and left to this plan to make safe.
//
// Four things here are deliberate — each was a CONFIRMED review finding on 2458's removed
// prototype, and each recurs in any reimplementation that does not think about it:
//   1. `spawn()` reports ENOENT / bad cwd / EMFILE via an ASYNC `'error'` event, not a
//      synchronous throw — a surrounding try/catch never fires, and an UNHEARD `'error'` event
//      is fatal, killing the whole land process. Hence the listener.
//   2. Run the WORKTREE's own script, not MAIN's. Spawning `scripts/done-worktree.mjs` with
//      `cwd: MAIN` loads MAIN's COMMITTED copy — so for any land whose own diff changes
//      prep/gate logic (2458 was itself such a land, and so is this one) the prep exercises the
//      PRE-diff battery and stamps a marker the at-head check trusts, since the marker proves sha
//      equality, not which code produced it.
//   3. Never `stdio: 'ignore'` — that discards runLandPrep's own rebase/gate diagnostics, so a
//      failed prep is silent. Per-slug log instead.
//   4. Use this file's `gitEnv()` rather than hand-rolling the non-interactive git env.
// Fires at most once per invocation, and never into a worktree someone already holds.
// plan 2551 Layer 3(a) — WHY the seam dump gets a skip reason. The 2026-07-27 incident's exit-18
// seam printed `prepDispatched: false` AND `prepDispatchedSpeculative: false` at a position-2
// poll, and nothing could say WHICH of four structurally different paths produced that: (i) a
// live worktree-lock holder (`lockHeld`, the only arm that logs anything today, at the stepLog
// below); (ii) a missing worktree CLI (`hasCli:false`, done-worktree-lib.mjs shouldDispatchLandPrep
// ~line 1247); (iii) a THROW anywhere from `resolveMain()` on — the whole body is inside the try,
// and its catch writes to console.error, which is NOT part of the seam payload the incident
// preserved; (iv) the call site never being reached at all. Two false booleans, four causes, no
// discriminator — so the same investigation would have to be re-run from scratch next time.
// The booleans stay (they mean "did a dispatch fire"); this records the complementary fact.
// It hangs on `state`, which emitSeam serializes verbatim, so it rides every future seam dump.
function dispatchLandPrep(state, position) {
  const D = landDeps();
  if (D.env.DRY) return;
  const skip = (why) => {
    state.prepDispatchSkip = why;
  };
  try {
    const MAIN = state.main || D.coordGit.resolveMain();
    const lockPath = worktreeLockFor(state.wtPath, state.slug);
    // (2) the WORKTREE's copy, run FROM the worktree.
    const cli = `${state.wtPath}/scripts/done-worktree.mjs`;
    // review 2473 [5]: `worktreeLockIsLive`, NOT a bare presence read. A STALE lock — a crashed
    // prep's leftover, which acquireWorktreeLock reaps on sight — must not read as "busy", or one
    // crashed prep would suppress every future dispatch for this slug until something else
    // happened to reap the file, silently switching the optimization off for good.
    const lockHeld = Boolean(lockPath && D.worktreeLock.worktreeLockIsLive(lockPath));
    // ONE stat, reused by both the gate and the skip reason below (review 2026-07-28): a second
    // `existsSync(cli)` in the reason ternary was a duplicated condition that could drift out of
    // step with what the gate actually decided — in the very field added to make that decision
    // legible.
    const hasCli = existsSync(cli);
    if (
      !D.L.shouldDispatchLandPrep({
        position,
        dispatched: state.prepDispatched,
        speculativeDispatched: state.prepDispatchedSpeculative, // plan 2463
        lockHeld,
        hasCli,
      })
    ) {
      // review [2]: keyed on "could this attempt still have fired", NOT on prepDispatched — since
      // plan 2463 a SECOND (speculative) dispatch is legal at position 2 even once the plain one
      // fired, so the old guard silenced exactly the case an operator most needs to see: why
      // speculative stacking never engages on a busy queue.
      // Same priority as the gate and the skip reason below — !hasCli first. Review 2026-07-28
      // (round 2): reordering only the skip() ternary left THIS line still lockHeld-first, so with
      // both conditions true the live log said "lock held" while the seam field said "missing CLI"
      // — the two-sources-disagree bug moved to the log/field boundary instead of being removed.
      if (hasCli && lockHeld && (!state.prepDispatched || position === D.L.SPECULATIVE_POS))
        D.spine.stepLog(
          state,
          'land-prep: a pass is already running in this worktree — not dispatching',
        );
      // plan 2551: name the DECLINING condition, in the seam payload, not just the log.
      // ORDER MIRRORS THE GATE (done-worktree-lib.mjs shouldDispatchLandPrep: `!hasCli` first,
      // then `lockHeld`). Review 2026-07-28 caught these two disagreeing: with the reason
      // checking lockHeld first, a poll where BOTH held reported "worktree-lock held" while the
      // gate had actually declined on the missing CLI — sending a future investigation after the
      // wrong cause, in the field whose entire purpose is naming the right one.
      skip(
        !hasCli
          ? `no done-worktree.mjs in the worktree (${cli})`
          : lockHeld
            ? 'worktree-lock held by a live holder (a sibling prep or a resuming land)'
            : `gate declined at position ${position} (dispatched=${state.prepDispatched}, speculative=${state.prepDispatchedSpeculative})`,
      );
      return;
    }
    // A dispatch is happening — clear any reason a PREVIOUS poll in this same (--wait /
    // --wait-chunk) loop recorded. Review 2026-07-28: without this, tick N's "worktree-lock held"
    // survived into tick N+1's successful dispatch, so a later seam dump showed
    // `prepDispatched: true` next to text claiming the prep was declined — the exact
    // misreading this field exists to prevent.
    state.prepDispatchSkip = null;
    state.prepDispatched = true; // one attempt per invocation, whatever the outcome below
    // plan 2463: …plus one more the first time this land reaches the speculative position, which
    // is the only position where there is a head-of-queue tree to stack on.
    if (position === D.L.SPECULATIVE_POS) state.prepDispatchedSpeculative = true;
    // (3) a per-slug log, never 'ignore'. Appended across preps, rotated once past
    // PREP_LOG_MAX_BYTES (a prep emits full `next build` / WebKit-gate output, and a slug can
    // sit in the queue for days) — bounded at ~2x on disk, the same rotate-then-append shape
    // `appendJsonl` uses.
    const logPath = `${MAIN}/.scratch/land-prep-${state.slug}.log`;
    let fd;
    try {
      mkdirSync(`${MAIN}/.scratch`, { recursive: true });
      // review 2473 [8]: the ONE rotation primitive (extracted from appendJsonl's `maxBytes` arm),
      // not a second hand-rolled stat-then-rename.
      D.coordMetrics.rotateIfOver(logPath, PREP_LOG_MAX_BYTES);
      fd = openSync(logPath, 'a');
    } catch (e) {
      D.spine.stepLog(
        state,
        `land-prep: cannot open ${logPath} (${e.message || e}) — not dispatching`,
      );
      skip(`prep log unopenable: ${e.message || e}`);
      return;
    }
    // The win32 two-stage spawn shape (plan 2513) lives in spawnDetachedWorktreeChild — see its
    // header for the full rationale (that comment is the single source; worktree-lock.mjs points
    // at it). Relevant here only as: the prep child writes the worktree-lock holder pid ITSELF,
    // so preemption stays shim-agnostic.
    const child = D.spawnDetachedWorktreeChild.spawnDetachedWorktreeChild({
      MAIN,
      cli,
      slug: state.slug,
      wtPath: state.wtPath,
      childArgs: ['--prep'],
      shimLabel: 'land-prep shim: --prep',
      fd,
      env: D.spawn.gitEnv(),
    });
    // (1) an unheard 'error' event is fatal to THIS process.
    child.on('error', (e) => {
      console.error(
        `done-worktree: land-prep dispatch for ${state.slug} failed to spawn — ${e.message || e}. ` +
          `The land is unaffected; it pays the full gate battery at head.`,
      );
    });
    child.unref();
    try {
      closeSync(fd); // the child holds its own dup of the descriptor
    } catch {
      /* ignore */
    }
    D.spine.stepLog(
      state,
      `land-prep: dispatched a background --prep pass${child.pid ? ` (${process.platform === 'win32' ? 'shim pid' : 'pid'} ${child.pid})` : ''} — ` +
        `log ${logPath}`,
    );
  } catch (e) {
    // Dispatch is an optimization; nothing here may cost a land.
    console.error(`done-worktree: land-prep dispatch skipped (non-fatal) — ${e.message || e}`);
    // plan 2551: console.error is NOT in the seam payload, so a throw here used to be the one
    // both-booleans-false cause that left no trace an incident reader could recover.
    skip(`threw before dispatch: ${e.message || e}`);
  }
}

// ── plan 2551 Layer 3(b): spawn the detached keep-hot WATCHER on a turn-ending seam-out ──
//
// plan 2819 added the SECOND call site: the LAND_BLOCKED_REQUEUED seam. Read the gate's
// `inProcessWaiterSurvives` note in done-worktree-lib.mjs for why the raw --wait/--wait-chunk
// flags stopped being the right question once a second site existed.
//
// The gap this closes. The plain (`!wait && !chunk`) path polls the queue ONCE and exits with
// QUEUE_WAIT. `dispatchLandPrep` above fires at most one prep, against the tip AS OF THAT POLL —
// so a session that then launches no watcher of its own gets nothing when master moves later. In
// the 2026-07-27 incident the head merged ~35 min after the poll, which is why a one-shot prep
// could not have covered it: only a process that OUTLIVES the invocation can react.
//
// This does not replace the seam's session-side recipe — it cannot. A detached watcher spawned
// HERE re-invokes nobody when it exits; only a watcher the session launched via
// `run_in_background` wakes that session. So this covers PREP, the seam text still covers WAKE,
// and two live watchers per slug is the normal post-2551 state (they dedup at the worktree lock).
//
// Placement is AFTER dispatchLandPrep deliberately: both are safe concurrently (the per-slug
// worktree lock serializes them), but one-then-other keeps the prep log readable.
//
// Spawn shape is the plan-2513 two-stage win32 shim, for the same reasons spelled out in full at
// dispatchLandPrep — that comment is the single source; do not restate it here.
function autoSpawnQueueWatcher(state, { inProcessWaiterSurvives }) {
  const D = landDeps();
  try {
    // Cheap, IO-free rejections FIRST (review 2026-07-28). These were object-literal properties
    // on the shouldAutoSpawnWatcher call, which JS evaluates eagerly — so a --wait / --wait-chunk /
    // --dry-run invocation paid a pidfile read plus a kill(pid,0) probe purely to have the pure
    // predicate discard the result. The predicate keeps ALL the conditions (it is the tested
    // contract); this just avoids computing inputs that cannot change the answer.
    if (inProcessWaiterSurvives || D.env.DRY) return;
    const MAIN = state.main || D.coordGit.resolveMain();
    const cli = `${state.wtPath}/scripts/landing-queue-watch.mjs`;
    const pidfile = `${MAIN}/${D.L.lqWatchPidfileRel(state.slug)}`;
    if (
      !D.L.shouldAutoSpawnWatcher({
        inProcessWaiterSurvives,
        dry: D.env.DRY,
        watcherLive: D.landingQueueWatch.watcherIsLive(pidfile),
        hasCli: existsSync(cli),
      })
    )
      return;
    const logPath = `${MAIN}/.scratch/lq-watch-${state.slug}.log`;
    let fd;
    try {
      mkdirSync(`${MAIN}/.scratch`, { recursive: true });
      D.coordMetrics.rotateIfOver(logPath, PREP_LOG_MAX_BYTES);
      fd = openSync(logPath, 'a');
    } catch (e) {
      D.spine.stepLog(
        state,
        `queue-watch: cannot open ${logPath} (${e.message || e}) — not spawning`,
      );
      return;
    }
    // Same detached-child shape as the prep dispatch — ONE helper, so a future win32 fix cannot
    // land on one caller and silently miss the other. The watcher takes no extra argv.
    const child = D.spawnDetachedWorktreeChild.spawnDetachedWorktreeChild({
      MAIN,
      cli,
      slug: state.slug,
      wtPath: state.wtPath,
      childArgs: [],
      shimLabel: 'queue-watch shim:',
      fd,
      env: D.spawn.gitEnv(),
    });
    child.on('error', (e) => {
      console.error(
        `done-worktree: queue-watch spawn for ${state.slug} failed — ${e.message || e}. ` +
          `The land is unaffected; it pays the full gate battery at head.`,
      );
    });
    child.unref();
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    D.spine.stepLog(
      state,
      `queue-watch: spawned a detached keep-hot watcher${child.pid ? ` (${process.platform === 'win32' ? 'shim pid' : 'pid'} ${child.pid})` : ''} — ` +
        `PREP-ONLY, it CANNOT wake this session; the CANONICAL WAIT in the seam below is still required — ` +
        `log ${logPath}`,
    );
  } catch (e) {
    // Same posture as the prep dispatch: an optimization, never a cost to the land.
    console.error(`done-worktree: queue-watch auto-spawn skipped (non-fatal) — ${e.message || e}`);
  }
}

// plan 2328: does this land carry the operator's `priority: high` stamp? Read at
// ENQUEUE time (plan-body reads otherwise happen only at archive, long after the
// queue insert). Single plan: resolvePlanRelForSlug above. Batch slug: priority if
// ANY manifest member is stamped — resolved via the batch manifest ids through
// buildPlanIdIndex, never slug-parsing. Fail-safe: an unresolved/unreadable plan
// file reads as NOT priority — a lost stamp only ever costs queue position (a plain
// tail append), never correctness.
function planPriorityFor(main, slug, manifest) {
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
  // plan 2520: routed through the ONE shared tier reader — stays a `high`-only flag,
  // byte-identical to before; a `medium`/`low` stamp only feeds queue-drain's sort, never
  // this queue-priority check.
  return rels.some((rel) => {
    try {
      return D.buildIndexLib.isHighPriorityTier(readFileSync(`${main}/${rel}`, 'utf8'));
    } catch {
      return false;
    }
  });
}

export function queueEnqueueAndGate(state, wait, resume, chunkSec = 0) {
  const D = landDeps();
  const chunk = !wait && chunkSec > 0;
  // plan 2328: the priority feed-through — resolved LAZILY here, at its only consumer
  // (review 2328 efficiency finding: an unconditional read at lane-derivation time made
  // every post-merge --resume / already-landed bookkeeping re-run pay a git ls-files +
  // plan-body read for a value those fast paths never use). Batch: priority if ANY
  // manifest member carries the stamp. DRY has no real plan files; DW_FAKE_PRIORITY=1
  // is the dry-run harness hook (mirrors DW_FAKE_NODE_MODULES — honoured only under
  // --dry-run).
  state.priority = D.env.DRY
    ? process.env.DW_FAKE_PRIORITY === '1'
    : planPriorityFor(
        state.main || D.coordGit.resolveMain(),
        state.slug,
        state.batch?.manifest ?? null,
      );
  D.spine.stepLog(
    state,
    `landing queue: enqueueing (lane=${state.lane}${state.priority ? ' ⚡ priority' : ''})`,
  );
  // plan 2517 (supersedes plan 2170 Ship 2's preserved-position ticket): a
  // dequeue-on-rework stamps a `reenterPending` marker in the land-attempt sidecar — not
  // a position to restore (there is none any more — operator ruling: "a plan carries no
  // priority... it re-enters at the TAIL"), just a flag telling the NEXT enqueue to route
  // through the `reenter` verb so the audit trail can name a rework re-entry distinctly
  // from a first-time enqueue. Consumed (cleared, in memory AND on disk) right after the
  // FIRST enqueue lands, so a later stolen/dropped rejoin from the wait loop is a plain
  // enqueue, not a second reenter audit line (review 2170 [2]'s stale-ticket concern, same
  // shape). A crash between enqueue and clear is harmless (reenter is idempotent on a
  // present slug).
  const priorAttempt = readLandAttempt(
    D.env.DRY ? null : state.main || D.coordGit.resolveMain(),
    state.slug,
  );
  let reenterPending = priorAttempt?.reenterPending === true;
  // plan 665 G3: in --wait mode a sibling's transient foreign-dirt at enqueue must back-off-
  // and-retry, not crash the land (the 2026-06-15 plan-661 standalone-spine crash was exactly
  // here). --wait-chunk retries too (an unattended run has nobody to clear operator dirt, and
  // sibling mid-commit dirt is the transient case retrying exists for). Plain non-wait keeps
  // coordWrite's immediate hard-stop (the dirt is usually the operator's own uncommitted
  // edit). On budget exhaustion coordRetry throws { coordContention } → main() converts it
  // to a clean COORD_CONTENTION seam.
  // plan 2328: the priority stamp feeds through on the enqueue verb's front-block insert.
  const prio = state.priority ? ['--priority'] : [];
  // plan 2561: enq() is called once normally (line ~2105) and again only on a stolen/
  // dropped rejoin (line ~2205's `enq(); continue;`) — a genuine re-entry where the sidecar
  // could have changed since `priorAttempt` was captured above. `firstEnqCall` lets the
  // stamp write below reuse that already-read `priorAttempt` on the common first-call path
  // instead of a redundant synchronous re-read, while still reading fresh on an actual retry
  // iteration.
  let firstEnqCall = true;
  const enq = () => {
    const isFirstCall = firstEnqCall;
    firstEnqCall = false;
    // plan 2538: stamp the moment we're ABOUT to invoke the real enqueue/reenter
    // subprocess, BEFORE it runs. coordWrite's push+verify (assertPushReachedOrigin
    // ls-remotes origin directly — scripts/coord/coord-git.mjs) is synchronous inside that
    // subprocess, so an ORDINARY call only returns once the entry is confirmed on
    // origin — no staleness window remains once this function returns and a LATER
    // invocation of the same land runs its own discovery (makeQueueHeartbeatStamper
    // below). The one window that survives is a crash of THIS process while the
    // subprocess is still mid-flight (an orphaned child can outlive a killed parent,
    // and coordWrite's own freshen/commit/push/verify loop can retry for a while
    // under contention) — recentEnqueueAttempt is how a fresh re-invocation's
    // discovery bounds a retry for exactly that case, instead of either latching a
    // false negative for the rest of the wait (round 4's PLAUSIBLE finding) or
    // re-querying every ordinary negative (round 3's efficiency finding). Best-effort:
    // a lost stamp only forgoes the bounded retry, it never causes a wrong verdict.
    if (!D.env.DRY) {
      try {
        const main = state.main || D.coordGit.resolveMain();
        writeLandAttempt(main, state.slug, {
          ...((isFirstCall ? priorAttempt : readLandAttempt(main, state.slug)) || {}),
          slug: state.slug,
          enqueueAttemptedIso: D.spine.nowIso(),
        });
      } catch {
        /* best-effort — see above */
      }
    }
    D.coordGit.coordRetry(
      wait || chunk,
      () =>
        reenterPending
          ? D.spawn.node(
              'landing-queue.mjs',
              'reenter',
              state.slug,
              '--lane',
              state.lane,
              '--host',
              state.host,
              '--session',
              state.session,
              ...prio,
            )
          : D.spawn.node(
              'landing-queue.mjs',
              'enqueue',
              state.slug,
              '--lane',
              state.lane,
              '--host',
              state.host,
              '--session',
              state.session,
              ...prio,
            ),
      { label: `enqueue ${state.slug}` },
    );
    if (reenterPending) {
      // Ticket consumed: clear the in-memory flag (so a stolen-entry rejoin is a plain
      // enqueue) and the on-disk sidecar field.
      reenterPending = false;
      if (!D.env.DRY) {
        // sonnet-review finding (2026-07-27): this used to reuse the already-read
        // `priorAttempt` (review 2170 [6]'s single-read optimization) instead of a second
        // disk read — but `priorAttempt` was captured BEFORE `enq()`'s plan-2538
        // `enqueueAttemptedIso` stamp above, so spreading it back here silently clobbered
        // that fresh stamp with the stale pre-enqueue snapshot on every rework re-entry,
        // reopening the exact stale-negative discovery window plan 2538 exists to close.
        // Read fresh so the just-written stamp survives the clear.
        const main = state.main || D.coordGit.resolveMain();
        const cleaned = { ...(readLandAttempt(main, state.slug) || {}), slug: state.slug };
        delete cleaned.reenterPending;
        writeLandAttempt(main, state.slug, cleaned);
      }
    }
  };
  enq();
  state.queued = true;
  const fake = process.env.DW_FAKE_QUEUE_POS;
  if (D.env.DRY && !fake) {
    // dry trace only — no JSON to parse; treat as head-of-queue
    D.spawn.node('landing-queue.mjs', 'status', state.slug, '--json');
    return;
  }
  const pollSec = Number(process.env.DW_QUEUE_POLL_SEC || 260);
  // plan 2170 Ship 3: the chunk clock — one --wait-chunk call blocks at most chunkSec
  // seconds in this loop, then seams QUEUE_WAIT for a same-turn re-invoke.
  const chunkDeadlineMs = chunk ? Date.now() + chunkSec * 1000 : 0;
  let waited = false;
  let reenqueues = 0;
  // plan 2334: ONE throttle ledger for the whole recovery ladder (demote 1682 / steal 2266 /
  // overtake 2275 / reap 2331) — a non-`--wait` invocation gets at most ONE attempt per verb,
  // which is what the four separate `let xAttempted` flags encoded before the unification.
  const recoveryAttempted = new Set();
  let holdingClearFails = 0; // plan 2275: bounded retries of the resume-side settlement clear
  for (;;) {
    const st = fake
      ? JSON.parse(fake)
      : JSON.parse(D.spawn.node('landing-queue.mjs', 'status', state.slug, '--json'));
    if (st.position === 1) {
      // plan 2275: a resume arriving back at head with its HOLDING stamp still set must
      // CLEAR it before proceeding — the position-1-verdicted `mark-holding off` is the
      // overtake/resume race settlement: an overtake that commits between this poll and
      // the clear makes the clear REFUSE, and falling back into the wait path instead of
      // merging past a mid-land overtaker is exactly the point. Every non-holding land
      // reads headState null here and pays nothing. Bounded: a persistent failure while
      // genuinely at head means a wedged queue doc — surface it, don't spin.
      // DELIBERATELY ABOVE the chunk seam-out below (review 2275 F0): emitSeam
      // process.exits, so a clear placed after it would be unreachable for a driver
      // that only ever polls via --wait-chunk — the stamp would never settle and the
      // land would look wedged "at position 1" forever. A chunk call clearing the
      // stamp is also semantically right: at head with a live poller, the entry is
      // back on-spine, and the stamp's meaning is "parked, not in the merge window".
      if (st.headState === D.landingQueueLib.HOLDING_STATE && !fake) {
        if (!attemptClearHolding(state)) {
          if (++holdingClearFails >= 5) {
            throw new Error(
              `landing-queue gate: could not clear the HOLDING stamp for ${state.slug} after ` +
                `${holdingClearFails} attempts at position 1 — either an overtaker keeps taking ` +
                `the head (re-run and wait) or the queue doc is wedged; inspect ` +
                `\`node scripts/landing-queue.mjs status --json\`.`,
            );
          }
          D.spine.stepLog(
            state,
            'landing queue: HOLDING clear refused (an overtaker may hold the head) — re-polling',
          );
          D.coordGit.sleepSync(5000);
          continue;
        }
      }
      if (chunk) {
        // plan 2170: a chunk call is WAIT-ONLY — never proceed into the land (a
        // timeout-killed call must not die mid-merge, the plan-662 class). Bump the
        // heartbeat once at head-arrival (the watcher's head-exit arm, plan 2085) so
        // the bare re-invoke arrives demote-fresh, then seam out.
        queueHeartbeat(state);
        state.queuePosition = 1;
        D.spine.emitSeam(D.L.SEAM.QUEUE_WAIT, D.L.queueWaitAtHeadReason(), state, {
          keepQueue: true,
        });
      }
      break;
    }
    // plan 2170 Ship 3: chunk budget exhausted → seam QUEUE_WAIT (slot retained) for the
    // same-turn re-invoke. Lives at the TOP of the iteration, right after the at-head
    // check (review 2170 [1]): the `continue` paths below — the stolen-entry re-enqueue
    // and a successful stale-head demote — jump back here, so a demote chain or a rejoin
    // can never spin a chunk call past its bound; each continue gets one more poll, then
    // the deadline seams out.
    if (chunk && Date.now() >= chunkDeadlineMs) {
      // plan 2529: a farewell heartbeat — the process is alive at this seam by
      // definition, so stamping here (once per chunk, not per poll) restarts the
      // demote budget clock at the chunk boundary instead of leaving the entry
      // heartbeat-frozen for the whole inter-chunk re-arm gap. Gated on the SAME
      // near-head window as the in-loop self-arm below (line ~2066/2141 —
      // duplicated inline here because this branch's emitSeam process-exits before
      // that later computation runs): only a near/at-head entry's own heartbeat is
      // ever judged by the demote/steal/reap ladder, so a deep-position stamp buys
      // no protection and would just be an extra coordWrite against the shared
      // queue doc every ~10-min chunk (review finding, plan 2529).
      const nearHeadOnChunkExit = st.position > 1 && st.position <= D.L.PRECONVERGE_POS;
      if (nearHeadOnChunkExit) queueHeartbeat(state);
      state.queuePosition = st.position;
      D.spine.emitSeam(D.L.SEAM.QUEUE_WAIT, D.L.queueWaitChunkReason(st, chunkSec), state, {
        keepQueue: true,
      });
    }
    if (st.position === 0 && !fake) {
      // we were stolen/dropped while waiting — rejoin at the tail. Bounded:
      // a slug that repeatedly fails to appear after its own enqueue means the
      // queue doc is broken — surface that instead of tight-spinning coordWrites.
      if (++reenqueues > 3) {
        throw new Error(
          `landing-queue gate: ${state.slug} absent from the queue after ${reenqueues} re-enqueues — ` +
            `the landing queue is likely corrupt; inspect it (and the enqueue output) before retrying.`,
        );
      }
      enq();
      continue;
    }
    // plan 2334: the ONE waiter-side auto-recovery ladder — demote (1682) → steal (2266) →
    // overtake (2275) → reap (2331), in that order, each with its own local pre-check and
    // the shared one-attempt-per-invocation throttle. The gating that used to be four
    // hand-rolled `if` blocks now lives in RECOVERY_VERBS + recoveryLadderForTick (pure,
    // unit-tested); every verb's REAL gates stay in its landing-queue.mjs CLI, so a refusal
    // here is always harmless. Ladder order is load-bearing: overtake is the recourse for a
    // HOLDING head and reap must never touch one, so the two rows carry inverse headState
    // shortcuts and reap sits last. A taken action re-polls immediately (we may be head).
    let recovered = false;
    for (const verb of recoveryLadderForTick({
      st,
      fake: Boolean(fake),
      wait,
      chunk,
      attempted: recoveryAttempted,
      host: state.host,
      lane: state.lane,
      nowMs: Date.now(),
    })) {
      if (!verb.eligible) continue; // the CLI would only refuse — skip the spawn + its fetch
      // review [0]: the one-shot is spent HERE, on the spawn — see recoveryLadderForTick.
      recoveryAttempted.add(verb.subcommand);
      if (attemptAutoRecovery(state, verb)) {
        recovered = true;
        break;
      }
    }
    if (recovered) continue;
    // plan 2473: THE DISPATCH. Reaching here proves position ≥ 2 — position 1 broke/seamed out
    // above and position 0 re-enqueued and continued — so this is the "waiters only, never at
    // head" gate plan 2458 specified, read off the poll this loop already performs rather than a
    // second queue probe. It runs in ALL THREE wait modes (plain seam-out below, --wait-chunk,
    // attended --wait): the plain non-wait invocation is the cloud drain's whole cadence, and
    // leaving it out would keep the coverage gap open for exactly the sessions that never run a
    // watcher. Detached + at-most-once per invocation; the worktree lock — not this call site —
    // is what makes it safe against the merge, a sibling prep, and a re-invocation. The position
    // is passed through to `shouldDispatchLandPrep` rather than left implicit in the call site:
    // "never at head" is the invariant the whole design rests on, so it gets a test, not a
    // comment.
    dispatchLandPrep(state, st.position);
    // plan 1805: pre-convergence — NEAR the head (1 < position ≤ L.PRECONVERGE_POS), probe
    // for rebase conflicts vs fresh origin/master so STALE conflict work happens DURING the
    // wait, not on the head slot (the plan-1776 8-min head-cap burn; 8+ "heavy head rework"
    // requeues in the audit log). --wait is the attended waiter (TTY-gated, plan 665 G4.3)
    // and may attempt the real rebase; the non-wait pass is probe-only — the conflict list
    // rides the QUEUE_WAIT seam reason (the plan-1805 unattended pin).
    // plan 2085 review [6]: the near-head window, computed ONCE per iteration — the
    // pre-convergence probe (plan 1805) and the heartbeat self-arm below deliberately
    // share it. Keyed on the spine's own near-head constant (PRECONVERGE_POS), not the
    // watcher's NEAR_POSITION_THRESHOLD — importing across would invert the module
    // direction, and a drift between the two only shifts where the protection window
    // starts (the sleep clamp below keeps the cadence itself demote-safe regardless).
    const nearHead = st.position > 1 && st.position <= D.L.PRECONVERGE_POS;
    let preconvergeNote = '';
    // plan 2085 review [4] + r2 [0]: attemptPreconverge sets this on state at its OWN
    // queueHeartbeat call site — never inferred here from the mere invocation, because
    // its early 'skip' returns (busy worktree, rounds cap) exit before any write, and
    // suppressing the self-arm on those iterations would starve the entry back into
    // the demote window this plan closes.
    state.preconvergeHeartbeated = false;
    if (nearHead) {
      const probe = preconvergeProbe(state);
      if (probe && probe.conflicted) {
        if (wait) {
          const r = attemptPreconverge(state);
          if (r === 'converged') continue; // re-poll immediately — we may be head by now
          if (r === 'conflict') {
            state.queuePosition = st.position; // plan 692: the 🔴 banner shows the FIFO position
            D.spine.emitSeam(
              D.L.SEAM.QUEUE_WAIT,
              D.L.preconvergeConflictReason(st, probe.files, state.branch),
              state,
              { keepQueue: true },
            );
          }
          // 'skip' (rounds exhausted / bookkeeping failure) → plain wait; the head path covers it
        } else if (chunk) {
          // plan 2170: probe-only, exactly the plan-1805 pin — a chunk NEVER attempts the
          // rebase, and a conflicted probe needs session action NOW, so seam out instead
          // of sleeping the rest of the chunk on a known blocker.
          state.queuePosition = st.position;
          D.spine.emitSeam(
            D.L.SEAM.QUEUE_WAIT,
            D.L.queueWaitChunkConflictReason(st, probe.files),
            state,
            {
              keepQueue: true,
            },
          );
        } else {
          preconvergeNote = D.L.preconvergeConflictNote(probe.files);
        }
      }
    }
    if (!wait && !chunk) {
      state.queuePosition = st.position; // plan 692: the 🔴 banner shows the FIFO position
      // plan 2517: the flagless probe's own entry can go stale with NO visible signal —
      // exit 18 looks identical whether the entry is fresh or about to be demoted, because
      // only the (wait || chunk) near-head self-arm below ever refreshes a heartbeat (plan
      // 2085), and it is UNREACHABLE for this branch. When the status read (the idempotent
      // re-enqueue this invocation just did) already shows THIS entry's own heartbeat older
      // than HALF the plan-1682 demote threshold, say so loudly and name the fix — a string
      // change composed from data already fetched, no new coordWrite on the flagless path.
      let staleNote = '';
      // ageMinutes (landing-lock.mjs) is the ONE heartbeat-age computation — NaN guard,
      // negative-delta clamp, one rounding mode — shared with every other lock/queue consumer.
      const ageMin = D.landingLock.ageMinutes(st.heartbeatIso || '', Date.now());
      if (ageMin !== null && ageMin > D.landingQueueLib.DEFAULT_DEMOTE_STALE_MIN / 2) {
        staleNote =
          `\n\n⚠ STALE HEARTBEAT (plan 2517): this entry's OWN heartbeat is ~${ageMin} min ` +
          `old — over half the ${D.landingQueueLib.DEFAULT_DEMOTE_STALE_MIN}-min demote threshold. A flagless ` +
          `poll loop like this one never refreshes it (only the --wait/--wait-chunk near-head ` +
          `self-arm does, plan 2085), so this entry can be demoted to the tail while alive. ` +
          'Switch to `node scripts/done-worktree.mjs <slug> --wait-chunk`' +
          ` — it self-arms the heartbeat near the head and blocks in-process at zero ` +
          `model-token cost (plan 2170).`;
      }
      // plan 2551 Layer 3(b): a session that launches NO watcher of its own still gets its
      // branch kept hot — the one-shot prep above only ever saw the tip as of this poll, and
      // this seam is the LAST thing this invocation does. Spawned before emitSeam because
      // emitSeam process.exits (anything after it is unreachable). Never on --wait/--wait-chunk;
      // never when a watcher already advertises this slug. See autoSpawnQueueWatcher.
      // This branch is `!wait && !chunk` by construction, so the survives-flag is always false
      // here — passing the expression rather than a literal keeps the answer derived from the
      // same condition the branch is guarded by, if that guard is ever widened.
      autoSpawnQueueWatcher(state, { inProcessWaiterSurvives: wait || chunk });
      D.spine.emitSeam(
        D.L.SEAM.QUEUE_WAIT,
        // plan 2655: st.head is the HEAD slug (someone else); queueWaitReason also needs OUR
        // slug to produce a copy-paste-runnable recipe and the disambiguation sentence — spread
        // it in rather than confusing the two.
        D.L.queueWaitReason({ ...st, slug: state.slug }) + preconvergeNote + staleNote,
        state,
        { keepQueue: true },
      );
    }
    // plan 2085: self-arm the own entry's heartbeat NEAR the head in the attended --wait
    // loop — closing the gap for the (wait || chunk) in-process waiters: nothing refreshed
    // a waiter's heartbeat during a long wait, so it reached head > DEFAULT_DEMOTE_STALE_MIN
    // stale and the plan-1682 waiter sentinels demoted it before this loop's own at-head
    // stamp (below) could run. This self-arm is UNREACHABLE for the flagless (!wait &&
    // !chunk) branch above — that gap is closed there only as a VISIBILITY fix (the
    // staleNote composed above, plan 2517), never a heartbeat refresh: a bare poll loop
    // still writes no heartbeat between invocations. Skipped when attemptPreconverge
    // ACTUALLY stamped this tick (review [4] — no double coordWrite per iteration); deep
    // positions stay write-free (only a HEAD's heartbeat is ever judged, and near-head is
    // where the stale-arrival window opens).
    if ((wait || chunk) && !fake && nearHead && !state.preconvergeHeartbeated) {
      queueHeartbeat(state);
    }
    // plan 2085 review [1] + r2 [6]: near head the sleep is CLAMPED so the heartbeat
    // cadence can never exceed the plan-1682 demote threshold — the self-arm above fires
    // once per iteration, so its real cadence IS the sleep length, and an env override
    // like DW_QUEUE_POLL_SEC=1000 would otherwise silently reopen the exact stale-arrival
    // window this plan closes. Derived from the threshold itself (3x margin, = 300 s
    // today) so a future re-tune of DEFAULT_DEMOTE_STALE_MIN moves this clamp with it;
    // the 260 s default pollSec sits under the cap, so default behavior is unchanged.
    let sleepSec = nearHead
      ? Math.min(pollSec, Math.floor((D.landingQueueLib.DEFAULT_DEMOTE_STALE_MIN * 60) / 3))
      : pollSec;
    // plan 2170: never sleep past the chunk deadline — the leftover is spent on one more
    // poll iteration, whose deadline check above then seams out.
    if (chunk) {
      sleepSec = Math.max(0, Math.min(sleepSec, Math.ceil((chunkDeadlineMs - Date.now()) / 1000)));
    }
    D.spine.stepLog(
      state,
      `landing queue: waiting at position ${st.position} (polling every ${sleepSec}s)`,
    );
    waited = true;
    D.coordGit.sleepSync(sleepSec * 1000);
    if (fake && !chunk) break; // test hook: one iteration only (a chunk exits via its deadline seam)
  }
  D.spine.stepLog(state, 'landing queue: at head of queue, proceeding');
  // Refresh the heartbeat ONLY when it could be stale — after a wait, or on a
  // resume (the idempotent re-enqueue kept the OLD entry + timestamps). A fresh
  // first-pass enqueue already stamped heartbeatIso seconds ago; an immediate
  // second coordWrite push would be pure contention (review fix, plan 504).
  // plan 2266 review fix: THIS process's pid rides the SAME call whenever it fires
  // here (waited/resume — exactly the case a resumed/restarted process reaches head
  // under a NEW pid) — markHeadAcquired below skips its own pid stamp in that case,
  // so a resumed residency never pays two back-to-back coordWrite pushes for one
  // head-acquisition.
  // plan 2485: head ACQUISITION is a progress stamp — it is the transition that starts this
  // residency's convergence clock, and without a baseline stamp the axis would abstain
  // forever (a null progressIso is fail-safe = immune). Every later spine step re-stamps;
  // a head that acquires the slot and then completes no step inside the leash is exactly
  // the alive-but-not-converging class.
  const heartbeatedHere = waited || resume;
  if (heartbeatedHere) queueHeartbeat(state, process.pid, { progress: true });
  // plan 3226: tell every child spawned from here it is running AT THE HEAD — the load-bearing
  // signal for session-priority.mjs's CPU-priority axis (see that module's header).
  process.env.LANDING_QUEUE_HEAD = state.slug;
  // plan 1528: we are at the head — stamp when THIS residency acquired it (the
  // requeue trip's cumulative head-hold clock; a holding-halt resume keeps the
  // stamp, a fresh residency re-stamps and zeroes the conflict counter).
  markHeadAcquired(state, { pidAlreadyStamped: heartbeatedHere });
  // plan 2414: stamp the free-lane liveness token every time we reach the head
  // (including a post-HOLDING resume, which needs it re-stamped). plan 2437: folded
  // into markHeadAcquired's own heartbeat call when heartbeatedHere is false — see
  // markHeadAcquired's fold comment for the full rationale; only the heartbeatedHere
  // branch (that fold didn't fire) still needs this standalone call.
  if (heartbeatedHere) markQueueInLand(state);
}

// ── plan 3422 D4: PRE-QUEUE FRESHEN ──────────────────────────────────────────────────────────
//
// Before this, the branch met origin/master for the first time AT THE HEAD. Plan 1917 (2026-08-24
// audit, class 1) reached the head after a 116-minute wait, had to commit a freshen-merge carrying
// 32 conflicts from siblings' lands, and the resulting sha bump staled its sha-pinned review
// markers — which the enqueue-readiness gate correctly refuses — so it dequeued to the tail of the
// queue and paid a full 51-minute gate re-proof. Nothing in its OWN diff had changed.
//
// Freshening here, in the last step before the enqueue, moves that whole sequence OFF the
// serialized head slot: the branch enters the queue already sitting on a recent master, its
// markers re-pinned while nobody is waiting behind it, and the head visit is merge-only.
//
// It is DELIBERATELY OPPORTUNISTIC — every failure mode leaves the land exactly as it was:
//   · already up to date  → no-op, silent, identical to pre-3422 behaviour;
//   · a CONFLICT          → abort the rebase and enqueue unfreshened. The at-head path keeps its
//                           existing LAND_BLOCKED_HOLDING contract for genuine conflicts, which is
//                           where a human/session is actually engaged with the land. Halting here
//                           would cost the land its place in line before it ever took one, and
//                           leaving the conflict in the tree would trip D4's own orphaned-merge
//                           preflight on the next invocation;
//   · any error           → log and continue.
// The at-head rebase is NOT removed: master keeps moving during the wait, and that rebase is still
// what makes the merge race-free. This only makes it usually-trivial instead of usually-expensive.
//
// WHERE IT SITS, and why exactly there. Between the plan-2170 enqueue-readiness refusal and the
// plan-2992 heartbeat disarm:
//   · AFTER the refusal, not before. `recordedVerdict` is computed against HEAD back at step 2.5;
//     this function MOVES HEAD and re-pins the markers on disk, but that in-memory verdict would
//     not be re-read — so freshening first would make the refusal judge a stale verdict and seam
//     REVIEW_NEEDED on a land that is perfectly reviewed. (The at-head rebase has the same shape
//     and solves it the same way: move HEAD, then re-pin.)
//   · BEFORE the disarm (gpt-review 17e12b). This rebases and force-pushes, which runs the push
//     gate battery and can take minutes; a RETAINED queue entry left unheartbeated across that
//     window could go demote-stale before the land even reaches the queue.
// Its push carries the once-per-land proof set (gpt-review 2bf3e7), exported by the caller for the
// same reason the at-head rebase exports it — so this publish downgrades the two heavy suites to
// the diff-scoped remainder instead of buying a second FULL battery ahead of the head's own.
// `gateRoster` (plan 3960; derived from the registry rather than config since plan 3961 T2.7a) is
// the preflight-stage prepGates roster: without it this push authorized its skip against a
// roster that could disagree with what the registry actually registers. Keep it a PARAMETER, and
// keep the rationale here rather than at the call site — that call sits inside the
// plan-2170 enqueue-readiness source pin (done-worktree-land.test.mjs), whose 700-char budget
// measures the refusal-to-enqueue distance and which call-site prose would silently blow.
export function preQueueFreshen(state, wtPath, branch, gateRoster) {
  const D = landDeps();
  const standDown = preQueueFreshenStandDown(chunkGateConfig());
  if (standDown.standDown) {
    const message = `pre-queue freshen: stand-down — ${standDown.reason}`;
    D.spine.stepLog(state, message);
    if (D.env.DRY) process.stdout.write(`${message}\n`);
    return;
  }
  if (D.env.DRY) {
    if (process.env.DW_FAKE_PREQUEUE_FRESHEN === 'skip') return;
    D.spawn.run('git', ['-C', wtPath, 'fetch', '--quiet', 'origin', 'master']);
    if (process.env.DW_FAKE_PREQUEUE_FRESHEN === 'behind') {
      // plan 3972: the skip decides BEFORE the "rebasing" line, exactly as the real path below —
      // a skipped freshen never announces a rebase it is not going to run.
      const skip = trySkipSync(state, wtPath, branch, { site: SYNC_SITE.preQueue });
      if (skip.skipped) {
        logSyncSkipped(state, skip, SYNC_SITE.preQueue);
        return;
      }
      const message = 'pre-queue freshen: branch is behind origin/master — rebasing before enqueue';
      D.spine.stepLog(state, message);
      process.stdout.write(`${message}\n`);
    }
    return;
  }
  try {
    // plan 3974 round 3 (gpt-review 9e9c0e/fbf68e/c0c94a/a8b176/7489e0/c19015/c8c57e/bc9cfb): a
    // worktree ALREADY mid-rebase/mid-merge before this freshen ever runs — a human's own paused
    // `git rebase`, or a leftover the at-head D4 halt exists to catch — must not be rebased over
    // OR aborted here. The abort-on-seam block further down may only ever clean up a mutation ITS
    // OWN `tryRebase` call below created; probing FIRST (before the fetch even runs) is what keeps
    // that true, and it costs nothing extra since a mid-mutation worktree is refused
    // unconditionally.
    //
    // plan 3974 round 4 (gpt-review 98caaf/25c270/246be0/2974e2/ba4258): `worktreeMutationKind`
    // alone is fail-OPEN — it returns null for "no mutation" AND for "the probe itself failed" —
    // so a transient `rev-parse --git-path` failure over a human's genuinely paused rebase would
    // read as "clean" and let `tryRebase` run, with the later abort-on-seam block then destroying
    // real resolution work. `mutationKnownAbsent` is the positive-proof gate (land-lib.mjs, reached
    // through the deps container): only an UNKNOWN state (probe failure) or a genuine mutation
    // stands this freshen down; only a POSITIVELY PROVEN clean worktree proceeds.
    if (!D.landLib.mutationKnownAbsent(wtPath)) {
      const kind = worktreeMutationKind(wtPath);
      D.spine.stepLog(
        state,
        kind
          ? `pre-queue freshen: worktree is already mid-${kind} (not started by this land) — ` +
              'leaving it untouched; the at-head preflight will halt on it'
          : 'pre-queue freshen: could not prove the worktree is free of an in-progress ' +
              'rebase/merge (git probe failed) — leaving it untouched; the at-head preflight ' +
              'will decide',
      );
      return;
    }
    // The push this rebase performs runs the pre-push gate battery, so hand it the once-per-land
    // proof set first (gpt-review 2bf3e7) — the same env channel the at-head rebase sets three
    // call layers above its own push, for the same reason: without it this publish buys a second
    // FULL battery ahead of the head's, instead of the diff-scoped remainder.
    Object.assign(
      process.env,
      D.L.landGatesProvenPushEnv(
        { landId: state.landGateId, gatesProven: state.gatesProven },
        gateRoster,
      ),
    );
    D.spawn.run('git', ['-C', wtPath, 'fetch', '--quiet', 'origin', 'master']);
    // "Behind" is the only case worth paying for: if origin/master is already an ancestor of the
    // branch there is nothing to take on board, and a rebase would be a pure sha churn — which is
    // the very cost this step exists to avoid.
    const behind = D.spawn
      .run('git', ['-C', wtPath, 'rev-list', '--count', 'HEAD..origin/master'])
      .trim();
    if (behind === '0' || behind === '') return;
    // plan 3972: "behind" by bookkeeping alone is not worth a rebase + re-pin + gated push. When
    // the whole master delta is coordination paths and merge-tree is clean, enqueue as-is: the
    // head merge is a real three-way merge and takes a behind-but-clean branch unchanged. Any
    // clause false (a code path in the delta, a graft, an unpublished tip, a dirty merge-tree, a
    // git error) falls through to the rebase exactly as before.
    // noFetch: the freshen fetched this same ref two lines above.
    const skip = trySkipSync(state, wtPath, branch, {
      noFetch: true,
      site: SYNC_SITE.preQueue,
    });
    if (skip.skipped) {
      logSyncSkipped(state, skip, SYNC_SITE.preQueue);
      return;
    }
    D.spine.stepLog(
      state,
      `pre-queue freshen: branch is ${behind} commit(s) behind origin/master — rebasing and ` +
        're-pinning markers BEFORE taking a queue slot, so the head visit is merge-only (plan 3422 D4)' +
        (skip.reason ? ` [sync not skipped: ${skip.reason}]` : ''),
    );
    const reb = tryRebase(wtPath, branch);
    if (D.L.rebaseSeam(reb)) {
      // CLEAN UP ON ANY SEAM, not just a conflict (gpt-review 6ca231 / fd2c40). The earlier cut
      // reasoned that a plan-3080 graft block and a hook-rejected push leave nothing in progress,
      // so it cleaned up only `reb.conflicted`. That reasoning is not worth relying on: this
      // freshen must not be the thing that strands mutation state for D4's own preflight to halt
      // on, and probing costs one git call. So: ask what is actually in progress and abort THAT.
      //
      // `tryRebase` can conflict as a REBASE or as a merge-bearing FRESHEN-MERGE, where
      // `git rebase --abort` is the wrong verb (gpt-review 28fec8 / 429d0b / c980c4) — hence the
      // probe rather than a fixed verb.
      const kind = worktreeMutationKind(wtPath);
      if (kind) {
        try {
          D.spawn.run('git', ['-C', wtPath, kind === 'merge' ? 'merge' : 'rebase', '--abort']);
        } catch (firstErr) {
          // `rebase-apply` is ALSO where `git am` keeps its state, and `git rebase --abort` does
          // not clear an interrupted `am` (gpt-review 09c8d4 / 37a4e5 / f3eb70 / 46a904). Rather
          // than teach the probe a distinction git's own layout does not cheaply expose, fall back
          // to the other verb — the one that will succeed for whichever state is really there.
          try {
            if (kind === 'rebase') D.spawn.run('git', ['-C', wtPath, 'am', '--abort']);
            else throw firstErr;
          } catch (e) {
            // Neither verb cleared it. Say so LOUDLY rather than leaving a silent orphan for the
            // next invocation's preflight to discover.
            D.spine.stepLog(
              state,
              `pre-queue freshen: WARNING — could not abort the in-progress ${kind} (${e.message}). ` +
                'The worktree is left mid-mutation and the next preflight will halt on it; finish ' +
                `or discard it by hand (\`git ${kind} --abort\`, or \`git am --abort\` if it was a git am).`,
            );
            return;
          }
        }
      }
      // `kind === null` is genuinely ambiguous — "nothing in progress" OR "the probe itself failed"
      // (worktreeMutationKind swallows git errors, gpt-review 80a5c3). Say what was actually
      // observed rather than claiming an abort that may not have happened.
      D.spine.stepLog(
        state,
        reb.conflicted
          ? `pre-queue freshen: conflicts with origin/master — ${kind ? `in-progress ${kind} aborted` : 'no mutation state found to abort'}, ` +
              'enqueueing unfreshened. The at-head rebase will halt LAND_BLOCKED_HOLDING for ' +
              'resolution as it always has.'
          : 'pre-queue freshen: the branch sync was REFUSED (a graft or push-gate refusal, not a ' +
              `conflict)${kind ? ` — in-progress ${kind} aborted` : ''} — enqueueing unfreshened; the ` +
              'at-head rebase re-runs it and raises the real seam.',
      );
      return;
    }
    D.spine.repinAndReprove(state, wtPath); // plan 3972: the tip follows the re-sha only on the repin's proof
    // Re-stamp a RETAINED queue slot explicitly. Two earlier cuts of this got it wrong and the
    // review caught both: moving the plan-2992 disarm after the freshen cannot help (that disarm
    // cancels a setInterval, and every step above is synchronous `execFileSync`, which blocks the
    // event loop — the interval can never fire during the freshen wherever the disarm sits,
    // gpt-review f523a0), and a plain `queueHeartbeat` is a NO-OP here because `bestEffortQueueCall`
    // early-returns on `!state.queued`, which is false until the enqueue below (gpt-review 1f75de /
    // 940c83 / e2306a / c548cf / 691a65). `heartbeatDiscoveredQueueSlot` is the repo's own answer
    // for exactly this shape — "refresh a slot I hold but have not enqueued in THIS invocation" —
    // and it is what the plan-2992 retained-entry timer calls. Best-effort throughout: with no
    // retained entry the CLI simply has nothing to stamp, and the failure is swallowed.
    heartbeatDiscoveredQueueSlot(state);
    D.spine.stepLog(
      state,
      'pre-queue freshen: branch synced onto origin/master and markers re-pinned, off the head slot',
    );
  } catch (e) {
    D.spine.stepLog(state, `pre-queue freshen: skipped (${e.message}) — enqueueing unfreshened`);
  }
}

// ── plan 1528 Phase B: land-attempt state (requeue-to-tail bookkeeping) ───────
// Cross-invocation counters for ONE land attempt: when this slug's queue entry first
// reached the head slot, how many rebase/merge conflicts it burned there, and how many
// times it requeued to the tail. Lives beside the land-prep marker (MAIN/.scratch,
// gitignored, slug-keyed — same "survives the very rebase it describes" rationale).
// entryEnqueuedIso keys the head counters to ONE continuous queue residency: an abort
// path dequeues the entry, so a later invocation's fresh enqueue (new enqueuedIso)
// resets headAcquiredIso + the event tallies. requeueCount deliberately SURVIVES those
// resets — it is the per-land-attempt starvation cap (L.REQUEUE_MAX), cleared only on
// SUCCESS (clearLandAttempt beside the terminal sidecar write).
// plan 2453: the per-attempt EVENT counts live in ONE keyed `tallies` object (kinds
// declared in L.LAND_EVENT_KINDS), not N sibling scalars — see readLandAttempt's
// migration note for how a pre-2453 sidecar is carried over.
// plan 2538: exported (was module-private) so a test can populate/read the REAL sidecar
// file recentEnqueueAttempt reads from, instead of only exercising it through an
// injected mock — the plan's own ask for a test against the real staleness scenario.
export function landAttemptPath(main, slug) {
  return `${main}/.scratch/land-attempt-${slug}.json`;
}

// A record older than this is an ABANDONED attempt (review 1528 [2]): clearLandAttempt only
// runs on the clean-land path (every seam emitSeam→process.exit()s past it), so a torn-down/
// redone land would otherwise bequeath its requeueCount to an unrelated future attempt of the
// same slug — silently pre-capping its requeues. 24h is far beyond any live halt-resume cycle.
const LAND_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// plan 2453 step 4: THE migration point. A record written by the pre-2453 code carries the
// event counts as sibling scalars (`conflictCount` / `pushStormCount`); a land attempt can
// be mid-flight across the deploy of this change, so the read carries those counts over
// into the keyed `tallies` object rather than silently resetting them (a reset would hand a
// two-conflict attempt a clean slate and lose exactly the arm-(a) demote plan 1528 exists
// to make). Normalizing HERE — at the single boundary — means every caller downstream sees
// only the new shape, and the legacy scalars are DROPPED so the two encodings can never
// coexist on disk and diverge (`...attempt` spreads at the write sites cannot carry them
// back). Applies to the DRY injection path too, so the plan-2432 spine tests keep exercising
// exactly the old-format sidecars they were written against.
function migrateLandAttempt(rec) {
  const D = landDeps();
  if (!rec || typeof rec !== 'object') return rec;
  const out = { ...rec, tallies: D.L.normalizeTallies(rec) };
  for (const def of Object.values(D.L.LAND_EVENT_KINDS)) {
    if (def.legacyField) delete out[def.legacyField];
  }
  return out;
}

// plan 2538: exported alongside landAttemptPath, same rationale.
export function readLandAttempt(main, slug) {
  const D = landDeps();
  // DRY test hook: DW_FAKE_LAND_ATTEMPT injects the attempt JSON (mirrors DW_FAKE_LAND_PREP).
  if (D.env.DRY) {
    try {
      return process.env.DW_FAKE_LAND_ATTEMPT
        ? migrateLandAttempt(JSON.parse(process.env.DW_FAKE_LAND_ATTEMPT))
        : null;
    } catch {
      return null;
    }
  }
  try {
    const rec = JSON.parse(readFileSync(landAttemptPath(main, slug), 'utf8'));
    const age = rec.updatedIso ? Date.now() - Date.parse(rec.updatedIso) : Infinity;
    return Number.isFinite(age) && age <= LAND_ATTEMPT_MAX_AGE_MS ? migrateLandAttempt(rec) : null;
  } catch {
    return null; // absent / unreadable → fresh attempt (counters start at zero)
  }
}

// plan 2538: exported alongside landAttemptPath, same rationale.
export function writeLandAttempt(main, slug, data) {
  const D = landDeps();
  if (D.env.DRY) return;
  try {
    mkdirSync(`${main}/.scratch`, { recursive: true });
    writeFileSync(
      landAttemptPath(main, slug),
      JSON.stringify({ ...data, updatedIso: new Date().toISOString() }, null, 2),
    );
  } catch {
    /* best-effort — a lost counter only delays a trip, never corrupts a land */
  }
}

// review fix (plan 2505 sonnet-review round 4 [1]): the raw query+parse core, shared by
// queueStatusView below (which swallows every failure into null — its established contract,
// several OTHER callers rely on that) and makeQueueHeartbeatStamper's discovery (which needs
// the opposite: a thrown failure it can retry, vs. a clean result — positive or negative — it
// can trust as definitive). One body, two callers wrapping it differently, instead of two
// hand-copied bodies drifting apart on a future landing-queue.mjs shape change.
function queueStatusRawQuery(state) {
  const D = landDeps();
  const st = JSON.parse(D.spawn.node('landing-queue.mjs', 'status', '--json'));
  const mine = (st.entries || []).find((e) => e.slug === state.slug) || null;
  return { total: st.total || 0, position: mine ? mine.position : 0, mine };
}

// The live queue view feeding the requeue trip: our own entry (for enqueuedIso), our
// position, and the total. null on any failure — the trip then refuses (hold as today).
export function queueStatusView(state) {
  const D = landDeps();
  // DRY test hook: DW_FAKE_QUEUE_STATUS injects the view (mirrors DW_FAKE_QUEUE_POS).
  if (D.env.DRY) {
    try {
      return process.env.DW_FAKE_QUEUE_STATUS ? JSON.parse(process.env.DW_FAKE_QUEUE_STATUS) : null;
    } catch {
      return null;
    }
  }
  try {
    return queueStatusRawQuery(state);
  } catch {
    return null;
  }
}

// Stamp when THIS queue residency first reached the head slot — the requeue trip's
// cumulative head-hold clock. Re-invocations of a holding halt keep the stamp (same
// entryEnqueuedIso); a fresh residency (re-enqueued after an abort, or post-requeue)
// re-stamps and zeroes the event tallies. Best-effort; called from queueEnqueueAndGate
// the moment position 1 is reached.
// `pidAlreadyStamped` (plan 2266): true when the caller already issued a pid-carrying
// heartbeat THIS invocation (queueEnqueueAndGate's own waited/resume call, immediately
// before this runs) — skips the redundant second coordWrite in that case.
function markHeadAcquired(state, { pidAlreadyStamped = false } = {}) {
  const D = landDeps();
  if (D.env.DRY) return;
  try {
    const MAIN = state.main || D.coordGit.resolveMain(); // review 1528 [4]: never re-resolve when the spine already did
    const enqIso = queueStatusView(state)?.mine?.enqueuedIso || null;
    const prior = readLandAttempt(MAIN, state.slug) || {};
    // A residency is FRESH only when provably so: no stamp yet, or BOTH the prior and the
    // live enqueuedIso are known and differ. A prior stamped while queueStatusView was
    // transiently failing (entryEnqueuedIso null) must NOT read as fresh on the next,
    // successful call — that would reset the heavy-rework clock + conflict tally mid-attempt
    // (review 1528 [0]); instead BACKFILL the identity and keep the counters.
    const fresh =
      !prior.headAcquiredIso ||
      (enqIso && prior.entryEnqueuedIso && prior.entryEnqueuedIso !== enqIso);
    if (fresh) {
      writeLandAttempt(MAIN, state.slug, {
        slug: state.slug,
        entryEnqueuedIso: enqIso,
        headAcquiredIso: new Date().toISOString(),
        // plan 2453 reset site 1/3 — structural, never enumerated: every registered event
        // kind is zeroed per-residency because freshTallies() derives from the registry.
        tallies: D.L.freshTallies(),
        requeueCount: prior.requeueCount || 0,
      });
    } else if (enqIso && !prior.entryEnqueuedIso) {
      writeLandAttempt(MAIN, state.slug, { ...prior, entryEnqueuedIso: enqIso });
    }
    // plan 2266 item 1 (review fix): stamp THIS PROCESS's pid (+ existing host) into the
    // QUEUE ENTRY itself — not just the local sidecar above — riding the existing
    // heartbeat command. Deliberately UNCONDITIONAL on `fresh`: `fresh` tracks residency
    // identity for the requeue-trip bookkeeping above, but the pid must track WHICH
    // PROCESS IS CURRENTLY RUNNING, which is a different question — a crashed/restarted
    // process resuming the SAME residency (same enqueuedIso, `fresh` false) runs under a
    // NEW OS pid, and gating the stamp on `fresh` left the OLD, now-dead pid recorded for
    // the rest of that residency (CONFIRMED review finding: a live resumed land could
    // then be mechanically "reaped" out from under itself by a waiter reading the stale
    // dead pid). A later waiter's mechanical steal-verdict (landing-queue-lib.mjs) can
    // then prove, on a SAME-host stale head, that THIS exact process is gone — no human
    // --confirm-holder-gone needed (the 2208 incident: a dead head wedged the FIFO for
    // hours because nothing but a human noticing could reclaim it). Skipped only when
    // the caller already stamped it moments ago in this same invocation (avoids a
    // redundant back-to-back coordWrite push under 5-7 parallel sessions). Best-effort,
    // covered by this function's own outer try/catch: a failed stamp only means that
    // later check falls back to the pre-2266 manual path, same as today.
    // plan 2437: fold the IN_LAND stamp (formerly markQueueInLand's own separate
    // coordWrite, unconditional right after this function returns — see the call site
    // in queueEnqueueAndGate) into THIS heartbeat call, one mutateQueue instead of two.
    // Only reachable here, not the pidAlreadyStamped branch (that call is skipped
    // entirely there; the call site stamps IN_LAND standalone in that branch instead).
    // review fix: routed through bestEffortQueueCall (not a bare node() swallowed by
    // this function's own silent outer catch) — plan 2414 made IN_LAND-stamp failures
    // loud on purpose (the incident: a silent mark-in-land failure reopened the
    // free-lane demote hole with no distinguishing symptom), and the fold must not
    // regress that back to silent.
    if (!pidAlreadyStamped) {
      // plan 2485: `--progress` rides this fold too — this IS the head-acquisition stamp
      // (the twin of the `heartbeatedHere` call above, for the branch where that one was
      // skipped), so the convergence clock gets its baseline on BOTH paths. Missing it on
      // this branch would leave every non-waited/non-resumed residency with a null
      // progressIso, i.e. permanently convergence-immune.
      bestEffortQueueCall(
        state,
        [
          'heartbeat',
          state.slug,
          '--pid',
          String(process.pid),
          '--state',
          D.landingQueueLib.IN_LAND_STATE,
          '--progress',
        ],
        'heartbeat+mark-in-land',
      );
    }
  } catch {
    /* best-effort — no stamp just means the head-hold arm can't trip */
  }
}

// After a successful requeue, nothing of the head TENURE may stay held: release the
// exclusive-lane landing-lock (idempotent — it may be held over from a PRIOR holding halt whose
// process state this resumed invocation can't see) and flip the board LANDING row back
// to ACTIVE (plan 1528 B4(b): no stranded LANDING rows; ACTIVE is honest — the session
// is actively reworking). Free lane never acquired either — clean no-op.
function releaseHeadTenureAfterRequeue(state) {
  const D = landDeps();
  if (state.lane !== D.L.EXCLUSIVE_LANE) return;
  try {
    D.spawn.node('landing-lock.mjs', 'release', state.slug);
  } catch {
    /* not held / already released */
  }
  try {
    D.spine.coordStep(
      state,
      () => D.spawn.node('board.mjs', 'set-state', D.spine.landingBoardSlug(state), 'ACTIVE'),
      `board ACTIVE ${D.spine.landingBoardSlug(state)}`,
    );
  } catch (e) {
    const msg = `${e.stderr || ''}${e.stdout || ''}${e.message || ''}`;
    if (!D.L.isRowAbsentError(msg)) {
      (state.teardownErrors ||= []).push(
        `board ACTIVE after requeue ${D.spine.landingBoardSlug(state)}: ${e.message || e}`,
      );
    }
  }
  state.landingClaimed = false;
  state.landingReleased = true;
}

// plan 1528 Phase B: evaluate the requeue trip at a halt site and, when it fires,
// execute the requeue. `conflict: true` burns one conflict on the attempt counter
// FIRST (arm a counts per land attempt); `rework: true` is the arm-(b) signal (a
// marker re-pin refused on non-identical patch-ids). The queue mutation is ONE
// atomic coordWrite commit (landing-queue.mjs requeue — dequeue+enqueue can never
// end half-done, B4(a)); on ANY failure this falls back to { requeued: false } and
// the caller proceeds with today's HOLDING/halt behavior, saying so. On success the
// head tenure is fully released (mutex + board row) and state is marked so the
// finally never dequeues the fresh tail entry.
// plan 2170: the rework/reworkFamily opts are GONE — every rework halt now routes through
// dequeueForRework (position-preserving release); this trip serves the CONFLICT arms only.
// plan 2453: the event is passed as its KIND (a key of L.LAND_EVENT_KINDS, resolved from
// the caller's already-discriminated seam reason) and burns that kind's own keyed tally.
// Which kinds feed the content-conflict arm is the registry's business, not this
// function's — plan 2432's decided semantics (a lost ff-only push race is not branch
// content in conflict, so it feeds NO conflict arm) live there unchanged.
function maybeRequeueToTail(state, { kind = null } = {}) {
  const D = landDeps();
  // The ENTIRE evaluation is best-effort: it runs at conflict halt sites whose contract is
  // "hold the slot" — any internal throw escaping here would fall to main()'s finally and
  // release the mutex + FIFO slot (the plan-1174 slot-loss class this feature must never
  // reintroduce — review 1528 [3]). So every failure degrades to { requeued: false }.
  try {
    const MAIN = D.env.DRY ? null : state.main || D.coordGit.resolveMain();
    const attempt = readLandAttempt(MAIN, state.slug) || {};
    // ONE increment path for every kind (the pre-2453 if/else-if chain grew a branch per
    // event type). `attempt.tallies` is ALREADY the fully-normalized, zero-filled object —
    // readLandAttempt routes every record through migrateLandAttempt — so this trusts that
    // single normalization rather than re-deriving it (review 2453 [0]); the `|| freshTallies()`
    // covers only the no-sidecar case, where readLandAttempt returned null.
    // `kind` is registry-VALIDATED by the caller (requeueOnConflictOrReturn resolves it via
    // L.eventKindForReason, which returns null or a registered key and nothing else), so an
    // unregistered kind cannot reach this increment — the guard lives at that one reachable
    // boundary instead of being duplicated here as an unreachable branch (review 2453 [1]).
    const tallies = attempt.tallies || D.L.freshTallies();
    if (kind) {
      tallies[kind] = (tallies[kind] || 0) + 1;
      writeLandAttempt(MAIN, state.slug, { slug: state.slug, ...attempt, tallies });
    }
    const view = queueStatusView(state);
    // Only a PROVABLE head with the trip conditions met requeues; anything unprovable
    // (status failure, not position 1) holds as today — never a speculative dequeue.
    if (!view || view.position !== 1) return { requeued: false };
    const headHoldMin = attempt.headAcquiredIso
      ? Math.max(0, (Date.now() - Date.parse(attempt.headAcquiredIso)) / 60000)
      : 0;
    const trip = D.L.requeueTrip({
      tallies,
      headHoldMin,
      waitersBehind: Math.max(0, (view.total || 0) - 1),
      requeueCount: attempt.requeueCount || 0,
    });
    if (!trip.requeue) {
      console.error(`done-worktree: requeue trip not taken — ${trip.why} (plan 1528)`);
      return { requeued: false };
    }
    let queue = null;
    try {
      const out = D.spawn.node(
        'landing-queue.mjs',
        'requeue',
        state.slug,
        '--lane',
        state.lane,
        '--host',
        state.host,
        '--note',
        `heavy head rework: ${trip.arms.join('; ')} (plan 1528)`,
        '--json',
      );
      // The requeue op itself reports the fresh tail position — no second status round-trip
      // (review 1528 [13]). DRY's faked node() returns '' → queue stays null (reason omits it).
      try {
        queue = JSON.parse(out);
      } catch {
        /* unparseable/dry output — position just won't show in the reason */
      }
    } catch (e) {
      console.error(
        `done-worktree: requeue-to-tail FAILED (${e.message || e}) — falling back to ` +
          `hold-through-conflict with the head slot RETAINED (plan 1528 B4(a) fallback).`,
      );
      return { requeued: false };
    }
    // The fresh TAIL entry must survive this halt: requeuedToTail makes dequeueQueueIfHeld
    // a no-op (a distinct flag, NOT state.dequeued — the entry was moved, not removed, and
    // the terminal sidecar must not claim a dequeue that never happened; review 1528 [5]).
    state.queued = true;
    state.requeuedToTail = true;
    releaseHeadTenureAfterRequeue(state);
    writeLandAttempt(MAIN, state.slug, {
      slug: state.slug,
      entryEnqueuedIso: null,
      headAcquiredIso: null,
      // plan 2453 reset site 2/3 — a fresh tail residency starts EVERY tally at zero.
      tallies: D.L.freshTallies(),
      requeueCount: (attempt.requeueCount || 0) + 1,
    });
    return { requeued: true, arms: trip.arms, queue };
  } catch (e) {
    console.error(
      `done-worktree: requeue evaluation failed (${e.message || e}) — holding the slot as before plan 1528.`,
    );
    return { requeued: false };
  }
}

// plan 2517 (supersedes plan 2170 Ship 2's preserved-position half): release the queue
// slot for REWORK — a marker re-pin refused on non-identical patch-ids (review / decision /
// conclusion family) means source changed after the recorded decision: findings requiring
// code changes. That rework happens OUT of the lane (never on the head slot, never as a
// not-ready waiter drifting back to head); the released entry re-enters at the TAIL on its
// next enqueue (operator ruling, plan 2517: "a plan carries no priority... it shouldn't hog
// the head if it's not ready" — reversing plan 2170's preserved-position re-entry, which
// quietly re-granted the priority the 2026-07-10 "any session that isn't ready must leave
// its space at the head" directive removed). A `reenterPending` marker in the land-attempt
// sidecar tells the NEXT enqueue to route through the `reenter` verb (landing-queue.mjs) so
// the audit trail can still tell a rework re-entry from a first-time enqueue — position is
// no longer preserved. Supersedes plan 1528's requeue-to-tail for the rework arm ONLY;
// conflict trips keep the 1528 path (a patch-id change from resolving a rebase conflict is
// a resolution artifact — plan 1867 — so a rework signal at a nonzero content-conflict
// tally is left to the conflict arms, mirroring requeueTrip's own discrimination). Unlike
// the 1528 trip this fires at ANY queue position and with no waiters-behind gate: releasing
// a slot you are not ready to use is always correct. Best-effort like maybeRequeueToTail:
// any failure degrades to { dequeued: false } (the plain halt keeps the slot — exactly
// pre-2170 behavior).
export function dequeueForRework(state, reworkFamily) {
  const D = landDeps();
  try {
    const MAIN = D.env.DRY ? null : state.main || D.coordGit.resolveMain();
    const attempt = readLandAttempt(MAIN, state.slug) || {};
    // plan 2432: CONTENT conflicts only. A push-storm exhaustion never rewrites the tree, so
    // it can produce no resolution artifact and must not block a rework release — before the
    // counter split it incremented the shared counter and wrongly did. plan 2453: "which
    // kinds are content conflicts" is the registry's answer (conflictTallyTotal), so this
    // hold automatically covers a future content-conflict kind and automatically ignores a
    // future non-arm one — the same discrimination requeueTrip's arm (a) makes.
    // (review 2453 [0]: attempt.tallies is already normalized by readLandAttempt — trust it.)
    if (D.L.conflictTallyTotal(attempt.tallies || {}) > 0) {
      console.error(
        `done-worktree: rework signal during a conflicted attempt — resolution artifact ` +
          `(plan 1867), holding the slot (conflict arms govern).`,
      );
      return { dequeued: false };
    }
    // review 2170 [4]: the per-land-attempt starvation cap (L.REQUEUE_MAX, shared with the
    // conflict-arm requeue path) bounds rework dequeues too — a flaky review loop must not
    // churn the shared queue doc with unbounded dequeue+reenter coordWrite pairs. Past the
    // cap, the plain halt keeps the slot (pre-2170 behavior); requeueCount clears only on a
    // successful land (clearLandAttempt) or the 24h sidecar TTL.
    if ((attempt.requeueCount || 0) >= D.L.REQUEUE_MAX) {
      console.error(
        `done-worktree: rework dequeue cap reached (${attempt.requeueCount}/${D.L.REQUEUE_MAX} this ` +
          `land attempt) — holding the slot (starvation/churn guard, plan 2170).`,
      );
      return { dequeued: false };
    }
    const view = queueStatusView(state);
    if (!view || view.position < 1) return { dequeued: false }; // not queued / status unavailable
    try {
      D.spawn.node('landing-queue.mjs', 'dequeue', state.slug);
    } catch (e) {
      console.error(
        `done-worktree: dequeue-for-rework FAILED (${e.message || e}) — holding the slot as before plan 2170.`,
      );
      return { dequeued: false };
    }
    state.queued = false;
    state.dequeued = true; // the finally's dequeueQueueIfHeld no-ops — already released
    if (view.position === 1) releaseHeadTenureAfterRequeue(state);
    writeLandAttempt(MAIN, state.slug, {
      ...attempt,
      slug: state.slug,
      entryEnqueuedIso: null,
      headAcquiredIso: null,
      tallies: D.L.freshTallies(), // plan 2453 reset site 3/3 — structural, never enumerated
      requeueCount: (attempt.requeueCount || 0) + 1, // counts toward the shared cap above
      reenterPending: true,
    });
    console.error(
      `done-worktree: queue slot RELEASED for rework (${reworkFamily} marker, plan 2517) — ` +
        `re-entry lands at the TAIL (a plan carries no priority — operator ruling, plan 2517).`,
    );
    return { dequeued: true };
  } catch (e) {
    console.error(
      `done-worktree: dequeue-for-rework evaluation failed (${e.message || e}) — holding the slot.`,
    );
    return { dequeued: false };
  }
}

export function requeueOnConflictOrReturn(state, { reason } = {}) {
  const D = landDeps();
  const kind = D.L.eventKindForReason(reason);
  if (reason && !kind) {
    console.error(
      `done-worktree: land-attempt event reason "${reason}" maps to no registered kind — ` +
        `not counted (add it to L.LAND_EVENT_KINDS.<kind>.reasons, plan 2453).`,
    );
  }
  const rq = maybeRequeueToTail(state, { kind });
  if (rq.requeued) {
    // plan 2819: ARM KEEP-HOT ON THE REQUEUE. This is the one turn-ending seam that left the
    // slug enqueued with nothing warming it: the session's own watcher already exited when this
    // land reached head (watchVerdict treats position 1 as terminal), and until now the spine's
    // only auto-spawn was the QUEUE_WAIT seam-out. So the exact state that guarantees a cold
    // branch — just kicked to the TAIL, master moving, a full gate battery owed at head — was
    // also the state where nothing rebased it during the wait, which is how a requeue fed the
    // next requeue (58 events / 44 slugs in 26 days; 12 hit the REQUEUE_MAX=2 ceiling).
    //
    // `inProcessWaiterSurvives: false` UNCONDITIONALLY, not `wait || chunk` like the QUEUE_WAIT
    // site: emitSeam below process.exits, so no in-process poll loop survives this whatever the
    // invocation flags said — an attended `--wait` land is left exactly as cold as a bare one.
    // (`--wait-chunk` cannot reach here at all: a chunk call at head is WAIT-ONLY and seams out
    // before the land, plan 662 — so the plan-2551 "no detached child in a cloud sandbox"
    // rationale has no purchase at this site either. A cloud land reaches this seam as a BARE
    // invocation, i.e. precisely the case being armed.)
    //
    // Safe against the conflicted tree both call sites hand us: the rebase-conflict arm leaves
    // the rebase in progress deliberately, and runLandPrep already refuses exactly that state
    // (PREP_EXIT.BUSY) and never re-attaches a deliberately-detached HEAD — the watcher just
    // polls until the session resolves, then warms.
    autoSpawnQueueWatcher(state, { inProcessWaiterSurvives: false });
    D.spine.emitSeam(
      D.L.SEAM.LAND_BLOCKED_REQUEUED,
      D.L.requeuedReason(rq.arms, state.lane, rq.queue, state.slug),
      state,
    );
  }
}
