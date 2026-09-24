#!/usr/bin/env node
// scripts/coord/install-lock.mjs — machine-wide mutex serializing `pnpm install` on the shared main
// checkout (plan 1869).
//
// WHY: the main checkout's `node_modules/` is a single shared pnpm virtual store on disk — with
// ~5-7 parallel coord sessions on one clone, two sessions that BOTH decide to run `pnpm install`
// against the main checkout at once can interleave their writes into the same
// `node_modules/.pnpm/<entry>/` directories (create, link, delete) and leave a torn entry behind
// (present directory, missing inner `package.json` — see install-main.mjs's healer). This file is
// the single-holder mutex that stops that overlap; install-main.mjs is the one caller that must
// hold it before touching the shared store.
//
// SAME ARITY AS battery-lock.mjs — single-holder, token-owned, age-staled, FAIL-OPEN — deliberately
// MIRRORED rather than imported: consistency with the repo's one identity model beats a second one,
// but an install lock's flag surface (`--root`, no `--label`-only CLI contract) and staleness
// ceiling differ enough that a shared module would just be an extra indirection over ~150 lines.
//
// RENDEZVOUS: the lockfile lives in the SHARED `.git` common dir (`git rev-parse --git-common-dir`),
// exactly like `battery-lock.mjs` / `landing-lock.mjs` — every worktree of the one clone sees the
// same file, and it is never git-tracked nor swept by `git clean -fdx`.
//
// KEYED BY INSTALL ROOT: unlike battery-lock (one lock for the whole clone), a pnpm install can
// legitimately run against DIFFERENT roots at once — the main checkout AND any worktree, each with
// its OWN `node_modules/` — and those must never contend with each other. The lock filename embeds
// a short hash of the RESOLVED, CASE/SEPARATOR-NORMALIZED absolute install root
// (`normalizeInstallRoot` / `hashInstallRoot`), so two installs against the same physical directory
// always hash identically (however a caller spelled the path — mixed slashes, a differently-cased
// drive letter) while installs against different roots get different, non-contending lock files in
// the SAME shared `.git` common dir.
//
// STALENESS BY AGE, NOT PID (the `landing-lock.mjs` / `battery-lock.mjs` convention, generalized
// again here for consistency): a crashed installer leaves a lockfile no later process can attribute
// to a pid. DEFAULT_STALE_MIN = 15: a `pnpm install` against this monorepo's ~640-entry virtual
// store legitimately runs low-single-digit minutes warm and a handful more stone cold (a fresh
// clone / cache purge); it is never a "minutes vs hours" job the way the pre-push battery is. 15
// minutes is comfortably above any real cold-install tail while staying far below the "reap a LIVE
// holder" failure mode battery-lock's header warns against — pick a ceiling this low ONLY because
// the guarded job (unlike the battery) has no retry-doubling behaviour that could legitimately hold
// the lock twice as long.
//
// OWNERSHIP BY TOKEN: `acquire` prints an opaque token on stdout and writes it into the lockfile;
// `release --token <t>` unlinks ONLY when the token matches — a session that timed out (and never
// held the lock) can never release the install that is actually running.
//
// FAIL-OPEN, NEVER WEDGE: a bounded queue wait (DEFAULT_TIMEOUT_SEC) then the caller proceeds
// UNSERIALIZED with a loud warning — an install must never be blocked forever by a lock bug. Exit
// codes mirror battery-lock's contract exactly (0 ACQUIRED / 4 TIMEOUT / 5 ERROR) so a caller that
// already knows that contract needs nothing new. INSTALL_LOCK_DISABLE=1 is the emergency bypass
// hatch (skips the mutex entirely, no lockfile touched); INSTALL_LOCK_DIR=<path> redirects the
// rendezvous dir for test isolation while keeping the REAL acquire path (the `TEST_QUEUE_DIR`
// pattern) — unlike the bypass, every decision still runs, just against a scratch dir.
//
// Usage:
//   node scripts/coord/install-lock.mjs acquire [--root <path>] [--label <s>] [--stale-min 15] [--timeout-sec 900] [--poll-sec 5]
//   node scripts/coord/install-lock.mjs release [--root <path>] --token <token> [--force]
//   node scripts/coord/install-lock.mjs status [--root <path>]   # read-only: "free" or one held line
//   node scripts/coord/install-lock.mjs path   [--root <path>]   # read-only: the resolved lock path
//
// `--root` defaults to `process.cwd()` — the directory a caller is about to run `pnpm install` in.

