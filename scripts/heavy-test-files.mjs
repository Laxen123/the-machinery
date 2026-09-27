#!/usr/bin/env node
// scripts/heavy-test-files.mjs — regenerates scripts/coord/heavy-test-files.json (plan 4241 Task 2).
//
// WHAT THIS FILE OWNS. The MEASURED list of `node --test` files whose LAST recorded run took
// ≥HEAVY_TEST_THRESHOLD_MS on this box — the data half of the "a known-heavy single-file test run
// takes a test-queue ticket" rule. scripts/hooks/hand-rolled-step-guard.mjs (the guard half) reads
// the JSON this module writes; neither module talks to the other beyond that file. See plan 4241 §
// Session decisions for the full design record (S1-S7); this header only restates what a reader of
// THIS file needs.
//
// WHY MEASURED, NEVER HAND-MAINTAINED (S1). A hand-typed heavy-file list is exactly the kind of
// rule the operator's standing "fewer rules" direction refuses — it would need a human to notice a
// file got slow (or fast) and edit a list nobody re-checks. This module is a pure FUNCTION of the
// per-file `durationMs` data scripts/coord/battery-ledger.mjs already records (plan 4236 T5), so the
// list self-corrects on the next `regenerate` call: a file that got faster silently drops off next
// time, no edit required.
//
// WHY THE LAST RECORDED VALUE, NOT AN AVERAGE OR A MINIMUM (S3). "Unloaded" duration is not
// observable from the ledger — every reading is whatever the box's load happened to be at that
// moment. Taking a file's LAST recorded value means a loaded reading can put a file on the list even
// though it usually runs fast; that errs toward TAKING a ticket, the safe direction (a spurious
// ticket costs a queue wait; a missing one costs an unticketed multi-minute run beside a battery).
// It self-corrects on the very next faster run, so nothing here tunes for "how loaded is too
// loaded" — that is deliberately not a question this module answers.
//
// WHERE THE DATA COMES FROM. Every `.scratch/gate-ledgers/<key>.json` entry directly under the
// ROOT ledger dir (never its `pytest/` subdirectory — a SEPARATE namespace for a different runner;
// see battery-ledger.mjs's own header) is a node:test battery-ledger entry, one per distinct content
// key this box has proven green under. `readDurations` (battery-ledger.mjs) already decides per-key
// TRUST (TTL, shape, corruption) — this module never re-derives that; it only decides, for a file
// more than one LIVE key recorded, which key's value is the more recent one (by the entry's own
// `iso` timestamp, read directly — ordering is not a trust question).
//
// WHY THE MAIN CHECKOUT ROOT, NOT process.cwd(). A worktree's own `.scratch/` dies with the
// worktree at teardown, so a worktree-run `regenerate` reading its OWN ledger would almost always
// see nothing. The guard fires on THIS Windows box (plan 4241 S6, cloudExec: false), so the
// measurement must read the shared checkout's ledger — the one every session's battery run actually
// writes to. `--ledger-dir` overrides this for a deliberate one-off; tests always pass a fixture
// dir straight into the exported functions and never reach this resolution at all.
//
// FAIL DIRECTION: every doubt here empties the list, never invents one. A missing/unreadable ledger
// dir, a corrupt entry, an unparseable `iso` — all read as "no evidence", which the CALLER (this
// file's own `regenerate` subcommand, and the guard reading its output) already treats as
// ALLOW-everything. Nothing here can cause a file to be LISTED that the ledger never actually
// measured at or above the threshold.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDurations, resolveLedgerDir, DEFAULT_TTL_MIN } from './coord/battery-ledger.mjs';
import { repoRootFrom, scriptsFileFrom } from './coord/scripts-anchor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = repoRootFrom(HERE);
export const HEAVY_TEST_FILES_JSON = scriptsFileFrom('coord/heavy-test-files.json', HERE); // dangling-ok: scriptsFileFrom resolves it under scripts/

// S3, pinned as one constant — not a tunable, per S1's "the threshold is one constant in the
// regenerator, not a tunable rule family".
export const HEAVY_TEST_THRESHOLD_MS = 600_000;

const LEDGER_KEY_RE = /^([0-9a-f]{32})\.json$/;

// Every battery-ledger key directly under `ledgerDir` (never its `pytest/` subdirectory — see the
// module header). Absent/unreadable dir ⇒ no keys ⇒ no evidence, the fail-safe direction.
function listLedgerKeys(ledgerDir) {
  let names;
  try {
    names = readdirSync(ledgerDir);
  } catch {
    return [];
  }
  const keys = [];
  for (const name of names) {
    const m = LEDGER_KEY_RE.exec(name);
    if (m) keys.push(m[1]);
  }
  return keys;
}

