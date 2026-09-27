// scripts/coord/land/registry.test.mjs — the name-pair of scripts/coord/land/registry.mjs
// (plan 3961 T1). NEW-FILE JUSTIFICATION (CLAUDE.md § a new scripts/*.test.mjs FILE requires
// one): the name-pair of a genuinely new module — registry.mjs is a new pure module with no
// existing name-paired test file to fold into, and folding it into done-worktree.test.mjs would
// couple the registry's tests to the spine internals the rest of this plan is rewriting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  EXTENSION_POINTS,
  isExtensionPoint,
  normalizeEntry,
  buildRegistry,
  buildRegistries,
  selectPrepGates,
  runLandSeams,
  runContextExtras,
  runStepRegistry,
  PREP_GATE_STAGES,
  prepGateStage,
  prepGateRunsInPrepPass,
  optionalEntryKeys,
  PREP_GATE_LIFECYCLES,
} from './registry.mjs';

const src = (entries, where = 'test') => [{ where, entries }];

// ── the point roster ──────────────────────────────────────────────────────────────────────────

test('EXTENSION_POINTS is the five-point roster and is frozen', () => {
  assert.deepEqual(
    [...EXTENSION_POINTS],
    ['contextExtras', 'landSeams', 'prepGates', 'postMerge', 'closeOutExtras'],
  );
  assert.ok(Object.isFrozen(EXTENSION_POINTS));
  for (const p of EXTENSION_POINTS) assert.equal(isExtensionPoint(p), true);
  assert.equal(isExtensionPoint('prepGate'), false);
  assert.equal(isExtensionPoint(''), false);
});

test('an unknown point name is refused, naming the valid set', () => {
  assert.throws(() => buildRegistry('gates', []), /unknown extension point "gates"/);
  assert.throws(() => buildRegistry('gates', []), /contextExtras, landSeams, prepGates/);
  assert.throws(() => buildRegistries({ nope: [] }), /sources names "nope"/);
});

// ── entry validation ──────────────────────────────────────────────────────────────────────────

test('normalizeEntry requires a name, a finite order, and the point-required functions', () => {
  const run = () => ({ ok: true });
  assert.throws(() => normalizeEntry('prepGates', null, 'm.mjs'), /is not an object/);
  assert.throws(() => normalizeEntry('prepGates', [], 'm.mjs'), /is not an object/);
  assert.throws(
    () => normalizeEntry('prepGates', { order: 1, run }, 'm.mjs'),
    /no non-empty "name"/,
  );
  assert.throws(
    () => normalizeEntry('prepGates', { name: '  ', order: 1, run }, 'm.mjs'),
    /no non-empty "name"/,
  );
  assert.throws(
    () => normalizeEntry('prepGates', { name: 'build', run }, 'm.mjs'),
    /needs a finite numeric "order"/,
  );
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '2.6', null]) {
    assert.throws(
      () => normalizeEntry('prepGates', { name: 'build', order: bad, run }, 'm.mjs'),
      /needs a finite numeric "order"/,
    );
  }
  assert.throws(
    () => normalizeEntry('prepGates', { name: 'build', order: 2.6 }, 'm.mjs'),
    /must define run\(\) as a function/,
  );
  assert.throws(
    () => normalizeEntry('landSeams', { name: 'review', order: 2.5 }, 'm.mjs'),
    /must define check\(\) as a function/,
  );
});

test('every error names WHERE the entry came from — the plugin module, not just the entry', () => {
  assert.throws(
    () => normalizeEntry('prepGates', { name: 'x', order: 1 }, 'scripts/project/land-gates.mjs'),
    /scripts\/project\/land-gates\.mjs/,
  );
});

test('an unknown key is refused rather than silently ignored', () => {
  // The motivating typo: `appliesTo` instead of `applies` would leave applies() undefined, i.e.
  // a gate that always runs — a behaviour change with no error anywhere.
  assert.throws(
    () =>
      normalizeEntry(
        'prepGates',
        {
          name: 'mobile',
          order: 2.66,
          run: () => ({ ok: true }),
          lifecycle: 'custom',
          step: () => {},
          appliesTo: () => true,
        },
        'm.mjs',
      ),
    /unknown key\(s\) appliesTo/,
  );
});

test('optional keys are type-checked; chunkable is the one boolean', () => {
  const base = {
    name: 'g',
    order: 1,
    run: () => ({ ok: true }),
    lifecycle: 'custom',
    step: () => {},
  };
  assert.throws(
    () => normalizeEntry('prepGates', { ...base, applies: 'yes' }, 'm.mjs'),
    /non-function "applies"/,
  );
  assert.throws(
    () => normalizeEntry('prepGates', { ...base, cacheKey: 42 }, 'm.mjs'),
    /non-function "cacheKey"/,
  );
  assert.throws(
    () => normalizeEntry('prepGates', { ...base, chunkable: 'true' }, 'm.mjs'),
    /non-boolean "chunkable"/,
  );
  // plan 3961 T3.5b: `passCacheGate` is a STRING, unlike `cacheKey` (a function) — the two look
  // similar enough to invite conflating them, so both directions are pinned: a non-string is
  // refused, and a real string round-trips.
  assert.throws(
    () => normalizeEntry('prepGates', { ...base, passCacheGate: 42 }, 'm.mjs'),
    /non-string "passCacheGate"/,
  );
  assert.throws(
    () => normalizeEntry('prepGates', { ...base, passCacheGate: '' }, 'm.mjs'),
    /non-string "passCacheGate"/,
  );
  assert.equal(
    normalizeEntry('prepGates', { ...base, passCacheGate: 'next-build' }, 'm.mjs').passCacheGate,
    'next-build',
  );
  // undefined optional keys are fine, and chunkable:false is a real value not an absence
  assert.equal(
    normalizeEntry('prepGates', { ...base, chunkable: false }, 'm.mjs').chunkable,
    false,
  );
});

test('plan 4042 D-M12: provesGate is a function, like select/reclassify/remainder/invalidatedBy', () => {
  const base = {
    name: 'g',
    order: 1,
    run: () => ({ ok: true }),
    lifecycle: 'custom',
    step: () => {},
  };
  assert.throws(
    () => normalizeEntry('prepGates', { ...base, provesGate: true }, 'm.mjs'),
    /non-function "provesGate"/,
  );
  const provesGate = (result) => result.verified === true;
  assert.equal(
    normalizeEntry('prepGates', { ...base, provesGate }, 'm.mjs').provesGate,
    provesGate,
  );
});

test('optionalEntryKeys exposes exactly POINT_SHAPES optional list, and never the live array', () => {
  // gates-core.mjs's relay (plan 4042) derives its allowlist from this accessor instead of
  // hand-listing field names a second time — this pins the contract that accessor relies on.
  const keys = optionalEntryKeys('prepGates');
  for (const expected of [
    'applies',
    'cacheKey',
    'passCacheGate',
    'chunkable',
    'stage',
    'prepPass',
    'select',
    'reclassify',
    'provesGate',
    'seams',
  ]) {
    assert.ok(
      keys.includes(expected),
      `expected optionalEntryKeys('prepGates') to include "${expected}"`,
    );
  }
  // plan 4056 (the seam fold) gave landSeams three optional fields of its own; seams-core.mjs's
  // relay derives its allowlist from this same accessor, exactly as gates-core.mjs's does.
  assert.deepEqual(optionalEntryKeys('landSeams').sort(), ['applies', 'markerFamily', 'seamCode']);
  assert.deepEqual(optionalEntryKeys('contextExtras'), ['applies']);
  // a caller mutating the returned array must not touch what a later call sees
  keys.push('bogus');
  assert.ok(!optionalEntryKeys('prepGates').includes('bogus'));
  assert.throws(() => optionalEntryKeys('nope'), /unknown extension point "nope"/);
});

test('normalizeEntry stamps `where` and does not mutate the caller"s object', () => {
  const raw = {
    name: 'g',
    order: 1,
    run: () => ({ ok: true }),
    lifecycle: 'custom',
    step: () => {},
  };
  const norm = normalizeEntry('prepGates', raw, 'm.mjs');
  assert.equal(norm.where, 'm.mjs');
  assert.equal('where' in raw, false);
});

// ── ordering ──────────────────────────────────────────────────────────────────────────────────

