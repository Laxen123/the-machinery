#!/usr/bin/env node
// Per-gate content-addressed pass-cache (plan 2462).
//
// WHAT THIS IS
// ------------
// The pre-push battery's EXPENSIVE gates — cross-package tsc, the vitest tiers, the pytest
// gate, the frontend production build, the WebKit mobile gate — re-run from scratch on every
// push, including the overwhelmingly common case this cache exists for: a patch-id-identical
// rebase re-push, where master moved but nothing a given gate READS changed. Plan 1824 solved
// exactly this for the `scripts/*.test.mjs` node:test battery; this module is the same idea
// generalized to one entry PER GATE.
//
// WHY A SIBLING MODULE AND NOT AN EXTENSION OF battery-pass-cache.mjs (plan 2462 judgment call)
// ---------------------------------------------------------------------------------------------
// The plan permits either ("extend … or a sibling module sharing its store/TTL/invalidate
// discipline"). Sibling wins, and not narrowly: 1824's key derivation is inseparable from
// TEST-SELECTION semantics — a canonical selection claim, universal twins, `selectionCovers`,
// per-selection prefix reachability. Every one of those exists because a battery run proves a
// SET OF TESTS, so one entry may or may not cover another entry's claim. A gate has no
// selection: `tsc -p backend` either ran green over this exact content or it did not. Folding
// gates into that module would mean threading a degenerate always-universal claim through
// every soundness pin it has — bloating the very code whose narrowness is what makes it
// trustworthy. What IS shared is the mechanical discipline, and that is shared by construction
// below: identical exit-code contract, identical TTL default and `isLive` fail direction,
// identical dirt refusal, identical telemetry shape, identical never-block close-out.
//
// THE ONE UNACCEPTABLE FAILURE MODE IS A STALE GREEN.
// Every design choice below therefore errs toward "run the gate":
//   * dirt anywhere in a gate's closure   → UNCACHEABLE (that gate runs)
//   * any git trouble                     → UNCACHEABLE (all gates run)
//   * unparseable / future entry timestamp → NOT live (the gate runs)
//   * a red run                           → actively invalidates its key
//   * an unknown gate name                → UNCACHEABLE, never a silent skip
//   * a probe-gated gate whose probe is
//     anything but a definite "required"  → UNCACHEABLE at BOTH check and record (plan 2491)
// A missed input would be unsound, so the closures below are DELIBERATELY COARSE (plan 2462's
// pinned mitigation): an over-broad closure only lowers the hit rate, and the target case — a
// rebase where NOTHING changed — hits regardless of coarseness.
//
// TOOL VERSIONS ARE KEYED BY LOCKFILE PROXY, NOT BY PROBING (plan 2462 judgment call)
// -----------------------------------------------------------------------------------
// The plan asks that "every key also includes the gate's tool version". Probing each gate's
// tool (`tsc --version`, `vitest --version`, `next --version`, `pytest --version`) would cost
// one subprocess PER GATE on EVERY push — defeating the millisecond fast path this cache
// exists to create. Instead every JS-tool closure includes `pnpm-lock.yaml`, which pins
// typescript/vitest/next/prettier/playwright exactly, and the pytest closure includes
// `backend/scripts/requirements.txt`. A version bump moves the lockfile oid and misses every
// affected gate. This is strictly COARSER than per-tool probing (an unrelated dependency bump
// also misses), i.e. the safe direction, at zero subprocess cost. `nodeMajor` and `gitVersion`
// are keyed directly, mirroring 1824.

// plan 2491: the mobile gate's required-vs-not probe spawns `verify-mobile-gate.mjs
// --detect-only`, so it needs `spawnSync` + `join` (and `existsSync`, already here). The
// storage-layer fs helpers this file used pre-2492 now live in the battery-pass-cache kernel
// and are deliberately NOT re-imported — the rebase that resolved 2492 against this plan
// dropped them on purpose.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseLockArgs } from './landing-lock.mjs';
// plan 4071 T4/D5: the gate registry is no longer a module-level literal — it is built from
// coord.config.json's `gates` key (empty core default `{}`) by `gatesFrom` below, and the CLI
// entry point (`main`) is the ONE place in this file that resolves the config, via the
// scripts-anchor root resolver rather than a fixed `..` count (every module here is one
// directory deeper than before plan 3962's move). Every other function that used to read the
// module-level `GATES` now takes the built registry as an explicit parameter — see this file's
// own exports (`gatesFrom`/`gateNames`/`probeGates`/`checkAllGates`/`allKeyedPaths`/`gateVerdict`/
// `probeVerdict`/`decideGates`) — so a `{}` registry (a config-less checkout) degrades every one
// of them to "no gate is cacheable" rather than crashing or assuming a gate name exists.
import { loadCoordConfig } from './coord-config.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';
// plan 3766: the ONE synchronous stdin reader every CLI/hook in this repo consuming a piped
// payload uses (see that module's own header for the read-failure-vs-no-input defect it
// closes) — `selection-key` below reads its newline-separated test-path selection through it
// rather than hand-rolling a second `readFileSync(0, 'utf8')` copy.
import { readStdinResult } from './stdin-read.mjs';
// The storage/TTL/telemetry KERNEL — the ONE implementation, shared with battery-pass-cache.mjs
// (plan 2492). Only the mechanics live there; KEY DERIVATION — everything below the registry —
// stays here, which is the sibling-module boundary this module's header argues for.
import {
  DEFAULT_TTL_MIN,
  EXIT_HIT,
  EXIT_MISS,
  EXIT_UNCACHEABLE,
  PRUNE_MIN_ENTRIES,
  entryPath,
  isLive,
  logTelemetry,
  makeGit,
  parseEntry,
  pruneExpired,
  readCacheEntry,
  removeCacheEntry,
  resolveCacheDir as resolveCacheDirIn,
  writeCacheEntry,
} from './pass-cache-kernel.mjs';

// Re-exported so this module stays the ONE import site for its own CLI, its tests and the
// done-worktree prep path — a caller never has to know which half of the pair owns a helper.
export {
  DEFAULT_TTL_MIN,
  EXIT_HIT,
  EXIT_MISS,
  EXIT_UNCACHEABLE,
  entryPath,
  isLive,
  logTelemetry,
  makeGit,
  parseEntry,
  pruneExpired,
  readCacheEntry,
  removeCacheEntry,
  writeCacheEntry,
};

// A SEPARATE dir from battery-pass-cache/: different key format, different prune policy, and a
// `status` listing that mixed the two would be unreadable.
export const resolveCacheDir = (git) => resolveCacheDirIn(git, 'gate-pass-cache');

