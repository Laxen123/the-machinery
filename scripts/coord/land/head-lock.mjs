// scripts/coord/land/head-lock.mjs — plan 3961 T3.4: the land spine's head-lock mechanics, moved
// out of scripts/done-worktree.mjs behaviour-identical (parity proven by this migration's
// parity-test suite against committed goldens, plus the full legacy test suite, both unchanged
// by this move).
//
// WHAT THIS MODULE OWNS. The plan-2473 worktree-lock interlock that keeps a `--prep` pass and
// the head-time land from ever rebasing + force-pushing the same worktree branch at once: taking
// and dropping the lock (worktreeLockFor/takeWorktreeLock/dropWorktreeLock), the pre-preflight
// acquire that blocks/seams/exits depending on call contract (acquireWorktreeBeforePreflight),
// the head-hold-clock adjustment for time spent waiting on a live prep (rebaseHeadHoldClock), the
// renew-or-detect-reaped check (renewOrAbort) and its thrown signal (WorktreeLockLost), the
// head-time BOUNDED wait-then-preempt acquisition itself (acquireWorktreeLockAtHead, with its
// nested holder-read and preemption helpers), the wait-tally sidecar
// (readHeadLockWaitTally/writeHeadLockWaitTally) that carries the accumulated wait forward across
// chunked re-invocations, and the same-PC landing-mutex release trio
// (releaseMutexIfHeld/releaseHeldSlotBestEffort). It is generic — no project-specific vocabulary
// anywhere in this file; the *_CHUNKED mentions are done-worktree-lib.mjs SEAM enum member
// names, not any one project's gate literals.
//
// HOW THIS MODULE REACHES THE REST OF THE WORLD. A non-test module under scripts/coord/ may
// import only scripts/coord/** and node: builtins (Rule 3,
// docs/coord/scripts-layout.md) — so every one of the plain scripts/*.mjs modules this
// code used to reach directly is instead read off the bound dependency container, `landDeps()`
// (scripts/coord/land/deps.mjs), AT CALL TIME, inside each function — never at module top level.
// `D` (this module's convention: `const D = landDeps();` as the first line of every function that
// needs it) is the same one-letter binding every other scripts/coord/land/*.mjs core module uses
// for the same reason. `chunk-gate.mjs` and `queue.mjs` are SIBLING core modules under
// scripts/coord/land/ (chunk-gate.mjs moved at T2.0a, queue.mjs at T3.3), so
// `monotonicNowMs`/`parsePrepushPositiveInt`/`landPreflightChunkOptions` and
// `makeQueueHeartbeatStamper`/`queueHeartbeat`/`readLandAttempt`/`writeLandAttempt`/
// `dequeueQueueIfHeld` are imported from them directly, no container needed.
//
// THE `spine` GROUP. `chunkGateStartDecision` and `noStartGateResult` join `spine` with this
// move: both are called by `acquireWorktreeLockAtHead` (the chunk-cap/no-start-gate composition
// every other chunk-capped gate in done-worktree.mjs goes through too — the build gate and the
// suite gates each have their own call sites), so neither can move here. `worktreeLock`
// (the whole worktree-lock.mjs namespace: resolveWorktreeLockPath, acquireWorktreeLock,
// renewWorktreeLock, releaseWorktreeLock, readWorktreeLockEntry, terminateWorktreeLockHolder,
// describeWorktreeLockHolder) was ALREADY a `LAND_DEPS_GROUPS` member, so those seven become
// `D.worktreeLock.<name>` with no new group. `worktreeLockFor` LEAVES the `spine` group this
// move — it joined at T3.3b only so queue.mjs's dispatchLandPrep could reach it before this step
// carved it out; queue.mjs now imports it from here directly instead (see deps.mjs's own comment
// and queue.mjs's one updated call site).
//
// THE EXIT-HOOK SPLIT. done-worktree.mjs used to run ONE combined `process.on('exit', …)`
// callback that both released every held worktree lock (`heldWorktreeLocks`, a `const Map` —
// mutated, never reassigned, so it moves here intact: mutation through a shared reference crosses
// a module boundary even though reassignment does not) AND disarmed
// `armRetainedEntryHeartbeat`'s queue-heartbeat interval (`_retainedEntryHeartbeatDisarm`, a
// spine `let` reassigned from `phaseLaneMerge` — an ES module's private binding is unreachable
// from another module, so it and its disarm half stay in done-worktree.mjs). This module now
// registers its OWN `process.on('exit', …)` listener for the lock-release half alone, at import
// time; done-worktree.mjs keeps a listener for the disarm half. Node runs `exit` listeners in
// REGISTRATION order — this module is imported (and so registers its listener) before
// done-worktree.mjs registers its own — so the lock-release still runs first, exactly the order
// the one combined callback ran its two halves in before the split. Neither half depends on the
// other: both are best-effort cleanups over disjoint state, so the split changes nothing an
// observer could see either order would not already have produced.
//
// FORWARD DEPENDENCY. `renewOrAbort` and `WorktreeLockLost` are exported here but 9 of
// `renewOrAbort`'s ~10 call sites and the one place `WorktreeLockLost` is thrown/caught still live
// in the not-yet-carved prep-gates/preflight machinery (runPrepGates/runLandPrepLocked, headed for
// a later T3 step) — done-worktree.mjs imports both back and keeps calling them from there for
// now.
//
// EXPORTS. `releaseMutexIfHeld`/`releaseHeldSlotBestEffort` are called by done-worktree.mjs's own
// crash path and teardown (imported back below). `worktreeLockFor`/`takeWorktreeLock`/
// `dropWorktreeLock`/`acquireWorktreeBeforePreflight`/`rebaseHeadHoldClock`/
// `acquireWorktreeLockAtHead` are called by done-worktree.mjs's own phasePreflight/phaseLaneMerge
// (imported back) and — `takeWorktreeLock`/`dropWorktreeLock` only — by
// scripts/coord/land/queue-probe.mjs's `attemptPreconverge` once T3.4b carves it out (a
// sibling-core-module reach, no container needed). `readHeadLockWaitTally`/
// `writeHeadLockWaitTally`/`heldWorktreeLocks`/`_worktreeLockPathCache` have no caller outside
// this module's own cluster and stay module-private.
//
// A PURE MOVE. Every moved function is byte-identical to its done-worktree.mjs original apart
// from the mechanical container-access rewrites (`L.foo(` → `D.L.foo(`, `DRY` → `D.env.DRY`,
// `emitSeam(` → `D.spine.emitSeam(`, and so on), the `export` keyword added where a caller outside
// this module needs it, the `const D = landDeps();` first line every function that needs the
// container gained, and the exit-hook registration split described above — no renames, no
// reordering, no incidental fixes. Every comment moved with its function; they carry the plan
// history that explains the code.

import { readFileSync, mkdirSync } from 'node:fs';
import { landDeps } from './deps.mjs';
import {
  monotonicNowMs,
  parsePrepushPositiveInt,
  landPreflightChunkOptions,
} from './chunk-gate.mjs';
import {
  makeQueueHeartbeatStamper,
  queueHeartbeat,
  readLandAttempt,
  writeLandAttempt,
  dequeueQueueIfHeld,
} from './queue.mjs';

// plan 4066 task 0: the member-level container-read manifest for this module — see
// preflight.mjs's own CONTAINER_READS comment for what asserts it and when, and
// container-manifest.mjs's header for the aggregator itself. Generated, not hand-typed;
// regenerate with the same scanner on a real change to this file's container reads.
export const CONTAINER_READS = Object.freeze({
  L: Object.freeze([
    'PREP_EXIT',
    'SEAM',
    'UNIDENTIFIABLE_HOLDER_IDENTITY',
    'headLockHolderIdentity',
    'headLockPollAction',
    'headLockPreemptAction',
    'headLockWaitBudget',
    'isRowAbsentError',
    'mutexHeld',
    'nextHeadLockWaitTally',
    'parseHeadLockWaitTally',
    'worktreeLockHeadAction',
  ]),
  atomicWrite: Object.freeze(['atomicWriteTextSync']),
  coordGit: Object.freeze(['resolveMain', 'sleepSync']),
  env: Object.freeze(['DRY', 'IS_PREP']),
  spawn: Object.freeze(['node', 'run']),
  spine: Object.freeze([
    'chunkGateStartDecision',
    'coordStep',
    'emitSeam',
    'landingBoardSlug',
    'noStartGateResult',
    'stepLog',
  ]),
  worktreeLock: Object.freeze([
    'WORKTREE_LOCK_RENEW_MS',
    'acquireWorktreeLock',
    'describeWorktreeLockHolder',
    'readWorktreeLockEntry',
    'releaseWorktreeLock',
    'renewWorktreeLock',
    'resolveWorktreeLockPath',
    'terminateWorktreeLockHolder',
  ]),
});

export function releaseMutexIfHeld(state) {
  const D = landDeps();
  if (!D.L.mutexHeld(state)) return;
  // plan 793: free the same-PC landing-lock FIRST and INDEPENDENTLY of the board demote. It is
  // the HARD landing mutex that serializes the lane — a board-demote foreign-dirt failure must NEVER
  // skip it (the 2026-06-18 session-718 strand: set-state threw on a sibling's transient dirt
  // BEFORE the lock release ran, orphaning the lock + wedging a sibling 🟥 land). landing-lock
  // release is idempotent + by-slug, so a failure here is only ever an unexpected IO error →
  // record it, never crash. landingReleased is set ONLY on a SUCCESSFUL release (inside the try):
  // the moment the HARD lock is truly gone the "finally" can't re-enter — but if the release
  // unexpectedly threw, landingReleased stays false so a re-entry (or a re-run) re-attempts it
  // rather than masking an un-freed lock (review finding, plan 793).
  try {
    D.spawn.node('landing-lock.mjs', 'release', state.slug);
    state.landingReleased = true;
  } catch (e) {
    (state.teardownErrors ||= []).push(`landing-lock release ${state.slug}: ${e.message || e}`);
  }
  // Demote the board LANDING row → IN-PROGRESS (advisory cross-PC signal). Best-effort:
  //  - Bug B (plan 367): on the success/teardown path the row was ALREADY removed (board.mjs
  //    remove), so `set-state … IN-PROGRESS` fails "row not found" — a benign already-released.
  //  - plan 793: a sibling's TRANSIENT foreign-dirt is retried (coordStep forces the retry once
  //    merged); an EXHAUSTED retry post-merge is recorded, NOT rethrown — the hard mutex is
  //    already freed and a bare re-run heals the row, so an advisory demote must never crash an
  //    irreversibly-landed merge. PRE-merge a genuine board error still propagates (main()'s
  //    catch then converts a coordContention to the clean COORD_CONTENTION seam).
  try {
    D.spine.coordStep(
      state,
      () => D.spawn.node('board.mjs', 'set-state', D.spine.landingBoardSlug(state), 'IN-PROGRESS'),
      `board demote ${D.spine.landingBoardSlug(state)}`,
    );
  } catch (e) {
    const msg = `${e.stderr || ''}${e.stdout || ''}${e.message || ''}`;
    if (D.L.isRowAbsentError(msg)) return;
    if (state.mergeSha) {
      (state.teardownErrors ||= []).push(
        `board demote ${D.spine.landingBoardSlug(state)}: ${e.message || e}`,
      );
      return;
    }
    throw e;
  }
}

