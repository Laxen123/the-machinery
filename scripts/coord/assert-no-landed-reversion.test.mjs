// scripts/coord/assert-no-landed-reversion.test.mjs (plan 2274 Fix 2; rule reformulated by plan 2585)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  diffLineSets,
  authoringPlanId,
  attributeRemovals,
  parseNumstatZ,
  detectLandedReversion,
  mergedTreeOid,
  ownPlanIds,
  reversionPreflightReason,
  unsoundWarnBlock,
  parseAttributionLog,
  isGeneratedDataPath,
  buildGeneratedDataRx,
  LOG_RECORD_SEP,
  ATTRIBUTION_LOG_FORMAT,
  MIN_ATTRIBUTED_LINES,
  MAX_RENDERED_PLANS,
  MIN_SIGNIFICANT_LINE_LENGTH,
  // plan 3210 Part 2 — culprit-plan test discriminator
  culpritTestTargets,
  runCulpritTests,
  culpritTestEvidence,
  CULPRIT_TEST_TIMEOUT_MS,
  // plan 3210 Part 3 — --explain (the scope-pinned release apparatus was retired by plan 3832,
  // which demoted this lint from a halt to an advisory report; see assert-no-landed-reversion.mjs
  // header § DEMOTED TO ADVISORY)
  explainDroppedLines,
  // review fixes [4], [7]
  main,
  defaultCulpritTestRunner,
  // plan 3246 — class-2 whitespace normalization
  normalizeWhitespace,
  renamePathsFor,
  netRemovedLines,
} from './assert-no-landed-reversion.mjs';

// plan 3958: this module ships as-is into the public coord-kit, so a shipped core test must not
// pin THIS repo's real coord.config.json value (the kit's own config carries no seedShardDir/
// derivedShardDirs/etc. at all) — FIXTURE_CONFIG below is a fixed, portable fixture with neutral
// paths (never this repo's seed paths, which the seed-seam gate forbids as literals); the drift-protection intent the original live read had is
// now covered by the coord-config.mjs unit tests that pin these same keys directly). It still
// keeps the sample paths SEGMENT-WISE (`[dir, 'clinics', cc, file].join('/')`) instead of quoted
// whole-path literals, which is what `assert-seed-io-seam.mjs` asks of every file in `scripts/`
// — a hardcoded "…/seed/clinics/GB/clinic-NNN.json" string is a seam violation even in an
// assertion.
const FIXTURE_CONFIG = {
  seedShardDir: 'data/records',
  seedLaneFile: 'data/records-legacy.json',
  derivedShardDirs: ['data/derived/fingerprints', 'data/derived/store', 'data/derived/proposals'],
  derivedGlobalFiles: [
    'data/derived/observations/sweep.jsonl',
    'data/derived/observations/price.jsonl',
  ],
};
const FIXTURE_DATA_RX = buildGeneratedDataRx(FIXTURE_CONFIG);

// --- pure: diffLineSets / authoringPlanId / attributeRemovals -----------------

test('diffLineSets — added/removed content sets, keyed by the new-side path', () => {
  const diff = [
    'diff --git a/f.py b/f.py',
    'index abc..def 100644',
    '--- a/f.py',
    '+++ b/f.py',
    '@@ -5 +5 @@',
    '-old_line_content',
    '+new_line_content',
    '',
  ].join('\n');
  const sets = diffLineSets(diff);
  assert.deepEqual([...sets.keys()], ['f.py']);
  assert.deepEqual([...sets.get('f.py').removed], ['old_line_content']);
  assert.deepEqual([...sets.get('f.py').added], ['new_line_content']);
});

test('diffLineSets — trivially short lines are dropped from BOTH sides (coincidence floor)', () => {
  const diff = [
    'diff --git a/f.py b/f.py',
    '--- a/f.py',
    '+++ b/f.py',
    '@@ -1,4 +1,4 @@',
    '-}',
    '-)',
    '-',
    '-a_real_removed_line',
    '+}',
    '+a_real_added_line',
    '',
  ].join('\n');
  const sets = diffLineSets(diff);
  assert.deepEqual([...sets.get('f.py').removed], ['a_real_removed_line']);
  assert.deepEqual([...sets.get('f.py').added], ['a_real_added_line']);
});

test('diffLineSets — a rename keys on the NEW path; the `---`/`+++` headers are never content', () => {
  const diff = [
    'diff --git a/old.py b/new.py',
    'similarity index 90%',
    'rename from old.py',
    'rename to new.py',
    '--- a/old.py',
    '+++ b/new.py',
    '@@ -5 +5 @@',
    '-was_here',
    '+is_here',
    '',
  ].join('\n');
  const sets = diffLineSets(diff);
  assert.deepEqual([...sets.keys()], ['new.py']);
  assert.deepEqual([...sets.get('new.py').removed], ['was_here']);
});

test('diffLineSets — empty/garbage input yields an empty map (never throws)', () => {
  assert.equal(diffLineSets('').size, 0);
  assert.equal(diffLineSets(null).size, 0);
  assert.equal(diffLineSets('not a diff at all\n').size, 0);
});

test('authoringPlanId — every authorship form this repo actually uses (review F1)', () => {
  // All seven shapes are real subjects taken from this repo's own `git log`. The first cut
  // recognised only three of them, and a commit whose subject claims no id is skipped WHOLE from
  // the attribution walk — so each unrecognised shape was a class of revert the gate could never
  // clear the floor on.
  const cases = [
    ['2255: dedup Nordic-fold table', '2255'],
    ['feat(2261): secondary-phone axis — schema, helpers, akut CTA preference', '2261'],
    ["Merge branch 'worktree-2233-FABLE-DQ-places' into master", '2233'],
    ['fix(places): review-round fixes (plan 2205, /sonnet-review)', '2205'],
    ['feat(places): country-parameterize the stack (plan 2205)', '2205'],
    ['fix(test): address review findings on the plan-2575 env scrub', '2575'],
    [
      'de-freeze the gate surface — pre-push logic moves to scripts/hooks/pre-push.sh (2576)',
      '2576',
    ],
    ['fix(scripts): 2233 rebuild fix — restore master 4-plan additions', '2233'],
  ];
  for (const [subject, expected] of cases) {
    assert.equal(authoringPlanId(subject), expected, subject);
  }
});

test('authoringPlanId — a REFERENCED id never beats the authoring one, and never stands alone', () => {
  // 343467e2b7's real subject: the authoring plan is 2233 (the conventional-commit description
  // form); 2208/2221/2242 are what it reconciled AGAINST. Returning one of those would let a
  // reverting commit exempt its own victims simply by naming them.
  assert.equal(
    authoringPlanId(
      'data(seed): 2233 rebuild on fresh master — reconciles with plans 2208/2221/2242',
    ),
    '2233',
  );
  // no authorship claim at all ⇒ null, so the commit is skipped rather than mis-attributed
  assert.equal(authoringPlanId('chore: unrelated cleanup'), null);
  assert.equal(
    authoringPlanId('refactor(select-battery-tests): collapse hasNestedScriptChange'),
    null,
  );
  assert.equal(authoringPlanId('bump the socket timeout (600)'), null, 'a 3-digit bare paren');
  assert.equal(authoringPlanId(''), null);
  assert.equal(authoringPlanId(undefined), null);
});

test('authoringPlanId — the worktree- form is token-anchored and uncapped (review F6/F7)', () => {
  assert.equal(authoringPlanId("Merge branch 'worktree-123456-Foo'"), '123456', 'no 5-digit cap');
  assert.equal(authoringPlanId("Merge branch 'origin/worktree-2233-Foo'"), '2233', 'slash is fine');
  assert.equal(
    authoringPlanId('touched not-a-worktree-99 marker'),
    null,
    'too few digits to be an id, and not a real branch token',
  );
});

test('parseAttributionLog — one batched `git log -p` splits into per-commit added-line sets', () => {
  const rec = (sha, subject, patch) => `${LOG_RECORD_SEP}${sha}\x1f${subject}\n${patch}`;
  const out =
    rec(
      'aaa111',
      '2255: add the fold table',
      [
        '',
        'diff --git a/f.py b/f.py',
        '--- a/f.py',
        '+++ b/f.py',
        '@@ -1,0 +2 @@',
        '+added_by_2255',
      ].join('\n'),
    ) +
    rec('bbb222', 'chore: no plan id at all', '\ndiff --git a/f.py b/f.py\n+irrelevant_line\n') +
    rec(
      'ccc333',
      '2219: add the transliteration',
      [
        '',
        'diff --git a/f.py b/f.py',
        '--- a/f.py',
        '+++ b/f.py',
        '@@ -5,0 +6 @@',
        '+added_by_2219',
      ].join('\n'),
    );
  const history = parseAttributionLog(out);
  assert.deepEqual(
    history.map((h) => [h.sha, [...h.added]]),
    [
      ['aaa111', ['added_by_2255']],
      ['ccc333', ['added_by_2219']],
    ],
    'un-attributable commits are dropped here, not by the caller',
  );
  assert.deepEqual(parseAttributionLog(''), []);
  assert.deepEqual(parseAttributionLog(null), []);
});

test('the attribution --format arg carries the LITERAL %x00, never a raw NUL byte', () => {
  // Node's child_process throws ERR_INVALID_ARG_VALUE ("must be a string without null bytes") for
  // a real NUL in argv; git expands the four characters "%x00" itself. Getting this wrong makes
  // every attribution call throw, which fail-open then swallows into a silently empty finding
  // set — a gate that reports "clean" because it never ran. land-lib.mjs carries the same
  // warning; this pins it.
  assert.equal(ATTRIBUTION_LOG_FORMAT, '--format=%x00%H%x1f%s');
  assert.ok(!ATTRIBUTION_LOG_FORMAT.includes(LOG_RECORD_SEP), 'no raw NUL may reach argv');
  assert.equal(LOG_RECORD_SEP.charCodeAt(0), 0, 'the OUTPUT separator is still a real NUL');
});

test('attributeRemovals — only OTHER plans count; the branch removing its own lines is rework', () => {
  const removed = new Set(['alpha_line', 'beta_line', 'gamma_line']);
  const history = [
    { sha: 'aaa', subject: '2255: add alpha', added: new Set(['alpha_line']) },
    { sha: 'bbb', subject: '2219: add beta', added: new Set(['beta_line']) },
    { sha: 'ccc', subject: '2585: add gamma', added: new Set(['gamma_line']) },
    { sha: 'ddd', subject: 'chore: no plan id', added: new Set(['alpha_line', 'beta_line']) },
  ];
  const { attributed, plans } = attributeRemovals(removed, history, new Set(['2585']));
  assert.equal(attributed, 2, 'own plan 2585 and the un-attributable commit both excluded');
  assert.deepEqual(
    plans.map((p) => p.id),
    ['2255', '2219'],
  );
});

test('attributeRemovals — plans sort by lines desc; an empty history attributes nothing', () => {
  const removed = new Set(['l1', 'l2', 'l3']);
  const history = [
    { sha: 'aaa', subject: '100: one', added: new Set(['l1']) },
    { sha: 'bbb', subject: '200: two', added: new Set(['l2', 'l3']) },
  ];
  assert.deepEqual(
    attributeRemovals(removed, history).plans.map((p) => p.id),
    ['200', '100'],
  );
  assert.deepEqual(attributeRemovals(removed, []), { attributed: 0, plans: [] });
  assert.deepEqual(attributeRemovals(removed, null), { attributed: 0, plans: [] });
});

test('attributeRemovals — a line touched by several commits is counted ONCE, for the newest', () => {
  // Without per-line claiming, a hot file whose lines are re-touched by N commits inflates
  // `attributed` N-fold and can clear MIN_ATTRIBUTED_LINES on churn alone.
  const removed = new Set(['dup_line_one', 'dup_line_two']);
  const history = [
    { sha: 'new', subject: '300: newest re-adds both', added: new Set([...removed]) },
    { sha: 'mid', subject: '200: also added both', added: new Set([...removed]) },
    { sha: 'old', subject: '100: added both originally', added: new Set([...removed]) },
  ];
  const { attributed, plans } = attributeRemovals(removed, history);
  assert.equal(attributed, 2, 'two removed lines ⇒ at most two attributed, never six');
  assert.deepEqual(
    plans.map((p) => [p.id, p.lines]),
    [['300', 2]],
    'the newest commit that added a line owns it; the older two claim nothing',
  );
});

test('parseNumstatZ — renames pair correctly and binary rows are dropped', () => {
  // The real `git diff --numstat -M -z` shape: a binary row carries "-" counts, and a rename's
  // counts field ends with an EMPTY third column followed by the old and new paths as their own
  // NUL-terminated tokens.
  const rows = parseNumstatZ(
    ['-\t-\tbin.dat', '1\t1\t', 'old.py', 'new.py', '4\t40\tplain.py', ''].join('\0'),
  );
  assert.deepEqual(rows, [
    { added: 1, deleted: 1, path: 'new.py', oldPath: 'old.py' },
    { added: 4, deleted: 40, path: 'plain.py', oldPath: null },
  ]);
  assert.deepEqual(parseNumstatZ(''), []);
  assert.deepEqual(parseNumstatZ(null), []);
  assert.deepEqual(parseNumstatZ('garbage-with-no-tabs'), []);
});

// --- pure: the generated-data path-class exclusion --------------------------------------