import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sleepSync } from './coord-git.mjs';
import { resolveCommonDirPath } from './lock-path.mjs';

// SCRIPT_DIR — this file's OWN directory, resolved once at load time. See resolveLockPath's own
// comment for why this (never `process.cwd()`) is the fallback probe location when `root` doesn't
// exist on disk: it is deterministic (always inside THIS clone), cannot be deleted out from under
// the running process, and cannot point at a sibling repo the way an arbitrary caller cwd can.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// safeCwd — `process.cwd()` THROWS (uv_cwd/ENOENT) when the process's own working directory has
// been deleted underneath it, which is not exotic here: a teardown that removes the very worktree a
// session is sitting in does exactly that. Every `root ?? process.cwd()` default was therefore a
// latent crash on the one code path (a vanished root) that most needs to degrade gracefully — and
// it threw BEFORE reaching any of the fallback logic below. Falling back to this file's own
// directory keeps the same "resolve against THIS clone" answer the SCRIPT_DIR fallback already
// gives, instead of an unhandled exception.
export function safeCwd() {
  try {
    return process.cwd();
  } catch {
    return SCRIPT_DIR;
  }
}
// The file-level O_EXCL create/reap/release mechanism, shared with battery-lock.mjs/landing-lock.mjs
// (plan 1678) — see scripts/coord/excl-lock.mjs for the extraction rationale. This file's OWN identity
// model (single-holder, token-owned, age-staled, root-keyed) is NOT part of that shared module.
import {
  tryCreateExclusive,
  readExclusive,
  reapStaleExclusive,
  releaseOwned,
} from './excl-lock.mjs';
// `ageMinutes` and `parseLockArgs` are landing-lock's, imported rather than re-implemented — the
// same reuse battery-lock.mjs already relies on, so a fix to either helper never silently drifts
// between three hand-copied versions of the same logic.
import { ageMinutes, parseLockArgs } from './landing-lock.mjs';
// `numericFlag`/`assertFlagValue` are battery-lock's — imported rather than copy-pasted a second
// time (review finding [11]: this file used to carry a byte-identical fork of both). Both are
// re-exported verbatim: review finding [3] (delta round) folded the `numericFlag('')` bug fix
// upstream into battery-lock.mjs itself (this file's own thin local wrapper around it — which used
// to patch the bug only here, leaving it live in the shared helper — is deleted; the natural
// cleanup this file's own comment once predicted).
import { numericFlag, assertFlagValue } from './battery-lock.mjs';

export { ageMinutes, parseLockArgs, assertFlagValue, numericFlag };

// This CLI's own flag surface (`--root`; no `--scope`/`--wait` — those are landing-lock's).
export const INSTALL_ARG_SPEC = Object.freeze({
  label: 'install-lock',
  value: Object.freeze(['root', 'label', 'stale-min', 'timeout-sec', 'poll-sec', 'token']),
  boolean: Object.freeze(['force']),
});

// See the header comment for the sizing rationale.
export const DEFAULT_STALE_MIN = 15;
// DEFAULT_TIMEOUT_SEC: how long a waiter queues before giving up and proceeding UNSERIALIZED.
// Set equal to the stale ceiling (in seconds) — a waiter should be willing to wait as long as a
// legitimate install is allowed to run before either (a) the holder finishes and releases, or (b)
// the holder is presumed dead and reaped. Waiting materially LESS than the stale ceiling would make
// timeouts routine even against a perfectly healthy, still-running install; waiting materially MORE
// gains nothing (the ceiling already bounds how long a genuinely stuck holder can be trusted).
export const DEFAULT_TIMEOUT_SEC = DEFAULT_STALE_MIN * 60;
export const DEFAULT_POLL_SEC = 5;
export const EXIT_TIMEOUT = 4; // "proceed unserialized" — install-main.mjs must still run the install
export const EXIT_ERROR = 5;

