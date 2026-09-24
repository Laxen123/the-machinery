// coord/scripts/coord-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
// plan 3961 T2.7c fix-now: a bare Windows path (e.g. under a non-C: drive scratch/worktree root)
// passed straight to a spawned child's dynamic `import()` throws ERR_UNSUPPORTED_ESM_URL_SCHEME —
// `import()` needs a real specifier, not a raw fs path. `pathToFileURL(...).href`, the same fix
// already applied in scripts/project/deploy.test.mjs.
import { pathToFileURL } from 'node:url';
// plan 3960 T3: the isolated-plan-repo scaffold writes NO coord.config.json — it already
// IS the "no config" case (verified below), so it is the vehicle for this file's own
// no-config acceptance test rather than a hand-rolled second temp-repo builder.
import { isolatedRepoFactory, runTool } from '../test-helpers/isolated-plan-repo.mjs';
import { seedScopeOf } from './done-worktree-lib.mjs';
import { readSeedMarker } from './build-index-lib.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';
import {
  normalizeConfig,
  loadCoordConfig,
  loadCoordConfigAtOrigin,
  derivePaths,
  LEGACY_PATHS,
  DEFAULTS,
  resolveConfigDir,
  configDirCandidates,
  DEFAULT_GIT_PAT_ENV_VAR,
  DEFAULT_CODEX_AUTH_ENV_VAR,
} from './coord-config.mjs';

// plan 3960 T1: today's exact vetapp-default shapes for the six new keys, restated here (not
// imported from DEFAULTS) so a drift in the source file's defaults fails THIS test rather than
// silently changing what "byte-identical to today" means.
// The RAW shape (DEFAULTS.lanes itself — no `statusOrder`, that field is a normalizeConfig-only
// derivation) and the NORMALIZED shape (normalizeConfig(...).lanes — carries `statusOrder`) are
// deliberately two different constants; conflating them would silently mask a missing/extra key
// on whichever side happens to lack it.
const DEFAULT_LANES_RAW_SHAPE = {
  inProgress: 'in-progress',
  ready: 'ready',
  pendingApproval: 'pending-approval',
  waitingBlocked: 'waiting-blocked',
  waitingOperator: 'waiting-operator',
  waitingGrill: 'waiting-grill',
  waitingDate: 'waiting-date',
  waitingTrip: 'waiting-trip',
  order: [
    'inProgress',
    'ready',
    'pendingApproval',
    'waitingBlocked',
    'waitingOperator',
    'waitingGrill',
    'waitingDate',
    'waitingTrip',
  ],
  archive: 'archive',
  parked: 'parked',
};
const DEFAULT_LANES_SHAPE = {
  ...DEFAULT_LANES_RAW_SHAPE,
  statusOrder: [
    'in-progress',
    'ready',
    'pending-approval',
    'waiting-blocked',
    'waiting-operator',
    'waiting-grill',
    'waiting-date',
    'waiting-trip',
  ],
};
const DEFAULT_LAND_SHAPE = {
  localTimeoutSeconds: 14400,
  // plan 3961 T2.7a: gateRoster is GONE — the once-per-land roster is derived from the land-gates
  // registry (registered preflight-stage prepGates), not a config key. See the refusal test below.
  // plan 3961 T2.6: a config-less repo's CONCLUSION_REVIEW landSeam guards NO fields — same
  // empty-default posture as deployServices (R1) — so the seam is a permanent no-op there.
  worldClaimFields: [],
  // plan 4071 D3: specReviewGatedFields is a SIBLING key to worldClaimFields, not a fold into
  // it — it guards the Gate 1/2 push/claim-time specReview flip, not the land-time
  // CONCLUSION_REVIEW overwrite seam. Same empty-default posture: a config-less repo's Gate 1/2
  // pipeline-field check is a permanent no-op.
  specReviewGatedFields: [],
  // plan 3961 T2.7b: the generic four coordination roots every repo using this spine's
  // plan/handoff machinery shares — `wiki/log.md` is vetapp-only content, added back in
  // vetapp's OWN coord.config.json (see the vetapp pin test below).
  coordinationOnlyPathPrefixes: [
    'docs/handoff/',
    'docs/superpowers/plans/',
    'docs/superpowers/batches/',
    '.drain-status/',
    'docs/INDEX.md',
  ],
  // plan 3961 T2.7b: a config-less repo has no memory-reclaim script — teardown skips the step.
  worktreeMemoryReclaimScript: null,
  // plan 3961 review fix: a config-less repo has no build gate — the core `build` preflight
  // gate no-ops to a real green instead of naming a project package.
  buildCommand: null,
  // plan 4096 T5: a config-less repo configures no typecheck gate — the push battery says so in
  // one line instead of naming a pnpm workspace it does not have.
  typecheckCommands: [],
};

// plan 4071 D1/D2: today's exact vetapp-default shapes for the plan-4071 keys, restated here for
// the same reason DEFAULT_LANES_SHAPE/DEFAULT_LAND_SHAPE are above — a drift in the source
// file's defaults must fail THIS test, not silently change what "byte-identical to today" means.
const DEFAULT_PLAN_CATEGORIES_SHAPE = { allowlist: [], evidenceGated: [] };
const DEFAULT_PLAN_NAMING_SHAPE = {
  countryTokenHints: [],
  stageTokens: { category: null, tokens: [] },
};
const DEFAULT_PYTEST_SELECTOR_SHAPE = { prefix: null, script: null };

test('normalizeConfig: agnostic defaults when raw is null', () => {
  const c = normalizeConfig(null);
  assert.deepEqual(c, {
    seedLaneFile: null,
    seedShardDir: null,
    derivedShardDirs: [],
    derivedGlobalFiles: [],
    // plan 3962 P1: a config-less repo has no job-output tree, no project-specific
    // battery-scoping bail-out prefixes, no data-dependency rows, and no extra cloud-drain
    // repo registry.
    jobOutputPrefixes: [],
    externalTreePrefixes: [],
    dataDependencyMap: {},
    cloudRepos: [],
    handoffLayout: 'single',
    seedLane: false,
    handoffDir: null,
    paths: { ...LEGACY_PATHS },
    // R1 (operator grill ruling, 2026-09-13): a config-less repo gets an EMPTY deploy table —
    // the generic core carries no knowledge of any project's production deploy graph. vetapp's
    // own eight rows now live in vetapp's OWN coord.config.json (see the
    // "loadCoordConfig(vetapp repo root): deployServices" test below for the plan-3082 guard).
    deployServices: [],
    // plan 4071: CORE default is now null ("no sharded records") — same posture as seedShardDir.
    // vetapp's own pattern is an explicit row in vetapp's coord.config.json (see the guard test
    // below).
    shardIdPattern: null,
    scopeMaxKeys: 500,
    // plan 4069 review round 2: the operator's per-plan drain spend ceiling, now normalized
    // through this loader instead of a second ad-hoc fs/JSON.parse read in drain-run.mjs.
    operatorSpendCeilingUsd: 5,
    // plan 4071: CORE default is now the neutral DATA-WRITE/--data-write pair — vetapp's own
    // SEED-WRITE/--seed-write row is unaffected (already an explicit row in coord.config.json).
    mutationBanner: { label: 'DATA-WRITE', flag: '--data-write' },
    lanes: DEFAULT_LANES_SHAPE,
    land: DEFAULT_LAND_SHAPE,
    // plan 3961 T1: a config-less repo registers NO land plugins — same posture, and the same
    // reason, as deployServices above: the generic core inherits no project's steps by default.
    plugins: {},
    // plan 4071: the vetapp literals INSIDE scripts/coord/** — every one of them empty/null in a
    // config-less repo, same R1 posture as deployServices/worldClaimFields/plugins above.
    coordCheckoutExcludedTopLevel: [],
    planWorktreeExcludedPaths: [],
    reviewDiffExcludes: [],
    batteryScopedPrefixes: [],
    localHostDenylist: [],
    wikiSubjectPatterns: [],
    planCategories: DEFAULT_PLAN_CATEGORIES_SHAPE,
    planNaming: DEFAULT_PLAN_NAMING_SHAPE,
    pytestSelector: DEFAULT_PYTEST_SELECTOR_SHAPE,
    gates: {},
    // plan 3958 — generic, unclaimed env-var-name defaults (see the loadCoordConfig test below).
    gitPatEnvVar: 'GIT_PUSH_TOKEN',
    codexAuthEnvVar: 'CODEX_LOGIN_B64',
  });
});

// --- plan 3960 T1: the six new config keys ------------------------------------------------

test('normalizeConfig: deployServices defaults to DEFAULTS.deployServices and validates shape', () => {
  assert.equal(normalizeConfig(null).deployServices, DEFAULTS.deployServices);
  assert.throws(() => normalizeConfig({ deployServices: 'nope' }), /must be an array/);
  assert.throws(
    () =>
      normalizeConfig({
        deployServices: [{ platform: 'railway', market: 'SE', role: 'frontend' }],
      }),
    /missing a non-empty "name"/,
  );
  assert.throws(
    () => normalizeConfig({ deployServices: [{ name: 'x', market: 'SE', role: 'frontend' }] }),
    /missing a non-empty "platform"/,
  );
  assert.throws(
    () =>
      normalizeConfig({ deployServices: [{ name: 'x', platform: 'railway', role: 'frontend' }] }),
    /missing the "market" key/,
  );
  assert.throws(
    () => normalizeConfig({ deployServices: [{ name: 'x', platform: 'railway', market: null }] }),
    /missing a non-empty "role"/,
  );
  // market: null is a VALID value (a backend serving every market) — only an absent key throws.
  assert.doesNotThrow(() =>
    normalizeConfig({
      deployServices: [{ name: 'x', platform: 'railway', market: null, role: 'backend' }],
    }),
  );
});

// plan 3962 P1: three more vetapp-hardcoded constants moved behind this seam.
test('normalizeConfig: jobOutputPrefixes/externalTreePrefixes default to [] and normalize slashes without stripping trailing "/"', () => {
  assert.deepEqual(normalizeConfig(null).jobOutputPrefixes, []);
  assert.deepEqual(normalizeConfig(null).externalTreePrefixes, []);
  assert.deepEqual(
    normalizeConfig({ jobOutputPrefixes: ['backend\\data\\price-pipeline/'] }).jobOutputPrefixes,
    ['backend/data/price-pipeline/'],
  );
  assert.deepEqual(normalizeConfig({ externalTreePrefixes: ['backend/'] }).externalTreePrefixes, [
    'backend/',
  ]);
  assert.throws(
    () => normalizeConfig({ jobOutputPrefixes: 'nope' }),
    /must be an array of repo-relative paths/,
  );
  assert.throws(() => normalizeConfig({ jobOutputPrefixes: [''] }), /empty\/non-string entry/);
});

