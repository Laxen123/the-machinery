// scripts/coord/coord-child-probe.test.mjs (plan 4087 T3)
// Name-paired with coord-child-probe.mjs — new module (a real testable surface: two raw
// process-row readers, a platform dispatcher, age formatting, and the opt-in kill), see that
// file's own header for why it was extracted rather than folded into heal-main.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listWindowsProcessRows,
  listPosixProcessRows,
  listAllProcessRows,
  listCoordChildren,
  commandLineTargetsPath,
  formatAge,
  killHungCoordChildren,
  killProcessByPid,
} from './coord-child-probe.mjs';

const COORD_DIR = 'C:\\repo\\.claude\\coord-worktree';

// ── listWindowsProcessRows — injected `exec` returns the REAL Win32_Process CIM shape (the
// exact field names our own -Command script selects: ProcessId, CommandLine, CreationDateIso)
// rather than an abstract {pid,commandLine,...} row — this is the "supply the platform's
// SYMBOLS, not just its name" half of the CLAUDE.md platform-assertion rule. Never spawns a
// real powershell.exe.
test('listWindowsProcessRows: parses a multi-row Win32_Process CIM JSON array', () => {
  const json = JSON.stringify([
    {
      ProcessId: 4242,
      CommandLine: 'git -C C:\\repo\\.claude\\coord-worktree fetch --quiet origin master',
      CreationDateIso: '2026-09-22T10:00:00.000Z',
    },
    {
      ProcessId: 55,
      CommandLine: 'notepad.exe',
      CreationDateIso: '2026-09-22T10:05:00.000Z',
    },
  ]);
  const rows = listWindowsProcessRows({ exec: () => json });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pid, 4242);
  assert.match(rows[0].commandLine, /coord-worktree fetch/);
  assert.equal(rows[0].creationDateMs, Date.parse('2026-09-22T10:00:00.000Z'));
});

test('listWindowsProcessRows: a SINGLE CIM match serializes as a bare object, not a 1-element array', () => {
  // ConvertTo-Json's well-known quirk: one matching row is not wrapped in [ ]. Real symptom if
  // unhandled: a lone hung child on an otherwise quiet box silently vanishes from the report.
  const json = JSON.stringify({
    ProcessId: 9,
    CommandLine: 'git -C C:\\repo\\.claude\\coord-worktree reset --hard origin/master',
    CreationDateIso: '2026-09-22T09:00:00.000Z',
  });
  const rows = listWindowsProcessRows({ exec: () => json });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, 9);
});

test('listWindowsProcessRows: empty CIM output (no processes carry a CommandLine) yields no rows', () => {
  assert.deepEqual(listWindowsProcessRows({ exec: () => '' }), []);
  assert.deepEqual(listWindowsProcessRows({ exec: () => '[]' }), []);
});

// ── listPosixProcessRows — injected `exec` returns the REAL `ps -eo pid,lstart,args` shape
// (a header row, then fixed-format ctime lstart ahead of the free-form args tail) — the POSIX
// half of the same platform-symbol rule. Never spawns a real `ps`.
test('listPosixProcessRows: parses `ps -eo pid,lstart,args`-shaped stdout', () => {
  const stdout = [
    '  PID                  STARTED CMD',
    '12345 Mon Sep 22 10:00:00 2026 git -C /repo/.claude/coord-worktree fetch --quiet origin master',
    '   99 Mon Sep 22 09:00:00 2026 sshd: user@pts/0',
    '',
  ].join('\n');
  const rows = listPosixProcessRows({ exec: () => stdout });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pid, 12345);
  assert.match(rows[0].commandLine, /coord-worktree fetch/);
  assert.equal(rows[0].creationDateMs, Date.parse('Mon Sep 22 10:00:00 2026'));
  assert.equal(rows[1].pid, 99);
});

test('listPosixProcessRows: an unparseable row is skipped, not fatal to the whole probe', () => {
  const stdout = ['  PID                  STARTED CMD', 'garbage line with no pid', ''].join('\n');
  assert.deepEqual(listPosixProcessRows({ exec: () => stdout }), []);
});

// plan 4087 review round 3 (findings coord-child-probe.mjs:194 e9c5aa/5dbc34): this is RECOVERY
// tooling — a stuck enumeration subprocess must never itself hang the tool that exists to
// unstick a hang. Proven by inspecting the options `exec` is actually called with, never by
// spawning a real (potentially hanging) powershell.exe/ps.
test('listWindowsProcessRows: passes an explicit subprocess timeout to exec', () => {
  let capturedOpts;
  listWindowsProcessRows({
    exec: (cmd, args, opts) => {
      capturedOpts = opts;
      return '[]';
    },
  });
  assert.equal(typeof capturedOpts.timeout, 'number');
  assert.ok(capturedOpts.timeout > 0);
});