export const GATE_CACHE_ARG_SPEC = Object.freeze({
  label: 'gate-pass-cache',
  // state-out (check-all only) / state-in (check only): plan 2527 item 2's cross-process
  // repo-state reuse — see serializeRepoState/deserializeRepoState/readStateFile above.
  value: Object.freeze(['key', 'label', 'gate', 'out', 'ttl-min', 'state-out', 'state-in']),
  boolean: Object.freeze([]),
});

// (DEFAULT_TTL_MIN — the same 240 min the battery cache uses, for the same lockfile-proxy reason
//  — and the EXIT_* contract now live in pass-cache-kernel.mjs and are re-exported above.)

// Bump when key derivation changes shape: the version is hashed INTO the key, so a bump
// orphans every old entry (they age out via prune rather than ever matching).
//
// v2 (plan 4071 review round 1, finding e14223): the key now also hashes the gate's own
// DEFINITION (desc/envUncacheable/probeName/probeScript — see computeGateKey), not only the
// content it covers. Bumping this ALONE would not have been the fix (it only invalidates once,
// at the moment of the bump) — the real fix is the new `def` component below; the version bump
// just documents that the shape changed and forces every pre-existing entry to miss on first
// read rather than silently resolving under a hash whose meaning moved.
export const KEY_FORMAT_VERSION = 2;

// --- probe-gated gates (plan 2491) -------------------------------------------
//
// A PROBE-GATED gate is one whose runner exits 0 for TWO different reasons: "I ran and
// passed" and "I decided I was not required for this range and never ran at all". Its exit
// code alone therefore cannot be recorded — that is exactly the stale green plan 2462's
// xhigh review caught on the WebKit mobile gate. `probe` on a registry entry names the
// function that disambiguates. It is consulted BEFORE the cache is read or written, and the
// gate is cacheable ONLY on a definite `required === true`. Everything else — not required,
// probe missing, probe crashed, probe output unparseable — lands on UNCACHEABLE, which the
// callers read as "run the gate, record nothing" (the gate's own ~50ms no-op fast path is
// what makes that cheap).
//
// WHY THE PROBE IS NOT PART OF `check-all`: check-all is the whole-battery fast path — ONE
// git probe, zero subprocesses per gate. A probe costs a node spawn AND must observe the
// same range/commit state the run that follows it observes, so a probe-gated gate is decided
// by its own `check --gate <name>` call AT ITS CALL SITE, immediately before the run.

// Parse `verify-mobile-gate.mjs --detect-only` output → true | false | null.
// `null` is UNKNOWN, and unknown is emphatically NOT "not required": both reach the same
// uncacheable outcome here, but conflating them in the parser would be one refactor away
// from treating silence as a licence to record.
export function parseRequiredProbe(text) {
  const hits = [...String(text ?? '').matchAll(/\brequired=(true|false)\b/g)].map((m) => m[1]);
  if (hits.length === 0) return null;
  // Contradictory output (a future gate printing both) is doubt, not a majority vote.
  if (new Set(hits).size !== 1) return null;
  return hits[0] === 'true';
}

