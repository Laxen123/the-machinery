import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { applyWindowsCpuCap } from '../coord/win-cpu-cap.mjs';
import { pwshExe, pwshCandidates } from '../coord/pwsh-exec.mjs';

const INTEROP_PATH = join(dirname(fileURLToPath(import.meta.url)), '../windows-job-interop.cs');
const WINDOWS_PROCESS_COMMAND = [
  '$source = Get-Content -Raw -LiteralPath $env:VETAPP_CPU_CAP_INTEROP_PATH',
  'Add-Type -TypeDefinition $source -Language CSharp | Out-Null',
  '$process = [System.Diagnostics.Process]::GetProcessById([int]$env:VETAPP_CPU_CAP_TARGET_PID)',
  'try {',
  '  $parent = [VetappWindowsJobs.JobInterop]::GetParentPidOf($process.Id)',
  '  $name = $null',
  '  $startTicks = $null',
  '  try {',
  '    try { $name = $process.MainModule.ModuleName } catch { $name = $process.ProcessName }',
  '    $startTicks = $process.StartTime.ToUniversalTime().Ticks.ToString()',
  '  } catch { $name = $null; $startTicks = $null }',
  '  [pscustomobject]@{ ProcessId = $process.Id; ParentProcessId = $parent; Name = $name; StartTimeUtcTicks = $startTicks } | ConvertTo-Json -Compress',
  '} finally { $process.Dispose() }',
].join('\n');

export function getWindowsProcess(
  pid,
  {
    env = process.env,
    // Candidate ORDER supplied by this caller, not imported by the resolver (plan 4061 T3).
    runPowerShell = (args, options) =>
      spawnSync(pwshExe({ candidates: pwshCandidates(process.platform) }), args, options),
  } = {},
) {
  const result = runPowerShell(
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_PROCESS_COMMAND,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        VETAPP_CPU_CAP_INTEROP_PATH: INTEROP_PATH,
        VETAPP_CPU_CAP_TARGET_PID: String(pid),
      },
    },
  );
  if (result?.error || result?.status !== 0) {
    const detail =
      result?.error?.message || String(result?.stderr || '').trim() || `exit ${result?.status}`;
    throw new Error(detail);
  }
  const parsed = JSON.parse(result.stdout);
  return {
    pid: Number(parsed.ProcessId),
    parentPid: Number(parsed.ParentProcessId),
    imageName: String(parsed.Name || ''),
    startTimeUtcTicks: String(parsed.StartTimeUtcTicks || ''),
  };
}

export function resolveSessionProcess(
  startPid = process.ppid,
  {
    platform = process.platform,
    getProcess = getWindowsProcess,
    warn = (message) => console.error(message),
    ...listOptions
  } = {},
) {
  if (platform !== 'win32') return null;
  if (!Number.isInteger(startPid) || startPid <= 0) return null;

  try {
    const visited = new Set();
    let currentPid = startPid;
    while (currentPid > 0) {
      if (visited.has(currentPid)) throw new Error(`cycle at pid ${currentPid}`);
      visited.add(currentPid);
      const current = getProcess(currentPid, listOptions);
      if (!current || current.pid !== currentPid) {
        throw new Error(`pid ${currentPid} could not be read`);
      }
      if (current.parentPid < 0) throw new Error(`parent lookup failed at pid ${currentPid}`);
      // Parent linkage remains useful when an exited/protected hop refuses its identity fields.
      // Such a hop cannot be the target, but it must not discard the rest of the ancestor chain.
      if (
        current.imageName &&
        /^\d+$/.test(current.startTimeUtcTicks) &&
        current.imageName.replace(/\.exe$/i, '').toLowerCase() === 'claude'
      ) {
        return current;
      }
      if (current.parentPid === 0 || current.parentPid === current.pid) break;
      currentPid = current.parentPid;
    }
    throw new Error('no claude ancestor found');
  } catch (error) {
    warn(
      `apply-session-cpu-class: could not resolve the session process from pid ${startPid} ` +
        `(${error?.message ?? error}); the session proceeds unchanged`,
    );
    return null;
  }
}

export function applySessionCpuClass(
  target,
  {
    platform = process.platform,
    env = process.env,
    applyCpuCap = (processIdentity, options) => applyWindowsCpuCap(processIdentity, options),
    warn = (message) => console.error(message),
  } = {},
) {
  if (platform !== 'win32' || env.CLAUDE_CODE_REMOTE === 'true') return false;
  if (!Number.isInteger(target?.pid) || target.pid <= 0) return false;
  return applyCpuCap(target, { platform, env, warn });
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform !== 'win32' || env.CLAUDE_CODE_REMOTE === 'true') return false;

  const explicitPid = Number(argv[0]);
  if (Number.isInteger(explicitPid) && explicitPid > 0) {
    let explicitTarget;
    try {
      explicitTarget = (deps.getProcess ?? getWindowsProcess)(explicitPid, { ...deps, env });
    } catch (error) {
      (deps.warn ?? console.error)(
        `apply-session-cpu-class: could not verify explicit pid ${explicitPid} ` +
          `(${error?.message ?? error}); the session proceeds unchanged`,
      );
      return false;
    }
    if (argv.includes('--resolve-only')) {
      (deps.log ?? console.log)(
        `resolved session pid ${explicitTarget.pid} image ${explicitTarget.imageName}`,
      );
      return true;
    }
    return applySessionCpuClass(explicitTarget, { ...deps, platform, env });
  }

  const resolveSession = deps.resolveSession ?? resolveSessionProcess;
  const resolved = resolveSession(process.ppid, { ...deps, platform, env });
  if (!resolved) return false;
  if (argv.includes('--resolve-only')) {
    (deps.log ?? console.log)(`resolved session pid ${resolved.pid} image ${resolved.imageName}`);
    return true;
  }
  return applySessionCpuClass(resolved, { ...deps, platform, env });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
