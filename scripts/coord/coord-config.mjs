// scripts/coord/coord-config.mjs — load a repo's coord.config.json (its coordination profile).
// Pure normalizeConfig (unit-testable) + IO loadCoordConfig (reads <repoRoot>/coord.config.json).
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { git } from './coord-git.mjs';
// plan 3961 T1: the extension-point roster lives with the registry that defines it, so this
// validator never carries a second copy of the five names that could drift from it. Importing
// INTO scripts/coord/ is fine — Rule 3 binds what a coord module may import, not who may import
// one (done-worktree-lib.mjs already imports scripts/coord/review-markers.mjs the same way).
import { EXTENSION_POINTS, isExtensionPoint } from './land/registry.mjs';

// Project-AGNOSTIC defaults: a config-less repo has NO seed lane (every plan
// merges freely, no LANDING mutex), a single handoff.md (no sessions/ split),
// and the legacy root-scattered handoff layout (handoffDir=null).
// A project opts INTO vetapp-style coordination via its own coord.config.json.
// seedShardDir (plan 1300): the sharded seed layout's root (vetapp:
// "backend/src/data/seed") — a diff touching it is a 🟥 seed land, and its
// per-clinic shard paths carry the lock's narrowing SCOPE. null = no shard
// layout (pre-flip repos + siblings): the monolith seedLaneFile alone decides.
// derivedShardDirs / derivedGlobalFiles (plan 1867): clinic-sharded DERIVED-DATA
// roots (vetapp: render-fingerprints + render-store) whose per-clinic paths join
// the landing-lock scope exactly like seed shards, and shared append-only data
// files (the observations *.jsonl) that are global-on-touch. Empty = plan-1300
// behavior (derived data invisible to the mutex) — siblings without a price
// pipeline never set these.
// ── plan 3960 (coord-core step 2): the vetapp constants the core still hardcoded ─────────────
// Six more keys. Five default to TODAY's vetapp value so a checkout whose coord.config.json
// sets none of them behaves byte-identically to before this plan; `deployServices` is the
// exception (R1) — it defaults to EMPTY, and vetapp's own eight rows now live in vetapp's own
// coord.config.json instead of in this project-agnostic module. Every default lives HERE; every
// validation lives in normalizeConfig below; nothing in this block — or in normalizeConfig's
// handling of it — reads process.env.
// CLOSED by plan 4071: the two vetapp-shaped core defaults this block left behind —
// `DEFAULT_SHARD_ID_PATTERN` (was the literal `clinics/[A-Z]{2}/...` pattern) and
// `DEFAULT_MUTATION_BANNER` (was `SEED-WRITE`/`--seed-write`) — are now project-neutral (`null`,
// and the generic `DATA-WRITE`/`--data-write` pair); vetapp's own values live as explicit rows in
// vetapp's `coord.config.json` (shardIdPattern already did; mutationBanner already had a row too).

// deployServices[] — operator ruling R1 (plan 3960 grill, 2026-09-13): a config-less repo gets
// an EMPTY deploy table. The generic core carries no knowledge of any project's production
// deploy graph, and in particular no import of railway-domains.mjs (the VetNära Railway
// registry) — a public copy must not inherit vetapp's production deploy targets. vetapp's own
// eight rows (plans 3082/3222/3215/3399/3635) now live in THIS repo's coord.config.json (byte-
// identical to the pre-3960 PROD_DEPLOY_SERVICES literal), read back through normalizeConfig's
// deployServices validation below exactly like any other project's override would be.
const DEFAULT_DEPLOY_SERVICES = Object.freeze([]);

// shardIdPattern — the per-clinic shard filename pattern, relative to the seed shard root
// (plan 1300), with exactly ONE capture group (the clinic id). done-worktree-lib.mjs derives
// SHARD_REL_SRC / ORDER_MANIFEST_REL_SRC / DERIVED_SHARD_REL_SRC from this string at module
// load (same anchors as before); see that module's own comments.
// plan 4071: CORE default is now `null` ("no sharded records"), following seedShardDir's own
// null-means-none contract — a config-less repo has no per-clinic shard filename shape to derive
// anything from. A consumer that dereferences a null shardIdPattern without checking for it first
// is a wave-2/3 wiring bug, not this seam's — see the plan-4071 hand-off note.
const DEFAULT_SHARD_ID_PATTERN = null;

// scopeMaxKeys — SCOPE_MAX_CLINICS (plan 1867): past this many ids in one land's scope set the
// landing-lock mutex collapses the scope to {global:true} instead of carrying it as data.
const DEFAULT_SCOPE_MAX_KEYS = 500;

// operatorSpendCeilingUsd — the operator's own per-plan drain spend ceiling (plan 4069 task 5
// R1/R2/R3; plan 4069 review round 2, key 6a70ae/853db6/066a1a). drain-run.mjs used to hand-parse
// `coord.config.json` for this key with its own `fs`/`JSON.parse` read instead of going through
// this loader — a second config parser that could drift from the normalized contract. It is a
// human-authored safety knob, not a structural correctness field, so — unlike scopeMaxKeys —
// an invalid value here is tolerated rather than a hard config-authoring error: normalization
// below silently falls back instead of throwing, exactly matching the ad-hoc read it replaces.
const DEFAULT_OPERATOR_SPEND_CEILING_USD = 5;

// mutationBanner.label — the plan-body banner text (🟥/🟩 **<label>:**) build-index-lib.mjs's
// SEED_BANNER_ANCHOR_RX anchors on, and every other banner reader looks for. mutationBanner.flag
// (plan 3961 T3.1a) — the done-worktree carry-forward minter's `next-plan-id.mjs claim` CLI flag
// naming the same concept, carried the same way.
// plan 4071: CORE default is now the neutral `DATA-WRITE` / `--data-write` pair — the concept
// (does this plan mutate the data store?) is generic and every plan body needs a label, but the
// word "SEED" was vetapp's own vocabulary. vetapp's `coord.config.json` already carries an
// explicit `mutationBanner` row (`SEED-WRITE` / `--seed-write`), so vetapp behaviour is unchanged.
const DEFAULT_MUTATION_BANNER = Object.freeze({ label: 'DATA-WRITE', flag: '--data-write' });

// lanes.* — today's plan-status folder names, keyed by a stable short name, plus `order` (the
// canonical STATUS_ORDER render order) and the two frozen/archival folders that are always
// appended AFTER the active ones (archive, then parked — never reordered, never in `order`
// itself). build-index-lib.mjs is the ONE reader of this key; every other module imports its
// derived STATUS_ORDER / ALL_PLAN_FOLDERS / PLAN_FOLDER_ALT / per-lane constants from there
// instead of repeating a lane-name literal.
const DEFAULT_LANES = Object.freeze({
  inProgress: 'in-progress',
  ready: 'ready',
  pendingApproval: 'pending-approval',
  waitingBlocked: 'waiting-blocked',
  waitingOperator: 'waiting-operator',
  waitingGrill: 'waiting-grill',
  waitingDate: 'waiting-date',
  waitingTrip: 'waiting-trip',
  archive: 'archive',
  parked: 'parked',
  order: Object.freeze([
    'inProgress',
    'ready',
    'pendingApproval',
    'waitingBlocked',
    'waitingOperator',
    'waitingGrill',
    'waitingDate',
    'waitingTrip',
  ]),
});

