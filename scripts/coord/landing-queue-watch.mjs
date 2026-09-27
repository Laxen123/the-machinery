#!/usr/bin/env node
// scripts/landing-queue-watch.mjs (plan 968)
// Sleep-until-head watcher for a session waiting on a FIFO landing-queue slot.
//
// THE PROBLEM. A landing session enqueues (done-worktree.mjs `queueEnqueueAndGate`)
// and may not be head. The non-`--wait` default already does the right thing: it
// emits a QUEUE_WAIT seam and EXITS, retaining the slot, expecting the session to
// RE-INVOKE `done-worktree <slug>` later (the idempotent enqueue keeps its position).
// The two ways to learn WHEN to re-invoke are both poor: `done-worktree … --wait`
// blocks the session polling in-process at ~260s (and CLAUDE.md forbids running it
// detached — plan 665 G4), and a self-poll (plans-workflow.md "Self-manage mechanical
// waits", ~280s) burns LLM output tokens on every wake for the whole wait.
//
// THIS TOOL is the cheap primitive between those: a DETACHED process that polls the
// canonical `landing-queue.mjs status` at ZERO LLM-token cost and simply EXITS the
// moment the slug reaches head. Launched from a waiting session via Bash
// `run_in_background: true`, its exit RE-INVOKES that session automatically — so the
// session goes fully idle until it is genuinely its turn, then wakes ONCE and re-runs
// `done-worktree <slug>`. Pair it with a long (~1200s) ScheduleWakeup dead-man fallback
// in case the watcher dies (machine sleep / Claude Code restart). Pattern + rationale:
// docs/coord/landing-queue.md § "Chunked, resumable waiting".
//
// Usage:
//   node scripts/landing-queue-watch.mjs <slug> [--interval <sec>] [--timeout <sec>]
//        [--heartbeat-every <sec>] [--json] [--pure-poll]
//
// KEEP-HOT IS THE DEFAULT (plan 2551; it was the opt-in `--keep-hot` flag from plan 972 until
// then). Each poll where origin/master advanced while the slug is still queued fires
// `done-worktree <slug> --prep` — rebase the worktree branch onto the fresh tip, re-validate the
// applicable gates, and stamp a land-prep marker — so the head-of-queue land fast-paths past the
// rebase + gate window (the serialized seed re-apply happens here, during the wait, instead of at
// head inside the LANDING mutex). A prep conflict the detached driver can't resolve is logged and
// the wait continues (it re-surfaces at head as LAND_BLOCKED_HOLDING).
//
// WHY THE DEFAULT FLIPPED. Every canonical machine-emitted recipe (both done-worktree-lib seam
// texts, .claude/commands/landing-queue.md) handed out the FLAGLESS command, while only the
// runbook added --keep-hot — so an agent that copy-pasted what the spine printed waited COLD,
// arrived at head needing a rebase + the full gate battery inside the head slot, blew the
// plan-1528 8-min head cap, and was requeued to the tail. Observed end-to-end on plan 2549's
// 2026-07-27 land attempt. Making the safe behavior the DEFAULT means a stale doc, an old skill
// text, or a forgetful agent still gets it; `--keep-hot` stays ACCEPTED as a redundant no-op so
// every existing recipe and muscle-memory invocation keeps working.
//
// plan 2738: THE PREP RUNS AS A SUPERVISED CHILD, NEVER INSIDE THE POLL. Through plan 2551 the
// keep-hot pass was a SYNCHRONOUS `execFileSync` in this loop, so for as long as a prep ran the
// watcher could not poll — it could not observe that it had reached head, could not exit (so the
// session was never woken), and could not bump the queue heartbeat (so its own slot drifted toward
// demote-stale) while the head slot it held blocked every waiter behind it. Observed live
// 2026-08-02: 36 min at head un-woken, heartbeat 10 min stale, one plan queued behind, no wake ever
// sent — the operator found it by hand. Keep-hot is ON BY DEFAULT and re-preps on every
// origin/master advance, so under 5-7 parallel sessions that is the COMMON path, not a rare one.
//
// The prep is now `spawnWithTreeKill`ed and merely SUPERVISED: the loop keeps its cadence, so head
// detection, the heartbeat and the recovery sentinels all stay live for the prep's whole runtime.
// Reaching head ABORTS an in-flight prep (its entire purpose was to save time BEFORE head; running
// it past head burns the very slot it exists to accelerate). The abort kills the whole process
// TREE, WAITS for it to die (escalating to a SIGKILL of that same tree if it does not), and only
// then clears the rebase state the kill leaves behind — exactly as done-worktree's own at-head
// preemption arm does, and in that order for the same reason. A prep is additionally bounded by
// PREP_MAX_MS, a backstop against a WEDGED prep; see that constant for why it is deliberately NOT
// the worktree-lock hold ceiling.
//
// plan 2738 also SPLITS THE PREP EXIT CLASSES. A conflict or a failed gate genuinely does re-surface
// at head, so "logged, continuing to wait" is true for those. It is FALSE for a lock-contention or
// error exit, which means keep-hot is not running at all — a liveness fault in the watcher's own
// machinery, not a property of the branch. Collapsing both into one benign line is why 36 minutes of
// dead keep-hot read as healthy in the log; classifyPrepExit + prepExitReport keep them apart and
// escalate a run of infrastructure exits.
//
// --pure-poll is the explicit opt-out: the plan-968 pure poll, for read-only observation of a
// queue you must not mutate. It is NOT the cheap option for a real land — see the load story
// below.
//
// LOAD STORY for the default-on prep: keep-hot preps serialize through the battery-lock, and the
// per-slug worktree lock already dedups overlapping preps (plan 2473), so N flagless waiters do
// not herd. Deep-tail re-preps cost serialized CPU only — accepted, and the same behavior the
// runbook already recommended for every attended waiter. A position-gate on preps is deliberately
// OUT of scope; file a follow-up if load data ever says otherwise.
//
// Exit codes (informational — the background re-invoke fires on ANY exit; the woken
// session reads the final line to branch):
//   0  HEAD    — slug is head of the queue, your turn to land → run `done-worktree <slug>`
//   3  GONE    — slug no longer in the queue (landed already, or the head slot was stolen)
//   4  TIMEOUT — still not head after --timeout → relaunch the watcher, or escalate
//   5  ERROR   — bad args, or repeated status failures (e.g. the queue doc is corrupt)
//
// --heartbeat-every (whole-wait heartbeating) is OFF by default: `stealVerdict` /
// `demoteVerdict` (landing-queue-lib.mjs) only ever check the HEAD's heartbeat, so a
// DEEP-tail waiter's heartbeat age is irrelevant — default-off keeps the long tail of
// the wait pure-read (no origin/master commit noise from 5-7 parallel waiters).
//
// plan 2085: NEAR the head the watcher SELF-ARMS heartbeating — position <=
// NEAR_POSITION_THRESHOLD bumps every SELF_ARM_HEARTBEAT_SEC (effectiveHeartbeatSec),
// plus one refresh at head-exit. Before 2085 the flag was the ONLY way to heartbeat and
// the canonical QUEUE_WAIT seam text handed out the flagless command — so any land
// waiting past DEFAULT_DEMOTE_STALE_MIN reached head with a stale entry and was demoted
// by the plan-1682 sentinels inside done-worktree's ~26 s pre-queue preflight, re-
// enqueued at the tail, and livelocked (4 consecutive head-demotes observed 2026-07-19,
// plan 1999). The knob documented the exact hole it existed to plug; it is now armed by
// default precisely in the window where the demote math looks. --heartbeat-every remains
// for whole-wait heartbeating (a value faster than the self-arm cadence also speeds up
// the near-head bumps).
//
// plan 1682: the watcher is ALSO the demote sentinel. When the SAME head has been
// observed continuously for ≥ the demote threshold while we wait behind it, fire one
// `landing-queue.mjs demote <slug>` attempt (throttled to one per DEMOTE_RETRY_MS) —
// the CLI holds every gate itself (heartbeat age, 🟢 LANDING board row, starvation cap)
// and refuses with exit 2 when the head is legitimately mid-land. The local
// same-head-observation clock exists only to keep the attempts (and their extra fetch)
// rare; eligibility is always re-judged fresh by the CLI. A taken demote re-polls
// immediately — we may be head now.
//
// plan 1807 lever 2: two-tier poll cadence — NOT a distance-scaled/adaptive formula
// (the plan explicitly pins "hardcoded two-tier ... no derived/adaptive formula in
// v1"). This watcher — launched detached per docs/coord/landing-queue.md
// § "Chunked, resumable waiting" — is the LIVE head-detection path in normal
// operation (done-worktree.mjs's own in-process --wait loop is CLAUDE.md-forbidden to
// run detached and is dormant in the real ripple flow; plan 1807 confirmed this
// before touching either poll loop — see the plan body for the trace). Because
// watchVerdict() returns done:true for position 1 and 0 BEFORE the sleep is ever
// reached, NEAR_POSITION_THRESHOLD=2 means, in practice, only a waiter at EXACTLY
// position 2 ever gets the faster nearSec cadence — every deeper position
// intentionally keeps today's (slower) intervalSec, by design, not as an
// unaddressed gap: a waiter 3+ slots from head is still far enough out that the
// git-fetch-load tradeoff below (the 120s-vs-60s reasoning, extended to nearSec's
// 30s) dominates over shaving its wait time. The demote
// sentinel's own attempt throttle (nextDemoteMs, DEMOTE_RETRY_MS) is independent of
// poll cadence already, so speeding up the poll near head does not amplify
// demote-attempt frequency.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_DEMOTE_STALE_MIN,
  DEFAULT_STEAL_STALE_MIN,
  DEFAULT_REAP_STALE_MIN,
  stealLocallyEligible,
  HOLDING_STATE,
  IN_LAND_STATE,
  deadLandVerdict,
  firstHostLabel,
} from './landing-queue-lib.mjs';
import { parseFlags, resolveMain } from './coord-git.mjs';
import {
  mergeTreeConflictProbe,
  lqWatchPidfileRel,
  // plan 3274 (review round, F3 review fix): the shared prep-mode exit-code map (beside EXIT/SEAM
  // in done-worktree-lib.mjs) — PREP_EXITS' own GATE_CHUNKED row keys off PREP_EXIT.GATE_CHUNKED
  // directly rather than a re-typed `40` literal, closing the same class of drift that produced the
  // GATE_CHUNKED=10 collision this map's own history (below) already fixed once.
  PREP_EXIT,
} from './done-worktree-lib.mjs';
import {
  pidAlive,
  describeWorktreeLockHolder,
  readWorktreeLockEntry,
  resolveWorktreeLockPath,
  worktreeLockIsLive,
} from './worktree-lock.mjs';
import { spawnWithTreeKill, killProcessTree, waitForExit } from './kill-tree.mjs';
import { atomicWriteJsonSync } from './atomic-write.mjs';
import { attributeConflict, formatConflictCulprits } from './land-lib.mjs';
import { scriptsFileFrom } from './scripts-anchor.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';
// plan 3422 D5 (gpt-review 7d8839 / 7fa184): the repo's ONE best-effort desktop toast-notification
// helper is reused rather than re-typed. plan 4096 T1 (S3): it is FLEET-side (wake-stalls.mjs,
// whose graph reaches the account registry and the cloud-routine specs), and this watcher is core
// — the land spine binds it — so the static import is gone. The toast is now an injected
// dependency with a no-op default. plan 4096 T2: this module now lives under scripts/coord/, which
// may import only coord siblings and node: builtins (Rule 3) — so the project wiring (the guarded
// optional-import load of scripts/project/land-notify.mjs) moved OUT to the path-compat shim left
// behind at scripts/landing-queue-watch.mjs, which calls `setDeadLandToast` before running `main`.
// A checkout without a project layer, or a caller that invokes this core module directly, simply
// keeps the no-op default. The board line is the channel the alarm rides on either way (see
// raiseDeadLandAlarm).

let deadLandToast = () => {};
/** Inject the dead-land desktop notifier (title, body) — best-effort, must never throw. */
export function setDeadLandToast(fn) {
  if (typeof fn !== 'function') throw new TypeError('setDeadLandToast: expected a function');
  deadLandToast = fn;
}

// Each poll shells `landing-queue.mjs status`, which `git fetch`es origin/master AND the
// queue ref (plan 3973: the doc lives on refs/heads/coord/landing-queue; this file never
// reads it directly — the status subprocess is the one reader it needs).
// 120s keeps head-detection timely while halving the fetch load a 60s default would
// add to the already-contended shared `.git` (×5-7 parallel waiters); being a couple
// minutes late to land is harmless. Override with --interval for a faster local test.
export const DEFAULT_INTERVAL_SEC = 120;
export const DEFAULT_TIMEOUT_SEC = 14400; // 4h — bounds a wedged-queue zombie watcher
// plan 3422 D3: was 0 (off — deep positions never heartbeated, and only the position-<=2
// self-arm below kept an entry demote-fresh). The 2026-08-24 landing audit measured what that
// costs: plan 2347 waited quietly ~124 min at a deep position, its queue heartbeat aged past
// DEFAULT_DEMOTE_STALE_MIN, and a waiter demoted it to the tail JUST as it reached position 2 —
// the entry was stale on arrival because nothing had refreshed it on the way there. The default
// is now the self-arm cadence itself, so the watcher heartbeats at EVERY position and an entry
// can never approach the head already stale. Defined below SELF_ARM_HEARTBEAT_SEC (a `const` is
// in TDZ until its own initializer runs, so this cannot be hoisted above it).
// plan 1807 lever 2: near-head fast poll. position <= this threshold uses nearSec
// instead of the (slower) base interval — position 1 and 0 are both terminal
// (watchVerdict returns done:true before the sleep is ever reached), so in practice
// only position 2 exercises this tier; a waiter one slot from head still gets it.
// This DOES reintroduce some of the git-fetch-contention cost the 120s-vs-60s
// reasoning above was written to avoid — deliberately, and narrowly scoped: at most
// ONE waiter across the whole fleet is ever at position 2 at a time (a FIFO has a
// single occupant per position), so the added fetch volume is one extra poll every
// 30s from a single session, not a fleet-wide amplification. A failed status read
// falls back to the (slower) far tier (selectPollIntervalSec's null-position
// branch), so contention-driven read failures self-throttle rather than compound.
export const NEAR_POSITION_THRESHOLD = 2;
export const DEFAULT_NEAR_INTERVAL_SEC = 30;
// plan 2085: the self-armed near-head heartbeat cadence. DERIVED from the plan-1682
// demote threshold (3× margin — a cadence at or past the threshold would make the
// self-arm decorative), so a future re-tune of DEFAULT_DEMOTE_STALE_MIN moves it in
// lockstep (review r2 [6]). = 300 s today, matching the manual `--heartbeat-every 300`
// workaround the plan-1999 incident applied; the margin relation is additionally pinned
// by a regression test in landing-queue-watch.test.mjs.
export const SELF_ARM_HEARTBEAT_SEC = Math.floor((DEFAULT_DEMOTE_STALE_MIN * 60) / 3);
// plan 3422 D3 (see the note above NEAR_POSITION_THRESHOLD): heartbeating is ON at every
// position, at the same demote-derived cadence the near-head self-arm uses. An explicit
// --heartbeat-every still overrides it, and near head effectiveHeartbeatSec still tightens a
// slower flag value to the self-arm cadence.
export const DEFAULT_HEARTBEAT_SEC = SELF_ARM_HEARTBEAT_SEC;
// plan 2085 review [5]: the head-exit refresh is skipped when THIS watcher wrote a
// heartbeat within the last minute — the entry is already demote-fresh, so a second
// back-to-back coordWrite buys zero freshness.
export const HEAD_EXIT_REFRESH_MIN_AGE_MS = 60_000;
// plan 1682: minimum gap between demote ATTEMPTS against one long-held head — a refusal
// (head actively mid-land past the threshold, e.g. a slow merge-step battery) must not
// re-fetch on every 120s poll.
export const DEMOTE_RETRY_MS = 4 * 60_000;
// plan 2275: minimum gap between OVERTAKE attempts. Same cadence rationale as the demote
// throttle; the verb needs no staleness observation clock (a HOLDING head is overtakable
// the moment it parks — state-keyed, not staleness-keyed), so a plain time throttle is
// the whole decision, gated locally on this poll's own payload (own lane 🟩 + headState
// HOLDING) so refused spawns stay rare (most refusals — path overlap, starvation cap —
// are stable for the life of a holding episode).
export const OVERTAKE_RETRY_MS = DEMOTE_RETRY_MS;
// plan 2331: minimum gap between REAP attempts. Same cadence rationale as demote/steal —
// a refusal (grace still pending, board LANDING, HOLDING) must not re-fetch on every poll.
// The CLI's own arm-then-fire grace (default 10 min) is a SEPARATE, longer-running clock
// on the queue doc itself; this throttle only bounds how often THIS watcher pays for the
// spawn+fetch while that grace plays out.
export const REAP_RETRY_MS = DEMOTE_RETRY_MS;
// Repeated status failures (transient git-fetch churn is normal; a persistent run is
// a corrupt queue doc) — bail to ERROR so a broken queue surfaces instead of spinning.
const MAX_CONSECUTIVE_ERRORS = 8;