test('plan 2585: generated whole-file-rewritten data trees are excluded, sourced from the mutex config', () => {
  // A seed shard is re-`json.dump`ed in full by every apply, so a legitimate re-apply always
  // removes lines another plan added — the plan-2585 prototype flagged clinic-2126.json (-46,
  // 29 attributed to plan 2205) for exactly that reason. Those trees are protected by the
  // plan-1300/1867 scoped landing mutex, not by this lint.
  assert.ok(FIXTURE_CONFIG.seedShardDir, 'the fixture declares a sharded seed root');
  const covered = [
    [FIXTURE_CONFIG.seedShardDir, 'clinics', 'GB', 'clinic-2126.json'].join('/'),
    [FIXTURE_CONFIG.seedShardDir, 'clinics', 'GB', 'order.json'].join('/'),
    ...(FIXTURE_CONFIG.seedLaneFile ? [FIXTURE_CONFIG.seedLaneFile] : []),
    ...FIXTURE_CONFIG.derivedShardDirs.map((d) => [d, 'clinic-1352.json'].join('/')),
    ...FIXTURE_CONFIG.derivedGlobalFiles,
  ];
  assert.ok(covered.length >= 5, 'the live config still declares every scope this test asserts');
  for (const path of covered) {
    assert.equal(isGeneratedDataPath(path, FIXTURE_DATA_RX), true, `${path} must classify as data`);
  }
  assert.equal(isGeneratedDataPath('scripts/foo.mjs', FIXTURE_DATA_RX), false);
  // a sibling of the shard root, not inside it — the `/` suffix on each dir alternative is what
  // keeps a prefix like "<seedShardDir>-notes.md" out of the exclusion
  assert.equal(
    isGeneratedDataPath(`${FIXTURE_CONFIG.seedShardDir}-notes.md`, FIXTURE_DATA_RX),
    false,
  );
  // a repo declaring none of the keys gets a regex that matches nothing (never throws)
  assert.equal(isGeneratedDataPath('anything/at/all.json', buildGeneratedDataRx({})), false);
  assert.equal(isGeneratedDataPath('anything/at/all.json', buildGeneratedDataRx(null)), false);
});

// --- fixture-repo integration tests -------------------------------------------

// The committer identity every fixture repo needs, whether it was `git init`ed here or cloned
// from one that was (a clone inherits no local config). ONE definition so the two fixture classes
// cannot drift apart on identity/signing requirements (review 1f5ae3).
function configureFixtureRepo(dir) {
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  return dir;
}

function initFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'reversion-fixture-'));
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'base']);
  return configureFixtureRepo(dir);
}

