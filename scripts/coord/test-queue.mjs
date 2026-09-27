#!/usr/bin/env node
// scripts/coord/test-queue.mjs — machine-global test-run slot queue (plan 1750).
//
// THE PROBLEM: every session's `.husky/pre-push` runs the full backend vitest
// suite (via run-land-tests.mjs) whenever backend/ changed. Each run spins a
// vitest worker pool (~1 proc/core). With ~5–7 parallel sessions pushing around
// the same time, dozens of test processes contend for the same cores →
// sustained overload → the 600s bound trips or every file times out. Plan 978's
// isolation-retry TOLERATES the resulting flake after the fact; this queue
// PREVENTS the herd by capping how many heavy test runs execute concurrently,
// machine-wide. The two compose: the queue caps concurrency, 978 heals whatever
// flake still slips through.
//
// CONSUMERS: run-land-tests.mjs (the pre-push / done-worktree gates) and — since
// plan 1785 — queued-run.mjs, the MANUAL wrapper (`pnpm --filter @vetapp/backend
// test:queued`, or `node scripts/queued-run.mjs <cmd…>` for any heavy command,
// pytest whole-dir sweeps included), so hand-launched full-suite debug runs take
// a ticket too instead of becoming the herd beside live gate runs.
//
// WHY os.tmpdir(), not the repo: the contended resource is the MACHINE's CPU
// across all repos (vetapp + siblings share one dev box), so the queue dir is
// machine+user-global — `path.join(os.tmpdir(), 'claude-test-queue')` — shared
// by every session in every repo. Once a sibling adopts this script + the
// run-land-tests.mjs wiring (coord sync), it joins the SAME queue automatically.
//
// TICKET PROTOCOL (multi-holder FIFO semaphore — deliberately NOT excl-lock.mjs,
// which is a single-holder O_EXCL primitive; here N holders coexist by design,
// and unlike landing-lock's repo-scoped single-registry-behind-a-meta-mutex,
// tickets are per-process FILES so no writer ever contends with another):
//   acquire(label) writes `<startedWaiting-ms>-<pid>.json` =
//   { pid, host, label, tier, startedWaiting, heartbeat, startedRunning? }, then
//   polls (~1.5s):
//   refresh own heartbeat (throttled to the ~10s HEARTBEAT_MS cadence — the
//   poll READS every 1.5s for responsiveness but only WRITES every ~10s, so
//   5-7 queued sessions don't hammer the shared tmpdir), prune tickets whose
//   heartbeat is older than STALE_MS (holder crashed — pid reuse is also
//   covered: a reused pid can't refresh a dead session's ticket), order live
//   WAITING tickets by priority tier then FIFO, and if my ticket is among the
//   first N (TEST_QUEUE_CONCURRENCY, default 2) → hold a slot: heartbeat timer (~10s)
//   + signal-wired release() returned to caller. Ticket writes go through the
//   SHARED atomic-write helper (fsync+tmp-then-rename — the plan-1733
//   landing-lock lesson, extracted to atomic-write.mjs in plan 1761) so a
//   concurrent reader never sees a torn write as anything worse than a
//   skippable parse failure and a failed write can't leave a live-looking tmp
//   file. The write shape is ALL this queue shares with landing-lock: the
//   heartbeat/staleness/FIFO core here stays deliberately separate (see the
//   TICKET PROTOCOL note above and landing-lock.mjs's own boundary note —
//   plan 1761 evaluated a shared holder module and declined it).
//
// HOLDER CONTRACT — do not block the event loop while holding a slot. The
// holding process's heartbeat is a setInterval; a caller that sits in
// spawnSync/execSync for minutes starves it, the ticket goes stale, and rival
// waiters legitimately prune a LIVE holder and over-admit past N — silently
// re-creating the herd this queue exists to prevent. run-land-tests.mjs runs
// vitest via ASYNC spawn for exactly this reason (plan 1750 review finding 0).
//
// FAIL-OPEN INVARIANT (the landing-queue lesson: queue machinery must never
// WEDGE every push):
//   - MAX_WAIT_MS (~20 min) ceiling → RELEASE the ticket, then proceed
//     unserialized with a logged warning. The ticket must not stay queued: a
//     failed-open process that kept its FIFO-oldest ticket would later be
//     awarded a slot it no longer needs, starving a genuine waiter behind it.
//   - A transient fs error INSIDE the wait loop (AV/sync-scan EBUSY/EACCES —
//     the class landing-lock's plan-1703 retry exists for) retries on the next
//     poll; a PERSISTENT one (≥10 consecutive failed polls ≈ 15s — queue dir
//     quarantined, permissions revoked, disk full) fails open immediately, as
//     does a failure to even create the queue dir/ticket.
//   - TEST_QUEUE_DISABLE=1 → bypass entirely (emergency hatch).
//   - TEST_QUEUE_DIR=<path> → redirect the queue dir (test isolation that
//     keeps the real acquire path, unlike the bypass).
//   - release() is best-effort and idempotent. Kill paths: SIGINT/SIGTERM and
//     process.exit free the slot via the wired handlers; an uncatchable kill
//     (SIGKILL, Windows Job-Object termination — what run_bounded escalates
//     to) CANNOT run them, by OS design — that ticket is reclaimed by rivals'
//     stale-pruning within ~STALE_MS (90s). Accepted: a bounded 90s slot leak
//     on hard kills, in exchange for zero daemons/helpers.
//
// PRIORITY TIERS (plan 2716) — a ticket carries the acquiring session's
// scheduling class (`session-priority.mjs` resolves it from the session's
// claimed plan's `priority:` frontmatter; callers PASS it in as `opts.tier`, so
// this module stays git-free and its battery stays repo-free). WAITING tickets
// are served highest tier first, FIFO within a tier.
//
//   NEVER PREEMPT. A ticket that has been AWARDED a slot stamps `startedRunning`
//   and is thereafter counted as a holder unconditionally — a `high` arrival can
//   never displace a running `low` job. That stamp is not bookkeeping garnish:
//   without it, a rival's recomputation would rank the arriving `high` above the
//   already-running `low`, admit it, and run N+1 jobs at once — silently
//   re-creating the very herd this queue exists to cap. (The already-running
//   process never re-checks, so "eviction" cannot actually stop it.)
//
//   STARVATION GUARD. A waiting `low` ticket older than TEST_QUEUE_LOW_PROMOTE_MS
//   (default 10 min — it MUST stay under the 20-min MAX_WAIT_MS fail-open
//   ceiling, or no live waiter ever reaches it) is ordered AS `medium`, so a steady drip of medium work
//   cannot hold a background run out forever. Deliberately capped at `medium`
//   and deliberately one-directional: `medium` never ages into `high`. `high` is
//   the operator-in-the-loop tier and is rare by construction, so the residual
//   "medium behind an unbroken stream of highs" case is accepted, not guarded.
//
//   ROLLOUT / MIXED VERSIONS. A ticket written by a pre-2716 process (a stale
//   long-running holder, an unsynced sibling repo) has no `tier` (→ `medium`,
//   the ruled default) and no `startedRunning` (→ ranked as a waiter). Since it
//   is also the OLDEST waiter, plain FIFO still awards it its slot — the only
//   divergence is a `high` arrival jumping ahead of it, which can over-admit by
//   one until that legacy run finishes. Bounded, transient, and only while two
//   versions coexist.
//
// PURE CORE: computeHolders(tickets, now, concurrency, staleMs) → Set<pid> is a
// pure function so tier+FIFO ordering, the never-preempt rule, the concurrency-N
// cut, and stale pruning are unit-tested (test-queue.test.mjs, the node --test
// battery) without spawning.

