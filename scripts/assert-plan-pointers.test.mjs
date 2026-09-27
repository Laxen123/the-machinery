// scripts/assert-plan-pointers.test.mjs  (plan 3204)
//
// Name-pair for the new scripts/assert-plan-pointers.mjs module (the plan-2530 growth valve).
//
// The whole point of this lint is precision — it is a heuristic about English, permanently
// WARN-only, and it earns its place only by not crying wolf. So the bulk of this battery is
// NEGATIVE: the phrasings that must NOT fire. Each of them was a measured false positive on
// the first full-corpus run, not a hypothetical.
//
// `folders` (id -> the status folder holding that plan) is injected everywhere, so no test
// depends on the real plans tree — plans archive constantly, and a battery keyed to today's
// archive would rot within the week.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GRANDFATHER_FILE,
  PENDING_PATTERNS,
  extractPlanClaims,
  lintDocument,
  main,
  PLANS_DIR,
  planFolders,
  readGrandfather,
} from './assert-plan-pointers.mjs';

/** 2631 shipped; 3204 is still open in ready/; 9999 was never minted. */
const FOLDERS = new Map([
  ['2631', 'archive'],
  ['7', 'archive'],
  ['3204', 'ready'],
]);

const lint = (text, folders = FOLDERS) => lintDocument('docs/x.md', { text, folders }).findings;
const claimIds = (text) => extractPlanClaims(text).map((c) => `${c.pattern}:${c.id}`);

// ── the positive class: a still-coming claim about a plan that shipped ───────────

test('the five phrase families each flag an archived plan', () => {
  assert.equal(lint('Deferred until plan 2631 lands.').length, 1);
  assert.equal(lint('This is blocked on plan 2631.').length, 1);
  assert.equal(lint('Tracked as plan 2631.').length, 1);
  assert.equal(lint('plan 2631 is still open').length, 1);
  assert.equal(lint('Pending plan 2631.').length, 1);
});

test('a path naming a LIVE status folder for an archived plan is flagged', () => {
  const findings = lint('See `docs/superpowers/plans/ready/2631-Infra-x.md`.');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, 'open-folder');
});

test('the four id spellings the corpus uses are all read', () => {
  for (const form of ['plan 2631', 'plans 2631', 'plan **2631**', 'plan #2631']) {
    assert.equal(lint(`Tracked as ${form}.`).length, 1, form);
  }
});

test('a zero-padded plan file and a bare prose id are the same plan', () => {
  // The file is `007-P07-….md`; the prose says "plan 7".
  assert.equal(lint('Tracked as plan 7.').length, 1);
  assert.equal(lint('Tracked as plan 007.').length, 1);
});

test('the finding names the plan, the pattern and the phrase that triggered it', () => {
  const [f] = lint('Deferred until plan 2631 lands.');
  assert.equal(f.id, '2631');
  assert.equal(f.kind, 'landed-plan-pointer');
  assert.equal(f.pattern, 'until-lands');
  assert.match(f.message, /until plan 2631 lands/);
});

// ── the negative class: everything that must stay quiet ──────────────────────────

test('an OPEN plan is never a finding, however pending the phrasing', () => {
  assert.deepEqual(lint('Blocked on plan 3204 until plan 3204 lands.'), []);
});

test("an unknown id is never a finding — a typo is not this lint's class", () => {
  assert.deepEqual(lint('Tracked as plan 9999.'), []);
});

test('past tense is not a claim: `landed` never matches the land patterns', () => {
  assert.deepEqual(lint('Once plan 2631 landed, the gate went live.'), []);
  assert.deepEqual(lint('After plan 2631 had landed we removed the flag.'), []);
});

test("a possessive turns the land into a noun: `plan 2631's land` is history", () => {
  assert.deepEqual(lint("The flag went away after plan 2631's land."), []);
});

test('a parenthesised id is a citation, not the object of the verb', () => {
  assert.deepEqual(lint('Gated on GB seed depth (plan 2631).'), []);
  assert.deepEqual(lint('Deferred to "decide at enable time" (plan 2631).'), []);
  assert.deepEqual(lint('The rule shipped (plan 2631), but the class is open.'), []);
});

test('the `pending-approval/` FOLDER NAME is not the adjective "pending"', () => {
  assert.deepEqual(lint('A fresh mint rests in `pending-approval/` (plan 2631).'), []);
});

test('a match never spans a sentence boundary', () => {
  assert.deepEqual(lint('This is blocked. Separately, plan 2631 shipped the gate.'), []);
  assert.deepEqual(lint('This is blocked; plan 2631 shipped the gate.'), []);
});

test('an archive path for an archived plan is correct, and stays quiet', () => {
  assert.deepEqual(lint('See `docs/superpowers/plans/archive/2631-Infra-x.md`.'), []);
});

// ── waivers, shared with the dead-pointer lint ───────────────────────────────────

