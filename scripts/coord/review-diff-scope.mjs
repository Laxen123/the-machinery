#!/usr/bin/env node
// scripts/coord/review-diff-scope.mjs — the ONE source of truth for which paths a code
// review's finder diff leaves out (plan 3093).
//
// WHY THIS EXISTS. The 3035 land's range (origin/master...worktree-3035-FABLE-Pipe-
// run-2141-study-wave-b) was 719 changed files / 19.5 MB of `diff.patch`, and the bulk
// of it was committed wave artifacts (backend/data/regression-study-2141/**,
// backend/data/job-pipeline/** batches and renders) rather than code. Two of the 11
// `/gpt-review` finder angles (A and C) hit the hardcoded 900 s per-finder cap on BOTH
// genuine attempts while the other nine finished in 371-685 s, and the Claude
// data-grounding arm died `spawn ENAMETOOLONG` on an argument built from the same
// unscoped file set. The runner correctly refused to report on incomplete coverage,
// which forced a full `/sonnet-review` re-fan-out for a diff whose reviewable code was
// a small fraction of its bytes. Asked whether to raise the timeout instead, the
// operator chose the structural fix, verbatim: "do this" (2026-08-11).
//
// WHAT IS EXCLUDED AND WHY IT IS SAFE. The land gate mandates review for
// `frontend/src/**`, `backend/src/**`, `shared/src/**`, `scripts/**` (CLAUDE.md § Plans,
// specs, landing) and exempts docs/plans/config-only diffs by the same policy. The
// excluded paths are committed DATA, not reviewable source, and contribute zero signal
// to a finder prompt while (as 3035 proved) costing enough bytes to starve one.
//
// PLAN 4071 T2 — CALLER-INJECTED, NOT SELF-RESOLVED. This module used to hardcode the
// project's own exclude roots (`backend/data`, `backend/src/data/seed`) alongside the two
// generic ones. `scripts/test-helpers/isolated-plan-repo.mjs` copies only the `scripts/`
// tool tree into its fixtures, so `coord.config.json` (which lives at the repo root) is
// absent there — a module that resolved it FOR ITSELF would silently read the empty
// defaults under test. Per this repo's caller-injects rule (plan 4071 Rule 1), every pure
// helper below takes the project's exclude list as a parameter (`reviewDiffExcludesFor`
// turns coord.config.json's `reviewDiffExcludes` row into that list); only `main()` — a
// CLI entry point whose sole caller is the shell — resolves the config, once, and passes
// the merged list down. `scripts/gpt-review.mjs` does the equivalent at its own CLI-entry
// boundary (it also supports `--repo <path>`, so its config must come from the repo under
// review, not from this checkout).
//
// NO SILENT TRUNCATION. Both lanes still NAME how many files the exclusion dropped, in
// the scope block every finder reads, so a reviewer always knows data moved even though
// its hunks are absent. `excludedNote()` is that sentence, shared like the list itself.
//
// CONSUMED TWO DIFFERENT WAYS, ONE LIST. `scripts/gpt-review.mjs` imports the helpers
// directly. `.claude/workflows/sonnet-review.js` cannot import anything — the Workflow
// runtime has no filesystem or Node API access — but its SCOPE AGENT runs Bash, so that
// lane shells out to this file's CLI (`materialize` / `pathspecs`) instead. That is the
// whole reason the rule lives in `scripts/` as a module WITH a CLI rather than as a
// constant inside either lane: two copies of an exclude list is the drift shape this
// repo has paid for before.
//
// Usage (CLI):
//   node scripts/coord/review-diff-scope.mjs materialize --out <file> <base> <head> [--include-worktree]
//   node scripts/coord/review-diff-scope.mjs pathspecs
//   node scripts/coord/review-diff-scope.mjs note-for <target...> [-- <pathspec...>]
//   node scripts/coord/review-diff-scope.mjs note <excludedCount>
//
// `materialize` writes the SCOPED patch and prints one JSON line describing it
// (outPath, bytes, files, excludedFiles, note, diffCommand) — the default-path lane's one
// call. `pathspecs` prints the shell-quoted exclude tail to append to a diff command built
// some other way, and `note-for` returns the finished no-silent-truncation sentence for
// that same hand-built command — together, the explicit-target lane's two calls. `note`
// is the raw count-to-sentence form for a caller that already knows the number.
// Every CLI subcommand resolves the excludes from `<cwd>/coord.config.json` (this module's
// existing contract already treats `cwd` as the repo root — every git call below runs
// unqualified, relying on it).

