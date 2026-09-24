// scripts/coord/land/gates-core.test.mjs — the name-pair of scripts/coord/land/gates-core.mjs
// (plan 3961 T1). NEW-FILE JUSTIFICATION: the name-pair of a genuinely new module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_PREP_GATE_SPECS, coreGates, PREP_GATE_STAGES } from './gates-core.mjs';
import { buildRegistry, selectPrepGates, prepGateStage, optionalEntryKeys } from './registry.mjs';

const run = () => ({ ok: true });
// `build` and `battery` run at the default preflight stage, which now requires `lifecycle`+`step`
// (plan 4056 D-4056-12); `prettier` runs at `lane-merge` and must NOT declare either.
const fullImpl = () => ({
  build: { run, lifecycle: 'custom', step: () => {} },
  battery: { run, lifecycle: 'custom', step: () => {} },
  prettier: { run },
});

test('the core roster is exactly build, scripts-battery and prettier-drift', () => {
  assert.deepEqual(
    CORE_PREP_GATE_SPECS.map((s) => s.name),
    ['build', 'scripts-battery', 'prettier-drift'],
  );
  // vetapp's gates are deliberately ABSENT — they register through plugins.prepGates in T2, and
  // the core neither names them nor knows they exist.
  for (const vetapp of ['mobile', 'pytest-backend-scripts', 'price-trust', 'market-copy']) {
    assert.ok(
      !CORE_PREP_GATE_SPECS.some((s) => s.name === vetapp),
      `"${vetapp}" is a project gate and must not be in the core roster`,
    );
  }
});

test('every core spec declares a stage that is a real PREP_GATE_STAGES member', () => {
  for (const spec of CORE_PREP_GATE_SPECS) {
    assert.ok(PREP_GATE_STAGES.includes(spec.stage), `${spec.name} has bogus stage ${spec.stage}`);
  }
});

test('prettier-drift runs at lane-merge, not preflight — it inspects the POST-rebase tree', () => {
  const spec = CORE_PREP_GATE_SPECS.find((s) => s.name === 'prettier-drift');
  assert.equal(spec.stage, 'lane-merge');
  assert.equal(spec.chunkable, false);
  // the two heavy ones chunk, and run pre-queue
  for (const name of ['build', 'scripts-battery']) {
    const s = CORE_PREP_GATE_SPECS.find((x) => x.name === name);
    assert.equal(s.stage, 'preflight', name);
    assert.equal(s.chunkable, true, name);
  }
});

test('coreGates builds registry-valid entries carrying name/order/stage/chunkable', () => {
  const entries = coreGates(fullImpl());
  const built = buildRegistry('prepGates', [{ where: 'core', entries }]);
  assert.deepEqual(
    built.map((e) => e.name),
    ['build', 'scripts-battery', 'prettier-drift'],
  );
  assert.equal(prepGateStage(built.find((e) => e.name === 'build')), 'preflight');
  assert.deepEqual(
    selectPrepGates(built, [], {}, { stage: 'preflight' }).map((e) => e.name),
    ['build', 'scripts-battery'],
  );
});

test('an omitted impl key declines that gate — not an error', () => {
  // A repo with no frontend has no build gate, and that must not throw.
  const entries = coreGates({ battery: { run } });
  assert.deepEqual(
    entries.map((e) => e.name),
    ['scripts-battery'],
  );
  assert.deepEqual(coreGates({}), []);
  assert.deepEqual(coreGates(), []);
});

test('a PRESENT impl key with no run() is a bug, and says how to decline instead', () => {
  assert.throws(() => coreGates({ build: {} }), /impl\.build must provide run\(\)/);
  assert.throws(() => coreGates({ build: { run: 'nope' } }), /must provide run\(\)/);
  assert.throws(() => coreGates({ build: {} }), /omitting the whole key is how you decline/);
});

test('optional applies/cacheKey/passCacheGate are passed through only when provided', () => {
  const applies = () => true;
  const cacheKey = () => 'k';
  const [withOpts] = coreGates({
    build: { run, applies, cacheKey, passCacheGate: 'next-build' },
  });
  assert.equal(withOpts.applies, applies);
  assert.equal(withOpts.cacheKey, cacheKey);
  assert.equal(withOpts.passCacheGate, 'next-build');
  const [without] = coreGates({ build: { run } });
  // absent rather than undefined-valued: registry.mjs rejects unknown keys, and an explicitly
  // undefined optional is indistinguishable from a typo at the call site.
  assert.equal('applies' in without, false);
  assert.equal('cacheKey' in without, false);
  assert.equal('passCacheGate' in without, false);
});

test('the core roster is frozen data — a caller cannot mutate the shared specs', () => {
  assert.ok(Object.isFrozen(CORE_PREP_GATE_SPECS));
  for (const s of CORE_PREP_GATE_SPECS) assert.ok(Object.isFrozen(s));
  // but each coreGates() call yields FRESH entry objects, so one host's registry cannot be
  // mutated through another's
  const a = coreGates(fullImpl());
  const b = coreGates(fullImpl());
  assert.notEqual(a[0], b[0]);
});

test('only an ABSENT key declines — a falsy value is a bug (review round 1)', () => {
  // Findings dff9bd/c9a4e5: `!provided` swallowed false/0/'' too, so a host that computed its
  // impl bag and produced a falsy value for one gate silently lost that gate.
  for (const falsy of [false, 0, '']) {
    assert.throws(
      () => coreGates({ build: falsy }),
      /impl\.build must be an object with run\(\)/,
      `expected ${JSON.stringify(falsy)} to be refused`,
    );
  }
  // undefined and null are the two real spellings of "decline"
  assert.deepEqual(coreGates({ build: undefined }), []);
  assert.deepEqual(coreGates({ build: null }), []);
});

