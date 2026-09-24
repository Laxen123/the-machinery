// name-pair of a genuinely new module
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AT_CAP_ROUND,
  FIX_BRIEF_EXEMPT_CHANGED_LINES,
  PAST_CAP_EXITS,
  REVIEW_LEVELS,
  SANCTIONED_DELTA_ROUNDS,
  capDenialMessage,
  effectiveLaunchFloor,
  exitOfPastCapReason,
  fixBriefCandidates,
  fixBriefDenialMessage,
  fixBriefRequired,
  fixDeltaChangedLines,
  isPastCap,
  lastEscapeExit,
  ledgerEntryIdentityKey,
  pastCapEscapeDecision,
  planIdFromSlug,
  planSlugFromBranch,
  readConsecutiveEscapes,
  readLaunchCount,
  recordLaunch,
  resolveReviewTargetBranch,
  sanctionedDeltaRounds,
  reviewArtifactsDir,
  reviewFindingsPath,
  reviewFixBriefPath,
  reviewRoundsRef,
  validatePastCapReason,
} from './review-round-cap.mjs';
import { endRefOf } from './git-range.mjs';

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

for (const key of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
]) {
  delete process.env[key];
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'review-round-cap-'));
  const g = (...args) =>
    execFileSync(
      'git',
      [
        '-C',
        dir,
        '-c',
        'core.autocrlf=false',
        '-c',
        'user.name=Review Test',
        '-c',
        'user.email=review@test.invalid',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  g('init', '-q', '-b', 'master');
  return { dir, g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('launch count starts at zero and increments exactly once per recordLaunch', () => {
  const repo = makeRepo();
  try {
    assert.equal(readLaunchCount(repo.dir, '3527'), 0);
    assert.equal(recordLaunch(repo.dir, '3527', { branch: 'worktree-3527-SOL-cap' }), 1);
    assert.equal(readLaunchCount(repo.dir, '3527'), 1);
    assert.equal(recordLaunch(repo.dir, '3527', { branch: 'worktree-3527-SOL-cap' }), 2);
    assert.equal(readLaunchCount(repo.dir, '3527'), 2);
  } finally {
    repo.cleanup();
  }
});

test('the cap permits launch ordinals 1 through 4 and denies 5', () => {
  const repo = makeRepo();
  try {
    assert.equal(SANCTIONED_DELTA_ROUNDS, 3);
    assert.equal(AT_CAP_ROUND, 4);
    assert.equal(isPastCap(1), false);
    assert.equal(isPastCap(2), false);
    assert.equal(isPastCap(3), false);
    assert.equal(isPastCap(4), false);
    assert.equal(isPastCap(5), true);
    assert.equal(reviewRoundsRef('3527'), 'refs/review-rounds/3527');
    assert.equal(
      capDenialMessage({
        planId: '3527',
        launchOrdinal: 5,
        pastCapFlagName: '--past-cap',
      }),
      'review-round cap: denying launch 5 for plan 3527; local launch ledger: refs/review-rounds/3527.\n' +
        'At the cap, STOP reviewing and pick one, in this order:\n' +
        '1. Run it.\n' +
        '2. Simplify or delete the fragile construct\n' +
        '3. Park it\n' +
        'Escape only with --past-cap "<reason>".',
    );
  } finally {
    repo.cleanup();
  }
});

// plan 3967: `lane: fast` narrows the cap to round 1 alone (0 sanctioned delta rounds), while the
// DEFAULT lane (no lane arg, or `null`, or any non-`'fast'` value) is untouched — the whole point
// of the byte-identity acceptance criterion.
test('sanctionedDeltaRounds: 0 for the fast lane, the default constant for every other lane', () => {
  assert.equal(sanctionedDeltaRounds('fast'), 0);
  assert.equal(sanctionedDeltaRounds(null), SANCTIONED_DELTA_ROUNDS);
  assert.equal(sanctionedDeltaRounds(undefined), SANCTIONED_DELTA_ROUNDS);
  assert.equal(sanctionedDeltaRounds('slow'), SANCTIONED_DELTA_ROUNDS);
});

test('isPastCap: a fast-lane plan caps at round 1 — launch 2 is past cap, launch 1 is not', () => {
  assert.equal(isPastCap(1, 'fast'), false);
  assert.equal(isPastCap(2, 'fast'), true);
  // The default lane is BYTE-IDENTICAL whether or not the second argument is passed at all.
  assert.equal(isPastCap(4), false);
  assert.equal(isPastCap(4, null), false);
  assert.equal(isPastCap(5), true);
  assert.equal(isPastCap(5, null), true);
});

test('capDenialMessage: the default lane (no `lane`, or `null`) renders byte-identically to before plan 3967', () => {
  const withoutLane = capDenialMessage({
    planId: '3527',
    launchOrdinal: 5,
    pastCapFlagName: '--past-cap',
  });
  assert.equal(
    withoutLane,
    'review-round cap: denying launch 5 for plan 3527; local launch ledger: refs/review-rounds/3527.\n' +
      'At the cap, STOP reviewing and pick one, in this order:\n' +
      '1. Run it.\n' +
      '2. Simplify or delete the fragile construct\n' +
      '3. Park it\n' +
      'Escape only with --past-cap "<reason>".',
  );
  assert.equal(
    capDenialMessage({
      planId: '3527',
      launchOrdinal: 5,
      pastCapFlagName: '--past-cap',
      lane: null,
    }),
    withoutLane,
  );
});

test('capDenialMessage: a `lane: fast` denial names the lane and points at park-review-findings.mjs', () => {
  const message = capDenialMessage({
    planId: '3967',
    launchOrdinal: 2,
    pastCapFlagName: '--past-cap',
    lane: 'fast',
  });
  assert.match(message, /denying launch 2 for plan 3967/);
  assert.match(message, /plan 3967 is `lane: fast`: one review round/);
  assert.match(message, /scripts\/park-review-findings\.mjs/);
  assert.match(message, /At the cap, STOP reviewing/);
});

test('past-cap reason is preserved verbatim in the ref commit message', () => {
  const repo = makeRepo();
  try {
    const reason = 'land rebase added "new logic"\nkeep this second line exactly';
    recordLaunch(repo.dir, '3527', {
      branch: 'worktree-3527-SOL-cap',
      pastCapReason: reason,
    });
    const message = repo.g('log', '-1', '--format=%B', reviewRoundsRef('3527'));
    assert.ok(message.includes(reason));
  } finally {
    repo.cleanup();
  }
});

test('past-cap reasons name a sanctioned exit with a strict lowercase prefix', () => {
  assert.deepEqual(PAST_CAP_EXITS, ['run', 'simplify', 'park']);
  for (const reason of ['run: ship the verified change', 'park: await upstream']) {
    assert.deepEqual(validatePastCapReason(reason), { accepted: true, reason });
  }
  assert.deepEqual(validatePastCapReason(''), {
    accepted: false,
    message: '--past-cap requires a non-empty reason',
  });
  for (const reason of ['retry after rebase', 'Run: now', ' run: now', 'run now']) {
    const result = validatePastCapReason(reason);
    assert.equal(result.accepted, false);
    assert.match(result.message, /run, simplify, park/);
  }
  for (const reason of ['run:', 'simplify:   ', 'park:\t']) {
    assert.deepEqual(validatePastCapReason(reason), {
      accepted: false,
      message: '--past-cap reason must include non-empty text after the exit prefix',
    });
  }
});

test('an absent ledger can be seeded from an existing marker round floor', () => {
  const repo = makeRepo();
  try {
    assert.equal(
      recordLaunch(repo.dir, '3527', {
        branch: 'worktree-3527-SOL-cap',
        launchFloor: 4,
      }),
      5,
    );
    assert.equal(readLaunchCount(repo.dir, '3527'), 5);
  } finally {
    repo.cleanup();
  }
});

test('a huge marker floor seeds only to the cap and denies the next launch', () => {
  const repo = makeRepo();
  try {
    const ordinal = recordLaunch(repo.dir, '3527', {
      branch: 'worktree-3527-SOL-cap',
      launchFloor: 999,
    });
    assert.equal(ordinal, AT_CAP_ROUND + 1);
    assert.equal(isPastCap(ordinal), true);
    assert.equal(readLaunchCount(repo.dir, '3527'), AT_CAP_ROUND + 1);
    assert.equal(
      repo.g('rev-list', '--count', `${reviewRoundsRef('3527')}^`),
      String(AT_CAP_ROUND),
      'the marker migration must seed exactly the capped historical floor',
    );
  } finally {
    repo.cleanup();
  }
});

test('effectiveLaunchFloor clamps the marker and applies it over an existing ledger', () => {
  assert.equal(effectiveLaunchFloor(0, 0), 0);
  assert.equal(effectiveLaunchFloor(2, 4), 4);
  assert.equal(effectiveLaunchFloor(5, 4), 5);
  assert.equal(effectiveLaunchFloor(1, 999), AT_CAP_ROUND);
  assert.equal(effectiveLaunchFloor(-1, Number.NaN), 0);
});

test('a marker floor advances an existing ledger instead of being ignored', () => {
  const repo = makeRepo();
  try {
    assert.equal(recordLaunch(repo.dir, '3527', { branch: 'worktree-3527-SOL-cap' }), 1);
    assert.equal(
      recordLaunch(repo.dir, '3527', {
        branch: 'worktree-3527-SOL-cap',
        launchFloor: AT_CAP_ROUND,
      }),
      AT_CAP_ROUND + 1,
    );
    assert.equal(readLaunchCount(repo.dir, '3527'), AT_CAP_ROUND + 1);
  } finally {
    repo.cleanup();
  }
});

test('the local ref survives removing the worktree used to record the launch', () => {
  const repo = makeRepo();
  const worktree = join(repo.dir, 'launch-worktree');
  try {
    writeFileSync(join(repo.dir, 'initial.txt'), 'initial\n');
    repo.g('add', 'initial.txt');
    repo.g('commit', '-qm', 'initial');
    repo.g('worktree', 'add', '-q', '-b', 'worktree-3527-SOL-cap', worktree);
    recordLaunch(worktree, '3527', { branch: 'worktree-3527-SOL-cap' });
    repo.g('worktree', 'remove', '--force', worktree);
    assert.equal(existsSync(worktree), false);
    assert.equal(readLaunchCount(repo.dir, '3527'), 1);
  } finally {
    repo.cleanup();
  }
});

test('a compare-and-swap race retries without throwing or double-counting', () => {
  const repo = makeRepo();
  try {
    assert.equal(recordLaunch(repo.dir, '3527', { branch: 'worktree-3527-SOL-cap' }), 1);
    let raced = false;
    const ordinal = recordLaunch(repo.dir, '3527', {
      branch: 'worktree-3527-SOL-cap',
      _sleep: () => {},
      _beforeUpdate: ({ ref, oldSha }) => {
        if (raced) return;
        raced = true;
        assert.match(oldSha, /^[0-9a-f]{40}$/);
        const competitor = repo.g(
          'commit-tree',
          EMPTY_TREE_SHA,
          '-p',
          oldSha,
          '-m',
          'review-launch:2\nbranch:worktree-3527-SOL-racer',
        );
        repo.g('update-ref', ref, competitor, oldSha);
      },
    });
    assert.equal(raced, true);
    assert.equal(ordinal, 3);
    assert.equal(readLaunchCount(repo.dir, '3527'), 3);
  } finally {
    repo.cleanup();
  }
});

test('a compare-and-swap retry preserves the marker-derived floor', () => {
  const repo = makeRepo();
  try {
    let raced = false;
    const ordinal = recordLaunch(repo.dir, '3527', {
      branch: 'worktree-3527-SOL-cap',
      launchFloor: AT_CAP_ROUND,
      _sleep: () => {},
      _beforeUpdate: ({ ref, oldSha }) => {
        if (raced) return;
        raced = true;
        assert.equal(oldSha, null);
        const competitor = repo.g(
          'commit-tree',
          EMPTY_TREE_SHA,
          '-m',
          'review-launch:1\nbranch:worktree-3527-SOL-racer',
        );
        repo.g('update-ref', ref, competitor, '');
      },
    });
    assert.equal(raced, true);
    assert.equal(ordinal, AT_CAP_ROUND + 1);
    assert.equal(readLaunchCount(repo.dir, '3527'), AT_CAP_ROUND + 1);
  } finally {
    repo.cleanup();
  }
});

test('planIdFromSlug reads a worktree slug and rejects branch names', () => {
  const repo = makeRepo();
  try {
    assert.equal(planIdFromSlug('3527-SOL-Infra-gate-review-round-cap-at-launch'), '3527');
    assert.equal(planIdFromSlug('3527-1-example'), null);
    assert.equal(planIdFromSlug('12-ad-hoc'), null);
    assert.equal(planIdFromSlug('master'), null);
    assert.equal(planIdFromSlug('feature/review-cap'), null);
  } finally {
    repo.cleanup();
  }
});

test('planSlugFromBranch accepts only worktree and drain execution branches', () => {
  assert.equal(
    planSlugFromBranch('worktree-3527-SOL-Infra-gate-review-round-cap-at'),
    '3527-SOL-Infra-gate-review-round-cap-at',
  );
  assert.equal(
    planSlugFromBranch('claude/drain-3527-SOL-Infra-gate-review-round-cap-at'),
    '3527-SOL-Infra-gate-review-round-cap-at',
  );
  assert.equal(planSlugFromBranch('master'), null);
  assert.equal(planSlugFromBranch('feature/random'), null);
});

// plan 3624 (findings 1yw98m2 + m57y8f): the ONE owner of gpt-review.mjs's real (flat,
// slug-keyed) --out layout — both review-fix-brief.mjs's default artifact lookup and
// record-review.mjs's prior-round-brief check derive their path through these, never a
// hand-rolled join().
test('reviewArtifactsDir/reviewFindingsPath/reviewFixBriefPath: one flat, slug-keyed directory — no round-<n> level', () => {
  const repoRoot = '/repo';
  const slug = '3624-SOL-flat-layout';
  // Pinned RELATIVE to the root: the layout literal is asserted without joining it onto a
  // repo-root constant, which is the real-tree-read idiom select-battery-tests' guard scans for.
  // That guard reads raw source (comments included) and cannot tell this synthetic '/repo' from
  // the real checkout, so the idiom is avoided here rather than waived there — the root above is
  // a fixture and this suite never touches the real tree.
  assert.equal(
    relative(repoRoot, reviewArtifactsDir(repoRoot, slug)),
    join('.scratch', 'gpt-review', slug),
  );
  const expectedDir = reviewArtifactsDir(repoRoot, slug);
  assert.equal(reviewFindingsPath(repoRoot, slug), join(expectedDir, 'findings.json'));
  assert.equal(reviewFixBriefPath(repoRoot, slug), join(expectedDir, 'review-fix-brief.md'));
  // No round number anywhere in the derived paths — the writer never creates a per-round dir.
  for (const p of [
    reviewArtifactsDir(repoRoot, slug),
    reviewFindingsPath(repoRoot, slug),
    reviewFixBriefPath(repoRoot, slug),
  ]) {
    assert.doesNotMatch(p, /round-\d/);
  }
});

// ── plan 4078 T1: the fix brief becomes a gate from round 2 on, above a small-delta carve-out ──

test('FIX_BRIEF_EXEMPT_CHANGED_LINES is 10 (operator-pinned 2026-09-20)', () => {
  assert.equal(FIX_BRIEF_EXEMPT_CHANGED_LINES, 10);
});

test('fixBriefCandidates: reviewOutDir first (when supplied), then the slug-keyed default — the ONE resolver record-review.mjs also calls', () => {
  const repoRoot = '/repo';
  const slug = '4078-SOL-fix-brief';
  assert.deepEqual(fixBriefCandidates({ repoRoot, slug }), [reviewFixBriefPath(repoRoot, slug)]);
  // A reviewOutDir that genuinely DIFFERS from the slug-keyed default (an explicit --out the
  // caller pointed elsewhere) yields both, that one first. plan 4078 fix round 1 (key b81c28):
  // this case used to be written with the default dir itself, so it asserted the same path twice
  // — the duplicate the dedupe below removes.
  const reviewOutDir = '/repo/.scratch/gpt-review/some-other-out-dir';
  assert.deepEqual(fixBriefCandidates({ repoRoot, slug, reviewOutDir }), [
    join(reviewOutDir, 'review-fix-brief.md'),
    reviewFixBriefPath(repoRoot, slug),
  ]);
  // plan 4078 fix round 1 (gpt-review key b81c28): when the caller's own --out IS the slug-keyed
  // default — the documented convention, `--out .scratch/gpt-review/<slug>` — the two candidates
  // collapse to one path. Observed live on this very plan: the pre-launch warning printed
  // "checked <path> and <path>", the same file named twice. Dedupe at the resolver so every
  // consumer (both cap callers, record-review's warning, the denial message) gets it.
  const defaultDir = dirname(reviewFixBriefPath(repoRoot, slug));
  assert.deepEqual(fixBriefCandidates({ repoRoot, slug, reviewOutDir: defaultDir }), [
    reviewFixBriefPath(repoRoot, slug),
  ]);
});

test('fixDeltaChangedLines: sums added+deleted numstat rows via ONE git diff --numstat call, a binary row counts 0', () => {
  const calls = [];
  const runGitFn = (repoRoot, args) => {
    calls.push([repoRoot, args]);
    return '10\t5\tfile-a.ts\n-\t-\tbinary.png\n3\t2\tfile-b.ts\n';
  };
  assert.equal(fixDeltaChangedLines('/repo', 'sha1', 'sha2', { runGitFn }), 20);
  assert.deepEqual(calls, [['/repo', ['diff', '--numstat', 'sha1', 'sha2']]]);
});

test('fixDeltaChangedLines: a missing endpoint or a git failure fails OPEN (null), never throws — no real git', () => {
  assert.equal(fixDeltaChangedLines('/repo', null, 'sha2', { runGitFn: () => 'unused' }), null);
  assert.equal(fixDeltaChangedLines('/repo', 'sha1', null, { runGitFn: () => 'unused' }), null);
  assert.equal(
    fixDeltaChangedLines('/repo', 'sha1', 'sha2', {
      runGitFn: () => {
        throw new Error('git exploded');
      },
    }),
    null,
  );
});

test('fixBriefRequired: denies only round >= 2, above the carve-out, with no brief; fails open on a null changedLines', () => {
  assert.equal(fixBriefRequired({ launchOrdinal: 1, changedLines: 30, briefExists: false }), false);
  assert.equal(fixBriefRequired({ launchOrdinal: 2, changedLines: 10, briefExists: false }), false);
  assert.equal(fixBriefRequired({ launchOrdinal: 2, changedLines: 11, briefExists: false }), true);
  assert.equal(fixBriefRequired({ launchOrdinal: 3, changedLines: 30, briefExists: true }), false);
  assert.equal(
    fixBriefRequired({ launchOrdinal: 2, changedLines: null, briefExists: false }),
    false,
  );
  assert.equal(
    fixBriefRequired({ launchOrdinal: 2, changedLines: undefined, briefExists: false }),
    false,
  );
});

test('fixBriefDenialMessage: names the exact brief command, the checked candidates, and the carve-out size', () => {
  const message = fixBriefDenialMessage({
    planId: '4078',
    slug: '4078-SOL-fix-brief',
    launchOrdinal: 3,
    candidates: ['/repo/a/review-fix-brief.md', '/repo/b/review-fix-brief.md'],
  });
  assert.match(message, /denying launch 3 for plan 4078/);
  assert.match(message, /round 2's fix landed with no fresh-context brief/);
  assert.match(
    message,
    /checked \/repo\/a\/review-fix-brief\.md and \/repo\/b\/review-fix-brief\.md; none exist/,
  );
  assert.match(message, /node scripts\/review-fix-brief\.mjs 4078-SOL-fix-brief --round 2/);
  assert.match(message, /10 changed lines needs no brief/);
  // plan 4078 fix round 1 (gpt-review keys 5d5949/c4f482/fcab0e/ceae60/d5e623): the remedy command
  // must WRITE the brief to a path this gate actually checks. review-fix-brief.mjs prints to
  // stdout unless given `--out` (its own usage header: "`--out` overrides stdout"), so the bare
  // command the first cut printed left the denial standing no matter how many times you ran it —
  // the gate's own escape hatch did not clear the gate.
  //
  // fix round 2 (keys 9f2d74, and ff5efb/bb47f0/2b7c77/4de57a): the target is the LAST candidate —
  // the stable slug-keyed default — not the first. The caller's own `--out` can be a
  // timestamp-keyed directory, and a brief written THERE is invisible to the next launch, which
  // resolves a different timestamp; the slug-keyed path is the one every future launch checks. And
  // it is SHELL-QUOTED, because this string is printed for a human to paste and the repo's own
  // local checkout lives under `98 Hobby/` — an unquoted path with a space silently writes the
  // brief to the wrong file and leaves the denial standing.
  assert.match(message, /--out '\/repo\/b\/review-fix-brief\.md'/);
});

test('fixBriefDenialMessage: shell-quotes a path containing a space or a quote (plan 4078 fix round 2)', () => {
  const message = fixBriefDenialMessage({
    planId: '4078',
    slug: '4078-SOL-fix-brief',
    launchOrdinal: 2,
    candidates: ["/c/98 Hobby/vetapp/.scratch/o'brien/review-fix-brief.md"],
  });
  // POSIX single-quoting: the embedded ' closes, escapes, and reopens the quoted run.
  assert.match(
    message,
    /--out '\/c\/98 Hobby\/vetapp\/\.scratch\/o'\\''brien\/review-fix-brief\.md'/,
  );
});

// ─── plan 3618: consecutive-escape counting ────────────────────────────────────────────────

test('exitOfPastCapReason reads the sanctioned prefix and null for anything else', () => {
  assert.equal(exitOfPastCapReason('run: ship it'), 'run');
  assert.equal(exitOfPastCapReason('simplify: delete the seam'), 'simplify');
  assert.equal(exitOfPastCapReason('park: awaiting upstream'), 'park');
  assert.equal(exitOfPastCapReason('one more review'), null);
  assert.equal(exitOfPastCapReason(null), null);
  assert.equal(exitOfPastCapReason(undefined), null);
});

test('readConsecutiveEscapes counts only TRAILING escapes, never non-consecutive ones', () => {
  const repo = makeRepo();
  try {
    const branch = 'worktree-3527-SOL-cap';
    assert.equal(readConsecutiveEscapes(repo.dir, '3527'), 0, 'empty ledger');
    recordLaunch(repo.dir, '3527', { branch }); // round 1, clean
    assert.equal(readConsecutiveEscapes(repo.dir, '3527'), 0);
    recordLaunch(repo.dir, '3527', { branch, pastCapReason: 'run: first escape' }); // round 2
    assert.equal(readConsecutiveEscapes(repo.dir, '3527'), 1);
    recordLaunch(repo.dir, '3527', { branch, pastCapReason: 'run: second in a row' }); // round 3
    assert.equal(readConsecutiveEscapes(repo.dir, '3527'), 2);
    recordLaunch(repo.dir, '3527', { branch }); // round 4, clean — breaks the trailing streak
    assert.equal(readConsecutiveEscapes(repo.dir, '3527'), 0);
    // E3(a): a run: at round 5 with a clean round between must not resurrect the earlier streak.
    recordLaunch(repo.dir, '3527', { branch, pastCapReason: 'run: unrelated later escape' });
    assert.equal(readConsecutiveEscapes(repo.dir, '3527'), 1);
  } finally {
    repo.cleanup();
  }
});

test('lastEscapeExit reports the newest entry only, null on an empty or non-escaped ledger', () => {
  const repo = makeRepo();
  try {
    const branch = 'worktree-3527-SOL-cap';
    assert.equal(lastEscapeExit(repo.dir, '3527'), null, 'empty ledger');
    recordLaunch(repo.dir, '3527', { branch, pastCapReason: 'simplify: drop the fragile bit' });
    assert.equal(lastEscapeExit(repo.dir, '3527'), 'simplify');
    recordLaunch(repo.dir, '3527', { branch, pastCapReason: 'run: ship it' });
    assert.equal(lastEscapeExit(repo.dir, '3527'), 'run');
    recordLaunch(repo.dir, '3527', { branch });
    assert.equal(lastEscapeExit(repo.dir, '3527'), null, 'newest entry did not escape');
  } finally {
    repo.cleanup();
  }
});

test('pastCapEscapeDecision denies only a SECOND CONSECUTIVE run: escape past the cap', () => {
  // E3(b): the bound is ONE — a first-ever run: (no prior escape) is allowed.
  assert.equal(
    pastCapEscapeDecision({
      launchOrdinal: 5,
      pastCapReason: 'run: ship it',
      consecutiveEscapes: 0,
      lastExit: null,
    }),
    false,
  );
  // The deny case: a second run: right after a first one.
  assert.equal(
    pastCapEscapeDecision({
      launchOrdinal: 6,
      pastCapReason: 'run: keep going',
      consecutiveEscapes: 1,
      lastExit: 'run',
    }),
    true,
  );
  // E3(c): simplify: then run: is a DIFFERENT exit each time — allowed.
  assert.equal(
    pastCapEscapeDecision({
      launchOrdinal: 6,
      pastCapReason: 'run: ship it now',
      consecutiveEscapes: 1,
      lastExit: 'simplify',
    }),
    false,
  );
  // Never denies below the cap, regardless of the escape history.
  assert.equal(
    pastCapEscapeDecision({
      launchOrdinal: 3,
      pastCapReason: 'run: keep going',
      consecutiveEscapes: 1,
      lastExit: 'run',
    }),
    false,
  );
  // No escape reason at all (the pre-existing "denied, no --past-cap" case) is not this
  // predicate's concern — it never fires without an exit of 'run'.
  assert.equal(
    pastCapEscapeDecision({
      launchOrdinal: 6,
      pastCapReason: null,
      consecutiveEscapes: 1,
      lastExit: 'run',
    }),
    false,
  );
});

// ─── plan 3618, finding D2: the decision lives INSIDE recordLaunch's CAS loop ──────────────

test('recordLaunch: a second consecutive run: escape is denied WITHOUT writing to the ledger', () => {
  const repo = makeRepo();
  try {
    const branch = 'worktree-3527-SOL-cap';
    for (let i = 0; i < 4; i++) assert.equal(recordLaunch(repo.dir, '3527', { branch }), i + 1);
    assert.equal(
      recordLaunch(repo.dir, '3527', { branch, pastCapReason: 'run: first escape' }),
      5,
      'a first run: past the cap still returns a plain ordinal',
    );
    assert.equal(readLaunchCount(repo.dir, '3527'), 5);
    const denied = recordLaunch(repo.dir, '3527', {
      branch,
      pastCapReason: 'run: second in a row',
    });
    assert.deepEqual(denied, { denied: true, ordinal: 6, consecutiveEscapes: 2 });
    // The defect this closes: a denied attempt used to still append a ledger entry, inflating
    // the very count it was computed from. The ledger must be UNCHANGED after a denial.
    assert.equal(readLaunchCount(repo.dir, '3527'), 5, 'a denied attempt writes nothing');
    assert.equal(readConsecutiveEscapes(repo.dir, '3527'), 1, 'still just the one recorded escape');
    // Retrying with a DIFFERENT exit is allowed — the denial did not corrupt the ledger into
    // some inconsistent state that blocks every future launch.
    assert.equal(recordLaunch(repo.dir, '3527', { branch, pastCapReason: 'simplify: drop it' }), 6);
    assert.equal(readLaunchCount(repo.dir, '3527'), 6);
  } finally {
    repo.cleanup();
  }
});

// ─── plan 3967 fix round 1 (findings 8/9/10/13/14): the fast-lane cap must reach recordLaunch's
// own internal past-cap/consecutive-escape check, not just the outer isPastCap call sites ───

test('pastCapEscapeDecision: a lane:fast plan denies the SECOND consecutive run: escape at ITS cap (round 2), not the default cap', () => {
  // Below the fast cap (ordinal 1): never denies, regardless of escape history — mirrors the
  // default-lane "never denies below the cap" case already pinned above.
  assert.equal(
    pastCapEscapeDecision({
      launchOrdinal: 1,
      pastCapReason: 'run: keep going',
      consecutiveEscapes: 1,
      lastExit: 'run',
      lane: 'fast',
    }),
    false,
  );
  // A FIRST run: past the fast cap (ordinal 2, no prior escape) is allowed — same "bound is one"
  // rule as the default lane.
  assert.equal(
    pastCapEscapeDecision({
      launchOrdinal: 2,
      pastCapReason: 'run: first escape',
      consecutiveEscapes: 0,
      lastExit: null,
      lane: 'fast',
    }),
    false,
  );
  // A SECOND consecutive run: at ordinal 3 is denied for the fast lane — the default lane's
  // `isPastCap(3)` alone is false (3 <= AT_CAP_ROUND), which is exactly the gap the findings
  // named: without `lane` threaded through, this call would wrongly read as "not past cap yet".
  assert.equal(
    pastCapEscapeDecision({
      launchOrdinal: 3,
      pastCapReason: 'run: second in a row',
      consecutiveEscapes: 1,
      lastExit: 'run',
      lane: 'fast',
    }),
    true,
  );
  // The DEFAULT lane at the same ordinal 3 is untouched — still below its own (higher) cap.
  assert.equal(
    pastCapEscapeDecision({
      launchOrdinal: 3,
      pastCapReason: 'run: second in a row',
      consecutiveEscapes: 1,
      lastExit: 'run',
    }),
    false,
  );
});

test('recordLaunch: a lane:fast plan denies a second consecutive run: escape at round 3, WITHOUT writing to the ledger', () => {
  const repo = makeRepo();
  try {
    const branch = 'worktree-3967-SOL-fastlane';
    assert.equal(recordLaunch(repo.dir, '3967', { branch, lane: 'fast' }), 1, 'round 1, clean');
    assert.equal(
      recordLaunch(repo.dir, '3967', {
        branch,
        lane: 'fast',
        pastCapReason: 'run: first escape',
      }),
      2,
      'a first run: past the fast cap still returns a plain ordinal',
    );
    assert.equal(readLaunchCount(repo.dir, '3967'), 2);
    const denied = recordLaunch(repo.dir, '3967', {
      branch,
      lane: 'fast',
      pastCapReason: 'run: second in a row',
    });
    assert.deepEqual(
      denied,
      { denied: true, ordinal: 3, consecutiveEscapes: 2 },
      'the second consecutive run: escape must be denied at the FAST cap (round 2), not the ' +
        'default cap (round 4) — this is the exact defect findings 8/9/10/13/14 named',
    );
    assert.equal(readLaunchCount(repo.dir, '3967'), 2, 'a denied attempt writes nothing');
  } finally {
    repo.cleanup();
  }
});

// ─── plan 3757: key the round-cap ledger on the REVIEW IDENTITY, not on invocation count ───

test('recordLaunch: a resume with the SAME identityKey returns the existing ordinal and writes nothing new to the ledger', () => {
  const repo = makeRepo();
  try {
    const branch = 'worktree-3527-SOL-cap';
    const identityKey = 'deadbeefcafef00d';
    assert.equal(recordLaunch(repo.dir, '3527', { branch, identityKey }), 1);
    const shaAfterFirst = repo.g('rev-parse', reviewRoundsRef('3527'));
    assert.deepEqual(
      recordLaunch(repo.dir, '3527', { branch, identityKey }),
      { ordinal: 1, resumed: true, denied: false },
      'a same-identity resume must report the SAME ordinal, not a new one, and flag itself a resume',
    );
    assert.equal(
      repo.g('rev-parse', reviewRoundsRef('3527')),
      shaAfterFirst,
      'a same-identity resume must not append a ledger commit',
    );
    assert.equal(readLaunchCount(repo.dir, '3527'), 1);
  } finally {
    repo.cleanup();
  }
});

test('recordLaunch: a DIFFERENT identityKey still increments the ordinal exactly as today', () => {
  const repo = makeRepo();
  try {
    const branch = 'worktree-3527-SOL-cap';
    assert.equal(recordLaunch(repo.dir, '3527', { branch, identityKey: 'identity-A' }), 1);
    assert.equal(recordLaunch(repo.dir, '3527', { branch, identityKey: 'identity-B' }), 2);
    assert.equal(readLaunchCount(repo.dir, '3527'), 2);
  } finally {
    repo.cleanup();
  }
});

test('recordLaunch: an omitted identityKey behaves exactly as today — no review-identity line, ordinal increments every call', () => {
  const repo = makeRepo();
  try {
    const branch = 'worktree-3527-SOL-cap';
    assert.equal(recordLaunch(repo.dir, '3527', { branch }), 1);
    assert.equal(recordLaunch(repo.dir, '3527', { branch }), 2);
    const message = repo.g('log', '-1', '--format=%B', reviewRoundsRef('3527'));
    assert.ok(
      !message.includes('review-identity:'),
      'no identityKey supplied must mean no review-identity: line at all',
    );
  } finally {
    repo.cleanup();
  }
});

test('recordLaunch: four same-identity resumes do NOT reach the cap (the plan-3632 symptom)', () => {
  const repo = makeRepo();
  try {
    const branch = 'worktree-3527-SOL-cap';
    const identityKey = 'same-review-round';
    // The FIRST launch of this identity is round 1 — well within AT_CAP_ROUND.
    assert.equal(recordLaunch(repo.dir, '3527', { branch, identityKey }), 1);
    // Three more foreground calls resuming the EXACT same identity — before this fix, each of
    // these minted a NEW ledger entry (rounds 2, 3, 4), which is exactly what exhausted the cap
    // on plan 3632 before a single genuine re-review round ever ran.
    for (let i = 0; i < 3; i++) {
      const result = recordLaunch(repo.dir, '3527', { branch, identityKey });
      assert.equal(result.ordinal, 1, `resume #${i + 1} must stay at ordinal 1`);
      assert.equal(result.resumed, true);
      assert.equal(isPastCap(result.ordinal), false);
    }
    assert.equal(readLaunchCount(repo.dir, '3527'), 1);
  } finally {
    repo.cleanup();
  }
});

test('recordLaunch: a past-cap-reason body still parses correctly when a review-identity line is also present (ordering hazard)', () => {
  const repo = makeRepo();
  try {
    const branch = 'worktree-3527-SOL-cap';
    for (let i = 0; i < 4; i++) recordLaunch(repo.dir, '3527', { branch });
    const reason = 'run: ship the verified change';
    const identityKey = 'identity-with-escape';
    recordLaunch(repo.dir, '3527', { branch, identityKey, pastCapReason: reason });
    const message = repo.g('log', '-1', '--format=%B', reviewRoundsRef('3527'));
    assert.ok(message.includes(`review-identity:${identityKey}`));
    assert.ok(message.includes(`past-cap-reason:\n${reason}`));
    const identityLineIndex = message.indexOf('review-identity:');
    const reasonMarkerIndex = message.indexOf('past-cap-reason:');
    assert.ok(
      identityLineIndex !== -1 && identityLineIndex < reasonMarkerIndex,
      'review-identity: must sit BEFORE past-cap-reason: — placed after, it would be swallowed ' +
        'into the reason text instead of being read back as an identity',
    );
    // The real regression surface: ledgerEntryPastCapReason/escapeStateFromBodies must still read
    // the reason correctly (via readConsecutiveEscapes/lastEscapeExit) with the identity line
    // present ahead of it.
    assert.equal(readConsecutiveEscapes(repo.dir, '3527'), 1);
    assert.equal(lastEscapeExit(repo.dir, '3527'), 'run');
  } finally {
    repo.cleanup();
  }
});

// ─── plan 3757 fix round 1 (gpt-review keys 74676c/68a1c0/9c0b70, 624ddf/5b9a8e) ───

test('ledgerEntryIdentityKey: stops at the past-cap-reason marker and never reads identity out of the reason text', () => {
  // The reason text runs to the END of the body, so a reason whose own text happens to contain a
  // line starting `review-identity:` must NOT be read back as this entry's identity — otherwise
  // free-form operator prose decides whether a later launch counts as a resume of this round.
  const spoofed = [
    'review-launch:5',
    'branch:worktree-3527-SOL-cap',
    'launched-at:2026-09-06T00:00:00.000Z',
    'past-cap-reason:',
    'run: ship it',
    'review-identity:spoofed',
  ].join('\n');
  assert.equal(
    ledgerEntryIdentityKey(spoofed),
    null,
    'a review-identity: line INSIDE the past-cap reason text is reason prose, not an identity',
  );

  const genuine = [
    'review-launch:5',
    'branch:worktree-3527-SOL-cap',
    'launched-at:2026-09-06T00:00:00.000Z',
    'review-identity:realkey',
    'past-cap-reason:',
    'run: ship it',
    'review-identity:spoofed',
  ].join('\n');
  assert.equal(
    ledgerEntryIdentityKey(genuine),
    'realkey',
    'the identity written BEFORE the marker is the entry’s real identity',
  );

  assert.equal(ledgerEntryIdentityKey('review-launch:1\nbranch:b\nlaunched-at:t'), null);
});

test('recordLaunch: a same-identity resume still honours the marker-derived launch floor', () => {
  const repo = makeRepo();
  try {
    const branch = 'worktree-3527-SOL-cap';
    const identityKey = 'floored-identity';
    const first = recordLaunch(repo.dir, '3527', { branch, identityKey });
    assert.equal(first.ordinal ?? first, 1);
    // The migration floor says "treat the next launch as at least round 3". A resume must not
    // report a LOWER ordinal than the floor just because it reuses the existing round's slot —
    // that would let a resume silently un-apply the floor the marker exists to impose.
    const resumed = recordLaunch(repo.dir, '3527', { branch, identityKey, launchFloor: 3 });
    assert.equal(
      resumed.ordinal ?? resumed,
      3,
      'a same-identity resume reports the floor-adjusted ordinal, not the raw ledger count',
    );
    assert.equal(
      readLaunchCount(repo.dir, '3527'),
      1,
      'and still appends no ledger commit — it is the same round',
    );
  } finally {
    repo.cleanup();
  }
});

test('recordLaunch: a same-identity resume reports itself as a resume, so the caller can tell it apart from a fresh launch', () => {
  const repo = makeRepo();
  try {
    const branch = 'worktree-3527-SOL-cap';
    const identityKey = 'resume-flagged';
    const first = recordLaunch(repo.dir, '3527', { branch, identityKey });
    assert.equal(
      first,
      1,
      'the FIRST launch of an identity is an ordinary launch: a plain integer',
    );
    const resumed = recordLaunch(repo.dir, '3527', { branch, identityKey });
    assert.equal(typeof resumed, 'object');
    assert.equal(resumed.ordinal, 1);
    assert.equal(resumed.resumed, true);
    assert.equal(
      resumed.denied,
      false,
      'explicitly false: the pre-3757 readers treat "an object" as a denial positionally, so the ' +
        'resume shape must carry denied:false rather than rely on its absence',
    );
  } finally {
    repo.cleanup();
  }
});

test('capDenialMessage names the mode-switch rule only when consecutiveEscapes is passed', () => {
  const base = capDenialMessage({
    planId: '3527',
    launchOrdinal: 5,
    pastCapFlagName: '--past-cap',
  });
  assert.doesNotMatch(base, /mode-switch/);
  const consecutive = capDenialMessage({
    planId: '3527',
    launchOrdinal: 6,
    pastCapFlagName: '--past-cap',
    consecutiveEscapes: 2,
  });
  assert.match(consecutive, /past-cap escape #2 in the current streak/);
  assert.match(consecutive, /the last two in a row both named "run:"/);
  assert.match(consecutive, /mode-switch failure/);
  assert.match(consecutive, /Disposition the remainder/);
  assert.match(consecutive, /Park it/);
  assert.doesNotMatch(consecutive, /Escape only with/);
});

test('capDenialMessage: the count names a streak of ANY exit, never "N run: escapes" (finding 348c84)', () => {
  // park: then run: then run: — the denial fires on the second consecutive run:, but the
  // trailing streak is 3 escapes of mixed exits. The wording must not misstate that as "3 run:
  // escapes"; it must call out the run:/run: pair separately from the streak count.
  const message = capDenialMessage({
    planId: '3527',
    launchOrdinal: 7,
    pastCapFlagName: '--past-cap',
    consecutiveEscapes: 3,
  });
  assert.match(message, /past-cap escape #3 in the current streak/);
  assert.doesNotMatch(message, /3 run: escapes/);
  assert.doesNotMatch(message, /3 consecutive run:/);
  assert.match(message, /the last two in a row both named "run:"/);
});

// ─── plan 3618, addendum items A/B: shared review-target resolution ────────────────────────

test('endRefOf (the shared range parser, finding d6a14d) charges a range to its END ref, never the start', () => {
  assert.equal(endRefOf('worktree-1111-old..worktree-3527-target'), 'worktree-3527-target');
  assert.equal(endRefOf('worktree-1111-old...worktree-3527-target'), 'worktree-3527-target');
  assert.equal(endRefOf('worktree-3527-target'), 'worktree-3527-target', 'no range, unchanged');
  assert.equal(endRefOf(42), null, 'non-string tokens resolve to null');
  // finding d6a14d's exact regression case: a malformed trailing range used to leave the
  // pre-range text intact (charging the WRONG plan); endRefOf resolves it to HEAD instead,
  // which then correctly fails to name any plan.
  assert.equal(endRefOf('worktree-3527-target..'), 'HEAD');
});

test('resolveReviewTargetBranch: an explicit single-token or level+token target wins, range charged to its end ref', () => {
  const runGitFn = (_repoRoot, args) => (args[0] === 'rev-parse' ? '/repo' : 'master');
  assert.deepEqual(
    resolveReviewTargetBranch({ tokens: ['worktree-3545-example'], cwd: '/repo', runGitFn }),
    { status: 'explicit', branch: 'worktree-3545-example', path: null, repoRoot: '/repo' },
  );
  assert.deepEqual(
    resolveReviewTargetBranch({
      tokens: ['high', 'worktree-3545-example'],
      cwd: '/repo',
      runGitFn,
    }),
    { status: 'explicit', branch: 'worktree-3545-example', path: null, repoRoot: '/repo' },
  );
  assert.deepEqual(
    resolveReviewTargetBranch({
      tokens: ['worktree-1111-old...worktree-3527-target'],
      cwd: '/repo',
      runGitFn,
    }),
    { status: 'explicit', branch: 'worktree-3527-target', path: null, repoRoot: '/repo' },
    'the END ref wins, never the start (round-7 intent, kept as a test not a rejection)',
  );
  // finding d6a14d: a malformed trailing range no longer misfires onto plan 3527.
  assert.deepEqual(
    resolveReviewTargetBranch({
      tokens: ['worktree-3527-target..'],
      cwd: '/repo',
      runGitFn,
    }),
    { status: 'current', branch: 'master', path: '/repo', repoRoot: '/repo' },
  );
  assert.ok(REVIEW_LEVELS.has('high'), 'sanity: the level union used above is the real one');
});

test('resolveReviewTargetBranch: the Bash lane (allowSiblingHunt: false, the default) NEVER hunts, even from master with a sibling ahead — finding D1', () => {
  // This is a regression THIS plan's own first pass introduced: the sibling hunt must be
  // Workflow-scope-recovery only. Same mocked master-with-one-ahead-sibling shape as the
  // Workflow hunt test below, but WITHOUT allowSiblingHunt — must resolve to 'current'/'master'
  // (no plan), never guess the sibling.
  const repoRoot = '/repo';
  const porcelain =
    'worktree /repo\nHEAD abc\nbranch refs/heads/master\n\n' +
    'worktree /repo-wt-a\nHEAD def\nbranch refs/heads/worktree-3545-a\n\n';
  function runGitFn(_root, args) {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return repoRoot;
    if (args[0] === 'branch') return 'master';
    if (args[0] === 'rev-parse' && args[1] === '--verify') return 'deadbeef';
    if (args[0] === 'merge-base') return 'deadbeef';
    if (args[0] === 'worktree') return porcelain;
    if (args[0] === 'rev-list') return '3'; // the sibling IS genuinely ahead
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  }
  assert.deepEqual(resolveReviewTargetBranch({ tokens: [], cwd: repoRoot, runGitFn }), {
    status: 'current',
    branch: 'master',
    path: repoRoot,
    repoRoot,
  });
  // Explicit resolution (item B's real satisfier) still works without allowSiblingHunt — the
  // Bash lane's `--range`/`--end-ref` value.
  assert.deepEqual(
    resolveReviewTargetBranch({
      tokens: ['origin/master...worktree-3545-a'],
      cwd: repoRoot,
      runGitFn,
    }),
    { status: 'explicit', branch: 'worktree-3545-a', path: null, repoRoot },
  );
});

test('resolveReviewTargetBranch: no explicit token on a non-master branch is just the current branch', () => {
  const runGitFn = (_repoRoot, args) => (args[0] === 'rev-parse' ? '/repo' : 'worktree-3527-x');
  assert.deepEqual(
    resolveReviewTargetBranch({ tokens: [], cwd: '/repo', runGitFn, allowSiblingHunt: true }),
    {
      status: 'current',
      branch: 'worktree-3527-x',
      path: '/repo',
      repoRoot: '/repo',
    },
  );
  // A prose target that resolves to neither shape falls through the same way.
  assert.deepEqual(
    resolveReviewTargetBranch({
      tokens: ['xhigh', 'focus', 'on', 'x'],
      cwd: '/repo',
      runGitFn,
      allowSiblingHunt: true,
    }),
    { status: 'current', branch: 'worktree-3527-x', path: '/repo', repoRoot: '/repo' },
  );
});

test('resolveReviewTargetBranch: an unresolved free-form target on master does NOT trigger the sibling hunt — finding 7abd8c', () => {
  // "high only review scripts/foo.mjs" from master, with a sole sibling ahead: the real
  // Workflow routes this through its explicit-TARGET prompt branch (free-form instructions),
  // which never reaches the step-f hunt either. The resolver must agree: leftover multi-token
  // text after stripping a leading level is an UNRESOLVED target, not "no target at all".
  const repoRoot = '/repo';
  const porcelain =
    'worktree /repo\nHEAD abc\nbranch refs/heads/master\n\n' +
    'worktree /repo-wt-a\nHEAD def\nbranch refs/heads/worktree-3545-a\n\n';
  function runGitFn(_root, args) {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return repoRoot;
    if (args[0] === 'branch') return 'master';
    if (args[0] === 'rev-parse' && args[1] === '--verify') return 'deadbeef';
    if (args[0] === 'merge-base') return 'deadbeef';
    if (args[0] === 'worktree') return porcelain;
    if (args[0] === 'rev-list') return '3';
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  }
  assert.deepEqual(
    resolveReviewTargetBranch({
      tokens: ['high', 'only', 'review', 'scripts/foo.mjs'],
      cwd: repoRoot,
      runGitFn,
      allowSiblingHunt: true,
    }),
    { status: 'current', branch: 'master', path: repoRoot, repoRoot },
  );
});

test('resolveReviewTargetBranch: main checkout on master with no explicit token hunts sibling worktrees (allowSiblingHunt: true)', () => {
  const repoRoot = '/repo';
  const porcelain =
    'worktree /repo\nHEAD abc\nbranch refs/heads/master\n\n' +
    'worktree /repo-wt-a\nHEAD def\nbranch refs/heads/worktree-3545-a\n\n' +
    'worktree /repo-wt-b\nHEAD ghi\nbranch refs/heads/worktree-9999-b\n\n' +
    'worktree /repo-wt-c\nHEAD jkl\nbranch refs/heads/worktree-1234-stale\nprunable gone\n';
  // plan 3618 round 3 (findings bdd0d9 et al.): candidacy is now decided by a TREE DIFF
  // ('git diff --quiet <baseRef> <revSpec>' — 4 args), never a commit count. Only these
  // revSpecs carry a genuinely non-empty diff; the main checkout's own diff (revSpec 'HEAD')
  // stays clean, which is what lets the hunt run at all (finding 5475c1).
  const nonEmptyDiffRevSpecs = new Set(['worktree-3545-a', 'worktree-1234-stale']);
  function runGitFn(_root, args) {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return repoRoot;
    if (args[0] === 'branch') return 'master';
    if (args[0] === 'rev-parse' && args[1] === '--verify') return 'deadbeef'; // origin/master exists, resolves to this sha
    if (args[0] === 'merge-base') return 'deadbeef'; // and shares history with HEAD
    if (args[0] === 'worktree') return porcelain;
    // 4-arg tree-diff call ('diff --quiet <baseRef> <revSpec>') vs. the 3-arg TRACKED-changes
    // call ('diff --quiet HEAD', finding e446c6, unchanged) — distinguished by length.
    if (args[0] === 'diff' && args.length === 4) {
      if (nonEmptyDiffRevSpecs.has(args[3])) {
        const error = new Error('non-empty diff');
        error.status = 1;
        throw error;
      }
      return ''; // empty tree diff
    }
    if (args[0] === 'diff' && args.length === 3) return ''; // no tracked changes anywhere
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  }
  // status 'resolved': exactly one worktree (3545-a) carries a non-empty diff against the base —
  // the prunable stale entry (finding f0b34c) is excluded despite also carrying real changes.
  assert.deepEqual(
    resolveReviewTargetBranch({ tokens: [], cwd: repoRoot, runGitFn, allowSiblingHunt: true }),
    {
      status: 'resolved',
      branch: 'worktree-3545-a',
      path: '/repo-wt-a',
      repoRoot,
      baseRef: 'deadbeef',
    },
  );
  // status 'ambiguous': both sibling worktrees carry a non-empty diff — do not guess.
  function runGitFnBoth(_root, args) {
    if (args[0] === 'diff' && args.length === 4) {
      if (new Set(['worktree-3545-a', 'worktree-9999-b']).has(args[3])) {
        const error = new Error('non-empty diff');
        error.status = 1;
        throw error;
      }
      return '';
    }
    return runGitFn(_root, args);
  }
  const ambiguous = resolveReviewTargetBranch({
    tokens: [],
    cwd: repoRoot,
    runGitFn: runGitFnBoth,
    allowSiblingHunt: true,
  });
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.candidates.length, 2);
  // status 'none': no sibling worktree carries a non-empty diff, none uncommitted.
  function runGitFnNone(_root, args) {
    if (args[0] === 'diff') return ''; // every diff, committed or tracked, is empty
    return runGitFn(_root, args);
  }
  assert.deepEqual(
    resolveReviewTargetBranch({
      tokens: [],
      cwd: repoRoot,
      runGitFn: runGitFnNone,
      allowSiblingHunt: true,
    }),
    {
      status: 'none',
      branch: 'master',
      path: repoRoot,
      repoRoot,
      candidates: [],
      baseRef: 'deadbeef',
    },
  );
});

test('resolveReviewTargetBranch: the current checkout with its OWN non-empty diff is the target, no hunt runs — finding 5475c1', () => {
  const repoRoot = '/repo';
  const porcelain =
    'worktree /repo\nHEAD abc\nbranch refs/heads/master\n\n' +
    'worktree /repo-wt-a\nHEAD def\nbranch refs/heads/worktree-3545-a\n\n';
  function runGitFn(_root, args) {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return repoRoot;
    if (args[0] === 'branch') return 'master';
    if (args[0] === 'rev-parse' && args[1] === '--verify') return 'deadbeef';
    if (args[0] === 'merge-base') return 'deadbeef';
    // the CURRENT checkout's tree diff against the resolved base is itself non-empty — its own
    // diff is what the review is meant to cover, so the hunt must never fire here even though a
    // sibling also exists.
    if (args[0] === 'diff' && args.length === 4 && args[3] === 'HEAD') {
      const error = new Error('own diff non-empty');
      error.status = 1;
      throw error;
    }
    if (args[0] === 'worktree') return porcelain;
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  }
  assert.deepEqual(
    resolveReviewTargetBranch({ tokens: [], cwd: repoRoot, runGitFn, allowSiblingHunt: true }),
    { status: 'current', branch: 'master', path: repoRoot, repoRoot, baseRef: 'deadbeef' },
  );
});

test('resolveReviewTargetBranch: an EMPTY commit on master does not suppress the hunt — finding bdd0d9/77ecb9/0f5b7f', () => {
  // A COMMIT COUNT is not a valid proxy for "has a real diff": an empty commit is a nonzero
  // count with an EMPTY tree diff. Real git, not a mock — the exact shape a mocked rev-list
  // could not have caught, since it can only ever answer the question it's asked.
  const repo = makeRepo();
  const worktree = join(repo.dir, 'sibling-worktree');
  try {
    writeFileSync(join(repo.dir, 'initial.txt'), 'initial\n');
    repo.g('add', 'initial.txt');
    repo.g('commit', '-qm', 'initial');
    repo.g('update-ref', 'refs/remotes/origin/master', 'HEAD');
    // Ahead by one commit, but with a genuinely empty tree diff.
    repo.g('commit', '--allow-empty', '-qm', 'empty commit');
    repo.g('worktree', 'add', '-q', '-b', 'worktree-3527-SOL-cap', worktree);
    writeFileSync(join(worktree, 'change.txt'), 'change\n');
    execFileSync('git', ['-C', worktree, 'add', 'change.txt'], { encoding: 'utf8' });
    execFileSync(
      'git',
      [
        '-C',
        worktree,
        '-c',
        'user.name=Review Test',
        '-c',
        'user.email=review@test.invalid',
        'commit',
        '-qm',
        'sibling work',
      ],
      { encoding: 'utf8' },
    );
    const result = resolveReviewTargetBranch({
      tokens: [],
      cwd: repo.dir,
      allowSiblingHunt: true,
    });
    assert.equal(result.status, 'resolved');
    assert.equal(result.branch, 'worktree-3527-SOL-cap');
  } finally {
    repo.g('worktree', 'remove', '--force', worktree);
    repo.cleanup();
  }
});

test('resolveReviewTargetBranch: a change-and-revert on master does not suppress the hunt — finding bdd0d9/77ecb9/0f5b7f', () => {
  const repo = makeRepo();
  const worktree = join(repo.dir, 'sibling-worktree');
  try {
    writeFileSync(join(repo.dir, 'initial.txt'), 'initial\n');
    repo.g('add', 'initial.txt');
    repo.g('commit', '-qm', 'initial');
    repo.g('update-ref', 'refs/remotes/origin/master', 'HEAD');
    // Two commits ahead, but the second undoes the first — a genuinely empty tree diff overall.
    writeFileSync(join(repo.dir, 'initial.txt'), 'changed\n');
    repo.g('add', 'initial.txt');
    repo.g('commit', '-qm', 'change');
    writeFileSync(join(repo.dir, 'initial.txt'), 'initial\n');
    repo.g('add', 'initial.txt');
    repo.g('commit', '-qm', 'revert the change');
    repo.g('worktree', 'add', '-q', '-b', 'worktree-3527-SOL-cap', worktree);
    writeFileSync(join(worktree, 'change.txt'), 'change\n');
    execFileSync('git', ['-C', worktree, 'add', 'change.txt'], { encoding: 'utf8' });
    execFileSync(
      'git',
      [
        '-C',
        worktree,
        '-c',
        'user.name=Review Test',
        '-c',
        'user.email=review@test.invalid',
        'commit',
        '-qm',
        'sibling work',
      ],
      { encoding: 'utf8' },
    );
    const result = resolveReviewTargetBranch({
      tokens: [],
      cwd: repo.dir,
      allowSiblingHunt: true,
    });
    assert.equal(result.status, 'resolved');
    assert.equal(result.branch, 'worktree-3527-SOL-cap');
  } finally {
    repo.g('worktree', 'remove', '--force', worktree);
    repo.cleanup();
  }
});

test('resolveReviewTargetBranch: origin/master advancing past the lagging main checkout does not suppress the hunt — finding c34b42/6479af', () => {
  // A raw two-dot 'diff baseRef revSpec' compares TREE CONTENTS, not ancestry: if baseRef
  // (origin/master's own tip) has since advanced with unrelated commits, that diff is non-empty
  // purely from origin's later work — even though HEAD carries none of its own. Diffing from the
  // MERGE-BASE instead (this fix) correctly reads that as an empty own-diff, same as the
  // Workflow's own reviewed range.
  const repo = makeRepo();
  const worktree = join(repo.dir, 'sibling-worktree');
  try {
    writeFileSync(join(repo.dir, 'initial.txt'), 'initial\n');
    repo.g('add', 'initial.txt');
    repo.g('commit', '-qm', 'initial');
    repo.g('update-ref', 'refs/remotes/origin/master', 'HEAD');
    repo.g('worktree', 'add', '-q', '-b', 'worktree-3527-SOL-cap', worktree);
    writeFileSync(join(worktree, 'change.txt'), 'change\n');
    execFileSync('git', ['-C', worktree, 'add', 'change.txt'], { encoding: 'utf8' });
    execFileSync(
      'git',
      [
        '-C',
        worktree,
        '-c',
        'user.name=Review Test',
        '-c',
        'user.email=review@test.invalid',
        'commit',
        '-qm',
        'sibling work',
      ],
      { encoding: 'utf8' },
    );
    // origin/master advances with a commit that genuinely CHANGES the tree — unrelated to this
    // checkout's own HEAD (which stays at 'initial') — the exact "local master lags a freshly
    // fetched origin/master" shape. Built via a throwaway detached worktree so it is a REAL
    // commit with a REAL tree difference, not a same-tree relabeling a raw diff would miss.
    const advanceWorktree = join(repo.dir, 'advance-worktree');
    repo.g('worktree', 'add', '-q', '--detach', advanceWorktree, 'origin/master');
    writeFileSync(join(advanceWorktree, 'unrelated.txt'), 'unrelated\n');
    execFileSync('git', ['-C', advanceWorktree, 'add', 'unrelated.txt'], { encoding: 'utf8' });
    execFileSync(
      'git',
      [
        '-C',
        advanceWorktree,
        '-c',
        'user.name=Review Test',
        '-c',
        'user.email=review@test.invalid',
        'commit',
        '-qm',
        'unrelated later commit on origin',
      ],
      { encoding: 'utf8' },
    );
    const advancedSha = execFileSync('git', ['-C', advanceWorktree, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    repo.g('worktree', 'remove', '--force', advanceWorktree);
    repo.g('update-ref', 'refs/remotes/origin/master', advancedSha);
    const result = resolveReviewTargetBranch({
      tokens: [],
      cwd: repo.dir,
      allowSiblingHunt: true,
    });
    assert.equal(result.status, 'resolved');
    assert.equal(result.branch, 'worktree-3527-SOL-cap');
  } finally {
    repo.g('worktree', 'remove', '--force', worktree);
    repo.cleanup();
  }
});

test('resolveReviewTargetBranch: a sibling BEHIND the base is not a candidate — finding 4e738f', () => {
  const repo = makeRepo();
  const worktree = join(repo.dir, 'sibling-worktree');
  try {
    writeFileSync(join(repo.dir, 'initial.txt'), 'initial\n');
    repo.g('add', 'initial.txt');
    repo.g('commit', '-qm', 'initial');
    const initialSha = repo.g('rev-parse', 'HEAD');
    writeFileSync(join(repo.dir, 'second.txt'), 'second\n');
    repo.g('add', 'second.txt');
    repo.g('commit', '-qm', 'advance');
    repo.g('update-ref', 'refs/remotes/origin/master', 'HEAD'); // origin/master == the ADVANCED tip
    // The sibling is checked out at the OLDER commit — behind the base, not ahead of it. Its
    // tree differs from origin/master's tip (it is missing 'second.txt'), but that difference is
    // the base's OWN later work, not anything the sibling itself contributed.
    repo.g('worktree', 'add', '-q', '-b', 'worktree-9001-behind', worktree, initialSha);
    const result = resolveReviewTargetBranch({
      tokens: [],
      cwd: repo.dir,
      allowSiblingHunt: true,
    });
    assert.equal(result.status, 'none');
  } finally {
    repo.g('worktree', 'remove', '--force', worktree);
    repo.cleanup();
  }
});

test('resolveReviewTargetBranch: an all-uncommitted sibling still counts as a candidate — finding 24ccca', () => {
  const repoRoot = '/repo';
  const porcelain =
    'worktree /repo\nHEAD abc\nbranch refs/heads/master\n\n' +
    'worktree /repo-wt-a\nHEAD def\nbranch refs/heads/worktree-3545-a\n\n';
  function runGitFn(_root, args) {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return repoRoot;
    if (args[0] === 'branch') return 'master';
    if (args[0] === 'rev-parse' && args[1] === '--verify') return 'deadbeef';
    if (args[0] === 'merge-base') return 'deadbeef';
    if (args[0] === 'worktree') return porcelain;
    if (args[0] === 'rev-list') return '0'; // zero COMMITTED commits ahead, anywhere
    // plan 3618 round 2 finding e446c6: TRACKED-only ('git diff --quiet HEAD'). The main
    // checkout's own diff must stay clean (else the own-diff precondition would short-circuit
    // before the hunt ever runs) — only the SIBLING carries real uncommitted work.
    if (args[0] === 'diff') {
      if (_root === repoRoot) return ''; // clean exit: the main checkout has no tracked changes
      const error = new Error('tracked changes present');
      error.status = 1; // 'git diff --quiet' exits 1 when there IS a difference
      throw error;
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  }
  assert.deepEqual(
    resolveReviewTargetBranch({ tokens: [], cwd: repoRoot, runGitFn, allowSiblingHunt: true }),
    {
      status: 'resolved',
      branch: 'worktree-3545-a',
      path: '/repo-wt-a',
      repoRoot,
      baseRef: 'deadbeef',
    },
  );
});

test('resolveReviewTargetBranch: a sibling whose only change is an UNTRACKED file is not a candidate — finding e446c6', () => {
  const repoRoot = '/repo';
  const porcelain =
    'worktree /repo\nHEAD abc\nbranch refs/heads/master\n\n' +
    'worktree /repo-wt-a\nHEAD def\nbranch refs/heads/worktree-3545-a\n\n';
  function runGitFn(_root, args) {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return repoRoot;
    if (args[0] === 'branch') return 'master';
    if (args[0] === 'rev-parse' && args[1] === '--verify') return 'deadbeef';
    if (args[0] === 'merge-base') return 'deadbeef';
    if (args[0] === 'worktree') return porcelain;
    if (args[0] === 'rev-list') return '0'; // zero COMMITTED commits ahead, anywhere
    // 'git diff --quiet HEAD' never sees an untracked file (unlike 'git status --porcelain',
    // whose '??' lines would have wrongly counted this as a candidate before this fix) — a
    // clean exit here for EVERY cwd means no tracked changes anywhere, sibling included.
    if (args[0] === 'diff') return '';
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  }
  assert.deepEqual(
    resolveReviewTargetBranch({ tokens: [], cwd: repoRoot, runGitFn, allowSiblingHunt: true }),
    {
      status: 'none',
      branch: 'master',
      path: repoRoot,
      repoRoot,
      candidates: [],
      baseRef: 'deadbeef',
    },
  );
});

test('resolveReviewTargetBranch: a locked sibling ahead of base is not a candidate — finding 1703c4', () => {
  const repoRoot = '/repo';
  const porcelain =
    'worktree /repo\nHEAD abc\nbranch refs/heads/master\n\n' +
    'worktree /repo-wt-a\nHEAD def\nbranch refs/heads/worktree-3545-a\nlocked\n\n';
  function runGitFn(_root, args) {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return repoRoot;
    if (args[0] === 'branch') return 'master';
    if (args[0] === 'rev-parse' && args[1] === '--verify') return 'deadbeef';
    if (args[0] === 'merge-base') return 'deadbeef';
    if (args[0] === 'worktree') return porcelain;
    // The locked sibling IS genuinely ahead — this proves the exclusion is the `locked` flag,
    // not a side effect of it happening to look unready.
    if (args[0] === 'rev-list') return args[2].split('..').pop() === 'HEAD' ? '0' : '5';
    if (args[0] === 'diff') return '';
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  }
  assert.deepEqual(
    resolveReviewTargetBranch({ tokens: [], cwd: repoRoot, runGitFn, allowSiblingHunt: true }),
    {
      status: 'none',
      branch: 'master',
      path: repoRoot,
      repoRoot,
      candidates: [],
      baseRef: 'deadbeef',
    },
  );
});

test('resolveReviewTargetBranch: base-ref selection skips a ref with no usable merge base — finding 3b89eb', () => {
  const repoRoot = '/repo';
  const porcelain =
    'worktree /repo\nHEAD abc\nbranch refs/heads/master\n\n' +
    'worktree /repo-wt-a\nHEAD def\nbranch refs/heads/worktree-3545-a\n\n';
  function runGitFn(_root, args) {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return repoRoot;
    if (args[0] === 'branch') return 'master';
    // origin/master EXISTS but shares no history with HEAD (an unrelated/orphan ref).
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[3] === 'origin/master') {
      return 'deadbeef';
    }
    // plan 3618 round 2 finding 6ea3ab: merge-base is now checked against the RESOLVED SHA
    // ('deadbeef'), never the candidate NAME ('origin/master') — a bare name is relative to
    // whichever checkout evaluates it.
    if (args[0] === 'merge-base' && args[1] === 'deadbeef') {
      throw new Error('fatal: no merge base');
    }
    // 'main' is the next candidate that actually resolves AND shares history.
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[3] === 'main') return 'cafebabe';
    if (args[0] === 'merge-base' && args[1] === 'cafebabe') return 'cafebabe';
    if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('no such ref');
    if (args[0] === 'worktree') return porcelain;
    if (args[0] === 'diff' && args.length === 4) {
      assert.equal(
        args[2],
        'cafebabe',
        'must diff against the VERIFIED (resolved sha) base, never a candidate NAME',
      );
      if (args[3] === 'HEAD') return ''; // own diff stays clean so the hunt proceeds
      const error = new Error('non-empty diff');
      error.status = 1;
      throw error; // the sibling has real work
    }
    if (args[0] === 'diff' && args.length === 3) return ''; // no tracked changes anywhere
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  }
  assert.deepEqual(
    resolveReviewTargetBranch({ tokens: [], cwd: repoRoot, runGitFn, allowSiblingHunt: true }),
    {
      status: 'resolved',
      branch: 'worktree-3545-a',
      path: '/repo-wt-a',
      repoRoot,
      baseRef: 'cafebabe',
    },
  );
});

test('resolveReviewTargetBranch: the resolved baseRef is a raw sha, never a relative candidate name — finding 6ea3ab', () => {
  // With origin/master absent and no upstream configured, 'main' is the winning candidate. The
  // returned baseRef must be the sha 'main' resolves to, not the string 'main' — a bare name is
  // relative to whichever checkout later evaluates it (the Workflow's own step i runs `git -C
  // <sibling worktree>`, a DIFFERENT checkout than the one that resolved it here).
  const repoRoot = '/repo';
  const porcelain =
    'worktree /repo\nHEAD abc\nbranch refs/heads/master\n\n' +
    'worktree /repo-wt-a\nHEAD def\nbranch refs/heads/worktree-3545-a\n\n';
  function runGitFn(_root, args) {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return repoRoot;
    if (args[0] === 'branch') return 'master';
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[3] === 'origin/master') {
      throw new Error('unknown revision: origin/master');
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[3] === '@{upstream}') {
      throw new Error('no upstream configured');
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[3] === 'main') return 'facefeed';
    if (args[0] === 'merge-base' && args[1] === 'facefeed') return 'facefeed';
    if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('no such ref');
    if (args[0] === 'worktree') return porcelain;
    if (args[0] === 'diff' && args.length === 4) {
      if (args[3] === 'HEAD') return ''; // own diff clean
      const error = new Error('non-empty diff');
      error.status = 1;
      throw error; // sibling has real work
    }
    if (args[0] === 'diff' && args.length === 3) return ''; // no tracked changes anywhere
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  }
  const result = resolveReviewTargetBranch({
    tokens: [],
    cwd: repoRoot,
    runGitFn,
    allowSiblingHunt: true,
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.baseRef, 'facefeed', 'baseRef is the RESOLVED sha, never the name "main"');
});

test('resolveReviewTargetBranch: the DEFAULT invocation shape charges a real sibling worktree (E9)', () => {
  // The shape plan 3545's own probes never covered: no branch token, launched from a REAL main
  // checkout sitting on master, with a plan worktree checked out beside it.
  const repo = makeRepo();
  const worktree = join(repo.dir, 'sibling-worktree');
  try {
    writeFileSync(join(repo.dir, 'initial.txt'), 'initial\n');
    repo.g('add', 'initial.txt');
    repo.g('commit', '-qm', 'initial');
    writeFileSync(join(repo.dir, 'second.txt'), 'second\n');
    repo.g('add', 'second.txt');
    repo.g('commit', '-qm', 'second');
    // plan 3618 round 2 finding 5475c1: the hunt only fires when the main checkout's OWN diff
    // against the resolved base is empty. Point a same-shaped `origin/master` ref at the
    // current HEAD — this main checkout carries no unpushed work of its own, which is the
    // realistic precondition for ever reaching the hunt at all (the real Workflow's own diff
    // materialization would otherwise be non-empty and never call this resolver). The pre-round-
    // 2 version of this test instead relied on the HEAD~1 last-resort fallback, which is
    // trivially non-empty against ANY current HEAD and so can never satisfy this precondition.
    repo.g('update-ref', 'refs/remotes/origin/master', 'HEAD');
    repo.g('worktree', 'add', '-q', '-b', 'worktree-3527-SOL-cap', worktree);
    writeFileSync(join(worktree, 'change.txt'), 'change\n');
    execFileSync('git', ['-C', worktree, 'add', 'change.txt'], { encoding: 'utf8' });
    execFileSync(
      'git',
      [
        '-C',
        worktree,
        '-c',
        'user.name=Review Test',
        '-c',
        'user.email=review@test.invalid',
        'commit',
        '-qm',
        'sibling work',
      ],
      { encoding: 'utf8' },
    );
    const result = resolveReviewTargetBranch({
      tokens: [],
      cwd: repo.dir,
      allowSiblingHunt: true,
    });
    assert.equal(result.status, 'resolved');
    assert.equal(result.branch, 'worktree-3527-SOL-cap');
    // git's own porcelain output may normalize separators/casing differently from Node's
    // path.join on Windows — compare normalized rather than byte-for-byte.
    assert.equal(
      result.path.replace(/\\/g, '/').toLowerCase(),
      worktree.replace(/\\/g, '/').toLowerCase(),
    );
    assert.equal(planIdFromSlug(planSlugFromBranch(result.branch)), '3527');
  } finally {
    repo.g('worktree', 'remove', '--force', worktree);
    repo.cleanup();
  }
});

const REVIEW_ROUND_CAP_PATH = fileURLToPath(new URL('./review-round-cap.mjs', import.meta.url));

test('resolve-target-branch CLI: --base <sha> is returned verbatim, never re-resolved — finding fb87ce/d49ff6', () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo.dir, 'a.txt'), 'a\n');
    repo.g('add', 'a.txt');
    repo.g('commit', '-qm', 'a');
    const headSha = repo.g('rev-parse', 'HEAD');
    // No origin/master, no upstream, no main configured here — if the CLI ignored --base and
    // re-resolved on its own, it would fall through the whole candidate chain to HEAD~1 (a
    // DIFFERENT value than headSha) instead of echoing back the value this test supplied.
    const out = execFileSync(
      process.execPath,
      [REVIEW_ROUND_CAP_PATH, 'resolve-target-branch', '--cwd', repo.dir, '--base', headSha],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(out);
    assert.equal(result.baseRef, headSha);
    // its own diff against its own HEAD is empty, so the hunt proceeds and finds no siblings.
    assert.equal(result.status, 'none');
  } finally {
    repo.cleanup();
  }
});
