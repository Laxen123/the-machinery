// scripts/move-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedRepoFactory, runTool } from '../test-helpers/isolated-plan-repo.mjs';
import {
  rewriteBlockedByHeader,
  resolvePlanRel,
  VALID_TARGETS,
  assertBlockedByOk,
  assertTripConditionOk,
  assertUnblockOk,
  assertCostBannerOk,
  assertSpecReviewOk,
  assertRespecOk,
  assertEvidenceFloorOk,
  assertGrillQuestionsOk,
  assertGrillExitOk,
  GRILL_BLOCKED_BY_DEFAULT,
  // plan 4069
  AXIS_TAGS,
  AXIS_TAGS_BY_UNBLOCK,
  GRILL_AXIS_TAGS,
  assertBlockedByAxisTagOk,
  assertGrillQuestionsStructureOk,
  assertGrillQuestionAxisTagsOk,
  assertGrillQuestionsNotStaleOk,
  GRILL_ANSWERED_MARKERS,
  assertGrillQuestionsNotDuplicateOk,
  syncBoardPlanRefs,
  claimHolderError,
  parseMoveTarget,
  statusOf,
  statusPathOf,
  planRenameGrammar,
  renameLaneError,
  RENAMEABLE_STATUSES,
  describeClaimHolder,
} from './move-plan.mjs';
// The ONE authority for a claim ref's name, in both live shapes (round-3 review fix,
// findings f4c9b3/12ef2c/06453e) — used to build expected ref strings in the
// claimHolderError unit tests below, never a hand-built `refs/claims/<id>` literal.
import { claimRef, legacyClaimRef } from './coord-refs.mjs';
// Review round 2 (R2-9): the axis vocabulary's real leaf-module source — move-plan.mjs now
// imports and re-exports these under the same names, so the identity check below proves the
// re-export actually resolves to axis-tags.mjs rather than a second, drifted copy.
import {
  AXIS_TAGS as AXIS_TAGS_LEAF,
  AXIS_TAGS_BY_UNBLOCK as AXIS_TAGS_BY_UNBLOCK_LEAF,
  GRILL_AXIS_TAGS as GRILL_AXIS_TAGS_LEAF,
} from './axis-tags.mjs';

for (const name of [
  'COORD_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'GROK_SESSION_ID',
])
  delete process.env[name];
import { PLAN_FILENAME_RX, MUTATION_BANNER_LABEL } from './build-index-lib.mjs';
import { isNonFastForward, readCoordOpJournal } from './coord-git.mjs';
import { execModelDefaultLane } from './exec-model-default-lib.mjs';
import { LANE_SEGMENTS } from './plan-lane-segments.mjs';

// Plan 3656: the Tier-0 `exempt-mechanical` backfill stamps whatever lane
// `scripts/exec-model-default.json` names, so the basename segment these assertions expect
// follows the toggle rather than a pinned lane — a flip must never turn the suite red.
const DEFAULT_LANE = execModelDefaultLane();
const DEFAULT_SEG = LANE_SEGMENTS.find((s) => s.lane === DEFAULT_LANE)?.marker ?? '';

// plan 338's inherited-git-env clear (GIT_DIR / GIT_WORK_TREE / …) runs at import of
// test-helpers/isolated-plan-repo.mjs above — every `git -C <tmpdir>` call here (and
// the spawned move-plan child) honours -C <tmpdir>, never the real repo.

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const MOVE_PLAN = join(SCRIPTS_DIR, 'move-plan.mjs');
// plan 3958: same rationale as build-index-lib.test.mjs's own `sw()` — MUTATION_BANNER_LABEL is
// the kit's neutral 'DATA-WRITE' default there, not vetapp's real 'SEED-WRITE' row, and is the
// IDENTITY function on vetapp itself (where the label really is 'SEED-WRITE').
const sw = (s) => s.replaceAll('SEED-WRITE', MUTATION_BANNER_LABEL);
const BANNER = sw('> 🟥 **SEED-WRITE: YES** — mutates seed');

// plan 3958: this module ships as-is into the public coord-kit, so a shipped core test must not
// pin THIS repo's real coord.config.json planCategories/planNaming rows (the kit's own config
// carries neither at all) — fixed, portable fixtures (today's real vetapp values, kept as a
// snapshot) for the pure-function unit tests below that used to read the module-level literals
// directly. A CLI (subprocess) test that needs this SAME gate enforced writes an equivalent
// coord.config.json into its isolated fixture root instead (loadCoordConfig reads off disk,
// uncommitted is fine; see done-worktree.test.mjs's precedent) — a fixture repo has none of its
// own by default, which is D1's "empty = no gate" degrade, proven separately below.
const VETAPP_PLAN_CATEGORIES = {
  allowlist: ['Coord', 'Pipe', 'Infra', 'DQ', 'App', 'UI', 'SEO', 'Biz', 'MAIL', 'Other'],
  evidenceGated: ['Pipe', 'DQ', 'App', 'UI'],
};
const VETAPP_PLAN_NAMING = {
  countryTokenHints: [
    { token: 'gb', code: 'uk' },
    { token: 'britain', code: 'uk' },
    { token: 'england', code: 'uk' },
    { token: 'sweden', code: 'se' },
    { token: 'sverige', code: 'se' },
    { token: 'svenska', code: 'se' },
    { token: 'norway', code: 'no' },
    { token: 'norge', code: 'no' },
    { token: 'denmark', code: 'dk' },
    { token: 'danmark', code: 'dk' },
  ],
  stageTokens: {
    category: 'Pipe',
    tokens: ['render', 'extract', 'consensus', 'gates', 'apply', 'grammar'],
  },
};

// Bare plan body (no frontmatter / Status / Trip-condition) for the error-path tests
// that used the pre-1797 minimal makeRepoWithPlan scaffold — those tests exercise
// gates that must fire regardless of body richness, so they keep the bare body while
// riding the same shared isolated-plan-repo scaffold as every other test (plan 1797;
// the shared scaffold's tracked status folders preserve the original guarantee that
// a `git mv` dest exists, so a gate throw — not ENOENT — is what's under test).
const MINIMAL_PLAN_BODY = [
  sw('> 🟩 **SEED-WRITE: no**'),
  '',
  '# 050-Infra-foo',
  '',
  'Body.',
  '',
].join('\n');
const makeRepoWithPlan = () => makeIsolatedRepo({ body: MINIMAL_PLAN_BODY });

// Run move-plan.mjs as a subprocess with cwd in the temp repo; capture exit + IO.
// `scriptPath` lets the happy-path test run the COPY inside the temp repo (so the
// spawned build-index resolves REPO_ROOT to the temp repo, not the real one).
// Body extracted to the shared runTool (plan 1797); only the MOVE_PLAN default stays.
function runMovePlan(dir, args, scriptPath = MOVE_PLAN) {
  return runTool(dir, args, scriptPath);
}

// Default plan body for the isolated repo: a frontmatter summary (so build-index
// renders a clean bullet) PLUS — since plan 619 — a **Status:** line and a
// `## Trip-condition` section, so a move into waiting-trip/ passes the new
// body-state gate (a waiting-trip target now requires a concrete trip-condition).
const DEFAULT_PLAN_BODY = [
  '---',
  'summary: Test plan for the move-plan happy path',
  '---',
  '',
  sw('> 🟩 **SEED-WRITE: no**'),
  // plan 1260: a parseable Cost forecast banner, so a move INTO ready/ passes the new
  // cost-banner gate (a bannerless promotion to ready/ is now refused).
  '> 💰 **Cost forecast:** $0 — no LLM spend.',
  '',
  '**Status:** 📋 READY — opened 2026-06-01.',
  '',
  '# 050-Infra-foo',
  '',
  'Body.',
  '',
  '## Trip-condition',
  '',
  'Revive if X recurs.',
  '',
].join('\n');

// The shared isolated-plan-repo scaffold (test-helpers/isolated-plan-repo.mjs — this
// suite pioneered it, plan 1797 extracted it) with this suite's defaults baked in.
// build-index.mjs resolves REPO_ROOT from its OWN __dirname (not cwd), so the
// happy path can only be exercised end-to-end against the REAL repo UNLESS the
// tool tree is copied there — the scaffold copies it, so the spawned build-index
// touches the temp repo. Options (plan 619) let a test seed the plan in any folder
// with any body; the `movePlan` key is the COPIED tool inside the temp repo.
const makeIsolatedRepo = isolatedRepoFactory({
  prefix: 'moveplan-iso',
  basename: '050-Infra-foo.md',
  body: DEFAULT_PLAN_BODY,
  tools: { movePlan: 'move-plan.mjs' },
});