// land.localTimeoutSeconds — THE one local-land timeout number (plan 3452; operator ruling
// 2026-08-24: "I don't want random choices for the timeout"). land.worldClaimFields[] — the
// CONCLUSION_REVIEW landSeam's guarded field list (plan 3961 T2.6/D2): the seam's MECHANISM (an
// established world-claim may not be overwritten without a fresh adversarial-review verdict) is
// generic over sharded record files, but WHICH fields count as a world claim is project
// vocabulary. Default EMPTY — same posture as deployServices (R1) and plugins (T1): an empty list
// makes the seam a permanent no-op (findWorldClaimFlips pushes no flip, and the deletion branch's
// `.some()` is false), so a config-less repo gets no conclusion-review gate at all rather than
// inheriting vetapp's five fields.
//
// land.gateRoster IS GONE (plan 3961 T2.7a). The once-per-land gate roster used to be restated
// here as a literal list, three of whose five names were vetapp gate names — exactly the kind of
// project noun this config seam exists to stop a generic core from defaulting. It is now DERIVED
// from the land-gates registry: exactly the registered prepGates whose stage is 'preflight', in
// registry order (`landGateRosterFromRegistry`, done-worktree.mjs). See normalizeLand below for
// the refusal that keeps a stale `land.gateRoster` key from silently doing nothing.
//
// land.coordinationOnlyPathPrefixes[] (plan 3961 T2.7b): the plan-3972 `masterDeltaIsCoordinationOnly`
// skip's path-prefix allowlist. The CORE default is the four generic coordination roots every
// repo using this spine's plan/handoff machinery shares; `wiki/log.md` is NOT one of them — a
// wiki vault is project content this generic core has no opinion about, so a config-less repo's
// list omits it (same empty/absent-by-default posture as worldClaimFields/deployServices/
// plugins). vetapp's own coord.config.json ADDS `wiki/log.md` back (the append-only wiki-page
// ledger line really does ride along with pure coordination bookkeeping there).
//
// land.worktreeMemoryReclaimScript (plan 3961 T2.7b): the teardown step-2 pwsh script path that
// reclaims a torn-down worktree's cwd-keyed Claude auto-memory. CORE default `null` — a
// config-less repo has no such script and the step is skipped outright (no DRY trace line, no
// best-effort run). A string value must be an absolute path or a `~/`-prefixed path (T2 review
// key 3dc8da: a relative path resolves against whatever directory happens to be the process cwd
// at teardown time, an implicit target normalizeLand refuses); the spine (never this validator)
// expands a leading `~/` against `USERPROFILE || HOME`.
//
// land.specReviewGatedFields[] (plan 4071 D3): claim-plan-lib.mjs's GATE1_PIPELINE_FIELDS — a
// SIBLING key to worldClaimFields, NOT a fold into it. worldClaimFields guards an established
// value being OVERWRITTEN at LAND time (the CONCLUSION_REVIEW seam); specReviewGatedFields guards
// a FLIP at PUSH/CLAIM time requiring a heavy-model specReview (plan 1427 Gate 1/2) — a plan
// touching one of these fields in a 🟥 seed-write body cannot self-stamp `exempt-mechanical`.
// Folding the two would widen Gate 1 to every worldClaimFields entry, a behaviour change, not
// byte-identity. CORE default EMPTY, same posture as worldClaimFields: a config-less repo's Gate
// 1/2 pipeline-field check is a permanent no-op.
//
// land.buildCommand (plan 3961 review fix round): the `build` preflight gate (registered
// unconditionally in gates-core.mjs — every project gets the GATE, not every project has a
// build) used to spell `pnpm --filter @vetapp/frontend build` directly in the generic core
// (scripts/coord/land/gates-runner.mjs) — exactly the project-noun coupling this whole plan
// exists to remove. CORE default `null` — a config-less repo has no build step and the gate
// no-ops to a real green rather than failing or being silently absent. A non-null value is
// `{ command, args }`, mirroring execFileSync's own (file, args) split, so the WHOLE invocation
// is expressible — not just a package name — for a project that doesn't build with pnpm at all.
const DEFAULT_LAND = Object.freeze({
  localTimeoutSeconds: 14400,
  worldClaimFields: Object.freeze([]),
  specReviewGatedFields: Object.freeze([]),
  coordinationOnlyPathPrefixes: Object.freeze([
    'docs/handoff/',
    'docs/superpowers/plans/',
    'docs/superpowers/batches/',
    '.drain-status/',
    'docs/INDEX.md',
  ]),
  worktreeMemoryReclaimScript: null,
  buildCommand: null,
  // typecheckCommands[] (scripts/hooks/pre-push-core.sh's typecheck gates, plan 4096 T5): the
  // per-project compile gates the push battery runs, as DATA. Default EMPTY: a config-less repo
  // has no workspace the core could name, so the gate prints one line saying no typecheck is
  // configured and passes — the same empty-core-default posture deployServices[] (plan 3960 R1)
  // and the plan-4071 keys above already carry. Row shape + the word-splitting contract the
  // `command` string must satisfy: scripts/coord/land-typecheck-rows.mjs's header.
  typecheckCommands: Object.freeze([]),
});

// plugins.* — plan 3961 T1: which modules contribute entries to each land extension point,
// as repo-relative module paths (`{"prepGates": ["scripts/project/land-gates.mjs"]}`). Each
// named module default-exports an ARRAY of registry entries; scripts/coord/land/registry.mjs
// owns the entry shape and the five point names.
//
// The default is EMPTY, and that is the whole contract for a config-less repo: it registers no
// project gates, no project seams, no project post-merge or close-out steps, and still lands on
// the core defaults alone. Same posture as deployServices (plan 3960 R1) and for the same reason
// — the generic core must not inherit any project's steps by default.
//
// This key holds PATHS only. Actually importing them lives in scripts/land-plugins.mjs
// (loadLandPlugins), NOT here, for two reasons: `await import()` is async and cannot happen
// inside the sync normalizeConfig, and — the load-bearing one — a dynamic import with a computed
// specifier makes select-battery-tests.mjs's closure analysis unresolvable, which would widen the
// battery pass-cache to the full tree for every module that imports this one. That is nearly the
// whole tree. See land-plugins.mjs's own header; scripts/battery-pass-cache.test.mjs is what
// catches a regression of it.
const DEFAULT_PLUGINS = Object.freeze({});

// jobOutputPrefixes[] (plan 3962 P1): repo-relative path prefixes (each ending in "/") that name
// a live JOB's output tree — data a background pipeline writes, never loose session work. Read by
// scripts/coord/main-checkout-allowlist.mjs's isJobOutput/jobOutputRxFor/jobOutputStashExcludesFor,
// which stay a pure, zero-import leaf module (Rule 3: scripts/coord/** carries no project
// knowledge, and this leaf must not import coord-config.mjs either) — the CALLER resolves this
// list and passes it in. Default EMPTY, same posture as derivedShardDirs/deployServices: a
// config-less repo has no job-output tree to protect from the pre-yield-guard park/stash.
// vetapp's row reproduces its former hardcoded literal exactly: ["backend/data/price-pipeline/"].
//
// externalTreePrefixes[] (plan 3962 P1): project-specific ADDITIONS to
// scripts/select-battery-tests.mjs's EXTERNAL_TREE_PREFIXES bail-out list (real-tree paths a
// battery test reads directly, which the import-closure selector cannot scope). The module's own
// generic default (wiki/, .husky/, node_modules/, …) always applies; this key adds project-only
// entries on top — vetapp's is `backend/` (the price-pipeline stores + backend test fixtures no
// scripts/*.mjs file imports). Default EMPTY: a config-less repo widens nothing.
// dataDependencyMap (plan 3962 P1): project ADDITIONS to
// scripts/select-battery-tests.mjs's own DATA_DEPENDENCY_MAP (test-basename -> glob[] rows for
// battery tests whose true inputs are DATA the import-closure selector cannot see at all — see
// that module's own header). Default EMPTY object: a config-less repo's battery selection widens
// on no project-specific data class. vetapp's row is the former 'wiki-loader-coverage.test.mjs'
// entry, reproduced exactly.
export const DEFAULT_JOB_OUTPUT_PREFIXES = Object.freeze([]);
export const DEFAULT_EXTERNAL_TREE_PREFIXES = Object.freeze([]);
export const DEFAULT_DATA_DEPENDENCY_MAP = Object.freeze({});

// gitPatEnvVar / codexAuthEnvVar (plan 3958): the env var NAMES two coord tools read a secret
// from — a cloud drain's github push PAT (ensure-coord-reroute.mjs, spec-sweep-lock.mjs,
// drain-status.mjs, queue-drain.mjs) and a cloud env's codex/ChatGPT login blob (gpt-review.mjs's
// codex self-bootstrap). Neither value is a secret itself — it is the NAME of the env var that
// carries one — but the name is project vocabulary the public kit must not hardcode. Generic
// defaults below are plain, unclaimed names; a project sets its own in coord.config.json.
export const DEFAULT_GIT_PAT_ENV_VAR = 'GIT_PUSH_TOKEN';
export const DEFAULT_CODEX_AUTH_ENV_VAR = 'CODEX_LOGIN_B64';

// cloudRepos[] (plan 3962 P1; consumed directly by scripts/coord/cloud-repos-lib.mjs since plan
// 3958): the EXTRA-repo registry (which repos besides this one a cloud drain may clone, and
// under which credential) — see cloud-repos-lib.mjs's own header for the full row shape
// (`key`/`url`/`dir`/`tokenEnv`/`note`) and how it self-resolves this key at module load.
// Default EMPTY: a config-less repo's cloud drains clone nothing extra. vetapp's row reproduces
// its pre-3958 hardcoded `CLOUD_REPOS` literal exactly (the `hobby-main` row).
export const DEFAULT_CLOUD_REPOS = Object.freeze([]);

// wikiSubjectPatterns[] (plan 4096 T2): the repo-relative path patterns whose diff means "this
// land touched a subject the WIKI owns", as REGEX SOURCE strings (anchored and escaped by the
// author — they are compiled with `new RegExp(src)` and matched against a repo-relative path).
// Read by scripts/coord/wiki-checkpoint.mjs's `wikiCheckpointNeeded`, which
// scripts/project/land-seams.mjs re-exports and `record-review.mjs` imports directly.
//
// Default EMPTY, same posture as deployServices (plan 3960 R1) / the plan-4071 block below: a
// config-less repo's wiki checkpoint never fires on the PATH axis, while the two explicit
// signals (`chainsChanged`, `clinicPageChanged`) still do — so a project that wires those keeps
// a working checkpoint with no patterns configured. vetapp's five rows reproduce the former
// module-private `WIKI_SUBJECT_PATTERNS` literal in land-seams.mjs exactly.
//
// WHY THIS IS DATA. The predicate is generic ("did any changed path match a subject pattern");
// the pattern LIST is five vetapp paths — backend adapters, the price pipeline, the inspector
// scripts, two shared pricing modules. Leaving the list inside a project module forced
// `record-review` (a kit command) to import `scripts/project/land-seams.mjs`, which is the edge
// that blocked it at the coord-kit closure gate.
export const DEFAULT_WIKI_SUBJECT_PATTERNS = Object.freeze([]);

// ── plan 4071 (coord-core step 5): the vetapp literals INSIDE scripts/coord/** ────────────────
// Plan 3962 moved 92 generic modules under scripts/coord/** and proved (Rule 3) that none of
// them IMPORTS project-specific code — but Rule 3 is blind to a vetapp string literal sitting
// INSIDE a core module's own executable code. This block is where those literals land: one
// repeated shape (empty core default, vetapp row in coord.config.json, byte-identity test), the
// same posture operator ruling R1 (plan 3960) set for deployServices/worldClaimFields/
// derivedShardDirs/plugins. Every key below is a LEAF value only — no consumer is wired to read
// any of them yet (that is wave 2/3's job); a `{}`/`[]`/`null` default here must never be assumed
// non-empty by a module that imports it.

