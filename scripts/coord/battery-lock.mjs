#!/usr/bin/env node
// scripts/battery-lock.mjs — machine-wide mutex for the pre-push coord test battery (plan 1673).
//
// WHY: the battery drives REAL git in throwaway temp repos and spawns ~one node worker per test
// file. With 5-7 parallel coord sessions, every coordWrite push fired its own battery: 9-10 ran
// CONCURRENTLY (measured 2026-07-10 — 162 live git.exe, ~15 process creations/sec, kernel paged
// pool 6.1 GB in 5h, reboot required). `select-battery-tests.mjs` shrinks each battery; this file
// stops them from overlapping. The two axes are independent — keep both.
//
// SERIALIZATION IS LOAD-SHEDDING, NEVER A TEST-SKIP (operator ruling 2026-07-10). A queue-wait
// expiry therefore exits with a DISTINCT code and the hook runs the battery anyway, unserialized —
// exactly today's behaviour. Nothing in this file may ever cause a test not to run.
//
// RENDEZVOUS: the lockfile lives in the SHARED `.git` common dir (`git rev-parse --git-common-dir`),
// the same property `scripts/landing-lock.mjs` relies on — every worktree of the one clone sees the
// one file, and it is never git-tracked nor swept by `git clean -fdx`. Sessions on a DIFFERENT clone
// have their own lock; that is out of scope (the pathology was one clone's worktree herd).
//
// STALENESS: SAME-HOST HOLDER-PID PROOF PRIMARY, AGE THE FALLBACK (plan 2549). A same-host entry
// whose DECLARED holder pid is PROVABLY dead (`pidAlive(entry.holderPid) === false`, imported from
// worktree-lock.mjs — the convention worktree-lock and the plan-2266 landing-queue reap already
// established) is reaped immediately, independent of age. Everything else falls through to the age
// rule: a foreign-host entry (its pid is another machine's number — default-deny, the plan-2266
// posture), an unprovable probe (null), a pid-reuse false-alive, and any entry WITHOUT a declared
// holderPid. The probe can only ever produce a false ALIVE, never a false dead, so it can only
// ever reap locks that are already orphaned. See DEFAULT_STALE_MIN for the fallback ceiling.
//
// THAT "NEVER A FALSE DEAD" GUARANTEE HAS A PRECONDITION, AND PLAN 2734 MADE IT ENFORCED RATHER THAN
// MERELY DOCUMENTED. It holds only while the declared pid lives in the SAME namespace as
// `process.kill` — i.e. a WINDOWS pid on Windows. An MSYS-namespace pid (a raw `$$` from Git Bash)
// is a perfectly valid positive integer that simply does not exist to `process.kill`, so it raises
// ESRCH and reads as PROVABLY DEAD: the next waiter reaps a LIVE holder's lock instantly and the
// concurrent-battery herd is back. The warning below used to be prose only, and it was still tripped
// within minutes of being read (a plan-2734 scratch test passed a Git Bash `$$`), so prose is not
// enough. `holderPidTrustworthy` now SELF-CHECKS the declaration at acquire time: the declared
// holder is the process blocked waiting on this very subprocess, so it CANNOT be dead right now —
// a `false` probe therefore proves the DECLARATION wrong, not the holder dead. On that verdict the
// field is dropped (age-only, exactly the pre-2549 behaviour) with a loud warning, converting a
// silent unsafe failure into a loud safe one. The residual case — a wrong pid that happens to match
// some other LIVE process — is NOT eliminated, and the first draft of this comment wrongly called it
// "safe in the safe direction" (caught by the second review round, two finders): a false ALIVE at
// declaration time turns into a false DEAD later, when that unrelated process exits while the battery
// is still running, and the next waiter reaps a live lock. So the guard narrows the window from
// "every wrong-namespace pid poisons the lock" to "only a wrong pid that both collides with a live
// Windows pid AND outlives the declaration but not the battery" — a real residual, not zero. Closing
// it needs ownership proof, not liveness: verifying the declared pid is an ANCESTOR of this acquirer.
// That is deliberately not done here — the only portable way on Windows is a WMI/CIM ancestry scan,
// which costs a PowerShell spawn (~150-400ms, see the hook's own plan-2530 note) on the hot push path
// this plan exists to make cheaper, and `process.ppid` alone cannot stand in for it because MSYS
// command substitution may insert an intermediate shell, which would make a strict check REFUSE
// valid declarations — trading a rare residual for a routine regression.
//
// WHY `holderPid` IS A SEPARATE, OPT-IN FIELD — NEVER probe `entry.pid` (the plan-2549 execution
// finding that reshaped the spec): `entry.pid` is the pid of whichever process WROTE the lock
// file. For this CLI that is the short-lived `acquire` subprocess inside the hook's command
// substitution — dead milliseconds after a perfectly healthy acquire, in NORMAL operation (the
// landing-lock.mjs "short-lived holder" insight applies to the acquirer here too). Probing it
// would reap every legitimately held lock on the first waiter poll and resurrect the exact
// concurrent-battery herd this lock exists to prevent. Only a pid the caller EXPLICITLY declares
// long-lived (`--holder-pid`, wired in scripts/hooks/pre-push.sh from the hook shell's own pid — the
// process that actually spans the battery run) is probeable. On Git-for-Windows sh, `$$` is an
// MSYS-namespace pid that `process.kill` cannot probe (false-DEAD risk on a live holder), so the
// hook passes `$(cat /proc/$$/winpid 2>/dev/null || echo $$)` — the Windows pid on MSYS, plain
// `$$` on Linux. Callers that don't declare (older hooks, manual CLI runs, and
// cloud-session-hygiene.mjs's delete lock built on this same acquireOnce) keep age-only exactly
// as before.
//
// OWNERSHIP BY TOKEN: `acquire` prints an opaque token on stdout and writes it into the lockfile;
// `release --token <t>` unlinks ONLY when the token matches. This is what keeps a session that
// TIMED OUT (and never held the lock) from releasing the lock of the session that did.
//
// TWO TIERS + A PROGRESS-AWARE WAIT (plan 2734). The wait is no longer a flat per-waiter timer that
// dumps every expired waiter onto the machine at once (the measured 2026-08-02 thundering herd —
// see DEFAULT_STALE_MIN's successor constants below for the full history and numbers). A waiter now
// gives up only when the CURRENT HOLDER is stuck, and even then it must be ADMITTED: it takes the
// single `overflow` slot, so at most one clamped battery joins the one full-parallelism battery.
// See LOCK_TIERS for the tier model and why it is two files rather than a new N-slot mechanism.
//
// Usage:
//   node scripts/battery-lock.mjs acquire [--label <s>] [--holder-pid <windows-pid>] [--stale-min 120]
//                                         [--timeout-sec 4409] [--holder-patience-sec 3300]
//                                         [--admission-wait-sec 300] [--poll-sec 5]
//   (`scripts/hooks/pre-push.sh` overrides --timeout-sec to 30 for a small selected subset — plan
//   1679; that flag is now the anti-hang TOTAL-wait ceiling, not the give-up timer)
//   node scripts/battery-lock.mjs release --token <token> [--force]   # probes BOTH tiers
//   node scripts/battery-lock.mjs status                  # read-only: one line per tier
//   node scripts/battery-lock.mjs path [--tier overflow]  # read-only: the resolved lock path
//
// Exit codes (acquire): 0 ACQUIRED the serialized lock (token on stdout; run at FULL parallelism) ·
// 4 UNSERIALIZED (the caller must PROCEED at REDUCED parallelism,
// `--test-concurrency=OVERFLOW_TEST_CONCURRENCY`, never skip — plan 1795). Exit 4 now comes in two
// flavours that the caller does NOT need to distinguish: WITH a token on stdout it holds the
// overflow slot (release it like any token — `release` probes both tiers), WITHOUT one it is running
// unadmitted because the slot was taken for the whole admission window. Either way the clamp is the
// same, so the hook's branch is unchanged apart from no longer discarding the token ·
// 5 error (NOT a load signal — the caller proceeds unserialized at FULL parallelism, exactly the
// pre-1795 behaviour). `release` always exits 0 (close-out must never block a push).