import { execFileSync } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GIT_MAXBUFFER } from './coord-git.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';
import { loadCoordConfig } from './coord-config.mjs';

// The CORE generic excludes — apply to ANY project, never vetapp-specific (plan 4071 T2):
// `output/` (committed review reports) and `pnpm-lock.yaml` are the two coord-config.mjs's
// own `reviewDiffExcludes` comment names as staying in the module; `input/` (raw asset
// uploads — a staging dir any project's asset pipeline uses the same way) is equally
// project-agnostic and stays here too, because coord.config.json's `reviewDiffExcludes` key
// is documented to carry only a project's own ADDITIONS on top of this list, not a second
// place for a second generic entry.
export const CORE_REVIEW_DIFF_EXCLUDES = Object.freeze(['output', 'input', 'pnpm-lock.yaml']);

// Reviewable SOURCE ROOTS the land gate makes mandatory (CLAUDE.md § Plans, specs, landing:
// "frontend/src/**, backend/src/**, shared/src/**, scripts/**"). plan 4071 review round 1
// (finding e26400): `gpt-review.mjs` reads `reviewDiffExcludes` from the repo UNDER REVIEW,
// so a branch whose OWN coord.config.json adds e.g. "scripts" or "backend/src" would make its
// own changed source vanish from every finder patch -- the mandatory review would run,
// report a clean scope, and never have seen the code it exists to check. `reviewDiffExcludesFor`
// below refuses (loudly) any configured entry that COVERS one of these roots -- equal to it,
// or an ANCESTOR of it -- while an entry NESTED INSIDE a root (`backend/src/data/seed`,
// committed data a source root happens to contain) is unaffected: it narrows what is hidden,
// it does not hide the root.
//
// Deliberately hardcoded here rather than config-driven, unlike CORE_REVIEW_DIFF_EXCLUDES
// above: config that arrives FROM the reviewed branch cannot also be the channel that defines
// what that branch is forbidden to hide from its own review, or the protection defends
// against nothing. A future non-vetapp checkout of this coord tooling with different
// source-root names is out of this fix's scope.
export const MANDATORY_REVIEW_SOURCE_ROOTS = Object.freeze([
  'frontend/src',
  'backend/src',
  'shared/src',
  'scripts',
]);

// A configured `reviewDiffExcludes` entry must be a LITERAL repo-relative path -- no glob,
// no pathspec magic, no decoration. Plan 4071 review round 3 (nine findings: 356638,
// 08b412, 63eba4, ed6453, ca1d60, fa5d8b, df853d, cd8623, ac6a9e) found that accepting
// globs AT ALL was the defect, not merely how the earlier normalizer recognized them: a
// mid-segment wildcard (`*/src/**`, `scr*pts`, `backend/s*rc`) passes the equality/ancestor
// root check below but git's pathspec expands it to cover a protected root anyway, and even
// an accepted glob that does NOT hit a root reaches git as a glob-aware `:(top,exclude)`
// pathspec while `isExcludedPath` does plain literal-prefix matching -- so the JS partition
// and the git pathspec can silently disagree about which files were excluded, which is
// exactly the silent-truncation class round 1 existed to fix. There is no normalizer any
// more: refuse anything that is not already the literal path git and this module both use,
// so the two mechanically cannot disagree.
//
// Refused: any glob/pathspec-magic character (`* ? [ ] { } \`), a leading `:` (pathspec
// magic like `:(glob)x`), a leading `./` or `/`, a trailing `/`, a `..` path segment, and
// the empty string. Accepted: a plain repo-relative path with none of the above, exactly as
// configured -- `backend/data`, `backend/src/data/seed`, and any future addition of the
// same shape.
const EXCLUDE_ENTRY_MAGIC_RE = /[*?[\]{}\\]/;

