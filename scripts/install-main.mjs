#!/usr/bin/env node
// scripts/install-main.mjs — the ONE sanctioned entry point for a main-checkout `pnpm install`
// (plan 1869).
//
// WHY: the shared main checkout's `node_modules/` is one pnpm virtual store that ~5-7 parallel
// coord sessions all read from. Two sessions independently running a bare `pnpm install` at once
// can interleave their writes into the same `node_modules/.pnpm/<entry>/` directories and leave a
// torn entry behind — an entry directory whose own package is present but missing its
// `package.json` (see the healer below; the exact on-disk layout was verified against this
// worktree's real `node_modules/.pnpm/` before writing the predicate — see findOwnPackageDirs).
// This script is the single choke point that (1) serializes installs via install-lock.mjs so that
// interleaving can no longer happen going forward, and (2) heals any already-torn entries a PAST
// unserialized collision left behind, before pnpm gets a chance to trip over them.
//
// SEQUENCE: resolve install root → acquire install-lock.mjs's mutex (FAIL-OPEN — see its header;
// this script proceeds even on a timeout, never wedges) → heal the virtual store → run
// `pnpm install` → POST-INSTALL VERIFY + one heal-and-retry round if the store is torn again
// already (plan 2198; exit 3 if entries are STILL corrupt after the retry), journaling every heal
// event to <root>/.scratch/install-main-heals.jsonl (async spawn, via spawnWithTreeKill so the
// whole child tree dies with this process,
// never `spawnSync` — a sync spawn would starve nothing here since there is no heartbeat to keep
// alive, but async is still required so SIGINT/SIGTERM can kill the child tree before this process
// exits) → release the lock in a `finally`, and also on SIGINT/SIGTERM (mirrors test-queue.mjs's
// signal wiring: the child-kill listener spawnWithTreeKill registers via prependOnceListener always
// runs BEFORE this file's release listener, because prependOnceListener always inserts at the head
// regardless of registration order — the child tree is dead before the lock can be seen as free).
//
// THE HEALER'S PREDICATE (verified against THIS worktree's real `node_modules/.pnpm/`, 637 entries,
// 2026-07-15 — do not re-derive from memory, re-check a live store if this file is ever revisited):
// naively decoding a pnpm store ENTRY DIRECTORY NAME back into a package name (undo the `@scope`→
// `@scope+`, split off `@version`) is NOT a reliable path shape — pnpm truncates long entry names to
// a content hash for path-length reasons, e.g. the real entry
// `@csstools+css-parser-algori_b9ad755ebdc6dc54abc499015fcb7df0` truncates the package name itself;
// its OWN package lives at `.../node_modules/@csstools/css-parser-algorithms/package.json`, which
// nothing in the truncated entry name spells out. What IS reliable, verified structurally on this
// store: every entry's `node_modules/` links every OTHER dependency in as a symlink/junction, and
// leaves exactly the entry's OWN extracted package as a REAL (non-symlink) directory — e.g.
// `.pnpm/@babel+helper-module-transforms@7.28.6_@babel+core@7.29.0/node_modules/@babel/` contains a
// REAL `helper-module-transforms/` beside SYMLINKED `core`/`helper-module-imports`/`traverse`/etc.
// So: find the real (non-symlink) directory inside an entry's `node_modules/` (one level deeper for
// a `@scope` namespace) — THAT is the entry's own package, and the corrupt signature is that
// directory PRESENT with its `package.json` MISSING. An entry with no real directory at all (fully
// symlinked, or genuinely empty) is NOT this signature and is left alone.
//
// Usage:
//   node scripts/install-main.mjs [--root <path>] [--dry] [--json] [-- <extra pnpm install args>]
// `--root` defaults to `process.cwd()`. `--dry` never acquires the lock (nothing to serialize
// against — it only reports what heal would do) and never runs pnpm. Exit code forwards pnpm's own
// (or 0 for a clean `--dry` report).

import { existsSync, readdirSync, lstatSync, statSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendJsonl, parseLandPrepMetrics } from './coord/coord-metrics.mjs';
import { pathToFileURL } from 'node:url';
import { parseFlags } from './coord/parse-flags.mjs';
import { spawnWithTreeKill, waitForExit } from './coord/kill-tree.mjs';
import {
  runAcquireLoop,
  releaseAt as releaseInstallLock,
  assertFlagValue,
  requireRootIfNeeded,
  normalizeInstallRoot,
  EXIT_TIMEOUT,
  EXIT_ERROR,
  DEFAULT_STALE_MIN,
} from './coord/install-lock.mjs';

export const ARG_SPEC = Object.freeze({
  label: 'install-main',
  value: Object.freeze(['root']),
  boolean: Object.freeze(['dry', 'json']),
});

// --- path containment (pure) -------------------------------------------------

