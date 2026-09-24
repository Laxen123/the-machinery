// scripts/coord/land/gates-runner.test.mjs — the name-pair of scripts/coord/land/gates-runner.mjs
// (plan 3961 T3.5, extended by plan 4042). NEW-FILE JUSTIFICATION: gates-runner.mjs had no
// dedicated test file before plan 4042 — its existing surface is exercised indirectly through
// done-worktree.test.mjs and parity.test.mjs — and plan 4042's new generic gate lifecycle
// (`runPrepGateLifecycle`) is a genuinely isolable unit whose ten-step contract deserves its own
// fast, fake-deps coverage rather than only the slow, real-git parity/done-worktree suites.
//
// FAKE-DEPS STRATEGY. `runPrepGateLifecycle` reaches `landDeps()` at several points (proof
// read/write, HEAD reads, telemetry, seam emission). Binding `env: { DRY: false, ... }` (the real
// land shape) and a `spawn.run` fake that answers the two `git` subcommands this path actually
// issues (`rev-parse HEAD`, from a queue tests fill via `queueShas()`; `diff --name-only`, always
// "nothing changed") keeps every test here off real git — `DRY: true` was tried first and
// rejected: it also silences `appendDeployGateOutcome` (step 8's own `!D.env.DRY` guard, matching
// production), which is real behaviour worth asserting on, not something to fake around.
// `state.worktreeLock = null` (renewOrAbort's own null-lock short circuit) keeps step 5 off real
// lock files, and an EMPTY `gatePassCache` closure keeps the once-per-land env-hash comparison off
// real disk (see `landGateEnvHash`'s own `if (!files.length) return '';`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindLandDeps, LAND_DEPS_GROUPS } from './deps.mjs';
import { buildRegistries } from './registry.mjs';
import {
  runPrepGateLifecycle,
  runPrepGates,
  landGateProven,
  runLandSeamStep,
  runLandSeamPhase,
  runPreflightGates,
} from './gates-runner.mjs';
import { withEnvVar } from '../../test-helpers/with-env-var.mjs';

// CLOUD-FLAG STRATEGY (plan 4057). `landGateProven` returns null outright when
// `CLAUDE_CODE_REMOTE` is set — a cloud land deliberately proves every gate every land — and that
// variable is exported in EVERY cloud sandbox. The once-per-land scenarios below assert the LOCAL
// behaviour, so inheriting the ambient value made this file green on a developer desktop and red
// in every cloud drain: the skip never fired there, the scenario fell through into a
// `worktreeHeadSha` read its fixture never primes, and it died "sha queue exhausted". Since
// `select-battery-tests.mjs` falls back to the FULL battery for any nested `scripts/**` delta,
// that red blocked every cloud push touching this tree.
//
// The environment is therefore a PARAMETER here, stated once for the file rather than inherited.
// Deleted at module scope rather than per test on purpose: node's runner gives each test FILE its
// own process, so this cannot leak into another file, and `landGateProven` reads `process.env`
// live at call time, so one statement covers every case below. The sibling `withEnvVar` helper —
// the per-case form done-worktree.test.mjs uses for the same variable — is sync-only, and these
// scenarios are async. A future case that wants the CLOUD branch must set it back explicitly.
delete process.env.CLAUDE_CODE_REMOTE;

// …and because forcing the local branch for the whole file would otherwise leave the CLOUD branch
// untested — a regression letting `landGateProven` honour a cached proof on a cloud land could
// then pass this battery while a cloud land silently skipped a gate it must re-run (gpt-review r2
// f953db) — the cloud refusal gets its own case, with the variable set EXPLICITLY for the call.
// `landGateProven` is synchronous, so the sibling `withEnvVar` helper fits here even though the
// lifecycle scenarios above are async and cannot use it.
test('plan 4057: landGateProven REFUSES a once-per-land proof on a cloud land, and honours it locally', () => {
  const state = { gatesProven: { build: { sha: 'deadbeef', envHash: undefined } } };

  // Both spellings, because the two cloud predicates in this repo do NOT agree on one
  // (gpt-review r3 8f5c47): `landGateIsCloud` here is `Boolean(env.CLAUDE_CODE_REMOTE)`, while
  // `L.isCloudLand` is `env.CLAUDE_CODE_REMOTE === 'true'`. Pinning both spellings means a future
  // tightening to strict `'true'` on THIS predicate fails here instead of silently handing a
  // cached proof to a sandbox that exports `1`.
  for (const spelling of ['true', '1']) {
    withEnvVar({ CLAUDE_CODE_REMOTE: spelling }, () => {
      assert.equal(
        landGateProven(state, 'build'),
        null,
        `a cloud land proves every gate every land — a recorded proof must never authorize a skip there (CLAUDE_CODE_REMOTE=${spelling})`,
      );
    });
  }

  withEnvVar({ CLAUDE_CODE_REMOTE: undefined }, () => {
    assert.deepEqual(
      landGateProven(state, 'build'),
      { sha: 'deadbeef', envHash: undefined },
      'locally the same proof IS returned — the refusal is the cloud flag, not the proof shape',
    );
  });
});

const telemetry = [];
const seams = [];
let shaQueue = [];

/** Fill the queue `worktreeHeadSha`/`headShaAfterGate` drain from, in call order. */
function queueShas(...shas) {
  shaQueue = [...shas];
}