// Force EXACTLY ONE non-ff push during a subprocess move-plan: install a one-shot
// pre-push hook in `dir` that, the first time move-plan pushes, advances origin/master
// (a sibling clone pushes a NEUTRAL file — never the plan body or INDEX, so the retry's
// `pull --ff-only` is unobstructed even with the preserved dirty plan body) and then
// lets our push proceed → the remote rejects it non-ff → withRetry re-runs. A sentinel
// guarantees the hook fires once, so the second attempt's push lands cleanly.
// This is the subprocess analogue of coord-git.test.mjs's `cloneOf`-pushes-during-mutate
// trick (we can't inject a callback mid-subprocess, so we hook the push itself).
function installOneShotNonFfHook(dir, origin) {
  const posix = (p) => p.replace(/\\/g, '/');
  const hooksDir = join(dir, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const sentinel = join(dir, '.git', 'nonff-fired');
  const fixture = join(dir, '.git', 'sibling-push.mjs');
  writeFileSync(
    fixture,
    [
      "import { execFileSync } from 'node:child_process';",
      "import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      // git exports GIT_DIR/GIT_WORK_TREE/… into the pre-push hook subprocess; those
      // would redirect our sibling git ops onto the work repo. Clear them (same guard
      // as the top of every coord temp-repo test).
      "for (const k of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_COMMON_DIR','GIT_NAMESPACE','GIT_PREFIX']) delete process.env[k];",
      'const origin = process.argv[2];',
      "const sib = mkdtempSync(join(tmpdir(), 'moveplan-sib-'));",
      "execFileSync('git', ['clone', '-q', origin, sib]);",
      "execFileSync('git', ['-C', sib, 'config', 'user.email', 'sib@t.t']);",
      "execFileSync('git', ['-C', sib, 'config', 'user.name', 'sib']);",
      "writeFileSync(join(sib, 'sibling-neutral.txt'), 'theirs\\n');",
      "execFileSync('git', ['-C', sib, 'add', 'sibling-neutral.txt']);",
      "execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling advance']);",
      "execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);",
      'rmSync(sib, { recursive: true, force: true });',
      '',
    ].join('\n'),
  );
  // POSIX sh hook (git-for-Windows runs hooks through its bundled sh). Bake absolute,
  // forward-slashed paths + the node binary so it needs nothing from PATH.
  writeFileSync(
    join(hooksDir, 'pre-push'),
    [
      '#!/bin/sh',
      `if [ ! -f '${posix(sentinel)}' ]; then`,
      `  : > '${posix(sentinel)}'`,
      `  '${posix(process.execPath)}' '${posix(fixture)}' '${posix(origin)}' || exit 1`,
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

test('rewriteBlockedByHeader inserts after the banner for a waiting-* target', () => {
  const content = [BANNER, '', '# Title', 'body'].join('\n');
  const out = rewriteBlockedByHeader(content, 'waiting-blocked', 'plan 246 landing');
  assert.match(
    out,
    new RegExp(
      `${MUTATION_BANNER_LABEL}: YES.*\\n\\n\\*\\*Blocked-by:\\*\\* plan 246 landing\\n`,
      's',
    ),
  );
  assert.ok(out.indexOf('**Blocked-by:**') < out.indexOf('# Title'));
});

// plan 2892 review round 2 (CONFIRMED): when the anchor is the LAST line of an
// unterminated body, `content.indexOf('\n', idx)` returns -1 and the old
// `slice(0, bannerEnd + 1)` collapsed to slice(0, 0) — the ENTIRE body was discarded and
// the Blocked-by header landed at offset zero. Both anchor branches had the arithmetic.
test('2892 R2: an anchor on the final UNTERMINATED line does not truncate the body', () => {
  const content = `# T\n\n> \u{1F7E9} **${MUTATION_BANNER_LABEL}: NO** \u2014 none`; // no trailing newline
  const out = rewriteBlockedByHeader(content, 'waiting-blocked', 'plan 246 landing');
  assert.match(out, /^# T$/m, 'the H1 must survive');
  assert.match(out, new RegExp(`${MUTATION_BANNER_LABEL}: NO`), 'the banner must survive');
  assert.match(out, /\*\*Blocked-by:\*\* plan 246 landing/);
  assert.ok(
    out.indexOf('# T') < out.indexOf('**Blocked-by:**'),
    'the header must come AFTER the anchor, not at offset zero',
  );
});

test('2892 R2: the seedLane-off H1 fallback survives the same final-line shape', () => {
  const out = rewriteBlockedByHeader('# T', 'waiting-blocked', 'plan 246 landing', {
    seedLane: false,
  });
  assert.match(out, /^# T$/m);
  assert.ok(out.indexOf('# T') < out.indexOf('**Blocked-by:**'));
});

test('rewriteBlockedByHeader replaces an existing Blocked-by line in place', () => {
  const content = [BANNER, '', '**Blocked-by:** old reason', '', '# Title'].join('\n');
  const out = rewriteBlockedByHeader(content, 'waiting-trip', 'new reason');
  assert.match(out, /\*\*Blocked-by:\*\* new reason/);
  assert.ok(!out.includes('old reason'));
  assert.equal((out.match(/\*\*Blocked-by:\*\*/g) || []).length, 1);
});

test('rewriteBlockedByHeader leaves the body unchanged when promoting (non-waiting target)', () => {
  const content = [BANNER, '', '**Blocked-by:** plan 246', '', '# Title'].join('\n');
  assert.equal(rewriteBlockedByHeader(content, 'ready', undefined), content);
  assert.equal(rewriteBlockedByHeader(content, 'in-progress', undefined), content);
});

test('rewriteBlockedByHeader requires --blocked-by for a waiting-* target', () => {
  assert.throws(
    () => rewriteBlockedByHeader(`${BANNER}\n# T`, 'waiting-operator', undefined),
    /requires --blocked-by/,
  );
});

test('rewriteBlockedByHeader rejects a flag-shaped blocked-by (parseArgs footgun)', () => {
  assert.throws(
    () => rewriteBlockedByHeader(`${BANNER}\n# T`, 'waiting-trip', '--dry'),
    /looks like a flag/,
  );
});

test('assertBlockedByOk: no-op for a non-waiting (promotion) target, with or without a reason', () => {
  assert.doesNotThrow(() => assertBlockedByOk('ready', undefined));
  assert.doesNotThrow(() => assertBlockedByOk('in-progress', undefined));
  assert.doesNotThrow(() => assertBlockedByOk('archive', 'ignored historical reason'));
});

test('assertBlockedByOk: waiting-* target requires a --blocked-by reason', () => {
  assert.throws(() => assertBlockedByOk('waiting-blocked', undefined), /requires --blocked-by/);
  assert.throws(() => assertBlockedByOk('waiting-trip', ''), /requires --blocked-by/);
});

test('assertBlockedByOk: waiting-* target rejects a flag-shaped reason (parseArgs footgun)', () => {
  assert.throws(() => assertBlockedByOk('waiting-operator', '--dry'), /looks like a flag/);
});

test('assertBlockedByOk: waiting-* target with a real reason passes', () => {
  assert.doesNotThrow(() => assertBlockedByOk('waiting-trip', 'plan 246 landing'));
});

// plan 3960 cluster-6 review fix: assertBlockedByOk (and rewriteBlockedByHeader,
// stampClaimInProgress's TERMINAL_PARK_TARGETS sibling logic) used to detect a "waiting" target
// with a literal `/^waiting-/` STRING-PREFIX test — so a coord.config.json renaming a waiting
// lane to a folder that does not happen to start with "waiting-" (nothing in coord-config.mjs's
// lane validation requires that spelling) would silently stop requiring --blocked-by for that
// lane, even though it is still, in every other sense (coord-config.mjs's `lanes.waitingBlocked`
// role), a waiting lane. Reading the configured lane ROLES instead of the string prefix closes
// that gap. Proven with a REAL isolated repo (a fresh module graph, per the plan-3960 T3 test's
// own precedent) whose coord.config.json renames `lanes.waitingBlocked` to "frozen" — a name
// that does NOT start with "waiting-".
test('assertBlockedByOk: a renamed waiting lane (not spelled "waiting-…") still requires --blocked-by (cluster-6 review fix)', () => {
  const repo = makeIsolatedRepo();
  try {
    writeFileSync(
      join(repo.dir, 'coord.config.json'),
      JSON.stringify({ lanes: { waitingBlocked: 'frozen' } }),
    );
    const probePath = join(repo.dir, 'probe.mjs');
    writeFileSync(
      probePath,
      [
        `import { assertBlockedByOk } from ${JSON.stringify(pathToFileURL(repo.movePlan).href)};`,
        'let threwOnRenamed = false;',
        'try {',
        "  assertBlockedByOk('frozen', undefined);",
        '} catch {',
        '  threwOnRenamed = true;',
        '}',
        'let threwOnUnrelated = false;',
        'try {',
        "  assertBlockedByOk('parked', undefined);", // an ordinary non-waiting lane: still no-op
        '} catch {',
        '  threwOnUnrelated = true;',
        '}',
        'process.stdout.write(JSON.stringify({ threwOnRenamed, threwOnUnrelated }));',
      ].join('\n'),
    );
    const probe = spawnSync(process.execPath, [probePath], { cwd: repo.dir, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const result = JSON.parse(probe.stdout.trim());
    assert.equal(
      result.threwOnRenamed,
      true,
      'the renamed waiting lane must still require --blocked-by',
    );
    assert.equal(result.threwOnUnrelated, false, 'an ordinary non-waiting lane stays a no-op');
  } finally {
    repo.cleanup();
  }
});

test('resolvePlanRel matches by exact basename, by id, and errors on ambiguity / miss', () => {
  const plans = [
    'docs/superpowers/plans/ready/247-SEO-foo.md',
    'docs/superpowers/plans/waiting-trip/232-DQ-bar.md',
    'docs/superpowers/plans/archive/232-DQ-old.md',
  ];
  assert.equal(
    resolvePlanRel(plans, '247-SEO-foo.md'),
    'docs/superpowers/plans/ready/247-SEO-foo.md',
  );
  assert.equal(resolvePlanRel(plans, '247'), 'docs/superpowers/plans/ready/247-SEO-foo.md');
  assert.throws(() => resolvePlanRel(plans, '232'), /ambiguous/);
  assert.throws(() => resolvePlanRel(plans, '999'), /no plan matches/);
});

test('resolvePlanRel: a 4-digit id resolves to its own plan, never a 3-digit-prefix collision (plan 1002)', () => {
  const plans = [
    'docs/superpowers/plans/archive/100-2026-05-16-card-ux-followups.md',
    'docs/superpowers/plans/waiting-operator/1001-Other-acct-foo.md',
  ];
  // The rollover bug: `/^(\d{3})/` truncated "1001" → "100" and resolved the WRONG
  // (archived 100-*) plan. A bare 4-digit id must resolve to the 4-digit plan.
  assert.equal(
    resolvePlanRel(plans, '1001'),
    'docs/superpowers/plans/waiting-operator/1001-Other-acct-foo.md',
  );
  // …and the 3-digit id still resolves to its own plan, not the 4-digit one.
  assert.equal(
    resolvePlanRel(plans, '100'),
    'docs/superpowers/plans/archive/100-2026-05-16-card-ux-followups.md',
  );
});

test('resolvePlanRel: a year-valued id does not collide with dated legacy archive basenames (plan 2039)', () => {
  const plans = [
    'docs/superpowers/plans/archive/2026-05-17-adaptive-bouncing-castle-uiux-session.md',
    'docs/superpowers/plans/archive/2026-05-23-another-dated-note.md',
    'docs/superpowers/plans/archive/2026-06-01-yet-another-dated-note.md',
    'docs/superpowers/plans/archive/2026-06-15-fourth-dated-note.md',
    'docs/superpowers/plans/ready/2026-FABLE-price-thing.md',
  ];
  // The dated basenames are a `YYYY-MM-DD-slug.md` legacy shape with no real id — their
  // "05-17-" etc. right after "2026-" is only a MONTH-DAY continuation, which the shared
  // idClaimPattern exclusion recognizes and skips, resolving the real id-2026 plan uniquely.
  assert.equal(
    resolvePlanRel(plans, '2026'),
    'docs/superpowers/plans/ready/2026-FABLE-price-thing.md',
  );
  // The exact-basename fast path still resolves a dated file by its full name.
  assert.equal(
    resolvePlanRel(plans, '2026-05-17-adaptive-bouncing-castle-uiux-session.md'),
    'docs/superpowers/plans/archive/2026-05-17-adaptive-bouncing-castle-uiux-session.md',
  );
  // A genuinely duplicated id (two real `2026-<letter>…` plans) still throws ambiguous.
  const dupPlans = [...plans, 'docs/superpowers/plans/waiting-blocked/2026-Other-duplicate-id.md'];
  assert.throws(() => resolvePlanRel(dupPlans, '2026'), /ambiguous/);
});

test('resolvePlanRel: a malformed/unrecognized id-prefixed basename still counts as an ambiguity candidate, never silently dropped', () => {
  // idClaimPattern excludes ONLY the proven false-positive shape (a bare
  // `YYYY-MM-DD-` continuation with no real id) — anything else that starts with
  // `<id>-`, however unconventional, must still surface as a collision rather than
  // vanish from the scan (a review-caught risk of an allow-list-only anchor).
  const plans = [
    'docs/superpowers/plans/ready/2026-FABLE-price-thing.md',
    'docs/superpowers/plans/waiting-operator/2026-24-hour-vet-audit.md',
  ];
  assert.throws(() => resolvePlanRel(plans, '2026'), /ambiguous/);
});

test('rewriteBlockedByHeader: seedLane off + no SEED-WRITE banner ⇒ insert after H1, no throw', () => {
  const content = '# 050-X-foo\n\nSome body.\n';
  const out = rewriteBlockedByHeader(content, 'waiting-blocked', 'plan 999 first', {
    seedLane: false,
  });
  assert.match(out, /\*\*Blocked-by:\*\* plan 999 first/);
  assert.match(out, /^# 050-X-foo/m);
});

test("rewriteBlockedByHeader: seedLane on + no banner ⇒ still throws (today's behavior)", () => {
  assert.throws(
    () => rewriteBlockedByHeader('# 050-X-foo\n\nbody\n', 'waiting-blocked', 'r'),
    /no SEED-WRITE banner/,
  );
});

test('VALID_TARGETS covers the seven active folders plus archive', () => {
  for (const t of [
    'in-progress',
    'ready',
    'waiting-blocked',
    'waiting-operator',
    'waiting-grill',
    'waiting-date',
    'waiting-trip',
    'archive',
  ]) {
    assert.ok(VALID_TARGETS.includes(t), `${t} missing`);
  }
});

// plan 1371 (D5): `drafting/` is retired from the taxonomy WHOLE — replaced by
// `pending-approval/` as the sanctioned resting spot for a fresh mint (D1/D2/D4).
// VALID_TARGETS is derived from STATUS_ORDER (build-index-lib.mjs), so this pins the
// swap at the move-plan surface: the new name is a legal move target, the old one isn't.
test('VALID_TARGETS: pending-approval/ is accepted, drafting/ is rejected (plan 1371)', () => {
  assert.ok(
    VALID_TARGETS.includes('pending-approval'),
    'pending-approval missing from VALID_TARGETS',
  );
  assert.ok(!VALID_TARGETS.includes('drafting'), 'drafting must be retired from VALID_TARGETS');
});

// plan 1426: parked/ is a legal move target/source (a plain, reversible freeze) even
// though it is NOT a STATUS_ORDER member — VALID_TARGETS adds it explicitly alongside
// archive.
test('VALID_TARGETS: parked/ is accepted (plan 1426)', () => {
  assert.ok(VALID_TARGETS.includes('parked'), 'parked missing from VALID_TARGETS');
});

// End-to-end smoke (plan 1371): the CLI itself rejects `drafting` with the same message
// shape as any other unknown target, naming pending-approval among the valid options.
test('move-plan: CLI rejects "drafting" as an unknown target, naming valid options', () => {
  const repo = makeRepoWithPlan();
  try {
    const res = runMovePlan(repo.dir, ['050', 'drafting']);
    assert.notEqual(
      res.code,
      0,
      `expected non-zero exit\nstdout:${res.stdout}\nstderr:${res.stderr}`,
    );
    const io = `${res.stderr}${res.stdout}`;
    assert.match(io, /invalid target "drafting"/);
    assert.match(io, /pending-approval/);
  } finally {
    repo.cleanup();
  }
});

// Task 1 (plan 486) — the half-applied-rename regression. A move into a waiting-*
// target WITHOUT --blocked-by must fail BEFORE any filesystem mutation, leaving a
// clean working tree. On the pre-fix code the `git mv` ran first and the throw from
// the header rewrite was uncaught, stranding a staged rename (and breaking the retry
// with "already in <target>/"). Bit 4 sessions / 5 plans on 2026-06-08/09.
test('move-plan: waiting-* target without --blocked-by exits non-zero AND leaves a clean tree', () => {
  const repo = makeRepoWithPlan();
  try {
    const res = runMovePlan(repo.dir, ['050', 'waiting-trip']);
    // (a) non-zero exit, with the requires-blocked-by message
    assert.notEqual(
      res.code,
      0,
      `expected non-zero exit\nstdout:${res.stdout}\nstderr:${res.stderr}`,
    );
    assert.match(`${res.stderr}${res.stdout}`, /requires --blocked-by/);
    // (b) MAIN's tracked tree CLEAN — no staged rename, no INDEX churn, no half-move.
    // --untracked-files=no excludes the disposable .claude/coord-worktree the plan-995
    // wrapper materialises even on a validation-error path (it resolves the coord-checkout
    // before mainImpl runs its arg validation); we only care that no TRACKED file moved.
    const status = repo.g('status', '--porcelain', '--untracked-files=no').trim();
    assert.equal(status, '', `expected a clean tree, got:\n${status}`);
    // file still in ready/, NOT in waiting-trip/
    assert.ok(existsSync(join(repo.dir, repo.readyRel)), 'plan should remain in ready/');
    assert.ok(
      !existsSync(join(repo.dir, 'docs/superpowers/plans/waiting-trip', repo.basename)),
      'plan must NOT have moved into waiting-trip/',
    );
  } finally {
    repo.cleanup();
  }
});

// Done-criterion (plan 486): a NORMAL move with a valid --blocked-by still works
// end-to-end — mv → Blocked-by header → build-index → commit → push — and leaves a
// clean tree. Runs the COPIED tool tree so the spawned build-index touches the temp
// repo, not the real one.
test('move-plan: a valid waiting-* move runs end-to-end (mv → header → build-index → commit → push)', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', 'waiting-trip', '--blocked-by', 'plan 999 landing'],
      repo.movePlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    // The move is isolated in the coord-checkout → it lands on origin/master, NOT in MAIN's
    // working tree (plan 995). Assert the outcome on origin, like the 989 claim-plan tests.
    repo.g('fetch', '-q', 'origin', 'master');
    const movedRel = `docs/superpowers/plans/waiting-trip/${repo.basename}`;
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(
      tree,
      /waiting-trip\/050-Infra-foo\.md/,
      'plan should be in waiting-trip/ on origin',
    );
    assert.doesNotMatch(
      tree,
      /ready\/050-Infra-foo\.md/,
      'plan should no longer be in ready/ on origin',
    );
    // Blocked-by header inserted (read the committed body on origin)
    assert.match(
      repo.g('show', `origin/master:${movedRel}`),
      /\*\*Blocked-by:\*\* plan 999 landing/,
    );
    // INDEX regenerated with the bullet pointing at the new path
    assert.match(
      repo.g('show', 'origin/master:docs/INDEX.md'),
      /→ `waiting-trip\/050-Infra-foo\.md`/,
    );
    // MAIN's tracked tree is untouched by the isolated move.
    assert.equal(
      repo.g('status', '--porcelain', '--untracked-files=no').trim(),
      '',
      'MAIN tracked tree should be untouched',
    );
    assert.match(
      repo.g('log', 'origin/master', '-1', '--format=%s').trim(),
      /move 050-Infra-foo\.md/,
    );
  } finally {
    repo.cleanup();
  }
});

// plan 1362 (D2) — a promotion auto-stamps the FABLE- filename segment as PART of the
// SAME `git mv` when the plan's frontmatter already carries execModel: fable but the
// filename doesn't (a legacy plan, or one whose spec-pass ran post-mint) — never a
// separate follow-up commit (E2).
test('move-plan: promoting a plan with execModel: fable auto-stamps the FABLE- filename segment (plan 1362)', () => {
  const FABLE_BODY = DEFAULT_PLAN_BODY.replace(
    '---\nsummary: Test plan for the move-plan happy path\n---',
    '---\nsummary: Test plan for the move-plan happy path\nexecModel: fable\n---',
  );
  const repo = makeIsolatedRepo({ startFolder: 'pending-approval', body: FABLE_BODY });
  try {
    const res = runMovePlan(repo.dir, ['050', 'ready'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stdout, /renamed to 050-FABLE-Infra-foo\.md/);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/050-FABLE-Infra-foo\.md/, 'plan renamed + moved on origin');
    assert.doesNotMatch(tree, /ready\/050-Infra-foo\.md$/m, 'no unstamped duplicate in ready/');
    const body = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/ready/050-FABLE-Infra-foo.md',
    );
    assert.match(body, /^execModel: fable$/m);
    assert.match(
      repo.g('show', 'origin/master:docs/INDEX.md'),
      /→ `ready\/050-FABLE-Infra-foo\.md`/,
      'INDEX bullet points at the stamped filename',
    );
  } finally {
    repo.cleanup();
  }
});

// Plan 3656: the Tier-0 backfill stamps whatever lane scripts/exec-model-default.json
// names, so the promotion's filename segment (none for `sonnet`, a marker for
// `fable`/`sol`) is derived from that toggle. The rename-in-the-same-commit property
// this test guards still matters for the explicit-FABLE case below.
test('move-plan: ready promotion backfills exempt-mechanical to the default lane, matching filename segment', () => {
  const body = DEFAULT_PLAN_BODY.replace(
    '---\nsummary: Test plan for the move-plan happy path\n---',
    '---\nsummary: Test plan for the move-plan happy path\nstage: stub\nspecReview: exempt-mechanical\n---',
  );
  const repo = makeIsolatedRepo({ startFolder: 'pending-approval', body });
  try {
    const res = runMovePlan(repo.dir, ['050', 'ready'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const rel = `docs/superpowers/plans/ready/050-${DEFAULT_SEG}Infra-foo.md`;
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, new RegExp(`ready/050-${DEFAULT_SEG}Infra-foo\\.md`));
    assert.match(
      repo.g('show', `origin/master:${rel}`),
      new RegExp(`^execModel: ${DEFAULT_LANE}$`, 'm'),
    );
  } finally {
    repo.cleanup();
  }
});

test('move-plan: explicit FABLE lane wins over the exempt-mechanical default backfill', () => {
  const body = DEFAULT_PLAN_BODY.replace(
    '---\nsummary: Test plan for the move-plan happy path\n---',
    '---\nsummary: Test plan for the move-plan happy path\nstage: stub\nspecReview: exempt-mechanical\nexecModel: fable\n---',
  );
  const repo = makeIsolatedRepo({ startFolder: 'pending-approval', body });
  try {
    const res = runMovePlan(repo.dir, ['050', 'ready'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const rel = 'docs/superpowers/plans/ready/050-FABLE-Infra-foo.md';
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/050-FABLE-Infra-foo\.md/);
    const written = repo.g('show', `origin/master:${rel}`);
    assert.match(written, /^execModel: fable$/m);
    assert.doesNotMatch(written, /^execModel: sol$/m);
    assert.doesNotMatch(written, /^execModel: sonnet$/m);
  } finally {
    repo.cleanup();
  }
});

test('move-plan: in-progress/ is never auto-stamped, even with execModel: fable (worktree-coupled basename)', () => {
  const FABLE_BODY = DEFAULT_PLAN_BODY.replace(
    '---\nsummary: Test plan for the move-plan happy path\n---',
    '---\nsummary: Test plan for the move-plan happy path\nexecModel: fable\n---',
  );
  const repo = makeIsolatedRepo({ startFolder: 'pending-approval', body: FABLE_BODY });
  try {
    const res = runMovePlan(repo.dir, ['050', 'in-progress'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.doesNotMatch(res.stdout, /renamed to/);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /in-progress\/050-Infra-foo\.md/, 'unstamped basename preserved');
    assert.doesNotMatch(tree, /FABLE/, 'no auto-stamp in in-progress/');
  } finally {
    repo.cleanup();
  }
});

// Task 3 (plan 486) belt-and-suspenders: a downstream failure AFTER the `git mv`
// (here build-index throws because docs/INDEX.md is missing) must STILL roll the
// tree back clean — exercises the committed=false branch of the path-scoped
// rollback, the case the old push-only catch never covered.
test('move-plan: a post-`git mv` downstream throw rolls the tree back clean', () => {
  const repo = makeIsolatedRepo();
  try {
    // Drop docs/INDEX.md from ORIGIN so the disposable coord-checkout (reset to origin/master each
    // attempt) lacks it → the in-process regenerateIndex throws ENOENT mid-move, a genuine
    // post-`git mv`, pre-commit failure that drives the committed=false rollback. Pre-isolation
    // (plan 995) this removed MAIN's INDEX; now the move runs in the coord-checkout, so the failure
    // must be injected on the tree the coord-checkout resets to — origin.
    repo.g('rm', '-q', 'docs/INDEX.md');
    repo.g('commit', '-qm', 'drop index');
    repo.g('push', '-q', 'origin', 'master');
    const res = runMovePlan(
      repo.dir,
      ['050', 'waiting-trip', '--blocked-by', 'plan 999 landing'],
      repo.movePlan,
    );
    assert.notEqual(
      res.code,
      0,
      `expected non-zero exit\nstdout:${res.stdout}\nstderr:${res.stderr}`,
    );
    // MAIN's tracked tree is clean (the coord-checkout is untracked-in-MAIN noise).
    assert.equal(
      repo.g('status', '--porcelain', '--untracked-files=no').trim(),
      '',
      'MAIN tracked tree should be clean after rollback',
    );
    // The move rolled back on origin: the plan is still in ready/, never stranded in waiting-trip/.
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(
      tree,
      /ready\/050-Infra-foo\.md/,
      'plan should remain in ready/ on origin after rollback',
    );
    assert.doesNotMatch(
      tree,
      /waiting-trip\/050-Infra-foo\.md/,
      'plan must NOT be stranded in waiting-trip/ on origin',
    );
  } finally {
    repo.cleanup();
  }
});

// plan 492 / 995. The plan-492 scenario — an UNCOMMITTED edit in MAIN's working tree carried
// through `git mv` and lost on a non-ff rollback — is STRUCTURALLY ELIMINATED by plan-995
// isolation: the standalone move now runs in the disposable coord-checkout (a fresh reset of
// origin/master), so it never reads MAIN's working tree, and an uncommitted MAIN edit simply
// isn't part of the move. What still matters, and is exercised here, is that the non-ff RETRY
// itself is correct: a forced single non-ff during the push must roll the coord-checkout back
// cleanly and the retry must re-land the move on origin. The one-shot pre-push hook lives in the
// shared .git/hooks, so it fires on the coord-checkout's push too.
test('move-plan: a promotion survives a forced non-ff retry and lands on origin (plan 492/995)', () => {
  const repo = makeIsolatedRepo();
  try {
    installOneShotNonFfHook(repo.dir, repo.origin);
    // Promote ready/ → in-progress/. The hook fires on attempt 1's push → non-ff → rollback →
    // attempt 2 lands.
    const res = runMovePlan(repo.dir, ['050', 'in-progress'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);

    repo.g('fetch', '-q', 'origin', 'master');
    // Sanity: the race actually fired (the sibling's neutral commit reached origin) — so
    // a green here means the rollback-retry path was exercised, not that we skipped it.
    assert.match(
      repo.g('ls-tree', '--name-only', 'origin/master').toString(),
      /sibling-neutral\.txt/,
      'the forced non-ff must have happened (sibling commit on origin)',
    );
    // The promotion landed on origin: in-progress/, gone from ready/.
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(
      tree,
      /in-progress\/050-Infra-foo\.md/,
      'plan should be in in-progress/ on origin',
    );
    assert.doesNotMatch(
      tree,
      /ready\/050-Infra-foo\.md/,
      'plan should no longer be in ready/ on origin',
    );
    // MAIN's tracked tree is untouched by the isolated move.
    assert.equal(
      repo.g('status', '--porcelain', '--untracked-files=no').trim(),
      '',
      'MAIN tracked tree should be untouched',
    );
  } finally {
    repo.cleanup();
  }
});

test('move-plan: push catch routes ff-abort wording through isNonFastForward', () => {
  const source = readFileSync(MOVE_PLAN, 'utf8');
  assert.match(source, /if \(isNonFastForward\(e\)\)/);
  assert.doesNotMatch(source, /\/non-fast-forward\|fetch first\|rejected\/i/);
  assert.equal(
    isNonFastForward({ stderr: 'fatal: Not possible to fast-forward, aborting.' }),
    true,
  );
});

// ───────────────────────── plan 619: body-state-sync ─────────────────────────

// ── assertTripConditionOk (pure) ─────────────────────────────────────────────
test('assertTripConditionOk: no-op for non-waiting-trip targets', () => {
  for (const t of ['ready', 'in-progress', 'archive', 'waiting-blocked', 'waiting-operator'])
    assert.doesNotThrow(() => assertTripConditionOk(t, '# T\n\nno trip here'));
});

test('assertTripConditionOk: waiting-trip requires a trip-condition; passes when present', () => {
  assert.throws(
    () => assertTripConditionOk('waiting-trip', '# T\n\nno revival signal'),
    /requires a trip-condition/,
  );
  assert.doesNotThrow(() =>
    assertTripConditionOk('waiting-trip', '## Trip-condition\n\nrevive if X recurs'),
  );
});

// ── assertUnblockOk (pure) ───────────────────────────────────────────────────
test('assertUnblockOk: no-op for non-waiting-operator targets', () => {
  for (const t of ['ready', 'in-progress', 'archive', 'waiting-blocked', 'waiting-trip'])
    assert.doesNotThrow(() => assertUnblockOk(t, '# T', undefined));
});

test('assertUnblockOk: waiting-operator requires an unblock field or a valid --unblock flag', () => {
  // no flag, no frontmatter field → throws (cost is no longer offered — plan 1065)
  assert.throws(
    () => assertUnblockOk('waiting-operator', '# T\n\nbody', undefined),
    /requires an "unblock: manual\|decision"/,
  );
  // a valid flag → passes (setUnblock writes it in the body rewrite)
  assert.doesNotThrow(() => assertUnblockOk('waiting-operator', '# T', 'decision'));
  // an existing valid frontmatter field → passes
  assert.doesNotThrow(() =>
    assertUnblockOk('waiting-operator', '---\nunblock: manual\n---\n# T', undefined),
  );
  // an invalid flag → throws
  assert.throws(
    () => assertUnblockOk('waiting-operator', '# T', 'nonsense'),
    /--unblock must be one of/,
  );
  // an existing invalid field → throws
  assert.throws(
    () => assertUnblockOk('waiting-operator', '---\nunblock: bogus\n---\n# T', undefined),
    /is invalid/,
  );
});

// plan 1065: cost is never an operator hold. assertUnblockOk rejects a `cost` value
// arriving as either a --unblock flag or an existing body frontmatter, pointing to ready/.
test('assertUnblockOk: cost is rejected for waiting-operator (flag and existing frontmatter)', () => {
  assert.throws(
    () => assertUnblockOk('waiting-operator', '# T', 'cost'),
    /cost is not an operator hold/,
  );
  assert.throws(
    () => assertUnblockOk('waiting-operator', '---\nunblock: cost\n---\n# T', undefined),
    /cost is not an operator hold/,
  );
});

// ── plan 1260: a ready/ target must carry a parseable Cost forecast banner ────
test('assertCostBannerOk: no-op for non-ready targets (banner not required there)', () => {
  for (const t of ['in-progress', 'archive', 'waiting-blocked', 'waiting-operator', 'waiting-trip'])
    assert.doesNotThrow(() => assertCostBannerOk(t, '# T\n\nbody', '050-Infra-foo.md'));
});

test('assertCostBannerOk: ready target refuses a bannerless body, passes a bannered one', () => {
  assert.throws(
    () =>
      assertCostBannerOk('ready', sw('> 🟩 **SEED-WRITE: no**\n\n# T\n\nbody'), '050-Infra-foo.md'),
    /no parseable 💰 Cost forecast banner/,
  );
  assert.doesNotThrow(() =>
    assertCostBannerOk(
      'ready',
      sw('> 🟩 **SEED-WRITE: no**\n> 💰 **Cost forecast:** $0 — no LLM spend.\n\n# T\n\nbody'),
      '050-Infra-foo.md',
    ),
  );
});

// ── plan 1292: a ready/ target must have cleared spec-pass (stage/specReview gate) ──
test('assertSpecReviewOk: no-op for non-ready targets, even on a bare stub', () => {
  const stub = '---\nstage: stub\n---\n# T\n\nbody';
  for (const t of ['in-progress', 'archive', 'waiting-blocked', 'waiting-operator', 'waiting-trip'])
    assert.doesNotThrow(() => assertSpecReviewOk(t, stub, '050-Infra-foo.md'));
});

test('assertSpecReviewOk: ready target refuses stage: stub without a specReview stamp', () => {
  assert.throws(
    () => assertSpecReviewOk('ready', '---\nstage: stub\n---\n# T\n\nbody', '050-Infra-foo.md'),
    /stage: stub without a specReview stamp/,
  );
});

test('assertSpecReviewOk: ready target allows stage: stub with a sha-shaped specReview', () => {
  assert.doesNotThrow(() =>
    assertSpecReviewOk(
      'ready',
      '---\nstage: stub\nspecReview: 328a351c0\n---\n# T\n\nbody',
      '050-Infra-foo.md',
    ),
  );
});

test('assertSpecReviewOk: ready target allows stage: stub with specReview: exempt-mechanical', () => {
  assert.doesNotThrow(() =>
    assertSpecReviewOk(
      'ready',
      '---\nstage: stub\nspecReview: exempt-mechanical\n---\n# T\n\nbody',
      '050-Infra-foo.md',
    ),
  );
});

test('assertSpecReviewOk: ready target allows a missing/empty stage field (legacy grandfather)', () => {
  assert.doesNotThrow(() =>
    assertSpecReviewOk('ready', '# T\n\nno frontmatter at all', '050-Infra-foo.md'),
  );
  assert.doesNotThrow(() =>
    assertSpecReviewOk('ready', '---\nsummary: hi\n---\n# T\n\nbody', '050-Infra-foo.md'),
  );
});

test('assertSpecReviewOk: ready target allows stage: specced regardless of specReview', () => {
  assert.doesNotThrow(() =>
    assertSpecReviewOk('ready', '---\nstage: specced\n---\n# T\n\nbody', '050-Infra-foo.md'),
  );
});

// ── plan 1292 bugfix: assertSpecReviewOk now delegates to the shared
// specReviewGateError, which is case-insensitive on `stage` and strips a
// trailing YAML comment off `specReview` before checking it's non-empty.
test('assertSpecReviewOk: case-insensitive stage compare (STUB / Stub still gate)', () => {
  assert.throws(
    () => assertSpecReviewOk('ready', '---\nstage: STUB\n---\n# T\n\nbody', '050-Infra-foo.md'),
    /stage: stub without a specReview stamp/,
  );
  assert.doesNotThrow(() =>
    assertSpecReviewOk('ready', '---\nstage: SPECCED\n---\n# T\n\nbody', '050-Infra-foo.md'),
  );
});

test('assertSpecReviewOk: a comment-suffixed specReview still satisfies the gate', () => {
  assert.doesNotThrow(() =>
    assertSpecReviewOk(
      'ready',
      '---\nstage: stub\nspecReview: exempt-mechanical # no judgment call here\n---\n# T\n\nbody',
      '050-Infra-foo.md',
    ),
  );
});

// ── plan 2943: the evidence-floor promotion gate ──────────────────────────────
// plan 4071 T2/D1/D2: the gated-category list moved from the module-level
// EVIDENCE_GATED_CATEGORIES literal to coord.config.json's planCategories.evidenceGated, and
// assertEvidenceFloorOk now takes it as a PARAMETER (default `[]` — D1: empty means no category
// is gated). Every call below that means to exercise the REAL gate threads VETAPP_PLAN_CATEGORIES
// .evidenceGated through explicitly; the byte-identity of that list against the taxonomy is
// pinned in build-index-lib.test.mjs (the leaf module that now owns assertEvidenceFloorOk).
test('assertEvidenceFloorOk: no-op for non-ready targets, even latent + a gated category', () => {
  const latent = '---\nevidence: latent\n---\n# T\n\nbody';
  for (const t of ['in-progress', 'archive', 'waiting-blocked', 'waiting-operator', 'waiting-trip'])
    assert.doesNotThrow(() =>
      assertEvidenceFloorOk(t, latent, '050-Pipe-foo.md', VETAPP_PLAN_CATEGORIES.evidenceGated),
    );
});

test('assertEvidenceFloorOk: ready target REFUSES a gated category stamped evidence: latent', () => {
  for (const category of VETAPP_PLAN_CATEGORIES.evidenceGated) {
    assert.throws(
      () =>
        assertEvidenceFloorOk(
          'ready',
          '---\nevidence: latent\n---\n# T\n\nbody',
          `050-${category}-foo.md`,
          VETAPP_PLAN_CATEGORIES.evidenceGated,
        ),
      /evidence: latent/,
      `expected a refusal for category ${category}`,
    );
  }
});

test('assertEvidenceFloorOk: the refusal names both return paths and the stamp command', () => {
  assert.throws(
    () =>
      assertEvidenceFloorOk(
        'ready',
        '---\nevidence: latent\n---\n# T\n\nbody',
        '050-Pipe-foo.md',
        VETAPP_PLAN_CATEGORIES.evidenceGated,
      ),
    (e) =>
      /fold it to a line/.test(e.message) &&
      /upgrade the class/.test(e.message) &&
      /stamp-evidence\.mjs/.test(e.message),
  );
});

test('assertEvidenceFloorOk: ready target allows a gated category with an observed-* class', () => {
  for (const value of ['observed-wave', 'observed-live', 'observed-measured', 'operator']) {
    assert.doesNotThrow(() =>
      assertEvidenceFloorOk(
        'ready',
        `---\nevidence: ${value}\n---\n# T\n\nbody`,
        '050-Pipe-foo.md',
        VETAPP_PLAN_CATEGORIES.evidenceGated,
      ),
    );
  }
});

test('assertEvidenceFloorOk: a MISSING evidence key never refuses (forward-only, grandfathered pool)', () => {
  assert.doesNotThrow(() =>
    assertEvidenceFloorOk(
      'ready',
      '---\nsummary: hi\n---\n# T\n\nbody',
      '050-Pipe-foo.md',
      VETAPP_PLAN_CATEGORIES.evidenceGated,
    ),
  );
  assert.doesNotThrow(() =>
    assertEvidenceFloorOk(
      'ready',
      '# T with no frontmatter at all\n\nbody',
      '050-Pipe-foo.md',
      VETAPP_PLAN_CATEGORIES.evidenceGated,
    ),
  );
});

test('assertEvidenceFloorOk: Infra/Coord plans route unaffected regardless of the stamp', () => {
  for (const category of ['Infra', 'Coord']) {
    assert.doesNotThrow(() =>
      assertEvidenceFloorOk(
        'ready',
        '---\nevidence: latent\n---\n# T\n\nbody',
        `050-${category}-foo.md`,
        VETAPP_PLAN_CATEGORIES.evidenceGated,
      ),
    );
  }
});

test('assertEvidenceFloorOk: SEO/Biz/Other plans are deliberately ungated for now', () => {
  for (const category of ['SEO', 'Biz', 'Other']) {
    assert.doesNotThrow(() =>
      assertEvidenceFloorOk(
        'ready',
        '---\nevidence: latent\n---\n# T\n\nbody',
        `050-${category}-foo.md`,
        VETAPP_PLAN_CATEGORIES.evidenceGated,
      ),
    );
  }
});

test('assertEvidenceFloorOk: plan 2896 — MAIL is ungated BY CONSTRUCTION, not "for now"', () => {
  // Distinct from the SEO/Biz/Other case above, which is a not-yet decision. A MAIL plan is
  // minted by /clinic-correction-intake with `--evidence observed-live` always — a clinic
  // reporting on the live site IS a live observation — so `evidence: latent` can never occur
  // on one and gating the category would only add a trap. The runbook (§ Mail-originated
  // plans) says "do not fix that by adding it"; this pins the promise so a later sweep that
  // adds MAIL to coord.config.json's planCategories.evidenceGated goes red here instead of
  // silently blocking the one plan class a stranger is waiting on.
  assert.ok(
    !VETAPP_PLAN_CATEGORIES.evidenceGated.includes('MAIL'),
    'MAIL must stay out of planCategories.evidenceGated (plan 2896 ruling)',
  );
  assert.doesNotThrow(() =>
    assertEvidenceFloorOk(
      'ready',
      '---\nevidence: latent\n---\n# T\n\nbody',
      '050-MAIL-foo.md',
      VETAPP_PLAN_CATEGORIES.evidenceGated,
    ),
  );
});

test('assertEvidenceFloorOk: case-insensitive on the evidence value (LATENT still gates)', () => {
  assert.throws(() =>
    assertEvidenceFloorOk(
      'ready',
      '---\nevidence: LATENT\n---\n# T\n\nbody',
      '050-Pipe-foo.md',
      VETAPP_PLAN_CATEGORIES.evidenceGated,
    ),
  );
});

test('assertEvidenceFloorOk: a FABLE- exec-model segment is stripped before matching the category', () => {
  assert.throws(
    () =>
      assertEvidenceFloorOk(
        'ready',
        '---\nevidence: latent\n---\n# T\n\nbody',
        '050-FABLE-DQ-foo.md',
        VETAPP_PLAN_CATEGORIES.evidenceGated,
      ),
    /category "DQ"/,
  );
  // an exempt category still routes unaffected even carrying the FABLE- segment
  assert.doesNotThrow(() =>
    assertEvidenceFloorOk(
      'ready',
      '---\nevidence: latent\n---\n# T\n\nbody',
      '050-FABLE-Infra-foo.md',
      VETAPP_PLAN_CATEGORIES.evidenceGated,
    ),
  );
});

// plan 4071 D1: an OMITTED evidenceGatedCategories degrades to `[]` — "no category is gated" —
// never "reject everything". Kept distinct from the unit test in build-index-lib.test.mjs (that
// one pins the leaf function's default in isolation; this one pins that move-plan.mjs's
// re-exported reference behaves identically).
test('assertEvidenceFloorOk: an omitted evidenceGatedCategories parameter never refuses (D1 default is empty)', () => {
  assert.doesNotThrow(() =>
    assertEvidenceFloorOk('ready', '---\nevidence: latent\n---\n# T\n\nbody', '050-Pipe-foo.md'),
  );
});

test('assertEvidenceFloorOk: a malformed/legacy basename no-ops rather than refusing', () => {
  assert.doesNotThrow(() =>
    assertEvidenceFloorOk(
      'ready',
      '---\nevidence: latent\n---\n# T\n\nbody',
      'not-a-plan-name.md',
      VETAPP_PLAN_CATEGORIES.evidenceGated,
    ),
  );
});

// End-to-end: the real CLI wires assertEvidenceFloorOk into the ready/ promotion path.
const LATENT_PIPE_BODY = [
  '---',
  'summary: Test plan for the evidence-floor gate',
  'stage: specced',
  'specReview: exempt-mechanical',
  'evidence: latent',
  '---',
  '',
  sw('> 🟩 **SEED-WRITE: no**'),
  '> 💰 **Cost forecast:** $0 — no LLM spend.',
  '',
  '**Status:** ⏸ WAITING-BLOCKED — parked 2026-08-06.',
  '',
  '**Blocked-by:** an unrelated dependency',
  '',
  '# 050-Pipe-foo',
  '',
  'Body.',
  '',
].join('\n');

test('move-plan: a Pipe plan stamped evidence: latent is refused at the ready/ promotion (plan 2943)', () => {
  const repo = makeIsolatedRepo({
    startFolder: 'waiting-blocked',
    basename: '050-Pipe-foo.md',
    body: LATENT_PIPE_BODY,
  });
  // plan 4071 D1/D2: the isolated fixture repo carries no coord.config.json of its own, and an
  // absent planCategories.evidenceGated degrades to `[]` — no category gated — so the CLI would
  // NOT refuse this promotion without an explicit config row naming "Pipe" gated, the same way
  // vetapp's own coord.config.json does. UNLIKE the direct-import buildClaimOps/probe fixtures
  // elsewhere in this file, move-plan's real CLI (`main()`) redirects mainImpl's resolveMain()
  // through a DISPOSABLE `.claude/coord-worktree` reset to the fresh origin/master tip
  // (withCoordCheckout) — so an uncommitted coord.config.json on repo.dir's working tree is
  // invisible to it; it must be committed + pushed to origin, exactly like the seed plan file.
  writeFileSync(
    join(repo.dir, 'coord.config.json'),
    JSON.stringify({ planCategories: { evidenceGated: VETAPP_PLAN_CATEGORIES.evidenceGated } }),
  );
  repo.g('add', 'coord.config.json');
  repo.g('commit', '-qm', 'plan 4071 test fixture: gate Pipe on the evidence floor');
  repo.g('push', '-q', 'origin', 'master');
  try {
    const res = runMovePlan(repo.dir, ['050', 'ready'], repo.movePlan);
    assert.notEqual(
      res.code,
      0,
      `expected non-zero exit\nstdout:${res.stdout}\nstderr:${res.stderr}`,
    );
    assert.match(`${res.stderr}${res.stdout}`, /evidence: latent/);
    assert.match(`${res.stderr}${res.stdout}`, /stamp-evidence\.mjs/);
    const status = repo.g('status', '--porcelain', '--untracked-files=no').trim();
    assert.equal(status, '', `expected a clean tree, got:\n${status}`);
  } finally {
    repo.cleanup();
  }
});

test('move-plan: the SAME Pipe plan promotes fine once re-stamped observed-* (plan 2943)', () => {
  const repo = makeIsolatedRepo({
    startFolder: 'waiting-blocked',
    basename: '050-Pipe-foo.md',
    body: LATENT_PIPE_BODY.replace('evidence: latent', 'evidence: observed-wave'),
  });
  try {
    const res = runMovePlan(repo.dir, ['050', 'ready'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    // Plan 3656: an exempt-mechanical ready promotion stamps whatever lane the toggle
    // names, so the basename marker (if any) is derived, not pinned.
    assert.match(
      tree,
      new RegExp(`ready/050-${DEFAULT_SEG}Pipe-foo\\.md`),
      'plan should be in ready/ on origin',
    );
  } finally {
    repo.cleanup();
  }
});

test('move-plan: an Infra plan stamped evidence: latent still promotes (exempt family, plan 2943)', () => {
  const repo = makeIsolatedRepo({
    startFolder: 'waiting-blocked',
    basename: '050-Infra-foo.md',
    body: LATENT_PIPE_BODY.replace('# 050-Pipe-foo', '# 050-Infra-foo'),
  });
  try {
    const res = runMovePlan(repo.dir, ['050', 'ready'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
  } finally {
    repo.cleanup();
  }
});

// ── plan 2973: cloudExec-unstamped WARN at the ready/ entry point ────────────
// DEFAULT_PLAN_BODY carries no `cloudExec:` key, so the plain-happy-path promotion
// above already exercises the warn case incidentally; these tests pin the warning
// TEXT and the silent case explicitly, and prove the promotion outcome is IDENTICAL
// either way (never a refusal, never a changed exit code).

test('move-plan: promoting a cloudExec-less plan to ready/ emits ONE stderr warning naming the stamp command, and still succeeds', () => {
  const repo = makeIsolatedRepo({ startFolder: 'pending-approval' });
  try {
    const res = runMovePlan(repo.dir, ['050', 'ready'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /cloudExec: frontmatter key/);
    assert.match(res.stderr, /node scripts\/stamp-cloud-exec\.mjs 050 true /);
    assert.match(
      res.stderr,
      /node scripts\/stamp-cloud-exec\.mjs 050 false --reason "<why not cloud-safe>"/,
    );
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/050-Infra-foo\.md/, 'plan should still land in ready/ on origin');
  } finally {
    repo.cleanup();
  }
});

test('move-plan: a plan stamped cloudExec: false promotes to ready/ silently — false is a deliberate verdict, not absence', () => {
  const repo = makeIsolatedRepo({
    startFolder: 'pending-approval',
    body: DEFAULT_PLAN_BODY.replace(
      'summary: Test plan for the move-plan happy path',
      'summary: Test plan for the move-plan happy path\ncloudExec: false',
    ),
  });
  try {
    const res = runMovePlan(repo.dir, ['050', 'ready'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.doesNotMatch(res.stderr, /cloudExec: frontmatter key/);
  } finally {
    repo.cleanup();
  }
});

test('move-plan: a plan stamped cloudExec: true promotes to ready/ silently', () => {
  const repo = makeIsolatedRepo({
    startFolder: 'pending-approval',
    body: DEFAULT_PLAN_BODY.replace(
      'summary: Test plan for the move-plan happy path',
      'summary: Test plan for the move-plan happy path\ncloudExec: true',
    ),
  });
  try {
    const res = runMovePlan(repo.dir, ['050', 'ready'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.doesNotMatch(res.stderr, /cloudExec: frontmatter key/);
  } finally {
    repo.cleanup();
  }
});

test('move-plan: promoting a cloudExec-less plan to a NON-ready target (waiting-blocked/) emits no cloudExec warning', () => {
  const repo = makeIsolatedRepo({
    startFolder: 'pending-approval',
    body: DEFAULT_PLAN_BODY,
  });
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', 'waiting-blocked', '--blocked-by', 'an unrelated dependency'],
      repo.movePlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.doesNotMatch(res.stderr, /cloudExec: frontmatter key/);
  } finally {
    repo.cleanup();
  }
});

// ── waiting-trip without a trip-condition → fail-fast, CLEAN tree ─────────────
// The plan-486 fail-before-`git mv` discipline, extended to the body-dependent
// trip-condition gate: a waiting-trip move whose body has no trip-condition must
// exit non-zero and leave the working tree untouched (no half-applied rename).
test('move-plan: waiting-trip without a trip-condition exits non-zero AND leaves a clean tree', () => {
  const NO_TRIP = [
    '---',
    'summary: x',
    '---',
    '',
    sw('> 🟩 **SEED-WRITE: no**'),
    '',
    '**Status:** 📋 READY — opened 2026-06-01.',
    '',
    '# 050-Infra-foo',
    '',
    'Body with no revival signal.',
    '',
  ].join('\n');
  const repo = makeIsolatedRepo({ body: NO_TRIP });
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', 'waiting-trip', '--blocked-by', 'plan 999 landing'],
      repo.movePlan,
    );
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /requires a trip-condition/);
    // MAIN's tracked tree untouched (--untracked-files=no excludes the coord-checkout, plan 995).
    assert.equal(
      repo.g('status', '--porcelain', '--untracked-files=no').trim(),
      '',
      'MAIN tracked tree must be clean (no half-move)',
    );
    assert.ok(existsSync(join(repo.dir, repo.srcRel)), 'plan must remain in ready/');
    assert.ok(
      !existsSync(join(repo.dir, `docs/superpowers/plans/waiting-trip/${repo.basename}`)),
      'plan must NOT have moved into waiting-trip/',
    );
  } finally {
    repo.cleanup();
  }
});

// ── waiting-operator without unblock → fail-fast, CLEAN tree ──────────────────
test('move-plan: waiting-operator without an unblock field/flag exits non-zero AND leaves a clean tree', () => {
  const repo = makeIsolatedRepo(); // default body has NO unblock: field
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', 'waiting-operator', '--blocked-by', 'operator decision'],
      repo.movePlan,
    );
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /requires an "unblock: manual\|decision"/);
    assert.equal(
      repo.g('status', '--porcelain', '--untracked-files=no').trim(),
      '',
      'MAIN tracked tree must be clean',
    );
    assert.ok(existsSync(join(repo.dir, repo.srcRel)), 'plan must remain in ready/');
  } finally {
    repo.cleanup();
  }
});

// ── plan 1065: cost is never a blocker — `waiting-operator --unblock cost` → ready/ ──
// An explicit `--unblock cost` into waiting-operator/ is auto-routed to ready/ (the
// drain gates spend, so a cost-gated plan is safe there). It lands as a normal promotion
// — no --blocked-by required, Status restamped READY — and prints a routing notice.
test('move-plan: `waiting-operator --unblock cost` auto-routes to ready/ (plan 1065)', () => {
  // start in pending-approval/ so the redirect to ready/ is a real move (not a ready→ready no-op)
  const repo = makeIsolatedRepo({ startFolder: 'pending-approval' });
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', 'waiting-operator', '--unblock', 'cost'],
      repo.movePlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /Routing to ready\//);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/050-Infra-foo\.md/, 'plan should be routed to ready/ on origin');
    assert.doesNotMatch(
      tree,
      /waiting-operator\/050-Infra-foo\.md/,
      'plan must NOT have parked in waiting-operator/',
    );
    // routed as a promotion: no stale unblock:cost written into the ready/ body
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/050-Infra-foo.md');
    assert.doesNotMatch(body, /^unblock: cost$/m, 'the moot unblock:cost must not be stamped');
  } finally {
    repo.cleanup();
  }
});

test('move-plan: `--unblock COST` (uppercase) routes to ready/ and notes a dropped --blocked-by (plan 1065)', () => {
  const repo = makeIsolatedRepo({ startFolder: 'pending-approval' });
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', 'waiting-operator', '--unblock', 'COST', '--blocked-by', 'operator must $-OK first'],
      repo.movePlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /Routing to ready\//);
    assert.match(`${res.stderr}${res.stdout}`, /dropped/i);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/050-Infra-foo\.md/, 'plan should be routed to ready/ on origin');
    assert.doesNotMatch(tree, /waiting-operator\/050-Infra-foo\.md/);
  } finally {
    repo.cleanup();
  }
});

test('move-plan: `waiting-operator --unblock cost --dry` previews the ready/ redirect (plan 1065)', () => {
  const repo = makeIsolatedRepo({ startFolder: 'pending-approval' });
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', 'waiting-operator', '--unblock', 'cost', '--dry'],
      repo.movePlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /Routing to ready\//);
    // the dry preview is for a ready/ promotion, not a waiting-operator park
    assert.match(res.stdout, /ready\//);
    assert.doesNotMatch(res.stdout, /set unblock: cost/);
  } finally {
    repo.cleanup();
  }
});

// plan 1260 (review finding 1): the `--unblock cost` → ready/ reroute (plan 1065) collides
// with the new banner gate when the plan is BANNERLESS. The reroute must NOT silently land a
// bannerless plan in ready/; it is refused, the notice flags the banner requirement (coherent,
// not self-contradicting), and the plan stays put.
test('move-plan: `--unblock cost` on a bannerless plan is refused, notice flags the banner (plan 1260)', () => {
  const BANNERLESS_BODY = [
    '---',
    'summary: cost-gated but no banner',
    '---',
    '',
    sw('> 🟩 **SEED-WRITE: no**'),
    '',
    '**Status:** 📋 READY — opened 2026-07-02.',
    '',
    '# 050-Infra-foo',
    '',
    'Body.',
    '',
  ].join('\n');
  const repo = makeIsolatedRepo({ startFolder: 'pending-approval', body: BANNERLESS_BODY });
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', 'waiting-operator', '--unblock', 'cost'],
      repo.movePlan,
    );
    const io = `${res.stderr}${res.stdout}`;
    assert.notEqual(res.code, 0, `expected non-zero\n${io}`);
    // the reroute notice acknowledges the banner requirement (no bald "success" before the refusal)
    assert.match(io, /Routing to ready\//);
    assert.match(io, /must carry a 💰 Cost forecast banner/);
    // and the promotion is actually refused
    assert.match(io, /no parseable 💰 Cost forecast banner/);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(
      tree,
      /pending-approval\/050-Infra-foo\.md/,
      'plan must remain in pending-approval/ on origin',
    );
    assert.doesNotMatch(tree, /ready\/050-Infra-foo\.md/, 'bannerless plan must NOT reach ready/');
  } finally {
    repo.cleanup();
  }
});

// ── waiting-operator WITH --unblock decision → sets the frontmatter + moves ──
test('move-plan: a waiting-operator move with --unblock decision sets the frontmatter and moves', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runMovePlan(
      repo.dir,
      [
        '050',
        'waiting-operator',
        '--blocked-by',
        '[axis: policy] operator decision',
        '--unblock',
        'decision',
      ],
      repo.movePlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const movedRel = `docs/superpowers/plans/waiting-operator/${repo.basename}`;
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /waiting-operator\/050-Infra-foo\.md/,
      'plan should be in waiting-operator/ on origin',
    );
    const body = repo.g('show', `origin/master:${movedRel}`);
    assert.match(body, /^unblock: decision$/m, 'unblock: decision must be in the frontmatter');
    assert.match(
      body,
      /\*\*Blocked-by:\*\* \[axis: policy\] operator decision/,
      'Blocked-by line must be set',
    );
  } finally {
    repo.cleanup();
  }
});

// ── promotion from waiting-blocked → ready drops stale Blocked-by + restamps Status
test('move-plan: a promotion (waiting-blocked → ready) drops the stale Blocked-by and restamps Status', () => {
  const BLOCKED_BODY = [
    '---',
    'summary: x',
    '---',
    '',
    sw('> 🟩 **SEED-WRITE: no**'),
    '> 💰 **Cost forecast:** $0 — no LLM spend.', // plan 1260: needed to promote into ready/
    '',
    '**Status:** 🔄 IN PROGRESS — picked up 2026-06-01 by `H` in `worktree-050`.',
    '**Blocked-by:** plan 246 landing',
    '',
    '# 050-Infra-foo',
    '',
    'Body.',
    '',
  ].join('\n');
  const repo = makeIsolatedRepo({ startFolder: 'waiting-blocked', body: BLOCKED_BODY });
  try {
    const res = runMovePlan(repo.dir, ['050', 'ready'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const movedRel = `docs/superpowers/plans/ready/${repo.basename}`;
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/050-Infra-foo\.md/, 'plan should be in ready/ on origin');
    assert.doesNotMatch(
      tree,
      /waiting-blocked\/050-Infra-foo\.md/,
      'plan should no longer be in waiting-blocked/ on origin',
    );
    const body = repo.g('show', `origin/master:${movedRel}`);
    assert.ok(
      !body.includes('**Blocked-by:**'),
      'the stale Blocked-by must be dropped on promotion',
    );
    assert.match(
      body,
      /\*\*Status:\*\* 📋 READY — re-filed waiting-blocked→ready \d{4}-\d{2}-\d{2}\./,
      'Status must be restamped as a ready promotion',
    );
    assert.ok(!body.includes('🔄 IN PROGRESS'), 'the old IN PROGRESS status must be gone');
  } finally {
    repo.cleanup();
  }
});

// ── plan 1022/1371: release a stub to the orchestrator (pending-approval → ready) ──
// The documented release valve — a fresh mint lands in pending-approval/ (not auto-
// drainable); `move-plan <id> ready` hands it to the autonomous drain. A promotion
// (non-waiting target): drops no blocker, restamps Status to a READY promotion from
// pending-approval.
test('move-plan: pending-approval → ready releases a stub (the plan-1022/1371 orchestrator-handoff path)', () => {
  const DRAFT_BODY = [
    '---',
    'summary: a freshly minted draft',
    '---',
    '',
    sw('> 🟩 **SEED-WRITE: no**'),
    '> 💰 **Cost forecast:** $0 — no LLM spend.', // plan 1260: needed to release into ready/
    '',
    '**Status:** 📋 READY — opened 2026-06-24.',
    '',
    '# 050-Infra-foo',
    '',
    'Body.',
    '',
  ].join('\n');
  const repo = makeIsolatedRepo({ startFolder: 'pending-approval', body: DRAFT_BODY });
  try {
    const res = runMovePlan(repo.dir, ['050', 'ready'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/050-Infra-foo\.md/, 'plan should be released into ready/ on origin');
    assert.doesNotMatch(
      tree,
      /pending-approval\/050-Infra-foo\.md/,
      'plan should no longer be in pending-approval/ on origin',
    );
    const body = repo.g('show', `origin/master:docs/superpowers/plans/ready/${repo.basename}`);
    assert.match(
      body,
      /\*\*Status:\*\* 📋 READY — re-filed pending-approval→ready \d{4}-\d{2}-\d{2}\./,
      'Status restamped as a ready promotion from pending-approval',
    );
  } finally {
    repo.cleanup();
  }
});

// ── plan 1260: a bannerless promotion into ready/ is refused end-to-end, clean tree ──
// The whole point of the plan: catch the missing banner AT PROMOTION TIME (so the promoter
// fixes it), not at the next unrelated session's push (where lint-plan-cost-forecast blocks
// repo-wide). Fail-fast in the producer BEFORE the `git mv`, so the plan stays put on origin.
test('move-plan: a bannerless promotion into ready/ is refused AND leaves a clean tree (plan 1260)', () => {
  const BANNERLESS_BODY = [
    '---',
    'summary: a draft without a cost banner',
    '---',
    '',
    sw('> 🟩 **SEED-WRITE: no**'),
    '',
    '**Status:** 📋 READY — opened 2026-07-02.',
    '',
    '# 050-Infra-foo',
    '',
    'Body.',
    '',
  ].join('\n');
  const repo = makeIsolatedRepo({ startFolder: 'pending-approval', body: BANNERLESS_BODY });
  try {
    const res = runMovePlan(repo.dir, ['050', 'ready'], repo.movePlan);
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(
      `${res.stderr}${res.stdout}`,
      /no parseable 💰 Cost forecast banner/,
      'the refusal must name the missing banner',
    );
    assert.match(
      `${res.stderr}${res.stdout}`,
      /Cost forecast:\*\* Cash \$0 · Claude \$0/,
      'the refusal must show an example banner (shared help)',
    );
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(
      tree,
      /pending-approval\/050-Infra-foo\.md/,
      'plan must remain in pending-approval/ on origin',
    );
    assert.doesNotMatch(
      tree,
      /ready\/050-Infra-foo\.md/,
      'plan must NOT have been promoted to ready/',
    );
  } finally {
    repo.cleanup();
  }
});

// ── plan 3975 (T2b): move-plan <id> pending-approval --respec "<reason>" ──
// The sanctioned way to send a SPECCED plan back to pending-approval/ for a fresh
// spec-pass — withdraws stage: specced + specReview + specReviewBy and rewrites the
// Status line to the stub form, in ONE write/commit. Without --respec, the existing
// plan-1371 D7 refusal (a specced plan may not rest in pending-approval/) still stands.
const SPECCED_BODY = [
  '---',
  'summary: A specced plan that needs a fresh look',
  'stage: specced',
  'specReview: abc123def456',
  'specReviewBy: fable-5.1/medium',
  '---',
  '',
  sw('> 🟩 **SEED-WRITE: no**'),
  '> 💰 **Cost forecast:** $0 — no LLM spend.',
  '',
  '**Status:** 📋 READY — re-filed pending-approval→ready 2026-09-01.',
  '',
  '# 050-Infra-foo',
  '',
  'Body.',
  '',
].join('\n');

test('move-plan: pending-approval --respec withdraws stage: specced + specReview + specReviewBy and stamps the stub Status line, in one write', () => {
  const repo = makeIsolatedRepo({ startFolder: 'ready', body: SPECCED_BODY });
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', 'pending-approval', '--respec', 'operator wants a fresh look at scope'],
      repo.movePlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(
      tree,
      /pending-approval\/050-Infra-foo\.md/,
      'plan lands in pending-approval/ on origin',
    );
    assert.doesNotMatch(tree, /ready\/050-Infra-foo\.md/, 'plan left ready/');
    const body = repo.g(
      'show',
      `origin/master:docs/superpowers/plans/pending-approval/${repo.basename}`,
    );
    assert.match(body, /^stage: stub$/m, 'stage withdrawn to stub');
    assert.doesNotMatch(body, /^specReview:/m, 'specReview dropped outright');
    assert.doesNotMatch(body, /^specReviewBy:/m, 'specReviewBy dropped outright');
    assert.match(
      body,
      /\*\*Status:\*\* 📋 STUB — re-filed ready→pending-approval \d{4}-\d{2}-\d{2} \(--respec: operator wants a fresh look at scope\)\./,
      'Status line rewritten to the stub form, naming the respec reason',
    );
  } finally {
    repo.cleanup();
  }
});

test('move-plan: WITHOUT --respec, a specced plan sent to pending-approval/ still hits the D7 refusal, tree unchanged', () => {
  const repo = makeIsolatedRepo({ startFolder: 'ready', body: SPECCED_BODY });
  try {
    const res = runMovePlan(repo.dir, ['050', 'pending-approval'], repo.movePlan);
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(
      `${res.stderr}${res.stdout}`,
      /stage: specced in pending-approval\//,
      'the refusal must name the stage/folder violation',
    );
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/050-Infra-foo\.md/, 'plan must remain in ready/ on origin');
    assert.doesNotMatch(
      tree,
      /pending-approval\/050-Infra-foo\.md/,
      'plan must NOT have reached pending-approval/',
    );
  } finally {
    repo.cleanup();
  }
});

test('assertRespecOk: --respec is refused against any target other than pending-approval', () => {
  assert.throws(() => assertRespecOk('ready', 'some reason'), /only applies to a pending-approval/);
  assert.throws(
    () => assertRespecOk('waiting-operator', 'some reason'),
    /only applies to a pending-approval/,
  );
});

test('assertRespecOk: a flag-shaped or empty --respec reason is refused', () => {
  assert.throws(
    () => assertRespecOk('pending-approval', '--dry'),
    /looks like a flag, not a reason/,
  );
  assert.throws(() => assertRespecOk('pending-approval', ''), /looks like a flag, not a reason/);
});

test('assertRespecOk: no-ops when --respec was not passed at all, regardless of target', () => {
  assert.doesNotThrow(() => assertRespecOk('ready', undefined));
  assert.doesNotThrow(() => assertRespecOk('pending-approval', undefined));
});

// ── --no-push standalone is rejected (would be silently discarded, plan 995) ──
// A standalone move (COORD_MAIN_DIR unset, as runMovePlan spawns it) runs in the disposable
// coord-checkout, so a committed-but-unpushed move would be wiped by the next coord op's
// reset --hard. The wrapper fails fast instead of losing the move.
test('move-plan: --no-push standalone exits non-zero AND moves nothing (plan 995)', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runMovePlan(repo.dir, ['050', 'in-progress', '--no-push'], repo.movePlan);
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /--no-push is not supported/);
    // nothing moved: origin still has the plan in ready/, MAIN tracked tree untouched
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/050-Infra-foo\.md/, 'plan must remain in ready/ on origin');
    assert.doesNotMatch(tree, /in-progress\/050-Infra-foo\.md/, 'plan must NOT have moved');
    assert.equal(
      repo.g('status', '--porcelain', '--untracked-files=no').trim(),
      '',
      'MAIN tracked tree must be untouched',
    );
  } finally {
    repo.cleanup();
  }
});

// ── archive flips Status → ✅ COMPLETED and drops a LAND_BLOCKED parking note ──
test('move-plan: archiving flips Status → ✅ COMPLETED and drops a LAND_BLOCKED Blocked-by', () => {
  const LAND_BLOCKED_BODY = [
    '---',
    'summary: x',
    '---',
    '',
    sw('> 🟩 **SEED-WRITE: no**'),
    '',
    '**Status:** 📋 READY — opened 2026-06-01.',
    '**Blocked-by:** drain land seam LAND_BLOCKED 2026-06-14 — held.',
    '',
    '# 050-Infra-foo',
    '',
    'Body.',
    '',
  ].join('\n');
  const repo = makeIsolatedRepo({ startFolder: 'in-progress', body: LAND_BLOCKED_BODY });
  try {
    const res = runMovePlan(repo.dir, ['050', 'archive'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const movedRel = `docs/superpowers/plans/archive/${repo.basename}`;
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /archive\/050-Infra-foo\.md/,
      'plan should be in archive/ on origin',
    );
    const body = repo.g('show', `origin/master:${movedRel}`);
    assert.match(
      body,
      /\*\*Status:\*\* ✅ COMPLETED — archived \d{4}-\d{2}-\d{2} \(move-plan\)\./,
      'archived body must read ✅ COMPLETED',
    );
    assert.ok(!body.includes('LAND_BLOCKED'), 'the LAND_BLOCKED parking note must be dropped');
    assert.ok(!body.includes('**Blocked-by:**'), 'no Blocked-by line should survive into archive/');
  } finally {
    repo.cleanup();
  }
});

// ── --dry reports the planned body rewrite per target (plan 619) ──────────────
test('move-plan: --dry reports the body rewrite for a promotion and for an archive', () => {
  const repo = makeIsolatedRepo();
  try {
    const promote = runMovePlan(repo.dir, ['050', 'in-progress', '--dry'], repo.movePlan);
    assert.equal(promote.code, 0);
    assert.match(promote.stdout, /\[dry\] rewrite body: Status → 🔄 IN PROGRESS promotion stamp/);
    assert.match(promote.stdout, /\[dry\] regenerate docs\/INDEX\.md \(in-process\)/);
    const archive = runMovePlan(repo.dir, ['050', 'archive', '--dry'], repo.movePlan);
    assert.equal(archive.code, 0);
    assert.match(archive.stdout, /\[dry\] rewrite body: Status → ✅ COMPLETED/);
  } finally {
    repo.cleanup();
  }
});

// plan 2587 review finding (CONFIRMED): the --dry preview for a ready/ promotion used to
// hardcode `📋 READY` while the real write goes through the now stage-aware
// stampPromotedStatus, so a `stage: stub` + `specReview: exempt-mechanical` promotion — a
// combination assertSpecReviewOk legitimately permits — was PREVIEWED as READY and then
// WRITTEN as STUB. Both branches now read the same shared statusTokenForStage helper.
test('move-plan: --dry preview of a ready/ promotion follows the stage stamp, not a hardcoded READY (plan 2587)', () => {
  const stubBody = [
    '---',
    'summary: Test plan for the dry-preview stage split',
    'stage: stub',
    'specReview: exempt-mechanical',
    '---',
    '',
    sw('> 🟩 **SEED-WRITE: no**'),
    '> 💰 **Cost forecast:** $0 — no LLM spend.',
    '',
    '**Status:** 📋 STUB — opened 2026-06-01.',
    '',
    '# 050-Infra-foo',
    '',
    'Body.',
    '',
  ].join('\n');
  const stub = makeIsolatedRepo({ startFolder: 'waiting-blocked', body: stubBody });
  try {
    const res = runMovePlan(stub.dir, ['050', 'ready', '--dry'], stub.movePlan);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /\[dry\] rewrite body: Status → 📋 STUB promotion stamp/);
    assert.ok(
      !/rewrite body: Status → 📋 READY/.test(res.stdout),
      'a stage: stub promotion must not be previewed as READY',
    );
  } finally {
    stub.cleanup();
  }

  // …and a specced plan still previews READY, matching what stampPromotedStatus writes.
  const specced = makeIsolatedRepo({
    startFolder: 'waiting-blocked',
    body: stubBody.replace('stage: stub', 'stage: specced'),
  });
  try {
    const res = runMovePlan(specced.dir, ['050', 'ready', '--dry'], specced.movePlan);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /\[dry\] rewrite body: Status → 📋 READY promotion stamp/);
  } finally {
    specced.cleanup();
  }
});