test('listPosixProcessRows: passes an explicit subprocess timeout to exec', () => {
  let capturedOpts;
  listPosixProcessRows({
    exec: (cmd, args, opts) => {
      capturedOpts = opts;
      return '  PID                  STARTED CMD\n';
    },
  });
  assert.equal(typeof capturedOpts.timeout, 'number');
  assert.ok(capturedOpts.timeout > 0);
});

// plan 4087 review round 4 (finding coord-child-probe.mjs:99): `ps -o lstart` prints localized
// day/month names, which the fixed-English regex (and Date.parse) cannot read on a non-English
// box — LC_ALL=C pins the format regardless of the box's actual locale.
test('listPosixProcessRows: forces LC_ALL=C on the ps spawn so lstart is always English-formatted', () => {
  let capturedOpts;
  listPosixProcessRows({
    exec: (cmd, args, opts) => {
      capturedOpts = opts;
      return '  PID                  STARTED CMD\n';
    },
  });
  assert.equal(capturedOpts.env.LC_ALL, 'C');
  // merged into the existing env, not replacing it — an arbitrary pre-existing key (env var name
  // casing is platform-dependent, e.g. "Path" on Windows — pick whatever process.env actually has
  // rather than assuming "PATH") must still be present and unchanged.
  const someExistingKey = Object.keys(process.env)[0];
  assert.equal(capturedOpts.env[someExistingKey], process.env[someExistingKey]);
});

// ── commandLineTargetsPath — the path-boundary matcher (review findings 1ih0n1u/nceh4n/
// iwtsw4/zq14ns/1d7x87q). Each test names the bug class it closes.
test('commandLineTargetsPath: matches the target dir at a real boundary (quoted, trailing segment, exact)', () => {
  assert.equal(
    commandLineTargetsPath(`git -C ${COORD_DIR} fetch --quiet origin master`, COORD_DIR, {
      platform: 'win32',
    }),
    true,
  );
  assert.equal(
    commandLineTargetsPath(`git -C "${COORD_DIR}" fetch`, COORD_DIR, { platform: 'win32' }),
    true,
    'quoted path',
  );
  assert.equal(
    commandLineTargetsPath(`git -C ${COORD_DIR}\\some\\child fetch`, COORD_DIR, {
      platform: 'win32',
    }),
    true,
    'a deeper path under the coord dir',
  );
});

test('commandLineTargetsPath: rejects a SIBLING directory whose name merely extends coordDir (unanchored-match bug)', () => {
  assert.equal(
    commandLineTargetsPath(`git -C ${COORD_DIR}-old fetch`, COORD_DIR, { platform: 'win32' }),
    false,
  );
  assert.equal(
    commandLineTargetsPath(`echo see-also=${COORD_DIR}-backup`, COORD_DIR, { platform: 'win32' }),
    false,
  );
});

test('commandLineTargetsPath: rejects coordDir appearing only as a substring of an unrelated argument', () => {
  assert.equal(
    commandLineTargetsPath(`echo message-mentioning-${COORD_DIR}-in-passing`, COORD_DIR, {
      platform: 'win32',
    }),
    false,
  );
});

test('commandLineTargetsPath: win32 matches regardless of drive-letter case or slash spelling (case-sensitivity bug)', () => {
  const differentCase = COORD_DIR.toUpperCase();
  assert.equal(
    commandLineTargetsPath(`git -C ${differentCase} fetch`, COORD_DIR, { platform: 'win32' }),
    true,
  );
  const forwardSlashed = COORD_DIR.replace(/\\/g, '/');
  assert.equal(
    commandLineTargetsPath(`git -C ${forwardSlashed} fetch`, COORD_DIR, { platform: 'win32' }),
    true,
  );
});

test('commandLineTargetsPath: POSIX stays case-sensitive (a differently-cased path is a real miss, not a false one)', () => {
  const posixDir = '/repo/.claude/coord-worktree';
  assert.equal(
    commandLineTargetsPath(`git -C ${posixDir} fetch`, posixDir, { platform: 'linux' }),
    true,
  );
  assert.equal(
    commandLineTargetsPath(`git -C ${posixDir.toUpperCase()} fetch`, posixDir, {
      platform: 'linux',
    }),
    false,
    'POSIX filesystems are case-sensitive — a case difference is a genuinely different path',
  );
});