test('entries sort by order ascending, across sources, regardless of source order', () => {
  const g = (name, order) => ({
    name,
    order,
    run: () => ({ ok: true }),
    lifecycle: 'custom',
    step: () => {},
  });
  // vetapp's real shape: project gates interleave with core ones, and the project source is
  // appended AFTER the core one — the case registration order alone cannot express.
  const built = buildRegistry('prepGates', [
    { where: 'core', entries: [g('build', 2.6), g('scripts-battery', 2.662)] },
    { where: 'project', entries: [g('price-trust', 2.59), g('mobile', 2.66), g('pytest', 2.661)] },
  ]);
  assert.deepEqual(
    built.map((e) => e.name),
    ['price-trust', 'build', 'mobile', 'pytest', 'scripts-battery'],
  );
});

test('the seam registry sorts into the documented seam order', () => {
  const s = (name, order) => ({ name, order, check: () => ({ ok: true }) });
  const built = buildRegistry('landSeams', [
    { where: 'core', entries: [s('review', 2.5), s('findings', 2.55)] },
    {
      where: 'project',
      entries: [s('wiki-checkpoint', 2.68), s('conclusion-review', 2.672), s('status-flip', 2.67)],
    },
  ]);
  assert.deepEqual(
    built.map((e) => e.name),
    ['review', 'findings', 'status-flip', 'conclusion-review', 'wiki-checkpoint'],
  );
});