test('normalizeConfig: dataDependencyMap defaults to {} and validates row shape', () => {
  assert.deepEqual(normalizeConfig(null).dataDependencyMap, {});
  assert.throws(
    () => normalizeConfig({ dataDependencyMap: 'nope' }),
    /must be an object keyed by test basename/,
  );
  assert.throws(
    () => normalizeConfig({ dataDependencyMap: { 'x.test.mjs': 'not-an-array' } }),
    /must be an array of globs/,
  );
  assert.throws(
    () => normalizeConfig({ dataDependencyMap: { 'x.test.mjs': [''] } }),
    /empty\/non-string glob/,
  );
  assert.deepEqual(
    normalizeConfig({ dataDependencyMap: { 'x.test.mjs': ['a\\b/**'] } }).dataDependencyMap,
    { 'x.test.mjs': ['a/b/**'] },
  );
});

// plan 3962 P1: vetapp's coord.config.json rows for externalTreePrefixes/dataDependencyMap must
// reproduce select-battery-tests.mjs's former hardcoded 'backend/' entry and
// 'wiki-loader-coverage.test.mjs' row exactly — a byte-identical-behavior guard, same intent as
// the "loadCoordConfig(vetapp repo root): deployServices" test below.
// ── plan 4071: the vetapp literals INSIDE scripts/coord/** ────────────────────────────────────
// coordCheckoutExcludedTopLevel / planWorktreeExcludedPaths / reviewDiffExcludes: the same
// normList shape as derivedShardDirs above (trailing slash stripped — these name directory-ish
// paths, matched at path-component boundaries).

test('normalizeConfig: coordCheckoutExcludedTopLevel defaults to [] and normalizes like derivedShardDirs', () => {
  assert.deepEqual(normalizeConfig(null).coordCheckoutExcludedTopLevel, []);
  assert.deepEqual(
    normalizeConfig({ coordCheckoutExcludedTopLevel: ['backend', 'frontend/'] })
      .coordCheckoutExcludedTopLevel,
    ['backend', 'frontend'],
  );
  assert.throws(
    () => normalizeConfig({ coordCheckoutExcludedTopLevel: 'backend' }),
    /must be an array of repo-relative paths/,
  );
  assert.throws(
    () => normalizeConfig({ coordCheckoutExcludedTopLevel: [''] }),
    /empty\/non-string entry/,
  );
});

test('normalizeConfig: planWorktreeExcludedPaths defaults to [] and validates shape', () => {
  assert.deepEqual(normalizeConfig(null).planWorktreeExcludedPaths, []);
  assert.deepEqual(
    normalizeConfig({
      planWorktreeExcludedPaths: ['backend\\data\\price-pipeline\\render-store/'],
    }).planWorktreeExcludedPaths,
    ['backend/data/price-pipeline/render-store'],
  );
  assert.throws(
    () => normalizeConfig({ planWorktreeExcludedPaths: [42] }),
    /empty\/non-string entry/,
  );
});

test('normalizeConfig: reviewDiffExcludes defaults to [] (module keeps output/pnpm-lock.yaml generic) and validates shape', () => {
  assert.deepEqual(normalizeConfig(null).reviewDiffExcludes, []);
  assert.deepEqual(normalizeConfig({ reviewDiffExcludes: ['backend/data/'] }).reviewDiffExcludes, [
    'backend/data',
  ]);
  assert.throws(() => normalizeConfig({ reviewDiffExcludes: [''] }), /empty\/non-string entry/);
});

// batteryScopedPrefixes / localHostDenylist are matched by prefix/exact-string, so — like
// jobOutputPrefixes/externalTreePrefixes above — a trailing slash is NEVER stripped.

test('normalizeConfig: batteryScopedPrefixes defaults to [] (module keeps wiki/ generic) and never strips a trailing slash', () => {
  assert.deepEqual(normalizeConfig(null).batteryScopedPrefixes, []);
  assert.deepEqual(
    normalizeConfig({ batteryScopedPrefixes: ['backend\\'] }).batteryScopedPrefixes,
    ['backend/'],
  );
  assert.throws(() => normalizeConfig({ batteryScopedPrefixes: [''] }), /empty\/non-string entry/);
});

// plan 4096 T2: wikiSubjectPatterns[] — the wiki checkpoint's subject-path list, as regex SOURCE
// strings. Validated by COMPILING each entry here rather than at the point of use: a bad pattern
// is a config error, and deferring it surfaces as an opaque SyntaxError from inside the land's
// wiki checkpoint, naming neither the key nor the offending row.
test('normalizeConfig: wikiSubjectPatterns defaults to [] and compiles every entry (plan 4096 T2)', () => {
  assert.deepEqual(normalizeConfig(null).wikiSubjectPatterns, []);
  assert.deepEqual(normalizeConfig({ wikiSubjectPatterns: ['^a/', '^b/'] }).wikiSubjectPatterns, [
    '^a/',
    '^b/',
  ]);
  assert.throws(() => normalizeConfig({ wikiSubjectPatterns: 'nope' }), /must be an array/);
  assert.throws(() => normalizeConfig({ wikiSubjectPatterns: [123] }), /non-string or empty entry/);
  assert.throws(
    () => normalizeConfig({ wikiSubjectPatterns: ['  '] }),
    /non-string or empty entry/,
  );
  // The whole point of compiling at load: an unbalanced group is named here, with its key.
  assert.throws(
    () => normalizeConfig({ wikiSubjectPatterns: ['^a(['] }),
    /wikiSubjectPatterns entry .* is not a valid regular expression/,
  );
});

test('normalizeConfig: localHostDenylist defaults to [] and validates shape (plan 4071 D4)', () => {
  assert.deepEqual(normalizeConfig(null).localHostDenylist, []);
  assert.deepEqual(normalizeConfig({ localHostDenylist: ['SOME-HOST'] }).localHostDenylist, [
    'SOME-HOST',
  ]);
  assert.throws(() => normalizeConfig({ localHostDenylist: 'nope' }), /must be an array/);
  // plan 4071 review round 2 (key 94827c): localHostDenylist is normalized BESPOKE, not
  // through the shared `normList` above, so an empty entry is DROPPED rather than throwing
  // like normList's path-list siblings do -- a stray blank in a hostname denylist is paste
  // noise, not a config error worth failing the whole load over.
  assert.deepEqual(normalizeConfig({ localHostDenylist: [''] }).localHostDenylist, []);
});

// plan 4071 review round 3 (key 30957d): a non-string entry (e.g. `[123]`) used to be
// silently FILTERED OUT by a `.filter((h) => typeof h === 'string')` step, so a malformed
// config like `{"localHostDenylist":[123]}` collapsed to `[]` -- an empty denylist that,
// combined with guard 2's cloud signal and the destructive opt-in, let the local-master
// discard guard's guard 3 skip its refusal entirely on the operator's own machine. A
// malformed entry must be a loud config error, never an empty list.
test('normalizeConfig: localHostDenylist throws on a non-string entry instead of silently dropping it (plan 4071 review round 3, key 30957d)', () => {
  assert.throws(
    () => normalizeConfig({ localHostDenylist: [123] }),
    /localHostDenylist has a non-string entry/,
  );
  assert.throws(
    () => normalizeConfig({ localHostDenylist: ['SOME-HOST', null] }),
    /localHostDenylist has a non-string entry/,
  );
  // A genuinely blank STRING entry is still dropped, not a type error -- only a non-string
  // element throws.
  assert.deepEqual(normalizeConfig({ localHostDenylist: ['   '] }).localHostDenylist, []);
});

// plan 4071 review round 2 (key 94827c): localHostDenylist entries are TRIMMED as well as
// uppercased -- a config entry with stray whitespace (a paste artifact, e.g.
// `" BUILD-HOST-01"`) must still match the bare hostname the comparison side never pads.
// A whitespace-only entry must be DROPPED after trimming, not kept as `''` (which would be
// harmless on its own, but the drop is what guarantees a malformed row like `["", "  "]`
// can never silently expand into something that reads as a working denylist).
test('normalizeConfig: localHostDenylist entries are trimmed, and a whitespace-only entry is dropped rather than kept (plan 4071 review round 2)', () => {
  assert.deepEqual(
    normalizeConfig({ localHostDenylist: [' BUILD-HOST-01 '] }).localHostDenylist,
    ['BUILD-HOST-01'],
    'a padded entry must still match the bare hostname',
  );
  assert.deepEqual(
    normalizeConfig({ localHostDenylist: ['\tsome-host\n'] }).localHostDenylist,
    ['SOME-HOST'],
    'mixed whitespace + case must both be normalized away',
  );
  assert.deepEqual(
    normalizeConfig({ localHostDenylist: ['   '] }).localHostDenylist,
    [],
    'a whitespace-only entry must be dropped, never survive as an empty string that could ' +
      'be mistaken for "matches everything"',
  );
  assert.deepEqual(
    normalizeConfig({ localHostDenylist: ['  ', 'SOME-HOST', ''] }).localHostDenylist,
    ['SOME-HOST'],
    'blank entries are dropped while a real entry among them survives',
  );
});

// plan 4071 review round 1: a lowercase (or mixed-case) config entry used to survive this
// normalizer unchanged while every comparison site (cloud-checkout-preflight.mjs's guard 3,
// landing-queue-board.mjs's originLabel) uppercases the HOST side — so it silently never
// matched. Hostnames are case-insensitive: the normalizer now uppercases every entry
// regardless of how it was spelled in coord.config.json, and an already-empty list must stay
// empty (default-deny is a property of the list being empty, not of any casing rule).
test('normalizeConfig: localHostDenylist entries are uppercased regardless of the spelling in coord.config.json (plan 4071 review round 1)', () => {
  assert.deepEqual(normalizeConfig({ localHostDenylist: ['some-host'] }).localHostDenylist, [
    'SOME-HOST',
  ]);
  assert.deepEqual(normalizeConfig({ localHostDenylist: ['Some-Host'] }).localHostDenylist, [
    'SOME-HOST',
  ]);
  assert.deepEqual(
    normalizeConfig({ localHostDenylist: ['SOME-HOST', 'other-host'] }).localHostDenylist,
    ['SOME-HOST', 'OTHER-HOST'],
  );
  assert.deepEqual(normalizeConfig(null).localHostDenylist, [], 'empty list stays empty');
});

test('loadCoordConfig: localHostDenylist round-trips a coord.config.json value exactly (plan 4071 D4 guard)', () => {
  // This module ships as-is into the public coord-kit (scripts/coord/ is copied wholesale), so
  // this shipped core test must not pin THIS project's own coord.config.json value — that would
  // be false in any other repo (including the kit itself, whose coord.config.json carries no
  // localHostDenylist at all). Write a throwaway fixture config instead and assert the loader
  // reproduces it byte-for-byte, which is the actual property this guard is checking.
  const root = mkdtempSync(join(tmpdir(), 'coordcfg-hostdenylist-'));
  writeFileSync(
    join(root, 'coord.config.json'),
    JSON.stringify({ localHostDenylist: ['WORKSTATION-A1'] }), // personal-data-ok: fixture
  );
  const cfg = loadCoordConfig(root);
  assert.deepEqual(cfg.localHostDenylist, ['WORKSTATION-A1']); // personal-data-ok: fixture
  rmSync(root, { recursive: true, force: true });
});