// Is `targetPath` at or inside `parentDir`? A naive `startsWith` on the raw resolved strings would
// wrongly admit a sibling whose name happens to share the parent's as a prefix (e.g. parentDir
// `/x/.pnpm` and targetPath `/x/.pnpm-evil/entry`) — this guards the healer's ONE dangerous
// operation (a recursive delete) against ever reaching outside the resolved `.pnpm` store dir, even
// if a future caller passes a bad `pnpmDir`.
//
// Review finding [10]: the COMPARISON-only normalization (never for real fs ops — those use the
// caller's real-cased path) is install-lock.mjs's `normalizeInstallRoot`, imported rather than
// duplicated byte-for-byte a second time in this file.
export function isPathContained(parentDir, targetPath) {
  const parent = normalizeInstallRoot(parentDir).replace(/\/+$/, '');
  const target = normalizeInstallRoot(targetPath);
  return target === parent || target.startsWith(`${parent}/`);
}

// --- the healer (pure-ish: fs-reading, no network, hermetic under a temp dir) -----------------

// quietFsOp — the ONE shared "ENOENT means absent, anything else is logged and treated as NOT
// corrupt" guard (review finding [5], round 3). Findings [1]/[2] (delta round) established the
// rule at listEntryDirs/findOwnPackageDirs's four call sites plus isPackageJsonMissing's, but each
// site hand-copied its own try/catch instead of sharing one — and the delta round then ADDED two
// MORE copies rather than extracting it, six near-identical blocks total. Runs a synchronous fs op
// (`readdirSync`/`lstatSync`/`statSync`, passed as a thunk so the caller's own injectable seam — see
// isPackageJsonMissing's `_statSync` — still works): `code: 'OK'` + the result on success; `code:
// 'ENOENT'` (silent — genuinely absent is not an error worth logging) or `code: 'OTHER'` (logged —
// EPERM/EBUSY/etc., a transient lock is NOT the same as gone) on failure. NEVER rethrows — every
// call site this replaces exists precisely so an unreadable/locked path can never crash the scan,
// only be treated as unproven-corruption. `op` ('read' | 'stat') only selects the log verb, so the
// message wording each site already had (and the tests that grep for "cannot read"/"cannot stat")
// stays intact.
//
// Review finding [3] (round 4): folding the six call sites into this one implementation also folded
// their DIFFERENT consequence wording into one generic "treating as not this corruption signature,
// never thrown" string — losing the distinction between "the ENTIRE heal scan for this store was
// skipped" (listEntryDirs's OWN store-dir readdirSync failing: every OTHER entry never even gets
// listed, so every corrupt entry among them survives unhealed) and "one nested package dir was
// skipped" (any of the other five sites: only THAT entry/item is unproven, every sibling entry is
// still scanned normally). An operator debugging a Windows EPERM heal failure needs to be able to
// tell "the whole store never got scanned" from "one package dir out of hundreds was skipped" —
// `consequence` is now supplied PER CALL SITE (see listEntryDirs / findOwnPackageDirs /
// isPackageJsonMissing below) while the shared try/catch/ENOENT-vs-OTHER decision stays exactly ONE
// implementation, here.
function quietFsOp(fn, { op, path, log = () => {}, consequence }) {
  try {
    return { code: 'OK', value: fn() };
  } catch (e) {
    if (e.code === 'ENOENT') return { code: 'ENOENT', value: undefined };
    log(`install-main: cannot ${op} ${path} (${e.code ?? e.message}) — ${consequence}`);
    return { code: 'OTHER', value: undefined };
  }
}

// quietReaddir / quietLstat — review finding [6] (round 4): thin wrappers over quietFsOp so the
// call sites that read a directory or lstat a path stop repeating the `{ op, path, log }` literal
// (5 of the 6 quietFsOp call sites fit this shape). The 6th (isPackageJsonMissing) calls quietFsOp
// directly instead: it needs an INJECTABLE stat function (`_statSync`, its own unit-test seam for
// provoking an EPERM/EBUSY deterministically without a real locked file) that a fixed-function
// wrapper like these two can't offer without reintroducing the very parameter these wrappers exist
// to stop repeating — left as-is rather than forced into a shape that doesn't fit.
function quietReaddir(path, { log = () => {}, consequence }) {
  return quietFsOp(() => readdirSync(path, { withFileTypes: true }), {
    op: 'read',
    path,
    log,
    consequence,
  });
}
function quietLstat(path, { log = () => {}, consequence }) {
  return quietFsOp(() => lstatSync(path), { op: 'stat', path, log, consequence });
}

// listEntryDirs — direct child DIRECTORY names of a pnpm store dir (skips files it also contains,
// e.g. `lock.yaml`). [] when the dir doesn't exist — the healer's own "no node_modules/.pnpm at
// all" no-op case reduces to this returning empty, no special-casing needed above it.
//
// Review finding [1]: a non-ENOENT readdirSync error (EPERM/EBUSY — THE Windows condition this
// whole script exists to survive) used to be RETHROWN uncaught, killing the run before `pnpm
// install` ever spawned — strictly worse than the bare `pnpm install` this script replaces. An
// unreadable dir is simply "not this corruption signature": log it and skip, never throw (via
// quietFsOp, finding [5]). (main() also wraps the whole heal step in a try/catch as a second line of
// defense — see its own comment.)
//
// Review finding [3] (round 4): THIS is the severe call site — a failure here means the ENTIRE heal
// scan for this store is skipped (every top-level entry, so every corrupt entry among them, is never
// even listed and so survives unhealed until a future run can read this directory). The consequence
// wording says exactly that, distinct from the per-entry wording below.
function listEntryDirs(pnpmDir, { log = () => {} } = {}) {
  const r = quietReaddir(pnpmDir, {
    log,
    consequence:
      'SKIPPING THE ENTIRE HEAL SCAN for this store — every corrupt entry it contains will survive ' +
      'unhealed until a future run can read this directory',
  });
  if (r.code !== 'OK') return [];
  return r.value.filter((d) => d.isDirectory()).map((d) => d.name);
}

