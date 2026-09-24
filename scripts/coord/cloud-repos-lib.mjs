// scripts/coord/cloud-repos-lib.mjs  (plan 2577; made config-driven by plan 3958)
//
// HISTORY (plan 3962 P1): two earlier attempts self-resolved coord.config.json's `cloudRepos`
// key via `loadCoordConfig(REPO_ROOT)`, with `REPO_ROOT` derived at a FIXED depth relative to
// this module's own `import.meta.url`. Both broke `scripts/test-helpers/isolated-plan-repo.mjs`'s
// temp-repo fixture (used by stamp-cloud-exec.test.mjs's `--repos hobby-main` subprocess cases),
// which copies ONLY the `scripts/` tool tree into its fixture root and — at the time — wrote no
// `coord.config.json` beside it: a copied cloud-repos-lib.mjs self-resolved to an EMPTY registry
// there, so `VALID_CLOUD_REPOS` no longer recognized `hobby-main` and those tests failed. Both
// attempts were reverted; between them and this change, the module kept its `CLOUD_REPOS` literal
// hardcoded (the project's own repo/owner/token-env-var values baked into a file the coord-kit
// scrub ships publicly), and `cloud-repos-lib.test.mjs` pinned that literal against
// coord.config.json's `cloudRepos` array field-for-field so the two copies could not drift apart
// unnoticed.
//
// RESOLUTION (plan 3958): both halves of the prior break are fixed instead of worked around.
//   1. Repo-root resolution now goes through `scripts-anchor.mjs`'s `repoRootFrom`, which anchors
//      on the `scripts/` directory NAME rather than a fixed relative depth — correct whether this
//      module runs from its real location or from a temp-repo copy (see that helper's own header;
//      `build-index-lib.mjs`'s `resolveBuildIndexCoordConfig` already established this pattern for
//      `lanes.*`/`mutationBanner`).
//   2. `isolated-plan-repo.mjs`'s `makeIsolatedRepo` grew an OPT-IN `coordConfig` option — a
//      caller that needs `cloudRepos` populated (stamp-cloud-exec.test.mjs's `--repos hobby-main`
//      subprocess cases) passes `{ coordConfig: { cloudRepos: [...] } }` with generic/synthetic
//      values (never the project's real URL/owner/token-env-var literals), and the fixture writes
//      that `coord.config.json` into its root so a copied cloud-repos-lib.mjs resolves a non-empty
//      registry there too. Every OTHER caller still gets NO coord.config.json at all — the
//      scaffold's long-standing "no config" contract (coord-config.test.mjs's plan-3960-T3 suite)
//      stays intact by construction, not by coincidence.
//   3. Missing/malformed config still degrades to an EMPTY registry (never a hardcoded fallback,
//      never a throw at import) — the correct behavior for a repo that genuinely has no
//      `cloudRepos` configured, matching `coord-config.mjs`'s own `DEFAULT_CLOUD_REPOS`.
//
// `queue-drain.mjs` — a generic scripts/coord/** core module — does NOT import this file: Rule 3
// (scripts/assert-scripts-self-contained.mjs) restricts a coord module to importing only its own
// scripts/coord/** siblings, which this file satisfies, but queue-drain.mjs threads its
// `validCloudRepoKeys` in from its own already-loaded `coord.config.json` instead (via
// `loadCoordConfig`), never from this module — see queue-drain.mjs's own import-site comment for
// why (a self-resolving read at import time is more than that particular call site needs). The
// GENERIC split/dedup/validate mechanics `parseCloudRepos` below builds on live in
// `scripts/coord/token-list-lib.mjs`, a pure zero-import leaf both modules share.
//
// The EXTRA-REPO registry: which repos other than this one a cloud drain may clone
// into its sandbox, and under which credential.
//
// Why this exists: a cloud drain sees exactly one clone (this repo). Before plan 2577, ANY plan
// whose file surface reached outside that clone — a parent umbrella-repo policy doc, a
// cross-repo coordination-sync layer, any sibling repo a plan's work genuinely touches — was
// stamped `cloudExec: false` under rubric #4, structurally rather than because the work was
// hard. That bucket is a RECURRING class in a multi-repo setup: policy/coordination text that
// lives one level up from the repo a drain actually checks out. Registering a repo here plus
// stamping the plan `cloudRepos: <key>` retires rubric #4 for that repo.
//
// Why a REGISTRY and a LIST-valued frontmatter axis rather than a boolean
// `needsExtraRepo: true` (plan 2577 decision D1): adding a sibling repo later is then one row
// here plus a credential decision, not a new frontmatter axis with a new validator, a new
// oracle read and a new prompt branch. Registering a repo here is deliberately NOT the same act
// as deciding a sibling repo is in scope for drain work at all (plan 2577 § Out of scope); this
// module only means the MECHANISM will not need reinventing when that decision comes.
//
// Why NOT a `cloudEnv` rung: `cloudEnv` is an ordered capability LADDER compared by rank
// (trusted < full < webkit < browser), where a higher lane admits every lower rung. "Needs a
// second repo cloned" is ORTHOGONAL to egress capability — a registered-repo plan can be
// perfectly runnable in a Trusted environment — so it has no place on that ladder and forcing
// it there would make the rank comparison mean two things at once.
//
// SINGLE SOURCE (decision D2): consumers of this table never mirror it —
//   - scripts/stamp-cloud-exec.mjs           validates `--repos` against it
//   - scripts/project/cloud-routine-specs.mjs   renders the clone/push instructions
// `scripts/coord/queue-drain.mjs` surfaces the SAME parsed-key shape on each oracle item, but
// (plan 3962 P1) sources its valid-key set from coord.config.json's `cloudRepos` rows
// instead of importing this module — see the header comment above. The `CLOUD_ENV_LANES`
// comment in queue-drain.mjs calls out table-mirroring as the drift risk to avoid; this
// table is never copied.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAndValidateTokenList } from './token-list-lib.mjs';
import { loadCoordConfig } from './coord-config.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';

