// New test-file justification: name-paired tests for the new win-cpu-cap.mjs module.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { scriptFile } from '../test-helpers/repo-script-path.mjs';

import {
  applySessionCpuClass,
  getWindowsProcess,
  main as applySessionMain,
  resolveSessionProcess,
} from '../hooks/apply-session-cpu-class.mjs';
import {
  CPU_CAP_JOB_NAME,
  DEFAULT_CPU_CAP_PERCENT,
  applyWindowsCpuCap,
  cpuCapPercent,
  findScriptsFile,
} from './win-cpu-cap.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const TARGET = {
  pid: 4242,
  parentPid: 100,
  imageName: 'claude.exe',
  startTimeUtcTicks: '638921088000000000',
};
const processLookup = (rows) => (pid) => {
  const row = rows.find((entry) => entry.ProcessId === pid);
  if (!row) return null;
  return {
    pid: row.ProcessId,
    parentPid: row.ParentProcessId,
    imageName: row.Name,
    startTimeUtcTicks: row.StartTimeUtcTicks ?? String(638921088000000000n + BigInt(pid)),
  };
};

test('the named cap defaults to 90 percent and can be retuned', () => {
  assert.equal(CPU_CAP_JOB_NAME, String.raw`Local\vetapp-heavy`);
  assert.equal(cpuCapPercent({}), DEFAULT_CPU_CAP_PERCENT);
  assert.equal(cpuCapPercent({ VETAPP_CPU_CAP_PERCENT: '90' }), 90);
  assert.equal(cpuCapPercent({ VETAPP_CPU_CAP_PERCENT: '79.5' }), 79.5);
});

test('a tiny positive percentage clamps to the minimum valid CpuRate', () => {
  const calls = [];
  assert.equal(
    applyWindowsCpuCap(TARGET, {
      platform: 'win32',
      env: { VETAPP_CPU_CAP_PERCENT: '0.001' },
      runPowerShell: (args, options) => {
        calls.push({ args, options });
        return { status: 0, stderr: '', stdout: '3\n' };
      },
    }),
    true,
  );
  assert.equal(calls[0].options.env.VETAPP_CPU_CAP_RATE, '1');
});

test('Windows assignment passes the target pid, shared job name, and hundredths-of-percent rate', () => {
  const calls = [];
  const ok = applyWindowsCpuCap(TARGET, {
    platform: 'win32',
    env: { VETAPP_CPU_CAP_PERCENT: '90' },
    runPowerShell: (args, options) => {
      calls.push({ args, options });
      return { status: 0, stderr: '', stdout: '3\n' };
    },
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 4), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
  ]);
  assert.equal(calls[0].options.env.VETAPP_CPU_CAP_TARGET_PID, '4242');
  assert.equal(calls[0].options.env.VETAPP_CPU_CAP_TARGET_IMAGE, 'claude.exe');
  assert.equal(calls[0].options.env.VETAPP_CPU_CAP_TARGET_START_TICKS, TARGET.startTimeUtcTicks);
  assert.equal(calls[0].options.env.VETAPP_CPU_CAP_JOB_NAME, CPU_CAP_JOB_NAME);
  assert.equal(calls[0].options.env.VETAPP_CPU_CAP_RATE, '9000');
  assert.match(calls[0].options.env.VETAPP_CPU_CAP_INTEROP_PATH, /windows-job-interop\.cs$/);
});

test('non-Windows and remote paths do not touch Windows symbols', () => {
  const runPowerShell = () => assert.fail('Windows process symbol must not be called');
  assert.equal(applyWindowsCpuCap(TARGET, { platform: 'linux', env: {}, runPowerShell }), false);
  assert.equal(
    applyWindowsCpuCap(TARGET, {
      platform: 'win32',
      env: { CLAUDE_CODE_REMOTE: 'true' },
      runPowerShell,
    }),
    false,
  );
});

test('VETAPP_CPU_CAP=0 skips only job assignment and still requests BelowNormal demotion', () => {
  const calls = [];
  assert.equal(
    applyWindowsCpuCap(TARGET, {
      platform: 'win32',
      env: { VETAPP_CPU_CAP: '0' },
      runPowerShell: (args, options) => {
        calls.push({ args, options });
        return { status: 0, stderr: '', stdout: '1\n' };
      },
    }),
    true,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.VETAPP_CPU_CAP_RATE, '0');
});