// plan 4096 T2: anchored on the `scripts/` directory NAME (scripts-anchor.mjs), not on this file's
// own depth — every one of these is a top-level scripts/ command, and this module now lives one
// level down in scripts/coord/. The watcher runs inside the worktree it is keeping hot, so the
// sibling copy found from THIS file's own directory is the right one for that worktree.
const HERE_DIR = dirname(fileURLToPath(import.meta.url));
const LQ_CLI = scriptsFileFrom('landing-queue.mjs', HERE_DIR);
const DW_CLI = scriptsFileFrom('done-worktree.mjs', HERE_DIR);
// plan 2738: the provably-stale lock clearer run after aborting a prep (see abortPrep).
const CLEAR_STALE_CLI = scriptsFileFrom('clear-stale-worktree-lock.mjs', HERE_DIR);

// --- pure --------------------------------------------------------------------

// The terminal/continue decision for one status read. `position` is 1-based; 0 means
// "not in the queue" (landing-queue-lib positionOf). Total functions only.
export function watchVerdict({ position, total }) {
  if (position === 1) {
    return { kind: 'head', done: true, code: 0, message: `your turn to land (1/${total})` };
  }
  if (position === 0) {
    return {
      kind: 'gone',
      done: true,
      code: 3,
      message: 'no longer in the queue (landed already, or the head slot was stolen)',
    };
  }
  return { kind: 'waiting', done: false, code: null, message: `position ${position}/${total}` };
}

// Boolean-aware arg parser — since plan 1777 a spec'd wrapper over the shared coord-git
// parseFlags (plan 1769). Throws on a missing slug or a non-positive numeric flag so a
// typo fails loudly at the CLI rather than waiting forever; an unknown flag now ALSO
// throws (the old loop silently consumed `--typo value` pairs — the 1769 strictness).
// Keep-hot (rebase+gate-revalidate while waiting, plan 972) is ON unless `--pure-poll` opts out
// — plan 2551 flipped the default; see the header for why. `--keep-hot` stays in the boolean
// list so every pre-flip recipe still PARSES (it is a no-op: the value it would have set is
// already the default). Removing it would turn a stale-but-safe invocation into a hard
// "unknown flag" throw, which is the opposite of the safe-by-default posture of the flip.
// `--near-interval` is plan 1807 lever 2: the fast-tier cadence at position <=
// NEAR_POSITION_THRESHOLD; `--interval` keeps meaning the base/far-tier cadence.
export function parseWatchArgs(argv) {
  const { positionals, flags } = parseFlags(argv, {
    label: 'landing-queue-watch',
    value: ['interval', 'timeout', 'heartbeat-every', 'near-interval'],
    boolean: ['json', 'keep-hot', 'pure-poll'],
  });
  const slug = positionals[0];
  if (!slug) throw new Error('landing-queue-watch: needs a <slug>');

  const num = (name, val, def) => {
    if (val == null) return def;
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`--${name} must be a positive number (got "${val}")`);
    return n;
  };
  return {
    slug,
    intervalSec: num('interval', flags.interval, DEFAULT_INTERVAL_SEC),
    timeoutSec: num('timeout', flags.timeout, DEFAULT_TIMEOUT_SEC),
    heartbeatEverySec: num('heartbeat-every', flags['heartbeat-every'], DEFAULT_HEARTBEAT_SEC),
    nearIntervalSec: num('near-interval', flags['near-interval'], DEFAULT_NEAR_INTERVAL_SEC),
    json: flags.json === true,
    // Default ON; only the explicit opt-out turns it off (`--keep-hot` is therefore a no-op).
    keepHot: flags['pure-poll'] !== true,
  };
}

// plan 1807 lever 2: pure poll-interval selection. position null (status read failed
// this poll) falls back to farSec — fail toward the SLOWER, already-safe cadence rather
// than hammering a possibly-broken queue doc. position <= NEAR_POSITION_THRESHOLD (in
// practice only 2 — see the constant's comment) gets nearSec; everything else farSec.
// plan 2085 review [8]: the ONE near-head predicate — poll cadence and heartbeat
// self-arm key off the SAME window by construction (a drift between the two literal
// checks would desync polling speed from heartbeat cadence exactly at the boundary).
// null/0 (failed status read / gone) is never near.
export function isNearHead(position, threshold = NEAR_POSITION_THRESHOLD) {
  return position != null && position >= 1 && position <= threshold;
}

export function selectPollIntervalSec({
  position,
  nearSec = DEFAULT_NEAR_INTERVAL_SEC,
  farSec = DEFAULT_INTERVAL_SEC,
}) {
  return isNearHead(position) ? nearSec : farSec;
}

// plan 2085: pure heartbeat-cadence selection — the self-arm twin of
// selectPollIntervalSec. Deep positions (or an unknown position after a failed status
// read) keep the flag's value verbatim: 0 (the default) stays pure-read, an explicit
// --heartbeat-every keeps its whole-wait meaning. At position <= threshold the watcher
// self-arms: heartbeating turns ON at SELF_ARM_HEARTBEAT_SEC even flagless, and an
// explicit slower flag is tightened to the self-arm cadence (min) — near head the
// demote clock (DEFAULT_DEMOTE_STALE_MIN) is the binding constraint, not the flag.
// An explicit FASTER flag wins (min again). Total function.
export function effectiveHeartbeatSec({
  position,
  heartbeatEverySec,
  selfArmSec = SELF_ARM_HEARTBEAT_SEC,
  threshold = NEAR_POSITION_THRESHOLD,
}) {
  if (!isNearHead(position, threshold)) return heartbeatEverySec;
  return heartbeatEverySec > 0 ? Math.min(heartbeatEverySec, selfArmSec) : selfArmSec;
}

// plan 3422 D3: the heartbeat-NOW decision, pure so the transition arm is unit-testable apart
// from the loop's clock bookkeeping.
//
// Two independent reasons to write. (1) CADENCE — the usual `hbSec` window since this watcher's
// last write (seeded at watcher start, so a fresh watcher does not write on its first poll).
// (2) THE NEAR-HEAD TRANSITION ARM — the poll that FIRST observes near-head writes immediately,
// whatever the cadence clock says. That second reason exists because the observation itself can
// be stale: away from the head the poll interval is DEFAULT_INTERVAL_SEC (120 s), so the move
// into position <= threshold may have happened up to a full far-interval ago, and the entry can
// reach the head — where the plan-1682 demote check actually fires — inside that gap. Arming on
// the transition closes it; waiting out another cadence window does not. `prevPosition` is
// Infinity before the first poll, so a watcher that STARTS near head arms on poll 1 (the case
// where the slot has been sitting unrefreshed since some other session enqueued it).
export function shouldHeartbeatNow({
  position,
  prevPosition,
  hbSec,
  lastWriteMs,
  cadenceSeedMs,
  nowMs,
  threshold = NEAR_POSITION_THRESHOLD,
}) {
  if (isNearHead(position, threshold) && !isNearHead(prevPosition, threshold)) {
    return { write: true, reason: 'near-head-transition' };
  }
  if (!(hbSec > 0)) return { write: false, reason: 'off' };
  if (nowMs - (lastWriteMs ?? cadenceSeedMs) >= hbSec * 1000) {
    return { write: true, reason: 'cadence' };
  }
  return { write: false, reason: 'within-window' };
}

// plan 1682 (review [5]): the demote-sentinel decision as a PURE step so the clock
// bookkeeping is unit-testable. Given this poll's observed head + verdict kind and the
// carried state, returns the next { observedHead, headSinceMs, nextDemoteMs } plus
// `attempt` — whether THIS poll should fire a demote. Invariants the tests pin:
// the observation clock resets ONLY on an actual head change (never on a mere re-poll);
// only 'waiting' polls ever attempt; the same head must have been observed continuously
// ≥ staleMs; attempts are spaced ≥ retryMs apart regardless of the attempt's outcome.
// plan 2266: shared core factored out for the new stealSentinelStep (mirrors how
// landing-queue-lib.mjs's headDisplacementVerdict was factored out of steal/demote —
// review 1682 [3]'s lesson: twin hand-rolled per-verb clock skeletons are exactly where
// a fix lands in one verb and stays a hole in the other). demoteSentinelStep keeps its
// existing name/params/return shape (a thin wrapper) so no caller or test changes.
function sentinelStep({
  head,
  kind,
  nowMs,
  observedHead,
  headSinceMs,
  nextAttemptMs,
  staleMs,
  retryMs,
}) {
  if (head !== observedHead) {
    return { observedHead: head, headSinceMs: nowMs, nextAttemptMs, attempt: false };
  }
  if (kind !== 'waiting' || nowMs - headSinceMs < staleMs || nowMs < nextAttemptMs) {
    return { observedHead, headSinceMs, nextAttemptMs, attempt: false };
  }
  return { observedHead, headSinceMs, nextAttemptMs: nowMs + retryMs, attempt: true };
}

export function demoteSentinelStep({
  head,
  kind,
  nowMs,
  observedHead,
  headSinceMs,
  nextDemoteMs,
  staleMs = DEFAULT_DEMOTE_STALE_MIN * 60_000,
  retryMs = DEMOTE_RETRY_MS,
}) {
  const r = sentinelStep({
    head,
    kind,
    nowMs,
    observedHead,
    headSinceMs,
    nextAttemptMs: nextDemoteMs,
    staleMs,
    retryMs,
  });
  return {
    observedHead: r.observedHead,
    headSinceMs: r.headSinceMs,
    nextDemoteMs: r.nextAttemptMs,
    attempt: r.attempt,
  };
}

// plan 2266: the steal-sentinel's own clock — SAME throttle cadence as the demote sentinel
// (DEMOTE_RETRY_MS), but its OWN observedHead/headSinceMs/nextStealMs triple (never shared
// with the demote sentinel's): the two verbs' staleMs thresholds differ (15 min vs 45 min),
// so a shared clock would let whichever verb resets first silently rearm the other early.
export const STEAL_RETRY_MS = DEMOTE_RETRY_MS;

export function stealSentinelStep({
  head,
  kind,
  nowMs,
  observedHead,
  headSinceMs,
  nextStealMs,
  staleMs = DEFAULT_STEAL_STALE_MIN * 60_000,
  retryMs = STEAL_RETRY_MS,
}) {
  const r = sentinelStep({
    head,
    kind,
    nowMs,
    observedHead,
    headSinceMs,
    nextAttemptMs: nextStealMs,
    staleMs,
    retryMs,
  });
  return {
    observedHead: r.observedHead,
    headSinceMs: r.headSinceMs,
    nextStealMs: r.nextAttemptMs,
    attempt: r.attempt,
  };
}

// plan 2331 (sonnet-review fix): the reap-sentinel's own clock, mirroring
// stealSentinelStep — SAME shared `sentinelStep` core, its OWN observedHead/
// headSinceMs/nextReapMs triple (never shared with demote's or steal's: reap's
// staleMs threshold, 45 min, differs from demote's 15 min, and reusing steal's clock
// would let whichever verb resets first silently rearm the other early — the same
// reasoning STEAL_RETRY_MS's header already gives for not sharing with demote).
// This watcher-side clock only decides WHEN to spawn `landing-queue.mjs reap` — the
// CLI's own arm-then-fire grace (landing-queue-lib.mjs reapVerdict) is the real
// eligibility gate and is re-verdicted fresh on every spawn, exactly like demote/
// steal's CLI-side gates.
export function reapSentinelStep({
  head,
  kind,
  nowMs,
  observedHead,
  headSinceMs,
  nextReapMs,
  staleMs = DEFAULT_REAP_STALE_MIN * 60_000,
  retryMs = REAP_RETRY_MS,
}) {
  const r = sentinelStep({
    head,
    kind,
    nowMs,
    observedHead,
    headSinceMs,
    nextAttemptMs: nextReapMs,
    staleMs,
    retryMs,
  });
  return {
    observedHead: r.observedHead,
    headSinceMs: r.headSinceMs,
    nextReapMs: r.nextAttemptMs,
    attempt: r.attempt,
  };
}

// plan 2275 (review F4): the overtake-attempt decision as a PURE step, mirroring
// demoteSentinelStep/stealSentinelStep's testability. Unlike those two it carries NO
// same-head observation clock — overtake is STATE-keyed (a HOLDING head is eligible
// the moment it parks, and a holding episode is stable for its whole life), so the
// time throttle plus the two payload gates (own lane 🟩, headState HOLDING) IS the
// whole decision. Returns {attempt, nextOvertakeMs}; nextOvertakeMs advances only on
// a fired attempt (a gated-out poll must not push the next eligibility window back).
export function overtakeSentinelStep({
  kind,
  nowMs,
  nextOvertakeMs,
  lane,
  headState,
  retryMs = OVERTAKE_RETRY_MS,
}) {
  if (
    kind !== 'waiting' ||
    lane !== '🟩' ||
    headState !== HOLDING_STATE ||
    nowMs < nextOvertakeMs
  ) {
    return { attempt: false, nextOvertakeMs };
  }
  return { attempt: true, nextOvertakeMs: nowMs + retryMs };
}

// plan 2274 Fix 1: should THIS poll run the (non-mutating) STALE-WHILE-QUEUED probe? Unlike
// keep-hot this is ALWAYS ON (no opt-in flag) — the plan-2233 post-mortem's gap was a branch
// going stale across the WHOLE deep-queue wait (position 8), not just the plan-1805 near-head
// window, and it must never mutate the worktree (the post-mortem's near-miss WAS a mutating
// rebuild). Only while WAITING (head → land; gone → exit), and only when origin/master
// ADVANCED since the last probe — re-probing an unchanged tip is a wasted merge-tree call. A
// null tip (rev-parse failed) skips this poll rather than probing against an unknown base. Pure.
export function staleWhileQueuedShouldProbe({ kind, tip, lastProbedTip }) {
  if (kind !== 'waiting') return false;
  if (!tip) return false;
  return tip !== lastProbedTip;
}