test('commandLineTargetsPath: a bare/empty commandLine or targetDir never matches', () => {
  assert.equal(commandLineTargetsPath(undefined, COORD_DIR), false);
  assert.equal(commandLineTargetsPath('notepad.exe', ''), false);
  assert.equal(commandLineTargetsPath('notepad.exe', COORD_DIR), false);
});

// ── listCoordChildren — the platform dispatcher. `platform` is itself a parameter (per the
// confirmTreeDead pattern in kill-tree.mjs), so BOTH branches are exercised here regardless of
// which OS this suite actually runs on; each is proven with THAT platform's real reader
// wired to an injected `exec`, not just a `listRows` bypass, so the dispatch logic itself
// (which reader a given platform value selects) is under test too.
test('listCoordChildren: platform "win32" routes through listWindowsProcessRows with an injected exec', () => {
  const json = JSON.stringify([
    {
      ProcessId: 4242,
      CommandLine: `git -C ${COORD_DIR} fetch --quiet origin master`,
      CreationDateIso: '2026-09-22T10:00:00.000Z',
    },
    { ProcessId: 55, CommandLine: 'notepad.exe', CreationDateIso: '2026-09-22T10:05:00.000Z' },
  ]);
  const now = Date.parse('2026-09-22T10:05:00.000Z');
  const children = listCoordChildren(COORD_DIR, { platform: 'win32', exec: () => json, now });
  assert.equal(children.length, 1, 'only the row whose command line targets the coord dir');
  assert.equal(children[0].pid, 4242);
  assert.equal(children[0].ageMs, 5 * 60_000);
});

test('listCoordChildren: a non-win32 platform routes through listPosixProcessRows with an injected exec', () => {
  const stdout = [
    '  PID                  STARTED CMD',
    `12345 Mon Sep 22 10:00:00 2026 git -C ${COORD_DIR} reset --hard origin/master`,
    '   99 Mon Sep 22 09:00:00 2026 sshd: user@pts/0',
    '',
  ].join('\n');
  const now = Date.parse('Mon Sep 22 10:03:00 2026');
  const children = listCoordChildren(COORD_DIR, { platform: 'linux', exec: () => stdout, now });
  assert.equal(children.length, 1);
  assert.equal(children[0].pid, 12345);
  assert.equal(children[0].ageMs, 3 * 60_000);
});

test('listCoordChildren: `listRows` bypasses both platform readers entirely', () => {
  let realReaderCalled = false;
  const children = listCoordChildren(COORD_DIR, {
    platform: 'win32',
    exec: () => {
      realReaderCalled = true;
      return '[]';
    },
    listRows: () => [{ pid: 1, commandLine: `x ${COORD_DIR} y`, creationDateMs: 0 }],
    now: 5000,
  });
  assert.equal(realReaderCalled, false, 'the injected listRows must short-circuit the real reader');
  assert.deepEqual(children, [
    { pid: 1, commandLine: `x ${COORD_DIR} y`, ageMs: 5000, creationDateMs: 0 },
  ]);
});

test('listCoordChildren: no matching command line yields an empty list', () => {
  const children = listCoordChildren(COORD_DIR, {
    listRows: () => [{ pid: 1, commandLine: 'notepad.exe', creationDateMs: 0 }],
    now: 5000,
  });
  assert.deepEqual(children, []);
});

test('listCoordChildren: an unparseable creation date yields ageMs: null, never NaN', () => {
  const children = listCoordChildren(COORD_DIR, {
    listRows: () => [{ pid: 1, commandLine: `git ${COORD_DIR}`, creationDateMs: NaN }],
    now: 5000,
  });
  assert.equal(children[0].ageMs, null);
  // plan 4087 review round 2: creationDateMs is carried through raw (for the pre-kill identity
  // re-check) — an unparseable value is null here too, never NaN.
  assert.equal(children[0].creationDateMs, null);
});

// ── listAllProcessRows — killHungCoordChildren's own one-enumeration-per-batch primitive
// (plan 4087 review round 3, finding coord-child-probe.mjs:194 efficiency e9c5aa/5dbc34).
// Unlike listCoordChildren, this never filters on a coordDir — it exists purely to answer "what
// does the live table look like right now" for a batch identity re-check.
test('listAllProcessRows: win32 dispatches through listWindowsProcessRows, unfiltered', () => {
  const json = JSON.stringify([
    { ProcessId: 1, CommandLine: 'notepad.exe', CreationDateIso: '2026-09-22T10:00:00.000Z' },
    { ProcessId: 2, CommandLine: 'calc.exe', CreationDateIso: '2026-09-22T10:01:00.000Z' },
  ]);
  const rows = listAllProcessRows({ platform: 'win32', exec: () => json });
  assert.equal(rows.length, 2, 'no coordDir filtering — every row comes through');
  assert.deepEqual(
    rows.map((r) => r.pid),
    [1, 2],
  );
});