// planCategories.allowlist/evidenceGated: D1 — allowlist empty means ALLOW ALL, not reject-all.

test('normalizeConfig: planCategories defaults to {allowlist:[],evidenceGated:[]} (D1 — empty allowlist means allow ALL) and validates shape', () => {
  assert.deepEqual(normalizeConfig(null).planCategories, { allowlist: [], evidenceGated: [] });
  assert.deepEqual(normalizeConfig({}).planCategories, { allowlist: [], evidenceGated: [] });
  assert.deepEqual(normalizeConfig({ planCategories: { allowlist: ['Coord'] } }).planCategories, {
    allowlist: ['Coord'],
    evidenceGated: [],
  });
  assert.throws(
    () => normalizeConfig({ planCategories: 'nope' }),
    /planCategories must be an object/,
  );
  assert.throws(
    () => normalizeConfig({ planCategories: { allowlist: 'nope' } }),
    /planCategories\.allowlist must be an array/,
  );
  assert.throws(
    () => normalizeConfig({ planCategories: { allowlist: [''] } }),
    /planCategories\.allowlist has an empty\/non-string entry/,
  );
  assert.throws(
    () => normalizeConfig({ planCategories: { allowlist: ['Coord', 'Coord'] } }),
    /planCategories\.allowlist lists "Coord" more than once/,
  );
  assert.throws(
    () => normalizeConfig({ planCategories: { evidenceGated: [42] } }),
    /planCategories\.evidenceGated has an empty\/non-string entry/,
  );
});

// planNaming.countryTokenHints[] / planNaming.stageTokens: advisory plan-rename lints.

test('normalizeConfig: planNaming defaults to empty hints + null-category stageTokens and validates shape', () => {
  assert.deepEqual(normalizeConfig(null).planNaming, {
    countryTokenHints: [],
    stageTokens: { category: null, tokens: [] },
  });
  assert.deepEqual(
    normalizeConfig({ planNaming: { countryTokenHints: [{ token: 'gb', code: 'uk' }] } })
      .planNaming,
    {
      countryTokenHints: [{ token: 'gb', code: 'uk' }],
      stageTokens: { category: null, tokens: [] },
    },
  );
  assert.throws(() => normalizeConfig({ planNaming: 'nope' }), /planNaming must be an object/);
  assert.throws(
    () => normalizeConfig({ planNaming: { countryTokenHints: 'nope' } }),
    /countryTokenHints must be an array of rows/,
  );
  assert.throws(
    () => normalizeConfig({ planNaming: { countryTokenHints: [{ code: 'uk' }] } }),
    /missing a non-empty "token"/,
  );
  assert.throws(
    () => normalizeConfig({ planNaming: { countryTokenHints: [{ token: 'gb' }] } }),
    /missing a non-empty "code"/,
  );
  assert.throws(
    () =>
      normalizeConfig({
        planNaming: {
          countryTokenHints: [
            { token: 'gb', code: 'uk' },
            { token: 'gb', code: 'ie' },
          ],
        },
      }),
    /lists token "gb" more than once/,
  );
  assert.throws(
    () => normalizeConfig({ planNaming: { stageTokens: 'nope' } }),
    /stageTokens must be an object/,
  );
  assert.throws(
    () => normalizeConfig({ planNaming: { stageTokens: { category: '' } } }),
    /stageTokens\.category must be null or a non-empty string/,
  );
  assert.throws(
    () => normalizeConfig({ planNaming: { stageTokens: { tokens: 'nope' } } }),
    /stageTokens\.tokens must be an array of strings/,
  );
  assert.throws(
    () => normalizeConfig({ planNaming: { stageTokens: { tokens: [''] } } }),
    /stageTokens\.tokens has an empty\/non-string entry/,
  );
});

// pytestSelector.{prefix,script}: battery-ledger.mjs's land-tier pytest selector (plan 4071 E-A).

test('normalizeConfig: pytestSelector defaults to {prefix:null,script:null} and validates shape', () => {
  assert.deepEqual(normalizeConfig(null).pytestSelector, { prefix: null, script: null });
  assert.deepEqual(
    normalizeConfig({ pytestSelector: { prefix: 'backend/scripts/' } }).pytestSelector,
    { prefix: 'backend/scripts/', script: null },
  );
  assert.throws(
    () => normalizeConfig({ pytestSelector: 'nope' }),
    /pytestSelector must be an object/,
  );
  assert.throws(
    () => normalizeConfig({ pytestSelector: { prefix: '' } }),
    /pytestSelector\.prefix must be null or a non-empty string/,
  );
  assert.throws(
    () => normalizeConfig({ pytestSelector: { script: 42 } }),
    /pytestSelector\.script must be null or a non-empty string/,
  );
});

// gates{}: gate-pass-cache.mjs's whole GATES registry (plan 4071 T4/D5 — the big one). Shape/type
// validation only here; a `{}` default must degrade to "no gate is cacheable" everywhere a
// consumer reads this key correctly — see E-B for the crash hazard this shape exists to avoid.

test('normalizeConfig: gates defaults to {} and validates row shape (plan 4071 T4/D5)', () => {
  assert.deepEqual(normalizeConfig(null).gates, {});
  assert.deepEqual(
    normalizeConfig({ gates: { foo: { desc: 'run foo', paths: ['a', 'b'] } } }).gates,
    { foo: { desc: 'run foo', paths: ['a', 'b'] } },
  );
  assert.deepEqual(
    normalizeConfig({
      gates: {
        foo: {
          desc: 'run foo',
          paths: ['a'],
          envUncacheable: ['a/.env.local'],
          probe: 'mobile-required',
          probeScript: 'a/probe.mjs',
        },
      },
    }).gates,
    {
      foo: {
        desc: 'run foo',
        paths: ['a'],
        envUncacheable: ['a/.env.local'],
        probe: 'mobile-required',
        probeScript: 'a/probe.mjs',
      },
    },
  );
  assert.throws(() => normalizeConfig({ gates: 'nope' }), /must be an object keyed by gate name/);
  assert.throws(
    () => normalizeConfig({ gates: { foo: 'nope' } }),
    /gates\["foo"\] must be an object/,
  );
  assert.throws(
    () => normalizeConfig({ gates: { foo: { paths: ['a'] } } }),
    /gates\["foo"\] is missing a non-empty "desc"/,
  );
  assert.throws(
    () => normalizeConfig({ gates: { foo: { desc: 'x', paths: 'a' } } }),
    /gates\["foo"\]\.paths must be an array of paths/,
  );
  assert.throws(
    () => normalizeConfig({ gates: { foo: { desc: 'x', paths: [''] } } }),
    /gates\["foo"\]\.paths has an empty\/non-string entry/,
  );
  assert.throws(
    () => normalizeConfig({ gates: { foo: { desc: 'x', paths: ['a'], envUncacheable: 'nope' } } }),
    /gates\["foo"\]\.envUncacheable must be an array of paths/,
  );
  assert.throws(
    () => normalizeConfig({ gates: { foo: { desc: 'x', paths: ['a'], probe: '' } } }),
    /gates\["foo"\]\.probe must be a non-empty string/,
  );
  assert.throws(
    () => normalizeConfig({ gates: { foo: { desc: 'x', paths: ['a'], probeScript: 42 } } }),
    /gates\["foo"\]\.probeScript must be a non-empty string/,
  );
});

test('normalizeConfig: cloudRepos defaults to [] and validates row shape', () => {
  assert.deepEqual(normalizeConfig(null).cloudRepos, []);
  assert.throws(() => normalizeConfig({ cloudRepos: 'nope' }), /cloudRepos must be an array/);
  assert.throws(
    () => normalizeConfig({ cloudRepos: [{ url: 'x', dir: 'x', tokenEnv: 'X' }] }),
    /missing a non-empty "key"/,
  );
  assert.throws(
    () =>
      normalizeConfig({
        cloudRepos: [
          { key: 'a', url: 'x', dir: 'x', tokenEnv: 'X' },
          { key: 'a', url: 'y', dir: 'y', tokenEnv: 'Y' },
        ],
      }),
    /lists key "a" more than once/,
  );
  assert.deepEqual(
    normalizeConfig({
      cloudRepos: [{ key: 'hobby-main', url: 'https://x', dir: 'x', tokenEnv: 'TEST_GIT_PAT' }],
    }).cloudRepos,
    [{ key: 'hobby-main', url: 'https://x', dir: 'x', tokenEnv: 'TEST_GIT_PAT', note: '' }],
  );
});

test('normalizeConfig: shardIdPattern defaults to null (plan 4071) and validates compilability and exactly one capture group', () => {
  // plan 4071: CORE default is now null ("no sharded records"), the same contract seedShardDir
  // already has — a config-less repo has no per-clinic shard filename shape.
  assert.equal(normalizeConfig(null).shardIdPattern, null);
  assert.equal(normalizeConfig({}).shardIdPattern, null);
  assert.equal(normalizeConfig({ shardIdPattern: null }).shardIdPattern, null);
  assert.equal(
    normalizeConfig({ shardIdPattern: 'pets/[A-Z]{3}/(pet-\\d+)\\.json' }).shardIdPattern,
    'pets/[A-Z]{3}/(pet-\\d+)\\.json',
  );
  assert.throws(
    () => normalizeConfig({ shardIdPattern: '' }),
    /must be null or a non-empty string/,
  );
  assert.throws(() => normalizeConfig({ shardIdPattern: '(unterminated' }), /does not compile/);
  // zero capture groups
  assert.throws(
    () => normalizeConfig({ shardIdPattern: 'clinics/[A-Z]{2}/clinic-\\d+\\.json' }),
    /exactly one capture group/,
  );
  // two capture groups
  assert.throws(
    () => normalizeConfig({ shardIdPattern: 'clinics/([A-Z]{2})/(clinic-\\d+)\\.json' }),
    /exactly one capture group/,
  );
  // non-capturing group + lookaround don't count as capturing
  assert.doesNotThrow(() =>
    normalizeConfig({ shardIdPattern: '(?:clinics)/[A-Z]{2}/(clinic-\\d+)(?=\\.json)' }),
  );
  // a named capturing group DOES count
  assert.throws(
    () =>
      normalizeConfig({
        shardIdPattern: 'clinics/(?<cc>[A-Z]{2})/(clinic-\\d+)\\.json',
      }),
    /exactly one capture group/,
  );
});

