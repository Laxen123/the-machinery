#!/usr/bin/env node
// scripts/prettier-check.mjs — plan 4211: a per-file `prettier --check` wrapper that never
// prints a false clean.
//
// WHY. A hand-run `npx prettier --check <file>` can report "All matched files use Prettier
// code style!" and exit 0 while examining ZERO of the files it was asked about, through two
// mechanisms measured live on prettier 3.8.3 (see plan 4211's spec-pass):
//
//   1. AN IGNORED PATH exits 0 with the success sentence — `--check` on a `.prettierignore`d
//      file silently skips it and still prints success. A genuinely NONEXISTENT path exits 2,
//      but its STDOUT still prints the success sentence (the error goes to stderr only), so an
//      agent reading stdout alone is fooled there too.
//   2. ANY PATH UNDER ANOTHER CHECKOUT'S IGNORE FILES is swallowed when checked from the wrong
//      cwd. Prettier's CLI picks its default ignore FILES (`.gitignore`/`.prettierignore`) from
//      the cwd, and each file's patterns then match relative to THAT FILE's own folder — so a
//      `.claude/worktrees/<slug>/…` file checked with cwd = the MAIN checkout is swallowed by
//      MAIN's own `.gitignore` (`.claude/worktrees/`) and `.prettierignore` (`.claude/`), even
//      though the same file checked from the WORKTREE's own cwd is not ignored at all.
//
// The automated land/push gates are unaffected — they always run with the repo/worktree root as
// cwd and relative paths, so their default ignore-file selection is already correct. This wrapper
// exists for the HAND-RUN shape: a human or agent running `prettier --check` ad hoc.
//
// HOW. Per file, per prettier's Node API — no CLI spawn, no stdout parsing, no success-sentence
// matching:
//   1. Resolve the file's OWNING checkout root via `git rev-parse --show-toplevel` run from the
//      file's OWN folder (never the process cwd) — a worktree file yields the worktree's own
//      root, never main's, because a linked worktree's `--show-toplevel` reports itself.
//   2. `prettier.getFileInfo(file, { ignorePath: [<owningRoot>/.gitignore,
//      <owningRoot>/.prettierignore] })` — ignore files are read from the OWNING root, not the
//      process cwd, closing mechanism 2. A missing ignore file is a silent no-op (prettier's own
//      `readFile` returns undefined on ENOENT), so passing both paths unconditionally is safe.
//   3. Non-ignored: `prettier.resolveConfig(file)` + `prettier.check(source, { ...config,
//      filepath: file })` → CLEAN or DIRTY.
// Every file gets exactly one of four printed verdicts — IGNORED / CLEAN / DIRTY / MISSING —
// and there is no path through which a file that was not actually examined is reported CLEAN.
//
// EXIT CODES: 0 only when every requested file is CLEAN (or IGNORED under `--allow-ignored`);
// 1 if any file is DIRTY and nothing worse; 2 if any file is MISSING, an IGNORED file without
// `--allow-ignored`, a directory argument that expands to zero files, or on a usage error (no
// paths given). Worse trumps DIRTY: 2 outranks 1 outranks 0. A DIRECTORY argument follows
// prettier's own directory semantics for ignored files — they are skipped and counted in one
// `SKIPPED <n> ignored file(s) under <dir>` line rather than failing the run — but a directory in
// which no file at all was examined (empty, or every file ignored) is still MISSING, exit 2.
//
// USAGE: node scripts/prettier-check.mjs <paths…> [--allow-ignored]

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── win32 drive-letter case normalisation ────────────────────────────────────
// `platform` is a PARAMETER, never read inline, so the win32 branch is directly testable from
// any host (mirrors `pathsEqual`/`samePathFamily` elsewhere in this repo's scripts/hooks/**).
// git and node do not always agree on a drive letter's case, and this wrapper joins a
// git-reported root with node-built paths (`join(root, '.gitignore')`), so folding the drive
// letter's case once here keeps that join stable rather than depending on incidental agreement.
export function normalizeDriveCase(p, platform = process.platform) {
  const s = String(p ?? '');
  if (platform !== 'win32') return s;
  return /^[A-Za-z]:[\\/]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

// ── owning checkout root ─────────────────────────────────────────────────────
// `git rev-parse --show-toplevel`, run with cwd = the TARGET's own folder — never the process
// cwd and never a fixed repo root — so a worktree file resolves to the worktree's own top level.
// `_exec` is an injectable seam for tests. Returns null when no repo can be resolved (the target
// sits outside any git checkout); callers fall back to the target's own directory in that case.
export function ownedRootOf(targetPath, { _exec = execFileSync } = {}) {
  const dir = dirname(resolvePath(targetPath));
  try {
    const out = String(
      _exec('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).trim();
    return out ? normalizeDriveCase(out) : null;
  } catch {
    return null;
  }
}

// One `git rev-parse` per DIRECTORY, not per file — a directory argument can expand to hundreds of
// files sharing a handful of folders.
const rootCache = new Map();
function ownedRootCached(abs) {
  const dir = dirname(abs);
  if (!rootCache.has(dir)) rootCache.set(dir, ownedRootOf(abs));
  return rootCache.get(dir);
}

// ── directory expansion ──────────────────────────────────────────────────────
// Every file under `dirAbs`, recursively, sorted for stable output. Three prunes keep a
// directory argument meaning what a hand-run `prettier --check <dir>` means: `.git` and
// `node_modules` are never walked, and neither is a NESTED checkout (a subdirectory carrying its
// own `.git` entry — e.g. `.claude/worktrees/<slug>` under the main checkout), which is another
// tree with its own ignore files and must be named explicitly to be checked. A symlink to a file
// is INCLUDED (a `Dirent` for it is not `isFile()`, which silently dropped it before); a symlink
// to a directory is not followed (no loops). An empty result is the "expands to zero files" case
// the caller reports as MISSING.
const PRUNED_DIR_NAMES = new Set(['.git', 'node_modules']);

export function expandDirectory(dirAbs) {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (PRUNED_DIR_NAMES.has(e.name) || existsSync(join(p, '.git'))) continue;
        walk(p);
      } else if (e.isFile()) {
        files.push(p);
      } else if (e.isSymbolicLink()) {
        try {
          if (statSync(p).isFile()) files.push(p);
        } catch {
          // dangling link — nothing to examine
        }
      }
    }
  };
  walk(dirAbs);
  return files.sort();
}

