# scripts/prepush-job-wrapper.ps1 -- kill-on-close Job Object wrapper for the pre-push
# scripts/*.test.mjs battery (plan 1674; operator released the timeout-first pin 2026-07-10).
#
# Runs <command> [args...] so that the spawned tree can never outlive its purpose:
#
#   1. PARENT DEATH (the orphan bug this plan fixes): this wrapper assigns ITSELF to a new
#      Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE before spawning the command, so
#      every descendant inherits membership. If the wrapper is killed along with the push,
#      its death closes the job handle and the KERNEL terminates the whole job -- no
#      surviving process has to do anything. If instead the wrapper SURVIVES while its
#      parent dies (the measured sh<-sh<-DEAD-PID pattern: kills over this tree are
#      non-uniform), the parent-handle watch below notices within ~500ms and the wrapper
#      exits, which closes the handle, which kills the job. Both paths end at the same
#      kernel-guaranteed kill.
#   2. HANG (which a job object alone cannot bound -- it only fires on handle close): an
#      explicit deadline of <capSeconds>. On expiry the wrapper calls
#      TerminateJobObject(job, 124), which atomically terminates EVERY member -- including
#      the wrapper itself -- with exit code 124, deliberately matching GNU timeout's
#      convention so the hook's existing 124-aware retry loop needs no new branch.
#
# Degradation: if Add-Type / job assignment fails (constrained language mode, AV, a host
# that refuses nested jobs), the wrapper warns and falls back to `taskkill /T /F` for the
# deadline and parent-death kills -- weaker (tree-walk races vs atomic job termination),
# but the deadline still applies, and the hook additionally runs a GNU timeout INSIDE this
# wrapper's job with a tighter cap, so a wedged wrapper is backstopped from within (and
# the wrapper's own deadline backstops a wedged inner timeout -- see the hook's ORPHAN
# BOUND block for the layer map).
#
# Usage:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/prepush-job-wrapper.ps1 <capSeconds> <command> [args...]
#
# No param() block on purpose: PowerShell's parameter binder would try to bind tokens like
# `--test` as parameter names; raw $args passes them through verbatim.
#
# Exit codes: the command's own exit code on normal completion; 124 when the cap fires
# (whole job, timeout convention); 3 on parent-death self-termination (unobserved -- the
# parent that would have read it is dead); 96 usage error; 97 spawn failure.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ($args.Count -lt 2) {
  [Console]::Error.WriteLine('prepush-job-wrapper: usage: <capSeconds> <command> [args...]')
  exit 96
}
$capSeconds = 0
if (-not [int]::TryParse([string]$args[0], [ref]$capSeconds) -or $capSeconds -le 0) {
  [Console]::Error.WriteLine("prepush-job-wrapper: capSeconds must be a positive integer, got '$($args[0])'")
  exit 96
}
$command = [string]$args[1]
$commandArgs = @()
if ($args.Count -gt 2) { $commandArgs = @($args[2..($args.Count - 1)]) }

# Arm the wrapper's one overall deadline before any process discovery. The CIM operation timeout
# below is the first bound on the degraded parent lookup. This deadline is armed BEFORE that
# lookup runs, so time spent there is charged against it -- but be precise about what that buys:
# the deadline is only EVALUATED inside the child-wait loop below, so it bounds the post-spawn
# phase, not the pre-arm phase. A wedge inside Add-Type itself is interrupted by NEITHER bound
# (no child exists yet, so the worst case is this one powershell process leaking, covered by the
# plan-1673 reap backstop -- accepted and documented, plan 1674 round 6).
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$capMs = [long]$capSeconds * 1000

$jobSourcePath = Join-Path $PSScriptRoot 'windows-job-interop.cs'

$jobArmed = $false
try {
  # Loading the extracted interop is part of the fail-open arm step: a missing/locked/AV-held
  # source file must degrade to taskkill, never prevent the wrapped command from starting.
  $jobSource = Get-Content -Raw -LiteralPath $jobSourcePath
  Add-Type -TypeDefinition $jobSource -Language CSharp | Out-Null
  $jobArmed = [VetappWindowsJobs.JobInterop]::AssignSelfToKillOnCloseJob()
} catch {
  $jobArmed = $false
}
if (-not $jobArmed) {
  [Console]::Error.WriteLine('prepush-job-wrapper: kill-on-close job unavailable (Add-Type or job assignment failed) -- degrading to taskkill /T fallback; the deadline still applies')
}

