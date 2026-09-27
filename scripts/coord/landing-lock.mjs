#!/usr/bin/env node
// scripts/landing-lock.mjs — same-PC LANDING mutex (plan 234), SCOPE-AWARE since
// plan 1300 (per-record seed sharding Phase 3).
//
// WHY: the `🟢 LANDING` board marker (board.mjs set-state … LANDING) is an
// ADVISORY cross-PC signal with a TOCTOU window — two same-PC sessions can both
// read "no LANDING held" before either pushes its board row, then both merge to
// master and the second clobbers the first's seed rewrite. This tool is the
// same-PC belt-and-suspenders: a holder REGISTRY in the SHARED `.git` common dir
// (so all worktrees of the one clone rendezvous on it), mutated only under an
// O_EXCL meta-mutex. Cross-PC sessions have their own clone and own lock file —
// their serialization still rides on the git push-rejection guard (a non-ff push
// is refused). This lock is the same-PC layer ON TOP of that.
//
// SCOPE NARROWING (plan 1300): with the seed sharded per-record, two seed writes
// to DISJOINT records are conflict-free by construction and must NOT serialize.
// Each acquire therefore carries a SCOPE — `{"global":true}` (the monolith /
// manifests / anything not a record shard) or `{"shards":["record-1",…]}` (the
// exact shard set the land touches) — and an acquire BLOCKS only on a holder
// whose scope OVERLAPS its own (global overlaps everything; record sets overlap
// on a non-empty intersection). Same-record collisions still serialize exactly
// as before; disjoint-record 🟥 lands are effectively 🟩. An acquire with no
// --scope defaults to global (pre-1300 behaviour, and the safe conservative
// reading for any caller that cannot compute its shard set).
//
// LIFECYCLE (wired into done-worktree): acquire in step 3a BEFORE the
// `🟢 LANDING` board write; hold through rebase + merge + master push; release
// in step 9 after the push (and on EVERY demote/halt path between 3a and 9 —
// the "finally"). The board marker stays the cross-PC signal; this file is the
// same-PC enforcement.
//
// IDENTITY MODEL — ownership by SLUG, staleness by AGE (not pid):
// each `node landing-lock.mjs …` invocation is a separate short-lived process,
// so the acquiring pid is already dead by the time `release` (a LATER process)
// or a retry runs. pid-liveness is therefore useless as an ownership/staleness
// discriminator here. So: a registry ENTRY is OWNED by its `slug` (the landing
// worktree) — same-slug re-acquire is REENTRANT (the entry is refreshed with the
// new scope/timestamp, still overlap-checked against the OTHER holders first),
// same-slug release succeeds across processes; a DIFFERENT slug's overlapping
// entry is BUSY until it ages past --stale-min, then STALE (surfaced to the
// operator, never auto-stolen — --force-stale reclaims). pid + host are still
// recorded for diagnostics.
//
// Usage:
//   node scripts/landing-lock.mjs acquire <slug> [--scope <json>] [--stale-min 35] [--force-stale] [--wait] [--timeout-sec 120] [--poll-sec 3]
//   node scripts/landing-lock.mjs release <slug> [--force]
//   node scripts/landing-lock.mjs status                # read-only, one line per holder or "free"
//   node scripts/landing-lock.mjs path                  # read-only, prints the resolved lock path
//
// Exit codes (acquire): 0 ACQUIRE|REENTRANT|RECLAIMED · 2 BUSY (an overlapping
// holder is fresh; retry later) · 3 STALE (every overlapping holder is older
// than --stale-min; escalate to operator, NOT auto-stolen — re-run with
// --force-stale to reclaim) · 5 error.
// release always exits 0 (idempotent close-out must never be blocked).

import { existsSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolveMain, sleepSync } from './coord-git.mjs';
// plan 4172: the read-both window's legacy scope key names come from the repo's own
// coord.config.json (`legacyScopeKeys`), resolved once in main() — never a literal here.
import { loadCoordConfig } from './coord-config.mjs';
import { resolveCommonDirPath } from './lock-path.mjs';
// parseFlags comes from the ADOPTED module, NOT coord-git: this file is byte-synced to
// siblings whose coord-git.mjs is a slim local shim without it (plan 1777).
import { parseFlags } from './parse-flags.mjs';
// The file-level O_EXCL create/reap mechanism behind this file's registry META-MUTEX is shared
// with battery-lock.mjs's single-holder lock (plan 1678) — see scripts/coord/excl-lock.mjs. This module
// is a NEW coordShare member (adopted by tandapp alongside this file, per the
// coordShare dependency-ordering rule) since THIS file — unlike battery-lock — is
// byte-identical-synced to a sibling. registryVerdict and the scoped multi-holder registry
// read-modify-write below are NOT part of that shared module — only the mutex mechanism is.
import { tryCreateExclusive, readExclusive, reapStaleExclusive } from './excl-lock.mjs';
// The crash-safe registry WRITE (fsync+tmp-then-rename, plan 1733) is equally shared — with
// test-queue.mjs's ticket writes (plan 1761) — via atomic-write.mjs, a coordShare member adopted
// by tandapp alongside this file. TMP_SEP is the tmp-naming contract reapOrphanRegistryTemps
// scans by; rmTempPath is the one temp remover (rm, not unlink — squatter-dir-capable) shared by
// that sweep and the helper's own error path so the two cannot drift.
//
// SHARING BOUNDARY (plan 1761, evaluated and deliberately NOT extracted): the write primitive
// and the O_EXCL mechanism are ALL this file shares with the other registries. Its
// heartbeat/staleness/holder core stays its own — test-queue is N per-process ticket FILES,
// heartbeat-stale at 90s, fail-OPEN; this file is ONE repo-scoped registry behind a meta-mutex,
// ISO-age-stale at 35min, operator-gated reclaim, fail-CLOSED. Those diverge on every axis
// (cardinality, staleness signal, failure policy, storage shape), so a shared holder module
// would be a wide-interface shim rerouting the landing mutex through new code for zero dedup —
// the regression risk plan 1750 already declined once.
import { atomicWriteJsonSync, rmTempPath, TMP_SEP } from './atomic-write.mjs';