// plan 2274 Fix 1: render the loud advisory line for a conflicted probe. `culpritText` is
// formatConflictCulprits' output (land-lib.mjs) — may be '' when attribution itself failed
// (best-effort; a probe must never crash the watcher over a diagnostic-only step).
export function formatStaleWhileQueued(slug, files, culpritText) {
  const body =
    culpritText && culpritText.trim() ? culpritText : files.map((f) => `  - ${f}`).join('\n');
  return (
    `STALE-WHILE-QUEUED (plan 2274): ${slug}'s branch now CONFLICTS with the current ` +
    `origin/master — reconcile during the wait (the slot is kept), not at head:\n${body}`
  );
}

// plan 972 keep-hot: should this poll fire a `done-worktree --prep`? Only while WAITING (head →
// land; gone → exit) and only when origin/master ADVANCED since the last prep — a rebase onto an
// unchanged tip is a no-op (runLandPrep idempotently skips it). The first poll (lastPreppedTip
// null) preps to stamp the initial marker. A null tip (rev-parse failed) skips this poll rather
// than prepping against an unknown base. Pure.
// plan 2738: `prepRunning` is the new gate. The prep used to be synchronous, so "a prep is already
// in flight" was unrepresentable — the loop simply could not come back around. Now that it is a
// supervised child, a second master advance mid-prep would otherwise spawn a RIVAL prep against the
// same worktree; the per-slug worktree lock would refuse it (BUSY), but that refusal is precisely
// the infrastructure exit class this plan teaches the watcher to treat as alarming, so we must not
// manufacture it ourselves. Defaults false: every pre-2738 caller and test keeps its exact meaning.
export function keepHotShouldPrep({ enabled, kind, tip, lastPreppedTip, prepRunning = false }) {
  if (!enabled) return false;
  if (prepRunning) return false;
  if (kind !== 'waiting') return false;
  if (!tip) return false;
  return tip !== lastPreppedTip;
}

// plan 2738: the backstop for a WEDGED prep — NOT a runtime budget for a healthy one.
//
// TWO WRONG ANCHORS, BOTH REJECTED BY REVIEW, so state the policy outright rather than alias a
// third constant:
//   * WORKTREE_LOCK_MAX_HOLD_MS (40 min, the first cut) — "a prep must not outlive its lock" reads
//     right and is wrong: that ceiling is a NO-RENEWAL ceiling, and `runLandPrep` renews between
//     phases (done-worktree's `renewOrAbort`), so a healthy-but-slow prep keeps its lock
//     indefinitely. Killing at 40 min would have killed exactly the long, valid preps keep-hot
//     exists to produce — this plan's own failure, reintroduced by its own safety bound.
//   * WATCHER_PIDFILE_MAX_AGE_MS (120 min, the second cut) — the right NUMBER for the wrong REASON.
//     That constant is the duplicate-spawn suppression policy; a future re-tune of it (say, to make
//     a crashed watcher's advertisement expire sooner) would silently move this watchdog with it,
//     for reasons that have nothing to do with preps.
// So: an INDEPENDENT constant, derived from the thing it actually guards. battery-lock puts a gate
// battery's worst case, retry included, at ~50 min on this 5-7-session machine; double it, because
// the only cost of overshooting is that a wedged prep is killed late (the head/gone abort is the
// lever that matters in practice), while undershooting kills healthy work. The test beside it pins
// the ONE relation that must hold — comfortably above the lock's no-renewal ceiling.
// Checked once per poll, so the true bound is this plus one poll interval: fine for a backstop
// whose whole job is catching something already broken.
export const PREP_MAX_MS = 120 * 60 * 1000;

// plan 2738: should an in-flight keep-hot prep be aborted this poll, and why? Pure.
//   'head' / 'gone' — the wait is over; the prep's whole value was arriving at head already
//                     prepared, so continuing it only delays the wake it was meant to speed up.
//   'timeout'       — it reached PREP_MAX_MS (see above).
// Null means let it run. `kind` is watchVerdict's kind for THIS poll.
export function prepAbortReason({ running, kind, startedMs, nowMs, maxMs = PREP_MAX_MS }) {
  if (!running) return null;
  if (kind === 'head') return 'head';
  if (kind === 'gone') return 'gone';
  if (nowMs - startedMs >= maxMs) return 'timeout';
  return null;
}

// plan 2738: `done-worktree --prep`'s exit codes, split by WHAT THE OPERATOR SHOULD CONCLUDE.
// The codes themselves are done-worktree.mjs's PREP_EXIT map; this is the watcher's reading of them.
//
//   'benign' — CONFLICT (7) / GATE_FAILED (8) / GATE_CHUNKED (40). CONFLICT/GATE_FAILED are a real
//              property of the branch that genuinely does re-surface at head as LAND_BLOCKED_HOLDING.
//              GATE_CHUNKED (plan 3274) is not a branch defect at all — a gate simply ran out of its
//              per-process cloud-chunk time budget; done-worktree.mjs's own comment on the code says
//              "re-invoke to continue", never "there is nothing wrong here". All three prove keep-hot
//              itself is working. GATE_CHUNKED alone also sets `retry: true` (see prepExitReport) —
//              unlike CONFLICT/GATE_FAILED, re-attempting it is not re-deriving the same answer, it
//              is the mechanism that fulfils the "re-invoke to continue" promise (delta-review
//              finding: nothing else re-arms the same tip for another prep, so without this the
//              chunk-and-resume loop the code exists for never actually continues).
//   'infra'  — BUSY (6) / ERROR (9) / anything unrecognised (a preflight seam code, a crash).
//              Keep-hot did NOT run. Nothing about the branch was learned, nothing re-surfaces at
//              head, and a run of these means the branch is silently going cold while the log says
//              the wait is fine — the 2026-08-02 incident verbatim.
// Unknown codes classify as 'infra' deliberately: an exit this file does not recognise is a fault
// in the machinery, and the fail direction that costs an extra warning beats the one that hides a
// 36-minute stall.
// ONE row per exit code — class and operator label together (review finding: two parallel maps make
// a renumbered code easy to update in one and not the other, which shows up as a correct class
// beside an `unexpected exit` label, or worse the reverse).
export const PREP_EXITS = Object.freeze({
  [PREP_EXIT.OK]: { class: 'ok', label: 'prepared' },
  // plan 2940: the prep reached a marker-stamp seam on a DETACHED worktree and refused to certify
  // gates for a sha that is not the branch's tip. `infra`, not `benign`: nothing about this
  // re-surfaces at head (no marker was written — the land simply pays the full battery), and the
  // branch IS going cold, which is precisely what the infra class means. Retrying is right rather
  // than futile — the prep's own no-detached-exit invariant (restorePrepAttachment) re-attaches on
  // the common lossless shape, so the next poll usually succeeds; a tree it could NOT heal (the
  // detached tip carries commits the branch lacks) keeps failing and escalates to KEEP-HOT STALLED
  // after 3, which is the loud line an operator needs for a worktree that wants hand recovery.
  // Registered here rather than left to classifyPrepExit's `infra` default so the operator reads a
  // cause instead of "unexpected exit 5".
  // gpt-review 2940 [216def/65a844]: the label must not say "detached" — exit 5 also covers HEAD
  // attached to the WRONG branch and a HEAD ref that could not be read at all, and each wants a
  // different recovery (the wrong-branch one must specifically NOT be `checkout`ed out of). The
  // prep's own stderr names which of the three actually held; this label points at that rather
  // than guessing the most common case and mis-diagnosing the other two.
  // gpt-review 2940 round 2 [5ecdfd/80b124]: still not "is not on the plan's branch" either — one
  // of the three states exit 5 covers is a HEAD ref that could not be READ, where the truth is that
  // the attachment is UNKNOWN, and sending an operator after branch ownership leaves the actual
  // I/O fault unfixed. The honest label is the one thing all three share: the prep could not
  // confirm the tree is on the plan's branch. Its stderr names which state actually held.
  [PREP_EXIT.DETACHED_STAMP]: {
    class: 'infra',
    label: "refused to stamp — could not confirm the worktree is on the plan's branch",
  },
  [PREP_EXIT.BUSY]: { class: 'infra', label: 'another process holds this worktree' },
  [PREP_EXIT.CONFLICT]: { class: 'benign', label: 'rebase conflict' },
  [PREP_EXIT.GATE_FAILED]: { class: 'benign', label: 'a gate failed after the rebase' },
  [PREP_EXIT.ERROR]: { class: 'infra', label: 'prep error (fetch/IO)' },
  // 10 is done-worktree.mjs's PREFLIGHT_FAIL — a LAND SEAM code, not a PREP_EXIT one, but a
  // `--prep` invocation CAN exit with it (main()'s preflight runs before the `--prep` branch is
  // even reached, e.g. a dirty worktree). It is deliberately left UNMAPPED here rather than given
  // its own row: it falls through to classifyPrepExit's `infra` default, which is the right answer
  // — a preflight failure means keep-hot did NOT run, exactly what `infra` says.
  //
  // plan 3274 (renumbered to 40 — a delta-review finding: 10 already named PREFLIGHT_FAIL in
  // done-worktree.mjs, a code from the SAME script, so a caller could not tell "a gate ran out of
  // chunk budget, re-invoke me" from "the preflight failed"; worse, this map's old row 10 made that
  // collision BENIGN and non-escalating, which would have silently swallowed a genuine preflight
  // failure): the prep hit its per-process cloud-chunk time budget before every gate came back
  // green. `benign`, not `infra` — this is never a real branch defect (a mixed chunked+FAILED pass
  // still reports GATE_FAILED, 8, so a bare 40 means nothing actually failed), and keep-hot itself
  // ran successfully; it just did not finish. Classifying it `infra` would feed the exact stall
  // counter this code is designed to make routine, escalating a "re-invoke me" signal into a false
  // KEEP-HOT STALLED alarm on the very path plan 3274 exists to exercise.
  //
  // (F3 review fix) keyed off PREP_EXIT.GATE_CHUNKED (done-worktree-lib.mjs), never a bare `40` —
  // the SAME shared reference done-worktree.mjs's own runLandPrep returns, so this row can never
  // again silently drift from the code it is meant to classify (the exact class of bug the 10->40
  // renumber above already fixed once).
  [PREP_EXIT.GATE_CHUNKED]: {
    class: 'benign',
    label: 'a gate ran out of its cloud-chunk time budget — re-invoke to continue',
    // (this fix) GATE_CHUNKED gets its OWN message rather than inheriting the CONFLICT/GATE_FAILED
    // 'benign' template below ("a branch-level failure that re-surfaces at head") — that sentence is
    // simply untrue here: nothing failed, nothing is branch-level, and there is nothing waiting to
    // re-surface. A gate ran out of its per-process cloud-chunk time budget and wants to be
    // re-invoked. `message` is the optional per-row override prepExitReport prefers when present;
    // every other row leaves it unset and keeps the shared per-class template.
    // (f96036/ae1359/dc67a0 fix) interpolates PREP_EXIT.GATE_CHUNKED rather than spelling out `40` —
    // a renumber must not leave the diagnosis naming the OLD exit code while classification already
    // follows the new one.
    message:
      `keep-hot --prep exited ${PREP_EXIT.GATE_CHUNKED} (a gate ran out of its cloud-chunk time ` +
      'budget) — nothing failed and nothing is branch-level: the gate wants to be re-invoked to ' +
      'keep checking. keep-hot itself is working, and it will re-invoke the prep against this same ' +
      'tip on a later poll',
    // (delta-review fix) `retry: true` — the ONLY benign row that sets this. CONFLICT/GATE_FAILED
    // leave it false because respinning them against an UNCHANGED tip reproduces the identical
    // answer (see prepExitReport's header). A chunked gate is different: `runLandPrep` clears the
    // land-prep marker on this exit (done-worktree.mjs, same as GATE_FAILED), so nothing carries the
    // partial progress forward — the ONLY way "re-invoke to continue" (this row's own label, and
    // done-worktree.mjs's own comment on the code) ever actually happens is a caller invoking
    // `--prep` again. Before this fix nothing did: `keepHotShouldPrep` only re-fires when
    // origin/master's tip advances past `lastPreppedTip`, and `lastPreppedTip` is set the moment the
    // prep STARTS (before its exit code is known) and, for a `retry: false` row, is never rolled
    // back — so on a quiet master a chunked prep's tip was consumed for the rest of the wait and the
    // branch stayed un-prepped until someone else moved origin/master. `retry: true` rolls
    // `lastPreppedTip` back (the same mechanism the `infra` class already uses), so the very next
    // poll re-arms this tip and fires another prep — proven end-to-end by the
    // "GATE_CHUNKED (40) actually gets re-invoked" CLI test below. It does NOT join the infra
    // escalation counter (consecutiveInfra stays 0, see prepExitReport) — a chunked gate is not a
    // machinery fault, so it retries every poll for as long as the wait lasts, never printing
    // KEEP-HOT STALLED.
    retry: true,
  },
  // plan 3374: the row GATE_CHUNKED's own `retry: true` makes necessary. A gate that has proven
  // ZERO new files for NON_CONVERGENT_ROUNDS consecutive chunk-capped rounds is not going to prove
  // any on the next one — every further round re-enters the same over-wall file. Left unmapped it
  // would fall to classifyPrepExit's `infra` default, which BOTH retries (rolling lastPreppedTip
  // back so the same tip re-fires every poll) and feeds the consecutiveInfra counter into a false
  // KEEP-HOT STALLED alarm; mapped to GATE_CHUNKED's row it would retry forever while calling
  // itself benign. Neither is honest, hence its own row.
  //
  // `benign`, not `infra`: keep-hot itself ran perfectly, and this IS a real property of the branch
  // that genuinely re-surfaces at head — the same thing CONFLICT/GATE_FAILED mean by the class. So
  // it must not feed the infra escalation counter, which exists to catch MACHINERY faults.
  //
  // `retry: false` — and this is the whole point of the row. GATE_CHUNKED sets `retry: true`
  // because re-invoking is the mechanism that fulfils its "re-invoke to continue" promise. Here the
  // opposite holds, and it is exactly the rule CONFLICT/GATE_FAILED already state for `retry:
  // false`: respinning an UNCHANGED tip reproduces the identical answer. The way through is a new
  // COMMIT (slow-mark the file, split it, fix the hotspot), which moves the branch tip and re-arms
  // the prep through the ordinary path.
  [PREP_EXIT.GATE_NON_CONVERGENT]: {
    class: 'benign',
    label: 'a gate cannot converge inside its chunk wall — needs a fix commit, not another round',
    message:
      `keep-hot --prep exited ${PREP_EXIT.GATE_NON_CONVERGENT} (a heavy gate has proven ZERO new ` +
      'files for several consecutive chunk-capped rounds) — this is NOT ordinary chunking and ' +
      'will NOT resolve by being re-invoked: a single test file whose wall exceeds the chunk wall ' +
      'absorbs every round. The prep stderr names the file. Mark it `slow`, split it, or fix its ' +
      'hotspot, then COMMIT — the new tip re-arms the prep on its own. keep-hot itself is working ' +
      'and will NOT re-fire this tip, deliberately',
    retry: false,
  },
});

