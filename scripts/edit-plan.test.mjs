// scripts/edit-plan.test.mjs (plan 533, Task 1)
// Unit tests for edit-plan's pure logic: arg parsing, mode selection, and the literal
// find→replace transform. The git/coordWrite integration (resolve on $MAIN → freshen →
// commit → push) is exercised by the live tooling, not re-mocked here — same split as
// move-plan.test / coord-config.test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { isolatedRepoFactory } from './test-helpers/isolated-plan-repo.mjs';
import {
  parseEditArgs,
  selectMode,
  applyFindReplace,
  indexBulletAffected,
  decideSelfHeal,
  diffFrontmatterKeys,
  staleBaseRefusalMessage,
  wouldDropFrontmatter,
  frontmatterDropRefusalMessage,
  missingBaseShaRefusalMessage,
  assertClaimedOverrideOk,
  assertAlsoOk,
  editClaimHolderError,
  invalidExecModelMessage,
} from './edit-plan.mjs';
import { collectPlans } from './coord/build-index.mjs';
import {
  renderPlansBlock,
  splicePlansBlock,
  MUTATION_BANNER_LABEL,
} from './coord/build-index-lib.mjs';
// plan 3958: this module ships as-is into the public coord-kit, so MUTATION_BANNER_LABEL
// resolves to the kit's neutral 'DATA-WRITE' default there, not vetapp's real 'SEED-WRITE' row —
// every fixture below that hardcodes the literal banner text runs through this helper instead.
// Identity function on vetapp itself (where the label really is 'SEED-WRITE').
const sw = (s) => s.replaceAll('SEED-WRITE', MUTATION_BANNER_LABEL);
// The ONE authority for a claim ref's name (plan 3973 round-2 review fix, finding 330360) —
// never a hand-built `refs/claims/<id>` string. `legacyClaimRef` (not `claimRef`) because
// these fixtures deliberately push into the PRE-3756 namespace planStatus's dual-read still
// honours (see pushTestClaim's own comment below).
import { legacyClaimRef } from './coord/coord-refs.mjs';

for (const name of [
  'COORD_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'GROK_SESSION_ID',
])
  delete process.env[name];

// plan 338's inherited-git-env clear (GIT_DIR/GIT_WORK_TREE/…) runs at import of
// test-helpers/isolated-plan-repo.mjs above, so the temp-repo helpers below honour
// `git -C <tmpdir>` even when this suite runs inside a git hook.

test('parseEditArgs: id + value flags + booleans', () => {
  assert.deepEqual(parseEditArgs(['533', '--find', 'a', '--replace', 'b', '--all', '--dry']), {
    idOrName: '533',
    flags: { find: 'a', replace: 'b', all: true, dry: true },
  });
});

test('parseEditArgs: a value-flag consumes the next token even if it looks like a flag', () => {
  // The F1 fix: `--replace --dry` must yield replace='--dry', NOT strip --dry as a boolean.
  const { flags } = parseEditArgs(['533', '--find', 'x', '--replace', '--dry']);
  assert.equal(flags.replace, '--dry');
  assert.equal(flags.dry, undefined); // not set — it was consumed as the replace value
});

test('parseEditArgs: empty --replace value preserved', () => {
  assert.equal(parseEditArgs(['533', '--find', 'x', '--replace', '']).flags.replace, '');
});

test('parseEditArgs: unknown flag is a loud error (catches typos)', () => {
  assert.throws(() => parseEditArgs(['533', '--mesage', 'oops']), /unknown flag --mesage/);
});

test('parseEditArgs: a single-dash typo refuses loudly (plan 1769 deliberate strictness)', () => {
  // Pre-1769 the loop silently discarded `-dry` as an extra positional — a typo'd dry-run
  // flag ran a REAL edit. parseFlags refuses instead; this pins the new contract.
  assert.throws(() => parseEditArgs(['533', '--body', 'x.md', '-dry']), /unknown flag -dry/);
});

test('parseEditArgs: missing id → idOrName null', () => {
  assert.equal(parseEditArgs(['--body', 'x.md']).idOrName, null);
});

test('parseEditArgs: --base-sha is a value flag (plan 1642)', () => {
  const { flags } = parseEditArgs(['533', '--body', 'x.md', '--base-sha', 'deadbeef']);
  assert.equal(flags['base-sha'], 'deadbeef');
});

test('parseEditArgs: --allow-frontmatter-drop is a boolean flag (plan 3079)', () => {
  const { flags } = parseEditArgs(['533', '--body', 'x.md', '--allow-frontmatter-drop']);
  assert.equal(flags['allow-frontmatter-drop'], true);
});

test('selectMode: --body alone → body mode', () => {
  assert.deepEqual(selectMode({ body: 'x.md' }), { mode: 'body', file: 'x.md' });
});

test('selectMode: --find + --replace → replace mode, all defaults false', () => {
  assert.deepEqual(selectMode({ find: 'a', replace: 'b' }), {
    mode: 'replace',
    find: 'a',
    replace: 'b',
    all: false,
  });
});

test('selectMode: --all boolean threads through from flags', () => {
  assert.equal(selectMode({ find: 'a', replace: 'b', all: true }).all, true);
});

test('selectMode: --replace empty string is a valid (delete) replacement', () => {
  assert.deepEqual(selectMode({ find: 'a', replace: '' }), {
    mode: 'replace',
    find: 'a',
    replace: '',
    all: false,
  });
});

test('selectMode: --body + --find rejected', () => {
  assert.throws(() => selectMode({ body: 'x.md', find: 'a', replace: 'b' }), /cannot be combined/);
});

test('selectMode: half-specified find/replace rejected', () => {
  assert.throws(() => selectMode({ find: 'a' }), /must be given together/);
  assert.throws(() => selectMode({ replace: 'b' }), /must be given together/);
});

test('selectMode: no mode given rejected', () => {
  assert.throws(() => selectMode({}), /need --body/);
});

test('applyFindReplace: first occurrence only by default', () => {
  assert.equal(applyFindReplace('a X a X a', 'X', 'Y', false), 'a Y a X a');
});

test('applyFindReplace: --all replaces every occurrence', () => {
  assert.equal(applyFindReplace('a X a X a', 'X', 'Y', true), 'a Y a Y a');
});

test('applyFindReplace: replacement is literal — $& / $1 not interpreted', () => {
  // String#replace with a string pattern would expand `$&`; the function replacer must not.
  assert.equal(applyFindReplace('hello', 'hello', '$& world', false), '$& world');
  assert.equal(applyFindReplace('a a', 'a', '$&!', true), '$&! $&!');
});

test('applyFindReplace: find absent → content unchanged', () => {
  assert.equal(applyFindReplace('abc', 'Z', 'Y', false), 'abc');
});

test('applyFindReplace: checkbox check-off (the canonical use)', () => {
  const before = '- [ ] **T1** — build the thing\n- [ ] **T2** — doc it';
  const after = applyFindReplace(before, '- [ ] **T1**', '- [x] **T1**', false);
  assert.equal(after, '- [x] **T1** — build the thing\n- [ ] **T2** — doc it');
});

test('applyFindReplace: empty --find rejected', () => {
  assert.throws(() => applyFindReplace('abc', '', 'Y', false), /non-empty/);
});

// ---------------------------------------------------------------------------------------
// plan 1398 (item 1) — decideSelfHeal: the sibling-vs-own-attempt race fix. The sentinel
// (movedRelThisLoop) is loop-local state owned by mutate()'s enclosing closure; this pure
// function is just the DECISION given that state + whether absPlan is missing.

test('decideSelfHeal: absPlan present → no decision needed, regardless of the sentinel', () => {
  assert.equal(decideSelfHeal(false, false), null);
  assert.equal(decideSelfHeal(true, false), null);
});

test(
  'decideSelfHeal: sibling case — pre-delete absPlan before the first mutate() attempt ' +
    '(sentinel false) → clear abort, never resurrect',
  () => {
    assert.equal(decideSelfHeal(false, true), 'abort');
  },
);

test(
  'decideSelfHeal: own-heal case — sentinel flipped (this loop already moved rel once) ' +
    'and absPlan missing again → resurrection still happens',
  () => {
    assert.equal(decideSelfHeal(true, true), 'heal');
  },
);

// ---------------------------------------------------------------------------------------
// plan 1642 — the pure stale-base-guard helpers: diffFrontmatterKeys (diagnostic diff) and
// staleBaseRefusalMessage (the refusal text mutate() throws). The live retry/coordWrite
// integration is exercised by the CLI tests further down (same split as decideSelfHeal
// above vs. the FABLE-rename CLI tests).

test('diffFrontmatterKeys: detects added/changed frontmatter keys, ignores unchanged ones', () => {
  const base = '---\nsummary: s\n---\n\nbody';
  const master = '---\nsummary: s\nstage: specced\nspecReview: abc123\n---\n\nbody';
  const diffs = diffFrontmatterKeys(base, master);
  const byKey = Object.fromEntries(diffs.map((d) => [d.key, d]));
  assert.equal(byKey.stage.baseValue, null);
  assert.equal(byKey.stage.masterValue, 'specced');
  assert.equal(byKey.specReview.masterValue, 'abc123');
  assert.equal(byKey.summary, undefined, 'unchanged key is not reported as a diff');
});

test('diffFrontmatterKeys: a key REMOVED on master is reported (masterValue null)', () => {
  const base = '---\nsummary: s\nstage: specced\n---\n\nbody';
  const master = '---\nsummary: s\n---\n\nbody';
  const diffs = diffFrontmatterKeys(base, master);
  assert.deepEqual(diffs, [{ key: 'stage', baseValue: 'specced', masterValue: null }]);
});

test('diffFrontmatterKeys: no frontmatter on either side → empty diff', () => {
  assert.deepEqual(diffFrontmatterKeys('# Title\n\nbody', '# Title\n\nother body'), []);
});

test('staleBaseRefusalMessage: calls out stage/specReview on their own CLOBBER RISK line', () => {
  const base = '---\nsummary: s\n---\n\nbody';
  const master = '---\nsummary: s\nstage: specced\nspecReview: abc123\n---\n\nbody';
  const msg = staleBaseRefusalMessage('1635-Infra-x.md', base, master);
  assert.match(msg, /CLOBBER RISK/);
  assert.match(msg, /stage: \(absent\) → specced/);
  assert.match(msg, /specReview: \(absent\) → abc123/);
  assert.match(msg, /stale-base/);
  assert.match(msg, /--find\/--replace/);
});

test('staleBaseRefusalMessage: a non-frontmatter (body-prose-only) change still gets a clear fallback line', () => {
  const base = '---\nsummary: s\n---\n\nold body';
  const master = '---\nsummary: s\n---\n\nnew body';
  const msg = staleBaseRefusalMessage('x.md', base, master);
  assert.match(msg, /no frontmatter-key changes detected/);
  assert.doesNotMatch(msg, /CLOBBER RISK/);
});

test('staleBaseRefusalMessage: a non-loud frontmatter change is still shown, just not as CLOBBER RISK', () => {
  const base = '---\nsummary: old\n---\n\nbody';
  const master = '---\nsummary: new\n---\n\nbody';
  const msg = staleBaseRefusalMessage('x.md', base, master);
  assert.match(msg, /other frontmatter changes/);
  assert.match(msg, /summary: old → new/);
  assert.doesNotMatch(msg, /CLOBBER RISK/);
});