function assertLiteralExcludeEntry(raw) {
  const p = String(raw);
  if (p === '') {
    throw new Error(
      "review-diff-scope: coord.config.json's reviewDiffExcludes entry is an empty string -- " +
        'refusing.',
    );
  }
  if (p.startsWith(':') || p.includes('**') || EXCLUDE_ENTRY_MAGIC_RE.test(p)) {
    throw new Error(
      `review-diff-scope: coord.config.json's reviewDiffExcludes entry "${raw}" contains a ` +
        'glob or pathspec-magic character -- configured excludes must be literal repo-relative ' +
        "paths, never a glob or pathspec pattern, so git's pathspec and this module's own " +
        'literal-prefix check can never disagree about what it covers.',
    );
  }
  if (p.startsWith('./') || p.startsWith('/') || p.endsWith('/')) {
    throw new Error(
      `review-diff-scope: coord.config.json's reviewDiffExcludes entry "${raw}" is decorated ` +
        '(a leading "./" or "/", or a trailing "/") -- refusing rather than normalizing it, so ' +
        'what is configured is exactly what is used.',
    );
  }
  if (p.split('/').includes('..')) {
    throw new Error(
      `review-diff-scope: coord.config.json's reviewDiffExcludes entry "${raw}" contains a ` +
        '".." path segment -- refusing.',
    );
  }
  return p;
}

// The core list plus a project's own additions (coord.config.json's `reviewDiffExcludes`
// row), deduplicated, core first. This is the "function OF the value" plan 4071's Rule 1
// requires: every pure helper below takes the MERGED list as a parameter (default
// CORE_REVIEW_DIFF_EXCLUDES, so a caller that never heard of coord.config.json still gets
// safe generic behavior) — the caller resolves the project's config and merges it here.
//
// plan 4071 review round 1 (finding e26400): validates every config-provided entry against
// MANDATORY_REVIEW_SOURCE_ROOTS first and THROWS on the first one that would hide a root
// wholesale — a loud refusal, not a silent drop, because a dropped-but-unremarked entry is
// exactly the kind of "looks fine, isn't" state this whole module exists to avoid (see the
// NO SILENT TRUNCATION header note above). Both call sites of this function
// (review-diff-scope.mjs's own `main()` and gpt-review.mjs) leave this uncaught, so the
// refusal reaches the terminal as a hard, named failure in either lane without either file
// needing its own check.
//
// plan 4071 review round 2 (key 876800): `protectedRoots` used to be a caller-overridable
// parameter, which meant any caller could pass `[]` (or anything short of the real list) and
// disable a MANDATORY safeguard. It is now the frozen constant, full stop -- a test that
// needs to exercise a different root set asserts against the real constant instead of
// injecting a substitute one.
export function reviewDiffExcludesFor(configExcludes = []) {
  for (const raw of configExcludes) {
    const literal = assertLiteralExcludeEntry(raw);
    const covered = MANDATORY_REVIEW_SOURCE_ROOTS.find(
      (root) => literal === root || root.startsWith(`${literal}/`),
    );
    if (covered) {
      throw new Error(
        `review-diff-scope: coord.config.json's reviewDiffExcludes entry "${raw}" would hide ` +
          `the mandatory review root "${covered}" from every code review (CLAUDE.md § Plans, ` +
          `specs, landing) -- refusing. An entry NESTED inside a root (e.g. "${covered}/data/` +
          `seed") is fine; an entry equal to, or an ancestor of, the root itself is not.`,
      );
    }
  }
  const out = [...CORE_REVIEW_DIFF_EXCLUDES];
  for (const p of configExcludes) if (!out.includes(p)) out.push(p);
  return out;
}

// `top` magic pins each pattern to the repo root, so the pathspecs mean the same thing
// no matter which subdirectory a caller happens to run git from. These strings are built
// HERE and handed to git as an argv array (never through a shell), so MSYS path mangling
// on Windows never sees them.
export function excludePathspecs(excludes = CORE_REVIEW_DIFF_EXCLUDES) {
  return excludes.map((p) => `:(top,exclude)${p}`);
}

