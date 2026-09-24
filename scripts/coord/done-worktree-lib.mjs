// scripts/coord/done-worktree-lib.mjs
// Pure logic for the done-worktree single-call spine (plan 333).
// No fs, no child_process, no git AT CALL TIME — every function this module defines directly is
// a total function of its inputs, so it can be node:test-unit-tested. The IO shell
// (done-worktree.mjs) feeds it git output and consumes its decisions.
//
// (index-lib.mjs is likewise pure — git-/fs-free string mutation of docs/INDEX.md
// — so importing its bullet helpers keeps this module's "total function" contract.)
//
// One IO-module import exists (plan 980): the three transient-index-write classifiers are
// RE-EXPORTED from coord-git.mjs (see near the bottom of this file). They are pure string
// predicates and coord-git executes no IO at import, so the re-export does not break the
// unit-testability contract — it just avoids a duplicated regex that could drift.
//
// plan 3961 T2.5/T2.6/T2.7c moved the project-shaped functions (the wiki/status-flip/price-clinic
// seams, the price-trust baseline data, the pytest-preflight closure, the deploy wall) out to
// scripts/project/*.mjs; plan 4096 T2 then removed the pass-through re-exports of them and MOVED
// this module under scripts/coord/ (it was core by usage — every land-spine module reads it as
// `L`). Rule 3 now applies to it: it imports only its scripts/coord/** siblings. Every sibling it
// imports performs no IO AT IMPORT TIME, whatever IO its own functions may do once CALLED —
// done-worktree-lib.test.mjs's "performs no IO at import time" test proves it for the whole
// aggregate graph empirically (a fresh process, a cwd that resolves to no git repository at all).

import { ACTIVE_END_RX, insertArchiveNarrativeLine } from './index-lib.mjs';
// Same contract as the coord-git re-export above: landing-lock.mjs runs no IO at
// import (its CLI main() is entrypoint-guarded), and importing its DEFAULT_STALE_MIN
// keeps the reclaim gate's staleness threshold the SAME constant the lock's own
// STALE verdict uses — a hand-copied 35 here would silently diverge on any retune.
import { DEFAULT_STALE_MIN } from './landing-lock.mjs';
// plan 1000: formatConflictCulprits is a PURE string formatter (no git/fs); land-lib
// runs no IO at import (it only defines git-wrapping functions), so importing it here is
// consistent with the coord-git re-export rationale above and keeps this module's
// total-function contract.
import { formatConflictCulprits } from './land-lib.mjs';
// Reuse build-index's frontmatter parser so the archive note's summary is byte-
// identical to the docs/INDEX.md bullet's (same quote-unwrap, same single-line
// scalar handling) — see planSummary below (plan 427).
import {
  readFrontmatterSummary,
  escapeRegex,
  readFrontmatterScalar,
  stripFrontmatter,
} from './build-index-lib.mjs';
// plan 3960 cluster-4 review fix: capturingGroups is the SAME scanner coord-config.mjs's own
// shardIdPattern validator counts groups with (countCaptureGroups, built on it) — pure, no IO,
// same "safe to import a value/pure-function export" precedent as the DEFAULTS/LEGACY_PATHS
// import beside it. See deriveShardPatterns below for why sharing this implementation (instead
// of this module hand-rolling its own capture-group regex) is the actual fix.
import { LEGACY_PATHS, DEFAULTS, capturingGroups } from './coord-config.mjs';
// plan 4096 T1/S9: the watched-surface predicate (`mobilePreflightNeeded`) and the mobile
// gate's port-collision classifier (`isPortCollision`) USED to be defined here over an import of
// verify-mobile-watched.mjs. Both moved to scripts/project/land-gate-mobile.mjs, the mobile gate's
// own module and their only consumer, once the four-gate carry-forward roster below stopped
// hand-listing gates and started taking the registry-derived predicate table instead.
// plan 3954 T2: the spawn-starvation NTSTATUS signature set — a dependency-free, IO-free data +
// predicate module (same contract as this file's own header), so importing it here keeps the
// "no fs, no child_process, no git" property intact.
import { looksSpawnStarved } from './spawn-failure-signatures.mjs';
import { parseWorktreePorcelain } from './worktree-porcelain.mjs';
// plan 2891 T4: the shared session-entry date shape. build-handoff-lib.mjs imports NOTHING
// (a pure renderer core), so this import keeps this module's fs-/child_process-free contract.
import { SESSION_ENTRY_DATE_SHAPE } from './build-handoff-lib.mjs';
// plan 2875 delta round 4 (finding 08dcf5, review fix): round 3's import of gate-pass-cache.mjs
// (for GATES/pathCovers, so pytestPreflightNeeded's closure could be DERIVED from the canonical
// one rather than hand-copied) is REVERTED here. It satisfied the dedup goal but broke a more
// important one: this module's own header pins "No fs, no child_process, no git" specifically so
// EVERY coord entrypoint that imports it (claim-plan, record-review, record-wiki, drain-run,
// done-worktree) keeps loading in a PARTIAL checkout — coord-sharing.md's declared-subset adoption
// model means a sibling can adopt this file without also adopting every file it transitively
// reaches. gate-pass-cache.mjs pulls in pass-cache-kernel.mjs, which pulls in node:child_process
// and node:fs — a checkout missing either file now crashes all five entrypoints at import
// (ERR_MODULE_NOT_FOUND), which is exactly the failure mode done-worktree-lib.test.mjs's own
// "module-load safety" test exists to catch, and is a worse failure than the drift the dedup
// closed. The durable fix is extracting the pytest closure + a path-prefix matcher into their own
// dependency-free sibling module that BOTH this file and gate-pass-cache.mjs import from — that
// needs an edit to gate-pass-cache.mjs, out of this round's allowlist, so it is not done here.
// Until then PYTEST_PREFLIGHT_CLOSURE below is a second, independently-maintained copy of the same
// list coord.config.json's `gates['pytest-backend-scripts'].paths` row owns (plan 4071) — keep them in sync by
// hand on any change to either. done-worktree-lib.test.mjs's "fires on every path GATES[...]
// names" test reads the CANONICAL list live and asserts against this predicate, so any drift
// between the two copies fails that test rather than passing silently.
// plan 3815: disk-headroom.mjs (its own module, node built-ins only) is the IO shell for the
// cloud land's disk-headroom gate — the actual `prune`/`checkFreeBytes` fs calls stay OUT of this
// file for the identical "no fs, no child_process, no git" reason the gate-pass-cache.mjs import
// was reverted immediately above: importing them here would make every coord entrypoint that
// loads this module (claim-plan, record-review, record-wiki, drain-run, done-worktree) pull in
// fs-performing code at import time. `DEFAULT_FLOOR_BYTES` and `formatBytes` are the two exports
// disk-headroom.mjs itself verifiably runs no IO to produce — same precedent as the
// landing-lock.mjs / land-lib.mjs / railway-domains.mjs imports above (a value/pure-function
// import from a module that performs IO only in OTHER exports, never at import time, is the
// established exception here, not a new one). The done-worktree.mjs cloud land path is the
// caller that imports disk-headroom.mjs's `prune`/`checkFreeBytes` directly and feeds their
// results into `diskHeadroomLowMessage` below.
import { DEFAULT_FLOOR_BYTES, formatBytes } from './disk-headroom.mjs';
// plan 4096 T1/S9: the `pytestPreflightNeeded` import that used to sit here is GONE. The pytest
// gate's predicate reaches the carry-forward roster below as that gate's own registry `applies`
// (scripts/project/land-gate-pytest.mjs's `pytestPrepGateEntry`), never as a lib import.

// plan 3961 T3.3b: the lane is an opaque token everywhere except this producer and the two
// spine comparisons that branch on it (done-worktree.mjs's landing-lock acquire and its
// releaseHeadTenureAfterRequeue early-return) — those three sites, plus this producer, are the
// ONLY ones rewritten to the constants below. Every OTHER 'seed' string literal in this file and
// in landing-queue*.mjs (recorded in the plan 3961 body) is deliberate and stays untouched: the
// strings themselves are external protocol values written into queue/board rows and logs, so
// the values stay byte-identical — only the source of truth for typing them moves here.
export const EXCLUSIVE_LANE = 'seed';
export const FREE_LANE = 'free';

/**
 * @param {string[]} changedFiles paths from `git diff --name-only origin/master...HEAD`
 * @param {string|null} seedLaneFile repo's configured seed-lane file (null ⇒ no monolith lane)
 * @param {string|null} seedShardDir repo's sharded seed root (plan 1300; null ⇒ no shard layout)
 */
export function detectLane(changedFiles, seedLaneFile, seedShardDir = null, derived = {}) {
  return seedScopeOf(changedFiles, seedLaneFile, seedShardDir, derived) === null
    ? FREE_LANE
    : EXCLUSIVE_LANE;
}

// plan 3960 (coord-core step 2): SHARD_REL_SRC / ORDER_MANIFEST_REL_SRC / DERIVED_SHARD_REL_SRC
// (further below) are all BUILT from ONE config key, `shardIdPattern` (coord-config.mjs's
// DEFAULTS — a pure, already-computed constant, never IO; this module's "no fs, no
// child_process, no git" contract is unaffected). `deriveShardPatterns` is pure and exported
// so a test can prove the derivation independently of the module-scope constants below, and so
// a future caller with a genuinely different `shardIdPattern` (a sibling project) gets the same
// three regex sources this one produces for vetapp's today value.
//
// The derivation, in order:
//   1. shardRelSrc — the pattern itself, unchanged.
//   2. orderManifestRelSrc — the pattern's DIRECTORY portion (everything before the last `/`)
//      with its `[A-Z]{2}` country-code fragment turned into a capture group, followed by the
//      literal `order\.json` filename. For today's default this reproduces
//      'clinics/([A-Z]{2})/order\\.json' byte-for-byte.
//   3. derivedShardRelSrc — the pattern's OWN capture-group content (the clinic-id fragment,
//      e.g. `clinic-\d+`), re-wrapped as `(<content>)(?:\.json$|/)` — the shape a derived-data
//      root needs to match either a flat per-clinic file or a per-clinic subtree. For today's
//      default this reproduces '(clinic-\\d+)(?:\\.json$|/)' byte-for-byte.
// Both derivations assume the vetapp-specific "clinics/<CC>/<file>" shape (a literal
// `[A-Z]{2}` country-code segment in the directory portion, and exactly one capture group in
// the pattern) — coord-config.mjs's own validation only requires "compiles + exactly one
// capture group" (project-agnostic), so THIS module is where the extra vetapp assumption
// lives, and it throws loudly (at module load) rather than silently deriving nonsense if a
// future `shardIdPattern` breaks either assumption.
//
// plan 4071: `null` means "no sharded records" — coord-config.mjs's own `normalizeShardIdPattern`
// already gives that meaning to a null `shardIdPattern` (the same contract `seedShardDir` has),
// so this function returns `null` right back rather than throwing on the property access a bare
// literal would need. A malformed NON-null pattern still throws loudly, unchanged.
export function deriveShardPatterns(shardIdPattern) {
  if (shardIdPattern == null) return null;
  const lastSlash = shardIdPattern.lastIndexOf('/');
  if (lastSlash === -1) {
    throw new Error(
      `deriveShardPatterns: shardIdPattern ${JSON.stringify(shardIdPattern)} has no "/" — ` +
        'expected a "<dir>/<file>" shape (e.g. "clinics/[A-Z]{2}/(clinic-\\\\d+)\\\\.json")',
    );
  }
  const dirPart = shardIdPattern.slice(0, lastSlash);
  if (!dirPart.includes('[A-Z]{2}')) {
    throw new Error(
      `deriveShardPatterns: shardIdPattern's directory portion ${JSON.stringify(dirPart)} does ` +
        'not contain a literal "[A-Z]{2}" country-code fragment — cannot derive ' +
        'ORDER_MANIFEST_REL_SRC (the per-country order-manifest pattern)',
    );
  }
  const orderManifestRelSrc = `${dirPart.replace('[A-Z]{2}', '([A-Z]{2})')}/order\\.json`;
  // plan 3960 cluster-4 review fix: this used to be `shardIdPattern.match(/\(([^()]+)\)/)` — the
  // FIRST parenthesis in the string, full stop, regardless of whether it was a real capturing
  // group. coord-config.mjs's own shardIdPattern validator (normalizeShardIdPattern) deliberately
  // ACCEPTS a pattern whose first group is non-capturing (`(?:…)`) or a lookaround (`(?=…)` /
  // `(?!…)` / `(?<=…)` / `(?<!…)`) as long as exactly ONE group elsewhere is a real capture — so a
  // validator-accepted pattern like `clinics/(?:[A-Z]{2})/(clinic-\d+)\.json` used to have its
  // clinic-id fragment silently mis-derived as the CONTENTS of the non-capturing group instead of
  // the real one. capturingGroups (imported from coord-config.mjs — the SAME scanner the
  // validator counts groups with) finds the first GENUINE capturing group, so this can never
  // again disagree with what the validator already proved the pattern contains: exactly one.
  const groups = capturingGroups(shardIdPattern);
  if (groups.length === 0) {
    throw new Error(
      `deriveShardPatterns: shardIdPattern ${JSON.stringify(shardIdPattern)} has no capture ` +
        'group — cannot derive DERIVED_SHARD_REL_SRC (the clinic-id fragment)',
    );
  }
  const derivedShardRelSrc = `(${groups[0].content})(?:\\.json$|/)`;
  return { shardRelSrc: shardIdPattern, orderManifestRelSrc, derivedShardRelSrc };
}

// plan 4071: coord-config.mjs's CORE `DEFAULTS.shardIdPattern` is now `null` (a config-less
// repo has no per-clinic shard filename shape) — vetapp's own value lives as a row in vetapp's
// `coord.config.json` instead, and reaches this module only through a CALLER-supplied override
// (seedScopeOf's `derived.shardIdPattern`, shardFileRx/orderManifestRx/derivedShardRx's own
// override params — see spine.mjs's `cfg.shardIdPattern` threading for the real caller). So
// `SHARD_PATTERNS` here is deliberately derived from the BARE core default, which is null, and
// deriveShardPatterns(null) returns null rather than throwing (see its own comment) — this
// module must not fail to LOAD just because the core carries no default to fall back to.
const SHARD_PATTERNS = deriveShardPatterns(DEFAULTS.shardIdPattern);

// A regex-source fragment that matches nothing (JS has no literal for "never match"; a negative
// lookahead on the empty pattern always fails since the empty pattern always succeeds). This is
// what SHARD_REL_SRC / ORDER_MANIFEST_REL_SRC / DERIVED_SHARD_REL_SRC — and so shardFileRx /
// orderManifestRx / derivedShardRx's own defaults — degrade to when no `shardIdPattern` reaches
// this module at all: "no shard layout" must mean "recognizes no shard files", never a thrown
// TypeError from interpolating `null` into a RegExp source string.
const NEVER_MATCH_REL_SRC = '(?!)';

// THE one encoding of a per-clinic shard filename, relative to the shard root:
// `clinics/<CC>/<clinic-id>.json`, capture group 1 = the clinic id. Every coord
// matcher derives from this string (seedScopeOf / statusFlipSeam here, the
// done-worktree gate views via shardFileRx) so the layout pattern cannot drift
// between gates (plan-1300 review finding 9 — previously three hand-rolled copies).
export const SHARD_REL_SRC = SHARD_PATTERNS?.shardRelSrc ?? NEVER_MATCH_REL_SRC;
export const ORDER_MANIFEST_REL_SRC = SHARD_PATTERNS?.orderManifestRelSrc ?? NEVER_MATCH_REL_SRC;

/**
 * The anchored per-clinic shard-path regex under a configured shard root.
 * `shardRelSrc` (plan 3960 cluster-1 review fix) defaults to the module's own SHARD_REL_SRC
 * (derived from coord-config.mjs's DEFAULTS.shardIdPattern) — a caller with a REAL loaded
 * `coord.config.json` (done-worktree.mjs's `cfg.shardIdPattern`, run through deriveShardPatterns)
 * passes its own derivation instead, so a repo that configures a non-default `shardIdPattern`
 * actually changes what this matches, rather than the seam being inert for that key.
 */
export function shardFileRx(seedShardDir, shardRelSrc = SHARD_REL_SRC) {
  const escaped = escapeRegex(`${seedShardDir}/`);
  return new RegExp(`^${escaped}${shardRelSrc}$`);
}

/** The anchored per-country order-manifest regex under the seed shard root (see shardFileRx). */
export function orderManifestRx(seedShardDir, orderManifestRelSrc = ORDER_MANIFEST_REL_SRC) {
  const escaped = escapeRegex(`${seedShardDir}/`);
  return new RegExp(`^${escaped}${orderManifestRelSrc}$`);
}

// Plan 1867: clinic-sharded DERIVED-DATA roots (render-fingerprints / render-store)
// join the landing-lock scope with the same clinic-id semantics as seed shards. One
// rel encoding covers both observed layouts under a derived root — a flat per-clinic
// file (`render-fingerprints/clinic-4.json`) and a per-clinic subtree
// (`render-store/clinic-4/<engine>/<hash>/_meta.json`). Derived from `shardIdPattern`
// (plan 3960) — see deriveShardPatterns above.
export const DERIVED_SHARD_REL_SRC = SHARD_PATTERNS?.derivedShardRelSrc ?? NEVER_MATCH_REL_SRC;

/** The anchored per-clinic derived-shard regex under a configured derived root (see shardFileRx). */
export function derivedShardRx(derivedDir, derivedShardRelSrc = DERIVED_SHARD_REL_SRC) {
  const escaped = escapeRegex(`${derivedDir}/`);
  return new RegExp(`^${escaped}${derivedShardRelSrc}`);
}

// Plan 1867: past this many clinic ids the scope collapses to {global:true}. A
// corpus-scale rewrite (the 1788/1825/1852 fingerprint rebaselines were 712–899
// files) intersects essentially every concurrent land anyway, and a ~15 KB scope
// JSON would ride the lock registry + argv for no narrowing payoff. The cap is
// UNCONDITIONAL (applies to seed-only scopes too — xhigh review F2 made the
// docstring honest about that), so it sits far above any legitimate batch shape:
// refresh batches run ~30 clinics (plan 1015/1055 sizing), the largest observed
// seed land is well under 200, while every corpus rebaseline clears 700.
// plan 3960: sourced from coord-config.mjs's `scopeMaxKeys` default (500, unchanged) — a pure
// constant read, no IO, no change to the cap's semantics or the mutex's byte-identical behavior.
export const SCOPE_MAX_CLINICS = DEFAULTS.scopeMaxKeys;

/**
 * The land's SEED SCOPE (plan 1300 mutex narrowing; plan 1867 derived-data
 * extension) — what the landing-lock serializes on. Pure.
 *   null                      → no seed/derived surface touched (free lane, no lock)
 *   {global:true}             → the monolith, chains.json, anything under a shard root
 *                               that is NOT a per-clinic shard, a derived
 *                               global-on-touch file, or a clinic set past the
 *                               cap — contends with every other scoped land
 *   {clinics:[ids]}           → per-clinic shards and/or country manifests
 *                               (`manifest:<CC>`) touched — contends only with a
 *                               land whose scope set INTERSECTS
 * A clinic id is extracted from `<shardDir>/clinics/<CC>/<clinic-id>.json`; the
 * id (not the path) is the scope unit, so a country MOVE (same id, two paths)
 * still collides with any other land touching that clinic.
 *
 * Plan 1867: clinic-sharded DERIVED-DATA roots (`derived.shardDirs`, e.g.
 * render-fingerprints + render-store) contribute clinic ids to the SAME set —
 * disjoint-clinic lands keep merging freely, same-clinic derived writes
 * serialize exactly like seed shards. `derived.globalFiles` (the append-only
 * observations *.jsonl, which conflict on any concurrent touch) are global on
 * touch. A combined id set larger than `derived.maxClinics` (default
 * SCOPE_MAX_CLINICS, applied UNCONDITIONALLY — with or without derived config)
 * collapses to {global:true} — a corpus rebaseline (712–899 files in the
 * 1788/1825/1852 passes) intersects everything anyway and must not ride
 * argv/registry as a ~15 KB scope. The cap sits far above every legitimate
 * batch shape (see SCOPE_MAX_CLINICS), so absent `derived` config the observable
 * behavior matches plan 1300 for every historically observed diff.
 * `derived.shardIdPattern` (plan 3960 cluster-1 review fix): an optional override of
 * coord-config.mjs's `shardIdPattern` default (this module stays fs-/git-free, so the caller —
 * done-worktree.mjs / spine.mjs, which already hold the LOADED `coord.config.json` — pass the
 * loaded value). Omitted, this resolves to the module's own SHARD_PATTERNS, which is `null` by
 * default (plan 4071: the core `DEFAULTS.shardIdPattern` carries no project-specific literal any
 * more) — shardFileRx/orderManifestRx/derivedShardRx then fall back to their own "matches
 * nothing" default, so an unconfigured caller degrades to "no shard files recognized" rather
 * than throwing. Provided, `deriveShardPatterns` recomputes the three regex sources fresh from
 * it, so a configured `shardIdPattern` actually changes what shardFileRx / orderManifestRx /
 * derivedShardRx match here, instead of the seam being inert for that key.
 * @param {string[]} changedFiles
 * @param {string|null} seedLaneFile
 * @param {string|null} seedShardDir
 * @param {{shardDirs?: string[], globalFiles?: string[], maxClinics?: number, shardIdPattern?: string}} derived
 */
export function seedScopeOf(changedFiles, seedLaneFile, seedShardDir = null, derived = {}) {
  const {
    shardDirs = [],
    globalFiles = [],
    maxClinics = SCOPE_MAX_CLINICS,
    shardIdPattern,
  } = derived;
  if (!seedLaneFile && !seedShardDir && shardDirs.length === 0 && globalFiles.length === 0)
    return null;
  if (seedLaneFile && changedFiles.includes(seedLaneFile)) return { global: true };
  // plan 4071: `patterns` is `null` whenever neither this call's `shardIdPattern` nor the
  // module's own bare-core-default SHARD_PATTERNS resolved to a real pattern — `?.` below lets
  // shardFileRx/orderManifestRx/derivedShardRx fall back to their own NEVER_MATCH_REL_SRC default
  // param in that case, instead of this function dereferencing a property off `null`.
  const patterns = shardIdPattern ? deriveShardPatterns(shardIdPattern) : SHARD_PATTERNS;
  const globalSet = new Set(globalFiles);
  const roots = [];
  if (seedShardDir)
    roots.push({
      prefix: `${seedShardDir}/`,
      rx: shardFileRx(seedShardDir, patterns?.shardRelSrc),
      manifestRx: orderManifestRx(seedShardDir, patterns?.orderManifestRelSrc),
    });
  for (const d of shardDirs)
    roots.push({
      prefix: `${d}/`,
      rx: derivedShardRx(d, patterns?.derivedShardRelSrc),
      manifestRx: null,
    });
  const ids = new Set();
  let touched = false;
  for (const f of changedFiles) {
    if (globalSet.has(f)) return { global: true };
    for (const { prefix, rx, manifestRx } of roots) {
      if (!f.startsWith(prefix)) continue;
      touched = true;
      const m = f.match(rx);
      if (m) ids.add(m[1]);
      else {
        const manifest = manifestRx && f.match(manifestRx);
        if (!manifest) return { global: true }; // chains / unexpected layout file
        ids.add(`manifest:${manifest[1]}`);
      }
      break;
    }
  }
  if (!touched) return null;
  if (ids.size > maxClinics) return { global: true };
  return { clinics: [...ids].sort() };
}

// plan 3961 T2.7c: the land trust gate's merge-base baseline data/filters — TRUST_GATE_ENTRY_FILES,
// TRUST_GATE_MODULE_CLOSURE, TRUST_GATE_EVIDENCE_REGISTRY_FILES, TRUST_GATE_BASE_CODE_DATA_LINKS,
// trustGateClosureTouched, trustGateRegistryTouched, trustGateBaselineRefusals,
// trustGateProofPrefixes, CONSENSUS_FILE_RX, changedConsensusIds — moved to
// scripts/project/land-gate-price-trust.mjs, alongside stageTrustGateBaseCode/runPriceTrustGate
// (plan 3961 T2.4), which are this data's only real consumers. Re-exported below so no existing
// importer of this module breaks (done-worktree.mjs's direct project-module import, and every
// done-worktree.test.mjs import of these names).

/**
 * Build the Windows teardown process-kill PowerShell command (teardown step 1):
 * kill every process whose CommandLine lives under THIS worktree path, return the
 * kill count on stdout.
 *
 * Why a builder + the `$_.ProcessId -ne $PID` clause (plan 681): the previous
 * inline pipeline `Get-CimInstance Win32_Process | Where CommandLine -like '*<wt>*'
 * | Stop-Process -Force | Measure | % Count` exited NON-ZERO (255) on EVERY land —
 * not from CIM CommandLine-access errors (the original hypothesis), but a
 * **self-kill**: the worktree path is embedded as the `-like` search literal in the
 * searcher powershell.exe's OWN command line, so it matches itself and
 * `Stop-Process -Force` terminates the running process mid-pipeline (exit 255, empty
 * stdout). Excluding `$_.ProcessId -ne $PID` removes the only false-positive (the
 * legit node/esbuild dev-server targets keep their distinct PIDs). Belt-and-braces
 * against the original CIM-error hypothesis too: `$ErrorActionPreference =
 * 'SilentlyContinue'` + a forced trailing `exit 0` guarantee a clean run exits 0,
 * and the count comes from stdout, not the pipeline exit code. Dual forward/back-
 * slash match is preserved (plan 378). Pure (no child_process) so it is unit-tested
 * here; the spawn lives in done-worktree.mjs.
 *
 * Plan 3092 — `$PID` alone spares the SEARCHER but not the INVOKER: a session that
 * self-invokes the spine with the worktree path spelled out in the command line
 * (`cd "<wtPath>" && node .../done-worktree.mjs <slug>`) carries that literal path
 * in its OWN `bash.exe` command line, so the sweep matched it and `Stop-Process
 * -Force` killed the invoking shell mid-teardown (observed on the plan-3082 and
 * plan-2303 lands, 2026-08-11): the land had fully succeeded (merge, archive,
 * dequeue) but the harness saw exit 255 and a `prunable` worktree-dir leftover.
 * Passing the spine's `rootPid` walks `Win32_Process.ParentProcessId` upward from
 * it — bounded, cycle-safe — to build the invoking shell's own ancestor set (which
 * includes `rootPid` itself) and excludes that set from the kill match too.
 * Legitimate targets (dev servers spawned under the worktree) are never ancestors
 * of the land process, so they stay killable. The walk runs INSIDE the returned
 * PowerShell string at sweep time — the builder stays pure (no live process-table
 * read here), so this remains a plain string-assertion unit test.
 *
 * The walk also refuses a parent NEWER than its child. Windows never repoints
 * `ParentProcessId` when the true parent exits, so a reused PID can put an unrelated
 * LIVE process in the ancestor set and exempt it from a kill it deserved (/sonnet-review
 * high @ 3d39c5a7, PLAUSIBLE). A real ancestor is always older than its descendant, so
 * a `CreationDate` inversion is positive proof of reuse and stops the climb. The guard
 * is conservative in the safe direction: a missing/unreadable `CreationDate` on either
 * side leaves the climb intact (an over-broad ancestor set only spares a process, while
 * an under-broad one is the self-kill this whole function exists to prevent).
 * @param {string} wtPath worktree path, forward-slash form (`git worktree list` output)
 * @param {number} [rootPid] the spine's own `process.pid`; when omitted the
 *   returned string is byte-identical to the pre-plan-3092 form (no ancestry
 *   clause) — required for the other caller, `pre-push-battery-cap.test.mjs`,
 *   which calls this with one argument.
 * @returns {string} the `-Command` string for `powershell -NoProfile -Command <…>`
 */
export function buildProcessKillCommand(wtPath, rootPid) {
  const wtWin = wtPath.replace(/\//g, '\\');
  const matchPredicate =
    `($_.CommandLine -like '*${wtPath}*' -or $_.CommandLine -like '*${wtWin}*') ` +
    `-and $_.ProcessId -ne $PID`;
  if (rootPid === null || rootPid === undefined) {
    return (
      `$ErrorActionPreference='SilentlyContinue'; $n=0; ` +
      `Get-CimInstance Win32_Process | Where-Object { ${matchPredicate} } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; ` +
      `[Console]::Out.Write($n); exit 0`
    );
  }
  const pid = Number(rootPid);
  return (
    `$ErrorActionPreference='SilentlyContinue'; $n=0; ` +
    `$procs=@(Get-CimInstance Win32_Process); $byId=@{}; foreach($p in $procs){ $byId[[int]$p.ProcessId]=$p }; ` +
    `$anc=@{}; $cur=${pid}; $d=0; ` +
    `while($cur -and -not $anc.ContainsKey($cur) -and $d -lt 64){ $anc[$cur]=$true; $cp=$byId[$cur]; if(-not $cp){ break }; ` +
    `$par=[int]$cp.ParentProcessId; if(-not $par){ break }; $pp=$byId[$par]; ` +
    `if($pp -and $cp.CreationDate -and $pp.CreationDate -and $pp.CreationDate -gt $cp.CreationDate){ break }; ` +
    `$cur=$par; $d++ }; ` +
    `$procs | Where-Object { ${matchPredicate} -and -not $anc.ContainsKey([int]$_.ProcessId) } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; ` +
    `[Console]::Out.Write($n); exit 0`
  );
}

/** Minimal flag parser (slug is the first positional). */
export function parseDoneArgs(argv) {
  const out = {
    slug: null,
    dryRun: false,
    resume: null,
    decision: null,
    wait: false,
    waitChunk: 0,
    deploy: false,
    carryforwardDefer: false,
    prep: false,
    finishCloseOut: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dry-run') out.dryRun = true;
    else if (t === '--finish-close-out')
      // plan 3375: resume a DEAD land's close-out from a fresh session. Standalone mode like
      // --prep: it returns before the land flow, never merges, and — crucially — never needs
      // the plan worktree, which a fresh clone does not have. See planFinishCloseOut.
      out.finishCloseOut = true;
    else if (t === '--prep')
      // plan 972: keep-hot mode — rebase the QUEUED worktree branch onto the live
      // origin/master, re-validate the applicable gates, and stamp a land-prep marker so
      // the head-of-queue land can fast-path past the rebase + gate re-runs. Standalone
      // mode: it returns BEFORE the land flow (never merges).
      out.prep = true;
    else if (t === '--wait')
      out.wait = true; // plan 504: in-process queue poll
    else if (t === '--wait-chunk') {
      // plan 2170 Ship 3: bounded in-process queue wait for UNATTENDED runs — blocks up to
      // <sec> seconds (default/cap WAIT_CHUNK_MAX_SEC, under the 600s Bash tool ceiling),
      // then seams QUEUE_WAIT for a same-turn re-invoke. A chunk call is WAIT-ONLY: at head
      // it seams out instead of landing (the plan-662 detached-kill class can't reach a
      // half-land). Optional numeric value; a bare `--wait-chunk` takes the default.
      const v = argv[i + 1];
      if (v != null && /^\d+$/.test(v)) {
        out.waitChunk = Math.min(Number(v), WAIT_CHUNK_MAX_SEC);
        i++;
      } else {
        out.waitChunk = WAIT_CHUNK_MAX_SEC;
      }
    } else if (t === '--deploy')
      out.deploy = true; // plan 632: trigger a manual deploy at land time (auto-deploy OFF)
    else if (t === '--carryforward-defer')
      // plan 629: a non-interactive close-out (the drain) must NOT halt on an ambiguous
      // carry-forward — each undecided bullet becomes its own waiting-operator/ stub and
      // the parent archives. Standalone lands omit the flag and still seam for the agent.
      out.carryforwardDefer = true;
    else if (t === '--resume') out.resume = argv[++i] ?? null;
    else if (t === '--decision') out.decision = argv[++i] ?? null;
    else if (!t.startsWith('--') && out.slug === null) out.slug = t;
  }
  return out;
}

// ── Seam / exit-code contract ────────────────────────────────────────
// A "seam" is the ONLY point the spine returns control to the agent: a halt
// with HANDOFF:<code> + nonzero exit. Each decider below returns null (proceed)
// or a Seam {code, reason, payload}.

// plan 367 Bug B: a `board.mjs set-state … IN-PROGRESS` on an already-removed row
// fails with "row not found" — on the success/teardown path the row is already
// gone, so this is a benign "already released", NOT a real failure. The release
// path swallows ONLY this (keeps every other set-state error fatal).
export function isRowAbsentError(msg) {
  return /row not found/i.test(String(msg || ''));
}

// plan 1291's `isPortCollision` moved to scripts/project/land-gate-mobile.mjs (plan 4096 T1/S9).

// plan 367 Bug A: the archive step must find the plan WHEREVER it lives, not assume
// `in-progress/`. Given `git ls-files docs/superpowers/plans` output + a basename,
// return the plan's current tracked path — excluding `archive/` (already-archived =
// nothing to move → null, making a partial-crash re-run idempotent). null when absent.
export function resolvePlanRel(lsFiles, base, { archived = false } = {}) {
  const hit = String(lsFiles || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // plan 822: `{archived}` selects the side — default false = live status folders
    // (excludes archive/, the original behavior); true = ONLY archive/. Mirrors
    // resolvePlanRelById so the closeOut "already archived vs genuinely missing" probe
    // works for legacy date-prefixed slugs too (which have no numeric-ID key).
    .find((l) => l.endsWith(`/${base}`) && l.includes('/archive/') === archived);
  return hit || null;
}

// plan 822: resolve the plan's tracked path by its numeric ID (case-free), returning the
// REAL on-disk path with its original casing. `{archived:false}` (default) matches the live
// status folders (excludes archive/) → null means "not live"; `{archived:true}` matches ONLY
// archive/. WHY by ID: the slug claimed at pickup can lowercase the `NNN-PX-` category tag
// (`811-price-…`) while the tracked file keeps its mixed case (`811-Price-…`). A slug-derived
// basename then mismatches resolvePlanRel's case-sensitive `endsWith` → null → the close-out
// archive `git mv` no-ops and the later `git add archive/<lowercase>.md` throws AFTER the merge
// landed, stranding the land at the archive tail (2026-06-19, plan 811). The 3-digit ID is
// unique and case-free, so keying on it sidesteps the mismatch — exactly what move-plan.mjs
// already does. The `(^|/)` anchor on the ID stops `811` from matching a `1811-…` sibling. Pure.
export function resolvePlanRelById(lsFiles, planId, { archived = false } = {}) {
  const id = String(planId == null ? '' : planId).trim();
  if (!/^\d{3,}$/.test(id)) return null;
  const re = new RegExp(`(^|/)${id}-[^/]*\\.md$`);
  const hit = String(lsFiles || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .find((l) => re.test(l) && l.includes('/archive/') === archived);
  return hit || null;
}

// plan 3959 T2: buildPlanIdIndex + rowSlugFromIndex moved to scripts/coord/plan-id-index.mjs —
// generic plan-file lookup, no vetapp vocabulary, and claim-plan.mjs (which cannot safely pull in
// this file's own heavy import graph) needed a light-weight import target. Re-exported here so
// the L.buildPlanIdIndex / L.rowSlugFromIndex namespace-import shape done-worktree.mjs already
// uses keeps working unmodified, and so does this module's own re-export of rowSlugFromIndex
// further down (removed once the program's later step retires this shim).
export { buildPlanIdIndex, rowSlugFromIndex } from './plan-id-index.mjs';

// plan 872: derive the 3-digit plan id for a worktree slug that may be MODERN
// (`NNN-PX-desc`, id verbatim) OR BARE/prefix-less (`desc` — the plan-869 mistake the
// claim-time guard now blocks, but plans ALREADY claimed bare must still land). A bare
// slug carries no id, so `planIdOf(slug)` THROWS — and the spine's releaseClaimAfterMerge
// runs POST-merge, where a throw stranded the whole landing (claim ref leaked, plan
// un-archived, board row + worktree orphaned). For a bare slug, recover the id from the
// LIVE plan file whose basename ends with `-<slug>.md` (the file ALWAYS carries the id —
// next-plan-id.mjs prepends `NNN-PX-`); the `-` boundary before the slug prevents a
// substring false-match (`foo` ⊄ `869-UI-barfoo.md`). Excludes archive/. Returns null when
// neither the slug nor any live plan file yields an id — the caller logs + skips (the ref
// leak is healed by reconcile-board), NEVER throws mid-spine. Pure.
export function planIdForSlug(slug, lsFiles) {
  const s = String(slug || '');
  const direct = s.match(/^(\d{3,})-(?![0-9])/);
  if (direct) return direct[1];
  if (!s) return null;
  const esc = escapeRegex(s);
  const re = new RegExp(`(^|/)(\\d{3,})-(?:[^/]+-)?${esc}\\.md$`);
  for (const line of String(lsFiles || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    if (line.includes('/archive/')) continue;
    const m = line.match(re);
    if (m) return m[2];
  }
  return null;
}

// plan 651: decide HOW closeOut's archive step reaches its goal state (the plan file
// tracked + staged under archive/) from whatever partial state a crashed/interrupted
// prior run left behind, so a bare `done-worktree <slug>` re-run finishes the move
// instead of crashing on it. `src` = resolvePlanRel's result (the plan's tracked
// in-progress/waiting-* path, or null); `srcOnDisk` = does that path exist in the
// worktree right now. Pure so the (small, partial-state-sensitive) branching is
// unit-locked; the IO shell does the existsSync probe + runs the chosen git op.
//   src === null  → 'noop'         resolvePlanRel already found the plan in archive/
//                                  (or absent) — nothing to move (idempotent re-run).
//   srcOnDisk     → 'move'         normal — `git mv -f src arch` (the -f tolerates a
//                                  leftover untracked archive copy from a crashed run).
//   !srcOnDisk    → 'restore-move' half-staged crash (the plan's `Status` step found
//                                  the file already moved on disk but the rename never
//                                  staged: "deletion unstaged + untracked archive copy").
//                                  Restore the tracked content to src, then `git mv -f`
//                                  it over the untracked archive copy — a uniform, idempotent
//                                  path that also recovers a fully-missing working file.
export function archivePlanAction(src, srcOnDisk) {
  if (!src) return 'noop';
  return srcOnDisk ? 'move' : 'restore-move';
}

// plan 651: does the FIRST `**Status:**` line already read ✅ COMPLETED? Used to make
// the close-out's two status-flips idempotent across a partial-run re-run — the handoff
// session-entry flip and the archived plan-body stamp both skip when already complete,
// so a re-run neither churns the file nor re-dates an already-closed plan. Checks ONLY
// the first Status line — the exact line `flipSessionCompleted` / `stampArchivedStatus`
// (via setStatusLine) rewrite — so a LATER quoted/example `**Status:** ✅ COMPLETED`
// line elsewhere in a body can't false-positive the gate and skip stamping the real
// (first) line, which would archive the plan with a stale READY status. Pure.
//
// Scans the frontmatter-STRIPPED body (plan 2392 review finding 0) — setStatusLine's
// own existing-Status match now does the same, so the two agree on which line is
// "the first Status line". Before this, a malformed/hand-edited frontmatter block
// containing a stray column-0 `**Status:**`-shaped line (however unlikely) could
// make this raw-content scan see a false, non-COMPLETED "first" line while the
// real, already-archived body Status line sat later and unread — re-triggering
// stampArchivedStatus on an already-closed plan and overwriting its true archive
// date with today's.
export function statusAlreadyCompleted(txt) {
  const first = stripFrontmatter(String(txt || '')).match(/^\*\*Status:\*\*.*$/m);
  return first ? /✅\s*COMPLETED/.test(first[0]) : false;
}

// plan 3959 T2: the session-entry resolution protocol (isArchiveSessionPath through
// ambiguousSessionEntryMessage) moved to scripts/coord/review-markers.mjs — generic, no
// vetapp vocabulary. Re-exported below (with the rest of that module's names) so no existing
// importer breaks.

// plan 1329: a recurring calendar "heartbeat" plan declares `heartbeat: <days>` in
// frontmatter (e.g. 1078 SEO weekly → `heartbeat: 7`). done-worktree honors it by
// RE-FILING the plan to waiting-date/ +<days> on land instead of archiving it — a
// heartbeat NEVER archives (running it IS the deliverable), so it stays in the
// GENERATED active region and never enters the hand-maintained archive narrative
// (which is exactly what tripped the archive-consistency lint on every re-file before
// this plan). Returns the positive integer day count, or null when the key is absent /
// non-positive / unparseable → the normal archive close-out path. Pure.
export function readHeartbeatDays(content) {
  const raw = readFrontmatterScalar(content, 'heartbeat');
  // Validate the WHOLE value is a bare positive integer — Number.parseInt would silently
  // accept `7d` / `7,0` as 7, quietly wiring a mistyped cadence instead of failing closed to
  // the normal archive path. A malformed value → null (archive), never a wrong heartbeat.
  if (!/^\d+$/.test(String(raw || '').trim())) return null;
  const n = Number.parseInt(raw, 10);
  return n > 0 ? n : null;
}

// runDate (`YYYY-MM-DD`) + days → the next trip date (`YYYY-MM-DD`). Computed in UTC so
// it never drifts a day across a DST boundary, and pure (the Date is built from an
// explicit ISO string, never `now`) so it is deterministic + unit-testable. Throws on a
// malformed runDate rather than silently emitting `NaN-NaN-NaN`.
export function nextHeartbeatDate(runDate, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(runDate || ''))) {
    throw new Error(`nextHeartbeatDate: runDate must be YYYY-MM-DD, got "${runDate}"`);
  }
  const d = new Date(`${runDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// plan 399: idempotent docs/INDEX.md archive transform. The close-out folds the
// INDEX archive into the SAME commit/push as the plan-file `git mv` (it no longer
// self-pushes via `index.mjs archive` BEFORE the move), so origin/master is never
// left half-archived — INDEX "archived" while the file is still tracked in
// in-progress/ (the lint-plan-index reject that wedged plan 396's landing).
//
// This owns ONLY the hand-maintained archive narrative BELOW the INDEX:PLANS
// sentinel. The GENERATED active region above the sentinel is owned entirely by
// `build-index` (run right after, from `git ls-files`, which already reflects the
// staged `git mv` → the archived plan drops out of the active region) — so this
// function deliberately does NOT remove the active bullet. Idempotent for a
// partial-crash re-run: a narrative line for `base` already present → no-op.
export function idempotentArchiveIndex(content, base, note) {
  if (archiveNarrativeHasEntry(content.split('\n'), base)) return content;
  return insertArchiveNarrativeLine(content, base, note);
}

function archiveNarrativeHasEntry(lines, base) {
  const headerIdx = lines.findIndex((l) => ACTIVE_END_RX.test(l));
  if (headerIdx === -1) return false;
  const esc = escapeRegex(base);
  const rx = new RegExp(`^- \`${esc}\``);
  return lines.slice(headerIdx).some((l) => rx.test(l));
}

// ── plan 427: close-out narrative fields (state.sessionN + state.summary) ──
// The archive note + close-out commit subject interpolate state.sessionN /
// state.summary, but main()'s state literal never set either — so every archive
// note rendered '(session ?)' with an empty summary and every commit subject fell
// back to 'closed via spine'. closeOut() now feeds these three pure helpers.

// Pull the session number from a `handoff/sessions/YYYY-MM-DD-session-<N>.md`
// path. This is the live source at note-build time: the board row (which also
// carries the number) is already removed earlier in closeOut(). <N> is the global
// session counter plus an optional same-day letter suffix (19b, 97c). Returns null
// for the single-file layout ('handoff.md'), the DRY placeholder, or any path
// without the marker — the caller's `?? '?'` then renders it.
export function sessionNumFromSessionFile(sf) {
  if (!sf) return null;
  const m = String(sf).match(/-session-(\d+[a-z]?)\.md$/i);
  return m ? m[1] : null;
}

// The plan's frontmatter `summary:` one-liner (via build-index's parser, so it
// matches the INDEX bullet exactly), or null when absent. Returning null — not the
// parser's '' — is deliberate: it lets the caller's `?? '?'` / `?? 'closed via
// spine'` fallbacks fire ('' would suppress them, since '' is neither null nor
// undefined).
export function planSummary(content) {
  return readFrontmatterSummary(content) || null;
}

// plan 2604: the child-env scrub itself lives in the LEAF scripts/coord/child-env.mjs (see its header
// for why it must sit at the spawn seam and why it matches case-insensitively). Re-exported here
// so existing `L.`-namespace callers and the test suite keep one import site.
export { CHILD_ENV_STRIP, GIT_ENV_PREFIXES, childEnv, spawnEnv } from './child-env.mjs';

// Single-line, length-clamped form for a git commit subject (git convention caps
// the subject ~72 chars; a frontmatter summary can be multi-sentence). null-safe:
// null/'' pass through unchanged so the caller's `?? 'closed via spine'` fallback
// still fires.
export function clampSubject(s, max = 72) {
  if (!s) return s;
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

export const SEAM = {
  PREFLIGHT_FAIL: 'PREFLIGHT_FAIL',
  LAND_BLOCKED: 'LAND_BLOCKED',
  REVIEW_NEEDED: 'REVIEW_NEEDED',
  REBASE_CONFLICT: 'REBASE_CONFLICT',
  REBASE_UGLY: 'REBASE_UGLY',
  DEPLOY_FAILED: 'DEPLOY_FAILED',
  CARRYFORWARD_AMBIGUOUS: 'CARRYFORWARD_AMBIGUOUS',
  PROMOTE_AMBIGUOUS: 'PROMOTE_AMBIGUOUS',
  // plan 504: FIFO landing queue + hold-through-conflict + build preflight
  QUEUE_WAIT: 'QUEUE_WAIT',
  LAND_BLOCKED_HOLDING: 'LAND_BLOCKED_HOLDING',
  BUILD_FAILED: 'BUILD_FAILED',
  // (plan 556's ARTIFACT_STALE seam — the generated-artifact freshness land-time gate —
  //  was RETIRED by plan 1024: frontend/public/clinics-index.json is now build-generated +
  //  gitignored, so there is no committed artifact left to go stale vs its seed.)
  // plan 771: the land diff touches a watched landing/composer/mobile surface and the
  // WebKit T1–T7 gate (verify-mobile-gate.mjs) failed. The hook's verify-mobile block is
  // BRANCH=master-gated and the spine lands from a detached-HEAD ephemeral worktree, so
  // the hook never fired it — this worktree-side preflight is the spine's only mobile gate.
  MOBILE_FAILED: 'MOBILE_FAILED',
  // plan 2875 task 4/Part A: the land diff touches backend/scripts/** or shared/src/** and the
  // FULL `python -m pytest backend/scripts` suite FAILED. This is one of the two heavy tiers the
  // retiered scripts/hooks/pre-push.sh no longer proves on every LOCAL push (operator decision,
  // docs/runbooks/push-gate-tiering.md § Operator decision, 2026-08-06) — this pre-queue
  // preflight is now the fail-closed replacement, same family as BUILD_FAILED/MOBILE_FAILED
  // (pre-merge, resumable on its own code after a fix+push).
  PYTEST_FAILED: 'PYTEST_FAILED',
  // plan 3954 T2: the pytest tier's own twin of the vitest reporter-IPC carve-out
  // (run-land-tests.mjs's VITEST_IPC_TIMEOUT_RE) — a run whose failures are ALL a Windows
  // spawn-init NTSTATUS (spawn-failure-signatures.mjs's `looksSpawnStarved`/
  // `allFailedTestsSpawnStarved`) never ran the code under test at all; the box was out of
  // memory when the child tried to start. Fires from the SAME two places PYTEST_FAILED does
  // (pytestRedIsFlake's two callers) instead of PYTEST_FAILED, when either the original run's
  // failure tail carries the signature on EVERY failed test, or the plan-3422 isolation
  // recheck's own process exits with a signature code and produced no captured output — see
  // pytestIsolationRecheck's `starved` field. It still BLOCKS (never auto-greens — the
  // plan-3422 "red in isolation is never self-healed" property is unchanged, a starved recheck
  // is UNPROVEN, not green); only the label and the resume shape change. Same
  // pre-merge/resumable family as PYTEST_CHUNKED, and for the same reason: nothing needs
  // fixing, so landResumeCode gives it no skip code — the way through is a BARE re-invoke once
  // the box has headroom.
  PYTEST_STARVED: 'PYTEST_STARVED',
  // plan 2875 task 4/Part A: the land diff touches scripts/**/*.mjs and the FULL `node --test
  // scripts/*.test.mjs` battery FAILED. The other heavy tier the retiered hook no longer proves
  // on every LOCAL push — see PYTEST_FAILED above for the same rationale.
  BATTERY_FAILED: 'BATTERY_FAILED',
  // plan 4006 review round 1 (finding 4a76e3): the battery tier's own twin of PYTEST_STARVED above
  // — a battery preflight (or its isolation recheck) that was never admitted to the shared heavy-
  // test queue at all is not a genuine cap-kill/test failure the way BATTERY_FAILED means; nothing
  // this run's own timeoutMs bounds ever ran. Fires from the same place BATTERY_FAILED does
  // (batteryRedIsFlake's callers) instead of BATTERY_FAILED, when `batteryIsolationRecheck`'s own
  // runViaTestQueue call comes back `slotStarved` (testQueueRunOutcome's never-admitted branch).
  // Still BLOCKS (never auto-greens); only the label and the resume shape change — same pre-merge/
  // resumable family as BATTERY_CHUNKED, and for the same reason: nothing needs fixing, so
  // landResumeCode gives it no skip code — the way through is a BARE re-invoke once the shared
  // queue is free.
  BATTERY_STARVED: 'BATTERY_STARVED',
  // plan 3274: the partial-progress twin of PYTEST_FAILED — the land preflight's own cloud-chunk
  // cap (chunkGateConfig/chunkCapDecision in done-worktree.mjs, NOT a real per-file/per-suite
  // failure) is what stopped this attempt before the FULL `python -m pytest backend/scripts` suite
  // could finish proving every file green under its content key. An unattended cloud drain that
  // reads PYTEST_FAILED here follows the land-failure loop (dequeue, diagnose a bug that does not
  // exist, burn both fix-cycles, park) — this seam exists so the drain's generic seam
  // classification (LAND_STUCK_SEAMS + landResumeCode below) can tell "not finished yet, re-invoke
  // to continue" apart from "broken, go fix it" at the SIGNAL itself, not just in prose. Same
  // pre-merge/resumable family as PYTEST_FAILED — its resume path is a BARE re-invoke (never a
  // --resume skip, see landResumeCode below): the content-keyed ledger picks up exactly where the
  // chunk cap left off.
  PYTEST_CHUNKED: 'PYTEST_CHUNKED',
  // plan 3274: the partial-progress twin of BATTERY_FAILED — same rationale as PYTEST_CHUNKED
  // immediately above, for the `node --test scripts/*.test.mjs` battery half.
  BATTERY_CHUNKED: 'BATTERY_CHUNKED',
  // plan 3374: the CHUNKED pair above says "not finished yet, re-invoke to continue" — which is
  // true right up until it isn't. A single test file whose wall exceeds the chunk wall can never
  // be proven inside one round: plan 3318's `orderStalledLast` retires everything else first, and
  // then every remaining round attempts only that file, proves ZERO, and reports CHUNKED again,
  // forever. Measured on plan 3284 (2026-08-22): green frozen at 153/925, rounds 2-8 each proving
  // nothing, the gate reporting healthy chunking the whole way. This seam is that loop's exit —
  // raised when a gate has run and proven zero new files for NON_CONVERGENT_ROUNDS consecutive
  // chunk-capped rounds, with a message that NAMES the head file instead of promising progress.
  //
  // ONE seam for BOTH heavy gates, unlike the CHUNKED pair (plan 3374 decision D4): that pair is
  // split because each half carries its own --resume code and gate-skip semantics, whereas the
  // operator action here is identical for pytest and battery alike ("this file cannot finish
  // inside one chunk wall — slow-mark it, split it, or fix the hotspot"), and the message already
  // names which gate and which file. Pre-merge and not-yet-landed, so it joins LAND_STUCK_SEAMS
  // below; landResumeCode gives it NO skip code, because the way through is a new commit.
  GATE_NON_CONVERGENT: 'GATE_NON_CONVERGENT',
  // plan 4086: the `backend/scripts` pytest suite RAN and left the worktree dirtier than it found
  // it — a test wrote into a path git tracks. Raised by the pytest gate itself, from a
  // `git status --porcelain` snapshot taken immediately before the suite spawns and again after it
  // exits (runPytestPreflight and pytestIsolationRecheck, the two spawn sites).
  //
  // WHY A SEAM AND NOT A LATER PREFLIGHT_FAIL. The dirt was always caught eventually — by the
  // CLEAN-TREE check in the land preflight, which runs BEFORE the battery and therefore only ever
  // sees the leak on the NEXT land, or mid-rebase. `docs/handoff/infra-debt.md` recorded exactly
  // that six times in four days for one file (`apply-flags/clinic-004.json`), each costing a land
  // attempt to a failure whose message named a dirty worktree and not the test that dirtied it.
  // Attribution is the whole point: this fires in the gate that ran the suite, names the paths,
  // and points at `backend/scripts/conftest.py`'s `_isolate_committed_stores`.
  //
  // It REPLACES a green verdict only. On any already-blocking outcome — PYTEST_FAILED,
  // PYTEST_STARVED, PYTEST_CHUNKED, GATE_NON_CONVERGENT — the paths are APPENDED to that seam's
  // own message instead, so a starved run is still reported as starved and a chunked run keeps its
  // "re-invoke to continue" resume semantics. Never auto-restores the files: a `git checkout --`
  // here would hide the defect this seam exists to surface.
  //
  // Pre-merge and not-yet-landed, so it joins LAND_STUCK_SEAMS below. landResumeCode gives it NO
  // skip code, for PRETTIER_DRIFT's reason: the way through is a NEW COMMIT (redirect the sink the
  // test reached, then restore the file), and a `--resume PYTEST_DIRTIED_TREE` skip would bypass
  // the very re-check that proves the leak is gone.
  PYTEST_DIRTIED_TREE: 'PYTEST_DIRTIED_TREE',
  // plan 665 G3: a --wait land whose coordWrite-backed steps (enqueue / board) were
  // blocked by a sibling's foreign-dirt for the whole retryOnForeignDirt budget. A
  // clean, slot-released halt (mirrors the drain's coordContention stop) instead of a
  // stack trace — transient, so a bare re-invoke re-checks and proceeds (like PREFLIGHT_FAIL).
  COORD_CONTENTION: 'COORD_CONTENTION',
  // plan 822: closeOut cannot resolve the plan file to archive — it is in NO live status
  // folder AND not already in archive/ (a genuinely missing plan, not the slug/filename
  // case mismatch the ID-keyed resolution now handles). Fires POST-merge; a clean seam
  // instead of letting a `git add archive/<missing>.md` throw an opaque stack trace after
  // the merge already landed. A human must locate/restore the file, then re-invoke (bare).
  ARCHIVE_UNRESOLVED: 'ARCHIVE_UNRESOLVED',
  // plan 1074: pre-merge knowledge-of-record gates (the read/reasoning-layer twin of
  // the data-layer plan-706 `status` Zod guard).
  // STATUS_FLIP — the seed diff flips a clinic's operationalStatus across the
  // active/closed line (active<->closed_permanently or active<->moved) WITHOUT the
  // rationale the provenance rule demands (a statusNote / an operationalStatus
  // verifications[] entry; closedAt on a closure). The resurrect direction
  // (closed->active) is the loudest — it is the exact failure plan 1074 exists to
  // stop. Resume with --resume STATUS_FLIP after fixing the row (or a conscious
  // override once the flip is confirmed genuine).
  STATUS_FLIP: 'STATUS_FLIP',
  // WIKI_CHECKPOINT — the land diff touched a subject the wiki OWNS (a platform
  // adapter, the price-pipeline inspectors, a pricing-concept module, or the seed
  // chains[] registry) but no fresh `Wiki: WROTE|SKIP @ <sha>` decision was recorded.
  // Forces the "did this teach the wiki something durable?" decision
  // (scripts/record-wiki.mjs); a SKIP is allowed but logged VISIBLY so the checkpoint
  // keeps its teeth (a silent always-skip would decay it to a toothless advisory).
  WIKI_CHECKPOINT: 'WIKI_CHECKPOINT',
  // plan 1165 Part A: the land diff changes a clinic's prices[] and that clinic FAILS the
  // extraction-trust gate (a DEDUP_PRICING_MODE / TIMEBAND_GAP / IMAGING_INDICATION / … HARD
  // finding). Pre-merge, ABSOLUTE — unlike the manual sign-off stamp-cohort, the land gate has
  // NO override (the plan-1097 gap: 6 clinics landed gate-failing). Fix the rows in the worktree
  // (apply-1165-trust-gate-enrichment.py or re-extract; see docs/runbooks/price-cohort-workflow.md
  // § "definition of done"), push, and re-invoke done-worktree --resume PRICE_GATE_FAILED. The
  // spine check is gate-ENFORCEMENT only (read-only — land-trust-gate.py without --apply); stamping
  // verifiedAgainstRender is the session's one-command definition-of-done step
  // (`land-trust-gate.py --clinics … --apply`), NOT a mid-land in-spine commit (which would break
  // the sha-pinned review marker on a QUEUE_WAIT re-run — operator decision 2026-06-29).
  PRICE_GATE_FAILED: 'PRICE_GATE_FAILED',
  // plan 1205: findings-as-data land gate. A review recorded as NITS/BUGS-FOUND for the
  // current HEAD must carry an attached findings record (scripts/record-review.mjs
  // --findings), and EVERY reported finding must be dispositioned — filed as a plan
  // (machine-verified), fixed in-diff, or explicitly waved (--wontfix, reason required)
  // — before the land. Closes the "pre-existing, I'll skip it" escape (operator directive
  // 2026-06-30): a known bug CAN land, but only once a plan is filed for it. Unlike the
  // other pre-merge gates there is NO --resume skip — the way through is always to
  // disposition each finding (a bare re-invoke then re-reads the record and passes); the
  // per-finding --wontfix IS the conscious, reason-stamped override valve.
  FINDINGS_OPEN: 'FINDINGS_OPEN',
  // plan 1528 Phase B: the head-holder's recovery crossed from "quick in-slot fix" to heavy
  // rework (a SECOND rebase/merge conflict in the same land attempt, source-edit rework proven
  // by a non-identical patch-id after A1's mechanical re-pin refused, or >8 min cumulative
  // head-hold) while ≥1 waiter sat behind it — so the spine RELEASED the head: the queue entry
  // moved to the tail (dequeue+enqueue in ONE atomic coordWrite commit — landing-queue.mjs
  // requeue), the seed mutex was released and the board LANDING row flipped back to ACTIVE.
  // Finish the rework during the wait (keep-hot --prep keeps the branch current), then
  // re-invoke (bare or --resume LAND_BLOCKED_REQUEUED — both re-enter at the queue-wait step,
  // never the merge step). Capped at 2 requeues per land attempt; past the cap the spine holds
  // regardless (livelock guard — the trip function returns hold).
  LAND_BLOCKED_REQUEUED: 'LAND_BLOCKED_REQUEUED',
  // plan 1723 E3: the land rebase pulled in a NEWER prettier config than the worker formatted
  // against (e.g. a different printWidth landed on master mid-flight), so files the worker's
  // pre-rebase in-worktree prettier check passed now FAIL `prettier --check` against the rebased
  // tree — a failure that would otherwise only surface at the merge pre-push (the 1710/1711 lands,
  // 2026-07-11). A proactive post-rebase CHECK seams here with the exact scoped fix. Deliberately
  // NEVER an auto-fix commit: an auto-commit changes the branch patch-id, so tryMarkerRepin (plan
  // 1528 A1 — repins only patch-id-IDENTICAL rebases) classifies the land as rework anyway; auto-
  // fixing would just convert a bookkeeping failure into a silent review-marker bypass. The fix is
  // a `prettier --write` on the named files + commit + re-record the review (a prettier-only delta
  // is "no new logic" → self-read + record-review PASS) + re-run done-worktree (bare — a new commit
  // was pushed, so every gate MUST re-run against it; there is no --resume skip for this seam).
  PRETTIER_DRIFT: 'PRETTIER_DRIFT',
  // plan 2033: pre-merge conclusion-review gate for world-claim seed writes. The seed
  // diff OVERWRITES an established world-claim field (coord.config.json's
  // land.worldClaimFields — a claim about external reality: liveness / clinic type /
  // chain attribution / booking identity) but no fresh `Conclusion: UPHELD @ <sha>`
  // adversarial-review verdict is recorded (scripts/record-conclusion.mjs). The review machinery reviews DIFFS;
  // this gate makes someone review the CONCLUSION — one adversarial refuter (plan
  // body + seed diff + verification note, prompted to REFUTE: name a source that
  // could contradict; what question does the evidence NOT answer). All 5 judgment
  // failures in the 2026-07-18 retrospective were operator-caught, zero gate-caught;
  // the plan-767 template (every named source agreed "not open" while a competitor
  // operated at the premises) is the failure class. --resume CONCLUSION_REVIEW is the
  // explicit operator-waiver valve.
  CONCLUSION_REVIEW: 'CONCLUSION_REVIEW',
  // plan 3078: the land diff RE-INTRODUCES the retired backend/src/data/seed-clinics.json
  // monolith, which CLAUDE.md forbids explicitly ("a re-appearing monolith is a resurrected
  // legacy write") — the sharded seed under backend/src/data/seed/ is the only seed surface.
  // This is the one land shape that used to reach the monolith branch of the pre-merge
  // seed-gate block (the monolith-ref seed reader, since deleted) and silently no-op the
  // plan-1074 STATUS_FLIP and plan-1165 PRICE_GATE_FAILED gates: that reader returned null at a
  // merge-base where the file is absent, so a resurrected-monolith diff sailed through both
  // gates unchecked — on precisely the land that most deserves a stop. Fires pre-merge/
  // pre-queue; --resume MONOLITH_RESURRECTED is the conscious operator waiver, same family as
  // STATUS_FLIP.
  MONOLITH_RESURRECTED: 'MONOLITH_RESURRECTED',
  // plan 3832: LANDED_REVERSION (seam string + exit 32) was here and is RETIRED. The
  // landed-work-reversion lint is ADVISORY now — done-worktree prints its findings and merges —
  // so there is no seam to emit and no code to resume past. See
  // scripts/coord/assert-no-landed-reversion.mjs § DEMOTED TO ADVISORY.
  // plan 2875 task 4: the MANDATORY pre-deploy gate. `--deploy` re-proves the FULL scripts
  // battery + a real production build + the WebKit mobile gate immediately before the Render
  // trigger fires (checkDeploy), "non-negotiable, regardless of per-push tiering" — the plan's
  // one hard wall for whatever the retiered push hook stops running on the hot path. POST-merge
  // (fires right where DEPLOY_FAILED does), so landSeamDisposition's `branchMerged` check
  // already classifies it 'archive' with no taxonomy change needed. No --resume skip code (same
  // family as FINDINGS_OPEN/PRETTIER_DRIFT) — the way through is to fix the failing tier and
  // re-invoke with --deploy; a bare re-invoke naturally re-enters via the alreadyLanded fast
  // path and re-runs this gate fresh, never a stale skip.
  DEPLOY_GATE_FAILED: 'DEPLOY_GATE_FAILED',
  // plan 3282: `mergeBaseRef` (done-worktree.mjs) returns null when the merge-base against
  // origin/master cannot be resolved (a shared-checkout git hiccup, or a shallow cloud
  // checkout — plan 3239) — its own contract on failure. Fed into readShardGateViews, that
  // null base is read by all FOUR base-vs-head seed gates (STATUS_FLIP / CONCLUSION_REVIEW /
  // PRICE_GATE_FAILED / WIKI_CHECKPOINT) as "nothing changed", so a genuine status flip, price
  // change, world-claim overwrite, or paged-clinic change could land ungated. This seam
  // refuses at the ONE call site that feeds all four, before any of them run. No --resume skip
  // code: the way through is a repaired checkout (fetch / --unshallow) and a plain re-invoke,
  // never a conscious override — skipping this one would re-open the exact fail-open it closes.
  SEED_BASE_UNRESOLVED: 'SEED_BASE_UNRESOLVED',
  // plan 3436 (D1): the partial-progress twins of BUILD_FAILED / MOBILE_FAILED. Plan 3430
  // anchored the cloud chunk wall at process start so the land's PRE-GATE spend finally counts
  // against the 480s budget — but counting is not bounding: `next build` and the WebKit T1–T7
  // gate each carried their OWN fixed 600s `execFileSync` timeout, so one slow pre-gate phase
  // could spend the whole wall (and then some) before a chunkable gate was ever reached, and
  // nothing stopped it. Both gates now derive their effective timeout from whatever is LEFT of the
  // shared wall (chunkCapDecision, exactly as pytest/battery do), and these seams are what a run
  // stopped by THAT cap reports — never a gate regression.
  //
  // "Capping a build mid-run is a new failure mode" was the stated reason plan 3430 left this
  // alone; it is not. Both gates already passed `timeout: 600_000`, so a mid-run kill of the
  // build or of the WebKit driver is an outcome the land could already reach — this changes the
  // THRESHOLD and the CLASSIFICATION, not the failure mode. The resume story is likewise the one
  // both gates already have: a bare re-invoke, made cheap by their content-keyed pass caches
  // (gate-pass-cache.mjs). landResumeCode gives them no --resume skip for the same reason
  // PYTEST_CHUNKED/BATTERY_CHUNKED have none — the way through is to let the run finish, never to
  // skip the gate that has not proven anything yet.
  BUILD_CHUNKED: 'BUILD_CHUNKED',
  MOBILE_CHUNKED: 'MOBILE_CHUNKED',
  // plan 3453: the head-time worktree-lock wait's own chunked seam — the one land phase plan 3430
  // left outside the chunk wall (see push-gate-tiering.md § Cloud-chunked heavy gates). Plan 3436
  // tried folding it in and withdrew after four review rounds found three correctness bugs, every
  // one at the moment this code SIGTERM+SIGKILLs a live process; plan 3453 is the redesign — TWO
  // CLOCKS that never touch each other (a holder clock, accumulated across invocations, that
  // bounds PREEMPTION, and an attempt clock, this shared process wall, that bounds only THIS
  // INVOCATION'S poll loop). This seam is what the attempt clock fires: the wait was making no
  // promise about the holder — it simply ran out of its own turn. RETAINS the queue slot
  // (`keepQueue: true` at every emit site) — it fires AT the head of the FIFO, so a re-invoke
  // should resume there, never pay a full queue traversal for a wait nobody caused (3436's own
  // choice, reconfirmed: see acquireWorktreeLockAtHead's header for what now bounds that). No
  // --resume skip code (below) for the same reason BUILD_CHUNKED/MOBILE_CHUNKED have none: the way
  // through is a re-invoke that resumes the SAME wait (the holder-clock sidecar carries the
  // accumulated total forward), never a conscious override of a wait that never finished.
  HEAD_LOCK_CHUNKED: 'HEAD_LOCK_CHUNKED',
  // plan 3815: a CLOUD land's disk-headroom gate — immediately before the production-build gate
  // fires, done-worktree.mjs's cloud land path calls disk-headroom.mjs's prune() (main checkout +
  // every OTHER worktree, never the one being landed) and then checkFreeBytes() against
  // diskHeadroomFloorBytes() (default 3 GB, DISK_HEADROOM_FLOOR_BYTES-overridable). Cloud
  // sandboxes ran out of disk mid-build at least ten times between 2026-08-21 and 2026-09-08
  // (plans 3784, 3652, 3533, 3526, 3594, 3691, 3677 and more), always recovered by hand deleting a
  // stray `.next` — this seam is the refusal BEFORE `next build` dies mid-way with ENOSPC inside
  // close-out, where a session has the least room to recover. Fires PRE-merge/pre-queue, same
  // family as SEED_BASE_UNRESOLVED: the fix is genuinely freeing more disk (or raising the floor,
  // a conscious env override), never a --resume skip of a gate that hasn't run yet — see
  // landResumeCode below. LOCAL is untouched: done-worktree.mjs guards every call with
  // isCloudLand() below, so the Windows checkout's caches (kept on purpose) are never touched.
  DISK_HEADROOM_LOW: 'DISK_HEADROOM_LOW',
};

// Distinct nonzero exit code per seam so a wrapper/agent can branch on $?.
export const EXIT = {
  [SEAM.PREFLIGHT_FAIL]: 10,
  [SEAM.REVIEW_NEEDED]: 11,
  [SEAM.REBASE_CONFLICT]: 12,
  [SEAM.REBASE_UGLY]: 13,
  [SEAM.DEPLOY_FAILED]: 14,
  [SEAM.CARRYFORWARD_AMBIGUOUS]: 15,
  [SEAM.PROMOTE_AMBIGUOUS]: 16,
  [SEAM.LAND_BLOCKED]: 17,
  [SEAM.QUEUE_WAIT]: 18,
  [SEAM.LAND_BLOCKED_HOLDING]: 19,
  [SEAM.BUILD_FAILED]: 20,
  // 21 was [SEAM.ARTIFACT_STALE] — retired by plan 1024 (left as a gap; exit codes are
  // explicit literals, so dropping the entry doesn't renumber the others).
  [SEAM.COORD_CONTENTION]: 22,
  [SEAM.MOBILE_FAILED]: 23,
  [SEAM.ARCHIVE_UNRESOLVED]: 24,
  [SEAM.STATUS_FLIP]: 25, // plan 1074
  [SEAM.WIKI_CHECKPOINT]: 26, // plan 1074
  [SEAM.PRICE_GATE_FAILED]: 27, // plan 1165
  [SEAM.FINDINGS_OPEN]: 28, // plan 1205
  [SEAM.LAND_BLOCKED_REQUEUED]: 29, // plan 1528
  [SEAM.PRETTIER_DRIFT]: 30, // plan 1723
  [SEAM.CONCLUSION_REVIEW]: 31, // plan 2033
  // 32 was LANDED_REVERSION (plan 2274), retired by plan 3832. Deliberately NOT reused: a
  // result sidecar written before that land can still carry `code: 'LANDED_REVERSION'` /
  // `exitCode: 32`, and handing 32 to a new seam would make those records read as that seam.
  [SEAM.DEPLOY_GATE_FAILED]: 33, // plan 2875
  [SEAM.PYTEST_FAILED]: 34, // plan 2875
  [SEAM.BATTERY_FAILED]: 35, // plan 2875
  // 36 was OMNIBUS_CARRYFORWARD (plan 2944), retired by plan 3961 with the grammar-omnibus
  // carry-forward machinery — see docs/handoff/grammar-debt.md for the current routing.
  // Deliberately UNASSIGNED, not reused: a result sidecar written before that retirement can
  // still carry `code: 'OMNIBUS_CARRYFORWARD'` / `exitCode: 36`, and handing 36 to a new seam
  // would make those records read as that seam.
  [SEAM.MONOLITH_RESURRECTED]: 37, // plan 3078
  [SEAM.SEED_BASE_UNRESOLVED]: 38, // plan 3282
  // plan 3274, renumbered at the land rebase: 38 was taken by plan 3282's SEED_BASE_UNRESOLVED
  // while this branch was in review. 40 is deliberately SKIPPED — it belongs to
  // PREP_EXIT.GATE_CHUNKED, and these two maps share one observable space (a caller reads a single
  // exit code and cannot tell which map produced it), which is exactly the collision this branch
  // already shipped once when GATE_CHUNKED was 10 against EXIT[SEAM.PREFLIGHT_FAIL] = 10.
  [SEAM.PYTEST_CHUNKED]: 39, // plan 3274
  [SEAM.BATTERY_CHUNKED]: 41, // plan 3274
  // plan 3374: 42 is the first free value in this band — 40 belongs to PREP_EXIT.GATE_CHUNKED
  // (see the note above) and 41 to BATTERY_CHUNKED. Its PREP-side twin takes 43, deliberately a
  // DIFFERENT number: the two maps share one observable space, and the collision-guard test in
  // done-worktree.test.mjs forbids any PREP_EXIT value from equalling an EXIT[SEAM.*] value.
  [SEAM.GATE_NON_CONVERGENT]: 42, // plan 3374
  // plan 3436: 44-46 are the first free values above the whole band in use — 42 is
  // GATE_NON_CONVERGENT here and 43 is PREP_EXIT.GATE_NON_CONVERGENT, and these two maps share one
  // observable space (a caller reads a single exit code and cannot tell which map produced it), the
  // collision rule this file has already had to enforce twice. done-worktree.test.mjs's
  // collision-guard test pins it structurally.
  [SEAM.BUILD_CHUNKED]: 44, // plan 3436 D1
  [SEAM.MOBILE_CHUNKED]: 45, // plan 3436 D1
  // plan 3453: 46 is the next free value above the whole band in use (MOBILE_CHUNKED = 45) — never
  // a PREP_EXIT value (those top out at PREP_EXIT.GATE_NON_CONVERGENT = 43), so the collision-guard
  // test in done-worktree.test.mjs stays green with no renumbering.
  [SEAM.HEAD_LOCK_CHUNKED]: 46, // plan 3453
  // plan 3815: 47 is the next free value above the whole band in use (HEAD_LOCK_CHUNKED = 46) —
  // same non-collision reasoning as every entry above it.
  [SEAM.DISK_HEADROOM_LOW]: 47, // plan 3815
  // plan 3954: 48 is the next free value above the whole band in use (DISK_HEADROOM_LOW = 47) —
  // same non-collision reasoning as every entry above it.
  [SEAM.PYTEST_STARVED]: 48, // plan 3954 T2
  // plan 4006 review round 1: 49 is the next free value above the whole band in use
  // (PYTEST_STARVED = 48) — same non-collision reasoning as every entry above it.
  [SEAM.BATTERY_STARVED]: 49, // plan 4006 review round 1 (finding 4a76e3)
  // plan 4086: 50 is the next free value above the whole band in use (BATTERY_STARVED = 49) —
  // same non-collision reasoning as every entry above it.
  [SEAM.PYTEST_DIRTIED_TREE]: 50, // plan 4086 T3
};

// plan 972: prep-mode exit codes — a DIFFERENT process-exit-code namespace than the land SEAM/EXIT
// map just above (prep runs BEFORE the land flow and is consumed by the 969 watcher
// (landing-queue-watch.mjs), not the seam classifiers). OK = prepared (or already current);
// CONFLICT = a genuinely-new rebase conflict the detached driver can't resolve (surface to the
// session); GATE_FAILED = an applicable gate broke after the rebase (surface so it is fixed during
// the wait, not at head); ERROR = fetch/IO failure.
// plan 2473: BUSY = another process owns this worktree right now (a sibling prep, the head-time
// land, or leftover rebase state a session must resolve). It is a clean NO-OP, not a failure — the
// caller (the watcher, or the spine's own dispatch) logs it and carries on, exactly as it does for
// the other non-zero codes.
//
// BUSY is 6, NOT 10: every code in this map EXCEPT GATE_CHUNKED (see its own comment below) lives
// BELOW `EXIT`'s seam-code range (PREFLIGHT_FAIL=10 … the highest live seam), and a done-worktree.mjs
// `--prep` invocation can exit with EITHER kind — the seam codes come from main()'s preflight,
// which runs before the `--prep` branch is even reached (observed live: a dirty worktree made a
// prep exit PREFLIGHT_FAIL). Overlapping the two ranges would make "the prep skipped, someone else
// owns the tree" indistinguishable from "the prep hit a preflight failure" for every reader of the
// child's exit code.
// plan 2940: DETACHED_STAMP = the prep reached a marker-stamp seam on a worktree whose HEAD is no
// longer attached to refs/heads/<branch>, so the sha it was about to certify is NOT the branch's.
// Distinct from ERROR because the operator action differs: ERROR is a fetch/IO fault or an
// attachment lost BEFORE the prep wrote anything (guardrail 1 — nothing to undo), while this one
// means the prep's OWN rebase stranded HEAD mid-run and the tree needs recovery. It stays inside
// the ≤9 band for the reason the block comment above gives: 1–4 are left free, and 5 is the lowest
// unused value in the map.
//
// plan 3274 (review round, F1/CONFIRMED): GATE_CHUNKED = every gate that did not come back green
// this pass was CHUNKED (out of cloud-chunk budget — plan 3274), never a real branch defect, so the
// exit is distinguishable from GATE_FAILED end to end rather than collapsing into it. A pass that
// mixes a chunked gate with a genuinely FAILED one still reports GATE_FAILED — this code means
// "re-invoke to continue", never "there is nothing wrong here".
//
// plan 3274 (review round, F1/CONFIRMED [renumber]): GATE_CHUNKED first landed as 10 — which
// COLLIDES with `EXIT[SEAM.PREFLIGHT_FAIL]` (also 10). Both are process exit codes from
// done-worktree.mjs, and this whole map deliberately lives BELOW EXIT's seam-code range for
// exactly that reason (see the BUSY=6 block comment above) — 10 was simply the first value that
// band-reasoning forgot to clear. Renumbered to 40: clear above the HIGHEST EXIT value in use
// (`BATTERY_CHUNKED` = 39) rather than squeezed into the ≤9 band, so it can never again collide
// with a seam code no matter how many more of either map get added between them.
// done-worktree.test.mjs's own collision-guard test pins this structurally: no PREP_EXIT value may
// ever equal an EXIT[SEAM.*] value.
//
// plan 3274 (review round, F3/PLAUSIBLE [PREP_EXIT-EXIT-drift]): moved HERE from done-worktree.mjs
// — beside EXIT/SEAM, the map it must never collide with — rather than living in a different file
// than its own collision partner. done-worktree.mjs re-exports this SAME object
// (`export const PREP_EXIT = L.PREP_EXIT`), never a second, drifting literal; landing-queue-watch.mjs's
// own PREP_EXITS report table (its reading of these codes) now keys its GATE_CHUNKED row off
// `PREP_EXIT.GATE_CHUNKED` directly, for the same reason — this branch already shipped ONE
// exit-code collision (the GATE_CHUNKED=10 clash the renumber above fixed) from two places
// disagreeing about a number, and a re-typed `40` literal in the watcher was the same class of risk.
// plan 3374: GATE_NON_CONVERGENT is the prep-side twin of the land seam of the same name — a gate
// that has now proven zero new files for NON_CONVERGENT_ROUNDS consecutive chunk-capped rounds.
// It gets its OWN prep code rather than reusing GATE_CHUNKED for one decisive reason: GATE_CHUNKED
// is classified `retry: true` in landing-queue-watch.mjs's PREP_EXITS (the mechanism that fulfils
// its "re-invoke to continue" promise), and re-arming the SAME tip every poll is precisely the
// infinite loop this seam exists to break. 43, not 42: 42 is EXIT[SEAM.GATE_NON_CONVERGENT], and
// these two maps must never alias (see the collision history above).
export const PREP_EXIT = {
  OK: 0,
  DETACHED_STAMP: 5,
  BUSY: 6,
  CONFLICT: 7,
  GATE_FAILED: 8,
  ERROR: 9,
  GATE_CHUNKED: 40,
  GATE_NON_CONVERGENT: 43,
};

// ── plan 629: drain land-seam destination taxonomy ────────────────────
// When the drain lands a worker's pushed branch via the spine and the spine HALTS
// at a seam, the half-landed plan has exactly three honest destinations — NOT the
// one-size-fits-all waiting-operator/ park that made the folder unreadable (the
// 2026-06-15 audit: 621 parked READY-bodied though its code had shipped; 622 a
// land-stuck rebase conflict mislabelled "needs an operator decision"):
//
//   'archive'  — the merge ALREADY landed (branch is an ancestor of origin/master);
//                a POST-merge seam (carry-forward / promote / deploy) fired. The code
//                is on master — finish the close-out (archive + board-remove +
//                teardown), never park with a stale READY body.
//   'resume'   — a LAND-STUCK seam: the land did not complete (rebase/build/artifact/
//                review/preflight). KEEP the plan in in-progress/ with a
//                RESUME-NEEDED:<CODE> marker; the operator/agent resolves and re-invokes
//                done-worktree. This is "finish the land," NOT "decide whether to do the
//                work" — the work was greenlit at claim (operator taxonomy, plan 629
//                Task 3, 2026-06-15).
//   'operator' — an UNKNOWN seam (spawn failure / no HANDOFF line): genuinely unclear →
//                park to waiting-operator/ for a human to look (the conservative default).
//
// QUEUE_WAIT is retryable and never reaches this classifier; the post-merge seams are
// caught by `branchMerged` first, so the LAND_STUCK set only ever decides not-merged
// seams. Pure so the (small, error-prone) routing rule is unit-locked.
export const LAND_STUCK_SEAMS = new Set([
  SEAM.REBASE_CONFLICT,
  SEAM.REBASE_UGLY,
  SEAM.LAND_BLOCKED,
  SEAM.LAND_BLOCKED_HOLDING,
  SEAM.BUILD_FAILED,
  SEAM.MOBILE_FAILED, // plan 771: pre-merge worktree mobile gate — resume on --resume MOBILE_FAILED after a fix+push
  // plan 2875: pytest / battery are the third and fourth pre-merge pre-queue gates, same family
  // as BUILD_FAILED/MOBILE_FAILED — not-yet-merged halt, resume on the seam's own code after a
  // fix+push.
  SEAM.PYTEST_FAILED,
  SEAM.BATTERY_FAILED,
  // plan 3274: the chunked (partial-progress) twins of the two seams immediately above — same
  // pre-merge, not-yet-landed family, so a not-merged halt keeps the plan in in-progress/ with a
  // RESUME-NEEDED:<CODE> marker instead of falling through to landSeamDisposition's 'operator'
  // default (the only other outcome for a seam outside this set). landResumeCode (below) gives
  // these two a null resume code — the way through is always a BARE re-invoke, never a --resume
  // skip, because the fix here is "let the ledger-backed run continue", not "confirm a fix and
  // skip the gate".
  SEAM.PYTEST_CHUNKED,
  SEAM.BATTERY_CHUNKED,
  // plan 3954 T2: fires from the same two pre-merge/pre-queue sites as PYTEST_FAILED (the
  // original run's failure tail, and the plan-3422 isolation recheck), so a not-merged halt
  // keeps the plan in in-progress/ with a RESUME-NEEDED:PYTEST_STARVED marker instead of falling
  // through to landSeamDisposition's 'operator' default. landResumeCode (below) gives it no skip
  // code, same as PYTEST_CHUNKED immediately above — nothing needs fixing, the way through is a
  // BARE re-invoke once the box has headroom.
  SEAM.PYTEST_STARVED,
  // plan 4006 review round 1 (finding 4a76e3): the battery tier's own twin of PYTEST_STARVED
  // immediately above, fired from the same two pre-merge/pre-queue sites as BATTERY_FAILED (the
  // original run's own outcome, and the plan-3827 isolation recheck), for the identical reason —
  // nothing needs fixing, the way through is a BARE re-invoke once the shared heavy-test queue is
  // free.
  SEAM.BATTERY_STARVED,
  // plan 3436 D1: the pre-gate pair joins the same family for the same reasons — both fire
  // PRE-merge (2.6 / 2.66, strictly before the enqueue), so a not-merged halt keeps the plan in
  // in-progress/ with a RESUME-NEEDED marker instead of falling through to landSeamDisposition's
  // 'operator' default, and landResumeCode gives both a null resume code because the way through
  // is a BARE re-invoke, never a --resume skip of a gate that proved nothing.
  SEAM.BUILD_CHUNKED,
  SEAM.MOBILE_CHUNKED,
  // plan 3453: fires AT the head of the FIFO (after enqueue, unlike the pre-queue CHUNKED pair
  // above), so a not-merged halt keeps the plan in in-progress/ with a
  // RESUME-NEEDED:HEAD_LOCK_CHUNKED marker rather than falling through to landSeamDisposition's
  // 'operator' default — and landResumeCode gives it no skip code either, for the identical reason:
  // the wait proved nothing about the holder, so the way through is a BARE re-invoke that resumes
  // the same wait from its accumulated total, never a skip of a wait that never finished.
  SEAM.HEAD_LOCK_CHUNKED,
  // plan 3374: fires PRE-merge at the same two preflights as the CHUNKED pair above, so a
  // not-merged halt keeps the plan in in-progress/ with a RESUME-NEEDED marker rather than falling
  // through to landSeamDisposition's 'operator' default. The distinction from the pair is not WHERE
  // it halts but what the halt MEANS: the way through is a new commit (slow-mark the named file,
  // split it, or fix its hotspot), not another round of the same run — so landResumeCode gives it
  // no skip code and the seam's own message, not the marker, carries the "do not just re-invoke"
  // instruction.
  SEAM.GATE_NON_CONVERGENT,
  // plan 4086: fires PRE-merge from the pytest gate itself (2.661, strictly before the enqueue),
  // so a not-merged halt keeps the plan in in-progress/ with a RESUME-NEEDED marker rather than
  // falling through to landSeamDisposition's 'operator' default. Like GATE_NON_CONVERGENT above
  // and unlike the CHUNKED pair, the way through is a NEW COMMIT, not another round of the same
  // run — so landResumeCode gives it no skip code and the seam's own message carries the
  // "redirect the sink, then restore the file" half a bare command line cannot express.
  SEAM.PYTEST_DIRTIED_TREE,
  SEAM.REVIEW_NEEDED,
  SEAM.PREFLIGHT_FAIL,
  // plan 665 G3: a coord-contention halt is usually PRE-merge (enqueue / board LANDING) →
  // branch not landed → 'resume' (keep in in-progress/, re-invoke). It CAN also fire post-merge
  // (board remove in closeOut), but there branchMerged is true so landSeamDisposition short-
  // circuits to 'archive' first — this membership only decides the not-yet-merged case.
  SEAM.COORD_CONTENTION,
  // plan 1074: both fire PRE-merge (the gate halts before the FIFO queue), so a
  // not-merged halt keeps the plan in in-progress/ with a RESUME-NEEDED:<CODE>
  // marker — the work was greenlit at claim; this is "finish the land", not a
  // re-decision. landResumeCode falls through to the seam's own --resume code.
  SEAM.STATUS_FLIP,
  SEAM.WIKI_CHECKPOINT,
  // plan 1165: pre-merge price gate — a not-merged halt keeps the plan in in-progress/ with a
  // RESUME-NEEDED:PRICE_GATE_FAILED marker (fix the rows + re-land), same family as STATUS_FLIP.
  SEAM.PRICE_GATE_FAILED,
  // plan 1205: pre-merge findings gate — a not-merged halt keeps the plan in in-progress/ with a
  // RESUME-NEEDED:FINDINGS_OPEN marker. The way through is to disposition each open finding
  // (record-review disposition …) then re-invoke (bare — the gate re-reads the record), NOT a
  // --resume skip (there is none for this seam).
  SEAM.FINDINGS_OPEN,
  // plan 1528: a requeued land is land-stuck by definition — the code hasn't merged; the
  // session finishes the rework during the tail wait and re-invokes. landResumeCode falls
  // through to the seam's own code, which skips NOTHING (no resumedPast() gate checks it),
  // so both `--resume LAND_BLOCKED_REQUEUED` and a bare re-invoke re-enter at the queue-wait
  // step — exactly the plan-1528 B4(d) contract (never the merge step).
  SEAM.LAND_BLOCKED_REQUEUED,
  // plan 1723: the post-rebase prettier-drift check fires PRE-merge, so a not-merged halt keeps
  // the plan in in-progress/ with a RESUME-NEEDED:PRETTIER_DRIFT marker — the session prettier-
  // writes + commits + re-records the review, then re-invokes (bare — landResumeCode returns null
  // so the fresh commit re-runs every gate, never a skip). Same "finish the land" family as
  // BUILD_FAILED, not a re-decision (the work was greenlit at claim).
  SEAM.PRETTIER_DRIFT,
  // plan 2033: pre-merge conclusion gate — a not-merged halt keeps the plan in in-progress/
  // with a RESUME-NEEDED:CONCLUSION_REVIEW marker. The way through is to run the adversarial
  // refuter + record the verdict (record-conclusion.mjs), then re-invoke; --resume
  // CONCLUSION_REVIEW is the conscious operator waiver, same family as STATUS_FLIP.
  SEAM.CONCLUSION_REVIEW,
  // plan 3078: fires PRE-merge/pre-queue (a pure changed-files check, before any gate view is
  // built), so a not-merged halt keeps the plan in in-progress/ with a
  // RESUME-NEEDED:MONOLITH_RESURRECTED marker. The way through is to drop the monolith path
  // from the diff; --resume MONOLITH_RESURRECTED is the conscious operator waiver — same family
  // as STATUS_FLIP. Every seam gets the standard --resume valve by design; this one is no
  // exception even though the offending diff shape is itself forbidden.
  SEAM.MONOLITH_RESURRECTED,
  // plan 3282: fires PRE-merge/pre-queue (before any gate view is built), so a not-merged halt
  // keeps the plan in in-progress/ with a RESUME-NEEDED:SEED_BASE_UNRESOLVED marker rather than
  // quarantining it to waiting-operator/ — an unresolvable merge-base is a MECHANICAL checkout
  // repair (`git fetch origin master` / `git fetch --unshallow`), never an operator decision.
  // Like PREFLIGHT_FAIL / COORD_CONTENTION / PRETTIER_DRIFT — the other land-stuck seams with no
  // --resume valve — landResumeCode returns null for it (below), because nothing checks
  // resumedPast(SEED_BASE_UNRESOLVED) and a generated
  // `--resume SEED_BASE_UNRESOLVED` recipe would teach the exact skip that re-opens the
  // fail-open this seam exists to close. Same no-skip-code shape as PRETTIER_DRIFT: the marker
  // names the BARE re-invoke, which re-runs the check against the repaired checkout.
  SEAM.SEED_BASE_UNRESOLVED,
  // plan 3815: fires PRE-merge/pre-queue (before the production-build gate even starts), so a
  // not-merged halt keeps the plan in in-progress/ with a RESUME-NEEDED:DISK_HEADROOM_LOW marker
  // rather than falling through to landSeamDisposition's 'operator' default — freeing disk space
  // is a MECHANICAL condition to clear, never an operator decision. Same no-skip-code shape as
  // SEED_BASE_UNRESOLVED immediately above (see landResumeCode below): the marker names the bare
  // re-invoke, which re-runs prune()+checkFreeBytes() against whatever space now exists.
  SEAM.DISK_HEADROOM_LOW,
]);

export function landSeamDisposition(seam, branchMerged) {
  // plan 822: the one deliberate exception to "branchMerged ALWAYS archives". An unresolved
  // archive (the plan file is missing from every status folder) cannot be healed by re-running
  // the close-out — the re-run re-seams. It needs a human to locate/restore the file, so park
  // for the operator even post-merge instead of looping on the 'archive' disposition.
  if (seam === SEAM.ARCHIVE_UNRESOLVED) return 'operator';
  if (branchMerged) return 'archive';
  if (LAND_STUCK_SEAMS.has(seam)) return 'resume';
  return 'operator';
}

// The rebase/merge-family seams all re-enter the merge through the ONE canonical
// plan-504 resume code (LAND_BLOCKED_HOLDING re-enters with the queue slot intact;
// --resume REBASE_CONFLICT is honoured too). The build/artifact/review seams resume
// on their OWN code after a fix+push. PREFLIGHT_FAIL has no skip code — it is usually
// transient foreign-dirt, so a bare re-invoke re-checks and proceeds. Pure.
const MERGE_FAMILY_SEAMS = new Set([
  SEAM.REBASE_CONFLICT,
  SEAM.REBASE_UGLY,
  SEAM.LAND_BLOCKED,
  SEAM.LAND_BLOCKED_HOLDING,
]);

export function landResumeCode(seam) {
  if (MERGE_FAMILY_SEAMS.has(seam)) return SEAM.LAND_BLOCKED_HOLDING;
  // PREFLIGHT_FAIL and COORD_CONTENTION are transient (foreign-dirt) — no --resume skip
  // code; a bare re-invoke re-checks and proceeds once the sibling's dirt clears (plan 665).
  // ARCHIVE_UNRESOLVED (plan 822) heals the same way: once a human restores the plan file,
  // a bare re-invoke re-resolves it by ID and finishes the close-out — no skip code needed.
  if (
    seam === SEAM.PREFLIGHT_FAIL ||
    seam === SEAM.COORD_CONTENTION ||
    seam === SEAM.ARCHIVE_UNRESOLVED ||
    // plan 1723: a prettier-drift fix is a NEW commit (prettier --write + commit), so a bare
    // re-invoke must re-run every gate against the fresh tree — a --resume PRETTIER_DRIFT skip
    // would bypass the very re-check that proves the drift is gone. No skip code (like
    // PREFLIGHT_FAIL); the marker names the bare `done-worktree.mjs <slug>` re-run.
    seam === SEAM.PRETTIER_DRIFT ||
    // plan 3282: SEED_BASE_UNRESOLVED heals by REPAIRING THE CHECKOUT (fetch / --unshallow), and
    // nothing checks resumedPast(SEED_BASE_UNRESOLVED) — so a `--resume SEED_BASE_UNRESOLVED`
    // recipe would be both inert and actively misleading, teaching the one skip that re-opens the
    // four-gate fail-open this seam closes. No skip code: the marker names the bare re-invoke,
    // which re-resolves the merge-base and either clears or re-refuses honestly.
    seam === SEAM.SEED_BASE_UNRESOLVED ||
    // plan 3274: a chunked heavy-gate halt resumes by CONTINUING the same content-keyed ledger run,
    // never by skipping the gate outright — a --resume PYTEST_CHUNKED/BATTERY_CHUNKED skip code
    // would bypass the very re-check that proves the remaining files green. No skip code (like
    // PRETTIER_DRIFT); the marker names the bare `done-worktree.mjs <slug>` re-run, matching
    // chunkReportDetail's own "Re-invoke done-worktree to continue" instruction verbatim.
    seam === SEAM.PYTEST_CHUNKED ||
    seam === SEAM.BATTERY_CHUNKED ||
    // plan 3954 T2: same rule as PYTEST_CHUNKED/BATTERY_CHUNKED two lines up — a starved run
    // proved nothing (the code under test never ran), so a `--resume PYTEST_STARVED` skip would
    // bypass the very re-check that proves the tests pass with headroom. No skip code: the
    // marker names the bare `done-worktree.mjs <slug>` re-run, matching the seam's own "re-invoke
    // when the box has headroom" message.
    seam === SEAM.PYTEST_STARVED ||
    // plan 4006 review round 1: same rule as PYTEST_STARVED immediately above, for its battery
    // twin — a `--resume BATTERY_STARVED` skip would bypass the very re-check that proves the
    // battery passes with a queue slot. No skip code: the marker names the bare re-invoke.
    seam === SEAM.BATTERY_STARVED ||
    // plan 3374: the way through a non-convergent gate is a NEW COMMIT — slow-mark the named file,
    // split it, or fix its hotspot — exactly like PRETTIER_DRIFT above. A `--resume
    // GATE_NON_CONVERGENT` skip would bypass the very gate the seam exists to protect, teaching the
    // one move that turns "this file is never proven" into "this file is never RUN". No skip code:
    // the marker names the bare re-invoke, which is the correct command ONCE the fix commit exists,
    // and the seam's own message carries the "fix the file first, do not simply re-invoke" half a
    // bare command line cannot express.
    seam === SEAM.GATE_NON_CONVERGENT ||
    // plan 4086: the way through a tree-dirtying test is a NEW COMMIT — redirect the committed
    // sink the test reached (`backend/scripts/conftest.py`'s `_isolate_committed_stores`) and
    // restore the file it wrote — exactly like PRETTIER_DRIFT and GATE_NON_CONVERGENT above. A
    // `--resume PYTEST_DIRTIED_TREE` skip would bypass the very gate that proves the leak is gone,
    // and would carry the dirty tree into the land's own clean-tree preflight, which is the
    // failure this seam exists to pre-empt. No skip code: the marker names the bare re-invoke,
    // correct ONCE the fix commit exists.
    seam === SEAM.PYTEST_DIRTIED_TREE ||
    // plan 3436 D1: same rule as the PYTEST/BATTERY pair four lines up — a chunk-capped build or
    // mobile run proved NOTHING, so `--resume BUILD_CHUNKED` would skip the gate on the strength of
    // a run that never finished. Their content-keyed pass caches (gate-pass-cache.mjs) make the
    // bare re-invoke cheap, which is precisely why no skip is needed.
    seam === SEAM.BUILD_CHUNKED ||
    seam === SEAM.MOBILE_CHUNKED ||
    // plan 3453: same rule as the BUILD/MOBILE pair immediately above — the wait proved nothing
    // about the holder it was waiting on, so `--resume HEAD_LOCK_CHUNKED` would skip straight past
    // a wait that never finished. No skip code: the marker names the bare re-invoke, which resumes
    // the same wait from its accumulated holder-clock total (the sidecar carries it forward), never
    // restarting the 30-minute preempt budget from zero.
    seam === SEAM.HEAD_LOCK_CHUNKED ||
    // plan 3815: same rule as SEED_BASE_UNRESOLVED above — DISK_HEADROOM_LOW heals by freeing
    // actual disk space (or a conscious DISK_HEADROOM_FLOOR_BYTES override), and nothing checks
    // resumedPast(DISK_HEADROOM_LOW), so a `--resume DISK_HEADROOM_LOW` recipe would be inert at
    // best and actively misleading at worst — teaching a skip of the one check standing between
    // the land and the exact ENOSPC-inside-close-out crash this seam exists to prevent. No skip
    // code: the marker names the bare re-invoke, which re-runs prune()+checkFreeBytes() fresh.
    seam === SEAM.DISK_HEADROOM_LOW
  )
    return null;
  return seam; // BUILD_FAILED / REVIEW_NEEDED resume on their own code
}

// The done-worktree command a land-stuck plan's RESUME-NEEDED marker names, so the
// next reader (operator OR a re-pickup) knows the exact one-liner to finish the land.
export function landResumeCommand(slug, seam) {
  const code = landResumeCode(seam);
  return code
    ? `node scripts/done-worktree.mjs ${slug} --resume ${code}`
    : `node scripts/done-worktree.mjs ${slug}`;
}

// ── plan 3815: cloud-land disk-headroom gate — pure decision/formatting helpers ────────────────
// The actual IO (disk-headroom.mjs's prune()/checkFreeBytes()) stays entirely OUT of this file —
// see the disk-headroom.mjs import comment above for why. What lives here is everything the
// done-worktree.mjs cloud land path needs to DECIDE with, once it has already run that IO: is
// this a cloud land at all, what floor applies, and what does the refusal message say. Every
// function below is a total function of its inputs, consistent with this file's own contract.

// Cloud vs local, by the same env var (and the same truthy-string convention — `=== 'true'`,
// matching hobby-env.mjs / pytest-workers.mjs / win-cpu-cap.mjs) every other cloud/local branch
// in this codebase already reads. `env` is injectable so a test never has to mutate
// process.env; the real default lets a done-worktree.mjs call site take no argument.
export function isCloudLand(env = process.env) {
  return env.CLAUDE_CODE_REMOTE === 'true';
}

// The free-space floor a cloud land refuses to start the production build under, in bytes.
// Defaults to disk-headroom.mjs's DEFAULT_FLOOR_BYTES (3 GB); DISK_HEADROOM_FLOOR_BYTES
// overrides it when set to a finite positive number — anything else (unset, non-numeric, zero,
// negative) silently falls back to the default rather than disabling the floor, the same
// fail-safe direction every ledger/gate default in this file already takes.
export function diskHeadroomFloorBytes(env = process.env) {
  const raw = env.DISK_HEADROOM_FLOOR_BYTES;
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FLOOR_BYTES;
}

// The DISK_HEADROOM_LOW refusal message — built from values the caller already computed (the
// prune() result that just ran, plus the checkFreeBytes()/floor pair), never computed here. Named
// explicitly in the plan: "a clear message that also reports the prune line already run", so an
// operator or an unattended drain reading this seam's message never has to go re-derive whether
// pruning even happened before concluding the sandbox is genuinely out of room.
export function diskHeadroomLowMessage({ freeBytes, floorBytes, prunedBytes, prunedCount }) {
  return (
    `Free disk space (${formatBytes(freeBytes)}) is below the ${formatBytes(floorBytes)} floor ` +
    `required before the production build starts. The pre-build prune already ran and freed ` +
    `${formatBytes(prunedBytes)} across ${prunedCount} director${prunedCount === 1 ? 'y' : 'ies'} ` +
    `— it was not enough. Free more space in the sandbox (stop/archive an unrelated worktree, or ` +
    `raise DISK_HEADROOM_FLOOR_BYTES if this floor is wrong for this environment) and re-invoke.`
  );
}

// ── plan 3223/3225: is the per-file green ledger active for this preflight call? ───────────────
//
// ONE definition, shared by runFullBatteryPreflight and runPytestPreflight (which carried
// byte-identical copies of this expression). It is also THE GUARANTEE THE `--deploy` PRE-DEPLOY
// WALL RESTS ON, which is why it is pure and tested rather than inlined twice: that wall calls its
// preflight directly with no `useLedger`, so this returns '' — and an empty key is what makes the
// whole ledger path (plan 3225's carry-forward seeding included) unreachable, leaving the wall to
// physically re-run the FULL battery exactly as its charter requires. The default-OFF direction
// means a future caller that FORGETS the flag degrades to "ledger never engages" (today's
// behavior), never to silently trusting a cached partial result on a hard wall.
//
// A caller-supplied key that came up empty or malformed (a MISS whose cache check could not even
// mint a key — an uncacheable or dirty tree) lands in the same place, the fail-safe direction every
// ledger consultation in this repo takes: doubt never narrows what runs.
export function ledgerActiveKey({ useLedger, ledgerKey } = {}) {
  return useLedger && typeof ledgerKey === 'string' && /^[0-9a-f]{32}$/.test(ledgerKey)
    ? ledgerKey
    : '';
}

// ── plan 3225 Fix B: the stale-halt `--resume` nag (pure decider) ─────────────
//
// `--resume <SEAM>` is the designed valve for "I fixed the ONE thing that halted the last land,
// re-enter past it" — and it was HABIT-ONLY: nothing reminded a session it existed at the moment it
// mattered. Session 3099 (2026-08-16) called done-worktree fresh after a 3-file fix and silently
// re-proved both heavy suites from the top, "out of habit rather than checking first". The terminal
// sidecar already records every exit's seam code + timestamp (writeResultSidecar, plan 665 G4.1), so
// the reminder costs one file read this invocation already knows how to do.
//
// WARN-ONLY, NEVER A BLOCK — deliberately, and this is the whole safety argument: a fresh full run
// is ALWAYS sound (a broad delta, or plain distrust of the earlier fix, are both good reasons to
// re-prove everything), so the worst case of ignoring this line is the cost we pay today. Refusing
// or auto-resuming would trade a cost problem for a correctness one.
//
// The predicate reuses the EXISTING taxonomy rather than a second hand-written seam list (which is
// how one list silently drifts from the other): LAND_STUCK_SEAMS is already "halted before the merge,
// `--resume` is the way through", and `landResumeCode` already knows which of those have a real skip
// code at all. A seam whose resume code is null (PREFLIGHT_FAIL, COORD_CONTENTION, PRETTIER_DRIFT)
// resumes via a BARE re-invoke — which is exactly what this invocation already is, so nagging about
// it would be pure noise. SUCCESS / CRASH / every post-merge seam fall out for free, never being
// LAND_STUCK members.
export const RESUME_NAG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Returns the warning text, or null for silence. Pure: the caller supplies the already-read sidecar
// (null when absent/unparseable) and the clock.
export function staleHaltResumeNag({
  sidecar,
  slug,
  nowMs,
  resume = null,
  prep = false,
  maxAgeMs = RESUME_NAG_MAX_AGE_MS,
}) {
  // `--resume` was passed: the session is already doing the thing this nag exists to suggest.
  // `--prep` never writes or owns the land sidecar (plan 2473), so it must never read one either.
  if (resume || prep) return null;
  if (!sidecar || typeof sidecar !== 'object') return null;
  const code = sidecar.code;
  if (typeof code !== 'string' || !LAND_STUCK_SEAMS.has(code)) return null;
  const resumeCode = landResumeCode(code);
  if (!resumeCode) return null; // resumes via a bare re-invoke — i.e. this one
  // A recent halt only. An unparseable stamp, or one in the FUTURE (clock skew, a VM-snapshot
  // resume), is not evidence of anything — the same direction pass-cache-kernel's `isLive` takes,
  // and silence is the cheap failure for an advisory line.
  const t = Date.parse(sidecar.timestamp ?? '');
  if (Number.isNaN(t) || t > nowMs || nowMs - t > maxAgeMs) return null;
  const mins = Math.round((nowMs - t) / 60000);
  return (
    `done-worktree: this slug's LAST invocation halted at ${code} ${mins} min ago, and this is a ` +
    `FRESH (non --resume) call — so every gate before that seam is about to be re-proved from the ` +
    `top (the scripts battery and the backend/scripts pytest suite are the expensive ones). If you ` +
    `have already fixed + pushed what ${code} halted on, the call you probably want is:\n` +
    `    ${landResumeCommand(slug, code)}\n` +
    `which re-enters the land past that seam instead of re-running it. Ignoring this is always ` +
    `SOUND — a fresh full run proves strictly more — so re-run fresh whenever the delta is broad ` +
    `or you distrust the fix. Advisory only; nothing is skipped or blocked by this message.`
  );
}

// ── plan 665 G4: --wait detached false-failure hardening (pure deciders) ──────

// G4.3: refuse `--wait` when stdout is NOT a TTY (a detached / background / piped run).
// A detached --wait polls in-process and the harness can KILL it AFTER the land completed,
// surfacing exit 255 with EMPTY output — a false-failure that nearly drove a clobbering
// hand-merge on the plan-653 land (plan 662). Default-deny is the safest fix: the land never
// runs detached, so there is no half-land or stranded lock to recover. Returns the refusal
// reason, or null to proceed. Exemptions: --dry-run (never lands), an attached TTY, the
// deterministic test hook DW_FAKE_QUEUE_POS, and the explicit DW_ALLOW_DETACHED_WAIT=1
// power-user override (whose detached run is still covered by the G4.1 sidecar). Pure.
export function detachedWaitRefusal({ wait, isTTY, dry, env = {} }) {
  if (!wait || dry || isTTY) return null;
  if (env.DW_FAKE_QUEUE_POS != null) return null; // deterministic queue-poll test hook
  if (env.DW_ALLOW_DETACHED_WAIT === '1') return null; // explicit override (still writes the sidecar)
  return (
    '--wait was requested but stdout is NOT a TTY (a detached / background / piped run). A detached ' +
    '--wait polls in-process and can be KILLED after completing the land yet report exit 255 with empty ' +
    'output — a false-failure that has nearly driven a clobbering hand-merge (plan 662). Run done-worktree ' +
    '--wait in the FOREGROUND, or — the canonical agent path — drop --wait and launch ' +
    `\`${WATCH_RECIPE}\` via Bash run_in_background:true (zero-token detached ` +
    'poll that keeps the branch hot; exits at head → re-invokes the session; the QUEUE_WAIT seam ' +
    'RETAINS your slot). ' +
    // plan 2819: a non-TTY run is very often an UNATTENDED one, so this refusal is read
    // disproportionately by exactly the sessions the watcher cannot help — offering only the
    // watcher sends them to a wake that never arrives. Shares the clause with the two wait seams
    // rather than restating it: 'can use NEITHER' because this path has already refused --wait.
    unattendedChunkClause('<slug>', 'can use NEITHER') +
    ' Deliberate override: DW_ALLOW_DETACHED_WAIT=1.'
  );
}

// Parse one `landing-lock.mjs status` line. "held <slug> pid=<pid> host=<host> age=<n>m …"
// → { slug, pid, host, ageMin }; "free" / anything else → null. ageMin is null when the
// line prints age=unknown (corrupt lock file). Pure.
export function parseLockStatusLine(line) {
  const m = String(line || '').match(/^held (\S+) pid=(\S+) host=(\S+) age=(\S+)/);
  if (!m) return null;
  const age = /^\d+m$/.test(m[4]) ? Number(m[4].slice(0, -1)) : null;
  return { slug: m[1], pid: m[2], host: m[3], ageMin: age };
}

// G4.2: decide whether a STRANDED seed landing-lock may be reclaimed. A detached/killed
// --wait that COMPLETED the land but skipped the `finally` strands the same-PC lock (the
// 2026-06-15 incident: 643's lock blocked 633 until a manual --force).
//
// CRITICAL PRECONDITION (enforced HERE since plan 1300, per holder): the holder must be
// older than staleMin (~35 min). A live seed merge is seconds-to-minutes, NEVER 35 min, so a
// stale holder cannot be a live re-land mid-merge. That liveness gate is what makes the
// reclaim safe — WITHOUT it, a persisted sidecar (sidecars are slug-keyed and never deleted)
// from a PRIOR completed land of the same slug would authorise force-releasing the FRESH lock
// of a CURRENT re-land, causing the double-merge race landing-lock exists to prevent (review
// finding, plan 665). Pre-1300 the single-holder lock let the CALLER's STALE verdict (exit 3)
// prove the age; under the multi-holder registry (plan 1300) STALE only proves the OVERLAPPING
// blockers are stale, while the reclaim sweep walks EVERY holder — so a fresh, live holder
// whose plan is already archived (the closeOut→release window is multi-second) would be
// stolen mid-push without a per-holder age check (plan-1300 review finding 0). ageMin comes
// off the holder's own status line; unknown age (corrupt line) is never reclaimed.
//
// Given that precondition, we PROVE the land finished, primary→fallback:
//
//   PRIMARY (sidecar) — the holder's terminal sidecar carries `mergeSha` ⇒ the branch reached
//   master, on THIS PC. The host check compares the SIDECAR's host — written by done-worktree's
//   own `run('hostname')`, the same source as `ourHost` (state.host) — NOT the lock holder's
//   `os.hostname()` (a different source that can disagree in case/form on Windows).
//
//   FALLBACK (committed git state — plan 675) — when NO sidecar / no `mergeSha` is found (hard
//   kill, power loss, a cross-machine land, OR a crash before the sidecar write — including the
//   plan-674 cwd-inside-worktree exit-255). The sidecar lives in gitignored `.scratch/` —
//   ephemeral and the wrong SOLE source of truth. Committed git state answers durably: a holder
//   whose plan now lives in `docs/superpowers/plans/archive/<slug>.md` has FINISHED its land
//   (close-out archives only AFTER the merge; an explicit supersede likewise ends the branch), so
//   the lock must be freed. With no sidecar host to compare, gate on the LOCK RECORD's own host
//   (`holder.host === ourHost`) — never reclaim a possibly-live land on another PC. This makes a
//   no-sidecar orphan SELF-HEAL on the next land instead of stranding the next 🟥 seed land at
//   PREFLIGHT_FAIL until a human force-releases (the 2026-06-15 plan-663 strand, hit twice).
//
// Pure: `holder` = parseLockStatusLine output; `ourHost`; `readSidecar(slug)` → parsed result
// JSON or null; `isHolderPlanArchived(slug)` → boolean (the durable git-state probe). Returns
// { reclaim, holderSlug?, mergeSha? } and, ONLY on the archive-fallback reclaim, `via:'archive'`
// (the sidecar-path reclaim deliberately omits `via` to keep its `{reclaim,holderSlug,mergeSha}`
// shape unchanged — the caller distinguishes the two via `verdict.via === 'archive'`).
export function staleLandLockReclaimable({
  holder,
  ourHost,
  readSidecar,
  isHolderPlanArchived,
  staleMin = DEFAULT_STALE_MIN, // the lock's own threshold; a live land never runs this long
}) {
  if (!holder || !holder.slug) return { reclaim: false };
  // Per-holder liveness gate (plan 1300): only a provably-old holder may be stolen. A
  // missing/unknown age is treated as possibly-live — no steal.
  if (holder.ageMin == null || holder.ageMin <= staleMin) return { reclaim: false };
  let sc = null;
  try {
    sc = readSidecar(holder.slug);
  } catch {
    sc = null; // unreadable sidecar → fall through to the durable git-state fallback
  }
  // PRIMARY: sidecar proves the land completed (mergeSha) — unchanged behaviour.
  if (sc && sc.mergeSha) {
    if (sc.host && ourHost && sc.host !== ourHost) return { reclaim: false }; // a completed land on a DIFFERENT PC — never touch
    return { reclaim: true, holderSlug: holder.slug, mergeSha: sc.mergeSha };
  }
  // FALLBACK (plan 675): no sidecar proof → the holder's plan being archived proves the land
  // finished. Require the lock record's host to match ours (no sidecar host to compare). The
  // comparison is CASE-INSENSITIVE: holder.host comes from the lock record's `os.hostname()`
  // while ourHost comes from done-worktree's `run('hostname')` — on Windows those two sources
  // can disagree in case (the same caveat the PRIMARY path dodges by using the sidecar's
  // run('hostname') value). An exact `===` would make the fallback silently no-op on the very
  // Windows host it must heal; hostnames are case-insensitive, so lowercasing is safe and is
  // strictly a same-machine check (never widens the steal across PCs).
  if (typeof isHolderPlanArchived === 'function') {
    let archived = false;
    try {
      archived = Boolean(isHolderPlanArchived(holder.slug));
    } catch {
      archived = false; // a throwing probe is treated as "unproven" → no steal
    }
    const sameHost = Boolean(
      holder.host && ourHost && String(holder.host).toLowerCase() === String(ourHost).toLowerCase(),
    );
    if (archived && sameHost) {
      return { reclaim: true, holderSlug: holder.slug, mergeSha: null, via: 'archive' };
    }
  }
  return { reclaim: false }; // no durable proof the holder's land completed
}

// ── plan 504: queue gate + hold-through-conflict + build preflight (pure) ──

// The land diff touches the frontend production-build surface — the spine must
// run `pnpm --filter @vetapp/frontend build` BEFORE taking a queue slot (the
// gate whose manual-path skip broke master 10:40–12:00 on 2026-06-10).
export function buildPreflightNeeded(changedFiles) {
  return (changedFiles || []).some((f) => /^frontend\/src\//.test(f));
}

// (plan 556's generatedArtifactPreflightNeeded predicate — which gated the
//  generated-artifact freshness land-time preflight — was REMOVED by plan 1024:
//  frontend/public/clinics-index.json is now build-generated + gitignored, so there
//  is no committed artifact to regenerate-and-diff before the merge.)

// plan 771's `mobilePreflightNeeded` moved to scripts/project/land-gate-mobile.mjs (plan 4096 T1/S9).

// plan 3961 T2.7c: the pytest-preflight trigger closure — PYTEST_PREFLIGHT_CLOSURE (private),
// pathCoversLocal (private) and pytestPreflightNeeded — moved to
// scripts/project/land-gate-pytest.mjs, alongside the rest of the pytest gate (plan 3961 T2.3).
// Since plan 4096 T1/S9 this file neither imports nor re-exports it: the carry-forward roster
// reaches the predicate as the pytest gate's own registry `applies`.

// plan 2875 task 4/Part A: the FULL `scripts/*.test.mjs` node:test battery must pass before a
// land merges. `scripts/**/*.mjs` (recursive — scripts/ is not flat, e.g.
// scripts/lib/decision-dossier/inline.mjs; a test's dependency closure reaches nested files the
// same way select-battery-tests.mjs's own reference walk does) mirrors the coord-machinery blast
// radius the plan's own design-principle table names: this tree is consumed by every parallel
// session the instant it lands.
// plan 2875 cluster 5 (review fix): also fires on a change to the gate script itself
// (scripts/hooks/pre-push.sh). Before this, a diff touching ONLY that file matched neither this
// predicate NOR the hook's own push-time trigger (scripts/hooks/pre-push.sh's identical `.mjs`-only
// pattern, fixed alongside this) — so a broken pre-push.sh change could reach master with the
// scripts battery never proving it, at push time OR at land time (finding dfc45c). The file is not
// itself a `.mjs`, but it IS the gate logic the battery closure exists to protect — select-battery-
// tests.mjs already treats it as an external-tree path the flat import-closure selector cannot
// scope (its own NESTED_SCRIPTS_PATH_RX / EXTERNAL_TREE_PREFIXES machinery), so once this predicate
// fires the selector correctly falls back to the FULL battery on its own; this predicate only had
// to stop being blind to the file in the first place.
// plan 3765: where hook implementations live, for the JS side of the gates.
// `batteryPreflightNeeded` (land time) keys on it directly, and `isReviewableDiff`'s
// SCRIPTS_SHELL_RE is a deliberate SUPERSET of it, so a relocation cannot move the
// battery trigger while leaving the review gate on the old directory.
//
// The PUSH-time twin, `scripts/hooks/pre-push.sh`'s own grep, cannot import this — it is
// shell. It therefore spells the same prefix literally, and the two are held in step by a
// TEST that reads the real hook text (`pre-push-hook.test.mjs`, "the push-time battery
// trigger names the same hooks directory the JS gates do") rather than by a comment
// asking the next reader to remember. gpt-review round 4 caught this stated-but-
// unenforced sharing; the guard is the answer, not the claim.
// Trailing slash included: it is matched with startsWith.
export const HOOKS_DIR_PREFIX = 'scripts/hooks/';

export function batteryPreflightNeeded(changedFiles) {
  return (changedFiles || []).some(
    // The whole hooks dir, not just .mjs + the pre-push.sh carve-out — the moved SHELL
    // hooks matched neither, so their tests never ran at land time. Kept identical in
    // meaning to pre-push.sh's own trigger (they must not drift).
    (f) => /^scripts\/.*\.mjs$/.test(f) || f.startsWith(HOOKS_DIR_PREFIX),
  );
}

// plan 2875 delta round 2 (cluster D, review fix — findings d08b59/7157d9/89c720): decide
// acquireBatteryLock's `{ token, concArgs }` outcome from a spawnSync-shaped result (`{ stdout,
// status, error }`), pure — extracted from done-worktree.mjs's acquireBatteryLock so the fix below
// is directly unit-testable without mocking spawnSync or waiting out a real multi-minute timeout.
//
// `status === 4` is battery-lock.mjs's own EXIT_TIMEOUT: admitted to the overflow slot (a token IS
// present — hold it) or the wait simply expired (no token) — either way the mutex's documented
// contract is REDUCED parallelism, never a skip.
//
// `r.error?.code === 'ETIMEDOUT'` is the round-2 fix: OUR OWN spawnSync `timeout` option firing is
// NOT a status battery-lock.mjs ever returned — the caller sizes that timeout well above
// battery-lock's own wait ceiling (see BATTERY_LOCK_ACQUIRE_TIMEOUT_MS), so by construction this
// can only fire after waiting past that ceiling, i.e. behind a holder that is STILL alive. That
// makes it exactly as much a load signal as EXIT_TIMEOUT, and it must clamp the same way — never
// fold into the generic "lock ERROR, run unserialized at full width" branch below, which is exactly
// how the round-1 fix regressed (the plan-2734 thundering herd, reintroduced through a backstop
// meant only as a sanity net).
//
// Any OTHER status/error (a lock ERROR — a flag typo, an fs refusal) is NOT a load signal and keeps
// today's full-parallelism fallback, mirroring scripts/hooks/pre-push.sh's own non-4 branch.
export function batteryLockAcquireOutcome(r) {
  const token = ((r && r.stdout) || '').trim();
  const status = !r || r.error || typeof r.status !== 'number' ? null : r.status;
  if (status === 0 && token) return { token, concArgs: [] };
  if (status === 4) return { token: token || null, concArgs: ['--test-concurrency=2'] };
  if (r?.error?.code === 'ETIMEDOUT') return { token: null, concArgs: ['--test-concurrency=2'] };
  return { token: null, concArgs: [] };
}

// plan 2875 delta round 3 (finding 8e5a63, review fix): runViaTestQueue's own
// `{ code, error, timedOut }` → gate outcome, pure — extracted so the fix (a killed run ALWAYS
// fails, whatever `code` the child happened to report) is directly unit-testable without racing a
// real spawn against a real timer, mirroring why batteryLockAcquireOutcome above was extracted.
//
// THE BUG THIS CLOSES: the caller used to check `code === 0` before checking `timedOut` — so a
// child that our own timer already tree-killed, but that ALSO reports (or raced to report) exit
// code 0 on its way out (e.g. it was mid-graceful-shutdown when SIGTERM/taskkill reached it, or it
// finished within microseconds of the timer firing), was reported as a PASSING gate. A killed run
// is a run this preflight could never prove finished within its required cap — the only sound
// verdict is failure, unconditionally, however the child's own exit code came out. So `timedOut` is
// now checked FIRST and wins outright: nothing after it can turn a timeout into a pass.
//
// `error` (a spawn failure — the process never started at all) is checked before `timedOut` too:
// `waitForExit` never sets both, but ordering it first keeps this function correct even if that
// invariant ever loosens, and its own message is more specific than a generic timeout/tail.
//
// `tail` (already bounded by the caller via boundedAppend, plan 2875 delta round 3 finding
// b8d981/d83dbb) can legitimately be empty — a process that exits nonzero before writing anything.
// The old execFileSync-based implementation this replaced always had `e.message` to fall back on;
// this shape does not, so an empty tail on a genuine nonzero exit gets an explicit fallback message
// (finding c9d050) instead of silently handing the operator nothing to diagnose.
// defaultNonTtyReporter relocated to battery-ledger.mjs (plan 3962 Decision 5).

// plan 3954 T2 code-review round 2 (findings 59ec4a/202420/abb462): the NESTED wrapper shape —
// `queued-run.mjs`'s own inner Python spawn (or, at the extreme, the pytest MASTER process
// itself) hits a WinError/NTSTATUS spawn-init refusal, logs it, and exits 1 — leaves a NON-EMPTY
// `tail` (the wrapper's own error text), so the `!tail && looksSpawnStarved(code)` branch above
// never fires (that branch is deliberately "no output at all"). A pytest run that genuinely
// FINISHES and fails always prints a verdict summary line ("N passed", "N failed", "no tests
// ran", …); a process that starved before pytest ever got that far never does. This line's
// presence is therefore the same "did the process even get far enough to run pytest" signal the
// tail-emptiness check above uses for the no-output shape, extended to the non-empty-tail shape.
const PYTEST_VERDICT_LINE_RE =
  /\b\d+\s+(?:passed|failed|errors?|skipped|xfailed|xpassed|deselected)\b|no tests ran|no tests collected/i;

// plan 3954 T2 round-3 review (findings e87a4f/a1708a/f33651/82a4fc): the earlier "any spawn
// signature anywhere in the tail, no verdict line" rule over-fired on a truncated REAL assertion
// that merely mentions a signature-looking number with the summary cut off — that is a real
// regression, not proof the wrapper never launched pytest. Narrow to the two shapes that ARE
// actual evidence of that: (1) the tail's LAST non-empty line is the wrapper's own spawn-failure
// line (`queued-run.mjs:91`'s `queued-run: failed to spawn ...`), itself carrying a starvation
// signature — nothing after that line could be a pytest verdict, because the wrapper never got
// far enough to run pytest at all; or (2) the tail carries an xdist `INTERNALERROR>` block (xdist's
// own crash report when a WORKER dies mid-run, before any per-test verdict can be attributed to
// it) whose text carries a signature or a bare `MemoryError`.
const QUEUED_RUN_SPAWN_FAILURE_LINE_RE = /^queued-run: failed to spawn\b/;
const INTERNALERROR_BLOCK_RE = /INTERNALERROR>[\s\S]*/i;

function tailLastNonEmptyLine(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return '';
}

function tailShowsWrapperNeverDeliveredVerdict(trimmedTail) {
  const lastLine = tailLastNonEmptyLine(trimmedTail);
  if (QUEUED_RUN_SPAWN_FAILURE_LINE_RE.test(lastLine) && looksSpawnStarved(lastLine)) return true;
  const internalError = INTERNALERROR_BLOCK_RE.exec(trimmedTail);
  if (
    internalError &&
    (looksSpawnStarved(internalError[0]) || /\bMemoryError\b/.test(internalError[0]))
  ) {
    return true;
  }
  return false;
}

// plan 4006: `neverAdmitted`/`admissionMeasuredWaitMs`/`admissionBackstopMs` are additive and
// OPTIONAL — every existing caller/test that omits them gets byte-identical behavior (`neverAdmitted`
// undefined is falsy, so the new branch below never fires). Set by `runViaTestQueue`
// (done-worktree.mjs) when its own admission scan (plan 4003 T1) never saw the queued-run.mjs
// marker before this run ended: the run was bounded by the shared queue's pre-admission BACKSTOP,
// not by its own `timeoutMs` — nothing this run's cap was meant to bound ever got the chance to
// run at all, so classifying it as an ordinary cap-kill (the generic `timedOut` branch below) would
// misreport a starved run as a failing/too-slow test suite. Checked BEFORE that generic branch —
// mirrors the PYTEST_STARVED precedent (this same file's `starved` convention elsewhere): a starved
// run sets `starved: true` so callers already reading `.starved` (state.pytestStarved,
// pytestIsolationRecheck) treat it as "proved nothing", never as a red diff.
//
// plan 4006 review round 1 (findings d6bf79/ab9ea5/4a76e3): `slotStarved: true` rides ALONGSIDE
// `starved: true` here, additive and never set anywhere else in this function. The caller
// (runViaTestQueue) also rides `timedOut: true` on this same outcome — required for the cloud-
// chunking path's own `runCap.usingChunkCap` reliance on it — so a consumer that checks `.timedOut`
// before `.starved` silently discards this classification (exactly the bug the three findings
// report). `slotStarved` gives a consumer a flag to check FIRST, distinct from the plain OOM-spawn-
// signature `starved` shape elsewhere in this function (which never sets `slotStarved` — the two
// starvation causes narrate different messages and must stay tellable apart).
export function testQueueRunOutcome({
  code,
  error,
  timedOut,
  tail,
  label,
  timeoutMs,
  neverAdmitted,
  admissionMeasuredWaitMs,
  admissionBackstopMs,
}) {
  // plan 3961 review (rev-telemetry, BLOCKING): the guard is `neverAdmitted` ALONE, not
  // `timedOut && neverAdmitted`. The caller's header claimed `neverAdmitted` implies `timedOut`
  // "by construction" — that until admission only the pre-admission backstop can end the run — and
  // that is false. `queued-run.mjs` prints the admission marker from INSIDE the `withTestSlot`
  // callback, which runs only after `acquire()` resolves; if `acquire()` rejects (a corrupt lock
  // file, an unexpected fs error, any bug in the queue itself) the callback never runs, the marker
  // is never printed, and queued-run exits 1 through its own `.then(_, handler)` — an ordinary
  // child exit that our deadline timer never fires for, so `timedOut` stays false. The outcome then
  // fell past every starvation branch to the generic fallback and was reported as an ordinary gate
  // failure: the operator is told the test suite failed when the queue wrapper crashed before the
  // suite ever started. `neverAdmitted` is already the precise signal on its own — the marker is
  // printed immediately before the wrapped command runs, INCLUDING on every fail-open path, so its
  // absence means the command never started, whatever killed the wrapper.
  //
  // It is guarded by "the run did not succeed", NOT by `timedOut`, and that distinction is the
  // whole fix. `timedOut` was standing in for two different things at once: "this run did not
  // pass" (which the branch genuinely needs — a clean exit whose caller simply never armed the
  // scan must stay a pass, pinned by done-worktree-lib.test.mjs's own plan-4006 test) and "our
  // backstop is the only thing that can have ended it" (which is false, and is what dropped the
  // wrapper-crash case). Splitting them keeps the first and discards the second.
  const ranClean = code === 0 && !error;
  if (neverAdmitted && !ranClean) {
    return {
      ok: false,
      starved: true,
      slotStarved: true,
      // plan 4006 review round 3 (findings 3c7871/a3f5ba/f705c6): `starved` alone conflates TWO
      // distinct causes this function classifies — a busy shared queue (this branch) and an
      // out-of-memory box (the three branches below) — and a consumer wording the diagnosis for an
      // operator needs to tell them apart, not just know "this run proved nothing". Additive,
      // omitted (never a third state) when not starved, same convention as `starved`/`timedOut`.
      starvedCause: 'queue',
      // Two ways to reach here, and they must not tell the same story. `timedOut` means OUR
      // pre-admission backstop killed it while it still queued. Without it the wrapper ended on
      // its own before admission, so claiming a backstop kill would be a fabricated diagnosis —
      // name the wrapper's own exit and carry its output, which is where the real cause is.
      detail: timedOut
        ? `${label} was never admitted to the shared heavy-test queue — killed after ` +
          `${Math.round((admissionMeasuredWaitMs ?? 0) / 1000)}s by the ` +
          `${Math.round((admissionBackstopMs ?? 0) / 1000)}s pre-admission backstop (plan 4006), ` +
          `not by its own ${Math.round(timeoutMs / 1000)}s cap — nothing this run's own cap bounds ` +
          `ever ran`
        : `${label} never reached the shared heavy-test queue: the queued-run wrapper itself ` +
          `ended after ${Math.round((admissionMeasuredWaitMs ?? 0) / 1000)}s without ever ` +
          `announcing admission, so the command it wraps never started and nothing this run's own ` +
          `${Math.round(timeoutMs / 1000)}s cap bounds ever ran. This is NOT a test failure — ` +
          `the queue wrapper is what broke` +
          (tail ? `. Its output: ${tail}` : '.'),
    };
  }
  if (error) {
    // plan 3954 code-review findings 6c3299/23c850/75c9f2: `waitForExit` maps a Node spawn
    // `error` event to `{ code: null, error }` (kill-tree.mjs) BEFORE any exit code exists to
    // check `looksSpawnStarved(code)` against below — so a Windows CreateProcess refusal that
    // never gets far enough to hand back an NTSTATUS (e.g. the `[WinError 1455]` paging-file
    // text `_seed_validation.py`'s own OSError branch matches) surfaces only in `error.message`,
    // and would otherwise fall straight into the generic "failed to spawn" detail below with no
    // `starved` flag. Check the message (and, defensively, `.code`) the same way.
    //
    // plan 3954 code-review round 2 (finding 99d244): `looksSpawnStarved` only recognises
    // Python's own OSError text/NTSTATUS numbers — a REAL Node child_process spawn `error` on
    // Windows never carries that vocabulary at all; libuv/Node's own spawn refusal surfaces as a
    // plain errno-shaped error (`{ code: 'ENOMEM', message: 'spawn ENOMEM' }` / `'EAGAIN'`
    // style), which the text check above cannot recognise. Check the Node errno codes directly,
    // alongside (not instead of) the existing text check — both can fire depending on which
    // layer actually produced the refusal.
    const starved =
      looksSpawnStarved(error.message) ||
      looksSpawnStarved(error.code) ||
      error.code === 'ENOMEM' ||
      error.code === 'EAGAIN';
    return {
      ok: false,
      // Omitted (never `starved: false`) when not starved — every existing caller reads only
      // `.ok`/`.detail` and asserts the object shape exactly (deepEqual), the same convention the
      // non-error branches below already follow for their own `starved` flag.
      // plan 4006 review round 3: `starvedCause: 'spawn'` alongside — a spawn `error` is always the
      // OOM/spawn-init cause, never queue admission (which never even reaches a real spawn attempt).
      ...(starved ? { starved: true, starvedCause: 'spawn' } : {}),
      detail: `${label} failed to spawn — ${error.message || error}`,
    };
  }
  if (timedOut) {
    return {
      ok: false,
      detail:
        `${label} hit its ${Math.round(timeoutMs / 1000)}s cap and was tree-killed (no orphan ` +
        `left behind — kill-tree.mjs)${tail ? `\n${tail}` : ''}`,
    };
  }
  if (code === 0) return { ok: true };
  // plan 3954 T2 round-3 review (item 2a): a captured tail of pure whitespace (e.g. a bare
  // trailing newline) is the SAME "no captured output" shape as a genuinely empty tail — trim
  // before testing, so a known spawn-starvation exit code is not missed just because the child
  // managed to flush one blank line before dying.
  const trimmedTail = typeof tail === 'string' ? tail.trim() : tail;
  // plan 3954 T2: a NON-ZERO exit whose code is a known spawn-starvation NTSTATUS AND produced NO
  // captured output at all is a child that never started, not a child that ran and rejected
  // something — "no captured output" is the same condition the generic fallback message just
  // below already gates on (an empty `tail`). Additive (`starved`, mirroring `timedOut` on the
  // caller's own outcome object): every existing caller reads only `.ok`/`.detail` and is
  // unaffected; a caller that wants the distinction (pytestIsolationRecheck) reads `.starved`.
  if (!trimmedTail && looksSpawnStarved(code)) {
    return {
      ok: false,
      starved: true,
      starvedCause: 'spawn', // plan 4006 review round 3 — a signature exit code is always OOM/spawn
      detail:
        `${label} exited with code ${code} (a spawn-init failure, not a test verdict — the ` +
        `process never produced any output) and produced no captured output`,
    };
  }
  // plan 3954 T2 code-review round 2 (findings 59ec4a/202420/abb462), narrowed in round 3 (see
  // tailShowsWrapperNeverDeliveredVerdict above): the nested wrapper shape — a spawn-starvation
  // signature in one of the two shapes that are actual proof pytest itself never ran, with NO
  // pytest verdict summary line present anywhere in the tail. A REAL pytest run that fails always
  // carries its own verdict line even when a FAILED reason happens to mention a signature-looking
  // number, so that shape still falls through to the ordinary `detail: tail` return below, exactly
  // as `allFailedTestsSpawnStarved` already requires for the tail-parsed classification path.
  if (
    trimmedTail &&
    !PYTEST_VERDICT_LINE_RE.test(trimmedTail) &&
    tailShowsWrapperNeverDeliveredVerdict(trimmedTail)
  ) {
    return {
      ok: false,
      starved: true,
      starvedCause: 'spawn', // plan 4006 review round 3 — a nested wrapper spawn failure is OOM/spawn
      detail: `${label} could not even launch pytest (a spawn-init failure) — ${tail}`,
    };
  }
  return {
    ok: false,
    detail: tail || `${label} exited with code ${code} and produced no captured output`,
  };
}

// plan 1723 E2: a fresh worktree cut by cut-worktree has NO node_modules (gitignored, not
// carried over) until `pnpm install` runs (E1 does this at cut time; this is the belt-and-
// suspenders for the rare case where that install failed or the worktree was hand-created).
// A land whose diff touches an app-source surface — frontend/**, backend/**, shared/**,
// scripts/** — runs node-based gates (next build, vitest, tsc, prettier) that CANNOT execute
// without deps, so a missing node_modules there must fail-fast at preflight rather than surface
// as a cryptic mid-land gate failure (or, worse, let a worker falsely self-report those gates
// green — the 1710/1711 lands, 2026-07-11). Docs/plans/seed-only lands need no node gate and
// so are exempt. Pure.
export function nodeModulesGatesNeeded(changedFiles) {
  return (changedFiles || []).some((f) => /^(frontend|backend|shared|scripts)\//.test(f));
}

// plan 1723 E3: the prettier-relevant subset of a changed-file list — the exact extension set
// the scripts/hooks/pre-push.sh prettier gate scopes to (kept in sync with that regex). prettier itself
// applies .prettierignore to the explicit paths it is handed (seed/lockfiles/plans/board/*.py
// are skipped), so this filter only trims by extension; the caller drops paths that no longer
// exist on disk before invoking prettier (a deleted/renamed-away path errors prettier). Pure.
export function prettierDriftCandidates(changedFiles) {
  return (changedFiles || []).filter((f) =>
    /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|yml|yaml)$/.test(f),
  );
}

// plan 1723 review (F3/F4): split a prettier file list into length-BOUNDED arg chunks (the twin
// of scripts/hooks/pre-push.sh's `xargs -s 6000`). One unbounded `pnpm exec prettier --check <files…>` arg
// spread overflows cmd.exe's ~8191-char command line for a wide land (the plan-628 class), which
// execFileSync would surface as a spurious PRETTIER_DRIFT. On win32 the caller runs prettier with
// shell:true (pnpm is pnpm.cmd), which joins args UNQUOTED — so a path containing whitespace is
// quoted HERE (else cmd.exe mis-splits it, F3); off-win32 shell is false and args pass literally,
// so quoting must NOT be added. `win` is a param (not process.platform) so this stays deterministic
// under test. Returns an array of arg-arrays; an empty input yields []. Pure.
export function prettierArgChunks(files, { win = false, max = 6000 } = {}) {
  const arg = (f) => (win && /\s/.test(f) ? `"${f}"` : f);
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const f of files || []) {
    const a = arg(f);
    if (cur.length && len + a.length + 1 > max) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(a);
    len += a.length + 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ── plan 972: keep-hot land-prep marker + speculative-gate fast-path (pure) ──
// The keep-hot driver (the plan-969 landing-queue watcher) rebases a QUEUED worktree
// branch onto origin/master each time the remote advances and stamps a `land-prep`
// marker recording { branchSha, baseSha, gateResults, ts }. At head, done-worktree
// consults the marker: when it is still current (landPrepValid) the rebase + gate
// re-runs are provably a no-op and the mutex-held window collapses to merge+push —
// front-loading the serialized seed re-apply that today happens at head inside the
// LANDING mutex. Pinning gate validity to baseSha also fixes the latent soundness gap
// where the pre-queue gates ran against the PRE-rebase tree.

// Which heavy pre-queue gates a LANDED sibling delta (the files that changed on
// origin/master between the marker's baseSha and the new tip) forces to re-run after a
// keep-hot rebase. Composes the SINGLE-SOURCE-OF-TRUTH gate predicates so a gate's
// trigger surface is never re-declared. A delta that touches NONE of them leaves the
// cached gateResults valid — the cap that stops every unrelated land re-running the
// multi-minute next-build / mobile gates. Backend VITEST is cheap → re-run regardless, not
// modelled here — but plan 2875's two new tiers (pytest / the scripts battery) are exactly as
// heavy as build/mobile, so they ARE modelled the same way. Total function (nullish delta ⇒
// nothing touched).
//
// plan 4096 T1/S9: `predicates` is the ROSTER, and it is never hand-listed here. It maps each
// prep key (PREP_GATE_TO_LAND_GATE's left column) to that gate's own trigger predicate, and the
// ONE production builder is gates-runner.mjs's `prepGatePredicates(registries)`, which derives it
// from the registered preflight-stage, prep-pass prepGates entries' own `applies`. Before this the
// four keys and their four predicates were spelled here, three of them project-shaped (a
// frontend path regex, the mobile watch list, the pytest closure) — so the lib could not load
// without the project layer, and a gate added to the registry was silently absent from the cap.
// A missing table is REFUSED (never defaulted to "no gates"): an empty roster would carry every
// gate forward unproven, which is the silent under-run this cap exists to prevent.
export function assertPrepGatePredicates(predicates, where) {
  const bad =
    predicates === null ||
    typeof predicates !== 'object' ||
    Array.isArray(predicates) ||
    Object.values(predicates).some((fn) => typeof fn !== 'function');
  if (bad) {
    throw new TypeError(
      `${where}: needs the registry-derived prep-gate predicate table ({ <prepKey>: (files) => ` +
        `boolean }, built by gates-runner.mjs's prepGatePredicates) — got ` +
        `${predicates === null ? 'null' : Array.isArray(predicates) ? 'an array' : typeof predicates}` +
        ` (plan 4096 S9: the roster is never hand-listed or defaulted)`,
    );
  }
  return predicates;
}

export function gateInputsTouched(delta, predicates) {
  assertPrepGatePredicates(predicates, 'gateInputsTouched');
  const files = delta || [];
  const touched = {};
  let any = false;
  for (const [key, applies] of Object.entries(predicates)) {
    touched[key] = Boolean(applies(files));
    any = any || touched[key];
  }
  return { ...touched, any };
}

// Is the `land-prep` marker still a valid fast-path at head? STRICT by design: BOTH the
// recorded baseSha must equal the live origin/master tip AND the recorded branchSha must
// equal the live branch tip. Any movement of either (a sibling landed; a newer worktree
// commit) ⇒ false ⇒ the caller falls back to the full rebase + gate path. Correctness
// over speed — a missing / partial / empty-sha marker is NEVER valid (no silent skip).
//
// plan 2875 cluster 3 (review fix): sha equality alone proves the marker's TREE matches — it says
// nothing about whether `marker.gateResults` ever recorded a verdict for a gate THIS branch's
// diff now requires. `gateResults`/`ts` are documented as optional metadata (parseLandPrepMarker),
// so a marker written before plan 2875 (or by any path that predates the pytest/battery tiers)
// still carries only `{ baseSha, branchSha }` and used to pass this proof anyway — letting the fast
// path skip gates it never ran, fail-open on exactly the tier this plan exists to guarantee.
// `changed` (optional, 4th arg — every existing caller updated to pass it) is fed through
// `landPrepGatesToRun`'s own `applicable` predicate (the `hasPrior=false` branch: "which gates does
// THIS diff need", independent of any prior) so the required set can never drift from the one
// `runPrepGates` itself uses to decide what to (re)run. Every required key must carry a `true`
// verdict already recorded; a missing `gateResults`, a missing key, or a recorded `false` fails
// CLOSED to the full rebase + gate path — never a silent skip. `changed` flows straight into
// `buildPreflightNeeded`/etc, which all treat a nullish list as "nothing applicable" (same as every
// other consumer of those predicates), so an omitted `changed` degrades to the pre-2875 sha-only
// proof rather than throwing — never a special case here.
export function landPrepValid(marker, currentTip, branchTip, changed, branchRef, predicates) {
  assertPrepGatePredicates(predicates, 'landPrepValid');
  if (!marker || typeof marker !== 'object') return false;
  const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length >= 7 && a === b;
  if (!eq(marker.baseSha, currentTip) || !eq(marker.branchSha, branchTip)) return false;
  if (!markerReadFromBranch(marker, branchRef)) return false;
  return gateResultsCoverRequired(marker, changed, predicates);
}

// gpt-review 2940 round 2 [c7044f/c4a65e/bead3c/f02d76] + round 3 [7475b7]: may the speculative
// pass `reset --hard` this worktree back to its plain-prepped tip?
//
// The hazard `reset --hard` carries is that it moves whatever ref HEAD points at. That makes the
// rule about WHICH ref, not about attachment as such — and the two are not the same question:
//
//   * attached to OUR branch  ⇒ ALLOW. The ordinary rollback; the ref it moves is ours.
//   * DETACHED                ⇒ ALLOW. There is no branch ref to damage: the reset moves HEAD
//     alone, and the branch still points where it did before the speculative rebase. Round 2's
//     first cut refused this case too, which round 3 caught as a REGRESSION: refusing left the
//     stranded speculative tip in place, and `restorePrepAttachment` then also refuses (that tip
//     is not contained in the branch), so the worktree stayed detached-and-diverged with nothing
//     able to clean it. Allowing the reset restores HEAD to the branch's own tip, which is exactly
//     what lets the no-detached-exit invariant re-attach it losslessly.
//   * attached to ANOTHER branch ⇒ REFUSE. The commits it holds are not ours to move — the same
//     rule restorePrepAttachment's WRONG_BRANCH arm follows.
//   * UNREADABLE ⇒ REFUSE. We cannot show what we would be moving, and this is not a detached HEAD.
//
// Pure, so the rule is pinned by a test rather than by reading the call sites. Note it is NOT
// `worktreeAttachmentSeam`'s predicate (round 2 [a084a6] proposed reusing that): that one answers
// "is it safe to REBASE", where a detached HEAD is the canonical refusal. Here it is the canonical
// ALLOW. Same inputs, deliberately opposite answers.
export function speculativeRollbackAllowed(headRef, branch) {
  if (headRef === null) return true; // detached: the reset can only move HEAD
  return typeof headRef === 'string' && headRef === `refs/heads/${branch}`;
}

// plan 2940 (reader half of ruling 1): sha equality proves the marker's recorded tip matches the
// tip we just READ — it says nothing about which REF that sha came off. Both markers take their
// `branchSha` from `worktreeHeadSha`, i.e. `git rev-parse HEAD`, which equals the branch tip only
// while HEAD is ATTACHED to refs/heads/<branch>. On a worktree left DETACHED by a rebase that
// stopped mid-replay, that read returns the stranded commit, and the measured 2026-08-06 incident
// (plan 2933's land) is exactly what follows: a marker claiming `battery: true` for a sha holding
// 1 of the branch's 2 commits, missing every review fix — and the head-time proof could not tell,
// because the same detached HEAD reads back the same sha on both sides.
//
// So the marker now RECORDS the ref its `branchSha` was read from, and this is the consume-side
// check that it is the branch we are landing. The writer-side stamp assert (done-worktree.mjs) is
// the primary guard; this is the defense in depth ruling 1 asks for on the one artifact the fast
// path trusts — it also covers a marker stamped by an older done-worktree, or one that survived in
// `.scratch` across a re-cut worktree.
//
// Fails CLOSED in BOTH directions, deliberately, and unlike `changed` there is NO degrade-to-the-
// old-proof arm: a caller that cannot name the branch has not proven anything, and a marker with
// no recorded ref (every pre-2940 marker) is precisely the un-provable case. Rejecting only costs
// one full rebase + gate battery — the same price a missing marker has always cost.
function markerReadFromBranch(marker, branchRef) {
  if (typeof branchRef !== 'string' || branchRef === '') return false;
  return typeof marker.branchRef === 'string' && marker.branchRef === branchRef;
}

// Shared by landPrepValid and landSpecPrepValid (plan 2875 cluster 3) — both markers are stamped
// by the SAME runPrepGates loop and are exactly as exposed to a pre-2875 or otherwise-incomplete
// gateResults object; one predicate keeps the "which gates must this marker prove" question from
// answering itself two different ways.
function gateResultsCoverRequired(marker, changed, predicates) {
  const required = landPrepGatesToRun(changed, null, false, predicates);
  const results =
    marker.gateResults && typeof marker.gateResults === 'object' ? marker.gateResults : {};
  return Object.keys(required).every((key) => !required[key] || results[key] === true);
}

// Parse a serialized `land-prep` marker. Returns the object ONLY when it is a JSON object
// carrying both required sha strings; returns null on empty / garbage / non-object /
// partial input, so a corrupt marker degrades to the safe full-rebase fallback — never a
// throw, never a false fast-path. gateResults / ts are optional metadata, preserved verbatim.
//
// plan 2940: `branchRef` stays OPTIONAL here on purpose, even though `landPrepValid` now requires
// it. Parsing is the "is this a marker at all" question and its answer feeds more than the fast
// path — `hadMarker` telemetry, and the --prep carry-forward cap, which is keyed on
// `prior.branchSha === branchBefore` (tree identity, sound whichever ref that sha was read from).
// Rejecting a pre-2940 marker HERE would silently reclassify every one of those as "no marker",
// which is a different and less honest claim than "a marker that cannot prove its ref".
export function parseLandPrepMarker(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.baseSha !== 'string' || typeof obj.branchSha !== 'string') return null;
  return obj;
}

// Which heavy gates a keep-hot --prep must FRESHLY run after a rebase. A gate runs only when
// it is APPLICABLE to this branch's own diff (the same predicate the pre-queue gate uses) AND —
// if a prior marker exists to carry forward from — the LANDED delta (origin/master baseSha..new
// tip) touched its inputs. The FIRST prep (no prior) runs every applicable gate; a re-prep
// re-runs only those the landed delta could have invalidated, carrying the rest of the prior
// gateResults forward (the "cap heavy-gate re-runs" caveat — a docs-only land never re-runs the
// multi-minute next-build / mobile gates). Pure.
//
// plan 4096 T1/S9: keyed by exactly the keys of the registry-derived `predicates` table (see
// gateInputsTouched's own header) — plan 2875's pytest/battery tiers and plan 972's build/mobile
// ones are whatever the registry registers, never a list spelled here.
export function landPrepGatesToRun(changed, landedDelta, hasPrior, predicates) {
  assertPrepGatePredicates(predicates, 'landPrepGatesToRun');
  const applicable = {};
  for (const [key, applies] of Object.entries(predicates)) {
    applicable[key] = Boolean(applies(changed || []));
  }
  if (!hasPrior) return applicable;
  const touched = gateInputsTouched(landedDelta, predicates);
  const capped = {};
  for (const key of Object.keys(applicable)) capped[key] = applicable[key] && touched[key];
  return capped;
}

// plan 3503 D1: this translation is load-bearing, not cosmetic. `runPrepGates` names its results
// with the compact prep vocabulary, while `parseLandGatesProven` deliberately DROPS every name
// outside LAND_GATE_NAMES. Writing a raw prep key such as `pytest` would therefore create a
// sidecar entry that looks valid on disk but every later invocation silently discards — a no-op
// masquerading as a banked proof. `price-trust` has no prep counterpart and remains land-only.
export const PREP_GATE_TO_LAND_GATE = Object.freeze({
  build: 'build',
  mobile: 'mobile',
  pytest: 'pytest-backend-scripts',
  battery: 'scripts-battery',
});

// ── plan 2463: speculative stacking — prep position 2 against the head's tree ──────
//
// The plain land-prep marker above is anchored to origin/master-at-prep and invalidated by STRICT
// sha equality, so the head slot's own land — the ONE master movement a position-2 waiter can
// predict — invalidates it BY CONSTRUCTION. Measured over 1,817 head lands (coord-metrics.mjs,
// `fired` vs `hadMarker`) the plain fast path fired ONCE. Zuul-class merge queues close exactly
// this by gating each position against the SPECULATIVE result of everything ahead of it.
//
// The speculative base here is the head slot's BRANCH TIP, not a `merge-tree`-constructed merge
// commit (plan-body decision D1). The spine rebases a branch onto origin/master at step 3b BEFORE
// its ephemeral merge, so a head-of-queue branch tip already IS "master + the head's work" as a
// linear history. Stacking onto it therefore (a) reproduces the tree the post-land master will be
// merged against and (b) — load-bearing — makes that tip the MERGE-BASE of our branch and the
// post-land master, so the ephemeral `merge --no-ff` contributes ONLY our own commits: no phantom
// merge commit, no duplicated history, and no unpredictable sha for anything to match on.

// One level only. The plan's Non-goals rule out stacking deeper (position 3+ against two
// speculative lands): the rollback cases grow quadratically while a 1-2-deep busy queue is already
// the common case.
export const SPECULATIVE_POS = 2;

const shaLike = (s) => typeof s === 'string' && /^[0-9a-f]{7,40}$/.test(s);
const shaEq = (a, b) => shaLike(a) && shaLike(b) && a === b;

// May a `--prep` pass speculate right now? Every condition is a hard NO — speculation is purely
// opportunistic (the plan's mechanism step 4) and degrades to the plain prep on any doubt:
//   * position !== SPECULATIVE_POS — position 1 IS the head (nothing ahead), 0 means not queued,
//     and ≥ 3 would stack on two speculative lands (Non-goals).
//   * no head slug, or the head is us — nothing ahead to speculate on.
//   * an unresolvable head branch tip, or one equal to the master tip — an empty head branch makes
//     the speculative tree identical to the plain one, which the plain marker already covers.
//   * the head's branch does NOT already contain origin/master. A head that has not yet reached
//     its own step-3b rebase is based on an OLDER master, so stacking on it would gate a tree that
//     never comes to exist — and the resulting marker could never validate anyway (its recorded
//     baseSha would not be a parent of the merge the head eventually pushes).
// Pure.
export function shouldSpeculate({
  position,
  headSlug,
  ownSlug,
  headBranchTip,
  masterTip,
  headContainsMaster,
} = {}) {
  if (position !== SPECULATIVE_POS) return false;
  if (!headSlug || typeof headSlug !== 'string') return false;
  if (headSlug === ownSlug) return false;
  if (!shaLike(headBranchTip) || !shaLike(masterTip)) return false;
  if (headBranchTip === masterTip) return false;
  return Boolean(headContainsMaster);
}

// Parse a serialized speculative marker. Returns the object ONLY when it carries all four required
// shas, so a partial/corrupt marker degrades to "no speculation" — never a throw, never a false
// fast-path, and never an un-stack against a sha we cannot trust. `preSpecBranchSha` is the
// plain-prepped tip the un-stack restores; without it the marker is unusable for recovery, which
// is why it is required rather than optional metadata.
// ── plan 3295 E2/E3: the per-land `gatesProven` proof set ────────────────────────────────────
//
// THE RULING (operator 2026-08-19, verbatim "Once per land period"): on a LOCAL land each slow
// pre-queue part runs AT MOST ONCE. Once it has gone green inside a land it is never re-run in
// that land — not after a seed heal, not after a paperwork stop, not after a review fix, and not
// after the rebase/squash at the queue head. The plan-3214 land is the measured cost of the old
// behaviour: the full backend/scripts pytest suite ×3 (21 + 33 + ≥20 min) and the production
// build ×3, for a branch whose code had been green since before the first land launch.
//
// WHY THIS IS NOT THE PLAN-2462 CONTENT CACHE. That cache keys on the tree's CONTENT, which is
// exactly the thing every one of those events changes: a two-clinic seed heal, a review fix, a
// master merge at the queue head all mint a new content key and miss. The proof here is keyed to
// the LAND — so it survives every content change the land itself causes. The two stack: the
// per-land set sits IN FRONT of the content cache, and the content cache still serves a genuinely
// new land over an unchanged tree.
//
// SAFETY. Skipping is never blind, and NO gate is skipped outright on a delta it can still see
// (the first cut did skip build/mobile/price-trust that way, and gpt-review ea1746 / f3106d /
// 13f188 showed what it blinded). Every entry authorizes a skip only for the tree it was proven
// against; what changed SINCE that tree decides the rest:
//   `pytest-backend-scripts` / `scripts-battery` — run the DIFF-SCOPED selection of the remainder
//       (its surface includes the configured seed root, so a seed-only remainder runs the seed-gate
//       test subset rather than nothing);
//   `build` / `mobile` — skip only while the remainder touches NOTHING in that gate's own
//       content-cache key closure; anything inside it falls through to the plan-2462 cache, which
//       then decides whether a real build input moved;
//   `price-trust` — skip only while no seed path changed since the proof; otherwise the gate
//       re-runs over the REMAINDER rows (base = the proven tree), never over rows it already passed.
// A green refreshes the entry's sha, so each re-entry measures its remainder from the newest proof.
// Only the FULL re-run is what the land refuses to buy twice. Cloud lands write the set but never
// take the skip (`CLAUDE_CODE_REMOTE`), per the same ruling: cloud default stays full every land,
// chunked per plan 3274. And a 3274 chunk-resume is NOT green — only a whole-gate green ever
// writes an entry.
// plan 3961 T2.7a: there is no module-level roster constant here any more. `land.gateRoster` is
// GONE as a coord-config.mjs key — the once-per-land roster is derived from the land-gates
// registry (the preflight-stage prepGates, in registry order; see done-worktree.mjs's
// `landGateRosterFromRegistry`), which this pure module has no way to build (it does no IO and
// does not import the registry). `parseLandGatesProven` and `landGatesProvenPushEnv` below
// therefore take the roster as a REQUIRED parameter instead of defaulting to a constant here.

// One proof: the worktree HEAD sha the part actually ran against, plus when. The sha is not
// decoration — it is the BASELINE the diff-scoped remainder is computed from, so an entry without
// a usable one would authorize a skip nothing could bound. Refuses rather than stamping a
// placeholder.
//
// `envHash` (optional, plan 3295 review r2 — gpt-review 2f9fb2 / 97c100 / 41a726) is the digest of
// the gate's UNTRACKED inputs: the `envUncacheable` files `scripts/gate-pass-cache.mjs` declares
// (today `frontend/.env.local` for `next-build` and `mobile-gate`). A git delta cannot see those —
// they are gitignored, which is exactly why the pass cache refuses to serve a cached green while
// one exists — so a proof that carried only a sha could authorize a skip across a changed
// `NEXT_PUBLIC_*` value. Gates with no untracked inputs simply carry no `envHash`.
export function gateProvenEntry(sha, at = new Date(), envHash = undefined) {
  if (!shaLike(sha)) return null;
  const entry = { sha: String(sha), at: at instanceof Date ? at.toISOString() : String(at) };
  if (typeof envHash === 'string') entry.envHash = envHash;
  return entry;
}

// ── plan 4003 T2: a PARTIAL proof ─────────────────────────────────────────────────────────────
//
// A whole entry means "this gate went GREEN at `sha`, so only the delta since it is unproven". A
// partial entry means something strictly weaker and, before this plan, unsayable: "this gate was
// KILLED at `sha`, but these named files had already passed". Plan 3827's Fix B refused any credit
// for a timed-out run on the premise that "which files it never reached is unknown" — a premise
// the per-file ledger reporter made false, and one that cost 267 minutes on 2026-09-13 by making
// every cap-killed battery restart from file one.
//
// `provenFiles` IS the partial marker — its presence, not a separate boolean, so an entry cannot
// be half-labelled. Every consumer that authorizes a SKIP must therefore check for it and refuse:
// a partial proof authorizes a NARROWER RUN, never a skip. `normalizeProvenFiles` is what keeps a
// hand-edited or truncated sidecar from smuggling junk into that narrowing — a non-string, an
// absolute path, or a `..` escape is dropped, and dropping one can only ever make the next run
// WIDER, which is the safe direction.
export function normalizeProvenFiles(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  const seen = new Set();
  for (const p of raw) {
    if (typeof p !== 'string') continue;
    const rel = p.trim().replace(/\\/g, '/');
    if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('/')) continue;
    if (/^[A-Za-z]:/.test(rel)) continue; // a drive-qualified absolute is not repo-relative either
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

export function gatePartialProvenEntry(sha, provenFiles, at = new Date()) {
  const entry = gateProvenEntry(sha, at);
  if (!entry) return null;
  const files = normalizeProvenFiles(provenFiles);
  // An EMPTY proven set is not a proof of anything — recording it would put a partial entry on the
  // sidecar that narrows nothing while still having to be reasoned about. Refuse, and the next
  // invocation behaves exactly as it does today.
  if (!files || files.length === 0) return null;
  entry.provenFiles = files;
  return entry;
}

export function isPartialGateProof(entry) {
  return Array.isArray(entry?.provenFiles) && entry.provenFiles.length > 0;
}

// ── plan 4003 T2: the BATTERY_FAILED seam message ─────────────────────────────────────────────
//
// gpt-review r1 (f8cfcb / 22af55, two finders): the seam used to end with "Fix in the worktree,
// push, then re-invoke with --resume BATTERY_FAILED" UNCONDITIONALLY. For a KILLED run that advice
// is actively dangerous, and in the worst direction: `--resume BATTERY_FAILED` makes
// `resumedPast(BATTERY_FAILED)` true, which skips the battery step entirely — so an operator
// following the message would never run the files the partial proof just banked as unproven, and
// the land would proceed with them unverified. The first cut of this plan made it WORSE by adding
// a "bare re-invoke" note beneath the `--resume` line, leaving two contradictory instructions.
//
// So the two cases get two messages, never one with a footnote. A KILLED run names no `--resume`
// at all, because there is nothing to fix and resuming past the seam is the one thing that must
// not happen. Pure and exported so the contradiction is unit-testable without driving a land.
// gpt-review r2 (120093): `killed` and "nothing failed" are NOT the same claim. A run can hit its
// cap AFTER the reporter already recorded real failures, and the first cut asserted "No test
// failed, so there is nothing to fix" for that shape — false, and misleading in the direction that
// makes an operator stop looking. `failureCount` splits the two. What does NOT change with it is
// the `--resume` advice: a killed run's unproven remainder is unproven however the failures came
// out, so no killed shape may ever be told to resume past this seam.
//
// gpt-review r3 (72d6a5/2f4eed/533673/6b3a0b/a466a0 — five finders): `scope` is REQUIRED in
// substance, because r2 routed the diff-scoped arms through this builder and the text still said
// the FULL battery had run. An operator told "the FULL scripts battery rejected it" after a
// twelve-file subset ran will verify the wrong amount of work. It defaults to the full-suite
// wording only because that is what the original caller meant.
//
// gpt-review r4 (2c124b): `full` is DERIVED from `scope`, never supplied beside it. Two independent
// inputs describing one fact can contradict each other, and the contradiction this pair invites —
// a named subset scope with `full: true` — produces exactly the misleading sentence the r3 finding
// was about. Naming a scope IS the statement that this was not the full suite.
export function batteryFailedSeamMessage({ killed, detail, failureCount = 0, scope } = {}) {
  const full = scope === undefined;
  const what = scope ?? 'node --test scripts/*.test.mjs';
  const tail = `\n--- battery tail ---\n${detail || ''}`;
  if (killed) {
    // gpt-review r3 (c90e7a, PLAUSIBLE, accepted): zero RECORDED failures is not proof that none
    // occurred — a kill can outrun the reporter's flush. Say what is actually known ("none was
    // recorded") rather than the stronger claim the first cut made ("no test failed"), so an
    // operator who does find one afterwards has not been told it could not exist.
    const whatFailed =
      failureCount > 0
        ? `${failureCount} test file(s) DID fail before it died — fix those first. `
        : `No failing test was RECORDED before it died (a kill can outrun the reporter's flush, so ` +
          `this is "none seen", not "none happened"). `;
    return (
      `${what} was KILLED, not rejected — its cap fired, or its termination could not be proven. ` +
      `${whatFailed}Whatever it had already proved is banked as a partial land-gate proof, so ` +
      `re-invoke done-worktree BARE — same slug, no rebase, and specifically NOT ` +
      `--resume BATTERY_FAILED, which would skip the battery outright and land the unproven ` +
      `remainder unverified (plan 4003 T2/T4).` +
      tail
    );
  }
  const which = full
    ? `the land diff touches scripts/**/*.mjs and the FULL scripts battery rejected it (plan 2875: ` +
      `this preflight is now the only place a LOCAL land proves this tier)`
    : `a DIFF-SCOPED selection rejected it — only the files named below ran, NOT the full battery`;
  return (
    `${what} FAILED — ${which}. Fix in the worktree, push, then re-invoke with ` +
    `--resume BATTERY_FAILED.` +
    tail
  );
}

// plan 4006 review round 2: BATTERY_STARVED's own twin of batteryFailedSeamMessage above — round 1
// wired the seam into only the full-suite arm and hand-spelled its message inline, unconditionally
// naming the full suite ("node --test scripts/*.test.mjs"). Adding the same branch to the
// diff-scoped and partial-proof-remainder arms by copy-pasting that hand-spelling would re-open the
// EXACT drift plan 4003's gpt-review round 2 already found once for BATTERY_FAILED (see that
// builder's own header above) — a scope-blind message that tells the operator the wrong amount of
// work ran. `scope` follows batteryFailedSeamMessage's own contract: omitted means the full suite,
// named means this was not the full suite.
//
// plan 4006 review round 3 (findings 3c7871/a3f5ba/f705c6): `starved` covers TWO distinct causes
// (see testQueueRunOutcome's own header) — a busy shared queue, and a genuinely out-of-memory box
// (the shape FIX 3 taught the isolation-recheck classifier to recognise on the battery side too).
// This builder used to word EVERY BATTERY_STARVED as queue admission, which is simply wrong for
// the OOM shape. `cause` selects the wording; omitted (or 'queue', the only cause this seam could
// ever carry before this plan) keeps the ORIGINAL text verbatim, so every pre-existing caller that
// does not pass `cause` is unaffected. `freeMemText` is the caller's own `freeMemoryReading()`
// reading (this module stays fs/child_process/git-free per its own header — a live memory read is
// not a pure function of its inputs, so it is threaded in rather than read here).
export function batteryStarvedSeamMessage({ scope, detail, cause, freeMemText } = {}) {
  const what = scope ?? 'node --test scripts/*.test.mjs';
  if (cause === 'spawn') {
    return (
      `scripts battery preflight: ${what} is STARVED, not FAILED — a Windows spawn-init NTSTATUS ` +
      `signature (${freeMemText || 'free-memory reading unavailable'}, plan 3954/4006): the box ` +
      `was out of memory when a child process tried to start, so the code under test never ran. ` +
      `Re-invoke when the box has headroom — nothing to fix.\n--- battery tail ---\n${detail || ''}`
    );
  }
  // plan 4006 review round 3: "this run" (never "the isolation recheck") — this builder is now
  // ALSO reached when the ORIGINAL run itself was the one never admitted (FIX 1's
  // `batteryRedIsFlake` originalStarved shortcut, which never runs a recheck at all), so a
  // recheck-specific claim would be simply wrong there. `detail` (passed through unchanged) is
  // whichever run's own testQueueRunOutcome message — it already names the measured wait and the
  // backstop that fired.
  return (
    `scripts battery preflight: ${what} is STARVED, not FAILED — this run was never admitted to ` +
    `the shared heavy-test queue (plan 4006): the box had no queue slot to give it, so the code ` +
    `under test never ran. Re-invoke when the shared queue is free — nothing to fix.\n` +
    `--- battery tail ---\n${detail || ''}`
  );
}

// ── plan 4034 T5: the PYTEST_FAILED seam message ──────────────────────────────────────────────
//
// The pytest twin of `batteryFailedSeamMessage` above, and it exists for the same reason that one
// grew its `killed` arm: on 2026-09-14 a LOCAL land was tree-killed at its cap at 99% of
// `backend/scripts` with ZERO FAILED/ERROR lines, and the seam it emitted said "the FULL
// backend/scripts pytest suite rejected it … re-invoke with --resume PYTEST_FAILED". Every clause
// of that was wrong for a kill. Nothing rejected anything; and `--resume PYTEST_FAILED` makes
// `resumedPast(PYTEST_FAILED)` true, which SKIPS the pytest step outright — so an operator
// following the advice would land the unproven remainder with nothing having run it. The operator
// read it as "the next attempt starts again from test one", which the very next run disproved: it
// passed in 64 s, because the plan-3223 per-file ledger had already banked the ~99% the killed run
// proved and a bare re-invoke runs only the remainder. The mechanism was right; only the report
// lied.
//
// So, exactly as for the battery: two messages, never one with a contradictory footnote. A KILLED
// run names no `--resume` at all, and it names the three things the 2026-09-14 message left the
// operator to guess — the cap it hit, what was banked and under which ledger key, and that the
// bare re-invoke is the whole recovery.
//
// `failureCount` splits "killed" from "nothing failed", the same way `batteryFailedSeamMessage`'s
// own r2 finding required: a cap can fire AFTER real failures were recorded, and claiming "nothing
// failed" there stops an operator looking. `capS`, `bankedFiles`, `collectedFiles` and `ledgerKey`
// are all OPTIONAL — each clause is simply omitted when its input is unknown, because a kill that
// could not parse its own events is precisely when an invented number would mislead most.
// `scope` follows `batteryFailedSeamMessage`'s contract: omitted means the full suite.
export function pytestFailedSeamMessage({
  killed,
  detail,
  failureCount = 0,
  capS,
  bankedFiles,
  collectedFiles,
  ledgerKey,
  scope,
} = {}) {
  const full = scope === undefined;
  const what = scope ?? 'python -m pytest backend/scripts';
  const tail = `\n--- pytest tail ---\n${detail || ''}`;
  if (killed) {
    const cap = Number.isFinite(capS) && capS > 0 ? ` after ${Math.round(capS)}s` : '';
    const whatFailed =
      failureCount > 0
        ? `${failureCount} test(s) DID fail before it died — fix those first. `
        : `No failing test was RECORDED before it died (a kill can outrun the reporter's flush, so ` +
          `this is "none seen", not "none happened"). `;
    // gpt-review r1 (4 finders, BLOCKING): the REMAINDER promise is true only where a per-file
    // ledger actually persisted this run's greens, and `ledgerKey` is the only input that says so.
    // Two real callers have no ledger at all — the diff-scoped selection (which simply runs the
    // chosen files) and the full-suite NO-KEY branch — and telling either of them that a bare
    // re-invoke "executes only the remainder" is the same class of misinformation this builder
    // exists to remove. So the recovery sentence branches on the LEDGER, not on the kill.
    //
    // The reach clause is likewise stated as what the run GOT THROUGH, never as a persistence
    // claim: `pytest-merge` is best-effort and swallows its own write failures, so "this round
    // proved N files" is knowable here while "N files are durably banked" is not.
    const reach =
      Number.isFinite(bankedFiles) && Number.isFinite(collectedFiles) && collectedFiles > 0
        ? `It got through ${bankedFiles} of the ${collectedFiles} file(s) it collected ` +
          `(${Math.round((bankedFiles / collectedFiles) * 100)}%). `
        : Number.isFinite(bankedFiles)
          ? `It got through ${bankedFiles} file(s). `
          : '';
    // gpt-review r2 (3 finders: angle-B / guard-fires / writer-trace): the guard is the key AND a
    // real banked count, never the key alone. `pytest-merge` is best-effort and its failure is
    // swallowed, so a truthy key by itself says only that ledger MODE was on — promise a remainder
    // on that and a run whose merge failed sends the operator into a full re-run believing it will
    // resume. The caller now withholds the key unless the merge provably persisted something
    // (`done-worktree.mjs`), and this belt-and-braces check keeps the builder honest on its own.
    const remainderIsReal = Boolean(ledgerKey) && Number.isFinite(bankedFiles) && bankedFiles > 0;
    const recovery = remainderIsReal
      ? `Those greens were merged into the per-file ledger under key ${ledgerKey}, so re-invoke ` +
        `done-worktree BARE — same slug, no rebase — and the next run executes only the ` +
        `REMAINDER, not the suite from the top.`
      : `This path keeps no per-file ledger, so a bare re-invoke will re-run this selection from ` +
        `the top — re-invoke done-worktree BARE anyway (same slug, no rebase); there is nothing ` +
        `to fix and nothing to resume past.`;
    return (
      `${what} was KILLED${cap}, not rejected — its whole-run cap fired. ${whatFailed}${reach}` +
      `${recovery} Specifically do NOT --resume PYTEST_FAILED: that skips the pytest step ` +
      `outright and would land the unproven remainder unverified (plan 4034 T5). If a bare ` +
      `re-invoke is killed again at a high completion percentage with no failures, the cap needs ` +
      `re-deriving against that run's own admitted worker count (workers= in the gate-outcome ` +
      `telemetry), not a code change.` +
      tail
    );
  }
  const which = full
    ? `the land diff touches backend/scripts/** or shared/src/** and the FULL backend/scripts ` +
      `pytest suite rejected it (plan 2875: this preflight is now the only place a LOCAL land ` +
      `proves this tier)`
    : `a DIFF-SCOPED selection rejected it — only the files named below ran, NOT the full suite`;
  return (
    `${what} FAILED — ${which}. A ModuleNotFoundError is a missing dep (python -m pip install -r ` +
    `backend/scripts/requirements.txt), never a --no-verify equivalent. Fix in the worktree, push, ` +
    `then re-invoke with --resume PYTEST_FAILED.` +
    tail
  );
}

// plan 4006 review round 3 (findings 3c7871/a3f5ba/f705c6): PYTEST_STARVED's own twin of
// batteryStarvedSeamMessage immediately above — before this fix the two pytest call sites
// (done-worktree.mjs, the diff-scoped and full-suite arms) hand-spelled the OOM/spawn-init wording
// UNCONDITIONALLY, even though `state.pytestStarved` can be set true by either cause (a busy
// shared queue, or a genuinely out-of-memory box — see testQueueRunOutcome's own header). `scope`
// follows batteryFailedSeamMessage's own contract: omitted means the full suite, named means a
// diff-scoped selection. `cause` selects the wording ('spawn' keeps the pre-existing OOM text
// verbatim — the only cause this seam carried before this plan — 'queue' or anything else gets the
// queue wording). `freeMemText` is the caller's own `freeMemoryReading()` reading, threaded in for
// the same fs/child_process/git-free reason batteryStarvedSeamMessage's own header explains.
export function pytestStarvedSeamMessage({ scope, detail, cause, freeMemText } = {}) {
  const what = scope ?? 'python -m pytest backend/scripts';
  if (cause === 'queue') {
    return (
      `pytest preflight: ${what} is STARVED, not FAILED — this run was never admitted to the ` +
      `shared heavy-test queue (plan 4006): the box had no queue slot to give it, so the code ` +
      `under test never ran. Re-invoke when the shared queue is free — nothing to fix.\n` +
      `--- pytest tail ---\n${detail || ''}`
    );
  }
  return (
    `pytest preflight: ${what} is STARVED, not FAILED — every failing test's signature is a ` +
    `Windows spawn-init NTSTATUS (${freeMemText || 'free-memory reading unavailable'}, plan 3954 ` +
    `T2): the box was out of memory when a child process (node validator / git / a subprocess) ` +
    `tried to start, so the code under test never ran. Re-invoke when the box has headroom — ` +
    `nothing to fix.\n--- pytest tail ---\n${detail || ''}`
  );
}

// Validate the on-disk sidecar. Every failure route returns `null` / drops the entry, because this
// object's whole job is to AUTHORIZE SKIPS: doubt must always degrade to "run the gate", never to
// "assume it passed". Unknown gate names are dropped (a name no step checks is dead weight at
// best, and a future typo that silently authorizes nothing at worst); a malformed entry is dropped
// for gateProvenEntry's reason; a sidecar with no landId is discarded whole, since every skip is
// conditioned on the landId matching and an unattributable proof can never satisfy that.
// `gateNames` (plan 3960 cluster-1 review fix; REQUIRED since plan 3961 T2.7a — `land.gateRoster`
// is no longer a config key this module can default from) is the roster of names this sidecar
// parser recognizes. The land spine passes the registry-derived roster
// (`landGateRosterFromRegistry`, done-worktree.mjs); a non-array is a caller bug, not a "use the
// default" signal, so it throws rather than silently recognizing nothing.
export function parseLandGatesProven(text, gateNames) {
  if (!Array.isArray(gateNames)) {
    throw new Error(
      'parseLandGatesProven: gateNames must be an array of gate names (plan 3961 T2.7a — there ' +
        'is no default roster to fall back to; pass the registry-derived roster)',
    );
  }
  if (typeof text !== 'string' || text.trim() === '') return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.landId !== 'string' || obj.landId.trim() === '') return null;
  const gatesProven = {};
  const raw = obj.gatesProven && typeof obj.gatesProven === 'object' ? obj.gatesProven : {};
  for (const gate of gateNames) {
    const entry = raw[gate];
    if (!entry || typeof entry !== 'object') continue;
    if (!shaLike(entry.sha)) continue;
    const parsed = { sha: entry.sha, at: typeof entry.at === 'string' ? entry.at : '' };
    // Carried through verbatim when present; ABSENT is meaningful too — the reader treats a
    // missing envHash as "this proof was taken when no untracked input existed", so a gate whose
    // env file exists NOW compares unequal and re-runs (the safe direction).
    if (typeof entry.envHash === 'string') parsed.envHash = entry.envHash;
    // plan 4003 T2: a partial proof's file list, normalized on the way in for the same reason
    // every other field here is validated — this object authorizes what the next run may SKIP
    // RUNNING, so a junk path must degrade to a wider run, never a narrower one. An entry whose
    // list normalizes to nothing is read as a WHOLE proof only if it never claimed to be partial:
    // a present-but-empty `provenFiles` is dropped entirely rather than silently promoted, since
    // promoting it would turn "killed, nothing banked" into "green".
    //
    // gpt-review r1 (77b78c/3d8677/c815ee/839ac0/09b61b — five finders, one defect): the test is on
    // PRESENCE, not on shape. An earlier cut checked `Array.isArray(entry.provenFiles)` and let
    // anything else fall through — so `provenFiles: "scripts/a.test.mjs"`, `{}`, or `null` (a
    // truncated write, a hand edit, a future writer's bug) silently PROMOTED a partial entry to a
    // WHOLE one, which authorizes skipping the entire gate. That is the single worst direction this
    // parser can fail in, and it is the direction a shape check reads as "no partial data here".
    if ('provenFiles' in entry) {
      const files = normalizeProvenFiles(entry.provenFiles);
      if (!files || files.length === 0) continue; // claimed partial, unusable ⇒ no proof at all
      parsed.provenFiles = files;
    }
    gatesProven[gate] = parsed;
  }
  return { landId: obj.landId, slug: typeof obj.slug === 'string' ? obj.slug : '', gatesProven };
}

// ── plan 3436 D2: the did-not-start (no-start) tally ─────────────────────────────────────────
//
// A chunk-capped gate with less than `minChunkS` left refuses to start and reports
// `chunked: true, started: false`. Plan 3374's non-convergence counter deliberately IGNORES such a
// round — correctly, on its own terms: it scores rounds that RAN and proved zero new files, and a
// round that never started observed nothing about convergence. That was harmless while the budget
// was always fresh at the gate. Plan 3430's process-start anchor makes it reachable, so the
// no-start round now needs a bound of its own — and on the `--prep` path it needs one badly:
// `runPrepGates` runs the mobile gate through the UNCACHED `runMobilePreflight`, so the same wall is
// re-burned every invocation, `GATE_NON_CONVERGENT` can never fire, and the only thing standing
// between that and an unbounded loop was a sentence in the routine prompt — a real bound for an
// agent reading it, and NO bound at all for a script-driven `--prep` retry.
//
// WHERE IT LIVES, and why neither of the two homes the plan proposed:
//
//   * NOT the content ledger. The did-not-start case is precisely the case with no resolved ledger
//     key (the battery's own !shouldRun branch already falls back to a keyless report for exactly
//     that reason), so a ledger-keyed tally cannot record the rounds it exists to count.
//   * NOT the plan-3295 `gatesProven` sidecar. Right LIFETIME (worktree-local, survives
//     re-invocations, dies with the teardown) but wrong SEMANTICS: `landGateProven` returns null on
//     cloud by operator ruling and `recordLandGateProven` returns early under `IS_PREP` — so the one
//     path this bound must cover is the one that store opts out of. (Plan 3422 D6 also owns a live
//     concurrency bug in it, out of scope here; a separate file keeps that blast radius out.)
//
// So: its own worktree-local sidecar with the same lifetime properties and no shared state.
//
// KEYED BY HEAD SHA. A stored sha that differs from the current one resets every counter — the
// doctrine's "two consecutive did-not-start reports on the SAME commit", made literal. A new commit
// is a new series, and on `--prep` the rebase that moves HEAD resets it for the same reason.
//
// The threshold is `NON_CONVERGENT_ROUNDS`, REUSED rather than given a second constant: it is
// already 2, which is also exactly the routine prompt's own two-strikes rule, so one knob keeps the
// code and the doctrine from drifting apart — which is the whole failure this bound exists to close.
// It is PASSED IN rather than imported, because it lives in `battery-ledger.mjs`, which pulls
// `node:fs` and `node:child_process` at module top level and this module's own header contract is to
// stay fs-/child_process-free. `bumpNoStartRound` therefore REQUIRES it (no default): a default here
// would be a second copy of the number, i.e. exactly the drift the reuse exists to prevent.
//
// These four are PURE (the caller supplies the parsed sidecar and the sha) so the reset/bump/clear
// rules are unit-testable with no worktree, no `.scratch`, and no real gate.

// Parse the sidecar. Anything unreadable, malformed, or shaped wrong reads as "no tally yet", which
// is the safe direction: a lost counter costs one extra round, never a false stop.
export function parseNoStartTally(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (!shaLike(obj.sha)) return null;
  const rounds = {};
  const raw =
    obj.rounds && typeof obj.rounds === 'object' && !Array.isArray(obj.rounds) ? obj.rounds : {};
  for (const [gate, n] of Object.entries(raw)) {
    if (Number.isInteger(n) && n >= 0) rounds[gate] = n;
  }
  return { sha: obj.sha, rounds };
}

// The tally that applies to `sha`: the stored one when it is for this same sha, an empty one
// otherwise. The ONE place the reset rule is written, so bump/clear/read cannot disagree about it.
function noStartTallyFor(tally, sha) {
  return tally && tally.sha === sha ? tally : { sha, rounds: {} };
}

// Rounds already counted for `gate` on `sha`. Zero for a different sha, an absent tally, or a gate
// that has never refused to start.
export function noStartRoundsFor(tally, sha, gate) {
  return noStartTallyFor(tally, sha).rounds[gate] || 0;
}

// Count one did-not-start round. Returns the NEW tally to persist plus the resulting count and
// whether it has reached the bound — one call, so no caller can bump without reading the verdict.
export function bumpNoStartRound(tally, sha, gate, threshold) {
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(
      `bumpNoStartRound: threshold must be a positive integer (pass NON_CONVERGENT_ROUNDS from ` +
        `battery-ledger.mjs — see this section's header for why it is not imported here), got ` +
        `${JSON.stringify(threshold)}`,
    );
  }
  const base = noStartTallyFor(tally, sha);
  const rounds = { ...base.rounds, [gate]: (base.rounds[gate] || 0) + 1 };
  const count = rounds[gate];
  return { tally: { sha, rounds }, rounds: count, exhausted: count >= threshold };
}

// A gate that STARTED clears its counter, whatever the run's outcome — the bound is on rounds that
// observed nothing, never on rounds that ran. (A gate that ran and proved nothing is plan 3374's
// job, and it is measured against the ledger, not against this.)
export function clearNoStartRound(tally, sha, gate) {
  const base = noStartTallyFor(tally, sha);
  if (!base.rounds[gate]) return { sha, rounds: { ...base.rounds } };
  const rounds = { ...base.rounds };
  delete rounds[gate];
  return { sha, rounds };
}

// The report for a gate whose no-start tally has run out. Deliberately NOT
// nonConvergentReportDetail (done-worktree.mjs): that one speaks in files, keys and green counts —
// the vocabulary of a gate that RAN — and every one of those is empty here. This says the one true
// thing instead: the phases BEFORE this gate are eating the whole wall, so another round of the
// same invocation shape cannot help.
// gpt-review 39975d: the remedy must name the variable that is ACTUALLY in force. When
// `PREPUSH_GATE_CHUNK_S` is set it OVERRIDES the wall outright (chunkGateConfig rule 1, mirroring
// the hook's own `PREPUSH_WALL_S="$PREPUSH_GATE_CHUNK_S"` clobber), so telling that operator to
// raise `PREPUSH_WALL_S` is advice that provably does nothing — on the one surface whose entire job
// is saying what to do next.
//
// `wallVar` is PASSED IN, and the first fix's `env` parameter is GONE (gpt-review r2 8c1c33 /
// f2bafc / a2f60a / 83682b / 69d472 / bab6c8 / ad886b / 146b6f — eight finders, one defect). That
// fix re-derived the answer here behind its own `/^[0-9]+$/` test, which is LOOSER than the
// authoritative `parsePrepushPositiveInt` (that one also demands `Number.isSafeInteger` and `> 0`,
// precisely because plan 3274's F2/F3 rounds had already been bitten twice by a second, drifting
// copy of this parse). `PREPUSH_GATE_CHUNK_S=0`, or a digit run past 2^53, would therefore have been
// announced as an active override while `chunkGateConfig` rejected it and used `PREPUSH_WALL_S`
// after all. The remedy is not a TIGHTER copy of the parser — it is NO copy: the caller already
// holds the authoritative verdict, so passing the answer in makes a third parser unrepresentable
// rather than merely correct-for-now. (Importing the real one is not open to this module: it lives
// in done-worktree.mjs, which would be circular, and this module's header contract is to stay
// fs-/child_process-free.)
export function noStartExhaustedDetail({ gate, rounds, secondsLeft = 0, minChunkS = 0, wallVar }) {
  // REQUIRED, not defaulted (gpt-review r3 f7fd48). A default here is a silent wrong answer whenever
  // the caller forgets: the operator is told to raise a knob that is not in force, on the one
  // surface whose whole job is saying what to do next. Same reasoning as `bumpNoStartRound`'s
  // required `threshold` — an authoritative input this module cannot derive is one it must be given.
  if (typeof wallVar !== 'string' || !wallVar) {
    throw new Error(
      'noStartExhaustedDetail: wallVar is required (pass chunkGateConfig(env).wallVar — this ' +
        'module cannot read the environment; see its header)',
    );
  }
  return (
    `${gate} gate: NON-CONVERGENT (not a test failure, and not ordinary chunking): it has now ` +
    `made ${rounds} consecutive rounds of ZERO progress on this same commit — either declining to ` +
    `start (only ${Math.max(0, Math.round(secondsLeft))}s of the chunk budget left when it was ` +
    `reached, against a ${minChunkS}s floor) or being cut off by the cap before it could finish. ` +
    `The budget is being spent BEFORE this gate, or this gate simply cannot fit inside one wall, ` +
    `so re-invoking reproduces the same result: the earlier phases of this land (preflight, the ` +
    `production build, the WebKit mobile gate) are consuming it. The remedy is to make those ` +
    `phases cheaper or to raise the wall (${wallVar}) for this land — not another round.`
  );
}

// ── plan 3453 D4/D7: the head-lock wait's per-holder accumulated DURATION ──────────────────────
//
// Bug 1 (3436's clamp shortened the PREEMPT threshold itself, killing a healthy prep child the
// moment the shared chunk wall ran low) is closed by plan 3453's design, not by these four
// functions — see acquireWorktreeLockAtHead's own header in done-worktree.mjs for the two-clocks
// argument. What these four close is bugs 2 and 3 — the accumulation rule itself:
//
//   * Bug 2 (3436 r2, 6565bc/52a89b): a persisted WALL-CLOCK `since` compared against `Date.now()`
//     is reset by a backward NTP/VM step — the stamp reads as "in the future", the record reads as
//     invalid, and the SAME holder gets a fresh full window, repeatable on every correction. Closed
//     structurally: the persisted record below is a DURATION (`waitedMs`) plus an identity
//     (`holder`), with NO epoch field anywhere, and `Date.now()` is never read on this path — the
//     in-invocation clock is always the caller's `monotonicNowMs()` (this repo's plan-3430
//     monotonic standard), so a clock step cannot invalidate anything it never touches.
//   * Bug 3 (3436 r3/r4, 9b50f0/1f9c2c/9e648f): two distinct ways one attempt got this wrong.
//     (3a) a per-invocation elapsed clock let a FRESH holder inherit the PREVIOUS holder's elapsed
//     wait — closed by `carriedMs` requiring an EXACT token match. (3b) accumulating the full
//     elapsed against a running total on every poll double-counted every poll (10s/30s/60s… instead
//     of 10s/20s/30s…), reaching the 30-minute threshold in about 3 minutes — closed by `elapsedMs`
//     being ONE subtraction from a baseline fixed for the holder's whole tenure, never `+=`.
//
// All four are PURE: no `Date.now()`, no fs, no real 30-minute wait. `parseHeadLockWaitTally`
// mirrors `parseNoStartTally`'s contract exactly (see that section's header) — anything unreadable,
// malformed, or wrong-shaped reads as "no tally yet", which costs at most one extra window and can
// NEVER cause a false preempt.

// Parse the sidecar (`.scratch/land-head-lock-wait.json`). `holder` must be a non-empty string
// identity and `waitedMs` a non-negative integer DURATION — no epoch field is representable here,
// which is bug 2's structural closure: there is nothing left for a clock step to invalidate.
export function parseHeadLockWaitTally(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.holder !== 'string' || !obj.holder) return null;
  if (!Number.isInteger(obj.waitedMs) || obj.waitedMs < 0) return null;
  return { holder: obj.holder, waitedMs: obj.waitedMs };
}

// The record to persist after a poll. Deliberately just these two keys, forever — the D9 guard
// asserts the written shape's key set is EXACTLY `['holder', 'waitedMs']`, so a future edit cannot
// silently reintroduce the epoch field bug 2 removed.
export function nextHeadLockWaitTally({ holderToken, totalMs }) {
  return { holder: holderToken, waitedMs: Math.max(0, Math.round(totalMs)) };
}

// The holder-clock composition: carried-for-THIS-holder + elapsed-since-THIS-holder-was-first-seen.
// `firstSeenMonotonicMs` is the caller's baseline, fixed for the duration of one holder (reset only
// when the observed lock token changes) — this function never re-derives it, so it cannot drift
// into the double-count bug 3b's accumulator had.
export function headLockWaitBudget({
  tally,
  holderToken,
  firstSeenMonotonicMs,
  nowMonotonicMs,
  budgetMs,
}) {
  // Bug 3a closed: a tally left by a DIFFERENT holder is never carried — a fresh holder always
  // starts at 0, however close the previous holder was to the threshold.
  const carriedMs = tally && tally.holder === holderToken ? tally.waitedMs : 0;
  // Bug 3b closed: ONE subtraction from a fixed baseline, never an accumulating `+=` — the shape
  // that produced 10s/30s/60s… instead of 10s/20s/30s… is unrepresentable here.
  const elapsedMs = Math.max(0, nowMonotonicMs - firstSeenMonotonicMs);
  const totalMs = carriedMs + elapsedMs;
  return { carriedMs, elapsedMs, totalMs, exhausted: totalMs >= budgetMs };
}

// D5's per-poll decision, in order: acquired beats everything; an exhausted ATTEMPT clock beats an
// exhausted HOLDER clock (seaming with ~0s of tool budget left costs one extra invocation; racing a
// SIGTERM+SIGKILL against that same ~0s risks landing it mid-merge — the most dangerous phase —
// under a guaranteed kill); anything else is an ordinary wait.
export function headLockPollAction({ acquired, attemptExhausted, holderExhausted }) {
  if (acquired) return 'proceed';
  if (attemptExhausted) return 'seam';
  if (holderExhausted) return 'preempt';
  return 'wait';
}

// D7 (ruling on finding d148e9): may we preempt the holder we are looking at right now? Only when
// its token is the SAME one whose budget just expired — `waitingOnToken` is the caller's record of
// that holder. A missing/foreign `currentToken` (the lock was released, or is now unreadable) is
// never "the same holder": it resets rather than preempts, because there is no proof left that
// whoever (if anyone) holds the lock now is the wedged process the wait was actually measuring.
export function headLockPreemptAction({ waitingOnToken, currentToken }) {
  if (!currentToken) return 'reset';
  return waitingOnToken === currentToken ? 'preempt' : 'reset';
}

// plan 3453 F3 (gpt-review round 1: acdf1c/60a0c7/f959da/1bfb5f/8e0511/347f4e): a tokenless holder
// gets an IDENTITY the ordinary per-holder accumulator above can key on, instead of the separate
// in-memory special case (`unidentifiedSinceMonotonicMs`) it used to get. That one special case was
// wrong four ways at once, all from the same root: it tried to be a second accumulator instead of
// reusing this one. Its timer was never cleared when a real token appeared after a tokenless stretch
// (acdf1c/60a0c7); an EMPTY-STRING token counted as "identifiable" even though `headLockPreemptAction`
// above treats a falsy token as invalid and resets (f959da); and the timer lived only in the calling
// PROCESS, so it claimed a cross-invocation bound (HEAD_LOCK_WAIT_MS) it could never actually enforce
// — a chunked cloud re-invoke reset it to zero every time (1bfb5f/8e0511/347f4e). All four vanish once
// a tokenless-but-otherwise-legible holder record simply gets a STABLE identity: the ordinary
// `waitingOnToken` / sidecar / D4 reset-on-change machinery covers it for free, including PERSISTING
// the accumulated wait across invocations, which the in-memory timer never did.
//
// Returns:
//   * `entry.token`, when it is a non-empty string — the ordinary, ubiquitous case.
//   * a synthesized `notoken:<json-tuple>` key, when the record carries enough to name it STABLY (a
//     non-empty `host`, a positive-integer `pid`, and a non-empty `startedIso`) but has no real token
//     — a legacy or pre-2738 writer. Stable across repeated calls against the SAME holder record
//     (same three fields in, same key out); cannot collide with a real token, because `randomUUID()`
//     never produces the `notoken:` prefix.
//   * `null`, when the record is too sparse to identify even that much (a missing/invalid host, pid,
//     or startedIso) — this holder can never be accumulated against at all; the caller now routes
//     THAT narrower case through `UNIDENTIFIABLE_HOLDER_IDENTITY` (see its own header) rather than a
//     second, non-persistent clock.
//
// PREEMPTION still requires the REAL token, never this synthesized identity — see the caller: a
// holder with no real token is never signalled, because D7 needs a token to pin a kill to; when such
// a holder's own clock (this function's identity IS what lets it have one) expires, the caller halts
// instead of preempting.
//
// plan 3453 G8 (gpt-review round 2, finding cca203, WONTFIX): the ONLY writer of this repo's
// worktree-lock JSON (`acquireWorktreeLock` in worktree-lock.mjs) always sets `token: randomUUID()`,
// so the tokenless-but-legible branch below can never fire on a record THIS codebase writes — round
// 2's finder is right that it is unreachable from any writer in this tree today. It stays anyway:
// the lock file lives in the shared `.git` common dir, where an OLDER or FOREIGN writer (a stale
// worktree still running a pre-2738 build of this script, or a future writer that drops the token
// field) can leave a record this reader has to make sense of regardless of what wrote it. The branch
// costs nothing on the hot path (one extra typeof/Number.isInteger check, never reached once a real
// token is present), and removing it would trade a free safety net for a `null` identity — the
// LEAST identifiable outcome — in exactly the one case (a foreign writer) that is hardest to reason
// about at the point this code actually runs.
export function headLockHolderIdentity(entry) {
  if (!entry) return null;
  if (typeof entry.token === 'string' && entry.token) return entry.token;
  const { host, pid, startedIso } = entry;
  if (
    typeof host === 'string' &&
    host &&
    Number.isInteger(pid) &&
    pid > 0 &&
    typeof startedIso === 'string' &&
    startedIso
  ) {
    // plan 3453 G7 (gpt-review round 2, finding adee1a): colon-joining these three fields directly
    // was ambiguous — a hostname CAN contain a colon (IPv6-literal-style names do) and an ISO
    // timestamp always does, so two DIFFERENT (host, pid, startedIso) tuples could stringify to the
    // SAME key (host:'h', startedIso:'x:2:y' vs host:'h:1:x', startedIso:'y' both produced
    // `notoken:h:1:x:2:y`). A later holder with the colliding identity would inherit an earlier
    // holder's wait tally and could be halted or preempted prematurely. `JSON.stringify` of the
    // 3-tuple is an injective encoding — every string element is length-delimited by its own quoting
    // — so no two distinct tuples can ever produce the same output.
    return `notoken:${JSON.stringify([host, pid, startedIso])}`;
  }
  return null;
}

// plan 3453 H4 (gpt-review round 3, findings lib 2544 x3, WONTFIX): changing this synthesized
// `notoken:…` format (e.g. the G7 tuple encoding above) discards any tally already persisted under
// the OLD format's key — a tally whose key no longer matches is simply not carried, which costs one
// extra wait window and can never cause a false preempt (the safe direction this design states
// throughout). And this code has never landed: the format has only ever changed within this
// unlanded branch, so no sidecar written by an older format exists anywhere to be orphaned by it.

// plan 3453 G2 (gpt-review round 2, findings 1dc7da/ac2387/33e96a): a holder record too SPARSE for
// `headLockHolderIdentity` above to name at all (missing/invalid host, pid, or startedIso) used to
// get its own process-local clock (`unidentifiableSinceMonotonicMs` in acquireWorktreeLockAtHead)
// that reset on every chunked re-invocation — so a persistent sparse holder could retain the queue
// head indefinitely, because the intended 30-minute bound never actually accumulated across
// invocations. This sentinel routes that case through the SAME sidecar accumulator every other
// holder already uses (persisted in `.scratch/land-head-lock-wait.json`, survives across
// invocations) instead of a second, non-persistent timer — see the caller for how it is plugged in.
//
// Impossible to collide with a real token (a `randomUUID()` never equals this literal) or a
// synthesized `notoken:…` key (which always carries that distinct prefix).
//
// Two DIFFERENT unidentifiable holders sharing this one clock is ACCEPTABLE, not a bug: the
// terminal action for an unidentifiable holder is ALWAYS a halt that releases the queue slot, never
// a signal (see the `!waitingOnHasRealToken` branch in acquireWorktreeLockAtHead) — so the worst
// case of two holders sharing the clock is a land halting somewhat early and handing back for a
// re-invoke, whereas the cost of NOT persisting the clock at all is a bound that silently does not
// exist. Sharing would only be unacceptable if the terminal action were a kill, and it never is.
//
// plan 3453 H3 (gpt-review round 3, findings 2164 x3, lib 2567, WONTFIX): this sentinel conflates
// every DIFFERENT holder record too sparse to identify into the same clock — that is the deliberate
// cost of the G2 ruling above (the clock must survive re-invocation), and the alternative is
// impossible by construction: "too sparse to identify" means there is nothing left to key a
// per-holder clock on. The conflation cannot cause a WRONG KILL, because preemption is gated on
// `waitingOnHasRealToken` and a sentinel identity is never preemptable — the only consequence is
// that the unidentifiable-holder HALT (see `!waitingOnHasRealToken` in acquireWorktreeLockAtHead)
// can fire earlier than one holder alone would have earned, which is the safe direction: a halt that
// releases the queue slot and names the operator action, never a signal aimed at a live process.
export const UNIDENTIFIABLE_HOLDER_IDENTITY = 'unidentifiable-holder';

// The wire format the spine hands `scripts/hooks/pre-push.sh` for the post-rebase force-push (E3).
// A plain env channel, exactly like the plan-3223 `GATE_LEDGER_KEY` consult it sits beside — the
// hook is a POSIX shell script and cannot import this module.
//
//   LAND_ID=<the land's id>   — and NOTHING else.
//
// ONE fact rides the env; the PROOFS themselves ride the worktree sidecar
// (`.scratch/land-gates-proven.json`), which the hook reads directly (gpt-review findings a5db89 /
// eda9b2 / 11844d). The earlier shape also exported `LAND_GATES_PROVEN` + `LAND_GATES_PROVEN_SHAS`,
// so the same gate→sha map existed in two places on one push: the hook validated only `LAND_ID`
// against the sidecar and then trusted the env copy for WHICH gates and WHICH baseline shas — an
// env value that disagreed with the sidecar (a stale export re-used across an amended land, a
// hand-set variable) would have been honoured as proof. With the sidecar as the single source of
// truth that class is unrepresentable: the env carries only the id that ATTRIBUTES the sidecar, and
// a mismatch (or a missing sidecar) leaves every gate running in full.
//
// Nothing proven — or no landId to attribute it to — exports NOTHING: a `LAND_ID` on a land that
// has proven nothing would make the hook read a sidecar it can learn nothing from.
// `gateNames` (plan 3960 cluster-1 review fix; REQUIRED since plan 3961 T2.7a, same contract
// change as parseLandGatesProven above): the caller passes the registry-derived roster
// (`landGateRosterFromRegistry`, done-worktree.mjs). A non-array is a caller bug, not a "use the
// default" signal, so it throws rather than silently authorizing no skip for any gate.
export function landGatesProvenPushEnv(state, gateNames) {
  if (!Array.isArray(gateNames)) {
    throw new Error(
      'landGatesProvenPushEnv: gateNames must be an array of gate names (plan 3961 T2.7a — ' +
        'there is no default roster to fall back to; pass the registry-derived roster)',
    );
  }
  if (!state || typeof state !== 'object') return {};
  const landId = typeof state.landId === 'string' ? state.landId.trim() : '';
  if (!landId) return {};
  const proven =
    state.gatesProven && typeof state.gatesProven === 'object' ? state.gatesProven : {};
  const names = gateNames.filter((g) => proven[g] && shaLike(proven[g].sha));
  if (!names.length) return {};
  return { LAND_ID: landId };
}

// ── plan 3422 D6: the proof cache under CONCURRENCY ──────────────────────────────────────────
//
// THE DEFECT (2026-08-24 landing audit, class 2, ~3h of the audited two days). The once-per-land
// remainder is `git diff <proven sha>..HEAD`. With ~5 sessions landing in parallel, master moves
// during every queue wait, and the branch takes that advance on board at the head rebase or a
// freshen-merge. The remainder then contains every path those SIBLING lands touched — 3399 saw
// "2009 paths since a19bf31 are inside the key closure" — so the "once per land" suites ran twice
// or three times per land (3100: full pytest 47 min, then 43 min again after four siblings landed
// mid-dwell; 1917: a full 51-min re-proof after a freshen-merge whose own diff changed nothing).
//
// THE RULE. A path is only this branch's unproven risk if the BRANCH owns it. Intersect the
// since-proof delta with the branch's own contribution relative to the master baseline it now
// sits on (`git diff <merge-base(HEAD, origin/master)>..HEAD`):
//
//     remainder = (paths changed since the proof) ∩ (paths the branch itself changed)
//
// Case by case, which is why this is exactly right and not merely cheaper:
//   · master moved P, branch never touched P → at HEAD, P IS master's P, so P is absent from the
//     branch-own set → EXCLUDED. P's content landed green through its own land's full gates.
//   · branch owns P and master also moved it (a conflict resolution) → in both sets → KEPT. That
//     combination is genuinely new and nothing has gated it.
//   · branch changed P after the proof → in both sets → KEPT.
//   · branch changed P BEFORE the proof and nothing since → absent from the since-proof delta →
//     EXCLUDED, because the proof already covers it. (Unchanged from today's behaviour.)
//
// A clean freshen-merge — the plan-1917 "sha-only bookkeeping bump" — therefore costs NOTHING: it
// adds only master-sourced paths, the intersection is empty, and the proof stands. That is the
// plan's acceptance criterion.
//
// SCOPE, and why it is not applied everywhere. This narrows the DIFF-SCOPED remainder only — the
// two heavy suites and the price trust gate, whose remainder feeds a selector answering "what must
// I re-test". `build` / `mobile` deliberately keep the unfiltered delta: those two skip OUTRIGHT
// on a clean key closure with no cheaper cache behind them, so a sibling's frontend change must
// still drop them through to the plan-2462 content cache rather than be waved past. Speed there is
// worth less than the one gate a concurrently-landed frontend change can actually break.
//
// The residual risk this accepts — a sibling's already-gated change interacting with ours without
// a combined re-run — is the SAME risk the once-per-land ruling already accepted and backstopped
// (operator 2026-08-19, "the RISK isn't critical"; the daily full-suite cloud routine is the
// backstop). It is widened from "across this land's own re-entries" to "across a sibling's
// mid-dwell land"; it is not a new class.
//
// Pure and total: `null` on either side means "could not be computed", and every such doubt
// returns the WIDER set (or null), never a narrower one.
export function branchOwnedRemainder(proofDelta, branchOwnedPaths) {
  if (!Array.isArray(proofDelta)) return null; // no delta ⇒ caller runs the full gate
  if (!Array.isArray(branchOwnedPaths)) return proofDelta; // cannot attribute ⇒ keep everything
  const owned = new Set(branchOwnedPaths);
  return proofDelta.filter((p) => owned.has(p));
}

export function parseLandSpecMarker(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  for (const k of ['baseSha', 'specBase', 'preSpecBranchSha', 'branchSha']) {
    if (!shaLike(obj[k])) return null;
  }
  return obj;
}

// Is the speculative marker an exact fast-path at head? A speculative marker can NEVER satisfy
// `landPrepValid` — the post-land master tip is a merge commit whose sha depends on its committer
// timestamp, so it is unpredictable at prep time. The proof is parent-based instead, and just as
// strict: the live origin/master tip must be a MERGE whose two parents are EXACTLY the master tip
// we prepped against and the head branch tip we stacked onto (`git merge --no-ff <branch>` from a
// detached master gives parents [master, branch], in that order), and our own branch must not have
// moved since the stack. Together that says "master advanced by EXACTLY the head's land and
// nothing else" — a third land slipping in makes the tip a merge of a DIFFERENT first parent, so
// it invalidates, because the gates were validated against a tree that does not contain it.
// Correctness over speed: a missing / partial marker, a non-merge tip, or a moved branch is never
// valid (no silent skip).
// plan 2875 cluster 3 (review fix): same gate-coverage proof landPrepValid enforces, for the same
// reason — parentage/sha equality proves the TREE, not that `gateResults` ever recorded a verdict
// for a tier this branch's diff now requires. The speculative marker is stamped by the SAME
// runPrepGates loop as the plain one (attemptSpeculativeStack) and is exactly as exposed to a
// pre-2875 or otherwise-incomplete gateResults object. See gateResultsCoverRequired.
// plan 2940: the same branch-ref proof landPrepValid enforces, for the same reason — the
// speculative marker's `branchSha` comes off the SAME `worktreeHeadSha` read, stamped by the same
// prep pass, so it is exposed to the identical detached-HEAD miscertification. See
// markerReadFromBranch.
export function landSpecPrepValid(
  marker,
  masterParents,
  branchTip,
  changed,
  branchRef,
  predicates,
) {
  assertPrepGatePredicates(predicates, 'landSpecPrepValid');
  if (!marker || typeof marker !== 'object') return false;
  if (!shaEq(marker.branchSha, branchTip)) return false;
  if (!Array.isArray(masterParents) || masterParents.length !== 2) return false;
  if (!shaEq(masterParents[0], marker.baseSha) || !shaEq(masterParents[1], marker.specBase))
    return false;
  if (!markerReadFromBranch(marker, branchRef)) return false;
  return gateResultsCoverRequired(marker, changed, predicates);
}

// THE no-laundering invariant (plan-body decision D5). A branch left stacked on a speculative base
// that never landed carries ANOTHER plan's unlanded, unreviewed commits; merging it would launder
// them onto master — strictly worse than any queue latency this plan saves. So: whenever the
// branch still descends from a recorded specBase that origin/master does NOT contain, the stack
// must be undone before anything can merge. Note it is deliberately NOT keyed on the marker being
// a valid fast-path — a marker that fails `landSpecPrepValid` for any other reason (a third land,
// a moved branch) is exactly when a silent stale stack would otherwise ride through.
// Pure; the caller supplies the two ancestry facts.
export function specUnstackNeeded(marker, { branchDescendsFromSpecBase, masterContainsSpecBase }) {
  if (!marker || typeof marker !== 'object') return false;
  return Boolean(branchDescendsFromSpecBase) && !masterContainsSpecBase;
}

// ── plan 2473: the spine-side land-prep dispatch gate + the head-time wait bound ──
//
// Both are the SAFETY half of making a spine-side `--prep` dispatch possible at all: plan 2458
// built the dispatch, then reverted it because a prep child and the head-time merge could operate
// on one working tree at the same time. `worktree-lock.mjs` excludes them; these two pure
// predicates pin the two decisions AROUND that lock so they are testable rather than call-site
// folklore.

// May this invocation dispatch a detached `--prep` right now? Every condition is a hard NO:
//   * position ≥ 2 — the WAITERS-ONLY rule. A prep rebases and force-pushes the branch, so it must
//     never run while the head-time merge works that same worktree. Position 1 is the head and
//     position 0 means "not in the queue" (stolen/dropped) — neither is a waiting land.
//   * not already dispatched this invocation — a poll loop must not spawn a child per tick.
//   * no live holder — a sibling prep or a resuming land already owns the tree. (The child would
//     refuse anyway; skipping the spawn keeps the log honest and costs nothing.)
//   * the worktree's own done-worktree.mjs exists — we deliberately run the WORKTREE's copy, not
//     MAIN's, so a land whose diff changes prep/gate logic preps with its own code.
// Pure.
// plan 2463 adds ONE exception to "not already dispatched": reaching the SPECULATIVE position
// earns a second dispatch, even when a plain prep already fired this invocation from further back
// in the queue. Without it speculative stacking is near-dead on the attended `--wait` path — a land
// that enqueues at position 6 dispatches once, at position 6, where there is no head-of-queue tree
// worth stacking on, and never dispatches again as it advances to 2. Still bounded (at most two
// children per invocation), still never at the head, and still never into a held worktree: the
// `lockHeld` arm above already serializes the two, and `speculativeDispatched` is set only when a
// spawn actually happened, so a tick blocked by a live prep can retry on the next one.
export function shouldDispatchLandPrep({
  position,
  dispatched,
  lockHeld,
  hasCli,
  speculativeDispatched,
}) {
  if (!hasCli) return false;
  if (lockHeld) return false;
  if (!Number.isInteger(position) || position < 2) return false;
  if (dispatched) return position === SPECULATIVE_POS && !speculativeDispatched;
  return true;
}

// What the head-time land does on a poll where it could not take the worktree lock. The bound is
// acceptance criterion 2 in one function: a crashed or hung prep child NEVER wedges a land — the
// wait always terminates, and terminates into preemption, not into a halt.
//
// Waiting at all (rather than preempting immediately) is the deliberate part: if the prep
// finishes, the at-head re-check fast-paths the whole ~15-27 min battery, so waiting out a prep
// that is minutes from done costs LESS head time than killing it and paying the battery ourselves.
// The bound exists for the wedged holder, not the slow one. Pure.
export function worktreeLockHeadAction({ acquired, nowMs, deadlineMs }) {
  if (acquired) return 'proceed';
  return nowMs >= deadlineMs ? 'preempt' : 'wait';
}

// parseBatchManifest relocated to batch-paths.mjs (plan 3962 Decision 5).

// ── plan 2551: THE canonical watch recipe — one constant, every seam text ──────────
//
// Both seam texts below (detachedWaitRefusal, queueWaitReason) used to spell this command out
// themselves. They agreed by luck, not by construction, and the whole cold-head incident is what
// a drifting recipe costs: a session copy-pastes what the spine printed, so the printed string IS
// the behavior. Interpolating ONE constant makes drift between them impossible.
//
// FLAGLESS ON PURPOSE, and now safe on purpose. Since plan 2551 the watcher keeps the branch hot
// BY DEFAULT (rebase + gate re-validation on every master advance), so the bare command is the
// keep-hot one; `--pure-poll` is the opt-out and must NEVER appear in a canonical recipe. Before
// the flip this same flagless text handed out a COLD wait, which is how plan 2549's land reached
// head needing a full rebase + gate battery, blew the plan-1528 8-min head cap, and was requeued.
// Regression-pinned in done-worktree-lib.test.mjs (both seam texts) and doc-pinned against the
// real `.claude/commands/landing-queue.md` + `docs/runbooks/plans-workflow.md`.
//
// Do not "fix" this by appending `--heartbeat-every` either (the plan-2085 rule, unchanged): the
// watcher self-arms queue heartbeats near the head and once at head-exit, so a wait longer than
// the plan-1682 demote threshold no longer reaches head demote-stale. Whole-wait heartbeating is
// commit noise the default intentionally avoids.
export const WATCH_RECIPE = 'node scripts/landing-queue-watch.mjs <slug>';

// plan 2655: the same template, interpolated with the WAITER's own slug so the printed
// recipe is copy-paste runnable. WATCH_RECIPE itself stays the literal template constant
// (detachedWaitRefusal has no slug in scope and keeps quoting it verbatim) — this is the
// one place that renders it for a session that DOES know its own slug.
export function watchRecipeFor(slug) {
  return WATCH_RECIPE.replace('<slug>', slug);
}

// The per-slug pidfile a live watcher advertises itself with, relative to MAIN (plan 2551).
// Pure path construction so the two resolvers — the watcher (which resolves MAIN via coord-git)
// and the spine (which already holds `state.main`) — can never disagree about the filename.
// It sits beside the other land sidecars (`land-attempt-<slug>.json`, `land-prep-<slug>.log`)
// in the gitignored `.scratch/`. NB `store-tear-watch.mjs`'s header calls this watcher
// "pidfile-less"; that stopped being true here.
export function lqWatchPidfileRel(slug) {
  return `.scratch/lq-watch-${slug}.pid`;
}

// plan 2551 Layer 3(b): may a seam-out that leaves the slug enqueued spawn its own detached
// keep-hot watcher? Every condition is a hard NO:
//   * `inProcessWaiterSurvives` — something in THIS process keeps polling after the caller
//     returns, and every poll tick already fires its own one-shot `dispatchLandPrep`, so the
//     branch is covered without a detached child. plan 2819 renamed this from the raw
//     `wait`/`chunk` flag pair: those flags MEAN "a waiter survives" at the QUEUE_WAIT seam
//     (`--wait` is the attended in-process poll, `--wait-chunk` the cloud cadence whose every
//     re-invocation brings a fresh prep budget — and a detached process in a cloud sandbox is
//     untested and unwanted), but they do NOT mean it at the LAND_BLOCKED_REQUEUED seam, where
//     the process is exiting to the queue TAIL and an attended `--wait` land is left exactly as
//     cold as a bare one. The gate's real question was never "which flags", so it now asks the
//     semantic and each call site answers for itself.
//   * `dry` — a dry run must never spawn a real process.
//   * `watcherLive` — a KEEP-HOT watcher already holds this slug's pidfile. Keep-hot is the whole
//     reason to suppress: a `--pure-poll` watcher does no rebase and no gate re-validation, so it
//     never counts as coverage and (since plan 2839) never writes the pidfile at all — see
//     `watcherIsLive`'s mode gate in landing-queue-watch.mjs. Pure ECONOMY, not correctness:
//     duplicate preps already serialize/dedup via the per-slug worktree lock (plan 2473) and the
//     battery-lock. It must NEVER suppress the SESSION's own launch — see the wake asymmetry
//     below.
//   * `hasCli` — the watcher script must exist where we are about to spawn it from.
//
// WAKE ASYMMETRY — why this does NOT replace the session-side recipe. A spine-spawned detached
// watcher's exit re-invokes NOBODY; only a watcher the SESSION launched via `run_in_background`
// wakes that session. So this auto-spawn covers PREP for a session that launches nothing at all,
// while the seam text still instructs the session to launch its own. Two live watchers per slug
// is the NORMAL post-2551 state, and that is fine (see the dedup note above).
//
// Why a persistent watcher rather than leaning on the one-shot prep dispatch: the plain path
// polls ONCE and exits. In the 2549 incident the head merged ~35 min AFTER that poll, so even a
// prep that DID fire (against the poll-time tip) would not have covered it. Only something that
// outlives the invocation can react to master moving later.
// Pure.
export function shouldAutoSpawnWatcher({ inProcessWaiterSurvives, dry, watcherLive, hasCli }) {
  if (inProcessWaiterSurvives) return false;
  if (dry) return false;
  if (!hasCli) return false;
  return !watcherLive;
}

// The QUEUE_WAIT halt text: position + a rough ETA (~8 min per land ahead of
// us, the 2026-06-09 evening-wave cadence), and the canonical continuation
// path. The queue slot is RETAINED across the halt — re-invoking later keeps
// the position (enqueue is idempotent). plan 1280: the canonical wait is the
// zero-token detached watcher `scripts/landing-queue-watch.mjs` (shipped in
// plan 968; keep-hot in plan 972, made the DEFAULT in plan 2551), launched via
// Bash run_in_background and paired with a dead-man ScheduleWakeup — not a
// foreground poll loop. The command itself comes from WATCH_RECIPE above; the
// flagless-and-why rationale lives there, in ONE place.
export function queueWaitReason({ position, total, head, slug }) {
  const ahead = Math.max(0, (position ?? 1) - 1);
  return (
    WATCHER_DISAMBIGUATION_LEAD +
    `queued at position ${position}/${total} behind head ${head} — ETA ~${ahead * 8} min. ` +
    `The queue slot is RETAINED (enqueue is idempotent; re-invoking keeps the position). ` +
    canonicalWaitBlock(slug, `then run a bare done-worktree ${slug}`)
  );
}

// plan 2655: LEADS both wait seams — the plan-2632 incident session read the auto-spawned
// watcher's stepLog line (printed two lines above the seam) as "a wake is already armed" and
// skipped launching its own. Name that trap before anything else so a seam cannot be misread
// that way again.
const WATCHER_DISAMBIGUATION_LEAD =
  `DISAMBIGUATION: any "queue-watch: spawned a detached keep-hot watcher" line printed above ` +
  `is PREP-ONLY — it wakes NOBODY. The ONLY watcher that can re-invoke THIS session is the ` +
  `one YOU launch below via run_in_background. `;

// plan 2819: the wait instructions shared by the TWO seams that hand a session a fresh queue
// wait — QUEUE_WAIT and LAND_BLOCKED_REQUEUED. Extracted the moment the second seam existed,
// because the copy this replaced had already drifted on the load-bearing clause: it told EVERY
// session to launch a watcher and END THE TURN, including UNATTENDED (cloud) sessions, which get
// no wake-on-event after a turn ends (plan 1902) and must re-chunk in the SAME turn instead. A
// requeued cloud land following that advice waits forever. One renderer, so the next correction
// to either clause cannot reach only one seam.
//
// `reinvoke` is the only per-seam part: what to run once the watcher wakes you (a bare re-invoke
// at QUEUE_WAIT; bare-or---resume after a requeue, which re-enters at the queue-wait step).
function canonicalWaitBlock(slug, reinvoke) {
  const s = slug || '<slug>';
  return (
    `CANONICAL WAIT: launch \`${watchRecipeFor(s)}\` via Bash run_in_background:true ` +
    `and END THE TURN — it polls at zero token cost, keeps your branch rebased + gate-validated ` +
    `while you wait so you reach head HOT (plan 2551), self-arms queue heartbeats near the head so a long ` +
    `wait stays demote-fresh (plan 2085), and exits the moment ${s} reaches head, which ` +
    `re-invokes the session; ${reinvoke}. Pair with a ~1200s ScheduleWakeup ` +
    `dead-man fallback. Alternatives: re-invoke done-worktree manually when nearer the head, or --wait to ` +
    `poll in-process every ~260 s (foreground TTY only). ` +
    unattendedChunkClause(s, 'use `--wait-chunk` instead')
  );
}

// plan 2819: the one statement of "an unattended session cannot be woken, so it re-chunks in the
// same turn" (plan 1902 + plan 2170). THREE surfaces render it — both queue-wait seams and the
// detached-`--wait` refusal — and each had, or was about to get, its own copy. `verb` is the only
// part that differs: the seams offer --wait-chunk as the alternative to the watcher, while the
// refusal has already ruled --wait out too, so there it is "can use NEITHER".
function unattendedChunkClause(slug, verb) {
  return (
    `UNATTENDED sessions (cloud — no wake-on-event, plan 1902) ${verb}. ` +
    // WAIT_CHUNK_REINVOKE is the repo's ONE statement of the re-invoke mechanics (same turn,
    // foreground, 600000ms) — the chunk seams already render it, so this clause quotes it rather
    // than restating the timeout a second time and letting the two drift.
    `${WAIT_CHUNK_REINVOKE}: \`node scripts/done-worktree.mjs ${slug} --wait-chunk\` — each call ` +
    `blocks in-process up to ~${WAIT_CHUNK_MAX_SEC} s at zero model-token cost (plan 2170).`
  );
}

// ── plan 2170 Ship 3: bounded in-process queue wait for unattended runs ─────────
// One --wait-chunk call blocks in queueEnqueueAndGate's poll loop for at most this many
// seconds, then seams QUEUE_WAIT so the (cloud) session re-invokes in the SAME turn — the
// turn stays alive (the plan-1902 no-wake-on-event constraint) while the wait itself costs
// zero model tokens (vs the pre-2170 pattern: the MODEL re-polled every few minutes, each
// poll turn re-reading 75-150k cache tokens — the measured 2026-07-20 burn). Capped under
// the 600s Bash tool ceiling with margin for the enqueue/status coordWrites, so a chunk
// call given the instructed 600000ms timeout can never be killed mid-wait.
export const WAIT_CHUNK_MAX_SEC = 480;

// The re-invoke instruction shared by both chunk seam texts — one source so the
// exhausted and at-head variants can never drift on the mechanics.
const WAIT_CHUNK_REINVOKE =
  `Re-invoke in THIS SAME TURN (unattended sessions must keep the turn alive — plan 1902; ` +
  `give the Bash call a 600000ms timeout, foreground)`;

// Chunk elapsed without reaching head: slot retained, re-chunk in the same turn.
export function queueWaitChunkReason({ position, total, head }, chunkSec) {
  return (
    `queued at position ${position}/${total} behind head ${head} — the --wait-chunk in-process ` +
    `wait (${chunkSec}s) elapsed without reaching head. The queue slot is RETAINED (enqueue is ` +
    `idempotent). ${WAIT_CHUNK_REINVOKE}: \`node scripts/done-worktree.mjs <slug> --wait-chunk\` ` +
    `— each chunk blocks at zero model-token cost (plan 2170).`
  );
}

// A chunk call that reaches head NEVER proceeds into the land — landing inside a chunk
// would re-open the plan-662 class (a detached/timeout-killed call completing the merge
// yet reporting failure). It seams out instead; the bare re-invoke lands with a full,
// fresh tool-call budget.
export function queueWaitAtHeadReason() {
  return (
    `AT HEAD of the landing queue. A --wait-chunk call is WAIT-ONLY and never lands (a ` +
    `timeout-killed call must not die mid-merge — plan 662). ${WAIT_CHUNK_REINVOKE}: ` +
    `\`node scripts/done-worktree.mjs <slug>\` (bare — no --wait-chunk) to run the land now.`
  );
}

// Near-head conflicted probe in chunk mode: the chunk stays probe-only (the plan-1805 pin
// — an unattended waiter never auto-resolves) and seams out at once — a known conflict
// needs session action NOW, not the rest of the chunk slept away on a blocker.
export function queueWaitChunkConflictReason({ position, total, head }, files) {
  return (
    `queued at position ${position}/${total} behind head ${head} — the pre-convergence probe ` +
    `(plan 1805) found REBASE CONFLICTS vs fresh origin/master: ${files.join(', ')}. A ` +
    `--wait-chunk call never resolves conflicts (probe-only): resolve them in the worktree NOW, ` +
    `during the wait (docs/runbooks/plans-workflow.md § Queue-waiter pre-convergence; 🟥 seed ` +
    `shards use the branch-hygiene recipe, never a hand-merge), re-record the review marker, ` +
    `push, then re-invoke \`done-worktree <slug> --wait-chunk\` in the same turn. The queue ` +
    `slot is RETAINED.`
  );
}

// ── plan 1805: queue-waiter pre-convergence (resolve stale conflicts at position ≤2) ──
// While enqueued NEAR the head, done-worktree probes the branch against fresh
// origin/master with a non-mutating `git merge-tree --write-tree` dry-run. The probe is
// an advisory TRIGGER only (its conflict report can differ from a real rebase on renames
// / per-commit replay); the mutating pre-convergence is a real rebase, attempted only in
// the ATTENDED --wait loop (TTY-gated by plan 665 G4.3) and only when the probe reports
// conflicts. Probe-only paths (the non-wait QUEUE_WAIT seam) just carry the note below.
export const PRECONVERGE_POS = 2; // probe while 1 < position ≤ this
export const PRECONVERGE_MAX_ROUNDS = 2; // real-rebase rounds per queue residency

// Parse `git merge-tree --write-tree --name-only <a> <b>` conflict output: line 1 is the
// written tree OID, then one conflicted path per line until a blank line separates the
// informational-message section (git ≥2.38). Pure; unexpected shapes yield [].
export function parseMergeTreeConflicts(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const files = [];
  for (const ln of lines.slice(1)) {
    if (!ln.trim()) break;
    files.push(ln.trim());
  }
  return files;
}

// plan 2274 review fix: the ONE non-mutating merge-tree dry-run + exit-code classification,
// shared by done-worktree.mjs's preconvergeProbe (plan 1805, near-head attended waits) and
// landing-queue-watch.mjs's staleWhileQueuedProbe (plan 2274 Fix 1, the always-on detached
// watcher). The two had already silently diverged before this extraction — one took explicit
// `-C wtPath` + explicit branch-tip args and cached by (masterTip, branchTip); the other used
// implicit cwd + a literal `HEAD` with no caching — so a future exit-code-assumption fix, a
// git-version compatibility issue, or a `merge-tree` flag change would otherwise need applying
// twice, independently, in two separately-tested files. `execGit` is an injected `(args) =>
// stdout` closure (each caller's own git-invoking wrapper has a different shape/signature —
// this takes a pre-bound closure rather than assuming either one). Returns `{conflicted,
// files}` on a definitive result, or `null` when the probe itself is unavailable this tick (a
// git error OTHER than the documented conflict exit) — callers treat null as "skip this round",
// never as "clean" (fail-open).
export function mergeTreeConflictProbe(execGit, masterRef, branchRef) {
  try {
    execGit(['merge-tree', '--write-tree', '--name-only', masterRef, branchRef]);
    return { conflicted: false, files: [] };
  } catch (e) {
    if (e.status !== 1) return null;
    return { conflicted: true, files: parseMergeTreeConflicts(e.stdout) };
  }
}

// The session recipe both pre-convergence texts point at. One source so the seam and the
// advisory note can never drift apart on the steps (mirror of heldSlotPhrase's rationale).
const PRECONVERGE_RECIPE =
  `resolve during the wait: (1) resolve the conflicts in the worktree — rerere/manual; 🟥 seed ` +
  `shards use \`git checkout --ours\` + re-run the apply script with the .scratch finds ` +
  `(docs/runbooks/branch-hygiene.md), NEVER a hand-merge; (2) conclude (\`git rebase --continue\`, ` +
  `or \`git commit\` for a freshen-merge) and re-run the plan's targeted tests; (3) \`git push ` +
  `--force-with-lease origin <branch>\`; (4) re-record the review marker — \`node ` +
  `scripts/record-review.mjs repin\` auto-carries dispositions on a patch-identical re-sha (plan ` +
  `1775), a content change re-records with --carry-dispositions; (5) re-invoke done-worktree. ` +
  `Full section: docs/runbooks/plans-workflow.md § Queue-waiter pre-convergence.`;

// The QUEUE_WAIT reason for an ATTENDED (--wait) pre-convergence halt: the probe found
// conflicts and the in-waiter rebase could not auto-complete (rerere/clean replay), so a
// conflicted rebase/merge is left IN PROGRESS in the worktree for the session to conclude
// (mirrors the at-head LAND_BLOCKED_HOLDING contract; the detached --prep aborts instead
// because no session is present there). Slot semantics are exactly QUEUE_WAIT's: RETAINED.
export function preconvergeConflictReason({ position, total }, files, branch) {
  return (
    `pre-convergence (plan 1805): queued at position ${position}/${total} with a STALE-CONFLICTED ` +
    `branch — the near-head probe found conflicts vs the current origin/master and the in-waiter ` +
    `rebase could not auto-complete. A conflicted rebase/merge is IN PROGRESS in the worktree ` +
    `(branch ${branch}). The queue slot is RETAINED (enqueue is idempotent) — ` +
    PRECONVERGE_RECIPE +
    ` The kept slot means the head rebase then replays clean instead of burning head-hold time. ` +
    `Conflicted files:\n${files.map((f) => `  - ${f}`).join('\n')}`
  );
}

// The advisory note appended to the plain QUEUE_WAIT reason on the PROBE-ONLY paths (a
// non---wait invocation at position ≤2; unattended waiters NEVER auto-resolve — plan 1805 pin).
export function preconvergeConflictNote(files) {
  return (
    `\n\n⚠ pre-convergence probe (plan 1805): this branch CONFLICTS with the current ` +
    `origin/master — left as-is, the conflict work burns the head slot at land time. ` +
    `Pre-converge NOW, during the wait (the slot is kept): rebase onto origin/master, then ` +
    PRECONVERGE_RECIPE +
    `\nConflicted files:\n${files.map((f) => `  - ${f}`).join('\n')}`
  );
}

// The LAND_BLOCKED_HOLDING halt text. Wraps the rebaseSeam classification
// (REBASE_CONFLICT vs REBASE_UGLY rides along for the agent's judgment) and
// states the plan-504 contract: what is HELD — resolve, push the branch, then
// --resume LAND_BLOCKED_HOLDING to re-enter the merge directly. Lane-aware:
// a 🟩 free-lane land never acquired the landing-lock / 🟢 LANDING row, so its
// halt must claim only the queue head slot (or operators hunt for a board row
// that never existed and misread its absence as an already-released slot).
// plan 1239: the held-slot phrase + steal-eligibility hint, shared by holdingReason (rebase seam)
// and ephemeralMergeConflictReason (ephemeral-merge seam) so the two hold-through-conflict seams
// stay in lockstep — a change to the 45-min steal threshold or the held-slot wording lands in ONE
// place, not two near-identical copies that silently diverge (the plan-1239 review's DRY finding).
function heldSlotPhrase(lane) {
  return lane === 'seed' ? 'the LANDING claim + queue head slot are' : 'the queue head slot is';
}
const STEAL_HINT = 'Keep heartbeating: a head silent > 45 min is steal-eligible for waiters.';
// plan 1000: render the conflict-culprit attribution block for a hold-through-conflict seam.
function culpritBlock(culprits) {
  return culprits && culprits.length
    ? `\nCulprit (who landed the conflicted file on master since this branch's base):\n${formatConflictCulprits(culprits)}`
    : '';
}

export function holdingReason(rebaseSeamResult, lane) {
  const { code, reason, payload = {} } = rebaseSeamResult;
  const held = heldSlotPhrase(lane);
  // plan 3080: a graft is not a conflict — there is nothing to `git add`/`--continue`, and the
  // seam's own reason already carries the correct (and quite different) recovery. Appending the
  // conflict-resolution boilerplate here sent the session hunting for conflict markers that do
  // not exist (gpt-review 1ed9d9/fad1bc). Keep the hold + resume mechanics, drop the wrong fix.
  if (payload.graftBlocked) {
    // An UNVERIFIABLE check found no graft — it could not look. Telling the session to "un-graft
    // the branch" would send it hunting for foreign commits that may not exist, and worse, to
    // force-push on the strength of that hunt (gpt-review round 2:
    // d98b07/ce2583/2a8cb1/ec7fc0/d63d71). The recovery is to make the check evaluable and re-run.
    const fixGraft = payload.graftUnverifiable
      ? 'make the check evaluable again (usually a transient failure on the shared .git — just ' +
        're-invoke; do NOT force-push anything on the strength of an unevaluated check)'
      : 'un-graft the branch as described above, then push it';
    return (
      `${code}: ${reason} — ${held} HELD (plan 504, hold-through-conflict): ${fixGraft}, then ` +
      `re-invoke with --resume LAND_BLOCKED_HOLDING to re-enter the merge with the slot intact ` +
      `(the resume re-runs this same graft check before merging). ${STEAL_HINT}`
    );
  }
  // plan 507: a merge-bearing branch conflicted on its FINAL FRESHEN-MERGE — one
  // author-resolvable pass (prior freshen resolutions are kept; only genuinely-new
  // conflicts surface). The fix is concluding the merge, not untangling a rebase.
  const fix = payload.mergeBearing
    ? 'resolve the freshen-merge in the worktree (fix conflicts, `git add`, then `git commit` to conclude the merge)'
    : 'resolve the rebase in the worktree (rerere/manual, or rebuild my-files-only on fresh master)';
  // plan 1000 (Task 3): name the sibling plan(s) that landed each conflicted file so the
  // driver resolves against the real culprit instead of guessing (the 993/994/996 misattribution).
  const culprits = culpritBlock(payload.culprits);
  return (
    `${code}: ${reason} — ${held} HELD (plan 504, ` +
    `hold-through-conflict): ${fix}, push the branch, then re-invoke with ` +
    `--resume LAND_BLOCKED_HOLDING to re-enter the merge with the slot intact. ${STEAL_HINT}${culprits}`
  );
}

// plan 2274 Fix 4: the --resume LAND_BLOCKED_HOLDING / REBASE_CONFLICT path SKIPS the rebase
// entirely (the session already resolved the conflict and pushed) — this is the reason
// rendered when the spine's own LIVE `git ls-remote` check finds origin/<branch> did NOT
// actually move to the local rebuilt tip. Closes the plan-2233 post-mortem's structural leak:
// "a backgrounded force-push that FAILED its pre-push gate was reported completed (~10 min
// lost before the session verified via git ls-remote)" — the background-push exit code is
// untrustworthy in BOTH directions (standing memory), so the spine now verifies the remote
// tip itself instead of trusting the session's own push report before re-entering the merge.
// `verifyError` (plan 2274 review fix): the ls-remote verification itself can fail transiently
// (network blip, a timed-out lsRemoteTimed) rather than definitively prove a mismatch — that
// must NEVER be treated as "push confirmed" (silently proceeding on an unverifiable state would
// defeat the whole point), so the caller holds on either outcome. The message says which one
// happened: a genuine mismatch names both tips; an unverifiable check says so and points at a
// bare re-invoke (no branch/push action needed — just try the verification again).
export function pushNotVerifiedReason(branch, localSha, remoteSha, verifyError = null) {
  if (verifyError) {
    return (
      `LAND_BLOCKED_HOLDING (plan 2274): resuming past a conflict resolution, but the spine could ` +
      `NOT verify origin/${branch}'s actual tip before re-entering the merge (ls-remote failed: ` +
      `${verifyError}) — an unverifiable push is never treated as a confirmed one (that would ` +
      `defeat the point of this check). Likely transient (network/proxy blip) — re-invoke ` +
      `\`done-worktree <slug> --resume LAND_BLOCKED_HOLDING\` again to retry the verification. If ` +
      `it persists, confirm connectivity to origin and that the branch is actually pushed ` +
      `(\`git ls-remote origin ${branch}\` by hand). The queue head slot and seed mutex remain HELD.`
    );
  }
  const local = localSha ? localSha.slice(0, 9) : '(unknown)';
  const remote = remoteSha
    ? remoteSha.slice(0, 9)
    : 'ref not found on origin — the push never landed';
  return (
    `LAND_BLOCKED_HOLDING (plan 2274): resuming past a conflict resolution, but origin/${branch}'s ` +
    `ACTUAL tip (${remote}) does not match the resolved branch's LOCAL tip (${local}) — the push ` +
    `that was supposed to publish the resolution did not actually land. Push the resolved branch ` +
    `again (\`git push --force-with-lease origin ${branch}\`), CONFIRM it succeeds — foreground, ` +
    `or \`git ls-remote origin ${branch}\` if backgrounded — then re-invoke \`done-worktree <slug> ` +
    `--resume LAND_BLOCKED_HOLDING\` again. The queue head slot and seed mutex remain HELD.`
  );
}

// plan 1239: the ephemeral-merge conflict seam reason. The ephemeral `merge --no-ff`
// (land-lib.mjs) now throws a TYPED `ephemeral-merge-conflict` instead of crashing the spine;
// done-worktree seams LAND_BLOCKED_HOLDING with the slot HELD (mirroring the rebase seam, including
// its plan-1000 culprit attribution). NAME the recovery so the session resolves the CONTENT instead
// of chasing the queue/spine layer (the plan-1174 ~1h misdiagnosis that also cost ~4× slot losses).
// The recovery is LANE-SPECIFIC (plan-1239 review finding): a 🟥 seed conflict is a whole-file
// rewrite (re-run the apply script — the seed is ~1.01M pretty-printed lines, indent=2, NOT
// single-line, and re-stamps asOf across every touched row, so two seed lands never line-merge);
// a 🟩 non-seed (code/docs) conflict is an ordinary file conflict (resolve the file in the branch),
// so NEVER give the seed-only `checkout --ours` advice for a non-seed lane. `detail` is the
// (truncated) raw git conflict output; `culprits` is land-lib.attributeConflict's per-path plan
// attribution (who landed the clobbering change), rendered like the rebase seam's.
export function ephemeralMergeConflictReason(
  branch,
  lane,
  detail = '',
  culprits = [],
  conflictedPaths = [],
) {
  const held = heldSlotPhrase(lane);
  const d = detail ? ` (${detail})` : '';
  const content = conflictedPaths.length > 0;
  // The `lead` (what failed) and `body` (the cause + recovery) are the ONLY parts that vary; the
  // LAND_BLOCKED_HOLDING preamble, the held-slot phrase, the --resume footer and the steal hint are
  // built ONCE below so the two subtypes (and any third) cannot drift (the plan-1239 review caught
  // the first draft drifting "retry" vs "re-enter"). A CONTENT conflict (unmerged paths) gets the
  // lane-specific recovery + plan-1000 culprit attribution; a NO-unmerged-paths failure STILL holds
  // the slot (the plan-1239 goal — never crash on a merge failure) but must NOT claim a content/seed
  // conflict: it may be stray ephemeral-checkout state OR a genuine infra fault (disk full, a locked
  // .git object) that a bare retry will NOT clear, so it says so and tells the operator to inspect.
  const lead = content
    ? `the ephemeral merge of ${branch} onto origin/master CONFLICTED${d} — ${held} HELD`
    : `the ephemeral merge of ${branch} onto origin/master FAILED with no content conflict ` +
      `(no unmerged paths)${d} — ${held} HELD`;
  let body;
  if (!content) {
    body =
      `this is NOT a queue/spine bug and NOT a seed conflict. The cause is EITHER stray/untracked ` +
      `state in the throwaway ephemeral land worktree OR a genuine infrastructure fault (a full disk, ` +
      `a locked .git object, a git error) — INSPECT the detail above to tell which; a bare retry will ` +
      `NOT clear an infra fault, so fix that first. Recover: clear the ephemeral-checkout/infra ` +
      `problem the detail points at`;
  } else if (lane === 'seed') {
    // Plan 1867: the seed lane now also covers clinic-sharded DERIVED data, so the
    // recovery names BOTH surfaces — the conflicted-path/culprit block below says which
    // one actually conflicted (xhigh review F4: the seed-only recipe misdirected a
    // derived-only conflict into re-running the seed apply for nothing).
    body =
      `this is a CONTENT conflict, NOT a queue/spine bug. Match the recovery to the conflicted ` +
      `file(s) listed below: a SEED file (backend/src/data/seed*) is rewritten WHOLE-FILE + ` +
      `re-stamps asOf across every touched row, so overlapping seed lands never line-merge — ` +
      `git checkout --ours the seed file(s), then RE-RUN the apply script (never hand-merge the ` +
      `JSON); a DERIVED-data file (render-fingerprints / render-store _meta / observations) takes ` +
      `YOUR branch's copy (checkout --ours) — the next pipeline run / weekly sweep re-derives and ` +
      `self-heals a stale baseline (the plan-1839 clinic-378 pattern). Rebase the branch onto ` +
      `fresh origin/master, resolve per surface, push --force-with-lease, re-record-review`;
  } else {
    body =
      `this is a CONTENT conflict, NOT a queue/spine bug. Recover: rebase the branch onto fresh ` +
      `origin/master, resolve the conflicted file(s) in the worktree (the branch and a sibling land ` +
      `both changed them), push --force-with-lease, re-record-review`;
  }
  return (
    `LAND_BLOCKED_HOLDING: ${lead} (plan 504/1239, hold-through-conflict): ${body}, then re-invoke ` +
    `with --resume LAND_BLOCKED_HOLDING to re-enter the merge with the slot intact. ` +
    `${STEAL_HINT}${culpritBlock(culprits)}`
  );
}

// plan 2411: landBranchViaEphemeral's push loop already retries a non-ff race 6 times
// (re-fetch + re-reset + re-merge + re-push each time — the ephemeral-checkout equivalent of
// coordWrite's retry). EXHAUSTION (all 6 attempts lost the race) used to rethrow the raw git
// error past this catch, escaping to done-worktree main()'s crash path and RELEASING the queue
// slot even though the branch is NOT on origin/master and resuming is safe. Mirrors
// ephemeralMergeConflictReason's hold-through-conflict posture one layer over (a push race has
// no conflicted paths/culprits to attribute, so this is the plain case — no content/lane split).
// `detail` (review fix, sonnet-review high, CONFIRMED): the last attempt's raw git message
// (land-lib.mjs's `err.pushDetail`, truncated). The retryable-push classifier this typing rides on is
// the SAME broad one the retry loop already uses (non-fast-forward|fetch first|rejected|failed
// to push) — a permanent rejection (branch-protection, a stale ref) can match it too and would
// have crashed loudly with the raw detail pre-2411; surfacing that detail here — plus the
// explicit caution below — lets an operator recognize "this isn't actually a race" instead of
// blindly `--resume`-ing forever against an unfixable-by-retry failure.
// plan 3972: land-lib refused the merge because origin/<branch> no longer carries the tip this
// land reviewed and gated (typed `branch-tip-moved`, see assertExpectedBranchTip). Slot-RELEASING
// on purpose: the new tip needs the review/marker preflight again, and a `--resume
// LAND_BLOCKED_HOLDING` would re-enter at the merge and skip exactly that.
// plan 3972 (round 2): the worktree HEAD at merge time is not the tip preflight validated (and
// no spine-owned re-sha carried it there) — a commit landed in the worktree after preflight.
// REVIEW_NEEDED, from the top: the new tip has to pass the marker preflight like any other.
export function preflightTipDriftReason(branch, slug, preflightTip, head) {
  return (
    `REVIEW_NEEDED (plan 3972): the worktree HEAD of ${branch} moved after preflight validated ` +
    `${preflightTip} (now ${head}) — a commit was made in the worktree after the review/marker ` +
    `checks ran, so the tip about to be merged is not the one those checks covered. NOT merged. ` +
    `Recover: if the new commit is intended, re-record the review for it and re-run the land ` +
    `from the top: \`node scripts/done-worktree.mjs ${slug}\` (never --resume: the new tip must ` +
    `pass the marker preflight again); if it was not intended, reset the worktree to ` +
    `${preflightTip} and re-run.`
  );
}

export function branchTipMovedReason(branch, slug, expectedHead, actualHead) {
  return (
    `LAND_BLOCKED (plan 3972): origin/${branch} is at ${actualHead || '(absent)'} but this land ` +
    `reviewed, queued and gated ${expectedHead} — the branch was pushed by someone else AFTER the ` +
    `review (another session, a stray prep, a hand force-push). NOT merged; the queue slot is ` +
    `released. Recover: check what moved (\`git log --oneline ${expectedHead}..origin/${branch}\` ` +
    `from the worktree), reconcile the worktree's HEAD with origin/${branch}, re-review if the ` +
    `content changed, then re-run the land from the top: \`node scripts/done-worktree.mjs ${slug}\` ` +
    `(never --resume: the new tip must pass the marker preflight again).`
  );
}

export function ephemeralPushExhaustedReason(branch, lane, detail = '') {
  const held = heldSlotPhrase(lane);
  const d = detail ? ` (${detail})` : '';
  return (
    `LAND_BLOCKED_HOLDING (plan 2411): the ephemeral push of ${branch} onto origin/master lost ` +
    `the non-ff race on ALL 6 retry attempts${d} (a sibling push — coordWrite, wiki-commit, ` +
    `another land — kept winning between our fetch and our push) — ${held} HELD: this is NOT a ` +
    `content conflict and NOT a queue/spine bug — MOST OFTEN just an unusually persistent push ` +
    `storm. Recover: re-invoke with --resume LAND_BLOCKED_HOLDING to re-enter the merge (a fresh ` +
    `fetch+merge+push cycle against the CURRENT origin/master tip — most storms clear within one ` +
    `more round). CAUTION: if the SAME rejection detail above recurs again after a --resume, this ` +
    `is NOT a transient race (a bare retry cannot fix it — e.g. a branch-protection rule or a ` +
    `stale ref) — stop resuming and investigate the detail instead. ${STEAL_HINT}`
  );
}

// ── plan 1528 Phase B: requeue-to-tail when head recovery becomes heavy rework ──────
// The 2026-07-06 plan-1450 incident: ~24 min at head grinding through two rebase
// conflicts, marker re-pins and size-budget shaving while a waiter sat blocked the whole
// time. Every step was a sanctioned recovery — the problem was the AGGREGATE serialized
// under the head mutex. When the recovery crosses from "quick in-slot fix" to heavy
// rework AND someone is actually waiting, the head releases its slot to the tail and
// finishes the rework during the wait (keep-hot --prep makes that wait productive).

export const REQUEUE_MAX = 2; // starvation cap: past this the head holds regardless (livelock guard)
export const REQUEUE_HOLD_MIN = 8; // cumulative head-hold minutes that count as heavy rework

// ── plan 2453: land-attempt events are KEYED by kind, not a boolean flag per type ────
// The per-attempt event tallies used to be N sibling scalars on the sidecar
// (`conflictCount`, then plan 2432's `pushStormCount`) threaded through as mutually-
// exclusive booleans with hand-computed exclusion at the call site, a duplicated
// if/else-if increment block, and per-field zeroing at THREE separate reset sites. A
// third event type needed a third boolean, a third exclusion, a third increment branch
// and a third field zeroed at every reset site — and a MISSED reset does not fail loudly:
// it leaks a stale tally from a PRIOR queue residency into the next attempt's trip
// evaluation, spuriously demoting a clean land. That is exactly the failure class plan
// 2432 removed for the first pair; the boolean shape reintroduced it for every future one.
//
// THIS registry is the single place a new event kind is declared. One entry supplies all
// four things the old shape spread across the file:
//   reasons          the discriminated seam reason(s) that PRODUCE this kind — the caller
//                    already holds `e.reason`, so routing is a lookup, never a boolean
//   feedsConflictArm does it count toward requeueTrip's content-conflict arm (a)?
//   legacyField      the pre-2453 sidecar scalar this kind migrates FROM (omit for a kind
//                    that never had one — a new kind has no legacy on-disk history)
//   noteLabel/Why    how a non-arm kind names itself in the not-taken `why` string
// Reset is structural, not enumerated: freshTallies() derives its zeroed object from these
// keys, so a new kind is zeroed at every reset site with no per-site edit.
export const LAND_EVENT_KINDS = {
  conflict: {
    // rebase-seam and ephemeral-merge CONTENT conflicts share ONE tally: both mean the
    // branch's content collides with master, and plan 1528's arm (a) has always counted
    // them together ("a SECOND conflict in this land attempt").
    reasons: ['rebase-conflict', 'ephemeral-merge-conflict'],
    feedsConflictArm: true,
    legacyField: 'conflictCount',
  },
  pushStorm: {
    // plan 2432: tracked but DELIBERATELY feeds no arm. A push-retry exhaustion means a
    // sibling kept winning the ff-only push race — the branch conflicts with nothing, and
    // the plan-2411 seam says so in as many words ("this is NOT a content conflict … most
    // storms clear within one more round"). Counting it toward arm (a) demoted a land to
    // the tail for a transient race, and made ONE real conflict + ONE storm
    // indistinguishable from two real conflicts. A PERSISTENT storm is still bounded — by
    // arm (c): the head time it burns with waiters behind, which is the honest cost to the
    // queue. It is reported in the not-taken `why` so a storm is visible in the halt log.
    reasons: ['ephemeral-push-nonff-exhausted'],
    feedsConflictArm: false,
    legacyField: 'pushStormCount',
    noteLabel: 'push-storm exhaustion(s)',
    noteWhy: 'deliberately not counted as content conflicts (plan 2432)',
  },
};

// Derived LIVE from the registry on every call, never snapshotted at import time — that is
// what makes "one place declares a kind" literally true (and what lets a test register a
// third kind and observe it reach every reset site with no per-site edit).
export function landEventKeys() {
  return Object.keys(LAND_EVENT_KINDS);
}

// A fresh, fully-zeroed tally object — THE reset primitive. Every reset site calls this
// instead of enumerating fields, so "a new event type cannot be forgotten at any of them"
// is true by construction rather than by discipline.
export function freshTallies() {
  return Object.fromEntries(landEventKeys().map((k) => [k, 0]));
}

// Map a discriminated seam reason to its event kind; null for an unregistered reason (the
// caller decides — done-worktree logs and declines to count rather than inventing a tally
// no arm reads and no reset zeroes).
export function eventKindForReason(reason) {
  if (!reason) return null;
  for (const [kind, def] of Object.entries(LAND_EVENT_KINDS)) {
    if (def.reasons.includes(reason)) return kind;
  }
  return null;
}

// plan 2453 step 4 — SIDECAR BACK-COMPAT DECISION: a land attempt can be mid-flight across
// the deploy of this change (the sidecar survives the very rebase it describes), so the
// read TOLERATES the pre-2453 scalar format and carries the counts over; a silent reset
// would hand a two-conflict attempt a clean slate and lose exactly the demote plan 1528
// exists to make. The keyed `tallies` object WINS when present (it is the newer format);
// a legacy scalar is consulted only for a kind that declares `legacyField` and has no
// keyed value. The WRITE side is new-format only — done-worktree's readLandAttempt
// normalizes at the boundary and DROPS the legacy scalars, so the two encodings can never
// coexist on disk and silently diverge (a reset zeroing `tallies` but not `conflictCount`
// would reintroduce the very stale-leak hazard this plan removes).
export function normalizeTallies(src = {}) {
  const keyed = (src && src.tallies) || {};
  const out = {};
  for (const [kind, def] of Object.entries(LAND_EVENT_KINDS)) {
    const fromKeyed = Number(keyed[kind]);
    const fromLegacy = def.legacyField ? Number(src[def.legacyField]) : NaN;
    out[kind] = Number.isFinite(fromKeyed)
      ? fromKeyed
      : Number.isFinite(fromLegacy)
        ? fromLegacy
        : 0;
  }
  return out;
}

// Total across every kind that feeds the content-conflict arm — the one number arm (a)
// and done-worktree's plan-1867 "resolution artifact" rework hold both key on.
export function conflictTallyTotal(tallies = {}) {
  return landEventKeys()
    .filter((k) => LAND_EVENT_KINDS[k].feedsConflictArm)
    .reduce((n, k) => n + (Number(tallies[k]) || 0), 0);
}

// Pure trip decision — the CONFLICT arms pinned at plan-1528 spec-pass, each gated on ≥1
// waiter behind the head (an empty queue makes holding free) and the ≤2-requeues
// starvation cap. The former arm (b) — source-edit REWORK proven by a marker re-pin
// refused on non-identical patch-ids — was REMOVED by plan 2170: every rework halt now
// routes through done-worktree's dequeueForRework (position-preserving slot release, its
// own L.REQUEUE_MAX-capped counter), so this trip serves conflict-driven requeues only.
//   tallies        the keyed per-attempt event tallies (plan 2453). The pre-2453 scalar
//                  params (`conflictCount` / `pushStormCount`) are still accepted at the
//                  top level and normalized through the SAME migration helper the sidecar
//                  read uses — no second decoding of the old shape.
//   headHoldMin    cumulative minutes since this attempt acquired the head slot (arm c: >8)
//   waitersBehind  queue entries behind the head RIGHT NOW
//   requeueCount   requeues already taken in this land attempt
// Which kinds feed arm (a) is declared ONCE, in LAND_EVENT_KINDS above — this function
// asks the registry rather than naming any kind itself.
// Returns { requeue: true, arms: [...] } or { requeue: false, why }.
export function requeueTrip({
  headHoldMin = 0,
  waitersBehind = 0,
  requeueCount = 0,
  maxRequeues = REQUEUE_MAX,
  holdMinCap = REQUEUE_HOLD_MIN,
  ...eventSource
}) {
  const tallies = normalizeTallies(eventSource);
  if (waitersBehind < 1)
    return { requeue: false, why: 'no waiters behind the head — holding is free' };
  if (requeueCount >= maxRequeues)
    return {
      requeue: false,
      why: `requeue cap reached (${requeueCount}/${maxRequeues}) — holding regardless (starvation guard)`,
    };
  const arms = [];
  const conflicts = conflictTallyTotal(tallies);
  if (conflicts >= 2) arms.push(`second conflict in this land attempt (#${conflicts})`);
  if (headHoldMin > holdMinCap)
    arms.push(`head held ${Math.round(headHoldMin)} min (> ${holdMinCap} min cap)`);
  if (arms.length) return { requeue: true, arms };
  // plan 2432/2453: name every non-arm event the conflict arm deliberately did NOT count,
  // so such a hold is legible in the halt log instead of looking like a no-op evaluation.
  // Generic over the registry — a third non-arm kind gets its note with no edit here.
  const notes = landEventKeys()
    .filter((k) => !LAND_EVENT_KINDS[k].feedsConflictArm && tallies[k])
    .map((k) => {
      const def = LAND_EVENT_KINDS[k];
      return ` — ${tallies[k]} ${def.noteLabel || `${k} event(s)`} noted, ${
        def.noteWhy || 'deliberately not counted as content conflicts'
      }`;
    });
  return {
    requeue: false,
    why: `below threshold (first conflict / quick in-slot fix stays HOLDING)${notes.join('')}`,
  };
}

// The LAND_BLOCKED_REQUEUED halt text. States what tripped, what was RELEASED (the
// opposite of holdingReason's held-slot phrase — mutex freed, board row back to ACTIVE,
// queue entry at the tail), and the way back: finish the rework during the wait, then
// re-invoke (bare or --resume LAND_BLOCKED_REQUEUED — both re-enter at the queue-wait
// step). `queue` is the post-requeue { position, total } when known.
// plan 2170: the `needsReview` fourth param is gone with requeueTrip's rework arm — every
// caller is now a conflict trip (rework halts route through dequeueForRework instead).
//
// plan 2819: this text used to assert "keep-hot --prep keeps the branch rebased + gates
// validated" as a statement of fact about the wait ahead. On this path that was FALSE, and it
// was the sentence that made the cold-arrival loop self-sustaining: the session's OWN watcher
// had already exited at head (watchVerdict treats position 1 as terminal), no spine watcher was
// ever armed here, so a session told "keep-hot has you covered" launched nothing, sat at the
// tail while master moved, and arrived cold — blowing the 8-min head cap into a second requeue.
// The spine now arms a PREP watcher at this seam, so half that sentence became true; the other
// half (the WAKE) can only ever be the session's own watcher, so this seam renders the SHARED
// canonicalWaitBlock — the same one queueWaitReason renders, cloud clause and all. Sharing it is
// not tidiness: the hand-copy that preceded it silently dropped the UNATTENDED branch, which
// would have told a requeued cloud land to end its turn on a wake it can never receive.
export function requeuedReason(arms, lane, queue = null, slug = null) {
  const released =
    lane === 'seed'
      ? 'the landing-lock was RELEASED, the board LANDING row flipped back to ACTIVE, and the queue entry moved to the TAIL'
      : 'the queue entry moved to the TAIL';
  // position 0 is positionOf's "absent" sentinel — deliberately omitted, not a falsy slip.
  const pos = queue && queue.position > 0 ? ` (now position ${queue.position}/${queue.total})` : '';
  return (
    WATCHER_DISAMBIGUATION_LEAD +
    // The requeue-specific half of the trap: at QUEUE_WAIT a session may still have a watcher
    // running; here it provably does not, because a watcher exits at head and head is where the
    // requeue happened. Say so, or "launch your own" reads as optional belt-and-braces.
    `Your previous watcher already EXITED when this land reached head, so nothing is armed. ` +
    `head recovery crossed into heavy rework — ${arms.join('; ')} — with waiter(s) queued behind, ` +
    `so the head slot was requeued (plan 1528): ${released}${pos}. Finish the rework in the ` +
    `worktree and push the branch, then: ` +
    canonicalWaitBlock(
      slug,
      `then re-invoke done-worktree (bare or --resume LAND_BLOCKED_REQUEUED — both re-enter at ` +
        `the queue-wait step, never the merge step)`,
    ) +
    ` Do NOT substitute a hand \`git rebase\` + backgrounded \`git push\` for the watcher: a ` +
    `backgrounded gate-running push dies at turn-end with an EMPTY log and exit 1, which is how ` +
    `plan 2758 arrived at head 82 commits behind with no evidence in its transcript (plan 2819). ` +
    `Max ${REQUEUE_MAX} requeues per land attempt; past the cap the spine holds through instead.`
  );
}

// plan 2517 (supersedes plan 2170 Ship 2's preserved-position wording): appended to a
// marker-family halt reason when dequeueForRework released the queue slot — states what
// happened to the slot, so the session never "helpfully" re-enqueues by hand. No position
// is preserved any more (operator ruling, plan 2517: "a plan carries no priority... it
// shouldn't hog the head if it's not ready" — re-entry is a plain tail enqueue, the same as
// any other rejoin).
export function reworkDequeuedNote() {
  return (
    ` The queue slot was RELEASED for this rework (plan 2517) — rework happens OUT of the lane, ` +
    `never on the head slot. Do NOT re-enqueue by hand: when you re-invoke done-worktree after ` +
    `re-recording, the land re-enters the queue at the TAIL (a plan carries no priority — ` +
    `operator ruling, plan 2517), not its original position.`
  );
}

const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb)$/;
// plan 3765: hook logic moved from .claude/hooks/ into scripts/hooks/, so a hook is app
// source on the review axis too. SOURCE_RE is extension-keyed and carries no `.sh`, which
// left the five relocated SHELL guards — worktree-guard.sh above all, the one that gates
// every hand push to master — landable with no recorded verdict at all.
//
// Scoped to `scripts/**`, not to `scripts/hooks/`: the mandatory-review surface in
// vetapp/CLAUDE.md is the whole of scripts/**, so a future `scripts/maintenance.sh` needs
// a verdict for exactly the same reason a hook does, and a hooks-only rule would be a
// second, narrower answer to a question the repo has already answered once. A committed
// `.sh` OUTSIDE scripts/ (docs/runbooks/, .husky/) keeps its own class and is untouched.
const SCRIPTS_SHELL_RE = /^scripts\/.*\.sh$/;
const REVIEW_EXCLUDE_RE =
  /(\.test\.|\.spec\.|\/tests?\/|\/__tests__\/|\/fixtures\/|\/node_modules\/|\/seed-[^/]*\.json)/;

// plan 3961 T2.5: exported (was module-private) so scripts/project/land-seams.mjs can build the
// SAME `{code,reason,payload}` shape for the two seams that moved there (statusFlipSeam,
// wikiCheckpointSeam) — every other seam function in this file keeps using this one copy.
export function seam(code, reason, payload = {}) {
  return { code, reason, payload };
}

// plan 3959 T2: checkRecordBranch + sameCommitSha moved to scripts/coord/review-markers.mjs.

// plan 3959 T2: the marker-family table (REVIEW_METHODS, REVIEW_FANOUT_METHODS,
// REVIEW_PROVENANCE_UNDECLARED, MARKER_FAMILIES) moved to scripts/coord/review-markers.mjs.

// ── plan 2743: the rebase-STABLE half of a marker's identity ──────────────────────
// A marker pinned to the branch tip sha alone is invalidated by every rebase, and plan
// 1528's mechanical re-pin heals that by pushing a commit to master — which advances
// master, which invalidates the rebase base of every land currently prepping, including
// the one that just emitted it. Measured 2026-08-03: 326 re-pin commits on origin/master
// in ONE day, whose entire semantic content is "the same reviewed patch now has a
// different sha". The re-pin's own subject already says `(patch-id-identical rebase)`.
//
// So the marker carries a SECOND, rebase-stable identity alongside the sha: the range
// patch-id (land-lib.rangePatchId — the branch's whole content-diff vs its merge-base with
// origin/master), written as a trailing ` patch-id:<value>` token:
//
//   Review: PASS:sonnet-review f=6 v=4 adj=1 @ <sha> patch-id:<hex|empty>
//
// The token is OPTIONAL in the grammar — the same backward-compat trick plan 2162 used for
// the detail group. A legacy sha-only marker still parses (patchId null) and still takes
// the plan-1528 repin path unchanged; forward-only migration, no backfill.
//
// plan 3959 T2: the PATCH_ID_VALUE/PATCH_ID_GROUP/PATCH_ID_VALUE_RX consts moved to
// scripts/coord/review-markers.mjs alongside normalizeMarkerPatchId/markerRegExp below.

// ── plan 3295: the seed-only carry (REVIEW family only) ────────────────────────────────
// Operator ruling 2026-08-19 ("Review stamp CARRIES across seed-data-only commits" — verbatim
// "yes" to "carry it"): a review marker recorded at sha X is honored at tip Y when EVERY path
// in `git diff --name-only X..Y` is seed data (backend/src/data/seed/**, incl.
// per-country order.json / chains.json — no code). Any other path in the delta keeps today's strict
// sha/patch-id rule. `isSeedOnlyDelta` is the ONE pure predicate over an already-computed path
// list (this module is fs-/git-free by contract — see the header) — the caller (done-worktree.mjs
// / record-review.mjs) spawns the actual `git diff --name-only`, lazily, only when both the sha
// fast path and the plan-2743 patch-id fallback have already failed.
//
// The seed root is CONFIG, not a literal this predicate owns: `coord.config.json`'s `seedShardDir`
// — the SAME value `seedScopeOf` / `shardFileRx` key on — is threaded in by every production
// caller (gpt-review finding 9bd383: a second hard-coded vocabulary here would silently stop
// recognizing seed commits the day that config moves). plan 3961 T2.7b: `isSeedOnlyDelta` itself
// no longer defaults to a fallback literal — every production caller already threads its own
// configured (or explicitly null) `seedShardDir`, and a repo with none (`null`) is simply "no
// path can be seed-only" (the strict sha/patch-id rule stands), never a silently-guessed root.
// plan 3961 T2.7b follow-up: the FALLBACK_SEED_SHARD_DIR constant this comment used to describe
// is retired — record-review.mjs's one remaining use (a display-string default for its own
// wikiDecisionNudge helper, unrelated to this predicate) now reads `cfg.seedShardDir` directly
// off config, with the chains-path/seed-only logic skipped outright when a repo configures none.

// seedShardDir has NO DEFAULT: every caller passes it explicitly. `null`/`undefined` means "this
// repo has no configured seed shard dir" and the predicate returns `false` (doubt keeps the
// strict sha/patch-id pin — nothing can be seed-only); any other non-string throws, since a
// caller passing e.g. an object or number is a bug at the call site, not a repo with no seed root.
export function isSeedOnlyDelta(paths, seedShardDir) {
  if (seedShardDir === null || seedShardDir === undefined) return false;
  if (typeof seedShardDir !== 'string') {
    throw new Error('isSeedOnlyDelta: seedShardDir must be a string, null, or undefined');
  }
  const prefix = `${seedShardDir.replace(/\/+$/, '')}/`;
  return Array.isArray(paths) && paths.length > 0 && paths.every((p) => p.startsWith(prefix));
}

// plan 3959 T2: normalizeMarkerPatchId through buildReviewProvenance (markerRegExp,
// parseMarkerAny, markerStatusRow, markerIdentityMatch, parseMarkerCurrent, upsertMarker, the
// review-family delegates, repinDecision, upsertReviewMarker, buildReviewProvenance) moved to
// scripts/coord/review-markers.mjs. MARKER_FAMILIES/parseMarkerCurrent/parseMarkerAny/
// upsertMarker/markerIdentityMatch are imported back below for the wiki/conclusion delegates and
// findingsGate, which stay here (land-spine, SEAM-coded).
import {
  classifyAndBlocks,
  findingWithCanonicalKey,
  markerIdentityMatch,
  MARKER_FAMILIES,
  parseMarkerCurrent,
  parseMarkerAny,
  upsertMarker,
} from './review-markers.mjs';

// ── plan 3972: the coordination-only master delta ──────────────────────────────────────
// Operator ruling 2026-09-12 (paraphrased in the plan body): a branch that merges cleanly must not
// be held up by re-syncing to commits that change no code. The plan-3941 land spent ~50 minutes
// rebasing + re-pinning + gated-force-pushing against master advances that were ENTIRELY the
// queue's own bookkeeping and other sessions' review records — 22 such commits still cost the
// final, clean invocation nine minutes.
//
// `masterDeltaIsCoordinationOnly` is the ONE pure predicate over an already-computed path list
// (`git diff --name-only <merge-base>..origin/master`, spawned by done-worktree.mjs's trySkipSync —
// this module is fs-/git-free by contract, see the header). True iff EVERY path is under one of
// the coordination roots in `prefixes`. Empty delta ⇒ true (nothing moved). PATHS ARE THE
// CRITERION, never commit subjects: a `docs(plans):` subject can carry a code file, so the IO
// shell logs the subjects for telemetry only and decides on this list alone. Backslashes are
// normalised so a Windows-flavoured path list cannot fail the match by spelling.
//
// plan 3961 T2.7b: the prefix list is CONFIG, not a literal this predicate owns — it moved to
// `coord.config.json`'s `land.coordinationOnlyPathPrefixes` (normalizeLand validates shape: an
// array of non-empty, non-duplicate strings) and is threaded in by the one production caller
// (done-worktree.mjs's trySkipSync). `prefixes` is REQUIRED here — a caller with no list in hand
// is a bug, not a repo with no coordination paths (unlike isSeedOnlyDelta's seedShardDir, there
// is no meaningful "no config" fallback: an empty coordination-path list makes the predicate
// return false for any non-empty delta, which is a valid config choice, not the null case). A
// trailing `/` on an entry marks a directory prefix, a bare path matches exactly.
// `docs/PIPELINE.md` (the real plan-3941 conflict) and every other `docs/` page are NOT
// coordination by the vetapp list — a doc that carries a spec is content, and `wiki/<page>.md` is
// content too; only the append-only `wiki/log.md` line ledger rides along THERE. Widen a project's
// list in its own coord.config.json, never here.
export function masterDeltaIsCoordinationOnly(paths, prefixes) {
  if (!Array.isArray(prefixes)) {
    throw new Error('masterDeltaIsCoordinationOnly: prefixes must be an array of path prefixes');
  }
  if (!Array.isArray(paths)) return false;
  return paths.every((raw) => {
    const p = String(raw ?? '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
    if (!p) return false; // a blank entry is not a known coordination path — fail closed
    return prefixes.some((root) => (root.endsWith('/') ? p.startsWith(root) : p === root));
  });
}

// plan 3959 T2: re-export shim for every name moved to scripts/coord/review-markers.mjs, so no
// existing importer of THIS module breaks (removed once the program's later step retires this
// shim). Covers the session-entry protocol, the marker-family primitives, and the
// findings-sidecar/disposition machinery.
export {
  isArchiveSessionPath,
  isSessionEntryPath,
  sessionEntryPathspec,
  SESSION_BRANCH_LINE_PATTERN,
  sessionEntryAnchor,
  sessionEntryOwnerSlug,
  rankSessionFiles,
  pickSessionFile,
  resolveSessionEntry,
  assertSessionEntryOwner,
  sessionEntryOwnerMessage,
  ambiguousSessionEntryMessage,
  checkRecordBranch,
  sameCommitSha,
  REVIEW_METHODS,
  REVIEW_FANOUT_METHODS,
  REVIEW_PROVENANCE_UNDECLARED,
  MARKER_FAMILIES,
  normalizeMarkerPatchId,
  markerRegExp,
  parseMarkerAny,
  markerStatusRow,
  markerIdentityMatch,
  parseMarkerCurrent,
  upsertMarker,
  parseReviewMarker,
  parseReviewMarkerAny,
  parseReviewMarkerFull,
  repinDecision,
  upsertReviewMarker,
  buildReviewProvenance,
  normalizeFindingIdentity,
  findingKey,
  malformedFindingPathText,
  malformedFindingEntry,
  normalizeRounds,
  buildFindingsRecord,
  normalizeFindingTags,
  isMustFixFinding,
  deferredByTagDisposition,
  sidecarOwnedBy,
  sidecarOwnerConflict,
  classifyFinding,
  findingBlocksLand,
  normalizeDisposition,
  parseFindingsRecord,
  dispositionFinding,
  findingsSidecarPath,
  planIdInTree,
} from './review-markers.mjs';

// The single "this diff carries source-code that needs a code-review verdict" predicate, shared by
// reviewSeam (the land gate) and enqueueReadinessWarning (the enqueue nudge) so the two can NEVER
// drift (a drift would silently disagree on whether a diff needs review — review [2]/[4]/[6]).
export function isReviewableDiff(changedFiles) {
  return (changedFiles || []).some(
    (f) => (SOURCE_RE.test(f) || SCRIPTS_SHELL_RE.test(f)) && !REVIEW_EXCLUDE_RE.test(f),
  );
}

/** Mirrors the SKILL.md step-2.5 trigger probe. recordedVerdict: 'PASS'|'NITS'|'BUGS-FOUND'|null */
export function reviewSeam(changedFiles, recordedVerdict) {
  if (!isReviewableDiff(changedFiles)) return null;
  // plan 1205: ANY recorded verdict (PASS / NITS / BUGS-FOUND) clears the review-needed
  // seam — a verdict means the review ran. BUGS-FOUND no longer hard-blocks HERE (it used
  // to re-surface REVIEW_NEEDED, which pushed sessions to downgrade to NITS or stay silent
  // about a bug they did not fix). Instead the findings-as-data gate (findingsGate, below)
  // now requires each reported finding to be DISPOSITIONED — filed as a plan, fixed, or
  // waved — so a known bug can land iff a plan is filed for it ("file a plan, then land").
  // Only the ABSENCE of any verdict (null — review not yet run) still halts here.
  if (recordedVerdict === 'PASS' || recordedVerdict === 'NITS' || recordedVerdict === 'BUGS-FOUND')
    return null;
  return seam(
    SEAM.REVIEW_NEEDED,
    'source-code paths in diff need a code-review verdict — run /code-review, then re-invoke with --resume REVIEW_NEEDED. ' +
      'To skip this halt next time, record the verdict after reviewing (before landing): node scripts/record-review.mjs <PASS|NITS|BUGS-FOUND>.',
    { recordedVerdict },
  );
}

// plan 2170 Ship 1: enqueue-time readiness REFUSAL — queue position ≠ readiness. The FIFO
// landing slot must mean "reviewed + done, merge NOW". Plan 1219 took a slot after one review
// and ran a third on the head slot (~23 min); plan 2150 enqueued 67 minutes before it was
// land-ready and priced the head slot with its full Sonnet review while up to 6 waiters sat
// behind it. Plan 1240 shipped this check as a WARN; 2170 upgrades it to a hard refuse.
//
// The gate fires when the land diff is reviewable but carries NO current sha-pinned review
// verdict for HEAD — i.e. no marker yet, OR a STALE marker whose sha predates HEAD (the reopen
// signal; recordedVerdict is null in BOTH cases because parseReviewMarker returns null on a sha
// mismatch). A clean, current verdict returns null (the sha-pin is honored → NO redundant
// re-fan-out). The refusal deliberately does NOT honor `--resume REVIEW_NEEDED` at its call
// site — that resume token skipping the 2.5 review seam and reaching the enqueue verdict-less
// IS the 2150 hole (a resume asserting "review done" is verifiable: the marker either exists
// for HEAD or it doesn't).
//
// The plan-1240 warn-not-refuse objections, addressed rather than inherited:
//   - keep-hot --prep REBASE (marker sha legitimately predates a patch-identical re-sha):
//     the caller hoists tryMarkerRepin BEFORE this check (including on --resume runs), so a
//     pure rebase self-heals and never reaches the refusal.
//   - Group D-prep's in-mutex seed re-apply commit moves HEAD AFTER enqueue — an enqueue-time
//     gate never sees it.
//   - "auto-release-at-head machinery": Ship 2's dequeue-on-rework with position-preserving
//     re-entry (reenterEntry / landing-queue reenter) is that machinery, non-thrashy by
//     construction (re-entry keeps the original enqueuedIso, never displaces an in-flight head).
//   - handoffLayout: in a 'single'-layout consumer (a sibling repo adopting these scripts) the
//     marker convention doesn't exist — recordedVerdict is ALWAYS null there, so a refusal
//     would make every reviewable land unlandable. Those repos keep `--resume REVIEW_NEEDED`
//     as their way past; the refusal is sessions-layout only. Pure; returns reason or null.
export function enqueueReadinessRefusal(changedFiles, recordedVerdict, handoffLayout) {
  if (handoffLayout !== 'sessions') return null;
  if (!isReviewableDiff(changedFiles)) return null;
  if (recordedVerdict === 'PASS' || recordedVerdict === 'NITS' || recordedVerdict === 'BUGS-FOUND')
    return null;
  return (
    'REFUSING to enqueue for a FIFO landing slot: the land diff carries source paths but NO ' +
    'CURRENT sha-pinned review verdict for HEAD (no marker recorded, or a marker whose sha ' +
    'predates HEAD = reworked-after-review). A queue slot means "reviewed + done, merge NOW" ' +
    '(plan 2170 — the plan-2150 67-min head hold; review time must never price the head slot). ' +
    'Run the review OUT of the queue, record it (node scripts/record-review.mjs ' +
    '<PASS|NITS|BUGS-FOUND> [--findings …]), then re-invoke done-worktree. A marker stale from ' +
    'a pure rebase auto-repins before this gate; genuine rework re-reviews the delta.'
  );
}

// plan 3959 T2: the findings-sidecar/disposition machinery (normalizeFindingIdentity through
// dispositionFinding below) moved to scripts/coord/review-markers.mjs.
// True when the record is pinned to the current HEAD (same staleness rule as the review/wiki
// markers — the shared sameCommitSha predicate). A record for an older tip does not gate.
// plan 2743: the sidecar twin of parseMarkerCurrent's rebase-stable fallback, and deliberately
// the same shape — sha fast path first (no git), then, only on a mismatch and only when the
// record carries a patch-id, the content identity. `headPatchId` is a value or a thunk; omitted
// ⇒ sha-only, exactly the pre-2743 behavior (which is what a legacy sidecar gets).
// plan 3295: `seedOnlyDelta` (optional 4th arg) is the findings-sidecar twin of the review
// marker's seed-only carry — threaded straight into markerIdentityMatch's 5th param, same
// value-or-function contract as headPatchId, tried lazily only after sha+patch-id both fail.
// "Findings dispositions ride along (no re-disposition)" (operator ruling 2026-08-19): a
// dispositioned NITS/BUGS-FOUND sidecar recorded at X must not re-open at a seed-only tip Y
// just because the marker above it was honored and the sidecar was not.
function findingsRecordIsCurrent(record, currentSha, headPatchId = null, seedOnlyDelta = null) {
  if (!record) return false;
  return Boolean(
    markerIdentityMatch(record.sha, record.patchId, currentSha, headPatchId, seedOnlyDelta),
  );
}

// plan 3959 T2: findingsSidecarPath + planIdInTree moved to scripts/coord/review-markers.mjs.

// The findings-as-data land gate (plan 1205). Returns a FINDINGS_OPEN seam when the land
// must halt, else null. Inputs:
//   recordedVerdict — parseReviewMarker(currentSha): 'PASS'|'NITS'|'BUGS-FOUND'|null
//   record          — parseFindingsRecord(sidecar) or null
//   currentSha      — HEAD the land covers
//   planExists(id)  — boolean: does plan <id> exist (refs/plans or a plan folder)? Defaults to
//                     `() => false` (CONSERVATIVE — an unverified plan ref counts as dangling, so
//                     a caller that forgets a real checker FAILS CLOSED, never silently passes).
// Missing, open, dangling, and malformed findings all halt; PASS/null never gate here.
export function findingsGate(
  recordedVerdict,
  record,
  currentSha,
  planExists = () => false,
  headPatchId = null, // plan 2743: rebase-stable identity, same contract as parseMarkerCurrent's
  seedOnlyDelta = null, // plan 3295: the review-only seed-only carry, same contract as headPatchId
) {
  if (recordedVerdict !== 'NITS' && recordedVerdict !== 'BUGS-FOUND') return null;
  const current = findingsRecordIsCurrent(record, currentSha, headPatchId, seedOnlyDelta);
  if (!current) {
    return seam(
      SEAM.FINDINGS_OPEN,
      `a ${recordedVerdict} review verdict is recorded for HEAD but no findings are attached for this tip — ` +
        `record-review ${recordedVerdict} now requires --findings (the review's findings as JSON) so each can be ` +
        `dispositioned before landing. Re-run /sonnet-review to produce them (it writes the findings sidecar), or, ` +
        `if the review was genuinely clean, record PASS instead.`,
      { recordedVerdict, reason: 'no-findings-attached' },
    );
  }
  const open = [];
  const dangling = [];
  const malformed = [];
  for (const [index, rawFinding] of (record.findings || []).entries()) {
    const f = findingWithCanonicalKey(rawFinding, index);
    // plan 3623 item 4/5: the halt decision goes through the SAME predicate record-review's
    // openCount uses (findingBlocksLand) — the old `if (!isMustFixFinding(f)) continue;` here
    // skipped the dangling-plan check for every advisory finding too, because it opened the loop
    // instead of gating only the 'open'/undispositioned bucket. Bucketing below reuses the SAME
    // classification (finding 2a1680) instead of re-deriving it via a second classifyFinding call.
    const { cls, blocks } = classifyAndBlocks(f, planExists);
    if (!blocks) continue;
    if ('malformedIndex' in f) {
      malformed.push(f);
      continue;
    }
    if (cls === 'dangling') dangling.push(f);
    else open.push(f); // cls === 'open' — blocks already proved isMustFixFinding(f)
  }
  if (open.length === 0 && dangling.length === 0 && malformed.length === 0) return null;
  const fmt = (f) => `  [${f.key}] ${f.file}${f.line != null ? ':' + f.line : ''} — ${f.summary}`;
  const parts = [];
  if (open.length > 0)
    parts.push(
      `${open.length} review finding${open.length === 1 ? '' : 's'} not yet dispositioned:\n` +
        open.map(fmt).join('\n'),
    );
  if (dangling.length > 0)
    parts.push(
      `${dangling.length} finding${dangling.length === 1 ? '' : 's'} reference a plan that does not exist:\n` +
        dangling.map((f) => `${fmt(f)}  (plan ${f.disposition.planId})`).join('\n'),
    );
  if (malformed.length > 0)
    parts.push(
      `${malformed.length} malformed finding ${malformed.length === 1 ? 'entry blocks' : 'entries block'} landing and cannot be dispositioned; repair the findings sidecar:\n` +
        malformed.map((f) => `  ${f.malformedReason}`).join('\n'),
    );
  return seam(
    SEAM.FINDINGS_OPEN,
    `every review finding must be dispositioned before landing (operator directive 2026-06-30 — ` +
      `"pre-existing" is not an exemption). For each open finding choose one:\n` +
      `  • file a plan and link it:  node scripts/record-review.mjs disposition <key> --plan <id>\n` +
      `  • it was fixed in this diff: node scripts/record-review.mjs disposition <key> --fixed\n` +
      `  • consciously not doing it:  node scripts/record-review.mjs disposition <key> --wontfix "<reason>"\n` +
      `then re-invoke done-worktree (bare — the gate re-reads the record; there is no --resume skip).\n\n` +
      parts.join('\n\n'),
    {
      open: open.map((f) => f.key),
      dangling: dangling.map((f) => f.key),
      malformed: malformed.map((f) => f.malformedIndex),
    },
  );
}

// plan 3961 T2.5: the STATUS_FLIP knowledge-of-record land gate (plan 1074/2043/2069) — CLOSED,
// ROUTINE_FLIPS, isGuardedFlip, rowHasStatusRationale, TERMINAL_STATUSES, and
// findStatusFlipViolations itself — moved to scripts/project/land-seams.mjs (statusFlipSeam moved
// with it; see that module's own header). `groupRowsById` right below stays HERE: it is also used
// by findWorldClaimFlips (conclusionReviewSeam's own detector), which is T2.6's move, not this
// one's.

// Groups rows by id into an ARRAY of every row sharing that id, not the last-write-wins
// single row a plain `Map.set` collapse gives you. Shared by both flip-detection
// functions' base-side views (plan-2069 review): a last-write-wins Map silently
// drops a duplicate-id BASE row, which is harmless for the normal head-comparison
// lookup (still uses the last occurrence, same as before) but was a real gap for the
// residual-deletion walk — if the surviving duplicate happened to be terminal/
// unestablished while a dropped sibling was not, a genuine deletion of that id cleared
// the gate silently. Grouping keeps every sibling's info available to that walk.
// plan 3961 T2.5: exported (was module-private) — findStatusFlipViolations (now
// scripts/project/land-seams.mjs) is the other consumer.
export function groupRowsById(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!r || !r.id) continue;
    if (!groups.has(r.id)) groups.set(r.id, []);
    groups.get(r.id).push(r);
  }
  return groups;
}

// Pure: does the diff touch the clinic-row seed surface — the monolith OR (plan 1300,
// post-flip) a per-clinic shard file? Layout-pattern match, not a configured root, so
// the lib stays pure and config-free; a manifest-only diff (chains/country order)
// can't flip a row field. ONE copy shared by statusFlipSeam + conclusionReviewSeam
// (review 2033 [2]: a third copy-pasted regex pair would let the gates drift blind on
// the next shard-layout change).
// `shardIdPattern` (plan 3960 review fix): an optional override of coord-config.mjs's
// `shardIdPattern` default, mirroring shardFileRx/seedScopeOf's own seam above — omitted, this
// matches on the module's own SHARD_REL_SRC (today's exact default, byte-identical); provided, the
// clinic-row surface test tracks the SAME configured layout the mutex (seedScopeOf) and the gate
// readers (readShardGateViews) already use, so a custom shardIdPattern is recognized here too.
export function seedSurfaceTouched(changedFiles, shardIdPattern) {
  const shardRelSrc = shardIdPattern
    ? deriveShardPatterns(shardIdPattern).shardRelSrc
    : SHARD_REL_SRC;
  const shardTailRx = new RegExp(`/seed/${shardRelSrc}$`);
  return (changedFiles || []).some((f) => /seed-clinics\.json$/.test(f) || shardTailRx.test(f));
}

// The gate-INVOCATION twin of seedSurfaceTouched (plan 2042 — was a third, non-identical
// inline copy in done-worktree.mjs). Deliberately BROADER: the shard arm is a configured
// directory-prefix check, not the clinic-row regex, because the outer seed-gate block also
// feeds the chains.json wiki signal (and per-country order.json) — a manifest-only diff must
// still invoke the gates even though it can't flip a row field. Lives HERE, beside
// seedSurfaceTouched, so a shard-layout change edits both detectors in one place instead
// of leaving the gates blind. Returns the two arms separately: monolith-in-diff selects
// the full-corpus seed views, shards-only the per-shard views.
//
// plan 3078: `monolithPaths` (the matched paths, not just the boolean) is returned so the
// MONOLITH_RESURRECTED seam can NAME the offending files without re-deriving the match — the
// monolith regex stays in exactly ONE place here, per this function's own co-location rule
// above. `monolithInDiff` is unchanged in meaning: it is that list being non-empty.
export function seedGateSurfaces(changedFiles, seedShardDir) {
  const files = changedFiles || [];
  const monolithPaths = files.filter((f) => /seed-clinics\.json$/.test(f));
  return {
    monolithPaths,
    monolithInDiff: monolithPaths.length > 0,
    shardsInDiff: Boolean(seedShardDir) && files.some((f) => f.startsWith(`${seedShardDir}/`)),
  };
}

// plan 3961 T2.5: statusFlipSeam moved to scripts/project/land-seams.mjs alongside
// findStatusFlipViolations — see that module's own header for the full move rationale.

// Pure: the MONOLITH_RESURRECTED seam (plan 3078). Fires when the diff carries the retired
// seed monolith. Takes the ALREADY-MATCHED paths from seedGateSurfaces' monolithPaths rather
// than re-testing the regex here: the matcher lives in exactly one place (that function's own
// co-location rule), so a shard-layout change cannot leave this seam matching a different set
// than the arm that gates it. Unlike statusFlipSeam/conclusionReviewSeam this needs NO
// base/head seed read — a resurrected monolith is a land-refusal regardless of what it
// contains — so the spine can call it before building any gate view.
//
// `seedShardDir` is passed IN (from the spine's resolved cfg.seedShardDir) rather than
// hardcoded: the sharded root is configurable, and — deliberately — a quoted literal of it
// here would trip assert-seed-io-seam.mjs, which flags any quoted path into the sharded tree
// in a non-allowlisted scripts/ module. Naming the live configured root is both more honest
// and seam-clean.
export function monolithResurrectedSeam(monolithPaths, seedShardDir) {
  const paths = monolithPaths || [];
  if (paths.length === 0) return null;
  const shardRoot = seedShardDir ? `${seedShardDir}/` : 'the sharded seed directory';
  return seam(
    SEAM.MONOLITH_RESURRECTED,
    `the land diff resurrects the retired seed monolith (${paths.join(', ')}). ` +
      `CLAUDE.md forbids this explicitly ("a re-appearing monolith is a resurrected legacy ` +
      `write") — the only seed surface is ${shardRoot}. Drop ` +
      `the monolith path from the diff and re-invoke; if its presence is genuinely intentional, ` +
      `the conscious operator waiver is --resume MONOLITH_RESURRECTED (plan 3078).`,
  );
}

// Pure: the SEED_BASE_UNRESOLVED seam (plan 3282). `mergeBaseRef` (done-worktree.mjs) returns
// null on any failure to resolve the branch's merge-base against origin/master — its own
// documented contract. Passed straight into readShardGateViews, a null baseRef produces a null
// base VIEW, and every one of the four base-vs-head seed gates fed by that one call
// (findStatusFlipViolations / findWorldClaimFlips / changedPriceClinics / pagedClinicChanged)
// treats a non-array as "no violations" — deliberately, for a DIFFERENT case (an unreadable/
// malformed seed on one side must not over-gate a normal land; see each function's own
// comment). This seam closes the merge-base-specific case at its ONE feeder call site instead:
// baseRef === null on a land whose diff touches seed shards refuses HERE, before any of those
// four gates run, rather than let all four silently see nothing.
//
// Only baseRef === null refuses — an EMPTY base view (`clinics: []`, e.g. a shard file added at
// head with no base version) is a real, resolved comparison and must not be conflated with an
// unresolved lookup. shardsInDiff mirrors the call site's own guard so this predicate never
// fires when there is no seed-shard diff to gate in the first place.
export function seedBaseUnresolvedSeam(baseRef, { shardsInDiff }) {
  if (baseRef !== null || !shardsInDiff) return null;
  return seam(
    SEAM.SEED_BASE_UNRESOLVED,
    `the seed diff's merge-base against origin/master could not be resolved (git merge-base ` +
      `failed), so the base-vs-head seed gates (STATUS_FLIP / CONCLUSION_REVIEW / ` +
      `PRICE_GATE_FAILED / WIKI_CHECKPOINT) cannot see what actually changed and must not run ` +
      `blind against an empty base. Repair the checkout — \`git -C <worktree> fetch origin ` +
      `master\`, or \`git fetch --unshallow\` on a shallow cloud checkout (plans 3239/3274) — ` +
      `then re-invoke \`node scripts/done-worktree.mjs <slug>\` PLAINLY. There is no --resume ` +
      `waiver for this seam: skipping it would re-open the exact fail-open it exists to close.`,
  );
}

// ── plan 2033: conclusion-review gate for world-claim seed writes ─────────────
// The fields whose seed value IS a claim about external reality — liveness, clinic
// type, chain/brand attribution, booking-platform identity — used to live here as one exported
// const (the GATE1_PIPELINE_FIELDS pattern, claim-plan-lib.mjs), deliberately NOT the whole
// VerifiableFieldSchema enum: contact data, prices, hours etc. are observations the diff-review
// ladder already covers; these are the CONCLUSIONS the 2026-07-18 retrospective showed no gate
// reviews. Plan 3961 T2.6 moved the list itself OUT of this module and into configuration —
// `coord.config.json -> land.worldClaimFields` (vetapp's own config still carries the same five:
// operationalStatus, clinicConfirmation, chainId, bookingPlatform, externalId) — because the
// seam's MECHANISM below is generic over sharded record files and only the field list is project
// vocabulary. `findWorldClaimFlips`/`conclusionReviewSeam` now take it as a required parameter.

// A base value that does NOT yet constitute an established world claim. Overwriting
// one of these is a FIRST attribution (a null→value backfill, an unverified→veterinary
// confirmation, an unknown→active promote) — routine pipeline writes, not conclusion
// overwrites. Gating them would fire the seam on every enrichment land, normalise the
// waiver, and decay the gate to a toothless advisory (the wikiCheckpointNeeded
// narrowness argument). The plan-767 template — an established verdict overwritten
// while every named source agreed — is squarely inside the guarded set.
const UNESTABLISHED_VALUES = new Set([null, undefined, '', 'unknown', 'unverified']);

// Pure: find rows whose established world-claim field value CHANGED between the base
// and head seed views. Only transitions count (a brand-new row is an attribution, not
// an overwrite); value→null counts (a de-attribution — "no longer chain X" — is as
// much a world claim as the attribution was). A base row ABSENT from head is reported
// as one '(row)' present→deleted flip when it carried any established world-claim
// value (review 2033 [0]: a delete-and-recreate/re-key edit would otherwise vanish
// from the head view and silently bypass the gate — the seed convention is
// tombstoning, so an outright row deletion is exactly the shape that deserves the
// adversarial look; a legit dedup removal clears via review or the --resume waiver).
// baseRows/headRows are parsed seed clinic arrays; a non-array (unreadable seed)
// yields [] so the gate fails OPEN (validate-seed guards parse errors separately,
// same contract as STATUS_FLIP).
// plan 3282: the caller guarantees baseRows is never null-from-an-unresolved-merge-base —
// that case now refuses via SEED_BASE_UNRESOLVED before this runs.
// `worldClaimFields` (plan 3961 T2.6): REQUIRED, no default — the guarded field list moved to
// `coord.config.json -> land.worldClaimFields`, so a caller that forgets to pass it gets a thrown
// Error naming the parameter rather than silently seeing "the five" (a stale hardcode) or
// silently seeing "none" (a gate that quietly never fires). validateWorldClaimFields is the one
// check shared with conclusionReviewSeam below.
function validateWorldClaimFields(worldClaimFields) {
  if (!Array.isArray(worldClaimFields)) {
    throw new Error(
      'findWorldClaimFlips/conclusionReviewSeam: worldClaimFields must be an array (pass ' +
        "coord.config.json's land.worldClaimFields — there is no default)",
    );
  }
}

export function findWorldClaimFlips(baseRows, headRows, worldClaimFields) {
  validateWorldClaimFields(worldClaimFields);
  if (!Array.isArray(baseRows) || !Array.isArray(headRows)) return [];
  const baseGroups = groupRowsById(baseRows);
  const seenIds = new Set();
  const flips = [];
  for (const cur of headRows) {
    if (!cur || !cur.id) continue;
    seenIds.add(cur.id);
    const prevGroup = baseGroups.get(cur.id);
    if (!prevGroup) continue; // new row — an attribution, not an overwrite
    const prev = prevGroup[prevGroup.length - 1];
    for (const field of worldClaimFields) {
      const from = prev[field] ?? null;
      const to = cur[field] ?? null;
      if (UNESTABLISHED_VALUES.has(from)) continue; // first attribution — routine
      if (from === to) continue;
      flips.push({ id: cur.id, name: cur.name || cur.id, field, from, to });
    }
  }
  for (const [id, group] of baseGroups) {
    if (seenIds.has(id)) continue; // still present in head — not a deletion
    // A duplicate-id base group must not silently lose an established sibling: flag
    // the deletion if ANY row sharing this id carried an established world-claim value.
    const establishedRow = group.find((r) =>
      worldClaimFields.some((f) => !UNESTABLISHED_VALUES.has(r[f] ?? null)),
    );
    if (establishedRow)
      flips.push({
        id,
        name: establishedRow.name || id,
        field: '(row)',
        from: 'present',
        to: 'deleted',
      });
  }
  return flips;
}

// The conclusion-review marker scripts/record-conclusion.mjs leaves in the worktree's
// handoff session entry: `Conclusion: <UPHELD|REFUTED|UNDERDETERMINED>:<detail> @ <sha>`.
// The detail is MANDATORY at record time (the missing-source / unanswered-question
// line IS the audit-trail artifact); the parse still tolerates its absence so a
// hand-trimmed marker degrades to a parseable verdict rather than a silent re-halt.
// Conclusion-family delegates of the plan-2042 generics above.
export function parseConclusionMarker(text, currentSha, headPatchId = null) {
  const m = parseMarkerCurrent(MARKER_FAMILIES.conclusion, text, currentSha, headPatchId);
  return m ? { verdict: m.verdict, detail: m.detail } : null;
}

export function parseConclusionMarkerAny(text) {
  return parseMarkerAny(MARKER_FAMILIES.conclusion, text);
}

export function upsertConclusionMarker(content, verdict, sha, detail = '', patchId = null) {
  return upsertMarker(MARKER_FAMILIES.conclusion, content, verdict, sha, detail, patchId);
}

// Pure: the CONCLUSION_REVIEW seam. Fires when the seed diff overwrites an established
// world-claim field AND no fresh UPHELD verdict covers the current tip. recordedVerdict
// is the parsed marker for HEAD ({ verdict, detail }) or null. Only UPHELD clears: a
// recorded REFUTED must not land (the conclusion failed its own review — fix the seed
// or re-review), and an UNDERDETERMINED names the missing source to chase; both halt
// loudly with the recorded verdict named, leaving --resume CONCLUSION_REVIEW as the
// conscious operator waiver.
export function conclusionReviewSeam(
  changedFiles,
  baseRows,
  headRows,
  recordedVerdict,
  shardIdPattern,
  worldClaimFields,
) {
  validateWorldClaimFields(worldClaimFields);
  if (!seedSurfaceTouched(changedFiles, shardIdPattern)) return null;
  const flips = findWorldClaimFlips(baseRows, headRows, worldClaimFields);
  if (flips.length === 0) return null;
  if (recordedVerdict && recordedVerdict.verdict === 'UPHELD') return null;
  const lines = flips.map(
    (f) =>
      `  - ${f.name} (${f.id}): ${f.field} ${JSON.stringify(f.from)} → ${JSON.stringify(f.to)}`,
  );
  const recordedNote = recordedVerdict
    ? `A conclusion review IS recorded for this tip — verdict ${recordedVerdict.verdict}` +
      (recordedVerdict.detail ? ` (${recordedVerdict.detail})` : '') +
      (recordedVerdict.verdict === 'REFUTED'
        ? ` — a REFUTED conclusion must not land: fix the seed rows (or re-run the refuter if the refutation was wrong), re-record, and re-invoke.`
        : ` — chase the named missing source, re-run the refuter, and re-record; only UPHELD clears the gate.`)
    : `No conclusion review is recorded for this tip. Run ONE adversarial refuter (Sonnet-tier) over the ` +
      `plan body + the seed diff + the verification note, prompted to REFUTE the conclusion: name a source ` +
      `that could contradict the claim, and state what question the gathered evidence does NOT answer ` +
      `(the plan-767 template: sources proved the named brand absent, not the premises empty). Then record ` +
      `the verdict: node scripts/record-conclusion.mjs <UPHELD|REFUTED|UNDERDETERMINED> "<missing-source / ` +
      `unanswered-question line>" (run from inside the worktree, after the final commit).`;
  return seam(
    SEAM.CONCLUSION_REVIEW,
    `the seed diff OVERWRITES an established world-claim field (${worldClaimFields.join(', ')}) — a ` +
      `claim about external reality whose CONCLUSION (not just the diff) needs one adversarial look before ` +
      `it reaches master (plan 2033; the review ladder reviews diffs, and every judgment failure in the ` +
      `2026-07-18 retrospective was operator-caught, zero gate-caught). ${recordedNote} ` +
      `--resume CONCLUSION_REVIEW is the explicit operator-waiver valve (only after confirming the ` +
      `conclusion is genuinely sound):\n${lines.join('\n')}`,
    { flips, recordedVerdict: recordedVerdict || null },
  );
}

// The wiki growth-checkpoint marker scripts/record-wiki.mjs leaves in the worktree's
// handoff session entry: `Wiki: WROTE:<detail> @ <sha>` / `Wiki: SKIP:<detail> @ <sha>`
// (sha = the branch HEAD the decision covered). The detail is optional but encouraged
// (the pages written, or why nothing was). Parsed to satisfy WIKI_CHECKPOINT.
// Wiki-family delegates of the plan-2042 generics above (historical contract: the
// verdict key is `decision`).
export function parseWikiMarker(text, currentSha, headPatchId = null) {
  const m = parseMarkerCurrent(MARKER_FAMILIES.wiki, text, currentSha, headPatchId);
  return m ? { decision: m.decision, detail: m.detail } : null;
}

export function parseWikiMarkerAny(text) {
  return parseMarkerAny(MARKER_FAMILIES.wiki, text);
}

export function upsertWikiMarker(content, decision, sha, detail = '', patchId = null) {
  return upsertMarker(MARKER_FAMILIES.wiki, content, decision, sha, detail, patchId);
}

// plan 3961 T2.5: WIKI_SUBJECT_PATTERNS and wikiCheckpointNeeded moved to
// scripts/project/land-seams.mjs alongside wikiCheckpointSeam — see that module's own header.

// Key-order-insensitive JSON serialization: object keys are sorted recursively, array
// order is preserved (a reordered array IS a real change). Used by BOTH pagedClinicChanged
// and chainsChanged (in done-worktree.mjs) so a key-reorder-only seed re-serialization does
// not spuriously trip WIKI_CHECKPOINT (finding [6]). Inputs are JSON-parsed seed values →
// no undefined/function values.
export function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

// Pure: did any clinic that HAS a wiki page change between base and head? The
// per-clinic-page analogue of chainsChanged. hasPage(id) is injected (the spine
// passes existsSync over wiki/entities/clinics/; tests stub it). Compares ONLY the
// paged subset, so it stays cheap and can't normalise SKIP across the plain rows.
// Compares a canonical (sorted-key) serialization, so a key-reorder-only seed
// re-serialization does not spuriously trip the checkpoint (finding [6]).
// plan 3282: the caller guarantees baseClinics is never null-from-an-unresolved-merge-base —
// that case now refuses via SEED_BASE_UNRESOLVED before this runs.
export function pagedClinicChanged(baseClinics, headClinics, hasPage) {
  if (!Array.isArray(baseClinics) || !Array.isArray(headClinics)) return false;
  const subset = (rows) => {
    const m = new Map();
    for (const c of rows) {
      if (c && c.id && hasPage(c.id)) m.set(c.id, canonicalJSON(c));
    }
    return m;
  };
  const b = subset(baseClinics);
  const h = subset(headClinics);
  const ids = new Set([...b.keys(), ...h.keys()]);
  for (const id of ids) {
    if (b.get(id) !== h.get(id)) return true;
  }
  return false;
}

// plan 3961 T2.5: STAMP_ONLY_PRICE_FIELDS, stripStampOnlyPriceFields, changedPriceClinics
// (plan 1165/2737/3130's JS land price-gate cohort) and wikiCheckpointSeam all moved to
// scripts/project/land-seams.mjs -- see that module's own header for the full move rationale and
// what stayed shared here (seedSurfaceTouched, groupRowsById, canonicalJSON, seam, pagedClinicChanged).

// plan 3959 T2: the prod-deploy cluster (DEPLOY_FAILURE_STATUSES through
// uniformManualDeployOutcome — PROD_DEPLOY_SERVICES, deploySeam, worstDeployStatus,
// mapRailwayDeployStatus, isManualDeployMode, manualDeployNotice, postDeploySmokeNotice,
// manualDeployReportStatus, missingDeployCredentialSummary, manualServicesNotTriggered,
// applyTriggerOutcomes, uniformManualDeployOutcome) moved to scripts/project/deploy.mjs — 100%
// vetapp-specific (market/service vocabulary), so it lives in the PROJECT layer, not coord.
// Re-exported below so no existing importer of this module breaks.
// plan 4096 T2: the re-export is GONE. A core module may not import a project one, and these
// names are PASS-THROUGHS — nothing in this file reads any of them. Import the prod-deploy
// cluster from scripts/project/deploy.mjs, which owns it.

// plan 3961 T2.5: findStatusFlipViolations/statusFlipSeam, wikiCheckpointNeeded/
// wikiCheckpointSeam, and changedPriceClinics/STAMP_ONLY_PRICE_FIELDS moved to
// scripts/project/land-seams.mjs (see this file's own comments above, in place of each moved
// function, for what stayed and why). Re-exported below so no existing importer of this module
// breaks (done-worktree.mjs's `L.findStatusFlipViolations` etc., record-review.mjs's
// `wikiCheckpointNeeded`, and every done-worktree-lib.test.mjs import of these names).
// plan 4096 T2: the re-export is GONE, for the same reason as the deploy block above. Import
// these from scripts/project/land-seams.mjs, which owns them. (`wikiCheckpointNeeded` also
// left THAT module: its subject patterns are coord.config.json data now and the predicate
// lives in scripts/coord/wiki-checkpoint.mjs, which land-seams.mjs re-exports.)

// plan 3961 T2.7c: the land trust gate's merge-base baseline data/filters — TRUST_GATE_ENTRY_FILES
// through changedConsensusIds — moved to scripts/project/land-gate-price-trust.mjs, alongside
// stageTrustGateBaseCode/runPriceTrustGate (plan 3961 T2.4), their only real consumers. Re-exported
// below so no existing importer of this module breaks (done-worktree.test.mjs's imports of these
// names).
// plan 4096 T2: the re-export is GONE, for the same reason as the two blocks above. Import
// these from scripts/project/land-gate-price-trust.mjs, which owns them.

// plan 4096 T1/S9: the `export { pytestPreflightNeeded }` re-export is GONE — import it from
// scripts/project/land-gate-pytest.mjs, which owns it.

// ── plan 502: index.lock backoff + exhaustion typing ──────────────────
// The old gitMain budget (9×300ms ≈ 2.7s) was routinely exhausted at peak 6–7-
// session contention on the shared .git. Exponential backoff, ~24s total, first
// retry fast (most collisions clear in milliseconds).
export const LOCK_RETRY_DELAYS_MS = [300, 600, 1200, 2400, 4800, 5000, 5000, 5000];

// The git failure shapes that mean "another process holds a .git lock" — transient
// contention, safe to retry — as opposed to a genuine error. Mirrors coord-git's
// LOCK_RX discipline: the "unable to create" alternative requires the quoted
// `'…*.lock'` path git emits, so an unrelated FS "unable to create" error is NOT
// mistaken for contention (and retried/mislabeled "transient" for 24s).
export function isIndexLockContention(msg) {
  return /index\.lock|unable to create '.*\.lock'|another git process|could not lock/i.test(
    String(msg || ''),
  );
}

// Tag an exhausted git-index retry budget as a TYPED error (.reason) so the spine's merge-step
// typed-error catch converts it to a recoverable LAND_BLOCKED seam instead of a raw stack trace.
// Mutates + returns the original error (stack preserved). plan 960: this now covers BOTH exhaustion
// causes gitMain retries — index.lock CONTENTION (a sibling session holds the lock) AND a transient
// index-WRITE failure (`unable to write new index file`, e.g. an antivirus/file-lock briefly holding
// `.git/index`) — so the message names both rather than mislabelling an AV write-stall as a sibling
// lock collision. Recovery is identical for both (re-run; the already-landed branch is detected).
export function markLockExhausted(e, detail) {
  e.reason = 'index-lock-exhausted';
  e.message =
    'git index/ref write blocked past the retry budget — either index.lock contention from sibling ' +
    'sessions on the shared .git, a transient `.git/index` write failure (e.g. an antivirus / ' +
    'file-lock briefly holding the index), or a ref-lock race (a sibling kept moving local HEAD ' +
    'during the retries). Transient, NOT a real failure. Safe to re-run ' +
    `done-worktree (an already-landed branch is detected and the re-merge skipped). (${String(detail || '').trim()})`;
  return e;
}

// ── plan 960/980: transient index-WRITE failure classifiers (distinct from .lock CONTENTION) ──
// These three were born here for done-worktree's PRIVATE gitMain (plan 960), but the SAME transient
// index-write crash class can hit ANY coord script that routes through coord-git's gitWithLockRetry /
// coordWrite / gitMoveCommit. Plan 980 lifts them to the single coord-git definition (the natural
// home alongside isNonFastForward / isForeignDirtRefusal) and RE-EXPORTS them here so every existing
// `L.isTransientIndexWrite` / `L.isNothingToCommit` / `L.isMvBadSource` call site in done-worktree.mjs
// (and this module's tests) keeps working against one source of truth — no duplicated regex to drift.
// They are pure string predicates and coord-git executes NO IO at import, so re-exporting them keeps
// this module's "total function" / unit-testable contract intact.
//   - isTransientIndexWrite: git did the work (commit object + ref move, or the working-tree rename)
//     then failed the final `.git/index` write ("…unable to write new index file"). gitMain retries it.
//   - isNothingToCommit: the half-land's retried commit finds nothing staged — tolerated AFTER
//     confirming the close-out commit is at HEAD (closeOutCommitAtHead), never a bare "nothing to commit".
//   - isMvBadSource: the half-move's retried `git mv` dies "bad source" because src already moved —
//     tolerated only when the move demonstrably happened (src absent, dest present).
//   - isRefLockRace (plan 983): a sibling moved local HEAD between this commit's HEAD-read and its
//     ref-write ("cannot lock ref 'HEAD': is at X but expected Y") — the commit did NOT land, so
//     gitMain retries it; re-reading the now-current HEAD on the next attempt succeeds.
//   - isRefUpdateRace (plan 2471): the fetch-side analogue — a sibling advanced origin/master
//     between gitMain's fetch's read and write of the remote-tracking ref ("fetching ref … failed:
//     incorrect old value provided"). Added here so gitMain's OWN retry loop (a separate
//     implementation from coord-git's gitWithLockRetry) covers the same transient on its
//     highest-contention call site — the pre-merge assertLandable TOCTOU re-check, routed through
//     gitMain, not land-lib's run() (sonnet-review high finding on this plan's own diff).
export {
  isTransientIndexWrite,
  isNothingToCommit,
  isMvBadSource,
  isRefLockRace,
  isRefUpdateRace,
} from './coord-git.mjs';

/** @param {{conflicted:boolean, conflictCommits:number, abortedOnce:boolean, mergeBearing?:boolean, pushBlocked?:boolean, pushDetail?:string, graftBlocked?:boolean, graftCommits?:{sha:string,subject:string}[]}} r */
export function rebaseSeam(r) {
  // plan 3080: the branch came out of the rebase carrying commits that live on the shared LOCAL
  // master and have NOT landed on origin/master — another plan's unlanded, unreviewed work
  // grafted onto this branch (the 2026-08-05 incident: plan 2883's branch carrying plan 2721's
  // 15 commits). Checked BEFORE the force-push, so this refuses instead of publishing it.
  // Ordered first: a graft is a statement about WHAT the branch contains, so it must not be
  // reported as whatever the push happened to do about it.
  if (r.graftBlocked) {
    // The check could not be EVALUATED (a git failure other than "no local master ref"). Fail
    // closed: an unverifiable graft guard must not read as "all clear" — see GraftCheckError.
    if (r.graftUnverifiable) {
      return seam(
        SEAM.LAND_BLOCKED,
        `REFUSING to publish this branch: the plan-3080 foreign-commit graft check could not be ` +
          `evaluated, so it cannot be shown that the branch carries only its own work — ` +
          `${r.graftDetail || '(no detail captured)'}. This is usually a transient git failure on ` +
          `the shared .git; re-run done-worktree. If it persists, check the worktree's refs ` +
          `(\`git -C <worktree> rev-list --topo-order origin/master..HEAD\`) before forcing anything.`,
        r,
      );
    }
    const commits = r.graftCommits || [];
    const named = commits
      .map((c) => `  ${c.sha.slice(0, 9)} ${c.subject || '(subject unavailable)'}`)
      .join('\n');
    // `graftCommits` is topo order (NEWEST first), so the one-line recovery cuts at commits[0] —
    // the oldest would strand every foreign commit above it (the plan-3080 recovery test caught
    // that on the first cut). It is only offered when every foreign commit sits BELOW all of our
    // own: otherwise `rebase --onto` would drop our work along with the graft (gpt-review 14f336),
    // so the interleaved case gets an explicit cherry-pick instead of a recipe that loses commits.
    const newest = commits.length ? commits[0].sha : '<newest-foreign-commit>';
    const recovery = r.graftCleanCutoff
      ? `Recover (drops everything up to and including the NEWEST foreign commit, replaying ` +
        `your own work above it onto origin/master):\n` +
        `  git -C <worktree> rebase --onto origin/master ${newest}\n`
      : // A MERGE in the range is the usual reason the cutoff is not clean, and it is exactly
        // where `cherry-pick` stops being a recipe: cherry-picking a merge commit needs `-m` and
        // a parent choice, and picking only the non-merge commits silently discards the merge's
        // own conflict RESOLUTION (gpt-review round 3: 70b811/1328a6/29ff15). Do not pretend
        // there is a one-size command — say what has to be decided, and by whom.
        (r.graftMergeBearing
          ? `The branch is MERGE-BEARING, so there is no mechanical recipe: ` +
            `\`git rebase --onto origin/master ${newest}\` would drop work along with the graft, ` +
            `and a cherry-pick cannot replay the merge commits (nor their conflict resolutions) ` +
            `without you choosing a parent for each. Rebuild it by hand: branch fresh off ` +
            `origin/master and re-apply THIS plan's work, re-doing the freshen-merge resolutions ` +
            `as you go. Start by listing what is actually yours:\n` +
            `  git -C <worktree> log --oneline --graph --topo-order origin/master..HEAD\n`
          : `Your own commits are INTERLEAVED below a foreign one` +
            (r.graftOwnAbove?.length
              ? ` (yours above the graft: ${r.graftOwnAbove.join(', ')})`
              : '') +
            `, so \`git rebase --onto origin/master ${newest}\` would DROP your work with it. ` +
            `Rebuild the branch explicitly instead — reset to origin/master and cherry-pick only ` +
            `your own commits back:\n` +
            `  git -C <worktree> log --oneline --topo-order origin/master..HEAD   # identify yours\n` +
            `  git -C <worktree> reset --hard origin/master\n` +
            `  git -C <worktree> cherry-pick <your commits, oldest first>\n`) +
        // The `-C <worktree>` on every command above is load-bearing, not tidiness: a bare
        // `reset --hard` run from where a session usually stands would wipe the SHARED main
        // checkout (gpt-review 83f120).
        '';
    return seam(
      SEAM.LAND_BLOCKED,
      `REFUSING to publish this branch: it carries ${commits.length} commit(s) that are on the ` +
        `shared LOCAL master but NOT on origin/master — i.e. another plan's unlanded, unreviewed ` +
        `work. Landing it would merge that work under THIS plan's merge (plan 3080; the ` +
        `2026-08-05 graft incident).\n${named}\n` +
        recovery +
        `  git -C <worktree> push --force-with-lease origin <branch>\n` +
        `  node <repo>/scripts/record-review.mjs repin   # must report rebase-stable\n` +
        `then re-run done-worktree. If those commits are genuinely a sibling's unpushed land, ` +
        `the shared local master needs healing first (scripts/heal-main.mjs) — do NOT force-push ` +
        `them onto master from here.`,
      r,
    );
  }
  // plan 502: the branch force-push after a clean rebase was hook-rejected (the
  // pre-push lint-board / lint-plan-index hooks validate origin/master's COMMITTED
  // board/INDEX, so a SIBLING's drift there blocks OUR push) — recoverable, not a crash.
  if (r.pushBlocked) {
    return seam(
      SEAM.LAND_BLOCKED,
      "branch push rejected (pre-push hook / remote) — most often a SIBLING session's board/INDEX " +
        "drift on master failing lint-board / lint-plan-index, NOT this branch's own diff. Heal the " +
        'drift on master (or wait for the owning session to fix it), then re-run done-worktree — ' +
        `the rebase+push is idempotent. Push output:\n${r.pushDetail || '(no output captured)'}`,
      r,
    );
  }
  // plan 3090: the rebase/freshen failed WITHOUT leaving unmerged paths — an index.lock/
  // ref-lock race on the shared .git, a rerere failure, a hook error, a killed child. This
  // is NOT a clean sync (the branch was never rebased onto the captured origin/master tip
  // and never force-pushed), so it must not fall through to the `!r.conflicted` early-return
  // below and read as clean — placed BEFORE that return on purpose.
  if (r.syncFailed) {
    return seam(
      SEAM.LAND_BLOCKED,
      'branch sync (rebase/freshen) failed WITHOUT a merge conflict — most often an index.lock/ ' +
        "ref-lock race on the shared .git, a rerere failure, or a hook error, NOT this branch's " +
        'own content. The branch was never rebased onto the captured origin/master tip and never ' +
        'force-pushed. There is NO conflict to resolve here: do not go hunting for conflict ' +
        'markers, and do not --resume past the rebase.\n' +
        'For a TRANSIENT cause (the lock races above) just re-run done-worktree — the rebase+push ' +
        'is idempotent. But read the output first: if it names a leftover rebase-merge/rebase-apply ' +
        'directory, the residue is STICKY and a bare re-run hits the identical refusal forever — ' +
        'clear it first with `node scripts/clear-stale-worktree-lock.mjs --rebase-state` (or ' +
        '`git -C <worktree> rebase --abort`), then re-run.\n' +
        `Sync output:\n${r.syncDetail || '(no output captured)'}`,
      r,
    );
  }
  if (!r.conflicted) return null;
  // plan 507: a merge-bearing branch syncs via ONE freshen-merge (conflictCommits is
  // pinned to 1 — a merge is a single pass, never "too divergent" by replay length)
  if (r.mergeBearing) {
    return seam(SEAM.REBASE_CONFLICT, 'freshen-merge conflict needs worktree-author resolution', r);
  }
  if (r.conflictCommits > 3 || r.abortedOnce) {
    return seam(SEAM.REBASE_UGLY, 'rebase too divergent — operator must judge mergeability', r);
  }
  return seam(SEAM.REBASE_CONFLICT, 'rebase conflict needs worktree-author resolution', r);
}

/** The "finally" predicate: is the cross-PC/same-PC mutex currently held? */
export function mutexHeld(state) {
  return state.lane === 'seed' && state.landingClaimed === true && state.landingReleased !== true;
}

// plan 674: is the land IRREVERSIBLY complete — the merge on origin/master (`mergeSha`) AND the
// close-out committed+pushed (`closedOut`, set at the end of closeOut after the push + mutex
// release + dequeue)? When true, a throw from the best-effort tail (carry-forward mint) or from
// teardown must be reported as success-with-teardown-errors (exit 0), NOT a CRASH / exit 255 —
// the plan-665 G4 false-failure that reads as a failed land and can drive a clobbering hand-merge
// (classically: on Windows the worktree dir could not be removed because it was the spine's cwd).
// When false (pre-merge, OR close-out half-done) a throw is a genuine crash and is rethrown so the
// operator re-runs (the already-landed re-run path then finishes the bookkeeping).
export function landFullyCompleted(state) {
  return Boolean(state && state.mergeSha && state.closedOut);
}

// plan 850: the merge sha a CRASH sidecar should record. state.mergeSha is authoritative —
// it is assigned right after mergeToMaster returns. But mergeToMaster can throw AFTER the
// ephemeral push has reached origin/master but BEFORE that assignment (a post-push fetch/sync
// overflow or any post-push throw), so the merge demonstrably landed yet state.mergeSha is still
// null. The crash path then probes origin for the real sha and passes it as `recovered`. Recording
// it makes the sidecar read "landed (teardown incomplete)" instead of the plan-844 "mergeSha:null"
// that the documented recovery (`docs/runbooks/plans-workflow.md`) reads as "nothing merged" —
// inviting a clobbering hand-merge of work that already shipped. The authoritative value always wins.
export function crashResultMergeSha(state, recovered) {
  return (state && state.mergeSha) || recovered || null;
}

// ── Carry-forward disposition + waiting-blocked promotion ─────────────

// A bullet is "decided" if it already names where it goes (SKILL.md step-5 speed rule).
const DISPOSITION_RE =
  /(→|->)\s*(open new plan|shipped in|won't fix|won’t fix|folded into|already)|\bwon['’]t fix\b/i;

export function classifyCarryForwards(bullets) {
  const auto = [];
  const ask = [];
  for (const b of bullets) {
    if (DISPOSITION_RE.test(b)) auto.push(b);
    else ask.push(b);
  }
  return { auto, ask };
}

// ── Carry-forward minting (plan 406) ─────────────────────────────────
// The `auto` bucket holds EVERY disposition-named bullet, but only the ones that
// name `→ open new plan` should mint a real plan. The other dispositions —
// `→ shipped in <sha>`, `→ won't fix`, `→ folded into <plan>`, `→ already …` —
// are records of where the follow-up already went, so they mint NOTHING. This
// selects the mintable ones and parses each into the inputs the IO shell hands to
// `next-plan-id.mjs claim` (the same race-safe mint path the drain uses, plan 388).
const OPEN_NEW_PLAN_RE = /(→|->)\s*open new plan\b/i;
// Explicit hints only — a bracketed/parenthesised `(seed)` / `(seed, ready)` token,
// the literal `seed-write`, or a 🟥 — never a bare "seed"/"ready" word in prose (a
// title like "re-validate seed-clinics" must NOT flip SEED-WRITE; the operator
// confirms the real banner at triage). Seed ⇒ 🟥 SEED-WRITE banner. Ready is a
// RETIRED flag (plan 1419): it no longer branches the mint destination — every
// carry-forward stub rests in pending-approval/ regardless — but is still detected
// so the done-worktree spine can surface a one-line land-report warning when a
// legacy author still writes the token.
const SEED_HINT_RE = /[([][^)\]]*\bseed\b[^)\]]*[)\]]|seed-write|seed write|🟥/i;
const READY_HINT_RE = /[([][^)\]]*\bready\b[^)\]]*[)\]]|ready-to-start|fully[- ]scoped/i;

// The bullet's title = the prose BEFORE the `→ open new plan` marker (stripped of
// the list bullet + any strike-through). When the marker leads the bullet (no
// prose before it), fall back to the descriptor after the marker, dropping a bare
// trailing plan-id token the operator may have jotted (`open new plan 340` → "").
export function carryForwardTitle(bullet) {
  let s = String(bullet)
    .replace(/^\s*[-*]\s+/, '')
    .replace(/~~/g, '')
    .trim();
  const idx = s.search(OPEN_NEW_PLAN_RE);
  let title = (idx >= 0 ? s.slice(0, idx) : s).replace(/[\s—–:;,-]+$/u, '').trim();
  if (!title) {
    title =
      s
        .replace(/^.*?(?:→|->)\s*open new plan\b[:\s-]*/i, '')
        .replace(/^\d{3,}\b[\s:.-]*/, '') // drop a bare jotted plan-id
        .replace(/^[([][^)\]]*[)\]][\s:.-]*/, '') // drop a leading (seed)/(ready) hint token
        .trim() || 'carry-forward';
  }
  return title;
}

/**
 * @param {string[]} autoBullets the `auto` bucket from classifyCarryForwards
 * @returns {{title:string, mutation:'yes'|'no', ready:boolean, raw:string}[]}
 *   one entry per `→ open new plan` bullet; non-open-new-plan dispositions excluded.
 */
export function carryForwardMints(autoBullets) {
  const out = [];
  for (const b of autoBullets || []) {
    if (!OPEN_NEW_PLAN_RE.test(b)) continue;
    out.push({
      title: carryForwardTitle(b),
      mutation: SEED_HINT_RE.test(b) ? 'yes' : 'no',
      ready: READY_HINT_RE.test(b),
      raw: b,
    });
  }
  return out;
}

/**
 * plan 629: mint items for the AMBIGUOUS (no-disposition) carry-forward bucket — the
 * `cf.ask` bullets that would otherwise raise CARRYFORWARD_AMBIGUOUS. When a close-out
 * runs with --carryforward-defer (the autonomous drain), each undecided bullet becomes
 * its OWN pending-approval/ stub (plan 1419: every mint rests there, uniformly with
 * carryForwardMints) instead of halting the land or being silently dropped. The whole
 * bullet IS the title (there is no `→ open new plan` marker to split on, so
 * carryForwardTitle just strips the list marker); `ready` is always false (an
 * unclassified follow-up is never auto-ready, and the flag is retired regardless — see
 * READY_HINT_RE). Same output shape as carryForwardMints so the IO shell's existing
 * minting loop files these too.
 * @param {string[]} askBullets the `ask` bucket from classifyCarryForwards
 * @returns {{title:string, mutation:'yes'|'no', ready:boolean, raw:string}[]}
 */
export function ambiguousCarryForwardMints(askBullets) {
  return (askBullets || []).map((b) => ({
    title: carryForwardTitle(b),
    mutation: SEED_HINT_RE.test(b) ? 'yes' : 'no',
    ready: false,
    raw: b,
  }));
}

// plan 665 G2: the HTML-comment marker the spine writes into every carry-forward stub
// body (`<!-- carry-forward-of: <parentSlug> -->`). Exported so the writer
// (spineCarryForwardBody) and the reader (carryForwardAlreadyFiled) share ONE token.
export const CARRY_FORWARD_MARKER = 'carry-forward-of';

// plan 665 G2: idempotency for the spine's carry-forward mint. A close-out interrupted
// AFTER the merge+archive push but BEFORE/DURING the mint (e.g. a coordWrite foreign-dirt
// refusal at `next-plan-id claim`) re-runs the WHOLE close-out — the plan-651 already-landed
// short-circuit still reaches closeOut → mintCarryForwards, which is correct (an interrupted-
// before-mint close-out MUST still file its unfiled carry-forwards). Without a per-item
// "already filed?" check, though, every such re-run would mint a DUPLICATE plan. Each minted
// stub carries a `<!-- carry-forward-of: <parentSlug> -->` marker; this detects it and skips.
// The (parentSlug, itemSlug) pair is the key — itemSlug alone could collide across parents
// (two parents with a same-named follow-up). Distinguishes "mint done" (marker present) from
// "mint not done" (absent), so a resumed close-out files exactly the un-minted remainder.
// Pure: `files` = `git ls-files docs/superpowers/plans` lines (any status folder, incl.
// archive/ — an already-archived stub still counts as filed); `readBody(relPath)` reads one.
export function carryForwardAlreadyFiled({ files, readBody, parentSlug, itemSlug }) {
  const esc = escapeRegex(String(itemSlug));
  const rx = new RegExp(`-Other-${esc}\\.md$`); // minted filename: <id>-Other-<itemSlug>.md
  const marker = `${CARRY_FORWARD_MARKER}: ${parentSlug}`;
  for (const f of files || []) {
    const rel = String(f).trim();
    if (!rel || !rx.test(rel)) continue; // basename doesn't match this carry-forward's slug
    let body;
    try {
      body = readBody(rel);
    } catch {
      continue; // unreadable candidate → not a confirmed match, never crash the mint
    }
    if (body.includes(marker)) return true;
  }
  return false;
}

// Reverse-blocker promotion keys on the SHARED Blocked-by matcher (plan 569).
// The prior NAMED_BLOCKER_RE matched a `Blocked-by-plan:` token + the blocker's full
// FILENAME — neither of which any real plan writes (canonical token is `**Blocked-by:**`,
// blockers are named by bare id), so the auto-promoter never fired (plan 484, 2026-06-13).
// `classifyBlocked` is re-exported here so done-worktree.mjs reaches it as `L.classifyBlocked`.
export { classifyBlocked } from './blocked-by-lib.mjs';

// ── plan 692: the close-safety banner ────────────────────────────────
// The LAST stdout line of EVERY spine exit (success, seam, gateProbe abort, crash),
// so the operator — piloting ~7 parallel sessions — gets an unmistakable 🟢/🔴 "can I
// close this session?" verdict without parsing the report or the HANDOFF JSON. Pure
// (the local HH:MM + queue position are injected by the caller) so the wording is
// unit-locked. Operator-specified format (2026-06-16): 🟢 "Safe to close" on a clean
// land; 🔴 "<very short why> · HH:MM" on any pause — the reason alone is the signal,
// with the FIFO position folded in when waiting in the landing queue.

// A terse, operator-facing "why" for each seam — the red-light reason. QUEUE_WAIT
// carries the FIFO position when known (state.queuePosition); 'CRASH' is the uncaught
// top-level throw. The default returns the raw code so a future seam degrades to
// something readable rather than blank.
// `cause` (plan 4006 review round 3 fix, findings eefaf0/4f690c) is OPTIONAL and defaults to
// undefined, so every existing 2-arg call/test stays byte-identical when it is omitted — it exists
// only so PYTEST_STARVED/BATTERY_STARVED (below) can pick the wording that matches the SAME
// starvedCause the long seam builders (pytestStarvedSeamMessage/batteryStarvedSeamMessage) already
// take. Passed in explicitly by the caller (doNotCloseBanner) rather than read off `state` here —
// this file's functions are pure/total by contract, so the ONE existing exception (QUEUE_WAIT's own
// `state.queuePosition` read below, pre-existing and untouched) does not extend to a new field.
export function seamShortReason(code, state = {}, cause) {
  switch (code) {
    case SEAM.QUEUE_WAIT:
      return state.queuePosition
        ? `Waiting in queue (position ${state.queuePosition})`
        : 'Waiting in queue';
    case SEAM.REVIEW_NEEDED:
      return 'Needs code review';
    case SEAM.BUILD_FAILED:
      return 'Build failed';
    case SEAM.MOBILE_FAILED:
      return 'Mobile gate failed';
    case SEAM.PYTEST_FAILED:
      return 'backend/scripts pytest suite failed';
    case SEAM.PYTEST_STARVED:
      // plan 3954 T2: deliberately NOT "failed" — a starved run never ran the code under test,
      // distinct wording from PYTEST_FAILED right above so the 🔴 banner never misreads a
      // memory-starved box as a code regression.
      // plan 4006 review round 3 fix (eefaf0): cause-aware — 'queue' (the NEW branch: this run
      // was never admitted to the shared heavy-test queue) gets queue wording; every other cause
      // (including the omitted-cause default every pre-existing caller/test still uses) keeps the
      // ORIGINAL memory/headroom text verbatim — that was, and remains, the only cause this seam
      // could carry before this plan.
      if (cause === 'queue') {
        return 'pytest starved for a queue slot — re-invoke when the shared queue is free';
      }
      return 'pytest starved for memory — re-invoke when the box has headroom';
    case SEAM.PYTEST_DIRTIED_TREE:
      // plan 4086: deliberately NOT "failed" — the suite may well have gone GREEN; what stops the
      // land is that a test wrote into a path git tracks. Distinct wording from PYTEST_FAILED
      // above so the 🔴 banner never sends an operator hunting a test failure that does not exist,
      // and it names the remedy's SHAPE (fix the isolation) rather than the file, because
      // restoring the file alone leaves the leak in place for the next land.
      return 'a pytest test wrote into the tracked tree — fix its isolation, then restore the file';
    case SEAM.BATTERY_FAILED:
      return 'scripts battery failed';
    case SEAM.BATTERY_STARVED:
      // plan 4006 review round 1: deliberately NOT "failed" — same reasoning as PYTEST_STARVED
      // above, distinct wording from BATTERY_FAILED so the 🔴 banner never misreads a queue-
      // starved run as a code regression.
      // plan 4006 review round 3 fix (4f690c): cause-aware — 'spawn' (the NEW branch: a Windows
      // spawn-init NTSTATUS signature, the box was out of memory) gets memory/headroom wording;
      // every other cause (including the omitted-cause default every pre-existing caller/test
      // still uses) keeps the ORIGINAL queue-slot text verbatim — that was, and remains, the only
      // cause this seam could carry before this plan.
      if (cause === 'spawn') {
        return 'scripts battery starved for memory — re-invoke when the box has headroom';
      }
      return 'scripts battery starved for a queue slot — re-invoke when the queue is free';
    case SEAM.PYTEST_CHUNKED:
      // plan 3274: deliberately NOT "failed" — a chunk-cap halt is partial progress, distinct
      // wording from PYTEST_FAILED right above so the 🔴 banner itself never misreads as a gate
      // failure.
      return 'pytest chunk-capped mid-run — re-invoke to continue';
    case SEAM.BATTERY_CHUNKED:
      return 'scripts battery chunk-capped mid-run — re-invoke to continue';
    // plan 3436 D1: the pre-gate pair, worded like the two rows above and deliberately NOT like
    // BUILD_FAILED / MOBILE_FAILED — the whole point of these seams is that the 🔴 banner does not
    // read as a gate regression.
    case SEAM.BUILD_CHUNKED:
      return 'production build chunk-capped — re-invoke to continue';
    case SEAM.MOBILE_CHUNKED:
      return 'WebKit mobile gate chunk-capped — re-invoke to continue';
    // plan 3453: same family, same "re-invoke to continue" promise — the wait itself made no
    // judgment about the holder, it simply ran out of this invocation's own chunk budget.
    case SEAM.HEAD_LOCK_CHUNKED:
      return 'head-time worktree-lock wait chunk-capped — re-invoke to continue';
    case SEAM.GATE_NON_CONVERGENT:
      // plan 3374: the 🔴 banner must NOT end in "re-invoke to continue" like the two CHUNKED rows
      // right above — that is the exact promise this seam exists to withdraw. One phrase for both
      // heavy gates (the seam is gate-agnostic, decision D4); which gate and which file are in the
      // seam's own message, not the banner.
      return 'heavy gate cannot converge in one chunk wall — needs a fix commit';
    case SEAM.STATUS_FLIP:
      return 'Status flip needs rationale';
    case SEAM.CONCLUSION_REVIEW:
      return 'World-claim flip needs an adversarial conclusion review';
    case SEAM.MONOLITH_RESURRECTED:
      return 'Resurrected seed monolith in the diff';
    case SEAM.WIKI_CHECKPOINT:
      return 'Wiki growth checkpoint';
    case SEAM.PRICE_GATE_FAILED:
      return 'Price trust-gate failed';
    case SEAM.FINDINGS_OPEN:
      return 'Review findings need a plan/fix/wave';
    case SEAM.DEPLOY_FAILED:
      return 'Deploy failed';
    case SEAM.DEPLOY_GATE_FAILED:
      return 'Pre-deploy gate failed (full battery/build/mobile)';
    case SEAM.REBASE_CONFLICT:
      return 'Rebase conflict';
    case SEAM.REBASE_UGLY:
      return 'Rebase too divergent';
    case SEAM.LAND_BLOCKED:
      return 'Land blocked';
    case SEAM.LAND_BLOCKED_HOLDING:
      // plan 1239: cause-agnostic — this seam now fires for BOTH a pre-land rebase conflict AND an
      // ephemeral merge-to-master conflict, so the terse 🔴 banner must not point only at "rebase".
      return 'Land conflict (rebase/merge) — holding the slot';
    case SEAM.LAND_BLOCKED_REQUEUED:
      // plan 1528: the opposite of HOLDING — the head slot was released to the tail.
      return 'Heavy rework — requeued to tail, finish rework during the wait';
    case SEAM.PRETTIER_DRIFT:
      return 'Prettier drift after rebase — write + re-record';
    case SEAM.CARRYFORWARD_AMBIGUOUS:
      return 'Needs carry-forward decision';
    case SEAM.PROMOTE_AMBIGUOUS:
      return 'Needs promote decision';
    case SEAM.PREFLIGHT_FAIL:
      return 'Preflight failed';
    case SEAM.COORD_CONTENTION:
      return 'Coordination contention';
    case SEAM.ARCHIVE_UNRESOLVED:
      return 'Plan file not found — cannot archive';
    case SEAM.SEED_BASE_UNRESOLVED:
      return 'Seed merge-base unresolved — seed gates cannot run blind';
    case SEAM.DISK_HEADROOM_LOW:
      return 'Disk headroom below floor after prune — free space before the build';
    case 'CRASH':
      return 'Crashed — land incomplete';
    default:
      return code || 'Paused';
  }
}

// 🟢 the clean-land banner (exit 0). A teardown that left residue is STILL safe to
// close — the land is on origin/master; the leftover (a residual worktree dir, an
// un-deleted branch, a flaky claim-release) is best-effort hand-cleanup, not a reason
// to keep the session open — but say so. hhmm = local HH:MM at emit time. The note is
// kept generic because teardownErrors covers several step kinds, not only dir removal.
export function safeToCloseBanner(state = {}, hhmm = '') {
  const residue =
    state.teardownErrors && state.teardownErrors.length
      ? ' — teardown incomplete, see notes above'
      : '';
  return `🟢 Safe to close${residue}${hhmm ? ` · ${hhmm}` : ''}`;
}

// 🔴 the paused/seam banner. The reason alone is the signal (operator directive
// 2026-06-16); the queue position rides in for QUEUE_WAIT via seamShortReason.
export function doNotCloseBanner(code, state = {}, hhmm = '') {
  // plan 4006 review round 3 fix (eefaf0/4f690c): the starved cause lives on `state` under a
  // seam-specific field name (done-worktree.mjs stamps `state.pytestStarvedCause` /
  // `state.batteryStarvedCause` when it classifies the starvation) — extracted HERE, at the
  // caller, and handed to seamShortReason as an explicit `cause` argument rather than having that
  // pure/total function reach into `state` itself for a field only two of its many seams have.
  const cause =
    code === SEAM.PYTEST_STARVED
      ? state.pytestStarvedCause
      : code === SEAM.BATTERY_STARVED
        ? state.batteryStarvedCause
        : undefined;
  return `🔴 ${seamShortReason(code, state, cause)}${hhmm ? ` · ${hhmm}` : ''}`;
}

// ── Report (the SKILL.md step-12 block + a Lane line) ─────────────────
/** @param {object} s rolled-up run state */
export function formatReport(s) {
  const m = s.memory || { moved: 0, dup: 0, diverged: 0 };
  const lines = [
    `Closed from host: ${s.host}`,
    `Merged: ${s.branch} → master at ${s.mergeSha}`,
    `Lane: ${s.lane === 'seed' ? 'seed (LANDING mutex)' : 'free (no LANDING mutex)'}`,
    `Live: ${s.deployStatus ?? 'skipped'}`,
  ];
  // plan 1364 Ship 3: a batch land archives N members in one close-out, not one plan — report
  // each member's disposition (archived / already-archived / reparked-skipped) instead of the
  // single-plan `Plan archived: <base> → archive/` line. The single-plan branch below is
  // BYTE-FOR-BYTE the original line — batch reporting is a purely additive alternative.
  if (s.batch) {
    const members = (s.batch.manifest && s.batch.manifest.members) || [];
    const disp = (s.batch.dispositions || []).map((d) => `${d.id}:${d.disposition}`).join(', ');
    lines.push(`Batch ${s.slug}: ${members.length} member(s) — ${disp || 'none'}`);
  } else if (s.heartbeatReparked) {
    // plan 1329: a heartbeat plan is re-filed to waiting-date/ for its next run, NOT archived —
    // report it as such so the operator's post-land skim isn't misled into a false "archived".
    lines.push(`Plan re-filed (heartbeat): ${s.heartbeatReparked} → waiting-date/`);
  } else {
    lines.push(`Plan archived: ${s.planArchived} → archive/`);
  }
  if (s.promoted && s.promoted.length) {
    lines.push(`Promoted from waiting-blocked/: ${s.promoted.join(', ')}`);
  }
  // plan 3975: an unblocked plan (every named plan-blocker archived-and-shipped) never
  // sleeps back in waiting-blocked/ any more — it lands in ready/ (the block above),
  // pending-approval/ (not yet specced), or waiting-operator/ (specced but a ready/
  // gate failed). These two headings replace the three retired park-advisory state
  // keys this plan removed, which only ever reported a plan left parked where it
  // already was.
  if (s.promotedToPending && s.promotedToPending.length) {
    lines.push(
      `Unblocked → pending-approval/ (not yet specced; awaiting a spec-pass): ` +
        `${s.promotedToPending.join(', ')}`,
    );
  }
  if (s.promotedToOperator && s.promotedToOperator.length) {
    lines.push(
      `Unblocked → waiting-operator/ (specced, but a ready/ gate failed): ` +
        `${s.promotedToOperator.join(', ')}`,
    );
  }
  // plan 1419: every mint rests in pending-approval/ now, so name the resting folder
  // on each minted-plan line rather than leaving the operator to assume ready/.
  lines.push(
    `New plans opened: ${
      s.newPlans && s.newPlans.length
        ? s.newPlans.map((p) => `${p} (pending-approval/)`).join(', ')
        : 'none'
    }`,
  );
  // plan 1419: the `(ready)` bullet flag is retired — it no longer branches the mint
  // destination, but a legacy author still writing it deserves a heads-up rather than
  // a silent no-op, so name each title that carried the token.
  if (s.legacyReadyMints && s.legacyReadyMints.length) {
    lines.push(
      `(ready) is retired — stub rests in pending-approval/: ${s.legacyReadyMints.join(', ')}`,
    );
  }
  // plan 406: a carry-forward `→ open new plan` bullet that FAILED to mint must be
  // surfaced, not swallowed — otherwise a flaky claim/move-plan re-introduces the
  // exact silent-drop this minting set out to fix. Name the bullet + error so the
  // operator can mint it by hand from the (still-intact) handoff entry.
  if (s.mintErrors && s.mintErrors.length) {
    lines.push(`Carry-forward mint FAILED (open these by hand from the handoff entry):`);
    for (const e of s.mintErrors) lines.push(`  - ${e}`);
  }
  lines.push(`Killed: ${s.killed || 0} processes`);
  lines.push(
    `Memory reclaimed: ${m.moved} moved, ${m.dup} dup deleted, ${m.diverged} diverged left for review`,
  );
  // Honest teardown line (plan 338): teardown is best-effort, so never claim a
  // clean removal when tryStep recorded failures. On Windows a locked / long-path
  // node_modules can survive both `git worktree remove --force` and rmdir, leaving
  // the dir + local branch behind — say so, and name what to clean up by hand.
  if (s.teardownErrors && s.teardownErrors.length) {
    lines.push(`Teardown INCOMPLETE (best-effort) — clean up by hand:`);
    for (const e of s.teardownErrors) lines.push(`  - ${e}`);
    if (s.wtPath) lines.push(`  Residual worktree dir: ${s.wtPath}`);
  } else {
    lines.push(`Removed: worktree dir, local branch, remote branch`);
  }
  lines.push(`/state delta: active-worktree row for ${s.slug} removed`);
  // plan 692: the 🟢 close-safety banner is the LAST line — the operator's
  // "this session is done, nothing left to do" verdict (s.bannerTime = local HH:MM).
  lines.push(safeToCloseBanner(s, s.bannerTime));
  return lines.join('\n');
}

// ── Worktree resolution (plan 355) ───────────────────────────────────
// Parse `git worktree list --porcelain` and find the worktree for `slug`.
// Resolve by BRANCH NAME first (refs/heads/worktree-<slug>), so a hobby-root
// sibling like ../vetapp-land351 — whose PATH does NOT end in /<slug> — is still
// found and torn down. Fall back to the legacy path-ends-with-/<slug> match for
// the canonical .claude/worktrees/<slug> location and any detached/odd cases.
// Returns { wtPath, branch } or null (the caller throws a friendly error).
/**
 * @param {string} porcelain  output of `git worktree list --porcelain`
 * @param {string} slug       plan slug (branch is `worktree-<slug>`)
 */
// plan 2654 review [14]: both this and detachedWorktreeCandidate are called on the SAME porcelain
// text on the detached path, so accept already-parsed entries and parse at most once per caller.
function asEntries(porcelainOrEntries) {
  return Array.isArray(porcelainOrEntries)
    ? porcelainOrEntries
    : parseWorktreePorcelain(porcelainOrEntries);
}

export function resolveWorktreeFromPorcelain(porcelain, slug) {
  const entries = asEntries(porcelain);
  // 1. branch name match — location-independent (handles hobby-root siblings)
  for (const { path, branch, head } of entries) {
    if (path && branch === `worktree-${slug}`) {
      return { wtPath: path, branch, detached: false, head: head ?? null };
    }
  }
  // 2. legacy fallback — path ends with /<slug>
  // plan 2654: `detached` is now CARRIED OUT of here rather than dropped. parseWorktreePorcelain
  // has always parsed it; this function used to discard it, so a detached worktree came back as
  // `{ branch: null }` and every caller proceeded as if it had a branch.
  for (const { path, branch, head, detached } of entries) {
    if (path && path.replace(/\\/g, '/').endsWith(`/${slug}`)) {
      return { wtPath: path, branch, detached: Boolean(detached), head: head ?? null };
    }
  }
  return null;
}

// plan 2654: find a DETACHED worktree that PLAUSIBLY belongs to `slug`, for the diagnostic ONLY.
//
// Why a separate, looser matcher is needed: neither resolution key above can find a detached
// worktree whose slug is long. Key 1 needs `branch === worktree-<slug>`, and a detached entry has
// no branch line at all; key 2 needs the dir to end in `/<slug>`, but cut-worktree TRUNCATES the
// dir basename to 40 chars (plan 909 MAX_PATH headroom) for exactly the slugs long enough to be
// truncated. So for any slug >40 chars, a detached worktree resolves to NOTHING and the spine
// died on the bare `not found in git worktree list` — the observed plan-2644 wedge, where the
// worktree was sitting right there, just unattached.
//
// The truncation relation is `basename === slug.slice(0, 40)` (plus a trailing-separator trim), so
// an EXACT basename match and a strict-PREFIX match are the two shapes to accept. That is LOOSER
// than resolution uses (two slugs sharing a 40-char prefix both match), which is why this is wired
// only into the error message and never into a resolved return value.
//
// plan 2654 review [7] + [12]: the min-length rule applies ONLY to the strict-prefix arm. Applying
// it to every match silently defeated the whole diagnostic for genuinely short slugs (a 5-char slug
// whose dir is not truncated at all), which is the opposite of the intent — an EXACT basename match
// is unambiguous at any length and needs no floor. That also makes the equality test load-bearing
// rather than the redundant `slug === basename ||` it was (a string always starts with itself).
const MIN_DETACHED_PREFIX = 8;
// plan 2654 review [3]: return ALL matches, not the first in porcelain order. Naming one arbitrary
// worktree in operator-facing recovery text is worse than naming none: the operator runs the
// printed `git -C <path> checkout …` against an UNRELATED plan's worktree and corrupts it. The
// caller renders every match when there is more than one and asks the operator to pick.
export function detachedWorktreeCandidates(porcelainOrEntries, slug) {
  const out = [];
  for (const { path, head, detached } of asEntries(porcelainOrEntries)) {
    if (!path || !detached) continue;
    const basename = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || '';
    if (!basename) continue;
    const exact = basename === slug;
    const prefix = !exact && slug.startsWith(basename) && basename.length >= MIN_DETACHED_PREFIX;
    if (exact || prefix) out.push({ wtPath: path, head: head ?? null, exact });
  }
  // An exact match is strictly stronger evidence than a truncation-prefix guess; when both kinds
  // are present the exact one is the answer and the prefix guesses are noise.
  const exacts = out.filter((c) => c.exact);
  return exacts.length > 0 ? exacts : out;
}

// Single-candidate convenience: the unambiguous case, or null when there is no match OR the match
// is ambiguous (callers that must not name a path use this and fall back to the plural form).
export function detachedWorktreeCandidate(porcelainOrEntries, slug) {
  const all = detachedWorktreeCandidates(porcelainOrEntries, slug);
  return all.length === 1 ? all[0] : null;
}

// plan 2654 review [10]: the WHY clause and the RECOVERY clause are shared by every
// attachment refusal below, so they live here exactly once. They were duplicated (near-identically,
// which is worse than exactly) across the resolve-time message and the seam message, and any future
// edit would have drifted one from the other.
function cwdScopedWhy(branch) {
  return (
    `Every rebase/merge the spine runs is cwd-scoped and moves whatever HEAD is, so on an ` +
    `unattached tree it advances the wrong commit while refs/heads/${branch} stays put, and the ` +
    `force-with-lease push then republishes that stale unchanged branch ref (plan 2654).`
  );
}
function reattachRecovery(wtPath, branch) {
  return (
    `\`git -C "${wtPath}" status\` to confirm the tree is clean, then ` +
    `\`git -C "${wtPath}" checkout ${branch}\``
  );
}
const strandedAt = (head) => (head ? ` (stranded at ${String(head).slice(0, 9)})` : '');

// plan 2654: the one detached-worktree diagnostic, for the RESOLVE-time refusal. Pure so it is
// testable without a real repo. Shape follows the house convention (what/why — what it means for
// state — how to fix).
export function detachedWorktreeMessage({ slug, wtPath, head }) {
  const branch = `worktree-${slug}`;
  return (
    `worktree for slug "${slug}" is on a DETACHED HEAD${strandedAt(head)}, not on branch ` +
    `"${branch}" — refusing to act on it. ${cwdScopedWhy(branch)} ` +
    `Recover: ${reattachRecovery(wtPath, branch)}, then re-invoke done-worktree.`
  );
}

// plan 2654 review [3]: the AMBIGUOUS variant. More than one detached worktree prefix-matches this
// slug, so naming one would send the operator to fix the wrong plan's tree. List them all and let
// them choose; the refusal itself is identical either way.
export function ambiguousDetachedWorktreeMessage({ slug, candidates }) {
  const branch = `worktree-${slug}`;
  const list = candidates.map((c) => `"${c.wtPath}"${strandedAt(c.head)}`).join(', ');
  return (
    `worktree for slug "${slug}" is not attached to "${branch}", and ${candidates.length} ` +
    `DETACHED worktrees match its truncated directory prefix — refusing to act, and deliberately ` +
    `NOT guessing which one is yours. ${cwdScopedWhy(branch)} Candidates: ${list}. Identify the ` +
    `right one (\`git -C "<path>" log --oneline -1\`), re-attach it with ` +
    `\`git -C "<path>" checkout ${branch}\`, then re-invoke done-worktree.`
  );
}

// plan 2654: the ONE attachment seam. Returns null when HEAD is attached to exactly
// `refs/heads/<branch>`, else a { code, message } the caller refuses on. `action` names what is
// being refused so one function serves both the prep and the head-time land (review [1]).
//
// A single `git symbolic-ref -q HEAD` comparison covers BOTH failure shapes at once: detached
// (rc=1 ⇒ headRef null) and attached-to-the-wrong-branch. It also implies the sha check the plan
// asked for — if HEAD symbolically IS refs/heads/<branch>, then `rev-parse HEAD` and
// `rev-parse refs/heads/<branch>` cannot differ, so no second comparison is needed.
export function worktreeAttachmentSeam({ headRef, branch, slug, wtPath, action = 'prep' }) {
  if (headRef === `refs/heads/${branch}`) return null;
  const what =
    headRef === null
      ? 'a DETACHED HEAD'
      : `branch "${String(headRef).replace(/^refs\/heads\//, '')}"`;
  const consequence =
    action === 'land'
      ? `A rebase here would advance ${what} while refs/heads/${branch} stayed put, and the ` +
        `force-push would republish the STALE branch tip — so the land would merge a tree that ` +
        `is not what this branch's recorded review covers. This is the land, not a speculative ` +
        `prep: it publishes, so it refuses instead of guessing.`
      : `A rebase here would advance ${what} while refs/heads/${branch} stayed put, and the ` +
        `land-prep marker would then stamp that wrong tip as "branch" — a land could merge ` +
        `without the commits a sha-pinned review marker says it reviewed. A prep is speculative, ` +
        `so aborting costs nothing.`;
  const tail =
    action === 'land'
      ? `; then re-invoke done-worktree.`
      : `; the next keep-hot poll preps it normally.`;
  return {
    code: headRef === null ? 'DETACHED' : 'WRONG_BRANCH',
    message:
      `done-worktree ${action === 'land' ? '(land)' : '--prep'}: ${slug}'s worktree is on ` +
      `${what}, not "${branch}" — REFUSING without moving HEAD or stamping anything. ` +
      `${consequence} Recover: ${reattachRecovery(wtPath, branch)}${tail}`,
  };
}

// plan 985: cut-worktree (plan 958) stamps an untracked `.owner` marker at the worktree
// root for the worktree-owner-guard hook. The main repo's `.claude/worktrees/` gitignore
// does NOT cover it from INSIDE the linked worktree (ignore patterns match relative to the
// worktree root, where `.owner` sits at the top level), so `git -C <wtPath> status
// --porcelain` reports a lone `?? .owner` and the preflight clean-check would PREFLIGHT_FAIL
// EVERY cut-worktree land. cut-worktree now also adds `.owner` to the worktree's exclude, so
// new worktrees are clean — but worktrees created before that fix won't be, hence this
// backstop: drop exactly the `?? .owner` line from the porcelain dirty list. ANY other
// untracked or modified path still remains (real uncommitted work must still block the land).
// Returns the meaningful porcelain lines (empty array ⇒ worktree is clean).
export function filterPreflightDirty(porcelain) {
  return (porcelain || '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() && l.trim() !== '?? .owner');
}

// ── plan 2697: run the land spine from MAIN, never a worktree's stale copy ───────────
// THE BUG THIS FIXES. `node scripts/done-worktree.mjs <slug>` is normally self-invoked from
// inside `.claude/worktrees/<slug>` (pickup-plan step 7 cd's the session there), so Node loads
// the spine from THAT checkout — whatever commit the branch happened to be cut from. main()
// then `process.chdir(MAIN)`, which correctly routes every CHILD `scripts/…` spawn at MAIN's
// copy, but the already-loaded parent keeps running the worktree's version for the whole land.
//
// Consequence: a safety fix to the spine stays INERT until every in-flight worktree
// independently rebases past it. That is exactly how plan 2401's store-tear fix could be landed,
// verified, and still recur — the 2026-08-01T12:58:16Z tear came from plan 320's worktree, cut
// 2026-08-01T10:35:51Z, 47 minutes BEFORE the fix merged at 11:22:31Z (plan 2697's evidence
// pass). At that moment NINE live worktrees still carried the pre-fix spine.
//
// So: re-exec MAIN's copy whenever the running spine differs from it. Deliberately content-keyed,
// not mtime/commit-keyed: identical bytes need no re-exec, and byte equality is the exact property
// that matters here.
//
// "DIFFERS" IS THE RULE, NOT "MAIN IS NEWER" — and that is deliberate (gpt-review 868bee). The
// two copies are not symmetric: MAIN sits on `master`, which this repo only ever FAST-FORWARDS to
// origin/master, so MAIN's spine is by construction LANDED code. A worktree's copy is whatever
// its branch carries, which may include the branch's own unlanded edits to the spine itself. For
// an operation as shared as a land, "run the landed spine, not an in-flight one" is the property
// worth having, and it is strictly stronger than a freshness comparison could be. The one case
// where a plan legitimately needs its OWN spine logic — `--prep`, which stamps a gate-pass marker
// the queue head trusts — is excluded at the call site rather than weakened here.
export const SPINE_REEXEC_ENV = 'DONE_WORKTREE_SPINE_REEXEC';

/** Windows path compare: `/` and `\` are the same separator and the drive letter's case is not
 * meaningful, so normalise both before comparing. POSIX compares verbatim. */
export function samePathForPlatform(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const norm = (p) => {
    // Separator folding is win32-ONLY: on POSIX a backslash is a legal filename character, so
    // rewriting it there would make `/a/b\c` and `/a/b/c` compare equal — two different files
    // (gpt-review bdc385).
    const s = platform === 'win32' ? String(p).split('\\').join('/').toLowerCase() : String(p);
    return s.replace(/\/+$/, '');
  };
  return norm(a) === norm(b);
}

/**
 * Decide whether this process should hand the land over to MAIN's copy of the spine.
 *
 * Every "don't" case is a deliberate no-op rather than a refusal: this guard must never be able
 * to BLOCK a land — the worst it may do is let a land run the copy it would have run anyway.
 *
 * @param {object} o
 * @param {string} o.runningFile absolute path of the spine file this process loaded
 * @param {string} o.mainFile absolute path of `<MAIN>/scripts/done-worktree.mjs`
 * @param {string|null} o.runningSha content hash of runningFile (null = unreadable)
 * @param {string|null} o.mainSha content hash of mainFile (null = missing/unreadable)
 * @param {boolean} o.alreadyReexeced the re-exec env latch is set (we ARE the child)
 * @param {NodeJS.Platform} [o.platform]
 * @returns {{reexec: boolean, reason: string}}
 */
export function spineReexecDecision({
  runningFile,
  mainFile,
  runningSha,
  mainSha,
  alreadyReexeced,
  platform = process.platform,
}) {
  if (alreadyReexeced) return { reexec: false, reason: 'already re-execed once (latch set)' };
  if (samePathForPlatform(runningFile, mainFile, platform))
    return { reexec: false, reason: "already running MAIN's copy" };
  if (!mainSha) return { reexec: false, reason: 'MAIN copy missing or unreadable' };
  // An unreadable RUNNING closure is the one "unknown" that must resolve toward the handoff, not
  // away from it: we cannot show this process is current, and MAIN's copy is landed code by
  // construction. Skipping here would fail OPEN into the stale-spine execution this guard exists
  // to prevent (gpt-review round 2).
  if (!runningSha)
    return { reexec: true, reason: "running spine unreadable, deferring to MAIN's landed copy" };
  if (runningSha === mainSha) return { reexec: false, reason: "byte-identical to MAIN's copy" };
  return {
    reexec: true,
    reason:
      `spine copy differs from MAIN's (${runningSha.slice(0, 12)} vs ` +
      `${mainSha.slice(0, 12)}). Running MAIN's, so land-spine fixes take effect immediately ` +
      `instead of waiting for this worktree to rebase (plan 2697).`,
  };
}

// ── plan 3375: resumable close-out ───────────────────────────────────────────────────────
// A cloud land is killed by the platform 75–100 s into a FOREGROUND `done-worktree <slug>`
// call (measured 4-for-4 over 11 hours, 2026-08-21/22). The MERGE half always completed —
// every one of those four plans is archived on origin/master — but the CLOSE-OUT TAIL did
// not, leaving orphan `worktree-*` branches on origin and a plan that reads mid-flight.
//
// The spine has ALWAYS been idempotent on re-invoke (isBranchAlreadyLanded → skip every
// pre-merge gate → closeOut + teardown). What it could NOT survive is the death of the
// SESSION: a fresh session has a fresh clone, no plan worktree, and no in-memory state, and
// `done-worktree <slug>` wants a worktree to stand in. So the missing piece is an entry
// point that reads WHERE the dead land stopped purely from ORIGIN state and finishes each
// remaining step idempotently — which is what `--finish-close-out` is.
//
// This half is the PURE decision layer: what can be proven, what is refused, and what is
// left to do. Every fact it consumes is gathered by gatherCloseOutFacts (done-worktree.mjs);
// nothing here touches git, so all four kill boundaries are directly testable.

// The residues a dead close-out can leave, in the order --finish-close-out clears them. The
// order is the spine's own close-out order for the first three; the last three are teardown,
// where it deliberately does NOT mirror teardown()'s internal sequence (which removes the
// worktree dir at step 3 and deletes the branch at step 4). A resume seam that assumed ANY
// ordering would mis-handle a kill landing between two steps it thinks are adjacent, so each
// residue is detected and cleared INDEPENDENTLY — strictly more robust than replaying a
// sequence, and the reason the four acceptance boundaries all converge.
export const CLOSE_OUT_RESIDUE_ORDER = [
  'archive', // plan file still in a live status folder at origin/master (+ its board row)
  'queue', // the plan-504 FIFO landing-queue entry still holds a slot
  'claim', // refs/claims/<id> still held on origin
  'branch-remote', // origin still carries worktree-<slug>
  'branch-local', // this checkout still carries the local branch ref
  'worktree-dir', // .claude/worktrees/<dir> still on disk
];

// Named refusal reasons — fail-closed against tearing down a land that is NOT provably done.
export const FINISH_REFUSAL = {
  BATCH_SLUG: 'batch-slug-unsupported',
  NO_PLAN_ID: 'no-plan-id',
  PLAN_NOT_FOUND: 'plan-not-found-at-origin',
  SLUG_MISMATCH: 'slug-does-not-match-plan-file',
  ORIGIN_UNREADABLE: 'origin-unreadable',
  BRANCH_NOT_MERGED: 'branch-not-merged',
  UNPROVEN: 'land-unproven',
};

/**
 * Decide what a killed close-out still owes, from origin-only facts.
 *
 * The proof obligation is the whole safety story: this seam DELETES branches and RELEASES a
 * claim, so it must never run against a land that did not actually merge. Two independent
 * provers, either of which is sufficient:
 *
 *   - `branch-merged` — `origin/worktree-<slug>` exists AND is an ancestor of origin/master.
 *     Covers a kill BEFORE the archive commit, when the plan still reads in-progress/.
 *   - `plan-archived` — the plan file sits under `docs/superpowers/plans/archive/` at
 *     origin/master. Covers a kill AFTER the branch was already deleted, when the first
 *     prover has nothing left to look at. The archive commit is pushed only after the merge
 *     reached origin, so an archived plan is itself proof the merge landed.
 *
 * Everything else refuses by NAME. In particular a branch that is present on origin but NOT
 * an ancestor of master is refused outright rather than "unproven": that is the shape of a
 * LIVE land (or a diverged branch), and tearing it down would destroy work — so it is a
 * distinct, louder refusal than the merely-unprovable case.
 *
 * A heartbeat plan (frontmatter `heartbeat: <days>`) re-files to waiting-date/ rather than
 * archiving, so `waiting-date/` is ITS terminal folder and the plan-file prover reads it as
 * such — but only for a plan whose frontmatter actually says so (`planHeartbeat`), never for
 * an ordinary plan merely parked there.
 *
 * @param {object} facts see gatherCloseOutFacts
 * @returns {{proven: boolean, landedVia: string|null, refusal: string|null,
 *            refusalReason: string|null, residues: string[], alreadyClosed: boolean}}
 */
export function planFinishCloseOut(facts) {
  const f = facts || {};
  const slug = f.slug || '<slug>';
  const refuse = (refusal, refusalReason) => ({
    proven: false,
    landedVia: null,
    refusal,
    refusalReason,
    residues: [],
    alreadyClosed: false,
  });

  // A batch train's slug owns N member plans, N claim refs and one manifest; its close-out
  // is closeOutBatch, not closeOutSingle. Resuming that from origin state alone would have to
  // re-derive the member set from a manifest the archive commit has usually already deleted —
  // exactly the plan-1384 hazard verifyCloseOutOnOrigin fails closed on. Out of scope here:
  // refuse by name and point at the batch recovery path rather than guess a member set.
  if (f.isBatch) {
    return refuse(
      FINISH_REFUSAL.BATCH_SLUG,
      `"${slug}" is a BATCH slug — its close-out spans N member plans, N claim refs and a ` +
        `manifest, which cannot be re-derived from origin state once the archive commit ` +
        `deleted the manifest. Recover a batch land with a bare re-invoke of ` +
        `done-worktree.mjs ${slug} from a checkout that still has the worktree (it is ` +
        `idempotent by manifest presence), or by the per-member checklist in ` +
        `docs/runbooks/plans-workflow.md § Landing recovery under contention.`,
    );
  }
  if (!f.planId) {
    return refuse(
      FINISH_REFUSAL.NO_PLAN_ID,
      `cannot derive a numeric plan id from slug "${slug}" — this seam resolves the plan ` +
        `file, the claim ref and the archive proof by id, so an ad-hoc (non-plan) slug has ` +
        `no bookkeeping for it to finish. Tear such a worktree down by hand.`,
    );
  }
  // "Fetch before judging" (CLAUDE.md) is a PROOF obligation here, not a nicety: every judgment
  // below reads origin/master, and a fresh clone's remote-tracking refs are exactly as stale as
  // the last fetch left them. A failed fetch, or a remote-branch probe that could not answer, is
  // therefore refused rather than silently downgraded to "no branch" — a false "branch absent"
  // is what would let this seam report a land fully closed out while `worktree-<slug>` is still
  // sitting on origin, which is the residue the whole plan exists to remove (gpt-review).
  if (f.fetchOk === false) {
    return refuse(
      FINISH_REFUSAL.ORIGIN_UNREADABLE,
      `could not fetch origin/master — every proof this seam needs is read from origin, and ` +
        `judging "${slug}" off possibly-stale remote-tracking refs could report a land closed ` +
        `out while its branch is still on origin. Fix connectivity and re-invoke.`,
    );
  }
  if (f.branchOnOrigin == null || (f.branchOnOrigin === true && f.branchMerged == null)) {
    return refuse(
      FINISH_REFUSAL.ORIGIN_UNREADABLE,
      `could not determine whether origin carries ${f.branch || `worktree-${slug}`}` +
        `${f.branchOnOrigin === true ? ' whether its tip is an ancestor of origin/master' : ''} ` +
        `— the probe failed rather than answering. Unknown is never treated as absent or as ` +
        `merged; fix the origin read and re-invoke.`,
    );
  }
  // The plan file is the seam's anchor on BOTH provers (it carries the archive proof, and it
  // is what the archive residue moves). Not finding it at origin/master at all means we are
  // reasoning about a repo state we do not understand — never guess.
  if (!f.planFolder) {
    return refuse(
      FINISH_REFUSAL.PLAN_NOT_FOUND,
      `no plan file for id ${f.planId} anywhere under docs/superpowers/plans/ at ` +
        `origin/master. Locate the plan file before finishing this land's close-out.`,
    );
  }
  // The plan file is resolved by NUMERIC ID, which a mistyped or truncated slug still hits — and
  // this seam then releases that OTHER plan's claim ref. Require the resolved file to actually be
  // this slug's before anything mutates (gpt-review).
  if (f.planBasenameMatchesSlug !== true) {
    return refuse(
      FINISH_REFUSAL.SLUG_MISMATCH,
      `plan id ${f.planId} at origin/master resolves to "${f.planBasename || '(unknown)'}", ` +
        `which is not slug "${slug}". A truncated or mistyped slug shares the leading id with a ` +
        `DIFFERENT plan, and acting on it would release that plan's claim — refusing. An ` +
        `UNPROVEN match (the plan path could not be recovered at all) refuses the same way: an ` +
        `identity check that fails open is not a check. Pass the exact slug (the ` +
        `worktree-<slug> branch name without its prefix).`,
    );
  }
  if (f.branchOnOrigin && f.branchMerged === false) {
    return refuse(
      FINISH_REFUSAL.BRANCH_NOT_MERGED,
      `origin still carries ${f.branch || `worktree-${slug}`} and its tip is NOT an ancestor ` +
        `of origin/master — this land's merge has NOT reached master (or the branch diverged ` +
        `after it did). That is the shape of a LIVE or unfinished land, so nothing is torn ` +
        `down here. Land it normally with done-worktree.mjs ${slug}.`,
    );
  }

  // Where a COMPLETED close-out leaves this plan's file. A heartbeat plan (frontmatter
  // `heartbeat: <days>`) never archives — running it IS the deliverable — so closeOutSingle
  // re-files it to waiting-date/ instead (plan 1329). Without this the resume seam would see a
  // successfully re-filed heartbeat as "still owes the archive step" forever, re-enter the
  // close-out on every pass and never converge, reporting exit 1 on a land it had just finished
  // correctly (gpt-review).
  const terminalFolder = f.planHeartbeat ? 'waiting-date' : 'archive';
  const landedVia =
    f.branchOnOrigin === true && f.branchMerged === true
      ? 'branch-merged'
      : // The plan-file prover requires the branch's absence from origin to be PROVEN, not merely
        // unanswered: an archived plan alone does not distinguish "landed, branch torn down" from
        // "archived by a supersession move-plan that never landed anything". Pairing it with a
        // proven-absent branch is what makes it evidence about THIS land (gpt-review).
        f.branchOnOrigin === false && f.planFolder === terminalFolder
        ? 'plan-archived'
        : null;
  if (!landedVia) {
    return refuse(
      FINISH_REFUSAL.UNPROVEN,
      `cannot prove this land completed: origin carries no ${f.branch || `worktree-${slug}`} ` +
        `to test against origin/master, and plan ${f.planId} sits in ` +
        `docs/superpowers/plans/${f.planFolder}/ rather than archive/. Neither prover holds, ` +
        `so the close-out is not resumed (fail-closed — this seam deletes branches and ` +
        `releases a claim, and must never do so against a land that never merged).`,
    );
  }

  // Residues. `!== false` rather than `=== true` on the bookkeeping axes: an UNKNOWN fact
  // (the gatherer could not read the board or the queue doc) must resolve toward attempting
  // the clear, never toward "already clean" — each of those clears is itself idempotent and
  // exit-0 on a no-op, so attempting one costs nothing while skipping one strands a slot.
  const residues = [];
  if (f.planFolder !== terminalFolder || f.boardRow !== false) residues.push('archive');
  if (f.queueEntry !== false) residues.push('queue');
  if (f.claimOnOrigin !== false) residues.push('claim');
  if (f.branchOnOrigin === true) residues.push('branch-remote');
  if (f.branchLocal !== false) residues.push('branch-local');
  if (f.worktreeDirPresent !== false) residues.push('worktree-dir');

  return {
    proven: true,
    landedVia,
    refusal: null,
    refusalReason: null,
    residues,
    alreadyClosed: residues.length === 0,
  };
}

/**
 * One-line-per-residue operator report. Pure so the exact wording is asserted in tests
 * rather than eyeballed in a transcript.
 */
export function formatFinishCloseOutReport(slug, plan, outcomes = {}) {
  if (!plan.proven)
    return `done-worktree: REFUSED --finish-close-out for "${slug}" — ${plan.refusalReason}`;
  if (plan.alreadyClosed)
    return (
      `done-worktree: --finish-close-out "${slug}" — already fully closed out ` +
      `(landed proof: ${plan.landedVia}); nothing to do.`
    );
  const lines = [
    `done-worktree: --finish-close-out "${slug}" — landed proof: ${plan.landedVia}; ` +
      `${plan.residues.length} residue(s) to clear.`,
  ];
  for (const r of plan.residues) lines.push(`  ${r}: ${outcomes[r] || 'pending'}`);
  return lines.join('\n');
}
