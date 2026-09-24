// scripts/kill-tree.test.mjs — unit tests for the shared descendant-tree kill
// behind run-land-tests.mjs and verify-mobile.mjs (plan 1761), and for
// spawnWithTreeKill (plan 1785) — the shared spawn seam that passes ARBITRARY
// args safely on Windows (no shell:true → no cmd.exe re-splitting of quoted
// args, the plan-1785 F1 bug) and wires the kill-on-parent-exit ordering that
// run-land-tests.mjs previously hand-rolled (F2).
//
// The contract under test is the one both callers lean on: synchronous,
// never-throws (exit-handler-safe), no-op on a missing/already-killed proc,
// and it actually terminates a live child on this platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  killProcessTree,
  killProcessTreeByPid,
  spawnWithTreeKill,
  listPidPpidPairs,
  collectDescendants,
  snapshotDescendants,
  confirmTreeDead,
  isTaskkillAlreadyGoneExit,
} from './kill-tree.mjs';
import { isAlive, getPgid, forceKillPids } from '../test-helpers/kill-tree-test-lib.mjs';

// Collect a child's stdout to completion and return { code, stdout }.
function collect(child) {
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: out }));
  });
}

// A scratch dir WITH a space in its name — the repo path itself contains one
// ("98 Hobby"), so a spawn seam that only works space-free would pass in a
// clean tmpdir and still break in production.
function makeSpacedFixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kt space test-'));
  const echoJs = join(dir, 'echo-args.mjs');
  writeFileSync(echoJs, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  // A .cmd shim delegating to node with %* — the exact shape of pnpm.cmd /
  // node_modules/.bin/*.CMD, which Node >=22 refuses to spawn without a shell.
  const echoCmd = join(dir, 'echo-args.cmd');
  writeFileSync(echoCmd, `@"${process.execPath}" "${echoJs}" %*\r\n`);
  return { dir, echoJs, echoCmd };
}

