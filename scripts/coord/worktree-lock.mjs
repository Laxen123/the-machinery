#!/usr/bin/env node
// scripts/coord/worktree-lock.mjs — a WORKTREE-SCOPED ownership handshake between the detached
// land-prep child and the head-time land (plan 2473).
//
// WHY THIS EXISTS. Plan 972's `--prep` keep-hot pass rebases the worktree branch and
// `push --force-with-lease`es it; so does the head-time land (`syncBranchOntoMaster`). Both
// operate on the SAME working tree. Plan 2458 prototyped a spine-side prep dispatch and
// REMOVED it before landing, because two review rounds found the same hazard from three
// directions: a detached prep races the merge (the land's poll loop keeps running after the
// child is spawned, so it can reach position 1 while the child is mid-rebase), and even
// dispatching only at the QUEUE_WAIT seam-out does not help (the session re-invokes
// `done-worktree` while the previous invocation's child may still be running). Two concurrent
// `git rebase` / `git push --force-with-lease` runs against one working tree risk an
// index.lock collision, corrupted rebase state, or one force-push silently losing to the
// other — a worktree needing manual recovery, in a repo with 5-7 concurrent sessions.
//
// The seed `landing-lock` does NOT cover this: that is a cross-worktree, cross-shard mutex on
// who may merge seed data. This is a same-worktree, two-process overlap — a different axis
// entirely, and the two are held concurrently by design.
//
// THE MODEL — single-holder, token-owned, PID-proved.
//   * Single holder per worktree (keyed by land slug — slug↔worktree is 1:1 via
//     `worktree-<slug>`), so `prep` and `land` arbitrate on one file.
//   * Token ownership: `release(token)` unlinks ONLY when the token matches, so a process
//     that timed out waiting (and never held the lock) can never release the holder's lock.
//     Same contract as `battery-lock.mjs`.
//   * Staleness is PID-PROVED FIRST, age-bounded second — deliberately unlike battery-lock /
//     landing-lock, which are age-only. Those two guard operations whose holder may legitimately
//     be a short-lived child of an unrelated process; here the holder is ALWAYS a live, long-lived
//     process on THIS machine that wrote its own pid, so `kill(pid, 0)` is a real proof of death
//     and beats any age heuristic (a crashed prep is reapable in milliseconds instead of after a
//     ceiling sized for the ~15-27 min gate battery). Age remains as the second gate for a holder
//     that is alive but wedged, and as the ONLY gate when the record is from another host.
//     This mirrors `clear-stale-worktree-lock.mjs`'s rule: never remove a lock a live op holds.
//
// RENDEZVOUS: the SHARED `.git` common dir (`git rev-parse --git-common-dir`), the property
// `landing-lock.mjs` / `battery-lock.mjs` already rely on — every worktree of the one clone sees
// the one file, and it is never git-tracked nor swept by `git clean -fdx`. Deliberately NOT
// `MAIN/.scratch` beside the land-prep marker it guards: a swept lock is a LOST lock, i.e. exactly
// the two-process overlap this module exists to prevent, whereas a swept marker only costs a
// fast path.
//
// The file-level O_EXCL create/reap/release mechanism is `excl-lock.mjs`'s (plan 1678) — this
// module contributes the identity model (pid-proved staleness, prep-vs-land owner kinds) and the
// preemption verb, never a second copy of the primitive.

import { readFileSync, openSync, writeSync, ftruncateSync, closeSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveCommonDirPath } from './lock-path.mjs';
// plan 2738: the `/proc/<pid>/stat` reader kill-tree.mjs already owns (see processStartToken).
// Deliberately reused rather than re-rolled — this repo has one parsing convention for that file
// and a second copy is exactly the drift excl-lock/atomic-write were extracted to stop.
import { procStatFields } from './kill-tree.mjs';
import {
  tryCreateExclusive,
  readExclusive,
  reapStaleExclusive,
  releaseOwned,
} from './excl-lock.mjs';

