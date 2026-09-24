// scripts/coord/drain-run.test.mjs — unit tests for the drain driver's deterministic
// core (plan 231 Phase 2). Pure functions only; the claude -p spawn + git ops
// are exercised via the dry-run runner in the live smoke, not here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlanPrompt,
  parsePlanResult,
  classifyOutcome,
  pickAccount,
  shouldPauseForCost,
  emptyState,
  nextState,
  shouldHalt,
  makeClaudeRunner,
  buildClaudeArgs,
  dryRunner,
  runDrain,
  blockedHasShippedWork,
  mintableCarryForwards,
  classifyCarryForwardKinds,
  carryForwardSlug,
  renderCarryForwardPlanBody,
  recordFiledCarryForwards,
  recordSkipped,
  repathPlanClaimCell,
  repathBoardRow,
  buildClaimPlanCell,
  verifyBoardRowLintClean,
  writeClaimBoardRow,
  spawnGateOpen,
  recordLanded,
  recordLandParked,
  classifySpineExit,
  buildContinuationPrompt,
  retryOnForeignDirt,
  isBoardLintRefusal,
  stampClaimInProgress,
  orderedPlanMove,
  selectNextCandidate,
  claimCarryForwardId,
  DEFAULT_CEILING_USD,
  MAX_QUARANTINES,
  PAUSE_COST_THRESHOLD_USD,
  readOperatorSpendCeilingUsd,
  classifyPlanSpend,
  // plan 4069 fix round 1 (finding F): the carry-forward stub's --blocked-by text, extracted so
  // the fix can be tested directly against move-plan.mjs's real gate.
  carryForwardBlockedByText,
  // review round 2 (R2-1): the frontmatter-safe Blocked-by insertion fallback, exported for a
  // direct unit test.
  insertBlockedByLine,
} from './drain-run.mjs';
import { parsePlanMeta } from './queue-drain.mjs';
// plan 4069 fix round 1 (finding F): the real waiting-operator/ entry gate carryForwardBlockedByText
// must pass — a hand-copied regex here could silently disagree with the actual gate.
import { assertBlockedByAxisTagOk } from './move-plan.mjs';
import { validateRows } from './lint-board.mjs';
import { ALL_PLAN_FOLDERS, MUTATION_BANNER_LABEL } from './build-index-lib.mjs';

// plan 3958: MUTATION_BANNER_LABEL self-resolves to 'SEED-WRITE' in vetapp's real checkout and
// the public coord-kit's neutral 'DATA-WRITE' default in the built kit — every fixture below that
// a parser/anchor under test actually READS (not a test title or a comment) must use it instead
// of the literal 'SEED-WRITE' text, or it silently stops matching in the kit.
const sw = (s) => s.replaceAll('SEED-WRITE', MUTATION_BANNER_LABEL);
// plan 3960 cluster-2/3 review fixes: a REAL isolated repo (a fresh module graph, same
// precedent as the plan-3960 T3 test) is the only way to prove a coord.config.json VALUE
// actually reaches drain-run.mjs's config-derived constants — this test file's own
// already-imported module is vetapp's own unconfigured instance.
import { spawnSync } from 'node:child_process';
import { isolatedRepoFactory } from '../test-helpers/isolated-plan-repo.mjs';
// plan 3961 T3.1b fix-now: a bare Windows path (e.g. under a non-C: drive scratch/worktree
// root) embedded as an import specifier in a generated probe script throws
// ERR_UNSUPPORTED_ESM_URL_SCHEME — Node parses the drive letter as a URL scheme. This is the
// same ambient-machine-state bug class coord-config.test.mjs's plan-3961 T2.7c fix names;
// `pathToFileURL(...).href` is the fix there and here. Any new probe script written in this
// file should embed a `pathToFileURL(...).href` specifier too, never a raw fs path.
import { pathToFileURL } from 'node:url';

const plan = {
  slug: '203-UI-x',
  path: 'docs/superpowers/plans/ready/203-UI-x.md',
  cost: { usd: 0, unknown: false },
};

// --- buildPlanPrompt ---------------------------------------------------------

test('buildPlanPrompt: workers NEVER land — no phase variant exists (plan 518)', () => {
  const p = buildPlanPrompt(plan);
  assert.match(p, /DO NOT run done-worktree/);
  assert.match(p, /the DRIVER lands it/);
  assert.match(p, /203-UI-x/);
  assert.match(p, /EXACTLY ONE plan/);
  // The old phase-3 conditional auto-land must be gone entirely.
  assert.doesNotMatch(p, /you MAY invoke done-worktree/);
});

test('buildPlanPrompt: instructs the sha-pinned record-review marker after the final commit', () => {
  const p = buildPlanPrompt(plan);
  assert.match(p, /record-review\.mjs <PASS\|NITS\|BUGS-FOUND>/);
  assert.match(p, /AFTER your final commit/);
  assert.match(p, /\/sonnet-review/);
  // plan 1205: a non-PASS verdict must carry + disposition findings, or the driver land halts
  // at FINDINGS_OPEN with no worker left to clear it.
  assert.match(p, /--findings/);
  assert.match(p, /FINDINGS_OPEN/);
});

// --- parsePlanResult ---------------------------------------------------------

test('parsePlanResult: clean JSON', () => {
  const r = parsePlanResult('{"status":"completed","slug":"203-UI-x","shipped_sha":"abc"}');
  assert.equal(r.status, 'completed');
  assert.equal(r.shipped_sha, 'abc');
});

test('parsePlanResult: tolerates code fence + leading prose', () => {
  const r = parsePlanResult(
    'Here is the result:\n```json\n{"status":"gate_failed","slug":"x"}\n```',
  );
  assert.equal(r.status, 'gate_failed');
});

test('parsePlanResult: throws on no JSON', () => {
  assert.throws(() => parsePlanResult('all done, no json here'), /no JSON object/);
});

test('parsePlanResult: throws on missing status', () => {
  assert.throws(() => parsePlanResult('{"slug":"x"}'), /missing status/);
});

test('parsePlanResult: throws on empty', () => {
  assert.throws(() => parsePlanResult(''), /empty worker result/);
});

// --- runner safety gate ------------------------------------------------------

test('makeClaudeRunner: refuses to spawn without explicit allowDangerous opt-in', () => {
  const runner = makeClaudeRunner(); // allowDangerous defaults false
  assert.throws(() => runner(plan, {}), /gated|allow-dangerous|DRAIN_ALLOW_DANGEROUS/);
});

// --- buildClaudeArgs (plan 1427 Gate 3 — point-escalation) -------------------

test('buildClaudeArgs: defaults to --advisor fable', () => {
  const prevAdvisor = process.env.DRAIN_ADVISOR;
  delete process.env.DRAIN_ADVISOR;
  try {
    const args = buildClaudeArgs('do the thing');
    assert.deepEqual(args.slice(-2), ['--advisor', 'fable']);
  } finally {
    if (prevAdvisor === undefined) delete process.env.DRAIN_ADVISOR;
    else process.env.DRAIN_ADVISOR = prevAdvisor;
  }
});

test('buildClaudeArgs: honours a custom DRAIN_ADVISOR model', () => {
  const prevAdvisor = process.env.DRAIN_ADVISOR;
  process.env.DRAIN_ADVISOR = 'opus';
  try {
    const args = buildClaudeArgs('do the thing');
    assert.deepEqual(args.slice(-2), ['--advisor', 'opus']);
  } finally {
    if (prevAdvisor === undefined) delete process.env.DRAIN_ADVISOR;
    else process.env.DRAIN_ADVISOR = prevAdvisor;
  }
});

test('buildClaudeArgs: an explicitly EMPTY DRAIN_ADVISOR disables the flag entirely', () => {
  const prevAdvisor = process.env.DRAIN_ADVISOR;
  process.env.DRAIN_ADVISOR = '';
  try {
    const args = buildClaudeArgs('do the thing');
    assert.doesNotMatch(args.join(' '), /--advisor/);
  } finally {
    if (prevAdvisor === undefined) delete process.env.DRAIN_ADVISOR;
    else process.env.DRAIN_ADVISOR = prevAdvisor;
  }
});

test('buildClaudeArgs: extraArgs are appended after the advisor pair', () => {
  const prevAdvisor = process.env.DRAIN_ADVISOR;
  delete process.env.DRAIN_ADVISOR;
  try {
    const args = buildClaudeArgs('do the thing', { extraArgs: ['--foo', 'bar'] });
    assert.deepEqual(args.slice(-4), ['--advisor', 'fable', '--foo', 'bar']);
  } finally {
    if (prevAdvisor === undefined) delete process.env.DRAIN_ADVISOR;
    else process.env.DRAIN_ADVISOR = prevAdvisor;
  }
});

test('dryRunner: no-spend, reports completed without spawning', async () => {
  const r = await dryRunner()(plan, {});
  assert.equal(r.spendUsd, 0);
  assert.equal(r.result.status, 'completed');
  assert.equal(r.result.shipped_sha, 'DRYRUN');
});

test('dryRunner: latencyMs delays resolution but keeps the same shape', async () => {
  const t0 = Date.now();
  const r = await dryRunner({ latencyMs: 5 })(plan, {});
  assert.ok(Date.now() - t0 >= 4); // setTimeout clamps can undershoot by <1ms
  assert.equal(r.spendUsd, 0);
  assert.equal(r.result.status, 'completed');
  assert.equal(r.result.shipped_sha, 'DRYRUN');
});

// --- classifyOutcome ---------------------------------------------------------

test('classifyOutcome: maps statuses, defaults to error', () => {
  assert.equal(classifyOutcome({ status: 'completed' }), 'completed');
  assert.equal(classifyOutcome({ status: 'gate_failed' }), 'gate_failed');
  assert.equal(classifyOutcome({ status: 'blocked' }), 'blocked');
  assert.equal(classifyOutcome({ error: true, status: 'error' }), 'error');
  assert.equal(classifyOutcome({ status: 'weird' }), 'error');
  assert.equal(classifyOutcome(null), 'error');
});

// --- pickAccount -------------------------------------------------------------

test('pickAccount: null without accounts, round-robins with', () => {
  assert.equal(pickAccount(null, 0), null);
  assert.equal(pickAccount([], 3), null);
  const a = ['p1', 'p2', 'p3'];
  assert.equal(pickAccount(a, 0), 'p1');
  assert.equal(pickAccount(a, 1), 'p2');
  assert.equal(pickAccount(a, 3), 'p1');
  assert.equal(pickAccount(a, 4), 'p2');
});

// --- shouldPauseForCost ------------------------------------------------------

test('shouldPauseForCost: unknown / over-threshold pause; $0 and small do not', () => {
  assert.equal(shouldPauseForCost({ unknown: true }), true);
  assert.equal(shouldPauseForCost(null), true);
  assert.equal(shouldPauseForCost({ usd: 6, unknown: false }), true);
  assert.equal(shouldPauseForCost({ usd: 0, unknown: false }), false);
  assert.equal(shouldPauseForCost({ usd: 4, unknown: false }), false);
  assert.equal(shouldPauseForCost({ usd: 5, unknown: false }), false); // at threshold, not over
});

// plan 4069 (task 5, R1-R3): the operator's own ceiling + the code-change/data-pass split —
// backward-compatible (no opts ⇒ the legacy $5-threshold behaviour above, unchanged).
test('shouldPauseForCost: a code-change plan pauses only above the ceiling (R1/R3)', () => {
  const opts = { spendClass: 'code-change', ceilingUsd: 100 };
  assert.equal(shouldPauseForCost({ usd: 80, unknown: false }, opts), false);
  assert.equal(shouldPauseForCost({ usd: 100, unknown: false }, opts), false); // at ceiling, not over
  assert.equal(shouldPauseForCost({ usd: 120, unknown: false }, opts), true);
});

// Fix round 1 (finding D, key b46acd): `cost.over` (queue-drain.mjs's parsePlanCost) marks a
// figure that came from a CEILING match — "Cash > $100" parses as `{ usd: 100, over: true }` —
// so the numeric compare alone (100 > 100) misses it and a forecast explicitly declared as
// over-budget slipped through unasked.
test('shouldPauseForCost: honours cost.over even when usd is not strictly above the ceiling (finding D)', () => {
  const opts = { spendClass: 'code-change', ceilingUsd: 100 };
  assert.equal(shouldPauseForCost({ usd: 100, over: true, unknown: false }, opts), true);
  // the unaffected cases stay unaffected
  assert.equal(shouldPauseForCost({ usd: 100, over: false, unknown: false }, opts), false);
  assert.equal(shouldPauseForCost({ usd: 80, over: false, unknown: false }, opts), false);
});

test('shouldPauseForCost: a data-pass plan pauses on ANY non-zero cash, ceiling notwithstanding (R2)', () => {
  const opts = { spendClass: 'data-pass', ceilingUsd: 100 };
  assert.equal(shouldPauseForCost({ usd: 10, unknown: false }, opts), true);
  assert.equal(shouldPauseForCost({ usd: 0, unknown: false }, opts), false); // $0 never asks
  assert.equal(shouldPauseForCost({ usd: 1, unknown: false }, opts), true); // well under the ceiling, still asks
});

// Fix round 3 (item 6, REGRESSION): the data-pass branch used to read `cost.usd != null &&
// cost.usd > 0` alone, missing a forecast like "Cash > $0" (`{ usd: 0, over: true }`) — a paid
// data pass at exactly $0-but-declared-over ran unasked.
test('shouldPauseForCost (round 3, item 6): a data-pass plan also pauses on an explicitly-over cash forecast, even at $0/absent usd (e.g. "Cash > $0")', () => {
  const opts = { spendClass: 'data-pass', ceilingUsd: 100 };
  assert.equal(shouldPauseForCost({ usd: 0, over: true, unknown: false }, opts), true);
  // the unaffected case stays unaffected: $0 and not declared over never asks
  assert.equal(shouldPauseForCost({ usd: 0, over: false, unknown: false }, opts), false);
});

// Fix round 3 (item 5, REGRESSION): round 1's `cost.over` fix honoured the flag UNCONDITIONALLY,
// regardless of which threshold produced it — "Cash > $10" parses as `{ usd: 10, over: true }`,
// and that forced a pause against a $100 ceiling even though $10 is fully compliant with it.
test('shouldPauseForCost (round 3, item 5): cost.over only forces a pause when its own figure is at/above the ACTIVE ceiling', () => {
  const opts = { spendClass: 'code-change', ceilingUsd: 100 };
  // "Cash > $10" parses as {usd:10, over:true} — compliant with a $100 ceiling, must not pause.
  assert.equal(shouldPauseForCost({ usd: 10, over: true, unknown: false }, opts), false);
  // a figure that genuinely IS at/over the ACTIVE ceiling still pauses.
  assert.equal(shouldPauseForCost({ usd: 100, over: true, unknown: false }, opts), true);
});

test('shouldPauseForCost: unknown/absent cost still pauses unconditionally, whichever spendClass', () => {
  for (const spendClass of ['code-change', 'data-pass', undefined]) {
    assert.equal(shouldPauseForCost({ unknown: true }, { spendClass, ceilingUsd: 100 }), true);
    assert.equal(shouldPauseForCost(null, { spendClass, ceilingUsd: 100 }), true);
  }
});

test('shouldPauseForCost: an unclassified call (no opts) is byte-identical to the pre-4069 $5 rule', () => {
  // Same assertions as the base test above, called with a real ceiling in scope but no opts —
  // proves a caller that never classifies a plan (every pre-4069 call site) is unaffected.
  assert.equal(shouldPauseForCost({ usd: 80, unknown: false }), true); // >$5, no ceiling override
  assert.equal(shouldPauseForCost({ usd: 4, unknown: false }), false);
});

// --- readOperatorSpendCeilingUsd / classifyPlanSpend (plan 4069 task 5) -----

function makeSpendTestDir() {
  return mkdtempSync(join(tmpdir(), 'drain-spend-'));
}

