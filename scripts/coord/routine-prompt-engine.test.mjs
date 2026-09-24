// scripts/coord/routine-prompt-engine.test.mjs (plan 3964 T2)
//
// Unit tests for the GENERIC half of the cloud-routine-prompt split: axis validation, the
// axis-gloss list grammar, the ruling-banner grammar, the attribution-report paragraph
// grammar, and the section-assembly/ordering algorithm itself, all driven against small
// synthetic RoutineSpec objects rather than vetapp content — the vetapp CONTENT-contract
// tests (every rendered word the 6 committed bodies must carry) live in
// scripts/project/cloud-routine-specs.test.mjs, since they assert on this module's OUTPUT
// composed with the vetapp spec, not on anything generic this module itself owns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAxes,
  axisListWithGlosses,
  rulingBanner,
  attributionReportParagraph,
  renderRoutinePrompt,
} from './routine-prompt-engine.mjs';

const LANES = ['alpha', 'beta'];
const ENVS = ['low', 'high'];
const CANONICAL = [
  { lane: 'alpha', env: 'low' },
  { lane: 'alpha', env: 'high' },
  { lane: 'beta', env: 'low' },
  // Deliberately no (beta, high) row — mirrors the real module's (fable, browser) gap
  // between plans 3754 and 3823: assertAxes must refuse a pair with no canonical row even
  // when both axis values are independently valid.
];

test('assertAxes: accepts every (lane, env) pair CANONICAL carries', () => {
  assert.doesNotThrow(() =>
    assertAxes('alpha', 'low', { lanes: LANES, envs: ENVS, canonical: CANONICAL }),
  );
  assert.doesNotThrow(() =>
    assertAxes('beta', 'low', { lanes: LANES, envs: ENVS, canonical: CANONICAL }),
  );
});

test('assertAxes: throws on an unknown lane, unknown env, or a valid-axes-but-uncanonical pair', () => {
  const spec = { lanes: LANES, envs: ENVS, canonical: CANONICAL };
  assert.throws(() => assertAxes('gamma', 'low', spec), /unknown lane/);
  assert.throws(() => assertAxes('alpha', 'medium', spec), /unknown env/);
  // Both axis values are individually valid, but no CANONICAL row pairs them — this is the
  // pair-level guard plan 3754's land review found missing from an independent-axis check.
  assert.throws(() => assertAxes('beta', 'high', spec), /unsupported \(lane, env\) pair/);
});

test('axisListWithGlosses: renders a two-item list with "or", not a comma', () => {
  assert.equal(
    axisListWithGlosses(['a', 'b'], { a: 'alpha', b: 'beta' }),
    'a (alpha), or b (beta)',
  );
});

test('axisListWithGlosses: renders a three-item list with an Oxford-comma "or"', () => {
  assert.equal(
    axisListWithGlosses(['a', 'b', 'c'], { a: 'alpha', b: 'beta', c: 'gamma' }),
    'a (alpha), b (beta), or c (gamma)',
  );
});

test('axisListWithGlosses: a single tag renders with no trailing connector', () => {
  assert.equal(axisListWithGlosses(['a'], { a: 'alpha' }), 'a (alpha)');
});

test('axisListWithGlosses: throws loudly on a tag with no gloss entry, rather than rendering a bare tag', () => {
  assert.throws(
    () => axisListWithGlosses(['a', 'z'], { a: 'alpha' }),
    /no gloss entry for axis "z"/,
  );
});

test('rulingBanner: concatenates the marker and the explanation with a single space', () => {
  assert.equal(
    rulingBanner('**MARKER**', 'Explanation follows.'),
    '**MARKER** Explanation follows.',
  );
});

test('attributionReportParagraph: composes the sentence shape from spec-owned fields only', () => {
  const p = attributionReportParagraph({
    planRef: 'plan 1',
    fieldsList: '`FOO` and `BAR`',
    identifiersLabel: 'both identifiers',
    writeCondition: 'X happens',
    writeTool: 'tool.mjs',
    excludedField: 'BAZ',
    excludedReason: 'privacy',
  });
  assert.equal(
    p,
    'Record drain attribution (plan 1): report the literal `FOO` and `BAR` values in the final ' +
      'summary. Whenever you take X happens, also write both identifiers into the plan-body ' +
      'handoff section via `tool.mjs`. Do NOT record `BAZ`; privacy.',
  );
});