function bindFakeDeps() {
  const deps = {};
  for (const name of LAND_DEPS_GROUPS) deps[name] = { marker: name };
  deps.env = { DRY: false, IS_PREP: false, PREP_NO_REBASE: false };
  deps.spawn = {
    run: (cmd, args) => {
      if (cmd !== 'git') throw new Error(`gates-runner.test.mjs: unfaked spawn.run(${cmd})`);
      if (args.includes('rev-parse')) {
        if (!shaQueue.length) {
          throw new Error(
            'gates-runner.test.mjs: sha queue exhausted — call queueShas() before this scenario',
          );
        }
        return shaQueue.shift();
      }
      if (args.includes('diff')) return ''; // "nothing changed since the proven sha"
      throw new Error(`gates-runner.test.mjs: unfaked git subcommand: ${args.join(' ')}`);
    },
  };
  // `onceProvenClosureSkip`'s closure/env comparisons read this — an EMPTY closure for every
  // cache-gate key a test uses means "nothing touched, nothing to hash", so no real file is ever
  // read (see landGateEnvHash's own `if (!files.length) return '';` short circuit).
  deps.gatePassCache = {
    // plan 4071 T4/D5: gatesFrom(config) replaces the module-level GATES — this fake ignores its
    // `config` argument and returns the fixed fixture registry every call.
    gatesFrom: () => ({
      'fake-cache-gate': { paths: [], envUncacheable: [] },
    }),
    pathCovers: () => false,
  };
  // resolveGateRegistry(D) calls D.coordConfig.loadCoordConfig(...) before handing its result to
  // the fake gatesFrom above, which ignores it — any return value satisfies the call.
  deps.coordConfig = { loadCoordConfig: () => ({}) };
  deps.L = {
    isPartialGateProof: () => false,
    gateProvenEntry: (sha, _at, envHash) => ({ sha, envHash }),
    // plan 4056 (finding `lgmdvs`): the `--prep` pass addresses a registered gate by the compact
    // prep key this map's inverse yields, and reads its carry-forward answer from
    // `landPrepGatesToRun`. Both are declared HERE rather than added to the bound container later:
    // `bindLandDeps` freezes each group, so a post-bind assignment throws.
    PREP_GATE_TO_LAND_GATE: { build: 'build' },
    landPrepGatesToRun: () => ({ ...prepFakes.toRun }),
    SEAM: { QUEUE_WAIT: 'QUEUE_WAIT' },
    // plan 4056 (the seam fold): `runLandSeamStep` resolves a declared `markerFamily.key`
    // against this table — for the rework label, and to REFUSE a key that names no family.
    // SYNTHETIC on purpose: the driver is generic, so a test proving it looks the key up in
    // whatever table the host supplies is a stronger pin than one that would still pass if the
    // driver had hardcoded this repo's own family names.
    MARKER_FAMILIES: { alpha: { label: 'Alpha' }, beta: { label: 'Beta' } },
  };
  deps.spine = {
    appendDeployGateOutcome: (wtPath, fields) => telemetry.push(fields),
    emitSeam: (code, message, state) => {
      seams.push({ code, message, state });
      // The real emitSeam calls process.exit(); this fake returns instead, which is exactly why
      // every seam-emitting scenario below reads its outcome off `seams`, never off a return
      // value the real function would never actually produce.
    },
    // plan 4056 (finding `lgmdvs`): `runPrepGates` reads its roster off the registry through this
    // member. Answered from `prepFakes` below rather than closed over one fixture, because the
    // `--prep` scenarios each register a different entry shape.
    landRegistries: async () => prepFakes.registries,
    // plan 4056: the marker-table appendix `emitSeamWithMarkerTable` builds short-circuits to its
    // "no session entry found" line on a null here — so a seam halt in this file costs exactly the
    // one `rev-parse HEAD` the fake above answers, and never reads a real session document.
    findSessionFile: () => null,
    // plan 4056 (the gate fold): the preflight driver's one project interlude. An ACCESSOR, not a
    // value, because `bindLandDeps` freezes each group — a per-scenario value has to be read at
    // call time, exactly as `landRegistries` above reads `prepFakes`. `null` means the host
    // declares no interlude, which is the shape a repo with no such step has.
    get preflightInterlude() {
      return driverFakes.interlude;
    },
  };
  return bindLandDeps(deps);
}
// plan 4056 (finding `lgmdvs`): the two per-scenario inputs the `--prep` pass takes that the
// lifecycle scenarios above have no use for — the registry it selects its roster from, and
// `landPrepGatesToRun`'s carry-forward answer. Both fakes above read this object at CALL time, so a
// scenario sets it immediately before its own `runPrepGates` call; declared ahead of bindFakeDeps()
// because those fakes close over it. `var`-free and hoisted by `const` TDZ rules only because
// nothing calls those fakes during binding itself.
const prepFakes = { registries: null, toRun: {} };
// plan 4056 (the gate fold): the preflight driver's per-scenario interlude, read at call time
// through the accessor above for the same freeze reason `prepFakes` exists.
const driverFakes = { interlude: null };
bindFakeDeps();

function resetSpies() {
  telemetry.length = 0;
  seams.length = 0;
  shaQueue = [];
}

function makeState(overrides = {}) {
  return { branch: 'worktree-x', slug: 'x', worktreeLock: null, gatesProven: {}, ...overrides };
}

// plan 4056: `lifecycle`/`step` are REQUIRED of any preflight-stage prepGates entry, so the
// helper supplies defaults every caller can override. `generic` + a stub step is the honest
// default HERE, because every scenario below drives `runPrepGateLifecycle` itself — which is
// exactly what a `generic` entry's step is handed.
function registriesWith(buildEntry) {
  return buildRegistries({
    prepGates: [
      {
        where: 'test',
        entries: [
          { name: 'build', order: 2.6, lifecycle: 'generic', step: () => {}, ...buildEntry },
        ],
      },
    ],
  });
}

test('step 1: an inapplicable diff returns { applicable: false } and runs nothing', async () => {
  resetSpies();
  let ran = false;
  const registries = registriesWith({
    applies: () => false,
    run: () => {
      ran = true;
      return { ok: true };
    },
  });
  const out = await runPrepGateLifecycle(registries, 'build', {
    wtPath: '/wt',
    diff: [],
    state: makeState(),
    opts: {},
  });
  assert.deepEqual(out, { applicable: false });
  assert.equal(ran, false);
  assert.deepEqual(telemetry, []);
  assert.deepEqual(seams, []);
});

test('step 2: a once-per-land proof with an untouched closure skips the run and telemeters cache-hit', async () => {
  resetSpies();
  let ran = false;
  const registries = registriesWith({
    passCacheGate: 'fake-cache-gate',
    run: () => {
      ran = true;
      return { ok: true };
    },
  });
  const state = makeState({ gatesProven: { build: { sha: 'deadbeef', envHash: undefined } } });
  const out = await runPrepGateLifecycle(registries, 'build', {
    wtPath: '/wt',
    diff: [],
    state,
    opts: {},
  });
  assert.deepEqual(out, { applicable: true, provenSkip: true });
  assert.equal(ran, false);
  assert.deepEqual(telemetry, [
    {
      branch: 'worktree-x',
      gate: 'fake-cache-gate',
      result: 'cache-hit',
      durS: 0,
      sel: 'gates-proven',
      phase: 'land',
    },
  ]);
});

test('happy path: a passing run records proof and telemeters pass/full', async () => {
  resetSpies();
  queueShas('sha1', 'sha1');
  const registries = registriesWith({
    passCacheGate: 'fake-cache-gate',
    run: (ctx) => ({ ok: true, wtPathSeen: ctx.wtPath }),
  });
  const state = makeState();
  const out = await runPrepGateLifecycle(registries, 'build', {
    wtPath: '/wt',
    diff: ['x'],
    state,
    opts: {},
  });
  assert.equal(out.applicable, true);
  assert.equal(out.provenSkip, false);
  assert.equal(out.classification, 'pass');
  assert.equal(out.proofRecorded, true);
  assert.equal(out.proofWithheldReason, null);
  assert.equal(state.gatesProven.build.sha, 'sha1');
  assert.deepEqual(telemetry, [
    {
      branch: 'worktree-x',
      gate: 'fake-cache-gate',
      result: 'pass',
      durS: 0,
      sel: 'full',
      phase: 'land',
    },
  ]);
  assert.deepEqual(seams, []);
});

test('HEAD moving under the gate withholds the proof instead of recording or failing it', async () => {
  resetSpies();
  queueShas('sha1', 'sha2');
  const registries = registriesWith({
    passCacheGate: 'fake-cache-gate',
    run: () => ({ ok: true }),
  });
  const state = makeState();
  const out = await runPrepGateLifecycle(registries, 'build', {
    wtPath: '/wt',
    diff: ['x'],
    state,
    opts: {},
  });
  assert.equal(out.classification, 'pass');
  assert.equal(out.proofRecorded, false);
  assert.match(out.proofWithheldReason, /HEAD moved under the gate/);
  assert.equal(state.gatesProven.build, undefined);
});

test('a gate with no passCacheGate never once-per-land-skips and records a sha-only proof', async () => {
  resetSpies();
  queueShas('sha1', 'sha1');
  const registries = registriesWith({ run: () => ({ ok: true }) });
  const state = makeState({ gatesProven: { build: { sha: 'anything' } } });
  const out = await runPrepGateLifecycle(registries, 'build', {
    wtPath: '/wt',
    diff: ['x'],
    state,
    opts: {},
  });
  assert.equal(out.provenSkip, false);
  assert.equal(out.proofRecorded, true);
  assert.equal(telemetry[0].gate, 'build'); // falls back to the entry name, no passCacheGate to use
});

