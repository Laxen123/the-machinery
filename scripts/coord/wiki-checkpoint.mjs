// scripts/coord/wiki-checkpoint.mjs — "did this land's diff touch a subject the WIKI owns?"
// (plan 4096 T2; the predicate is plan 1074's, moved here from scripts/project/land-seams.mjs
// with its pattern list turned into configuration).
//
// WHY IT LIVES IN CORE. The PREDICATE is generic — "did any changed path match a configured
// subject pattern, or did the caller flag one of the two explicit signals". The pattern LIST is
// project data (vetapp's five are backend adapters, the price pipeline, the inspector scripts and
// two shared pricing modules), so it moved to `coord.config.json -> wikiSubjectPatterns[]`, the
// same shape plan 3960 gave `deployServices[]` and plan 4071 gave the rest of the vetapp literals
// inside `scripts/coord/**`. Before this split, `record-review.mjs` — a coord-kit command — could
// only reach this predicate by importing `scripts/project/land-seams.mjs`, and that one edge
// dragged the whole project land-gate closure in behind it.
//
// `scripts/project/land-seams.mjs` re-exports `wikiCheckpointNeeded` from here, so
// `wikiCheckpointSeam` and every existing importer are unchanged.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCoordConfig } from './coord-config.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';

// REPO_ROOT for the load below, ANCHORED on the `scripts/` directory name rather than on a fixed
// depth (plan 3962's scripts-anchor seam). Not `process.cwd()`, which is wherever the calling
// command happened to be invoked from; and not a hand-counted `../../`, which is right at exactly
// one depth and silently starts reading `scripts/coord.config.json` the moment this file moves — (dangling-ok: names the wrong path the bug would read)
// a fail-open narrowing, not a throw, which is the failure shape scripts-anchor.mjs exists for.
const REPO_ROOT = repoRootFrom(dirname(fileURLToPath(import.meta.url)));

/**
 * The compiled subject patterns, resolved LAZILY on first use and memoized.
 *
 * Two constraints meet here, and both gpt-review rounds named one of them:
 *
 *  - It must FAIL CLOSED (round 1, angle-B). An earlier draft caught the loader's throw and fell
 *    back to `[]`, copying `scripts/project/deploy.mjs` — but deploy.mjs pairs that fallback with
 *    `DEPLOY_CONFIG_LOAD_ERROR`, which its entry point re-reads and REFUSES on, and there is no
 *    equivalent re-check here. An empty list silently switches OFF the path axis of the
 *    WIKI_CHECKPOINT land gate, so a malformed coord.config.json would let a land touching the
 *    price pipeline, an adapter, an inspector or a pricing-concept module through with no wiki
 *    decision recorded — the one thing this gate exists to prevent, failing open and saying
 *    nothing. So the throw propagates, as it already does for every other malformed config key.
 *
 *  - It must not be an IMPORT-TIME precondition (round 2, angle-C). Reading the config at module
 *    scope made a malformed `coord.config.json` — an invalid `handoffLayout`, say, nothing to do
 *    with the wiki — kill `record-review.mjs` at import, because that command statically imports
 *    this module for one predicate. Importing a module must not be able to fail for a reason the
 *    importer never asked about.
 *
 * Lazy resolution satisfies both: nothing is read until someone actually ASKS the wiki question,
 * and when they do, a broken config throws in their face instead of quietly answering "no".
 * Memoized, so the predicate stays effectively pure per call after the first — the same
 * once-per-process cost the module-scope literal used to have.
 */
let cachedPatterns = null;

/**
 * `repoRoot` is a PARAMETER with a default so the two properties above are testable at all: a
 * test points it at a temp root carrying a deliberately malformed config and asserts the THROW,
 * without having to relocate this module or fake `import.meta.url`. Only the default-root answer
 * is memoized — an explicit root always re-reads, so one test's fixture can never poison another's
 * or the real process's answer.
 */
export function wikiSubjectPatterns(repoRoot = REPO_ROOT) {
  if (repoRoot !== REPO_ROOT) {
    return Object.freeze(
      loadCoordConfig(repoRoot).wikiSubjectPatterns.map((src) => new RegExp(src)),
    );
  }
  if (cachedPatterns === null) {
    cachedPatterns = Object.freeze(
      loadCoordConfig(repoRoot).wikiSubjectPatterns.map((src) => new RegExp(src)),
    );
  }
  return cachedPatterns;
}

/**
 * Pure: does this land's diff touch a subject the wiki OWNS (subject synthesis: how a
 * platform/inspector/pricing-concept WORKS) — as DISTINCT from plain per-record seed DATA edits,
 * which the seed, not the wiki, is the record for.
 *
 * Kept deliberately NARROW by whoever configures `wikiSubjectPatterns`: a checkpoint that fired
 * on every backend diff would normalise SKIP and decay into the toothless advisory plan 1074
 * warns about. Plain data-row edits do NOT trip it; the seed `chains[]` registry (a chain that
 * has a wiki page) DOES, via the `chainsChanged` signal the spine computes from the seed diff.
 *
 * `patterns` is a PARAMETER with a default (the same lazy, memoized `wikiSubjectPatterns()` read
 * every real caller already gets) so a test can pin a synthetic pattern list and assert the
 * match/no-match logic itself — portably, without depending on whatever this checkout's own
 * coord.config.json happens to configure (plan 3958: the public coord-kit's own config carries
 * no wikiSubjectPatterns at all, so the self-resolved default degrades to "never checkpoints").
 */
export function wikiCheckpointNeeded(
  changedFiles,
  chainsChanged = false,
  // Positional (a project caller, e.g. land-seams.mjs, keeps its own name for this argument —
  // renaming it here is call-site-compatible by construction).
  subjectPageChanged = false,
  patterns = wikiSubjectPatterns(),
) {
  if (chainsChanged) return true;
  if (subjectPageChanged) return true;
  return (changedFiles || []).some((f) => patterns.some((re) => re.test(f)));
}