// ── which ignore file caused an IGNORED verdict ──────────────────────────────
// The combined getFileInfo call above only says "ignored: true/false" for the pair; this makes
// one extra call per ignore file to attribute the specific one, ONLY once a file is already
// known to be ignored, so the common (non-ignored) path stays at one API call.
async function attributeIgnore(prettier, abs, root) {
  const gitignore = join(root, '.gitignore');
  const viaGitignore = await prettier.getFileInfo(abs, { ignorePath: gitignore });
  if (viaGitignore.ignored) return '.gitignore';
  const prettierignore = join(root, '.prettierignore');
  const viaPrettierignore = await prettier.getFileInfo(abs, { ignorePath: prettierignore });
  if (viaPrettierignore.ignored) return '.prettierignore';
  return null; // the combined check said ignored but neither individual file agrees — unreachable
  // in practice (both are the only entries the combined call examined), reported generically.
}

// ── one file's verdict (never a directory — the caller expands those first) ──
// `label` is exactly the string the caller passed in (a CLI arg, or a path this module derived
// while expanding a directory), never a re-derived absolute form, so a relative argument reports
// back as the relative path the caller typed.
export async function checkOnePath(label, { _prettier = null } = {}) {
  const abs = resolvePath(label);
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    return { label, verdict: 'MISSING', detail: null };
  }
  if (stat.isDirectory()) {
    throw new Error(`checkOnePath: '${label}' is a directory — the caller must expand it first`);
  }
  const prettier = _prettier ?? (await import('prettier')).default;
  const root = ownedRootCached(abs) ?? dirname(abs);
  const info = await prettier.getFileInfo(abs, {
    ignorePath: [join(root, '.gitignore'), join(root, '.prettierignore')],
    resolveConfig: true,
  });
  if (info.ignored) {
    const by = await attributeIgnore(prettier, abs, root);
    return { label, verdict: 'IGNORED', detail: by };
  }
  if (!info.inferredParser) {
    // No parser prettier knows how to run on this extension — there is nothing to CLEAN/DIRTY
    // check, so this reports the same as IGNORED (never a false clean) with its own reason.
    return { label, verdict: 'IGNORED', detail: 'no inferred parser' };
  }
  const cfg = (await prettier.resolveConfig(abs)) ?? {};
  const src = readFileSync(abs, 'utf8');
  const clean = await prettier.check(src, { ...cfg, filepath: abs });
  return { label, verdict: clean ? 'CLEAN' : 'DIRTY', detail: null };
}

