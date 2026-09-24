// scripts/stamp-lib.test.mjs — plan 3973 (T2): end-to-end tests for stampFrontmatterAxis's
// combined stamp+move core, against a throwaway isolated git repo (the shared
// test-helpers/isolated-plan-repo.mjs scaffold — plan 1797). stamp-lib.mjs has no CLI of
// its own, so every test here writes a small harness .mjs INTO the copied tool tree (the
// same pattern stamp-exec-model.test.mjs's `writeSpineHarness`/3919 spine tests already use
// for this exact module) and runs it as a subprocess, so `resolveMain()`/`withCoordCheckout`
// resolve against the isolated repo exactly as a real invocation would.
//
// Pure-function coverage for the small module-local helpers stamp-lib.mjs exports
// (resolveSpecPassCost / specCostFrontmatterValue) already lives in
// stamp-exec-model.test.mjs (its only consumer, per the repo's "fold into the consumer's
// test file" rule) — not duplicated here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolatedRepoFactory, runTool as runStamp } from '../test-helpers/isolated-plan-repo.mjs';
// The ONE authority for a claim ref's name (plan 3973 round-2 review fix, finding 438030) —
// never a hand-built `refs/claims/<id>` string. Both namespaces: `pushTestClaim` deliberately
// pushes into the PRE-3756 legacy namespace planStatus's dual-read still honours (see its own
// comment below), and `pushTestClaimNew` (round-3 review fix, findings f4c9b3/12ef2c/06453e)
// pushes into the live branch-shaped one — the refusal message must name whichever one a
// claim actually sits in, never a hardcoded guess of either.
import { claimRef, legacyClaimRef } from './coord-refs.mjs';
// plan 4071 review fix (T2 caller): assertEvidenceFloorOk's evidenceGatedCategories now
// comes from coord.config.json (the removed EVIDENCE_GATED_CATEGORIES literal) — a fixed,
// portable literal matching today's real vetapp row (plan 3958: same precedent as
// move-plan.test.mjs's/next-plan-id.test.mjs's VETAPP_PLAN_CATEGORIES), rather than a live
// loadCoordConfig read. The public coord-kit's own neutral coord.config.json carries no
// planCategories at all, which degrades to `evidenceGated: []` (coord-config.mjs's own
// DEFAULT_PLAN_CATEGORIES) — a live read would silently stop gating "Pipe" and the refusal
// this test exists to pin would never fire.
const VETAPP_PLAN_CATEGORIES = { evidenceGated: ['Pipe', 'DQ', 'App', 'UI'] };

// Same 💰/🟩-banner fixture shape stamp-exec-model.test.mjs uses (assertCostBannerOk /
// rewriteBlockedByHeader's SEED-WRITE anchor both need it); no `stage:` frontmatter key,
// so assertSpecReviewOk's grandfather clause (a missing stage always passes) applies and
// the tests below don't need to fabricate a spec-pass to reach ready/.
const DEFAULT_BODY = [
  '---',
  'summary: Test plan for stamp-lib',
  'seedWrite: false',
  '---',
  '',
  '> 🟩 **SEED-WRITE: no**',
  '',
  '> 💰 **Cost forecast:** $0 — no LLM/API spend.',
  '',
  '**Status:** 📋 READY — opened 2026-07-02.',
  '',
  '# 1000-Other-foo',
  '',
  'Body.',
  '',
].join('\n');

const makeIsolatedRepo = isolatedRepoFactory({
  prefix: 'stamplib',
  basename: '1000-Other-foo.md',
  body: DEFAULT_BODY,
});