// A holder that has not renewed its heartbeat in this long is treated as wedged and reaped even
// though its pid is still alive. Sized ABOVE the worst-case thing it guards — the `--prep` pass is
// a rebase + the full ~28-gate pre-push battery, quantified at ~15-27 min in
// `land-lib.mjs`'s plan-2433 comment — so a merely SLOW prep is never falsely reaped (the
// battery-lock header's "the reap ceiling MUST exceed the worst-case runtime of the thing it
// guards" rule, applied here). The head-side bounded wait (`done-worktree.mjs`) is what stops a
// wedged holder from actually costing 40 minutes: it preempts long before this ceiling.
export const WORKTREE_LOCK_MAX_HOLD_MS = 40 * 60 * 1000;

// Renewal cadence the holder aims for. Since plan 4034 T1 `done-worktree.mjs` IS that holder: it
// arms one process-wide `setInterval` at this cadence over every lock it holds, so a lock now
// renews DURING a gate and not only between gates. The heavy gates all spawn asynchronously and
// `await`, so the event loop is free for the minutes they run; a holder that blocks it in a
// synchronous `execFileSync` git call (which `runLandPrep` does, for a minute or two at a time)
// simply pauses the timer, which the 40-minute ceiling absorbs. That is still why pid-liveness and
// not the heartbeat is the PRIMARY staleness proof — a paused timer must never read as a dead
// holder, and a genuinely wedged parent stops renewing and is reaped by the ceiling as before.
//
// Until 4034 no holder read this constant at all, and the flat 2400s land-gate caps were the
// consequence: with nothing renewing, the ceiling bounded the SUM of a land's pre-enqueue gates,
// so a ~45-minute pytest suite was killed at 99% (plan 3982, 2026-09-14).
export const WORKTREE_LOCK_RENEW_MS = 30 * 1000;

export function worktreeLockPath(commonDirAbs, slug) {
  return join(commonDirAbs, `worktree-lock-${slug}.json`);
}

// Resolve the shared `.git` common dir from `cwd`, with git's own env scrubbed (`lock-path.mjs`) —
// the same reasoning as battery-lock's `resolveLockPath`: this can run under a git hook, where
// GIT_DIR / GIT_INDEX_FILE are exported into every child and may point at a worktree gitdir
// mid-operation.
export function resolveWorktreeLockPath(cwd, slug, { _exec = execFileSync } = {}) {
  return worktreeLockPath(resolveCommonDirPath({ anchor: cwd, _exec }), slug);
}

// Is `pid` a live process? `kill(pid, 0)` sends no signal and only probes existence.
// EPERM means it EXISTS but belongs to another user — alive, not reapable. ONLY a clean ESRCH
// proves death; any OTHER error code is treated as alive, not dead (review 2549 finding [2]:
// this predicate became reap-load-bearing for battery-lock's dead-holder reap, whose safety
// argument is "a probe can never produce a false DEAD" — an exotic process.kill error shape
// under a sandboxed/restricted context must therefore fail toward ALIVE, where the age ceiling
// still bounds the damage, never toward an early reap of a live holder). A non-numeric/absent
// pid is unprovable → `null`, which every caller treats as "cannot prove death" (age gate).
//
// WHAT IT CANNOT PROVE (plan 2738). `kill(pid, 0)` proves that SOME process currently owns that
// pid NUMBER — never that it is still OUR holder. The OS recycles pids, so a crashed holder whose
// number has been reassigned probes ALIVE forever. See `processStartToken` below for the identity
// half this predicate structurally cannot supply.
export function pidAlive(pid, { _kill = process.kill } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    _kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'ESRCH' ? false : true;
  }
}