// plan 4071: vetapp's coord.config.json must carry an explicit shardIdPattern row reproducing
// the pattern the core used to hardcode as DEFAULT_SHARD_ID_PATTERN, now that the core default
// is null — a silent drop of this row would put every shard consumer back on "no shard layout".
test('normalizeConfig: scopeMaxKeys defaults to 500 and validates a positive integer', () => {
  assert.equal(normalizeConfig(null).scopeMaxKeys, 500);
  assert.equal(normalizeConfig({ scopeMaxKeys: 30 }).scopeMaxKeys, 30);
  assert.throws(() => normalizeConfig({ scopeMaxKeys: 0 }), /positive integer/);
  assert.throws(() => normalizeConfig({ scopeMaxKeys: -1 }), /positive integer/);
  assert.throws(() => normalizeConfig({ scopeMaxKeys: 1.5 }), /positive integer/);
  assert.throws(() => normalizeConfig({ scopeMaxKeys: 'many' }), /positive integer/);
});

test('normalizeConfig: operatorSpendCeilingUsd defaults to 5 and accepts only a finite positive number (plan 4069 review round 2)', () => {
  assert.equal(normalizeConfig(null).operatorSpendCeilingUsd, 5);
  assert.equal(normalizeConfig({ operatorSpendCeilingUsd: 100 }).operatorSpendCeilingUsd, 100);
  // absent key ⇒ default, never a throw
  assert.equal(normalizeConfig({}).operatorSpendCeilingUsd, 5);
  // malformed / non-positive all silently fall back — this is a soft safety knob, not a
  // structural config error, so (unlike scopeMaxKeys) none of these throw.
  for (const bad of ['100', 0, -5, null, undefined, NaN, Infinity, {}, []]) {
    assert.equal(
      normalizeConfig({ operatorSpendCeilingUsd: bad }).operatorSpendCeilingUsd,
      5,
      JSON.stringify(bad),
    );
  }
});

test('normalizeConfig: mutationBanner.label defaults to the neutral DATA-WRITE (plan 4071) and validates non-empty', () => {
  // plan 4071: CORE default is now the project-neutral DATA-WRITE/--data-write pair — vetapp's
  // own SEED-WRITE/--seed-write row is an explicit override, guarded separately below.
  assert.deepEqual(normalizeConfig(null).mutationBanner, {
    label: 'DATA-WRITE',
    flag: '--data-write',
  });
  assert.deepEqual(normalizeConfig({ mutationBanner: { label: 'SEED-WRITE' } }).mutationBanner, {
    label: 'SEED-WRITE',
    flag: '--data-write',
  });
  assert.throws(
    () => normalizeConfig({ mutationBanner: { label: '' } }),
    /mutationBanner.label must be a non-empty string/,
  );
});

// plan 3961 T3.1a: the flag counterpart, given the equivalent coverage as label above — a
// CONFIGURED flag is what the carry-forward minter would pass to `next-plan-id.mjs claim`.
test('normalizeConfig: mutationBanner.flag defaults to the neutral --data-write (plan 4071) and validates non-empty', () => {
  assert.deepEqual(normalizeConfig(null).mutationBanner, {
    label: 'DATA-WRITE',
    flag: '--data-write',
  });
  assert.deepEqual(normalizeConfig({ mutationBanner: { flag: '--seed-write' } }).mutationBanner, {
    label: 'DATA-WRITE',
    flag: '--seed-write',
  });
  assert.throws(
    () => normalizeConfig({ mutationBanner: { flag: '' } }),
    /mutationBanner.flag must be a non-empty string/,
  );
});

// plan 4071: vetapp's coord.config.json already carried an explicit mutationBanner row before
// this plan (plan 3961 T3.1a) — this guard proves the core's default-neutralization did not
// silently change vetapp's own behaviour.
test("normalizeConfig: land.localTimeoutSeconds defaults to today's value", () => {
  const c = normalizeConfig(null);
  assert.equal(c.land.localTimeoutSeconds, 14400);
  assert.throws(
    () => normalizeConfig({ land: { localTimeoutSeconds: 0 } }),
    /localTimeoutSeconds must be a positive integer/,
  );
  // a partial override (one field only) keeps the OTHER fields' defaults (shallow-merge-like)
  assert.deepEqual(normalizeConfig({ land: { localTimeoutSeconds: 999 } }).land, {
    ...DEFAULT_LAND_SHAPE,
    localTimeoutSeconds: 999,
  });
});

// plan 3961 T2.7a: land.gateRoster is GONE as a config key — the once-per-land gate roster is
// derived from the land-gates registry (registered preflight-stage prepGates) instead. A config
// that still sets it is refused rather than silently ignored, so a repo carrying the stale key
// from before this plan gets a loud pointer to delete it instead of a config value that quietly
// stops doing anything.
test('normalizeConfig: land.gateRoster is refused as a config key (plan 3961 T2.7a)', () => {
  assert.throws(
    () => normalizeConfig({ land: { gateRoster: ['build'] } }),
    /land\.gateRoster is no longer a config key.*plan 3961 T2\.7a/,
  );
  assert.throws(
    () => normalizeConfig({ land: { gateRoster: [] } }),
    /land\.gateRoster is no longer a config key/,
  );
});

// plan 3961 T2 review (key ed6e7d): `normalizeLand` used to merge ANY `land` value over
// DEFAULT_LAND via `{ ...DEFAULT_LAND, ...(raw || {}) }` — spreading a non-object's own
// enumerable keys (a string's numeric indices, an array's none) is never the intended shape, so
// `land: "oops"` or `land: []` silently fell back to every land default (worldClaimFields: []
// included), disabling the conclusion-review gate with no error at all. null/undefined still
// mean "use every default" and must NOT be refused.
test('normalizeConfig: a malformed non-object land value is refused, not silently defaulted (plan 3961 review ed6e7d)', () => {
  assert.throws(
    () => normalizeConfig({ land: 'oops' }),
    /coord-config: land must be an object \(got string\)/,
  );
  assert.throws(
    () => normalizeConfig({ land: ['oops'] }),
    /coord-config: land must be an object \(got an array\)/,
  );
  assert.throws(
    () => normalizeConfig({ land: 42 }),
    /coord-config: land must be an object \(got number\)/,
  );
  assert.deepEqual(normalizeConfig({ land: null }).land, DEFAULT_LAND_SHAPE);
  assert.deepEqual(normalizeConfig({ land: undefined }).land, DEFAULT_LAND_SHAPE);
  assert.deepEqual(normalizeConfig({}).land, DEFAULT_LAND_SHAPE);
});

// plan 3961 T2.6/D2: land.worldClaimFields — the CONCLUSION_REVIEW landSeam's guarded field
// list, moved OUT of done-worktree-lib.mjs's WORLD_CLAIM_FIELDS constant and into configuration.
// Default empty (a config-less repo's conclusion-review seam is a permanent no-op); vetapp's own
// coord.config.json carries the historical five (see the "loadCoordConfig(vetapp repo root):
// land.worldClaimFields" test below, the plan-2033 guard mirroring the deployServices/plan-3082
// one above).
test('normalizeConfig: land.worldClaimFields defaults to empty and validates shape', () => {
  assert.deepEqual(normalizeConfig(null).land.worldClaimFields, []);
  assert.deepEqual(
    normalizeConfig({ land: { worldClaimFields: ['operationalStatus'] } }).land.worldClaimFields,
    ['operationalStatus'],
  );
  // a partial override keeps localTimeoutSeconds at its default
  assert.deepEqual(normalizeConfig({ land: { worldClaimFields: ['operationalStatus'] } }).land, {
    ...DEFAULT_LAND_SHAPE,
    worldClaimFields: ['operationalStatus'],
  });
  assert.throws(
    () => normalizeConfig({ land: { worldClaimFields: 'operationalStatus' } }),
    /land\.worldClaimFields must be an array/,
  );
  assert.throws(
    () => normalizeConfig({ land: { worldClaimFields: [''] } }),
    /land\.worldClaimFields has an empty\/non-string entry/,
  );
  assert.throws(
    () => normalizeConfig({ land: { worldClaimFields: [1] } }),
    /land\.worldClaimFields has an empty\/non-string entry/,
  );
  assert.throws(
    () =>
      normalizeConfig({
        land: { worldClaimFields: ['operationalStatus', 'operationalStatus'] },
      }),
    /land\.worldClaimFields lists "operationalStatus" more than once/,
  );
});

// plan 3961 T2 review (key a71dfc): a whitespace-padded entry like `" operationalStatus"` used
// to pass the empty/non-string check unchanged (only `.trim()` was tested for TRUTHINESS, the
// untrimmed value was kept), so `findWorldClaimFlips` read `prev[" operationalStatus"]` — always
// `undefined` on both sides — and a real `operationalStatus` overwrite went unflagged. Config is
// exact: a padded entry is REFUSED, never silently trimmed for the caller.
test('normalizeConfig: land.worldClaimFields refuses a whitespace-padded entry rather than silently accepting it (plan 3961 review a71dfc)', () => {
  assert.throws(
    () => normalizeConfig({ land: { worldClaimFields: [' operationalStatus'] } }),
    /land\.worldClaimFields has a whitespace-padded entry: " operationalStatus"/,
  );
  assert.throws(
    () => normalizeConfig({ land: { worldClaimFields: ['operationalStatus '] } }),
    /land\.worldClaimFields has a whitespace-padded entry: "operationalStatus "/,
  );
  assert.throws(
    () => normalizeConfig({ land: { worldClaimFields: ['\toperationalStatus\n'] } }),
    /land\.worldClaimFields has a whitespace-padded entry/,
  );
  // the clean, untrimmed-equal form is still accepted
  assert.deepEqual(
    normalizeConfig({ land: { worldClaimFields: ['operationalStatus'] } }).land.worldClaimFields,
    ['operationalStatus'],
  );
});

// plan 4071 D3: land.specReviewGatedFields is a SIBLING key to worldClaimFields — same shape
// validation (non-empty, no whitespace padding, no duplicates), but it guards the Gate 1/2
// push/claim-time specReview flip, not the land-time CONCLUSION_REVIEW overwrite seam. Folding it
// into worldClaimFields would widen Gate 1 from two fields to five, a behaviour change.
test('normalizeConfig: land.specReviewGatedFields defaults to empty and validates shape (plan 4071 D3)', () => {
  assert.deepEqual(normalizeConfig(null).land.specReviewGatedFields, []);
  assert.deepEqual(
    normalizeConfig({ land: { specReviewGatedFields: ['acceptsAcuteCases'] } }).land
      .specReviewGatedFields,
    ['acceptsAcuteCases'],
  );
  // a partial override keeps the OTHER land fields at their defaults
  assert.deepEqual(
    normalizeConfig({ land: { specReviewGatedFields: ['acceptsAcuteCases'] } }).land,
    { ...DEFAULT_LAND_SHAPE, specReviewGatedFields: ['acceptsAcuteCases'] },
  );
  assert.throws(
    () => normalizeConfig({ land: { specReviewGatedFields: 'acceptsAcuteCases' } }),
    /land\.specReviewGatedFields must be an array/,
  );
  assert.throws(
    () => normalizeConfig({ land: { specReviewGatedFields: [''] } }),
    /land\.specReviewGatedFields has an empty\/non-string entry/,
  );
  assert.throws(
    () => normalizeConfig({ land: { specReviewGatedFields: [' acceptsAcuteCases'] } }),
    /land\.specReviewGatedFields has a whitespace-padded entry/,
  );
  assert.throws(
    () =>
      normalizeConfig({
        land: { specReviewGatedFields: ['acceptsAcuteCases', 'acceptsAcuteCases'] },
      }),
    /land\.specReviewGatedFields lists "acceptsAcuteCases" more than once/,
  );
});

