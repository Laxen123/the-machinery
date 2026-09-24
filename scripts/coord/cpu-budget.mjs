// Shared machine-level CPU budget for the Windows hard cap and per-queue-slot soft limits.
//
// 90, not 80, by operator ruling 2026-08-30 (plan 3544). Offered "shipping 80, 90 is one env var",
// the operator answered verbatim: "start there" — so 90 is the shipped default and 80 is the
// tune-down. On the 20-thread dev box that reserves 2 threads for the desktop and gives each of
// the two queue slots 9 workers. Retune per session with VETAPP_CPU_CAP_PERCENT; both the hard
// job cap and the soft per-slot worker budget derive from THIS constant, so they cannot drift.
export const DEFAULT_CPU_CAP_PERCENT = 90;

// plan 4096 T1: the ONE CPU probe, moved here from pytest-workers.mjs (which re-exports it, so its
// own runner policy and every existing importer are unchanged). The land spine needs a CPU count
// for `perSlotWorkerBudget`, which declares no default for it (plan 4034), and the spine is core:
// it may not reach pytest-workers.mjs, which is pytest-shaped project tooling. A pure `node:os`
// reading, so it belongs with the machine-level CPU budget constant above.
import os from 'node:os';

export function detectedCpuCount() {
  return Math.max(1, Math.floor(os.availableParallelism?.() ?? os.cpus().length));
}
