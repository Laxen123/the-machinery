#!/usr/bin/env node
// scripts/coord/kill-tree.mjs — the shared whole-descendant-tree kill behind
// run-land-tests.mjs (orphaned vitest pool on exit) and
// frontend/scripts/verify-mobile.mjs (spawned dev server teardown) — plan 1761.
//
// WHY: on Windows a spawned child under `shell: true` is a cmd.exe WRAPPER —
// `child.kill()` terminates only the wrapper while the real worker tree (pnpm →
// vitest workers, or next dev → its compiler processes) survives and keeps
// loading the machine. `taskkill /pid <pid> /T /F` walks and force-kills the
// whole descendant tree. Both call sites hand-rolled the same platform fork
// (flagged by /sonnet-review round 3 on plan 1750); a hardening to one copy
// silently missing the other is the same drift class atomic-write.mjs /
// excl-lock.mjs were extracted to close.
//
// CONTRACT: synchronous (spawnSync) and never throws — callable from a Node
// 'exit' handler, which is where run-land-tests needs it (an exit handler may
// not await, and a throw there would mask the real exit). Best-effort by
// design: the target may already be dead, and a failed kill must never block a
// teardown path. POSIX walks the descendant tree at KILL time (plan 1813):
// snapshot every live pid→ppid pair (/proc on Linux, one `ps` elsewhere),
// collect the ppid-chain descendants of the child, and SIGTERM them
// deepest-first, the child itself last. Kill-time collection is deliberate —
// the obvious spawn-time fix (detached + kill(-pid)) was implemented and
// REVERTED by the plan-1785 delta review: detaching removes the child from
// the process group GNU `timeout --kill-after` (run_bounded) SIGKILLs, and a
// group kill on a non-group-leader pid can SIGTERM strangers when an
// unrelated pgid numerically collides. The walk touches only pids whose ppid
// chain provably roots at the child, and leaves spawn semantics (non-detached
// group inheritance — load-bearing for the run_bounded path) untouched.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { delimiter, extname, join, resolve as resolvePath } from 'node:path';

// Procs THIS module already issued a kill for. `proc.killed` alone is not a
// usable guard on the win32 path: Node sets it only when proc.kill() delivers a
// signal, which taskkill never does — so without this set a SECOND call for the
// same ChildProcess would re-issue taskkill against the original pid, which the
// OS may by then have recycled to an unrelated process (delta-review finding,
// plan 1761). WeakSet so dead ChildProcess objects stay collectable.
const alreadyKilled = new WeakSet();

// Parse /proc/<pid>/stat into the space-split fields AFTER the comm parens —
// comm may itself contain spaces and parens, so split only after the LAST ')'.
// Offsets in the returned array: [0]=state, [1]=ppid, [2]=pgrp, … Returns null
// when the pid vanished or /proc is unavailable. Exported so the test
// batteries (kill-tree-test-lib.mjs) share the ONE parsing convention instead
// of re-rolling it per file.
export function procStatFields(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'latin1');
    const close = stat.lastIndexOf(')');
    if (close === -1) return null;
    return stat.slice(close + 2).split(' ');
  } catch {
    return null;
  }
}

// Best-effort stderr diagnostic that can itself NEVER throw — an EPIPE from a
// closing stderr inside an exit handler must not abort the kill cascade it is
// narrating (delta-review finding, plan 1813).
function warn(msg) {
  try {
    process.stderr.write(`kill-tree: ${msg}\n`);
  } catch {
    /* stderr gone — nothing left to tell */
  }
}

// taskkill's own exit code for "process not found" (plan 4087 review round 4, finding
// kill-tree.mjs:399 — verified 2026-09-22 against this box's real taskkill.exe with
// `taskkill /pid <gone-pid> /T /F`): the pid legitimately exited on its own between a caller's
// discovery/eligibility check and this kill attempt, a normal race rather than a failure.
// Exported as a plain pure function so a test can pin the classification directly, without
// spawning a real taskkill.exe.
export function isTaskkillAlreadyGoneExit(status) {
  return status === 128;
}