export function classifyPrepExit(code) {
  return PREP_EXITS[code]?.class ?? 'infra';
}

// plan 2816: the one exit code the sibling-prep stand-down applies to, named rather than spelled `6`
// at the three sites that need it (the reap block's holder read, the pure predicate's own gate, and
// the tests). BUSY is `done-worktree --prep`'s "the per-slug worktree lock is held by someone else"
// — the ONLY exit that can be explained by a healthy sibling. An ERROR (9) or an unrecognised code
// says nothing about the lock, so a live holder observed alongside one is a coincidence, not a cause.
// (f96036/4c58da fix) defined AS PREP_EXIT.BUSY, never a re-typed literal `6` — the exported name
// stays for its existing importers (this file's three call sites + the test file), but its VALUE now
// always tracks done-worktree-lib.mjs's canonical map, so a BUSY renumber can never leave this
// constant behind while PREP_EXITS' own row (keyed the same way) already moved.
export const PREP_EXIT_BUSY = PREP_EXIT.BUSY;

// plan 2738: after N consecutive INFRASTRUCTURE exits, keep-hot is not merely unlucky — it is
// stalled, and the operator needs a line that says so instead of the same benign sentence forever.
// 3 is the smallest count that cannot be one transient collision with a sibling land: at a 120 s
// base cadence it is ~6 minutes of provably-cold branch, well inside the ~36 min the incident ran
// undetected, and well outside a single passing prep.
export const PREP_INFRA_ESCALATE_AFTER = 3;

// plan 2816: THE BUSY THAT IS NOT A FAULT. Plan 2738 (above) reads every BUSY as a machinery fault,
// and on the DESIGNED steady state that is false. Plan 2551 made two preps per slug normal:
// done-worktree's QUEUE_WAIT seam fires a one-shot `dispatchLandPrep` AND spawns the detached
// watcher, so a session that seams QUEUE_WAIT — the documented recipe — reliably produces a SIBLING
// prep this watcher's own prep must bounce off. `keepHotShouldPrep`'s `prepRunning` gate suppresses
// only the watcher's OWN rival; it structurally cannot suppress a process the watcher never spawned.
// Result (plan 2758's land, 2026-08-04): 11 consecutive escalating stalls against ONE healthy prep,
// whose heartbeat was frozen only because `runLandPrep` blocks the event loop in synchronous git
// calls — the exact case worktree-lock.mjs says pid-liveness rather than the heartbeat exists to
// cover. The message was false on the happy path ("the branch is going cold" while the sibling was
// the thing keeping it hot) and its advice ("check the per-slug worktree lock") pointed a human at a
// live mid-battery holder the 40-min ceiling deliberately refuses to reap.
//
// So: on a BUSY, split the class by WHO holds the lock.
//   same slug + owner 'prep' + LIVE  → keep-hot is being done by a sibling. Stand down quietly.
//   anything else (an owner 'land', a foreign slug, an unreadable/CORRUPT record, or a same-slug
//                  prep that classifies STALE) → the plan-2738 alarm, unchanged.
//
// PURE. `holder` is `{ entry, live }` as read at the moment of the BUSY (see readBusyHolder), or
// null when there was nothing to read — null always means "not a stand-down", so every unprovable
// shape falls through to the alarm. Liveness is NOT re-derived here: `live` comes from
// worktree-lock.mjs's `worktreeLockIsLive`, the read-only twin whose own header promises it can
// never disagree with the acquire-side verdict (both route through the private `classifyHolder`).
// That file is OUT of this plan's scope, so the already-exported read-only twin is the reuse seam
// rather than exporting `classifyHolder` itself — same verdict, no edit to the lock.
//
// Returns null (not a stand-down) or `{ wedged, message }`:
//   wedged false — the healthy case. The stand-down line is prefixed `keep-hot stand-down:` so it is
//                  grep-distinct from the stall lines (spec answer 3: the same predicate runs in the
//                  cloud drains, whose logs nobody reads live, and land-health telemetry that counts
//                  stall lines must not count these). It carries the sibling's prep log path — the
//                  USEFUL pointer, in place of the dangerous "check the lock" one (spec answer 4).
//   wedged true  — a sibling that has held the worktree past `maxMs` (PREP_MAX_MS, 120 min) IS
//                  genuinely stuck, and until this plan the watcher had no view of it at all. It
//                  gets its OWN distinct alarm at its OWN much-higher threshold, never the 3-strike
//                  counter (spec answer 1) — closing the false positive must not close the true one.
//                  WHICH STUCK PREP THIS CATCHES, since `live === true` gates it (gpt-review 2816):
//                  the one that keeps RENEWING and simply never ends — exactly what PREP_MAX_MS was
//                  sized for, plan 2738 having explicitly rejected the 40-min lock ceiling as an
//                  anchor because `runLandPrep` renews between phases and a healthy-but-slow prep
//                  therefore holds its lock indefinitely. A prep whose heartbeat FREEZES past that
//                  40-min ceiling is a different animal and needs no arm here: the lock itself
//                  classifies it STALE, so `acquireWorktreeLock` REAPS it on sight and the watcher's
//                  next prep simply takes the lock — it stops producing BUSY at all. And in the
//                  window before the ceiling, a frozen holder is still LIVE (pid-proved), which is
//                  the incident's own case and the stand-down above. Between them there is no shape
//                  that goes quiet: a STALE holder that somehow still refuses falls through to the
//                  unchanged plan-2738 alarm.
// Age is measured from the holder's OWN `startedIso`, not from a watcher-side counter: the lock
// record knows when the sibling actually started, while a counter would only measure how long THIS
// watcher happened to be looking. An unparseable/absent `startedIso` is not wedged — we have proved
// the holder LIVE, and "cannot prove it has been there two hours" is not evidence that it has.
export function keepHotBusyStandDown({ code, slug, holder, nowMs, maxMs = PREP_MAX_MS }) {
  if (code !== PREP_EXIT_BUSY) return null;
  if (!holder || holder.live !== true) return null;
  const entry = holder.entry;
  if (!entry || typeof entry !== 'object') return null;
  if (entry.owner !== 'prep') return null;
  if (entry.slug !== slug) return null;
  const who = describeWorktreeLockHolder(entry);
  const log = `.scratch/land-prep-${slug}.log`;
  const startedMs = entry.startedIso ? Date.parse(entry.startedIso) : NaN;
  const heldMs = Number.isFinite(startedMs) ? nowMs - startedMs : NaN;
  if (Number.isFinite(heldMs) && heldMs > maxMs) {
    return {
      wedged: true,
      message:
        `KEEP-HOT SIBLING PREP WEDGED — ${who} has held ${slug}'s worktree since ` +
        `${entry.startedIso} (${Math.round(heldMs / 60000)} min, past the ` +
        `${Math.round(maxMs / 60000)} min prep backstop). A prep this long is not merely slow; ` +
        `keep-hot cannot run for ${slug} until it lets go. Read its prep log (${log}) and, only if ` +
        `it is genuinely dead, let the next land preempt it.`,
    };
  }
  return {
    wedged: false,
    message:
      `keep-hot stand-down: ${who} is already prepping ${slug} — this IS the keep-hot work ` +
      `(plan 2551 makes two preps per slug the normal state), so the branch is being kept HOT, ` +
      `not going cold. Nothing to check; the sibling's progress is in ${log}.`,
  };
}

// plan 2738: the whole post-prep decision as ONE pure step — the class, the running infra counter,
// whether to RETRY the same tip, and the exact line to log. Returns
// { class, consecutiveInfra, escalate, retry, message }; message is null for a clean exit (nothing
// to say). `consecutiveInfra` resets on ANY non-infra outcome, so a successful prep between two
// BUSYs correctly means keep-hot is alive.
//
// `retry` (review finding) is why an infra exit is not merely logged. keep-hot only fires when
// origin/master ADVANCES, and `lastPreppedTip` is advanced when the prep STARTS — so without an
// explicit retry an infra failure would consume that tip's only attempt: on a quiet master the
// branch then stays cold for the whole wait, AND the streak never reaches the escalation threshold
// because there is never a second attempt to count. Rolling the tip back lets the next poll try
// again. A `benign` exit deliberately does NOT retry BY DEFAULT: a rebase conflict against an
// unchanged tip reproduces identically, so respinning it would burn the wait re-deriving the same
// answer. GATE_CHUNKED (PREP_EXITS[40]) is the one benign exception — its `retry: true` row
// overrides this default (see that row's comment) because, unlike a conflict, re-attempting it is
// not re-deriving the same answer: it is the only thing that ever fulfils its own "re-invoke to
// continue" promise. It still does NOT join the infra escalation counter below — see the 2816
// block's own `retry false` note for the shape of a benign-but-approximate credit, which this is
// not: GATE_CHUNKED's retry is exact, not a credited guess.
//
// RETRY STOPS AT THE ESCALATION THRESHOLD — it is not an unbounded respin. Some infra exits are
// cheap (a BUSY prep stands down at the lock), but others are not: an unrecognised code covers the
// preflight seam range, where a dirty worktree makes every attempt pay a ~26 s preflight before
// failing the same way. Uncapped, that is one `done-worktree` spawn per poll for the rest of a
// multi-hour wait, for a condition that is not going to fix itself. Three attempts is enough to ride
// out transient contention, and once the loud STALLED line has been printed, spinning further adds
// cost and no information. A master advance re-arms the whole cycle by moving the tip.
//
// plan 2816: `standDown` (keepHotBusyStandDown's result, or null) carves the DESIGNED sibling-prep
// BUSY out of the infra class before any of the above applies. Its own class, so nothing downstream
// mistakes it for either half of 2738's split:
//   consecutiveInfra 0 — a LIVE sibling prep is positive proof the machinery works, exactly as a
//                        benign or clean exit is. Not merely "don't increment": leaving an older
//                        streak standing would let two real infra faults plus a stand-down plus one
//                        more fault escalate on a grudge the stand-down already disproved.
//   retry false        — this is spec answer 2, CREDIT the sibling's prep to `lastPreppedTip`. The
//                        retry mechanism works by rolling the tip back; not rolling it back leaves
//                        the tip credited, so the watcher does not re-attempt (and re-collide) once
//                        per poll for the sibling's whole ~15-27 min battery. A sibling that dies
//                        silently is covered by the wedged threshold, not by respinning.
//                        THE CREDIT IS APPROXIMATE AND KNOWINGLY SO (gpt-review 2816, two finders;
//                        it is the tradeoff spec-pass question 2 posed and answered). The lock
//                        record proves a sibling prep is RUNNING; it does not prove which origin
//                        tip that sibling is rebasing onto, nor that it will succeed. So a sibling
//                        dispatched at tip T0 can credit a newer T1 the watcher wanted. What that
//                        costs is bounded: the next master advance re-arms the cycle by moving the
//                        tip, a sibling that fails re-surfaces its own exit through the seam that
//                        dispatched it, and the alternative the spec pass rejected — standing down
//                        on every tip advance — pays one collide per poll for the same information.
//   escalate           — false on the healthy path; true only for the wedged sibling, whose message
//                        is its own distinct alarm rather than KEEP-HOT STALLED.
export function prepExitReport({
  code,
  slug,
  consecutiveInfra = 0,
  threshold = PREP_INFRA_ESCALATE_AFTER,
  standDown = null,
}) {
  const cls = classifyPrepExit(code);
  const label = PREP_EXITS[code]?.label ?? `unexpected exit ${code}`;
  if (cls === 'ok')
    return { class: cls, consecutiveInfra: 0, escalate: false, retry: false, message: null };
  if (cls === 'infra' && standDown) {
    return {
      class: 'standdown',
      consecutiveInfra: 0,
      escalate: standDown.wedged,
      retry: false,
      message: standDown.message,
    };
  }
  if (cls === 'benign') {
    // (this fix) a row MAY carry its own message (see PREP_EXITS[40]) for the case where the
    // shared "branch-level failure that re-surfaces at head" template — written for CONFLICT/
    // GATE_FAILED — would be false. Prefer it when present; every other benign row is unaffected
    // and keeps producing this exact template, byte-for-byte.
    const own = PREP_EXITS[code]?.message;
    // (delta-review fix) same per-row-override shape as `message` above: a row MAY set `retry: true`
    // to opt OUT of the benign default (see PREP_EXITS[40]'s comment for why GATE_CHUNKED is the one
    // row that needs this — a chunked gate's "re-invoke to continue" promise is only ever kept if
    // something actually re-invokes it). Every other benign row leaves it unset and keeps `false`.
    const retry = PREP_EXITS[code]?.retry ?? false;
    return {
      class: cls,
      consecutiveInfra: 0,
      escalate: false,
      retry,
      message:
        own ??
        `keep-hot --prep exited ${code} (${label}) — a branch-level failure that re-surfaces at ` +
          `head; keep-hot itself is working, continuing to wait`,
    };
  }
  const n = consecutiveInfra + 1;
  const escalate = n >= threshold;
  const base =
    `keep-hot --prep exited ${code} (${label}) — KEEP-HOT DID NOT RUN (${n} in a row). This is a ` +
    `fault in the wait's own machinery, NOT a property of the branch: nothing re-surfaces at head, ` +
    `and ${slug}'s branch is going cold` +
    (escalate ? '' : '. Retrying on the next poll');
  return {
    class: cls,
    consecutiveInfra: n,
    escalate,
    retry: !escalate,
    message: escalate
      ? `KEEP-HOT STALLED — ${base}. Check the per-slug worktree lock and the prep log ` +
        `(.scratch/land-prep-${slug}.log); this land will arrive at head needing the full gate battery.`
      : base,
  };
}

// --- IO ----------------------------------------------------------------------

// plan 2738: LQW_FAKE_STATUS_JSON may be a single payload (as since plan 968) or an ARRAY of
// payloads — a SCRIPT of what successive polls see, the last entry repeating forever. A single
// payload cannot express the only thing that matters about this loop: that the queue MOVES while a
// prep is running. Pure, so the indexing rule is pinned by a test rather than by a CLI trace.
export function fakeStatusFor(json, pollIndex) {
  const injected = JSON.parse(json);
  if (!Array.isArray(injected)) return json;
  if (!injected.length) throw new Error('LQW_FAKE_STATUS_JSON: empty poll script');
  return JSON.stringify(injected[Math.min(pollIndex, injected.length - 1)]);
}

// One read of the canonical status (reuses landing-queue.mjs's freshness + orphan-prune
// — no re-implementation, no drift from what a human sees). LQW_FAKE_STATUS_JSON injects
// a payload for a deterministic dry trace (mirrors done-worktree's DW_FAKE_QUEUE_POS).
function readStatus(slug, pollIndex = 0) {
  const raw =
    process.env.LQW_FAKE_STATUS_JSON !== undefined
      ? fakeStatusFor(process.env.LQW_FAKE_STATUS_JSON, pollIndex)
      : execFileSync('node', [LQ_CLI, 'status', slug, '--json'], { encoding: 'utf8' });
  const st = JSON.parse(raw);
  if (typeof st.position !== 'number' || typeof st.total !== 'number') {
    throw new Error(`malformed status payload: ${raw}`);
  }
  return st;
}