import { mkdirSync, readdirSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname, freemem as osFreemem } from 'node:os';
import { atomicWriteJsonSync } from './atomic-write.mjs';
import { cpuCapPercent } from './win-cpu-cap.mjs';
import {
  PRIORITY_DEFAULT,
  PRIORITY_SORT_WEIGHT,
  normalizePriorityTier,
} from './build-index-lib.mjs';
// The memory axis (plan 3954 T3) lives in its own module — see that module's header for why it
// is not inlined here (the scripts/**-module-layout import-boundary rule, and a genuinely new
// module gets its own name-paired test file instead of growing this one's).
import { loadPytestMemoryBudget, memoryWorkerBudget } from './pytest-memory-budget.mjs';

// TEST_QUEUE_DIR redirects the queue to a scratch dir — for tests that must
// exercise the REAL acquire path (signal wiring, ticket lifecycle) without
// contending on the machine-global queue. TEST_QUEUE_DISABLE=1 can't serve
// those: it bypasses acquire entirely, wiring nothing (plan 1813).
export const DEFAULT_QUEUE_DIR = process.env.TEST_QUEUE_DIR || join(tmpdir(), 'claude-test-queue');
export const DEFAULT_CONCURRENCY = 2; // operator pick, plan 1750
export const POLL_MS = 1500;
export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 90_000;
export const MAX_WAIT_MS = 20 * 60_000;
// Starvation guard (plan 2716). MUST stay BELOW MAX_WAIT_MS: a ticket that reaches the 20-minute
// fail-open ceiling RELEASES and proceeds unserialized, so a promotion window at or past that
// ceiling can never be reached by a live waiter — the guard would be dead code that still reads
// as a working one. The plan's sketch said "default 30 min" without noticing the interaction;
// 10 min preserves the intent (a low ticket held out for a long stretch stops being low) with
// room for the promoted ticket to actually be SERVED before the ceiling. The invariant is pinned
// in test-queue.test.mjs — change one constant and that test tells you about the other.
export const LOW_PROMOTE_MS = 10 * 60_000;

// ── plan 4003 T1: the slot-admission marker ──────────────────────────────────
//
// A heavy gate spawned through `queued-run.mjs` spends two completely different kinds of time in
// one child process: WAITING for one of this module's slots, then RUNNING the wrapped command.
// `done-worktree.mjs`'s runViaTestQueue used to arm its kill timer around BOTH, so a battery that
// waited 15 minutes for a slot was tree-killed 15 minutes into its own run — five such kills on
// 2026-09-13 cost 267 minutes with no failing test in any of them.
//
// The marker is how the child tells its parent "the wait is over, my run starts NOW" so the parent
// can arm the run's cap against the RUN. It is a fixed, deliberately unmistakable token rather
// than prose: `acquire`'s own human-readable "slot acquired … after Ns in queue" line is (a) only
// printed when the run actually announced a wait first, and (b) narration that may legitimately be
// reworded — neither is a wire contract. This is.
//
// Defined HERE, beside the queue constants, and imported by both ends (the writer,
// `queued-run.mjs`; the reader, `done-worktree.mjs`'s runViaTestQueue) so the token has exactly
// ONE spelling — a second hand-typed copy on either side is a silent protocol break that degrades
// to today's whole-invocation cap with nothing saying so.
//
// It travels on the WRAPPER's STDERR: `queued-run.mjs`'s stdout is the wrapped command's own, byte
// for byte, and at least one consumer parses it as data. The reader pipes both streams into one
// capture, so the choice of stream is the writer's to make safely.
export const TEST_SLOT_ADMITTED_MARKER = '##TEST-QUEUE-SLOT-ADMITTED##';