test('equal order keys keep registration order (stable) — a golden cannot flap on it', () => {
  const g = (name) => ({
    name,
    order: 5,
    run: () => ({ ok: true }),
    lifecycle: 'custom',
    step: () => {},
  });
  const names = () =>
    buildRegistry('prepGates', [{ where: 'core', entries: [g('a'), g('b'), g('c'), g('d')] }]).map(
      (e) => e.name,
    );
  assert.deepEqual(names(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(names(), ['a', 'b', 'c', 'd']); // deterministic across runs
});

test('duplicate names are refused, naming both sources', () => {
  const g = (name, order) => ({
    name,
    order,
    run: () => ({ ok: true }),
    lifecycle: 'custom',
    step: () => {},
  });
  assert.throws(
    () =>
      buildRegistry('prepGates', [
        { where: 'core', entries: [g('build', 2.6)] },
        { where: 'project/land-gates.mjs', entries: [g('build', 9)] },
      ]),
    /two entries named "build" \(core and project\/land-gates\.mjs\)/,
  );
});

test('a source that is not an array is refused', () => {
  assert.throws(
    () => buildRegistry('prepGates', [{ where: 'p.mjs', entries: { name: 'x' } }]),
    /source p\.mjs did not provide an array/,
  );
});

// ── buildRegistries ───────────────────────────────────────────────────────────────────────────

test('buildRegistries: every point present, a missing point is EMPTY not an error', () => {
  const regs = buildRegistries({
    prepGates: src([
      {
        name: 'build',
        order: 2.6,
        run: () => ({ ok: true }),
        lifecycle: 'custom',
        step: () => {},
      },
    ]),
  });
  for (const p of EXTENSION_POINTS) assert.ok(Array.isArray(regs[p]), `${p} missing`);
  assert.equal(regs.prepGates.length, 1);
  assert.deepEqual(regs.landSeams, []);
  assert.deepEqual(regs.closeOutExtras, []);
});

test('buildRegistries with NO sources at all yields five empty registries', () => {
  // The config-less repo: it registers nothing and must still build.
  const regs = buildRegistries();
  for (const p of EXTENSION_POINTS) assert.deepEqual(regs[p], []);
});

// ── selectPrepGates ───────────────────────────────────────────────────────────────────────────

test('selectPrepGates: no applies() means always applies; order is preserved', () => {
  const gates = buildRegistry('prepGates', [
    {
      where: 'core',
      entries: [
        {
          name: 'always',
          order: 1,
          run: () => ({ ok: true }),
          lifecycle: 'custom',
          step: () => {},
        },
        {
          name: 'never',
          order: 2,
          applies: () => false,
          run: () => ({ ok: true }),
          lifecycle: 'custom',
          step: () => {},
        },
        {
          name: 'frontend',
          order: 3,
          applies: (diff) => diff.some((f) => f.startsWith('frontend/')),
          run: () => ({ ok: true }),
          lifecycle: 'custom',
          step: () => {},
        },
      ],
    },
  ]);
  assert.deepEqual(
    selectPrepGates(gates, ['frontend/src/app/page.tsx'], {}).map((g) => g.name),
    ['always', 'frontend'],
  );
  assert.deepEqual(
    selectPrepGates(gates, ['scripts/x.mjs'], {}).map((g) => g.name),
    ['always'],
  );
});

test('selectPrepGates passes BOTH the diff and the ctx to applies()', () => {
  const seen = [];
  const gates = buildRegistry('prepGates', [
    {
      where: 'core',
      entries: [
        {
          name: 'g',
          order: 1,
          applies: (diff, ctx) => {
            seen.push([diff, ctx]);
            return true;
          },
          run: () => ({ ok: true }),
          lifecycle: 'custom',
          step: () => {},
        },
      ],
    },
  ]);
  const ctx = { slug: 's' };
  selectPrepGates(gates, ['a.mjs'], ctx);
  assert.deepEqual(seen, [[['a.mjs'], ctx]]);
});

// ── runLandSeams ──────────────────────────────────────────────────────────────────────────────

test('runLandSeams returns ok when every check passes, and runs them all', () => {
  const ran = [];
  const seams = buildRegistry('landSeams', [
    {
      where: 'core',
      entries: [
        { name: 'review', order: 2.5, check: () => (ran.push('review'), { ok: true }) },
        { name: 'findings', order: 2.55, check: () => (ran.push('findings'), { ok: true }) },
      ],
    },
  ]);
  assert.deepEqual(runLandSeams(seams, {}), { ok: true, seam: null, message: '', name: null });
  assert.deepEqual(ran, ['review', 'findings']);
});

test('runLandSeams stops at the FIRST failing seam and reports it', () => {
  const ran = [];
  const seams = buildRegistry('landSeams', [
    {
      where: 'core',
      entries: [
        { name: 'review', order: 2.5, check: () => (ran.push('review'), { ok: true }) },
        {
          name: 'findings',
          order: 2.55,
          check: () => (
            ran.push('findings'),
            { ok: false, seam: 'FINDINGS_OPEN', message: '3 open' }
          ),
        },
        { name: 'status-flip', order: 2.67, check: () => (ran.push('status-flip'), { ok: true }) },
      ],
    },
  ]);
  assert.deepEqual(runLandSeams(seams, {}), {
    ok: false,
    seam: 'FINDINGS_OPEN',
    message: '3 open',
    name: 'findings',
  });
  // the seam AFTER the failure never ran — the spine exits at the first seam today
  assert.deepEqual(ran, ['review', 'findings']);
});

test('a seam that fails without a seam code, or returns nothing, is a BUG in the entry', () => {
  const bad = (name, check) =>
    buildRegistry('landSeams', [{ where: 'p.mjs', entries: [{ name, order: 1, check }] }]);
  assert.throws(
    () =>
      runLandSeams(
        bad('a', () => ({ ok: false })),
        {},
      ),
    /reported a failure with no "seam" code/,
  );
  assert.throws(
    () =>
      runLandSeams(
        bad('b', () => undefined),
        {},
      ),
    /returned no result object/,
  );
  assert.throws(
    () =>
      runLandSeams(
        bad('c', () => 'nope'),
        {},
      ),
    /returned no result object/,
  );
  // and the error names the offending entry + module
  assert.throws(
    () =>
      runLandSeams(
        bad('d', () => ({ ok: false })),
        {},
      ),
    /"d" \(p\.mjs\)/,
  );
});

// ── runContextExtras ──────────────────────────────────────────────────────────────────────────

test('runContextExtras merges each extra"s object into ctx, in order', () => {
  const extras = buildRegistry('contextExtras', [
    {
      where: 'project',
      entries: [
        { name: 'seed-lane', order: 1, run: () => ({ lane: 'seed' }) },
        { name: 'seed-scope', order: 2, run: () => ({ scope: { global: false } }) },
      ],
    },
  ]);
  assert.deepEqual(runContextExtras(extras, { slug: 's' }, []), {
    slug: 's',
    lane: 'seed',
    scope: { global: false },
  });
});

test('a later extra SEES what an earlier one added', () => {
  const extras = buildRegistry('contextExtras', [
    {
      where: 'project',
      entries: [
        { name: 'lane', order: 1, run: () => ({ lane: 'seed' }) },
        {
          name: 'views',
          order: 2,
          run: (ctx) => ({ views: ctx.lane === 'seed' ? ['shard'] : [] }),
        },
      ],
    },
  ]);
  assert.deepEqual(runContextExtras(extras, {}, []).views, ['shard']);
});

test('runContextExtras does not mutate the ctx it was handed', () => {
  const ctx = { slug: 's' };
  const extras = buildRegistry('contextExtras', [
    { where: 'p', entries: [{ name: 'x', order: 1, run: () => ({ added: true }) }] },
  ]);
  const out = runContextExtras(extras, ctx, []);
  assert.deepEqual(ctx, { slug: 's' });
  assert.equal(out.added, true);
});

test('null/undefined contributes nothing; a non-object throws naming the entry', () => {
  const mk = (run) =>
    buildRegistry('contextExtras', [{ where: 'p.mjs', entries: [{ name: 'x', order: 1, run }] }]);
  assert.deepEqual(
    runContextExtras(
      mk(() => null),
      { a: 1 },
      [],
    ),
    { a: 1 },
  );
  assert.deepEqual(
    runContextExtras(
      mk(() => undefined),
      { a: 1 },
      [],
    ),
    { a: 1 },
  );
  assert.throws(
    () =>
      runContextExtras(
        mk(() => 7),
        {},
        [],
      ),
    /"x" \(p\.mjs\) returned a non-object/,
  );
  assert.throws(
    () =>
      runContextExtras(
        mk(() => [1]),
        {},
        [],
      ),
    /returned a non-object/,
  );
});

test('two extras defining the SAME ctx key is refused, not silently order-dependent', () => {
  const extras = buildRegistry('contextExtras', [
    {
      where: 'p',
      entries: [
        { name: 'a', order: 1, run: () => ({ seedScope: 1 }) },
        { name: 'b', order: 2, run: () => ({ seedScope: 2 }) },
      ],
    },
  ]);
  assert.throws(() => runContextExtras(extras, {}, []), /"a" and "b" both define ctx\.seedScope/);
});

test('an extra may overwrite a key that came in on the ORIGINAL ctx — only extra-vs-extra collides', () => {
  // The collision rule is about two EXTRAS disagreeing. Deliberately shadowing a ctx value the
  // spine computed is a legitimate thing for one extra to do.
  const extras = buildRegistry('contextExtras', [
    { where: 'p', entries: [{ name: 'a', order: 1, run: () => ({ lane: 'seed' }) }] },
  ]);
  assert.equal(runContextExtras(extras, { lane: 'free' }, []).lane, 'seed');
});

test('an extra with applies() returning false is skipped entirely', () => {
  let ran = false;
  const extras = buildRegistry('contextExtras', [
    {
      where: 'p',
      entries: [
        {
          name: 'seed-only',
          order: 1,
          applies: (diff) => diff.some((f) => f.startsWith('seed/')),
          run: () => ((ran = true), { seed: true }),
        },
      ],
    },
  ]);
  assert.deepEqual(runContextExtras(extras, { a: 1 }, ['scripts/x.mjs']), { a: 1 });
  assert.equal(ran, false);
});

// ── runStepRegistry ───────────────────────────────────────────────────────────────────────────

test('runStepRegistry runs entries in order and reports what ran', async () => {
  const ran = [];
  const steps = buildRegistry('postMerge', [
    {
      where: 'project',
      entries: [
        { name: 'deploy-check', order: 2, run: () => ran.push('deploy-check') },
        { name: 'first', order: 1, run: () => ran.push('first') },
      ],
    },
  ]);
  assert.deepEqual(await runStepRegistry(steps, {}), [
    { name: 'first', ok: true, error: null },
    { name: 'deploy-check', ok: true, error: null },
  ]);
  assert.deepEqual(ran, ['first', 'deploy-check']);
});

test('by default a throwing step propagates — a postMerge failure is a land failure', async () => {
  const steps = buildRegistry('postMerge', [
    {
      where: 'p',
      entries: [
        {
          name: 'boom',
          order: 1,
          run: () => {
            throw new Error('deploy 500');
          },
        },
      ],
    },
  ]);
  await assert.rejects(() => runStepRegistry(steps, {}), /deploy 500/);
});

test('bestEffort catches per entry and keeps going — the close-out sweep contract', async () => {
  const ran = [];
  const steps = buildRegistry('closeOutExtras', [
    {
      where: 'p',
      entries: [
        {
          name: 'wiki-sweep',
          order: 1,
          run: () => {
            throw new Error('sweep blew up');
          },
        },
        { name: 'after', order: 2, run: () => ran.push('after') },
      ],
    },
  ]);
  const out = await runStepRegistry(steps, {}, { bestEffort: true });
  assert.equal(out[0].name, 'wiki-sweep');
  assert.equal(out[0].ok, false);
  assert.match(String(out[0].error?.message), /sweep blew up/);
  assert.deepEqual(out[1], { name: 'after', ok: true, error: null });
  // a failing extra must NOT stop the ones after it
  assert.deepEqual(ran, ['after']);
});

test('runStepRegistry honours applies() with the diff it is given', async () => {
  const ran = [];
  const steps = buildRegistry('closeOutExtras', [
    {
      where: 'p',
      entries: [
        {
          name: 'wiki',
          order: 1,
          applies: (diff) => diff !== null && diff.includes('wiki/x.md'),
          run: () => ran.push('wiki'),
        },
      ],
    },
  ]);
  await runStepRegistry(steps, {}, { diff: ['scripts/a.mjs'] });
  assert.deepEqual(ran, []);
  await runStepRegistry(steps, {}, { diff: ['wiki/x.md'] });
  assert.deepEqual(ran, ['wiki']);
});

// ── the whole thing, once, in the shape the spine will use it ─────────────────────────────────

test('end to end: core + project sources build the five registries the spine consults', async () => {
  const regs = buildRegistries({
    contextExtras: src([{ name: 'seed-lane', order: 1, run: () => ({ lane: 'seed' }) }], 'project'),
    prepGates: [
      {
        where: 'core',
        entries: [
          {
            name: 'build',
            order: 2.6,
            run: () => ({ ok: true }),
            lifecycle: 'custom',
            step: () => {},
          },
        ],
      },
      {
        where: 'project',
        entries: [
          {
            name: 'price-trust',
            order: 2.59,
            run: () => ({ ok: true }),
            lifecycle: 'custom',
            step: () => {},
          },
          {
            name: 'mobile',
            order: 2.66,
            chunkable: true,
            run: () => ({ ok: true }),
            lifecycle: 'custom',
            step: () => {},
          },
        ],
      },
    ],
    landSeams: src([{ name: 'review', order: 2.5, check: () => ({ ok: true }) }], 'core'),
    postMerge: src([{ name: 'deploy', order: 1, run: () => {} }], 'project'),
    closeOutExtras: src([{ name: 'wiki-sweep', order: 1, run: () => {} }], 'project'),
  });

  assert.deepEqual(
    regs.prepGates.map((g) => g.name),
    ['price-trust', 'build', 'mobile'],
  );
  assert.equal(regs.prepGates.find((g) => g.name === 'mobile').chunkable, true);
  assert.equal(regs.prepGates.find((g) => g.name === 'build').chunkable, undefined);

  const ctx = runContextExtras(regs.contextExtras, { slug: 's' }, []);
  assert.equal(ctx.lane, 'seed');
  assert.equal(runLandSeams(regs.landSeams, ctx).ok, true);
  assert.deepEqual(
    selectPrepGates(regs.prepGates, [], ctx).map((g) => g.name),
    ['price-trust', 'build', 'mobile'],
  );
  assert.equal((await runStepRegistry(regs.postMerge, ctx)).length, 1);
  assert.equal((await runStepRegistry(regs.closeOutExtras, ctx, { bestEffort: true }))[0].ok, true);
});

// ── the `prepPass` axis (prepGates only) ──────────────────────────────────────────────────────
//
// plan 3961 T1d. `stage` says WHERE in a land a gate runs; `prepPass` says whether the out-of-band
// `--prep` pre-pass covers it at all. Today exactly one preflight-stage gate declines (vetapp's
// price-trust gate is land-only), and before this axis existed that fact lived only in a comment
// and in the shape of a hard-coded array inside runPrepGates.

test('prepPass defaults to true and only false declines the prep pass', () => {
  const base = {
    name: 'g',
    order: 1,
    run: () => ({ ok: true }),
    lifecycle: 'custom',
    step: () => {},
  };
  assert.equal(prepGateRunsInPrepPass(normalizeEntry('prepGates', base, 'm.mjs')), true);
  assert.equal(
    prepGateRunsInPrepPass(normalizeEntry('prepGates', { ...base, prepPass: true }, 'm.mjs')),
    true,
  );
  assert.equal(
    prepGateRunsInPrepPass(normalizeEntry('prepGates', { ...base, prepPass: false }, 'm.mjs')),
    false,
  );
});

test('prepPass must be a boolean — a truthy string is a bug, not a yes', () => {
  const base = { name: 'g', order: 1, run: () => ({ ok: true }) };
  assert.throws(
    () => normalizeEntry('prepGates', { ...base, prepPass: 'false' }, 'm.mjs'),
    /has a non-boolean "prepPass"/,
  );
  // The sibling boolean key keeps its own name in the same message.
  assert.throws(
    () => normalizeEntry('prepGates', { ...base, chunkable: 1 }, 'm.mjs'),
    /has a non-boolean "chunkable"/,
  );
});

test('prepPass is a prepGates-only key — other points reject it as unknown', () => {
  assert.throws(
    () =>
      buildRegistry(
        'landSeams',
        src([{ name: 's', order: 1, prepPass: true, check: () => ({ ok: true }) }]),
      ),
    /unknown key\(s\) prepPass/,
  );
});

test('selectPrepGates { prepPassOnly } drops the land-only gates, and composes with stage', () => {
  // The real roster shape at T1d: price-trust (2.59) is preflight-stage but land-only, and sorts
  // BEFORE the core build gate — so a prep pass that forgot to drop it would not merely run an
  // extra gate, it would run it FIRST.
  const gates = buildRegistry(
    'prepGates',
    src([
      {
        name: 'price-trust',
        order: 2.59,
        prepPass: false,
        run: () => ({ ok: true }),
        lifecycle: 'custom',
        step: () => {},
      },
      {
        name: 'build',
        order: 2.6,
        run: () => ({ ok: true }),
        lifecycle: 'custom',
        step: () => {},
      },
      {
        name: 'scripts-battery',
        order: 2.662,
        run: () => ({ ok: true }),
        lifecycle: 'custom',
        step: () => {},
      },
      { name: 'prettier-drift', order: 3.5, stage: 'lane-merge', run: () => ({ ok: true }) },
    ]),
  );
  assert.deepEqual(
    selectPrepGates(gates, [], {}, { stage: 'preflight' }).map((g) => g.name),
    ['price-trust', 'build', 'scripts-battery'],
  );
  assert.deepEqual(
    selectPrepGates(gates, [], {}, { stage: 'preflight', prepPassOnly: true }).map((g) => g.name),
    ['build', 'scripts-battery'],
  );
  // prepPassOnly alone spans every stage — the two options compose rather than one implying the
  // other, which is why the lane-merge gate (declaring no prepPass) stays in THIS selection even
  // though the real pre-pass, which asks for the preflight stage, never sees it. See
  // prepGateRunsInPrepPass's SCOPE note: on a non-preflight gate the `true` default is not a claim
  // that the pre-pass runs it (gpt-review ebfa7d).
  assert.deepEqual(
    selectPrepGates(gates, [], {}, { prepPassOnly: true }).map((g) => g.name),
    ['build', 'scripts-battery', 'prettier-drift'],
  );
  // Default is the whole roster — omitting the option must never quietly mean "true".
  assert.equal(selectPrepGates(gates, [], {}).length, 4);
});

test('selectPrepGates REFUSES a non-boolean prepPassOnly instead of coercing it', () => {
  // Same reason as the unknown-stage refusal below: a caller passing a string has a bug, and
  // silently reading it as `true` drops gates without a word.
  const gates = buildRegistry(
    'prepGates',
    src([
      {
        name: 'g',
        order: 1,
        run: () => ({ ok: true }),
        lifecycle: 'custom',
        step: () => {},
      },
    ]),
  );
  assert.throws(
    () => selectPrepGates(gates, [], {}, { prepPassOnly: 'yes' }),
    /prepPassOnly must be a boolean/,
  );
  assert.equal(selectPrepGates(gates, [], {}, { prepPassOnly: false }).length, 1);
});

// ── the `stage` axis (prepGates only) ─────────────────────────────────────────────────────────

test('PREP_GATE_STAGES is the three-stage roster and is frozen', () => {
  assert.deepEqual([...PREP_GATE_STAGES], ['preflight', 'lane-merge', 'deploy-wall']);
  assert.ok(Object.isFrozen(PREP_GATE_STAGES));
});

test('stage defaults to preflight and validates against the enum', () => {
  const base = { name: 'g', order: 1, run: () => ({ ok: true }) };
  assert.equal(
    prepGateStage(
      normalizeEntry('prepGates', { ...base, lifecycle: 'custom', step: () => {} }, 'm.mjs'),
    ),
    'preflight',
  );
  assert.equal(
    prepGateStage(normalizeEntry('prepGates', { ...base, stage: 'deploy-wall' }, 'm.mjs')),
    'deploy-wall',
  );
  assert.throws(
    () => normalizeEntry('prepGates', { ...base, stage: 'preFlight' }, 'm.mjs'),
    /has stage "preFlight" — expected one of: preflight, lane-merge, deploy-wall/,
  );
  assert.throws(
    () => normalizeEntry('prepGates', { ...base, stage: '' }, 'm.mjs'),
    /expected one of: preflight, lane-merge, deploy-wall/,
  );
});

test('stage is a prepGates-only key — other points reject it as unknown', () => {
  assert.throws(
    () =>
      normalizeEntry(
        'landSeams',
        { name: 's', order: 1, stage: 'preflight', check: () => ({ ok: true }) },
        'm.mjs',
      ),
    /unknown key\(s\) stage/,
  );
});

test('selectPrepGates filters by stage, and omitting stage returns every stage', () => {
  // The real roster shape: three stages, and the caller is a different phase of the spine each
  // time. Ordering is preserved within a stage.
  const gates = buildRegistry('prepGates', [
    {
      where: 'core',
      entries: [
        {
          name: 'build',
          order: 2.6,
          run: () => ({ ok: true }),
          lifecycle: 'custom',
          step: () => {},
        },
        {
          name: 'scripts-battery',
          order: 2.662,
          run: () => ({ ok: true }),
          lifecycle: 'custom',
          step: () => {},
        },
        { name: 'prettier-drift', order: 3.5, stage: 'lane-merge', run: () => ({ ok: true }) },
      ],
    },
    {
      where: 'project',
      entries: [
        {
          name: 'price-trust',
          order: 2.59,
          run: () => ({ ok: true }),
          lifecycle: 'custom',
          step: () => {},
        },
        { name: 'market-copy', order: 4, stage: 'deploy-wall', run: () => ({ ok: true }) },
      ],
    },
  ]);
  assert.deepEqual(
    selectPrepGates(gates, [], {}, { stage: 'preflight' }).map((g) => g.name),
    ['price-trust', 'build', 'scripts-battery'],
  );
  assert.deepEqual(
    selectPrepGates(gates, [], {}, { stage: 'lane-merge' }).map((g) => g.name),
    ['prettier-drift'],
  );
  assert.deepEqual(
    selectPrepGates(gates, [], {}, { stage: 'deploy-wall' }).map((g) => g.name),
    ['market-copy'],
  );
  // no stage filter = the whole roster, which is what a gatesProven roster consumer wants
  assert.equal(selectPrepGates(gates, [], {}).length, 5);
});

test('stage and applies() compose — both must pass', () => {
  const gates = buildRegistry('prepGates', [
    {
      where: 'core',
      entries: [
        {
          name: 'build',
          order: 1,
          applies: (diff) => diff.some((f) => f.startsWith('frontend/')),
          run: () => ({ ok: true }),
          lifecycle: 'custom',
          step: () => {},
        },
      ],
    },
  ]);
  assert.equal(selectPrepGates(gates, ['scripts/a.mjs'], {}, { stage: 'preflight' }).length, 0);
  assert.equal(selectPrepGates(gates, ['frontend/a.tsx'], {}, { stage: 'preflight' }).length, 1);
  assert.equal(selectPrepGates(gates, ['frontend/a.tsx'], {}, { stage: 'lane-merge' }).length, 0);
});

// ── review round 1 fixes ──────────────────────────────────────────────────────────────────────

test('runLandSeams requires ok === true — a truthy non-boolean is a BUG, not a pass', () => {
  // Finding 9fcc44/b1096e/68f22c: `if (r.ok) continue` accepted `{ok: 'false'}`, so a seam that
  // stringified its verdict would be read as PASSED and an unsafe land would proceed.
  const mk = (check) =>
    buildRegistry('landSeams', [{ where: 'p.mjs', entries: [{ name: 's', order: 1, check }] }]);
  assert.throws(
    () =>
      runLandSeams(
        mk(() => ({ ok: 'false', seam: 'BLOCK' })),
        {},
      ),
    /non-boolean "ok"/,
  );
  assert.throws(
    () =>
      runLandSeams(
        mk(() => ({ ok: 1 })),
        {},
      ),
    /non-boolean "ok"/,
  );
  assert.throws(
    () =>
      runLandSeams(
        mk(() => ({ ok: 'true' })),
        {},
      ),
    /non-boolean "ok"/,
  );
  // the two real values still work
  assert.equal(
    runLandSeams(
      mk(() => ({ ok: true })),
      {},
    ).ok,
    true,
  );
  assert.equal(
    runLandSeams(
      mk(() => ({ ok: false, seam: 'X' })),
      {},
    ).seam,
    'X',
  );
});

test('a seam or context extra that returns a PROMISE is refused, not silently passed', () => {
  // These two runners are deliberately synchronous (the spine's seams and context are computed
  // from state already in hand). An async one would have its result read as a truthy object and
  // never awaited — a seam that always "passes". Refuse it loudly instead.
  const seams = buildRegistry('landSeams', [
    {
      where: 'p.mjs',
      entries: [{ name: 's', order: 1, check: async () => ({ ok: false, seam: 'X' }) }],
    },
  ]);
  assert.throws(
    () => runLandSeams(seams, {}),
    /returned a Promise, but this runner is[\s\S]*synchronous/,
  );
  const extras = buildRegistry('contextExtras', [
    { where: 'p.mjs', entries: [{ name: 'x', order: 1, run: async () => ({ a: 1 }) }] },
  ]);
  assert.throws(
    () => runContextExtras(extras, {}, []),
    /returned a Promise, but this runner is[\s\S]*synchronous/,
  );
});

test('runStepRegistry AWAITS async steps, and bestEffort catches a rejection', async () => {
  // Finding 01f446/efebc2: postMerge's deploy check is genuine network IO, so these steps are the
  // ones that really are async — an unawaited run() would report ok before it finished, and a
  // rejected promise would escape bestEffort entirely.
  const order = [];
  const steps = buildRegistry('postMerge', [
    {
      where: 'p',
      entries: [
        {
          name: 'slow',
          order: 1,
          run: async () => {
            await new Promise((r) => setTimeout(r, 10));
            order.push('slow');
          },
        },
        { name: 'fast', order: 2, run: () => order.push('fast') },
      ],
    },
  ]);
  const ran = await runStepRegistry(steps, {});
  assert.deepEqual(order, ['slow', 'fast'], 'an async step must complete before the next starts');
  assert.deepEqual(
    ran.map((r) => [r.name, r.ok]),
    [
      ['slow', true],
      ['fast', true],
    ],
  );

  const boom = buildRegistry('postMerge', [
    {
      where: 'p',
      entries: [
        {
          name: 'boom',
          order: 1,
          run: async () => {
            throw new Error('deploy 500');
          },
        },
      ],
    },
  ]);
  await assert.rejects(() => runStepRegistry(boom, {}), /deploy 500/);
  const caught = await runStepRegistry(boom, {}, { bestEffort: true });
  assert.equal(caught[0].ok, false);
  assert.match(String(caught[0].error?.message), /deploy 500/);
});

test('bestEffort also catches a throw from applies(), not just from run()', async () => {
  // Finding 097b26: applies() ran outside the try, so a throwing predicate killed the whole
  // close-out sweep the bestEffort contract exists to protect.
  const ran = [];
  const steps = buildRegistry('closeOutExtras', [
    {
      where: 'p',
      entries: [
        {
          name: 'bad-predicate',
          order: 1,
          applies: () => {
            throw new Error('applies blew up');
          },
          run: () => ran.push('bad'),
        },
        { name: 'after', order: 2, run: () => ran.push('after') },
      ],
    },
  ]);
  const out = await runStepRegistry(steps, {}, { bestEffort: true });
  assert.equal(out[0].ok, false);
  assert.match(String(out[0].error?.message), /applies blew up/);
  assert.deepEqual(ran, ['after'], 'a throwing predicate must not stop the later extras');
  // without bestEffort it still propagates
  await assert.rejects(() => runStepRegistry(steps, {}), /applies blew up/);
});

test('selectPrepGates REFUSES an unknown stage instead of silently selecting nothing', () => {
  // Finding 2212df: a typo'd stage at a spine call site returned [] — i.e. every gate silently
  // skipped, which is the exact failure mode this module's header calls the one with no symptom.
  const gates = buildRegistry('prepGates', [
    {
      where: 'core',
      entries: [
        {
          name: 'build',
          order: 1,
          run: () => ({ ok: true }),
          lifecycle: 'custom',
          step: () => {},
        },
      ],
    },
  ]);
  assert.throws(
    () => selectPrepGates(gates, [], {}, { stage: 'preFlight' }),
    /selectPrepGates: unknown stage "preFlight"/,
  );
  assert.throws(() => selectPrepGates(gates, [], {}, { stage: '' }), /unknown stage/);
  // null/omitted still means "every stage"
  assert.equal(selectPrepGates(gates, [], {}, { stage: null }).length, 1);
  assert.equal(selectPrepGates(gates, [], {}).length, 1);
});

test('a source missing its `entries` key is refused, not read as empty', () => {
  // Finding a572d8: `source?.entries ?? []` meant a typo'd key ({ where, gates: [...] }) silently
  // registered nothing.
  assert.throws(
    () => buildRegistry('prepGates', [{ where: 'p.mjs' }]),
    /source p\.mjs has no "entries"/,
  );
  assert.throws(() => buildRegistry('prepGates', [null]), /has no "entries"/);
  // an explicitly EMPTY array stays legal — that is a real "this module registers nothing"
  assert.deepEqual(buildRegistry('prepGates', [{ where: 'p.mjs', entries: [] }]), []);
});

test('EXTENSION_POINTS lists landSeams BEFORE prepGates — the order the spine runs them', () => {
  // Finding 2040f1: the roster claimed to be "the order the spine consults them" while listing
  // prepGates first. Since plan 3499 every seam (2.5, 2.55, 2.67, 2.672, 2.68) runs BEFORE every
  // preflight gate (2.59, 2.6, 2.66, 2.661, 2.662), so the claim was backwards.
  const i = (p) => EXTENSION_POINTS.indexOf(p);
  assert.ok(i('contextExtras') < i('landSeams'), 'context is computed before the seams read it');
  assert.ok(i('landSeams') < i('prepGates'), 'cheap paperwork seams run before the slow gates');
  assert.ok(i('prepGates') < i('postMerge'));
  assert.ok(i('postMerge') < i('closeOutExtras'));
});

// ── review round 2 fixes ──────────────────────────────────────────────────────────────────────

test('an async applies() is REFUSED everywhere — a Promise predicate is always truthy', async () => {
  // Round 2 (cc6ae9/aa3f53/8dfd76/fbf2e7): round 1 refused a thenable from check()/run() but left
  // applies() alone, and `!somePromise` is always false — so an async predicate silently made its
  // gate/extra/step ALWAYS apply. applies() is synchronous everywhere, by contract.
  const gates = buildRegistry('prepGates', [
    {
      where: 'p.mjs',
      entries: [
        {
          name: 'g',
          order: 1,
          applies: async () => false,
          run: () => ({ ok: true }),
          lifecycle: 'custom',
          step: () => {},
        },
      ],
    },
  ]);
  assert.throws(() => selectPrepGates(gates, [], {}), /applies\(\)[\s\S]*returned a Promise/);

  const extras = buildRegistry('contextExtras', [
    {
      where: 'p.mjs',
      entries: [{ name: 'x', order: 1, applies: async () => false, run: () => ({ a: 1 }) }],
    },
  ]);
  assert.throws(() => runContextExtras(extras, {}, []), /applies\(\)[\s\S]*returned a Promise/);

  const steps = buildRegistry('postMerge', [
    {
      where: 'p.mjs',
      entries: [{ name: 's', order: 1, applies: async () => false, run: () => {} }],
    },
  ]);
  await assert.rejects(() => runStepRegistry(steps, {}), /applies\(\)[\s\S]*returned a Promise/);
});

test('refusing a thenable does not leave it as an UNHANDLED rejection', async () => {
  // Round 2 (e2348b/d4b985): throwing on a thenable abandoned the promise. A rejecting one then
  // surfaced as an unhandled rejection — which on the land spine is a process-level crash
  // attributed to the wrong place, long after the useful error was thrown.
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const seams = buildRegistry('landSeams', [
      {
        where: 'p.mjs',
        entries: [{ name: 's', order: 1, check: () => Promise.reject(new Error('boom')) }],
      },
    ]);
    assert.throws(() => runLandSeams(seams, {}), /returned a Promise/);
    // DETERMINISTIC drain, not a wall-clock sleep (review round 3, findings c44608/17fc16, and
    // CLAUDE.md's ambient-LOAD-STATE rule: assert event order, never a timer a loaded box can
    // outrun). Node emits unhandledRejection after the microtask queue drains at the end of a
    // tick, so two setImmediate turns — the check phase, strictly after that point, twice — is
    // the ordering guarantee a 50 ms timer only approximated.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, [], 'the refused promise must be marked handled');
    // A CUSTOM thenable whose then() itself hands back a rejected promise: round 2's fix attached
    // handlers to the original but discarded what .then() returned, so it could manufacture the
    // very unhandled rejection it was closing (round 3, finding 8faf63).
    const nasty = { then: () => Promise.reject(new Error('secondary')) };
    const seams2 = buildRegistry('landSeams', [
      { where: 'p.mjs', entries: [{ name: 's', order: 1, check: () => nasty }] },
    ]);
    assert.throws(() => runLandSeams(seams2, {}), /returned a Promise/);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, [], 'the promise .then() returned must be handled too');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// ── T2.10 closing sweep: the core carries no project-specific noun in its COMMENTS ──────────────
//
// plan 3961's whole point is that scripts/coord/land/** stays generic — a project's mobile /
// per-file-test / price-trust / market-copy gates register through coord.config.json plugins, and
// this directory never names them. That discipline is easy to lose one comment at a time (a
// worked example creeping back in to explain "why", a copy-pasted paragraph from the plan body),
// so this pins it: every non-test `.mjs` file directly under this directory (never `__golden__/`,
// which is data, and never `*.test.mjs`, which legitimately exercises project-shaped fixtures) is
// scanned for the word list below, and only the COMMENT portion of each line counts.
//
// Deliberately COMMENTS ONLY, not the whole file: a project-specific literal appearing in CODE —
// e.g. chunk-gate.mjs's `nonConvergentReportDetail`, which still branches on a literal gate name
// to pick its remedy string — is a genuine coupling this pure module should not have, but carving
// it out is T3's job (it needs an injected remedy-string parameter, not a comment edit), so this
// test does not fail on it. It is tracked as a known finding instead of silently waived: grep this
// directory's non-test `.mjs` files for the word list to see it.
//
// The comment/code split uses a small, deliberately approximate scanner (line-comments after
// `//`, block comments between `/*` and `*/`) — good enough for this codebase's own comment style
// (no `//` or `/*` sequences inside string literals in these files today) without pulling in a
// real parser for a lint-shaped test.
function commentPortionsOf(text) {
  const lines = text.split('\n');
  const portions = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let commentText = '';
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) {
        commentText = line;
      } else {
        commentText = line.slice(0, end);
        inBlock = false;
      }
    } else {
      const blockStart = line.indexOf('/*');
      const lineStart = line.indexOf('//');
      if (blockStart !== -1 && (lineStart === -1 || blockStart < lineStart)) {
        const end = line.indexOf('*/', blockStart + 2);
        if (end === -1) {
          commentText = line.slice(blockStart);
          inBlock = true;
        } else {
          commentText = line.slice(blockStart, end);
        }
      } else if (lineStart !== -1) {
        commentText = line.slice(lineStart);
      }
    }
    portions.push({ lineNo: i + 1, commentText });
  }
  return portions;
}