// A minimal axis literal, inlined into a generated harness script (functions can't cross
// a subprocess boundary, so every harness below is a small standalone .mjs file — same
// shape as writeSpineHarness in stamp-exec-model.test.mjs).
function axisSnippet(name, key, value) {
  return (
    `{ tool: '${name}', regenIndex: false, preflight: () => {}, ` +
    `mutateBody: (body) => body.replace('seedWrite: false', 'seedWrite: false\\n${key}: ${value}'), ` +
    `commitSubject: () => 'docs(plans): stamp 1000-Other-foo.md ${key}: ${value}', ` +
    `dryPreview: () => ['[dry] set ${key}: ${value}'] }`
  );
}

function writeHarness(repo, body) {
  // Written BESIDE the copied stamp-lib.mjs (which plan 3962 Phase 2 moved to scripts/coord/),
  // because the harness source below imports it with a bare './stamp-lib.mjs'.
  const harness = join(dirname(repo.toolPath('stamp-lib.mjs')), 'stamp-lib-t2-harness.mjs');
  writeFileSync(harness, body);
  return harness;
}

// plan 3973 review fix (findings 330895/0b905d): push a parentless claim commit for a plan,
// mirroring move-plan.test.mjs's own pushTestClaim/claim-guard fixture (same legacy
// refs/claims/<id> ref shape planStatus's claimRefCandidates still reads).
// `refBuilder` defaults to the legacy `refs/claims/<id>` namespace; round-3 review fix
// (findings f4c9b3/12ef2c/06453e) added the LIVE branch-shaped namespace as a companion
// case, so a test can assert the refusal names whichever namespace the claim ACTUALLY sits
// in. Round-4 review (finding 1a48d1): parameterized by ref builder instead of a second
// hand-copied function — a future fixture change (message shape, empty-tree sha) now
// applies to both namespaces from ONE place.
function pushTestClaim(repo, planId, sessionUuid, { refBuilder = legacyClaimRef } = {}) {
  const msg = [
    `claim plan=${planId}`,
    `session=${sessionUuid}`,
    'host=test-host',
    'iso=2026-07-19T00:00:00.000Z',
  ].join('\n');
  const sha = repo.g('commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', msg).trim();
  repo.g('push', '-q', 'origin', `${sha}:${refBuilder(planId)}`);
}

function pushTestClaimNew(repo, planId, sessionUuid) {
  return pushTestClaim(repo, planId, sessionUuid, { refBuilder: claimRef });
}

// Like runStamp but with an env override, so the claim-guard test can pin
// CLAUDE_CODE_SESSION_ID deterministically regardless of the harness environment (mirrors
// move-plan.test.mjs's runMovePlanEnv).
function runStampEnv(dir, scriptPath, envOverride) {
  const env = { ...process.env };
  for (const name of [
    'COORD_SESSION_ID',
    'CLAUDE_CODE_SESSION_ID',
    'CODEX_SESSION_ID',
    'CODEX_THREAD_ID',
    'GROK_SESSION_ID',
  ])
    delete env[name];
  const r = spawnSync(process.execPath, [scriptPath], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...env, ...envOverride },
  });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('T2: two axes in one call produce exactly ONE new commit on master', () => {
  const repo = makeIsolatedRepo();
  try {
    const before = repo.g('rev-list', '--count', 'origin/master').trim();
    const harness = writeHarness(
      repo,
      [
        "import { stampFrontmatterAxis } from './stamp-lib.mjs';",
        `await stampFrontmatterAxis({ idOrName: '1000', dry: false, axes: [${axisSnippet('axis-a', 'execModel', 'fable')}, ${axisSnippet('axis-b', 'cloudExec', 'true')}] });`,
        '',
      ].join('\n'),
    );
    const res = runStamp(repo.dir, [], harness);
    assert.equal(res.code, 0, res.stderr);
    const after = repo.g('rev-list', '--count', 'origin/master').trim();
    assert.equal(Number(after) - Number(before), 1, 'exactly one new commit');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^execModel: fable$/m);
    assert.match(body, /^cloudExec: true$/m);
    // Coord-Write trailer names BOTH axes (plan 1797's audit-trail contract, extended here).
    const subject = repo.g('log', '-1', '--format=%B', 'origin/master');
    assert.match(subject, /Coord-Write: axis-a\+axis-b/);
  } finally {
    repo.cleanup();
  }
});