// --- pure helpers -----------------------------------------------------------

// numericFlag: see battery-lock.mjs's own implementation and its finding [3] comment for the exact
// bug (`Number('5m')` is NaN, `Number('')`/`Number('   ')` are both 0) and why the fix now lives
// there rather than in a local wrapper here (review finding [3], delta round — this file used to
// carry a thin wrapper patching the empty-string case on top of an otherwise-buggy shared helper,
// leaving the bug live for battery-lock.mjs's own CLI; folded upstream instead, wrapper deleted).

// Normalize an install root for HASH-KEY purposes only (never for real fs operations — those must
// use the caller's real-cased path). Windows paths are case-insensitive and accept both slash
// styles, so two spellings of the SAME physical directory (mixed slash, a differently-cased drive
// letter) must hash identically, or a worktree install and the main checkout's install could
// silently fail to contend with each other (or two spellings of ONE root could falsely contend
// with themselves via two different lock files). POSIX paths stay case-sensitive as-is.
export function normalizeInstallRoot(root) {
  const abs = resolve(root);
  return process.platform === 'win32' ? abs.replace(/\\/g, '/').toLowerCase() : abs;
}

// Short (12 hex char) sha1 of the normalized root — enough to make lock-file collisions between
// unrelated roots practically impossible while keeping the filename short and diffable in `status`.
export function hashInstallRoot(root) {
  return createHash('sha1').update(normalizeInstallRoot(root)).digest('hex').slice(0, 12);
}

// Parse a lockfile's text. null on anything unreadable/malformed — a corrupt lock is treated as an
// unknown-age entry, i.e. reapable (see isStale below).
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
  return `${entry.label ?? '?'} (host ${entry.host ?? '?'}, pid ${entry.pid ?? '?'}, root-hash ${entry.rootHash ?? '?'}, age ${age == null ? 'unknown' : age + 'm'})`;
}

// --- fs ops (explicit path → unit-testable without a real .git) -------------

export function readEntry(lockPath) {
  const text = readExclusive(lockPath);
  return text === undefined ? undefined : parseEntry(text); // undefined = free, null = corrupt
}

// Try once to create the lock. Returns the token on success, undefined when already held.
export function tryCreate(lockPath, { token, label, nowIso, pid, host, rootHash }) {
  const created = tryCreateExclusive(
    lockPath,
    JSON.stringify({ token, label, iso: nowIso, pid, host, rootHash }),
  );
  return created ? token : undefined;
}

// Reap a stale lock via the shared excl-lock primitive (rename-then-unlink — see
// scripts/coord/excl-lock.mjs for why this closes the double-reap race). Returns true when this process
// performed the reap.
export function reapStale(lockPath, reaperTag) {
  return reapStaleExclusive(lockPath, reaperTag);
}

// One acquire attempt against an already-read world. Pure decision, fs effects delegated.
// Returns { action: 'ACQUIRED', token } | { action: 'BUSY', entry } | { action: 'REAPED' }.
export function acquireOnce(
  lockPath,
  {
    token,
    label,
    nowMs,
    pid,
    host,
    rootHash,
    staleMin = DEFAULT_STALE_MIN,
    _tryCreate = tryCreate,
    _readEntry = readEntry,
    _reapStale = reapStale,
  },
) {
  const created = _tryCreate(lockPath, {
    token,
    label,
    nowIso: new Date(nowMs).toISOString(),
    pid,
    host,
    rootHash,
  });
  if (created) return { action: 'ACQUIRED', token: created };

  const entry = _readEntry(lockPath);
  if (entry === undefined) return { action: 'REAPED' }; // released between create and read — retry
  if (isStale(entry, nowMs, staleMin)) {
    _reapStale(lockPath, `${pid}-${token.slice(0, 8)}`);
    return { action: 'REAPED' };
  }
  return { action: 'BUSY', entry };
}

