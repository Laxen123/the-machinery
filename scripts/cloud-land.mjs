#!/usr/bin/env node
// scripts/cloud-land.mjs — entry shim for
// scripts/coord/cloud-land.mjs (plan 4255), the same shim shape as the modules move-to-coord.mjs
// relocated (plan 3962), so skills and runbooks name the flat scripts/ path like every other
// coord CLI.
import { main } from './coord/cloud-land.mjs';

try {
  // ASSIGN ONLY A NUMBER. Two entry-point contracts are live in this tree: a `main` that
  // RETURNS its exit code, and one that sets `process.exitCode` itself and returns undefined.
  // A bare `process.exitCode = await main(...)` silently RESETS the second kind to 0 - which
  // turned compute-push-diff.mjs's `--drain-status-only` "no" into a "yes" and skipped the
  // pre-push gate battery on a push carrying real code (plan 3962 Phase 2).
  const code = await main(process.argv.slice(2));
  if (typeof code === 'number') process.exitCode = code;
} catch (e) {
  console.error('cloud-land:', e?.message ?? e);
  process.exitCode = 1;
}