export const DEFAULT_STALE_MIN = 35; // stale-claim threshold (minutes); done-worktree-lib's reclaim gate imports this
// CLI acquire defaults — shared by runAcquireLoop's parameter defaults AND main()'s flag
// fallbacks so the two call sites cannot drift apart (mirrors how DEFAULT_STALE_MIN is shared).
const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_POLL_SEC = 3;

// The ONE "genuine fs error" discriminator: a real filesystem failure carries a STRING `e.code`
// (EACCES/EBUSY/EPERM/EISDIR/…); a coding defect — or withRegistryMutex's deliberate
// "registry mutex wedged" throw, a plain Error — does not. Shared by acquire's --wait retry,
// `status`, and `release`; never inline another copy (three drifted inline copies was a
// plan-1703 review finding).
function isGenuineFsError(e) {
  return typeof e?.code === 'string';
}

// Degraded `status` output for a registry we cannot produce real holders from — ONE builder for
// both tokens (unreadable-registry / corrupt-lock-file) so the field shape parseLockStatusLine
// (done-worktree-lib) captures can never desync between the two cases. age=unknown ⇒ the reclaim
// sweep never touches it.
function degradedHeldLine(token) {
  return `held ${token} pid=? host=? age=unknown scope=global`;
}
// The registry meta-mutex: held only for the microseconds of one read-modify-write.
// A mutex file older than this is a crash leftover, safe to clear.
const MUTEX_STALE_MS = 60_000;
// The one staleness predicate for crash-leftover files at the mutex threshold — shared by the
// meta-mutex sweep and the orphan-temp sweep so the two cannot drift. Throws when the path
// can't be stat'd (both callers already catch-and-skip).
const olderThanMutexStale = (p) => Date.now() - statSync(p).mtimeMs > MUTEX_STALE_MS;

// --- pure helpers -----------------------------------------------------------

// Whole minutes since `iso`, clamped ≥0. null when `iso` can't be parsed.
export function ageMinutes(iso, nowMs) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 60000));
}

// plan 4172 — the record-set scope key is `shards` (the vocabulary coord.config.json already
// uses: seedShardDir, shardIdPattern, derivedShardDirs). READ-BOTH WINDOW: a project that renamed
// the key declares its old name(s) in coord.config.json's `legacyScopeKeys`, and
//   • normalizeScope reads a legacy key exactly like `shards` (a holder written by a landing-lock
//     copy on an OLDER branch, which knows only the old key, still contends correctly), and
//   • withLegacyMirrors writes every legacy key BESIDE `shards` on the persisted holder entry (so
//     that older copy, reading a NEW holder, finds the key it knows instead of throwing
//     "malformed scope" inside its own acquire).
// Remove the window by dropping `legacyScopeKeys` from the config once one full land cycle has
// passed; nothing in this file names a legacy key.
let activeLegacyScopeKeys = [];

/** Test/CLI seam: set the legacy scope key names (null/undefined = none). */
export function setLegacyScopeKeys(keys) {
  activeLegacyScopeKeys = Array.isArray(keys) ? [...keys] : [];
}

const isIdList = (v) => Array.isArray(v) && v.every((c) => typeof c === 'string');

// Normalize a scope value. Accepts `{"global":true}`, `{"shards":[...]}` (or a configured legacy
// key carrying the same list), undefined/null (→ global — the conservative pre-1300 meaning).
// Throws on a malformed shape so a caller bug surfaces at acquire time, not as a silently
// non-blocking lock.
export function normalizeScope(scope, legacyKeys = activeLegacyScopeKeys) {
  if (scope == null) return { global: true };
  if (typeof scope !== 'object')
    throw new Error(`landing-lock: malformed scope ${JSON.stringify(scope)}`);
  if (scope.global === true) return { global: true };
  const key = ['shards', ...(legacyKeys || [])].find((k) => isIdList(scope[k]));
  if (key) {
    const ids = scope[key];
    if (ids.length === 0) return { global: true }; // an empty shard set can't prove disjointness
    return { shards: [...new Set(ids)].sort() };
  }
  throw new Error(`landing-lock: malformed scope ${JSON.stringify(scope)}`);
}