// Release ONLY our own entry. A token mismatch is a NOOP, not an error: after a TIMEOUT the caller
// holds no token, and a stale-reaped lock may since have been re-acquired by someone else.
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

// --- root validation ---------------------------------------------------------

// Review finding [1] (delta round): a nonexistent --root has nothing to install into or serialize
// an install against — a genuine caller/config error, NOT the fail-open path (fail-open is reserved
// for lock CONTENTION/staleness, never for "there is no install to run at all"). Both this file's
// own CLI and install-main.mjs's CLI call this (via requireRootIfNeeded below) BEFORE any git or fs
// work, so a bad root fails fast with one clear line instead of surfacing however the git-common-dir
// probe or the pnpm-store walk happen to fail on a path that was never real. Exported so the two
// CLIs share one message rather than drifting.
export function assertRootExists(root) {
  if (!existsSync(root)) {
    throw new Error(`install root does not exist: ${root}`);
  }
}

// Review finding [2] (round 3) — REGRESSION FIXED: `status`/`path` are pure read-only lockfile
// queries — they never touch `root` on disk, only resolve the shared `.git` common dir and hash the
// root STRING (see resolveLockPath's own finding [2] fallback below for the other half of this fix,
// which handles the "root is gone but resolveLockPath still probes a directory" half). A teardown
// script probing "is any lock outstanding for the worktree I just deleted?" must keep working after
// the worktree is gone. Only `acquire` (and install-main.mjs's own install path) genuinely need a
// real directory to do real work in.
//
// Review finding [4] (round 3): this is the ONE exported, documented function both this file's own
// CLI and install-main.mjs's CLI call, each passing an explicit `needsRoot` intent for its own
// situation — the same de-duplication this round's numericFlag fix applied by folding upstream into
// battery-lock.mjs, now applied to the "which subcommands need a real root" rule so it is decided in
// ONE place instead of ad hoc, separately, in each CLI's main().
export function requireRootIfNeeded(root, needsRoot) {
  if (needsRoot) assertRootExists(root);
}

// --- lock path resolution ---------------------------------------------------

