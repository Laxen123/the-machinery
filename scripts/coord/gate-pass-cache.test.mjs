// scripts/gate-pass-cache.test.mjs — unit + CLI tests for the per-gate pass-cache (plan 2462).
// Pure key/verdict/entry logic, gateVerdict against injected repo states, fs ops against temp
// dirs, and end-to-end CLI runs inside throwaway git repos (the cache rendezvous is
// `git rev-parse --git-common-dir`, so a real repo is needed for the CLI arm — the 1824 cache's
// pattern, inherited).
//
// THE INVARIANT EVERY CASE DEFENDS: A STALE GREEN IS THE ONE UNACCEPTABLE OUTCOME. Every
// refusal path (dirt in the gate's own closure, an untracked env file it reads, git trouble,
// an expired/corrupt/future-stamped entry, key drift at record time, either kill-switch, an
// unknown gate) must land on MISS or UNCACHEABLE — exits the hook reads as "run this gate
// exactly as today". Only an exact, live, same-gate, same-content pass may HIT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  gatesFrom,
  gateNames,
  checkAllGates,
  probeGates,
  parseRequiredProbe,
  probeMobileRequired,
  probeVerdict,
  DEFAULT_TTL_MIN,
  EXIT_HIT,
  EXIT_MISS,
  EXIT_UNCACHEABLE,
  KEY_FORMAT_VERSION,
  allKeyedPaths,
  pathCovers,
  parseStatusPaths,
  parseBatchCheck,
  computeGateKey,
  deriveSelectionKey,
  parseEntry,
  isLive,
  gatherRepoState,
  gateVerdict,
  decideGates,
  serializeRepoState,
  deserializeRepoState,
  readStateFile,
  makeGit,
  renderDecisions,
  entryPath,
  readCacheEntry,
  writeCacheEntry,
  removeCacheEntry,
  pruneExpired,
  selectionFilesFromStdin,
} from './gate-pass-cache.mjs';
import { loadCoordConfig } from './coord-config.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';
import { makeNoRepoRoot } from '../test-helpers/no-repo-root.mjs';
import { makeIsolatedRepo } from '../test-helpers/isolated-plan-repo.mjs';

// plan 4071 T4/D5: the registry is no longer a module-level export — it is built by `gatesFrom`
// from coord.config.json's `gates` key. This fixture INLINES the pre-plan-4071 literal registry
// (byte-for-byte, as a raw coord.config.json-shaped object: `probe` is the STRING name, never the
// function) so this suite keeps testing the exact vetapp shape it always has, independent of
// whatever the real coord.config.json happens to contain at test time; the SEPARATE byte-identity
// test near the bottom of this file is what pins the real config against this same literal.
const MOBILE_GATE = 'mobile-gate';
const RAW_GATES_FIXTURE = Object.freeze({
  'tsc-backend': {
    desc: 'pnpm --filter @vetapp/backend exec tsc --noEmit -p tsconfig.json',
    paths: [
      'backend/src',
      'backend/tsconfig.json',
      'shared/src',
      'shared/tsconfig.json',
      'tsconfig.base.json',
      'pnpm-lock.yaml',
    ],
  },
  'tsc-shared': {
    desc: 'pnpm --filter @vetapp/backend exec tsc --noEmit -p ../shared/tsconfig.json',
    paths: [
      'backend/src',
      'backend/tsconfig.json',
      'shared/src',
      'shared/tsconfig.json',
      'tsconfig.base.json',
      'pnpm-lock.yaml',
    ],
  },
  'tsc-frontend': {
    desc: 'pnpm --filter @vetapp/frontend exec tsc --noEmit',
    paths: [
      'frontend/src',
      'frontend/tsconfig.json',
      'shared/src',
      'tsconfig.base.json',
      'pnpm-lock.yaml',
    ],
  },
  'vitest-backend-full': {
    desc: 'node scripts/run-land-tests.mjs (full backend suite)',
    paths: ['backend', 'shared/src', 'pnpm-lock.yaml'],
  },
  'vitest-backend-seed-sanity': {
    desc: 'node scripts/run-land-tests.mjs (seed-sanity subset)',
    paths: ['backend', 'shared/src', 'pnpm-lock.yaml'],
  },
  'vitest-frontend-seed-sanity': {
    desc: 'pnpm --filter @vetapp/frontend exec vitest run (seed-sanity subset)',
    paths: ['frontend/src', 'backend/src/data', 'shared/src', 'pnpm-lock.yaml'],
  },
  'vitest-frontend-full': {
    desc: 'node scripts/run-land-tests.mjs --filter @vetapp/frontend (full frontend suite)',
    paths: [
      'frontend',
      'shared/src',
      'pnpm-lock.yaml',
      'scripts/run-land-tests.mjs',
      'scripts/pytest-workers.mjs',
      'scripts/coord/cpu-budget.mjs',
      'scripts/coord/test-queue.mjs',
      'backend/tests/land-gate-unhandled-errors-reporter.mjs',
    ],
  },
  'pytest-backend-scripts': {
    desc: 'python -m pytest backend/scripts',
    paths: [
      'backend/scripts',
      'backend/src/data',
      'shared/src',
      'backend/scripts/requirements.txt',
    ],
  },
  'next-build': {
    desc: 'pnpm --filter @vetapp/frontend build',
    paths: ['frontend', 'shared', 'backend/src/data', 'pnpm-lock.yaml'],
    envUncacheable: ['frontend/.env.local'],
  },
  [MOBILE_GATE]: {
    desc: 'node frontend/scripts/verify-mobile-gate.mjs (WebKit T1-T7)',
    paths: [
      'frontend',
      'shared',
      'backend/src/data',
      'scripts/verify-mobile-watched.mjs',
      'scripts/coord/kill-tree.mjs',
      'pnpm-lock.yaml',
    ],
    envUncacheable: ['frontend/.env.local'],
    probe: 'mobile-required',
    probeScript: 'frontend/scripts/verify-mobile-gate.mjs',
  },
});
const GATES = gatesFrom({ gates: RAW_GATES_FIXTURE });
const GATE_NAMES = gateNames(GATES);
const CHECK_ALL_GATES = checkAllGates(GATES);
const PROBE_GATES = probeGates(GATES);

const CLI = resolve(import.meta.dirname, 'gate-pass-cache.mjs');
const ISO = '2026-07-26T10:00:00.000Z';
const at = (min) => Date.parse(ISO) + min * 60000;

// This suite RUNS inside the pre-push hook, where git exports GIT_DIR/GIT_WORK_TREE into every
// subprocess — an inherited GIT_DIR would point our throwaway repos at the real one. Scrub it,
// plus the cache's own kill-switches, which the very push running this suite may have exported.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  delete env.PREPUSH_NO_BATTERY_CACHE;
  delete env.PREPUSH_FULL_BATTERY;
  // plan 2491: the mobile gate's probe reads these. A push run with the documented
  // VERIFY_MOBILE_SKIP=1 bypass exported would otherwise make every mobile case here
  // uncacheable and the suite would pass without proving anything.
  delete env.VERIFY_MOBILE_SKIP;
  delete env.VERIFY_MOBILE_RANGE;
  delete env.STUB_MOBILE_REQUIRED;
  return env;
}

// A stand-in for `frontend/scripts/verify-mobile-gate.mjs --detect-only`, planted in every
// throwaway repo. Content-STABLE and ENV-switched on purpose: acceptance 3 needs the probe to
// answer differently over an IDENTICAL tree, and the real script lives inside the mobile gate's
// own closure — a stub that changed shape between the two answers would move the key by itself
// and prove nothing. Defaults to required=true so the generic gate loops below cover the mobile
// gate exactly like every other one.
const PROBE_STUB = [
  '#!/usr/bin/env node',
  "const required = process.env.STUB_MOBILE_REQUIRED !== '0';",
  "console.log('verify-mobile-gate: required=' + required);",
  '',
].join('\n');

function commitAll(dir, msg) {
  execFileSync('git', ['add', '-A'], { cwd: dir, env: cleanEnv() });
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@test.invalid', 'commit', '-q', '-m', msg],
    { cwd: dir, env: cleanEnv() },
  );
}

// A throwaway repo carrying enough of the real tree shape that every gate's closure resolves.
// EVERY path of a gate's closure must exist here, not merely one: plan 2509 made gateVerdict's
// no-gated-tree refusal all-present rather than any-present, so a fixture missing a single blob
// makes that whole gate uncacheable and its cases assert on the wrong branch.
function tmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cache-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: cleanEnv() });
  for (const d of [
    'backend/src',
    'backend/scripts',
    'backend/src/data',
    'shared/src',
    'frontend/src',
    'frontend/scripts',
    'scripts',
    'scripts/coord',
    'backend/tests',
  ])
    mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'frontend/scripts/verify-mobile-gate.mjs'), PROBE_STUB);
  // The mobile gate's closure also keys the harness's two cross-package imports (see its GATES
  // entry). Content is irrelevant — only presence and oid stability are.
  writeFileSync(join(dir, 'scripts/verify-mobile-watched.mjs'), 'export const watched = [];\n');
  writeFileSync(join(dir, 'scripts/coord/kill-tree.mjs'), 'export const killTree = () => {};\n');
  // plan 4088 (gpt-review 299b81/5a6cee/aaefc5): vitest-frontend-full keys its own RUNNER the
  // same way — a change to the worker count the frontend config reads, to the report parser, or
  // to the crash classifier must not be served a cached green. Same deal as the two above:
  // presence and oid stability are all that matter, not content.
  writeFileSync(join(dir, 'scripts/run-land-tests.mjs'), 'export const runLandTests = () => {};\n');
  writeFileSync(join(dir, 'scripts/pytest-workers.mjs'), 'export const workers = 1;\n');
  writeFileSync(join(dir, 'scripts/coord/cpu-budget.mjs'), 'export const cpus = () => 1;\n');
  writeFileSync(join(dir, 'scripts/coord/test-queue.mjs'), 'export const budget = 1;\n');
  writeFileSync(
    join(dir, 'backend/tests/land-gate-unhandled-errors-reporter.mjs'),
    'export default class R {}\n',
  );
  writeFileSync(join(dir, 'backend/src/app.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'backend/scripts/x.py'), 'x = 1\n');
  writeFileSync(join(dir, 'backend/scripts/requirements.txt'), 'pytest\n');
  writeFileSync(join(dir, 'backend/src/data/seed.json'), '{}\n');
  writeFileSync(join(dir, 'shared/src/schemas.ts'), 'export const s = 1;\n');
  writeFileSync(join(dir, 'frontend/src/page.tsx'), 'export default () => null;\n');
  writeFileSync(join(dir, 'backend/tsconfig.json'), '{}\n');
  writeFileSync(join(dir, 'shared/tsconfig.json'), '{}\n');
  writeFileSync(join(dir, 'frontend/tsconfig.json'), '{}\n');
  writeFileSync(join(dir, 'tsconfig.base.json'), '{}\n');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  commitAll(dir, 'init');
  return dir;
}

const cacheDirOf = (repo) => join(repo, '.git', 'gate-pass-cache');

const runCli = (repo, args, { env = {}, input } = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    env: { ...cleanEnv(), ...env },
    encoding: 'utf8',
    // plan 3766: `selection-key` is the first subcommand in this file that reads stdin — every
    // earlier caller of runCli passes no `input`, which leaves spawnSync's default (an
    // already-closed pipe, i.e. immediate EOF) exactly as before this addition.
    ...(input === undefined ? {} : { input }),
  });