test('invalid configuration and refused assignment warn once and fail open', () => {
  for (const setup of [
    { env: { VETAPP_CPU_CAP_PERCENT: '0' }, runPowerShell: () => assert.fail('must not run') },
    { env: {}, runPowerShell: () => ({ status: 1, stderr: 'refused' }) },
  ]) {
    const warnings = [];
    assert.equal(
      applyWindowsCpuCap(TARGET, {
        platform: 'win32',
        ...setup,
        warn: (message) => warnings.push(message),
      }),
      false,
    );
    assert.equal(warnings.length, 1);
  }
});

test('priority demotion and cap assignment still fail open independently', () => {
  for (const [resultCode, warningPattern] of [
    ['1', /could not assign pid 4242/],
    ['2', /could not demote pid 4242/],
  ]) {
    const warnings = [];
    assert.equal(
      applyWindowsCpuCap(TARGET, {
        platform: 'win32',
        env: {},
        runPowerShell: () => ({ status: 0, stderr: '', stdout: resultCode }),
        warn: (message) => warnings.push(message),
      }),
      true,
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], warningPattern);
  }
});

test('SessionStart applies the identity-checked Windows policy and fails open', () => {
  const capCalls = [];
  assert.equal(
    applySessionCpuClass(TARGET, {
      platform: 'win32',
      env: {},
      applyCpuCap: (target, options) => {
        capCalls.push([target, options.platform]);
        return true;
      },
    }),
    true,
  );
  assert.deepEqual(capCalls, [[TARGET, 'win32']]);

  assert.doesNotThrow(() =>
    applySessionCpuClass(TARGET, {
      platform: 'win32',
      env: {},
      applyCpuCap: () => false,
    }),
  );
});

test('SessionStart is a clean non-Windows no-op with all platform symbols injected', () => {
  const applyCpuCap = () => assert.fail('applyCpuCap must not be called');
  assert.equal(applySessionCpuClass(TARGET, { platform: 'linux', env: {}, applyCpuCap }), false);
});

test('SessionStart resolves the claude ancestor instead of guessing that the shell parent is claude', () => {
  const processes = [
    { ProcessId: 400, ParentProcessId: 300, Name: 'bash.exe' },
    { ProcessId: 300, ParentProcessId: 200, Name: 'conhost.exe' },
    { ProcessId: 200, ParentProcessId: 100, Name: 'claude.exe' },
    { ProcessId: 100, ParentProcessId: 0, Name: 'pwsh.exe' },
  ];
  assert.deepEqual(
    resolveSessionProcess(400, {
      platform: 'win32',
      getProcess: processLookup(processes),
    }),
    {
      pid: 200,
      parentPid: 100,
      imageName: 'claude.exe',
      startTimeUtcTicks: '638921088000000200',
    },
  );
});

test('SessionStart fails open when no claude ancestor exists', () => {
  const processes = [
    { ProcessId: 400, ParentProcessId: 300, Name: 'bash.exe' },
    { ProcessId: 300, ParentProcessId: 0, Name: 'session-host.exe' },
  ];
  const warnings = [];
  assert.equal(
    resolveSessionProcess(400, {
      platform: 'win32',
      getProcess: processLookup(processes),
      warn: (message) => warnings.push(message),
    }),
    null,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no claude ancestor found/);
});

test('SessionStart walks past an unreadable intermediate identity', () => {
  const processes = [
    { ProcessId: 400, ParentProcessId: 300, Name: 'bash.exe' },
    { ProcessId: 300, ParentProcessId: 200, Name: '', StartTimeUtcTicks: '' },
    { ProcessId: 200, ParentProcessId: 100, Name: 'claude.exe' },
  ];
  assert.equal(
    resolveSessionProcess(400, {
      platform: 'win32',
      getProcess: processLookup(processes),
    })?.pid,
    200,
  );
});

test('SessionStart ancestor-walk failures warn and fail open', () => {
  const warnings = [];
  assert.equal(
    resolveSessionProcess(400, {
      platform: 'win32',
      getProcess: processLookup([{ ProcessId: 400, ParentProcessId: 300, Name: 'bash.exe' }]),
      warn: (message) => warnings.push(message),
    }),
    null,
  );
  assert.equal(warnings.length, 1);
});

test('a -1 parent lookup sentinel fails open instead of resolving the current process', () => {
  const warnings = [];
  assert.equal(
    resolveSessionProcess(400, {
      platform: 'win32',
      getProcess: processLookup([{ ProcessId: 400, ParentProcessId: -1, Name: 'bash.exe' }]),
      warn: (message) => warnings.push(message),
    }),
    null,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /parent lookup failed/);
});