// coordCheckoutExcludedTopLevel[] / planWorktreeExcludedPaths[] (coord-git.mjs
// COORD_CHECKOUT_EXCLUDED_TOP_LEVEL / PLAN_WORKTREE_EXCLUDED_PATHS): the sparse-checkout cones
// for the shared coord checkout (top-level dirs never materialised) and a plan worktree (heavy
// price-pipeline data stores never materialised). Default EMPTY: a config-less repo's coord
// checkout and plan worktrees are cut DENSE — no cone to apply.
// reviewDiffExcludes[] (review-diff-scope.mjs REVIEW_DIFF_EXCLUDES): project ADDITIONS to that
// module's own generic exclude list (`output`, `pnpm-lock.yaml` stay in the module — they apply
// to any project). Default EMPTY: a config-less repo's review diff widens on no project-specific
// data-artifact path.
// batteryScopedPrefixes[] (battery-pass-cache.mjs SCOPED_PREFIXES): project ADDITIONS to that
// module's own generic `wiki/` scoped-prefix (which always applies). Default EMPTY: a
// config-less repo's battery cache key is unscoped by no project-specific real-tree prefix.
// localHostDenylist[] (cloud-checkout-preflight.mjs LOCAL_HOST_DENYLIST, plan 4071 D4): known
// OPERATOR machine hostnames — a belt-on-top-of-env-var-guard backstop against running a
// destructive cloud-checkout-preflight recovery on a real local machine. Default EMPTY: a
// config-less repo names no operator machine (the env-var guard it backstops still applies).
// Hostnames are case-insensitive, so entries are UPPERCASED here regardless of how the operator
// spelled them in coord.config.json (plan 4071 review round 1) — every consumer that compares a
// host against this list (originLabel in landing-queue-board.mjs, and cloud-checkout-preflight.mjs's
// own separately-parsed copy below) already uppercases the HOST side; a config entry that was not
// also uppercased silently never matched, which would have skipped the local-machine refusal.
export const DEFAULT_COORD_CHECKOUT_EXCLUDED_TOP_LEVEL = Object.freeze([]);
export const DEFAULT_PLAN_WORKTREE_EXCLUDED_PATHS = Object.freeze([]);
export const DEFAULT_REVIEW_DIFF_EXCLUDES = Object.freeze([]);
export const DEFAULT_BATTERY_SCOPED_PREFIXES = Object.freeze([]);
export const DEFAULT_LOCAL_HOST_DENYLIST = Object.freeze([]);

// planCategories.allowlist[] / planCategories.evidenceGated[] (build-index-lib.mjs
// PLAN_CATEGORY_ALLOWLIST / EVIDENCE_GATED_CATEGORIES, plan 4071 D1/T2): the plan-minting
// category gate. `allowlist` core default `[]` is read as "no category gate" (allow ALL), not
// "reject everything" (D1 — plan 4071 execution notes): the allowlist is a REJECTING gate, so the
// safe degrade direction for a config-less repo is not-restricting — an empty allowlist letting a
// fresh checkout mint no plan at all would be dead on arrival. `evidenceGated` core default `[]`:
// a config-less repo gates no category behind a heavy-model specReview evidence marker.
const DEFAULT_PLAN_CATEGORIES = Object.freeze({
  allowlist: Object.freeze([]),
  evidenceGated: Object.freeze([]),
});

// planNaming.countryTokenHints[] / planNaming.stageTokens (move-plan.mjs COUNTRY_TOKEN_HINTS +
// PIPE_STAGE_TOKENS + the `Pipe` category literal that selects them, plan 4071 T2): both are
// ADVISORY plan-rename/mint lints, grouped under one key per the plan body's instruction rather
// than two top-level ones. `countryTokenHints` is an array of `{ token, code }` rows (JSON has no
// Map literal) rather than the source Map directly — a wave-2 consumer rebuilds the Map from this
// array. `stageTokens.category` names WHICH category the stage-token lint applies to (`null` =
// the lint never fires); `stageTokens.tokens` is the vocabulary a matching plan's first slug token
// is checked against. Default EMPTY / null: a config-less repo lints no country-token hint and no
// category's slug against a stage-token vocabulary.
const DEFAULT_PLAN_NAMING = Object.freeze({
  countryTokenHints: Object.freeze([]),
  stageTokens: Object.freeze({ category: null, tokens: Object.freeze([]) }),
});

// pytestSelector.{prefix,script} (battery-ledger.mjs PYTEST_SELECTOR_PREFIX + the
// `backend/scripts/_select_tests.py` spawn path inside runPytestSelector, plan 4071 E-A): the
// land-tier pytest selector script and the one path prefix it maps. Default BOTH null: a
// config-less repo has no pytest selector script, and runPytestSelector's own contract already
// degrades a missing/failing script to `null` ("run everything") — the safe direction — rather
// than throwing on an absent path.
const DEFAULT_PYTEST_SELECTOR = Object.freeze({ prefix: null, script: null });

// gates{} (gate-pass-cache.mjs's whole GATES registry, plan 4071 T4/D5 — the big one): every
// pre-push gate's `desc` (the human-readable command), `paths` (its content-cache-key closure),
// and optionally `envUncacheable` (gitignored env paths that force the gate uncacheable) / `probe`
// (a NAME — JSON cannot carry a function — naming a core-provided probe, e.g.
// `"mobile-required"`) / `probeScript` (the probe's own watched-diff script path). Default EMPTY
// `{}`: a config-less repo caches NO gate — every consumer must degrade to "not cacheable" for an
// absent name, never crash or assume a gate name exists (T4's own import-time-crash hazard, E-B).
// Shape/type validation only here — whether a `probe` name corresponds to an actual core-provided
// probe function, and whether `probeScript` exists on disk, are wave-3's business (D5), not this
// seam's.
const DEFAULT_GATES = Object.freeze({});

export const DEFAULTS = {
  seedLaneFile: null,
  seedShardDir: null,
  derivedShardDirs: [],
  derivedGlobalFiles: [],
  jobOutputPrefixes: DEFAULT_JOB_OUTPUT_PREFIXES,
  externalTreePrefixes: DEFAULT_EXTERNAL_TREE_PREFIXES,
  dataDependencyMap: DEFAULT_DATA_DEPENDENCY_MAP,
  cloudRepos: DEFAULT_CLOUD_REPOS,
  wikiSubjectPatterns: DEFAULT_WIKI_SUBJECT_PATTERNS,
  handoffLayout: 'single',
  handoffDir: null,
  deployServices: DEFAULT_DEPLOY_SERVICES,
  shardIdPattern: DEFAULT_SHARD_ID_PATTERN,
  scopeMaxKeys: DEFAULT_SCOPE_MAX_KEYS,
  operatorSpendCeilingUsd: DEFAULT_OPERATOR_SPEND_CEILING_USD,
  mutationBanner: DEFAULT_MUTATION_BANNER,
  lanes: DEFAULT_LANES,
  land: DEFAULT_LAND,
  plugins: DEFAULT_PLUGINS,
  coordCheckoutExcludedTopLevel: DEFAULT_COORD_CHECKOUT_EXCLUDED_TOP_LEVEL,
  planWorktreeExcludedPaths: DEFAULT_PLAN_WORKTREE_EXCLUDED_PATHS,
  reviewDiffExcludes: DEFAULT_REVIEW_DIFF_EXCLUDES,
  batteryScopedPrefixes: DEFAULT_BATTERY_SCOPED_PREFIXES,
  localHostDenylist: DEFAULT_LOCAL_HOST_DENYLIST,
  planCategories: DEFAULT_PLAN_CATEGORIES,
  planNaming: DEFAULT_PLAN_NAMING,
  pytestSelector: DEFAULT_PYTEST_SELECTOR,
  gates: DEFAULT_GATES,
  gitPatEnvVar: DEFAULT_GIT_PAT_ENV_VAR,
  codexAuthEnvVar: DEFAULT_CODEX_AUTH_ENV_VAR,
};

const VALID_LAYOUTS = new Set(['sessions', 'single']);

// ── plan 3960 validation helpers (shape + type only — deeper per-row semantics, e.g. Railway
// coordinate completeness, stay where they already live: resolveDeployServices in
// scripts/project/deploy.mjs) ─────────────────────────────────────────────────────────────────

/**
 * wikiSubjectPatterns[] (plan 4096 T2): a list of REGEX SOURCE strings, validated by COMPILING
 * each one here rather than at the point of use. A bad pattern is a config error and must say so
 * at load — deferring it would surface as an opaque SyntaxError from inside the wiki checkpoint,
 * mid-land, naming neither the key nor the offending row.
 */
function normalizeWikiSubjectPatterns(rows) {
  if (!Array.isArray(rows)) {
    throw new Error('coord-config: wikiSubjectPatterns must be an array');
  }
  return Object.freeze(
    rows.map((src) => {
      if (typeof src !== 'string' || !src.trim()) {
        throw new Error('coord-config: wikiSubjectPatterns has a non-string or empty entry');
      }
      try {
        new RegExp(src);
      } catch (e) {
        throw new Error(
          `coord-config: wikiSubjectPatterns entry ${JSON.stringify(src)} is not a valid ` +
            `regular expression (${e.message})`,
        );
      }
      return src;
    }),
  );
}