test('readOperatorSpendCeilingUsd: reads the configured ceiling; falls back to $5 when absent/invalid', () => {
  const dir = makeSpendTestDir();
  try {
    // no coord.config.json at all
    assert.equal(readOperatorSpendCeilingUsd(dir), PAUSE_COST_THRESHOLD_USD);

    writeFileSync(join(dir, 'coord.config.json'), JSON.stringify({ operatorSpendCeilingUsd: 100 }));
    assert.equal(readOperatorSpendCeilingUsd(dir), 100);

    // invalid values (non-number, zero, negative) all fall back
    for (const bad of ['100', 0, -5, null]) {
      writeFileSync(
        join(dir, 'coord.config.json'),
        JSON.stringify({ operatorSpendCeilingUsd: bad }),
      );
      assert.equal(readOperatorSpendCeilingUsd(dir), PAUSE_COST_THRESHOLD_USD, JSON.stringify(bad));
    }

    // malformed JSON
    writeFileSync(join(dir, 'coord.config.json'), '{not json');
    assert.equal(readOperatorSpendCeilingUsd(dir), PAUSE_COST_THRESHOLD_USD);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fix round 3 (item 7): loadCoordConfig's normalizeConfig throws on ANY invalid field in the
// whole file, not just an invalid operatorSpendCeilingUsd — round 2's bare catch collapsed the
// money ceiling to $5 on a totally unrelated config problem. On a throw, a TARGETED raw read of
// just operatorSpendCeilingUsd must still recover the real, valid ceiling.
test('readOperatorSpendCeilingUsd (round 3, item 7): an unrelated config-authoring error elsewhere in the file must not silently collapse a VALID ceiling to $5', () => {
  const dir = makeSpendTestDir();
  try {
    writeFileSync(
      join(dir, 'coord.config.json'),
      JSON.stringify({
        // scopeMaxKeys must be a positive integer (coord-config.mjs's normalizeScopeMaxKeys) —
        // this alone makes loadCoordConfig(dir) throw, with nothing wrong about the ceiling below.
        scopeMaxKeys: -1,
        operatorSpendCeilingUsd: 100,
      }),
    );
    assert.equal(readOperatorSpendCeilingUsd(dir), 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readOperatorSpendCeilingUsd (round 3, item 7): an unrelated config error AND an invalid/absent ceiling still falls back to $5, not a crash', () => {
  const dir = makeSpendTestDir();
  try {
    writeFileSync(join(dir, 'coord.config.json'), JSON.stringify({ scopeMaxKeys: -1 }));
    assert.equal(readOperatorSpendCeilingUsd(dir), PAUSE_COST_THRESHOLD_USD);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review fix (finding 429f60, part of F7): readOperatorSpendCeilingUsd's raw-JSON fallback used
// to hand-roll `typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT` — a SECOND
// copy of coord-config.mjs's own normalizeOperatorSpendCeilingUsd acceptance rule that could
// silently diverge from it. Fixed by delegating to the canonical normalizer (via the already-
// exported normalizeConfig, fed ONLY the one field so an unrelated malformed field never reaches
// it) instead of re-implementing the predicate. Asserted at the source level since the two
// predicates are behaviourally identical today — this pins the STRUCTURAL fix, not a new
// observable outcome.
test('readOperatorSpendCeilingUsd (fix, finding 429f60): the raw-JSON fallback delegates to the canonical normalizer instead of re-implementing its predicate', () => {
  const fn = DRAIN_SRC.slice(
    DRAIN_SRC.indexOf('export function readOperatorSpendCeilingUsd('),
    DRAIN_SRC.indexOf('export function classifyPlanSpend('),
  );
  assert.ok(fn.length, 'readOperatorSpendCeilingUsd must be found in the source');
  assert.match(fn, /normalizeConfig\(/, 'must delegate through the canonical normalizer');
  assert.doesNotMatch(
    fn,
    /Number\.isFinite/,
    'must not re-implement the acceptance predicate by hand',
  );
});

test('classifyPlanSpend: the durable spendClass frontmatter stamp wins over the path heuristic', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    writeFileSync(
      join(dir, rel),
      [
        '---',
        'spendClass: data-pass',
        '---',
        '',
        '## Tasks',
        '',
        '- edit `backend/scripts/price-pipeline/run.py`',
        '',
      ].join('\n'),
    );
    // the stamp says data-pass even though the Tasks section names a code root
    assert.equal(classifyPlanSpend(dir, rel), 'data-pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyPlanSpend: path-heuristic fallback — a Tasks section naming a code root is code-change', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    for (const codeRoot of [
      'backend/scripts/price-pipeline/run.py',
      'backend/src/location/geocoding/google-provider.ts',
      'shared/src/schemas.ts',
      'scripts/move-plan.mjs',
    ]) {
      writeFileSync(join(dir, rel), `# T\n\n## Tasks\n\n1. Edit \`${codeRoot}\`.\n`);
      assert.equal(classifyPlanSpend(dir, rel), 'code-change', codeRoot);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review fix (finding ef209c, blocking): TASKS_HEADING_RX required the literal PLURAL word
// "tasks" — the real plan corpus overwhelmingly uses singular per-item headings ("## Task 1 —
// …", "## Task 1: Spike …"), so those plans had no matching heading, fell through to the
// uncertain⇒data-pass branch, and the $100 code-change ceiling never activated for them. Fixed
// by accepting singular OR plural (`\btasks?\b`), still anchored to a heading line.
test('classifyPlanSpend (fix, finding ef209c): a singular "## Task N — …" heading is recognised, not just plural "## Tasks"', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    writeFileSync(
      join(dir, rel),
      '# T\n\n## Task 1 — fix the geocode adapter\n\n1. Edit `scripts/foo.mjs`.\n',
    );
    assert.equal(classifyPlanSpend(dir, rel), 'code-change');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review fix (finding ef209c): the durable `spendClass:` frontmatter stamp must still win over
// the path heuristic in BOTH directions, including against the widened singular-heading match.
test('classifyPlanSpend (fix, finding ef209c): the explicit spendClass frontmatter still wins over the heuristic, both directions', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    // data-pass stamp wins even with a singular "## Task N" code-root mention
    writeFileSync(
      join(dir, rel),
      '---\nspendClass: data-pass\n---\n\n## Task 1 — x\n\n1. Edit `scripts/foo.mjs`.\n',
    );
    assert.equal(classifyPlanSpend(dir, rel), 'data-pass');
    // code-change stamp wins even with no Tasks heading at all
    writeFileSync(
      join(dir, rel),
      '---\nspendClass: code-change\n---\n\n# T\n\nJust prose, no Tasks section.\n',
    );
    assert.equal(classifyPlanSpend(dir, rel), 'code-change');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyPlanSpend: no spendClass stamp and no code-root path in Tasks ⇒ data-pass', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    writeFileSync(
      join(dir, rel),
      [
        '# T',
        '',
        '## Tasks',
        '',
        // A path OUTSIDE all four code roots (backend/scripts/**, backend/src/**, shared/src/**,
        // scripts/**) — the seed/store trees live under backend/data/, not backend/src/data/seed/
        // (which itself would match backend/src/** and is deliberately NOT used here).
        '1. Re-run the national price refresh over `backend/data/price-pipeline/render-store/`.',
        '',
      ].join('\n'),
    );
    assert.equal(classifyPlanSpend(dir, rel), 'data-pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fix round 3 (item 2, INVERTS this test's expectation): an unreadable plan file used to classify
// as 'code-change' on the theory that an unreadable file was an anomaly, not a real data-pass
// signal. Under the governing principle for this whole function ("when the spend class is
// uncertain, ASK") that was backwards — an unreadable plan is MAXIMAL uncertainty, and the cost of
// a false ask (one operator click) is far below the cost of a false code-change (up to the
// ceiling in unapproved spend) — so it now classifies as 'data-pass' like every other ambiguous
// case.
test('classifyPlanSpend (round 3, item 2): an unreadable/missing plan file classifies as data-pass — maximal uncertainty asks, never assumes the ceiling is safe to skip', () => {
  const dir = makeSpendTestDir();
  try {
    assert.equal(classifyPlanSpend(dir, 'does-not-exist.md'), 'data-pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fix round 1 (finding E): four concrete defects in the path-heuristic fallback.
test('classifyPlanSpend (finding E.1): the sharded seed root is clinic DATA, not code — stays data-pass', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    // Built from a separate root segment (never spelled as one quoted span naming the full
    // sharded-seed root in one go) so this genuinely-necessary reference into that tree does
    // not itself trip the assert-seed-io-seam push gate that CODE_CHANGE_PATH_RX's own negative
    // lookahead exists to respect.
    const seedRoot = ['backend', 'src', 'data', 'seed'].join('/');
    writeFileSync(join(dir, rel), `# T\n\n## Tasks\n\n1. Write \`${seedRoot}/chains.json\`.\n`);
    assert.equal(classifyPlanSpend(dir, rel), 'data-pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyPlanSpend (finding E.2): frontend/src/** is a code root', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    writeFileSync(
      join(dir, rel),
      '# T\n\n## Tasks\n\n1. Edit `frontend/src/components/SearchBar.tsx`.\n',
    );
    assert.equal(classifyPlanSpend(dir, rel), 'code-change');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyPlanSpend (finding E.3): a code root must be repo-root-anchored, not a nested occurrence', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    writeFileSync(
      join(dir, rel),
      '# T\n\n## Tasks\n\n1. Update `docs/scripts/example.md` — no code touched.\n',
    );
    assert.equal(classifyPlanSpend(dir, rel), 'data-pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fix round 3 (item 3): the seed exclusion only excluded DESCENDANTS written with a trailing
// slash after the seed segment — the seed ROOT mentioned bare (no trailing slash) still fell
// through to the `backend/src/` alternative and classified a seed data pass as code.
test('classifyPlanSpend (round 3, item 3): the seed ROOT mentioned bare (no trailing slash) is also excluded, not just its descendants', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    // Built from a joined array (never one quoted span naming the full sharded-seed root), same
    // convention as finding E.1 above, so this reference does not itself trip the
    // assert-seed-io-seam push gate.
    const seedRoot = ['backend', 'src', 'data', 'seed'].join('/');
    writeFileSync(
      join(dir, rel),
      `# T\n\n## Tasks\n\n1. Re-run the pipeline over \`${seedRoot}\`.\n`,
    );
    assert.equal(classifyPlanSpend(dir, rel), 'data-pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fix round 3 (item 4): `(?<![\w/])` let a root match after ANY non-word/non-slash punctuation,
// including a nested/mid-word occurrence like `x.scripts/` (preceded by `.`, neither a word char
// nor `/`) — a root must now start only at a real path start (string start, whitespace, or an
// opening quote/backtick/paren).
test('classifyPlanSpend (round 3, item 4): a root only anchors at a real path start — not after arbitrary punctuation like a bare dot', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    writeFileSync(join(dir, rel), '# T\n\n## Tasks\n\n1. See `x.scripts/foo.mjs` for context.\n');
    assert.equal(classifyPlanSpend(dir, rel), 'data-pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fix round 3 (item 1, INVERTS this test's expectation and REVERTS finding E.4): round 1 made a
// plan with no `## Tasks` heading fall back to scanning the WHOLE body for a code-root mention.
// That let incidental narrative prose ("this fixes a bug in `scripts/foo.mjs`") flip a genuine
// data-only rerun to code-change and skip R2's cash-forecast pause. Reverted: no `## Tasks`
// section ⇒ 'data-pass' unconditionally, regardless of what the rest of the body mentions — a
// plan that wants the full ceiling declares `spendClass: code-change` explicitly.
test('classifyPlanSpend (round 3, item 1): no ## Tasks heading ⇒ data-pass, even when the rest of the body mentions a code root', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    writeFileSync(
      join(dir, rel),
      [
        '# T',
        '',
        '## What to delete',
        '',
        '1. Remove `backend/scripts/price-pipeline/legacy-run.py`.',
        '',
      ].join('\n'),
    );
    assert.equal(classifyPlanSpend(dir, rel), 'data-pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review round 2 (R2-4, key 185 altitude): `.*\btasks?\b` matched any heading merely CONTAINING
// the word — e.g. "## Task-force notes" ("Task" bounded by the following hyphen). Anchored to a
// genuine Tasks-section heading: hashes, "Task"/"Tasks" as the FIRST word, then only a number
// and/or the punctuation that introduces the rest of a real heading (colon, em/en dash) — never
// arbitrary prose glued straight onto the word.
test('classifyPlanSpend (R2-4): the three real corpus heading shapes still match', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    for (const heading of ['## Tasks', '### Tasks:', '## Task 1 — fix the geocode adapter']) {
      writeFileSync(join(dir, rel), `# T\n\n${heading}\n\n1. Edit \`scripts/foo.mjs\`.\n`);
      assert.equal(classifyPlanSpend(dir, rel), 'code-change', heading);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyPlanSpend (R2-4): a heading merely CONTAINING the word "task(s)" no longer false-matches', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    for (const heading of ['## Task-force notes', '## Tasking', '## Subtasks deferred']) {
      writeFileSync(join(dir, rel), `# T\n\n${heading}\n\n1. Edit \`scripts/foo.mjs\`.\n`);
      assert.equal(
        classifyPlanSpend(dir, rel),
        'data-pass',
        `${heading} must NOT be read as a Tasks-section heading`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review round 3 (key 209 x6 — angle-A/B/C, altitude, writer-trace, claude-data-grounding): round
// 2's fix above over-corrected — it enumerated an allowed-suffix punctuation set (colon, em/en
// dash) instead of the actual predicate, and six independent finders agreed it now REJECTS
// heading shapes real committed plans use: a parenthetical or comma-qualified "## Tasks (sketch)"
// / "## Tasks, in stage order". Fixed at the predicate this time ("Task"/"Tasks" is the first
// word; nothing after it is excluded except a word char or hyphen gluing onto a longer word), so
// the pendulum (round 1 too broad, round 2 too narrow) stops here — both directions pinned in one
// test so a future edit can't re-narrow or re-widen it without failing loudly.
test('classifyPlanSpend (R3-1, key 209): the predicate fix — first word exactly Task/Tasks, anything may follow', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    for (const heading of [
      '## Tasks',
      '## Tasks (sketch)',
      '## Tasks, in stage order',
      '## Task 1 — /behandlingar (…)',
      '### Tasks:',
      '## Task 1: Spike',
    ]) {
      writeFileSync(join(dir, rel), `# T\n\n${heading}\n\n1. Edit \`scripts/foo.mjs\`.\n`);
      assert.equal(classifyPlanSpend(dir, rel), 'code-change', `must match: ${heading}`);
    }
    for (const heading of ['## Task-force notes', '## Tasking', '## Subtasks deferred']) {
      writeFileSync(join(dir, rel), `# T\n\n${heading}\n\n1. Edit \`scripts/foo.mjs\`.\n`);
      assert.equal(classifyPlanSpend(dir, rel), 'data-pass', `must NOT match: ${heading}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review fix (round-3 re-review, keys 1o88dsp/6cl5x6 — the last two must-fix findings): the R3-1
// predicate above expressed "not glued onto a longer word" as `(?![\w-])`, but `\w` is ASCII-only,
// so a heading whose next character is a NON-ASCII letter still passed the lookahead — "## Tasksé"
// and "## Tasksåäö" (this repo is Swedish; å/ä/ö are the letters most likely to appear) were read
// as the Tasks SECTION and could flip a genuine data pass to `code-change`, skipping ruling R2's
// mandatory ask. Fixed by making the lookahead Unicode-aware (`\p{L}\p{N}_` under the `u` flag)
// rather than by enumerating letters. Pinned in BOTH directions, like its R3-1 sibling above.
test('classifyPlanSpend (round-3 re-review, keys 1o88dsp/6cl5x6): the word-glue lookahead is Unicode-aware, not ASCII-only', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    // A non-ASCII letter glued onto "Task"/"Tasks" is still a LONGER WORD, not the Tasks section.
    for (const heading of ['## Tasksé', '## Tasksåäö', '## Taskör 1']) {
      writeFileSync(join(dir, rel), `# T\n\n${heading}\n\n1. Edit \`scripts/foo.mjs\`.\n`);
      assert.equal(classifyPlanSpend(dir, rel), 'data-pass', `must NOT match: ${heading}`);
    }
    // A non-ASCII character that is NOT a letter/digit cannot glue a word, so these still match —
    // the em-dash and the Swedish-quoted qualifier are both real committed heading shapes.
    for (const heading of ['## Tasks — i ordning', '## Tasks ”skiss”']) {
      writeFileSync(join(dir, rel), `# T\n\n${heading}\n\n1. Edit \`scripts/foo.mjs\`.\n`);
      assert.equal(classifyPlanSpend(dir, rel), 'code-change', `must match: ${heading}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review round 2 (R2-5, key 208 angle-A): the code-path heuristic's lookbehind already tolerated
// a preceding backtick or `(` (so `` `scripts/foo.mjs` `` and a markdown link's TARGET,
// `[the runner](scripts/foo.mjs)`, already counted) but not a preceding `[` — so a path named as
// a markdown link's own TEXT (`[scripts/foo.mjs](docs/runbooks/x.md)`) fell through uncounted.
test('classifyPlanSpend (R2-5): a code path named as a markdown link\'s TEXT (preceded by "[") counts', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    writeFileSync(
      join(dir, rel),
      '# T\n\n## Tasks\n\n1. See [scripts/foo.mjs](docs/runbooks/x.md) for details.\n',
    );
    assert.equal(classifyPlanSpend(dir, rel), 'code-change');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyPlanSpend (R2-5): a backticked code path still counts (regression)', () => {
  const dir = makeSpendTestDir();
  try {
    const rel = 'plan.md';
    writeFileSync(join(dir, rel), '# T\n\n## Tasks\n\n1. See `scripts/foo.mjs` for details.\n');
    assert.equal(classifyPlanSpend(dir, rel), 'code-change');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- state accumulation ------------------------------------------------------

test('emptyState shape', () => {
  const s = emptyState();
  assert.deepEqual(s.plans_completed, []);
  assert.equal(s.cumulative_spend_usd, 0);
  assert.equal(s.iterations, 0);
});

test('nextState: completed accumulates + rounds spend', () => {
  let s = emptyState();
  s = nextState(s, { slug: 'a', outcome: 'completed', spendUsd: 1.25 });
  s = nextState(s, { slug: 'b', outcome: 'completed', spendUsd: 2.1 });
  assert.deepEqual(s.plans_completed, ['a', 'b']);
  assert.equal(s.cumulative_spend_usd, 3.35);
  assert.equal(s.iterations, 2);
});

test('nextState: gate_failed + error → quarantined; blocked → blocked', () => {
  let s = emptyState();
  s = nextState(s, { slug: 'a', outcome: 'gate_failed', spendUsd: 0.5 });
  s = nextState(s, { slug: 'b', outcome: 'error', spendUsd: 0 });
  s = nextState(s, { slug: 'c', outcome: 'blocked', spendUsd: 0.2 });
  assert.deepEqual(s.plans_quarantined, ['a', 'b']);
  assert.deepEqual(s.plans_blocked, ['c']);
  assert.equal(s.cumulative_spend_usd, 0.7);
});

test('nextState: immutable (does not mutate input)', () => {
  const s0 = emptyState();
  nextState(s0, { slug: 'a', outcome: 'completed', spendUsd: 1 });
  assert.equal(s0.iterations, 0);
  assert.deepEqual(s0.plans_completed, []);
});

// --- spawnGateOpen (plan 518: reserve-based spawn gate) -----------------------

test('spawnGateOpen: settled + inFlight×reserve within ceiling → open', () => {
  assert.equal(spawnGateOpen({ settled: 5, inFlight: 2, reserve: 2.5, ceiling: 10 }), true); // 5+5=10 ≤ 10
  assert.equal(spawnGateOpen({ settled: 0, inFlight: 0, reserve: 2.5, ceiling: 10 }), true);
  assert.equal(spawnGateOpen({ settled: 5.01, inFlight: 2, reserve: 2.5, ceiling: 10 }), false);
  assert.equal(spawnGateOpen({ settled: 9, inFlight: 1, reserve: 2.5, ceiling: 10 }), false);
});

test('spawnGateOpen: zero in-flight degenerates to settled ≤ ceiling (serial compat)', () => {
  assert.equal(spawnGateOpen({ settled: 9.99, inFlight: 0, reserve: 2.5, ceiling: 10 }), true);
  assert.equal(spawnGateOpen({ settled: 10.01, inFlight: 0, reserve: 2.5, ceiling: 10 }), false);
});

// --- landing-state folds (plan 518) -------------------------------------------

test('emptyState: gains plans_landed / lands_parked / in_flight / run_config', () => {
  const s = emptyState();
  assert.deepEqual(s.plans_landed, []);
  assert.deepEqual(s.lands_parked, []);
  assert.deepEqual(s.in_flight, []);
  assert.equal(s.run_config, null);
});

test('recordLanded / recordLandParked: immutable, tolerate legacy state without the keys', () => {
  const legacy = { plans_completed: [], cumulative_spend_usd: 0, iterations: 0 };
  const s1 = recordLanded(legacy, 'a-slug');
  assert.deepEqual(s1.plans_landed, ['a-slug']);
  assert.equal(legacy.plans_landed, undefined);
  // plan 629: a record with no explicit disposition defaults to 'operator' (the pre-629
  // park-to-waiting-operator behaviour).
  const s2 = recordLandParked(s1, { slug: 'b-slug', seam: 'REVIEW_NEEDED', reason: 'no marker' });
  assert.deepEqual(s2.lands_parked, [
    { slug: 'b-slug', seam: 'REVIEW_NEEDED', reason: 'no marker', disposition: 'operator' },
  ]);
  assert.deepEqual(s1.lands_parked ?? [], []);
  // An explicit 'resume' disposition (a land-stuck seam held in in-progress/) round-trips.
  const s3 = recordLandParked(s1, {
    slug: 'c-slug',
    seam: 'REBASE_CONFLICT',
    reason: 'held',
    disposition: 'resume',
  });
  assert.equal(s3.lands_parked[0].disposition, 'resume');
});

// --- classifySpineExit (plan 518: done-worktree HANDOFF seam parser) ----------

test('classifySpineExit: exit 0 → landed', () => {
  assert.deepEqual(classifySpineExit({ code: 0, stdout: 'step-12 report...' }), { landed: true });
});

test('classifySpineExit: HANDOFF line is authoritative; QUEUE_WAIT alone is retryable', () => {
  assert.deepEqual(
    classifySpineExit({ code: 11, stdout: 'HANDOFF:REVIEW_NEEDED\n{"code":"REVIEW_NEEDED"}' }),
    {
      landed: false,
      seam: 'REVIEW_NEEDED',
      retryable: false,
    },
  );
  assert.deepEqual(classifySpineExit({ code: 18, stdout: 'HANDOFF:QUEUE_WAIT\n{}' }), {
    landed: false,
    seam: 'QUEUE_WAIT',
    retryable: true,
  });
});

test('classifySpineExit: no HANDOFF line → reverse-map the exit code; unknown → UNKNOWN', () => {
  assert.deepEqual(classifySpineExit({ code: 20, stdout: '' }), {
    landed: false,
    seam: 'BUILD_FAILED',
    retryable: false,
  });
  assert.deepEqual(classifySpineExit({ code: 1, stdout: 'some crash' }), {
    landed: false,
    seam: 'UNKNOWN',
    retryable: false,
  });
});

// --- shouldHalt --------------------------------------------------------------

test('shouldHalt: spend ceiling reached', () => {
  const s = { ...emptyState(), cumulative_spend_usd: DEFAULT_CEILING_USD };
  assert.deepEqual(shouldHalt(s), { halt: true, reason: 'spend_ceiling' });
});

test('shouldHalt: custom ceiling', () => {
  const s = { ...emptyState(), cumulative_spend_usd: 5.01 };
  assert.equal(shouldHalt(s, 5).halt, true);
  assert.equal(shouldHalt(s, 10).halt, false);
});

test('shouldHalt: quarantine limit', () => {
  const s = { ...emptyState(), plans_quarantined: new Array(MAX_QUARANTINES).fill('x') };
  assert.deepEqual(shouldHalt(s), { halt: true, reason: 'quarantine_limit' });
});

test('shouldHalt: under all limits → no halt', () => {
  const s = { ...emptyState(), cumulative_spend_usd: 3, plans_quarantined: ['x'] };
  assert.equal(shouldHalt(s).halt, false);
});

// --- runDrain loop (injected oracle/runner/quarantine seams; no git/spawn) ---

const NOWHERE = '.drain-test-nonexistent'; // loadState → emptyState (path absent)
const P = (slug, cost = { usd: 0, unknown: false }) => ({
  slug,
  path: `docs/superpowers/plans/ready/${slug}.md`,
  cost,
});
function scriptedOracle(plans) {
  let i = 0;
  return () => (i < plans.length ? { next: plans[i++] } : { reason: 'empty' });
}
const ok =
  (extra = {}) =>
  async (p) => ({
    result: { status: 'completed', slug: p.slug, ...extra },
    spendUsd: extra.spendUsd ?? 0,
  });

test('runDrain: phase 3 drains all eligible plans then terminates empty', async () => {
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('203-x'), P('210-x')]),
    runner: ok({ spendUsd: 0.1 }),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'empty');
  assert.deepEqual(r.state.plans_completed, ['203-x', '210-x']);
  assert.equal(r.state.iterations, 2);
});

test('runDrain: phase 2 stops after one completed plan (phase2_paused_before_land)', async () => {
  const r = await runDrain({
    phase: 2,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('203-x'), P('210-x')]),
    runner: ok(),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'phase2_paused_before_land');
  assert.deepEqual(r.state.plans_completed, ['203-x']);
});

test('runDrain: gate failures quarantine; 2 halt the loop', async () => {
  const quarantined = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b'), P('c')]),
    runner: async (p) => ({ result: { status: 'gate_failed', slug: p.slug }, spendUsd: 0 }),
    quarantine: (p) => quarantined.push(p.slug),
    persist: () => {},
  });
  assert.equal(r.reason, 'quarantine_limit');
  assert.deepEqual(quarantined, ['a', 'b']); // 'c' never runs — halt fires first
  assert.equal(r.state.plans_quarantined.length, 2);
});

test('runDrain: unknown-cost plan, non-interactive → cost-parks and CONTINUES (plan 518; cost_pause reason retired)', async () => {
  // REWRITTEN from the serial driver's terminate-on-cost_pause: the pool parks
  // the plan (ready/ → waiting-operator/) and keeps draining the queue.
  const ran = [];
  const costParked = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a', { unknown: true }), P('b')]),
    runner: async (p) => {
      ran.push(p.slug);
      return { result: { status: 'completed', slug: p.slug }, spendUsd: 0 };
    },
    claim: () => {},
    parkCostPause: (p) => costParked.push(p.slug),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'empty'); // NOT cost_pause — the run kept going
  assert.deepEqual(ran, ['b']); // 'a' never ran; 'b' did
  assert.deepEqual(costParked, ['a']);
  // The closing SKIPPED list names the parked plan with the cost_pause reason.
  const skip = r.state.plans_skipped.find((s) => s.slug === 'a');
  assert.equal(skip.exclude, 'cost_pause');
});

// Review fix (findings c01265/3cc803, part of F7): the operator spend ceiling used to be
// re-read (and re-normalised) once per CANDIDATE PLAN inside the FILL loop, so a large drain does
// hundreds of synchronous config reads, and a config edit mid-run could make otherwise-identical
// plans see different ceilings. Fixed by resolving it ONCE per drain run, via an injectable
// `readCeiling` seam so the count is directly observable.
test('runDrain (fix, findings c01265/3cc803): reads the operator spend ceiling ONCE per run, not once per candidate plan', async () => {
  let calls = 0;
  const parked = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([
      P('a', { usd: 200, unknown: false }),
      P('b', { usd: 200, unknown: false }),
      P('c', { usd: 200, unknown: false }),
    ]),
    readCeiling: () => {
      calls++;
      return 100;
    },
    claim: () => {},
    parkCostPause: (p) => parked.push(p.slug),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'empty');
  assert.deepEqual(parked, ['a', 'b', 'c']);
  assert.equal(calls, 1, 'the ceiling must be read once for the whole run, not once per candidate');
});

test('runDrain: spend ceiling halts before the next plan', async () => {
  const r = await runDrain({
    phase: 3,
    ceiling: 1,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b'), P('c')]),
    runner: ok({ spendUsd: 0.6 }),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'spend_ceiling'); // 0.6 + 0.6 = 1.2 ≥ 1 → halt before c
  assert.deepEqual(r.state.plans_completed, ['a', 'b']);
});

test('runDrain: records the full carry-forward manifest in state (audit)', async () => {
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    runner: ok({ carry_forward: [{ kind: 'open-new-plan', title: 'follow X' }] }),
    mintCarryForwards: () => [], // stub — don't spawn the real git minter in a unit test
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.state.carry_forwards.length, 1);
  assert.equal(r.state.carry_forwards[0].kind, 'open-new-plan');
  assert.equal(r.state.carry_forwards[0].plan, 'a');
});

test('runDrain: a blocked plan parks to waiting-operator and CONTINUES (plan 444)', async () => {
  // Both a and b block; the loop must park each and keep going, ending on the
  // oracle's terminal reason — NOT halt on the first block (the old plan_blocked).
  const operatored = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b')]),
    runner: async (p) => ({
      result: { status: 'blocked', slug: p.slug, notes: 'needs fan-out' },
      spendUsd: 0,
    }),
    quarantineToOperator: (p, sha) => operatored.push(`${p.slug}@${sha}`),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'empty'); // ran a + b, then queue exhausted — did NOT halt on the block
  assert.deepEqual(r.state.plans_blocked, ['a', 'b']); // both recorded
  assert.deepEqual(operatored, ['a@', 'b@']); // both filed to waiting-operator (sketch → empty sha)
});

test('runDrain: halts plan_not_advancing if a plan re-appears after running', async () => {
  // Oracle always returns the same plan (simulates landing failing to remove it).
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: () => ({ next: P('stuck-x') }),
    runner: ok(),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'plan_not_advancing');
  assert.equal(r.state.plans_completed.length, 1); // ran exactly once
});

// --- dispatcher pool (plan 518) ------------------------------------------------

test('runDrain pool: never more than --workers in flight; claims serialize in oracle order; all plans fold', async () => {
  let live = 0;
  let peak = 0;
  const claims = [];
  const r = await runDrain({
    phase: 3,
    workers: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b'), P('c'), P('d'), P('e')]),
    claim: (p) => claims.push(p.slug),
    runner: async (p) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((res) => setTimeout(res, 10 + Math.random() * 10));
      live--;
      return { result: { status: 'completed', slug: p.slug }, spendUsd: 0 };
    },
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'empty');
  assert.equal(r.state.plans_completed.length, 5);
  assert.ok(peak <= 3, `pool overflow: ${peak} in flight`);
  assert.ok(peak >= 2, `pool never overlapped (peak ${peak}) — not actually parallel`);
  assert.deepEqual(claims, ['a', 'b', 'c', 'd', 'e']); // strict serial claim order
});

test('runDrain pool: reserve gate defers a spawn until a settle frees headroom', async () => {
  // ceiling 10, reserve 3. a/b/c spawn (0, 3, 6 ≤ 10). a settles +$5 →
  // 5 + 2×3 = 11 > 10 blocks d; b settles +$1 → 6 + 1×3 = 9 ≤ 10 spawns d.
  const events = [];
  const mk = (latency, spend) => async (p) => {
    await new Promise((res) => setTimeout(res, latency));
    events.push(`end:${p.slug}`);
    return { result: { status: 'completed', slug: p.slug }, spendUsd: spend };
  };
  const runners = { a: mk(5, 5), b: mk(20, 1), c: mk(50, 1), d: mk(1, 0) };
  const r = await runDrain({
    phase: 3,
    workers: 3,
    ceiling: 10,
    reserve: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b'), P('c'), P('d')]),
    claim: (p) => events.push(`claim:${p.slug}`),
    runner: (p) => runners[p.slug](p),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.state.plans_completed.length, 4);
  const idx = (e) => events.indexOf(e);
  assert.ok(idx('claim:d') > idx('end:a'), `d not deferred past a's settle: ${events}`);
  assert.ok(idx('claim:d') > idx('end:b'), `d spawned while reserve-blocked: ${events}`);
});

test('runDrain pool: a breaker stops spawning but in-flight workers always fold (never killed)', async () => {
  const r = await runDrain({
    phase: 3,
    workers: 2,
    ceiling: 1,
    reserve: 0,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b'), P('c')]),
    claim: () => {},
    runner: async (p) => {
      await new Promise((res) => setTimeout(res, 10));
      return { result: { status: 'completed', slug: p.slug }, spendUsd: 1 };
    },
    quarantine: () => {},
    persist: () => {},
  });
  // a + b spawn together; the $2 settled ≥ $1 ceiling halts BEFORE c, but both
  // a and b still folded as completed — no in-flight work was discarded.
  assert.equal(r.reason, 'spend_ceiling');
  assert.deepEqual([...r.state.plans_completed].sort(), ['a', 'b']);
});

// --- interactive mode (plan 518) ------------------------------------------------

test('runDrain interactive: cost-pause prompt — approve runs the plan, decline parks it', async () => {
  const ran = [];
  const costParked = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a', { unknown: true }), P('b', { usd: 9, unknown: false })]),
    prompter: async (kind, payload) => {
      assert.equal(kind, 'cost_pause');
      return payload.plan.slug === 'a'; // approve a, decline b
    },
    claim: () => {},
    parkCostPause: (p) => costParked.push(p.slug),
    runner: async (p) => {
      ran.push(p.slug);
      return { result: { status: 'completed', slug: p.slug }, spendUsd: 0 };
    },
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'empty');
  assert.deepEqual(ran, ['a']);
  assert.deepEqual(costParked, ['b']);
});

// Review round 2 (R2-6, key 2668 guard-fires): the data-pass cost-pause branch fires on EITHER of
// two distinct predicates (shouldPauseForCost's own comment) — a genuinely positive figure
// (`cost.usd > 0`), or an explicit "over" bound at ANY figure including $0 (`cost.over`, e.g.
// "Cash > $0"). The old text unconditionally said "non-zero cash forecast" for BOTH — false for
// the second predicate, since a plan declaring exactly $0 with an explicit ">" bound has no
// non-zero figure at all. `classifyPlanSpend(mainDir, plan.path)` returns 'data-pass' for both
// fixtures below regardless of file content, since `mainDir` (NOWHERE) never resolves a real path.
test('runDrain (R2-6): the data-pass cost-pause reason is TRUE for whichever predicate actually fired', async () => {
  const whys = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([
      P('zero-over', { usd: 0, over: true, unknown: false }),
      P('nonzero', { usd: 9, unknown: false }),
    ]),
    prompter: async (kind, payload) => {
      whys.push(payload.why);
      return false; // decline both — only the reason text is under test
    },
    claim: () => {},
    parkCostPause: () => {},
    runner: async (p) => ({ result: { status: 'completed', slug: p.slug }, spendUsd: 0 }),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'empty');
  assert.equal(whys.length, 2);
  assert.doesNotMatch(
    whys[0],
    /non-zero cash forecast/,
    'a $0-but-explicitly-"over" bound is not "non-zero cash" — that statement is false for this plan',
  );
  assert.match(whys[0], /explicit "over" cash bound/);
  assert.match(whys[1], /non-zero cash forecast/, 'a genuinely positive figure keeps the old text');
});

test('runDrain interactive: ceiling prompt — a raise resumes spawning, this run only', async () => {
  const prompts = [];
  const r = await runDrain({
    phase: 3,
    ceiling: 1,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b'), P('c')]),
    prompter: async (kind, payload) => {
      prompts.push(kind);
      if (kind === 'ceiling') {
        assert.equal(payload.ceiling, 1);
        return 5; // raise to $5
      }
      return false;
    },
    claim: () => {},
    runner: ok({ spendUsd: 0.6 }),
    quarantine: () => {},
    persist: () => {},
  });
  // 0.6 + 0.6 = 1.2 ≥ 1 → prompt → raised to 5 → c runs → queue empty.
  assert.equal(r.reason, 'empty');
  assert.deepEqual(r.state.plans_completed, ['a', 'b', 'c']);
  assert.deepEqual(prompts, ['ceiling']);
});

test('runDrain interactive: ceiling prompt declined → finishes spend_ceiling as before', async () => {
  const r = await runDrain({
    phase: 3,
    ceiling: 1,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b'), P('c')]),
    prompter: async (kind) => (kind === 'ceiling' ? false : false),
    claim: () => {},
    runner: ok({ spendUsd: 0.6 }),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'spend_ceiling');
  assert.deepEqual(r.state.plans_completed, ['a', 'b']);
});

test('runDrain interactive: quarantine-limit prompt — continue extends the budget', async () => {
  const quarantined = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b'), P('c')]),
    prompter: async (kind, payload) => {
      if (kind === 'quarantine_limit') {
        assert.equal(payload.count, 2);
        return true;
      }
      return false;
    },
    claim: () => {},
    runner: async (p) =>
      p.slug === 'c'
        ? { result: { status: 'completed', slug: p.slug }, spendUsd: 0 }
        : { result: { status: 'gate_failed', slug: p.slug }, spendUsd: 0 },
    quarantine: (p) => quarantined.push(p.slug),
    persist: () => {},
  });
  assert.equal(r.reason, 'empty'); // operator continued past the 2-quarantine halt
  assert.deepEqual(quarantined, ['a', 'b']);
  assert.deepEqual(r.state.plans_completed, ['c']);
});

test('runDrain: records run_config and in_flight forensics in state (plan 518)', async () => {
  const snapshots = [];
  const r = await runDrain({
    phase: 3,
    workers: 2,
    reserve: 1.5,
    ceiling: 7,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    claim: () => {},
    runner: ok(),
    quarantine: () => {},
    persist: (s) => snapshots.push(s),
  });
  assert.deepEqual(r.state.run_config, {
    workers: 2,
    reserve: 1.5,
    interactive: false,
    phase: 3,
    ceiling: 7,
  });
  // While 'a' was live, some persisted snapshot carried it in in_flight.
  assert.ok(
    snapshots.some((s) => (s.in_flight || []).some((f) => f.slug === 'a')),
    'no persisted snapshot recorded the in-flight worker',
  );
  // After the drain, in_flight is empty again.
  assert.deepEqual(r.state.in_flight, []);
});

// --- blocked-plan triage (plan 518) ----------------------------------------------

test('buildContinuationPrompt: granted checkpoint, resume pushed branch, never land', () => {
  const p = buildContinuationPrompt(plan, 'ce3ce3e4');
  assert.match(p, /GRANTED/);
  assert.match(p, /worktree-203-UI-x/);
  assert.match(p, /ce3ce3e4/);
  assert.match(p, /in-progress\/203-UI-x\.md/);
  assert.match(p, /DO NOT run done-worktree/);
  assert.match(p, /record-review\.mjs/);
  assert.match(p, /set-state 203-UI-x ACTIVE/);
});

test('runDrain triage: grant spawns a continuation worker; its completion lands; nothing parks', async () => {
  const parked = [];
  const landed = [];
  const runs = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    prompter: async (kind, payload) => {
      assert.equal(kind, 'blocked_triage');
      assert.equal(payload.plan.slug, 'a');
      assert.equal(payload.result.shipped_sha, 'ce3ce3e4');
      return 'grant';
    },
    claim: () => {},
    runner: async (p, opts = {}) => {
      runs.push(opts.promptOverride ? 'continuation' : 'first');
      if (opts.promptOverride) {
        assert.match(opts.promptOverride, /GRANTED/); // continuation protocol, not the default
        return {
          result: { status: 'completed', slug: p.slug, shipped_sha: 'ce3ce3e4' },
          spendUsd: 0,
        };
      }
      return {
        result: { status: 'blocked', slug: p.slug, shipped_sha: 'ce3ce3e4', notes: 'apply gate' },
        spendUsd: 0,
      };
    },
    land: async (p) => {
      landed.push(p.slug);
      return { code: 0, stdout: '' };
    },
    quarantineToOperator: (p, sha) => parked.push(`${p.slug}@${sha}`),
    mintCarryForwards: () => [],
    quarantine: () => {},
    persist: () => {},
  });
  assert.deepEqual(runs, ['first', 'continuation']);
  assert.deepEqual(parked, []); // a granted block is never parked
  assert.deepEqual(landed, ['a']); // the continuation's completion flowed into the landing queue
  assert.deepEqual(r.state.plans_landed, ['a']);
  assert.deepEqual(r.state.plans_blocked, ['a']); // the first block is still on the audit record
});

test('runDrain triage: park answer files to waiting-operator exactly as non-interactive does', async () => {
  const parked = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    prompter: async (kind) => (kind === 'blocked_triage' ? 'park' : false),
    claim: () => {},
    runner: async (p) => ({
      result: { status: 'blocked', slug: p.slug, shipped_sha: 'ce3ce3e4', notes: 'apply gate' },
      spendUsd: 0,
    }),
    quarantineToOperator: (p, sha) => parked.push(`${p.slug}@${sha}`),
    quarantine: () => {},
    persist: () => {},
  });
  assert.deepEqual(parked, ['a@ce3ce3e4']);
  assert.equal(r.reason, 'empty');
});

test('runDrain triage: a sketch block NEVER prompts (no auto-dispatched fan-outs, both modes)', async () => {
  const parked = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    prompter: async (kind) => {
      assert.notEqual(kind, 'blocked_triage', 'sketch block must not reach the triage prompt');
      return false;
    },
    claim: () => {},
    runner: async (p) => ({
      result: { status: 'blocked', slug: p.slug, notes: 'needs price-pipeline fan-out' },
      spendUsd: 0,
    }),
    quarantineToOperator: (p, sha) => parked.push(`${p.slug}@${sha}`),
    quarantine: () => {},
    persist: () => {},
  });
  assert.deepEqual(parked, ['a@']);
  assert.equal(r.reason, 'empty');
});

test('runDrain triage: a continuation that blocks AGAIN parks without a second prompt', async () => {
  let prompts = 0;
  const parked = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    prompter: async (kind) => {
      if (kind === 'blocked_triage') {
        prompts++;
        return 'grant';
      }
      return false;
    },
    claim: () => {},
    runner: async (p) => ({
      // first AND continuation both block at the checkpoint
      result: { status: 'blocked', slug: p.slug, shipped_sha: 'ce3ce3e4', notes: 'apply gate' },
      spendUsd: 0,
    }),
    quarantineToOperator: (p, sha) => parked.push(`${p.slug}@${sha}`),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(prompts, 1); // one offer per slug — no operator ping-pong
  assert.deepEqual(parked, ['a@ce3ce3e4']); // the re-block parked
  assert.deepEqual(r.state.plans_blocked, ['a']); // dedup: two blocked folds, ONE audit entry
  assert.equal(r.reason, 'empty');
});

// --- driver-serial landing (plan 518) -------------------------------------------

test('runDrain landing: lands strictly one at a time even with parallel workers', async () => {
  let liveLands = 0;
  let peakLands = 0;
  const landed = [];
  const r = await runDrain({
    phase: 3,
    workers: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b'), P('c')]),
    claim: () => {},
    runner: async (p) => {
      await new Promise((res) => setTimeout(res, 5));
      return { result: { status: 'completed', slug: p.slug }, spendUsd: 0 };
    },
    land: async (p) => {
      liveLands++;
      peakLands = Math.max(peakLands, liveLands);
      await new Promise((res) => setTimeout(res, 15));
      liveLands--;
      landed.push(p.slug);
      return { code: 0, stdout: 'ok' };
    },
    mintCarryForwards: () => [],
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(peakLands, 1, `concurrent lands detected (peak ${peakLands})`);
  assert.equal(landed.length, 3);
  assert.deepEqual([...r.state.plans_landed].sort(), ['a', 'b', 'c']);
});

test('runDrain landing: QUEUE_WAIT retries with jittered backoff then parks', async () => {
  let attempts = 0;
  const sleeps = [];
  const parked = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    claim: () => {},
    runner: ok(),
    land: async () => {
      attempts++;
      return { code: 18, stdout: 'HANDOFF:QUEUE_WAIT\n{}' };
    },
    landRetries: 2,
    landSleep: async (ms) => {
      sleeps.push(ms);
    },
    parkLandSeam: (p, seam) => parked.push({ slug: p.slug, seam }),
    mintCarryForwards: () => [],
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(attempts, 3); // initial try + 2 retries
  assert.equal(sleeps.length, 2);
  assert.ok(
    sleeps.every((ms) => ms >= 30_000 && ms < 60_000),
    `backoff out of the 30–60s band: ${sleeps}`,
  );
  assert.deepEqual(parked, [{ slug: 'a', seam: 'QUEUE_WAIT' }]);
  assert.deepEqual(r.state.plans_landed, []);
  assert.equal(r.state.lands_parked[0].seam, 'QUEUE_WAIT');
});

test('runDrain landing: a land-stuck seam HOLDS in in-progress (resume), never mints, never halts (plan 629)', async () => {
  const held = [];
  const parked = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b')]),
    claim: () => {},
    runner: ok(),
    land: async (p) =>
      p.slug === 'a' ? { code: 11, stdout: 'HANDOFF:REVIEW_NEEDED\n{}' } : { code: 0, stdout: '' },
    isBranchMerged: () => false, // not merged → a land-stuck seam routes to resume, not park
    resumeInProgress: (p, seam) => held.push(`${p.slug}:${seam}`),
    parkLandSeam: (p, seam) => parked.push(`${p.slug}:${seam}`),
    mintCarryForwards: () => [],
    quarantine: () => {},
    persist: () => {},
  });
  // REVIEW_NEEDED is land-stuck → HELD in in-progress/ with a RESUME-NEEDED marker, NOT
  // parked to waiting-operator/ (the Task-3 taxonomy: finish the land ≠ operator decision).
  assert.deepEqual(held, ['a:REVIEW_NEEDED']);
  assert.deepEqual(parked, []);
  assert.deepEqual(
    r.state.lands_parked.map((l) => `${l.slug}:${l.seam}:${l.disposition}`),
    ['a:REVIEW_NEEDED:resume'],
  );
  assert.deepEqual(r.state.plans_landed, ['b']); // the run continued and landed b
  assert.equal(r.reason, 'empty'); // a held land is not a quarantine and never halts
});

test('runDrain landing: non-$0 completed plans are never enqueued for landing', async () => {
  // Fix round 3 (items 1/2 ripple): this test's plan must actually be READABLE and classify as
  // 'code-change' — under mainDir: NOWHERE the plan file is unreadable, which round 3 now
  // classifies as 'data-pass' (governing principle: uncertain ⇒ ask), and a data-pass plan pauses
  // on ANY non-zero cash (item 6) — so the $2 cost fixture below would now park-and-continue
  // before ever reaching "completed", which is not what THIS test is about (landing eligibility
  // of an already-completed non-$0 plan). A real minimal file with an explicit `spendClass:
  // code-change` stamp keeps the cost gate's pass-through behaviour ($2 is under the default $5
  // ceiling) so the test still exercises what it says it does.
  const dir = mkdtempSync(join(tmpdir(), 'drain-landing-'));
  try {
    const rel = 'docs/superpowers/plans/ready/a.md';
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), '---\nspendClass: code-change\n---\n\n# a\n');
    let lands = 0;
    const r = await runDrain({
      phase: 3,
      mainDir: dir,
      oracle: scriptedOracle([P('a', { usd: 2, unknown: false })]),
      claim: () => {},
      runner: ok(),
      land: async () => {
        lands++;
        return { code: 0, stdout: '' };
      },
      mintCarryForwards: () => [],
      quarantine: () => {},
      persist: () => {},
    });
    assert.equal(lands, 0);
    assert.deepEqual(r.state.plans_landed, []);
    assert.deepEqual(r.state.plans_completed, ['a']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDrain landing: phase 2 never lands even when a land seam is wired', async () => {
  let lands = 0;
  const r = await runDrain({
    phase: 2,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    claim: () => {},
    runner: ok(),
    land: async () => {
      lands++;
      return { code: 0, stdout: '' };
    },
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(lands, 0);
  assert.equal(r.reason, 'phase2_paused_before_land');
});

test('runDrain: phase 2 with --workers 3 drains the whole queue (plan 518 semantics change)', async () => {
  const r = await runDrain({
    phase: 2,
    workers: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b'), P('c')]),
    claim: () => {},
    runner: ok(),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'phase2_paused_before_land');
  assert.equal(r.state.plans_completed.length, 3); // serial would have stopped after 'a'
});

// --- driver-side claim: ready/ → in-progress/ on master BEFORE the worker runs -

test('runDrain: claims the plan (ready→in-progress) BEFORE running it', async () => {
  const order = [];
  await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    claim: (p) => order.push(`claim:${p.slug}`),
    runner: async (p) => {
      order.push(`run:${p.slug}`);
      return { result: { status: 'completed', slug: p.slug }, spendUsd: 0 };
    },
    quarantine: () => {},
    persist: () => {},
  });
  // The folder-lock move must land before the worker is spawned — otherwise the
  // plan sits in ready/ during execution and a parallel session can double-pick.
  assert.deepEqual(order, ['claim:a', 'run:a']);
});

test('runDrain: a sketch block files to waiting-operator (NOT revert to ready/) and continues — plan 444', async () => {
  // Supersedes plan 363's sketch-revert-to-ready/: with continue (444), leaving the
  // plan in ready/ would let the oracle re-pick it → plan_not_advancing. So a sketch
  // block now files to waiting-operator/ (empty sha) and the loop keeps going.
  const operatored = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    claim: () => {},
    runner: async (p) => ({
      result: { status: 'blocked', slug: p.slug, notes: 'needs fan-out — nothing shipped' },
      spendUsd: 0,
    }),
    quarantineToOperator: (p, sha) => operatored.push(`${p.slug}@${sha}`),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'empty'); // continued past the block to queue-exhaustion
  // Filed to waiting-operator/ with an empty sha (sketch), NOT reverted to ready/.
  assert.deepEqual(operatored, ['a@']);
});

test('buildPlanPrompt: tells the worker the driver already claimed + moved it to in-progress', () => {
  const p = buildPlanPrompt(plan);
  assert.match(p, /in-progress/);
  assert.match(p, /already claimed|not a foreign|do NOT.*re-?claim/i);
});

// --- blocked classification: sketch/fan-out block vs work-pushed block (plan 363) -

test('blockedHasShippedWork: true only for a real shipped sha, not empty / sentinel / placeholder', () => {
  assert.equal(blockedHasShippedWork({ shipped_sha: 'ce3ce3e4' }), true);
  assert.equal(
    blockedHasShippedWork({ shipped_sha: 'ce3ce3e49f1a2b3c4d5e6f7081920304a5b6c7d8' }),
    true,
  );
  assert.equal(blockedHasShippedWork({ shipped_sha: '' }), false);
  assert.equal(blockedHasShippedWork({ shipped_sha: '   ' }), false);
  assert.equal(blockedHasShippedWork({ shipped_sha: null }), false);
  assert.equal(blockedHasShippedWork({}), false);
  assert.equal(blockedHasShippedWork({ shipped_sha: 'DRYRUN' }), false); // dry-run sentinel
  assert.equal(blockedHasShippedWork({ shipped_sha: 'none' }), false); // non-hex placeholder
  assert.equal(blockedHasShippedWork({ shipped_sha: 'n/a' }), false);
  assert.equal(blockedHasShippedWork(null), false);
});

test('runDrain: a work-pushed block files to waiting-operator (keeps worktree, not ready) and continues', async () => {
  const operatored = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    claim: () => {},
    runner: async (p) => ({
      result: {
        status: 'blocked',
        slug: p.slug,
        shipped_sha: 'ce3ce3e4',
        notes: 'blocked at A4 seed --apply operator checkpoint; code built + pushed',
      },
      spendUsd: 0,
    }),
    quarantineToOperator: (p, sha) => operatored.push(`${p.slug}@${sha}`),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'empty'); // continued past the block (444), not plan_blocked
  // Built + pushed work PRESERVED: in-progress/ → waiting-operator/, worktree kept, real sha in the note.
  assert.deepEqual(operatored, ['a@ce3ce3e4']);
  assert.deepEqual(r.state.plans_blocked, ['a']);
});

test('runDrain: ONE run parks a whole queue of apply-gated 🟥 plans (the 407→432→442 case — plan 444)', async () => {
  // The motivating scenario: three seed-write plans each build+push then block at
  // their own --apply gate. Before 444 this needed three launches (one halt each);
  // now one launch parks all three and the loop ends on queue-exhaustion.
  const operatored = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('407'), P('432'), P('442')]),
    claim: () => {},
    runner: async (p) => ({
      result: { status: 'blocked', slug: p.slug, shipped_sha: 'deadbeef', notes: 'apply gate' },
      spendUsd: 1,
    }),
    quarantineToOperator: (p, sha) => operatored.push(`${p.slug}@${sha}`),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'empty'); // all three parked in ONE run, no halt
  assert.deepEqual(r.state.plans_blocked, ['407', '432', '442']);
  assert.deepEqual(operatored, ['407@deadbeef', '432@deadbeef', '442@deadbeef']);
  assert.equal(r.state.cumulative_spend_usd, 3);
});

test('runDrain: the spend ceiling still bounds a continuing blocked queue (plan 444)', async () => {
  // Blocks no longer halt, so the spend ceiling is the bound on how many apply-gated
  // plans one run builds. Two $0.6 blocks → after the 2nd, $1.2 ≥ 1 → halt before the 3rd.
  const operatored = [];
  const r = await runDrain({
    phase: 3,
    ceiling: 1,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b'), P('c')]),
    claim: () => {},
    runner: async (p) => ({
      result: { status: 'blocked', slug: p.slug, shipped_sha: 'deadbeef', notes: 'apply gate' },
      spendUsd: 0.6,
    }),
    quarantineToOperator: (p, sha) => operatored.push(`${p.slug}@${sha}`),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'spend_ceiling'); // 0.6 + 0.6 = 1.2 ≥ 1 → halt before c
  assert.deepEqual(operatored, ['a@deadbeef', 'b@deadbeef']); // a + b parked; c never ran
});

test('buildPlanPrompt: distinguishes a work-pushed block (set shipped_sha → waiting-operator) from a sketch block', () => {
  const p = buildPlanPrompt(plan);
  assert.match(p, /work-pushed block/i);
  assert.match(p, /waiting-operator/i);
  assert.match(p, /shipped_sha/);
});

// --- carry-forward extraction: the Phase-3 mint (plan 388) -------------------

const MIXED_MANIFEST = [
  { kind: 'open-new-plan', title: 'Pin TZ at deploy', blurb: 'render.yaml TZ', seed_write: 'no' },
  { kind: 'waiting-operator', title: 'Operator approves seed apply', seed_write: 'yes' },
  { kind: 'wont-fix', title: 'Reformat that comment', seed_write: 'no' },
  {
    kind: 'open-new-plan',
    title: 'FAQ phone format',
    blurb: 'swedish formatter',
    seed_write: 'yes',
  },
];

test('mintableCarryForwards: only open-new-plan items with a title — no spurious mints', () => {
  const m = mintableCarryForwards(MIXED_MANIFEST);
  assert.deepEqual(
    m.map((c) => c.title),
    ['Pin TZ at deploy', 'FAQ phone format'],
  );
  // waiting-operator (already filed) + wont-fix (closed) must NOT mint.
  assert.equal(mintableCarryForwards([{ kind: 'waiting-operator', title: 'x' }]).length, 0);
  assert.equal(mintableCarryForwards([{ kind: 'wont-fix', title: 'x' }]).length, 0);
  // defensive: missing title / unknown kind / null / empty all → nothing minted.
  assert.equal(mintableCarryForwards([{ kind: 'open-new-plan' }]).length, 0);
  assert.equal(mintableCarryForwards([{ kind: 'bogus', title: 'x' }]).length, 0);
  assert.equal(mintableCarryForwards([null, undefined]).length, 0);
  assert.equal(mintableCarryForwards(null).length, 0);
  assert.equal(mintableCarryForwards(undefined).length, 0);
});

test('classifyCarryForwardKinds: buckets every kind (mint / already-filed / wont-fix / ignored)', () => {
  const c = classifyCarryForwardKinds([
    ...MIXED_MANIFEST,
    { kind: 'open-new-plan' }, // no title → ignored
    { kind: 'weird', title: 'y' }, // unknown → ignored
    null,
  ]);
  assert.equal(c.mint.length, 2);
  assert.equal(c.alreadyFiled.length, 1);
  assert.equal(c.wontFix.length, 1);
  assert.equal(c.ignored.length, 3); // no-title open-new-plan + unknown kind + null
});

test('carryForwardSlug: kebab-cases + bounds length; identical titles map to the same slug', () => {
  assert.equal(carryForwardSlug('Pin TZ at deploy'), 'pin-tz-at-deploy');
  assert.equal(carryForwardSlug('  Trailing/punctuation!!  '), 'trailing-punctuation');
  assert.equal(carryForwardSlug(''), 'carry-forward');
  assert.equal(carryForwardSlug(null), 'carry-forward');
  // same title → same slug (distinct NNN- id prefixes keep the files unique)
  assert.equal(carryForwardSlug('Pin TZ at deploy'), carryForwardSlug('Pin TZ at deploy'));
  // length-bounded to a sane filename segment (≤48 chars)
  const long = carryForwardSlug('a'.repeat(120));
  assert.ok(long.length <= 48, `slug too long: ${long.length}`);
});

// Fix round 1 (finding F — REGRESSION, key b7f489): mintCarryForwardPlans shells out to
// `move-plan.mjs <id> waiting-operator --blocked-by <this text>`, and the stub body itself
// carries `unblock: decision` (renderCarryForwardPlanBody), so that call runs through the new
// `assertBlockedByAxisTagOk` gate. Pre-fix, the text carried no `[axis: …]` marker and the gate
// refused it — the claimed/pushed `ready/` stub was then never moved, and never recorded.
test('carryForwardBlockedByText: passes the REAL waiting-operator/decision axis gate (finding F)', () => {
  const text = carryForwardBlockedByText({ slug: '372-Other-foo' }, '2026-06-06');
  assert.doesNotThrow(() => assertBlockedByAxisTagOk('waiting-operator', text, 'decision'));
  assert.match(text, /372-Other-foo/);
  assert.match(text, /2026-06-06/);
});

test('renderCarryForwardPlanBody: 🟩 stub carries banners, provenance, trip-condition; lint-clean', () => {
  const body = renderCarryForwardPlanBody(
    { kind: 'open-new-plan', title: 'Pin TZ at deploy', blurb: 'render.yaml TZ', seed_write: 'no' },
    { parentSlug: '372-Other-foo', date: '2026-06-06' },
  );
  assert.match(body, new RegExp(`${MUTATION_BANNER_LABEL}: NO`));
  assert.match(body, /# Pin TZ at deploy/);
  assert.match(body, /372-Other-foo/); // provenance back-link to the parent plan
  assert.match(body, /## Trip-condition/);
  assert.match(body, /\*\*Follow-up:\*\* render\.yaml TZ/);
  // The brief ready/ window must be cost-lint-clean: parsePlanMeta (the same parser
  // the drain + lint-plan-cost-forecast use) must read a parseable, non-unknown cost.
  const meta = parsePlanMeta('999-Other-pin-tz-at-deploy.md', body);
  assert.equal(meta.cost.unknown, false);
  assert.equal(meta.seedWrite, 'no');
  // SAFETY (defense-in-depth): even if a mint half-fails and strands the stub in
  // ready/, the oracle must NOT auto-execute it — the body's operator-gate phrase
  // makes parsePlanMeta exclude it as operator-gated.
  assert.equal(meta.exclude, 'operator');
  // plan 2587: the body carries its OWN **Status:** line, so next-plan-id's
  // ensureReadyStatusLine heal leaves it alone while ensureStageFrontmatter still stamps
  // `stage: stub` — a `📋 READY` token here would be the exact stage/Status contradiction
  // board-write-gate's `stage-status-prose` check refuses, bricking the drain's own
  // carry-forward mint. The token must agree with the stamp the mint will write.
  assert.match(body, /\*\*Status:\*\* 📋 STUB — auto-extracted by the autonomous drain/);
  assert.doesNotMatch(body, /\*\*Status:\*\* 📋 READY/);
});

test('renderCarryForwardPlanBody: 🟥 stub flips the SEED-WRITE banner', () => {
  const body = renderCarryForwardPlanBody(
    { kind: 'open-new-plan', title: 'FAQ phone format', seed_write: 'yes' },
    { parentSlug: '380-Other-bar', date: '2026-06-06' },
  );
  assert.match(body, new RegExp(`${MUTATION_BANNER_LABEL}: YES`));
  const meta = parsePlanMeta('999-Other-faq.md', body);
  assert.equal(meta.seedWrite, 'yes');
  assert.equal(meta.cost.unknown, false);
});

// plan 3960 cluster-2 review fix: renderCarryForwardPlanBody used to hardcode the "SEED-WRITE"
// literal even after SEED_BANNER_ANCHOR_RX (build-index-lib.mjs) was made to read
// mutationBanner.label — so a repo configuring a different label would still get an UNPARSEABLE
// stub (its own SEED_BANNER_ANCHOR_RX would never match the hardcoded old name). Proven with a
// REAL isolated repo, not this file's already-loaded (vetapp-default) module instance.
const makeCoordLabelRepo = isolatedRepoFactory({
  prefix: 'drain-label-iso',
  basename: '900-Coord-label-plan.md',
  body: '---\nsummary: plan 3960 cluster-2 label fixture\n---\n\n# 900-Coord-label-plan\n',
});

test('renderCarryForwardPlanBody: a configured mutationBanner.label is what the stub banner actually carries (cluster-2 review fix)', () => {
  const repo = makeCoordLabelRepo();
  try {
    writeFileSync(
      join(repo.dir, 'coord.config.json'),
      JSON.stringify({ mutationBanner: { label: 'DATA-WRITE' } }),
    );
    // A real PROBE SCRIPT FILE (not `-e`) — drain-run.mjs's own CLI main is guarded by
    // `process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href` (its own
    // self-invocation check), which a `-e` invocation naming drain-run.mjs's path as argv[1]
    // (the plan-3960 T3 pattern used for the fs-/git-free build-index-lib.mjs) would trip,
    // running the WHOLE drain instead of just importing the module for its export.
    const probePath = join(repo.dir, 'probe.mjs');
    const drainRunUrl = pathToFileURL(repo.toolPath('drain-run.mjs')).href;
    writeFileSync(
      probePath,
      [
        `import { renderCarryForwardPlanBody } from ${JSON.stringify(drainRunUrl)};`,
        'const body = renderCarryForwardPlanBody(',
        "  { kind: 'open-new-plan', title: 'x', seed_write: 'yes' },",
        "  { parentSlug: '380-Other-bar', date: '2026-06-06' },",
        ');',
        'process.stdout.write(JSON.stringify({',
        "  hasConfiguredLabel: body.includes('DATA-WRITE: YES'),",
        "  hasOldLabel: body.includes('SEED-WRITE'),",
        '}));',
      ].join('\n'),
    );
    const probe = spawnSync(process.execPath, [probePath], { cwd: repo.dir, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const result = JSON.parse(probe.stdout.trim());
    assert.equal(result.hasConfiguredLabel, true);
    assert.equal(result.hasOldLabel, false);
  } finally {
    repo.cleanup();
  }
});

test('recordFiledCarryForwards: immutable append of minted basenames', () => {
  const s0 = emptyState();
  const s1 = recordFiledCarryForwards(s0, ['405-Other-a', '406-Other-b']);
  assert.deepEqual(s1.carry_forwards_filed, ['405-Other-a', '406-Other-b']);
  assert.deepEqual(s0.carry_forwards_filed, []); // input untouched
  const s2 = recordFiledCarryForwards(s1, ['407-Other-c']);
  assert.deepEqual(s2.carry_forwards_filed, ['405-Other-a', '406-Other-b', '407-Other-c']);
});

// --- skip-list (plan 443) ----------------------------------------------------

test('emptyState carries an empty plans_skipped list', () => {
  assert.deepEqual(emptyState().plans_skipped, []);
});

test('recordSkipped: dedupes by slug, keeps latest reason, immutable', () => {
  const s0 = emptyState();
  const s1 = recordSkipped(s0, [
    { slug: '437-UI-x', exclude: 'operator', reason: 'operator-interactive: google flow' },
    { slug: '438-DQ-x', exclude: 'operator', reason: 'operator-interactive: claude-in-chrome' },
  ]);
  assert.deepEqual(
    s1.plans_skipped.map((p) => p.slug),
    ['437-UI-x', '438-DQ-x'],
  );
  assert.deepEqual(s0.plans_skipped, []); // input untouched
  // Re-seeing 437 next iteration updates in place (no duplicate row).
  const s2 = recordSkipped(s1, [
    { slug: '437-UI-x', exclude: 'operator', reason: 'operator-interactive: updated' },
  ]);
  assert.equal(s2.plans_skipped.length, 2);
  assert.equal(
    s2.plans_skipped.find((p) => p.slug === '437-UI-x').reason,
    'operator-interactive: updated',
  );
});

test('recordSkipped: empty/absent excluded is a no-op (same ref)', () => {
  const s0 = emptyState();
  assert.equal(recordSkipped(s0, []), s0);
  assert.equal(recordSkipped(s0, undefined), s0);
});

test('runDrain: folds the oracle excluded set into state.plans_skipped (plan 443)', async () => {
  // Oracle yields one runnable plan, then empty — both calls carry the same
  // operator-input exclusion. The driver must continue past it AND report it.
  let i = 0;
  const oracle = () => {
    const excluded = [
      { slug: '437-UI-x', exclude: 'operator', reason: 'operator-interactive: google flow' },
    ];
    return i++ === 0 ? { next: P('435-x'), excluded } : { reason: 'empty', excluded };
  };
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle,
    runner: ok({ spendUsd: 0 }),
    mintCarryForwards: () => [],
    quarantine: () => {},
    claim: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'empty');
  assert.deepEqual(r.state.plans_completed, ['435-x']); // ran the eligible plan
  assert.equal(r.state.plans_skipped.length, 1); // ...and reported the skip once (deduped)
  assert.equal(r.state.plans_skipped[0].slug, '437-UI-x');
  assert.match(r.state.plans_skipped[0].reason, /operator-interactive/);
});

// --- runDrain loop: mint wiring ---------------------------------------------

test('runDrain: phase 3 mints open-new-plan carry-forwards AFTER the driver lands (plan 518)', async () => {
  // REWRITTEN from mint-on-complete: under the parallel-drain design the worker
  // never lands; the DRIVER lands $0 plans via the spine and mints only after a
  // successful land. With no land seam (or a parked land) nothing mints — the
  // manifest stays in drain-state.json for the operator.
  const seen = [];
  const order = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    runner: ok({ carry_forward: MIXED_MANIFEST }),
    claim: () => {},
    land: async (p) => {
      order.push(`land:${p.slug}`);
      return { code: 0, stdout: 'landed' };
    },
    mintCarryForwards: (p, cf) => {
      order.push(`mint:${p.slug}`);
      seen.push({ slug: p.slug, cf });
      // simulate the real minter: returns the minted basenames for the 2 open-new-plan items
      return mintableCarryForwards(cf).map((c, i) => `40${i}-Other-${carryForwardSlug(c.title)}`);
    },
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'empty');
  assert.deepEqual(order, ['land:a', 'mint:a']); // mint strictly AFTER the land
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].cf, MIXED_MANIFEST); // the WHOLE manifest is handed to the minter
  assert.deepEqual(r.state.plans_landed, ['a']);
  // exactly the 2 open-new-plan items were filed — no spurious plans for waiting-operator/wont-fix
  assert.deepEqual(r.state.carry_forwards_filed, [
    '400-Other-pin-tz-at-deploy',
    '401-Other-faq-phone-format',
  ]); // i is the mintable-array index here (0,1), so no -2 suffix
});

test('runDrain: phase 3 with NO land seam mints nothing (landing disabled — unit/test default)', async () => {
  let minted = 0;
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    runner: ok({ carry_forward: MIXED_MANIFEST }),
    claim: () => {},
    mintCarryForwards: () => {
      minted++;
      return [];
    },
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'empty');
  assert.equal(minted, 0); // no land → no mint; manifest still recorded in state
  assert.equal(r.state.carry_forwards.length, MIXED_MANIFEST.length);
});

test('runDrain: phase 2 completed does NOT mint (operator lands later)', async () => {
  let called = 0;
  const r = await runDrain({
    phase: 2,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    runner: ok({ carry_forward: MIXED_MANIFEST }),
    mintCarryForwards: () => {
      called++;
      return [];
    },
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'phase2_paused_before_land');
  assert.equal(called, 0); // phase 2 pauses before the land — minting belongs to the lander
  assert.deepEqual(r.state.carry_forwards_filed, []);
});

test('runDrain: gate_failed / blocked do NOT mint carry-forwards', async () => {
  let called = 0;
  await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b')]),
    runner: async (p) =>
      p.slug === 'a'
        ? {
            result: { status: 'gate_failed', slug: p.slug, carry_forward: MIXED_MANIFEST },
            spendUsd: 0,
          }
        : {
            result: { status: 'blocked', slug: p.slug, carry_forward: MIXED_MANIFEST },
            spendUsd: 0,
          },
    mintCarryForwards: () => {
      called++;
      return [];
    },
    claim: () => {},
    quarantine: () => {},
    quarantineToOperator: () => {},
    persist: () => {},
  });
  // a gate_failed plan is quarantined and a blocked plan is parked to waiting-operator —
  // neither is a completed land, so its carry-forwards are NOT minted by the driver.
  assert.equal(called, 0);
});

// --- repathPlanClaimCell / repathBoardRow (plan 422) -------------------------

const SLUG_422 = '422-Infra-drain-work-pushed-block-board-repath';

test('repathPlanClaimCell: swaps an existing subfolder prefix, leaving the rest intact', () => {
  const cell = `\`in-progress/${SLUG_422}.md\` · session 399 · host=\`T2021896\` · 🟩 NON-SEED`;
  assert.equal(
    repathPlanClaimCell(cell, SLUG_422, 'waiting-operator'),
    `\`waiting-operator/${SLUG_422}.md\` · session 399 · host=\`T2021896\` · 🟩 NON-SEED`,
  );
});

test('repathPlanClaimCell: prefixes a bare <slug>.md token', () => {
  assert.equal(
    repathPlanClaimCell(`\`${SLUG_422}.md\` · session 399`, SLUG_422, 'ready'),
    `\`ready/${SLUG_422}.md\` · session 399`,
  );
});

test('repathPlanClaimCell: swaps a pending-approval/ prefix (plan 1371 taxonomy)', () => {
  const cell = `\`pending-approval/${SLUG_422}.md\` · session 399`;
  assert.equal(
    repathPlanClaimCell(cell, SLUG_422, 'ready'),
    `\`ready/${SLUG_422}.md\` · session 399`,
  );
});

test('repathPlanClaimCell: swaps a parked/ prefix (plan 1426)', () => {
  // parked/ is in BOARD_SUBFOLDER_GROUP so a stale board row survives an un-park
  // (parked/ → any lane) repath, even though the drain itself never claims from
  // or lands into parked/.
  const cell = `\`parked/${SLUG_422}.md\` · session 399`;
  assert.equal(
    repathPlanClaimCell(cell, SLUG_422, 'ready'),
    `\`ready/${SLUG_422}.md\` · session 399`,
  );
});

test('repathPlanClaimCell: a retired drafting/ prefix is NOT recognized as a known subfolder', () => {
  // drafting/ is retired from BOARD_SUBFOLDER_GROUP (plan 1371 D5) — a stray legacy
  // cell carrying it should be left alone rather than silently swapped, since it is
  // no longer a matcher target.
  const cell = `\`drafting/${SLUG_422}.md\` · session 399`;
  assert.equal(repathPlanClaimCell(cell, SLUG_422, 'ready'), cell);
});

test('repathPlanClaimCell: no-op when already at the target subfolder', () => {
  const cell = `\`waiting-operator/${SLUG_422}.md\` · session 399`;
  assert.equal(repathPlanClaimCell(cell, SLUG_422, 'waiting-operator'), cell);
});

test('repathPlanClaimCell: leaves an unrelated slug untouched', () => {
  const cell = `\`in-progress/999-Other-unrelated.md\` · session 1`;
  assert.equal(repathPlanClaimCell(cell, SLUG_422, 'waiting-operator'), cell);
});

test('repathPlanClaimCell: does not mangle a dotted prose mention of the slug', () => {
  // A `.`-prefixed mention (not a real path) must NOT get a subfolder spliced
  // in mid-token — the bare-branch lookbehind excludes a preceding dot.
  const cell = `see note.${SLUG_422}.md (not a path) · session 1`;
  assert.equal(repathPlanClaimCell(cell, SLUG_422, 'waiting-operator'), cell);
});

// plan 1447 drift guard: BOARD_SUBFOLDER_GROUP is now DERIVED from build-index-lib's
// PLAN_FOLDER_ALT instead of a hand-listed literal (its alternation order also changed —
// see build-index-lib.mjs's ALL_PLAN_FOLDERS comment for why that's harmless). BEHAVIORAL
// equivalence, not textual string equality, is the meaningful guard here: every folder in
// ALL_PLAN_FOLDERS must still be recognized as a swappable old-subfolder prefix.
test('repathPlanClaimCell recognizes EVERY ALL_PLAN_FOLDERS entry as a swappable prefix (plan 1447 drift guard)', () => {
  for (const folder of ALL_PLAN_FOLDERS) {
    const target = folder === 'ready' ? 'in-progress' : 'ready';
    const cell = `\`${folder}/${SLUG_422}.md\` · session 399`;
    assert.equal(
      repathPlanClaimCell(cell, SLUG_422, target),
      `\`${target}/${SLUG_422}.md\` · session 399`,
      `folder "${folder}" was not recognized as a swappable prefix`,
    );
  }
});

// Behavioral (not textual) parity check against the ORIGINAL hand-listed BOARD_SUBFOLDER_GROUP
// string (kept here as a plain string literal, never re-imported from drain-run.mjs) — the old
// alternation order must produce the SAME repathPlanClaimCell results as the new
// PLAN_FOLDER_ALT-derived construction, for a representative matrix of cells.
test('repathPlanClaimCell behaves identically to the pre-1447 hand-listed BOARD_SUBFOLDER_GROUP', () => {
  const OLD_GROUP =
    'in-progress|ready|pending-approval|waiting-blocked|waiting-date|waiting-trip|waiting-operator|archive|parked';
  const oldRepath = (cell, slug, toSubfolder) => {
    const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefixed = new RegExp(`(?:${OLD_GROUP})/(${esc}\\.md)`, 'g');
    const swapped = cell.replace(prefixed, `${toSubfolder}/$1`);
    if (swapped !== cell) return swapped;
    const bare = new RegExp(`(?<![\\w/.-])(${esc}\\.md)`, 'g');
    return cell.replace(bare, `${toSubfolder}/$1`);
  };
  const cases = [
    ['in-progress', 'ready'],
    ['ready', 'in-progress'],
    ['pending-approval', 'ready'],
    ['waiting-blocked', 'ready'],
    ['waiting-operator', 'ready'],
    ['waiting-date', 'ready'],
    ['waiting-trip', 'ready'],
    ['archive', 'ready'],
    ['parked', 'ready'],
  ];
  for (const [fromSubfolder, toSubfolder] of cases) {
    const cell = `\`${fromSubfolder}/${SLUG_422}.md\` · session 399`;
    assert.equal(
      repathPlanClaimCell(cell, SLUG_422, toSubfolder),
      oldRepath(cell, SLUG_422, toSubfolder),
      `mismatch for ${fromSubfolder} → ${toSubfolder}`,
    );
  }
  // bare-token (no subfolder prefix) case too — exercises the fallback branch identically.
  const bareCell = `\`${SLUG_422}.md\` · session 399`;
  assert.equal(
    repathPlanClaimCell(bareCell, SLUG_422, 'ready'),
    oldRepath(bareCell, SLUG_422, 'ready'),
  );
});

const boardWith = (slug, planClaim, state = '⏸ PAUSED') =>
  [
    'intro narration',
    '<!-- BOARD-START -->',
    '',
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    `| ${slug} | \`abc1234\` | ${state} | ${planClaim} | 2026-06-07 | resume |`,
    '<!-- BOARD-END -->',
    '',
  ].join('\n');

test('repathBoardRow: no board file → no-op, never calls update', () => {
  let calls = 0;
  const r = repathBoardRow('/x', '/scripts', SLUG_422, 'waiting-operator', {
    readBoard: () => null,
    runUpdate: () => calls++,
  });
  assert.deepEqual(r, { repathed: false, reason: 'no-board' });
  assert.equal(calls, 0);
});

test('repathBoardRow: no matching row → no-op (claim-time / sketch-block case)', () => {
  let calls = 0;
  const r = repathBoardRow('/x', '/scripts', SLUG_422, 'waiting-operator', {
    readBoard: () => boardWith('some-other-plan', '`in-progress/some-other-plan.md`'),
    runUpdate: () => calls++,
  });
  assert.deepEqual(r, { repathed: false, reason: 'no-row' });
  assert.equal(calls, 0);
});

test('repathBoardRow: already at target subfolder → no-op', () => {
  let calls = 0;
  const r = repathBoardRow('/x', '/scripts', SLUG_422, 'waiting-operator', {
    readBoard: () => boardWith(SLUG_422, `\`waiting-operator/${SLUG_422}.md\` · session 399`),
    runUpdate: () => calls++,
  });
  assert.deepEqual(r, { repathed: false, reason: 'already-correct' });
  assert.equal(calls, 0);
});

test('repathBoardRow: in-progress row + move to waiting-operator → calls update with repathed cell', () => {
  const captured = [];
  const r = repathBoardRow('/x', '/scripts', SLUG_422, 'waiting-operator', {
    readBoard: () => boardWith(SLUG_422, `\`in-progress/${SLUG_422}.md\` · session 399 · 🟩`),
    runUpdate: (s, c) => captured.push([s, c]),
  });
  assert.equal(r.repathed, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0][0], SLUG_422);
  assert.equal(captured[0][1], `\`waiting-operator/${SLUG_422}.md\` · session 399 · 🟩`);
});

test('repathBoardRow: swallows a benign row-vanish race (board.mjs row-not-found)', () => {
  // The row existed in our local read but board.mjs's fresh pull no longer sees
  // it (a parallel done-worktree removed it). The update throws row-not-found;
  // repathBoardRow swallows it instead of crashing the drain post-move.
  const r = repathBoardRow('/x', '/scripts', SLUG_422, 'waiting-operator', {
    readBoard: () => boardWith(SLUG_422, `\`in-progress/${SLUG_422}.md\` · session 399`),
    runUpdate: () => {
      throw Object.assign(new Error('board.mjs failed'), {
        stderr: 'board: board-lib: row not found for slug "..."',
      });
    },
  });
  assert.deepEqual(r, { repathed: false, reason: 'row-vanished' });
});

test('repathBoardRow: re-throws a non-row-not-found board.mjs failure', () => {
  assert.throws(
    () =>
      repathBoardRow('/x', '/scripts', SLUG_422, 'waiting-operator', {
        readBoard: () => boardWith(SLUG_422, `\`in-progress/${SLUG_422}.md\` · session 399`),
        runUpdate: () => {
          throw Object.assign(new Error('push rejected'), { stderr: 'fatal: non-fast-forward' });
        },
      }),
    /push rejected/,
  );
});

// --- driver-side board row at claim time (plan 506) --------------------------

const SLUG_506 = '506-Infra-drain-worker-board-row-lint-clean';
const PLAN_506 = (seedWrite) => ({
  slug: SLUG_506,
  path: `docs/superpowers/plans/ready/${SLUG_506}.md`,
  seedWrite,
  cost: { usd: 0, unknown: false },
});
const rowFrom506 = (cell, state = '🔄 ACTIVE') => [
  { cells: [SLUG_506, '`PENDING`', state, cell, '2026-06-10', '—'], raw: '' },
];
const BASENAMES_506 = new Map([[`${SLUG_506}.md`, [`in-progress/${SLUG_506}.md`]]]);

test('buildClaimPlanCell: backticked in-progress path + host + seed marker', () => {
  const cell = buildClaimPlanCell(PLAN_506('no'), 'T2020188');
  assert.match(cell, new RegExp(`\`in-progress/${SLUG_506}\\.md\``));
  assert.match(cell, /host=`T2020188`/);
  assert.match(cell, /drain worker \(plan-231\)/);
  assert.match(cell, /🟩/);
});

test('buildClaimPlanCell: seed marker is 🟩 only for an explicit "no" — yes/unknown/missing are 🟥', () => {
  assert.match(buildClaimPlanCell(PLAN_506('no'), 'h'), /🟩/);
  assert.match(buildClaimPlanCell(PLAN_506('yes'), 'h'), /🟥/);
  assert.match(buildClaimPlanCell(PLAN_506('unknown'), 'h'), /🟥/); // oracle's null-banner shape
  assert.match(buildClaimPlanCell(PLAN_506(undefined), 'h'), /🟥/);
});

test('buildClaimPlanCell: the template cell passes lint-board validateRows (NO_PLAN_REF + subfolder)', () => {
  const cell = buildClaimPlanCell(PLAN_506('no'), 'BUILD-HOST-01');
  assert.deepEqual(validateRows(rowFrom506(cell), BASENAMES_506), []);
});

// plan 3960 review fix (finding 22): buildClaimPlanCell used to hardcode the literal
// `in-progress/<slug>.md` cell text even though claimPlan (drain-run.mjs) moves the file to the
// CONFIGURED IN_PROGRESS_FOLDER — a `lanes.inProgress` rename (e.g. to `active`) made claimPlan
// move the file to `active/<slug>.md` while this cell kept naming `in-progress/<slug>.md`,
// deterministically writing a nonexistent path into the board's Plan/claim cell. Proven with a
// REAL isolated repo (a fresh module graph, per this file's own cluster-2 precedent above) whose
// coord.config.json renames the lane — this test file's own already-imported buildClaimPlanCell
// is vetapp's own unconfigured instance and would trivially pass without proving anything.
test('buildClaimPlanCell: a configured lanes.inProgress rename is what the cell actually names (review fix)', () => {
  const repo = makeCoordLabelRepo();
  try {
    writeFileSync(
      join(repo.dir, 'coord.config.json'),
      JSON.stringify({ lanes: { inProgress: 'active' } }),
    );
    // A real probe SCRIPT FILE (not `-e`) — see the cluster-2 test above for why: drain-run.mjs's
    // own CLI main is guarded by a `process.argv[1] === import.meta.url` self-invocation check.
    const probePath = join(repo.dir, 'probe.mjs');
    const drainRunUrl = pathToFileURL(repo.toolPath('drain-run.mjs')).href;
    writeFileSync(
      probePath,
      [
        `import { buildClaimPlanCell } from ${JSON.stringify(drainRunUrl)};`,
        "const cell = buildClaimPlanCell({ slug: '9700-Infra-x', seedWrite: 'no' }, 'h');",
        'process.stdout.write(JSON.stringify({',
        "  namesConfiguredFolder: cell.includes('`active/9700-Infra-x.md`'),",
        "  namesOldFolder: cell.includes('in-progress/9700-Infra-x.md'),",
        '}));',
      ].join('\n'),
    );
    const probe = spawnSync(process.execPath, [probePath], { cwd: repo.dir, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const result = JSON.parse(probe.stdout.trim());
    assert.equal(result.namesConfiguredFolder, true);
    assert.equal(result.namesOldFolder, false);
  } finally {
    repo.cleanup();
  }
});

test('lint-board: the plan-479 incident cell (free-form, no filename) fails NO_PLAN_REF — the bug this closes', () => {
  // Verbatim shape of the 2026-06-10 incident: slug + prose, no `.md` reference.
  const incidentCell = '479-INTL-norway-frontend-localization (drain worker, host T2020188)';
  const errors = validateRows(rowFrom506(incidentCell), BASENAMES_506);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'NO_PLAN_REF');
});

test('verifyBoardRowLintClean: clean row passes; poisoned cell throws naming the finding', () => {
  const board = (cell) => boardWith(SLUG_506, cell, '🔄 ACTIVE'); // reuses the sentinel-framed board fixture
  const clean = buildClaimPlanCell(PLAN_506('no'), 'h');
  assert.doesNotThrow(() =>
    verifyBoardRowLintClean('/x', SLUG_506, {
      readBoard: () => board(clean),
      basenames: BASENAMES_506,
    }),
  );
  assert.throws(
    () =>
      verifyBoardRowLintClean('/x', SLUG_506, {
        readBoard: () => board('free-form prose, no plan filename'),
        basenames: BASENAMES_506,
      }),
    /NO_PLAN_REF/,
  );
});

test('verifyBoardRowLintClean: missing board / missing row throw loudly', () => {
  assert.throws(
    () => verifyBoardRowLintClean('/x', SLUG_506, { readBoard: () => null }),
    /not found/,
  );
  assert.throws(
    () =>
      verifyBoardRowLintClean('/x', SLUG_506, {
        readBoard: () => boardWith('some-other-slug', '`in-progress/some-other-slug.md`'),
        basenames: BASENAMES_506,
      }),
    /row for 506-.*not found/,
  );
});

test('writeClaimBoardRow: claims with the template cell, then verifies', () => {
  const calls = [];
  const r = writeClaimBoardRow('/x', '/scripts', PLAN_506('no'), '2026-06-10', {
    host: 'T2020188',
    hasBoard: true,
    runClaim: (slug, cell) => calls.push(['claim', slug, cell]),
    verify: () => calls.push(['verify']),
  });
  assert.equal(r.written, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['claim', SLUG_506, buildClaimPlanCell(PLAN_506('no'), 'T2020188')]);
  assert.deepEqual(calls[1], ['verify']); // lint check runs AFTER the write (plan 506 T2)
});

test('writeClaimBoardRow: a verify failure removes the poisoned row then rethrows — never left for siblings', () => {
  const removed = [];
  assert.throws(
    () =>
      writeClaimBoardRow('/x', '/scripts', PLAN_506('no'), '2026-06-10', {
        host: 'h',
        hasBoard: true,
        runClaim: () => {},
        runRemove: (slug) => removed.push(slug),
        verify: () => {
          throw new Error('NO_PLAN_REF: poisoned');
        },
      }),
    /NO_PLAN_REF/,
  );
  assert.deepEqual(removed, [SLUG_506]);
});

test('writeClaimBoardRow: no handoff-board.md (legacy project) → no-op, never claims', () => {
  let calls = 0;
  const r = writeClaimBoardRow('/x', '/scripts', PLAN_506('no'), '2026-06-10', {
    hasBoard: false,
    runClaim: () => calls++,
  });
  assert.deepEqual(r, { written: false, reason: 'no-board' });
  assert.equal(calls, 0);
});

test('buildPlanPrompt: worker is told its board row exists and must NEVER compose the Plan/claim cell (plan 506)', () => {
  // Single unconditional prompt since plan 518 (the old test looped phase 2/3;
  // phase no longer exists in the prompt).
  const p = buildPlanPrompt(plan);
  assert.match(p, /wrote your ACTIVE board row/i); // driver-side write announced
  assert.match(p, /set-state/); // the sanctioned state-flip path
  assert.match(p, /never --plan-claim/i); // the cell is driver-owned
  assert.match(p, /NO_PLAN_REF/); // the failure mode is named, not implied
  // The old instruction — the root cause — must be gone: the worker no longer
  // writes its own board row at all.
  assert.doesNotMatch(p, /write your handoff session entry \+ board row/);
});

// Acceptance: the BOARD_SUBFOLDER_DRIFT repro clears after the repath, for each
// of the three drain move targets (waiting-operator = quarantine / work-pushed
// block, ready = revert claim, in-progress = claim).
for (const toSubfolder of ['waiting-operator', 'ready', 'in-progress']) {
  test(`lint-board: BOARD_SUBFOLDER_DRIFT clears after repath to ${toSubfolder}`, () => {
    const from = toSubfolder === 'in-progress' ? 'ready' : 'in-progress';
    const byBasename = new Map([[`${SLUG_422}.md`, [`${toSubfolder}/${SLUG_422}.md`]]]);
    const beforeCell = `\`${from}/${SLUG_422}.md\` · session 1`;
    const rowFrom = (cell) => [{ cells: [SLUG_422, '`abc`', '⏸ PAUSED', cell, 'd', 'r'] }];

    const drift = validateRows(rowFrom(beforeCell), byBasename);
    assert.equal(drift.length, 1);
    assert.equal(drift[0].kind, 'BOARD_SUBFOLDER_DRIFT');

    const afterCell = repathPlanClaimCell(beforeCell, SLUG_422, toSubfolder);
    assert.equal(validateRows(rowFrom(afterCell), byBasename).length, 0);
  });
}

// --- foreign-dirt resilience (plan 618) --------------------------------------
// A coordWrite refusal from a sibling session's transient uncommitted edit in the
// shared main checkout must NOT crash the drain (the 2026-06-14 exit-2 class).

// The exact assertCleanOutsidePathspec refusal text, as it reaches the driver via a
// board.mjs subprocess (execFileSync surfaces it on the thrown error's message).
const foreignDirtError = () =>
  new Error(
    'coordWrite(board): refusing to run — the main checkout has uncommitted changes to ' +
      "tracked file(s) OUTSIDE this tool's pathspec:\n  M handoff/sessions/2026-06-14-session-537.md",
  );
const noSleep = { sleep: () => {}, backoff: () => 0, log: () => {} };

test('retryOnForeignDirt: retries on foreign-dirt then succeeds', () => {
  let calls = 0;
  const out = retryOnForeignDirt(
    () => {
      calls++;
      if (calls < 3) throw foreignDirtError();
      return 'ok';
    },
    { attempts: 6, ...noSleep },
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
});

test('retryOnForeignDirt: a non-foreign-dirt error propagates immediately (no retry)', () => {
  let calls = 0;
  assert.throws(
    () =>
      retryOnForeignDirt(
        () => {
          calls++;
          throw new Error('non-fast-forward [rejected]');
        },
        { attempts: 6, ...noSleep },
      ),
    /non-fast-forward/,
  );
  assert.equal(calls, 1); // surfaced on the first attempt, never retried
});

test('retryOnForeignDirt: budget exhaustion throws a coordContention-tagged error', () => {
  let calls = 0;
  try {
    retryOnForeignDirt(
      () => {
        calls++;
        throw foreignDirtError();
      },
      { attempts: 3, ...noSleep },
    );
    assert.fail('expected throw');
  } catch (e) {
    assert.equal(e.coordContention, true);
    assert.match(e.message, /after 3 attempts/);
    assert.equal(calls, 3); // tried exactly the budget, then gave up
  }
});

test('runDrain: a coordContention claim stops CLEANLY (coord_contention), never exit 2', async () => {
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('203-x'), P('210-x')]),
    runner: ok(),
    // Simulate the claim's board write exhausting the foreign-dirt retry budget.
    claim: () => {
      throw Object.assign(new Error('drain-run: board claim … after 6 attempts'), {
        coordContention: true,
      });
    },
    persist: () => {},
  });
  assert.equal(r.reason, 'coord_contention');
  // It stopped before running anything — no plan completed, no crash.
  assert.deepEqual(r.state.plans_completed, []);
});

test('runDrain: a coordContention from foldOutcome (park/quarantine) stops CLEANLY too', async () => {
  // A gate_failed outcome routes foldOutcome → quarantine(plan); if THAT board
  // write exhausts the foreign-dirt budget the fold throws coordContention. The
  // FILL-loop fold catch must convert it to a clean stop, not crash.
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('203-x'), P('210-x')]),
    runner: async (p) => ({ result: { status: 'gate_failed', slug: p.slug }, spendUsd: 0 }),
    claim: () => {},
    quarantine: () => {
      throw Object.assign(new Error('drain-run: board update … after 6 attempts'), {
        coordContention: true,
      });
    },
    persist: () => {},
  });
  assert.equal(r.reason, 'coord_contention');
});

// --- board-lint claim refusal: park-and-continue (plan 817) ------------------
// A malformed plan slug (lowercase category, e.g. `811-price-…`) makes board.mjs's
// write-time cell lint REFUSE the worker's "Plan / claim" cell with NO_PLAN_REF. That
// refusal propagates out of claimPlan; pre-817 it crashed the whole drain (exit 2) and
// abandoned the in-flight workers. The driver must classify it (isBoardLintRefusal),
// park the offending plan to waiting-operator/, and KEEP draining. Distinct from the
// foreign-dirt refusal (transient, retried) — this one is deterministic, so no retry.

test('isBoardLintRefusal: matches a board.mjs NO_PLAN_REF cell-lint refusal, not foreign-dirt', () => {
  // board.mjs assertCellLintClean write-time refusal (the 2026-06-18 crash shape).
  assert.ok(
    isBoardLintRefusal(
      new Error(
        'refusing to write a lint-poisoned "Plan / claim" cell for 811-price-x ' +
          '(it would block every sibling push at lint-board):\n  [NO_PLAN_REF] expected NNN-[A-Z]…',
      ),
    ),
  );
  // verifyBoardRowLintClean's post-write variant — surfaced via a subprocess stderr.
  assert.ok(
    isBoardLintRefusal({
      stderr: 'drain-run: just-written board row fails lint-board: [NO_PLAN_REF] …',
    }),
  );
  // A foreign-dirt refusal is a DIFFERENT (transient) class — must NOT match.
  assert.ok(!isBoardLintRefusal(foreignDirtError()));
  // A plain non-ff push rejection is neither.
  assert.ok(!isBoardLintRefusal(new Error('non-fast-forward [rejected]')));
  // A lint-board error of a non-NO_PLAN_REF kind (e.g. subfolder drift) is not this class.
  assert.ok(!isBoardLintRefusal(new Error('fails lint-board: [BOARD_SUBFOLDER_DRIFT] …')));
});

test('runDrain: a board-lint NO_PLAN_REF claim refusal PARKS the malformed plan and CONTINUES (plan 817)', async () => {
  const ran = [];
  const parked = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('811-price-x'), P('812-Infra-y')]),
    runner: async (p) => {
      ran.push(p.slug);
      return { result: { status: 'completed', slug: p.slug }, spendUsd: 0 };
    },
    // The malformed plan's claim hits board.mjs's write-time NO_PLAN_REF refusal; the
    // well-formed plan claims fine. (The real claimPlan moves the file to in-progress/
    // before the board write throws — parkBoardLint sources from there.)
    claim: (p) => {
      if (p.slug === '811-price-x') {
        throw new Error(
          'refusing to write a lint-poisoned "Plan / claim" cell for 811-price-x ' +
            '(it would block every sibling push at lint-board):\n  [NO_PLAN_REF] …',
        );
      }
    },
    parkBoardLint: (p) => parked.push(p.slug),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'empty'); // the run drained to the end — NEVER crashed (no exit 2)
  assert.deepEqual(parked, ['811-price-x']); // the malformed plan was parked, not run
  assert.deepEqual(ran, ['812-Infra-y']); // it never spawned a worker; the next plan ran
  // The closing SKIPPED list names the parked plan with the board_lint reason.
  const skip = r.state.plans_skipped.find((s) => s.slug === '811-price-x');
  assert.equal(skip.exclude, 'board_lint');
});

// --- stampClaimInProgress (plan 619) ----------------------------------------
// The drain claim's body flip: ready/ → in-progress/ must restamp the body
// 🔄 IN PROGRESS (it historically left it frozen at 📋 READY). srcFolder 'ready'
// → no Override line (that's only for a waiting-* resume).
test('stampClaimInProgress: flips a READY body to IN PROGRESS, recording the previous status, no Override', () => {
  const body = [
    sw('> 🟩 **SEED-WRITE: NO**'),
    '',
    '**Status:** 📋 READY — opened 2026-06-01.',
    '',
    '# 050-X',
  ].join('\n');
  const out = stampClaimInProgress(body, { host: 'HOST1', slug: '050-X', date: '2026-06-14' });
  assert.match(
    out,
    /\*\*Status:\*\* 🔄 IN PROGRESS — picked up 2026-06-14 by `HOST1` in `worktree-050-X`\./,
  );
  assert.match(out, /\*\*Previous status:\*\* 📋 READY — opened 2026-06-01\./);
  assert.ok(
    !out.includes('**Override:**'),
    'a ready→in-progress claim must not emit an Override line',
  );
  assert.ok(!/\*\*Status:\*\* 📋 READY/.test(out), 'the old READY status line must be replaced');
});

// --- orderedPlanMove: move-first + rollback ordering (plan 622 finding 1) -----
// A park moves the plan file FIRST (gitMoveCommit commits its pending Blocked-by body
// edit → clean tree; repathing first would self-trip the board coordWrite's own
// foreign-dirt guard on that uncommitted edit), THEN repaths the board row. If the
// repath exhausts its budget against GENUINE sibling dirt, the file move is ROLLED BACK
// (raw git, unaffected by the dirt) → row + file still agree → no BOARD_SUBFOLDER_DRIFT.
// (The pre-622 order moved-then-repathed and STOPPED on exhaustion, stranding exactly
// that drift, which lint-board's full-board pass then used to block every sibling push.)

test('orderedPlanMove: happy path moves the file FIRST, THEN repaths the board to the target', () => {
  const order = [];
  const r = orderedPlanMove({
    moveFile: () => order.push('move'),
    unmoveFile: () => order.push('unmove'),
    repath: (sub) => {
      order.push(`repath:${sub}`);
      return { repathed: true, newCell: 'x' };
    },
    toSubfolder: 'waiting-operator',
  });
  assert.deepEqual(order, ['move', 'repath:waiting-operator']); // move precedes repath; no rollback
  assert.equal(r.repathed, true);
});

test('orderedPlanMove: a coordContention at the repath ROLLS BACK the file move (no drift left)', () => {
  const order = [];
  assert.throws(
    () =>
      orderedPlanMove({
        moveFile: () => order.push('move'),
        unmoveFile: () => order.push('unmove'),
        repath: () => {
          order.push('repath');
          throw Object.assign(foreignDirtError(), { coordContention: true });
        },
        toSubfolder: 'waiting-operator',
      }),
    (e) => e.coordContention === true,
  );
  // move → repath (throws) → unmove: the file is returned to its source subfolder, so
  // board row + plan file agree → no BOARD_SUBFOLDER_DRIFT.
  assert.deepEqual(order, ['move', 'repath', 'unmove']);
});

test('orderedPlanMove: a moveFile failure propagates and NEVER repaths or rolls back', () => {
  const order = [];
  assert.throws(
    () =>
      orderedPlanMove({
        moveFile: () => {
          order.push('move');
          throw new Error('rename push failed');
        },
        unmoveFile: () => order.push('unmove'),
        repath: () => order.push('repath'),
        toSubfolder: 'waiting-operator',
      }),
    /rename push failed/,
  );
  // The file never moved (gitMoveCommit/push threw) → no repath, no rollback needed.
  assert.deepEqual(order, ['move']);
});

test('orderedPlanMove: no toSubfolder (claim-time) → file moves, repath skipped, no rollback', () => {
  const order = [];
  const r = orderedPlanMove({
    moveFile: () => order.push('move'),
    unmoveFile: () => order.push('unmove'),
    repath: () => assert.fail('repath must not run without a toSubfolder'),
    toSubfolder: null,
  });
  assert.deepEqual(order, ['move']);
  assert.equal(r.repathed, false);
  assert.equal(r.reason, 'no-target');
});

test('orderedPlanMove: a best-effort rollback failure is swallowed; the ORIGINAL repath error propagates', () => {
  assert.throws(
    () =>
      orderedPlanMove({
        moveFile: () => {},
        unmoveFile: () => {
          throw new Error('rollback also hit dirt');
        },
        repath: () => {
          throw Object.assign(new Error('repath exhausted'), { coordContention: true });
        },
        toSubfolder: 'waiting-operator',
      }),
    /repath exhausted/, // NOT the rollback error
  );
});

// Acceptance (plan 622 verification): a simulated sustained-foreign-dirt park leaves a
// lint-clean board — the move-first order commits the body edit, the repath then fails
// on genuine sibling dirt, and the rollback returns the file to its source subfolder so
// the board row and the plan tree still agree.
test('lint-board acceptance: a sustained-foreign-dirt park (move-first + rollback) leaves no BOARD_SUBFOLDER_DRIFT', () => {
  const SLUG = '622-Infra-x';
  // Model the file's on-disk subfolder as a mutable cell the move/unmove seams flip.
  let fileSubfolder = 'in-progress';
  assert.throws(
    () =>
      orderedPlanMove({
        moveFile: () => {
          fileSubfolder = 'waiting-operator';
        },
        unmoveFile: () => {
          fileSubfolder = 'in-progress';
        }, // rollback returns the file to source
        repath: () => {
          throw Object.assign(foreignDirtError(), { coordContention: true });
        },
        toSubfolder: 'waiting-operator',
      }),
    (e) => e.coordContention === true,
  );
  // The rollback ran → the file is back in in-progress/; the board row never repathed,
  // so it also still names in-progress/ → validateRows must find NO drift (the pre-622
  // order would have left the file in waiting-operator/ while the row said in-progress/).
  assert.equal(fileSubfolder, 'in-progress');
  const byBasename = new Map([[`${SLUG}.md`, [`${fileSubfolder}/${SLUG}.md`]]]);
  const cell = `\`in-progress/${SLUG}.md\` · drain worker`;
  const rows = [{ cells: [SLUG, '`abc`', '⏸ PAUSED', cell, 'd', 'r'] }];
  assert.equal(validateRows(rows, byBasename).length, 0);
});

// --- claimCarryForwardId: foreign-dirt-retried carry-forward mint (plan 622 finding 2)
// The carry-forward claim shells next-plan-id.mjs (a coordWrite op that CAN throw the
// transient foreign-dirt refusal); retrying it rides out a sibling's brief uncommitted
// edit instead of silently dropping the stub.

test('claimCarryForwardId: retries the claim on transient foreign-dirt, then parses the id', () => {
  let calls = 0;
  const claimExec = () => {
    calls++;
    if (calls < 3) throw foreignDirtError();
    return 'next-plan-id: reserved 407\n407\n'; // the bare id prints on its own line
  };
  const id = claimCarryForwardId(claimExec, ['claim', '--slug', 'x'], { retryOpts: noSleep });
  assert.equal(id, '407');
  assert.equal(calls, 3); // pre-622 the first refusal silently dropped the stub; now it retries
});

test('claimCarryForwardId: a non-foreign-dirt claim error propagates (per-item catch logs+skips)', () => {
  assert.throws(
    () =>
      claimCarryForwardId(
        () => {
          throw new Error('next-plan-id boom');
        },
        ['claim'],
        { retryOpts: noSleep },
      ),
    /next-plan-id boom/,
  );
});

test('claimCarryForwardId: throws when stdout carries no id line', () => {
  assert.throws(
    () => claimCarryForwardId(() => 'chatter but no id\n', ['claim'], { retryOpts: noSleep }),
    /returned no id/,
  );
});

test('claimCarryForwardId: scans for the bare id line, ignoring stray stdout (future-proof past 999)', () => {
  const id = claimCarryForwardId(() => 'INFO doing stuff\n  1012  \ntrailing note\n', ['claim'], {
    retryOpts: noSleep,
  });
  assert.equal(id, '1012');
});

// --- finding 3: no per-worker park thrash once coord_contention is terminal --------

test("runDrain: once coord_contention latches, the fold SKIPS remaining workers' park (no K×retry thrash — plan 622 finding 3)", async () => {
  let quarantineCalls = 0;
  const r = await runDrain({
    phase: 3,
    workers: 2, // two workers in flight → two folds
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b')]),
    runner: async (p) => ({ result: { status: 'gate_failed', slug: p.slug }, spendUsd: 0 }),
    claim: () => {},
    quarantine: () => {
      quarantineCalls++;
      throw Object.assign(new Error('drain-run: board update … after 6 attempts'), {
        coordContention: true,
      });
    },
    persist: () => {},
  });
  assert.equal(r.reason, 'coord_contention');
  // The FIRST fold detects the contention (one doomed park attempt sets the terminal);
  // the SECOND worker's fold sees coord_contention latched and skips its park entirely —
  // so quarantine is invoked ONCE, not once-per-in-flight-worker (the K×~20s thrash).
  assert.equal(quarantineCalls, 1);
});

// ── plan 629: post-merge archive + operator-park dispositions ─────────
test('runDrain landing: a POST-merge seam ARCHIVES (branchMerged) — never parks a shipped plan', async () => {
  const finished = [];
  const parked = [];
  const held = [];
  const minted = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    claim: () => {},
    runner: ok({ carry_forward: [{ kind: 'open-new-plan', title: 'follow up' }] }),
    land: async () => ({ code: 15, stdout: 'HANDOFF:CARRYFORWARD_AMBIGUOUS\n{}' }),
    isBranchMerged: () => true, // the merge landed → archive disposition
    finishLand: async (p, seam) => {
      finished.push(`${p.slug}:${seam}`);
      return { code: 0, stdout: '' };
    },
    resumeInProgress: (p, seam) => held.push(`${p.slug}:${seam}`),
    parkLandSeam: (p, seam) => parked.push(`${p.slug}:${seam}`),
    mintCarryForwards: (p) => {
      minted.push(p.slug);
      return ['NNN-Other-follow-up'];
    },
    quarantine: () => {},
    persist: () => {},
  });
  assert.deepEqual(finished, ['a:CARRYFORWARD_AMBIGUOUS']); // close-out completed via the re-invoke
  assert.deepEqual(parked, []); // a shipped plan is NEVER parked to waiting-operator/
  assert.deepEqual(held, []);
  assert.deepEqual(r.state.plans_landed, ['a']); // it counts as a LAND
  assert.deepEqual(minted, ['a']); // carry-forwards minted after the archive
  assert.deepEqual(r.state.lands_parked, []);
});

test('runDrain landing: a branchMerged finish that RE-seams is HELD for resume — a shipped plan is NEVER parked', async () => {
  const held = [];
  const parked = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a')]),
    claim: () => {},
    runner: ok(),
    land: async () => ({ code: 14, stdout: 'HANDOFF:DEPLOY_FAILED\n{}' }),
    isBranchMerged: () => true,
    finishLand: async () => ({ code: 16, stdout: 'HANDOFF:PROMOTE_AMBIGUOUS\n{}' }), // re-seams
    resumeInProgress: (p, seam) => held.push(`${p.slug}:${seam}`),
    parkLandSeam: (p, seam) => parked.push(`${p.slug}:${seam}`),
    mintCarryForwards: () => [],
    quarantine: () => {},
    persist: () => {},
  });
  // the code is on master — STILL land-completion, so it's HELD in in-progress/ to finish
  // the land (re-run done-worktree), NOT parked to waiting-operator/ (the pre-629 outcome).
  assert.deepEqual(held, ['a:PROMOTE_AMBIGUOUS']); // recorded against the finish seam
  assert.deepEqual(parked, []);
  assert.equal(r.state.lands_parked[0].disposition, 'resume');
  assert.equal(r.state.lands_parked[0].seam, 'PROMOTE_AMBIGUOUS');
  assert.deepEqual(r.state.plans_landed, []);
});

test('runDrain landing: an UNKNOWN not-merged seam PARKS for the operator (disposition operator)', async () => {
  const parked = [];
  const held = [];
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle: scriptedOracle([P('a'), P('b')]),
    claim: () => {},
    runner: ok(),
    land: async (p) =>
      p.slug === 'a' ? { code: 99, stdout: 'no HANDOFF line' } : { code: 0, stdout: '' },
    isBranchMerged: () => false, // not merged
    resumeInProgress: (p, seam) => held.push(`${p.slug}:${seam}`),
    parkLandSeam: (p, seam) => parked.push(`${p.slug}:${seam}`),
    mintCarryForwards: () => [],
    quarantine: () => {},
    persist: () => {},
  });
  assert.deepEqual(parked, ['a:UNKNOWN']); // UNKNOWN → operator park
  assert.deepEqual(held, []); // never held in in-progress/
  assert.equal(r.state.lands_parked[0].disposition, 'operator');
  assert.deepEqual(r.state.plans_landed, ['b']); // run continues
  assert.equal(r.reason, 'empty');
});

// ── plan 629: park-path wiring (Task 2 status stamp + Task 4 board PAUSED) ──
// parkToWaitingOperator / resumeInProgressLandSeam shell out to git+board, so assert
// the wiring at the source level (the pure stamps are unit-tested in plan-body-state).
import { readFileSync as _readFileSync } from 'node:fs';
const DRAIN_SRC = _readFileSync(new URL('./drain-run.mjs', import.meta.url), 'utf8');

test('plan 629 Task 2/4: parkToWaitingOperator stamps the body Status AND flips the board to PAUSED', () => {
  assert.match(DRAIN_SRC, /stampWaitingOperatorStatus\(body,/);
  assert.match(DRAIN_SRC, /flipBoardPaused\(mainDir, scriptsDir, plan\.slug, \{ fetch: true \}\)/);
  // flipBoardPaused shells board.mjs set-state … PAUSED and tolerates the row-vanish race
  assert.match(DRAIN_SRC, /'set-state', slug, 'PAUSED'/);
  assert.match(DRAIN_SRC, /row not found/);
  // review fix: it ONLY flips a live ACTIVE row — never a held 🟢 LANDING marker (which
  // would desync the landing-queue steal protocol).
  assert.match(DRAIN_SRC, /if \(!\/ACTIVE\/i\.test\(stateCell\)\) return;/);
});

// plan 3960 review fix (findings 8/9): parkToWaitingOperator used to hardcode BOTH the
// destination folder (`docs/superpowers/plans/waiting-operator/...`, ignoring a configured
// `lanes.waitingOperator` rename) and the Blocked-by insertion anchor (`/(^>.*SEED-WRITE.*$)/im`,
// ignoring a configured `mutationBanner.label`) — the destination check stays a source-level
// assertion (same style as the plan-629/3371 tests above, since parkToWaitingOperator shells out
// to git+board and the WIRING is the property under test).
//
// Review round 2 (R2-8, key drain-run.test.mjs:370 simplification): the banner-anchor half used
// to assert on the literal `new RegExp(...)` source text drain-run.mjs built by hand — gone now
// that R2-1 replaced it with the canonical SEED_BANNER_RX import (build-index-lib.mjs), which
// already derives from the SAME configured mutationBanner.label. Replaced with a BEHAVIOURAL
// check: the Blocked-by line actually lands right after the banner line in the parked body.
test('plan 3960 review fix (findings 8/9): parkToWaitingOperator targets the CONFIGURED waiting-operator folder', () => {
  const fn = DRAIN_SRC.slice(
    DRAIN_SRC.indexOf('function parkToWaitingOperator('),
    DRAIN_SRC.indexOf('function flipBoardPaused('),
  );
  assert.match(
    fn,
    /const to = `docs\/superpowers\/plans\/\$\{WAITING_OPERATOR_FOLDER\}\/\$\{plan\.slug\}\.md`;/,
    'the destination must be the CONFIGURED WAITING_OPERATOR_FOLDER, not a literal "waiting-operator"',
  );
  assert.doesNotMatch(
    fn,
    /const to = `docs\/superpowers\/plans\/waiting-operator\/\$\{plan\.slug\}\.md`;/,
    'the old literal destination must be gone',
  );
});

test('R2-8 behavioural replacement: parkToWaitingOperator inserts the Blocked-by line right after the SEED-WRITE banner line', () => {
  const slug = '2358-Coord-banner-anchor';
  const fromRel = `docs/superpowers/plans/in-progress/${slug}.md`;
  const waitingRel = `docs/superpowers/plans/waiting-operator/${slug}.md`;
  const s = makeCoordRepo({
    [fromRel]: sw(
      "---\nsummary: 'x'\n---\n\n> 🟩 **SEED-WRITE: NO** — no seed touched.\n\n# 2358\n\nSome body prose.\n",
    ),
  });
  try {
    quarantineBlockedToOperator(s.dir, SCRIPTS_DIR_FOR_TEST, { slug }, '2026-07-26', null);
    s.g('fetch', '-q', 'origin', 'master');
    const committed = s.g('show', `origin/master:${waitingRel}`);
    // stampWaitingOperatorStatus runs right after and independently anchors its OWN Status
    // line on the same banner, so the two land banner → Status → Blocked-by, not glued
    // directly to each other — what matters here is that the anchor genuinely fired (the
    // Blocked-by line lands after the banner, not above/inside the frontmatter it precedes).
    const bannerIdx = committed.indexOf(`${MUTATION_BANNER_LABEL}: NO`);
    const blockedByIdx = committed.indexOf('**Blocked-by:**');
    assert.ok(bannerIdx > -1, 'the banner line survives');
    assert.ok(
      blockedByIdx > bannerIdx,
      'the Blocked-by line is anchored after the SEED-WRITE banner',
    );
  } finally {
    s.cleanup();
  }
});

// ── plan 3371 task 5: the park's two pushes, in the order whose crash window is benign ──────────
//
// infra-debt `drain-park-repath-then-pause-is-not-atomic`. The two steps cannot become one commit
// (different files, different push paths), so the guarantee has to come from ORDER: repath-then-pause
// leaves a pushed `🔄 ACTIVE` row on a waiting-lane plan, which lint-board.mjs hard-blocks for every
// sibling session until a human heals it (2917/2909/2888 were three live instances). Pause-first
// leaves a `⏸ PAUSED` row on an in-progress plan, which nothing lints and the next drain re-parks.
//
// Asserted at the source level for the same reason the plan-629 test above is: parkToWaitingOperator
// shells out to git and board.mjs, and the ordering — not any value it returns — IS the property.
test('plan 3371: parkToWaitingOperator PAUSES the board row BEFORE it repaths the plan', () => {
  const fn = DRAIN_SRC.slice(
    DRAIN_SRC.indexOf('function parkToWaitingOperator('),
    DRAIN_SRC.indexOf('function flipBoardPaused('),
  );
  assert.ok(fn.length, 'parkToWaitingOperator must precede flipBoardPaused in the source');
  const pauseAt = fn.indexOf('flipBoardPaused(mainDir, scriptsDir, plan.slug');
  const moveAt = fn.indexOf('movePlanOnMaster(mainDir, scriptsDir, plan, from, to');
  assert.ok(pauseAt > -1, 'the park still pauses the row');
  assert.ok(moveAt > -1, 'the park still repaths the plan');
  assert.ok(
    pauseAt < moveAt,
    'a crash between the two must never leave a pushed ACTIVE row on a parked plan',
  );
});

// Fix (R3-4, key 1206 angle-P): the park-failure catch block prints a recovery `move-plan`
// command that hardcoded the literal destination folder name `waiting-operator`, ignoring the
// CONFIGURED `WAITING_OPERATOR_FOLDER` this same function already uses for the actual move's own
// `to` path (plan 3960's fix, tested above) — a repo with a renamed `lanes.waitingOperator` would
// get a recovery command naming the WRONG folder, which then fails against the real (renamed)
// destination, stranding the plan right back where the recovery command was supposed to rescue
// it from. Pre-existing per the plan's own earlier handoff, but a one-line fix sitting in code
// already being edited this round.
test('R3-4 (key 1206): the park-failure recovery command uses the CONFIGURED WAITING_OPERATOR_FOLDER, not a literal "waiting-operator"', () => {
  const fn = DRAIN_SRC.slice(
    DRAIN_SRC.indexOf('function parkToWaitingOperator('),
    DRAIN_SRC.indexOf('function flipBoardPaused('),
  );
  assert.match(
    fn,
    // Quoted since the round-3 re-review (keys 1t1imp0/1nq4koi/irfsdw) — the property THIS test
    // owns is that the folder is the CONFIGURED constant rather than a literal, which the quoted
    // form still proves; the quoting itself is pinned by its own test further down.
    /const moveCmd = `node scripts\/move-plan\.mjs \$\{plan\.slug\} "\$\{WAITING_OPERATOR_FOLDER\}" --blocked-by/,
    'the recovery command must name the CONFIGURED WAITING_OPERATOR_FOLDER, not a literal ' +
      '"waiting-operator" — a renamed lanes.waitingOperator must reach this command the same ' +
      'way it already reaches the `to` destination path above',
  );
});

test('plan 3371: a park whose move fails after the pause NAMES the state and rethrows', () => {
  // gpt-review 12c1f3: a failed move leaves the plan in its source folder under both orderings and
  // nothing re-parks it. The reorder makes that state QUIET on the board (a PAUSED row lints
  // nothing), which is right for sibling sessions and wrong for the operator — so it must be loud in
  // the log instead, with the one-line recovery, and the error must still propagate.
  const fn = DRAIN_SRC.slice(
    DRAIN_SRC.indexOf('function parkToWaitingOperator('),
    DRAIN_SRC.indexOf('function flipBoardPaused('),
  );
  assert.match(fn, /park FAILED after the board-pause step/);
  // R3-4 (key 1206): the CONFIGURED WAITING_OPERATOR_FOLDER, not a literal "waiting-operator" —
  // see the dedicated R3-4 test above for why.
  assert.match(fn, /move-plan\.mjs \$\{plan\.slug\} "\$\{WAITING_OPERATOR_FOLDER\}"/);
  assert.match(fn, /throw e;/, 'a failed park must never be swallowed into a silent success');
  // delta round 7d243b / 85d9bd: orderedPlanMove's compensating rollback can itself fail and its
  // error is swallowed, so the message must LOOK at where the file is rather than assert it.
  assert.match(fn, /const atSource = existsSync\(abs\);/);
  assert.match(fn, /ALREADY in waiting-operator\//);
  // round 3, 8a04d3: BOTH-present is a real outcome and gets its own branch and its own action,
  // never a move-plan command that would run over a duplicated plan file.
  assert.match(fn, /in BOTH \$\{fromSubfolder\}\/ and waiting-operator\//);
  // round 3, 20e3b3: flipBoardPaused returns nothing and no-ops silently on several paths, so the
  // message must not assert the row IS paused — it must tell the operator to look.
  assert.match(fn, /the pause is \` \+\n\s*\`best-effort and reports nothing back/);
});

test('plan 3371: the park body write and the move are BOTH inside the recovery handler', () => {
  // round 3, f341d1 / 82b52a: a writeFileSync that throws on the shared checkout is the same
  // half-finished park as a move that throws — row published, plan un-repathed — so it must not
  // escape bare, without the location reporting that case exists for.
  const fn = DRAIN_SRC.slice(
    DRAIN_SRC.indexOf('function parkToWaitingOperator('),
    DRAIN_SRC.indexOf('function flipBoardPaused('),
  );
  const tryAt = fn.indexOf('try {');
  const writeAt = fn.indexOf('writeFileSync(abs, body);');
  const moveAt = fn.indexOf('movePlanOnMaster(mainDir, scriptsDir, plan, from, to');
  const catchAt = fn.indexOf('} catch (e) {');
  assert.ok(tryAt > -1 && catchAt > -1);
  assert.ok(tryAt < writeAt && writeAt < catchAt, 'the body write is inside the try');
  assert.ok(writeAt < moveAt && moveAt < catchAt, 'and so is the move, after it');
});

test('plan 3371: the park writes the plan body only AFTER the pause has succeeded', () => {
  // delta round cf229d: the body edit is an uncommitted working-tree write on the SHARED main
  // checkout. Authoring it before the pause meant a failing pause left that checkout dirty with a
  // waiting-lane Status stamp on a plan still in-progress under a still-ACTIVE row.
  const fn = DRAIN_SRC.slice(
    DRAIN_SRC.indexOf('function parkToWaitingOperator('),
    DRAIN_SRC.indexOf('function flipBoardPaused('),
  );
  const stampAt = fn.indexOf('body = stampWaitingOperatorStatus(body,');
  const pauseAt = fn.indexOf('flipBoardPaused(mainDir, scriptsDir, plan.slug');
  const writeAt = fn.indexOf('writeFileSync(abs, body);');
  assert.ok(stampAt > -1 && pauseAt > -1 && writeAt > -1);
  assert.ok(stampAt < pauseAt, 'the body is composed in memory first');
  assert.ok(pauseAt < writeAt, 'and only hits disk once the pause it depends on has succeeded');
});

test('plan 3371: flipBoardPaused defaults to fetch:false and honours an explicit fetch', () => {
  // The F-003 read is authoritative only against a current tracking ref. Every ORIGINAL caller got
  // one free from its own push landing immediately before; the reordered park does not, so it must
  // ask for the fetch rather than silently reading a stale ref and pausing a 🟢 LANDING row.
  assert.match(
    DRAIN_SRC,
    /function flipBoardPaused\(mainDir, scriptsDir, slug, \{ fetch = false \} = \{\}\)/,
  );
  assert.match(DRAIN_SRC, /readBoardAuthoritative\(mainDir, boardRel, boardPath, \{ fetch \}\)/);
});

test('plan 629 Task 3: resumeInProgressLandSeam stamps RESUME-NEEDED via coordWrite + flips board PAUSED', () => {
  assert.match(DRAIN_SRC, /stampLandBlockedResume\(/);
  assert.match(DRAIN_SRC, /coordWrite\(mainDir, \{/);
  // the plan stays in in-progress/ (no move), and the board row is paused
  assert.match(DRAIN_SRC, /in-progress\/\$\{plan\.slug\}\.md/);
});

// ── plan 1312 (2026-07-02 coord audit): F-003 + F-002 origin-backed fixtures ──────────────────
// F-003's regression survived the suite precisely BECAUSE every board read was DI-seamed —
// the seam hid that the DEFAULT read was MAIN's stale working-tree copy. These tests use a
// REAL bare origin + work clone and leave the read path unseamed.
// `test`/`assert` come from this file's top-of-file imports; only the fixture deps are new.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { coordLockPath, readCoordOpJournal } from './coord-git.mjs';
import { makeRenameMoveSync } from './drain-run.mjs';

// NOTE: near-twin of coord-git.test.mjs makeBareOrigin / heal-main.test.mjs makeRepo, kept
// local on purpose — each suite seeds slightly different repo shapes and none exports its
// fixture; unifying them is a test-only refactor with real fixture-drift risk across 200+
// tests (reviewed and consciously skipped, plan 1312).
function makeCoordRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'drain-1312-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  const dir = join(root, 'work');
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, dir]);
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  g('add', '-A');
  g('commit', '-qm', 'base');
  g('push', '-q', 'origin', 'master');
  return {
    root,
    dir,
    origin,
    g,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("F-003 (plan 1312): verifyBoardRowLintClean's DEFAULT read is the AUTHORITATIVE origin board, not MAIN's stale working-tree copy", () => {
  const cell = buildClaimPlanCell(PLAN_506('no'), 'host-x');
  const s = makeCoordRepo({
    'handoff-board.md': boardWith(SLUG_506, cell, '🔄 ACTIVE'),
    [`docs/superpowers/plans/in-progress/${SLUG_506}.md`]: '# plan\n',
  });
  try {
    // The plan-989 world: board.mjs claim lands the row on ORIGIN via the coord-checkout;
    // MAIN's working-tree board is NOT freshened. Reproduce: origin has the row, MAIN's
    // working-tree copy is a row-less stale version.
    writeFileSync(
      join(s.dir, 'handoff-board.md'),
      boardWith('some-other-plan', '`in-progress/some-other-plan.md`'),
    );
    // NO readBoard seam — the DI seam is exactly why the suite never caught the regression.
    assert.doesNotThrow(() => verifyBoardRowLintClean(s.dir, SLUG_506));
    // …and the pre-F-003 behavior (a bare working-tree read) is exactly the deterministic
    // ROW_NOT_FOUND the audit verified — kept as the contrast that documents the fix.
    assert.throws(
      () =>
        verifyBoardRowLintClean(s.dir, SLUG_506, {
          readBoard: () => _readFileSync(join(s.dir, 'handoff-board.md'), 'utf8'),
        }),
      /not found/,
    );
  } finally {
    s.cleanup();
  }
});

test("F-003 (plan 1312): repathBoardRow's DEFAULT read sees a row that exists only on origin/master", () => {
  const s = makeCoordRepo({
    'handoff-board.md': boardWith(SLUG_506, `\`in-progress/${SLUG_506}.md\` · session 1`),
  });
  try {
    writeFileSync(
      join(s.dir, 'handoff-board.md'),
      boardWith('some-other-plan', '`in-progress/some-other-plan.md`'),
    );
    const captured = [];
    const r = repathBoardRow(s.dir, '/scripts', SLUG_506, 'waiting-operator', {
      runUpdate: (sl, c) => captured.push([sl, c]),
    });
    assert.equal(r.repathed, true, 'the origin row is found and repathed (was no-row pre-F-003)');
    assert.equal(captured[0][1], `\`waiting-operator/${SLUG_506}.md\` · session 1`);
  } finally {
    s.cleanup();
  }
});