test('ancestor cycles are detected while walking one process at a time', () => {
  const calls = [];
  const warnings = [];
  assert.equal(
    resolveSessionProcess(400, {
      platform: 'win32',
      getProcess: (pid) => {
        calls.push(pid);
        return {
          pid,
          parentPid: pid === 400 ? 300 : 400,
          imageName: 'bash.exe',
          startTimeUtcTicks: String(638921088000000000n + BigInt(pid)),
        };
      },
      warn: (message) => warnings.push(message),
    }),
    null,
  );
  assert.deepEqual(calls, [400, 300]);
  assert.match(warnings[0], /cycle at pid 400/);
});

test('production ancestor transport reads exactly one requested process and its identity', () => {
  const calls = [];
  const processIdentity = getWindowsProcess(400, {
    env: {},
    runPowerShell: (args, options) => {
      calls.push({ args, options });
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          ProcessId: 400,
          ParentProcessId: 200,
          Name: 'bash.exe',
          StartTimeUtcTicks: '638921088000000400',
        }),
      };
    },
  });
  assert.deepEqual(processIdentity, {
    pid: 400,
    parentPid: 200,
    imageName: 'bash.exe',
    startTimeUtcTicks: '638921088000000400',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.VETAPP_CPU_CAP_TARGET_PID, '400');
  const command = calls[0].args.at(-1);
  assert.equal(command.match(/Add-Type/g)?.length, 1);
  assert.match(command, /GetParentPidOf/);
  assert.match(command, /GetProcessById/);
  assert.match(command, /StartTime/);
  assert.doesNotMatch(command, /GetProcesses/);
  assert.doesNotMatch(command, /AssignProcessToCpuCap|claude|while/);
});

test('SessionStart production path resolves through the tested JavaScript walk before applying', () => {
  const capCalls = [];
  const rows = [
    { ProcessId: process.ppid, ParentProcessId: 200, Name: 'bash.exe' },
    { ProcessId: 200, ParentProcessId: 100, Name: 'claude.exe' },
  ];
  assert.equal(
    applySessionMain([], {
      platform: 'win32',
      env: {},
      getProcess: processLookup(rows),
      applyCpuCap: (target) => {
        capCalls.push(target);
        return true;
      },
    }),
    true,
  );
  assert.equal(capCalls[0].pid, 200);
  assert.equal(capCalls[0].imageName, 'claude.exe');
  assert.equal(capCalls[0].startTimeUtcTicks, '638921088000000200');
});

test('identity mismatch at assignment warns and fails open without touching the recycled pid', () => {
  const warnings = [];
  assert.equal(
    applyWindowsCpuCap(TARGET, {
      platform: 'win32',
      env: {},
      runPowerShell: () => ({
        status: 2,
        stdout: '',
        stderr: 'target process identity changed before policy assignment',
      }),
      warn: (message) => warnings.push(message),
    }),
    false,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /identity changed/);
});

test('an unresolved session target changes neither priority nor job membership', () => {
  const mustNotRun = () => assert.fail('an unresolved process must remain untouched');
  assert.equal(
    applySessionMain([], {
      platform: 'win32',
      env: {},
      getProcess: processLookup([
        { ProcessId: process.ppid, ParentProcessId: 0, Name: 'bash.exe' },
      ]),
      applyCpuCap: mustNotRun,
      warn: () => {},
    }),
    false,
  );
});

test('remote SessionStart opts out before process discovery', () => {
  assert.equal(
    applySessionMain([], {
      platform: 'win32',
      env: { CLAUDE_CODE_REMOTE: 'true' },
      getProcess: () => assert.fail('remote startup must not inspect processes'),
    }),
    false,
  );
});

test('--resolve-only uses the production resolver and never changes priority or cap membership', () => {
  const logs = [];
  const rows = [
    { ProcessId: process.ppid, ParentProcessId: 200, Name: 'bash.exe' },
    { ProcessId: 200, ParentProcessId: 100, Name: 'claude.exe' },
  ];
  assert.equal(
    applySessionMain(['--resolve-only'], {
      platform: 'win32',
      env: {},
      getProcess: processLookup(rows),
      applyCpuCap: () => assert.fail('resolve-only must not assign a cap'),
      log: (message) => logs.push(message),
    }),
    true,
  );
  assert.deepEqual(logs, ['resolved session pid 200 image claude.exe']);
});

test('an explicit pid overrides ancestor resolution for deterministic tests and recovery', () => {
  const capCalls = [];
  assert.equal(
    applySessionMain(['4242'], {
      platform: 'win32',
      env: {},
      getProcess: (pid) => ({ ...TARGET, pid }),
      applyCpuCap: (target) => {
        capCalls.push(target);
        return true;
      },
    }),
    true,
  );
  assert.equal(capCalls[0].pid, 4242);
  assert.equal(capCalls[0].startTimeUtcTicks, TARGET.startTimeUtcTicks);
});