test('T2: a single-axis call (no `axes`, no `move`) is byte-identical to the pre-3973 shape', () => {
  const repo = makeIsolatedRepo();
  try {
    const harness = writeHarness(
      repo,
      [
        "import { stampFrontmatterAxis } from './stamp-lib.mjs';",
        "await stampFrontmatterAxis({ idOrName: '1000', dry: false, tool: 'legacy-tool', regenIndex: false,",
        '  preflight: () => {},',
        "  mutateBody: (body) => body.replace('seedWrite: false', 'seedWrite: false\\nexecModel: fable'),",
        "  commitSubject: () => 'docs(plans): stamp 1000-Other-foo.md execModel: fable',",
        "  dryPreview: () => ['[dry] set execModel: fable'] });",
        '',
      ].join('\n'),
    );
    const res = runStamp(repo.dir, [], harness);
    assert.equal(res.code, 0, res.stderr);
    const subject = repo.g('log', '-1', '--format=%s', 'origin/master').trim();
    // The COMBINED-form subject builder must never engage for a single axis with no move —
    // the commit subject is that one axis's own commitSubject(ctx) output, unchanged.
    assert.equal(subject, 'docs(plans): stamp 1000-Other-foo.md execModel: fable');
    assert.match(repo.g('log', '-1', '--format=%B', 'origin/master'), /Coord-Write: legacy-tool/);
  } finally {
    repo.cleanup();
  }
});

test('T2: --move to an unsupported target refuses before any mutation — no commit', () => {
  const repo = makeIsolatedRepo();
  try {
    const before = repo.g('rev-parse', 'origin/master').trim();
    const harness = writeHarness(
      repo,
      [
        "import { stampFrontmatterAxis } from './stamp-lib.mjs';",
        'try {',
        `  await stampFrontmatterAxis({ idOrName: '1000', dry: false, axes: [${axisSnippet('axis-a', 'execModel', 'fable')}], move: { target: 'archive' } });`,
        "  console.error('UNEXPECTED_SUCCESS');",
        '} catch (e) {',
        "  console.error('CAUGHT:' + e.message);",
        '  process.exitCode = 1;',
        '}',
        '',
      ].join('\n'),
    );
    const res = runStamp(repo.dir, [], harness);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /CAUGHT:.*--move archive is not supported/);
    assert.equal(repo.g('rev-parse', 'origin/master').trim(), before);
  } finally {
    repo.cleanup();
  }
});

test('T2: --move ready folds an axis stamp + lane move into ONE commit', () => {
  const repo = makeIsolatedRepo();
  try {
    const before = repo.g('rev-list', '--count', 'origin/master').trim();
    const harness = writeHarness(
      repo,
      [
        "import { stampFrontmatterAxis } from './stamp-lib.mjs';",
        `await stampFrontmatterAxis({ idOrName: '1000', dry: false, axes: [${axisSnippet('axis-a', 'execModel', 'fable')}], move: { target: 'ready' } });`,
        '',
      ].join('\n'),
    );
    // Seed plan starts in ready/ by default (isolatedRepoFactory's startFolder default) —
    // re-target the scaffold to pending-approval/ so the move is a REAL folder change.
    repo.g('mv', repo.srcRel, 'docs/superpowers/plans/pending-approval/1000-Other-foo.md');
    repo.g('commit', '-qm', 're-seed into pending-approval/');
    repo.g('push', '-q', 'origin', 'master');
    const beforeMove = repo.g('rev-list', '--count', 'origin/master').trim();

    const res = runStamp(repo.dir, [], harness);
    assert.equal(res.code, 0, res.stderr);
    const after = repo.g('rev-list', '--count', 'origin/master').trim();
    assert.equal(Number(after) - Number(beforeMove), 1, 'exactly one new commit for stamp+move');
    assert.notEqual(before, after);

    // Lands at ready/, never at its old pending-approval/ location.
    assert.throws(() =>
      repo.g('show', 'origin/master:docs/superpowers/plans/pending-approval/1000-Other-foo.md'),
    );
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^execModel: fable$/m);
    // stampPromotedStatus rewrote the Status line for the promotion.
    assert.match(body, /\*\*Status:\*\* 📋 READY — re-filed pending-approval→ready/);

    const subject = repo.g('log', '-1', '--format=%s', 'origin/master');
    assert.match(subject, /^docs\(plans\): stamp\+move 1000-Other-foo\.md — /);
    assert.match(subject, /move pending-approval\/ → ready\//);
  } finally {
    repo.cleanup();
  }
});