// One row per registerable repo, shaped `{ key, url, dir, tokenEnv, note }`:
//   - `key`:      the frontmatter token (`cloudRepos: <key>`). Kebab-case; it is a stable
//                 identifier, deliberately not the bare repo name, so a repo rename does not
//                 invalidate every stamped plan.
//   - `url`:      HTTPS clone URL. Pushes are authenticated by the credential helper the drain
//                 already installs for its git host — the token is NEVER embedded here (it
//                 would leak via `git remote -v` / `git config -l`).
//   - `dir`:      clone directory name, created BESIDE the main checkout, never inside it:
//                 anything under the working tree shows up as untracked dirt and fails the
//                 done-worktree preflight.
//   - `tokenEnv`: the env var whose token grants access.
//   - `note`:     one line a human reader needs that the fields above do not carry.
// Deliberately NOT a field: how a drain pushes an edit back. It was `landsVia: 'direct-push'`
// briefly, but nothing read it — the push-back contract is prose in the prompt block and in
// docs/runbooks/cloud-drain-autonomy.md, so the field was pure decoration that a future row
// could set to something the generated prompt would then contradict (sonnet-review finding,
// plan 2577). When a repo genuinely needs a different push-back path, add the field TOGETHER
// with the consumer that branches on it.
//
// THE ROWS THEMSELVES are project data, not code: read from coord.config.json's `cloudRepos`
// array (shape/type validated by coord-config.mjs's `normalizeCloudRepos`), resolved once at
// module load against THIS repo's own root — see the header comment for why `repoRootFrom`
// (not a fixed `import.meta.url`-relative depth) is what makes that resolution work correctly
// both for a real checkout and for a module COPIED into `isolated-plan-repo.mjs`'s temp-repo
// fixture. Fail-open: a repo-root surprise or a malformed on-disk coord.config.json degrades to
// an EMPTY registry (matching `coord-config.mjs`'s own `DEFAULT_CLOUD_REPOS`) rather than
// crashing every importer — the same posture `build-index-lib.mjs`'s
// `resolveBuildIndexCoordConfig` already uses for `lanes.*`/`mutationBanner`. A config-less repo
// therefore ships with no extra-repo registry at all: every `cloudRepos:` stamp is an unknown
// key, and `parseCloudRepos` simply has nothing to validate against.
function resolveCloudRepos() {
  try {
    const repoRoot = repoRootFrom(dirname(fileURLToPath(import.meta.url)));
    const cfg = loadCoordConfig(repoRoot);
    return Array.isArray(cfg?.cloudRepos) ? cfg.cloudRepos : [];
  } catch {
    return [];
  }
}

export const CLOUD_REPOS = resolveCloudRepos();

// Order-preserving key column — the value set `--repos` and the oracle validate against.
export const VALID_CLOUD_REPOS = CLOUD_REPOS.map((r) => r.key);

export function cloudRepoByKey(key) {
  return CLOUD_REPOS.find((r) => r.key === key) ?? null;
}

// Parse a raw `cloudRepos` value — the frontmatter scalar or a `--repos` flag — into a
// normalized, deduped, order-preserving key array. Thin wrapper over the generic
// scripts/coord/token-list-lib.mjs helper, supplying THIS registry's valid-key set and error text.
//
// Accepts comma- and/or whitespace-separated keys, case-insensitively, so
// `hobby-main`, `hobby-main, foo` and `hobby-main foo` all parse. Absent/blank → `[]`.
//
// `strict` (the stamp tool) THROWS on an unknown key: a typo at stamp time must be a
// loud refusal, because the plan would otherwise sit stamped-but-unclonable and the
// drain would skip it forever with no signal. `strict: false` (the oracle) DROPS
// unknown keys instead — the oracle's job is to report, and one bad token in one plan
// body must never take the whole drain selection down. That asymmetry mirrors
// `cloudEnv`, where the stamp tool validates against VALID_CLOUD_ENV but queue-drain
// treats an unrecognized value as the ungated floor.
export function parseCloudRepos(raw, { strict = false } = {}) {
  return parseAndValidateTokenList(raw, VALID_CLOUD_REPOS, {
    strict,
    formatUnknownError: (t) =>
      `unknown cloudRepos key \`${t}\` — known keys: ${VALID_CLOUD_REPOS.join(', ')}. ` +
      'Register the repo in coord.config.json\'s "cloudRepos" array (and provision its ' +
      'credential on both drain environments) before stamping a plan against it.',
  });
}

// The canonical frontmatter serialization of a key list (comma+space).
export function formatCloudRepos(keys) {
  return keys.join(', ');
}