// The persisted shape of a normalized scope: `shards` plus every configured legacy key mirrored
// beside it (see the READ-BOTH WINDOW note above). A global scope carries no list to mirror.
export function withLegacyMirrors(normalized, legacyKeys = activeLegacyScopeKeys) {
  if (normalized.global) return normalized;
  const out = { shards: normalized.shards };
  for (const k of legacyKeys || []) out[k] = normalized.shards;
  return out;
}

// Do two (normalized) scopes contend? Global overlaps everything; record sets
// overlap on a non-empty intersection. A holder record with NO scope (written by
// a pre-1300 process during rollout) reads as global — never under-serialize.
export function scopesOverlap(a, b, legacyKeys = activeLegacyScopeKeys) {
  return normalizedOverlap(normalizeScope(a, legacyKeys), normalizeScope(b, legacyKeys));
}

// The ONE overlap definition, on already-normalized scopes. registryVerdict calls
// this directly with its once-normalized own scope (hoisted out of the per-holder
// loop) — never a second hand-rolled copy of the semantics.
function normalizedOverlap(na, nb) {
  if (na.global || nb.global) return true;
  const set = new Set(na.shards);
  return nb.shards.some((c) => set.has(c));
}

// Human-readable scope tag for status/error lines.
export function scopeLabel(scope, legacyKeys = activeLegacyScopeKeys) {
  const n = normalizeScope(scope, legacyKeys);
  return n.global ? 'global' : n.shards.join(',');
}

// Parse the registry file's text into an array of holder records. v2 shape is
// `{"v":2,"holders":[…]}`; a legacy single-holder object (pre-1300 rollout) is
// read as one GLOBAL holder. null on any malformed input (never throws) —
// callers treat null as "corrupt file" (surfaced, only --force clears).
export function parseRegistry(str) {
  try {
    const o = JSON.parse(str);
    if (!o || typeof o !== 'object') return null;
    if (Array.isArray(o.holders)) {
      return o.holders.filter((h) => h && typeof h === 'object' && typeof h.slug === 'string');
    }
    // Legacy single-holder record: {slug, pid, host, iso}
    if (typeof o.slug === 'string') return [o];
    return null;
  } catch {
    return null;
  }
}

// Boolean-aware arg parser — since plan 1777 a spec'd wrapper over parseFlags's shared
// subcommand mode (see parse-flags.mjs's header for the full semantics: leading spec'd
// booleans peel before the cmd, a value-flag-shaped leading token comes back as cmd
// verbatim, unknown flags throw loudly). The spec is a PARAMETER because battery-lock.mjs
// reuses this cmd-shaped wrapper with its own, different flag surface — this CLI's
// surface is the default.
export const LOCK_ARG_SPEC = Object.freeze({
  label: 'landing-lock',
  value: Object.freeze(['scope', 'stale-min', 'timeout-sec', 'poll-sec']),
  boolean: Object.freeze(['force-stale', 'wait', 'force']),
});
export function parseLockArgs(argv, spec = LOCK_ARG_SPEC) {
  return parseFlags(argv, { ...spec, subcommand: true });
}

// Decide the acquire action from an already-read registry. Pure (no fs) so every
// branch is deterministically testable.
//   holders   — parsed holder records (may be empty).
//   slug      — the acquiring landing worktree's slug (the ownership key).
//   scope     — the acquiring land's seed scope (normalized here).
//   nowMs     — current clock (injected).
//   staleMin  — an overlapping DIFFERENT-slug holder older than this is reclaimable.
// Returns { action: 'ACQUIRE'|'REENTRANT'|'BUSY'|'STALE', holder?, ageMin?, staleHolders? }.
//   BUSY  → at least one overlapping holder is fresh (reported, with its age).
//   STALE → every overlapping holder is stale (staleHolders lists them all;
//           --force-stale removes exactly those, never a disjoint or fresh one).
export function registryVerdict({
  holders,
  slug,
  scope,
  nowMs,
  staleMin = DEFAULT_STALE_MIN,
  legacyKeys = activeLegacyScopeKeys,
}) {
  const own = holders.find((h) => h.slug === slug);
  const others = holders.filter((h) => h.slug !== slug);
  // Normalize OUR scope ONCE (scopesOverlap would re-sort/dedup the same array per
  // holder); the overlap semantics stay single-sourced in normalizedOverlap.
  const ourScope = normalizeScope(scope, legacyKeys);
  const blockers = others.filter((h) =>
    normalizedOverlap(ourScope, normalizeScope(h.scope, legacyKeys)),
  );
  if (blockers.length === 0) return { action: own ? 'REENTRANT' : 'ACQUIRE' };
  // Unknown age (corrupt timestamp) can't be proven healthy → treat as stale and
  // surface, consistent with the board landing-age convention. STALE never auto-steals anyway.
  const withAge = blockers.map((h) => ({ holder: h, ageMin: ageMinutes(h.iso, nowMs) }));
  const fresh = withAge.filter(({ ageMin }) => ageMin != null && ageMin <= staleMin);
  if (fresh.length > 0) {
    // Report the FRESHEST overlapping holder — the one whose land most recently
    // proved liveness, i.e. the strongest reason to wait.
    const youngest = fresh.reduce((a, b) => (a.ageMin <= b.ageMin ? a : b));
    return { action: 'BUSY', holder: youngest.holder, ageMin: youngest.ageMin };
  }
  return {
    action: 'STALE',
    holder: withAge[0].holder,
    ageMin: withAge[0].ageMin,
    staleHolders: withAge.map(({ holder }) => holder),
  };
}