// plan 2411 review fix (sonnet-review high, PLAUSIBLE): the "release the mutex, swallow+record
// any throw, then dequeue" sequence is needed at TWO sites — the crash-path catch (which must
// release BEFORE writing the sidecar, so `dequeued`/`landingReleased` are true in the sidecar
// instead of stale — see D3 below) and this function's own finally (the backstop for every
// OTHER exit path, and a no-op here on the crash path since both calls are state-guarded
// idempotent). One shared helper keeps the two sites from drifting on a future change to the
// release-cleanup contract; `context` only varies the recorded teardownErrors message so a
// reader can tell which call site actually performed the release.
export function releaseHeldSlotBestEffort(state, context) {
  try {
    releaseMutexIfHeld(state);
  } catch (releaseErr) {
    (state.teardownErrors ||= []).push(
      `mutex-release cleanup (${context}): ${releaseErr.message || releaseErr}`,
    );
  }
  dequeueQueueIfHeld(state);
}

// ── plan 2473: the worktree-scoped prep ⇄ land ownership handshake ───
// A `--prep` pass and the head-time land both rebase + force-push THIS worktree's branch.
// `worktree-lock.mjs` is the mutex that keeps them from ever overlapping; this section is the
// spine's side of it — take/release, the head-time BOUNDED wait with preemption, and the
// detached dispatch that finally makes the prep fire for every waiting land instead of only
// under an opt-in watcher nobody runs (measured coverage before this plan: a marker on 15 of
// 1704 head lands, the fast path firing once).

// How long the head-time land waits for a live prep child before preempting it. Sized ABOVE the
// battery it is waiting on — the pre-push gate battery is quantified at ~15-27 min in land-lib's
// plan-2433 comment, so the bound is 30 min, past its UPPER end (review 2473 [4]: 20 min sat
// INSIDE that range, so a legitimately-slow-but-healthy prep would be preempted at exactly the
// moment it was about to pay off). Waiting rather than killing is the cheaper trade: if the prep
// finishes, the at-head re-check fast-paths the whole battery, so waiting out a prep that is
// minutes from done costs LESS head time than killing it and paying the battery ourselves. The
// bound exists for the WEDGED holder, not the slow one — and it stays below
// WORKTREE_LOCK_MAX_HOLD_MS (40 min) so preemption, not the staleness ceiling, is what resolves
// a wedge at head.
// plan 3453 G5 (gpt-review round 2, finding 1327fa): `Number(raw || 1800)` turns a non-numeric
// `DW_HEAD_LOCK_WAIT_SEC` (a typo, e.g. "abc") into `NaN` — and every `>=` comparison against `NaN`
// is false, so BOTH the holder-exhaustion check and (via `chunkGateStartDecision`'s own
// `naturalTimeoutMs`) the attempt-exhaustion check silently stop firing, turning the one bound this
// whole plan exists to enforce into an unbounded wait reachable by a single mistyped env var. Reuses
// this file's own validated parser (`parsePrepushPositiveInt`, defined below and already used by
// `chunkGateConfig` for the sibling PREPUSH_* knobs) instead of a second hand-rolled check — it
// takes a STRING and returns `null` for anything that is not a plain positive integer, so an invalid
// value falls back to the 1800s default exactly like an absent one always has.
const HEAD_LOCK_WAIT_MS =
  (parsePrepushPositiveInt(process.env.DW_HEAD_LOCK_WAIT_SEC) ?? 1800) * 1000;
const HEAD_LOCK_POLL_MS = 10_000;
// How long a preempted holder gets to die from SIGTERM before SIGKILL.
const PREEMPT_GRACE_MS = 5_000;
// plan 3453 G4 (gpt-review round 2, finding dfcc2a): a preemption is SIGTERM + PREEMPT_GRACE_MS +
// SIGKILL + the stale-lock clear + `git rebase --abort` + a re-acquire — comfortably more wall-clock
// than the single HEAD_LOCK_POLL_MS reserve `attemptExhausted()` requires for an ORDINARY poll. A
// chunk wall firing mid-preemption is the worst possible moment to be killed (see
// `preemptReserveExhausted` at its own call site). Sized as PREEMPT_GRACE_MS itself plus a stated
// margin for the two subprocess calls and the reacquire — normally fast, but not assumed instant
// under load — never a bare magic number.
const HEAD_LOCK_PREEMPT_RESERVE_MS = PREEMPT_GRACE_MS + 25_000;

// plan 3453 D8 (ruling on finding 31dc49): consecutive lock-READ throws (EACCES/EBUSY/EPERM out of
// excl-lock.mjs's readExclusive — see acquireWorktreeLockAtHead's own header) before the wait gives
// up rather than fails open. ~30s at HEAD_LOCK_POLL_MS: long enough to ride out a transient AV scan
// or sync-tool lock without letting a genuinely wedged read block the land for an unbounded time
// nobody can see progress in.
const HEAD_LOCK_INDETERMINATE_POLLS = 3;

// ── plan 3453 D4: the head-lock-wait accumulated-duration sidecar ────────────────────────────
//
// Worktree-local, same lifetime reasoning as NO_START_SIDECAR_REL below (gitignored, dies with the
// worktree teardown, visible to a re-invocation and to a --prep child) — see that section's own
// header for why neither the content ledger nor the plan-3295 gatesProven store is the right home.
// A SEPARATE file rather than folding into that one: the no-start tally is keyed by HEAD SHA (a new
// commit is a new series) while this one is keyed by HOLDER TOKEN (a new holder is a new series) —
// different reset keys, so one JSON object would let one series's reset silently clobber the other.
const HEAD_LOCK_WAIT_SIDECAR_REL = '.scratch/land-head-lock-wait.json';
const headLockWaitSidecarPath = (wtPath) => `${wtPath}/${HEAD_LOCK_WAIT_SIDECAR_REL}`;

// Modelled on readNoStartTally below (plan 3436 D2): anything unreadable/malformed reads as "no
// tally yet" (parseHeadLockWaitTally's own contract), which costs at most one extra window and can
// never cause a false preempt — the safe direction, per D4. `acquireWorktreeLockAtHead` itself
// already returns under DRY before either of these is ever called; the guards below are kept anyway
// so both stay independently safe if a future caller reaches them without that escape.
function readHeadLockWaitTally(wtPath) {
  const D = landDeps();
  if (D.env.DRY) return null;
  try {
    return D.L.parseHeadLockWaitTally(readFileSync(headLockWaitSidecarPath(wtPath), 'utf8'));
  } catch {
    return null; // absent/unreadable ⇒ no wait counted ⇒ one extra window, never a false preempt
  }
}

// Best-effort, but NEVER silent — same reasoning as writeNoStartTally below (gpt-review
// 800aae/5e31e7/557e57/6ecc7e class): a land must not fail because a `.scratch` write did, but a
// write that always fails means D4's per-poll carry-forward silently stops working, and the
// original bare-swallow made that indistinguishable from a healthy run.
//
// plan 3453 F4 (gpt-review round 1: 8ad011/c3adfc/998cfb/0c1292/4eed45/c81331): this sidecar is
// concurrently READ by re-invocations too (a chunked re-invoke resumes from whatever the previous
// invocation last wrote), so — unlike `writeNoStartTally` beside it, whose plain write is
// pre-existing and out of this plan's scope — a mid-write failure here can leave a TORN file that
// the next invocation then reads as "no tally at all", restarting the holder clock exactly like an
// outright write failure would. `atomicWriteTextSync` (rename-based, already imported) closes that:
// a reader always sees either the OLD complete file or the NEW one, never a partial write.
//
// Returns whether the write succeeded — the caller (acquireWorktreeLockAtHead) counts CONSECUTIVE
// failures across polls and halts once that count reaches HEAD_LOCK_INDETERMINATE_POLLS: this file
// is not decoration, it IS the cross-invocation holder-wait bound (D4), so while it cannot be
// persisted, the 30-minute preempt threshold can never be reached — continuing regardless would swap
// a bounded wait for an unbounded chain of wait-then-seam-then-re-invoke that never converges.
function writeHeadLockWaitTally(wtPath, payload) {
  const D = landDeps();
  if (D.env.DRY) return true;
  try {
    mkdirSync(`${wtPath}/.scratch`, { recursive: true });
    D.atomicWrite.atomicWriteTextSync(
      headLockWaitSidecarPath(wtPath),
      JSON.stringify(payload, null, 2),
    );
    return true;
  } catch (e) {
    console.error(
      `done-worktree: could not persist the head-lock wait tally (${e.message || e}) — the holder ` +
        `clock for this poll is not carried forward; a call killed before the next successful write ` +
        `restarts this holder's wait from zero rather than resuming it.`,
    );
    return false;
  }
}

// Every worktree lock this process holds, released by the `exit` hook below. That hook is the
// load-bearing release point, NOT a nicety: `emitSeam` calls `process.exit()` directly, so a
// `finally` around the land body would be skipped on every seam halt and the lock would survive
// its holder — making the next invocation wait out HEAD_LOCK_WAIT_MS before preempting a process
// that is already gone.
const heldWorktreeLocks = new Map(); // lockPath → token
// plan 4034 T1: every lock path whose renewal came back FALSE — our token is no longer in the
// file, so another process reaped and retook this tree while we were inside a gate. Separate from
// `heldWorktreeLocks` (which the renewal deletes the entry from) because the FACT must outlive the
// entry: `renewOrAbort` consults this set FIRST, so a loss the background timer noticed mid-gate
// still fires the existing lock-lost seams at the next check point rather than being papered over
// by a renewal that would now (correctly) refuse a lock we do not hold.
const lostWorktreeLocks = new Set(); // lockPath

// plan 4034 T1: the process-wide heartbeat that keeps every held worktree lock fresh WHILE a gate
// runs. Before that plan nothing renewed during a gate at all: the gate runner renews only BETWEEN
// gates, and the plain land path never renewed once — it took the lock before preflight and
// dropped it after the battery, so the heartbeat stamp stayed at the start time for the WHOLE
// pre-enqueue sequence and the staleness ceiling bounded the SUM of every gate rather than any one
// of them. THAT is why the land's heavy-gate caps sat pinned at 2400s for as long as they did (see
// plan 4003 T3's refusal note): the cap was the lock's hold limit reused as a run limit, and a
// ~45-minute suite was killed at 99% of its work. Renewing mid-gate is what let plans 4034 T3/T4
// derive those caps from the work instead — the two changes are one argument, not two.
//
// WHY A TIMER IS SOUND HERE. Every heavy gate spawns asynchronously and awaits, so the event loop
// IS free for the minutes the gate runs and this interval fires. The synchronous git calls block it
// for at most a minute or two, which the ceiling absorbs unchanged.
//
// WHY IT DOES NOT RESURRECT A WEDGED HOLDER. The timer only fires while this process's event loop
// is alive, so a parent that is genuinely hung stops renewing and the ceiling still reaps it; a
// hung CHILD is bounded by that gate's own cap. Both arms still terminate — which is the property
// the ceiling exists for, and the one a blanket cap raise would have broken.
//
// It lives HERE rather than in the command file (where plan 4034 first wrote it) because it is a
// pure reader/writer of `heldWorktreeLocks` and `lostWorktreeLocks`, both of which are this
// module's own private state since the T3.4 carve — and because the exit hook's ordering
// guarantee (disarm before release) is only a guarantee while both halves sit in ONE listener.
//
// `.unref()` so a forgotten interval can never hold the process open past its own exit.
let _worktreeLockRenewTimer = null;