// One key's `iso` timestamp, read directly (not through readDurations, which already answered the
// TRUST question) — used ONLY to decide which of several LIVE keys recorded a file's more RECENT
// duration. '' (sorts before any real ISO string) on any doubt, so a corrupt/missing entry never
// wins a comparison it has no evidence for.
function entryIso(ledgerDir, key) {
  try {
    const raw = JSON.parse(readFileSync(join(ledgerDir, `${key}.json`), 'utf8'));
    return typeof raw?.iso === 'string' ? raw.iso : '';
  } catch {
    return '';
  }
}

// S2/S3: every file's LAST recorded durationMs across every LIVE key in `ledgerDir`, sorted
// descending (ties broken by file path, for a stable/testable order). `readDurations` decides
// per-key trust; this function only decides recency across keys that both cleared that bar.
export function measureDurations(ledgerDir, { nowMs = Date.now(), ttlMin = DEFAULT_TTL_MIN } = {}) {
  const latest = new Map(); // file -> { ms, iso }
  for (const key of listLedgerKeys(ledgerDir)) {
    const durations = readDurations(ledgerDir, key, nowMs, ttlMin);
    if (Object.keys(durations).length === 0) continue;
    const iso = entryIso(ledgerDir, key);
    for (const [file, ms] of Object.entries(durations)) {
      const prev = latest.get(file);
      if (!prev || iso > prev.iso) latest.set(file, { ms, iso });
    }
  }
  return [...latest.entries()]
    .map(([file, { ms }]) => ({ file, durationMs: ms }))
    .sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file));
}

// S3's threshold applied, file paths only (the shape both the JSON and the guard want).
export function heavyFilesAtOrAbove(ledgerDir, thresholdMs = HEAVY_TEST_THRESHOLD_MS, opts) {
  return measureDurations(ledgerDir, opts)
    .filter((r) => r.durationMs >= thresholdMs)
    .map((r) => r.file);
}

// The MAIN checkout root — see the module header's "WHY THE MAIN CHECKOUT ROOT" section. `_exec` is
// an injectable seam (mirrors pass-cache-kernel.mjs's own git DI convention) so a test never spawns
// a real git process; every doubt (a non-git cwd, a spawn failure, a non-zero exit) falls back to
// `REPO_ROOT` itself, which degrades to "read this checkout's own .scratch/" — never a throw.
export function resolveMainCheckoutRoot(cwd = REPO_ROOT, { _exec = spawnSync } = {}) {
  let res;
  try {
    res = _exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
    });
  } catch {
    return REPO_ROOT;
  }
  if (!res || res.status !== 0 || typeof res.stdout !== 'string') return REPO_ROOT;
  const gitCommonDir = res.stdout.trim();
  return gitCommonDir ? dirname(gitCommonDir) : REPO_ROOT;
}

// Writes `path` with the measured list. `files` is de-duplicated and sorted for a stable diff;
// `thresholdMs` plus `source`/`generatedAt` are the "threshold and the ledger key/date it was
// generated from" metadata the plan asks for (Task 2) — global, not per-file, because one
// `regenerate` call is one atomic measurement over the whole ledger, not a per-file provenance
// record.
export function writeHeavyTestFilesJson(
  files,
  {
    thresholdMs = HEAVY_TEST_THRESHOLD_MS,
    source = null,
    path = HEAVY_TEST_FILES_JSON,
    now = new Date(),
  } = {},
) {
  const payload = {
    thresholdMs,
    generatedAt: now.toISOString(),
    source,
    files: [...new Set(files)].sort(),
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'regenerate') {
    process.stderr.write(
      'usage: node scripts/heavy-test-files.mjs regenerate [--ledger-dir <dir>] [--out <path>]\n',
    );
    process.exitCode = 2;
    return;
  }
  let ledgerDirArg = null;
  let outArg = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--ledger-dir') ledgerDirArg = args[++i];
    else if (args[i] === '--out') outArg = args[++i];
  }
  const root = resolveMainCheckoutRoot();
  const ledgerDir = ledgerDirArg ? resolve(ledgerDirArg) : resolveLedgerDir(root);
  const outPath = outArg ? resolve(outArg) : HEAVY_TEST_FILES_JSON;
  const files = heavyFilesAtOrAbove(ledgerDir);
  const payload = writeHeavyTestFilesJson(files, { source: ledgerDir, path: outPath });
  process.stdout.write(
    `heavy-test-files: ${payload.files.length} file(s) at/above ${payload.thresholdMs}ms, from ${ledgerDir} -> ${outPath}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