// ── plan 3422 D5: the dead-land watchdog's IO half ───────────────────────────────────────────
// The verdict itself is pure (`deadLandVerdict` in landing-queue-lib.mjs); this supplies the two
// IO facts it needs.
//
// The pid probe mirrors landing-queue.mjs's own `demoteHolderPidAlive` gate-for-gate — IN_LAND,
// same host, a usable recorded pid — and returns the same tri-state, so the watchdog and the
// demote verb can never disagree about whether a holder is provably gone. `pidAlive` itself is
// worktree-lock.mjs's probe, already imported here and already what the locks use.
function headHolderPidAlive(st) {
  if (!st || st.headState !== IN_LAND_STATE) return null;
  // Host match uses the FIRST-DNS-LABEL normalization, not `!==` (gpt-review 4e2194 / 65cbed /
  // 4fabf4 / 5fbb2f, CONFIRMED across four angles). `landing-queue.mjs` writes `host: flags.host ??
  // hostname()`, which on Windows can disagree in case/form with this process's `hostname()` — the
  // exact drift plan 3226 documents. A strict compare returns `null` (unprobeable) for the SAME
  // machine, which silently disables the alarm rather than failing loudly, and it would disagree
  // with deadLandVerdict's own same-host predicate one call away. (landing-queue.mjs's
  // demoteHolderPidAlive still uses a strict compare; that is pre-existing and outside this plan's
  // surface — recorded as infra-debt rather than changed under a landing-mutex diff.)
  if (!st.headHost || firstHostLabel(st.headHost) !== firstHostLabel(hostname())) return null;
  const pidNum = Number(st.headPid);
  if (!st.headPid || !Number.isFinite(pidNum) || pidNum <= 0) return null;
  return pidAlive(pidNum);
}

// The sidecar is read ONLY to answer "did this land already end?" — never as a liveness signal
// (see deadLandVerdict's header: it is written on process exit, so its mtime cannot corroborate
// a running land). It is done-worktree.mjs's file, read here strictly read-only.
//
// The read swallows everything: an absent or unreadable sidecar is a legitimate state (the land
// never wrote one), and a watchdog that can crash the wait loop is worse than no watchdog.
export function readLandResultSidecar(mainDir, slug) {
  // The mtime probe that used to sit here is GONE with the signal it fed (gpt-review 956a88): the
  // verdict no longer takes a `sidecarMtimeMs`, so stat-ing the file was dead weight that also
  // implied a liveness meaning the file cannot carry.
  try {
    return {
      sidecar: JSON.parse(
        readFileSync(join(mainDir, '.scratch', `done-worktree-${slug}.result.json`), 'utf8'),
      ),
    };
  } catch {
    // Absent, unreadable, or torn mid-write — all legitimate, and all mean "no terminal record I
    // can trust", which the verdict already treats as "keep judging on the pid".
    return { sidecar: null };
  }
}

// Raise the alarm. Repo-side only, per the plan's Q3 ruling (option A): a board line via
// coordWrite + a best-effort desktop notification. Deliberately NOT a new log file and NOT a new
// hook — the board is where a human already looks, and the `resume` cell is precisely "what has to
// happen for this to move again".
//
// Writing to the HEAD's row means writing to another session's row, which is why this fires ONCE
// per head (the caller's `alarmedHead` latch) and never mutates the queue itself. If the board
// write fails, the stderr line above it has already carried the alarm — nothing here is allowed to
// throw into the poll loop.
function raiseDeadLandAlarm(headSlug, verdict) {
  console.error(
    `landing-queue-watch: ⚠ DEAD-LAND SUSPECTED at the queue head (${headSlug}) — ${verdict.reason} (plan 3422 D5)`,
  );
  if (process.env.LQW_FAKE_STATUS_JSON !== undefined) return; // dry trace: never write
  try {
    execFileSync(
      'node',
      [
        join(dirname(LQ_CLI), 'board.mjs'),
        'update',
        headSlug,
        '--resume',
        `⚠ DEAD-LAND SUSPECTED (plan 3422 D5) — ${verdict.reason}. Verify against git before acting (a sidecar can be stale, plan 2917): \`git merge-base --is-ancestor <mergeSha> origin/master\`. If the land is genuinely dead, its slot is steal/reap-eligible on the usual clocks.`,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
  } catch (e) {
    console.error(`landing-queue-watch: dead-land board note failed (non-fatal) — ${e.message}`);
  }
  // The repo's ONE "notify a human if that channel happens to exist" helper, reused rather than
  // re-typed (gpt-review 7d8839 / 7fa184). It is currently a no-op on this machine — notify.py
  // exits silently without `windows_toasts` — which is exactly why the board line above, not this,
  // is the channel the alarm actually rides on.
  try {
    deadLandToast(`Dead land suspected: ${headSlug}`, verdict.reason);
  } catch {
    /* best-effort: a notifier failure must never reach the poll loop */
  }
}

function heartbeat(slug) {
  if (process.env.LQW_FAKE_STATUS_JSON !== undefined) return; // dry trace: never write
  // plan 2085 review [2]: timeboxed — a heartbeat is a best-effort liveness stamp, and
  // on the head-exit path it sits between "your turn" and the watcher's exit (which is
  // what re-invokes the waiting session). Under heavy shared-.git contention the
  // coordWrite could otherwise stall the wake indefinitely; 60 s bounds it.
  execFileSync('node', [LQ_CLI, 'heartbeat', slug], { encoding: 'utf8', timeout: 60_000 });
}

// The ONE waiter-side recovery-verb spawn wrapper (review 2275 F6 — the same
// dedupe lesson headDisplacementVerdict/attemptAutoRecovery already encode): run the
// CLI verb against our own slug; a refusal (exit 2) or any transient failure → false
// (keep waiting), success → true (we may be head now). The CLI holds every real gate
// per verb — demote: heartbeat age + 🟢 LANDING row + cap (plan 1682); steal: the
// mechanical holder-gone proof, no --confirm-holder-gone ever passed here (plan 2266);
// overtake: HOLDING re-verdict + path-disjointness + cap (plan 2275). Never fires
// under a fake-status dry trace (the watcher stays pure-read).
function tryQueueVerb(verb, slug) {
  if (process.env.LQW_FAKE_STATUS_JSON !== undefined) return false;
  try {
    execFileSync('node', [LQ_CLI, verb, slug], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}
const tryDemote = (slug) => tryQueueVerb('demote', slug);
const tryMechanicalSteal = (slug) => tryQueueVerb('steal', slug);
const tryOvertake = (slug) => tryQueueVerb('overtake', slug);
const tryReap = (slug) => tryQueueVerb('reap', slug);

// plan 972 keep-hot: the live origin/master tip in the worktree the watcher was launched from.
// LQW_FAKE_ORIGIN_TIP injects it for a deterministic test (mirrors LQW_FAKE_STATUS_JSON). null on
// a rev-parse failure → keepHotShouldPrep skips the poll (never preps against an unknown base).
function originTip() {
  if (process.env.LQW_FAKE_ORIGIN_TIP !== undefined) return process.env.LQW_FAKE_ORIGIN_TIP;
  try {
    // plan 4096: an ambient GIT_DIR/GIT_WORK_TREE could otherwise redirect this cwd-scoped
    // read at a different repo than the worktree the watcher was launched from (see
    // scripts/coord/child-env.mjs gitRepoIsolatedEnv()). Local, network-free read.
    return execFileSync('git', ['rev-parse', 'origin/master'], {
      encoding: 'utf8',
      env: gitRepoIsolatedEnv(),
    }).trim();
  } catch {
    return null;
  }
}

// plan 2274 Fix 1: non-mutating merge-tree dry-run of the watcher's own branch (HEAD in this
// worktree) vs a given origin/master tip — WITHOUT any rebase/mutation (the near-miss this fix
// exists to prevent, a rebuild subagent restoring stale content over landed work, makes
// "advisory only, never touches the worktree" a hard requirement here, not a style choice).
// Delegates the actual dry-run + exit-code classification to L.mergeTreeConflictProbe, SHARED
// with done-worktree.mjs's plan-1805 preconvergeProbe (review fix: the two had silently
// diverged before this extraction — see that function's header comment). LQW_FAKE_STALE_PROBE
// injects a result for a deterministic test: 'clean' → no conflicts, a comma-separated path
// list → those files conflict (mirrors LQW_FAKE_ORIGIN_TIP / LQW_FAKE_PREP). Returns null when
// the probe itself is unavailable this tick — callers treat null as "skip this round", never as
// "clean" (fail-open, same posture as preconvergeProbe).
function staleWhileQueuedProbe(masterTip) {
  if (process.env.LQW_FAKE_STALE_PROBE !== undefined) {
    const fake = process.env.LQW_FAKE_STALE_PROBE;
    return fake === 'clean'
      ? { conflicted: false, files: [] }
      : { conflicted: true, files: fake.split(',') };
  }
  return mergeTreeConflictProbe(
    // plan 4096: an ambient GIT_DIR/GIT_WORK_TREE could otherwise redirect this local,
    // network-free merge-tree dry run at a different repo (gitRepoIsolatedEnv()).
    (args) => execFileSync('git', args, { encoding: 'utf8', env: gitRepoIsolatedEnv() }),
    masterTip,
    'HEAD',
  );
}

// plan 2274 Fix 1: best-effort culprit attribution for the probe's conflicted files — reuses
// land-lib.mjs's plan-1000 attributeConflict/formatConflictCulprits (the SAME naming the
// at-head LAND_BLOCKED_HOLDING seam already uses) so a queued waiter sees the identical "who
// landed this" text it would otherwise only see hours later, at head. Never throws: a git
// failure (no resolvable merge-base, etc.) degrades to '' and the caller falls back to a bare
// file list (formatStaleWhileQueued handles the empty case).
function staleWhileQueuedCulprits(files) {
  if (process.env.LQW_FAKE_STALE_PROBE !== undefined) return ''; // dry trace: no real commits to attribute
  try {
    // plan 4096: an ambient GIT_DIR/GIT_WORK_TREE could otherwise redirect this local,
    // network-free merge-base read at a different repo (gitRepoIsolatedEnv()).
    const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/master'], {
      encoding: 'utf8',
      env: gitRepoIsolatedEnv(),
    }).trim();
    if (!base) return '';
    return formatConflictCulprits(attributeConflict(process.cwd(), files, base));
  } catch {
    return '';
  }
}

// plan 972 keep-hot / plan 2738: START one `done-worktree <slug> --prep` (rebase the queued branch
// onto the fresh tip + re-validate gates + stamp the land-prep marker) as a SUPERVISED CHILD and
// return immediately. Through plan 2551 this was an `execFileSync` that blocked the whole poll loop
// for the prep's ~15-27 min — the stall this plan closes (see the header).
//
// `spawnWithTreeKill` rather than a bare `spawn`, for both halves of its contract: the abort below
// must reach the `git` grandchildren the prep is blocked in (a surviving `git push --force-with-
// lease` is exactly the racing writer the worktree lock exists to exclude), and it wires the same
// tree-kill to THIS process's exit, so a killed watcher can no longer orphan a prep that keeps
// rewriting a worktree nobody is watching.
//
// Returns a mutable record: { child, tip, startedMs, exited, code, aborted }. `code` is the prep
// exit code (0 OK / 6 BUSY / 7 CONFLICT / 8 GATE_FAILED / 9 ERROR), or null while it runs.
// LQW_FAKE_PREP injects a code for tests — it yields an already-exited record and never spawns.
// plan 2816: read the per-slug worktree lock's CURRENT holder, for keepHotBusyStandDown to classify.
// Returns `{ entry, live }` or null (nothing readable → the caller treats that as "not a stand-down"
// and the plan-2738 alarm fires — the fail direction that can never hide a real stall).
//
// Called at the MOMENT OF THE BUSY (from beginPrep's exit handler) rather than when the watcher
// reaps the exit at the top of a later poll: the reap can be a full poll interval (up to 120 s)
// after the prep bounced off the lock, by which time a short-lived holder may already be gone and
// the healthy case would misread as a fault.
//
// PAIRING (gpt-review 2816, five independent finders). `worktreeLockIsLive` does its OWN read, so
// the identity we classify (`entry`) and the verdict we classify it with (`live`) come from two
// separate snapshots — and an unguarded pairing is not merely a cosmetically-outdated pid in a log
// line. The turnover that matters: our sibling prep releases and a LAND takes the lock between the
// two reads. `live` is then true OF THE LAND, while `entry` still says `owner: 'prep'` on our slug —
// so a land holding the worktree would be classified as keep-hot-in-progress and silence the alarm.
// Guarded by re-reading afterwards and requiring the SAME `token` (a fresh randomUUID per
// acquisition, so equal tokens prove the record never turned over across the probe). Anything else —
// a changed token, a vanished lock, a record with no token to pair on — returns null and falls
// through to the plan-2738 alarm, the fail direction that can never hide a real stall.
//
// Deriving liveness from the single entry we already read would mean re-implementing
// `classifyHolder`, which is exactly the drift worktree-lock.mjs forbids; three cheap reads under a
// confirm-token is the sound way to get one snapshot out of the exported read-only API.
//
// The lock PATH is memoised per slug (gpt-review 2816, efficiency): `resolveWorktreeLockPath` spawns
// a `git rev-parse` to find the shared common dir, and that answer cannot change for the life of a
// watcher pinned to one worktree.
//
// LQW_FAKE_BUSY_HOLDER injects a `{ entry, live }` payload for a deterministic dry trace (mirrors
// LQW_FAKE_PREP / LQW_FAKE_ORIGIN_TIP).
// The pairing rule itself, PURE and exported so it is pinned by a unit test rather than by a lock
// file a test would have to race. `before`/`after` are the lock record read either side of the
// liveness probe. Returns the `{ entry, live }` the classifier may trust, or null when the two
// snapshots cannot be proven to be the same acquisition.
export function pairBusyHolder({ before, live, after }) {
  if (!before || !before.token) return null; // FREE / CORRUPT / nothing to pair on
  if (!after || after.token !== before.token) return null; // released, reaped, or retaken mid-probe
  return { entry: before, live };
}

const busyLockPathCache = new Map();

// SUCCESS-CACHING ONLY, and the `.set` taking the call's return value directly is what enforces it:
// a throw from `resolveWorktreeLockPath` propagates while the argument is being evaluated, so
// nothing is ever memoised and the next BUSY simply retries. Do not "tidy" this into caching a
// null/undefined fallback. done-worktree.mjs's `worktreeLockFor` carries the same rule with the
// evidence (review 2473-r2 [3]): `git rev-parse` fails transiently under this repo's 5-7-session
// load, and memoising that failure would disable the path for the rest of the invocation.
function busyLockPath(slug) {
  if (!busyLockPathCache.has(slug)) {
    busyLockPathCache.set(slug, resolveWorktreeLockPath(process.cwd(), slug));
  }
  return busyLockPathCache.get(slug);
}

function readBusyHolder(slug) {
  if (process.env.LQW_FAKE_BUSY_HOLDER !== undefined) {
    try {
      return JSON.parse(process.env.LQW_FAKE_BUSY_HOLDER);
    } catch {
      return null;
    }
  }
  try {
    const path = busyLockPath(slug);
    const before = readWorktreeLockEntry(path);
    if (!before) return null; // undefined = FREE, null = CORRUPT — neither is a provable sibling
    const live = worktreeLockIsLive(path);
    return pairBusyHolder({ before, live, after: readWorktreeLockEntry(path) });
  } catch {
    return null; // a lock/git read failure must never crash a watcher over a diagnostic
  }
}

function beginPrep(slug, tip, nowMs = Date.now()) {
  // plan 2816: `busyHolder` is the lock's holder as observed the instant a BUSY exit lands (null for
  // every other exit) — see readBusyHolder for why the observation cannot wait for the reap.
  const rec = {
    child: null,
    tip,
    startedMs: nowMs,
    exited: false,
    code: null,
    aborted: false,
    busyHolder: null,
  };
  // plan 2738: a SLOW stand-in for the prep — a harmless sleeping node process driven through the
  // real spawn/supervise/tree-kill path. LQW_FAKE_PREP (an exit code) short-circuits the spawn
  // entirely and so cannot exercise the one property this plan is about: that the loop keeps
  // polling while a prep runs. This seam can, without a 15-27 min gate battery in a test.
  const sleepMs = process.env.LQW_FAKE_PREP_SLEEP_MS;
  if (sleepMs === undefined && process.env.LQW_FAKE_PREP !== undefined) {
    rec.exited = true;
    rec.code = Number(process.env.LQW_FAKE_PREP) || 0;
    if (rec.code === PREP_EXIT_BUSY) rec.busyHolder = readBusyHolder(slug);
    return rec;
  }
  const [cmd, args, stdio] =
    sleepMs === undefined
      ? ['node', [DW_CLI, slug, '--prep'], 'inherit']
      : ['node', ['-e', `setTimeout(() => {}, ${Number(sleepMs) || 0})`], 'ignore'];
  rec.child = spawnWithTreeKill(cmd, args, { stdio });
  // Kept on the record so `abortPrep` can WAIT for the tree to actually die rather than assume it.
  rec.done = waitForExit(rec.child).then(({ code, error }) => {
    rec.exited = true;
    // A spawn failure (no `error` path leaves `code` null) and a signal death both mean the prep
    // did not run — the ERROR class, which classifyPrepExit already reads as infrastructure.
    rec.code = error ? 9 : (code ?? 9);
    if (rec.code === PREP_EXIT_BUSY) rec.busyHolder = readBusyHolder(slug);
  });
  return rec;
}

// plan 2738: kill an in-flight prep and leave the worktree usable. ASYNC, and the awaiting is the
// point (gpt-review 2026-08-03, four independent finders): `killProcessTree` only DELIVERS a signal
// — on POSIX a plain SIGTERM to the descendant walk — and returns immediately. Cleaning up straight
// after it would run `git rebase --abort` while the prep's own `git` grandchild is still writing the
// tree, which is precisely the two-concurrent-writers corruption the worktree lock exists to
// exclude: the abort would be recreating the bug at the moment it claims to be preventing it.
//
// So this mirrors done-worktree's at-head preemption arm exactly, phase for phase: signal, wait a
// bounded grace for the tree to go, ESCALATE to SIGKILL if it did not, and only then clean up. (On
// win32 `killProcessTree` already force-kills the tree via `taskkill /T /F`, so the escalation is a
// harmless no-op there — the same degradation `terminateWorktreeLockHolder` documents.)
//
// The cleanup itself is the same two steps in the same order, for the same reason: a killed
// `git rebase` can leave rebase state AND an `index.lock`, and `rebase --abort` fails against that
// very lock — so the provably-stale clearer (which never removes a lock a live op holds) runs FIRST.
//
// EVERYTHING here shares ONE deadline. This runs on the path to the wake, so a cleanup that hung
// would recreate the un-woken session this plan exists to fix; a per-step timeout would let a slow
// clearer and a slow abort compound into twice the delay (review finding).
async function abortPrep(rec, slug, reason) {
  if (!rec || rec.aborted) return;
  rec.aborted = true;
  if (rec.exited || !rec.child) return;
  console.error(
    `landing-queue-watch: aborting the in-flight keep-hot prep for ${slug} (${reason}) — ` +
      `waiting for its process tree to die, then clearing its rebase state`,
  );
  try {
    killProcessTree(rec.child);
  } catch {
    /* best-effort by contract — never block the wake on a kill */
  }
  await Promise.race([rec.done, sleep(PREP_ABORT_GRACE_MS)]);
  if (!rec.exited) {
    // The tree outlived a graceful signal. A surviving `git push --force-with-lease` grandchild is
    // the exact racing writer we are excluding, so escalate rather than proceed alongside it.
    console.error(
      `landing-queue-watch: the prep tree for ${slug} outlived SIGTERM by ` +
        `${Math.round(PREP_ABORT_GRACE_MS / 1000)}s — escalating to SIGKILL`,
    );
    try {
      // Through the TREE abstraction, not `rec.child.kill('SIGKILL')` (review round 2, four
      // finders): a bare child kill reaches only the prep's own node process and leaves the `git`
      // grandchildren — which got the first round's SIGTERM and survived it — still writing the
      // worktree. Those grandchildren ARE the racing writer this abort exists to exclude, so
      // escalating past them would be escalating past the entire point. `force` re-arms the
      // once-only guard the first round set.
      killProcessTree(rec.child, { signal: 'SIGKILL', force: true });
    } catch {
      /* already gone / no permission — the cleanup below is still the right next step */
    }
    await Promise.race([rec.done, sleep(PREP_ABORT_KILL_GRACE_MS)]);
    if (!rec.exited) {
      // Say so LOUDLY rather than clean up under a live writer: the land is about to run in this
      // worktree, and "a process we could not kill still owns it" is the operator's problem now.
      console.error(
        `landing-queue-watch: the prep tree for ${slug} SURVIVED SIGKILL — NOT clearing rebase ` +
          `state (doing so under a live writer is the corruption this abort exists to prevent). ` +
          `The land will hit done-worktree's own at-head preemption; check for a stuck git process.`,
      );
      return;
    }
  }
  // Under a dry trace the "prep" was a sleeping stand-in that never touched the worktree, so the
  // cleanup below would run real git against the developer's own tree for nothing. Same posture as
  // every other seam in this file: a fake trace never writes.
  if (process.env.LQW_FAKE_STATUS_JSON !== undefined) return;
  const deadline = Date.now() + PREP_ABORT_CLEANUP_TIMEOUT_MS;
  for (const [cmd, args, benign] of [
    [`node`, [CLEAR_STALE_CLI, '--rebase-state'], null],
    ['git', ['rebase', '--abort'], /no rebase in progress/i],
  ]) {
    const left = deadline - Date.now();
    if (left <= 0) {
      console.error(
        `landing-queue-watch: abort cleanup budget spent before \`${cmd} ${args.at(-1)}\` — ` +
          `skipping it; a surviving leftover surfaces on the land's own rebase`,
      );
      break;
    }
    try {
      execFileSync(cmd, args, { encoding: 'utf8', timeout: left });
    } catch (e) {
      // "no rebase in progress" is the NORMAL case (the prep may have been past the rebase, in the
      // gate battery) — silent. ANYTHING else is a cleanup that did not happen, and the land is
      // about to inherit whatever was left: never swallow it (review finding), or done-worktree
      // dies hundreds of lines later on a raw `index.lock` error with no trace of why.
      const text = `${e?.stdout || ''}${e?.stderr || ''}${e?.message || ''}`;
      if (!(benign && benign.test(text))) {
        console.error(
          `landing-queue-watch: abort cleanup step \`${cmd} ${args.at(-1)}\` FAILED — the land may ` +
            `inherit leftover rebase state: ${String(text).trim().split('\n')[0]}`,
        );
      }
    }
  }
}

// How long a signalled prep tree gets to die before we escalate, and again before we give up.
// Mirrors done-worktree's own two-phase preemption grace: long enough for `git` to unwind and drop
// its locks, short enough that the wake this plan exists to deliver is not delayed by a corpse.
const PREP_ABORT_GRACE_MS = 10_000;
const PREP_ABORT_KILL_GRACE_MS = 5_000;

// ONE budget for the whole cleanup (both steps share it) — see abortPrep's header.
const PREP_ABORT_CLEANUP_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── plan 2551: the per-slug pidfile a live watcher advertises itself with ────────────
//
// Read by the spine's plain-path auto-spawn (done-worktree.mjs) so it can skip spawning a
// SECOND watcher for a slug that already has one. Economy only, never correctness: overlapping
// preps already serialize/dedup via the per-slug worktree lock (plan 2473) + the battery-lock,
// so a missed or stale pidfile costs a redundant detached poller, never a corrupted tree. That
// is why every function here is best-effort and NEVER throws into the watch loop — a watcher
// that cannot write its pidfile must still watch.
//
// Liveness is `pidAlive` (worktree-lock.mjs), the SAME probe the locks use — deliberately not a
// `tasklist` shell-out, which is unreliable on this machine.
function pidfilePathFor(slug) {
  try {
    return join(resolveMain({ assertMaster: false }), lqWatchPidfileRel(slug));
  } catch {
    return null; // MAIN unresolvable → no advertisement; the spine just spawns its own watcher
  }
}

// How long an un-refreshed advertisement stays believable.
//
// THE CEILING MUST EXCEED THE WORST-CASE RUNTIME OF THE THING IT GUARDS — the same rule (and the
// same number) as `battery-lock.mjs`'s DEFAULT_STALE_MIN, and for the same reason. A watcher does
// not only poll: on every master advance it runs `done-worktree --prep` SYNCHRONOUSLY
// (`runPrep`'s execFileSync), which is the full gate battery — tsc, backend vitest, `next build`,
// the WebKit mobile gate — and battery-lock derives that worst case, retry included, at ~50 min on
// this 5-7-session machine, which is why its own ceiling sits at 120. A 30-minute ceiling (this
// constant's first value, review 2026-07-28) would therefore mark a watcher stale precisely while
// it was doing the most useful work it ever does, and a rival spine would spawn a duplicate.
//
// The error is asymmetric, so over-shooting is right: a ceiling that is too HIGH only delays
// lifting the duplicate-spawn suppression for a PID-REUSED orphan (rare, and the pid gate still
// frees a provably-dead holder instantly), while one that is too LOW spawns duplicate watchers
// against a healthy one — the case this ceiling exists to avoid mis-judging.
export const WATCHER_PIDFILE_MAX_AGE_MS = 120 * 60 * 1000;

// Tolerant of THREE shapes: the `{pid, iso, keepHot}` JSON this writes today, the pre-plan-2839
// `{pid, iso}` shape, and a bare pid number (what plan 2551's first cut wrote) — a watcher
// launched from an older checkout can still be running while a newer spine reads its file. A bare
// number parses with `iso: null`, which the age gate below treats as un-refreshed rather than as
// fresh.
//
// plan 2839: `keepHot` is what the advertisement was MISSING. It is deliberately `=== true`, not
// truthy-or-absent: an advertisement written by a PRE-2839 checkout carries no field at all, and
// that checkout stamped the file in BOTH modes — so the only safe reading of a missing field is
// "cannot prove keep-hot coverage", which `watcherIsLive` turns into a free slot. Fail-toward-free
// (see its header): at worst one redundant detached poller.
export function parseWatcherPidfile(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  let pid = null;
  let iso = null;
  let keepHot = false;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      pid = Number(o.pid);
      iso = typeof o.iso === 'string' ? o.iso : null;
      keepHot = o.keepHot === true;
    } else {
      pid = Number(o);
    }
  } catch {
    pid = Number(raw); // legacy bare-pid file
  }
  return Number.isInteger(pid) && pid > 0 ? { pid, iso, keepHot } : null;
}

