// scripts/test-helpers/no-repo-root.mjs — a temp root that is PROVABLY outside any git
// repository, for the tests that exercise a "there is no repo here" production branch
// (plan 3622).
//
// THE CLASS THIS EXISTS FOR. `mkdtempSync(join(tmpdir(), 'x-'))` gives a directory that is
// outside a git repo only if the MACHINE happens to have no repo above `tmpdir()`. That is an
// assumption about what the host filesystem CONTAINS, not a fact about the path — the third
// axis alongside path SPELLING and platform SYMBOLS, and the one that blocked the plan-3595
// drain for ~3.5h (`output/reports/2026-09-01-drain-3595-stall-structural-root-cause.md`).
// A sandbox with a `/tmp/.git`, a developer whose TMPDIR sits under a checkout, or a CI image
// that git-inits its work root all break the assumption, and the break lands on whichever
// UNRELATED plan the import-closure selector next pulls the test into.
//
// WHY A DANGLING GITFILE AND NOT ONE OF THE OBVIOUS ALTERNATIVES. All three were measured on
// 2026-09-02 against a deliberately-planted valid repo above the temp root:
//
//   • `git init` the root — makes the root a repo, which DELETES the very coverage these
//     tests exist for. Correct for a fixture that wants a repo (that is what
//     `main-checkout-clean-guard.test.mjs`'s `makeProject()` does, and its git-init is
//     load-bearing shadowing for exactly this reason); wrong here.
//   • an empty `.git` DIRECTORY in the root — does NOT work: measured `status=0`, git IGNORES
//     an unusable `.git` and keeps walking up to the ancestor repo. (Note this corrects the
//     wording in the 3595 report, which said real git "REJECTS" an empty `.git` dir. It does
//     not reject it; it skips it. The report's CONCLUSION — that real-git tests are latent
//     rather than live — still holds, but by ignoring, not by rejecting.)
//   • `GIT_CEILING_DIRECTORIES` set to the root's PARENT — genuinely fences the walk
//     (measured `status=128`), but is USELESS against the production paths these tests drive:
//     `scripts/coord/lock-path.mjs`'s `resolveCommonDirPath` deliberately scrubs every `GIT_*` var
//     out of the child env (`gitIsolatedEnv()`) before resolving, so the fence never reaches
//     git. Setting it here would look like a seam and silently do nothing.
//
// A `.git` FILE whose `gitdir:` points at a path that does not exist is the one construction
// that survives all of that: git's discovery STOPS at the root (it found a `.git` entry) and
// then fails to use it, so `rev-parse` exits non-zero regardless of what sits above `tmpdir()`
// and regardless of env scrubbing. The resulting condition is "git can resolve no repository
// from this directory", which is precisely the production state each caller is exercising —
// reached by a failed discovery at the root rather than by an exhausted walk, an immaterial
// difference to every caller here and the only one that is a FACT about the path.
//
// The precondition is ASSERTED, not assumed: if a future git ever resolves a repo from a root
// built here, these tests fail loudly at construction instead of passing vacuously — which is
// the whole failure mode this helper exists to end.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Returns an absolute temp-dir path from which `git rev-parse` can resolve NO repository.
// `prefix` is the usual `mkdtempSync` prefix (e.g. `'install-main-notgit-'`).
//
// `_mkdtempSync` is injectable so a suite that shadows `mkdtempSync` with
// `test-helpers/tracked-tmpdir.mjs`'s leak-tracking wrapper can pass its OWN wrapper in and keep
// the root in that suite's `after()` sweep — otherwise routing a call site through this helper
// would quietly re-open the very temp-dir leak plan 2365 T4 closed.
// ambient-git-ok: this helper IS the seam — it plants the barrier and asserts the condition.
export function makeNoRepoRoot(prefix, { _tmpdir = tmpdir, _mkdtempSync = mkdtempSync } = {}) {
  const root = _mkdtempSync(join(_tmpdir(), prefix));
  // The pointed-at gitdir is deliberately inside `root` and deliberately never created, so the
  // marker is self-contained (nothing outside the temp dir is referenced, named, or needed).
  writeFileSync(join(root, '.git'), `gitdir: ${join(root, 'no-such-gitdir')}\n`);
  const probe = spawnSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (probe.status === 0) {
    throw new Error(
      `no-repo-root: precondition FAILED — git still resolved a repository from ${root} ` +
        `(--git-common-dir → ${String(probe.stdout).trim()}). The dangling-gitfile barrier no ` +
        `longer stops discovery; fix this helper rather than letting the caller pass vacuously.`,
    );
  }
  return root;
}
