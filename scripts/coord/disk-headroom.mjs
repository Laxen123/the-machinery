#!/usr/bin/env node
// scripts/disk-headroom.mjs (plan 3815)
//
// Cloud drain sandboxes have a fixed disk. A land runs the frontend production build
// (`pnpm --filter @vetapp/frontend build`) in a worktree, and a long-lived sandbox can already
// be carrying `.next` output from the main checkout's earlier build, other worktrees' builds,
// and `node_modules/.cache` — nothing pruned any of it, so the build died mid-way with ENOSPC
// at least ten times between 2026-08-21 and 2026-09-08 (plans 3784, 3652, 3533, 3526, 3594,
// 3691, 3677 and more), every time recovered by hand. This module is the fix, standalone and
// dependency-free so it can run BEFORE `pnpm install` (a torn/incomplete node_modules must
// never block reclaiming disk space) and so it is trivially importable in-process for tests.
//
// PURE NODE BUILT-INS ONLY (`node:fs`, `node:path`, `node:url`) — no shell-out, no external
// deps, no import of any other scripts/*.mjs module. Never deletes `node_modules` itself, the
// pnpm store, or `.git` — see PRUNE_DIR_NAMES / NODE_MODULES_DIR_NAME / NEVER_ENTER_DIR_NAMES
// below for the exact allow-list this rests on.
//
// ── CLI shape ──────────────────────────────────────────────────────────────────────────────
//   node scripts/disk-headroom.mjs check [<path>]
//       Prints free bytes for the volume containing <path> (default: the repo root, resolved
//       from this script's own location). Read-only, no writes anywhere.
//
//   node scripts/disk-headroom.mjs prune [--keep <worktree-path>] [--root <path>] [--worktrees-root <path>]
//       Deletes `.next`, `.turbo`, and `node_modules/.cache` under <root> (default: the repo
//       root) and under every immediate child of <worktrees-root> (default: <root>/.claude/
//       worktrees) EXCEPT `--keep <worktree-path>` — the worktree currently being landed, whose
//       build output the caller still needs. Prints what it freed, one line per deleted
//       directory. Both root flags are escape hatches for tests/CI; the defaults are what every
//       real caller (a land, or the routine's own checkout-preflight prune) wants.
//
// `--keep` names the LANDED worktree deliberately as an ARGUMENT rather than this module trying
// to infer "which worktree is currently being landed" itself — that decision belongs entirely to
// the caller (done-worktree-lib.mjs's cloud land path), which already knows the worktree path
// from its own state. This module stays a total function of what it is told.
//
// Both `check` and `prune` are exported as plain functions (`checkFreeBytes`, `prune`,
// `pruneNext`) so a caller — the land's disk-headroom gate, or a test — can drive this
// in-process without shelling out.

import { readdirSync, readlinkSync, rmSync, statSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { repoRootFrom } from './scripts-anchor.mjs';

// plan 3815: default free-space floor a cloud land refuses to start the production build
// under, in bytes. The one caller reading this today is done-worktree-lib.mjs's
// diskHeadroomFloorBytes (env-overridable there via DISK_HEADROOM_FLOOR_BYTES) — exported here,
// not re-declared there, so the two never drift.
export const DEFAULT_FLOOR_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB

// Directory names this module ever deletes by a bare NAME MATCH — build output/caches only.
const PRUNE_DIR_NAMES = new Set(['.next', '.turbo']);
// node_modules is NEVER deleted and NEVER recursed into generally (see walk() below) — the
// pnpm store lives under it and a store tear is exactly the failure class CLAUDE.md's "THIRD
// lock" section exists to prevent. The one thing pruned inside it is its OWN direct `.cache`
// child (Next/webpack/babel's build-tool cache), by an explicit, narrow check — never a walk.
const NODE_MODULES_DIR_NAME = 'node_modules';
const NODE_MODULES_CACHE_SUBDIR = '.cache';
// Never entered, for any reason — the pnpm store's peer, and unrelated to build output.
const NEVER_ENTER_DIR_NAMES = new Set(['.git']);

export function repoRootFromScript() {
  return repoRootFrom(dirname(fileURLToPath(import.meta.url)));
}

// Sums the on-disk size of every regular file under `path`, recursively. Never follows
// symlinks — `readdirSync(..., { withFileTypes: true })` Dirents report a symlink's own type
// (SYMLINK), so `entry.isDirectory()`/`entry.isFile()` are both false for one and the walk
// simply skips it. That is deliberate here, not incidental: pnpm's `node_modules/.pnpm` tree is
// a dense symlink farm, and this module never walks into `node_modules` anyway (see prune()
// below) — but a `.next`/`.turbo` directory could in principle itself contain a symlink, and
// this keeps sizing (and, in deleteDir, deletion) from ever chasing one out of the tree we were
// asked to measure.
function dirSizeBytes(path) {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0; // gone, or never existed — nothing to size
  }
  let total = 0;
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += statSync(full).size;
      } catch {
        // raced away mid-scan (a concurrent process, or the entry vanished between readdir and
        // stat) — not fatal, just excluded from the size total.
      }
    }
  }
  return total;
}

