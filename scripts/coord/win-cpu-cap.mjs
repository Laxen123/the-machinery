import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CPU_CAP_PERCENT } from './cpu-budget.mjs';
import { pwshExe, pwshCandidates } from './pwsh-exec.mjs';
import { scriptsFileFrom } from './scripts-anchor.mjs';

export const CPU_CAP_JOB_NAME = String.raw`Local\vetapp-heavy`;
export { DEFAULT_CPU_CAP_PERCENT };

const HERE = dirname(fileURLToPath(import.meta.url));

// `findScriptsFile` is now ONE implementation, `scripts/coord/scripts-anchor.mjs` — see that module for
// why the anchor is the `scripts/` directory NAME and not a repo-root marker or an existsSync
// probe. It used to be copied into each module because Rule 3 forbids a coord-core-destined
// module importing a NON-coord sibling; the shared version lives under `scripts/coord/`, so
// that objection is gone and the copies are retired (plan 3962 Phase 2).
// Kept as a named export (and as this module's default-`HERE` spelling) because the tests and
// importers already name it.
export const findScriptsFile = (name, startDir = HERE) => scriptsFileFrom(name, startDir);

const INTEROP_PATH = findScriptsFile('windows-job-interop.cs');
const POWERSHELL_COMMAND = [
  '$source = Get-Content -Raw -LiteralPath $env:VETAPP_CPU_CAP_INTEROP_PATH',
  'Add-Type -TypeDefinition $source -Language CSharp | Out-Null',
  '$result = [VetappWindowsJobs.JobInterop]::ApplyProcessCpuPolicy([int]$env:VETAPP_CPU_CAP_TARGET_PID, $env:VETAPP_CPU_CAP_TARGET_IMAGE, [long]$env:VETAPP_CPU_CAP_TARGET_START_TICKS, $env:VETAPP_CPU_CAP_JOB_NAME, [uint32]$env:VETAPP_CPU_CAP_RATE)',
  "if ($result -eq -1) { Write-Error 'target process identity changed before policy assignment'; exit 2 }",
  '$result',
  'if ($result -eq 0) { exit 1 }',
].join('; ');

export function cpuCapPercent(env = process.env) {
  const raw = env.VETAPP_CPU_CAP_PERCENT;
  if (raw === undefined || raw === '') return DEFAULT_CPU_CAP_PERCENT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : null;
}

export function applyWindowsCpuCap(
  target,
  {
    platform = process.platform,
    env = process.env,
    // Candidate ORDER supplied by this caller, not imported by the resolver (plan 4061 T3).
    // `platform` (destructured just above) rather than `process.platform`, so a test that injects
    // a platform gets that platform's candidate list too — the repo's half-injection rule.
    runPowerShell = (args, options) =>
      spawnSync(pwshExe({ candidates: pwshCandidates(platform) }), args, options),
    warn = (message) => console.error(message),
  } = {},
) {
  if (platform !== 'win32' || env.CLAUDE_CODE_REMOTE === 'true') {
    return false;
  }
  const pid = Number(target?.pid);
  const imageName = String(target?.imageName || '');
  const startTimeUtcTicks = String(target?.startTimeUtcTicks || '');
  if (!Number.isInteger(pid) || pid <= 0 || !imageName || !/^\d+$/.test(startTimeUtcTicks)) {
    warn('win-cpu-cap: target identity is incomplete; the session proceeds unchanged');
    return false;
  }

  const capEnabled = env.VETAPP_CPU_CAP !== '0';
  const percent = capEnabled ? cpuCapPercent(env) : null;
  if (capEnabled && percent === null) {
    warn(
      `win-cpu-cap: invalid VETAPP_CPU_CAP_PERCENT=${env.VETAPP_CPU_CAP_PERCENT}; ` +
        'the session proceeds without a CPU cap',
    );
    return false;
  }

  try {
    // Zero is an internal sentinel for "demote priority, but skip job assignment". The public
    // percentage parser still rejects zero, so VETAPP_CPU_CAP=0 remains the only way to request it.
    const cpuRate = capEnabled ? Math.max(1, Math.round(percent * 100)) : 0;
    const result = runPowerShell(
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        POWERSHELL_COMMAND,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...env,
          VETAPP_CPU_CAP_INTEROP_PATH: INTEROP_PATH,
          VETAPP_CPU_CAP_TARGET_PID: String(pid),
          VETAPP_CPU_CAP_TARGET_IMAGE: imageName,
          VETAPP_CPU_CAP_TARGET_START_TICKS: startTimeUtcTicks,
          VETAPP_CPU_CAP_JOB_NAME: CPU_CAP_JOB_NAME,
          VETAPP_CPU_CAP_RATE: String(cpuRate),
        },
      },
    );
    if (result?.error || result?.status !== 0) {
      const detail =
        result?.error?.message || String(result?.stderr || '').trim() || `exit ${result?.status}`;
      throw new Error(detail);
    }
    const changed = Number.parseInt(String(result.stdout || '').trim(), 10);
    if ((changed & 1) === 0) {
      warn(`apply-session-cpu-class: could not demote pid ${pid} to BelowNormal`);
    }
    if (capEnabled && (changed & 2) === 0) {
      warn(`win-cpu-cap: could not assign pid ${pid} to the shared ${percent}% CPU cap`);
    }
    return changed > 0;
  } catch (error) {
    warn(
      `win-cpu-cap: could not apply the session CPU policy to pid ${pid} ` +
        `(${error?.message ?? error}); the session proceeds unchanged`,
    );
    return false;
  }
}
