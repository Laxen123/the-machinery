// scripts/prettier-check.test.mjs — name-paired test for scripts/prettier-check.mjs (plan 4211).
//
// Every case builds a REAL git repo (never asserts on ambient machine state — see
// test-helpers/no-repo-root.mjs's own header for why a bare mkdtempSync root is not enough for
// the no-repo case) and, for the false-green reproduction, a REAL `git worktree add` nested under
// `<main>/.claude/worktrees/x` — the exact physical layout this repo's own `.gitignore`
// (`.claude/worktrees/`) and `.prettierignore` (`.claude/`) create for every plan worktree.
//
// Cases (a)-(e) below are the plan's own acceptance list, each red before scripts/prettier-check.mjs
// existed (module-not-found) and green after.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkOnePath,
  expandDirectory,
  normalizeDriveCase,
  ownedRootOf,
  run,
} from './prettier-check.mjs';
import { makeNoRepoRoot } from './test-helpers/no-repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(HERE, 'prettier-check.mjs');

// `ownedRootOf` deliberately returns git's own `--show-toplevel` form (forward slashes,
// drive-letter case folded — see that function's header comment): it is built to join stably
// with node `path` calls, not to string-match a fixture root built with `path.join` (native
// separators, native drive-letter case). Comparing the two forms needs the same normalization on
// BOTH sides — this carries no meaning about which directory was chosen, only its spelling — so
// this strips slash direction on top of the module's own drive-case fold rather than relying on
// incidental agreement between git and node on this machine.
function normalizeRootForCompare(p) {
  return normalizeDriveCase(p).replace(/\\/g, '/');
}

// Prettier-clean under DEFAULT settings (no .prettierrc in these temp repos): semi, double
// quotes untouched (no strings here), trailingComma "all" (inapplicable — no trailing list).
const CLEAN_JS = 'const x = 1;\n';
// Same statement, deliberately mis-spaced and missing its semicolon — prettier reformats it, so
// checking it against its own (unformatted) source reports DIRTY.
const DIRTY_JS = 'const   x=1\n';

function gitInit(dir) {
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
}

function gitCommitAll(dir, message) {
  const env = {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t.t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t.t',
  };
  execFileSync('git', ['-c', 'core.hooksPath=', 'add', '-A'], { cwd: dir, stdio: 'ignore', env });
  execFileSync('git', ['-c', 'core.hooksPath=', 'commit', '-qm', message], {
    cwd: dir,
    stdio: 'ignore',
    env,
  });
}

// A real main checkout carrying a REAL git worktree at `.claude/worktrees/x` — the same physical
// shape as any vetapp plan worktree — plus a plain ignored file and a plain clean/dirty pair at
// main's own top level, for the cases that do not need the worktree at all. Returns absolute
// paths + a `cleanup()`.
function makeFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'prettier-check-'));
  const mainDir = join(root, 'main');
  gitInit(mainDir);
  writeFileSync(join(mainDir, '.gitignore'), '.claude/worktrees/\n');
  writeFileSync(join(mainDir, '.prettierignore'), '.claude/\nignored-file.txt\n');
  writeFileSync(join(mainDir, 'ignored-file.txt'), 'not   prettier   clean  at all\n');
  writeFileSync(join(mainDir, 'clean.js'), CLEAN_JS);
  writeFileSync(join(mainDir, 'empty-dir'), ''); // placeholder, replaced by mkdirSync below
  rmSync(join(mainDir, 'empty-dir'));
  mkdirSync(join(mainDir, 'empty-dir'));
  gitCommitAll(mainDir, 'init');

  const wtParent = join(mainDir, '.claude', 'worktrees');
  mkdirSync(wtParent, { recursive: true });
  const wtDir = join(wtParent, 'x');
  execFileSync('git', ['-c', 'core.hooksPath=', 'worktree', 'add', '-q', wtDir, '-b', 'wt-x'], {
    cwd: mainDir,
    stdio: 'ignore',
  });
  // The exact false-green target: a genuinely unformatted file that lives ONLY in the worktree.
  writeFileSync(join(wtDir, 'foo.mjs'), DIRTY_JS);

  return {
    root,
    mainDir,
    wtDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [MODULE_PATH, ...args], {
    encoding: 'utf8',
    ...opts,
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status };
}

// ── (a) an ignored file: IGNORED, exit 2 without --allow-ignored, 0 with it ──