// --- registry meta-mutex (fs) ------------------------------------------------

// Run `fn` with the registry's O_EXCL meta-mutex held. The mutex guards only the
// read-modify-write of the registry file (microseconds), NOT the land itself —
// so a bounded spin with a crash-leftover sweep is enough. Throws after the spin
// budget (a genuinely wedged mutex is a repo-integrity problem to surface, not
// to silently bypass).
function withRegistryMutex(lockPath, fn) {
  const mutexPath = `${lockPath}.mutex`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (tryCreateExclusive(mutexPath, String(process.pid))) {
      try {
        return fn();
      } finally {
        try {
          unlinkSync(mutexPath);
        } catch {
          /* best-effort — the stale sweep below heals a leak */
        }
      }
    }
    // Crash leftover? A meta-mutex is held for microseconds; anything old is dead. Reap via the
    // shared rename-then-unlink primitive (excl-lock.mjs), NOT a naive unlink: two racing
    // sweepers could otherwise both observe the same stale mtime, and the SECOND one's unlink
    // would delete the FRESH mutex the first sweeper's own create just wrote underneath it —
    // the exact double-reap race the shared primitive exists to close for every caller.
    try {
      if (olderThanMutexStale(mutexPath)) {
        reapStaleExclusive(mutexPath, `${process.pid}-${attempt}`);
      }
    } catch {
      /* raced another sweeper (statSync on a since-removed file), or the mutex is still fresh — retry */
    }
    sleepSync(100);
  }
  throw new Error(`landing-lock: registry mutex wedged at ${mutexPath} — inspect and remove it`);
}

// --- fs ops (explicit path → unit-testable without a real .git) -------------

export function readHolders(lockPath) {
  // A transient, non-ENOENT read error (excl-lock.mjs's readExclusive throws rather than silently
  // treating an unreadable EXISTING registry as "free" — plan 1678 batch review finding [0])
  // deliberately PROPAGATES here, uncaught. Two rounds of trying to route it through the existing
  // `null` = "corrupt registry" sentinel instead (age-gated BUSY/STALE) were each themselves found
  // to be wrong: `null` carries STALE + `--force-stale` whole-registry-wipe semantics that assume
  // the registry is genuinely malformed, which is false for a merely-transient read glitch on an
  // otherwise-healthy, possibly still-actively-held lock — and STALE's own branch ignores
  // `wait`/`deadline` entirely, so a --wait caller could be bounced out on the very first
  // iteration instead of retried. Letting it propagate uncaught is the SIMPLEST correct behavior:
  // it reaches main()'s outer try/catch and exits 5, fail-closed, immediately, for every caller —
  // never a silent ACQUIRE, and never a false "corrupt, safe to wipe" classification. The one
  // caller that is allowed to ride THROUGH the glitch is the CLI acquire loop under --wait
  // (plan 1703, runAcquireLoop below): it catches the propagated error AT ITS OWN LAYER and
  // retries within the same wait/deadline window as ordinary BUSY contention — never here, and
  // never via the corrupt/STALE sentinel.
  const text = readExclusive(lockPath);
  if (text === undefined) return []; // never existed / vanished underneath us — free
  const parsed = parseRegistry(text);
  return parsed === null ? null : parsed; // null = corrupt (distinct from empty)
}

// Reap orphaned atomic-write temps (`<registry>.tmp.<pid>` a crashed/failed writeRegistry left
// behind — its own catch already cleans up best-effort, so an orphan means that cleanup ALSO
// failed, e.g. an AV scanner holding the temp). Only temps older than MUTEX_STALE_MS are touched:
// we run under the registry mutex so no sibling is legitimately mid-write, but the age gate keeps
// the sweep conservative against anything unforeseen. rmSync, not unlinkSync: a squatter
// DIRECTORY at a temp path (review 1733 [1]) would survive unlink forever AND wedge every later
// openSync from the same pid — rm reaps both shapes. Best-effort — a failed reap never blocks
// the write; the orphan is inert (never read by anyone) and gets retried on the next write.
function reapOrphanRegistryTemps(lockPath) {
  const dir = dirname(lockPath);
  // TMP_SEP (atomic-write.mjs) is the tmp-naming contract — the helper stages every write at
  // `<path>${TMP_SEP}<pid>`, so this prefix is guaranteed to match exactly what a failed write
  // can strand. Never re-spell '.tmp.' here.
  const prefix = `${basename(lockPath)}${TMP_SEP}`;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    try {
      const p = join(dir, name);
      if (olderThanMutexStale(p)) rmTempPath(p);
    } catch {
      /* raced another sweep, or still held — inert either way, retry on the next write */
    }
  }
}