// ── plan 2738: PID RECYCLING — the hole that pinned keep-hot off for 36 minutes ───────────────
//
// THE INCIDENT (2026-08-02, plan 2718's land). Every keep-hot `--prep` for ~36 min exited BUSY
// against a lock whose holder — pid 50384 — was ALREADY DEAD (verified against the live process
// table). `worktreeLockVerdict` returns STALE only on `alive === false` OR `age > maxHoldMs`; the
// wait was 36 min against a 40-min ceiling, so the age gate never fired, and `pidAlive(50384)` did
// not return false. `pidAlive` returns false ONLY on a clean ESRCH — so the pid number was still
// owned by SOMETHING. That is pid recycling, a documented failure mode on this host: the
// terminal-tab-light work measured 119 pids probing "alive" for 12 real sessions, i.e. a merely-
// alive pid here is USUALLY a recycled one. Existence is not identity.
//
// THE FIX — a start-time token, captured from the SAME source on both sides. The holder records
// the OS's own start-time for its pid at acquire; a prober re-reads the start-time for that pid
// and compares. A recycled pid necessarily started LATER than the record, so the strings differ
// and the holder is provably dead — reapable in one poll instead of after the 40-min ceiling.
// Comparing two readings of the SAME OS field (never a locally-computed
// `Date.now() - process.uptime()`) is what makes an exact string compare correct.
//
// WHY NOT just shorten the ceiling (the plan's other candidate lever). 40 min is DERIVED: a prep
// is a rebase plus the ~15-27 min gate battery, and battery-lock's own header pins the rule that a
// reap ceiling must exceed the worst case of the thing it guards. Shortening it would falsely reap
// slow-but-healthy preps — trading a rare wedge for a routine corruption risk. The ceiling stays;
// identity is the correct lever.
//
// COST + FAIL DIRECTION. One short subprocess, and only where it changes an answer: callers probe
// identity ONLY when the cheap `kill(pid,0)` already said ALIVE on a SAME-HOST record (a dead or
// foreign holder is already decided). Any failure — no such process, an access-denied read, a
// legacy lock written before this field existed, a platform whose query we cannot parse — returns
// null / 'UNPROVEN' and falls back verbatim to the pre-2738 pid+age behaviour. The probe can
// therefore never manufacture a false STALE, which is the safety property the whole module rests on.
export const PROCESS_START_TOKEN_TIMEOUT_MS = 10_000;