// The pre-admission backstop: how long a parent may wait for that marker before treating the child
// as wedged. Derived from THIS module's own fail-open ceiling rather than invented, because that
// ceiling is what actually bounds a slot wait — `acquire` bails and proceeds UNSERIALIZED once a
// ticket has waited `maxWaitMs`, so a marker that has not arrived by then is not "a long queue",
// it is a child that is not running the code this contract assumes. The grace covers everything
// `queued-run.mjs` does before it reaches `withTestSlot` (process start, the scheduling-class read
// and its git subprocesses) plus the running-marker stamp retries after the award.
export const SLOT_ADMISSION_GRACE_MS = 120_000;

export function slotAdmissionBackstopMs(env = process.env) {
  return envInt('TEST_QUEUE_MAX_WAIT_MS', MAX_WAIT_MS, env) + SLOT_ADMISSION_GRACE_MS;
}

// makeAdmissionScanner — plan 4003 T1 (originally inlined in done-worktree.mjs's runViaTestQueue;
// extracted here in plan 4006 so a SECOND call site — nightly-windows-suite.mjs's
// spawnQueuedCommand — reuses the exact same scan rather than hand-typing a second copy beside the
// marker it recognizes). Returns a scanner function that carries at most one marker's worth of
// trailing bytes between calls (O(1) memory, independent of how much output the run produces) and
// returns `true` the first time `marker` is seen in the accumulated stream, `false` otherwise —
// once it has fired, every subsequent call returns `false` again (a `fired` latch, set alongside
// clearing the buffer on match — plan 4006 review round 1, findings 92c7b3/3cc5b6: clearing the
// buffer alone does not stop a WHOLLY NEW later chunk that also contains the marker from firing a
// second time), which is exactly right for a caller that stops caring the moment admission is
// first recorded.
//
// ONE SCANNER PER STREAM (gpt-review r1, plan 4003, finding 6e5e23): a caller piping BOTH stdout
// and stderr into one shared scanner can have the marker's bytes split across an interleaved chunk
// from the OTHER stream, so it is never recognized — the run then stays bound by the pre-admission
// backstop instead of its own cap, silently reintroducing the exact false-kill this mechanism
// exists to remove. Construct one scanner per stream (`makeAdmissionScanner()` twice) and treat
// either one firing as proof of admission; the two cannot interleave with each other.
export function makeAdmissionScanner(marker = TEST_SLOT_ADMITTED_MARKER) {
  let buf = '';
  // plan 4006 review round 1 (findings 92c7b3/3cc5b6): a LATCH, distinct from clearing `buf` on a
  // match. Clearing `buf` alone only stops a match that spans the match chunk and a later one from
  // being seen twice — it does nothing to stop a WHOLLY NEW later chunk that also happens to
  // contain the marker text from firing again, which is exactly the header's own "every subsequent
  // call returns false" promise. Both current callers (runViaTestQueue, spawnQueuedCommand) happen
  // to guard this externally with their own `admittedAtMs !== null` check, so nothing was broken in
  // practice — but this is a newly SHARED helper and the doc/behaviour mismatch is precisely the
  // drift the extraction exists to prevent.
  let fired = false;
  return (chunk) => {
    if (fired) return false;
    buf += chunk;
    if (buf.includes(marker)) {
      fired = true;
      buf = '';
      return true;
    }
    // Carry at most one marker's worth of trailing bytes, so a marker split across two chunks of
    // THIS stream is still seen while the scan stays O(1) in memory.
    if (buf.length > marker.length) {
      buf = buf.slice(-marker.length);
    }
    return false;
  };
}

// isLiveTicket — THE staleness boundary, defined exactly once. computeHolders
// (who may hold) and pruneStale (whose file gets deleted) must agree at the
// boundary or a pruner could delete a ticket the assignment still counts (or
// vice versa) — so both call this, never a re-rolled comparison.
export function isLiveTicket(t, now, staleMs) {
  return Boolean(t) && Number.isFinite(t.heartbeat) && now - t.heartbeat <= staleMs;
}

// isRunningTicket — THE "already awarded a slot" boundary, defined exactly once, for the same
// reason isLiveTicket is: the never-preempt rule is only sound if every process agrees on which
// tickets are running. A ticket stamps `startedRunning` the moment acquire() breaks out of its
// wait loop; anything without a finite stamp is still a waiter.
export function isRunningTicket(t) {
  return Boolean(t) && Number.isFinite(t.startedRunning);
}

// effectiveTier — a WAITING ticket's ordering tier, after the starvation guard. An unknown or
// absent tier reads as the ruled default (`medium`) exactly as an unstamped plan does; the tier
// vocabulary and its sort weights come from build-index-lib.mjs (plan 2520's canonical
// {high, medium, low}), never re-inlined here.
// Delegates to build-index-lib's normalizePriorityTier — the SAME read-time normalization every
// other priority consumer uses — rather than probing PRIORITY_SORT_WEIGHT for undefined. That
// probe was both a re-implementation and prototype-unsafe: a ticket whose `tier` read
// `"constructor"` or `"toString"` hit an INHERITED Object.prototype member, so the lookup was not
// undefined, the value sailed through as a legal tier, and the sort weight later resolved to a
// function — making every comparison against it NaN and the ordering arbitrary. A ticket is a
// file on a machine-global tmpdir that any process can write, so "no writer emits that today" is
// not a guarantee. Silent (`warn: () => {}`): an odd ticket must not spray a warning on every
// poll of every rival process — the write-time gate is where a bad tier gets reported.
export function normalizeTier(raw) {
  return normalizePriorityTier(raw, { warn: () => {} });
}