// Run the mobile gate's required-vs-not-required probe. Returns { required, reason }.
//
// The probe inherits process.env and runs in the SAME cwd the gate run will use — deliberately
// NOT through `makeGit`'s scrubbed environment. makeGit scrubs GIT_* so the cache keys the repo
// the CWD selects; this probe must instead observe EXACTLY what the subsequent gate run
// observes (same range: VERIFY_MOBILE_RANGE / origin/master..HEAD under whatever GIT_* the hook
// exported). A probe that disagreed with its own run is the whole bug this plan exists to close.
export function probeMobileRequired({
  probeScript,
  _spawn = spawnSync,
  _existsSync = existsSync,
  cwd = process.cwd(),
  // Deliberately UNDER every caller's own bound (done-worktree's 60s execFileSync timeout,
  // the hook's `timeout 90`) so a wedged probe trips HERE, with a 'probe-failed' telemetry
  // line, rather than as an opaque outer kill. It is a git diff walk — ~50ms in practice.
  timeoutMs = 30_000,
} = {}) {
  // VERIFY_MOBILE_SKIP=1 is the documented bypass: the RUN exits 0 without launching WebKit
  // even when a watched surface changed. A bypassed run must never be recordable as a pass —
  // and since check and record both consult this, neither can credit one.
  if (process.env.VERIFY_MOBILE_SKIP === '1')
    return { required: null, reason: 'verify-mobile-skip' };
  // plan 4071 T4/D5: the script path is no longer a module-level literal (it was
  // `frontend/scripts/verify-mobile-gate.mjs`, vetapp's own path) — it is the calling gate's own
  // `probeScript` from coord.config.json, passed in by probeVerdict below. No configured script
  // degrades exactly like an absent one, never a crash.
  if (!probeScript) return { required: null, reason: 'probe-script-absent' };
  const script = join(cwd, probeScript);
  // A tree without frontend/ (a coord-only checkout, plan 1839's shape) simply has no probe.
  if (!_existsSync(script)) return { required: null, reason: 'probe-script-absent' };
  let r;
  try {
    r = _spawn(process.execPath, [script, '--detect-only'], {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
    });
  } catch {
    return { required: null, reason: 'probe-failed' };
  }
  if (!r || r.error || r.status !== 0) return { required: null, reason: 'probe-failed' };
  const required = parseRequiredProbe(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  if (required === null) return { required: null, reason: 'probe-unparseable' };
  return { required, reason: required ? 'required' : 'not-required' };
}

// The core-provided probes a gate entry's `probe` STRING may name (JSON cannot carry a function —
// plan 4071 D5). "mobile-required" names the PROTOCOL (spawn `<probeScript> --detect-only`, read a
// `required=true|false` line) — not any particular project's gate, so a project without this
// pattern at all simply never configures an entry with this probe name.
const PROBES = Object.freeze({
  'mobile-required': probeMobileRequired,
});

// The probe half of a gate's verdict: { ok: true } | { ok: false, reason }.
// Non-probe-gated gates pass through untouched, so every caller can call this unconditionally.
export function probeVerdict(gate, gates, { _probe } = {}) {
  const spec = gates[gate];
  if (!spec) return { ok: false, reason: 'unknown-gate' };
  if (!spec.probe) return { ok: true };
  const { required, reason } = (_probe ?? (() => spec.probe({ probeScript: spec.probeScript })))();
  if (required === true) return { ok: true };
  return {
    ok: false,
    reason: required === false ? 'gate-not-required' : (reason ?? 'probe-failed'),
  };
}

// --- the gate registry -------------------------------------------------------
//
// THIS IS THE INPUT-CLOSURE DEFINITION plan 2462 acceptance 4 requires to live in the
// implementing file — but plan 4071 T4/D5 moved the DATA (which gates exist, their `desc` /
// `paths` / `envUncacheable` / `probe` name / `probeScript`) into coord.config.json's `gates`
// key, empty core default `{}`. `gatesFrom` below is the ONE place that turns that config data
// into the registry shape every other function here consumes; the shape/type validation itself
// already lives in coord-config.mjs's `normalizeGates` (raw paths are non-empty strings, `desc`
// is a non-empty string, etc.) — this function's own job is resolving a `probe` NAME (JSON
// cannot carry a function) to the actual core-provided probe, which coord-config.mjs
// deliberately leaves to "wave 3" (this module) rather than duplicating the probe roster there.
//
// Each `paths` entry is a git pathspec (a tree or a blob); the gate's key is the HEAD oid of
// each. Read every closure as "if any of this content changes, that gate must re-run".
//
// `envUncacheable` lists gitignored files whose mere PRESENCE makes the gate uncacheable:
// untracked-and-ignored content git cannot key, but that the gate demonstrably reads.
//
// An unknown `probe` name is a CONFIG ERROR at load, never a silent uncached gate (plan 4071
// D5) — the alternative (falling through to an uncacheable gate) would hide a typo in
// coord.config.json behind "this gate just never happens to hit", which is much harder to
// notice than a load-time throw naming the bad value.
export function gatesFrom(config) {
  const raw = config?.gates ?? {};
  const out = {};
  for (const [name, entry] of Object.entries(raw)) {
    const outEntry = { desc: entry.desc, paths: Object.freeze([...entry.paths]) };
    if (entry.envUncacheable !== undefined) {
      outEntry.envUncacheable = Object.freeze([...entry.envUncacheable]);
    }
    if (entry.probeScript !== undefined) outEntry.probeScript = entry.probeScript;
    if (entry.probe !== undefined) {
      const fn = PROBES[entry.probe];
      if (!fn) {
        throw new Error(
          `gate-pass-cache: gates["${name}"].probe names unknown probe ${JSON.stringify(entry.probe)} ` +
            `(known: ${Object.keys(PROBES).join(', ') || '(none)'})`,
        );
      }
      outEntry.probe = fn;
      // plan 4071 review round 1 (finding e14223): the resolved probe is a FUNCTION — JSON.stringify
      // silently drops function-valued properties, so computeGateKey below cannot hash `probe`
      // itself into the cache key. Keeping the raw STRING name alongside it is what lets the key
      // derivation see a probe rename/removal as a real definition change.
      outEntry.probeName = entry.probe;
    }
    out[name] = Object.freeze(outEntry);
  }
  return Object.freeze(out);
}

// Every gate name in the registry, in declaration order.
export function gateNames(gates) {
  return Object.keys(gates);
}

// The split `check-all` needs (plan 2491): probe-gated gates are NOT decided by the battery
// fast path — see the probe section above. They still APPEAR in check-all's output file, as
// `uncacheable reason=probe-gated`, so the file stays total over the registry and a caller that
// forgot its own `check` call gets "run the gate", never a missing line it could misread.
export function probeGates(gates) {
  return gateNames(gates).filter((g) => gates[g].probe);
}
export function checkAllGates(gates) {
  return gateNames(gates).filter((g) => !gates[g].probe);
}

// A gate's full keyed closure: its configured `paths` PLUS its own `probeScript`, when it has
// one. Review fix round 2 (4071, finding 19bc63/2c054e): computeGateKey used to hash the gate's
// DEFINITION (desc/envUncacheable/probeName/probeScript — see computeGateKey's own comment) but
// only the probe SCRIPT'S NAME, never its content — so editing `probeScript`'s file (vetapp:
// `frontend/scripts/verify-mobile-gate.mjs`) with the gate's `paths` closure unchanged reused a
// stale key. `probeScript` is a repo-relative file path exactly like a `paths` entry, so folding
// it into the same closure list means every caller that already keys off `paths` (allKeyedPaths'
// git status/cat-file union, computeGateKey's oids, gateVerdict's dirt check and oid-availability
// check) picks up the probe script's content for free, with no separate code path to keep in
// sync. A gate whose `probeScript` already sits inside one of its own `paths` entries (vetapp's
// mobile-gate: `probeScript` is under the `frontend` tree already in `paths`) gets a harmless
// duplicate that `[...new Set(...)]` callers collapse.
function closurePaths(spec) {
  return spec.probeScript ? [...spec.paths, spec.probeScript] : spec.paths;
}

// Every path any gate keys — the single `git status` / `git ls-tree` probe covers this union,
// so one node process answers every gate (the whole point of `check-all`). `{}` (no gates
// configured) yields an empty union, never a crash.
export function allKeyedPaths(gates) {
  const out = new Set();
  for (const g of Object.values(gates)) for (const p of closurePaths(g)) out.add(p);
  return [...out].sort();
}

// --- pure helpers ------------------------------------------------------------

// Does `dirtyPath` fall inside `closurePath`? Exact blob match, or anything under a tree.
// Deliberately prefix-based: `git status` reports FILES, closures name trees.
export function pathCovers(closurePath, dirtyPath) {
  return dirtyPath === closurePath || dirtyPath.startsWith(`${closurePath}/`);
}

// Parse `git status --porcelain` into the plain file list. Handles the rename form
// (`R  old -> new`) by taking the destination, and strips the quoting git applies to paths
// with unusual bytes — an unparseable line is kept verbatim rather than dropped, because a
// dropped dirty path is a stale green and a spurious one only costs a hit.
export function parseStatusPaths(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const rest = line.slice(3).trim();
    // A rename reports BOTH sides (`R  old -> new`) and BOTH are dirt: the source path has
    // left its closure and the destination has entered one. Keeping only the destination
    // (the first cut) was a stale-green — `git mv backend/src/util.ts scripts/util.ts` staged
    // but uncommitted left the tsc/vitest/pytest closures looking clean while the tree those
    // gates actually compile no longer had the file (xhigh review finding, plan 2462).
    const arrow = rest.indexOf(' -> ');
    const parts =
      arrow === -1 ? [rest] : [rest.slice(0, arrow).trim(), rest.slice(arrow + 4).trim()];
    for (let p of parts) {
      if (!p) continue;
      if (p.startsWith('"') && p.endsWith('"') && p.length > 1) {
        try {
          p = JSON.parse(p);
        } catch {
          /* keep the quoted form — a path we cannot parse still counts as dirt */
        }
      }
      out.push(p);
    }
  }
  return out;
}

