// scripts/coord/plan-id-index.test.mjs — moved from scripts/done-worktree-lib.test.mjs
// (plan 3959 T2), alongside buildPlanIdIndex/rowSlugFromIndex.
//
// resolvePlanRelById (imported only for the parity cross-check below) stays in
// done-worktree-lib.mjs — this is a TEST file, so Rule 3 (docs/runbooks/scripts-module-layout.md)
// does not bind it the way it binds the non-test scripts/coord/plan-id-index.mjs itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlanRelById } from './done-worktree-lib.mjs';
import { buildPlanIdIndex, rowSlugFromIndex } from './plan-id-index.mjs';

// ── plan 1364 review R1 (F6): buildPlanIdIndex — the ONE-PASS batching analogue of calling
// ── resolvePlanRelById once per id per side. Results must be byte-identical to composing
// ── resolvePlanRelById(lsFiles, id) / resolvePlanRelById(lsFiles, id, {archived:true}) per id.
test('buildPlanIdIndex: resolves BOTH live and archived paths for every requested id in one pass', () => {
  const ls = [
    'docs/superpowers/plans/in-progress/1362-DQ-a.md',
    'docs/superpowers/plans/archive/1365-Infra-b.md',
    'docs/superpowers/plans/ready/400-X-y.md', // not requested — must not pollute the index
  ].join('\n');
  const index = buildPlanIdIndex(ls, ['1362', '1365', '999']);
  assert.deepEqual(index.get('1362'), {
    live: 'docs/superpowers/plans/in-progress/1362-DQ-a.md',
    archived: null,
  });
  assert.deepEqual(index.get('1365'), {
    live: null,
    archived: 'docs/superpowers/plans/archive/1365-Infra-b.md',
  });
  assert.deepEqual(index.get('999'), { live: null, archived: null }, 'absent id → both null');
  assert.equal(index.has('400'), false, 'a non-requested id never enters the index');
});

test('buildPlanIdIndex: matches resolvePlanRelById exactly — case-mismatched slug, id-boundary, 1811-vs-811', () => {
  const ls = [
    'docs/superpowers/plans/_dashboard.base',
    'docs/superpowers/plans/in-progress/811-Price-surface-comparable-price-categories-prislista.md',
    'docs/superpowers/plans/ready/400-X-y.md',
    'docs/superpowers/plans/in-progress/1811-X-other.md',
  ].join('\n');
  const index = buildPlanIdIndex(ls, ['811', '1811']);
  assert.equal(
    index.get('811').live,
    resolvePlanRelById(ls, '811'),
    'parity with the per-id resolvePlanRelById call',
  );
  assert.equal(
    index.get('1811').live,
    resolvePlanRelById(ls, '1811'),
    'the 1811 sibling never collides with the 811 lookup',
  );
});

test('buildPlanIdIndex: empty ids list → an empty (but non-throwing) Map', () => {
  const index = buildPlanIdIndex('docs/superpowers/plans/ready/1-A-x.md', []);
  assert.equal(index.size, 0);
});

test('buildPlanIdIndex: empty/undefined lsFiles → every requested id resolves to {live:null, archived:null}', () => {
  assert.deepEqual(buildPlanIdIndex('', ['1']).get('1'), { live: null, archived: null });
  assert.deepEqual(buildPlanIdIndex(undefined, ['1']).get('1'), { live: null, archived: null });
});

// plan 1454: rowSlugFromIndex recovers a member board slug (basename, live else archive).
test('rowSlugFromIndex: basename, preferring live over archived, null when unresolved', () => {
  const ls = [
    'docs/superpowers/plans/in-progress/1395-DQ-synth-composite-sourceurl.md',
    'docs/superpowers/plans/archive/1396-DQ-dental-completeness.md',
  ].join('\n');
  const idx = buildPlanIdIndex(ls, ['1395', '1396', '9999']);
  assert.equal(rowSlugFromIndex(idx, '1395'), '1395-DQ-synth-composite-sourceurl');
  assert.equal(rowSlugFromIndex(idx, '1396'), '1396-DQ-dental-completeness'); // archive fallback
  assert.equal(rowSlugFromIndex(idx, '9999'), null); // unresolvable → null
});