test('(a) an ignored file reports IGNORED and exits 2, or 0 with --allow-ignored', async () => {
  const fx = makeFixtureRepo();
  try {
    const denied = await run(['ignored-file.txt'], {});
    // run() resolves relative paths against process.cwd(), so exercise it through the real CLI
    // (cwd = mainDir) instead of hand-resolving here — the CLI's own argv → run() wiring is what
    // the acceptance command in the plan actually exercises.
    const cli = runCli(['ignored-file.txt'], { cwd: fx.mainDir });
    assert.equal(cli.status, 2);
    assert.match(cli.stdout, /^IGNORED ignored-file\.txt \(by \.prettierignore\)$/m);

    const cliAllowed = runCli(['ignored-file.txt', '--allow-ignored'], { cwd: fx.mainDir });
    assert.equal(cliAllowed.status, 0);
    assert.match(cliAllowed.stdout, /^IGNORED ignored-file\.txt \(by \.prettierignore\)$/m);
    // never a clean verdict for a file that was never examined
    assert.doesNotMatch(cliAllowed.stdout, /^CLEAN /m);
    void denied;
  } finally {
    fx.cleanup();
  }
});

// ── (b) an absolute path into the nested worktree, cwd = main root ──────────
// The exact false-green shape: a raw `prettier --check <abs path>` run from MAIN's cwd is
// swallowed by MAIN's own ignore files. This wrapper resolves the OWNING root (the worktree
// itself) regardless of cwd and reports the unformatted file DIRTY.

test('(b) an absolute worktree path, checked with cwd = MAIN, resolves against the WORKTREE root and reports DIRTY', async () => {
  const fx = makeFixtureRepo();
  try {
    const target = join(fx.wtDir, 'foo.mjs');
    const owningRoot = ownedRootOf(target);
    // Same directory, compared spelling-insensitively (see normalizeRootForCompare above) — this
    // still fails if ownedRootOf picked MAIN instead of the worktree, since the two are genuinely
    // different paths, not just different spellings of the same one.
    assert.equal(normalizeRootForCompare(owningRoot), normalizeRootForCompare(fx.wtDir));

    const cli = runCli([target], { cwd: fx.mainDir });
    assert.equal(cli.status, 1);
    assert.equal(cli.stdout.trim(), `DIRTY ${target}`);
    assert.doesNotMatch(cli.stdout, /^IGNORED/m);
    assert.doesNotMatch(cli.stdout, /All matched files use Prettier/);
  } finally {
    fx.cleanup();
  }
});

// ── (c) a missing file → MISSING, exit 2 ─────────────────────────────────────

test('(c) a missing file reports MISSING and exits 2', async () => {
  const fx = makeFixtureRepo();
  try {
    const { lines, exitCode } = await run([join(fx.mainDir, 'does-not-exist.js')]);
    assert.deepEqual(lines, [`MISSING ${join(fx.mainDir, 'does-not-exist.js')}`]);
    assert.equal(exitCode, 2);
  } finally {
    fx.cleanup();
  }
});

// ── (d) a directory arg expanding to zero files → exit 2 ────────────────────

test('(d) a directory argument that expands to zero files reports MISSING and exits 2', async () => {
  const fx = makeFixtureRepo();
  try {
    const emptyDir = join(fx.mainDir, 'empty-dir');
    assert.deepEqual(expandDirectory(emptyDir), []);
    const { lines, exitCode } = await run([emptyDir]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^MISSING .*\(directory expands to zero files\)$/);
    assert.equal(exitCode, 2);
  } finally {
    fx.cleanup();
  }
});

// ── (e) a clean file → CLEAN, exit 0 ─────────────────────────────────────────

test('(e) a clean file reports CLEAN and exits 0', async () => {
  const fx = makeFixtureRepo();
  try {
    const target = join(fx.mainDir, 'clean.js');
    const result = await checkOnePath(target);
    assert.deepEqual(result, { label: target, verdict: 'CLEAN', detail: null });
    const { exitCode } = await run([target]);
    assert.equal(exitCode, 0);
  } finally {
    fx.cleanup();
  }
});

// ── supporting unit coverage ──────────────────────────────────────────────────

test('run() with no paths is a usage error: exit 2, no lines', async () => {
  const { lines, errors, exitCode } = await run([]);
  assert.deepEqual(lines, []);
  assert.equal(exitCode, 2);
  assert.equal(errors.length, 1);
});

test('run() with only --allow-ignored (no paths) is still a usage error', async () => {
  const { exitCode } = await run(['--allow-ignored']);
  assert.equal(exitCode, 2);
});

test('worst-exit-wins: a DIRTY file and a MISSING file together exit 2, not 1', async () => {
  const fx = makeFixtureRepo();
  try {
    const { exitCode } = await run([
      join(fx.wtDir, 'foo.mjs'),
      join(fx.mainDir, 'does-not-exist.js'),
    ]);
    assert.equal(exitCode, 2);
  } finally {
    fx.cleanup();
  }
});

