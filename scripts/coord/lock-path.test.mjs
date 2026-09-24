// scripts/lock-path.test.mjs — unit tests for the shared git-common-dir lock-path resolution
// (plan 2478) behind landing-lock.mjs, battery-lock.mjs, and worktree-lock.mjs.
//
// The invariant every case defends: the resolved path is the one file every worktree of a clone
// rendezvous on, and a poisoned GIT_DIR (a git hook exports it into every child, sometimes
// pointing at a worktree gitdir mid-operation) must never redirect it to a foreign repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve, win32, posix } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveCommonDirPath } from './lock-path.mjs';
import { cleanGitEnv } from '../test-helpers/clean-git-env.mjs';
import { trackedMkdtempSync } from '../test-helpers/tracked-tmpdir.mjs';
import { makeRepoWithWorktree } from '../test-helpers/worktree-lock-repo.mjs';

const mkdtempSync = trackedMkdtempSync();

function tmpRepo(prefix = 'lock-path-repo-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: cleanGitEnv() });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: dir,
    env: cleanGitEnv(),
  });
  return dir;
}

test('resolveCommonDirPath: resolves the common dir from a plain repo', () => {
  const repo = tmpRepo();
  const common = resolveCommonDirPath({ anchor: repo });
  assert.equal(common.replaceAll('\\', '/'), resolve(repo, '.git').replaceAll('\\', '/'));
});

test('resolveCommonDirPath: resolves the SHARED common dir from a linked worktree', () => {
  const { mainDir, wtDir, cleanup } = makeRepoWithWorktree();
  try {
    const fromMain = resolveCommonDirPath({ anchor: mainDir });
    const fromWorktree = resolveCommonDirPath({ anchor: wtDir });
    // STRICT compare, deliberately not separator-normalized (plan 2490 correction, 2026-07-26):
    // a normalizing compare here would mask the exact divergence plan 2489 fixes -- git spells
    // the main clone's common dir differently from a linked worktree's on Windows, and
    // landing-lock/battery-lock/worktree-lock use this string AS THEIR LOCKFILE PATH, so the two
    // strings must be byte-identical, not merely equivalent after normalization. Now that
    // resolveCommonDirPath resolves both branches, they already are.
    // path-assert-ok: byte-identity IS the invariant here — these strings are used AS lockfile
    // paths, so assertSamePath's normalizing compare would pass on a pair that cannot rendezvous.
    assert.equal(fromWorktree, fromMain);
  } finally {
    cleanup();
  }
});

test('resolveCommonDirPath: a poisoned GIT_DIR in process.env does not redirect the resolution', () => {
  const repo = tmpRepo('lock-path-real-');
  const foreign = tmpRepo('lock-path-foreign-');
  const prior = process.env.GIT_DIR;
  process.env.GIT_DIR = join(foreign, '.git');
  try {
    const common = resolveCommonDirPath({ anchor: repo });
    assert.equal(common.replaceAll('\\', '/'), resolve(repo, '.git').replaceAll('\\', '/'));
  } finally {
    if (prior === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = prior;
  }
});

// `_path: posix` is explicit here (plan 2489 review [0]): this test's anchor and expected output
// are POSIX-shaped, and now that the fix routes the absolute branch through `resolve()` too, an
// UN-injected default `_path` would run this exact fixture through the platform-native module on
// a Windows executor -- win32.resolve drive-relativizes a drive-less absolute path like
// '/elsewhere/.git' against process.cwd()'s drive, breaking the assertion on the very platform
// the fix targets. Pinning `_path: posix` makes the assertion platform-independent instead of
// silently depending on which OS runs the suite.
test('resolveCommonDirPath: honors an injected _exec and joins a relative result against the anchor', () => {
  const common = resolveCommonDirPath({
    anchor: '/somewhere',
    _exec: () => '.git\n',
    _path: posix,
  });
  assert.equal(common, '/somewhere/.git');
  const abs = resolveCommonDirPath({
    anchor: '/somewhere',
    _exec: () => '/elsewhere/.git\n',
    _path: posix,
  });
  assert.equal(abs, '/elsewhere/.git');
});

// Re-fixtured (plan 2489, failure 2): a real Windows anchor always carries a drive letter --
// anchors come from `process.cwd()` / worktree paths, never a drive-less absolute like the
// POSIX-style '/somewhere' above. Injecting `path.win32` against a drive-qualified anchor
// exercises the ACTUAL Windows shape instead of a fixture `resolve()` would drive-relativize
// against `process.cwd()`'s drive, which is what the drive-less fixture used to trip over.
test('resolveCommonDirPath: on win32, a drive-qualified anchor plus a relative _exec result resolves without inventing a drive letter', () => {
  const common = resolveCommonDirPath({
    anchor: 'C:\\Users\\user\\repo',
    _exec: () => '.git\n',
    _path: win32,
  });
  assert.equal(common, 'C:\\Users\\user\\repo\\.git');
});

// The two shapes `resolveCommonDirPath` actually sees on Windows (plan 2489 failure 1): git
// returns a RELATIVE `.git` from the main checkout but an ABSOLUTE MSYS-style forward-slash
// path from a linked worktree of the SAME repo. Both must resolve to the identical string --
// injecting `path.win32` pins this red->green on any platform, not just a real Windows box.
test('resolveCommonDirPath: on win32, main-checkout (relative) and worktree (absolute MSYS) anchors of the same repo resolve identically', () => {
  const fromMain = resolveCommonDirPath({
    anchor: 'C:\\Users\\user\\repo',
    _exec: () => '.git\n',
    _path: win32,
  });
  const fromWorktree = resolveCommonDirPath({
    anchor: 'C:\\Users\\user\\repo\\.claude\\worktrees\\some-slug',
    _exec: () => 'C:/Users/user/repo/.git\n',
    _path: win32,
  });
  assert.equal(fromWorktree, fromMain);
});