test('classification: chunked, non-convergent (starved) and failed are mutually exclusive and ordered correctly', async () => {
  const cases = [
    { result: { ok: false, chunked: true, nonConvergent: true, detail: 'stuck' }, want: 'starved' },
    { result: { ok: false, chunked: true, detail: 'partial' }, want: 'chunked' },
    { result: { ok: false, detail: 'nope' }, want: 'failed' },
    { result: { ok: true, detail: 'fine' }, want: 'pass' },
  ];
  for (const { result, want } of cases) {
    resetSpies();
    queueShas('sha1', 'sha1');
    const registries = registriesWith({ run: () => result });
    const out = await runPrepGateLifecycle(registries, 'build', {
      wtPath: '/wt',
      diff: ['x'],
      state: makeState(),
      opts: {},
    });
    assert.equal(out.classification, want, JSON.stringify(result));
  }
});

test('telemetry result vocabulary is a separate axis from the seam classification', async () => {
  const cases = [
    { result: { ok: true, cached: true }, want: 'cache-hit' },
    { result: { ok: true }, want: 'pass' },
    { result: { ok: false, chunked: true, nonConvergent: true, detail: 'x' }, want: 'fail' },
    { result: { ok: false, chunked: true, detail: 'x' }, want: 'chunked' },
    { result: { ok: false, timedOut: true, detail: 'x' }, want: 'cap-kill' },
    { result: { ok: false, detail: 'x' }, want: 'fail' },
  ];
  for (const { result, want } of cases) {
    resetSpies();
    queueShas('sha1', 'sha1');
    const registries = registriesWith({ run: () => result });
    await runPrepGateLifecycle(registries, 'build', {
      wtPath: '/wt',
      diff: ['x'],
      state: makeState(),
      opts: {},
    });
    assert.equal(telemetry[0].result, want, JSON.stringify(result));
  }
});

test('reclassify hook can turn a base classification into a different one', async () => {
  resetSpies();
  queueShas('sha1');
  const registries = registriesWith({
    run: () => ({ ok: false, detail: 'x' }),
    reclassify: (classification) => (classification === 'failed' ? 'starved' : classification),
  });
  const out = await runPrepGateLifecycle(registries, 'build', {
    wtPath: '/wt',
    diff: ['x'],
    state: makeState(),
    opts: {},
  });
  assert.equal(out.classification, 'starved');
});

test('select hook threads a selection into ctx and is reported as sel:"scoped" in telemetry', async () => {
  resetSpies();
  queueShas('sha1', 'sha1');
  let seenSelection;
  const registries = registriesWith({
    select: () => ({ files: ['a.ts'] }),
    run: (ctx) => {
      seenSelection = ctx.selection;
      return { ok: true };
    },
  });
  await runPrepGateLifecycle(registries, 'build', {
    wtPath: '/wt',
    diff: ['x'],
    state: makeState(),
    opts: {},
  });
  assert.deepEqual(seenSelection, { files: ['a.ts'] });
  assert.equal(telemetry[0].sel, 'scoped');
});

// ── gpt-review round 1, three CONFIRMED lifecycle findings ──────────────────────────────────────
// All three were LATENT when found: no production entry declares `select`, so none could fire yet.
// They are fixed and pinned here anyway, because the first entry to declare one would otherwise
// inherit all three silently, and "no adopter yet" is exactly the state in which a wrong default
// is cheapest to correct and hardest to notice.

test('a SCOPED run never banks a whole-gate proof — it verified a subset (gpt-review)', async () => {
  resetSpies();
  queueShas('sha1', 'sha1');
  const registries = registriesWith({
    select: () => ({ files: ['a.ts'] }),
    run: () => ({ ok: true }),
  });
  const out = await runPrepGateLifecycle(registries, 'build', {
    wtPath: '/wt',
    diff: ['x'],
    state: makeState(),
    opts: {},
  });
  // Still a real pass for every other purpose — it just proves less than the gate.
  assert.equal(out.classification, 'pass');
  assert.equal(telemetry[0].sel, 'scoped');
  assert.equal(
    out.proofRecorded,
    false,
    'a narrowed run must not bank a proof a LATER land would skip the real gate on',
  );
});

test('a FULL run still banks its proof — the scoped withholding is not a blanket one', async () => {
  resetSpies();
  queueShas('sha1', 'sha1');
  const registries = registriesWith({ run: () => ({ ok: true }) });
  const out = await runPrepGateLifecycle(registries, 'build', {
    wtPath: '/wt',
    diff: ['x'],
    state: makeState(),
    opts: {},
  });
  assert.equal(out.proofRecorded, true);
  assert.equal(telemetry[0].sel, 'full');
});

test('reclassify receives the SELECTION-augmented ctx, not the pre-selection one (gpt-review)', async () => {
  resetSpies();
  queueShas('sha1', 'sha1');
  let seenInReclassify;
  const registries = registriesWith({
    select: () => ({ files: ['a.ts'] }),
    run: () => ({ ok: false, detail: 'x' }),
    reclassify: (classification, _result, ctx) => {
      seenInReclassify = ctx.selection;
      return classification;
    },
  });
  await runPrepGateLifecycle(registries, 'build', {
    wtPath: '/wt',
    diff: ['x'],
    state: makeState(),
    opts: {},
  });
  assert.deepEqual(
    seenInReclassify,
    { files: ['a.ts'] },
    'the hook must see the run that actually happened',
  );
});

test('reclassify returning an unrecognised value THROWS naming the entry (gpt-review)', async () => {
  resetSpies();
  queueShas('sha1', 'sha1');
  const registries = registriesWith({
    run: () => ({ ok: false, detail: 'x' }),
    reclassify: () => 'faled', // a typo, not a new outcome
  });
  await assert.rejects(
    () =>
      runPrepGateLifecycle(registries, 'build', {
        wtPath: '/wt',
        diff: ['x'],
        state: makeState(),
        opts: {},
      }),
    /reclassify\(\) returned "faled".*not a classification/s,
    'an unvalidated stray value would mean no proof, no seam and no telemetry naming a problem',
  );
});

test('reclassify may NOT return the runner-owned "unproven" (gpt-review round 2)', async () => {
  resetSpies();
  queueShas('sha1', 'sha1');
  const registries = registriesWith({
    run: () => ({ ok: true }),
    reclassify: () => 'unproven', // reaching past provesGate's own derivation
  });
  await assert.rejects(
    () =>
      runPrepGateLifecycle(registries, 'build', {
        wtPath: '/wt',
        diff: ['x'],
        state: makeState(),
        opts: {},
      }),
    /not a classification.*provesGate/s,
    'an entry must not be able to assert "green but proves nothing" without answering provesGate',
  );
});

test('an unstringifiable reclassify result still produces the precise error (gpt-review round 2)', async () => {
  resetSpies();
  queueShas('sha1', 'sha1');
  const circular = {};
  circular.self = circular; // JSON.stringify would throw on this
  const registries = registriesWith({
    run: () => ({ ok: true }),
    reclassify: () => circular,
  });
  await assert.rejects(
    () =>
      runPrepGateLifecycle(registries, 'build', {
        wtPath: '/wt',
        diff: ['x'],
        state: makeState(),
        opts: {},
      }),
    /reclassify\(\) returned object value, which is not a classification/,
    'the error path must not be able to throw its own unrelated error while reporting',
  );
});