# Pin a handle to the parent NOW: .HasExited on a Process object obtained here keeps
# tracking THIS process even if its PID is later reused. If the lookup fails, only the
# fast parent-death path is lost -- wrapper-death handle-close and the deadline remain.
#
# TOPOLOGY REQUIREMENT (review find, session 1535): this watch is only meaningful if the
# wrapper's DIRECT OS parent is a process that actually dies with the push (the hook's own
# sh). The first integration nested this wrapper INSIDE the outer GNU timeout -- whose
# defining, verified property is that it SURVIVES its ancestor's death -- so the watched
# parent never exited and the fast-kill path could never fire. The hook therefore invokes
# this wrapper OUTERMOST (sh -> powershell -> sh -> timeout -> node); GNU timeout runs
# INSIDE the job, where its survive-ancestor-death property is neutralized by job
# termination. Keep it that way.
# The primary lookup is the in-process NtQueryInformationProcess syscall exposed by Add-Type.
# If Add-Type failed, Get-CimInstance's -OperationTimeoutSec is the ONLY active bound on the WMI
# fallback: the wrapper deadline is armed by now but is not evaluated until the child-wait loop,
# so it does not interrupt a lookup that wedges HERE. WMI is service-mediated and can hang under
# host load (plan 1674) -- that is why it is the fallback and never the primary path. This
# cmdlet-only path is what survives constrained language mode, where direct .NET type access --
# including the ProcessStartInfo/WaitForExit bound it replaced -- is forbidden, which is exactly
# the mode that makes Add-Type fail and sends us here.
function Get-ParentPidViaBoundedWmi {
  $row = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -OperationTimeoutSec 3 -ErrorAction Stop
  if ($null -eq $row) { throw 'WMI parent lookup returned no process' }
  return $row.ParentProcessId
}

$parentProc = $null
try {
  $parentPid = -1
  # Type-existence, not $jobArmed: GetParentPid works whenever Add-Type compiled, even
  # if the subsequent job assignment was refused.
  try { $parentPid = [VetappWindowsJobs.JobInterop]::GetParentPid() } catch { $parentPid = -1 }
  if ($parentPid -le 0) { $parentPid = Get-ParentPidViaBoundedWmi }
  if ($parentPid -le 0) { throw "parent lookup failed" }
  $parentProc = Get-Process -Id $parentPid -ErrorAction Stop
} catch {
  $parentProc = $null
  if ($jobArmed) {
    [Console]::Error.WriteLine('prepush-job-wrapper: could not resolve parent process -- parent-death fast-kill disabled for this run (job close-kill + deadline still apply)')
  } else {
    [Console]::Error.WriteLine('prepush-job-wrapper: could not resolve parent process -- parent-death fast-kill and job close-kill are unavailable for this run (deadline taskkill fallback still applies)')
  }
}

function Format-Arg([string]$a) {
  if ($a -match '[\s"]') { return '"' + ($a -replace '"', '\"') + '"' }
  return $a
}

# Spawn THROUGH `sh -c '"$@"'` rather than executing $command directly: a direct
# ProcessStartInfo spawn resolves $command with Windows CreateProcess PATH semantics,
# which silently BYPASSES extensionless sh-script shims earlier on PATH. That is not a
# hypothetical: scripts/pre-push-hook.test.mjs stubs `node` with exactly such a shim, and
# a direct spawn here resolved the REAL node.exe instead -- recursively running the real
# battery inside the hook's own test suite. Routing through sh preserves the hook's own
# resolution semantics exactly (the caller IS sh), costs one ~ms-scale sh process, and
# changes nothing else: sh waits on the command and propagates its exit code, and both
# processes are inside this wrapper's job so every kill path still takes the whole tree.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'sh'
$commandArgs = @('-c', '"$@"', 'prepush-battery', $command) + $commandArgs
$psi.Arguments = (($commandArgs | ForEach-Object { Format-Arg $_ }) -join ' ')
$psi.UseShellExecute = $false # inherit this console's stdio + environment
$child = $null
try {
  $child = [System.Diagnostics.Process]::Start($psi)
} catch {
  [Console]::Error.WriteLine("prepush-job-wrapper: failed to start sh for '$command': $($_.Exception.Message)")
  exit 97
}

# Single kill-tree-and-exit path for both triggers (parent death, cap expiry) -- a
# one-sided edit to the KillJob->taskkill fallback was a reviewed drift hazard. On a
# successful KillJob the whole job -- this process included -- terminates with $code and
# the trailing exit never runs; the taskkill branch is the degraded-mode fallback.
function Stop-Tree([int]$code) {
  $killed = $false
  if ($script:jobArmed) { $killed = [VetappWindowsJobs.JobInterop]::KillJob($code) }
  if (-not $killed) { & taskkill /T /F /PID $script:child.Id 2>$null | Out-Null }
  exit $code
}

while (-not $child.WaitForExit(500)) {
  if ($null -ne $parentProc -and $parentProc.HasExited) {
    # The push is dead; nothing above will ever read our exit code (3 is for a human
    # reading Get-Process output, not for the hook). Job termination and the
    # handle-close-on-exit are the same kernel end state; KillJob is just faster.
    Stop-Tree 3
  }
  if ($clock.ElapsedMilliseconds -ge $capMs) {
    [Console]::Error.WriteLine("prepush-job-wrapper: command exceeded the ${capSeconds}s cap -- terminating the whole tree (exit 124)")
    Stop-Tree 124
  }
}
exit $child.ExitCode