test('spawnWithTreeKill: direct exe spawn passes space-containing args intact (all platforms)', async () => {
  const child = spawnWithTreeKill(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', 'foo bar', 'baz'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const { code, stdout } = await collect(child);
  assert.equal(code, 0);
  // node itself consumes the `--` separator; the payload args must survive intact
  assert.deepEqual(JSON.parse(stdout), ['foo bar', 'baz']);
});

test(
  'spawnWithTreeKill: a .cmd shim receives quoted/space/metachar args VERBATIM (the F1 pin)',
  { skip: process.platform !== 'win32' },
  async () => {
    const { dir, echoCmd } = makeSpacedFixtureDir();
    try {
      // The args a debugging session actually passes: a quoted test-name filter
      // with spaces (the arg shell:true silently re-split, running the FULL
      // suite — the exact herd this plan prevents), a cmd metachar, quotes.
      const args = ['--testNamePattern', 'slow test name', 'a&b', 'he said "hi"'];
      const child = spawnWithTreeKill(echoCmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
      const { code, stdout } = await collect(child);
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(stdout), args);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'spawnWithTreeKill: a bare command name resolves to its .cmd via PATH (the pnpm shape)',
  { skip: process.platform !== 'win32' },
  async () => {
    const { dir } = makeSpacedFixtureDir();
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${dir}${delimiter}${oldPath}`;
      const child = spawnWithTreeKill('echo-args', ['foo bar'], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const { code, stdout } = await collect(child);
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(stdout), ['foo bar']);
    } finally {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('spawnWithTreeKill: rejects a shell option loudly (it would reintroduce the F1 splitting)', () => {
  assert.throws(() => spawnWithTreeKill('node', [], { shell: true }), /shell.*not accepted/i);
  // even a falsy shell is rejected — presence signals a caller porting the old pattern
  assert.throws(() => spawnWithTreeKill('node', [], { shell: false }), /shell.*not accepted/i);
});

test('spawnWithTreeKill: registers a prepended exit-kill listener and detaches it on close', async () => {
  const before = process.listenerCount('exit');
  const child = spawnWithTreeKill(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.equal(process.listenerCount('exit'), before + 1);
  await new Promise((resolve) => child.once('close', resolve));
  assert.equal(process.listenerCount('exit'), before);
});

test('spawnWithTreeKill: spawn failure emits error (never throws sync) and detaches the exit listener', async () => {
  const before = process.listenerCount('exit');
  const child = spawnWithTreeKill('definitely-not-a-real-command-1785', [], { stdio: 'ignore' });
  const err = await new Promise((resolve) => child.once('error', resolve));
  assert.ok(err);
  // error may fire without close; the error handler itself must detach
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(process.listenerCount('exit'), before);
});

// ── killProcessTreeByPid — the shared bare-pid primitive (plan 4087 review round 2, reuse
// finding coord-child-probe.mjs:194): extracted OUT of killProcessTree below so a caller with
// no ChildProcess handle (coord-child-probe.mjs's killProcessByPid, for a pid discovered by
// enumerating live processes) shares the exact same walk, ordering, and self-pid guard —
// instead of hand-rolling a second copy that can drift (round 1 did exactly that, and the copy
// had dropped the self-pid guard). Every seam injected — never a real taskkill/ps or a real
// signal to a real pid.
test('killProcessTreeByPid: win32 shells straight to taskkill /pid <p> /T /F and reports { ok: true }', () => {
  const calls = [];
  const result = killProcessTreeByPid(4242, { platform: 'win32', _taskkill: (p) => calls.push(p) });
  assert.deepEqual(result, { ok: true, descendantsFailed: [], enumerationFailed: false });
  assert.deepEqual(calls, [4242]);
});

test('killProcessTreeByPid: POSIX signals descendants deepest-first, then the target pid last', () => {
  const signalled = [];
  const pairs = [
    [778, 777],
    [779, 778],
  ];
  const result = killProcessTreeByPid(777, {
    platform: 'linux',
    _processKill: (pid, signal) => signalled.push([pid, signal]),
    _listPairs: () => pairs,
  });
  assert.deepEqual(result, { ok: true, descendantsFailed: [], enumerationFailed: false });
  assert.deepEqual(signalled, [
    [779, 'SIGTERM'],
    [778, 'SIGTERM'],
    [777, 'SIGTERM'],
  ]);
});

// The exact bug this whole finding is about: round 1's hand-rolled copy in coord-child-probe.mjs
// dropped this guard, so a corrupt/racy pid→ppid snapshot that happened to list THIS process
// among the discovered pid's descendants could signal the process running the healer itself.
test('killProcessTreeByPid: POSIX never signals the current process, even if the snapshot lists it as a descendant', () => {
  const signalled = [];
  const pairs = [
    [process.pid, 777], // corrupt/racy snapshot
    [778, 777],
  ];
  const result = killProcessTreeByPid(777, {
    platform: 'linux',
    _processKill: (pid, signal) => signalled.push([pid, signal]),
    _listPairs: () => pairs,
  });
  assert.deepEqual(result, { ok: true, descendantsFailed: [], enumerationFailed: false });
  assert.ok(signalled.every(([pid]) => pid !== process.pid));
  assert.deepEqual(signalled, [
    [778, 'SIGTERM'],
    [777, 'SIGTERM'],
  ]);
});

test('killProcessTreeByPid: the final direct-kill throwing degrades to { ok: false }, never throws', () => {
  const result = killProcessTreeByPid(777, {
    platform: 'linux',
    _processKill: () => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    },
    // an empty (not null) pairs list — enumeration SUCCEEDED with no descendants; this test is
    // about the direct-kill throw, not the enumeration-failure case covered below.
    _listPairs: () => [],
  });
  assert.deepEqual(result, { ok: false, descendantsFailed: [], enumerationFailed: false });
});

// plan 4087 review round 4 (finding kill-tree.mjs:454 — a descendant-enumeration failure was
// still reported as a clean tree kill): `enumerationFailed` marks this as a PARTIAL kill, the
// same honest shape a signalled descendant that survived gets — with no descendant list we
// cannot confirm any descendant was actually reached. Both a null-return and a throw from
// `_listPairs` are enumeration failures; each gets its own pin below.
test('killProcessTreeByPid: POSIX descendant-enumeration unavailable (listPairs returns null) is reported enumerationFailed:true — the target is still signalled', () => {
  const signalled = [];
  const result = killProcessTreeByPid(777, {
    platform: 'linux',
    _processKill: (pid, signal) => signalled.push([pid, signal]),
    _listPairs: () => null,
  });
  assert.deepEqual(result, { ok: true, descendantsFailed: [], enumerationFailed: true });
  assert.deepEqual(signalled, [[777, 'SIGTERM']]);
});

test('killProcessTreeByPid: POSIX descendant-enumeration failure (listPairs throws) is reported enumerationFailed:true — the target is still signalled', () => {
  const signalled = [];
  const result = killProcessTreeByPid(777, {
    platform: 'linux',
    _processKill: (pid, signal) => signalled.push([pid, signal]),
    _listPairs: () => {
      throw new Error('ps: command not found');
    },
  });
  assert.deepEqual(result, { ok: true, descendantsFailed: [], enumerationFailed: true });
  assert.deepEqual(signalled, [[777, 'SIGTERM']]);
});

// plan 4087 review round 3 (finding kill-tree.mjs:427/428 — tree-kill success used to reflect
// only the target pid, invisibly ignoring a descendant that failed to die): a descendant whose
// signal throws something OTHER than ESRCH (permission denied, a cross-user re-exec, …) is now
// recorded in `descendantsFailed` — the target pid can still be genuinely killed (`ok: true`),
// but the caller (coord-child-probe.mjs's killProcessByPid) needs to be able to tell a PARTIAL
// kill apart from a clean one, which the old bare-boolean return could never express.
test('killProcessTreeByPid: POSIX a descendant whose signal fails for a REAL reason (not ESRCH) is recorded in descendantsFailed — the target is still signalled', () => {
  const signalled = [];
  const pairs = [[778, 777]];
  const result = killProcessTreeByPid(777, {
    platform: 'linux',
    _processKill: (pid, signal) => {
      if (pid === 778) throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      signalled.push([pid, signal]);
    },
    _listPairs: () => pairs,
  });
  assert.deepEqual(result, { ok: true, descendantsFailed: [778], enumerationFailed: false });
  assert.deepEqual(
    signalled,
    [[777, 'SIGTERM']],
    'the target itself is still signalled despite the descendant failure',
  );
});

test('killProcessTreeByPid: POSIX a descendant that already raced away (ESRCH) is NOT counted as a failure', () => {
  const pairs = [[778, 777]];
  const result = killProcessTreeByPid(777, {
    platform: 'linux',
    _processKill: (pid) => {
      if (pid === 778) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    },
    _listPairs: () => pairs,
  });
  assert.deepEqual(result, { ok: true, descendantsFailed: [], enumerationFailed: false });
});

// plan 4087 review round 3 (finding kill-tree.mjs:386 — Windows kill success used to ignore
// taskkill's own exit status): the shared outer try/catch already converts a THROWING
// `_taskkill` into `{ ok: false }` on the POSIX side (proven above); this pins the same contract
// on win32, which the fixed default `_taskkill` now relies on (it throws on a non-zero
// `spawnSync` status instead of silently discarding the result — see that default's own header).
test('killProcessTreeByPid: win32 a THROWING _taskkill (the fixed default throws on a non-zero exit status) degrades to { ok: false }, never throws itself', () => {
  const result = killProcessTreeByPid(4242, {
    platform: 'win32',
    _taskkill: () => {
      // access-denied or a genuine partial failure — a THROWING _taskkill here is deliberately
      // NOT exit 128, which round 4 reclassified as "already gone", not a failure (see the
      // isTaskkillAlreadyGoneExit tests below).
      throw new Error('taskkill /pid 4242 /T /F exited 1');
    },
  });
  assert.deepEqual(result, { ok: false, descendantsFailed: [], enumerationFailed: false });
});

// plan 4087 review round 4 (finding kill-tree.mjs:399 — a normal PID-exit race on Windows was
// converted into a failed kill): taskkill's own default `_taskkill` (used when a caller passes
// none) treats exit 128 as "already gone", not a failure — pinned via the exported pure
// predicate rather than spawning a real taskkill.exe.
test('isTaskkillAlreadyGoneExit: 128 ("process not found") is a race, not a failure; other non-zero codes are real failures', () => {
  assert.equal(isTaskkillAlreadyGoneExit(128), true);
  assert.equal(isTaskkillAlreadyGoneExit(1), false);
  assert.equal(isTaskkillAlreadyGoneExit(0), false);
});

// killProcessTree (the ChildProcess-handle caller) now delegates to killProcessTreeByPid above —
// the real-process tests below ("terminates a live child…", the plan-2738 escalation pair, the
// repeated-call and already-exited guards) all still exercise that delegation end-to-end and
// stayed green through this refactor unchanged; killProcessTreeByPid's own unit tests above
// cover the shared primitive's internals (ordering, self-pid guard, degrade paths) directly.

test('killProcessTree: no-op (no throw) on null / undefined / already-killed / pid-less procs', () => {
  killProcessTree(null);
  killProcessTree(undefined);
  killProcessTree({ killed: true, pid: 1 });
  killProcessTree({ killed: false, pid: null }); // spawn-failure shape: ChildProcess with no pid
});

test('killProcessTree: terminates a live child and the close event fires', async () => {
  // A child that would otherwise run forever. Spawned WITHOUT shell so the pid
  // is the node process itself on every platform (the win32 shell-wrapper tree
  // case is exactly what taskkill /T covers in production; exercising it here
  // would only re-test taskkill itself).
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  // Give the child a beat to actually start before killing it.
  await new Promise((r) => setTimeout(r, 300));
  killProcessTree(child);
  const outcome = await new Promise((resolve) => {
    child.once('close', () => resolve('closed'));
    setTimeout(() => resolve('timeout'), 10_000).unref();
  });
  assert.equal(outcome, 'closed');
  // And a second call on the now-dead child is still a safe no-op — guarded by
  // BOTH the alreadyKilled set and the exitCode check (proc.killed alone never
  // trips on the win32 taskkill path; delta-review finding, plan 1761).
  killProcessTree(child);
});

// ── plan 2738: two-phase escalation over the WHOLE tree ──────────────────────
// landing-queue-watch aborts an in-flight land-prep by signalling, waiting a grace,
// then escalating. Escalating with a bare `child.kill('SIGKILL')` would reach only
// the prep's own node process and leave the `git` grandchildren — which already
// ignored the first round's SIGTERM — still writing the worktree, i.e. exactly the
// racing writer the tree walk exists to reach (four independent review finders).
test('plan 2738 killProcessTree: `force` re-arms the once-only guard so SIGKILL can follow SIGTERM', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 300));
  killProcessTree(child, { signal: 'SIGTERM' });
  // Without `force` the alreadyKilled guard swallows the second round — which is the
  // right default (it is what keeps a repeated teardown call from signalling a pid the
  // OS may have recycled), and precisely why the escalation has to opt out of it.
  killProcessTree(child, { signal: 'SIGKILL', force: true });
  const outcome = await new Promise((resolve) => {
    child.once('close', () => resolve('closed'));
    setTimeout(() => resolve('timeout'), 10_000).unref();
  });
  assert.equal(outcome, 'closed');
});

test('plan 2738 killProcessTree: `force` still refuses a pid the OS may have recycled', async () => {
  // The one guard force must NOT relax: once the child has exited, its number is the
  // OS's to reassign, and no amount of caller urgency makes signalling it acceptable.
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.once('close', resolve));
  assert.notEqual(child.exitCode ?? child.signalCode, null, 'the child really exited');
  killProcessTree(child, { signal: 'SIGKILL', force: true }); // must be a silent no-op, never a throw
});

test('killProcessTree: repeated calls before exit do not re-issue the kill (no throw, pid-recycle-safe)', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 300));
  killProcessTree(child);
  killProcessTree(child); // second call in the killed-but-not-yet-reaped window → WeakSet guard
  const outcome = await new Promise((resolve) => {
    child.once('close', () => resolve('closed'));
    setTimeout(() => resolve('timeout'), 10_000).unref();
  });
  assert.equal(outcome, 'closed');
});

test('killProcessTree: a child that already exited on its own is never re-killed', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('close', resolve));
  assert.notEqual(child.exitCode, null); // precondition: the OS may recycle this pid now
  killProcessTree(child); // must early-return on exitCode, not taskkill a recyclable pid
});

// ---------------------------------------------------------------------------
// POSIX descendant walk (plan 1813) — these tests are the acceptance pins for
// the kill-time /proc-walk design and are skipped on win32 (taskkill /T owns
// that platform). They MUST run green on Linux (Docker/cloud drain/CI).
// isAlive (zombie-aware) / getPgid / forceKillPids live in the shared
// kill-tree-test-lib.mjs — one /proc-parsing convention, one home.
// ---------------------------------------------------------------------------

async function pollUntilDead(pids, timeoutMs = 8_000) {
  // ambient-load-ok: this IS the event-driven shape the gate asks for — the loop returns the
  // instant every pid is gone, so the deadline never decides the verdict on a healthy run. It is
  // the single generous hang backstop, and the value it returns on expiry is one final live
  // `isAlive` reading, not "the clock ran out", so a slow box yields a correct late answer.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((p) => !isAlive(p))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pids.every((p) => !isAlive(p));
}

test(
  'killProcessTree (POSIX): kills grandchildren and great-grandchildren, not just the child',
  { skip: process.platform === 'win32' },
  async () => {
    // A self-recursing fixture: each level forks the next and idles forever,
    // printing the forked pid to the shared stdout pipe. Depth 2 under the
    // spawned child gives child → grandchild → great-grandchild — deep enough
    // to prove the walk actually recurses (a single-level `pgrep -P` fake
    // would pass a grandchild-only test).
    const dir = mkdtempSync(join(tmpdir(), 'kt-tree-'));
    const fixture = join(dir, 'tree.mjs');
    writeFileSync(
      fixture,
      [
        "import { spawn } from 'node:child_process';",
        "import { fileURLToPath } from 'node:url';",
        'const depth = Number(process.argv[2]);',
        'if (depth > 0) {',
        '  const c = spawn(process.execPath, [fileURLToPath(import.meta.url), String(depth - 1)],',
        "    { stdio: ['ignore', 'inherit', 'ignore'] });",
        '  console.log(c.pid);',
        '}',
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );
    // Tracked outside the try so the finally can SIGKILL-sweep whatever was
    // actually spawned — an assertion or timeout firing BEFORE the kill under
    // test must not leak the infinite-idle fixture tree (review finding).
    let child;
    let descendants = [];
    try {
      child = spawn(process.execPath, [fixture, '2'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      // Two descendant pids arrive on the shared pipe: the grandchild (printed
      // by the child) and the great-grandchild (printed by the grandchild).
      descendants = await new Promise((resolve, reject) => {
        let buf = '';
        child.stdout.on('data', (d) => {
          buf += d;
          const pids = buf.split('\n').filter(Boolean).map(Number);
          if (pids.length >= 2) resolve(pids.slice(0, 2));
        });
        child.once('error', reject);
        setTimeout(
          () => reject(new Error(`tree fixture never reported 2 pids (got: ${buf})`)),
          10_000,
        ).unref();
      });
      assert.ok(descendants.every((p) => Number.isInteger(p) && p > 0));
      assert.ok(descendants.every(isAlive), 'precondition: the whole tree is alive');
      killProcessTree(child);
      const closed = await new Promise((resolve) => {
        child.once('close', () => resolve(true));
        setTimeout(() => resolve(false), 10_000).unref();
      });
      assert.equal(closed, true, 'the child itself must die');
      assert.equal(
        await pollUntilDead(descendants),
        true,
        `descendants survived the tree kill: ${descendants.filter(isAlive).join(', ')}`,
      );
    } finally {
      forceKillPids([...descendants, child?.pid]);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'spawnWithTreeKill (POSIX): child shares the parent process group (run_bounded SIGKILL regression pin)',
  { skip: process.platform === 'win32' },
  async () => {
    // The plan-1785 revert: a detached child leaves the group GNU
    // `timeout --kill-after` SIGKILLs, surviving as an orphan on exactly the
    // forceful-kill path. The 1813 walk must never re-detach — pin it.
    const child = spawnWithTreeKill(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    await new Promise((r) => setTimeout(r, 300));
    try {
      const childPgid = getPgid(child.pid);
      const ownPgid = getPgid(process.pid);
      assert.ok(Number.isInteger(childPgid) && childPgid > 0);
      assert.equal(childPgid, ownPgid, 'child must stay in the parent process group');
    } finally {
      killProcessTree(child);
      await new Promise((resolve) => {
        child.once('close', resolve);
        setTimeout(resolve, 10_000).unref();
      });
    }
  },
);

// ---------------------------------------------------------------------------
// plan 3929 — export visibility + confirmTreeDead (whole-tree death
// confirmation). Split out of plan 3912: a supervisor that confirms only the
// direct child's 'close' event misses a surviving grandchild.
// ---------------------------------------------------------------------------

test(
  'listPidPpidPairs / collectDescendants: exported and directly usable (plan 3929)',
  { skip: process.platform === 'win32' },
  () => {
    const pairs = listPidPpidPairs();
    assert.ok(pairs === null || Array.isArray(pairs), 'null or an array — the documented contract');
    if (pairs) {
      const descendants = collectDescendants(process.pid, pairs);
      assert.ok(Array.isArray(descendants));
      assert.ok(!descendants.includes(process.pid), 'descendants-only, per its own contract');
    }
  },
);

test(
  'confirmTreeDead: reports a grandchild that outlives a direct-child-only kill (plan 3929)',
  { skip: process.platform === 'win32' },
  async () => {
    // Models the exact bug this plan fixes: a caller kills ONLY the direct
    // child (process.kill(child.pid), not killProcessTree) and a grandchild
    // the child spawned survives it, undetected by a direct-child-only confirm.
    const dir = mkdtempSync(join(tmpdir(), 'kt-survivor-'));
    const fixture = join(dir, 'spawn-then-idle.mjs');
    writeFileSync(
      fixture,
      [
        "import { spawn } from 'node:child_process';",
        // stdio fully 'ignore' (never 'inherit') — a grandchild sharing the
        // direct child's stdout pipe would keep that pipe's write end open
        // after the child itself exits, so the child's own 'close' event
        // (which waits for EOF on every stdio stream) would never fire while
        // the grandchild we are deliberately leaving alive still holds it.
        "const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
        "  { stdio: ['ignore', 'ignore', 'ignore'] });",
        'console.log(gc.pid);',
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );
    let child;
    let grandchild;
    try {
      child = spawn(process.execPath, [fixture], { stdio: ['ignore', 'pipe', 'ignore'] });
      grandchild = await new Promise((resolve, reject) => {
        let buf = '';
        child.stdout.on('data', (d) => {
          buf += d;
          const pid = Number(buf.trim());
          if (Number.isInteger(pid) && pid > 0) resolve(pid);
        });
        child.once('error', reject);
        setTimeout(
          () => reject(new Error(`fixture never reported a grandchild pid (got: ${buf})`)),
          10_000,
        ).unref();
      });
      assert.ok(isAlive(child.pid) && isAlive(grandchild), 'precondition: both alive');
      // Snapshot while BOTH are alive — a snapshot taken after the kill would
      // find nothing to walk, which is exactly the bug this plan closes.
      const snapshot = snapshotDescendants(child.pid);
      assert.deepEqual(
        snapshot.map((s) => s.pid),
        [grandchild],
      );
      process.kill(child.pid); // direct child ONLY — never the grandchild
      await new Promise((resolve) => {
        child.once('close', () => resolve());
        setTimeout(resolve, 10_000).unref();
      });
      const result = await confirmTreeDead(child.pid, snapshot, { timeoutMs: 500, pollMs: 50 });
      assert.equal(result.dead, false, 'the grandchild is still alive — must not report dead:true');
      assert.deepEqual(
        result.survivors.map((s) => s.pid),
        [grandchild],
      );
    } finally {
      // killProcessTree(child) is a documented no-op once child has already
      // exited (its exitCode/signalCode guard) — it cannot reach the now-
      // orphaned grandchild either, since that walk roots at child.pid too.
      // forceKillPids is the only thing here that reliably reaps the
      // grandchild the test deliberately left alive.
      killProcessTree(child);
      forceKillPids([grandchild, child?.pid]);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('confirmTreeDead: a recycled pid (same pid, LATER start time) is not a survivor, even under its original ppid (D2, plan 3929 round 1)', async () => {
  // The bug the retired ppid-based rule had (findings 2170c5 et al.): if the
  // ORIGINAL parent pid itself got recycled, `ppidOf.has(ppid)` read that
  // recycled parent as proof of legitimacy — so a pid could even keep its
  // snapshotted ppid by pure coincidence and still be misread as "ours".
  // Start time is what actually proves it, independent of ppid entirely:
  // pid 100 is present, and under the SAME ppid it had before, but its
  // starttime moved forward — conclusive proof the OS handed this pid number
  // to an unrelated process while we were watching.
  const snapshot = [{ pid: 100, ppid: 555, startTime: '1000' }];
  const fakePairs = () => [[100, 555]]; // same ppid as the snapshot — no longer proof of anything
  const result = await confirmTreeDead(1, snapshot, {
    // Explicit non-win32 platform: this scenario is POSIX-only (mocked
    // listPairs/identityOf have no win32 meaning). Without this the test
    // silently exercises the win32 short-circuit on a Windows dev machine
    // instead of the enumeration logic it claims to test (plan 3952).
    platform: 'linux',
    timeoutMs: 50,
    pollMs: 10,
    listPairs: fakePairs,
    identityOf: (pid) => (pid === 100 ? '4000' : null), // strictly later starttime → recycled
  });
  assert.equal(result.dead, true);
  assert.deepEqual(result.survivors, []);
});

test('confirmTreeDead: a reparented survivor (ppid changed, start time UNCHANGED) is still a survivor (D2, plan 3929 round 1)', async () => {
  // The primary scenario this whole helper exists for: the kernel reparents
  // a still-alive descendant to the nearest subreaper (usually pid 1) the
  // INSTANT its own parent dies, no grace period. ppid moves (555 -> 1);
  // starttime does not (measured on this container, per processStartTime's
  // own comment). Identity survives the reparent — ppid needs no special
  // case at all now.
  const snapshot = [{ pid: 100, ppid: 555, startTime: '1000' }];
  const fakePairs = () => [[100, 1]]; // reparented to the reaper; 555 no longer present
  const result = await confirmTreeDead(1, snapshot, {
    // Explicit non-win32 platform (plan 3952) — see the recycled-pid test above.
    platform: 'linux',
    timeoutMs: 50,
    pollMs: 10,
    listPairs: fakePairs,
    identityOf: () => '1000', // same starttime — proven still ours despite the new ppid
  });
  assert.equal(result.dead, false);
  assert.deepEqual(result.survivors, [{ pid: 100, ppid: 1 }]);
});

test('confirmTreeDead: an unverifiable identity (no starttime available anywhere) degrades to survivor, never dead (D2 fail-safe)', async () => {
  // The `ps`-fallback platform (no /proc at all) never has a starttime to
  // compare — identityOf returns null both at snapshot time and here. With
  // no evidence either way the honest, fail-SAFE answer is "still a
  // survivor", never a fabricated "confirmed gone".
  const snapshot = [{ pid: 100, ppid: 555, startTime: null }];
  const fakePairs = () => [[100, 1]];
  const result = await confirmTreeDead(1, snapshot, {
    // Explicit non-win32 platform (plan 3952) — see the recycled-pid test above.
    platform: 'linux',
    timeoutMs: 50,
    pollMs: 10,
    listPairs: fakePairs,
    identityOf: () => null,
  });
  assert.equal(result.dead, false);
  assert.deepEqual(result.survivors, [{ pid: 100, ppid: 1 }]);
});

test('confirmTreeDead: a zombie descendant (state Z) cannot write and is never reported a survivor (D4, plan 3929 round 1)', async () => {
  // A force-killed orphan reparented onto a non-reaping pid 1 (plain `node
  // --test` in Docker, no init) stays present in the process table forever
  // as state 'Z' (defunct) — kill-tree-test-lib.mjs's isAlive is already
  // zombie-aware for exactly this reason (see its own comment). Without the
  // same awareness here, a zombie produces a PERMANENT spurious KILL_FAILED.
  const snapshot = [{ pid: 100, ppid: 555, startTime: '1000' }];
  const fakePairs = () => [[100, 1]];
  const result = await confirmTreeDead(1, snapshot, {
    // Explicit non-win32 platform (plan 3952) — see the recycled-pid test above.
    platform: 'linux',
    timeoutMs: 50,
    pollMs: 10,
    listPairs: fakePairs,
    identityOf: () => '1000', // identity matches — would be a survivor if not for the zombie state
    stateOf: () => 'Z',
  });
  assert.equal(result.dead, true);
  assert.deepEqual(result.survivors, []);
});

test('confirmTreeDead: a snapshot that could not be taken (null) never resolves dead:true, even once enumeration later works (D3, plan 3929 round 1)', async () => {
  // snapshotDescendants returns null (never []) when the PRE-kill
  // enumeration itself failed — there is then no baseline descendant set to
  // check survivors against. A transient failure followed by listPairs()
  // recovering by confirm time must still never read as "the tree is dead".
  const result = await confirmTreeDead(1, null, {
    // Explicit non-win32 platform (plan 3952) — see the recycled-pid test above.
    platform: 'linux',
    timeoutMs: 50,
    pollMs: 10,
    listPairs: () => [], // enumeration WORKS here — the point is the pre-kill snapshot never did
  });
  assert.equal(result.dead, false);
  assert.deepEqual(result.survivors, []);
  assert.equal(result.enumerationUnavailable, true);
});

test('snapshotDescendants: returns null (not []) when enumeration is unavailable — distinct from "genuinely no descendants" (D3)', () => {
  assert.equal(snapshotDescendants(1, null), null);
  assert.deepEqual(snapshotDescendants(1, []), []); // pairs usable; root just has none
});

test('confirmTreeDead: win32 trusts taskkill /T /F as its own whole-tree confirmation and never touches POSIX enumeration (D1, plan 3929 round 1)', async () => {
  // No `{ skip: ... }` here on purpose — this pins the win32 BRANCH, which
  // must be exercisable from Linux/CI (win32 CI does not run this file).
  // listPairs is injected to THROW if ever called, proving the win32 path
  // short-circuits before any POSIX enumeration attempt — the platform
  // symbol under test (listPidPpidPairs legitimately returns null on
  // win32; a half-injected test that fakes only the platform NAME would
  // pass even if the win32 branch fell through to the POSIX loop and
  // called listPairs() anyway, which is exactly the D1 regression).
  const result = await confirmTreeDead(1234, [{ pid: 1, ppid: 1, startTime: '1' }], {
    platform: 'win32',
    listPairs: () => {
      throw new Error('POSIX enumeration must never run on win32');
    },
  });
  assert.equal(result.dead, true);
  assert.deepEqual(result.survivors, []);
  assert.equal(result.confirmedByPlatformKill, true);
});

test('confirmTreeDead: an empty snapshot with a gone root resolves dead:true promptly', async () => {
  const result = await confirmTreeDead(999999, [], {
    // Explicit non-win32 platform (plan 3952) — see the recycled-pid test above.
    // Without it this test passed VACUOUSLY on win32 (the short-circuit
    // always returns dead:true) without ever exercising the enumeration
    // loop it names in its own description.
    platform: 'linux',
    timeoutMs: 50,
    pollMs: 10,
    listPairs: () => [],
  });
  assert.equal(result.dead, true);
  assert.deepEqual(result.survivors, []);
});

test('confirmTreeDead: degrades honestly (dead:false, no fabricated survivors) when enumeration is unavailable', async () => {
  // Explicit non-win32 platform (plan 3952) — without it this test read
  // ambient process.platform and, on a Windows dev machine, silently took
  // the win32 short-circuit (always dead:true) instead of the "enumeration
  // came back null" branch its own name and assertions describe.
  const result = await confirmTreeDead(1, [{ pid: 2, ppid: 1 }], {
    platform: 'linux',
    listPairs: () => null,
  });
  assert.equal(result.dead, false);
  assert.deepEqual(result.survivors, []);
  assert.equal(result.enumerationUnavailable, true);
});
