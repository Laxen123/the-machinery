// scripts/coord/land/container-manifest.mjs — plan 4066 task 0: the ONE place that asserts
// every core module's declared container-read manifest against the REAL bound container, at boot,
// before any land phase runs.
//
// WHY A SEPARATE AGGREGATOR, NOT AN ASSERTION INSIDE EACH MODULE. The natural-looking shape —
// each core module calling `requireDeps` on its own manifest at its own top level, right where its
// own `CONTAINER_READS` is declared — cannot work: every reader (`preflight.mjs`, `lane-merge.mjs`,
// and the rest) already imports `landDeps`/`requireDeps` from `./deps.mjs`, and `landDeps()` throws
// until `bindLandDeps()` has run. A module-top-level call would fire at IMPORT time, which is
// before done-worktree.mjs has bound the real container — so the assertion would always throw,
// unconditionally, on every load. Moving the assertion inside each module's own entry-point
// FUNCTION instead of its top level avoids that ordering problem, but buys nothing over one
// aggregator doing the same ten checks: ten call sites instead of one, each needing the same
// import of `requireDeps`, for the same one-shot check. One aggregator, called once, right after
// the real bind, is simpler and is what this file is.
//
// WHY NOT INSIDE bindLandDeps() ITSELF (deps.mjs). Every core module reader already imports
// `landDeps`/`requireDeps` FROM deps.mjs — so deps.mjs importing back the ten readers' own
// `CONTAINER_READS` manifests to assert them from inside `bindLandDeps()` would be an import
// cycle. This file breaks that cycle the ordinary way: it imports the ten readers (and
// deps.mjs), and nothing imports it back except the boot script.
//
// WHY ONE MODULE ASSERTING TEN MANIFESTS, NOT TEN SEPARATE GROUP-LEVEL CHECKS PER MEMBER READ.
// `preflight.mjs` alone exports 22 names and reads 59 container members across 8 groups; wiring
// `requireDeps` at every individual read site (rather than once per group, per module) would be
// noise, and a forgotten read site is exactly the same silent `undefined` this net exists to
// convert into a named throw — a manifest asserted whole, at boot, has no forgettable call sites.
//
// CYCLE-FREE BY CONSTRUCTION. This file imports the ten core modules and deps.mjs; nothing under
// scripts/coord/land/ imports this file back — only scripts/done-worktree.mjs does, right after its
// own `bindLandDeps({...})` call closes. Rule 3 (docs/runbooks/scripts-module-layout.md) is
// satisfied the same way every other core module satisfies it: imports stay inside scripts/coord/**
// and node: builtins.
import { landDeps, requireDeps } from './deps.mjs';
import { CONTAINER_READS as SPINE_READS } from './spine.mjs';
import { CONTAINER_READS as PREFLIGHT_READS } from './preflight.mjs';
import { CONTAINER_READS as CLOSE_OUT_READS } from './close-out.mjs';
import { CONTAINER_READS as GATES_RUNNER_READS } from './gates-runner.mjs';
import { CONTAINER_READS as QUEUE_READS } from './queue.mjs';
import { CONTAINER_READS as LANE_MERGE_READS } from './lane-merge.mjs';
import { CONTAINER_READS as HEAD_LOCK_READS } from './head-lock.mjs';
import { CONTAINER_READS as TEARDOWN_READS } from './teardown.mjs';
import { CONTAINER_READS as REBASE_SYNC_READS } from './rebase-sync.mjs';
import { CONTAINER_READS as QUEUE_PROBE_READS } from './queue-probe.mjs';

/**
 * Module id → its declared container-read manifest, for every core module that reads the land
 * dependency container. The test suite iterates this map (container-manifest.test.mjs's parity
 * test) rather than re-listing the ten modules a second time, so adding an eleventh core module's
 * manifest here is the ONE place that widens both the boot-time assertion and the parity test.
 */
export const CORE_MODULE_MANIFESTS = Object.freeze({
  'spine.mjs': SPINE_READS,
  'preflight.mjs': PREFLIGHT_READS,
  'close-out.mjs': CLOSE_OUT_READS,
  'gates-runner.mjs': GATES_RUNNER_READS,
  'queue.mjs': QUEUE_READS,
  'lane-merge.mjs': LANE_MERGE_READS,
  'head-lock.mjs': HEAD_LOCK_READS,
  'teardown.mjs': TEARDOWN_READS,
  'rebase-sync.mjs': REBASE_SYNC_READS,
  'queue-probe.mjs': QUEUE_PROBE_READS,
});

/**
 * Assert every core module's declared manifest against the REAL bound container. Called exactly
 * once, from done-worktree.mjs, immediately after its own `bindLandDeps({...})` call closes — so a
 * mis-named or missing container member throws here, naming both the member and the reading
 * module, before any land phase (`--prep`, close-out, the queue, a merge, …) has a chance to reach
 * it as a plain `undefined`. `requireDeps` (deps.mjs) already does the per-group naming; this
 * function's own job is just walking every module's every group once.
 */
export function assertContainerManifests() {
  const D = landDeps();
  for (const [moduleId, manifest] of Object.entries(CORE_MODULE_MANIFESTS)) {
    for (const [group, members] of Object.entries(manifest)) {
      requireDeps(D[group], members, moduleId);
    }
  }
}