// plan 4122: `git mv` does not create its destination's parent directory, and git
// tracks no empty directory — so a lane that has emptied on origin (every plan
// promoted/moved out, no file left behind) is simply ABSENT from a fresh coord
// checkout until the first file lands there again, and the raw `git mv` fatals
// "destination directory does not exist" (hit 4x live on waiting-grill/, 2026-09-22).
// Reproduce that exact shape: push a commit to origin/master that removes ready/'s
// last tracked file (its `.gitkeep`), so ready/ genuinely does not exist anywhere the
// disposable coord checkout can fetch it from — then --move ready must still succeed,
// via the ensureMvDestDir guard now placed immediately before stamp-lib.mjs's mv.
test('T2: --move into a lane directory absent from the checkout succeeds and creates it (plan 4122)', () => {
  const repo = makeIsolatedRepo({ startFolder: 'pending-approval' });
  try {
    repo.g('rm', '-q', 'docs/superpowers/plans/ready/.gitkeep');
    repo.g('commit', '-qm', 'empty ready/ lane for the test');
    repo.g('push', '-q', 'origin', 'master');

    const harness = writeHarness(
      repo,
      [
        "import { stampFrontmatterAxis } from './stamp-lib.mjs';",
        `await stampFrontmatterAxis({ idOrName: '1000', dry: false, axes: [${axisSnippet('axis-a', 'execModel', 'fable')}], move: { target: 'ready' } });`,
        '',
      ].join('\n'),
    );
    const res = runStamp(repo.dir, [], harness);
    assert.equal(res.code, 0, res.stderr);
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^execModel: fable$/m);
    assert.throws(
      () =>
        repo.g('show', 'origin/master:docs/superpowers/plans/pending-approval/1000-Other-foo.md'),
      'the plan is gone from its old lane',
    );
  } finally {
    repo.cleanup();
  }
});

test("T2: --move waiting-blocked without --blocked-by refuses (assertBlockedByOk-equivalent gate is the CALLER's job, but assertTripConditionOk-style body gates still run) — a bad waiting-trip body refuses with no commit", () => {
  const repo = makeIsolatedRepo();
  try {
    const before = repo.g('rev-parse', 'origin/master').trim();
    const harness = writeHarness(
      repo,
      [
        "import { stampFrontmatterAxis } from './stamp-lib.mjs';",
        'try {',
        `  await stampFrontmatterAxis({ idOrName: '1000', dry: false, axes: [${axisSnippet('axis-a', 'execModel', 'fable')}], move: { target: 'waiting-trip', blockedBy: 'x' } });`,
        "  console.error('UNEXPECTED_SUCCESS');",
        '} catch (e) {',
        "  console.error('CAUGHT:' + e.message);",
        '  process.exitCode = 1;',
        '}',
        '',
      ].join('\n'),
    );
    const res = runStamp(repo.dir, [], harness);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /CAUGHT:.*waiting-trip.*trip-condition/);
    assert.equal(repo.g('rev-parse', 'origin/master').trim(), before);
  } finally {
    repo.cleanup();
  }
});