test('listAllProcessRows: a non-win32 platform dispatches through listPosixProcessRows, unfiltered', () => {
  const stdout = [
    '  PID                  STARTED CMD',
    '11 Mon Sep 22 10:00:00 2026 sshd: user@pts/0',
    '',
  ].join('\n');
  const rows = listAllProcessRows({ platform: 'linux', exec: () => stdout });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, 11);
});

// ── formatAge ──────────────────────────────────────────────────────────────────────────
test('formatAge: seconds under a minute, minutes at/above it, and an unknown age', () => {
  assert.equal(formatAge(0), '0s');
  assert.equal(formatAge(45_000), '45s');
  assert.equal(formatAge(60_000), '1min');
  assert.equal(formatAge(3 * 60_000 + 20_000), '3min');
  assert.equal(formatAge(null), 'an unknown age');
  assert.equal(formatAge(NaN), 'an unknown age');
});

// ── killHungCoordChildren — the opt-in kill. Never touches a real process; `_kill` is a spy. ─
test('killHungCoordChildren: refuses to run without an explicit ageMs (no baked-in ceiling)', () => {
  assert.throws(
    () => killHungCoordChildren([{ pid: 1, ageMs: 999_999 }], null),
    /no kill-age ceiling/,
  );
  assert.throws(
    () => killHungCoordChildren([{ pid: 1, ageMs: 999_999 }], undefined),
    /no kill-age ceiling/,
  );
  assert.throws(
    () => killHungCoordChildren([{ pid: 1, ageMs: 999_999 }], NaN),
    /no kill-age ceiling/,
  );
});

test('killHungCoordChildren: kills only children at/above the age ceiling, by pid via the injected killer', () => {
  const calls = [];
  const children = [
    { pid: 1, ageMs: 100 }, // young — spared
    { pid: 2, ageMs: 30_000 }, // exactly at the ceiling — killed
    { pid: 3, ageMs: 90_000 }, // well over — killed
    { pid: 4, ageMs: null }, // unknown age — never killed (fail safe)
  ];
  const killed = killHungCoordChildren(children, 30_000, {
    coordDir: COORD_DIR,
    _kill: (pid) => {
      calls.push(pid);
      return { ok: true, reason: 'killed' };
    },
  });
  assert.deepEqual(
    killed.map((c) => c.pid),
    [2, 3],
  );
  // plan 4087 review fix (lrgecf/1ms5c76/g7cc53): `_kill` is now called with the bare pid — the
  // default (killProcessByPid) needs nothing else, and there is no real ChildProcess to shape a
  // stand-in for any more.
  assert.deepEqual(calls, [2, 3]);
  // plan 4087 review round 2 (finding coord-child-probe.mjs:250/251): every eligible child is
  // annotated with its TRUE outcome, never silently assumed killed. Plan 4087 review round 3
  // (finding coord-child-probe.mjs:298, simplification): `killed` is dropped — `reason` alone is
  // the source of truth now.
  assert.ok(killed.every((c) => c.reason === 'killed' && !('killed' in c)));
});

test('killHungCoordChildren: no eligible children calls the killer zero times', () => {
  const calls = [];
  const killed = killHungCoordChildren([{ pid: 1, ageMs: 100 }], 30_000, {
    _kill: (pid) => calls.push(pid),
  });
  assert.deepEqual(killed, []);
  assert.equal(calls.length, 0);
});

// plan 4087 review round 2 (finding coord-child-probe.mjs:250/251 — a failed kill must never be
// reported as a kill): an eligible child whose kill attempt FAILS still appears in the result,
// but truthfully marked `reason: 'kill-failed'`.
test('killHungCoordChildren: an eligible child whose kill FAILS is reported reason:kill-failed — never silently marked killed', () => {
  const children = [{ pid: 5, ageMs: 60_000 }];
  const killed = killHungCoordChildren(children, 30_000, {
    coordDir: COORD_DIR,
    _kill: () => ({ ok: false, reason: 'kill-failed' }),
  });
  assert.equal(killed.length, 1, 'still reported — the caller must know an attempt was made');
  assert.equal(killed[0].reason, 'kill-failed');
  assert.ok(!('killed' in killed[0]), 'killed is dropped — reason is the one source of truth');
});