// ── parked/ (plan 1426): a PLAIN move — body untouched, none of archive's terminal
// treatment (no ✅-COMPLETED stamp, no dropped Blocked-by) ─────────────────────────
test('move-plan: moving to parked/ is a plain move — body carried over byte-identical', () => {
  const repo = makeIsolatedRepo({ startFolder: 'in-progress' });
  try {
    const res = runMovePlan(repo.dir, ['050', 'parked'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /parked\/050-Infra-foo\.md/,
      'plan should be in parked/ on origin',
    );
    const body = repo.g('show', `origin/master:docs/superpowers/plans/parked/${repo.basename}`);
    assert.equal(body, DEFAULT_PLAN_BODY, 'body must be byte-identical — no stamp of any kind');
    assert.ok(!body.includes('✅ COMPLETED'), 'parked must never get the archive completion stamp');
  } finally {
    repo.cleanup();
  }
});

test('move-plan: --dry for a parked/ target reports a plain move, not a promotion stamp', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runMovePlan(repo.dir, ['050', 'parked', '--dry'], repo.movePlan);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /\[dry\] rewrite body: body untouched \(plain move/);
  } finally {
    repo.cleanup();
  }
});

// ── plan 1452: the target status folder may not exist on disk at all — git cannot
// track an empty directory, so a lane that has never held a file (a fresh sibling's
// parked/, a sibling with zero archived plans) is simply absent from a fresh
// checkout, and `git mv` does NOT create the destination directory for you. Delete
// the target folder from the tracked tree first (simulating that never-yet-populated
// lane) and confirm the move still succeeds — move-plan must mkdir it before the mv.
test('move-plan: moving into a target status folder that does not exist on disk succeeds and creates it (plan 1452)', () => {
  const repo = makeIsolatedRepo({ startFolder: 'in-progress' });
  try {
    // Remove parked/ entirely from the tracked tree + disk, then push — origin/master
    // (and the disposable coord-checkout the standalone move runs in) now has no
    // parked/ directory at all, exactly like a lane that has never held a file.
    repo.g('rm', '-rq', 'docs/superpowers/plans/parked/.gitkeep');
    rmSync(join(repo.dir, 'docs/superpowers/plans/parked'), { recursive: true, force: true });
    repo.g('commit', '-qm', 'remove parked/ (simulate a never-yet-populated lane)');
    repo.g('push', '-q', 'origin', 'master');
    assert.ok(
      !existsSync(join(repo.dir, 'docs/superpowers/plans/parked')),
      'sanity: parked/ must be gone before the move',
    );

    const res = runMovePlan(repo.dir, ['050', 'parked'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /parked\/050-Infra-foo\.md/,
      'plan should be in the freshly created parked/ on origin',
    );
  } finally {
    repo.cleanup();
  }
});

// Un-parking (parked → any lane) must work as a NORMAL move — driven by the TARGET,
// not the source folder, so a promotion out of parked/ gets the ordinary promotion
// stamp exactly like a promotion out of ready/ or waiting-*/.
test('move-plan: un-parking (parked/ → in-progress/) is a normal promotion move', () => {
  const repo = makeIsolatedRepo({ startFolder: 'parked' });
  try {
    const res = runMovePlan(repo.dir, ['050', 'in-progress'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g(
      'show',
      `origin/master:docs/superpowers/plans/in-progress/${repo.basename}`,
    );
    assert.match(
      body,
      /\*\*Status:\*\* 🔄 IN PROGRESS/,
      'un-parked plan gets the normal promotion stamp',
    );
  } finally {
    repo.cleanup();
  }
});

// ───────────────────── plan 926: in-process INDEX regen + post-move heal ───────
// move-plan now regenerates docs/INDEX.md IN-PROCESS (no spawned `node build-index.mjs`) and
// runs healIndexDrift after every pushed move. The "clobber lands in the regen→commit window"
// case can't be reproduced deterministically here: the only injectable hook (pre-commit) fires
// AFTER git has already snapshotted the working-tree pathspec content for an `--only` commit, so
// a hook-driven clobber arrives too late to corrupt the commit. The heal's drift-correction path
// (where it actually does work) is driven deterministically in claim-plan.test.mjs against a
// PRE-COMMITTED drift via the healIndexDriftAfterMove wrapper (= the same healIndexDrift). Here
// we lock move-plan's own contract: the in-process regen commits a CONSISTENT INDEX, and the
// post-move heal is a ZERO-commit no-op on that clean path (no redundant heal commit).
test('move-plan: a normal move commits a CONSISTENT INDEX in-process, with no redundant heal commit (plan 926)', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runMovePlan(repo.dir, ['050', 'in-progress'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');

    // The in-process regen committed a CONSISTENT INDEX on origin: bullet at the new folder, no
    // stale ready/ bullet. (Asserted on origin, not MAIN's working tree, since the isolated move
    // lands on origin and leaves MAIN untouched — plan 995.)
    const committed = repo.g('show', 'origin/master:docs/INDEX.md').toString();
    assert.match(
      committed,
      /→ `in-progress\/050-Infra-foo\.md`/,
      'bullet at the new folder on origin',
    );
    assert.doesNotMatch(
      committed,
      /→ `ready\/050-Infra-foo\.md`/,
      'no stale ready/ bullet survives',
    );

    // The post-move heal saw a consistent INDEX → made NO extra commit: origin/master HEAD is
    // move-plan's own rename commit, not a `heal INDEX repath drift` commit on top of it.
    assert.match(
      repo.g('log', 'origin/master', '-1', '--format=%s').toString(),
      /move 050-Infra-foo\.md ready\/ → in-progress\//,
      'origin HEAD must be the rename commit — the heal must NOT have added a redundant commit',
    );
  } finally {
    repo.cleanup();
  }
});

// ── plan 2034: waiting-grill/ — the batched operator-grilling lane ───────────

// Entry guard (R3a): presence + substance of `## Grill questions`, never a
// machine-parse of question structure.
test('assertGrillQuestionsOk: refuses waiting-grill without a Grill questions section', () => {
  assert.throws(() => assertGrillQuestionsOk('waiting-grill', '# T\n\nBody.\n'), /Grill questions/);
});

test('assertGrillQuestionsOk: refuses an EMPTY Grill questions section (heading, no content)', () => {
  const emptyThenNext = '# T\n\n## Grill questions\n\n## Next section\n\ncontent\n';
  assert.throws(() => assertGrillQuestionsOk('waiting-grill', emptyThenNext), /Grill questions/);
  const emptyAtEof = '# T\n\n## Grill questions\n\n';
  assert.throws(() => assertGrillQuestionsOk('waiting-grill', emptyAtEof), /Grill questions/);
});

test('assertGrillQuestionsOk: passes a non-empty Grill questions section; no-op for other targets', () => {
  const ok = '# T\n\n## Grill questions\n\n1. Which default applies? Recommend: X.\n';
  assert.doesNotThrow(() => assertGrillQuestionsOk('waiting-grill', ok));
  // other targets are out of scope — a questionless body is fine there
  assert.doesNotThrow(() => assertGrillQuestionsOk('waiting-operator', '# T\n\nBody.\n'));
  assert.doesNotThrow(() => assertGrillQuestionsOk('ready', '# T\n\nBody.\n'));
});

// Exit guard (R4b): keyed on plan CONTENT, not the origin folder.
const QUESTIONS = '## Grill questions\n\n1. Tombstone or keep? Recommend: tombstone.\n';

test('assertGrillExitOk: refuses a ready/ promotion whose questions are unanswered', () => {
  assert.throws(() => assertGrillExitOk('ready', `# T\n\n${QUESTIONS}`), /Operator rulings/);
});

test('assertGrillExitOk: passes with rulings — incl. the one-line dissolution ruling', () => {
  assert.doesNotThrow(() =>
    assertGrillExitOk('ready', `# T\n\n${QUESTIONS}\n## Operator rulings\n\n- R1: pick X.\n`),
  );
  assert.doesNotThrow(() =>
    assertGrillExitOk(
      'ready',
      `# T\n\n${QUESTIONS}\n## Operator rulings\n\ndissolved: superseded by plan 2100\n`,
    ),
  );
});

test('assertGrillExitOk: a body with no grill questions at all is unaffected', () => {
  assert.doesNotThrow(() => assertGrillExitOk('ready', '# T\n\nAn ordinary plan body.\n'));
});

test('assertGrillExitOk: every non-ready exit stays unguarded', () => {
  const unanswered = `# T\n\n${QUESTIONS}`;
  const targets = [
    'pending-approval',
    'waiting-operator',
    'waiting-blocked',
    'waiting-grill',
    'parked',
    'archive',
  ];
  for (const target of targets) {
    assert.doesNotThrow(() => assertGrillExitOk(target, unanswered), target);
  }
});

// 2034 review, finding [1] — the intermediate-hop bypass. The guard used to key on
// (fromStatus === 'waiting-grill' && target === 'ready'), so parking in waiting-grill/,
// hopping to a deliberately-unguarded lane, then promoting from THERE slipped an
// unanswered plan into ready/ and thence to the drain. Content-keyed, the origin folder
// is irrelevant and every hop is closed.
test('assertGrillExitOk: an intermediate hop cannot launder unanswered questions into ready/', () => {
  const unanswered = `# T\n\n${QUESTIONS}`;
  // whatever lane the plan hopped through, the promotion is still refused
  assert.throws(() => assertGrillExitOk('ready', unanswered), /Operator rulings/);
});

// R3b e2e: --blocked-by is optional for waiting-grill — an omitted flag is filled with
// the standard reason (never refused), and the entry guard admits the questions-bearing
// body. Runs the COPIED tool tree end-to-end like the waiting-trip happy path above.
const GRILL_PLAN_BODY = [
  '---',
  'summary: Test plan for the waiting-grill happy path',
  '---',
  '',
  sw('> 🟩 **SEED-WRITE: no**'),
  '> 💰 **Cost forecast:** $0 — no LLM spend.',
  '',
  '**Status:** 📋 READY — opened 2026-06-01.',
  '',
  '# 050-Infra-foo',
  '',
  'Body.',
  '',
  '## Grill questions',
  '',
  '1. `[axis: product]` Tombstone or keep? Recommend: tombstone (no online presence).',
  '',
].join('\n');

test('move-plan: waiting-grill without --blocked-by auto-defaults the reason (plan 2034 R3b)', () => {
  const repo = makeIsolatedRepo({ body: GRILL_PLAN_BODY });
  try {
    const res = runMovePlan(repo.dir, ['050', 'waiting-grill'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const movedRel = `docs/superpowers/plans/waiting-grill/${repo.basename}`;
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(
      tree,
      /waiting-grill\/050-Infra-foo\.md/,
      'plan should be in waiting-grill/ on origin',
    );
    const committed = repo.g('show', `origin/master:${movedRel}`);
    assert.ok(
      committed.includes(`**Blocked-by:** ${GRILL_BLOCKED_BY_DEFAULT}`),
      `default Blocked-by missing:\n${committed}`,
    );
    // INDEX regenerated with the bullet repathed into the new lane
    assert.match(
      repo.g('show', 'origin/master:docs/INDEX.md'),
      /→ `waiting-grill\/050-Infra-foo\.md`/,
    );
  } finally {
    repo.cleanup();
  }
});

test('move-plan: an explicit --blocked-by into waiting-grill wins over the default (plan 2034 R3b)', () => {
  const repo = makeIsolatedRepo({ body: GRILL_PLAN_BODY });
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', 'waiting-grill', '--blocked-by', 'needs the pricing-taxonomy ruling'],
      repo.movePlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const committed = repo.g(
      'show',
      `origin/master:docs/superpowers/plans/waiting-grill/${repo.basename}`,
    );
    assert.match(committed, /\*\*Blocked-by:\*\* needs the pricing-taxonomy ruling/);
  } finally {
    repo.cleanup();
  }
});

// ── plan 4069: axis tags on both park moves ──────────────────────────────────

test('AXIS_TAGS_BY_UNBLOCK: decision admits every axis but manual; manual admits only manual|access', () => {
  assert.deepEqual(AXIS_TAGS_BY_UNBLOCK.decision, [
    'product',
    'policy',
    'money',
    'access',
    'data-ruling',
    'hold',
  ]);
  assert.deepEqual(AXIS_TAGS_BY_UNBLOCK.manual, ['manual', 'access']);
  for (const tag of AXIS_TAGS_BY_UNBLOCK.decision) assert.ok(AXIS_TAGS.includes(tag));
  for (const tag of AXIS_TAGS_BY_UNBLOCK.manual) assert.ok(AXIS_TAGS.includes(tag));
});

// Review round 2 (R2-9, key 79 efficiency): the axis vocabulary was extracted into the
// zero-import leaf module scripts/axis-tags.mjs; move-plan.mjs imports and RE-EXPORTS it under
// the same names so every existing consumer keeps working unchanged. Prove the re-export
// actually resolves to the SAME bindings the leaf module exports (identity, not just equal
// shape) — a re-export that silently forked into a second copy would defeat the whole point.
test('R2-9: move-plan.mjs re-exports the axis vocabulary from the new axis-tags.mjs leaf, unchanged', () => {
  assert.strictEqual(AXIS_TAGS, AXIS_TAGS_LEAF);
  assert.strictEqual(AXIS_TAGS_BY_UNBLOCK, AXIS_TAGS_BY_UNBLOCK_LEAF);
  assert.strictEqual(GRILL_AXIS_TAGS, GRILL_AXIS_TAGS_LEAF);
});

test('assertGrillQuestionAxisTagsOk: refuses an untagged or unrecognised-tag question; passes a tagged one', () => {
  const untagged = '# T\n\n## Grill questions\n\n1. Which default applies?\n';
  assert.throws(() => assertGrillQuestionAxisTagsOk('waiting-grill', untagged), /\[axis: <tag>\]/);
  const badTag = '# T\n\n## Grill questions\n\n1. `[axis: bogus]` Which default applies?\n';
  assert.throws(() => assertGrillQuestionAxisTagsOk('waiting-grill', badTag), /\[axis: <tag>\]/);
  const ok = '# T\n\n## Grill questions\n\n1. `[axis: product]` Which default applies?\n';
  assert.doesNotThrow(() => assertGrillQuestionAxisTagsOk('waiting-grill', ok));
  // no-op for every other target
  assert.doesNotThrow(() => assertGrillQuestionAxisTagsOk('waiting-operator', untagged));
  assert.doesNotThrow(() => assertGrillQuestionAxisTagsOk('ready', untagged));
});

test('assertGrillQuestionAxisTagsOk: accepts the tag with or without backticks; a second untagged question still refuses', () => {
  const noBackticks = '# T\n\n## Grill questions\n\n1. [axis: policy] Which default applies?\n';
  assert.doesNotThrow(() => assertGrillQuestionAxisTagsOk('waiting-grill', noBackticks));
  const twoQuestions = '# T\n\n## Grill questions\n\n1. `[axis: money]` One?\n2. Two, untagged?\n';
  assert.throws(
    () => assertGrillQuestionAxisTagsOk('waiting-grill', twoQuestions),
    /Two, untagged\?/,
  );
});

test('assertGrillQuestionAxisTagsOk: an indented sub-bullet needs no tag of its own — only the top-level item does', () => {
  const withContext = [
    '# T',
    '',
    '## Grill questions',
    '',
    '1. `[axis: policy]` **Fork: tombstone or keep?**',
    '   - (a) tombstone — no online presence.',
    '   - (b) keep — still listed elsewhere.',
    '',
  ].join('\n');
  assert.doesNotThrow(() => assertGrillQuestionAxisTagsOk('waiting-grill', withContext));
});

test('fix round 1 (finding A): waiting-grill refuses hold/manual — those axes are operator-lane-only', () => {
  const hold = '# T\n\n## Grill questions\n\n1. `[axis: hold]` Blanket hold on X?\n';
  assert.throws(() => assertGrillQuestionAxisTagsOk('waiting-grill', hold), /\[axis: <tag>\]/);
  const manual = '# T\n\n## Grill questions\n\n1. `[axis: manual]` Rotate the API key?\n';
  assert.throws(() => assertGrillQuestionAxisTagsOk('waiting-grill', manual), /\[axis: <tag>\]/);
  // every genuinely grill-shaped axis still passes
  const ok = '# T\n\n## Grill questions\n\n1. `[axis: data-ruling]` Which row wins?\n';
  assert.doesNotThrow(() => assertGrillQuestionAxisTagsOk('waiting-grill', ok));
});

// ── plan 4069 session decision S1 ─────────────────────────────────────────────
// Structured, numbered-list-only contract — replaces the deleted prose-inference
// (ENTRY_OPENER_RX/ENTRY_MARKER_RX/STALE_GRILL_ITEM_RX) the fix-round-1/round-3 tests above used
// to exercise. The fix-round tests that asserted the DELETED behaviour (round 1 findings B/C,
// round 3 items 8/9/10/13) are removed rather than left stale — their scenarios are re-tested
// below under the new contract, several with the OPPOSITE verdict (S1's whole point: prose is no
// longer read for structure or status).

test('assertGrillQuestionsStructureOk: refuses a bold-prose line, a sub-heading, bare unindented prose, a bullet item, and an unindented fence delimiter', () => {
  const bold = '# T\n\n## Grill questions\n\n**Q1. What happens to it?**\n';
  assert.throws(() => assertGrillQuestionsStructureOk('waiting-grill', bold), /What happens to it/);
  const heading = '# T\n\n## Grill questions\n\n### 1. Which default applies?\n';
  assert.throws(
    () => assertGrillQuestionsStructureOk('waiting-grill', heading),
    /Which default applies\?/,
  );
  const prose = '# T\n\n## Grill questions\n\nWhich default applies?\n';
  assert.throws(
    () => assertGrillQuestionsStructureOk('waiting-grill', prose),
    /Which default applies\?/,
  );
  const bullet = '# T\n\n## Grill questions\n\n- Tombstone or keep?\n';
  assert.throws(
    () => assertGrillQuestionsStructureOk('waiting-grill', bullet),
    /Tombstone or keep\?/,
  );
  const fence = [
    '# T',
    '',
    '## Grill questions',
    '',
    '1. `[axis: policy]` What list format should sub-items use?',
    '',
    '```md',
    '1. Example sub-item',
    '```',
    '',
  ].join('\n');
  // The fence delimiter itself, and the line inside it, are both unindented and not a numbered
  // item — under S1 no fence-tracking is needed at all, they are refused like any other offender.
  assert.throws(() => assertGrillQuestionsStructureOk('waiting-grill', fence), /```md/);
  // a well-formed numbered item is never itself an offender
  const ok = '# T\n\n## Grill questions\n\n1. `[axis: policy]` Which default applies?\n';
  assert.doesNotThrow(() => assertGrillQuestionsStructureOk('waiting-grill', ok));
  // no-op for every other target
  assert.doesNotThrow(() => assertGrillQuestionsStructureOk('waiting-operator', bold));
  assert.doesNotThrow(() => assertGrillQuestionsStructureOk('ready', bold));
});

test('assertGrillQuestionsStructureOk: an indented continuation line and an indented sub-bullet are accepted; an indented line with no item open is refused', () => {
  const withContinuations = [
    '# T',
    '',
    '## Grill questions',
    '',
    '1. `[axis: policy]` Tombstone or keep?',
    '   Recommend: tombstone — no online presence, matches the last three closures.',
    '   - (a) tombstone — no online presence.',
    '   - (b) keep — still listed elsewhere.',
    '',
  ].join('\n');
  assert.doesNotThrow(() => assertGrillQuestionsStructureOk('waiting-grill', withContinuations));
  const orphanIndent = '# T\n\n## Grill questions\n\n   Recommend: tombstone.\n';
  assert.throws(
    () => assertGrillQuestionsStructureOk('waiting-grill', orphanIndent),
    /Recommend: tombstone\./,
  );
});

test('a well-formed numbered item with indented continuations passes all three grill gates', () => {
  const body = [
    '# T',
    '',
    '## Grill questions',
    '',
    '1. `[axis: policy]` Tombstone or keep?',
    '   Recommend: tombstone — no online presence, matches the last three closures.',
    '   → RULED, see R1 below.',
    '',
  ].join('\n');
  assert.doesNotThrow(() => assertGrillQuestionsOk('waiting-grill', body));
  assert.doesNotThrow(() => assertGrillQuestionsStructureOk('waiting-grill', body));
  assert.doesNotThrow(() => assertGrillQuestionAxisTagsOk('waiting-grill', body));
  assert.doesNotThrow(() => assertGrillQuestionsNotStaleOk('waiting-grill', body));
});

test('assertGrillQuestionAxisTagsOk: the tag must OPEN the item text — with or without backticks; untagged/unknown-tag still refuses', () => {
  const backtickTag = '# T\n\n## Grill questions\n\n1. `[axis: product]` Q1. What happens?\n';
  assert.doesNotThrow(() => assertGrillQuestionAxisTagsOk('waiting-grill', backtickTag));
  const noBackticks = '# T\n\n## Grill questions\n\n1. [axis: policy] Which default applies?\n';
  assert.doesNotThrow(() => assertGrillQuestionAxisTagsOk('waiting-grill', noBackticks));
  const untagged = '# T\n\n## Grill questions\n\n1. Which default applies?\n';
  assert.throws(() => assertGrillQuestionAxisTagsOk('waiting-grill', untagged), /\[axis: <tag>\]/);
  const unknown = '# T\n\n## Grill questions\n\n1. `[axis: bogus]` Which default applies?\n';
  assert.throws(() => assertGrillQuestionAxisTagsOk('waiting-grill', unknown), /\[axis: <tag>\]/);
});

test('assertGrillQuestionsNotStaleOk: [RESOLVED]/[RULED]/[ANSWERED] immediately after the axis tag refuses — backtick-wrapped and lowercase too — and the accepted-token list appears in the message', () => {
  for (const marker of GRILL_ANSWERED_MARKERS) {
    for (const wrap of [(m) => `[${m}]`, (m) => `\`[${m}]\``, (m) => `[${m.toLowerCase()}]`]) {
      const body = `# T\n\n## Grill questions\n\n1. \`[axis: policy]\` ${wrap(marker)} Old question?\n`;
      assert.throws(
        () => assertGrillQuestionsNotStaleOk('waiting-grill', body),
        (err) => {
          assert.match(err.message, /Operator rulings.*Session decisions/s);
          for (const m of GRILL_ANSWERED_MARKERS) assert.ok(err.message.includes(m));
          return true;
        },
        `${marker} via ${wrap(marker)}`,
      );
    }
  }
  const fresh = '# T\n\n## Grill questions\n\n1. `[axis: policy]` A live question?\n';
  assert.doesNotThrow(() => assertGrillQuestionsNotStaleOk('waiting-grill', fresh));
  // no-op for every other target
  assert.doesNotThrow(() =>
    assertGrillQuestionsNotStaleOk('waiting-operator', '1. [axis: policy] [RESOLVED] Old?'),
  );
});

test('assertGrillQuestionsNotStaleOk: prose that merely MENTIONS a status now PASSES — the writer declares, the script no longer infers', () => {
  const arrowInProse =
    '# T\n\n## Grill questions\n\n1. `[axis: money]` What is the ceiling?\n   Recommended: $50. → RULED, see R1–R3 below.\n';
  assert.doesNotThrow(() => assertGrillQuestionsNotStaleOk('waiting-grill', arrowInProse));
  const statusOnContinuation = [
    '# T',
    '',
    '## Grill questions',
    '',
    '1. `[axis: policy]` Which default applies?',
    '   Status: RESOLVED, see R1.',
    '',
  ].join('\n');
  assert.doesNotThrow(() => assertGrillQuestionsNotStaleOk('waiting-grill', statusOnContinuation));
  const notYetAnswered = [
    '# T',
    '',
    '## Grill questions',
    '',
    '1. `[axis: policy]` This is not yet answered — which default applies?',
    '',
  ].join('\n');
  assert.doesNotThrow(() => assertGrillQuestionsNotStaleOk('waiting-grill', notYetAnswered));
});

test("plan 4069's own real ## Grill questions section passes all three grill gates", () => {
  const body = [
    '# 4069',
    '',
    '## Grill questions',
    '',
    '1. `[axis: money]` **What is the spend ceiling under which a session never asks about cash inside an',
    '   already approved plan?** Recommended: $50 per plan; the audit’s individually-grilled amounts were',
    '   $15–$90 and every one was approved. → RULED, see R1–R3 below.',
    '',
  ].join('\n');
  assert.doesNotThrow(() => assertGrillQuestionsOk('waiting-grill', body));
  assert.doesNotThrow(() => assertGrillQuestionsStructureOk('waiting-grill', body));
  assert.doesNotThrow(() => assertGrillQuestionAxisTagsOk('waiting-grill', body));
  assert.doesNotThrow(() => assertGrillQuestionsNotStaleOk('waiting-grill', body));
});

test('assertBlockedByAxisTagOk: waiting-operator/decision requires an axis tag from the decision subset', () => {
  assert.throws(
    () => assertBlockedByAxisTagOk('waiting-operator', 'no tag here', 'decision'),
    /\[axis: <tag>\]/,
  );
  assert.throws(
    () => assertBlockedByAxisTagOk('waiting-operator', '[axis: manual] plain text', 'decision'),
    /not valid for unblock: decision/,
  );
  assert.doesNotThrow(() =>
    assertBlockedByAxisTagOk('waiting-operator', '[axis: money] over budget', 'decision'),
  );
  // no-op for every non-waiting-operator target
  assert.doesNotThrow(() => assertBlockedByAxisTagOk('waiting-blocked', 'no tag', 'decision'));
});

test('assertBlockedByAxisTagOk: waiting-operator/manual admits only manual|access', () => {
  assert.doesNotThrow(() =>
    assertBlockedByAxisTagOk('waiting-operator', '[axis: manual] post the comment', 'manual'),
  );
  assert.doesNotThrow(() =>
    assertBlockedByAxisTagOk('waiting-operator', '[axis: access] get the dashboard key', 'manual'),
  );
  assert.throws(
    () => assertBlockedByAxisTagOk('waiting-operator', '[axis: product] wording', 'manual'),
    /not valid for unblock: manual/,
  );
});

// e2e: a question with no [axis: …] marker refuses the waiting-grill/ entry, clean tree.
test('move-plan: waiting-grill with an untagged question is refused (plan 4069 task 1)', () => {
  const untaggedBody = GRILL_PLAN_BODY.replace(
    '1. `[axis: product]` Tombstone or keep? Recommend: tombstone (no online presence).',
    '1. Tombstone or keep? Recommend: tombstone (no online presence).',
  );
  const repo = makeIsolatedRepo({ body: untaggedBody });
  try {
    const res = runMovePlan(repo.dir, ['050', 'waiting-grill'], repo.movePlan);
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /\[axis: <tag>\]/);
    assert.equal(repo.g('status', '--porcelain', '--untracked-files=no').trim(), '');
    assert.ok(existsSync(join(repo.dir, repo.readyRel)), 'plan should remain in ready/');
  } finally {
    repo.cleanup();
  }
});

// e2e: plan 4069 session decision S1 — a structurally malformed (non-numbered-list) "## Grill
// questions" section refuses the waiting-grill/ entry via the real CLI, clean tree.
test('move-plan: waiting-grill with a structurally malformed (bulleted, not numbered) question section is refused (plan 4069 session decision S1)', () => {
  const malformedBody = GRILL_PLAN_BODY.replace(
    '1. `[axis: product]` Tombstone or keep? Recommend: tombstone (no online presence).',
    '- `[axis: product]` Tombstone or keep? Recommend: tombstone (no online presence).',
  );
  const repo = makeIsolatedRepo({ body: malformedBody });
  try {
    const res = runMovePlan(repo.dir, ['050', 'waiting-grill'], repo.movePlan);
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /NUMBERED LIST ONLY/);
    assert.equal(repo.g('status', '--porcelain', '--untracked-files=no').trim(), '');
    assert.ok(existsSync(join(repo.dir, repo.readyRel)), 'plan should remain in ready/');
  } finally {
    repo.cleanup();
  }
});

