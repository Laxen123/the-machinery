// scripts/gpt-review.test.mjs (plan 2663)
// Justification (CLAUDE.md pre-commit growth-valve rule): gpt-review.mjs is a
// genuinely new scripts/ module (the codex-CLI GPT review runner) with no
// existing name-paired test file — this is its name-pair, not a new file for
// an existing module.
//
// Tests ONLY the pure parts: scope-block assembly, canonFile normalization,
// (file,line) grouping, the escalate-on-refute classification tables, the
// findings-shaping (key + verdict), and the "tokens used" trailer parse. No
// codex subprocess is spawned — mocking a real transport call would just
// assert the mock, and the transport itself is exercised by the smoke
// acceptance run (a real `codex exec` call), never by this unit suite.
//
// plan 3637 narrows that last sentence to what it was always defending: no REAL
// codex is spawned. runCodex's exit-code gate cannot be reached from a pure part —
// the condition under test IS a process outcome — so its tests spawn a controlled
// node stand-in in codex's place, the same fake-binary shape this file already uses
// for git. runCodex itself runs unmodified there, so those tests assert the
// transport's own handling, not a mock of it.
//
// plan 2766 — same rule for the Claude data-grounding arm: no real `claude -p`
// call. classifyClaudeArmResult() is the pure soft-fail classifier that would
// otherwise run against runClaudeArm()'s output — it accepts the SAME shape
// runClaudeArm() returns (`{error}` or `{envelope}`, the single
// `--output-format json` envelope), so a test double covers the soft-fail
// path, the checkpoint-tag shape, and candidate-shape-reaches-verify without
// spawning anything.
//
// ROUND 3 (post-incident, post-repo-sweep): the arm's PRIMARY defense against
// a Stop-hook epilogue clobbering its answer is now `--settings
// disableAllHooks` on the transport (repo precedent: backend/scripts/lib/
// claude_hooks.py's DISABLE_HOOKS_ARGS) — an earlier round built a bespoke
// stream-json/NDJSON multi-event parser to defend against the same failure;
// that parser (parseStreamJsonLines) is REMOVED, deliberately, per the
// "don't invent a mechanism this repo already has" call. extractDelimited
// CandidatesJson stays as a cheap SECONDARY layer (prose-tolerance within the
// ONE envelope `result` string) — its coverage below is scoped precisely to
// what it can and cannot do now that there is only one string to parse, not
// a multi-block stream (see its header comment in gpt-review.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildScopeBlock,
  canonFile,
  ensureCodexBootstrap,
  ensureCodexProjectTrust,
  resolveCodexTrustRoot,
  projectTrustState,
  codexHookTrustArgs,
  classifyRound1,
  classifyRound2,
  finderPrompt,
  callTag,
  promptCallDigest,
  requireArrayPayload,
  callCachedArray,
  sanitizeTag,
  groupVerifierPrompt,
  groupByLoc,
  histNote,
  locKey,
  parseArgs,
  parseTokensUsed,
  shapeFindings,
  shapeRefuted,
  shortKey,
  CORRECTNESS_ANGLES,
  CLEANUP_ANGLES,
  DATA_GROUNDING_ANGLES,
  FINDERS,
  DEFAULT_CONCURRENCY,
  MODEL_LUNA,
  MODEL_SOL,
  GROUP_VERDICT_SCHEMA,
  GROUP_VERDICT_SCHEMA_JSON,
  VERDICT_LADDER,
  VERDICT_LADDER_RECALL,
  CLEANUP_PRECEDENCE,
  // plan 2936 — severity floor + prior-round dispositions
  SEVERITY_FLOOR_NOTE,
  FINDING_TAG_NOTE,
  extractDispositionedFindings,
  buildDispositionsBlock,
  resolveDispositionsBlock,
  dispositionsBlockForSlug,
  // plan 2766 — Claude data-grounding hybrid arm
  CLAUDE_MODEL,
  CLAUDE_ARM_LABEL,
  CLAUDE_ARM_TAG,
  CLAUDE_ARM_CAP,
  CLAUDE_ARM_MAX_TURNS,
  CLAUDE_ARM_DELIM_START,
  CLAUDE_ARM_DELIM_END,
  claudeArmPrompt,
  parseClaudeArmCandidates,
  extractDelimitedCandidatesJson,
  resolveClaudeModelStamp,
  sumModelUsageTokens,
  classifyClaudeArmResult,
  pickFreshestSidecar,
  readSidecarForSlug,
  warnBeforeReviewLaunch,
  resolveLaunchTargetBranch,
  gatePrepSpawnDecision,
  gatePrepChildEnv,
  reviewDetachDecision,
  classifyRunProgress,
  shouldLogProgressObservation,
  REVIEW_WAIT_TIMEOUT_MS,
  REVIEW_LAUNCH_GRACE_MS,
  EXIT_WAIT_STILL_RUNNING,
  EXIT_DETACHED_GONE,
  isClaudeCodeRemote,
  rewriteDetachedChildArgs,
  defaultReviewOutDir,
  progressCommandExitCode,
  handleDetachedSpawnResult,
  detachedPollCommand,
  probeFindingsFreshness,
  // plan 3451 — identity-reset raw/ recreation regression (clearStaleReviewArtifacts itself
  // is already imported below, plan 3369 fix round 1)
  EMPTY_RANGE_STALE_ARTIFACTS,
  EMPTY_RANGE_STALE_DIRS,
  clearStaleReviewArtifactsForIdentityReset,
  // plan 3637 — the runCodex exit-code gate and its exit renderer
  runCodex,
  describeExit,
  // plan 3966 — the liveness probe that replaced the fixed wall-clock kill
  armLivenessProbe,
  LIVENESS_START_AFTER_S,
  LIVENESS_WINDOW_S,
} from './gpt-review.mjs';
import { parseSidecarOrRefuse } from './coord/findings-sidecar-io.mjs';
// plan 3503, review round 3: the two pure env builders gpt-review.mjs's network-reaching git
// children now route through — tested directly here (no child-env.test.mjs exists yet; the
// round-3 brief folds its env-helper coverage into this module's name-paired test file) so the
// primitives are pinned independent of any one caller's own settings/import shape.
import { gitIsolatedEnv, gitRepoIsolatedEnv, GIT_REPO_SELECTOR_VARS } from './coord/child-env.mjs';

test('canonFile: suffix-matches against the scope file list, longest match wins', () => {
  const files = ['backend/src/foo.ts', 'src/foo.ts'];
  assert.equal(canonFile('C:\\repo\\backend\\src\\foo.ts', files), 'backend/src/foo.ts');
  assert.equal(canonFile('src/foo.ts', files), 'src/foo.ts');
  assert.equal(canonFile('unrelated/path.ts', files), 'unrelated/path.ts');
  assert.equal(canonFile('', files), '');
});

test('locKey: file, or file:line when a line is present', () => {
  assert.equal(locKey({ file: 'a.ts', line: null }), 'a.ts');
  assert.equal(locKey({ file: 'a.ts', line: 42 }), 'a.ts:42');
});

test('warnBeforeReviewLaunch: refreshes then warns from the plan session marker', () => {
  const slug = '3395-SOL-review-round-cap';
  const warnings = [];
  const order = [];
  assert.equal(
    warnBeforeReviewLaunch('/repo', {
      branchName: `worktree-${slug}`,
      paths: { sessionsDir: 'docs/handoff/sessions' },
      warn: (message) => warnings.push(message),
      refreshFn: () => order.push('refresh'),
      findSessionFn: () => {
        order.push('read');
        return 'docs/handoff/sessions/session.md';
      },
      readCandidatesFn: () => [
        `Review: PASS @ ${'a'.repeat(40)} patch-id:${'b'.repeat(40)} review-round:3\n`,
      ],
    }),
    3,
  );
  assert.deepEqual(order, ['refresh', 'read']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /launching round 4 is at the 3-delta-round cap/);
});

test('warnBeforeReviewLaunch: passes the review output directory to the round-brief advisory', () => {
  const warnings = [];
  warnBeforeReviewLaunch('/repo', {
    branchName: 'worktree-3545-SOL-review-fix-brief',
    paths: { sessionsDir: 'docs/handoff/sessions' },
    reviewOutDir: '/repo/.scratch/gpt-review/3545-SOL-review-fix-brief/round-2',
    warn: (message) => warnings.push(message),
    refreshFn: () => {},
    findSessionFn: () => 'docs/handoff/sessions/session.md',
    readCandidatesFn: () => [`Review: PASS @ ${'a'.repeat(40)} review-round:1\n`],
    existsFn: () => false,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /round 1's fix ran without a fresh-context brief/);
});

test('warnBeforeReviewLaunch: main can reuse the exact branch slug already resolved for the advisory', () => {
  const context = warnBeforeReviewLaunch('/repo', {
    branchName: 'worktree-3527-SOL-review-round-cap',
    paths: { sessionsDir: 'docs/handoff/sessions' },
    refreshFn: () => {},
    findSessionFn: () => null,
    returnContext: true,
  });
  assert.deepEqual(context, {
    branch: 'worktree-3527-SOL-review-round-cap',
    slug: '3527-SOL-review-round-cap',
    rounds: 1,
    markerRoundFloor: 0,
    markerSha: null,
  });
});

test('warnBeforeReviewLaunch: drain execution branches resolve the same bare plan slug', () => {
  const context = warnBeforeReviewLaunch('/repo', {
    branchName: 'claude/drain-3527-SOL-review-round-cap',
    paths: { sessionsDir: 'docs/handoff/sessions' },
    refreshFn: () => {},
    findSessionFn: () => null,
    returnContext: true,
  });
  assert.deepEqual(context, {
    branch: 'claude/drain-3527-SOL-review-round-cap',
    slug: '3527-SOL-review-round-cap',
    rounds: 1,
    markerRoundFloor: 0,
    markerSha: null,
  });
});

test('warnBeforeReviewLaunch: a malformed coord.config.json degrades to advisory, not a crash', () => {
  // e33d8b (CONFIRMED): unlike the refresh() call right above it, the `loadCoordConfig(repoRoot)`
  // call this function makes when no `paths` override is passed sat OUTSIDE any try/catch — so a
  // fail-loud coord-config validation error (an invalid handoffLayout, an empty seedShardDir, bad
  // JSON, …) crashed the entire gpt-review launch before a single finder ran, contradicting this
  // function's own doc comment: "Advisory only; absent/unreadable means round 1."
  const dir = mkdtempSync(joinPath(tmpdir(), 'gptrev-badcoordcfg-'));
  writeFileSync(joinPath(dir, 'coord.config.json'), '{"handoffLayout":"bogus"}\n');
  try {
    const warnings = [];
    let result;
    assert.doesNotThrow(() => {
      result = warnBeforeReviewLaunch(dir, {
        branchName: 'worktree-3395-SOL-review-round-cap',
        warn: (message) => warnings.push(message),
        refreshFn: () => {},
        findSessionFn: () => 'docs/handoff/sessions/session.md',
        readCandidatesFn: () => [`Review: PASS @ ${'a'.repeat(40)}\n`],
      });
    }, 'a malformed coord.config.json must degrade the round warning, not crash the launch');
    assert.equal(result, 1, 'unresolvable paths degrades to round 1, same as an absent config');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 3618 round 3 finding 3fe0f1: main()'s launch-target resolution used to call
// resolveReviewTargetBranch directly, OUTSIDE warnBeforeReviewLaunch's own fail-open branch
// lookup — a transient git failure there crashed main() before a single finder ran. Wrapping it
// in resolveLaunchTargetBranch restores the fail-open contract: a throwing resolver degrades to
// branchName: undefined (warnBeforeReviewLaunch's own pre-existing advisory fallback) with a
// warning, never a crash.
test('resolveLaunchTargetBranch: a throwing resolver degrades to the fallback branch with a warning, never crashes — finding 3fe0f1', () => {
  const warnings = [];
  const result = resolveLaunchTargetBranch({
    args: { rangeExplicit: false, range: 'origin/master...HEAD' },
    repoRoot: '/repo',
    warn: (message) => warnings.push(message),
    resolveFn: () => {
      throw new Error('transient git failure');
    },
  });
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /plan-branch resolution failed/);
  assert.match(warnings[0], /transient git failure/);
});

test('resolveLaunchTargetBranch: the resolver runs with an explicit --range token, else none', () => {
  let seenTokens;
  resolveLaunchTargetBranch({
    args: { rangeExplicit: true, range: 'origin/master..worktree-9999-x' },
    repoRoot: '/repo',
    resolveFn: ({ tokens }) => {
      seenTokens = tokens;
      return { status: 'explicit', branch: 'worktree-9999-x', path: null, repoRoot: '/repo' };
    },
  });
  assert.deepEqual(seenTokens, ['origin/master..worktree-9999-x']);
  resolveLaunchTargetBranch({
    args: { rangeExplicit: false, range: 'origin/master...HEAD' },
    repoRoot: '/repo',
    resolveFn: ({ tokens }) => {
      seenTokens = tokens;
      return { status: 'current', branch: 'master', path: '/repo', repoRoot: '/repo' };
    },
  });
  assert.deepEqual(seenTokens, []);
});

// plan 3618 round 4 finding 2bf5f2: fail-open means "do not block", never "charge someone else".
// A throwing resolver with an EXPLICIT target (naming another plan) must NOT fall back to the
// current checkout — that would charge (or cap-deny) the WRONG plan. It must return a sentinel
// (`{ branch: null }`) that resolves to no plan id at all, so the launch runs uncharged instead
// of misattributed.
test('resolveLaunchTargetBranch: an explicit target that throws is uncharged, never falls back to the current branch — finding 2bf5f2', () => {
  const warnings = [];
  const result = resolveLaunchTargetBranch({
    args: { rangeExplicit: true, range: 'origin/master..worktree-9999-b' },
    repoRoot: '/repo',
    warn: (message) => warnings.push(message),
    resolveFn: () => {
      throw new Error('transient git failure');
    },
  });
  assert.deepEqual(result, { branch: null });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /plan-branch resolution failed/);
  assert.match(warnings[0], /ad-hoc \(uncharged\)/);
});

// End-to-end proof of finding 2bf5f2's downstream consequence: branchName: null (what main()
// passes through from the sentinel above) resolves to NO plan id at all, so neither the current
// checkout's plan NOR the requested target's ledger is touched — the launch is genuinely ad-hoc,
// not silently misattributed.
test('a null branchName (the 2bf5f2 sentinel) charges no plan and records no launch', () => {
  const r = launchCapRepo(); // checked out on worktree-3527-SOL-review-round-cap
  try {
    const context = warnBeforeReviewLaunch(r.dir, {
      returnContext: true,
      branchName: null,
      refreshFn: () => {},
    });
    assert.equal(context.slug, null);
    const decision = reviewLaunchCapDecision(r.dir, context);
    assert.deepEqual(decision, { planId: null, launchOrdinal: null, denied: false });
    assert.equal(
      readFileSync(joinPath(r.dir, '.git', 'HEAD'), 'utf8').length > 0,
      true,
      'sanity: the repo is real',
    );
    // no ledger ref was created for the current checkout's own plan (3527)
    assert.throws(() => r.g(['rev-parse', '--verify', '--quiet', 'refs/review-rounds/3527']));
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('prior dispositions: malformed coord.config.json warns, skips injection, and review flow continues', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gptrev-malformed-dispositions-'));
  const warnings = [];
  try {
    writeFileSync(joinPath(dir, 'coord.config.json'), '{"handoffLayout":"bogus"}\n');
    assert.equal(
      dispositionsBlockForSlug(dir, '3527-SOL-review-round-cap', {
        warn: (message) => warnings.push(message),
        readSidecarFn: () => assert.fail('malformed config must skip the dispositions read'),
      }),
      '',
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not read coord\.config\.json/);
    assert.match(warnings[0], /continuing the review/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sonnet-review workflow remains self-contained for the import-free Workflow sandbox', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../.claude/workflows/sonnet-review.js', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /warnIfReviewRoundCapReached|REVIEW_OUT/);
  assert.match(source, /export const meta =/);
  assert.match(source, /await agent\(/);
});

test('sonnet-review workflow strips both shared --past-cap forms before deriving TARGET', () => {
  assert.match(WORKFLOW_SRC, /const REVIEW_ARGS = RAW_ARGS/);
  const pattern = WORKFLOW_SRC.match(/^const PAST_CAP_ARG = \/(.*)\/g$/m);
  assert.ok(pattern, 'the import-free workflow must vendor its --past-cap stripper');
  const strip = (value) => value.replace(new RegExp(pattern[1], 'g'), '').trim();
  assert.equal(
    strip('high --past-cap "run: finish now" worktree-3545-SOL-fix'),
    'high worktree-3545-SOL-fix',
  );
  assert.equal(strip('xhigh --past-cap=run:finish-now'), 'xhigh');
  assert.match(
    WORKFLOW_SRC,
    /const TARGET = FIRST_IS_LEVEL \? REVIEW_ARGS\.slice\(FIRST\.length\)\.trim\(\) : REVIEW_ARGS/,
  );
});

test('groupByLoc: groups candidates sharing the same (file,line)', () => {
  const cands = [
    { file: 'a.ts', line: 1, summary: 'x' },
    { file: 'a.ts', line: 1, summary: 'y' },
    { file: 'b.ts', line: 2, summary: 'z' },
  ];
  const groups = groupByLoc(cands);
  assert.equal(groups.length, 2);
  const sizes = groups.map((g) => g.length).sort();
  assert.deepEqual(sizes, [1, 2]);
});

test('classifyRound1: CONFIRMED/PLAUSIBLE settle, REFUTED and needsEscalation escalate', () => {
  const round1 = [
    { file: 'a.ts', line: 1, verdict: 'CONFIRMED' },
    { file: 'a.ts', line: 2, verdict: 'PLAUSIBLE' },
    { file: 'a.ts', line: 3, verdict: 'REFUTED' },
    { file: 'a.ts', line: 4, __needsEscalation: true },
  ];
  const { settled, toEscalate } = classifyRound1(round1);
  assert.equal(settled.length, 2);
  assert.equal(toEscalate.length, 2);
  assert.deepEqual(
    settled.map((c) => c.line),
    [1, 2],
  );
  assert.deepEqual(
    toEscalate.map((c) => c.line),
    [3, 4],
  );
});

test('classifyRound1: never drops a candidate — every input lands in settled or toEscalate', () => {
  const round1 = [
    { file: 'a.ts', line: 1, verdict: 'CONFIRMED' },
    { file: 'a.ts', line: 2, verdict: 'REFUTED' },
    { file: 'a.ts', line: 3, __needsEscalation: true },
  ];
  const { settled, toEscalate } = classifyRound1(round1);
  assert.equal(settled.length + toEscalate.length, round1.length);
});

test('classifyRound2: CONFIRMED/PLAUSIBLE kept, REFUTED dropped (logged), needsEscalation -> UNVERIFIED kept', () => {
  const round2 = [
    { file: 'a.ts', line: 1, verdict: 'CONFIRMED' },
    { file: 'a.ts', line: 2, verdict: 'REFUTED' },
    { file: 'a.ts', line: 3, __needsEscalation: true },
  ];
  const { kept, refuted } = classifyRound2(round2);
  assert.equal(kept.length, 2);
  assert.equal(refuted.length, 1);
  assert.equal(refuted[0].line, 2);
  const unverified = kept.find((c) => c.line === 3);
  assert.equal(unverified.verdict, 'UNVERIFIED');
  assert.ok(unverified.evidence.length > 0, 'a fallback evidence string is always present');
});

test('classifyRound2: never silently drops — kept.length + refuted.length === input.length', () => {
  const round2 = [
    { file: 'a.ts', line: 1, verdict: 'CONFIRMED' },
    { file: 'a.ts', line: 2, verdict: 'REFUTED' },
    { file: 'a.ts', line: 3, __needsEscalation: true },
    { file: 'a.ts', line: 4, verdict: 'PLAUSIBLE' },
  ];
  const { kept, refuted } = classifyRound2(round2);
  assert.equal(kept.length + refuted.length, round2.length);
});

test('shapeFindings: assigns a stable 6-hex key and carries the verdict/angle through', () => {
  const kept = [
    {
      file: 'a.ts',
      line: 10,
      summary: 'S',
      failure_scenario: 'F',
      angle: 'angle-A',
      verdict: 'CONFIRMED',
      evidence: 'E',
    },
  ];
  const findings = shapeFindings(kept);
  assert.equal(findings.length, 1);
  assert.match(findings[0].key, /^[0-9a-f]{6}$/);
  assert.equal(findings[0].verdict, 'CONFIRMED');
  assert.equal(findings[0].angle, 'angle-A');
  // deterministic: same inputs → same key
  assert.equal(shortKey('a.ts', '10', 'S'), findings[0].key);
});

test('shapeFindings: carries kind, adjudicator tags, and evidence into the written finding shape', () => {
  const [finding] = shapeFindings([
    {
      file: 'a.ts',
      line: 10,
      summary: 'S',
      failure_scenario: 'F',
      angle: 'angle-A',
      kind: 'correctness',
      verdict: 'CONFIRMED',
      evidence: 'the verifier cited line 10',
      preExisting: true,
      preExistingWhy: 'the behavior is outside the reviewed plus side',
      blocksLand: false,
      blocksLandWhy: 'the finding is advisory on this target surface',
    },
  ]);

  assert.deepEqual(
    {
      kind: finding.kind,
      evidence: finding.evidence,
      preExisting: finding.preExisting,
      preExistingWhy: finding.preExistingWhy,
      blocksLand: finding.blocksLand,
      blocksLandWhy: finding.blocksLandWhy,
    },
    {
      kind: 'correctness',
      evidence: 'the verifier cited line 10',
      preExisting: true,
      preExistingWhy: 'the behavior is outside the reviewed plus side',
      blocksLand: false,
      blocksLandWhy: 'the finding is advisory on this target surface',
    },
  );
});

test('shapeFindings: a null line is preserved as null, not coerced', () => {
  const kept = [
    {
      file: 'a.ts',
      line: null,
      summary: 'S',
      failure_scenario: 'F',
      angle: 'reuse',
      verdict: 'PLAUSIBLE',
    },
  ];
  const findings = shapeFindings(kept);
  assert.equal(findings[0].line, null);
});

test('shapeRefuted: shape matches findings minus failure_scenario', () => {
  const refuted = [
    { file: 'a.ts', line: 5, summary: 'S', angle: 'angle-B', verdict: 'REFUTED', evidence: 'E' },
  ];
  const shaped = shapeRefuted(refuted);
  assert.equal(shaped[0].verdict, 'REFUTED');
  assert.equal(shaped[0].file, 'a.ts');
});

test('promptCallDigest: rendered prompt changes move the cache tag', () => {
  const finder = { label: 'angle-A', text: 'original prompt', kind: 'correctness' };
  const oldPrompt = finderPrompt('scope A', finder);
  const newPrompt = finderPrompt('scope A', { ...finder, text: 'corrected prompt' });
  const oldTag = callTag(
    `finder:${finder.label}`,
    promptCallDigest({ prompt: oldPrompt, schema: null, model: MODEL_LUNA }),
  );
  const newTag = callTag(
    `finder:${finder.label}`,
    promptCallDigest({ prompt: newPrompt, schema: null, model: MODEL_LUNA }),
  );
  assert.notEqual(newTag, oldTag);
  assert.notEqual(sanitizeTag(newTag), sanitizeTag(oldTag));
  const longBase = `finder:${'nested-path/'.repeat(20)}angle-A`;
  assert.notEqual(
    sanitizeTag(
      callTag(longBase, promptCallDigest({ prompt: oldPrompt, schema: null, model: MODEL_LUNA })),
    ),
    sanitizeTag(
      callTag(longBase, promptCallDigest({ prompt: newPrompt, schema: null, model: MODEL_LUNA })),
    ),
    'the filename cap must preserve the prompt digest on long tags',
  );
  assert.equal(callTag(`finder:${finder.label}`, ''), `finder:${finder.label}`);
});

test('verify tag changes when the candidate group changes at the same location', () => {
  const base = {
    file: 'src/a.ts',
    line: 10,
    failure_scenario: 'the user sees the wrong result',
  };
  const firstPrompt = groupVerifierPrompt('same scope', [{ ...base, summary: 'first claim' }]);
  const secondPrompt = groupVerifierPrompt('same scope', [{ ...base, summary: 'second claim' }]);
  const tagFor = (prompt) =>
    callTag(
      'verify:src/a.ts:10',
      promptCallDigest({ prompt, schema: GROUP_VERDICT_SCHEMA, model: MODEL_LUNA }),
    );

  assert.notEqual(tagFor(firstPrompt), tagFor(secondPrompt));
});

test('promptCallDigest changes when only interpolated ladder text changes', () => {
  const render = (ladder) => `verify the candidate\n\n${ladder}\n\nStructured output only.`;
  assert.notEqual(
    promptCallDigest({
      prompt: render('CONFIRMED means fully demonstrated'),
      schema: GROUP_VERDICT_SCHEMA,
      model: MODEL_LUNA,
    }),
    promptCallDigest({
      prompt: render('CONFIRMED means demonstrated beyond doubt'),
      schema: GROUP_VERDICT_SCHEMA,
      model: MODEL_LUNA,
    }),
  );
});

test('shapeFindings without extraFields keeps the exact legacy key and field set', () => {
  const kept = [
    {
      file: 'a.ts',
      line: 10,
      summary: 'S',
      failure_scenario: 'F',
      angle: 'angle-A',
      verdict: 'CONFIRMED',
      evidence: 'E',
      proposed_fix: 'must remain absent without the opt-in',
    },
  ];
  const expected = {
    key: '37ede8',
    file: 'a.ts',
    line: 10,
    summary: 'S',
    failure_scenario: 'F',
    angle: 'angle-A',
    verdict: 'CONFIRMED',
    evidence: 'E',
  };
  assert.deepEqual(shapeFindings(kept), [expected]);
  assert.equal(JSON.stringify(shapeFindings(kept)[0]), JSON.stringify(expected));
});

test('shapeFindings keeps structured extra-field keys outside the legacy joined-key space', () => {
  const common = {
    file: 'f',
    line: 1,
    failure_scenario: 'failure',
    angle: 'correctness',
    verdict: 'CONFIRMED',
    evidence: 'evidence',
  };
  const withExtra = shapeFindings([{ ...common, summary: 'A', proposed_fix: 'x' }], {
    extraFields: ['proposed_fix'],
  })[0];
  const legacyOnly = shapeFindings([{ ...common, summary: 'A|["x"]' }])[0];

  assert.notEqual(withExtra.key, legacyOnly.key);
});

test('sanitizeTag: distinct over-cap tags cannot collide while short tags stay unchanged', () => {
  const sharedPrefix = `verify:${'deep/path/'.repeat(20)}`;
  const first = `${sharedPrefix}first.ts:10`;
  const second = `${sharedPrefix}second.ts:10`;

  assert.notEqual(sanitizeTag(first), sanitizeTag(second));
  assert.ok(sanitizeTag(first).length <= 120);
  assert.ok(sanitizeTag(second).length <= 120);
  assert.equal(sanitizeTag('verify:short.ts:10'), 'verify_short_ts_10');
});

test('parseTokensUsed: extracts the digits from the "tokens used" trailer, ignoring separators', () => {
  assert.equal(parseTokensUsed('some output\ntokens used\n1,234,567\n'), 1234567);
  assert.equal(parseTokensUsed('tokens used\n   987\n'), 987);
  assert.equal(parseTokensUsed('no trailer here'), null);
  assert.equal(parseTokensUsed(''), null);
  assert.equal(parseTokensUsed(undefined), null);
});

test('histNote: names the end-ref and instructs git show over the working tree', () => {
  const note = histNote('abc1234');
  assert.match(note, /HISTORICAL commit range/);
  assert.match(note, /git show abc1234:<path>/);
  assert.match(note, /MSYS_NO_PATHCONV=1/);
});

test('buildScopeBlock: assembles the review-scope shape with files/CLAUDE.md/summary/conventions', () => {
  const block = buildScopeBlock({
    diffPatchPath: '/abs/out/diff.patch',
    headSha: 'deadbeef',
    files: ['a.ts', 'b.ts'],
    claudeMdFiles: ['/repo/CLAUDE.md'],
    summary: 'Did a thing.',
    conventions: 'Read the files.',
    target: '',
  });
  assert.match(block, /## Review scope/);
  assert.match(block, /Diff file .*: \/abs\/out\/diff\.patch/);
  assert.match(block, /Changed files \(2\):/);
  assert.match(block, /- a\.ts/);
  assert.match(block, /## What changed\nDid a thing\./);
  assert.match(block, /## Conventions\nRead the files\./);
  assert.doesNotMatch(block, /User instructions/);
});

test('buildScopeBlock: appends the verbatim target/user-instructions section when given', () => {
  const block = buildScopeBlock({
    diffPatchPath: '/abs/out/diff.patch',
    headSha: 'a1b2c3',
    files: ['a.ts'],
    claudeMdFiles: [],
    summary: 'S',
    conventions: 'C',
    target: 'HISTORICAL NOTE TEXT',
  });
  assert.match(block, /## User instructions \(verbatim\)\nHISTORICAL NOTE TEXT/);
  assert.match(block, /Applicable CLAUDE.md files \(0\):\n {2}\(none\)/);
});

// ─── plan 2936 T2 — the materialized-diff path + orientation sentence, no runnable
// `git diff` instruction left for finders ─────────────────────────────────────────
test('buildScopeBlock (T2): carries the materialized-diff ABSOLUTE path and the +/- orientation sentence, not a "Diff command:" line', () => {
  const block = buildScopeBlock({
    diffPatchPath: '/abs/out/diff.patch',
    headSha: 'cafef00d',
    files: ['a.ts'],
    claudeMdFiles: [],
    summary: 'S',
    conventions: 'C',
    target: '',
  });
  assert.doesNotMatch(block, /Diff command:/);
  assert.ok(block.includes('/abs/out/diff.patch'));
  // orientation: '+' side is the code under review at the resolved tip, '-' side is the base.
  assert.match(block, /lines beginning `\+`.*code under review.*cafef00d/i);
  assert.match(block, /lines beginning `-`.*pre-change base/i);
});

test('buildScopeBlock (T3): always carries the SEVERITY_FLOOR_NOTE, verbatim', () => {
  const block = buildScopeBlock({
    diffPatchPath: '/abs/out/diff.patch',
    headSha: 'x',
    files: ['a.ts'],
    claudeMdFiles: [],
    summary: 'S',
    conventions: 'C',
    target: '',
  });
  assert.ok(block.includes(SEVERITY_FLOOR_NOTE));
});

test('finderPrompt (T2): instructs finders to READ the diff file — no "run the diff" instruction survives', () => {
  const block = buildScopeBlock({
    diffPatchPath: '/abs/out/diff.patch',
    headSha: 'x',
    files: ['a.ts'],
    claudeMdFiles: [],
    summary: 'S',
    conventions: 'C',
    target: '',
  });
  const prompt = finderPrompt(block, CORRECTNESS_ANGLES[0]);
  assert.doesNotMatch(prompt, /run the diff/i);
  assert.match(prompt, /read the diff file/i);
});

// ─── plan 2936 T1 — prior-round dispositions ────────────────────────────────
test('extractDispositionedFindings: only wontfix/plan are extracted; fixed is excluded; reason truncated to 200 chars', () => {
  const longReason = 'x'.repeat(250);
  const rec = {
    findings: [
      {
        file: 'a.ts',
        line: 1,
        summary: 'wontfixed one',
        disposition: { type: 'wontfix', reason: longReason },
      },
      {
        file: 'b.ts',
        line: 2,
        summary: 'deferred one',
        disposition: { type: 'plan', planId: '2500' },
      },
      { file: 'c.ts', line: 3, summary: 'fixed one', disposition: { type: 'fixed' } },
      { file: 'd.ts', line: 4, summary: 'still open', disposition: null },
    ],
  };
  const { entries, dropped } = extractDispositionedFindings(rec);
  assert.equal(dropped, 0);
  assert.equal(entries.length, 2);
  const wontfix = entries.find((e) => e.type === 'wontfix');
  assert.equal(wontfix.file, 'a.ts');
  assert.equal(wontfix.reason.length, 200);
  const plan = entries.find((e) => e.type === 'plan');
  assert.equal(plan.reason, '2500');
});

// plan 3623 item 3: deferred-by-tag was a first-class disposition type as of plan 3545 but was
// never read back — every advisory finding auto-cleared by isMustFixFinding's tag axis in round N
// was invisible to round N+1's finders and got re-found and re-verified from scratch.
test('extractDispositionedFindings: deferred-by-tag is admitted, carrying its own reason string (not a planId)', () => {
  const rec = {
    findings: [
      {
        file: 'a.ts',
        line: 1,
        summary: 'tagged advisory',
        disposition: {
          type: 'deferred-by-tag',
          preExisting: true,
          blocksLand: false,
          reason: 'preExisting=true: still there without this diff; blocksLand=false: cosmetic',
        },
      },
    ],
  };
  const { entries, dropped } = extractDispositionedFindings(rec);
  assert.equal(dropped, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'deferred-by-tag');
  assert.equal(
    entries[0].reason,
    'preExisting=true: still there without this diff; blocksLand=false: cosmetic',
  );
});

test('extractDispositionedFindings: caps at 120, dropped count reflects the excess, newest (tail) entries survive', () => {
  const findings = Array.from({ length: 130 }, (_, i) => ({
    file: 'a.ts',
    line: i,
    summary: `S${i}`,
    disposition: { type: 'wontfix', reason: `R${i}` },
  }));
  const { entries, dropped } = extractDispositionedFindings({ findings });
  assert.equal(dropped, 10);
  assert.equal(entries.length, 120);
  // the tail of the input array survives — the first 10 (oldest) are dropped
  assert.equal(entries[0].line, 10);
  assert.equal(entries[entries.length - 1].line, 129);
});

test('buildDispositionsBlock: empty entries -> empty string; non-empty -> pinned heading + instruction + one line per entry', () => {
  assert.equal(buildDispositionsBlock([]), '');
  const block = buildDispositionsBlock([
    { file: 'a.ts', line: 5, summary: 'S1', type: 'wontfix', reason: 'by design' },
    { file: 'b.ts', line: null, summary: 'S2', type: 'plan', reason: '2500' },
  ]);
  assert.match(block, /## Already dispositioned in earlier review rounds/);
  assert.match(block, /do not re-report these unless the diff/i);
  assert.match(block, /a\.ts:5 — S1 \[wontfix: by design\]/);
  assert.match(block, /b\.ts — S2 \[plan: 2500\]/);
});

test('resolveDispositionsBlock: an absent sidecar injects nothing (the normal first-round case)', () => {
  const logs = [];
  const out = resolveDispositionsBlock({ absent: true }, 'my-slug', { logFn: (m) => logs.push(m) });
  assert.equal(out, '');
  assert.equal(logs.length, 0);
});

test('resolveDispositionsBlock: a PARSE/IO failure on an EXISTING sidecar is WARNED and injects nothing — never treated as absent', () => {
  const logs = [];
  const out = resolveDispositionsBlock({ refuse: 'REFUSED — could not read it' }, 'my-slug', {
    logFn: (m) => logs.push(m),
  });
  assert.equal(out, '');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /REFUSED — could not read it/);
});

test('resolveDispositionsBlock: a sidecar slug mismatch SKIPS injection with a warning (plan-2838 sibling-sidecar guard)', () => {
  const logs = [];
  const rec = {
    slug: 'someone-elses-slug',
    findings: [
      { file: 'a.ts', line: 1, summary: 'S', disposition: { type: 'wontfix', reason: 'R' } },
    ],
  };
  const out = resolveDispositionsBlock({ rec }, 'my-slug', { logFn: (m) => logs.push(m) });
  assert.equal(out, '');
  assert.ok(logs.some((m) => /sibling-sidecar/.test(m)));
});

test('resolveDispositionsBlock: a matching-slug sidecar with dispositioned findings injects the block and logs the carried count', () => {
  const logs = [];
  const rec = {
    slug: 'my-slug',
    findings: [
      { file: 'a.ts', line: 1, summary: 'S', disposition: { type: 'wontfix', reason: 'R' } },
    ],
  };
  const out = resolveDispositionsBlock({ rec }, 'my-slug', { logFn: (m) => logs.push(m) });
  assert.match(out, /## Already dispositioned in earlier review rounds/);
  assert.ok(logs.some((m) => /carrying 1 prior disposition/.test(m)));
});

test('resolveDispositionsBlock: logs the dropped count when the cap trims (no silent caps)', () => {
  const logs = [];
  const findings = Array.from({ length: 121 }, (_, i) => ({
    file: 'a.ts',
    line: i,
    summary: `S${i}`,
    disposition: { type: 'wontfix', reason: 'R' },
  }));
  const out = resolveDispositionsBlock({ rec: { slug: 'my-slug', findings } }, 'my-slug', {
    logFn: (m) => logs.push(m),
  });
  assert.ok(out.length > 0);
  assert.ok(logs.some((m) => /capped at 120 — dropped 1/.test(m)));
});

// ── Prompt-parity drift guard against .claude/workflows/sonnet-review.js ────
// The 9 shared angle texts, the verdict ladders, and CLEANUP_PRECEDENCE are
// byte-copied between the two review lanes because the Workflow sandbox has no
// module imports — a shared module is impossible on the sonnet-review.js side.
// This test is the drift guard: the workflow declares each constant as a
// one-line JSON literal (`const NAME = <json>`), so we extract and JSON.parse
// the workflow's VALUE and compare it to this module's exported value.
// A failure means someone tuned one lane's prompt without the other.
const WORKFLOW_PATH = fileURLToPath(
  new URL('../.claude/workflows/sonnet-review.js', import.meta.url),
);
// The isolated-plan-repo scaffold copies only scripts/ — the workflow file is
// absent there; parity is only checkable in the real repo.
const WORKFLOW_SRC = existsSync(WORKFLOW_PATH) ? readFileSync(WORKFLOW_PATH, 'utf8') : null;

// The vendored workflow is import-free by design, so these probes RUN it through AsyncFunction
// rather than importing it — which means its one `export` keyword has to come off first.
// plan 3623 round 3 finding de6f03: an exact-string strip tied that to one spelling, so
// `export const meta=` would leave an export statement inside the function body and throw,
// failing the scripts battery on a behaviour-preserving reformat. Match the keyword, not the
// formatting, and prove nothing else survives.
function runnableWorkflowSource() {
  const source = WORKFLOW_SRC.replace(/^\s*export\s+(?=const\s+meta\b)/m, '');
  assert.doesNotMatch(
    source,
    /^\s*export\s/m,
    'the vendored workflow carries an export statement this probe cannot strip',
  );
  return source;
}

// ─── plan 2936 T3 — drift check against .claude/workflows/sonnet-review.js ──
test(
  'SEVERITY_FLOOR_NOTE: byte-identical copy present in .claude/workflows/sonnet-review.js',
  { skip: WORKFLOW_SRC === null ? 'sonnet-review.js absent (isolated scripts/ copy)' : false },
  () => {
    assert.ok(
      WORKFLOW_SRC.includes(SEVERITY_FLOOR_NOTE),
      'SEVERITY_FLOOR_NOTE drifted from .claude/workflows/sonnet-review.js — edit both or neither.',
    );
  },
);

test('GROUP_VERDICT_SCHEMA: requires verdict tags with one-line reasons', () => {
  const item = GROUP_VERDICT_SCHEMA.properties.verdicts.items;
  for (const key of ['preExisting', 'preExistingWhy', 'blocksLand', 'blocksLandWhy'])
    assert.ok(item.required.includes(key), `${key} must be required`);
  assert.equal(item.properties.preExisting.type, 'boolean');
  assert.equal(item.properties.blocksLand.type, 'boolean');
  assert.equal(item.properties.preExistingWhy.type, 'string');
  assert.equal(item.properties.blocksLandWhy.type, 'string');
  assert.equal(item.properties.preExistingWhy.pattern, '^[^\\r\\n]+$');
  assert.equal(item.properties.blocksLandWhy.pattern, '^[^\\r\\n]+$');
});

// plan 3623 finding cf8d04: the schema must declare exactly what verifyOnce actually enforces
// (`Number.isInteger(v.index)`, scripts/gpt-review.mjs ~2932) — `type: 'number'` schema-validated
// a fractional index the verifier then silently discarded, so this ties the two together and
// fails the moment they drift again.
test("GROUP_VERDICT_SCHEMA: index is declared integer, matching verifyOnce's Number.isInteger guard", () => {
  assert.equal(GROUP_VERDICT_SCHEMA.properties.verdicts.items.properties.index.type, 'integer');
});

test(
  'FINDING_TAG_NOTE: byte-identical copy present in .claude/workflows/sonnet-review.js',
  { skip: WORKFLOW_SRC === null ? 'sonnet-review.js absent (isolated scripts/ copy)' : false },
  () => {
    assert.ok(
      WORKFLOW_SRC.includes(JSON.stringify(FINDING_TAG_NOTE)),
      'FINDING_TAG_NOTE drifted from .claude/workflows/sonnet-review.js — edit both or neither.',
    );
  },
);

test(
  'GROUP_VERDICT_SCHEMA: byte-identical JSON string copy present in .claude/workflows/sonnet-review.js',
  { skip: WORKFLOW_SRC === null ? 'sonnet-review.js absent (isolated scripts/ copy)' : false },
  () => {
    assert.ok(
      WORKFLOW_SRC.includes(JSON.stringify(GROUP_VERDICT_SCHEMA_JSON)),
      'GROUP_VERDICT_SCHEMA drifted from .claude/workflows/sonnet-review.js — edit both or neither.',
    );
  },
);

// ─── plan 3623 item 3 — deferred-by-tag is a read-back prior disposition in BOTH lanes ──────
// Behavioural, not source-parsed, for THIS module's own admitted set: extractDispositionedFindings
// is the code under test, so calling it is the honest check, not re-deriving its filter by regex.
function gptReviewAdmittedTypes() {
  const dispositions = [
    { type: 'wontfix', reason: 'r' },
    { type: 'plan', planId: '1' },
    { type: 'deferred-by-tag', reason: 'r', preExisting: true, blocksLand: false },
    { type: 'fixed' },
  ];
  const rec = {
    findings: dispositions.map((d, i) => ({
      file: 'a.ts',
      line: i,
      summary: `S${i}`,
      disposition: d,
    })),
  };
  return extractDispositionedFindings(rec).entries.map((e) => e.type);
}

// plan 3623 finding 88a876: the OLD helper here regex-parsed the workflow's `.filter(d => d &&
// (...) && typeof d.reason` runtime expression — a behaviour-preserving reformat (multiline, or
// switching to `.includes(...)`) made the regex match null and threw, blocking the scripts
// battery on correct code. This drives the vendored (import-free) workflow through the SAME
// AsyncFunction technique the "sonnet-review workflow: ..." tests below already use, and reads
// what its runtime filter actually ADMITS: a scope agent hands back one priorDispositions entry
// per candidate type (including two that must NOT be admitted — `fixed` and a bogus type), and
// this returns the subset whose distinguishing summary text actually reached a finder prompt's
// "Already dispositioned" block — the real admission gate, not a re-derivation of its source text.
const PRIOR_DISPOSITION_PROBES = [
  { type: 'wontfix', file: 'a.mjs', summary: 'probe-3623-wontfix', reason: 'not fixing this' },
  { type: 'plan', file: 'a.mjs', summary: 'probe-3623-plan', reason: '3600' },
  {
    type: 'deferred-by-tag',
    file: 'a.mjs',
    summary: 'probe-3623-deferred',
    reason: 'pre-existing',
  },
  { type: 'fixed', file: 'a.mjs', summary: 'probe-3623-fixed', reason: 'done' },
  { type: 'bogus-type', file: 'a.mjs', summary: 'probe-3623-bogus', reason: 'whatever' },
];
async function workflowRuntimeAdmittedTypes() {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runnableSource = runnableWorkflowSource();
  const runWorkflow = new AsyncFunction(
    'agent',
    'parallel',
    'phase',
    'log',
    'args',
    runnableSource,
  );
  let finderPrompt = null;
  let scopeSchema = null;
  const agent = async (prompt, options) => {
    if (options.label === 'scope') {
      scopeSchema = options.schema;
      return {
        diffCommand: 'git diff HEAD~1',
        files: ['scripts/a.mjs'],
        summary: 'one change',
        conventions: '',
        claudeMdFiles: [],
        priorDispositions: PRIOR_DISPOSITION_PROBES,
      };
    }
    if (options.phase === 'Find') {
      if (finderPrompt === null) finderPrompt = prompt; // identical across every finder angle
      return { candidates: [] };
    }
    assert.fail(`unexpected workflow agent call: ${options.label}`);
  };
  await runWorkflow(
    agent,
    async (tasks) => Promise.all(tasks.map((task) => task())),
    () => {},
    () => {},
    'high',
  );
  assert.ok(finderPrompt, 'no finder prompt captured — the workflow shape changed');
  // plan 3623 round 2 finding f9c2a4: the schema enum is read off the REAL object the workflow
  // hands its scope agent, not scraped out of the file's source text. Wrapping that enum across
  // lines used to null the regex and fail the battery on a behaviour-preserving reformat.
  const schemaTypes =
    scopeSchema?.properties?.priorDispositions?.items?.properties?.type?.enum ?? null;
  assert.ok(
    Array.isArray(schemaTypes),
    'SCOPE_SCHEMA.priorDispositions.items.properties.type.enum missing from the schema the workflow passed its scope agent',
  );
  // plan 3623 round 3 finding 7f16c9: read admission from the "Already dispositioned" BLOCK, not
  // from the whole prompt. A probe summary echoed anywhere else (the scope summary, a future
  // section that lists the raw scope answer) would otherwise count as admitted, and a real
  // prior-disposition contract drift could pass this agreement test on a coincidence.
  const heading = '## Already dispositioned in earlier review rounds';
  const start = finderPrompt.indexOf(heading);
  assert.ok(
    start >= 0,
    'the finder prompt carries no "Already dispositioned" block — the workflow shape changed',
  );
  const after = finderPrompt.indexOf('\n## ', start + heading.length);
  const block = finderPrompt.slice(start, after === -1 ? undefined : after);
  return {
    schemaTypes,
    admittedTypes: PRIOR_DISPOSITION_PROBES.filter((d) => block.includes(d.summary)).map(
      (d) => d.type,
    ),
  };
}

test(
  'prior-disposition ADMITTED type set: gpt-review lane, sonnet-review SCOPE_SCHEMA enum, and its RUNTIME filter all agree',
  { skip: WORKFLOW_SRC === null ? 'sonnet-review.js absent (isolated scripts/ copy)' : false },
  async () => {
    const gptTypes = gptReviewAdmittedTypes().slice().sort();
    const workflow = await workflowRuntimeAdmittedTypes();
    const schemaTypes = workflow.schemaTypes.slice().sort();
    const runtimeTypes = workflow.admittedTypes.slice().sort();
    assert.deepEqual(
      gptTypes,
      schemaTypes,
      'extractDispositionedFindings (gpt-review.mjs) and SCOPE_SCHEMA.priorDispositions.type (sonnet-review.js) disagree on the admitted disposition types.',
    );
    assert.deepEqual(
      gptTypes,
      runtimeTypes,
      'extractDispositionedFindings (gpt-review.mjs) and the RUNTIME priorDispositions filter (sonnet-review.js) disagree on the admitted disposition types.',
    );
  },
);

test(
  'sonnet-review workflow: a pre-existing correctness verdict reaches the written finding output with its kind',
  { skip: WORKFLOW_SRC === null ? 'sonnet-review.js absent (isolated scripts/ copy)' : false },
  async () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const runnableSource = runnableWorkflowSource();
    const runWorkflow = new AsyncFunction(
      'agent',
      'parallel',
      'phase',
      'log',
      'args',
      runnableSource,
    );
    let emittedCandidate = false;
    const agent = async (_prompt, options) => {
      if (options.label === 'scope') {
        return {
          diffCommand: 'git diff HEAD~1',
          files: ['scripts/a.mjs'],
          summary: 'one test change',
          conventions: '',
          claudeMdFiles: [],
          priorDispositions: [],
        };
      }
      if (options.phase === 'Find') {
        if (emittedCandidate) return { candidates: [] };
        emittedCandidate = true;
        return {
          candidates: [
            {
              file: 'scripts/a.mjs',
              line: 7,
              summary: 'tagged defect',
              failure_scenario: 'the caller receives a wrong value',
            },
          ],
        };
      }
      if (options.phase === 'Verify') {
        return {
          verdicts: [
            {
              index: 0,
              verdict: 'CONFIRMED',
              evidence: 'line 7 returns the stale value',
              preExisting: true,
              preExistingWhy: 'line 7 is outside the reviewed plus side',
              blocksLand: true,
              blocksLandWhy: 'the target API returns a wrong value',
            },
          ],
        };
      }
      if (options.label === 'synthesize') {
        return { summary: 'one confirmed finding', decisions: [{ index: 0 }] };
      }
      assert.fail(`unexpected workflow agent call: ${options.label}`);
    };
    const result = await runWorkflow(
      agent,
      async (tasks) => Promise.all(tasks.map((task) => task())),
      () => {},
      () => {},
      'high',
    );

    assert.deepEqual(
      {
        kind: result.findings[0].kind,
        evidence: result.findings[0].evidence,
        preExisting: result.findings[0].preExisting,
        preExistingWhy: result.findings[0].preExistingWhy,
        blocksLand: result.findings[0].blocksLand,
        blocksLandWhy: result.findings[0].blocksLandWhy,
      },
      {
        kind: 'correctness',
        evidence: 'line 7 returns the stale value',
        preExisting: true,
        preExistingWhy: 'line 7 is outside the reviewed plus side',
        blocksLand: true,
        blocksLandWhy: 'the target API returns a wrong value',
      },
    );
  },
);

test(
  'sonnet-review workflow: merged findings promote the most-blocking tags and their source reasons',
  { skip: WORKFLOW_SRC === null ? 'sonnet-review.js absent (isolated scripts/ copy)' : false },
  async () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const runnableSource = runnableWorkflowSource();
    const runWorkflow = new AsyncFunction(
      'agent',
      'parallel',
      'phase',
      'log',
      'args',
      runnableSource,
    );
    const agent = async (_prompt, options) => {
      if (options.label === 'scope') {
        return {
          diffCommand: 'git diff HEAD~1',
          files: ['scripts/a.mjs', 'scripts/b.mjs', 'scripts/c.mjs'],
          summary: 'three related findings',
          conventions: '',
          claudeMdFiles: [],
          priorDispositions: [],
        };
      }
      if (options.phase === 'Find') {
        if (options.label === 'angle-A') {
          return {
            candidates: [
              {
                file: 'scripts/a.mjs',
                line: 7,
                summary: 'advisory primary',
                failure_scenario: 'the warning is vague',
              },
            ],
          };
        }
        if (options.label === 'reuse') {
          return {
            candidates: [
              {
                file: 'scripts/b.mjs',
                line: 9,
                summary: 'blocking sibling',
                failure_scenario: 'the land gate reports success',
              },
            ],
          };
        }
        if (options.label === 'simplification') {
          return {
            candidates: [
              {
                file: 'scripts/c.mjs',
                line: 11,
                summary: 'most-blocking sibling',
                failure_scenario: 'the defect ships in the reviewed change',
              },
            ],
          };
        }
        return { candidates: [] };
      }
      if (options.phase === 'Verify') {
        const confirmedSibling = options.label.includes('b.mjs');
        const blockingSibling = options.label.includes('c.mjs');
        return {
          verdicts: [
            confirmedSibling
              ? {
                  index: 0,
                  verdict: 'CONFIRMED',
                  evidence: 'b.mjs:9 bypasses the gate',
                  preExisting: true,
                  preExistingWhy: 'b.mjs:9 is outside the reviewed plus side',
                  blocksLand: false,
                  blocksLandWhy: 'b.mjs:9 only affects diagnostic text',
                }
              : blockingSibling
                ? {
                    index: 0,
                    verdict: 'PLAUSIBLE',
                    evidence: 'c.mjs:11 leaves the defect live',
                    preExisting: false,
                    preExistingWhy: 'c.mjs:11 is on the reviewed plus side',
                    blocksLand: true,
                    blocksLandWhy: 'the target land gate reports false success',
                  }
                : {
                    index: 0,
                    verdict: 'PLAUSIBLE',
                    evidence: 'a.mjs:7 has vague warning text',
                    preExisting: true,
                    preExistingWhy: 'a.mjs:7 is outside the reviewed plus side',
                    blocksLand: false,
                    blocksLandWhy: 'warning text alone does not block the land',
                  },
          ],
        };
      }
      if (options.label === 'synthesize') {
        return { summary: 'merged root cause', decisions: [{ index: 0, merge: [1, 2] }] };
      }
      assert.fail(`unexpected workflow agent call: ${options.label}`);
    };

    const result = await runWorkflow(
      agent,
      async (tasks) => Promise.all(tasks.map((task) => task())),
      () => {},
      () => {},
      'high',
    );

    assert.deepEqual(
      {
        verdict: result.findings[0].verdict,
        evidence: result.findings[0].evidence,
        preExisting: result.findings[0].preExisting,
        preExistingWhy: result.findings[0].preExistingWhy,
        blocksLand: result.findings[0].blocksLand,
        blocksLandWhy: result.findings[0].blocksLandWhy,
      },
      {
        verdict: 'CONFIRMED',
        evidence: 'b.mjs:9 bypasses the gate',
        preExisting: false,
        preExistingWhy: 'c.mjs:11 is on the reviewed plus side',
        blocksLand: true,
        blocksLandWhy: 'the target land gate reports false success',
      },
    );
  },
);

test('groupVerifierPrompt: includes the shared finding-tag definitions', () => {
  const prompt = groupVerifierPrompt('scope', [
    { file: 'scripts/a.mjs', line: 1, summary: 'bug', failure_scenario: 'wrong output' },
  ]);
  assert.ok(prompt.includes(FINDING_TAG_NOTE));
});

function workflowConst(name) {
  const m = WORKFLOW_SRC.match(new RegExp(`^const ${name} = (.*?);?$`, 'm'));
  assert.ok(m, `const ${name} not found as a one-line JSON literal in sonnet-review.js`);
  return JSON.parse(m[1]);
}

// Derived from the runner's own arrays — a new/renamed shared angle is
// parity-checked automatically (only the data-grounding pair is gpt-only).
const SHARED_ANGLE_LABELS = [...CORRECTNESS_ANGLES, ...CLEANUP_ANGLES].map((a) => a.label);

test(
  'prompt parity: the 9 sonnet-review angle texts are byte-identical in both lanes',
  { skip: WORKFLOW_SRC === null ? 'sonnet-review.js absent (isolated scripts/ copy)' : false },
  () => {
    const wfByLabel = new Map(
      [...workflowConst('CORRECTNESS_ANGLES'), ...workflowConst('CLEANUP_ANGLES')].map((a) => [
        a.label,
        a.text,
      ]),
    );
    const mineByLabel = new Map(
      [...CORRECTNESS_ANGLES, ...CLEANUP_ANGLES].map((a) => [a.label, a.text]),
    );
    for (const label of SHARED_ANGLE_LABELS) {
      assert.ok(wfByLabel.has(label), `angle "${label}" missing from sonnet-review.js`);
      assert.equal(
        mineByLabel.get(label),
        wfByLabel.get(label),
        `angle "${label}" text drifted from .claude/workflows/sonnet-review.js — ` +
          'the two lanes must review through identical angle prompts; re-sync the edited side.',
      );
    }
  },
);

test(
  'prompt parity: VERDICT_LADDER / VERDICT_LADDER_RECALL / CLEANUP_PRECEDENCE match the workflow',
  { skip: WORKFLOW_SRC === null ? 'sonnet-review.js absent (isolated scripts/ copy)' : false },
  () => {
    const mine = {
      VERDICT_LADDER,
      VERDICT_LADDER_RECALL,
      CLEANUP_PRECEDENCE,
    };
    for (const name of Object.keys(mine)) {
      assert.equal(
        mine[name],
        workflowConst(name),
        `${name} drifted from .claude/workflows/sonnet-review.js — re-sync the edited side.`,
      );
    }
  },
);

// ─── plan 2957 T2 — the materialized-diff header is byte-identical in both lanes ──
// The workflow cannot import this module, so it vendors the wording as a one-line
// JSON literal with {diffPatchPath}/{headSha} placeholders (a raw `WORKFLOW_SRC.includes`
// check, the SEVERITY_FLOOR_NOTE pattern, cannot cover an interpolating string). Render the
// vendored template with fixed values and assert equality with what `buildScopeBlock`
// actually emits — so a reworded orientation sentence on either side fails the push.
test(
  'prompt parity: the materialized-diff + orientation lines match the workflow (plan 2957 T2)',
  { skip: WORKFLOW_SRC === null ? 'sonnet-review.js absent (isolated scripts/ copy)' : false },
  () => {
    const diffPatchPath = '/abs/out/diff.patch';
    const headSha = 'cafef00d';
    // Rendered exactly the way the workflow renders it: ONE left-to-right pass with a
    // function replacer, so a substituted value is never re-scanned or re-read as a
    // replacement pattern.
    const rendered = workflowConst('DIFF_ORIENTATION_TEMPLATE').replace(
      /\{diffPatchPath\}|\{headSha\}/g,
      (m) => (m === '{headSha}' ? headSha : diffPatchPath),
    );
    assert.doesNotMatch(
      rendered,
      /\{diffPatchPath\}|\{headSha\}/,
      'the workflow template left a placeholder unsubstituted — its placeholder names drifted.',
    );
    const block = buildScopeBlock({
      diffPatchPath,
      headSha,
      files: ['a.ts'],
      claudeMdFiles: [],
      summary: 'S',
      conventions: 'C',
      target: '',
    });
    // Byte-identity AND position: the two lines follow the '## Review scope' header in both
    // lanes, so a substring match alone would pass if either side moved them.
    assert.ok(
      block.startsWith('## Review scope\n' + rendered),
      'the diff-file/orientation lines drifted from .claude/workflows/sonnet-review.js — ' +
        'both lanes must state the diff artifact and its +/- orientation identically; ' +
        're-sync the edited side.',
    );
  },
);

// ─── plan 2665: cloud codex self-bootstrap ──────────────────────────────────
// Pure-parts testing only, per the header contract: authPath/installFn/env are
// injected, so no real HOME write, no real npm install, no codex spawn.
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join as joinPath, dirname } from 'node:path';
import { createHash } from 'node:crypto';

test('ensureCodexBootstrap: no CODEX_LOGIN_B64 → pure no-op (the local-machine case)', () => {
  const calls = [];
  const res = ensureCodexBootstrap({
    env: {},
    authPath: joinPath(tmpdir(), 'never-created', 'auth.json'),
    installFn: () => calls.push('install'),
    probeFn: () => calls.push('probe'),
    logFn: () => {},
  });
  assert.deepEqual(res, { wroteAuth: false, installed: false, wroteTrust: false });
  assert.equal(calls.length, 0);
  assert.equal(existsSync(joinPath(tmpdir(), 'never-created', 'auth.json')), false);
});

// --- plan 3380: cloud hook-trust seeding. A full-egress sandbox has no ~/.codex/config.toml,
// so codex loads no project trust, so .codex/hooks.json never loads and every context
// injection hook fires SILENTLY dark. The safety property these guard is the inverse of the
// feature: a LOCAL machine (no CODEX_LOGIN_B64) must never have its real config touched.

test('ensureCodexProjectTrust: no CODEX_LOGIN_B64 → never writes (the local machine keeps its real trust entries)', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-trust-'));
  try {
    const configPath = joinPath(dir, 'config.toml');
    const res = ensureCodexProjectTrust({
      env: {},
      configPath,
      trustRoot: '/home/user/vetapp',
      logFn: () => {},
    });
    assert.deepEqual(res, { wroteTrust: false });
    assert.equal(existsSync(configPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCodexProjectTrust: an existing config.toml that lacks this project is APPENDED to, never rewritten (skipping it entirely left the sandbox silently dark)', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-trust-'));
  try {
    const configPath = joinPath(dir, 'config.toml');
    const preexisting = '[projects."C:\\\\real"]\ntrust_level = "trusted"\n';
    writeFileSync(configPath, preexisting);
    const res = ensureCodexProjectTrust({
      env: { CODEX_LOGIN_B64: 'x' },
      configPath,
      trustRoot: '/home/user/vetapp',
      logFn: () => {},
    });
    assert.equal(res.wroteTrust, true);
    const after = readFileSync(configPath, 'utf8');
    // The operator's own entry survives byte-for-byte, and ours is added after it.
    assert.ok(after.startsWith(preexisting));
    assert.match(after, /\[projects\."\/home\/user\/vetapp"\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCodexProjectTrust: a config.toml that ALREADY trusts this project is left completely alone (no duplicate table, which TOML rejects)', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-trust-'));
  try {
    const configPath = joinPath(dir, 'config.toml');
    const preexisting = '[projects."/home/user/vetapp"]\ntrust_level = "trusted"\n';
    writeFileSync(configPath, preexisting);
    const res = ensureCodexProjectTrust({
      env: { CODEX_LOGIN_B64: 'x' },
      configPath,
      trustRoot: '/home/user/vetapp',
      logFn: () => {},
    });
    assert.deepEqual(res, { wroteTrust: false });
    assert.equal(readFileSync(configPath, 'utf8'), preexisting);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureCodexProjectTrust: codex's own single-quoted [projects.'…'] spelling also counts as already-trusted (a second table for one path is a TOML parse error)", () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-trust-'));
  try {
    const configPath = joinPath(dir, 'config.toml');
    const preexisting = '[projects.\'/home/user/vetapp\']\ntrust_level = "trusted"\n';
    writeFileSync(configPath, preexisting);
    const res = ensureCodexProjectTrust({
      env: { CODEX_LOGIN_B64: 'x' },
      configPath,
      trustRoot: '/home/user/vetapp',
      logFn: () => {},
    });
    assert.deepEqual(res, { wroteTrust: false });
    assert.equal(readFileSync(configPath, 'utf8'), preexisting);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('projectTrustState: presence is not trust — a table with trust_level "untrusted" reports present, and seeding leaves it alone rather than overriding a deliberate decision', () => {
  const cfg = '[projects."/home/user/vetapp"]\ntrust_level = "untrusted"\n';
  assert.equal(projectTrustState(cfg, '/home/user/vetapp'), 'present');
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-trust-'));
  try {
    const configPath = joinPath(dir, 'config.toml');
    writeFileSync(configPath, cfg);
    const res = ensureCodexProjectTrust({
      env: { CODEX_LOGIN_B64: 'x' },
      configPath,
      trustRoot: '/home/user/vetapp',
      logFn: () => {},
    });
    assert.deepEqual(res, { wroteTrust: false });
    // Neither overridden nor duplicated (a second table for one path is a TOML parse error).
    assert.equal(readFileSync(configPath, 'utf8'), cfg);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('projectTrustState: the table name inside a COMMENT is not a match (a raw substring scan read it as already-trusted and skipped seeding forever)', () => {
  const cfg =
    '# see [projects."/home/user/vetapp"] for the shape\n[projects."/other"]\ntrust_level = "trusted"\n';
  assert.equal(projectTrustState(cfg, '/home/user/vetapp'), 'absent');
});

test('projectTrustState: a header with a trailing inline comment still matches (missing it would append a duplicate table and brick the config)', () => {
  const cfg = '[projects."/home/user/vetapp"]  # seeded by hand\ntrust_level = "trusted"\n';
  assert.equal(projectTrustState(cfg, '/home/user/vetapp'), 'trusted');
  assert.equal(
    projectTrustState('[projects."/home/user/vetapp"]#c\n', '/home/user/vetapp'),
    'present',
  );
});

test('projectTrustState: a LONGER path that merely starts with ours is not a match', () => {
  const cfg = '[projects."/home/user/vetapp-two"]\ntrust_level = "trusted"\n';
  assert.equal(projectTrustState(cfg, '/home/user/vetapp'), 'absent');
});

test("projectTrustState: recognizes codex's own single-quoted spelling as trusted", () => {
  const cfg = "[projects.'/home/user/vetapp']\ntrust_level = 'trusted'\n";
  assert.equal(projectTrustState(cfg, '/home/user/vetapp'), 'trusted');
});

test('projectTrustState: trust_level belonging to a LATER table does not leak into an earlier untrusted one', () => {
  const cfg = '[projects."/home/user/vetapp"]\n\n[projects."/other"]\ntrust_level = "trusted"\n';
  assert.equal(projectTrustState(cfg, '/home/user/vetapp'), 'present');
});

test('ensureCodexProjectTrust: a control character in the checkout path seeds nothing rather than writing unparseable TOML', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-trust-'));
  try {
    const configPath = joinPath(dir, 'config.toml');
    const res = ensureCodexProjectTrust({
      env: { CODEX_LOGIN_B64: 'x' },
      configPath,
      trustRoot: '/home/user/vet\napp',
      logFn: () => {},
    });
    assert.deepEqual(res, { wroteTrust: false });
    assert.equal(existsSync(configPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCodexProjectTrust: secret present + no config → writes the project-trust entry keyed on the MAIN checkout', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-trust-'));
  try {
    const configPath = joinPath(dir, 'nested', 'config.toml');
    const res = ensureCodexProjectTrust({
      env: { CODEX_LOGIN_B64: 'x' },
      configPath,
      trustRoot: '/home/user/vetapp',
      logFn: () => {},
    });
    assert.equal(res.wroteTrust, true);
    const body = readFileSync(configPath, 'utf8');
    assert.match(body, /\[projects\."\/home\/user\/vetapp"\]/);
    assert.match(body, /trust_level = "trusted"/);
    // atomicWriteTextSync leaves no temp behind (its own TMP_SEP naming).
    assert.deepEqual(readdirSync(joinPath(dir, 'nested')), ['config.toml']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCodexProjectTrust: a Windows main checkout is escaped as a TOML basic string', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-trust-'));
  try {
    const configPath = joinPath(dir, 'config.toml');
    ensureCodexProjectTrust({
      env: { CODEX_LOGIN_B64: 'x' },
      configPath,
      trustRoot: 'C:\\Users\\user\\vetapp',
      logFn: () => {},
    });
    // Each backslash doubled, so the TOML parses back to the original path.
    assert.match(readFileSync(configPath, 'utf8'), /\[projects\."C:\\\\Users\\\\user\\\\vetapp"\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCodexProjectTrust: an unresolvable main checkout seeds nothing rather than writing a bogus key', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-trust-'));
  try {
    const configPath = joinPath(dir, 'config.toml');
    const res = ensureCodexProjectTrust({
      env: { CODEX_LOGIN_B64: 'x' },
      configPath,
      trustRoot: null,
      logFn: () => {},
    });
    assert.deepEqual(res, { wroteTrust: false });
    assert.equal(existsSync(configPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The git-backed resolver itself, not just the injected-trustRoot paths above: every other
// test hand-supplies trustRoot, so without this the real code path ships unexercised (review
// 3380, claude-data-grounding arm). Runs against this repo's own checkout.
test('real git: resolveCodexTrustRoot resolves the MAIN checkout from a worktree as well as from the main checkout itself', () => {
  const here = dirname(fileURLToPath(import.meta.url)); // scripts/ of whichever checkout runs this
  const root = resolveCodexTrustRoot(here);
  assert.ok(root, 'expected a resolved trust root');
  // It is the checkout that OWNS the shared .git — so .git exists there (a dir in the main
  // checkout, a file in a linked worktree, hence existsSync rather than a type check), and it
  // is the same answer from any anchor inside the same repo.
  assert.ok(existsSync(joinPath(root, '.git')), `${root} should contain .git`);
  assert.equal(resolveCodexTrustRoot(joinPath(here, '..')), root);
});

test('resolveCodexTrustRoot: a non-repo anchor yields null rather than throwing (callers treat null as "seed nothing")', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-norepo-'));
  try {
    assert.equal(resolveCodexTrustRoot(joinPath(dir, 'does-not-exist')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codexHookTrustArgs: local (no secret) adds nothing; cloud adds the bypass AND pins approvals back to never', () => {
  assert.deepEqual(codexHookTrustArgs({}), []);
  // plan 3958 review (key 10k7z8u): the third param (`authEnvVar`) is passed explicitly here
  // so this test's assertion is independent of which coord.config.json the default `repoRoot`
  // (process.cwd()) happens to resolve against — see the dedicated "no override" test below for
  // the default-resolution behavior itself.
  const cloud = codexHookTrustArgs({ CODEX_LOGIN_B64: 'x' }, undefined, 'CODEX_LOGIN_B64');
  assert.deepEqual(cloud, ['--dangerously-bypass-hook-trust', '-c', 'approval_policy="never"']);
});

// plan 3958 review (key 10k7z8u): the whole point of the fix — a caller that omits BOTH the
// repoRoot and the authEnvVar override must still resolve the env-var name a project's
// coord.config.json actually configures, not the neutral literal. Built with a fixture repo
// dir (no git needed — loadCoordConfig only reads the JSON file) carrying a coord.config.json
// that names a THIRD, distinct env var — so this cannot pass by accident if the code fell back
// to either the generic default or the real vetapp repo's own configured name.
test("codexHookTrustArgs: with no authEnvVar override, resolves the name from repoRoot's coord.config.json", () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-cfg-'));
  try {
    writeFileSync(
      joinPath(dir, 'coord.config.json'),
      JSON.stringify({ codexAuthEnvVar: 'MY_PROJECT_CODEX_AUTH' }),
    );
    assert.deepEqual(
      codexHookTrustArgs({ CODEX_LOGIN_B64: 'x' }, dir),
      [],
      'wrong var unset ⇒ no bypass',
    );
    const cloud = codexHookTrustArgs({ MY_PROJECT_CODEX_AUTH: 'x' }, dir);
    assert.deepEqual(cloud, ['--dangerously-bypass-hook-trust', '-c', 'approval_policy="never"']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureCodexBootstrap: with no authEnvVar override, resolves the name from trustAnchor's coord.config.json", () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-cfg-boot-'));
  try {
    writeFileSync(
      joinPath(dir, 'coord.config.json'),
      JSON.stringify({ codexAuthEnvVar: 'MY_PROJECT_CODEX_AUTH' }),
    );
    const authPath = joinPath(dir, 'auth.json');
    const payload = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'fake-access-token-value',
        refresh_token: 'fake-refresh-token-value',
      },
    });
    const res = ensureCodexBootstrap({
      env: { MY_PROJECT_CODEX_AUTH: Buffer.from(payload).toString('base64') },
      authPath,
      trustAnchor: dir,
      installFn: () => {},
      probeFn: () => true,
      logFn: () => {},
      trustFn: () => ({ wroteTrust: false }),
    });
    assert.equal(
      res.wroteAuth,
      true,
      'the configured env var name must have been read, not CODEX_LOGIN_B64',
    );
    assert.equal(readFileSync(authPath, 'utf8'), payload);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCodexBootstrap: secret present + auth.json missing → decodes and writes it', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-boot-'));
  try {
    const authPath = joinPath(dir, '.codex', 'auth.json');
    // plan 4019: the bootstrap now validates before writing, so the fixture must be a
    // plausibly-SHAPED login (fake token values, never real ones) rather than an empty
    // `tokens: {}` — the exact shape the new gate exists to catch.
    const payload = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'fake-access-token-value',
        refresh_token: 'fake-refresh-token-value',
      },
    });
    const res = ensureCodexBootstrap({
      env: { CODEX_LOGIN_B64: Buffer.from(payload).toString('base64') },
      authPath,
      // plan 3958 review (key 10k7z8u): `authEnvVar` now defaults from `trustAnchor`'s coord
      // config rather than a neutral literal — `dir` carries no coord.config.json, so it
      // degrades to DEFAULT_CODEX_AUTH_ENV_VAR ('CODEX_LOGIN_B64'), matching this fixture,
      // without depending on the real repo's own config (ambient-state rule).
      trustAnchor: dir,
      installFn: () => {},
      probeFn: () => true,
      logFn: () => {},
      trustFn: () => ({ wroteTrust: false }),
    });
    assert.equal(res.wroteAuth, true);
    assert.equal(readFileSync(authPath, 'utf8'), payload);
    // Windows has no POSIX modes — assert 600 only where chmod is real.
    if (process.platform !== 'win32') {
      assert.equal(statSync(authPath).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCodexBootstrap: existing auth.json is never overwritten', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-boot-'));
  try {
    const authPath = joinPath(dir, 'auth.json');
    writeFileSync(authPath, 'existing-login');
    const res = ensureCodexBootstrap({
      env: { CODEX_LOGIN_B64: Buffer.from('new-login').toString('base64') },
      authPath,
      trustAnchor: dir, // plan 3958 review (key 10k7z8u) — see the first bootstrap test's comment
      installFn: () => {},
      probeFn: () => true,
      logFn: () => {},
      trustFn: () => ({ wroteTrust: false }),
    });
    assert.equal(res.wroteAuth, false);
    assert.equal(readFileSync(authPath, 'utf8'), 'existing-login');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 4019: the repair path this plan adds. An existing file is no longer trusted blindly — it
// is validated, and only a file that FAILS validation may be replaced, and only when the env
// value is itself valid.
const FAKE_VALID_AUTH = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: { access_token: 'fake-access-token-value', refresh_token: 'fake-refresh-token-value' },
});

test('ensureCodexBootstrap: a pre-existing but INVALID auth.json is REPLACED when CODEX_LOGIN_B64 is valid (the repair path)', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-boot-'));
  try {
    const authPath = joinPath(dir, 'auth.json');
    // Torn/truncated — not even valid JSON, the shape a killed write leaves behind.
    writeFileSync(authPath, '{"tokens": {"access_todummy');
    const logs = [];
    const res = ensureCodexBootstrap({
      env: { CODEX_LOGIN_B64: Buffer.from(FAKE_VALID_AUTH).toString('base64') },
      authPath,
      trustAnchor: dir, // plan 3958 review (key 10k7z8u) — see the first bootstrap test's comment
      installFn: () => {},
      probeFn: () => true,
      logFn: (m) => logs.push(m),
      trustFn: () => ({ wroteTrust: false }),
    });
    assert.equal(res.wroteAuth, true);
    assert.equal(readFileSync(authPath, 'utf8'), FAKE_VALID_AUTH);
    assert.ok(logs.some((m) => m.includes('existing') && m.includes('failed validation')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCodexBootstrap: a VALID existing auth.json is left alone even when CODEX_LOGIN_B64 is invalid (nothing to replace it WITH)', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-boot-'));
  try {
    const authPath = joinPath(dir, 'auth.json');
    writeFileSync(authPath, FAKE_VALID_AUTH);
    const logs = [];
    const res = ensureCodexBootstrap({
      env: { CODEX_LOGIN_B64: Buffer.from('not valid json at all').toString('base64') },
      authPath,
      trustAnchor: dir, // plan 3958 review (key 10k7z8u) — see the first bootstrap test's comment
      installFn: () => {},
      probeFn: () => true,
      logFn: (m) => logs.push(m),
      trustFn: () => ({ wroteTrust: false }),
    });
    assert.equal(res.wroteAuth, false);
    assert.equal(readFileSync(authPath, 'utf8'), FAKE_VALID_AUTH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCodexBootstrap: BOTH the existing file and the env value invalid → refuses to write, says so loudly, leaves the file untouched', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-boot-'));
  try {
    const authPath = joinPath(dir, 'auth.json');
    writeFileSync(authPath, 'not json either');
    const logs = [];
    const res = ensureCodexBootstrap({
      env: { CODEX_LOGIN_B64: Buffer.from('also not json').toString('base64') },
      authPath,
      trustAnchor: dir, // plan 3958 review (key 10k7z8u) — see the first bootstrap test's comment
      installFn: () => {},
      probeFn: () => true,
      logFn: (m) => logs.push(m),
      trustFn: () => ({ wroteTrust: false }),
    });
    assert.equal(res.wroteAuth, false);
    assert.equal(readFileSync(authPath, 'utf8'), 'not json either');
    assert.ok(logs.some((m) => m.includes('CODEX_LOGIN_B64 failed validation')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 4019 fix round 1, G2 (findings 44f3e6/e9ce1f, both blocking): shape validation alone
// accepted an EXPIRED but well-formed access token as "valid" and left it in place — reproducing
// the original bug one level up (the file looks fine and codex 401s three minutes later).
function fakeJwt(payload) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.fake-signature`;
}

test('ensureCodexBootstrap: an existing auth.json that is shape-VALID but has an EXPIRED access token is REPLACED, not kept (fix round 1, G2)', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-boot-'));
  try {
    const authPath = joinPath(dir, 'auth.json');
    const now = Date.UTC(2026, 8, 14, 12, 0, 0); // 2026-09-14T12:00:00Z
    const expiredAuth = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: fakeJwt({ exp: Math.floor(now / 1000) - 1 }),
        refresh_token: 'fake-refresh-token-value',
      },
    });
    writeFileSync(authPath, expiredAuth);
    const logs = [];
    const res = ensureCodexBootstrap({
      env: { CODEX_LOGIN_B64: Buffer.from(FAKE_VALID_AUTH).toString('base64') },
      authPath,
      trustAnchor: dir, // plan 3958 review (key 10k7z8u) — see the first bootstrap test's comment
      now,
      installFn: () => {},
      probeFn: () => true,
      logFn: (m) => logs.push(m),
      trustFn: () => ({ wroteTrust: false }),
    });
    assert.equal(res.wroteAuth, true);
    assert.equal(readFileSync(authPath, 'utf8'), FAKE_VALID_AUTH);
    assert.ok(logs.some((m) => m.includes('failed validation') && m.includes('expired')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (The opaque-non-JWT-token-is-unknown-not-expired half of G2's ruling is already covered by
// "ensureCodexBootstrap: existing auth.json is never overwritten" and the repair-path tests
// above, whose fixtures all use a plain (non-JWT) access_token string and rely on staying
// `existingValid: true` — accessTokenExpiry's own opaque-token contract has its dedicated test
// in codex-auth-check.test.mjs, imported here rather than re-asserted.)

// plan 4019 fix round 2, H1 (findings 7a1326/468217/d7fb7b — three angles, one root cause): G2
// above added expiry checking for the EXISTING file, but the ENV value (`CODEX_LOGIN_B64`) still
// went through shape-only `decodeAuthB64` — so a fresh sandbox with no auth.json, or one whose
// existing file was already invalid, could still have an expired-but-well-formed env token
// WRITTEN, reproducing the exact "looks fine, 401s three minutes later" bug this plan exists to
// close, one level up. The fix folds the same expiry rule into the env check via the shared
// `authPayloadReason` helper (codex-auth-check.mjs) — this test is RED against the pre-fix code
// (which wrote the expired env value) and green against the fix (which refuses it, taking the
// existing "neither is usable" branch).
test('ensureCodexBootstrap: CODEX_LOGIN_B64 that is shape-VALID but has an EXPIRED access token is REFUSED, never written — the env path must fail the SAME expiry check the existing-file path already applies (fix round 2, H1)', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-boot-'));
  try {
    const authPath = joinPath(dir, 'auth.json');
    const now = Date.UTC(2026, 8, 14, 12, 0, 0); // 2026-09-14T12:00:00Z
    const expiredEnvAuth = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: fakeJwt({ exp: Math.floor(now / 1000) - 1 }),
        refresh_token: 'fake-refresh-token-value',
      },
    });
    const logs = [];
    // No existing file at all — the fresh-cloud-sandbox shape finding 7a1326 names.
    const res = ensureCodexBootstrap({
      env: { CODEX_LOGIN_B64: Buffer.from(expiredEnvAuth).toString('base64') },
      authPath,
      trustAnchor: dir, // plan 3958 review (key 10k7z8u) — see the first bootstrap test's comment
      now,
      installFn: () => {},
      probeFn: () => true,
      logFn: (m) => logs.push(m),
      trustFn: () => ({ wroteTrust: false }),
    });
    assert.equal(res.wroteAuth, false, 'an expired env token must never be installed');
    assert.equal(existsSync(authPath), false);
    assert.ok(
      logs.some((m) => m.includes('CODEX_LOGIN_B64 failed validation') && m.includes('expired')),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 4019 fix round 1, G3 (findings 5ab3c6/c40ec3/c5d92d, all blocking): the check-then-replace
// race. `mkdirFn` is the one real side effect between the initial validation and the pre-rename
// recheck (same DI pattern as installFn/probeFn/trustFn above) — a test hook there simulates
// "codex refreshed auth.json in place while we were mid-repair", deterministically, no timing.
test('ensureCodexBootstrap: a concurrent refresh between validation and rename is NOT clobbered — the file is re-checked immediately before the rename and left alone if it has become valid (fix round 1, G3)', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-boot-'));
  try {
    const authPath = joinPath(dir, 'auth.json');
    writeFileSync(authPath, 'torn-not-json');
    const logs = [];
    const res = ensureCodexBootstrap({
      env: { CODEX_LOGIN_B64: Buffer.from(FAKE_VALID_AUTH).toString('base64') },
      authPath,
      trustAnchor: dir, // plan 3958 review (key 10k7z8u) — see the first bootstrap test's comment
      installFn: () => {},
      probeFn: () => true,
      logFn: (m) => logs.push(m),
      trustFn: () => ({ wroteTrust: false }),
      mkdirFn: (dirPath, opts) => {
        mkdirSync(dirPath, opts);
        // Simulate a concurrent codex refresh landing a fresh, valid login right in the
        // window this fix narrows — a DIFFERENT valid payload than the env copy, so the
        // assertion below can tell "left alone" apart from "coincidentally rewrote the same
        // bytes".
        writeFileSync(
          authPath,
          JSON.stringify({ ...JSON.parse(FAKE_VALID_AUTH), nonce: 'concurrent-refresh' }),
        );
      },
    });
    assert.equal(res.wroteAuth, false, 'the concurrently-refreshed login must not be replaced');
    assert.equal(
      JSON.parse(readFileSync(authPath, 'utf8')).nonce,
      'concurrent-refresh',
      'the file on disk must be the concurrently-written login, not the env copy',
    );
    assert.ok(logs.some((m) => m.includes('became valid') && m.includes('concurrent refresh')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCodexBootstrap: install failure is non-fatal (falls through to the exit-2 fallback path)', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-boot-'));
  try {
    const logs = [];
    // plan 4019: `{}` no longer decodes as a usable login under the new validation gate (no
    // `tokens` object) — a plausibly-shaped fake payload keeps this test's actual subject
    // (install failure is non-fatal) exercised rather than tripping the unrelated auth gate.
    const payload = JSON.stringify({
      tokens: {
        access_token: 'fake-access-token-value',
        refresh_token: 'fake-refresh-token-value',
      },
    });
    const res = ensureCodexBootstrap({
      env: { CODEX_LOGIN_B64: Buffer.from(payload).toString('base64') },
      authPath: joinPath(dir, 'auth.json'),
      trustAnchor: dir, // plan 3958 review (key 10k7z8u) — see the first bootstrap test's comment
      installFn: () => {
        throw new Error('npm dead');
      },
      probeFn: () => false,
      logFn: (m) => logs.push(m),
      trustFn: () => ({ wroteTrust: false }),
    });
    assert.equal(res.wroteAuth, true);
    // installed reflects what actually happened; the throw was swallowed.
    assert.equal(res.installed, false);
    assert.ok(logs.some((m) => m.includes('npm dead')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── plan 2766: Claude data-grounding hybrid arm ────────────────────────────

test('parseArgs: --no-claude-arm disables the arm; default is on', () => {
  assert.equal(parseArgs([]).claudeArm, true);
  assert.equal(parseArgs(['--range', 'a..b']).claudeArm, true);
  assert.equal(parseArgs(['--no-claude-arm']).claudeArm, false);
  assert.equal(parseArgs(['--range', 'a..b', '--no-claude-arm']).claudeArm, false);
});

test('CLAUDE_ARM_TAG: follows the finder:<label> convention and is namespace-distinct from every codex angle', () => {
  assert.equal(CLAUDE_ARM_TAG, 'finder:claude-data-grounding');
  assert.match(CLAUDE_ARM_TAG, /^finder:[a-z0-9-]+$/);
  // Not a collision with any codex FINDERS label (including the two codex
  // angles — guard-fires/writer-trace — this arm's mandate overlaps) — a
  // shared tag would silently merge two different transports' checkpoint
  // entries and break resume for both.
  const codexTags = FINDERS.map((f) => `finder:${f.label}`);
  assert.ok(!codexTags.includes(CLAUDE_ARM_TAG));

  const firstPrompt = claudeArmPrompt('scope A', { repoRoot: '/repo' });
  const secondPrompt = claudeArmPrompt('scope B', { repoRoot: '/repo' });
  const tagFor = (prompt) =>
    callTag(CLAUDE_ARM_TAG, promptCallDigest({ prompt, schema: null, model: CLAUDE_MODEL }));
  assert.notEqual(tagFor(firstPrompt), tagFor(secondPrompt));
});

test('DEFAULT_CONCURRENCY: covers the finder roster so a new angle cannot silently add a wave', () => {
  assert.ok(DEFAULT_CONCURRENCY >= FINDERS.length);
});

test('claudeArmPrompt: carries both DATA_GROUNDING_ANGLES texts verbatim (byte-ported, not rewritten), the JSON response contract, and the delimiter markers', () => {
  const block = buildScopeBlock({
    diffPatchPath: '/abs/out/diff.patch',
    headSha: 'deadbeef',
    files: ['a.ts'],
    claudeMdFiles: [],
    summary: 'S',
    conventions: 'C',
    target: '',
  });
  const prompt = claudeArmPrompt(block);
  for (const angle of DATA_GROUNDING_ANGLES) {
    assert.ok(prompt.includes(angle.text), `prompt is missing the verbatim ${angle.label} text`);
  }
  assert.match(prompt, /"candidates"/);
  assert.match(prompt, new RegExp(`up to ${CLAUDE_ARM_CAP} candidate`));
  assert.equal(CLAUDE_ARM_CAP, 12); // PER_ANGLE(6) * 2 mandates in one call
  // The delimiter contract (plan 2766 post-incident fix) — both markers present,
  // START before END, and the instruction that this is the final output.
  assert.ok(prompt.includes(CLAUDE_ARM_DELIM_START));
  assert.ok(prompt.includes(CLAUDE_ARM_DELIM_END));
  assert.ok(prompt.indexOf(CLAUDE_ARM_DELIM_START) < prompt.indexOf(CLAUDE_ARM_DELIM_END));
  assert.match(prompt, /FINAL INSTRUCTION/);
});

test('claudeArmPrompt (round 4): contains NO instruction to write a file — every mention of "write" is a negation; the delimiter contract is restated at the TOP and is the FINAL instruction; the stale round-3 "may be followed by additional turns" line is gone', () => {
  // Round-3 real-data finding: the arm found the target defect (real grep-the-
  // seed grounding, per team-lead's report) but never emitted the delimiter
  // pair — its FIRST assistant text was "Let me write the file into the
  // working directory instead", i.e. it believed file output was expected.
  // This test locks in the two structural fixes so neither regresses silently.
  const block = buildScopeBlock({
    diffPatchPath: '/abs/out/diff.patch',
    headSha: 'deadbeef',
    files: ['a.ts'],
    claudeMdFiles: [],
    summary: 'S',
    conventions: 'C',
    target: '',
  });
  const prompt = claudeArmPrompt(block);

  // 1. No instruction TO write a file — every "write" occurrence that co-occurs
  // with "file"/"disk" nearby (the file-output-instruction shape, e.g. "write
  // ... to a file") must be preceded by a negation word within a short window.
  // A "write" used in a non-file sense ("prose you write") is not scanned —
  // only the specific shape that caused the round-3 confusion matters here.
  const WINDOW = 25;
  const writeRe = /\bwrite\b/gi;
  let m;
  let sawFileWriteMention = false;
  while ((m = writeRe.exec(prompt))) {
    const before = prompt.slice(Math.max(0, m.index - WINDOW), m.index);
    const after = prompt.slice(m.index, m.index + WINDOW + 30);
    if (!/\b(file|disk)\b/i.test(after)) continue; // not a file-output mention at all
    sawFileWriteMention = true;
    assert.match(
      before,
      /\b(do not|don't|never)\b/i,
      `"write" at index ${m.index} co-occurs with "file"/"disk" but is not preceded by a negation — ` +
        `reads as an instruction TO write a file: "...${before}${m[0]}${after}..."`,
    );
  }
  assert.ok(
    sawFileWriteMention,
    'expected the prompt to explicitly negate file-writing at least once',
  );

  // 2. The stale, likely-confusing round-3 line is gone.
  assert.doesNotMatch(prompt, /may be followed by additional/i);

  // 3. The format contract is restated near the TOP, before the scope block
  // (so it is not buried after the two long angle texts — the round-3 answer
  // took 24 turns to reach prose, evidence the contract was easy to lose).
  assert.ok(prompt.indexOf(CLAUDE_ARM_DELIM_START) < prompt.indexOf(block));

  // 4. ...AND the format contract is the prompt's FINAL content.
  assert.ok(prompt.trimEnd().endsWith(CLAUDE_ARM_DELIM_END));
});

test('claudeArmPrompt (round 5, write containment): with a repoRoot, the prompt tells the model its cwd is scratch/disposable, names the repo path, and instructs the exact `-C <repoRoot>` git prefix — matching the allowlist runClaudeArm actually grants', () => {
  // Round-4 real-run finding (reported by team-lead): `--allowedTools
  // "Bash(git show:*)"` is a command-PREFIX match, not a sandbox — a
  // `git show <ref>:<path> > file.json` redirect still writes, and the arm
  // wrote a 34MB copy of the retired seed monolith straight into
  // the worktree root. The fix is a disposable scratch cwd (runClaudeArm) +
  // this prompt paragraph telling the model to always go through
  // `-C <repoRoot>` for git, matching the `git -C <repoRoot> <subcommand>`
  // patterns the allowlist actually grants (a bare `git show` would fail
  // outright from a non-repo scratch cwd).
  const block = buildScopeBlock({
    diffPatchPath: '/abs/out/diff.patch',
    headSha: 'deadbeef',
    files: ['a.ts'],
    claudeMdFiles: [],
    summary: 'S',
    conventions: 'C',
    target: '',
  });
  const repoRoot = 'C:/fake/repo/root';
  const prompt = claudeArmPrompt(block, { repoRoot });

  assert.match(prompt, /WORKING DIRECTORY/);
  assert.ok(prompt.includes(repoRoot), 'the concrete repoRoot path must appear in the prompt');
  assert.match(prompt, /disposable/i);
  assert.ok(
    prompt.includes(`-C ${repoRoot}`),
    'the prompt must instruct the exact -C <repoRoot> git prefix',
  );
  // Every one of the round-4 no-file-write / bookended-contract properties
  // still holds with repoRoot present — the two fixes must not regress each other.
  assert.doesNotMatch(prompt, /may be followed by additional/i);
  assert.ok(prompt.indexOf(CLAUDE_ARM_DELIM_START) < prompt.indexOf(block));
  assert.ok(prompt.trimEnd().endsWith(CLAUDE_ARM_DELIM_END));
});

test('claudeArmPrompt (round 5): WITHOUT a repoRoot (pure-unit-test convenience), no WORKING DIRECTORY paragraph is added — backward compatible with every earlier-round test in this file', () => {
  const block = buildScopeBlock({
    diffPatchPath: '/abs/out/diff.patch',
    headSha: 'deadbeef',
    files: ['a.ts'],
    claudeMdFiles: [],
    summary: 'S',
    conventions: 'C',
    target: '',
  });
  const prompt = claudeArmPrompt(block);
  assert.doesNotMatch(prompt, /WORKING DIRECTORY/);
});

test('parseClaudeArmCandidates: extracts a fenced JSON object, tolerating leading/trailing prose', () => {
  const raw =
    'Sure, here is the result:\n```json\n' +
    JSON.stringify({
      candidates: [{ file: 'a.ts', line: 3, summary: 'S', failure_scenario: 'F' }],
    }) +
    '\n```\nLet me know if you need anything else.';
  const { candidates, parseError } = parseClaudeArmCandidates(raw);
  assert.equal(parseError, null);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].file, 'a.ts');
});

test('parseClaudeArmCandidates: an empty candidates list is a legitimate (non-error) result', () => {
  const raw = JSON.stringify({ candidates: [] });
  const { candidates, parseError } = parseClaudeArmCandidates(raw);
  assert.equal(parseError, null);
  assert.deepEqual(candidates, []);
});

test('parseClaudeArmCandidates: unparseable text returns candidates:null with a reason, never throws', () => {
  assert.equal(parseClaudeArmCandidates('').candidates, null);
  assert.equal(parseClaudeArmCandidates('no json here').candidates, null);
  assert.equal(parseClaudeArmCandidates('{"not_candidates": []}').candidates, null);
  assert.equal(parseClaudeArmCandidates('{not: valid json}').candidates, null);
  assert.ok(parseClaudeArmCandidates('{not: valid json}').parseError.length > 0);
});

// ─── plan 2766 round 3: delimiter extraction over the single envelope ───────
// The PRIMARY fix for the production incident (a Stop hook reopening the turn
// and clobbering the arm's answer with a short epilogue) is now `--settings
// disableAllHooks` on the transport (runClaudeArm) — repo precedent, not a
// bespoke parser. extractDelimitedCandidatesJson is the cheap SECONDARY
// layer: it still runs over the ONE `--output-format json` envelope's
// `result` string, so its job here is narrower than an earlier round's —
// prose-tolerance WITHIN one string, not surviving a REPLACED message. Both
// halves of that honest scope get their own test below.

const wrap = (obj) => `${CLAUDE_ARM_DELIM_START}\n${JSON.stringify(obj)}\n${CLAUDE_ARM_DELIM_END}`;

test('extractDelimitedCandidatesJson: extracts the JSON between the delimiter pair from a single text block', () => {
  const json = extractDelimitedCandidatesJson([wrap({ candidates: [{ file: 'a.ts' }] })]);
  assert.deepEqual(JSON.parse(json), { candidates: [{ file: 'a.ts' }] });
});

test('extractDelimitedCandidatesJson: WHAT IT CAN STILL DO — tolerates incidental prose surrounding the delimiters WITHIN THE SAME result string', () => {
  const resultText =
    'Sure, here is my analysis of the diff:\n' +
    wrap({ candidates: [{ file: 'backend/src/price-resolver.ts', line: 768 }] }) +
    '\nLet me know if you would like more detail.';
  const json = extractDelimitedCandidatesJson([resultText]);
  assert.deepEqual(JSON.parse(json), {
    candidates: [{ file: 'backend/src/price-resolver.ts', line: 768 }],
  });
});

test('extractDelimitedCandidatesJson: WHAT IT CANNOT DO — a REPLACED single-string result (the shape a Stop hook produces if disableAllHooks fails to suppress it) has no delimiters left to find, and this function correctly returns null rather than fabricating a match', () => {
  // Under --output-format json there is exactly ONE `result` string — a
  // reopened turn does not APPEND to it, it REPLACES it. So if disableAllHooks
  // ever failed, the real delimited answer is not "harder to find", it is
  // gone from the envelope; this is why the smoke test targets the transport
  // flag, not this extractor.
  const json = extractDelimitedCandidatesJson(['📎 reconciled — no corrections']);
  assert.equal(json, null);
});

test('extractDelimitedCandidatesJson: takes the LAST delimited block when more than one text block contains a real pair (still correct for the general/array-of-blocks case)', () => {
  const texts = [
    wrap({ candidates: [{ file: 'first.ts' }] }),
    wrap({ candidates: [{ file: 'second.ts' }] }),
  ];
  const json = extractDelimitedCandidatesJson(texts);
  assert.deepEqual(JSON.parse(json), { candidates: [{ file: 'second.ts' }] });
});

test('extractDelimitedCandidatesJson: no text block contains a complete delimiter pair -> null, never throws', () => {
  assert.equal(extractDelimitedCandidatesJson([]), null);
  assert.equal(extractDelimitedCandidatesJson(undefined), null);
  assert.equal(extractDelimitedCandidatesJson(['plain text, no delimiters']), null);
  assert.equal(extractDelimitedCandidatesJson([CLAUDE_ARM_DELIM_START + '\nunterminated']), null);
  assert.equal(extractDelimitedCandidatesJson([42, null, 'text']), null); // non-string entries skipped, not thrown on
});

test('resolveClaudeModelStamp: picks the requested-family model by output tokens; unavailable when modelUsage is absent', () => {
  const envelope = {
    modelUsage: {
      'claude-sonnet-5': { outputTokens: 500, canonicalModel: 'claude-sonnet-5' },
      'claude-haiku-4-5': { outputTokens: 10 }, // a side-call (e.g. title gen) must not win
    },
  };
  const stamp = resolveClaudeModelStamp(envelope, 'sonnet');
  assert.equal(stamp.resolvedModel, 'claude-sonnet-5');
  assert.equal(stamp.resolvedVia, 'output-json');

  const mismatch = resolveClaudeModelStamp(
    { modelUsage: { 'claude-opus-5': { outputTokens: 5 } } },
    'sonnet',
  );
  assert.equal(mismatch.resolvedVia, 'output-json-family-mismatch');

  assert.deepEqual(resolveClaudeModelStamp({}, 'sonnet'), {
    resolvedModel: null,
    resolvedVia: 'unavailable',
  });
  assert.deepEqual(resolveClaudeModelStamp(null, 'sonnet'), {
    resolvedModel: null,
    resolvedVia: 'unavailable',
  });
});

test('sumModelUsageTokens: sums input/output/cache token fields across every model entry', () => {
  const usage = {
    'claude-sonnet-5': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 20 },
    'claude-haiku-4-5': { outputTokens: 5 },
  };
  assert.equal(sumModelUsageTokens(usage), 175);
  assert.equal(sumModelUsageTokens(null), 0);
  assert.equal(sumModelUsageTokens({}), 0);
});

test('classifyClaudeArmResult: soft-fail path — a transport error yields status "failed: <reason>", zero candidates, costUsd/turns null, never throws', () => {
  // plan 3966: the arm's liveness-probe kill returns error: 'dead', not the retired
  // 'timeout' string — classifyClaudeArmResult must not special-case either kind.
  const result = classifyClaudeArmResult({ error: 'dead', wallS: 900 });
  assert.equal(result.status, 'failed: dead');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.tokens, 0);
  assert.equal(result.resolvedModel, null);
  assert.equal(result.costUsd, null);
  assert.equal(result.turns, null);
  // A caller can always tell "did the arm run" from this one predicate — the
  // review continues regardless; nothing here throws or requires a try/catch.
  assert.ok(result.status.startsWith('failed'));
});

test('classifyClaudeArmResult: soft-fail path — an envelope whose result has no extractable JSON also fails, not silently zero (still reports costUsd/turns — real spend for zero coverage)', () => {
  const result = classifyClaudeArmResult({
    envelope: {
      result: 'I found nothing worth reporting.',
      subtype: 'success',
      total_cost_usd: 1.78,
      num_turns: 34,
    },
  });
  assert.ok(result.status.startsWith('failed'));
  assert.deepEqual(result.candidates, []);
  // Real spend, zero coverage — must stay visible even on the failed branch
  // (this is what the production incident looked like numerically).
  assert.equal(result.costUsd, 1.78);
  assert.equal(result.turns, 34);
});

test('classifyClaudeArmResult: REPLAY OF THE PRODUCTION INCIDENT, honestly scoped — if a Stop hook were NOT suppressed by disableAllHooks, the single `result` string is JUST the epilogue (no delimiters survive a REPLACED message, only an appended one), and this correctly reports a failure rather than fabricating a match', () => {
  const result = classifyClaudeArmResult({
    envelope: {
      subtype: 'success',
      result: '📎 reconciled — no corrections', // the wiki-loaders-stop.mjs epilogue, verbatim — REPLACES, doesn't append
      total_cost_usd: 1.78,
      num_turns: 34,
      modelUsage: { 'claude-sonnet-5': { outputTokens: 18683, canonicalModel: 'claude-sonnet-5' } },
    },
  });
  assert.ok(result.status.startsWith('failed'));
  assert.deepEqual(result.candidates, []);
  assert.equal(result.costUsd, 1.78);
  assert.equal(result.turns, 34);
  assert.equal(result.resolvedModel, 'claude-sonnet-5'); // model-stamp provenance survives even a lost answer
});

test('classifyClaudeArmResult: the delimiters DO help when the real answer is still present but wrapped in incidental prose within the ONE result string', () => {
  const result = classifyClaudeArmResult({
    envelope: {
      subtype: 'success',
      result:
        'Here is what I found reviewing consult_kind handling:\n' +
        wrap({
          candidates: [
            {
              file: 'backend/src/price-resolver.ts',
              line: 768,
              summary: 'guard keys on consult_kind === basic but it is never serialized that way',
              failure_scenario: 'the guard silently no-ops on real seed data',
            },
          ],
        }) +
        '\nHope that helps!',
      total_cost_usd: 0.31,
      num_turns: 12,
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].file, 'backend/src/price-resolver.ts');
  assert.equal(result.candidates[0].line, 768);
  assert.equal(result.costUsd, 0.31);
  assert.equal(result.turns, 12);
});

test('classifyClaudeArmResult: a clean call with zero candidates is "ok", not a failure ("nothing qualifies" is legitimate)', () => {
  const result = classifyClaudeArmResult({
    envelope: { result: wrap({ candidates: [] }), subtype: 'success', modelUsage: {} },
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.candidates, []);
});

test('classifyClaudeArmResult: a non-success terminal subtype fails BY NAME — a turn-cap exhaustion must not masquerade as a parse error (it cost two measurement runs to learn that)', () => {
  const result = classifyClaudeArmResult({
    envelope: {
      subtype: 'error_max_turns',
      result: '',
      num_turns: 25,
      total_cost_usd: 1.23,
      modelUsage: {},
    },
  });
  assert.equal(result.status, 'failed: terminal subtype error_max_turns');
  assert.deepEqual(result.candidates, []);
  // Spend is still reported: a capped call burned real quota for zero coverage.
  assert.equal(result.costUsd, 1.23);
  assert.equal(result.turns, 25);
});

test('classifyClaudeArmResult: an absent subtype (older CLI shape) stays permissive rather than failing every call', () => {
  const result = classifyClaudeArmResult({
    envelope: {
      result: wrap({ candidates: [{ file: 'a.ts', summary: 'S', failure_scenario: 'F' }] }),
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.candidates.length, 1);
});

test('classifyClaudeArmResult: malformed candidate ELEMENTS are dropped, never dereferenced — one bad entry must not cost the 11 codex angles their run', () => {
  const result = classifyClaudeArmResult({
    envelope: {
      subtype: 'success',
      result: wrap({
        candidates: [
          'a bare string, not a candidate',
          null,
          ['nested', 'array'],
          { file: 'a.ts', summary: 'real one', failure_scenario: 'F' },
        ],
      }),
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].summary, 'real one');
  assert.equal(result.malformed, 3);
});

test('classifyClaudeArmResult: a candidate missing failure_scenario keeps its slot with an empty string, rather than emitting undefined into the verify prompt', () => {
  const result = classifyClaudeArmResult({
    envelope: {
      subtype: 'success',
      result: wrap({ candidates: [{ file: 'a.ts', summary: 'S' }] }),
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.candidates[0].failure_scenario, '');
});

test('classifyClaudeArmResult: a non-empty candidates list with NOTHING well-formed is a failure, not a silent zero', () => {
  const result = classifyClaudeArmResult({
    envelope: { subtype: 'success', result: wrap({ candidates: [null, 'x'] }) },
  });
  assert.match(result.status, /^failed: 2 candidate\(s\), none well-formed$/);
  assert.deepEqual(result.candidates, []);
});

test('classifyClaudeArmResult: also parses a plain (non-delimited) JSON result — a response that never used the delimiters still gets a fair parse', () => {
  const result = classifyClaudeArmResult({
    envelope: {
      result: JSON.stringify({
        candidates: [{ file: 'a.ts', summary: 'S', failure_scenario: 'F' }],
      }),
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.candidates.length, 1);
});

test('classifyClaudeArmResult: shapes candidates to reach the SAME verify stage as codex candidates (file/line/summary/failure_scenario/angle/kind), tagged CLAUDE_ARM_LABEL', () => {
  const envelope = {
    subtype: 'success',
    total_cost_usd: 0.42,
    num_turns: 9,
    modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 20 } },
    result: wrap({
      candidates: [
        { file: 'backend/src/foo.ts', line: 12, summary: 'S1', failure_scenario: 'F1' },
        { file: 'backend/src/foo.ts', line: 12, summary: 'S2', failure_scenario: 'F2' },
        { file: 'other.ts', line: null, summary: 'S3', failure_scenario: 'F3' },
      ],
    }),
  };
  const result = classifyClaudeArmResult(
    { envelope },
    { files: ['backend/src/foo.ts', 'other.ts'] },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.candidates.length, 3);
  for (const c of result.candidates) {
    assert.equal(c.angle, CLAUDE_ARM_LABEL);
    assert.equal(c.kind, 'correctness');
    assert.ok('file' in c && 'line' in c && 'summary' in c && 'failure_scenario' in c);
  }
  assert.equal(result.tokens, 30);
  assert.equal(result.costUsd, 0.42);
  assert.equal(result.turns, 9);
  // The exact same shape codex finder candidates have when they enter
  // allCandidates — verified by feeding them through groupByLoc, the first
  // step of the real verify stage (groupByLoc/verifyOnce/verifyGroups), same
  // as the file's other "reaches verify" style assertions.
  const groups = groupByLoc(result.candidates);
  assert.equal(groups.length, 2); // two share (backend/src/foo.ts:12), one is alone at other.ts
  const pairedGroup = groups.find((g) => g.length === 2);
  assert.equal(locKey(pairedGroup[0]), 'backend/src/foo.ts:12');
});

test('classifyClaudeArmResult: caps at CLAUDE_ARM_CAP candidates, same slice-cap discipline as a codex finder angle', () => {
  const many = Array.from({ length: CLAUDE_ARM_CAP + 5 }, (_, i) => ({
    file: 'a.ts',
    line: i,
    summary: `S${i}`,
    failure_scenario: `F${i}`,
  }));
  const result = classifyClaudeArmResult({
    envelope: { result: wrap({ candidates: many }) },
  });
  assert.equal(result.candidates.length, CLAUDE_ARM_CAP);
});

test('classifyClaudeArmResult: falls back to the requested model / matches CLAUDE_MODEL default; no total_cost_usd/num_turns on the envelope -> costUsd/turns null', () => {
  const result = classifyClaudeArmResult({
    envelope: {
      result: wrap({ candidates: [] }),
      modelUsage: { 'claude-sonnet-5': { outputTokens: 1 } },
    },
  });
  assert.equal(result.resolvedModel, 'claude-sonnet-5');
  assert.equal(CLAUDE_MODEL, 'sonnet');
  assert.equal(result.costUsd, null);
  assert.equal(result.turns, null);
});

test('CLAUDE_ARM_MAX_TURNS: a positive integer turn cap — the flag now confirmed real, not the "invented" one an earlier round wrongly disqualified', () => {
  assert.equal(typeof CLAUDE_ARM_MAX_TURNS, 'number');
  assert.ok(Number.isInteger(CLAUDE_ARM_MAX_TURNS));
  assert.ok(CLAUDE_ARM_MAX_TURNS > 0);
});

// plan 2840 — a source-text pin, not a behavioural one: the ENOBUFS this guards is a
// property of the SPAWN OPTIONS, and reproducing it for real would mean building a diff
// with ~1 MB of path names. The `git diff` and `git diff --name-only` calls must BOTH
// carry the shared GIT_MAXBUFFER ceiling; the name-only one did not, so plan 2840's
// corpus re-render (~6,100 changed paths) could not be reviewed at all, and the failure
// surfaced as a transport error, which routes to the /sonnet-review fallback.
//
// The first cut of this test used a lazy non-greedy regex to slice each call.
// Review (findings caeb49/651581/b461d1/0b4d33) proved it VACUOUS: the one-line
// `rev-parse` call ends in `.trim();`, not `});`, so the slice ran on past it and
// swallowed the very `diff --name-only` call under test — then the rev-parse exemption
// skipped the merged blob entirely. A test that cannot fail is worse than no test, so
// the calls are now split by matching parentheses, which is exact rather than heuristic.
function gitExecFileSyncCalls(src) {
  const calls = [];
  const needle = "execFileSync('git'";
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
    const open = src.indexOf('(', at);
    let depth = 0;
    let inStr = null;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') inStr = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          calls.push(src.slice(at, i + 1));
          break;
        }
      }
    }
  }
  return calls;
}

test('gitExecFileSyncCalls: splits adjacent calls instead of merging them (the bug the first cut had)', () => {
  const fixture = [
    "const a = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();",
    "const b = execFileSync('git', ['diff', '--name-only', r], {",
    '  cwd: repoRoot,',
    '  encoding: "utf8",',
    '});',
  ].join('\n');
  const calls = gitExecFileSyncCalls(fixture);
  assert.equal(calls.length, 2, 'the one-line rev-parse call must not swallow the multi-line one');
  assert.match(calls[0], /rev-parse/);
  assert.doesNotMatch(calls[0], /--name-only/);
  assert.match(calls[1], /--name-only/);
  assert.doesNotMatch(calls[1], /rev-parse/);
});

test('every execFileSync git call in gpt-review.mjs carries the shared GIT_MAXBUFFER', () => {
  const src = readFileSync(new URL('./gpt-review.mjs', import.meta.url), 'utf8');
  const calls = gitExecFileSyncCalls(src);
  assert.ok(calls.length >= 2, `expected at least 2 git execFileSync calls, found ${calls.length}`);
  let checked = 0;
  for (const call of calls) {
    // `git rev-parse --show-toplevel` returns a single path and cannot overflow.
    if (/rev-parse/.test(call)) continue;
    checked++;
    assert.match(
      call,
      /maxBuffer: GIT_MAXBUFFER/,
      `git call without the shared ceiling:
${call}`,
    );
  }
  // Without this the exemption above could silently skip every call and still pass —
  // exactly the vacuity the first cut shipped.
  assert.ok(checked >= 2, `expected >=2 non-rev-parse git calls to check, checked ${checked}`);
});

test('gpt-review.mjs imports GIT_MAXBUFFER rather than re-declaring a literal ceiling', () => {
  const src = readFileSync(new URL('./gpt-review.mjs', import.meta.url), 'utf8');
  // Other named imports may ride the same statement (GIT_NONINTERACTIVE_ENV does) — what this
  // pins is that GIT_MAXBUFFER comes from the shared module and no literal ceiling is re-declared.
  assert.match(src, /import \{[^}]*\bGIT_MAXBUFFER\b[^}]*\} from '[^']*coord-git\.mjs'/);
  assert.doesNotMatch(src, /maxBuffer: \d+ \* 1024 \* 1024/);
});

// ─── plan 2936 review round 1 — regression guards for two confirmed findings ──

// FINDING: the first cut resolved the sidecar with a WORKING-TREE `git grep`. record-review's
// default write path lands the sidecar on origin/master through a disposable coord-checkout
// that never touches the calling worktree's files, so on a worktree branch the sidecar for the
// CURRENT plan is routinely absent from disk. Measured on this very plan: the worktree saw 1181
// sidecars, origin/master had 1188, and the lookup returned null for this plan's own slug —
// i.e. T1 was a silent no-op in exactly the re-review case it exists to serve. This guards the
// fix: the read must go through the canonical ORIGIN-FIRST resolver, not a local-only scan.

// FINDING: extraction trusted `disposition.type` on sight, so a malformed disposition
// (`wontfix` with no reason, `plan` with no planId) was injected as an authoritative
// "already declined" line carrying an EMPTY reason — which suppresses a re-report while
// supplying nothing to re-judge against. Must route through the canonical validator.
test('extractDispositionedFindings: skips malformed dispositions via normalizeDisposition', () => {
  const rec = {
    slug: 's',
    findings: [
      {
        file: 'a.ts',
        line: 1,
        summary: 'valid wontfix',
        disposition: { type: 'wontfix', reason: 'by design' },
      },
      {
        file: 'b.ts',
        line: 2,
        summary: 'valid plan',
        disposition: { type: 'plan', planId: '1234' },
      },
      { file: 'c.ts', line: 3, summary: 'wontfix w/o reason', disposition: { type: 'wontfix' } },
      { file: 'd.ts', line: 4, summary: 'plan w/o id', disposition: { type: 'plan' } },
      { file: 'e.ts', line: 5, summary: 'fixed', disposition: { type: 'fixed' } },
    ],
  };
  const { entries } = extractDispositionedFindings(rec);
  assert.deepEqual(
    entries.map((e) => e.summary),
    ['valid wontfix', 'valid plan'],
    'only well-formed wontfix/plan dispositions are injected',
  );
  assert.equal(entries[0].reason, 'by design');
  assert.equal(entries[1].reason, '1234');
});

// The parse half of the sidecar policy, split out so the origin-first reader (which holds
// content, not a path) shares the SAME refusal wording instead of re-rolling one.
test('parseSidecarOrRefuse: refuses unparseable content, returns the record otherwise', () => {
  assert.ok(parseSidecarOrRefuse('not json at all', 'x.findings.json').refuse);
  const good = JSON.stringify({
    sha: 'a'.repeat(40),
    slug: 's',
    findings: [],
  });
  assert.ok(parseSidecarOrRefuse(good, 'x.findings.json').rec);
});

// ─── plan 2936 review round 2 — freshness selection + git-failure handling ────

// FINDING (six angles): the round-1 fix read origin FIRST and returned it on the spot. But a
// `record-review --no-push` record/disposition writes ONLY the working tree, so origin can hold
// an OLDER sidecar — first-wins would then inject a superseded disposition set and suppress a
// finding that had just been reopened locally. This is pickFreshestMarker's rule (plan 2891 T5
// item 4), applied to sidecars: current beats stale wherever it sits.
const HEAD_SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);

test('pickFreshestSidecar: a HEAD-current record wins over an earlier stale one', () => {
  const stale = { rec: { sha: OLD_SHA, slug: 's', findings: [] } };
  const current = { rec: { sha: HEAD_SHA, slug: 's', findings: [] } };
  // origin (stale) listed FIRST — the freshest must still win, which is the whole point.
  assert.equal(pickFreshestSidecar([stale, current], HEAD_SHA), current);
  assert.equal(pickFreshestSidecar([current, stale], HEAD_SHA), current);
});

test('pickFreshestSidecar: with nothing current, the first parseable wins (prior behaviour)', () => {
  const a = { rec: { sha: OLD_SHA, slug: 's', findings: [] } };
  const b = { rec: { sha: 'c'.repeat(40), slug: 's', findings: [] } };
  assert.equal(pickFreshestSidecar([a, b], HEAD_SHA), a);
  // A null headSha (no commits) must degrade to first-parseable, never throw.
  assert.equal(pickFreshestSidecar([a, b], null), a);
});

test('pickFreshestSidecar: an unreadable candidate never masks a good one, nor vanishes', () => {
  const refusal = { refuse: 'REFUSED — unreadable' };
  const good = { rec: { sha: HEAD_SHA, slug: 's', findings: [] } };
  // A bad origin copy must not shadow a good local one — the winner's record is the good one...
  const won = pickFreshestSidecar([refusal, good], HEAD_SHA);
  assert.deepEqual(won.rec, good.rec);
  // ...but the loser is CARRIED, not dropped (round-4 cleanup): the caller logs it.
  assert.equal(won.suppressedRefusal, 'REFUSED — unreadable');
  assert.equal(won.refuse, undefined); // still a successful read, not a refusal
  // ...and with nothing parseable anywhere, the refusal is surfaced rather than read as absent.
  assert.equal(pickFreshestSidecar([refusal], HEAD_SHA), refusal);
  assert.equal(pickFreshestSidecar([refusal], HEAD_SHA).suppressedRefusal, undefined);
  assert.equal(pickFreshestSidecar([], HEAD_SHA), null);
  // A clean read carries no annotation at all.
  assert.equal(pickFreshestSidecar([good], HEAD_SHA), good);
});

test('pickFreshestSidecar: a refusal ordered AFTER the winner is still carried', () => {
  const good = { rec: { sha: HEAD_SHA, slug: 's', findings: [] } };
  const refusal = { refuse: 'REFUSED — local unreadable' };
  // origin is HEAD-current, the working-tree copy is unreadable: the run must not look clean.
  const won = pickFreshestSidecar([good, refusal], HEAD_SHA);
  assert.deepEqual(won.rec, good.rec);
  assert.equal(won.suppressedRefusal, 'REFUSED — local unreadable');
});

test('pickFreshestSidecar: the patch-id identity keeps a pre-rebase sidecar current', () => {
  // The round-3 branch that round 4 found DEAD (main() never passed headPatchId). A record whose
  // sha no longer pins HEAD but whose patchId matches HEAD's range patch-id is still CURRENT.
  const rebased = { rec: { sha: OLD_SHA, patchId: 'ab'.repeat(20), slug: 's', findings: [] } };
  const other = { rec: { sha: 'c'.repeat(40), slug: 's', findings: [] } };
  // Listed SECOND, so first-parseable would have picked `other` — only the patch-id match wins it.
  assert.equal(pickFreshestSidecar([other, rebased], HEAD_SHA, 'ab'.repeat(20)), rebased);
  // A thunk is accepted too (that is the shape main() passes — land-lib.rangePatchIdOnce).
  assert.equal(
    pickFreshestSidecar([other, rebased], HEAD_SHA, () => 'ab'.repeat(20)),
    rebased,
  );
  // Without the patch-id (the dead-parameter behaviour), the stale record loses.
  assert.equal(pickFreshestSidecar([other, rebased], HEAD_SHA), other);
});

test('resolveDispositionsBlock: a suppressed refusal is LOGGED beside the successful injection', () => {
  const logs = [];
  const read = {
    rec: {
      sha: HEAD_SHA,
      slug: 'fix-slug',
      findings: [
        {
          key: 'k1',
          file: 'a.ts',
          line: 1,
          summary: 's',
          disposition: { type: 'wontfix', reason: 'r' },
        },
      ],
    },
    suppressedRefusal: 'REFUSED — could not read origin/master copy',
  };
  const block = resolveDispositionsBlock(read, 'fix-slug', { logFn: (m) => logs.push(m) });
  assert.match(block, /Already dispositioned in earlier review rounds/);
  assert.ok(
    logs.some((m) => m.includes('could not read origin/master copy')),
    `expected the suppressed refusal to be logged, got: ${JSON.stringify(logs)}`,
  );
});

// FINDING (five angles): the round-1 fix wrapped the origin read in a bare catch, so a real git
// failure (I/O error, unreadable ref) read as "no sidecar" and the review silently dropped every
// prior disposition. Presence must be probed with ls-tree — empty output means absent, a throw
// means git failed — and a throw must refuse rather than fall through.

// ─── plan 2936 round 3 — BEHAVIOURAL cover for the origin/local sidecar read ──
// Replaces two source-regex tests round 3 correctly flagged (finding f47da2): they asserted on
// implementation text, so a behaviour-preserving refactor broke them while a real regression
// that kept the literals would have passed. These drive the real function against a real repo.

const SESSION_MD = (slug) =>
  `# fixture session\n\n**Branch:** \`worktree-${slug}\` · worktree \`.claude/worktrees/x\`\n`;
const sidecarJson = (sha, summary) =>
  JSON.stringify({
    sha,
    slug: 'fix-slug',
    rounds: 1,
    verdict: 'NITS',
    findings: [
      { key: 'k1', file: 'a.ts', line: 1, summary, disposition: { type: 'wontfix', reason: 'r' } },
    ],
  });

function sidecarRepo({ originBody, localBody }) {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gptrev-sidecar-'));
  const g = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  g(['init', '-q', '-b', 'master']);
  g(['config', 'user.email', 'f@x']);
  g(['config', 'user.name', 'f']);
  const rel = 'docs/handoff/sessions/2026-01-01-session-1';
  mkdirSync(joinPath(dir, 'docs/handoff/sessions'), { recursive: true });
  writeFileSync(joinPath(dir, `${rel}.md`), SESSION_MD('fix-slug'));
  if (originBody !== null) writeFileSync(joinPath(dir, `${rel}.findings.json`), originBody);
  g(['add', '-A']);
  g(['commit', '-qm', 'fixture']);
  // Make the committed state reachable as origin/master, then optionally diverge the worktree.
  g(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
  if (localBody !== undefined) {
    if (localBody === null) rmSync(joinPath(dir, `${rel}.findings.json`), { force: true });
    else writeFileSync(joinPath(dir, `${rel}.findings.json`), localBody);
  }
  return { dir, headSha: g(['rev-parse', 'HEAD']).trim() };
}
const PATHS = { sessionsDir: 'docs/handoff/sessions' };

test('readSidecarForSlug: reads the sidecar from origin/master when it is absent on disk', () => {
  const { dir } = sidecarRepo({
    originBody: sidecarJson('a'.repeat(40), 'from-origin'),
    localBody: null,
  });
  const read = readSidecarForSlug(dir, 'fix-slug', PATHS);
  assert.ok(read?.rec, 'expected a parsed record read off origin/master');
  assert.equal(read.rec.findings[0].summary, 'from-origin');
  rmSync(dir, { recursive: true, force: true });
});

// The regression that motivated round 2: a --no-push record writes ONLY the working tree, so a
// HEAD-current local record must beat the older origin one regardless of candidate order.
test('readSidecarForSlug: a HEAD-current working-tree sidecar beats an older origin one', () => {
  const { dir, headSha } = sidecarRepo({
    originBody: sidecarJson('b'.repeat(40), 'stale-origin'),
    localBody: sidecarJson('PLACEHOLDER', 'fresh-local'),
  });
  writeFileSync(
    joinPath(dir, 'docs/handoff/sessions/2026-01-01-session-1.findings.json'),
    sidecarJson(headSha, 'fresh-local'),
  );
  const read = readSidecarForSlug(dir, 'fix-slug', PATHS, { headSha });
  assert.equal(read.rec.findings[0].summary, 'fresh-local');
  rmSync(dir, { recursive: true, force: true });
});

// A checkout that never fetched origin/master is a SUPPORTED shape (findSessionFile falls back
// to HEAD) — round 3 flagged round 2 for refusing there instead of using the local sidecar.
test('readSidecarForSlug: no origin/master ref falls back to the working tree, not a refusal', () => {
  const { dir } = sidecarRepo({
    originBody: sidecarJson('c'.repeat(40), 'local-only'),
    localBody: undefined,
  });
  execFileSync('git', ['-C', dir, 'update-ref', '-d', 'refs/remotes/origin/master']);
  const read = readSidecarForSlug(dir, 'fix-slug', PATHS);
  assert.ok(read?.rec, 'a missing origin ref must not produce a refusal');
  assert.equal(read.rec.findings[0].summary, 'local-only');
  rmSync(dir, { recursive: true, force: true });
});

// Hard rule #1: an EXISTING but unparseable sidecar is warned, never read as absent.
test('readSidecarForSlug: an unparseable sidecar refuses rather than reporting absence', () => {
  const { dir } = sidecarRepo({ originBody: '{ not json', localBody: undefined });
  const read = readSidecarForSlug(dir, 'fix-slug', PATHS);
  assert.ok(read?.refuse, 'expected a refusal, not a silent absence');
  rmSync(dir, { recursive: true, force: true });
});

test('readSidecarForSlug: null when no session entry names the slug', () => {
  const { dir } = sidecarRepo({
    originBody: sidecarJson('d'.repeat(40), 'x'),
    localBody: undefined,
  });
  assert.equal(readSidecarForSlug(dir, 'some-other-slug', PATHS), null);
  rmSync(dir, { recursive: true, force: true });
});

// ─── Empty-range guard (plan 3193) ─────────────────────────────────────────
// A review launched from the MAIN checkout while the diff lives on a worktree
// branch resolves an empty range. That used to exit 0 with a pass-shaped
// stats.json — feedable straight to `record-review.mjs PASS --review-stats`,
// i.e. a PASS marker on a diff no reviewer read. These cover the hard failure,
// the diagnosis that points at the right worktree, and the ONE legitimate empty
// case (artifacts-only) that must still pass.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import {
  EXIT_EMPTY_RANGE,
  collectAheadWorktrees,
  formatEmptyRangeError,
  recoveryCommand,
  shellQuoteArg,
  // plan 3213 — the landed-range guard
  EXIT_LANDED_RANGE,
  EXIT_REVIEW_ROUND_CAP,
  reviewLaunchCapDecision,
  buildPastCapStatsField,
  containmentRange,
  detectLandedRange,
  fetchOriginForLandedGuard,
  formatLandedRangeError,
  landedRangeRecoveryCommand,
  // plan 3369 — finder stderr persistence + bounded backoff retry (tasks 1+2)
  FINDER_STDERR_DIRNAME,
  STDERR_INLINE_LINES,
  RETRY_BACKOFF_MS,
  MAX_FINDER_RETRIES,
  persistFinderStderr,
  matchesForceFail,
  callFinderAngle,
  runFindersWithRetry,
  verifyGroups,
  // plan 3369 — path scope (task 3)
  FINDER_CONTEXT_BUDGET_CHARS,
  defaultDataExcludeGlobsFor,
  userPathspecs,
  applyPathScope,
  buildPathScopeNote,
  // plan 3369 — torn-checkpoint quarantine (task 4)
  Checkpoint,
  quarantineTornCheckpoint,
  // plan 3369 fix round 1
  reviewIdentityFingerprint,
  reviewIdentityComponents,
  buildScopeStatsField,
  clearStaleReviewArtifacts,
  // plan 3369 fix round 2
  resolveDiffTargetShas,
  callCached,
  capDiagnosticText,
  // plan 3369 fix round 3
  additiveGlobsThatDropped,
  // plan 3757 — resume merge-base pin (Change B) + round-cap identity key (Change A)
  readCheckpointBasePin,
  resolveResumeMergeBase,
  reviewRoundIdentityKey,
} from './gpt-review.mjs';
// plan 3369 fix round 1 (1522de/46279f/4fd40f) — the SAME constant gpt-review.mjs's
// defaultDataExcludeGlobsFor is now derived from (imported, never re-declared). Plan 4071
// T2: the CORE-only list — the merged (core + project) list is now caller-injected, so a
// bare import here has no coord.config.json context to merge in.
import { CORE_REVIEW_DIFF_EXCLUDES } from './coord/review-diff-scope.mjs';
// plan 3369 fix round 1 (bf342e) — the scope-record persistence pure helper.
// plan 3369 fix round 2 (7d51a1) — the suffix-placement helper (AFTER `@ <sha>`, not folded
// into `detail`).
import { describeReviewScope, appendMarkerScopeSuffix } from './record-review.mjs';
// plan 3369 fix round 3 (990944) — identicalReRecord's scope-identity comparison, pure and
// independently testable from here like the two imports directly above.
import { markerLineScopeSuffix, recordedScopeSuffix } from './record-review.mjs';
// plan 3369 fix round 1 (bf342e) — proving the marker regex still matches with the scope
// suffix appended, using the REAL done-worktree-lib.mjs functions (never a re-implementation).
import {
  buildReviewProvenance,
  upsertReviewMarker,
  parseReviewMarkerAny,
} from './coord/done-worktree-lib.mjs';
// plan 3618 — reviewLaunchCapDecision's second-consecutive-run: denial shares this exact
// function with the call site (scripts/gpt-review.mjs main()); imported here so the new cases
// below can prove the SAME message the call site would actually print.
import {
  AT_CAP_ROUND,
  capDenialMessage,
  fixBriefDenialMessage,
  reviewFixBriefPath,
  resolveReviewTargetBranch,
} from './coord/review-round-cap.mjs';

const GPT_REVIEW_PATH = fileURLToPath(new URL('./gpt-review.mjs', import.meta.url));

function launchCapRepo(
  branch = 'worktree-3527-SOL-review-round-cap',
  { artifactOnly = false } = {},
) {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gptrev-launch-cap-'));
  const g = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  g(['init', '-q', '-b', 'master']);
  g(['config', 'user.email', 'f@x']);
  g(['config', 'user.name', 'f']);
  writeFileSync(joinPath(dir, 'base.txt'), 'base\n');
  g(['add', 'base.txt']);
  g(['commit', '-qm', 'base']);
  g(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
  g(['remote', 'add', 'origin', dir]);
  g(['switch', '-q', '-c', branch]);
  const featurePath = artifactOnly ? 'input/raw/fixture.txt' : 'feature.txt';
  mkdirSync(joinPath(dir, dirname(featurePath)), { recursive: true });
  writeFileSync(joinPath(dir, featurePath), 'review me\n');
  g(['add', featurePath]);
  g(['commit', '-qm', 'feature']);

  // GPT_REVIEW_CODEX_BIN points at Node itself; its first positional (`exec`) is this local file.
  // That makes the first token-spending seam observable without launching codex or Claude.
  const spawnLog = joinPath(dir, 'model-spawns.log');
  writeFileSync(
    joinPath(dir, 'exec'),
    `require('node:fs').appendFileSync(process.env.GPT_REVIEW_SPAWN_LOG, 'spawn\\n');\nprocess.exit(1);\n`,
  );
  const run = (
    extra = [],
    outDir = joinPath(dir, `out-${Date.now()}-${Math.random()}`),
    env = {},
  ) =>
    spawnSync(
      process.execPath,
      [
        GPT_REVIEW_PATH,
        '--no-detach',
        '--out',
        outDir,
        '--no-claude-arm',
        '--no-gate-prep',
        ...extra,
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          CODEX_LOGIN_B64: '',
          GPT_REVIEW_CODEX_BIN: process.execPath,
          GPT_REVIEW_SPAWN_LOG: spawnLog,
          ...env,
        },
      },
    );
  return { dir, g, run, spawnLog };
}

// platform-assert-ok: This shim is a POSIX /bin/sh script that Windows cannot execute via PATH, so its three win32-skipped tests provide POSIX-only coverage.
function gitFetchLoggingShim(dir) {
  const shimDir = joinPath(dir, 'git-shim');
  const fetchLog = joinPath(dir, 'git-fetches.log');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  mkdirSync(shimDir);
  const gitPath = joinPath(shimDir, 'git');
  writeFileSync(
    gitPath,
    '#!/bin/sh\n' +
      'for arg in "$@"; do\n' +
      '  if [ "$arg" = "fetch" ]; then\n' +
      '    echo fetch >> "$GPT_REVIEW_FETCH_LOG"\n' +
      '    break\n' +
      '  fi\n' +
      'done\n' +
      'exec "$GPT_REVIEW_REAL_GIT" "$@"\n',
  );
  chmodSync(gitPath, 0o755);
  return {
    fetchLog,
    env: {
      PATH: `${shimDir}:${process.env.PATH}`,
      GPT_REVIEW_FETCH_LOG: fetchLog,
      GPT_REVIEW_REAL_GIT: realGit,
    },
  };
}

test(
  'gpt-review launch cap: a normal launch fetches origin exactly once',
  { skip: process.platform === 'win32' },
  () => {
    const r = launchCapRepo();
    try {
      const shim = gitFetchLoggingShim(r.dir);
      for (let ordinal = 1; ordinal <= 4; ordinal++) {
        reviewLaunchCapDecision(r.dir, {
          slug: '3527-SOL-review-round-cap',
          branch: 'worktree-3527-SOL-review-round-cap',
        });
      }
      r.run([], undefined, shim.env);
      assert.equal(readFileSync(shim.fetchLog, 'utf8'), 'fetch\n');
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  },
);

test(
  'gpt-review launch cap: an --end-ref launch still refreshes origin',
  { skip: process.platform === 'win32' },
  () => {
    const r = launchCapRepo();
    try {
      const shim = gitFetchLoggingShim(r.dir);
      for (let ordinal = 1; ordinal <= 4; ordinal++) {
        reviewLaunchCapDecision(r.dir, {
          slug: '3527-SOL-review-round-cap',
          branch: 'worktree-3527-SOL-review-round-cap',
        });
      }
      r.run(['--end-ref', 'HEAD'], undefined, shim.env);
      assert.equal(readFileSync(shim.fetchLog, 'utf8'), 'fetch\n');
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  },
);

test(
  'gpt-review launch cap: a failed guard fetch is retried before the cap decision',
  { skip: process.platform === 'win32' },
  () => {
    const r = launchCapRepo();
    try {
      const shim = gitFetchLoggingShim(r.dir);
      r.g(['remote', 'set-url', 'origin', joinPath(r.dir, 'no-such-remote')]);
      for (let ordinal = 1; ordinal <= 4; ordinal++) {
        reviewLaunchCapDecision(r.dir, {
          slug: '3527-SOL-review-round-cap',
          branch: 'worktree-3527-SOL-review-round-cap',
        });
      }
      r.run([], undefined, shim.env);
      assert.equal(readFileSync(shim.fetchLog, 'utf8'), 'fetch\nfetch\n');
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  },
);

test('gpt-review launch cap: launches 1-4 proceed; launch 5 exits 5 before any subprocess', () => {
  const r = launchCapRepo();
  try {
    for (let ordinal = 1; ordinal <= 4; ordinal++) {
      assert.deepEqual(
        reviewLaunchCapDecision(r.dir, {
          slug: '3527-SOL-review-round-cap',
          branch: 'worktree-3527-SOL-review-round-cap',
        }),
        { planId: '3527', launchOrdinal: ordinal, denied: false },
        `launch ${ordinal} must be allowed`,
      );
    }

    const denied = r.run();
    assert.equal(denied.status, EXIT_REVIEW_ROUND_CAP, denied.stderr);
    assert.match(denied.stderr, /review-round cap: denying launch 5 for plan 3527/);
    assert.equal(
      existsSync(r.spawnLog),
      false,
      'the denied launch must not start the stubbed codex/finder seam',
    );
    assert.equal(
      r.g(['rev-list', '--count', 'refs/review-rounds/3527']),
      '5',
      'the denied launch is still counted in the local ledger',
    );
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('gpt-review launch cap: --repo branch and cap ignore ambient Git selectors', () => {
  const target = launchCapRepo();
  const ambient = emptyRangeRepo();
  try {
    for (let ordinal = 1; ordinal <= 4; ordinal++) {
      assert.equal(
        reviewLaunchCapDecision(target.dir, {
          slug: '3527-SOL-review-round-cap',
          branch: 'worktree-3527-SOL-review-round-cap',
        }).launchOrdinal,
        ordinal,
      );
    }
    const denied = target.run(
      ['--repo', target.dir],
      joinPath(target.dir, 'ambient-selector-out'),
      {
        GIT_DIR: joinPath(ambient, '.git'),
        GIT_WORK_TREE: ambient,
      },
    );
    assert.equal(denied.status, EXIT_REVIEW_ROUND_CAP, denied.stderr);
    assert.match(denied.stderr, /denying launch 5 for plan 3527/);
  } finally {
    rmSync(target.dir, { recursive: true, force: true });
    rmSync(ambient, { recursive: true, force: true });
  }
});

test('gpt-review launch cap: a branch with no plan slug is completely ungated and writes no ledger ref', () => {
  const r = launchCapRepo('feature/ad-hoc-review');
  try {
    const res = r.run(['--paths', 'does-not-match/**']);
    assert.notEqual(res.status, EXIT_REVIEW_ROUND_CAP, res.stderr);
    assert.equal(existsSync(r.spawnLog), false, 'the path-scope refusal stops before model spawn');
    assert.equal(
      r.g(['for-each-ref', '--format=%(refname)', 'refs/review-rounds/']),
      '',
      'an ad-hoc branch must not write any review-round ref',
    );
    assert.doesNotMatch(res.stderr, /review-round cap: denying/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('gpt-review launch cap: a scoped-to-nothing exit leaves the ledger unchanged', () => {
  const r = launchCapRepo();
  try {
    assert.equal(
      reviewLaunchCapDecision(r.dir, {
        slug: '3527-SOL-review-round-cap',
        branch: 'worktree-3527-SOL-review-round-cap',
      }).launchOrdinal,
      1,
    );
    const res = r.run(['--paths', 'does-not-match/**']);
    assert.equal(res.status, EXIT_EMPTY_RANGE, res.stderr);
    assert.equal(existsSync(r.spawnLog), false, 'the empty scope stops before model spawn');
    assert.equal(
      r.g(['rev-list', '--count', 'refs/review-rounds/3527']),
      '1',
      'an empty review attempt must not consume a launch',
    );
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('gpt-review launch cap: a genuinely empty range leaves the ledger unchanged', () => {
  const r = launchCapRepo();
  try {
    assert.equal(
      reviewLaunchCapDecision(r.dir, {
        slug: '3527-SOL-review-round-cap',
        branch: 'worktree-3527-SOL-review-round-cap',
      }).launchOrdinal,
      1,
    );
    const res = r.run(['--range', 'HEAD..HEAD']);
    assert.equal(res.status, EXIT_EMPTY_RANGE, res.stderr);
    assert.equal(existsSync(r.spawnLog), false, 'the empty range stops before model spawn');
    assert.equal(r.g(['rev-list', '--count', 'refs/review-rounds/3527']), '1');
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('gpt-review launch cap: a landed range leaves the ledger unchanged', () => {
  const r = launchCapRepo();
  try {
    assert.equal(
      reviewLaunchCapDecision(r.dir, {
        slug: '3527-SOL-review-round-cap',
        branch: 'worktree-3527-SOL-review-round-cap',
      }).launchOrdinal,
      1,
    );
    const staleBase = r.g(['merge-base', 'master', 'HEAD']);
    r.g(['switch', '-q', 'master']);
    writeFileSync(joinPath(r.dir, 'stranger.txt'), 'landed by someone else\n');
    r.g(['add', 'stranger.txt']);
    r.g(['commit', '-qm', 'stranger landed work']);
    r.g(['switch', '-q', 'worktree-3527-SOL-review-round-cap']);
    r.g(['rebase', '-q', 'master']);
    const headSha = r.g(['rev-parse', 'HEAD']);

    const res = r.run(['--range', `${staleBase}..${headSha}`]);
    assert.equal(res.status, EXIT_LANDED_RANGE, res.stderr);
    assert.equal(
      existsSync(r.spawnLog),
      false,
      'the landed-range refusal stops before model spawn',
    );
    assert.equal(r.g(['rev-list', '--count', 'refs/review-rounds/3527']), '1');
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('gpt-review launch cap: a normal launch increments the ledger exactly once', () => {
  const r = launchCapRepo('worktree-3527-SOL-review-round-cap', { artifactOnly: true });
  try {
    const res = r.run();
    assert.equal(res.status, 0, res.stderr);
    assert.equal(r.g(['rev-list', '--count', 'refs/review-rounds/3527']), '1');
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('gpt-review launch cap: a round-4 marker seeds an absent ledger and denies launch 5', () => {
  const r = launchCapRepo();
  try {
    const context = warnBeforeReviewLaunch(r.dir, {
      branchName: 'worktree-3527-SOL-review-round-cap',
      paths: { sessionsDir: 'docs/handoff/sessions' },
      refreshBeforeRead: false,
      refreshFn: () => assert.fail('the seed read must not fetch before the cap gate'),
      findSessionFn: () => 'docs/handoff/sessions/session.md',
      readCandidatesFn: () => [`Review: PASS:gpt-review @ ${'a'.repeat(40)} review-round:4\n`],
      warn: () => {},
      returnContext: true,
    });
    assert.equal(context.markerRoundFloor, 4);
    assert.deepEqual(reviewLaunchCapDecision(r.dir, context), {
      planId: '3527',
      launchOrdinal: 5,
      denied: true,
    });
    assert.equal(r.g(['rev-list', '--count', 'refs/review-rounds/3527']), '5');
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('gpt-review launch cap: a round-4 marker remains the floor after a ledger entry exists', () => {
  const r = launchCapRepo();
  try {
    assert.equal(
      reviewLaunchCapDecision(r.dir, {
        slug: '3527-SOL-review-round-cap',
        branch: 'worktree-3527-SOL-review-round-cap',
      }).launchOrdinal,
      1,
    );
    assert.deepEqual(
      reviewLaunchCapDecision(r.dir, {
        slug: '3527-SOL-review-round-cap',
        branch: 'worktree-3527-SOL-review-round-cap',
        markerRoundFloor: 4,
      }),
      { planId: '3527', launchOrdinal: 5, denied: true },
    );
    assert.equal(r.g(['rev-list', '--count', 'refs/review-rounds/3527']), '5');
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('parseArgs: --past-cap requires a sanctioned exit prefix and preserves it verbatim', () => {
  assert.throws(() => parseArgs(['--past-cap']), /--past-cap is missing its value/);
  assert.throws(() => parseArgs(['--past-cap', '   ']), /--past-cap.*missing its value/);
  assert.throws(() => parseArgs(['--past-cap', 'docs re-pin']), /run, simplify, park/);
  assert.equal(
    parseArgs(['--past-cap', 'simplify: remove the brittle seam']).pastCapReason,
    'simplify: remove the brittle seam',
  );
  assert.equal(parseArgs([]).pastCapReason, null);
});

test('gpt-review --past-cap: launch 5 proceeds, increments, stamps the ref verbatim, and persists the automatic stats channel', () => {
  const reason = 'run: queue rebase introduced "new" surfaces; review-round:99';
  const r = launchCapRepo('worktree-3527-SOL-review-round-cap', { artifactOnly: true });
  const context = {
    slug: '3527-SOL-review-round-cap',
    branch: 'worktree-3527-SOL-review-round-cap',
  };
  try {
    for (let ordinal = 1; ordinal <= 4; ordinal++) {
      assert.equal(reviewLaunchCapDecision(r.dir, context).launchOrdinal, ordinal);
    }
    const outDir = joinPath(r.dir, 'past-cap-out');
    const allowed = r.run(['--past-cap', reason], outDir);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(existsSync(r.spawnLog), false, 'artifact-only completion starts no model process');
    assert.equal(r.g(['rev-list', '--count', 'refs/review-rounds/3527']), '5');
    const refMessage = r.g(['log', '-1', '--format=%B', 'refs/review-rounds/3527']);
    assert.ok(
      refMessage.includes(`past-cap-reason:\n${reason}`),
      'the ref commit body must contain the caller reason verbatim',
    );
    assert.deepEqual(JSON.parse(readFileSync(joinPath(outDir, 'stats.json'), 'utf8')).pastCap, {
      reason,
    });
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

// plan 3618: a second consecutive `run:` escape is a DENY, not a warning — proven here through
// the SAME reviewLaunchCapDecision() the CLI's main() calls, in this file's existing
// throwaway-repo harness (the guard hook's mirror-image cases live in
// scripts/review-round-cap-guard.test.mjs).
test('reviewLaunchCapDecision: a second consecutive run: escape past the cap is denied, with the count the call site feeds to capDenialMessage', () => {
  const r = launchCapRepo();
  const context = {
    slug: '3527-SOL-review-round-cap',
    branch: 'worktree-3527-SOL-review-round-cap',
  };
  try {
    for (let ordinal = 1; ordinal <= 4; ordinal++) {
      assert.equal(reviewLaunchCapDecision(r.dir, context).launchOrdinal, ordinal);
    }
    const first = reviewLaunchCapDecision(r.dir, {
      ...context,
      pastCapReason: 'run: first escape',
    });
    assert.deepEqual(first, { planId: '3527', launchOrdinal: 5, denied: false });

    const second = reviewLaunchCapDecision(r.dir, {
      ...context,
      pastCapReason: 'run: second in a row',
    });
    assert.deepEqual(second, {
      planId: '3527',
      launchOrdinal: 6,
      denied: true,
      consecutiveEscapes: 2,
    });
    // Mirrors main()'s own call site exactly: capDenialMessage(...,
    // consecutiveEscapes: launchDecision.consecutiveEscapes).
    const message = capDenialMessage({
      planId: second.planId,
      launchOrdinal: second.launchOrdinal,
      pastCapFlagName: '--past-cap',
      consecutiveEscapes: second.consecutiveEscapes,
    });
    assert.match(message, /past-cap escape #2 in the current streak/);
    assert.match(message, /mode-switch failure/);
    // plan 3618 finding D2: the denial is decided ATOMICALLY inside recordLaunch's own CAS
    // loop, on a deny it returns WITHOUT calling update-ref — the ledger must be unchanged.
    assert.equal(r.g(['rev-list', '--count', 'refs/review-rounds/3527']), '5');
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('reviewLaunchCapDecision: simplify: then run: is allowed — different exits do not trip the consecutive-run guard', () => {
  const r = launchCapRepo();
  const context = {
    slug: '3527-SOL-review-round-cap',
    branch: 'worktree-3527-SOL-review-round-cap',
  };
  try {
    for (let ordinal = 1; ordinal <= 4; ordinal++) {
      assert.equal(reviewLaunchCapDecision(r.dir, context).launchOrdinal, ordinal);
    }
    const first = reviewLaunchCapDecision(r.dir, {
      ...context,
      pastCapReason: 'simplify: drop the fragile bit',
    });
    assert.deepEqual(first, { planId: '3527', launchOrdinal: 5, denied: false });

    const second = reviewLaunchCapDecision(r.dir, {
      ...context,
      pastCapReason: 'run: ship the simplified change',
    });
    assert.deepEqual(second, { planId: '3527', launchOrdinal: 6, denied: false });
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('reviewLaunchCapDecision: the FIRST run: past the cap is allowed and carries no fabricated escape count', () => {
  const r = launchCapRepo();
  const context = {
    slug: '3527-SOL-review-round-cap',
    branch: 'worktree-3527-SOL-review-round-cap',
  };
  try {
    for (let ordinal = 1; ordinal <= 4; ordinal++) {
      assert.equal(reviewLaunchCapDecision(r.dir, context).launchOrdinal, ordinal);
    }
    const decision = reviewLaunchCapDecision(r.dir, {
      ...context,
      pastCapReason: 'run: ship the tiny unreviewed delta',
    });
    assert.deepEqual(decision, { planId: '3527', launchOrdinal: 5, denied: false });
    assert.equal(
      decision.consecutiveEscapes,
      undefined,
      'the bound is ONE — a first run: carries no escape count for the call site to report',
    );
    // The call site only calls capDenialMessage when denied — but proving what it WOULD pass
    // here (undefined) still produces the base at-cap message, never a fabricated mode-switch
    // note, ties this decision's shape directly to capDenialMessage's contract.
    const message = capDenialMessage({
      planId: decision.planId,
      launchOrdinal: decision.launchOrdinal,
      pastCapFlagName: '--past-cap',
      consecutiveEscapes: decision.consecutiveEscapes,
    });
    assert.doesNotMatch(message, /mode-switch/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

// plan 3967 fix round 2 (findings 8/9/11): the PreToolUse hook closes the Workflow/Bash-guard
// path for a `lane: fast` plan, but a dispatched subagent (no Workflow tool, and its plain-CLI
// launch never passes through that hook) reaches `reviewLaunchCapDecision` directly — so THIS
// seam must read the plan's own lane too, not rely solely on the hook. `readLaneByIdFn` is faked
// exactly as scripts/review-round-cap-guard.test.mjs fakes it — no on-disk plan file needed.
test('reviewLaunchCapDecision: a lane: fast plan denies its SECOND launch — the fastlane cap is round 1', () => {
  const r = launchCapRepo();
  const context = {
    slug: '3527-SOL-review-round-cap',
    branch: 'worktree-3527-SOL-review-round-cap',
  };
  const deps = { readLaneByIdFn: () => 'fast' };
  try {
    const first = reviewLaunchCapDecision(r.dir, context, deps);
    assert.deepEqual(first, { planId: '3527', launchOrdinal: 1, denied: false });
    const second = reviewLaunchCapDecision(r.dir, context, deps);
    assert.equal(
      second.denied,
      true,
      "a lane: fast plan's round-cap ledger path must deny the second launch, not just the hook",
    );
    assert.equal(second.launchOrdinal, 2);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

// plan 3967 fix round 3 (defect F, findings ee26d4/49bd4d/ed9cc7/70e2cf): round 2 made this seam
// APPLY the fastlane cap but never carried the plan's lane out on the denied path, so main()'s
// capDenialMessage({...}) call built the GENERIC default-cap message for a fastlane plan's second
// launch — pointing the reader at --past-cap instead of the required one-round/park contract.
test("reviewLaunchCapDecision + capDenialMessage: a lane: fast plan's cap denial names the lane and scripts/park-review-findings.mjs", () => {
  const r = launchCapRepo();
  const context = {
    slug: '3527-SOL-review-round-cap',
    branch: 'worktree-3527-SOL-review-round-cap',
  };
  const deps = { readLaneByIdFn: () => 'fast' };
  try {
    const first = reviewLaunchCapDecision(r.dir, context, deps);
    assert.equal(first.denied, false);
    const second = reviewLaunchCapDecision(r.dir, context, deps);
    assert.equal(second.denied, true);
    assert.equal(
      second.lane,
      'fast',
      "the denied decision must carry the plan's own lane so the call site can build the fastlane denial message",
    );
    // Mirrors main()'s own call site exactly (scripts/gpt-review.mjs's capDenialMessage(...) call).
    const message = capDenialMessage({
      planId: second.planId,
      launchOrdinal: second.launchOrdinal,
      pastCapFlagName: '--past-cap',
      consecutiveEscapes: second.consecutiveEscapes,
      lane: second.lane,
    });
    assert.match(message, /plan 3527 is `lane: fast`/);
    assert.match(message, /park-review-findings\.mjs/);

    // Cross-check the OTHER half of plan 3967's own acceptance criterion directly against
    // capDenialMessage: a default-lane denial (no `lane` passed, exactly what every pre-3967
    // caller and the round-4-marker test above still do) must stay byte-identical — no fastlane
    // note at all.
    const defaultMessage = capDenialMessage({
      planId: '3527',
      launchOrdinal: 5,
      pastCapFlagName: '--past-cap',
    });
    assert.doesNotMatch(defaultMessage, /lane: fast/);
    assert.doesNotMatch(defaultMessage, /park-review-findings/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

// plan 3967 fix round 4 (defect F, second denial path). `reviewLaunchCapDecision` has TWO denial
// returns, and round 3 only carried `lane` out of one of them. This covers the other: the
// object-shaped return, which is `recordLaunch`'s own ATOMIC second-consecutive-`run:`-escape
// denial. It matters more than the path round 3 fixed, not less — a fastlane plan's cap is round
// 1, so an executor who hits the denial and reaches for the documented `--past-cap "run: …"`
// escape lands on exactly this branch, and before this fix it was handed the generic default-cap
// guidance instead of being told to park with scripts/park-review-findings.mjs.
test("reviewLaunchCapDecision + capDenialMessage: a lane: fast plan's CONSECUTIVE-ESCAPE denial also names the lane", () => {
  const r = launchCapRepo();
  const context = {
    slug: '3527-SOL-review-round-cap',
    branch: 'worktree-3527-SOL-review-round-cap',
  };
  const deps = { readLaneByIdFn: () => 'fast' };
  try {
    reviewLaunchCapDecision(r.dir, context, deps); // launch 1 — allowed
    // Launch 2 and 3 both escape with `run:`; recordLaunch denies the SECOND consecutive one
    // atomically, returning an object rather than a bare ordinal.
    reviewLaunchCapDecision(r.dir, { ...context, pastCapReason: 'run: first escape' }, deps);
    const denied = reviewLaunchCapDecision(
      r.dir,
      { ...context, pastCapReason: 'run: second escape' },
      deps,
    );
    assert.equal(denied.denied, true, 'the second consecutive run: escape must be denied');
    assert.ok(
      denied.consecutiveEscapes >= 2,
      `expected the object-shaped consecutive-escape denial, got ${JSON.stringify(denied)}`,
    );
    assert.equal(
      denied.lane,
      'fast',
      'the consecutive-escape denial must carry the lane too — it is the denial a fastlane plan actually reaches',
    );
    const message = capDenialMessage({
      planId: denied.planId,
      launchOrdinal: denied.launchOrdinal,
      pastCapFlagName: '--past-cap',
      consecutiveEscapes: denied.consecutiveEscapes,
      lane: denied.lane,
    });
    assert.match(message, /plan 3527 is `lane: fast`/);
    assert.match(message, /park-review-findings\.mjs/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('reviewLaunchCapDecision: a default-lane (unstamped) plan is still allowed at the same ordinal', () => {
  const r = launchCapRepo();
  const context = {
    slug: '3527-SOL-review-round-cap',
    branch: 'worktree-3527-SOL-review-round-cap',
  };
  const deps = { readLaneByIdFn: () => null };
  try {
    const first = reviewLaunchCapDecision(r.dir, context, deps);
    assert.deepEqual(first, { planId: '3527', launchOrdinal: 1, denied: false });
    const second = reviewLaunchCapDecision(r.dir, context, deps);
    assert.deepEqual(second, { planId: '3527', launchOrdinal: 2, denied: false });
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

// plan 4078 T1: the fix-brief gate's own denial shape (`denied: true, deniedReason:
// 'fix-brief-missing'`) and the exact message main() would print for it — reusing the SAME
// `fixBriefDenialMessage` the call site imports, never a re-typed expectation.
test('reviewLaunchCapDecision: a round-2+ launch with a large fix delta and no brief denies with deniedReason "fix-brief-missing"', () => {
  const r = launchCapRepo();
  const slug = '3527-SOL-review-round-cap';
  const branch = 'worktree-3527-SOL-review-round-cap';
  try {
    const markerSha = r.g(['rev-parse', 'master']);
    // round 1 — allowed, unaffected by the brief gate (launchOrdinal < 2)
    const first = reviewLaunchCapDecision(r.dir, { slug, branch, markerSha });
    assert.deepEqual(first, { planId: '3527', launchOrdinal: 1, denied: false });

    // a 30-line fix landed on the branch since the marker sha, no brief written anywhere
    writeFileSync(
      joinPath(r.dir, 'fix.txt'),
      Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join(''),
    );
    r.g(['add', 'fix.txt']);
    r.g(['commit', '-qm', 'fix']);

    const second = reviewLaunchCapDecision(r.dir, { slug, branch, markerSha });
    assert.deepEqual(second, {
      planId: '3527',
      launchOrdinal: 2,
      denied: true,
      deniedReason: 'fix-brief-missing',
    });
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('reviewLaunchCapDecision: the SAME 30-line-no-brief shape is allowed once reviewOutDir carries the brief', () => {
  const r = launchCapRepo();
  const slug = '3527-SOL-review-round-cap';
  const branch = 'worktree-3527-SOL-review-round-cap';
  try {
    const markerSha = r.g(['rev-parse', 'master']);
    reviewLaunchCapDecision(r.dir, { slug, branch, markerSha }); // round 1
    writeFileSync(
      joinPath(r.dir, 'fix.txt'),
      Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join(''),
    );
    r.g(['add', 'fix.txt']);
    r.g(['commit', '-qm', 'fix']);

    const reviewOutDir = joinPath(r.dir, '.scratch', 'gpt-review', 'round-1-out');
    mkdirSync(reviewOutDir, { recursive: true });
    writeFileSync(joinPath(reviewOutDir, 'review-fix-brief.md'), '# brief\n');

    const decision = reviewLaunchCapDecision(r.dir, { slug, branch, markerSha, reviewOutDir });
    assert.deepEqual(decision, { planId: '3527', launchOrdinal: 2, denied: false });
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('reviewLaunchCapDecision: a 5-line fix under the carve-out is allowed with no brief', () => {
  const r = launchCapRepo();
  const slug = '3527-SOL-review-round-cap';
  const branch = 'worktree-3527-SOL-review-round-cap';
  try {
    const markerSha = r.g(['rev-parse', 'master']);
    reviewLaunchCapDecision(r.dir, { slug, branch, markerSha }); // round 1
    writeFileSync(
      joinPath(r.dir, 'fix.txt'),
      Array.from({ length: 5 }, (_, i) => `line ${i}\n`).join(''),
    );
    r.g(['add', 'fix.txt']);
    r.g(['commit', '-qm', 'small fix']);

    const decision = reviewLaunchCapDecision(r.dir, { slug, branch, markerSha });
    assert.deepEqual(decision, { planId: '3527', launchOrdinal: 2, denied: false });
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('main() would print fixBriefDenialMessage for a fix-brief-missing denial, naming the exact brief command and both checked candidates', () => {
  const repoRoot = '/repo';
  const slug = '3527-SOL-review-round-cap';
  const outDir = '/repo/out';
  const message = fixBriefDenialMessage({
    planId: '3527',
    slug,
    launchOrdinal: 2,
    candidates: [joinPath(outDir, 'review-fix-brief.md'), reviewFixBriefPath(repoRoot, slug)],
  });
  assert.match(message, /denying launch 2 for plan 3527/);
  assert.match(message, /round 1's fix landed with no fresh-context brief/);
  assert.match(message, new RegExp(`node scripts/review-fix-brief\\.mjs ${slug} --round 1`));
  assert.match(message, /10 changed lines needs no brief/);
});

test('buildPastCapStatsField: an absent escape adds no bytes; a supplied reason is unchanged', () => {
  assert.deepEqual(buildPastCapStatsField(null), {});
  assert.deepEqual(buildPastCapStatsField(undefined), {});
  assert.deepEqual(buildPastCapStatsField('  exact reason  '), {
    pastCap: { reason: '  exact reason  ' },
  });
});

const PORCELAIN = [
  'worktree C:/repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/master',
  '',
  'worktree C:/repo/.claude/worktrees/mine',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/worktree-mine',
  '',
  'worktree C:/repo/.claude/coord-worktree',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
].join('\n');

// The porcelain parse itself is NOT retested here: gpt-review.mjs imports the canonical
// `parseWorktreePorcelain` from scripts/coord/worktree-porcelain.mjs ("THE ONE" parser, plan 2058),
// which owns its own coverage. A second copy here was the review's reuse finding (7950ea).

// The injected runGit keeps this a pure unit test — no repo, no worktrees on disk.
function fakeGit(aheadByBranch, { worktreeListThrows = false } = {}) {
  return (args) => {
    if (args[0] === 'worktree') {
      if (worktreeListThrows) throw new Error('git worktree list exploded');
      return PORCELAIN;
    }
    if (args[0] === 'rev-list') {
      const branch = String(args[2]).split('..')[1];
      if (!(branch in aheadByBranch)) throw new Error(`unknown revision ${branch}`);
      return `${aheadByBranch[branch]}\n`;
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
}

test('collectAheadWorktrees: only branches AHEAD of origin/master, never the checkout we already looked at, never detached', () => {
  const got = collectAheadWorktrees(
    'C:/repo',
    fakeGit({ master: 7, 'worktree-mine': 3 }), // master is ahead too, but it IS repoRoot
    'win32',
  );
  assert.deepEqual(got, [
    { path: 'C:/repo/.claude/worktrees/mine', branch: 'worktree-mine', ahead: 3 },
  ]);
});

// The repoRoot compare is platform-dependent, so the platform is a PARAMETER on both sides:
// win32 folds separators + case, POSIX compares verbatim. Both directions are asserted, so
// this passes identically on the Windows pre-push gate and in a Linux cloud drain.
test('collectAheadWorktrees (win32): a backslashed, differently-cased repoRoot still matches git\u2019s forward-slash output', () => {
  const got = collectAheadWorktrees(
    'C:\\Repo\\',
    fakeGit({ master: 7, 'worktree-mine': 3 }),
    'win32',
  );
  assert.deepEqual(
    got.map((c) => c.branch),
    ['worktree-mine'],
    'on win32 the main checkout must be recognised and excluded',
  );
});

test('collectAheadWorktrees (posix): case differences are REAL — /repo and /Repo are different worktrees', () => {
  const runGit = (args) => {
    if (args[0] === 'worktree')
      return ['worktree /repo', 'branch refs/heads/master', ''].join('\n');
    return '5\n';
  };
  // POSIX: '/Repo' is NOT the same path as '/repo', so the entry must SURVIVE as a candidate.
  assert.deepEqual(
    collectAheadWorktrees('/Repo', runGit, 'linux').map((c) => c.path),
    ['/repo'],
  );
  // Same bytes on both sides — now it IS the checkout we already looked at, so it is excluded.
  assert.deepEqual(collectAheadWorktrees('/repo', runGit, 'linux'), []);
});

test('collectAheadWorktrees: a zero-ahead branch is not a candidate', () => {
  const got = collectAheadWorktrees(
    'C:/elsewhere',
    fakeGit({ master: 0, 'worktree-mine': 0 }),
    'win32',
  );
  assert.deepEqual(got, []);
});

test('collectAheadWorktrees: sorted by commits-ahead, descending', () => {
  const runGit = (args) => {
    if (args[0] === 'worktree')
      return [
        'worktree C:/a',
        'branch refs/heads/small',
        '',
        'worktree C:/b',
        'branch refs/heads/big',
        '',
      ].join('\n');
    return String(args[2].endsWith('big') ? 12 : 2);
  };
  assert.deepEqual(
    collectAheadWorktrees('C:/root', runGit, 'win32').map((c) => c.branch),
    ['big', 'small'],
  );
});

test('collectAheadWorktrees: enumeration failure degrades to no candidates, never throws', () => {
  assert.deepEqual(
    collectAheadWorktrees('C:/repo', fakeGit({}, { worktreeListThrows: true }), 'win32'),
    [],
  );
  // a rev-list that cannot resolve the branch drops THAT candidate and keeps the rest
  assert.deepEqual(collectAheadWorktrees('C:/elsewhere', fakeGit({ master: 4 }), 'win32'), [
    { path: 'C:/repo', branch: 'master', ahead: 4 },
  ]);
});

// plan 3618 round 3 finding f146f0: this diagnostic (collectAheadWorktrees) and
// resolveReviewTargetBranch's own sibling hunt used to disagree about which siblings qualify — a
// sibling with only tracked uncommitted changes and zero committed commits ahead was found by
// one and not the other. Real repo, real worktrees: one sibling genuinely ahead by a commit, one
// with ONLY a tracked uncommitted change — both collectors must report BOTH.
test('collectAheadWorktrees and resolveReviewTargetBranch report the SAME candidates — finding f146f0', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gptrev-onecollector-'));
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  const aheadWorktree = joinPath(dir, 'ahead-sibling');
  const trackedWorktree = joinPath(dir, 'tracked-sibling');
  try {
    g('init', '-q', '-b', 'master');
    g('config', 'user.email', 'f@x');
    g('config', 'user.name', 'f');
    writeFileSync(joinPath(dir, 'shared.txt'), 'shared\n');
    g('add', 'shared.txt');
    g('commit', '-qm', 'initial');
    g('update-ref', 'refs/remotes/origin/master', 'HEAD');
    g('worktree', 'add', '-q', '-b', 'worktree-9001-ahead', aheadWorktree);
    writeFileSync(joinPath(aheadWorktree, 'ahead.txt'), 'ahead\n');
    execFileSync('git', ['-C', aheadWorktree, 'add', 'ahead.txt'], { encoding: 'utf8' });
    execFileSync(
      'git',
      ['-C', aheadWorktree, '-c', 'user.name=f', '-c', 'user.email=f@x', 'commit', '-qm', 'ahead'],
      { encoding: 'utf8' },
    );
    g('worktree', 'add', '-q', '-b', 'worktree-9002-tracked', trackedWorktree);
    // zero commits ahead — the ONLY change is a tracked, uncommitted modification.
    writeFileSync(joinPath(trackedWorktree, 'shared.txt'), 'modified\n');

    const collected = collectAheadWorktrees(dir)
      .map((c) => c.branch)
      .sort();
    const resolved = resolveReviewTargetBranch({ tokens: [], cwd: dir, allowSiblingHunt: true });
    assert.equal(resolved.status, 'ambiguous', JSON.stringify(resolved));
    const viaResolver = resolved.candidates.map((c) => c.branch).sort();
    assert.deepEqual(collected, ['worktree-9001-ahead', 'worktree-9002-tracked']);
    assert.deepEqual(viaResolver, ['worktree-9001-ahead', 'worktree-9002-tracked']);
    assert.deepEqual(collected, viaResolver, 'the two collectors must never disagree');
  } finally {
    try {
      g('worktree', 'remove', '--force', aheadWorktree);
    } catch {
      /* best-effort cleanup */
    }
    try {
      g('worktree', 'remove', '--force', trackedWorktree);
    } catch {
      /* best-effort cleanup */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatEmptyRangeError: names the candidate worktree, the branch, and says no stats.json was written', () => {
  const msg = formatEmptyRangeError({
    repoRoot: 'C:/repo',
    rangeLabel: 'abc..def',
    headLabel: 'master',
    candidates: [{ path: 'C:/repo/.claude/worktrees/mine', branch: 'worktree-mine', ahead: 3 }],
  });
  assert.match(msg, /EMPTY RANGE/);
  assert.match(msg, /worktree-mine/);
  assert.match(msg, /C:\/repo\/\.claude\/worktrees\/mine/);
  assert.match(msg, /3 commit\(s\)/);
  assert.match(msg, /no stats\.json/i);
  assert.match(msg, /NOT a PASS/);
});

// plan 3618 round 4 finding 566eb0: a tracked-only candidate (ahead: 0, real uncommitted work —
// finding f146f0's own fix) must read as real work, not "0 commit(s)" noise a reader would
// reasonably discount and skip.
test('formatEmptyRangeError: a tracked-only (ahead: 0) candidate reads as real work, not noise — finding 566eb0', () => {
  const msg = formatEmptyRangeError({
    repoRoot: 'C:/repo',
    rangeLabel: 'abc..def',
    headLabel: 'master',
    candidates: [{ path: 'C:/repo/.claude/worktrees/mine', branch: 'worktree-mine', ahead: 0 }],
  });
  assert.doesNotMatch(msg, /0 commit\(s\)/);
  assert.match(msg, /tracked changes/);
  assert.match(msg, /worktree-mine/);
  assert.match(msg, /carry commits OR tracked changes/i);
});

// The recovery line must actually RECOVER: cd into the candidate, run THAT worktree's copy,
// quoted, with the caller's own flags preserved. A rerun in the same wrong cwd, or a `<repo>`
// placeholder, reproduces the failure (review round 1 bb6012, round 2's six :1813 findings).
const CAND = { path: 'C:/repo/.claude/worktrees/mine', branch: 'worktree-mine', ahead: 3 };

// It runs THIS runner against the candidate, not the candidate's own copy: a worktree cut
// before --repo landed carries a runner that silently ignores the flag, so the hint would
// have reviewed the wrong checkout (round 4).
test('recoveryCommand: names the candidate via --repo, invoking the RUNNING copy of the runner', () => {
  assert.equal(
    recoveryCommand(CAND, [], 'C:/main/scripts/gpt-review.mjs'),
    "node 'C:/main/scripts/gpt-review.mjs' --repo 'C:/repo/.claude/worktrees/mine'",
  );
  // never the candidate's own copy — that one may predate the flag
  assert.doesNotMatch(
    recoveryCommand(CAND, [], 'C:/main/scripts/gpt-review.mjs'),
    /worktrees\/mine\/scripts/,
  );
});

// The whole point of --repo: the hint must not OPEN with `cd`. A Git-Bash command that does
// is never handed to this machine's auto-approval classifier, so an agent pasting it stalls.
test('recoveryCommand: never emits a cd — that is what --repo exists to avoid', () => {
  const cmd = recoveryCommand(CAND, ['--concurrency', '4']);
  assert.doesNotMatch(cmd, /(^|\s)cd\s/);
  assert.doesNotMatch(cmd, /&&/);
  assert.match(cmd, /^node /);
});

test('recoveryCommand: a path with a space stays ONE argument', () => {
  const cmd = recoveryCommand({ path: 'C:/98 Hobby/vetapp', branch: 'b', ahead: 1 });
  assert.match(cmd, /--repo 'C:\/98 Hobby\/vetapp'/);
});

// Single quotes, not double: `$VAR` interpolates inside double quotes in bash AND
// PowerShell, and a worktree path may legally contain one.
test('recoveryCommand: shell metacharacters in a path are not interpolated', () => {
  const cmd = recoveryCommand({ path: '/tmp/$HOME dir', branch: 'b', ahead: 1 });
  assert.match(cmd, /--repo '\/tmp\/\$HOME dir'/);
  assert.doesNotMatch(cmd, /"/);
});

test('shellQuoteArg: an embedded single quote is escaped, not swallowed', () => {
  assert.equal(shellQuoteArg("it's"), "'it'\\''s'");
});

test('recoveryCommand: preserves the caller\u2019s flags, quoted, but DROPS --out and the old --repo', () => {
  const cmd = recoveryCommand(CAND, [
    '--concurrency',
    '8',
    '--out',
    '.scratch/old',
    '--repo',
    'C:/wrong',
    '--range',
    'a b..c',
    '--no-claude-arm',
  ]);
  assert.match(cmd, /--concurrency' '8'/);
  assert.match(cmd, /'--range' 'a b\.\.c'/, 'a value with a space survives as one argument');
  assert.match(cmd, /'--no-claude-arm'/);
  assert.doesNotMatch(cmd, /\.scratch\/old/);
  assert.doesNotMatch(cmd, /C:\/wrong/);
  assert.equal((cmd.match(/--repo/g) || []).length, 1, 'exactly one --repo, the new one');
});

// The shared parser also accepts `--name=value`, so the drop must cover that form: a
// surviving `--out=…` points the re-run back at THIS failed run's directory (round 7).
test('recoveryCommand: drops the --out=/--repo= equals form too', () => {
  const cmd = recoveryCommand(CAND, ['--out=.scratch/old', '--repo=C:/wrong', '--concurrency=8']);
  assert.doesNotMatch(cmd, /\.scratch\/old/);
  assert.doesNotMatch(cmd, /C:\/wrong/);
  assert.match(cmd, /'--concurrency=8'/, 'other equals-form flags survive');
  assert.equal((cmd.match(/--repo/g) || []).length, 1);
  assert.equal((cmd.match(/--out/g) || []).length, 0);
});

test('formatEmptyRangeError: the printed recovery line is the real command, never a placeholder', () => {
  const msg = formatEmptyRangeError({
    repoRoot: 'C:/repo',
    rangeLabel: 'abc..def',
    headLabel: 'master',
    candidates: [CAND],
    argv: ['--concurrency', '2'],
  });
  assert.match(msg, /^\s*node '.*gpt-review\.mjs' --repo 'C:\/repo\/\.claude\/worktrees\/mine'/m);
  assert.match(msg, /'--concurrency' '2'/);
  assert.doesNotMatch(msg, /<repo>/);
  // ranking is a heuristic — the message must say so rather than imply the top row is correct
  assert.match(msg, /Ranking is by commits-ahead only/);
});

test('formatEmptyRangeError: the candidate list is capped, and the overflow is NAMED, never silent', () => {
  const many = Array.from({ length: 16 }, (_, i) => ({
    path: `C:/repo/.claude/worktrees/w${i}`,
    branch: `worktree-w${i}`,
    ahead: 16 - i,
  }));
  const msg = formatEmptyRangeError({
    repoRoot: 'C:/repo',
    rangeLabel: 'abc..def',
    headLabel: 'master',
    candidates: many,
    cap: 10,
  });
  assert.match(msg, /worktree-w0\b/, 'the top candidate is listed');
  assert.doesNotMatch(msg, /worktree-w15\b/, 'the 16th is past the cap');
  assert.match(msg, /… and 6 more/);
  // Under the cap, no overflow line at all.
  assert.doesNotMatch(
    formatEmptyRangeError({
      repoRoot: 'C:/repo',
      rangeLabel: 'abc..def',
      headLabel: 'master',
      candidates: many.slice(0, 3),
      cap: 10,
    }),
    /more \(/,
  );
});

test('formatEmptyRangeError: with no candidates it says so plainly instead of printing an empty list', () => {
  const msg = formatEmptyRangeError({
    repoRoot: 'C:/repo',
    rangeLabel: 'abc..def',
    headLabel: 'master',
    candidates: [],
  });
  assert.match(msg, /No worktree in this repo carries commits ahead/);
  assert.doesNotMatch(msg, /re-run from the right one/);
});

test('formatEmptyRangeError: an explicitly-passed range adds the --range hint (still an error)', () => {
  const explicit = formatEmptyRangeError({
    repoRoot: 'C:/repo',
    rangeLabel: 'v1..v2',
    headLabel: 'master',
    candidates: [],
    rangeExplicit: true,
  });
  assert.match(explicit, /--range\/--end-ref/);
  assert.match(explicit, /EMPTY RANGE/);
  const implicit = formatEmptyRangeError({
    repoRoot: 'C:/repo',
    rangeLabel: 'abc..def',
    headLabel: 'master',
    candidates: [],
  });
  assert.doesNotMatch(implicit, /--range\/--end-ref/);
});

// A repo whose HEAD IS origin/master — exactly the main-checkout-on-master shape.
function emptyRangeRepo() {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gptrev-empty-'));
  const g = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  g(['init', '-q', '-b', 'master']);
  g(['config', 'user.email', 'f@x']);
  g(['config', 'user.name', 'f']);
  writeFileSync(joinPath(dir, 'README.md'), 'fixture\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'fixture']);
  g(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
  return dir;
}

test('gpt-review (integration): an empty range exits EXIT_EMPTY_RANGE and writes NO stats.json', () => {
  const dir = emptyRangeRepo();
  const outDir = joinPath(dir, 'out');
  const res = spawnSync(process.execPath, [GPT_REVIEW_PATH, '--no-detach', '--out', outDir], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(
    res.status,
    EXIT_EMPTY_RANGE,
    `expected exit ${EXIT_EMPTY_RANGE}, got ${res.status}`,
  );
  assert.match(res.stderr, /EMPTY RANGE/);
  assert.equal(
    existsSync(joinPath(outDir, 'stats.json')),
    false,
    'stats.json must NOT exist — its absence is what stops a fake PASS being recorded',
  );
  assert.equal(existsSync(joinPath(outDir, 'findings.json')), false);
  assert.ok(existsSync(joinPath(outDir, 'summary.md')), 'the failure is still written up');
  assert.match(readFileSync(joinPath(outDir, 'summary.md'), 'utf8'), /FAILED \(empty range\)/);
  rmSync(dir, { recursive: true, force: true });
});

// The bug the review caught (d2be8a + 6 siblings): writing no NEW stats.json is not enough.
// `--out .scratch/gpt-review/<slug>` is the DOCUMENTED shape, so a re-run of the same plan
// reuses a directory that may still hold a pass-shaped stats.json from an earlier clean run —
// exactly what `record-review.mjs --review-stats` reads.
test('gpt-review (integration): a STALE stats.json from an earlier run in the same --out is DELETED', () => {
  const dir = emptyRangeRepo();
  const outDir = joinPath(dir, 'out');
  mkdirSync(joinPath(outDir, 'raw'), { recursive: true });
  mkdirSync(joinPath(outDir, 'finders'), { recursive: true });
  // checkpoint.json is in the set for a second reason: this runner RESUMES from it, keyed by
  // angle tag — a key that says nothing about the range — so an earlier run's checkpoint
  // would let the corrected re-run replay cached answers for a DIFFERENT diff (round 2).
  // diff.patch is in the set for a THIRD reason (round 3, item A): a reused --out can still hold
  // the PREVIOUS run's materialized patch, which an operator inspecting a failed run could
  // mistake for evidence describing the current (failed) range.
  const stale = ['stats.json', 'findings.json', 'refuted.json', 'checkpoint.json', 'diff.patch'];
  for (const name of stale) writeFileSync(joinPath(outDir, name), '{"stats":{"finders":11}}\n');
  writeFileSync(joinPath(outDir, 'raw', 'angle-A.json'), '{}\n');
  // Round 3, item A: a prior run's per-finder stderr diagnostic must go the same way as raw/ —
  // it too describes a DIFFERENT (earlier) run's failure, not this one's.
  writeFileSync(joinPath(outDir, 'finders', 'angle-A.stderr.txt'), 'boom\n');
  const res = spawnSync(process.execPath, [GPT_REVIEW_PATH, '--no-detach', '--out', outDir], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(res.status, EXIT_EMPTY_RANGE);
  for (const name of stale) {
    assert.equal(
      existsSync(joinPath(outDir, name)),
      false,
      `${name} from the earlier run must not survive an empty-range failure`,
    );
  }
  assert.equal(
    existsSync(joinPath(outDir, 'raw', 'angle-A.json')),
    false,
    'the cached raw call results must go too — they are what the checkpoint points at',
  );
  assert.equal(
    existsSync(joinPath(outDir, 'finders', 'angle-A.stderr.txt')),
    false,
    'a prior run’s per-finder stderr diagnostic must not survive either (round 3, item A)',
  );
  rmSync(dir, { recursive: true, force: true });
});

// Round 3: `new Checkpoint()` JSON.parses an existing checkpoint.json, and it used to be
// constructed BEFORE the guard — so a malformed one from an earlier run threw and the cleanup
// was unreachable in exactly the state it exists to clean up.
test('gpt-review (integration): a MALFORMED stale checkpoint does not prevent the empty-range guard', () => {
  const dir = emptyRangeRepo();
  const outDir = joinPath(dir, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(joinPath(outDir, 'checkpoint.json'), '{ not json');
  writeFileSync(joinPath(outDir, 'stats.json'), '{"stats":{"finders":11}}\n');
  const res = spawnSync(process.execPath, [GPT_REVIEW_PATH, '--no-detach', '--out', outDir], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(res.status, EXIT_EMPTY_RANGE, `expected the guard to run; stderr: ${res.stderr}`);
  assert.equal(existsSync(joinPath(outDir, 'stats.json')), false);
  assert.equal(existsSync(joinPath(outDir, 'checkpoint.json')), false);
  rmSync(dir, { recursive: true, force: true });
});

// --repo is the recovery mechanism: reviewing a checkout you are not sitting in.
test('gpt-review (integration): --repo reviews the NAMED checkout, not the cwd', () => {
  const dir = emptyRangeRepo();
  const elsewhere = mkdtempSync(joinPath(tmpdir(), 'gptrev-cwd-'));
  const outDir = joinPath(elsewhere, 'out');
  const res = spawnSync(
    process.execPath,
    [GPT_REVIEW_PATH, '--no-detach', '--repo', dir, '--out', outDir],
    {
      cwd: elsewhere, // NOT a git repo at all — only --repo makes this run resolvable
      encoding: 'utf8',
    },
  );
  assert.equal(res.status, EXIT_EMPTY_RANGE, `stderr: ${res.stderr}`);
  assert.match(res.stderr, /EMPTY RANGE/, 'it reached the named repo and found it empty');
  rmSync(dir, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

// Silently dropping an unknown flag is newly dangerous with --repo in the set: a mistyped
// `--rep <path>` would review the CWD's repo and be read as the answer for the named one.
// parseArgs delegates to the ONE shared value-aware parser (plans 1769/1777) with
// `requireValues`, so a typo'd or valueless flag THROWS instead of being dropped. Both
// refusals exist for --repo specifically: either way the review would otherwise have run
// against the CWD's checkout while the caller read the result as the answer for the one
// they named.
test('parseArgs: the documented flags round-trip, defaults intact', () => {
  assert.deepEqual(parseArgs([]), {
    range: 'origin/master...HEAD',
    rangeExplicit: false,
    endRef: null,
    concurrency: DEFAULT_CONCURRENCY,
    out: null,
    repo: null,
    claudeArm: true,
    gatePrep: true,
    detachFlag: false,
    noDetachFlag: false,
    status: false,
    wait: false,
    paths: [],
    excludePaths: [],
    pastCapReason: null,
  });
  const a = parseArgs(['--repo', 'C:/x', '--concurrency', '8', '--no-claude-arm']);
  assert.equal(a.repo, 'C:/x');
  assert.equal(a.concurrency, 8);
  assert.equal(a.claudeArm, false);
  assert.equal(a.gatePrep, true);
  assert.equal(parseArgs(['--no-gate-prep']).gatePrep, false);
  const b = parseArgs(['--range', 'a..b', '--end-ref', 'deadbeef', '--out', 'C:/o']);
  assert.equal(b.range, 'a..b');
  assert.equal(b.rangeExplicit, true, 'an explicit --range keeps its string-range semantics');
  assert.equal(b.endRef, 'deadbeef');
  assert.equal(b.out, 'C:/o');
  // concurrency clamping is unchanged by the delegation
  assert.equal(parseArgs(['--concurrency', '0']).concurrency, 1);
  assert.equal(parseArgs(['--concurrency', 'junk']).concurrency, DEFAULT_CONCURRENCY);
});

test('plan 3872: review detach policy defaults locally, stays foreground remotely, and loudly refuses explicit cloud detach', () => {
  assert.deepEqual(
    reviewDetachDecision({ detachFlag: false, noDetachFlag: false, remote: false }),
    { action: 'detach' },
  );
  assert.deepEqual(reviewDetachDecision({ detachFlag: false, noDetachFlag: true, remote: false }), {
    action: 'foreground',
  });
  assert.deepEqual(reviewDetachDecision({ detachFlag: true, noDetachFlag: false, remote: false }), {
    action: 'detach',
  });
  assert.deepEqual(reviewDetachDecision({ detachFlag: false, noDetachFlag: false, remote: true }), {
    action: 'foreground',
  });
  assert.deepEqual(reviewDetachDecision({ detachFlag: false, noDetachFlag: true, remote: true }), {
    action: 'foreground',
  });
  assert.match(
    reviewDetachDecision({ detachFlag: true, noDetachFlag: false, remote: true }).message,
    /cloud.*foreground-only/i,
  );
});

test('plan 3872 fix F1/F2: detached exits are collision-free and only the exact remote truthy string is cloud', () => {
  assert.equal(EXIT_WAIT_STILL_RUNNING, 6);
  assert.equal(EXIT_DETACHED_GONE, 7);
  assert.equal(isClaudeCodeRemote('true'), true);
  assert.equal(isClaudeCodeRemote('false'), false);
  assert.equal(isClaudeCodeRemote('1'), false);
  assert.equal(isClaudeCodeRemote(undefined), false);
});

test('plan 3872 fix F3: detached child argv pins resolved out/repo for split and equals spellings', () => {
  assert.deepEqual(
    rewriteDetachedChildArgs(
      ['--detach', '--out', '.scratch/run', '--repo=../relative-repo', '--paths', 'scripts/**'],
      { outDir: '/abs/out', repoRoot: '/abs/repo' },
    ),
    ['--out', '/abs/out', '--repo=/abs/repo', '--paths', 'scripts/**'],
  );
  assert.deepEqual(rewriteDetachedChildArgs([], { outDir: '/abs/out', repoRoot: '/abs/repo' }), [
    '--out',
    '/abs/out',
    '--repo',
    '/abs/repo',
  ]);
});

test('plan 3872 fix F4: an omitted --out allocates the documented timestamped directory', () => {
  assert.equal(
    defaultReviewOutDir('/caller', '2026-09-09T12-34-56-000Z'),
    joinPath('/caller', '.scratch', 'gpt-review', '2026-09-09T12-34-56-000Z'),
  );
});

test('plan 3872 G3: detached relaunch preserves the previous completed review', () => {
  const source = readFileSync(fileURLToPath(new URL('./gpt-review.mjs', import.meta.url)), 'utf8');
  const fn = source.slice(
    source.indexOf('function spawnDetachedReview'),
    source.indexOf('\nasync function main()', source.indexOf('function spawnDetachedReview')),
  );
  assert.doesNotMatch(fn, /clearDetachedTerminalArtifacts/);
});

test('plan 3872 fix F8: detached metadata is durably published before the child spawn', () => {
  const source = readFileSync(fileURLToPath(new URL('./gpt-review.mjs', import.meta.url)), 'utf8');
  const fn = source.slice(
    source.indexOf('function spawnDetachedReview'),
    source.indexOf('\nasync function main()', source.indexOf('function spawnDetachedReview')),
  );
  assert.ok(fn.indexOf('atomicWriteTextSync(') < fn.indexOf('spawnDetachedWorktreeChild({'));
});

test('plan 3872 G2: --wait treats an unrecorded run as terminal (deliberately reversing F6 now that F8 closed the race)', () => {
  const unknown = { done: false, failed: true };
  const gone = { done: false, failed: true };
  assert.equal(progressCommandExitCode({ progress: unknown, wait: false, timedOut: false }), 0);
  assert.equal(
    progressCommandExitCode({ progress: unknown, wait: true, timedOut: false }),
    EXIT_DETACHED_GONE,
  );
  assert.equal(
    progressCommandExitCode({ progress: gone, wait: true, timedOut: false }),
    EXIT_DETACHED_GONE,
  );
});

test('plan 3872: progress classifier distinguishes finders, verify, adjudicate, done, and dead', () => {
  assert.equal(REVIEW_WAIT_TIMEOUT_MS, 540_000);
  assert.equal(REVIEW_LAUNCH_GRACE_MS, 60_000);
  assert.deepEqual(
    classifyRunProgress({
      checkpointCalls: { 'finder:a:hash': {}, 'finder:b:hash': {} },
      finderCount: 3,
      hasFindings: false,
      hasSummary: false,
      pidAlive: true,
      metadataPresent: true,
      pidPresent: true,
      findingsFresh: false,
    }),
    { stage: 'finders', done: false, failed: false, label: 'finders 2/3' },
  );
  assert.equal(
    classifyRunProgress({
      checkpointCalls: { 'finder:a': {}, 'finder:b': { error: 'retry me' }, 'finder:c': {} },
      finderCount: 3,
      hasFindings: false,
      hasSummary: false,
      pidAlive: true,
      metadataPresent: true,
      pidPresent: true,
      findingsFresh: false,
    }).stage,
    'finders',
  );
  assert.equal(
    classifyRunProgress({
      checkpointCalls: { 'finder:a': {}, 'finder:b': {}, 'finder:c': {} },
      finderCount: 3,
      hasFindings: false,
      hasSummary: false,
      pidAlive: true,
      metadataPresent: true,
      pidPresent: true,
      findingsFresh: false,
    }).stage,
    'verify',
  );
  assert.equal(
    classifyRunProgress({
      checkpointCalls: { 'adjudicate:file:1': {} },
      finderCount: 3,
      hasFindings: false,
      hasSummary: false,
      pidAlive: true,
      metadataPresent: true,
      pidPresent: true,
      findingsFresh: false,
    }).stage,
    'adjudicate',
  );
  assert.equal(
    classifyRunProgress({
      checkpointCalls: {},
      finderCount: 3,
      hasFindings: true,
      hasSummary: true,
      pidAlive: false,
      metadataPresent: true,
      pidPresent: true,
      findingsFresh: true,
    }).stage,
    'done',
  );
  assert.deepEqual(
    classifyRunProgress({
      checkpointCalls: null,
      finderCount: 3,
      hasFindings: false,
      hasSummary: false,
      pidAlive: false,
      metadataPresent: true,
      pidPresent: true,
      findingsFresh: false,
    }),
    { stage: 'dead', done: false, failed: true, label: 'dead (no findings)' },
  );
  assert.deepEqual(
    classifyRunProgress({
      checkpointCalls: null,
      finderCount: 3,
      hasFindings: false,
      hasSummary: false,
      pidAlive: null,
      metadataPresent: false,
      pidPresent: false,
      findingsFresh: true,
    }),
    { stage: 'not-started', done: false, failed: true, label: 'no detached run recorded' },
  );
});

test('plan 3872 G1: a null pid is launching only inside the bounded grace window', () => {
  const base = {
    checkpointCalls: null,
    finderCount: 11,
    hasFindings: false,
    hasSummary: false,
    findingsFresh: false,
    pidAlive: null,
    pidPresent: false,
    metadataPresent: true,
  };
  assert.deepEqual(classifyRunProgress({ ...base, metadataAgeMs: 59_999 }), {
    stage: 'launching',
    done: false,
    failed: false,
    label: 'launching',
  });
  assert.deepEqual(classifyRunProgress({ ...base, metadataAgeMs: 60_000 }), {
    stage: 'launch-failed',
    done: false,
    failed: true,
    label: 'launch failed (pid not recorded)',
  });
});

test('plan 3872 G3: stale detached findings do not complete a replacement, but foreground findings do', () => {
  const base = {
    checkpointCalls: null,
    finderCount: 11,
    hasFindings: true,
    hasSummary: true,
    pidAlive: true,
    pidPresent: true,
    metadataAgeMs: 1,
  };
  assert.equal(
    classifyRunProgress({ ...base, metadataPresent: true, findingsFresh: false }).done,
    false,
  );
  assert.equal(
    classifyRunProgress({ ...base, metadataPresent: true, findingsFresh: true }).done,
    true,
  );
  assert.equal(
    classifyRunProgress({ ...base, metadataPresent: false, findingsFresh: false }).done,
    true,
  );
});

test('plan 3872 I1/I4: detached spawn installs an error sink and no-pid diagnostics use synchronous fds', () => {
  const durable = [];
  const exits = [];
  let errorListener;
  const child = {
    pid: undefined,
    on(event, listener) {
      if (event === 'error') errorListener = listener;
    },
  };
  handleDetachedSpawnResult({
    child,
    fd: 41,
    writeSyncFn: (fd, message) => durable.push([fd, message]),
    exit: (code) => exits.push(code),
  });
  assert.equal(
    typeof errorListener,
    'function',
    'an error listener must exist before pid handling',
  );
  errorListener(new Error('late spawn failure'));
  assert.deepEqual(durable, [
    [41, '[gpt-review] detached review failed to spawn (pid not recorded)\n'],
    [2, '[gpt-review] detached review failed to spawn (pid not recorded)\n'],
    [41, '[gpt-review] detached review spawn error: late spawn failure\n'],
  ]);
  assert.deepEqual(exits, [EXIT_DETACHED_GONE]);
});

test('plan 3872 I2: a confirmed detached spawn does not mutate child-owned review artifacts', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gptrev-detached-artifacts-'));
  try {
    for (const name of EMPTY_RANGE_STALE_ARTIFACTS) {
      writeFileSync(joinPath(dir, name), name);
    }
    handleDetachedSpawnResult({
      child: { pid: 42, on() {} },
      fd: 41,
    });
    for (const name of EMPTY_RANGE_STALE_ARTIFACTS) {
      assert.equal(existsSync(joinPath(dir, name)), true, `${name} must remain child-owned`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan 3872 I3: detached poll command invokes the absolute running runner and quotes spaces', () => {
  assert.equal(
    detachedPollCommand('/tmp/review output', '/repo with spaces/scripts/gpt-review.mjs'),
    `node '/repo with spaces/scripts/gpt-review.mjs' --wait --out '/tmp/review output'`,
  );
});

test('plan 3872 H3: findings freshness is one fail-soft stat and admits the start millisecond', () => {
  let calls = 0;
  assert.deepEqual(
    probeFindingsFreshness('/findings.json', 1234, () => {
      calls++;
      return { mtimeMs: 1234 };
    }),
    { hasFindings: true, findingsFresh: true },
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    probeFindingsFreshness('/vanished.json', 1234, () => {
      throw Object.assign(new Error('vanished'), { code: 'ENOENT' });
    }),
    { hasFindings: false, findingsFresh: false },
  );
});

test('plan 3872: progress logging keeps first, changed, and terminal observations only', () => {
  assert.equal(shouldLogProgressObservation(null, 'finders 0/11', false), true);
  assert.equal(shouldLogProgressObservation('finders 0/11', 'finders 0/11', false), false);
  assert.equal(shouldLogProgressObservation('finders 0/11', 'finders 1/11', false), true);
  assert.equal(shouldLogProgressObservation('verify', 'verify', true), true);
});

test('plan 3503: local worktree reviews spawn no-rebase prep; opt-out, cloud, and a held lock each log one decline', () => {
  assert.deepEqual(
    gatePrepSpawnDecision({
      gatePrep: true,
      remote: false,
      slug: '3503-slug',
      cliExists: true,
      lockHeld: false,
    }),
    { spawn: true, log: null },
  );

  const declined = [
    [
      { gatePrep: false, remote: false, slug: '3503-slug', cliExists: true, lockHeld: false },
      /disabled by --no-gate-prep/,
    ],
    [
      { gatePrep: true, remote: true, slug: '3503-slug', cliExists: true, lockHeld: false },
      /CLAUDE_CODE_REMOTE is set/,
    ],
    [
      { gatePrep: true, remote: false, slug: '3503-slug', cliExists: true, lockHeld: true },
      /a prep is already running in this worktree/,
    ],
  ];
  for (const [inputs, wording] of declined) {
    const decision = gatePrepSpawnDecision(inputs);
    assert.equal(decision.spawn, false);
    assert.match(decision.log, wording);
    assert.equal(decision.log.split('\n').length, 1, 'each decline is exactly one log line');
  }
});

// plan 3503 round 3: helper to set/restore a batch of env vars around a test body without the
// nested try/finally pyramid four+ vars would otherwise force. Restores exactly what it saved,
// including "was absent" (delete), so a test never leaks a var into the ones that run after it.
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('plan 3503 round 2 finding 84b237: named-repo child env scrubs ambient git before explicit git settings', () => {
  // plan 3832: this test's `ALLOW_LANDED_REVERSION` leg pinned CHILD_ENV_STRIP's former sole,
  // now-retired entry — childEnv()'s ALWAYS-APPLIED base list used to include it regardless of
  // the `names` option gitRepoIsolatedEnv() passes, so it rode along on gatePrepChildEnv() as a
  // side effect of the base list rather than anything this call path asked for. CHILD_ENV_STRIP
  // is now `[]` (see child-env.mjs), so that side effect is gone; gatePrepChildEnv() only ever
  // dropped GIT_REPO_SELECTOR_VARS on purpose, which is what this test still pins — the
  // ambient-GIT_DIR scrub the finding was actually about.
  withEnv({ GIT_DIR: 'C:/ambient/wrong-repo/.git' }, () => {
    const env = gatePrepChildEnv();
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GCM_INTERACTIVE, 'never');
  });
});

// plan 3503 round 3: round 2's gitIsolatedEnv() fixed the ambient-GIT_DIR bug above but, being a
// blanket GIT_* strip, ALSO dropped transport/credential variables — breaking the detached
// `--prep` child's network access the same way. gatePrepChildEnv() now routes through
// gitRepoIsolatedEnv() instead, which must drop every REPO-SELECTION var (this incident's own
// GIT_DIR included) while leaving transport/credential/config-injection vars alone.
test('plan 3503 round 3: gatePrepChildEnv drops every repo-selector var but leaves transport/credential/config vars alone', () => {
  withEnv(
    {
      // every member of the repo-selection drop list (GIT_REPO_SELECTOR_VARS) — none may survive
      GIT_DIR: 'C:/ambient/wrong-repo/.git',
      GIT_WORK_TREE: 'C:/ambient/wrong-repo',
      GIT_INDEX_FILE: 'C:/ambient/wrong-repo/.git/index',
      GIT_COMMON_DIR: 'C:/ambient/wrong-repo/.git',
      GIT_OBJECT_DIRECTORY: 'C:/ambient/wrong-repo/.git/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: 'C:/ambient/other/.git/objects',
      GIT_NAMESPACE: 'ambient-ns',
      GIT_CEILING_DIRECTORIES: 'C:/ambient',
      GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
      GIT_PREFIX: 'ambient/prefix/',
      // this is the round-3 regression: these must SURVIVE — dropping them broke the fetch
      GIT_SSH_COMMAND: 'ssh -i /ambient/key',
      GIT_ASKPASS: '/ambient/askpass.sh',
      GIT_HTTP_PROXY: 'http://ambient-proxy:8080',
      GIT_HTTPS_PROXY: 'http://ambient-proxy:8443',
      GIT_CONFIG_GLOBAL: 'C:/ambient/gitconfig',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.proxy',
      GIT_CONFIG_VALUE_0: 'http://ambient-proxy:8080',
    },
    () => {
      const env = gatePrepChildEnv();
      // exhaustively pin the drop list against its own named constant, not a hand-copied list
      for (const name of GIT_REPO_SELECTOR_VARS) {
        assert.equal(env[name], undefined, `${name} must not survive gatePrepChildEnv()`);
      }
      // the regression: transport/credential/config-injection vars must survive
      assert.equal(env.GIT_SSH_COMMAND, 'ssh -i /ambient/key');
      assert.equal(env.GIT_ASKPASS, '/ambient/askpass.sh');
      assert.equal(env.GIT_HTTP_PROXY, 'http://ambient-proxy:8080');
      assert.equal(env.GIT_HTTPS_PROXY, 'http://ambient-proxy:8443');
      assert.equal(env.GIT_CONFIG_GLOBAL, 'C:/ambient/gitconfig');
      assert.equal(env.GIT_CONFIG_COUNT, '1');
      assert.equal(env.GIT_CONFIG_KEY_0, 'http.proxy');
      assert.equal(env.GIT_CONFIG_VALUE_0, 'http://ambient-proxy:8080');
      // plan 3832: this used to also assert an ordinary process hatch (ALLOW_LANDED_REVERSION)
      // was scrubbed via CHILD_ENV_STRIP's always-applied base list. That list is now `[]` (see
      // child-env.mjs) — it was retired with the landed-reversion halt it existed to guard — so
      // gatePrepChildEnv() no longer drops anything outside GIT_REPO_SELECTOR_VARS, which is
      // exactly what this test otherwise pins.
      // the caller's explicit GIT_NONINTERACTIVE_ENV settings still apply after the strip
      assert.equal(env.GIT_TERMINAL_PROMPT, '0');
      assert.equal(env.GCM_INTERACTIVE, 'never');
    },
  );
});

// plan 3503 round 3: the two primitives directly, independent of gatePrepChildEnv's own settings
// layer — pins gitRepoIsolatedEnv()'s bare (no-settings) shape and confirms gitIsolatedEnv()'s
// EXISTING behaviour (its own callers, lock-path.mjs and pass-cache-kernel.mjs, are out of this
// plan's scope) is unchanged: it must still strip the whole GIT_* namespace, transport vars
// included, so a future edit cannot quietly widen or narrow either helper without this failing.
test('plan 3503 round 3: gitRepoIsolatedEnv vs gitIsolatedEnv — repo-selection-only vs whole-namespace strip', () => {
  withEnv(
    {
      GIT_DIR: 'C:/ambient/wrong-repo/.git',
      GIT_SSH_COMMAND: 'ssh -i /ambient/key',
      GIT_HTTP_PROXY: 'http://ambient-proxy:8080',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.proxy',
      GIT_CONFIG_VALUE_0: 'http://ambient-proxy:8080',
    },
    () => {
      const repoIsolated = gitRepoIsolatedEnv();
      assert.equal(repoIsolated.GIT_DIR, undefined);
      assert.equal(repoIsolated.GIT_SSH_COMMAND, 'ssh -i /ambient/key');
      assert.equal(repoIsolated.GIT_HTTP_PROXY, 'http://ambient-proxy:8080');
      assert.equal(repoIsolated.GIT_CONFIG_COUNT, '1');
      assert.equal(repoIsolated.GIT_CONFIG_KEY_0, 'http.proxy');

      // gitIsolatedEnv's pre-existing behaviour: unchanged, whole GIT_* namespace dropped
      const fullyIsolated = gitIsolatedEnv();
      assert.equal(fullyIsolated.GIT_DIR, undefined);
      assert.equal(fullyIsolated.GIT_SSH_COMMAND, undefined);
      assert.equal(fullyIsolated.GIT_HTTP_PROXY, undefined);
      assert.equal(fullyIsolated.GIT_CONFIG_COUNT, undefined);
      assert.equal(fullyIsolated.GIT_CONFIG_KEY_0, undefined);
    },
  );
});

test('plan 3503: gate-prep spawn stays after the landed-range guard and before the first finder', () => {
  const source = readFileSync(fileURLToPath(new URL('./gpt-review.mjs', import.meta.url)), 'utf8');
  const landedGuard = source.indexOf('// ─── Landed-range guard (plan 3213)');
  const spawn = source.indexOf('spawnReviewGatePrep(repoRoot, args);');
  const firstFinder = source.indexOf('const claudeArmPromise = args.claudeArm');

  assert.ok(landedGuard >= 0, 'landed-range guard marker must remain present');
  assert.ok(spawn > landedGuard, 'gate prep must not spawn before the landed-range refusal');
  assert.ok(firstFinder > spawn, 'gate prep must spawn before the first finder launches');
});

// plan 3369, task 3: --paths / --exclude-paths — comma-split, trimmed, empty entries dropped.
test('parseArgs: --paths/--exclude-paths split on comma, trim whitespace, drop empties', () => {
  assert.deepEqual(parseArgs(['--paths', 'a/**, b/**,c.ts']).paths, ['a/**', 'b/**', 'c.ts']);
  assert.deepEqual(parseArgs(['--exclude-paths', 'x/**,, y/**']).excludePaths, ['x/**', 'y/**']);
  assert.deepEqual(parseArgs([]).paths, []);
  assert.deepEqual(parseArgs([]).excludePaths, []);
});

test('parseArgs: a typo\u2019d, valueless, or stray argument THROWS — never a silent default', () => {
  assert.throws(() => parseArgs(['--rep', 'C:/x']), /unknown flag --rep/);
  assert.throws(() => parseArgs(['--repo']), /--repo is missing its value/);
  assert.throws(() => parseArgs(['--repo', '']), /--repo is missing its value/);
  assert.throws(() => parseArgs(['--out']), /--out is missing its value/);
  assert.throws(() => parseArgs(['--range']), /--range is missing its value/);
  assert.throws(() => parseArgs(['stray']), /unexpected argument "stray"/);
  // `--repo --out C:/o` names no repo: the shared parser takes `--out` as --repo's value
  // (its pinned "a value flag consumes the next token" contract), which strands C:/o as a
  // positional — a different message, the same refusal, which is the property that matters.
  assert.throws(() => parseArgs(['--repo', '--out', 'C:/o']), /unexpected argument "C:\/o"/);
});

test('gpt-review (integration): a valueless --repo exits 2 rather than reviewing the cwd', () => {
  const dir = emptyRangeRepo();
  const res = spawnSync(
    process.execPath,
    [GPT_REVIEW_PATH, '--out', joinPath(dir, 'out'), '--repo'],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  );
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--repo is missing its value/);
  rmSync(dir, { recursive: true, force: true });
});

test('gpt-review (integration): an unrecognised flag exits 2 and names it, rather than reviewing the wrong repo', () => {
  const dir = emptyRangeRepo();
  const res = spawnSync(
    process.execPath,
    [GPT_REVIEW_PATH, '--rep', dir, '--out', joinPath(dir, 'out')],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown flag --rep/);
  assert.match(res.stderr, /Known flags:/, 'the refusal lists what IS accepted');
  rmSync(dir, { recursive: true, force: true });
});

test('gpt-review (integration): a --repo that is not a git checkout exits 2 and names the flag', () => {
  const notARepo = mkdtempSync(joinPath(tmpdir(), 'gptrev-notrepo-'));
  const res = spawnSync(
    process.execPath,
    [GPT_REVIEW_PATH, '--repo', notARepo, '--out', joinPath(notARepo, 'out')],
    { cwd: notARepo, encoding: 'utf8' },
  );
  assert.equal(res.status, 2, 'a bad --repo is an operational failure (2), not an empty range');
  assert.match(res.stderr, /--repo/);
  rmSync(notARepo, { recursive: true, force: true });
});

test('gpt-review (integration): the initial --repo probe scrubs ambient repository selectors', () => {
  const ambientRepo = emptyRangeRepo();
  const notARepo = mkdtempSync(joinPath(tmpdir(), 'gptrev-badrepo-ambient-'));
  const res = spawnSync(
    process.execPath,
    [GPT_REVIEW_PATH, '--repo', notARepo, '--out', joinPath(notARepo, 'out')],
    {
      cwd: notARepo,
      encoding: 'utf8',
      env: {
        ...process.env,
        // Finding 43a9cb: without the scrub, Git ignores --repo and accepts ambientRepo.
        GIT_DIR: joinPath(ambientRepo, '.git'),
        GIT_WORK_TREE: ambientRepo,
      },
    },
  );
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--repo .* is not a git checkout/);
  rmSync(ambientRepo, { recursive: true, force: true });
  rmSync(notARepo, { recursive: true, force: true });
});

test('gpt-review (integration): an explicit empty --range fails the same way', () => {
  const dir = emptyRangeRepo();
  const outDir = joinPath(dir, 'out');
  const res = spawnSync(
    process.execPath,
    [GPT_REVIEW_PATH, '--no-detach', '--range', 'HEAD...HEAD', '--out', outDir],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(res.status, EXIT_EMPTY_RANGE);
  assert.match(res.stderr, /--range\/--end-ref/);
  rmSync(dir, { recursive: true, force: true });
});

// The ONE legitimate empty case survives: every changed file is an excluded data artifact,
// which is a real PASS and must keep its exit 0 + full pass-shaped output.
test('gpt-review (integration): an artifacts-only range still PASSES with a full stats.json', () => {
  const dir = emptyRangeRepo();
  const outDir = joinPath(dir, 'out');
  const g = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  // `input/` is one of REVIEW_DIFF_EXCLUDES (review-diff-scope.mjs) — raw asset input, a
  // data artifact with no reviewable source. Deliberately NOT a seed path: a quoted
  // backend/src/data/seed/… string in a scripts/ file is what assert-seed-io-seam reads as
  // a direct seed open, and it blocks the push.
  mkdirSync(joinPath(dir, 'input/raw'), { recursive: true });
  writeFileSync(joinPath(dir, 'input/raw/fixture.txt'), 'raw asset\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'data artifact']);
  const res = spawnSync(process.execPath, [GPT_REVIEW_PATH, '--no-detach', '--out', outDir], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `artifacts-only must stay a PASS; stderr: ${res.stderr}`);
  assert.ok(existsSync(joinPath(outDir, 'stats.json')), 'the PASS path still writes stats.json');
  assert.ok(existsSync(joinPath(outDir, 'findings.json')));
  assert.match(
    readFileSync(joinPath(outDir, 'summary.md'), 'utf8'),
    /excluded data artifacts/,
    'the PASS must say WHY it is empty, not "no changes"',
  );
  rmSync(dir, { recursive: true, force: true });
});

// ─── Landed-range guard (plan 3213) ────────────────────────────────────────
// The sibling misfire to the empty-range one above: a --range built from a sha read BEFORE a
// push-time rebase silently widens after the rebase rewrites that sha, because the OLD sha
// still resolves — as a real ancestor now sitting on origin/master (the rebase advanced the
// branch's actual merge-base). One real run reviewed 84 files of a stranger's just-landed work
// this way, cost $1.30 and 4.6M tokens, and said nothing was wrong. These cover the hard
// failure, the diagnosis, and the two paths that must NOT refuse.

// Scoped to `master`, NOT a bare `git fetch origin`: origin/master is the only ref the
// containment test reads, and this repo's origin carries every parallel session's in-flight
// worktree branches and coordination refs — which a bare fetch would drag down on EVERY
// review call.
test('fetchOriginForLandedGuard: a clean fetch reports ok, fetching ONLY origin master', () => {
  const calls = [];
  const runGit = (args) => {
    calls.push(args);
    return '';
  };
  assert.deepEqual(fetchOriginForLandedGuard('/repo', runGit), { ok: true });
  assert.deepEqual(calls, [['fetch', '--no-tags', 'origin', 'master']]);
});

// The whole point: offline / no configured remote / a sandboxed test fixture must degrade the
// diagnosis, never crash an otherwise-fine review over a network hiccup.
test('fetchOriginForLandedGuard: a failed fetch (offline / no remote) is non-fatal', () => {
  const runGit = () => {
    throw new Error('unable to access remote');
  };
  const result = fetchOriginForLandedGuard('/repo', runGit);
  assert.equal(result.ok, false);
  assert.match(result.error, /unable to access remote/);
});

// The injected runGit keeps this a pure unit test — no repo, no real git call, so this also
// documents the exact two-call detection recipe from the plan.
test('detectLandedRange: total minus unlanded via two injected `git rev-list --count` calls', () => {
  const calls = [];
  const runGit = (args) => {
    calls.push(args);
    return args.length === 3 ? '5\n' : '2\n'; // 5 total, 2 NOT reachable from origin/master
  };
  assert.deepEqual(detectLandedRange('/repo', 'base..head', runGit), {
    total: 5,
    unlanded: 2,
    landed: 3,
    testRange: 'base..head',
  });
  assert.deepEqual(calls, [
    ['rev-list', '--count', 'base..head'],
    ['rev-list', '--count', 'base..head', '^origin/master'],
  ]);
});

// The shape of the DEFAULT path: the resolved merge-base excludes landed commits by
// construction, so total === unlanded and landed comes out zero — a cheap no-op tripwire.
test('detectLandedRange: landed is zero when the range already excludes everything on origin/master', () => {
  const runGit = () => '3\n'; // same count both times
  assert.deepEqual(detectLandedRange('/repo', 'base..head', runGit), {
    total: 3,
    unlanded: 3,
    landed: 0,
    testRange: 'base..head',
  });
});

// ─── Triple-dot normalization (the guard's own first regression) ────────────
// `...` means two DIFFERENT things to the two git commands this guard straddles: `git diff
// A...B` is merge-base-based (B's own commits), while `git rev-list A...B` is the SYMMETRIC
// DIFFERENCE and additionally counts everything A has that B does not. The documented standard
// invocation is a triple-dot range (`--range "origin/master...HEAD"`), so an un-normalized
// guard charged the caller for every commit another session had landed since the branch point
// — refusing essentially every ordinary review in a repo with 5-7 sessions landing constantly.
test('containmentRange: a triple-dot range is normalized to merge-base..right (git diff semantics)', () => {
  const calls = [];
  const runGit = (args) => {
    calls.push(args);
    return 'mb123\n';
  };
  assert.equal(containmentRange('origin/master...HEAD', runGit), 'mb123..HEAD');
  assert.deepEqual(calls, [['merge-base', 'origin/master', 'HEAD']]);
});

test('containmentRange: a double-dot range passes through untouched, resolving nothing', () => {
  const calls = [];
  const runGit = (args) => {
    calls.push(args);
    return 'unused\n';
  };
  assert.equal(containmentRange('stale123..head456', runGit), 'stale123..head456');
  assert.deepEqual(calls, []); // the plan-3213 misfire shape must stay detectable as-is
});

// null means "undeterminable", which main() turns into an exit-2 failure — never a silent pass.
test('containmentRange: an unresolvable merge base returns null rather than guessing a range', () => {
  const runGit = () => {
    throw new Error('fatal: Not a valid object name');
  };
  assert.equal(containmentRange('origin/master...HEAD', runGit), null);
});

test('detectLandedRange: a triple-dot range counts the NORMALIZED range, not the symmetric difference', () => {
  const calls = [];
  const runGit = (args) => {
    calls.push(args);
    if (args[0] === 'merge-base') return 'mb123\n';
    // DIFFERENT counts per call, so this can only pass if the subtraction really reads both:
    // 3 commits in the normalized range, 2 of them not yet on origin/master.
    return args.includes('^origin/master') ? '2\n' : '3\n';
  };
  assert.deepEqual(detectLandedRange('/repo', 'origin/master...HEAD', runGit), {
    total: 3,
    unlanded: 2,
    landed: 1,
    testRange: 'mb123..HEAD',
  });
  assert.deepEqual(calls, [
    ['merge-base', 'origin/master', 'HEAD'],
    ['rev-list', '--count', 'mb123..HEAD'],
    ['rev-list', '--count', 'mb123..HEAD', '^origin/master'],
  ]);
});

// null means "could not determine", and main() turns that into a hard exit-2 rather than a
// silent pass — a containment test that never ran must not be recordable as a clean review.
test('detectLandedRange: returns null when the range cannot be normalized', () => {
  const runGit = (args) => {
    if (args[0] === 'merge-base') throw new Error('no merge base');
    throw new Error('should never be reached');
  };
  assert.equal(detectLandedRange('/repo', 'origin/master...HEAD', runGit), null);
});

test('landedRangeRecoveryCommand: names the SAME repo via --repo, strips --range/--out/--repo, preserves other flags', () => {
  const cmd = landedRangeRecoveryCommand(
    'C:/repo',
    [
      '--range',
      'a..b',
      '--concurrency',
      '8',
      '--out',
      '.scratch/old',
      '--repo',
      'C:/wrong',
      '--no-claude-arm',
    ],
    'C:/main/scripts/gpt-review.mjs',
  );
  assert.equal(
    cmd,
    "node 'C:/main/scripts/gpt-review.mjs' --repo 'C:/repo' '--concurrency' '8' '--no-claude-arm'",
  );
});

test('landedRangeRecoveryCommand: drops the --range=/--out=/--repo= equals form too', () => {
  const cmd = landedRangeRecoveryCommand('C:/repo', [
    '--range=a..b',
    '--out=.scratch/old',
    '--repo=C:/wrong',
    '--concurrency=8',
  ]);
  assert.doesNotMatch(cmd, /a\.\.b/);
  assert.doesNotMatch(cmd, /\.scratch\/old/);
  assert.doesNotMatch(cmd, /C:\/wrong/);
  assert.match(cmd, /'--concurrency=8'/, 'other equals-form flags survive');
  assert.equal((cmd.match(/--repo/g) || []).length, 1, 'exactly one --repo, the new one');
});

test('landedRangeRecoveryCommand: never emits a cd — same reasoning as recoveryCommand', () => {
  const cmd = landedRangeRecoveryCommand('C:/repo', []);
  assert.doesNotMatch(cmd, /(^|\s)cd\s/);
  assert.doesNotMatch(cmd, /&&/);
  assert.match(cmd, /^node /);
});

test('formatLandedRangeError: names the landed/unlanded split, says NOT a PASS, explains the rebase mechanism, and prints the recovery command', () => {
  const msg = formatLandedRangeError({
    repoRoot: 'C:/repo',
    rangeLabel: 'abc..def',
    headLabel: 'feature',
    landedCount: 3,
    unlandedCount: 1,
    argv: ['--range', 'abc..def'],
    selfPath: 'C:/main/scripts/gpt-review.mjs',
  });
  assert.match(msg, /RANGE COVERS ALREADY-LANDED/);
  assert.match(msg, /3 commit\(s\) in this range are already in origin\/master; 1 are not/);
  assert.match(msg, /NOT a PASS/);
  assert.match(msg, /no stats\.json/);
  assert.match(msg, /rebase/i);
  assert.match(msg, /--end-ref/);
  assert.match(msg, /^\s*node 'C:\/main\/scripts\/gpt-review\.mjs' --repo 'C:\/repo'\s*$/m);
  // the stale --range must NOT be replayed in the recovery line — that is the thing that misfired
  assert.doesNotMatch(msg, /'--range' 'abc\.\.def'/);
});

// A repo reproducing the plan-3213 misfire end to end: a base commit, a branch off it, a
// STRANGER session landing a commit on origin/master in the meantime, then a rebase of the
// branch onto the advanced origin/master — which rewrites the branch's own commit sha and
// leaves the OLD merge-base sha (staleBase) resolvable as a real ancestor of the now-advanced
// origin/master. A --range built from staleBase..(post-rebase HEAD) is exactly the range a
// session would have hand-copied before the rebase, and it silently spans the stranger's
// landed commit too.
// The shared prefix of both landed-range fixtures: a base commit that origin/master points at,
// a feature branch with one commit of its own, and then a STRANGER landing a commit on master
// and advancing origin/master past the branch point. Where the two fixtures diverge is what
// happens next — see their own comments.
function divergedFixtureBase(prefix) {
  const dir = mkdtempSync(joinPath(tmpdir(), prefix));
  const g = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  g(['init', '-q', '-b', 'master']);
  g(['config', 'user.email', 'f@x']);
  g(['config', 'user.name', 'f']);
  writeFileSync(joinPath(dir, 'README.md'), 'fixture\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  const staleBase = g(['rev-parse', 'HEAD']).trim();
  g(['update-ref', 'refs/remotes/origin/master', 'HEAD']);

  g(['checkout', '-qb', 'feature']);
  writeFileSync(joinPath(dir, 'feature.txt'), 'my own change\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'my own change']);

  // Another session lands work on master in the meantime.
  g(['checkout', '-q', 'master']);
  writeFileSync(joinPath(dir, 'stranger.txt'), 'landed by someone else\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'stranger landed work']);
  g(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
  g(['checkout', '-q', 'feature']);
  return { dir, g, staleBase };
}

function landedRangeRepo() {
  const { dir, g, staleBase } = divergedFixtureBase('gptrev-landed-');
  // Rebase the feature branch onto the advanced master — REWRITES the feature commit's sha,
  // leaving staleBase resolvable only as an ancestor of the now-advanced origin/master.
  g(['rebase', '-q', 'master']);
  const headSha = g(['rev-parse', 'HEAD']).trim();
  return { dir, staleBase, headSha };
}

// The ORDINARY shape of this repo, and the guard's own first regression: a branch off master,
// and origin/master advancing underneath it while the branch is NOT rebased. With 5-7 parallel
// sessions landing constantly this is the normal case, not an edge — and it is precisely what
// an un-normalized rev-list containment test mis-reads, because `git rev-list A...B` is the
// symmetric difference (it counts master's own new commit) while `git diff A...B` — what is
// actually reviewed — is merge-base-based and does not.
function divergedRepo() {
  // No rebase: the branch is left diverged from the advanced origin/master, which is the
  // ordinary steady state of this repo and the shape the un-normalized guard mis-read.
  const { dir } = divergedFixtureBase('gptrev-diverged-');
  return { dir };
}

// Never a real codex install/network call: this repo carries no CODEX_LOGIN_B64, so
// ensureCodexBootstrap() no-ops and a missing `codex` binary fails fast as ENOENT (`spawn:`
// prefixed, exit 2) — the point of these tests is the GUARD, not the finder transport past it.
function envWithoutCodexAuth() {
  const { CODEX_LOGIN_B64, ...rest } = process.env;
  return rest;
}

test('gpt-review (integration): a --range built from a pre-rebase sha refuses with EXIT_LANDED_RANGE, naming landed/unlanded counts, and writes no stats.json', () => {
  const { dir, staleBase, headSha } = landedRangeRepo();
  const outDir = joinPath(dir, 'out');
  const res = spawnSync(
    process.execPath,
    [GPT_REVIEW_PATH, '--no-detach', '--range', `${staleBase}..${headSha}`, '--out', outDir],
    { cwd: dir, encoding: 'utf8', env: envWithoutCodexAuth() },
  );
  assert.equal(
    res.status,
    EXIT_LANDED_RANGE,
    `expected exit ${EXIT_LANDED_RANGE}, got ${res.status}; stderr: ${res.stderr}`,
  );
  assert.match(res.stderr, /RANGE COVERS ALREADY-LANDED/);
  // range = staleBase..headSha = [stranger's landed commit, my own rebased commit]: 1 landed, 1 not
  assert.match(res.stderr, /1 commit\(s\) in this range are already in origin\/master; 1 are not/);
  assert.equal(
    existsSync(joinPath(outDir, 'stats.json')),
    false,
    'stats.json must NOT exist — its absence is what stops a fake PASS being recorded',
  );
  assert.ok(existsSync(joinPath(outDir, 'summary.md')), 'the failure is still written up');
  assert.match(
    readFileSync(joinPath(outDir, 'summary.md'), 'utf8'),
    /FAILED \(range covers landed commits\)/,
  );
  rmSync(dir, { recursive: true, force: true });
});

// Symmetry with the empty-range guard's own stale-artifact test: a reused --out directory must
// not let an earlier clean run's pass-shaped stats.json survive this refusal.
test('gpt-review (integration): a STALE stats.json from an earlier run in the same --out is DELETED on a landed-range refusal', () => {
  const { dir, staleBase, headSha } = landedRangeRepo();
  const outDir = joinPath(dir, 'out');
  mkdirSync(joinPath(outDir, 'raw'), { recursive: true });
  mkdirSync(joinPath(outDir, 'finders'), { recursive: true });
  // Round 3, item A: diff.patch and finders/*.stderr.txt must clear here too — same reused
  // --out, same "mixed-generation directory" hazard as the empty-range guard's own test above.
  const stale = ['stats.json', 'findings.json', 'refuted.json', 'checkpoint.json', 'diff.patch'];
  for (const name of stale) writeFileSync(joinPath(outDir, name), '{"stats":{"finders":11}}\n');
  writeFileSync(joinPath(outDir, 'raw', 'angle-A.json'), '{}\n');
  writeFileSync(joinPath(outDir, 'finders', 'angle-A.stderr.txt'), 'boom\n');
  const res = spawnSync(
    process.execPath,
    [GPT_REVIEW_PATH, '--no-detach', '--range', `${staleBase}..${headSha}`, '--out', outDir],
    { cwd: dir, encoding: 'utf8', env: envWithoutCodexAuth() },
  );
  assert.equal(res.status, EXIT_LANDED_RANGE);
  for (const name of stale) {
    assert.equal(existsSync(joinPath(outDir, name)), false, `${name} must not survive`);
  }
  assert.equal(existsSync(joinPath(outDir, 'raw', 'angle-A.json')), false);
  assert.equal(existsSync(joinPath(outDir, 'finders', 'angle-A.stderr.txt')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('gpt-review (integration): the default range (origin/master...HEAD) is a clean no-op tripwire post-rebase — no refusal', () => {
  const { dir } = landedRangeRepo();
  const outDir = joinPath(dir, 'out');
  const res = spawnSync(process.execPath, [GPT_REVIEW_PATH, '--no-detach', '--out', outDir], {
    cwd: dir,
    encoding: 'utf8',
    env: envWithoutCodexAuth(),
  });
  assert.notEqual(
    res.status,
    EXIT_LANDED_RANGE,
    `the default range must never itself be a landed range; stderr: ${res.stderr}`,
  );
  assert.doesNotMatch(res.stderr, /RANGE COVERS ALREADY-LANDED/);
  rmSync(dir, { recursive: true, force: true });
});

// THE regression this guard nearly shipped: `.claude/commands/gpt-review.md` documents
// `--range "origin/master...HEAD"` as the standard invocation, and origin/master having moved
// since the branch point is the normal state of this repo. An un-normalized rev-list count
// refuses here with "1 commit(s) ... already in origin/master" while the reviewed diff
// (`git diff --name-only origin/master...HEAD`) contains only feature.txt — blocking the
// mandatory pre-land review on essentially every ordinary call.
test('gpt-review (integration): the DOCUMENTED triple-dot --range does NOT refuse when origin/master merely moved ahead', () => {
  const { dir } = divergedRepo();
  const outDir = joinPath(dir, 'out');
  // Sanity-pin the fixture: the reviewed diff is the caller's own file and nothing else.
  const reviewed = execFileSync('git', ['-C', dir, 'diff', '--name-only', 'origin/master...HEAD'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(reviewed, 'feature.txt');
  const res = spawnSync(
    process.execPath,
    [GPT_REVIEW_PATH, '--no-detach', '--range', 'origin/master...HEAD', '--out', outDir],
    { cwd: dir, encoding: 'utf8', env: envWithoutCodexAuth() },
  );
  assert.notEqual(
    res.status,
    EXIT_LANDED_RANGE,
    `the documented standard invocation must never be refused; stderr: ${res.stderr}`,
  );
  assert.doesNotMatch(res.stderr, /RANGE COVERS ALREADY-LANDED/);
  rmSync(dir, { recursive: true, force: true });
});

test('gpt-review (integration): --end-ref marks a landed range as a deliberate historical replay — no refusal', () => {
  const { dir, staleBase, headSha } = landedRangeRepo();
  const outDir = joinPath(dir, 'out');
  const res = spawnSync(
    process.execPath,
    [
      GPT_REVIEW_PATH,
      '--no-detach',
      '--range',
      `${staleBase}..${headSha}`,
      '--end-ref',
      headSha,
      '--out',
      outDir,
    ],
    { cwd: dir, encoding: 'utf8', env: envWithoutCodexAuth() },
  );
  assert.notEqual(
    res.status,
    EXIT_LANDED_RANGE,
    `--end-ref is the recognized opt-out; stderr: ${res.stderr}`,
  );
  assert.doesNotMatch(res.stderr, /RANGE COVERS ALREADY-LANDED/);
  rmSync(dir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// plan 3369 — gpt-review robustness: finder stderr, bounded backoff retry,
// path scope, torn-checkpoint quarantine. Same testing philosophy as the top
// of this file: no real codex/claude subprocess. Tasks 1+2 use fakes injected
// as `runCodexFn` directly (the plan's own execution note (d) — no codex
// transport, no network); task 3 exercises the real git pathspec assembly
// against a real temp repo (same pattern as detectLandedRange/
// fetchOriginForLandedGuard above); task 4 is the Checkpoint class, fully
// self-contained (a JSON file on disk, no subprocess at all).
// ═══════════════════════════════════════════════════════════════════════════

// ─── Task 1 — finder stderr persistence ─────────────────────────────────────

test('persistFinderStderr: writes <out>/finders/<angle>.stderr.txt, creating the directory', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-stderr-'));
  const file = persistFinderStderr(outDir, 'angle-A', 'boom\nline2\n');
  assert.equal(file, joinPath(outDir, FINDER_STDERR_DIRNAME, 'angle-A.stderr.txt'));
  assert.equal(readFileSync(file, 'utf8'), 'boom\nline2\n');
  rmSync(outDir, { recursive: true, force: true });
});

test('persistFinderStderr: empty/missing text still writes a placeholder rather than an empty file nobody can distinguish from "not yet written"', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-stderr-'));
  const file = persistFinderStderr(outDir, 'angle-B', '');
  assert.match(readFileSync(file, 'utf8'), /no stderr captured/);
  rmSync(outDir, { recursive: true, force: true });
});

test('matchesForceFail: "all" forces every angle; a comma-list forces only its members; unset forces nothing', () => {
  const prev = process.env.GPT_REVIEW_FORCE_FINDER_FAIL;
  try {
    delete process.env.GPT_REVIEW_FORCE_FINDER_FAIL;
    assert.equal(matchesForceFail('angle-A'), false);
    process.env.GPT_REVIEW_FORCE_FINDER_FAIL = 'all';
    assert.equal(matchesForceFail('angle-A'), true);
    assert.equal(matchesForceFail('reuse'), true);
    process.env.GPT_REVIEW_FORCE_FINDER_FAIL = 'angle-A, reuse';
    assert.equal(matchesForceFail('angle-A'), true);
    assert.equal(matchesForceFail('reuse'), true);
    assert.equal(matchesForceFail('angle-B'), false);
  } finally {
    if (prev === undefined) delete process.env.GPT_REVIEW_FORCE_FINDER_FAIL;
    else process.env.GPT_REVIEW_FORCE_FINDER_FAIL = prev;
  }
});

test('callFinderAngle: a failing call persists the captured stderr and logs its first lines, without spawning real codex', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-stderr-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  const f = { label: 'angle-A', text: 'x', kind: 'correctness' };
  const runCodexFn = async () => ({
    error: 'exit 1 (rc=1)',
    stderr: 'boom line 1\nboom line 2\n',
    wallS: 1,
  });
  const logs = [];
  const origLog = console.log;
  console.log = (m) => logs.push(m);
  let r;
  try {
    r = await callFinderAngle({
      ckpt,
      outDir,
      repoRoot: outDir,
      codexBin: 'codex',
      scopeBlock: 'SCOPE',
      files: [],
      f,
      runCodexFn,
    });
  } finally {
    console.log = origLog;
  }
  assert.equal(r.error, 'exit 1 (rc=1)');
  assert.deepEqual(r.candidates, []);
  const stderrFile = joinPath(outDir, FINDER_STDERR_DIRNAME, 'angle-A.stderr.txt');
  assert.equal(readFileSync(stderrFile, 'utf8'), 'boom line 1\nboom line 2\n');
  assert.ok(
    logs.some((m) => m.includes('boom line 1')),
    'the first lines are logged inline',
  );
  rmSync(outDir, { recursive: true, force: true });
});

test('callFinderAngle: a non-array candidates payload is a recorded failure, not an empty clean angle', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-candidate-type-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  const r = await callFinderAngle({
    ckpt,
    outDir,
    repoRoot: outDir,
    codexBin: 'codex',
    scopeBlock: 'SCOPE',
    files: [],
    f: { label: 'angle-A', text: 'x', kind: 'correctness' },
    runCodexFn: async () => ({
      data: { candidates: { summary: 'wrong container type' } },
      tokens: 1,
      wallS: 1,
    }),
  });

  assert.match(r.error, /candidates.*array.*object/i);
  assert.deepEqual(r.candidates, []);
  rmSync(outDir, { recursive: true, force: true });
});

test('verifyGroups: a non-array verdicts payload escalates the whole group', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-verdict-type-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  const scopeBlock = 'SCOPE';
  const candidate = {
    file: 'a.ts',
    line: 10,
    summary: 'claim',
    failure_scenario: 'failure',
  };
  const prompt = groupVerifierPrompt(scopeBlock, [candidate]);
  const tagFor = (prefix, model) =>
    callTag(
      `${prefix}:${locKey(candidate)}`,
      promptCallDigest({ prompt, schema: GROUP_VERDICT_SCHEMA, model }),
    );
  ckpt.set(tagFor('verify', MODEL_LUNA), {
    data: { verdicts: { 0: { verdict: 'CONFIRMED', evidence: 'wrong container type' } } },
  });
  ckpt.set(tagFor('adjudicate', MODEL_SOL), {
    data: { verdicts: [{ index: 0, verdict: 'CONFIRMED', evidence: 'Sol checked it' }] },
  });

  const result = await verifyGroups(
    ckpt,
    outDir,
    outDir,
    'codex',
    scopeBlock,
    [candidate],
    { verify: { total: 0 }, adjudicate: { total: 0 } },
    1,
  );

  assert.equal(result.stats.escalated, 1);
  assert.equal(result.kept[0].verdict, 'CONFIRMED');
  assert.equal(result.kept[0].evidence, 'Sol checked it');
  rmSync(outDir, { recursive: true, force: true });
});

// plan 3623 item 1 fix-A: the checkpoint tag's digest must be keyed on the schema the caller
// actually wrote to schema-verdict.json (passed via the `schema` option), not a hardcoded
// GROUP_VERDICT_SCHEMA import — otherwise copy-review's own COPY_GROUP_VERDICT_SCHEMA could
// change with no effect on its checkpoint tags, and a stale cached verdict would be replayed
// against a changed contract. Proven at the digest/checkpoint level (verifyOnce is not
// exported): seed the checkpoint ONLY under the tag an alternate schema produces, pass that
// same schema through verifyGroups, and confirm it is the entry actually served back.
test('verifyGroups: the verify checkpoint tag tracks the `schema` option, not a hardcoded import', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-verify-schema-seam-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  const scopeBlock = 'SCOPE';
  const candidate = { file: 'a.ts', line: 10, summary: 'claim', failure_scenario: 'failure' };
  const altSchema = { ...GROUP_VERDICT_SCHEMA, description: 'a distinct schema object' };
  const prompt = groupVerifierPrompt(scopeBlock, [candidate]);

  const defaultTag = callTag(
    `verify:${locKey(candidate)}`,
    promptCallDigest({ prompt, schema: GROUP_VERDICT_SCHEMA, model: MODEL_LUNA }),
  );
  const altTag = callTag(
    `verify:${locKey(candidate)}`,
    promptCallDigest({ prompt, schema: altSchema, model: MODEL_LUNA }),
  );
  assert.notEqual(
    defaultTag,
    altTag,
    'fixture sanity: two distinct schema objects must produce two distinct digests',
  );

  // Seeded ONLY under the alt-schema tag. If verifyOnce still hashed the hardcoded
  // GROUP_VERDICT_SCHEMA regardless of the `schema` option, it would look up `defaultTag`
  // instead, miss this cache entry, and fall through to a real (uncached) codex call.
  ckpt.set(altTag, {
    data: { verdicts: [{ index: 0, verdict: 'CONFIRMED', evidence: 'seeded' }] },
  });

  const result = await verifyGroups(
    ckpt,
    outDir,
    outDir,
    'codex',
    scopeBlock,
    [candidate],
    { verify: { total: 0 }, adjudicate: { total: 0 } },
    1,
    { schema: altSchema },
  );

  assert.equal(result.kept.length, 1);
  assert.equal(
    result.kept[0].evidence,
    'seeded',
    'verifyGroups must have looked up the alt-schema tag — proof the digest tracked the `schema` option',
  );
  rmSync(outDir, { recursive: true, force: true });
});

// plan 3623 finding 7f43f4: verifyGroups is the ONE seam that owns schema-verdict.json — it must
// write the file from the SAME `schema` value it digests, before any codex call, so the digest
// (proven above) and what codex is actually shown can never disagree. A caller (e.g. copy-review)
// must not also hand-roll its own write of this path.
test('verifyGroups: writes its `schema` option to schema-verdict.json, not a hardcoded import', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-verify-schema-write-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  const scopeBlock = 'SCOPE';
  const candidate = { file: 'a.ts', line: 10, summary: 'claim', failure_scenario: 'failure' };
  const altSchema = { ...GROUP_VERDICT_SCHEMA, description: 'a distinct schema object' };
  const prompt = groupVerifierPrompt(scopeBlock, [candidate]);
  const altTag = callTag(
    `verify:${locKey(candidate)}`,
    promptCallDigest({ prompt, schema: altSchema, model: MODEL_LUNA }),
  );
  ckpt.set(altTag, {
    data: { verdicts: [{ index: 0, verdict: 'CONFIRMED', evidence: 'seeded' }] },
  });

  await verifyGroups(
    ckpt,
    outDir,
    outDir,
    'codex',
    scopeBlock,
    [candidate],
    { verify: { total: 0 }, adjudicate: { total: 0 } },
    1,
    { schema: altSchema },
  );

  assert.deepEqual(
    JSON.parse(readFileSync(joinPath(outDir, 'schema-verdict.json'), 'utf8')),
    altSchema,
    'schema-verdict.json must hold exactly the `schema` option verifyGroups was passed',
  );
  rmSync(outDir, { recursive: true, force: true });
});

// plan 3508 round-2 re-review, 14 findings on one seam: the payload guard originally ran AFTER
// callCached, so a malformed answer was checkpointed as a SUCCESS and replayed by every retry and
// every documented same-`--out` resume — one transient wrong-shape response wedged the output
// directory permanently. What matters is therefore not that the call reports an error, but that
// the CHECKPOINT refuses to serve the entry back.
test('callFinderAngle: a malformed candidates payload is checkpointed as RETRYABLE, not as a success', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-retryable-cand-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  const f = { label: 'angle-A', text: 'x', kind: 'correctness' };
  let codexCalls = 0;
  const call = () =>
    callFinderAngle({
      ckpt,
      outDir,
      repoRoot: outDir,
      codexBin: 'codex',
      scopeBlock: 'SCOPE',
      files: [],
      f,
      runCodexFn: async () => {
        codexCalls += 1;
        // Second attempt recovers, exactly as a transient model-format failure would.
        return codexCalls === 1
          ? { data: { candidates: { summary: 'wrong container' } }, tokens: 1, wallS: 1 }
          : { data: { candidates: [] }, tokens: 1, wallS: 1 };
      },
    });

  const first = await call();
  assert.match(first.error, /candidates.*array.*object/i);
  const second = await call();
  assert.ok(!second.error, 'the retry must succeed, not replay the cached malformed payload');
  assert.deepEqual(second.candidates, []);
  // The decisive count: a payload cached as a success would have left this at 1.
  assert.equal(codexCalls, 2, 'the retry must re-call the model, not replay the cache');
  rmSync(outDir, { recursive: true, force: true });
});

test('verifyGroups: a malformed verdicts payload is checkpointed as RETRYABLE, not as a success', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-retryable-verdict-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  const candidate = { file: 'a.ts', line: 10, summary: 'claim', failure_scenario: 'failure' };
  const prompt = groupVerifierPrompt('SCOPE', [candidate]);
  const tag = callTag(
    `verify:${locKey(candidate)}`,
    promptCallDigest({ prompt, schema: GROUP_VERDICT_SCHEMA, model: MODEL_LUNA }),
  );
  ckpt.set(
    tag,
    requireArrayPayload({ data: { verdicts: { 0: { verdict: 'CONFIRMED' } } } }, 'verdicts'),
  );
  assert.equal(ckpt.get(tag), null, 'a malformed verdicts entry must not be served back');
  rmSync(outDir, { recursive: true, force: true });
});

test('requireArrayPayload: marks a wrong-shape payload as an error and passes a good one through untouched', () => {
  const good = { data: { candidates: [] }, tokens: 3 };
  assert.equal(requireArrayPayload(good, 'candidates'), good);
  const passthrough = { error: 'transport died' };
  assert.equal(requireArrayPayload(passthrough, 'candidates'), passthrough);
  for (const [payload, word] of [
    [{ a: 1 }, 'object'],
    ['s', 'string'],
    [null, 'null'],
    [undefined, 'undefined'],
  ]) {
    assert.match(
      requireArrayPayload({ data: { verdicts: payload } }, 'verdicts').error,
      new RegExp(`verdicts.*array.*${word}`, 'i'),
    );
  }
  // A cached RECORD that is not an object at all: returning it unchanged handed the caller
  // something whose `.data` dereference throws.
  for (const bad of ['corrupt', 42, null, undefined])
    assert.match(requireArrayPayload(bad, 'candidates').error, /unusable cached result/);
});

test('requireArrayPayload: with `elements`, a container of non-records is rejected — [[]] included', () => {
  const arrayOf = (v) => ({ data: { terms: v } });
  // `typeof [] === 'object'`, so a bare typeof check passed `[[]]` and let renderTermsDoc commit
  // a termbase row of `undefined` fields. That is the case this option exists for.
  for (const bad of [[null], [[]], ['s'], [42], [{}, []]])
    assert.match(
      requireArrayPayload(arrayOf(bad), 'terms', { elements: true }).error,
      /every entry must be an object/,
      JSON.stringify(bad),
    );
  const ok = arrayOf([{ se: 'a', target: 'b', reasoning: 'c' }]);
  assert.equal(requireArrayPayload(ok, 'terms', { elements: true }), ok);
  // Opt-out leaves the container-only contract intact.
  assert.equal(requireArrayPayload(arrayOf([null]), 'terms', { elements: false }).error, undefined);
});

test('callCachedArray: a malformed CACHED success is rewritten as retryable, not merely reported', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-legacy-ckpt-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  // Exactly what a checkpoint written by an earlier version of this file holds: a success-shaped
  // entry with no `.error` and a wrong-shape payload. Reporting an in-memory error while leaving
  // it on disk would make every later run recompute the same error and never call the model.
  ckpt.set('finder:legacy', { data: { candidates: { wrong: 'container' } }, tokens: 1 });
  assert.ok(ckpt.get('finder:legacy'), 'precondition: the malformed entry IS served today');

  let calls = 0;
  const first = await callCachedArray(ckpt, 'finder:legacy', 'candidates', async () => {
    calls += 1;
    return { data: { candidates: [] }, tokens: 1 };
  });
  assert.match(first.error, /candidates.*array.*object/i);
  assert.equal(calls, 0, 'the cache hit is what was validated');
  assert.equal(ckpt.get('finder:legacy'), null, 'the bad entry must now be unservable');

  const second = await callCachedArray(ckpt, 'finder:legacy', 'candidates', async () => {
    calls += 1;
    return { data: { candidates: [] }, tokens: 1 };
  });
  assert.ok(!second.error);
  assert.equal(calls, 1, 'the next attempt must reach the model');
  rmSync(outDir, { recursive: true, force: true });
});

test('verifyOnce: a duplicate verdict index does not let the LAST verdict overwrite the first', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-verdict-elements-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  const group = [
    { file: 'a.ts', line: 10, summary: 'first', failure_scenario: 'f1' },
    { file: 'a.ts', line: 10, summary: 'second', failure_scenario: 'f2' },
  ];
  const prompt = groupVerifierPrompt('SCOPE', group);
  const tag = callTag(
    `verify:${locKey(group[0])}`,
    promptCallDigest({ prompt, schema: GROUP_VERDICT_SCHEMA, model: MODEL_LUNA }),
  );
  // Every element is a well-formed object here — element SHAPE is rejected one layer up, by
  // requireArrayPayload; this pins the ordering rule among otherwise-valid verdicts, where the
  // duplicate index 0 used to let the LAST verdict arbitrarily settle candidate 0.
  ckpt.set(tag, {
    data: {
      verdicts: [
        { index: 0, verdict: 'CONFIRMED', evidence: 'first wins' },
        { index: 0, verdict: 'REFUTED', evidence: 'duplicate must not overwrite' },
      ],
    },
  });

  const { kept, refuted } = await verifyGroups(
    ckpt,
    outDir,
    outDir,
    'codex',
    'SCOPE',
    group,
    { verify: { total: 0 }, adjudicate: { total: 0 } },
    1,
  );

  const first = kept.find((c) => c.summary === 'first');
  assert.equal(first.verdict, 'CONFIRMED');
  assert.equal(first.evidence, 'first wins');
  // Candidate 1 got no verdict of its own (the duplicate displaced it), so it escalates — the
  // same safe path a missing index already took — rather than being silently settled or dropped.
  assert.ok(
    kept.concat(refuted).some((c) => c.summary === 'second'),
    'the displaced candidate must survive the round, never be dropped',
  );
  rmSync(outDir, { recursive: true, force: true });
});

test('callFinderAngle: GPT_REVIEW_FORCE_FINDER_FAIL forces a failure without ever calling runCodexFn', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-stderr-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  const f = { label: 'angle-A', text: 'x', kind: 'correctness' };
  let called = false;
  const prev = process.env.GPT_REVIEW_FORCE_FINDER_FAIL;
  process.env.GPT_REVIEW_FORCE_FINDER_FAIL = 'angle-A';
  try {
    const r = await callFinderAngle({
      ckpt,
      outDir,
      repoRoot: outDir,
      codexBin: 'codex',
      scopeBlock: 'SCOPE',
      files: [],
      f,
      runCodexFn: async () => {
        called = true;
        return { data: { candidates: [] }, tokens: 1, wallS: 1 };
      },
    });
    assert.match(r.error, /forced failure/);
    assert.equal(called, false, 'the real transport must never be invoked while forced');
    assert.ok(existsSync(joinPath(outDir, FINDER_STDERR_DIRNAME, 'angle-A.stderr.txt')));
  } finally {
    if (prev === undefined) delete process.env.GPT_REVIEW_FORCE_FINDER_FAIL;
    else process.env.GPT_REVIEW_FORCE_FINDER_FAIL = prev;
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ─── Task 2 — bounded backoff retry ─────────────────────────────────────────

// The required case: a persistently-failing angle exhausts every retry round and is named in
// finderErrors — the signal main() turns into the documented non-zero exit — while a
// consistently-succeeding sibling angle is unaffected. sleepFn is injected as a no-op resolver
// so this asserts the FULL MAX_FINDER_RETRIES backoff schedule with zero real elapsed time.
test('runFindersWithRetry: a persistently-failing angle exhausts retries and lands in finderErrors; a healthy sibling is unaffected', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-retry-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  const finders = [
    { label: 'angle-A', text: 'x', kind: 'correctness' },
    { label: 'angle-B', text: 'y', kind: 'correctness' },
  ];
  const callsByLabel = { 'angle-A': 0, 'angle-B': 0 };
  const runCodexFn = async ({ prompt }) => {
    const label = prompt.includes('angle-A') ? 'angle-A' : 'angle-B';
    callsByLabel[label]++;
    if (label === 'angle-A') return { error: 'boom', stderr: 'boom stderr\n', wallS: 0 };
    return { data: { candidates: [] }, tokens: 7, wallS: 1 };
  };
  const sleeps = [];
  const result = await runFindersWithRetry({
    ckpt,
    outDir,
    repoRoot: outDir,
    codexBin: 'codex',
    scopeBlock: 'SCOPE',
    files: [],
    concurrency: DEFAULT_CONCURRENCY,
    runCodexFn,
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
    finders,
  });
  assert.deepEqual(
    sleeps,
    RETRY_BACKOFF_MS,
    'every retry round backs off, in the documented order',
  );
  assert.equal(
    callsByLabel['angle-A'],
    1 + MAX_FINDER_RETRIES,
    'initial attempt + every retry round',
  );
  assert.equal(callsByLabel['angle-B'], 1, 'a healthy angle is never retried');
  assert.equal(result.finderErrors.length, 1);
  assert.match(result.finderErrors[0], /^angle-A: boom$/);
  assert.deepEqual(
    result.angleStatus.find((s) => s.angle === 'angle-A'),
    {
      angle: 'angle-A',
      status: 'retried-failed',
    },
  );
  assert.deepEqual(
    result.angleStatus.find((s) => s.angle === 'angle-B'),
    {
      angle: 'angle-B',
      status: 'ok',
    },
  );
  assert.deepEqual(result.candidates, [], 'the failed angle contributes zero candidates');
  assert.equal(
    readFileSync(joinPath(outDir, FINDER_STDERR_DIRNAME, 'angle-A.stderr.txt'), 'utf8'),
    'boom stderr\n',
  );
  rmSync(outDir, { recursive: true, force: true });
});

test('runFindersWithRetry: a transient failure that clears on the FIRST retry round is "retried-ok", no further rounds run', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-retry-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  const finders = [{ label: 'angle-A', text: 'x', kind: 'correctness' }];
  let attempt = 0;
  const runCodexFn = async () => {
    attempt++;
    if (attempt === 1) return { error: 'contention', stderr: 'busy\n', wallS: 0 };
    return {
      data: { candidates: [{ file: 'a.ts', line: 1, summary: 's', failure_scenario: 'f' }] },
      tokens: 3,
      wallS: 1,
    };
  };
  const sleeps = [];
  const result = await runFindersWithRetry({
    ckpt,
    outDir,
    repoRoot: outDir,
    codexBin: 'codex',
    scopeBlock: 'SCOPE',
    files: ['a.ts'],
    concurrency: DEFAULT_CONCURRENCY,
    runCodexFn,
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
    finders,
  });
  assert.deepEqual(
    sleeps,
    [RETRY_BACKOFF_MS[0]],
    'only ONE backoff round — it recovered immediately',
  );
  assert.equal(attempt, 2);
  assert.equal(result.finderErrors.length, 0);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.angleStatus, [{ angle: 'angle-A', status: 'retried-ok' }]);
  rmSync(outDir, { recursive: true, force: true });
});

test('runFindersWithRetry: a resumed finder-failure run retries only calls that failed', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-resume-failure-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  const finders = [
    { label: 'angle-A', text: 'A', kind: 'correctness' },
    { label: 'angle-B', text: 'B', kind: 'correctness' },
  ];
  let firstA = 0;
  let firstB = 0;
  await runFindersWithRetry({
    ckpt,
    outDir,
    repoRoot: outDir,
    codexBin: 'codex',
    scopeBlock: 'SCOPE',
    files: [],
    concurrency: 2,
    finders,
    sleepFn: async () => {},
    runCodexFn: async ({ prompt }) => {
      if (prompt.includes('A')) {
        firstA++;
        return { data: { candidates: [] }, tokens: 1, wallS: 0 };
      }
      firstB++;
      return { error: 'failed', stderr: 'failed', wallS: 0 };
    },
  });
  let resumedA = 0;
  let resumedB = 0;
  const resumed = await runFindersWithRetry({
    ckpt: new Checkpoint(joinPath(outDir, 'checkpoint.json')),
    outDir,
    repoRoot: outDir,
    codexBin: 'codex',
    scopeBlock: 'SCOPE',
    files: [],
    concurrency: 2,
    finders,
    sleepFn: async () => {},
    runCodexFn: async ({ prompt }) => {
      if (prompt.includes('A')) resumedA++;
      else resumedB++;
      return { data: { candidates: [] }, tokens: 1, wallS: 0 };
    },
  });
  assert.equal(firstA, 1);
  assert.equal(firstB, 1 + MAX_FINDER_RETRIES);
  assert.equal(resumedA, 0);
  assert.equal(resumedB, 1);
  assert.equal(resumed.finderErrors.length, 0);
  rmSync(outDir, { recursive: true, force: true });
});

test('gpt-review: pre-bind codex exit clears foreign artifacts but keeps same-identity artifacts', () => {
  const dir = pathScopeRepo();
  const outDir = joinPath(dir, 'out');
  const run = () =>
    spawnSync(process.execPath, [GPT_REVIEW_PATH, '--no-detach', '--out', outDir], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...envWithoutCodexAuth(), GPT_REVIEW_CODEX_BIN: '/nonexistent' },
    });
  try {
    assert.equal(run().status, 2);
    for (const name of ['stats.json', 'findings.json', 'summary.md'])
      writeFileSync(joinPath(outDir, name), 'same');
    assert.equal(run().status, 2);
    for (const name of ['stats.json', 'findings.json', 'summary.md'])
      assert.equal(readFileSync(joinPath(outDir, name), 'utf8'), 'same');
    writeFileSync(joinPath(dir, 'scripts', 'keep.mjs'), 'export const keep = 2;\n');
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', [
      '-C',
      dir,
      '-c',
      'user.email=f@x',
      '-c',
      'user.name=f',
      'commit',
      '-qm',
      'next',
    ]);
    assert.equal(run().status, 2);
    for (const name of ['stats.json', 'findings.json', 'summary.md'])
      assert.equal(existsSync(joinPath(outDir, name)), false);
    assert.equal(existsSync(joinPath(outDir, 'diff.patch')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Task 3 — path scope (--paths / --exclude-paths / auto-budget) ─────────

test('userPathspecs: paths -> :(top,glob), excludePaths -> :(top,glob,exclude); both empty -> []', () => {
  assert.deepEqual(userPathspecs(['a/**'], ['b/**']), [
    ':(top,glob)a/**',
    ':(top,glob,exclude)b/**',
  ]);
  assert.deepEqual(userPathspecs([], []), []);
  assert.deepEqual(userPathspecs(undefined, undefined), []);
});

test('buildPathScopeNote: empty string when nothing dropped; names --paths/--exclude-paths/auto-excluded pieces when something was', () => {
  assert.equal(
    buildPathScopeNote({ paths: [], excludePaths: [], autoExcludedGlobs: [], droppedCount: 0 }),
    '',
  );
  const note = buildPathScopeNote({
    paths: ['a/**'],
    excludePaths: ['b/**'],
    autoExcludedGlobs: ['*.jsonl'],
    droppedCount: 3,
  });
  assert.match(note, /--paths a\/\*\*/);
  assert.match(note, /--exclude-paths b\/\*\*/);
  assert.match(note, /auto-excluded/);
  assert.match(note, /\*\.jsonl/);
  assert.match(note, /3 changed file\(s\)/);
});

// A real temp repo with one file to KEEP, one to drop via --exclude-paths, and one .jsonl file
// (a DEFAULT_DATA_EXCLUDE_GLOBS member) to prove the auto-budget layer actually changes what's
// in the patch, not just its own metadata.
function pathScopeRepo() {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gptrev-scope-'));
  const g = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  g(['init', '-q', '-b', 'master']);
  g(['config', 'user.email', 'f@x']);
  g(['config', 'user.name', 'f']);
  mkdirSync(joinPath(dir, 'scripts'), { recursive: true });
  writeFileSync(joinPath(dir, 'scripts', 'keep.mjs'), 'export const a = 1;\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  g(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
  mkdirSync(joinPath(dir, 'notes'), { recursive: true });
  writeFileSync(joinPath(dir, 'notes', 'drop-me.txt'), 'excluded by --exclude-paths\n');
  writeFileSync(joinPath(dir, 'scripts', 'keep.mjs'), 'export const a = 2;\n');
  writeFileSync(joinPath(dir, 'telemetry.jsonl'), '{"event":"x"}\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'change']);
  return dir;
}

test('applyPathScope: --exclude-paths drops the matching glob from BOTH the file list and the patch bytes', () => {
  const dir = pathScopeRepo();
  const outPath = joinPath(dir, 'diff.patch');
  const scoped = applyPathScope({
    diffTargets: ['origin/master', 'HEAD'],
    outPath,
    repoRoot: dir,
    paths: [],
    excludePaths: ['notes/**'],
  });
  assert.deepEqual(scoped.files.sort(), ['scripts/keep.mjs', 'telemetry.jsonl']);
  assert.doesNotMatch(scoped.patch, /drop-me/);
  assert.match(scoped.patch, /keep\.mjs/);
  assert.deepEqual(scoped.autoExcludedGlobs, [], 'under budget — the auto layer never fires');
  assert.equal(
    readFileSync(outPath, 'utf8'),
    scoped.patch,
    'the patch on disk matches the returned bytes',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('applyPathScope: --paths narrows to ONLY the matching glob', () => {
  const dir = pathScopeRepo();
  const scoped = applyPathScope({
    diffTargets: ['origin/master', 'HEAD'],
    outPath: joinPath(dir, 'diff.patch'),
    repoRoot: dir,
    paths: ['scripts/**'],
    excludePaths: [],
  });
  assert.deepEqual(scoped.files, ['scripts/keep.mjs']);
  rmSync(dir, { recursive: true, force: true });
});

// ─── (E) f8c8df — per-glob precision on the additive auto-exclude report ────────────────────
//
// Round 2 reported the WHOLE additive glob set whenever ANY of them dropped a file — all-or-
// nothing, so if a SECOND additive glob is ever added that matches nothing in a given diff while
// the first one does, the report would falsely claim that tree was excluded too. Derive the
// reported list per glob from that glob's OWN actual file delta instead. additiveGlobs currently
// has exactly one member (`**/*.jsonl`) so this is exercised directly against the underlying
// helper rather than waiting for DEFAULT_DATA_EXCLUDE_GLOBS to grow a second one for real.
test('additiveGlobsThatDropped: reports only the glob(s) that ACTUALLY dropped a file — never the whole set just because ONE of them fired (round 3, item E / f8c8df)', () => {
  const dir = pathScopeRepo();
  const beforeFileCount = 3; // scripts/keep.mjs, notes/drop-me.txt, telemetry.jsonl
  const globs = additiveGlobsThatDropped({
    diffTargets: ['origin/master', 'HEAD'],
    basePathspecs: [],
    additiveGlobs: ['**/*.jsonl', '**/*.nomatch-glob-xyz'],
    beforeFileCount,
    repoRoot: dir,
  });
  assert.deepEqual(
    globs,
    ['**/*.jsonl'],
    'only the glob that actually dropped a file may be named — a glob matching nothing in this ' +
      'diff must never be reported as having excluded anything',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('additiveGlobsThatDropped: reports [] when NONE of the additive globs drop anything (budget crossed on size alone)', () => {
  const dir = pathScopeRepo();
  const globs = additiveGlobsThatDropped({
    diffTargets: ['origin/master', 'HEAD'],
    basePathspecs: [],
    additiveGlobs: ['**/*.nomatch-a', '**/*.nomatch-b'],
    beforeFileCount: 3,
    repoRoot: dir,
  });
  assert.deepEqual(globs, []);
  rmSync(dir, { recursive: true, force: true });
});

test('applyPathScope: over budgetChars auto-applies DEFAULT_DATA_EXCLUDE_GLOBS, dropping the .jsonl file the built-in list alone would not', () => {
  const dir = pathScopeRepo();
  const under = applyPathScope({
    diffTargets: ['origin/master', 'HEAD'],
    outPath: joinPath(dir, 'diff.patch'),
    repoRoot: dir,
    paths: [],
    excludePaths: [],
  });
  assert.ok(
    under.files.includes('telemetry.jsonl'),
    'under budget: the jsonl file is reviewed normally',
  );
  const over = applyPathScope({
    diffTargets: ['origin/master', 'HEAD'],
    outPath: joinPath(dir, 'diff.patch'),
    repoRoot: dir,
    paths: [],
    excludePaths: [],
    budgetChars: 1, // force "over budget" on any non-empty diff
  });
  // plan 3369 fix round 2 (374430/3952c1): `basePathspecs` (above, in applyPathScope) already
  // applies scopedPathspecs(excludes) UNCONDITIONALLY, before this budget layer ever runs — so
  // re-adding those SAME members here is a proven no-op, and claiming them as something THIS
  // pass excluded is false provenance. Only the genuinely-additive member
  // (defaultDataExcludeGlobsFor(excludes) minus excludes) may be reported, and only because it
  // actually dropped telemetry.jsonl in THIS run. `applyPathScope` was called with no `excludes`
  // above, so it defaulted to CORE_REVIEW_DIFF_EXCLUDES — match that here.
  assert.deepEqual(
    over.autoExcludedGlobs,
    defaultDataExcludeGlobsFor(CORE_REVIEW_DIFF_EXCLUDES).filter(
      (g) => !CORE_REVIEW_DIFF_EXCLUDES.includes(g),
    ),
    'only the genuinely-additive glob(s) may be named — never a CORE_REVIEW_DIFF_EXCLUDES ' +
      'member the built-in layer already applied for free',
  );
  assert.ok(
    !over.files.includes('telemetry.jsonl'),
    'over budget: the auto layer drops the .jsonl file',
  );
  assert.ok(over.files.includes('scripts/keep.mjs'), 'a real source file survives the auto layer');
  rmSync(dir, { recursive: true, force: true });
});

// plan 3369 fix round 2 (374430/3952c1): the false-provenance class this fix closes — a budget
// pass that FIRES (the diff crossed the byte budget) but drops NOTHING (no file in this diff
// matches any of the genuinely-additive globs) must report an empty list, exactly like
// buildScopeStatsField's own "present but nothing dropped -> {}" contract one layer up.
test('applyPathScope: a budget pass that fires but drops NOTHING reports autoExcludedGlobs: [] — never a false narrowing claim', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gptrev-scope-noadd-'));
  const g = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  g(['init', '-q', '-b', 'master']);
  g(['config', 'user.email', 'f@x']);
  g(['config', 'user.name', 'f']);
  mkdirSync(joinPath(dir, 'scripts'), { recursive: true });
  writeFileSync(joinPath(dir, 'scripts', 'keep.mjs'), 'export const a = 1;\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  g(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
  // A large real source file ONLY — no jsonl, no backend/data, nothing any exclude glob
  // matches — so crossing the budget is purely a SIZE fact, not a data-artifact fact.
  writeFileSync(joinPath(dir, 'scripts', 'keep.mjs'), 'export const a = 2; // '.repeat(500) + '\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'change']);

  const over = applyPathScope({
    diffTargets: ['origin/master', 'HEAD'],
    outPath: joinPath(dir, 'diff.patch'),
    repoRoot: dir,
    paths: [],
    excludePaths: [],
    budgetChars: 1, // force "over budget" — the pass FIRES
  });
  assert.deepEqual(
    over.autoExcludedGlobs,
    [],
    'the pass fired but excluded nothing real — reporting any glob here would be a false narrowing claim',
  );
  assert.ok(over.files.includes('scripts/keep.mjs'), 'the real source file is untouched');
  rmSync(dir, { recursive: true, force: true });
});

// FINDER_CONTEXT_BUDGET_CHARS is the measured codex ceiling named in the plan/debt entry — pin
// its VALUE (not just its existence) so a future edit cannot silently drift it back toward "no
// limit" or below what a normal review needs.
test('FINDER_CONTEXT_BUDGET_CHARS: matches the measured codex per-call read ceiling (plan 2840)', () => {
  assert.equal(FINDER_CONTEXT_BUDGET_CHARS, 1_048_576);
});

// ─── Task 4 — torn checkpoint -> quarantine, never abort ────────────────────

test('quarantineTornCheckpoint: renames to <name>.torn-1.json and returns the destination', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-torn-'));
  const p = joinPath(outDir, 'checkpoint.json');
  writeFileSync(p, 'torn beyond parsing');
  const dest = quarantineTornCheckpoint(p);
  assert.equal(dest, joinPath(outDir, 'checkpoint.torn-1.json'));
  assert.equal(existsSync(p), false, 'the torn original is moved aside, not left in place');
  assert.equal(readFileSync(dest, 'utf8'), 'torn beyond parsing');
  rmSync(outDir, { recursive: true, force: true });
});

test('quarantineTornCheckpoint: a SECOND tear bumps the index instead of clobbering the first quarantine', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-torn-'));
  writeFileSync(joinPath(outDir, 'checkpoint.torn-1.json'), 'first torn\n');
  const p = joinPath(outDir, 'checkpoint.json');
  writeFileSync(p, 'second torn\n');
  const dest = quarantineTornCheckpoint(p);
  assert.equal(dest, joinPath(outDir, 'checkpoint.torn-2.json'));
  assert.equal(readFileSync(joinPath(outDir, 'checkpoint.torn-1.json'), 'utf8'), 'first torn\n');
  assert.equal(readFileSync(dest, 'utf8'), 'second torn\n');
  rmSync(outDir, { recursive: true, force: true });
});

test('Checkpoint: a torn checkpoint.json is quarantined and resume starts fresh, never aborts', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-torn-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  writeFileSync(ckptPath, '{ not json at all');
  const logs = [];
  const origLog = console.log;
  console.log = (m) => logs.push(m);
  let ckpt;
  try {
    ckpt = new Checkpoint(ckptPath);
  } finally {
    console.log = origLog;
  }
  assert.deepEqual(ckpt.data, { calls: {} }, 'starts fresh rather than aborting the resume');
  assert.equal(existsSync(ckptPath), false, 'the torn file no longer sits at the live path');
  assert.ok(existsSync(joinPath(outDir, 'checkpoint.torn-1.json')), 'quarantined for post-mortem');
  assert.ok(logs.some((m) => /quarantined to/.test(m)));
  rmSync(outDir, { recursive: true, force: true });
});

test('Checkpoint: a checkpoint that parses but has no `calls` map is left in place (not quarantined) — a DIFFERENT, pre-existing recovery path', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-torn-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  writeFileSync(ckptPath, '{"not_calls": true}');
  new Checkpoint(ckptPath);
  assert.ok(
    existsSync(ckptPath),
    'valid-JSON-wrong-shape is not a PARSE failure — quarantine is scoped to that',
  );
  assert.equal(existsSync(joinPath(outDir, 'checkpoint.torn-1.json')), false);
  rmSync(outDir, { recursive: true, force: true });
});

test('Checkpoint.set: writes via temp-file + atomic rename — no .tmp-<pid> file survives a normal set()', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-atomic-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  const ckpt = new Checkpoint(ckptPath);
  ckpt.set('tag1', { data: { ok: true } });
  assert.equal(JSON.parse(readFileSync(ckptPath, 'utf8')).calls.tag1.data.ok, true);
  const leftover = readdirSync(outDir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftover, [], 'the temp file is renamed away, never left beside the final one');
  rmSync(outDir, { recursive: true, force: true });
});

test('Checkpoint: get()/set() resume contract is unchanged by the atomic-write change — an errored call is retried, a successful one is cached', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-atomic-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  assert.equal(ckpt.get('tag'), null);
  ckpt.set('tag', { error: 'boom' });
  assert.equal(ckpt.get('tag'), null, 'an errored call is never cached as final');
  ckpt.set('tag', { data: { ok: true } });
  assert.deepEqual(ckpt.get('tag'), { data: { ok: true } });
  rmSync(outDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// plan 3369 FIX ROUND 1 — gpt-review-review findings ac45fd/bc6b9c/26e27a (1),
// f2481e/c1b242/9cb459/055dc7 (2), 351a8f/562162/374712 (3), bf342e (4),
// 58023b/cb7bdb (5), b65c47/3e458e (6), 1522de/46279f/4fd40f (7), 0d4d1b (8).
// Same testing philosophy as the rest of this file: no real codex/claude
// subprocess anywhere below.
// ═══════════════════════════════════════════════════════════════════════════

// ─── (1) ac45fd/bc6b9c/26e27a — a path-scoped-to-nothing review is a hard
// failure (EXIT_EMPTY_RANGE), never a PASS ───────────────────────────────────

test('gpt-review (integration): --paths matching nothing on a NON-empty diff exits EXIT_EMPTY_RANGE, never a PASS, and names the scope (not "wrong checkout")', () => {
  const dir = pathScopeRepo();
  const outDir = joinPath(dir, 'out');
  const res = spawnSync(
    process.execPath,
    [GPT_REVIEW_PATH, '--no-detach', '--paths', 'nonexistent-dir/**', '--out', outDir],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(
    res.status,
    EXIT_EMPTY_RANGE,
    `expected exit ${EXIT_EMPTY_RANGE} (never a PASS), got ${res.status}; stderr: ${res.stderr}`,
  );
  assert.match(res.stderr, /EMPTY RANGE/);
  assert.match(res.stderr, /--paths nonexistent-dir\/\*\*/, 'the message names THIS run’s scope');
  assert.doesNotMatch(
    res.stderr,
    /worktree/i,
    'must read as a scope failure, not the wrong-checkout diagnosis the top-of-file guard prints',
  );
  assert.equal(
    existsSync(joinPath(outDir, 'stats.json')),
    false,
    'no stats.json — a scoped-to-nothing run must never be adoptable as a PASS',
  );
  assert.ok(existsSync(joinPath(outDir, 'summary.md')), 'the failure is still written up');
  assert.match(
    readFileSync(joinPath(outDir, 'summary.md'), 'utf8'),
    /FAILED \(empty after path scoping\)/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('gpt-review (integration): a reused --out’s stale PASS-shaped stats.json is DELETED by a --paths-to-nothing re-run, never adopted', () => {
  const dir = pathScopeRepo();
  const outDir = joinPath(dir, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    joinPath(outDir, 'stats.json'),
    JSON.stringify({
      stats: { finders: 11, candidates: 0, verifierAgents: 0, escalated: 0, reported: 0 },
    }),
  );
  const res = spawnSync(
    process.execPath,
    [GPT_REVIEW_PATH, '--no-detach', '--paths', 'nonexistent-dir/**', '--out', outDir],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(res.status, EXIT_EMPTY_RANGE);
  assert.equal(
    existsSync(joinPath(outDir, 'stats.json')),
    false,
    'the stale pass-shaped stats.json must be deleted, not left for record-review to adopt',
  );
  rmSync(dir, { recursive: true, force: true });
});

// The one legitimate empty-PATH-SCOPE case does NOT exist — a genuinely correct empty PASS is
// ONLY the built-in-excludes-alone case (already covered by the existing "artifacts-only range
// still PASSES" test above); this section's whole point is that layering the RUN's OWN scope on
// top can only ever produce a hard failure, never a second PASS shape.

// ─── (2) f2481e/c1b242/9cb459/055dc7 — checkpoint identity binding ──────────

test('reviewIdentityFingerprint: pure, stable for identical inputs, changes with range/endRef/paths/excludePaths/autoExcludedGlobs — order within each array does not matter', () => {
  const base = {
    rangeLabel: 'abc..def',
    endRef: null,
    paths: ['scripts/**'],
    excludePaths: [],
    autoExcludedGlobs: [],
  };
  const fp1 = reviewIdentityFingerprint(base);
  assert.equal(
    reviewIdentityFingerprint({ ...base }),
    fp1,
    'identical inputs -> identical fingerprint',
  );
  assert.equal(
    reviewIdentityFingerprint({ ...base, paths: ['scripts/**', 'backend/**'].reverse() }),
    reviewIdentityFingerprint({ ...base, paths: ['backend/**', 'scripts/**'] }),
    'array ORDER must not change the fingerprint — only content',
  );
  assert.notEqual(reviewIdentityFingerprint({ ...base, rangeLabel: 'zzz..yyy' }), fp1);
  assert.notEqual(reviewIdentityFingerprint({ ...base, endRef: 'v1' }), fp1);
  assert.notEqual(reviewIdentityFingerprint({ ...base, paths: ['backend/**'] }), fp1);
  assert.notEqual(reviewIdentityFingerprint({ ...base, excludePaths: ['x/**'] }), fp1);
  assert.notEqual(reviewIdentityFingerprint({ ...base, autoExcludedGlobs: ['**/*.jsonl'] }), fp1);
});

test('plan 3872: checkpoint identity is identical when the same linked worktree is addressed by cwd or --repo', () => {
  const root = mkdtempSync(joinPath(tmpdir(), 'gptrev-readdress-'));
  const main = joinPath(root, 'main');
  const linked = joinPath(root, 'linked');
  mkdirSync(main);
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git(main, ['init', '-q', '-b', 'master']);
    git(main, ['config', 'user.email', 'f@x']);
    git(main, ['config', 'user.name', 'f']);
    writeFileSync(joinPath(main, 'reviewed.mjs'), 'export const value = 1;\n');
    git(main, ['add', 'reviewed.mjs']);
    git(main, ['commit', '-qm', 'base']);
    git(main, ['worktree', 'add', '-q', '-b', 'review', linked]);
    writeFileSync(joinPath(linked, 'reviewed.mjs'), 'export const value = 2;\n');
    git(linked, ['add', 'reviewed.mjs']);
    git(linked, ['commit', '-qm', 'change']);

    const cwdRepoRoot = git(linked, ['rev-parse', '--show-toplevel']);
    const repoFlagRoot = execFileSync('git', ['-C', linked, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    const identityFor = (repoRoot, suffix) => {
      const diffTargets = ['master', 'HEAD'];
      const scoped = applyPathScope({
        diffTargets,
        outPath: joinPath(root, `diff-${suffix}.patch`),
        repoRoot,
        paths: [],
        excludePaths: [],
      });
      const components = reviewIdentityComponents({
        rangeLabel: 'master..HEAD',
        resolvedShas: resolveDiffTargetShas(diffTargets, repoRoot),
        paths: [],
        excludePaths: [],
        autoExcludedGlobs: scoped.autoExcludedGlobs,
        diffDigest: createHash('sha256').update(scoped.patch).digest('hex'),
      });
      return reviewIdentityFingerprint(components);
    };
    assert.equal(identityFor(cwdRepoRoot, 'cwd'), identityFor(repoFlagRoot, 'repo'));
  } finally {
    try {
      git(main, ['worktree', 'remove', '--force', linked]);
    } catch {
      // plan 3872: cleanup is best-effort so a failed assertion remains the reported failure.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('Checkpoint.bindFingerprint: a MATCHING fingerprint on reopen keeps every cached call; a MISMATCHED one discards them all and logs loudly (f2481e/c1b242/9cb459/055dc7)', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-fingerprint-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  const fpA = reviewIdentityFingerprint({ rangeLabel: 'a..b', paths: ['scripts/**'] });
  const fpB = reviewIdentityFingerprint({ rangeLabel: 'a..b', paths: ['backend/**'] });

  // First run: a real --paths scripts/** review completes one finder call.
  const first = new Checkpoint(ckptPath);
  first.set('finder:angle-A', { data: { candidates: [] }, tokens: 5, wallS: 1 });
  first.bindFingerprint(fpA);
  assert.deepEqual(first.get('finder:angle-A'), { data: { candidates: [] }, tokens: 5, wallS: 1 });

  // Resume with the SAME scope: the cached call must survive.
  const resumeSame = new Checkpoint(ckptPath);
  resumeSame.bindFingerprint(fpA);
  assert.deepEqual(
    resumeSame.get('finder:angle-A'),
    { data: { candidates: [] }, tokens: 5, wallS: 1 },
    'a matching fingerprint on reopen must NOT discard prior results',
  );

  // Resume with a DIFFERENT scope (--paths backend/** this time) against the SAME --out: the
  // finder result computed for scripts/** must NOT be reused for a backend/** review.
  const resumeDifferent = new Checkpoint(ckptPath);
  const logs = [];
  const origLog = console.log;
  console.log = (m) => logs.push(m);
  try {
    resumeDifferent.bindFingerprint(fpB);
  } finally {
    console.log = origLog;
  }
  assert.equal(
    resumeDifferent.get('finder:angle-A'),
    null,
    'a MISMATCHED fingerprint must discard every cached call — never a silent partial reuse',
  );
  assert.ok(
    logs.some((m) => /different range\/path-scope identity/.test(m)),
    'the discard must be logged loudly, not silent',
  );
  rmSync(outDir, { recursive: true, force: true });
});

test('plan 3872: checkpoint mismatch names changed identity components while legacy checkpoints retain the old fail-soft message', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-component-diagnostic-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  try {
    const priorComponents = reviewIdentityComponents({
      rangeLabel: 'a..b',
      resolvedShas: ['aaa', 'bbb'],
      paths: ['scripts/**'],
      diffDigest: 'old',
    });
    const nextComponents = reviewIdentityComponents({
      rangeLabel: 'a..b',
      resolvedShas: ['aaa', 'bbb'],
      paths: ['backend/**'],
      diffDigest: 'new',
    });
    const first = new Checkpoint(ckptPath);
    first.bindFingerprint(reviewIdentityFingerprint(priorComponents), {
      components: priorComponents,
    });
    first.set('finder:angle-A', { data: { candidates: [] } });
    const logs = [];
    const resume = new Checkpoint(ckptPath);
    resume.bindFingerprint(
      reviewIdentityFingerprint(nextComponents),
      { components: nextComponents },
      (message) => logs.push(message),
    );
    assert.match(logs[0], /Changed component\(s\):/);
    assert.match(logs[0], /diffDigest: prior="old" now="new"/);
    assert.match(logs[0], /paths: prior=\["scripts\/\*\*"\] now=\["backend\/\*\*"\]/);

    writeFileSync(
      ckptPath,
      JSON.stringify({ fingerprint: 'old-fingerprint', calls: { 'finder:a': {} } }),
    );
    const legacyLogs = [];
    new Checkpoint(ckptPath).bindFingerprint(
      'new-fingerprint',
      { components: nextComponents },
      (message) => legacyLogs.push(message),
    );
    assert.doesNotMatch(legacyLogs[0], /Changed component/);
    assert.match(legacyLogs[0], /prior=old-fingerprint now=new-fingerprint/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// plan 3369 FIX ROUND 2 — delta /gpt-review findings, round-1's own gaps/regressions.
// ═══════════════════════════════════════════════════════════════════════════

// ─── (A) c3e304/a84062/2ca244/34a666/2f11a3/4f1ba2 — a checkpoint with cached calls but NO
// fingerprint is an UNKNOWN identity, not a fresh one ────────────────────────────────────
test('Checkpoint.bindFingerprint: a LEGACY checkpoint (cached calls, no fingerprint) is discarded as an unknown identity, never trusted as a first bind (c3e304/a84062/2ca244/34a666/2f11a3/4f1ba2)', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-legacy-fp-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  // Simulate exactly what output/reports/2766-c3-shipped-lane-replay/runs/rep0/checkpoint.json
  // (finding a84062's cited evidence) looks like: real cached finder output, no `fingerprint`
  // key at all — written by the pre-plan-3369 Checkpoint.set(), which never stamped one.
  writeFileSync(
    ckptPath,
    JSON.stringify({
      calls: {
        'finder:angle-A': {
          data: { candidates: [{ file: 'a.ts', line: 1 }] },
          tokens: 5,
          wallS: 1,
        },
      },
    }),
  );
  const fp = reviewIdentityFingerprint({ rangeLabel: 'a..b', paths: ['backend/**'] });
  const logs = [];
  const origLog = console.log;
  console.log = (m) => logs.push(m);
  let ckpt;
  try {
    ckpt = new Checkpoint(ckptPath);
    ckpt.bindFingerprint(fp);
  } finally {
    console.log = origLog;
  }
  assert.equal(
    ckpt.get('finder:angle-A'),
    null,
    'a legacy checkpoint (cached calls, no fingerprint) must be discarded — resuming it for a ' +
      'DIFFERENT range/scope must never silently reuse its results',
  );
  assert.ok(
    logs.some((m) => /unknown identity|UNKNOWN identity/.test(m)),
    'the discard must be logged loudly, not silent',
  );
  // The now-empty checkpoint must persist the new fingerprint on disk — a SECOND resume against
  // the same --out with the SAME fp must see it as a matching identity, not re-discard forever.
  const onDisk = JSON.parse(readFileSync(ckptPath, 'utf8'));
  assert.equal(onDisk.fingerprint, fp);
  rmSync(outDir, { recursive: true, force: true });
});

test('Checkpoint.bindFingerprint: a genuine FIRST bind (no fingerprint, no cached calls yet) still persists silently — no false discard log', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-firstbind-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  const fp = reviewIdentityFingerprint({ rangeLabel: 'a..b' });
  const logs = [];
  const origLog = console.log;
  console.log = (m) => logs.push(m);
  let ckpt;
  try {
    ckpt = new Checkpoint(ckptPath); // brand new — no file on disk at all
    ckpt.bindFingerprint(fp);
  } finally {
    console.log = origLog;
  }
  assert.deepEqual(logs, [], 'a brand-new checkpoint with nothing cached must not log a discard');
  assert.equal(JSON.parse(readFileSync(ckptPath, 'utf8')).fingerprint, fp);
  rmSync(outDir, { recursive: true, force: true });
});

// ─── (B) 2a4d68/b786c7/331b91/8aed81/5f31de — fingerprint the RESOLVED commits, not the
// literal range STRING ────────────────────────────────────────────────────────────────
test('reviewIdentityFingerprint: changes with resolvedShas even when rangeLabel/endRef/paths are all unchanged', () => {
  const base = {
    rangeLabel: 'origin/master...HEAD',
    endRef: null,
    resolvedShas: ['aaa', 'bbb'],
    paths: [],
    excludePaths: [],
    autoExcludedGlobs: [],
  };
  const fp1 = reviewIdentityFingerprint(base);
  assert.equal(
    reviewIdentityFingerprint({ ...base }),
    fp1,
    'identical resolvedShas -> identical fingerprint',
  );
  assert.notEqual(
    reviewIdentityFingerprint({ ...base, resolvedShas: ['aaa', 'ccc'] }),
    fp1,
    'a moved endpoint (same rangeLabel) must change the fingerprint',
  );
  assert.equal(
    reviewIdentityFingerprint({ rangeLabel: 'x', endRef: null }),
    reviewIdentityFingerprint({ rangeLabel: 'x', endRef: null, resolvedShas: [] }),
    'omitted resolvedShas defaults to [] — backward compatible with every round-1 fingerprint call',
  );
});

test('resolveDiffTargetShas: splits a literal range STRING on ... or .. and rev-parses each side; an already-resolved (mergeBase, headSha) pair round-trips unchanged', () => {
  const calls = [];
  const runGit = (args) => {
    calls.push(args);
    return `resolved-${args[1]}\n`;
  };
  assert.deepEqual(resolveDiffTargetShas(['origin/master...HEAD'], '/repo', runGit), [
    'resolved-origin/master',
    'resolved-HEAD',
  ]);
  assert.deepEqual(calls, [
    ['rev-parse', 'origin/master'],
    ['rev-parse', 'HEAD'],
  ]);

  calls.length = 0;
  assert.deepEqual(resolveDiffTargetShas(['HEAD~1..HEAD'], '/repo', runGit), [
    'resolved-HEAD~1',
    'resolved-HEAD',
  ]);

  // The default path's diffTargets are already a resolved (mergeBase, headSha) PAIR — no `.`
  // operator in either element, so each resolves to itself (idempotent, still a real rev-parse).
  calls.length = 0;
  assert.deepEqual(resolveDiffTargetShas(['deadbeef', 'cafef00d'], '/repo', runGit), [
    'resolved-deadbeef',
    'resolved-cafef00d',
  ]);
});

test('resolveDiffTargetShas: a resolution failure degrades to a distinct unresolved marker rather than throwing (a ref moving mid-run must not crash an otherwise-complete diff)', () => {
  const runGit = () => {
    throw new Error('fatal: ambiguous argument');
  };
  const shas = resolveDiffTargetShas(['a..b'], '/repo', runGit);
  assert.equal(shas.length, 2);
  // round 3 (ad5632/da8bc1): degrading to the RAW ref text ('a', 'b') made a resolution
  // failure a STABLE identity — if the same ref failed to resolve on both the original run and
  // a later resume (the ref moved and no longer exists under that name, or a transient git error
  // simply recurred), the fingerprint was UNCHANGED and the moved-ref invalidation this whole
  // mechanism exists for was silently defeated. Neither element may equal its raw ref anymore.
  assert.notEqual(shas[0], 'a');
  assert.notEqual(shas[1], 'b');
});

test('resolveDiffTargetShas: two SEPARATE resolution failures for the SAME ref never produce the same marker — the exact case that used to defeat checkpoint invalidation (round 3, item C / ad5632, da8bc1)', () => {
  const runGit = () => {
    throw new Error('fatal: ambiguous argument');
  };
  const first = resolveDiffTargetShas(['origin/master...HEAD'], '/repo', runGit);
  const second = resolveDiffTargetShas(['origin/master...HEAD'], '/repo', runGit);
  assert.notDeepEqual(
    first,
    second,
    'a failed resolution must fingerprint as an always-distinct identity, never a stable one — ' +
      'otherwise a ref that moved AND still fails to resolve looks unchanged',
  );
});

test('resolveDiffTargetShas: a resolution failure is logged, never silently swallowed (round 3, item C)', () => {
  const runGit = () => {
    throw new Error('fatal: bad revision');
  };
  const logs = [];
  resolveDiffTargetShas(['deadbeef..HEAD'], '/repo', runGit, (m) => logs.push(m));
  assert.ok(
    logs.some((m) => /rev-parse/.test(m) && /deadbeef/.test(m)),
    'the degraded resolution must be logged so a human sees it, not a silent pass-through',
  );
});

// End-to-end proof (no codex, no main() — the exported building blocks main() itself calls):
// an explicit --range STRING is a stable LABEL, but the diff it names moves with the ref. A
// resume against the SAME --out after the ref moved must invalidate, even though rangeLabel
// (the string "HEAD~1..HEAD") never changed.
test('resolveDiffTargetShas + reviewIdentityFingerprint + Checkpoint.bindFingerprint: a moved ref invalidates the checkpoint even though the literal rangeLabel is unchanged (2a4d68/b786c7/331b91/8aed81/5f31de)', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gptrev-resolvedshas-'));
  const g = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  g(['init', '-q', '-b', 'master']);
  g(['config', 'user.email', 'f@x']);
  g(['config', 'user.name', 'f']);
  writeFileSync(joinPath(dir, 'a.txt'), '1\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'c1']);
  writeFileSync(joinPath(dir, 'a.txt'), '2\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'c2']);

  const rangeLabel = 'HEAD~1..HEAD'; // a literal STRING whose resolved endpoints move with HEAD
  const shasAtC2 = resolveDiffTargetShas([rangeLabel], dir);
  const fp1 = reviewIdentityFingerprint({ rangeLabel, resolvedShas: shasAtC2 });

  const ckptPath = joinPath(dir, 'checkpoint.json');
  const first = new Checkpoint(ckptPath);
  first.bindFingerprint(fp1);
  first.set('finder:angle-A', { data: { candidates: [] }, tokens: 1, wallS: 1 });

  // Advance HEAD to a NEW commit — the range STRING is byte-identical, but it now names a
  // completely different diff (c2..c3 instead of c1..c2).
  writeFileSync(joinPath(dir, 'a.txt'), '3\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'c3']);

  const shasAtC3 = resolveDiffTargetShas([rangeLabel], dir);
  assert.notDeepEqual(
    shasAtC3,
    shasAtC2,
    'sanity check: the resolved endpoints must actually differ after HEAD moves',
  );
  const fp2 = reviewIdentityFingerprint({ rangeLabel, resolvedShas: shasAtC3 });
  assert.notEqual(
    fp2,
    fp1,
    'same literal rangeLabel, different resolved commits -> different fingerprint',
  );

  const logs = [];
  const origLog = console.log;
  console.log = (m) => logs.push(m);
  let resumed;
  try {
    resumed = new Checkpoint(ckptPath);
    resumed.bindFingerprint(fp2);
  } finally {
    console.log = origLog;
  }
  assert.equal(
    resumed.get('finder:angle-A'),
    null,
    'the finder result computed for the OLD (c1..c2) diff must not be reused for the NEW (c2..c3) one',
  );
  assert.ok(logs.some((m) => /different range\/path-scope identity/.test(m)));
  rmSync(dir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// plan 3757 — a resumed gpt-review no longer wipes its own progress.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Change A helper: reviewRoundIdentityKey — stable for the SAME (range, end sha) pair ──

test('reviewRoundIdentityKey: stable for identical inputs, different across differing ones', () => {
  const key1 = reviewRoundIdentityKey({ resolvedShas: ['abc', 'def'] });
  assert.equal(
    reviewRoundIdentityKey({ resolvedShas: ['abc', 'def'] }),
    key1,
    'an identical resolved range must produce the SAME key',
  );
  assert.notEqual(
    reviewRoundIdentityKey({ resolvedShas: ['abc', 'zzz'] }),
    key1,
    'a different END sha must change the key',
  );
  // plan 3757 fix round 2 (gpt-review keys b3c753 / e11f2d / 3d1089 / 9f68c9 / 6b25fb / 41d409):
  // the BASE endpoint is part of the identity too. Keying on a literal range LABEL plus only the
  // resolved end sha meant that for an explicit mutable range (`origin/master..HEAD`), a moved
  // base left both inputs unchanged — so a genuinely different review silently reused the round.
  assert.notEqual(
    reviewRoundIdentityKey({ resolvedShas: ['xyz', 'def'] }),
    key1,
    'a different BASE sha must change the key',
  );
  // ORDER is meaningful — which endpoint is which — so a reversed range is a different review.
  assert.notEqual(reviewRoundIdentityKey({ resolvedShas: ['def', 'abc'] }), key1);
  // plan 3757 fix round 3 (gpt-review keys 6dd9f7 / fa651b / 93802a / 29ecef): `A..B` and
  // `A...B` resolve to the SAME endpoint pair but are different diffs — three-dot is
  // merge-base-based. The endpoint tuple alone cannot tell them apart, so the range label rides
  // along to carry the operator. It only ever ADDS specificity: two labels that resolve to one
  // tuple are then charged separate rounds, which is the safe direction for a cap.
  assert.notEqual(
    reviewRoundIdentityKey({ rangeLabel: 'abc...def', resolvedShas: ['abc', 'def'] }),
    reviewRoundIdentityKey({ rangeLabel: 'abc..def', resolvedShas: ['abc', 'def'] }),
    'two-dot and three-dot ranges over the same endpoints must not share a round',
  );
  // Never wall-clock or an invocation ordinal — no time-based input exists to vary here at all,
  // so two calls made at genuinely different times with the same inputs must still agree.
  assert.equal(reviewRoundIdentityKey({ resolvedShas: ['abc', 'def'] }), key1);
});

// ─── Change B helper: readCheckpointBasePin — fail-open, never throws ─────────────────────

test('readCheckpointBasePin: reads a well-formed checkpoint', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-basepin-'));
  try {
    writeFileSync(
      joinPath(outDir, 'checkpoint.json'),
      JSON.stringify({ calls: {}, fingerprint: 'fp1', base: 'aaa111', endSha: 'bbb222' }),
    );
    assert.deepEqual(readCheckpointBasePin(outDir), { base: 'aaa111', endSha: 'bbb222' });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('readCheckpointBasePin: never throws — a missing file, malformed JSON, or missing keys all return null', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-basepin-fail-'));
  try {
    // Missing file entirely — the deliberately LATE Checkpoint constructor exists precisely
    // because a torn checkpoint.json used to throw here; this reader must never reintroduce
    // that crash on its own, earlier read.
    assert.equal(readCheckpointBasePin(outDir), null, 'no checkpoint.json at all');

    writeFileSync(joinPath(outDir, 'checkpoint.json'), '{ not valid json');
    assert.equal(readCheckpointBasePin(outDir), null, 'malformed JSON');

    writeFileSync(joinPath(outDir, 'checkpoint.json'), JSON.stringify({ calls: {} }));
    assert.equal(
      readCheckpointBasePin(outDir),
      null,
      'no base/endSha keys at all (every pre-3757 checkpoint)',
    );

    writeFileSync(
      joinPath(outDir, 'checkpoint.json'),
      JSON.stringify({ calls: {}, base: 'aaa111' }),
    );
    assert.equal(readCheckpointBasePin(outDir), null, 'base present but endSha missing');

    writeFileSync(
      joinPath(outDir, 'checkpoint.json'),
      JSON.stringify({ calls: {}, endSha: 'bbb222' }),
    );
    assert.equal(readCheckpointBasePin(outDir), null, 'endSha present but base missing');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ─── Change B decision: resolveResumeMergeBase — pin ONLY when the tip is unchanged ───────

test('resolveResumeMergeBase: upstream drift with an UNCHANGED tip pins the recorded base', () => {
  const result = resolveResumeMergeBase({
    recorded: { base: 'old-base', endSha: 'same-tip' },
    currentEndSha: 'same-tip',
    freshBase: 'new-base-after-fetch',
  });
  assert.deepEqual(result, {
    base: 'old-base',
    pinned: true,
    reason: 'reviewed tip unchanged; adopting the recorded base over upstream-only drift',
  });
});

test('resolveResumeMergeBase: a CHANGED tip must NOT pin — the plan-3369 false-coverage case', () => {
  const result = resolveResumeMergeBase({
    recorded: { base: 'old-base', endSha: 'old-tip' },
    currentEndSha: 'new-tip', // a real new commit landed on the reviewed branch
    freshBase: 'new-base-after-fetch',
  });
  assert.equal(result.pinned, false);
  assert.equal(
    result.base,
    'new-base-after-fetch',
    'a changed tip must still reset to the fresh base',
  );
});

test('resolveResumeMergeBase: no recorded pin at all does not pin', () => {
  const result = resolveResumeMergeBase({
    recorded: null,
    currentEndSha: 'some-tip',
    freshBase: 'fresh-base',
  });
  assert.deepEqual(result, { base: 'fresh-base', pinned: false, reason: 'no recorded pin' });
});

test('resolveResumeMergeBase: a recorded pin missing endSha does not pin', () => {
  const result = resolveResumeMergeBase({
    recorded: { base: 'old-base', endSha: null },
    currentEndSha: 'some-tip',
    freshBase: 'fresh-base',
  });
  assert.equal(result.pinned, false);
  assert.equal(result.base, 'fresh-base');
});

test('resolveResumeMergeBase: a recorded pin missing base does not pin', () => {
  const result = resolveResumeMergeBase({
    recorded: { base: null, endSha: 'same-tip' },
    currentEndSha: 'same-tip',
    freshBase: 'fresh-base',
  });
  assert.equal(result.pinned, false);
  assert.equal(result.base, 'fresh-base');
});

test('resolveResumeMergeBase: a recorded base already equal to the fresh base is not "pinned" — nothing to adopt', () => {
  const result = resolveResumeMergeBase({
    recorded: { base: 'same-base', endSha: 'same-tip' },
    currentEndSha: 'same-tip',
    freshBase: 'same-base',
  });
  assert.deepEqual(result, {
    base: 'same-base',
    pinned: false,
    reason: 'recorded base already matches the fresh base',
  });
});

// ─── Change B: Checkpoint.bindFingerprint persists (base, endSha); a genuine mismatch still
// performs the full identity reset exactly as plan 3369 built it ─────────────────────────

test('Checkpoint.bindFingerprint: records base/endSha alongside the fingerprint on a matching resume', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-basepin-persist-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  try {
    const fp = reviewIdentityFingerprint({ rangeLabel: 'base1..tip1' });
    const first = new Checkpoint(ckptPath);
    first.set('finder:angle-A', { data: { candidates: [] }, tokens: 1, wallS: 1 });
    first.bindFingerprint(fp, { base: 'ba5e001', endSha: '11d0001' });
    assert.deepEqual(readCheckpointBasePin(outDir), { base: 'ba5e001', endSha: '11d0001' });

    // A resume with the SAME fingerprint AND the same (base, endSha) — the ordinary matching
    // case — must still keep every cached call and leave the recorded pin intact.
    const resumeSame = new Checkpoint(ckptPath);
    resumeSame.bindFingerprint(fp, { base: 'ba5e001', endSha: '11d0001' });
    assert.deepEqual(
      resumeSame.get('finder:angle-A'),
      { data: { candidates: [] }, tokens: 1, wallS: 1 },
      'a matching fingerprint must not be disturbed by the base/endSha pin bookkeeping',
    );
    assert.deepEqual(readCheckpointBasePin(outDir), { base: 'ba5e001', endSha: '11d0001' });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('Checkpoint.bindFingerprint: a genuine MISMATCH still performs the full identity reset (plan 3369 tests unmodified) even when base/endSha are supplied', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-basepin-mismatch-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  try {
    const fpA = reviewIdentityFingerprint({ rangeLabel: 'a..b', paths: ['scripts/**'] });
    const fpB = reviewIdentityFingerprint({ rangeLabel: 'a..b', paths: ['backend/**'] });
    const first = new Checkpoint(ckptPath);
    first.set('finder:angle-A', { data: { candidates: [] }, tokens: 5, wallS: 1 });
    first.bindFingerprint(fpA, { base: 'ba5e001', endSha: '11d0001' });

    const logs = [];
    const origLog = console.log;
    console.log = (m) => logs.push(m);
    let resumeDifferent;
    try {
      resumeDifferent = new Checkpoint(ckptPath);
      // A genuinely different identity (different path scope) — the tip changed too, in this
      // case — must still discard every cached call, exactly as plan 3369 built it.
      resumeDifferent.bindFingerprint(fpB, { base: 'ba5e002', endSha: '11d0002' });
    } finally {
      console.log = origLog;
    }
    assert.equal(
      resumeDifferent.get('finder:angle-A'),
      null,
      'a MISMATCHED fingerprint must still discard every cached call, base/endSha notwithstanding',
    );
    assert.ok(logs.some((m) => /different range\/path-scope identity/.test(m)));
    assert.deepEqual(readCheckpointBasePin(outDir), { base: 'ba5e002', endSha: '11d0002' });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ─── plan 3757 fix round 1 (gpt-review keys 41ed57/838938/e50513/a61c5d/d945eb,
//     721bd7, d95e77) ──────────────────────────────────────────────────────────────

test('reviewRoundIdentityKey: the path scope is part of the round identity, not just the range', () => {
  // The checkpoint identity (reviewIdentityFingerprint) already folds in --paths/--exclude-paths,
  // because a differently-scoped review reads a DIFFERENT diff. The round-cap key must agree:
  // without the scope, two genuinely different reviews against the same branch tip collapse into
  // one ledger round, and the second is never charged — the cap silently weakens.
  const base = { resolvedShas: ['abc', 'def'] };
  const unscoped = reviewRoundIdentityKey(base);
  assert.notEqual(
    reviewRoundIdentityKey({ ...base, paths: ['scripts/**'] }),
    unscoped,
    'a --paths scope must change the round identity',
  );
  assert.notEqual(
    reviewRoundIdentityKey({ ...base, paths: ['scripts/**'] }),
    reviewRoundIdentityKey({ ...base, paths: ['backend/**'] }),
    'two DIFFERENT --paths scopes must not share a round',
  );
  assert.notEqual(
    reviewRoundIdentityKey({ ...base, excludePaths: ['scripts/**'] }),
    unscoped,
    'an --exclude-paths scope must change the round identity',
  );
  // Order must not matter — only CONTENT — mirroring reviewIdentityFingerprint's own sorting.
  assert.equal(
    reviewRoundIdentityKey({ ...base, paths: ['a/**', 'b/**'] }),
    reviewRoundIdentityKey({ ...base, paths: ['b/**', 'a/**'] }),
    'the scope is a SET: key order must not change the identity',
  );
  // An omitted scope must stay identical to an explicitly-empty one, so a caller that never
  // passes paths keeps a stable key across this change.
  assert.equal(reviewRoundIdentityKey({ ...base, paths: [], excludePaths: [] }), unscoped);
});

test('readCheckpointBasePin: a non-string base/endSha is refused, never coerced into a fake sha', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-pin-types-'));
  try {
    const write = (obj) =>
      writeFileSync(joinPath(outDir, 'checkpoint.json'), JSON.stringify(obj), 'utf8');
    // `String({})` is '[object Object]' — a value that is not a sha but IS a non-empty string, so
    // a blind coercion would sail past the truthiness check and be handed to git as a merge-base.
    write({ calls: {}, base: {}, endSha: 'a'.repeat(40) });
    assert.equal(readCheckpointBasePin(outDir), null, 'an object base must be refused');
    write({ calls: {}, base: 'a'.repeat(40), endSha: ['b'] });
    assert.equal(readCheckpointBasePin(outDir), null, 'an array endSha must be refused');
    write({ calls: {}, base: 12345, endSha: 'a'.repeat(40) });
    assert.equal(readCheckpointBasePin(outDir), null, 'a numeric base must be refused');
    write({ calls: {}, base: 'not a sha at all', endSha: 'a'.repeat(40) });
    assert.equal(readCheckpointBasePin(outDir), null, 'a non-sha-shaped base must be refused');
    // The good case still reads, so the validation cannot have closed the door on real pins.
    const realBase = 'a'.repeat(40);
    const realTip = 'b'.repeat(40);
    write({ calls: {}, base: realBase, endSha: realTip });
    assert.deepEqual(readCheckpointBasePin(outDir), { base: realBase, endSha: realTip });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('reviewLaunchCapDecision: a same-identity RESUME is never denied, so it can never wipe its own artifacts', () => {
  // The cap governs LAUNCHES. A resume is not one: the review it resumes was authorised when its
  // round was minted, and any real code change moves the tip, which changes the identity and
  // mints a fresh round the cap does govern. Before this fix, a resume of an already-past-cap
  // round that omitted --past-cap on that one foreground call was denied — and main()'s denial
  // path calls clearStaleReviewArtifacts(outDir), destroying checkpoint.json and raw/, which is
  // precisely the damage class this whole plan exists to stop.
  const resumeShape = { ordinal: AT_CAP_ROUND + 2, resumed: true, denied: false };
  assert.deepEqual(
    reviewLaunchCapDecision(
      '/repo',
      { slug: '3527-SOL-cap', branch: 'worktree-3527-SOL-cap', pastCapReason: null },
      { recordLaunchFn: () => resumeShape },
    ),
    { planId: '3527', launchOrdinal: AT_CAP_ROUND + 2, denied: false, resumed: true },
    'a past-cap ordinal reached by RESUMING is not a denial',
  );
  // A genuine new launch at the same past-cap ordinal, with no --past-cap, is STILL denied —
  // the escape's semantics are untouched.
  assert.equal(
    reviewLaunchCapDecision(
      '/repo',
      { slug: '3527-SOL-cap', branch: 'worktree-3527-SOL-cap', pastCapReason: null },
      { recordLaunchFn: () => AT_CAP_ROUND + 2 },
    ).denied,
    true,
    'a fresh past-cap launch without --past-cap must still be denied',
  );
  // And the plan-3618 second-consecutive-run: denial shape still reads as a denial.
  assert.equal(
    reviewLaunchCapDecision(
      '/repo',
      { slug: '3527-SOL-cap', branch: 'worktree-3527-SOL-cap', pastCapReason: 'run: again' },
      { recordLaunchFn: () => ({ denied: true, ordinal: 6, consecutiveEscapes: 2 }) },
    ).denied,
    true,
    'the explicit denial shape must not be mistaken for a resume',
  );
});

// ─── (C) 1507e0/74a7c9/c1c033 — clear stale review artifacts on EVERY early-exit path,
// not just the path-scoped one ──────────────────────────────────────────────────────
// A `git` wrapper that proxies transparently to the REAL git for every call EXCEPT a `diff`
// invocation that is NOT `--name-only` — i.e. the FULL patch call (writeScopedPatch's own
// `runGit(scopedDiffArgs(...))`), which fails deterministically. The `--name-only` partition
// call (changedFilePartition, run first) succeeds normally, so this reproduces "the diff LIST
// succeeded but the actual patch write failed" without depending on any git version's own
// error quirks. POSIX-only (shebang + chmod +x) — mirrors fakeGitFailingOn below; the nightly
// Windows full-suite run is this repo's documented backstop for POSIX-only test-infra gaps.
function fakeGitFailingOnFullDiff() {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  const fakeDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-fakegit-fulldiff-'));
  const script =
    '#!/usr/bin/env node\n' +
    "'use strict';\n" +
    "const { spawnSync } = require('child_process');\n" +
    'const REAL_GIT = process.env.FAKE_GIT_REAL_PATH;\n' +
    'const args = process.argv.slice(2);\n' +
    "if (args[0] === 'diff' && !args.includes('--name-only')) {\n" +
    "  process.stderr.write('fatal: simulated full-diff failure for test\\n');\n" +
    '  process.exit(128);\n' +
    '}\n' +
    'const res = spawnSync(REAL_GIT, args, { stdio: "inherit" });\n' +
    'process.exit(res.status == null ? 1 : res.status);\n';
  const gitPath = joinPath(fakeDir, 'git');
  writeFileSync(gitPath, script);
  chmodSync(gitPath, 0o755);
  return { fakeDir, realGit };
}

test(
  'gpt-review (integration): the INITIAL unscoped diff-write failure clears stale review artifacts before exiting 2 (1507e0/c1c033)',
  { skip: process.platform === 'win32' },
  () => {
    const dir = pathScopeRepo();
    const outDir = joinPath(dir, 'out');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      joinPath(outDir, 'stats.json'),
      JSON.stringify({
        stats: { finders: 11, candidates: 0, verifierAgents: 0, escalated: 0, reported: 0 },
      }),
    );
    writeFileSync(joinPath(outDir, 'findings.json'), '[]\n');

    const { fakeDir, realGit } = fakeGitFailingOnFullDiff();
    try {
      const res = spawnSync(process.execPath, [GPT_REVIEW_PATH, '--no-detach', '--out', outDir], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeDir}:${process.env.PATH}`,
          FAKE_GIT_REAL_PATH: realGit,
        },
      });
      assert.equal(
        res.status,
        2,
        `expected exit 2 (transport/operational failure); stderr: ${res.stderr}`,
      );
      assert.match(res.stderr, /git diff failed for range/);
      assert.equal(
        existsSync(joinPath(outDir, 'stats.json')),
        false,
        'the stale stats.json must be cleared, not left for record-review to adopt as this run’s PASS',
      );
      assert.equal(existsSync(joinPath(outDir, 'findings.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
    }
  },
);

test('gpt-review (integration): the default-range resolution failure (no origin/master ref) clears stale review artifacts before exiting 2 (74a7c9)', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gptrev-noorigin-'));
  const g = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  g(['init', '-q', '-b', 'master']);
  g(['config', 'user.email', 'f@x']);
  g(['config', 'user.name', 'f']);
  writeFileSync(joinPath(dir, 'a.txt'), '1\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'c1']);
  // No `refs/remotes/origin/master` at all — the default path's `git merge-base origin/master
  // HEAD` cannot resolve, so main() must exit 2 via the resolution catch, never reaching the
  // point where it would write a fresh stats.json.
  const outDir = joinPath(dir, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    joinPath(outDir, 'stats.json'),
    JSON.stringify({
      stats: { finders: 11, candidates: 0, verifierAgents: 0, escalated: 0, reported: 0 },
    }),
  );
  writeFileSync(joinPath(outDir, 'findings.json'), '[]\n');

  const res = spawnSync(process.execPath, [GPT_REVIEW_PATH, '--no-detach', '--out', outDir], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(res.status, 2, `expected exit 2; stderr: ${res.stderr}`);
  assert.match(res.stderr, /failed to resolve the default review range/);
  assert.equal(
    existsSync(joinPath(outDir, 'stats.json')),
    false,
    'the stale stats.json must be cleared, not left for record-review to adopt as this run’s PASS',
  );
  assert.equal(existsSync(joinPath(outDir, 'findings.json')), false);
  rmSync(dir, { recursive: true, force: true });
});

// ─── (3) 351a8f/562162/374712 — reuse the shared atomic-write helper ────────

test('Checkpoint.set: a failed write (rename target already a directory) still cleans up its own temp file — no orphan left behind (351a8f/562162/374712)', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-atomic2-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  // Construct against a path that does not exist yet (no read attempted), THEN create a
  // DIRECTORY at that exact path — renameSync(tmp, ckptPath) must now fail (EISDIR/ENOTEMPTY),
  // the same shape the repo's own Windows guidance names for an existing destination.
  const ckpt = new Checkpoint(ckptPath);
  mkdirSync(ckptPath);
  assert.throws(() => ckpt.set('tag1', { data: { ok: true } }));
  const leftover = readdirSync(outDir).filter((f) => f !== 'checkpoint.json');
  assert.deepEqual(
    leftover,
    [],
    'the temp file must not survive a failed write — the hand-rolled version left it behind',
  );
  rmSync(outDir, { recursive: true, force: true });
});

// ─── plan 4071 — _persist() retries a transient Windows file-lock error on the checkpoint
// rename (a `--wait` poller or an AV on-access scanner briefly holding checkpoint.json open
// without FILE_SHARE_DELETE killed a real 30-minute review with an EPERM out of renameSync).
// These use the injected `_write`/`_sleep` seams — no real filesystem timing, no platform
// faking; the error `code` is the only thing under test.

test('Checkpoint._persist (plan 4071): EPERM on the first two writes then success — persisted, no throw, sleeper called twice', () => {
  let writeCalls = 0;
  let sleepCalls = 0;
  const ckpt = new Checkpoint('/unused/checkpoint.json', {
    _write: () => {
      writeCalls++;
      if (writeCalls <= 2) {
        const e = new Error('EPERM: operation not permitted, rename');
        e.code = 'EPERM';
        throw e;
      }
    },
    _sleep: () => {
      sleepCalls++;
    },
  });
  assert.doesNotThrow(() => ckpt.set('tag1', { data: { ok: true } }));
  assert.equal(writeCalls, 3, 'two failures then a success — three write attempts');
  assert.equal(sleepCalls, 2);
});

test('Checkpoint._persist (plan 4071): a non-lock error code (ENOSPC) is rethrown immediately, no retry', () => {
  let writeCalls = 0;
  let sleepCalls = 0;
  const ckpt = new Checkpoint('/unused/checkpoint.json', {
    _write: () => {
      writeCalls++;
      const e = new Error('ENOSPC: no space left on device');
      e.code = 'ENOSPC';
      throw e;
    },
    _sleep: () => {
      sleepCalls++;
    },
  });
  assert.throws(() => ckpt.set('tag1', { data: { ok: true } }), /ENOSPC/);
  assert.equal(writeCalls, 1, 'no retry on a non-lock error code');
  assert.equal(sleepCalls, 0);
});

test('Checkpoint._persist (plan 4071): exhaustion — always EPERM throws the EPERM after the bounded attempt count', () => {
  let writeCalls = 0;
  let sleepCalls = 0;
  const ckpt = new Checkpoint('/unused/checkpoint.json', {
    _write: () => {
      writeCalls++;
      const e = new Error('EPERM: operation not permitted, rename');
      e.code = 'EPERM';
      throw e;
    },
    _sleep: () => {
      sleepCalls++;
    },
  });
  assert.throws(() => ckpt.set('tag1', { data: { ok: true } }), /EPERM/);
  assert.ok(writeCalls >= 4, `expected several bounded attempts, got ${writeCalls}`);
  assert.equal(
    sleepCalls,
    writeCalls - 1,
    'a sleep happens between attempts, never after the last',
  );
});

// ─── (4) bf342e — persist the scope into the recorded review marker ────────

test('describeReviewScope: no scope, or excludedFileCount <= 0, announces and persists nothing (belt-and-suspenders alongside the gpt-review.mjs b65c47/3e458e gate)', () => {
  assert.deepEqual(describeReviewScope(null), { note: '', suffix: '' });
  assert.deepEqual(describeReviewScope({}), { note: '', suffix: '' });
  assert.deepEqual(describeReviewScope({ excludedFileCount: 0, userPaths: ['scripts/**'] }), {
    note: '',
    suffix: '',
  });
});

test('describeReviewScope: a real narrowed scope produces both the console note (unchanged wording) and a marker-safe suffix', () => {
  const described = describeReviewScope({
    userPaths: ['scripts/**'],
    userExcludePaths: [],
    autoExcludedGlobs: [],
    excludedFileCount: 4,
  });
  assert.match(described.note, /review scope was narrowed/);
  assert.match(described.note, /--paths scripts\/\*\*/);
  assert.match(described.note, /did not.*cover the full changed-file set/s);
  assert.equal(described.suffix, ' scope-narrowed[excluded=4]');
  assert.doesNotMatch(described.suffix, /[@\r\n]/, 'marker-safe: no @ or newline');
});

// plan 3369 fix round 2 (7d51a1): round 1 appended the scope suffix INTO `detail`, so it landed
// BETWEEN the counts and the ` @ <sha>` — a REGRESSION against
// mine-sonnet-lane-executor-telemetry.mjs's stricter marker regex (its counts group must be
// followed immediately by `@`). The fix moves the suffix to AFTER `@ <sha>` via a separate
// `appendMarkerScopeSuffix` step — `detail` itself carries ONLY the provenance token, never the
// suffix, so this test (and describeReviewScope's own contract) still hold.
test('bf342e/7d51a1: the scope suffix survives a FULL marker round-trip through the REAL done-worktree-lib.mjs functions, positioned AFTER `@ <sha>` — the existing marker regex still matches', () => {
  const described = describeReviewScope({
    userPaths: ['scripts/**'],
    userExcludePaths: [],
    autoExcludedGlobs: ['**/*.jsonl'],
    excludedFileCount: 4,
  });
  const detail = buildReviewProvenance({
    method: 'gpt-review',
    finders: 11,
    verifiers: 3,
    adjudicated: 1,
  });
  const sha = 'a'.repeat(40);
  const base = upsertReviewMarker('some prior session-file prose\n', 'PASS', sha, detail);
  const written = appendMarkerScopeSuffix(base, described.suffix);
  assert.match(
    written,
    /^Review: PASS:gpt-review f=11 v=3 adj=1 @ [0-9a-f]{40} scope-narrowed\[excluded=4\]$/m,
    'the suffix must sit AFTER `@ <sha>`, never between the counts and the `@`',
  );
  const parsed = parseReviewMarkerAny(written);
  assert.ok(parsed, 'the existing marker regex must still match a marker carrying the suffix');
  assert.equal(parsed.verdict, 'PASS');
  assert.equal(parsed.sha, sha);
  assert.equal(
    parsed.detail,
    'gpt-review f=11 v=3 adj=1',
    'detail itself must carry ONLY the provenance token — the suffix lives outside it now',
  );
});

// plan 3369 fix round 2 (7d51a1): mine-sonnet-lane-executor-telemetry.mjs's own `parseReviewMarker`
// is intentionally NOT exported (that file is out of this fix round's allowlist — "do not fix the
// parser, fix the marker").
//
// plan 3369 fix round 3 (b334d3): round 2 exercised it by regex-EXTRACTING its verbatim source
// out of the file and `new Function`-evaluating the result — a harmless formatting change, or
// even just a reflow of the function's own body, could break the `[\s\S]*?\n\}\n` extraction
// regex before this test ever ran a single assertion on marker BEHAVIOR, and that module still
// stays out of this fix round's allowlist so it cannot be given an exported seam to close the
// gap properly. This is an INLINE LITERAL COPY of that function instead — copied verbatim from
// scripts/mine-sonnet-lane-executor-telemetry.mjs lines 146–160 (`parseReviewMarker`) as of plan
// 3369 fix round 3. IT MUST BE KEPT IN SYNC BY HAND with that function; there is no structural
// link between the two copies any more — that is the deliberate trade for a harness that no
// longer breaks on an unrelated formatting change in a file this test cannot touch.
function realTelemetryParseReviewMarker(text) {
  // "Review: NITS:sonnet-review f=9 v=1 adj=0 @ sha"  or  "Review: PASS @ sha"  or bare "Review: BUGS-FOUND @ sha"
  const m = text.match(
    /^Review:\s*([A-Z-]+)(?::([a-z-]+))?(?:\s+f=(\d+)\s+v=(\d+)\s+adj=(\d+))?\s*@\s*([0-9a-f]+)/m,
  );
  if (!m) return null;
  return {
    verdict: m[1],
    method: m[2] || null,
    finders: m[3] ? Number(m[3]) : null,
    verifiers: m[4] ? Number(m[4]) : null,
    adjudicated: m[5] ? Number(m[5]) : null,
    sha: m[6],
  };
}

test('7d51a1: a narrowed marker still parses correctly through the REAL mine-sonnet-lane-executor-telemetry.mjs parser — verdict/method/counts/sha all come back, the round-1 regression is fixed', () => {
  const detail = buildReviewProvenance({
    method: 'gpt-review',
    finders: 11,
    verifiers: 3,
    adjudicated: 1,
  });
  const sha = 'a'.repeat(40);
  const base = upsertReviewMarker('', 'PASS', sha, detail);
  const fixed = appendMarkerScopeSuffix(base, ' scope-narrowed[excluded=4]');

  const parsedFixed = realTelemetryParseReviewMarker(fixed);
  assert.ok(parsedFixed, 'the telemetry parser must still match a scope-narrowed marker');
  assert.equal(parsedFixed.verdict, 'PASS');
  assert.equal(parsedFixed.method, 'gpt-review');
  assert.equal(parsedFixed.finders, 11);
  assert.equal(parsedFixed.verifiers, 3);
  assert.equal(parsedFixed.adjudicated, 1);
  assert.equal(parsedFixed.sha, sha);

  // Regression canary: round 1's composition (suffix folded INTO detail, before ` @ <sha>`)
  // must fail this same parser — documenting exactly what 7d51a1 flagged.
  const brokenOldStyle = upsertReviewMarker(
    '',
    'PASS',
    sha,
    detail + ' scope-narrowed[excluded=4]',
  );
  const parsedBroken = realTelemetryParseReviewMarker(brokenOldStyle);
  assert.ok(
    parsedBroken === null || parsedBroken.finders === null,
    'round-1’s composition (suffix before @) must NOT parse cleanly through the telemetry regex — ' +
      'this is the exact regression 7d51a1 reported',
  );
});

// ─── (5) 58023b/cb7bdb — a path-scoped git-diff failure clears stale artifacts ──

// Builds a `git` wrapper that transparently proxies to the REAL git for every call EXCEPT one
// whose argv contains `marker`, which it fails deterministically (exit 128) — so the run's
// UNSCOPED diff (no user pathspec, no marker) succeeds exactly as normal, and only the
// PATH-SCOPED diff (which carries `:(top,glob)<marker>...` from --paths) fails. This reproduces
// "applyPathScope's own git call throws" without depending on any git version's pathspec-error
// quirks. POSIX-only (shebang + chmod +x) — skipped on win32; the nightly Windows full-suite run
// is this repo's documented backstop for POSIX-only test-infra gaps (CLAUDE.md's platform-test
// rule targets faked OS BEHAVIOR under test, not this kind of subprocess-based test double).
function fakeGitFailingOn(marker) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  const fakeDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-fakegit-'));
  const script =
    '#!/usr/bin/env node\n' +
    "'use strict';\n" +
    "const { spawnSync } = require('child_process');\n" +
    'const REAL_GIT = process.env.FAKE_GIT_REAL_PATH;\n' +
    'const MARKER = process.env.FAKE_GIT_FAIL_MARKER;\n' +
    'const args = process.argv.slice(2);\n' +
    'if (MARKER && args.some((a) => a.includes(MARKER))) {\n' +
    "  process.stderr.write('fatal: simulated failure for test (FAKE_GIT_FAIL_MARKER)\\n');\n" +
    '  process.exit(128);\n' +
    '}\n' +
    'const res = spawnSync(REAL_GIT, args, { stdio: "inherit" });\n' +
    'process.exit(res.status == null ? 1 : res.status);\n';
  const gitPath = joinPath(fakeDir, 'git');
  writeFileSync(gitPath, script);
  chmodSync(gitPath, 0o755);
  return { fakeDir, realGit, marker };
}

test(
  'gpt-review (integration): a path-scoped git-diff failure clears stale review artifacts before exiting 2 (58023b/cb7bdb)',
  { skip: process.platform === 'win32' },
  () => {
    const dir = pathScopeRepo();
    const outDir = joinPath(dir, 'out');
    // A prior successful run's PASS-shaped stats.json, in the reused --out — this must not
    // survive the coming failure.
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      joinPath(outDir, 'stats.json'),
      JSON.stringify({
        stats: { finders: 11, candidates: 0, verifierAgents: 0, escalated: 0, reported: 0 },
      }),
    );
    writeFileSync(joinPath(outDir, 'findings.json'), '[]\n');

    const marker = 'FORCEFAILMARKER';
    const { fakeDir, realGit } = fakeGitFailingOn(marker);
    try {
      const res = spawnSync(
        process.execPath,
        [GPT_REVIEW_PATH, '--no-detach', '--paths', `${marker}/**`, '--out', outDir],
        {
          cwd: dir,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${fakeDir}:${process.env.PATH}`,
            FAKE_GIT_REAL_PATH: realGit,
            FAKE_GIT_FAIL_MARKER: marker,
          },
        },
      );
      assert.equal(
        res.status,
        2,
        `expected exit 2 (transport/operational failure); stderr: ${res.stderr}`,
      );
      assert.match(res.stderr, /path-scoped git diff failed/);
      assert.equal(
        existsSync(joinPath(outDir, 'stats.json')),
        false,
        'the stale stats.json must be cleared, not left for record-review to adopt as this run’s PASS',
      );
      assert.equal(existsSync(joinPath(outDir, 'findings.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
    }
  },
);

// ─── (6) b65c47/3e458e — announce/record a narrowed scope only when a file was actually dropped ──

test('buildScopeStatsField: droppedCount 0 -> {} (never a false "narrowed" record), droppedCount > 0 -> the scope object with THAT count', () => {
  const globs = { userPaths: ['scripts/**'], userExcludePaths: [], autoExcludedGlobs: [] };
  assert.deepEqual(buildScopeStatsField(0, globs), {});
  assert.deepEqual(buildScopeStatsField(-1, globs), {}, 'never negative either');
  assert.deepEqual(buildScopeStatsField(3, globs), {
    scope: {
      userPaths: ['scripts/**'],
      userExcludePaths: [],
      autoExcludedGlobs: [],
      excludedFileCount: 3,
    },
  });
});

test('buildScopeStatsField: a scope flag present (or the auto-budget layer merely firing) with ZERO files actually dropped stays {} — the false-narrowing class this fix closes', () => {
  // Mirrors the exact finding scenario: --paths matches every changed file (droppedCount 0)
  // despite the flag being present, or the auto-budget layer running but excluding nothing.
  assert.deepEqual(
    buildScopeStatsField(0, {
      userPaths: ['scripts/**'],
      userExcludePaths: [],
      autoExcludedGlobs: ['backend/src/data/seed'],
    }),
    {},
  );
});

// ─── (7) 1522de/46279f/4fd40f — defaultDataExcludeGlobsFor is DERIVED, not re-declared ──

test('defaultDataExcludeGlobsFor: derived from the caller-supplied excludes plus exactly the one genuinely-additive entry — no dead hand-copied entries', () => {
  const excludes = [...CORE_REVIEW_DIFF_EXCLUDES, 'backend/data', 'backend/src/data/seed'];
  const globs = defaultDataExcludeGlobsFor(excludes);
  assert.deepEqual(globs, [...excludes, '**/*.jsonl']);
  // Every excludes member must be present (the derivation, not a re-declared subset) — a
  // future member added there must reach here automatically.
  for (const ex of excludes) assert.ok(globs.includes(ex));
  // The dead, hand-copied entries the earlier version carried are GONE — they added no
  // coverage beyond the excludes list's own `backend/data`/`backend/src/data/seed` on this
  // repo's real layout.
  assert.ok(!globs.includes('**/render-store/**'));
  assert.ok(!globs.includes('**/render-fingerprints/**'));
});

// ─── (8) 0d4d1b — a failed finder's persisted diagnostic carries BOTH streams ──

test('callFinderAngle: a failure with an actionable explanation on STDOUT and only a generic message on stderr persists BOTH — never picks one stream and drops the other (0d4d1b)', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-stderr2-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  const f = { label: 'angle-A', text: 'x', kind: 'correctness' };
  const runCodexFn = async () => ({
    error: 'no output file (rc=1)',
    stderr: 'exit 1\n',
    stdout: 'THE ACTUAL DIAGNOSIS: schema validation failed on field X\n',
    wallS: 1,
  });
  const r = await callFinderAngle({
    ckpt,
    outDir,
    repoRoot: outDir,
    codexBin: 'codex',
    scopeBlock: 'SCOPE',
    files: [],
    f,
    runCodexFn,
  });
  assert.equal(r.error, 'no output file (rc=1)');
  const persisted = readFileSync(
    joinPath(outDir, FINDER_STDERR_DIRNAME, 'angle-A.stderr.txt'),
    'utf8',
  );
  assert.match(persisted, /exit 1/, 'stderr must still be present');
  assert.match(
    persisted,
    /THE ACTUAL DIAGNOSIS/,
    'stdout’s actionable explanation must ALSO be persisted, not dropped because stderr was non-empty',
  );
  rmSync(outDir, { recursive: true, force: true });
});

// ─── (F) b66790 — cap the retained failure diagnostics ──────────────────────
// Round 1 (0d4d1b, above) made a failed call retain FULL stdout+stderr, then duplicate them
// into both checkpoint.json (via callCached -> ckpt.set, rewritten in FULL on every later
// call, for every OTHER tag too) and the per-finder .stderr.txt. A verbose failure across
// several angles could produce multi-megabyte artifacts. Cap what is RETAINED for checkpoint
// persistence tightly (bounded head+tail); the per-finder file stays genuinely useful — bounded
// too, but generously — and the inline first-N-lines print (STDERR_INLINE_LINES) is untouched.

test('capDiagnosticText: text at or under the cap is returned unchanged; text over the cap is bounded head+tail with an explicit elision marker naming the omitted count', () => {
  const short = 'a short diagnostic\n';
  assert.equal(capDiagnosticText(short, 100), short);
  const exact = 'x'.repeat(100);
  assert.equal(capDiagnosticText(exact, 100), exact, 'exactly at the cap -> unchanged');

  const big = 'HEAD-MARKER-' + 'x'.repeat(10_000) + '-TAIL-MARKER';
  const capped = capDiagnosticText(big, 200);
  assert.ok(capped.length < big.length, 'must actually shrink an over-cap text');
  assert.match(capped, /elided \d+ chars/, 'must name how much was elided');
  assert.match(capped, /^HEAD-MARKER-/, 'the HEAD of the original text must survive');
  assert.match(capped, /-TAIL-MARKER$/, 'the TAIL of the original text must survive');
  const omittedMatch = capped.match(/elided (\d+) chars/);
  assert.equal(Number(omittedMatch[1]), big.length - 200, 'the elided count must be exact');
});

test('callCached: a huge failed-call diagnostic is capped in what gets PERSISTED to checkpoint.json, but the caller still receives the FULL uncapped result', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-diagcap-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  const ckpt = new Checkpoint(ckptPath);
  const hugeStdout = 'STDOUT-START-' + 'o'.repeat(2_000_000) + '-STDOUT-END';
  const hugeStderr = 'STDERR-START-' + 'e'.repeat(2_000_000) + '-STDERR-END';
  const result = await callCached(ckpt, 'finder:huge-fail', async () => ({
    error: 'boom',
    stdout: hugeStdout,
    stderr: hugeStderr,
    wallS: 1,
  }));
  // The immediate caller (callFinderAngle, in real usage) needs the FULL text to build its own
  // generously-capped per-finder file — callCached must not cap what it hands back.
  assert.equal(result.stdout, hugeStdout, 'the returned result is NOT capped');
  assert.equal(result.stderr, hugeStderr, 'the returned result is NOT capped');

  const onDiskBytes = readFileSync(ckptPath, 'utf8');
  assert.ok(
    onDiskBytes.length < 20_000,
    `checkpoint.json must stay small even after a multi-MB failed diagnostic — was ${onDiskBytes.length} bytes`,
  );
  const persisted = JSON.parse(onDiskBytes).calls['finder:huge-fail'];
  assert.match(persisted.stdout, /elided \d+ chars/);
  assert.match(persisted.stderr, /elided \d+ chars/);
  assert.match(persisted.stdout, /^STDOUT-START-/);
  assert.match(persisted.stdout, /-STDOUT-END$/);
  rmSync(outDir, { recursive: true, force: true });
});

test('callCached: a SMALL failed-call diagnostic is persisted byte-identical — capping only ever shrinks, never mutates a diagnostic already under the cap', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-diagcap-small-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  const ckpt = new Checkpoint(ckptPath);
  await callCached(ckpt, 'finder:small-fail', async () => ({
    error: 'boom',
    stdout: 'a small stdout\n',
    stderr: 'a small stderr\n',
    wallS: 1,
  }));
  const persisted = JSON.parse(readFileSync(ckptPath, 'utf8')).calls['finder:small-fail'];
  assert.equal(persisted.stdout, 'a small stdout\n');
  assert.equal(persisted.stderr, 'a small stderr\n');
  rmSync(outDir, { recursive: true, force: true });
});

test('persistFinderStderr: bounded GENEROUSLY — a moderately large diagnostic survives in full, only a truly huge one is elided (and says so)', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-finderfile-cap-'));
  // Moderately large (bigger than the tight checkpoint cap, well under the generous file cap):
  // the per-finder file is a human-facing artifact and must stay genuinely useful.
  const moderate = 'M'.repeat(50_000);
  const file1 = persistFinderStderr(outDir, 'angle-A', moderate);
  assert.equal(
    readFileSync(file1, 'utf8'),
    moderate,
    'a moderately large diagnostic is kept whole',
  );

  const huge = 'HEAD-' + 'H'.repeat(5_000_000) + '-TAIL';
  const file2 = persistFinderStderr(outDir, 'angle-B', huge);
  const persisted = readFileSync(file2, 'utf8');
  assert.ok(persisted.length < huge.length, 'a truly huge diagnostic must still be bounded');
  assert.ok(
    persisted.length > moderate.length,
    'the file cap must be materially more generous than the checkpoint cap',
  );
  assert.match(persisted, /elided \d+ chars/, 'elision must be stated in the file itself');
  rmSync(outDir, { recursive: true, force: true });
});

test('callFinderAngle (integration): a huge failed diagnostic keeps checkpoint.json small while the per-finder file stays generously useful (b66790)', async () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-finderangle-cap-'));
  const ckpt = new Checkpoint(joinPath(outDir, 'checkpoint.json'));
  const f = { label: 'angle-A', text: 'x', kind: 'correctness' };
  // Newline-broken (unlike a single giant run) so the UNCHANGED inline STDERR_INLINE_LINES
  // print stays a bounded ~20 lines rather than one multi-hundred-KB console line.
  const hugeStdout = 'STDOUT-' + Array(6000).fill('o'.repeat(50)).join('\n');
  const runCodexFn = async () => ({
    error: 'no output file (rc=1)',
    stderr: 'exit 1\n',
    stdout: hugeStdout,
    wallS: 1,
  });
  const origLog = console.log;
  console.log = () => {};
  let r;
  try {
    r = await callFinderAngle({
      ckpt,
      outDir,
      repoRoot: outDir,
      codexBin: 'codex',
      scopeBlock: 'SCOPE',
      files: [],
      f,
      runCodexFn,
    });
  } finally {
    console.log = origLog;
  }
  assert.equal(r.error, 'no output file (rc=1)');
  const persistedFile = readFileSync(
    joinPath(outDir, FINDER_STDERR_DIRNAME, 'angle-A.stderr.txt'),
    'utf8',
  );
  assert.ok(
    persistedFile.length > 100_000,
    'the per-finder file stays genuinely useful (generous cap), not shrunk to the tiny checkpoint cap',
  );
  const ckptBytes = readFileSync(joinPath(outDir, 'checkpoint.json'), 'utf8');
  assert.ok(
    ckptBytes.length < 20_000,
    `checkpoint.json must stay small regardless of how large the diagnostic was — was ${ckptBytes.length} bytes`,
  );
  rmSync(outDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// plan 3369 FIX ROUND 3 — delta /gpt-review findings over fix round 2.
// ═══════════════════════════════════════════════════════════════════════════

// ─── (B) cc13c0 — a fingerprint MISMATCH must clear the prior run's artifacts too ───────────
//
// bindFingerprint's mismatch branch discards the cached CALLS (this.data = {calls:{}}) but,
// before this fix, left stats.json/findings.json/summary.md from the PRIOR (different-identity)
// run sitting in the same --out. A resumed run that then exits 2 (a finder/transport failure)
// writes no new stats.json — so record-review could adopt that stale, PASS-shaped one and stamp
// a PASS for a review that, for THIS identity, never actually ran. A mismatch means resume is
// impossible anyway (every cached call is already being thrown away), so the artifact clear
// belongs in the same branch. Deliberately NOT exercised on the `unknownIdentity` (legacy,
// no-fingerprint) branch or on a MATCHING fingerprint — see the boundary test below.
test('Checkpoint.bindFingerprint: a MISMATCHED fingerprint clears stats.json/findings.json/summary.md from the prior identity, not just the cached calls (round 3, item B / cc13c0)', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-fp-mismatch-clear-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  const fpA = reviewIdentityFingerprint({ rangeLabel: 'a..b', paths: ['scripts/**'] });
  const fpB = reviewIdentityFingerprint({ rangeLabel: 'a..b', paths: ['backend/**'] });

  const first = new Checkpoint(ckptPath);
  first.set('finder:angle-A', { data: { candidates: [] }, tokens: 5, wallS: 1 });
  first.bindFingerprint(fpA);
  // A PRIOR run for identity fpA finished clean and left a pass-shaped stats.json/findings.json/
  // summary.md next to the checkpoint — exactly what a reused `--out` looks like.
  writeFileSync(joinPath(outDir, 'stats.json'), '{"stats":{"finders":11}}\n');
  writeFileSync(joinPath(outDir, 'findings.json'), '[]\n');
  writeFileSync(joinPath(outDir, 'summary.md'), '# gpt-review — PASS\n');
  writeFileSync(joinPath(outDir, 'diff.patch'), 'diff --git a/x b/x\n');

  const resumeDifferent = new Checkpoint(ckptPath);
  const logs = [];
  const origLog = console.log;
  console.log = (m) => logs.push(m);
  try {
    resumeDifferent.bindFingerprint(fpB); // a DIFFERENT identity — mismatch
  } finally {
    console.log = origLog;
  }
  for (const name of ['stats.json', 'findings.json', 'summary.md']) {
    assert.equal(
      existsSync(joinPath(outDir, name)),
      false,
      `${name} from the prior (mismatched) identity must not survive — a later exit-2 run could ` +
        `have record-review adopt it as this identity's PASS`,
    );
  }
  // …but diff.patch is THIS run's own, already materialized before the bind — see the
  // simplification note on IDENTITY_RESET_STALE_ARTIFACTS.
  assert.ok(
    existsSync(joinPath(outDir, 'diff.patch')),
    'diff.patch belongs to the CURRENT run (main() materializes it before bindFingerprint) — ' +
      'the identity reset must never delete the very patch this run is about to review',
  );
  rmSync(outDir, { recursive: true, force: true });
});

// The mirror of the test above, on the OTHER identity-reset branch. Round 3 scoped the artifact
// clear to `mismatched` only; the round-3 delta re-review then raised the same false-PASS risk
// against `unknownIdentity` from four independent angles (40ff5d / 89b503 / 4de673 / 7bb04d),
// and it is the same risk for the same reason: a legacy checkpoint's cached calls are discarded
// too, so a later exit-2 leaves the PRIOR run's pass-shaped stats.json standing for
// record-review to adopt. One branch, one behaviour.
test('Checkpoint.bindFingerprint: an UNKNOWN-identity (legacy, no-fingerprint) checkpoint clears the prior verdict artifacts too, and still keeps this run’s diff.patch', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-fp-legacy-clear-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  // A pre-fingerprint checkpoint: real cached calls, no `fingerprint` key at all.
  writeFileSync(
    ckptPath,
    JSON.stringify({ calls: { 'finder:angle-A': { data: { candidates: [] } } } }) + '\n',
  );
  writeFileSync(joinPath(outDir, 'stats.json'), '{"stats":{"finders":11}}\n');
  writeFileSync(joinPath(outDir, 'findings.json'), '[]\n');
  writeFileSync(joinPath(outDir, 'summary.md'), '# gpt-review — PASS\n');
  writeFileSync(joinPath(outDir, 'diff.patch'), 'diff --git a/x b/x\n');

  const resume = new Checkpoint(ckptPath);
  const logs = [];
  const origLog = console.log;
  console.log = (m) => logs.push(m);
  try {
    resume.bindFingerprint(reviewIdentityFingerprint({ rangeLabel: 'a..b' }));
  } finally {
    console.log = origLog;
  }
  for (const name of ['stats.json', 'findings.json', 'summary.md']) {
    assert.equal(
      existsSync(joinPath(outDir, name)),
      false,
      `${name} from the unknown prior identity must not survive — same false-PASS risk as a mismatch`,
    );
  }
  assert.ok(
    existsSync(joinPath(outDir, 'diff.patch')),
    "diff.patch is the CURRENT run's own — an identity reset must not delete it",
  );
  rmSync(outDir, { recursive: true, force: true });
});
// The identity reset's OTHER half, and the one that cost six dead review rounds on 2026-08-25
// (plans 3450 + 3451; infra-debt `gpt-review-identity-reset-deletes-raw-dir-and-never-recreates-it`).
// `raw/` is not merely an artifact to discard: it is the DIRECTORY every subsequent codex call
// writes its `--output-schema` result into, and main()'s only `mkdirSync(join(outDir,'raw'))`
// already ran BEFORE the bind. So clearing the directory without recreating it left every finder
// after the reset writing into a path that no longer existed — and codex reports that as
// `Failed to write last message file …(os error 3)` while still exiting 0, so the runner saw
// `no output file (rc=0)` on all 11 finders and produced a zero-finding, pass-shaped review.
// Silent, and repeated on every resume whose fingerprint had moved again.
//
// The contract this test pins: the reset removes the prior identity's CONTENT but leaves the
// directories themselves ready to be written into.
test('Checkpoint.bindFingerprint: an identity reset empties raw/ + finders/ but leaves them as writable directories — the codex calls that follow write straight into raw/ and main() already mkdir-ed it before the bind', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-fp-raw-dir-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  const fpA = reviewIdentityFingerprint({ rangeLabel: 'a..b', paths: ['scripts/**'] });
  const fpB = reviewIdentityFingerprint({ rangeLabel: 'a..b', paths: ['backend/**'] });

  const first = new Checkpoint(ckptPath);
  first.bindFingerprint(fpA);
  // main() creates `raw/` up front, then the PRIOR identity's calls fill it.
  mkdirSync(joinPath(outDir, 'raw'), { recursive: true });
  mkdirSync(joinPath(outDir, FINDER_STDERR_DIRNAME), { recursive: true });
  writeFileSync(joinPath(outDir, 'raw', 'finder_angle-A.json'), '{"candidates":[]}\n');
  writeFileSync(joinPath(outDir, FINDER_STDERR_DIRNAME, 'angle-A.stderr.txt'), 'stale\n');

  const resumeDifferent = new Checkpoint(ckptPath);
  const origLog = console.log;
  console.log = () => {};
  try {
    resumeDifferent.bindFingerprint(fpB); // a DIFFERENT identity — mismatch, so the reset fires
  } finally {
    console.log = origLog;
  }

  for (const name of ['raw', FINDER_STDERR_DIRNAME]) {
    assert.ok(
      existsSync(joinPath(outDir, name)),
      `${name}/ must survive the identity reset AS A DIRECTORY — codex does not create the ` +
        `parent of its --output-schema target and swallows the write failure with rc=0, so a ` +
        `missing ${name}/ turns every finder after the reset into a silent no-output failure`,
    );
    assert.ok(
      statSync(joinPath(outDir, name)).isDirectory(),
      `${name}/ must be a directory, not a file left behind by the clear`,
    );
    assert.deepEqual(
      readdirSync(joinPath(outDir, name)),
      [],
      `${name}/ must be EMPTIED of the prior identity's output — the point of the reset`,
    );
  }
  rmSync(outDir, { recursive: true, force: true });
});

// The boundary this fix must NOT cross: a MATCHING fingerprint (a genuine resume) must leave a
// prior stats.json alone — clearing here would be wrong (nothing changed identity) and is not
// what cc13c0 asked for.
test('Checkpoint.bindFingerprint: a MATCHING fingerprint on reopen does NOT clear stats.json — only a mismatch does (round 3, item B boundary)', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-fp-match-noclear-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  const fpA = reviewIdentityFingerprint({ rangeLabel: 'a..b', paths: ['scripts/**'] });

  const first = new Checkpoint(ckptPath);
  first.bindFingerprint(fpA);
  writeFileSync(joinPath(outDir, 'stats.json'), '{"stats":{"finders":11}}\n');

  const resumeSame = new Checkpoint(ckptPath);
  resumeSame.bindFingerprint(fpA); // SAME identity — not a mismatch
  assert.ok(
    existsSync(joinPath(outDir, 'stats.json')),
    'a matching fingerprint is a genuine resume, not an identity change — stats.json must survive',
  );
  rmSync(outDir, { recursive: true, force: true });
});

// ─── (D) 6b3b47/f3ffa5 — fingerprint the diff SNAPSHOT actually materialized ────────────────
//
// For an explicit mutable range (`HEAD~1..HEAD`, `origin/master...HEAD`), diff.patch is written
// FIRST and resolveDiffTargetShas runs LATER — a ref can advance in between (another commit
// landing, the landed-range guard's own `git fetch`), so the checkpoint could be stamped with
// the NEWER endpoint shas while its cached results describe the OLDER patch that was actually
// read. A later run reviewing the genuinely-new range for real could then see a MATCHING
// fingerprint (same rangeLabel, same resolvedShas — the ref only moved once) and wrongly reuse
// results that describe a different diff entirely.
//
// Fix chosen: fold a digest of the materialized diff.patch bytes into the fingerprint, rather
// than moving the resolveDiffTargetShas call earlier in main()'s control flow. Reordering would
// mean resolving shas BEFORE the diff (and the landed-range guard's fetch) exist, which the
// existing comments mark as deliberately untouched territory for the explicit-range path
// (histNote's wording / the --end-ref historical path, plan 2936) — binding the identity to the
// bytes actually read is a strictly smaller, additive change that needs no reordering at all.
test('reviewIdentityFingerprint: changes with diffDigest — the snapshot actually materialized is part of the identity, independent of rangeLabel/resolvedShas (round 3, item D / 6b3b47, f3ffa5)', () => {
  const base = {
    rangeLabel: 'origin/master...HEAD',
    resolvedShas: ['aaa', 'bbb'],
    diffDigest: createHash('sha256').update('diff --git a/x b/x\n+old\n').digest('hex'),
  };
  const fp1 = reviewIdentityFingerprint(base);
  assert.equal(reviewIdentityFingerprint({ ...base }), fp1, 'stable for identical inputs');
  const fp2 = reviewIdentityFingerprint({
    ...base,
    diffDigest: createHash('sha256').update('diff --git a/x b/x\n+new\n').digest('hex'),
  });
  assert.notEqual(
    fp2,
    fp1,
    'a DIFFERENT materialized patch must change the fingerprint even when rangeLabel and ' +
      'resolvedShas are byte-identical — exactly the writeScopedPatch-then-resolve race',
  );
});

test('reviewIdentityFingerprint + Checkpoint.bindFingerprint: a checkpoint whose cached calls describe an OLDER patch is discarded on resume, even though a moved-then-settled ref made rangeLabel/resolvedShas coincide (round 3, item D)', () => {
  const outDir = mkdtempSync(joinPath(tmpdir(), 'gptrev-diffdigest-ckpt-'));
  const ckptPath = joinPath(outDir, 'checkpoint.json');
  const digest = (text) => createHash('sha256').update(text).digest('hex');

  // A corrupted run: diff.patch was materialized for C1..C2, but by the time
  // resolveDiffTargetShas ran the ref had already advanced, so the checkpoint got stamped with
  // shas that (as far as this test is concerned) look identical to a LEGITIMATE later C2..C3
  // review's own resolved shas — the exact coincidence the old rangeLabel+resolvedShas-only
  // fingerprint could not tell apart.
  const sharedRangeLabel = 'origin/master...HEAD';
  const sharedResolvedShas = ['deadbeef', 'cafef00d'];
  const corruptedFp = reviewIdentityFingerprint({
    rangeLabel: sharedRangeLabel,
    resolvedShas: sharedResolvedShas,
    diffDigest: digest('diff --git a/x b/x\n+content-from-C1..C2\n'),
  });
  const corrupted = new Checkpoint(ckptPath);
  corrupted.set('finder:angle-A', { data: { candidates: [{ file: 'x', line: 1 }] }, tokens: 5 });
  corrupted.bindFingerprint(corruptedFp);

  // The LEGITIMATE run: same rangeLabel, same resolvedShas (the coincidence), but the diff.patch
  // it actually read describes DIFFERENT content (C2..C3, not C1..C2).
  const legitimateFp = reviewIdentityFingerprint({
    rangeLabel: sharedRangeLabel,
    resolvedShas: sharedResolvedShas,
    diffDigest: digest('diff --git a/x b/x\n+content-from-C2..C3\n'),
  });
  const resumed = new Checkpoint(ckptPath);
  const logs = [];
  const origLog = console.log;
  console.log = (m) => logs.push(m);
  try {
    resumed.bindFingerprint(legitimateFp);
  } finally {
    console.log = origLog;
  }
  assert.equal(
    resumed.get('finder:angle-A'),
    null,
    'the corrupted run’s cached result (computed over the WRONG patch) must not be reused just ' +
      'because rangeLabel and resolvedShas happen to match',
  );
  assert.ok(logs.some((m) => /different range\/path-scope identity/.test(m)));
  rmSync(outDir, { recursive: true, force: true });
});

// ─── (F) 990944 — scope must be part of the re-record identity ─────────────────────────────
//
// record-review.mjs's identicalReRecord compared only the parsed provenance `detail` — never
// the scope-narrowed[...] suffix appendMarkerScopeSuffix writes AFTER `@ <sha>` (outside the
// detail group entirely, by round 2's own 7d51a1 design). A same-sha re-record that flips
// narrowed->full (or the reverse) therefore read as "identical" and short-circuited straight to
// the re-pin path, leaving a FALSE scope annotation standing on the persisted marker forever.
// markerLineScopeSuffix/recordedScopeSuffix are the pure seam identicalReRecord now calls —
// tested here directly, the same way describeReviewScope/appendMarkerScopeSuffix already are.
const SHA_A = 'a'.repeat(40);

test('markerLineScopeSuffix: extracts the trailing scope-narrowed[...] token from the REAL marker line shape (upsertMarker + appendMarkerScopeSuffix), keyed to the given sha', () => {
  const detail = buildReviewProvenance({ method: 'gpt-review', finders: 9, verifiers: 1 });
  const base = upsertReviewMarker('some prior prose\n', 'PASS', SHA_A, detail);
  const withSuffix = appendMarkerScopeSuffix(base, ' scope-narrowed[excluded=3]');
  assert.equal(markerLineScopeSuffix(withSuffix, SHA_A), 'scope-narrowed[excluded=3]');
});

// 103209 / 4b0e38 (round-3 delta re-review): when a session entry carries MORE THAN ONE marker
// line for the same sha, the shared parser (done-worktree-lib.mjs's parseMarkerAny) keeps the
// LAST match — it loops `matchAll` into `last`. markerLineScopeSuffix used a non-global `exec`,
// i.e. the FIRST. So the scope this reads could belong to a different marker line than the one
// every other consumer resolves, and identicalReRecord would compare a scope the record does not
// actually carry. Same content, same sha: the two must agree on WHICH line wins.
test('markerLineScopeSuffix: with two marker lines for the same sha it reads the LAST one, matching parseMarkerAny (103209/4b0e38)', () => {
  const detail = buildReviewProvenance({ method: 'gpt-review', finders: 9, verifiers: 1 });
  const first = appendMarkerScopeSuffix(
    upsertReviewMarker('', 'PASS', SHA_A, detail),
    ' scope-narrowed[excluded=3]',
  );
  // A second, LATER marker for the same sha — the un-narrowed one the shared parser would pick.
  const both = `${first.trimEnd()}\nReview: PASS:gpt-review f=9 v=1 adj=0 @ ${SHA_A}\n`;
  assert.equal(
    markerLineScopeSuffix(both, SHA_A),
    '',
    'the LAST marker line for this sha carries no scope suffix — reading the first one would ' +
      'report a narrowing the record the shared parser resolves does not claim',
  );
});

test('markerLineScopeSuffix: an UN-narrowed marker (no suffix appended) reports "" — found, but nothing to report — never null', () => {
  const detail = buildReviewProvenance({ method: 'gpt-review', finders: 9, verifiers: 1 });
  const base = upsertReviewMarker('', 'PASS', SHA_A, detail);
  assert.equal(markerLineScopeSuffix(base, SHA_A), '');
});

test('markerLineScopeSuffix: no marker line for the given sha in this content -> null (a different sha, or no marker at all)', () => {
  const detail = buildReviewProvenance({ method: 'gpt-review', finders: 9, verifiers: 1 });
  const base = upsertReviewMarker('', 'PASS', SHA_A, detail);
  assert.equal(markerLineScopeSuffix(base, 'b'.repeat(40)), null);
  assert.equal(markerLineScopeSuffix('no marker here at all\n', SHA_A), null);
});

test('recordedScopeSuffix: walks candidates in order and returns the first one that actually contains this sha\'s marker line (mirrors pickFreshestMarker\'s own "first candidate wins")', () => {
  const detail = buildReviewProvenance({ method: 'gpt-review', finders: 9, verifiers: 1 });
  const narrowed = appendMarkerScopeSuffix(
    upsertReviewMarker('', 'PASS', SHA_A, detail),
    ' scope-narrowed[excluded=2]',
  );
  const noMarkerHere = 'stale prose with no review marker\n';
  assert.equal(recordedScopeSuffix([noMarkerHere, narrowed], SHA_A), 'scope-narrowed[excluded=2]');
  assert.equal(recordedScopeSuffix([narrowed, noMarkerHere], SHA_A), 'scope-narrowed[excluded=2]');
});

test('recordedScopeSuffix: returns null (never a false "no scope") when NO candidate carries this sha\'s marker line', () => {
  assert.equal(recordedScopeSuffix(['prose one\n', 'prose two\n'], SHA_A), null);
});

// ─── plan 3451: identity-reset raw/ recreation ──────────────────────────────
// Measured live 2026-08-25: clearStaleReviewArtifactsForIdentityReset runs MID-RUN (unlike its
// exit-path twin clearStaleReviewArtifacts) and the run then carries on — every finder
// dispatched after the reset tried to write its result into a now-deleted `raw/` and died with
// an ENOENT, reporting real work as "finder failed". This pins that the mid-run variant
// recreates every EMPTY_RANGE_STALE_DIRS entry (writable, not just present) while its exit-path
// twin leaves them gone, and that both variants still preserve the deliberate diff.patch
// exception.
function seedStaleOutDir() {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gpt-review-stale-out-'));
  for (const name of EMPTY_RANGE_STALE_ARTIFACTS) {
    writeFileSync(joinPath(dir, name), 'stale-' + name);
  }
  for (const name of EMPTY_RANGE_STALE_DIRS) {
    mkdirSync(joinPath(dir, name), { recursive: true });
    writeFileSync(joinPath(dir, name, 'stale-file.json'), 'stale');
  }
  return dir;
}

test('clearStaleReviewArtifactsForIdentityReset: recreates every EMPTY_RANGE_STALE_DIRS entry, writable, after clearing stale contents', () => {
  const dir = seedStaleOutDir();
  try {
    clearStaleReviewArtifactsForIdentityReset(dir);
    for (const name of EMPTY_RANGE_STALE_DIRS) {
      const dirPath = joinPath(dir, name);
      assert.ok(existsSync(dirPath), `${name}/ must exist again after an identity reset`);
      assert.equal(
        existsSync(joinPath(dirPath, 'stale-file.json')),
        false,
        `${name}/ must be emptied of the prior identity's stale contents`,
      );
      // The regression: a directory that "exists" per existsSync but was never actually
      // recreated (e.g. a no-op that merely skipped the rmSync) would still fail here — the
      // write is what the finders in the live incident could not do.
      const probePath = joinPath(dirPath, 'finder_probe.json');
      writeFileSync(probePath, '{}');
      assert.equal(existsSync(probePath), true, `${name}/ must be writable, not just present`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearStaleReviewArtifactsForIdentityReset: diff.patch survives (the deliberate exception — the current run already materialized it)', () => {
  const dir = seedStaleOutDir();
  try {
    clearStaleReviewArtifactsForIdentityReset(dir);
    assert.equal(readFileSync(joinPath(dir, 'diff.patch'), 'utf8'), 'stale-diff.patch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearStaleReviewArtifacts (exit path): leaves EMPTY_RANGE_STALE_DIRS entries GONE — no recreation, unlike the identity-reset variant', () => {
  const dir = seedStaleOutDir();
  try {
    clearStaleReviewArtifacts(dir);
    for (const name of EMPTY_RANGE_STALE_DIRS) {
      assert.equal(
        existsSync(joinPath(dir, name)),
        false,
        `${name}/ must stay gone — the exit path is about to process.exit, nothing reads it again`,
      );
    }
    assert.equal(existsSync(joinPath(dir, 'diff.patch')), false, 'the exit path has no exception');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── plan 3637: runCodex must not return a non-zero exit as a success ─────────────
// The header's "no codex subprocess is spawned" contract stands for the REAL codex
// transport, and these keep it: the child is a short node stand-in this file writes
// itself. It is not a mock of runCodex asserting itself — runCodex runs unmodified,
// spawning, piping the prompt, arming the timeout and reading the -o file for real;
// only the process on the other end is controlled, which is the ONLY way to drive
// "exited non-zero AFTER writing a valid-JSON answer" deterministically.
//
// CROSS-PLATFORM BY CONSTRUCTION — no shebang, no chmod, no `.cmd` shim, no
// `skip: win32` (review round 1, findings 59c2d8 (blocking) / d21742). runCodex builds
// its own argv starting with the literal `exec` and spawns `codexBin` with it, so
// handing it `codexBin = process.execPath` and a cwd containing a FILE NAMED `exec`
// makes the child `node exec -m … -o <out> -` — node runs that file as CommonJS
// (no extension) with the rest as argv. The fake-git helpers above use the POSIX
// shebang+chmod route and are skipped on Windows for it; this one needs neither, so
// the gate it covers is exercised on every platform the suite runs on rather than
// leaning on the nightly Windows backstop.
function fakeCodexDir({
  exitCode,
  writeOutput,
  killSelf = false,
  // plan 4019: an injectable stderr line, defaulting to the pre-existing text so every
  // call site above is byte-for-byte unaffected — this only ADDS a way for a new caller to
  // drive runCodex's failure-classification fold with specific transcript text.
  stderrText = 'fake codex: deliberate probe failure\n',
}) {
  const dir = mkdtempSync(joinPath(tmpdir(), 'gptrev-fakecodex-'));
  const script =
    "'use strict';\n" +
    // Drain stdin: runCodex writes the prompt there, and a child that exits without
    // reading it makes the parent see EPIPE — a different failure than the one under test.
    "process.stdin.resume();\nprocess.stdin.on('data', () => {});\n" +
    'const args = process.argv.slice(2);\n' +
    "const out = args[args.indexOf('-o') + 1];\n" +
    `if (${JSON.stringify(!!writeOutput)}) {\n` +
    // Valid JSON, correctly shaped for the candidates schema — "incomplete" only in the
    // sense the plan means: whatever the child managed to emit before failing.
    "  require('fs').writeFileSync(out, JSON.stringify({ candidates: [{ title: 'partial' }] }));\n" +
    '}\n' +
    `process.stderr.write(${JSON.stringify(stderrText)});\n` +
    (killSelf
      ? // A REAL signal death, so waitForExit sees Node's (code=null, signal) close rather
        // than a number. POSIX only, and that is why its one test is skipped on win32:
        // Windows has no signals — `process.kill(pid, 'SIGKILL')` there is TerminateProcess,
        // which the parent reads as an ordinary numeric exit, so the branch under test is
        // genuinely unreachable rather than merely awkward to reach.
        "process.kill(process.pid, 'SIGKILL');\n"
      : `process.exit(${Number(exitCode)});\n`);
  // The name is load-bearing: it is runCodex's own first argv element.
  writeFileSync(joinPath(dir, 'exec'), script);
  writeFileSync(joinPath(dir, 'schema.json'), JSON.stringify({ type: 'object' }));
  return dir;
}

async function runFakeCodex({
  exitCode,
  writeOutput,
  killSelf = false,
  codexBin = process.execPath,
  stderrText,
}) {
  const dir = fakeCodexDir({ exitCode, writeOutput, killSelf, stderrText });
  try {
    return await runCodex({
      codexBin,
      model: 'fake-model',
      prompt: 'probe',
      schemaPath: joinPath(dir, 'schema.json'),
      outFile: joinPath(dir, 'out.json'),
      cwd: dir,
      // These fake children exit near-instantly; the liveness probe is not what
      // this harness is testing (armLivenessProbe has its own direct tests
      // below), so disable it — the seam a falsy `liveness` opts into.
      liveness: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// console.log is what log() writes to, and the exit-log line is the whole point of two
// of the cases below — there is no other seam to observe it through.
async function captureLog(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = real;
  }
}

test('runCodex: a non-zero exit that DID leave valid JSON is an error, never a success (the plan-3637 pass-shaped review)', async () => {
  const r = await runFakeCodex({ exitCode: 1, writeOutput: true });
  assert.equal(
    r.data,
    undefined,
    'the parsed payload must NOT be handed back — callCachedArray would checkpoint it as final and verifyOnce would settle verdicts from it',
  );
  assert.equal(r.error, 'exit 1');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /deliberate probe failure/, 'the child diagnostic must survive');
});

test('runCodex: exit 2 with valid JSON is likewise an error (the rule is code !== 0, not a single-code special case)', async () => {
  const r = await runFakeCodex({ exitCode: 2, writeOutput: true });
  assert.equal(r.data, undefined);
  assert.equal(r.error, 'exit 2');
  assert.equal(r.code, 2);
});

test('runCodex: exit 0 with valid JSON is STILL a success — the gate fails closed on failure, not on everything (measured: every benign non-fatal codex condition exits 0)', async () => {
  const r = await runFakeCodex({ exitCode: 0, writeOutput: true });
  assert.equal(r.error, undefined);
  assert.equal(r.code, 0);
  assert.deepEqual(r.data, { candidates: [{ title: 'partial' }] });
});

test('runCodex: a non-zero exit with NO output file and no recognizable marker keeps the bare "no output file (rc=N)" message (generic transport class does not decorate it, and every existing exact-match caller depends on that string)', async () => {
  const r = await runFakeCodex({ exitCode: 1, writeOutput: false });
  assert.equal(r.error, 'no output file (rc=1)');
  assert.equal(r.code, 1);
  assert.equal(r.failureClass, 'transport');
});

// plan 4019 fix round 1, G1 (findings fa2c93/5c2bd1/2bcec7/556147/c9f9eb — five review angles, one
// root cause): the no-output shape is the PRIMARY failure this classifier exists for — measured,
// every rc=1 401/usage-limit failure in the 3982 incident produced no output file at all — but the
// classifier was originally wired ONLY into the later `code !== 0` branch, which this early return
// never reaches. This is exactly the shape that incident hit: classification must run here too,
// and the existing informative message must survive with the class appended, not replaced.
test('runCodex: a usage-limit failure with NO output file (the actual plan-3982 shape) is still classified — the "no output file" message keeps its rc= wording AND gets the class suffix (fix round 1, G1)', async () => {
  const r = await runFakeCodex({
    exitCode: 1,
    writeOutput: false,
    stderrText:
      "ERROR: You've hit your usage limit. Upgrade to Plus to continue using Codex or " +
      'try again at Oct 14th, 2026 11:21 AM.\n',
  });
  assert.equal(r.failureClass, 'usage-limit');
  assert.equal(r.failureClassReportedResetAt, 'Oct 14th, 2026 11:21 AM');
  assert.equal(
    r.error,
    'no output file (rc=1) [usage-limit, reported reset Oct 14th, 2026 11:21 AM]',
  );
});

test('runCodex: a token-rotten failure with NO output file is classified the same way (fix round 1, G1)', async () => {
  const r = await runFakeCodex({
    exitCode: 1,
    writeOutput: false,
    stderrText: 'stream error: 401 Unauthorized\n',
  });
  assert.equal(r.failureClass, 'token-rotten');
  assert.equal(r.error, 'no output file (rc=1) [token-rotten]');
});

test('runCodex: exit 0 with NO output file is the known-benign shape (measured: `-o` into a nonexistent directory) and is NOT classified — classifying a clean exit would be meaningless', async () => {
  const r = await runFakeCodex({ exitCode: 0, writeOutput: false });
  assert.equal(r.error, 'no output file (rc=0)');
  assert.equal(r.failureClass, undefined);
  assert.equal(r.failureClassReportedResetAt, undefined);
});

// plan 4019: the failure-classification fold, driven through runCodex end to end rather than
// through codexFailureClass alone — this is what proves the class actually reaches the string
// callFinderAngle logs and the finderErrors summary reports, not just the classifier's own unit.
test('runCodex: a usage-limit stderr (the real plan-3982 phrasing) is classified and the REPORTED reset date is folded into `error` — never as an authoritative schedule (measured 2026-09-14: the same "try again at Oct 14th" session was usable again the same afternoon)', async () => {
  const r = await runFakeCodex({
    exitCode: 1,
    writeOutput: true,
    stderrText:
      "ERROR: You've hit your usage limit. Upgrade to Plus to continue using Codex or " +
      'try again at Oct 14th, 2026 11:21 AM.\n',
  });
  assert.equal(r.failureClass, 'usage-limit');
  assert.equal(r.failureClassReportedResetAt, 'Oct 14th, 2026 11:21 AM');
  assert.equal(r.error, 'exit 1 [usage-limit, reported reset Oct 14th, 2026 11:21 AM]');
});

test('runCodex: a token-rotten stderr (401 / refresh_token_reused) is classified and named in `error`', async () => {
  const r = await runFakeCodex({
    exitCode: 1,
    writeOutput: true,
    stderrText: 'stream error: 401 Unauthorized\n',
  });
  assert.equal(r.failureClass, 'token-rotten');
  assert.equal(r.error, 'exit 1 [token-rotten]');
});

test('runCodex: an ordinary failure classifies as the generic `transport` class but leaves `error` UNCHANGED (every existing exact-match caller depends on the bare "exit N" string)', async () => {
  const r = await runFakeCodex({ exitCode: 1, writeOutput: true });
  assert.equal(r.failureClass, 'transport');
  assert.equal(r.error, 'exit 1');
});

// Review round 1, findings 845458/ac65a4/45ab22/4c4b58/883e81/79c886/ebd813/7a9483 —
// eight angles on one root cause: the exit log fired on a bare `code !== 0`, before the
// spawn-error branch, so a missing binary reported itself as a signal death.
test('runCodex: an async spawn failure is NOT logged as a signal death (waitForExit reports code null for a missing binary too)', async () => {
  const missing = joinPath(tmpdir(), `gptrev-no-such-codex-${process.pid}`);
  const { result, lines } = await captureLog(() =>
    runFakeCodex({ exitCode: 0, writeOutput: false, codexBin: missing }),
  );
  assert.match(result.error, /^spawn: /, 'the real cause must be the returned error');
  assert.equal(result.code, null);
  assert.equal(
    lines.some((l) => /killed by signal/.test(l)),
    false,
    'a process that never started must not be announced as killed by a signal — that sends the reader after an OOM killer',
  );
});

// Review round 1, findings 117e00/6eb952/fabdc8/ba25d3/a54e23/0676f1 — six angles: the
// sibling message interpolated the raw code, so a signal death read as `rc=null` in the
// branch a killed child is most likely to reach, and callFinderAngle persisted it.
test('describeExit: a signal death renders as such in every slot that uses it, never as the bare "null" a reader misfiles as a missing value', () => {
  assert.equal(describeExit(null), 'null — killed by signal');
  assert.equal(describeExit(undefined), 'null — killed by signal');
  assert.equal(describeExit(0), '0');
  assert.equal(describeExit(1), '1');
  assert.equal(describeExit(2), '2');
  // Round 2, finding 566a47: this test used to also "pin the call sites" by rebuilding
  // each message from describeExit on BOTH sides of the assertion, which proves the
  // renderer's phrasing but NOT that production still calls it — a regression back to a
  // raw `rc=${code}` would have kept it green. The production renderings are pinned by
  // tests that actually invoke runCodex instead: `exit 1` / `exit 2` and
  // `no output file (rc=1)` above, and the real signal death below.
});

// Round 2, finding 566a47: the PRODUCTION rendering of the signal case, driven through
// runCodex rather than reconstructed. The child kills itself before writing anything, so
// waitForExit reports (code: null, error: null) and the no-output-file branch — the one a
// killed child actually reaches — has to render it.
//
// POSIX-only, and the platform IS the parameter here rather than a fake name: Windows has
// no signals, so `process.kill(pid, 'SIGKILL')` there is TerminateProcess and the parent
// reads an ordinary numeric exit. Faking `code: null` on Windows would assert the mock, not
// the branch. Every other test in this block is cross-platform; only this one needs a real
// POSIX signal. The backstop is the DAILY CLOUD full-suite routine
// (docs/runbooks/cloud-routines/full-suite.md), which runs on Linux and therefore actually
// EXECUTES this test rather than skipping it. There is no Windows nightly and never will be —
// docs/runbooks/nightly-windows-suite.md is retired-task history, not a live backstop, and an
// earlier version of this comment cited it as one (caught in plan 4019's round-3 self-read).
test(
  'runCodex: a real signal death renders through describeExit in the message production actually returns, not just in the renderer',
  { skip: process.platform === 'win32' },
  async () => {
    const { result, lines } = await captureLog(() =>
      runFakeCodex({ writeOutput: false, killSelf: true }),
    );
    assert.equal(result.code, null);
    assert.equal(
      result.error,
      'no output file (rc=null — killed by signal)',
      'callFinderAngle persists this string — a bare "rc=null" there reads as a missing exit code, not a killed process',
    );
    assert.ok(
      lines.some((l) => l.includes('codex exit null — killed by signal')),
      'and the exit log says the same thing, since neither error nor dead is set here',
    );
  },
);

// plan 4019 fix round 2, H6 (finding 5af7ea): `code !== 0` is also true when `code === null` — a
// signal death from OUTSIDE our own watchdog (an OOM kill, an operator `taskkill`; the liveness
// probe's own kill and a spawn failure are excluded already via `dead`/`error`). The test above
// proves the renderer/log wording for a signal death with an ORDINARY transcript; this one proves
// the classifier itself is never invoked for one, even when the transcript happens to CONTAIN a
// recognizable marker — a signal-killed process must not be reported as `[token-rotten]` just
// because its last words before dying included "401".
//
// plan 4019 fix round 3, J6 (finding 02a4a3): `killSelf` drives a REAL POSIX SIGKILL so
// `waitForExit` observes an actual (code: null, signal) close — the exact shape under test. The
// platform genuinely IS the parameter here, not an ambient name: on win32 `process.kill(pid,
// 'SIGKILL')` is `TerminateProcess`, which the parent reads back as an ordinary NUMERIC exit, so
// this branch is unreachable there by construction, not merely awkward to fake. Injecting a fake
// `code: null` instead would assert the mock, not the branch (see `fakeCodexDir`'s own header).
// platform-assert-ok: genuinely needs a real POSIX signal; the backstop is the daily cloud
// full-suite routine (docs/runbooks/cloud-routines/full-suite.md), which runs on Linux and so
// actually executes this test. NOT a Windows nightly — there is none.
test(
  'runCodex: a signal death is NEVER classified, even when the transcript contains a recognizable marker — describeExit already renders it honestly and "we do not know why" is the correct answer (fix round 2, H6)',
  { skip: process.platform === 'win32' },
  async () => {
    const r = await runFakeCodex({
      writeOutput: false,
      killSelf: true,
      stderrText: 'stream error: 401 Unauthorized\n',
    });
    assert.equal(r.code, null);
    assert.equal(
      r.failureClass,
      undefined,
      'a signal death must not be classified as token-rotten just because the transcript happens to contain a 401',
    );
    assert.equal(r.failureClassReportedResetAt, undefined);
    assert.equal(r.error, 'no output file (rc=null — killed by signal)');
  },
);

// Round 3, findings 0a7992 / 4069c1 / 8d4f5a / ff31ab — four angles on the one call site
// round 2 left uncovered. The signal test above uses writeOutput: false, so it drives the
// no-output-file branch; the THIRD renderer call site is the plan's own new branch, reached
// only when a killed child DID leave a file behind. That is also the shape this plan exists
// for — a valid-JSON answer from a process that did not exit cleanly — so leaving it pinned
// by nothing but the renderer's unit test was the same self-referential gap as round 2's.
//
// platform-assert-ok: same real-POSIX-SIGKILL need as the H6 test above.
test(
  'runCodex: a signal death that DID leave valid JSON returns the plan-3637 exit error, rendered through describeExit',
  { skip: process.platform === 'win32' },
  async () => {
    const r = await runFakeCodex({ writeOutput: true, killSelf: true });
    assert.equal(
      r.data,
      undefined,
      'a killed child never yields a success, however complete the file it left looks',
    );
    assert.equal(r.error, 'exit null — killed by signal');
    assert.equal(r.code, null);
  },
);

// plan 4019 fix round 3, J2 (findings 9d0237/bd8419/a8946f/19df10/610519 — five angles): the H6
// guard above excludes `code === null` from classification only in the NO-OUTPUT branch. The
// OUTPUT-FILE branch (the test right above this one — `writeOutput: true, killSelf: true`) had
// the identical gap: `code !== 0` is true for `null` too, so a signal-killed process that left a
// valid output file behind was STILL handed to the classifier, and a leftover "401" in its
// transcript could fabricate a `[token-rotten]` label. This is the mirror of the H6 test above,
// through the OTHER call site — RED before the fix (would have reported `failureClass:
// 'token-rotten'` and `error: 'exit null — killed by signal [token-rotten]'`).
//
// platform-assert-ok: same real-POSIX-SIGKILL need as the two tests above.
test(
  'runCodex: a signal death that DID leave valid JSON is ALSO never classified, even with a recognizable marker in the transcript (fix round 3, J2)',
  { skip: process.platform === 'win32' },
  async () => {
    const r = await runFakeCodex({
      writeOutput: true,
      killSelf: true,
      stderrText: 'stream error: 401 Unauthorized\n',
    });
    assert.equal(r.code, null);
    assert.equal(
      r.data,
      undefined,
      'a killed child never yields a success, however complete the file it left looks',
    );
    assert.equal(
      r.failureClass,
      undefined,
      'a signal death must not be classified as token-rotten just because the transcript happens to contain a 401',
    );
    assert.equal(r.failureClassReportedResetAt, undefined);
    assert.equal(r.error, 'exit null — killed by signal');
  },
);

// ─── plan 3966 — armLivenessProbe: the kill condition, pinned directly ─────────
// The exported constants are the real defaults a caller gets when it omits
// `liveness` entirely — pinned once here so a future edit to either number is a
// deliberate, visible diff rather than a silent drift.
test('LIVENESS_START_AFTER_S / LIVENESS_WINDOW_S: the spec-pass defaults (30 min arm delay, 10 min silence window)', () => {
  assert.equal(LIVENESS_START_AFTER_S, 1800);
  assert.equal(LIVENESS_WINDOW_S, 600);
});

// These cases drive the predicate through an INJECTED clock and the returned
// `tick()`, never through real elapsed time (review round 1, findings 6d074e /
// b766cb / c9f6f7). A real-timer version flaked in BOTH directions on a loaded
// box — a nominal 320ms sleep waking at 520ms makes a legitimate kill look like
// a bug, and an event-loop stall makes a legitimate kill look late — and this
// battery is a measured load-flake surface (CLAUDE.md § Conventions: four
// consecutive full-battery runs red with a different failing set each time), so
// a flake here blocks an unrelated session's push. With the clock injected the
// assertions are exact: no tolerances, no sleeps, and the real production
// numbers (1800/600) are used instead of scaled-down stand-ins.
//
// One real-timer case at the end still proves the setInterval is actually wired
// to tick(), which the fake-clock cases deliberately bypass.
function fakeClock(startMs = 1_000_000) {
  let t = startMs;
  return {
    nowMs: () => t,
    advanceS(s) {
      t += s * 1000;
    },
  };
}

// A plain object stands in for the real ChildProcess: armLivenessProbe only ever
// reads `exitCode`/`signalCode` off it (to label an already-exited child) and
// otherwise treats it opaquely.
function fakeChild(over = {}) {
  return { exitCode: null, signalCode: null, ...over };
}

// Arm a probe on the fake clock at the REAL production thresholds. tickMs is
// large enough that the background interval never fires during a test — every
// evaluation below is an explicit `probe.tick()`.
function armOnFakeClock({ child = fakeChild(), onDead } = {}) {
  const clock = fakeClock();
  const calls = [];
  const probe = armLivenessProbe({
    child,
    startAfterS: LIVENESS_START_AFTER_S,
    windowS: LIVENESS_WINDOW_S,
    tickMs: 60 * 60 * 1000,
    nowMs: clock.nowMs,
    onDead: (info) => {
      calls.push(info);
      onDead?.(info);
    },
  });
  return { clock, probe, calls };
}

test('armLivenessProbe: a slow-but-progressing child is NEVER killed, at any elapsed time', () => {
  const { clock, probe, calls } = armOnFakeClock();
  // Nine hours of steady progress at 9-minute intervals — always shorter than
  // the 600s window, and vastly past startAfterS + windowS (2400s). A predicate
  // that ORed the two clauses instead of ANDing them would fire on the first
  // tick after 2400s regardless of the bumping; this is the case that catches it.
  for (let i = 0; i < 60; i++) {
    clock.advanceS(540);
    probe.bump();
    probe.tick();
    assert.equal(calls.length, 0, `must not fire while progressing (iteration ${i})`);
  }
  probe.disarm();
});

test('armLivenessProbe: a child that goes silent AFTER the start mark is killed exactly one window after its last output', () => {
  const { clock, probe, calls } = armOnFakeClock();
  clock.advanceS(2000); // past the 1800s start mark
  probe.bump(); // last real output at t=2000s
  clock.advanceS(LIVENESS_WINDOW_S - 1); // t=2599s — one second short of a full window
  probe.tick();
  assert.equal(calls.length, 0, 'one second short of a full window must not fire');
  clock.advanceS(1); // t=2600s — exactly one window of silence
  probe.tick();
  assert.equal(calls.length, 1, 'a full window of silence after the start mark must fire');
  probe.disarm();
});

test('armLivenessProbe: a child silent BEFORE the start mark survives until the mark plus one window — never at lastProgress + windowS', () => {
  const { clock, probe, calls } = armOnFakeClock();
  probe.bump(); // the ONLY output, at t=0 — long before the 1800s mark
  // A predicate keyed on silence alone would fire here, at t=600s.
  clock.advanceS(LIVENESS_WINDOW_S);
  probe.tick();
  assert.equal(calls.length, 0, 'silence alone must not fire before the start mark');
  clock.advanceS(LIVENESS_START_AFTER_S - 1); // t=2399s — one second short
  probe.tick();
  assert.equal(calls.length, 0, 'one second short of startAfterS + windowS must not fire');
  clock.advanceS(1); // t=2400s
  probe.tick();
  assert.equal(calls.length, 1, 'must fire exactly at startAfterS + windowS');
  probe.disarm();
});

test('armLivenessProbe: it fires at most once, and disarm() stops it firing at all', () => {
  const { clock, probe, calls } = armOnFakeClock();
  clock.advanceS(5000);
  probe.tick();
  probe.tick();
  probe.tick();
  assert.equal(calls.length, 1, 'repeated ticks past the mark must not re-fire');

  const second = armOnFakeClock();
  second.probe.disarm();
  second.clock.advanceS(5000);
  second.probe.tick();
  assert.equal(second.calls.length, 0, 'a disarmed probe must never fire');
});

// What this pins is the LABEL, not a tree-kill (findings 4a1f17 then a42a1d /
// af37e0 / d1c4fc / cbb84e / ae23a2 / 2ae76b / 5fe9e8 — round 2 corrected round
// 1's reasoning). An earlier draft RETURNED from the tick whenever the child had
// already exited, which meant never disarming and never reporting anything; the
// tick must still fire. It does NOT follow that the caller can then release a
// descendant-held tree — `killProcessTree` is a documented no-op on an exited
// root and the pre-existing `waitForExit`-on-'close' hang is unchanged by this
// plan (see armLivenessProbe's own note, and the infra-debt line). So: fires,
// reports childAlreadyExited, and the caller withholds the 'dead' label.
test('armLivenessProbe: an already-exited child still fires and reports childAlreadyExited, so the caller withholds the dead label', () => {
  const exited = armOnFakeClock({ child: fakeChild({ exitCode: 0 }) });
  exited.clock.advanceS(5000);
  exited.probe.tick();
  assert.equal(exited.calls.length, 1, 'an exited child must still fire rather than silently bail');
  assert.equal(
    exited.calls[0].childAlreadyExited,
    true,
    'and must report that the child had already exited, so the caller withholds the dead label',
  );

  const signalled = armOnFakeClock({ child: fakeChild({ signalCode: 'SIGTERM' }) });
  signalled.clock.advanceS(5000);
  signalled.probe.tick();
  assert.equal(signalled.calls[0].childAlreadyExited, true, 'signalCode counts as exited too');

  const live = armOnFakeClock();
  live.clock.advanceS(5000);
  live.probe.tick();
  assert.equal(
    live.calls[0].childAlreadyExited,
    false,
    'a still-running child IS labelled dead — that is the whole point of the probe',
  );
});

// Findings 6071d1 / 3861b7: every quantity the probe compares is a DURATION, so
// it must not read a wall clock. A forward jump of Date.now() (NTP, DST, a
// manual set) would otherwise satisfy both thresholds at once and kill a
// healthy call. Pinned by construction: a probe on the default clock, with
// Date.now() moved a day forward, must not fire.
test('armLivenessProbe: the default clock is monotonic — a wall-clock jump cannot make a healthy call look dead', () => {
  let fired = 0;
  const realDateNow = Date.now;
  const probe = armLivenessProbe({
    child: fakeChild(),
    startAfterS: LIVENESS_START_AFTER_S,
    windowS: LIVENESS_WINDOW_S,
    tickMs: 60 * 60 * 1000,
    onDead: () => {
      fired++;
    },
  });
  try {
    Date.now = () => realDateNow() + 24 * 60 * 60 * 1000; // a day forward, mid-call
    probe.tick();
    assert.equal(fired, 0, 'a wall-clock jump must not fire the probe');
  } finally {
    Date.now = realDateNow;
    probe.disarm();
  }
});

// The fake-clock cases above all call tick() by hand, so none of them proves
// the setInterval is actually wired to it. This one does — by CAPTURING the
// callback the probe schedules and invoking it, rather than waiting on real
// time (review round 2, findings 844f4d / 9938c2: an earlier version polled for
// up to four seconds, which an event-loop stall on a loaded shared runner can
// exceed, failing a correct implementation and blocking an unrelated push).
// Capturing proves all of it with no wall clock at all: that an interval was
// scheduled at `tickMs`, that the function it scheduled really performs the
// evaluation, and — because the stub honours `clearInterval` and tracks live
// handles (review round 3, findings 90e232 / 475141) — that `disarm()` and a
// fired kill each actually CANCEL it. Without the cancellation half a
// regression that cleared the interval immediately would leave production
// unable to notice a silent child while a capture-and-invoke test still passed.
test('armLivenessProbe: the interval really drives tick(), and both disarm() and a fired kill cancel it', () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  // A minimal timer registry: setInterval registers a live handle, clearInterval
  // removes it, so `live.size` is a real assertion about cancellation.
  const live = new Map();
  let nextId = 1;
  const scheduled = [];
  const withFakeTimers = (fn) => {
    globalThis.setInterval = (cb, ms) => {
      const handle = { id: nextId++, unref() {} };
      live.set(handle.id, cb);
      scheduled.push({ cb, ms, handle });
      return handle;
    };
    globalThis.clearInterval = (handle) => {
      if (handle && live.has(handle.id)) live.delete(handle.id);
    };
    try {
      return fn();
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  };

  // (a) disarm() must cancel the registered interval.
  {
    const clock = fakeClock();
    let fired = 0;
    const probe = withFakeTimers(() =>
      armLivenessProbe({
        child: fakeChild(),
        startAfterS: LIVENESS_START_AFTER_S,
        windowS: LIVENESS_WINDOW_S,
        tickMs: 12_345,
        nowMs: clock.nowMs,
        onDead: () => {
          fired++;
        },
      }),
    );
    assert.equal(scheduled.length, 1, 'arming must schedule exactly one interval');
    assert.equal(scheduled[0].ms, 12_345, 'and schedule it at the requested tickMs');
    assert.equal(live.size, 1, 'the interval must be live while the probe is armed');
    withFakeTimers(() => probe.disarm());
    assert.equal(live.size, 0, 'disarm() must clear the registered interval, not just set a flag');
    assert.equal(fired, 0);
  }

  // (b) the scheduled callback itself must run the evaluation and, on firing,
  // cancel its own interval.
  {
    scheduled.length = 0;
    const clock = fakeClock();
    let fired = 0;
    const probe = withFakeTimers(() =>
      armLivenessProbe({
        child: fakeChild(),
        startAfterS: LIVENESS_START_AFTER_S,
        windowS: LIVENESS_WINDOW_S,
        tickMs: 12_345,
        nowMs: clock.nowMs,
        onDead: () => {
          fired++;
        },
      }),
    );
    assert.equal(live.size, 1);
    withFakeTimers(() => scheduled[0].cb()); // t=0 — condition not met
    assert.equal(fired, 0);
    assert.equal(live.size, 1, 'a tick that does not fire must leave the interval live');

    clock.advanceS(LIVENESS_START_AFTER_S + LIVENESS_WINDOW_S);
    withFakeTimers(() => scheduled[0].cb());
    assert.equal(fired, 1, 'the scheduled callback must run the kill evaluation');
    assert.equal(live.size, 0, 'and a fired kill must clear its own interval');
    probe.disarm();
  }
});