// The SHARED `.git` common dir (unless INSTALL_LOCK_DIR redirects it — test isolation that keeps
// the real acquire path, never an ambient bypass: production callers never set this env var).
// The actual GIT_*-scrubbed `rev-parse --git-common-dir` + isAbsolute/resolve algorithm is the
// shared `resolveCommonDirPath` helper (scripts/coord/lock-path.mjs, plan 2478 — also used by
// battery-lock.mjs/landing-lock.mjs/worktree-lock.mjs); this file's own layer above it is only the
// anchor choice below (`probeCwd`) and the friendly error wrap around it.
//
// Review finding [3]: the probe is anchored at `installRoot` — NOT the process's own cwd — so
// the rendezvous dir it resolves always belongs to the repo that owns `root`. A caller resolving a
// path for a DIFFERENT root than its own cwd (a worktree install invoked from elsewhere) would
// otherwise get the WRONG repo's `--git-common-dir`, silently keying the lock filename's hash
// correctly but its containing directory wrongly.
//
// Review finding [0] (round 4) — REGRESSION FIXED, THIRD TIME's the anchor: rounds 1-3 tried
// process.cwd() first as the ONLY probe (wrong clone if `--root` names another checkout), then
// `cwd: installRoot` alone (a nonexistent root threw ENOENT before git even ran), then added a
// `process.cwd()` FALLBACK for a nonexistent root — which is the bug this round closes: the lock
// FILENAME is already keyed by `hash(root)` (see the file header's "KEYED BY INSTALL ROOT"), so this
// probe decides only WHICH `.git` common dir is the rendezvous, never the identity of the lock. When
// `root` is gone, its clone is UNKNOWABLE — `process.cwd()` is an arbitrary, CALLER-dependent guess:
// it may be a sibling clone entirely (→ `release` silently no-ops against the wrong `.git`, leaving
// the REAL lock stuck for its full staleness ceiling; `status` misreports `free` while a lock is
// genuinely held elsewhere), or it may be the very root that was just deleted out from under this
// process (→ `process.cwd()` itself throws ENOENT/`uv_cwd` — round 4's finding [1], see below).
//
// The fix: when `root` exists, probe from `root` (unchanged — this is finding [3]'s invariant,
// preserved exactly). When `root` does NOT exist, probe from THIS SCRIPT's own directory
// (`SCRIPT_DIR`, computed once at module load from `import.meta.url`) instead of `process.cwd()`.
// SCRIPT_DIR is deterministic and always inside THIS clone — it cannot be deleted out from under the
// process (unlike a deleted `root`) and cannot silently resolve to a SIBLING repo (unlike an
// arbitrary caller cwd). Every worktree of one clone shares the SAME `.git` common dir, so probing
// from SCRIPT_DIR still resolves the correct shared lock directory for a root that used to be one of
// this clone's own worktrees — exactly the teardown use case (`status`/`path`/`release` on a
// just-deleted worktree root) this fallback exists for.
//
// DO NOT "simplify" this back to `process.cwd()` — that is precisely the bug four review rounds kept
// reintroducing. The whole reason a fallback is needed at all is that the lock filename's hash
// already pins WHICH root this lock is for; the probe's only job is finding a stable, in-clone
// directory to ask git for `--git-common-dir` from, and the running script's own location is exactly
// that, unconditionally, with no dependency on who called it or from where.
//
// Round 4 finding [1]: because SCRIPT_DIR is a plain string computed once at load time (not a
// `process.cwd()` call made fresh on every probe), resolving it can never throw — there is no longer
// any path through this function, including the fallback-selection itself, that can throw OUTSIDE
// the try/catch around the git exec below.
//
// Review finding [5]: `process.env.INSTALL_LOCK_DIR || (...)` treated a SET-BUT-EMPTY value
// (`INSTALL_LOCK_DIR=''`) the same as unset, falling through to the real shared `.git` common dir —
// exactly the accidental production write a test isolating via `''` would be trying to avoid. An
// explicit empty string is instead treated as a caller misconfiguration and rejected loudly (the
// safer of "reject" vs "redirect to a garbage relative path"): a test/tool that meant to isolate
// away from the real lock must find out immediately, not silently touch it.
//
// Review finding [12]: `rootHash` is accepted so a caller that already computed it (runAcquireLoop)
// need not pay for `hashInstallRoot` a second time with the identical input.
//
// The existsSync below is ALWAYS fresh — never trust a caller's "I already checked" hint.
// Round 4 added exactly that hint (`rootExists: true`) as a perf cleanup to elide one redundant
// stat on the acquire path, and round 5 found it had traded a syscall for a CRASH: a root deleted
// in the window between the caller's check and this call (a `done-worktree` teardown of the very
// worktree being installed into — the race class this repo lives with) left the hint STALE, so this
// function skipped the check, probed a path that no longer existed, and threw from a call site with
// no try/catch above it — killing the install without ever running pnpm, in direct violation of the
// FAIL-OPEN / NEVER-WEDGE contract. The stat is one syscall against a ~24s install; the fallback it
// guards is the difference between degrading gracefully and wedging. Do not re-add the hint.
export function resolveLockPath({ root, rootHash, _exec = execFileSync } = {}) {
  const installRoot = root ?? safeCwd();
  const hash = rootHash ?? hashInstallRoot(installRoot);
  const envDir = process.env.INSTALL_LOCK_DIR;
  let dir;
  if (envDir !== undefined) {
    if (envDir === '')
      throw new Error(
        'install-lock: INSTALL_LOCK_DIR is set but empty — refusing to silently fall back to the ' +
          'real shared .git common dir (this almost always means a test/tool meant to isolate away ' +
          'from the real lock and failed to)',
      );
    dir = envDir;
  } else {
    // Review finding [1] (delta round): the raw execFileSync throw used to escape as an unhandled
    // (and misleadingly-labeled — Node calls a bad `cwd` "spawnSync git ENOENT", blaming git for a
    // problem that is actually the missing directory) error. This call is also reached IN-PROCESS
    // from install-main.mjs's runAcquireLoop, which has no try/catch of its own around it at all —
    // wrapping ANY exec failure here (a missing git binary, a root that is not a repo, or anything
    // else) into one clear message means every caller gets a clean, non-stack-trace error for free,
    // not just this file's own CLI.
    // Round 4 finding [0]: probe from `installRoot` when it's known/verified to exist; degrade to
    // SCRIPT_DIR (never `process.cwd()` — see the big comment above) when it isn't. A real root is
    // ALWAYS probed from itself, exactly finding [3]'s invariant.
    const probeCwd = existsSync(installRoot) ? installRoot : SCRIPT_DIR;
    // The GIT_*-scrub + rev-parse --git-common-dir + isAbsolute/resolve algorithm itself is
    // plan 2478's shared helper (scripts/coord/lock-path.mjs) — this file's own layer above it is just
    // the root/rootHash-scoped anchor choice (probeCwd) and the friendly error wrap below.
    try {
      dir = resolveCommonDirPath({ anchor: probeCwd, _exec });
    } catch (e) {
      throw new Error(
        `cannot resolve the shared .git common dir for install root ${installRoot} ` +
          `(${e.code ?? e.message}) — is this root a git repository?`,
      );
    }
  }
  return join(dir, `install-lock-${hash}.json`);
}