function normalizeDeployServices(rows) {
  if (!Array.isArray(rows)) {
    throw new Error('coord-config: deployServices must be an array');
  }
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('coord-config: deployServices has a non-object entry');
    }
    if (typeof row.name !== 'string' || !row.name.trim()) {
      throw new Error('coord-config: a deployServices row is missing a non-empty "name"');
    }
    if (typeof row.platform !== 'string' || !row.platform.trim()) {
      throw new Error(
        `coord-config: deployServices row "${row.name}" is missing a non-empty "platform" ` +
          '(never defaulted — plan 3222)',
      );
    }
    if (!('market' in row)) {
      throw new Error(
        `coord-config: deployServices row "${row.name}" is missing the "market" key (a MARKETS ` +
          'key, or explicit null for a backend serving every market — never defaulted, plan 3215)',
      );
    }
    if (typeof row.role !== 'string' || !row.role.trim()) {
      throw new Error(
        `coord-config: deployServices row "${row.name}" is missing a non-empty "role" ` +
          '(never defaulted — plan 3399)',
      );
    }
  }
  return rows;
}

// plan 3962 P1: shape/type validation only — a glob's DOMAIN semantics (the bare-prefix-glob
// refusal, "exactly one capture group", etc.) stay in select-battery-tests.mjs, which is the
// module that actually interprets these globs. This validator only proves the merged map is
// well-typed: an object keyed by test basename, each value an array of non-empty strings.
function normalizeDataDependencyMap(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('coord-config: dataDependencyMap must be an object keyed by test basename');
  }
  const out = {};
  for (const [test, globs] of Object.entries(raw)) {
    if (!Array.isArray(globs)) {
      throw new Error(`coord-config: dataDependencyMap["${test}"] must be an array of globs`);
    }
    out[test] = globs.map((g) => {
      if (typeof g !== 'string' || !g.trim()) {
        throw new Error(`coord-config: dataDependencyMap["${test}"] has an empty/non-string glob`);
      }
      return g.replace(/\\/g, '/');
    });
  }
  return out;
}

// plan 3962 P1: cloudRepos row shape mirrors scripts/coord/cloud-repos-lib.mjs's former CLOUD_REPOS
// literal exactly — shape/type only, no URL-reachability or credential-provisioning check (that
// stays a human/operator step, same posture as normalizeDeployServices above).
function normalizeCloudRepos(rows) {
  if (!Array.isArray(rows)) {
    throw new Error('coord-config: cloudRepos must be an array');
  }
  const seenKeys = new Set();
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('coord-config: cloudRepos has a non-object entry');
    }
    for (const field of ['key', 'url', 'dir', 'tokenEnv']) {
      if (typeof row[field] !== 'string' || !row[field].trim()) {
        throw new Error(`coord-config: a cloudRepos row is missing a non-empty "${field}"`);
      }
    }
    if (seenKeys.has(row.key)) {
      throw new Error(`coord-config: cloudRepos lists key "${row.key}" more than once`);
    }
    seenKeys.add(row.key);
    if (row.note !== undefined && typeof row.note !== 'string') {
      throw new Error(`coord-config: cloudRepos row "${row.key}" has a non-string "note"`);
    }
    return {
      key: row.key,
      url: row.url,
      dir: row.dir,
      tokenEnv: row.tokenEnv,
      note: row.note ?? '',
    };
  });
}

// Syntactic (not semantic) capturing-group scanner: a `(` opens a capturing group unless it is a
// non-capturing group (`(?:`), a lookaround (`(?=` `(?!` `(?<=` `(?<!`), sits inside a character
// class (`[...]`, where parens are literal), or is escaped (`\(`, likewise literal). A named
// group (`(?<name>`) DOES capture. Good enough for a config-authored pattern — this never has to
// parse arbitrary user regex, only validate the one string a project's coord.config.json may set.
//
// Exported (plan 3960 cluster-4 review fix) as the ONE shared implementation of "what counts as a
// real capturing group in a shardIdPattern string" — done-worktree-lib.mjs's deriveShardPatterns
// used to hand-roll its OWN naive `/\(([^()]+)\)/` scan to find "the" capture group, which counted
// the FIRST parenthesis regardless of type. That silently disagreed with the validator here the
// instant a pattern's first group was non-capturing or a lookaround (exactly the shape this
// validator deliberately ACCEPTS as valid): the validator would pass the pattern, then
// deriveShardPatterns would extract the WRONG group's content as "the clinic id". Importing this
// scanner instead of re-deriving the rule means the two can no longer drift apart — see that
// module's own comment at its call site.
//
// Groups are returned in TEXT order (by opening-paren position, not closing-paren/pop order) as
// `{ start, end, content }` — `start`/`end` are the indices of the group's own `(`/`)` in
// `pattern`, `content` is the text strictly between them. A stack, not a running counter, so
// nested groups (not expected in a shardIdPattern today, but not assumed away either) resolve
// correctly: only a `)` that closes a capturing `(` records a group.
export function capturingGroups(pattern) {
  const stack = [];
  const groups = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i++; // skip the escaped character, whatever it is
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '(') {
      // (?<name>...) captures; (?: (?= (?! (?<= (?<! do not.
      const capturing = !(
        pattern[i + 1] === '?' &&
        !(pattern[i + 2] === '<' && pattern[i + 3] !== '=' && pattern[i + 3] !== '!')
      );
      stack.push({ capturing, start: i });
      continue;
    }
    if (c === ')') {
      const g = stack.pop();
      if (g && g.capturing)
        groups.push({ start: g.start, end: i, content: pattern.slice(g.start + 1, i) });
    }
  }
  return groups.sort((a, b) => a.start - b.start);
}

function countCaptureGroups(pattern) {
  return capturingGroups(pattern).length;
}

function normalizeShardIdPattern(pattern) {
  // plan 4071: null means "no sharded records" — the same contract seedShardDir already has.
  // A config-less repo has no per-clinic shard filename shape, and every consumer must degrade
  // to that ("no shard layout"), never throw at load.
  if (pattern === null) return null;
  if (typeof pattern !== 'string' || !pattern.trim()) {
    throw new Error('coord-config: shardIdPattern must be null or a non-empty string');
  }
  try {
    // eslint-disable-next-line no-new -- validating compilability only; the constructed
    // RegExp itself is discarded (consumers build their own anchored regexes from the string).
    new RegExp(pattern);
  } catch (err) {
    throw new Error(`coord-config: shardIdPattern does not compile as a regex: ${err.message}`);
  }
  const groups = countCaptureGroups(pattern);
  if (groups !== 1) {
    throw new Error(
      `coord-config: shardIdPattern must have exactly one capture group (the clinic id) — ` +
        `found ${groups} in ${JSON.stringify(pattern)}`,
    );
  }
  return pattern;
}

function normalizeScopeMaxKeys(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('coord-config: scopeMaxKeys must be a positive integer');
  }
  return value;
}

// plan 4069 review round 2 (keys 6a70ae/853db6/066a1a): accept only a finite positive number —
// anything else (absent, malformed, zero, negative, wrong type) falls back to
// DEFAULT_OPERATOR_SPEND_CEILING_USD, silently, never throwing. This mirrors the ad-hoc
// `typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : PAUSE_COST_THRESHOLD_USD` read that
// used to live directly in drain-run.mjs (PAUSE_COST_THRESHOLD_USD === DEFAULT_OPERATOR_SPEND_
// CEILING_USD, both $5) — a soft safety knob a malformed value should degrade past, not a
// structural config error worth a hard refusal.
function normalizeOperatorSpendCeilingUsd(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_OPERATOR_SPEND_CEILING_USD;
}

// gitPatEnvVar / codexAuthEnvVar: same soft-degrade posture as operatorSpendCeilingUsd — a
// missing/malformed value degrades to the generic default rather than throwing, because a typo
// here must never turn into a hard refusal on an unrelated coord command's startup.
//
// plan 3958 review (key jlfzz7): both names are interpolated into POSIX shell syntax as-is
// downstream — ensure-coord-reroute.mjs's credentialHelperFor builds `echo "password=$${patEnvVar}"`
// — so a value that is not a valid shell/env identifier (e.g. "MY-PAT") would have the shell
// expand only its "$MY" prefix and silently feed the WRONG credential rather than fail loud. A
// config value shaped like that must never reach the interpolation site at all, so it is
// validated HERE, at load, against the POSIX env-var-name grammar (`^[A-Za-z_][A-Za-z0-9_]*$`),
// with the SAME degrade-to-default-and-warn posture every other malformed value on this key
// already has — never a hard throw, so a typo here still cannot refuse an unrelated coord
// command's startup.
const ENV_VAR_NAME_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeEnvVarName(value, fallback, key) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const trimmed = value.trim();
  if (!ENV_VAR_NAME_RX.test(trimmed)) {
    console.warn(
      `coord-config: ${key} ${JSON.stringify(trimmed)} is not a valid environment-variable name ` +
        `(must match ${ENV_VAR_NAME_RX}) — falling back to ${JSON.stringify(fallback)}`,
    );
    return fallback;
  }
  return trimmed;
}

function normalizeMutationBanner(raw) {
  const merged = { ...DEFAULT_MUTATION_BANNER, ...(raw || {}) };
  if (typeof merged.label !== 'string' || !merged.label.trim()) {
    throw new Error('coord-config: mutationBanner.label must be a non-empty string');
  }
  if (typeof merged.flag !== 'string' || !merged.flag.trim()) {
    throw new Error('coord-config: mutationBanner.flag must be a non-empty string');
  }
  return { label: merged.label, flag: merged.flag };
}