function writeRegistry(lockPath, holders) {
  // Sweep BEFORE the empty-holders early return too — the terminal release-to-zero write must
  // still reap a prior failed write's orphan, or a lock path whose last-ever write is a release
  // strands it forever (review 1733 [2]).
  reapOrphanRegistryTemps(lockPath);
  if (holders.length === 0) {
    try {
      unlinkSync(lockPath);
    } catch (e) {
      // Only "already gone" is a successful idempotent release. Swallowing a transient
      // EBUSY/EPERM here would report RELEASED while the registry still lists the holder —
      // a phantom BUSY/STALE for the next overlapping acquire (review 1733 [0]).
      if (e.code !== 'ENOENT') throw e;
    }
    return;
  }
  // Atomic replace (plan 1733, extracted to atomic-write.mjs in plan 1761): a plain
  // writeFileSync opens with O_TRUNC, so a mid-write fs error would leave the previously-valid
  // registry TRUNCATED — which a later readHolders classifies via the corrupt (null) sentinel,
  // exposing --force-stale's whole-registry wipe against holders that were healthy one write
  // earlier. The shared helper guarantees the registry is always either the old complete content
  // or the new complete content. The atomicity is against MID-WRITE failure only — the registry
  // mutex already excludes concurrent writers, and any error still propagates fail-closed exactly
  // like the old direct write (the helper cleans up its temp and rethrows; no new retry layer).
  atomicWriteJsonSync(lockPath, { v: 2, holders });
}

// F-019 (plan 1313, 2026-07-02 coord audit): age (in whole minutes, clamped ≥0) of `lockPath`'s
// mtime relative to `nowIso`, via `statMs` (injectable for tests — real files carry the REAL wall
// clock, which this file's synthetic-ISO test suite runs far from). null when the file can't be
// stat'd or `nowIso` doesn't parse — callers treat null conservatively (see acquireAt below).
// plan 1398 (item 4): the ms-level clamp math (nowMs - mtimeMs, floored at 0) MIRRORS coord-git's
// shared clampedAgeMs (the same helper acquireCoordLock uses) rather than importing it — this file
// is byte-identical-synced to tandapp (coord.config.json → coordShare), whose OWN independent
// coord-git.mjs does not carry acquireCoordLock/clampedAgeMs at all (that machinery was never part
// of tandapp's adopted set). Importing clampedAgeMs here would silently break tandapp's copy at
// import time the moment it's synced (verified: `SyntaxError: … does not provide an export named
// 'clampedAgeMs'`) — a cross-repo dependency the "coord-sharing" model's own dependency-ordering
// rule forbids introducing without adopting the dependency first. Kept as an inline duplicate of
// the SAME formula on purpose; if coord-git.mjs's clamp math ever changes, update both by hand.
function corruptFileAgeMinutes(lockPath, nowIso, statMs) {
  let mtimeMs;
  try {
    mtimeMs = statMs(lockPath);
  } catch {
    return null;
  }
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) return null;
  return Math.max(0, Math.round((nowMs - mtimeMs) / 60000));
}

// Acquire a scoped entry in the registry at `lockPath`. opts: { slug, pid, host,
// nowIso, scope, staleMin, forceStale }. Returns the registryVerdict shape, plus
// RECLAIMED for a forced stale/corrupt takeover. `_statMs` is a test seam (real
// `statSync(path).mtimeMs` by default) — see F-019 below.
export function acquireAt(
  lockPath,
  {
    slug,
    pid,
    host,
    nowIso,
    scope,
    staleMin = DEFAULT_STALE_MIN,
    forceStale = false,
    _statMs = (p) => statSync(p).mtimeMs,
  },
) {
  const entry = { slug, pid, host, iso: nowIso, scope: withLegacyMirrors(normalizeScope(scope)) };
  return withRegistryMutex(lockPath, () => {
    const holders = readHolders(lockPath);
    if (holders === null) {
      // Corrupt/unreadable registry: never silently steal. Force reclaims it whole.
      if (!forceStale) {
        // F-019: port coord-git.acquireCoordLock's mtime-freshness fallback for an empty/
        // unparseable holder — the SAME transient create-then-write window a sibling's
        // writeRegistry can leave. A corrupt file YOUNGER than staleMin is presumed to be that
        // in-flight write and reported BUSY (poll/retry, never silently stolen); only a corrupt
        // file OLDER than staleMin — genuinely orphaned/corrupt — keeps the pre-fix STALE
        // classification (still gated behind an explicit --force-stale). An unknown age (can't
        // stat, or nowIso unparseable) stays conservative: STALE, as before.
        const ageMin = corruptFileAgeMinutes(lockPath, nowIso, _statMs);
        if (ageMin != null && ageMin <= staleMin) return { action: 'BUSY', holder: null, ageMin };
        return { action: 'STALE', holder: null, ageMin };
      }
      writeRegistry(lockPath, [entry]);
      return { action: 'RECLAIMED', holder: null };
    }
    const v = registryVerdict({
      holders,
      slug,
      scope: entry.scope,
      nowMs: Date.parse(nowIso),
      staleMin,
    });
    if (v.action === 'ACQUIRE' || v.action === 'REENTRANT') {
      // REENTRANT refreshes the own entry (new scope/pid/timestamp) — the verdict
      // above already overlap-checked the NEW scope against the other holders.
      writeRegistry(lockPath, [...holders.filter((h) => h.slug !== slug), entry]);
      return v;
    }
    if (v.action === 'STALE' && forceStale) {
      const staleSlugs = new Set(v.staleHolders.map((h) => h.slug));
      // Remove exactly the stale OVERLAPPING holders; disjoint/fresh entries stay.
      const kept = holders.filter((h) => h.slug !== slug && !staleSlugs.has(h.slug));
      writeRegistry(lockPath, [...kept, entry]);
      return { action: 'RECLAIMED', holder: v.holder };
    }
    return v;
  });
}