test('an entry with no `seams` never emits a seam itself — the caller must still act on classification', async () => {
  resetSpies();
  queueShas('sha1');
  const registries = registriesWith({ run: () => ({ ok: false, detail: 'boom' }) });
  const out = await runPrepGateLifecycle(registries, 'build', {
    wtPath: '/wt',
    diff: ['x'],
    state: makeState(),
    opts: {},
  });
  assert.equal(out.classification, 'failed');
  assert.deepEqual(seams, []);
});

test('an entry WITH `seams` has its failure emitted by the lifecycle itself, verbatim detail', async () => {
  resetSpies();
  queueShas('sha1');
  const registries = registriesWith({
    run: () => ({ ok: false, detail: 'boom' }),
    seams: { failed: 'BUILD_FAILED', chunked: 'BUILD_CHUNKED', starved: 'GATE_NON_CONVERGENT' },
  });
  const state = makeState();
  await runPrepGateLifecycle(registries, 'build', {
    wtPath: '/wt',
    diff: ['x'],
    state,
    opts: {},
  });
  assert.deepEqual(seams, [{ code: 'BUILD_FAILED', message: 'boom', state }]);
});

test('an entry WITH `seams` but missing the slot the outcome needs throws, naming the entry', async () => {
  resetSpies();
  queueShas('sha1');
  const registries = registriesWith({
    run: () => ({ ok: false, chunked: true, detail: 'x' }),
    seams: { failed: 'BUILD_FAILED' }, // no `chunked` slot
  });
  await assert.rejects(
    runPrepGateLifecycle(registries, 'build', {
      wtPath: '/wt',
      diff: ['x'],
      state: makeState(),
      opts: {},
    }),
    /prepGates entry "build".*declares no seams\.chunked/,
  );
});

// ── plan 4042 D-M12: unproven classification ────────────────────────────────────────────────────

test('D-M12: no provesGate declared classifies a passing run as pass and records its proof, unchanged', async () => {
  resetSpies();
  queueShas('sha1', 'sha1');
  const registries = registriesWith({
    passCacheGate: 'fake-cache-gate',
    run: () => ({ ok: true }),
  });
  const state = makeState();
  const out = await runPrepGateLifecycle(registries, 'build', {
    wtPath: '/wt',
    diff: ['x'],
    state,
    opts: {},
  });
  assert.equal(out.classification, 'pass');
  assert.equal(out.proofRecorded, true);
  assert.equal(state.gatesProven.build.sha, 'sha1');
  assert.deepEqual(telemetry, [
    {
      branch: 'worktree-x',
      gate: 'fake-cache-gate',
      result: 'pass',
      durS: 0,
      sel: 'full',
      phase: 'land',
    },
  ]);
});

test('D-M12: provesGate() returning false classifies unproven, records no proof, emits no seam, telemeters skipped', async () => {
  resetSpies();
  queueShas('sha1', 'sha1');
  const registries = registriesWith({
    passCacheGate: 'fake-cache-gate',
    run: () => ({ ok: true }),
    provesGate: (result) => result.verified === true, // this run's result carries no such field
    seams: { failed: 'BUILD_FAILED', chunked: 'BUILD_CHUNKED', starved: 'GATE_NON_CONVERGENT' },
  });
  const state = makeState();
  const out = await runPrepGateLifecycle(registries, 'build', {
    wtPath: '/wt',
    diff: ['x'],
    state,
    opts: {},
  });
  assert.equal(out.classification, 'unproven');
  assert.equal(out.proofRecorded, false);
  assert.equal(out.proofWithheldReason, null);
  assert.equal(state.gatesProven.build, undefined);
  assert.deepEqual(seams, []); // not a failure of any kind — nothing to halt on
  assert.deepEqual(telemetry, [
    {
      branch: 'worktree-x',
      gate: 'fake-cache-gate',
      result: 'skipped',
      durS: 0,
      sel: 'full',
      phase: 'land',
    },
  ]);
});

test('D-M12: provesGate is never consulted for a failed, chunked or starved result', async () => {
  const cases = [
    { result: { ok: false, detail: 'nope' }, want: 'failed' },
    { result: { ok: false, chunked: true, detail: 'partial' }, want: 'chunked' },
    { result: { ok: false, chunked: true, nonConvergent: true, detail: 'stuck' }, want: 'starved' },
  ];
  for (const { result, want } of cases) {
    resetSpies();
    queueShas('sha1');
    let consulted = false;
    const registries = registriesWith({
      run: () => result,
      provesGate: () => {
        consulted = true;
        return false; // would force `unproven` if it were ever asked
      },
      seams: { failed: 'BUILD_FAILED', chunked: 'BUILD_CHUNKED', starved: 'GATE_NON_CONVERGENT' },
    });
    const out = await runPrepGateLifecycle(registries, 'build', {
      wtPath: '/wt',
      diff: ['x'],
      state: makeState(),
      opts: {},
    });
    assert.equal(out.classification, want, JSON.stringify(result));
    assert.equal(consulted, false, `provesGate must not be consulted for a ${want} result`);
  }
});

test('D-M12: telemetry derived from classification still matches every existing mapping', async () => {
  const cases = [
    { result: { ok: true, cached: true }, want: 'cache-hit' },
    { result: { ok: true }, want: 'pass' },
    { result: { ok: false, chunked: true, nonConvergent: true, detail: 'x' }, want: 'fail' },
    { result: { ok: false, chunked: true, detail: 'x' }, want: 'chunked' },
    { result: { ok: false, timedOut: true, detail: 'x' }, want: 'cap-kill' },
    { result: { ok: false, detail: 'x' }, want: 'fail' },
  ];
  for (const { result, want } of cases) {
    resetSpies();
    queueShas('sha1', 'sha1');
    const registries = registriesWith({ run: () => result });
    await runPrepGateLifecycle(registries, 'build', {
      wtPath: '/wt',
      diff: ['x'],
      state: makeState(),
      opts: {},
    });
    assert.equal(telemetry[0].result, want, JSON.stringify(result));
  }
});

test('assertWorktreeStillOurs (step 5) runs with a null worktreeLock and never blocks a pass', async () => {
  resetSpies();
  queueShas('sha1', 'sha1');
  const registries = registriesWith({ run: () => ({ ok: true }) });
  const state = makeState({ worktreeLock: null });
  const out = await runPrepGateLifecycle(registries, 'build', {
    wtPath: '/wt',
    diff: ['x'],
    state,
    opts: {},
  });
  assert.equal(out.classification, 'pass');
});

// ── plan 4056 (plan 4042 review finding `lgmdvs`): the `--prep` pass reads the SAME declared
// ── metadata the land-time lifecycle does ──────────────────────────────────────────────────────
//
// `runPrepGates` decides whether a gate's green earns a proof, and until plan 4056 it decided that
// from a HAND-WRITTEN predicate (`r.ok && !r.slowDeselected && !r.mobileBypassed`) rather than from
// the entry's own `provesGate` hook — the very question plan 4042 D-M12 introduced that hook to
// answer. Two consequences, and the first is the land-correctness defect:
//
//   * An entry whose `provesGate` says a green verified nothing was banked anyway, because its
//     result carried neither of the two flag names that predicate happened to know. `--prep` then
//     stamps the gate proven, and a LATER land takes the once-per-land fast path and merges without
//     ever running it — an unearned proof, which is exactly the hazard D-M12 exists to make
//     impossible rather than merely discouraged.
//   * The two project-specific result-flag names were spelled out in a core module, which is the
//     coupling the land-spine split exists to remove.
//
// Both close the same way: ONE derivation, `prepGateProofClassification`, shared by this pass and
// by the lifecycle, and each gate declaring its own answer on its own entry.