test('F-002 (plan 1312): the drain rename+push window holds the coord-write lock (mutually exclusive with heal-main)', () => {
  const from = 'docs/superpowers/plans/ready/999-Other-locked.md';
  const to = 'docs/superpowers/plans/in-progress/999-Other-locked.md';
  const s = makeCoordRepo({ [from]: '# p\n' });
  try {
    mkdirSync(join(s.dir, 'docs/superpowers/plans/in-progress'), { recursive: true });
    let lockHeldDuringWindow = null;
    const mv = makeRenameMoveSync(s.dir, '/scripts', 'idx msg', {
      // The seam replaces only the INDEX step (build-index needs repo-root machinery a
      // fixture lacks); the lock, mv+commit, and push are all real.
      _syncIndex: () => {
        lockHeldDuringWindow = existsSync(coordLockPath(s.dir));
      },
    });
    mv(from, to, 'drain: claim 999-Other-locked → in-progress (2026-07-03)');
    assert.equal(lockHeldDuringWindow, true, 'coord-write lock held across the rebase window');
    assert.equal(existsSync(coordLockPath(s.dir)), false, 'lock released afterwards');
    s.g('fetch', '-q', 'origin', 'master');
    assert.match(
      s.g('ls-tree', '--name-only', '-r', 'origin/master'),
      /in-progress\/999-Other-locked\.md/,
      'the move committed and pushed',
    );
    const ops = readCoordOpJournal(s.dir);
    assert.ok(
      ops.some((e) => e.tool === 'drain-move' && e.phase === 'start') &&
        ops.some((e) => e.tool === 'drain-move' && e.phase === 'done'),
      'the window is journaled as a drain-move coord op (withCoordLock wiring, not a bare lock file)',
    );
  } finally {
    s.cleanup();
  }
});

