#!/usr/bin/env node
// scripts/queued-run.mjs — run ANY heavy command under a machine-global
// test-queue slot (plan 1785).
//
// THE GAP THIS CLOSES: plan 1750's test-run queue was consumed only by
// run-land-tests.mjs (the pre-push / done-worktree gates). A session
// hand-running the full suite to DEBUG a red gate — `pnpm --filter
// @vetapp/backend test`, bare `vitest run`, a whole-dir pytest sweep — took no
// ticket, so the debugging session became the very herd the queue exists to
// prevent, degrading exactly the gate runs it was diagnosing (observed
// 2026-07-13). This wrapper is the generic fix: it acquires a slot via
// withTestSlot and forwards ANY command with its args and exit code — one
// wrapper, no per-runner queue logic (`backend` `test:queued` and pytest
// whole-dir sweeps both ride it).
//
// Usage:
//   node scripts/queued-run.mjs [--label <name>] [--] <cmd> [args...]
//   pnpm --filter @vetapp/backend test:queued        # the vitest full-suite form
//   node scripts/queued-run.mjs python -m pytest backend/scripts/price-pipeline/
//
// Single-file runs stay ticket-free ON PURPOSE (not herd-shaped) — this is for
// full-suite / whole-dir loads. The child is spawned via spawnWithTreeKill
// (kill-tree.mjs): async (the queue's heartbeat keeps beating — HOLDER
// CONTRACT), cross-platform-safe for arbitrary args (a quoted
// `--testNamePattern "slow test"` survives Windows .cmd shims — the plan-1785
// F1 bug), and its whole descendant tree dies if this process exits mid-run,
// BEFORE the slot releases (F2 — the ordering lives in ONE place now).

import { existsSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withTestSlot, TEST_SLOT_ADMITTED_MARKER } from './coord/test-queue.mjs';
import { spawnWithTreeKill, waitForExit } from './coord/kill-tree.mjs';
import { resolveSchedulingClass, applyCpuClass } from './coord/session-priority.mjs';
// plan 4096 S10: the pytest worker POLICY (scripts/pytest-workers.mjs) is pytest-shaped project
// tooling, while this wrapper is the generic queue/ticket path every heavy run goes through. So it
// is no longer a static import: the CLI entry point below loads it through the SAME guarded
// optional-import seam the land spine loads its project plugin through
// (scripts/coord/optional-import.mjs). Present → injection exactly as before; absent (a checkout
// with no pytest tooling) → no injection, the wrapper still queues the command unchanged; present
// but broken → the load error fails the wrapper, never a silent serial run.
import { importOptional } from './coord/optional-import.mjs';

const USAGE = 'usage: node scripts/queued-run.mjs [--label <name>] [--] <cmd> [args...]';

// ── plan 3969: inject the parallel-sweep flags a session would otherwise have
// to type by hand ─────────────────────────────────────────────────────────
//
// scripts/pytest-workers.mjs is the ONE place the worker count and the
// "is this even a sweep" rule live (pre-push.sh, nightly-windows-suite.mjs and
// measure-pytest-memory.mjs all read it and pass explicit flags to THIS
// wrapper already). Nothing here re-derives either — pytestXdistArgsForTargets
// is loaded (plan 4096 S10: optionally, see the import above), never
// re-implemented, and an empty result from it — or no policy module at all —
// means no injection.
//
// Basename-matched (not path.basename) so both `/` and `\` separated forms
// are recognised regardless of which platform this process is running on —
// the same convention scripts/hooks/hand-rolled-step-guard.mjs uses for `rm`
// and `git`.
const PYTEST_BASENAME_RE = /(?:^|[\\/])pytest(?:\.exe)?$/i;
const PYTHON_LAUNCHER_BASENAME_RE = /(?:^|[\\/])(?:python3?(?:\.\d+)?|py)(?:\.exe)?$/i;

// The index into `args` right AFTER the `pytest` token — where the injected
// flags belong. `-1` means this command is not a pytest invocation at all.
// A bare `pytest`/`pytest.exe` cmd has no `pytest` token in `args` (the cmd
// IS the token), so the insertion point is the front of `args`. A python
// launcher's `pytest` token is the value of `-m` — interpreter flags
// (`-X utf8`) may sit before it, so this scans rather than assuming position
// 0, and only the FIRST `-m pytest` counts (`python -m coverage pytest` runs
// coverage and hands it the word pytest, not a pytest run — same read as the
// hand-rolled-step-guard's `-m` handling).
function pytestArgsInsertIndex(cmd, args) {
  if (PYTEST_BASENAME_RE.test(String(cmd))) return 0;
  if (PYTHON_LAUNCHER_BASENAME_RE.test(String(cmd))) {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-m' && args[i + 1] === 'pytest') return i + 2;
    }
  }
  return -1;
}