test('an unknown impl key is refused, not silently ignored (review round 2)', () => {
  // Finding 224f94: coreGates({ buidl: {...} }) registered nothing and said nothing.
  assert.throws(() => coreGates({ buidl: { run } }), /unknown key\(s\) buidl/);
  assert.throws(() => coreGates({ build: { run }, mobile: { run } }), /unknown key\(s\) mobile/);
  assert.throws(() => coreGates({ buidl: { run } }), /valid keys: build, battery, prettier/);
});

test('a falsy-but-PRESENT optional is forwarded so the registry can reject it (review round 2)', () => {
  // Findings 485547/6ff4a3: `if (provided.applies)` dropped `applies: 0`, turning a typo into a
  // gate that always applies. Forwarding it turns the same typo into an error at buildRegistry.
  const [e] = coreGates({ build: { run, applies: 0 } });
  assert.equal(e.applies, 0);
  assert.throws(
    () =>
      buildRegistry('prepGates', [
        { where: 'core', entries: coreGates({ build: { run, applies: 0 } }) },
      ]),
    /non-function "applies"/,
  );
  // an genuinely absent optional is still omitted entirely
  const [clean] = coreGates({ build: { run } });
  assert.equal('applies' in clean, false);
});

// A sentinel value shaped so registry.mjs's own normalizeEntry accepts it — the tests below prove
// a field reaches the REGISTRY, not merely the plain object coreGates hands back, so the sentinel
// must satisfy whatever type each field's validator expects (see registry.mjs's normalizeEntry).
function sentinelFor(key) {
  if (key === 'passCacheGate') return 'sentinel-cache-gate';
  if (key === 'prepPass') return true;
  if (key === 'seams') return { failed: 'SENTINEL_FAILED' };
  // plan 4056: `lifecycle` is an enum, not a function — a sentinel function would fail
  // registry.mjs's own lifecycle validation instead of proving the relay.
  if (key === 'lifecycle') return 'generic';
  return () => 'sentinel'; // applies/cacheKey/select/reclassify/provesGate/step: functions
}

test('plan 4042 (D-M7/D-M8/D-M9): every prepGates optional field the registry declares relays without editing this module', () => {
  // This is the regression test for the whole point of the change: it reads the relayable set
  // from registry.mjs's OWN declaration (never a hardcoded name list), so a field the registry
  // adds tomorrow is exercised here without touching this test either. `seams` is the field that
  // motivated the fix — declared in registry.mjs's POINT_SHAPES, dropped silently by the old
  // three-hand-written-line relay because nobody added a fourth line for it.
  const relayable = optionalEntryKeys('prepGates').filter(
    (k) => !['chunkable', 'stage'].includes(k),
  );
  assert.ok(
    relayable.length >= 8,
    `expected several relayable fields (plan 4042 added five on top of the original three), got: ${relayable.join(', ')}`,
  );
  assert.ok(relayable.includes('seams'), 'seams must be among the relayable fields');
  for (const key of relayable) {
    // `build` runs at the default preflight stage, which now REQUIRES both `lifecycle` and `step`
    // (plan 4056 D-4056-12) regardless of which single field this iteration is proving relays —
    // without them every iteration would fail on the mechanical stage check before ever reaching
    // the field under test. The computed `[key]` assignment intentionally comes last so that when
    // `key` IS `lifecycle` or `step`, its sentinel value overrides the base one above.
    const impl = { run, lifecycle: 'custom', step: () => {}, [key]: sentinelFor(key) };
    const [entry] = coreGates({ build: impl });
    assert.equal(entry[key], impl[key], `expected "${key}" to relay onto the build gate entry`);
    // And it must reach a real REGISTRY unrejected, not just sit on the plain object coreGates
    // returns — proving registry.mjs's own validator recognizes what was relayed.
    assert.doesNotThrow(
      () => buildRegistry('prepGates', [{ where: 'core', entries: [entry] }]),
      `expected relayed "${key}" to pass registry.mjs's own validation`,
    );
  }
});

test('an undeclared field on a gate impl bag throws, naming the field and the gate', () => {
  // This is exactly the check that would have caught `seams` being dropped immediately, had the
  // old three-line relay been the thing doing the catching instead of silently ignoring it.
  assert.throws(
    () => coreGates({ build: { run, bogusField: 1 } }),
    /impl\.build has unknown field "bogusField" for gate "build"/,
  );
  assert.throws(() => coreGates({ build: { run, bogusField: 1 } }), /valid fields: run, /);
});

test('chunkable/stage on a gate impl bag are refused — the core spec owns them, not the host', () => {
  // CORE_PREP_GATE_SPECS already sets chunkable/stage for every gate; a host supplying either
  // would either silently win (masking the spec) or silently lose (masking a bug in the host), so
  // both are refused instead, naming which spec value the host should have used unchanged.
  assert.throws(
    () => coreGates({ build: { run, chunkable: false } }),
    /impl\.build sets "chunkable", but the core gate spec already owns "chunkable" for "build"/,
  );
  assert.throws(
    () => coreGates({ prettier: { run, stage: 'preflight' } }),
    /impl\.prettier sets "stage", but the core gate spec already owns "stage" for "prettier-drift"/,
  );
});

test('a non-object impl BAG is refused, not read as empty (review round 3)', () => {
  // Finding 267615: Object.keys(false) and Object.keys([]) are both empty, so a non-object bag
  // passed the unknown-key check and then read every spec as absent — registering nothing.
  for (const bad of [false, 0, '', [], 'build', null]) {
    assert.throws(
      () => coreGates(bad),
      /impl must be a plain object/,
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
  // the two legitimate "nothing to register" spellings still work
  assert.deepEqual(coreGates(), []);
  assert.deepEqual(coreGates({}), []);
});