// e2e: waiting-operator/ --blocked-by without an axis tag is refused.
test('move-plan: waiting-operator with an untagged --blocked-by is refused (plan 4069 task 1)', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', 'waiting-operator', '--blocked-by', 'no axis here', '--unblock', 'decision'],
      repo.movePlan,
    );
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /\[axis: <tag>\]/);
    assert.ok(existsSync(join(repo.dir, repo.readyRel)), 'plan should remain in ready/');
  } finally {
    repo.cleanup();
  }
});

// e2e: a duplicate re-park (identical questions section, whitespace aside) is refused and
// names the previous park's commit.
test('move-plan: an identical re-park into waiting-grill is refused, naming the previous park commit (plan 4069 task 2)', () => {
  const repo = makeIsolatedRepo({ body: GRILL_PLAN_BODY });
  try {
    const first = runMovePlan(repo.dir, ['050', 'waiting-grill'], repo.movePlan);
    assert.equal(
      first.code,
      0,
      `first park failed\nstdout:${first.stdout}\nstderr:${first.stderr}`,
    );
    repo.g('fetch', '-q', 'origin', 'master');
    const prevSha = repo.g('rev-parse', 'origin/master').trim();

    // Hop out through an UNGUARDED exit (pending-approval/), keeping the SAME questions
    // section byte-for-byte, then attempt to re-park with the identical text.
    const hopOut = runMovePlan(repo.dir, ['050', 'pending-approval'], repo.movePlan);
    assert.equal(
      hopOut.code,
      0,
      `hop-out failed\nstdout:${hopOut.stdout}\nstderr:${hopOut.stderr}`,
    );

    const repark = runMovePlan(repo.dir, ['050', 'waiting-grill'], repo.movePlan);
    assert.notEqual(
      repark.code,
      0,
      `expected non-zero\nstdout:${repark.stdout}\nstderr:${repark.stderr}`,
    );
    assert.match(`${repark.stderr}${repark.stdout}`, /byte-identical/);
    assert.ok(repark.stderr.includes(prevSha) || repark.stdout.includes(prevSha), prevSha);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /pending-approval\/050-Infra-foo\.md/,
      'a refused re-park must leave the plan wherever it already sat',
    );
  } finally {
    repo.cleanup();
  }
});