// plan 3961 T2.7b: land.coordinationOnlyPathPrefixes — the plan-3972 masterDeltaIsCoordinationOnly
// skip's path-prefix allowlist, moved OUT of done-worktree-lib.mjs's frozen
// COORDINATION_ONLY_PATH_PREFIXES constant and into configuration. CORE default is the four
// generic roots; `wiki/log.md` is NOT one of them (a config-less repo has no wiki vault opinion).
test('normalizeConfig: land.coordinationOnlyPathPrefixes defaults to the four generic roots and validates shape', () => {
  assert.deepEqual(normalizeConfig(null).land.coordinationOnlyPathPrefixes, [
    'docs/handoff/',
    'docs/superpowers/plans/',
    'docs/superpowers/batches/',
    '.drain-status/',
    'docs/INDEX.md',
  ]);
  assert.deepEqual(
    normalizeConfig({ land: { coordinationOnlyPathPrefixes: ['docs/x/'] } }).land
      .coordinationOnlyPathPrefixes,
    ['docs/x/'],
  );
  // a partial override keeps the OTHER land fields at their defaults
  assert.deepEqual(normalizeConfig({ land: { coordinationOnlyPathPrefixes: ['docs/x/'] } }).land, {
    ...DEFAULT_LAND_SHAPE,
    coordinationOnlyPathPrefixes: ['docs/x/'],
  });
  assert.throws(
    () => normalizeConfig({ land: { coordinationOnlyPathPrefixes: 'docs/x/' } }),
    /land\.coordinationOnlyPathPrefixes must be an array/,
  );
  assert.throws(
    () => normalizeConfig({ land: { coordinationOnlyPathPrefixes: [''] } }),
    /land\.coordinationOnlyPathPrefixes has an empty\/non-string entry/,
  );
  assert.throws(
    () => normalizeConfig({ land: { coordinationOnlyPathPrefixes: [1] } }),
    /land\.coordinationOnlyPathPrefixes has an empty\/non-string entry/,
  );
  assert.throws(
    () =>
      normalizeConfig({
        land: { coordinationOnlyPathPrefixes: ['docs/x/', 'docs/x/'] },
      }),
    /land\.coordinationOnlyPathPrefixes lists "docs\/x\/" more than once/,
  );
});

// plan 3961 T2.7b: land.worktreeMemoryReclaimScript — teardown's step-2 pwsh reclaim script path,
// moved OUT of done-worktree.mjs's inline literal and into configuration. CORE default null (the
// step is skipped, no DRY trace line, no best-effort run).
test('normalizeConfig: land.worktreeMemoryReclaimScript defaults to null and validates shape', () => {
  assert.equal(normalizeConfig(null).land.worktreeMemoryReclaimScript, null);
  assert.equal(
    normalizeConfig({ land: { worktreeMemoryReclaimScript: '~/reclaim.ps1' } }).land
      .worktreeMemoryReclaimScript,
    '~/reclaim.ps1',
  );
  assert.deepEqual(
    normalizeConfig({ land: { worktreeMemoryReclaimScript: '~/reclaim.ps1' } }).land,
    { ...DEFAULT_LAND_SHAPE, worktreeMemoryReclaimScript: '~/reclaim.ps1' },
  );
  assert.throws(
    () => normalizeConfig({ land: { worktreeMemoryReclaimScript: '' } }),
    /land\.worktreeMemoryReclaimScript must be null or a non-empty string/,
  );
  assert.throws(
    () => normalizeConfig({ land: { worktreeMemoryReclaimScript: 42 } }),
    /land\.worktreeMemoryReclaimScript must be null or a non-empty string/,
  );
});

// plan 3961 T2 review (key 3dc8da): the shape check above accepted ANY non-empty string,
// including a relative or parent-traversing one — teardown passes it straight to PowerShell's
// `-File` argument (only a leading `~/` is expanded), so `../../outside.ps1` or a bare
// `scripts/reclaim.ps1` resolves against whatever directory happens to be the process cwd at
// teardown time, an implicit and unreviewable target. Constrain to the three unambiguous,
// explicit forms: null, an absolute path (POSIX, Windows drive-rooted, or UNC — checked without
// relying on node:path's platform-DEFAULT isAbsolute, which would classify a Windows-style path
// differently depending on which OS runs the validator), or a "~/"-prefixed path.
test('normalizeConfig: land.worktreeMemoryReclaimScript refuses a relative path — only null, an absolute path, or a "~/"-prefixed path are accepted (plan 3961 review 3dc8da)', () => {
  const msg =
    /land\.worktreeMemoryReclaimScript must be null, an absolute path, or a "~\/"-prefixed path/;
  assert.throws(
    () => normalizeConfig({ land: { worktreeMemoryReclaimScript: '../../outside.ps1' } }),
    msg,
  );
  assert.throws(
    () => normalizeConfig({ land: { worktreeMemoryReclaimScript: 'scripts/reclaim.ps1' } }),
    msg,
  );
  assert.throws(
    () => normalizeConfig({ land: { worktreeMemoryReclaimScript: './reclaim.ps1' } }),
    msg,
  );
  // accepted forms: POSIX-absolute, Windows drive-rooted (both slash styles), UNC, and "~/"
  for (const accepted of [
    '/opt/reclaim.ps1',
    'C:/outside/reclaim.ps1',
    'C:\\outside\\reclaim.ps1',
    '\\\\host\\share\\reclaim.ps1',
    '~/reclaim.ps1',
  ]) {
    assert.equal(
      normalizeConfig({ land: { worktreeMemoryReclaimScript: accepted } }).land
        .worktreeMemoryReclaimScript,
      accepted,
      `expected "${accepted}" to be accepted`,
    );
  }
});

// plan 3961 review fix: land.buildCommand — the `build` preflight gate's invocation, moved OUT
// of the generic core (scripts/coord/land/gates-runner.mjs used to spell `pnpm --filter
// @vetapp/frontend build` directly) and into configuration. CORE default null (a config-less
// repo has no build step; the gate no-ops to a real green). Mirrors worktreeMemoryReclaimScript's
// own null-or-refuse contract immediately above.
// plan 4096 T5: land.typecheckCommands — the push battery's typecheck gates, moved OUT of
// scripts/hooks/pre-push-core.sh (which spelled three `@vetapp/*` pnpm commands literally) and
// into configuration. CORE default []: a config-less repo has no workspace to typecheck, so the
// gate says so in one line and passes. normalizeConfig checks the SHAPE only — the per-row
// contract lives in scripts/coord/land-typecheck-rows.mjs (its own name-paired test), because
// that module is the single consumer and two copies of those rules would drift. What must be
// caught HERE is the one shape that would silently disable every gate: a non-array, which the
// consumer's own `?? []` would otherwise turn into "no typecheck configured" on a green push.
test('normalizeConfig: land.typecheckCommands defaults to [] and refuses a non-array', () => {
  assert.deepEqual(normalizeConfig(null).land.typecheckCommands, []);
  const row = {
    name: 'tsc',
    label: 'typecheck',
    group: 'typecheck',
    groupDiffLabel: 'src diff',
    changed: '^src/',
    command: 'npm run typecheck',
    capSeconds: 300,
    failHint: 'fix it',
  };
  assert.deepEqual(normalizeConfig({ land: { typecheckCommands: [row] } }).land.typecheckCommands, [
    row,
  ]);
  assert.deepEqual(normalizeConfig({ land: { typecheckCommands: [row] } }).land, {
    ...DEFAULT_LAND_SHAPE,
    typecheckCommands: [row],
  });
  // Copied, not aliased: a caller mutating the returned rows must not reach back into the
  // parsed config object (same posture as the array spreads elsewhere in normalizeLand).
  const parsed = normalizeConfig({ land: { typecheckCommands: [row] } });
  parsed.land.typecheckCommands[0].name = 'mutated';
  assert.equal(row.name, 'tsc');
  for (const bad of [null, 'tsc', 42, { name: 'tsc' }]) {
    assert.throws(
      () => normalizeConfig({ land: { typecheckCommands: bad } }),
      /land\.typecheckCommands must be an array/,
      `land.typecheckCommands: ${JSON.stringify(bad)} must be refused, not silently emptied`,
    );
  }
});

test('normalizeConfig: land.buildCommand defaults to null and validates shape', () => {
  assert.equal(normalizeConfig(null).land.buildCommand, null);
  assert.deepEqual(
    normalizeConfig({ land: { buildCommand: { command: 'npm', args: ['run', 'build'] } } }).land
      .buildCommand,
    { command: 'npm', args: ['run', 'build'] },
  );
  assert.deepEqual(
    normalizeConfig({ land: { buildCommand: { command: 'npm', args: ['run', 'build'] } } }).land,
    { ...DEFAULT_LAND_SHAPE, buildCommand: { command: 'npm', args: ['run', 'build'] } },
  );
  assert.throws(
    () => normalizeConfig({ land: { buildCommand: 'pnpm build' } }),
    /land\.buildCommand must be null or an object of shape \{ command, args \}/,
  );
  assert.throws(
    () => normalizeConfig({ land: { buildCommand: ['pnpm', 'build'] } }),
    /land\.buildCommand must be null or an object of shape \{ command, args \}/,
  );
  assert.throws(
    () => normalizeConfig({ land: { buildCommand: { args: ['build'] } } }),
    /land\.buildCommand\.command must be a non-empty string/,
  );
  assert.throws(
    () => normalizeConfig({ land: { buildCommand: { command: '', args: [] } } }),
    /land\.buildCommand\.command must be a non-empty string/,
  );
  assert.throws(
    () => normalizeConfig({ land: { buildCommand: { command: 'pnpm', args: 'build' } } }),
    /land\.buildCommand\.args must be an array of strings/,
  );
  assert.throws(
    () => normalizeConfig({ land: { buildCommand: { command: 'pnpm', args: ['build', 42] } } }),
    /land\.buildCommand\.args must be an array of strings/,
  );
});

test("normalizeConfig: lanes.* defaults to today's folder names + STATUS_ORDER order", () => {
  const c = normalizeConfig(null);
  assert.deepEqual(c.lanes.statusOrder, [
    'in-progress',
    'ready',
    'pending-approval',
    'waiting-blocked',
    'waiting-operator',
    'waiting-grill',
    'waiting-date',
    'waiting-trip',
  ]);
  assert.equal(c.lanes.archive, 'archive');
  assert.equal(c.lanes.parked, 'parked');
});