test('the inline waiver silences a line; the section waiver silences to the next heading', () => {
  assert.deepEqual(
    lint('Until plan 2631 lands <!-- doc-pointer-ok: quoting the 2026-07 text -->'),
    [],
  );
  const doc = [
    '<!-- doc-pointer-ok-section: the state as of 2026-07 -->',
    'Blocked on plan 2631.',
    '',
    '## Today',
    'Blocked on plan 2631.',
  ].join('\n');
  assert.deepEqual(
    lint(doc).map((f) => f.line),
    [5],
  );
});

// ── extraction mechanics ─────────────────────────────────────────────────────────

test('one claim per (line, id), whichever pattern spotted it first', () => {
  assert.deepEqual(claimIds('Blocked on plan 2631, tracked as plan 2631.'), ['blocked-on:2631']);
});

test('two different ids on one line are two claims', () => {
  const ids = extractPlanClaims('Tracked as plan 2631 and filed as plan 3204.').map((c) => c.id);
  assert.deepEqual(ids.sort(), ['2631', '3204']);
});

test('a /g pattern does not lose matches on later lines (lastIndex is reset per line)', () => {
  const doc = ['Tracked as plan 2631.', 'Tracked as plan 3204.', 'Tracked as plan 2631.'].join(
    '\n',
  );
  assert.deepEqual(
    extractPlanClaims(doc).map((c) => c.line),
    [1, 2, 3],
  );
});

test('every pattern captures the id in group 1, with no width to expire', () => {
  for (const { name, re } of PENDING_PATTERNS) {
    assert.equal(re.source.includes('(\\d+)'), true, name);
  }
  assert.equal(lint('Tracked as plan 2631.').length, 1);
});

test('a past auxiliary makes the phrase history, not a claim', () => {
  assert.deepEqual(lint('The rollout was blocked on plan 2631 before it landed.'), []);
  assert.deepEqual(lint('These were tracked as plan 2631.'), []);
  assert.deepEqual(lint('It had been deferred to plan 2631.'), []);
  // …but the present tense is exactly what the lint is for.
  assert.equal(lint('The rollout is blocked on plan 2631.').length, 1);
});

test('PRESENT perfect is still a live claim — only the past perfect is history', () => {
  // "has been blocked" means it is blocked right now; "had been blocked" means it no longer is.
  assert.equal(lint('The rollout has been blocked on plan 2631.').length, 1);
  assert.equal(lint('These have been tracked as plan 2631.').length, 1);
  assert.deepEqual(lint('The rollout had been blocked on plan 2631.'), []);
});

test('a bare past perfect and every counterfactual form are history too', () => {
  // Each phrasing uses a REAL trigger, so the lookbehind is what suppresses it — a sentence
  // built from a non-trigger verb would pass this test without exercising the guard at all.
  assert.deepEqual(lint('We had deferred to plan 2631.'), []);
  for (const modal of ['would', 'could', 'might', 'should']) {
    assert.deepEqual(lint(`It ${modal} be blocked on plan 2631.`), [], modal);
    assert.deepEqual(lint(`It ${modal} have deferred to plan 2631.`), [], modal);
    assert.deepEqual(lint(`It ${modal} have been blocked on plan 2631.`), [], modal);
  }
  // …and each of those sentences DOES fire once the counterfactual auxiliary is removed, which
  // is what proves the guard is the thing doing the suppressing.
  assert.equal(lint('It is blocked on plan 2631.').length, 1);
  assert.equal(lint('It deferred to plan 2631.').length, 1);
});

test('an assertive future is a live claim, not a hypothetical', () => {
  // "will be blocked on plan N" asserts a real dependency; if N has archived that IS the
  // finding, so `will` / `must` / `can` are deliberately not in MODALS.
  for (const modal of ['will', 'must', 'can', 'shall']) {
    assert.equal(lint(`It ${modal} be blocked on plan 2631.`).length, 1, modal);
  }
});

test('a CATEGORISED plan path states its status too', () => {
  // `move-plan` emits `parked/denmark/588-….md` (plan 2678); the dead-pointer sibling skips
  // every plans/ path, so if this regex misses the category form nothing catches it.
  const findings = lint('See `docs/superpowers/plans/parked/denmark/2631-Infra-x.md`.');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, 'open-folder');
});

test('an id of any width is read — the counter keeps counting', () => {
  assert.equal(lint('Tracked as plan 12345.', new Map([['12345', 'archive']])).length, 1);
  assert.equal(lint('Tracked as plan 1234567.', new Map([['1234567', 'archive']])).length, 1);
});

// ── plan-state resolution ────────────────────────────────────────────────────────

