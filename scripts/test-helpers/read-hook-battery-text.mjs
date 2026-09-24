// scripts/test-helpers/read-hook-battery-text.mjs — ONE shared reader for the split pre-push
// gate battery text (plan 3963 review findings cfe87c / 00e928 / 67fc85).
//
// Three test files (scripts/pre-push-hook.test.mjs, scripts/pre-push-battery-cap.test.mjs,
// scripts/pre-push-orphan-bound-coverage.test.mjs) each carried an independent copy of the
// "concatenate core + project hook text" reader. Duplication meant a future hook-layout change
// only had to update ONE copy to make the other two read a different (stale) shape than the code
// under test actually ships. Worse, every copy's `try { … } catch { … }` swallowed ANY
// `readFileSync` failure — not just a genuinely absent project file — so a permission/I-O error on
// the project hook silently degraded the read to core-only text and the calling test passed on
// that false-core-only view with the project gates entirely unchecked.
//
// This is the one place that logic lives now. It swallows ONLY `ENOENT` (the real "no
// scripts/hooks/pre-push-project.sh" case — a checkout of just the generic coordination core) and
// rethrows everything else, so a broken-but-present project file fails LOUDLY instead of quietly
// degrading the test.
//
// finding 67fc85 (round 2): the THREE CALLERS used to each derive corePath/projectPath from their
// own REPO/REPO_ROOT constant with an identical pair of `join(…, 'scripts', 'hooks', '…')` calls,
// duplicating the LAYOUT knowledge (not just the concatenation logic) in three places — a future
// hook-layout change (a rename, a move to a subdirectory) had to be applied to all three or one
// caller silently kept reading the old shape. readHookBatteryText() now takes the single repo
// root each caller already computes and derives both paths itself, so the layout is known in
// exactly one place. readHookBatteryTextFromPaths() is the underlying primitive, still exported
// for the one legitimate reason to bypass the derivation: a test that deliberately points at a
// NON-standard path (a missing file, a directory standing in for an unreadable one) to exercise
// the ENOENT-vs-everything-else distinction directly.
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Concatenate the core hook's text with the project hook's text (when present), deriving both
 * paths from a single repo root.
 *
 * @param {string} repoRoot - absolute path to the repo root (the directory containing scripts/).
 * @returns {string} `${core}\n${project}` — `project` is `''` when the file is genuinely absent.
 */
export function readHookBatteryText(repoRoot) {
  const corePath = join(repoRoot, 'scripts', 'hooks', 'pre-push-core.sh');
  const projectPath = join(repoRoot, 'scripts', 'hooks', 'pre-push-project.sh');
  return readHookBatteryTextFromPaths(corePath, projectPath);
}

/**
 * Concatenate the core hook's text with the project hook's text (when present), given explicit
 * paths. Exported for tests that need to point at a non-standard path (missing / unreadable) to
 * exercise the ENOENT-vs-everything-else distinction directly; every ordinary caller should use
 * readHookBatteryText(repoRoot) instead so the repo layout is derived in one place.
 *
 * @param {string} corePath - absolute path to scripts/hooks/pre-push-core.sh (always present).
 * @param {string} projectPath - absolute path to scripts/hooks/pre-push-project.sh (present only
 *   in a checkout that ships vetapp-specific gates).
 * @returns {string} `${core}\n${project}` — `project` is `''` when the file is genuinely absent.
 */
export function readHookBatteryTextFromPaths(corePath, projectPath) {
  const core = readFileSync(corePath, 'utf8');
  let project = '';
  try {
    project = readFileSync(projectPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // finding eee20a: an ENOENT from readFileSync also fires for a DANGLING SYMLINK (the entry
    // itself exists — `lstatSync` sees it — but its target does not), which is a broken-but-
    // PRESENT project file, not a genuinely absent one. Rethrow that case too instead of
    // silently degrading to core-only text: a broken symlink at this path means something is
    // wrong with the checkout, not that this is a generic-core repo.
    // Round 3 (findings 89d616 / 06ae60 / 48d5ab / bb34f2): `throwIfNoEntry: false` returns
    // undefined ONLY for a genuinely absent entry; any other lstat failure (EACCES, ENOTDIR, …)
    // throws through, so the read never fails open into core-only text on an I/O error.
    if (lstatSync(projectPath, { throwIfNoEntry: false })) throw err;
    // No project file at all (a generic-core checkout) — degrade to core-only text.
  }
  return `${core}\n${project}`;
}
