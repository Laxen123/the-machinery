// scripts/coord/pytest-memory-budget.mjs — the memory axis of the per-slot pytest worker budget
// (plan 3954 T3). Owns two things, split out of test-queue.mjs per the
// scripts/**-module-layout import-boundary rule (test-queue.mjs stays free of anything but
// atomic-write / win-cpu-cap / build-index-lib) and so this genuinely new module gets its own
// name-paired test file instead of growing test-queue.test.mjs's own surface:
//
//   loadPytestMemoryBudget — reads the measurement plan 3954 T0 committed at
//   scripts/pytest-memory-budget.json ({ perWorkerPeakBytes, p95Bytes, measuredOn, machine,
//   suite, … }). Missing or unreadable (a machine T0 never ran on, a cloud sandbox, a stale/
//   malformed file) degrades to null with ONE logged line — never a throw — so a caller falls
//   back to a CPU-only budget exactly as before this plan.
//
//   memoryWorkerBudget — the pure arithmetic: how many workers of `perWorkerPeakBytes` each fit
//   in `freeBytes`. No admission floor, never zero (plan 1750 ruling, applied again here): a
//   near-zero free-memory reading still returns 1, it never refuses to answer.
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname as osHostname, totalmem as osTotalmem } from 'node:os';
import { scriptsFileFrom } from './scripts-anchor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// `findScriptsFile` is now ONE implementation, `scripts/coord/scripts-anchor.mjs` — see that module for
// why the anchor is the `scripts/` directory NAME and not a repo-root marker or an existsSync
// probe. It used to be copied into each module because Rule 3 forbids a coord-core-destined
// module importing a NON-coord sibling; the shared version lives under `scripts/coord/`, so
// that objection is gone and the copies are retired (plan 3962 Phase 2).
// Kept as a named export (and as this module's default-`HERE` spelling) because the tests and
// importers already name it.
export const findScriptsFile = (name, startDir = HERE) => scriptsFileFrom(name, startDir);

export const DEFAULT_BUDGET_PATH = findScriptsFile('pytest-memory-budget.json');

// `hostname`/`totalMemoryBytes` are injection points (default: the live machine) so the
// host-mismatch check below is testable per the vetapp CLAUDE.md "environment must be a
// parameter" rule, never by reading the real os.hostname()/os.totalmem() from inside a test.
export function loadPytestMemoryBudget(
  path = DEFAULT_BUDGET_PATH,
  { hostname = osHostname(), totalMemoryBytes = osTotalmem() } = {},
) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(
      `pytest-memory-budget: could not read ${path} (${err.code ?? err.message}) — falling back to the CPU-only worker budget.`,
    );
    return null;
  }
  const perWorkerPeakBytes = Number(parsed?.perWorkerPeakBytes);
  if (!Number.isFinite(perWorkerPeakBytes) || perWorkerPeakBytes <= 0) {
    console.error(
      `pytest-memory-budget: ${path} has no usable perWorkerPeakBytes — falling back to the CPU-only worker budget.`,
    );
    return null;
  }
  // The committed figure is a measurement on ONE host at ONE point in time — a different or
  // materially changed local host may see a different real per-worker peak. That is never a
  // reason to reject it (no admission floor applies here either — plan 1750's ruling, applied
  // again in T3), only a reason to say so ONCE so a session investigating an unexpected memory
  // cap knows to look here first (review finding, plan 3954).
  if (typeof parsed?.machine === 'string' && parsed.machine !== hostname) {
    let note =
      `pytest-memory-budget: ${path} was measured on "${parsed.machine}", not this host ` +
      `("${hostname}")`;
    const fileTotal = Number(parsed?.totalMemoryBytes);
    if (
      Number.isFinite(fileTotal) &&
      fileTotal > 0 &&
      Number.isFinite(totalMemoryBytes) &&
      totalMemoryBytes > 0
    ) {
      const deltaFraction = Math.abs(fileTotal - totalMemoryBytes) / totalMemoryBytes;
      if (deltaFraction > 0.25) {
        note += ` and this host's total memory differs by more than 25% (file ${fileTotal}B vs this host ${totalMemoryBytes}B)`;
      }
    }
    note += ' — using the committed figure anyway.';
    console.error(note);
  }
  // A budget file written before plan 3954's review round 2 (or hand-trimmed) carries no
  // `controllerPeakBytes` at all — treat that exactly like 0 (no controller term), never a
  // missing-field crash, so the old file shape keeps loading unchanged (review finding, plan
  // 3954 round 2).
  const controllerPeakBytes = Number.isFinite(Number(parsed?.controllerPeakBytes))
    ? Math.max(0, Number(parsed.controllerPeakBytes))
    : 0;
  return { ...parsed, perWorkerPeakBytes, controllerPeakBytes };
}

// controllerPeakBytes (plan 3954 review round 2) is the xdist CONTROLLER's own peak subtree RSS —
// an ADDITIONAL, fixed cost every slot pays once before any worker even starts, not folded into
// `perWorkerPeakBytes`. Omitting it here (as the original T3 formula did) let a slot admit workers
// against the WHOLE share, when the real cost is controller-plus-N-workers — reproducing exactly
// the spawn-starvation this budget exists to prevent. The numerator is clamped at 0 (never
// negative) before the floor/max-1: a slot whose share is smaller than the controller's own cost
// still returns 1, never a refusal — the plan 1750 no-admission-floor ruling applies to this term
// too. `controllerPeakBytes` defaults to 0 so an old call site (or an old committed budget file,
// see loadPytestMemoryBudget below) that never supplies it keeps behaving exactly as before.
export function memoryWorkerBudget(freeBytes, perWorkerPeakBytes, controllerPeakBytes = 0) {
  if (
    !Number.isFinite(freeBytes) ||
    !Number.isFinite(perWorkerPeakBytes) ||
    perWorkerPeakBytes <= 0
  ) {
    return null;
  }
  const safeControllerPeakBytes = Number.isFinite(controllerPeakBytes)
    ? Math.max(0, controllerPeakBytes)
    : 0;
  const numerator = Math.max(0, freeBytes - safeControllerPeakBytes);
  return Math.max(1, Math.floor(numerator / perWorkerPeakBytes));
}