// Resolve `git cat-file --batch-check` output back onto the paths that produced it.
//
// WHY NOT `git ls-tree` (the 1824 cache's primitive) — a stale-green bug this plan's own
// negative controls caught before it shipped: `git ls-tree HEAD -- <paths>` EXPANDS an ancestor
// tree whenever a descendant is also in the pathspec. Our union pathspec contains both `backend`
// (the vitest closure) and `backend/src` / `backend/scripts` (the tsc and pytest closures), so
// git descended and returned the CHILDREN instead of the ancestor entries — `backend/src` came
// back absent, hashed as the literal 'absent', and edits under it did not move the key at all.
// `cat-file --batch-check` asks for each path's own object directly, so a directory always
// resolves to its own TREE oid (which already summarizes its full recursive content) and there
// is no pathspec-expansion semantics to get wrong. It is also ~70x cheaper than the obvious
// alternative (`ls-tree -r` over the union is 55k blobs / ~2s here; this is ~28ms).
//
// batch-check emits exactly ONE line per input line, in order, so the mapping is positional:
// a found object prints `<oid> <type> <size>`; anything else (`<input> missing`, `ambiguous`)
// is treated as absent, which hashes as 'absent' — absence is content too.
export function parseBatchCheck(paths, text) {
  const lines = String(text)
    .split('\n')
    .filter((l) => l.trim() !== '');
  const out = new Map();
  paths.forEach((p, i) => {
    const m = /^([0-9a-f]{40,}) (?:blob|tree|commit) \d+$/.exec(lines[i] ?? '');
    if (m) out.set(p, m[1]);
  });
  return out;
}

// The per-gate key: sha256 over the canonical JSON of the gate's own covered components. The
// gate NAME is hashed in, so two gates with identical closures (tsc-backend / tsc-shared,
// which read the same trees) can never collide and satisfy each other's lookups. A path absent
// from HEAD hashes as the literal 'absent' — absence is content too.
export function computeGateKey({ gate, oids, nodeMajor, gitVersion, gates }) {
  const spec = gates[gate];
  if (!spec) throw new Error(`unknown gate ${JSON.stringify(gate)}`);
  const components = {
    v: KEY_FORMAT_VERSION,
    gate,
    nodeMajor,
    gitVersion,
    // plan 4071 review round 1 (finding e14223): the gate's DEFINITION is now config data
    // (coord.config.json's `gates` key), not a frozen literal in this file — so redefining a
    // gate (dropping its probe, changing its probeScript, editing envUncacheable or desc) must
    // invalidate the key even when `paths` — and therefore `oids` below — happens to be
    // unchanged. Without this, deleting `probe: "mobile-required"` from a gate's config row
    // would keep the SAME key, so a later `check` would read a stale HIT recorded under the
    // gate's old (probe-gated) shape without ever consulting `probeVerdict` again.
    def: {
      desc: spec.desc,
      envUncacheable: spec.envUncacheable ?? [],
      probeName: spec.probeName ?? null,
      probeScript: spec.probeScript ?? null,
    },
    // Review fix round 2 (4071, finding 19bc63/2c054e): `closurePaths` folds `probeScript` in
    // alongside `paths` — see its own comment — so the probe script's CONTENT (not just its name,
    // already hashed above in `def`) moves this key the moment the script changes, with no
    // separate oid lookup to keep in sync with `paths`.
    oids: Object.fromEntries(closurePaths(spec).map((p) => [p, oids.get(p) ?? 'absent'])),
  };
  const key = createHash('sha256').update(JSON.stringify(components)).digest('hex').slice(0, 32);
  return { key, components };
}

// plan 3766: a SELECTION-scoped sibling of computeGateKey, for the ONE gate whose subset arm has
// a real per-file ledger (`pytest-backend-scripts`) but derives no whole-gate content key it is
// sound to record — the selection comes from the push RANGE, not from content, so two pushes of
// identical tree content can legitimately need different subsets (see pre-push.sh's own soundness
// note on $PYTEST_LEDGER_KEY). Folding the exact sorted file set into the hash alongside the
// gate's already-derived content key means: a FULL run over the same content key never collides
// with it (different gate closure, different components — well, same content key but a DIFFERENT
// selection array, since a full run has no `files` argument to this function at all and never
// calls it), and a BROADER or NARROWER subset over the identical content key gets a DIFFERENT key
// too (a different sorted file set hashes differently). Only a same-content, same-selection
// re-push can ever read back the same key — precisely the resume case this plan exists for.
//
// Deliberately a PURE function with no validation — the 32-hex shape check and the "malformed/
// empty ⇒ fail closed" contract belong to the CLI wrapper below (`selection-key`), which is the
// ONLY caller in production (pre-push.sh never imports this module as a library). Order- and
// duplicate-insensitive: `[...new Set(files)].sort()` collapses both before hashing, so
// `_select_tests.py`'s already-sorted output (or a caller's differently-ordered or
// duplicate-bearing list) always converges on the identical key for the identical SET of files.
// plan 3766 (gpt-review finding 7f2520): turn a readStdinResult() into the selection this
// command may act on, or `null` meaning "do not derive a key". Two distinct rejections collapse
// to that one null ON PURPOSE, because the caller's only safe response to either is the same
// empty ledger key:
//   - `ok: false` — the read FAILED. `raw` then carries whatever arrived before the error, which
//     may be a non-empty PREFIX of the real selection. Deriving from it would mint a key that
//     describes a narrower file set than the pytest run it is about to vouch for. A failed read
//     means the selection is UNKNOWN, never "this is the selection".
//   - a successful read that yields no non-blank path — genuinely nothing to key.
// Split out of the CLI body so the failed-read branch is unit-testable: fd 0 cannot be made to
// fail mid-read through the subprocess seam the other selection-key tests use.
export function selectionFilesFromStdin(result) {
  if (!result || result.ok !== true) return null;
  const files = (result.raw ?? '')
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line !== '');
  return files.length === 0 ? null : files;
}

export function deriveSelectionKey({ gate, contentKey, files }) {
  const sortedFiles = [...new Set(files)].sort();
  return createHash('sha256')
    .update(JSON.stringify(['selection', gate, contentKey, sortedFiles]))
    .digest('hex')
    .slice(0, 32);
}

// (parseEntry / isLive / makeGit / resolveCacheDir now live in pass-cache-kernel.mjs — the
//  storage/TTL discipline is identical in both caches and drifting copies were the debt.)

// --- git seam ----------------------------------------------------------------

