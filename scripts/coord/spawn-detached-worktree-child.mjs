import { spawn } from 'node:child_process';

// THE one detached-child spawn shape for a worktree-scoped helper (plan 2513; extracted to a
// single helper by plan 2551's review, which found the whole block copy-pasted into the queue-watch
// auto-spawn). Both callers — the land-prep dispatch and the keep-hot watcher auto-spawn — need
// the identical win32 dance, and two hand-maintained copies is how a future fix lands on one and
// silently misses the other.
//
// Moved to this import-safe scripts-only module by plan 3503 so gpt-review can reuse the exact
// shape without importing done-worktree.mjs and accidentally evaluating that CLI's argv guards.
//
// win32 spawn shape — THIS COMMENT IS THE SINGLE SOURCE for the rationale (worktree-lock.mjs
// references it; don't restate it elsewhere). A detached child is CONSOLELESS on Windows, so every
// git it execs allocates its own VISIBLE conhost window — measured 72 flashes on the operator's
// desktop in 5 minutes. A windowsHide child is invisible but DIES: the harness reaps a
// non-detached child when its spawner exits (A/B-verified 2026-07-26: plain and windowsHide
// children die at parent exit; detached survives; children of a still-LIVING parent always
// survive). CREATE_NO_WINDOW + DETACHED_PROCESS cannot combine (the former is ignored under the
// latter). So win32 threads the needle with a two-stage dispatch: a DETACHED shim survives this
// invocation and stays alive holding the real child, spawned windowsHide — the child survives
// because its parent lives, and owns ONE invisible console the entire git subtree inherits
// (verified: 0 windows during an 8-git churn under a 3ms EnumWindows probe). The shim exits when
// the child does; any worktree-lock holder pid is written by the CHILD itself, so preemption is
// shim-agnostic. POSIX spawns the child directly, detached: pid==pgid is what worktree-lock's
// group-kill preemption relies on.
//
// The shim's OWN cwd is MAIN, never the worktree (review 2513 r2 [2]): a shim lingering a beat
// past a preempted child must not hold wtPath open against rebase-abort/teardown; the child's cwd
// threads through argv instead. POSIX runs the child directly, so it takes the worktree cwd itself.
//
// -e argv convention: argv.slice(1) = [cli path, slug, worktree path]. stdio 1/2 = the shim's own
// fds, i.e. the caller's log fd — the child logs to the same file either way, and a child SPAWN
// failure lands in that log too (review 2513 r2 [0]: the old single-stage dispatch printed spawn
// failures; the shim must not swallow them).
// `env` is REQUIRED, deliberately with no default (plan 3503, reversion-review advisory 1). Before
// the extraction this function hard-coded done-worktree's `gitEnv()`, so the plan-2604 child-env
// scrub was unconditional. A default of `undefined` here would silently hand a future caller the
// raw ambient `process.env` — reinstating exactly the leak the scrub exists to close, in a DETACHED
// child that outlives its spawner. Failing loudly at the seam is the only version of this that
// cannot rot: pass `gitEnv()`, `spawnEnv(...)` or `gitRepoIsolatedEnv(...)`, never nothing.
export function spawnDetachedWorktreeChild({
  MAIN,
  cli,
  slug,
  wtPath,
  childArgs,
  shimLabel,
  fd,
  env,
}) {
  if (!env || typeof env !== 'object')
    throw new TypeError(
      `spawnDetachedWorktreeChild(${shimLabel || slug}): \`env\` is required — pass a scrubbed child ` +
        `environment (gitEnv() / spawnEnv() / gitRepoIsolatedEnv()), never the raw process.env.`,
    );
  const argsLiteral = JSON.stringify(childArgs);
  const WIN32_SHIM_SRC = [
    "const { spawn } = require('node:child_process');",
    'const [cli, slug, wtPath] = process.argv.slice(1);',
    `const c = spawn(process.execPath, [cli, slug, ...${argsLiteral}], { cwd: wtPath, windowsHide: true, stdio: ['ignore', 1, 2] });`,
    `c.on('error', (e) => { console.error(${JSON.stringify(`${shimLabel} spawn failed — `)} + ((e && e.message) || e)); process.exit(1); });`,
    "c.on('exit', (code) => process.exit(code ?? 1));",
  ].join('\n');
  return spawn(
    process.execPath,
    process.platform === 'win32'
      ? ['-e', WIN32_SHIM_SRC, cli, slug, wtPath]
      : [cli, slug, ...childArgs],
    {
      cwd: process.platform === 'win32' ? MAIN : wtPath,
      detached: true,
      stdio: ['ignore', fd, fd],
      env,
    },
  );
}