// plan 3961 T2 review (key 3dc8da): recognizes an absolute filesystem path across BOTH path
// flavors a `worktreeMemoryReclaimScript` value could legitimately name — POSIX ("/foo/bar"),
// Windows drive-rooted ("C:\foo" / "C:/foo"), or Windows UNC ("\\host\share"). Deliberately NOT
// node:path's platform-default `isAbsolute`: that classifies a Windows-style string differently
// depending on which OS is running the VALIDATOR, not which OS the string targets — this
// coord.config.json key is committed and read on Windows and Linux alike (platform-symbol axis,
// see this repo's CLAUDE.md), so the same config value must validate identically everywhere.
function isAbsoluteLikePath(p) {
  return /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
}

function normalizeLand(raw) {
  // plan 3961 T2 review (key ed6e7d): `{ ...DEFAULT_LAND, ...(raw || {}) }` below silently
  // accepts a non-object `land` value — spreading a string's own enumerable keys (its numeric
  // indices) or an array's (none) is never the intended shape, so `land: "oops"` or `land: []`
  // used to fall back to every default (worldClaimFields: [] included) with no error, silently
  // disabling the conclusion-review gate. null/undefined mean "use every default" and pass.
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error(
      `coord-config: land must be an object (got ${Array.isArray(raw) ? 'an array' : typeof raw})`,
    );
  }
  // plan 3961 T2.7a: land.gateRoster is no longer a config key at all — the once-per-land roster
  // is derived from the land-gates registry (the registered preflight-stage prepGates, in
  // registry order; see landGateRosterFromRegistry in done-worktree.mjs). A config that still
  // sets it is refused rather than silently ignored: before this change a wrong or stale
  // land.gateRoster quietly changed which gate names the once-per-land proof recognized, so a
  // key this validator now drops without a word would fail in exactly that same silent way.
  if (raw && Object.prototype.hasOwnProperty.call(raw, 'gateRoster')) {
    throw new Error(
      'coord-config: land.gateRoster is no longer a config key (plan 3961 T2.7a) — the once-per-' +
        'land gate roster is derived from the registered preflight-stage prepGates instead of ' +
        'being configured. Delete land.gateRoster from coord.config.json.',
    );
  }
  const merged = { ...DEFAULT_LAND, ...(raw || {}) };
  const {
    localTimeoutSeconds,
    worldClaimFields,
    specReviewGatedFields,
    coordinationOnlyPathPrefixes,
    worktreeMemoryReclaimScript,
    buildCommand,
    typecheckCommands,
  } = merged;
  // Shape only. The per-row contract — required fields, the regex, the positive integer cap, and
  // the word-splitting safety the hook's unquoted expansion demands — is validated by the one
  // consumer, scripts/coord/land-typecheck-rows.mjs, which THROWS (exit 2) rather than dropping a
  // row. Keeping it there avoids two copies of the same rules drifting apart, and the hook treats
  // that non-zero exit as a hard push failure, so a malformed row can never read as "no typecheck
  // configured" and pass. What must be caught HERE is the shape that would make the consumer's own
  // `?? []` fall back to empty and silently disable every gate: a non-array.
  if (!Array.isArray(typecheckCommands)) {
    throw new Error(
      'coord-config: land.typecheckCommands must be an array (got ' +
        (typecheckCommands === null ? 'null' : typeof typecheckCommands) +
        ')',
    );
  }
  if (!Number.isSafeInteger(localTimeoutSeconds) || localTimeoutSeconds <= 0) {
    throw new Error('coord-config: land.localTimeoutSeconds must be a positive integer (seconds)');
  }
  // Shared by worldClaimFields and specReviewGatedFields (plan 4071 D3): both are exact,
  // deduplicated field-name lists a downstream `content.includes(field)` / `prev[field]`-style
  // read compares against verbatim, so a whitespace-padded entry must be refused rather than
  // silently trimmed (plan 3961 T2 review, key a71dfc) — it would otherwise read as a nonexistent
  // property on both sides and mask exactly the flip/overwrite each gate exists to catch.
  const normFieldNameList = (key, list) => {
    if (!Array.isArray(list)) {
      throw new Error(`coord-config: land.${key} must be an array of field names`);
    }
    const seen = new Set();
    for (const f of list) {
      if (typeof f !== 'string' || !f.trim()) {
        throw new Error(`coord-config: land.${key} has an empty/non-string entry`);
      }
      if (f !== f.trim()) {
        throw new Error(
          `coord-config: land.${key} has a whitespace-padded entry: ${JSON.stringify(f)}`,
        );
      }
      if (seen.has(f)) {
        throw new Error(`coord-config: land.${key} lists "${f}" more than once`);
      }
      seen.add(f);
    }
    return [...list];
  };
  normFieldNameList('worldClaimFields', worldClaimFields);
  normFieldNameList('specReviewGatedFields', specReviewGatedFields);
  if (!Array.isArray(coordinationOnlyPathPrefixes)) {
    throw new Error(
      'coord-config: land.coordinationOnlyPathPrefixes must be an array of path prefixes',
    );
  }
  const seenPrefixes = new Set();
  for (const p of coordinationOnlyPathPrefixes) {
    if (typeof p !== 'string' || !p.trim()) {
      throw new Error(
        'coord-config: land.coordinationOnlyPathPrefixes has an empty/non-string entry',
      );
    }
    if (seenPrefixes.has(p)) {
      throw new Error(
        `coord-config: land.coordinationOnlyPathPrefixes lists "${p}" more than once`,
      );
    }
    seenPrefixes.add(p);
  }
  if (
    worktreeMemoryReclaimScript !== null &&
    (typeof worktreeMemoryReclaimScript !== 'string' || !worktreeMemoryReclaimScript.trim())
  ) {
    throw new Error(
      'coord-config: land.worktreeMemoryReclaimScript must be null or a non-empty string',
    );
  }
  // plan 3961 T2 review (key 3dc8da): the shape check above accepted ANY non-empty string. The
  // spine (done-worktree.mjs's teardown step 2) expands only a leading "~/" and otherwise passes
  // the value straight to PowerShell's `-File` argument, so a bare relative path — traversing
  // ("../../outside.ps1") or not ("scripts/reclaim.ps1") — resolves against whatever directory
  // happens to be the process cwd at teardown time: an implicit, unreviewable target. Constrain
  // to the three explicit forms the spine actually knows how to resolve unambiguously.
  if (
    worktreeMemoryReclaimScript !== null &&
    !worktreeMemoryReclaimScript.startsWith('~/') &&
    !isAbsoluteLikePath(worktreeMemoryReclaimScript)
  ) {
    throw new Error(
      'coord-config: land.worktreeMemoryReclaimScript must be null, an absolute path, or a ' +
        `"~/"-prefixed path — got ${JSON.stringify(worktreeMemoryReclaimScript)}`,
    );
  }
  // plan 3961 review fix: land.buildCommand carries the WHOLE invocation ({ command, args }),
  // never just a package name — a project that builds with something other than pnpm must be
  // expressible. null (the core default) means this project has no build gate; the shape check
  // below is malformed-value refusal, mirroring worktreeMemoryReclaimScript's own null-or-refuse
  // contract just above.
  if (buildCommand !== null) {
    if (typeof buildCommand !== 'object' || Array.isArray(buildCommand)) {
      throw new Error(
        'coord-config: land.buildCommand must be null or an object of shape ' +
          `{ command, args } — got ${Array.isArray(buildCommand) ? 'an array' : typeof buildCommand}`,
      );
    }
    if (typeof buildCommand.command !== 'string' || !buildCommand.command.trim()) {
      throw new Error('coord-config: land.buildCommand.command must be a non-empty string');
    }
    if (!Array.isArray(buildCommand.args) || buildCommand.args.some((a) => typeof a !== 'string')) {
      throw new Error('coord-config: land.buildCommand.args must be an array of strings');
    }
  }
  return {
    localTimeoutSeconds,
    worldClaimFields: [...worldClaimFields],
    specReviewGatedFields: [...specReviewGatedFields],
    coordinationOnlyPathPrefixes: [...coordinationOnlyPathPrefixes],
    worktreeMemoryReclaimScript,
    buildCommand:
      buildCommand === null
        ? null
        : { command: buildCommand.command, args: [...buildCommand.args] },
    typecheckCommands: typecheckCommands.map((r) => ({ ...r })),
  };
}

