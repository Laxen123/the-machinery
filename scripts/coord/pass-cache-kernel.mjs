// scripts/coord/pass-cache-kernel.mjs — the STORAGE / TTL / TELEMETRY kernel shared by this repo's two
// content-addressed pass-caches: `battery-pass-cache.mjs` (plan 1824 — one entry per test
// SELECTION) and `gate-pass-cache.mjs` (plan 2462 — one entry per GATE).
//
// WHY (plan 2492, xhigh review finding `11yvngr` on plan 2462): the two modules had
// near-identical copies of `makeGit` / `resolveCacheDir` / `entryPath` / `readCacheEntry` /
// `writeCacheEntry` / `removeCacheEntry` / `pruneExpired` / `logTelemetry` / `isLive` /
// `parseEntry`. That is the `atomic-write.mjs` situation exactly (plan 1761): a hardening
// applied to one copy silently missing the other, in a subsystem whose entire value is that it
// is trustworthy. One implementation, imported twice.
//
// WHAT IS DELIBERATELY *NOT* HERE — KEY DERIVATION.
// gate-pass-cache's module header records plan 2462's judgment call and it still stands: 1824's
// key is inseparable from TEST-SELECTION semantics (a canonical selection claim, universal twins,
// `selectionCovers`, per-selection prefix reachability), all of which exist because a battery run
// proves a SET OF TESTS. A gate has no selection — `tsc -p backend` either ran green over this
// exact content or it did not. Merging those would thread a degenerate always-universal claim
// through every soundness pin 1824 has. So: the mechanical discipline is shared HERE; what a key
// MEANS stays in each sibling. Nothing in this file may learn what a key covers.
//
// THE FAIL DIRECTION IS THE SAME IN BOTH CALLERS AND IS ENCODED HERE:
//   * a corrupt / unparseable entry            → absent ⇒ MISS ⇒ the work runs
//   * an unparseable or FUTURE timestamp       → NOT live ⇒ the work runs
//   * any fs trouble reading an entry          → absent ⇒ MISS
//   * telemetry failure                        → swallowed (never delays or fails a push)
//   * prune failure                            → ignored (hygiene, never load-bearing)
// A caller may add refusals on top; none may weaken these.

import { execFileSync } from 'node:child_process';
import { gitIsolatedEnv } from './child-env.mjs';
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWriteTextSync, TMP_SEP } from './atomic-write.mjs';
import { resolveCommonDirPath } from './lock-path.mjs';

// Both caches use the same 240 min, for the same reason: ONE keyed dependency is a PROXY, not
// content — node_modules/ is untracked and represented by `pnpm-lock.yaml` — and the TTL bounds
// how long that proxy is trusted. Deliberately NOT sized to battery/gate runtimes: an entry is
// only ever consulted BETWEEN runs, never during one. 240 min covers the whole target window
// (the worst measured land-queue wait was 109 min) while keeping any lockfile↔node_modules drift
// exposure to a same-workday scale.
export const DEFAULT_TTL_MIN = 240;

// The exit-code contract both CLIs share (the hook branches on these).
export const EXIT_HIT = 0;
export const EXIT_MISS = 2;
export const EXIT_UNCACHEABLE = 3;

// --- entry shape -------------------------------------------------------------

export function parseEntry(str) {
  try {
    const o = JSON.parse(str);
    return o && typeof o === 'object' && typeof o.iso === 'string' ? o : null;
  } catch {
    return null; // corrupt ⇒ treated as absent (MISS), and prune-able
  }
}

