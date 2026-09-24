// scripts/coord/land/seams-core.test.mjs — the name-pair of scripts/coord/land/seams-core.mjs
// (plan 3961 T1). NEW-FILE JUSTIFICATION: the name-pair of a genuinely new module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_LAND_SEAM_SPECS, coreSeams, seamResult } from './seams-core.mjs';
import { buildRegistry, runLandSeams, normalizeEntry, optionalEntryKeys } from './registry.mjs';

const ok = () => ({ ok: true });

test('the core seam roster is exactly review-marker, findings-open and conclusion-review', () => {
  assert.deepEqual(
    CORE_LAND_SEAM_SPECS.map((s) => s.name),
    ['review-marker', 'findings-open', 'conclusion-review'],
  );
});

test('conclusion-review IS registered here as core, at order 2.672 with key "conclusion" (plan 3961 T2.6/D2)', () => {
  // The seam's MECHANISM (an established world-claim may not be overwritten without a fresh
  // adversarial-review verdict) is generic over sharded record files; only the FIELD LIST is
  // project vocabulary, and that now lives at coord.config.json -> land.worldClaimFields
  // (default empty). The two seams nobody disputes are vetapp (status-flip / wiki-checkpoint)
  // stay OUT of the core roster.
  const spec = CORE_LAND_SEAM_SPECS.find((s) => s.name === 'conclusion-review');
  assert.ok(spec, 'conclusion-review must be registered as a core seam');
  assert.equal(spec.key, 'conclusion');
  assert.equal(spec.order, 2.672);
  for (const vetapp of ['status-flip', 'wiki-checkpoint']) {
    assert.ok(!CORE_LAND_SEAM_SPECS.some((s) => s.name === vetapp));
  }
});

test('coreSeams builds registry-valid entries that sort into the documented seam order', () => {
  const built = buildRegistry('landSeams', [
    {
      where: 'core',
      entries: coreSeams({
        review: { check: ok },
        findings: { check: ok },
        conclusion: { check: ok },
      }),
    },
  ]);
  assert.deepEqual(
    built.map((e) => e.name),
    ['review-marker', 'findings-open', 'conclusion-review'],
  );
  assert.equal(runLandSeams(built, {}).ok, true);
});

test('coreSeams registers conclusion-review alone when it is the only impl key provided', () => {
  const built = buildRegistry('landSeams', [
    { where: 'core', entries: coreSeams({ conclusion: { check: ok } }) },
  ]);
  assert.deepEqual(
    built.map((e) => e.name),
    ['conclusion-review'],
  );
});

test('the injected check() is what actually runs, and its seam is reported', () => {
  const built = buildRegistry('landSeams', [
    {
      where: 'core',
      entries: coreSeams({
        review: { check: ok },
        findings: { check: () => ({ ok: false, seam: 'FINDINGS_OPEN', message: '3 open' }) },
      }),
    },
  ]);
  assert.deepEqual(runLandSeams(built, {}), {
    ok: false,
    seam: 'FINDINGS_OPEN',
    message: '3 open',
    name: 'findings-open',
  });
});

test('an omitted impl key declines that seam — not an error', () => {
  assert.deepEqual(
    coreSeams({ review: { check: ok } }).map((e) => e.name),
    ['review-marker'],
  );
  assert.deepEqual(coreSeams({}), []);
  assert.deepEqual(coreSeams(), []);
});

test('a PRESENT impl key with no check() is a bug, and says how to decline instead', () => {
  assert.throws(() => coreSeams({ review: {} }), /impl\.review must provide check\(\)/);
  assert.throws(() => coreSeams({ findings: { check: 1 } }), /must provide check\(\)/);
  assert.throws(() => coreSeams({ review: {} }), /omitting the whole key is how you decline/);
});

test('the core roster is frozen data, and each call yields fresh entries', () => {
  assert.ok(Object.isFrozen(CORE_LAND_SEAM_SPECS));
  for (const s of CORE_LAND_SEAM_SPECS) assert.ok(Object.isFrozen(s));
  const a = coreSeams({ review: { check: ok } });
  const b = coreSeams({ review: { check: ok } });
  assert.notEqual(a[0], b[0]);
});

test('only an ABSENT key declines — a falsy value is a bug (review round 1)', () => {
  // Findings 881148/c6acdb: `!provided` swallowed false/0/'', which would silently drop the
  // review-marker or findings-open seam — the two that stop an unreviewed diff from landing.
  for (const falsy of [false, 0, '']) {
    assert.throws(
      () => coreSeams({ review: falsy }),
      /impl\.review must be an object with check\(\)/,
      `expected ${JSON.stringify(falsy)} to be refused`,
    );
  }
  assert.deepEqual(coreSeams({ review: undefined }), []);
  assert.deepEqual(coreSeams({ review: null }), []);
});

test('an unknown impl key is refused, not silently ignored (review round 2)', () => {
  assert.throws(() => coreSeams({ reveiw: { check: ok } }), /unknown key\(s\) reveiw/);
  assert.throws(
    () => coreSeams({ review: { check: ok }, 'status-flip': { check: ok } }),
    /unknown key\(s\) status-flip/,
  );
  assert.throws(() => coreSeams({ reveiw: { check: ok } }), /valid keys: review, findings/);
});