// The pathspec tail of a scoped diff: the excludes and NOTHING ELSE. Deliberately NOT
// prefixed with a `:/` "match everything" pathspec — git already applies a pathspec list
// made only of exclusions to every path, so `:/` would buy nothing and would COST the one
// property that matters here: this tail must be safe to append to a diff command someone
// else already narrowed. `git diff X -- frontend/src/foo.ts :/ :(top,exclude)…` widens
// that review back to the whole repo; without the `:/` it stays narrowed and merely drops
// the data artifacts (verified: a `-- scripts :(top,exclude)backend/data` diff returns the
// 6 scripts files, not the repo). Round-1 review caught this on the sonnet-review
// explicit-target branch, which appends exactly this tail.
export function scopedPathspecs(excludes = CORE_REVIEW_DIFF_EXCLUDES) {
  return excludePathspecs(excludes);
}

// Full argv for `git <...>`. `gitArgs` carries diff options (e.g. `--name-only`), which
// git requires BEFORE the commits; `targets` is either a resolved (base, head) pair or a
// single range string. The `--` separator is mandatory: without it git would try to
// resolve a leading `:` pathspec as a revision first.
export function scopedDiffArgs(targets, gitArgs = [], excludes = CORE_REVIEW_DIFF_EXCLUDES) {
  return ['diff', ...gitArgs, ...targets, '--', ...scopedPathspecs(excludes)];
}

// Single-quote for a POSIX shell, so the printed `diffCommand` can be pasted verbatim.
// Pathspecs contain `:`, `(`, `)` and `!` — unquoted, a shell would mangle them.
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function scopedDiffCommand(targets, gitArgs = [], excludes = CORE_REVIEW_DIFF_EXCLUDES) {
  // Only the pathspecs need quoting; they are the only tokens that start with `:`, and
  // diff options / commits / ranges must stay bare to remain readable and pasteable.
  const args = scopedDiffArgs(targets, gitArgs, excludes).map((a) =>
    a.startsWith(':') ? shellQuote(a) : a,
  );
  return ['git', ...args].join(' ');
}

// Path membership, mirroring git's own component-boundary rule so the JS-side partition
// and the git-side pathspec can never disagree about a file. Backslashes are normalized
// because `git diff --name-only` output is normalized to forward slashes elsewhere in
// this repo's tooling and a caller may hand us either.
export function isExcludedPath(path, excludes = CORE_REVIEW_DIFF_EXCLUDES) {
  const p = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
  return excludes.some((ex) => p === ex || p.startsWith(ex + '/'));
}

// Split a changed-file list into what the finders see and what the exclusion dropped.
// Callers use `included` as the scope block's file list and `excluded.length` for the
// note — one pass over a list they already had, rather than a second `git diff` call.
export function partitionPaths(paths, excludes = CORE_REVIEW_DIFF_EXCLUDES) {
  const included = [];
  const excluded = [];
  for (const p of paths) (isExcludedPath(p, excludes) ? excluded : included).push(p);
  return { included, excluded };
}

// The no-silent-truncation sentence. Empty string when nothing was dropped, so a normal
// code-only review's scope block is byte-unchanged from before this plan.
export function excludedNote(excludedCount, excludes = CORE_REVIEW_DIFF_EXCLUDES) {
  if (!excludedCount) return '';
  return (
    // "changed", never "committed": with `--include-worktree` an excluded file may be an
    // UNCOMMITTED working-tree edit, and calling it committed hands the reviewer false
    // provenance about what the range did (round-2 review, 6 findings across 5 angles).
    `Excluded from this diff: ${excludedCount} changed data-artifact file(s) under ` +
    `${excludes.join(', ')}. Those paths carry no reviewable source (seed rows ` +
    'have their own seed-diff gates), so their hunks are deliberately absent. Do not ' +
    'report findings against them and do not run `git diff` yourself to recover them.'
  );
}

function runGit(args, cwd) {
  // GIT_MAXBUFFER, not Node's 1 MB default: without it the `--name-only` call dies ENOBUFS
  // on the PATH LIST alone — plan 2840's corpus re-render changes ~6,100 paths, ~800 KB of
  // names, and the review could not run at all. The failure surfaces as a transport error,
  // which routes to the /sonnet-review fallback instead of naming the size limit. (Rationale
  // carried over from scripts/gpt-review.mjs, whose inline calls this replaced.)
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_MAXBUFFER,
    env: gitRepoIsolatedEnv(),
  });
}