// findOwnPackageDirs — see the file header for the verified layout this walks. Returns relative
// paths (POSIX-joined) of every REAL (non-symlink) package directory directly inside an entry's
// `node_modules/` — `"name"` for an unscoped package, `"@scope/name"` for a scoped one. In the
// healthy, common case this is a single-element array; [] when the entry's `node_modules/` is
// missing, empty, or entirely symlinks (not this corruption signature).
//
// Review finding [1]/[2]: every readdirSync/lstatSync here used to hand-copy its own ENOENT-vs-other
// try/catch (a non-ENOENT error on ONE entry used to kill the scan of every OTHER entry too, or a
// scope dir that's merely locked right now used to be misread as "gone"). All four sites now route
// through quietFsOp (finding [5], round 3) — same behavior, one implementation.
// Review finding [3] (round 4): every quietReaddir/quietLstat call in this function is a PER-ENTRY
// (or per-item-within-an-entry) skip, never a whole-store skip — the consequence wording below says
// so explicitly, distinct from listEntryDirs's whole-scan-skipped wording above.
export function findOwnPackageDirs(entryNodeModulesDir, { log = () => {} } = {}) {
  const topR = quietReaddir(entryNodeModulesDir, {
    log,
    consequence:
      'skipping this store entry — treating it as not this corruption signature (every OTHER entry is still scanned)',
  });
  if (topR.code !== 'OK') return [];

  const found = [];
  for (const t of topR.value) {
    const tPath = join(entryNodeModulesDir, t.name);
    const lstR = quietLstat(tPath, {
      log,
      consequence:
        "skipping this item within the entry — treating it as not the entry's own package",
    });
    if (lstR.code !== 'OK') continue; // vanished (ENOENT) or unreadable (OTHER, logged) — skip either way
    const lst = lstR.value;
    if (lst.isSymbolicLink() || !lst.isDirectory()) continue; // a linked dependency, not our own

    if (t.name.startsWith('@')) {
      // Scope namespace directory — the real package is one level deeper.
      const innerR = quietReaddir(tPath, {
        log,
        consequence:
          'skipping this scope namespace within the entry — treating it as not this corruption signature',
      });
      if (innerR.code !== 'OK') continue;
      for (const i of innerR.value) {
        const iPath = join(tPath, i.name);
        const ilstR = quietLstat(iPath, {
          log,
          consequence: "skipping this scoped item — treating it as not the entry's own package",
        });
        if (ilstR.code !== 'OK') continue;
        const ilst = ilstR.value;
        if (ilst.isSymbolicLink() || !ilst.isDirectory()) continue;
        found.push(`${t.name}/${i.name}`);
      }
    } else {
      found.push(t.name);
    }
  }
  return found;
}

// Is `pkgJsonPath` missing — the genuine corruption signature? Review finding [2]: the previous
// `existsSync(pkgJsonPath)` returns `false` on ANY stat error (ENOENT for a truly missing file, but
// ALSO EPERM/EBUSY for an AV/indexer-locked file mid-scan), and the caller read `false` as "corrupt"
// either way — misclassifying a merely-locked-right-now package.json as torn and deleting a GOOD
// tree. Only a true ENOENT counts as missing/corrupt; any other stat error is treated as NOT corrupt
// (conservative: under-healing is recoverable on the next run, deleting a good tree is not). Exported
// with an injectable `_statSync` seam so this safety-critical branch is unit-testable without
// needing to provoke a real EPERM/EBUSY (unreliable to force portably in a test). Routed through
// quietFsOp (finding [5], round 3) — same behavior, no more hand-copied try/catch.
export function isPackageJsonMissing(pkgJsonPath, { log = () => {}, _statSync = statSync } = {}) {
  const r = quietFsOp(() => _statSync(pkgJsonPath), {
    op: 'stat',
    path: pkgJsonPath,
    log,
    // Review finding [3] (round 4): the per-package consequence — distinct from the store-wide and
    // per-entry wording above. This is the ONE call site whose "not corrupt" verdict is the actual
    // healer decision (not just a scan-skip), so it spells out WHY that's the conservative choice.
    consequence:
      'treating this package as NOT corrupt (conservative — under-healing is recoverable on the ' +
      'next run, deleting a good tree is not)',
  });
  if (r.code === 'ENOENT') return true; // genuinely absent — the corruption signature
  return false; // present (OK) or unreadable (OTHER, logged) — both are conservatively "not corrupt"
}

