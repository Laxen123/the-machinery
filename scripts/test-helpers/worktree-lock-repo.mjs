// scripts/test-helpers/worktree-lock-repo.mjs — the shared real-git repo + linked-worktree
// fixture for the worktree index.lock self-heal suites (plan 1100 / plan 2465).
//
// WHY THIS IS A SHARED HELPER. clear-stale-worktree-lock.test.mjs (plan 1100) and
// coord-git.test.mjs's healOwnWorktreeIndexLock suite (plan 2465) each need the identical
// fixture — a real repo with a real linked worktree, both git-dirs' index.lock paths
// resolved — to plant/backdate a lock and assert it is (or is not) cleared. A hand-copied
// second version of this fixture in coord-git.test.mjs was the plan-2465 review's own
// finding: a fixture bug fix or git-version compat tweak (e.g. `git worktree add` flag
// changes) applied to one copy could silently leave the other stale. One copy lives here.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function gitOut(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// A real repo with a linked worktree. Returns absolute
// { mainDir, wtDir, mainLock, wtLock, cleanup }.
export function makeRepoWithWorktree() {
  const root = mkdtempSync(join(tmpdir(), 'wt-lock-repo-'));
  const mainDir = join(root, 'main');
  execFileSync('git', ['init', '-q', mainDir], { stdio: 'ignore' });
  const g = (...args) =>
    execFileSync(
      'git',
      [
        '-C',
        mainDir,
        '-c',
        'user.email=t@t.t',
        '-c',
        'user.name=t',
        '-c',
        'core.hooksPath=',
        ...args,
      ],
      { stdio: 'ignore' },
    );
  writeFileSync(join(mainDir, 'f.txt'), 'a\n');
  g('add', 'f.txt');
  g('commit', '-qm', 'init');
  const wtDir = join(root, 'wt');
  g('worktree', 'add', '-q', wtDir, '-b', 'wb');
  const mainGitDir = gitOut(mainDir, ['rev-parse', '--absolute-git-dir']);
  const wtGitDir = gitOut(wtDir, ['rev-parse', '--absolute-git-dir']);
  return {
    mainDir,
    wtDir,
    mainLock: `${mainGitDir}/index.lock`,
    wtLock: `${wtGitDir}/index.lock`,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