/** The `runPrepGates` argument bag, with only the per-scenario parts spelled out at call sites. */
function prepGatesArgs(state, overrides = {}) {
  return {
    state,
    wtPath: '/wt',
    changed: ['x'],
    delta: null,
    hasPriorForCap: false,
    priorGateResults: {},
    lock: null, // renewOrAbort's own null-lock short circuit, as everywhere else in this file
    slug: 'x',
    label: '',
    stopOnFail: false,
    narrateCache: false,
    proofBuffer: null,
    onGateFail: () => {},
    ...overrides,
  };
}

test('lgmdvs: --prep banks NO proof for a green the entry’s own provesGate() rejects', async () => {
  resetSpies();
  // FOUR sha reads, in this order: the pass-start tree, the gate's own start and end trees, and the
  // pass-end tree. All equal, so the pass-end reconcile falsifies nothing for a moved tree and the
  // only thing that can withhold this proof is the entry's own hook.
  queueShas('sha1', 'sha1', 'sha1', 'sha1');
  prepFakes.registries = registriesWith({
    passCacheGate: 'fake-cache-gate',
    run: () => ({ ok: true }),
    provesGate: (result) => result.verified === true, // this run's result carries no such field
  });
  prepFakes.toRun = { build: true };
  const state = makeState();
  const out = await runPrepGates(prepGatesArgs(state));
  assert.equal(out.ok, true, 'an unproven green is not a gate FAILURE — the pass still succeeds');
  assert.equal(
    out.gateResults.build,
    false,
    'the whole-pass marker must not claim a gate whose own provesGate() says it verified nothing',
  );
  assert.equal(
    state.gatesProven.build,
    undefined,
    'and nothing may reach the once-per-land sidecar, or a later land skips a gate that never ran',
  );
});

test('lgmdvs: a plain green with no provesGate declared still banks its proof, unchanged', async () => {
  resetSpies();
  queueShas('sha1', 'sha1', 'sha1', 'sha1');
  prepFakes.registries = registriesWith({
    passCacheGate: 'fake-cache-gate',
    run: () => ({ ok: true }),
  });
  prepFakes.toRun = { build: true };
  const state = makeState();
  const out = await runPrepGates(prepGatesArgs(state));
  assert.equal(out.gateResults.build, true);
  assert.equal(state.gatesProven.build.sha, 'sha1');
});

test('lgmdvs: a chunked and a failed run each bank nothing, exactly as before', async () => {
  for (const result of [
    { ok: false, chunked: true, detail: 'partial' },
    { ok: false, chunked: true, nonConvergent: true, detail: 'stuck' },
    { ok: false, detail: 'nope' },
  ]) {
    resetSpies();
    queueShas('sha1', 'sha1', 'sha1', 'sha1');
    prepFakes.registries = registriesWith({
      passCacheGate: 'fake-cache-gate',
      run: () => result,
    });
    prepFakes.toRun = { build: true };
    const state = makeState();
    const out = await runPrepGates(prepGatesArgs(state));
    assert.equal(out.ok, false, JSON.stringify(result));
    assert.equal(out.gateResults.build, false, JSON.stringify(result));
    assert.equal(state.gatesProven.build, undefined, JSON.stringify(result));
  }
});

// ── plan 4056: runLandSeamStep, the ONE generic landSeam driver (finding `elukwb`) ──────────────
//
// Three hand-written wrappers used to spell the same seven-step shape around three registered
// seams whose own `check(ctx)` was a one-line pure translation. These cases pin the shape itself,
// against SYNTHETIC entries: the driver is generic, so proving it against this repo's own three
// seams would leave "it hardcoded them" indistinguishable from "it read their declarations".
// The adopters' own declarations are pinned by their registration modules' name-paired tests.
//
// `emitSeam` is faked to RECORD AND RETURN, where the real one process-exits. Every case that can
// reach a halt therefore asserts on `seams`, and — because control really does return here where
// production's would not — a halting case also asserts the driver did not go on to emit twice.

/** A landSeams registry holding ONE entry, with whatever fields a scenario declares. */
function seamRegistryWith(entry) {
  return buildRegistries({
    landSeams: [{ where: 'test', entries: [{ name: 'seam-under-test', order: 2.67, ...entry }] }],
  });
}

function seamCtx(overrides = {}) {
  return {
    state: makeState(),
    MAIN: '/main',
    slug: 'x',
    wtPath: '/wt',
    handoffLayout: 'sessions',
    resumedPast: () => false,
    seamTimeRepin: () => ({ repinned: false, rework: false }),
    changed: ['scripts/x.mjs'],
    ...overrides,
  };
}

const HOLD = { ok: false, seam: 'SEAM_UNDER_TEST', message: 'held' };
const CLEAR = { ok: true, seam: null, message: '' };

/**
 * Run `fn` with `console.error` captured.
 *
 * `emitReworkHaltWithRelease` is reached through a static import, so it cannot be spied on
 * directly — but it is the ONLY caller of `dequeueForRework`, and that function narrates its own
 * outcome on stderr unconditionally. So a line from it is a sound witness that the REWORK arm ran
 * rather than the plain halt: the two are otherwise indistinguishable from outside, since both end
 * in the same single `emitSeam`. (Which release verdict it reaches is `dequeueForRework`'s own
 * business and its own tests'; what this file pins is which arm the driver chose.)
 */
function captureStderr(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try {
    fn();
  } finally {
    console.error = real;
  }
  return lines.join('\n');
}

test('seam driver step 1: an entry whose applies() says no runs nothing and reports no marker', () => {
  resetSpies();
  let checked = false;
  let lookedUp = false;
  const registries = seamRegistryWith({
    applies: () => false,
    seamCode: 'RESUME_CODE',
    markerFamily: {
      key: 'alpha',
      lookup: () => {
        lookedUp = true;
        return 'FOUND';
      },
      recorder: 'record-alpha.mjs',
    },
    check: () => {
      checked = true;
      return HOLD;
    },
  });
  const out = runLandSeamStep(registries, 'seam-under-test', seamCtx());
  assert.deepEqual(out, { applicable: false, resumed: false, marker: null });
  assert.equal(lookedUp, false, 'an inapplicable seam does not even look its marker up');
  assert.equal(checked, false);
  assert.deepEqual(seams, []);
});

test('seam driver step 1: applies() sees the changed-file list as its diff argument, and the whole ctx as its second', () => {
  resetSpies();
  const seen = [];
  const registries = seamRegistryWith({
    applies: (diff, c) => {
      seen.push({ diff, layout: c.handoffLayout });
      return false;
    },
    check: () => CLEAR,
  });
  runLandSeamStep(registries, 'seam-under-test', seamCtx({ changed: ['a.mjs', 'b.mjs'] }));
  assert.deepEqual(seen, [{ diff: ['a.mjs', 'b.mjs'], layout: 'sessions' }]);
});