// scanPnpmStore — every entry under `pnpmDir` whose own package directory is present but missing
// `package.json`. Returns `{ entry, entryPath, pkgDir }[]`. An entry with no own directory at all
// (findOwnPackageDirs → []) is not this signature and is skipped, not flagged.
//
// Review finding [5] (delta round): `_entries` lets healPnpmStore hand in a store listing it has
// ALREADY read (for its own `scanned` count) instead of this function re-reading the same directory
// a second time. Defaults to `null` so every existing direct caller (this file's own tests included)
// keeps working unchanged — the injection is purely an optional reuse seam, not a new contract.
export function scanPnpmStore(
  pnpmDir,
  { log = () => {}, _statSync = statSync, _entries = null } = {},
) {
  const corrupt = [];
  const entries = _entries ?? listEntryDirs(pnpmDir, { log });
  for (const entryName of entries) {
    const entryPath = join(pnpmDir, entryName);
    const nmDir = join(entryPath, 'node_modules');
    for (const pkgDir of findOwnPackageDirs(nmDir, { log })) {
      if (isPackageJsonMissing(join(nmDir, pkgDir, 'package.json'), { log, _statSync })) {
        corrupt.push({ entry: entryName, entryPath, pkgDir });
        break; // one condemned own-dir is enough to condemn the whole entry
      }
    }
  }
  return corrupt;
}

// The empty heal-result shape, shared by every call site that reports "nothing to heal" — the
// early no-pnpm-dir return here, healOrSkip's catch fallback, and main()'s ternary default used to
// each hand-copy the same object literal (review finding [6], delta round). A FUNCTION, not a
// shared object constant: `healed` must be a fresh array on every call, never one mutable array
// three call sites could accidentally alias and mutate into each other.
export function emptyHealResult() {
  return { scanned: 0, corrupt: 0, healed: [] };
}

// healPnpmStore — scan + (unless dryRun) delete each corrupt entry's WHOLE top-level store
// directory (pnpm re-materializes it on the next install; the torn own-package dir inside it can
// never be trusted piecemeal). Safe / a no-op when `pnpmDir` doesn't exist. Every delete is
// path-containment-checked against `pnpmDir` first — see isPathContained.
//
// Review finding [8]: the returned `scanned` field used to actually hold `corrupt.length` — a
// reader checking "did it scan anything" against `scanned` misread a perfectly healthy run (0
// corrupt entries out of hundreds scanned) as "scanned nothing". Renamed to the honest `corrupt`,
// and `scanned` now reports the real top-level entry count (cheap — one extra readdirSync, not a
// recursive walk). Nothing consumed the old shape yet (per the review), so this changes freely.
//
// Review finding [5] (delta round): that "one extra readdirSync" is now read exactly ONCE — listed
// here, then handed into scanPnpmStore via `_entries` instead of scanPnpmStore listing the same
// directory again internally.
export function healPnpmStore(pnpmDir, { dryRun = false, log = () => {} } = {}) {
  const pnpmDirAbs = resolve(pnpmDir);
  if (!existsSync(pnpmDirAbs)) return emptyHealResult();
  const entries = listEntryDirs(pnpmDirAbs, { log });
  const corrupt = scanPnpmStore(pnpmDirAbs, { log, _entries: entries });
  const healed = [];
  for (const c of corrupt) {
    if (!isPathContained(pnpmDirAbs, c.entryPath)) {
      log(`install-main: REFUSING to touch ${c.entryPath} — outside ${pnpmDirAbs}`);
      continue;
    }
    log(
      `install-main: ${dryRun ? '[dry] would heal' : 'healing'} corrupt store entry "${c.entry}" ` +
        `(missing ${c.pkgDir}/package.json)`,
    );
    if (!dryRun) {
      try {
        rmSync(c.entryPath, { recursive: true, force: true });
      } catch (e) {
        log(`install-main: failed to remove ${c.entryPath}: ${e.message}`);
        continue;
      }
    }
    healed.push(c.entry);
  }
  return { scanned: entries.length, corrupt: corrupt.length, healed };
}

// Review finding [0]: decide whether healing may run AT ALL, given the install-lock acquire result
// — `acquired.code === 0` covers BOTH a real ACQUIRE and the INSTALL_LOCK_DISABLE=1 bypass
// (runAcquireLoop returns code 0 for both), which is the correct union: a real holder has
// exclusivity via the lock, and an explicit operator bypass means the operator OWNS the exclusivity
// call instead. A queue-wait TIMEOUT (EXIT_TIMEOUT) or an ERROR (EXIT_ERROR) is NOT the same as
// disabled — either means the lock was NOT taken, and on the TIMEOUT path specifically a rival
// install may genuinely be live right now, so healing here could `rmSync` its in-flight store entry.
// Exported (rather than inlined in main()) so this safety-critical decision is unit-testable without
// spawning a real pnpm or waiting out install-lock's real (900s) queue timeout.
export function shouldHeal(acquired, { log = () => {} } = {}) {
  if (acquired.code === 0) {
    if (acquired.bypassed) {
      log(
        'install-main: INSTALL_LOCK_DISABLE=1 — healing anyway (an explicit operator bypass means ' +
          'the operator owns the exclusivity call, not this script).',
      );
    }
    return true;
  }
  log(
    `install-main: SKIPPING the heal — the install lock was NOT held (code ${acquired.code}: ` +
      `${acquired.code === EXIT_TIMEOUT ? 'queue-wait TIMEOUT' : acquired.code === EXIT_ERROR ? 'ERROR' : 'unexpected'}). A non-acquired lock ` +
      'is positive evidence a rival install may be live right now; healing without exclusivity ' +
      "risks deleting a rival's in-flight store entry. Proceeding UNSERIALIZED with pnpm install " +
      '(fail-open — this must never wedge the install).',
  );
  return false;
}