// Release this slug's entry at `lockPath`. Idempotent — a missing file or absent
// entry is a NOOP; other holders' entries are never touched (except a corrupt
// registry, which only --force clears whole). Never throws on the happy paths.
export function releaseAt(lockPath, { slug, force = false }) {
  return withRegistryMutex(lockPath, () => {
    if (!existsSync(lockPath)) return { action: 'NOOP' };
    const holders = readHolders(lockPath);
    if (holders === null) {
      // Corrupt registry: only --force clears it (whole-file — nothing parseable to keep).
      if (!force) return { action: 'FOREIGN', holder: null };
      unlinkSync(lockPath);
      return { action: 'RELEASED', holder: null };
    }
    const own = holders.find((h) => h.slug === slug);
    if (!own && !force) {
      const rest = holders.length ? holders : null;
      return rest ? { action: 'FOREIGN', holder: holders[0] } : { action: 'NOOP' };
    }
    // --force on an absent entry: remove the NAMED slug only (a targeted stranded-
    // holder reclaim must not evict unrelated live holders — post-1300 there can
    // legitimately be several).
    const kept = holders.filter((h) => h.slug !== slug);
    if (kept.length === holders.length && force && holders.length > 0) {
      // Named slug matched NO holder — the registry is untouched. Distinct action so
      // the CLI can tell the operator the truth instead of the reassuring "free"
      // (a mistyped slug in a manual recovery must not read as success — plan-1300
      // review finding 1). `holders` is included so the caller can name who IS held.
      return { action: 'NOT_FOUND', holder: holders[0], holders };
    }
    writeRegistry(lockPath, kept);
    return { action: 'RELEASED', holder: own ?? null };
  });
}