// The tick's whole body, taken as PARAMETERS rather than read from module state, so the one thing
// that actually needs proving — a refused renewal drops the entry AND records the loss, in that
// order, without disturbing the locks that renewed fine — is unit-testable with no timer, no real
// lock file, and no clock. (The repo's ambient-load rule, plan 4005: drive the fixture's own
// signal, never race a real timer.) Returns the paths it lost, for the caller and the test alike.
export function renewLockSet(held, lost, { _renew, _warn = console.error } = {}) {
  const renew = _renew ?? ((path, token) => landDeps().worktreeLock.renewWorktreeLock(path, token));
  const lostNow = [];
  // Iterate a COPY: the loop deletes from `held`, and a live Map iterator plus delete is the kind
  // of subtlety that works until the day it does not.
  for (const [path, token] of [...held]) {
    if (renew(path, token)) continue;
    held.delete(path); // it is not ours to release any more
    lost.add(path);
    lostNow.push(path);
    _warn(
      `done-worktree: worktree lock ${path} was REAPED mid-gate — another process now owns this ` +
        `tree. The next gate boundary will abort rather than record a proof for a tree we do not ` +
        `own (plan 4034 T1).`,
    );
  }
  return lostNow;
}

function renewHeldWorktreeLocks() {
  renewLockSet(heldWorktreeLocks, lostWorktreeLocks);
  if (heldWorktreeLocks.size === 0) disarmWorktreeLockRenewal();
}

export function armWorktreeLockRenewal() {
  if (_worktreeLockRenewTimer) return;
  const D = landDeps();
  _worktreeLockRenewTimer = setInterval(
    renewHeldWorktreeLocks,
    D.worktreeLock.WORKTREE_LOCK_RENEW_MS,
  );
  _worktreeLockRenewTimer.unref?.();
}

export function disarmWorktreeLockRenewal() {
  if (!_worktreeLockRenewTimer) return;
  clearInterval(_worktreeLockRenewTimer);
  _worktreeLockRenewTimer = null;
}

// plan 3961 T3.4: this `exit` listener owns ONLY the lock-release half of what was, in
// done-worktree.mjs, a single combined `process.on('exit', …)` callback also disarming
// `armRetainedEntryHeartbeat`'s interval (`_retainedEntryHeartbeatDisarm`, a spine `let`
// reassigned from `phaseLaneMerge` — it cannot move here, an ES module's private binding is
// unreachable from another module). Node runs `exit` listeners in registration order: today
// this module's own listener registers at import time, BEFORE done-worktree.mjs registers its
// own (kept) listener for the disarm half — so the lock-release still runs first, exactly the
// order the single combined callback ran its two halves in before this split. Neither half
// depends on the other (both are best-effort cleanups over disjoint state — this one over
// `heldWorktreeLocks`, the other over `_retainedEntryHeartbeatDisarm`), so the split changes
// nothing observable either order would not already have produced.
process.on('exit', () => {
  // plan 3961 review fix: bail BEFORE resolving the container when no lock is held. This
  // listener registers at IMPORT time, but `landDeps()` throws until `bindLandDeps()` runs
  // later in done-worktree.mjs — so an exit between import and bind (an argv error, another
  // module's import-time throw) used to fire this handler, which threw resolving `D` and masked
  // the real error behind a confusing dependency-container failure. No lock can be held before
  // the bind (nothing in this module acquires one that early), so this guard is behaviour-
  // identical on every real path — it only removes the throw on the early-exit path. It also
  // sits ahead of the disarm below for the same reason: with nothing held there is nothing to
  // stop renewing either.
  if (heldWorktreeLocks.size === 0) return;
  // plan 4034 T1: stop the heartbeat FIRST — a renewal that fired between the releases below and
  // the process actually dying would re-stamp a lock we just handed back.
  try {
    disarmWorktreeLockRenewal();
  } catch {
    /* best-effort — never mask an exit */
  }
  const D = landDeps();
  for (const [path, token] of heldWorktreeLocks) {
    try {
      D.worktreeLock.releaseWorktreeLock(path, token);
    } catch {
      /* the lock is pid-proved reapable the moment we exit — never mask an exit */
    }
  }
});

// Resolve this worktree's lock path; null when git can't answer (no repo / ancient git), which
// degrades the whole feature to pre-2473 behaviour rather than failing a land.
//
// MEMOISED (review 2473 [9]): resolution shells out to `git rev-parse --git-common-dir`, and the
// call sites include the queue poll loop — which runs every ~260 s for the whole queue residency —
// so an unmemoised resolve spawns a subprocess per tick for a value that cannot change within one
// invocation (the worktree path and slug are fixed at startup). Keyed by both anyway, so a future
// multi-worktree caller cannot collide.
const _worktreeLockPathCache = new Map();
export function worktreeLockFor(wtPath, slug) {
  const D = landDeps();
  const key = `${wtPath}\u0000${slug}`;
  if (_worktreeLockPathCache.has(key)) return _worktreeLockPathCache.get(key);
  let path = null;
  try {
    path = D.worktreeLock.resolveWorktreeLockPath(wtPath, slug);
  } catch (e) {
    // review 2473-r2 [3]: cache SUCCESS ONLY. `git rev-parse` can fail transiently under this
    // repo's 5-7-session load (a momentarily-locked .git, an EMFILE burst). Memoising that null
    // would silently disable the prep⇄land interlock for the REST of the invocation — the
    // corruption class this feature exists to close — off one unlucky subprocess. Not caching
    // means the next call site simply retries.
    console.error(
      `done-worktree: worktree-lock path unresolved (${e.message || e}) — the prep interlock is ` +
        `inactive for this call; retrying at the next one.`,
    );
    return null;
  }
  _worktreeLockPathCache.set(key, path);
  return path;
}

// NOTE the DRY guard: `--dry-run` has no real worktree, and this lock rendezvouses in the SHARED
// `.git` common dir — so a dry run that took it for real would write (and, on a killed run, leak)
// a lock file that a LIVE sibling land then has to wait out. The dry-run harness runs the spine
// dozens of times per suite against fixture slugs; none of that may reach a real lock. Every entry
// point is guarded HERE rather than at each call site, so a future caller cannot forget.
export function takeWorktreeLock(wtPath, slug, owner) {
  const D = landDeps();
  if (D.env.DRY) return { path: null, token: null, holder: null };
  const path = worktreeLockFor(wtPath, slug);
  if (!path) return { path: null, token: null, holder: null };
  const r = D.worktreeLock.acquireWorktreeLock(path, { owner, slug });
  if (!r.ok) return { path, token: null, holder: r.holder };
  // plan 4034 T1: a freshly-acquired lock is ours again, whatever a previous acquisition of this
  // same path lost — clear the stale loss before arming, or `renewOrAbort` would abort on a tree
  // we demonstrably hold.
  lostWorktreeLocks.delete(path);
  heldWorktreeLocks.set(path, r.token);
  armWorktreeLockRenewal(); // plan 4034 T1: empty → non-empty arms the heartbeat; idempotent after
  return { path, token: r.token, holder: null };
}

export function dropWorktreeLock(path, token) {
  const D = landDeps();
  if (D.env.DRY || !path || !token) return;
  heldWorktreeLocks.delete(path);
  // plan 4034 T1: nothing left to renew ⇒ nothing left to tick.
  if (heldWorktreeLocks.size === 0) disarmWorktreeLockRenewal();
  try {
    D.worktreeLock.releaseWorktreeLock(path, token);
  } catch {
    /* best-effort — a surviving lock is pid-proved stale once this process exits */
  }
}

// review 2473 [0] — THE MOST SEVERE FINDING, and the reason the lock is taken HERE rather than
// deeper in the land. `preflight()` calls land-lib's `recoverRebasedUnpushed`, which range-diffs a
// branch that is ahead of `origin/<branch>` and, when it classifies as a pure unpushed rebase, runs
// `git reset --hard origin/<branch>` on the worktree. That is exactly the state a HEALTHY prep child
// is in for most of its life: `tryRebase` rebases locally, then force-pushes — and that push runs
// the full ~15-27 min gate battery, so the branch sits ahead of its remote for the whole battery.
// A concurrent re-invocation's preflight would therefore hard-reset the branch out from under a
// live prep: the corrupted-rebase / lost-force-push class this plan exists to close, on a
// PRE-EXISTING call site that no lock covered. Latent before (the keep-hot watcher is opt-in and
// off), live the moment prep dispatch fires for every waiting land.
//
// Taking the worktree lock BEFORE preflight closes it structurally — preflight only ever runs when
// we own the tree — and needs no flag threaded into land-lib.
//
// What happens when someone else owns it is chosen per call contract, NOT one-size-fits-all:
//   * `--prep`: exit BUSY. A prep is speculative; a busy worktree means someone with a stronger
//     claim is already here.
//   * `--wait` / `--wait-chunk`: block, bounded by the caller's own budget. These modes exist to
//     block, so this is free; a chunk call returning QUEUE_WAIT for a same-turn re-invoke is
//     precisely its documented shape.
//   * plain `done-worktree <slug>`: seam QUEUE_WAIT immediately. That mode is contractually a
//     near-instant probe — blocking it is the exact call-contract break that made plan 2458 revert
//     its inline prep — and QUEUE_WAIT is the seam every caller (the cloud drain above all) already
//     handles as "not your turn yet, come back", so this needs no new code on the reading side.
// Deliberately NOT a hard failure in any mode: the holder is another cooperating process, and the
// answer is always "come back", never "this land is broken".
// Returns the acquired lock, or PREP_EXIT.BUSY when a `--prep` invocation must stand down (review
// 2473-r2 [5]: the prep's outcome goes back through main()'s single `process.exit(PREP_EXIT…)`
// funnel like every other prep result, instead of this helper exiting the process itself).
export function acquireWorktreeBeforePreflight(state, a) {
  const D = landDeps();
  if (D.env.DRY) return { path: null, token: null };
  // review 2473-r2 [1]: plain `--wait` is the ATTENDED, in-process, never-exiting poll — this
  // file's own contract (see queueEnqueueAndGate's header) says only `--wait-chunk` ever seams
  // QUEUE_WAIT. Giving `--wait` a bounded budget here made it silently exit to the shell whenever a
  // healthy prep outran the bound, which is exactly the population the bound is sized for.
  // Unbounded for `--wait`; the chunk's OWN budget for `--wait-chunk` (review [4]: the chunk
  // therefore never spends more than one chunk here, so the pre-preflight and at-head waits cannot
  // compound into two full HEAD_LOCK_WAIT_MS blocks for an unattended caller); zero for the plain
  // near-instant probe.
  const budgetMs = a.waitChunk ? a.waitChunk * 1000 : a.wait ? Infinity : 0;
  const deadline = Date.now() + budgetMs;
  let announced = false;
  const stampQueueHeartbeat = makeQueueHeartbeatStamper(budgetMs);
  for (;;) {
    const r = takeWorktreeLock(state.wtPath, state.slug, D.env.IS_PREP ? 'prep' : 'land');
    if (!r.path || r.token) {
      state.worktreeLock = r;
      return r;
    }
    const who = D.worktreeLock.describeWorktreeLockHolder(r.holder);
    if (D.env.IS_PREP) {
      console.error(
        `done-worktree --prep: ${state.slug}'s worktree is held by ${who} — skipping this prep.`,
      );
      return D.L.PREP_EXIT.BUSY;
    }
    // review 2473-r2 [8]: the SAME pure wait-vs-preempt predicate its sibling
    // acquireWorktreeLockAtHead uses, so the two waits can never drift apart on the bound.
    if (
      D.L.worktreeLockHeadAction({ acquired: false, nowMs: Date.now(), deadlineMs: deadline }) ===
      'preempt'
    ) {
      state.queuePosition = null;
      // plan 2505: stamp liveness BEFORE the seam exits the process — a bounded (--wait-chunk)
      // wait that exhausts its budget never reaches the poll-loop heartbeat below for THIS
      // iteration, since emitSeam never returns. (The zero-budget plain probe also lands here
      // on its first iteration, but the stamper is a no-op for it — see makeQueueHeartbeatStamper.)
      stampQueueHeartbeat(state);
      D.spine.emitSeam(
        D.L.SEAM.QUEUE_WAIT,
        `${who} is preparing ${state.slug}'s worktree (a land-prep rebases the branch and runs ` +
          `the full gate battery off-head, ~15-27 min). This land has NOT enqueued yet and holds ` +
          `nothing; re-invoke done-worktree when the prep finishes — its marker will usually let ` +
          `this land skip the whole battery. Prep log: ${state.main}/.scratch/land-prep-${state.slug}.log`,
        state,
        { keepQueue: true },
      );
    }
    if (!announced) {
      announced = true;
      D.spine.stepLog(
        state,
        `worktree lock: ${who} is preparing this worktree — waiting before preflight`,
      );
    }
    // plan 2505: mirror the at-head sibling (acquireWorktreeLockAtHead) — stamp on every
    // stand-down so the 45-min steal clock never fires while this land legitimately waits.
    stampQueueHeartbeat(state);
    D.coordGit.sleepSync(HEAD_LOCK_POLL_MS);
  }
}