// Whether /proc is usable — probed once and cached, but ONLY the positive
// result: a false re-probes on the next call, so a /proc that appears later
// in an exotic container's life is still picked up (delta-review finding).
let procAvailable = null;

// Snapshot [pid, ppid] for every live process, synchronously. Linux reads
// /proc directly — no subprocess, so it works in minimal containers without
// procps; a /proc that exists but refuses a full listing (hardened mount)
// falls through to `ps` rather than giving up. Other POSIX (macOS/BSD) pays
// ONE spawnSync `ps`. Returns null when neither source is usable; the caller
// degrades to the single-child SIGTERM.
export function listPidPpidPairs() {
  if (procAvailable !== true) procAvailable = existsSync('/proc/self/stat');
  if (procAvailable) {
    let names = null;
    try {
      names = readdirSync('/proc');
    } catch {
      names = null; // listing denied (LSM/hidepid) — the ps fallback below may still work
    }
    if (names) {
      const pairs = [];
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        const fields = procStatFields(name); // null = pid exited mid-walk
        const ppid = fields ? Number(fields[1]) : NaN;
        if (Number.isInteger(ppid)) pairs.push([Number(name), ppid]);
      }
      return pairs;
    }
  }
  const r = spawnSync('ps', ['-Ao', 'pid=,ppid='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  const pairs = [];
  for (const line of r.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) pairs.push([pid, ppid]);
  }
  return pairs;
}

// BFS the ppid map down from rootPid → descendants in shallow→deep order.
// Index-cursor queue (no shift()) keeps the walk O(n) — this runs on the
// exit-handler kill path. The visited set guards against pathological snapshot
// cycles (a pid recycled mid-walk can make the pair list momentarily
// inconsistent).
export function collectDescendants(rootPid, pairs) {
  const childrenOf = new Map();
  for (const [pid, ppid] of pairs) {
    let bucket = childrenOf.get(ppid);
    if (!bucket) childrenOf.set(ppid, (bucket = []));
    bucket.push(pid);
  }
  const order = [rootPid];
  const visited = new Set(order);
  for (let head = 0; head < order.length; head++) {
    for (const c of childrenOf.get(order[head]) ?? []) {
      if (visited.has(c)) continue;
      visited.add(c);
      order.push(c);
    }
  }
  return order.slice(1); // descendants only
}

// Identity reader behind confirmTreeDead's recycled-vs-reparented distinction
// (plan 3929 review round 1, D2). A pid's /proc/<pid>/stat starttime (field
// 22 — procStatFields' index 19, since it drops the two comm-prefixed fields)
// is immutable and strictly monotonic for the life of that pid: the kernel
// cannot hand a pid number back out before its process-table slot clears, so
// a RECYCLED pid always carries a LATER starttime than the one snapshotted.
// A REPARENTED survivor's starttime never moves, even though its ppid does —
// measured on this container: a grandchild orphaned onto pid 1 keeps its
// original starttime exactly, while ppid flips 7621 -> 1 immediately. That is
// why starttime, not ppid, is the identity key: ppid distinguishes neither
// case reliably (see confirmTreeDead's own header comment for the ppid rule
// this replaced and the survivor it silently dismissed). Returns null when
// procStatFields itself can't read it (pid gone, or the `ps`-fallback
// platform with no /proc at all). Exported so kill-tree.test.mjs can inject
// it as a seam and pin both cases deterministically instead of racing real
// process starttimes.
export function processStartTime(pid) {
  const fields = procStatFields(pid);
  return fields ? fields[19] : null;
}

// procStatFields(pid)[0] is the /proc stat state field. A force-killed
// descendant that gets reparented onto a NON-REAPING pid 1 (plain `node
// --test` in Docker, no init) never gets wait()ed and stays in the table
// forever as state 'Z' (defunct) — present, holding a pid, but unable to
// execute or write anything. confirmTreeDead must not count it as a
// survivor, or a zombie produces a permanent, spurious KILL_FAILED (D4,
// review round 1) — the exact reason kill-tree-test-lib.mjs's isAlive is
// zombie-aware for its own battery. Exported as the same kind of injectable
// seam as processStartTime, for the same reason.
export function processState(pid) {
  const fields = procStatFields(pid);
  return fields ? fields[0] : null;
}

