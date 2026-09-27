// scripts/review-fix-brief.test.mjs (plan 3545 T2)
// Justification: review-fix-brief.mjs is a genuinely new module; this is its name-paired test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReviewFixBrief, toRepoRelative, writeBriefOutput } from './review-fix-brief.mjs';

const SCRIPT = fileURLToPath(new URL('./review-fix-brief.mjs', import.meta.url));

const MUST_FIX = {
  key: 'must-fix',
  file: 'scripts/widget.mjs',
  line: 42,
  summary: 'the widget drops a required value',
  verdict: 'CONFIRMED',
  preExisting: false,
  blocksLand: true,
  blocksLandWhy: 'the changed writer corrupts its persisted contract',
};

const ADVISORY = {
  key: 'advisory-secret-that-must-not-leak',
  file: 'scripts/advisory.mjs',
  line: 7,
  summary: 'advisory-secret-summary-that-must-not-leak',
  verdict: 'CONFIRMED',
  preExisting: true,
  preExistingWhy: 'the behaviour predates this branch',
  blocksLand: false,
  blocksLandWhy: 'warning text only',
  disposition: {
    type: 'deferred-by-tag',
    preExisting: true,
    blocksLand: false,
    reason: 'warning-only residual cost',
  },
};

test('brief contains only must-fix findings, existing paired tests, and all four fix rules', () => {
  // The root is a temp tree this test owns: the paired-test probe is a real filesystem check, so
  // pinning it on the checkout's own layout made the test pass or fail by where it was run from.
  const root = mkdtempSync(join(tmpdir(), 'review-fix-brief-scope-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'review-fix-brief.mjs'), '');
  writeFileSync(join(root, 'scripts', 'review-fix-brief.test.mjs'), '');
  const brief = renderReviewFixBrief(
    '3545-SOL-review-fix-brief',
    {
      findings: [
        {
          ...MUST_FIX,
          file: 'scripts/review-fix-brief.mjs',
          evidence: 'the writer drops the persisted value',
        },
        { ...ADVISORY, disposition: undefined },
      ],
    },
    { root },
  );
  rmSync(root, { recursive: true, force: true });

  assert.match(brief, /^## SCOPE — DO NOT EXCEED/m);
  assert.match(brief, /scripts\/review-fix-brief\.mjs/);
  assert.match(brief, /scripts\/review-fix-brief\.test\.mjs/);
  assert.doesNotMatch(brief, /scripts\/advisory\.mjs/);
  assert.match(brief, /the widget drops a required value/);
  assert.match(brief, /the writer drops the persisted value/);
  assert.doesNotMatch(brief, /advisory-secret/);
  assert.match(brief, /failing test first, and confirm it FAILS on the pre-fix code;/);
  assert.match(brief, /smallest change.*lowest-debt.*canonical helper.*local copy.*delete.*patch/i);
  assert.match(
    brief,
    /if the fix needs a new mechanism \(a new lock, cache, parser, comparison algebra, retry loop\) or grows the touched file by more than ~40 lines, STOP and report `SIMPLIFY: <what to delete instead>` — do not build it;/,
  );
  assert.match(
    brief,
    /if the finding is about a mechanism the previous round added, prefer DELETING that mechanism over patching it\./,
  );
  // plan 4078 T2 — the two checklist rules aimed at the two recurring round-2+ regression shapes
  // (a fix landed at one call site and left a sibling; an over-correction that broke the case the
  // pre-fix code handled correctly). Both must be in the emitted brief.
  assert.match(
    brief,
    /sibling-site sweep: before writing the fix, list every OTHER call site of the function you are changing and every other place the same pattern appears/,
  );
  assert.match(
    brief,
    /a fix that lands at one site and leaves a sibling is the single most common regression the next round finds/,
  );
  assert.match(
    brief,
    /keep-the-old-case test: alongside the failing-test-first test for the flagged input, add \(or point at\) one test for the case the pre-fix code handled CORRECTLY/,
  );
  assert.match(brief, /so an over-correction turns red instead of shipping/);
  // plan 3944: a review-FIX round is the same shape as the plan-execution dispatch that plan 3858
  // caught reporting green off a hand-picked test subset, so the brief carries the selector rule
  // too. Both output shapes must be spelled out — a `FULL` verdict prints NO filenames, so a rule
  // that only said "run every file it prints" would read as "run nothing" on the exact change
  // (a widely-reached shared helper) where narrowing is most dangerous.
  assert.match(brief, /_select_tests\.py --changed-file/);
  assert.match(brief, /`SUBSET <n> test files` means run every file it lists/);
  assert.match(brief, /`FULL <reason>` means you may not narrow by judgment/);
  assert.match(brief, /queued-run\.mjs/, 'a FULL verdict must route through the heavy-run queue');
  assert.match(
    brief,
    /green is therefore unverified/,
    'the escape hatch is SAYING you did not run it, never a silent green',
  );
  assert.match(
    brief,
    /`scripts\/\*\*` `\.mjs` module has no such selector/,
    'the JS side has no import-closure selector and must not be implied to be covered',
  );
});

test('the paired-test probe resolves against the given root, not the process cwd', () => {
  // Findings carry repo-relative paths. Resolving the probe against process.cwd() made every
  // paired test look absent whenever the tool ran from anywhere but the repo root, silently
  // narrowing the brief's own allowlist.
  const root = mkdtempSync(join(tmpdir(), 'review-fix-brief-root-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'review-fix-brief-other-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'widget.mjs'), '');
  writeFileSync(join(root, 'scripts', 'widget.test.mjs'), '');
  const record = { findings: [MUST_FIX] };

  assert.match(renderReviewFixBrief('slug', record, { root }), /scripts\/widget\.test\.mjs/);
  assert.doesNotMatch(
    renderReviewFixBrief('slug', record, { root: elsewhere }),
    /scripts\/widget\.test\.mjs/,
  );

  rmSync(root, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

test('the paired-test probe includes existing TypeScript sibling tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-fix-brief-typescript-'));
  mkdirSync(join(root, 'backend', 'src'), { recursive: true });
  writeFileSync(join(root, 'backend', 'src', 'widget.ts'), '');
  writeFileSync(join(root, 'backend', 'src', 'widget.test.ts'), '');

  const brief = renderReviewFixBrief(
    'slug',
    { findings: [{ ...MUST_FIX, file: 'backend/src/widget.ts' }] },
    { root },
  );

  assert.match(brief, /backend\/src\/widget\.test\.ts/);
  rmSync(root, { recursive: true, force: true });
});

test('scope does not invent a paired test file when none exists', () => {
  const brief = renderReviewFixBrief('3545-SOL-review-fix-brief', { findings: [MUST_FIX] });
  assert.match(brief, /No existing paired test file was found/);
  assert.doesNotMatch(brief, /scripts\/widget\.test\.mjs/);
});

test('must-fix findings are deduplicated by identity and use real evidence with an explicit legacy fallback', () => {
  const brief = renderReviewFixBrief('3545-SOL-review-fix-brief', {
    findings: [
      { ...MUST_FIX, evidence: 'first adjudicator proof' },
      { ...MUST_FIX, key: 'different-raw-key', summary: 'a second report at the same location' },
      { ...MUST_FIX, file: 'scripts/other.mjs', line: 9, blocksLandWhy: 'tag boilerplate' },
    ],
  });

  assert.equal((brief.match(/scripts\/widget\.mjs:42/g) || []).length, 2);
  assert.match(brief, /a second report at the same location/);
  assert.match(brief, /Adjudicator evidence: first adjudicator proof/);
  assert.match(
    brief,
    /Adjudicator evidence: \(legacy record: adjudicator evidence was not recorded\)/,
  );
  assert.doesNotMatch(brief, /Adjudicator evidence: tag boilerplate/);
});

test('only semantically settled canonical dispositions remove a finding from the must-fix set', () => {
  const settled = [
    { type: 'fixed' },
    { type: 'wontfix', reason: 'accepted residual risk' },
    { type: 'plan', planId: '9999' },
    {
      type: 'deferred-by-tag',
      preExisting: true,
      blocksLand: false,
      reason: 'tagged advisory',
    },
  ].map((disposition, index) => ({
    ...MUST_FIX,
    file: `scripts/settled-${index}.mjs`,
    disposition,
  }));
  const malformed = {
    ...MUST_FIX,
    file: 'scripts/malformed.mjs',
    disposition: { type: 'wontfix', reason: '' },
  };

  const brief = renderReviewFixBrief(
    '3545-SOL-review-fix-brief',
    { findings: [...settled, malformed] },
    { planExists: (id) => id === '9999' },
  );
  assert.match(brief, /scripts\/malformed\.mjs/);
  assert.match(brief, /scripts\/settled-3\.mjs/);
  for (let index = 0; index < 3; index += 1) {
    assert.doesNotMatch(brief, new RegExp(`scripts/settled-${index}\\.mjs`));
  }
});

test('E1: canonical classification keeps semantically open dispositions in the brief', () => {
  const brief = renderReviewFixBrief('3545-SOL-review-fix-brief', {
    findings: [
      {
        ...MUST_FIX,
        file: 'scripts/deferred-must-fix.mjs',
        disposition: {
          type: 'deferred-by-tag',
          preExisting: false,
          blocksLand: true,
          reason: 'cannot defer a must-fix finding',
        },
      },
      {
        ...MUST_FIX,
        file: 'scripts/dangling-plan.mjs',
        disposition: { type: 'plan', planId: '999999' },
      },
    ],
  });

  assert.match(brief, /scripts\/deferred-must-fix\.mjs/);
  assert.match(brief, /scripts\/dangling-plan\.mjs/);
});

function routedSidecarRepo(slug, sidecarRecord) {
  const dir = mkdtempSync(join(tmpdir(), 'review-fix-brief-routed-'));
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git(['init', '-q', '-b', 'master']);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'fixture']);
  writeFileSync(
    join(dir, 'coord.config.json'),
    JSON.stringify({ handoffLayout: 'sessions', handoffDir: 'docs/handoff' }),
  );
  const session = join(dir, 'docs', 'handoff', 'sessions', '2026-01-01-fixture.md');
  mkdirSync(dirname(session), { recursive: true });
  writeFileSync(session, `# fixture\n\n**Branch:** \`worktree-${slug}\`\n`);
  const sidecar = session.replace(/\.md$/, '.findings.json');
  writeFileSync(sidecar, JSON.stringify(sidecarRecord));
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture']);
  git(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
  rmSync(sidecar);
  return dir;
}

// ─── Round-2 findings :646, :173, :171 — three ways main() could reach the WRONG sidecar ───

// plan 3623 item 4: review-fix-brief is the FOURTH consumer of the must-fix partition, found by
// sweeping every caller of isMustFixFinding / classifyFinding rather than fixing only the reported
// one. The old `!isMustFixFinding(f) || classifyFinding(f) === 'ok'` filter carried the same bug
// item 4 fixed in findingsGate: an ADVISORY finding whose `plan` disposition names a plan that
// does NOT exist still halts the land (referential integrity is not a severity question), but was
// skipped here — so the brief reported no fix round was owed for work the land refuses to pass.
test('an ADVISORY finding whose plan reference dangles still earns a fix round', () => {
  const dangling = {
    ...ADVISORY,
    key: 'advisory-dangling',
    file: 'scripts/advisory-dangling.mjs',
    summary: 'an advisory finding routed to a plan that does not exist',
    disposition: { type: 'plan', planId: '999999' },
  };
  const brief = renderReviewFixBrief(
    '3623-Infra-review-tag-contract-consumers',
    { findings: [dangling] },
    { planExists: () => false },
  );
  assert.doesNotMatch(brief, /must-fix set is empty/);
  assert.match(brief, /scripts\/advisory-dangling\.mjs/);
  // …and it drops back out once the plan it names actually exists.
  const routed = renderReviewFixBrief(
    '3623-Infra-review-tag-contract-consumers',
    { findings: [dangling] },
    { planExists: (id) => id === '999999' },
  );
  assert.doesNotMatch(routed, /scripts\/advisory-dangling\.mjs/);
});

// plan 3623 round-4 findings 28f6b1 / f467bb / 2122f2 / 1d8018 / 83cf67: the file list is an
// AUTHORIZATION, so containment is checked there rather than trusted from the finding. Note this
// is deliberately NOT toRepoRelative's job — that helper returns an unresolvable path unchanged on
// purpose (plan 3624), which is right for the finding text and wrong for the allowlist.
for (const [label, claimed] of [
  ['escapes the repository', '../../outside.mjs'],
  ['is a foreign-host absolute path', 'C:\\elsewhere\\secret.mjs'],
]) {
  test(`a finding whose path ${label} is named but never allowlisted`, () => {
    const root = mkdtempSync(join(tmpdir(), 'review-fix-brief-contain-'));
    try {
      const brief = renderReviewFixBrief(
        '3623-Infra-review-tag-contract-consumers',
        { findings: [{ ...MUST_FIX, file: claimed }] },
        { root },
      );
      assert.ok(brief.includes(claimed), 'the finding itself must still name its file');
      assert.ok(
        !brief.includes('- `' + claimed + '`'),
        'an uncontained path must never appear as a MAY-modify allowlist entry',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('a symlink pointing out of the checkout is not allowlisted', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'review-fix-brief-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'review-fix-brief-outside-'));
  try {
    writeFileSync(join(outside, 'secret.mjs'), '');
    try {
      symlinkSync(join(outside, 'secret.mjs'), join(root, 'escape.mjs'), 'file');
    } catch {
      // Symlink creation needs a privilege this host may not grant; the rule is asserted wherever
      // the shape can be built, and the platform itself is never the assertion.
      t.skip('symlink creation not permitted here');
      return;
    }
    const brief = renderReviewFixBrief(
      '3623-Infra-review-tag-contract-consumers',
      { findings: [{ ...MUST_FIX, file: 'escape.mjs' }] },
      { root },
    );
    assert.ok(!brief.includes('- `escape.mjs`'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// plan 3657 review (findings cbb528 / ccea64), both the same class as the drive-letter hole
// above: containment must refuse what it cannot resolve, on every host, and must not be
// satisfied merely because a path does not exist YET.

test('a Windows UNC path is named but never allowlisted', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-fix-brief-unc-'));
  const claimed = '\\\\server\\share\\secret.mjs';
  try {
    const brief = renderReviewFixBrief(
      '3623-Infra-review-tag-contract-consumers',
      { findings: [{ ...MUST_FIX, file: claimed }] },
      { root },
    );
    assert.ok(brief.includes(claimed), 'the finding itself must still name its file');
    assert.ok(
      !brief.includes('- `' + claimed + '`'),
      'a UNC path is rooted on its writing host and unresolvable here — never a MAY-modify entry',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a not-yet-written file BENEATH an escaping symlink is not allowlisted', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'review-fix-brief-linkdir-'));
  const outside = mkdtempSync(join(tmpdir(), 'review-fix-brief-outsidedir-'));
  try {
    try {
      symlinkSync(outside, join(root, 'escape'), 'dir');
    } catch {
      t.skip('symlink creation not permitted here');
      return;
    }
    // The file does not exist, so realpath() on it throws and the pre-fix code fell back to
    // the un-resolved lexical path — which sits under `root` and passed. The ESCAPE is the
    // directory link, and it is resolvable right now.
    const brief = renderReviewFixBrief(
      '3623-Infra-review-tag-contract-consumers',
      { findings: [{ ...MUST_FIX, file: 'escape/not-yet-written.mjs' }] },
      { root },
    );
    assert.ok(
      !brief.includes('- `escape/not-yet-written.mjs`'),
      'a path whose nearest existing ancestor resolves outside the checkout must be refused',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('an ordinary repo-relative path is still allowlisted, present or not yet written', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-fix-brief-ok-'));
  try {
    const brief = renderReviewFixBrief(
      '3623-Infra-review-tag-contract-consumers',
      { findings: [{ ...MUST_FIX, file: 'scripts/not-yet-written.mjs' }] },
      { root },
    );
    assert.ok(brief.includes('- `scripts/not-yet-written.mjs`'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a sidecar stamped for another plan is REFUSED, not merged (round 2, finding :646)', () => {
  // The write path has refused this since plan 2838; the read path did not, so another plan's
  // dispositions could be merged in and silently suppress a matching finding of ours.
  const slug = '3545-SOL-owner-check';
  const dir = routedSidecarRepo(slug, {
    slug: '9999-SOME-other-plan',
    rounds: 1,
    findings: [MUST_FIX],
  });
  try {
    const result = spawnSync(process.execPath, [SCRIPT, slug, '--round', '1'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /REFUSED/);
    assert.match(result.stderr, /9999-SOME-other-plan/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresher working-tree sidecar beats a stale origin one (round 2, finding :173)', () => {
  // readSidecarForSlug only prefers the record matching HEAD when it is TOLD what HEAD is.
  // Without headSha it falls through to first-parseable, which is origin/master.
  const slug = '3545-SOL-freshness';
  const dir = routedSidecarRepo(slug, {
    slug,
    sha: 'stale00000000000000000000000000000000000',
    rounds: 1,
    findings: [{ ...MUST_FIX, disposition: { type: 'wontfix', reason: 'stale origin decision' } }],
  });
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const sidecar = join(dir, 'docs', 'handoff', 'sessions', '2026-01-01-fixture.findings.json');
  writeFileSync(
    sidecar,
    JSON.stringify({ slug, sha: head, rounds: 2, findings: [{ ...MUST_FIX }] }),
  );
  try {
    const result = spawnSync(process.execPath, [SCRIPT, slug, '--round', '1'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    // The fresh record leaves the finding undispositioned, so it must still be briefed.
    assert.match(result.stdout, /## Must-fix findings/);
    assert.doesNotMatch(result.stdout, /must-fix set is empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repository discovery ignores an inherited GIT_DIR (round 2, finding :171)', () => {
  // `git rev-parse --show-toplevel` with no -C and no env isolation resolves whatever GIT_DIR
  // points at, so a launcher's exported GIT_DIR silently swapped which repo the tool read.
  // Since round 2, finding :171, repoRoot() strips the repo selectors; the coord spine's shared
  // git() helper now does too. An ambient GIT_DIR therefore redirects neither repository
  // discovery nor the sidecar lookup: the tool reads OUR checkout, not the foreign one.
  const slug = '3545-SOL-ambient-git';
  const dir = routedSidecarRepo(slug, { slug, rounds: 1, findings: [MUST_FIX] });
  const foreign = routedSidecarRepo('9999-FOREIGN-checkout', {
    slug: '9999-FOREIGN-checkout',
    rounds: 1,
    findings: [],
  });
  try {
    const result = spawnSync(process.execPath, [SCRIPT, slug, '--round', '1'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_DIR: join(foreign, '.git'), GIT_WORK_TREE: foreign },
    });
    const said = result.stdout + result.stderr;
    assert.equal(result.status, 0, result.stderr);
    // A briefed must-fix can only originate from dir: foreign was built with no findings, so
    // this positively proves repository discovery resolved our own checkout.
    assert.match(result.stdout, /## Must-fix findings/);
    assert.ok(!said.includes(foreign), `the foreign checkout leaked into: ${said}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test('an inherited GIT_DIR does not redirect the sidecar lookup either (plan 3586)', () => {
  const slug = '3545-SOL-ambient-git-full';
  const dir = routedSidecarRepo(slug, { slug, rounds: 1, findings: [MUST_FIX] });
  const foreign = routedSidecarRepo('9999-FOREIGN-checkout', {
    slug: '9999-FOREIGN-checkout',
    rounds: 1,
    findings: [],
  });
  try {
    const result = spawnSync(process.execPath, [SCRIPT, slug, '--round', '1'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_DIR: join(foreign, '.git'), GIT_WORK_TREE: foreign },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /## Must-fix findings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test('exact dogfood command finds a normally routed sidecar on origin/master', () => {
  const slug = '3545-SOL-Infra-review-must-fix-tags-and-fresh-context-fix-rounds';
  const dir = routedSidecarRepo(slug, { rounds: 1, findings: [MUST_FIX] });
  try {
    const result = spawnSync(process.execPath, [SCRIPT, slug, '--round', '1'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /## Must-fix findings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prior decisions merge by canonical finding identity, not stored raw key', () => {
  const slug = '3545-SOL-canonical-identity';
  const dir = routedSidecarRepo(slug, {
    rounds: 1,
    findings: [
      {
        ...MUST_FIX,
        key: 'old-raw-key',
        disposition: { type: 'wontfix', reason: 'accepted decision' },
      },
    ],
  });
  const roundDir = join(dir, 'round-2');
  mkdirSync(roundDir);
  writeFileSync(
    join(roundDir, 'findings.json'),
    JSON.stringify([{ ...MUST_FIX, key: 'new-raw-key', disposition: undefined }]),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, slug, '--round', '2', '--round-dir', roundDir],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /must-fix set is empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E1b: prior carry preserves decisions only and never overwrites an explicit reopen', () => {
  const slug = '3545-SOL-decision-only-carry';
  const fixed = { ...MUST_FIX, file: 'scripts/fixed-regression.mjs' };
  const planned = { ...MUST_FIX, file: 'scripts/planned-regression.mjs' };
  const reopened = { ...MUST_FIX, file: 'scripts/explicitly-reopened.mjs' };
  const decided = { ...MUST_FIX, file: 'scripts/accepted-decision.mjs' };
  const dir = routedSidecarRepo(slug, {
    rounds: 1,
    findings: [
      { ...fixed, disposition: { type: 'fixed' } },
      { ...planned, disposition: { type: 'plan', planId: '3545' } },
      { ...reopened, disposition: { type: 'wontfix', reason: 'old decision' } },
      { ...decided, disposition: { type: 'wontfix', reason: 'accepted residual risk' } },
    ],
  });
  const roundDir = join(dir, 'round-2');
  mkdirSync(roundDir);
  writeFileSync(
    join(roundDir, 'findings.json'),
    JSON.stringify([fixed, planned, { ...reopened, disposition: null }, decided]),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, slug, '--round', '2', '--round-dir', roundDir],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /scripts\/fixed-regression\.mjs/);
    assert.match(result.stdout, /scripts\/planned-regression\.mjs/);
    assert.match(result.stdout, /scripts\/explicitly-reopened\.mjs/);
    assert.doesNotMatch(result.stdout, /scripts\/accepted-decision\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E2: canonical finding identity keeps distinct defects at one location', () => {
  const brief = renderReviewFixBrief('3545-SOL-review-fix-brief', {
    findings: [
      { ...MUST_FIX, summary: 'first defect at the shared line' },
      { ...MUST_FIX, summary: 'second defect at the shared line' },
      { ...MUST_FIX, key: 'duplicate-raw-key', summary: 'first defect at the shared line' },
    ],
  });

  assert.equal((brief.match(/scripts\/widget\.mjs:42/g) || []).length, 2);
  assert.match(brief, /first defect at the shared line/);
  assert.match(brief, /second defect at the shared line/);
});

test('E3: malformed entries are listed as un-briefable — never a synthetic fix target — and Python paired tests use repo naming (plan 3624, findings 1u4tyh9/vul15p/1nt2873)', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-fix-brief-malformed-'));
  mkdirSync(join(root, 'backend', 'scripts', '__tests__'), { recursive: true });
  writeFileSync(join(root, 'backend', 'scripts', '__tests__', 'test_foo.py'), '');
  try {
    let brief;
    assert.doesNotThrow(() => {
      brief = renderReviewFixBrief(
        '3545-SOL-review-fix-brief',
        {
          findings: [
            null,
            'broken entry',
            { summary: 'object with no usable file' },
            // vul15p: a file WITH no summary is just as un-briefable as no file at all.
            { file: 'scripts/no-summary.mjs' },
            { ...MUST_FIX, file: 'backend/scripts/foo.py' },
          ],
        },
        { root },
      );
    });
    assert.match(brief, /## Cannot brief — fix the sidecar/);
    assert.match(brief, /malformed finding entry at index 0/);
    assert.match(brief, /malformed finding entry at index 1/);
    assert.match(brief, /malformed finding entry at index 2/);
    assert.match(brief, /malformed finding entry at index 3/);
    assert.match(brief, /backend\/scripts\/__tests__\/test_foo\.py/);
    // None of the malformed entries became a fix target: no placeholder path in the allowlist,
    // and the real defect's file is the only entry under "Files you MAY modify".
    assert.doesNotMatch(brief, /\(malformed finding\)/);
    assert.ok(!brief.includes('- `scripts/no-summary.mjs`'));
    assert.equal((brief.match(/^- `/gm) || []).length, 2);
    // plan 3623: the malformed entry's own path IS named, in the Cannot-brief section — it is the
    // only lead for repairing the sidecar, and it was previously dropped on the floor by
    // done-worktree-lib's malformed shape, leaving "at index 3" and nothing to act on. Naming it
    // there is not the same as making it a fix target, which the allowlist assertions above pin.
    assert.match(brief, /malformed finding entry at index 3.*scripts\/no-summary\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D: an entirely-malformed findings set is reported as un-briefable, not as a clean empty must-fix set', () => {
  const brief = renderReviewFixBrief('3624-SOL-cannot-brief-only', {
    findings: [ADVISORY, { file: 'scripts/no-summary.mjs' }, null],
  });
  assert.match(brief, /the must-fix set is empty/);
  assert.match(brief, /## Cannot brief — fix the sidecar/);
  assert.match(brief, /1\. malformed finding entry at index 1/);
  assert.match(brief, /2\. malformed finding entry at index 2/);
  assert.doesNotMatch(brief, /## SCOPE — DO NOT EXCEED/);
});

test('--sidecar rejects a shape-invalid findings record through the canonical parser', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-fix-brief-invalid-'));
  const sidecar = join(dir, 'invalid.findings.json');
  writeFileSync(sidecar, '[]');
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '3545-SOL-invalid-sidecar', '--round', '1', '--sidecar', sidecar],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /invalid findings record/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prior dispositions include wontfix and deferred-by-tag reasons', () => {
  const brief = renderReviewFixBrief('3545-SOL-review-fix-brief', {
    findings: [
      MUST_FIX,
      ADVISORY,
      {
        key: 'wontfix-prior',
        file: 'scripts/old.mjs',
        summary: 'old issue',
        disposition: { type: 'wontfix', reason: 'outside the accepted risk class' },
      },
    ],
  });

  assert.match(brief, /— wontfix: outside the accepted risk class/);
  assert.match(brief, /— deferred-by-tag: warning-only residual cost/);
});

test('empty must-fix set says no fix round is owed and emits no worker brief', () => {
  const output = renderReviewFixBrief('3545-SOL-review-fix-brief', { findings: [ADVISORY] });
  assert.equal(
    output,
    'No fix round is owed for 3545-SOL-review-fix-brief: the must-fix set is empty.\n',
  );
  assert.doesNotMatch(output, /## Must-fix findings/);
});

test('--out writes the rendered brief to a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-fix-brief-'));
  const sidecar = join(dir, 'round.findings.json');
  const out = join(dir, 'review-fix-brief.md');
  try {
    writeFileSync(sidecar, JSON.stringify({ rounds: 2, findings: [MUST_FIX] }));
    writeBriefOutput(
      renderReviewFixBrief('3545-SOL-review-fix-brief', JSON.parse(readFileSync(sidecar))),
      out,
    );
    assert.match(readFileSync(out, 'utf8'), /## SCOPE — DO NOT EXCEED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 4078 fix round 2 (gpt-review keys 72590e/594a32): the T1 fix-brief denial tells the operator
// to run this tool with `--out <the slug-keyed default>`, and that directory does not necessarily
// exist yet — a plan whose review artifacts were never written, or a cleaned .scratch, has no such
// folder. A bare writeFileSync would ENOENT there, so the denial's own remedy would fail and leave
// the launch denied with nothing produced. The parent is created instead.
test('--out creates the parent directory when it does not exist (plan 4078 fix round 2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-fix-brief-mkdir-'));
  const sidecar = join(dir, 'round.findings.json');
  // Two levels that do not exist yet — exactly the shape of .scratch/gpt-review/<slug>/.
  const out = join(dir, 'gpt-review', '4078-SOL-fix-brief', 'review-fix-brief.md');
  try {
    writeFileSync(sidecar, JSON.stringify({ rounds: 2, findings: [MUST_FIX] }));
    writeBriefOutput(
      renderReviewFixBrief('4078-SOL-fix-brief', JSON.parse(readFileSync(sidecar))),
      out,
    );
    assert.match(readFileSync(out, 'utf8'), /## SCOPE — DO NOT EXCEED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── plan 3624: default-path layout + loud fallback + failure_scenario + abs paths + HEAD plans ───

test('C: must-fix findings carry their failure_scenario, with an explicit legacy fallback (finding 1va0d5e)', () => {
  const brief = renderReviewFixBrief('3624-SOL-failure-scenario', {
    findings: [
      { ...MUST_FIX, failure_scenario: 'call foo(null) and observe an unhandled TypeError' },
      { ...MUST_FIX, file: 'scripts/legacy.mjs', line: 3 },
    ],
  });
  assert.match(brief, /Failure scenario: call foo\(null\) and observe an unhandled TypeError/);
  assert.match(brief, /Failure scenario: \(legacy record: failure scenario was not recorded\)/);
});

test('H: an absolute finding path is normalized to repo-relative before sibling-test resolution and in the file allowlist (finding 1mgghh8)', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-fix-brief-abspath-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'abspath-widget.mjs'), '');
  writeFileSync(join(root, 'scripts', 'abspath-widget.test.mjs'), '');
  let brief;
  try {
    brief = renderReviewFixBrief(
      '3624-SOL-abspath',
      { findings: [{ ...MUST_FIX, file: join(root, 'scripts', 'abspath-widget.mjs') }] },
      { root },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.match(brief, /scripts\/abspath-widget\.test\.mjs/);
  assert.match(brief, /- `scripts\/abspath-widget\.mjs`/);
  assert.doesNotMatch(brief, /- `\/.*abspath-widget\.mjs`/);
});

// `_path: win32` is injected here (the plan-2489 pattern, per
// scripts/assert-posix-path-assertions.mjs's own prescribed fix for a platform-specific branch)
// rather than faking process.platform: node:path's `relative()` only returns backslash-separated
// segments on win32, and injecting the module directly exercises that real shape from any host —
// Linux cloud drains included — instead of a fake that would only "work" on the platform that
// already had the right symbols.
test('toRepoRelative forward-slashes an absolute Windows path via the canonical normalizeRel, not a hand-rolled normalization (findings 102d50/c6c779/371bd7/48db1a)', () => {
  const rel = toRepoRelative(
    'C:\\Users\\vet\\repo',
    'C:\\Users\\vet\\repo\\backend\\src\\foo.ts',
    win32,
  );
  assert.equal(rel, 'backend/src/foo.ts');
  assert.doesNotMatch(rel, /\\/);
});

// plan 3624 round 3: the cross-host case (a Windows-absolute path read on a POSIX process, and
// the relative-backslash variant of it) that round 2 added here is deleted along with the
// mechanism in toRepoRelative that tried to handle it — see that function's own comment for why
// it cannot work in principle. What remains is the POSIX-native behavior below.
test('toRepoRelative leaves an already-relative POSIX path unchanged', () => {
  assert.equal(toRepoRelative('/repo', 'scripts/widget.mjs', posix), 'scripts/widget.mjs');
});

test('toRepoRelative leaves a path genuinely outside the repo root as-is, not mangled into ../..', () => {
  const outside = '/elsewhere/scripts/widget.mjs';
  assert.equal(toRepoRelative('/repo', outside, posix), outside);
});

// plan 3624 round 4 (findings 2f9984 / 24d9cc / 4bcadc / 632e9d): escaping the root is a SEGMENT
// property. A `startsWith('..')` prefix test also rejects an ordinary in-repo file whose name
// merely begins with two dots, leaving a host-absolute path in the brief and breaking both the
// paired-test lookup and the repo-relative allowlist for it.
test('toRepoRelative keeps an in-repo path whose first segment merely begins with ".." (findings 2f9984/24d9cc/4bcadc/632e9d)', () => {
  assert.equal(toRepoRelative('/repo', '/repo/..hidden/widget.ts', posix), '..hidden/widget.ts');
  assert.equal(toRepoRelative('/repo', '/repo/..cache.ts', posix), '..cache.ts');
});

test('toRepoRelative still treats a genuine parent-escape as outside the root', () => {
  const escaping = '/widget.ts'; // relative to /repo/nested this is ../../widget.ts
  assert.equal(toRepoRelative('/repo/nested', escaping, posix), escaping);
});

// plan 3624 round 4 (findings c0f9f4 / 3a58c5): the function's own comment promises a foreign-host
// absolute path is "left as-is". normalizeRel would instead rewrite C:\repo\x.mjs to C:/repo/x.mjs
// — a path that resolves no better and no longer matches what was recorded in the sidecar.
test('toRepoRelative preserves a foreign-host absolute path byte-identically (findings c0f9f4/3a58c5)', () => {
  const windowsPath = 'C:\\repo\\scripts\\foo.mjs';
  assert.equal(toRepoRelative('/repo', windowsPath, posix), windowsPath);
});

test("acceptance 1: the default path resolves against gpt-review's real flat --out layout, not a hand-built round-<n> directory", () => {
  const slug = '3624-SOL-flat-layout';
  const dir = mkdtempSync(join(tmpdir(), 'review-fix-brief-flatlayout-'));
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git(['init', '-q', '-b', 'master']);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'fixture']);
  writeFileSync(join(dir, 'placeholder.txt'), 'x\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  // scripts/gpt-review.mjs's own documented shape (its header comment at :3553): `--out
  // .scratch/gpt-review/<slug>`, flat, findings.json written directly inside it — no round-<n>
  // subdirectory. This is what the writer actually produces; the existing --round-dir tests in
  // this file (~line 370+) build the WRONG world (a hand-made round-N folder) instead.
  const outDir = join(dir, '.scratch', 'gpt-review', slug);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'findings.json'), JSON.stringify([MUST_FIX]));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, slug, '--round', '1'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /## Must-fix findings/);
    assert.match(result.stderr, /brief source: round artifact/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B: falling back to the routed sidecar announces the source out loud (finding 1yw98m2, acceptance bullet 2)', () => {
  const slug = '3624-SOL-loud-fallback';
  const dir = routedSidecarRepo(slug, { rounds: 1, findings: [MUST_FIX] });
  try {
    const result = spawnSync(process.execPath, [SCRIPT, slug, '--round', '1'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /brief source: routed session sidecar/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E: plan-disposition filtering also recognizes a plan minted on the reviewed HEAD, not just origin/master (finding 31x9yl)', () => {
  const slug = '3624-SOL-head-plan-check';
  const dir = mkdtempSync(join(tmpdir(), 'review-fix-brief-headplan-'));
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git(['init', '-q', '-b', 'master']);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'fixture']);
  writeFileSync(
    join(dir, 'coord.config.json'),
    JSON.stringify({ handoffLayout: 'sessions', handoffDir: 'docs/handoff' }),
  );
  const session = join(dir, 'docs', 'handoff', 'sessions', '2026-01-01-fixture.md');
  mkdirSync(dirname(session), { recursive: true });
  writeFileSync(session, `# fixture\n\n**Branch:** \`worktree-${slug}\`\n`);
  writeFileSync(
    session.replace(/\.md$/, '.findings.json'),
    JSON.stringify({
      rounds: 1,
      findings: [{ ...MUST_FIX, disposition: { type: 'plan', planId: '9101' } }],
    }),
  );
  // The plan is minted ON the branch under review, after this fixture commits — and
  // deliberately with NO refs/remotes/origin/master at all (a fresh clone / throwaway repo that
  // never fetched), same shape review-fix-brief.mjs's own "treat every plan as absent" comment
  // already names.
  const planPath = join(dir, 'docs', 'superpowers', 'plans', 'ready', '9101-Infra-example.md');
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, '# example\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture + plan 9101 minted on this branch']);
  try {
    const result = spawnSync(process.execPath, [SCRIPT, slug, '--round', '1'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /must-fix set is empty/,
      `expected the plan-9101 disposition to resolve via the reviewed HEAD, got: ${result.stdout}${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planIdsTreeText runs through the isolated git env, so an ambient GIT_DIR cannot redirect the plan-existence check to a foreign repository (finding 090415)', () => {
  // Driven through --sidecar (not --round) deliberately: the --round default path resolves the
  // session/sidecar through the coord spine's OWN git() helper, which has a separate, already-
  // known ambient-GIT_DIR leak of its own (see "an inherited GIT_DIR does not redirect the
  // sidecar lookup either (plan 3586)" above, skipped, owned by a different plan). --sidecar
  // skips that helper entirely, so this test isolates planIdsTreeText's OWN git call — the one
  // this fix actually touches — from that unrelated pre-existing leak.
  const slug = '3624-SOL-isolated-plantree-env';
  const dir = mkdtempSync(join(tmpdir(), 'review-fix-brief-isoenv-'));
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git(['init', '-q', '-b', 'master']);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'fixture']);
  const planPath = join(dir, 'docs', 'superpowers', 'plans', 'ready', '9101-Infra-example.md');
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, '# example\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'plan 9101 minted on this checkout']);

  const sidecar = join(dir, 'round.findings.json');
  writeFileSync(
    sidecar,
    JSON.stringify({
      rounds: 1,
      findings: [{ ...MUST_FIX, disposition: { type: 'plan', planId: '9101' } }],
    }),
  );

  // A REAL foreign git checkout (not a bogus path) — `-C root` alone does not protect against
  // this: git honors an ambient GIT_DIR/GIT_WORK_TREE over `-C`'s repo selection, so a naive git
  // call silently reads THIS other, unrelated repo's tree instead of erroring out.
  const foreign = mkdtempSync(join(tmpdir(), 'review-fix-brief-foreign-'));
  execFileSync('git', ['-C', foreign, 'init', '-q', '-b', 'master'], { encoding: 'utf8' });
  execFileSync('git', ['-C', foreign, 'config', 'user.email', 'fixture@example.test']);
  execFileSync('git', ['-C', foreign, 'config', 'user.name', 'fixture']);
  writeFileSync(join(foreign, 'placeholder.txt'), 'x\n');
  execFileSync('git', ['-C', foreign, 'add', '-A']);
  execFileSync('git', ['-C', foreign, 'commit', '-qm', 'unrelated foreign checkout']);
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, slug, '--round', '1', '--sidecar', sidecar],
      {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, GIT_DIR: join(foreign, '.git'), GIT_WORK_TREE: foreign },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /must-fix set is empty/,
      `expected the plan-9101 disposition to resolve despite an ambient GIT_DIR, got: ${result.stdout}${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test('mergePriorDispositions normalizes both sides before computing identity — a wontfix recorded with an ABSOLUTE path still carries onto the same finding recorded relative (findings 94a23c/b9994a)', () => {
  const slug = '3624-SOL-abs-carry';
  const dir = mkdtempSync(join(tmpdir(), 'review-fix-brief-abscarry-'));
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git(['init', '-q', '-b', 'master']);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'fixture']);
  writeFileSync(
    join(dir, 'coord.config.json'),
    JSON.stringify({ handoffLayout: 'sessions', handoffDir: 'docs/handoff' }),
  );
  const session = join(dir, 'docs', 'handoff', 'sessions', '2026-01-01-fixture.md');
  mkdirSync(dirname(session), { recursive: true });
  writeFileSync(session, `# fixture\n\n**Branch:** \`worktree-${slug}\`\n`);
  const sidecar = session.replace(/\.md$/, '.findings.json');
  writeFileSync(
    sidecar,
    JSON.stringify({
      rounds: 1,
      findings: [
        {
          ...MUST_FIX,
          file: join(dir, 'scripts', 'abs-carry.mjs'),
          disposition: { type: 'wontfix', reason: 'accepted decision' },
        },
      ],
    }),
  );
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture']);
  git(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
  rmSync(sidecar);

  const roundDir = join(dir, 'round-2');
  mkdirSync(roundDir);
  writeFileSync(
    join(roundDir, 'findings.json'),
    JSON.stringify([{ ...MUST_FIX, file: 'scripts/abs-carry.mjs' }]),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, slug, '--round', '2', '--round-dir', roundDir],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /must-fix set is empty/, result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F: --sidecar applies the same same-plan ownership check as the default path (finding hdosru)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-fix-brief-sidecar-owner-'));
  const sidecar = join(dir, 'foreign.findings.json');
  writeFileSync(
    sidecar,
    JSON.stringify({ slug: '9999-SOME-other-plan', rounds: 1, findings: [MUST_FIX] }),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '3624-SOL-sidecar-owner', '--round', '1', '--sidecar', sidecar],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /REFUSED/);
    assert.match(result.stderr, /9999-SOME-other-plan/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--sidecar announces its brief source too, not only the default path (finding 7ecc67)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-fix-brief-sidecar-source-'));
  const sidecar = join(dir, 'round.findings.json');
  writeFileSync(sidecar, JSON.stringify({ rounds: 1, findings: [MUST_FIX] }));
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '3624-SOL-sidecar-source', '--round', '1', '--sidecar', sidecar],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /review-fix-brief: brief source:/);
    assert.match(result.stderr, new RegExp(sidecar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 3657 review round 2 (findings c839b3 / 0c85d2 / be4c02): the same class again — an
// authorization must refuse what it cannot resolve, and must not answer a LEXICAL question
// where the filesystem asks a different one.

test('a DANGLING escaping symlink is not allowlisted', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'review-fix-brief-dangling-'));
  try {
    try {
      symlinkSync(
        join(tmpdir(), 'review-fix-brief-does-not-exist-at-all'),
        join(root, 'escape'),
        'dir',
      );
    } catch {
      t.skip('symlink creation not permitted here');
      return;
    }
    // realpath() throws on the link itself (its target is absent), so walking up past it would
    // reach `root` and wrongly report containment.
    const brief = renderReviewFixBrief(
      '3623-Infra-review-tag-contract-consumers',
      { findings: [{ ...MUST_FIX, file: 'escape/x.mjs' }] },
      { root },
    );
    assert.ok(!brief.includes('- `escape/x.mjs`'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a path with a .. segment is refused even when it lexically stays inside', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-fix-brief-dotdot-'));
  try {
    const brief = renderReviewFixBrief(
      '3623-Infra-review-tag-contract-consumers',
      { findings: [{ ...MUST_FIX, file: 'scripts/../scripts/x.mjs' }] },
      { root },
    );
    assert.ok(
      !brief.includes('- `scripts/../scripts/x.mjs`'),
      'resolve() collapses .. lexically; through a symlink the filesystem would not agree',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bare Windows root-relative path is named but never allowlisted', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-fix-brief-rootrel-'));
  const claimed = '\\Windows\\System32\\drivers\\etc\\hosts';
  try {
    const brief = renderReviewFixBrief(
      '3623-Infra-review-tag-contract-consumers',
      { findings: [{ ...MUST_FIX, file: claimed }] },
      { root },
    );
    assert.ok(brief.includes(claimed), 'preserved verbatim in the finding text');
    assert.ok(!brief.includes('- `' + claimed + '`'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
