// scripts/coord/scripts-anchor.mjs — resolve repo-relative paths by ANCHORING on the `scripts/`
// directory name, never on a depth fixed relative to the calling module's own location
// (plan 3962 Phase 2).
//
// WHY THIS EXISTS. Most of the modules `coord-core` step 4 moves from `scripts/` to
// `scripts/coord/` compute the repo root as `join(dirname(fileURLToPath(import.meta.url)), '..')`
// — correct at exactly one depth. The move adds a level, so every one of those walks would land
// on `scripts/` instead of the repo root and start reading `scripts/docs/INDEX.md`,
// `scripts/coord.config.json`, `scripts/docs/superpowers/plans/` … none of which exist. Nothing
// throws: the readers fail open or glob nothing, so the failure is a SILENT narrowing, which is
// the shape plan 3962's Phase 1 already hit twice through the config seam (§ E16).
//
// WHY THE ANCHOR IS THE DIRECTORY NAME and not a repo-root marker file (`coord.config.json`,
// `.git`) or an existsSync probe for the target: `scripts/test-helpers/isolated-plan-repo.mjs`'s
// temp-repo fixture copies ONLY the `scripts/` tool tree into `<tmp>/scripts/`. That directory
// really is named `scripts`, so a name-anchored walk lands where the fixture put it — but there
// is no `coord.config.json` and no `.git` there, so a marker walk finds nothing and falls back
// wrong, and a probe for a file not yet written degrades the same way. The name has neither blind
// spot and needs no filesystem access at all.
//
// RULE 3 (`scripts/assert-scripts-self-contained.mjs`): zero-import leaf apart from node:path, so
// it is importable from anywhere under `scripts/coord/**` — and, because the rule is one-way, from
// a module still sitting at `scripts/` that is on its way in.
import { basename, dirname, join } from 'node:path';

// Twelve is far past any real nesting under `scripts/` (the deepest today is
// `scripts/coord/land/`, two levels) and bounds the walk on a path that has no `scripts` ancestor
// at all, e.g. a module loaded from a temp dir by a test.
const MAX_WALK = 12;

/**
 * The nearest ancestor of `startDir` (inclusive) whose basename is `scripts`, or `null` when
 * there is none within `MAX_WALK` levels.
 */
export function findScriptsDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < MAX_WALK; i += 1) {
    if (basename(dir) === 'scripts') return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The repo root containing `startDir`'s `scripts/` directory.
 *
 * Fallback when no ancestor is named `scripts`: `dirname(startDir)` — the pre-3962 assumption
 * (the caller sits one level under the root). Deliberately a fallback rather than a throw: these
 * are module-scope constants, and a throw here would crash every importer at static import time
 * for a path that most callers then only use to read an optional file.
 */
export function repoRootFrom(startDir) {
  const scriptsDir = findScriptsDir(startDir);
  return scriptsDir ? dirname(scriptsDir) : dirname(startDir);
}

/**
 * The path of `name` inside `startDir`'s `scripts/` directory — for a sibling command that is
 * spawned by path, or a data file that lives beside the tools rather than under `docs/`.
 *
 * Fallback when no ancestor is named `scripts`: `join(startDir, name)`, the pre-3962 assumption
 * (the file sits alongside the caller).
 */
export function scriptsFileFrom(name, startDir) {
  const scriptsDir = findScriptsDir(startDir);
  return join(scriptsDir ?? startDir, name);
}