// plan 3973 review fix (findings 330895/0b905d): the combined stamp+move path must run
// move-plan.mjs's OWN claim-holder guard (plan 2082) — a plan claimed by ANOTHER session
// must refuse to move here exactly as it does through move-plan.mjs itself, with NO commit.
//
// Round-2 review fix (finding 8f28cd): the refusal must NOT reuse move-plan.mjs's own
// claimHolderError text — that message is branded "move-plan:" and tells the operator to
// "re-run with --force", a flag the combined --move form does not accept. Assert the
// refusal instead names the ACTUAL tool and the real way through (drop --move and run
// move-plan.mjs directly, which DOES have --force).
//
// Round-3 review fix (finding f4c9b3): the pre-fix code always named the branch-shaped
// ref regardless of which namespace actually held the claim — this fixture deliberately
// pushes into the LEGACY namespace (pushTestClaim → legacyClaimRef), so the correct
// refusal here names THAT ref; see the companion test just below for the same assertion
// against a claim in the live branch-shaped namespace.
test('T2 review fix: --move refuses a plan CLAIMED by ANOTHER session in the LEGACY namespace — no commit (findings 330895/0b905d/8f28cd/f4c9b3)', () => {
  const repo = makeIsolatedRepo();
  try {
    pushTestClaim(repo, '1000', 'ffffffff-0000-0000-0000-000000000000');
    const before = repo.g('rev-parse', 'origin/master').trim();
    const harness = writeHarness(
      repo,
      [
        "import { stampFrontmatterAxis } from './stamp-lib.mjs';",
        'try {',
        `  await stampFrontmatterAxis({ idOrName: '1000', dry: false, axes: [${axisSnippet('axis-a', 'execModel', 'fable')}], move: { target: 'waiting-blocked', blockedBy: 'x' } });`,
        "  console.error('UNEXPECTED_SUCCESS');",
        '} catch (e) {',
        "  console.error('CAUGHT:' + e.message);",
        '  process.exitCode = 1;',
        '}',
        '',
      ].join('\n'),
    );
    const res = runStampEnv(repo.dir, harness, {
      CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-1111-2222-3333-444444444444',
    });
    assert.equal(res.code, 1, `expected fatal throw\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /CAUGHT:.*axis-a: .*CLAIMED by session ffffffff-0000/);
    assert.match(res.stderr, /refs\/claims\/1000\b/, 'names the LEGACY ref actually held');
    assert.doesNotMatch(
      res.stderr,
      /refs\/heads\/coord\/claims\/1000/,
      'never the branch-shaped ref when the claim is legacy',
    );
    assert.doesNotMatch(res.stderr, /^CAUGHT:move-plan:/m, 'never move-plan-branded here');
    assert.doesNotMatch(
      res.stderr,
      /re-run with --force/,
      "never the standalone tool's own wording",
    );
    assert.match(
      res.stderr,
      /move-plan\.mjs 1000 waiting-blocked --force/,
      'names the actual escape hatch — drop --move, run move-plan.mjs directly',
    );
    assert.equal(repo.g('rev-parse', 'origin/master').trim(), before);
  } finally {
    repo.cleanup();
  }
});

// Round-3 review fix (finding f4c9b3): the companion case — a claim actually held in the
// LIVE branch-shaped namespace must be named as such, never the retired refs/claims/<id>
// spelling. Byte-identical setup to the test above except for pushTestClaimNew.
test('T2 review fix: --move refuses a plan CLAIMED by ANOTHER session in the NEW (branch-shaped) namespace — no commit (finding f4c9b3)', () => {
  const repo = makeIsolatedRepo();
  try {
    pushTestClaimNew(repo, '1000', 'ffffffff-0000-0000-0000-000000000000');
    const before = repo.g('rev-parse', 'origin/master').trim();
    const harness = writeHarness(
      repo,
      [
        "import { stampFrontmatterAxis } from './stamp-lib.mjs';",
        'try {',
        `  await stampFrontmatterAxis({ idOrName: '1000', dry: false, axes: [${axisSnippet('axis-a', 'execModel', 'fable')}], move: { target: 'waiting-blocked', blockedBy: 'x' } });`,
        "  console.error('UNEXPECTED_SUCCESS');",
        '} catch (e) {',
        "  console.error('CAUGHT:' + e.message);",
        '  process.exitCode = 1;',
        '}',
        '',
      ].join('\n'),
    );
    const res = runStampEnv(repo.dir, harness, {
      CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-1111-2222-3333-444444444444',
    });
    assert.equal(res.code, 1, `expected fatal throw\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /CAUGHT:.*axis-a: .*CLAIMED by session ffffffff-0000/);
    assert.match(
      res.stderr,
      /refs\/heads\/coord\/claims\/1000/,
      'names the branch-shaped ref actually held',
    );
    assert.equal(repo.g('rev-parse', 'origin/master').trim(), before);
  } finally {
    repo.cleanup();
  }
});