// The starvation window every tier-aware call defaults to. A FUNCTION, not a captured constant, so
// the env override reaches the display probe and the assignment core alike — a status line
// claiming a `low` waiter is still `low` while the queue is serving it as `medium` is exactly the
// drift the shared comparator exists to prevent.
export function defaultLowPromoteMs() {
  return envInt('TEST_QUEUE_LOW_PROMOTE_MS', LOW_PROMOTE_MS);
}

export function effectiveTier(ticket, now, lowPromoteMs = defaultLowPromoteMs()) {
  const tier = normalizeTier(ticket?.tier);
  if (
    tier === 'low' &&
    Number.isFinite(ticket?.startedWaiting) &&
    now - ticket.startedWaiting >= lowPromoteMs
  ) {
    return PRIORITY_DEFAULT;
  }
  return tier;
}

// compareWaiting — the ONE waiting-ticket order: effective tier first, then FIFO by
// startedWaiting, then pid as a deterministic tie-break so two same-ms arrivals resolve
// identically in every process. Exported so push-queue-status.mjs displays the queue in the order
// it will actually be served instead of a second, drifting sort.
export function compareWaiting(a, b, now, lowPromoteMs = defaultLowPromoteMs()) {
  return (
    PRIORITY_SORT_WEIGHT[effectiveTier(a, now, lowPromoteMs)] -
      PRIORITY_SORT_WEIGHT[effectiveTier(b, now, lowPromoteMs)] ||
    a.startedWaiting - b.startedWaiting ||
    a.pid - b.pid
  );
}

// computeHolders — the pure slot-assignment core.
// tickets: [{ pid, startedWaiting, heartbeat, tier?, startedRunning? }] (already parsed).
// Live = isLiveTicket. Holders = every live RUNNING ticket (never preempted, never capped away —
// they are already burning cores; "evicting" one only mis-counts the load) PLUS the best waiting
// tickets, in compareWaiting order, up to whatever is left of `concurrency`.
export function computeHolders(tickets, now, concurrency, staleMs, opts = {}) {
  const lowPromoteMs = opts.lowPromoteMs ?? defaultLowPromoteMs();
  // ONE pass over the tickets, partitioning as we go — this runs on every poll of every waiting
  // process, so three separate traversals of the same array were pure waste.
  const holders = new Set();
  const waiting = [];
  let runningCount = 0;
  for (const t of tickets) {
    if (!isLiveTicket(t, now, staleMs)) continue;
    if (isRunningTicket(t)) {
      holders.add(t.pid);
      runningCount++;
    } else {
      waiting.push(t);
    }
  }
  const free = Math.max(0, concurrency) - runningCount;
  if (free <= 0) return holders;
  waiting.sort((a, b) => compareWaiting(a, b, now, lowPromoteMs));
  for (const t of waiting.slice(0, free)) holders.add(t.pid);
  return holders;
}