function nameOnly(targets, cwd) {
  return (
    runGit(['diff', '--name-only', ...targets], cwd)
      .split(/\r?\n/)
      // NOT `.trim()`: a leading or trailing space is legal in a path, and trimming it
      // silently yields a filename that matches nothing downstream. Splitting on /\r?\n/
      // already removed the only whitespace that was ever noise here (the CR).
      .map((f) => f.replace(/\\/g, '/'))
      .filter(Boolean)
  );
}

// The changed-file split for a review scope. UNSCOPED `--name-only`, partitioned in JS
// rather than a second scoped git call — same answer, one spawn, and the excluded COUNT
// falls out exactly.
//
// `includeWorktree` must mirror whatever the PATCH covers. When the patch appends the
// working-tree diff, its files belong in this list too: round-1 review caught (7 findings
// across 4 angles) that a file changed only in the working tree appeared as hunks in the
// artifact while being absent from the reported file list — so the scope block would show
// a finder a diff for a file it was told had not changed.
export function changedFilePartition({
  targets,
  includeWorktree = false,
  cwd,
  excludes = CORE_REVIEW_DIFF_EXCLUDES,
}) {
  const seen = new Set();
  const all = [];
  for (const set of includeWorktree ? [targets, ['HEAD']] : [targets]) {
    for (const f of nameOnly(set, cwd)) {
      if (seen.has(f)) continue;
      seen.add(f);
      all.push(f);
    }
  }
  return partitionPaths(all, excludes);
}

// Assemble and write the scoped patch. Split out from `materializeScopedDiff` so
// `scripts/gpt-review.mjs` can reuse the patch assembly WITHOUT re-running the file
// listing it already did (its empty-range guard must run — and short-circuit — before
// codex is ever bootstrapped, so it needs the two halves in that order). Round-1 review's
// altitude angle flagged the alternative: gpt-review hand-rolling its own `git diff` +
// write beside this one.
export function writeScopedPatch({
  targets,
  outPath,
  includeWorktree = false,
  cwd,
  excludes = CORE_REVIEW_DIFF_EXCLUDES,
}) {
  const out = resolvePath(outPath);
  mkdirSync(dirname(out), { recursive: true });

  // The exclusion is applied at diff ASSEMBLY, never post-filtered from a huge patch:
  // the excluded hunks must not exist in the artifact at any point, which is the whole
  // point of the plan (a 19.5 MB patch we then trim is still a 19.5 MB patch on disk and
  // still an ENAMETOOLONG-sized file list on the way there).
  const patch = runGit(scopedDiffArgs(targets, [], excludes), cwd);
  writeFileSync(out, patch);

  const commands = [scopedDiffCommand(targets, [], excludes)];
  let worktreePatch = '';
  if (includeWorktree) {
    worktreePatch = runGit(scopedDiffArgs(['HEAD'], [], excludes), cwd);
    if (worktreePatch.length > 0) {
      appendFileSync(out, worktreePatch);
      commands.push(scopedDiffCommand(['HEAD'], [], excludes));
    }
  }

  return {
    outPath: out,
    bytes: statSync(out).size,
    patch: patch + worktreePatch,
    // Every command needed to reproduce EVERYTHING in the artifact — the sonnet-review
    // contract for `diffCommand` is that a narrower command would silently review less
    // than the artifact did.
    diffCommand: commands.join(' && '),
  };
}

// How many files a caller's OWN diff command loses to the exclusion. The explicit-target
// lane builds its command itself (a PR number, a branch, a path), so it cannot go through
// `materializeScopedDiff` — but it still owes its finders the no-silent-truncation
// sentence. Round-3 review (2 findings) had that lane doing the arithmetic in the PROMPT:
// build two `--name-only` commands, subtract the counts. Unspecified subtraction order, no
// test, and a wrong sign silently yields "No changes found to review" on a data-only PR.
// One git call and a JS partition here instead — the same primitive the default path uses.
export function excludedCountFor({
  targets,
  pathspecs = [],
  cwd,
  excludes = CORE_REVIEW_DIFF_EXCLUDES,
}) {
  const args = [
    'diff',
    '--name-only',
    ...targets,
    ...(pathspecs.length ? ['--', ...pathspecs] : []),
  ];
  const all = runGit(args, cwd)
    .split(/\r?\n/)
    .map((f) => f.replace(/\\/g, '/'))
    .filter(Boolean);
  return partitionPaths(all, excludes).excluded.length;
}