// A CHANGED questions section, by contrast, parks normally even on a repeat visit.
test('move-plan: a re-park with a CHANGED questions section is not treated as a duplicate (plan 4069 task 2)', () => {
  const repo = makeIsolatedRepo({ body: GRILL_PLAN_BODY });
  try {
    const first = runMovePlan(repo.dir, ['050', 'waiting-grill'], repo.movePlan);
    assert.equal(
      first.code,
      0,
      `first park failed\nstdout:${first.stdout}\nstderr:${first.stderr}`,
    );
    const hopOut = runMovePlan(repo.dir, ['050', 'pending-approval'], repo.movePlan);
    assert.equal(
      hopOut.code,
      0,
      `hop-out failed\nstdout:${hopOut.stdout}\nstderr:${hopOut.stderr}`,
    );

    // move-plan mutates via a disposable coord-checkout, not repo.dir's own working tree — sync
    // repo.dir to origin/master before editing the file locally (mirrors the fetch every other
    // test in this suite does before reading post-move state via `git show`).
    repo.g('fetch', '-q', 'origin', 'master');
    repo.g('reset', '-q', '--hard', 'origin/master');

    // Change the questions section before re-parking.
    const planPath = join(repo.dir, 'docs/superpowers/plans/pending-approval/050-Infra-foo.md');
    const changed = readFileSync(planPath, 'utf8').replace(
      '1. `[axis: product]` Tombstone or keep? Recommend: tombstone (no online presence).',
      '1. `[axis: product]` Tombstone or keep? Recommend: keep — a new lead surfaced.',
    );
    writeFileSync(planPath, changed);
    // Stage the plan file alone (never `-A`) — a move-plan run leaves a disposable
    // `.claude/coord-worktree` checkout behind, and a blanket add would pick it up as a
    // stray embedded-repo gitlink.
    repo.g('add', 'docs/superpowers/plans/pending-approval/050-Infra-foo.md');
    repo.g('commit', '-qm', 'edit-plan: sharpen the fork');
    repo.g('push', '-q', 'origin', 'master');

    const repark = runMovePlan(repo.dir, ['050', 'waiting-grill'], repo.movePlan);
    assert.equal(
      repark.code,
      0,
      `expected exit 0\nstdout:${repark.stdout}\nstderr:${repark.stderr}`,
    );
  } finally {
    repo.cleanup();
  }
});