// ONE git probe answering every gate. Returns
//   { ok: true, oids, gitVersion, nodeMajor, dirty: string[], root }
//   | { ok: false, reason }
// Note `dirty` is returned rather than refused globally: a dirty frontend file must not stop
// the pytest gate from hitting. Per-gate attribution happens in `gateVerdict`.
export function gatherRepoState(git, gates, { _existsSync = existsSync } = {}) {
  const paths = allKeyedPaths(gates);
  let status;
  try {
    status = git(['status', '--porcelain', '--untracked-files=normal', '--', ...paths]);
  } catch (e) {
    return { ok: false, reason: `git-status-failed: ${e.message}` };
  }
  let batch;
  try {
    // One process, one line per path, positional output — see parseBatchCheck for why this is
    // NOT `git ls-tree` (that primitive silently loses ancestor trees under our union pathspec).
    batch = git(['cat-file', '--batch-check'], `${paths.map((p) => `HEAD:${p}`).join('\n')}\n`);
  } catch (e) {
    return { ok: false, reason: `git-cat-file-failed: ${e.message}` };
  }
  let gitVersion;
  try {
    gitVersion = git(['version']).trim();
  } catch (e) {
    return { ok: false, reason: `git-version-failed: ${e.message}` };
  }
  // The repo root, resolved through the same injected `git` seam as everything else here — so
  // it is cwd-independent by the exact same construction `HEAD:<path>` already is (git resolves
  // `--show-toplevel` off its own `-C`/cwd discovery, not the ambient process.cwd()). This is
  // the anchor `gateVerdict`'s envUncacheable `existsSync` check below is threaded onto, instead
  // of resolving against whatever process.cwd() happens to be at call time.
  let root;
  try {
    root = git(['rev-parse', '--show-toplevel']).trim();
  } catch (e) {
    return { ok: false, reason: `git-toplevel-failed: ${e.message}` };
  }
  return {
    ok: true,
    oids: parseBatchCheck(paths, batch),
    gitVersion,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    dirty: parseStatusPaths(status),
    root,
    _existsSync,
  };
}

// --- cross-process state reuse (plan 2527 item 2) -----------------------------
//
// `check-all` and the mobile gate's own `check --gate mobile-gate` call are separate node
// processes, moments apart in the same hook run, asking the identical gatherRepoState()
// question over the identical allKeyedPaths() union (mobile-gate's own closure is part of
// that union — see allKeyedPaths). Serializing the ONE gather check-all already paid for and
// having `check` load it instead of re-deriving cuts a redundant git status + cat-file +
// version trio. `record`, by contrast, runs AFTER the real (up to 900s) gate — its own fresh
// gatherRepoState() call is the SOUNDNESS PIN that catches content drifting mid-run (see the
// `record` command below), so it deliberately does NOT participate in this reuse.
//
// Only the plain oid/dirty/version/root shape round-trips — `_existsSync` is a function and
// is never serialized; a caller loading a state back in always gets the real `existsSync`.
export function serializeRepoState(state) {
  return JSON.stringify({
    oids: Object.fromEntries(state.oids),
    gitVersion: state.gitVersion,
    nodeMajor: state.nodeMajor,
    dirty: state.dirty,
    root: state.root ?? '.',
  });
}

// Parses `serializeRepoState`'s output back into the shape `gatherRepoState` returns. ANY
// doubt — malformed JSON, a missing/mistyped field — returns `{ ok: false }` rather than
// throwing: every caller's contract is "not ok ⇒ gather fresh", never "not ok ⇒ crash".
export function deserializeRepoState(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `state-file-unparseable: ${e.message}` };
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.gitVersion !== 'string' ||
    typeof parsed.nodeMajor !== 'number' ||
    typeof parsed.root !== 'string' ||
    !Array.isArray(parsed.dirty) ||
    !parsed.oids ||
    typeof parsed.oids !== 'object'
  )
    return { ok: false, reason: 'state-file-malformed' };
  return {
    ok: true,
    oids: new Map(Object.entries(parsed.oids)),
    gitVersion: parsed.gitVersion,
    nodeMajor: parsed.nodeMajor,
    dirty: parsed.dirty,
    root: parsed.root,
  };
}

// Read + parse a --state-in file. Folds the fs read into the same "not ok ⇒ gather fresh"
// contract as deserializeRepoState — an absent or unreadable file is exactly as safe to fall
// back on as a malformed one, so callers never need to distinguish the two.
export function readStateFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, reason: 'state-file-unreadable' };
  }
  return deserializeRepoState(text);
}

// The per-gate decision, given an already-gathered state. Returns
//   { ok: true, key, components } | { ok: false, reason }
export function gateVerdict(state, gate, gates) {
  const spec = gates[gate];
  if (!spec) return { ok: false, reason: 'unknown-gate' };
  // Ignored-but-present content the gate reads and git cannot key (frontend/.env.local). `f` is
  // repo-root-relative, so it is anchored to `state.root` here — NOT resolved against the
  // ambient process.cwd() — matching the cwd-independence the oid gathering above already has.
  // `state.root` defaults to '.' (== process.cwd(), today's behavior) for callers/tests that
  // construct a state directly without going through `gatherRepoState`.
  const exists = state._existsSync ?? existsSync;
  const root = state.root ?? '.';
  for (const f of spec.envUncacheable ?? [])
    if (exists(join(root, f))) return { ok: false, reason: 'untracked-env-file' };
  // Dirt ANYWHERE in this gate's closure means the working tree — what the gate actually reads
  // — is not the HEAD content we would key on. `closurePaths` folds the gate's own `probeScript`
  // in alongside `paths` (review fix round 2, 4071, finding 19bc63/2c054e) so uncommitted edits
  // to the probe script itself are dirt too, exactly like any other closure member.
  const gateClosure = closurePaths(spec);
  const hit = state.dirty.find((d) => gateClosure.some((p) => pathCovers(p, d)));
  if (hit) return { ok: false, reason: 'dirty-gated-paths' };
  // A closure path absent from HEAD entirely is a repo shape this cache does not understand
  // (a partial checkout, a renamed tree). Refuse whenever ANY closure path is missing, not only
  // when ALL are — a missing path hashes as the literal 'absent' in computeGateKey, so a
  // genuinely different state of that path (present vs. absent) would otherwise key identically.
  if (!gateClosure.every((p) => state.oids.has(p))) return { ok: false, reason: 'no-gated-tree' };
  return {
    ok: true,
    ...computeGateKey({
      gate,
      oids: state.oids,
      nodeMajor: state.nodeMajor,
      gitVersion: state.gitVersion,
      gates,
    }),
  };
}

// (entryPath / readCacheEntry / writeCacheEntry / removeCacheEntry / pruneExpired / logTelemetry
//  now live in pass-cache-kernel.mjs — see the import block at the top.)

// --- the check-all core (pure over an injected state) -------------------------