// snapshotDescendants — capture rootPid's descendant set as {pid, ppid,
// startTime} triples a caller can hold onto and hand to confirmTreeDead
// AFTER the tree is killed, once enumeration can no longer find it (plan
// 3929). This is NOT a second copy of the walk: it calls collectDescendants
// for the pid list, exactly like killProcessTree does, and only adds the
// ppid + starttime lookups collectDescendants itself deliberately doesn't
// return (see its own comment — "descendants only", bare pids).
// confirmTreeDead needs starttime to tell a still-alive descendant apart
// from an unrelated process the OS later recycled the same pid to (D2); ppid
// is kept alongside only for the diagnostic log line, never for identity.
//
// Returns null — NOT [] — when `pairs` is unusable (D3, review round 1): an
// enumeration failure at snapshot time and a root that genuinely has no
// descendants used to collapse to the same [], so a transient failure right
// here, followed by enumeration recovering by confirm time, let sol-run
// resume past a live grandchild with no baseline it was ever checked
// against. null carries that "could not look" fact across the kill boundary
// so confirmTreeDead can refuse to ever call it dead:true. This is a
// DIFFERENT contract from killProcessTree's own missing-/proc degrade
// (best-effort, [] there is fine) — no other caller of snapshotDescendants
// exists yet, so nothing downstream relies on the old []-always shape.
export function snapshotDescendants(
  rootPid,
  pairs = listPidPpidPairs(),
  { identityOf = processStartTime } = {},
) {
  if (!pairs) return null;
  const ppidOf = new Map(pairs);
  return collectDescendants(rootPid, pairs).map((pid) => ({
    pid,
    ppid: ppidOf.get(pid),
    startTime: identityOf(pid),
  }));
}

