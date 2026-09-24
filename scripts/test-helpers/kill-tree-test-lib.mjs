// scripts/test-helpers/kill-tree-test-lib.mjs — shared process probes for the kill-tree and
// queued-run test batteries (plan 1813 review round: the zombie-aware liveness
// check and the /proc-stat parsing were triplicated across two test files and
// kill-tree.mjs; this is their one home). TEST-ONLY: production teardown paths
// keep using killProcessTree/spawnWithTreeKill.
//
// Moved here from top-level scripts/kill-tree-test-lib.mjs (coord-kit plan 3958, S2/task-2,
// session 4277): a generic, non-vetapp test helper belongs under scripts/test-helpers/, which
// ships wholesale with the kit — the top-level location left scripts/coord/kill-tree.test.mjs
// (itself wholesale-shipped) importing a file the kit never copied, an ERR_MODULE_NOT_FOUND the
// per-command closure gate can't see because kill-tree.test.mjs is not a name-paired test of any
// shipped top-level command.
import { spawnSync } from 'node:child_process';
import { procStatFields } from '../coord/kill-tree.mjs';

// One probe shape for every field read: the /proc stat field where available
// (indexes per procStatFields' contract), one `ps -o <column>=` elsewhere.
// Returns '' when the pid is gone on the ps path.
function pidField(pid, procIndex, psColumn) {
  const fields = procStatFields(pid); // null → no /proc (macOS/BSD): ask ps
  if (fields) return fields[procIndex];
  const r = spawnSync('ps', ['-o', `${psColumn}=`, '-p', String(pid)], { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

// Zombie-aware liveness: killed descendants get reparented to pid 1, and when
// the test runner IS pid 1 (docker `node --test`) nobody ever wait()s them —
// `kill(pid, 0)` then succeeds forever on a process that has fully terminated.
// State 'Z' means the signal landed, which is what the batteries assert.
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = pidField(pid, 0, 'state');
  return state !== '' && !state.startsWith('Z');
}

// A pid's process-group id — /proc where available, one `ps` elsewhere.
export function getPgid(pid) {
  return Number(pidField(pid, 2, 'pgid'));
}

// Best-effort SIGKILL sweep for a test's failure path — a test that spawns an
// infinite-idle fixture tree must never leak it just because an assertion or
// timeout fired before the kill under test ran. Never throws; dead/undefined
// pids are no-ops.
export function forceKillPids(pids) {
  for (const pid of pids) {
    if (!pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