// plan 3973 review fix (findings 5ac1f2/a83e2c): the combined stamp+move path must run
// move-plan.mjs's OWN evidence-floor gate (assertEvidenceFloorOk) — a Pipe/DQ/App/UI plan
// stamped evidence: latent must refuse a --move ready exactly as move-plan.mjs itself
// refuses, with NO commit.
test('T2 review fix: --move ready refuses a Pipe/DQ/App/UI plan stamped evidence: latent — no commit (findings 5ac1f2/a83e2c)', () => {
  const evidenceBody = DEFAULT_BODY.replace(
    'summary: Test plan for stamp-lib',
    'summary: Test plan for stamp-lib\nevidence: latent',
  );
  const repo = makeIsolatedRepo({
    basename: '1000-Pipe-foo.md',
    body: evidenceBody,
    startFolder: 'pending-approval',
  });
  // plan 4071 review fix: the isolated fixture repo carries no coord.config.json of its
  // own, and an absent planCategories.evidenceGated degrades to `[]` — no category gated
  // (D1's degrade direction) — so this refusal would silently stop firing without an
  // explicit config row naming "Pipe" gated, the same way vetapp's own coord.config.json
  // does. stampImpl's mainDir is ff-synced from origin/master (ffMasterFromOrigin) before
  // this file is read, so — exactly like move-plan.test.mjs's plan-4071 fixture — the
  // config must be COMMITTED + PUSHED to origin, not merely written on repo.dir's
  // uncommitted working tree.
  writeFileSync(
    join(repo.dir, 'coord.config.json'),
    JSON.stringify({ planCategories: { evidenceGated: VETAPP_PLAN_CATEGORIES.evidenceGated } }),
  );
  repo.g('add', 'coord.config.json');
  repo.g('commit', '-qm', 'plan 4071 test fixture: gate Pipe on the evidence floor');
  repo.g('push', '-q', 'origin', 'master');
  try {
    const before = repo.g('rev-parse', 'origin/master').trim();
    const harness = writeHarness(
      repo,
      [
        "import { stampFrontmatterAxis } from './stamp-lib.mjs';",
        'try {',
        `  await stampFrontmatterAxis({ idOrName: '1000', dry: false, axes: [${axisSnippet('axis-a', 'execModel', 'fable')}], move: { target: 'ready' } });`,
        "  console.error('UNEXPECTED_SUCCESS');",
        '} catch (e) {',
        "  console.error('CAUGHT:' + e.message);",
        '  process.exitCode = 1;',
        '}',
        '',
      ].join('\n'),
    );
    const res = runStamp(repo.dir, [], harness);
    assert.equal(res.code, 1, `expected fatal throw\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /CAUGHT:.*evidence: latent/);
    assert.equal(repo.g('rev-parse', 'origin/master').trim(), before);
  } finally {
    repo.cleanup();
  }
});
