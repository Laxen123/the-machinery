// scripts/test-helpers/clean-git-env.mjs — the GIT_*-scrubbed child-process env shared by the
// lock-path test suites (plan 2478 review finding [2]).
//
// WHY THIS IS A SHARED HELPER. git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE into every
// hook subprocess; these suites run inside the pre-push hook, so an inherited GIT_DIR would point
// a test's throwaway repo at the real one. Scrubbing before spawning `git init`/`git worktree add`
// in a temp fixture is the same class of fix `resolveCommonDirPath` (lock-path.mjs) applies to the
// lock resolution itself — a second, independently-maintained copy of the scrub loop is exactly
// the plan-1678 failure mode (a hardening applied to one copy silently left the other behind).
// plan 2604: delegates to the ONE implementation in scripts/coord/child-env.mjs rather than keeping a
// fourth copy of the loop — which is exactly what this header warned about. The shared version is
// case-INSENSITIVE, so an ambient `git_dir=…` no longer survives on win32 and point a fixture's
// throwaway repo at the real one.
import { gitIsolatedEnv } from '../coord/child-env.mjs';

export function cleanGitEnv() {
  return gitIsolatedEnv();
}