// confirmTreeDead — the post-kill question snapshotDescendants' capture exists
// to answer: given the descendant set recorded BEFORE a kill, is the WHOLE tree
// actually gone, or is some pid still running? (plan 3929). A supervisor that
// confirms only the direct child's 'close' event can miss a surviving
// grandchild that goes on writing a shared worktree concurrently with whatever
// runs next — this is that missing confirmation, factored into the ONE module
// that already owns tree enumeration rather than re-walked at each call site.
//
// OBSERVATION ONLY. This function must never signal anything, ever — killing
// is the caller's job (killProcessTree); this is only the caller asking "did
// it work". On POSIX it polls `listPairs()` (the same snapshot primitive the
// kill walk uses) until the tree is clean or `timeoutMs` elapses, and returns
// promptly once it is — no reason to burn the rest of the budget once every
// snapshot pid is confirmed gone.
//
// WIN32 (D1, review round 1). There is no POSIX enumeration on this platform
// — listPidPpidPairs has no win32 branch (/proc doesn't exist, `ps` is
// normally absent) and correctly returns null there — so demanding one here
// would report `dead: false` on every single Windows stall, where local
// operator sessions run. That is not merely unavailable, it is UNNECESSARY:
// killProcessTree's win32 branch is `taskkill /pid <p> /T /F`, which is
// ALREADY a forced whole-tree kill — the same guarantee this function exists
// to independently verify on POSIX, delivered a different way. So win32 gets
// its own short-circuit that trusts taskkill's own guarantee instead of
// failing an enumeration this platform was never going to pass, flagged
// distinctly (`confirmedByPlatformKill`) so a caller can tell "actually
// walked the tree and found nothing" apart from "trusted the OS's own forced
// kill". `platform` is a parameter (defaulting to `process.platform`)
// precisely so this branch is exercisable from Linux/CI, where win32 CI does
// not run.
//
// PID RECYCLING — vs. LEGITIMATE REPARENTING (D2, review round 1). A pid
// that is still present after the kill is not necessarily still OURS: the OS
// is free to hand a freed pid number to an unrelated new process. The rule
// that actually distinguishes "recycled" from "reparented" is process START
// TIME, not ppid (see processStartTime's own comment for the measurement): a
// surviving descendant keeps its exact snapshotted starttime even though the
// kernel reparents it to the nearest subreaper (usually pid 1) the INSTANT
// its own parent dies — no grace period — while a recycled pid always
// carries a strictly LATER starttime, because the OS cannot reissue a pid
// before its process-table slot clears. An earlier draft of this file used
// "same ppid, or original parent confirmed gone" instead; that rule was
// WRONG in the dangerous direction, not merely imprecise — if the ORIGINAL
// PARENT pid itself got recycled to an unrelated process, `ppidOf.has(ppid)`
// read that recycled parent as proof the child was still legitimate, so a
// genuinely surviving reparented descendant could be dismissed as "recycled"
// and dropped from `survivors` — the exact hazard this whole helper exists
// to prevent (findings 2170c5 et al.). Starttime has no such failure mode:
// it is a per-pid fact, never inherited from a parent's own identity.
// `identityOf` is an injectable seam (default processStartTime) so the
// recycled/reparented distinction is unit-testable without racing real
// process starttimes. Reparenting itself needs no special case any more —
// ppid may change freely; only starttime decides identity.
//
// `rootPid` has no snapshot entry to compare against — snapshotDescendants is
// descendants-only by construction — so root is checked by pid PRESENCE (and
// zombie state, below) alone, a narrower guarantee than the starttime rule
// above. That asymmetry is acceptable here because the caller (sol-run.mjs)
// already holds a strong, race-free confirmation of the root's own death from
// Node's 'close'/'error' event; this helper's root check is only a second,
// best-effort corroboration of that, not the only one.
//
// ZOMBIES (D4, review round 1). A present pid in state 'Z' (defunct) cannot
// execute or write anything — it is a force-killed descendant reparented
// onto a non-reaping pid 1 (plain `node --test` in Docker) that nobody ever
// wait()s. Counting it as a survivor produces a permanent, spurious
// KILL_FAILED; `stateOf` (default processState) is checked before ANY pid —
// root included — is ever added to `survivors`.
//
// UNKNOWN SNAPSHOT (D3, review round 1). `snapshot === null` means the
// PRE-kill enumeration itself failed (see snapshotDescendants's own comment)
// — there is no baseline descendant set to check survivors against, so no
// later recovery of `listPairs()` can turn this into a confident
// `dead: true`. Reported with the same honest shape as the mid-poll degrade
// below, before the poll loop ever starts.
//
// DEGRADED ENUMERATION (mid-poll). When `listPairs()` returns null (no
// /proc, no `ps` — the same case killProcessTree already degrades on), this
// function has no evidence for OR against any specific pid, so it can prove
// nothing either way. Reporting `dead: true` here would be exactly the false
// confidence this whole helper exists to prevent; reporting every snapshot
// pid as a survivor would be equally dishonest (we don't actually know
// they're still alive, only that we can't check). The honest shape is
// `dead: false` (we did not confirm death) with an EMPTY `survivors` list
// (we have no evidence for any specific one) plus `enumerationUnavailable:
// true` so the caller can tell "checked, something is alive" apart from
// "could not check at all". The same fail-safe shape covers an unavailable
// per-pid IDENTITY read (no /proc, no starttime — the `ps`-fallback
// platform): a pid we cannot verify is reported a survivor rather than a
// fabricated match, per pid rather than aborting the whole check.
export async function confirmTreeDead(
  rootPid,
  snapshot,
  {
    timeoutMs = 2000,
    pollMs = 100,
    listPairs = listPidPpidPairs,
    identityOf = processStartTime,
    stateOf = processState,
    platform = process.platform,
  } = {},
) {
  if (platform === 'win32') {
    // taskkill /pid <p> /T /F already force-killed the whole tree before this
    // function is ever called on this platform — see the WIN32 header
    // comment above. Nothing to enumerate, nothing to poll.
    return { dead: true, survivors: [], confirmedByPlatformKill: true };
  }
  if (snapshot === null) {
    // The pre-kill snapshot could not be taken at all (D3) — see the UNKNOWN
    // SNAPSHOT header comment; this can never become dead:true regardless of
    // how listPairs() behaves below.
    return { dead: false, survivors: [], enumerationUnavailable: true };
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pairs = listPairs();
    if (pairs === null) return { dead: false, survivors: [], enumerationUnavailable: true };
    const ppidOf = new Map(pairs);
    const survivors = [];
    for (const { pid, startTime } of snapshot) {
      if (!ppidOf.has(pid)) continue; // pid gone entirely — not a survivor
      if (stateOf(pid) === 'Z') continue; // D4 — present but defunct, not a survivor
      const currentPpid = ppidOf.get(pid);
      const currentStartTime = identityOf(pid);
      if (startTime == null || currentStartTime == null) {
        // No identity evidence either way (ps-fallback platform, or a read
        // that raced the pid away between the listPairs() snapshot above and
        // this call) — fail SAFE: presence alone marks it a survivor.
        survivors.push({ pid, ppid: currentPpid });
      } else if (String(currentStartTime) === String(startTime)) {
        // Same pid, same starttime — still ours, however its ppid moved.
        survivors.push({ pid, ppid: currentPpid });
      }
      // else: same pid, a DIFFERENT starttime — the OS recycled it to an
      // unrelated process while we were watching; not ours.
    }
    if (ppidOf.has(rootPid) && stateOf(rootPid) !== 'Z') {
      survivors.push({ pid: rootPid, ppid: ppidOf.get(rootPid) });
    }
    if (survivors.length === 0) return { dead: true, survivors: [] };
    if (Date.now() >= deadline) return { dead: false, survivors };
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }
}