export function readWatcherPid(path, { _read = readFileSync } = {}) {
  try {
    return parseWatcherPidfile(_read(path, 'utf8'))?.pid ?? null;
  } catch {
    return null; // absent / unreadable / garbage — all mean "nobody is advertising"
  }
}

// Is KEEP-HOT COVERAGE live for this slug right now? That is the only question the sole consumer
// (done-worktree's auto-spawn) asks — the name predates plan 2839, which is when the difference
// started to matter. THREE gates, and each pairing is the point:
//
//   0. MODE (plan 2839) — the advertiser must have declared `keepHot`. A `--pure-poll` watcher
//      does NO rebase and NO gate re-validation, so its presence is not coverage; before this gate
//      it claimed the same pidfile and silently suppressed the spine's auto-spawn for the whole
//      wait, i.e. the cold-wait failure the auto-spawn exists to prevent, arriving by another
//      door. Since 2839 a pure-poll watcher writes nothing at all — this gate is what additionally
//      covers a pure-poll watcher still running from a PRE-2839 checkout (no field ⇒ not coverage).
//      TRANSITION WINDOW, accepted (gpt-review 7c3fb4): while pre-2839 watchers are still alive, a
//      KEEP-HOT one from an old checkout re-stamps `{pid, iso}` every poll and can overwrite a
//      current watcher's record on the same slug, which then reads free. No code here can prevent
//      that — the overwriting process is the OLD checkout — and the cost lands squarely in this
//      probe's documented fail-toward-free direction: a redundant detached poller, which dedups at
//      the per-slug worktree lock. It ends on its own as those watchers exit (one wait each).
//   1. pid — provably dead ⇒ free. `pidAlive` returns null when death cannot be PROVEN (foreign
//      user, exotic kill error), which alone reads as "not dead".
//   2. AGE — the stamp must be fresh. Without this, a crashed watcher whose `process.on('exit')`
//      cleanup never ran (OOM-kill, hard termination) leaves a pidfile the OS can later REASSIGN
//      to an unrelated long-lived process; the pid then probes alive FOREVER and the spine's
//      auto-spawn is silently suppressed for that slug for the rest of its wait — the branch stops
//      being kept hot with no visible signal, i.e. exactly the cold-wait failure this plan exists
//      to remove, reintroduced by its own safety net.
//
// FAIL DIRECTION IS DELIBERATELY OPPOSITE TO THE LOCKS. A lock must fail toward "held" (a false
// free corrupts a tree). This probe must fail toward "free": the only cost of a false free is ONE
// redundant detached poller — duplicate preps already dedup at the per-slug worktree lock (plan
// 2473) + the battery-lock — while a false "live" costs the whole keep-hot guarantee. So an
// unreadable, undated, or merely OLD advertisement all read as free.
export function watcherIsLive(
  path,
  {
    _read = readFileSync,
    _pidAlive = pidAlive,
    _now = () => Date.now(),
    maxAgeMs = WATCHER_PIDFILE_MAX_AGE_MS,
  } = {},
) {
  let entry = null;
  try {
    entry = parseWatcherPidfile(_read(path, 'utf8'));
  } catch {
    return false;
  }
  if (!entry) return false;
  if (!entry.keepHot) return false; // pure-poll, or a pre-2839 advertisement ⇒ cannot prove coverage
  if (_pidAlive(entry.pid) === false) return false;
  const stampedMs = Date.parse(entry.iso || '');
  if (Number.isNaN(stampedMs)) return false; // undated (legacy bare-pid) ⇒ cannot prove fresh
  // The window is BOUNDED AT BOTH ENDS (gpt-review 714d86, 2026-08-05). A ceiling alone lets a
  // FUTURE-dated stamp through: `_now() - stampedMs` goes negative, which is trivially `<= max`,
  // so a host clock that jumped forward before a watcher died leaves a dead watcher's
  // advertisement suppressing the auto-spawn until real time catches up — the same
  // guarantee-losing failure the ceiling exists to bound, entered from the other side. A stamp
  // from the future is not evidence of a live watcher, so it reads as free. Skew cuts the safe
  // way too: a few seconds of NTP correction against a HEALTHY watcher costs one redundant
  // detached poller, the documented price of every false "free" here.
  //
  // SAME POLICY AS `pass-cache-kernel.mjs`'s `isLive` (a future stamp ⇒ NOT live), reached
  // independently there and re-pinned by two reviews (plans 1824, 2462) for the same reason: a
  // clock-skewed future timestamp would otherwise read as permanently fresh. Deliberately NOT
  // imported from it — that module's header declares its scope as the two content-addressed
  // pass-caches, and this probe is a pid+mode+age judgment with its own fail direction, not a
  // cache entry. The cross-reference is here so a change to either policy sees the other
  // (gpt-review 68d37d).
  const ageMs = _now() - stampedMs;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

// Stamp (or re-stamp) the advertisement. Called once at launch and again on every poll — the age
// gate in `watcherIsLive` is only meaningful if a LIVE watcher keeps its stamp fresh. A local
// file write, no git, no lock: cheap enough to do per poll.
// atomicWriteJsonSync (temp + rename), not a plain write: the spine reads this file from ANOTHER
// process while the watcher rewrites it every poll, so a write torn by a kill / AV scan / disk
// hiccup could be read mid-flush. Fail-toward-free bounds the damage to a spurious duplicate
// watcher rather than corruption — but the repo already has the primitive that removes the hazard
// outright, and every other rival-read JSON file in scripts/ uses it (review 2026-07-28).
//
// plan 2839: `keepHot` is REQUIRED, and omitting it THROWS rather than defaulting. That is a
// deliberate exception to this function's best-effort-never-throws contract, and the exception is
// narrow: a missing mode is a programmer error at the call site (deterministic, caught by the
// tests), while every IO failure still returns false as before. The default it replaces is the bug
// that shipped and was reverted — the per-poll re-stamp called `stampPidfile(path)` with no
// options, so a defaulted `false` rewrote a CORRECT record on the very first poll and inverted the
// spine's dedup into an amplifier (one duplicate watcher spawned per poll).
//
// A `keepHot: false` call WRITES NOTHING and returns false. The path is per-slug and
// last-writer-wins, so a watcher with nothing to advertise must not touch it: a stamp from a
// pure-poll watcher would not merely misdescribe itself, it would OVERWRITE a live keep-hot
// watcher's record on the same slug. Writing nothing is the only safe answer.
export function stampPidfile(
  path,
  { keepHot, _write = atomicWriteJsonSync, _nowIso = () => new Date().toISOString() } = {},
) {
  if (typeof keepHot !== 'boolean') {
    throw new TypeError(
      'stampPidfile: { keepHot } is REQUIRED — every write must re-declare the mode (plan 2839)',
    );
  }
  if (!keepHot) return false; // nothing to advertise ⇒ never touch a shared last-writer-wins path
  try {
    _write(path, { pid: process.pid, iso: _nowIso(), keepHot: true });
    return true;
  } catch {
    return false; // best-effort: a watcher that cannot advertise must still watch
  }
}

// Register this watcher's exit cleanup, and — only if it has something to advertise — claim the
// per-slug pidfile. Returns a RE-STAMP closure (call it on every poll to keep the age gate fresh)
// or null when this watcher does not advertise.
//
// TWO CONCERNS, DELIBERATELY UNFUSED (plan 2839). Through plan 2838 this function did both jobs
// and returned early when either half failed, which made them impossible to separate:
//
//   - The exit/SIGINT/SIGTERM handlers are registered UNCONDITIONALLY and FIRST, before any early
//     return — including the `pidfilePathFor` null return (a `resolveMain` failure). Two reasons.
//     (a) The SIGINT/SIGTERM handlers are what make Ctrl+C and SIGTERM EXIT at all: plan 2738's
//     prep-kill listener is PREPENDED on the assumption that a handler ending in `process.exit`
//     already exists behind it, so a watcher that skipped registration was left with a signal
//     listener that never exits. (b) They must not be collateral damage of "this watcher does not
//     advertise" — that was the first attempted fix, and it broke Ctrl+C for every pure-poll
//     watcher.
//   - Advertising is then decided SEPARATELY. `release` is pid-guarded, so registering it for a
//     watcher that never writes is harmless (it can only ever unlink a file that names our own pid).
//
// The mode is captured ONCE here and re-declared by the closure on every write, so no call site
// can omit it — the reverted fix's per-poll `stampPidfile(pidfile)` is now unrepresentable.
export function claimPidfile(
  slug,
  {
    keepHot,
    _pathFor = pidfilePathFor,
    _on = (ev, fn) => process.on(ev, fn),
    _mkdir = (d) => mkdirSync(d, { recursive: true }),
    _stamp = stampPidfile,
    _readPid = readWatcherPid,
    _rm = (p) => rmSync(p, { force: true }),
    _exit = (c) => process.exit(c),
  } = {},
) {
  if (typeof keepHot !== 'boolean') {
    throw new TypeError('claimPidfile: { keepHot } is REQUIRED (plan 2839)');
  }
  const path = _pathFor(slug);

  // Drop the advertisement on EVERY exit path — clean return, timeout, throw, or signal. Only
  // remove a file that still names US: a watcher relaunched for the same slug may legitimately
  // have taken it over, and unlinking the live one's advertisement would re-enable duplicate
  // spawns. That same pid guard is why this is safe to register for a non-advertising watcher.
  const release = () => {
    try {
      if (path && _readPid(path) === process.pid) _rm(path);
    } catch {
      /* best-effort */
    }
  };
  _on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    _on(sig, () => {
      release();
      _exit(sig === 'SIGINT' ? 130 : 143);
    });
  }

  if (!keepHot) return null; // pure poll: nothing to advertise, so write nothing
  if (!path) return null; // MAIN unresolvable → the spine just spawns its own watcher
  try {
    _mkdir(dirname(path));
  } catch {
    return null;
  }
  if (!_stamp(path, { keepHot: true })) return null;
  return () => _stamp(path, { keepHot: true });
}