// --- acquire loop (exported so install-main.mjs can call it in-process, without a CLI spawn) ------

// Returns { code, token, lockPath }. code 0 ⇒ token is set and the caller HOLDS the lock (release
// via releaseAt(lockPath, { token }) in a finally). code EXIT_TIMEOUT ⇒ token is null: the caller
// must proceed UNSERIALIZED (never block the install). Never throws for the FAIL-OPEN paths — a
// malformed numeric flag still throws (via numericFlag, called by the CLI before this), because a
// garbled flag is a caller bug that must surface immediately, not degrade into "just proceed".
export function runAcquireLoop({
  root,
  label = 'install',
  staleMin = DEFAULT_STALE_MIN,
  timeoutSec = DEFAULT_TIMEOUT_SEC,
  pollSec = DEFAULT_POLL_SEC,
  pid = process.pid,
  host = hostname(),
  log = (m) => console.error(m),
  _resolveLockPath = resolveLockPath,
  _acquireOnce = acquireOnce,
  _now = Date.now,
  _sleep = sleepSync,
}) {
  if (process.env.INSTALL_LOCK_DISABLE === '1') {
    log('install-lock: INSTALL_LOCK_DISABLE=1 — bypassing the mutex, proceeding unserialized');
    return { code: 0, token: randomUUID(), lockPath: null, bypassed: true };
  }
  const installRoot = root ?? safeCwd();
  // Computed ONCE here and threaded into _resolveLockPath (finding [12] — the lock path used to
  // recompute the identical hash internally).
  const rootHash = hashInstallRoot(installRoot);
  // No `rootExists` hint: resolveLockPath re-checks for itself, on purpose (round 5 — see its
  // header). The caller's earlier check can go stale if the root is torn down in the gap.
  const lockPath = _resolveLockPath({ root: installRoot, rootHash });
  const token = randomUUID();
  const deadline = _now() + timeoutSec * 1000;
  let announcedWait = false;
  // A reap→retry cycle does not sleep, so it needs its own bound: an fs that refuses both the
  // create and the reap (permissions, a directory at the lock path) would otherwise spin forever.
  let reaps = 0;

  for (;;) {
    const r = _acquireOnce(lockPath, {
      token,
      label,
      nowMs: _now(),
      pid,
      host,
      rootHash,
      staleMin,
    });
    if (r.action === 'ACQUIRED') return { code: 0, token: r.token, lockPath };
    if (r.action === 'REAPED') {
      if (++reaps > 10 || _now() >= deadline) {
        log('install-lock: cannot take the lock after repeated reaps — proceeding UNSERIALIZED');
        return { code: EXIT_TIMEOUT, token: null, lockPath };
      }
      log('install-lock: reaped a stale/abandoned lock — retrying');
      continue;
    }
    if (_now() >= deadline) {
      log(
        `install-lock: TIMEOUT after ${timeoutSec}s waiting on ${describeEntry(r.entry, _now())} — ` +
          'proceeding UNSERIALIZED (an install must never be blocked forever by this lock).',
      );
      return { code: EXIT_TIMEOUT, token: null, lockPath };
    }
    if (!announcedWait) {
      log(
        `install-lock: queued behind ${describeEntry(r.entry, _now())} — waiting up to ${timeoutSec}s`,
      );
      announcedWait = true;
    }
    _sleep(pollSec * 1000);
  }
}