// plan 4087 review round 2 (finding coord-child-probe.mjs:194/228 — identity re-check): the
// child's discovery-time `creationDateMs`, the coord dir, and `exec` are threaded through to the
// killer, and an identity-changed refusal is reported truthfully too.
//
// plan 4087 review round 4 (finding coord-child-probe.mjs:397, angle-B/C/altitude — a stale batch
// snapshot): round 3 forced every kill in a batch to check identity against ONE shared
// pre-batch snapshot via an injected `_currentRow`. This asserts the opposite now: no
// `_currentRow` override is passed at all, so `_kill`'s own default (killProcessByPid's fresh,
// per-pid `currentProcessRow` read) is what actually runs the identity check, immediately before
// that specific kill.
test("killHungCoordChildren: threads each child's creationDateMs, the coordDir, and exec through to the killer — never a shared pre-batch snapshot", () => {
  const opts = [];
  const children = [{ pid: 6, ageMs: 60_000, creationDateMs: 111 }];
  const fakeExec = () => 'unused';
  const killed = killHungCoordChildren(children, 30_000, {
    coordDir: COORD_DIR,
    exec: fakeExec,
    _kill: (pid, o) => {
      opts.push(o);
      return { ok: false, reason: 'identity-changed' };
    },
  });
  assert.equal(opts[0].expectedStartTime, 111);
  assert.equal(opts[0].coordDir, COORD_DIR);
  assert.equal(opts[0].exec, fakeExec);
  assert.ok(
    !('_currentRow' in opts[0]),
    'no shared snapshot is force-injected — the killer does its own fresh, per-pid read',
  );
  assert.equal(killed[0].reason, 'identity-changed');
  assert.ok(!('killed' in killed[0]));
});

// plan 4087 review round 4 (finding coord-child-probe.mjs:397 — the stale-batch-snapshot fix,
// end-to-end): with the REAL default `_kill` (killProcessByPid, not a stub), a failed fresh
// identity re-read for ONE eligible child degrades ONLY that child to a safe identity-changed
// refusal — proving the per-child read replaces the old shared-batch-snapshot mechanism without
// needing any enumeration plumbing inside killHungCoordChildren itself any more.
test('killHungCoordChildren: an eligible child whose fresh identity re-read fails degrades to a safe identity-changed refusal, never a hang or a throw (real default kill)', () => {
  const children = [{ pid: 1, ageMs: 60_000, creationDateMs: 10 }];
  const killed = killHungCoordChildren(children, 30_000, {
    platform: 'linux',
    coordDir: COORD_DIR,
    exec: () => {
      throw new Error('ETIMEDOUT');
    },
  });
  assert.equal(killed.length, 1);
  assert.equal(killed[0].reason, 'identity-changed');
});

// ── killProcessByPid — the default kill (review findings lrgecf/1ms5c76/g7cc53: the POSIX path
// used to hand killProcessTree a plain object with no `.kill` method, so the kill silently did
// nothing there). Every symbol each branch actually touches is injected — `_taskkill`/
// `_processKill`/`_listPairs`/`_currentRow` — never a bare `process.platform` fake; never spawns
// a real taskkill/ps or signals a real pid.
//
// plan 4087 review round 2: the return value is now `{ ok, reason }` (finding coord-child-probe.mjs:
// 250/251 — a failed kill must never be reported as a kill), never a bare boolean — every test
// below asserts `.ok`/`.reason`, never a loose truthy check.
test('killProcessByPid: win32 shells straight to taskkill /pid <p> /T /F', () => {
  const calls = [];
  const result = killProcessByPid(4242, { platform: 'win32', _taskkill: (p) => calls.push(p) });
  assert.deepEqual(result, { ok: true, reason: 'killed' });
  assert.deepEqual(calls, [4242]);
});

test('killProcessByPid: win32 taskkill throwing (already dead / permission blip) degrades to a kill-failed result, never throws', () => {
  const result = killProcessByPid(4242, {
    platform: 'win32',
    _taskkill: () => {
      throw new Error('taskkill: process not found');
    },
  });
  assert.deepEqual(result, { ok: false, reason: 'kill-failed' });
});