// R3a e2e: a questionless body is refused BEFORE any filesystem mutation — same
// clean-tree guarantee as the blocked-by fail-fast (plan 486 discipline).
test('move-plan: waiting-grill without a Grill questions section exits non-zero AND leaves a clean tree', () => {
  const repo = makeIsolatedRepo(); // DEFAULT_PLAN_BODY has no Grill questions section
  try {
    const res = runMovePlan(repo.dir, ['050', 'waiting-grill'], repo.movePlan);
    assert.notEqual(
      res.code,
      0,
      `expected non-zero exit\nstdout:${res.stdout}\nstderr:${res.stderr}`,
    );
    assert.match(`${res.stderr}${res.stdout}`, /Grill questions/);
    const status = repo.g('status', '--porcelain', '--untracked-files=no').trim();
    assert.equal(status, '', `expected a clean tree, got:\n${status}`);
    assert.ok(existsSync(join(repo.dir, repo.readyRel)), 'plan should remain in ready/');
  } finally {
    repo.cleanup();
  }
});

// R4b e2e: the exit guard blocks waiting-grill → ready until rulings exist; the
// unguarded exits (e.g. → pending-approval) pass without them.
const GRILL_PARKED_BODY = GRILL_PLAN_BODY.replace(
  '**Status:** 📋 READY — opened 2026-06-01.',
  '**Status:** ⏸ WAITING-GRILL — parked 2026-07-19.\n\n**Blocked-by:** operator grilling — see ## Grill questions',
);

test('move-plan: waiting-grill → ready is refused without Operator rulings; allowed with them (plan 2034 R4b)', () => {
  const noRulings = makeIsolatedRepo({ startFolder: 'waiting-grill', body: GRILL_PARKED_BODY });
  try {
    const res = runMovePlan(noRulings.dir, ['050', 'ready'], noRulings.movePlan);
    assert.notEqual(
      res.code,
      0,
      `expected non-zero exit\nstdout:${res.stdout}\nstderr:${res.stderr}`,
    );
    assert.match(`${res.stderr}${res.stdout}`, /Operator rulings/);
  } finally {
    noRulings.cleanup();
  }
  const withRulings = makeIsolatedRepo({
    startFolder: 'waiting-grill',
    body: `${GRILL_PARKED_BODY}\n## Operator rulings\n\n- R1: tombstone it.\n`,
  });
  try {
    const res = runMovePlan(withRulings.dir, ['050', 'ready'], withRulings.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    withRulings.g('fetch', '-q', 'origin', 'master');
    const tree = withRulings.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/050-Infra-foo\.md/, 'plan should be in ready/ on origin');
  } finally {
    withRulings.cleanup();
  }
});