import { join } from 'node:path';
import nodePath from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sleepSync } from './coord-git.mjs';
import { resolveCommonDirPath } from './lock-path.mjs';
// The file-level O_EXCL create/reap/release mechanism is shared with landing-lock.mjs's registry
// meta-mutex (plan 1678) — see scripts/coord/excl-lock.mjs for the extraction rationale and the
// cross-repo dependency-ordering constraint (a NEW coordShare member, adopted by tandapp ahead of
// or alongside any dependent). This file's OWN identity model (single-holder, token-owned,
// age-staled) and exit-code contract are NOT part of that shared module — only the mechanism is.
import {
  tryCreateExclusive,
  readExclusive,
  reapStaleExclusive,
  releaseOwned,
} from './excl-lock.mjs';
// `ageMinutes` and `parseLockArgs` are landing-lock's, imported rather than re-implemented: this
// lock deliberately follows its identity model, so a divergence between two hand-copied helpers
// would be a silent behaviour split between the two mutexes. (The import direction is safe:
// landing-lock.mjs is byte-identical-synced to siblings via coord.config.json, but battery-lock is
// not adopted by any sibling, so nothing downstream gains a dependency it does not already have.)
import { ageMinutes, parseLockArgs } from './landing-lock.mjs';
// Same-host liveness proof (plan 2549) — imported, not re-implemented: its semantics (true = alive
// incl. EPERM-under-another-user, false = provably dead via ESRCH, null = unprovable) are exactly
// what a second identity model here would need to duplicate. Import direction is safe: battery-lock
// already imports from landing-lock, and battery-lock is not in any sibling's adopt set, so no
// sibling gains a dependency it does not already have.
import { pidAlive, processStartToken, holderIdentity } from './worktree-lock.mjs';

export { ageMinutes, parseLockArgs };

// This CLI's own flag surface, passed to the shared cmd-shaped wrapper (plan 1777):
// parseLockArgs defaults to LANDING-LOCK's spec, and battery-lock's flags differ
// (`--label`/`--token`; no `--scope`, no `--wait`). An unknown flag throws loudly.
export const BATTERY_ARG_SPEC = Object.freeze({
  label: 'battery-lock',
  value: Object.freeze([
    'label',
    'holder-pid',
    'stale-min',
    'timeout-sec',
    'poll-sec',
    'token',
    // plan 2734: the progress-aware wait's two knobs (both defaulted from measured constants — the
    // hook passes neither; they exist so tests can drive patience and admission independently
    // without waiting out real minutes) plus `--tier` for the read-only status/path commands.
    'holder-patience-sec',
    'admission-wait-sec',
    'tier',
  ]),
  boolean: Object.freeze(['force']),
  // Strict values (plan-2734 review): NONE of this CLI's flags is `in`-checked — every one is read
  // with `!= null` and falls back to a default. So a valueless flag at the end of argv silently took
  // the default instead of erroring: `path --tier` printed the SERIALIZED path, `acquire
  // --holder-pid` disabled holder tracking, `release --token` behaved as if no token were given.
  // One spec line closes all of them; a per-flag guard would have to be repeated eight times and
  // would be forgotten on the ninth.
  requireValues: true,
});