function formatLine({ label, verdict, detail }) {
  if (verdict === 'IGNORED') return detail ? `IGNORED ${label} (by ${detail})` : `IGNORED ${label}`;
  if (verdict === 'MISSING' && detail) return `MISSING ${label} (${detail})`;
  return `${verdict} ${label}`;
}

function exitCodeFor(verdict, allowIgnored) {
  if (verdict === 'MISSING') return 2;
  if (verdict === 'IGNORED') return allowIgnored ? 0 : 2;
  if (verdict === 'DIRTY') return 1;
  return 0; // CLEAN
}

// ── the whole run, argv → { lines, errors, exitCode } ────────────────────────
// Exported (not just the CLI entry point below) so tests drive it directly without spawning a
// subprocess per case. `_prettier` is the same injectable seam checkOnePath takes, threaded
// through so a test can stand in a fake prettier module for every file in one run.
export async function run(argv, { _prettier = null } = {}) {
  const paths = [];
  let allowIgnored = false;
  for (const a of argv) {
    if (a === '--allow-ignored') allowIgnored = true;
    else paths.push(a);
  }
  if (!paths.length) {
    return {
      lines: [],
      errors: ['usage: node scripts/prettier-check.mjs <paths…> [--allow-ignored]'],
      exitCode: 2,
    };
  }

  const lines = [];
  let worstExit = 0;
  const bump = (code) => {
    if (code > worstExit) worstExit = code;
  };

  for (const label of paths) {
    const abs = resolvePath(label);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch {
      lines.push(formatLine({ label, verdict: 'MISSING', detail: null }));
      bump(2);
      continue;
    }
    if (stat.isDirectory()) {
      const files = expandDirectory(abs);
      if (!files.length) {
        lines.push(
          formatLine({ label, verdict: 'MISSING', detail: 'directory expands to zero files' }),
        );
        bump(2);
        continue;
      }
      // Inside a directory argument an ignored file is SKIPPED and counted (prettier's own
      // directory semantics), never failed — but the skip is always printed, and a directory in
      // which NOTHING was examined is still MISSING (exit 2), so no directory reads as clean
      // without at least one file actually checked.
      let examined = 0;
      let skipped = 0;
      for (const f of files) {
        const result = await checkOnePath(f, { _prettier });
        if (result.verdict === 'IGNORED') {
          skipped++;
          continue;
        }
        examined++;
        lines.push(formatLine(result));
        bump(exitCodeFor(result.verdict, allowIgnored));
      }
      if (!examined) {
        lines.push(
          formatLine({
            label,
            verdict: 'MISSING',
            detail: `directory expands to zero checkable files; ${skipped} ignored`,
          }),
        );
        bump(2);
      } else if (skipped) {
        lines.push(`SKIPPED ${skipped} ignored file(s) under ${label}`);
      }
      continue;
    }
    const result = await checkOnePath(label, { _prettier });
    lines.push(formatLine(result));
    bump(exitCodeFor(result.verdict, allowIgnored));
  }
  return { lines, errors: [], exitCode: worstExit };
}

// ── CLI entry point ───────────────────────────────────────────────────────────
async function main() {
  const { lines, errors, exitCode } = await run(process.argv.slice(2));
  for (const line of lines) process.stdout.write(`${line}\n`);
  for (const err of errors) process.stderr.write(`${err}\n`);
  // process.exitCode, not process.exit(): lets stdout/stderr flush before the process exits.
  process.exitCode = exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