// Decide every requested gate against the cache. Returns an array of
//   { gate, status: 'hit'|'miss'|'uncacheable', key?, reason?, iso? }
// `miss` still carries the key — that is what a green run records under.
//
// `probeResults` (plan 2527 item 1) — a `{ [gate]: { ok, reason? } }` map, the exact shape
// `probeVerdict` returns — is how a caller vouches for a PROBE-GATED gate (one with a `.probe`
// on its registry entry, e.g. mobile-gate). FAIL LOUD, not narrow-the-default: a probe-gated
// gate requested here with NO entry in `probeResults` throws, rather than silently falling
// through to gateVerdict's pure content check and risking exactly the stale-green plan 2491
// exists to prevent (an unconfirmed probe read as "not required"). An entry IS present but
// says `ok: false` is a different, legitimate case — the caller DID probe and the probe said
// not-required/failed/bypassed — so that reads as a normal 'uncacheable', never a throw.
// Deliberately NOT calling `probeVerdict` in here to fill a gap: the single-gate `check` CLI
// path already probed once before calling this, and probing again would spawn the mobile
// gate's detect-only subprocess a second time per push (see the CLI `check` command, and the
// item-2 note on gatherRepoState reuse — the same "don't re-derive what a caller already
// proved" principle applies to the probe as to the repo-state gather).
// `gates` is the REGISTRY (plan 4071 D5 — caller-injects, built by `gatesFrom` from
// coord.config.json); `only` is which of its names to decide, defaulting to every one of them.
export function decideGates({
  state,
  cacheDir,
  gates,
  only = gateNames(gates),
  nowMs,
  ttlMin,
  readEntry = readCacheEntry,
  probeResults = {},
}) {
  return only.map((gate) => {
    if (gates[gate]?.probe) {
      const pv = probeResults[gate];
      if (!pv)
        throw new Error(
          `decideGates: '${gate}' is probe-gated and requires an explicit probeResults['${gate}'] ` +
            'entry (the shape probeVerdict returns) — call probeVerdict(gate) at the call site ' +
            'and pass its result; decideGates must never guess, and must never call probeVerdict ' +
            'itself (that would probe twice).',
        );
      if (!pv.ok)
        return { gate, status: 'uncacheable', reason: pv.reason ?? 'probe-not-confirmed' };
    }
    const v = gateVerdict(state, gate, gates);
    if (!v.ok) return { gate, status: 'uncacheable', reason: v.reason };
    const entry = readEntry(cacheDir, v.key);
    if (isLive(entry, nowMs, ttlMin))
      return { gate, status: 'hit', key: v.key, iso: entry.iso, label: entry.label };
    return { gate, status: 'miss', key: v.key, reason: entry ? 'expired' : 'no-entry' };
  });
}