// Review finding [1]: wraps healPnpmStore so a heal-internal failure (e.g. some unforeseen bug in
// a per-entry guard) can NEVER prevent `pnpm install` from running — that would be strictly worse
// than the bare `pnpm install` this script replaces. Exported with an injectable `_healPnpmStore`
// seam so this safety-net is unit-testable without forcing a real fs error.
export function healOrSkip(pnpmDir, { log = () => {}, _healPnpmStore = healPnpmStore } = {}) {
  try {
    return _healPnpmStore(pnpmDir, { dryRun: false, log });
  } catch (e) {
    log(
      `install-main: heal step failed unexpectedly (${e?.code ?? e?.message}) — skipping the heal ` +
        'and proceeding to pnpm install regardless.',
    );
    return emptyHealResult();
  }
}

// postInstallVerify — re-scan the store AFTER `pnpm install` reported success (plan 2198). The
// 2026-07-21 recurrence showed a completed heal+install is not proof the store is healthy at the
// moment this process exits: the same ~26 entries (plus the whole root `.bin`) were torn again
// within minutes, four times in one morning, and the gates that die on it ('lint-staged is not
// recognized') give no timestamped record of what the store looked like when. This verify closes
// the loop: scan once more, and also flag a missing/empty root `.bin` when the root manifest
// declares dependencies (the observed gate deaths were `.bin` wipes, which the entry-level
// signature cannot see — pnpm re-links `.bin` on any completed install, so post-install emptiness
// is suspect). `binEmpty` is a warn/retry signal only, never a hard failure: a manifest whose
// dependencies expose no bins legitimately has no `.bin` dir, and that must not fail a sibling
// project's install (only corrupt ENTRIES escalate the exit code — see main()).
export function postInstallVerify(root, { log = () => {}, _statSync = statSync } = {}) {
  const pnpmDir = join(root, 'node_modules', '.pnpm');
  // No existsSync guard (review finding [7]): scanPnpmStore's own listEntryDirs already treats a
  // missing pnpmDir as the empty scan via its ENOENT branch.
  const corrupt = scanPnpmStore(pnpmDir, { log, _statSync });
  let binEmpty = false;
  const pkgJson = join(root, 'package.json');
  const binDir = join(root, 'node_modules', '.bin');
  try {
    // A root that survived requireRootIfNeeded and a completed install has a readable
    // package.json in every real case; any parse/read error just means "cannot judge
    // .bin" — the catch below skips the check.
    const manifest = JSON.parse(readFileSync(pkgJson, 'utf8'));
    const hasDeps =
      Object.keys(manifest.dependencies ?? {}).length > 0 ||
      Object.keys(manifest.devDependencies ?? {}).length > 0;
    if (hasDeps) {
      const r = quietReaddir(binDir, {
        log,
        consequence:
          'treating root .bin as SUSPECT (retry-worthy) — an unreadable .bin right after an ' +
          'install is closer to the torn signature than to health',
      });
      // Review finding [1]: an OTHER (EPERM/EBUSY) read is SUSPECT here, not clean — unlike the
      // healer's per-entry predicate (where "not proven corrupt" avoids deleting a good tree),
      // binEmpty only ever triggers a warn/one-retry, so the safe default inverts: anything
      // short of a successful non-empty read counts.
      binEmpty = r.code !== 'OK' || r.value.length === 0;
    }
  } catch {
    /* no manifest / unparsable — nothing to judge .bin against */
  }
  return { corrupt, binEmpty };
}

// appendHealJournal — one JSONL line per heal/verify event, at <root>/.scratch/
// install-main-heals.jsonl (plan 2198). The four-heal morning that motivated this had NO
// machine-readable trace: heal output went to the invoking session's stderr and died with it, so
// reconstructing "when did each tear happen, what exactly was torn" took transcript archaeology.
// Routed through coord-metrics' shared appendJsonl (review finding [3] — this was becoming the
// 4th hand-rolled mkdir+append+swallow copy), with a size cap (finding [11]): rotates once to
// `.1` past 512KB, so the journal can never grow unbounded on the long-lived main checkout.
// Best-effort — a journal failure must never affect the install (log + continue).
export const HEAL_JOURNAL_MAX_BYTES = 512 * 1024;
export function appendHealJournal(root, record, { log = () => {} } = {}) {
  const ok = appendJsonl(join(root, '.scratch', 'install-main-heals.jsonl'), record, {
    maxBytes: HEAL_JOURNAL_MAX_BYTES,
  });
  if (!ok) log('install-main: could not write heal journal — continuing.');
  return ok;
}