// --- CLI acquire loop ---------------------------------------------------------
//
// Exported (with injectable seams) so the retry semantics are deterministically
// unit-testable — the plan-1703 acceptance criteria are about THIS loop's behavior,
// which used to live inline in main() where only real AV timing could exercise it.
// Returns the process exit code (0 acquired · 2 BUSY · 3 STALE); THROWS on a
// fail-closed error — main()'s outer try/catch turns that into exit 5, unchanged.
//
// Transient-error retry (plan 1703): acquireAt can throw a genuine transient fs
// error — readHolders propagating excl-lock's non-ENOENT read throw (EACCES/EBUSY/
// EPERM under an AV/sync scan; plan 1678), and the same scan can equally hit the
// meta-mutex create or the registry write. All of those carry a STRING `e.code`
// (isGenuineFsError — the same discriminator the `status` and `release` commands
// use). The predicate is DELIBERATELY any-string-code broad, not an allowlist of
// known-transient codes: an unlisted transient code slipping through an allowlist
// would abort a whole land on its first glitch (the exact regression this plan
// fixes), while the cost of retrying a genuinely permanent fs error is a bounded,
// per-retry-logged delay (≤ timeoutSec) ending in the same fail-closed exit 5.
// Under --wait, such an error is normalized to a TRANSIENT_READ
// pseudo-action that rides the SAME wait/deadline check as BUSY — one predicate,
// never a second hand-written copy. Everything else is deliberately NOT retried:
//   - no --wait → rethrow: a non-wait caller keeps failing closed immediately
//     (exit 5), exactly as before this plan.
//   - withRegistryMutex's "registry mutex wedged" throw (a plain Error, NO `.code`)
//     → rethrow even under --wait: a terminal repo-integrity signal that must
//     surface immediately, never be silently retried (the attempt-1 bug).
//   - deadline exhausted with the error persisting → rethrow the ORIGINAL fs
//     error: fail CLOSED at exit 5, never BUSY's exit 2 (done-worktree's reclaim
//     gate keys on exit 3, and a caller must never read "unreadable registry" as
//     ordinary contention it could eventually steal through).
// The transient path can never reach STALE/RECLAIMED — acquireAt threw before any
// verdict was computed, so the corrupt-registry (`null`) sentinel and its
// --force-stale wipe semantics are structurally unreachable from here (the
// attempt-2 bug).
export function runAcquireLoop({
  lockPath,
  slug,
  scope,
  staleMin = DEFAULT_STALE_MIN,
  forceStale = false,
  wait = false,
  timeoutSec = DEFAULT_TIMEOUT_SEC,
  pollSec = DEFAULT_POLL_SEC,
  pid = process.pid,
  host = hostname(),
  _acquireAt = acquireAt,
  _now = Date.now,
  _sleep = sleepSync,
  _nowIso = () => new Date().toISOString(),
  log = console.log,
  logError = console.error,
}) {
  // A garbled numeric flag must fail fast, not warp the loop: NaN staleMin makes every fresh
  // holder look STALE to registryVerdict (ageMin <= NaN is false → a live land becomes
  // force-stale bait), and a NaN deadline disables the --wait timeout outright (now >= NaN is
  // always false → infinite retry inside done-worktree). Throws a codeless Error → main()'s
  // outer catch → exit 5.
  for (const [name, v] of [
    ['staleMin (--stale-min)', staleMin],
    ['timeoutSec (--timeout-sec)', timeoutSec],
  ]) {
    if (!Number.isFinite(v) || v < 0)
      throw new Error(`landing-lock: bad ${name}: "${v}" — expected a non-negative number`);
  }
  // pollSec is STRICTLY positive: 0 passes a >=0 gate but turns the retry loop into a
  // zero-delay busy-loop hammering the shared registry (O_EXCL mutex churn) for the whole
  // --wait window — which itself manufactures the transient EBUSY/EACCES class under AV.
  if (!Number.isFinite(pollSec) || pollSec <= 0)
    throw new Error(
      `landing-lock: bad pollSec (--poll-sec): "${pollSec}" — expected a positive number`,
    );
  const deadline = _now() + timeoutSec * 1000;
  for (;;) {
    let r;
    try {
      r = _acquireAt(lockPath, {
        slug,
        pid,
        host,
        nowIso: _nowIso(),
        scope,
        staleMin,
        forceStale,
      });
    } catch (e) {
      if (!isGenuineFsError(e) || !wait) throw e;
      r = { action: 'TRANSIENT_READ', error: e };
    }
    if (r.action === 'ACQUIRE' || r.action === 'REENTRANT' || r.action === 'RECLAIMED') {
      log(`${r.action} ${slug} scope=${scopeLabel(scope)}`);
      return 0;
    }
    if (r.action === 'STALE') {
      const h = r.holder;
      logError(
        `STALE — landing lock held by ${h ? `${h.slug} (pid ${h.pid}, host ${h.host}, age ${r.ageMin}m, scope ${scopeLabel(h.scope)})` : 'a corrupt lock file'}. ` +
          `Re-run with --force-stale to reclaim, after confirming that landing is truly dead.`,
      );
      return 3;
    }
    // BUSY | TRANSIENT_READ — ONE wait/deadline check decides retry vs fail for
    // both (TRANSIENT_READ only exists when wait=true, so the !wait leg is inert
    // for it — kept in the shared predicate rather than duplicated per action).
    if (!wait || _now() >= deadline) {
      if (r.action === 'TRANSIENT_READ') {
        logError(
          `landing-lock: --wait window exhausted while the registry stayed unreadable (${r.error.code}) — failing CLOSED, no acquire recorded (if the error struck mid-write the registry may be truncated — inspect it before any --force-stale).`,
        );
        throw r.error;
      }
      const h = r.holder;
      logError(
        `BUSY — landing lock held by ${h ? `${h.slug} (age ${r.ageMin}m, scope ${scopeLabel(h.scope)}, overlapping ours ${scopeLabel(scope)})` : 'a corrupt lock file'}.${wait ? ` Timed out after ${timeoutSec}s.` : ''}`,
      );
      return 2;
    }
    if (r.action === 'TRANSIENT_READ')
      logError(
        `landing-lock: transient registry read error (${r.error.code}) — retrying within the --wait window.`,
      );
    _sleep(pollSec * 1000);
  }
}

// --- lock path resolution ---------------------------------------------------

// The lock lives in the SHARED `.git` common dir (not a worktree-local gitdir,
// not the working tree) so every worktree of the one clone rendezvous on the
// same file, and it is never git-tracked / never swept by `git clean -fdx`.
// Anchored at `resolveMain()`, GIT_*-scrubbed (`lock-path.mjs`) — the scrub is what keeps a
// poisoned GIT_DIR (exported into every child of a git hook, mid-operation) from resolving a
// foreign repo's common dir instead of main's.
export function resolveLockPath() {
  return join(resolveCommonDirPath({ anchor: resolveMain() }), 'landing-lock.json');
}

// --- CLI --------------------------------------------------------------------