test('a non-object impl BAG is refused, not read as empty (review round 3)', () => {
  for (const bad of [false, 0, '', [], 'review', null]) {
    assert.throws(
      () => coreSeams(bad),
      /impl must be a plain object/,
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
  assert.deepEqual(coreSeams(), []);
  assert.deepEqual(coreSeams({}), []);
});

// plan 3961 T2 review (key 34fbae): `seamResult` — the `seam()`-shaped-nullable → registry
// `{ok,seam,message}` adapter — used to be a byte-identical private copy in BOTH
// done-worktree.mjs's coreSeamImpls() (review/findings/conclusion) and
// scripts/project/land-seams.mjs's project seams (status-flip/wiki-checkpoint). ONE definition
// here, imported by both, so a later change to the adapter cannot make core and project seams
// emit divergent `ok`/`message` results with nothing to catch it.
test('seamResult adapts a seam()-shaped value to the registry {ok,seam,message} contract', () => {
  assert.deepEqual(seamResult(null), { ok: true, seam: null, message: '' });
  assert.deepEqual(seamResult({ code: 'FINDINGS_OPEN', reason: '3 open' }), {
    ok: false,
    seam: 'FINDINGS_OPEN',
    message: '3 open',
  });
});

test('seamResult emits ONLY the documented shape — no extra field (gpt-review acb447)', () => {
  // The adapter first shipped as `…check(ctx).raw`, unwrapping a field the registry's landSeams
  // contract does not mention. A seam returning the documented { code, reason } shape then
  // yielded `undefined` for `.raw`, and every call site spells its halt as `if (seam)`, so a
  // registered land seam read as CLEARED and the land continued.
  const halted = seamResult({ code: 'X', reason: 'y', payload: { extra: true } });
  assert.deepEqual(Object.keys(halted).sort(), ['message', 'ok', 'seam']);
  assert.equal('raw' in halted, false);
  const cleared = seamResult(null);
  assert.deepEqual(Object.keys(cleared).sort(), ['message', 'ok', 'seam']);
});

// ── plan 4056: the impl-bag relay ──────────────────────────────────────────────────────────────
//
// Before the seam fold this builder produced `{ name, order, check }` and DROPPED everything else.
// That was harmless while `check` was the only field a seam could carry, and became a silent
// swallow the moment the one core-registered seam started declaring a guard, a resume code and a
// marker family: the entry would have reached the registry stripped of all three — always
// applying, never resumable, with no marker to be satisfied by. These cases pin the relay, and
// that it is DERIVED from the registry's own declaration rather than a second hand-written list.

test('plan 4056: coreSeams relays every optional landSeams field from the impl bag, verbatim', () => {
  const applies = () => true;
  const lookup = () => 'FOUND';
  const [entry] = coreSeams({
    conclusion: {
      check: () => ({ ok: true, seam: null, message: '' }),
      applies,
      seamCode: 'SOME_CODE',
      markerFamily: { key: 'fam', lookup, recorder: 'record-fam.mjs' },
    },
  });
  assert.equal(entry.name, 'conclusion-review');
  assert.equal(entry.applies, applies);
  assert.equal(entry.seamCode, 'SOME_CODE');
  assert.deepEqual(entry.markerFamily, { key: 'fam', lookup, recorder: 'record-fam.mjs' });
});

test('plan 4056: the relay allowlist is DERIVED from the registry, so a newly-declared optional field needs no edit here', () => {
  // The bug this guards against is the one this builder actually had: a field declared optional in
  // registry.mjs and forgotten in a hand-copied list here is dropped silently, not refused. Asking
  // the registry for its own list is what makes that impossible — asserted by pinning that EVERY
  // declared optional key survives the relay, whatever that list grows to.
  const bag = { check: () => ({ ok: true, seam: null, message: '' }) };
  for (const key of optionalEntryKeys('landSeams')) bag[key] = { sentinel: key };
  const [entry] = coreSeams({ conclusion: bag });
  for (const key of optionalEntryKeys('landSeams')) {
    assert.deepEqual(entry[key], { sentinel: key }, `optional field "${key}" must be relayed`);
  }
});

test('plan 4056: an impl-bag field the registry does not declare is REFUSED, not dropped', () => {
  assert.throws(
    () =>
      coreSeams({
        conclusion: { check: () => ({}), seamCodee: 'TYPO' },
      }),
    /unknown field "seamCodee" for seam "conclusion-review"/,
  );
});

test('plan 4056: an impl bag may not set name/order — the core spec owns both', () => {
  for (const key of ['name', 'order']) {
    assert.throws(
      () => coreSeams({ conclusion: { check: () => ({}), [key]: 'mine' } }),
      new RegExp(`sets "${key}", but the core seam spec already owns it`),
      key,
    );
  }
});

test('plan 4056: PRESENCE not truthiness — a falsy-but-present optional field reaches the registry, where it becomes an error', () => {
  // Dropping it would turn a typo into a seam that always applies; forwarding it turns the same
  // typo into registry.mjs's own refusal. Same reasoning as gates-core.mjs's relay.
  const [entry] = coreSeams({ conclusion: { check: () => ({}), applies: 0 } });
  assert.equal(entry.applies, 0);
  assert.throws(() => normalizeEntry('landSeams', entry, 'core'), /has a non-function "applies"/);
});