// The reap ceiling MUST exceed the worst-case runtime of the thing it guards, or a waiter reaps a
// LIVE battery and starts a second one — precisely the concurrent-battery pathology this lock
// exists to prevent. The full battery is 2336 tests / 6m43s cold and ALONE on an idle machine, and
// the hook's retry-once loop (plan 984) can run it twice: ~13.5 min before any parallel-herd load.
// The old 15-minute ceiling sat inside that window. Plan 1674 then raised the hook's own
// per-attempt bound to max(1500s wrapper backstop deadline, 1200s+30s inner GNU-timeout
// cap+grace) = 1500s, making the retry loop's true worst case ~2×1500s ≈ 50 min — the previous
// 60-minute ceiling left only ~10 min of margin over a still-LIVE double-wedged run. The error
// is asymmetric — a ceiling that is too HIGH only delays reaping a genuinely crashed lock
// (waiters already give up after DEFAULT_TIMEOUT_SEC and proceed unserialized), while one that
// is too LOW reintroduces the bug — so the ceiling sits at ~2× the worst case. The numbers are
// not hand-maintained here alone: battery-lock.test.mjs DERIVES the worst case from the real
// hook text and fails if this ceiling stops clearing it.
export const DEFAULT_STALE_MIN = 120;
// ── A PROVABLY-LIVE HOLDER OUTLASTS THE AGE GATE, UP TO A HARD CEILING (plan 4236 T3, H3) ─────
// DEFAULT_STALE_MIN above assumed a battery never legitimately outlives 120 min. A LOADED land
// battery now does (plan 4228 measured 103 min on 2026-09-25 and 167+ min on 2026-09-26), and on
// 2026-09-26 a second land's acquire reaped a LIVE holder by age at 127 min and ran a second
// full-box battery beside it. A declared holder pid did not help and could not have: a pid that
// probes ALIVE only makes holderProvedDead false, and control then falls straight through to the
// age gate — the pid was designed as a FASTER reap for dead holders, never a protection for live
// ones. So an entry now also records its holder's OS start-time token (`holderStartToken`, the
// plan-2738 identity probe from worktree-lock.mjs) and the age gate is skipped while ALL of these
// hold: same host, the declared holder probes ALIVE, its start-time token still matches (a recycled
// pid necessarily started later, so a stranger that inherited the number is never mistaken for the
// holder), and the entry is no older than HARD_STALE_MIN. The hard ceiling is what keeps a wrong
// "alive" answer from wedging the lock for good; an entry without a trustworthy identity (no
// declared holder, no recorded token, an unreadable probe) keeps the plain 120-min age gate. The
// identity probe runs ONLY for an entry that is already age-stale, so the ordinary poll path pays
// nothing new.
export const HARD_STALE_MIN = 360;
// ── THE QUEUE WAIT: PROGRESS-AWARE, NOT A FLAT PER-WAITER TIMER (plan 2734) ─────────────────
// HISTORY, because the number that used to live here IS the bug. Plan 1679 set a flat
// DEFAULT_TIMEOUT_SEC = ceil(p95 403s × 1.5) = 605s, after which a waiter proceeded unserialized.
// That fallback has NO admission control, so under sustained load every waiter reaches the cap at
// roughly the same moment and serialization COLLAPSES rather than degrades. Measured live
// 2026-08-02 on this 20-core box (~5-7 sessions): push-queue-status.mjs reported
// `test-queue: 0/2 slot(s) held, 0 waiting` while the SAME probe counted 27 pre-push shells and 11
// live `node --test` processes — an empty queue beside live test trees IS the bypass, and it made
// the occupancy readout say QUIET at the exact moment the mechanism had been abandoned.
// Plan 1679's own latency-first justification for bypass-over-backpressure ("the cost of
// under-covering the tail is an occasional overlap, not a skipped test") is OVERTURNED on that
// evidence by operator ruling 2026-08-02: the overlap was not occasional, and it repaid itself in
// non-fast-forward rejections and load-induced re-runs, making concurrent strictly WORSE than
// serial for total throughput rather than merely equal.
//
// THE NEW EXIT TEST: a waiter gives up because the holder is STUCK, never because it is SLOW.
// The progress signal is the holder's OWN AGE (`entry.iso` — already written into every entry, so
// no new field and no holder-side writes). Two alternatives were considered and rejected:
//   - A holder HEARTBEAT. The holder is a `sh` hook shell, and the node process that acquires exits
//     milliseconds after a healthy acquire (the plan-2549 finding that made `holderPid` a separate
//     opt-in field). A heartbeat needs a background writer per battery — a new orphan class on the
//     exact surface plan 1674 spent a whole plan bounding.
//   - POSITION-aware scaling (the plan-2734 stub's first candidate). This lock has no queue and
//     therefore no position: it is a single-holder O_EXCL file and waiters are invisible to each
//     other. Positions mean a registry behind a meta-mutex (landing-lock's shape) on the hottest
//     lock in the repo. Not needed either — ADMISSION (below) closes the simultaneous-expiry
//     stampede, so waiters no longer need staggering.
// A handover writes a NEW entry with a fresh `iso`, so patience RESETS by construction: a waiter
// sits out a legitimately slow convoy instead of stampeding it, with no reset bookkeeping.
export const BATTERY_P95_SEC = 403; // measured cold full battery, plan 1673 (2336 tests / 6m43s)
// Machine load factor, measured on THIS host (plan 2511): the backend pytest suite, GREEN, took
// 605s quiet and 1665s (27:45) un-queued at 100% CPU under ~5-7 parallel sessions → ×2.75. That is
// a DIFFERENT suite from the battery this lock guards, so it is used ONLY as a machine-level
// loaded/quiet ratio, never as a battery duration. (Its 605s coincidence with plan 1679's old cap
// is exactly that — a coincidence; plan 2734's spec-pass corrected a stub that read the pair as a
// same-suite measurement and concluded the cap fires on healthy runs from it directly. The
// conclusion survives, via this multiplier: 403 × 2.75 ≈ 1109s ≫ 605s.)
export const LOAD_MULTIPLIER = 2.75;
export const LOADED_BATTERY_SEC = Math.ceil(BATTERY_P95_SEC * LOAD_MULTIPLIER); // 1109
// How long may the CURRENT holder hold before it is STUCK rather than merely slow?
//
// DERIVED FROM THE HOOK'S OWN BOUND, NOT FROM A LOAD MODEL — corrected by the plan-2734 review
// (2026-08-02, two independent finders): the first cut used `LOADED_BATTERY_SEC * 2` = 2218s, and
// "a two-attempt holder that completes each attempt just under the hook's 1200s cap can exceed the
// 2218s patience while still running." That reproduces THIS PLAN'S OWN DEFECT at a higher threshold:
// a give-up test below the holder's legitimate maximum fires on healthy holders. A load-derived
// average can never bound a worst case, so patience must come from whatever actually bounds a holder.
//
// What bounds a tier-1 holder is `scripts/hooks/pre-push.sh`: run_bounded caps each attempt at
// BATTERY_CAP=1200s with a wrapper backstop deadline of cap+300, and plan 984's retry-once can run
// two attempts inside ONE acquire ⇒ a HEALTHY tier-1 holder can legitimately hold 2 × 1500 = 3000s.
// The CLAMPED overflow cap (2400s) deliberately does NOT enter this: a clamped battery never holds
// tier 1 — it runs unserialized by construction, which is what earned it the clamp.
// battery-lock.test.mjs re-derives this bound from the REAL hook text and fails if patience stops
// clearing it (the DEFAULT_STALE_MIN pattern), so a future cap raise in the hook cannot silently
// reintroduce the false-stuck verdict.
// Plus MARGIN for what the two attempts do NOT include (second review round, 2026-08-02): the
// holder's lock lifetime spans lock setup, per-attempt mktemp/tee plumbing, the TAP failed-file
// harvest between attempts, the release itself, and OS scheduling delay on a saturated box. Covering
// exactly 2×(cap+grace) left ZERO headroom, so a healthy holder could cross the threshold on
// overhead alone — the same false-stuck verdict one step smaller. 300s is one wrapper-grace unit,
// the same magnitude the hook already allows per attempt for teardown.
export const HOLDER_PATIENCE_MARGIN_SEC = 300;
export const HOLDER_PATIENCE_SEC = 2 * (1200 + 300) + HOLDER_PATIENCE_MARGIN_SEC; // 3300
// ANTI-HANG BACKSTOP, NOT the primary exit. The lock is not FIFO, so a waiter can lose the create
// race repeatedly while the queue churns; with patience resetting on every handover the wait would
// be genuinely unbounded, and an unbounded wait HANGS `git push` with no signal at all — strictly
// worse than this file's documented worst case (proceed unserialized), exactly like the NaN-timeout
// footgun numericFlag() below exists to prevent. Sized as "sit out at most one stuck holder plus
// one more healthy handover". Affordable precisely BECAUSE admission makes the post-ceiling run
// harmless. Invariant, re-derived from these constants by battery-lock.test.mjs:
// DEFAULT_STALE_MIN * 60 (7200) > MAX_TOTAL_WAIT_SEC. `LOADED_BATTERY_SEC` is the right term for
// "one more healthy handover" here (an AVERAGE loaded run is what a handover costs), which is exactly
// why it is wrong for HOLDER_PATIENCE_SEC above (a worst case).
export const MAX_TOTAL_WAIT_SEC = HOLDER_PATIENCE_SEC + LOADED_BATTERY_SEC; // 4409
// ADMISSION (plan 2734): leaving the serialized wait does NOT mean running immediately. The waiter
// enters a bounded admission phase where it still PREFERS tier 1 (full parallelism, exit 0) and
// otherwise takes the single OVERFLOW slot — so the machine's worst case is one full-parallelism
// battery plus one clamped one, instead of the measured N-way stampede. This window only has to
// serialize a simultaneous-expiry cohort; it is NOT a drain window, because the CLAMP (not the
// wait) is the safety mechanism. Effective default is min(this, the total-wait ceiling): a push
// unwilling to wait long for the lock — plan 1679's size-gated `--timeout-sec 30` for a ≤5-file
// selection, which is explicitly not the load problem — is not asked to wait long for admission
// either, so its worst case stays ~2× its own ceiling instead of inheriting this one.
export const ADMISSION_WAIT_SEC = 300;
export const DEFAULT_POLL_SEC = 5;
export const EXIT_TIMEOUT = 4; // "proceed unserialized at REDUCED parallelism" — NEVER "skip the tests"
export const EXIT_ERROR = 5;
// OVERFLOW_TEST_CONCURRENCY (plan 1795): the `--test-concurrency` clamp the hook applies to an
// EXIT_TIMEOUT overflow run. A queue-wait expiry means the machine is ALREADY saturated (a holder
// battery is running, and under the 2026-07-13 storm two more were queued behind it) — letting the
// overflow run spawn the default one-worker-per-file herd is what turned "one slow battery" into
// 894 processes / 3 concurrent full batteries. The overflow still RUNS (the 2026-07-10 ruling:
// serialization is load-shedding, never a test-skip, and an expired waiter is never starved), just
// at clamped file-level parallelism so it adds ~2 workers to the storm instead of ~cores. 2, not
// the plan's illustrative 1: a fully serialized full-glob battery (~99 files, several 70s+) blows
// past any per-attempt cap the DEFAULT_STALE_MIN ceiling can absorb — 2 halves-or-better the
// storm's marginal load while keeping a clamped full battery inside the hook's overflow cap.
// This constant is the single source: scripts/hooks/pre-push.sh hardcodes the same value in its
// EXIT_TIMEOUT branch (a sh hook cannot import JS), and battery-lock.test.mjs derives the hook's
// literal from the real hook text and fails on drift — the DEFAULT_STALE_MIN pattern.
// STILL 2 UNDER PLAN 2734's TIERING, deliberately. Plan 2734 asked whether an UNADMITTED run (one
// that could not even get the overflow slot) should clamp harder, to 1. Answer: no — plan 1795
// already settled that question with a stated reason (a fully serialized full-glob battery, ~99
// files with several 70s+, blows past any per-attempt cap the DEFAULT_STALE_MIN ceiling can absorb),
// so re-introducing 1 would trade a load win for false cap-kill failures. Prior art wins; the clamp
// is the same 2 for both the overflow-slot holder and an unadmitted run.
export const OVERFLOW_TEST_CONCURRENCY = 2;