export function main() {
  const { cmd, positionals, flags } = parseLockArgs(process.argv.slice(2));
  // plan 4172: resolve the read-both window's legacy key names once, from the main checkout's own
  // config. A config that cannot be read degrades to "no legacy key" — a legacy-keyed holder then
  // reads as malformed and acquire fails CLOSED (exit 5), never silently non-blocking.
  try {
    setLegacyScopeKeys(loadCoordConfig(resolveMain()).legacyScopeKeys);
  } catch {
    setLegacyScopeKeys(null);
  }
  if (!cmd) {
    console.error('landing-lock: no command (acquire|release|status|path)');
    return 5;
  }
  if (cmd === 'path') {
    console.log(resolveLockPath());
    return 0;
  }
  if (cmd === 'status') {
    // Read-only/diagnostic — must degrade gracefully on a transient registry-read error rather
    // than hard-fail, but on a DIFFERENT token than the corrupt (unparseable) registry below:
    // the two states demand different operator responses (retry vs recover). Only catches a
    // genuine fs error (has `.code`, e.g. EACCES/EBUSY/EISDIR); anything else (e.g. a coding
    // defect) still surfaces, unswallowed.
    let holders;
    try {
      holders = readHolders(resolveLockPath());
    } catch (e) {
      if (!isGenuineFsError(e)) throw e;
      // Transiently unreadable ≠ corrupt — say so, on a DISTINCT slug token, so an operator
      // doesn't force-release a healthy registry over an AV blip. Both tokens parse identically
      // for done-worktree's reclaim sweep (age=unknown is never reclaimed).
      console.error(
        `landing-lock: registry transiently unreadable (${e.code}) — not necessarily corrupt; re-run status before acting on it.`,
      );
      console.log(degradedHeldLine('unreadable-registry'));
      return 0;
    }
    if (holders === null) {
      console.log(degradedHeldLine('corrupt-lock-file'));
      return 0;
    }
    if (!holders.length) {
      console.log('free');
      return 0;
    }
    for (const h of holders) {
      const ageMin = ageMinutes(h.iso, Date.now());
      console.log(
        `held ${h.slug} pid=${h.pid} host=${h.host} age=${ageMin == null ? 'unknown' : ageMin + 'm'} scope=${scopeLabel(h.scope)}`,
      );
    }
    return 0;
  }

  const slug = positionals[0];
  if (!slug) {
    console.error(`landing-lock: "${cmd}" needs a <slug>`);
    return 5;
  }
  const lockPath = resolveLockPath();

  if (cmd === 'release') {
    // This command's own header invariant is "release always exits 0 — idempotent close-out must
    // never block a push." releaseAt() can throw a genuine fs error from EITHER side of its
    // read-modify-write: the read (readHolders propagates a transient, non-ENOENT read error
    // instead of silently treating it as free — plan 1678 batch review finding [0]) or the write
    // (plan 1733's atomic writeRegistry propagates a temp-write/rename/unlink failure — and
    // guarantees the registry kept its previous content). Either way, taking no action and
    // warning is the only choice consistent with never blocking AND never guessing at ownership
    // we can't verify. Only catch a genuine fs error here (has `.code`, e.g. EACCES/EBUSY/EISDIR)
    // — NOT withRegistryMutex's own "registry mutex wedged" throw (a plain Error with no `.code`,
    // a different, terminal repo-integrity signal that must keep surfacing immediately per its
    // own documented intent, never silently reported as a harmless glitch).
    let r;
    try {
      r = releaseAt(lockPath, { slug, force: flags.force === true });
    } catch (e) {
      if (!isGenuineFsError(e)) throw e;
      console.error(
        `landing-lock: could not read or rewrite the registry to release ${slug} (${e.message}) — registry keeps its previous content, treating as a no-op close-out.`,
      );
      return 0;
    }
    if (r.action === 'FOREIGN')
      console.error(
        `landing-lock: NOT releasing ${slug} — lock held by ${r.holder ? r.holder.slug : 'corrupt-file'} (use --force to override)`,
      );
    else if (r.action === 'NOT_FOUND')
      console.error(
        `landing-lock: --force release of ${slug} matched NO holder — registry UNTOUCHED. ` +
          `Current holder(s): ${(r.holders || []).map((h) => h.slug).join(', ')}. ` +
          `Re-run with the exact slug from \`status\`.`,
      );
    else console.log(r.action === 'NOOP' ? 'free (nothing to release)' : `released ${slug}`);
    return 0; // close-out must never be blocked by release
  }

  if (cmd === 'acquire') {
    let scope;
    try {
      scope = normalizeScope(flags.scope != null ? JSON.parse(flags.scope) : null);
    } catch (e) {
      console.error(`landing-lock: bad --scope: ${e.message}`);
      return 5;
    }
    return runAcquireLoop({
      lockPath,
      slug,
      scope,
      staleMin: flags['stale-min'] != null ? Number(flags['stale-min']) : DEFAULT_STALE_MIN,
      forceStale: flags['force-stale'] === true,
      wait: flags.wait === true,
      timeoutSec: flags['timeout-sec'] != null ? Number(flags['timeout-sec']) : DEFAULT_TIMEOUT_SEC,
      pollSec: flags['poll-sec'] != null ? Number(flags['poll-sec']) : DEFAULT_POLL_SEC,
    });
  }

  console.error(`landing-lock: unknown command "${cmd}"`);
  return 5;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    console.error('landing-lock:', e.message);
    process.exit(5);
  }
}