test('move-plan: waiting-grill → pending-approval stays unguarded (no rulings needed)', () => {
  const repo = makeIsolatedRepo({ startFolder: 'waiting-grill', body: GRILL_PARKED_BODY });
  try {
    const res = runMovePlan(repo.dir, ['050', 'pending-approval'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /pending-approval\/050-Infra-foo\.md/);
  } finally {
    repo.cleanup();
  }
});

// 2034 review finding [1], end-to-end: a plan that LEFT waiting-grill/ through an
// unguarded exit still cannot be promoted to ready/ with its questions unanswered.
// Seeded directly in waiting-blocked/ — the folder the hop lands in — so the CLI
// exercises exactly the post-hop promotion the folder-pair guard used to wave through.
test('move-plan: a post-hop ready/ promotion with unanswered questions is refused (plan 2034 review)', () => {
  const hopped = makeIsolatedRepo({
    startFolder: 'waiting-blocked',
    body: GRILL_PARKED_BODY, // has ## Grill questions, no ## Operator rulings
  });
  try {
    const res = runMovePlan(hopped.dir, ['050', 'ready'], hopped.movePlan);
    assert.notEqual(
      res.code,
      0,
      `expected non-zero exit\nstdout:${res.stdout}\nstderr:${res.stderr}`,
    );
    assert.match(`${res.stderr}${res.stdout}`, /Operator rulings/);
    hopped.g('fetch', '-q', 'origin', 'master');
    assert.doesNotMatch(
      hopped.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /ready\/050-Infra-foo\.md/,
      'an unanswered plan must not reach ready/ via an intermediate lane',
    );
  } finally {
    hopped.cleanup();
  }
});

// The same hop, once the rulings exist, promotes normally — the guard gates on the
// answers, never on which folder the plan happens to sit in.
test('move-plan: a post-hop ready/ promotion WITH rulings succeeds (plan 2034 review)', () => {
  const hopped = makeIsolatedRepo({
    startFolder: 'waiting-blocked',
    body: `${GRILL_PARKED_BODY}\n## Operator rulings\n\n- R1: tombstone it.\n`,
  });
  try {
    const res = runMovePlan(hopped.dir, ['050', 'ready'], hopped.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    hopped.g('fetch', '-q', 'origin', 'master');
    assert.match(
      hopped.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /ready\/050-Infra-foo\.md/,
    );
  } finally {
    hopped.cleanup();
  }
});

// --- plan 2082: board-row path sync + claim-holder guard ---------------------

const BOARD_HEADER = [
  '# Active worktrees',
  '',
  '<!-- BOARD-START -->',
  '',
  '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
  '| --- | --- | --- | --- | --- | --- |',
];
const boardWith = (...rows) => [...BOARD_HEADER, ...rows, '', '<!-- BOARD-END -->', ''].join('\n');

test('syncBoardPlanRefs: rewrites the subfolder segment of a matching Plan/claim ref, sibling rows untouched', () => {
  const content = boardWith(
    // NOT run through sw(): this board-row cell is hand-typed test data that syncBoardPlanRefs
    // passes through byte-for-byte (it rewrites the path segment only) — the assertion below
    // checks the literal text survives unchanged, so both sides must stay the SAME literal.
    '| 050-Infra-foo | `abc` | 🔄 ACTIVE | `in-progress/050-Infra-foo.md` · session 1946 · host=`H` · 🟥 SEED-WRITE | 2026-07-19 17:55 | — |',
    '| 051-Infra-bar | `def` | 🔄 ACTIVE | `in-progress/051-Infra-bar.md` · session 1947 | 2026-07-19 17:56 | — |',
  );
  const r = syncBoardPlanRefs(content, {
    oldBasename: '050-Infra-foo.md',
    newBasename: '050-Infra-foo.md',
    target: 'ready',
  });
  assert.equal(r.changed, true);
  assert.equal(r.rows, 1);
  // The path is repointed; the rest of the cell (session/host/banner) is untouched.
  assert.match(r.content, /`ready\/050-Infra-foo\.md` · session 1946 · host=`H` · 🟥 SEED-WRITE/);
  assert.doesNotMatch(r.content, /in-progress\/050-Infra-foo\.md/);
  assert.match(r.content, /`in-progress\/051-Infra-bar\.md` · session 1947/);
});

test('syncBoardPlanRefs: no matching row → byte-identical no-op', () => {
  const content = boardWith(
    '| 051-Infra-bar | `def` | 🔄 ACTIVE | `in-progress/051-Infra-bar.md` | 2026-07-19 | — |',
  );
  const r = syncBoardPlanRefs(content, {
    oldBasename: '050-Infra-foo.md',
    newBasename: '050-Infra-foo.md',
    target: 'ready',
  });
  assert.equal(r.changed, false);
  assert.equal(r.content, content);
});

test('syncBoardPlanRefs: an already-correct path → byte-identical no-op (idempotent)', () => {
  const content = boardWith(
    '| 050-Infra-foo | `abc` | 🔄 ACTIVE | `ready/050-Infra-foo.md` · session 1946 | 2026-07-19 | — |',
  );
  const r = syncBoardPlanRefs(content, {
    oldBasename: '050-Infra-foo.md',
    newBasename: '050-Infra-foo.md',
    target: 'ready',
  });
  assert.equal(r.changed, false);
  assert.equal(r.content, content);
});

test('syncBoardPlanRefs: a same-move FABLE rename rewrites folder AND basename', () => {
  const content = boardWith(
    '| 050-Infra-foo | `abc` | 🔄 ACTIVE | `pending-approval/050-Infra-foo.md` · session 5 | 2026-07-19 | — |',
  );
  const r = syncBoardPlanRefs(content, {
    oldBasename: '050-Infra-foo.md',
    newBasename: '050-FABLE-Infra-foo.md',
    target: 'ready',
  });
  assert.equal(r.changed, true);
  assert.match(r.content, /`ready\/050-FABLE-Infra-foo\.md` · session 5/);
});

test('syncBoardPlanRefs: a bare (subfolder-less) ref changes only on a rename', () => {
  const bare = boardWith(
    '| 050-Infra-foo | `abc` | 🔄 ACTIVE | `050-Infra-foo.md` | 2026-07-19 | — |',
  );
  const same = syncBoardPlanRefs(bare, {
    oldBasename: '050-Infra-foo.md',
    newBasename: '050-Infra-foo.md',
    target: 'ready',
  });
  assert.equal(same.changed, false, 'no rename → the lint never flags a bare ref, so no diff');
  const renamed = syncBoardPlanRefs(bare, {
    oldBasename: '050-Infra-foo.md',
    newBasename: '050-FABLE-Infra-foo.md',
    target: 'ready',
  });
  assert.equal(renamed.changed, true, 'a rename would leave the bare ref BROKEN — must follow');
  assert.match(renamed.content, /`050-FABLE-Infra-foo\.md`/);
});

test('syncBoardPlanRefs: sentinel-less content → no-op, never a throw', () => {
  const r = syncBoardPlanRefs('# not a board\n', {
    oldBasename: '050-Infra-foo.md',
    newBasename: '050-Infra-foo.md',
    target: 'ready',
  });
  assert.equal(r.changed, false);
  assert.equal(r.content, '# not a board\n');
});

test('claimHolderError: unheld and self-held proceed; foreign, unparseable, and unprovable-self refuse', () => {
  const other = {
    sessionUuid: 'ffffffff-0000-0000-0000-000000000000',
    host: 'other-pc',
    iso: '2026-07-19T00:00:00.000Z',
  };
  const ctx = { basename: '050-Infra-foo.md' };
  const status = (held, holder, youAreHolder) => ({ planId: '050', held, holder, youAreHolder });
  assert.equal(claimHolderError(status(false, null, false), ctx), null, 'unheld → proceed');
  assert.equal(
    claimHolderError(status(true, other, true), ctx),
    null,
    'self-held (planStatus proved youAreHolder) → proceed',
  );
  const foreign = claimHolderError(status(true, other, false), ctx);
  assert.match(foreign, /CLAIMED by session ffffffff-0000/);
  assert.match(foreign, /host other-pc/);
  assert.match(foreign, /--force/);
  assert.match(foreign, /release-claim\.mjs release 050/);
  assert.doesNotMatch(
    foreign,
    /no coordination session identity/,
    'selfIdKnown default → no env note',
  );
  assert.match(
    claimHolderError(status(true, null, false), ctx),
    /UNPARSEABLE claim record/,
    'held ref with an unparseable message → refuse (self-hold cannot be proven)',
  );
  const unprovable = claimHolderError(status(true, other, false), { ...ctx, selfIdKnown: false });
  assert.match(
    unprovable,
    /CLAIMED by session/,
    'no session id in the environment → cannot prove self → refuse',
  );
  assert.match(
    unprovable,
    /no coordination session identity/,
    'the unprovable-self refusal must explain WHY and name --force (review r2)',
  );
});

// Round-3 review fix (finding e91eef): claimHolderError is now parameterized so
// stamp-lib.mjs's combined stamp+move form can reuse it instead of keeping its own
// hand-duplicated copy (the retired combinedMoveClaimHolderError) — `tool` swaps the
// "move-plan:" brand, `hasForceOverride` drops the "--force is the sanctioned way
// through" tail for a caller with no override flag of its own, and `guidance` swaps the
// whole remediation sentence. Defaults (no options beyond basename) must stay
// byte-identical to the pre-fix standalone wording — pinned by the test just above.
test('claimHolderError: tool/hasForceOverride/guidance parameterize the message for a non-move-plan caller (finding e91eef)', () => {
  const other = {
    sessionUuid: 'ffffffff-0000-0000-0000-000000000000',
    host: 'other-pc',
    iso: '2026-07-19T00:00:00.000Z',
  };
  const status = (held, holder, youAreHolder) => ({ planId: '050', held, holder, youAreHolder });
  const combined = claimHolderError(status(true, other, false), {
    basename: '050-Infra-foo.md',
    tool: 'stamp-exec-model',
    hasForceOverride: false,
    guidance: 'Drop --move and run move-plan.mjs 050 waiting-blocked --force directly instead.',
  });
  assert.match(combined, /^stamp-exec-model: 050-Infra-foo\.md is CLAIMED by session/);
  assert.doesNotMatch(combined, /^move-plan:/, 'tool overrides the "move-plan:" brand');
  assert.match(
    combined,
    /Drop --move and run move-plan\.mjs 050 waiting-blocked --force directly instead\./,
    'the supplied guidance replaces the standalone remediation sentence',
  );
  assert.doesNotMatch(
    combined,
    /re-run with --force/,
    "never the standalone tool's own wording once guidance is supplied",
  );
  // hasForceOverride: false also shortens the unprovable-self NOTE when selfIdKnown is false.
  const combinedUnprovable = claimHolderError(status(true, other, false), {
    basename: '050-Infra-foo.md',
    tool: 'stamp-exec-model',
    hasForceOverride: false,
    guidance: 'Drop --move and run move-plan.mjs 050 waiting-blocked --force directly instead.',
    selfIdKnown: false,
  });
  assert.match(combinedUnprovable, /cannot be proven yours\./);
  assert.doesNotMatch(
    combinedUnprovable,
    /--force is the sanctioned way through/,
    'hasForceOverride: false drops the --force tail this tool does not have',
  );
});

// Round-3 review fix (findings f4c9b3/12ef2c/06453e): the ref text names whichever
// namespace `status.ref` says the claim actually sits in (as readClaimHolderStatus sets
// it), never a hardcoded guess of either namespace — the `?? claimRef(...)` fallback only
// applies when a caller's status fixture omits `ref` entirely (every OTHER test in this
// file, all pre-dating this field).
test('claimHolderError: names the LEGACY or the branch-shaped ref per status.ref, falls back to claimRef when unset', () => {
  const other = {
    sessionUuid: 'ffffffff-0000-0000-0000-000000000000',
    host: 'other-pc',
    iso: '2026-07-19T00:00:00.000Z',
  };
  const ctx = { basename: '050-Infra-foo.md' };
  const legacy = claimHolderError(
    { planId: '050', held: true, holder: other, youAreHolder: false, ref: legacyClaimRef('050') },
    ctx,
  );
  assert.match(legacy, /refs\/claims\/050\b/);
  assert.doesNotMatch(legacy, /refs\/heads\/coord\/claims\/050/);
  const branchShaped = claimHolderError(
    { planId: '050', held: true, holder: other, youAreHolder: false, ref: claimRef('050') },
    ctx,
  );
  assert.match(branchShaped, /refs\/heads\/coord\/claims\/050/);
  const noRefSet = claimHolderError(
    { planId: '050', held: true, holder: other, youAreHolder: false },
    ctx,
  );
  assert.match(
    noRefSet,
    /refs\/heads\/coord\/claims\/050/,
    'no status.ref (a fixture that predates it) falls back to claimRef()',
  );
});

// Push a parentless claim commit for plan 050 to the temp origin, mirroring
// claim-plan's acquireRef (empty tree + message-as-holder-record).
function pushTestClaim(repo, sessionUuid) {
  const msg = [
    'claim plan=050',
    `session=${sessionUuid}`,
    'host=test-host',
    'iso=2026-07-19T00:00:00.000Z',
  ].join('\n');
  // The empty-tree object id is a git constant, always resolvable without mktree.
  const sha = repo.g('commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', msg).trim();
  repo.g('push', '-q', 'origin', `${sha}:refs/claims/050`);
}

// Round-3 review fix (finding 06453e): the same fixture, pushed into the LIVE
// branch-shaped namespace instead — the companion case to pushTestClaim above.
function pushTestClaimNew(repo, sessionUuid) {
  const msg = [
    'claim plan=050',
    `session=${sessionUuid}`,
    'host=test-host',
    'iso=2026-07-19T00:00:00.000Z',
  ].join('\n');
  const sha = repo.g('commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', msg).trim();
  repo.g('push', '-q', 'origin', `${sha}:${claimRef('050')}`);
}

// Like runMovePlan but with an env override, so the claim-guard tests can pin
// CLAUDE_CODE_SESSION_ID deterministically regardless of the harness environment.
function runMovePlanEnv(dir, args, scriptPath, envOverride) {
  const env = { ...process.env };
  for (const name of [
    'COORD_SESSION_ID',
    'CLAUDE_CODE_SESSION_ID',
    'CODEX_SESSION_ID',
    'CODEX_THREAD_ID',
    'GROK_SESSION_ID',
  ])
    delete env[name];
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...env, ...envOverride },
  });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('move-plan: a plan claimed by ANOTHER session refuses to move; --force overrides (plan 2082)', () => {
  const repo = makeIsolatedRepo();
  try {
    pushTestClaim(repo, 'ffffffff-0000-0000-0000-000000000000');
    // --dry neither refuses nor false-cleans (review r5/r10): exit 0, loud would-refuse line.
    const dryRes = runMovePlanEnv(repo.dir, ['050', 'pending-approval', '--dry'], repo.movePlan, {
      CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-1111-2222-3333-444444444444',
    });
    assert.equal(
      dryRes.code,
      0,
      `dry preview must not refuse\nstdout:${dryRes.stdout}\nstderr:${dryRes.stderr}`,
    );
    assert.match(dryRes.stderr, /\[dry\] claim guard: the real run would REFUSE/);
    const res = runMovePlanEnv(repo.dir, ['050', 'pending-approval'], repo.movePlan, {
      CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-1111-2222-3333-444444444444',
    });
    assert.equal(res.code, 2, `expected fatal exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /CLAIMED by session ffffffff-0000/);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /ready\/050-Infra-foo\.md/,
      'refused move must leave the plan in place on origin',
    );
    const forced = runMovePlanEnv(repo.dir, ['050', 'pending-approval', '--force'], repo.movePlan, {
      CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-1111-2222-3333-444444444444',
    });
    assert.equal(
      forced.code,
      0,
      `expected exit 0\nstdout:${forced.stdout}\nstderr:${forced.stderr}`,
    );
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /pending-approval\/050-Infra-foo\.md/,
    );
  } finally {
    repo.cleanup();
  }
});

test('move-plan: a SELF-held claim proceeds with an advisory note (plan 2082)', () => {
  const repo = makeIsolatedRepo();
  try {
    const self = 'aaaaaaaa-1111-2222-3333-444444444444';
    pushTestClaim(repo, self);
    const res = runMovePlanEnv(repo.dir, ['050', 'pending-approval'], repo.movePlan, {
      CLAUDE_CODE_SESSION_ID: self,
    });
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /you hold refs\/claims\/050 yourself/);
    assert.doesNotMatch(
      res.stderr,
      /refs\/heads\/coord\/claims\/050/,
      'never the branch-shaped ref when the self-held claim is legacy',
    );
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /pending-approval\/050-Infra-foo\.md/,
    );
  } finally {
    repo.cleanup();
  }
});

// Round-3 review fix (finding 06453e): the companion case — a SELF-held claim actually
// sitting in the LIVE branch-shaped namespace must be named as such in the advisory
// note, never the retired refs/claims/<id> spelling. Byte-identical to the test above
// except for pushTestClaimNew.
test('move-plan: a SELF-held claim in the NEW (branch-shaped) namespace names that ref in its advisory note (finding 06453e)', () => {
  const repo = makeIsolatedRepo();
  try {
    const self = 'aaaaaaaa-1111-2222-3333-444444444444';
    pushTestClaimNew(repo, self);
    const res = runMovePlanEnv(repo.dir, ['050', 'pending-approval'], repo.movePlan, {
      CLAUDE_CODE_SESSION_ID: self,
    });
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /you hold refs\/heads\/coord\/claims\/050 yourself/);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /pending-approval\/050-Infra-foo\.md/,
    );
  } finally {
    repo.cleanup();
  }
});

test('move-plan: a self-held claim moving into a terminal park lane also WARNs to release it; a non-terminal target does not (plan 2818)', () => {
  const repo = makeIsolatedRepo();
  try {
    const self = 'aaaaaaaa-1111-2222-3333-444444444444';
    pushTestClaim(repo, self);
    // Fires: waiting-blocked is one of the terminal park lanes.
    const blockedRes = runMovePlanEnv(
      repo.dir,
      ['050', 'waiting-blocked', '--blocked-by', 'plan 999 landing'],
      repo.movePlan,
      { CLAUDE_CODE_SESSION_ID: self },
    );
    assert.equal(
      blockedRes.code,
      0,
      `expected exit 0\nstdout:${blockedRes.stdout}\nstderr:${blockedRes.stderr}`,
    );
    assert.match(blockedRes.stderr, /you hold refs\/claims\/050 yourself/);
    assert.match(blockedRes.stderr, /WARN \(plan 2818\)/);
    assert.match(blockedRes.stderr, /release-claim\.mjs release 050/);

    // Does not fire: waiting-trip is a non-terminal waiting lane (self-held note still
    // prints, but no plan-2818 release nudge). Same still-held claim from above — the
    // warn-only nudge never releases anything, so the ref survives untouched.
    const tripRes = runMovePlanEnv(
      repo.dir,
      ['050', 'waiting-trip', '--blocked-by', 'plan 999 landing'],
      repo.movePlan,
      { CLAUDE_CODE_SESSION_ID: self },
    );
    assert.equal(
      tripRes.code,
      0,
      `expected exit 0\nstdout:${tripRes.stdout}\nstderr:${tripRes.stderr}`,
    );
    assert.match(tripRes.stderr, /you hold refs\/claims\/050 yourself/);
    assert.doesNotMatch(tripRes.stderr, /WARN \(plan 2818\)/);
  } finally {
    repo.cleanup();
  }
});

test('move-plan: a move rewrites the board-row path in the SAME commit (plan 2082)', () => {
  const repo = makeIsolatedRepo();
  try {
    // Config-less repo → loadCoordConfig's LEGACY boardFile: handoff-board.md at root.
    writeFileSync(
      join(repo.dir, 'handoff-board.md'),
      boardWith(
        '| 050-Infra-foo | `abc` | 🔄 ACTIVE | `ready/050-Infra-foo.md` · session 1946 · host=`H` | 2026-07-19 17:55 | — |',
      ),
    );
    repo.g('add', 'handoff-board.md');
    repo.g('commit', '-qm', 'seed board');
    repo.g('push', '-q', 'origin', 'master');
    const res = runMovePlan(
      repo.dir,
      ['050', 'waiting-trip', '--blocked-by', 'plan 999 landing'],
      repo.movePlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('show', 'origin/master:handoff-board.md'),
      /`waiting-trip\/050-Infra-foo\.md` · session 1946 · host=`H`/,
      'board row path repointed to the new status folder',
    );
    // Atomicity: the ONE move commit carries plan file + INDEX + board together.
    const moveCommitFiles = repo.g('show', '--name-only', '--format=', 'origin/master');
    assert.match(moveCommitFiles, /handoff-board\.md/);
    assert.match(moveCommitFiles, /waiting-trip\/050-Infra-foo\.md/);
    assert.match(moveCommitFiles, /docs\/INDEX\.md/);
  } finally {
    repo.cleanup();
  }
});

test('move-plan: a board with NO matching row is left out of the move commit (plan 2082)', () => {
  const repo = makeIsolatedRepo();
  try {
    writeFileSync(
      join(repo.dir, 'handoff-board.md'),
      boardWith(
        '| 051-Infra-bar | `def` | 🔄 ACTIVE | `in-progress/051-Infra-bar.md` | 2026-07-19 | — |',
      ),
    );
    repo.g('add', 'handoff-board.md');
    repo.g('commit', '-qm', 'seed board');
    repo.g('push', '-q', 'origin', 'master');
    const res = runMovePlan(
      repo.dir,
      ['050', 'waiting-trip', '--blocked-by', 'plan 999 landing'],
      repo.movePlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const moveCommitFiles = repo.g('show', '--name-only', '--format=', 'origin/master');
    assert.doesNotMatch(
      moveCommitFiles,
      /handoff-board\.md/,
      'untouched board stays out of the commit',
    );
  } finally {
    repo.cleanup();
  }
});

// ── Category subfolders (plan 2678) ────────────────────────────────────────
// A move target may name an optional one-level category folder — `move-plan 050
// parked/denmark` — purely so related plans clump in the operator's explorer. The
// STATUS (segment 0) still drives every gate, stamp and board-row state.

test('parseMoveTarget: bare status stays flat; a category is split off the status', () => {
  assert.deepEqual(parseMoveTarget('parked'), {
    status: 'parked',
    category: null,
    path: 'parked',
  });
  assert.deepEqual(parseMoveTarget('parked/denmark'), {
    status: 'parked',
    category: 'denmark',
    path: 'parked/denmark',
  });
});

// Without these three, an illegal target would be CREATED as a folder on master by the
// `git mv` (ensureMvDestDir mkdirs recursively) and only caught later by the pre-push
// corpus lint — after the move had already landed.
test('parseMoveTarget: two levels, an uppercase category, and a category under archive/ all throw', () => {
  assert.throws(() => parseMoveTarget('parked/a/b'), /EXACTLY one/);
  assert.throws(() => parseMoveTarget('parked/Denmark'), /lowercase/);
  assert.throws(() => parseMoveTarget('archive/done'), /stays FLAT/);
});

// statusOf answers "which lifecycle state", statusPathOf answers "which directory" —
// conflating them made `ready/` → `ready/infra/` look like a no-op move and refuse.
test('statusOf keeps meaning the STATUS; statusPathOf carries the category', () => {
  const flat = 'docs/superpowers/plans/ready/050-Infra-foo.md';
  const nested = 'docs/superpowers/plans/parked/denmark/050-Infra-foo.md';
  assert.equal(statusOf(flat), 'ready');
  assert.equal(statusPathOf(flat), 'ready');
  assert.equal(statusOf(nested), 'parked');
  assert.equal(statusPathOf(nested), 'parked/denmark');
});

// The board ref must name the file an operator can actually open — and lint-board's
// BOARD_SUBFOLDER_DRIFT compares that ref against the real on-disk location, so a
// status-only rewrite here would immediately fail the next push's board lint.
test('syncBoardPlanRefs: a categorised target repaths the row to the FULL path', () => {
  const content = boardWith(
    '| 050-Infra-foo | `abc` | 🔄 ACTIVE | `in-progress/050-Infra-foo.md` · session 1946 | 2026-07-19 | — |',
  );
  const r = syncBoardPlanRefs(content, {
    oldBasename: '050-Infra-foo.md',
    newBasename: '050-Infra-foo.md',
    target: 'parked/denmark',
  });
  assert.equal(r.changed, true);
  assert.equal(r.rows, 1);
  assert.match(r.content, /`parked\/denmark\/050-Infra-foo\.md` · session 1946/);
  assert.doesNotMatch(r.content, /in-progress\/050-Infra-foo\.md/);
});

// End-to-end: the plan lands in the nested folder on origin AND docs/INDEX.md's bullet
// names the real path — the two surfaces that silently dropped a nested plan before.
test('move-plan: a categorised target moves the file into the subfolder end-to-end', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runMovePlan(repo.dir, ['050', 'parked/denmark'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /parked\/denmark\/050-Infra-foo\.md/, 'plan should be in parked/denmark/');
    assert.doesNotMatch(tree, /plans\/ready\/050-Infra-foo\.md/, 'plan should have left ready/');
  } finally {
    repo.cleanup();
  }
});

// Re-clumping INSIDE one status (`ready/` → `ready/infra/`) is a legitimate move; the
// pre-2678 status-only comparison refused it as "already in ready/".
test('move-plan: re-clumping within the same status is allowed, not a no-op refusal', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runMovePlan(repo.dir, ['050', 'ready/infra'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /ready\/infra\/050-Infra-foo\.md/,
    );
  } finally {
    repo.cleanup();
  }
});

// The CLI must refuse an illegal target BEFORE the irreversible git mv, and say why.
test('move-plan: CLI rejects an uppercase category target with a self-explaining message', () => {
  const repo = makeRepoWithPlan();
  try {
    const res = runMovePlan(repo.dir, ['050', 'parked/Denmark']);
    assert.notEqual(res.code, 0);
    assert.match(`${res.stdout}${res.stderr}`, /lowercase/);
  } finally {
    repo.cleanup();
  }
});

// ── plan 2719: the sanctioned slug-rename path ────────────────────────────────
// Folded into this file rather than a new rename-plan.test.mjs (the scripts test rule's
// default): --rename is a flag on move-plan, not a new module, so this IS its name-paired
// suite. Pure-verdict tests first, then the end-to-end + refusal paths.

test('planRenameGrammar: a conformant basename passes clean', () => {
  assert.deepEqual(
    planRenameGrammar('2713-UI-se-basta-veterinar-ratings-landing.md', { expectedId: '2713' }),
    { errors: [], warnings: [] },
  );
  // The FABLE- exec-model segment is part of the grammar, not a violation.
  assert.deepEqual(planRenameGrammar('2719-FABLE-Coord-plan-slug-rename-tool.md'), {
    errors: [],
    warnings: [],
  });
  // plan 3341 fix: the SOL- exec-model segment is equally part of the grammar — this
  // used to be rejected by RENAME_BASENAME_RX's fable-only marker alternation.
  assert.deepEqual(planRenameGrammar('2719-SOL-Coord-plan-slug-rename-tool.md'), {
    errors: [],
    warnings: [],
  });
});

test('planRenameGrammar: hard errors — shape, extension, path separator, id, category', () => {
  const errsOf = (n, opts) => planRenameGrammar(n, opts).errors.join('\n');
  assert.match(errsOf('2713-UI-no-extension'), /must end in \.md/);
  assert.match(errsOf('ready/2713-UI-x.md'), /contains a path separator/);
  assert.match(errsOf('not-a-plan-name.md'), /is not a plan basename/);
  assert.match(errsOf('2714-UI-x.md', { expectedId: '2713' }), /claims plan id 2714/);
  // plan 4071 D1: the category check is skipped for an EMPTY allowlist (no gate) — these two
  // must pass the REAL vetapp taxonomy explicitly to exercise the refusal.
  const withAllowlist = { allowlist: VETAPP_PLAN_CATEGORIES.allowlist };
  assert.match(errsOf('2713-ui-lowercase.md', withAllowlist), /not in the plan-2329 taxonomy/);
  assert.match(errsOf('2713-Nope-x.md', withAllowlist), /not in the plan-2329 taxonomy/);
  assert.equal(planRenameGrammar('', {}).errors.length, 1);
});

// The slug charset is the SHARED one (claim-plan-lib's SLUG_CHARSET_RX), deliberately
// permissive: ~20 live plans carry camelCase code identifiers in the slug, so a
// lowercase-kebab hard rule would refuse names the corpus proves are wanted.
test('planRenameGrammar: a camelCase code identifier in the slug is legal, not an error', () => {
  assert.deepEqual(
    planRenameGrammar('2234-Infra-centralize-findChrome-into-cdp-client.md', {
      expectedId: '2234',
    }),
    { errors: [], warnings: [] },
  );
});

// The country token and the Pipe stage token are SOFT — neither is machine-verifiable as
// a rule (only a human knows a plan's country scope; the stage rule is widely unenforced),
// and a hard gate would refuse renames that FIX one convention while tripping the other.
test('planRenameGrammar: country-spelling and Pipe-stage issues WARN, never refuse', () => {
  // plan 4071 D1: both hint tables default to empty/no-op — pass the REAL vetapp rows
  // explicitly to exercise the warnings.
  const gb = planRenameGrammar('2713-UI-gb-thing.md', {
    expectedId: '2713',
    countryTokenHints: VETAPP_PLAN_NAMING.countryTokenHints,
  });
  assert.deepEqual(gb.errors, []);
  assert.match(gb.warnings.join('\n'), /use "uk"/);
  const sweden = planRenameGrammar('2713-UI-sweden-thing.md', {
    expectedId: '2713',
    countryTokenHints: VETAPP_PLAN_NAMING.countryTokenHints,
  });
  assert.deepEqual(sweden.errors, []);
  assert.match(sweden.warnings.join('\n'), /use "se"/);
  const pipe = planRenameGrammar('2713-Pipe-se-thing.md', {
    expectedId: '2713',
    stageTokens: VETAPP_PLAN_NAMING.stageTokens,
  });
  assert.deepEqual(pipe.errors, []);
  assert.match(pipe.warnings.join('\n'), /FIRST slug token should be the pipeline stage/);
  // A Pipe plan that DOES lead with a stage token is clean.
  assert.deepEqual(
    planRenameGrammar('2713-Pipe-extract-se-thing.md', {
      expectedId: '2713',
      stageTokens: VETAPP_PLAN_NAMING.stageTokens,
    }),
    {
      errors: [],
      warnings: [],
    },
  );
});

test('renameLaneError: guards BOTH ends, and names the concrete reason per lane', () => {
  assert.equal(renameLaneError('ready', 'ready', 'x.md'), null);
  assert.equal(renameLaneError('pending-approval', 'waiting-blocked', 'x.md'), null);
  assert.match(renameLaneError('in-progress', 'in-progress', 'x.md'), /source lane is in-progress/);
  assert.match(renameLaneError('ready', 'in-progress', 'x.md'), /destination lane is in-progress/);
  assert.match(renameLaneError('ready', 'archive', 'x.md'), /archive-narrative region/);
  assert.match(renameLaneError('ready', 'parked', 'x.md'), /absent from STATUS_ORDER/);
  // in-progress/ refuses because the branch/worktree/queue slug key on the basename.
  assert.match(renameLaneError('in-progress', 'ready', 'x.md'), /key on the basename/);
  assert.ok(!RENAMEABLE_STATUSES.includes('in-progress'));
});

test('move-plan: --rename with no target renames in place, body byte-identical, INDEX resynced', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', '--rename', '050-Infra-se-renamed-foo.md'],
      repo.movePlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/050-Infra-se-renamed-foo\.md/, 'renamed plan should be on origin');
    assert.doesNotMatch(tree, /ready\/050-Infra-foo\.md/, 'old basename should be gone');
    // A pure rename is a plain move: no promotion stamp, no Blocked-by rewrite.
    assert.equal(
      repo.g('show', 'origin/master:docs/superpowers/plans/ready/050-Infra-se-renamed-foo.md'),
      DEFAULT_PLAN_BODY,
      'a pure rename must carry the body over byte-identical',
    );
    // The INDEX bullet follows the new basename in the SAME commit (no guard override,
    // no hand git) — the whole point of the tool.
    const index = repo.g('show', 'origin/master:docs/INDEX.md');
    assert.match(index, /ready\/050-Infra-se-renamed-foo\.md/);
    assert.doesNotMatch(index, /050-Infra-foo\.md/, 'stale INDEX reference must be gone');
    assert.match(
      repo.g('log', '-1', '--format=%s', 'origin/master'),
      /rename 050-Infra-foo\.md → 050-Infra-se-renamed-foo\.md/,
    );
  } finally {
    repo.cleanup();
  }
});