// --- plan 2426 (operator ruling Q3): the write-time board gate on the drain's claim ----
//
// The drain gets NO override. On a BoardInvariantError it records the skip, leaves the plan
// UNTOUCHED in ready/, and takes the next plan — and, critically, does not livelock or halt
// when the oracle keeps re-offering the plan it just refused (which it always will, because
// the refusal is deliberately non-mutating).

test('2426 Q3: selectNextCandidate skips refused slugs, keeps oracle order, dedupes next/eligible', () => {
  const a = { slug: 'a' };
  const b = { slug: 'b' };
  const c = { slug: 'c' };
  const pick = { next: a, eligible: [a, b, c] };
  assert.equal(selectNextCandidate(pick, new Set()).slug, 'a');
  assert.equal(selectNextCandidate(pick, new Set(['a'])).slug, 'b');
  assert.equal(selectNextCandidate(pick, new Set(['a', 'b'])).slug, 'c');
  assert.equal(selectNextCandidate(pick, new Set(['a', 'b', 'c'])), null);
  // A `next`-only oracle result (every pre-2426 scripted fixture) still works.
  assert.equal(selectNextCandidate({ next: a }, new Set()).slug, 'a');
  assert.equal(selectNextCandidate({ next: a }, new Set(['a'])), null);
});