// Sizes, then deletes, one directory. Best-effort: a directory that vanishes between the size
// pass and the delete (or that this process lacks permission to remove) is silently skipped
// rather than throwing — a prune step must never be the reason a land fails.
function deleteDir(path, deleted) {
  const bytes = dirSizeBytes(path);
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    return;
  }
  deleted.push({ path, bytes });
}

// The one tree-walker both prune() and pruneNext() build on. Recursively finds every directory
// under `root` whose bare name is in `names`, deleting each one found (without recursing further
// into it — there is nothing left under a deleted directory to walk). Two hard exclusions,
// independent of `names`:
//   - `.git` is never entered, full stop.
//   - `node_modules` is never entered either, EXCEPT — when `includeNodeModulesCache` is true —
//     to check for (and delete) its own direct `.cache` child; never `node_modules` itself,
//     never anything else inside it. `pruneNext` passes `includeNodeModulesCache: false`: its
//     contract is `.next` ONLY (see its own header comment for why node_modules/.cache is left
//     for the next land-wide prune() instead), so this flag — not `names` — is what it gates on.
// `skipDirs` is a Set of RESOLVED absolute paths to skip entirely (never entered, never
// deleted) — distinct from NEVER_ENTER_DIR_NAMES (a by-NAME exclusion applied everywhere) in
// that this is a by-PATH exclusion the caller supplies for one specific walk. `prune()` below is
// the one caller, and the one path it excludes is `worktreesRoot`: in the real repo layout
// `.claude/worktrees/` sits INSIDE the main checkout, so a plain recursive walk of
// `mainCheckoutPath` would otherwise descend straight into every worktree — including the one
// named by `keep` — and delete its `.next` as collateral, silently defeating `keep` (caught by
// manually exercising the CLI against a nested fixture tree before this fix; see plan 3815
// executor notes). The separate worktrees fan-out loop in prune() is the ONLY code that is
// allowed to touch anything under `worktreesRoot`, and it is the one that honours `keep`.
function pruneTree(root, names, { includeNodeModulesCache = true, skipDirs } = {}) {
  const deleted = [];
  walk(root);
  return deleted;

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // gone, or never existed
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // also excludes symlinks — see dirSizeBytes above
      if (NEVER_ENTER_DIR_NAMES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (skipDirs && skipDirs.has(resolve(full))) continue;
      if (entry.name === NODE_MODULES_DIR_NAME) {
        if (includeNodeModulesCache) {
          const cache = join(full, NODE_MODULES_CACHE_SUBDIR);
          let cacheStat;
          try {
            cacheStat = statSync(cache);
          } catch {
            cacheStat = null; // no .cache here
          }
          if (cacheStat && cacheStat.isDirectory()) deleteDir(cache, deleted);
        }
        continue; // never recurse further into node_modules for any other reason
      }
      if (names.has(entry.name)) {
        deleteDir(full, deleted);
        continue; // deleted — nothing left under it to walk
      }
      walk(full);
    }
  }
}