test('move-plan: a target AND --rename move and rename in ONE commit', () => {
  const repo = makeIsolatedRepo({ startFolder: 'pending-approval' });
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', 'ready', '--rename', '050-Infra-se-renamed-foo.md'],
      repo.movePlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/050-Infra-se-renamed-foo\.md/);
    assert.doesNotMatch(tree, /pending-approval\/050-Infra-foo\.md/);
    // A real move still stamps the promotion — only the PURE rename is body-neutral.
    assert.match(
      repo.g('show', 'origin/master:docs/superpowers/plans/ready/050-Infra-se-renamed-foo.md'),
      /\*\*Status:\*\*/,
    );
    assert.equal(
      repo.g('log', '--oneline', 'origin/master').trim().split('\n').length,
      2,
      'move + rename + INDEX must be ONE commit on top of the seed commit',
    );
  } finally {
    repo.cleanup();
  }
});

test('move-plan: --rename refuses a grammar violation and leaves the plan untouched', () => {
  const repo = makeIsolatedRepo();
  // plan 4071 D1/D2: an empty (fixture-default) planCategories.allowlist means no category
  // gate — "nope" would otherwise pass clean. Drop in the REAL vetapp taxonomy so the CLI
  // still refuses it, matching planRenameGrammar's own unit-tested behavior above. Committed +
  // pushed, not just written: move-plan's real CLI redirects through a disposable
  // `.claude/coord-worktree` reset from origin/master (withCoordCheckout), so an uncommitted
  // coord.config.json on repo.dir's working tree would never reach it.
  writeFileSync(
    join(repo.dir, 'coord.config.json'),
    JSON.stringify({ planCategories: { allowlist: VETAPP_PLAN_CATEGORIES.allowlist } }),
  );
  repo.g('add', 'coord.config.json');
  repo.g('commit', '-qm', 'plan 4071 test fixture: gate the plan-category allowlist');
  repo.g('push', '-q', 'origin', 'master');
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', '--rename', '050-nope-bad-category.md'],
      repo.movePlan,
    );
    assert.equal(res.code, 2, `expected fatal exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /naming grammar/);
    assert.match(res.stderr, /not in the plan-2329 taxonomy/);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /ready\/050-Infra-foo\.md/,
    );
    assert.equal(
      repo.g('status', '--porcelain', '--untracked-files=no').trim(),
      '',
      'a refused rename must leave a clean tree',
    );
  } finally {
    repo.cleanup();
  }
});

test('move-plan: --rename refuses an in-progress/ plan (branch + queue slug key on the basename)', () => {
  const repo = makeIsolatedRepo({ startFolder: 'in-progress' });
  try {
    const res = runMovePlan(repo.dir, ['050', '--rename', '050-Infra-se-x.md'], repo.movePlan);
    assert.equal(res.code, 2, `expected fatal exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /source lane is in-progress/);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /in-progress\/050-Infra-foo\.md/,
    );
  } finally {
    repo.cleanup();
  }
});

// The rename claim gate is STRICTER than the plan-2082 holder guard: ANY held claim
// refuses, self-held included, and --force does NOT waive it — a claim means a live
// worktree/branch/queue slug keyed on this basename, which a rename would orphan.
test('move-plan: --rename refuses a CLAIMED plan even when self-held, and even with --force', () => {
  const repo = makeIsolatedRepo();
  try {
    const self = 'aaaaaaaa-1111-2222-3333-444444444444';
    pushTestClaim(repo, self);
    for (const args of [
      ['050', '--rename', '050-Infra-se-x.md'],
      ['050', '--rename', '050-Infra-se-x.md', '--force'],
    ]) {
      const res = runMovePlanEnv(repo.dir, args, repo.movePlan, {
        CLAUDE_CODE_SESSION_ID: self,
      });
      assert.equal(
        res.code,
        2,
        `expected fatal exit 2 for ${args.join(' ')}\nstderr:${res.stderr}`,
      );
      assert.match(res.stderr, /refs\/claims\/050 is HELD/);
      assert.match(res.stderr, /that is YOU, and it still refuses/);
    }
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /ready\/050-Infra-foo\.md/,
    );
  } finally {
    repo.cleanup();
  }
});

test('move-plan: --rename refuses a basename that already exists', () => {
  const repo = makeIsolatedRepo();
  try {
    // A sibling plan occupying the target basename, pushed to origin so the
    // coord-checkout's `git ls-files` sees it.
    const sibling = 'docs/superpowers/plans/pending-approval/051-Infra-se-taken.md';
    writeFileSync(join(repo.dir, sibling), MINIMAL_PLAN_BODY);
    repo.g('add', sibling);
    repo.g('commit', '-qm', 'sibling plan');
    repo.g('push', '-q', 'origin', 'master');
    const res = runMovePlan(repo.dir, ['050', '--rename', '051-Infra-se-taken.md'], repo.movePlan);
    assert.equal(res.code, 2, `expected fatal exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    // The id mismatch is caught too — both are real reasons the rename cannot proceed.
    assert.match(res.stderr, /already exists|claims plan id 051/);
  } finally {
    repo.cleanup();
  }
});

test('move-plan: --rename to the SAME name is a self-explaining no-op refusal', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runMovePlan(repo.dir, ['050', '--rename', '050-Infra-foo.md'], repo.movePlan);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /--rename is a no-op/);
  } finally {
    repo.cleanup();
  }
});

test('move-plan: --rename swallowing the next flag is caught before anything else', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runMovePlan(repo.dir, ['050', '--rename', '--dry'], repo.movePlan);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /looks like a flag, not a basename/);
  } finally {
    repo.cleanup();
  }
});

test('move-plan: --dry previews a pure rename as a plain move and changes nothing', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', '--rename', '050-Infra-se-renamed-foo.md', '--dry'],
      repo.movePlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stdout, /\[dry\] rewrite body: body untouched \(pure rename/);
    assert.match(res.stdout, /\[dry\] git mv .*050-Infra-foo\.md .*050-Infra-se-renamed-foo\.md/);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /ready\/050-Infra-foo\.md/,
    );
  } finally {
    repo.cleanup();
  }
});

// A pure rename must not become a retroactive lane audit: the entry gates belong to a
// lane the plan is not entering. A ready/ plan with no cost banner is still renameable.
test('move-plan: a pure rename skips the destination-lane entry gates', () => {
  const repo = makeIsolatedRepo({ body: MINIMAL_PLAN_BODY });
  try {
    const res = runMovePlan(repo.dir, ['050', '--rename', '050-Infra-se-x.md'], repo.movePlan);
    assert.equal(
      res.code,
      0,
      `a bannerless ready/ plan must still be renameable\nstdout:${res.stdout}\nstderr:${res.stderr}`,
    );
    // ...while an actual MOVE into ready/ still enforces the banner gate.
    const moved = runMovePlan(repo.dir, ['050', 'pending-approval'], repo.movePlan);
    assert.equal(moved.code, 0);
    const back = runMovePlan(repo.dir, ['050', 'ready'], repo.movePlan);
    assert.equal(back.code, 2, 'the cost-banner gate must still fire on a real move to ready/');
    assert.match(back.stderr, /Cost forecast/);
  } finally {
    repo.cleanup();
  }
});

// ── plan 2719 review fixes ────────────────────────────────────────────────────
// One case per confirmed finding, so a regression re-breaks a named test.

// Anchored on the frontmatter FENCES, matching the two existing inline FABLE_BODY fixtures
// (plan 2719 fix-pass re-review, finding [4]) — a bare `summary:` match would silently no-op
// if DEFAULT_PLAN_BODY's frontmatter is ever reshaped, quietly degrading the fable-rename
// regression tests below into tests of a NON-fable plan that still pass. The assertion makes
// that failure loud instead of invisible.
const FABLE_PLAN_BODY = DEFAULT_PLAN_BODY.replace(
  '---\nsummary: Test plan for the move-plan happy path\n---',
  '---\nsummary: Test plan for the move-plan happy path\nexecModel: fable\n---',
);
assert.match(FABLE_PLAN_BODY, /^execModel: fable$/m, 'FABLE_PLAN_BODY fixture must be fable');

// plan 3341 fix: the `sol` twin of FABLE_PLAN_BODY, for the parity tests below proving
// the rename-refusal messages name the ACTUAL lane instead of assuming "fable".
const SOL_PLAN_BODY = DEFAULT_PLAN_BODY.replace(
  '---\nsummary: Test plan for the move-plan happy path\n---',
  '---\nsummary: Test plan for the move-plan happy path\nexecModel: sol\n---',
);
assert.match(SOL_PLAN_BODY, /^execModel: sol$/m, 'SOL_PLAN_BODY fixture must be sol');

// [0] The FABLE- auto-stamp used to silently rewrite the operator's validated name.
test('move-plan: --rename refuses a fable plan renamed WITHOUT the FABLE- segment, naming the right string', () => {
  const repo = makeIsolatedRepo({ basename: '050-FABLE-Infra-foo.md', body: FABLE_PLAN_BODY });
  try {
    const res = runMovePlan(repo.dir, ['050', '--rename', '050-Infra-se-x.md'], repo.movePlan);
    assert.equal(res.code, 2, `expected fatal exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /execModel: fable/);
    assert.match(res.stderr, /Pass 050-FABLE-Infra-se-x\.md instead/);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /ready\/050-FABLE-Infra-foo\.md/,
      'the refused rename must leave the plan in place',
    );
  } finally {
    repo.cleanup();
  }
});

test('move-plan: --rename accepts the canonical FABLE- name for a fable plan', () => {
  const repo = makeIsolatedRepo({ basename: '050-FABLE-Infra-foo.md', body: FABLE_PLAN_BODY });
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', '--rename', '050-FABLE-Infra-se-x.md'],
      repo.movePlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /ready\/050-FABLE-Infra-se-x\.md/,
    );
  } finally {
    repo.cleanup();
  }
});

// [4] A FABLE- segment typed onto a NON-fable plan used to pass the grammar and die after
// the git mv on assertExecModelFilenameOk's "should be unreachable" internal error (exit 1).
test('move-plan: --rename refuses a FABLE- segment on a non-fable plan, cleanly and pre-flight', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runMovePlan(
      repo.dir,
      ['050', '--rename', '050-FABLE-Infra-se-x.md'],
      repo.movePlan,
    );
    assert.equal(res.code, 2, `expected fatal exit 2, not an internal error\nstderr:${res.stderr}`);
    assert.match(res.stderr, /frontmatter execModel is not fable/);
    assert.doesNotMatch(res.stderr, /should be unreachable/);
  } finally {
    repo.cleanup();
  }
});

// ── plan 3341 fix: the SOL- lane parity of the three FABLE- tests directly above ──
// Proves the reader grammar (RENAME_BASENAME_RX) accepts a SOL- basename end-to-end, and
// that the refusal messages name the plan's ACTUAL lane/marker instead of the pre-fix
// hardcoded "fable"/"FABLE-" — which used to be simply WRONG for a sol plan.

test('move-plan: --rename refuses a sol plan renamed WITHOUT the SOL- segment, naming the right string', () => {
  const repo = makeIsolatedRepo({ basename: '050-SOL-Infra-foo.md', body: SOL_PLAN_BODY });
  try {
    const res = runMovePlan(repo.dir, ['050', '--rename', '050-Infra-se-x.md'], repo.movePlan);
    assert.equal(res.code, 2, `expected fatal exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /execModel: sol/);
    assert.match(res.stderr, /Pass 050-SOL-Infra-se-x\.md instead/);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /ready\/050-SOL-Infra-foo\.md/,
      'the refused rename must leave the plan in place',
    );
  } finally {
    repo.cleanup();
  }
});

test('move-plan: --rename accepts the canonical SOL- name for a sol plan', () => {
  const repo = makeIsolatedRepo({ basename: '050-SOL-Infra-foo.md', body: SOL_PLAN_BODY });
  try {
    const res = runMovePlan(repo.dir, ['050', '--rename', '050-SOL-Infra-se-x.md'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /ready\/050-SOL-Infra-se-x\.md/,
    );
  } finally {
    repo.cleanup();
  }
});

test('move-plan: --rename refuses a SOL- segment on a non-sol plan, naming "sol" not "fable"', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runMovePlan(repo.dir, ['050', '--rename', '050-SOL-Infra-se-x.md'], repo.movePlan);
    assert.equal(res.code, 2, `expected fatal exit 2, not an internal error\nstderr:${res.stderr}`);
    assert.match(res.stderr, /frontmatter execModel is not sol/);
    assert.doesNotMatch(res.stderr, /should be unreachable/);
  } finally {
    repo.cleanup();
  }
});

// [2] The dropped `/^(\d{3,})/` fallback: a dateless legacy basename has NO plan id, and
// reading its YEAR as one probed an unrelated plan's claim ref.
test('move-plan: --rename refuses a dateless legacy basename instead of reading its year as a plan id', () => {
  const repo = makeIsolatedRepo({ basename: '2026-05-17-legacy-archive-note.md' });
  try {
    const res = runMovePlan(
      repo.dir,
      ['2026-05-17-legacy-archive-note.md', '--rename', '050-Infra-se-x.md'],
      repo.movePlan,
    );
    assert.equal(res.code, 2, `expected fatal exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /cannot determine the plan id/);
    // The refusal must NOT be a claim-ref verdict about the unrelated plan 2026.
    assert.doesNotMatch(res.stderr, /refs\/claims\/2026/);
  } finally {
    repo.cleanup();
  }
});

// [3] The self-held advisory promised "the move proceeds" one line before the rename gate
// fatally refused the same claim.
test('move-plan: a self-held claim + --rename prints no contradictory "move proceeds" note', () => {
  const repo = makeIsolatedRepo();
  try {
    const self = 'aaaaaaaa-1111-2222-3333-444444444444';
    pushTestClaim(repo, self);
    const res = runMovePlanEnv(repo.dir, ['050', '--rename', '050-Infra-se-x.md'], repo.movePlan, {
      CLAUDE_CODE_SESSION_ID: self,
    });
    assert.equal(res.code, 2);
    assert.match(res.stderr, /--rename refuses/);
    assert.doesNotMatch(
      res.stderr,
      /the move proceeds/,
      'the holder guard’s advisory must be suppressed when a rename will refuse',
    );
    // ...but a plain MOVE (no rename) still gets the advisory it always got.
    const moved = runMovePlanEnv(repo.dir, ['050', 'pending-approval'], repo.movePlan, {
      CLAUDE_CODE_SESSION_ID: self,
    });
    assert.equal(moved.code, 0);
    assert.match(moved.stderr, /the move proceeds/);
  } finally {
    repo.cleanup();
  }
});

// [6] One holder-identity string, shared by both claim gates.
test('describeClaimHolder: one phrasing for a parsed holder and for an unparseable record', () => {
  assert.equal(
    describeClaimHolder({ holder: { sessionUuid: 'u', host: 'h', iso: 'i' } }),
    'session u (host h, since i)',
  );
  assert.match(describeClaimHolder({ holder: null }), /UNPARSEABLE claim record/);
  assert.match(describeClaimHolder(undefined), /UNPARSEABLE claim record/);
  // The shared helper still produces claimHolderError's own long-standing wording.
  assert.match(
    claimHolderError(
      { held: true, planId: '050', holder: { sessionUuid: 'u', host: 'h', iso: 'i' } },
      { basename: 'x.md' },
    ),
    /is CLAIMED by session u \(host h, since i\)/,
  );
});

// [9] The rename gate can never accept a basename the canonical PLAN_FILENAME_RX rejects.
test('planRenameGrammar: nothing it accepts can fail the canonical PLAN_FILENAME_RX', () => {
  // The invariant the backstop exists to hold: every ACCEPTED name is one build-index and
  // lint-board recognise as a plan. Swept across the whole taxonomy, plain/FABLE-/SOL-
  // (plan 3341 fix: SOL- added alongside the pre-existing FABLE- sweep).
  for (const category of VETAPP_PLAN_CATEGORIES.allowlist) {
    for (const name of [
      `050-${category}-se-x.md`,
      `050-FABLE-${category}-se-x.md`,
      `050-SOL-${category}-se-x.md`,
    ]) {
      assert.deepEqual(
        planRenameGrammar(name, {
          expectedId: '050',
          allowlist: VETAPP_PLAN_CATEGORIES.allowlist,
        }).errors,
        [],
        name,
      );
      assert.ok(PLAN_FILENAME_RX.test(name), `${name} must satisfy the canonical shape`);
    }
  }
  // A single-char category is off the taxonomy AND off the canonical shape — refused, and
  // the more specific taxonomy message is the one the operator gets.
  assert.match(
    planRenameGrammar('050-A-x.md', { allowlist: VETAPP_PLAN_CATEGORIES.allowlist }).errors.join(
      '\n',
    ),
    /not in the plan-2329 taxonomy/,
  );
});

// ── plan 4136 E4: the lock-free preflight refuses a validation-only failure WITHOUT ever
// acquiring the coord-write lock. Lock evidence is the coord-op-journal's 'start' lines
// (journalCoordOp, coord-git.mjs — written on every real withCoordLock/withCoordCheckout
// acquisition); asserted by COUNT rather than presence/absence of the file itself, since an
// absent journal and a present-but-unchanged one are both "no new lock taken". ────────────
function startJournalCount(dir) {
  return readCoordOpJournal(dir).filter((e) => e.phase === 'start').length;
}

test('move-plan (plan 4136): a content-gate refusal (waiting-operator missing --unblock) takes NO coord-write lock', () => {
  const repo = makeIsolatedRepo(); // default body has NO unblock: field
  try {
    const before = startJournalCount(repo.dir);
    const res = runMovePlan(
      repo.dir,
      ['050', 'waiting-operator', '--blocked-by', 'operator decision'],
      repo.movePlan,
    );
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /requires an "unblock: manual\|decision"/);
    assert.equal(
      startJournalCount(repo.dir),
      before,
      'a content-gate refusal must never journal a coord-write lock acquisition',
    );
    assert.ok(existsSync(join(repo.dir, repo.srcRel)), 'plan must remain in ready/');
  } finally {
    repo.cleanup();
  }
});

test('move-plan (plan 4136): a pure argument error (unknown target) takes NO coord-write lock', () => {
  const repo = makeRepoWithPlan();
  try {
    const before = startJournalCount(repo.dir);
    const res = runMovePlan(repo.dir, ['050', 'drafting']);
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /invalid target "drafting"/);
    assert.equal(
      startJournalCount(repo.dir),
      before,
      'a pure argument error must never journal a coord-write lock acquisition',
    );
  } finally {
    repo.cleanup();
  }
});

test('move-plan (plan 4136): a VALID move still succeeds and DOES journal a coord-write lock start (proves the assertion can fail)', () => {
  const repo = makeIsolatedRepo();
  try {
    const before = startJournalCount(repo.dir);
    const res = runMovePlan(repo.dir, ['050', 'in-progress'], repo.movePlan);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.ok(
      startJournalCount(repo.dir) > before,
      'a real move must still journal a coord-write lock start',
    );
  } finally {
    repo.cleanup();
  }
});