test('normalizeConfig: lanes.* validates order/archive/parked and rejects duplicate folder names', () => {
  assert.throws(() => normalizeConfig({ lanes: { order: [] } }), /order must be a non-empty array/);
  assert.throws(
    () => normalizeConfig({ lanes: { order: ['inProgress', 'inProgress'] } }),
    /lists "inProgress" more than once/,
  );
  assert.throws(
    () => normalizeConfig({ lanes: { order: ['bogusKey'] } }),
    /names "bogusKey", but lanes.bogusKey is missing\/empty/,
  );
  assert.throws(() => normalizeConfig({ lanes: { archive: '' } }), /lanes.archive must be/);
  assert.throws(() => normalizeConfig({ lanes: { parked: '' } }), /lanes.parked must be/);
  // archive colliding with an active folder name
  assert.throws(
    () => normalizeConfig({ lanes: { archive: 'ready' } }),
    /duplicate folder name\(s\): ready/,
  );
  // a partial override renames ONE lane and keeps the rest at their defaults
  const c = normalizeConfig({ lanes: { ready: 'queued' } });
  assert.equal(c.lanes.statusOrder[1], 'queued');
  assert.equal(c.lanes.inProgress, 'in-progress');
});

// plan 3960 cluster-6 review fix: the pre-fix duplicate check only spanned `[...statusOrder,
// archive, parked]` — folders NOT named in `lanes.order` were invisible to it, so a role left
// out of `order` (a shorter active list that still keeps e.g. waitingGrill as a real folder)
// could silently collide with an active folder's name. Every per-lane named constant
// (WAITING_GRILL_FOLDER, …) still resolves such a role, so it must be checked exactly like an
// in-`order` one.
test('normalizeConfig: lanes.* rejects a duplicate role folder even when the colliding role is OUT of `order` (cluster-6 review fix)', () => {
  assert.throws(
    () =>
      normalizeConfig({
        lanes: {
          order: ['inProgress', 'ready'], // waitingGrill deliberately NOT listed here
          waitingGrill: 'ready', // but its VALUE collides with the active "ready" folder
        },
      }),
    /duplicate folder name\(s\): ready/,
  );
});

test('normalizeConfig: lanes.* rejects an empty/non-string role folder even when OUT of `order` (cluster-6 review fix)', () => {
  assert.throws(
    () =>
      normalizeConfig({
        lanes: { order: ['inProgress', 'ready'], waitingGrill: '' },
      }),
    /lanes\.waitingGrill must be a non-empty string/,
  );
});

test('normalizeConfig: derived scope lists normalize + fail loud on malformed entries (plan 1867)', () => {
  const c = normalizeConfig({
    derivedShardDirs: ['backend\\data\\price-pipeline\\render-fingerprints/'],
    derivedGlobalFiles: ['backend/data/price-pipeline/observations/sweep-observations.jsonl'],
  });
  assert.deepEqual(c.derivedShardDirs, ['backend/data/price-pipeline/render-fingerprints']);
  assert.deepEqual(c.derivedGlobalFiles, [
    'backend/data/price-pipeline/observations/sweep-observations.jsonl',
  ]);
  // a silently-dropped entry would put derived diffs back outside the mutex — throw instead
  assert.throws(() => normalizeConfig({ derivedShardDirs: [''] }), /empty\/non-string entry/);
  assert.throws(() => normalizeConfig({ derivedGlobalFiles: [42] }), /empty\/non-string entry/);
  assert.throws(() => normalizeConfig({ derivedShardDirs: 'not-a-list' }), /must be an array/);
});

test('normalizeConfig: derived scope roots alone turn seedLane on (xhigh F3 — banners/drain must agree with the lock)', () => {
  assert.equal(normalizeConfig({ derivedShardDirs: ['backend/data/x'] }).seedLane, true);
  assert.equal(normalizeConfig({ derivedGlobalFiles: ['backend/data/y.jsonl'] }).seedLane, true);
  assert.equal(normalizeConfig({ derivedShardDirs: [], derivedGlobalFiles: [] }).seedLane, false);
});

test('normalizeConfig: seedShardDir normalizes separators + trailing slash and turns seedLane on (plan 1300)', () => {
  const c = normalizeConfig({ seedShardDir: 'backend\\src\\data\\seed/' });
  assert.equal(c.seedShardDir, 'backend/src/data/seed');
  assert.equal(c.seedLane, true); // a shard-layout repo has a seed lane even with no monolith file
});

test('normalizeConfig: seedShardDir set-but-empty throws loud (never silently drops the seed lane)', () => {
  assert.throws(() => normalizeConfig({ seedShardDir: '' }), /seedShardDir is set but empty/);
  assert.throws(() => normalizeConfig({ seedShardDir: '   ' }), /seedShardDir is set but empty/);
  // explicit null stays a valid "no shard tree" (DEFAULTS shape)
  assert.equal(normalizeConfig({ seedShardDir: null }).seedShardDir, null);
});

test('normalizeConfig: vetapp profile derives seedLane=true + docs/handoff paths', () => {
  const c = normalizeConfig({
    seedLaneFile: 'backend/src/data/seed-clinics.json',
    handoffLayout: 'sessions',
    handoffDir: 'docs/handoff',
  });
  assert.equal(c.seedLane, true);
  assert.equal(c.seedLaneFile, 'backend/src/data/seed-clinics.json');
  assert.equal(c.handoffLayout, 'sessions');
  assert.equal(c.handoffDir, 'docs/handoff');
  assert.deepEqual(c.paths, {
    handoffDir: 'docs/handoff',
    boardFile: 'docs/handoff/board.md',
    queueFile: 'docs/handoff/landing-queue.md',
    rollingHandoffFile: 'docs/handoff/current.md',
    sessionsDir: 'docs/handoff/sessions',
    archiveDir: 'docs/handoff/archive',
  });
});

test('normalizeConfig: explicit seedLaneFile null ⇒ seedLane false', () => {
  assert.equal(normalizeConfig({ seedLaneFile: null, handoffLayout: 'single' }).seedLane, false);
});

test('normalizeConfig: invalid handoffLayout throws loud', () => {
  assert.throws(() => normalizeConfig({ handoffLayout: 'bogus' }), /invalid handoffLayout/);
});

// plan 3960 cluster-6 review fix: `{ ...DEFAULTS, ...raw }` silently accepted a malformed
// top-level shape — an array spreads its INDICES as keys (`{0: 'x'}`), so `normalizeConfig([])`
// or `normalizeConfig('oops')` used to read as "no overrides" (every real default kept) instead
// of failing loud on the authoring mistake. null/undefined stay the documented "no config"
// sentinel and must NOT throw.
test('normalizeConfig: a malformed non-object top-level value throws loud instead of silently reading as "no overrides" (cluster-6 review fix)', () => {
  assert.throws(() => normalizeConfig([]), /must be a JSON object at the top level/);
  assert.throws(() => normalizeConfig(['oops']), /must be a JSON object at the top level/);
  assert.throws(() => normalizeConfig('oops'), /must be a JSON object at the top level/);
  assert.throws(() => normalizeConfig(42), /must be a JSON object at the top level/);
  assert.throws(() => normalizeConfig(false), /must be a JSON object at the top level/);
  // the documented "no config" sentinels must NOT throw
  assert.doesNotThrow(() => normalizeConfig(null));
  assert.doesNotThrow(() => normalizeConfig(undefined));
});

test('derivePaths(null) ⇒ legacy root-scattered literals (config-less repos unchanged)', () => {
  assert.deepEqual(derivePaths(null), {
    handoffDir: null,
    boardFile: 'handoff-board.md',
    queueFile: 'landing-queue.md',
    rollingHandoffFile: 'handoff.md',
    sessionsDir: 'handoff/sessions',
    archiveDir: 'docs/handoffs',
  });
});

test('derivePaths(dir): one tree under handoffDir, trailing slash + backslash normalized', () => {
  const a = derivePaths('docs/handoff');
  const b = derivePaths('docs/handoff/');
  const c = derivePaths('docs\\handoff');
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.equal(a.sessionsDir, 'docs/handoff/sessions');
  assert.equal(a.archiveDir, 'docs/handoff/archive');
});

test('loadCoordConfig: reads <repoRoot>/coord.config.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'coordcfg-'));
  writeFileSync(
    join(root, 'coord.config.json'),
    JSON.stringify({
      seedLaneFile: 'seed.json',
      handoffLayout: 'sessions',
      handoffDir: 'docs/handoff',
    }),
  );
  const c = loadCoordConfig(root);
  assert.equal(c.seedLane, true);
  assert.equal(c.seedLaneFile, 'seed.json');
  assert.equal(c.paths.boardFile, 'docs/handoff/board.md');
  rmSync(root, { recursive: true, force: true });
});

test('loadCoordConfig: missing file ⇒ DEFAULTS', () => {
  const root = mkdtempSync(join(tmpdir(), 'coordcfg-'));
  assert.deepEqual(loadCoordConfig(root), normalizeConfig(null));
  assert.deepEqual(DEFAULTS, {
    seedLaneFile: null,
    seedShardDir: null,
    derivedShardDirs: [],
    derivedGlobalFiles: [],
    // plan 3962 P1 — same empty-default posture as deployServices below.
    jobOutputPrefixes: [],
    externalTreePrefixes: [],
    dataDependencyMap: {},
    cloudRepos: [],
    handoffLayout: 'single',
    handoffDir: null,
    // R1: the core's own DEFAULTS carry NO deploy rows at all — see the dedicated
    // no-config-repo / config-less-config-object tests below.
    deployServices: [],
    // plan 4071: CORE default is now null — see the shardIdPattern test above.
    shardIdPattern: null,
    scopeMaxKeys: 500,
    // plan 4069 review round 2: default $5, matching drain-run.mjs's historical
    // PAUSE_COST_THRESHOLD_USD fallback.
    operatorSpendCeilingUsd: 5,
    // plan 4071: CORE default is now the neutral DATA-WRITE/--data-write pair.
    mutationBanner: { label: 'DATA-WRITE', flag: '--data-write' },
    lanes: DEFAULT_LANES_RAW_SHAPE,
    land: DEFAULT_LAND_SHAPE,
    plugins: {}, // plan 3961 T1 — no land plugins in the core's own DEFAULTS
    // plan 4071 — the vetapp literals inside scripts/coord/**, every one empty/null by default.
    coordCheckoutExcludedTopLevel: [],
    planWorktreeExcludedPaths: [],
    reviewDiffExcludes: [],
    batteryScopedPrefixes: [],
    localHostDenylist: [],
    wikiSubjectPatterns: [],
    planCategories: DEFAULT_PLAN_CATEGORIES_SHAPE,
    planNaming: DEFAULT_PLAN_NAMING_SHAPE,
    pytestSelector: DEFAULT_PYTEST_SELECTOR_SHAPE,
    gates: {},
    // plan 3958 — the env var NAMES two coord tools read a secret from; generic, unclaimed
    // defaults so the public kit hardcodes no project vocabulary.
    gitPatEnvVar: 'GIT_PUSH_TOKEN',
    codexAuthEnvVar: 'CODEX_LOGIN_B64',
  });
  rmSync(root, { recursive: true, force: true });
});