test('planFolders maps ids to their status folder, and a live folder beats archive', () => {
  const map = planFolders('/nowhere', () => [
    'docs/superpowers/plans/archive/007-P07-x.md',
    'docs/superpowers/plans/archive/2631-Infra-x.md',
    'docs/superpowers/plans/ready/3204-Infra-x.md',
    // Same id in two places (a bad state): the live folder wins, so no stale-claim finding.
    'docs/superpowers/plans/archive/3204-Infra-x.md',
    'docs/superpowers/plans/archive/P03b-no-numeric-id.md',
    // A CATEGORY subfolder: the status is still segment 0.
    'docs/superpowers/plans/parked/denmark/588-INTL-x.md',
    // LEGACY date-prefixed plans. A bare `^(\d+)-` reads `2026` out of these and files a
    // phantom archived plan 2026 — the class planIdOf's `(?=[A-Za-z])` lookahead closes.
    'docs/superpowers/plans/archive/2026-05-17-adaptive-bouncing-castle-uiux-session.md',
    'docs/superpowers/plans/archive/2026-05-23-record-category-4-tier-split.md',
    // …and the 86 archived plans whose TITLE starts with a date, which DO carry an id.
    'docs/superpowers/plans/archive/001-2026-05-21-fb-insta-ui-surface.md',
  ]);
  assert.equal(map.get('7'), 'archive');
  assert.equal(map.get('2631'), 'archive');
  assert.equal(map.get('3204'), 'ready');
  assert.equal(map.get('588'), 'parked');
  assert.equal(map.get('1'), 'archive');
  assert.equal(map.has('2026'), false);
  assert.equal(map.size, 5); // the id-less and date-only files contribute nothing
});

test('an id followed by a date is an id; a date alone is not', () => {
  // 86 archived plans are named `NNN-YYYY-MM-DD-title.md`. Dropping them (which a
  // letter-lookahead id parser does) makes every stale claim about them invisible; minting an
  // id for the four date-ONLY legacy names files a phantom archived plan 2026. This is the
  // exact discrimination `claimedIdOfBasename` was factored out for (plan 2082), which is why
  // planFolders reads it rather than a local regex — the case is asserted here against the
  // shapes this lint depends on.
  const idsOf = (names) =>
    [...planFolders('/nowhere', () => names.map((n) => `${PLANS_DIR}/archive/${n}`)).keys()].sort();
  assert.deepEqual(
    idsOf([
      '001-2026-05-21-fb-insta-ui-surface.md',
      '3204-2026-08-15-something.md',
      '007-P07-x.md',
      '1234567-Big-x.md',
    ]),
    ['1', '1234567', '3204', '7'],
  );
  assert.deepEqual(
    idsOf(['2026-05-17-adaptive-bouncing-castle-uiux-session.md', 'P03b-classifier-v4.md']),
    [],
  );
});

// ── grandfathering and main() ────────────────────────────────────────────────────

test('a grandfathered claim is counted, not reported; the same claim elsewhere reports', () => {
  const grandfather = new Set(['docs/known.md 2631']);
  const text = 'Tracked as plan 2631.';
  const known = lintDocument('docs/known.md', { text, folders: FOLDERS, grandfather });
  assert.deepEqual(known.findings, []);
  assert.equal(known.grandfathered, 1);
  assert.equal(
    lintDocument('docs/fresh.md', { text, folders: FOLDERS, grandfather }).findings.length,
    1,
  );
});

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'plan-pointers-'));
  const write = (rel, body) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  try {
    return run({ root, write });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('main WARNs and exits 0 by default, exits 1 under --check, and honours the grandfather file', () => {
  withFixture(({ root, write }) => {
    write('docs/runbooks/a.md', 'Tracked as plan 2631.\n');
    const opts = { root, files: ['docs/runbooks/a.md'], folders: FOLDERS };
    assert.equal(main([], opts), 0);
    assert.equal(main(['--check'], opts), 1);
    write(GRANDFATHER_FILE, '# header\ndocs/runbooks/a.md 2631\n');
    assert.equal(main(['--check'], opts), 0);
    assert.equal(main(['--check', '--no-grandfather'], opts), 1);
  });
});

test('named files are filtered to the corpus, so a caller may pass its whole changed list', () => {
  withFixture(({ root, write }) => {
    write('docs/runbooks/a.md', 'Tracked as plan 2631.\n');
    write('docs/handoff/sessions/2026-08-15-session-1.md', 'Tracked as plan 2631.\n');
    const opts = { root, folders: FOLDERS };
    assert.equal(main(['--check', 'docs/handoff/sessions/2026-08-15-session-1.md'], opts), 0);
    assert.equal(main(['--check', 'docs/runbooks/a.md'], opts), 1);
  });
});

test('readGrandfather normalises zero-padded ids', () => {
  withFixture(({ root, write }) => {
    write(GRANDFATHER_FILE, 'docs/a.md 007\n');
    assert.deepEqual([...readGrandfather(root)], ['docs/a.md 7']);
  });
});

test('an unknown flag is a caller bug (exit 2), never a silent clean pass', () => {
  assert.equal(main(['--nope'], { root: '/nowhere', files: [], folders: FOLDERS }), 2);
});
