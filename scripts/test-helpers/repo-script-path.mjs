// scripts/test-helpers/repo-script-path.mjs — resolve a REAL-tree script by basename, across
// both layers of the scripts/ tree (plan 3962 Phase 2).
//
// Many tests read a sibling module's SOURCE to assert something about it — that it imports a
// shared helper rather than re-inlining a check, that a hook declares a pid, that a count is not
// restated. Those tests spelled the sibling as `join(<own dir>, '<name>.mjs')`, which was exact
// while `scripts/` was flat. coord-core step 4 moved 93 modules into `scripts/coord/`, and moved
// their paired tests with them — so a moved test now looks for an unmoved sibling one directory
// too deep, and an unmoved test looks for a moved one one directory too shallow. Both fail with
// ENOENT rather than a wrong answer, which is the good direction, but they still fail.
//
// A test asking for a module by BASENAME means "the module", not "the module at the layer it
// happened to sit on the day this test was written". This resolves that intent, and keeps doing
// so as later steps of the program move more modules. Mirrors `toolPath` in
// `test-helpers/isolated-plan-repo.mjs`, which does the same job inside a COPIED tree.
//
// TEST-ONLY, and it lives under test-helpers/ for that reason: `scripts/test-helpers/` is never
// copied into the isolated-repo fixture, so nothing that ships can import it (Rule 3 enforces
// exactly that).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findScriptsDir } from '../coord/scripts-anchor.mjs';

/**
 * Absolute path of `rel` (a path relative to `scripts/`, e.g. `coord-git.mjs` or
 * `hooks/pre-push.sh`) in the real tree containing `startDir`, looking at `scripts/` first and
 * `scripts/coord/` second.
 *
 * Falls back to the flat `scripts/<rel>` when neither exists, so a genuinely missing file still
 * fails with the path a reader expects rather than the nested one.
 */
export function scriptFile(rel, startDir) {
  const scriptsDir = findScriptsDir(startDir);
  if (!scriptsDir) throw new Error(`repo-script-path: no scripts/ ancestor of ${startDir}`);
  // coord/ FIRST: a command this program moved leaves a three-line path-compat SHIM at the flat
  // path, and a test that reads a module's SOURCE means the real module, never the shim.
  const nested = join(scriptsDir, 'coord', rel);
  if (existsSync(nested)) return nested;
  return join(scriptsDir, rel);
}