test('seam driver step 2: the marker lookup runs OUTSIDE the --resume guard (plan 3972), so a waived seam still arms the re-proof', () => {
  resetSpies();
  let checked = false;
  const registries = seamRegistryWith({
    seamCode: 'RESUME_CODE',
    markerFamily: { key: 'alpha', lookup: () => 'FOUND', recorder: 'record-alpha.mjs' },
    check: () => {
      checked = true;
      return HOLD;
    },
  });
  const out = runLandSeamStep(
    registries,
    'seam-under-test',
    seamCtx({ resumedPast: (code) => code === 'RESUME_CODE' }),
  );
  assert.deepEqual(out, { applicable: true, resumed: true, marker: 'FOUND' });
  assert.equal(checked, false, 'the seam itself is waived');
  assert.deepEqual(seams, [], 'and nothing halts');
});

test('seam driver step 3: --resume matches the entry OWN seamCode, not any other code', () => {
  resetSpies();
  const registries = seamRegistryWith({ seamCode: 'RESUME_CODE', check: () => CLEAR });
  const out = runLandSeamStep(
    registries,
    'seam-under-test',
    seamCtx({ resumedPast: (code) => code === 'SOME_OTHER_CODE' }),
  );
  assert.equal(out.resumed, false, 'a different waived code must not skip this seam');
});

test('seam driver step 4: the found marker reaches the entry check() on ctx.seamMarker, so no projection field is needed', () => {
  resetSpies();
  const seenMarkers = [];
  const registries = seamRegistryWith({
    markerFamily: { key: 'alpha', lookup: () => 'UPHELD', recorder: 'record-alpha.mjs' },
    check: (c) => {
      seenMarkers.push(c.seamMarker);
      return CLEAR;
    },
  });
  const out = runLandSeamStep(registries, 'seam-under-test', seamCtx());
  assert.deepEqual(seenMarkers, ['UPHELD']);
  assert.deepEqual(out, { applicable: true, resumed: false, marker: 'UPHELD' });
});

test('seam driver step 5: a hold with NO marker re-pins once, re-looks-up, re-checks — and a cleared re-check halts nothing', () => {
  resetSpies();
  queueShas('sha1');
  const lookups = [null, 'UPHELD'];
  const repinCalls = [];
  const registries = seamRegistryWith({
    markerFamily: {
      key: 'alpha',
      lookup: () => (lookups.length ? lookups.shift() : null),
      recorder: 'record-alpha.mjs',
    },
    check: (c) => (c.seamMarker ? CLEAR : HOLD),
  });
  const out = runLandSeamStep(
    registries,
    'seam-under-test',
    seamCtx({
      seamTimeRepin: (recorder) => {
        repinCalls.push(recorder);
        return { repinned: true, rework: false };
      },
    }),
  );
  assert.deepEqual(repinCalls, ['record-alpha.mjs'], 'the entry names its own recorder script');
  assert.deepEqual(out, { applicable: true, resumed: false, marker: 'UPHELD' });
  assert.deepEqual(seams, [], 'the re-pin cleared the seam, so nothing halts');
});

test('seam driver step 5: a hold WITH a marker already in hand never re-pins — a real verdict problem is not a stale pin', () => {
  resetSpies();
  queueShas('sha1');
  let repins = 0;
  const registries = seamRegistryWith({
    markerFamily: { key: 'alpha', lookup: () => 'REFUTED', recorder: 'record-alpha.mjs' },
    check: () => HOLD,
  });
  runLandSeamStep(
    registries,
    'seam-under-test',
    seamCtx({
      seamTimeRepin: () => {
        repins += 1;
        return { repinned: true, rework: false };
      },
    }),
  );
  assert.equal(repins, 0);
  assert.equal(seams.length, 1, 'it still halts, with the marker-table halt');
  assert.equal(seams[0].code, 'SEAM_UNDER_TEST');
});

test('seam driver step 6: a marker-backed hold halts WITH the marker-status table appended (plan 2086)', () => {
  resetSpies();
  queueShas('sha1');
  const registries = seamRegistryWith({
    markerFamily: { key: 'alpha', lookup: () => null, recorder: 'record-alpha.mjs' },
    check: () => HOLD,
  });
  runLandSeamStep(registries, 'seam-under-test', seamCtx());
  assert.equal(seams.length, 1);
  assert.equal(seams[0].code, 'SEAM_UNDER_TEST');
  assert.match(
    seams[0].message,
    /^held\n\nmarker status for x:/,
    'the halt reason is the seam message, then the table',
  );
});

test('seam driver step 6: a seam declaring NO markerFamily halts BARE — no lookup, no re-pin, no marker table', () => {
  resetSpies();
  let repins = 0;
  const registries = seamRegistryWith({ seamCode: 'RESUME_CODE', check: () => HOLD });
  const out = runLandSeamStep(
    registries,
    'seam-under-test',
    seamCtx({
      seamTimeRepin: () => {
        repins += 1;
        return { repinned: true, rework: true };
      },
    }),
  );
  assert.equal(repins, 0);
  assert.equal(seams.length, 1);
  assert.equal(seams[0].code, 'SEAM_UNDER_TEST');
  assert.equal(seams[0].message, 'held', 'bare emitSeam: no table appended');
  assert.equal(out.marker, null);
});

test('seam driver step 6: a PROVEN-rework hold takes the release arm (plan 2170 Ship 2), a plain hold does not', () => {
  const registries = seamRegistryWith({
    markerFamily: { key: 'alpha', lookup: () => null, recorder: 'record-alpha.mjs' },
    check: () => HOLD,
  });
  const RELEASE_NARRATION = /dequeue-for-rework|RELEASED for rework|holding the slot/;

  resetSpies();
  queueShas('sha1');
  const withRework = captureStderr(() =>
    runLandSeamStep(
      registries,
      'seam-under-test',
      seamCtx({ seamTimeRepin: () => ({ repinned: false, rework: true }) }),
    ),
  );
  assert.match(
    withRework,
    RELEASE_NARRATION,
    'a proven rework goes through the release wrapper, which narrates its own outcome',
  );
  // TWO emitSeam calls, and that is the fake talking, not a double halt: the release wrapper
  // emits, and in PRODUCTION that call process-exits, so the driver's trailing marker-table halt
  // is unreachable. This fake records and returns instead, so both fire — which makes the count a
  // second, independent witness of which arm ran (the plain hold below reaches exactly one).
  assert.equal(
    seams.length,
    2,
    'the release halt, then the trailing halt production never reaches',
  );
  assert.deepEqual(
    seams.map((s) => s.code),
    ['SEAM_UNDER_TEST', 'SEAM_UNDER_TEST'],
  );

  resetSpies();
  queueShas('sha1');
  const withoutRework = captureStderr(() =>
    runLandSeamStep(
      registries,
      'seam-under-test',
      seamCtx({ seamTimeRepin: () => ({ repinned: false, rework: false }) }),
    ),
  );
  assert.doesNotMatch(
    withoutRework,
    RELEASE_NARRATION,
    'a plain hold never touches the queue slot',
  );
  assert.equal(seams.length, 1, 'and reaches the marker-table halt exactly once');
});

test('seam driver: a markerFamily.key naming no real family is REFUSED, before applicability', () => {
  resetSpies();
  const registries = seamRegistryWith({
    applies: () => false, // …so the refusal cannot be credited to the seam merely running
    markerFamily: { key: 'not-a-family', lookup: () => null, recorder: 'record-x.mjs' },
    check: () => CLEAR,
  });
  assert.throws(
    () => runLandSeamStep(registries, 'seam-under-test', seamCtx()),
    /markerFamily\.key "not-a-family", which is not a known marker family/,
  );
});