// plan 3961 T1: plugins is `{ <extension point>: [<repo-relative module path>, …] }`.
//
// Shape and PATH SAFETY only — whether the file exists, loads, or exports the right thing is
// scripts/land-plugins.mjs's business (and registry.mjs's, for the entries themselves). Three refusals
// beyond the obvious type checks, each closing a way a wrong value would otherwise fail late and
// unhelpfully:
//
//   - an unknown point name. `{"prepGate": […]}` (singular) would otherwise be a plugin list
//     nothing ever reads — a registered gate that silently never runs, which on the land spine
//     is the failure mode with no symptom. The error names the five valid points.
//   - an absolute path or one escaping the repo (`/etc/x.mjs`, `../../x.mjs`, a Windows drive
//     path, a URL). A coord.config.json is committed repo content and its plugin paths are
//     resolved against the repo root; anything reaching outside it is a config error, not a
//     capability this key is meant to offer.
//   - a duplicate path within one point. Importing the same module twice would register every
//     one of its entries twice, which buildRegistry then refuses as duplicate NAMES — a correct
//     refusal with a misleading message. Catch it here, where the cause is visible.
function normalizePlugins(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULT_PLUGINS };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'coord-config: plugins must be an object keyed by extension point ' +
        `(one of: ${EXTENSION_POINTS.join(', ')})`,
    );
  }
  const out = {};
  for (const [point, list] of Object.entries(raw)) {
    if (!isExtensionPoint(point)) {
      throw new Error(
        `coord-config: plugins names "${point}", which is not a land extension point ` +
          `(expected one of: ${EXTENSION_POINTS.join(', ')})`,
      );
    }
    if (!Array.isArray(list)) {
      throw new Error(`coord-config: plugins.${point} must be an array of module paths`);
    }
    const seen = new Set();
    const paths = [];
    for (const entry of list) {
      if (typeof entry !== 'string' || !entry.trim()) {
        throw new Error(`coord-config: plugins.${point} has an empty/non-string entry`);
      }
      const posix = entry.replace(/\\/g, '/').trim();
      if (
        posix.startsWith('/') ||
        /^[A-Za-z]:\//.test(posix) ||
        /^[a-z][a-z0-9+.-]*:/i.test(posix) ||
        posix === '..' ||
        posix.startsWith('../') ||
        posix.split('/').includes('..')
      ) {
        throw new Error(
          `coord-config: plugins.${point} entry ${JSON.stringify(entry)} must be a ` +
            'repo-relative path inside the repo (no absolute path, no "..", no URL)',
        );
      }
      // Canonicalize before the duplicate check (review round 1, findings 9ae61a/cecd6a/d48193/
      // 915306): "./scripts/x.mjs", "scripts/./x.mjs" and "scripts/x.mjs" all resolve to the same
      // module, so a raw-string comparison let two spellings of one path through and the module
      // registered every one of its entries twice. Lexical only, and that is enough here — the
      // ".." and absolute forms are already refused above, so the only segments left to fold are
      // "." and empty ones from a doubled slash.
      const canonical = posix
        .split('/')
        .filter((seg, i) => seg !== '.' && (seg !== '' || i === 0))
        .join('/');
      // Canonicalization can EMPTY a path that passed the non-empty check above (review round 2,
      // finding 56655b): "." and "./" fold to "". An empty plugin path would resolve to the repo
      // root and fail far away from its cause, so refuse it here.
      if (!canonical) {
        throw new Error(
          `coord-config: plugins.${point} entry ${JSON.stringify(entry)} canonicalizes to an ` +
            'empty path — it must name a module file inside the repo',
        );
      }
      if (seen.has(canonical)) {
        throw new Error(
          `coord-config: plugins.${point} lists ${JSON.stringify(canonical)} twice — every entry ` +
            'in that module would register twice',
        );
      }
      seen.add(canonical);
      paths.push(canonical);
    }
    out[point] = paths;
  }
  return out;
}

// plan 4071 D1: allowlist core default `[]` means ALLOW ALL, not "reject everything" — the
// allowlist is a REJECTING gate, so the safe degrade direction for a config-less repo is
// not-restricting. evidenceGated core default `[]`: gates no category behind a heavy-model
// specReview evidence marker. Shape/type only: non-empty strings, no duplicates within each list
// (a duplicate would silently do nothing except mask a typo).
function normalizePlanCategories(raw) {
  if (raw === undefined || raw === null) return { allowlist: [], evidenceGated: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('coord-config: planCategories must be an object');
  }
  const merged = { ...DEFAULT_PLAN_CATEGORIES, ...raw };
  const normStringList = (key, list) => {
    if (!Array.isArray(list)) {
      throw new Error(`coord-config: planCategories.${key} must be an array of category names`);
    }
    const seen = new Set();
    return list.map((entry) => {
      if (typeof entry !== 'string' || !entry.trim()) {
        throw new Error(`coord-config: planCategories.${key} has an empty/non-string entry`);
      }
      if (seen.has(entry)) {
        throw new Error(`coord-config: planCategories.${key} lists "${entry}" more than once`);
      }
      seen.add(entry);
      return entry;
    });
  };
  return {
    allowlist: normStringList('allowlist', merged.allowlist),
    evidenceGated: normStringList('evidenceGated', merged.evidenceGated),
  };
}

// plan 4071 T2: countryTokenHints is an array of `{ token, code }` rows (JSON carries no Map
// literal) rather than the source Map directly; a wave-2 consumer rebuilds the Map from this
// array. stageTokens.category names WHICH category the stage-token lint applies to (`null` = the
// lint never fires); stageTokens.tokens is the vocabulary a matching plan's first slug token is
// checked against. Shape/type only — the actual lint logic stays with its wave-2/3 consumer.
function normalizePlanNaming(raw) {
  if (raw === undefined || raw === null) {
    return { countryTokenHints: [], stageTokens: { category: null, tokens: [] } };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('coord-config: planNaming must be an object');
  }
  const merged = { ...DEFAULT_PLAN_NAMING, ...raw };
  if (!Array.isArray(merged.countryTokenHints)) {
    throw new Error('coord-config: planNaming.countryTokenHints must be an array of rows');
  }
  const seenTokens = new Set();
  const countryTokenHints = merged.countryTokenHints.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('coord-config: planNaming.countryTokenHints has a non-object entry');
    }
    if (typeof row.token !== 'string' || !row.token.trim()) {
      throw new Error(
        'coord-config: a planNaming.countryTokenHints row is missing a non-empty "token"',
      );
    }
    if (typeof row.code !== 'string' || !row.code.trim()) {
      throw new Error(
        `coord-config: planNaming.countryTokenHints row "${row.token}" is missing a non-empty ` +
          '"code"',
      );
    }
    if (seenTokens.has(row.token)) {
      throw new Error(
        `coord-config: planNaming.countryTokenHints lists token "${row.token}" more than once`,
      );
    }
    seenTokens.add(row.token);
    return { token: row.token, code: row.code };
  });
  const rawStageTokens = merged.stageTokens;
  if (
    rawStageTokens === undefined ||
    rawStageTokens === null ||
    typeof rawStageTokens !== 'object' ||
    Array.isArray(rawStageTokens)
  ) {
    throw new Error('coord-config: planNaming.stageTokens must be an object');
  }
  const stageMerged = { ...DEFAULT_PLAN_NAMING.stageTokens, ...rawStageTokens };
  if (
    stageMerged.category !== null &&
    (typeof stageMerged.category !== 'string' || !stageMerged.category.trim())
  ) {
    throw new Error(
      'coord-config: planNaming.stageTokens.category must be null or a non-empty string',
    );
  }
  if (!Array.isArray(stageMerged.tokens)) {
    throw new Error('coord-config: planNaming.stageTokens.tokens must be an array of strings');
  }
  const tokens = stageMerged.tokens.map((t) => {
    if (typeof t !== 'string' || !t.trim()) {
      throw new Error('coord-config: planNaming.stageTokens.tokens has an empty/non-string entry');
    }
    return t;
  });
  return {
    countryTokenHints,
    stageTokens: { category: stageMerged.category, tokens },
  };
}

// plan 4071 E-A: both null ⇒ a config-less repo has no pytest selector script; runPytestSelector's
// own contract already degrades a missing/failing script to `null` ("run everything"), so this
// default costs nothing to consumers written to that contract.
function normalizePytestSelector(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULT_PYTEST_SELECTOR };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('coord-config: pytestSelector must be an object');
  }
  const merged = { ...DEFAULT_PYTEST_SELECTOR, ...raw };
  if (merged.prefix !== null && (typeof merged.prefix !== 'string' || !merged.prefix.trim())) {
    throw new Error('coord-config: pytestSelector.prefix must be null or a non-empty string');
  }
  if (merged.script !== null && (typeof merged.script !== 'string' || !merged.script.trim())) {
    throw new Error('coord-config: pytestSelector.script must be null or a non-empty string');
  }
  return { prefix: merged.prefix, script: merged.script };
}

// plan 4071 T4/D5: shape/type validation only — a `probe` value's correspondence to an actual
// core-provided probe function, and `probeScript`'s existence on disk, are the wave-3 consumer's
// business, not this seam's. `{}` degrades to "no gate is cacheable" everywhere a consumer reads
// this key correctly (T4's own import-time-crash hazard, E-B, is exactly the failure mode this
// shape exists to make impossible to write by accident).
function normalizeGates(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('coord-config: gates must be an object keyed by gate name');
  }
  const out = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`coord-config: gates["${name}"] must be an object`);
    }
    if (typeof entry.desc !== 'string' || !entry.desc.trim()) {
      throw new Error(`coord-config: gates["${name}"] is missing a non-empty "desc"`);
    }
    if (!Array.isArray(entry.paths)) {
      throw new Error(`coord-config: gates["${name}"].paths must be an array of paths`);
    }
    const paths = entry.paths.map((p) => {
      if (typeof p !== 'string' || !p.trim()) {
        throw new Error(`coord-config: gates["${name}"].paths has an empty/non-string entry`);
      }
      return p;
    });
    const outEntry = { desc: entry.desc, paths };
    if (entry.envUncacheable !== undefined) {
      if (!Array.isArray(entry.envUncacheable)) {
        throw new Error(`coord-config: gates["${name}"].envUncacheable must be an array of paths`);
      }
      outEntry.envUncacheable = entry.envUncacheable.map((p) => {
        if (typeof p !== 'string' || !p.trim()) {
          throw new Error(
            `coord-config: gates["${name}"].envUncacheable has an empty/non-string entry`,
          );
        }
        return p;
      });
    }
    if (entry.probe !== undefined) {
      if (typeof entry.probe !== 'string' || !entry.probe.trim()) {
        throw new Error(`coord-config: gates["${name}"].probe must be a non-empty string`);
      }
      outEntry.probe = entry.probe;
    }
    if (entry.probeScript !== undefined) {
      if (typeof entry.probeScript !== 'string' || !entry.probeScript.trim()) {
        throw new Error(`coord-config: gates["${name}"].probeScript must be a non-empty string`);
      }
      outEntry.probeScript = entry.probeScript;
    }
    out[name] = outEntry;
  }
  return out;
}