// Exported (plan 1795) so push-queue-status.mjs resolves TEST_QUEUE_CONCURRENCY through the
// SAME validation this queue uses — a re-rolled copy could silently drift on the >0 rule.
export function envInt(name, fallback, env = process.env) {
  const v = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function resolveTestQueueConcurrency(env = process.env) {
  return envInt('TEST_QUEUE_CONCURRENCY', DEFAULT_CONCURRENCY, env);
}

// PYTEST_MEMORY_BUDGET / PYTEST_MEMORY_FREE_BYTES (plan 3954 review round 2) — env-level pins for
// the memory axis, alongside TEST_QUEUE_CONCURRENCY above: `PYTEST_MEMORY_BUDGET=off` disables
// the axis (CPU-only, same as opts.budget: null); any other value is a budget-file PATH to load
// instead of the default scripts/pytest-memory-budget.json. `PYTEST_MEMORY_FREE_BYTES=<int>`
// substitutes for a live os.freemem() read. Both exist so a real CLI subprocess spawned from a
// test (pytest-workers.test.mjs's `runCli()`) can be made fully deterministic — the alternative,
// injecting opts.freemem/opts.budget, only reaches an in-process call. `opts` still wins over
// env on both axes (an explicit in-process injection is never overridden by an inherited var).
function envPytestMemoryBudget(env) {
  if (env.PYTEST_MEMORY_BUDGET === undefined) return undefined; // no override — caller's default
  if (env.PYTEST_MEMORY_BUDGET === 'off') return null; // disables the memory axis outright
  return loadPytestMemoryBudget(env.PYTEST_MEMORY_BUDGET); // a fixture budget file path
}

function envPytestMemoryFreeBytes(env) {
  if (env.PYTEST_MEMORY_FREE_BYTES === undefined) return undefined;
  const v = Number.parseInt(env.PYTEST_MEMORY_FREE_BYTES, 10);
  return Number.isFinite(v) ? v : undefined;
}

// perSlotWorkerBudgetDetail — workers = min(cpuBudget, memoryBudget), bounding only the WORKER
// count inside a slot; DEFAULT_CONCURRENCY (the SLOT count) is untouched and there is no
// admission floor that refuses a slot on low memory (plan 1750's fixed-concurrency ruling — see
// plan 3954 § Rulings applied). The memory axis budgets against its SHARE of free memory, not
// the whole pool — exactly like the CPU axis already divides by resolveTestQueueConcurrency(env)
// — because every concurrent slot reads the same live freemem() figure: an undivided memory
// budget lets N slots each admit up to the full free pool's worth of workers, so N slots can
// collectively demand N times the machine's free memory and reproduce the Windows spawn-starvation
// failure this axis exists to prevent (review finding, plan 3954). `opts.freemem`/`opts.budget`
// are the injection points: a caller (or a test) supplies its own free-memory reader and/or a
// fixture budget object instead of the live machine and the committed
// scripts/pytest-memory-budget.json, per the vetapp CLAUDE.md "the environment must be a
// parameter" rule. `opts.budget: null` disables the memory axis outright (CPU-only, matching this
// function's pre-3954 behaviour) without touching the filesystem or the clock. A missing/
// unreadable/unmeasured budget degrades the same way — loadPytestMemoryBudget() already logs the
// one line and returns null. `env.PYTEST_MEMORY_BUDGET`/`env.PYTEST_MEMORY_FREE_BYTES` are the
// same two injection points reachable through the environment instead of `opts`, for a real CLI
// subprocess a test cannot pass `opts` into directly — see envPytestMemoryBudget above; `opts`
// always wins when both are supplied.
// ── plan 4236 T2 (H2): a FAIL-OPENED run is CLAMPED, never full-width ─────────────────────────
// Past MAX_WAIT_MS (and on the other bail() exits) acquire() lets the waiter run UNSERIALIZED so a
// queue bug can never wedge every push. Before this plan that run was also UNCLAMPED: under
// sustained load a correctly-full queue (two live full-box holders) pushed the next waiter over 20
// min and it started a THIRD full-box job — the box got slower, so the next waiter timed out too
// (the 2026-09-26 incident, 4228's battery). The fail-open stays; its width does not. The caller
// that spawns the run (queued-run.mjs, run-land-tests.mjs) sets TEST_QUEUE_FAIL_OPEN=1 in the
// child's env, and THIS is the one place the clamp value lives for every runner that sizes itself
// from the per-slot budget at load time (pytest-workers.mjs, both vitest configs): under the flag
// both axes answer FAIL_OPEN_CONCURRENCY. It equals battery-lock.mjs's OVERFLOW_TEST_CONCURRENCY
// (plan 1795, the clamp an unserialized battery already runs at) — a test pins the two together;
// it is not imported from there because the vitest configs load this module and must not pull the
// lock module's git-facing import graph in with it.
export const FAIL_OPEN_CONCURRENCY = 2;
export const FAIL_OPEN_ENV = 'TEST_QUEUE_FAIL_OPEN';

// The child env for a fail-opened run: the flag above, PLUS the two runner-policy override vars
// (`PYTEST_WORKERS` / `VITEST_WORKERS`, read by scripts/pytest-workers.mjs) clamped to the same
// value — gpt-review r1 (8fd10a/87bf88): that policy replaces the per-slot budget with a
// `min(4, cpu)` ceiling on a remote sandbox, so the flag alone did not reach a cloud vitest run,
// while an override is honoured on every host (it can tune down, never up). An explicit override
// already at or below the clamp is kept — a fail-open never WIDENS a run. Pure: returns a new env.
// The ONE worker-value clamp every fail-open rewrite uses (gpt-review r2 ff21dd — queued-run's
// argv rewrite and failOpenEnv below share it so they cannot drift): a positive integer at or below
// FAIL_OPEN_CONCURRENCY is kept (a fail-open never widens); anything else — larger, zero, negative,
// `auto`, junk, absent — becomes FAIL_OPEN_CONCURRENCY. Returns a string (argv/env shaped).
export function clampWorkerValue(v) {
  const s = v == null ? '' : String(v);
  return /^[0-9]+$/.test(s) && Number(s) >= 1 && Number(s) <= FAIL_OPEN_CONCURRENCY
    ? s
    : String(FAIL_OPEN_CONCURRENCY);
}

export function failOpenEnv(env = process.env) {
  const clamp = clampWorkerValue;
  return {
    ...env,
    [FAIL_OPEN_ENV]: '1',
    PYTEST_WORKERS: clamp(env.PYTEST_WORKERS),
    VITEST_WORKERS: clamp(env.VITEST_WORKERS),
  };
}

export function perSlotWorkerBudgetDetail(cpu, env = process.env, opts = {}) {
  if (env?.[FAIL_OPEN_ENV] === '1') {
    return {
      workers: FAIL_OPEN_CONCURRENCY,
      cpuBudget: FAIL_OPEN_CONCURRENCY,
      memoryBudget: null,
      binding: 'fail-open',
      perWorkerPeakBytes: null,
      controllerPeakBytes: 0,
      freeBytes: null,
      memoryShareBytes: null,
    };
  }
  const envFreeBytes = envPytestMemoryFreeBytes(env);
  const freemem = opts.freemem ?? (envFreeBytes !== undefined ? () => envFreeBytes : osFreemem);
  let budget;
  if (opts.budget !== undefined) {
    budget = opts.budget; // explicit in-process injection — never overridden by env
  } else if (env.PYTEST_MEMORY_BUDGET !== undefined) {
    budget = envPytestMemoryBudget(env); // 'off' -> null, else the fixture path's own result
  } else {
    budget = loadPytestMemoryBudget(); // the live default: the committed budget file
  }
  const normalizedCpu = Math.max(1, Math.floor(cpu));
  const effectiveCapPercent = cpuCapPercent(env) ?? 100;
  const concurrency = resolveTestQueueConcurrency(env);
  const cpuBudget = Math.max(
    1,
    Math.floor((normalizedCpu * effectiveCapPercent) / 100 / concurrency),
  );
  const perWorkerPeakBytes =
    Number.isFinite(budget?.perWorkerPeakBytes) && budget.perWorkerPeakBytes > 0
      ? budget.perWorkerPeakBytes
      : null;
  // controllerPeakBytes (plan 3954 review round 2): the xdist CONTROLLER's own peak, an
  // additional fixed cost every slot pays once before any worker starts. loadPytestMemoryBudget
  // already normalizes a missing/invalid value to 0, so this is never NaN even from an old
  // committed file or an opts.budget fixture that omits the field entirely.
  const controllerPeakBytes = Number.isFinite(budget?.controllerPeakBytes)
    ? Math.max(0, budget.controllerPeakBytes)
    : 0;
  // Only read free memory at all when there is a usable divisor — a disabled/absent budget must
  // cost nothing beyond the (already-logged) file read, never an extra live syscall.
  const freeBytes = perWorkerPeakBytes != null ? freemem() : null;
  // This slot's SHARE of the free pool — every concurrent slot divides the same live reading by
  // the same fixed slot count, so N slots budget against N disjoint shares instead of each
  // budgeting against the whole pool.
  const memoryShareBytes = freeBytes != null ? freeBytes / concurrency : null;
  const memoryBudget =
    perWorkerPeakBytes != null
      ? memoryWorkerBudget(memoryShareBytes, perWorkerPeakBytes, controllerPeakBytes)
      : null;
  const workers = memoryBudget != null ? Math.min(cpuBudget, memoryBudget) : cpuBudget;
  const binding = memoryBudget != null && memoryBudget < cpuBudget ? 'memory' : 'cpu';
  return {
    workers,
    cpuBudget,
    memoryBudget,
    binding,
    perWorkerPeakBytes,
    controllerPeakBytes,
    freeBytes,
    memoryShareBytes,
  };
}

export function perSlotWorkerBudget(cpu, env = process.env, opts = {}) {
  return perSlotWorkerBudgetDetail(cpu, env, opts).workers;
}

// readTickets — parse every ticket in the queue dir into computeHolders input.
// A half-written / unparseable ticket degrades gracefully instead of poisoning
// the queue: pid + startedWaiting are recovered from the `<ms>-<pid>.json`
// filename and the file's mtime stands in for its heartbeat (so an abandoned
// corrupt file still goes stale and gets pruned). Files that fit neither shape
// are ignored entirely. Exported since plan 1795 for the read-only
// push-queue-status.mjs probe; label/host ride along (when parseable) purely
// for that probe's display — computeHolders/pruneStale never read them.
export function readTickets(dir) {
  // A readdir failure THROWS (it is not "no tickets"): the wait loop's
  // consecutive-error counter is the fail-open path for a persistently broken
  // queue dir, and swallowing the error here would instead starve the caller
  // invisibly for the whole max-wait (round-3 review finding).
  const names = readdirSync(dir);
  const tickets = [];
  for (const name of names) {
    const m = /^(\d+)-(\d+)\.json$/.exec(name);
    if (!m) continue;
    const file = join(dir, name);
    let t;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      t = {
        pid: Number(parsed.pid),
        startedWaiting: Number(parsed.startedWaiting),
        heartbeat: Number(parsed.heartbeat),
        label: typeof parsed.label === 'string' ? parsed.label : undefined,
        host: typeof parsed.host === 'string' ? parsed.host : undefined,
        // Plan 2716 — ORDERING inputs, unlike label/host: effectiveTier and isRunningTicket read
        // these, so a ticket parsed here must carry them or every rival would rank it as an
        // unstamped waiter. `startedRunning` stays undefined (not NaN) when absent so
        // Number.isFinite cleanly says "still waiting" for a pre-2716 ticket.
        tier: typeof parsed.tier === 'string' ? parsed.tier : undefined,
        // STRICT: a real number, above zero. `Number(x)` was wrong here — `Number(null)` and
        // `Number('')` are both 0, which IS finite, so a ticket carrying `"startedRunning": null`
        // (or an empty string) would have been classified as a RUNNING holder that no rival may
        // preempt, permanently, until it went stale. No writer emits that shape today, which is
        // exactly why the parse must not accept it: this reader's whole job is to make a foreign
        // or half-written ticket degrade safely, and "silently promoted to un-preemptable" is the
        // least safe possible degradation.
        startedRunning:
          typeof parsed.startedRunning === 'number' &&
          Number.isFinite(parsed.startedRunning) &&
          parsed.startedRunning > 0
            ? parsed.startedRunning
            : undefined,
      };
    } catch {
      t = { pid: Number(m[2]), startedWaiting: Number(m[1]), heartbeat: NaN };
    }
    if (!Number.isFinite(t.heartbeat)) {
      try {
        t.heartbeat = statSync(file).mtimeMs;
      } catch {
        continue; // vanished mid-scan (a rival prune / a release) — not a ticket anymore
      }
    }
    if (!Number.isFinite(t.pid) || !Number.isFinite(t.startedWaiting)) continue;
    tickets.push({ ...t, file });
  }
  return tickets;
}