// ---------------------------------------------------------------------------------------
// plan 3079 — the frontmatter-drop guard's pure helpers: wouldDropFrontmatter (the trigger
// predicate) and frontmatterDropRefusalMessage (the refusal text mutate() throws). Mirrors the
// plan-1642 stale-base tests above in style/placement; the live mutate()/coordWrite wiring
// (`!flags['allow-frontmatter-drop'] && wouldDropFrontmatter(bodyBytes, freshContent)` in
// edit-plan.mjs) is exercised here by asserting that exact gate expression directly, same as
// the CLI's own guard — these stay pure unit tests rather than needing a full isolated-repo run.

test('wouldDropFrontmatter: frontmatter-less body vs a stamped master → true (case 1)', () => {
  const body = '# Title\n\nsome new body text with no frontmatter fence\n';
  const master = '---\nstage: specced\nexecModel: sonnet\n---\n\n# Title\n\nold body\n';
  assert.equal(wouldDropFrontmatter(body, master), true);
});

test('frontmatterDropRefusalMessage: names every doomed frontmatter key (case 1)', () => {
  const master = '---\nstage: specced\nexecModel: sonnet\nspecReview: abc123\n---\n\nbody\n';
  const msg = frontmatterDropRefusalMessage('3079-x.md', master);
  assert.match(msg, /stage/);
  assert.match(msg, /execModel/);
  assert.match(msg, /specReview/);
  assert.match(msg, /--allow-frontmatter-drop/);
  assert.match(msg, /3079-x\.md/);
});

test('wouldDropFrontmatter + --allow-frontmatter-drop: the CLI gate does not refuse (case 2)', () => {
  // Mirrors mutate()'s own guard expression verbatim: `!flags['allow-frontmatter-drop'] &&
  // wouldDropFrontmatter(bodyBytes, freshContent)` — with the flag set, the guard never fires
  // even though the drop condition itself is still true.
  const body = 'no frontmatter here\n';
  const master = '---\nstage: specced\n---\n\nbody\n';
  const { flags } = parseEditArgs(['3079', '--body', 'x.md', '--allow-frontmatter-drop']);
  assert.equal(wouldDropFrontmatter(body, master), true, 'the drop condition is still true');
  assert.equal(
    !flags['allow-frontmatter-drop'] && wouldDropFrontmatter(body, master),
    false,
    'but the flag suppresses the CLI guard',
  );
});

test('wouldDropFrontmatter: body WITH its own frontmatter block → false (case 3, wholesale replace unchanged)', () => {
  const body = '---\nstage: draft\n---\n\nnew body\n';
  const master = '---\nstage: specced\nexecModel: sonnet\n---\n\nold body\n';
  assert.equal(wouldDropFrontmatter(body, master), false);
});

test('wouldDropFrontmatter: master has NO frontmatter fence either → false (case 4, nothing to drop)', () => {
  const body = '# Title\n\nnew body, no fence\n';
  const master = '# Title\n\nold body, also no fence\n';
  assert.equal(wouldDropFrontmatter(body, master), false);
});

// ---------------------------------------------------------------------------------------
// plan 3244 — missingBaseShaRefusalMessage: the pure message builder for the mandatory
// --base-sha refusal that replaced plan 1642 review fix [A]'s auto-capture. Mirrors the
// staleBaseRefusalMessage/frontmatterDropRefusalMessage unit tests above in style/placement;
// the live CLI wiring (the `if (!baseSha)` gate in main()) is exercised by the CLI tests
// further down.

test('missingBaseShaRefusalMessage: names --base-sha, the rev-parse capture step, and the "authored from" wording', () => {
  const msg = missingBaseShaRefusalMessage('3244');
  assert.match(msg, /--base-sha/);
  assert.match(msg, /rev-parse/);
  assert.match(msg, /authored from/);
  assert.match(msg, /3244/, 'echoes the id/basename the caller typed');
});

// plan 3341: invalidExecModelMessage — the pure refusal-message helper for an execModel
// write the shared VALID_EXEC_MODELS enum doesn't recognize. Mirrors the placement/style
// of the other refusal-message unit tests above; the live CLI wiring (the check in
// main() right after `afterBody` is computed) is exercised by the CLI tests further down.
test('invalidExecModelMessage: names the bad value, the basename, and the valid set', () => {
  const msg = invalidExecModelMessage('060-Infra-foo.md', 'opus');
  assert.match(msg, /"opus"/);
  assert.match(msg, /060-Infra-foo\.md/);
  assert.match(msg, /sonnet|fable|sol/);
  assert.match(msg, /reads as sonnet/);
});

// ---------------------------------------------------------------------------------------
// plan 696 — INDEX-bullet resync when a body edit changes the bullet. indexBulletAffected
// is the pure decision (does the bullet's rendered text shift?). resyncIndex itself runs the
// canonical generator scripts/build-index.mjs as a subprocess, so the regen transform under
// it is build-index's collectPlans + renderPlansBlock + splicePlansBlock — exercised here via
// the same injectable seams build-index.test uses (no git). Together they prove the contract
// resyncIndex relies on: after a summary edit, the regenerated INDEX reflects the new summary
// and is idempotent (== `build-index --check` clean), so a body+INDEX co-commit can't strand a
// stale INDEX. (The coordWrite/subprocess wiring is exercised by the live tooling, not git-
// mocked here — same split as move-plan.test / the pure-logic tests above.)

const fm = (summary, { seed = 'no', h1 = 'Title', body = 'body' } = {}) =>
  `---\nsummary: ${summary}\n---\n\n> ${seed === 'yes' ? '🟥' : '🟩'} **${MUTATION_BANNER_LABEL}: ${seed === 'yes' ? 'YES' : 'NO'}**\n\n# ${h1}\n\n${body}\n`;

test('indexBulletAffected: a summary-frontmatter change → true (the trap this plan closes)', () => {
  assert.equal(indexBulletAffected(fm('old summary'), fm('new summary')), true);
});

test('indexBulletAffected: a body edit that leaves summary+marker untouched → false (checkbox tick)', () => {
  const before = fm('same', { body: '- [ ] **T1** do it' });
  const after = fm('same', { body: '- [x] **T1** do it' });
  assert.equal(indexBulletAffected(before, after), false);
});

test('indexBulletAffected: identical bodies → false', () => {
  assert.equal(indexBulletAffected(fm('same'), fm('same')), false);
});

test('indexBulletAffected: H1 change on a frontmatter-less plan → true (the H1 fallback summary)', () => {
  const before = '# Old title\n\nbody';
  const after = '# New title\n\nbody';
  assert.equal(indexBulletAffected(before, after), true);
});

test('indexBulletAffected: a SEED-WRITE marker flip → true (the bullet emoji changes)', () => {
  assert.equal(indexBulletAffected(fm('s', { seed: 'no' }), fm('s', { seed: 'yes' })), true);
});

test('indexBulletAffected: seedLane=false ignores the marker (build-index renders 🟩 either way)', () => {
  // With no seed lane, build-index always renders 🟩, so a banner flip must NOT count as a
  // bullet change — but a summary change still does.
  assert.equal(
    indexBulletAffected(fm('s', { seed: 'no' }), fm('s', { seed: 'yes' }), { seedLane: false }),
    false,
  );
  assert.equal(
    indexBulletAffected(fm('old', { seed: 'no' }), fm('new', { seed: 'no' }), { seedLane: false }),
    true,
  );
});

test('plan 696: resync transform reflects the new summary and is idempotent (build-index --check clean)', () => {
  const REL = 'docs/superpowers/plans/in-progress/696-Infra-x.md';
  const OTHER = 'docs/superpowers/plans/ready/690-Infra-y.md';
  const bodies = {
    [REL]: fm('OLD summary for 696'),
    [OTHER]: fm('summary for 690'),
  };
  // The pure core of resyncIndex(mainDir): collectPlans(seams) → render → splice.
  const regenerate = (indexContent) => {
    const { plans } = collectPlans({
      lsFiles: () => Object.keys(bodies),
      readFile: (rel) => bodies[rel],
    });
    return splicePlansBlock(indexContent, renderPlansBlock(plans));
  };
  const sentinelOnly =
    'preamble\n\n<!-- INDEX:PLANS-START (generated by scripts/build-index.mjs — do not hand-edit between the sentinels) -->\n\n<!-- INDEX:PLANS-END -->\n\nMoved to `docs/superpowers/plans/archive/` …\n';

  // Build a baseline INDEX from the OLD bodies, then "edit" 696's summary.
  const baseline = regenerate(sentinelOnly);
  assert.match(baseline, /OLD summary for 696/);
  bodies[REL] = fm('NEW summary for 696'); // <-- the summary-frontmatter edit

  // After resync the bullet carries the NEW summary and the OLD text is gone.
  const resynced = regenerate(baseline);
  assert.match(resynced, /NEW summary for 696/);
  assert.doesNotMatch(resynced, /OLD summary for 696/);
  assert.match(resynced, /summary for 690/); // sibling bullet untouched

  // Idempotent: regenerating again is a no-op ⇔ `build-index --check` would be clean.
  assert.equal(regenerate(resynced), resynced);
});

// ---------------------------------------------------------------------------------------
// plan 1362 (D2) — edit-plan auto-stamps the FABLE- filename segment as part of the SAME
// coordWrite commit when an edit ADDS execModel: fable to a plan's frontmatter. Full
// subprocess/coordWrite integration test — the isolated-repo harness is the shared
// test-helpers/isolated-plan-repo.mjs scaffold (bare origin + clone + the whole scripts/
// tool tree copied in, since resyncIndex spawns the COPY's own build-index.mjs).

const DEFAULT_EDIT_BODY = [
  '---',
  'summary: Test plan for edit-plan FABLE- auto-stamp',
  '---',
  '',
  sw('> 🟩 **SEED-WRITE: no**'),
  '',
  '**Status:** 📋 READY — opened 2026-07-04.',
  '',
  '# 060-Infra-foo',
  '',
  'Body.',
  '',
].join('\n');

// The shared isolated-plan-repo scaffold with this suite's defaults baked in; the
// `editPlan` key is the COPIED tool inside the temp repo (run that copy, never the
// real tool).
const makeIsolatedRepo = isolatedRepoFactory({
  prefix: 'editplan-iso',
  basename: '060-Infra-foo.md',
  body: DEFAULT_EDIT_BODY,
  tools: { editPlan: 'edit-plan.mjs' },
});

test('edit-plan CLI: an edit that ADDS execModel: fable auto-stamps the FABLE- filename + resyncs INDEX (plan 1362 D2)', () => {
  const repo = makeIsolatedRepo();
  try {
    const baseSha = repo.g('rev-parse', `HEAD:${repo.srcRel}`).trim();
    const newBody = DEFAULT_EDIT_BODY.replace(
      '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\n---',
      '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\nexecModel: fable\n---',
    );
    const bodyFile = join(repo.dir, '.scratch-body.md');
    writeFileSync(bodyFile, newBody);
    const out = execFileSync(
      'node',
      [repo.editPlan, '060', '--body', bodyFile, '--base-sha', baseSha],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    assert.match(out, /renamed to 060-FABLE-Infra-foo\.md/);

    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/060-FABLE-Infra-foo\.md/, 'plan renamed on origin');
    assert.doesNotMatch(tree, /ready\/060-Infra-foo\.md$/m, 'old basename is gone');
    const newPlanBody = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/ready/060-FABLE-Infra-foo.md',
    );
    assert.match(newPlanBody, /^execModel: fable$/m);
    assert.match(
      repo.g('show', 'origin/master:docs/INDEX.md'),
      /→ `ready\/060-FABLE-Infra-foo\.md`/,
      'INDEX bullet points at the renamed file',
    );
  } finally {
    repo.cleanup();
  }
});