// check → record in one step; returns the minted key.
function recordPass(repo, gate) {
  const key = runCli(repo, ['check', '--gate', gate]).stdout.trim();
  runCli(repo, ['record', '--gate', gate, '--key', key, '--label', 'test']);
  return key;
}

// ── plan 3958 review fix (keys 1y0pqy0/15wuu8d/1pcaz3t) ────────────────────────────────────────
// gate-pass-cache.mjs's main() self-resolves its gate registry via
// `gatesFrom(loadCoordConfig(repoRootFrom(import.meta.dirname)))` — the SCRIPT FILE's own
// location, never the spawned process's cwd, and never a fixture repo's own coord.config.json
// (empirically verified, plan 3958 review). Every OTHER CLI case in this file therefore only
// ever exercises whichever coord.config.json happens to sit above wherever THIS test file's
// `CLI` constant (`resolve(import.meta.dirname, 'gate-pass-cache.mjs')`) currently lives —
// genuine vetapp coverage in this checkout, but silently wrong (or vacuous) inside a BUILT
// coord-kit copy, whose shipped root coord.config.json carries no gates at all (the generic
// core's own `DEFAULT_GATES` is `{}`). The three regressions restored below (b7976fdae6b
// removed them for exactly that reason) instead carry their OWN fixture repo AND their OWN
// coord.config.json, built via the isolated-plan-repo scaffold: `makeIsolatedRepo` copies the
// WHOLE scripts/ tool tree — including a COPY of this very gate-pass-cache.mjs — into the
// fixture, so that copy's own self-resolution walks up from ITS OWN (fixture) location and
// finds the fixture's config, never whatever config happens to sit above the real checkout.
// Portable in vetapp AND inside the built kit alike.
function portableGateRepo() {
  const iso = makeIsolatedRepo({
    prefix: 'gate-cache-portable',
    basename: 'seed.md',
    body: '# seed\n',
    coordConfig: { gates: RAW_GATES_FIXTURE },
  });
  const dir = iso.dir;
  // Mirrors tmpRepo()'s own closure-completeness fixture (see its header comment) IN FULL,
  // writing every DATA-only closure path unconditionally rather than trusting the copied
  // scripts/ tree to supply some of them — a real vetapp checkout's scripts/ carries
  // verify-mobile-watched.mjs, run-land-tests.mjs, and pytest-workers.mjs, but a BUILT
  // coord-kit copy does not (they are vetapp-only, excluded from the shipped subset), which
  // silently made the mobile-gate closure incomplete (`no-gated-tree`) the first time this test
  // ran inside the kit — the probe still answered correctly, but the closure completeness check
  // downstream of it then failed loud with an empty key.
  //
  // `scripts/coord/kill-tree.mjs` (and its own siblings `scripts/coord/cpu-budget.mjs` /
  // `scripts/coord/test-queue.mjs`) are deliberately EXCLUDED from this stub-write list, despite
  // also being closure paths — kill-tree.mjs is a REAL import of coord-git.mjs (`import {
  // procStatFields, killProcessTree } from './kill-tree.mjs'`), itself imported by
  // coord-config.mjs, itself imported by gate-pass-cache.mjs: overwriting it with a stub lacking
  // those exports crashed the COPIED gate-pass-cache.mjs subprocess outright (every CLI call
  // failed, not just the mobile gate's). Because it is a real import, it — and its siblings,
  // copied alongside it as part of the SAME scripts/coord/ directory — are always present for
  // real via makeIsolatedRepo's copyScriptsTree in EITHER environment (gate-pass-cache.mjs could
  // not itself load without them), so no stub is needed.
  for (const d of [
    'backend/src',
    'backend/scripts',
    'backend/src/data',
    'shared/src',
    'frontend/src',
    'frontend/scripts',
    'backend/tests',
  ])
    mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'scripts/verify-mobile-watched.mjs'), 'export const watched = [];\n');
  writeFileSync(join(dir, 'scripts/run-land-tests.mjs'), 'export const runLandTests = () => {};\n');
  writeFileSync(join(dir, 'scripts/pytest-workers.mjs'), 'export const workers = 1;\n');
  writeFileSync(join(dir, 'frontend/scripts/verify-mobile-gate.mjs'), PROBE_STUB);
  writeFileSync(
    join(dir, 'backend/tests/land-gate-unhandled-errors-reporter.mjs'),
    'export default class R {}\n',
  );
  writeFileSync(join(dir, 'backend/src/app.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'backend/scripts/x.py'), 'x = 1\n');
  writeFileSync(join(dir, 'backend/scripts/requirements.txt'), 'pytest\n');
  writeFileSync(join(dir, 'backend/src/data/seed.json'), '{}\n');
  writeFileSync(join(dir, 'shared/src/schemas.ts'), 'export const s = 1;\n');
  writeFileSync(join(dir, 'frontend/src/page.tsx'), 'export default () => null;\n');
  writeFileSync(join(dir, 'backend/tsconfig.json'), '{}\n');
  writeFileSync(join(dir, 'shared/tsconfig.json'), '{}\n');
  writeFileSync(join(dir, 'frontend/tsconfig.json'), '{}\n');
  writeFileSync(join(dir, 'tsconfig.base.json'), '{}\n');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  iso.g('add', '-A');
  iso.g('commit', '-qm', 'gate closure fixture tree');
  return { dir, g: iso.g, cli: iso.toolPath('gate-pass-cache.mjs'), cleanup: iso.cleanup };
}

const portableRunCli = (repo, args, { env = {}, input } = {}) =>
  spawnSync(process.execPath, [repo.cli, ...args], {
    cwd: repo.dir,
    env: { ...cleanEnv(), ...env },
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });

function portableRecordPass(repo, gate) {
  const key = portableRunCli(repo, ['check', '--gate', gate]).stdout.trim();
  portableRunCli(repo, ['record', '--gate', gate, '--key', key, '--label', 'test']);
  return key;
}

function portableCommitAll(repo, msg) {
  repo.g('add', '-A');
  repo.g('commit', '-qm', msg);
}

// A synthetic repo state, the shape gatherRepoState returns.
function stateOf({ oids = {}, dirty = [], exists = () => false } = {}) {
  return {
    ok: true,
    oids: new Map(Object.entries(oids)),
    gitVersion: 'git version 2.45.0',
    nodeMajor: 22,
    dirty,
    _existsSync: exists,
  };
}

const FULL_OIDS = Object.fromEntries(
  allKeyedPaths(GATES).map((p, i) => [p, `${i}`.padStart(40, 'a')]),
);

// --- the registry itself -----------------------------------------------------

test('plan 2462: every gate declares a non-empty input closure and a description', () => {
  assert.ok(GATE_NAMES.length >= 8, 'expected the full expensive-gate roster');
  for (const g of GATE_NAMES) {
    assert.ok(GATES[g].paths.length > 0, `${g} has no closure`);
    assert.equal(typeof GATES[g].desc, 'string');
    assert.ok(GATES[g].desc.length > 0, `${g} has no desc`);
  }
});

test('plan 2462: every JS gate keys the lockfile (the tool-version proxy)', () => {
  // The lockfile stands in for typescript/vitest/next/playwright versions — a bump must miss.
  for (const g of GATE_NAMES) {
    const p = GATES[g].paths;
    const proxied = p.includes('pnpm-lock.yaml') || p.includes('backend/scripts/requirements.txt');
    assert.ok(proxied, `${g} keys no tool-version proxy — a version bump would stale-green it`);
  }
});

test('allKeyedPaths is the deduped sorted union of every closure', () => {
  const all = allKeyedPaths(GATES);
  assert.deepEqual(all, [...new Set(all)].sort(), 'not deduped/sorted');
  for (const g of GATE_NAMES) for (const p of GATES[g].paths) assert.ok(all.includes(p));
});

test('plan 2491: the mobile gate is cached ONLY as a probe-gated entry', () => {
  // Plan 2462 left this gate out entirely: verify-mobile-gate.mjs exits 0 both when T1-T7
  // passed and when it decided the gate was not required for its range and never launched
  // WebKit, and a content-addressed entry cannot tell those apart. Plan 2491 re-adds it with
  // the disambiguating probe attached — so "is it in the registry" is no longer the invariant;
  // "it can never be in the registry WITHOUT a probe" is.
  assert.ok(GATE_NAMES.includes(MOBILE_GATE), 'the mobile gate should be cacheable now');
  assert.equal(
    typeof GATES[MOBILE_GATE].probe,
    'function',
    'STALE GREEN: the mobile gate is cached with NO required-vs-not probe — its exit 0 is ' +
      'ambiguous, so a self-no-op run would be recordable as a real T1-T7 pass (plan 2462)',
  );
  assert.deepEqual(
    PROBE_GATES,
    [MOBILE_GATE],
    'a new probe-gated gate needs its own wiring review',
  );
  assert.ok(
    !CHECK_ALL_GATES.includes(MOBILE_GATE),
    'the battery fast path must not decide a probe-gated gate — it runs no probe',
  );
});

test('plan 2491: the mobile-gate closure keys what the WebKit run actually reads', () => {
  const p = GATES[MOBILE_GATE].paths;
  // The dev server compiles the whole frontend (harness included) and shared; `predev` runs
  // generate-clinic-index.ts over the sharded seed, so seed content decides whether the server
  // even starts. Missing any of these would be a stale green, not just a missed hit.
  for (const need of ['frontend', 'shared', 'backend/src/data', 'pnpm-lock.yaml'])
    assert.ok(p.includes(need), `mobile-gate closure is missing ${need}`);
  assert.ok(
    (GATES[MOBILE_GATE].envUncacheable ?? []).includes('frontend/.env.local'),
    'the dev server reads frontend/.env.local — gitignored content git cannot key',
  );
});

// --- the required-vs-not-required probe (plan 2491) ---------------------------

test('parseRequiredProbe: a definite answer only; silence and contradiction are UNKNOWN', () => {
  assert.equal(parseRequiredProbe('verify-mobile-gate: required=true'), true);
  assert.equal(
    parseRequiredProbe('some surface changed\nverify-mobile-gate: required=false\n'),
    false,
  );
  assert.equal(parseRequiredProbe(''), null, 'no answer is not "not required"');
  assert.equal(parseRequiredProbe('gate not required.'), null, 'prose is not an answer');
  assert.equal(parseRequiredProbe(undefined), null);
  assert.equal(
    parseRequiredProbe('required=true\nrequired=false'),
    null,
    'contradictory output is doubt, not a majority vote',
  );
  assert.equal(parseRequiredProbe('required=maybe'), null);
});

test('probeVerdict: only a definite `required` is cacheable; every other answer refuses', () => {
  const withProbe = (r) => probeVerdict(MOBILE_GATE, GATES, { _probe: () => r });
  assert.ok(withProbe({ required: true, reason: 'required' }).ok);
  assert.equal(withProbe({ required: false, reason: 'not-required' }).reason, 'gate-not-required');
  assert.equal(withProbe({ required: null, reason: 'probe-failed' }).reason, 'probe-failed');
  assert.equal(
    withProbe({ required: null, reason: 'verify-mobile-skip' }).reason,
    'verify-mobile-skip',
  );
  assert.equal(
    withProbe({ required: null }).reason,
    'probe-failed',
    'a reasonless null still refuses',
  );
  // A gate with no probe passes straight through, so callers can call this unconditionally.
  assert.ok(probeVerdict('tsc-backend', GATES).ok);
  assert.equal(probeVerdict('no-such-gate', GATES).reason, 'unknown-gate');
});

test('probeMobileRequired: the documented VERIFY_MOBILE_SKIP bypass is never recordable', () => {
  // VERIFY_MOBILE_SKIP=1 makes the RUN exit 0 without launching WebKit even on a watched diff —
  // the same ambiguity as the no-op path, one env var away. It must refuse before the spawn.
  const prev = process.env.VERIFY_MOBILE_SKIP;
  process.env.VERIFY_MOBILE_SKIP = '1';
  try {
    const r = probeMobileRequired({
      _spawn: () => assert.fail('must refuse BEFORE spawning the probe'),
      _existsSync: () => true,
    });
    assert.deepEqual(r, { required: null, reason: 'verify-mobile-skip' });
  } finally {
    if (prev === undefined) delete process.env.VERIFY_MOBILE_SKIP;
    else process.env.VERIFY_MOBILE_SKIP = prev;
  }
});

test('probeMobileRequired: no probeScript configured is UNKNOWN, never a crash (plan 4071 T4/D5)', () => {
  // The config-authoring gap: a gate entry named `probe: "mobile-required"` but no `probeScript`.
  // Degrades exactly like an absent file — no spawn is even attempted.
  assert.deepEqual(probeMobileRequired({ _spawn: () => assert.fail('must not spawn') }), {
    required: null,
    reason: 'probe-script-absent',
  });
});

test('probeMobileRequired: an absent, crashing, or non-zero probe is UNKNOWN (never "not required")', () => {
  const PROBE_SCRIPT = 'frontend/scripts/verify-mobile-gate.mjs';
  assert.deepEqual(probeMobileRequired({ probeScript: PROBE_SCRIPT, _existsSync: () => false }), {
    required: null,
    reason: 'probe-script-absent',
  });
  const opts = { probeScript: PROBE_SCRIPT, _existsSync: () => true };
  assert.equal(
    probeMobileRequired({
      ...opts,
      _spawn: () => {
        throw new Error('spawn EPERM');
      },
    }).reason,
    'probe-failed',
  );
  assert.equal(
    probeMobileRequired({ ...opts, _spawn: () => ({ status: 1, stdout: 'required=true' }) }).reason,
    'probe-failed',
    'a non-zero probe must not be trusted even when it printed an answer',
  );
  assert.equal(
    probeMobileRequired({ ...opts, _spawn: () => ({ status: 0, stdout: 'hello' }) }).reason,
    'probe-unparseable',
  );
  assert.deepEqual(
    probeMobileRequired({
      ...opts,
      _spawn: () => ({ status: 0, stdout: 'verify-mobile-gate: required=true\n' }),
    }),
    { required: true, reason: 'required' },
  );
});

// --- pure helpers ------------------------------------------------------------

test('pathCovers matches a blob exactly and anything under a tree, never a sibling prefix', () => {
  assert.ok(pathCovers('backend/src', 'backend/src/app.ts'));
  assert.ok(pathCovers('pnpm-lock.yaml', 'pnpm-lock.yaml'));
  assert.ok(!pathCovers('backend/src', 'backend/srcfoo/app.ts'), 'sibling prefix must not match');
  assert.ok(!pathCovers('backend/src', 'backend'), 'a parent is not covered by its child');
  assert.ok(!pathCovers('frontend', 'backend/src/app.ts'));
});

test('parseStatusPaths reads porcelain, keeps BOTH rename sides, unquotes odd paths', () => {
  const out = parseStatusPaths(
    ' M backend/src/app.ts\n?? frontend/src/new.tsx\nR  old/a.ts -> shared/src/b.ts\n',
  );
  assert.deepEqual(out, [
    'backend/src/app.ts',
    'frontend/src/new.tsx',
    'old/a.ts',
    'shared/src/b.ts',
  ]);
  assert.deepEqual(parseStatusPaths(' M "backend/src/\\303\\244.ts"\n').length, 1);
});

test('REGRESSION (plan 2462): a rename OUT of a closure dirties the SOURCE gate too', () => {
  // `git mv backend/src/util.ts scripts/util.ts`, staged but uncommitted. Keeping only the
  // rename DESTINATION (the first cut) left tsc-backend/vitest/pytest looking clean while the
  // tree those gates actually compile no longer had the file — a stale green.
  const st = stateOf({
    oids: FULL_OIDS,
    dirty: parseStatusPaths('R  backend/src/util.ts -> scripts/util.ts\n'),
  });
  assert.equal(gateVerdict(st, 'tsc-backend', GATES).reason, 'dirty-gated-paths');
  assert.equal(gateVerdict(st, 'vitest-backend-full', GATES).reason, 'dirty-gated-paths');
});

test('parseStatusPaths keeps an unparseable quoted path rather than dropping it', () => {
  // A DROPPED dirty path is a stale green; a spurious one only costs a hit. Keep it.
  const out = parseStatusPaths(' M "unterminated\n');
  assert.equal(out.length, 1);
});

test('parseBatchCheck maps positionally and treats missing/ambiguous as absent', () => {
  const paths = ['backend/src', 'pnpm-lock.yaml', 'gone'];
  const m = parseBatchCheck(
    paths,
    `${'a'.repeat(40)} tree 519\n${'b'.repeat(40)} blob 22\nHEAD:gone missing\n`,
  );
  assert.equal(m.get('backend/src'), 'a'.repeat(40));
  assert.equal(m.get('pnpm-lock.yaml'), 'b'.repeat(40));
  assert.equal(m.has('gone'), false, 'missing must be absent, never a bogus oid');
  // Truncated output must not shift the mapping onto the wrong paths.
  const short = parseBatchCheck(paths, `${'c'.repeat(40)} tree 1\n`);
  assert.equal(short.get('backend/src'), 'c'.repeat(40));
  assert.equal(short.size, 1);
});

// --- the key -----------------------------------------------------------------

test('the gate NAME is in the key: two gates with identical closures never collide', () => {
  // tsc-backend and tsc-shared read the exact same trees. If the name were not keyed, one's
  // green would satisfy the other's lookup — a stale green across two different verdicts.
  assert.deepEqual([...GATES['tsc-backend'].paths], [...GATES['tsc-shared'].paths]);
  const args = { oids: new Map(Object.entries(FULL_OIDS)), nodeMajor: 22, gitVersion: 'g' };
  const a = computeGateKey({ gates: GATES, gate: 'tsc-backend', ...args });
  const b = computeGateKey({ gates: GATES, gate: 'tsc-shared', ...args });
  assert.notEqual(a.key, b.key);
});

test('a moved oid in the closure changes the key; an unrelated path does not', () => {
  const base = new Map(Object.entries(FULL_OIDS));
  const k0 = computeGateKey({
    gates: GATES,
    gate: 'pytest-backend-scripts',
    oids: base,
    nodeMajor: 22,
    gitVersion: 'g',
  }).key;
  const moved = new Map(base);
  moved.set('backend/scripts', 'ffffffff');
  const k1 = computeGateKey({
    gates: GATES,
    gate: 'pytest-backend-scripts',
    oids: moved,
    nodeMajor: 22,
    gitVersion: 'g',
  }).key;
  assert.notEqual(k0, k1, 'a closure path moving must miss');
  const unrelated = new Map(base);
  unrelated.set('frontend/src', 'ffffffff'); // not in the pytest closure
  const k2 = computeGateKey({
    gates: GATES,
    gate: 'pytest-backend-scripts',
    oids: unrelated,
    nodeMajor: 22,
    gitVersion: 'g',
  }).key;
  assert.equal(k0, k2, 'a path outside the closure must NOT invalidate — that is the whole win');
});

test('an absent path hashes as absent and cannot collide with it being present', () => {
  const present = new Map(Object.entries(FULL_OIDS));
  const absent = new Map(present);
  absent.delete('pnpm-lock.yaml');
  const a = computeGateKey({
    gates: GATES,
    gate: 'tsc-backend',
    oids: present,
    nodeMajor: 22,
    gitVersion: 'g',
  });
  const b = computeGateKey({
    gates: GATES,
    gate: 'tsc-backend',
    oids: absent,
    nodeMajor: 22,
    gitVersion: 'g',
  });
  assert.notEqual(a.key, b.key);
  assert.equal(b.components.oids['pnpm-lock.yaml'], 'absent');
});

test('node major and git version are keyed', () => {
  const oids = new Map(Object.entries(FULL_OIDS));
  const k = (over) =>
    computeGateKey({
      gates: GATES,
      gate: 'tsc-backend',
      oids,
      nodeMajor: 22,
      gitVersion: 'g',
      ...over,
    }).key;
  assert.notEqual(k(), k({ nodeMajor: 23 }));
  assert.notEqual(k(), k({ gitVersion: 'g2' }));
});

test('the key format version is hashed in, so a bump orphans old entries', () => {
  const c = computeGateKey({
    gates: GATES,
    gate: 'tsc-backend',
    oids: new Map(Object.entries(FULL_OIDS)),
    nodeMajor: 22,
    gitVersion: 'g',
  }).components;
  assert.equal(c.v, KEY_FORMAT_VERSION);
});

test('computeGateKey refuses an unknown gate rather than minting a key', () => {
  assert.throws(() =>
    computeGateKey({ gates: GATES, gate: 'nope', oids: new Map(), nodeMajor: 22, gitVersion: 'g' }),
  );
});

// plan 4071 review round 1 (finding e14223): the gate DEFINITION (desc/envUncacheable/probe/
// probeScript) is config data now, not a frozen literal in gate-pass-cache.mjs — so redefining a
// gate must invalidate its key even when its content closure (`paths`, and therefore `oids`) is
// byte-identical. Before this fix, deleting `probe: "mobile-required"` from the mobile gate's
// config row kept the SAME key: a later `check` would then read a stale HIT recorded under the
// gate's OLD (probe-gated) shape without ever consulting `probeVerdict` again.
test('plan 4071 review round 1 (finding e14223): two registries differing only in probe/probeScript key differently', () => {
  const oids = new Map(Object.entries(FULL_OIDS));
  const args = { gate: MOBILE_GATE, oids, nodeMajor: 22, gitVersion: 'g' };

  const {
    probe: _probe,
    probeScript: _probeScript,
    ...mobileWithoutProbe
  } = RAW_GATES_FIXTURE[MOBILE_GATE];
  const gatesWithoutProbe = gatesFrom({
    gates: { ...RAW_GATES_FIXTURE, [MOBILE_GATE]: mobileWithoutProbe },
  });
  const gatesDifferentScript = gatesFrom({
    gates: {
      ...RAW_GATES_FIXTURE,
      [MOBILE_GATE]: {
        ...RAW_GATES_FIXTURE[MOBILE_GATE],
        probeScript: 'frontend/scripts/some-other-gate.mjs',
      },
    },
  });

  const keyWithProbe = computeGateKey({ ...args, gates: GATES }).key;
  const keyWithoutProbe = computeGateKey({ ...args, gates: gatesWithoutProbe }).key;
  const keyDifferentScript = computeGateKey({ ...args, gates: gatesDifferentScript }).key;

  assert.notEqual(
    keyWithProbe,
    keyWithoutProbe,
    'dropping a gate’s probe must invalidate its key even though paths/oids are unchanged',
  );
  assert.notEqual(
    keyWithProbe,
    keyDifferentScript,
    'changing probeScript alone (same probe name, same paths) must invalidate the key too',
  );
});

// Review fix round 2 (4071, finding 19bc63/2c054e): the round-1 fix above hashes the gate's
// DEFINITION (desc/envUncacheable/probeName/probeScript — i.e. probeScript's NAME) but, before
// this fix, never the probe script's CONTENT — so editing `frontend/scripts/verify-mobile-gate.mjs`
// with the mobile gate's `paths` closure unchanged reused a stale key. vetapp's real mobile gate
// happens to have its `probeScript` nested inside `frontend`, already one of its own `paths`
// entries, so this pins the fix at the level that actually matters: the SAME oids map, with only
// the probe script's own oid changed (standing in for an edit to that one file — every other
// closure member is byte-identical), must move the key.
test('plan 4071 review round 2 (finding 19bc63/2c054e): editing only the probe script CONTENT (paths closure otherwise unchanged) must move the mobile-gate key', () => {
  const probeScript = GATES[MOBILE_GATE].probeScript;
  assert.equal(
    probeScript,
    'frontend/scripts/verify-mobile-gate.mjs',
    'fixture drifted — re-check this test against the real mobile-gate config',
  );
  const args = { gate: MOBILE_GATE, nodeMajor: 22, gitVersion: 'g', gates: GATES };

  const baseOids = new Map(Object.entries(FULL_OIDS));
  const keyBefore = computeGateKey({ ...args, oids: baseOids }).key;

  const editedOids = new Map(baseOids);
  editedOids.set(probeScript, 'b'.repeat(40));
  const keyAfter = computeGateKey({ ...args, oids: editedOids }).key;

  assert.notEqual(
    keyBefore,
    keyAfter,
    'STALE GREEN: editing the probe script content alone must move the key, not only editing ' +
      'its NAME (probeScript) or the rest of the paths closure',
  );
});

// Same defect, proven at the level that matters for a gate whose probeScript is NOT already
// nested inside one of its own `paths` entries — vetapp's only probe-gated gate happens to have
// that overlap, which could mask the general mechanism being broken for any future gate that
// doesn't. A synthetic registry closes that gap: the probe script here sits entirely outside the
// gate's own `paths`, so before this fix its content could never move the key at all.
test('plan 4071 review round 2 (finding 19bc63/2c054e): a probeScript OUTSIDE the gate’s own `paths` still keys its content', () => {
  const gatesOutsideProbe = gatesFrom({
    gates: {
      ...RAW_GATES_FIXTURE,
      [MOBILE_GATE]: {
        ...RAW_GATES_FIXTURE[MOBILE_GATE],
        paths: RAW_GATES_FIXTURE[MOBILE_GATE].paths.filter((p) => p !== 'frontend'),
        probeScript: 'tools/mobile-probe.mjs',
      },
    },
  });
  const args = { gate: MOBILE_GATE, nodeMajor: 22, gitVersion: 'g', gates: gatesOutsideProbe };

  assert.ok(
    !gatesOutsideProbe[MOBILE_GATE].paths.includes('tools/mobile-probe.mjs'),
    'the synthetic probeScript must genuinely sit outside `paths` for this test to mean anything',
  );

  const baseOids = new Map(Object.entries(FULL_OIDS));
  baseOids.set('tools/mobile-probe.mjs', 'c'.repeat(40));
  const keyBefore = computeGateKey({ ...args, oids: baseOids }).key;

  const editedOids = new Map(baseOids);
  editedOids.set('tools/mobile-probe.mjs', 'd'.repeat(40));
  const keyAfter = computeGateKey({ ...args, oids: editedOids }).key;

  assert.notEqual(
    keyBefore,
    keyAfter,
    'a probeScript living outside the gate’s own `paths` closure must still move the key when ' +
      'its content changes — the closure is `paths` PLUS `probeScript`, not `paths` alone',
  );
  assert.deepEqual(
    allKeyedPaths(gatesOutsideProbe).includes('tools/mobile-probe.mjs'),
    true,
    'allKeyedPaths must include a probeScript that lives outside every gate’s `paths`, so the ' +
      'one shared git status/cat-file gather actually resolves its oid',
  );
});

// --- deriveSelectionKey (plan 3766) -------------------------------------------
//
// A SUBSET pytest run's per-file ledger proof must be keyed on (content key, exact sorted
// selection), never on the bare content key alone — see this module's own header comment on
// deriveSelectionKey for the full soundness argument. Every case below defends one edge of it.

const SOME_CONTENT_KEY = '0123456789abcdef0123456789abcdef';

test('deriveSelectionKey: 32-lowercase-hex, deterministic, order- and duplicate-insensitive', () => {
  const key = deriveSelectionKey({
    gate: 'pytest-backend-scripts',
    contentKey: SOME_CONTENT_KEY,
    files: ['b.py', 'a.py'],
  });
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(
    key,
    deriveSelectionKey({
      gate: 'pytest-backend-scripts',
      contentKey: SOME_CONTENT_KEY,
      files: ['a.py', 'b.py'],
    }),
    'reordering the selection must yield the identical key (a re-collected same-content re-push ' +
      'may hand the paths back in a different order)',
  );
  assert.equal(
    key,
    deriveSelectionKey({
      gate: 'pytest-backend-scripts',
      contentKey: SOME_CONTENT_KEY,
      files: ['b.py', 'a.py', 'a.py'],
    }),
    'a duplicated entry must not change the key',
  );
});

test('deriveSelectionKey: never collides with the bare content key it derives from', () => {
  const selectionKey = deriveSelectionKey({
    gate: 'pytest-backend-scripts',
    contentKey: SOME_CONTENT_KEY,
    files: ['a.py'],
  });
  assert.notEqual(
    selectionKey,
    SOME_CONTENT_KEY,
    'a FULL run over this same content key must never read a SUBSET green as its own',
  );
});

test('deriveSelectionKey: a broader (or narrower) selection over identical content keys differently', () => {
  const narrow = deriveSelectionKey({
    gate: 'pytest-backend-scripts',
    contentKey: SOME_CONTENT_KEY,
    files: ['a.py'],
  });
  const broader = deriveSelectionKey({
    gate: 'pytest-backend-scripts',
    contentKey: SOME_CONTENT_KEY,
    files: ['a.py', 'b.py'],
  });
  assert.notEqual(
    narrow,
    broader,
    'a later broader (or a differently-scoped narrower) subset over the identical content must ' +
      'never satisfy — or be satisfied by — a green banked under the other selection',
  );
});

test('deriveSelectionKey: a different content key yields a different key over the identical selection', () => {
  const files = ['a.py'];
  const keyA = deriveSelectionKey({
    gate: 'pytest-backend-scripts',
    contentKey: '1'.repeat(32),
    files,
  });
  const keyB = deriveSelectionKey({
    gate: 'pytest-backend-scripts',
    contentKey: '2'.repeat(32),
    files,
  });
  assert.notEqual(keyA, keyB, 'a rebase/new-commit content change must start the file set over');
});

// --- the `selection-key` CLI (plan 3766) --------------------------------------

test('selection-key: round-trips a real selection to the same 32-hex key deriveSelectionKey computes', () => {
  const repo = tmpRepo();
  const files = ['backend/scripts/tests/test_a.py', 'backend/scripts/tests/test_b.py'];
  const result = runCli(
    repo,
    ['selection-key', '--gate', 'pytest-backend-scripts', '--key', SOME_CONTENT_KEY],
    { input: `${files.join('\n')}\n` },
  );
  assert.equal(result.status, 0, result.stderr);
  const key = result.stdout.trim();
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(
    key,
    deriveSelectionKey({ gate: 'pytest-backend-scripts', contentKey: SOME_CONTENT_KEY, files }),
  );
});

test('selection-key: CRLF- and blank-line-tolerant stdin yields the identical key', () => {
  const repo = tmpRepo();
  const withCrlf = runCli(
    repo,
    ['selection-key', '--gate', 'pytest-backend-scripts', '--key', SOME_CONTENT_KEY],
    { input: 'backend/scripts/tests/test_a.py\r\n\r\nbackend/scripts/tests/test_b.py\r\n' },
  );
  const plain = runCli(
    repo,
    ['selection-key', '--gate', 'pytest-backend-scripts', '--key', SOME_CONTENT_KEY],
    { input: 'backend/scripts/tests/test_a.py\nbackend/scripts/tests/test_b.py\n' },
  );
  assert.equal(withCrlf.status, 0, withCrlf.stderr);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(withCrlf.stdout.trim(), plain.stdout.trim());
});

test('selection-key: fails closed (no stdout, non-zero) on a missing --gate', () => {
  const repo = tmpRepo();
  const result = runCli(repo, ['selection-key', '--key', SOME_CONTENT_KEY], {
    input: 'backend/scripts/tests/test_a.py\n',
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

test('selection-key: fails closed (no stdout, non-zero) on a missing --key', () => {
  const repo = tmpRepo();
  const result = runCli(repo, ['selection-key', '--gate', 'pytest-backend-scripts'], {
    input: 'backend/scripts/tests/test_a.py\n',
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

test('selection-key: fails closed (no stdout, non-zero) on a malformed --key', () => {
  const repo = tmpRepo();
  // Includes the two near-miss shapes this plan exists to catch (its own header comment): a raw
  // 64-hex sha256 (never truncated) and an uppercase-hex key — both LOOK key-shaped but are not
  // the exact 32-lowercase-hex shape battery-ledger.mjs silently treats as malformed.
  for (const badKey of [
    'not-hex-at-all',
    '0123456789abcdef0123456789abcde', // 31 chars — one short
    'A'.repeat(32), // uppercase
    'a'.repeat(64), // a full, untruncated sha256 hex digest
  ]) {
    const result = runCli(
      repo,
      ['selection-key', '--gate', 'pytest-backend-scripts', '--key', badKey],
      { input: 'backend/scripts/tests/test_a.py\n' },
    );
    assert.notEqual(result.status, 0, `expected non-zero for --key ${JSON.stringify(badKey)}`);
    assert.equal(result.stdout, '', `expected no stdout for --key ${JSON.stringify(badKey)}`);
  }
});

test('selection-key: fails closed (no stdout, non-zero) on an empty selection', () => {
  const repo = tmpRepo();
  const result = runCli(
    repo,
    ['selection-key', '--gate', 'pytest-backend-scripts', '--key', SOME_CONTENT_KEY],
    { input: '\n  \n\t\n' },
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

// gpt-review finding 7f2520 (CONFIRMED, blocksLand): `selection-key` used the FAIL-OPEN
// `readStdin()` wrapper, which returns `.raw` even when `readStdinResult()` reports `ok: false`.
// A pipe read that dies AFTER delivering part of the selection therefore yielded a TRUNCATED
// file list, and the CLI happily exited 0 with a key derived from it — a key describing a
// narrower selection than the run it is about to vouch for. That is the exact opposite of this
// command's stated contract, and of the hook's "fail direction is always run more" rule: the
// only safe reading of a failed read is "I do not know the selection", which must fail closed to
// an EMPTY ledger key. `select-battery-tests.mjs` reaches for `readStdinResult` for this same
// reason. These cases pin the discriminated-result handling directly, because the truncation is
// unreachable through the subprocess `runCli` seam (fd 0 cannot be made to fail mid-read there).
test('selectionFilesFromStdin: a FAILED read fails closed even when partial input arrived', () => {
  // The regression itself: ok:false with real content. Pre-fix this returned the truncated list.
  assert.equal(
    selectionFilesFromStdin({ ok: false, raw: 'backend/scripts/tests/test_a.py\n' }),
    null,
  );
  // ...and a failed read that delivered nothing is equally unknown, not "empty".
  assert.equal(selectionFilesFromStdin({ ok: false, raw: '' }), null);
});

test('selectionFilesFromStdin: a successful read parses, trims and is CRLF-tolerant', () => {
  assert.deepEqual(
    selectionFilesFromStdin({
      ok: true,
      raw: 'backend/scripts/tests/test_a.py\r\n  backend/scripts/tests/test_b.py  \n\n',
    }),
    ['backend/scripts/tests/test_a.py', 'backend/scripts/tests/test_b.py'],
  );
});

test('selectionFilesFromStdin: a successful but EMPTY selection is null, not an empty list', () => {
  assert.equal(selectionFilesFromStdin({ ok: true, raw: '' }), null);
  assert.equal(selectionFilesFromStdin({ ok: true, raw: '\n  \n\t\n' }), null);
});

// --- liveness ----------------------------------------------------------------

test('isLive: fresh yes, expired no, unparseable no, FUTURE no', () => {
  assert.ok(isLive({ iso: ISO }, at(10)));
  assert.ok(!isLive({ iso: ISO }, at(DEFAULT_TTL_MIN + 1)));
  assert.ok(!isLive({ iso: 'garbage' }, at(1)), 'unknown age must not skip a gate');
  // Clock skew (VM resume, NTP): a future stamp must never read as permanently fresh.
  assert.ok(!isLive({ iso: ISO }, at(-10)));
  assert.ok(!isLive(null, at(1)));
});

test('parseEntry treats corrupt JSON and shapeless objects as absent', () => {
  assert.equal(parseEntry('{'), null);
  assert.equal(parseEntry('{"no":"iso"}'), null);
  assert.equal(parseEntry(JSON.stringify({ iso: ISO })).iso, ISO);
});

// --- gateVerdict: the refusal matrix -----------------------------------------

test('gateVerdict refuses an unknown gate', () => {
  assert.deepEqual(gateVerdict(stateOf({ oids: FULL_OIDS }), 'nope', GATES), {
    ok: false,
    reason: 'unknown-gate',
  });
});

test('gateVerdict: dirt in the gate closure refuses, and is SCOPED to that gate', () => {
  const st = stateOf({ oids: FULL_OIDS, dirty: ['backend/src/app.ts'] });
  assert.equal(gateVerdict(st, 'tsc-backend', GATES).reason, 'dirty-gated-paths');
  assert.equal(gateVerdict(st, 'vitest-backend-full', GATES).reason, 'dirty-gated-paths');
  // frontend closures do not contain backend/src — they must stay cacheable.
  assert.ok(
    gateVerdict(st, 'tsc-frontend', GATES).ok,
    'a backend edit must not block the frontend gate',
  );
  assert.ok(gateVerdict(st, 'next-build', GATES).ok);
  // plan 4088: the new full frontend suite is a frontend closure too — a backend-only push must
  // not pay 464 files. This is the acceptance criterion for that gate's diff scope, asserted on
  // the registry rather than by reading the hook's grep.
  assert.ok(
    gateVerdict(st, 'vitest-frontend-full', GATES).ok,
    'a backend edit must not run the full frontend suite',
  );
});

// plan 4088 — the other half of that scope, and the S1 split that makes a seed push stay cheap.
// The two frontend vitest gates carry DIFFERENT closures on purpose: the six-file seed-sanity
// tier is keyed on the seed (so a seed-only push runs it) while the full tier is not (so a
// seed-only push does not run 464 files). They are separate registry names precisely so their
// verdicts can never cross-satisfy — see this module's non-cross-satisfy comment.
test('gateVerdict (plan 4088): the two frontend vitest gates scope to different diffs', () => {
  const frontendEdit = stateOf({ oids: FULL_OIDS, dirty: ['frontend/src/lib/price/money.ts'] });
  assert.equal(
    gateVerdict(frontendEdit, 'vitest-frontend-full', GATES).reason,
    'dirty-gated-paths',
    'a frontend/src edit must run the full frontend suite',
  );

  // A frontend file OUTSIDE src/ — the full gate's closure is the whole package, the
  // seed-sanity gate's is `frontend/src` only.
  const configEdit = stateOf({ oids: FULL_OIDS, dirty: ['frontend/vitest.config.ts'] });
  assert.equal(gateVerdict(configEdit, 'vitest-frontend-full', GATES).reason, 'dirty-gated-paths');
  assert.ok(gateVerdict(configEdit, 'vitest-frontend-seed-sanity', GATES).ok);

  // A seed-only push: the cheap tier runs, the 464-file tier stays cached (plan 4088 S1).
  // The shard path is COMPOSED rather than written as one literal on purpose:
  // `assert-seed-io-seam.mjs` blocks any quoted string naming the sharded seed tree, and
  // rightly so — but this is a path FIXTURE for the dirty-set, not a seed read, so the
  // grandfather allowlist (which means "this script genuinely opens the seed by path") would
  // be the wrong home for it and would read as a false claim about this file.
  const seedShard = ['backend/src/data/seed', 'clinics', 'SE', 'clinic-001.json'].join('/');
  const seedEdit = stateOf({ oids: FULL_OIDS, dirty: [seedShard] });
  assert.equal(
    gateVerdict(seedEdit, 'vitest-frontend-seed-sanity', GATES).reason,
    'dirty-gated-paths',
  );
  assert.ok(
    gateVerdict(seedEdit, 'vitest-frontend-full', GATES).ok,
    'a seed-only push must not run the full frontend suite',
  );

  // shared/src reaches both, since the frontend imports it.
  const sharedEdit = stateOf({ oids: FULL_OIDS, dirty: ['shared/src/schemas.ts'] });
  assert.equal(gateVerdict(sharedEdit, 'vitest-frontend-full', GATES).reason, 'dirty-gated-paths');
  assert.equal(
    gateVerdict(sharedEdit, 'vitest-frontend-seed-sanity', GATES).reason,
    'dirty-gated-paths',
  );
});

test('gateVerdict: an untracked dirty file in the closure refuses too', () => {
  const st = stateOf({ oids: FULL_OIDS, dirty: ['backend/scripts/scratch.py'] });
  assert.equal(gateVerdict(st, 'pytest-backend-scripts', GATES).reason, 'dirty-gated-paths');
});

test('gateVerdict: a PRESENT gitignored env file makes next-build/mobile uncacheable', () => {
  // frontend/.env.local is content next build reads and git cannot key. Presence ⇒ refuse.
  // Compare through `join` on BOTH sides: since plan 2534 the production check calls
  // `exists(join(root, f))`, and with the default root of '.' that is `frontend\.env.local`
  // on Windows but `frontend/.env.local` on POSIX. A literal forward-slash expectation here
  // was green in CI and red on every Windows checkout (found 2026-07-27 — it was failing on
  // master, blocking the scripts node:test pre-push gate for any Windows diff touching
  // scripts/). `existsSync` itself accepts either separator, so this was never a production
  // bug — only a platform-dependent test fixture.
  const st = stateOf({ oids: FULL_OIDS, exists: (f) => f === join('.', 'frontend/.env.local') });
  assert.equal(gateVerdict(st, 'next-build', GATES).reason, 'untracked-env-file');
  // The WebKit gate drives the same dev server, which reads the same file (plan 2491).
  assert.equal(gateVerdict(st, MOBILE_GATE, GATES).reason, 'untracked-env-file');
  // ...but it is not in the tsc/pytest closures, so those are unaffected.
  assert.ok(gateVerdict(st, 'tsc-backend', GATES).ok);
  assert.ok(gateVerdict(st, 'pytest-backend-scripts', GATES).ok);
});

test('REGRESSION (plan 2534): gateVerdict anchors the envUncacheable exists() check to state.root', () => {
  // The bug: `exists(f)` was called with the bare repo-relative path, so a real `existsSync`
  // resolves it against the ambient process.cwd() rather than the repo root — unlike the
  // git-based oid gathering (HEAD:<path>), which is cwd-independent by construction. This case
  // proves the wiring directly: a spy `exists` records exactly what path it was asked about, and
  // it must be `state.root` joined with the closure's relative path, not the bare relative path.
  // Drive-QUALIFIED anchor (plan 2552): a bare '/repo/root' is drive-less, so a join-built
  // expectation would match only while gateVerdict itself joins. Anchoring root, spy, and
  // expectation to the same resolved value keeps the case honest under either primitive.
  const rootDir = resolve('/repo/root');
  const seen = [];
  const st = stateOf({
    oids: FULL_OIDS,
    exists: (f) => {
      seen.push(f);
      return f === join(rootDir, 'frontend/.env.local');
    },
  });
  st.root = rootDir;
  assert.equal(gateVerdict(st, 'next-build', GATES).reason, 'untracked-env-file');
  assert.deepEqual(seen, [join(rootDir, 'frontend/.env.local')]);
});

test('REGRESSION (plan 2534): gateVerdict without an explicit root defaults to "." (today\'s behavior)', () => {
  // A caller that builds a state directly (as every existing test here does, and as any future
  // caller not going through gatherRepoState would) must see unchanged behavior: no root ⇒ the
  // relative path, exactly as before this fix.
  //
  // Expressed as `join('.', …)` rather than a literal, for the same reason as the
  // PRESENT-gitignored-env-file test above: `join` normalises the separator per platform, so a
  // hardcoded 'frontend/.env.local' asserts POSIX and fails on Windows. "Unchanged behavior"
  // means the path is still repo-RELATIVE (not root-anchored) — which is what this compares.
  const RELATIVE_ENV = join('.', 'frontend/.env.local');
  const seen = [];
  const st = stateOf({
    oids: FULL_OIDS,
    exists: (f) => {
      seen.push(f);
      return f === RELATIVE_ENV;
    },
  });
  assert.equal(gateVerdict(st, 'next-build', GATES).reason, 'untracked-env-file');
  assert.deepEqual(seen, [RELATIVE_ENV]);
});

test('REGRESSION (plan 2534): the envUncacheable check finds the repo-root file from a non-repo-root cwd', () => {
  // The end-to-end proof: gatherRepoState resolves `root` via the injected `git` seam (cwd-
  // independent, exactly like its HEAD:<path> oid gathering), and gateVerdict anchors the real
  // `existsSync` to that root. Before the fix, existsSync(f) resolved against whatever the
  // ACTUAL process.cwd() was at call time — so running from a subdirectory (or, as here, from
  // an entirely unrelated directory) would silently miss a real, present gitignored env file,
  // exactly the "future caller invoking from a different cwd" the plan describes.
  const repo = tmpRepo();
  // A real, present, gitignored env file at the true repo root — untracked so the porcelain
  // status call also stays quiet about it (only its PRESENCE matters here).
  writeFileSync(join(repo, 'frontend/.env.local'), 'NEXT_PUBLIC_X=1\n');
  const elsewhere = mkdtempSync(join(tmpdir(), 'gate-cache-elsewhere-'));
  const prevCwd = process.cwd();
  process.chdir(elsewhere);
  try {
    // `git`'s own cwd is bound to the repo via makeGit's `cwd` option — independent of the real
    // process.cwd() we just moved away from.
    const git = makeGit({ cwd: repo });
    const state = gatherRepoState(git, GATES);
    assert.equal(state.ok, true, `gatherRepoState failed: ${state.reason}`);
    // realpath both sides: some platforms symlink the tmp root (e.g. macOS /tmp -> /private/tmp),
    // so a byte-exact compare against the mkdtempSync path would be a false negative there.
    assert.equal(
      realpathSync(state.root),
      realpathSync(repo),
      'resolved root must be the true repo root, not process.cwd()',
    );
    const v = gateVerdict(state, 'next-build', GATES);
    assert.equal(
      v.reason,
      'untracked-env-file',
      'STALE GREEN: a real gitignored env file at the repo root went undetected from a foreign cwd',
    );
  } finally {
    process.chdir(prevCwd);
    rmSync(elsewhere, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('gateVerdict refuses when no closure path exists in HEAD at all', () => {
  assert.equal(gateVerdict(stateOf({ oids: {} }), 'tsc-backend', GATES).reason, 'no-gated-tree');
});

test('gateVerdict refuses when only SOME of a multi-path closure exists (any-vs-all)', () => {
  // tsc-backend's closure is 6 paths; here backend/src resolves but shared/src does not — a
  // sibling checkout shape .some() would wrongly accept, hashing shared/src as 'absent'.
  const partial = { ...FULL_OIDS };
  delete partial['shared/src'];
  assert.equal(
    gateVerdict(stateOf({ oids: partial }), 'tsc-backend', GATES).reason,
    'no-gated-tree',
  );
});

// --- decideGates -------------------------------------------------------------

test('decideGates: hit only on a live entry; miss carries the record key', () => {
  const st = stateOf({ oids: FULL_OIDS });
  const key = gateVerdict(st, 'tsc-backend', GATES).key;
  const live = decideGates({
    state: st,
    cacheDir: '/x',
    gates: GATES,
    only: ['tsc-backend'],
    nowMs: at(1),
    ttlMin: DEFAULT_TTL_MIN,
    readEntry: (_d, k) => (k === key ? { iso: ISO, label: 'l' } : null),
  });
  assert.equal(live[0].status, 'hit');
  assert.equal(live[0].key, key);

  const stale = decideGates({
    state: st,
    cacheDir: '/x',
    gates: GATES,
    only: ['tsc-backend'],
    nowMs: at(DEFAULT_TTL_MIN + 5),
    ttlMin: DEFAULT_TTL_MIN,
    readEntry: () => ({ iso: ISO }),
  });
  assert.equal(stale[0].status, 'miss');
  assert.equal(stale[0].reason, 'expired');
  assert.equal(stale[0].key, key, 'a miss must still name the key a green run records under');
});

test('decideGates: an uncacheable gate never carries a key', () => {
  const st = stateOf({ oids: FULL_OIDS, dirty: ['backend/src/a.ts'] });
  const [d] = decideGates({
    state: st,
    cacheDir: '/x',
    gates: GATES,
    only: ['tsc-backend'],
    nowMs: at(1),
    ttlMin: DEFAULT_TTL_MIN,
    readEntry: () => ({ iso: ISO }),
  });
  assert.equal(d.status, 'uncacheable');
  assert.equal(d.key, undefined, 'an uncacheable gate must not offer a key to record under');
});

// plan 2527 item 1: decideGates must FAIL LOUD on a probe-gated gate with no explicit
// probeResults entry, rather than silently falling through to gateVerdict's pure content
// check — the exact "unknown probe state read as not required" stale-green the item exists to
// prevent. Not live today (both production call sites already pass gates/probeResults that
// avoid it), but a future bare decideGates() call must not be able to reintroduce it.
test('decideGates: a probe-gated gate with NO probeResults entry throws (Item 1 negative control)', () => {
  const st = stateOf({ oids: FULL_OIDS });
  assert.throws(
    () =>
      decideGates({
        state: st,
        cacheDir: '/x',
        gates: GATES,
        only: [MOBILE_GATE],
        nowMs: at(1),
        ttlMin: DEFAULT_TTL_MIN,
      }),
    /probe-gated/,
  );
});

test('decideGates: an omitted `only` (default = every gate in the registry) throws too — the full roster includes a probe-gated gate', () => {
  const st = stateOf({ oids: FULL_OIDS });
  assert.throws(() =>
    decideGates({ state: st, cacheDir: '/x', gates: GATES, nowMs: at(1), ttlMin: DEFAULT_TTL_MIN }),
  );
});

test('decideGates: probeResults[gate].ok=true lets a probe-gated gate through WITHOUT calling probeVerdict itself', () => {
  const st = stateOf({ oids: FULL_OIDS });
  const [d] = decideGates({
    state: st,
    cacheDir: '/x',
    gates: GATES,
    only: [MOBILE_GATE],
    nowMs: at(1),
    ttlMin: DEFAULT_TTL_MIN,
    readEntry: () => null,
    probeResults: { [MOBILE_GATE]: { ok: true } },
  });
  assert.equal(d.status, 'miss', 'a confirmed-required probe-gated gate decides normally');
  assert.ok(d.key);
});

test('decideGates: an explicit probeResults[gate].ok=false is a legitimate uncacheable, NOT a throw', () => {
  // The caller DID probe (unlike the missing-entry case above) and the probe said not-required
  // — that is not doubt, it is an answer, so it must read as uncacheable like any other refusal.
  const st = stateOf({ oids: FULL_OIDS });
  const [d] = decideGates({
    state: st,
    cacheDir: '/x',
    gates: GATES,
    only: [MOBILE_GATE],
    nowMs: at(1),
    ttlMin: DEFAULT_TTL_MIN,
    probeResults: { [MOBILE_GATE]: { ok: false, reason: 'gate-not-required' } },
  });
  assert.equal(d.status, 'uncacheable');
  assert.equal(d.reason, 'gate-not-required');
});

test('decideGates: a non-probe-gated gate needs no probeResults entry at all', () => {
  const st = stateOf({ oids: FULL_OIDS });
  const [d] = decideGates({
    state: st,
    cacheDir: '/x',
    gates: GATES,
    only: ['tsc-backend'],
    nowMs: at(1),
    ttlMin: DEFAULT_TTL_MIN,
    readEntry: () => null,
  });
  assert.equal(d.status, 'miss');
});

// --- state (de)serialization for cross-process reuse (plan 2527 item 2) -------

test('serializeRepoState/deserializeRepoState: round trips a gathered state', () => {
  const st = stateOf({ oids: FULL_OIDS, dirty: ['frontend/src/x.tsx'] });
  st.root = '/repo/root';
  const back = deserializeRepoState(serializeRepoState(st));
  assert.ok(back.ok);
  assert.equal(back.gitVersion, st.gitVersion);
  assert.equal(back.nodeMajor, st.nodeMajor);
  assert.deepEqual(back.dirty, st.dirty);
  assert.equal(back.root, st.root);
  assert.deepEqual(Object.fromEntries(back.oids), FULL_OIDS);
});

test('deserializeRepoState: malformed or shapeless input fails safe rather than throwing', () => {
  assert.equal(deserializeRepoState('{not json').ok, false);
  assert.equal(deserializeRepoState('null').ok, false);
  assert.equal(deserializeRepoState('[]').ok, false);
  assert.equal(deserializeRepoState('{}').ok, false);
  assert.equal(
    deserializeRepoState('{"oids":{},"gitVersion":1,"nodeMajor":22,"root":".","dirty":[]}').ok,
    false,
    'wrong-typed field must not pass',
  );
});

test('readStateFile: an absent file fails safe exactly like a malformed one', () => {
  const missing = join(tmpdir(), 'gate-cache-state-does-not-exist.json');
  assert.equal(readStateFile(missing).ok, false);
});

test('renderDecisions emits flat non-executable key=value lines', () => {
  const out = renderDecisions([
    { gate: 'tsc-backend', status: 'hit', key: 'a'.repeat(32) },
    { gate: 'next-build', status: 'uncacheable', reason: 'dirty-gated-paths' },
  ]);
  assert.match(out, /^tsc-backend\.status=hit$/m);
  assert.match(out, /^tsc-backend\.key=a{32}$/m);
  assert.match(out, /^next-build\.status=uncacheable$/m);
  assert.match(out, /^next-build\.reason=dirty-gated-paths$/m);
  assert.ok(!/[;`$(]/.test(out), 'must carry no shell metacharacters');
});

// --- fs ops ------------------------------------------------------------------

test('entryPath rejects a malformed key rather than escaping the cache dir', () => {
  // Drive-QUALIFIED anchor (plan 2552): '/c' is rooted but drive-less, so join() and resolve()
  // disagree on Windows and a join-built expectation tracks whichever primitive entryPath uses
  // today. Anchoring both sides makes them agree on every platform.
  const anchor = resolve('/c');
  assert.throws(() => entryPath(anchor, '../../etc/passwd'));
  assert.throws(() => entryPath(anchor, 'NOTHEX'.repeat(6)));
  assert.equal(entryPath(anchor, 'a'.repeat(32)), join(anchor, `${'a'.repeat(32)}.json`));
});

test('write → read → remove round trip; a corrupt entry reads as absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cache-fs-'));
  const key = 'b'.repeat(32);
  writeCacheEntry(dir, key, { iso: ISO, gate: 'tsc-backend' });
  assert.equal(readCacheEntry(dir, key).gate, 'tsc-backend');
  writeFileSync(join(dir, `${key}.json`), '{oops');
  assert.equal(readCacheEntry(dir, key), null);
  assert.ok(removeCacheEntry(dir, key));
  assert.equal(removeCacheEntry(dir, key), false);
  rmSync(dir, { recursive: true, force: true });
});

test('pruneExpired drops expired and corrupt entries, keeps live ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cache-prune-'));
  writeCacheEntry(dir, 'a'.repeat(32), { iso: ISO });
  writeCacheEntry(dir, 'c'.repeat(32), { iso: new Date(at(-DEFAULT_TTL_MIN - 60)).toISOString() });
  writeFileSync(join(dir, `${'d'.repeat(32)}.json`), '{corrupt');
  const pruned = pruneExpired(dir, at(1), DEFAULT_TTL_MIN);
  assert.equal(pruned, 2);
  assert.ok(readCacheEntry(dir, 'a'.repeat(32)));
  rmSync(dir, { recursive: true, force: true });
});

// --- CLI lifecycle (throwaway repos) -----------------------------------------

// plan 2527 item 2: check-all can serialize its gather (--state-out) for a later probe-gated
// `check --state-in` call to reuse instead of re-deriving via a fresh git status/cat-file/
// version trio. Proven by ACTUALLY consulting the file (corrupting one oid must move the key),
// not merely by not-crashing — a silently-ignored flag would pass a weaker assertion.
test('CLI: check --state-in falls back to a fresh gather when the file is missing or malformed', () => {
  const repo = tmpRepo();
  const liveKey = runCli(repo, ['check', '--gate', 'tsc-backend']).stdout.trim();

  const missing = runCli(repo, [
    'check',
    '--gate',
    'tsc-backend',
    '--state-in',
    join(repo, 'no-such-state.json'),
  ]).stdout.trim();
  assert.equal(missing, liveKey, 'a missing state file must fall back to a fresh gather');

  const malformed = join(repo, 'bad-state.json');
  writeFileSync(malformed, '{not json');
  const badKey = runCli(repo, [
    'check',
    '--gate',
    'tsc-backend',
    '--state-in',
    malformed,
  ]).stdout.trim();
  assert.equal(badKey, liveKey, 'a malformed state file must fall back to a fresh gather');
  rmSync(repo, { recursive: true, force: true });
});

test('CLI: an UNTRACKED file in the closure is dirt too', () => {
  const repo = tmpRepo();
  recordPass(repo, 'tsc-backend');
  writeFileSync(join(repo, 'backend/src/scratch.ts'), 'x\n');
  assert.equal(runCli(repo, ['check', '--gate', 'tsc-backend']).status, EXIT_UNCACHEABLE);
  rmSync(repo, { recursive: true, force: true });
});

test('CLI: record/invalidate always exit 0 even on malformed input — never block a push', () => {
  const repo = tmpRepo();
  assert.equal(runCli(repo, ['record', '--gate', 'tsc-backend']).status, 0);
  assert.equal(runCli(repo, ['record', '--key', 'a'.repeat(32)]).status, 0);
  assert.equal(runCli(repo, ['record', '--gate', 'nope', '--key', 'a'.repeat(32)]).status, 0);
  assert.equal(runCli(repo, ['invalidate']).status, 0);
  assert.equal(runCli(repo, ['invalidate', '--key', 'not-hex']).status, 0);
  rmSync(repo, { recursive: true, force: true });
});

test('CLI: both kill-switches disable check AND record (plan 2462 task 4)', () => {
  const repo = tmpRepo();
  for (const sw of ['PREPUSH_NO_BATTERY_CACHE', 'PREPUSH_FULL_BATTERY']) {
    assert.equal(
      runCli(repo, ['check', '--gate', 'tsc-backend'], { env: { [sw]: '1' } }).status,
      EXIT_UNCACHEABLE,
      `${sw} must disable check`,
    );
  }
  // A forced full run must not RECORD either — it ran outside the cache's contract.
  const key = runCli(repo, ['check', '--gate', 'tsc-backend']).stdout.trim();
  runCli(repo, ['record', '--gate', 'tsc-backend', '--key', key], {
    env: { PREPUSH_FULL_BATTERY: '1' },
  });
  assert.equal(readCacheEntry(cacheDirOf(repo), key), null, 'a forced run must not be recorded');
  rmSync(repo, { recursive: true, force: true });
});

test('CLI: check-all without --out refuses rather than silently doing nothing', () => {
  const repo = tmpRepo();
  assert.equal(runCli(repo, ['check-all']).status, EXIT_UNCACHEABLE);
  rmSync(repo, { recursive: true, force: true });
});

test('CLI: an unknown gate is UNCACHEABLE, never a silent skip', () => {
  const repo = tmpRepo();
  assert.equal(runCli(repo, ['check', '--gate', 'no-such-gate']).status, EXIT_UNCACHEABLE);
  assert.equal(runCli(repo, ['check']).status, EXIT_UNCACHEABLE);
  rmSync(repo, { recursive: true, force: true });
});

test('CLI: outside a git repo everything is UNCACHEABLE, never a crash-hit', () => {
  // The outside-a-repo condition is BUILT, not hoped for (plan 3622): a bare
  // `mkdtempSync(join(tmpdir(), …))` is outside a repo only while the machine has no repo above
  // tmpdir(). With one there this test still PASSED — an EMPTY dir inside a repo is uncacheable
  // for a different reason (`no-gated-tree`) — while `resolveCacheDir` silently resolved that
  // ANCESTOR repo's cache dir, so the outside-a-repo path was never entered.
  const dir = makeNoRepoRoot('gate-cache-nogit-');
  const r = runCli(dir, ['check', '--gate', 'tsc-backend']);
  assert.notEqual(r.status, EXIT_HIT);
  rmSync(dir, { recursive: true, force: true });
});

test('FIXTURE COMPLETENESS: tmpRepo satisfies every gate closure in full (plan 2509 all-present)', () => {
  // A fixture missing ONE closure blob does not fail loudly — the gate silently goes
  // UNCACHEABLE (`no-gated-tree`) and every case for it then asserts against the refusal path
  // instead of the behaviour it was written to prove. That is how this suite went green on a
  // `.some()` base and red the moment plan 2509 made the refusal all-present. Adding a path to
  // any GATES closure without planting it here must fail HERE, naming the path, not five tests
  // away with an opaque `3 !== 0`.
  const repo = tmpRepo();
  const missing = [];
  for (const gate of GATE_NAMES)
    for (const p of GATES[gate].paths)
      if (!existsSync(join(repo, p))) missing.push(`${gate} → ${p}`);
  assert.deepEqual(missing, [], `tmpRepo is missing closure paths:\n  ${missing.join('\n  ')}`);
  rmSync(repo, { recursive: true, force: true });
});

// ── plan 3958 review fix (key 1y0pqy0/15wuu8d) — restored, portable ─────────────────────────────
// Removed at b7976fdae6b as "genuine vetapp product coverage" because the shared tmpRepo()/CLI
// pair only ever proves the case against whichever coord.config.json happens to sit above the
// REAL, currently-running gate-pass-cache.mjs. Rebuilt on portableGateRepo() (its own fixture
// repo + its own coord.config.json, spawning a COPY of gate-pass-cache.mjs), so these pass
// identically in vetapp and inside the built coord-kit.
test('CLI: editing a closure path MISSES; editing outside it still HITs', () => {
  const repo = portableGateRepo();
  portableRecordPass(repo, 'pytest-backend-scripts');
  // Outside the pytest closure (frontend/src) — must still hit.
  writeFileSync(join(repo.dir, 'frontend/src/page.tsx'), 'export default () => 1;\n');
  portableCommitAll(repo, 'frontend only');
  assert.equal(
    portableRunCli(repo, ['check', '--gate', 'pytest-backend-scripts']).status,
    EXIT_HIT,
    'an out-of-closure change must not invalidate — this is the cache win',
  );
  // Inside the closure — must miss.
  writeFileSync(join(repo.dir, 'backend/scripts/x.py'), 'x = 2\n');
  portableCommitAll(repo, 'pytest surface');
  assert.equal(
    portableRunCli(repo, ['check', '--gate', 'pytest-backend-scripts']).status,
    EXIT_MISS,
  );
  repo.cleanup();
});

test('REGRESSION (plan 2462): a closure keying BOTH a tree and a blob inside it still keys the tree', () => {
  // The bug this pins, caught by the negative controls before it shipped: with `git ls-tree`,
  // passing an ancestor (`backend/scripts`) and a descendant (`backend/scripts/requirements.txt`)
  // in one pathspec made git EXPAND the ancestor, so `backend/scripts` resolved to absent and
  // every .py edit under it was invisible to the key — a silent stale green on the pytest gate.
  // The pytest closure is exactly that shape, so this is a live configuration, not a synthetic.
  const spec = GATES['pytest-backend-scripts'].paths;
  assert.ok(spec.includes('backend/scripts'), 'closure shape changed — re-check this regression');
  assert.ok(spec.includes('backend/scripts/requirements.txt'));

  const repo = portableGateRepo();
  portableRecordPass(repo, 'pytest-backend-scripts');
  // Edit a file under the ANCESTOR tree only — requirements.txt is untouched.
  writeFileSync(join(repo.dir, 'backend/scripts/x.py'), 'x = 42\n');
  portableCommitAll(repo, 'edit under the ancestor tree');
  assert.equal(
    portableRunCli(repo, ['check', '--gate', 'pytest-backend-scripts']).status,
    EXIT_MISS,
    'STALE GREEN: an edit under a keyed tree did not move the key',
  );
  repo.cleanup();
});

// plan 3958 review fix (key 1pcaz3t) — restored, portable (same rationale as the two tests above).
test('CLI: record refuses a drifted key (content moved between check and record)', () => {
  const repo = portableGateRepo();
  const key = portableRunCli(repo, ['check', '--gate', 'tsc-backend']).stdout.trim();
  writeFileSync(join(repo.dir, 'backend/src/app.ts'), 'export const a = 99;\n');
  portableCommitAll(repo, 'moved under the run');
  const rec = portableRunCli(repo, ['record', '--gate', 'tsc-backend', '--key', key]);
  assert.equal(rec.status, 0, 'record never blocks a push');
  assert.match(rec.stderr, /key drifted/);
  // The stale key must NOT have been written.
  assert.equal(readCacheEntry(cacheDirOf(repo.dir), key), null);
  repo.cleanup();
});

// --- the probe-gated mobile gate, end to end (plan 2491 acceptance) -----------
//
// These drive the REAL spawn path against the content-stable PROBE_STUB planted in tmpRepo,
// switched by STUB_MOBILE_REQUIRED so the same tree can answer both ways — which is the only
// way to test the stale-green case the plan exists to close.

const NOT_REQUIRED = { env: { STUB_MOBILE_REQUIRED: '0' } };

// ── plan 3958 review fix (key 15wuu8d) — restored, portable ─────────────────────────────────────
// Removed at b7976fdae6b for the same self-resolving-config reason as the closure tests above —
// rebuilt on portableGateRepo()/portableRunCli() so the mobile gate's own registry row (and its
// PROBE_STUB) come from the test's own fixture, not from whatever config sits above wherever
// gate-pass-cache.mjs happens to be running from.
test('plan 2491 acceptance 1: a push where the gate is NOT required never reads or writes an entry', () => {
  const repo = portableGateRepo();
  const r = portableRunCli(repo, ['check', '--gate', MOBILE_GATE], NOT_REQUIRED);
  assert.equal(r.status, EXIT_UNCACHEABLE, 'a not-required range must not hand back a key');
  assert.equal(r.stdout.trim(), '', 'no key on stdout ⇒ the caller has nothing to record under');
  const log = readFileSync(join(cacheDirOf(repo.dir), 'telemetry.log'), 'utf8');
  assert.match(log, /UNCACHEABLE gate=mobile-gate reason=gate-not-required/);
  repo.cleanup();
});

test('plan 2491 acceptance 3: THE STALE GREEN — a no-op run cannot be recorded, so a later required run MISSES', () => {
  // The exact failure plan 2462's xhigh review caught before it shipped: the gate self-no-ops
  // (exit 0, WebKit never launched), that exit 0 is recorded as a pass for this frontend
  // content, and a LATER push that genuinely needs the gate hits the entry and skips it.
  const repo = portableGateRepo();
  // Learn the key a genuine run WOULD record under — the strongest form of the attack: the
  // caller holds the correct key and still must not be able to record a no-op under it.
  const key = portableRunCli(repo, ['check', '--gate', MOBILE_GATE]).stdout.trim();
  assert.match(key, /^[0-9a-f]{32}$/);

  const rec = portableRunCli(repo, ['record', '--gate', MOBILE_GATE, '--key', key], NOT_REQUIRED);
  assert.equal(rec.status, 0, 'record never blocks a push');
  assert.match(rec.stderr, /record refused for mobile-gate — gate-not-required/);
  assert.equal(
    readCacheEntry(cacheDirOf(repo.dir), key),
    null,
    'STALE GREEN: a run whose probe said "not required" was persisted as a T1-T7 pass',
  );

  // Same tree, same key — now the gate IS required. It must MISS and really run WebKit.
  const later = portableRunCli(repo, ['check', '--gate', MOBILE_GATE]);
  assert.equal(later.status, EXIT_MISS, 'STALE GREEN: the no-op run shadowed a required run');
  assert.equal(
    later.stdout.trim(),
    key,
    'same content ⇒ same key ⇒ this really was the same entry',
  );
  repo.cleanup();
});

test('plan 2491: VERIFY_MOBILE_SKIP=1 (the documented bypass) is uncacheable at check AND record', () => {
  // The bypass exits the gate 0 without launching WebKit on a watched diff — same ambiguity as
  // the no-op path. Neither half of the cache may credit it.
  const repo = tmpRepo();
  const key = runCli(repo, ['check', '--gate', MOBILE_GATE]).stdout.trim();
  const skip = { env: { VERIFY_MOBILE_SKIP: '1' } };
  assert.equal(runCli(repo, ['check', '--gate', MOBILE_GATE], skip).status, EXIT_UNCACHEABLE);
  runCli(repo, ['record', '--gate', MOBILE_GATE, '--key', key], skip);
  assert.equal(
    readCacheEntry(cacheDirOf(repo), key),
    null,
    'a BYPASSED run was recorded as a pass',
  );
  rmSync(repo, { recursive: true, force: true });
});

// --- byte-identity: vetapp's real coord.config.json vs this file's fixture (plan 4071 T4) ------
//
// Every OTHER test in this file exercises the mechanics against RAW_GATES_FIXTURE, a fixture
// that stays fixed regardless of what coord.config.json says. THIS is the one test that pins the
// two together: it loads vetapp's real coord.config.json and proves its `gates` row resolves to
// exactly the registry the fixture declares, so a drift in the config file (an edited path, a
// renamed gate, a dropped probe) fails HERE instead of silently changing pre-push cache
// behaviour. The fixture started life as the pre-plan-4071 module-level `GATES` literal; ADDING
// a gate is a legitimate change and updates both sides in the same diff (plan 4088 added
// `vitest-frontend-full`), which is the point — the guard catches an UNINTENDED divergence, it
// does not freeze the roster.