// ── plan 4133 S4: pytest's OWN basetemp ─────────────────────────────────────────────────────────
//
// pytest's basetemp (`<tmp root>/pytest-of-<user>/pytest-<n>`, auto-incrementing per session) lives
// under the OS tmp root — entirely outside every root prune() above already walks (mainCheckoutPath,
// worktreesRoot). A chunk-capped land re-invokes the pytest gate repeatedly, and pytest does not
// clean up after itself across a run that is killed mid-suite by the chunk cap, so each attempt
// leaves its OWN basetemp behind. Plan 4110 measured ~3 GB per chunked round, reaching 12 GB across
// eleven rounds — misdiagnosed once as "the cloud box is too small" and handed back on that wrong
// cause (docs/handoff/infra-debt.md, 2026-09-11 x2, 2026-09-22) before this untouched root was
// found to be the actual reason headroom kept dropping.
//
// POSIX-only (Session decision S4): a local Windows box runs several parallel sessions at once,
// each with its own concurrently-live basetemp under the same OS tmp root, and there is no way from
// here to tell "stale" from "another session's run in progress" on it — cloud boxes are
// single-occupancy, which is exactly where the 12 GB accrues, so this sweep is scoped to where
// reaping is safe. `platform` is a PARAMETER (not read from `process.platform` internally) so a
// test can drive both branches without faking global process state — see this module's test file
// for the win32/posix pair.
const BASETEMP_ROOT_NAME_RE = /^pytest-of-/;
const BASETEMP_SESSION_NAME_RE = /^pytest-\d+$/;
const BASETEMP_KEEP_NEWEST = 2;

// A directory's mtime, best-effort. One that vanishes mid-scan (a concurrent process, or this
// process's own earlier delete of a sibling raced by the OS) sorts as oldest (`-Infinity`) rather
// than throwing — it will never be picked as one of the two kept, and deleteDir's own delete
// attempt on it is already a silent no-op by its own contract.
function dirMtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -Infinity;
  }
}

// Best-effort: the directory `<pytestOfDir>/pytest-current` currently points at, resolved to an
// absolute path — `null` on any trouble (no such symlink, a broken link, a read error). pytest only
// ever creates this as a symlink, never a directory of its own, so its target has to be resolved
// explicitly rather than found by walking (the same reason `dirSizeBytes`'s header gives for
// skipping symlinks generally: `readdirSync(..., { withFileTypes: true })` reports a symlink's own
// type, so a bare directory walk would never enter it either way).
function pytestCurrentTarget(pytestOfDir) {
  try {
    const link = readlinkSync(join(pytestOfDir, 'pytest-current'));
    return resolve(pytestOfDir, link);
  } catch {
    return null;
  }
}

// One `pytest-of-*` directory's own prune: keep the BASETEMP_KEEP_NEWEST most-recently-modified
// `pytest-<n>` session dirs, plus whatever `pytest-current` points at right now (usually, but not
// necessarily, one of those two — a long-idle session `pytest-current` still names must never be
// reaped out from under it), and delete every other `pytest-<n>` dir found. Anything under
// `pytest-of-*` that is not a `pytest-<n>` directory (a stray file, some other tool's own
// subdirectory) is left alone entirely — this sweep's contract is the one shape pytest itself
// creates, nothing broader.
function pruneOneBasetempRoot(pytestOfDir, deleted) {
  let entries;
  try {
    entries = readdirSync(pytestOfDir, { withFileTypes: true });
  } catch {
    return;
  }
  const currentTarget = pytestCurrentTarget(pytestOfDir);
  const sessions = entries
    .filter((e) => e.isDirectory() && BASETEMP_SESSION_NAME_RE.test(e.name))
    .map((e) => {
      const full = join(pytestOfDir, e.name);
      return { full, resolved: resolve(full), mtimeMs: dirMtimeMs(full) };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = new Set(sessions.slice(0, BASETEMP_KEEP_NEWEST).map((s) => s.resolved));
  if (currentTarget) keep.add(resolve(currentTarget));
  for (const s of sessions) {
    if (keep.has(s.resolved)) continue;
    deleteDir(s.full, deleted);
  }
}

// The basetemp root itself (`os.tmpdir()` by default; `root` is injectable so a test never has to
// scan — or delete inside — the REAL OS tmp dir, which on a live box can carry another session's
// genuinely in-progress basetemp), swept for every `pytest-of-*` directory it holds. Returns one
// entry per `pytest-of-*` found, in the SAME per-root shape `prune()`'s other roots use — there can
// be more than one when several OS users share the box, and each is kept/pruned independently.
// A missing/unreadable root (nothing has ever run pytest on this box yet) is a silent no-op, same
// convention as `prune()`'s own worktreesRoot half.
function pruneBasetempRoots({ root = tmpdir(), platform = process.platform } = {}) {
  if (platform === 'win32') return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !BASETEMP_ROOT_NAME_RE.test(entry.name)) continue;
    const full = join(root, entry.name);
    const deleted = [];
    pruneOneBasetempRoot(full, deleted);
    const freedBytes = deleted.reduce((sum, d) => sum + d.bytes, 0);
    roots.push({ label: `basetemp:${entry.name}`, path: full, deleted, freedBytes });
  }
  return roots;
}