// The OS-reported start time of `pid`, as an opaque string to be compared only against another
// reading of this same function. null = unprovable (no such process, query failed, unparseable).
//
// win32 uses PowerShell's `Get-Process` rather than `tasklist`: tasklist intermittently returns an
// empty result under this repo's sandboxed shells (a known false "process exited" on this machine),
// and a probe that silently reads "gone" is exactly the false-DEAD this module may never produce.
// `windowsHide` keeps the spawn from flashing a console window on the operator's desktop.
export function processStartToken(
  pid,
  {
    _platform = process.platform,
    _exec = execFileSync,
    _procStatFields = procStatFields,
    timeoutMs = PROCESS_START_TOKEN_TIMEOUT_MS,
  } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (_platform !== 'win32') {
      // LINUX FIRST, via kill-tree.mjs's existing `/proc/<pid>/stat` reader (review findings: both
      // that a second `ps` spawn was needless, and that `ps -o lstart=` resolves only to the SECOND
      // — a pid recycled inside the same second yields an identical token and reads as SAME, which
      // is the exact false-alive this whole mechanism exists to remove). Field 22, `starttime`, is
      // in clock ticks since boot: far finer than a second, and free — no subprocess at all. The
      // cloud drains run Linux, so this is the common POSIX path, not an exotic one.
      // procStatFields slices off `pid` and `comm`, so /proc field N is index N-3 ⇒ 22 → 19.
      const fields = _procStatFields(pid);
      if (fields && fields[19] != null && String(fields[19]).trim())
        return String(fields[19]).trim();
      // macOS/BSD (no /proc): `ps -o lstart=` is the portable ABSOLUTE start time. Its one-second
      // resolution leaves a same-second recycle unprovable — which reads as UNPROVEN and falls back
      // to the pre-2738 pid+age gates, i.e. degrades to today's behaviour rather than to a wrong
      // answer. (`etimes` would be worse than useless here: being relative, two readings of ONE live
      // process differ, so a healthy holder would read as RECYCLED.)
      const out = _exec('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: timeoutMs,
      });
      const token = String(out ?? '').trim();
      return token ? token : null;
    }
    const out = _exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToFileTimeUtc() }`,
      ],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
    );
    // A FileTime is 100-nanosecond ticks, so a same-second recycle is fully distinguishable here.
    const token = String(out ?? '').trim();
    return token ? token : null;
  } catch {
    return null;
  }
}

// This process's own token, memoised: our start time cannot change, and acquire runs inside poll
// loops (done-worktree's `acquireWorktreeBeforePreflight`) where a per-attempt subprocess would be
// pure waste. A null (unprovable) result is cached too — a query that failed once for this process
// will keep failing, and re-paying for it every attempt buys nothing.
let _selfStartToken;
export function selfStartToken({ _startToken = processStartToken, pid = process.pid } = {}) {
  if (_selfStartToken === undefined) _selfStartToken = _startToken(pid);
  return _selfStartToken;
}

// PURE-ish identity check for a lock record's holder:
//   'SAME'      — the pid's start time still matches what the holder recorded ⇒ genuinely our holder.
//   'RECYCLED'  — it differs ⇒ the recorded holder is DEAD and its number was reassigned.
//   'UNPROVEN'  — no recorded token (a lock written by a pre-2738 checkout), no readable current
//                 token, or an unusable pid. Callers fall back to the pid+age gates.
export function holderIdentity(entry, { _startToken = processStartToken } = {}) {
  if (!entry || typeof entry.startToken !== 'string' || !entry.startToken) return 'UNPROVEN';
  if (!Number.isInteger(entry.pid) || entry.pid <= 0) return 'UNPROVEN';
  const current = _startToken(entry.pid);
  if (!current) return 'UNPROVEN';
  return current === entry.startToken ? 'SAME' : 'RECYCLED';
}

export function parseWorktreeLockEntry(text) {
  if (text === undefined) return undefined;
  try {
    const o = JSON.parse(text);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null; // present but unparseable — CORRUPT, see the verdict below
  }
}

// PURE. Classify the current holder:
//   'FREE'    — nothing holds it.
//   'CORRUPT' — present but not a JSON object; reapable (nobody can prove ownership of garbage).
//   'STALE'   — provably reapable: the holder's pid is dead, its pid was RECYCLED (plan 2738), or
//               it has not renewed in maxHoldMs.
//   'LIVE'    — a real process is working in this worktree; NEVER reap it.
// `alive` is the caller's pid probe result (true / false / null = unprovable, e.g. the record
// came from another host, where a local pid number means nothing). `identity` is the caller's
// start-time cross-check (`holderIdentity`) — 'UNPROVEN' by default, which reproduces the exact
// pre-2738 behaviour, so every existing caller and lock file keeps its meaning.
export function worktreeLockVerdict(
  entry,
  { nowMs, maxHoldMs = WORKTREE_LOCK_MAX_HOLD_MS, alive, identity = 'UNPROVEN' },
) {
  if (entry === undefined) return 'FREE';
  if (!entry) return 'CORRUPT';
  if (alive === false) return 'STALE'; // pid-proved death — the crash case, reapable immediately
  // plan 2738: the pid number is alive but belongs to a DIFFERENT process than the one that took
  // this lock — the holder crashed and the OS reassigned its number. Same proof strength as an
  // ESRCH, so it reaps on the same arm rather than waiting out the 40-min ceiling.
  if (identity === 'RECYCLED') return 'STALE';
  const stampIso = entry.heartbeatIso || entry.startedIso;
  const age = stampIso ? nowMs - Date.parse(stampIso) : NaN;
  if (!Number.isFinite(age)) return 'LIVE'; // unreadable stamp + no death proof → fail CLOSED
  return age > maxHoldMs ? 'STALE' : 'LIVE';
}

// The ONE holder-classification path (plan 2738). `acquireWorktreeLock` and `worktreeLockIsLive`
// both route through it, so the acquire-side and read-only verdicts can never disagree about who
// owns a worktree — the property `worktreeLockIsLive`'s own header already promises, now with a
// third input (identity) that would have been easy to add to one side only.
//
// The two probes are ORDERED, not both-always: only a SAME-HOST record has a meaningful local pid,
// and identity is asked ONLY when the cheap probe already said ALIVE — a dead or foreign holder is
// decided without paying for a subprocess.
function classifyHolder(
  entry,
  { nowMs, maxHoldMs, host, _pidAlive = pidAlive, _holderIdentity = holderIdentity },
) {
  const sameHost = Boolean(entry && entry.host === host);
  const alive = sameHost ? _pidAlive(entry.pid) : null;
  // CHEAP GATES FIRST, and only then the subprocess (review finding). Everything except a LIVE
  // verdict is already decided by `kill(pid,0)` and the age stamp — FREE, CORRUPT, a pid-proved
  // death, a foreign host, a holder past the ceiling — and identity cannot change any of them.
  // Probing before this check spent a PowerShell/`ps` spawn (up to the 10 s timeout) on locks the
  // age rule had already condemned, once per poll of done-worktree's pre-preflight wait loop.
  const cheap = worktreeLockVerdict(entry, { nowMs, maxHoldMs, alive });
  if (cheap !== 'LIVE' || alive !== true) return cheap;
  return worktreeLockVerdict(entry, { nowMs, maxHoldMs, alive, identity: _holderIdentity(entry) });
}

// Try to take the lock. Reaps a FREE/STALE/CORRUPT holder and retries ONCE (a losing reaper's
// second create legitimately fails against the winner's fresh lock — that is a refusal, not an
// error). Returns:
//   { ok: true,  token, reaped }     — held by us; pass `token` to renew/release.
//   { ok: false, holder, verdict }   — a LIVE holder; `holder` is the parsed entry (or null when
//                                      it vanished underneath us — retry).
export function acquireWorktreeLock(
  path,
  {
    owner,
    slug,
    pid = process.pid,
    host = hostname(),
    maxHoldMs = WORKTREE_LOCK_MAX_HOLD_MS,
    _now = () => Date.now(),
    _uuid = randomUUID,
    _pidAlive = pidAlive,
    _holderIdentity = holderIdentity,
    // plan 2738: our own start-time token, stamped into the record so a later prober can tell our
    // pid from whatever the OS reassigns the number to after we die. Memoised per process; null
    // (unprovable) simply omits the field and leaves that holder on the pre-2738 gates.
    startToken = selfStartToken(),
  } = {},
) {
  const token = _uuid();
  const write = () => {
    const iso = new Date(_now()).toISOString();
    return tryCreateExclusive(
      path,
      JSON.stringify({
        token,
        owner,
        slug,
        pid,
        host,
        startedIso: iso,
        heartbeatIso: iso,
        ...(startToken ? { startToken } : {}),
      }),
    );
  };
  if (write()) return { ok: true, token, reaped: false };

  const entry = parseWorktreeLockEntry(readExclusive(path));
  // Only a SAME-HOST record's pid is meaningful; a foreign host's pid number is another
  // machine's, so leave it unprovable and let the age gate decide.
  const verdict = classifyHolder(entry, {
    nowMs: _now(),
    maxHoldMs,
    host,
    _pidAlive,
    _holderIdentity,
  });
  if (verdict === 'LIVE') return { ok: false, holder: entry, verdict };
  if (verdict === 'FREE') return write() ? { ok: true, token, reaped: false } : refuse(path);
  reapStaleExclusive(path, token);
  return write() ? { ok: true, token, reaped: true } : refuse(path);
}

function refuse(path) {
  const entry = parseWorktreeLockEntry(readExclusive(path));
  return { ok: false, holder: entry ?? null, verdict: 'LIVE' };
}

// Bump `heartbeatIso` — only when we still own the file. Never throws; a failed renewal just
// brings the holder closer to the age ceiling, and its pid still proves it alive.
//
// ── plan 4034, gpt-review round 1 (2 finders, BLOCKING): a renewal is not ownership PROOF ──────
//
// The original shape read the record through the PATH, compared the token, and then wrote through
// the PATH again — two operations against a name other processes may reap and re-create between
// them. A sibling that reaped this (from its point of view, stale) lock and took the worktree in
// that window had its own fresh record overwritten by our bytes, and the renewal still returned
// TRUE. Both processes then believed they owned the tree: the two-writers-one-worktree corruption
// this module exists to prevent, arriving through its own heartbeat. The window was always
// reachable, but plan 4034 T1 turned a handful of renewals per land into one every 30 s for the
// whole pre-enqueue preflight, so leaving it was no longer defensible.
//
// The fix is to bind the whole operation to the INODE rather than the name. One `r+` descriptor is
// opened once; the token is read from it and the new record is written back through it. A reaper's
// rename/unlink then leaves that descriptor pointing at the detached old inode, so our write lands
// on a file nobody can see and the sibling's new record is untouched — which is exactly the
// guarantee `reapStaleExclusive`'s rename-then-unlink was designed to give and that a path-based
// `writeFileSync` (which happily CREATES) silently gave up. It also removes the truncate-then-write
// window in which a reader could see a half-written record and classify it CORRUPT, itself a
// licence to reap a lock we hold: the payload length is invariant across renewals (only the
// fixed-width `heartbeatIso` changes), so the `ftruncate` is a no-op in practice and a torn read
// sees equal-length bytes that still parse.
//
// Then READ BACK through the path and confirm the record is still ours. No care in the write can
// make check-and-act atomic against an outside reaper, so the honest answer is to verify after the
// fact and report what is true — a renewal that now finds a different token (or nothing) returns
// false and the caller's existing lock-lost arms fire. Note what this deliberately does NOT do: it
// never tries to take the lock back. A sibling that reaped us owns the tree now; our job is to
// stop, not to win a race.
//
// `_beforeWrite` is the test seam for that window — the only way to drive a reap-and-retake
// deterministically, since racing a real second process could not fail reproducibly (the
// ambient-load rule, plan 4005). Unused in production.
export function renewWorktreeLock(
  path,
  token,
  { _now = () => Date.now(), _beforeWrite = null } = {},
) {
  let fd;
  try {
    fd = openSync(path, 'r+');
  } catch {
    return false; // gone (a release or a completed reap) — never re-create it
  }
  try {
    const entry = parseWorktreeLockEntry(readFileSync(fd, 'utf8'));
    if (!entry || entry.token !== token) return false;
    const buf = Buffer.from(
      JSON.stringify({ ...entry, heartbeatIso: new Date(_now()).toISOString() }),
      'utf8',
    );
    _beforeWrite?.(path);
    writeSync(fd, buf, 0, buf.length, 0);
    ftruncateSync(fd, buf.length);
    // gpt-review r2: the SHARED reader, not a second inline `parseWorktreeLockEntry(readExclusive(…))`
    // — a future fix to how a lock record is read or parsed must reach the renewal's own ownership
    // check too, or this path alone would keep the old reading and could continue after losing the
    // worktree (or abort while still holding it).
    const after = readWorktreeLockEntry(path);
    return Boolean(after && after.token === token);
  } catch {
    return false;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* best-effort close — a failed close never changes the verdict above */
    }
  }
}

// Release iff we hold it. 'RELEASED' | 'NOOP' (already gone — idempotent) | 'FOREIGN' (someone
// else holds it now: our lock was reaped and retaken; NEVER unlink theirs).
export function releaseWorktreeLock(path, token, { force = false } = {}) {
  return releaseOwned(path, (text) => {
    if (force) return true;
    const entry = parseWorktreeLockEntry(text);
    return Boolean(entry && entry.token === token);
  });
}

export function readWorktreeLockEntry(path) {
  return parseWorktreeLockEntry(readExclusive(path));
}

// Is the lock held by a holder that is actually ALIVE? The read-only twin of the acquire path's
// own verdict, for callers that want to know without taking the lock.
//
// Callers must use THIS rather than `existsSync(path)`: a bare presence check treats a STALE lock
// — a crashed holder's leftover, which acquireWorktreeLock would reap on sight — as if it were a
// live one, so a single crashed prep would suppress every future dispatch until something else
// happened to reap the file. Same pid-proved-then-age-bounded verdict as acquire, so the two can
// never disagree about who owns a worktree.
export function worktreeLockIsLive(
  path,
  {
    maxHoldMs = WORKTREE_LOCK_MAX_HOLD_MS,
    _now = () => Date.now(),
    _pidAlive = pidAlive,
    _holderIdentity = holderIdentity,
  } = {},
) {
  const entry = readWorktreeLockEntry(path);
  if (entry === undefined) return false;
  return (
    classifyHolder(entry, {
      nowMs: _now(),
      maxHoldMs,
      host: hostname(),
      _pidAlive,
      _holderIdentity,
    }) === 'LIVE'
  );
}

// PREEMPTION — the "a crashed or hung prep child never wedges a land" arm (plan 2473 acceptance
// 2). Terminate a LIVE holder that outlasted the head-side bounded wait, then the caller reaps the
// lock and proceeds on the full-battery path.
//
// POSIX: kills the process GROUP first (`-pid`). The prep child is spawned `detached: true`, so
// its pid IS its group id, and the group kill takes down the `git`/`node` grandchildren it may be
// blocked in — which matters, because a surviving `git push --force-with-lease` grandchild is
// precisely the racing writer this whole module exists to exclude. Falls back to the bare pid
// where the group kill fails (already gone).
//
// win32: there are no process groups, so the group-kill arm above is skipped entirely (plan 2515;
// for the win32 spawn shape see the single-source comment at
// scripts/coord/spawn-detached-worktree-child.mjs `spawnDetachedWorktreeChild` (it lived on
// `dispatchLandPrep` until plan 2551 extracted the shared helper that both the prep dispatch and
// the queue-watch auto-spawn call, and moved to its own module in plan 3503 D2 so
// scripts/gpt-review.mjs could reuse it without importing done-worktree.mjs)
// — plan 2513) — a bare `_kill(pid)` only terminates the prep's own node process and orphans any
// git grandchild it is synchronously blocked in (worst case `git push --force-with-lease`), which
// is the exact racing-writer bug this module exists to exclude. Instead run
// `taskkill /PID <pid> /T /F`, which kills the pid's descendant tree; only on a taskkill failure
// (already gone, access denied) does it fall back to the bare `_kill(pid)` — a root-only kill
// still beats no kill. SIGTERM and SIGKILL are treated identically here: Windows has no graceful
// signal, so the caller's two-phase escalation degrades to two idempotent tree-kill attempts, the
// second a no-op against an already-dead pid.
//
// NOT routed through kill-tree.mjs `killProcessTree` deliberately: that seam takes a ChildProcess
// of OUR OWN (guards on .killed/.exitCode) and swallows failures (best-effort, exit-handler-safe),
// while this arm kills a FOREIGN pid from a lock entry and must REPORT delivery — the return value
// gates the caller's SIGKILL escalation. If you harden the taskkill invocation there, mirror it
// here (and vice versa).
//
// Returns true iff a kill was delivered by any route (never false while the holder is alive) —
// the caller's SIGKILL round only runs when the SIGTERM round reported true, so a false-negative
// here would skip escalation entirely and re-create the bug this preemption arm exists to close.
export function terminateWorktreeLockHolder(
  entry,
  signal = 'SIGTERM',
  {
    _kill = process.kill,
    _platform = process.platform,
    _execFileSync = execFileSync,
    _holderIdentity = holderIdentity,
  } = {},
) {
  if (!entry || !Number.isInteger(entry.pid) || entry.pid <= 0) return false;
  if (entry.host && entry.host !== hostname()) return false; // never signal a pid on another host
  // plan 2738 (review finding): the pid in a lock record is only as good as the record. This arm
  // force-kills a whole process TREE, so signalling a number the OS has since reassigned would
  // kill an unrelated process — and on this host a merely-alive pid is usually a recycled one.
  // A proven mismatch means there is nothing of ours left to kill: refuse, and let the caller's
  // reap take the lock (a RECYCLED holder is STALE, so it reaps without any kill at all). Returning
  // false is the correct signal too — the caller's SIGKILL escalation only runs after a delivered
  // SIGTERM, and there is nothing to escalate against. UNPROVEN (a legacy record, an unreadable
  // start time) behaves exactly as before this plan.
  if (_holderIdentity(entry) === 'RECYCLED') return false;

  if (_platform === 'win32') {
    try {
      _execFileSync('taskkill', ['/PID', String(entry.pid), '/T', '/F']);
      return true;
    } catch {
      /* taskkill failed — already gone, access denied, or no such pid — fall back below */
    }
    try {
      _kill(entry.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  try {
    _kill(-entry.pid, signal);
    return true;
  } catch {
    /* no process group or already gone — try the bare pid */
  }
  try {
    _kill(entry.pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function describeWorktreeLockHolder(entry) {
  if (!entry) return 'an unreadable lock record';
  const age = entry.heartbeatIso ? `, last renewed ${entry.heartbeatIso}` : '';
  return `${entry.owner || 'unknown'} pid ${entry.pid} on ${entry.host}${age}`;
}