// ── THE TWO LOCK TIERS (plan 2734) ──────────────────────────────────────────────────────────
// Two single-holder locks, the SAME excl-lock primitive with the same reap rules:
//   'serialized' — the historical battery mutex. Its holder runs at FULL parallelism (exit 0).
//   'overflow'   — ONE slot for a battery admitted after a serialized-wait expiry. Its holder runs
//                  at OVERFLOW_TEST_CONCURRENCY (exit 4, token on stdout). This slot IS the
//                  admission control plan 1679's flat timer lacked: the machine's worst case
//                  becomes one full battery + one clamped one instead of the measured N-way herd.
// Why two FILES rather than one file with two slots: excl-lock.mjs is single-holder BY DESIGN, and
// N-holder semantics mean a registry behind a meta-mutex (landing-lock's shape) on the hottest lock
// in this repo — the plan-1678 surface that cost one train four review rounds on lock semantics
// alone. Two files reuse the proven primitive verbatim, with no new concurrency model.
// Why NOT test-queue.mjs, which is already a machine-global FIFO semaphore with N slots: its HOLDER
// CONTRACT is "do not block the event loop while holding a slot" and its tickets stay alive only
// while the HOLDING process heartbeats them. This lock's holder is a `sh` hook shell whose node
// acquirer exits milliseconds later (see the holderPid header note) — precisely the model that
// queue forbids. Reusing it here would let rivals prune a live holder's ticket and over-admit past
// N, which is its own documented failure mode, not a hypothetical.
export const LOCK_TIERS = Object.freeze({
  serialized: 'battery-lock.json',
  overflow: 'battery-overflow-lock.json',
});

// --- pure helpers -----------------------------------------------------------