// --- CLI --------------------------------------------------------------------

function main() {
  const { cmd, flags } = parseLockArgs(process.argv.slice(2), INSTALL_ARG_SPEC);
  if (!cmd) {
    console.error('install-lock: no command (acquire|release|status|path)');
    return EXIT_ERROR;
  }
  // assertFlagValue guard (finding [6]): unlike --label/--token, --root was read raw, so
  // `acquire --root --dry` silently swallowed `--dry` as the root value instead of surfacing it.
  const root = assertFlagValue(flags.root, 'root') ?? process.cwd();
  // Review finding [1] (delta round): fail fast & clean on a nonexistent root, before any git-probe
  // or fs op gets a chance to surface a confusing raw error (this throw is caught by the bottom-of-
  // file try/catch below, which turns it into one `install-lock: <message>` line + EXIT_ERROR).
  // Skipped only under INSTALL_LOCK_DIR (test isolation) — there the root is a bare hashing key,
  // never a directory this process actually reads from.
  //
  // Review finding [2] (round 3) — REGRESSION FIXED: this used to gate EVERY subcommand, hard-
  // failing `status`/`path` (pure read-only lockfile queries that never touch `root`) on a root that
  // no longer exists. requireRootIfNeeded (finding [4]) now decides per-subcommand: only `acquire`
  // genuinely needs a real directory; `release`/`status`/`path` don't (resolveLockPath's own finding
  // [2] fallback keeps them resolvable even when `root` is gone).
  if (process.env.INSTALL_LOCK_DIR === undefined) requireRootIfNeeded(root, cmd === 'acquire');
  if (cmd === 'path') {
    console.log(resolveLockPath({ root }));
    return 0;
  }
  if (cmd === 'status') {
    const entry = readEntry(resolveLockPath({ root }));
    console.log(entry === undefined ? 'free' : `held ${describeEntry(entry, Date.now())}`);
    return 0;
  }
  if (cmd === 'release') {
    const r = releaseAt(resolveLockPath({ root }), {
      token: assertFlagValue(flags.token, 'token'),
      force: flags.force === true,
    });
    if (r.action === 'FOREIGN')
      console.error(
        'install-lock: NOT releasing — the lock is held by another install (token mismatch)',
      );
    else
      console.error(
        r.action === 'NOOP' ? 'install-lock: free (nothing to release)' : 'install-lock: released',
      );
    return 0; // close-out must never block a caller
  }
  if (cmd !== 'acquire') {
    console.error(`install-lock: unknown command "${cmd}"`);
    return EXIT_ERROR;
  }

  const label = assertFlagValue(flags.label, 'label') ?? 'install';
  const staleMin = numericFlag(flags['stale-min'], DEFAULT_STALE_MIN, 'stale-min');
  const timeoutSec = numericFlag(flags['timeout-sec'], DEFAULT_TIMEOUT_SEC, 'timeout-sec');
  const pollSec = numericFlag(flags['poll-sec'], DEFAULT_POLL_SEC, 'poll-sec');
  const result = runAcquireLoop({ root, label, staleMin, timeoutSec, pollSec });
  if (result.token) console.log(result.token); // stdout is the token, and ONLY the token
  return result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    console.error('install-lock:', e.message);
    process.exit(EXIT_ERROR);
  }
}