test('2426 Q3: a gate-refused claim is SKIPPED — the next plan runs, the plan is never re-picked', async () => {
  const blocked = P('2358-Coord-blocked');
  const clean = P('2360-Coord-clean');
  const ran = [];
  const claimed = [];
  // The REAL oracle's behaviour after a non-mutating refusal: 2358 is still sitting in
  // ready/, so every subsequent call keeps offering it at the head of `eligible`.
  const remaining = new Set([blocked.slug, clean.slug]);
  const oracle = () => {
    const eligible = [blocked, clean].filter((p) => remaining.has(p.slug));
    if (!eligible.length) return { reason: 'empty' };
    return { next: eligible[0], eligible };
  };
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    oracle,
    claim: (p) => {
      if (p.slug === blocked.slug) {
        throw new BoardInvariantError('drain-run: REFUSING this write — …', [
          { kind: 'live-blocked-by', detail: '2358-Coord-blocked.md: a LIVE **Blocked-by:** line' },
        ]);
      }
      claimed.push(p.slug);
      remaining.delete(p.slug); // a real claim moves the file out of ready/
    },
    runner: async (p) => {
      ran.push(p.slug);
      return { result: { status: 'completed', slug: p.slug }, spendUsd: 0 };
    },
    quarantine: () => {},
    persist: () => {},
  });
  // The clean plan ran; the refused one never did, and never re-entered the pick.
  assert.deepEqual(claimed, [clean.slug]);
  assert.deepEqual(ran, [clean.slug]);
  // No livelock and no `plan_not_advancing` halt — the run ends on its own terminal reason
  // once the refused plan is the ONLY thing left.
  assert.equal(r.reason, 'all_gate_refused');
  // …and the refusal is surfaced in the closing SKIPPED list, with the gate's own detail.
  const skip = r.state.plans_skipped.find((s) => s.slug === blocked.slug);
  assert.equal(skip.exclude, 'board_invariant');
  assert.match(skip.reason, /LIVE \*\*Blocked-by:\*\* line/);
});