// plan 4087 review round 3 (finding kill-tree.mjs:427/428 — a partial kill must never render as a
// plain success): the target died, but killProcessTreeByPid reports a descendant it could not
// confirm killed (POSIX only — win32's single `taskkill /T /F` call has no per-descendant signal
// of its own to observe, see kill-tree.mjs's own header) — killProcessByPid must surface that as
// its OWN distinct reason, never collapse it into 'killed'.
test('killProcessByPid: POSIX a partial kill (target died, a descendant survived) is reported reason:descendants-survived, never killed', () => {
  const result = killProcessByPid(777, {
    platform: 'linux',
    _processKill: (pid) => {
      if (pid === 778) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    },
    _listPairs: () => [[778, 777]],
  });
  assert.deepEqual(result, { ok: false, reason: 'descendants-survived', descendantsFailed: [778] });
});

// plan 4087 review round 4 (finding kill-tree.mjs:454): a missing descendant enumeration is no
// longer read as a clean kill — the target is still signalled (the original bug this test name
// pins), but the outcome is now the same honest partial-kill shape a failed descendant signal
// gets, since neither case lets us say the tree is actually clean.
test('killProcessByPid: POSIX actually signals the target pid (the exact bug — it used to not), but an unavailable enumeration reports a partial kill, not "killed"', () => {
  const signalled = [];
  const result = killProcessByPid(777, {
    platform: 'linux',
    _processKill: (pid, signal) => signalled.push([pid, signal]),
    _listPairs: () => null, // no descendant enumeration available — direct kill must still fire
  });
  assert.deepEqual(result, { ok: false, reason: 'descendants-survived', descendantsFailed: [] });
  assert.deepEqual(
    signalled,
    [[777, 'SIGKILL']],
    'the target is still signalled despite the enumeration failure',
  );
});

test('killProcessByPid: POSIX signals descendants deepest-first, then the target pid last', () => {
  const signalled = [];
  // 777 -> 778 -> 779 (779 is the deepest grandchild)
  const pairs = [
    [778, 777],
    [779, 778],
    [1, 0],
  ];
  const result = killProcessByPid(777, {
    platform: 'linux',
    _processKill: (pid, signal) => signalled.push([pid, signal]),
    _listPairs: () => pairs,
  });
  assert.deepEqual(result, { ok: true, reason: 'killed' });
  assert.deepEqual(signalled, [
    [779, 'SIGKILL'],
    [778, 'SIGKILL'],
    [777, 'SIGKILL'],
  ]);
});

test('killProcessByPid: POSIX a descendant that already raced away (ESRCH-shaped throw) does not stop the rest', () => {
  const signalled = [];
  const pairs = [
    [778, 777],
    [779, 778],
  ];
  const result = killProcessByPid(777, {
    platform: 'linux',
    _processKill: (pid, signal) => {
      if (pid === 779) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      signalled.push([pid, signal]);
    },
    _listPairs: () => pairs,
  });
  assert.deepEqual(result, { ok: true, reason: 'killed' });
  assert.deepEqual(signalled, [
    [778, 'SIGKILL'],
    [777, 'SIGKILL'],
  ]);
});

// plan 4087 review round 4 (finding kill-tree.mjs:454): same as the null-return case above, but
// via a THROWING _listPairs — either shape of enumeration failure must report the same honest
// partial-kill outcome, never a plain "killed".
test('killProcessByPid: POSIX enumeration failure (listPairs throws) degrades to a direct-pid-only kill, reported as a partial kill, never throws or reports "killed"', () => {
  const signalled = [];
  const result = killProcessByPid(777, {
    platform: 'linux',
    _processKill: (pid, signal) => signalled.push([pid, signal]),
    _listPairs: () => {
      throw new Error('ps: command not found');
    },
  });
  assert.deepEqual(result, { ok: false, reason: 'descendants-survived', descendantsFailed: [] });
  assert.deepEqual(
    signalled,
    [[777, 'SIGKILL']],
    'the target is still signalled despite the enumeration failure',
  );
});

test('killProcessByPid: POSIX the direct kill itself failing (already dead) degrades to a kill-failed result, never throws', () => {
  const result = killProcessByPid(777, {
    platform: 'linux',
    _processKill: () => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    },
    _listPairs: () => null,
  });
  assert.deepEqual(result, { ok: false, reason: 'kill-failed' });
});