// Kill `pid` (a BARE pid — no ChildProcess handle) and its entire descendant tree —
// taskkill /T on Windows, a pid→ppid snapshot walk + child-first signal cascade on POSIX.
// Extracted from killProcessTree below (plan 4087 review round 2, reuse finding
// coord-child-probe.mjs:194): round 1 added a SECOND, independent tree-kill implementation
// there (killProcessByPid, for a pid discovered by enumerating live processes — never a
// ChildProcess killProcessTree's own `proc.kill()` call could land on) and in doing so
// dropped THIS module's self-pid guard (`descendants[i] === process.pid`, corrupt-snapshot
// insurance) — its POSIX descendant walk could then signal the healer's own process. One
// primitive, one guard, one ordering, shared by killProcessTree (below, wraps this for a real
// spawned child) and coord-child-probe.mjs's killProcessByPid (wraps this for a rediscovered
// pid, after its own identity check — see that file's header).
//
// Synchronous and never throws (same exit-handler-safe contract as killProcessTree). Returns
// `{ ok, descendantsFailed, enumerationFailed }`: `ok` is true once the direct kill on `pid`
// itself was attempted without throwing (best-effort — the same "already dead is not a failure"
// contract killProcessTree has always had), false if even that final attempt threw (already dead
// / permission blip). `descendantsFailed` (plan 4087 review round 3, finding kill-tree.mjs:
// 427/428) is the pid list of descendants whose signal attempt threw something OTHER than ESRCH
// (the expected "already gone" race). `enumerationFailed` (plan 4087 review round 4, finding
// kill-tree.mjs:454) is true when the pid→ppid WALK ITSELF could not run at all (no /proc, no
// `ps`, or the listing threw) — a DIFFERENT partial-kill shape from `descendantsFailed`: there we
// know exactly which descendants might still be alive, here we never got far enough to know which
// pids to even check. Either one non-empty/true means the target itself died but the tree-kill
// was PARTIAL, which the pre-round-3 boolean return could not distinguish from a clean kill at
// all. Both are always `false`/`[]` on win32: `taskkill /T /F` is a single all-or-nothing call
// with no per-descendant signal or separate enumeration step of its own to observe (see the
// win32 branch below).
//
// `platform`/`_processKill`/`_taskkill`/`_listPairs` are testability seams (vetapp CLAUDE.md:
// "inject the platform AND its real symbols, never a bare `process.platform` fake") so both
// branches are exercisable from either host.
export function killProcessTreeByPid(
  pid,
  {
    platform = process.platform,
    signal = 'SIGTERM',
    _processKill = (p, s) => process.kill(p, s),
    // plan 4087 review round 3 (finding kill-tree.mjs:386 — Windows kill success ignored
    // taskkill's own exit status): `spawnSync` never throws on a non-zero exit by itself, unlike
    // `execFileSync` — the result used to be discarded entirely below, so ANY taskkill failure
    // was reported as a successful kill regardless. This throws on a spawn-level error or a
    // non-zero exit OTHER than 128, which the shared outer try/catch below already converts to
    // `ok: false` — the exact contract a caller supplying its own `execFileSync`-based `_taskkill`
    // already got for free (that redundant wrapper, in coord-child-probe.mjs, was removed once
    // this default itself became trustworthy — see that file's own header).
    //
    // plan 4087 review round 4 (finding kill-tree.mjs:399): exit 128 is taskkill's own "process
    // not found" code (verified 2026-09-22 against this box's real taskkill.exe with
    // `taskkill /pid <gone> /T /F`) — the pid can legitimately have exited on its own in the
    // ordinary window between a caller's discovery/eligibility check and this kill attempt, which
    // is a normal race, not a failure. Round 3 treated it identically to access-denied or any
    // other genuine failure, turning that routine race into a permanent, spurious kill-failed
    // report. Any OTHER non-zero exit is still a real failure.
    _taskkill = (p) => {
      const res = spawnSync('taskkill', ['/pid', String(p), '/T', '/F'], { stdio: 'ignore' });
      if (res.error) throw res.error;
      if (res.status !== 0 && !isTaskkillAlreadyGoneExit(res.status)) {
        throw new Error(`taskkill /pid ${p} /T /F exited ${res.status}`);
      }
    },
    _listPairs = listPidPpidPairs,
  } = {},
) {
  // Populated only on POSIX, only for a descendant whose signal genuinely failed (not ESRCH) —
  // see the return-shape comment above for why win32 never adds to this.
  const descendantsFailed = [];
  let enumerationFailed = false;
  try {
    if (platform === 'win32') {
      _taskkill(pid);
      return { ok: true, descendantsFailed, enumerationFailed };
    }
    // The walk is wrapped separately so no surprise inside it can ever skip
    // the direct kill below — that kill ran unconditionally before
    // plan 1813 and must keep doing so.
    try {
      const pairs = _listPairs();
      if (pairs) {
        const descendants = collectDescendants(pid, pairs);
        // Child-first: deepest pids get the signal before their parents, the
        // target pid itself last — a signaled parent can otherwise treat a
        // half-dead worker pool as a crash and respawn into the cascade.
        for (let i = descendants.length - 1; i >= 0; i--) {
          if (descendants[i] === process.pid) continue; // corrupt-snapshot insurance
          try {
            _processKill(descendants[i], signal);
          } catch (err) {
            // ESRCH (raced away between snapshot and signal) is the expected
            // case; anything else — EPERM from a sandboxed CI or a cross-user
            // re-exec — degrades but never silently (the plan-1785 revert
            // dinged a catch that hid exactly this class), and is now also
            // RECORDED (round 3) so the caller can tell a partial kill apart
            // from a clean one instead of only reading it off stderr.
            if (err?.code !== 'ESRCH') {
              warn(`${signal} to descendant ${descendants[i]} failed (${err?.code ?? err})`);
              descendantsFailed.push(descendants[i]);
            }
          }
        }
      } else {
        // Degrading is acceptable (best-effort contract) but never silent — and (round 4, finding
        // kill-tree.mjs:454) never silently reported as a CLEAN kill either: with no descendant
        // list we cannot confirm any descendant was actually reached, so this is a partial kill,
        // same as a descendant whose signal failed (see enumerationFailed in the return-shape
        // comment above).
        enumerationFailed = true;
        warn(
          'POSIX descendant enumeration unavailable (no /proc, no ps) — ' +
            `${signal} reaches the immediate child only`,
        );
      }
    } catch (err) {
      // The walk must never block the direct kill below — but a walk that
      // dies IS a degrade, and degrades are never silent in this file.
      enumerationFailed = true;
      warn(
        `descendant walk failed (${err?.code ?? err}) — ${signal} reaches the immediate child only`,
      );
    }
    _processKill(pid, signal);
    return { ok: true, descendantsFailed, enumerationFailed };
  } catch {
    // already dead / permission blip — best-effort by contract. `descendantsFailed` /
    // `enumerationFailed` are still whatever was recorded before the target's own kill threw —
    // informative even though `ok` is false, never discarded.
    return { ok: false, descendantsFailed, enumerationFailed };
  }
}