// ── plan 4066 task 3 (finding `92nebq`): runLandSeamPhase, the generic seam-phase driver ────────
//
// The driver decides exactly ONE thing — WHICH registered landSeams it drives through
// runLandSeamStep: exactly the ones declaring `seamCode`, in the registry's own order. Everything
// below drives SYNTHETIC entries rather than this repo's own five seams, deliberately — the same
// reason the sibling runPreflightGates section below does: a test built on the real roster would
// still pass if the driver hardcoded these names, which is the coupling the fold exists to delete.
// The REAL roster this driver selects from this repo's own registry (exactly status-flip,
// conclusion-review, wiki-checkpoint — never review-marker/findings-open) is pinned separately, in
// done-worktree.test.mjs, beside the sibling test that pins those five seams' full declared order.

/** A landSeams registry of `{ name, order, seamCode?, check }` specs; each seam logs its own call. */
function seamPhaseRegistry(specs, log) {
  return buildRegistries({
    landSeams: [
      {
        where: 'test',
        entries: specs.map((s) => ({
          name: s.name,
          order: s.order,
          ...(s.seamCode ? { seamCode: s.seamCode } : {}),
          check: (c) => {
            log.push({ name: s.name, ctx: c });
            return s.result ?? CLEAR;
          },
        })),
      },
    ],
  });
}

test('seam-phase driver: drives ONLY the entries declaring `seamCode`, in the registry order — an entry with none is never even checked', () => {
  resetSpies();
  const log = [];
  const registries = seamPhaseRegistry(
    [
      { name: 'no-code-early', order: 2.5 }, // e.g. review-marker: no seamCode, no --resume valve
      { name: 'no-code-mid', order: 2.55 }, // e.g. findings-open: likewise
      { name: 'late', order: 2.68, seamCode: 'LATE_CODE' },
      { name: 'early', order: 2.67, seamCode: 'EARLY_CODE' },
      { name: 'mid', order: 2.672, seamCode: 'MID_CODE' },
    ],
    log,
  );
  const out = runLandSeamPhase(registries, seamCtx());
  assert.deepEqual(
    out.ran,
    ['early', 'mid', 'late'],
    'registration order must not decide it, and neither may declaring no seamCode — the declared `order` among the seamCode-bearing entries does',
  );
  assert.deepEqual(
    log.map((c) => c.name),
    ['early', 'mid', 'late'],
    'the two entries with no seamCode are never checked at all — not merely excluded from `ran`',
  );
});

test('seam-phase driver: ONE ctx, shared by every driven entry — no seam is handed a narrower view than its siblings', () => {
  resetSpies();
  const log = [];
  const registries = seamPhaseRegistry(
    [
      { name: 'a', order: 2.67, seamCode: 'A' },
      { name: 'b', order: 2.68, seamCode: 'B' },
    ],
    log,
  );
  runLandSeamPhase(registries, seamCtx({ marker: 'the-land-ctx' }));
  for (const call of log) assert.equal(call.ctx.marker, 'the-land-ctx');
});

test('seam-phase driver: `markers` maps each DRIVEN name to the marker runLandSeamStep found for it — `null` for a seam with no markerFamily', () => {
  resetSpies();
  const log = [];
  const registries = buildRegistries({
    landSeams: [
      {
        where: 'test',
        entries: [
          { name: 'bare', order: 2.67, seamCode: 'BARE', check: () => CLEAR },
          {
            name: 'marked',
            order: 2.68,
            seamCode: 'MARKED',
            markerFamily: { key: 'alpha', lookup: () => 'FOUND', recorder: 'record-alpha.mjs' },
            check: () => CLEAR,
          },
        ],
      },
    ],
  });
  const out = runLandSeamPhase(registries, seamCtx());
  assert.deepEqual(out.ran, ['bare', 'marked']);
  assert.deepEqual(
    out.markers,
    { bare: null, marked: 'FOUND' },
    'a seam with no markerFamily maps to null (never absent, and never undefined) — a caller ' +
      'reading `markers[name]` for an unregistered/undriven name gets undefined instead, which ' +
      'stays distinguishable from a driven-but-marker-less seam',
  );
});

test('seam-phase driver: a HALTING entry still reaches runLandSeamStep’s own halt path (emitSeam), same as calling it by hand', () => {
  resetSpies();
  const registries = seamPhaseRegistry(
    [{ name: 'held', order: 2.67, seamCode: 'HELD', result: HOLD }],
    [],
  );
  runLandSeamPhase(registries, seamCtx());
  assert.equal(seams[0].code, 'SEAM_UNDER_TEST');
  assert.equal(seams[0].message, 'held');
});

// ── plan 4056 (the gate fold): runPreflightGates, the generic preflight driver ────────────
//
// The driver decides exactly ONE thing — what an entry's `step` receives as its second argument —
// and places one project interlude by its declared order. Everything below drives SYNTHETIC
// entries rather than this repo's own five gates, deliberately: a test built on the real roster
// would still pass if the driver hardcoded these names, which is the coupling the fold exists to
// delete.

/** A registry of `{ name, order, stage?, lifecycle }` specs whose steps record their own calls. */
function driverRegistry(specs, log) {
  return buildRegistries({
    prepGates: [
      {
        where: 'test',
        entries: specs.map((s) => ({
          name: s.name,
          order: s.order,
          ...(s.stage ? { stage: s.stage } : {}),
          run: s.run ?? (() => ({ ok: true })),
          ...(s.applies ? { applies: s.applies } : {}),
          ...(s.stage && s.stage !== 'preflight'
            ? {}
            : {
                lifecycle: s.lifecycle ?? 'custom',
                step: (ctx, lifecycle) => log.push({ name: s.name, ctx, lifecycle }),
              }),
        })),
      },
    ],
  });
}

test('plan 4056 driver: preflight-stage entries run in `order`, each through its own declared step', async () => {
  resetSpies();
  driverFakes.interlude = null;
  const log = [];
  const registries = driverRegistry(
    [
      { name: 'late', order: 2.9 },
      { name: 'early', order: 2.1 },
      { name: 'middle', order: 2.5 },
    ],
    log,
  );
  const ran = await runPreflightGates(registries, { marker: 'the-land-ctx' });
  assert.deepEqual(
    log.map((c) => c.name),
    ['early', 'middle', 'late'],
    'registration order must not decide execution order — the declared `order` does',
  );
  assert.deepEqual(ran, ['early', 'middle', 'late']);
  // ONE ctx, shared: no step may be handed a narrower view of the land than its siblings.
  for (const call of log) assert.equal(call.ctx.marker, 'the-land-ctx');
});

test('plan 4056 driver: a non-preflight-stage entry is never run by the preflight driver', async () => {
  resetSpies();
  driverFakes.interlude = null;
  const log = [];
  // A lane-merge and a deploy-wall gate declare NO lifecycle/step at all (the registry refuses
  // them there), and the driver must not reach for either.
  const registries = driverRegistry(
    [
      { name: 'preflight-gate', order: 2.6 },
      { name: 'lane-merge-gate', order: 3.5, stage: 'lane-merge' },
      { name: 'deploy-wall-gate', order: 3.9, stage: 'deploy-wall' },
    ],
    log,
  );
  const ran = await runPreflightGates(registries, {});
  assert.deepEqual(ran, ['preflight-gate']);
});