// ── killProcessByPid's pre-kill identity re-check (plan 4087 review round 2, finding
// coord-child-probe.mjs:194/228 — kill the process you found, not whoever has its pid now).
// `expectedStartTime` is the identity token discovery recorded; `_currentRow` is the injected
// pre-kill re-read (returning the pid's CURRENT `{ creationDateMs, commandLine }`, or null) —
// never a real /proc read or a real powershell spawn in these tests. Round 3 (finding
// coord-child-probe.mjs:258): `coordDir` is ALSO required for the check to pass, matching
// commandLineTargetsPath's own boundary matcher against the current row's command line — see
// that test group below for the second-resolution-recycling case this specifically closes.
test('killProcessByPid: identity confirmed (same start time AND command line still targets the coord checkout) — proceeds to kill', () => {
  const calls = [];
  const result = killProcessByPid(777, {
    platform: 'linux',
    expectedStartTime: '123456',
    coordDir: COORD_DIR,
    _currentRow: () => ({ creationDateMs: '123456', commandLine: `git -C ${COORD_DIR} fetch` }),
    _processKill: (pid, signal) => calls.push([pid, signal]),
    // an empty (not null) pairs list: enumeration SUCCEEDED and found no descendants — this test
    // is about the identity check, not the enumeration-failure partial-kill case covered above.
    _listPairs: () => [],
  });
  assert.deepEqual(result, { ok: true, reason: 'killed' });
  assert.deepEqual(calls, [[777, 'SIGKILL']]);
});

test('killProcessByPid: identity CHANGED (a different start time) — refuses to kill, never signals the pid', () => {
  const calls = [];
  const result = killProcessByPid(777, {
    platform: 'linux',
    expectedStartTime: '123456',
    coordDir: COORD_DIR,
    // the OS recycled this pid to an unrelated process — the command line still matches by
    // coincidence, so this isolates the start-time mismatch as the sole reason for refusal
    _currentRow: () => ({ creationDateMs: '999999', commandLine: `git -C ${COORD_DIR} fetch` }),
    _processKill: (pid, signal) => calls.push([pid, signal]),
    _listPairs: () => null,
  });
  assert.deepEqual(result, { ok: false, reason: 'identity-changed' });
  assert.deepEqual(calls, [], 'a mismatched pid must never be signalled at all');
});

// plan 4087 review round 3 (finding coord-child-probe.mjs:258 — second-resolution identity):
// `ps -o lstart` (and the CIM CreationDate parsed from it) is only ONE-SECOND precise, so a pid
// recycled to an unrelated process WITHIN the same rounded second still carries the exact SAME
// recorded start time and would pass a start-time-only check. This is the exact window the
// command-line re-check closes.
test('killProcessByPid: same pid, same recorded start time, but a DIFFERENT command line — refused (closes the second-resolution recycling window)', () => {
  const calls = [];
  const result = killProcessByPid(777, {
    platform: 'linux',
    expectedStartTime: '123456',
    coordDir: COORD_DIR,
    _currentRow: () => ({
      creationDateMs: '123456',
      commandLine: '/usr/bin/unrelated-daemon --foo',
    }),
    _processKill: (pid, signal) => calls.push([pid, signal]),
    _listPairs: () => null,
  });
  assert.deepEqual(result, { ok: false, reason: 'identity-changed' });
  assert.deepEqual(
    calls,
    [],
    'a same-second recycled pid with a non-matching command line must never be signalled',
  );
});

test('killProcessByPid: identity re-check finds the pid GONE entirely — refuses to kill, same as a mismatch', () => {
  const calls = [];
  const result = killProcessByPid(777, {
    platform: 'linux',
    expectedStartTime: '123456',
    coordDir: COORD_DIR,
    _currentRow: () => null, // pid no longer present — nothing of ours left to kill
    _processKill: (pid, signal) => calls.push([pid, signal]),
    _listPairs: () => null,
  });
  assert.deepEqual(result, { ok: false, reason: 'identity-changed' });
  assert.deepEqual(calls, []);
});

test('killProcessByPid: identity re-check itself throwing is treated as "cannot confirm" — refuses, never throws', () => {
  const calls = [];
  const result = killProcessByPid(777, {
    platform: 'linux',
    expectedStartTime: '123456',
    coordDir: COORD_DIR,
    _currentRow: () => {
      throw new Error('/proc/777/stat: EPERM');
    },
    _processKill: (pid, signal) => calls.push([pid, signal]),
    _listPairs: () => null,
  });
  assert.deepEqual(result, { ok: false, reason: 'identity-changed' });
  assert.deepEqual(calls, []);
});