// pruneStale — best-effort unlink of tickets whose heartbeat is stale. Unlike
// excl-lock's rename-then-unlink reap, a plain unlink is race-safe HERE because
// ticket filenames are per-(startedWaiting,pid) unique and never recreated —
// two racing pruners just means one wins and one gets ENOENT.
function pruneStale(tickets, now, staleMs) {
  for (const t of tickets) {
    if (!isLiveTicket(t, now, staleMs)) {
      try {
        unlinkSync(t.file);
      } catch {
        /* already pruned/released by someone else */
      }
    }
  }
}

// writeTicket — the shared atomic-write helper (fsync + tmp-then-rename; the
// plan-1733 writeRegistry lesson, extracted in plan 1761: an un-fsynced write
// can survive the rename as a truncated file under a real I/O error) so readers
// never parse a torn write as a (wrong) live ticket. The helper's rename
// replaces an existing target on all platforms Node supports, which is exactly
// the heartbeat-refresh path; a failed write cleans up its own tmp file (orphan
// tmps would otherwise accumulate in the machine-global dir — and are inert to
// readTickets' `^\d+-\d+\.json$` filter either way) and rethrows — the caller
// decides retry vs fail-open.
function writeTicket(file, ticket) {
  atomicWriteJsonSync(file, ticket);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// acquire — wait for a slot (or a fail-open condition), return an idempotent
// release() fn. Never throws and never waits past maxWaitMs: a queue bug or a
// full queue degrades to "run unserialized, loudly", never a wedged push.
// plan 4236 T2: the returned fn carries `admitted` — true for a genuine slot (and for the
// deliberate TEST_QUEUE_DISABLE=1 bypass, which is an opt-out, not a failure), false for every
// bail() fail-open — so the caller can clamp a run the queue never admitted. Every existing
// caller that only calls the fn is unaffected.
// opts (tests / callers with special needs — production callers pass only `tier`):
//   dir, concurrency, staleMs, pollMs, maxWaitMs, heartbeatMs, lowPromoteMs, pid, tier, log
//
// `tier` is PASSED IN rather than derived here (plan 2716): resolving it means asking git which
// plan this session claimed, and this module deliberately owns no git/plan knowledge — that lives
// in session-priority.mjs, which the two production callers (queued-run.mjs, run-land-tests.mjs)
// import. An omitted tier is the ruled default, `medium`.
export async function acquire(label, opts = {}) {
  const log = opts.log ?? ((m) => console.error(m));
  if (process.env.TEST_QUEUE_DISABLE === '1') {
    log(`test-queue: TEST_QUEUE_DISABLE=1 — bypassing the queue for "${label}"`);
    return Object.assign(() => {}, { admitted: true });
  }
  if (process.env.TEST_QUEUE_DIR) {
    // The override must never be ambient/invisible: a TEST_QUEUE_DIR leaked
    // into a REAL gate run (exported in a shell profile, inherited from a
    // debugging session) would queue against an empty scratch dir and silently
    // defeat the machine-global herd cap (plan 1750).
    log(
      `test-queue: TEST_QUEUE_DIR override active — queue dir is ${process.env.TEST_QUEUE_DIR}, NOT the machine-global default`,
    );
  }
  const dir = opts.dir ?? DEFAULT_QUEUE_DIR;
  const concurrency = opts.concurrency ?? resolveTestQueueConcurrency();
  const staleMs = opts.staleMs ?? STALE_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const maxWaitMs = opts.maxWaitMs ?? envInt('TEST_QUEUE_MAX_WAIT_MS', MAX_WAIT_MS);
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const lowPromoteMs = opts.lowPromoteMs ?? defaultLowPromoteMs();
  const pid = opts.pid ?? process.pid;

  let ticketFile;
  let heartbeatTimer;
  let released = false;
  const ticket = {
    pid,
    host: hostname(),
    label,
    // Plan 2716. Written even when it is the default so a ticket is self-describing on disk (the
    // push-queue-status probe and any post-mortem read it straight from the file).
    tier: normalizeTier(opts.tier),
    startedWaiting: Date.now(),
    heartbeat: Date.now(),
  };

  const release = () => {
    if (released) return;
    released = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    process.removeListener('exit', release);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (ticketFile) {
      try {
        unlinkSync(ticketFile);
      } catch {
        /* already gone (pruned as stale, or dir vanished) — releasing is best-effort */
      }
    }
  };
  // A killed / run_bounded-timed-out process must free its slot immediately,
  // not after the 90s stale window. On SIGINT/SIGTERM we call ONLY
  // process.exit and let the 'exit' listeners run in order: the caller's
  // PREPENDED child-tree kill first (run-land-tests), THEN this module's
  // release. Releasing directly here would free the slot while the vitest
  // tree is still alive, admitting a rival on top of it (round-3 finding).
  const onSignal = (sig) => {
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };

  // bail — the ONE fail-open exit: log why, free the ticket, hand the caller a
  // no-op release. Every unserialized-proceed path goes through here.
  const bail = (msg) => {
    log(msg);
    release();
    return Object.assign(() => {}, { admitted: false });
  };

  try {
    mkdirSync(dir, { recursive: true });
    ticketFile = join(dir, `${ticket.startedWaiting}-${pid}.json`);
    writeTicket(ticketFile, ticket);
    process.on('exit', release);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    let announced = false;
    let warnedTransient = false;
    let consecutiveErrs = 0;
    // A TRANSIENT fs blip retries; a PERSISTENT one (queue dir quarantined,
    // permissions revoked, disk full) must fail open in seconds, not silently
    // burn the whole 20-min max-wait (delta-review finding 2). Ten consecutive
    // failed polls ≈ 15s of unbroken failure — far past any AV-scan blip.
    const ERR_FAIL_OPEN_AFTER = 10;
    let lastBeat = ticket.startedWaiting; // the pre-loop writeTicket above was the first beat
    for (;;) {
      const now = Date.now();
      // The whole iteration body is transient-error-tolerant (the plan-1703
      // landing-lock lesson: AV/sync-scan EBUSY/EACCES blips strike lock files
      // mid-wait): a failed beat/read retries on the next poll — our ticket
      // self-heals because writeTicket's rename is create-or-replace, so even
      // a wrongful prune of our file is undone by the next successful beat
      // (startedWaiting is preserved in memory → FIFO position retained).
      try {
        if (now - lastBeat >= heartbeatMs) {
          ticket.heartbeat = now; // waiting processes heartbeat too, or they'd be pruned while queued
          writeTicket(ticketFile, ticket);
          lastBeat = now;
        }
        const tickets = readTickets(dir);
        pruneStale(tickets, now, staleMs);
        if (computeHolders(tickets, now, concurrency, staleMs, { lowPromoteMs }).has(pid)) {
          if (announced) {
            log(
              `test-queue: slot acquired for "${label}" after ` +
                `${Math.round((now - ticket.startedWaiting) / 1000)}s in queue`,
            );
          }
          break;
        }
        if (!announced) {
          announced = true;
          const ahead = tickets.filter((t) => t.pid !== pid).length;
          log(
            `test-queue: waiting for a test slot ("${label}", tier ${ticket.tier}) — ` +
              `~${ahead} other run(s) queued, concurrency ${concurrency}, ` +
              `machine-global dir ${dir}`,
          );
        }
        consecutiveErrs = 0;
      } catch (e) {
        consecutiveErrs++;
        if (!warnedTransient) {
          warnedTransient = true;
          log(
            `test-queue: transient queue-dir error while waiting (${e?.message ?? e}) — ` +
              `retrying each poll; ${ERR_FAIL_OPEN_AFTER} consecutive failures fail-open.`,
          );
        }
        if (consecutiveErrs >= ERR_FAIL_OPEN_AFTER) {
          return bail(
            `test-queue: ${consecutiveErrs} consecutive queue-dir errors — the queue dir looks ` +
              `persistently broken, not a transient blip. FAIL-OPEN: proceeding UNSERIALIZED. ` +
              `Repair ${dir} (permissions/disk) to restore serialization.`,
          );
        }
      }
      if (now - ticket.startedWaiting > maxWaitMs) {
        // bail releases the ticket BEFORE proceeding: a failed-open run that
        // kept its FIFO-oldest ticket would later be awarded a slot it no
        // longer needs, starving a genuine waiter (review finding 3). The
        // unserialized run is invisible to the queue's load accounting —
        // accepted and logged.
        return bail(
          `test-queue: WARNING — waited ${Math.round(maxWaitMs / 60_000)} min for a slot ` +
            `("${label}") without acquiring one. FAIL-OPEN: proceeding UNSERIALIZED so a ` +
            `queue bug can never wedge every push. If this recurs, inspect ${dir}.`,
        );
      }
      await sleep(pollMs);
    }

    // NEVER-PREEMPT STAMP (plan 2716). From here on this ticket is a HOLDER, not a waiter, in
    // every rival's computeHolders — so a later high-tier arrival is admitted only into a FREE
    // slot, never on top of this run. Written immediately (not left to the ~10s heartbeat): the
    // gap between breaking out of the loop and the first beat is exactly the window in which a
    // rival could out-rank us and over-admit.
    //
    // NOT ATOMIC with the award, and cannot be: the award is a pure computation each process does
    // over the same shared files, so there is no write to fuse it with. The exposure is precisely
    // the interval in which our ticket is on disk WITHOUT the stamp — during it we rank as a
    // waiter, and a higher-tier arrival can be admitted alongside us, running N+1 heavy jobs.
    // Retried a few times because a single tmpdir blip must not stretch that interval to the full
    // ~10s heartbeat gap, and logged loudly if every attempt fails, because the alternative is an
    // over-admission with nothing anywhere saying why.
    //
    // Note what does NOT save us: being the FIFO-oldest waiter. That only holds within a tier —
    // the whole point of this plan is that a `high` arrival outranks an older `low`, which is
    // exactly the case where the missing stamp bites. (An earlier draft of this comment claimed
    // FIFO covered it; it does not.)
    ticket.startedRunning = Date.now();
    ticket.heartbeat = ticket.startedRunning;
    let stamped = false;
    for (let attempt = 0; attempt < 3 && !stamped; attempt++) {
      try {
        writeTicket(ticketFile, ticket);
        stamped = true;
      } catch {
        /* retry; the heartbeat below is the last-resort re-lander */
      }
    }
    if (!stamped) {
      log(
        `test-queue: WARNING — could not stamp the running marker for "${label}" (pid ${pid}). ` +
          `Until the next heartbeat lands (~${Math.round(heartbeatMs / 1000)}s) a higher-tier ` +
          `arrival may be admitted alongside this run, briefly exceeding concurrency ${concurrency}.`,
      );
    }

    heartbeatTimer = setInterval(() => {
      ticket.heartbeat = Date.now();
      try {
        writeTicket(ticketFile, ticket);
      } catch {
        /* tmpdir hiccup — stale-reclaim may reap us; the run itself must not die for it */
      }
    }, heartbeatMs);
    heartbeatTimer.unref();
    return Object.assign(release, { admitted: true });
  } catch (e) {
    // FAIL-OPEN: an I/O failure during setup (mkdir / first ticket write)
    // degrades to an unserialized run immediately.
    return bail(
      `test-queue: WARNING — queue unavailable (${e?.message ?? e}); proceeding UNSERIALIZED.`,
    );
  }
}

// withTestSlot — the one-call wrapper run-land-tests.mjs uses: hold a slot for
// the duration of fn(), releasing in a finally (signals/exit are wired inside
// acquire for the paths finally can't reach).
// plan 4236 T2: fn receives `{ admitted }` (see acquire) so a fail-opened run can be clamped.
export async function withTestSlot(label, fn, opts = {}) {
  const release = await acquire(label, opts);
  try {
    return await fn({ admitted: release.admitted !== false });
  } finally {
    release();
  }
}