// Any arg already naming a worker count, a dist mode, or `-p no:xdist` — a
// session that typed its own parallelism (or deliberately opted into serial,
// the named escape the parallel-by-default ruling requires) is left alone,
// verbatim, with no log line.
function hasExplicitXdistArg(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-n(\d+)?$/.test(a)) return true;
    if (/^--numprocesses(=.*)?$/.test(a)) return true;
    if (/^--dist(=.*)?$/.test(a)) return true;
    if (a === '-p' && args[i + 1] === 'no:xdist') return true;
    if (a.startsWith('-p') && a.slice(2) === 'no:xdist') return true;
  }
  return false;
}

// The pytest TARGETS in the tail of `args` (everything from the pytest
// token on), resolved against `cwd`. A token starting with `-` is a flag and
// is skipped outright — pytest's value-taking flags are deliberately not
// enumerated (execution notes: "the filesystem check is the rule"), so a
// `-k expr` value or an unrecognised word is ignored for the same reason a
// real directory/file is recognised: it is tested against the filesystem, not
// matched by name. An existing directory is a non-file target; an existing
// file ending `.py` (a `::selector` is stripped first) is a file target;
// anything else is ignored.
function pytestTargetsIn(tailArgs, cwd) {
  const targets = [];
  for (const tok of tailArgs) {
    if (typeof tok !== 'string' || tok.startsWith('-')) continue;
    const stripped = tok.replace(/::.*/, '');
    if (!stripped) continue;
    let full;
    try {
      full = resolvePath(cwd, stripped);
    } catch {
      continue;
    }
    if (!existsSync(full)) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      targets.push(full);
    } else if (st.isFile() && stripped.endsWith('.py')) {
      targets.push(full);
    }
  }
  return targets;
}

// Pure, exported for tests. `{ cmd, args }` in, `{ cmd, args }` out — never
// mutates its input, and a non-pytest command (or a pytest command with no
// sweep-shaped target list) is returned untouched. `xdistArgsForTargets`
// defaults to the real policy module; tests inject a stub so the machine's
// CPU count never enters the assertion. `log` defaults to `console.error` (the
// one stderr line the execution notes require); tests inject a seam instead of
// spying on the global.
export function injectPytestParallelism(
  { cmd, args },
  { cwd = process.cwd(), xdistArgsForTargets = null, log = console.error } = {},
) {
  // plan 4096 S10: no policy supplied (the CLI found no scripts/pytest-workers.mjs) ⇒ no injection.
  if (typeof xdistArgsForTargets !== 'function') return { cmd, args };
  const insertAt = pytestArgsInsertIndex(cmd, args);
  if (insertAt < 0) return { cmd, args };
  if (hasExplicitXdistArg(args)) return { cmd, args };
  const targets = pytestTargetsIn(args.slice(insertAt), cwd);
  // plan 3969 fix round 1, F1 (findings dcd233 + f507e9): a TARGETLESS pytest
  // run — a bare `pytest`, or one whose only non-flag word is a `-k`
  // expression or other unrecognised token that resolves to nothing on the
  // filesystem — names no target at all, so pytest discovers from the CWD:
  // the BIGGEST sweep there is. `pytestTargetsIn` correctly yields `[]` for
  // that shape (nothing on disk to point at), but handing an empty list
  // straight to the policy function reads as "0 files, below the floor" and
  // left it serial — while worktree-guard.sh's deny already calls this exact
  // shape sweep-shaped and sends the session here. So an EMPTY target list is
  // handed the same shape the policy function would see for an explicit `.`
  // directory target (a single non-`.py`-ending path): a non-file target
  // always meets the sweep floor, matching how an explicit directory does.
  const implicitCwdSweep = targets.length === 0;
  const targetsForPolicy = implicitCwdSweep ? [resolvePath(cwd, '.')] : targets;
  const flags = xdistArgsForTargets(targetsForPolicy);
  if (!flags || flags.length === 0) return { cmd, args };
  const newArgs = [...args.slice(0, insertAt), ...flags, ...args.slice(insertAt)];
  log(
    `queued-run: injecting pytest parallelism ${flags.join(' ')} ` +
      `(from scripts/pytest-workers.mjs; ` +
      `${implicitCwdSweep ? 'implicit CWD (no target named)' : `${targets.length} target(s)`} swept) — ` +
      `pass -n/--dist/-p no:xdist yourself to opt out`,
  );
  return { cmd, args: newArgs };
}

// Only flags BEFORE the command belong to queued-run; everything from the first
// non-flag token on is the wrapped command, passed through VERBATIM (its own
// --label / -- / anything must never be consumed here).
export function parseArgs(argv) {
  let label;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a === '--label') {
      if (i + 1 >= argv.length) throw new Error(`queued-run: --label needs a value\n${USAGE}`);
      label = argv[i + 1];
      i += 2;
      continue;
    }
    break;
  }
  const cmd = argv[i];
  if (!cmd) throw new Error(USAGE);
  return { label: label ?? `manual:${cmd}`, cmd, args: argv.slice(i + 1) };
}