// plan 4087 review round 2 (finding coord-child-probe.mjs:217/altitude — reuse): round 1's
// hand-rolled descendant walk had dropped kill-tree.mjs's self-pid guard, so a corrupt/racy
// snapshot that listed THIS process among the discovered pid's descendants could signal the
// healer itself. Now that the walk is shared (kill-tree.mjs's killProcessTreeByPid), the guard
// applies here too — proven without touching the real process table.
test('killProcessByPid: POSIX descendant walk never signals the current process, even if the snapshot lists it', () => {
  const signalled = [];
  const pairs = [
    [process.pid, 777], // corrupt/racy snapshot: OUR pid shows up as a "descendant"
    [778, 777],
  ];
  const result = killProcessByPid(777, {
    platform: 'linux',
    _processKill: (pid, signal) => signalled.push([pid, signal]),
    _listPairs: () => pairs,
  });
  assert.deepEqual(result, { ok: true, reason: 'killed' });
  assert.ok(
    signalled.every(([pid]) => pid !== process.pid),
    `must never signal the running process itself; signalled: ${JSON.stringify(signalled)}`,
  );
  assert.deepEqual(signalled, [
    [778, 'SIGKILL'],
    [777, 'SIGKILL'],
  ]);
});

test('killProcessByPid: no expectedStartTime supplied — no identity check performed (backward compatible), coordDir not required either', () => {
  const calls = [];
  const result = killProcessByPid(777, {
    platform: 'linux',
    _currentRow: () => {
      throw new Error('must never be called — no expectedStartTime was given');
    },
    _processKill: (pid, signal) => calls.push([pid, signal]),
    // an empty (not null) pairs list — this test is about skipping the identity check, not the
    // enumeration-failure partial-kill case covered above.
    _listPairs: () => [],
  });
  assert.deepEqual(result, { ok: true, reason: 'killed' });
  assert.deepEqual(calls, [[777, 'SIGKILL']]);
});

// plan 4087 review round 4 (finding coord-child-probe.mjs:311/312): coordDir used to be
// documented as an optional fallback (start-time-only) but the code always required it — this
// pins the fix: coordDir is now a hard requirement whenever expectedStartTime is supplied, and a
// caller that omits it gets a clear error, never a silent, permanent identity-changed refusal.
test('killProcessByPid: expectedStartTime supplied without coordDir throws a clear error (no silent start-time-only fallback)', () => {
  assert.throws(
    () => killProcessByPid(777, { platform: 'linux', expectedStartTime: '123456' }),
    /coordDir is required whenever expectedStartTime is supplied/,
  );
});

// Orchestrator-caught regression (plan 4087 review round 2 fix): the default identity re-read on
// POSIX used kill-tree.mjs's processStartTime (/proc starttime, clock TICKS) while discovery
// records epoch ms from `ps -o lstart`, so the two could never be equal and EVERY POSIX kill was
// refused as identity-changed. Drive discovery and the kill through the SAME injected `ps`
// output with NO `_currentRow` override, so the default re-read path is the one exercised.
test('killProcessByPid: POSIX default identity re-read uses the discovery reader, so an unchanged process IS killed', () => {
  const stdout = [
    '  PID                  STARTED CMD',
    `12345 Mon Sep 22 10:00:00 2026 git -C ${COORD_DIR} fetch --quiet origin master`,
    '',
  ].join('\n');
  const [child] = listCoordChildren(COORD_DIR, {
    platform: 'linux',
    exec: () => stdout,
    now: Date.parse('Mon Sep 22 10:30:00 2026'),
  });
  const signalled = [];
  const outcome = killProcessByPid(child.pid, {
    platform: 'linux',
    exec: () => stdout,
    expectedStartTime: child.creationDateMs,
    coordDir: COORD_DIR,
    _processKill: (p, s) => signalled.push([p, s]),
    _listPairs: () => [],
  });
  assert.deepEqual(outcome, { ok: true, reason: 'killed' });
  assert.deepEqual(signalled, [[12345, 'SIGKILL']]);
});

test('killProcessByPid: POSIX default identity re-read refuses when the same pid now carries a later start', () => {
  const discovered = `12345 Mon Sep 22 10:00:00 2026 git -C ${COORD_DIR} fetch\n`;
  const recycled = `12345 Mon Sep 22 10:29:00 2026 /usr/bin/unrelated-daemon\n`;
  const [child] = listCoordChildren(COORD_DIR, {
    platform: 'linux',
    exec: () => `  PID STARTED CMD\n${discovered}`,
    now: Date.parse('Mon Sep 22 10:30:00 2026'),
  });
  const signalled = [];
  const outcome = killProcessByPid(child.pid, {
    platform: 'linux',
    exec: () => `  PID STARTED CMD\n${recycled}`,
    expectedStartTime: child.creationDateMs,
    coordDir: COORD_DIR,
    _processKill: (p, s) => signalled.push([p, s]),
    _listPairs: () => [],
  });
  assert.deepEqual(outcome, { ok: false, reason: 'identity-changed' });
  assert.deepEqual(signalled, []);
});