// Live iff it parses AND its age is known AND within TTL.
//
// Unknown age ⇒ NOT live, and a FUTURE stamp ⇒ NOT live. This is deliberately the OPPOSITE fail
// direction from landing-lock's `ageMinutes` (which clamps a negative delta to 0 because
// battery-lock's reaping needs a corrupt LOCK to be reapable): here a clock-skewed future
// timestamp — VM-snapshot resume, NTP misconfig — would otherwise read as permanently fresh and
// skip its work forever (xhigh + delta review findings, plan 1824; re-pinned by plan 2462).
export function isLive(entry, nowMs, ttlMin = DEFAULT_TTL_MIN) {
  if (!entry) return false;
  const t = Date.parse(entry.iso);
  if (Number.isNaN(t) || t > nowMs) return false;
  return (nowMs - t) / 60000 <= ttlMin;
}

// --- git seam (injectable for tests) -----------------------------------------

// Scrubbed-env git. Both caches run inside a git hook, where GIT_DIR / GIT_INDEX_FILE point at a
// worktree gitdir mid-operation and would override cwd-based repo selection. GIT_OPTIONAL_LOCKS=0
// keeps `git status` from taking index.lock — a cache probe must never contend with a parallel
// session's real git operation (there are ~5-7 of them).
//
// `input` feeds stdin (gate-pass-cache's `cat-file --batch-check` reads its path list there);
// battery-pass-cache simply never passes it.
export function makeGit({ _exec = execFileSync, cwd = process.cwd() } = {}) {
  // plan 2604: one shared, case-INSENSITIVE scrub. The hand-rolled `k.startsWith('GIT_')` loop
  // that used to live here was the third independently-maintained copy of it, and case-sensitive:
  // on win32, where env lookup is case-insensitive but a spread copy of process.env is not, an
  // ambient `git_dir=…` survived it and the child still resolved it as GIT_DIR. Scrub every GIT_*
  // first, then set GIT_OPTIONAL_LOCKS — order matters, it must not be scrubbed back out.
  const env = gitIsolatedEnv({ GIT_OPTIONAL_LOCKS: '0' });
  return (args, input) =>
    _exec('git', args, { encoding: 'utf8', env, cwd, ...(input === undefined ? {} : { input }) });
}

// `<git common dir>/<name>` — the shared-.git rendezvous battery-lock.mjs relies on (every
// worktree of the one clone sees the one cache; never git-tracked, never swept by
// `git clean -fdx`). Common-dir resolution is the shared `resolveCommonDirPath` helper
// (scripts/coord/lock-path.mjs, plan 2478/2489) — the same Windows cross-checkout rendezvous fix
// already applied to landing-lock/battery-lock/worktree-lock/install-lock/coord-git/heal-main
// (plan 2493). Unlike those five, this function's `git` is a caller-injected DI seam (both
// caches, and this suite's own tests, construct it) rather than a private module-level helper —
// so the migration routes resolveCommonDirPath's exec THROUGH the injected `git` (via a thin
// arg-forwarding adapter) instead of silently dropping it for `_exec`'s own default
// `execFileSync`, which would ignore whatever scrub/cwd the caller's `git` carries.
//
// `name` is per-cache ON PURPOSE — the two use SEPARATE dirs (different key formats, different
// prune policies, and a `status` listing that mixed the two would be unreadable).
export function resolveCacheDir(git, name) {
  return join(
    resolveCommonDirPath({ anchor: process.cwd(), _exec: (_bin, args) => git(args) }),
    name,
  );
}

// --- fs ops ------------------------------------------------------------------

export function entryPath(cacheDir, key) {
  // The key is our own lowercase-hex output, but it arrives back via --key from a shell — never
  // let a crafted value escape the cache dir.
  if (!/^[0-9a-f]{32}$/.test(key)) throw new Error(`malformed cache key ${JSON.stringify(key)}`);
  return join(cacheDir, `${key}.json`);
}

export function readCacheEntry(cacheDir, key) {
  try {
    return parseEntry(readFileSync(entryPath(cacheDir, key), 'utf8'));
  } catch {
    return null; // absent or unreadable ⇒ MISS
  }
}