test('2426 Q3: the refusal is recorded ONCE even though the oracle re-offers the plan every pass', async () => {
  const blocked = P('2358-Coord-blocked');
  const r = await runDrain({
    phase: 3,
    mainDir: NOWHERE,
    // Never exhausts: the plan stays in ready/ forever, exactly like the real oracle.
    oracle: () => ({ next: blocked, eligible: [blocked] }),
    claim: () => {
      throw new BoardInvariantError('refused', [{ kind: 'live-blocked-by', detail: 'x' }]);
    },
    runner: async () => assert.fail('the worker must never spawn for a refused plan'),
    quarantine: () => {},
    persist: () => {},
  });
  assert.equal(r.reason, 'all_gate_refused');
  assert.equal(
    r.state.plans_skipped.filter((s) => s.slug === blocked.slug).length,
    1,
    'recordSkipped dedupes by slug — the closing list must not repeat one refusal',
  );
  assert.equal(r.state.plans_completed.length, 0);
});

test('2426 Q2: stampClaimInProgress drops a STALE Blocked-by via the shared seam', () => {
  const body = [
    sw('> 🟩 **SEED-WRITE: NO**'),
    '',
    '**Blocked-by:** plan 2141 — must land first.',
    '',
    '**Status:** 📋 READY — opened 2026-06-01.',
  ].join('\n');
  const shipped = { statusOf: (id) => (id === '2141' ? 'archive' : null), isShipped: () => true };
  const open = { statusOf: (id) => (id === '2141' ? 'ready' : null), isShipped: () => false };
  const args = { host: 'H', slug: '2408-Coord-x', date: '2026-07-26' };
  assert.doesNotMatch(
    stampClaimInProgress(body, {
      ...args,
      blockedView: { basename: '2408-Coord-x.md', ...shipped },
    }),
    /Blocked-by/,
  );
  assert.match(
    stampClaimInProgress(body, { ...args, blockedView: { basename: '2408-Coord-x.md', ...open } }),
    /\*\*Blocked-by:\*\* plan 2141 — must land first\./,
    'a LIVE line is never dropped — the gate refuses that claim instead',
  );
  // No blockedView (every pre-2426 caller) → byte-identical to the old behaviour.
  assert.match(stampClaimInProgress(body, args), /\*\*Blocked-by:\*\* plan 2141/);
});