// lanes.order names WHICH of the named keys render, and in what order; archive/parked are
// always appended after, never listed in `order` themselves (mirrors STATUS_ORDER's own
// long-standing contract — see build-index-lib.mjs). Every folder name across the whole set
// (active + archive + parked) must be distinct: a duplicate would make two lanes
// indistinguishable to every path-prefix consumer built from PLAN_FOLDER_ALT.
function normalizeLanes(raw) {
  const merged = { ...DEFAULT_LANES, ...(raw || {}) };
  const { order, archive, parked, ...folders } = merged;
  if (!Array.isArray(order) || order.length === 0) {
    throw new Error('coord-config: lanes.order must be a non-empty array of lane keys');
  }
  const seenKeys = new Set();
  for (const key of order) {
    if (typeof key !== 'string' || !key.trim()) {
      throw new Error('coord-config: lanes.order has an empty/non-string entry');
    }
    if (seenKeys.has(key)) {
      throw new Error(`coord-config: lanes.order lists "${key}" more than once`);
    }
    seenKeys.add(key);
    if (typeof folders[key] !== 'string' || !folders[key].trim()) {
      throw new Error(
        `coord-config: lanes.order names "${key}", but lanes.${key} is missing/empty`,
      );
    }
  }
  if (typeof archive !== 'string' || !archive.trim()) {
    throw new Error('coord-config: lanes.archive must be a non-empty string');
  }
  if (typeof parked !== 'string' || !parked.trim()) {
    throw new Error('coord-config: lanes.parked must be a non-empty string');
  }
  // Every ROLE folder must be a non-empty string, whether or not `order` names it (cluster-6
  // review fix): a role omitted from `order` (e.g. a config that renders a shorter active list
  // but keeps waitingGrill as a real folder consumers still cross-reference by role) is still a
  // real folder every per-lane named constant (WAITING_GRILL_FOLDER, …) resolves to, so it must
  // be validated exactly like an in-`order` one — an empty/missing value there used to pass
  // normalizeLanes silently and only blow up later at whatever call site first dereferenced it.
  for (const key of Object.keys(folders)) {
    if (typeof folders[key] !== 'string' || !folders[key].trim()) {
      throw new Error(`coord-config: lanes.${key} must be a non-empty string`);
    }
  }
  const statusOrder = order.map((key) => folders[key]);
  // Duplicate check spans EVERY role folder (not just the ones `order` renders) plus
  // archive/parked — a lane left OUT of `order` used to be invisible to this check, so it could
  // silently collide with an active folder's name and become indistinguishable to every
  // path-prefix consumer built from PLAN_FOLDER_ALT / the per-lane named constants (cluster-6
  // review fix: "reject duplicate role folders too").
  const allFolders = [...Object.values(folders), archive, parked];
  const dupes = allFolders.filter((f, i) => allFolders.indexOf(f) !== i);
  if (dupes.length) {
    throw new Error(
      `coord-config: lanes has duplicate folder name(s): ${[...new Set(dupes)].join(', ')}`,
    );
  }
  return { ...folders, order: [...order], archive, parked, statusOrder };
}

// The legacy root-scattered coordination layout (config-less repos + pre-857
// vetapp): the three loose root .md files, a root-level handoff/sessions/ dir, and
// the older docs/handoffs/ archive home. derivePaths(null) returns exactly this, so
// any repo without `handoffDir` keeps its current behavior byte-for-byte.
export const LEGACY_PATHS = {
  handoffDir: null,
  boardFile: 'handoff-board.md',
  queueFile: 'landing-queue.md',
  rollingHandoffFile: 'handoff.md',
  sessionsDir: 'handoff/sessions',
  archiveDir: 'docs/handoffs',
};

/**
 * Pure: the five coordination file/dir paths, keyed off an optional `handoffDir`.
 * Plan 857 centralizes EVERY handoff path literal here so the move to one tree is a
 * one-line config flip rather than a ~30-consumer grep-and-replace.
 *   - handoffDir set (vetapp post-857: "docs/handoff") => one tree, out of repo root.
 *   - null => the legacy root-scattered literals above (config-less + sibling repos).
 * Paths are repo-root-RELATIVE and POSIX-separated (git pathspecs / commit grep).
 */
export function derivePaths(handoffDir) {
  if (!handoffDir) return { ...LEGACY_PATHS };
  const d = String(handoffDir)
    .replace(/[/\\]+$/, '')
    .replace(/\\/g, '/');
  return {
    handoffDir: d,
    boardFile: `${d}/board.md`,
    // plan 3973: the MASTER-side file. Since the cut-over it is a one-line tombstone; the live
    // queue document is on the coord ref refs/heads/coord/landing-queue (landing-queue-ref.mjs).
    queueFile: `${d}/landing-queue.md`,
    rollingHandoffFile: `${d}/current.md`,
    sessionsDir: `${d}/sessions`,
    archiveDir: `${d}/archive`,
  };
}