// A minimal synthetic RoutineSpec — every section is a short, uniquely-named marker string so
// the assembly order can be read directly off the rendered output, without depending on any
// vetapp content. Mirrors the real spec's field names one-for-one (see
// scripts/project/cloud-routine-specs.mjs's `renderPrompt`).
function fakeSpec({ lane, env }) {
  return {
    lane,
    env,
    lanes: LANES,
    envs: ENVS,
    canonical: CANONICAL,
    primaryLane: 'alpha',
    isFullEgress: (e) => e === 'high',
    opening: () => 'OPENING',
    fullEgressBlock: () => 'FULL-EGRESS',
    gitCredentialSetup: () => 'GIT-CRED',
    extraReposBlock: () => 'EXTRA-REPOS',
    checkoutPreflightBlock: () => 'CHECKOUT-PREFLIGHT',
    diskHeadroomPruneBlock: () => 'DISK-HEADROOM',
    usageGate: () => 'USAGE-GATE',
    claimDriftReportBlock: () => 'CLAIM-DRIFT',
    earlyExit: () => 'EARLY-EXIT',
    contract: () => 'CONTRACT',
    claimWorktree: () => 'CLAIM-WORKTREE',
    primaryBatchBlock: () => 'PRIMARY-BATCH',
    primaryOrchestratorBlock: () => 'PRIMARY-ORCHESTRATOR',
    secondaryOrchestratorBlock: () => 'SECONDARY-ORCHESTRATOR',
    secondaryBatchBlock: () => 'SECONDARY-BATCH',
    solLaneBlock: () => 'SOL-LANE',
    execute: () => 'EXECUTE',
    reviewBlock: () => 'REVIEW',
    landBlock: () => 'LAND',
    landFailureLoop: () => 'LAND-FAILURE-LOOP',
    escapeHatch: () => 'ESCAPE-HATCH',
    hardLimits: () => 'HARD-LIMITS',
    finalSummary: () => 'FINAL-SUMMARY',
  };
}

test('renderRoutinePrompt: the primary lane orders claim+worktree/batch/orchestrator before Execute, with no secondary-orchestrator section', () => {
  const body = renderRoutinePrompt(fakeSpec({ lane: 'alpha', env: 'low' }));
  const order = [
    'OPENING',
    'GIT-CRED',
    'EXTRA-REPOS',
    'DISK-HEADROOM',
    'USAGE-GATE',
    'CLAIM-DRIFT',
    'EARLY-EXIT',
    'CONTRACT',
    'CLAIM-WORKTREE',
    'PRIMARY-BATCH',
    'PRIMARY-ORCHESTRATOR',
    'EXECUTE',
    'REVIEW',
    'LAND',
    'LAND-FAILURE-LOOP',
    'ESCAPE-HATCH',
    'HARD-LIMITS',
    'FINAL-SUMMARY',
  ];
  const indices = order.map((marker) => body.indexOf(marker));
  assert.ok(
    indices.every((i) => i !== -1),
    `every primary-lane marker must appear: ${JSON.stringify(order.filter((_, i) => indices[i] === -1))}`,
  );
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i - 1] < indices[i], `${order[i - 1]} must come before ${order[i]}`);
  }
  assert.ok(
    !body.includes('SECONDARY-ORCHESTRATOR'),
    'the primary lane must not carry the secondary orchestrator',
  );
  assert.ok(
    !body.includes('SECONDARY-BATCH'),
    'the primary lane must not carry the secondary batch block',
  );
  // Not full-egress (env: 'low') — none of the full-egress-only sections render.
  assert.ok(!body.includes('FULL-EGRESS'));
  assert.ok(!body.includes('CHECKOUT-PREFLIGHT'));
  assert.ok(!body.includes('SOL-LANE'));
});

test('renderRoutinePrompt: a non-primary lane orders orchestrator doctrine before Execute, then claim+worktree, then its own batch block after Execute', () => {
  const body = renderRoutinePrompt(fakeSpec({ lane: 'beta', env: 'low' }));
  const order = [
    'CONTRACT',
    'SECONDARY-ORCHESTRATOR',
    'EXECUTE',
    'CLAIM-WORKTREE',
    'SECONDARY-BATCH',
    'REVIEW',
  ];
  const indices = order.map((marker) => body.indexOf(marker));
  assert.ok(indices.every((i) => i !== -1));
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i - 1] < indices[i], `${order[i - 1]} must come before ${order[i]}`);
  }
  assert.ok(!body.includes('PRIMARY-BATCH'));
  assert.ok(!body.includes('PRIMARY-ORCHESTRATOR'));
});

test('renderRoutinePrompt: full-egress-family sections (and the Sol lane) render only when isFullEgress(env) is true', () => {
  const full = renderRoutinePrompt(fakeSpec({ lane: 'alpha', env: 'high' }));
  assert.ok(full.includes('FULL-EGRESS'));
  assert.ok(full.includes('CHECKOUT-PREFLIGHT'));
  assert.ok(full.includes('SOL-LANE'));

  const trusted = renderRoutinePrompt(fakeSpec({ lane: 'alpha', env: 'low' }));
  assert.ok(!trusted.includes('FULL-EGRESS'));
  assert.ok(!trusted.includes('CHECKOUT-PREFLIGHT'));
  assert.ok(!trusted.includes('SOL-LANE'));
});

test('renderRoutinePrompt: rejects an unsupported (lane, env) pair before rendering any section', () => {
  const spec = fakeSpec({ lane: 'beta', env: 'high' }); // no CANONICAL row for this pair
  assert.throws(() => renderRoutinePrompt(spec), /unsupported \(lane, env\) pair/);
});

test('renderRoutinePrompt: joins sections with a blank line and ends with exactly one trailing newline', () => {
  const body = renderRoutinePrompt(fakeSpec({ lane: 'alpha', env: 'low' }));
  assert.ok(body.includes('OPENING\n\nGIT-CRED'), 'sections must be double-newline separated');
  assert.ok(
    body.endsWith('FINAL-SUMMARY\n'),
    'the body must end with exactly one trailing newline',
  );
  assert.ok(
    !body.endsWith('FINAL-SUMMARY\n\n'),
    'the body must not carry a second trailing newline',
  );
});