// Materialize the scoped patch for a range, optionally appending the scoped working-tree
// diff (the sonnet-review scope agent's "if there are uncommitted changes" step). Returns
// the same shape the CLI prints so a Node caller could reuse it without re-parsing JSON.
export function materializeScopedDiff({
  targets,
  outPath,
  includeWorktree = false,
  cwd,
  excludes = CORE_REVIEW_DIFF_EXCLUDES,
}) {
  const written = writeScopedPatch({ targets, outPath, includeWorktree, cwd, excludes });
  const { included, excluded } = changedFilePartition({ targets, includeWorktree, cwd, excludes });
  return {
    outPath: written.outPath,
    bytes: written.bytes,
    files: included,
    excludedFiles: excluded.length,
    note: excludedNote(excluded.length, excludes),
    diffCommand: written.diffCommand,
  };
}

function usage() {
  console.error(
    'usage: review-diff-scope.mjs materialize --out <file> <base> <head> [--include-worktree]\n' +
      '       review-diff-scope.mjs pathspecs\n' +
      '       review-diff-scope.mjs note <excludedCount>\n' +
      '       review-diff-scope.mjs note-for <target...> [-- <pathspec...>]',
  );
  return 2;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const sub = argv[0];
  // Resolve the project's excludes ONCE, here — this is the CLI entry point plan 4071's
  // Rule 1 carves out ("the chain genuinely terminates at a CLI entry point whose only
  // caller is the shell, that entry point resolves the config once and passes it down").
  // `cwd` already stands in for the repo root by this module's existing contract (every
  // git call above runs unqualified, relying on cwd being the repo), so it is also the
  // right place to read `coord.config.json` from — no scripts-anchor walk needed here.
  const excludes = reviewDiffExcludesFor(loadCoordConfig(cwd).reviewDiffExcludes);
  if (sub === 'pathspecs') {
    console.log(scopedPathspecs(excludes).map(shellQuote).join(' '));
    return 0;
  }
  // The explicit-target lane builds its own diff command, so it never goes through
  // `materialize` and would otherwise have no way to produce the no-silent-truncation
  // sentence — leaving its data-only reviews to report "No changes found" (round-2 review,
  // 3 findings). It counts its own dropped files and asks for the sentence here, so the
  // wording still lives in exactly ONE place.
  if (sub === 'note') {
    const n = Number(argv[1]);
    if (!Number.isInteger(n) || n < 0) return usage();
    console.log(excludedNote(n, excludes));
    return 0;
  }
  // The explicit-target lane's one call: hand it the SAME targets and pathspecs its own
  // diff command uses, and it gets the finished sentence back — no prompt-side arithmetic.
  if (sub === 'note-for') {
    const rest = argv.slice(1);
    const sep = rest.indexOf('--');
    const targets = sep === -1 ? rest : rest.slice(0, sep);
    const pathspecs = sep === -1 ? [] : rest.slice(sep + 1);
    if (targets.length === 0) return usage();
    try {
      console.log(excludedNote(excludedCountFor({ targets, pathspecs, cwd, excludes }), excludes));
    } catch (e) {
      console.error(`[review-diff-scope] git diff failed for ${targets.join(' ')}: ${e.message}`);
      return 2;
    }
    return 0;
  }
  if (sub !== 'materialize') return usage();

  const rest = argv.slice(1);
  let outPath = null;
  let includeWorktree = false;
  const targets = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--out') outPath = rest[++i];
    else if (rest[i] === '--include-worktree') includeWorktree = true;
    else targets.push(rest[i]);
  }
  if (!outPath || targets.length === 0) return usage();

  let result;
  try {
    result = materializeScopedDiff({ targets, outPath, includeWorktree, cwd, excludes });
  } catch (e) {
    console.error(`[review-diff-scope] git diff failed for ${targets.join(' ')}: ${e.message}`);
    return 2;
  }
  // One JSON line on stdout: the scope agent reads it as its structured result. `files`
  // is the full list (not a count) because that lane's scope schema wants the paths.
  console.log(JSON.stringify(result));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