// readHealJournal — best-effort parse of the journal above (for the repeat-notice below), the
// rotated `.1` INCLUDED (review round 1: rotation would otherwise reset the recurrence count to
// zero at exactly the moment the journal proves the condition is long-lived). Line parsing is
// coord-metrics' tolerant JSONL parser — the same one appendJsonl's other consumers use — not a
// third hand-rolled copy. Unreadable file → skipped, never thrown: journaling must not affect
// the install.
export function readHealJournal(root, { _read = readFileSync } = {}) {
  const path = join(root, '.scratch', 'install-main-heals.jsonl');
  const readOne = (p) => {
    try {
      return parseLandPrepMetrics(_read(p, 'utf8'));
    } catch {
      return [];
    }
  };
  return [...readOne(`${path}.1`), ...readOne(path)];
}

// repeatHealNotice (plan 2401 task 5) — the journal silently recorded 80 byte-identical
// 18-entry heals over 11 days before anyone noticed the pattern; each session saw only its own
// "healed 18 entries" line and moved on. When the set just healed matches prior journal
// records, SAY SO, so the next reader gets the recurrence (and the root cause) without
// re-deriving the whole picture. Messaging only — heal/verify semantics untouched (the plan's
// explicit carve-out from 2365's non-goal). Returns the notice string, or null when the heal is
// genuinely new. Set equality is order-insensitive (sorted join), and a record's healed set is
// its pre-install heal UNION its retry-round heal (review round 1: a tear caught only by the
// post-install verify lands in `retryHealed`, and comparing `healed` alone would miss it on both
// sides of the comparison).
export function healedSetOf(record) {
  const a = Array.isArray(record?.healed) ? record.healed : [];
  const b = Array.isArray(record?.retryHealed) ? record.retryHealed : [];
  return [...a, ...b];
}
export function repeatHealNotice(records, healedNow) {
  if (!Array.isArray(healedNow) || healedNow.length === 0) return null;
  const key = (arr) => [...new Set(arr)].sort().join('\n');
  const nowKey = key(healedNow);
  const prior = (records ?? []).filter((r) => {
    const s = healedSetOf(r);
    return s.length > 0 && key(s) === nowKey;
  });
  if (prior.length === 0) return null;
  const firstTs = prior[0]?.ts ?? 'unknown';
  return (
    `install-main: heal #${prior.length + 1} of the IDENTICAL ${healedNow.length}-entry set since ${firstTs} — ` +
    `recurring condition, not a one-off. Root cause + fix: plan 2401 (done-worktree's finish-worktree ` +
    `node_modules junction was deleted THROUGH by \`git worktree remove --force\`; fixed by unlinking the ` +
    `junction before teardown). A recurrence AFTER that fix landed means a second trigger — investigate, ` +
    `don't just re-heal.`
  );
}

// installVerifyRetry — the plan-2198 install→verify→heal→retry→escalate orchestration, EXPORTED
// with injectable seams (review finding [9]: this file's own pattern — shouldHeal/healOrSkip are
// exported precisely so safety-critical decisions are unit-testable without spawning a real pnpm;
// the state machine that decides a loud exit 3 deserves the same). Contract:
//   - run the install; when it succeeds under held exclusivity, verify the store;
//   - a failed verify triggers ONE heal+reinstall round — UNLESS the lock has been held longer
//     than `retryBudgetMs` (review finding [2]: the retry roughly doubles worst-case hold time,
//     and install-lock's staleness reaper computes age from the ORIGINAL acquire timestamp; a
//     retry that would run into the stale window invites a waiter to reap the lock and start a
//     rival install mid-write — the exact corruption this script exists to stop). A skipped
//     retry with corrupt entries still exits 3: loud beats a silent false-healthy 0.
//   - entries still corrupt after the retry → exit 3. `.bin` emptiness alone never escalates.
// Returns { code, error, retried, retryHealed, retrySkipped, verify }; `retryHealed` is the
// retry round's healed list (review finding [0]: it was being discarded, which dropped exactly
// the diagnostic data the journal exists to capture).
export async function installVerifyRetry({
  root,
  pnpmDir,
  healAllowed,
  log = () => {},
  runInstall,
  elapsedMs = () => 0,
  retryBudgetMs = (DEFAULT_STALE_MIN * 60_000 * 2) / 3, // 10 min of the 15-min stale window
  _verify = postInstallVerify,
  _heal = healOrSkip,
}) {
  let { code, error } = await runInstall();
  let retried = false;
  let retryHealed = [];
  let retrySkipped = null;
  let verify = null;
  if (healAllowed && !error && code === 0) {
    verify = _verify(root, { log });
    if (verify.corrupt.length > 0 || verify.binEmpty) {
      if (elapsedMs() > retryBudgetMs) {
        retrySkipped = 'stale-window';
        log(
          `install-main: POST-INSTALL VERIFY FAILED but the lock has been held ${Math.round(elapsedMs() / 1000)}s — ` +
            `NOT retrying (a retry running into install-lock's ${DEFAULT_STALE_MIN}-min stale window invites a waiter ` +
            `to reap the lock mid-write). Re-run install-main to heal.`,
        );
        if (verify.corrupt.length > 0) code = 3;
      } else {
        log(
          `install-main: POST-INSTALL VERIFY FAILED (${verify.corrupt.length} corrupt entr` +
            `${verify.corrupt.length === 1 ? 'y' : 'ies'}${verify.binEmpty ? ', root .bin missing/empty/unreadable' : ''}) ` +
            `after a successful pnpm install — healing and retrying ONCE.`,
        );
        retryHealed = _heal(pnpmDir, { log }).healed;
        retried = true;
        ({ code, error } = await runInstall());
        if (!error && code === 0) {
          verify = _verify(root, { log });
          if (verify.corrupt.length > 0) {
            // Two heal+install rounds could not produce a healthy store: something is actively
            // re-tearing it (or the store source is bad). A silent exit-0 here is exactly the
            // false "healed" signal plan 2198 diagnosed — fail LOUDLY instead.
            log(
              `install-main: STORE STILL CORRUPT AFTER RETRY (${verify.corrupt
                .map((c) => c.entry)
                .join(', ')}) — failing loudly (exit 3). See .scratch/install-main-heals.jsonl.`,
            );
            code = 3;
          } else if (verify.binEmpty) {
            log(
              'install-main: root .bin still missing/empty after retry — gates that shell out to ' +
                'dev bins may fail; not escalating (a manifest with no bin-exposing deps is legitimate).',
            );
          }
        }
      }
    }
  }
  return { code, error, retried, retryHealed, retrySkipped, verify };
}