const LAND_CORE_DIR = dirname(fileURLToPath(import.meta.url));
// plan 3961 review fix (FIX 4a): the plan's OWN acceptance criterion names ten words —
// clinic, seed, price, railway, render, wiki, market, akut, pytest, mobile — four of which // project-word-ok: describes the real word list below, not a leak
// (price, market, akut, mobile) were missing here. `vetapp`, `backend/`, `frontend/`, and
// `omnibus` are additional words this test has always scanned for beyond that list; they stay.
const PROJECT_NOUN_WORDS = [
  'vetapp',
  'clinic', // project-word-ok: this is the pre-existing land-core project-noun gate's OWN word list, not a leak
  'wiki',
  'backend/',
  'frontend/',
  'render',
  'railway',
  'pytest',
  'omnibus',
  'seed',
  'price',
  'market',
  'akut',
  'mobile',
];

test('scripts/coord/land/*.mjs comments name no project-specific noun (plan 3961 T2.10)', () => {
  const pattern = new RegExp(PROJECT_NOUN_WORDS.join('|'), 'i');
  const files = readdirSync(LAND_CORE_DIR)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .sort();
  assert.ok(files.length > 0, 'expected at least one non-test .mjs file to scan');
  const hits = [];
  for (const file of files) {
    const text = readFileSync(join(LAND_CORE_DIR, file), 'utf8');
    const portions = commentPortionsOf(text);
    const nextCommentText = new Map(
      portions.map((p, i) => [
        p.lineNo,
        portions[i + 1]?.lineNo === p.lineNo + 1 ? portions[i + 1].commentText : '',
      ]),
    );
    for (const { lineNo, commentText } of portions) {
      if (!commentText || !pattern.test(commentText)) continue;
      // A core comment may still have to NAME a foreign identifier or file whose own spelling
      // contains a listed word (drain-run.mjs's renderCarryForwardPlanBody is the standing case).
      // Rewording is the default answer; where the name IS the information, the line — or the one
      // right after it — carries `core-noun-ok: <reason>`, and the reason is mandatory so a
      // waiver always says why it is not simply a leak.
      const waiver = (commentText + ' ' + (nextCommentText.get(lineNo) || '')).match(
        /core-noun-ok:\s*(\S[^\n]*)/,
      );
      if (waiver) {
        assert.ok(
          waiver[1].trim().length >= 10,
          `${file}:${lineNo}: a core-noun-ok waiver must carry a reason, not a bare marker`,
        );
        continue;
      }
      hits.push(`${file}:${lineNo}: ${commentText.trim()}`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    `a project-specific noun leaked into a scripts/coord/land core comment:\n${hits.join('\n')}\n` +
      `(word list: ${PROJECT_NOUN_WORDS.join(', ')} — reword the comment; a CODE-level hit is a ` +
      `separate, already-tracked T3 finding, not this test's job)`,
  );
});

// ── T4 unbound-identifier gate: the class the token-stream carve proof cannot see ──────────────
//
// The carve proof (a token-stream identity check: acorn bounds each moved function, the
// mechanical rewrites are reversed, the two streams compared) proves no UNINTENDED edit landed —
// it cannot prove an INTENDED rewrite WAS made. A forgotten container prefix or a missing sibling
// import leaves the original bare identifier in place, which is token-identical to the source by
// definition and therefore invisible to that check. The final carve drew blood on exactly this:
// two runtime ReferenceErrors on the land path that no test reached (a bare
// `graftedForeignCommits(` that needed `D.landLib.`, and a bare `originMasterTip` that needed a
// sibling import). This test closes the hole: every non-test `.mjs` directly under this directory
// is parsed and checked for an identifier it REFERENCES but never declares, imports, or gets from
// a JS/Node global — a forgotten rewrite of this shape always leaves exactly one of those behind.
//
// This gate needs a real JS parser, and acorn is not a declared dependency of this repo. Two
// routes, tried in order, and the order is the point: `acorn` BY NAME first, so a checkout that
// declares it (this repo once it does, or another project adopting this directory as a generic
// coord kit) resolves it directly and owns its own version; then, only as a fallback, the edge
// this repo actually has today — frontend -> eslint -> espree -> acorn, no hardcoded store path
// and no version pinned here.
//
// Resolved lazily INSIDE the test, never at module load. At module scope a broken link would be
// a top-level throw that takes this WHOLE file down, including the no-project-noun gate above —
// which is one of plan 3961's acceptance criteria. A parser this gate cannot find must fail this
// gate alone, and say what to install.
//
// The fallback edge is the reason to keep this honest: a core module's test reaching through
// `frontend/` is exactly the coupling this plan exists to remove, so it is a stopgap, not the
// design. Declaring acorn at the root retires the fallback and the whole comment with it.
async function loadAcorn() {
  const here = createRequire(import.meta.url);
  const fromAcornPkg = (req) => {
    const pkg = req.resolve('acorn/package.json');
    return import(pathToFileURL(join(dirname(pkg), 'dist/acorn.mjs')).href);
  };
  try {
    return await fromAcornPkg(here);
  } catch {
    /* not declared here; fall through to the edge this repo has today */
  }
  try {
    const frontend = createRequire(new URL('../../../frontend/package.json', import.meta.url));
    const eslint = createRequire(frontend.resolve('eslint/package.json'));
    const espree = createRequire(eslint.resolve('espree/package.json'));
    return await fromAcornPkg(espree);
  } catch (e) {
    throw new Error(
      'this gate needs a JS parser and could not resolve acorn — neither by name from this ' +
        'directory nor through frontend -> eslint -> espree. Install it (`pnpm add -Dw acorn`) ' +
        `or run the workspace install first. Underlying error: ${e?.message || e}`,
    );
  }
}

// Node/JS globals the core modules may reference without a local binding. Kept short and
// explicit rather than pulling in a full environment-globals package: a name missing from this
// list fails LOUD, naming the file and the identifier, which is the point of the gate.
const UNBOUND_GLOBALS = new Set([
  'console',
  'process',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Math',
  'JSON',
  'Date',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'Promise',
  'Set',
  'Map',
  'WeakMap',
  'WeakSet',
  'RegExp',
  'Symbol',
  'BigInt',
  'globalThis',
  'undefined',
  'NaN',
  'Infinity',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'Buffer',
  'URL',
  'URLSearchParams',
  'structuredClone',
  'AbortController',
  'AbortSignal',
  'TextEncoder',
  'TextDecoder',
  'queueMicrotask',
  'Intl',
  'arguments',
  'isNaN',
  'parseInt',
  'parseFloat',
  'encodeURIComponent',
  'decodeURIComponent',
  'Function',
  'Proxy',
  'Reflect',
  'performance',
  'fetch',
]);

// Binds the identifier(s) a destructuring/parameter PATTERN introduces (ObjectPattern,
// ArrayPattern, AssignmentPattern default, RestElement) into `declared`.
function bindPattern(node, declared) {
  if (!node) return;
  if (node.type === 'Identifier') declared.add(node.name);
  else if (node.type === 'ObjectPattern') {
    for (const p of node.properties) {
      bindPattern(p.type === 'RestElement' ? p.argument : p.value, declared);
    }
  } else if (node.type === 'ArrayPattern') {
    for (const el of node.elements) bindPattern(el, declared);
  } else if (node.type === 'AssignmentPattern') bindPattern(node.left, declared);
  else if (node.type === 'RestElement') bindPattern(node.argument, declared);
}

// Walks the AST collecting every declared name (`declared`) and every referenced name (`used`).
// `import.meta` parses as a MetaProperty node whose own `meta`/`property` children are plain
// Identifiers ("import", "meta") — skipped outright so a core module's own
// `import.meta.dirname` never reads as an unbound reference to `import` or `meta`.
function collectIdentifiers(node, parent, declared, used) {
  if (!node || typeof node.type !== 'string') return;
  switch (node.type) {
    case 'MetaProperty':
      return;
    case 'VariableDeclarator':
      bindPattern(node.id, declared);
      break;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      if (node.id) declared.add(node.id.name);
      for (const p of node.params || []) bindPattern(p, declared);
      break;
    case 'ClassDeclaration':
    case 'ClassExpression':
      if (node.id) declared.add(node.id.name);
      break;
    case 'ImportDeclaration':
      for (const s of node.specifiers) declared.add(s.local.name);
      return;
    case 'CatchClause':
      bindPattern(node.param, declared);
      break;
    case 'Identifier': {
      if (parent) {
        if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
          return;
        if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
        if (parent.type === 'PropertyDefinition' && parent.key === node && !parent.computed) return;
        if (parent.type === 'MethodDefinition' && parent.key === node) return;
        if (parent.type === 'ExportSpecifier') return;
        if (
          parent.type === 'LabeledStatement' ||
          parent.type === 'BreakStatement' ||
          parent.type === 'ContinueStatement'
        ) {
          return;
        }
      }
      used.add(node.name);
      return;
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) collectIdentifiers(child, node, declared, used);
    } else if (value && typeof value.type === 'string') {
      collectIdentifiers(value, node, declared, used);
    }
  }
}

function unboundIdentifiersIn(acorn, sourceText) {
  const ast = acorn.parse(sourceText, { ecmaVersion: 'latest', sourceType: 'module' });
  const declared = new Set();
  const used = new Set();
  collectIdentifiers(ast, null, declared, used);
  return [...used].filter((name) => !declared.has(name) && !UNBOUND_GLOBALS.has(name)).sort();
}

test('every core land module references no identifier it never declares, imports, or gets from a global (plan 3961 T4)', async () => {
  const acorn = await loadAcorn();
  const files = readdirSync(LAND_CORE_DIR)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .sort();
  assert.ok(files.length > 0, 'expected at least one non-test .mjs file to scan');
  const findings = [];
  for (const file of files) {
    const unbound = unboundIdentifiersIn(acorn, readFileSync(join(LAND_CORE_DIR, file), 'utf8'));
    if (unbound.length > 0) findings.push(`${file}: ${unbound.join(', ')}`);
  }
  assert.deepEqual(
    findings,
    [],
    `an identifier is referenced but never bound — the class a token-stream carve check cannot ` +
      `see (a forgotten container prefix or sibling import leaves the original bare name, which ` +
      `is token-identical to the source):\n${findings.join('\n')}`,
  );
});

// ── plan 4056: the three optional landSeams fields the seam fold added ─────────────────────────
//
// A seam declaring none of them is run exactly as before — asserted first, because "the fold is
// opt-in" is the property that makes every unmigrated seam safe. The rest pin the validation:
// each field's own silent-failure mode is what makes a typo worth an error here rather than a
// seam that quietly never applies, never resumes, or renders no rework label.

test('plan 4056: a landSeams entry declaring none of the new fields still normalizes, unchanged', () => {
  const built = normalizeEntry('landSeams', { name: 's', order: 1, check: () => ({}) }, 'w');
  assert.equal(built.name, 's');
  assert.equal(built.applies, undefined);
  assert.equal(built.seamCode, undefined);
  assert.equal(built.markerFamily, undefined);
});

test('plan 4056: a landSeams entry carrying all three new fields normalizes and keeps them verbatim', () => {
  const lookup = () => 'FOUND';
  const applies = () => true;
  const built = normalizeEntry(
    'landSeams',
    {
      name: 's',
      order: 1,
      check: () => ({}),
      applies,
      seamCode: 'SOME_CODE',
      markerFamily: { key: 'fam', lookup, recorder: 'record-fam.mjs' },
    },
    'w',
  );
  assert.equal(built.applies, applies);
  assert.equal(built.seamCode, 'SOME_CODE');
  assert.deepEqual(built.markerFamily, { key: 'fam', lookup, recorder: 'record-fam.mjs' });
});

test('plan 4056: a non-function landSeams applies() is refused — the async/typo hole every other point already closes', () => {
  assert.throws(
    () =>
      normalizeEntry('landSeams', { name: 's', order: 1, check: () => ({}), applies: true }, 'w'),
    /has a non-function "applies"/,
  );
});

test('plan 4056: a non-string or empty seamCode is refused — a resume valve that can never match is a seam with none', () => {
  for (const bad of [42, '', '   ', null, {}]) {
    assert.throws(
      () =>
        normalizeEntry('landSeams', { name: 's', order: 1, check: () => ({}), seamCode: bad }, 'w'),
      /has a non-string "seamCode"/,
      `seamCode: ${JSON.stringify(bad)}`,
    );
  }
});

test('plan 4056: markerFamily is validated for SHAPE — object, known keys, two strings and a lookup function', () => {
  const entry = (markerFamily) => ({ name: 's', order: 1, check: () => ({}), markerFamily });
  const good = { key: 'fam', lookup: () => null, recorder: 'record-fam.mjs' };

  for (const bad of [42, 'fam', [], null]) {
    assert.throws(
      () => normalizeEntry('landSeams', entry(bad), 'w'),
      /has a non-object "markerFamily"/,
      `markerFamily: ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(
    () => normalizeEntry('landSeams', entry({ ...good, familyKey: 'oops' }), 'w'),
    /unknown markerFamily key\(s\) familyKey/,
    'a typo’d sub-key is an error, not a field silently missing',
  );
  for (const strKey of ['key', 'recorder']) {
    for (const bad of [undefined, '', 7]) {
      assert.throws(
        () => normalizeEntry('landSeams', entry({ ...good, [strKey]: bad }), 'w'),
        new RegExp(`needs a non-empty string markerFamily\\.${strKey}`),
        `${strKey}: ${JSON.stringify(bad)}`,
      );
    }
  }
  assert.throws(
    () => normalizeEntry('landSeams', entry({ ...good, lookup: 'nope' }), 'w'),
    /must define markerFamily\.lookup\(\) as a function/,
  );
});

test('plan 4056: membership of markerFamily.key is NOT the registry’s check — it stays import-free', () => {
  // A key naming no real family normalizes fine here, on purpose: this module may not import the
  // family table (Rule 3). The driver owns that half, and its own test pins the refusal — so this
  // case exists to stop someone "fixing" the gap in the wrong layer by adding an import.
  const built = normalizeEntry(
    'landSeams',
    {
      name: 's',
      order: 1,
      check: () => ({}),
      markerFamily: { key: 'no-such-family', lookup: () => null, recorder: 'r.mjs' },
    },
    'w',
  );
  assert.equal(built.markerFamily.key, 'no-such-family');
});

test('plan 4056: optionalEntryKeys("landSeams") reports the three fields, so a relay derives its allowlist instead of copying one', () => {
  assert.deepEqual(optionalEntryKeys('landSeams').sort(), ['applies', 'markerFamily', 'seamCode']);
});

// ── plan 4056 (the gate fold): `lifecycle` + `step`, and why the requirement is STAGE-SCOPED ──
//
// The two fields are what let the preflight driver execute registered entries instead of calling
// five project step functions by name. They are REQUIRED on a preflight-stage prepGate and
// REFUSED at every other stage, and both halves are errors rather than conventions:
//
//   - Missing at preflight: the driver would have nothing to call, so the gate would silently
//     never run — this module's header calls that the failure mode with no symptom.
//   - Present elsewhere: only the preflight driver reads them. A lane-merge gate is driven from
//     the post-rebase step and a deploy-wall gate from the deploy wall's own table, so a `step`
//     declared there is a capability nothing calls — the D-M17 shape ("a declaration nothing
//     checks is not a contract") that plan 4042 deleted two fields for.
//
// The alternative considered and rejected was one contract for all seven registered entries. It
// forces `prettier-drift` and `market-copy` to declare a step their own drivers never read, which
// is dishonest; making it honest means rewiring the deploy wall, which is out of this plan's
// scope. Scoping the requirement and ENFORCING the scope keeps the declaration true everywhere.

const preflightGate = (over = {}) => ({
  name: 'g',
  order: 1,
  run: () => ({ ok: true }),
  lifecycle: 'custom',
  step: () => {},
  ...over,
});

test('plan 4056: a preflight-stage prepGate MUST declare lifecycle and step', () => {
  for (const missing of ['lifecycle', 'step']) {
    const entry = preflightGate();
    delete entry[missing];
    assert.throws(
      () => normalizeEntry('prepGates', entry, 'w'),
      new RegExp(`runs at stage "preflight" and must declare "${missing}"`),
      `a preflight gate with no ${missing} must be an error, not a gate the driver skips`,
    );
  }
  // The default matters as much as the explicit value: `stage` defaults to preflight, so an entry
  // that declares NO stage is subject to the same requirement.
  const noStage = preflightGate();
  delete noStage.lifecycle;
  assert.throws(
    () => normalizeEntry('prepGates', noStage, 'w'),
    /runs at stage "preflight" and must declare "lifecycle"/,
  );
});

test('plan 4056: lifecycle is an ENUM — the driver dispatches off it, so an unknown value is refused', () => {
  assert.deepEqual([...PREP_GATE_LIFECYCLES], ['generic', 'custom']);
  for (const value of ['Generic', 'shared', '', true, null, 0]) {
    assert.throws(
      () => normalizeEntry('prepGates', preflightGate({ lifecycle: value }), 'w'),
      /has lifecycle .* expected one of: generic, custom/,
      `lifecycle ${JSON.stringify(value)} must be refused`,
    );
  }
  for (const value of PREP_GATE_LIFECYCLES) {
    assert.equal(
      normalizeEntry('prepGates', preflightGate({ lifecycle: value }), 'w').lifecycle,
      value,
    );
  }
});

test('plan 4056: step must be a FUNCTION — the driver calls it', () => {
  // Refused by the ordinary optional-key type check (every optional key that is neither a
  // declared boolean/string/enum nor one of the shaped objects must be a function), which is why
  // the stage-scoped block below it checks only presence: a name spelled as a string would
  // otherwise register a gate whose step the driver cannot call.
  assert.throws(
    () => normalizeEntry('prepGates', preflightGate({ step: 'runTheGate' }), 'w'),
    /has a non-function "step"/,
  );
});

test('plan 4056: a NON-preflight prepGate must declare NEITHER — nothing there would ever call one', () => {
  for (const stage of ['lane-merge', 'deploy-wall']) {
    // Both together, and each alone: a half-declaration is the same defect.
    assert.throws(
      () => normalizeEntry('prepGates', preflightGate({ stage }), 'w'),
      new RegExp(`runs at stage "${stage}" and must NOT declare lifecycle/step`),
    );
    const onlyStep = preflightGate({ stage });
    delete onlyStep.lifecycle;
    assert.throws(
      () => normalizeEntry('prepGates', onlyStep, 'w'),
      new RegExp(`runs at stage "${stage}" and must NOT declare step`),
    );
    // …and the bare entry at that stage is FINE, which is what keeps prettier-drift/market-copy
    // registrable exactly as they are today.
    const bare = { name: 'g', order: 1, stage, run: () => ({ ok: true }) };
    assert.equal(normalizeEntry('prepGates', bare, 'w').stage, stage);
  }
});

test('plan 4056: the requirement is prepGates-only — no other extension point grows a step', () => {
  // A landSeam/contextExtra/postMerge entry is unaffected, and spelling `step` at one of them is
  // still the ordinary unknown-key error rather than this plan's stage message.
  assert.equal(
    normalizeEntry('landSeams', { name: 's', order: 1, check: () => ({}) }, 'w').name,
    's',
  );
  assert.throws(
    () => normalizeEntry('postMerge', { name: 'p', order: 1, run: () => {}, step: () => {} }, 'w'),
    /has unknown key\(s\) step/,
  );
});

test('plan 4056: optionalEntryKeys("prepGates") reports both new fields, so a relay derives them instead of copying a list', () => {
  // gates-core.mjs builds its `RELAYABLE_FIELDS` allowlist FROM this call — a field added here and
  // forgotten there would be silently dropped off every core-registered entry, which is exactly
  // what happened to the seam fold's three fields on `coreSeams` before it gained the same relay.
  const keys = optionalEntryKeys('prepGates');
  assert.ok(keys.includes('lifecycle'), 'lifecycle must be relayable to a core-registered entry');
  assert.ok(keys.includes('step'), 'step must be relayable to a core-registered entry');
});