// plan 3341: the sol-lane twin of the FABLE- auto-stamp test above, via --find/--replace
// (no --base-sha plumbing needed) rather than --body — proves stampedRelForExecModel's
// generalization to `sol` is actually WIRED into edit-plan's live coordWrite path, not
// just correct in isolation.
test('edit-plan CLI: a --find/--replace edit that ADDS execModel: sol auto-stamps the SOL- filename + resyncs INDEX (plan 3341)', () => {
  const repo = makeIsolatedRepo();
  try {
    const out = execFileSync(
      'node',
      [
        repo.editPlan,
        '060',
        '--find',
        '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\n---',
        '--replace',
        '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\nexecModel: sol\n---',
      ],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    assert.match(out, /renamed to 060-SOL-Infra-foo\.md/);

    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/060-SOL-Infra-foo\.md/, 'plan renamed on origin');
    assert.doesNotMatch(tree, /ready\/060-Infra-foo\.md$/m, 'old basename is gone');
    const newPlanBody = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/ready/060-SOL-Infra-foo.md',
    );
    assert.match(newPlanBody, /^execModel: sol$/m);
    assert.match(
      repo.g('show', 'origin/master:docs/INDEX.md'),
      /→ `ready\/060-SOL-Infra-foo\.md`/,
      'INDEX bullet points at the renamed file',
    );
  } finally {
    repo.cleanup();
  }
});

// plan 3341: an execModel write the shared enum doesn't recognize is refused BEFORE any
// git mutation — the whole point of importing VALID_EXEC_MODELS rather than accepting any
// string --find/--replace could write.
test('edit-plan CLI: a --find/--replace edit that writes an unrecognized execModel is refused, nothing pushed (plan 3341)', () => {
  const repo = makeIsolatedRepo();
  try {
    assert.throws(
      () =>
        execFileSync(
          'node',
          [
            repo.editPlan,
            '060',
            '--find',
            '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\n---',
            '--replace',
            '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\nexecModel: opus\n---',
          ],
          { cwd: repo.dir, encoding: 'utf8' },
        ),
      (e) => {
        assert.equal(e.status, 2);
        const out = `${e.stdout || ''}${e.stderr || ''}`;
        assert.match(out, /refusing to write execModel: "opus"/);
        assert.match(out, /060-Infra-foo\.md/);
        return true;
      },
    );
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/060-Infra-foo\.md$/m, 'basename untouched');
    const landed = repo.g('show', 'origin/master:docs/superpowers/plans/ready/060-Infra-foo.md');
    assert.doesNotMatch(landed, /execModel/, 'nothing was pushed — original content untouched');
  } finally {
    repo.cleanup();
  }
});

// Force EXACTLY ONE non-ff push during the subprocess edit-plan run — same trick as
// move-plan.test.mjs's installOneShotNonFfHook (adapted): a sibling pushes a neutral
// file right before OUR push lands, forcing coordWrite's retry loop to fire once. This
// is the scenario the self-heal comment in edit-plan.mjs's mutate() exists for: a
// FAILED first attempt leaves `rel` missing from disk (coordWrite's generic revert
// can't undo a rename) — the retry's mutate() must recover and still land correctly.
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
      "for (const k of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_COMMON_DIR','GIT_NAMESPACE','GIT_PREFIX']) delete process.env[k];",
      'const origin = process.argv[2];',
      "const sib = mkdtempSync(join(tmpdir(), 'editplan-sib-'));",
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

test('edit-plan CLI: a FABLE- auto-stamp rename survives a forced non-ff retry (plan 1362 self-heal)', () => {
  const repo = makeIsolatedRepo();
  try {
    // The forced retry's sibling push touches an unrelated neutral file (never our plan's
    // content — see installOneShotNonFfHook above), so the base sha captured before the
    // subprocess starts stays valid for every coordWrite attempt in this run.
    const baseSha = repo.g('rev-parse', `HEAD:${repo.srcRel}`).trim();
    installOneShotNonFfHook(repo.dir, repo.origin);
    const newBody = DEFAULT_EDIT_BODY.replace(
      '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\n---',
      '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\nexecModel: fable\n---',
    );
    const bodyFile = join(repo.dir, '.scratch-body.md');
    writeFileSync(bodyFile, newBody);
    const out = execFileSync(
      'node',
      [repo.editPlan, '060', '--body', bodyFile, '--base-sha', baseSha],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    assert.match(out, /renamed to 060-FABLE-Infra-foo\.md/);

    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/060-FABLE-Infra-foo\.md/, 'plan renamed on origin after the retry');
    assert.doesNotMatch(tree, /ready\/060-Infra-foo\.md$/m, 'old basename is gone');
    assert.match(
      tree,
      /sibling-neutral\.txt/,
      'the sibling advance that forced the retry landed too',
    );
    const newPlanBody = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/ready/060-FABLE-Infra-foo.md',
    );
    assert.match(newPlanBody, /^execModel: fable$/m);
  } finally {
    repo.cleanup();
  }
});

// plan 4087 T4-B: the 2026-09-06 ledger incident
// (edit-plan-reports-already-up-to-date-after-index-lock-commit-failure). `coordWrite`'s
// "already up to date" report (res.noop, edit-plan.mjs's ~1142) comes ONLY from
// `mutate()` declaring an empty write or from `nothingStagedFor`'s pre-commit diff-quiet
// probe — BEFORE `coordLandCommit`'s own commit step ever runs. This reproduces a genuine,
// PERSISTENT index.lock contention on the disposable coord-checkout (a rival process
// holding the lock for the whole op, never clearing) by spawning a detached refresher that
// keeps a real index.lock file's mtime fresh — so `waitForIndexLock`'s own stale-lock
// self-heal (30s mtime threshold, coord-git.mjs's STALE_LOCK_MS) cannot silently absorb it
// — and asserts the CORRECT behaviour: edit-plan must surface the failure (non-zero exit,
// index-lock wording) and must NEVER report "already up to date" for a real edit that never
// committed.
function spawnIndexLockRefresher(lockPath) {
  const code = [
    "const { utimesSync, writeFileSync, existsSync, mkdirSync } = require('fs');",
    "const { dirname } = require('path');",
    'const p = process.argv[1];',
    'mkdirSync(dirname(p), { recursive: true });',
    'setInterval(() => {',
    '  try {',
    "    if (!existsSync(p)) writeFileSync(p, '');",
    '    const now = new Date();',
    '    utimesSync(p, now, now);',
    '  } catch {}',
    '}, 150);',
  ].join('\n');
  return spawn(process.execPath, ['-e', code, lockPath], { detached: true, stdio: 'ignore' });
}

// plan 4087 review follow-up (finding 1db412o): the call site below used to guess a 300ms
// wall-clock delay for "long enough that the refresher has probably planted the lock file by
// now" — a real timer racing a real process, the ambient-load shape this repo's CLAUDE.md
// forbids (the correct wait is a property of the machine's current load, not of the code under
// test). Block on the refresher's OWN signal — the lock file actually existing — instead.
function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFileSync(path, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`waitForFileSync: ${path} did not appear within ${timeoutMs}ms`);
    }
    syncSleep(intervalMs);
  }
}

test(
  // VERDICT (2026-09-22): DID NOT REPRODUCE. This test PASSES on the code it was written
  // against — a persistent index.lock makes edit-plan die loudly at resolveCoordCheckout's
  // own reset/clean, before coordWrite's mutate/add/commit ever run, with a correctly
  // diagnosed "blocked by index.lock ... after 10 attempts". "Already up to date" is
  // unreachable on that path. The ledger line is retired as ALREADY-FIXED and this test is
  // kept as the standing proof. See plan 4087 S9.
  'plan 4087 T4-B: a persistent index.lock fails loudly, never "already up to date" (ledger line does NOT reproduce)',
  { timeout: 90_000 },
  () => {
    const repo = makeIsolatedRepo();
    let refresher = null;
    try {
      // Warm-up edit: materialises .claude/coord-worktree so its index.lock path resolves.
      execFileSync(
        'node',
        [repo.editPlan, '060', '--find', 'Body.', '--replace', 'Body. (warmup)'],
        { cwd: repo.dir, encoding: 'utf8' },
      );
      const coordWorktreeDir = join(repo.dir, '.claude', 'coord-worktree');
      // `rev-parse --git-path` returns an ABSOLUTE path on this host (Windows git) — mirror
      // coord-git.mjs's own indexLockPath, which resolves either shape the same way.
      const lockRel = execFileSync(
        'git',
        ['-C', coordWorktreeDir, 'rev-parse', '--git-path', 'index.lock'],
        { encoding: 'utf8' },
      ).trim();
      const lockPath = isAbsolute(lockRel) ? lockRel : join(coordWorktreeDir, lockRel);
      refresher = spawnIndexLockRefresher(lockPath);
      // Block on the refresher's own signal (the lock file existing) instead of guessing how
      // long it needs to plant it before edit-plan's first git call.
      waitForFileSync(lockPath);

      let threw = null;
      let out = null;
      try {
        out = execFileSync(
          'node',
          [repo.editPlan, '060', '--find', 'Body. (warmup)', '--replace', 'Body. (real edit)'],
          { cwd: repo.dir, encoding: 'utf8', timeout: 80_000 },
        );
      } catch (e) {
        threw = e;
      }

      // CORRECT behaviour, asserted so this test fails now (reproduction) and turns green
      // once the fix lands: edit-plan must never claim "already up to date" for an edit that
      // could not actually commit because the coord-checkout's index was locked throughout.
      if (!threw) {
        assert.doesNotMatch(
          String(out),
          /already up to date/,
          `edit-plan reported "already up to date" despite a persistent index.lock on the ` +
            `coord-checkout — the edit never committed. Output: ${out}`,
        );
      }
      assert.ok(
        threw,
        `edit-plan must surface the persistent index.lock failure (non-zero exit) rather than ` +
          `silently succeed — got output: ${JSON.stringify(out)}`,
      );
      // The real edit must never have landed on origin.
      repo.g('fetch', '-q', 'origin', 'master');
      const landed = repo.g('show', 'origin/master:docs/superpowers/plans/ready/060-Infra-foo.md');
      assert.doesNotMatch(
        landed,
        /Body\. \(real edit\)/,
        'the locked-out edit never reached origin',
      );
    } finally {
      if (refresher) {
        try {
          process.kill(-refresher.pid);
        } catch {
          try {
            refresher.kill();
          } catch {
            /* best-effort */
          }
        }
      }
      repo.cleanup();
    }
  },
);