// --- CLI ---------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const sepIdx = argv.indexOf('--');
  const ownArgv = sepIdx === -1 ? argv : argv.slice(0, sepIdx);
  const extraInstallArgs = sepIdx === -1 ? [] : argv.slice(sepIdx + 1);

  // Review finding [1] (round 3): every genuinely INTENTIONAL / caller-config error this script can
  // produce — an unknown flag, `--root` swallowing the next flag as its value, a nonexistent install
  // root — is decided in this ONE block, before any real work (lock/heal/spawn) starts, and prints
  // ONE clean line. Funnelling them all through this single inline catch means the outer
  // `main().catch()` at the bottom of this file is reached ONLY by genuinely UNEXPECTED exceptions,
  // and can safely go back to printing the FULL stack for those — see that catch's own comment for
  // why (the previous round's `e?.message`-only outer catch lost the one diagnostic trace an
  // unanticipated bug has, since it could not tell the two classes apart).
  let root, dry, json;
  try {
    const { flags } = parseFlags(ownArgv, ARG_SPEC);
    // assertFlagValue guard (finding [6], mirrored from install-lock.mjs's CLI): --root was read
    // raw, so `install-main --root --dry` would silently swallow `--dry` as the root value.
    root = resolve(assertFlagValue(flags.root, 'root') ?? process.cwd());
    // Review finding [1] (delta round): a nonexistent --root has nothing to install into — fail
    // fast with ONE clear line and a non-zero exit, before this ever reaches the git-common-dir
    // probe (via runAcquireLoop) or the pnpm store walk. This is a genuine caller/config error, not
    // the fail-open path: fail-open covers lock contention/staleness, never "there is no install to
    // run". Checked before even the --dry heal report, so both modes get the same clean failure.
    //
    // Review finding [4] (round 3): install-main ALWAYS needs a real root (it installs into it and
    // heals its own store) — routed through requireRootIfNeeded, the ONE shared, exported decision
    // both this CLI and install-lock.mjs's own CLI call with an explicit intent flag, rather than
    // each deciding ad hoc (see install-lock.mjs's own `cmd === 'acquire'` call site + finding [2]).
    requireRootIfNeeded(root, true);
    dry = flags.dry === true;
    json = flags.json === true;
  } catch (e) {
    console.error(`install-main: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const pnpmDir = join(root, 'node_modules', '.pnpm');
  const log = (m) => console.error(m);

  if (dry) {
    const result = healPnpmStore(pnpmDir, { dryRun: true, log });
    if (json) console.log(JSON.stringify({ root, dry: true, ...result }));
    return 0;
  }

  let released = false;
  let held = null; // { lockPath, token } once acquired
  let child = null; // set once spawned, read by waitForExit below
  const releaseLock = () => {
    if (released || !held) {
      released = true;
      return;
    }
    released = true;
    // Review finding [0] (delta round) — CRITICAL regression, now DELETED rather than patched: this
    // used to spin a bounded synchronous wait here on a SIGINT/SIGTERM exit, polling `child.pid` for
    // liveness before releasing, on the theory that a just-killed child's writes into
    // node_modules/.pnpm might still be landing. On Windows that wait was a placebo, not protection:
    // spawnWithTreeKill('pnpm', …) spawns pnpm via its `pnpm.cmd` shim, so `child.pid` is the cmd.exe
    // WRAPPER's pid, never the node.exe that actually writes into the store. The wrapper dies
    // instantly once killed, so the old `isPidAlive(child.pid)` check returned false on its very
    // first poll and the wait exited in zero iterations — it guarded nothing on the one platform it
    // was written for.
    //
    // The right fix is to remove the wait, not make it tree-aware: a killed `pnpm install` leaves
    // behind a TORN store entry — present own-package dir, missing package.json — which is exactly
    // the signature healPnpmStore (above) detects and repairs. The NEXT install-main.mjs run
    // acquires this same lock and HEALS BEFORE it installs, so a rival that starts against a store
    // left settling by a killed install repairs it first. The self-healing design already covers the
    // kill path end to end; this wait never added anything beyond false assurance. And once a
    // process is force-terminated (taskkill /T /F on Windows, a SIGTERM cascade on POSIX), it issues
    // no further writes — the only residue left behind is the torn entry, and that is healed.
    try {
      releaseInstallLock(held.lockPath, { token: held.token });
    } catch (e) {
      log(`install-main: failed to release the install lock: ${e.message}`);
    }
  };
  const onSignal = (sig) => {
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('exit', releaseLock);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const acquired = runAcquireLoop({ root, label: 'install-main', log });
    if (acquired.token && acquired.lockPath)
      held = { lockPath: acquired.lockPath, token: acquired.token };

    // See shouldHeal / healOrSkip above (findings [0] / [1]) for the full reasoning: heal only when
    // exclusivity was genuinely established (real acquire or an explicit operator bypass), and a
    // heal-internal failure can never prevent the install itself.
    const healAllowed = shouldHeal(acquired, { log });
    const healResult = healAllowed ? healOrSkip(pnpmDir, { log }) : emptyHealResult();
    if (healResult.healed.length > 0) {
      log(
        `install-main: healed ${healResult.healed.length} corrupt store entr${healResult.healed.length === 1 ? 'y' : 'ies'}.`,
      );
    }

    // Never `--ignore-scripts` — this is a real, full install. Post-install verify + ONE retry
    // (plan 2198) run only under held exclusivity (healAllowed): without the lock a rival's
    // in-flight import legitimately looks torn mid-flight, and deleting its entries here would
    // BE the corruption this script exists to stop. Orchestration lives in installVerifyRetry
    // (exported + unit-tested); this block only wires the real seams.
    const acquiredAtMs = Date.now();
    const { code, error, retried, retryHealed, retrySkipped, verify } = await installVerifyRetry({
      root,
      pnpmDir,
      healAllowed,
      log,
      runInstall: async () => {
        child = spawnWithTreeKill('pnpm', ['install', ...extraInstallArgs], {
          cwd: root,
          stdio: 'inherit',
        });
        return waitForExit(child);
      },
      elapsedMs: () => Date.now() - acquiredAtMs,
    });

    if (error) {
      log(`install-main: pnpm install failed to start: ${error.message}`);
      process.exitCode = 1;
    } else {
      process.exitCode = code ?? 1;
    }
    // Journal every eventful run (a heal, a retry, or a verify finding) — see appendHealJournal.
    if (
      healResult.healed.length > 0 ||
      retried ||
      retrySkipped ||
      (verify && verify.corrupt.length > 0)
    ) {
      // plan 2401: surface an identical-set re-heal as the recurring condition it is (read the
      // prior records BEFORE appending this run's own, so the count excludes it; this run's set
      // is the pre-install heal UNION the retry-round heal — see healedSetOf).
      const healedThisRun = healedSetOf({ healed: healResult.healed, retryHealed });
      if (healedThisRun.length > 0) {
        const notice = repeatHealNotice(readHealJournal(root), healedThisRun);
        if (notice) log(notice);
      }
      appendHealJournal(
        root,
        {
          root,
          pid: process.pid,
          ppid: process.ppid,
          healed: healResult.healed,
          retried,
          retryHealed,
          retrySkipped,
          verifyCorrupt: verify ? verify.corrupt.map((c) => c.entry) : null,
          verifyBinEmpty: verify ? verify.binEmpty : null,
          installExitCode: code ?? null,
        },
        { log },
      );
    }
    if (json) {
      console.log(
        JSON.stringify({
          root,
          dry: false,
          ...healResult,
          installExitCode: code,
          retried,
          retryHealed,
          retrySkipped,
        }),
      );
    }
  } finally {
    releaseLock();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

// Review finding [4] (delta round): resolved automatically by deleting the post-signal wait above —
// this was its ONLY caller. `isPidAlive` was a third hand-copied liveness-probe implementation in
// this repo; not replaced with a shared one (out of scope — see kill-tree.mjs), just removed.

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // Review finding [1] (round 3) — REGRESSION FIXED: this handler is reached ONLY by genuinely
    // UNEXPECTED exceptions now (a bug deep in the heal/lock/spawn path) — every intentional/
    // validation error (a bad flag, a nonexistent --root) is caught inline inside main() above and
    // returns from there as ONE clean line before ever reaching here (that inline catch is what
    // finding [1] (delta round) originally added, and what the previous round's blanket
    // `e?.message ?? e` here wrongly copied onto THIS handler too, discarding the stack trace this
    // class of error still needs). Print the FULL stack: an unanticipated TypeError has only this
    // one diagnostic trace, unlike the clean single-line messages this file's own validation
    // produces on purpose.
    console.error('install-main: unexpected error —', e?.stack ?? e);
    process.exitCode = 1;
  });
}