// Kill `proc` (a ChildProcess) and its entire descendant tree. True no-op on a missing proc, a
// proc this module already killed, or one that already exited on its own (exitCode/signalCode
// set once 'exit' has fired — never taskkill a pid the OS is free to recycle). Delegates the
// actual mechanics to killProcessTreeByPid above, wiring the target pid's own kill through
// `proc.kill()` (the ChildProcess method, preserving Node's own killed/signalCode bookkeeping)
// while every OTHER pid touched — a descendant — goes through the shared default
// (`process.kill`), exactly as before this was factored out.
//
// ESCALATION (plan 2738). `signal` picks the POSIX signal for the cascade, and
// `force` re-arms the once-only guard so a caller that gave SIGTERM a grace
// period and watched it fail can follow up with SIGKILL — over the WHOLE tree,
// which is the point: escalating with a bare `proc.kill('SIGKILL')` would leave
// exactly the `git` grandchildren the tree walk exists to reach still running
// (four independent review finders, 2026-08-03). Both default to today's
// behaviour, so the two pre-2738 callers are unchanged. `force` deliberately
// does NOT relax the exited-already guard: a pid the OS may have recycled must
// never be signalled, however forcefully the caller asked.
// win32 needs neither — `taskkill /T /F` is already a forced whole-tree kill,
// so the escalation there is an idempotent repeat, the same degradation
// `terminateWorktreeLockHolder` documents for its own two-phase escalation.
export function killProcessTree(proc, { signal = 'SIGTERM', force = false } = {}) {
  if (!proc || proc.pid == null) return;
  if (!force && (proc.killed || alreadyKilled.has(proc))) return;
  if (proc.exitCode != null || proc.signalCode != null) return;
  alreadyKilled.add(proc);
  killProcessTreeByPid(proc.pid, {
    signal,
    _processKill: (p, s) => (p === proc.pid ? proc.kill(s) : process.kill(p, s)),
  });
}