// plan 1642: install a pre-push hook that fires ONCE — before our own push, a "sibling"
// session clones origin, stamps the SAME plan file's frontmatter (adds `<stampLine>` right
// after the opening `---` fence), commits, and pushes — forcing our push to fail non-ff and
// triggering coordWrite's retry. Mirrors installOneShotNonFfHook above, but the sibling's
// edit lands on OUR EXACT pathspec (not a neutral file), simulating the 2026-07-09 plan-1635
// incident (a parallel session's spec-pass stamp landing between our base-read and our push).
function installOneShotSiblingStampHook(dir, origin, planRelPath, stampLine) {
  const posix = (p) => p.replace(/\\/g, '/');
  const hooksDir = join(dir, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const sentinel = join(dir, '.git', 'nonff-stamp-fired');
  const fixture = join(dir, '.git', 'sibling-stamp.mjs');
  writeFileSync(
    fixture,
    [
      "import { execFileSync } from 'node:child_process';",
      "import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      "for (const k of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_COMMON_DIR','GIT_NAMESPACE','GIT_PREFIX']) delete process.env[k];",
      'const origin = process.argv[2];',
      'const rel = process.argv[3];',
      'const stampLine = process.argv[4];',
      "const sib = mkdtempSync(join(tmpdir(), 'editplan-stamp-sib-'));",
      // --config core.autocrlf=false at CLONE time (not after — the checkout already
      // happened by then): a plain `git clone` on this Windows host can pick up an
      // ambient global core.autocrlf=true and check the plan file out with CRLF line
      // endings, silently breaking a literal '\\n' match below.
      "execFileSync('git', ['clone', '-q', '--config', 'core.autocrlf=false', origin, sib]);",
      "execFileSync('git', ['-C', sib, 'config', 'user.email', 'sib@t.t']);",
      "execFileSync('git', ['-C', sib, 'config', 'user.name', 'sib']);",
      'const abs = join(sib, rel);',
      "const before = readFileSync(abs, 'utf8');",
      // \\r?\\n so this is robust even if autocrlf still slipped through.
      "const after = before.replace(/---\\r?\\n/, '---\\n' + stampLine + '\\n');",
      'writeFileSync(abs, after);',
      "execFileSync('git', ['-C', sib, 'add', rel]);",
      "execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling spec-pass stamp']);",
      "execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);",
      'rmSync(sib, { recursive: true, force: true });',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(hooksDir, 'pre-push'),
    [
      '#!/bin/sh',
      `if [ ! -f '${posix(sentinel)}' ]; then`,
      `  : > '${posix(sentinel)}'`,
      `  '${posix(process.execPath)}' '${posix(fixture)}' '${posix(origin)}' '${posix(planRelPath)}' '${stampLine}' || exit 1`,
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

// Round-4 review fix (finding de5c83): a sibling pre-push hook that fires ONCE — before OUR
// push, a "sibling" session clones origin, applies a literal find→replace to a NAMED plan
// file (removing the SAME --find text our own edit targets, on ONE plan only) and pushes,
// forcing our own push non-ff. Models a concurrent session editing away the --also plan's
// (or the primary's) find text between our base-read and our retry — the asymmetric-find-
// loss scenario the M4 fix refuses rather than silently half-applying.
function installOneShotSiblingEditHook(dir, origin, planRelPath, find, replace) {
  const posix = (p) => p.replace(/\\/g, '/');
  const hooksDir = join(dir, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const sentinel = join(dir, '.git', 'nonff-edit-fired');
  const fixture = join(dir, '.git', 'sibling-edit.mjs');
  writeFileSync(
    fixture,
    [
      "import { execFileSync } from 'node:child_process';",
      "import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      "for (const k of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_COMMON_DIR','GIT_NAMESPACE','GIT_PREFIX']) delete process.env[k];",
      'const origin = process.argv[2];',
      'const rel = process.argv[3];',
      'const find = process.argv[4];',
      'const replace = process.argv[5];',
      "const sib = mkdtempSync(join(tmpdir(), 'editplan-edit-sib-'));",
      "execFileSync('git', ['clone', '-q', '--config', 'core.autocrlf=false', origin, sib]);",
      "execFileSync('git', ['-C', sib, 'config', 'user.email', 'sib@t.t']);",
      "execFileSync('git', ['-C', sib, 'config', 'user.name', 'sib']);",
      'const abs = join(sib, rel);',
      "const before = readFileSync(abs, 'utf8');",
      'const after = before.split(find).join(replace);',
      'writeFileSync(abs, after);',
      "execFileSync('git', ['-C', sib, 'add', rel]);",
      "execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling edit']);",
      "execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);",
      'rmSync(sib, { recursive: true, force: true });',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(hooksDir, 'pre-push'),
    [
      '#!/bin/sh',
      `if [ ! -f '${posix(sentinel)}' ]; then`,
      `  : > '${posix(sentinel)}'`,
      `  '${posix(process.execPath)}' '${posix(fixture)}' '${posix(origin)}' '${posix(planRelPath)}' '${find}' '${replace}' || exit 1`,
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

test('edit-plan CLI: --body REFUSES when a sibling stamps the plan between base-read and push (plan 1642 stale-base guard, the plan-1635 incident)', () => {
  const repo = makeIsolatedRepo();
  try {
    // The base sha is captured BEFORE the sibling's stamp lands — the sibling only fires
    // once OUR OWN push reaches the pre-push hook (installOneShotSiblingStampHook), so this
    // sha is exactly what a compliant caller would have read+authored from.
    const baseSha = repo.g('rev-parse', `HEAD:${repo.srcRel}`).trim();
    installOneShotSiblingStampHook(repo.dir, repo.origin, repo.srcRel, 'stage: specced');
    const newBody = DEFAULT_EDIT_BODY.replace('Body.', 'Body v2 (unaware of the stamp).');
    const bodyFile = join(repo.dir, '.scratch-body.md');
    writeFileSync(bodyFile, newBody);

    assert.throws(
      () =>
        execFileSync('node', [repo.editPlan, '060', '--body', bodyFile, '--base-sha', baseSha], {
          cwd: repo.dir,
          encoding: 'utf8',
        }),
      (e) => {
        const out = `${e.stdout || ''}${e.stderr || ''}`;
        assert.match(out, /stale-base/);
        assert.match(out, /CLOBBER RISK/);
        assert.match(out, /stage: \(absent\) → specced/);
        return true;
      },
    );

    // The sibling's landed stamp must survive untouched — never clobbered — and our stale
    // content must never have landed.
    repo.g('fetch', '-q', 'origin', 'master');
    const landed = repo.g('show', `origin/master:${repo.srcRel}`);
    assert.match(landed, /^stage: specced$/m, "sibling's stamp preserved on master");
    assert.doesNotMatch(landed, /Body v2/, 'our stale --body content never landed');
  } finally {
    repo.cleanup();
  }
});

// plan 3079 — the frontmatter-drop guard through the REAL mutate()/coordWrite path. The pure
// helper tests above pin the predicate and the message; these two pin the WIRING, which a
// retyped copy of the guard expression cannot: remove or miswire the check in mutate() and
// these go red. Same isolated-repo harness as the plan-1642 stale-base CLI tests above.

test('edit-plan CLI: --body REFUSES a frontmatter-less body over a stamped plan (plan 3079 frontmatter-drop guard)', () => {
  const repo = makeIsolatedRepo();
  try {
    const baseSha = repo.g('rev-parse', `HEAD:${repo.srcRel}`).trim();
    // A body authored WITHOUT a frontmatter fence — the exact 2026-08-09 authoring bug.
    const newBody = ['# 060-Infra-foo', '', 'Rewritten body, no frontmatter fence.', ''].join('\n');
    const bodyFile = join(repo.dir, '.scratch-body.md');
    writeFileSync(bodyFile, newBody);

    assert.throws(
      () =>
        execFileSync('node', [repo.editPlan, '060', '--body', bodyFile, '--base-sha', baseSha], {
          cwd: repo.dir,
          encoding: 'utf8',
        }),
      (e) => {
        const out = `${e.stdout || ''}${e.stderr || ''}`;
        assert.match(out, /frontmatter-drop guard/);
        assert.match(out, /summary/, 'names the key that would be lost');
        assert.match(out, /--allow-frontmatter-drop/, 'names the escape hatch');
        return true;
      },
    );

    // Master's stamped copy must survive BYTE-IDENTICAL — a partial "frontmatter still
    // present" check would pass a mutation that kept `summary:` while rewriting the rest.
    repo.g('fetch', '-q', 'origin', 'master');
    const landed = repo.g('show', `origin/master:${repo.srcRel}`);
    assert.equal(landed, DEFAULT_EDIT_BODY, 'the plan on master is completely untouched');
  } finally {
    repo.cleanup();
  }
});

test('edit-plan CLI: --allow-frontmatter-drop lets the same frontmatter-less body through (plan 3079 escape hatch)', () => {
  const repo = makeIsolatedRepo();
  try {
    const baseSha = repo.g('rev-parse', `HEAD:${repo.srcRel}`).trim();
    const newBody = ['# 060-Infra-foo', '', 'Deliberately de-stamped body.', ''].join('\n');
    const bodyFile = join(repo.dir, '.scratch-body.md');
    writeFileSync(bodyFile, newBody);

    execFileSync(
      'node',
      [repo.editPlan, '060', '--body', bodyFile, '--base-sha', baseSha, '--allow-frontmatter-drop'],
      { cwd: repo.dir, encoding: 'utf8' },
    );

    // BYTE-IDENTICAL to what we asked for — so "the whole frontmatter block is gone" is
    // proven by the comparison itself, not by probing for one key that happened to vanish.
    repo.g('fetch', '-q', 'origin', 'master');
    const landed = repo.g('show', `origin/master:${repo.srcRel}`);
    assert.equal(landed, newBody, 'the opted-in replace landed exactly as authored');
  } finally {
    repo.cleanup();
  }
});

test('edit-plan CLI: --body SUCCEEDS (guard is a no-op) when the caller re-supplies content that already matches the sibling-stamped master', () => {
  // Idempotent-retry / already-applied case: bodyBytes happens to equal what's now on
  // master (post-stamp) — must NOT be treated as a conflict.
  const repo = makeIsolatedRepo();
  try {
    // Captured BEFORE the sibling's stamp lands — the base is genuinely stale by push time,
    // but the fast-path (freshContent === bodyBytes) below is what actually lets this through.
    const baseSha = repo.g('rev-parse', `HEAD:${repo.srcRel}`).trim();
    installOneShotSiblingStampHook(repo.dir, repo.origin, repo.srcRel, 'stage: specced');
    // Must byte-match what the sibling fixture actually produces — it inserts the stamp
    // line immediately after the OPENING fence (mirrors installOneShotSiblingStampHook's
    // own `before.replace(/---\r?\n/, ...)`), i.e. BEFORE `summary:`, not after — the
    // guard's fast-path is a byte-exact compare, so key ORDER matters here.
    const alreadyLanded = DEFAULT_EDIT_BODY.replace('---\n', '---\nstage: specced\n');
    const bodyFile = join(repo.dir, '.scratch-body.md');
    writeFileSync(bodyFile, alreadyLanded);

    const out = execFileSync(
      'node',
      [repo.editPlan, '060', '--body', bodyFile, '--base-sha', baseSha],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    // The guard's fast-path (freshContent === bodyBytes) lets mutate() proceed to WRITE, but
    // since the write reproduces content byte-identical to the freshened base, coordWrite's
    // OWN diff-cached short-circuit then finds nothing staged — a clean no-op, not a wasted
    // push. Either outcome proves the guard didn't refuse; this is the one coordWrite itself
    // actually produces here.
    assert.match(out, /already up to date/);
    repo.g('fetch', '-q', 'origin', 'master');
    const landed = repo.g('show', `origin/master:${repo.srcRel}`);
    assert.match(landed, /^stage: specced$/m, "sibling's stamp still present (never reverted)");
  } finally {
    repo.cleanup();
  }
});

test('edit-plan CLI: --find/--replace is UNCHANGED by the plan-1642 guard — still applies against the fresh retry base under the same forced sibling stamp', () => {
  const repo = makeIsolatedRepo();
  try {
    installOneShotSiblingStampHook(repo.dir, repo.origin, repo.srcRel, 'stage: specced');
    const out = execFileSync(
      'node',
      [repo.editPlan, '060', '--find', 'Body.', '--replace', 'Body (edited).'],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    assert.match(out, /committed \+ pushed/);
    repo.g('fetch', '-q', 'origin', 'master');
    const landed = repo.g('show', `origin/master:${repo.srcRel}`);
    assert.match(landed, /^stage: specced$/m, "sibling's stamp preserved");
    assert.match(landed, /Body \(edited\)\./, 'our find/replace applied cleanly on the retry');
  } finally {
    repo.cleanup();
  }
});

test('edit-plan CLI: an unresolvable --base-sha fails fast with exit 2 (no coordWrite/lock entered)', () => {
  const repo = makeIsolatedRepo();
  try {
    const bodyFile = join(repo.dir, '.scratch-body.md');
    writeFileSync(bodyFile, DEFAULT_EDIT_BODY.replace('Body.', 'Body v2.'));
    assert.throws(
      () =>
        execFileSync(
          'node',
          [
            repo.editPlan,
            '060',
            '--body',
            bodyFile,
            '--base-sha',
            'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          ],
          { cwd: repo.dir, encoding: 'utf8' },
        ),
      (e) => {
        assert.equal(e.status, 2);
        assert.match(`${e.stdout || ''}${e.stderr || ''}`, /--base-sha/);
        return true;
      },
    );
    // Nothing pushed — origin still holds only the original seed commit's content.
    repo.g('fetch', '-q', 'origin', 'master');
    const landed = repo.g('show', `origin/master:${repo.srcRel}`);
    assert.match(landed, /Body\./, 'origin untouched by the failed invocation');
  } finally {
    repo.cleanup();
  }
});

test('edit-plan CLI: (d) happy path — --base-sha captured at read time with no intervening write proceeds cleanly (plan 3244)', () => {
  const repo = makeIsolatedRepo();
  try {
    const goodSha = repo.g('rev-parse', `HEAD:${repo.srcRel}`).trim();
    const bodyFile = join(repo.dir, '.scratch-body.md');
    writeFileSync(bodyFile, DEFAULT_EDIT_BODY.replace('Body.', 'Body v2.'));
    const out = execFileSync(
      'node',
      [repo.editPlan, '060', '--body', bodyFile, '--base-sha', goodSha],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    assert.match(out, /committed \+ pushed/);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(repo.g('show', `origin/master:${repo.srcRel}`), /Body v2\./);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------
// plan 1642 review fix [A]/[B]/[D]/[E] — xhigh review of the plan-1642 stale-base guard.

// A "sibling session" pushes straight to `origin` — never touching `dir`'s own local
// master branch/working tree, mirroring mainDir's deliberate "never auto-synced" invariant
// the module header describes.
// Insert one frontmatter line into a plan file ON DISK, whatever line endings that checkout used.
// Git for Windows ships `core.autocrlf = true` in its SYSTEM gitconfig
// (C:/Program Files/Git/etc/gitconfig), so EVERY repo on a Windows box — including the throwaway
// clones these fixtures make — has CRLF in the working tree while the committed blob stays LF. A
// fixture that pattern-matches a literal '---\n' therefore matches nothing there and silently
// writes the file back unchanged: the mutation the test's premise depends on never happens, the
// sibling commit carries only the OTHER change beside it, and the assertion that was supposed to
// fire has nothing to fire on. That is a Linux-green / Windows-red shape (measured 2026-08-17: the
// plan-3244 case (b) test landed green on a cloud drain and then failed every local land's battery
// on `Missing expected exception`), so the no-op is asserted away rather than left to line endings.
function stampFrontmatterLine(file, line) {
  const before = readFileSync(file, 'utf8');
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const after = before.replace(`---${eol}`, `---${eol}${line}${eol}`);
  assert.notEqual(
    after,
    before,
    `fixture: stamping "${line}" into ${file} changed nothing — no frontmatter fence found ` +
      `for ${JSON.stringify(eol)} line endings`,
  );
  writeFileSync(file, after);
}

function pushSiblingCommit(origin, mutateFn, message) {
  const sib = mkdtempSync(join(tmpdir(), 'editplan-sib2-'));
  execFileSync('git', ['clone', '-q', origin, sib]);
  execFileSync('git', ['-C', sib, 'config', 'user.email', 'sib@t.t']);
  execFileSync('git', ['-C', sib, 'config', 'user.name', 'sib']);
  mutateFn(sib);
  execFileSync('git', ['-C', sib, 'add', '-A']);
  execFileSync('git', ['-C', sib, 'commit', '-qm', message]);
  execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
  rmSync(sib, { recursive: true, force: true });
}

test(
  'edit-plan CLI: an explicit --base-sha resolves a plan freshly minted+pushed by a SIBLING — ' +
    "present on origin/master, absent from mainDir's own checkout (plan 3244 — the auto-capture " +
    'this pinned pre-retirement, plan 1642 review fix [A], is gone; the object-store read it ' +
    'relied on is exercised the same way through an explicit --base-sha now)',
  () => {
    const repo = makeIsolatedRepo();
    try {
      const newPlanRel = 'docs/superpowers/plans/ready/062-Infra-baz.md';
      const newPlanBody = [
        '---',
        'summary: freshly minted by a sibling',
        '---',
        '',
        sw('> 🟩 **SEED-WRITE: no**'),
        '',
        '# 062-Infra-baz',
        '',
        'Original body.',
        '',
      ].join('\n');
      pushSiblingCommit(
        repo.origin,
        (sib) => writeFileSync(join(sib, newPlanRel), newPlanBody),
        'sibling: mint 062-Infra-baz',
      );

      // repo.dir's OWN checkout genuinely does not have it — never fetched/merged.
      assert.throws(() => repo.g('cat-file', '-e', `HEAD:${newPlanRel}`));

      // The base sha is resolved straight from origin/master's OBJECT STORE — `git cat-file -p`
      // (edit-plan's own resolve, below) needs only the shared object database, not a synced
      // working tree, so mainDir's own checkout being stale/never-having-seen-062 never blocks
      // this: `git fetch` then `git rev-parse origin/master:<path>`, exactly the flow
      // missingBaseShaRefusalMessage teaches.
      repo.g('fetch', '-q', 'origin', 'master');
      const baseSha = repo.g('rev-parse', `origin/master:${newPlanRel}`).trim();

      const editedBody = newPlanBody.replace('Original body.', 'Edited via explicit base-sha.');
      const bodyFile = join(repo.dir, '.scratch-062-body.md');
      writeFileSync(bodyFile, editedBody);

      // The plan resolves+lands even though mainDir's own on-disk checkout never saw 062 at
      // all — resolution happens inside the coord-checkout (cdir), freshly reset to
      // origin/master, not against mainDir's stale filesystem state.
      const out = execFileSync(
        'node',
        [repo.editPlan, '062', '--body', bodyFile, '--base-sha', baseSha],
        { cwd: repo.dir, encoding: 'utf8' },
      );
      assert.match(out, /committed \+ pushed/);

      repo.g('fetch', '-q', 'origin', 'master');
      assert.match(repo.g('show', `origin/master:${newPlanRel}`), /Edited via explicit base-sha\./);
    } finally {
      repo.cleanup();
    }
  },
);

test(
  'edit-plan CLI: a stale-base refusal on a RENAME-triggering edit does not leave the ' +
    'coord-checkout with an uncommitted `git mv` (plan 1642 review fix [B])',
  () => {
    const repo = makeIsolatedRepo();
    try {
      const baseSha = repo.g('rev-parse', `HEAD:${repo.srcRel}`).trim();
      installOneShotSiblingStampHook(repo.dir, repo.origin, repo.srcRel, 'stage: specced');
      const newBody = DEFAULT_EDIT_BODY.replace(
        '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\n---',
        '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\nexecModel: fable\n---',
      ).replace('Body.', 'Body v2 (unaware of the stamp).');
      const bodyFile = join(repo.dir, '.scratch-body.md');
      writeFileSync(bodyFile, newBody);

      assert.throws(
        () =>
          execFileSync('node', [repo.editPlan, '060', '--body', bodyFile, '--base-sha', baseSha], {
            cwd: repo.dir,
            encoding: 'utf8',
          }),
        (e) => {
          const out = `${e.stdout || ''}${e.stderr || ''}`;
          assert.match(out, /stale-base/);
          return true;
        },
      );

      // The refusal must fire BEFORE the rename: the coord-checkout must be left CLEAN, never
      // carrying a half-done `git mv` the refusal message itself doesn't even mention.
      const coordCheckout = join(repo.dir, '.claude', 'coord-worktree');
      const status = execFileSync('git', ['-C', coordCheckout, 'status', '--porcelain'], {
        encoding: 'utf8',
      });
      assert.equal(
        status.trim(),
        '',
        'coord-checkout must be clean after the aborted rename+refusal',
      );

      repo.g('fetch', '-q', 'origin', 'master');
      const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
      assert.match(
        tree,
        /ready\/060-Infra-foo\.md/,
        'plan NOT renamed on origin — the refusal aborted it',
      );
      assert.doesNotMatch(tree, /FABLE/, 'no FABLE- rename landed');
    } finally {
      repo.cleanup();
    }
  },
);

test("edit-plan CLI: a --base-sha resolving to a LARGE (>1MB) blob does not blow node execFileSync's default maxBuffer (plan 1642 review fix [D])", () => {
  const bigBody = DEFAULT_EDIT_BODY + 'x'.repeat(2 * 1024 * 1024); // > node's default 1MB maxBuffer
  const repo = makeIsolatedRepo({ body: bigBody });
  try {
    const goodSha = repo.g('rev-parse', `HEAD:${repo.srcRel}`).trim();
    const bodyFile = join(repo.dir, '.scratch-body.md');
    writeFileSync(bodyFile, bigBody.replace('Body.', 'Body v2.'));
    const out = execFileSync(
      'node',
      [repo.editPlan, '060', '--body', bodyFile, '--base-sha', goodSha],
      { cwd: repo.dir, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    );
    assert.match(out, /committed \+ pushed/);
    repo.g('fetch', '-q', 'origin', 'master');
    // repo.g's own execFileSync wrapper has no maxBuffer override (out of scope to change it
    // for this one large-blob assertion) — call git directly with a bumped maxBuffer instead.
    const landed = execFileSync('git', ['-C', repo.dir, 'show', `origin/master:${repo.srcRel}`], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.match(landed, /Body v2\./);
  } finally {
    repo.cleanup();
  }
});

test(
  'edit-plan CLI: --dry --body skips the stale-base capture entirely — an otherwise-' +
    'unresolvable --base-sha does not block a dry preview (plan 1642 review fix [E])',
  () => {
    const repo = makeIsolatedRepo();
    try {
      const bodyFile = join(repo.dir, '.scratch-body.md');
      writeFileSync(bodyFile, DEFAULT_EDIT_BODY.replace('Body.', 'Body v2.'));
      // Pre-fix, the --base-sha resolution ran UNCONDITIONALLY before the dry check, so this
      // unresolvable sha would exit 2 even under --dry. Post-fix, --dry skips the capture
      // entirely and the preview succeeds.
      const out = execFileSync(
        'node',
        [
          repo.editPlan,
          '060',
          '--body',
          bodyFile,
          '--base-sha',
          'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          '--dry',
        ],
        { cwd: repo.dir, encoding: 'utf8' },
      );
      assert.match(out, /^\[dry\]/);
      repo.g('fetch', '-q', 'origin', 'master');
      assert.match(repo.g('show', `origin/master:${repo.srcRel}`), /Body\./, 'nothing pushed');
    } finally {
      repo.cleanup();
    }
  },
);

test('edit-plan CLI: in-progress/ plans are never auto-renamed even when execModel: fable is added (plan 1362)', () => {
  const body = DEFAULT_EDIT_BODY.replace('060-Infra-foo', '061-Infra-bar');
  const repo = makeIsolatedRepo({ startFolder: 'in-progress', basename: '061-Infra-bar.md', body });
  try {
    const baseSha = repo.g('rev-parse', `HEAD:${repo.srcRel}`).trim();
    const newBody = body.replace(
      '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\n---',
      '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\nexecModel: fable\n---',
    );
    const bodyFile = join(repo.dir, '.scratch-body.md');
    writeFileSync(bodyFile, newBody);
    const out = execFileSync(
      'node',
      [repo.editPlan, '061', '--body', bodyFile, '--base-sha', baseSha],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    assert.doesNotMatch(out, /renamed to/);

    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /in-progress\/061-Infra-bar\.md/, 'unstamped basename preserved');
    assert.doesNotMatch(tree, /FABLE/, 'no auto-stamp in in-progress/');
    const newPlanBody = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/in-progress/061-Infra-bar.md',
    );
    assert.match(newPlanBody, /^execModel: fable$/m, 'the frontmatter edit still lands');
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------
// plan 3244 — retiring the auto-capture stale-base blind spot: --base-sha is now REQUIRED
// for --body, and the two measured incidents (2026-08-12 plan-2339 sequential-stale-author,
// 2026-08-08 plan-2977 lane-move-vs-edit) get direct regression coverage here. (c) and (d)
// round out the four cases the plan calls for: missing-flag refusal, and the happy path
// (already covered above by "an explicit --base-sha pinned to the CURRENT blob behaves like
// auto-capture" — that test IS case (d): sha captured at read time, no intervening write,
// proceeds cleanly).

test(
  'edit-plan CLI: (a) a sequential second --body edit that omits --base-sha (relying on the ' +
    'now-retired auto-capture) refuses instead of silently dropping the first edit — the ' +
    '2026-08-12 plan-2339 sequential-stale-author incident, shape 1. RED against pre-change ' +
    'edit-plan.mjs: auto-capture resolved the second base to the FRESH (post-edit1) tip, which ' +
    'trivially matched at compare time, so the guard passed and edit1 was silently dropped.',
  () => {
    const repo = makeIsolatedRepo();
    try {
      const baseSha = repo.g('rev-parse', `HEAD:${repo.srcRel}`).trim();

      // Edit1: authored correctly against the real base, lands cleanly.
      const body1 = DEFAULT_EDIT_BODY.replace('Body.', 'Body v1 (first edit, adds a section).');
      const bodyFile1 = join(repo.dir, '.scratch-body1.md');
      writeFileSync(bodyFile1, body1);
      const out1 = execFileSync(
        'node',
        [repo.editPlan, '060', '--body', bodyFile1, '--base-sha', baseSha],
        { cwd: repo.dir, encoding: 'utf8' },
      );
      assert.match(out1, /committed \+ pushed/);

      // Edit2: a SEPARATE invocation authored from the SAME stale in-context copy a session
      // composing several --body edits in a row carries — and, matching the actual incident,
      // omits --base-sha (the pre-fix optional auto-capture path). Post-fix this is refused
      // outright by the mandatory-flag guard BEFORE it can even reach the stale-base compare,
      // closing the hole at its root instead of relying on the compare to catch a base that was
      // never even captured. Pre-fix, auto-capture resolved the base to the CURRENT (post-edit1)
      // origin/master tip — which trivially matched at compare time since nothing else had
      // changed — so the guard passed and edit1's addition was silently overwritten.
      const body2 = DEFAULT_EDIT_BODY.replace('Body.', 'Body v2 (unaware edit1 ever landed).');
      const bodyFile2 = join(repo.dir, '.scratch-body2.md');
      writeFileSync(bodyFile2, body2);

      assert.throws(
        () =>
          execFileSync('node', [repo.editPlan, '060', '--body', bodyFile2], {
            cwd: repo.dir,
            encoding: 'utf8',
          }),
        (e) => {
          assert.equal(e.status, 2, `expected exit 2\nstdout:${e.stdout}\nstderr:${e.stderr}`);
          assert.match(`${e.stdout || ''}${e.stderr || ''}`, /--base-sha/);
          return true;
        },
      );

      // The FIRST edit's content must survive untouched — the second, stale-authored edit
      // never landed (the exact content-loss the incident measured).
      repo.g('fetch', '-q', 'origin', 'master');
      const landed = repo.g('show', `origin/master:${repo.srcRel}`);
      assert.match(landed, /Body v1 \(first edit, adds a section\)\./, "edit1's content survives");
      assert.doesNotMatch(landed, /Body v2/, 'edit2 never landed — no silent drop of edit1');
    } finally {
      repo.cleanup();
    }
  },
);

test(
  'edit-plan CLI: (b) a --base-sha predating a lane move + frontmatter stamp of the SAME plan ' +
    'still refuses — edit-plan resolves the plan by id at its NEW path, and the stale-base ' +
    'compare still fires there (the 2026-08-08 plan-2977 incident, shape 2)',
  () => {
    const repo = makeIsolatedRepo();
    try {
      const staleSha = repo.g('rev-parse', `HEAD:${repo.srcRel}`).trim();

      // A parallel session moves the plan to a new lane AND stamps its frontmatter (e.g. a
      // spec-pass) — landed on origin BEFORE our stale --body call runs.
      const newRel = repo.srcRel.replace('/ready/', '/in-progress/');
      pushSiblingCommit(
        repo.origin,
        (sib) => {
          execFileSync('git', ['-C', sib, 'mv', repo.srcRel, newRel]);
          stampFrontmatterLine(join(sib, newRel), 'stage: specced');
        },
        'sibling: lane move + spec-pass stamp',
      );

      const bodyFile = join(repo.dir, '.scratch-body.md');
      writeFileSync(bodyFile, DEFAULT_EDIT_BODY.replace('Body.', 'Body v2 (pre-move snapshot).'));

      assert.throws(
        () =>
          execFileSync('node', [repo.editPlan, '060', '--body', bodyFile, '--base-sha', staleSha], {
            cwd: repo.dir,
            encoding: 'utf8',
          }),
        (e) => {
          const out = `${e.stdout || ''}${e.stderr || ''}`;
          assert.match(out, /stale-base/);
          assert.match(out, /CLOBBER RISK/);
          assert.match(out, /stage: \(absent\) → specced/);
          return true;
        },
      );

      repo.g('fetch', '-q', 'origin', 'master');
      const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
      assert.match(tree, /in-progress\/060-Infra-foo\.md/, 'plan resolved+found at its NEW path');
      const landed = repo.g('show', `origin/master:${newRel}`);
      assert.match(landed, /^stage: specced$/m, "the sibling's move+stamp survives untouched");
      assert.doesNotMatch(landed, /Body v2/, 'the stale --body content never landed');
    } finally {
      repo.cleanup();
    }
  },
);

test(
  'edit-plan CLI: (c) --body with no --base-sha refuses immediately — exit 2, no coordWrite/lock ' +
    'entered, teaching message names --base-sha/rev-parse/"authored from" (plan 3244 mandatory flag). ' +
    'RED against pre-change edit-plan.mjs: it silently auto-captured a base instead of refusing.',
  () => {
    const repo = makeIsolatedRepo();
    try {
      const bodyFile = join(repo.dir, '.scratch-body.md');
      writeFileSync(bodyFile, DEFAULT_EDIT_BODY.replace('Body.', 'Body v2.'));
      assert.throws(
        () =>
          execFileSync('node', [repo.editPlan, '060', '--body', bodyFile], {
            cwd: repo.dir,
            encoding: 'utf8',
          }),
        (e) => {
          assert.equal(e.status, 2, `expected exit 2\nstdout:${e.stdout}\nstderr:${e.stderr}`);
          const out = `${e.stdout || ''}${e.stderr || ''}`;
          assert.match(out, /--base-sha/);
          assert.match(out, /rev-parse/);
          assert.match(out, /authored from/);
          return true;
        },
      );
      // Nothing pushed — origin still holds only the original seed content, and no coord lock
      // was ever taken (the refusal fires before withCoordCheckout is entered).
      repo.g('fetch', '-q', 'origin', 'master');
      assert.match(
        repo.g('show', `origin/master:${repo.srcRel}`),
        /Body\./,
        'origin untouched — no coordWrite/lock entered',
      );
    } finally {
      repo.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------------------
// plan 2729 — the claimed-plan edit guard: edit-plan.mjs must refuse to mutate a plan
// whose refs/claims/<id> is held by ANOTHER session, mirroring move-plan.mjs's plan-2082
// guard verbatim in predicate + failure handling, with a `--claimed-override "<reason>"`
// escape hatch (never move-plan's bare `--force`) whose reason is stamped into the
// coordWrite commit subject. Pure-function cases first (editClaimHolderError,
// assertClaimedOverrideOk — the same split move-plan.test.mjs uses for claimHolderError),
// then CLI cases mirroring move-plan.test.mjs's pushTestClaim/runMovePlanEnv shape.

test('editClaimHolderError: unheld and self-held proceed; foreign, unparseable, and unprovable-self refuse', () => {
  const other = {
    sessionUuid: 'ffffffff-0000-0000-0000-000000000000',
    host: 'other-pc',
    iso: '2026-07-19T00:00:00.000Z',
  };
  const ctx = { basename: '060-Infra-foo.md' };
  const status = (held, holder, youAreHolder) => ({ planId: '060', held, holder, youAreHolder });
  assert.equal(editClaimHolderError(status(false, null, false), ctx), null, 'unheld → proceed');
  assert.equal(
    editClaimHolderError(status(true, other, true), ctx),
    null,
    'self-held (planStatus proved youAreHolder) → proceed',
  );
  const foreign = editClaimHolderError(status(true, other, false), ctx);
  assert.match(foreign, /CLAIMED by session ffffffff-0000/);
  assert.match(foreign, /host other-pc/);
  assert.match(foreign, /SendMessage/, 'names the send-to-executor channel');
  assert.match(foreign, /--claimed-override/, 'names the reasoned-override channel');
  assert.doesNotMatch(foreign, /--force\b/, 'never move-plans bare --force');
  assert.match(
    editClaimHolderError(status(true, null, false), ctx),
    /UNPARSEABLE claim record/,
    'held ref with an unparseable message → refuse (self-hold cannot be proven)',
  );
  const unprovable = editClaimHolderError(status(true, other, false), {
    ...ctx,
    selfIdKnown: false,
  });
  assert.match(unprovable, /CLAIMED by session/);
  assert.match(unprovable, /no coordination session identity/);
});

test('assertClaimedOverrideOk: absent flag is fine; bare/empty/flag-shaped refuse; a real reason passes', () => {
  assert.doesNotThrow(() => assertClaimedOverrideOk({}));
  assert.doesNotThrow(() => assertClaimedOverrideOk({ 'claimed-override': 'operator directed' }));
  // A bare trailing --claimed-override resolves to an explicit `undefined` VALUE with the
  // key still PRESENT (parseFlags) — distinct from the flag never being given at all.
  assert.throws(
    () => assertClaimedOverrideOk({ 'claimed-override': undefined }),
    /requires a non-empty/,
  );
  assert.throws(() => assertClaimedOverrideOk({ 'claimed-override': '' }), /requires a non-empty/);
  assert.throws(
    () => assertClaimedOverrideOk({ 'claimed-override': '--dry' }),
    /looks like a flag, not a reason/,
  );
});

// Push a parentless claim commit for plan 060 to the temp origin, mirroring
// claim-plan's acquireRef (empty tree + message-as-holder-record) — same shape as
// move-plan.test.mjs's pushTestClaim, adapted to this suite's seed plan id.
function pushTestClaim(repo, sessionUuid, { planId = '060' } = {}) {
  const msg = [
    `claim plan=${planId}`,
    `session=${sessionUuid}`,
    'host=test-host',
    'iso=2026-07-19T00:00:00.000Z',
  ].join('\n');
  const sha = repo.g('commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', msg).trim();
  repo.g('push', '-q', 'origin', `${sha}:${legacyClaimRef(planId)}`);
}

// Like a plain subprocess run but with an env override, so the claim-guard CLI tests can
// pin CLAUDE_CODE_SESSION_ID deterministically regardless of the harness environment —
// the edit-plan analogue of move-plan.test.mjs's runMovePlanEnv.
function runEditPlanEnv(dir, args, scriptPath, envOverride = {}) {
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

test('edit-plan CLI: a plan claimed by ANOTHER session refuses to edit (plan 2729)', () => {
  const repo = makeIsolatedRepo();
  try {
    pushTestClaim(repo, 'ffffffff-0000-0000-0000-000000000000');
    const res = runEditPlanEnv(
      repo.dir,
      ['060', '--find', 'Body.', '--replace', 'Body (edited).'],
      repo.editPlan,
      { CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-1111-2222-3333-444444444444' },
    );
    assert.equal(res.code, 2, `expected fatal exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /CLAIMED by session ffffffff-0000/);
    assert.match(res.stderr, /SendMessage/);
    assert.match(res.stderr, /--claimed-override/);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.doesNotMatch(
      repo.g('show', `origin/master:${repo.srcRel}`),
      /Body \(edited\)\./,
      'refused edit must leave the plan unchanged on origin',
    );
  } finally {
    repo.cleanup();
  }
});

test('edit-plan CLI: a SELF-held claim proceeds (plan 2729)', () => {
  const repo = makeIsolatedRepo();
  try {
    const self = 'aaaaaaaa-1111-2222-3333-444444444444';
    pushTestClaim(repo, self);
    const res = runEditPlanEnv(
      repo.dir,
      ['060', '--find', 'Body.', '--replace', 'Body (edited).'],
      repo.editPlan,
      { CLAUDE_CODE_SESSION_ID: self },
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(repo.g('show', `origin/master:${repo.srcRel}`), /Body \(edited\)\./);
  } finally {
    repo.cleanup();
  }
});

test('edit-plan CLI: an UNCLAIMED plan proceeds normally (plan 2729)', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runEditPlanEnv(
      repo.dir,
      ['060', '--find', 'Body.', '--replace', 'Body (edited).'],
      repo.editPlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(repo.g('show', `origin/master:${repo.srcRel}`), /Body \(edited\)\./);
  } finally {
    repo.cleanup();
  }
});

test('edit-plan CLI: --claimed-override with no reason refuses (exit 2, no coordWrite entered)', () => {
  const repo = makeIsolatedRepo();
  try {
    pushTestClaim(repo, 'ffffffff-0000-0000-0000-000000000000');
    const res = runEditPlanEnv(
      repo.dir,
      ['060', '--find', 'Body.', '--replace', 'Body (edited).', '--claimed-override'],
      repo.editPlan,
      { CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-1111-2222-3333-444444444444' },
    );
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /--claimed-override requires a non-empty/);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.doesNotMatch(repo.g('show', `origin/master:${repo.srcRel}`), /Body \(edited\)\./);
  } finally {
    repo.cleanup();
  }
});

test(
  'edit-plan CLI: --claimed-override with a reason proceeds on a FOREIGN-held claim, ' +
    'and the reason reaches the commit subject (plan 2729)',
  () => {
    const repo = makeIsolatedRepo();
    try {
      pushTestClaim(repo, 'ffffffff-0000-0000-0000-000000000000');
      const res = runEditPlanEnv(
        repo.dir,
        [
          '060',
          '--find',
          'Body.',
          '--replace',
          'Body (edited).',
          '--claimed-override',
          'operator directed — see board',
        ],
        repo.editPlan,
        { CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-1111-2222-3333-444444444444' },
      );
      assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
      repo.g('fetch', '-q', 'origin', 'master');
      assert.match(repo.g('show', `origin/master:${repo.srcRel}`), /Body \(edited\)\./);
      const subject = repo.g('log', '-1', '--format=%s', 'origin/master');
      assert.match(subject, /\[claimed-override: operator directed — see board\]/);
    } finally {
      repo.cleanup();
    }
  },
);

// ───────────────── plan 3973 (T2): --also <id|basename> ─────────────────

test('edit-plan CLI: --also applies the same --find/--replace to a second plan in ONE commit', () => {
  const repo = makeIsolatedRepo();
  try {
    const secondRel = 'docs/superpowers/plans/ready/070-Infra-bar.md';
    const secondBody = [
      '---',
      'summary: Second test plan for edit-plan --also',
      '---',
      '',
      sw('> 🟩 **SEED-WRITE: no**'),
      '',
      '**Status:** 📋 READY — opened 2026-07-04.',
      '',
      '# 070-Infra-bar',
      '',
      'Body.',
      '',
    ].join('\n');
    writeFileSync(join(repo.dir, secondRel), secondBody);
    repo.g('add', secondRel);
    repo.g('commit', '-qm', 'seed second plan');
    repo.g('push', '-q', 'origin', 'master');

    const before = repo.g('rev-list', '--count', 'origin/master').trim();
    const res = runEditPlanEnv(
      repo.dir,
      ['060', '--find', 'Body.', '--replace', 'Body (edited).', '--also', '070'],
      repo.editPlan,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    const after = repo.g('rev-list', '--count', 'origin/master').trim();
    assert.equal(Number(after) - Number(before), 1, 'exactly one new commit for both plans');

    repo.g('fetch', '-q', 'origin', 'master');
    assert.match(repo.g('show', `origin/master:${repo.srcRel}`), /Body \(edited\)\./);
    assert.match(repo.g('show', `origin/master:${secondRel}`), /Body \(edited\)\./);
  } finally {
    repo.cleanup();
  }
});

test('edit-plan CLI: --body cannot be combined with --also', () => {
  const repo = makeIsolatedRepo();
  try {
    const bodyFile = join(repo.dir, '.scratch-body.md');
    writeFileSync(bodyFile, DEFAULT_EDIT_BODY);
    const before = repo.g('rev-parse', 'origin/master').trim();
    const res = runEditPlanEnv(
      repo.dir,
      ['060', '--body', bodyFile, '--base-sha', 'deadbeef', '--also', '070'],
      repo.editPlan,
    );
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /--body cannot be combined with --also/);
    assert.equal(repo.g('rev-parse', 'origin/master').trim(), before);
  } finally {
    repo.cleanup();
  }
});

// plan 3973 review fix (finding c8ff04): --also shares assertClaimedOverrideOk's exact
// hasOwnProperty-vs-`!= null` footgun. Pure unit test, mirroring the assertClaimedOverrideOk
// coverage right above it.
test('assertAlsoOk: absent flag is fine; bare/empty/flag-shaped refuse; a real id/basename passes', () => {
  assert.doesNotThrow(() => assertAlsoOk({}));
  assert.doesNotThrow(() => assertAlsoOk({ also: '070' }));
  // A bare trailing --also resolves to an explicit `undefined` VALUE with the key still
  // PRESENT (parseFlags) — distinct from the flag never being given at all. Before the
  // fix, main()'s `alsoIdOrName != null` check read this the same as "not given" and
  // silently edited only the primary plan.
  assert.throws(() => assertAlsoOk({ also: undefined }), /requires a non-empty/);
  assert.throws(() => assertAlsoOk({ also: '' }), /requires a non-empty/);
  assert.throws(() => assertAlsoOk({ also: '--dry' }), /looks like a flag, not a plan/);
});

// Seed the same second plan the existing --also happy-path test above uses, so the
// review-fix tests below can trigger a fault on plan 070 specifically (an invalid
// execModel, or a broken claim ref) while plan 060 stays a clean, unclaimed primary.
function seedSecondPlan(
  repo,
  { rel = 'docs/superpowers/plans/ready/070-Infra-bar.md', body } = {},
) {
  const secondBody =
    body ??
    [
      '---',
      'summary: Second test plan for edit-plan --also',
      '---',
      '',
      sw('> 🟩 **SEED-WRITE: no**'),
      '',
      '**Status:** 📋 READY — opened 2026-07-04.',
      '',
      '# 070-Infra-bar',
      '',
      'Body.',
      '',
    ].join('\n');
  writeFileSync(join(repo.dir, rel), secondBody);
  repo.g('add', rel);
  repo.g('commit', '-qm', 'seed second plan');
  repo.g('push', '-q', 'origin', 'master');
  return { rel, body: secondBody };
}

test('edit-plan CLI: a bare trailing --also refuses (exit 2) instead of silently editing only the primary plan (finding c8ff04)', () => {
  const repo = makeIsolatedRepo();
  try {
    seedSecondPlan(repo);
    const before = repo.g('rev-parse', 'origin/master').trim();
    const res = runEditPlanEnv(
      repo.dir,
      // --also is the LAST token — parseFlags resolves it to an explicit `undefined` value.
      ['060', '--find', 'Body.', '--replace', 'Body (edited).', '--also'],
      repo.editPlan,
    );
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /--also requires a non-empty/);
    assert.equal(
      repo.g('rev-parse', 'origin/master').trim(),
      before,
      'no coord lock entered — nothing committed, not even the primary plan',
    );
  } finally {
    repo.cleanup();
  }
});

test('edit-plan CLI: --also — a replacement writing an unrecognized execModel to the SECOND plan is refused, nothing pushed (findings 29d432/b1bedd/928ae6)', () => {
  const repo = makeIsolatedRepo();
  try {
    // The primary plan's own body carries the literal string "sonnet" only in ordinary
    // prose (never in frontmatter), so the primary's own execModel validation (which reads
    // its FRONTMATTER key, not prose) never trips — only the second plan's frontmatter
    // `execModel: sonnet` is turned into `execModel: bogus` by the shared find/replace.
    const primaryBody = DEFAULT_EDIT_BODY.replace('Body.', 'Body mentions sonnet in prose.');
    writeFileSync(join(repo.dir, repo.srcRel), primaryBody);
    repo.g('add', repo.srcRel);
    repo.g('commit', '-qm', 'primary plan mentions sonnet in prose');
    repo.g('push', '-q', 'origin', 'master');

    const secondBody = [
      '---',
      'summary: Second test plan for edit-plan --also',
      'execModel: sonnet',
      '---',
      '',
      sw('> 🟩 **SEED-WRITE: no**'),
      '',
      '**Status:** 📋 READY — opened 2026-07-04.',
      '',
      '# 070-Infra-bar',
      '',
      'Body.',
      '',
    ].join('\n');
    seedSecondPlan(repo, { body: secondBody });

    const before = repo.g('rev-parse', 'origin/master').trim();
    const res = runEditPlanEnv(
      repo.dir,
      ['060', '--find', 'sonnet', '--replace', 'bogus', '--all', '--also', '070'],
      repo.editPlan,
    );
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /refusing to write execModel: "bogus"/);
    assert.match(res.stderr, /070-Infra-bar\.md/);
    assert.equal(
      repo.g('rev-parse', 'origin/master').trim(),
      before,
      "the second plan's invalid execModel must never reach origin — no partial commit",
    );
  } finally {
    repo.cleanup();
  }
});

test('edit-plan CLI: --also — a claim-holder read failure WARNs naming the branch-shaped ref, never the retired refs/claims/<id> spelling (finding a369c3)', () => {
  const repo = makeIsolatedRepo();
  try {
    seedSecondPlan(repo);
    // Push a non-commit object (a blob) as plan 070's LEGACY claim ref tip: `ls-remote`
    // reports it present, `fetch` succeeds (the object exists), but `cat-file commit`
    // fails because it isn't a commit — readRemoteRefCommitWith's catch re-checks
    // ls-remote (still non-empty, so this isn't the "released mid-read" tolerance case)
    // and rethrows, exactly the "claim-holder read failed" path claimGuardMessage catches.
    const blobFile = join(repo.dir, '.scratch-not-a-commit.txt');
    writeFileSync(blobFile, 'not a commit\n');
    const blobSha = repo.g('hash-object', '-w', blobFile).trim();
    repo.g('push', '-q', 'origin', `${blobSha}:${legacyClaimRef('070')}`);

    const res = runEditPlanEnv(
      repo.dir,
      ['060', '--find', 'Body.', '--replace', 'Body (edited).', '--also', '070'],
      repo.editPlan,
    );
    // Fail-open: a transient/unreadable claim record WARNs and proceeds, same as every
    // other claim-guard read failure in this file.
    assert.equal(
      res.code,
      0,
      `expected exit 0 (fail-open)\nstdout:${res.stdout}\nstderr:${res.stderr}`,
    );
    assert.match(res.stderr, /WARN — claim-holder read failed for refs\/heads\/coord\/claims\/070/);
    assert.doesNotMatch(
      res.stderr,
      /claim-holder read failed for refs\/claims\/070/,
      'must never hand-build the retired refs/claims/<id> spelling',
    );
  } finally {
    repo.cleanup();
  }
});

// plan 3973 round-2 review fix (finding e5ce1e): the primary rename and --also's own rename
// are ONE transaction — if the second `git mv` throws (here: its destination already exists),
// the first `git mv` (already applied by the time the second one runs) must be REVERSED, not
// left stranded. `COORD_MAIN_DIR` is set to `repo.dir` itself so edit-plan operates directly
// on this checkout (withCoordCheckout's own documented short-circuit for done-worktree's
// detached finish worktree — see coord-git.mjs) instead of a disposable, hard-reset-every-call
// coord-checkout copy: that is exactly the "detached finish checkout" the finding names as the
// place nothing ever heals a stranded rename, so it is the environment that actually exercises
// the bug this fix closes.
test('edit-plan CLI: --also — a second-plan rename failure rolls back the primary rename too, no partial state (finding e5ce1e)', () => {
  const repo = makeIsolatedRepo({
    body: DEFAULT_EDIT_BODY.replace(
      '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\n---',
      '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\nexecModel: sonnet\n---',
    ),
  });
  try {
    const secondBody = [
      '---',
      'summary: Second test plan for edit-plan --also',
      'execModel: sonnet',
      '---',
      '',
      sw('> 🟩 **SEED-WRITE: no**'),
      '',
      '**Status:** 📋 READY — opened 2026-07-04.',
      '',
      '# 070-Infra-bar',
      '',
      'Body.',
      '',
    ].join('\n');
    seedSecondPlan(repo, { body: secondBody });

    // Pre-create the SECOND plan's rename DESTINATION so its `git mv` collides and throws.
    // The primary (060) renames first inside mutate() — this only needs to break --also's.
    const collisionRel = 'docs/superpowers/plans/ready/070-FABLE-Infra-bar.md';
    writeFileSync(join(repo.dir, collisionRel), 'collision placeholder\n');
    repo.g('add', collisionRel);
    repo.g('commit', '-qm', 'seed a colliding destination for the second rename');
    repo.g('push', '-q', 'origin', 'master');

    const before = repo.g('rev-parse', 'origin/master').trim();
    const res = runEditPlanEnv(
      repo.dir,
      [
        '060',
        '--find',
        'execModel: sonnet',
        '--replace',
        'execModel: fable',
        '--all',
        '--also',
        '070',
      ],
      repo.editPlan,
      { COORD_MAIN_DIR: repo.dir },
    );
    assert.notEqual(res.code, 0, `expected a refusal\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.equal(
      repo.g('rev-parse', 'origin/master').trim(),
      before,
      'no partial commit reached origin',
    );
    // The transactional fix: repo.dir (== cdir under COORD_MAIN_DIR) is left CLEAN — the
    // primary's git mv was reversed, not stranded at its new name with nothing to undo it.
    assert.equal(
      repo.g('status', '--porcelain').trim(),
      '',
      'the checkout is clean — the primary rename was rolled back, not left half-applied',
    );
    const tree = repo.g('ls-tree', '-r', '--name-only', 'HEAD');
    assert.match(
      tree,
      /ready\/060-Infra-foo\.md$/m,
      'primary plan is back at its ORIGINAL basename',
    );
    assert.doesNotMatch(
      tree,
      /060-FABLE-Infra-foo\.md/,
      'primary is NOT stranded at the new (renamed) basename',
    );
  } finally {
    repo.cleanup();
  }
});

// plan 3973 round-3 review fix (findings 615a49/afc5c1/a47216): unlike the e5ce1e test
// above (which breaks the SECOND git mv itself, i.e. before both renames succeed), this
// forces a throw AFTER both renames have already landed, immediately before the write
// mutate() would otherwise perform. Pre-fix, only assertBoardInvariants' own catch rolled
// anything back, so a failure here left BOTH plans stranded at their new (renamed)
// basenames with nothing committed. `COORD_MAIN_DIR` is set to `repo.dir` for the same
// reason as e5ce1e's test — that is the "detached finish checkout" shape where nothing
// else ever heals a stranded rename.
//
// Round-4 review fix (finding 2286b7): this used to force the failure with
// `chmodSync(primaryAbs, 0o444)` — ambient filesystem permission enforcement, which the
// repo rule requires be made a PARAMETER rather than assumed (0o444 does not reliably
// block a same-user write on every platform/filesystem). Replaced with edit-plan.mjs's
// `EDIT_PLAN_TEST_THROW=after-rename` injection point (mirrors done-worktree.mjs's
// DW_TEST_THROW convention) — deterministic on every platform, no chmod/EPERM involved.
test('edit-plan CLI: a write failure AFTER both renames succeed rolls both back, no partial state (findings 615a49/afc5c1/a47216)', () => {
  const repo = makeIsolatedRepo({
    body: DEFAULT_EDIT_BODY.replace(
      '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\n---',
      '---\nsummary: Test plan for edit-plan FABLE- auto-stamp\nexecModel: sonnet\n---',
    ),
  });
  try {
    const secondBody = [
      '---',
      'summary: Second test plan for edit-plan --also',
      'execModel: sonnet',
      '---',
      '',
      sw('> 🟩 **SEED-WRITE: no**'),
      '',
      '**Status:** 📋 READY — opened 2026-07-04.',
      '',
      '# 070-Infra-bar',
      '',
      'Body.',
      '',
    ].join('\n');
    seedSecondPlan(repo, { body: secondBody });

    const before = repo.g('rev-parse', 'origin/master').trim();
    const res = runEditPlanEnv(
      repo.dir,
      [
        '060',
        '--find',
        'execModel: sonnet',
        '--replace',
        'execModel: fable',
        '--all',
        '--also',
        '070',
      ],
      repo.editPlan,
      { COORD_MAIN_DIR: repo.dir, EDIT_PLAN_TEST_THROW: 'after-rename' },
    );
    assert.notEqual(res.code, 0, `expected a refusal\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.equal(
      repo.g('rev-parse', 'origin/master').trim(),
      before,
      'no partial commit reached origin',
    );
    assert.equal(
      repo.g('status', '--porcelain').trim(),
      '',
      'the checkout is clean — BOTH renames were rolled back, not left half-applied',
    );
    const tree = repo.g('ls-tree', '-r', '--name-only', 'HEAD');
    assert.match(tree, /ready\/060-Infra-foo\.md$/m, 'primary is back at its ORIGINAL basename');
    assert.match(
      tree,
      /ready\/070-Infra-bar\.md$/m,
      '--also plan is back at its ORIGINAL basename too',
    );
    assert.doesNotMatch(tree, /FABLE-Infra-foo\.md/, 'primary not stranded at the new basename');
    assert.doesNotMatch(
      tree,
      /FABLE-Infra-bar\.md/,
      '--also plan not stranded at the new basename',
    );
  } finally {
    repo.cleanup();
  }
});

// Round-4 review fix (finding de5c83): --find/--replace is idempotent against retry BY
// DESIGN — it silently no-ops for a plan whose find text is already gone, safe for a lone
// plan's own re-run. With --also, that same no-op used to apply per-plan independently: a
// sibling that removes the find text from ONLY the --also plan (a concurrent edit, not our
// own re-run) forced our push non-ff, and the retry then silently committed the primary's
// half of the edit while quietly skipping the --also plan's half. This test forces exactly
// that retry via installOneShotSiblingEditHook, and asserts the M4 fix refuses instead of
// half-applying.
test('edit-plan CLI: --also refuses on retry when a sibling removed --find from ONLY the secondary plan (finding de5c83)', () => {
  const repo = makeIsolatedRepo();
  try {
    const second = seedSecondPlan(repo);
    // Fires once OUR push reaches the pre-push hook: removes the SAME "Body." find text our
    // own edit targets, but only from the --also plan (070) — never from the primary (060).
    installOneShotSiblingEditHook(
      repo.dir,
      repo.origin,
      second.rel,
      'Body.',
      'Body (sibling-edited, no longer matches).',
    );

    assert.throws(
      () =>
        execFileSync(
          'node',
          [repo.editPlan, '060', '--find', 'Body.', '--replace', 'Body (edited).', '--also', '070'],
          { cwd: repo.dir, encoding: 'utf8' },
        ),
      (e) => {
        const out = `${e.stdout || ''}${e.stderr || ''}`;
        assert.match(out, /present in only one of the two plans/);
        return true;
      },
    );

    repo.g('fetch', '-q', 'origin', 'master');
    const primaryLanded = repo.g('show', `origin/master:${repo.srcRel}`);
    assert.match(
      primaryLanded,
      /^Body\.$/m,
      'primary plan UNCHANGED — our half of the multi-plan edit never landed on its own',
    );
    const alsoLanded = repo.g('show', `origin/master:${second.rel}`);
    assert.match(
      alsoLanded,
      /sibling-edited, no longer matches/,
      "the sibling's own edit to the --also plan is untouched",
    );
  } finally {
    repo.cleanup();
  }
});