// Render decisions as the flat `<gate>.<field>=<value>` file the hook reads. Deliberately NOT
// shell-evalable: the hook greps values out of this file rather than `eval`ing generated text,
// so a cache file can never inject shell. Values are constrained by construction (statuses are
// an enum, keys are validated hex, gates come from the frozen registry) but the read side is
// non-executing regardless — defense in depth on the highest-blast-radius file in the repo.
export function renderDecisions(decisions) {
  const lines = [];
  for (const d of decisions) {
    lines.push(`${d.gate}.status=${d.status}`);
    if (d.key) lines.push(`${d.gate}.key=${d.key}`);
    if (d.reason) lines.push(`${d.gate}.reason=${d.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

// --- CLI ----------------------------------------------------------------------

function envDisabled() {
  // Both plan-1824 kill-switches govern the new per-gate entries too (plan 2462 task 4).
  // PREPUSH_FULL_BATTERY forces every gate to really run AND to not record — a forced full run
  // is outside the cache's contract, so recording it would be recording an unproven claim.
  return process.env.PREPUSH_NO_BATTERY_CACHE === '1' || process.env.PREPUSH_FULL_BATTERY === '1';
}

export function main() {
  const { cmd, flags } = parseLockArgs(process.argv.slice(2), GATE_CACHE_ARG_SPEC);
  if (!cmd) {
    console.error(
      'gate-pass-cache: no command (check-all|check|selection-key|record|invalidate|status|path|gates)',
    );
    return EXIT_UNCACHEABLE;
  }
  // plan 4071 T4/D5: the ONE place this file resolves coord.config.json — via the scripts-anchor
  // root resolver (never a fixed `..` count) — and builds the gate registry from it. A `{}` gates
  // key (a config-less checkout) degrades every command below to "no gate is cacheable", never a
  // throw or a false hit; `gatesFrom` itself is what throws on an unknown `probe` name, which is a
  // config-authoring error, not a runtime one.
  //
  // plan 4071 review round 1 (finding 190669): resolved LAZILY, not unconditionally at the top of
  // main() — `selection-key` (which `pre-push.sh` calls repeatedly, once per battery selection)
  // and `path`/`status`/`invalidate` never touch a gate definition, so they must not pay the
  // load+normalize cost of coord.config.json at all. `resolveGates()` is memoized with `??=` so
  // the commands that DO need it (`gates`/`check-all`/`check`/`record`) still resolve it exactly
  // ONCE per invocation, however many times their own body reads the registry.
  let _gates;
  const resolveGates = () =>
    (_gates ??= gatesFrom(loadCoordConfig(repoRootFrom(import.meta.dirname))));
  if (cmd === 'gates') {
    const gates = resolveGates();
    for (const g of gateNames(gates)) console.log(`${g}\t${gates[g].desc}`);
    return 0;
  }
  if (cmd === 'selection-key') {
    // plan 3766: `selection-key --gate <gate> --key <contentKey>`, fed newline-separated
    // repo-relative test paths on stdin, prints the derived selection-scoped key on stdout and
    // NOTHING ELSE. This command's own body probes no git state and touches no cache entry — it
    // is a pure derivation over its inputs, callable outside the check/record lifecycle entirely
    // (pre-push.sh's SUBSET arm calls it once, right where it already has the gate's own content
    // key in hand from `check`). `git`/`cacheDir` above are resolved unconditionally for every
    // command dispatched past `gates`/`path`, this one included, but neither is read here.
    //
    // FAILS CLOSED — no stdout, non-zero exit — on anything short of a genuine (gate, 32-hex
    // content key, non-empty selection) triple. This is the ONLY place that stands between a
    // caller and the trap this plan exists to avoid: battery-ledger.mjs treats any key that is
    // not exactly 32 lowercase hex chars as "malformed → deselect nothing / merge nothing" with
    // NO error surfaced, so a raw 64-hex sha256, an uppercase hex, or any other near-miss shape
    // would make the subset arm look wired while silently banking nothing. Validating the shape
    // HERE, before it ever reaches deriveSelectionKey (itself a pure, unvalidated hash — see its
    // own header), is what makes that failure mode unreachable through this CLI.
    const gate = flags.gate;
    if (typeof gate !== 'string' || !gate || gate.startsWith('--')) {
      console.error('gate-pass-cache: selection-key needs --gate <gate>');
      return EXIT_UNCACHEABLE;
    }
    const contentKey = flags.key;
    if (typeof contentKey !== 'string' || !/^[0-9a-f]{32}$/.test(contentKey)) {
      console.error('gate-pass-cache: selection-key needs a 32-lowercase-hex --key <contentKey>');
      return EXIT_UNCACHEABLE;
    }
    // readStdinRESULT, not readStdin: the fail-open wrapper hands back `.raw` even when the read
    // FAILED, so a pipe that dies after delivering part of the selection would otherwise derive a
    // key for a truncated file set (gpt-review finding 7f2520). selectionFilesFromStdin folds
    // "read failed" and "nothing selected" into one null — see its header for why both must.
    const files = selectionFilesFromStdin(readStdinResult());
    if (files === null) {
      console.error(
        'gate-pass-cache: selection-key needs a non-empty selection on stdin that read cleanly',
      );
      return EXIT_UNCACHEABLE;
    }
    console.log(deriveSelectionKey({ gate, contentKey, files }));
    return 0;
  }

  const git = makeGit();
  const cacheDir = resolveCacheDir(git);
  if (cmd === 'path') {
    console.log(cacheDir);
    return 0;
  }
  const ttlMin = (() => {
    const raw = flags['ttl-min'];
    const n = Number(raw ?? DEFAULT_TTL_MIN);
    if (!Number.isFinite(n) || n < 0)
      throw new Error(`--ttl-min must be a non-negative number, got ${JSON.stringify(raw)}`);
    return n;
  })();

  if (cmd === 'status') {
    let names = [];
    try {
      names = readdirSync(cacheDir).filter((n) => n.endsWith('.json'));
    } catch {
      /* no dir yet */
    }
    const nowMs = Date.now();
    let shown = 0;
    for (const name of names) {
      const e = readCacheEntry(cacheDir, name.replace(/\.json$/, ''));
      if (!isLive(e, nowMs, ttlMin)) continue;
      console.log(`${e.gate ?? '?'}\t${e.iso}\t${e.label ?? '?'}\t${name.replace(/\.json$/, '')}`);
      shown += 1;
    }
    if (shown === 0) console.log('empty');
    return 0;
  }

  if (cmd === 'check-all') {
    const out = flags.out;
    if (typeof out !== 'string' || !out || out.startsWith('--')) {
      console.error('gate-pass-cache: check-all needs --out <file>');
      return EXIT_UNCACHEABLE;
    }
    const gates = resolveGates();
    // A disabled cache still writes the file — every gate uncacheable — so the hook has one
    // code path and never has to distinguish "no file" from "no hits".
    if (envDisabled()) {
      const reason =
        process.env.PREPUSH_NO_BATTERY_CACHE === '1' ? 'disabled-by-env' : 'forced-full-battery';
      writeFileSync(
        out,
        renderDecisions(gateNames(gates).map((gate) => ({ gate, status: 'uncacheable', reason }))),
      );
      logTelemetry(cacheDir, `UNCACHEABLE-ALL reason=${reason}`);
      return EXIT_UNCACHEABLE;
    }
    const state = gatherRepoState(git, gates);
    if (!state.ok) {
      const reason = state.reason.split(':')[0];
      writeFileSync(
        out,
        renderDecisions(gateNames(gates).map((gate) => ({ gate, status: 'uncacheable', reason }))),
      );
      console.error(`gate-pass-cache: uncacheable — ${state.reason}`);
      logTelemetry(cacheDir, `UNCACHEABLE-ALL reason=${reason}`);
      return EXIT_UNCACHEABLE;
    }
    // plan 2527 item 2: hand this exact gather to a later probe-gated `check` call in the same
    // hook run (see serializeRepoState's header comment) — best-effort only. A caller that
    // never passes --state-out gets `undefined`, which serializeRepoState/writeFileSync never
    // see; a write failure here (a read-only tmp dir, disk full) must never fail check-all
    // itself, so it is swallowed exactly like every other close-out in this file.
    const stateOut = flags['state-out'];
    if (typeof stateOut === 'string' && stateOut && !stateOut.startsWith('--')) {
      try {
        writeFileSync(stateOut, serializeRepoState(state));
      } catch {
        /* best-effort — a later `check --state-in` simply falls back to a fresh gather */
      }
    }
    // Probe-gated gates are deliberately not decided here (plan 2491) — they need a subprocess
    // probe pinned to their own call site's range. They are still listed, as uncacheable.
    const decisions = [
      ...decideGates({
        state,
        cacheDir,
        gates,
        only: checkAllGates(gates),
        nowMs: Date.now(),
        ttlMin,
      }),
      ...probeGates(gates).map((gate) => ({ gate, status: 'uncacheable', reason: 'probe-gated' })),
    ];
    writeFileSync(out, renderDecisions(decisions));
    for (const d of decisions)
      logTelemetry(
        cacheDir,
        `${d.status.toUpperCase()} gate=${d.gate}${d.key ? ` key=${d.key}` : ''}${d.reason ? ` reason=${d.reason}` : ''}`,
      );
    const hits = decisions.filter((d) => d.status === 'hit').length;
    console.error(`gate-pass-cache: ${hits}/${decisions.length} gate(s) cached green`);
    return hits > 0 ? EXIT_HIT : EXIT_MISS;
  }

  if (cmd === 'check') {
    const gates = resolveGates();
    const gate = flags.gate;
    if (typeof gate !== 'string' || !gates[gate]) {
      console.error(`gate-pass-cache: check needs a known --gate (${gateNames(gates).join('|')})`);
      return EXIT_UNCACHEABLE;
    }
    if (envDisabled()) {
      logTelemetry(cacheDir, `UNCACHEABLE gate=${gate} reason=disabled-by-env`);
      return EXIT_UNCACHEABLE;
    }
    // THE PROBE COMES FIRST (plan 2491). For a probe-gated gate, anything short of a definite
    // "required for this exact range" is UNCACHEABLE: no key on stdout, so the caller runs the
    // gate (which self-no-ops in ~50ms when it was not required) and its gate_close is a no-op.
    const pv = probeVerdict(gate, gates);
    if (!pv.ok) {
      console.error(`gate-pass-cache: uncacheable — ${pv.reason}`);
      logTelemetry(cacheDir, `UNCACHEABLE gate=${gate} reason=${pv.reason}`);
      return EXIT_UNCACHEABLE;
    }
    // plan 2527 item 2: reuse the repo state check-all already gathered over the identical
    // allKeyedPaths() union, rather than re-deriving it (a second git status + cat-file +
    // version trio for content check-all already covered moments earlier). --state-in is
    // best-effort ONLY — a missing file, a stale flag, or malformed JSON all fall back to a
    // fresh gather (readStateFile/deserializeRepoState's own fail-safe), so a caller that omits
    // it, or whose state file went stale, behaves exactly as before this item.
    const stateIn = flags['state-in'];
    const loaded =
      typeof stateIn === 'string' && stateIn && !stateIn.startsWith('--')
        ? readStateFile(stateIn)
        : { ok: false };
    const state = loaded.ok ? loaded : gatherRepoState(git, gates);
    if (!state.ok) {
      console.error(`gate-pass-cache: uncacheable — ${state.reason}`);
      logTelemetry(cacheDir, `UNCACHEABLE gate=${gate} reason=${state.reason.split(':')[0]}`);
      return EXIT_UNCACHEABLE;
    }
    const [d] = decideGates({
      state,
      cacheDir,
      gates,
      only: [gate],
      nowMs: Date.now(),
      ttlMin,
      probeResults: { [gate]: pv },
    });
    if (d.status === 'uncacheable') {
      console.error(`gate-pass-cache: uncacheable — ${d.reason}`);
      logTelemetry(cacheDir, `UNCACHEABLE gate=${gate} reason=${d.reason}`);
      return EXIT_UNCACHEABLE;
    }
    // stdout is the key and ONLY the key — the hook captures it.
    console.log(d.key);
    if (d.status === 'hit') {
      console.error(
        `gate-pass-cache: HIT ${gate} — identical gated content passed @ ${d.iso} (${d.label ?? '?'})`,
      );
      logTelemetry(cacheDir, `HIT gate=${gate} key=${d.key}`);
      return EXIT_HIT;
    }
    logTelemetry(cacheDir, `MISS gate=${gate} key=${d.key} reason=${d.reason}`);
    return EXIT_MISS;
  }

  if (cmd === 'record') {
    // record/invalidate ALWAYS exit 0 — they are close-out commands and must never block a
    // push. Refusals are logged to stderr + telemetry only.
    const gates = resolveGates();
    const gate = flags.gate;
    const key = flags.key;
    if (typeof key !== 'string' || !key || key.startsWith('--')) {
      console.error('gate-pass-cache: record needs --key <key> — nothing done');
      return 0;
    }
    if (typeof gate !== 'string' || !gates[gate]) {
      console.error('gate-pass-cache: record needs a known --gate — nothing done');
      return 0;
    }
    if (envDisabled()) {
      logTelemetry(cacheDir, `RECORD-REFUSED gate=${gate} reason=disabled-by-env`);
      return 0;
    }
    // THE STALE-GREEN PIN (plan 2491). A probe-gated gate may only record a run the probe
    // STILL calls required — re-asked here, after the run, rather than trusted from whatever
    // the caller checked under. A caller that skipped the check, a VERIFY_MOBILE_SKIP=1 bypass,
    // or master moving mid-run so the range no longer needs the gate: all refuse. Refusing a
    // legitimate pass costs one cache entry; recording an illegitimate one costs the invariant.
    const pv = probeVerdict(gate, gates);
    if (!pv.ok) {
      console.error(`gate-pass-cache: record refused for ${gate} — ${pv.reason}`);
      logTelemetry(cacheDir, `RECORD-REFUSED gate=${gate} reason=${pv.reason}`);
      return 0;
    }
    const state = gatherRepoState(git, gates);
    if (!state.ok) {
      logTelemetry(cacheDir, `RECORD-REFUSED gate=${gate} reason=${state.reason.split(':')[0]}`);
      return 0;
    }
    const v = gateVerdict(state, gate, gates);
    if (!v.ok) {
      logTelemetry(cacheDir, `RECORD-REFUSED gate=${gate} reason=${v.reason}`);
      return 0;
    }
    // THE SOUNDNESS PIN: re-derive the key here and refuse if it drifted from the --key the
    // caller checked under. A drift means the repo mutated between check and record (a
    // parallel session's commit, a mid-run edit) — recording would attribute THIS run's green
    // to content it did not actually gate. Mirrors the 1824 cache's key-mismatch refusal.
    if (v.key !== key) {
      console.error(
        `gate-pass-cache: record refused for ${gate} — key drifted (content changed mid-run)`,
      );
      logTelemetry(cacheDir, `RECORD-REFUSED gate=${gate} reason=key-mismatch`);
      return 0;
    }
    const nowMs = Date.now();
    try {
      writeCacheEntry(cacheDir, key, {
        iso: new Date(nowMs).toISOString(),
        gate,
        label: typeof flags.label === 'string' ? flags.label : undefined,
        components: v.components,
      });
      logTelemetry(cacheDir, `RECORD gate=${gate} key=${key}`);
    } catch (e) {
      logTelemetry(cacheDir, `RECORD-REFUSED gate=${gate} reason=write-failed`);
      console.error(`gate-pass-cache: record failed — ${e.message}`);
      return 0;
    }
    // Prune under the DEFAULT policy, never a caller's --ttl-min: a short-lived override must
    // not evict another session's still-live entry. Throttled by entry count (plan 2492) so the
    // common close-out — a dir holding a handful of entries — does not parse every one of them.
    pruneExpired(cacheDir, nowMs, DEFAULT_TTL_MIN, { minEntries: PRUNE_MIN_ENTRIES });
    return 0;
  }

  if (cmd === 'invalidate') {
    const key = flags.key;
    if (typeof key !== 'string' || !key || key.startsWith('--')) {
      console.error('gate-pass-cache: invalidate needs --key <key> — nothing done');
      return 0;
    }
    try {
      const gone = removeCacheEntry(cacheDir, key);
      logTelemetry(cacheDir, `INVALIDATE key=${key} removed=${gone ? 1 : 0}`);
    } catch (e) {
      console.error(`gate-pass-cache: invalidate — ${e.message}`);
    }
    return 0;
  }

  console.error(`gate-pass-cache: unknown command ${cmd}`);
  return EXIT_UNCACHEABLE;
}

// Only run as a CLI when invoked directly — the module is imported by tests and by the
// done-worktree prep path.
//
// The identity test (`import.meta.url` vs `argv[1]`) rather than the basename `endsWith` this
// carried before plan 4061: `endsWith` matches on BASENAME, so once the library half moves to
// `scripts/coord/gate-pass-cache.mjs` (coord-core step 4) behind a shim that keeps the invoked
// path `scripts/gate-pass-cache.mjs`, `argv[1]` STILL ends with `gate-pass-cache.mjs` and this
// block would fire in the moved module as well as in the shim — running the CLI twice. The
// identity form goes correctly inert in the moved copy. Behaviour is unchanged today: under a
// direct `node scripts/gate-pass-cache.mjs` both spellings are true, and under an import both
// are false.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let code;
  try {
    code = main();
  } catch (e) {
    // Fail-safe: any uncaught error reads as "no cache, run the gate". `record`/`invalidate`
    // callers `|| true` the call anyway, so this can only ever cost a run, never skip one.
    console.error(`gate-pass-cache: ${e?.message ?? e}`);
    code = EXIT_UNCACHEABLE;
  }
  process.exit(code);
}