test('findScriptsFile: survives this module moving to scripts/coord/ (plan 3962 P1)', () => {
  // windows-job-interop.cs is committed data that is NOT moving with win-cpu-cap.mjs. Simulate
  // this module living one level deeper (its post-move location) and confirm the sibling still
  // resolves to the real scripts/ directory, not scripts/coord/. No coord.config.json anywhere
  // — there is none in the real scripts/test-helpers/isolated-plan-repo.mjs fixture either (see
  // findScriptsFile's doc comment), so this deliberately does not create one.
  const root = mkdtempSync(join(tmpdir(), 'vetapp-scripts-file-'));
  try {
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir);
    writeFileSync(join(scriptsDir, 'windows-job-interop.cs'), '// stub');
    const simulatedCoordDir = join(scriptsDir, 'coord');
    mkdirSync(simulatedCoordDir);
    assert.equal(
      findScriptsFile('windows-job-interop.cs', scriptsDir),
      join(scriptsDir, 'windows-job-interop.cs'),
    );
    assert.equal(
      findScriptsFile('windows-job-interop.cs', simulatedCoordDir),
      join(scriptsDir, 'windows-job-interop.cs'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findScriptsFile: post-move resolution does NOT depend on the sibling existing on disk', () => {
  // The regression class an earlier (existsSync-based) version of this walk was still exposed
  // to: if the sibling has not been WRITTEN yet, an existence probe finds nothing at any
  // ancestor and falls back to `join(startDir, name)` — scripts/coord/windows-job-interop.cs,
  // the wrong directory, exactly the class of bug this whole fix exists to close. Anchoring on
  // the `scripts` directory NAME (not on whether the .cs file is present) must still resolve
  // correctly here, with windows-job-interop.cs never created at all.
  const root = mkdtempSync(join(tmpdir(), 'vetapp-scripts-file-nofile-'));
  try {
    const scriptsDir = join(root, 'scripts');
    const simulatedCoordDir = join(scriptsDir, 'coord');
    mkdirSync(simulatedCoordDir, { recursive: true }); // windows-job-interop.cs is never written
    assert.equal(
      findScriptsFile('windows-job-interop.cs', simulatedCoordDir),
      join(scriptsDir, 'windows-job-interop.cs'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findScriptsFile: pre-move (module directly IN scripts/) resolves with zero ancestor walk', () => {
  // The other direction of the same invariant: called from a directory whose own basename is
  // already `scripts` (today's real location, before plan 3962's move), no walk is needed.
  const root = mkdtempSync(join(tmpdir(), 'vetapp-scripts-file-premove-'));
  try {
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir);
    assert.equal(
      findScriptsFile('windows-job-interop.cs', scriptsDir),
      join(scriptsDir, 'windows-job-interop.cs'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findScriptsFile: falls back to alongside startDir when no ancestor is named scripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'vetapp-scripts-file-no-anchor-'));
  try {
    assert.equal(
      findScriptsFile('windows-job-interop.cs', root),
      join(root, 'windows-job-interop.cs'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findScriptsFile: resolves against the REAL isolated-plan-repo.mjs fixture, from a simulated scripts/coord/ location', async () => {
  // The exact mechanism a sister worker's module broke against (a repo-root-marker walk found
  // no marker in this fixture and silently resolved wrong): makeIsolatedRepo copies the WHOLE
  // scripts/ tool tree, nested dirs included, into <tmp>/scripts/ — no coord.config.json, no
  // other repo-root file, ever. scripts/coord/ is part of that copy, so simulating this
  // module's post-move location is just pointing startDir at the fixture's own copied
  // scripts/coord/ — no synthetic tree needed.
  const { makeIsolatedRepo } = await import('../test-helpers/isolated-plan-repo.mjs');
  const repo = makeIsolatedRepo({
    prefix: 'win-cpu-cap-fixture',
    basename: '9999-Test-fixture-only.md',
    body: '# fixture plan\n',
  });
  try {
    const simulatedCoordDir = join(repo.scriptsDir, 'coord');
    assert.ok(existsSync(simulatedCoordDir), 'fixture must have copied scripts/coord/');
    assert.equal(
      findScriptsFile('windows-job-interop.cs', simulatedCoordDir),
      join(repo.scriptsDir, 'windows-job-interop.cs'),
    );
  } finally {
    repo.cleanup();
  }
});