test('normalizeDriveCase lower-cases a win32 drive letter and leaves POSIX paths alone', () => {
  assert.equal(normalizeDriveCase('C:\\Users\\x', 'win32'), 'c:\\Users\\x');
  assert.equal(normalizeDriveCase('/home/x', 'win32'), '/home/x'); // no drive letter to fold; personal-data-ok: synthetic POSIX path fixture
  assert.equal(normalizeDriveCase('C:\\Users\\x', 'linux'), 'C:\\Users\\x'); // non-win32: untouched
});

test('ownedRootOf returns null outside any git repository', () => {
  const root = makeNoRepoRoot('prettier-check-norepo-');
  try {
    assert.equal(ownedRootOf(join(root, 'nested', 'file.js')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── directory expansion (review round 1) ─────────────────────────────────────

// Plants a symlink or reports that this host cannot (Windows without developer mode) — the
// caller skips rather than asserting a property of the machine.
function trySymlink(target, linkPath) {
  try {
    symlinkSync(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

test('expandDirectory prunes .git, node_modules and nested checkouts', () => {
  const fx = makeFixtureRepo();
  try {
    mkdirSync(join(fx.mainDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(fx.mainDir, 'node_modules', 'pkg', 'index.js'), DIRTY_JS);
    const files = expandDirectory(fx.mainDir).map((f) => f.slice(fx.mainDir.length + 1));
    assert.ok(files.includes('clean.js'));
    assert.ok(
      !files.some((f) => f.split(/[\\/]/)[0] === '.git'),
      `unexpected .git entry in ${files}`,
    );
    assert.ok(!files.some((f) => f.startsWith('node_modules')), `node_modules leaked: ${files}`);
    // the nested worktree is ANOTHER checkout — a directory arg on main never walks into it
    assert.ok(!files.some((f) => f.includes('worktrees')), `nested checkout leaked: ${files}`);
  } finally {
    fx.cleanup();
  }
});

test('a symlinked file inside a directory argument is examined, never silently dropped', async (t) => {
  const fx = makeFixtureRepo();
  try {
    const dir = join(fx.mainDir, 'linkdir');
    mkdirSync(dir);
    writeFileSync(join(dir, 'ok.js'), CLEAN_JS);
    writeFileSync(join(fx.mainDir, 'dirty-target.js'), DIRTY_JS);
    if (!trySymlink(join(fx.mainDir, 'dirty-target.js'), join(dir, 'link.js'))) {
      t.skip('host cannot create symlinks');
      return;
    }
    const { lines, exitCode } = await run([dir]);
    assert.ok(
      lines.some((l) => /^DIRTY .*link\.js$/.test(l)),
      lines.join('\n'),
    );
    assert.equal(exitCode, 1);
  } finally {
    fx.cleanup();
  }
});

test('ignored files under a directory argument are skipped and counted, not failed', async () => {
  const fx = makeFixtureRepo();
  try {
    // main's top level holds clean.js (CLEAN) + ignored-file.txt (ignored by .prettierignore)
    const { lines, exitCode } = await run([fx.mainDir]);
    assert.ok(
      lines.some((l) => /^CLEAN .*clean\.js$/.test(l)),
      lines.join('\n'),
    );
    assert.ok(!lines.some((l) => l.startsWith('IGNORED')), lines.join('\n'));
    assert.ok(
      lines.some((l) => /^SKIPPED \d+ ignored file/.test(l)),
      lines.join('\n'),
    );
    assert.equal(exitCode, 0);
  } finally {
    fx.cleanup();
  }
});

test('a directory argument whose every file is ignored exits 2 (nothing was examined)', async () => {
  const fx = makeFixtureRepo();
  try {
    const dir = join(fx.mainDir, 'only-ignored');
    mkdirSync(dir);
    writeFileSync(join(dir, 'data.bin'), 'x'); // no inferred parser
    const { lines, exitCode } = await run([dir]);
    assert.ok(
      lines.some((l) => /^MISSING .*zero checkable files/.test(l)),
      lines.join('\n'),
    );
    assert.equal(exitCode, 2);
  } finally {
    fx.cleanup();
  }
});

test('checkOnePath never reports CLEAN for a file it did not examine (fake prettier probe)', async () => {
  const fx = makeFixtureRepo();
  try {
    let calls = 0;
    const fakePrettier = {
      async getFileInfo() {
        calls++;
        return { ignored: false, inferredParser: 'babel' };
      },
      async resolveConfig() {
        return {};
      },
      async check(src) {
        calls++;
        return src === CLEAN_JS;
      },
    };
    const target = join(fx.mainDir, 'clean.js');
    const result = await checkOnePath(target, { _prettier: fakePrettier });
    assert.equal(result.verdict, 'CLEAN');
    assert.ok(calls >= 2); // both the ignore check and the format check actually ran
  } finally {
    fx.cleanup();
  }
});