// ATOMIC (plan 2492, finding `1y80hun`): both copies used a bare `writeFileSync`, which opens
// O_TRUNC — a mid-write failure (the AV/sync-scan EBUSY class, EIO, disk-full) left a TORN entry.
// Torn read as corrupt ⇒ absent ⇒ MISS, so it was never a stale green — but it silently poisoned
// a key until its TTL expired, and the repo already owns the crash-safe replace. Pretty-printed
// because these are read by hand when a gate stale-greens.
export function writeCacheEntry(cacheDir, key, entry) {
  mkdirSync(cacheDir, { recursive: true });
  atomicWriteTextSync(entryPath(cacheDir, key), JSON.stringify(entry, null, 2));
}

export function removeCacheEntry(cacheDir, key) {
  try {
    unlinkSync(entryPath(cacheDir, key));
    return true;
  } catch {
    return false;
  }
}

// Prune is THROTTLED by entry count (plan 2492, finding `1x7e82r`): before this it did a full
// readdir + parse-every-entry sweep on EVERY successful `record`, i.e. on the hot close-out path
// of every push. A dir holding a handful of entries has nothing worth sweeping, so the sweep only
// earns its keep once the dir has actually accumulated.
//
// Chosen over a time cadence deliberately: a cadence needs a mutable stamp file (a new shared
// mutable in the rendezvous dir, with its own corruption/clock-skew questions) to save a readdir
// that costs one syscall. The count IS the thing we care about — the dir staying small.
//
// Consequence, and it is fine: a dir that never crosses the threshold keeps expired entries
// indefinitely. They are inert (`isLive` gates every read) and bounded by the threshold.
export const PRUNE_MIN_ENTRIES = 32;

// Drop every expired/corrupt sibling, plus any orphaned atomic-write temp older than the TTL
// (`writeCacheEntry` cleans up its own temp on failure, but a killed process — the `timeout
// --kill-after` the hook wraps every cache call in — can leave one behind, and nothing else in
// either cache ever looks at a `.json.tmp.<pid>` name). Opportunistic: the dir stays small
// without a scheduled sweep. Any per-file error is ignored — pruning is hygiene, never
// load-bearing. Returns the number of files removed (0 when the throttle skipped the sweep).
export function pruneExpired(cacheDir, nowMs, ttlMin = DEFAULT_TTL_MIN, { minEntries = 0 } = {}) {
  let names;
  try {
    names = readdirSync(cacheDir);
  } catch {
    return 0;
  }
  if (names.length < minEntries) return 0;
  let pruned = 0;
  const drop = (name) => {
    try {
      unlinkSync(join(cacheDir, name));
      pruned += 1;
    } catch {
      /* another process pruned it first — fine */
    }
  };
  for (const name of names) {
    if (name.includes(`.json${TMP_SEP}`)) {
      // An orphaned temp. Age-gate it so a CONCURRENT writer's in-flight temp is never removed
      // out from under it (the same discipline landing-lock's orphan sweep uses).
      try {
        if (nowMs - statSync(join(cacheDir, name)).mtimeMs > ttlMin * 60000) drop(name);
      } catch {
        /* vanished or unstattable — leave it */
      }
      continue;
    }
    if (!name.endsWith('.json')) continue;
    let live = false;
    try {
      live = isLive(parseEntry(readFileSync(join(cacheDir, name), 'utf8')), nowMs, ttlMin);
    } catch {
      live = false;
    }
    if (!live) drop(name);
  }
  return pruned;
}

// One line per cache decision into a NEVER-COMMITTED log beside the cache dir (inside .git/, the
// plan-1731 telemetry convention) — this is the sizing instrumentation both caches were measured
// with: hit-rate and uncacheable-reason distribution come from here, not from a machine-wide env
// flip. Guarded: telemetry must never fail or delay a push.
export function logTelemetry(cacheDir, line) {
  try {
    mkdirSync(cacheDir, { recursive: true });
    appendFileSync(join(cacheDir, 'telemetry.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* never surface */
  }
}