import { BoardInvariantError } from './board-write-gate.mjs';
import {
  claimPlan,
  parkCostPausePlan,
  parkLandSeamPlan,
  parkBoardLintPlan,
  quarantineBlockedToOperator,
} from './drain-run.mjs';
// `pathToFileURL` is already imported at the top of this file (see its note there).
import { fileURLToPath } from 'node:url';

// claimPlan's scriptsDir is only reached by the post-move board repath, which neither test
// below gets to; the real path keeps the argument honest anyway.
const SCRIPTS_DIR_FOR_TEST = dirname(fileURLToPath(import.meta.url));

// The real-repo half of ruling Q3: the gate sits at the movePlanOnMaster choke point, so a
// refusal must leave the SHARED main checkout byte-clean. If it did not, the drain would
// break every parallel session by DECLINING to claim — their next coordWrite would refuse on
// this foreign uncommitted edit.
test('2426 Q3: a gate-refused drain claim leaves the working tree CLEAN and the plan in ready/', () => {
  const readyRel = 'docs/superpowers/plans/ready/2358-Coord-blocked.md';
  const body =
    "---\nsummary: 'x'\nstage: specced\n---\n\n# 2358\n\n" +
    '**Status:** 📋 READY — opened 2026-07-01.\n\n' +
    '**Blocked-by:** plan 2357 — must land first.\n';
  const s = makeCoordRepo({
    [readyRel]: body,
    // An OPEN blocker: still in ready/, so the line above is LIVE.
    'docs/superpowers/plans/ready/2357-Coord-blocker.md': "---\nsummary: 'y'\n---\n\n# 2357\n",
  });
  try {
    assert.throws(
      () => claimPlan(s.dir, SCRIPTS_DIR_FOR_TEST, { slug: '2358-Coord-blocked' }, '2026-07-26'),
      (e) => {
        assert.ok(e instanceof BoardInvariantError);
        assert.match(e.message, /open blockers: 2357/);
        return true;
      },
    );
    assert.equal(s.g('status', '--porcelain').trim(), '', 'no foreign dirt left for siblings');
    assert.equal(
      _readFileSync(join(s.dir, readyRel), 'utf8'),
      body,
      'the plan file is byte-identical — the drain never mutates on a refusal (ruling Q3)',
    );
    assert.equal(existsSync(join(s.dir, 'docs/superpowers/plans/in-progress')), true);
    assert.equal(
      existsSync(join(s.dir, 'docs/superpowers/plans/in-progress/2358-Coord-blocked.md')),
      false,
      'nothing moved',
    );
  } finally {
    s.cleanup();
  }
});

// The complement: a STALE line does NOT refuse — it is dropped, and the claim proceeds
// (proved here up to the flip; the git half is covered by the existing move tests).
test('2426 Q2: a drain claim of a plan whose blocker archived+shipped drops the dead line', () => {
  const readyRel = 'docs/superpowers/plans/ready/2408-Coord-y.md';
  const s = makeCoordRepo({
    [readyRel]:
      "---\nsummary: 'x'\nstage: specced\n---\n\n# 2408\n\n" +
      '**Status:** 📋 READY — opened 2026-07-01.\n\n' +
      '**Blocked-by:** plan 2141 — must land first.\n',
    'docs/superpowers/plans/archive/2141-Coord-done.md':
      "---\nsummary: 'y'\n---\n\n# 2141\n\n**Status:** ✅ COMPLETED — landed.\n",
  });
  try {
    // The move/push half needs the full coord scaffold; assert on the gate + flip, which is
    // everything this plan changed, by catching whatever the later git steps raise.
    try {
      claimPlan(s.dir, SCRIPTS_DIR_FOR_TEST, { slug: '2408-Coord-y' }, '2026-07-26');
    } catch (e) {
      assert.ok(!(e instanceof BoardInvariantError), `the gate must NOT refuse a stale line: ${e}`);
    }
    // The claim may or may not have got as far as the `git mv` before the scaffold-less
    // board repath gave out — read whichever side of the rename actually exists.
    const movedRel = 'docs/superpowers/plans/in-progress/2408-Coord-y.md';
    const landedRel = existsSync(join(s.dir, movedRel)) ? movedRel : readyRel;
    const after = _readFileSync(join(s.dir, landedRel), 'utf8');
    assert.doesNotMatch(after, /Blocked-by/, 'the dead line was dropped by the claim flip');
    assert.match(after, /🔄 IN PROGRESS/);
  } finally {
    s.cleanup();
  }
});

// --- plan 2426 review round 2: the gate's error posture at the drain choke point --------

// plan 2500: this test replaces a vacuous predecessor. The original fixture gave 2358 a
// LIVE Blocked-by on an OPEN 2357 — an ORDINARY violation that `assertTouched` already
// raises as a ready-made BoardInvariantError, which movePlanOnMaster's `instanceof` fast
// path re-throws unchanged. That never reaches the "gate threw something unexpected" wrap
// branch at all, so the test would have passed identically against the pre-round-2 code
// that had no try/catch. Proof this rewrite actually pins the wrap branch: the assertion
// below was watched RED against a build where the movePlanOnMaster catch simply did
// `throw e;` instead of wrapping — see the plan-2500 report for the revert-and-rerun.
test('2426 R2: an unrunnable gate FAILS CLOSED as a BoardInvariantError, never as a pass', () => {
  const readyRel = 'docs/superpowers/plans/ready/2358-Coord-x.md';
  const s = makeCoordRepo({
    [readyRel]:
      "---\nsummary: 'x'\nstage: specced\n---\n\n# 2358\n\n**Status:** 📋 READY — opened 2026-07-01.\n",
  });
  try {
    // The gate itself — not the plan body — is poisoned: a fake gate that throws a plain
    // TypeError, standing in for a library-level bug under classifyBlocked/loadCorpusView.
    // This is the ONLY seam that reaches the wrap branch without also tripping the EARLIER
    // dropStaleBlockedBy call claimPlan makes before movePlanOnMaster runs (that call
    // shares the same statusOf/isShipped a poisoned corpus would need to break, so a
    // poisoned-corpus fixture throws too early to ever exercise this branch).
    const poisonedGate = () => {
      throw new TypeError('gate machinery exploded');
    };
    assert.throws(
      () =>
        claimPlan(s.dir, SCRIPTS_DIR_FOR_TEST, { slug: '2358-Coord-x' }, '2026-07-26', {
          _gate: poisonedGate,
        }),
      (e) => {
        // A real refusal is a BoardInvariantError, and the FILL loop's catch keys on that
        // type — which is exactly why an unrunnable gate must surface as the SAME type
        // rather than as a raw throw that escapes runDrain and abandons every in-flight
        // worker.
        assert.ok(e instanceof BoardInvariantError, `expected a BoardInvariantError, got: ${e}`);
        assert.match(e.message, /gate itself/i);
        assert.match(e.message, /gate machinery exploded/);
        return true;
      },
    );
    assert.equal(s.g('status', '--porcelain').trim(), '', 'and the checkout is left clean');
  } finally {
    s.cleanup();
  }
});

// Review fix (finding 7f22d1, blocking): the cost-pause Blocked-by text unconditionally claimed
// "declares over the spend ceiling or no parseable cost" even for a data-pass pause — a data-pass
// plan is paused because R2 requires an explicit go on ANY non-zero cash forecast, ceiling
// notwithstanding, so telling the operator it is over the ceiling when it plainly is not is a
// false statement about the decision they are being asked to make.
test('fix (finding 7f22d1): parkCostPausePlan states a DATA-PASS reason, never falsely claiming "over the spend ceiling"', () => {
  const readyRel = 'docs/superpowers/plans/ready/2358-Coord-datapass.md';
  const waitingRel = 'docs/superpowers/plans/waiting-operator/2358-Coord-datapass.md';
  const s = makeCoordRepo({ [readyRel]: "---\nsummary: 'x'\n---\n\n# 2358\n" });
  try {
    parkCostPausePlan(
      s.dir,
      SCRIPTS_DIR_FOR_TEST,
      { slug: '2358-Coord-datapass' },
      '2026-07-26',
      'a data pass with a non-zero cash forecast — R2 requires an explicit go regardless of amount',
    );
    s.g('fetch', '-q', 'origin', 'master');
    const committed = s.g('show', `origin/master:${waitingRel}`);
    assert.match(committed, /data pass/);
    assert.doesNotMatch(committed, /over the spend ceiling/);
  } finally {
    s.cleanup();
  }
});

test('fix (finding 7f22d1): parkCostPausePlan names the amount and the ceiling for a genuine over-ceiling pause', () => {
  const readyRel = 'docs/superpowers/plans/ready/2358-Coord-overceil.md';
  const waitingRel = 'docs/superpowers/plans/waiting-operator/2358-Coord-overceil.md';
  const s = makeCoordRepo({ [readyRel]: "---\nsummary: 'x'\n---\n\n# 2358\n" });
  try {
    parkCostPausePlan(
      s.dir,
      SCRIPTS_DIR_FOR_TEST,
      { slug: '2358-Coord-overceil' },
      '2026-07-26',
      'declares $120, over the $100 ceiling',
    );
    s.g('fetch', '-q', 'origin', 'master');
    const committed = s.g('show', `origin/master:${waitingRel}`);
    assert.match(committed, /\$120/);
    assert.match(committed, /\$100/);
  } finally {
    s.cleanup();
  }
});

// plan 2500: this test replaces a vacuous predecessor. The original fixture seeded the
// plan at in-progress/, but parkCostPausePlan only ever reads from ready/ — so
// existsSync(from) was false and it returned via its "not found (already moved?)" guard
// before movePlanOnMaster (and therefore gateAppliesToFolder) was ever reached. The
// `!(threw instanceof BoardInvariantError)` assertion was then trivially true because
// nothing ran. Fixed by seeding at ready/ (parkCostPausePlan's real source folder) so the
// park genuinely executes, and by asserting POSITIVELY that the move landed — a "nothing
// threw" assertion is exactly what let the vacuity hide.
test('2426 R2: a park into a waiting lane never enters the gate at all', () => {
  const readyRel = 'docs/superpowers/plans/ready/2358-Coord-x.md';
  const waitingRel = 'docs/superpowers/plans/waiting-operator/2358-Coord-x.md';
  const s = makeCoordRepo({
    // A LIVE Blocked-by on an OPEN blocker — exactly the shape the gate WOULD refuse if it
    // ran against ready/in-progress. The park destination (waiting-operator/) is out of
    // gateAppliesToFolder's scope, so this body must park fine anyway.
    [readyRel]:
      "---\nsummary: 'x'\n---\n\n# 2358\n\n**Blocked-by:** plan 2357 — must land first.\n",
    'docs/superpowers/plans/ready/2357-Coord-blocker.md': "---\nsummary: 'y'\n---\n\n# 2357\n",
  });
  try {
    parkCostPausePlan(s.dir, SCRIPTS_DIR_FOR_TEST, { slug: '2358-Coord-x' }, '2026-07-26');
    assert.equal(
      existsSync(join(s.dir, waitingRel)),
      true,
      'the park actually moved the file to waiting-operator/ — not merely "nothing threw"',
    );
    assert.equal(existsSync(join(s.dir, readyRel)), false, 'and it left ready/');
    s.g('fetch', '-q', 'origin', 'master');
    assert.match(
      s.g('ls-tree', '--name-only', '-r', 'origin/master'),
      /waiting-operator\/2358-Coord-x\.md/,
      'the move committed and pushed',
    );
  } finally {
    s.cleanup();
  }
});

// Review fix (finding c01265, part of F7): parkToWaitingOperator used to call the real
// loadCoordConfig(mainDir) — which throws on ANY malformed field anywhere in coord.config.json,
// not just a seed-lane-relevant one — with no guard, WHILE parking. That threw straight out of
// the cost-pause path, aborting the whole drain and leaving the plan stuck in ready/ instead of
// parked and the run continuing.
test('parkCostPausePlan (fix, finding c01265): a malformed config field UNRELATED to seedLane must not abort the park — it degrades and parks anyway', () => {
  const readyRel = 'docs/superpowers/plans/ready/2358-Coord-x.md';
  const waitingRel = 'docs/superpowers/plans/waiting-operator/2358-Coord-x.md';
  const s = makeCoordRepo({
    [readyRel]: sw(
      "---\nsummary: 'x'\n---\n\n> 🟩 **SEED-WRITE: NO** — no seed touched.\n\n# 2358\n",
    ),
  });
  try {
    // scopeMaxKeys must be a positive integer (coord-config.mjs's normalizeScopeMaxKeys) — this
    // alone makes loadCoordConfig(dir) throw, with nothing wrong about seedLane/the park itself.
    writeFileSync(join(s.dir, 'coord.config.json'), JSON.stringify({ scopeMaxKeys: -1 }));
    parkCostPausePlan(s.dir, SCRIPTS_DIR_FOR_TEST, { slug: '2358-Coord-x' }, '2026-07-26');
    assert.equal(
      existsSync(join(s.dir, waitingRel)),
      true,
      'the park must still succeed despite the unrelated malformed config field',
    );
    assert.equal(existsSync(join(s.dir, readyRel)), false, 'and it left ready/');
  } finally {
    s.cleanup();
  }
});

// plan 2500 hygiene item 6: parkCostPausePlan was the only one of the four structurally
// identical "outside the gate's blast radius" park helpers with a test at this level.
// Table-driven so all four are pinned the same way the fixed test above pins
// parkCostPausePlan, without four near-duplicate test bodies.
const PARK_HELPER_CASES = [
  {
    name: 'parkCostPausePlan',
    fromSubfolder: 'ready',
    run: (s, slug) => parkCostPausePlan(s.dir, SCRIPTS_DIR_FOR_TEST, { slug }, '2026-07-26'),
  },
  {
    name: 'parkLandSeamPlan',
    fromSubfolder: 'in-progress',
    run: (s, slug) =>
      parkLandSeamPlan(s.dir, SCRIPTS_DIR_FOR_TEST, { slug }, '2026-07-26', 'FIXTURE_SEAM', 'x'),
  },
  {
    name: 'parkBoardLintPlan',
    fromSubfolder: 'in-progress',
    run: (s, slug) => parkBoardLintPlan(s.dir, SCRIPTS_DIR_FOR_TEST, { slug }, '2026-07-26'),
  },
  {
    name: 'quarantineBlockedToOperator',
    fromSubfolder: 'in-progress',
    run: (s, slug) =>
      quarantineBlockedToOperator(s.dir, SCRIPTS_DIR_FOR_TEST, { slug }, '2026-07-26', null),
  },
];

for (const { name, fromSubfolder, run } of PARK_HELPER_CASES) {
  test(`2500: ${name} parks a plan carrying a LIVE Blocked-by without ever entering the gate`, () => {
    const slug = '2358-Coord-x';
    const fromRel = `docs/superpowers/plans/${fromSubfolder}/${slug}.md`;
    const waitingRel = `docs/superpowers/plans/waiting-operator/${slug}.md`;
    const s = makeCoordRepo({
      [fromRel]: `---\nsummary: 'x'\n---\n\n# 2358\n\n**Blocked-by:** plan 2357 — must land first.\n`,
      'docs/superpowers/plans/ready/2357-Coord-blocker.md': "---\nsummary: 'y'\n---\n\n# 2357\n",
    });
    try {
      run(s, slug);
      assert.equal(
        existsSync(join(s.dir, waitingRel)),
        true,
        `${name} must actually move the file to waiting-operator/`,
      );
      assert.equal(existsSync(join(s.dir, fromRel)), false, `and leave ${fromSubfolder}/`);
    } finally {
      s.cleanup();
    }
  });
}

// Fix round 1 (finding G, keys 818ed3/34aae6): quarantineBlockedToOperator, parkLandSeamPlan, and
// parkBoardLintPlan build their Blocked-by text with no `[axis: …]` marker while bypassing the
// move-plan.mjs CLI gate entirely (a direct git write) — coherent only if the text itself carries
// the marker for downstream tooling (/unblock-lane) to classify. Exercises the REAL insertion
// path: `cfg.seedLane` true (so parkToWaitingOperator's Blocked-by insertion fires) and NO
// pre-existing Blocked-by line in the fixture body (so its own template text is what lands),
// unlike the 2500 table above whose fixture already carries a live Blocked-by and never reaches
// the insertion branch at all.
const AXIS_PARK_CASES = [
  {
    name: 'quarantineBlockedToOperator',
    fromSubfolder: 'in-progress',
    run: (s, slug) =>
      quarantineBlockedToOperator(s.dir, SCRIPTS_DIR_FOR_TEST, { slug }, '2026-07-26', null),
  },
  {
    name: 'parkLandSeamPlan',
    fromSubfolder: 'in-progress',
    run: (s, slug) =>
      parkLandSeamPlan(s.dir, SCRIPTS_DIR_FOR_TEST, { slug }, '2026-07-26', 'FIXTURE_SEAM', 'x'),
  },
  {
    name: 'parkBoardLintPlan',
    fromSubfolder: 'in-progress',
    run: (s, slug) => parkBoardLintPlan(s.dir, SCRIPTS_DIR_FOR_TEST, { slug }, '2026-07-26'),
  },
];

for (const { name, fromSubfolder, run } of AXIS_PARK_CASES) {
  test(`fix round 1 (finding G): ${name}'s Blocked-by carries an [axis: …] marker`, () => {
    const slug = '2358-Coord-z';
    const fromRel = `docs/superpowers/plans/${fromSubfolder}/${slug}.md`;
    const waitingRel = `docs/superpowers/plans/waiting-operator/${slug}.md`;
    const s = makeCoordRepo({
      [fromRel]: sw(
        "---\nsummary: 'x'\n---\n\n> 🟩 **SEED-WRITE: NO** — no seed touched.\n\n# 2358\n",
      ),
    });
    try {
      writeFileSync(
        join(s.dir, 'coord.config.json'),
        JSON.stringify({ seedShardDir: 'backend/src/data/seed' }),
      );
      run(s, slug);
      s.g('fetch', '-q', 'origin', 'master');
      const committed = s.g('show', `origin/master:${waitingRel}`);
      assert.match(committed, /\*\*Blocked-by:\*\* `?\[axis: [a-z-]+\]`?/, name);
    } finally {
      s.cleanup();
    }
  });
}

// Fix round 3 (item 11): quarantinePlan (the gate-failure park) is a private, unexported helper
// — asserted at the source level like the other parkToWaitingOperator-internals tests above,
// since it shells out to git/board and the WIRING (the blockedBy text it builds) is the property
// under test. Its text carried NO `[axis: …]` marker, unlike the three exported park helpers
// (finding G above) — which meant BOTH the park's own Blocked-by line AND the recovery command
// parkToWaitingOperator prints on a failed move (it interpolates this SAME string) were refused
// by move-plan.mjs's own assertBlockedByAxisTagOk gate, since both reuse the one `blockedBy` value.
test("round 3 (item 11): quarantinePlan (gate failure)'s Blocked-by carries an [axis: …] marker, like every other direct-git park writer", () => {
  const fn = DRAIN_SRC.slice(
    DRAIN_SRC.indexOf('function quarantinePlan('),
    DRAIN_SRC.indexOf('function runBuildIndex('),
  );
  assert.ok(fn.length, 'quarantinePlan must be found in the source');
  assert.match(fn, /blockedBy: `\[axis: [a-z0-9-]+\] gate failure in drain/);
});

// Fix round 3 (item 12) preserved a stale existing Blocked-by line's TEXT, only splicing this
// park's own tag onto its front — superseded by the post-S1 review finding below (ce8ec7): the
// parked body must state the CURRENT park reason, not an old one with a fresh tag glued on.
// parkToWaitingOperator now REPLACES the whole line whenever one already exists. Reuses
// PARK_HELPER_CASES' own fixture (a LIVE, untagged Blocked-by) to prove it.
for (const { name, fromSubfolder, run } of PARK_HELPER_CASES) {
  test(`fix (finding ce8ec7): ${name} REPLACES an existing untagged Blocked-by line with THIS park's own reason and axis`, () => {
    const slug = '2358-Coord-w';
    const fromRel = `docs/superpowers/plans/${fromSubfolder}/${slug}.md`;
    const waitingRel = `docs/superpowers/plans/waiting-operator/${slug}.md`;
    const s = makeCoordRepo({
      [fromRel]: `---\nsummary: 'x'\n---\n\n# 2358\n\n**Blocked-by:** plan 2357 — must land first.\n`,
      'docs/superpowers/plans/ready/2357-Coord-blocker.md': "---\nsummary: 'y'\n---\n\n# 2357\n",
    });
    try {
      run(s, slug);
      s.g('fetch', '-q', 'origin', 'master');
      const committed = s.g('show', `origin/master:${waitingRel}`);
      assert.match(committed, /\*\*Blocked-by:\*\*.*\[axis: [a-z0-9-]+\]/, name);
      // the OLD reason must be GONE — the current park's own reason is what's shown, never a
      // stale one from a different, earlier blocker.
      assert.doesNotMatch(committed, /must land first/, name);
    } finally {
      s.cleanup();
    }
  });
}

// Review fix (findings 866415/11f9ab/7c83d6): presence-only validation — an EXISTING marker that
// IS shaped like `[axis: …]` (so the old AXIS_TAG_PRESENT_RX presence check treated it as "fine")
// but names a bogus tag, or an axis wrong for this park's lane, used to be preserved untouched.
// Now that every re-park REPLACES the whole line (finding ce8ec7's fix), a bogus/wrong-lane
// existing marker can no longer survive either — proven directly rather than inferred from the
// ce8ec7 case above, since AXIS_TAG_PRESENT_RX's "presence" bar (which the fix deletes) was only
// ever a problem for a line that DID look tagged.
for (const { name, fromSubfolder, run } of PARK_HELPER_CASES) {
  test(`fix (findings 866415/11f9ab/7c83d6): ${name} REPLACES an existing BOGUS-tagged Blocked-by line, not just an untagged one`, () => {
    const slug = '2358-Coord-bogus';
    const fromRel = `docs/superpowers/plans/${fromSubfolder}/${slug}.md`;
    const waitingRel = `docs/superpowers/plans/waiting-operator/${slug}.md`;
    const s = makeCoordRepo({
      [fromRel]: `---\nsummary: 'x'\n---\n\n# 2358\n\n**Blocked-by:** \`[axis: bogus]\` stale unrelated reason.\n`,
    });
    try {
      run(s, slug);
      s.g('fetch', '-q', 'origin', 'master');
      const committed = s.g('show', `origin/master:${waitingRel}`);
      assert.doesNotMatch(committed, /axis: bogus/, name);
      assert.doesNotMatch(committed, /stale unrelated reason/, name);
      assert.match(committed, /\*\*Blocked-by:\*\*.*\[axis: [a-z0-9-]+\]/, name);
    } finally {
      s.cleanup();
    }
  });
}

// Review fix (finding 703f27): the insertion branch only ever fired when `cfg.seedLane` was true
// (it needs the SEED-WRITE banner as an anchor) — a config-less / non-seedLane repo with NO
// existing Blocked-by line got nothing inserted at all, landing in waiting-operator/ with no axis
// metadata whatsoever. Fixed with an H1-then-prepend fallback, mirroring move-plan.mjs's own
// rewriteBlockedByHeader for the identical case.
test('fix (finding 703f27): parkCostPausePlan inserts a Blocked-by line even with no SEED-WRITE banner and seedLane off (config-less repo)', () => {
  const readyRel = 'docs/superpowers/plans/ready/2358-Coord-noseed.md';
  const waitingRel = 'docs/superpowers/plans/waiting-operator/2358-Coord-noseed.md';
  const s = makeCoordRepo({
    // No coord.config.json at all ⇒ seedLane defaults off; body has an H1 but no SEED-WRITE
    // banner and no pre-existing Blocked-by line.
    [readyRel]: "---\nsummary: 'x'\n---\n\n# 2358\n\nSome body prose.\n",
  });
  try {
    parkCostPausePlan(s.dir, SCRIPTS_DIR_FOR_TEST, { slug: '2358-Coord-noseed' }, '2026-07-26');
    s.g('fetch', '-q', 'origin', 'master');
    const committed = s.g('show', `origin/master:${waitingRel}`);
    assert.match(committed, /\*\*Blocked-by:\*\*.*\[axis: [a-z0-9-]+\]/);
  } finally {
    s.cleanup();
  }
});