// waitForExit — the ONE child→outcome wiring for spawnWithTreeKill callers
// (plan-1785 review: run-land-tests and queued-run each hand-rolled this
// promise block; a tweak to one would silently miss the other — the same
// drift class spawnWithTreeKill itself was extracted to close). Resolves
// { code, error }: a spawn failure yields { code: null, error } (Node emits
// 'error' and no 'close' when the process never started); a normal exit
// yields { code, error: null }. Never rejects.
export function waitForExit(child) {
  return new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code, error: null }));
  });
}

// ---------------------------------------------------------------------------
// spawnWithTreeKill (plan 1785) — the ONE spawn seam for heavy child runs
// (run-land-tests.mjs runVitest, queued-run.mjs). Two problems it owns, in one
// place so a fix to either can never drift between callers (the plan-1785 F2
// finding — run-land-tests and the first queued-run each hand-rolled this):
//
// 1. ARBITRARY ARGS, SAFELY, ON WINDOWS. `pnpm` / node_modules/.bin shims are
//    .cmd batch files there; Node >= 22 refuses to spawn a .cmd without a
//    shell (CVE-2024-27980), and `shell: true` concatenates the args UNESCAPED
//    (DEP0190) — cmd.exe then re-splits a quoted `--testNamePattern "slow
//    test"` on its spaces, silently running the FULL suite (F1). The fix is
//    the cross-spawn strategy, vendored (~30 lines, no dep — this file syncs
//    byte-identical to sibling repos): resolve the command via PATH+PATHEXT;
//    a real .exe/.com spawns directly (args pass through the OS verbatim); a
//    .cmd/.bat spawns as `cmd.exe /d /s /c "<command line>"` with EVERY arg
//    quoted + caret-escaped per cross-spawn's rules and
//    windowsVerbatimArguments so Node adds no second layer of mangling.
//    (Known cross-spawn limitation, inherited: literal `%VAR%`-shaped args can
//    still be expanded by the batch layer — nothing our callers pass.)
//
// 2. KILL-ON-PARENT-EXIT ORDERING. If the calling process exits mid-run
//    (test-queue's SIGINT/SIGTERM wiring calls process.exit), the child tree
//    must die too — an orphaned vitest pool keeps loading the machine with no
//    slot held. prependOnceListener is load-bearing: 'exit' handlers run in
//    registration order and test-queue's slot-release handler registered FIRST
//    (at acquire), so PREPENDING puts this kill AHEAD of the release — the
//    child tree is dead before the freed slot can admit a rival. The listener
//    detaches once the child errors or closes on its own.
//
// Returns the ChildProcess; callers wire their own 'error'/'close' handlers.
// ---------------------------------------------------------------------------