// A numeric CLI flag, validated. `Number('5m')` is NaN, and `Date.now() >= NaN` is ALWAYS false —
// so an unvalidated NaN timeout turns the bounded queue wait into an infinite loop that hangs the
// pre-push hook, and with it the whole `git push`. That is strictly worse than this file's
// documented worst case (proceed unserialized): the battery never even starts. Throws → EXIT_ERROR
// → the hook runs the battery unserialized, which is the fail-safe direction.
//
// Review finding [3] (delta round, plan 1869 install-lock delta): `Number('')` and `Number('   ')`
// are BOTH `0` — a JS coercion quirk the `Number.isFinite(n) && n >= 0` check below does NOT catch,
// so a blank `--stale-min ''` used to silently become a valid 0-minute staleness that reaps every
// LIVE lock instantly — resurrecting the exact battery herd this lock exists to prevent. This was
// previously patched only in install-lock.mjs's own thin local wrapper around this function,
// leaving the bug live here in the shared helper (and in this file's own CLI, which calls this
// numericFlag directly with no wrapper of its own). Fixed at the source: reject an empty or
// whitespace-only string BEFORE the numeric coercion, so `null`/`undefined` (→ fallback) and an
// explicit `'0'` (→ 0, legitimate) are unaffected — only the blank-string case changes.
export function numericFlag(raw, fallback, name) {
  if (raw == null) return fallback;
  if (typeof raw === 'string' && raw.trim() === '')
    throw new Error(`--${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`--${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
  return n;
}

// A valued flag whose "value" is itself another `--flag` means the value was omitted
// (`release --token --force`): the parser silently consumed the next flag as the token, corrupting
// both. Surface it instead of acting on a garbage token.
export function assertFlagValue(raw, name) {
  if (typeof raw === 'string' && raw.startsWith('--'))
    throw new Error(`--${name} is missing its value (got the flag ${raw})`);
  return raw;
}

// Parse a lockfile's text. null on anything unreadable/malformed — a corrupt lock is treated as an
// unknown-age entry, i.e. reapable (see ageMinutes null → stale).
export function parseEntry(str) {
  try {
    const o = JSON.parse(str);
    return o && typeof o === 'object' && typeof o.token === 'string' ? o : null;
  } catch {
    return null;
  }
}

// Is a (possibly null/corrupt) holder entry reapable at `nowMs`? Unknown age ⇒ yes.
export function isStale(entry, nowMs, staleMin = DEFAULT_STALE_MIN) {
  if (!entry) return true;
  const age = ageMinutes(entry.iso, nowMs);
  return age == null || age > staleMin;
}

export function describeEntry(entry, nowMs) {
  if (!entry) return 'a corrupt lock file';
  const age = ageMinutes(entry.iso, nowMs);
  const holder = entry.holderPid != null ? `, holder-pid ${entry.holderPid}` : '';
  return `${entry.label ?? '?'} (host ${entry.host ?? '?'}, pid ${entry.pid ?? '?'}${holder}, age ${age == null ? 'unknown' : age + 'm'})`;
}

// --- fs ops (explicit path → unit-testable without a real .git) -------------

export function readEntry(lockPath) {
  const text = readExclusive(lockPath);
  return text === undefined ? undefined : parseEntry(text); // undefined = free, null = corrupt
}

// Try once to create the lock. Returns the token on success, undefined when already held.
// `holderPid` (plan 2549) is the OPT-IN declared long-lived holder — JSON.stringify drops it when
// undefined, so undeclaring callers write exactly the pre-2549 entry shape.
// `holderStartToken` (plan 4236 T3) is the declared holder's OS start-time token, recorded only
// alongside a declared holderPid — undefined is dropped by JSON.stringify exactly like holderPid.
export function tryCreate(
  lockPath,
  { token, label, nowIso, pid, host, holderPid, holderStartToken },
) {
  const created = tryCreateExclusive(
    lockPath,
    JSON.stringify({
      token,
      label,
      iso: nowIso,
      pid,
      host,
      holderPid,
      holderStartToken: holderPid != null ? holderStartToken : undefined,
    }),
  );
  return created ? token : undefined;
}

// Reap a stale lock via the shared excl-lock primitive (rename-then-unlink — see
// scripts/coord/excl-lock.mjs for why this closes the double-reap race). Returns true when this
// process performed the reap.
export function reapStale(lockPath, reaperTag) {
  return reapStaleExclusive(lockPath, reaperTag);
}

// Is this entry's DECLARED holder provably dead on THIS host? (plan 2549) The one exported
// staleness-beyond-age predicate — acquireOnce reaps on it, and push-queue-status.mjs classifies
// its 'stale'-vs-'held' report with it so the probe's verdict matches what the next acquire will
// actually do (review 2549 finding [1]: an age-only probe told sessions to wait on a lock the
// next acquire would reap instantly). Null-safe by construction: a corrupt entry (null), a
// foreign host, an undeclared holderPid (probe → null), and a live/unprovable probe are all
// `false` — only a same-host, declared, PROVABLY dead holder answers true.
export function holderProvedDead(entry, { host = hostname(), _pidAlive = pidAlive } = {}) {
  return entry != null && entry.host === host && _pidAlive(entry.holderPid) === false;
}

// May a caller's DECLARED holder pid be trusted enough to record? (plan 2734 — the enforcement half
// of the header's "never a false dead" precondition.) The declared holder is by construction the
// process waiting on this acquire subprocess, so it must be alive AT THIS MOMENT. A `false` probe
// therefore cannot mean "the holder died"; it means the pid is not the holder's pid — the classic
// cause being an MSYS-namespace `$$` on Windows, which every future caller can pass by accident.
//
// Only an explicit `false` (ESRCH: provably dead) refuses. `true` records normally, and `null`
// (unprovable — EPERM under another user, or a non-numeric pid) records too: null already degrades
// to the age gate at probe time, so refusing it here would buy nothing and would drop a legitimate
// declaration on a hardened host. Pure via the `_pidAlive` seam so both verdicts are unit-tested
// without spawning a process just to kill it.
export function holderPidTrustworthy(holderPid, { _pidAlive = pidAlive } = {}) {
  return _pidAlive(holderPid) !== false;
}

// Is this entry's declared holder PROVABLY the same live process that wrote it, and young enough
// that the hard ceiling has not yet been reached? (plan 4236 T3 — see HARD_STALE_MIN.) Only a
// same-host entry with a declared holderPid that probes ALIVE and whose recorded start-time token
// still matches answers true; every other shape (foreign host, undeclared, dead, unprovable,
// recycled, no recorded token, unreadable age, older than the ceiling) answers false, which leaves
// the entry to the ordinary age gate exactly as before. `_pidAlive` / `_startToken` are the test
// seams (no real process is spawned or killed to exercise either verdict).
export function holderProvedLive(
  entry,
  nowMs,
  {
    host = hostname(),
    hardStaleMin = HARD_STALE_MIN,
    _pidAlive = pidAlive,
    _startToken = processStartToken,
  } = {},
) {
  if (entry == null || entry.host !== host) return false;
  const age = ageMinutes(entry.iso, nowMs);
  if (age == null || age > hardStaleMin) return false;
  if (_pidAlive(entry.holderPid) !== true) return false;
  return (
    holderIdentity(
      { pid: entry.holderPid, startToken: entry.holderStartToken },
      { _startToken },
    ) === 'SAME'
  );
}

// --- progress-aware wait: the pure decision core (plan 2734) -----------------

// Seconds since the holder WROTE its entry. null when there is no entry or its `iso` is
// unparseable — callers must treat null as "no progress claim I can read", NEVER as 0: a 0 would
// read as a brand-new holder and make a waiter sit out a corrupt entry forever, when the reap path
// already owns that case.
//
// NOT built on landing-lock's shared ageMinutes, and that is deliberate (the first cut DID reuse it
// and a test caught this): ageMinutes returns WHOLE minutes via Math.round, so a holder 90s in reads
// as 2 minutes — 120s — and a 100s patience would declare a healthy 90s holder STUCK. Rounding UP
// toward "stuck" is the one direction this file must never round, since firing on healthy holders is
// the entire defect plan 2734 fixes. The null-on-unparseable and clamp-at-0 semantics are mirrored
// from ageMinutes exactly, so the two helpers still agree about what a bad timestamp means.
export function holderAgeSec(entry, nowMs) {
  if (entry == null) return null;
  const t = Date.parse(entry.iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (nowMs - t) / 1000);
}

// Has the CURRENT holder held past the point where a HEALTHY loaded battery (including plan 984's
// retry-once second attempt, which runs inside the same acquire) would have finished? That — not the
// waiter's own elapsed wait — is the give-up test, so a waiter gives up on a STUCK holder and never
// on a merely slow one. A null age is deliberately NOT stuck: an entry with no readable timestamp is
// already reapable through isStale, and classifying it here too would race that reap.
export function holderStuck(entry, nowMs, patienceSec = HOLDER_PATIENCE_SEC) {
  const age = holderAgeSec(entry, nowMs);
  return age != null && age > patienceSec;
}

// The two-phase wait policy as ONE pure function (the acquireOnce precedent: decide here, do the fs
// in the caller), so the whole admission policy is unit-testable with no fs, no clock and no real
// holder. Called only when tier 1 is BUSY.
//   'WAIT'          — poll again; nothing has changed phase.
//   'ADMIT-STUCK'   — the holder is stuck: enter the admission phase (prefer tier 1, else overflow).
//   'ADMIT-CEILING' — the anti-hang total-wait ceiling expired: same admission phase.
//   'UNADMITTED'    — already in admission and its window expired: run clamped with NO slot.
// `admissionStartedMs` doubles as the phase flag (null ⇒ still serialized), so there is exactly one
// piece of loop state and no way for a phase and a timer to disagree.
export function decideWaitStep({
  entry,
  nowMs,
  waitStartedMs,
  admissionStartedMs = null,
  patienceSec = HOLDER_PATIENCE_SEC,
  maxTotalWaitSec = MAX_TOTAL_WAIT_SEC,
  admissionWaitSec = ADMISSION_WAIT_SEC,
}) {
  if (admissionStartedMs != null)
    return nowMs - admissionStartedMs > admissionWaitSec * 1000 ? 'UNADMITTED' : 'WAIT';
  if (holderStuck(entry, nowMs, patienceSec)) return 'ADMIT-STUCK';
  if (nowMs - waitStartedMs > maxTotalWaitSec * 1000) return 'ADMIT-CEILING';
  return 'WAIT';
}

// The admission window a waiter actually gets: never longer than its own total-wait ceiling. Plan
// 1679's size-gated `--timeout-sec 30` (a ≤5-file selection, explicitly NOT the load problem) must
// not inherit the full 300s admission window and turn a 30s wait into a 330s one — a push unwilling
// to wait long for the lock is not asked to wait long for admission either.
//
// Applied to the RESOLVED value, not only to the default (plan-2734 review finding, 2026-08-02: "an
// explicit admission wait bypasses the documented clamp to the total-wait ceiling" — `--timeout-sec
// 30 --admission-wait-sec 300` really did wait ~330s). The clamp is the rule, so an explicit flag is
// clamped too; a caller wanting a longer admission window must raise the ceiling that bounds it,
// which keeps "your total wait is bounded by --timeout-sec plus one admission window" true no matter
// how the flags are combined.
export function effectiveAdmissionWaitSec(maxTotalWaitSec, admissionWaitSec = ADMISSION_WAIT_SEC) {
  return Math.min(admissionWaitSec, maxTotalWaitSec);
}

// One acquire attempt against an already-read world. Pure decision, fs effects delegated.
// Returns { action: 'ACQUIRED', token } | { action: 'BUSY', entry }
//       | { action: 'REAPED', entry, reason: 'dead-pid' | 'age' | 'released' }.
export function acquireOnce(
  lockPath,
  {
    token,
    label,
    nowMs,
    pid,
    host,
    holderPid,
    holderStartToken,
    staleMin = DEFAULT_STALE_MIN,
    hardStaleMin = HARD_STALE_MIN,
    _tryCreate = tryCreate,
    _readEntry = readEntry,
    _reapStale = reapStale,
    _pidAlive = pidAlive,
    _startToken = processStartToken,
  },
) {
  const created = _tryCreate(lockPath, {
    token,
    label,
    nowIso: new Date(nowMs).toISOString(),
    pid,
    host,
    holderPid,
    holderStartToken,
  });
  if (created) return { action: 'ACQUIRED', token: created };

  const entry = _readEntry(lockPath);
  // Released between create and read — retry. Nothing was reaped BY THIS CALL and there is no
  // holder to name, so the reason is its own value, not a fake 'age'.
  if (entry === undefined) return { action: 'REAPED', entry: null, reason: 'released' };
  // The dead-holder proof is checked BEFORE the age gate — a dead-holder orphan reaps regardless
  // of how fresh its age is. holderProvedDead targets ONLY the entry's DECLARED holderPid, never
  // entry.pid (the acquirer's pid — dead in normal operation; see the header), is null-safe for a
  // corrupt entry (which then falls to isStale's own null-is-reapable rule, the pre-2549
  // behaviour), and never probes a foreign host's pid.
  // plan 4236 T3: an age-stale entry whose declared holder is provably the same live process
  // (identity-checked, under HARD_STALE_MIN) is NOT reaped — see HARD_STALE_MIN. Checked only once
  // the age gate would fire, so a fresh entry never pays for the identity probe.
  const reason = holderProvedDead(entry, { host, _pidAlive })
    ? 'dead-pid'
    : isStale(entry, nowMs, staleMin) &&
        !holderProvedLive(entry, nowMs, { host, hardStaleMin, _pidAlive, _startToken })
      ? 'age'
      : null;
  if (reason) {
    _reapStale(lockPath, `${pid}-${token.slice(0, 8)}`);
    return { action: 'REAPED', entry, reason };
  }
  return { action: 'BUSY', entry };
}

// Release ONLY our own entry. A token mismatch is a NOOP, not an error: after a TIMEOUT the caller
// holds no token, and a stale-reaped lock may since have been re-acquired by someone else.
// Built on the shared releaseOwned (excl-lock.mjs): the predicate captures the parsed entry so the
// CLI's FOREIGN diagnostic can still name the actual holder.
export function releaseAt(lockPath, { token, force = false }) {
  let entry;
  const result = releaseOwned(lockPath, (text) => {
    entry = parseEntry(text);
    return force || (entry != null && entry.token === token);
  });
  if (result === 'NOOP') return { action: 'NOOP' };
  if (result === 'FOREIGN') return { action: 'FOREIGN', entry };
  return { action: 'RELEASED' };
}

// --- lock path resolution ---------------------------------------------------

// The SHARED `.git` common dir, resolved from cwd with git's own env scrubbed (`lock-path.mjs`).
// Scrubbing matters: this runs inside a git hook, where GIT_DIR / GIT_INDEX_FILE are exported into
// every child and can point at a worktree gitdir mid-operation. Resolving from cwd is deterministic
// and still yields the one common dir every worktree of the clone shares.
// `_path` is a TEST SEAM, not configuration (plan 2503, restoring plan 2501's never-landed fix;
// mirrors the plan-2489 fix to the sibling in lock-path.test.mjs). Without it a fixture that feeds
// a drive-less POSIX anchor like `/somewhere/.git` runs through the PLATFORM-NATIVE path module,
// and win32.resolve drive-relativizes it to `C:/somewhere/.git` — so the assertion could only ever
// hold on Linux. That is what red-ed master for every Windows push on 2026-07-26. Forward it to
// resolveCommonDirPath (which already accepts it) AND use it for the final join, or the seam only
// covers half the computation.
// `tier` (plan 2734) selects which of the two lock files this is — see LOCK_TIERS. An unknown tier
// THROWS rather than defaulting: a typo silently resolving to the serialized lock would let an
// overflow acquire contend on tier 1 and quietly delete the admission control. Throwing lands on
// EXIT_ERROR, i.e. the battery runs unserialized at full parallelism — loud, and the fail-safe
// direction this file already documents for every other bad flag.
export function resolveLockPath({
  tier = 'serialized',
  _exec = execFileSync,
  _path = nodePath,
} = {}) {
  const filename = Object.prototype.hasOwnProperty.call(LOCK_TIERS, tier) ? LOCK_TIERS[tier] : null;
  if (!filename)
    throw new Error(
      `unknown lock tier ${JSON.stringify(tier)} — expected one of ${Object.keys(LOCK_TIERS).join(', ')}`,
    );
  return _path.join(resolveCommonDirPath({ anchor: process.cwd(), _exec, _path }), filename);
}

// Both tiers' paths from ONE common-dir resolution (plan-2734 review finding, 2026-08-02: calling
// resolveLockPath per tier spawned a synchronous `git rev-parse --git-common-dir` per tier, on every
// acquire/status/release — repeated process spawns on the exact push path this plan exists to make
// cheaper, and on Windows a process spawn is the expensive operation, see the plan-2530 note in the
// hook). The tier→filename mapping stays in LOCK_TIERS, so there is still one source of truth.
export function resolveTierPaths({ _exec = execFileSync, _path = nodePath } = {}) {
  const dir = resolveCommonDirPath({ anchor: process.cwd(), _exec, _path });
  return Object.freeze(
    Object.fromEntries(
      Object.entries(LOCK_TIERS).map(([tier, filename]) => [tier, _path.join(dir, filename)]),
    ),
  );
}

// --- CLI --------------------------------------------------------------------

export function main() {
  const { cmd, flags } = parseLockArgs(process.argv.slice(2), BATTERY_ARG_SPEC);
  if (!cmd) {
    console.error('battery-lock: no command (acquire|release|status|path)');
    return EXIT_ERROR;
  }
  // `--tier` addresses ONE lock file and is therefore meaningful only for `path`. `acquire` chooses
  // its tier by POLICY (serialized first, overflow only through admission — that is the whole design),
  // and `status`/`release` deliberately cover both tiers. Accepting the flag there and ignoring it
  // would be a silent footgun: `acquire --tier overflow` would hand back the SERIALIZED lock and run
  // at full parallelism, bypassing the admission control it looks like it is requesting (second
  // review round). Refuse it loudly instead — an unusable flag must not read as an honoured one.
  const tierFlag = assertFlagValue(flags.tier, 'tier') ?? 'serialized';
  if (flags.tier != null && cmd !== 'path')
    throw new Error(
      `--tier is only valid for \`path\` (got \`${cmd}\`): acquire picks its tier by policy ` +
        '(serialized, then the overflow slot via admission), and status/release cover both tiers',
    );
  if (cmd === 'path') {
    console.log(resolveLockPath({ tier: tierFlag }));
    return 0;
  }
  if (cmd === 'status') {
    // Both tiers, one line each (plan 2734) — a report naming only the serialized lock would say
    // "free" on a machine running an admitted overflow battery, the same blind spot in
    // push-queue-status.mjs that let `0/2 held` read as quiet during the 2026-08-02 storm.
    const now = Date.now();
    const paths = resolveTierPaths();
    for (const [tier, lockPath] of Object.entries(paths)) {
      const entry = readEntry(lockPath);
      console.log(`${tier}: ${entry === undefined ? 'free' : `held ${describeEntry(entry, now)}`}`);
    }
    return 0;
  }
  if (cmd === 'release') {
    const token = assertFlagValue(flags.token, 'token');
    const force = flags.force === true;
    // BOTH tiers are probed (plan 2734). The caller — scripts/hooks/pre-push.sh — receives an
    // OPAQUE token on stdout and cannot know which tier granted it (exit 0 = serialized, exit 4
    // with a token = overflow), so making it name the tier would either leak the tier model into
    // the hook or need a second release call site. A token MISMATCH is already a documented NOOP,
    // so probing both files can never release someone else's lock. First match wins and stops.
    // `--force` (the emergency "clear the battery locks" hatch) deliberately sweeps BOTH tiers
    // rather than stopping at the first: a wedged machine wants both gone.
    let released = 0;
    let foreign = null;
    for (const [tier, lockPath] of Object.entries(resolveTierPaths())) {
      const r = releaseAt(lockPath, { token, force });
      if (r.action === 'RELEASED') {
        released++;
        console.error(`battery-lock: released (${tier})`);
        if (!force) break;
      } else if (r.action === 'FOREIGN' && foreign == null) {
        foreign = tier;
      }
    }
    if (released === 0)
      console.error(
        foreign
          ? `battery-lock: NOT releasing — the ${foreign} lock is held by another battery (token mismatch)`
          : 'battery-lock: free (nothing to release)',
      );
    return 0; // close-out must never block a push
  }
  if (cmd !== 'acquire') {
    console.error(`battery-lock: unknown command "${cmd}"`);
    return EXIT_ERROR;
  }

  const label = assertFlagValue(flags.label, 'label') ?? 'battery';
  // The DECLARED long-lived holder (plan 2549) — optional; see the header for why this is a
  // separate opt-in field and why it must be a WINDOWS pid on MSYS. ONE check owns the whole
  // valid-pid contract (review 2549 finding [4]: a numericFlag pass in front left the specific
  // message unreachable for most invalid inputs). `Number('')`/`Number('   ')` are 0 → rejected
  // by the same predicate, no blank-string special case needed. A malformed value throws →
  // EXIT_ERROR → the hook runs the battery unserialized (the fail-safe direction), loudly.
  let holderPid;
  if (flags['holder-pid'] != null) {
    const n = Number(flags['holder-pid']);
    if (!Number.isInteger(n) || n <= 0)
      throw new Error(
        `--holder-pid must be a positive integer, got ${JSON.stringify(flags['holder-pid'])}`,
      );
    holderPid = n;
    // SELF-CHECK the declaration (plan 2734) — see the header's "never a false dead" paragraph. The
    // declared holder is blocked waiting on THIS subprocess, so a provably-dead probe right now
    // proves the PID WRONG, not the holder dead. Recording it anyway would make the very next
    // waiter reap a live holder's lock and resurrect the herd this file exists to prevent. Degrade
    // to age-only instead, loudly. Never throws: a bad declaration must not fail a push, and
    // age-only staleness is a complete, previously-shipped behaviour (pre-2549).
    if (!holderPidTrustworthy(holderPid)) {
      console.error(
        `battery-lock: IGNORING --holder-pid ${holderPid} — it is already provably dead, which is ` +
          'impossible for the process waiting on this acquire, so the pid is wrong rather than the ' +
          'holder gone. Most likely cause: an MSYS-namespace pid (a raw `$$` from Git Bash) where a ' +
          'WINDOWS pid is required — read `/proc/$$/winpid`, and if that fails DECLARE NOTHING ' +
          'rather than falling back to `$$` (an untranslated pid can collide with a live unrelated ' +
          'Windows process, pass this very check, and get the lock reaped when that stranger exits). ' +
          'scripts/hooks/pre-push.sh does exactly that. Falling back to AGE-ONLY staleness for this lock ' +
          '(safe, and exactly the pre-plan-2549 behaviour); the dead-holder fast reap will not fire.',
      );
      holderPid = undefined;
    }
  }
  // plan 4236 T3: the declared holder's start-time identity, read ONCE per acquire (a Windows read
  // is a PowerShell spawn) and recorded beside holderPid. null (unprovable) records nothing, and
  // the entry then keeps the plain age gate.
  const holderStartToken =
    holderPid != null ? (processStartToken(holderPid) ?? undefined) : undefined;
  const staleMin = numericFlag(flags['stale-min'], DEFAULT_STALE_MIN, 'stale-min');
  // `--timeout-sec` KEEPS its name and its one hook call site (plan 1679's size-gated short wait for
  // a ≤5-file selection) but its meaning changed with plan 2734: it is the anti-hang TOTAL-wait
  // ceiling, not the flat give-up timer. The give-up test is now the holder's own age
  // (--holder-patience-sec). Renaming the flag would have churned the hook literal that
  // battery-lock.test.mjs derives from the hook text for no behavioural gain.
  const maxTotalWaitSec = numericFlag(flags['timeout-sec'], MAX_TOTAL_WAIT_SEC, 'timeout-sec');
  const patienceSec = numericFlag(
    flags['holder-patience-sec'],
    HOLDER_PATIENCE_SEC,
    'holder-patience-sec',
  );
  // effectiveAdmissionWaitSec wraps the RESOLVED value (see its own comment): the ceiling clamp is
  // the rule, so an explicit --admission-wait-sec is clamped exactly like the default.
  const admissionWaitSec = effectiveAdmissionWaitSec(
    maxTotalWaitSec,
    numericFlag(flags['admission-wait-sec'], ADMISSION_WAIT_SEC, 'admission-wait-sec'),
  );
  // `--poll-sec 0` passes numericFlag (0 is a legitimate value for --stale-min, so the shared helper
  // cannot reject it) and turns the wait into a BUSY-SPIN: sleepSync(0) returns immediately, so a
  // blocked acquire hammers the filesystem for its whole ceiling — burning the CPU this lock exists
  // to protect, on the machine it exists to protect it on (second review round). Floor it loudly.
  const pollSec = numericFlag(flags['poll-sec'], DEFAULT_POLL_SEC, 'poll-sec');
  if (pollSec <= 0)
    throw new Error('--poll-sec must be greater than 0 (a 0 poll busy-spins the queue wait)');
  const tierPath = resolveTierPaths();
  const token = randomUUID();
  const host = hostname();
  const waitStarted = Date.now();
  // The ONE piece of phase state: null ⇒ still in the serialized wait; a timestamp ⇒ in admission
  // (see decideWaitStep, which uses it as both flag and timer so the two can never disagree).
  let admissionStarted = null;
  let announcedWait = false;
  // A reap→retry cycle does not sleep, so it needs its own bound: an fs that refuses both the
  // create and the reap (permissions, a directory at the lock path) would otherwise spin forever.
  let reaps = 0;
  const waitedSec = (nowMs) => Math.round((nowMs - waitStarted) / 1000);
  const tryTier = (tier) =>
    acquireOnce(tierPath[tier], {
      token,
      label,
      nowMs: Date.now(),
      pid: process.pid,
      host,
      holderPid,
      holderStartToken,
      staleMin,
    });
  const announceReap = (r) =>
    console.error(
      r.entry
        ? `battery-lock: reaped ${describeEntry(r.entry, Date.now())} — reason: ${r.reason} — retrying`
        : 'battery-lock: reaped a stale/abandoned lock — retrying',
    );

  for (;;) {
    // Tier 1 is attempted FIRST on every single poll, admission phase included: a waiter that has
    // already given up on the current holder still prefers full parallelism the moment the
    // serialized lock frees. Admission never downgrades a waiter that could have run serialized.
    const r = tryTier('serialized');
    if (r.action === 'ACQUIRED') {
      console.log(r.token); // stdout is the token, and ONLY the token — the hook captures it
      return 0;
    }
    if (r.action === 'REAPED') {
      if (++reaps > 10) {
        // Reap exhaustion is an fs anomaly, NOT saturation — unchanged from plan 1795, including
        // its accepted over-clamp (this path exits 4, so the caller clamps parallelism it did not
        // need). It deliberately does NOT enter admission: an fs that refuses both create and reap
        // would refuse the overflow file too, so waiting for a slot would just burn the window.
        console.error(
          'battery-lock: cannot take the lock after repeated reaps — proceeding UNSERIALIZED',
        );
        return EXIT_TIMEOUT;
      }
      announceReap(r);
      continue;
    }

    // Tier 1 BUSY. In the admission phase, the single overflow slot is the fallback.
    if (admissionStarted != null) {
      const o = tryTier('overflow');
      if (o.action === 'ACQUIRED') {
        console.log(o.token); // an overflow token: `release --token` finds it in either tier
        console.error(
          `battery-lock: ADMITTED to the overflow slot after ${waitedSec(Date.now())}s — the caller ` +
            `must run the battery at REDUCED parallelism (--test-concurrency=${OVERFLOW_TEST_CONCURRENCY}); ` +
            'holding this slot is what keeps a second timed-out waiter from joining it.',
        );
        return EXIT_TIMEOUT;
      }
      if (o.action === 'REAPED') {
        if (++reaps > 10) {
          console.error(
            'battery-lock: cannot take the overflow slot after repeated reaps — proceeding UNSERIALIZED',
          );
          return EXIT_TIMEOUT;
        }
        announceReap(o);
        continue;
      }
    }

    const step = decideWaitStep({
      entry: r.entry,
      nowMs: Date.now(),
      waitStartedMs: waitStarted,
      admissionStartedMs: admissionStarted,
      patienceSec,
      maxTotalWaitSec,
      admissionWaitSec,
    });
    if (step === 'ADMIT-STUCK' || step === 'ADMIT-CEILING') {
      admissionStarted = Date.now();
      console.error(
        step === 'ADMIT-STUCK'
          ? `battery-lock: holder ${describeEntry(r.entry, admissionStarted)} has held past ${patienceSec}s ` +
              `(a healthy loaded battery, retry-once included, finishes inside that) — treating it as STUCK and ` +
              `entering the ${admissionWaitSec}s admission phase: tier 1 if it frees, else the single overflow slot.`
          : `battery-lock: total-wait ceiling ${maxTotalWaitSec}s reached while the queue kept moving ` +
              `(anti-hang backstop, not the holder's fault) — entering the ${admissionWaitSec}s admission phase.`,
      );
      continue; // re-attempt tier 1, then the overflow slot, before sleeping again
    }
    if (step === 'UNADMITTED') {
      console.error(
        `battery-lock: TIMEOUT after ${waitedSec(Date.now())}s — serialized lock busy and the overflow slot ` +
          `taken for the whole ${admissionWaitSec}s admission window. The caller must run the battery ` +
          `UNSERIALIZED at REDUCED parallelism (--test-concurrency=${OVERFLOW_TEST_CONCURRENCY}; ` +
          'serialization is load-shedding, never a test-skip).',
      );
      return EXIT_TIMEOUT;
    }
    if (!announcedWait) {
      console.error(
        `battery-lock: queued behind ${describeEntry(r.entry, Date.now())} — waiting while it makes progress ` +
          `(give up only once one holder passes ${patienceSec}s, or after ${maxTotalWaitSec}s total)`,
      );
      announcedWait = true;
    }
    sleepSync(pollSec * 1000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    console.error('battery-lock:', e.message);
    process.exit(EXIT_ERROR);
  }
}