function emitFinal(opts, kind, code, message, st) {
  if (opts.json) {
    console.log(
      JSON.stringify({
        slug: opts.slug,
        kind,
        position: st ? st.position : null,
        total: st ? st.total : null,
        code,
      }),
    );
  } else {
    console.log(`${kind.toUpperCase()} ${opts.slug} — ${message}`);
  }
}

export async function main(argv) {
  let opts;
  try {
    opts = parseWatchArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 5;
  }
  const { slug, intervalSec, timeoutSec, heartbeatEverySec, nearIntervalSec, keepHot } = opts;
  console.error(
    `landing-queue-watch: watching ${slug} — interval ${intervalSec}s (${nearIntervalSec}s at ` +
      `position <=${NEAR_POSITION_THRESHOLD}), timeout ${timeoutSec}s` +
      // plan 2085 review [3] + r2 [8]: the banner reports the EFFECTIVE cadences as two
      // clearly-labeled clauses, not the raw flag — a flagless launch still self-arms
      // near head, and a banner claiming heartbeating is off is what sends an operator
      // reaching for the --heartbeat-every "fix".
      `, heartbeat at deep positions: ${heartbeatEverySec > 0 ? `every ${heartbeatEverySec}s` : 'off'}` +
      `, self-armed every ${effectiveHeartbeatSec({ position: NEAR_POSITION_THRESHOLD, heartbeatEverySec })}s ` +
      `at position <=${NEAR_POSITION_THRESHOLD} (plan 2085)` +
      // plan 2551: report the EFFECTIVE mode both ways round. Keep-hot is now the default, so
      // the line an operator most needs to see is the OPT-OUT one — a banner that only ever
      // announced the ON case would leave a --pure-poll watcher looking identical to a normal
      // one in the log, which is exactly the cold-wait failure this plan exists to end.
      (keepHot ? ', keep-hot ON (default)' : ', PURE POLL — keep-hot OFF (--pure-poll)'),
  );

  // plan 2551: advertise this watcher so the spine's plain-path auto-spawn skips a duplicate.
  // Best-effort by construction (see claimPidfile) — a failure here never stops the watch.
  // plan 2839: a --pure-poll watcher advertises NOTHING (it provides no keep-hot coverage, so
  // claiming the slug would suppress the spine's auto-spawn for the whole wait), but its exit and
  // signal handlers are still registered inside this call — which is why it is called in BOTH
  // modes, and still called BEFORE the prep-kill listener that PREPENDS itself in front of them.
  const restampPidfile = claimPidfile(slug, { keepHot });

  const startMs = Date.now();
  // The heartbeat clock (plan 2085 r2 [10]: ONE mutable timestamp, two anchors).
  // cadenceSeedMs (immutable) anchors the FIRST scheduled bump: the launching session
  // just enqueued/heartbeated via done-worktree, so the entry is fresh at t=0 and the
  // flag's "every Ns" contract counts from launch, not from the first poll. lastWriteMs
  // records when THIS watcher last ACTUALLY wrote (null = never) — the only value any
  // write site updates. The head-exit refresh gates on lastWriteMs alone, never the
  // seed (a mid-wait relaunch breaks the seed's freshness assumption).
  const cadenceSeedMs = Date.now();
  let lastWriteMs = null;
  // plan 3422 D3: the position the PREVIOUS poll observed, so shouldHeartbeatNow can arm on the
  // transition into near-head. Infinity (not null) before the first poll — isNearHead(null) is
  // false too, but Infinity says "definitely not near head yet" without leaning on that, so a
  // watcher launched while ALREADY near head arms on poll 1 instead of waiting a cadence window.
  let prevHeartbeatPosition = Infinity;
  // plan 3422 D5: the head slug this watcher has already alarmed about. One alarm per head — the
  // board write touches ANOTHER session's row, so re-writing it every poll would be both noise and
  // needless coordWrite contention. Resets when the head changes (a new head is a new question).
  let deadLandAlarmedHead = null;
  let consecutiveErrors = 0;
  let lastPreppedTip = null; // plan 972: the origin/master tip the last keep-hot --prep rebased onto
  let lastProbedTip = null; // plan 2274 Fix 1: the origin/master tip the last STALE-WHILE-QUEUED probe checked
  // plan 1682: local same-head observation clock gating demote attempts (see header)
  let observedHead = null;
  let headSinceMs = Date.now();
  let nextDemoteMs = 0;
  // plan 2266: the steal-sentinel's OWN clock (never shared with the demote sentinel's —
  // see stealSentinelStep's header)
  let observedStealHead = null;
  let stealHeadSinceMs = Date.now();
  let nextStealMs = 0;
  // plan 2275: the overtake throttle — a plain next-attempt timestamp (no observation
  // clock; see OVERTAKE_RETRY_MS's header)
  let nextOvertakeMs = 0;
  // plan 2331: the reap-sentinel's OWN clock (never shared with demote's or steal's —
  // see reapSentinelStep's header)
  let observedReapHead = null;
  let reapHeadSinceMs = Date.now();
  let nextReapMs = 0;
  // plan 2738: the in-flight keep-hot prep (null = none), and the running count of CONSECUTIVE
  // infrastructure-class prep exits that drives the stall escalation.
  let prep = null;
  let consecutivePrepInfra = 0;
  // Set when a failed prep should be retried, APPLIED at the end of the poll (see the reap block).
  let retryPrepAfterPoll = false;
  // Which poll this is (0-based) — only read by the LQW_FAKE_STATUS_JSON poll script.
  let pollIndex = 0;

  // plan 2738: never leave a prep child rewriting a worktree after this watcher is gone.
  // spawnWithTreeKill already wires the tree-KILL to a normal 'exit', so the child always dies;
  // this adds the rebase-state CLEANUP on the signal paths. PREPENDED because claimPidfile's own
  // SIGINT/SIGTERM handlers (registered above, therefore first) end in `process.exit` — a plainly
  // appended listener would never run.
  // A signal handler cannot await, and claimPidfile's own handlers (registered above, therefore
  // first) end in `process.exit` — so this deliberately does the SYNCHRONOUS tree kill directly
  // rather than firing abortPrep and abandoning its promise mid-flight (review round 2: starting
  // async cleanup you cannot finish reads as cleanup that happened). The kill is the half that
  // matters here; the grace-wait and rebase cleanup exist to hand a usable worktree to a land that
  // is about to run, and on a signal path nothing is about to run. PREPENDED so it beats the
  // pidfile handler's exit.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.prependListener(sig, () => {
      if (prep && !prep.exited && prep.child && !prep.aborted) {
        prep.aborted = true;
        try {
          killProcessTree(prep.child);
        } catch {
          /* best-effort — never mask the signal exit */
        }
      }
    });
  }

  for (;;) {
    // plan 2551: re-stamp the advertisement every poll. `watcherIsLive`'s age gate is what stops a
    // crashed watcher's orphaned pidfile (whose pid the OS later reassigns) from suppressing the
    // spine's auto-spawn forever — and that gate only works if a LIVE watcher keeps its stamp fresh.
    // plan 2839: the closure carries the mode, so this re-stamp cannot silently drop it (null here
    // means this watcher never advertised — a pure poll, or a pidfile it could not claim).
    if (restampPidfile) restampPidfile();
    // plan 2738: reap a prep that finished since the last poll and say what its exit MEANS — the
    // benign "re-surfaces at head" line only for the classes where that is true, and an escalating
    // "keep-hot did not run" line for the infrastructure ones (see prepExitReport).
    if (prep && prep.exited) {
      // plan 2816: a BUSY whose holder is a LIVE same-slug sibling prep is the DESIGNED post-2551
      // steady state, not a fault — classify it before the 2738 alarm sees it. The holder was read
      // at the moment of the exit (beginPrep), not here, so this stays a pure decision.
      const report = prepExitReport({
        code: prep.code,
        slug,
        consecutiveInfra: consecutivePrepInfra,
        standDown: keepHotBusyStandDown({
          code: prep.code,
          slug,
          holder: prep.busyHolder,
          nowMs: Date.now(),
        }),
      });
      consecutivePrepInfra = report.consecutiveInfra;
      if (report.message) console.error(`landing-queue-watch: ${report.message}`);
      // Re-arm the tip so a LATER poll retries — without this an infra failure consumes that tip's
      // only attempt (see prepExitReport's header). Deferred to the end of this poll rather than
      // applied here (review round 2): clearing it now lets THIS poll's keep-hot block fire again
      // immediately, so three attempts land back-to-back with no gap, burn the escalation budget in
      // one go, and never actually ride out the transient contention the retry exists for.
      retryPrepAfterPoll = report.retry;
      prep = null;
    }
    let st = null;
    try {
      st = readStatus(slug, pollIndex);
      consecutiveErrors = 0;
    } catch (e) {
      if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        // plan 2738: awaited — the abort waits for the prep tree to die before cleaning up.
        if (prep) await abortPrep(prep, slug, 'watcher bailing on repeated status failures');
        emitFinal(opts, 'error', 5, `status read failed ${consecutiveErrors}x: ${e.message}`, null);
        return 5;
      }
      console.error(
        `landing-queue-watch: status read failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}) — ${e.message}`,
      );
    }

    if (st) {
      const v = watchVerdict(st);
      // plan 2738: the wait is over (or the prep hit its ceiling) — kill the prep BEFORE the
      // head-exit heartbeat and the exit that wakes the session. Ordered first so nothing on the
      // wake path waits behind a prep that has just become worthless.
      const abort = prepAbortReason({
        running: Boolean(prep) && !prep.exited,
        kind: v.kind,
        startedMs: prep ? prep.startedMs : 0,
        nowMs: Date.now(),
      });
      if (abort) {
        await abortPrep(prep, slug, abort);
        prep = null;
      }
      if (v.done) {
        // plan 2085: refresh the queue heartbeat once before exiting at HEAD — the woken
        // session's done-worktree spends ~26 s in pre-queue preflight before its own
        // queue step stamps, and a stale entry in exactly that window is what the
        // plan-1682 demote sentinels punish (the livelock this plan closes). Best-effort;
        // 'gone' has no entry left to refresh. Skipped when the entry was bumped within
        // the last minute (review [5]: a self-arm write one 30 s poll earlier already
        // leaves ~14 min of demote headroom — no second coordWrite for zero freshness).
        if (v.kind === 'head') {
          // Gate on a write THIS watcher actually made (never the start-time seed — after
          // a mid-wait relaunch the seed is an assumption, and skipping on it could leave
          // a genuinely stale entry unrefreshed at head).
          const ageMs = lastWriteMs == null ? Infinity : Date.now() - lastWriteMs;
          if (ageMs >= HEAD_EXIT_REFRESH_MIN_AGE_MS) {
            console.error(
              'landing-queue-watch: head reached — refreshing queue heartbeat before exit (plan 2085)',
            );
            try {
              heartbeat(slug);
            } catch (e) {
              console.error(
                `landing-queue-watch: head heartbeat failed (non-fatal) — ${e.message}`,
              );
            }
          } else {
            console.error(
              `landing-queue-watch: head reached — own heartbeat write is ${Math.round(ageMs / 1000)}s ` +
                'fresh, skipping the pre-exit refresh (plan 2085)',
            );
          }
        }
        emitFinal(opts, v.kind, v.code, v.message, st);
        return v.code;
      }
      console.error(`landing-queue-watch: ${slug} ${v.message}`);
      // plan 1682: waiter-side auto-demote of a stale, not-landing head (see header).
      // The decision is the pure demoteSentinelStep above (review 1682 [5] — testable
      // clock bookkeeping); only the tryDemote IO stays here.
      const sen = demoteSentinelStep({
        head: st.head,
        kind: v.kind,
        nowMs: Date.now(),
        observedHead,
        headSinceMs,
        nextDemoteMs,
      });
      ({ observedHead, headSinceMs, nextDemoteMs } = sen);
      if (sen.attempt && tryDemote(slug)) {
        console.error(
          `landing-queue-watch: demoted stale not-landing head ${st.head} to the tail (plan 1682) — re-polling`,
        );
        continue;
      }
      // plan 2266: after a failed/absent demote, attempt a MECHANICAL steal — same throttle
      // cadence as the demote sentinel above, its own clock (see stealSentinelStep). The CLI
      // only takes the head when the recorded {host, pid} proves the holder verifiably gone;
      // anything else is a harmless refusal (no --confirm-holder-gone passed — this watcher
      // never asserts a human check).
      const senSteal = stealSentinelStep({
        head: st.head,
        kind: v.kind,
        nowMs: Date.now(),
        observedHead: observedStealHead,
        headSinceMs: stealHeadSinceMs,
        nextStealMs,
      });
      ({ observedHead: observedStealHead, headSinceMs: stealHeadSinceMs, nextStealMs } = senSteal);
      // plan 2280: st already carries headHost/headPid from this poll's own status read
      // (readStatus is slug-scoped) — skip the steal spawn (and its own fetch) when a
      // cross-host or pid-less head means it would only be refused anyway.
      if (
        senSteal.attempt &&
        stealLocallyEligible({
          headHost: st.headHost,
          headPid: st.headPid,
          probingHost: hostname(),
        }) &&
        tryMechanicalSteal(slug)
      ) {
        console.error(
          `landing-queue-watch: dead head ${st.head} mechanically reaped (plan 2266) — re-polling`,
        );
        continue;
      }
      // plan 2275: after demote/steal, attempt an OVERTAKE of a head parked at
      // LAND_BLOCKED_HOLDING. The decision is the pure overtakeSentinelStep above
      // (locally gated on this poll's own slug-scoped payload — own lane 🟩 AND
      // headState HOLDING — so a waiter that can never win never pays the spawn);
      // only the tryOvertake IO stays here.
      const senOvertake = overtakeSentinelStep({
        kind: v.kind,
        nowMs: Date.now(),
        nextOvertakeMs,
        lane: st.lane,
        headState: st.headState,
      });
      nextOvertakeMs = senOvertake.nextOvertakeMs;
      if (senOvertake.attempt && tryOvertake(slug)) {
        console.error(
          `landing-queue-watch: overtook parked LAND_BLOCKED_HOLDING head ${st.head} (plan 2275) — re-polling`,
        );
        continue;
      }
      // plan 2331 (sonnet-review fix): after demote/steal/overtake, attempt a REAP of a
      // dead, NOT-landing head — this watcher (not done-worktree.mjs's in-process --wait
      // loop, which the file header already documents as dormant in the real flow) is the
      // LIVE head-detection path a normal (self-managed) wait actually uses, so reap must
      // be wired here too or it structurally never fires for the predominant flow it
      // exists to fix (the 2306 incident). The decision is the pure reapSentinelStep above
      // (own observation clock, mirroring demote/steal); the local `st.headState !==
      // HOLDING_STATE && st.headState !== IN_LAND_STATE` check (already-available payload
      // data, no extra fetch) skips the spawn for a parked/actively-landing head the CLI
      // would only refuse anyway — mirroring overtake's own local lane/headState pre-check
      // above, and demote/steal's cross-verb dedupe lesson (review 1682 [3]) applied to a
      // THIRD independent gate this time. plan 2414 review fix: IN_LAND (the free-lane
      // liveness token) added alongside HOLDING — reapVerdict itself now refuses an
      // IN_LAND head unconditionally (landing-queue-lib.mjs), and this pre-check must
      // agree or every poll behind an actively-landing free-lane head pays a wasted
      // git-fetch-plus-spawn the CLI refuses every single time.
      const senReap = reapSentinelStep({
        head: st.head,
        kind: v.kind,
        nowMs: Date.now(),
        observedHead: observedReapHead,
        headSinceMs: reapHeadSinceMs,
        nextReapMs,
      });
      ({ observedHead: observedReapHead, headSinceMs: reapHeadSinceMs, nextReapMs } = senReap);
      if (
        senReap.attempt &&
        st.headState !== HOLDING_STATE &&
        st.headState !== IN_LAND_STATE &&
        tryReap(slug)
      ) {
        console.error(
          `landing-queue-watch: dead not-landing head ${st.head} auto-reaped (plan 2331) — re-polling`,
        );
        continue;
      }
      // plan 2085: effectiveHeartbeatSec self-arms heartbeating at position <=
      // NEAR_POSITION_THRESHOLD even when --heartbeat-every was not passed, so a
      // long-waiting entry approaches head demote-fresh (the flagless canonical wait
      // used to arrive > DEFAULT_DEMOTE_STALE_MIN stale and get demoted mid-preflight).
      // plan 3422 D5: DEAD-LAND WATCHDOG. Runs on the WAITING path only — a watcher that has
      // reached the head has already exited above, so the head being judged here is always some
      // other session's land, which is exactly the case nobody was watching (plan 2347's overnight
      // death went ~9h unnoticed). Alarms, never displaces: demote/steal/reap own displacement on
      // their own clocks, and none of them tells a human.
      // The latch is keyed on the RESIDENCY, not the slug alone (gpt-review 7e56ce / ed4ca8 /
      // f8c54d, CONFIRMED across three angles): a slug that lands, dies, gets demoted, and later
      // returns to the head is a NEW question, and a slug-only latch would stay armed forever and
      // never alarm the second death. The head's heartbeat stamp identifies the residency — it is
      // re-stamped on every enqueue/requeue (`requeueEntry` refreshes `heartbeatIso`), so a
      // returning slug carries a different one. The re-arm is also checked UNCONDITIONALLY: the
      // earlier cut only reached the reset inside a `st.head !== alarmed` guard, so the alarmed
      // head could never clear its own latch.
      // The key is slug + pid + heartbeat TOGETHER, because no single component identifies a
      // residency and the review found each one-component version in turn: a heartbeat stamp is
      // mutable and two requeues can share a millisecond (98b46d / 64c2b5), and an OS pid is
      // reused, so a later residency could inherit an already-alarmed key and stay silent (0c6bcd
      // / 38e3b6 / 12f817 / aa82c6 / 9fa0d4). Together they are stable exactly where it matters: a
      // DEAD land stamps neither again, so the key is frozen for as long as the alarm should stay
      // latched, while a returning residency differs in at least one component.
      const deadLandKey = st.head
        ? `${st.head}@${st.headPid ?? ''}@${st.headHeartbeatIso ?? ''}`
        : null;
      if (!st.head || st.headState !== IN_LAND_STATE) {
        deadLandAlarmedHead = null; // nothing landing at the head — re-arm for whoever lands next
      } else if (deadLandKey !== deadLandAlarmedHead) {
        // `resolveMain` THROWS on an unresolvable checkout, and an uncaught throw here would kill
        // the whole watcher over a diagnostic read (gpt-review df6e75). The watchdog is strictly
        // advisory — it must never be able to end a wait it is only observing.
        let sidecar = null;
        try {
          sidecar = readLandResultSidecar(resolveMain({ assertMaster: false }), st.head).sidecar;
        } catch {
          /* no readable MAIN — the verdict simply judges on the pid, its load-bearing signal */
        }
        const dead = deadLandVerdict({
          headSlug: st.head,
          headState: st.headState,
          headHost: st.headHost,
          thisHost: hostname(),
          headHeartbeatIso: st.headHeartbeatIso,
          holderPidAlive: headHolderPidAlive(st),
          sidecar,
          nowMs: Date.now(),
        });
        if (dead.alarm) {
          raiseDeadLandAlarm(st.head, dead);
          deadLandAlarmedHead = deadLandKey;
        }
      }
      // plan 3422 D3: heartbeating is now armed at EVERY position (DEFAULT_HEARTBEAT_SEC is the
      // self-arm cadence, not 0), and shouldHeartbeatNow additionally forces a write on the poll
      // that first observes near-head — see its header for why the cadence clock alone leaves a
      // full far-interval gap exactly at the transition that matters.
      const hbSec = effectiveHeartbeatSec({ position: st.position, heartbeatEverySec });
      const hbDecision = shouldHeartbeatNow({
        position: st.position,
        prevPosition: prevHeartbeatPosition,
        hbSec,
        lastWriteMs,
        cadenceSeedMs,
        nowMs: Date.now(),
      });
      prevHeartbeatPosition = st.position;
      if (hbDecision.write) {
        try {
          heartbeat(slug);
          lastWriteMs = Date.now();
          if (hbDecision.reason === 'near-head-transition') {
            console.error(
              `landing-queue-watch: reached position ${st.position} — heartbeat armed on the ` +
                'near-head transition (plan 3422 D3)',
            );
          }
        } catch (e) {
          console.error(`landing-queue-watch: heartbeat failed (non-fatal) — ${e.message}`);
        }
      }
      // plan 2274 review fix: ONE originTip() per poll, shared by the stale-probe and keep-hot
      // blocks below (each independently called it — a needless second `git rev-parse
      // origin/master` subprocess every poll, doubling the shared-.git touch this file's own
      // interval tuning exists to limit across 5-7 parallel waiters).
      const pollTip = originTip();
      // plan 2274 Fix 1: STALE-WHILE-QUEUED freshness probe — ALWAYS ON (no flag), because the
      // plan-2233 post-mortem's gap was a branch going conflicted across the WHOLE deep-queue
      // wait, discovered only at head. Non-mutating (git merge-tree --write-tree only writes a
      // tree object) — this never touches the worktree, unlike keep-hot's real rebase below.
      // Only re-probes when origin/master ADVANCED since the last check (lastProbedTip).
      {
        if (staleWhileQueuedShouldProbe({ kind: v.kind, tip: pollTip, lastProbedTip })) {
          const probe = staleWhileQueuedProbe(pollTip);
          // plan 2274 review fix: advance lastProbedTip ONLY on a DEFINITIVE result (clean or
          // conflicted) — a transient probe failure (null, e.g. merge-tree lock contention from
          // a sibling session in this shared-.git) must be retried on the NEXT poll, not marked
          // "already checked" for the rest of a deep queue wait (mirrors done-worktree.mjs's
          // preconvergeProbe, which caches the same way).
          if (probe) {
            lastProbedTip = pollTip;
            if (probe.conflicted) {
              const culprits = staleWhileQueuedCulprits(probe.files);
              console.error(
                `landing-queue-watch: ${formatStaleWhileQueued(slug, probe.files, culprits)}`,
              );
            }
          }
        }
      }
      // plan 972 keep-hot: rebase the queued branch + re-validate gates + stamp the land-prep
      // marker each time origin/master advances WHILE WAITING, so the head-of-queue land fast-
      // paths past the rebase/gate window. ON BY DEFAULT since plan 2551 — this branch runs for
      // every queued waiter unless `--pure-poll` opted out (it was the opt-in `--keep-hot` flag
      // through plan 972; do not reason about this path as a rare one).
      //
      // plan 2738: STARTS the prep and moves on — the loop keeps polling, heartbeating and running
      // its recovery sentinels for the prep's whole runtime (it used to block here for ~15-27 min,
      // un-woken and un-heartbeated). The outcome is reaped and CLASSIFIED at the top of a later
      // poll (prepExitReport), not swallowed into one benign line. lastPreppedTip advances at START
      // so a prep that is still running never re-fires against the tip it is already rebasing onto.
      if (keepHot) {
        const tip = pollTip;
        if (
          keepHotShouldPrep({
            enabled: true,
            kind: v.kind,
            tip,
            lastPreppedTip,
            prepRunning: Boolean(prep) && !prep.exited,
          })
        ) {
          console.error(
            `landing-queue-watch: keep-hot — origin/master at ${tip.slice(0, 9)}, running ` +
              `done-worktree --prep for ${slug} (supervised; polling continues)`,
          );
          prep = beginPrep(slug, tip);
          lastPreppedTip = tip;
        }
      }
    }

    if (Date.now() - startMs >= timeoutSec * 1000) {
      // plan 2738: the watcher is leaving — take the prep with it, cleanly. spawnWithTreeKill's
      // exit hook would kill the child anyway, but only abortPrep clears the rebase state a kill
      // mid-rebase leaves for whoever picks this worktree up next.
      if (prep) await abortPrep(prep, slug, 'watcher timed out');
      const where = st ? `position ${st.position}/${st.total}` : 'status unread';
      emitFinal(opts, 'timeout', 4, `still ${where} after ${timeoutSec}s`, st);
      return 4;
    }
    const nextPollSec = selectPollIntervalSec({
      position: st ? st.position : null,
      nearSec: nearIntervalSec,
      farSec: intervalSec,
    });
    // plan 2738: the deferred infra retry (see the reap block) — re-arming the tip HERE, after
    // this poll's keep-hot block has already run, is what puts a full poll interval between two
    // attempts instead of firing them back-to-back.
    if (retryPrepAfterPoll) {
      lastPreppedTip = null;
      retryPrepAfterPoll = false;
    }
    pollIndex++;
    await sleep(nextPollSec * 1000);
  }
}

// plan 4096 T2: this core module carries NO project wiring (Rule 3) — a direct invocation (this
// guard, or a test spawning this file by path) runs with the no-op `deadLandToast` default. The
// path-compat shim at scripts/landing-queue-watch.mjs is where a real checkout's project-layer
// notifier gets wired in via `setDeadLandToast` before it calls this same `main`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error('landing-queue-watch:', e.message);
      process.exit(5);
    },
  );
}