// ── plan 3960 R1: the plan-3082 guard test ─────────────────────────────────────────────────────
// "A market missing from the [deploy] table is deployed by nothing" (plan 3082). Since R1 moved
// the deploy table OUT of the generic core and into vetapp's OWN coord.config.json, this is the
// test that stands guard over that move: it loads THIS repo's real, on-disk coord.config.json —
// not a synthetic fixture — and asserts it yields EXACTLY today's eight rows, matching the
// pre-3960 PROD_DEPLOY_SERVICES row-for-row, with `railway` coordinates equal to
// railwayCoords(RAILWAY_SERVICES.<key>) for the matching key. A silent drop of a row (or of the
// whole key) during the R1 move would otherwise be invisible until a deploy actually missed a
// market, exactly the plan-3082 failure mode.
// ── plan 3960 R1: the config-less case (both flavors) ──────────────────────────────────────────
test('normalizeConfig({}) yields deployServices: [] (R1 — empty default, never vetapp rows)', () => {
  assert.deepEqual(normalizeConfig({}).deployServices, []);
});

test('a repo with no coord.config.json yields deployServices: [] (R1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'coordcfg-noconfig-'));
  try {
    assert.equal(existsSync(join(root, 'coord.config.json')), false);
    assert.deepEqual(loadCoordConfig(root).deployServices, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- loadCoordConfigAtOrigin (plan 2502) -------------------------------------
// A tiny git repo standing in for mainDir: its OWN on-disk coord.config.json is left
// STALE (seedLane=false, no shard dir) while a later commit changes it. sha pins the
// read to a specific point in history — the same shape resolvePlanAtOrigin/readAtOrigin
// use for the plan-file read doAcquire's Gate 2 already resolves fresh.
// `withConfig: false` skips the initial coord.config.json commit — for tests exercising a
// history point that predates the file ever being tracked (kept on the same fixture instead
// of a second hand-rolled git-init, sonnet-review finding).
function makeConfigRepo({ withConfig = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coordcfg-git-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  g('config', 'commit.gpgsign', 'false');
  if (withConfig) {
    writeFileSync(join(dir, 'coord.config.json'), JSON.stringify({ seedLaneFile: null }));
  } else {
    writeFileSync(join(dir, 'f.txt'), 'x');
  }
  g('add', '-A');
  g('commit', '-qm', withConfig ? 'seedLane off' : 'no config yet');
  const staleSha = g('rev-parse', 'HEAD').trim();
  return { dir, g, staleSha, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('loadCoordConfigAtOrigin: reads coord.config.json AT the given sha, not the on-disk copy', () => {
  const { dir, g, staleSha, cleanup } = makeConfigRepo();
  try {
    // mainDir's on-disk file now flips to seedLane=true — loadCoordConfigAtOrigin(dir, staleSha)
    // must still see the OLD value committed at staleSha, proving it reads via `git show`, not fs.
    writeFileSync(
      join(dir, 'coord.config.json'),
      JSON.stringify({ seedShardDir: 'backend/src/data/seed' }),
    );
    g('add', '-A');
    g('commit', '-qm', 'seedLane on');
    const freshSha = g('rev-parse', 'HEAD').trim();

    assert.equal(loadCoordConfigAtOrigin(dir, staleSha).seedLane, false);
    assert.equal(loadCoordConfigAtOrigin(dir, freshSha).seedLane, true);
    // the live on-disk copy (post-flip) agrees with the fresh sha, confirming the fixture
    assert.equal(loadCoordConfig(dir).seedLane, true);
  } finally {
    cleanup();
  }
});

test('loadCoordConfigAtOrigin: no sha (origin resolution failed upstream) falls back to the local read', () => {
  const { dir, cleanup } = makeConfigRepo();
  try {
    assert.equal(loadCoordConfigAtOrigin(dir, null).seedLane, loadCoordConfig(dir).seedLane);
    assert.equal(loadCoordConfigAtOrigin(dir, undefined).seedLane, false);
  } finally {
    cleanup();
  }
});

test("loadCoordConfigAtOrigin: coord.config.json didn't exist yet at that sha falls back to the local read", () => {
  const { dir, staleSha: sha, cleanup } = makeConfigRepo({ withConfig: false });
  try {
    writeFileSync(
      join(dir, 'coord.config.json'),
      JSON.stringify({ seedShardDir: 'backend/src/data/seed' }),
    );
    assert.equal(loadCoordConfigAtOrigin(dir, sha).seedLane, true); // falls back to the local read
  } finally {
    cleanup();
  }
});

test('loadCoordConfigAtOrigin: a git-show failure that is NOT "path absent at this sha" PROPAGATES instead of falling back (sonnet-review finding)', () => {
  const { dir, cleanup } = makeConfigRepo();
  try {
    // A real git failure (an invalid/nonexistent object, distinct from the "path does not
    // exist in <sha>" absence shape) must throw — a bare catch-all here would silently reuse
    // the caller's stale local coord.config.json, reintroducing the exact staleness bug this
    // function exists to close, just under a different trigger (a transient/real git error
    // instead of "not committed yet").
    assert.throws(
      () => loadCoordConfigAtOrigin(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef1'),
      /invalid object name|bad object|fatal:/,
    );
  } finally {
    cleanup();
  }
});

test("loadCoordConfigAtOrigin: malformed JSON actually present at the sha propagates (mirrors loadCoordConfig's own fail-loud parse)", () => {
  const { dir, g, cleanup } = makeConfigRepo();
  try {
    writeFileSync(join(dir, 'coord.config.json'), '{ not valid json');
    g('add', '-A');
    g('commit', '-qm', 'malformed config');
    const sha = g('rev-parse', 'HEAD').trim();
    assert.throws(() => loadCoordConfigAtOrigin(dir, sha), /JSON/);
  } finally {
    cleanup();
  }
});

// --- CLAUDE_CONFIG_DIR resolution (plan 1643) --------------------------------
// Save/restore the env var around each case — this suite runs alongside every other
// scripts/*.test.mjs file under one `node --test` invocation (plan 338), so a leaked
// mutation here would bleed into unrelated tests.

test('resolveConfigDir / configDirCandidates: CLAUDE_CONFIG_DIR set ⇒ that dir wins, fallback still listed', () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = '/custom/config/dir';
    // path-assert-ok: resolveConfigDir returns the env value VERBATIM (no node:path call), so this
    // asserts pass-through, not a path spelling — the literal is the same string on every platform.
    assert.equal(resolveConfigDir(), '/custom/config/dir');
    assert.deepEqual(configDirCandidates(), ['/custom/config/dir', join(homedir(), '.claude')]);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('resolveConfigDir / configDirCandidates: CLAUDE_CONFIG_DIR unset ⇒ ~/.claude fallback only', () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(resolveConfigDir(), join(homedir(), '.claude'));
    assert.deepEqual(configDirCandidates(), [join(homedir(), '.claude')]);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

// ── plan 3960 T3: the "no config" mode has a test ─────────────────────────────────────────────
// The public-copy contract: a repo with NO coord.config.json runs the core's plan-shaped tools
// with agnostic defaults — no seed lane, default lanes, a seed scope that never escalates to
// global on a plain (non-seed) diff, and a banner reader that treats every plan as unmarked. The
// isolated-plan-repo scaffold (test-helpers/isolated-plan-repo.mjs) writes no coord.config.json
// today — verified directly below rather than assumed — so it already IS the no-config case; no
// second hand-rolled temp-repo builder is needed.

const T3_PLAN_BODY = [
  '---',
  'summary: plan 3960 T3 no-config fixture',
  '---',
  '',
  // Deliberately claims 🟥 SEED-WRITE: YES — the point of the banner-reader assertion below is
  // that a config-less repo (seedLane=false) reads EVERY plan as unmarked (🟩) regardless of
  // what its own body claims, because there is no seed lane for anything to belong to.
  '> 🟥 **SEED-WRITE: YES** — deliberately claims a seed write; seedLane=false must still read 🟩.',
  '',
  '**Status:** 📋 READY — opened 2026-09-13.',
  '',
  '# 900-Coord-no-config-plan',
  '',
  'Body.',
  '',
].join('\n');

const makeNoConfigRepo = isolatedRepoFactory({
  prefix: 'noconfig-iso',
  basename: '900-Coord-no-config-plan.md',
  body: T3_PLAN_BODY,
  tools: { buildIndex: 'build-index.mjs', movePlan: 'move-plan.mjs', board: 'board.mjs' },
});

test('plan 3960 T3: a repo with NO coord.config.json runs the core plan-shaped tools with agnostic defaults', () => {
  const repo = makeNoConfigRepo();
  try {
    // The scaffold's own no-config premise, checked directly (not assumed) — this test's
    // entire contract rests on it being true.
    assert.equal(existsSync(join(repo.dir, 'coord.config.json')), false);
    const cfg = loadCoordConfig(repo.dir);

    // (a) no seed lane.
    assert.equal(cfg.seedLane, false);
    assert.equal(cfg.seedLaneFile, null);
    assert.equal(cfg.seedShardDir, null);

    // (b) default lanes — resolved by the ISOLATED repo's OWN copy of build-index-lib.mjs (a
    // separate module graph under its own dirname), not this test file's already-loaded one, so
    // this actually proves the fail-open resolution the plan requires, not just today's defaults.
    // plan 3961 T2.7c fix-now: the module specifier must be a `file://` URL, not a bare fs path —
    // a raw path on a non-C: drive (an E:\Temp\... scratch/worktree root) throws
    // ERR_UNSUPPORTED_ESM_URL_SCHEME from a spawned child's dynamic `import()`. Embedding
    // `pathToFileURL(...).href` in the `-e` script itself (rather than passing the raw path via
    // `process.argv[1]`) sidesteps that entirely.
    const buildIndexLibUrl = pathToFileURL(repo.toolPath('build-index-lib.mjs')).href;
    const laneProbe = spawnSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(buildIndexLibUrl)}).then((m) => { process.stdout.write(JSON.stringify({ statusOrder: m.STATUS_ORDER, archive: m.ARCHIVE_FOLDER, parked: m.PARKED_FOLDER, allFolders: m.ALL_PLAN_FOLDERS })); });`,
      ],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    assert.equal(laneProbe.status, 0, laneProbe.stderr);
    const lanes = JSON.parse(laneProbe.stdout.trim());
    assert.deepEqual(lanes.statusOrder, [
      'in-progress',
      'ready',
      'pending-approval',
      'waiting-blocked',
      'waiting-operator',
      'waiting-grill',
      'waiting-date',
      'waiting-trip',
    ]);
    assert.equal(lanes.archive, 'archive');
    assert.equal(lanes.parked, 'parked');
    assert.deepEqual(lanes.allFolders, [...lanes.statusOrder, 'archive', 'parked']);

    // (c) a seed scope that never escalates to global on a plain (non-seed) diff — with no
    // seedLaneFile/seedShardDir/derived config, an ordinary plan-file change computes NO scope
    // at all (null = free lane, no mutex entry), so `scopesOverlap` never even sees it, let alone
    // reads it as {global:true}.
    const scope = seedScopeOf([repo.srcRel], cfg.seedLaneFile, cfg.seedShardDir, {
      shardDirs: cfg.derivedShardDirs,
      globalFiles: cfg.derivedGlobalFiles,
    });
    assert.equal(scope, null);

    // (d) the banner reader treats every plan as "not marked" (🟩) — the body above claims
    // 🟥 SEED-WRITE: YES, but with seedLane=false nothing can ever read as a seed write.
    assert.equal(readSeedMarker(T3_PLAN_BODY, { seedLane: cfg.seedLane }), '🟩');

    // (e) index — the copied build-index.mjs tool runs clean (no config-read crash) and renders
    // the plan under its default ready/ lane, unmarked.
    const idxRun = runTool(repo.dir, [], repo.buildIndex);
    assert.equal(idxRun.code, 0, idxRun.stderr);
    const indexOnDisk = readFileSync(join(repo.dir, 'docs', 'INDEX.md'), 'utf8');
    assert.match(indexOnDisk, /ready\/900-Coord-no-config-plan\.md/);
    assert.match(indexOnDisk, /🟩/);

    // (f) board — the copied board.mjs `list` (read-only) runs against a config-less repo with
    // no board file at all, and exits with board.mjs's own controlled "not found" refusal (exit
    // 2, its normal error convention) rather than an uncaught crash — a missing board file under
    // no config is an expected state ("no coordination board"), not a code defect.
    const boardRun = runTool(repo.dir, ['list'], repo.board);
    assert.equal(boardRun.code, 2);
    assert.match(boardRun.stderr, /handoff-board\.md not found/);

    // (g) move-plan — a plain move (ready/ → waiting-date/, both default-named lanes) succeeds
    // end-to-end against the no-config repo. move-plan commits+pushes through its own ephemeral
    // coord checkout, so the result lands on origin/master, not repo.dir's own working tree —
    // `git fetch` + read origin/master, the same pattern move-plan.test.mjs's own assertions use.
    const moveRun = runTool(
      repo.dir,
      [repo.basename, 'waiting-date', '--blocked-by', 'x'],
      repo.movePlan,
    );
    assert.equal(moveRun.code, 0, moveRun.stderr);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.ok(tree.includes(`docs/superpowers/plans/waiting-date/${repo.basename}`));
    assert.ok(!tree.includes(`docs/superpowers/plans/ready/${repo.basename}`));
  } finally {
    repo.cleanup();
  }
});

// ── plan 3961 T1: the `plugins` key ───────────────────────────────────────────────────────────
// The LOADER (scripts/land-plugins.mjs) is tested in its own name-pair, land-plugins.test.mjs —
// it carries a dynamic import, and importing it here would widen this file's own battery
// pass-cache closure. See land-plugins.mjs's header.

test('plugins: absent/null ⇒ {} — a config-less repo registers no land plugins', () => {
  assert.deepEqual(normalizeConfig(null).plugins, {});
  assert.deepEqual(normalizeConfig({}).plugins, {});
  assert.deepEqual(normalizeConfig({ plugins: null }).plugins, {});
  assert.deepEqual(normalizeConfig({ plugins: {} }).plugins, {});
});

test('plugins: a valid map is normalized to POSIX paths, per point', () => {
  const c = normalizeConfig({
    plugins: {
      prepGates: ['scripts/project/land-gates.mjs'],
      landSeams: ['scripts\\project\\land-seams.mjs'],
    },
  });
  assert.deepEqual(c.plugins, {
    prepGates: ['scripts/project/land-gates.mjs'],
    landSeams: ['scripts/project/land-seams.mjs'],
  });
});

test('plugins: an unknown extension point is refused, naming the valid set', () => {
  // `prepGate` (singular) would otherwise be a plugin list nothing ever reads — i.e. project
  // gates that silently never run.
  assert.throws(
    () => normalizeConfig({ plugins: { prepGate: ['scripts/project/x.mjs'] } }),
    /plugins names "prepGate", which is not a land extension point/,
  );
  assert.throws(
    () => normalizeConfig({ plugins: { prepGate: [] } }),
    /expected one of: contextExtras, landSeams, prepGates, postMerge, closeOutExtras/,
  );
});

test('plugins: non-object / non-array / empty entries are refused', () => {
  assert.throws(() => normalizeConfig({ plugins: 'nope' }), /must be an object keyed by/);
  assert.throws(() => normalizeConfig({ plugins: ['x'] }), /must be an object keyed by/);
  assert.throws(
    () => normalizeConfig({ plugins: { prepGates: 'scripts/x.mjs' } }),
    /plugins\.prepGates must be an array of module paths/,
  );
  for (const bad of ['', '   ', 42, null]) {
    assert.throws(
      () => normalizeConfig({ plugins: { prepGates: [bad] } }),
      /plugins\.prepGates has an empty\/non-string entry/,
    );
  }
});

test('plugins: a path escaping the repo is refused (absolute, .., drive, URL)', () => {
  for (const bad of [
    '/etc/evil.mjs',
    '../../outside.mjs',
    '..',
    'scripts/../../outside.mjs',
    'C:/Windows/x.mjs',
    'file:///etc/evil.mjs',
    'https://example.com/x.mjs',
  ]) {
    assert.throws(
      () => normalizeConfig({ plugins: { prepGates: [bad] } }),
      /must be a repo-relative path inside the repo/,
      `expected ${bad} to be refused`,
    );
  }
  // a plain nested path, and a "." segment, are fine
  assert.deepEqual(normalizeConfig({ plugins: { prepGates: ['scripts/project/a.mjs'] } }).plugins, {
    prepGates: ['scripts/project/a.mjs'],
  });
});

test('plugins: the same module listed twice in one point is refused', () => {
  // It would register every entry twice, which buildRegistry then reports as duplicate NAMES —
  // a correct refusal with a misleading message. Caught here, where the cause is visible.
  assert.throws(
    () =>
      normalizeConfig({
        plugins: { prepGates: ['scripts/project/a.mjs', 'scripts/project/a.mjs'] },
      }),
    /lists "scripts\/project\/a\.mjs" twice/,
  );
  // the SAME path under two DIFFERENT points is legitimate (one module, two rosters)
  assert.doesNotThrow(() =>
    normalizeConfig({
      plugins: { prepGates: ['scripts/project/a.mjs'], postMerge: ['scripts/project/a.mjs'] },
    }),
  );
});

test("THIS repo's coord.config.json registers no land plugins yet (T1 is additive)", () => {
  // T1 wires the mechanism; T2 is what moves vetapp's gates into scripts/project/ and adds the
  // rows here. If this starts failing, T2 has landed and this test should assert the new rows
  // instead of being deleted.
  const repoRoot = repoRootFrom(import.meta.dirname);
  assert.deepEqual(loadCoordConfig(repoRoot).plugins, {});
});

test('plugins: duplicate detection canonicalizes dot segments (review round 1)', () => {
  // Findings 9ae61a/cecd6a/d48193/915306: "./scripts/x.mjs" and "scripts/x.mjs" are the same
  // module, so a raw-string dup check let the module register every entry twice.
  for (const pair of [
    ['./scripts/project/a.mjs', 'scripts/project/a.mjs'],
    ['scripts/./project/a.mjs', 'scripts/project/a.mjs'],
    ['scripts//project/a.mjs', 'scripts/project/a.mjs'],
  ]) {
    assert.throws(
      () => normalizeConfig({ plugins: { prepGates: pair } }),
      /lists "scripts\/project\/a\.mjs" twice/,
      `expected ${pair[0]} to collide with ${pair[1]}`,
    );
  }
  // and the stored value is the canonical spelling, so the loader resolves one path
  assert.deepEqual(
    normalizeConfig({ plugins: { prepGates: ['./scripts/./project/a.mjs'] } }).plugins.prepGates,
    ['scripts/project/a.mjs'],
  );
  // genuinely different modules still coexist
  assert.doesNotThrow(() =>
    normalizeConfig({ plugins: { prepGates: ['scripts/project/a.mjs', 'scripts/project/b.mjs'] } }),
  );
});

test('plugins: a path that canonicalizes to EMPTY is refused (review round 2)', () => {
  // Finding 56655b: "." and "./" pass the non-empty check, then fold to "" — an empty plugin path
  // resolves to the repo root and fails far from its cause.
  for (const bad of ['.', './', './.', './//']) {
    assert.throws(
      () => normalizeConfig({ plugins: { prepGates: [bad] } }),
      /canonicalizes to an empty path/,
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
});

// ── plan 3958 review fix (key jlfzz7) ──────────────────────────────────────────────────────────
// gitPatEnvVar / codexAuthEnvVar are interpolated into POSIX shell syntax as-is downstream
// (ensure-coord-reroute.mjs's credentialHelperFor: `echo "password=$${patEnvVar}"`). A value that
// is not a valid shell/env identifier — e.g. "MY-PAT" — makes the shell expand only its "$MY"
// prefix, silently feeding the WRONG credential rather than failing loud. This proves the loader
// refuses (degrades to the generic default, with a warning — never a throw, matching the
// existing soft-degrade posture every other malformed value on these two keys already has) any
// name that does not match a plain shell/env identifier.
test('gitPatEnvVar: a malformed shell-unsafe name degrades to the default (never installs a shell-expansion hazard)', () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    for (const bad of ['MY-PAT', '1LEADING_DIGIT', 'HAS SPACE', 'HAS.DOT', '']) {
      const c = normalizeConfig({ gitPatEnvVar: bad });
      assert.equal(
        c.gitPatEnvVar,
        DEFAULT_GIT_PAT_ENV_VAR,
        `expected ${JSON.stringify(bad)} to fall back`,
      );
    }
    assert.ok(warnings.some((m) => m.includes('gitPatEnvVar') && m.includes('MY-PAT')));
  } finally {
    console.warn = origWarn;
  }
});

test('codexAuthEnvVar: a malformed shell-unsafe name degrades to the default, a valid name passes through', () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(
      normalizeConfig({ codexAuthEnvVar: 'MY-AUTH' }).codexAuthEnvVar,
      DEFAULT_CODEX_AUTH_ENV_VAR,
    );
    // A valid identifier (letters/digits/underscore, not digit-leading) still passes through
    // unchanged — this is a shape refusal, not a rejection of every non-default value. (A
    // fictitious name, not any real project's actual configured value — this file ships in the
    // public coord-kit, whose scrub gate denylists real project-specific env var names.)
    assert.equal(
      normalizeConfig({ codexAuthEnvVar: 'MY_PROJECT_CODEX_AUTH' }).codexAuthEnvVar,
      'MY_PROJECT_CODEX_AUTH',
    );
    assert.equal(
      normalizeConfig({ gitPatEnvVar: '_leading_underscore' }).gitPatEnvVar,
      '_leading_underscore',
    );
  } finally {
    console.warn = origWarn;
  }
});