// Free bytes on the volume containing `targetPath`. Needs Node >=18.15 (`fs.statfsSync`) — fine
// for every cloud sandbox this runs in.
export function checkFreeBytes(targetPath) {
  const stats = statfsSync(targetPath);
  return stats.bavail * stats.bsize;
}

// Prunes `.next`, `.turbo`, and `node_modules/.cache` under `mainCheckoutPath`, and under every
// immediate child directory of `worktreesRoot` except `keep` (the worktree currently being
// landed, matched by resolved path — see the CLI-shape note above for why that is an argument,
// never inferred). Either root is optional (a caller pruning only worktrees, or only the main
// checkout, passes just the one it wants); a missing/unreadable `worktreesRoot` (no worktrees
// dir yet — the routine's own checkout-preflight call, before any worktree is claimed) is a
// silent no-op for that half, not an error.
// plan 4133 S4: `basetempRoot`/`basetempPlatform` are the SAME injection seam as the other two
// roots — optional, defaulting to the real OS tmp dir / real process platform for every production
// caller (the CLI below, and done-worktree-lib.mjs), overridable only so a test can drive the sweep
// against a fixture tree instead of the live box's actual `/tmp`.
export function prune({
  mainCheckoutPath,
  worktreesRoot,
  keep,
  basetempRoot,
  basetempPlatform,
} = {}) {
  const roots = [];
  if (mainCheckoutPath) roots.push({ label: 'main', path: resolve(mainCheckoutPath) });
  if (worktreesRoot) {
    let entries = [];
    try {
      entries = readdirSync(worktreesRoot, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const keepResolved = keep ? resolve(keep) : null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = resolve(join(worktreesRoot, entry.name));
      if (keepResolved && full === keepResolved) continue; // the worktree being landed
      roots.push({ label: `worktree:${entry.name}`, path: full });
    }
  }
  // The main checkout's own walk must never descend into worktreesRoot — see pruneTree's
  // skipDirs doc comment above for why (it sits inside the main checkout in the real repo
  // layout, and only the fan-out loop above knows about `keep`).
  const mainSkipDirs = worktreesRoot ? new Set([resolve(worktreesRoot)]) : undefined;
  let freedBytes = 0;
  let deletedCount = 0;
  const perRoot = roots.map((r) => {
    const deleted = pruneTree(r.path, PRUNE_DIR_NAMES, {
      skipDirs: r.label === 'main' ? mainSkipDirs : undefined,
    });
    const rootFreedBytes = deleted.reduce((sum, d) => sum + d.bytes, 0);
    freedBytes += rootFreedBytes;
    deletedCount += deleted.length;
    return { ...r, deleted, freedBytes: rootFreedBytes };
  });
  // plan 4133 S4: an independent, always-attempted fourth root — see pruneBasetempRoots' own
  // header for why it is unrelated to mainCheckoutPath/worktreesRoot and safe to run regardless of
  // which of those two the caller passed (or neither).
  const basetempRoots = pruneBasetempRoots({ root: basetempRoot, platform: basetempPlatform });
  for (const r of basetempRoots) {
    freedBytes += r.freedBytes;
    deletedCount += r.deleted.length;
  }
  return { roots: [...perRoot, ...basetempRoots], freedBytes, deletedCount };
}

// The post-build half of the cloud land's disk-headroom gate (done-worktree-lib.mjs calls this
// once the production-build gate has reported green, before close-out): the landed worktree's
// OWN `.next` only — never `.turbo` or `node_modules/.cache`, which the NEXT land's pre-build
// prune() call will reclaim anyway, and the worktree is about to be torn down regardless. This
// exists purely to give that next prune() less to do under time pressure. Idempotent: a second
// call finds nothing left under the name and reports 0 bytes freed, so it is always safe to call
// again across a resume.
export function pruneNext(worktreePath) {
  const deleted = pruneTree(worktreePath, new Set(['.next']), { includeNodeModulesCache: false });
  const freedBytes = deleted.reduce((sum, d) => sum + d.bytes, 0);
  return { path: worktreePath, deleted, freedBytes };
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.abs(n);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const sign = n < 0 ? '-' : '';
  // Byte counts (unitIndex 0) are always whole; everything above gets up to 2 decimals with
  // trailing zeros trimmed, so an exact multiple (1 KB, 3 GB) prints clean rather than "1.00 KB".
  const body =
    unitIndex === 0 ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${sign}${body} ${units[unitIndex]}`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────
// Deliberately hand-rolled rather than importing scripts/coord/parse-flags.mjs — this module's one
// hard constraint is "pure node built-ins only, no other scripts/*.mjs import", so it can run
// before `pnpm install` with zero dependency surface, and its flag set (--keep/--root/
// --worktrees-root) is small enough that a shared parser buys nothing here.
function parseCliArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--keep') flags.keep = rest[++i];
    else if (a === '--root') flags.root = rest[++i];
    else if (a === '--worktrees-root') flags.worktreesRoot = rest[++i];
    // plan 4133 review round 1: the third root, symmetric with the two above. Omitted (every
    // production invocation), the basetemp sweep aims at the real `os.tmpdir()`, which is the whole
    // point of S4. Named, it aims somewhere else — which is what lets this module's OWN test drive
    // the CLI without reading or deleting inside the live box's `/tmp`, where a parallel session's
    // in-progress pytest basetemp lives.
    else if (a === '--basetemp-root') flags.basetempRoot = rest[++i];
    else positionals.push(a);
  }
  return { cmd, flags, positionals };
}

export function main(argv) {
  const { cmd, flags, positionals } = parseCliArgs(argv);
  const root = flags.root ? resolve(flags.root) : repoRootFromScript();
  const worktreesRoot = flags.worktreesRoot
    ? resolve(flags.worktreesRoot)
    : join(root, '.claude', 'worktrees');

  if (cmd === 'check') {
    const target = positionals[0] ? resolve(positionals[0]) : root;
    const free = checkFreeBytes(target);
    console.log(`disk-headroom check: ${formatBytes(free)} free (${free} bytes) at ${target}`);
    return 0;
  }

  if (cmd === 'prune') {
    const result = prune({
      mainCheckoutPath: root,
      worktreesRoot,
      keep: flags.keep,
      // undefined unless --basetemp-root was passed, which leaves prune()'s own default (the real
      // OS tmp dir) in place for every production caller.
      basetempRoot: flags.basetempRoot ? resolve(flags.basetempRoot) : undefined,
    });
    console.log(
      `disk-headroom prune: freed ${formatBytes(result.freedBytes)} (${result.freedBytes} bytes) ` +
        `across ${result.deletedCount} director${result.deletedCount === 1 ? 'y' : 'ies'}` +
        (flags.keep ? ` (kept ${flags.keep})` : ''),
    );
    for (const r of result.roots) {
      for (const d of r.deleted) {
        console.log(`  - [${r.label}] ${d.path} (${formatBytes(d.bytes)})`);
      }
    }
    return 0;
  }

  console.error(
    `disk-headroom: unknown or missing command "${cmd ?? ''}" — usage: ` +
      `check [<path>] | prune [--keep <worktree-path>] [--root <path>] [--worktrees-root <path>]`,
  );
  return 2;
}

// CLI only (not when imported by tests or by done-worktree-lib.mjs) — same guard idiom as
// landing-lock.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