// review 2473 [3]: push `headAcquiredIso` forward by however long this invocation spent WAITING for
// the worktree lock, so the plan-1528 head-hold budget (REQUEUE_HOLD_MIN, the "heavy rework →
// requeue to tail" trip) measures time spent working at head, not time spent idling for a prep to
// finish. Deliberately an ADJUSTMENT of the existing stamp rather than a fresh markHeadAcquired():
// that function's `fresh` logic would also zero the event tallies and re-derive residency identity, and
// the residency has NOT changed — only our start-of-work has. Best-effort, like every other
// land-attempt bookkeeping write: a failure just leaves today's (stricter) accounting.
export function rebaseHeadHoldClock(state, waitStartedMs) {
  const D = landDeps();
  if (D.env.DRY) return;
  try {
    const MAIN = state.main || D.coordGit.resolveMain();
    const prior = readLandAttempt(MAIN, state.slug);
    if (!prior || !prior.headAcquiredIso) return;
    const waitedMs = Date.now() - waitStartedMs;
    const shifted = new Date(Date.parse(prior.headAcquiredIso) + waitedMs);
    if (Number.isNaN(shifted.getTime())) return;
    writeLandAttempt(MAIN, state.slug, { ...prior, headAcquiredIso: shifted.toISOString() });
    D.spine.stepLog(
      state,
      `worktree lock: waited ${Math.round(waitedMs / 60000)} min for the prep — head-hold clock ` +
        `advanced so the wait is not charged as rework`,
    );
  } catch {
    /* best-effort bookkeeping — a failure only restores today's stricter accounting */
  }
}

// review 2473 [1]: renew, and report whether we STILL own the worktree. False means our token no
// longer matches — we were reaped and someone else is now writing this tree, so the caller must
// stop rather than keep mutating alongside them.
export function renewOrAbort(lock, slug, where) {
  const D = landDeps();
  // plan 3503 gpt-review round 3 (cluster 4) dry-only hook: DW_FAKE_LOCK_LOST_AT="<substring of
  // `where`>" makes the renewal at exactly that seam refuse. Real lock reaping needs a second live
  // process racing this one, so without this the "we no longer own this tree" arms — including the
  // rollback refusal cluster 4 is about — are unreachable from the --dry-run spine harness.
  // Honoured ONLY under --dry-run, like every DW_FAKE_*.
  if (D.env.DRY) {
    const at = process.env.DW_FAKE_LOCK_LOST_AT;
    if (at && where.includes(at)) {
      console.error(
        `done-worktree --prep: DRY DW_FAKE_LOCK_LOST_AT — LOST ${slug}'s lock ${where}.`,
      );
      return false;
    }
    return true;
  }
  if (!lock || !lock.token) return true;
  // plan 4034 T1: the background heartbeat may ALREADY have discovered the loss mid-gate. Consult
  // that first: without it a lock reaped-and-retaken during a gate would be re-read here only via
  // `renewWorktreeLock`, which is itself the thing that noticed — and once the entry is gone from
  // `heldWorktreeLocks` the fact must come from somewhere. This set is that somewhere, so the
  // existing lock-lost seams fire unchanged at the first check point after the loss.
  if (lostWorktreeLocks.has(lock.path)) {
    console.error(
      `done-worktree: LOST ${slug}'s worktree lock ${where} — the renewal heartbeat found our ` +
        `token gone earlier in this gate (plan 4034 T1). Aborting rather than acting on a tree ` +
        `another process now owns.`,
    );
    return false;
  }
  if (D.worktreeLock.renewWorktreeLock(lock.path, lock.token)) return true;
  heldWorktreeLocks.delete(lock.path); // it is not ours to release any more
  lostWorktreeLocks.add(lock.path); // plan 4034 T1: remember it, for the reason above
  console.error(
    `done-worktree --prep: LOST ${slug}'s worktree lock ${where} — it was reaped (this pass ` +
      `outlived the staleness ceiling while a gate blocked) and another process now owns the ` +
      `tree. Aborting this prep WITHOUT stamping a marker, so nothing downstream trusts a tree ` +
      `we no longer own.`,
  );
  return false;
}

// Thrown out of a gate runner when the lock is lost mid-battery (the runner's callback cannot
// return a prep exit code). Caught by runLandPrep's own boundary, never propagated to main().
export class WorktreeLockLost extends Error {
  constructor(slug) {
    super(`worktree lock lost for ${slug}`);
    this.name = 'WorktreeLockLost';
  }
}