function commit(dir, message) {
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', message]);
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function checkout(dir, ...args) {
  execFileSync('git', ['-C', dir, 'checkout', '-q', ...args]);
}

// plan 2908 E6: a plain LOCAL-PATH `git clone --depth 1` silently ignores the depth — a `file://`
// URL is required to get a genuinely shallow (`.git/shallow`-bearing) clone, matching what a
// cloud drain container actually does.
function shallowClone(originDir, branch) {
  const dest = mkdtempSync(join(tmpdir(), 'reversion-shallow-'));
  execFileSync('git', [
    'clone',
    '-q',
    '--depth',
    '1',
    '--branch',
    branch,
    pathToFileURL(originDir).href,
    dest,
  ]);
  return configureFixtureRepo(dest);
}

const BODY = Array.from({ length: 20 }, (_, i) => `shared_body_line_${i + 1}`).join('\n') + '\n';
// A block big enough to clear MIN_ATTRIBUTED_LINES on its own — this is the "4 plans' worth of
// intervening work" that the _places_geo.py restore silently dropped.
const landedBlock = (plan) =>
  Array.from({ length: 40 }, (_, i) => `def plan_${plan}_helper_${i + 1}(): return ${i + 1}`).join(
    '\n',
  ) + '\n';

// ---------------------------------------------------------------------------
// ACCEPTANCE 1 — a freshened branch whose master churn touched non-coord files it never
// edited produces ZERO findings. This is the plan-2585 defect: the old rule reported this
// staleness as 60+ reverted hunks across 14 files.
// ---------------------------------------------------------------------------
test('acceptance 1 — freshened branch + later master churn on untouched files ⇒ ZERO findings', () => {
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'shared.py'), BODY);
    writeFileSync(join(dir, 'other.mjs'), BODY);
    const base = commit(dir, 'base');

    // master advances to T1 with a big landed block on shared.py
    execFileSync('git', ['-C', dir, 'branch', 'masterbr']);
    checkout(dir, 'masterbr');
    writeFileSync(join(dir, 'shared.py'), BODY + landedBlock(1111));
    const t1 = commit(dir, '1111: land a helper block on shared.py');

    // the branch cuts from base, does its own work, then FRESHENS by merging master@T1
    checkout(dir, base);
    checkout(dir, '-b', 'worktree-9001-Infra-demo');
    writeFileSync(join(dir, 'branch-only.txt'), 'plan work\n');
    commit(dir, '9001: branch-only work');
    execFileSync('git', ['-C', dir, 'merge', '-q', '--no-edit', t1]);

    // master then advances to T2, touching a non-coord file the branch never edits
    checkout(dir, 'masterbr');
    writeFileSync(join(dir, 'other.mjs'), BODY + landedBlock(2222));
    commit(dir, '2222: land a helper block on other.mjs — the branch never touches this file');

    const findings = detectLandedReversion(dir, {
      masterRef: 'masterbr',
      branchRef: 'worktree-9001-Infra-demo',
    });
    assert.deepEqual(
      findings,
      [],
      'master content the branch never absorbed is re-supplied by the merge — never a finding',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acceptance 1 (stale variant) — a branch that never freshened at all still produces ZERO findings', () => {
  // The resume paths (resumedPast REBASE_CONFLICT / LAND_BLOCKED_HOLDING) keep masterRef on
  // LIVE origin/master with a genuinely old merge-base — the exact configuration that produced
  // the 2026-07-27 batch-train false positive. Structural immunity must cover it too.
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'shared.py'), BODY);
    const base = commit(dir, 'base');

    execFileSync('git', ['-C', dir, 'branch', 'masterbr']);
    checkout(dir, 'masterbr');
    writeFileSync(join(dir, 'shared.py'), BODY + landedBlock(1111));
    commit(dir, '1111: land a helper block the branch never sees');

    checkout(dir, base);
    checkout(dir, '-b', 'worktree-9002-Infra-demo');
    writeFileSync(join(dir, 'branch-only.txt'), 'plan work\n');
    commit(dir, '9002: branch-only work, never rebased');

    assert.deepEqual(
      detectLandedReversion(dir, {
        base,
        masterRef: 'masterbr',
        branchRef: 'worktree-9002-Infra-demo',
      }),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 2 — the _places_geo.py shape, reconstructed per the plan-2585 question-1 finding:
// the branch is REBUILT ON FRESH MASTER (its parent IS the master tip, so the old rule's
// base->master diff was empty and it flagged nothing) and its single commit restores a stale
// whole-file copy, dropping the blocks four other plans landed.
// ---------------------------------------------------------------------------
test('acceptance 2 — whole-file restore on a branch rebuilt ON master ⇒ FLAGGED, culprits named', () => {
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'shared.py'), BODY);
    const base = commit(dir, 'base');
    // the branch's own pre-fork copy: the base body plus this plan's own edit, and NONE of the
    // four blocks that land on master next.
    const staleCopy = BODY + landedBlock(9003).replace(/plan_9003/g, 'plan_9003_own');

    checkout(dir, '-b', 'masterbr');
    let content = BODY;
    for (const id of [2249, 2255, 2219, 2254]) {
      content += landedBlock(id);
      writeFileSync(join(dir, 'shared.py'), content);
      commit(dir, `${id}: land plan ${id}'s helper block on shared.py`);
    }
    const masterTip = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    // THE INCIDENT SHAPE: rebuilt on fresh master, one commit, whole-file stale restore.
    checkout(dir, '-b', 'worktree-9003-DQ-rebuild', masterTip);
    writeFileSync(join(dir, 'shared.py'), staleCopy);
    commit(dir, 'data(seed): 9003 rebuild on fresh master — reconciles with plans 2208/2221');

    const findings = detectLandedReversion(dir, {
      masterRef: masterTip,
      branchRef: 'worktree-9003-DQ-rebuild',
    });
    assert.equal(findings.length, 1, 'the whole-file restore must be caught');
    const [f] = findings;
    assert.equal(f.path, 'shared.py');
    assert.ok(
      f.attributed >= MIN_ATTRIBUTED_LINES,
      `attributed ${f.attributed} must clear the floor`,
    );
    assert.deepEqual(
      f.plans.map((p) => p.id).sort(),
      ['2219', '2249', '2254', '2255'],
      'all four victim plans are named from content alone',
    );

    const reason = reversionPreflightReason(findings);
    assert.match(reason, /landed-work-reversion lint/);
    assert.match(reason, /shared\.py/);
    assert.match(reason, /plan 2249/);
    // plan 2917 AC2: the message must name each attributed plan's COMMIT, not just its id —
    // that is what makes an ALLOW_LANDED_REVERSION=1 override auditable, since the operator can
    // read the very commits whose lines the land drops. Four culprits, under the render cap.
    assert.ok(f.plans.length <= MAX_RENDERED_PLANS, 'sanity: this fixture is under the cap');
    for (const p of f.plans) {
      assert.ok(
        reason.includes(String(p.sha).slice(0, 9)),
        `the message names plan ${p.id}'s short sha`,
      );
      assert.ok(reason.includes(p.subject), `the message names plan ${p.id}'s commit subject`);
    }
    assert.doesNotMatch(reason, /not shown/, 'nothing is omitted below the cap');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PLAN 3210 PART 1 — REGRESSION PINS for the disproven content-based stale-copy detector (see
// the module's own RULED OUT block, 2026-08-16). These three formulations are LOCAL to this
// test file and deliberately NOT exported from the module — each one mis-verdicts at least one
// of the two controls below, which is exactly what disqualifies it as a working detector. The
// point: a future attempt to ship any of these as the real thing reds one of these assertions
// immediately, rather than only being caught in review.
// ---------------------------------------------------------------------------

function tokenizeForSimilarity(line) {
  return new Set(
    String(line)
      .split(/[^a-zA-Z0-9_]+/)
      .filter(Boolean),
  );
}
function jaccardSimilarity(a, b) {
  const ta = tokenizeForSimilarity(a);
  const tb = tokenizeForSimilarity(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// Formulation 1 (RULED OUT header table row 1): are the ADDED lines ones master itself once
// wrote and later deleted ("resurrected"), or are they novel?
function resurrectionVerdict(addedLines, everDeletedByMaster) {
  let resurrected = 0;
  for (const l of addedLines) if (everDeletedByMaster.has(l)) resurrected++;
  const novel = addedLines.size - resurrected;
  return { resurrected, novel, verdict: resurrected > novel ? 'BLOCK' : 'EXEMPT' };
}

// Formulation 2: is the branch's resulting file content closer to an OLDER master revision than
// to CURRENT master? (symmetric line-set difference as the distance metric)
function nearestRevisionVerdict(branchContent, olderContent, currentContent) {
  const lineSetOf = (c) =>
    new Set(
      String(c)
        .split('\n')
        .filter((l) => l.trim().length >= MIN_SIGNIFICANT_LINE_LENGTH),
    );
  const dist = (a, b) => {
    let d = 0;
    for (const l of a) if (!b.has(l)) d++;
    for (const l of b) if (!a.has(l)) d++;
    return d;
  };
  const branchSet = lineSetOf(branchContent);
  const dOlder = dist(branchSet, lineSetOf(olderContent));
  const dCurrent = dist(branchSet, lineSetOf(currentContent));
  return { dOlder, dCurrent, verdict: dOlder < dCurrent ? 'BLOCK' : 'EXEMPT' };
}

// Formulation 3: does each DROPPED (removed) line have a lookalike among the ADDED lines?
function successorSimilarityVerdict(removedLines, addedLines) {
  const added = [...addedLines];
  let matched = 0;
  for (const r of removedLines) if (added.some((a) => jaccardSimilarity(r, a) >= 0.5)) matched++;
  const total = removedLines.size;
  return { matched, total, verdict: total && matched / total >= 0.5 ? 'EXEMPT' : 'BLOCK' };
}

// Every line master's OWN history ever removed for `path`, up to `masterTip` — the corpus
// `resurrectionVerdict` checks the branch's additions against.
function everDeletedByMasterHistory(dir, masterTip, path) {
  const log = execFileSync(
    'git',
    ['-C', dir, 'log', '--no-ext-diff', '-p', '-U0', '-M', masterTip, '--', path],
    { encoding: 'utf8' },
  );
  const deleted = new Set();
  for (const ln of log.split('\n')) {
    if (ln.startsWith('-') && !ln.startsWith('---')) {
      const body = ln.slice(1).trim();
      if (body.length >= MIN_SIGNIFICANT_LINE_LENGTH) deleted.add(body);
    }
  }
  return deleted;
}

test('regression pin (plan 3210 Part 1): the disproven content-based detectors mis-verdict the real controls — do not resurrect them', () => {
  // --- control A: the acceptance-2 incident shape (whole-file stale restore) — must BLOCK ---
  const incidentDir = initFixtureRepo();
  try {
    writeFileSync(join(incidentDir, 'shared.py'), BODY);
    commit(incidentDir, 'base');
    const staleCopy = BODY + landedBlock(9210).replace(/plan_9210/g, 'plan_9210_own');

    checkout(incidentDir, '-b', 'masterbr');
    let masterContent = BODY;
    for (const id of [2249, 2255, 2219, 2254]) {
      masterContent += landedBlock(id);
      writeFileSync(join(incidentDir, 'shared.py'), masterContent);
      commit(incidentDir, `${id}: land plan ${id}'s helper block on shared.py`);
    }
    const masterTip = execFileSync('git', ['-C', incidentDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    checkout(incidentDir, '-b', 'worktree-9210-DQ-rebuild', masterTip);
    writeFileSync(join(incidentDir, 'shared.py'), staleCopy);
    commit(incidentDir, 'data(seed): 9210 rebuild on fresh master — stale restore');

    const diff = execFileSync(
      'git',
      [
        '-C',
        incidentDir,
        'diff',
        '--no-ext-diff',
        '-U0',
        '-M',
        masterTip,
        'worktree-9210-DQ-rebuild',
        '--',
        'shared.py',
      ],
      { encoding: 'utf8' },
    );
    const sets = diffLineSets(diff).get('shared.py');
    const everDeleted = everDeletedByMasterHistory(incidentDir, masterTip, 'shared.py');

    // detectLandedReversion itself must still BLOCK this (already pinned by acceptance 2 above;
    // re-asserted here so this test's own ground truth is self-evident, not borrowed).
    const realFindings = detectLandedReversion(incidentDir, {
      masterRef: masterTip,
      branchRef: 'worktree-9210-DQ-rebuild',
    });
    assert.equal(realFindings.length, 1, 'sanity: the real gate blocks this incident');

    const resurrection = resurrectionVerdict(sets.added, everDeleted);
    assert.equal(
      resurrection.verdict,
      'EXEMPT',
      'resurrection reads the branch-own block as novel content',
    );
    assert.notEqual(
      resurrection.verdict,
      'BLOCK',
      'the incident MUST block — resurrection misses it',
    );

    const nearest = nearestRevisionVerdict(staleCopy, BODY, masterContent);
    assert.equal(nearest.verdict, 'BLOCK', 'nearest-revision happens to get the incident right');

    const successor = successorSimilarityVerdict(sets.removed, sets.added);
    assert.equal(
      successor.verdict,
      'EXEMPT',
      'successor-similarity reads the templated boilerplate as a rewrite',
    );
    assert.notEqual(
      successor.verdict,
      'BLOCK',
      'the incident MUST block — successor-similarity misses it too',
    );
  } finally {
    rmSync(incidentDir, { recursive: true, force: true });
  }

  // --- control B: an in-place REWRITE of the same landed blocks — must EXEMPT ---
  const rewriteDir = initFixtureRepo();
  try {
    writeFileSync(join(rewriteDir, 'shared.py'), BODY);
    commit(rewriteDir, 'base');

    checkout(rewriteDir, '-b', 'masterbr');
    let masterContent = BODY;
    for (const id of [2249, 2255, 2219, 2254]) {
      masterContent += landedBlock(id);
      writeFileSync(join(rewriteDir, 'shared.py'), masterContent);
      commit(rewriteDir, `${id}: land plan ${id}'s helper block on shared.py`);
    }
    const masterTip = execFileSync('git', ['-C', rewriteDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    checkout(rewriteDir, '-b', 'worktree-9211-Infra-rewrite', masterTip);
    // an IN-PLACE REWRITE: the four landed blocks are replaced by 190 lines of genuinely new,
    // differently-worded code — the plan-3182 shape (substantial novel replacement, not a
    // restore), deliberately sharing NO vocabulary with the `def plan_<id>_helper_<i>(): return
    // <i>` template so the successor-similarity formulation cannot coincidentally match on it.
    const rewritten =
      BODY +
      Array.from({ length: 190 }, (_, i) => `class RewrittenWidget${i + 1}: pass`).join('\n') +
      '\n';
    writeFileSync(join(rewriteDir, 'shared.py'), rewritten);
    commit(rewriteDir, '9211: rewrite the four landed helper blocks with new implementation');

    const diff = execFileSync(
      'git',
      [
        '-C',
        rewriteDir,
        'diff',
        '--no-ext-diff',
        '-U0',
        '-M',
        masterTip,
        'worktree-9211-Infra-rewrite',
        '--',
        'shared.py',
      ],
      { encoding: 'utf8' },
    );
    const sets = diffLineSets(diff).get('shared.py');
    const everDeleted = everDeletedByMasterHistory(rewriteDir, masterTip, 'shared.py');

    // Sanity: the real gate (Part 1's whole motivation) DOES flag a legitimate rewrite too —
    // that is exactly the plan-3182 halt this plan exists to give better evidence for, not to
    // silence outright.
    const realFindings = detectLandedReversion(rewriteDir, {
      masterRef: masterTip,
      branchRef: 'worktree-9211-Infra-rewrite',
    });
    assert.equal(realFindings.length, 1, 'sanity: the real gate also halts a legitimate rewrite');

    const resurrection = resurrectionVerdict(sets.added, everDeleted);
    assert.equal(
      resurrection.verdict,
      'EXEMPT',
      'resurrection happens to get the rewrite right — but it already missed the incident above, so it is still not a working detector',
    );

    const nearest = nearestRevisionVerdict(rewritten, BODY, masterContent);
    assert.equal(nearest.verdict, 'BLOCK', 'nearest-revision HALTS the legitimate rewrite');
    assert.notEqual(
      nearest.verdict,
      'EXEMPT',
      'the rewrite MUST be exempted — nearest-revision gets this one wrong',
    );

    const successor = successorSimilarityVerdict(sets.removed, sets.added);
    assert.equal(
      successor.verdict,
      'BLOCK',
      'successor-similarity reads zero lookalikes as a restore',
    );
    assert.notEqual(
      successor.verdict,
      'EXEMPT',
      'the rewrite MUST be exempted — successor-similarity gets this one wrong too',
    );
  } finally {
    rmSync(rewriteDir, { recursive: true, force: true });
  }
});

test('the branch removing its OWN earlier lines is rework, not reversion ⇒ not flagged', () => {
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'shared.py'), BODY);
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'shared.py'), BODY + landedBlock(9004));
    const masterTip = commit(dir, '9004: land this plan OWN earlier block');

    checkout(dir, '-b', 'worktree-9004-Infra-demo', masterTip);
    writeFileSync(join(dir, 'shared.py'), BODY);
    commit(dir, '9004: drop the block this same plan added');

    assert.deepEqual(
      detectLandedReversion(dir, {
        masterRef: masterTip,
        branchRef: 'worktree-9004-Infra-demo',
      }),
      [],
      'a plan removing its own landed lines is ordinary rework',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a restore that also RENAMES the file is still caught (master knows it by the OLD name)', () => {
  // The rename is the BRANCH's doing, so masterRef still has the file under its old name: the
  // per-file diff needs both sides of the pathspec, and the attribution history must be walked
  // under master's name. The body is deliberately long enough that dropping the block leaves
  // git's similarity index above the rename-detection threshold — below it (the short-body
  // case) git reports a plain delete+add instead, which the same code reports under the deleted
  // path and is equally caught.
  const dir = initFixtureRepo();
  try {
    const longBody =
      Array.from({ length: 200 }, (_, i) => `stable_body_line_${i + 1}`).join('\n') + '\n';
    writeFileSync(join(dir, 'shared.py'), longBody);
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'shared.py'), longBody + landedBlock(3131));
    const masterTip = commit(dir, "3131: land plan 3131's block on shared.py");

    checkout(dir, '-b', 'worktree-9010-Infra-demo', masterTip);
    execFileSync('git', ['-C', dir, 'mv', 'shared.py', 'renamed.py']);
    writeFileSync(join(dir, 'renamed.py'), longBody); // …and drops 3131's block in the same move
    commit(dir, '9010: rename the module, restoring a stale copy');

    const findings = detectLandedReversion(dir, {
      masterRef: masterTip,
      branchRef: 'worktree-9010-Infra-demo',
    });
    assert.equal(findings.length, 1, 'the rename must not hide the removal');
    assert.equal(findings[0].path, 'renamed.py', 'reported under the new name git paired it to');
    assert.deepEqual(
      findings[0].plans.map((p) => p.id),
      ['3131'],
      "attribution walked masterRef's own name for the file",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rename too lossy for git to pair is reported under the DELETED path, still attributed', () => {
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'shared.py'), BODY);
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'shared.py'), BODY + landedBlock(3132));
    const masterTip = commit(dir, "3132: land plan 3132's block on shared.py");

    checkout(dir, '-b', 'worktree-9011-Infra-demo', masterTip);
    execFileSync('git', ['-C', dir, 'mv', 'shared.py', 'renamed.py']);
    writeFileSync(join(dir, 'renamed.py'), BODY);
    commit(dir, '9011: rename + stale restore, past the similarity threshold');

    const findings = detectLandedReversion(dir, {
      masterRef: masterTip,
      branchRef: 'worktree-9011-Infra-demo',
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].path, 'shared.py', 'git saw a delete, so the old path is reported');
    assert.deepEqual(
      findings[0].plans.map((p) => p.id),
      ['3132'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a removal below the attribution floor is not a finding (an ordinary small edit)', () => {
  const dir = initFixtureRepo();
  try {
    const long = Array.from({ length: 60 }, (_, i) => `body_line_${i + 1}`).join('\n') + '\n';
    writeFileSync(join(dir, 'shared.py'), long);
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    const withSmall =
      long + Array.from({ length: 6 }, (_, i) => `small_added_line_${i + 1}`).join('\n') + '\n';
    writeFileSync(join(dir, 'shared.py'), withSmall);
    const masterTip = commit(dir, '7777: land a six-line block');

    checkout(dir, '-b', 'worktree-9005-Infra-demo', masterTip);
    writeFileSync(join(dir, 'shared.py'), long);
    commit(dir, '9005: remove the six-line block');

    assert.deepEqual(
      detectLandedReversion(dir, { masterRef: masterTip, branchRef: 'worktree-9005-Infra-demo' }),
      [],
      `fewer than ${MIN_ATTRIBUTED_LINES} attributed lines stays below the floor`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a generated data path is excluded end-to-end via the fixture repo's OWN coord.config.json", () => {
  const dir = initFixtureRepo();
  try {
    writeFileSync(
      join(dir, 'coord.config.json'),
      JSON.stringify({ handoffDir: 'docs/handoff', seedShardDir: 'seed' }),
    );
    mkdirSync(join(dir, 'seed'), { recursive: true });
    writeFileSync(join(dir, 'seed', 'clinic-1.json'), BODY);
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'seed', 'clinic-1.json'), BODY + landedBlock(6666));
    const masterTip = commit(dir, '6666: pipeline re-applies the shard');

    checkout(dir, '-b', 'worktree-9006-DQ-demo', masterTip);
    writeFileSync(join(dir, 'seed', 'clinic-1.json'), BODY);
    commit(dir, '9006: this plan re-applies the shard whole-file, dropping 6666 lines');

    assert.deepEqual(
      detectLandedReversion(dir, { masterRef: masterTip, branchRef: 'worktree-9006-DQ-demo' }),
      [],
      'the sharded seed is protected by the scoped landing mutex, not by this lint',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review F2: a coord path the branch DOES rewrite is now CAUGHT, not excluded by class', () => {
  // Plan 2274 excluded coord paths outright because its STALENESS axis fired on every routine
  // master-side coord commit. Under the merge-drop axis that motivation is gone: a path the
  // branch never touched resolves to master in the merge and is never a candidate at all, so the
  // only thing a coord exclusion could still suppress is the ABNORMAL case — a branch that
  // bypassed the coordination guard (BOARD_GUARD_OVERRIDE / --no-verify) and rewrote a coord doc
  // wholesale, dropping another plan's landed lines. That is precisely what this lint is for, so
  // the exclusion was removed and only the generated-data one remains.
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'coord.config.json'), JSON.stringify({ handoffDir: 'docs/handoff' }));
    mkdirSync(join(dir, 'docs', 'handoff'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'handoff', 'board.md'), BODY);
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'docs', 'handoff', 'board.md'), BODY + landedBlock(5555));
    const masterTip = commit(dir, '5555: board rows land');

    checkout(dir, '-b', 'worktree-9007-Coord-demo', masterTip);
    writeFileSync(join(dir, 'docs', 'handoff', 'board.md'), BODY);
    commit(dir, '9007: rewrite the board wholesale, past the coordination guard');

    const findings = detectLandedReversion(dir, {
      masterRef: masterTip,
      branchRef: 'worktree-9007-Coord-demo',
    });
    assert.equal(findings.length, 1, 'a bypassed coord rewrite that drops landed lines is caught');
    assert.equal(findings[0].path, 'docs/handoff/board.md');
    assert.deepEqual(
      findings[0].plans.map((p) => p.id),
      ['5555'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PLAN 2908 T1 — a SHALLOW clone must not emit a confident, plan-named accusation. Reconstructs
// the plan-2585 incident shape (acceptance 2 above) but the branch does its whole-file stale
// restore INSIDE a genuinely shallow (`file://`, --depth 1) clone of that same history, mirroring
// a cloud drain container. Without the T1 downgrade, `git log` on the shallow clone collapses to
// the graft boundary commit — which appears to have ADDED every line in the repo — and the
// attribution walk would confidently (and wrongly) name whichever plan that boundary commit's
// subject happens to claim.
// ---------------------------------------------------------------------------
test('plan 2908 T1 — a shallow clone downgrades a real reversion to unsound, no plan ids named', () => {
  const origin = initFixtureRepo();
  try {
    writeFileSync(join(origin, 'shared.py'), BODY);
    commit(origin, 'base');
    checkout(origin, '-b', 'masterbr');
    let content = BODY;
    for (const id of [4249, 4255, 4219, 4254]) {
      content += landedBlock(id);
      writeFileSync(join(origin, 'shared.py'), content);
      commit(origin, `${id}: land plan ${id}'s helper block on shared.py`);
    }

    const shallow = shallowClone(origin, 'masterbr');
    try {
      assert.equal(
        execFileSync('git', ['-C', shallow, 'rev-parse', '--is-shallow-repository'], {
          encoding: 'utf8',
        }).trim(),
        'true',
        'sanity: the fixture clone really is shallow',
      );
      // the graft boundary hides plans 4249/4255/4219/4254 — `git log -- shared.py` in the
      // shallow clone sees only the ONE boundary commit, which looks like it added everything.
      checkout(shallow, '-b', 'worktree-9020-DQ-rebuild');
      writeFileSync(join(shallow, 'shared.py'), BODY); // whole-file stale restore, same as AC2
      commit(shallow, '9020: rebuild on fresh (shallow) master — stale restore');

      const findings = detectLandedReversion(shallow, {
        masterRef: 'masterbr',
        branchRef: 'worktree-9020-DQ-rebuild',
      });
      assert.equal(findings.length, 1, 'the removal is still detected as a candidate');
      const [f] = findings;
      assert.equal(f.path, 'shared.py');
      assert.equal(f.unsound, 'shallow-history', 'downgraded, not a confident accusation');
      assert.ok(f.removedLines >= MIN_ATTRIBUTED_LINES, 'the removed-line count is still reported');
      assert.equal(f.plans, undefined, 'no plan ids are named off a graft boundary');
      assert.equal(f.attributed, undefined, 'no attributed count either — the walk never ran');

      // reversionPreflightReason must still render this shape without throwing (done-worktree's
      // caller does NOT route unsound findings through it — see done-worktree.mjs's own WARN
      // block — but the renderer must stay defensive regardless).
      const reason = reversionPreflightReason(findings);
      assert.match(reason, /shared\.py/);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  } finally {
    rmSync(origin, { recursive: true, force: true });
  }
});

test('plan 2908 T1 — a shallow clone with NO reversion still returns clean (unsound never manufactures a finding)', () => {
  const origin = initFixtureRepo();
  try {
    writeFileSync(join(origin, 'f.py'), BODY);
    commit(origin, 'base');
    checkout(origin, '-b', 'masterbr');
    writeFileSync(join(origin, 'f.py'), BODY + landedBlock(4260));
    commit(origin, '4260: land a helper block');

    const shallow = shallowClone(origin, 'masterbr');
    try {
      checkout(shallow, '-b', 'worktree-9021-Infra-demo');
      writeFileSync(join(shallow, 'branch-only.txt'), 'plan work\n');
      commit(shallow, '9021: branch-only work, never touches f.py');

      assert.deepEqual(
        detectLandedReversion(shallow, {
          masterRef: 'masterbr',
          branchRef: 'worktree-9021-Infra-demo',
        }),
        [],
        'nothing removed ⇒ no candidate, shallow or not',
      );
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  } finally {
    rmSync(origin, { recursive: true, force: true });
  }
});

// plan 2908 (review 28e99e/db9384): the removed-line count is the ONLY actionable number an
// unsound finding carries, so neither renderer may drop it — and the WARN must not promise a
// clean verdict after unshallowing, only a sound attribution.
test('plan 2908 — unsound findings keep their removed-line count in both renderers', () => {
  const unsound = [{ path: 'a/b.py', removedLines: 56, unsound: 'shallow-history' }];

  const reason = reversionPreflightReason(unsound);
  assert.match(reason, /a\/b\.py/);
  assert.match(reason, /56 lines/, 'the count survives into the shared reason renderer');
  assert.match(reason, /attribution unsound: shallow-history/);

  const warn = unsoundWarnBlock(unsound);
  assert.match(warn, /a\/b\.py/);
  assert.match(warn, /56 lines removed/);
  assert.match(warn, /Nothing here blocks the land/, 'the WARN says plainly that it is not a halt');
  assert.match(warn, /--unshallow/, 'the remedy is still named');
  assert.doesNotMatch(
    warn,
    /real verdict/,
    'unshallowing buys a SOUND attribution, not a guaranteed-clean verdict (defect class 2 lives on)',
  );
});

// --- fail-open contract -------------------------------------------------------

test('fail-open — an unresolvable ref yields [] and never throws', () => {
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'f.py'), 'x\n');
    commit(dir, 'init');
    assert.deepEqual(detectLandedReversion(dir, { masterRef: 'origin/nonexistent-ref-xyz' }), []);
    assert.equal(mergedTreeOid(dir, 'origin/nope', 'HEAD'), null);
    assert.equal(mergedTreeOid(dir, 'origin/nope', 'HEAD', { base: 'origin/nope-either' }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fail-open — a merge-tree CONFLICT is not this lint's business (the spine seams it)", () => {
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'f.py'), BODY);
    const base = commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'f.py'), BODY.replace('shared_body_line_5', 'MASTER_SIDE_EDIT'));
    commit(dir, '4444: master edits line 5');
    checkout(dir, base);
    checkout(dir, '-b', 'worktree-9008-Infra-demo');
    writeFileSync(join(dir, 'f.py'), BODY.replace('shared_body_line_5', 'BRANCH_SIDE_EDIT'));
    commit(dir, '9008: branch edits the same line differently');

    assert.equal(mergedTreeOid(dir, 'masterbr', 'worktree-9008-Infra-demo'), null);
    assert.deepEqual(
      detectLandedReversion(dir, { masterRef: 'masterbr', branchRef: 'worktree-9008-Infra-demo' }),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 2917 T3′/AC2: a whole-file restore of a hot file can attribute across far more plans than
// the incident's four, and an unbounded culprit list buries the actionable head of it. `plans[]`
// arrives sorted by attributed lines desc, so the cap keeps the biggest contributors and counts
// the tail. Pure over the finding shape — the cap is a RENDER bound, so it needs no repo.
test('plan 2917 — the message caps the named plans at MAX_RENDERED_PLANS and counts the rest', () => {
  const makePlans = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: String(9100 + i),
      sha: `${'abcdef01'[i % 8]}`.repeat(40),
      subject: `${9100 + i}: land helper block ${i}`,
      lines: 100 - i, // already sorted desc, as attributeRemovals returns them
    }));
  const render = (n) =>
    reversionPreflightReason([
      { path: 'shared.py', removedLines: 400, attributed: 380, plans: makePlans(n) },
    ]);

  const over = render(MAX_RENDERED_PLANS + 3);
  for (let i = 0; i < MAX_RENDERED_PLANS; i++) {
    assert.match(over, new RegExp(`plan ${9100 + i}\\b`), `the top ${i + 1} culprit is named`);
  }
  for (let i = MAX_RENDERED_PLANS; i < MAX_RENDERED_PLANS + 3; i++) {
    assert.doesNotMatch(
      over,
      new RegExp(`plan ${9100 + i}\\b`),
      'the tail is summarised, not named',
    );
  }
  assert.match(over, /\(\+3 more plans not shown\)/, 'the omitted count is stated');
  // the attributed TOTAL is unaffected by the render cap — capping the names must never look
  // like the land drops less than it does.
  assert.match(over, /380 of them landed by/);

  assert.match(
    render(MAX_RENDERED_PLANS + 1),
    /\(\+1 more plan not shown\)/,
    'singular reads right',
  );
  assert.doesNotMatch(render(MAX_RENDERED_PLANS), /not shown/, 'exactly at the cap omits nothing');
});

// plan 2917 T3′ (2792 review finding ucq7li): done-worktree does NOT compare against the string
// `origin/master` — plan 2433 pins the probe to the exact sha the rebase proved current — so a
// message hard-coding `origin/master` names a ref a sibling land may already have moved past.
test('plan 2917 — the message names the ref actually compared against, defaulting to origin/master', () => {
  const finding = { path: 'a/b.py', removedLines: 56, unsound: 'shallow-history' };

  // DEFAULT: byte-identical wording to before the parameter existed, so the standalone CLI and
  // every caller that omits the opt render exactly as they always did.
  const dflt = reversionPreflightReason([finding]);
  assert.match(dflt, /REMOVES lines from origin\/master/);
  assert.match(dflt, /drops 56 lines from origin\/master/);
  assert.match(dflt, /attribution unsound: shallow-history/);

  // PINNED: the sha replaces every NAME-OF-THE-COMPARED-REF use…
  const pinned = reversionPreflightReason([finding], { masterRef: 'a67a4906046d' });
  assert.match(pinned, /REMOVES lines from a67a4906046d/);
  assert.match(pinned, /merged tree vs a67a4906046d/);
  assert.match(pinned, /drops 56 lines from a67a4906046d/);
  assert.match(pinned, /attribution unsound: shallow-history/, 'the unsound render is untouched');
  // …and ONLY those: the remedy sentence still sends the operator at live origin/master, because
  // "replay onto <a sha that is already behind>" would be wrong advice.
  assert.match(pinned, /patch-replay the branch's OWN diff onto CURRENT origin\/master/);
  assert.doesNotMatch(pinned, /lines from origin\/master/);

  // plan 2917 T3′ round 2 (review 61eba4/0af61d/56b2fb/511058): the WARN renderer describes the
  // SAME run, so it takes the same opt — one run must never name two different refs. Its DEFAULT
  // is byte-identical to the pre-2917 string, which is what keeps plan 2908's shallow downgrade
  // unchanged (AC4) for every caller that omits the opt.
  assert.match(unsoundWarnBlock([finding]), /56 lines removed from origin\/master/);
  assert.match(
    unsoundWarnBlock([finding], { masterRef: 'a67a4906046d' }),
    /removed from a67a4906046d/,
  );
  assert.doesNotMatch(
    unsoundWarnBlock([finding], { masterRef: 'a67a4906046d' }),
    /origin\/master/,
    'the WARN carries no remedy sentence, so the pinned ref is its only ref',
  );
});

test('reversionPreflightReason renders the DRY-run fake finding shape without throwing', () => {
  // done-worktree's DW_FAKE_LANDED_REVERSION supplies bare `{ path }` objects to exercise the
  // seam's wiring without a scratch repo — the renderer must survive them.
  const reason = reversionPreflightReason([{ path: 'backend/scripts/_places_geo.py' }]);
  assert.match(reason, /_places_geo\.py/);
});

test("ownPlanIds — collected from the branch's own commit subjects AND its worktree- name", () => {
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'f.py'), 'x\n');
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    const masterTip = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    // a batch train: one branch, commits prefixed by each member's id
    checkout(dir, '-b', 'worktree-9009-Coord-demo', masterTip);
    writeFileSync(join(dir, 'a.py'), 'a\n');
    commit(dir, '8001: first member');
    writeFileSync(join(dir, 'b.py'), 'b\n');
    commit(dir, '8002: second member');

    const ids = ownPlanIds(dir, masterTip, 'worktree-9009-Coord-demo');
    assert.deepEqual([...ids].sort(), ['8001', '8002', '9009']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===============================================================================================
// PLAN 3210 PART 2 — culpritTestTargets / runCulpritTests / culpritTestEvidence
// ===============================================================================================

test('culpritTestTargets — the primary glob finds test_<planId>_*.py, token-anchored (no digit-run bleed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'culprit-targets-'));
  try {
    mkdirSync(join(dir, 'backend', 'scripts', '__tests__'), { recursive: true });
    writeFileSync(join(dir, 'backend', 'scripts', '__tests__', 'test_9401_helper.py'), '');
    writeFileSync(join(dir, 'backend', 'scripts', '__tests__', 'test_9401_other.py'), '');
    // must NOT match plan 9401 — the id must be its own token, not a prefix of a longer digit run
    writeFileSync(join(dir, 'backend', 'scripts', '__tests__', 'test_94010_decoy.py'), '');
    const finding = { path: 'backend/scripts/apply-homepage-verdicts.py', plans: [{ id: '9401' }] };
    assert.deepEqual(culpritTestTargets(dir, finding), [
      {
        planId: '9401',
        targets: [
          'backend/scripts/__tests__/test_9401_helper.py',
          'backend/scripts/__tests__/test_9401_other.py',
        ],
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("culpritTestTargets — falls back to the FINDING's own name-paired sibling when the primary glob is empty", () => {
  const dir = mkdtempSync(join(tmpdir(), 'culprit-fallback-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'foo.mjs'), '');
    writeFileSync(join(dir, 'scripts', 'foo.test.mjs'), '');
    assert.deepEqual(
      culpritTestTargets(dir, { path: 'scripts/foo.mjs', plans: [{ id: '9402' }] }),
      [{ planId: '9402', targets: ['scripts/foo.test.mjs'] }],
    );

    mkdirSync(join(dir, 'backend', 'scripts', '__tests__'), { recursive: true });
    writeFileSync(join(dir, 'backend', 'scripts', 'bar.py'), '');
    writeFileSync(join(dir, 'backend', 'scripts', '__tests__', 'test_bar.py'), '');
    assert.deepEqual(
      culpritTestTargets(dir, { path: 'backend/scripts/bar.py', plans: [{ id: '9403' }] }),
      [{ planId: '9403', targets: ['backend/scripts/__tests__/test_bar.py'] }],
    );

    // Review finding [3]: a REALISTIC hyphenated script name — this repo's real sibling test
    // files use underscores (`apply-homepage-verdicts.py` -> `test_apply_homepage_verdicts.py`),
    // so a raw-hyphenated candidate could never match anything on disk.
    writeFileSync(join(dir, 'backend', 'scripts', 'apply-homepage-verdicts.py'), '');
    writeFileSync(
      join(dir, 'backend', 'scripts', '__tests__', 'test_apply_homepage_verdicts.py'),
      '',
    );
    assert.deepEqual(
      culpritTestTargets(dir, {
        path: 'backend/scripts/apply-homepage-verdicts.py',
        plans: [{ id: '9406' }],
      }),
      [
        {
          planId: '9406',
          targets: ['backend/scripts/__tests__/test_apply_homepage_verdicts.py'],
        },
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('culpritTestTargets — neither the primary glob nor the fallback exists ⇒ targets: [] (AC4 shape)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'culprit-none-'));
  try {
    const finding = { path: 'scripts/nope.mjs', plans: [{ id: '9404' }, { id: '9405' }] };
    assert.deepEqual(culpritTestTargets(dir, finding), [
      { planId: '9404', targets: [] },
      { planId: '9405', targets: [] },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCulpritTests — no targets ⇒ ok:false (fail-closed), never invokes a runner', () => {
  assert.deepEqual(runCulpritTests('/nonexistent', []), {
    ok: false,
    detail: 'no test targets to run',
  });
  assert.deepEqual(runCulpritTests('/nonexistent', null), {
    ok: false,
    detail: 'no test targets to run',
  });
});

test('runCulpritTests — the injectable runner seam: a green result flows through untouched', () => {
  const runner = (wtPath, targets) => ({ ok: true, detail: `ran ${targets.join(',')}` });
  assert.deepEqual(runCulpritTests('/x', ['a.py'], { runner }), { ok: true, detail: 'ran a.py' });
});

test('runCulpritTests — fail-closed on a throwing runner, a malformed result, or a red result', () => {
  assert.equal(
    runCulpritTests('/x', ['a.py'], {
      runner: () => {
        throw new Error('boom');
      },
    }).ok,
    false,
  );
  assert.equal(
    runCulpritTests('/x', ['a.py'], { runner: () => ({ detail: 'no ok field' }) }).ok,
    false,
  );
  assert.equal(runCulpritTests('/x', ['a.py'], { runner: () => null }).ok, false);
  assert.deepEqual(
    runCulpritTests('/x', ['a.py'], { runner: () => ({ ok: false, detail: 'red' }) }),
    {
      ok: false,
      detail: 'red',
    },
  );
});

test('runCulpritTests — the DEFAULT runner really spawns `.mjs` targets via `node --test` (real green + real red)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'culprit-run-'));
  try {
    writeFileSync(
      join(dir, 'green.test.mjs'),
      "import { test } from 'node:test';\n" +
        "import assert from 'node:assert/strict';\n" +
        "test('passes', () => assert.equal(1, 1));\n",
    );
    writeFileSync(
      join(dir, 'red.test.mjs'),
      "import { test } from 'node:test';\n" +
        "import assert from 'node:assert/strict';\n" +
        "test('fails', () => assert.equal(1, 2));\n",
    );
    assert.equal(runCulpritTests(dir, ['green.test.mjs']).ok, true);
    const red = runCulpritTests(dir, ['red.test.mjs']);
    assert.equal(red.ok, false);
    assert.ok(red.detail && red.detail.length, 'a red run still carries SOME diagnostic detail');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCulpritTests — the DEFAULT runner refuses an unsupported target extension (fail-closed, not silently skipped)', () => {
  const result = runCulpritTests('/x', ['scripts/foo.ts']);
  assert.equal(result.ok, false);
  assert.match(result.detail, /unsupported culprit-test target extension/);
});

test('culpritTestEvidence — vouched iff EVERY culprit plan has >=1 target AND every one of them ran green', () => {
  const dir = mkdtempSync(join(tmpdir(), 'culprit-evidence-'));
  try {
    mkdirSync(join(dir, 'backend', 'scripts', '__tests__'), { recursive: true });
    writeFileSync(join(dir, 'backend', 'scripts', '__tests__', 'test_9410_helper.py'), '');
    writeFileSync(join(dir, 'backend', 'scripts', '__tests__', 'test_9411_helper.py'), '');
    const finding = {
      path: 'backend/scripts/apply-homepage-verdicts.py',
      plans: [{ id: '9410' }, { id: '9411' }],
    };

    const allGreen = culpritTestEvidence(dir, [finding], {
      runner: () => ({ ok: true, detail: '' }),
    });
    assert.equal(allGreen.length, 1);
    assert.equal(allGreen[0].vouched, true);
    assert.deepEqual(
      allGreen[0].plans.map((p) => p.status),
      ['green', 'green'],
    );

    // AC3: ONE culprit test failing ⇒ vouched:false, even though the other is green
    const oneRed = culpritTestEvidence(dir, [finding], {
      runner: (wtPath, targets) => ({ ok: !targets[0].includes('9411'), detail: '' }),
    });
    assert.equal(oneRed[0].vouched, false);
    assert.deepEqual(
      oneRed[0].plans.map((p) => p.status),
      ['green', 'red'],
    );

    // AC4: a culprit plan with NO test file ⇒ 'missing', vouched:false, and the runner is never
    // even invoked for that plan (there is nothing to run).
    let ranFor = [];
    const missing = culpritTestEvidence(
      dir,
      [{ path: finding.path, plans: [{ id: '9410' }, { id: '9999' }] }],
      {
        runner: (wtPath, targets) => {
          ranFor.push(targets);
          return { ok: true, detail: '' };
        },
      },
    );
    assert.equal(missing[0].vouched, false);
    assert.deepEqual(
      missing[0].plans.map((p) => p.status),
      ['green', 'missing'],
    );
    assert.equal(ranFor.length, 1, 'the runner ran ONLY for the plan that has a test target');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('culpritTestEvidence — never runs for an unsound (shallow-history) finding; its WARN-only path is untouched', () => {
  let called = false;
  const findings = [{ path: 'a.py', removedLines: 40, unsound: 'shallow-history' }];
  const evidence = culpritTestEvidence('/x', findings, {
    runner: () => {
      called = true;
      return { ok: true, detail: '' };
    },
  });
  assert.deepEqual(evidence, []);
  assert.equal(called, false, 'the runner must never be invoked for an unsound finding');
});

test('culpritTestEvidence — the SAME culprit plan across MULTIPLE findings runs its tests AT MOST ONCE (review finding [5])', () => {
  const dir = mkdtempSync(join(tmpdir(), 'culprit-memo-'));
  try {
    mkdirSync(join(dir, 'backend', 'scripts', '__tests__'), { recursive: true });
    writeFileSync(join(dir, 'backend', 'scripts', '__tests__', 'test_9450_helper.py'), '');
    // one plan (9450), attributed on TWO different findings — the "one plan's landed change
    // touched several files this land reverts lines in" shape the finding describes.
    const findingA = { path: 'backend/scripts/a.py', plans: [{ id: '9450' }] };
    const findingB = { path: 'backend/scripts/b.py', plans: [{ id: '9450' }] };
    let runs = 0;
    const evidence = culpritTestEvidence(dir, [findingA, findingB], {
      runner: () => {
        runs++;
        return { ok: true, detail: '' };
      },
    });
    assert.equal(runs, 1, "plan 9450's identical target set is run only ONCE across both findings");
    assert.equal(evidence[0].vouched, true);
    assert.equal(evidence[1].vouched, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===============================================================================================
// PLAN 3210 PART 2/3 — reversionPreflightReason(findings, { masterRef, evidence }): the vouching
// render, byte-compatible when `evidence` is omitted.
// ===============================================================================================

test('reversionPreflightReason — omitting `evidence` renders BYTE-IDENTICAL output (no change to any existing caller)', () => {
  const findings = [
    {
      path: 'backend/scripts/apply-homepage-verdicts.py',
      removedLines: 32,
      attributed: 32,
      plans: [
        {
          id: '3035',
          sha: '07a1e19b3aa',
          subject: '3035: land homepage verdict helper',
          lines: 32,
        },
      ],
    },
  ];
  const withoutOpt = reversionPreflightReason(findings, { masterRef: 'origin/master' });
  const withUndefinedEvidence = reversionPreflightReason(findings, {
    masterRef: 'origin/master',
    evidence: undefined,
  });
  assert.equal(withoutOpt, withUndefinedEvidence);
  assert.doesNotMatch(withoutOpt, /VOUCHED/);
  assert.doesNotMatch(withoutOpt, /RELEASE PATH/);
});

test('reversionPreflightReason — a VOUCHED finding names the plans + exact test targets (AC2)', () => {
  const findings = [
    {
      path: 'backend/scripts/apply-homepage-verdicts.py',
      removedLines: 32,
      attributed: 32,
      plans: [
        {
          id: '3035',
          sha: '07a1e19b3aa',
          subject: '3035: land homepage verdict helper',
          lines: 32,
        },
      ],
    },
  ];
  const evidence = [
    {
      path: 'backend/scripts/apply-homepage-verdicts.py',
      plans: [
        {
          id: '3035',
          targets: ['backend/scripts/__tests__/test_3035_apply_homepage_verdicts.py'],
          status: 'green',
        },
      ],
      vouched: true,
    },
  ];
  const reason = reversionPreflightReason(findings, { masterRef: 'origin/master', evidence });
  assert.match(
    reason,
    /VOUCHED: plan 3035's tests \(backend\/scripts\/__tests__\/test_3035_apply_homepage_verdicts\.py\) PASS/,
  );
  assert.match(reason, /does NOT prove no reversion/, 'honest naming — never "no reversion"');
  // plan 3832: RELEASE PATH / --allow-landed-reversion* text is retired along with the halt it
  // used to release — this lint reports and never blocks a land, so there is nothing left to
  // release from. reversionPreflightReason renders no such text any more.
  assert.doesNotMatch(reason, /RELEASE PATH/);
  assert.doesNotMatch(reason, /--allow-landed-reversion/);
});

test('reversionPreflightReason — a finding with evidence but NOT vouched renders no VOUCHED block and no release path (AC3 shape)', () => {
  const findings = [
    {
      path: 'a.py',
      removedLines: 40,
      attributed: 40,
      plans: [{ id: '9410', sha: 'a'.repeat(40), subject: '9410: land a', lines: 40 }],
    },
  ];
  const evidence = [
    {
      path: 'a.py',
      plans: [{ id: '9410', targets: ['backend/scripts/__tests__/test_9410_a.py'], status: 'red' }],
      vouched: false,
    },
  ];
  const reason = reversionPreflightReason(findings, { evidence });
  assert.doesNotMatch(reason, /VOUCHED/);
  assert.doesNotMatch(reason, /RELEASE PATH/);
});

test('reversionPreflightReason — anyVouched is scoped to the RENDERED findings, not the whole evidence array (review finding [1])', () => {
  // finding A: already vouched + released (no longer among the findings being rendered here).
  // finding B: still halting, its OWN evidence is red/un-vouched — but `evidence` (as done-
  // worktree's own caller passes it: computed once for `sound`, reused across the render) still
  // carries A's vouched entry.
  const findingB = {
    path: 'b.py',
    removedLines: 40,
    attributed: 40,
    plans: [{ id: '200', sha: 'b'.repeat(40), subject: '200: land b', lines: 40 }],
  };
  const evidence = [
    {
      path: 'a.py',
      plans: [{ id: '100', targets: ['backend/scripts/__tests__/test_100_a.py'], status: 'green' }],
      vouched: true,
    },
    {
      path: 'b.py',
      plans: [{ id: '200', targets: ['backend/scripts/__tests__/test_200_b.py'], status: 'red' }],
      vouched: false,
    },
  ];
  // Only B is passed as `findings` (A was already released and dropped from `remaining`) — the
  // repro from the finding's own failure_scenario.
  const reason = reversionPreflightReason([findingB], { evidence });
  assert.doesNotMatch(reason, /VOUCHED/, 'B was never vouched — no VOUCHED line for it');
  assert.doesNotMatch(
    reason,
    /RELEASE PATH/,
    "A's vouched-but-not-rendered evidence must not leak a release-path block onto B's halt",
  );
});

// plan 3832: PLAN 3210 PART 3's scope-pinned auditable release flag apparatus
// (`assertReleaseFlagOk`, `parseReversionScope`, `reviewerVerdictUpheld`, `releasedFindings`,
// `computeReversionRelease`, `parseReversionCliArgs`, `validateReleaseFlags`,
// `landedReversionOverrideTrailer`) and the `ESCAPE_HATCH_ENV`/`escapeHatchWarning` bypass are
// RETIRED along with the halt they released — this lint reports and never blocks a land, so
// there is no release decision left to test. Their tests are deleted with them; see
// assert-no-landed-reversion.mjs header § DEMOTED TO ADVISORY.
//
// Round-2 review fix [R3]: `stripReversionReleaseFlags` is defined+exported in done-worktree.mjs,
// so its tests moved to done-worktree.test.mjs (its name-paired test file, per CLAUDE.md's
// "fold new cases into the existing name-paired test file of the module under test") — see
// "stripReversionReleaseFlags (done-worktree.mjs) — flags-then-slug order resolves the SLUG
// correctly" there.

test('defaultCulpritTestRunner — exported (review fix [4]) and still runs `.mjs` targets for real', () => {
  const dir = mkdtempSync(join(tmpdir(), 'default-runner-export-'));
  try {
    writeFileSync(
      join(dir, 'green.test.mjs'),
      "import { test } from 'node:test';\n" +
        "import assert from 'node:assert/strict';\n" +
        "test('passes', () => assert.equal(1, 1));\n",
    );
    assert.equal(defaultCulpritTestRunner(dir, ['green.test.mjs']).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===============================================================================================
// PLAN 3210 — --explain: DISPLAY-only dropped-line/successor pairing (never a resurrection of the
// Part 1 detector: nothing here judges intent or decides release).
// ===============================================================================================

test('explainDroppedLines — pairs a dropped attributed line with its nearest surviving successor; "(no successor)" when nothing is close', () => {
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'shared.py'), 'header_stable\n');
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    const masterLines = Array.from({ length: 25 }, (_, i) => `tokA_${i + 1} tokB_${i + 1}`);
    writeFileSync(join(dir, 'shared.py'), 'header_stable\n' + masterLines.join('\n') + '\n');
    const masterTip = commit(dir, '9420: land 25 symbol lines');

    checkout(dir, '-b', 'worktree-9421-Infra-rewrite', masterTip);
    // ONE surviving line is a near-identical successor for symbol index 5 (shares both its
    // tokens plus an extra one); every other dropped line shares NOTHING with anything surviving.
    const rewritten =
      'header_stable\n' +
      'tokA_5 tokB_5 extra_marker\n' +
      Array.from({ length: 4 }, (_, i) => `filler_${i} completely_unrelated`).join('\n') +
      '\n';
    writeFileSync(join(dir, 'shared.py'), rewritten);
    commit(dir, '9421: rewrite — one line survives as a lookalike, the rest do not');

    const result = explainDroppedLines(dir, 'shared.py', {
      masterRef: masterTip,
      branchRef: 'worktree-9421-Infra-rewrite',
    });
    assert.equal(result.path, 'shared.py');
    assert.equal(result.pairs.length, 25, 'every dropped attributed line is paired');
    assert.ok(
      result.pairs.every((p) => p.planId === '9420'),
      'every pair is attributed to plan 9420',
    );
    const five = result.pairs.find((p) => p.dropped === 'tokA_5 tokB_5');
    assert.ok(five);
    assert.equal(five.successor, 'tokA_5 tokB_5 extra_marker', 'the near-identical line wins');
    const other = result.pairs.find((p) => p.dropped === 'tokA_9 tokB_9');
    assert.ok(other);
    assert.equal(other.successor, null, 'nothing surviving resembles this one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 3832 (independent R1 audit, non-refuting caveat): `main()`'s argv handling is now an
// INLINE scan — `--explain <path>` plus positionals — because it was the sole survivor of the
// four-flag `parseReversionCliArgs` scanner, whose own test went with the release machinery. That
// left a SURVIVING behaviour uncovered, which is the one shape a retirement must never produce.
// This is the replacement: it pins the two things the deleted test pinned about this argv shape —
// `--explain` consumes the NEXT token as its value (never a positional), and everything else is
// positional, so the worktree path can precede or follow the flag.
test('plan 3832: main() consumes `--explain <path>` as a pair and treats the rest as positional', async () => {
  const dir = initFixtureRepo();
  const logged = [];
  const realLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    // path-then-flag AND flag-then-path must both resolve the same way: wtPath = the fixture,
    // explainPath = 'shared.py'. Neither ordering may let 'shared.py' land in `positional`.
    for (const argv of [
      [dir, '--explain', 'shared.py'],
      ['--explain', 'shared.py', dir],
    ]) {
      logged.length = 0;
      const code = await main(argv);
      assert.equal(code, 0, '--explain is a DISPLAY mode and always exits 0');
      assert.match(
        logged.join('\n'),
        /--explain shared\.py|no dropped attributed line found for shared\.py/,
        `${argv.join(' ')} must resolve shared.py as the --explain target, not as the wtPath`,
      );
    }
  } finally {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explainDroppedLines — no dropped attributed lines ⇒ empty pairs; a merge-tree failure fails open to null', () => {
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'f.py'), 'x\n');
    commit(dir, 'init');
    assert.deepEqual(explainDroppedLines(dir, 'f.py', { masterRef: 'HEAD', branchRef: 'HEAD' }), {
      path: 'f.py',
      pairs: [],
    });
    assert.equal(
      explainDroppedLines(dir, 'f.py', { masterRef: 'origin/nope', branchRef: 'HEAD' }),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===============================================================================================
// PLAN 3210 — end-to-end acceptance criteria 2, 3, 4, 5: a REAL git rewrite fixture, real culprit
// test files discovered on disk (the primary glob), and an INJECTED runner standing in for
// `python -m pytest` (this suite must not depend on pytest being installed in every environment
// it runs in — the runner seam exists exactly so evidence-gathering behaviour does not).
// ===============================================================================================

function buildTwoPlanRewriteFixture() {
  const dir = initFixtureRepo();
  writeFileSync(join(dir, 'shared.py'), BODY);
  commit(dir, 'base');
  checkout(dir, '-b', 'masterbr');
  let content = BODY;
  for (const id of [9430, 9431]) {
    content += landedBlock(id);
    writeFileSync(join(dir, 'shared.py'), content);
    commit(dir, `${id}: land plan ${id}'s helper block on shared.py`);
  }
  mkdirSync(join(dir, 'backend', 'scripts', '__tests__'), { recursive: true });
  writeFileSync(
    join(dir, 'backend', 'scripts', '__tests__', 'test_9430_helper.py'),
    '# placeholder\n',
  );
  writeFileSync(
    join(dir, 'backend', 'scripts', '__tests__', 'test_9431_helper.py'),
    '# placeholder\n',
  );
  commit(dir, 'chore: add culprit-plan test placeholders (kept on the branch below too)');
  const masterTip = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();

  checkout(dir, '-b', 'worktree-9432-Infra-rewrite', masterTip);
  const rewritten =
    BODY +
    Array.from({ length: 190 }, (_, i) => `class RewrittenWidget${i + 1}: pass`).join('\n') +
    '\n';
  writeFileSync(join(dir, 'shared.py'), rewritten);
  commit(dir, '9432: rewrite the two landed helper blocks with new implementation');
  return { dir, masterTip, branchRef: 'worktree-9432-Infra-rewrite' };
}

test('AC2 end-to-end: culprit tests all green ⇒ vouched evidence rendered on a real two-plan rewrite fixture', () => {
  const { dir, masterTip, branchRef } = buildTwoPlanRewriteFixture();
  try {
    const findings = detectLandedReversion(dir, { masterRef: masterTip, branchRef });
    assert.equal(
      findings.length,
      1,
      'sanity: the real detector still reports a legitimate rewrite',
    );
    const [finding] = findings;
    assert.deepEqual(finding.plans.map((p) => p.id).sort(), ['9430', '9431']);

    const evidence = culpritTestEvidence(dir, findings, {
      runner: () => ({ ok: true, detail: '' }),
    });
    assert.equal(evidence[0].vouched, true);
    const reason = reversionPreflightReason(findings, { masterRef: masterTip, evidence });
    // `plans[]` order follows attributeRemovals' own sort (both blocks tie at 40 lines, so
    // insertion — i.e. history-walk — order decides it), so assert both names are present
    // somewhere in the VOUCHED line rather than assuming either comes first.
    assert.match(
      reason,
      /VOUCHED:.*plan 9430's tests \(backend\/scripts\/__tests__\/test_9430_helper\.py\)/,
    );
    assert.match(
      reason,
      /VOUCHED:.*plan 9431's tests \(backend\/scripts\/__tests__\/test_9431_helper\.py\)/,
    );
    // plan 3832: RELEASE PATH text and the scope-pinned computeReversionRelease/
    // landedReversionOverrideTrailer release apparatus are retired along with the halt they used
    // to release — this lint is advisory now, so there is no release computation left to pin.
    assert.doesNotMatch(reason, /RELEASE PATH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC3 end-to-end: the SAME rewrite fixture with ONE culprit test failing renders NO vouching', () => {
  const { dir, masterTip, branchRef } = buildTwoPlanRewriteFixture();
  try {
    const findings = detectLandedReversion(dir, { masterRef: masterTip, branchRef });
    assert.equal(findings.length, 1);
    const evidence = culpritTestEvidence(dir, findings, {
      runner: (wtPath, targets) => ({ ok: !targets[0].includes('9431'), detail: 'plan 9431 red' }),
    });
    assert.equal(evidence[0].vouched, false);
    const statusById = Object.fromEntries(evidence[0].plans.map((p) => [p.id, p.status]));
    assert.deepEqual(statusById, { 9430: 'green', 9431: 'red' });
    const reason = reversionPreflightReason(findings, { masterRef: masterTip, evidence });
    assert.doesNotMatch(reason, /VOUCHED/);
    assert.doesNotMatch(reason, /RELEASE PATH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC4 end-to-end: a culprit plan with NO test file at all halts with no vouching', () => {
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'shared.py'), BODY);
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    let content = BODY;
    for (const id of [9440, 9441]) {
      content += landedBlock(id);
      writeFileSync(join(dir, 'shared.py'), content);
      commit(dir, `${id}: land plan ${id}'s helper block on shared.py`);
    }
    // ONLY plan 9440 gets a test file — 9441 has none anywhere in the tree.
    mkdirSync(join(dir, 'backend', 'scripts', '__tests__'), { recursive: true });
    writeFileSync(
      join(dir, 'backend', 'scripts', '__tests__', 'test_9440_helper.py'),
      '# placeholder\n',
    );
    commit(dir, 'chore: add ONE culprit-plan test placeholder');
    const masterTip = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    checkout(dir, '-b', 'worktree-9442-Infra-rewrite', masterTip);
    const rewritten =
      BODY +
      Array.from({ length: 190 }, (_, i) => `class RewrittenWidget${i + 1}: pass`).join('\n') +
      '\n';
    writeFileSync(join(dir, 'shared.py'), rewritten);
    commit(dir, '9442: rewrite the two landed helper blocks with new implementation');

    const findings = detectLandedReversion(dir, {
      masterRef: masterTip,
      branchRef: 'worktree-9442-Infra-rewrite',
    });
    assert.equal(findings.length, 1);
    const evidence = culpritTestEvidence(dir, findings, {
      runner: () => ({ ok: true, detail: '' }),
    });
    assert.equal(evidence[0].vouched, false);
    const statuses = Object.fromEntries(evidence[0].plans.map((p) => [p.id, p.status]));
    assert.equal(statuses['9440'], 'green');
    assert.equal(statuses['9441'], 'missing');
    const reason = reversionPreflightReason(findings, { masterRef: masterTip, evidence });
    assert.doesNotMatch(reason, /VOUCHED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===============================================================================================
// PLAN 3210 — acceptance criterion 6: replaying plan 3182's real branch + merge-base.
//
// plan 3182 landed 2026-08-15 as commit a2e9043f9d (parents 6733d7e37d1b = pre-merge master,
// 18cd594423 = the branch tip), touching backend/scripts/apply-homepage-verdicts.py exactly as
// this plan's provenance describes. BOTH commits are present in THIS clone's history — but this
// sandbox's checkout of the vetapp repo is a SHALLOW clone (`.git/shallow` present machine-wide,
// shared by every session on this box), so `detectLandedReversion` downgrades the replay to
// `unsound: 'shallow-history'` rather than a sound, plan-attributed finding (verified live against
// the two real shas below before writing this test). Deepening the shared clone
// (`git fetch --unshallow`) to get a SOUND real replay is a machine-global, likely large/slow
// mutation of state every parallel session on this box shares — outside this plan's file
// allowlist and judgment call territory, so per the plan's own instruction this is NOT
// fabricated: the shape is covered by a fixture below instead, and the live-replay gap is
// reported back to the dispatching session.
// ===============================================================================================

test('AC6 (live replay unavailable — see comment above): a fixture mirroring plan 3182 s real shape reproduces the RULED behaviour', () => {
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'apply-homepage-verdicts.py'), BODY);
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    // plan 3035 lands 32 attributed lines (the plan-3182 provenance's own figure)
    const thirtyTwoLines =
      Array.from(
        { length: 32 },
        (_, i) => `def plan_3035_verdict_helper_${i + 1}(): return ${i + 1}`,
      ).join('\n') + '\n';
    writeFileSync(join(dir, 'apply-homepage-verdicts.py'), BODY + thirtyTwoLines);
    commit(dir, "3035: land plan 3035's homepage-verdict helper block");
    mkdirSync(join(dir, 'backend', 'scripts', '__tests__'), { recursive: true });
    writeFileSync(
      join(dir, 'backend', 'scripts', '__tests__', 'test_3035_apply_homepage_verdicts.py'),
      '# placeholder\n',
    );
    commit(dir, "chore: plan 3035's own test file");
    const masterTip = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    // plan 3182 rewrites those 32 lines in place with 254 lines of new replacement code —
    // _resolve_host / LIVENESS_COHORT_ACTION / --reject, per the plan's own provenance section.
    checkout(dir, '-b', 'worktree-3182-DQ-rewrite', masterTip);
    const rewritten =
      BODY +
      Array.from(
        { length: 254 },
        (_, i) => `def _resolve_host_variant_${i + 1}(): return LIVENESS_COHORT_ACTION`,
      ).join('\n') +
      '\n';
    writeFileSync(join(dir, 'apply-homepage-verdicts.py'), rewritten);
    commit(dir, '3182: rewrite the homepage-verdict helper with --reject support');

    const findings = detectLandedReversion(dir, {
      masterRef: masterTip,
      branchRef: 'worktree-3182-DQ-rewrite',
    });
    assert.equal(
      findings.length,
      1,
      'the real gate halts this rewrite, exactly as it did on 2026-08-15',
    );
    assert.deepEqual(
      findings[0].plans.map((p) => p.id),
      ['3035'],
    );

    const evidence = culpritTestEvidence(dir, findings, {
      runner: () => ({ ok: true, detail: '' }),
    });
    assert.equal(
      evidence[0].vouched,
      true,
      "plan 3035's own test still passes on the rewritten tree",
    );
    const reason = reversionPreflightReason(findings, { masterRef: masterTip, evidence });
    assert.match(reason, /VOUCHED: plan 3035's tests/);
    // plan 3832: the RULED behaviour that survives — tests-green alone never proves "no
    // reversion", only that the covered behaviour survives (reversionPreflightReason still says
    // so, above) — but there is no longer a RELEASE PATH to print or a flag-gated release
    // computation to pin: this lint reports and the land proceeds regardless.
    assert.doesNotMatch(reason, /RELEASE PATH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// PLAN 3246 — the three documented FALSE-POSITIVE / MISNAMING classes, replayed as fixtures.
//
// Step 0 of that plan was "replay first, fix second": build each firing shape and run it against
// the CURRENT gate before patching anything, so a class already closed by the 2908/2917/3210
// reworks is recorded as closed rather than re-fixed. Measured 2026-08-16 against the gate as it
// stood after plan 3210: ALL FOUR shapes still fired. None was closed by a rework, so each fix
// below is against a reproduced defect, and each fixture is the regression pin for it.
//
// The two remaining acceptance invariants — a TRUE reversion still hard-blocks (`acceptance 2`
// above) and the plan-3210 culprit-test / reviewer-verdict release path is byte-unchanged (the
// AC2–AC6 end-to-end tests above) — are asserted by the pre-existing tests, which all still pass.
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CLASS 1 — the FRESHEN merge. Firings: plan 2853 (blocked claiming 29 lines "landed by plan
// 2404") and plan 2875 (26 lines "landed by plan 2855"). The named commits are real:
// bd6656e29 is "Merge remote-tracking branch 'origin/master' into worktree-2404-…" and
// f0f7392fa is "Merge origin/master into worktree-2855 — …". Both are FRESHEN merges, whose
// FIRST parent is the branch — so their first-parent patch carries MASTER's work while
// `authoringPlanId` reads the BRANCH's id out of the subject. Being newer than the real
// authoring commits, the freshen merge won newest-wins and the true authors vanished.
//
// Note the plan-3246 body's own diagnostic caveat, which this fixture confirms: `git show
// --stat <sha> -- <file>` printing EMPTY is NOT proof the attribution was wrong, because
// `git show` defaults to no merge diff. The first-parent patch here is very much non-empty.
// ---------------------------------------------------------------------------
test("plan 3246 class 1 — a FRESHEN merge never authors master's work (2853/2875)", () => {
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'shared.py'), BODY);
    const base = commit(dir, 'base');

    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'shared.py'), BODY + landedBlock(1111));
    commit(dir, '1111: land plan 1111 helper block on shared.py');
    writeFileSync(join(dir, 'shared.py'), BODY + landedBlock(1111) + landedBlock(2222));
    const t2 = commit(dir, '2222: land plan 2222 helper block on shared.py');

    // plan 2404's branch forks BEFORE both, does its own work elsewhere, then freshens.
    checkout(dir, base);
    checkout(dir, '-b', 'worktree-2404-FABLE-Pipe-consensus-se-bundle-detector');
    writeFileSync(join(dir, 'unrelated.txt'), 'plan 2404 own work\n');
    commit(dir, '2404: plan 2404 own work on an unrelated file');
    execFileSync('git', ['-C', dir, 'merge', '-q', '--no-edit', t2]);

    // …and it lands, which is what puts that freshen merge in master's reachable history.
    checkout(dir, 'masterbr');
    execFileSync('git', [
      '-C',
      dir,
      'merge',
      '-q',
      '--no-ff',
      '--no-edit',
      'worktree-2404-FABLE-Pipe-consensus-se-bundle-detector',
    ]);
    const masterTip = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    // A LATER branch stale-restores the file, genuinely dropping what 1111 and 2222 landed.
    checkout(dir, '-b', 'worktree-9005-Infra-restore', masterTip);
    writeFileSync(join(dir, 'shared.py'), BODY);
    commit(dir, '9005: rebuild shared.py on fresh master');

    const findings = detectLandedReversion(dir, {
      masterRef: masterTip,
      branchRef: 'worktree-9005-Infra-restore',
    });
    assert.equal(findings.length, 1, 'the genuine stale restore must STILL be caught');
    const [f] = findings;
    assert.deepEqual(
      f.plans.map((p) => p.id).sort(),
      ['1111', '2222'],
      "the REAL authors are named — never the freshen merge's innocent plan 2404",
    );
    const reason = reversionPreflightReason(findings, { masterRef: masterTip });
    assert.doesNotMatch(reason, /plan 2404/, 'the refusal must not misname an innocent plan');
    // Attribution is CORRECTED, not lost: every dropped line is still accounted for, so the
    // fix can never turn this finding into a miss.
    assert.equal(f.attributed, 80);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan 3246 class 1 — a LAND merge is still the plan-id carrier (F4 design preserved)', () => {
  // The bound the plan sets on this fix: `--first-parent` must not cost us the landing merge,
  // which on a real land is the ONLY commit whose subject carries the plan id (the F4 comment
  // in the module). Here plan 7777's own commits claim no id at all, so if the land merge were
  // dropped from the walk the removal would be attributed to nobody and the guard would go
  // silent on a genuine reversion.
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'shared.py'), BODY);
    const base = commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');

    checkout(dir, base);
    checkout(dir, '-b', 'worktree-7777-Infra-feature');
    writeFileSync(join(dir, 'shared.py'), BODY + landedBlock(7777));
    commit(dir, 'add the helper block'); // deliberately NO plan id in the subject
    checkout(dir, 'masterbr');
    execFileSync('git', [
      '-C',
      dir,
      'merge',
      '-q',
      '--no-ff',
      '--no-edit',
      'worktree-7777-Infra-feature',
    ]);
    const masterTip = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    checkout(dir, '-b', 'worktree-9009-Infra-restore', masterTip);
    writeFileSync(join(dir, 'shared.py'), BODY);
    commit(dir, '9009: stale-restore shared.py');

    const findings = detectLandedReversion(dir, {
      masterRef: masterTip,
      branchRef: 'worktree-9009-Infra-restore',
    });
    assert.equal(findings.length, 1, 'the land merge must still carry the attribution');
    assert.deepEqual(
      findings[0].plans.map((p) => p.id),
      ['7777'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLASS 1 variant — firing 2892: a commit that RE-ADDS a whole file was credited every line in
// it forever after. The removal is real, so the halt is right; naming the janitor rather than
// the author is what made the refusal unactionable.
// ---------------------------------------------------------------------------
test('plan 3246 class 1 variant — a whole-file RE-ADD does not author the content (2892)', () => {
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'shared.py'), BODY);
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'shared.py'), BODY + landedBlock(1111));
    commit(dir, '1111: land plan 1111 helper block on shared.py');
    rmSync(join(dir, 'shared.py'));
    commit(dir, '3333: temporarily remove shared.py while restructuring');
    writeFileSync(join(dir, 'shared.py'), BODY + landedBlock(1111));
    const masterTip = commit(dir, '3333: restore shared.py unchanged after the restructure');

    checkout(dir, '-b', 'worktree-9006-Infra-drop', masterTip);
    writeFileSync(join(dir, 'shared.py'), BODY);
    commit(dir, '9006: drop the helper block');

    const findings = detectLandedReversion(dir, {
      masterRef: masterTip,
      branchRef: 'worktree-9006-Infra-drop',
    });
    assert.equal(findings.length, 1, 'the removal is genuine — the halt stands');
    assert.deepEqual(
      findings[0].plans.map((p) => p.id),
      ['1111'],
      'the author of the content, not the plan that mechanically re-added the file',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan 3246 class 1 variant — a genuinely NEW file still credits its creator', () => {
  // The other side of the re-add ordering rule: deprioritising file-creations must not make a
  // plan that CREATED a file un-nameable, or the fix would buy a false negative.
  const removed = new Set(['created_line_a', 'created_line_b', 'modified_line']);
  const history = [
    {
      sha: 'aaa',
      subject: '4444: create the module',
      added: new Set(['created_line_a', 'created_line_b']),
      fileCreation: true,
    },
    {
      sha: 'bbb',
      subject: '5555: edit the module',
      added: new Set(['modified_line']),
      fileCreation: false,
    },
  ];
  const { attributed, plans } = attributeRemovals(removed, history);
  assert.equal(attributed, 3);
  assert.deepEqual(plans.map((p) => p.id).sort(), ['4444', '5555']);
  assert.equal(
    plans.find((p) => p.id === '4444').lines,
    2,
    'the creator keeps lines nobody else added',
  );
});

// ---------------------------------------------------------------------------
// CLASS 2 — the table re-pad. Firings 2855 ("drops 61 lines, 60 landed by plan 2862" against a
// table that was a strict SUPERSET) and 2882, which proved the trigger is STRUCTURAL: adding the
// ONE glossary row docs/PIPELINE.md's own write-rule REQUIRES of a new-concept plan re-pads
// every column, so EVERY conforming new-concept land trips the gate. Hit live again by plan
// 2969 (infra-debt 2026-08-08). This fixture is the plan's named acceptance case.
// ---------------------------------------------------------------------------
test('plan 3246 class 2 — a required glossary row that re-pads every column is NOT a reversion (2855/2882)', () => {
  const dir = initFixtureRepo();
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    const rows = Array.from({ length: 60 }, (_, i) => [
      `concept-${i + 1}`,
      `stage 7.${i + 1}`,
      `what concept ${i + 1} means`,
    ]);
    const render = (rs) => {
      const w = [0, 1, 2].map((c) => Math.max(...rs.map((r) => r[c].length)));
      const line = (r) => `| ${r.map((c, i) => c.padEnd(w[i])).join(' | ')} |`;
      return (
        [
          line(['Name', 'Stage', 'Meaning']),
          `| ${w.map((n) => '-'.repeat(n)).join(' | ')} |`,
          ...rs.map(line),
        ].join('\n') + '\n'
      );
    };
    writeFileSync(join(dir, 'docs/PIPELINE.md'), '# pipeline\n');
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'docs/PIPELINE.md'), render(rows));
    const masterTip = commit(dir, '1111: land the glossary table');

    checkout(dir, '-b', 'worktree-9007-Pipe-new-concept', masterTip);
    const withNew = [
      ...rows,
      [
        'a-much-longer-new-concept-name',
        'stage 7.4.5.1',
        'the new concept this plan introduces, spelled out',
      ],
    ];
    writeFileSync(join(dir, 'docs/PIPELINE.md'), render(withNew));
    commit(dir, '9007: add the glossary row this plan is required to land');

    assert.deepEqual(
      detectLandedReversion(dir, {
        masterRef: masterTip,
        branchRef: 'worktree-9007-Pipe-new-concept',
      }),
      [],
      'the branch table is a strict superset — every "deleted" row is the same row, re-padded',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan 3246 class 2 — normalizeWhitespace/netRemovedLines pair a re-padded row with its survivor', () => {
  assert.equal(normalizeWhitespace('|  a   |  b |'), '| a | b |');
  assert.equal(normalizeWhitespace('   spaced   out   '), 'spaced out');
  const { net, reformatted } = netRemovedLines(
    new Set(['| alpha   | one |', '| beta    | two |', 'genuinely_deleted_line']),
    new Set(['| alpha | one |', '| beta | two |', '| gamma | three |']),
  );
  assert.deepEqual(
    [...net],
    ['genuinely_deleted_line'],
    'only the truly-gone line survives the filter',
  );
  assert.equal(reformatted, 2);
});

test('plan 3246 class 2 — normalization NEVER rescues a line that is simply gone', () => {
  // The safety direction: the filter may only ever remove lines that are demonstrably still
  // present modulo spacing. A real deletion with no counterpart is untouched.
  const { net, reformatted } = netRemovedLines(
    new Set(['def real_helper(): return 1', 'def other_helper(): return 2']),
    new Set(['def something_entirely_different(): return 3']),
  );
  assert.equal(net.size, 2);
  assert.equal(reformatted, 0);
});

// ---------------------------------------------------------------------------
// CLASS 2b (plan 3394) — PURE RE-INDENTATION. The CLASS 2 filter above pairs a re-PADDED line
// (internal spacing changed) with its survivor, but was blind to a re-INDENTED one (leading
// spacing changed), because diffLineSets trimmed every body before netRemovedLines could see it.
// Observed on plan 3321's land: wrapping a `<tr>` in a `<Fragment>` re-indents the block, and 38
// of 50 "dropped" lines were attributed to plans 2728 / 339 / 700 / 297 / 274 — against a
// `git diff -w` showing five real removals. Exit 32, cleared only with the blunt env var.
// ---------------------------------------------------------------------------

test('plan 3394 class 2b — the OLD trimmed-only pairing counts a pure re-indent as removed', () => {
  // Pins the MECHANISM the fix addresses, using the pre-3394 call shape (no raw sets): once the
  // bodies are trimmed, a re-indented line is byte-identical on both sides, so it hits the
  // "same literal text on both sides — never a reformat" branch and survives into `net`.
  const trimmed = ['const rows = bands.map((b) => b.serviceSlug);', 'return <tr>{rows}</tr>;'];
  const { net, reformatted } = netRemovedLines(new Set(trimmed), new Set(trimmed));
  assert.equal(reformatted, 0, 'nothing pairs off once indentation is gone');
  assert.deepEqual([...net].sort(), [...trimmed].sort(), 'every re-indented line reads as removed');
});

test('plan 3394 class 2b — raw sets let a pure re-indent pair off with its survivor', () => {
  const removedRaw = new Set([
    '    const rows = bands.map((b) => b.serviceSlug);',
    '    return <tr>{rows}</tr>;',
  ]);
  const addedRaw = new Set([
    '      const rows = bands.map((b) => b.serviceSlug);',
    '      return <tr>{rows}</tr>;',
  ]);
  const trimmed = new Set([...removedRaw].map((l) => l.trim()));
  const { net, reformatted } = netRemovedLines(trimmed, trimmed, { removedRaw, addedRaw });
  assert.equal(reformatted, 2, 'both lines are the same tokens at a different indent');
  assert.equal(net.size, 0, 'a pure re-indent removes nothing');
});

test('plan 3394 class 2b — a RAW-exact match is still never excused (round-1 property held)', () => {
  // The round-1 rule this fix must not weaken: an unrelated added line with identical text —
  // same indentation and all — may never excuse a genuine removal.
  const removedRaw = new Set(['        except Exception:', '        return legacy_helper(x)']);
  const addedRaw = new Set(['        except Exception:']);
  const trimmed = new Set([...removedRaw].map((l) => l.trim()));
  const { net, reformatted } = netRemovedLines(trimmed, trimmed, { removedRaw, addedRaw });
  assert.equal(reformatted, 0, 'an exact raw duplicate is not a reformat');
  assert.deepEqual(
    [...net].sort(),
    ['except Exception:', 'return legacy_helper(x)'],
    'both stay attributable, in TRIMMED space so the blame walk can still match them',
  );
});

test('plan 3394 class 2b — re-indent pairing stays BUDGETED (round-2 property held)', () => {
  // One added line excuses at most one removed line, even when several removals normalize to it.
  const removedRaw = new Set(['    return None', '        return None', '            return None']);
  const addedRaw = new Set(['  return None']);
  const trimmed = new Set(['return None']);
  const { net, reformatted } = netRemovedLines(trimmed, trimmed, { removedRaw, addedRaw });
  assert.equal(reformatted, 1, 'the single added line excuses exactly one of the three');
  assert.deepEqual([...net], ['return None'], 'the rest stay net-removed');
});

test('plan 3394 class 2b — diffLineSets carries raw bodies beside the trimmed ones', () => {
  const diff = [
    'diff --git a/f.tsx b/f.tsx',
    '--- a/f.tsx',
    '+++ b/f.tsx',
    '@@ -5 +5 @@',
    '-    const value = compute();',
    '+      const value = compute();',
    '',
  ].join('\n');
  const entry = diffLineSets(diff).get('f.tsx');
  assert.deepEqual([...entry.removed], ['const value = compute();'], 'trimmed set is unchanged');
  assert.deepEqual([...entry.removedRaw], ['    const value = compute();']);
  assert.deepEqual([...entry.addedRaw], ['      const value = compute();']);
});

test('plan 3394 class 2b — a <Fragment> wrap that re-indents a block is NOT a reversion (3321)', () => {
  const dir = initFixtureRepo();
  try {
    mkdirSync(join(dir, 'frontend/src/components'), { recursive: true });
    // 40 distinct body lines — comfortably over MIN_ATTRIBUTED_LINES (25), so a failure to pair
    // them off is a real exit-32 halt and not a floor artifact.
    const body = Array.from(
      { length: 40 },
      (_, i) => `        <td className="cell-${i}">{band.value${i}}</td>`,
    );
    const before = [
      "import { Fragment } from 'react';",
      '',
      'export function BandRows({ bands }) {',
      '  return bands.map((band) => (',
      '      <tr',
      '        key={band.serviceSlug}',
      '        className="band-row">',
      ...body,
      '      </tr>',
      '  ));',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'frontend/src/components/PrisindexTable.tsx'), 'export {};\n');
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'frontend/src/components/PrisindexTable.tsx'), before);
    const masterTip = commit(dir, '2728: land the per-band price rows');

    checkout(dir, '-b', 'worktree-9394-App-cheapest-rows', masterTip);
    // The plan-3321 shape exactly: wrap in <Fragment>, which re-indents every body line by two
    // spaces (prettier owns that), collapse the multi-line <tr> open tag, and move `key` up to
    // the new parent. Nothing is deleted — the whole block survives, re-indented.
    const after = [
      "import { Fragment } from 'react';",
      '',
      'export function BandRows({ bands }) {',
      '  return bands.map((band) => (',
      '      <Fragment key={band.serviceSlug}>',
      '        <tr className="band-row">',
      ...body.map((l) => `  ${l}`),
      '        </tr>',
      '        <CheapestRow band={band} />',
      '      </Fragment>',
      '  ));',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'frontend/src/components/PrisindexTable.tsx'), after);
    commit(dir, '9394: interleave the per-city cheapest-clinic row');

    assert.deepEqual(
      detectLandedReversion(dir, {
        masterRef: masterTip,
        branchRef: 'worktree-9394-App-cheapest-rows',
      }),
      [],
      'a <Fragment> wrap re-indents the block; every line is still there',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLASS 3 — single-owner relocation. Firings 2855 (inline strings moved into a new
// lib_incomplete_reasons.py — the gate named SEVEN plans as reverted while every removed string
// existed in the new module) and 2892 (a function moved to its owner module, re-exported; 55 of
// 71 "dropped" lines reappear verbatim elsewhere in the branch diff).
//
// The plan's item 4 scopes this to REPORTING ONLY, and its Bounds forbid a content-similarity
// release (plan 3210's measured disproof, operator ruling R1). So the halt must STAND and the
// --explain table must simply become readable: before this change every relocated line printed
// "(no successor)" because survivors were read from the dropped line's own file alone.
// ---------------------------------------------------------------------------
test('plan 3246 class 3 — --explain names the file a relocated line moved TO (2855/2892)', () => {
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'owner.py'), BODY);
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'owner.py'), BODY + landedBlock(1111));
    const masterTip = commit(dir, '1111: land plan 1111 reason strings inline in owner.py');

    checkout(dir, '-b', 'worktree-9008-Pipe-relocate', masterTip);
    writeFileSync(join(dir, 'owner.py'), BODY + 'from lib_reasons import *  # relocated\n');
    writeFileSync(join(dir, 'lib_reasons.py'), landedBlock(1111));
    commit(dir, '9008: move the reason strings into their own module');

    const findings = detectLandedReversion(dir, {
      masterRef: masterTip,
      branchRef: 'worktree-9008-Pipe-relocate',
    });
    assert.equal(
      findings.length,
      1,
      'REPORTING ONLY — a relocation is still a halt; R1 forbids a content-based release',
    );

    const explained = explainDroppedLines(dir, 'owner.py', {
      masterRef: masterTip,
      branchRef: 'worktree-9008-Pipe-relocate',
    });
    assert.ok(explained.pairs.length > 0);
    assert.ok(
      explained.pairs.every((p) => p.successorPath === 'lib_reasons.py'),
      'every dropped line is shown as relocated, not as vanished',
    );
    assert.ok(explained.pairs.every((p) => p.successor === p.dropped));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan 3246 class 3 — a line that is genuinely gone still reports NO successor', () => {
  // The counterpart: --explain must not manufacture a successor for a real deletion, or the
  // table it feeds the R1 reviewer would argue for release on every finding.
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'owner.py'), BODY);
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'owner.py'), BODY + landedBlock(1111));
    const masterTip = commit(dir, '1111: land plan 1111 helper block on owner.py');

    checkout(dir, '-b', 'worktree-9010-Infra-delete', masterTip);
    writeFileSync(join(dir, 'owner.py'), BODY);
    commit(dir, '9010: drop the block outright, replacing it with nothing');

    const explained = explainDroppedLines(dir, 'owner.py', {
      masterRef: masterTip,
      branchRef: 'worktree-9010-Infra-delete',
    });
    assert.ok(explained.pairs.length > 0);
    assert.ok(
      explained.pairs.every((p) => p.successorPath === null),
      'nothing was relocated, so nothing may be reported as relocated',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The plan's third acceptance criterion, stated directly.
// ---------------------------------------------------------------------------
test('plan 3246 acceptance — a commit whose first-parent patch for the file is EMPTY is never named', () => {
  // A merge that changed nothing in the candidate file contributes no added lines for it, so it
  // can claim none of the removals and cannot reach the refusal text. Asserted at the unit seam
  // so the property is pinned independently of which git flags produce the history.
  const removed = new Set(['def real_line_one(): pass', 'def real_line_two(): pass']);
  const history = [
    {
      sha: 'mmm',
      subject: "Merge branch 'worktree-2404-Pipe-thing'",
      added: new Set(),
      fileCreation: false,
    },
    {
      sha: 'aaa',
      subject: '1111: land the real lines',
      added: new Set([...removed]),
      fileCreation: false,
    },
  ];
  const { plans } = attributeRemovals(removed, history);
  assert.deepEqual(
    plans.map((p) => p.id),
    ['1111'],
  );
  const reason = reversionPreflightReason([
    { path: 'shared.py', removedLines: 2, attributed: 2, plans },
  ]);
  assert.doesNotMatch(reason, /2404/);
});

// --- plan 3246 round-1 review fixes -----------------------------------------------------------

test('plan 3246 review fix — an EXACT literal duplicate is never excused as a reformat', () => {
  // The round-1 CONFIRMED false-negative: testing membership modulo whitespace ALONE excluded a
  // removed line whenever any added line in the file carried the same text, duplicate boilerplate
  // included. Enough coincidences on a genuine revert could push it under MIN_ATTRIBUTED_LINES
  // and suppress the finding. An exact match now keeps the pre-3246 count verbatim.
  const { net, reformatted } = netRemovedLines(
    new Set(['except Exception:', 'return None', 'def deleted_helper(): pass']),
    new Set(['except Exception:', 'return None', 'def brand_new_helper(): pass']),
  );
  assert.equal(reformatted, 0, 'identical text on both sides is not a reformat');
  assert.equal(net.size, 3, 'every removed line still counts toward the floor');
});

test('plan 3246 review fix — a genuine revert full of duplicated boilerplate still HALTS', () => {
  // The end-to-end shape of the finding above: a real stale-copy restore whose dropped block is
  // padded with lines the same land also adds elsewhere in the file. The filter must not let
  // that fall under the floor.
  const dir = initFixtureRepo();
  try {
    const boiler = Array.from({ length: 30 }, () => 'except Exception:  # boilerplate').join('\n');
    writeFileSync(join(dir, 'shared.py'), BODY);
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'shared.py'), BODY + landedBlock(1111) + boiler + '\n');
    const masterTip = commit(dir, '1111: land plan 1111 block plus its boilerplate');

    // the branch stale-restores, dropping all of it, while adding new code that re-uses the
    // very same boilerplate line.
    checkout(dir, '-b', 'worktree-9011-Infra-restore', masterTip);
    // reuse `boiler` — the test's premise is that the two sides are byte-identical, so a second
    // independently-typed copy could silently desync and quietly weaken the case (review round 2)
    writeFileSync(join(dir, 'shared.py'), BODY + 'def fresh(): pass\n' + boiler + '\n');
    commit(dir, '9011: stale-restore shared.py');

    const findings = detectLandedReversion(dir, {
      masterRef: masterTip,
      branchRef: 'worktree-9011-Infra-restore',
    });
    assert.equal(findings.length, 1, 'the genuine revert must still be caught');
    assert.deepEqual(
      findings[0].plans.map((p) => p.id),
      ['1111'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan 3246 review fix — --explain applies the same CLASS-2 filter the halt applies', () => {
  // The round-1 CONFIRMED disagreement: --explain re-derived its table from the RAW removed set,
  // so on a land that both re-pads and reverts, the table the R1 reviewer reads listed the
  // re-padded rows as extra dropped lines the finding itself never counted.
  const dir = initFixtureRepo();
  try {
    const padded = Array.from(
      { length: 30 },
      (_, i) => `| row-${i + 1}   | value-${i + 1}   |`,
    ).join('\n');
    const repadded = Array.from({ length: 30 }, (_, i) => `| row-${i + 1} | value-${i + 1} |`).join(
      '\n',
    );
    writeFileSync(join(dir, 'mixed.md'), 'intro\n');
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'mixed.md'), 'intro\n' + padded + '\n' + landedBlock(1111));
    const masterTip = commit(dir, '1111: land the padded table and plan 1111 block');

    checkout(dir, '-b', 'worktree-9012-Infra-mixed', masterTip);
    // re-pad the table (not a removal) AND genuinely drop plan 1111's block (a removal)
    writeFileSync(join(dir, 'mixed.md'), 'intro\n' + repadded + '\n');
    commit(dir, '9012: re-pad the table and drop the block');

    const explained = explainDroppedLines(dir, 'mixed.md', {
      masterRef: masterTip,
      branchRef: 'worktree-9012-Infra-mixed',
    });
    assert.ok(explained.pairs.length > 0, 'the genuine drop is still explained');
    assert.ok(
      explained.pairs.every((p) => !p.dropped.startsWith('| row-')),
      'no re-padded table row appears as a dropped line',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan 3246 review fix — a plan that both created and modified a file is cited by its MODIFYING commit', () => {
  // Pins the (corrected) citation rule the round-1 review questioned: the modification is where
  // the content was authored; a creation only re-placed it.
  const removed = new Set(['authored_line_one', 'authored_line_two']);
  const history = [
    {
      sha: 'ccc',
      subject: '6666: recreate the module file',
      added: new Set([...removed]),
      fileCreation: true,
    },
    {
      sha: 'mmm',
      subject: '6666: author the lines',
      added: new Set([...removed]),
      fileCreation: false,
    },
  ];
  const { plans } = attributeRemovals(removed, history);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].sha, 'mmm', 'the modifying commit is the citation, not the re-creation');
});

// --- plan 3246 round-2 review fixes -----------------------------------------------------------

test('plan 3246 review fix — reformat matching is PAIRED: one added line excuses at most one removal', () => {
  // Round-2 CONFIRMED: plain Set membership let a SINGLE added line excuse ANY number of removed
  // lines normalizing to it. Two genuine removals differing only in indentation were both
  // excused by one unrelated reformat — and near-duplicate short statements are everywhere in
  // real code, so a real revert could still slip under MIN_ATTRIBUTED_LINES.
  const { net, reformatted } = netRemovedLines(
    new Set(['    return None', '        return None', '\t\treturn None']),
    new Set(['  return None']), // exactly ONE added line normalizes to "return None"
  );
  assert.equal(reformatted, 1, 'the single added line excuses exactly one removal, not three');
  assert.equal(net.size, 2, 'the other two removals still count toward the floor');
});

test('plan 3246 review fix — pairing still excuses a full table re-pad (budget scales with the added rows)', () => {
  // The other direction: pairing must not weaken CLASS 2, where every re-padded row has its own
  // added counterpart, so the budget covers all of them.
  const rows = Array.from({ length: 40 }, (_, i) => i + 1);
  const { net, reformatted } = netRemovedLines(
    new Set(rows.map((i) => `| row-${i}   | value-${i}   |`)),
    new Set(rows.map((i) => `| row-${i} | value-${i} |`)),
  );
  assert.equal(reformatted, 40);
  assert.equal(net.size, 0);
});

test('plan 3246 review fix — a real revert padded with NEAR-duplicate lines still HALTS', () => {
  // The end-to-end shape of the round-2 finding, reaching the budget path through the REAL
  // diffLineSets -> netRemovedLines pipeline.
  //
  // Round-3 review finding (CONFIRMED) on the first cut of this test: `diffLineSets` TRIMS each
  // line before it enters the set, so lines differing only by INDENTATION collapse to one entry
  // and the fixture never reached the multiplicity logic at all — it landed on the round-1
  // exact-match branch instead, and would have kept passing if the budget were reverted to plain
  // Set membership. Multiplicity survives trimming only through INTERNAL whitespace, so that is
  // what this builds: 30 lines that are pairwise distinct after trim yet all normalize to the
  // same text, against a single added line that normalizes to it too.
  const variants = Array.from(
    { length: 30 },
    (_, i) => `val${' '.repeat(i + 2)}=${' '.repeat(i + 2)}compute(1)`,
  );
  assert.equal(new Set(variants.map((l) => l.trim())).size, 30, 'distinct after trim');
  assert.equal(new Set(variants.map(normalizeWhitespace)).size, 1, '…but one normalized form');
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'shared.py'), BODY);
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'shared.py'), BODY + variants.join('\n') + '\n');
    const masterTip = commit(dir, '1111: land plan 1111 spaced assignments');

    // the branch drops all 30, adding back exactly ONE line that normalizes the same way
    checkout(dir, '-b', 'worktree-9013-Infra-restore', masterTip);
    writeFileSync(join(dir, 'shared.py'), BODY + 'val = compute(1)\n');
    commit(dir, '9013: stale-restore shared.py');

    const findings = detectLandedReversion(dir, {
      masterRef: masterTip,
      branchRef: 'worktree-9013-Infra-restore',
    });
    assert.equal(
      findings.length,
      1,
      'one near-duplicate added line must not excuse thirty removals',
    );
    assert.deepEqual(
      findings[0].plans.map((p) => p.id),
      ['1111'],
    );
    // Exactly one removal is excused (the budget the single added line provides); the other 29
    // still count. Under the reverted Set semantics all 30 would be excused and there would be
    // no finding at all — which is what makes this an end-to-end pin on the budget rather than a
    // restatement of the exact-match branch.
    assert.equal(findings[0].reformatted, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan 3246 review fix — --explain resolves a RENAME the way the halt does', () => {
  // Round-2 CONFIRMED: detectLandedReversion walks history under `oldPath || path`, but
  // --explain walked the CURRENT name, so on a land that renames a file AND reverts lines
  // authored under its old name it printed "no dropped attributed line found" for a halt that
  // was real and correctly attributed — telling the R1 reviewer the opposite of the truth.
  const dir = initFixtureRepo();
  try {
    writeFileSync(join(dir, 'old_name.py'), BODY);
    commit(dir, 'base');
    checkout(dir, '-b', 'masterbr');
    writeFileSync(join(dir, 'old_name.py'), BODY + landedBlock(1111));
    const masterTip = commit(dir, '1111: land plan 1111 helper block under the OLD name');

    // the branch renames the file AND drops the block
    checkout(dir, '-b', 'worktree-9014-Infra-rename', masterTip);
    rmSync(join(dir, 'old_name.py'));
    writeFileSync(join(dir, 'new_name.py'), BODY);
    commit(dir, '9014: rename the module and drop the block');

    const findings = detectLandedReversion(dir, {
      masterRef: masterTip,
      branchRef: 'worktree-9014-Infra-rename',
    });
    assert.equal(findings.length, 1, 'the halt itself already handled the rename');
    assert.deepEqual(
      findings[0].plans.map((p) => p.id),
      ['1111'],
    );

    const explained = explainDroppedLines(dir, findings[0].path, {
      masterRef: masterTip,
      branchRef: 'worktree-9014-Infra-rename',
    });
    assert.ok(
      explained.pairs.length > 0,
      '--explain must attribute the same dropped lines the halt named, not report none',
    );
    assert.ok(explained.pairs.every((p) => p.planId === '1111'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