// Hold a slot for the whole child run; resolve to the exit code to forward.
// opts: { spawnOpts, queueOpts, tier, yieldToHead, announceAdmitted } — test seams; production
// callers pass nothing. `tier` keeps its pre-3226 override semantics: passing it skips the landing-queue read
// entirely (a test seam, not a production path), and `yieldToHead` is an independent override in
// that same mode (default false, matching pre-3226 behavior when omitted).
//
// The session's scheduling class (plan 2716 + 3226) does two things here: it rides the queue
// TICKET (so a high-priority session's run is served ahead of waiting background work — the
// landing-queue head resolves `high` here too, plan 3226) and it sets the child's CPU class (so a
// low-priority session's heavy tree yields cores to everyone else, AND so ANY tier's heavy tree
// yields while a local land is in flight at the head and this session is not it). Resolved ONCE
// per run, before the wait, via the one queue read `resolveSchedulingClass` makes — an operator
// bumping the plan's `priority:` mid-queue affects the NEXT run, not this one, which keeps the
// ticket's tier stable for the whole wait.
export async function runQueued({ label, cmd, args }, opts = {}) {
  const scheduling =
    opts.tier !== undefined
      ? { tier: opts.tier, yieldToHead: opts.yieldToHead ?? false }
      : resolveSchedulingClass();
  const { tier, yieldToHead } = scheduling;
  // plan 4003 T1: on STDERR, not stdout. This wrapper's stdout belongs to the WRAPPED COMMAND —
  // it is inherited verbatim by the child and real consumers parse it as the command's own data
  // (`queued-run.test.mjs`'s argv round-trip does `JSON.parse(stdout)`, and a marker there breaks
  // it outright). stderr is already this wrapper's own diagnostic channel — the pytest-parallelism
  // notice goes there — and `runViaTestQueue` pipes BOTH streams into one capture, so the reader
  // sees the marker either way. The plan's execution note said stdout for the reason "the parent
  // already reads the child's stdout"; that reason holds for stderr too, and stdout does not
  // survive the ownership test.
  const announceAdmitted =
    opts.announceAdmitted ?? (() => process.stderr.write(`${TEST_SLOT_ADMITTED_MARKER}\n`));
  return withTestSlot(
    label,
    async () => {
      // plan 4003 T1 / plan 4006 review round 2 (finding 0cb34c residual): the marker means the
      // wrapped command is starting NOW — whether `withTestSlot` awarded a genuine queue slot or
      // fail-opened (`TEST_QUEUE_DISABLE=1`, a queue I/O error, or max-wait expiry: the callback
      // still runs on every one of those paths). Everything before this line was queue wait (or no
      // wait at all, on a fail-open); everything after it is the wrapped command's own run. A
      // fail-open is deliberately NOT starvation: the command really is starting immediately, which
      // is exactly the moment a caller's own run-timeout cap must begin bounding it — see
      // `runViaTestQueue`'s matching header comment in done-worktree.mjs (the reader side of this
      // same contract) for why. Announced BEFORE the spawn so the marker can never interleave into
      // the middle of a line the child writes (the child inherits this process's streams). One
      // line, one fixed token, no prose: see TEST_SLOT_ADMITTED_MARKER for why the existing
      // human-readable "slot acquired" line is not a wire contract, and `announceAdmitted` above
      // for why it goes to stderr.
      //
      // `announceAdmitted` is a test seam of the same shape as `log` in injectPytestParallelism —
      // a unit test injects it instead of capturing the real process stdout; production callers
      // pass nothing.
      announceAdmitted();
      const child = spawnWithTreeKill(cmd, args, { stdio: 'inherit', ...opts.spawnOpts });
      // Synchronously, on the pid we just got: the demotion is inherited by everything the child
      // forks afterwards (pnpm → vitest workers, python → pytest-xdist), so the whole tree comes
      // up below-normal. Never throws, never elevates — see session-priority.mjs.
      applyCpuClass(child.pid, tier, { yieldToHead });
      const { code, error } = await waitForExit(child);
      if (error) {
        console.error(`queued-run: failed to spawn ${cmd} — ${error?.message ?? error}`);
        return 1;
      }
      return code ?? 1;
    },
    { tier, ...opts.queueOpts },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  importOptional(
    new URL('./pytest-workers.mjs', import.meta.url),
    () => import('./pytest-workers.mjs'),
  )
    .then((policy) => {
      parsed = {
        ...parsed,
        ...injectPytestParallelism(parsed, {
          cwd: process.cwd(),
          xdistArgsForTargets: policy?.pytestXdistArgsForTargets ?? null,
        }),
      };
      return runQueued(parsed);
    })
    .then(
      (code) => process.exit(code),
      (e) => {
        console.error(`queued-run: unexpected error — ${e?.stack ?? e}`);
        process.exit(1);
      },
    );
}