// The head-time acquisition (plan 2473 acceptance 1 + 2). Waits BOUNDED for a live prep child to
// finish, then preempts it so a crashed/hung child can never wedge a land. Returns nothing — it
// either holds the lock (registered for release), or has proven the holder dead/terminated and
// proceeds anyway. Never throws: this is a safety interlock on an optimization, and a land must
// not fail because the interlock itself misbehaved.
export function acquireWorktreeLockAtHead(state) {
  const D = landDeps();
  if (D.env.DRY) return;
  const path = worktreeLockFor(state.wtPath, state.slug);
  if (!path) return;
  try {
    // plan 3453 — SUPERSEDES the plan-3436 D3 "exclusion KEPT" ruling (see
    // docs/coord/cloud-drains.md § Chunking a job that is too big for one foreground window and
    // docs/coord/hooks.md § Diff-scoping for the retired text). The whole design is TWO CLOCKS
    // that never touch each other — bug 1 (3436's clamp shortened the PREEMPT threshold itself,
    // so a starved chunk budget killed a live, healthy prep child — the exact opposite of the
    // wait's own rationale, "a finished prep fast-paths the whole gate battery, so waiting beats
    // killing it") is what happens when the two clocks are conflated, so separating them is not a
    // mitigation, it is the shape:
    //
    //   * the HOLDER clock — how long THIS HOLDER has been waited on, ACCUMULATED across every
    //     invocation (a per-holder duration in the sidecar below + monotonic elapsed this
    //     invocation) — bounds PREEMPTION and stays HEAD_LOCK_WAIT_MS (30 min), unconditionally.
    //   * the ATTEMPT clock — how long THIS INVOCATION may sit in the poll loop — bounds only a
    //     SEAM (HEAD_LOCK_CHUNKED, holder untouched), and is the EXISTING plan-3430/3436 chunk
    //     machinery (chunkGateStartDecision), not new clamp logic. There is no code path in which
    //     a chunk remainder reaches the holder-clock comparison below.
    //
    // Read the chunk config ONCE into a local (this file's reviewed rule against a second
    // `process.env` read per tick — see chunkGateConfig's own header) and feed it to the one
    // decision every chunk-capped gate makes. Chunking OFF (every local land) makes
    // `effectiveTimeoutMs` exactly HEAD_LOCK_WAIT_MS, so the poll loop below is functionally
    // identical to what it always was on that path — the guarantee this file leans on everywhere
    // else a gate goes through `chunkGateStartDecision`.
    // plan 3453 F7 (gpt-review round 1, finding 973518): reuse the ONE shared composition every
    // other chunk-capped gate in this file goes through (landPreflightChunkOptions, just above
    // noStartGateResult) instead of hand-composing `chunkCapMs`/`minChunkS` from `chunkGateConfig()`
    // a second time — a future change to that composition could otherwise leave this call site
    // silently disagreeing with the rest of the file about the cap, running past it with no
    // HEAD_LOCK_CHUNKED seam.
    const { chunkCapMs, minChunkS } = landPreflightChunkOptions();
    const decision = D.spine.chunkGateStartDecision(state.wtPath, 'head-lock', {
      chunkCapMs,
      minChunkS,
      naturalTimeoutMs: HEAD_LOCK_WAIT_MS,
    });
    if (!decision.shouldRun) {
      // D3: the no-progress bound. Without it, a land arriving at head with the chunk wall
      // already spent would seam on its very first poll, having waited zero — forever, across
      // unlimited re-invocations, accumulating nothing on the holder clock (a livelock the naive
      // clamp would create). `chunkGateStartDecision` already answers it exactly like
      // BUILD_CHUNKED/MOBILE_CHUNKED do (core-noun-ok: names the actual SEAM constants): gate 'head-lock' in the SAME
      // `.scratch/land-chunk-nostart.json`, keyed by head sha. Nothing ran, so `noStartGateResult`
      // reports either ordinary CHUNKED (re-invoke) or, once exhausted, the phases-before-head
      // NON-CONVERGENT message — and an exhausted round means another invocation of the same
      // shape cannot help, so it releases the queue slot rather than holding it for one.
      const r = D.spine.noStartGateResult('head-lock', decision, minChunkS);
      if (r.nonConvergent) {
        // plan 3453 F5 (gpt-review round 1: a1c7ce/0ce1a4): every OTHER chunk-capped gate in this
        // file reports this exact condition — did not start, tally exhausted — as
        // `GATE_NON_CONVERGENT` (see the other chunk-capped gate call sites), not `PREFLIGHT_FAIL`. Reporting
        // it under a different, less specific code here made the head-lock gate the one place a
        // cloud drain could not recognize "re-invoking cannot make progress" and would follow the
        // wrong remediation path.
        D.spine.emitSeam(D.L.SEAM.GATE_NON_CONVERGENT, r.detail, state);
      } else {
        // plan 3453 J1: same rule as the two in-loop chunked seams — this hand-back RETAINS the
        // queue slot and process.exit()s, so stamp liveness before leaving.
        queueHeartbeat(state);
        D.spine.emitSeam(D.L.SEAM.HEAD_LOCK_CHUNKED, r.detail, state, { keepQueue: true });
      }
    }

    const attemptBudgetMs = decision.effectiveTimeoutMs;
    const attemptStartedMonotonicMs = monotonicNowMs();
    // D5: never start a poll sleep the ATTEMPT cannot finish inside its own budget. Gated on
    // `decision.usingChunkCap` (chunkCapDecision's own "is this cap actually shorter than the
    // natural one" flag) rather than firing on elapsed time alone: chunking OFF, or chunking ON
    // with a remainder that exceeds HEAD_LOCK_WAIT_MS, both leave `attemptBudgetMs` EQUAL to the
    // holder-clock threshold itself — with no real external wall behind it, seaming ~10s early
    // there would turn every local wait that runs the full 30 minutes into a pointless extra
    // re-invoke instead of the direct preempt it always was, breaking the "byte-identical to
    // today" guarantee `chunkGateStartDecision`'s own header promises for the chunking-off path.
    // The headroom only matters when the attempt clock is a REAL, externally-imposed constraint.
    const attemptExhausted = () =>
      decision.usingChunkCap &&
      attemptBudgetMs - (monotonicNowMs() - attemptStartedMonotonicMs) < HEAD_LOCK_POLL_MS;
    // plan 3453 G4: the LARGER reserve required specifically before starting a preemption (see
    // HEAD_LOCK_PREEMPT_RESERVE_MS's own header) — same `usingChunkCap` gate as `attemptExhausted`
    // above, so the chunking-off (local) path is unaffected either way.
    const preemptReserveExhausted = () =>
      decision.usingChunkCap &&
      attemptBudgetMs - (monotonicNowMs() - attemptStartedMonotonicMs) <
        HEAD_LOCK_PREEMPT_RESERVE_MS;

    let announced = false;
    // The holder we are currently accumulating against, and the monotonic instant we first saw
    // it — D4's "carried baseline fixed for the duration of that holder". Both reset the moment
    // the observed lock token changes.
    //
    // plan 3453 F3: `waitingOnToken` is the ACCUMULATOR key, from `headLockHolderIdentity` — a
    // real token for the ordinary case, or a synthesized `notoken:…` key for a legible-but-tokenless
    // holder. plan 3453 G2: the too-sparse-to-identify case no longer leaves it `null` either — it
    // gets `UNIDENTIFIABLE_HOLDER_IDENTITY` (see that constant's own header), so `waitingOnToken`
    // is never `null` once the first poll has run. `waitingOnHasRealToken` tracks whether the key
    // came from a REAL token, kept in lockstep wherever `waitingOnToken` is (re)assigned:
    // preemption is never attempted against a synthesized identity (D7 needs a real token to pin a
    // kill to), so the `action === 'preempt'` branch below checks it BEFORE doing the usual
    // verify-then-kill dance.
    let waitingOnToken = null;
    let waitingOnHasRealToken = false;
    let firstSeenMonotonicMs = monotonicNowMs();
    // D4: the carried baseline for the CURRENT holder, read from the sidecar EXACTLY ONCE — the
    // instant `waitingOnToken` is (re)identified — and held fixed for the rest of that holder's
    // tenure. Re-reading it on every poll (rather than reusing this fixed snapshot) would feed
    // this invocation's OWN just-written total back in as "carried" on the very next poll, on top
    // of the monotonic elapsed that already accounts for it — reproducing bug 3b's double-count
    // from inside a single invocation instead of merely across invocations. The per-poll WRITE
    // below still happens every poll (so a re-invoke's fresh process has something to carry
    // forward); only the READ is pinned to holder-identification time.
    let carriedTallyForHolder = null;
    let indeterminateReads = 0;
    // plan 3453 F4: consecutive `writeHeadLockWaitTally` FAILURES — a separate counter from
    // `indeterminateReads` above (reads and writes fail independently), but bounded by the SAME
    // HEAD_LOCK_INDETERMINATE_POLLS ceiling for the same reason: this file IS the cross-invocation
    // holder-wait bound, not decoration, so a persistently unwritable sidecar must halt rather than
    // silently spin forever "healthy". A single successful write resets it.
    //
    // plan 3453 G3 (gpt-review round 2, finding e11275/2203, WONTFIX): round 2 asked for THIS
    // counter itself to survive across invocations, the same way `carriedTallyForHolder` does. It
    // cannot: the thing failing IS the write, so there is nowhere left to persist a count about it —
    // a counter about an unwritable file would itself need to be written to that same unwritable
    // file. The behaviour is bounded and safe regardless: every invocation halts within
    // HEAD_LOCK_INDETERMINATE_POLLS polls of its OWN sidecar writes failing and RELEASES its queue
    // slot (see the halt below), so a persistently unwritable `.scratch` produces a fast, loud,
    // repeatable halt rather than an unbounded wait — it never wedges anything, it just re-halts
    // every invocation until the write failure (permissions, disk space) is fixed, which is exactly
    // the operator action the halt message already names.
    let sidecarWriteFailures = 0;
    // plan 3453 H2 (gpt-review round 3, findings 2480/2500/506): consecutive `attemptPreemption`
    // calls that returned `{ terminated: false, reset: false }` — neither the verified holder nor a
    // replacement could be named, so nothing converged. See its call site for the full rationale;
    // reset to 0 by any OTHER outcome (reacquired, terminated, or reset).
    let preemptFailures = 0;
    // plan 3453 H8 (gpt-review round 3, finding 2133 angle-P): declared HERE, outside the loop, and
    // PERSISTED across iterations — reassigned (never redeclared) on every SUCCESSFUL read, like
    // `waitingOnToken` above — rather than recomputed fresh inside each iteration. A lock-READ
    // failure's own pre-sleep recheck (see `seamOutOfChunkBudget`, defined below) needs to report the
    // real accumulated total, not falsely reset to 0s just because THIS iteration's read never
    // refreshed it.
    let budget = { carriedMs: 0, elapsedMs: 0, totalMs: 0, exhausted: false };

    for (;;) {
      let r;
      // plan 3453 G6 (gpt-review round 2, finding d94c42): ONE place composes the "handing back for
      // chunk budget" seam message, shared by the 'seam' action below and the pre-sleep recheck at
      // the bottom of this loop — so a future sleep added to this loop cannot be wired up without
      // going through the same budget guard that closes this finding.
      //
      // plan 3453 H8 (gpt-review round 3, finding 2133 angle-P): defined HERE, before the read
      // attempt below, so the lock-READ-error catch a few lines down can share this SAME helper for
      // its own pre-sleep recheck — moving it any later would put it in the temporal dead zone from
      // that catch's point of view. `r` is read via `r && r.holder` because on that path the read
      // just failed and `r` is still its initial `undefined`; `describeWorktreeLockHolder(undefined)`
      // already reports "an unreadable lock record", which is the correct description for that case.
      const seamOutOfChunkBudget = () => {
        // plan 3453 J1 (gpt-review round 5, finding 2172 angle-A): stamp queue liveness BEFORE
        // handing back. `emitSeam` process.exit()s, so nothing after it runs, and a HEAD_LOCK_CHUNKED
        // hand-back RETAINS the queue slot (keepQueue) — leaving on a stale heartbeat means a
        // slow re-invoke can find its own retained slot stolen by the 45-min steal clock. The
        // ordinary poll heartbeat lives in `pollTail`, which a seam by definition never reaches.
        queueHeartbeat(state);
        const totalDesc =
          waitingOnToken != null
            ? `${Math.round(budget.totalMs / 1000)}s accumulated of the ` +
              `${Math.round(HEAD_LOCK_WAIT_MS / 1000)}s preempt budget`
            : `the holder record is not identifiable, so no preempt clock is running against it yet`;
        D.spine.emitSeam(
          D.L.SEAM.HEAD_LOCK_CHUNKED,
          `done-worktree: still waiting on ${D.worktreeLock.describeWorktreeLockHolder(r && r.holder)} for ` +
            `${state.slug}'s worktree (${totalDesc}) — this invocation is out of CHUNK BUDGET, not ` +
            `out of patience. Re-invoke to keep waiting; the accumulated wait carries forward, so ` +
            `this costs one extra round, never a lost wait.`,
          state,
          { keepQueue: true },
        );
      };
      // plan 3453 I2 (gpt-review round 4, findings 2388 angle-B, 2171/2438 duplication): the ONE
      // end-of-poll tail. Every path that ends a poll round — the ordinary bottom of the loop, the
      // indeterminate-read retry, and the two holder-changed `continue`s below — must do the SAME
      // three things in the SAME order: stamp queue liveness (the 45-min steal clock must not fire
      // while we legitimately wait), recheck the attempt budget immediately before sleeping (G6/H8),
      // then sleep. Round 3's H5 `continue` skipped all three, so a lock whose holder churned every
      // grace window could starve the heartbeat; hoisting the tail into one helper is what stops a
      // fourth caller from skipping them again.
      const pollTail = () => {
        queueHeartbeat(state);
        if (attemptExhausted()) seamOutOfChunkBudget();
        D.coordGit.sleepSync(HEAD_LOCK_POLL_MS);
      };
      try {
        r = takeWorktreeLock(state.wtPath, state.slug, 'land');
        indeterminateReads = 0; // D8: any SUCCESSFUL read resets the counter
      } catch (e) {
        // D8 (ruling on finding 31dc49): `readExclusive` (excl-lock.mjs) already distinguishes
        // "no lock" (absent, or ENOENT mid-read ⇒ `undefined`) from "could not tell"
        // (EACCES/EBUSY/EPERM ⇒ throws). The old blanket catch around this whole function
        // flattened a throw here into "no lock" and walked into rebase/merge beside a possibly-
        // live writer — precisely the two-processes-one-worktree corruption this lock exists to
        // prevent. A throw here is INDETERMINATE, not free: transient by nature (an AV scan, a
        // sync tool), so it is retried on the ordinary poll cadence rather than failing on the
        // first throw — but not forever, or a permanently unreadable lock would wait out the
        // whole HEAD_LOCK_WAIT_MS believing nothing is wrong.
        indeterminateReads += 1;
        console.error(
          `done-worktree: could not READ ${state.slug}'s worktree lock (${e.message || e}) — ` +
            `indeterminate, not "no lock" — retry ${indeterminateReads}/${HEAD_LOCK_INDETERMINATE_POLLS}.`,
        );
        if (indeterminateReads >= HEAD_LOCK_INDETERMINATE_POLLS) {
          // Same resolution as "preemption itself failed" below, and for the same reason: a clean
          // stop beats both corruption and a wedged head. Releases the queue slot — a re-invoke is
          // exactly as blind as this one until the read starts succeeding again.
          D.spine.emitSeam(
            D.L.SEAM.PREFLIGHT_FAIL,
            `${state.slug}'s worktree lock could not be READ ${HEAD_LOCK_INDETERMINATE_POLLS} ` +
              `consecutive times (${e.message || e}) — this means the lock could not be read, NOT ` +
              `that there is no lock. Merging past a writer we cannot see risks a corrupted rebase ` +
              `or a lost force-push, so this land halts instead of proceeding. Inspect what is ` +
              `holding the file (an AV scan, a sync tool are the usual transients) and re-invoke ` +
              `done-worktree once it clears — the queue slot has been RELEASED so other lands are ` +
              `not blocked behind this.`,
            state,
          );
        }
        // plan 3453 F6 (gpt-review round 1: 98f389/d3d8e0): this retry sleep must honour the SAME
        // attempt budget every other branch of this loop already does. An unconditional
        // HEAD_LOCK_POLL_MS sleep here, with less than one poll of chunk budget left, can overrun
        // the chunk wall while the process is asleep and get killed with NO seam at all — the exact
        // failure this whole plan exists to close, arriving through the error path instead of the
        // happy one. Checked AFTER the halt above (a genuine 3-strikes halt always wins) and BEFORE
        // the sleep (never start a sleep the attempt cannot finish inside its own budget — the same
        // D5 rule `attemptExhausted` documents at its own definition).
        if (attemptExhausted()) {
          queueHeartbeat(state); // plan 3453 J1: same rule as `seamOutOfChunkBudget` above
          D.spine.emitSeam(
            D.L.SEAM.HEAD_LOCK_CHUNKED,
            `done-worktree: ${state.slug}'s worktree lock was unreadable (${e.message || e}) and ` +
              `this invocation is out of CHUNK BUDGET — handing back for a re-invoke rather than ` +
              `risk overrunning the chunk wall on a retry sleep. The indeterminate-read count does ` +
              `NOT carry to the next invocation (a fresh process starts its own count at 0, exactly ` +
              `like every other per-invocation attempt-clock state); re-invoke to keep waiting.`,
            state,
            { keepQueue: true },
          );
        }
        // plan 3453 H8 (gpt-review round 3, finding 2133 angle-P): recheck IMMEDIATELY before this
        // sleep too — the check above ran BEFORE this heartbeat's own synchronous work, so it alone
        // cannot stop that work from carrying this sleep across the chunk wall. Same fix as G6, same
        // reason; `pollTail` is where that one rule now lives for every poll-ending path.
        pollTail();
        continue;
      }
      if (r.token) {
        state.worktreeLock = r;
        if (announced)
          D.spine.stepLog(state, 'worktree lock: the prep pass finished — the worktree is ours');
        // D4: a fresh acquisition means nothing is left to carry for THIS invocation's series —
        // clear the sidecar so an unrelated FUTURE holder can never inherit today's total. Writing
        // an empty holder identity (rather than deleting the file) round-trips through
        // `parseHeadLockWaitTally`'s own "holder must be non-empty" contract as "no tally at all",
        // so the clear needs no second code path.
        writeHeadLockWaitTally(
          state.wtPath,
          D.L.nextHeadLockWaitTally({ holderToken: '', totalMs: 0 }),
        );
        return;
      }
      // plan 3453 F3: `holderIdentity` covers a tokenless-but-legible holder too now (its
      // synthesized `notoken:…` key), so the ordinary per-holder accumulator branch below handles
      // it with NO separate special case — see `headLockHolderIdentity`'s own header.
      //
      // plan 3453 G2 (gpt-review round 2, findings 1dc7da/ac2387/33e96a): a record too SPARSE for
      // `headLockHolderIdentity` to name at all no longer gets its own process-local clock — it
      // gets `UNIDENTIFIABLE_HOLDER_IDENTITY`, the shared sentinel, and flows through this SAME
      // reset branch like every other holder. That is what makes it accumulate and PERSIST across
      // chunked invocations instead of restarting at zero every re-invoke — see the sentinel's own
      // header for why two different unidentifiable holders sharing this one clock is acceptable.
      const rawToken =
        r.holder && typeof r.holder.token === 'string' && r.holder.token ? r.holder.token : null;
      const rawIdentity = D.L.headLockHolderIdentity(r.holder);
      const holderIdentity = rawIdentity != null ? rawIdentity : D.L.UNIDENTIFIABLE_HOLDER_IDENTITY;
      if (holderIdentity !== waitingOnToken) {
        // D4: a DIFFERENT holder — the carried baseline resets: read whatever a PRIOR invocation
        // left for this exact holder (or null, the first time anyone waited on it), fixed for the
        // rest of this holder's tenure, and the clock restarts from now. (Bug 3a is what happens
        // when this reset is missing.)
        waitingOnToken = holderIdentity;
        waitingOnHasRealToken = rawToken != null;
        firstSeenMonotonicMs = monotonicNowMs();
        carriedTallyForHolder = readHeadLockWaitTally(state.wtPath);
        // plan 3453 H2 (orchestrator follow-up): the failed-preemption counter is PER-HOLDER, like
        // every other clock in this function. It counts consecutive attempts against the holder we
        // are waiting on, so a different holder starts it over — otherwise failures against a gone
        // holder A would be spent on a fresh holder B, halting B's wait early on evidence that was
        // never about B. Bug 3a's cross-holder inheritance in a second place, same rule.
        preemptFailures = 0;
      }
      // plan 3453 H8: reassigned (not redeclared) — `budget` is declared once, before the loop, so
      // it persists its last successfully-computed value across a subsequent lock-read failure. See
      // that declaration's own header.
      budget =
        waitingOnToken != null
          ? D.L.headLockWaitBudget({
              tally: carriedTallyForHolder,
              holderToken: waitingOnToken,
              firstSeenMonotonicMs,
              nowMonotonicMs: monotonicNowMs(),
              budgetMs: HEAD_LOCK_WAIT_MS,
            })
          : { carriedMs: 0, elapsedMs: 0, totalMs: 0, exhausted: false };
      // D4: persisted on EVERY poll, not only at the seam — a call killed at the 600s tool cap
      // emits no seam at all, and only a per-poll write carries THIS invocation's wait forward
      // for the next one to resume from.
      //
      // plan 3453 F4 (gpt-review round 1: 8ad011/c3adfc/998cfb/0c1292/4eed45/c81331): count
      // CONSECUTIVE write failures and halt once they reach the SAME ceiling the lock-READ throws
      // use — a write failure is the same class of problem as a read failure (this invocation
      // cannot trust its own bookkeeping), so they share the bound. Without this, a persistently
      // unwritable `.scratch` makes every chunked re-invocation restart the holder clock from zero
      // and emit HEAD_LOCK_CHUNKED again forever — healthy-looking, but the 30-min preempt
      // threshold this design promises can never actually be reached. A single successful write
      // resets the count.
      if (waitingOnToken != null) {
        const wrote = writeHeadLockWaitTally(
          state.wtPath,
          D.L.nextHeadLockWaitTally({ holderToken: waitingOnToken, totalMs: budget.totalMs }),
        );
        if (wrote) {
          sidecarWriteFailures = 0;
        } else {
          sidecarWriteFailures += 1;
          if (sidecarWriteFailures >= HEAD_LOCK_INDETERMINATE_POLLS) {
            D.spine.emitSeam(
              D.L.SEAM.PREFLIGHT_FAIL,
              `${state.slug}'s wait's own bookkeeping (.scratch/land-head-lock-wait.json) could ` +
                `not be WRITTEN ${HEAD_LOCK_INDETERMINATE_POLLS} consecutive times — this file is ` +
                `NOT decoration, it IS the cross-invocation holder-wait bound (D4): while it cannot ` +
                `be persisted, the ${Math.round(HEAD_LOCK_WAIT_MS / 60000)}-min preempt threshold ` +
                `can never be reached, so continuing would trade a bounded wait for an unbounded ` +
                `wait-then-seam-then-re-invoke chain that never converges. Fix the .scratch/ write ` +
                `failure (permissions, disk space) and re-invoke — the queue slot has been ` +
                `RELEASED so other lands are not blocked behind this.`,
              state,
            );
          }
        }
      }
      // plan 3453 G4 (gpt-review round 2, finding dfcc2a): the reserve required before COMMITTING
      // to a preemption is the LARGER HEAD_LOCK_PREEMPT_RESERVE_MS, not the ordinary-poll reserve
      // `attemptExhausted()` uses — see that constant's own header. Only consulted for a poll that
      // would actually attempt to preempt; an ordinary wait keeps using the smaller reserve.
      const wouldPreempt = waitingOnToken != null && budget.exhausted;
      const action = D.L.headLockPollAction({
        acquired: false,
        attemptExhausted: wouldPreempt ? preemptReserveExhausted() : attemptExhausted(),
        holderExhausted: wouldPreempt,
      });
      // plan 3453 H8: `seamOutOfChunkBudget` is now defined once, at the top of this loop (before
      // the read attempt) — see its own header for why — rather than redefined down here.
      if (action === 'seam') {
        // D5: the attempt check precedes the preempt check deliberately. Preempting with ~0s of
        // tool budget left would drive the land straight into rebase/merge — the most dangerous
        // phase — under a guaranteed kill. Seaming instead costs exactly one extra invocation,
        // which then preempts on its FIRST poll (carried ≥ budget, once the holder clock is
        // already exhausted) with a full fresh wall for the merge.
        seamOutOfChunkBudget();
      }
      if (action === 'preempt') {
        if (!waitingOnHasRealToken) {
          // plan 3453 F3: the budget on a legible-but-tokenless holder (`waitingOnToken` is a
          // synthesized `notoken:…` key, or now the G2 sentinel for a too-sparse record) has
          // expired. It can never be verified-then-preempted the normal way below —
          // `headLockPreemptAction` is fed the REAL token, which is always falsy for this holder,
          // so it would return 'reset' every time and this would spin forever, re-arming the same
          // expired budget against the same holder instead of ever converging. HALT instead.
          D.spine.emitSeam(
            D.L.SEAM.PREFLIGHT_FAIL,
            `${state.slug}'s worktree has been held for ${Math.round(HEAD_LOCK_WAIT_MS / 60000)} ` +
              `min by ${D.worktreeLock.describeWorktreeLockHolder(r.holder)}, a record carrying NO token — it ` +
              `cannot be identified by a real token, so it cannot be safely preempted (killing a ` +
              `holder this land cannot name is exactly the wrong-holder kill finding d148e9 ` +
              `covers). Merging past it is equally unsafe, so this land halts. Inspect the lock ` +
              `file, clear it if it is genuinely dead, then re-invoke done-worktree — the queue ` +
              `slot has been RELEASED so other lands are not blocked behind this.`,
            state,
          );
        }
        // D7 (ruling on finding d148e9): re-verify the CURRENT holder before acting on a decision
        // that was made against `waitingOnToken`. A different (or now-absent) token means holder A
        // — the one whose budget expired — already released, and either nobody or a fresh B holds
        // it now; B is NEVER preempted on A's expired budget. Reset and keep waiting, this time
        // against B (or against nothing, if the lock is simply free — the next poll's acquire
        // attempt picks that up on its own).
        //
        // plan 3453 F1 (0f410a/09d323/7f020e/08957c/1d5c10): routed through the SAME checked reader
        // the acquire read uses (`readLockEntryChecked`, defined below), so a throw here
        // (EACCES/EBUSY/EPERM) is INDETERMINATE — not proof the holder is gone — and never falls
        // through to the outer fail-open catch. Below the indeterminate-polls threshold this is
        // simply "could not verify this round" — never grounds to preempt — so it falls through to
        // this poll's ordinary announce/heartbeat/sleep and re-verifies next round.
        const freshRead = readLockEntryChecked(path);
        if (freshRead.ok) {
          const freshEntry = freshRead.entry;
          const freshToken =
            freshEntry && typeof freshEntry.token === 'string' && freshEntry.token
              ? freshEntry.token
              : null;
          const verdict = D.L.headLockPreemptAction({ waitingOnToken, currentToken: freshToken });
          if (verdict === 'reset') {
            console.error(
              `done-worktree: ${state.slug}'s worktree holder changed between the budget check and ` +
                `the preempt decision — NOT preempting; resuming the wait against the current holder.`,
            );
            // plan 3453 I1 (gpt-review round 4, findings 2337 claude-data-grounding, 2224 angle-B):
            // this was the THIRD hand-rebuilt copy of the holder-change state, and the one round 3's
            // H5 missed. Like H5's, it called `headLockHolderIdentity` bare — so a too-sparse
            // fresh record set `waitingOnToken` back to null, defeating the G2 sentinel — and it
            // never reset `preemptFailures`, so failures charged to the holder that just went away
            // were still spent against this new one. Same ruling as H5: do not rebuild anything
            // here. `continue`, and let the ONE top-of-loop identification branch derive identity,
            // the sentinel fallback, the D4 carried baseline, and the counter reset together.
            preemptFailures = 0;
            pollTail();
            continue;
          } else {
            // plan 3453 G1 (gpt-review round 2, findings c1c070/c2a2e6/7f62df/59d129/2411/2395/
            // e496eb/2436): actually attempt to terminate this VERIFIED holder. The destructive
            // cleanup below (clear-stale-lock + `git rebase --abort`) runs ONLY when
            // `attemptPreemption` can PROVE the holder it SIGTERM'd is the one it SIGKILL'd and is
            // now gone — never merely because this branch was reached. See its own header.
            const outcome = attemptPreemption(freshEntry);
            if (outcome.reacquired) return;
            if (outcome.terminated) {
              // Confirmed dead, but the reacquire itself failed. review 2473 [2] + 2473-r2 [0]: halt
              // (never merge unlocked past a writer this land cannot prove is gone) AND release the
              // queue slot (never wedge the queue behind a land that cannot safely proceed) — a
              // re-invocation re-enqueues and sails through as soon as the holder is gone or provably
              // dead.
              const finalRead = readLockEntryChecked(path);
              D.spine.emitSeam(
                D.L.SEAM.PREFLIGHT_FAIL,
                `${D.worktreeLock.describeWorktreeLockHolder(finalRead.ok ? finalRead.entry : undefined)} still ` +
                  `holds ${state.slug}'s worktree after ${Math.round(HEAD_LOCK_WAIT_MS / 60000)} ` +
                  `min at head AND survived SIGTERM+SIGKILL. Merging past a live writer risks a ` +
                  `corrupted rebase or a lost force-push, so this land halts instead. Inspect the ` +
                  `process, then re-invoke done-worktree — it re-enqueues and proceeds as soon as ` +
                  `the holder is gone or provably dead. The queue slot has been RELEASED so other ` +
                  `lands are not blocked behind this.`,
                state,
              );
            }
            // plan 3453 H5 (gpt-review round 3, finding 2351 — claude-data-grounding, simplification):
            // `outcome.reset` no longer hand-rebuilds `waitingOnToken`/`waitingOnHasRealToken`/
            // `firstSeenMonotonicMs`/`carriedTallyForHolder` here — that duplicated the ONE holder-
            // identification branch above (`if (holderIdentity !== waitingOnToken)`), calling
            // `headLockHolderIdentity` directly and so bypassing ITS `UNIDENTIFIABLE_HOLDER_IDENTITY`
            // sentinel fallback (G2) for a too-sparse `outcome.newHolderEntry` — reintroducing a null
            // `waitingOnToken` in the one place G2's sentinel was supposed to have eliminated it.
            // `continue` instead: the next poll re-reads the lock fresh and runs through that SAME
            // branch, which already applies the sentinel fallback and the D4 carried-baseline read.
            if (outcome.reset) {
              preemptFailures = 0; // H2: a positively-identified new (or no) holder is not a failure
              // plan 3453 I2 (gpt-review round 4, finding 2388 angle-B): this `continue` used to
              // jump straight past the heartbeat, the pre-sleep budget recheck and the sleep.
              pollTail();
              continue;
            }
            // plan 3453 H2 (gpt-review round 3, findings 2480 angle-A/angle-B, 2500 angle-C, 506
            // altitude): the ONLY remaining outcome shape is `{ terminated: false, reset: false }` —
            // SIGTERM/SIGKILL delivery failed, or the post-grace reread was indeterminate; neither the
            // holder nor a replacement could be named. On a LOCAL land (`decision.usingChunkCap` is
            // false) `attemptExhausted()`/`preemptReserveExhausted()` are BOTH permanently false, so NO
            // seam can ever fire — without this counter, an unsignalable holder makes this land retry
            // a failing signal every HEAD_LOCK_POLL_MS forever, holding the queue head the whole time.
            // Bounded by the SAME HEAD_LOCK_INDETERMINATE_POLLS ceiling the read/write counters above
            // use, for the same reason: this function IS the cross-invocation bound, so a wait that
            // cannot converge must halt loudly rather than spin healthy-looking forever.
            preemptFailures += 1;
            if (preemptFailures >= HEAD_LOCK_INDETERMINATE_POLLS) {
              const finalRead = readLockEntryChecked(path);
              D.spine.emitSeam(
                D.L.SEAM.PREFLIGHT_FAIL,
                `${D.worktreeLock.describeWorktreeLockHolder(finalRead.ok ? finalRead.entry : undefined)} still ` +
                  `holds ${state.slug}'s worktree, and this land could not deliver a termination ` +
                  `signal to it across ${HEAD_LOCK_INDETERMINATE_POLLS} consecutive preemption ` +
                  `attempts (access denied / EPERM is the usual cause) — that is never proof the ` +
                  `holder is gone. Merging past a writer this land cannot prove is gone risks a ` +
                  `corrupted rebase or a lost force-push, so this land halts rather than spinning on ` +
                  `a signal it cannot deliver. Inspect or kill that process, then re-invoke ` +
                  `done-worktree — the queue slot has been RELEASED so other lands are not blocked ` +
                  `behind this.`,
                state,
              );
            }
          }
        }
        // else: indeterminate and below the halt threshold — never preempt on a read we could not
        // make; fall through to this poll's ordinary announce/heartbeat/sleep and retry next round.
      }
      if (!announced) {
        announced = true;
        // plan 3453: the remaining budget, NOT a flat "up to 30 min". After a chunk seam the
        // sidecar can already carry most of this holder's 30 minutes, so a re-invoke that
        // announced the full window would be telling the operator something false about when the
        // preempt lands — the accumulated clock is the whole point of the design.
        const remainingMin = Math.max(0, Math.round((HEAD_LOCK_WAIT_MS - budget.totalMs) / 60000));
        D.spine.stepLog(
          state,
          `worktree lock: ${D.worktreeLock.describeWorktreeLockHolder(r.holder)} is mid-pass in this worktree — ` +
            `${Math.round(budget.totalMs / 60000)} min already waited on it. ` +
            `${remainingMin} min left before preemption — a finished prep fast-paths the whole ` +
            `gate battery, so waiting beats killing it`,
        );
      }
      // The 45-min steal clock must not fire while we legitimately wait at head.
      // plan 3453 G6: recheck the attempt budget IMMEDIATELY before this sleep too, not only when
      // `action` was computed a few lines up — slow synchronous work in between (a lock reread, a
      // log write, the heartbeat itself) can consume the remaining chunk budget after that check,
      // letting this sleep cross the chunk wall with no seam at all. `pollTail` carries that rule
      // (and the heartbeat before it) for every poll-ending path in this loop.
      pollTail();
    }

    // plan 3453 F1 (gpt-review round 1: 0f410a/09d323/7f020e/08957c/1d5c10/71a328/2f20e4): every
    // OTHER lock read below — the post-grace SIGKILL reread and the final halt message's reread —
    // used to call `readWorktreeLockEntry` BARE. That function throws on the exact same
    // EACCES/EBUSY/EPERM classes the D8 catch (top of the poll loop above) already treats as
    // INDETERMINATE for the acquire read; a bare call let that same throw escape D8 entirely and
    // fall into this function's OUTER catch (see its own narrowed comment below), which used to log
    // "non-fatal, proceeding" and return — merging beside a writer this land could not even prove
    // was gone. Every remaining bare call to it in this function (including the D7 pre-preempt
    // verify above, which is what "declared after its use" relies on function-hoisting for) is
    // routed through this instead, so a throw is always reported as `{ ok: false }`, never escapes
    // as an exception.
    //
    // Shares the SAME `indeterminateReads` counter and HEAD_LOCK_INDETERMINATE_POLLS ceiling the
    // acquire-read catch above uses — three consecutive unreadable polls TOTAL, from any read site
    // combined, not three per site — and any SUCCESSFUL read (from any site) resets it, matching
    // that catch's own retry-until-it-clears contract.
    function readLockEntryChecked(lockPath) {
      try {
        const entry = D.worktreeLock.readWorktreeLockEntry(lockPath);
        indeterminateReads = 0;
        return { ok: true, entry };
      } catch (e) {
        indeterminateReads += 1;
        console.error(
          `done-worktree: could not READ ${state.slug}'s worktree lock (${e.message || e}) — ` +
            `indeterminate, not "no lock" — retry ${indeterminateReads}/${HEAD_LOCK_INDETERMINATE_POLLS}.`,
        );
        if (indeterminateReads >= HEAD_LOCK_INDETERMINATE_POLLS) {
          D.spine.emitSeam(
            D.L.SEAM.PREFLIGHT_FAIL,
            `${state.slug}'s worktree lock could not be READ ${HEAD_LOCK_INDETERMINATE_POLLS} ` +
              `consecutive times (${e.message || e}) — this means the lock could not be read, NOT ` +
              `that there is no lock. Merging past a writer we cannot see risks a corrupted rebase ` +
              `or a lost force-push, so this land halts instead of proceeding. Inspect what is ` +
              `holding the file (an AV scan, a sync tool are the usual transients) and re-invoke ` +
              `done-worktree once it clears — the queue slot has been RELEASED so other lands are ` +
              `not blocked behind this.`,
            state,
          );
        }
        return { ok: false, error: e };
      }
    }

    // plan 3453 G1 (gpt-review round 2, findings c1c070/c2a2e6/7f62df/59d129/2411/2395/e496eb/2436):
    // round 1's F2 fix correctly stopped SIGKILLing a REPLACEMENT holder — and then fell straight
    // through into the destructive cleanup that follows (clear-stale-lock, `git rebase --abort`,
    // re-acquire) regardless of whether anything was actually terminated. That was worse than the
    // wrong-holder kill it replaced: silent data destruction (an ABORTED live rebase) in the land
    // spine's most dangerous phase, reachable whenever the replacement-holder reread was
    // indeterminate, or SIGTERM delivery itself failed (e.g. EPERM, with the holder still alive).
    //
    // This function makes "did we actually terminate the holder we verified" an EXPLICIT, checked
    // outcome instead of "we reached this line": the destructive cleanup below runs ONLY on the one
    // branch that can prove the SAME holder SIGTERM was sent to is the one SIGKILL was just sent to.
    // Every other branch returns `terminated: false` and skips the cleanup entirely — the caller
    // resumes the poll loop against whoever (if anyone) holds the lock now, exactly like the
    // ordinary holder-change path does, rather than halting or proceeding unlocked.
    //
    // Returns:
    //   * `{ terminated: true, reacquired: true }` — done; caller returns with the lock held.
    //   * `{ terminated: true, reacquired: false }` — confirmed dead, but the reacquire itself
    //     failed; caller halts (the pre-existing "preemption itself failed" resolution, unchanged).
    //   * `{ terminated: false, reset: false }` — SIGTERM delivery failed, or the confirming reread
    //     after the grace period was indeterminate: neither proves the holder is gone, so nothing is
    //     touched. Caller keeps waiting on the SAME `waitingOnToken` — a live holder gets SIGTERM'd
    //     again next poll; a dead-but-unsignalable one is reaped for free by the ordinary acquire at
    //     the top of the loop.
    //   * `{ terminated: false, reset: true, newHolderEntry }` — the confirming reread succeeded and
    //     found a DIFFERENT holder (`newHolderEntry` may be null/undefined, meaning the lock is
    //     simply free now): a healthy replacement, never a target. Caller resumes waiting against it.
    function attemptPreemption(verifiedHolder) {
      console.error(
        `done-worktree: PREEMPTING ${D.worktreeLock.describeWorktreeLockHolder(verifiedHolder)} — it still holds ` +
          `${state.slug}'s worktree after ${Math.round(HEAD_LOCK_WAIT_MS / 60000)} min at head. ` +
          `The land proceeds on the full gate battery.`,
      );
      const signalled = D.worktreeLock.terminateWorktreeLockHolder(verifiedHolder, 'SIGTERM');
      if (!signalled) {
        // G1 (finding e496eb): delivery failure does NOT prove the holder is gone — it can be very
        // much alive (EPERM/access-denied). Never treat an unsent signal as a kill.
        console.error(
          `done-worktree: SIGTERM could not be delivered to ` +
            `${D.worktreeLock.describeWorktreeLockHolder(verifiedHolder)} — this does NOT prove it is gone, so the ` +
            `destructive cleanup is SKIPPED; resuming the wait.`,
        );
        return { terminated: false, reset: false };
      }
      D.coordGit.sleepSync(PREEMPT_GRACE_MS);
      // plan 3453 F2 (gpt-review round 1: e92d8e/3ec6ee/4565cc/58dadd): pin the SIGKILL to the SAME
      // holder SIGTERM was just sent to, not to whatever the lock happens to hold five seconds
      // later. Holder A can release after SIGTERM and a fresh, HEALTHY holder B can acquire inside
      // the grace window — an unconditional reread-and-kill here would send an unblockable SIGKILL
      // to B's live prep/land. `headLockPreemptAction` (the SAME D7 verdict function the
      // pre-preempt check uses) answers it: 'preempt' only when the reread token still matches
      // `waitingOnToken` (holder A, unchanged); 'reset' means A already released — SUCCESS, not a
      // target, so the SIGKILL is SKIPPED, never escalated onto whoever holds it now. F1's checked
      // reader means an indeterminate reread here never guesses either: it skips the SIGKILL rather
      // than firing blind at an unverified holder.
      const regrace = readLockEntryChecked(path);
      if (!regrace.ok) {
        console.error(
          `done-worktree: could not re-read ${state.slug}'s worktree lock after the SIGTERM grace ` +
            `period — the SIGKILL is SKIPPED rather than fired blind at an unverified holder, and ` +
            `so is the destructive cleanup; resuming the wait.`,
        );
        return { terminated: false, reset: false };
      }
      const regraceToken =
        regrace.entry && typeof regrace.entry.token === 'string' && regrace.entry.token
          ? regrace.entry.token
          : null;
      const verdict = D.L.headLockPreemptAction({ waitingOnToken, currentToken: regraceToken });
      if (verdict !== 'preempt') {
        // plan 3453 H11 (gpt-review round 3, finding 2514, WONTFIX): skipping the destructive cleanup
        // here is the G1 fix working as ruled, not a gap. If the original holder A released cleanly
        // during the grace window there is nothing to clean up; if a fresh holder B acquired inside
        // that same window, B now owns the worktree, and running the post-SIGKILL cleanup sequence
        // against B's tree is precisely the destruction G1 exists to prevent.
        console.error(
          `done-worktree: ${state.slug}'s worktree holder changed during the SIGTERM grace period ` +
            `— SIGTERM's target is gone, so the SIGKILL is SKIPPED rather than aimed at whatever ` +
            `holds the lock now, and so is the destructive cleanup; resuming the wait against the ` +
            `current holder.`,
        );
        return { terminated: false, reset: true, newHolderEntry: regrace.entry };
      }
      // plan 3453 H1 (gpt-review round 3, findings 2516 angle-A/angle-C/altitude/guard-fires): check
      // the SIGKILL's delivery the same way SIGTERM's delivery above is already checked (G1) — an
      // undelivered signal (EPERM/access-denied) does NOT prove the holder is gone, so the destructive
      // cleanup below must not run against a holder that may still be very much alive. No post-SIGKILL
      // liveness probe is added on top of this: the re-acquire a few lines down IS the proof of death
      // — if the lock can be taken, the holder is gone; if it cannot, the pre-existing
      // `terminated: true` / reacquire-failed halt below already stops the land rather than merging
      // unlocked.
      const sigkilled = D.worktreeLock.terminateWorktreeLockHolder(regrace.entry, 'SIGKILL');
      if (!sigkilled) {
        console.error(
          `done-worktree: SIGKILL could not be delivered to ` +
            `${D.worktreeLock.describeWorktreeLockHolder(regrace.entry)} — this does NOT prove it is gone, so the ` +
            `destructive cleanup is SKIPPED; resuming the wait.`,
        );
        return { terminated: false, reset: false };
      }
      // Confirmed: the SAME holder SIGTERM was sent to is the one SIGKILL was just sent to. Only NOW
      // is the destructive cleanup safe — everything below this line used to run unconditionally.
      //
      // review 2473-r2 [2]: SIGKILL gives git no chance to remove its own lock files, so a killed
      // `git rebase`/`git push` can leave `.git/worktrees/<slug>/index.lock` behind — and
      // `rebase --abort` then fails against that very lock. Clear the crash leftovers FIRST with the
      // repo's provably-stale clearer (the same helper the agent-facing reflex uses; it never removes
      // a lock a live op holds and always exits 0), THEN abort. Without this the land dies hundreds
      // of lines later inside its own tryRebase on a raw `fatal: Unable to create '…index.lock'`
      // instead of any of this code path's actionable messaging.
      try {
        D.spawn.run(
          'node',
          [`${state.wtPath}/scripts/clear-stale-worktree-lock.mjs`, '--rebase-state'],
          {
            cwd: state.wtPath,
          },
        );
      } catch (e) {
        console.error(
          `done-worktree: stale-lock clear after preemption failed (${e.message || e}) — continuing; ` +
            `a surviving lock will surface on the rebase below.`,
        );
      }
      try {
        D.spawn.run('git', ['-C', state.wtPath, 'rebase', '--abort']);
      } catch (e) {
        // NOT swallowed (review 2473-r2 [2]): "nothing to abort" is the common, benign case, but a
        // FAILED abort is the tell that a leftover lock survived the clear — and that is what turns
        // the land's own rebase into an opaque git-plumbing death.
        const msg = String(e.message || e);
        if (!/no rebase in progress/i.test(msg))
          console.error(`done-worktree: \`git rebase --abort\` after preemption failed — ${msg}`);
      }
      // plan 3453 F1: this re-acquire reads the lock file too (`acquireWorktreeLock` → `readExclusive`
      // internally) and can throw the same EACCES/EBUSY/EPERM class every other read site in this
      // function now guards against. Indeterminate, not proof either way — treated as "still held" so
      // it falls through to the SAME halt-and-release the caller applies rather than escaping to the
      // outer catch, which would let the land proceed unlocked exactly like the read sites F1 closed.
      let r2;
      try {
        r2 = takeWorktreeLock(state.wtPath, state.slug, 'land');
      } catch (e) {
        console.error(
          `done-worktree: could not re-read/re-acquire ${state.slug}'s worktree lock after ` +
            `preemption (${e.message || e}) — indeterminate; treated as still-held below.`,
        );
        r2 = { path, token: null, holder: null };
      }
      if (r2.token) {
        state.worktreeLock = r2;
        return { terminated: true, reacquired: true };
      }
      return { terminated: true, reacquired: false };
    }
  } catch (e) {
    // plan 3453 F1: NARROWED. Every lock READ or ACQUIRE call in this function now handles its own
    // throw explicitly — the D8 catch around `takeWorktreeLock` in the poll loop, `readLockEntryChecked`
    // (every other `readWorktreeLockEntry` call, including the D7 pre-preempt reread, the post-grace
    // SIGKILL reread, and this halt message's reread), and the re-acquire after preemption — rather
    // than letting the throw reach here. A lock read/acquire failure can no longer be swallowed as
    // "non-fatal, proceeding" (gpt-review 2f20e4 and the read-site findings beside it: that was
    // exactly the fail-open D8 exists to close). What still reaches this catch is everything ELSE
    // this function does that is NOT a lock read/acquire — chunk-config reads, `stepLog` /
    // `queueHeartbeat` bookkeeping, and the stale-lock-clear / rebase-abort subprocess calls (each
    // already has its own try/catch above and does not rethrow anything lock-related) — and plan
    // 2473's original rationale still holds for those: a safety interlock on an optimization must
    // not itself fail the land.
    //
    // plan 3453 H9/H7 (gpt-review round 3, findings 2582/1948, WONTFIX — third round to raise this,
    // answer unchanged): the same plan-2473 ruling covers the `if (!path) return;` early return at
    // the top of this function too — an unresolvable lock path is a safety interlock declining to
    // engage, not a lock read/acquire failure, so the land proceeds exactly as it would have before
    // this optimization existed.
    console.error(
      `done-worktree: worktree-lock acquisition failed (non-fatal, proceeding) — ${e.message || e}`,
    );
  }
}