test('plan 4056 driver: `generic` is handed a lifecycle runner, `custom` is handed null', async () => {
  resetSpies();
  driverFakes.interlude = null;
  const log = [];
  const registries = driverRegistry(
    [
      { name: 'g', order: 2.1, lifecycle: 'generic' },
      { name: 'c', order: 2.2, lifecycle: 'custom' },
    ],
    log,
  );
  await runPreflightGates(registries, {});
  assert.equal(typeof log[0].lifecycle, 'function', 'a generic step gets a runner');
  assert.equal(log[1].lifecycle, null, 'a custom step is TOLD it owns its own protocol');
});

test('plan 4056 driver: the runner a `generic` step receives is bound to THAT entry, not to a name the step passes', async () => {
  resetSpies();
  queueShas('feedface'.repeat(5), 'feedface'.repeat(5));
  driverFakes.interlude = null;
  const log = [];
  let whichRan = null;
  const registries = driverRegistry(
    [
      {
        name: 'gate-one',
        order: 2.1,
        lifecycle: 'generic',
        run: () => {
          whichRan = 'gate-one';
          return { ok: true };
        },
      },
      {
        name: 'gate-two',
        order: 2.2,
        lifecycle: 'custom',
        run: () => {
          whichRan = 'gate-two';
          return { ok: true };
        },
      },
    ],
    log,
  );
  await runPreflightGates(registries, {});
  // The step names neither the registry nor its own gate — that binding is the driver's, and it
  // is what lets a generic gate's step stop knowing either. Invoking the runner must reach
  // gate-one's own `run`.
  const out = await log[0].lifecycle({ wtPath: '/wt', diff: [], state: makeState() });
  assert.equal(whichRan, 'gate-one');
  assert.equal(out.classification, 'pass');
});

test('plan 4056 driver: the interlude runs at its DECLARED order, between the gates that bracket it', async () => {
  resetSpies();
  const log = [];
  driverFakes.interlude = {
    order: 2.595,
    run: (ctx) => log.push({ name: '<interlude>', ctx, lifecycle: undefined }),
  };
  const registries = driverRegistry(
    [
      { name: 'price-ish', order: 2.59 },
      { name: 'build-ish', order: 2.6 },
      { name: 'battery-ish', order: 2.662 },
    ],
    log,
  );
  await runPreflightGates(registries, { marker: 'ctx' });
  assert.deepEqual(
    log.map((c) => c.name),
    ['price-ish', '<interlude>', 'build-ish', 'battery-ish'],
    'the prune must land before the build gate, so that gate’s proof window never has to ' +
      'account for its filesystem churn — and the ORDER that places it is the host’s, not a ' +
      'gate name the core knows',
  );
  assert.equal(log[1].ctx.marker, 'ctx', 'the interlude sees the same land ctx every step sees');
});

test('plan 4056 driver: an interlude ordered after every gate still runs (the post-loop flush)', async () => {
  resetSpies();
  const log = [];
  driverFakes.interlude = { order: 99, run: () => log.push({ name: '<interlude>' }) };
  const registries = driverRegistry([{ name: 'only', order: 2.6 }], log);
  await runPreflightGates(registries, {});
  assert.deepEqual(
    log.map((c) => c.name),
    ['only', '<interlude>'],
    'an interlude past the last gate must not be silently dropped',
  );
});

test('plan 4056 driver: the interlude runs exactly ONCE, however many gates follow its order', async () => {
  resetSpies();
  const log = [];
  let interludeRuns = 0;
  driverFakes.interlude = {
    order: 2.0,
    run: () => {
      interludeRuns += 1;
      log.push({ name: '<interlude>' });
    },
  };
  const registries = driverRegistry(
    [
      { name: 'a', order: 2.1 },
      { name: 'b', order: 2.2 },
      { name: 'c', order: 2.3 },
    ],
    log,
  );
  await runPreflightGates(registries, {});
  assert.equal(interludeRuns, 1);
  assert.deepEqual(
    log.map((c) => c.name),
    ['<interlude>', 'a', 'b', 'c'],
  );
});

test('plan 4056 driver: a host declaring NO interlude runs the gates and nothing else', async () => {
  resetSpies();
  driverFakes.interlude = null;
  const log = [];
  const registries = driverRegistry([{ name: 'a', order: 2.1 }], log);
  const ran = await runPreflightGates(registries, {});
  assert.deepEqual(ran, ['a']);
  assert.equal(log.length, 1);
});

test('plan 4056 driver: an empty preflight roster is a no-op, not a crash (a config-less repo still lands)', async () => {
  resetSpies();
  driverFakes.interlude = null;
  const log = [];
  const registries = driverRegistry([{ name: 'lm', order: 3.5, stage: 'lane-merge' }], log);
  assert.deepEqual(await runPreflightGates(registries, {}), []);
});

test('plan 4056 driver: steps run SEQUENTIALLY — an async step completes before the next begins', async () => {
  resetSpies();
  driverFakes.interlude = null;
  const order = [];
  const registries = buildRegistries({
    prepGates: [
      {
        where: 'test',
        entries: [
          {
            name: 'slow',
            order: 2.1,
            run: () => ({ ok: true }),
            lifecycle: 'custom',
            step: async () => {
              order.push('slow:start');
              await new Promise((r) => setImmediate(r));
              order.push('slow:end');
            },
          },
          {
            name: 'next',
            order: 2.2,
            run: () => ({ ok: true }),
            lifecycle: 'custom',
            step: () => order.push('next:start'),
          },
        ],
      },
    ],
  });
  await runPreflightGates(registries, {});
  // A gate that ran under a still-running predecessor would see a tree the predecessor is still
  // changing — the disk prune under a build being the concrete case this file's own interlude
  // exists to order.
  assert.deepEqual(order, ['slow:start', 'slow:end', 'next:start']);
});

test('plan 4056 driver: a malformed interlude is REFUSED, not silently run in the wrong place', async () => {
  resetSpies();
  const log = [];
  const registries = driverRegistry([{ name: 'a', order: 2.1 }], log);
  for (const bad of [
    { order: undefined, run: () => {} },
    { order: 'early', run: () => {} },
    { order: NaN, run: () => {} },
    { order: 2.0, run: 'runIt' },
  ]) {
    driverFakes.interlude = bad;
    await assert.rejects(
      () => runPreflightGates(registries, {}),
      /preflightInterlude must be \{ order: <finite number>, run\(ctx\) \}/,
      `a malformed interlude (${JSON.stringify(bad.order)}) must throw, not misplace itself`,
    );
  }
  // The specific silent failure this closes: a non-numeric `order` makes every `order > before`
  // comparison false, so the interlude would run ahead of the FIRST gate. For the one real
  // interlude — a filesystem prune — that means churning the tree under a gate's proof window
  // instead of before it.
  driverFakes.interlude = null;
});

test('plan 4056 driver: an ASYNC interlude is awaited before the next gate starts', async () => {
  resetSpies();
  const order = [];
  driverFakes.interlude = {
    order: 2.0,
    run: async () => {
      order.push('interlude:start');
      await new Promise((r) => setImmediate(r));
      order.push('interlude:end');
    },
  };
  const registries = buildRegistries({
    prepGates: [
      {
        where: 'test',
        entries: [
          {
            name: 'a',
            order: 2.1,
            run: () => ({ ok: true }),
            lifecycle: 'custom',
            step: () => order.push('a'),
          },
        ],
      },
    ],
  });
  await runPreflightGates(registries, {});
  assert.deepEqual(order, ['interlude:start', 'interlude:end', 'a']);
  driverFakes.interlude = null;
});
