#!/usr/bin/env node
// scripts/drain-run.mjs — path-compat shim: the real module moved to
// scripts/coord/drain-run.mjs (move-to-coord.mjs, vetapp plan 3962). Re-exports its entry
// point so any hook, skill, runbook or allow-list still invoking this path by name keeps
// working unchanged.
import { cliMain as main } from './coord/drain-run.mjs';

try {
  // ASSIGN ONLY A NUMBER. Two entry-point contracts are live in this tree: a `main` that
  // RETURNS its exit code, and one that sets `process.exitCode` itself and returns undefined.
  // A bare `process.exitCode = await main(...)` silently RESETS the second kind to 0 - which
  // turned compute-push-diff.mjs's `--drain-status-only` "no" into a "yes" and skipped the
  // pre-push gate battery on a push carrying real code (plan 3962 Phase 2).
  const code = await main(process.argv.slice(2));
  if (typeof code === 'number') process.exitCode = code;
} catch (e) {
  console.error('drain-run:', e?.message ?? e);
  process.exitCode = 1;
}