/** Pure: normalize a raw parsed config (or null) into the full profile + derived seedLane + paths. */
export function normalizeConfig(raw) {
  // A malformed top-level shape (an array, a string, a number, `false`) used to be silently
  // accepted here — `{ ...DEFAULTS, ...raw }` spreads a non-object into nothing (an array
  // spreads its INDICES as keys, e.g. `{0: 'x'}`, silently keeping every real default) rather
  // than throwing, so a coord.config.json authored as `[]` or `"oops"` read as "no overrides"
  // instead of the authoring mistake it is (cluster-6 review fix). `null`/`undefined` stay the
  // documented "no config" sentinel (loadCoordConfig's absent-file case and every existing
  // `normalizeConfig(null)` caller), so only a non-null, non-plain-object value is refused.
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error(
      `coord-config: coord.config.json must be a JSON object at the top level — got ${
        Array.isArray(raw) ? 'an array' : typeof raw
      }`,
    );
  }
  const merged = { ...DEFAULTS, ...(raw || {}) };
  if (!VALID_LAYOUTS.has(merged.handoffLayout)) {
    throw new Error(
      `coord-config: invalid handoffLayout "${merged.handoffLayout}" (expected: sessions | single)`,
    );
  }
  const seedLaneFile = merged.seedLaneFile ?? null;
  // Normalize to POSIX + no trailing slash (matched against git diff paths). A defined-but-
  // empty value is a config ERROR, not "no shard dir": silently collapsing "" to null would
  // drop shard-only diffs out of the seed lane and skip the LANDING mutex entirely (plan-1300
  // review finding 4) — fail loudly instead.
  if (merged.seedShardDir != null && !String(merged.seedShardDir).trim()) {
    throw new Error(
      'coord-config: seedShardDir is set but empty — either point it at the shard tree ' +
        '(e.g. "backend/src/data/seed") or omit the key entirely',
    );
  }
  const seedShardDir = merged.seedShardDir
    ? String(merged.seedShardDir).replace(/\\/g, '/').replace(/\/+$/, '')
    : null;
  // Plan 1867: same loud-fail posture as seedShardDir — a malformed/empty entry
  // would silently drop derived-data diffs out of the mutex scope, exactly the
  // class this config exists to close.
  const normList = (key, stripTrailingSlash) => {
    const raw = merged[key] ?? [];
    if (!Array.isArray(raw))
      throw new Error(`coord-config: ${key} must be an array of repo-relative paths`);
    return raw.map((entry) => {
      if (typeof entry !== 'string' || !entry.trim())
        throw new Error(`coord-config: ${key} has an empty/non-string entry — remove or fix it`);
      const posix = entry.replace(/\\/g, '/');
      return stripTrailingSlash ? posix.replace(/\/+$/, '') : posix;
    });
  };
  // Review round 3 (4071, key 30957d): localHostDenylist's own type check below, kept
  // deliberately separate from normList above rather than routed through it — normList's
  // single combined check (`typeof entry !== 'string' || !entry.trim()`) throws the SAME
  // message for a non-string entry and a blank string, but localHostDenylist must treat those
  // two cases differently (a blank string is harmless paste noise and is silently dropped,
  // per the comment on `rawLocalHostDenylist` below; only a genuinely non-string element is a
  // config-authoring bug). Splitting normList's own check to share this one would change its
  // error TEXT for every existing normList consumer (derivedShardDirs, derivedGlobalFiles,
  // jobOutputPrefixes, externalTreePrefixes, coordCheckoutExcludedTopLevel,
  // planWorktreeExcludedPaths, reviewDiffExcludes, batteryScopedPrefixes) for no reason those
  // keys need — so this stays its own small, single-purpose check instead.
  const assertStringEntries = (key, raw) => {
    for (const entry of raw) {
      if (typeof entry !== 'string')
        throw new Error(
          `coord-config: ${key} has a non-string entry (${JSON.stringify(entry)}) — remove or fix it`,
        );
    }
  };
  const derivedShardDirs = normList('derivedShardDirs', true);
  const derivedGlobalFiles = normList('derivedGlobalFiles', false);
  // jobOutputPrefixes / externalTreePrefixes are matched with a leading-anchor regex / startsWith
  // against a full relative path — NEVER strip the trailing slash (plan 3962 P1): stripping it
  // would let "backend/data/price-pipeline" match a sibling like "backend/data/price-pipeline-x/"
  // that the trailing "/" was there specifically to exclude.
  const jobOutputPrefixes = normList('jobOutputPrefixes', false);
  const externalTreePrefixes = normList('externalTreePrefixes', false);
  const dataDependencyMap = normalizeDataDependencyMap(merged.dataDependencyMap);
  const paths = derivePaths(merged.handoffDir);
  const deployServices = normalizeDeployServices(merged.deployServices);
  const cloudRepos = normalizeCloudRepos(merged.cloudRepos);
  const wikiSubjectPatterns = normalizeWikiSubjectPatterns(merged.wikiSubjectPatterns);
  const shardIdPattern = normalizeShardIdPattern(merged.shardIdPattern);
  const scopeMaxKeys = normalizeScopeMaxKeys(merged.scopeMaxKeys);
  const operatorSpendCeilingUsd = normalizeOperatorSpendCeilingUsd(merged.operatorSpendCeilingUsd);
  const mutationBanner = normalizeMutationBanner(merged.mutationBanner);
  const lanes = normalizeLanes(merged.lanes);
  const land = normalizeLand(merged.land);
  const plugins = normalizePlugins(merged.plugins);
  // plan 4071: simple repo-relative-path/token lists, same normList shape as
  // derivedShardDirs/derivedGlobalFiles/jobOutputPrefixes/externalTreePrefixes above.
  // coordCheckoutExcludedTopLevel/planWorktreeExcludedPaths/reviewDiffExcludes name directory-ish
  // paths (trailing slash stripped, like derivedShardDirs); batteryScopedPrefixes/
  // localHostDenylist are matched by prefix/exact-string and must NOT have a trailing slash
  // stripped (same reasoning as jobOutputPrefixes/externalTreePrefixes above — a stripped
  // "backend/" would prefix-match a sibling "backend-x/" it was meant to exclude).
  const coordCheckoutExcludedTopLevel = normList('coordCheckoutExcludedTopLevel', true);
  const planWorktreeExcludedPaths = normList('planWorktreeExcludedPaths', true);
  const reviewDiffExcludes = normList('reviewDiffExcludes', true);
  const batteryScopedPrefixes = normList('batteryScopedPrefixes', false);
  // localHostDenylist is a HOSTNAME list, not a path list, so it is normalized here
  // BESPOKE rather than through the shared `normList` above (plan 4071 review round 2, key
  // 94827c): normList's loud-fail-on-empty posture is right for a path/exclude list (a
  // silently-dropped scope entry hides real diff), but a stray blank entry in a hostname
  // denylist is just paste noise — dropping it after trimming is strictly SAFER than
  // throwing, and the alternative (keeping the untrimmed value) is what let a padded entry
  // like `" BUILD-HOST-01"` silently never match the guard it exists to trip. Case is
  // normalized to uppercase too (unlike normList's path-preserving siblings above) — see
  // the DEFAULT_LOCAL_HOST_DENYLIST header comment for why a hostname list normalizes case.
  // cloud-checkout-preflight.mjs's own independent parse of this same key applies the
  // identical trim-then-uppercase-then-drop-empty treatment so the two readers cannot
  // disagree about which hosts are denylisted.
  const rawLocalHostDenylist = merged.localHostDenylist ?? [];
  if (!Array.isArray(rawLocalHostDenylist))
    throw new Error('coord-config: localHostDenylist must be an array of hostnames');
  // Review round 3 (4071, key 30957d): a non-string entry (e.g. `[123]`) used to be silently
  // FILTERED OUT here rather than rejected, so a malformed config like that collapsed to `[]`
  // — exactly the class of failure assertStringEntries (defined above, next to normList)
  // exists to close. Routed through that shared helper rather than a second hand-rolled type
  // check, so this key's non-string-entry error can never drift out of sync with normList's.
  // A blank/whitespace-only entry still degrades silently to a drop after trimming (paste
  // noise, not a type error) — that divergence from normList's own blank handling is
  // intentional, see assertStringEntries's comment.
  assertStringEntries('localHostDenylist', rawLocalHostDenylist);
  const localHostDenylist = rawLocalHostDenylist
    .map((h) => h.trim().toUpperCase())
    .filter((h) => h !== '');
  const planCategories = normalizePlanCategories(merged.planCategories);
  const planNaming = normalizePlanNaming(merged.planNaming);
  const pytestSelector = normalizePytestSelector(merged.pytestSelector);
  const gates = normalizeGates(merged.gates);
  const gitPatEnvVar = normalizeEnvVarName(
    merged.gitPatEnvVar,
    DEFAULT_GIT_PAT_ENV_VAR,
    'gitPatEnvVar',
  );
  const codexAuthEnvVar = normalizeEnvVarName(
    merged.codexAuthEnvVar,
    DEFAULT_CODEX_AUTH_ENV_VAR,
    'codexAuthEnvVar',
  );
  return {
    seedLaneFile,
    seedShardDir,
    derivedShardDirs,
    derivedGlobalFiles,
    jobOutputPrefixes,
    externalTreePrefixes,
    dataDependencyMap,
    cloudRepos,
    wikiSubjectPatterns,
    handoffLayout: merged.handoffLayout,
    deployServices,
    shardIdPattern,
    scopeMaxKeys,
    operatorSpendCeilingUsd,
    mutationBanner,
    lanes,
    land,
    plugins,
    coordCheckoutExcludedTopLevel,
    planWorktreeExcludedPaths,
    reviewDiffExcludes,
    batteryScopedPrefixes,
    localHostDenylist,
    planCategories,
    planNaming,
    pytestSelector,
    gates,
    gitPatEnvVar,
    codexAuthEnvVar,
    // Plan 1867 (xhigh review F3): the derived scope roots also constitute a lane —
    // seedScopeOf treats their diffs as lockable scope, so every seedLane consumer
    // (plan 🟥/🟩 banners, queue-drain's mutex sort, claim-plan) must agree, or a
    // derived-data-only repo's plans read 🟩 while their lands silently serialize.
    seedLane:
      seedLaneFile !== null ||
      seedShardDir !== null ||
      derivedShardDirs.length > 0 ||
      derivedGlobalFiles.length > 0,
    handoffDir: paths.handoffDir,
    paths,
  };
}

/** IO: read <repoRoot>/coord.config.json if present, else DEFAULTS. */
export function loadCoordConfig(repoRoot) {
  const p = join(repoRoot, 'coord.config.json');
  const raw = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  return normalizeConfig(raw);
}

// Plan 2502: doAcquire's Gate 2 resolves the plan body fresh against origin/master (plan
// 2395's resolvePlanAtOrigin/readAtOrigin) but used to read coord.config.json off repoRoot's
// own possibly-stale working tree — a seedLane flip landing in the gap between the two reads
// could feed checkStubClaimGate a config value from a different moment than the plan body it's
// gating. loadCoordConfigAtOrigin pins the config read to the SAME sha the caller already
// resolved for the plan-file read, so both inputs come from one immutable point in history.
// `git show <sha>:<path>` fails with one of these two message shapes (and only these) when the
// path is genuinely absent from the tree at that sha — "does not exist in" when the path is
// absent everywhere, "exists on disk, but not in" when an untracked/uncommitted local copy is
// present but the pinned sha predates it. Every OTHER git-show failure (a transient spawn
// hiccup, repo corruption, an invalid sha) has a different message. Falling back to a local
// read on ANY error would swallow a real failure identically to a legitimate "not committed
// yet", quietly reintroducing the stale-read bug this function exists to close (sonnet-review
// finding, plan 2502) — so only the two absence shapes fall back; anything else propagates.
const PATH_ABSENT_AT_SHA_RX = /fatal: path '.*' (does not exist in|exists on disk, but not in)/;

/**
 * IO: read coord.config.json fresh from origin/master AT the given sha, via the same
 * `git show <sha>:<path>` shape resolvePlanAtOrigin/readAtOrigin use. Falls back to
 * loadCoordConfig(repoRoot)'s normal local read when sha is not available (the caller's own
 * origin resolution failed — no sha to pin against) or when coord.config.json doesn't exist
 * at that sha (a repo that hadn't committed the file yet at that point in history). Any OTHER
 * git-show failure, or malformed JSON content actually present at the sha, propagates rather
 * than silently falling back — mirrors loadCoordConfig's own fail-loud parse, and avoids
 * masking a real failure as a stale-but-harmless local read.
 */
export function loadCoordConfigAtOrigin(repoRoot, sha) {
  if (!sha) return loadCoordConfig(repoRoot);
  let content;
  try {
    content = git(repoRoot, ['show', `${sha}:coord.config.json`]);
  } catch (err) {
    if (PATH_ABSENT_AT_SHA_RX.test(err.message || '')) return loadCoordConfig(repoRoot);
    throw err;
  }
  return normalizeConfig(JSON.parse(content));
}

// --- CLAUDE_CONFIG_DIR resolution (plan 1643) --------------------------------
// The single seam for "which .claude config dir applies here" — orchestrator-budget.mjs,
// orchestrator-usage-refresh.mjs, orchestrate-dryrun.mjs, and claim-plan.mjs each used to
// hand-roll this decision independently; a future change to the fallback/candidate shape
// had to be hand-applied in four places with silent drift risk. Consume this instead.

/**
 * IO (reads env, not fs): ordered candidate config-dir paths, most-specific first —
 * $CLAUDE_CONFIG_DIR when set, then the ~/.claude fallback. claim-plan.mjs's doctrine-path
 * resolver probes these with existsSync (several config dirs may exist on one machine, one
 * per account, each chaining its own skills/ junction); most callers just want the
 * first entry, which is what resolveConfigDir() returns.
 */
export function configDirCandidates() {
  const candidates = [];
  if (process.env.CLAUDE_CONFIG_DIR) candidates.push(process.env.CLAUDE_CONFIG_DIR);
  candidates.push(join(homedir(), '.claude'));
  return candidates;
}

/** IO (reads env): the resolved config dir — $CLAUDE_CONFIG_DIR if set, else ~/.claude. */
export function resolveConfigDir() {
  return configDirCandidates()[0];
}