// cross-spawn's cmd.exe metachar set + escaping, verbatim (moxystudio/node-cross-spawn
// lib/util/escape.js) — battle-tested against exactly the cmd.exe double-parse
// this covers; do not "simplify" it.
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeCommand(cmdPath) {
  return cmdPath.replace(CMD_META_CHARS, '^$1');
}

function escapeArgument(arg) {
  let s = String(arg);
  s = s.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"'); // double backslashes before a quote, escape the quote
  s = s.replace(/(?=(\\+?)?)\1$/, '$1$1'); // double trailing backslashes (they'd eat our closing quote)
  s = `"${s}"`;
  s = s.replace(CMD_META_CHARS, '^$1');
  s = s.replace(CMD_META_CHARS, '^$1'); // twice: cmd.exe parses a batch-file line twice
  return s;
}

// Resolve `cmd` the way CreateProcess/where.exe would: a path-y command checks
// its own location; a bare name walks PATH; both probe PATHEXT extensions in
// order (so a standalone pnpm.exe beats a pnpm.cmd shim, matching the OS).
// Returns the resolved file path, or null (caller spawns as-given and lets the
// natural ENOENT 'error' event surface — never a synthesized failure here).
function resolveWin32Command(cmd, cwd) {
  const dirs = /[\\/]/.test(cmd)
    ? [null] // explicit path — no PATH walk
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of dirs) {
    const base = dir === null ? resolvePath(cwd ?? process.cwd(), cmd) : join(dir, cmd);
    if (extname(base) && existsSync(base)) return base;
    for (const ext of exts) {
      const candidate = base + ext;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Spawn `cmd` with `args` (an array — NEVER pre-joined), cross-platform-safe,
// with the whole-tree kill wired to this process's exit. `opts` forwards to
// child_process.spawn (cwd, stdio, env); `shell` is deliberately not accepted
// and REJECTED loudly — silently forwarding it would reintroduce the exact
// unescaped-args splitting this seam exists to close (plan-1785 review).
export function spawnWithTreeKill(cmd, args = [], opts = {}) {
  if ('shell' in opts) {
    throw new Error(
      'spawnWithTreeKill: the `shell` option is not accepted — it reintroduces unescaped-args ' +
        'splitting (DEP0190, the plan-1785 F1 bug). Pass the command and args separately; ' +
        '.cmd/.bat shims are wrapped safely for you.',
    );
  }
  let child;
  const resolved = process.platform === 'win32' ? resolveWin32Command(cmd, opts.cwd) : null;
  if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
    const commandLine = [escapeCommand(resolved), ...args.map(escapeArgument)].join(' ');
    child = spawn(process.env.comspec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
      ...opts,
      windowsVerbatimArguments: true,
    });
  } else {
    // Deliberately NOT detached: a non-detached child shares this process's
    // group, so group-directed kills (GNU timeout / run_bounded, Ctrl+C) reach
    // the whole tree natively — killProcessTree's kill-time walk exists so
    // this stays true (see the header: the detached variant was reverted).
    child = spawn(cmd, args, opts);
  }
  const onExit = () => killProcessTree(child);
  process.prependOnceListener('exit', onExit);
  const detach = () => process.removeListener('exit', onExit);
  child.once('error', detach);
  child.once('close', detach);
  return child;
}