// Review round 2 (R2-1, the serious defect): round 1's "no H1 → prepend at byte 0" insertion
// fallback ran on the RAW body and, with no H1/banner anchor, prepended the new Blocked-by line
// literally at offset 0 — landing it ABOVE a leading `---` YAML fence and corrupting it
// (frontmatterEnd's `isFenceLine(lines[0])` no longer recognises ANY frontmatter once the file's
// first line is the Blocked-by text, not `---`). Fixed via insertBlockedByLine's frontmatter-safe
// anchor chain (banner, else H1, else right after the frontmatter block, never above/inside it).
test('R2-1: insertBlockedByLine leaves a leading YAML frontmatter block byte-identical when there is no H1/banner anchor', () => {
  const content = "---\nsummary: 'x'\n---\n\nJust body prose, no heading, no banner.\n";
  const out = insertBlockedByLine(content, '**Blocked-by:** [axis: manual] test reason');
  const fmMatch = out.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fmMatch, 'the frontmatter fence must still parse as a well-formed block');
  assert.equal(
    fmMatch[0],
    "---\nsummary: 'x'\n---\n",
    'the frontmatter block is byte-identical to the original',
  );
  assert.doesNotMatch(
    fmMatch[1],
    /Blocked-by/,
    'the Blocked-by line must never land INSIDE the fence',
  );
  assert.match(
    out.slice(fmMatch[0].length),
    /\*\*Blocked-by:\*\* \[axis: manual\] test reason/,
    'the Blocked-by line lands in the body, after the fence',
  );
});

test('R2-1: insertBlockedByLine anchors after a SEED-WRITE banner when present, frontmatter still untouched', () => {
  const content = sw(
    "---\nsummary: 'x'\n---\n\n> 🟩 **SEED-WRITE: NO** — no seed touched.\n\n# 2358\n",
  );
  const out = insertBlockedByLine(content, '**Blocked-by:** test reason');
  assert.ok(out.startsWith("---\nsummary: 'x'\n---\n"));
  assert.match(
    out,
    new RegExp(
      `${MUTATION_BANNER_LABEL}: NO\\*\\* — no seed touched\\.\\n\\n\\*\\*Blocked-by:\\*\\* test reason`,
    ),
  );
});

test('R2-1: insertBlockedByLine anchors after the H1 when there is no banner, frontmatter still untouched', () => {
  const content = "---\nsummary: 'x'\n---\n\n# 2358 title\n\nSome prose.\n";
  const out = insertBlockedByLine(content, '**Blocked-by:** test reason');
  assert.ok(out.startsWith("---\nsummary: 'x'\n---\n"));
  assert.match(out, /# 2358 title\n\n\*\*Blocked-by:\*\* test reason/);
});

// The end-to-end park path, not just the pure helper: a real park through quarantineBlockedToOperator
// against a body with NO H1 and NO banner must leave the plan's YAML frontmatter parseable/intact.
test('R2-1: a real park that INSERTS a Blocked-by line into a body with no H1/banner leaves the YAML frontmatter byte-identical', () => {
  const slug = '2358-Coord-nofm-anchor';
  const fromRel = `docs/superpowers/plans/in-progress/${slug}.md`;
  const waitingRel = `docs/superpowers/plans/waiting-operator/${slug}.md`;
  const originalFrontmatter = "---\nsummary: 'plan 4069 R2-1 fixture'\n---\n";
  const s = makeCoordRepo({
    [fromRel]: `${originalFrontmatter}\nJust body prose with no heading and no Blocked-by line at all.\n`,
  });
  try {
    quarantineBlockedToOperator(s.dir, SCRIPTS_DIR_FOR_TEST, { slug }, '2026-07-26', null);
    s.g('fetch', '-q', 'origin', 'master');
    const committed = s.g('show', `origin/master:${waitingRel}`);
    const fmMatch = committed.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(
      fmMatch,
      'the frontmatter fence must still parse — a corrupted park loses it entirely',
    );
    assert.match(
      fmMatch[1],
      /^summary: 'plan 4069 R2-1 fixture'$/m,
      'the original summary: line survives inside the fence, untouched',
    );
    assert.doesNotMatch(
      fmMatch[1],
      /Blocked-by/,
      'the Blocked-by line must never land INSIDE the frontmatter fence',
    );
    assert.match(
      committed.slice(fmMatch[0].length),
      /\*\*Blocked-by:\*\*/,
      'the Blocked-by line is present in the body, after the fence',
    );
  } finally {
    s.cleanup();
  }
});

// Review round 2 (R2-2, key 1102): an existing `unblock:` value is preserved only when it is
// BOTH valid AND compatible with the axis THIS park is about to declare — never blindly, which
// let a park write e.g. `[axis: money]` onto a plan still carrying `unblock: manual` (a pair
// move-plan's own assertBlockedByAxisTagOk refuses outright), or leave a legacy `unblock: cost`
// (never a valid operator value) standing untouched.
test('R2-2: a CONFLICTING existing unblock: value is corrected to match the axis THIS park writes', () => {
  const fromRel = 'docs/superpowers/plans/in-progress/2358-Coord-unblock-conflict.md';
  const waitingRel = 'docs/superpowers/plans/waiting-operator/2358-Coord-unblock-conflict.md';
  const s = makeCoordRepo({
    // quarantineBlockedToOperator always writes `[axis: manual]`, which unblock: decision does
    // NOT admit (AXIS_TAGS_BY_UNBLOCK.decision excludes 'manual') — a genuine conflict.
    [fromRel]: "---\nsummary: 'x'\nunblock: decision\n---\n\n# 2358\n",
  });
  try {
    quarantineBlockedToOperator(
      s.dir,
      SCRIPTS_DIR_FOR_TEST,
      { slug: '2358-Coord-unblock-conflict' },
      '2026-07-26',
      null,
    );
    s.g('fetch', '-q', 'origin', 'master');
    const committed = s.g('show', `origin/master:${waitingRel}`);
    const matches = committed.match(/^unblock:\s*\S+\s*$/gm) || [];
    assert.equal(matches.length, 1, 'exactly one unblock: line, never a duplicate');
    assert.match(
      committed,
      /^unblock:\s*manual\s*$/m,
      'the incompatible existing "decision" is corrected to "manual" to match this park\'s [axis: manual]',
    );
  } finally {
    s.cleanup();
  }
});

test('R2-2: an invalid legacy "unblock: cost" value is corrected, never preserved', () => {
  const readyRel = 'docs/superpowers/plans/ready/2358-Coord-unblock-legacy-cost.md';
  const waitingRel = 'docs/superpowers/plans/waiting-operator/2358-Coord-unblock-legacy-cost.md';
  const s = makeCoordRepo({
    [readyRel]: "---\nsummary: 'x'\nunblock: cost\n---\n\n# 2358\n",
  });
  try {
    parkCostPausePlan(
      s.dir,
      SCRIPTS_DIR_FOR_TEST,
      { slug: '2358-Coord-unblock-legacy-cost' },
      '2026-07-26',
    );
    s.g('fetch', '-q', 'origin', 'master');
    const committed = s.g('show', `origin/master:${waitingRel}`);
    assert.doesNotMatch(
      committed,
      /^unblock:\s*cost\s*$/m,
      'cost is never a valid operator hold (plan 1065) and must not survive the park',
    );
    assert.match(committed, /^unblock:\s*decision\s*$/m);
  } finally {
    s.cleanup();
  }
});

// Review round 2 (R2-3, key 1036): flipBoardPaused/repathBoardRow must read the REPO'S REAL
// configured board path even when an UNRELATED coord.config.json field is malformed elsewhere —
// never substitute a fabricated whole-config default (round 1's loadCoordConfigOrDefault, which
// silently fell back to normalizeConfig(null)'s LEGACY board path, ignoring a real configured
// `handoffDir`).
test('R2-3: repathBoardRow reads the REAL configured board path even when an unrelated coord.config.json field is malformed', () => {
  const s = makeCoordRepo({
    'coord.config.json': JSON.stringify({ handoffDir: 'custom-handoff', scopeMaxKeys: -1 }),
    'custom-handoff/board.md': boardWith(SLUG_506, `\`in-progress/${SLUG_506}.md\` · session 1`),
  });
  try {
    const captured = [];
    const r = repathBoardRow(s.dir, '/scripts', SLUG_506, 'waiting-operator', {
      runUpdate: (sl, c) => captured.push([sl, c]),
    });
    assert.equal(
      r.repathed,
      true,
      'the row lives at the CONFIGURED handoffDir path — falling back to the LEGACY default ' +
        '(handoff-board.md, which does not exist here) would read no-board instead',
    );
    assert.equal(captured[0][1], `\`waiting-operator/${SLUG_506}.md\` · session 1`);
  } finally {
    s.cleanup();
  }
});

// Fix (R3-3, key 1054 angle-A): boardFileRelOf's malformed-config fallback re-derives
// `handoffDir` straight from the raw parsed JSON with no type check at all — a non-string value
// (a number, an object, an array; `raw.handoffDir` on an authoring mistake like
// `{"handoffDir": 42}`) is truthy, so it skips derivePaths' `!handoffDir` early-return and flows
// into `String(handoffDir)`, producing a coerced GARBAGE path ("42/board.md") instead of falling
// back to the LEGACY default the way an absent/empty handoffDir correctly does. Validate it is a
// non-empty string before use; anything else degrades to the legacy `handoff-board.md` path.
test('R3-3 (key 1054): boardFileRelOf falls back to the LEGACY board path when the raw handoffDir is non-string, instead of coercing it into a garbage path', () => {
  const s = makeCoordRepo({
    'coord.config.json': JSON.stringify({ handoffDir: 42, scopeMaxKeys: -1 }),
    'handoff-board.md': boardWith(SLUG_506, `\`in-progress/${SLUG_506}.md\` · session 1`),
  });
  try {
    const captured = [];
    const r = repathBoardRow(s.dir, '/scripts', SLUG_506, 'waiting-operator', {
      runUpdate: (sl, c) => captured.push([sl, c]),
    });
    assert.equal(
      r.repathed,
      true,
      'a non-string handoffDir must fall back to the LEGACY board path (handoff-board.md), not ' +
        'a coerced garbage path like "42/board.md" — falling back to the garbage path would read ' +
        'no-board here since nothing exists at that made-up location',
    );
    assert.equal(captured[0][1], `\`waiting-operator/${SLUG_506}.md\` · session 1`);
  } finally {
    s.cleanup();
  }
});

// R3-5 (key 1032 simplification): unblockValueForAxisTag's third branch
// (`AXIS_TAGS_BY_UNBLOCK.manual.includes(tag)`) is unreachable as written — every tag it could
// ever catch is already resolved by an earlier branch: `tag === 'manual'` is caught by the FIRST
// `if`, and `tag === 'access'` (the only other member of AXIS_TAGS_BY_UNBLOCK.manual) is caught
// by the SECOND `if`, since AXIS_TAGS_BY_UNBLOCK.decision — "every axis except manual" — already
// includes 'access'. No behaviour change: both the removed branch and the trailing default
// returned 'decision' for a non-manual tag, so simplifying to a plain manual/else ternary changes
// nothing observable.
test('R3-5 (key 1032): unblockValueForAxisTag has no unreachable AXIS_TAGS_BY_UNBLOCK.manual branch', () => {
  const fn = DRAIN_SRC.slice(
    DRAIN_SRC.indexOf('function unblockValueForAxisTag('),
    DRAIN_SRC.indexOf('function boardFileRelOf('),
  );
  assert.ok(fn.length, 'unblockValueForAxisTag must be found in the source');
  assert.doesNotMatch(
    fn,
    /AXIS_TAGS_BY_UNBLOCK\.manual\.includes/,
    'the unreachable manual-list check must be removed — tag === "manual" is already caught by ' +
      'the first `if`, and "access" (the only other manual-list member) is already caught by ' +
      'the decision-list `if` above it',
  );
});

test('R2-3: a malformed unrelated coord.config.json field still parks the plan (F7 preserved)', () => {
  const readyRel = 'docs/superpowers/plans/ready/2358-Coord-r23-park.md';
  const waitingRel = 'docs/superpowers/plans/waiting-operator/2358-Coord-r23-park.md';
  const s = makeCoordRepo({
    [readyRel]: sw(
      "---\nsummary: 'x'\n---\n\n> 🟩 **SEED-WRITE: NO** — no seed touched.\n\n# 2358\n",
    ),
  });
  try {
    writeFileSync(join(s.dir, 'coord.config.json'), JSON.stringify({ scopeMaxKeys: -1 }));
    parkCostPausePlan(s.dir, SCRIPTS_DIR_FOR_TEST, { slug: '2358-Coord-r23-park' }, '2026-07-26');
    assert.equal(existsSync(join(s.dir, waitingRel)), true, 'the park must still succeed');
    assert.equal(existsSync(join(s.dir, readyRel)), false, 'and it left ready/');
  } finally {
    s.cleanup();
  }
});

// Review fix (finding 88908f): the detector only matched the exactly-bolded `**Blocked-by:**`
// form — an unbolded `Blocked-by: …` or blockquoted `> **Blocked-by:** …` line (both sanctioned,
// corpus-attested forms per plan-body-state.mjs's own BLOCKED_RX) went undetected, so the
// insertion branch ran ANYWAY and produced a SECOND Blocked-by-shaped line rather than replacing
// the first.
for (const { name, fromSubfolder, run } of PARK_HELPER_CASES) {
  test(`fix (finding 88908f): ${name} detects an UNBOLDED existing Blocked-by line and replaces it (never duplicates)`, () => {
    const slug = '2358-Coord-unbold';
    const fromRel = `docs/superpowers/plans/${fromSubfolder}/${slug}.md`;
    const waitingRel = `docs/superpowers/plans/waiting-operator/${slug}.md`;
    const s = makeCoordRepo({
      [fromRel]: `---\nsummary: 'x'\n---\n\n# 2358\n\nBlocked-by: plan 2357 — must land first.\n`,
      'docs/superpowers/plans/ready/2357-Coord-blocker.md': "---\nsummary: 'y'\n---\n\n# 2357\n",
    });
    try {
      run(s, slug);
      s.g('fetch', '-q', 'origin', 'master');
      const committed = s.g('show', `origin/master:${waitingRel}`);
      const blockedByCount = (committed.match(/Blocked-by/g) || []).length;
      assert.equal(blockedByCount, 1, `${name}: exactly one Blocked-by line, never a duplicate`);
      assert.match(committed, /\*\*Blocked-by:\*\*.*\[axis: [a-z0-9-]+\]/, name);
    } finally {
      s.cleanup();
    }
  });
}

// Review fix (finding 969306/996adf/438ee8, F6): parkToWaitingOperator wrote a Blocked-by and a
// Status line but never an `unblock:` frontmatter field, so waiting-operator-status.mjs buckets
// the parked plan under "no unblock marker" and /unblock-lane can never route it. Fixed by
// stamping the unblock: value implied by THIS park's own axis (via setUnblock, plan-body-state's
// shared seam) whenever the field is absent; an already-present value is left alone.
test('fix (finding 969306): parkCostPausePlan (axis: money) stamps unblock: decision when the field is absent', () => {
  const readyRel = 'docs/superpowers/plans/ready/2358-Coord-unblock1.md';
  const waitingRel = 'docs/superpowers/plans/waiting-operator/2358-Coord-unblock1.md';
  const s = makeCoordRepo({
    [readyRel]: "---\nsummary: 'x'\n---\n\n# 2358\n",
  });
  try {
    parkCostPausePlan(s.dir, SCRIPTS_DIR_FOR_TEST, { slug: '2358-Coord-unblock1' }, '2026-07-26');
    s.g('fetch', '-q', 'origin', 'master');
    const committed = s.g('show', `origin/master:${waitingRel}`);
    assert.match(committed, /^unblock:\s*decision\s*$/m);
  } finally {
    s.cleanup();
  }
});

test('fix (finding 969306): quarantineBlockedToOperator (axis: manual) stamps unblock: manual when the field is absent', () => {
  const fromRel = 'docs/superpowers/plans/in-progress/2358-Coord-unblock2.md';
  const waitingRel = 'docs/superpowers/plans/waiting-operator/2358-Coord-unblock2.md';
  const s = makeCoordRepo({
    [fromRel]: "---\nsummary: 'x'\n---\n\n# 2358\n",
  });
  try {
    quarantineBlockedToOperator(
      s.dir,
      SCRIPTS_DIR_FOR_TEST,
      { slug: '2358-Coord-unblock2' },
      '2026-07-26',
      null,
    );
    s.g('fetch', '-q', 'origin', 'master');
    const committed = s.g('show', `origin/master:${waitingRel}`);
    assert.match(committed, /^unblock:\s*manual\s*$/m);
  } finally {
    s.cleanup();
  }
});

test('fix (finding 969306): an already-present unblock: value is left alone, never overwritten by the park', () => {
  const readyRel = 'docs/superpowers/plans/ready/2358-Coord-unblock3.md';
  const waitingRel = 'docs/superpowers/plans/waiting-operator/2358-Coord-unblock3.md';
  const s = makeCoordRepo({
    [readyRel]: "---\nsummary: 'x'\nunblock: decision\n---\n\n# 2358\n",
  });
  try {
    parkCostPausePlan(s.dir, SCRIPTS_DIR_FOR_TEST, { slug: '2358-Coord-unblock3' }, '2026-07-26');
    s.g('fetch', '-q', 'origin', 'master');
    const committed = s.g('show', `origin/master:${waitingRel}`);
    const matches = committed.match(/^unblock:\s*\S+\s*$/gm) || [];
    assert.equal(matches.length, 1, 'exactly one unblock: line, never a duplicate');
    assert.match(committed, /^unblock:\s*decision\s*$/m);
  } finally {
    s.cleanup();
  }
});

// Review fix (finding 54dced, F4): parkToWaitingOperator's failed-move recovery command told the
// operator to re-run `move-plan.mjs <slug> waiting-operator --blocked-by "<text>"` with NO
// `--unblock`, so a plan carrying `unblock: decision` (or none) that was quarantined with
// `[axis: manual]` got a recovery command move-plan.mjs's own gate rejects (assertUnblockOk
// requires --unblock for a body with no valid existing unblock: field), stranding the plan.
test('fix (finding 54dced): the failed-move recovery command carries --unblock matching the park axis (manual)', () => {
  // Asserted at the source level, same convention as the sibling "park whose move fails" tests
  // right above (plan 3371) — the property under test is the literal `moveCmd` template this
  // catch block builds, which move-plan.mjs's real assertUnblockOk gate refuses without
  // `--unblock` when the body carries no existing valid unblock: field (the exact shape a
  // quarantined plan lands the recovery command against).
  const fn = DRAIN_SRC.slice(
    DRAIN_SRC.indexOf('function parkToWaitingOperator('),
    DRAIN_SRC.indexOf('function flipBoardPaused('),
  );
  assert.ok(fn.length, 'parkToWaitingOperator must be found in the source');
  const m = fn.match(/const moveCmd = `([^`]+)`/);
  assert.ok(m, 'moveCmd template literal not found');
  assert.match(m[1], /--unblock/, 'the recovery command must carry --unblock');
});

// Review fix (round-3 re-review, keys 1t1imp0/1nq4koi/irfsdw — three finders, one line): R3-4 made
// the recovery command name the CONFIGURED WAITING_OPERATOR_FOLDER instead of a literal, which is
// right, but interpolated it BARE into a shell command the operator copy-pastes. The configured
// lane folder is repo-controlled (coord.config.json) so no untrusted input reaches it, but a
// renamed lane carrying a space would silently split into two argv entries and the pasted recovery
// command would fail against the very plan it exists to rescue. Quoted at the template, so the
// emitted command is correct for ANY configured folder name.
test('round-3 re-review (keys 1t1imp0/1nq4koi/irfsdw): the recovery command QUOTES the configured lane folder', () => {
  const fn = DRAIN_SRC.slice(
    DRAIN_SRC.indexOf('function parkToWaitingOperator('),
    DRAIN_SRC.indexOf('function flipBoardPaused('),
  );
  assert.ok(fn.length, 'parkToWaitingOperator must be found in the source');
  const m = fn.match(/const moveCmd = `([^`]+)`/);
  assert.ok(m, 'moveCmd template literal not found');
  assert.match(
    m[1],
    /"\$\{WAITING_OPERATOR_FOLDER\}"/,
    'the configured lane folder must be QUOTED in the emitted shell command, not interpolated bare',
  );
});

// --- plan 3111: the adopt-branch dispatch shape ------------------------------
// When the oracle hands the driver a plan carrying `adoptBranch`, a PREVIOUS execution's work is
// already committed and pushed on that branch and the plan was re-filed to ready/ for the next
// taker to CONTINUE it. Without this the worker cuts a fresh empty branch off origin/master and
// redoes work that already exists — the exact duplication plan 2863 was filed to stop, arriving
// through the other door.

test('buildPlanPrompt (plan 3111): no adoptBranch ⇒ the prompt is unchanged — a bare cut off origin/master', () => {
  const p = buildPlanPrompt(plan);
  assert.match(p, /cut-worktree\.mjs 203-UI-x`/, 'a bare cut, no --adopt suffix');
  assert.ok(!/ADOPT MODE/.test(p), 'no adopt prose leaks onto an ordinary plan');
  assert.match(p, /from origin\/master and publishes the empty branch/);
});

test('buildPlanPrompt (plan 3111): adoptBranch ⇒ the cut command carries --adopt=<branch>', () => {
  const p = buildPlanPrompt({ ...plan, adoptBranch: 'worktree-203-UI-x' });
  assert.match(p, /cut-worktree\.mjs 203-UI-x --adopt=worktree-203-UI-x`/);
});

test('buildPlanPrompt (plan 3111): adopt mode says CONTINUE, never restart, and how to read the branch', () => {
  const p = buildPlanPrompt({ ...plan, adoptBranch: 'worktree-203-UI-x' });
  assert.match(p, /ADOPT MODE/);
  assert.match(p, /Do NOT restart the plan from scratch/);
  // Review fix (findings 2/3): the ref is `origin/<branch>`, not the bare branch — see the
  // dedicated test below for why the bare form could not resolve.
  assert.match(p, /git log --oneline origin\/master\.\.origin\/worktree-203-UI-x/);
});

test('buildPlanPrompt (plan 3111): adopt mode names the STALE-STAMP fallback rather than stalling', () => {
  // The field can legitimately be present while origin no longer carries the branch (it landed
  // between the stamp and this dispatch). cut-worktree refuses loudly there; the recovery is a
  // normal cut, and a worker that is not told so stalls on a refusal it cannot interpret.
  const p = buildPlanPrompt({ ...plan, adoptBranch: 'worktree-203-UI-x' });
  assert.match(p, /REFUSED because origin no longer carries that branch/);
  assert.match(p, /cut normally with `node scripts\/cut-worktree\.mjs 203-UI-x`/);
});

// --- plan 3111 review-fix round ----------------------------------------------

test('buildPlanPrompt (finding 2/3): the inspection command names origin/<branch>, not a bare local ref', () => {
  // `cut-worktree --adopt=claude/drain-<slug>` checks the work out onto the LOCAL branch
  // worktree-<slug>; it never creates a local `claude/drain-<slug>`. A bare ref there dies with
  // an unknown-revision error and the worker cannot read the work it must inherit.
  const p = buildPlanPrompt({ ...plan, adoptBranch: 'claude/drain-203-UI-x' });
  assert.match(p, /git log --oneline origin\/master\.\.origin\/claude\/drain-203-UI-x/);
  assert.ok(
    !/origin\/master\.\.claude\/drain-203-UI-x[^.]/.test(p),
    'the bare-local-ref form must be gone',
  );
  assert.match(p, /worktree-203-UI-x/, 'and it says which local branch the work lands on');
});

test('buildPlanPrompt (finding 17): adopt mode does NOT claim cut-worktree fetches origin master', () => {
  // cut-worktree fetches the ADOPTED branch in adopt mode (`fetch origin <srcBranch>`), so the
  // stock clause was a false statement about the very command the worker is told to run.
  const p = buildPlanPrompt({ ...plan, adoptBranch: 'worktree-203-UI-x' });
  assert.ok(
    !/it fetches origin master first/.test(p),
    'the false claim must be gone in adopt mode',
  );
  assert.match(p, /it fetches `worktree-203-UI-x` from origin first/);
});

test('buildPlanPrompt (finding 17): the NON-adopt prompt keeps the original origin-master wording', () => {
  const p = buildPlanPrompt(plan);
  assert.match(p, /it fetches origin master first, then cuts from origin\/master/);
});

test('buildPlanPrompt (round-2 finding 7): adopt mode fetches origin/master before comparing against it', () => {
  // In adopt mode cut-worktree fetches only the ADOPTED branch, so a stale local origin/master
  // would make `origin/master..origin/<branch>` list already-landed commits and the worker could
  // misjudge which of the plan's steps are still outstanding.
  const p = buildPlanPrompt({ ...plan, adoptBranch: 'worktree-203-UI-x' });
  assert.match(
    p,
    /git fetch origin master && git log --oneline origin\/master\.\.origin\/worktree-203-UI-x/,
  );
});
