// scripts/coord-git.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  utimesSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import {
  parseArgs,
  parseFlags,
  withRetry,
  sleepSync,
  indexLockPath,
  invalidateIndexLockPath,
  waitForIndexLock,
  gitWithLockRetry,
  gitMoveCommit,
  isNonFastForward,
  isMultiBranchFastForward,
  ffMasterFromOrigin,
  isForeignDirtRefusal,
  pushMasterWithRebase,
  replayMismatches,
  LOCK_FREE_READ_ENV,
  coordWrite,
  coordErrorReason,
  assertPushReachedOrigin,
  assertNoopReachedOrigin,
  COORD_TRAILER,
  backoffMs,
  retryOnForeignDirt,
  retryTransientCoordDirt,
  isCoordDocPath,
  parseForeignDirtPaths,
  classifyForeignDirt,
  coordRetry,
  git,
  GIT_NONINTERACTIVE_ENV,
  clearStaleIndexLock,
  STALE_LOCK_MS,
  isTransientIndexWrite,
  isNothingToCommit,
  isMvBadSource,
  isRefLockRace,
  isRefUpdateRace,
  isMetadataCorruption,
  annotateMetadataCorruption,
  METADATA_HEAL_HINT,
  LOCK_RX,
  commitSubjectAtHead,
  commitNonceAtHead,
  abortRebaseAndDiagnose,
  readTrackedFileFresh,
  rebaseOwnerToken,
  selfRebaseOwnerToken,
  readCoordOpJournal,
  resolveMain,
  masterPushSpec,
  worktreeAdminRoot,
  coordLockPath,
  coordOpJournalPath,
  coordCheckoutPath,
  acquireCoordLock,
  releaseCoordLock,
  reclaimStaleLock,
  resolveCoordCheckout,
  ensureCoordSparseCheckout,
  ensureSparseCheckout,
  ensurePlanSparseCheckout,
  sparseConeDirs,
  planWorktreeIsSparse,
  widenPlanWorktree,
  planNarrowBlockers,
  narrowPlanWorktree,
  COORD_SPARSE_MARKER,
  PLAN_SPARSE_MARKER,
  readSparseState,
  assertCoordPathInCone,
  topLevelSegment,
  withCoordCheckout,
  withCoordLock,
  COORD_FALLBACK_IDENTITY,
  probeIdentityFallbackEnv,
  deleteStaleArchiveDups,
  resolveGuardRanges,
  errText,
  errSummary,
  clampedAgeMs,
  ensureMvDestDir,
  lsRemoteTimed,
  derivedReadTimeoutMs,
  readCoordOpJournalForStats,
  sweepWorktreeIndexLocks,
  healOwnWorktreeIndexLock,
  WORKTREE_LOCK_STALE_MS,
  DEAD_SEED_MIN_AGE_MS,
  deadSeedVerdict,
  boundedGitWithLockRetry,
  boundedGit,
  COORD_CHECKOUT_GIT_TIMEOUT_MS,
  COORD_CHECKOUT_TIMEOUT,
  coordOpJournalDailyPath,
  journalCoordOp,
  coordOpJournalArchiveRegex,
  stripInheritedRepoSelectors,
} from './coord-git.mjs';
// plan 4071 T2: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL / PLAN_WORKTREE_EXCLUDED_PATHS are no longer
// coord-git.mjs module constants -- they are coord.config.json's `coordCheckoutExcludedTopLevel` /
// `planWorktreeExcludedPaths` keys. This module ships as-is into the public coord-kit
// (scripts/coord/ is copied wholesale — plan 3958), so the tests below use a FIXED, portable
// fixture value rather than loading THIS repo's real root config (a shipped core test must be
// true in any repo, including the kit itself, whose coord.config.json carries neither key). The
// values are exactly what vetapp's real coord.config.json held at the time of this change — kept
// as a snapshot for realistic path shapes, not re-derived — and `makeConeRepo()`'s synthetic
// fixture writes the same two constants into its own coord.config.json so
// `resolveCoordCheckout`/`coordWrite`'s self-resolution (from the repo root they already receive)
// sees the identical list. loadCoordConfig/repoRootFrom stay imported for the one test below that
// exercises loadCoordConfig's own freshness contract against THIS repo's real root — portable
// because it asserts array freshness, not content (see that test's own comment).
import { loadCoordConfig } from './coord-config.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';
// plan 2465 review fix: shared with clear-stale-worktree-lock.test.mjs — one fixture, not two.
import { makeRepoWithWorktree as makeRepoWithWorktreeLock } from '../test-helpers/worktree-lock-repo.mjs';
import { withEnvVar } from '../test-helpers/with-env-var.mjs';
import { injectTransientOnFirst as injectTransientGit } from '../test-helpers/inject-transient-git.mjs';

const COORD_CHECKOUT_EXCLUDED_TOP_LEVEL = ['backend', 'frontend'];
const PLAN_WORKTREE_EXCLUDED_PATHS = [
  'backend/data/data-pipeline/render-store',
  'backend/data/data-pipeline/render-archive',
  'backend/data/data-pipeline/render-fingerprints',
  'backend/data/data-pipeline/batches',
  'backend/data/data-pipeline/prompt-bench',
  'backend/data/data-pipeline/llm-runs',
  'backend/data/data-pipeline/page-extractions',
];

// ── plan 3517: deadSeedVerdict ──

const DEAD_SEED_NOW_MS = 2_000_000_000_000;
const deadSeedCt = (ageMs) => (DEAD_SEED_NOW_MS - ageMs) / 1000;

test('deadSeedVerdict: carries-work and even an unknown-tip Git failure keep blocking', () => {
  const verdict = deadSeedVerdict('/repo', 'tip', {
    nowMs: DEAD_SEED_NOW_MS,
    _git: () => {
      throw new Error('merge-base exit 1 or 128');
    },
  });
  assert.deepEqual(verdict, { dead: false, ageMs: null, reason: 'carries-work' });
});

test('deadSeedVerdict: a log failure is a never-throwing git-error verdict', () => {
  const verdict = deadSeedVerdict('/repo', 'tip', {
    nowMs: DEAD_SEED_NOW_MS,
    _git: (_dir, args) => {
      if (args[0] === 'merge-base') return '';
      throw new Error('log failed');
    },
  });
  assert.deepEqual(verdict, { dead: false, ageMs: null, reason: 'git-error' });
});

for (const [label, output] of [
  ['empty output', ''],
  ['whitespace and non-numeric output', '  \nnot-a-time\nInfinity\n'],
]) {
  test(`deadSeedVerdict: ${label} makes age unknown`, () => {
    const verdict = deadSeedVerdict('/repo', 'tip', {
      nowMs: DEAD_SEED_NOW_MS,
      _git: (_dir, args) => (args[0] === 'log' ? output : ''),
    });
    assert.deepEqual(verdict, { dead: false, ageMs: null, reason: 'age-unknown' });
  });
}

for (const [label, ageMs, dead, reason] of [
  ['older than six hours', DEAD_SEED_MIN_AGE_MS + 1000, true, 'dead'],
  ['exactly six hours', DEAD_SEED_MIN_AGE_MS, true, 'dead'],
  ['six hours minus one second', DEAD_SEED_MIN_AGE_MS - 1000, false, 'fresh'],
  ['fresh', 1000, false, 'fresh'],
]) {
  test(`deadSeedVerdict: ${label}`, () => {
    const verdict = deadSeedVerdict('/repo', 'tip', {
      nowMs: DEAD_SEED_NOW_MS,
      _git: (_dir, args) => (args[0] === 'log' ? `${deadSeedCt(ageMs)}\n` : ''),
    });
    assert.deepEqual(verdict, { dead, ageMs, reason });
  });
}

test('deadSeedVerdict: uses the minimum committer time from unsorted log output', () => {
  const oldestAgeMs = DEAD_SEED_MIN_AGE_MS + 5000;
  const output = [deadSeedCt(1000), deadSeedCt(oldestAgeMs), deadSeedCt(3000)].join('\n');
  assert.deepEqual(
    deadSeedVerdict('/repo', 'tip', {
      nowMs: DEAD_SEED_NOW_MS,
      _git: (_dir, args) => (args[0] === 'log' ? output : ''),
    }),
    { dead: true, ageMs: oldestAgeMs, reason: 'dead' },
  );
});

test('deadSeedVerdict: handles an ancestry path larger than the V8 argument limit', () => {
  const oldCt = deadSeedCt(DEAD_SEED_MIN_AGE_MS + 1000);
  const output = Array.from({ length: 200_000 }, () => String(oldCt)).join('\n');
  assert.deepEqual(
    deadSeedVerdict('/repo', 'tip', {
      nowMs: DEAD_SEED_NOW_MS,
      _git: (_dir, args) => (args[0] === 'log' ? output : ''),
    }),
    { dead: true, ageMs: DEAD_SEED_MIN_AGE_MS + 1000, reason: 'dead' },
  );
});

test('deadSeedVerdict: passes the exact semantic argv and env to both Git calls', () => {
  const calls = [];
  const env = { TEST_ENV: 'yes' };
  deadSeedVerdict('/repo', 'abc123', {
    nowMs: DEAD_SEED_NOW_MS,
    env,
    _git: (dir, args, opts) => {
      calls.push({ dir, args, opts });
      return args[0] === 'log' ? `${deadSeedCt(1000)}\n` : '';
    },
  });
  assert.deepEqual(calls, [
    {
      dir: '/repo',
      args: ['merge-base', '--is-ancestor', 'abc123', 'origin/master'],
      opts: { env },
    },
    {
      dir: '/repo',
      args: ['log', '--ancestry-path', '--format=%ct', 'abc123..origin/master'],
      opts: { env },
    },
  ]);
});

test('deadSeedVerdict: unexpected parse failures cannot escape', () => {
  const verdict = deadSeedVerdict('/repo', 'tip', {
    nowMs: DEAD_SEED_NOW_MS,
    _git: (_dir, args) => (args[0] === 'log' ? null : ''),
  });
  assert.deepEqual(verdict, { dead: false, ageMs: null, reason: 'git-error' });
});

// ── plan 3205: errSummary — errText's operator-facing one-liner ───────────────────────

test('errSummary reduces a git failure to its first meaningful line', () => {
  // git writes the diagnosis first and the boilerplate after it, so the FIRST non-empty
  // line is the one worth putting in a gate's warning.
  const e = {
    stderr:
      "\nfatal: 'origin' does not appear to be a git repository\n" +
      'fatal: Could not read from remote repository.\n',
    message: 'Command failed: git fetch --quiet origin master',
  };
  assert.equal(errSummary(e), "fatal: 'origin' does not appear to be a git repository");
  // The MATCHING surface must be unaffected — the classifiers grep errText and need it whole.
  assert.match(errText(e), /Could not read from remote repository/);
});

test('errSummary truncates a runaway line and never returns empty', () => {
  const long = errSummary({ stderr: `fatal: ${'x'.repeat(500)}` }, { max: 40 });
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('…'), 'a truncated line must say it was truncated');
  // A message-less throw still has to name SOMETHING — a blank warning is the silence
  // this helper exists to end.
  assert.equal(errSummary(undefined), 'unknown error');
  assert.equal(errSummary({ stderr: '   \n\n' }), 'unknown error');
});

// ── plan 1289: resolveGuardRanges — the ONE range policy for the range-scoped guards ──

test('resolveGuardRanges: explicit argv ranges are returned verbatim, no git call', () => {
  const boom = () => {
    throw new Error('must not be called');
  };
  assert.deepEqual(resolveGuardRanges('/nowhere', ['a..b', 'c..d'], { _git: boom }), [
    'a..b',
    'c..d',
  ]);
});

test('resolveGuardRanges: no argv + resolvable origin/master → the default range', () => {
  const calls = [];
  const fake = (dir, args) => {
    calls.push(args.join(' '));
    return '';
  };
  assert.deepEqual(resolveGuardRanges('/repo', [], { _git: fake }), ['origin/master..HEAD']);
  assert.deepEqual(calls, ['rev-parse --verify --quiet origin/master']);
});

test('resolveGuardRanges: no argv + unresolvable origin/master → null (caller SKIPs)', () => {
  const fake = () => {
    throw new Error('unknown revision');
  };
  assert.equal(resolveGuardRanges('/repo', [], { _git: fake }), null);
});

// ── plan 1398 (item 4): clampedAgeMs — the ONE shared lock-age helper acquireCoordLock and
// landing-lock's corruptFileAgeMinutes both now call, so their stale/corrupt-file-age
// semantics can never silently diverge. ────────────────────────────────────────────────

test('clampedAgeMs: a past reference yields the plain positive age', () => {
  assert.equal(clampedAgeMs(10_000, 4_000), 6_000);
});

test('clampedAgeMs: a future reference (clock skew) floors to 0, never negative', () => {
  assert.equal(clampedAgeMs(1_000, 5_000), 0);
});

test('clampedAgeMs: zero age at exact equality', () => {
  assert.equal(clampedAgeMs(1_000, 1_000), 0);
});

test('clampedAgeMs: a non-finite reference (NaN from a garbage timestamp) returns NaN, not a crash', () => {
  assert.ok(Number.isNaN(clampedAgeMs(1_000, NaN)));
  assert.ok(Number.isNaN(clampedAgeMs(1_000, Infinity)));
});

// Backdate a file's mtime so it reads as `ageMs` old (for the stale-lock tests).
function ageFile(path, ageMs) {
  const when = (Date.now() - ageMs) / 1000; // utimesSync takes seconds
  utimesSync(path, when, when);
}

// plan 338: this suite is wired into pre-push, and git exports GIT_DIR /
// GIT_WORK_TREE / GIT_INDEX_FILE into hook subprocesses — those OVERRIDE the
// `git -C <tmpdir>` repo selection below and redirect these temp-repo ops onto
// the REAL repo (shared user.name corruption + junk commits, proven 2026-06-04).
// Clear them so every git call in this throwaway test process honours -C <tmpdir>.
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

// --- real-git temp-repo harness (used by the lock-retry tests) ----------------
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'coord-git-test-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'f.txt'), 'one\n');
  g('add', 'f.txt');
  g('commit', '-qm', 'init');
  return { dir, g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// plan 2493: worktreeAdminRoot/coordLockPath/coordOpJournalPath used to resolve the common dir
// via the UNSCRUBBED git() helper (`isAbsolute(common) ? common : resolve(mainDir, common)`)
// instead of the shared resolveCommonDirPath (lock-path.mjs, plan 2478/2489) -- a poisoned
// GIT_DIR (a git hook exports it into every child, sometimes pointing at a worktree gitdir
// mid-operation) could redirect all three onto a FOREIGN repo's common dir. This pins the
// migration: each must resolve under mainDir's own common dir regardless of a poisoned GIT_DIR.
test('worktreeAdminRoot / coordLockPath / coordOpJournalPath: a poisoned GIT_DIR is ignored', () => {
  const repo = makeRepo();
  const foreign = makeRepo();
  try {
    withEnvVar({ GIT_DIR: join(foreign.dir, '.git') }, () => {
      assert.equal(
        worktreeAdminRoot(repo.dir).replaceAll('\\', '/'),
        join(repo.dir, '.git', 'worktrees').replaceAll('\\', '/'),
      );
      assert.equal(
        coordLockPath(repo.dir).replaceAll('\\', '/'),
        join(repo.dir, '.git', 'coord-write.lock').replaceAll('\\', '/'),
      );
      assert.equal(
        coordOpJournalPath(repo.dir).replaceAll('\\', '/'),
        join(repo.dir, '.git', 'coord-op-journal.jsonl').replaceAll('\\', '/'),
      );
    });
  } finally {
    repo.cleanup();
    foreign.cleanup();
  }
});

// plan 4087 T0/T1: rotation used to DISCARD the pre-rotation content outright (JOURNAL_KEEP_LINES
// tail only, everything before it dropped on the floor) — the exact truncation that nearly cost
// the T0 measurement its evidence. Now the discarded content is archived to a daily file beside
// the live journal before the live file is truncated, so a week of ops survives across many
// rotations even though the live file's own tail-only contract (readCoordOpJournal / heal-main's
// openCoordOps fold) is unchanged.
test('journalCoordOp: rotation archives the pre-rotation content to a daily file instead of discarding it (plan 4087)', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-journal-rotate-'));
  try {
    const p = join(root, 'coord-op-journal.jsonl');
    // Seed a journal already over JOURNAL_ROTATE_BYTES (256KiB) with a recognisable marker line
    // repeated — big enough to force the next journalCoordOp call to rotate.
    const markerLine = JSON.stringify({
      ts: 'seed',
      tool: 'seed-marker-tool',
      token: 'seed-token',
    });
    const lines = [];
    for (let size = 0; size < 256 * 1024 + 2000; size += markerLine.length + 1)
      lines.push(markerLine);
    writeFileSync(p, lines.join('\n') + '\n');
    assert.ok(!existsSync(coordOpJournalDailyPath(p)), 'precondition: no daily archive exists yet');

    journalCoordOp(
      'unused-main-dir-path',
      { tool: 'rotation-trigger', token: 't1', phase: 'start' },
      { path: p },
    );

    const dailyPath = coordOpJournalDailyPath(p);
    assert.ok(existsSync(dailyPath), 'a daily archive file must be created on rotation');
    assert.match(
      readFileSync(dailyPath, 'utf8'),
      /seed-marker-tool/,
      'the pre-rotation content must be preserved in the archive, never discarded',
    );
    const liveLines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    assert.ok(
      liveLines.length <= 201,
      `the live file must stay truncated to the tail + the new line, got ${liveLines.length}`,
    );
    assert.match(
      readFileSync(p, 'utf8'),
      /"tool":"rotation-trigger"/,
      'the entry that triggered rotation must still land in the live file',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── plan 4087 round-4 review (keys c67d42/00ed01/5840c6/4ef78b/3a6139): the CAUSE of three review
// rounds of ever-more-clever reader-side overlap trims — archiving copied the WHOLE pre-rotation
// file, then truncated the live file to its own last JOURNAL_KEEP_LINES (200) lines, so the kept
// tail existed in BOTH places. Fixed at the source: the archive holds only the lines being REMOVED.
// These two tests replace the deleted collectJournalEntries overlap/dedup-guard tests in
// coord-op-stats.test.mjs — the writer no longer produces an overlap for a reader to guard against.
test('journalCoordOp: rotation archives ONLY the lines it removes, never the kept tail too', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-journal-rotate-exact-'));
  try {
    const p = join(root, 'coord-op-journal.jsonl');
    // 210 seed lines, individually identifiable — padded so the total comfortably exceeds
    // JOURNAL_ROTATE_BYTES (256KiB). 210 - 200 (JOURNAL_KEEP_LINES) = exactly 10 lines must be
    // archived; the other 200 must stay live-only.
    const pad = 'x'.repeat(1200);
    const seedLines = Array.from({ length: 210 }, (_, i) =>
      JSON.stringify({ ts: 'seed', tool: 'seed', token: `line-${i}`, pad }),
    );
    writeFileSync(p, seedLines.join('\n') + '\n');

    journalCoordOp(
      'unused-main-dir-path',
      { tool: 'rotation-trigger', token: 't1', phase: 'start' },
      { path: p },
    );

    const archivedLines = readFileSync(coordOpJournalDailyPath(p), 'utf8')
      .split('\n')
      .filter(Boolean);
    const liveLines = readFileSync(p, 'utf8').split('\n').filter(Boolean);

    assert.deepEqual(
      archivedLines,
      seedLines.slice(0, 10),
      'the archive must hold exactly the 10 removed lines — never the whole 210-line pre-rotation file (the old bug archived all 210)',
    );
    assert.deepEqual(
      liveLines.slice(0, 200),
      seedLines.slice(10),
      'the kept tail is the LAST 200 seed lines, present live only — not re-copied into the archive',
    );
    assert.equal(liveLines.length, 201, 'live file = the 200-line tail + the triggering entry');
    assert.match(liveLines[200], /"tool":"rotation-trigger"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('journalCoordOp: two consecutive rotations plus the final live file reproduce every written line exactly once, in order — including identical lines and equal timestamps', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-journal-rotate-lossless-'));
  try {
    const p = join(root, 'coord-op-journal.jsonl');
    const pad = 'x'.repeat(1200); // pushes each batch well over JOURNAL_ROTATE_BYTES (256KiB)
    const batch1 = Array.from({ length: 220 }, (_, i) =>
      JSON.stringify({
        ts: `2026-09-22T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
        tool: 'batch1',
        token: `b1-${i}`,
        pad,
      }),
    );
    // Pin an IDENTICAL pair (byte-for-byte, same content) and an EQUAL-timestamp pair (different
    // content, same ts) — the two shapes that defeated the old reader-side overlap trim across its
    // three review rounds. Neither should need any special handling now: the writer never produces
    // an overlap, so the reader is plain concatenation regardless of what the content looks like.
    batch1[6] = batch1[5]; // identical line, non-adjacent-to-a-rotation-boundary duplicate
    batch1[51] = JSON.stringify({
      ts: JSON.parse(batch1[50]).ts,
      tool: 'batch1',
      token: 'b1-51-eqts',
      pad,
    });
    const batch2 = Array.from({ length: 220 }, (_, i) =>
      JSON.stringify({
        ts: `2026-09-22T11:00:${String(i % 60).padStart(2, '0')}.000Z`,
        tool: 'batch2',
        token: `b2-${i}`,
        pad,
      }),
    );

    // Rotation 1: seed the live file with batch1 (already over threshold) and trigger via a real
    // journalCoordOp call. Its own appended line's exact bytes (ts/pid/host included) are captured
    // off disk rather than guessed, since journalCoordOp — not this test — decides its shape.
    writeFileSync(p, batch1.join('\n') + '\n');
    journalCoordOp(
      'unused-main-dir-path',
      { tool: 'rot1-marker', token: 'rot1', phase: 'start' },
      { path: p },
    );
    const afterRot1 = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const marker1Line = afterRot1[afterRot1.length - 1];

    // Grow the (now-truncated) live file past the threshold again with batch2, then trigger
    // rotation 2 the same way. Both rotations land on the same calendar day (real `now()`), so the
    // second rotation appends to the SAME daily archive file as the first.
    appendFileSync(p, batch2.join('\n') + '\n');
    journalCoordOp(
      'unused-main-dir-path',
      { tool: 'rot2-marker', token: 'rot2', phase: 'start' },
      { path: p },
    );
    const afterRot2 = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const marker2Line = afterRot2[afterRot2.length - 1];

    const archiveLines = readFileSync(coordOpJournalDailyPath(p), 'utf8')
      .split('\n')
      .filter(Boolean);
    const liveLines = afterRot2;
    const reconstructed = [...archiveLines, ...liveLines];
    const originalOrder = [...batch1, marker1Line, ...batch2, marker2Line];

    assert.deepEqual(
      reconstructed,
      originalOrder,
      'archive (oldest-first) + live file must reproduce every written line exactly once, in the exact order it was written',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('journalCoordOp: no rotation needed leaves the live file alone and never creates a daily archive', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-journal-norotate-'));
  try {
    const p = join(root, 'coord-op-journal.jsonl');
    journalCoordOp(
      'unused-main-dir-path',
      { tool: 'small', token: 't1', phase: 'start' },
      { path: p },
    );
    assert.ok(
      !existsSync(coordOpJournalDailyPath(p)),
      'a small journal must never trigger an archive',
    );
    assert.match(readFileSync(p, 'utf8'), /"tool":"small"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// plan 4087: a rotation failure (an unreadable/unwritable journal directory) must be best-effort,
// like every other journal write — it must never throw into the caller whose op it is describing.
test('journalCoordOp: a rotation failure never throws into the caller (best-effort, like every journal write)', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-journal-rotate-fail-'));
  try {
    const p = join(root, 'coord-op-journal.jsonl');
    const markerLine = JSON.stringify({ ts: 'seed', tool: 'seed', token: 'seed-token' });
    const lines = [];
    for (let size = 0; size < 256 * 1024 + 2000; size += markerLine.length + 1)
      lines.push(markerLine);
    writeFileSync(p, lines.join('\n') + '\n');
    // Make the journal's directory read-only-ish by pointing the daily archive at an impossible
    // path instead (Windows readonly-dir semantics are unreliable in CI) — simulate the failure by
    // deleting the live file out from under statSync between the size check and the read, which is
    // the same "no journal yet"-shaped race the existing outer catch already tolerates.
    rmSync(p, { force: true });
    assert.doesNotThrow(() =>
      journalCoordOp(
        'unused-main-dir-path',
        { tool: 'after-vanish', token: 't1', phase: 'start' },
        { path: p },
      ),
    );
    assert.match(
      readFileSync(p, 'utf8'),
      /"tool":"after-vanish"/,
      'the op is still journaled despite the race',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseArgs splits command, positionals, and --flags', () => {
  const a = parseArgs(['archive', 'my-slug', '--note', 'shipped X', '--date', '2026-05-29']);
  assert.equal(a.cmd, 'archive');
  assert.deepEqual(a.positionals, ['my-slug']);
  assert.equal(a.flags.note, 'shipped X');
  assert.equal(a.flags.date, '2026-05-29');
});

// --- parseFlags (plan 1769: the shared value-aware parser) --------------------
test('parseFlags: values, booleans, and positionals mix', () => {
  const r = parseFlags(['a.md', '--message', 'hi', '--dry', 'b.md'], {
    label: 't',
    value: ['message'],
    boolean: ['dry'],
  });
  assert.deepEqual(r, { positionals: ['a.md', 'b.md'], flags: { message: 'hi', dry: true } });
});

test('parseFlags: short flags resolve via alias only', () => {
  const spec = { label: 't', value: ['message'], alias: { m: 'message' } };
  assert.equal(parseFlags(['-m', 'hi'], spec).flags.message, 'hi');
  // an un-aliased short flag is unknown, and aliases never apply to long names (--m ≠ -m)
  assert.throws(() => parseFlags(['-x'], spec), /t: unknown flag -x/);
  assert.throws(() => parseFlags(['--m', 'hi'], spec), /t: unknown flag --m/);
  // '-' alone is a positional, not a flag
  assert.deepEqual(parseFlags(['-'], spec).positionals, ['-']);
});

test('parseFlags: a value-flag consumes the next token even if it looks like a flag', () => {
  const r = parseFlags(['--replace', '--dry'], {
    label: 't',
    value: ['replace'],
    boolean: ['dry'],
  });
  assert.equal(r.flags.replace, '--dry');
  assert.equal(r.flags.dry, undefined); // consumed as the value, not set as a boolean
});

test('parseFlags: empty value preserved; trailing value-flag is undefined but present', () => {
  const spec = { label: 't', value: ['replace'] };
  assert.equal(parseFlags(['--replace', ''], spec).flags.replace, '');
  const r = parseFlags(['--replace'], spec);
  assert.ok('replace' in r.flags);
  assert.equal(r.flags.replace, undefined);
});

test('parseFlags: multi collects until the next -- token, appending across repeats', () => {
  const spec = { label: 't', multi: ['paths'], boolean: ['dry'] };
  const r = parseFlags(['--paths', 'a', '-b', '--dry', '--paths', 'c'], spec);
  // a single-dash token IS collected (coord-edit's historical rule: stop only on '--')
  assert.deepEqual(r.flags.paths, ['a', '-b', 'c']);
  assert.equal(r.flags.dry, true);
  assert.deepEqual(parseFlags(['--paths'], spec).flags.paths, []);
});

test('parseFlags: unknown flag throws loudly with the label', () => {
  assert.throws(
    () => parseFlags(['--mesage', 'oops'], { label: 'edit-plan', value: ['message'] }),
    /edit-plan: unknown flag --mesage/,
  );
});

test('parseFlags: positionals:false rejects bare tokens, with message overrides honoured', () => {
  const spec = {
    label: 't',
    value: ['log'],
    positionals: false,
    messages: {
      unknownFlag: (a) => `unexpected argument "${a}"`,
      positional: (a) => `unexpected argument "${a}" (hint)`,
    },
  };
  assert.throws(() => parseFlags(['bare'], spec), /t: unexpected argument "bare" \(hint\)/);
  assert.throws(() => parseFlags(['--nope'], spec), /t: unexpected argument "--nope"/);
  assert.equal(parseFlags(['--log', 'watch'], spec).flags.log, 'watch');
});

// --- parseFlags subcommand mode (plan 1777, review [1]/[3]) --------------------
test('parseFlags subcommand: leading booleans peel, cmd resolves past them', () => {
  const spec = { label: 't', subcommand: true, value: ['slug'], boolean: ['force', 'ready'] };
  const r = parseFlags(['--force', 'derail', '123', '--slug', 's'], spec);
  assert.equal(r.cmd, 'derail');
  assert.deepEqual(r.positionals, ['123']);
  assert.deepEqual(r.flags, { force: true, slug: 's' });
});

test('parseFlags subcommand: a value-flag-first invocation surfaces ITS token as cmd', () => {
  // The pre-1777 diagnostic contract: `--host acquire <id>` must NOT let --host swallow the
  // subcommand and fall through to a silent default (the next-plan-id silent-peek bug) —
  // the raw flag token comes back as cmd so the caller's unknown-command path names it.
  const spec = { label: 't', subcommand: true, value: ['host', 'seed-write'], boolean: ['ready'] };
  const r = parseFlags(['--seed-write', 'claim', '--host', 'h'], spec);
  assert.equal(r.cmd, '--seed-write');
  assert.deepEqual(r.flags, { host: 'h' }, 'rest after the raw cmd token parses normally');
});

test('parseFlags subcommand: empty or boolean-only argv yields cmd undefined', () => {
  const spec = { label: 't', subcommand: true, boolean: ['ready'] };
  assert.equal(parseFlags([], spec).cmd, undefined);
  const r = parseFlags(['--ready'], spec);
  assert.equal(r.cmd, undefined);
  assert.equal(r.flags.ready, true);
});

test('parseFlags subcommand: a leading ALIASED boolean peels like its long form (r3 [2])', () => {
  const spec = { label: 't', subcommand: true, boolean: ['force'], alias: { f: 'force' } };
  const r = parseFlags(['-f', 'derail', '123'], spec);
  assert.equal(r.cmd, 'derail');
  assert.equal(r.flags.force, true);
  assert.deepEqual(r.positionals, ['123']);
  // An unknown short flag ends the peel and comes back verbatim as cmd (loud downstream).
  assert.equal(parseFlags(['-x', 'derail'], spec).cmd, '-x');
});

// --- parseFlags `=`-joined values + optional-value kind (plan 1968) ------------
test('parseFlags: --name=value on a value flag takes the joined value, never the next token', () => {
  const spec = { label: 't', value: ['replace'], boolean: ['dry'] };
  const r = parseFlags(['--replace=x', '--dry'], spec);
  assert.equal(r.flags.replace, 'x');
  assert.equal(r.flags.dry, true, 'the next token is NOT consumed');
  // split on the FIRST `=` only — the value may itself contain `=`
  assert.equal(parseFlags(['--replace=a=b'], spec).flags.replace, 'a=b');
});

test('parseFlags: --flag= yields the empty string, distinct from missing', () => {
  const spec = { label: 't', value: ['replace'] };
  const r = parseFlags(['--replace='], spec);
  assert.ok('replace' in r.flags);
  assert.equal(r.flags.replace, '');
});

test('parseFlags: a boolean flag with a joined value throws loudly', () => {
  assert.throws(
    () => parseFlags(['--dry=x'], { label: 't', boolean: ['dry'] }),
    /t: flag --dry takes no value \(got "--dry=x"\)/,
  );
});

test('parseFlags: multi seeds its list with the joined value then keeps collecting', () => {
  const spec = { label: 't', multi: ['paths'], boolean: ['dry'] };
  const r = parseFlags(['--paths=a', 'b', '--dry', '--paths=c'], spec);
  assert.deepEqual(r.flags.paths, ['a', 'b', 'c']);
  assert.equal(r.flags.dry, true);
});

test('parseFlags: optional kind — bare sets true, =-joined sets the string, never eats a token', () => {
  const spec = { label: 't', optional: ['adopt'] };
  // bare: true, and the following token stays a positional (the cut-worktree slug case)
  const bare = parseFlags(['--adopt', 'my-slug'], spec);
  assert.equal(bare.flags.adopt, true);
  assert.deepEqual(bare.positionals, ['my-slug']);
  // =-joined: the string value
  const joined = parseFlags(['--adopt=claude/drain-901', 'my-slug'], spec);
  assert.equal(joined.flags.adopt, 'claude/drain-901');
  assert.deepEqual(joined.positionals, ['my-slug']);
  // empty joined value is '' (caller-visible), not true and not missing
  assert.equal(parseFlags(['--adopt='], spec).flags.adopt, '');
});

test('parseFlags: unknown flag with a joined value throws naming the ORIGINAL token', () => {
  assert.throws(
    () => parseFlags(['--typo=x'], { label: 't', value: ['message'] }),
    /t: unknown flag --typo=x/,
  );
});

test('parseFlags: no `=` handling on short flags — -m=x is unknown, not an alias hit', () => {
  assert.throws(
    () => parseFlags(['-m=x'], { label: 't', value: ['message'], alias: { m: 'message' } }),
    /t: unknown flag -m=x/,
  );
});

test('parseFlags: a flag declared under two kinds throws on the ambiguous spec (review 1968 [1])', () => {
  // a leftover value:['adopt'] beside optional:['adopt'] would silently re-introduce
  // the slug-swallowing next-token consume the optional kind exists to kill
  assert.throws(
    () => parseFlags(['x'], { label: 't', value: ['adopt'], optional: ['adopt'] }),
    /t: flag --adopt declared as both value and optional \(ambiguous spec\)/,
  );
  assert.throws(
    () => parseFlags([], { label: 't', boolean: ['dry'], multi: ['dry'] }),
    /t: flag --dry declared as both boolean and multi \(ambiguous spec\)/,
  );
});

test('parseFlags subcommand: a =-joined leading token ends the boolean peel, surfaces as cmd', () => {
  // Consistent with the verbatim-take doctrine: the caller's unknown-command path names
  // the true offending token instead of the parser guessing at intent.
  const spec = { label: 't', subcommand: true, boolean: ['force'] };
  const r = parseFlags(['--force=x', 'derail'], spec);
  assert.equal(r.cmd, '--force=x');
});

test('withRetry re-runs producer on a non-ff signal then succeeds', async () => {
  let attempts = 0;
  const producer = () => `attempt-${++attempts}`;
  let pushes = 0;
  const pushFn = (payload) => {
    if (++pushes < 3) {
      const e = new Error('rejected');
      e.nonFastForward = true;
      throw e;
    }
    return payload;
  };
  const result = await withRetry(producer, pushFn, { max: 5 });
  assert.equal(result, 'attempt-3');
  assert.equal(attempts, 3);
});

test('withRetry gives up after max attempts', async () => {
  const producer = () => 'x';
  const pushFn = () => {
    const e = new Error('rejected');
    e.nonFastForward = true;
    throw e;
  };
  await assert.rejects(() => withRetry(producer, pushFn, { max: 2 }), /after 2 attempts/);
});

test('indexLockPath resolves to <repo>/.git/index.lock', () => {
  const r = makeRepo();
  try {
    const p = indexLockPath(r.dir);
    assert.ok(p.endsWith('index.lock'), `expected …index.lock, got ${p}`);
    assert.ok(p.includes('.git'), 'should be inside .git');
  } finally {
    r.cleanup();
  }
});

// plan 2479 finding 3: successful resolutions are memoized per dir for the process lifetime.
test('indexLockPath caches a successful resolution — survives the repo becoming unresolvable', () => {
  const r = makeRepo();
  try {
    const first = indexLockPath(r.dir);
    // wipe .git so a FRESH probe would throw — proves the second call reused the cache
    rmSync(join(r.dir, '.git'), { recursive: true, force: true });
    const second = indexLockPath(r.dir);
    // path-assert-ok: BYTE-identity is the assertion — both values come from the same resolver on
    // the same host, so a normalizing compare would pass even if the cache had re-probed.
    assert.equal(second, first, 'cached path reused instead of re-probing the now-broken repo');
  } finally {
    r.cleanup();
  }
});

test('indexLockPath does not cache a failed resolution — a later successful probe is not poisoned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-git-notrepo-'));
  try {
    assert.throws(() => indexLockPath(dir), /fatal|not a git repository/i);
    execFileSync('git', ['-C', dir, 'init', '-q']);
    const p = indexLockPath(dir);
    assert.ok(p.endsWith('index.lock'), `expected …index.lock, got ${p}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalidateIndexLockPath: evicting an unknown dir is a no-op (no throw)', () => {
  assert.doesNotThrow(() => invalidateIndexLockPath('/nowhere/never-cached'));
});

// plan 2481: a worktree removed and recreated at the SAME path can land on a DIFFERENT admin dir
// (git auto-suffixes when the prior admin dir wasn't fully pruned) — proves the stale-cache bug
// WITHOUT the eviction wired, then proves invalidateIndexLockPath fixes it.
test('indexLockPath goes stale across a same-path worktree remove+recreate; invalidateIndexLockPath fixes it', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-git-wtrecreate-'));
  const mainDir = join(root, 'main');
  execFileSync('git', ['init', '-q', mainDir], { stdio: 'ignore' });
  const g = (...args) =>
    execFileSync('git', ['-C', mainDir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', ...args], {
      stdio: 'ignore',
    });
  writeFileSync(join(mainDir, 'f.txt'), 'a\n');
  g('add', 'f.txt');
  g('commit', '-qm', 'init');
  const wtDir = join(root, 'wt');
  try {
    g('worktree', 'add', '-q', '--detach', wtDir);
    const firstAdmin = execFileSync('git', ['-C', wtDir, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
    }).trim();
    const staleResolved = indexLockPath(wtDir); // populate the cache on the FIRST admin dir
    assert.ok(
      staleResolved.startsWith(firstAdmin),
      `expected the cached path under ${firstAdmin}, got ${staleResolved}`,
    );

    // Simulate the crash-recovery recreate: the working dir is gone, but the admin dir under
    // .git/worktrees/<name>/ still carries debris from an incomplete removal (the same shape
    // resolveCoordCheckout's own comment documents) — git refuses to reuse that admin name and
    // auto-suffixes a new one on the next `worktree add` at the identical outer path.
    rmSync(wtDir, { recursive: true, force: true });
    try {
      execFileSync('git', ['-C', mainDir, 'worktree', 'remove', '--force', wtDir], {
        stdio: 'ignore',
      });
    } catch {
      /* dir already gone — expected */
    }
    execFileSync('git', ['-C', mainDir, 'worktree', 'prune'], { stdio: 'ignore' });
    // `remove`+`prune` above fully clear a clean removal (registration AND the admin dir both
    // gone) — recreate the admin dir with leftover debris by hand to simulate the INTERRUPTED
    // removal shape resolveCoordCheckout's own comment documents, so the re-add below cannot
    // reuse the old admin name and must auto-suffix a new one.
    mkdirSync(firstAdmin, { recursive: true });
    writeFileSync(join(firstAdmin, 'leftover-debris'), 'x');
    g('worktree', 'add', '-q', '--detach', wtDir);
    const secondAdmin = execFileSync('git', ['-C', wtDir, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
    }).trim();
    assert.notEqual(secondAdmin, firstAdmin, 'test setup must actually change the admin dir');

    // WITHOUT invalidation: documents the bug — the cache still hands back the dead first admin's
    // path even though the live worktree's index.lock now resolves under the second admin dir.
    assert.equal(
      indexLockPath(wtDir),
      staleResolved,
      'uninvalidated cache should still return the now-stale first-admin path',
    );

    // WITH invalidation wired: the next resolve picks up the live (second) admin dir.
    invalidateIndexLockPath(wtDir);
    const fresh = indexLockPath(wtDir);
    assert.ok(
      fresh.startsWith(secondAdmin),
      `expected the re-resolved path under ${secondAdmin}, got ${fresh}`,
    );
    assert.notEqual(fresh, staleResolved);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('waitForIndexLock returns true immediately when no lock is held', () => {
  const r = makeRepo();
  try {
    assert.equal(waitForIndexLock(r.dir, { attempts: 3, delayMs: 20 }), true);
  } finally {
    r.cleanup();
  }
});

test('waitForIndexLock returns false when the lock is never released', () => {
  const r = makeRepo();
  try {
    writeFileSync(indexLockPath(r.dir), ''); // simulate a stuck parallel session
    const t0 = Date.now();
    const cleared = waitForIndexLock(r.dir, { attempts: 4, delayMs: 25 });
    assert.equal(cleared, false);
    assert.ok(Date.now() - t0 >= 75, 'should have polled the full budget'); // ~4×25ms
  } finally {
    r.cleanup();
  }
});

test('waitForIndexLock returns true when the lock clears mid-wait', async () => {
  const r = makeRepo();
  try {
    const lock = indexLockPath(r.dir);
    writeFileSync(lock, '');
    // A real OS process removes the lock ~150ms in — proves the sync sleep
    // does not starve out-of-process lock holders clearing it.
    const child = spawn(process.execPath, [
      '-e',
      `setTimeout(() => require('fs').rmSync(${JSON.stringify(lock)}, { force: true }), 150)`,
    ]);
    const cleared = waitForIndexLock(r.dir, { attempts: 20, delayMs: 50 });
    child.kill();
    assert.equal(cleared, true);
    assert.equal(existsSync(lock), false);
  } finally {
    r.cleanup();
  }
});

// --- plan 871: ownerless stale index.lock auto-clear ------------------------

test('clearStaleIndexLock removes a lock whose mtime is older than the threshold', () => {
  const r = makeRepo();
  try {
    const lock = indexLockPath(r.dir);
    writeFileSync(lock, '');
    ageFile(lock, 60_000); // 60s idle
    assert.equal(clearStaleIndexLock(r.dir, { staleMs: 30_000 }), true);
    assert.equal(existsSync(lock), false, 'the stale lock should be removed');
  } finally {
    r.cleanup();
  }
});

test('clearStaleIndexLock leaves a FRESH lock alone (a live op may hold it)', () => {
  const r = makeRepo();
  try {
    const lock = indexLockPath(r.dir);
    writeFileSync(lock, ''); // just created → mtime ~now
    assert.equal(clearStaleIndexLock(r.dir, { staleMs: 30_000 }), false);
    assert.equal(existsSync(lock), true, 'a fresh lock must not be removed');
  } finally {
    r.cleanup();
  }
});

test('clearStaleIndexLock returns false when there is no lock', () => {
  const r = makeRepo();
  try {
    assert.equal(clearStaleIndexLock(r.dir, { staleMs: 30_000 }), false);
  } finally {
    r.cleanup();
  }
});

// plan 4087 round-3 review (finding 4, key b14495): sweepWorktreeIndexLocks now carries each
// lock's real clearStaleIndexLockDetailed outcome through on `outcome`, so a caller (e.g.
// clear-stale-worktree-lock.mjs's MAIN-checkout sweep branch) can report the TRUE reason a lock
// was left uncleared without a second, racy existsSync probe of its own. A fake `.git/worktrees/
// <name>/index.lock` is planted directly — sweepWorktreeIndexLocks only ever enumerates that admin
// dir, so no real `git worktree add` is needed to exercise it.
function plantFakeWorktreeLock(mainDir, name, ageMs) {
  const dir = join(mainDir, '.git', 'worktrees', name);
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, 'index.lock');
  writeFileSync(lockPath, '');
  ageFile(lockPath, ageMs);
  return lockPath;
}

test('sweepWorktreeIndexLocks: outcome is "fresh" for a lock idle under staleMs, never attempted', () => {
  const r = makeRepo();
  try {
    const lockPath = plantFakeWorktreeLock(r.dir, 'wt1', 0);
    const [s] = sweepWorktreeIndexLocks(r.dir, { staleMs: 30_000 });
    assert.equal(s.removed, false);
    assert.equal(s.outcome, 'fresh');
    assert.equal(existsSync(lockPath), true, 'a fresh lock must not be removed');
  } finally {
    r.cleanup();
  }
});

test('sweepWorktreeIndexLocks: outcome is "removed" for a stale lock that was actually cleared', () => {
  const r = makeRepo();
  try {
    const lockPath = plantFakeWorktreeLock(r.dir, 'wt1', 60_000);
    const [s] = sweepWorktreeIndexLocks(r.dir, { staleMs: 30_000 });
    assert.equal(s.removed, true);
    assert.equal(s.outcome, 'removed');
    assert.equal(existsSync(lockPath), false);
  } finally {
    r.cleanup();
  }
});

test('sweepWorktreeIndexLocks: outcome is "dry-stale" for a provably-stale lock a dry run intentionally leaves alone', () => {
  const r = makeRepo();
  try {
    const lockPath = plantFakeWorktreeLock(r.dir, 'wt1', 60_000);
    const [s] = sweepWorktreeIndexLocks(r.dir, { staleMs: 30_000, dry: true });
    assert.equal(s.removed, false);
    assert.equal(s.outcome, 'dry-stale');
    assert.equal(existsSync(lockPath), true, 'dry run must never remove anything');
  } finally {
    r.cleanup();
  }
});

test('STALE_LOCK_MS is the documented conservative 30s default', () => {
  assert.equal(STALE_LOCK_MS, 30_000);
});

// --- plan 2465: healOwnWorktreeIndexLock (the land-spine worktree-private heal) ----------
// Real repo + REAL linked worktree fixture — shared with clear-stale-worktree-lock.test.mjs
// (test-helpers/worktree-lock-repo.mjs, plan 2465 review fix: one copy, not two).

test('healOwnWorktreeIndexLock: clears a stale worktree lock idle past the 30s spine floor', () => {
  const r = makeRepoWithWorktreeLock();
  try {
    writeFileSync(r.wtLock, '');
    ageFile(r.wtLock, 28 * 60 * 1000); // the plan-2432 incident: 28 min idle
    assert.equal(healOwnWorktreeIndexLock(r.wtDir, r.mainDir), true);
    assert.equal(existsSync(r.wtLock), false, 'the stale worktree lock is cleared');
  } finally {
    r.cleanup();
  }
});

test('healOwnWorktreeIndexLock: leaves a lock idle < 30s in place even though the raw CLI 3s default would clear it', () => {
  const r = makeRepoWithWorktreeLock();
  try {
    assert.ok(
      WORKTREE_LOCK_STALE_MS < 30_000,
      'sanity: the raw CLI default is below the spine floor',
    );
    writeFileSync(r.wtLock, '');
    ageFile(r.wtLock, 5_000); // past the CLI's raw 3s default, well under the spine's 30s floor
    assert.equal(healOwnWorktreeIndexLock(r.wtDir, r.mainDir), false);
    assert.equal(
      existsSync(r.wtLock),
      true,
      'a sub-gate lock must not be stomped — a live op may hold it',
    );
  } finally {
    r.cleanup();
  }
});

test('healOwnWorktreeIndexLock: no-op when no lock is present', () => {
  const r = makeRepoWithWorktreeLock();
  try {
    assert.equal(healOwnWorktreeIndexLock(r.wtDir, r.mainDir), false);
  } finally {
    r.cleanup();
  }
});

test('healOwnWorktreeIndexLock: never touches the shared MAIN index.lock', () => {
  const r = makeRepoWithWorktreeLock();
  try {
    writeFileSync(r.mainLock, '');
    ageFile(r.mainLock, 60_000);
    writeFileSync(r.wtLock, '');
    ageFile(r.wtLock, 60_000);
    healOwnWorktreeIndexLock(r.wtDir, r.mainDir);
    assert.equal(existsSync(r.wtLock), false, 'the worktree lock is cleared');
    assert.equal(existsSync(r.mainLock), true, 'the shared main index.lock is never touched');
  } finally {
    r.cleanup();
  }
});

test('healOwnWorktreeIndexLock: an unresolvable worktree path is a safe no-op (never throws)', () => {
  const r = makeRepoWithWorktreeLock();
  try {
    assert.equal(
      healOwnWorktreeIndexLock(join(r.mainDir, '..', 'does-not-exist'), r.mainDir),
      false,
    );
  } finally {
    r.cleanup();
  }
});

test('waitForIndexLock clears an ownerless stale lock and returns true', () => {
  const r = makeRepo();
  try {
    const lock = indexLockPath(r.dir);
    writeFileSync(lock, '');
    ageFile(lock, 60_000);
    // a stale lock present from the first poll: must be cleared, not waited out
    assert.equal(waitForIndexLock(r.dir, { attempts: 4, delayMs: 25, staleMs: 30_000 }), true);
    assert.equal(existsSync(lock), false);
  } finally {
    r.cleanup();
  }
});

test('waitForIndexLock with staleMs:null keeps the pre-871 wait-only behaviour (no clear)', () => {
  const r = makeRepo();
  try {
    const lock = indexLockPath(r.dir);
    writeFileSync(lock, '');
    ageFile(lock, 60_000); // stale, but stale-clear disabled
    assert.equal(waitForIndexLock(r.dir, { attempts: 3, delayMs: 20, staleMs: null }), false);
    assert.equal(existsSync(lock), true, 'with staleMs:null the lock is left in place');
  } finally {
    r.cleanup();
  }
});

test('gitWithLockRetry proceeds after auto-clearing a stale ownerless lock', () => {
  const r = makeRepo();
  try {
    const lock = indexLockPath(r.dir);
    writeFileSync(lock, '');
    ageFile(lock, 60_000); // ownerless crash leftover
    writeFileSync(join(r.dir, 'f.txt'), 'two\n'); // make `git add` want the index
    // default staleMs (30s) → the 60s-idle lock is cleared and the add succeeds
    gitWithLockRetry(r.dir, ['add', 'f.txt'], { attempts: 4, delayMs: 20 });
    assert.match(r.g('status', '--porcelain'), /f\.txt/, 'the add went through');
    assert.equal(existsSync(lock), false);
  } finally {
    r.cleanup();
  }
});

test('gitWithLockRetry runs the git command when no lock contends', () => {
  const r = makeRepo();
  try {
    const out = gitWithLockRetry(r.dir, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      attempts: 3,
      delayMs: 20,
    });
    assert.match(out.trim(), /^(master|main)$/);
  } finally {
    r.cleanup();
  }
});

test('gitWithLockRetry surfaces a clean error when the index stays locked', () => {
  const r = makeRepo();
  try {
    writeFileSync(indexLockPath(r.dir), ''); // a never-clearing lock
    writeFileSync(join(r.dir, 'f.txt'), 'two\n'); // make `git add` want the index
    assert.throws(
      () => gitWithLockRetry(r.dir, ['add', 'f.txt'], { attempts: 2, delayMs: 20 }),
      /blocked by index\.lock \/ transient index-write \/ ref-lock race \/ ref-update race after 2 attempts/,
    );
  } finally {
    r.cleanup();
  }
});

// plan 2479 finding 2: the exhaustion error carries the FINAL attempt's stdout/stderr alongside
// .cause, so a caller composing an operator-facing detail from `e.stdout || e.stderr || e.message`
// (land-lib.mjs's conflictDetail/pushDetail) sees git's actual diagnostic instead of only the
// synthetic "blocked by index.lock…" wording.
test("gitWithLockRetry exhaustion error carries the final attempt's stdout/stderr alongside .cause", () => {
  const lastFakeErr = () => {
    const e = new Error('index.lock contention (fake)');
    e.stdout = 'FAKE-STDOUT-DETAIL';
    e.stderr = "Unable to create '.../index.lock': File exists.";
    throw e;
  };
  let caught;
  try {
    gitWithLockRetry('/repo', ['commit'], { attempts: 2, delayMs: 5, _git: lastFakeErr });
    assert.fail('expected gitWithLockRetry to throw after exhausting retries');
  } catch (e) {
    caught = e;
  }
  assert.match(caught.message, /blocked by index\.lock/);
  assert.equal(caught.stdout, 'FAKE-STDOUT-DETAIL');
  assert.match(caught.stderr, /index\.lock/);
  assert.ok(caught.cause, '.cause is still set alongside the lifted channels');
});

test('gitWithLockRetry rethrows non-lock git failures untouched', () => {
  const r = makeRepo();
  try {
    assert.throws(
      () =>
        gitWithLockRetry(r.dir, ['cat-file', '-p', 'deadbeefdeadbeef'], {
          attempts: 2,
          delayMs: 20,
        }),
      /Not a valid object name|fatal/i,
    );
  } finally {
    r.cleanup();
  }
});

test('sleepSync blocks for roughly the requested duration', () => {
  const t0 = Date.now();
  sleepSync(60);
  assert.ok(Date.now() - t0 >= 50, 'sleepSync should block ~60ms');
});

// --- gitMoveCommit (rename-commit foot-gun guard, plan 363) -------------------
// The pass-3 Defect 2: `git add <renamed-from-path>` after a `git mv` fatals
// ("pathspec did not match" — the source is gone from disk) and half-applies the
// move (a bare rename commits, the content edits are dropped). gitMoveCommit is
// the one true move primitive: `git mv` + `git commit -- from to` (pathspec),
// NEVER `git add <from>`. These tests prove it commits a rename whose source no
// longer exists on disk and carries a working-tree edit into the rename.

test('gitMoveCommit commits a rename whose source is gone from disk (never git add <from>)', () => {
  const r = makeRepo();
  try {
    gitMoveCommit(r.dir, 'f.txt', 'g.txt', 'move f→g');
    assert.equal(existsSync(join(r.dir, 'f.txt')), false, 'source removed from disk');
    assert.equal(existsSync(join(r.dir, 'g.txt')), true, 'destination present');
    // A half-applied move would leave the deletion or the addition uncommitted.
    assert.equal(r.g('status', '--porcelain').trim(), '', 'tree fully committed, nothing dangling');
    assert.match(r.g('log', '-1', '--format=%s'), /move f→g/);
    assert.equal(r.g('show', 'HEAD:g.txt'), 'one\n', 'content preserved at the new path');
  } finally {
    r.cleanup();
  }
});

test('gitMoveCommit carries a working-tree content edit into the committed rename (no half-apply)', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'EDITED\n'); // unstaged edit BEFORE the move
    gitMoveCommit(r.dir, 'f.txt', 'g.txt', 'move f→g with edit');
    assert.equal(r.g('status', '--porcelain').trim(), '', 'nothing left uncommitted');
    assert.equal(r.g('show', 'HEAD:g.txt'), 'EDITED\n', 'the edit rode along into the rename');
    assert.equal(existsSync(join(r.dir, 'f.txt')), false);
  } finally {
    r.cleanup();
  }
});

// --- ensureMvDestDir (plan 1452/1475 item 2: mkdir-before-git-mv guard) -------
// The ONE definition the four coord git-mv call sites route through: gitMoveCommit's
// primitive + done-worktree's movePlanFileIdempotent/promoteWaitingBlocked + move-plan.

test('ensureMvDestDir creates the destination parent dir (recursive) when absent', () => {
  const r = makeRepo();
  try {
    ensureMvDestDir(r.dir, 'a/b/c/g.txt');
    assert.equal(existsSync(join(r.dir, 'a', 'b', 'c')), true);
  } finally {
    r.cleanup();
  }
});

test('ensureMvDestDir is idempotent when the dir already exists', () => {
  const r = makeRepo();
  try {
    ensureMvDestDir(r.dir, 'lane/x.txt');
    assert.doesNotThrow(() => ensureMvDestDir(r.dir, 'lane/y.txt'));
    assert.equal(existsSync(join(r.dir, 'lane')), true);
  } finally {
    r.cleanup();
  }
});

test('ensureMvDestDir resolves a relative dest against mainDir (the tree the mv runs in)', () => {
  const r = makeRepo();
  try {
    // plan 1452 invariant: built under mainDir, never process.cwd() / a foreign checkout.
    ensureMvDestDir(r.dir, 'deep/lane/g.txt');
    assert.equal(existsSync(join(r.dir, 'deep', 'lane')), true);
  } finally {
    r.cleanup();
  }
});

test('ensureMvDestDir honours an absolute dest verbatim', () => {
  const r = makeRepo();
  try {
    ensureMvDestDir(r.dir, join(r.dir, 'abs', 'lane', 'g.txt'));
    assert.equal(existsSync(join(r.dir, 'abs', 'lane')), true);
  } finally {
    r.cleanup();
  }
});

test('plan 1475 (item 2): gitMoveCommit creates a missing destination lane before the mv', () => {
  const r = makeRepo();
  try {
    // `lane/` does not exist yet — pre-1475 the bare `git mv` fataled "destination directory
    // does not exist" (the empty-lane failure plan 1452 fixed at the OTHER call sites but not here).
    gitMoveCommit(r.dir, 'f.txt', 'lane/g.txt', 'move into a fresh lane');
    assert.equal(existsSync(join(r.dir, 'lane', 'g.txt')), true, 'destination present in new lane');
    assert.equal(existsSync(join(r.dir, 'f.txt')), false, 'source removed');
    assert.equal(r.g('status', '--porcelain').trim(), '', 'tree fully committed');
    assert.equal(r.g('show', 'HEAD:lane/g.txt'), 'one\n', 'content preserved at the new path');
  } finally {
    r.cleanup();
  }
});

// ── plan 4087 T2 (S3): derivedReadTimeoutMs — the ONE shared, DERIVED read cap ───────────────
// Replaces the two hardcoded 5s constants (this file's own former lsRemoteTimed default, and
// claim-plan.mjs's separate CLAIM_READ_TIMEOUT_MS) plus one hand-rolled bypass
// (heldClaimsMap's own ls-remote, which never touched lsRemoteTimed at all — see
// claim-plan.test.mjs for that side). Derived from the coord-op journal's own DONE-only p95 (T0's
// coord-op-stats.mjs, reused rather than re-parsed a second way — plan 4087 T4 review fix
// 3qw0gd switched the field read from `summary.p95Ms` to `summary.p95DoneMs`, see
// derivedReadTimeoutMs's own header for why), bounded to [5000ms, 30000ms], memoised per dir with
// a TTL (T4 review fix 1mtmw9g). Injectable seams keep every case here fast and deterministic —
// no real journal file, no real git spawn.

test('derivedReadTimeoutMs: an empty journal (no measurement) gets the 30000ms CEILING, never the floor', () => {
  const ms = derivedReadTimeoutMs('/journal-dir-4087-A', {
    _readCoordOpJournal: () => [],
    _computeCoordOpStats: () => ({ summary: { p95DoneMs: null } }),
  });
  assert.equal(ms, 30000);
});

// plan 4087 land (2026-09-23): an unmeasured or thinly-measured box gets the CEILING. Defaulting
// to the 5000ms floor re-created the retired 5s cap, and this plan's own land battery tripped it
// (next-plan-id.test.mjs, a fixture repo with no journal, timed out verifying a push under load).
test('derivedReadTimeoutMs: a p95 from fewer than the minimum sample is not trusted -- ceiling, not the tiny p95', () => {
  const ms = derivedReadTimeoutMs('/journal-dir-4087-thin', {
    _readCoordOpJournal: () => [{}],
    _computeCoordOpStats: () => ({ summary: { doneSampleCount: 3, p95DoneMs: 800 } }),
  });
  assert.equal(ms, 30000);
});

test('derivedReadTimeoutMs: a measured p95 within [floor, ceiling] is used verbatim', () => {
  const ms = derivedReadTimeoutMs('/journal-dir-4087-B', {
    _readCoordOpJournal: () => [{}],
    _computeCoordOpStats: () => ({ summary: { doneSampleCount: 50, p95DoneMs: 12000 } }),
  });
  assert.equal(ms, 12000);
});

test('derivedReadTimeoutMs: a p95 below the floor is clamped UP to 5000ms', () => {
  const ms = derivedReadTimeoutMs('/journal-dir-4087-C', {
    _readCoordOpJournal: () => [{}],
    _computeCoordOpStats: () => ({ summary: { doneSampleCount: 50, p95DoneMs: 800 } }),
  });
  assert.equal(ms, 5000);
});

test('derivedReadTimeoutMs: a p95 above the ceiling is clamped DOWN to 30000ms', () => {
  const ms = derivedReadTimeoutMs('/journal-dir-4087-D', {
    _readCoordOpJournal: () => [{}],
    _computeCoordOpStats: () => ({ summary: { doneSampleCount: 50, p95DoneMs: 120000 } }),
  });
  assert.equal(ms, 30000);
});

test('derivedReadTimeoutMs: a journal reader that throws degrades to the ceiling, never throws into the caller', () => {
  const ms = derivedReadTimeoutMs('/journal-dir-4087-E', {
    _readCoordOpJournal: () => {
      throw new Error('unreadable journal');
    },
  });
  assert.equal(ms, 30000);
});

test('derivedReadTimeoutMs: reads summary.p95DoneMs, not summary.p95Ms (plan 4087 T4 review fix 3qw0gd)', () => {
  // A mock whose p95Ms differs sharply from p95DoneMs proves the DONE-only field is what's
  // actually read -- p95Ms mixes in error/release closes, which is the exact contamination this
  // basis fix removes (see coord-op-stats.mjs's newToolBucket doneDurationsMs comment).
  const ms = derivedReadTimeoutMs('/journal-dir-4087-basis', {
    _readCoordOpJournal: () => [{}],
    _computeCoordOpStats: () => ({
      summary: { doneSampleCount: 50, p95Ms: 800, p95DoneMs: 15000 },
    }),
  });
  assert.equal(ms, 15000, 'must use p95DoneMs, not the all-close-reasons p95Ms');
});

test('derivedReadTimeoutMs: memoised per dir within the TTL — the journal is parsed at most once per dir', () => {
  let reads = 0;
  const seams = {
    _readCoordOpJournal: () => {
      reads++;
      return [{}];
    },
    _computeCoordOpStats: () => ({ summary: { doneSampleCount: 50, p95DoneMs: 9000 } }),
  };
  const dir = '/journal-dir-4087-F-memo';
  assert.equal(derivedReadTimeoutMs(dir, seams), 9000);
  assert.equal(derivedReadTimeoutMs(dir, seams), 9000);
  assert.equal(derivedReadTimeoutMs(dir, seams), 9000);
  assert.equal(reads, 1, 'a hot caller must not re-parse the journal on every read');
});

// plan 4087 T4 review fix 1mtmw9g: the cache used to live for the rest of the process. A fake
// clock proves the TTL actually re-derives once it expires, and stays cached (one read) within it
// -- both halves of the fix, on the SAME dir so a per-dir cache-entry bug couldn't hide either one.
test('derivedReadTimeoutMs: re-derives after DERIVED_READ_TIMEOUT_CACHE_MAX_AGE_MS, not forever (plan 4087 T4 review fix 1mtmw9g)', () => {
  let reads = 0;
  let nowMs = 1_000_000;
  const seams = {
    _readCoordOpJournal: () => {
      reads++;
      return [{}];
    },
    _computeCoordOpStats: () => ({
      summary: { doneSampleCount: 50, p95DoneMs: reads === 1 ? 6000 : 20000 },
    }),
    _now: () => nowMs,
  };
  const dir = '/journal-dir-4087-ttl';
  assert.equal(derivedReadTimeoutMs(dir, seams), 6000);
  nowMs += 60_000; // well inside the 5-minute TTL
  assert.equal(derivedReadTimeoutMs(dir, seams), 6000, 'still cached, well inside the TTL');
  assert.equal(reads, 1, 'must not have re-read within the TTL');
  nowMs += 5 * 60 * 1000 + 1; // just past the TTL
  assert.equal(
    derivedReadTimeoutMs(dir, seams),
    20000,
    'must re-derive (and pick up the new measurement) once the TTL has elapsed',
  );
  assert.equal(reads, 2, 'must have re-read exactly once after the TTL elapsed');
});

test('derivedReadTimeoutMs: a DIFFERENT dir gets its own cache entry, never a stale value from another repo', () => {
  const ms1 = derivedReadTimeoutMs('/journal-dir-4087-G1', {
    _readCoordOpJournal: () => [{}],
    _computeCoordOpStats: () => ({ summary: { doneSampleCount: 50, p95DoneMs: 7000 } }),
  });
  const ms2 = derivedReadTimeoutMs('/journal-dir-4087-G2', {
    _readCoordOpJournal: () => [{}],
    _computeCoordOpStats: () => ({ summary: { doneSampleCount: 50, p95DoneMs: 22000 } }),
  });
  assert.equal(ms1, 7000);
  assert.equal(ms2, 22000);
});

// ── plan 4087 round-3 review (finding 2, keys 270fdc/1ec367/altitude): readCoordOpJournalForStats
// bounds its archive window by SAMPLE SIZE, not a fixed day count — a fixed window can hand
// derivedReadTimeoutMs a thin or empty sample on a sparse day or right after a fresh rotation.
//
// plan 4087 round-4 review (keys d54f6a/12e2ce/c20dbe): the growth loop used to (a) stop on
// `closedBy.done` — every `done`-reason close, including ones with an unparseable/inverted
// timestamp that never entered a duration sample at all — rather than the sample size the p95 is
// actually computed over, and (b) grow by re-calling `collectJournalEntries` with an ever-larger
// `maxArchives`, which re-read every archive already in the window again from disk on every step.
// The three tests below now key on `doneSampleCount` (the real sample size) and pin fs reads
// directly via `_readFileSync`, asserting each path is fetched AT MOST ONCE regardless of how many
// growth steps it takes — the thing a `_collectJournalEntries`-based seam could not observe, since
// that function did its own internal re-reading a layer below the seam.
test('readCoordOpJournalForStats: grows the archive window newest-first, one at a time, until the USABLE done sample reaches the minimum — reading each archive at most once', () => {
  const r = makeRepo();
  try {
    const livePath = coordOpJournalPath(r.dir);
    const linesOf = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}-${i}`).join('\n');
    // Newest-first pull order is a4, a3, a2, a1, a0 — cumulative sample size (live=5) crosses 30
    // (DERIVED_READ_TIMEOUT_MIN_SAMPLE) exactly at a2 (5+7+12+40=64 >= 30), so a1/a0 must never be
    // read at all.
    const contentFor = {
      [livePath]: linesOf(5, 'live'),
      a4: linesOf(7, 'a4'),
      a3: linesOf(12, 'a3'),
      a2: linesOf(40, 'a2'),
      a1: linesOf(999, 'a1'), // must never be read
      a0: linesOf(999, 'a0'), // must never be read
    };
    const reads = [];
    const seams = {
      _listArchiveJournalPaths: () => ['a0', 'a1', 'a2', 'a3', 'a4'], // oldest-first, per contract
      _readFileSync: (p) => {
        reads.push(p);
        return contentFor[p];
      },
      _parseJournalText: (text) => ({ entries: text ? text.split('\n').filter(Boolean) : [] }),
      _computeCoordOpStats: (entries) => ({ summary: { doneSampleCount: entries.length } }),
    };
    const entries = readCoordOpJournalForStats(r.dir, seams);
    assert.deepEqual(
      reads,
      [livePath, 'a4', 'a3', 'a2'],
      'live file once, then a4/a3/a2 newest-first, each read exactly once — a1/a0 never touched',
    );
    assert.equal(entries.length, 64, 'the window that satisfied the minimum (5+7+12+40)');
  } finally {
    r.cleanup();
  }
});

test('readCoordOpJournalForStats: stops growing once the archive history runs out, even below the minimum sample — never re-reading an archive already pulled in', () => {
  const r = makeRepo();
  try {
    const livePath = coordOpJournalPath(r.dir);
    const contentFor = { [livePath]: 'live-0', a0: 'a0-0', a1: 'a1-0' }; // 1 line each -- always thin
    const reads = [];
    const seams = {
      _listArchiveJournalPaths: () => ['a0', 'a1'], // only 2 archives exist, ever
      _readFileSync: (p) => {
        reads.push(p);
        return contentFor[p];
      },
      _parseJournalText: (text) => ({ entries: text ? text.split('\n').filter(Boolean) : [] }),
      _computeCoordOpStats: (entries) => ({ summary: { doneSampleCount: entries.length } }),
    };
    const entries = readCoordOpJournalForStats(r.dir, seams);
    assert.deepEqual(
      reads,
      [livePath, 'a1', 'a0'],
      'grows newest-first until every archive on disk is included, then stops -- never loops forever, never re-reads',
    );
    assert.equal(entries.length, 3);
  } finally {
    r.cleanup();
  }
});

test('readCoordOpJournalForStats: no archives on disk reads just the live file, no growth attempted', () => {
  const r = makeRepo();
  try {
    const livePath = coordOpJournalPath(r.dir);
    const reads = [];
    const seams = {
      _listArchiveJournalPaths: () => [],
      _readFileSync: (p) => {
        reads.push(p);
        return 'live-0\nlive-1';
      },
      _parseJournalText: (text) => ({ entries: text ? text.split('\n').filter(Boolean) : [] }),
      _computeCoordOpStats: (entries) => ({ summary: { doneSampleCount: entries.length } }),
    };
    const entries = readCoordOpJournalForStats(r.dir, seams);
    assert.deepEqual(reads, [livePath], 'no archives -- only the live file is ever read');
    assert.equal(entries.length, 2);
  } finally {
    r.cleanup();
  }
});

test('lsRemoteTimed: the default timeout comes from derivedReadTimeoutMs, not a bare constant', () => {
  const dir = '/journal-dir-4087-lsrt-wiring';
  const primed = derivedReadTimeoutMs(dir, {
    _readCoordOpJournal: () => [{}],
    _computeCoordOpStats: () => ({ summary: { doneSampleCount: 50, p95DoneMs: 18000 } }),
  });
  assert.equal(primed, 18000); // sanity on the priming call itself
  let seenTimeout;
  const fakeGit = (_dir, _args, opts) => {
    seenTimeout = opts.timeout;
    return '';
  };
  lsRemoteTimed(dir, 'refs/claims/9999', { _git: fakeGit });
  assert.equal(
    seenTimeout,
    18000,
    'lsRemoteTimed must reuse the SAME cached derived cap for this dir, never a hardcoded 5000',
  );
});

// --- lsRemoteTimed (plan 1475 item 3: shared cap, now DERIVED — plan 4087 T2 above) -------------

test('lsRemoteTimed passes ref + a default timeout to git and returns its stdout (ceiling, for a dir with no journal)', () => {
  const calls = [];
  const fake = (dir, args, opts) => {
    calls.push({ dir, args, opts });
    return 'sha\trefs/claims/1400\n';
  };
  const out = lsRemoteTimed('/repo', 'refs/claims/*', { _git: fake });
  assert.equal(out, 'sha\trefs/claims/1400\n');
  assert.deepEqual(calls, [
    { dir: '/repo', args: ['ls-remote', 'origin', 'refs/claims/*'], opts: { timeout: 30000 } },
  ]);
});

test('lsRemoteTimed allows a custom timeout override', () => {
  let seen;
  const fake = (_dir, _args, opts) => {
    seen = opts;
    return '';
  };
  lsRemoteTimed('/repo', 'refs/claims/1400', { _git: fake, timeout: 1234 });
  assert.deepEqual(seen, { timeout: 1234 });
});

// --- isNonFastForward / pushMasterWithRebase (divergence tolerance) -----------

test('isNonFastForward recognises reject + ff-abort wording, not other errors', () => {
  assert.equal(
    isNonFastForward({ stderr: '! [rejected]        master -> master (fetch first)' }),
    true,
  );
  assert.equal(
    isNonFastForward({ message: 'Updates were rejected because ... non-fast-forward' }),
    true,
  );
  assert.equal(
    isNonFastForward({ stderr: 'fatal: Not possible to fast-forward, aborting.' }),
    true,
  );
  assert.equal(
    isNonFastForward({ stderr: 'error: failed to push some refs (pre-push hook)' }),
    false,
  );
  assert.equal(isNonFastForward({}), false);
});

test('makePushFn and stamp-lib route ff-abort wording through isNonFastForward', () => {
  const coordSource = readFileSync(new URL('./coord-git.mjs', import.meta.url), 'utf8');
  const makePushFnSource = coordSource.slice(coordSource.indexOf('export function makePushFn'));
  assert.match(makePushFnSource, /if \(isNonFastForward\(e\)\)/);
  assert.doesNotMatch(makePushFnSource, /\/non-fast-forward\|fetch first\|rejected\/i/);

  const stampSource = readFileSync(new URL('./stamp-lib.mjs', import.meta.url), 'utf8');
  assert.match(stampSource, /if \(isNonFastForward\(e\)\)/);
  assert.doesNotMatch(stampSource, /\/non-fast-forward\|fetch first\|rejected\/i/);

  assert.equal(
    isNonFastForward({ stderr: 'fatal: Not possible to fast-forward, aborting.' }),
    true,
  );
});

// --- plan 868: the FETCH_HEAD multi-branch race classifier + resilient ff-sync ---

test('isMultiBranchFastForward recognises the multi-branch race, not other errors', () => {
  // the exact wording git emits (observed twice during the session-818 pickup)
  assert.equal(
    isMultiBranchFastForward({ stderr: 'fatal: Cannot fast-forward to multiple branches.\n' }),
    true,
  );
  assert.equal(
    isMultiBranchFastForward({ message: 'Cannot fast-forward to multiple branches' }),
    true,
  );
  // a plain non-ff / ff-abort is a DIFFERENT, separately-handled condition
  assert.equal(
    isMultiBranchFastForward({ stderr: 'fatal: Not possible to fast-forward, aborting.' }),
    false,
  );
  assert.equal(isMultiBranchFastForward({}), false);
});

test('isNonFastForward does NOT match the multi-branch race (the two are distinct)', () => {
  // the regression that left it unretried: the multi-branch error is not a non-ff, so
  // neither isNonFastForward nor withRetry/pushMasterWithRebase ever caught it.
  assert.equal(
    isNonFastForward({ stderr: 'fatal: Cannot fast-forward to multiple branches.' }),
    false,
  );
});

test('ffMasterFromOrigin retries the multi-branch race then succeeds', () => {
  let calls = 0;
  let slept = 0;
  ffMasterFromOrigin('/unused', {
    attempts: 5,
    _sleep: () => slept++,
    _ffStep: () => {
      if (++calls < 3) throw new Error('fatal: Cannot fast-forward to multiple branches.');
    },
  });
  assert.equal(calls, 3, 'retried twice then succeeded');
  assert.equal(slept, 2, 'backed off once per retry');
});

test('ffMasterFromOrigin surfaces a non-multi-branch error immediately (no retry)', () => {
  let calls = 0;
  assert.throws(
    () =>
      ffMasterFromOrigin('/unused', {
        _sleep: () => {},
        _ffStep: () => {
          calls++;
          throw new Error('fatal: Not possible to fast-forward, aborting.');
        },
      }),
    /Not possible to fast-forward/,
  );
  assert.equal(calls, 1, 'a non-race error is never retried');
});

test('ffMasterFromOrigin throws a clean error after exhausting attempts', () => {
  assert.throws(
    () =>
      ffMasterFromOrigin('/unused', {
        attempts: 3,
        _sleep: () => {},
        _ffStep: () => {
          throw new Error('fatal: Cannot fast-forward to multiple branches.');
        },
      }),
    /multi-branch race after 3 attempts/,
  );
});

test('ffMasterFromOrigin: fast-forwards local master to a diverged origin (real git)', () => {
  const s = makeOriginAndClones();
  try {
    // A advances origin; B is now behind. ffMasterFromOrigin(B) must ff B's master.
    s.commit(s.A, 'a.txt', 'A-change');
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);
    ffMasterFromOrigin(s.B);
    assert.match(
      execFileSync('git', ['-C', s.B, 'log', '--oneline', 'master'], { encoding: 'utf8' }),
      /A-change/,
      "B's local master must have fast-forwarded to include A's commit",
    );
  } finally {
    s.cleanup();
  }
});

test('isForeignDirtRefusal recognises the assertCleanOutsidePathspec refusal, not other errors', () => {
  // The real message, as it reaches a caller via a board.mjs subprocess (plan 618).
  assert.equal(
    isForeignDirtRefusal({
      stderr:
        'coordWrite(board): refusing to run — the main checkout has uncommitted changes to ' +
        "tracked file(s) OUTSIDE this tool's pathspec:\n  M handoff/sessions/x.md",
    }),
    true,
  );
  assert.equal(
    isForeignDirtRefusal({
      message: "refusing to run … OUTSIDE this tool's pathspec",
    }),
    true,
  );
  // A non-ff rejection is a DIFFERENT, separately-retried condition — not foreign dirt.
  assert.equal(
    isForeignDirtRefusal({ stderr: '! [rejected]        master -> master (fetch first)' }),
    false,
  );
  assert.equal(isForeignDirtRefusal({}), false);
});

// Bare origin + two clones (A = a parallel session, B = our drain). A pushes
// after B is already committed → B's push is non-ff → pushMasterWithRebase must
// fetch+rebase and land B's commit without losing A's. This is the exact wedge
// that killed pass-3 (origin diverged mid-iteration).
function makeOriginAndClones() {
  const root = mkdtempSync(join(tmpdir(), 'coord-git-rebase-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  const clone = (name) => {
    const dir = join(root, name);
    execFileSync('git', ['clone', '-q', origin, dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.email', `${name}@t.t`]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', name]);
    return dir;
  };
  const commit = (dir, file, msg) => {
    writeFileSync(join(dir, file), `${msg}\n`);
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', msg]);
  };
  const log = (dir, ref = 'origin/master') =>
    execFileSync('git', ['-C', dir, 'log', '--oneline', ref], { encoding: 'utf8' });
  // seed master from A so the bare origin has a master branch
  const A = clone('A');
  commit(A, 'base.txt', 'base');
  execFileSync('git', ['-C', A, 'push', '-q', 'origin', 'master']);
  const B = clone('B');
  return { root, A, B, commit, log, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('pushMasterWithRebase: lands our commit onto a diverged origin (rebase-retry)', () => {
  const s = makeOriginAndClones();
  try {
    // B commits locally...
    s.commit(s.B, 'b.txt', 'B-change');
    // ...then A pushes first, so B is now behind origin (its push will be non-ff).
    s.commit(s.A, 'a.txt', 'A-change');
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);

    pushMasterWithRebase(s.B); // must fetch + rebase + push, not throw

    const log = s.log(s.B);
    assert.match(log, /A-change/, "origin must keep the parallel session's commit");
    assert.match(log, /B-change/, 'origin must gain our rebased commit');
  } finally {
    s.cleanup();
  }
});

test('pushMasterWithRebase: no-op fast-forward push when origin has not moved', () => {
  const s = makeOriginAndClones();
  try {
    s.commit(s.B, 'b.txt', 'B-only');
    pushMasterWithRebase(s.B); // clean ff — succeeds first try
    assert.match(s.log(s.B), /B-only/);
  } finally {
    s.cleanup();
  }
});

test('pushMasterWithRebase: throws (not a non-ff) when origin is unreachable', () => {
  const s = makeOriginAndClones();
  try {
    s.commit(s.B, 'b.txt', 'B-change');
    rmSync(join(s.root, 'origin.git'), { recursive: true, force: true }); // kill origin
    assert.throws(() => pushMasterWithRebase(s.B, { retries: 1 }));
  } finally {
    s.cleanup();
  }
});

// --- coordWrite (the single sanctioned shared-doc write path, plan 421) --------
// Bare origin + a working clone (`dir`) seeded with a master branch, plus a
// `cloneOf(origin)` helper for simulating a parallel session. The sibling clones
// live under the same root so makeBareOrigin's cleanup removes them too.
function makeBareOrigin() {
  const root = mkdtempSync(join(tmpdir(), 'coord-write-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  const dir = join(root, 'work');
  execFileSync('git', ['clone', '-q', origin, dir]);
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('config', 'user.email', 'work@t.t');
  g('config', 'user.name', 'work');
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  g('add', 'base.txt');
  g('commit', '-qm', 'base');
  g('push', '-q', 'origin', 'master');
  g('branch', '--set-upstream-to=origin/master', 'master');
  return { dir, origin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function cloneOf(origin) {
  const dir = mkdtempSync(join(dirname(origin), 'sib-'));
  execFileSync('git', ['clone', '-q', origin, dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'sib@t.t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'sib']);
  return dir;
}

test('backoffMs returns 50–100% of the capped exponential', () => {
  // attempt 0: exp = base*1 = 150 → range [75, 150)
  for (let i = 0; i < 50; i++) {
    const v = backoffMs(0, { base: 150, cap: 2000 });
    assert.ok(v >= 75 && v <= 150, `attempt 0 backoff out of range: ${v}`);
  }
  // attempt 6 would be 150*64=9600 but capped at 2000 → range [1000, 2000)
  for (let i = 0; i < 50; i++) {
    const v = backoffMs(6, { base: 150, cap: 2000 });
    assert.ok(v >= 1000 && v <= 2000, `attempt 6 backoff out of range: ${v}`);
  }
});

test('coordWrite: commits the pathspec with a Coord-Write trailer and pushes', () => {
  const { dir, origin, cleanup } = makeBareOrigin();
  try {
    coordWrite(dir, {
      relPaths: ['f.txt'],
      mutate: () => writeFileSync(join(dir, 'f.txt'), 'hello\n'),
      message: 'test: write f',
      tool: 'unit',
    });
    const log = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%B'], { encoding: 'utf8' });
    assert.match(log, new RegExp(`${COORD_TRAILER}: unit`));
    const remote = execFileSync('git', ['-C', dir, 'ls-remote', origin, 'refs/heads/master'], {
      encoding: 'utf8',
    });
    assert.ok(remote.trim().length > 0);
  } finally {
    cleanup();
  }
});

test('coordWrite: a sibling commit landed on origin between read and push is absorbed silently (re-mutate on fresh base, no throw)', () => {
  const { dir, origin, cleanup } = makeBareOrigin();
  try {
    // simulate a sibling: a SECOND clone pushes an unrelated file to origin/master
    const sib = cloneOf(origin);
    writeFileSync(join(sib, 'sibling.txt'), 'theirs\n');
    execFileSync('git', ['-C', sib, 'add', 'sibling.txt']);
    execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling']);
    execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
    // our coordWrite must NOT throw — it freshens onto the sibling tip and lands
    coordWrite(dir, {
      relPaths: ['ours.txt'],
      mutate: () => writeFileSync(join(dir, 'ours.txt'), 'ours\n'),
      message: 'test: write ours',
      tool: 'unit',
    });
    // final origin tree has BOTH files
    execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync('git', ['-C', dir, 'ls-tree', '--name-only', 'origin/master'], {
      encoding: 'utf8',
    });
    assert.match(tree, /sibling\.txt/);
    assert.match(tree, /ours\.txt/);
  } finally {
    cleanup();
  }
});

test('coordWrite: mutate is re-run on each attempt so generated content reflects the fresh tip', () => {
  // mutate writes the CURRENT origin/master short-sha into the file; after a sibling
  // lands, the re-run must capture the NEW sha (proves re-mutate, not stale first-run).
  const { dir, origin, cleanup } = makeBareOrigin();
  try {
    const sib = cloneOf(origin);
    let pushedSibling = false;
    coordWrite(dir, {
      relPaths: ['gen.txt'],
      mutate: () => {
        if (!pushedSibling) {
          writeFileSync(join(sib, 's.txt'), 'x\n');
          execFileSync('git', ['-C', sib, 'add', 's.txt']);
          execFileSync('git', ['-C', sib, 'commit', '-qm', 's']);
          execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
          pushedSibling = true; // force exactly one non-ff on the first push
        }
        const head = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
          encoding: 'utf8',
        }).trim();
        writeFileSync(join(dir, 'gen.txt'), head + '\n');
      },
      message: 'test: gen',
      tool: 'unit',
    });
    // first push rejects (sibling landed during mutate); retry re-mutates on the fresh
    // base, so gen.txt's recorded HEAD reflects the post-merge tip — assert the file is
    // non-empty and the push ultimately succeeded.
    const committed = readFileSync(join(dir, 'gen.txt'), 'utf8').trim();
    assert.ok(committed.length >= 7);
  } finally {
    cleanup();
  }
});

// Mixed relPaths (a NEW file + an EXISTING tracked file) recovering from a non-ff —
// this is next-plan-id's exact shape ([new plan file, docs/INDEX.md]). After the
// undone commit, `reset --soft` keeps the new file STAGED, so revertPathsToHead's
// `restore --source=HEAD` matches it (removes it) and reverts the existing file —
// the worktree is left clean for the next attempt's `merge --ff-only`. A buggy
// revert that left the existing file dirty would wedge every retry on a stale base
// and exhaust the budget (coordWrite would throw). Asserts both edits land.
test('coordWrite: mixed new+existing relPaths recover from a non-ff and both land (no wedge)', () => {
  const { dir, origin, cleanup } = makeBareOrigin();
  try {
    // seed an EXISTING tracked file on origin
    writeFileSync(join(dir, 'existing.txt'), 'orig\n');
    execFileSync('git', ['-C', dir, 'add', 'existing.txt']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'add existing']);
    execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'master']);
    const sib = cloneOf(origin);
    let pushedSibling = false;
    coordWrite(dir, {
      relPaths: ['newfile.txt', 'existing.txt'],
      mutate: () => {
        if (!pushedSibling) {
          writeFileSync(join(sib, 'sib.txt'), 's\n');
          execFileSync('git', ['-C', sib, 'add', 'sib.txt']);
          execFileSync('git', ['-C', sib, 'commit', '-qm', 's']);
          execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
          pushedSibling = true; // force exactly one non-ff on the first push
        }
        writeFileSync(join(dir, 'newfile.txt'), 'NEW\n'); // new path
        writeFileSync(join(dir, 'existing.txt'), 'EDITED\n'); // idempotent edit of an in-HEAD path
      },
      message: 'test: mixed',
      tool: 'unit',
      attempts: 8,
    });
    execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync('git', ['-C', dir, 'ls-tree', '--name-only', 'origin/master'], {
      encoding: 'utf8',
    });
    assert.match(tree, /newfile\.txt/, 'the new file must land');
    assert.match(tree, /sib\.txt/, "the sibling's file must survive");
    const existing = execFileSync('git', ['-C', dir, 'show', 'origin/master:existing.txt'], {
      encoding: 'utf8',
    });
    assert.equal(
      existing,
      'EDITED\n',
      'the in-HEAD file edit must land (revert left it clean for the retry)',
    );
  } finally {
    cleanup();
  }
});

// A mutate that yields content IDENTICAL to the freshened base (a no-op: the
// desired state already exists — a sibling applied an equivalent edit, or it's a
// redundant set-state) must NOT crash on an empty `git commit`. coordWrite detects
// nothing-staged and returns cleanly (noop:true) instead of throwing.
test('coordWrite: a no-op mutate (content already matches the base) returns cleanly, no empty-commit crash', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    // base.txt already exists with 'base\n'; mutate writes the SAME content → nothing staged
    const res = coordWrite(dir, {
      relPaths: ['base.txt'],
      mutate: () => writeFileSync(join(dir, 'base.txt'), 'base\n'),
      message: 'test: noop',
      tool: 'unit',
    });
    assert.equal(res.noop, true, 'a no-op write should report noop');
  } finally {
    cleanup();
  }
});

// --- plan 1578: coordWrite verifies the push actually reached origin -----------
// A real bare origin + a real clone (makeBareOrigin), but the `push` verb itself is faked to
// report success WITHOUT actually contacting origin — everything else (commit, ls-remote,
// fetch, merge-base) runs through REAL git against the REAL bare origin, so
// assertPushReachedOrigin's own git calls observe the genuine (unpushed) state of origin, not a
// mock. This reproduces the plan-1384/1508 class this generalizes: a local `git push` that
// reports success while origin silently never received it.
function fakePushGit(realOrigin) {
  return (dir, args, opts) => {
    if (args[0] === 'push') return ''; // pretend success — never actually contacts origin
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', ...opts });
  };
}

test('coordWrite: throws (pushUnverified) when the push locally "succeeds" but never reached origin', () => {
  const { dir, origin, cleanup } = makeBareOrigin();
  try {
    assert.throws(
      () =>
        coordWrite(dir, {
          relPaths: ['f.txt'],
          mutate: () => writeFileSync(join(dir, 'f.txt'), 'hello\n'),
          message: 'test: write f',
          tool: 'unit',
          _git: fakePushGit(origin),
        }),
      (e) => {
        assert.equal(e.pushUnverified, true, 'error must be tagged .pushUnverified');
        assert.match(e.message, /did NOT reach origin|does NOT contain it/i);
        return true;
      },
    );
    // origin genuinely never received the commit (the fake push never contacted it)
    const tree = execFileSync('git', ['-C', dir, 'ls-remote', origin, 'refs/heads/master'], {
      encoding: 'utf8',
    });
    const remoteSha = tree.split('\t')[0].trim();
    const localSha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    assert.notEqual(remoteSha, localSha, 'origin must NOT have our commit — the push was faked');
  } finally {
    cleanup();
  }
});

test('assertPushReachedOrigin: passes silently when the push genuinely reached origin', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    coordWrite(dir, {
      relPaths: ['ok.txt'],
      mutate: () => writeFileSync(join(dir, 'ok.txt'), 'fine\n'),
      message: 'test: real push',
      tool: 'unit',
    });
    // no throw ⇒ the verify passed; sanity-check origin genuinely has the file
    const tree = execFileSync('git', ['-C', dir, 'ls-tree', '--name-only', 'HEAD'], {
      encoding: 'utf8',
    });
    assert.match(tree, /ok\.txt/);
  } finally {
    cleanup();
  }
});

test('assertPushReachedOrigin: tolerates a SIBLING push landing past ours (ancestor, not exact tip)', () => {
  // Directly unit-test the primitive: our sha is an ancestor of origin/master's CURRENT tip
  // (a sibling pushed after us) — must NOT throw, since our commit did genuinely reach origin.
  const { dir, origin, cleanup } = makeBareOrigin();
  try {
    const ourSha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const sib = cloneOf(origin);
    writeFileSync(join(sib, 'sib.txt'), 'theirs\n');
    execFileSync('git', ['-C', sib, 'add', 'sib.txt']);
    execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling advances past us']);
    execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
    // our local HEAD is unchanged (still ourSha) but origin/master has moved past it
    assert.doesNotThrow(() =>
      assertPushReachedOrigin(dir, 'master', { ...process.env, HUSKY: '0' }),
    );
    const headNow = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(headNow, ourSha, 'sanity: our local HEAD did not move');
  } finally {
    cleanup();
  }
});

// --- plan 2580: assertPushReachedOrigin's `label` names the CALLER in every throw ----------
// Used to be hardcoded "coordWrite:" (see the plan-2580 header comment above the export) —
// coordEditApply now passes its own label so a push-verify failure is attributable to the
// right tool instead of misdirecting debugging toward coordWrite/board.mjs.
test('plan 2580: assertPushReachedOrigin honors a custom label, and defaults to "coordWrite"', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    // A commit that exists locally but was never pushed — origin's ref update never happened,
    // so this hits the "does NOT contain it" throw (the message body assertPushReachedOrigin's
    // unit tests already exercise elsewhere; here we only care about the `label:` prefix).
    writeFileSync(join(dir, 'never.txt'), 'unpushed\n');
    execFileSync('git', ['-C', dir, 'add', 'never.txt']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'never pushed']);
    assert.throws(
      () => assertPushReachedOrigin(dir, 'master', { ...process.env }, { label: 'coordEditApply' }),
      (e) => {
        assert.equal(e.pushUnverified, true);
        assert.match(e.message, /^coordEditApply: /, 'custom label replaces the hardcoded prefix');
        return true;
      },
    );
    assert.throws(
      () => assertPushReachedOrigin(dir, 'master', { ...process.env }),
      (e) => {
        assert.equal(e.pushUnverified, true);
        assert.match(e.message, /^coordWrite: /, 'the default label is unchanged: "coordWrite"');
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

// --- plan 2580: assertNoopReachedOrigin — Gap 3 of plan 2572, unit-level -------------------
// Proves a no-op against origin BEFORE a caller reports {noop:true}. The property tested is
// deliberately about the PATHS, not about HEAD: "does origin already carry the content we are
// about to report as landed" (review 2026-07-28, finding 1 — see the regression test below for
// why HEAD-containment was the wrong question).
test('plan 2580: assertNoopReachedOrigin returns silently when origin already carries our content', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    // makeBareOrigin's fixture already pushed base.txt to origin — the ordinary case.
    assert.doesNotThrow(() =>
      assertNoopReachedOrigin(dir, 'master', { ...process.env }, { relPaths: ['base.txt'] }),
    );
  } finally {
    cleanup();
  }
});

test('plan 2580: assertNoopReachedOrigin throws when origin does NOT carry our content for the paths', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    writeFileSync(join(dir, 'local-only.txt'), 'x\n');
    execFileSync('git', ['-C', dir, 'add', 'local-only.txt']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'never pushed']);
    assert.throws(
      () =>
        assertNoopReachedOrigin(
          dir,
          'master',
          { ...process.env },
          { relPaths: ['local-only.txt'], label: 'coordEditApply' },
        ),
      (e) => {
        assert.equal(e.pushUnverified, true, 'must be the pushUnverified class, not a silent pass');
        assert.match(e.message, /^coordEditApply: refusing to report a no-op/);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

// REGRESSION (review 2026-07-28, finding 1). The first cut of this guard asked "is HEAD an
// ancestor of origin/master", which is a STRICTER question than the one that matters: it also
// fails whenever the checkout happens to carry local commits touching OTHER paths. The sharpest
// real instance is done-worktree's DETACHED finish worktree, whose HEAD is the not-yet-pushed
// merge commit — every coord no-op there would have started throwing a hard pushUnverified error
// on a path that had always succeeded locally. Comparing the PATHS is immune to that.
test('plan 2580: assertNoopReachedOrigin ignores unrelated unpushed commits (no false alarm)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    // An unpushed local commit touching a path we are NOT asking about.
    writeFileSync(join(dir, 'unrelated.txt'), 'local work\n');
    execFileSync('git', ['-C', dir, 'add', 'unrelated.txt']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'unrelated unpushed work']);
    // base.txt is byte-identical to origin's copy, so this IS a genuine no-op for base.txt —
    // HEAD being ahead of origin is none of this guard's business.
    assert.doesNotThrow(() =>
      assertNoopReachedOrigin(dir, 'master', { ...process.env }, { relPaths: ['base.txt'] }),
    );
  } finally {
    cleanup();
  }
});

test('plan 2580: assertNoopReachedOrigin returns silently when the repo has no origin remote at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-git-noop-noorigin-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'master', dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t.t']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
    writeFileSync(join(dir, 'f.txt'), 'x\n');
    execFileSync('git', ['-C', dir, 'add', 'f.txt']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'init']);
    // No `origin` remote configured at all — nothing to verify against, and a real land here
    // would fail at the push, so this is unit-test/scratch territory, not the shared coord
    // checkout the guard is protecting.
    assert.doesNotThrow(() =>
      assertNoopReachedOrigin(dir, 'master', { ...process.env }, { relPaths: ['f.txt'] }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- plan 487: refuse to freshen over a foreign uncommitted edit -------------
// The freshen is `git fetch` + `git merge --ff-only origin/master` (coord-git.mjs,
// the top of coordWrite's loop). It is NON-destructive — git ABORTS rather than
// discarding a dirty file — but that abort is SWALLOWED by the catch, so a parallel
// session editing a plan body directly in the shared main checkout gets no signal
// that a coord op is about to fight its uncommitted edit (and coordWrite then either
// proceeds on a stale base or burns its whole retry budget with a misleading "origin
// kept advancing" error). The guard fails LOUD and EARLY instead, naming the file.
test('coordWrite: refuses loudly when the main checkout has an UNSTAGED edit OUTSIDE its pathspec', () => {
  const { dir, origin, cleanup } = makeBareOrigin();
  try {
    // a tracked "plan body", committed + pushed
    writeFileSync(join(dir, 'plan.md'), 'original\n');
    execFileSync('git', ['-C', dir, 'add', 'plan.md']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'add plan']);
    execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'master']);
    // a session leaves an UNCOMMITTED edit to plan.md (the 2026-06-09 478 scope note)
    writeFileSync(join(dir, 'plan.md'), 'original\nUNCOMMITTED SCOPE NOTE\n');
    // a coordWrite for a DIFFERENT file must refuse, not freshen over the edit
    assert.throws(
      () =>
        coordWrite(dir, {
          relPaths: ['board.md'],
          mutate: () => writeFileSync(join(dir, 'board.md'), 'row\n'),
          message: 'test: board row',
          tool: 'board',
        }),
      /OUTSIDE this tool's pathspec[\s\S]*plan\.md/,
      'coordWrite must refuse when a foreign uncommitted edit is present',
    );
    // the foreign edit survives untouched, and nothing of ours was written/pushed
    assert.equal(readFileSync(join(dir, 'plan.md'), 'utf8'), 'original\nUNCOMMITTED SCOPE NOTE\n');
    assert.equal(existsSync(join(dir, 'board.md')), false, 'mutate must not have run');
    const tree = execFileSync('git', ['-C', dir, 'ls-tree', '--name-only', 'origin/master'], {
      encoding: 'utf8',
    });
    assert.doesNotMatch(tree, /board\.md/, 'nothing pushed when refusing');
  } finally {
    cleanup();
  }
});

test('coordWrite: refuses on a STAGED edit outside the pathspec too (staged or unstaged both count)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    writeFileSync(join(dir, 'plan.md'), 'original\n');
    execFileSync('git', ['-C', dir, 'add', 'plan.md']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'add plan']);
    execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'master']);
    // edit AND stage plan.md (status `M ` in the index column) — still foreign
    writeFileSync(join(dir, 'plan.md'), 'staged change\n');
    execFileSync('git', ['-C', dir, 'add', 'plan.md']);
    assert.throws(
      () =>
        coordWrite(dir, {
          relPaths: ['board.md'],
          mutate: () => writeFileSync(join(dir, 'board.md'), 'row\n'),
          message: 'test: board row',
          tool: 'board',
        }),
      /plan\.md/,
    );
    // the staged edit survives and nothing of ours ran (same invariant as the unstaged case)
    assert.equal(readFileSync(join(dir, 'plan.md'), 'utf8'), 'staged change\n');
    assert.equal(existsSync(join(dir, 'board.md')), false, 'mutate must not have run');
  } finally {
    cleanup();
  }
});

// The guard is a temporary STOP, not a permanent wedge: once the blocking edit is
// committed (the documented recovery), the very next coordWrite for the same pathspec
// proceeds normally. Pins that the refusal does not poison the tool on that file.
test('coordWrite: proceeds once the blocking edit is committed (guard is a stop, not a wedge)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    writeFileSync(join(dir, 'plan.md'), 'original\n');
    execFileSync('git', ['-C', dir, 'add', 'plan.md']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'add plan']);
    execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'master']);
    // foreign uncommitted edit → first attempt refuses
    writeFileSync(join(dir, 'plan.md'), 'original\nNOTE\n');
    const args = {
      relPaths: ['board.md'],
      mutate: () => writeFileSync(join(dir, 'board.md'), 'row\n'),
      message: 'test: board row',
      tool: 'board',
    };
    assert.throws(() => coordWrite(dir, args), /plan\.md/);
    // commit the blocking edit (the recovery the error message prescribes), then re-run
    execFileSync('git', ['-C', dir, 'add', 'plan.md']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'commit the note']);
    const res = coordWrite(dir, args);
    assert.ok(res.attempts >= 1, 'the write should now complete');
    assert.equal(readFileSync(join(dir, 'board.md'), 'utf8'), 'row\n');
  } finally {
    cleanup();
  }
});

// A staged rename whose paths are BOTH foreign must be caught — the guard checks both
// sides of an "orig -> dest" entry, not just the destination (R1-F2 from the review).
test('coordWrite: a staged rename of a foreign file is caught (both rename sides checked)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    writeFileSync(join(dir, 'a.md'), 'aaa\n');
    execFileSync('git', ['-C', dir, 'add', 'a.md']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'add a']);
    execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'master']);
    // stage a rename a.md -> b.md (porcelain "R  a.md -> b.md") — both sides foreign
    execFileSync('git', ['-C', dir, 'mv', 'a.md', 'b.md']);
    assert.throws(
      () =>
        coordWrite(dir, {
          relPaths: ['board.md'],
          mutate: () => writeFileSync(join(dir, 'board.md'), 'row\n'),
          message: 'test: board row',
          tool: 'board',
        }),
      /a\.md|b\.md/,
    );
  } finally {
    cleanup();
  }
});

// An UNTRACKED file outside the pathspec is NOT foreign dirt: it is not an "edit",
// and a fast-forward aborts rather than overwriting it (mirrors the pickup-plan GATE
// probe, which tolerates `??`). The guard uses `--untracked-files=no` so a stray
// scratch file never wedges a legitimate coord write.
test('coordWrite: an untracked file outside the pathspec does NOT block the write', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    writeFileSync(join(dir, 'scratch.tmp'), 'junk\n'); // untracked, not gitignored
    const res = coordWrite(dir, {
      relPaths: ['t.txt'],
      mutate: () => writeFileSync(join(dir, 't.txt'), 'ok\n'),
      message: 'test: write t',
      tool: 'unit',
    });
    assert.ok(res.attempts >= 1, 'the write should complete');
    assert.equal(readFileSync(join(dir, 't.txt'), 'utf8'), 'ok\n');
  } finally {
    cleanup();
  }
});

// Task 6 dogfood: the automated form of the manual two-terminal race. TWO real
// OS processes (coordWrite is synchronous, so genuine concurrency needs separate
// processes), each its OWN clone of one origin, both coordWrite an idempotent
// upsert into the SAME file at the same instant. Neither may throw; the loser
// must rebase silently and BOTH lines must end up on origin (no lost write).
test('coordWrite: two concurrent writers to the same file both land (silent rebase-retry, no lost write)', async () => {
  const { origin, dir, cleanup } = makeBareOrigin(); // dir = writer A's clone
  try {
    const B = cloneOf(origin); // writer B's clone
    const root = dirname(origin);
    const modUrl = new URL('./coord-git.mjs', import.meta.url).href;
    const fixture = join(root, 'race-writer.mjs');
    writeFileSync(
      fixture,
      [
        "import { readFileSync, writeFileSync, existsSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const { coordWrite } = await import(process.env.CW_MOD);',
        'const dir = process.env.CW_DIR, line = process.env.CW_LINE;',
        'coordWrite(dir, {',
        "  relPaths: ['shared.txt'],",
        '  mutate: () => {',
        "    const p = join(dir, 'shared.txt');",
        "    const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';",
        "    const lines = cur.split('\\n').filter(Boolean);",
        '    if (!lines.includes(line)) lines.push(line);',
        '    lines.sort();',
        "    writeFileSync(p, lines.join('\\n') + '\\n');",
        '  },',
        "  message: 'race ' + line, tool: 'race', attempts: 25,",
        '});',
        '',
      ].join('\n'),
    );
    const run = (writerDir, line) =>
      new Promise((res) => {
        const cp = spawn(process.execPath, [fixture], {
          env: { ...process.env, CW_MOD: modUrl, CW_DIR: writerDir, CW_LINE: line },
        });
        let err = '';
        cp.stderr.on('data', (d) => (err += d));
        cp.on('close', (code) => res({ code, err }));
      });
    const [ra, rb] = await Promise.all([run(dir, 'AAA'), run(B, 'BBB')]);
    assert.equal(ra.code, 0, `writer A threw: ${ra.err}`);
    assert.equal(rb.code, 0, `writer B threw: ${rb.err}`);
    execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin', 'master']);
    const final = execFileSync('git', ['-C', dir, 'show', 'origin/master:shared.txt'], {
      encoding: 'utf8',
    });
    assert.match(final, /AAA/, "writer A's line must survive on origin");
    assert.match(final, /BBB/, "writer B's line must survive on origin");
  } finally {
    cleanup();
  }
});

// ── plan 989: coord-write lock + disposable coord-checkout (isolate coord writes from MAIN) ──

test('acquireCoordLock: O_EXCL mutual exclusion — a fresh foreign holder is BUSY → times out (coordContention)', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-lock-'));
  const lockPath = join(root, 'coord-write.lock');
  try {
    assert.equal(
      acquireCoordLock(lockPath, 'tok-A', { sleep: () => {}, now: () => 1000 }),
      'tok-A',
    );
    // a DIFFERENT token cannot acquire while A holds a FRESH lock → BUSY → deadline → throw
    assert.throws(
      () => acquireCoordLock(lockPath, 'tok-B', { sleep: () => {}, now: () => 1000, timeoutMs: 0 }),
      (e) => e.coordContention === true && /coord-write lock held by tok-A/.test(e.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acquireCoordLock/releaseCoordLock: owner release frees it; a foreign release is a no-op', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-lock-'));
  const lockPath = join(root, 'coord-write.lock');
  try {
    acquireCoordLock(lockPath, 'mine', { now: () => 0 });
    releaseCoordLock(lockPath, 'other'); // foreign — must NOT remove
    assert.ok(existsSync(lockPath), 'foreign release left the lock intact');
    releaseCoordLock(lockPath, 'mine'); // owner — removes
    assert.ok(!existsSync(lockPath), 'owner release removed the lock');
    // freed → a new token acquires cleanly
    assert.equal(acquireCoordLock(lockPath, 'next', { now: () => 0 }), 'next');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acquireCoordLock: reclaims a holder older than staleMs (a crashed op never self-clears)', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-lock-'));
  const lockPath = join(root, 'coord-write.lock');
  try {
    acquireCoordLock(lockPath, 'crashed', { now: () => 0 }); // iso stamped at t=0
    // a live op far past the stale threshold reclaims the orphaned lock instead of wedging forever
    assert.equal(
      acquireCoordLock(lockPath, 'live', { sleep: () => {}, now: () => 100_000, staleMs: 1000 }),
      'live',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acquireCoordLock: an empty/unparseable lock at the deadline throws coordContention, not a TypeError', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-lock-'));
  const lockPath = join(root, 'coord-write.lock');
  try {
    writeFileSync(lockPath, ''); // the O_EXCL-create-before-JSON-write window, frozen empty
    assert.throws(
      // fresh mtime ⇒ BUSY (not reclaimed); timeoutMs:0 ⇒ immediate deadline. holder is null here —
      // the error message must not deref holder.token (the pre-fix TypeError).
      () => acquireCoordLock(lockPath, 'tok', { sleep: () => {}, timeoutMs: 0 }),
      (e) => e.coordContention === true && /empty\/unparseable/.test(e.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acquireCoordLock: a future-dated holder (cross-host clock skew) is NOT reclaimed — treated as live', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-lock-'));
  const lockPath = join(root, 'coord-write.lock');
  try {
    // a live sibling on a host whose clock is ahead stamps an iso in OUR future → negative age.
    writeFileSync(
      lockPath,
      JSON.stringify({
        token: 'live',
        pid: 1,
        host: 'B',
        iso: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    assert.throws(
      () => acquireCoordLock(lockPath, 'mine', { sleep: () => {}, timeoutMs: 0 }),
      (e) => e.coordContention === true,
    );
    assert.ok(existsSync(lockPath), 'the future-dated (skewed) live lock must NOT be reclaimed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acquireCoordLock: F-005 — the empty-lock age fallback uses the INJECTED clock, not wall-clock Date.now()', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-lock-'));
  const lockPath = join(root, 'coord-write.lock');
  try {
    writeFileSync(lockPath, ''); // the O_EXCL-create-before-JSON-write window, frozen empty
    // A constant clock far in the future relative to the file's REAL mtime. If the reclaim math
    // used the real Date.now() (the pre-fix bug) instead of this injected `now`, the age would
    // read near-zero (fresh) and the lock would never be reclaimed; with timeoutMs:0 the deadline
    // check (`now() >= deadline`, also injected) would then throw immediately instead of acquiring.
    const farFuture = Date.now() + 10_000_000;
    assert.equal(
      acquireCoordLock(lockPath, 'mine', {
        sleep: () => {},
        now: () => farFuture,
        staleMs: 1000,
        timeoutMs: 0,
      }),
      'mine',
      'the injected far-future clock must be used to age the empty lock, reclaiming it',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reclaimStaleLock: F-006 — a re-read mismatch means a racing reclaimer already acted; does NOT unlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-lock-'));
  const lockPath = join(root, 'coord-write.lock');
  try {
    writeFileSync(lockPath, 'holder-B-fresh-json'); // a racing reclaimer already replaced it
    const reclaimed = reclaimStaleLock(lockPath, 'holder-A-stale-json'); // captured BEFORE the race
    assert.equal(reclaimed, false, 'must not blindly unlink a lock that changed under us');
    assert.equal(
      readFileSync(lockPath, 'utf8'),
      'holder-B-fresh-json',
      "the racing reclaimer's fresh lock survives untouched",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reclaimStaleLock: removes the file when its content is unchanged since the staleness read', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-lock-'));
  const lockPath = join(root, 'coord-write.lock');
  try {
    writeFileSync(lockPath, 'holder-A-stale-json');
    assert.equal(reclaimStaleLock(lockPath, 'holder-A-stale-json'), true);
    assert.ok(!existsSync(lockPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reclaimStaleLock: an already-vanished lock is a harmless no-op (both sides null)', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-lock-'));
  const lockPath = join(root, 'coord-write.lock'); // never created
  try {
    assert.equal(reclaimStaleLock(lockPath, null), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acquireCoordLock: F-006 — two concurrent stale-reclaimers never both end up holding the lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-lock-'));
  const lockPath = join(root, 'coord-write.lock');
  try {
    // A crashed holder, long stale relative to the shared injected clock below.
    writeFileSync(
      lockPath,
      JSON.stringify({ token: 'crashed', pid: 1, host: 'H', iso: new Date(0).toISOString() }),
    );
    let bRan = false;
    // Intercepts A's reclaim step: right when A is about to reclaim the stale holder it just
    // read, let waiter B run to COMPLETION first — B reads the SAME stale holder, reclaims it
    // (via the real reclaimStaleLock), and creates its own fresh lock. This simulates the exact
    // race window F-006 closes. A's reclaim call then runs the REAL reclaimStaleLock with A's
    // now-stale `capturedRaw`, which must detect B's fresh lock underneath it and decline to
    // remove it — proving the pre-fix "blind unlink" regression is closed.
    const spy = (path, capturedRaw) => {
      if (!bRan) {
        bRan = true;
        const bToken = acquireCoordLock(lockPath, 'B', {
          sleep: () => {},
          now: () => 999_999,
          staleMs: 1000,
        });
        assert.equal(bToken, 'B', 'waiter B must win the race and acquire cleanly');
      }
      return reclaimStaleLock(path, capturedRaw);
    };
    let aThrew = false;
    try {
      acquireCoordLock(lockPath, 'A', {
        sleep: () => {},
        now: () => 999_999,
        staleMs: 1000,
        timeoutMs: 0,
        _reclaimStaleLock: spy,
      });
    } catch {
      aThrew = true; // A legitimately fails to acquire once B has already taken it — expected
    }
    assert.equal(aThrew, true, 'A must not silently succeed after B already holds the lock');
    // The decisive assertion: the lock file holds EXACTLY B's holder — never A's (which the
    // pre-fix unconditional unlink would have clobbered B's fresh lock to install), and never a
    // corrupt/merged state.
    const finalHolder = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(
      finalHolder.token,
      'B',
      "B's fresh lock (created first) must survive A's stale reclaim of the OLD holder",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withCoordCheckout: a coord write lands on origin, MAIN tracked tree UNTOUCHED (plan 989)', () => {
  const { dir, origin, cleanup } = makeBareOrigin();
  const saved = process.env.COORD_MAIN_DIR;
  delete process.env.COORD_MAIN_DIR;
  try {
    const cdirSeen = withCoordCheckout(dir, (cdir) => {
      assert.notEqual(cdir, dir, 'the write runs in the coord-checkout, never the MAIN tree');
      assert.equal(cdir, coordCheckoutPath(dir));
      coordWrite(cdir, {
        relPaths: ['c.txt'],
        mutate: () => writeFileSync(join(cdir, 'c.txt'), 'coord\n'),
        message: 'test: coord write via checkout',
        tool: 'unit',
      });
      return cdir;
    });
    // landed on origin/master
    const tree = execFileSync('git', ['-C', origin, 'ls-tree', '-r', '--name-only', 'master'], {
      encoding: 'utf8',
    });
    assert.match(tree, /(^|\n)c\.txt(\n|$)/, 'c.txt must be on origin/master');
    // MAIN's TRACKED working tree is clean — the write never touched it (the coord-checkout dir is
    // untracked noise here; in the real repo .claude/coord-worktree/ is gitignored)
    const status = execFileSync(
      'git',
      ['-C', dir, 'status', '--porcelain', '--untracked-files=no'],
      { encoding: 'utf8' },
    ).trim();
    assert.equal(status, '', 'MAIN tracked tree must be untouched by a coord write');
    assert.ok(!existsSync(join(dir, 'c.txt')), 'the coord doc must NOT appear in the MAIN tree');
    // the coord-write lock was released (finally)
    assert.ok(!existsSync(coordLockPath(dir)), 'coord-write lock released after the op');
    // crash-mid-op recovery: dirty the coord-checkout, then a fresh resolve resets it clean
    writeFileSync(join(cdirSeen, 'leftover.txt'), 'crash residue\n');
    writeFileSync(join(cdirSeen, 'c.txt'), 'half-written\n');
    const cdir2 = resolveCoordCheckout(dir);
    assert.ok(!existsSync(join(cdir2, 'leftover.txt')), 'reset --hard + clean drops crash residue');
    const status2 = execFileSync('git', ['-C', cdir2, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(status2, '', 'coord-checkout is a clean disposable tree at op start');
  } finally {
    if (saved !== undefined) process.env.COORD_MAIN_DIR = saved;
    cleanup();
  }
});

test('resolveCoordCheckout: a registered-but-corrupt coord-worktree (truncated HEAD) self-heals (plan 1606)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const cdir = resolveCoordCheckout(dir); // first use: creates + registers the coord-worktree
    assert.ok(existsSync(cdir), 'coord-worktree created on first use');
    // Corrupt the worktree's internal HEAD exactly like the plan-1606 discovery incident: truncated
    // to 0 bytes by an interrupted git op (the fork()-crash class already documented for
    // index.lock, hitting HEAD instead). isRegisteredWorktree + existsSync BOTH still pass here —
    // this is the gap isWorktreeLive exists to catch.
    const gitDir = execFileSync('git', ['-C', cdir, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
    }).trim();
    const headPath = join(gitDir, 'HEAD');
    assert.ok(existsSync(headPath), 'precondition: HEAD exists before corruption');
    writeFileSync(headPath, '');
    // Sanity on the fixture: the corruption actually breaks ordinary git ops in that dir.
    assert.throws(() =>
      execFileSync('git', ['-C', cdir, 'rev-parse', '--git-dir'], { encoding: 'utf8' }),
    );
    // resolveCoordCheckout must self-heal (prune + re-add fresh), not fatal on the corrupt dir.
    const healed = resolveCoordCheckout(dir);
    assert.equal(healed, cdir, 'same disposable path, freshly recreated');
    const status = execFileSync('git', ['-C', healed, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(status, '', 'healed coord-checkout is a clean tree at origin/master');
    // isWorktreeLive must be a pure fs check: a git-subprocess probe here would run through git()'s
    // per-dir identity-fallback cache and poison it on a corrupt worktree (makeBareOrigin configures
    // a real identity, shared across worktrees of the same clone) — proving the cache is untouched
    // is the direct regression check for that bug.
    assert.equal(
      probeIdentityFallbackEnv(healed),
      null,
      'healing a corrupt worktree must never poison the identity-fallback cache for its path',
    );
  } finally {
    cleanup();
  }
});

test('resolveCoordCheckout: a transient rmSync EBUSY on the recreate path is retried, not thrown uncaught (plan 1621)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const cdir = resolveCoordCheckout(dir); // first use: creates + registers the coord-worktree
    assert.ok(existsSync(cdir), 'coord-worktree created on first use');
    // Force the recreate branch exactly like the plan-1606 corrupt-HEAD test.
    const gitDir = execFileSync('git', ['-C', cdir, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(gitDir, 'HEAD'), '');
    // Injected rm seam: mimics a Windows-held file handle (a killed process still holding
    // .git/worktrees/<name>/) — throws EBUSY once, then delegates to the real rmSync.
    let calls = 0;
    const flakyRmSync = (p, opts) => {
      calls++;
      if (calls === 1) {
        const e = new Error(`EBUSY: resource busy or locked, rmdir '${p}'`);
        e.code = 'EBUSY';
        throw e;
      }
      return rmSync(p, opts);
    };
    const healed = resolveCoordCheckout(dir, { _rmSync: flakyRmSync });
    assert.equal(healed, cdir, 'same disposable path, freshly recreated after the transient EBUSY');
    assert.ok(calls >= 2, 'the flaky rmSync must have been retried at least once');
    const status = execFileSync('git', ['-C', healed, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(status, '', 'healed coord-checkout is a clean tree at origin/master');
  } finally {
    cleanup();
  }
});

test('resolveCoordCheckout: an rmSync EBUSY that never clears exhausts to the wrapped "failed after retries" error (plan 1621)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const cdir = resolveCoordCheckout(dir);
    const gitDir = execFileSync('git', ['-C', cdir, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(gitDir, 'HEAD'), '');
    const alwaysBusyRmSync = () => {
      const e = new Error("EBUSY: resource busy or locked, rmdir 'x'");
      e.code = 'EBUSY';
      throw e;
    };
    assert.throws(
      () => resolveCoordCheckout(dir, { _rmSync: alwaysBusyRmSync }),
      /rmSync.*failed after retries/,
      'exhausting all 6 recreate attempts on an rmSync-only failure must name rmSync as the ' +
        'cause (review fix), not misattribute it to `git worktree add`, which was never reached',
    );
  } finally {
    cleanup();
  }
});

// ── plan 4087 T1: a bounded deadline on every coord-checkout git child ───────────────────────
// boundedGitWithLockRetry is the ONE shared primitive resolveCoordCheckout (this file) and
// claim-plan.mjs's runClaimProjectionRetryLoop both call for their fetch/reset/clean trio — see
// its own header comment in coord-git.mjs for the full mechanism. Two fast, deterministic unit
// tests against an injected `_git` first (no real process, no real timing), then one real
// end-to-end test with an actual hung child process for the "no orphan left" acceptance criterion
// (a wall-clock-timing assertion would violate the repo's ambient-load rule, so that test asserts
// event identity — the seam shape, the released lock, the confirmed-dead pid — never elapsed time).

test('boundedGitWithLockRetry: an ETIMEDOUT _git converts to the named COORD_CHECKOUT_TIMEOUT seam, reaps the tree exactly once, and is never retried (plan 4087 T1)', () => {
  let gitCalls = 0;
  const fakeGit = () => {
    gitCalls++;
    const e = new Error('spawnSync git ETIMEDOUT');
    e.code = 'ETIMEDOUT';
    e.pid = 424242;
    e.signal = 'SIGTERM';
    throw e;
  };
  const killed = [];
  const fakeKillTree = (proc, opts) => killed.push({ proc, opts });
  assert.throws(
    () =>
      boundedGitWithLockRetry('/nonexistent/coord-dir', ['fetch', '--quiet', 'origin', 'master'], {
        _git: fakeGit,
        timeoutMs: 50,
        _killTree: fakeKillTree,
      }),
    (e) => {
      assert.equal(
        e.code,
        COORD_CHECKOUT_TIMEOUT,
        'must carry the named seam as a structural code',
      );
      assert.equal(
        e.coordCheckoutTimeout,
        true,
        'must also carry the boolean flag, house convention',
      );
      assert.equal(e.coordCheckoutTimeoutMs, 50);
      assert.match(e.message, /fetch --quiet origin master/, 'must name which command hung');
      assert.match(e.message, /nonexistent[\\/]coord-dir/, 'must name where');
      assert.match(e.message, /within \d+s/, 'must name the deadline (rounded seconds)');
      assert.equal(
        e.cause?.code,
        'ETIMEDOUT',
        'the original execFileSync error is preserved as .cause',
      );
      return true;
    },
  );
  assert.equal(
    gitCalls,
    1,
    'gitWithLockRetry classifiers never match ETIMEDOUT text, so a timeout must surface on the ' +
      'FIRST attempt — never silently retried into a second, equally long hang',
  );
  assert.equal(killed.length, 1, 'the process tree must be reaped exactly once');
  assert.deepEqual(
    killed[0].proc,
    { pid: 424242, killed: false, exitCode: null, signalCode: null },
    'killProcessTree gets a minimal ChildProcess-shaped object built from the timed-out pid',
  );
  assert.equal(killed[0].opts.force, true);
});

test('boundedGitWithLockRetry: a non-timeout git failure passes through unchanged — no seam, no reap', () => {
  const realErr = new Error('fatal: some real git failure, unrelated to any timeout');
  const fakeGit = () => {
    throw realErr;
  };
  let killed = 0;
  assert.throws(
    () =>
      boundedGitWithLockRetry('/nonexistent/coord-dir', ['fetch'], {
        _git: fakeGit,
        timeoutMs: 50,
        _killTree: () => killed++,
      }),
    (e) => e === realErr,
    'an ordinary git failure must surface as-is, never wrapped or relabelled as a timeout',
  );
  assert.equal(killed, 0, 'a non-timeout failure must never trigger a tree reap');
});

test('boundedGitWithLockRetry: the cap is an injectable parameter, never a hardcoded module read', () => {
  assert.equal(typeof COORD_CHECKOUT_GIT_TIMEOUT_MS, 'number');
  assert.ok(COORD_CHECKOUT_GIT_TIMEOUT_MS > 0);
  let seenTimeout;
  const fakeGit = (_dir, _args, opts) => {
    seenTimeout = opts.timeout;
    return '';
  };
  boundedGitWithLockRetry('/nonexistent/coord-dir', ['fetch'], {
    _git: fakeGit,
    timeoutMs: 12345,
  });
  assert.equal(
    seenTimeout,
    12345,
    'a caller-supplied timeoutMs must reach the underlying git call',
  );
});

// plan 4087 T5 review fix (keys bbdavu/1m5u8po): killProcessTree does not wait for confirmed
// death before returning — POSIX signal delivery (`process.kill(pid, signal)`) is fire-and-forget
// by nature, and even win32's `taskkill /pid <pid> /T /F` (spawnSync, so it blocks until taskkill
// itself exits) returning does not guarantee the OS has finished tearing the process down. A
// SINGLE `process.kill(pid, 0)` probe run immediately after the kill call therefore races that
// teardown — the exact ambient-load hazard the repo's test-convention rule targets. This is the
// same defect class (and the same fix shape) as kill-tree.test.mjs's own `pollUntilDead`: poll
// instead of probing once. On a healthy run the loop returns the INSTANT the pid is confirmed
// gone, so the deadline never decides the verdict; only a pid genuinely still alive at the
// deadline reads as alive — never "timed out, assumed dead" in either direction. Plain
// `process.kill(pid, 0)`/ESRCH (not kill-tree-test-lib.mjs's zombie-aware `isAlive`, which shells
// out to `ps`/`/proc` and is POSIX-only) because these two tests are Windows-primary and Node's
// own ESRCH mapping is already correct cross-platform for a non-zombie liveness check.
function pollUntilPidDead(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      return e; // confirmed dead -- return the error so the caller asserts its .code directly
    }
    if (Date.now() >= deadline) return null; // still alive at the deadline -- a genuine failure
    sleepSync(25);
  }
}

// The end-to-end acceptance case (plan 4087 acceptance bullet 2): a fixture that makes the coord
// checkout's `git fetch` hang for real makes resolveCoordCheckout (via withCoordCheckout) fail
// within the T1 deadline with the named seam, the coord lock released, and no orphan process left
// — asserted via pollUntilPidDead's ESRCH, not assumed and not raced. The `_git` injection seam is used
// instead of a literal PATH-stubbed `git` binary: verified empirically against this Node build that
// plain execFileSync('git', …) (gitRaw's own call, no shell) does NOT resolve a `.cmd` PATH shim at
// all on Windows (ENOENT — Windows batch files need a shell wrapper, the exact CVE-2024-27980 class
// kill-tree.mjs's spawnWithTreeKill/cross-spawn machinery exists to handle, which gitRaw does not
// use) and does not honour a per-call `env.PATH` override either (Windows CreateProcess's implicit
// executable search reads the CALLING process's own environment, not `lpEnvironment`) — so a literal
// PATH stub would not exercise gitRaw's real code path at all. The `_git` seam is the established
// convention this exact test file already uses throughout (`_rmSync`, `injectTransientGit`, the
// `_git` parameter on every coord-git function); here it spawns a REAL node.exe child bounded by the
// SAME `timeout` option gitRaw's execFileSync would receive, so the timeout mechanism, the pid
// capture, and the kill are all exercised for real — only the *resolution* of the literal `git`
// executable name is substituted.
test('withCoordCheckout: a hung coord-checkout fetch is killed within the bounded deadline, the lock is released, and no orphan process survives (plan 4087 T1 acceptance)', () => {
  // ambient-load-ok: this is a deliberate real-process, real-OS-timeout acceptance test, not a
  // wall-clock ceiling on the CODE under test — see the block comment above naming exactly why an
  // injected clock/fixture cannot substitute (execFileSync's native `timeout` option, the pid
  // capture, and killProcessTree's tree reap are OS-level mechanisms with no fake surface to
  // inject; a literal `git` PATH stub does not exercise gitRaw's real spawn path on this Windows
  // host either). The final liveness check is the genuinely racy part on its own (see
  // pollUntilPidDead's header, review keys bbdavu/1m5u8po) and is fixed properly below, not
  // waived — it polls for confirmed death instead of probing once immediately after the kill.
  const { dir, cleanup } = makeBareOrigin();
  try {
    const capturedPid = { value: null };
    const hangingFetchGit = (d, args, opts = {}) => {
      if (args[0] !== 'fetch') return git(d, args, opts);
      try {
        // A real, genuinely-hanging child process (bounded only by the timeout this call is
        // given) — exactly the shape gitRaw's own execFileSync('git', …) call takes.
        return execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], {
          timeout: opts.timeout,
          encoding: 'utf8',
        });
      } catch (e) {
        if (Number.isInteger(e.pid)) capturedPid.value = e.pid;
        throw e;
      }
    };
    assert.throws(
      () => withCoordCheckout(dir, (cdir) => cdir, { _git: hangingFetchGit, timeoutMs: 500 }),
      (e) => {
        assert.equal(e.code, COORD_CHECKOUT_TIMEOUT, 'must fail with the named seam');
        assert.equal(e.coordCheckoutTimeout, true);
        return true;
      },
    );
    assert.ok(
      Number.isInteger(capturedPid.value),
      'the fixture must have captured a real spawned child pid — precondition for the next assert',
    );
    const deathErr = pollUntilPidDead(capturedPid.value);
    assert.ok(
      deathErr && deathErr.code === 'ESRCH',
      'no orphan process left: the hung child must be CONFIRMED dead (ESRCH on a polled liveness ' +
        'probe, not raced immediately after the kill), not merely assumed because the timeout fired',
    );
    assert.ok(
      !existsSync(coordLockPath(dir)),
      'the coord-write lock must be released on the timeout throw, never left held by a dead child',
    );
  } finally {
    cleanup();
  }
});

// ── plan 4087 T2: ensureCoordSparseCheckout's own git calls are bounded too ──────────────────
// resolveCoordCheckout used to hand ensureCoordSparseCheckout the plain `_git` (default `git`)
// completely unbounded -- T1 only wrapped the fetch/reset/clean trio directly in
// resolveCoordCheckout, not the sparse-checkout machinery ensureSparseCheckout calls in between
// (its own rev-parse, sparseConeDirs' ls-tree walk, readSparseState, the sparse-checkout
// set/disable calls). A try/catch there catches a THROW; a hung child never throws, so the
// best-effort contract ("a sparse-checkout failure must never break a coordination write") gave
// zero protection against a HANG. boundedGit is the per-call twin of boundedGitWithLockRetry
// (same raiseCoordCheckoutTimeout seam, same tree-reap) -- two fast unit tests against it
// directly (mirroring boundedGitWithLockRetry's own three above), then one real end-to-end test
// with an actual hung child at the sparse-checkout call site.

test('boundedGit: an ETIMEDOUT _git converts to the named COORD_CHECKOUT_TIMEOUT seam and reaps the tree (plan 4087 T2)', () => {
  const fakeGit = () => {
    const e = new Error('spawnSync git ETIMEDOUT');
    e.code = 'ETIMEDOUT';
    e.pid = 909090;
    throw e;
  };
  const killed = [];
  const fakeKillTree = (proc, opts) => killed.push({ proc, opts });
  assert.throws(
    () =>
      boundedGit('/nonexistent/coord-dir', ['rev-parse', '--absolute-git-dir'], {
        _git: fakeGit,
        timeoutMs: 50,
        _killTree: fakeKillTree,
      }),
    (e) => {
      assert.equal(
        e.code,
        COORD_CHECKOUT_TIMEOUT,
        'must carry the named seam as a structural code',
      );
      assert.equal(e.coordCheckoutTimeout, true);
      assert.equal(e.coordCheckoutTimeoutMs, 50);
      assert.match(e.message, /rev-parse --absolute-git-dir/, 'must name which command hung');
      assert.equal(e.cause?.code, 'ETIMEDOUT', 'the original error is preserved as .cause');
      return true;
    },
  );
  assert.equal(killed.length, 1, 'the process tree must be reaped exactly once');
  assert.deepEqual(
    killed[0].proc,
    { pid: 909090, killed: false, exitCode: null, signalCode: null },
    'killProcessTree gets a minimal ChildProcess-shaped object built from the timed-out pid',
  );
  assert.equal(killed[0].opts.force, true);
});

test('boundedGit: a non-timeout git failure passes through unchanged — no seam, no reap', () => {
  const realErr = new Error('fatal: some real git failure, unrelated to any timeout');
  let killed = 0;
  assert.throws(
    () =>
      boundedGit('/nonexistent/coord-dir', ['rev-parse', '--absolute-git-dir'], {
        _git: () => {
          throw realErr;
        },
        timeoutMs: 50,
        _killTree: () => killed++,
      }),
    (e) => e === realErr,
    'an ordinary git failure must surface as-is, never wrapped or relabelled as a timeout',
  );
  assert.equal(killed, 0, 'a non-timeout failure must never trigger a tree reap');
});

test('boundedGit: the cap and underlying _git are both injectable parameters, never hardcoded module reads', () => {
  let seenTimeout;
  const fakeGit = (_dir, _args, opts) => {
    seenTimeout = opts.timeout;
    return 'ok';
  };
  const out = boundedGit('/nonexistent/coord-dir', ['rev-parse', '--absolute-git-dir'], {
    _git: fakeGit,
    timeoutMs: 12345,
  });
  assert.equal(out, 'ok');
  assert.equal(
    seenTimeout,
    12345,
    'a caller-supplied timeoutMs must reach the underlying git call',
  );
});

// The end-to-end proof (plan S12/S3's "T2" paragraph): resolveCoordCheckout hands
// ensureCoordSparseCheckout a `_git` built FROM boundedGit at both its call sites -- a hang
// inside ensureSparseCheckout itself (not the fetch/reset/clean trio T1 already covers) is now
// bounded the same way. ensureSparseCheckout's own contract stays best-effort (a sparse-checkout
// failure must never break a coordination write), so the timeout is caught internally and the
// checkout falls back to dense rather than propagating a top-level throw -- the property under
// test is that the hang itself is BOUNDED (the child is confirmed dead, the call returns, the
// coord lock is released) rather than that the seam always reaches the caller uncaught. Same
// real-hung-child technique as the T1 acceptance test above (a literal `git` PATH stub does not
// exercise gitRaw's real spawn path on this Windows host -- see that test's own comment).
test('withCoordCheckout: a hung ensureCoordSparseCheckout git call is bounded too, not just fetch/reset/clean (plan 4087 T2)', () => {
  // ambient-load-ok: same acceptance-test shape and same reasoning as the T1 test above (a real
  // OS-level timeout+kill has no fake surface to inject) — and the same fix for the genuinely racy
  // part: the final liveness check polls for confirmed death (pollUntilPidDead, defined above,
  // review keys bbdavu/1m5u8po) rather than probing once immediately after the kill.
  const { dir, cleanup } = makeBareOrigin();
  try {
    const capturedPid = { value: null };
    const hangingSparseGit = (d, args, opts = {}) => {
      if (args[0] === 'rev-parse' && args.includes('--absolute-git-dir')) {
        try {
          // A real, genuinely-hanging child process (bounded only by the timeout this call is
          // given) -- exactly the shape gitRaw's own execFileSync('git', …) call takes.
          return execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
            timeout: opts.timeout,
            encoding: 'utf8',
          });
        } catch (e) {
          if (Number.isInteger(e.pid)) capturedPid.value = e.pid;
          throw e;
        }
      }
      return git(d, args, opts);
    };
    // Must not hang the test itself: the bounded call fires within timeoutMs, is reaped, and
    // ensureSparseCheckout's own best-effort contract degrades to dense instead of failing the
    // whole write.
    const resolved = withCoordCheckout(dir, (cdir) => cdir, {
      _git: hangingSparseGit,
      // 5 s, not 500 ms: the SAME bound also covers this fixture's REAL fetch/reset/clean against a
      // local bare origin, and 500 ms is short enough for a loaded box to trip it on a healthy call
      // (it did, twice, under parallel suites). Nothing here asserts elapsed time -- the proof is the
      // captured pid confirmed dead -- so a wider bound costs ~5 s of test time and no rigour.
      timeoutMs: 5000,
    });
    assert.equal(
      resolved,
      coordCheckoutPath(dir),
      'the write still completes -- a bounded sparse-checkout hang degrades to dense, it does not fail the write',
    );
    assert.ok(
      Number.isInteger(capturedPid.value),
      'the fixture must have captured a real spawned child pid — precondition for the next assert',
    );
    const deathErr = pollUntilPidDead(capturedPid.value);
    assert.ok(
      deathErr && deathErr.code === 'ESRCH',
      'no orphan process left: the hung rev-parse child must be CONFIRMED dead (polled, not raced), ' +
        'not merely assumed',
    );
    assert.ok(
      !existsSync(coordLockPath(dir)),
      'the coord-write lock must be released, never left held by a dead child',
    );
  } finally {
    cleanup();
  }
});

// Confirms T2's "surgical, no wider blast radius" claim: ensurePlanSparseCheckout (the
// plan-worktree cut path, a much wider caller set) still receives the plain, unbounded `_git`
// default -- a hang there is out of this plan's scope and must remain byte-for-byte unchanged.
// Proven by source inspection here rather than a behavioural test (forcing a real hang through
// the full cut-worktree call graph is its own large fixture, already out of scope for this
// task) -- the two properties asserted are exactly what a reviewer would grep for.
test('ensurePlanSparseCheckout call site is untouched by T2 -- still the plain unbounded default (source check)', () => {
  const src = readFileSync(new URL('./coord-git.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function ensurePlanSparseCheckout'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.doesNotMatch(
    body,
    /boundedGit/,
    'ensurePlanSparseCheckout must not reference boundedGit -- T2 only bounds the COORD call sites',
  );
});

test('withCoordCheckout: COORD_MAIN_DIR short-circuit runs fn on the given dir, no lock, no checkout', () => {
  const { dir, cleanup } = makeBareOrigin();
  const saved = process.env.COORD_MAIN_DIR;
  process.env.COORD_MAIN_DIR = dir; // simulate done-worktree's already-isolated detached worktree
  try {
    const seen = withCoordCheckout(dir, (d) => d);
    assert.equal(seen, dir, 'short-circuit passes the given dir straight through');
    assert.ok(!existsSync(coordLockPath(dir)), 'no coord-write lock taken under COORD_MAIN_DIR');
    assert.ok(
      !existsSync(coordCheckoutPath(dir)),
      'no coord-checkout created under COORD_MAIN_DIR',
    );
  } finally {
    if (saved === undefined) delete process.env.COORD_MAIN_DIR;
    else process.env.COORD_MAIN_DIR = saved;
    cleanup();
  }
});

// The gold-standard: two REAL concurrent processes, each calling withCoordCheckout against the SAME
// clone (shared .git → shared coord-write lock). The lock serializes them onto the one disposable
// coord-checkout; neither throws and BOTH lines land on origin (no lost write, zero MAIN residue).
test('withCoordCheckout: two concurrent processes serialize on the lock and both writes land', async () => {
  const { origin, dir, cleanup } = makeBareOrigin();
  const saved = process.env.COORD_MAIN_DIR;
  delete process.env.COORD_MAIN_DIR;
  try {
    const root = dirname(origin);
    const modUrl = new URL('./coord-git.mjs', import.meta.url).href;
    const fixture = join(root, 'race-coord-checkout.mjs');
    writeFileSync(
      fixture,
      [
        "import { readFileSync, writeFileSync, existsSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const { withCoordCheckout, coordWrite } = await import(process.env.CW_MOD);',
        'const dir = process.env.CW_DIR, line = process.env.CW_LINE;',
        'withCoordCheckout(dir, (cdir) => {',
        '  coordWrite(cdir, {',
        "    relPaths: ['shared.txt'],",
        '    mutate: () => {',
        "      const p = join(cdir, 'shared.txt');",
        "      const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';",
        "      const lines = cur.split('\\n').filter(Boolean);",
        '      if (!lines.includes(line)) lines.push(line);',
        '      lines.sort();',
        "      writeFileSync(p, lines.join('\\n') + '\\n');",
        '    },',
        "    message: 'race ' + line, tool: 'race', attempts: 25,",
        '  });',
        '});',
        '',
      ].join('\n'),
    );
    const run = (line) =>
      new Promise((res) => {
        const cp = spawn(process.execPath, [fixture], {
          env: { ...process.env, CW_MOD: modUrl, CW_DIR: dir, CW_LINE: line, COORD_MAIN_DIR: '' },
        });
        let err = '';
        cp.stderr.on('data', (d) => (err += d));
        cp.on('close', (code) => res({ code, err }));
      });
    // Pre-create the coord-checkout serially (one retried worktree-add), so the concurrent path
    // exercises the STEADY STATE both real sessions hit — reset+mutate an EXISTING coord-checkout
    // under the lock — rather than the once-per-machine first-create (its own git-worktree-add
    // transient, covered by the single-writer test + resolveCoordCheckout's retry).
    resolveCoordCheckout(dir);
    // The writes are idempotent (each appends its line only if absent), and this host's `git
    // worktree`/shared-.git ops carry a rare environmental transient unrelated to the lock logic
    // under test — so retry a writer that exits non-zero a couple of times. The ASSERTIONS below
    // (both lines land, MAIN clean) are what actually prove the lock serialized the two writers.
    const runRetry = async (line) => {
      let last;
      for (let i = 0; i < 3; i++) {
        last = await run(line);
        if (last.code === 0) return last;
      }
      return last;
    };
    const [ra, rb] = await Promise.all([runRetry('AAA'), runRetry('BBB')]);
    assert.equal(ra.code, 0, `writer A threw: ${ra.err}`);
    assert.equal(rb.code, 0, `writer B threw: ${rb.err}`);
    const final = execFileSync('git', ['-C', origin, 'show', 'master:shared.txt'], {
      encoding: 'utf8',
    });
    assert.match(final, /AAA/, "writer A's line must survive on origin");
    assert.match(final, /BBB/, "writer B's line must survive on origin");
    // the lock is released and MAIN's tracked tree is untouched
    assert.ok(!existsSync(coordLockPath(dir)), 'coord-write lock released after both ops');
    const status = execFileSync(
      'git',
      ['-C', dir, 'status', '--porcelain', '--untracked-files=no'],
      {
        encoding: 'utf8',
      },
    ).trim();
    assert.equal(status, '', 'MAIN tracked tree untouched by concurrent coord writes');
  } finally {
    if (saved !== undefined) process.env.COORD_MAIN_DIR = saved;
    cleanup();
  }
});
// ── plan 1184: deleteStaleArchiveDups — shared stale-dup removal helper ──────────────────────
// One shared repo for the three functional tests (cuts ~21 redundant git subprocesses).
// Falsy-base test uses no repo (hits `if (!base) return` before any git I/O).
// Fix-A seam test verifies gitWithLockRetry is wired, not bare run() — a regression
// back to bare run() would leave `seam_called` false and the assertion would fail.

function makePlanRepo() {
  const r = makeRepo();
  const plansAbs = join(r.dir, 'docs', 'superpowers', 'plans');
  const archiveAbs = join(plansAbs, 'archive');
  const readyAbs = join(plansAbs, 'ready');
  mkdirSync(archiveAbs, { recursive: true });
  mkdirSync(readyAbs, { recursive: true });
  writeFileSync(join(archiveAbs, '001-P01-foo.md'), 'archived\n');
  execFileSync('git', ['-C', r.dir, 'add', '.'], { encoding: 'utf8' });
  execFileSync('git', ['-C', r.dir, 'commit', '-qm', 'seed plans tree'], { encoding: 'utf8' });
  return { ...r, plansAbs, archiveAbs, readyAbs };
}

test('deleteStaleArchiveDups: filtering (removes dup, skips archive/, skips mismatched basename)', () => {
  // One shared repo, three filtering scenarios — avoids ~21 redundant git subprocesses.
  const r = makePlanRepo();
  try {
    // scenario 1: removes an untracked non-archive file whose basename matches
    const dup = join(r.readyAbs, '001-P01-foo.md');
    writeFileSync(dup, 'stale dup\n');
    assert.ok(existsSync(dup), 'dup written');
    deleteStaleArchiveDups(r.dir, '001-P01-foo.md');
    assert.ok(!existsSync(dup), 'untracked non-archive dup removed');

    // scenario 2: does NOT delete an untracked file inside archive/
    const archiveDup = join(r.archiveAbs, '002-P02-baz.md');
    writeFileSync(archiveDup, 'archive dup\n');
    deleteStaleArchiveDups(r.dir, '002-P02-baz.md');
    assert.ok(existsSync(archiveDup), 'archive/ file is untouched');

    // scenario 3: does NOT delete a file whose basename differs
    const other = join(r.readyAbs, '003-P03-bar.md');
    writeFileSync(other, 'other plan\n');
    deleteStaleArchiveDups(r.dir, '001-P01-foo.md'); // different base
    assert.ok(existsSync(other), 'non-matching file left intact');
  } finally {
    r.cleanup();
  }
});

test('deleteStaleArchiveDups: Fix-A seam — gitWithLockRetry is wired (not bare run()); lock error is non-fatal', () => {
  // If someone regresses deleteStaleArchiveDups to bare run()/execFileSync, the _gitWithLockRetry
  // seam is bypassed, `seam_called` stays false, and the assertion below fails.
  const r = makePlanRepo();
  try {
    let seam_called = false;
    const _gitWithLockRetry = (dir, args, opts) => {
      seam_called = true;
      return gitWithLockRetry(dir, args, opts); // real call
    };
    const dup = join(r.readyAbs, '001-P01-foo.md');
    writeFileSync(dup, 'stale dup\n');
    deleteStaleArchiveDups(r.dir, '001-P01-foo.md', { _gitWithLockRetry });
    assert.ok(seam_called, 'gitWithLockRetry seam was invoked (Fix A: not bare run())');
    assert.ok(!existsSync(dup), 'dup removed via seam path');

    // also verify a lock error from ls-files is non-fatal (no throw)
    assert.doesNotThrow(() =>
      deleteStaleArchiveDups(r.dir, '001-P01-foo.md', {
        _gitWithLockRetry: () => {
          throw new Error('Another git process seems to be running in this repository');
        },
      }),
    );
  } finally {
    r.cleanup();
  }
});

test('deleteStaleArchiveDups: no-op and no throw when base is falsy (no repo needed)', () => {
  // Hits `if (!base) return` before any git I/O — no real repo required.
  const fakeDir = 'nonexistent-should-never-be-called';
  assert.doesNotThrow(() => deleteStaleArchiveDups(fakeDir, ''));
  assert.doesNotThrow(() => deleteStaleArchiveDups(fakeDir, null));
  assert.doesNotThrow(() => deleteStaleArchiveDups(fakeDir, undefined));
});

test('withCoordCheckout: an ASYNC fn holds the lock until it settles, then releases (move-plan/coord-edit)', async () => {
  const { dir, cleanup } = makeBareOrigin();
  const saved = process.env.COORD_MAIN_DIR;
  delete process.env.COORD_MAIN_DIR;
  try {
    let heldDuringAwait = false;
    const out = await withCoordCheckout(dir, async (cdir) => {
      assert.notEqual(cdir, dir);
      heldDuringAwait = existsSync(coordLockPath(dir)); // lock taken before fn runs
      await Promise.resolve(); // a real async boundary — a sync finally would release here
      return 'done';
    });
    assert.equal(out, 'done');
    assert.ok(heldDuringAwait, 'lock held for the whole async fn');
    assert.ok(!existsSync(coordLockPath(dir)), 'lock released only AFTER the promise settled');
  } finally {
    if (saved !== undefined) process.env.COORD_MAIN_DIR = saved;
    cleanup();
  }
});

// ── plan 665 G3: retryOnForeignDirt (moved from drain-run) + coordRetry gate ──
// plan 987: parameterised by the foreign-dirty path so the non-`--wait` classification tests can
// vary it (coord-doc vs real source). The no-arg default reproduces the original fixture
// byte-for-byte (the pre-987 callers below rely on it). `trailer:true` appends the real
// assertCleanOutsidePathspec trailer so parseForeignDirtPaths' block-bounding is exercised.
const foreignDirtError = (
  relPath = 'handoff/sessions/2026-06-15-session-1.md',
  { trailer = false } = {},
) =>
  new Error(
    'coordWrite(board): refusing to run — the main checkout has uncommitted changes to ' +
      "tracked file(s) OUTSIDE this tool's pathspec:\n  M " +
      relPath +
      (trailer
        ? '\nThe freshen onto origin/master would fight these and an uncommitted edit must never ' +
          'be risked silently. Commit or stash them first (`git commit` / `git stash -k`), then re-run.'
        : ''),
  );
const noWait = { sleep: () => {}, backoff: () => 0, log: () => {} };

test('retryOnForeignDirt: retries on foreign-dirt then succeeds (moved to coord-git)', () => {
  let calls = 0;
  const out = retryOnForeignDirt(
    () => {
      if (++calls < 3) throw foreignDirtError();
      return 'ok';
    },
    { attempts: 6, ...noWait },
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
});

test('retryOnForeignDirt: budget exhaustion throws a coordContention-tagged error', () => {
  assert.throws(
    () =>
      retryOnForeignDirt(
        () => {
          throw foreignDirtError();
        },
        { attempts: 3, ...noWait },
      ),
    (e) => e.coordContention === true && /after 3 attempts/.test(e.message),
  );
});

test('coordRetry(false, …): REAL source/config foreign dirt propagates IMMEDIATELY (G3.2 hard-stop pinned)', () => {
  // plan 987: the non-`--wait` hard-stop is preserved for non-coord dirt — a source/config edit is
  // usually the OPERATOR's own uncommitted work and must NEVER be silently retried/clobbered.
  for (const p of [
    'backend/src/aggregator.ts',
    '.claude/settings.json',
    'scripts/coord/coord-git.mjs',
  ]) {
    let calls = 0;
    assert.throws(
      () =>
        coordRetry(
          false,
          () => {
            calls++;
            throw foreignDirtError(p);
          },
          { attempts: 4, ...noWait },
        ),
      /OUTSIDE this tool's pathspec/,
    );
    assert.equal(calls, 1, `${p}: non-coord dirt is never retried (operator hard-stop preserved)`);
  }
});

test('coordRetry(true, …): retries foreign-dirt then succeeds (the --wait spine path)', () => {
  let calls = 0;
  const out = coordRetry(
    true,
    () => {
      if (++calls < 2) throw foreignDirtError();
      return 'enqueued';
    },
    { attempts: 6, ...noWait },
  );
  assert.equal(out, 'enqueued');
  assert.equal(calls, 2);
});

test('coordRetry(true, …): budget exhaustion surfaces coordContention for the COORD_CONTENTION seam', () => {
  assert.throws(
    () =>
      coordRetry(
        true,
        () => {
          throw foreignDirtError();
        },
        { attempts: 2, ...noWait },
      ),
    (e) => e.coordContention === true,
  );
});

test('coordRetry: a non-foreign-dirt error propagates immediately in BOTH modes (never retried)', () => {
  for (const wait of [false, true]) {
    let calls = 0;
    assert.throws(
      () =>
        coordRetry(
          wait,
          () => {
            calls++;
            throw new Error('board.mjs: row not found');
          },
          { attempts: 6, ...noWait },
        ),
      /row not found/,
    );
    assert.equal(calls, 1, `wait=${wait}: a real error is never retried`);
  }
});

// ── plan 987: non-`--wait` coordRetry CLASSIFIES the foreign dirt — bounded-retry a sibling's
//    TRANSIENT coord-doc commit-in-progress, hard-stop the operator's own real source/config edit ──

test('isCoordDocPath: coordWrite-managed surface vs real source/config', () => {
  for (const p of [
    'docs/handoff/landing-queue.md', // the file whose sibling dirt crashed the plan-981 land
    'docs/handoff/board.md',
    'docs/handoff/sessions/2026-06-22-session-1.md',
    'docs/INDEX.md',
    'docs/superpowers/plans/ready/999-Foo.md',
    'docs/superpowers/specs/2026-06-22-bar.md',
    'wiki/concepts/baz.md',
    'WIKI.md',
  ])
    assert.equal(isCoordDocPath(p), true, `${p} is a coord doc`);
  for (const p of [
    'backend/src/aggregator.ts',
    'frontend/src/app/page.tsx',
    'scripts/coord/coord-git.mjs',
    '.claude/settings.json', // hook-maintenance, NOT transient coord-doc churn → hard-stop
    'scripts/hooks/worktree-guard.sh',
    'docs/INDEX.md.bak', // not the exact INDEX file
    'docsX/handoff/x.md', // the prefix is anchored — no false prefix match
    'WIKI.md.old',
  ])
    assert.equal(isCoordDocPath(p), false, `${p} is NOT a coord doc`);
});

test('parseForeignDirtPaths: extracts paths from a refusal (no trailer, with trailer, rename, non-refusal)', () => {
  assert.deepEqual(
    parseForeignDirtPaths(foreignDirtError('docs/handoff/landing-queue.md').message),
    ['docs/handoff/landing-queue.md'],
  );
  // the real trailer is present → the foreign block is still bounded correctly (trailer excluded)
  assert.deepEqual(
    parseForeignDirtPaths(foreignDirtError('docs/handoff/board.md', { trailer: true }).message),
    ['docs/handoff/board.md'],
  );
  // a rename entry ("orig -> dest") contributes BOTH sides
  const renameMsg =
    "coordWrite(board): refusing to run — … OUTSIDE this tool's pathspec:\n" +
    '  R  docs/superpowers/plans/ready/1-a.md -> docs/superpowers/plans/in-progress/1-a.md';
  assert.deepEqual(parseForeignDirtPaths(renameMsg), [
    'docs/superpowers/plans/ready/1-a.md',
    'docs/superpowers/plans/in-progress/1-a.md',
  ]);
  // not a foreign-dirt refusal → [] (classifyForeignDirt then reports not-coord-only)
  assert.deepEqual(parseForeignDirtPaths('some unrelated git error'), []);
});

test('classifyForeignDirt: coordOnly iff non-empty AND every path is a coord doc', () => {
  assert.equal(classifyForeignDirt(['docs/handoff/landing-queue.md']).coordOnly, true);
  assert.equal(classifyForeignDirt(['docs/handoff/board.md', 'docs/INDEX.md']).coordOnly, true);
  // one real-source path among coord docs ⇒ NOT coordOnly (hard-stop), and it is reported
  const mixed = classifyForeignDirt(['docs/handoff/board.md', 'backend/src/x.ts']);
  assert.equal(mixed.coordOnly, false);
  assert.deepEqual(mixed.nonCoord, ['backend/src/x.ts']);
  // empty ⇒ NOT coordOnly (an unparseable refusal falls back to the safe immediate hard-stop)
  assert.equal(classifyForeignDirt([]).coordOnly, false);
});

// (a) the plan-981 crash scenario: a sibling's transient coord-doc dirt clears within the budget.
test('coordRetry(false, …): bounded-retries TRANSIENT coord-doc foreign dirt, then succeeds', () => {
  let calls = 0;
  const out = coordRetry(
    false,
    () => {
      if (++calls < 3) throw foreignDirtError('docs/handoff/landing-queue.md');
      return 'enqueued';
    },
    { attempts: 4, ...noWait },
  );
  assert.equal(out, 'enqueued');
  assert.equal(calls, 3, 'transient coord-doc dirt is waited out (the 2026-06-22 plan-981 crash)');
});

// (c) coord-doc dirt that NEVER clears ⇒ hard-stop after the bounded budget, with the sweep pointer.
test('coordRetry(false, …): persistent coord-doc dirt → coordContention after the bounded budget, points at sweep-acquire-residue', () => {
  let calls = 0;
  assert.throws(
    () =>
      coordRetry(
        false,
        () => {
          calls++;
          throw foreignDirtError('docs/handoff/landing-queue.md');
        },
        { attempts: 3, ...noWait },
      ),
    (e) =>
      e.coordContention === true &&
      /after 3 attempts/.test(e.message) &&
      /sweep-acquire-residue\.mjs/.test(e.message),
  );
  assert.equal(calls, 3, 'bounded budget: tries exactly `attempts` times then hard-stops');
});

// retryTransientCoordDirt directly: a non-foreign-dirt error is never retried (parity with coordRetry).
test('retryTransientCoordDirt: a non-foreign-dirt error propagates immediately', () => {
  let calls = 0;
  assert.throws(
    () =>
      retryTransientCoordDirt(
        () => {
          calls++;
          throw new Error('board.mjs: row not found');
        },
        { attempts: 4, ...noWait },
      ),
    /row not found/,
  );
  assert.equal(calls, 1);
});

// ── plan 810 Group B: every git child the spine spawns carries the GCM interactive-credential-
// dialog suppression, so an ephemeral fetch/push can never pop the GUI dialog that crashed a
// land mid-merge (plan 774). ──

test('plan 810: GIT_NONINTERACTIVE_ENV is the documented GCM-dialog suppression', () => {
  assert.deepEqual(GIT_NONINTERACTIVE_ENV, { GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' });
});

// Observe the env git hands a child via a `!`-alias: git runs it as a child process that inherits
// git's resolved env, and the shim dumps that env to a file. No network, no credential machinery,
// no repo needed — fully deterministic and cross-platform (node is always on the child PATH).
function observeGitChildEnv(callerEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'gcm-suppress-'));
  try {
    const shim = join(dir, 'shim.cjs');
    const out = join(dir, 'env.json');
    writeFileSync(
      shim,
      "require('fs').writeFileSync(process.env.FAKE_GIT_OUT, JSON.stringify(process.env)); process.stdout.write('ok');",
    );
    const shimForGit = shim.replace(/\\/g, '/'); // git's `!`-shell wants forward slashes
    git(dir, ['-c', `alias.envdump=!node "${shimForGit}"`, 'envdump'], {
      env: { FAKE_GIT_OUT: out, ...callerEnv },
    });
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('plan 810: git() FORCES the GCM-dialog suppression onto the git child (overrides a hostile ambient value)', () => {
  // pass HOSTILE values for both vars to prove git() OVERRIDES them with the suppression
  // (GIT_NONINTERACTIVE_ENV is spread last), never merely passes an ambient value through.
  const childEnv = observeGitChildEnv({ GCM_INTERACTIVE: 'YES', GIT_TERMINAL_PROMPT: '1' });
  assert.equal(childEnv.GCM_INTERACTIVE, 'never', 'GCM dialog suppressed on the git child');
  assert.equal(childEnv.GIT_TERMINAL_PROMPT, '0', 'git terminal prompt disabled on the git child');
});

test('plan 810: git() preserves a caller-supplied env (HUSKY) alongside the suppression', () => {
  // the coord-write commit path passes { env: { ...process.env, HUSKY: '0' } } — the suppression
  // merge must not clobber it (regression guard for the gitMoveCommit / pushMasterWithRebase path).
  const childEnv = observeGitChildEnv({ HUSKY: '0' });
  assert.equal(childEnv.HUSKY, '0', 'a caller env key survives the suppression merge');
  assert.equal(childEnv.GCM_INTERACTIVE, 'never', 'and the suppression is still applied');
  assert.equal(childEnv.GIT_TERMINAL_PROMPT, '0');
});

// ── plan 980: transient index-WRITE retry + commit/mv half-land tolerance ──────────────────────
// The transient `unable to write new index file` (a brief Windows AV/file-lock on `.git/index` AFTER
// git already created the commit object / renamed the file) crashed any coord script routing through
// gitWithLockRetry/coordWrite/gitMoveCommit. plan 960 fixed it only inside done-worktree's private
// gitMain; plan 980 lifts the same self-healing into coord-git so every coord script inherits it.
// A real transient index-write cannot be provoked on demand, so the `_git` test seam (the low-level
// git runner) injects it: the wrapper runs REAL git (so the work actually lands) then throws the
// transient, and gitWithLockRetry's natural retry then sees git's real "nothing to commit" / "bad
// source" — exactly the production half-land sequence.

test("plan 980: classifiers recognise git's transient-index-write / nothing-to-commit / bad-source wordings", () => {
  assert.equal(
    isTransientIndexWrite(
      'fatal: repository has been updated, but unable to write new index file.',
    ),
    true,
  );
  assert.equal(isTransientIndexWrite('fatal: Unable to write new index file'), true); // case-insensitive
  // the .lock contention message is a DIFFERENT condition (LOCK_RX), NOT this transient
  assert.equal(
    isTransientIndexWrite("fatal: Unable to create '.git/index.lock': File exists."),
    false,
  );
  assert.equal(isTransientIndexWrite('nothing to commit, working tree clean'), false);
  assert.equal(isTransientIndexWrite(''), false);
  assert.equal(isNothingToCommit('nothing to commit, working tree clean'), true);
  assert.equal(isNothingToCommit('no changes added to commit'), true);
  assert.equal(isNothingToCommit('unable to write new index file'), false);
  assert.equal(isMvBadSource('fatal: bad source, source=a.md, destination=b.md'), true);
  assert.equal(isMvBadSource('unable to write new index file'), false);
});

test('plan 980: gitWithLockRetry retries a transient index-write then succeeds', () => {
  const r = makeRepo();
  try {
    let n = 0;
    const _git = () => {
      if (++n <= 2)
        throw new Error('fatal: repository has been updated, but unable to write new index file.');
      return 'done';
    };
    const out = gitWithLockRetry(r.dir, ['commit'], { attempts: 5, delayMs: 1, _git });
    assert.equal(out, 'done');
    assert.equal(n, 3, 'retried twice (transient) then succeeded');
  } finally {
    r.cleanup();
  }
});

test('plan 980: gitWithLockRetry surfaces a genuine non-transient git failure immediately (no retry)', () => {
  const r = makeRepo();
  try {
    let n = 0;
    const _git = () => {
      n++;
      throw new Error('fatal: not a git repository');
    };
    assert.throws(
      () => gitWithLockRetry(r.dir, ['status'], { attempts: 4, delayMs: 1, _git }),
      /not a git repository/,
    );
    assert.equal(n, 1, 'a non-lock, non-transient error is never retried');
  } finally {
    r.cleanup();
  }
});

// ── plan 983: transient ref-lock-during-commit race (`cannot lock ref 'HEAD'`) ────────────────
// A sibling session moving local HEAD between this commit's HEAD-read and its ref-write makes git
// abort with a compare-and-swap mismatch. The commit did NOT land (no ref move, staged content
// untouched), so gitWithLockRetry retries it — re-reading the now-current HEAD as the parent — and
// succeeds. A STALE `HEAD.lock` left by a crashed process is a DIFFERENT condition (the `.lock`-file
// "File exists" class, caught by LOCK_RX) that does NOT self-clear: isRefLockRace must NOT claim it.
test('plan 983: isRefLockRace recognises the CAS-mismatch wording only', () => {
  assert.equal(
    isRefLockRace("fatal: cannot lock ref 'HEAD': is at fc5b3e209 but expected 2d025363c"),
    true,
  );
  assert.equal(
    isRefLockRace("cannot lock ref 'refs/heads/master': is at abc123 but expected def456"),
    true,
  );
  // a STALE lock FILE ("File exists") is the `.lock`-contention class (LOCK_RX, which matches the
  // quoted `'…HEAD.lock'`), NOT this CAS race — it does NOT self-clear on retry, so isRefLockRace must
  // reject it (else it'd be retried 24s + mislabelled "ref race"); LOCK_RX still keeps the lock path.
  const staleHeadLock =
    "fatal: cannot lock ref 'HEAD': Unable to create '.git/HEAD.lock': File exists.";
  assert.equal(isRefLockRace(staleHeadLock), false);
  // …and the routing contract the comment promises: the stale-HEAD.lock wording IS still caught by
  // LOCK_RX, so it keeps the lock-wait/stale-clear path rather than being surfaced raw + unretried.
  assert.equal(LOCK_RX.test(staleHeadLock), true);
  assert.equal(isRefLockRace('fatal: Unable to write new index file'), false);
  assert.equal(isRefLockRace('nothing to commit, working tree clean'), false);
  assert.equal(isRefLockRace(''), false);
});

test('plan 983: gitWithLockRetry retries a ref-lock race then succeeds', () => {
  const r = makeRepo();
  try {
    let n = 0;
    const _git = () => {
      if (++n <= 2)
        throw new Error("fatal: cannot lock ref 'HEAD': is at fc5b3e209 but expected 2d025363c");
      return 'committed';
    };
    const out = gitWithLockRetry(r.dir, ['commit', '-m', 'x'], { attempts: 5, delayMs: 1, _git });
    assert.equal(out, 'committed');
    assert.equal(n, 3, 'retried twice (ref-lock race) then succeeded');
  } finally {
    r.cleanup();
  }
});

// ── plan 2471: transient ref-UPDATE race during `git fetch` ────────────────────────────────
// The fetch-side analogue of isRefLockRace's commit-side CAS mismatch: a sibling advanced
// origin/master between our fetch's read and write of the remote-tracking ref. Matched
// narrowly to git's exact wording so an unrelated fetch failure (network, auth, unknown ref)
// is never mistaken for the transient and retried.
test('plan 2471: isRefUpdateRace recognises the "incorrect old value provided" wording only', () => {
  assert.equal(
    isRefUpdateRace(
      'error: fetching ref refs/remotes/origin/master failed: incorrect old value provided',
    ),
    true,
  );
  // no leading "error:" and a different ref — still matches on the stable core wording
  assert.equal(
    isRefUpdateRace(
      'fetching ref refs/remotes/origin/worktree-foo failed: incorrect old value provided',
    ),
    true,
  );
  assert.equal(isRefUpdateRace('fatal: Unable to write new index file'), false);
  assert.equal(
    isRefUpdateRace("fatal: cannot lock ref 'HEAD': is at fc5b3e209 but expected 2d025363c"),
    false,
  );
  assert.equal(isRefUpdateRace('nothing to commit, working tree clean'), false);
  assert.equal(isRefUpdateRace(''), false);
});

test('plan 2471: gitWithLockRetry retries a ref-update race (fetch) then succeeds', () => {
  const r = makeRepo();
  try {
    let n = 0;
    const _git = () => {
      if (++n <= 2)
        throw new Error(
          'error: fetching ref refs/remotes/origin/master failed: incorrect old value provided',
        );
      return 'fetched';
    };
    const out = gitWithLockRetry(r.dir, ['fetch', 'origin'], { attempts: 5, delayMs: 1, _git });
    assert.equal(out, 'fetched');
    assert.equal(n, 3, 'retried twice (ref-update race) then succeeded');
  } finally {
    r.cleanup();
  }
});

test('plan 2471: gitWithLockRetry exhausts a persistent ref-update race with a clean, attributable error', () => {
  const r = makeRepo();
  try {
    const _git = () => {
      throw new Error(
        'error: fetching ref refs/remotes/origin/master failed: incorrect old value provided',
      );
    };
    assert.throws(
      () => gitWithLockRetry(r.dir, ['fetch', 'origin'], { attempts: 3, delayMs: 1, _git }),
      /coord-git: `git fetch origin` blocked by index\.lock \/ transient index-write \/ ref-lock race \/ ref-update race after 3 attempts/,
    );
  } finally {
    r.cleanup();
  }
});

test('plan 980: commitSubjectAtHead is true only when HEAD subject equals the message first line', () => {
  const r = makeRepo();
  try {
    r.g('commit', '--allow-empty', '-m', 'my subject line\n\nthe body');
    assert.equal(commitSubjectAtHead(r.dir, 'my subject line\n\nCoord-Write: x'), true);
    assert.equal(commitSubjectAtHead(r.dir, 'a different subject'), false);
    assert.equal(commitSubjectAtHead(r.dir, ''), false, 'an empty message → false');
    assert.equal(
      commitSubjectAtHead(join(tmpdir(), 'no-such-repo-980'), 'whatever'),
      false,
      'an unreadable HEAD → false (the safe direction)',
    );
  } finally {
    r.cleanup();
  }
});

// _git wrapper: run REAL git (so the work lands), then throw the transient on the FIRST `op` call —
// reproducing "git did the work, then the index write failed". The retry then hits git's real
// already-done signal (nothing to commit / bad source). plan 2580: the shim itself now lives in
// scripts/test-helpers/ so coord-edit.test.mjs proves tolerance of the SAME race, not a drifting
// copy of it; this local binding just supplies THIS suite's real-git runner.
const injectTransientOnFirst = (op) => injectTransientGit(git, op);

test('plan 980: coordWrite tolerates a half-land commit and the doc still lands on origin', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const res = coordWrite(dir, {
      relPaths: ['f.txt'],
      mutate: () => writeFileSync(join(dir, 'f.txt'), 'half-land\n'),
      message: 'test: half-land commit',
      tool: 'unit',
      _git: injectTransientOnFirst('commit'),
    });
    assert.ok(res.attempts >= 1, 'coordWrite returned success, not a throw');
    execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin', 'master']);
    assert.equal(
      execFileSync('git', ['-C', dir, 'show', 'origin/master:f.txt'], { encoding: 'utf8' }),
      'half-land\n',
      'the doc landed on origin despite the half-land commit',
    );
    const body = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%B', 'origin/master'], {
      encoding: 'utf8',
    });
    assert.match(body, new RegExp(`${COORD_TRAILER}: unit`), 'the Coord-Write trailer survived');
  } finally {
    cleanup();
  }
});

test('plan 983: coordWrite retries a ref-lock race on the commit and the doc lands with correct content', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    let fired = false;
    // Unlike the index-write transient (git did the work THEN failed the index write), a ref-lock
    // CAS failure aborts the commit BEFORE it lands — git did NOT do the work. So the seam throws
    // WITHOUT running git on the first commit; the retry runs real git and the mutate content lands.
    // This proves the generic gitWithLockRetry ref-lock retry carries coordWrite's commit through.
    const _git = (d, a, o) => {
      if (a[0] === 'commit' && !fired) {
        fired = true;
        throw new Error("fatal: cannot lock ref 'HEAD': is at fc5b3e209 but expected 2d025363c");
      }
      return git(d, a, o);
    };
    const res = coordWrite(dir, {
      relPaths: ['f.txt'],
      mutate: () => writeFileSync(join(dir, 'f.txt'), 'ref-lock-survivor\n'),
      message: 'test: ref-lock race on commit',
      tool: 'unit',
      _git,
    });
    assert.ok(res.attempts >= 1, 'coordWrite returned success, not a throw');
    assert.ok(fired, 'the ref-lock race was actually injected on the commit');
    execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin', 'master']);
    assert.equal(
      execFileSync('git', ['-C', dir, 'show', 'origin/master:f.txt'], { encoding: 'utf8' }),
      'ref-lock-survivor\n',
      'the doc landed on origin with the mutate content after the ref-lock retry',
    );
    const body = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%B', 'origin/master'], {
      encoding: 'utf8',
    });
    assert.match(body, new RegExp(`${COORD_TRAILER}: unit`), 'the Coord-Write trailer survived');
  } finally {
    cleanup();
  }
});

test('plan 980: coordWrite does NOT silently treat a "nothing to commit" WITHOUT the commit at HEAD as success', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    // _git throws "nothing to commit" WITHOUT ever committing → HEAD subject never matches → must surface
    const _git = (d, a, o) => {
      if (a[0] === 'commit') throw new Error('nothing to commit, working tree clean');
      return git(d, a, o);
    };
    assert.throws(
      () =>
        coordWrite(dir, {
          relPaths: ['f.txt'],
          mutate: () => writeFileSync(join(dir, 'f.txt'), 'x\n'),
          message: 'test: never lands',
          tool: 'unit',
          _git,
        }),
      /nothing to commit/,
    );
  } finally {
    cleanup();
  }
});

test('plan 980: gitMoveCommit tolerates a half-move mv (transient) and still commits the rename', () => {
  const r = makeRepo(); // f.txt committed with content 'one\n'
  try {
    gitMoveCommit(r.dir, 'f.txt', 'g.txt', 'move f->g (half-move)', {
      _git: injectTransientOnFirst('mv'),
    });
    assert.equal(existsSync(join(r.dir, 'f.txt')), false, 'source gone');
    assert.equal(existsSync(join(r.dir, 'g.txt')), true, 'destination present');
    assert.equal(
      r.g('status', '--porcelain').trim(),
      '',
      'rename fully committed, nothing dangling',
    );
    assert.match(r.g('log', '-1', '--format=%s'), /move f->g \(half-move\)/);
    assert.equal(r.g('show', 'HEAD:g.txt'), 'one\n', 'content preserved across the rename');
  } finally {
    r.cleanup();
  }
});

test('plan 980: gitMoveCommit tolerates a half-land commit (transient) on the rename commit', () => {
  const r = makeRepo();
  try {
    gitMoveCommit(r.dir, 'f.txt', 'g.txt', 'move f->g (commit half-land)', {
      _git: injectTransientOnFirst('commit'),
    });
    assert.equal(existsSync(join(r.dir, 'f.txt')), false);
    assert.equal(existsSync(join(r.dir, 'g.txt')), true);
    assert.equal(r.g('status', '--porcelain').trim(), '');
    assert.match(r.g('log', '-1', '--format=%s'), /move f->g \(commit half-land\)/);
  } finally {
    r.cleanup();
  }
});

test('plan 980: gitMoveCommit surfaces a "bad source" when the move did NOT happen (src still present)', () => {
  const r = makeRepo();
  try {
    // a "bad source" while src is STILL present (and dest absent) is NOT the half-move — it is a
    // genuine error and must surface, never be swallowed by the half-move tolerance.
    const _git = (d, a, o) => {
      if (a[0] === 'mv') throw new Error('fatal: bad source, source=f.txt, destination=g.txt');
      return git(d, a, o);
    };
    assert.throws(
      () => gitMoveCommit(r.dir, 'f.txt', 'g.txt', 'move that should fail', { _git }),
      /bad source/i,
    );
    assert.equal(
      existsSync(join(r.dir, 'f.txt')),
      true,
      'source untouched — the move never happened',
    );
    assert.equal(existsSync(join(r.dir, 'g.txt')), false, 'destination never created');
  } finally {
    r.cleanup();
  }
});

// The FAITHFUL half-move: a real transient index-write fails AFTER git renamed the working-tree file
// but BEFORE it wrote the index — so the index is NOT updated (`to` untracked, `from` still tracked &
// on-disk-absent). `git commit -- from to` would then die "pathspec 'to' did not match" and record
// NOTHING. gitMoveCommit must `git add -A -- from to` to re-derive the rename from disk, then commit.
// (injectTransientOnFirst above is NOT faithful here — it runs real git mv first, which DOES update
// the index, masking this case; this test reproduces the un-staged state directly.)
test('plan 980: gitMoveCommit recovers a REAL half-move (disk renamed, index NOT updated) — stages + commits the rename', () => {
  const r = makeRepo(); // f.txt committed with 'one\n'
  try {
    renameSync(join(r.dir, 'f.txt'), join(r.dir, 'g.txt')); // rename on DISK only — index unchanged
    // status is now `D f.txt` (tracked, gone from disk) + `?? g.txt` (untracked)
    assert.match(r.g('status', '--porcelain'), /D f\.txt/);
    assert.match(r.g('status', '--porcelain'), /\?\? g\.txt/);
    // the mv throws "bad source" (from is gone on disk) — exactly what real git does on the retry
    const _git = (d, a, o) => {
      if (a[0] === 'mv') throw new Error('fatal: bad source, source=f.txt, destination=g.txt');
      return git(d, a, o);
    };
    gitMoveCommit(r.dir, 'f.txt', 'g.txt', 'recover real half-move', { _git });
    assert.equal(existsSync(join(r.dir, 'f.txt')), false);
    assert.equal(existsSync(join(r.dir, 'g.txt')), true);
    assert.equal(
      r.g('status', '--porcelain').trim(),
      '',
      'rename fully committed, nothing dangling',
    );
    assert.match(r.g('log', '-1', '--format=%s'), /recover real half-move/);
    assert.equal(r.g('show', 'HEAD:g.txt'), 'one\n', 'content preserved across the rename');
    // the critical assertion: f.txt is GONE from HEAD (not a bare deletion leaving g.txt untracked)
    assert.doesNotMatch(
      r.g('ls-tree', '--name-only', 'HEAD'),
      /f\.txt/,
      'f.txt removed from HEAD — the rename landed, not a bare deletion',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 1312 / F-007: half-land tolerance is NONCE-bound, never subject-bound ────────────────
// drain-run's claim message is a pure function of (slug, day), so two racing drain processes
// produce IDENTICAL subjects — subject equality at HEAD proved nothing. Every gitMoveCommit
// now stamps a per-invocation `Coord-Nonce:` trailer and the tolerance verifies THAT.

test('F-007: commitNonceAtHead matches only the exact nonce trailer at HEAD (conservative on failure)', () => {
  const r = makeRepo();
  try {
    r.g('commit', '--allow-empty', '-m', 'subject\n\nCoord-Nonce: abc-123');
    assert.equal(commitNonceAtHead(r.dir, 'abc-123'), true);
    assert.equal(commitNonceAtHead(r.dir, 'some-other-nonce'), false);
    assert.equal(commitNonceAtHead(r.dir, ''), false, 'an empty nonce → false');
    assert.equal(
      commitNonceAtHead(join(tmpdir(), 'no-such-repo-1312'), 'abc-123'),
      false,
      'an unreadable HEAD → false (the safe direction)',
    );
  } finally {
    r.cleanup();
  }
});

test('F-007: gitMoveCommit stamps the per-invocation Coord-Nonce trailer into the commit body', () => {
  const r = makeRepo();
  try {
    gitMoveCommit(r.dir, 'f.txt', 'g.txt', 'move f->g', { _nonce: 'nonce-1312' });
    const body = r.g('log', '-1', '--format=%B');
    assert.match(body, /^move f->g/, 'subject unchanged');
    assert.match(body, /Coord-Nonce: nonce-1312/, 'nonce trailer in the body');
  } finally {
    r.cleanup();
  }
});

test("F-007: a racing sibling's IDENTICAL-subject commit is NOT read as our own half-land — the loser throws", () => {
  const r = makeRepo();
  try {
    // Deterministic (slug, day) message — exactly what two independently-launched drains build.
    const msg = 'drain: claim 999-Other-raced → in-progress (2026-07-03)';
    // The SIBLING drain wins the race: its gitMoveCommit renames + commits (its own nonce).
    gitMoveCommit(r.dir, 'f.txt', 'g.txt', msg);
    // OUR drain then runs the identical claim: `git mv` dies "bad source" with from-gone /
    // to-present (tolerated as a half-move), the commit finds nothing to do — and under the
    // pre-F-007 subject-equality check this was TOLERATED, so both drains reported a
    // successful claim and double-dispatched the plan. The nonce check must throw instead.
    assert.throws(
      () => gitMoveCommit(r.dir, 'f.txt', 'g.txt', msg),
      /nothing to commit|no changes|did not match/i,
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 1312 / F-003: readTrackedFileFresh reads the authoritative origin/master copy ────────
test('F-003: readTrackedFileFresh prefers origin/master over a stale working-tree copy, falls back offline', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    writeFileSync(join(dir, 'doc.md'), 'ORIGIN\n');
    execFileSync('git', ['-C', dir, 'add', 'doc.md']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'doc']);
    execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'master']);
    // MAIN's working-tree copy drifts (the plan-989 world: coord writes never freshen it).
    writeFileSync(join(dir, 'doc.md'), 'STALE-LOCAL\n');
    assert.equal(readTrackedFileFresh(dir, 'doc.md', join(dir, 'doc.md')), 'ORIGIN\n');
    // A path origin/master does not have falls back to the local file.
    writeFileSync(join(dir, 'only-local.md'), 'LOCAL\n');
    assert.equal(readTrackedFileFresh(dir, 'only-local.md', join(dir, 'only-local.md')), 'LOCAL\n');
    // fetch:false reads the LOCAL remote-tracking ref (current here — our push updated it)
    // without a network fetch.
    assert.equal(
      readTrackedFileFresh(dir, 'doc.md', join(dir, 'doc.md'), { fetch: false }),
      'ORIGIN\n',
    );
  } finally {
    cleanup();
  }
});

// ── plan 1312 / F-002: pushMasterWithRebase journals its rebase window (pid-stamped) ──────────
test('F-002: pushMasterWithRebase journals an open push-rebase window around the rebase and closes it on success', () => {
  const { dir, origin, cleanup } = makeBareOrigin();
  try {
    // sibling pushes a non-conflicting commit → our push is non-ff → the rebase path runs
    const sib = cloneOf(origin);
    writeFileSync(join(sib, 'sib.txt'), 'sib\n');
    execFileSync('git', ['-C', sib, 'add', 'sib.txt']);
    execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling']);
    execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
    writeFileSync(join(dir, 'ours.txt'), 'ours\n');
    execFileSync('git', ['-C', dir, 'add', 'ours.txt']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'ours']);
    pushMasterWithRebase(dir);
    const ops = readCoordOpJournal(dir).filter((e) => e.tool === 'push-rebase');
    assert.ok(
      ops.some((e) => e.phase === 'start'),
      'rebase window opened',
    );
    assert.ok(
      ops.some(
        (e) => e.phase === 'done' && e.token === ops.find((s2) => s2.phase === 'start').token,
      ),
      'window closed on success (heal-main sees no open window)',
    );
    assert.equal(typeof ops[0].pid, 'number', 'pid-stamped for the liveness probe');
  } finally {
    cleanup();
  }
});

// ── plan 4237 T0/T1: the rebase-retry replay guard ───────────────────────────────────────────
// The 2026-09-26 incident: heal-main's rebase-retry picked two local commits onto a moved
// origin/master, and between pick 1 and pick 2 the INDEX was rewritten back to the pre-rebase
// tip's state. Git's two-way checkout keeps an index entry at every path the pick does not
// change, so pick 2 recorded the pre-rebase TREE (c8c55d9e704): 2 changed paths became 30, every
// path the skipped upstream commits had touched rolled back, and it was pushed.
//
// T0 (session decision): the real concurrent-`git status` race did NOT reproduce in 25 bounded
// trials (24 of them died on index.lock instead), so the writer is not proven; the clobber is
// SIMULATED deterministically — a post-commit hook (the sequencer runs it after every pick) runs
// `git read-tree <pre-rebase tip>` once, which is exactly the state the incident's pick 2 read.
function makeReplayClobberFixture({ clobber = true } = {}) {
  const { dir, origin, cleanup } = makeBareOrigin();
  const g = (d, ...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' }).trim();
  // the local commits: pick 1 changes one path (the runbook note), pick 2 changes TWO (the
  // stop-hook's two doc files) — the incident's shape.
  writeFileSync(join(dir, 'runbook.md'), 'note\n');
  g(dir, 'add', 'runbook.md');
  g(dir, 'commit', '-qm', 'local runbook note');
  writeFileSync(join(dir, 'doc-a.md'), 'a\n');
  writeFileSync(join(dir, 'doc-b.md'), 'b\n');
  g(dir, 'add', 'doc-a.md', 'doc-b.md');
  g(dir, 'commit', '-qm', 'auto-heal: commit idle commit-safe dirt');
  const preTip = g(dir, 'rev-parse', 'HEAD');
  // origin moves: a sibling touches 28 OTHER paths (so the clobbered pick reads as 30 paths)
  const sib = cloneOf(origin);
  for (let i = 0; i < 28; i++) writeFileSync(join(sib, `sib-${i}.txt`), `${i}\n`);
  g(sib, 'add', '-A');
  g(sib, 'commit', '-qm', 'sibling lands 28 paths');
  g(sib, 'push', '-q', 'origin', 'master');
  const sibTip = g(sib, 'rev-parse', 'HEAD');
  if (clobber) {
    const hooks = join(dirname(origin), 'clobber-hooks');
    mkdirSync(hooks, { recursive: true });
    const fired = join(hooks, 'fired').replace(/\\/g, '/');
    writeFileSync(
      join(hooks, 'post-commit'),
      `#!/bin/sh\nif [ ! -f "${fired}" ]; then touch "${fired}"; git read-tree ${preTip}; fi\n`,
      { mode: 0o755 },
    );
    g(dir, 'config', 'core.hooksPath', hooks.replace(/\\/g, '/'));
  }
  return { dir, origin, preTip, sibTip, g, cleanup };
}

test('plan 4237 T1: a rebase pick carrying a clobbered index is REFUSED — no push, master back at the pre-rebase tip, journaled', () => {
  const f = makeReplayClobberFixture();
  try {
    let thrown;
    assert.throws(
      () => pushMasterWithRebase(f.dir),
      (e) => ((thrown = e), true),
    );
    assert.equal(thrown.code, 'PUSH_REBASE_REPLAY_MISMATCH');
    assert.equal(isNonFastForward(thrown), false, 'must not read as a retryable non-ff');
    assert.equal(
      f.g(f.origin, 'rev-parse', 'master'),
      f.sibTip,
      'origin must still sit at the sibling tip — the rollback commit never reaches it',
    );
    assert.equal(
      f.g(f.dir, 'rev-parse', 'master'),
      f.preTip,
      'local master reset to the pre-rebase tip (a later plain push must not ff the bad commit)',
    );
    assert.equal(f.g(f.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'master', 'HEAD attached');
    const hit = readCoordOpJournal(f.dir).find((e) => e.tool === 'push-rebase-replay-mismatch');
    assert.ok(hit, 'a push-rebase-replay-mismatch coord-op line is journaled');
    assert.equal(hit.originalPaths.length, 2, 'the original commit changed 2 paths');
    assert.equal(hit.rewrittenPaths.length, 30, 'the clobbered rewrite reads as 30 paths');
    assert.ok(hit.extraPaths.includes('sib-0.txt'), 'the rolled-back upstream paths are named');
  } finally {
    f.cleanup();
  }
});

test('plan 4237 T1: a clean two-pick rebase passes the guard and pushes as before', () => {
  const f = makeReplayClobberFixture({ clobber: false });
  try {
    pushMasterWithRebase(f.dir);
    const tip = f.g(f.origin, 'rev-parse', 'master');
    assert.notEqual(tip, f.sibTip, 'our rebased commits reached origin');
    const files = f.g(f.origin, 'ls-tree', '--name-only', 'master').split('\n');
    for (const p of ['sib-0.txt', 'sib-27.txt', 'runbook.md', 'doc-a.md', 'doc-b.md'])
      assert.ok(files.includes(p), `origin tree keeps ${p}`);
    assert.equal(
      readCoordOpJournal(f.dir).some((e) => e.tool === 'push-rebase-replay-mismatch'),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('plan 4237 T1: replayMismatches — patch-id equality accepts, a path SUBSET accepts, an extra path refuses', () => {
  const o = (key, paths, patchId) => ({ sha: `o-${key}`, key, paths, patchId });
  const r = (key, paths, patchId) => ({ sha: `r-${key}`, key, paths, patchId });
  // identical change (same patch-id) → accepted even if the path lists were somehow different
  assert.deepEqual(replayMismatches([o('k1', ['a'], 'P')], [r('k1', ['a'], 'P')]), []);
  // context moved (patch-id differs) but same paths → accepted
  assert.deepEqual(replayMismatches([o('k1', ['a', 'b'], 'P')], [r('k1', ['a', 'b'], 'Q')]), []);
  // part of the change already upstream → the rewrite touches a SUBSET → accepted
  assert.deepEqual(replayMismatches([o('k1', ['a', 'b'], 'P')], [r('k1', ['a'], 'Q')]), []);
  // an original the rebase dropped (already upstream / became empty) → accepted
  assert.deepEqual(
    replayMismatches([o('k1', ['a'], 'P'), o('k2', ['b'], 'R')], [r('k2', ['b'], 'R')]),
    [],
  );
  // extra paths → refused, naming them
  const bad = replayMismatches([o('k1', ['a'], 'P')], [r('k1', ['a', 'x', 'y'], 'Q')]);
  assert.equal(bad.length, 1);
  assert.deepEqual(bad[0].extraPaths, ['x', 'y']);
  // a rewritten commit with no original at all → refused
  const orphan = replayMismatches([o('k1', ['a'], 'P')], [r('zz', ['a'], 'P')]);
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0].reason, 'no-original');
});

// plan 4237 T2: LOCK_FREE_READ_ENV must actually reach the git child through the coord git()
// seam (gitRaw's env composition strips repo selectors and scrubs CHILD_ENV_STRIP — a layer
// that silently dropped GIT_OPTIONAL_LOCKS would leave every MAIN poller writing the index back).
// Observable: a `git status` over stale stat info REWRITES the index (optional-lock refresh);
// under LOCK_FREE_READ_ENV it must not.
test('plan 4237 T2: a status read with LOCK_FREE_READ_ENV never writes the index back; a plain one does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-lockfree-'));
  try {
    const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'x@x');
    g('config', 'user.name', 'x');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    g('add', 'a.txt');
    g('commit', '-qm', 'a');
    const idx = join(dir, '.git', 'index');
    const makeStatStale = () => {
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(idx, old, old);
      const newer = new Date(Date.now() - 60_000);
      utimesSync(join(dir, 'a.txt'), newer, newer); // stat info changed, content unchanged
      return statSync(idx).mtimeMs;
    };
    let before = makeStatStale();
    git(dir, ['status', '--porcelain'], { env: LOCK_FREE_READ_ENV });
    assert.equal(statSync(idx).mtimeMs, before, 'the lock-free read left the index untouched');
    before = makeStatStale();
    git(dir, ['status', '--porcelain']);
    assert.notEqual(
      statSync(idx).mtimeMs,
      before,
      'control: a plain status does refresh + write the index (else this test proves nothing)',
    );
    assert.deepEqual({ ...LOCK_FREE_READ_ENV }, { GIT_OPTIONAL_LOCKS: '0' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── plan 971: COORD_MAIN_DIR override + detached-worktree push (HEAD:master) ──
// done-worktree runs its post-merge bookkeeping in an EPHEMERAL detached worktree off
// origin/master so foreign dirt on the shared main checkout can never block a land.

test('plan 971: resolveMain honours the COORD_MAIN_DIR override and skips the on-master assert', () => {
  const prev = process.env.COORD_MAIN_DIR;
  process.env.COORD_MAIN_DIR = 'C:/some/ephemeral/finish-worktree';
  try {
    // returns the override verbatim — no porcelain probe, no "expected master" throw (the
    // finish worktree is a detached checkout, never on a master branch).
    assert.equal(resolveMain(), 'C:/some/ephemeral/finish-worktree');
  } finally {
    if (prev === undefined) delete process.env.COORD_MAIN_DIR;
    else process.env.COORD_MAIN_DIR = prev;
  }
});

test('plan 971: masterPushSpec is "master" on a branch checkout, "HEAD:master" when detached', () => {
  const s = makeOriginAndClones();
  try {
    assert.equal(masterPushSpec(s.B), 'master'); // B is checked out on the master branch
    const eph = join(s.root, 'fin-spec');
    execFileSync('git', ['-C', s.B, 'worktree', 'add', '--detach', eph, 'origin/master']);
    assert.equal(masterPushSpec(eph), 'HEAD:master'); // detached → explicit source ref
  } finally {
    s.cleanup();
  }
});

test('plan 971: coordWrite in a DETACHED finish worktree lands via HEAD:master even when the MAIN checkout is dirty (the 956 blocker)', () => {
  const s = makeOriginAndClones();
  try {
    // a detached finish worktree off origin/master, sharing B's .git (the done-worktree shape)
    const eph = join(s.root, 'fin');
    execFileSync('git', ['-C', s.B, 'worktree', 'add', '--detach', eph, 'origin/master']);
    execFileSync('git', ['-C', eph, 'config', 'user.email', 'fin@t.t']);
    execFileSync('git', ['-C', eph, 'config', 'user.name', 'fin']);
    // dirty the MAIN checkout (B) with a FOREIGN tracked-file edit — exactly the staged/edited
    // sibling doc that REFUSED the post-merge coordWrites and blocked the 956 land for 44 min.
    writeFileSync(join(s.B, 'base.txt'), 'FOREIGN SIBLING DIRT\n');

    // the bookkeeping coordWrite runs against the CLEAN detached worktree, not B:
    const r = coordWrite(eph, {
      relPaths: ['board.md'],
      mutate: () => writeFileSync(join(eph, 'board.md'), 'LANDING row\n'),
      message: 'board: land bookkeeping',
      tool: 'board',
    });
    assert.ok(
      r.attempts >= 1 && !r.noop,
      'the coordWrite committed + pushed (not refused, not no-op)',
    );

    // it landed on origin/master via HEAD:master, DESPITE B being dirty
    execFileSync('git', ['-C', eph, 'fetch', 'origin', 'master'], { encoding: 'utf8' });
    assert.match(
      execFileSync('git', ['-C', eph, 'log', 'origin/master', '--oneline'], { encoding: 'utf8' }),
      /board: land bookkeeping/,
      'the bookkeeping commit reached origin/master',
    );
    assert.match(
      execFileSync('git', ['-C', eph, 'show', 'origin/master:board.md'], { encoding: 'utf8' }),
      /LANDING row/,
      'the mutated content is on origin/master',
    );
    // and the FOREIGN dirt in the shared main checkout was never touched
    assert.equal(readFileSync(join(s.B, 'base.txt'), 'utf8'), 'FOREIGN SIBLING DIRT\n');
  } finally {
    s.cleanup();
  }
});

// ── plan 1455: coordWrite commits survive a host with NO configured git identity ──────────────
// A coordWrite-routed commit derives its author/committer from the ambient git identity; on an
// identity-less host (fresh container, un-configured contributor machine, another CI provider) that
// identity is absent and git() would fatal `empty ident name`. git()'s probe injects a fallback
// github-actions[bot] identity ONLY when none is configured, and preserves a configured one.

// A bare origin + a clone whose LOCAL identity has been stripped. The base commit is seeded with a
// throwaway identity (a commit needs one), then user.name/user.email are unset so the clone is
// identity-less. The caller neutralizes GLOBAL/SYSTEM config via env (see the test) so the host's
// own git identity can't leak in and mask the gap.
function makeIdentitylessOrigin() {
  const root = mkdtempSync(join(tmpdir(), 'coord-noident-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  const dir = join(root, 'work');
  execFileSync('git', ['clone', '-q', origin, dir]);
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  // seed with a throwaway identity, then REMOVE it → the clone has no local identity
  g('config', 'user.email', 'seed@t.t');
  g('config', 'user.name', 'seed');
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  g('add', 'base.txt');
  g('commit', '-qm', 'base');
  g('push', '-q', 'origin', 'master');
  g('branch', '--set-upstream-to=origin/master', 'master');
  g('config', '--unset', 'user.email');
  g('config', '--unset', 'user.name');
  return { dir, origin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('coordWrite: succeeds on a host with NO git identity (fallback injected, not `empty ident name`)', () => {
  const { dir, origin, cleanup } = makeIdentitylessOrigin();
  // Neutralize the HOST's global+system identity for every git child this test spawns (the probe
  // AND the commit), so the identity-less condition is genuine and not masked by the test machine's
  // own `git config --global user.email`. Restored in finally (node:test runs top-level tests
  // sequentially; mirrors the COORD_MAIN_DIR save/restore pattern above).
  const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = join(dir, 'no-such-global-gitconfig');
  try {
    // Sanity: the environment really IS identity-less (a raw identity read fatals), so this test
    // would reproduce `empty ident name` without the fallback — not a vacuous pass.
    assert.throws(
      () => execFileSync('git', ['-C', dir, 'config', 'user.email'], { encoding: 'utf8' }),
      'the clone must have no resolvable git identity for this test to be meaningful',
    );
    const res = coordWrite(dir, {
      relPaths: ['c.txt'],
      mutate: () => writeFileSync(join(dir, 'c.txt'), 'coord\n'),
      message: 'test: identity-less write',
      tool: 'unit',
    });
    assert.ok(res.attempts >= 1 && !res.noop, 'the write committed + pushed');
    // it landed on origin...
    execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin', 'master']);
    assert.match(
      execFileSync('git', ['-C', dir, 'show', 'origin/master:c.txt'], { encoding: 'utf8' }),
      /coord/,
      'the coord doc reached origin/master',
    );
    // ...authored by the injected fallback identity
    const ae = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%ae', 'origin/master'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(
      ae,
      COORD_FALLBACK_IDENTITY.GIT_AUTHOR_EMAIL,
      'commit authored by the fallback bot',
    );
  } finally {
    if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    cleanup();
  }
});

test('coordWrite: a CONFIGURED identity is preserved, never overridden by the fallback', () => {
  // makeBareOrigin sets a local identity (work <work@t.t>); the commit must be authored by THAT,
  // proving git() does not unconditionally stamp the bot identity over a real one.
  const { dir, origin, cleanup } = makeBareOrigin();
  try {
    coordWrite(dir, {
      relPaths: ['c.txt'],
      mutate: () => writeFileSync(join(dir, 'c.txt'), 'coord\n'),
      message: 'test: configured-identity write',
      tool: 'unit',
    });
    execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin', 'master']);
    const [an, ae] = execFileSync(
      'git',
      ['-C', dir, 'log', '-1', '--format=%an%n%ae', 'origin/master'],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n');
    assert.equal(ae, 'work@t.t', 'the operator’s configured email must author the commit');
    assert.equal(an, 'work', 'the operator’s configured name must author the commit');
    assert.notEqual(ae, COORD_FALLBACK_IDENTITY.GIT_AUTHOR_EMAIL, 'the fallback must NOT be used');
  } finally {
    cleanup();
  }
});

test('COORD_FALLBACK_IDENTITY matches the github-actions[bot] pair ci.yml uses (stay in sync)', () => {
  // The value is deliberately the same one .github/workflows/ci.yml configures (plan 1451 review [6]:
  // one canonical CI identity, not a second invented bot). Author and committer are the same bot.
  assert.equal(COORD_FALLBACK_IDENTITY.GIT_AUTHOR_NAME, 'github-actions[bot]');
  assert.equal(
    COORD_FALLBACK_IDENTITY.GIT_AUTHOR_EMAIL,
    '41898282+github-actions[bot]@users.noreply.github.com',
  );
  assert.equal(COORD_FALLBACK_IDENTITY.GIT_COMMITTER_NAME, COORD_FALLBACK_IDENTITY.GIT_AUTHOR_NAME);
  assert.equal(
    COORD_FALLBACK_IDENTITY.GIT_COMMITTER_EMAIL,
    COORD_FALLBACK_IDENTITY.GIT_AUTHOR_EMAIL,
  );
});

// ── plan 1771: NUL-fill metadata-corruption classifier + heal-pointer annotation ──────────

test('plan 1771: isMetadataCorruption matches exactly the two observed corruption wordings', () => {
  assert.ok(isMetadataCorruption('fatal: bad config line 1 in file C:/…/.git/config'));
  assert.ok(isMetadataCorruption('fatal: did not send all necessary objects'));
  // narrow on purpose — kin failures must never be blamed on corruption
  assert.ok(!isMetadataCorruption('fatal: not a git repository'));
  assert.ok(!isMetadataCorruption('error: could not lock config file'));
  assert.ok(!isMetadataCorruption(''));
  assert.ok(!isMetadataCorruption(null));
});

test('plan 1771: annotateMetadataCorruption appends the heal pointer, preserves channels, is idempotent', () => {
  const e = new Error('Command failed: git fetch origin');
  e.stderr = 'fatal: did not send all necessary objects';
  e.stdout = '';
  annotateMetadataCorruption(e);
  assert.ok(e.message.includes('git-metadata-heal'), 'pointer appended');
  assert.equal(e.stderr, 'fatal: did not send all necessary objects', 'stderr channel intact');
  const once = e.message;
  annotateMetadataCorruption(e); // a retry loop may pass the same error twice
  assert.equal(e.message, once, 'idempotent — no double pointer');
  // a non-matching error is returned untouched
  const clean = new Error('fatal: not a git repository');
  annotateMetadataCorruption(clean);
  assert.ok(!clean.message.includes('git-metadata-heal'));
});

test('plan 1771: gitWithLockRetry short-circuits on metadata corruption — no retry, pointer attached', () => {
  const r = makeRepo();
  try {
    let n = 0;
    const _git = () => {
      n++;
      throw new Error('fatal: bad config line 1 in file .git/config');
    };
    assert.throws(
      () => gitWithLockRetry(r.dir, ['status'], { attempts: 5, delayMs: 1, _git }),
      (e) => e.message.includes(METADATA_HEAL_HINT),
    );
    assert.equal(n, 1, 'corruption never self-heals — surfaced on the first attempt');
  } finally {
    r.cleanup();
  }
});

// --- plan 2391: a failed rebase must not strand the checkout DETACHED --------
// `git rebase` detaches HEAD for its duration, and pushMasterWithRebase rebases
// directly on whatever dir it is handed — including the shared MAIN checkout
// (heal-main, drain-run, and pre-yield-guard via the Stop auto-heal hook). If a
// rebase fails and the checkout is left detached, every subsequent commit made
// there is silently eaten by the next pull --rebase. The abort must actually
// return HEAD to master.
test('pushMasterWithRebase: a CONFLICTED rebase throws but leaves HEAD attached', () => {
  const s = makeOriginAndClones();
  try {
    // Both sides edit the SAME file so the rebase cannot auto-merge.
    s.commit(s.B, 'clash.txt', 'B-side');
    s.commit(s.A, 'clash.txt', 'A-side');
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);

    assert.throws(
      () => pushMasterWithRebase(s.B),
      'a conflicted rebase must surface, not be swallowed',
    );

    // The property that matters: we are back on a branch, not stranded detached.
    const head = execFileSync('git', ['-C', s.B, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(head, 'master', 'a failed rebase must not leave the checkout detached');

    // And our commit is still recoverable on the branch (nothing was discarded).
    const log = execFileSync('git', ['-C', s.B, 'log', '--oneline', 'master'], {
      encoding: 'utf8',
    });
    assert.match(log, /B-side/, 'the local commit must survive the failed rebase');
  } finally {
    s.cleanup();
  }
});

// ── abortRebaseAndDiagnose (plan 2391 review: 18b60jb / ghyvpz / 12lthe5 / 1rnavnv / 1epp0nd) ──
// The failed-`rebase --abort` path used to be untestable: pushMasterWithRebase called the
// module-local `git` with no injection seam, and forcing a genuine abort failure needs git's
// rebase state corrupted mid-call. It is now ONE exported primitive with `_git`/`_reattach`
// seams (shared with drain-run's syncIndexOnMaster), so every branch is driven directly here —
// including the two the first cut got wrong (a failed HEAD probe silently skipping the whole
// annotation, and a dirty-tree reattach failure mislabelled as stranded commits).

// A fake `git` that answers from a table keyed on the joined argv; a value that is an Error
// instance is THROWN, anything else returned. Records every call for order assertions.
function fakeGit(table) {
  const calls = [];
  const fn = (dir, args) => {
    const key = args.join(' ');
    calls.push(key);
    const hit = Object.entries(table).find(([k]) => key.startsWith(k));
    const val = hit ? hit[1] : '';
    if (val instanceof Error) throw val;
    return typeof val === 'function' ? val() : val;
  };
  fn.calls = calls;
  return fn;
}

test('abortRebaseAndDiagnose: a SUCCESSFUL abort returns the original error untouched', () => {
  const orig = new Error('CONFLICT (content): merge conflict in f.txt');
  const before = orig.message;
  const _git = fakeGit({ 'rebase --abort': '' });
  const out = abortRebaseAndDiagnose('/nope', orig, { _git });
  assert.equal(out, orig);
  assert.equal(out.message, before, 'the benign case must add NO noise');
  assert.equal(out.abortFailed, undefined);
});

test('abortRebaseAndDiagnose: failed abort + DETACHED head + successful reattach', () => {
  const orig = new Error('CONFLICT');
  const out = abortRebaseAndDiagnose('/nope', orig, {
    _git: fakeGit({
      'rebase --abort': new Error('fatal: no rebase in progress'),
      'rev-parse --abbrev-ref HEAD': 'HEAD\n',
    }),
    _reattach: () => ({ reattached: true }),
  });
  assert.equal(out.detachedAfterFailedAbort, true);
  assert.equal(out.reattached, true);
  assert.equal(out.abortFailed, true);
  assert.match(out.message, /DETACHED mid-rebase/);
  assert.match(out.message, /Auto-reattach SUCCEEDED/);
});

test('abortRebaseAndDiagnose: a REFUSED reattach (detachedUnsafe) names the stranded-work recipe', () => {
  const orig = new Error('CONFLICT');
  const unsafe = new Error('refusing to auto-reattach');
  unsafe.detachedUnsafe = true;
  const out = abortRebaseAndDiagnose('/nope', orig, {
    _git: fakeGit({
      'rebase --abort': new Error('fatal: abort failed'),
      'rev-parse --abbrev-ref HEAD': 'HEAD\n',
    }),
    _reattach: () => {
      throw unsafe;
    },
  });
  assert.equal(out.detachedUnsafe, true);
  assert.equal(out.reattached, false);
  assert.match(out.message, /carries commits no branch has/);
  assert.match(out.message, /log master\.\.HEAD/);
});

// Finding 1rnavnv: `reattachMainToMaster` ALSO throws when `git switch master` refuses over a
// dirty working tree — which a failed abort is exactly the thing that leaves behind. The old
// message told that operator to go hunting `log master..HEAD` for commits that do not exist.
test('abortRebaseAndDiagnose: a NON-detachedUnsafe reattach failure must NOT claim unpushed work', () => {
  const out = abortRebaseAndDiagnose('/nope', new Error('CONFLICT'), {
    _git: fakeGit({
      'rebase --abort': new Error('fatal: abort failed'),
      'rev-parse --abbrev-ref HEAD': 'HEAD\n',
    }),
    _reattach: () => {
      throw new Error('error: Your local changes to the following files would be overwritten');
    },
  });
  assert.equal(out.detachedUnsafe, false);
  assert.doesNotMatch(out.message, /log master\.\.HEAD/);
  assert.doesNotMatch(out.message, /carries commits no branch has/);
  assert.match(out.message, /UNRELATED to stranded commits/);
  assert.match(out.message, /git -C <main> status/);
  assert.match(out.message, /would be overwritten/, 'the REAL error must be surfaced');
});

// Findings ghyvpz + 12lthe5: when the HEAD probe ALSO throws, the old code left `head` null,
// never entered the `head === 'HEAD'` branch, and therefore emitted NOTHING — despite its own
// comment claiming it "falls through to the annotation below". Silence was the bug.
test('abortRebaseAndDiagnose: an UNREADABLE HEAD is still annotated, not silently skipped', () => {
  const out = abortRebaseAndDiagnose('/nope', new Error('CONFLICT'), {
    _git: fakeGit({
      'rebase --abort': new Error('fatal: abort failed'),
      'rev-parse --abbrev-ref HEAD': new Error('fatal: unable to read HEAD'),
    }),
    _reattach: () => assert.fail('must not attempt a reattach with an unknown HEAD state'),
  });
  assert.equal(out.headStateUnknown, true);
  assert.equal(out.abortFailed, true);
  assert.match(out.message, /HEAD state could NOT be determined/);
  assert.match(out.message, /heal-main\.mjs/);
});

test('abortRebaseAndDiagnose: a failed abort with HEAD still ATTACHED says so (no false alarm)', () => {
  const out = abortRebaseAndDiagnose('/nope', new Error('CONFLICT'), {
    _git: fakeGit({
      'rebase --abort': new Error('fatal: no rebase in progress'),
      'rev-parse --abbrev-ref HEAD': 'master\n',
    }),
    _reattach: () => assert.fail('an attached HEAD needs no reattach'),
  });
  assert.equal(out.detachedAfterFailedAbort, false);
  assert.match(out.message, /HEAD is still attached \(master\)/);
  assert.doesNotMatch(out.message, /DETACHED mid-rebase/);
});

// Finding 1epp0nd: prove the seam actually reaches pushMasterWithRebase's own failure path —
// the whole non-ff → fetch → rebase → failed-abort → self-heal chain, driven end to end
// through ONE injected git (which reattachMainToMaster inherits, so its ancestor check and
// `switch master` are driven too).
test('pushMasterWithRebase: routes a failed rebase --abort through the diagnosis + self-heal', () => {
  const nonFf = new Error('! [rejected] master -> master (non-fast-forward)');
  const _git = fakeGit({
    push: nonFf,
    'fetch origin master': '',
    'rebase origin/master': new Error('CONFLICT (content)'),
    'rebase --abort': new Error('fatal: abort failed'),
    'rev-parse --abbrev-ref HEAD': 'HEAD\n',
    'rev-parse HEAD': 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n',
    'fetch --quiet origin master': '',
    'merge-base --is-ancestor': '', // ancestor of origin/master → safe to reattach
    'switch master': '',
  });
  const dir = mkdtempSync(join(tmpdir(), 'cg-abortdiag-'));
  try {
    let thrown;
    assert.throws(
      () => pushMasterWithRebase(dir, { retries: 3, _git }),
      (e) => ((thrown = e), true),
    );
    assert.equal(thrown.detachedAfterFailedAbort, true);
    assert.equal(thrown.reattached, true);
    assert.match(thrown.message, /Auto-reattach SUCCEEDED/);
    assert.ok(
      _git.calls.includes('rebase --abort'),
      'the abort must still be attempted before diagnosing',
    );
    assert.ok(_git.calls.includes('switch master'), 'the self-heal must reach `git switch`');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const headOf = (d) =>
  execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

// ── plan 2393 lever 1: the critical section ends at the commit ────────────────────────────────
// The measured cost was ~4s of every op's ~9s hold spent on network round-trips (push + verify)
// under a mutex all ~7 sessions queue on. These tests pin the BOUNDARY (release after the commit,
// before the push), the sha PINNING that makes it safe, and the rollback's concurrency guard.

test('plan 2393: coordWrite releases the lock AFTER the commit and BEFORE the push', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const events = [];
    const lockCtx = {
      release: () => events.push(`release@${headOf(dir)}`),
      reacquire: () => events.push('reacquire'),
      held: true,
    };
    // The push must be observed AFTER the release, and the release must already see our commit at
    // HEAD (i.e. the commit is inside the critical section, the push is outside it).
    const _git = (d, args, opts) => {
      if (args[0] === 'push') events.push(`push@${args[2].split(':')[0]}`);
      return git(d, args, opts);
    };
    coordWrite(dir, {
      relPaths: ['boundary.txt'],
      mutate: () => writeFileSync(join(dir, 'boundary.txt'), 'x\n'),
      message: 'test: boundary',
      tool: 'unit',
      lockCtx,
      _git,
    });
    const committed = headOf(dir);
    assert.deepEqual(
      events,
      [`release@${committed}`, `push@${committed}`],
      'order must be commit → release → push, and the push must name the pinned commit sha',
    );
    assert.ok(!events.includes('reacquire'), 'no rollback on a clean first-attempt push');
  } finally {
    cleanup();
  }
});

test('plan 2393: the push names the PINNED sha, so a checkout reset in the released window cannot substitute another commit', () => {
  const { dir, origin, cleanup } = makeBareOrigin();
  try {
    // A sibling lands an unrelated commit, then — in OUR released window — hard-resets our
    // checkout onto that tip, exactly as resolveCoordCheckout does at the start of every op.
    const sib = cloneOf(origin);
    writeFileSync(join(sib, 'sibling.txt'), 'theirs\n');
    execFileSync('git', ['-C', sib, 'add', 'sibling.txt']);
    execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling']);
    execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
    let ours;
    const lockCtx = {
      release: () => {
        ours = headOf(dir);
        execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin', 'master']);
        execFileSync('git', ['-C', dir, 'reset', '--hard', '-q', 'origin/master']);
      },
      reacquire: () => {},
      held: true,
    };
    // First push is non-ff (the sibling moved origin), so this also exercises the retry path with
    // a checkout whose HEAD is no longer ours.
    coordWrite(dir, {
      relPaths: ['ours.txt'],
      mutate: () => writeFileSync(join(dir, 'ours.txt'), 'ours\n'),
      message: 'test: pinned sha',
      tool: 'unit',
      lockCtx,
    });
    assert.ok(ours, 'release must have run');
    const tree = execFileSync('git', ['-C', origin, 'ls-tree', '-r', '--name-only', 'master'], {
      encoding: 'utf8',
    });
    assert.match(tree, /ours\.txt/, 'our write must land despite the reset in the released window');
    assert.match(tree, /sibling\.txt/, "the sibling's commit must survive");
  } finally {
    cleanup();
  }
});

test('plan 2393: a non-ff rollback re-takes the lock and does NOT reset a HEAD that moved under it', () => {
  const { dir, origin, cleanup } = makeBareOrigin();
  try {
    const sib = cloneOf(origin);
    let pushedSibling = false;
    let reacquires = 0;
    // Move HEAD off our commit during the released window of the FIRST attempt only. The rollback
    // must then skip `reset --soft HEAD~1` — resetting would amputate the commit now at HEAD,
    // which is the sibling's, not ours.
    const lockCtx = {
      release: () => {
        if (!pushedSibling) return;
        execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin', 'master']);
        execFileSync('git', ['-C', dir, 'reset', '--hard', '-q', 'origin/master']);
      },
      reacquire: () => {
        reacquires++;
      },
      held: true,
    };
    coordWrite(dir, {
      relPaths: ['gen.txt'],
      mutate: () => {
        if (!pushedSibling) {
          writeFileSync(join(sib, 's.txt'), 'x\n');
          execFileSync('git', ['-C', sib, 'add', 's.txt']);
          execFileSync('git', ['-C', sib, 'commit', '-qm', 's']);
          execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
          pushedSibling = true; // forces exactly one non-ff
        }
        writeFileSync(join(dir, 'gen.txt'), 'ours\n');
      },
      message: 'test: rollback under concurrency',
      tool: 'unit',
      lockCtx,
    });
    assert.equal(
      reacquires,
      1,
      'the rollback must re-take the lock exactly once (the non-ff path)',
    );
    const tree = execFileSync('git', ['-C', origin, 'ls-tree', '-r', '--name-only', 'master'], {
      encoding: 'utf8',
    });
    assert.match(tree, /gen\.txt/, 'our write lands on the retry');
    assert.match(tree, /s\.txt/, "the sibling's commit is never amputated by our rollback");
  } finally {
    cleanup();
  }
});

test('plan 2393: assertPushReachedOrigin verifies the PINNED sha, not a moved HEAD (no false pass)', () => {
  const { dir, origin, cleanup } = makeBareOrigin();
  try {
    // Build a commit that never reaches origin, then move HEAD to a commit that origin DOES
    // contain. The old `rev-parse HEAD` read would verify the reachable one and pass; pinning the
    // unreachable sha must throw.
    writeFileSync(join(dir, 'never.txt'), 'unpushed\n');
    execFileSync('git', ['-C', dir, 'add', 'never.txt']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'never pushed']);
    const unreachable = headOf(dir);
    execFileSync('git', ['-C', dir, 'reset', '--hard', '-q', 'origin/master']);
    const reachable = headOf(dir);
    assert.notEqual(unreachable, reachable);
    // control: unpinned still reads HEAD and passes (back-compat for callers that pin nothing)
    assertPushReachedOrigin(dir, 'master', { ...process.env });
    assert.throws(
      () => assertPushReachedOrigin(dir, 'master', { ...process.env }, { sha: unreachable }),
      (e) => e.pushUnverified === true,
      'a pinned sha origin does not contain must throw .pushUnverified, never silently pass',
    );
    assert.ok(existsSync(join(origin, 'HEAD')), 'origin fixture intact');
  } finally {
    cleanup();
  }
});

test('plan 2393: withCoordLock hands fn a release/reacquire handle — idempotent, journal stays foldable', () => {
  const { dir, cleanup } = makeBareOrigin();
  const saved = process.env.COORD_MAIN_DIR;
  delete process.env.COORD_MAIN_DIR;
  try {
    const lockPath = coordLockPath(dir);
    let seen;
    withCoordLock(
      dir,
      (ctx) => {
        seen = ctx;
        assert.ok(existsSync(lockPath), 'lock held when fn starts');
        assert.equal(ctx.held, true);
        ctx.release();
        assert.ok(!existsSync(lockPath), 'release hands the lock back mid-op');
        assert.equal(ctx.held, false);
        ctx.release(); // idempotent — must never double-release a lock a sibling could now hold
        assert.ok(!existsSync(lockPath));
        ctx.reacquire();
        assert.ok(existsSync(lockPath), 'reacquire re-takes the same lock for the rollback window');
        assert.equal(ctx.held, true);
        ctx.reacquire(); // idempotent
      },
      { tool: 'unit-2393' },
    );
    assert.ok(!existsSync(lockPath), 'lock released when the op ends');
    assert.equal(seen.held, false);
    // heal-main's openCoordOps folds any non-start line as a close and a fresh start as a re-open,
    // so start → release → start → done leaves NO op open (nothing to heal after the op).
    const phases = readCoordOpJournal(dir)
      .filter((e) => e.tool === 'unit-2393')
      .map((e) => e.phase);
    assert.deepEqual(phases, ['start', 'release', 'start', 'done']);
  } finally {
    if (saved !== undefined) process.env.COORD_MAIN_DIR = saved;
    cleanup();
  }
});

// review 2026-07-25 findings 4+5: an early release must NOT swallow the op's terminal journal line.
// Losing `done` would undercount completions for anything keying on it; losing `error` would hide a
// post-release failure (an assertPushReachedOrigin throw) from the journal entirely.
test('plan 2393: an early release still journals the terminal phase — done on success, error on throw', () => {
  const { dir, cleanup } = makeBareOrigin();
  const saved = process.env.COORD_MAIN_DIR;
  delete process.env.COORD_MAIN_DIR;
  const phasesFor = (tool) =>
    readCoordOpJournal(dir)
      .filter((e) => e.tool === tool)
      .map((e) => e.phase);
  try {
    // released, never reacquired, returns normally → the `done` must survive
    withCoordLock(dir, (ctx) => ctx.release(), { tool: 'unit-2393-ok' });
    assert.deepEqual(phasesFor('unit-2393-ok'), ['start', 'release', 'done']);
    // released, then throws (the post-release verify-failure shape) → `error` must survive
    assert.throws(
      () =>
        withCoordLock(
          dir,
          (ctx) => {
            ctx.release();
            const e = new Error('verify failed after release');
            e.pushUnverified = true;
            throw e;
          },
          { tool: 'unit-2393-boom' },
        ),
      /verify failed after release/,
    );
    assert.deepEqual(phasesFor('unit-2393-boom'), ['start', 'release', 'error']);
    assert.ok(!existsSync(coordLockPath(dir)), 'no lock leaked on either path');
  } finally {
    if (saved !== undefined) process.env.COORD_MAIN_DIR = saved;
    cleanup();
  }
});

// review 2026-07-25 finding 3: if the rollback cannot re-take the lock, the PUSH error is the
// diagnosis worth keeping — a lock-timeout must not replace it, and the loop must not continue
// unlocked (that would re-mutate the shared checkout with no mutual exclusion).
test('plan 2393: a failed reacquire surfaces the original push error, annotated — never masks it', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const boom = new Error('could not re-take the coord lock (timeout)');
    const lockCtx = {
      release: () => {},
      reacquire: () => {
        throw boom;
      },
      held: true,
    };
    // A non-retryable push failure (not a lock class, not a non-ff) — the shape where the original
    // error carries the real diagnosis.
    const _git = (d, args, opts) => {
      if (args[0] === 'push') throw new Error('remote: pre-receive hook declined');
      return git(d, args, opts);
    };
    assert.throws(
      () =>
        coordWrite(dir, {
          relPaths: ['x.txt'],
          mutate: () => writeFileSync(join(dir, 'x.txt'), 'x\n'),
          message: 'test: reacquire failure',
          tool: 'unit',
          lockCtx,
          _git,
        }),
      (e) => /pre-receive hook declined/.test(e.message) && e.reacquireFailed === boom,
      'the push error must surface with the reacquire failure attached as context',
    );
  } finally {
    cleanup();
  }
});

// ── plan 2435 item 2: error-phase journal `reason` + foreign dirt named at exhaustion ──────────

test('plan 2435: coordErrorReason classifies the coord failure vocabulary', () => {
  const mk = (msg, props = {}) => Object.assign(new Error(msg), props);
  assert.equal(coordErrorReason(null), 'unknown');
  assert.equal(coordErrorReason(mk('x', { pushUnverified: true })), 'push-unverified');
  assert.equal(coordErrorReason(mk('x', { coordContention: true })), 'lock-contention');
  assert.equal(coordErrorReason(mk('x', { reacquireFailed: new Error('b') })), 'reacquire-failed');
  // the discriminator this field exists to create — keyed on the STRUCTURED flag coordWrite sets,
  // never on the prose (review 2026-07-26, finding 6)
  assert.equal(coordErrorReason(mk('…', { coordWriteExhausted: true })), 'exhausted-nonff');
  assert.equal(
    coordErrorReason(
      mk('…', { coordWriteExhausted: true, foreignDirtAtExhaustion: ['docs/INDEX.md'] }),
    ),
    'exhausted-foreign-dirt',
  );
  // review finding 6: SIBLING tools exhaust their OWN retry loops with the SAME "kept advancing"
  // prose (claim-plan's claim projection, coord-edit's apply loop) and also run inside
  // withCoordCheckout → withCoordLock. Text-matching mined them as coordWrite exhaustions and
  // silently polluted the signature; they must NOT be classified as one.
  assert.equal(
    coordErrorReason(
      mk(
        'claim-plan: claim projection for 2435 blocked after 6 attempts — origin/master kept advancing.',
      ),
    ),
    'other',
    "a sibling tool's own exhaustion must not read as a coordWrite exhaustion",
  );
  assert.equal(
    coordErrorReason(mk('coord-edit: blocked after 8 attempts — origin/master kept advancing.')),
    'other',
  );
  // a real coordWrite exhaustion still wins over the generic non-ff classifier
  const exhausted = mk('coordWrite(a) blocked after 8 attempts — origin/master kept advancing.', {
    coordWriteExhausted: true,
  });
  exhausted.cause = mk('! [rejected] master -> master (non-fast-forward)');
  assert.equal(coordErrorReason(exhausted), 'exhausted-nonff');
  assert.equal(
    coordErrorReason(mk("refusing to run — OUTSIDE this tool's pathspec:\n  M docs/INDEX.md")),
    'foreign-dirt',
  );
  assert.equal(coordErrorReason(mk('! [rejected] x -> x (non-fast-forward)')), 'non-ff');
  assert.equal(coordErrorReason(mk('something else entirely')), 'other');
});

test('plan 2435: an error-phase journal line carries a reason; start/release/done do not', () => {
  const { dir, cleanup } = makeBareOrigin();
  const saved = process.env.COORD_MAIN_DIR;
  delete process.env.COORD_MAIN_DIR;
  try {
    assert.throws(
      () =>
        withCoordLock(
          dir,
          () => {
            const e = new Error('verify failed');
            e.pushUnverified = true;
            throw e;
          },
          { tool: 'unit-2435-err' },
        ),
      /verify failed/,
    );
    const entries = readCoordOpJournal(dir).filter((e) => e.tool === 'unit-2435-err');
    assert.deepEqual(
      entries.map((e) => e.phase),
      ['start', 'error'],
    );
    assert.equal(entries[0].reason, undefined, 'a start line must keep its old shape');
    assert.equal(entries[1].reason, 'push-unverified');
    // success path stays reason-free
    withCoordLock(dir, () => {}, { tool: 'unit-2435-ok' });
    const ok = readCoordOpJournal(dir).filter((e) => e.tool === 'unit-2435-ok');
    assert.deepEqual(
      ok.map((e) => e.phase),
      ['start', 'done'],
    );
    assert.ok(
      ok.every((e) => e.reason === undefined),
      'non-error phases must not carry a reason',
    );
  } finally {
    if (saved !== undefined) process.env.COORD_MAIN_DIR = saved;
    cleanup();
  }
});

// ── plan 4136 E2: a `start` line records how long the acquire QUEUED, not just when it won ──

test('withCoordLock: a contended acquire journals a start with waitMs >= the injected wait', () => {
  const { dir, cleanup } = makeBareOrigin();
  const saved = process.env.COORD_MAIN_DIR;
  delete process.env.COORD_MAIN_DIR;
  try {
    const lockPath = coordLockPath(dir);
    // A foreign, FRESH holder occupies the lock before our acquire even starts — this forces
    // acquireCoordLock's BUSY/sleep branch on its first attempt (never reclaimed as stale: its
    // iso and our injected `now` both start at 0, so age reads 0).
    writeFileSync(
      lockPath,
      JSON.stringify({ token: 'foreign', pid: 1, host: 'H', iso: new Date(0).toISOString() }),
    );
    let clockMs = 0;
    const WAIT_MS = 200;
    let sleepCalls = 0;
    withCoordLock(dir, () => {}, {
      tool: 'unit-4136-wait',
      now: () => clockMs,
      // Deterministic stand-in for a real ~200ms wait behind a sibling: advances the SAME
      // injected clock withCoordLock reads for its wait measurement, then frees the foreign
      // holder so the very next O_EXCL attempt succeeds — one busy cycle, no real sleeping.
      sleep: () => {
        sleepCalls++;
        clockMs += WAIT_MS;
        try {
          unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      },
      staleMs: 999_999_999, // never reclaim the foreign holder as stale — only the sleep frees it
    });
    assert.equal(sleepCalls, 1, 'exactly one busy cycle before the foreign lock was released');
    const entries = readCoordOpJournal(dir).filter((e) => e.tool === 'unit-4136-wait');
    assert.deepEqual(
      entries.map((e) => e.phase),
      ['start', 'done'],
    );
    assert.ok(
      entries[0].waitMs >= WAIT_MS,
      `expected start.waitMs >= ${WAIT_MS}, got ${entries[0].waitMs}`,
    );
    assert.equal(entries[1].waitMs, undefined, 'a done/close line never carries waitMs');
  } finally {
    if (saved !== undefined) process.env.COORD_MAIN_DIR = saved;
    cleanup();
  }
});

test('withCoordLock: an uncontended acquire journals waitMs 0, not undefined', () => {
  const { dir, cleanup } = makeBareOrigin();
  const saved = process.env.COORD_MAIN_DIR;
  delete process.env.COORD_MAIN_DIR;
  try {
    withCoordLock(dir, () => {}, { tool: 'unit-4136-nowait', now: () => 5000 });
    const entries = readCoordOpJournal(dir).filter((e) => e.tool === 'unit-4136-nowait');
    assert.equal(entries[0].phase, 'start');
    assert.equal(entries[0].waitMs, 0, 'a clean, first-try acquire waited zero ms');
  } finally {
    if (saved !== undefined) process.env.COORD_MAIN_DIR = saved;
    cleanup();
  }
});

test('plan 2435: exhaustion NAMES foreign dirt that appeared after the entry check', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    // a second TRACKED file, clean at entry — the dirt lands mid-loop, exactly the shape the
    // one-time precondition cannot see (a sibling coordWrite running inside our released window).
    writeFileSync(join(dir, 'sibling.txt'), 'clean\n');
    execFileSync('git', ['-C', dir, 'add', 'sibling.txt']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'add sibling.txt']);
    execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'master']);
    // force every push non-ff so the loop exhausts
    const nonFf = (d, args, opts) => {
      if (args[0] === 'push') {
        const e = new Error('push rejected');
        e.stderr = '! [rejected]  master -> master (non-fast-forward)\nerror: failed to push';
        throw e;
      }
      return git(d, args, opts);
    };
    let threw;
    try {
      coordWrite(dir, {
        relPaths: ['ours.txt'],
        attempts: 1,
        _git: nonFf,
        mutate: () => {
          writeFileSync(join(dir, 'ours.txt'), 'ours\n');
          // the foreign dirt appears HERE — after assertCleanOutsidePathspec already passed
          writeFileSync(join(dir, 'sibling.txt'), 'dirty\n');
        },
        message: 'test: exhaust',
        tool: 'unit-2435',
      });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, 'coordWrite must throw once the attempt budget is spent');
    assert.match(threw.message, /kept advancing/);
    assert.equal(threw.coordWriteExhausted, true, 'the structural exhaustion marker must be set');
    assert.deepEqual(threw.foreignDirtAtExhaustion, ['sibling.txt']);
    assert.match(threw.message, /sibling\.txt/);
    assert.match(threw.message, /appeared AFTER this op's entry check/);
    // must NOT be classified as a foreign-dirt REFUSAL: retryOnForeignDirt retries those, and an
    // exhaustion is terminal — matching would silently multiply the retry budget.
    assert.equal(
      isForeignDirtRefusal(threw),
      false,
      'the exhaustion error must not masquerade as a pre-mutation refusal',
    );
    assert.equal(coordErrorReason(threw), 'exhausted-foreign-dirt');
  } finally {
    cleanup();
  }
});

test('plan 2435: a CLEAN exhaustion keeps the old message and classifies as exhausted-nonff', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const nonFf = (d, args, opts) => {
      if (args[0] === 'push') {
        const e = new Error('push rejected');
        e.stderr = '! [rejected]  master -> master (non-fast-forward)';
        throw e;
      }
      return git(d, args, opts);
    };
    let threw;
    try {
      coordWrite(dir, {
        relPaths: ['ours.txt'],
        attempts: 1,
        _git: nonFf,
        mutate: () => writeFileSync(join(dir, 'ours.txt'), 'ours\n'),
        message: 'test: exhaust clean',
        tool: 'unit-2435-clean',
      });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw);
    assert.match(threw.message, /kept advancing/);
    assert.equal(threw.coordWriteExhausted, true, 'the structural exhaustion marker must be set');
    assert.equal(threw.foreignDirtAtExhaustion, undefined, 'no dirt ⇒ no property, no extra prose');
    assert.doesNotMatch(threw.message, /appeared AFTER/);
    assert.equal(coordErrorReason(threw), 'exhausted-nonff');
  } finally {
    cleanup();
  }
});

// ── plan 2604: the scrub must never eat git's own non-interactive suppression ────────────────
test("plan 2604: gitRaw's scrub keeps GIT_TERMINAL_PROMPT/GCM_INTERACTIVE, drops only an explicitly-named var", async () => {
  // The highest-risk interaction in this plan's diff, and it is safe ONLY by an argument default.
  // gitRaw now scrubs the FULLY MERGED env — `childEnv({ ...process.env, ...env,
  // ...GIT_NONINTERACTIVE_ENV })` — and GIT_NONINTERACTIVE_ENV is `{ GCM_INTERACTIVE: 'never',
  // GIT_TERMINAL_PROMPT: '0' }`. One of those two keys starts with `GIT_`. childEnv strips a
  // prefix ONLY when asked (`prefixes` defaults to []), so today they survive — but the day
  // someone "tidies up" by passing GIT_ENV_PREFIXES here, git's interactive-credential
  // suppression silently vanishes and the GCM dialog comes back mid-land: the plan-774 crash
  // class, whose whole point was that a blocked dialog wedges a land with no error text.
  // Pinned as a test rather than a comment, because a comment cannot fail.
  //
  // plan 3832: `ALLOW_LANDED_REVERSION` (CHILD_ENV_STRIP's former sole, motivating entry) was
  // retired with the landed-reversion halt it released, and CHILD_ENV_STRIP is now `[]` — see
  // child-env.mjs's own comment. The base-list membership this test used to exercise no longer
  // exists, so this pins the surviving MECHANISM instead: an explicitly-passed `names` entry is
  // still dropped from the fully-merged env, and GIT_TERMINAL_PROMPT/GCM_INTERACTIVE still survive
  // an UNNAMED strip exactly as before.
  const { childEnv, GIT_ENV_PREFIXES } = await import('./child-env.mjs');
  const merged = {
    PATH: '/x',
    SOME_IN_PROCESS_ONLY_VAR: '1',
    GCM_INTERACTIVE: 'never',
    GIT_TERMINAL_PROMPT: '0',
  };
  const spawned = childEnv(merged, { names: ['SOME_IN_PROCESS_ONLY_VAR'] }); // exactly gitRaw's call shape, with an explicit name
  assert.equal(spawned.GIT_TERMINAL_PROMPT, '0', 'git must stay non-interactive (plan 774)');
  assert.equal(spawned.GCM_INTERACTIVE, 'never', 'GCM must stay suppressed (plan 774)');
  assert.equal(
    spawned.SOME_IN_PROCESS_ONLY_VAR,
    undefined,
    'an explicitly-named in-process-only var must not reach the child',
  );
  // An unnamed strip (CHILD_ENV_STRIP is now empty) leaves it untouched — the strip is opt-in now.
  assert.equal(childEnv(merged).SOME_IN_PROCESS_ONLY_VAR, '1');
  // And the opt-in prefix form DOES take GIT_* — which is why gitRaw must not pass it.
  assert.equal(childEnv(merged, { prefixes: GIT_ENV_PREFIXES }).GIT_TERMINAL_PROMPT, undefined);
});

// --- plan 2891 T2: a mutate() that RETURNS a path list narrows what gets staged -------------
// The declared `relPaths` is fixed before the freshen, so it cannot know about a path that
// appeared or vanished inside the retry window. The marker re-pin's `applyTo` already knew
// exactly which paths it wrote — it just had nowhere to say so, and `git commit -- <vanished>`
// fatals on a declared path that is no longer there.
test('coordWrite: a mutate returning paths stages THOSE, so a declared-but-absent path cannot fatal the write', () => {
  const { dir, origin, cleanup } = makeBareOrigin();
  try {
    coordWrite(dir, {
      // `gone.txt` is declared but never created — the pre-2891 `git add`/`git commit` over the
      // declared list would die on it ("did not match any files").
      relPaths: ['kept.txt', 'gone.txt'],
      mutate: () => {
        writeFileSync(join(dir, 'kept.txt'), 'kept\n');
        return ['kept.txt'];
      },
      message: 'test: narrowed write',
      tool: 'unit',
    });
    const show = execFileSync('git', ['-C', dir, 'show', '--stat', '--format=', 'HEAD'], {
      encoding: 'utf8',
    });
    assert.match(show, /kept\.txt/);
    assert.doesNotMatch(show, /gone\.txt/);
    assert.ok(
      execFileSync('git', ['-C', dir, 'ls-remote', origin, 'refs/heads/master'], {
        encoding: 'utf8',
      }).trim().length > 0,
    );
  } finally {
    cleanup();
  }
});

test('coordWrite: a mutate returning nothing keeps the DECLARED relPaths verbatim (unchanged behaviour)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    coordWrite(dir, {
      relPaths: ['a.txt', 'b.txt'],
      mutate: () => {
        writeFileSync(join(dir, 'a.txt'), 'a\n');
        writeFileSync(join(dir, 'b.txt'), 'b\n');
        // returns undefined — every caller but the marker re-pin
      },
      message: 'test: declared write',
      tool: 'unit',
    });
    const show = execFileSync('git', ['-C', dir, 'show', '--stat', '--format=', 'HEAD'], {
      encoding: 'utf8',
    });
    assert.match(show, /a\.txt/);
    assert.match(show, /b\.txt/);
  } finally {
    cleanup();
  }
});

// plan 2891 review round 1 (CONFIRMED): an EMPTY returned array means "this attempt wrote
// nothing" and must NOT fall back to the declared list — doing so staged and committed whatever
// dirt those declared paths happened to carry, under a message describing a write that never
// happened.
test('coordWrite: a mutate returning [] is a clean no-op — declared paths carrying dirt are NOT committed', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    // `dirty.txt` is a tracked file with an uncommitted edit, and it is one of our declared
    // paths (so the foreign-dirt pre-check passes it).
    writeFileSync(join(dir, 'dirty.txt'), 'committed\n');
    execFileSync('git', ['-C', dir, 'add', 'dirty.txt'], { encoding: 'utf8' });
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'seed dirty.txt'], { encoding: 'utf8' });
    execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'master'], { encoding: 'utf8' });
    const headBefore = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(dir, 'dirty.txt'), 'UNCOMMITTED EDIT\n');

    const res = coordWrite(dir, {
      relPaths: ['dirty.txt'],
      mutate: () => [], // wrote nothing this attempt
      message: 'test: should never be committed',
      tool: 'unit',
    });
    assert.equal(res.noop, true);
    assert.equal(
      execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      headBefore,
      'no commit was made',
    );
    assert.match(
      readFileSync(join(dir, 'dirty.txt'), 'utf8'),
      /UNCOMMITTED EDIT/,
      "and the caller's unrelated edit is still theirs, uncommitted",
    );
  } finally {
    cleanup();
  }
});

// ── plan 2948: the reboot-qualified rebase-owner token ───────────────────────────────────
// The OS probe itself is plan 2738's `processStartToken` (covered by worktree-lock's own
// suite) — what is tested here is the LAYER this plan adds on top: the reboot qualifier, the
// zombie refusal, and the fail-to-null direction. Every case pins the PLATFORM as a parameter
// AND supplies that platform's SYMBOLS (the `/proc` state reader, the start-time probe), per
// the repo's platform-injection rule: faking only the platform NAME would leave each case
// passing solely on the host that already had the real symbol, landing green on Linux and then
// blocking an unrelated session's Windows push.
const BOOT_ID = '848d0115-53a5-4db0-b90c-dc3926180a32';
// `procStatFields` returns the fields AFTER pid+comm, so [0] = state and /proc field 22
// (starttime) is index 19 — the same indexing worktree-lock's probe uses.
const procFields = ({ state = 'R', ticks = '66583' } = {}) =>
  [state, '1', '1'].concat(Array(16).fill('0'), [ticks]);
const linuxDeps = ({ state = 'R', ticks = '66583', bootId = BOOT_ID } = {}) => ({
  platform: 'linux',
  _procStatFields: () => procFields({ state, ticks }),
  _startToken: () => assert.fail('the linux path must not use the ps-fallback probe'),
  _readFile: (p) => {
    if (p !== '/proc/sys/kernel/random/boot_id') throw new Error(`ENOENT: ${p}`);
    if (bootId === null) throw new Error('ENOENT');
    return `${bootId}\n`;
  },
});

test('rebaseOwnerToken: linux binds the start time to the boot id', () => {
  assert.equal(rebaseOwnerToken(4242, linuxDeps()), `linux:${BOOT_ID}:66583`);
  // The qualifier is the point: field 22 is ticks-SINCE-BOOT, so the SAME tick count from a
  // different boot must never compare equal — that collision would spare dead residue.
  assert.notEqual(
    rebaseOwnerToken(4242, linuxDeps({ bootId: 'other-boot' })),
    rebaseOwnerToken(4242, linuxDeps()),
  );
});

test('rebaseOwnerToken: an unreadable boot id is null, NOT an unqualified token', () => {
  // The fail direction that matters. Emitting a bare tick count here would reopen the
  // across-reboot collision above; null routes the caller to the clock fallback instead, which
  // is bounded rather than wrong.
  assert.equal(rebaseOwnerToken(4242, linuxDeps({ bootId: null })), null);
  assert.equal(rebaseOwnerToken(4242, linuxDeps({ bootId: '' })), null);
  // Same rule for a starttime that is not the /proc shape we can byte-compare: refuse, so a
  // `ps`-style low-resolution string can never be dressed up as a reboot-qualified token.
  assert.equal(rebaseOwnerToken(4242, linuxDeps({ ticks: 'Thu Aug  7 21:00:00 2026' })), null);
  assert.equal(rebaseOwnerToken(4242, linuxDeps({ ticks: '' })), null);
});

test('rebaseOwnerToken: a ZOMBIE is not a live owner', () => {
  // A zombie keeps its pid AND its start time until it is reaped, so identity alone reads it
  // as live forever — and `kill(pid, 0)` succeeds on one too, so the state field is the only
  // thing that can tell them apart.
  assert.equal(rebaseOwnerToken(4242, linuxDeps({ state: 'Z' })), null);
  for (const state of ['R', 'S', 'D', 'T'])
    assert.ok(rebaseOwnerToken(4242, linuxDeps({ state })), `${state} is a live state`);
});

test('rebaseOwnerToken: an unprovable start time is null on both platforms', () => {
  assert.equal(rebaseOwnerToken(4242, { ...linuxDeps(), _procStatFields: () => null }), null);
  assert.equal(
    rebaseOwnerToken(4242, {
      platform: 'win32',
      _startToken: () => null,
      _procStatFields: () => assert.fail('win32 must not read /proc'),
      _readFile: () => assert.fail('win32 needs no boot id'),
    }),
    null,
  );
});

test('rebaseOwnerToken: win32 needs no boot qualifier — a FILETIME is absolute', () => {
  const win32 = {
    platform: 'win32',
    _startToken: () => '133694000000000000',
    _procStatFields: () => assert.fail('win32 must not read /proc'),
    _readFile: () => assert.fail('win32 must not read a boot id'),
  };
  assert.equal(rebaseOwnerToken(4242, win32), 'win32:133694000000000000');
});

test('rebaseOwnerToken: unsupported platforms and bad pids probe nothing', () => {
  // darwin's `ps -o lstart=` resolves only to the second, so a same-second recycle would read
  // as SAME — a false spare. Refusing costs nothing on this repo's two real hosts.
  const boom = {
    _startToken: () => assert.fail('no probe on an unsupported platform'),
    _procStatFields: () => assert.fail('no /proc read on an unsupported platform'),
    _readFile: () => assert.fail('no boot-id read on an unsupported platform'),
  };
  for (const platform of ['darwin', 'aix', 'freebsd'])
    assert.equal(rebaseOwnerToken(4242, { platform, ...boom }), null);
  for (const pid of [0, -1, 1.5, undefined, null, '4242'])
    assert.equal(rebaseOwnerToken(pid, { platform: 'linux', ...boom }), null);
});

test('selfRebaseOwnerToken: memoised — the writer pays for the probe at most once', () => {
  // pushMasterWithRebase stamps this inside its retry loop, where a fresh subprocess per
  // attempt would be pure waste on win32.
  let calls = 0;
  const tok = () => {
    calls++;
    return 'linux:boot-a:66583';
  };
  const first = selfRebaseOwnerToken({ _token: tok });
  const second = selfRebaseOwnerToken({ _token: tok });
  assert.equal(first, second);
  assert.equal(calls <= 1, true, 'the probe runs at most once per process');
});

test('rebaseOwnerToken: the real host agrees with itself and refuses a dead pid', () => {
  // platform-assert-ok: the ONE deliberately UNFAKED case — it is what proves the injected
  // fixtures above describe the real OS. It pins no platform BY DESIGN (that is the point) and
  // asserts nothing platform-specific: on a host with no probe the token is null and the body
  // returns before asserting anything at all, so it cannot land green here and fail on Windows.
  const mine = rebaseOwnerToken(process.pid);
  if (mine === null) return;
  assert.equal(mine, rebaseOwnerToken(process.pid), 'the token is stable across reads');
  assert.equal(rebaseOwnerToken(2147483647), null, 'a pid that cannot exist has no token');
});

test('rebaseOwnerToken: state and starttime come from ONE /proc read', () => {
  // Two probes are two reads of a moving target — a process can exit and be reaped between
  // them, producing a token that describes two different moments. One snapshot, one answer.
  let reads = 0;
  const tok = rebaseOwnerToken(4242, {
    platform: 'linux',
    _procStatFields: () => {
      reads++;
      return procFields();
    },
    _startToken: () => assert.fail('the ps-fallback probe must never run on the linux path'),
    _readFile: () => `${BOOT_ID}\n`,
  });
  assert.equal(tok, `linux:${BOOT_ID}:66583`);
  assert.equal(reads, 1);
});

// ── plan 3619: the status heartbeat suspends the dead-seed clock ──
//
// The 6h clock used to rest on the premise "every drain routine pushes after every commit", so an
// empty marker after six hours had to belong to a session that never reached its first commit. A
// gate-REJECTED drain falsifies that: it holds real commits and produces the exact origin state of
// zero. Since calling a dead seed FREES the plan for a second drain to redo the work, these tests
// pin both directions — a fresh heartbeat suspends the clock, and a stale one cannot pin a plan out
// of selection forever.

test('deadSeedVerdict (plan 3619): a FRESH status heartbeat suspends the clock on an old empty marker', () => {
  const gitCalls = [];
  const verdict = deadSeedVerdict('/repo', 'tip', {
    nowMs: DEAD_SEED_NOW_MS,
    statusHeartbeatMs: DEAD_SEED_NOW_MS - 60_000,
    // Without the heartbeat this marker is unambiguously DEAD (24h old, no commits of its own).
    _git: (_dir, args) => {
      gitCalls.push(args[0]);
      return args[0] === 'log' ? `${deadSeedCt(24 * 60 * 60 * 1000)}\n` : '';
    },
  });
  assert.deepEqual(verdict, { dead: false, ageMs: 60_000, reason: 'status-heartbeat' });
  assert.deepEqual(gitCalls, [], 'the heartbeat short-circuits BEFORE any git work');
});

test('deadSeedVerdict (plan 3619): a STALE heartbeat is not a veto — the ordinary age test resumes', () => {
  // Deliberate: an abandoned status branch left behind by a dead sandbox must not pin its plan out
  // of selection forever. Once the heartbeat ages past the same threshold, it stops counting.
  const ageMs = DEAD_SEED_MIN_AGE_MS + 1000;
  const verdict = deadSeedVerdict('/repo', 'tip', {
    nowMs: DEAD_SEED_NOW_MS,
    statusHeartbeatMs: DEAD_SEED_NOW_MS - DEAD_SEED_MIN_AGE_MS,
    _git: (_dir, args) => (args[0] === 'log' ? `${deadSeedCt(ageMs)}\n` : ''),
  });
  assert.deepEqual(verdict, { dead: true, ageMs, reason: 'dead' });
});

test('deadSeedVerdict (plan 3619): a heartbeat exactly at the threshold is stale, one ms under is fresh', () => {
  const atThreshold = deadSeedVerdict('/repo', 'tip', {
    nowMs: DEAD_SEED_NOW_MS,
    statusHeartbeatMs: DEAD_SEED_NOW_MS - DEAD_SEED_MIN_AGE_MS,
    _git: (_dir, args) => (args[0] === 'log' ? `${deadSeedCt(1000)}\n` : ''),
  });
  assert.equal(
    atThreshold.reason,
    'fresh',
    'at the threshold the heartbeat no longer short-circuits',
  );
  const underThreshold = deadSeedVerdict('/repo', 'tip', {
    nowMs: DEAD_SEED_NOW_MS,
    statusHeartbeatMs: DEAD_SEED_NOW_MS - (DEAD_SEED_MIN_AGE_MS - 1),
    _git: (_dir, args) => (args[0] === 'log' ? `${deadSeedCt(1000)}\n` : ''),
  });
  assert.equal(underThreshold.reason, 'status-heartbeat');
});

for (const [label, statusHeartbeatMs] of [
  ['absent', null],
  ['undefined', undefined],
  ['NaN', Number.NaN],
  ['a non-numeric string', 'yesterday'],
  ['in the FUTURE (a skewed clock)', DEAD_SEED_NOW_MS + 60_000],
]) {
  test(`deadSeedVerdict (plan 3619): a ${label} heartbeat degrades to the pre-3619 behaviour`, () => {
    // Every unusable heartbeat shape must land on the ordinary age test, not on a suspended clock —
    // a status channel that cannot be read is exactly the case where the old logic must still hold.
    const ageMs = DEAD_SEED_MIN_AGE_MS + 1000;
    const verdict = deadSeedVerdict('/repo', 'tip', {
      nowMs: DEAD_SEED_NOW_MS,
      statusHeartbeatMs,
      _git: (_dir, args) => (args[0] === 'log' ? `${deadSeedCt(ageMs)}\n` : ''),
    });
    assert.deepEqual(verdict, { dead: true, ageMs, reason: 'dead' });
  });
}

// ── plan 3802: the coord checkout is a sparse cone ──────────────────────────────────────────
// The measured defect: `.claude/coord-worktree` materialised every tracked file (~119,700 in
// vetapp, of which backend/ + frontend/ are ~107,700), so resolveCoordCheckout's reset --hard +
// clean -fd and coordWrite's status/merge/add/commit all walked an app tree no coordination write
// ever reads -- inside the lock. These pin the cone's shape, its idempotency marker, and the
// runtime guard that keeps a future coord target from silently falling outside it.

// A repo shaped like vetapp: an origin, a main clone, and two "giant" app trees that the cone
// must exclude alongside the coordination trees it must keep.
function makeConeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'coord-cone-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const main = join(root, 'main');
  const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'master', origin], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'master', seed], { encoding: 'utf8' });
  g(seed, 'config', 'user.email', 't@t.t');
  g(seed, 'config', 'user.name', 'T');
  const put = (rel, body) => {
    mkdirSync(dirname(join(seed, rel)), { recursive: true });
    writeFileSync(join(seed, rel), body);
  };
  put('package.json', '{"name":"cone"}\n');
  // plan 4071 T2: resolveCoordCheckout/coordWrite/cutWorktree now resolve their exclude lists from
  // <root>/coord.config.json (empty core default) rather than a coord-git.mjs module constant, so
  // this synthetic repo needs its own copy — the SAME lists this test file loaded from the real
  // vetapp root — for the cone to apply here exactly as it did when the lists were literals. A
  // root-level file, so cone mode always materialises it (see topLevelSegment's comment above).
  put(
    'coord.config.json',
    `${JSON.stringify(
      {
        coordCheckoutExcludedTopLevel: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL,
        planWorktreeExcludedPaths: PLAN_WORKTREE_EXCLUDED_PATHS,
      },
      null,
      2,
    )}\n`,
  );
  put('docs/INDEX.md', '# index\n');
  put('docs/handoff/board.md', '# board\n');
  put('wiki/index.md', '# wiki\n');
  put('output/reports/r.md', '# report\n');
  for (let i = 0; i < 40; i++) put(`backend/data/f${i}.json`, `{"i":${i}}\n`);
  for (let i = 0; i < 10; i++) put(`frontend/src/c${i}.tsx`, `// ${i}\n`);
  g(seed, 'add', '-A');
  g(seed, 'commit', '-qm', 'seed');
  g(seed, 'remote', 'add', 'origin', origin);
  g(seed, 'push', '-q', 'origin', 'master');
  execFileSync('git', ['clone', '-q', origin, main], { encoding: 'utf8' });
  g(main, 'config', 'user.email', 't@t.t');
  g(main, 'config', 'user.name', 'T');
  g(main, 'config', 'extensions.worktreeConfig', 'true');
  mkdirSync(join(main, '.claude'), { recursive: true });
  return { root, main, g, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('topLevelSegment: first path segment, separator- and prefix-tolerant', () => {
  assert.equal(topLevelSegment('docs/handoff/board.md'), 'docs');
  assert.equal(topLevelSegment('backend\\data\\rec-001.json'), 'backend');
  assert.equal(topLevelSegment('./wiki/index.md'), 'wiki');
  assert.equal(topLevelSegment('/output/reports/r.md'), 'output');
  // A bare root-level file is its own segment -- cone mode always materialises those.
  assert.equal(topLevelSegment('package.json'), 'package.json');
});

test('assertCoordPathInCone: admits coordination trees, refuses the excluded app trees', () => {
  for (const ok of ['docs/INDEX.md', 'wiki/index.md', 'output/reports/r.md', 'package.json'])
    assert.doesNotThrow(() =>
      assertCoordPathInCone(ok, { excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL }),
    );
  for (const bad of ['backend/data/seed/rec-001.json', 'frontend/src/app/page.tsx'])
    assert.throws(
      () =>
        assertCoordPathInCone(bad, {
          tool: 'edit-plan',
          excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL,
        }),
      /sparse cone/,
    );
});

test('assertCoordPathInCone: the refusal names the tool and the config key to widen', () => {
  // The message is the whole value of this guard -- without it the failure surfaces as an opaque
  // `git add` pathspec error from inside coordWrite's retry loop.
  assert.throws(
    () =>
      assertCoordPathInCone('backend/x.json', {
        tool: 'board',
        excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL,
      }),
    (e) => {
      assert.match(e.message, /coordWrite\(board\)/);
      // plan 4071 T2: the literal COORD_CHECKOUT_EXCLUDED_TOP_LEVEL constant is gone -- the
      // refusal now names the coord.config.json key that replaced it.
      assert.match(e.message, /coord\.config\.json's coordCheckoutExcludedTopLevel/);
      return true;
    },
  );
});

// plan 4071 T2: the cone is no longer widened at runtime by mutating a frozen module constant
// (there is none any more) -- it is widened by editing coord.config.json, a deliberate on-disk
// change, never an in-process one. What this test actually needs to guard now is that
// loadCoordConfig hands back an INDEPENDENT array each call, so a caller mutating the list it
// received (accidentally or otherwise) cannot leak into a later resolveCoordCheckout/coordWrite
// call in the same process.
test('loadCoordConfig: coordCheckoutExcludedTopLevel is a fresh array each call (mutating one load cannot widen another)', () => {
  // Portable by construction (plan 3958): asserts the FRESHNESS property (a mutation to one
  // load's array must not leak into the next), never the array's specific content — so this
  // holds regardless of whether the repo under test carries a coordCheckoutExcludedTopLevel row
  // at all (the kit's own root has none; vetapp's carries ['backend', 'frontend']).
  const root = repoRootFrom(import.meta.dirname);
  const first = loadCoordConfig(root).coordCheckoutExcludedTopLevel;
  const originalLength = first.length;
  first.push('frontend-widened-by-mistake');
  const second = loadCoordConfig(root).coordCheckoutExcludedTopLevel;
  assert.equal(second.length, originalLength);
  assert.ok(!second.includes('frontend-widened-by-mistake'));
});

test('resolveCoordCheckout: materialises the coordination trees and not the app trees', () => {
  const repo = makeConeRepo();
  try {
    const cdir = resolveCoordCheckout(repo.main, {});
    assert.equal(cdir, coordCheckoutPath(repo.main));
    for (const kept of [
      'docs/handoff/board.md',
      'wiki/index.md',
      'output/reports/r.md',
      'package.json',
    ])
      assert.ok(existsSync(join(cdir, kept)), `expected ${kept} to be materialised`);
    for (const dropped of ['backend/data/f0.json', 'frontend/src/c0.tsx'])
      assert.ok(!existsSync(join(cdir, dropped)), `expected ${dropped} NOT to be materialised`);
    assert.match(repo.g(cdir, 'config', '--get', 'core.sparseCheckout'), /true/i);
    // The COMMIT is untouched -- only which blobs reach disk changes. A cone that dropped files
    // from the tree would be a data-loss bug, not a speedup.
    assert.match(repo.g(cdir, 'ls-tree', '-r', '--name-only', 'HEAD'), /backend\/data\/f0\.json/);
    assert.equal(repo.g(cdir, 'status', '--porcelain').trim(), '');
  } finally {
    repo.cleanup();
  }
});

test('ensureCoordSparseCheckout: the marker makes the steady-state call a no-op, and a dropped marker re-applies', () => {
  const repo = makeConeRepo();
  try {
    const cdir = resolveCoordCheckout(repo.main, {});
    // resolveCoordCheckout already applied it, so a second call must not redo the work.
    assert.equal(
      ensureCoordSparseCheckout(cdir, { excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL }),
      false,
    );
    const admin = repo.g(cdir, 'rev-parse', '--absolute-git-dir').trim();
    const marker = join(admin, COORD_SPARSE_MARKER);
    assert.ok(existsSync(marker));
    // The recreate path (rmSync + worktree add) drops the admin dir with the worktree; simulate
    // just the marker loss and prove the cone is re-applied rather than silently skipped.
    rmSync(marker);
    assert.equal(
      ensureCoordSparseCheckout(cdir, { excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL }),
      true,
    );
    assert.ok(existsSync(marker));
  } finally {
    repo.cleanup();
  }
});

test('ensureCoordSparseCheckout: a git failure leaves the checkout dense rather than breaking the write', () => {
  // Best-effort by contract: a coordination write must never fail because the speedup could not be
  // applied. Dense is slow, not wrong.
  const repo = makeConeRepo();
  try {
    const cdir = resolveCoordCheckout(repo.main, {});
    const admin = repo.g(cdir, 'rev-parse', '--absolute-git-dir').trim();
    rmSync(join(admin, COORD_SPARSE_MARKER));
    const boom = (_dir, args) => {
      if (args[0] === 'sparse-checkout') throw new Error('sparse-checkout unsupported');
      return execFileSync('git', ['-C', _dir, ...args], { encoding: 'utf8' });
    };
    assert.equal(
      ensureCoordSparseCheckout(cdir, { excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL, _git: boom }),
      false,
    );
    // and no marker was written, so a later healthy call still gets its chance
    assert.ok(!existsSync(join(admin, COORD_SPARSE_MARKER)));
  } finally {
    repo.cleanup();
  }
});

test('coordWrite through the cone: the edit reaches origin and the excluded trees are untouched', () => {
  const repo = makeConeRepo();
  try {
    const cdir = resolveCoordCheckout(repo.main, {});
    coordWrite(cdir, {
      relPaths: ['docs/handoff/board.md'],
      mutate: () => writeFileSync(join(cdir, 'docs/handoff/board.md'), '# board\nrow-3802\n'),
      message: 'test: coord write under the sparse cone',
      tool: 'cone-test',
    });
    repo.g(repo.main, 'fetch', '-q', 'origin', 'master');
    assert.match(repo.g(repo.main, 'show', 'origin/master:docs/handoff/board.md'), /row-3802/);
    assert.match(repo.g(repo.main, 'show', 'origin/master:backend/data/f0.json'), /"i":0/);
    // A second op reuses the existing (already-sparse) checkout through reset --hard + clean -fd.
    const cdir2 = resolveCoordCheckout(repo.main, {});
    assert.ok(!existsSync(join(cdir2, 'backend/data/f0.json')));
    coordWrite(cdir2, {
      relPaths: ['docs/INDEX.md'],
      mutate: () => writeFileSync(join(cdir2, 'docs/INDEX.md'), '# index\nsecond-op\n'),
      message: 'test: second coord write',
      tool: 'cone-test',
    });
    repo.g(repo.main, 'fetch', '-q', 'origin', 'master');
    assert.match(repo.g(repo.main, 'show', 'origin/master:docs/INDEX.md'), /second-op/);
    // the first write is still there -- the second op did not reset over it
    assert.match(repo.g(repo.main, 'show', 'origin/master:docs/handoff/board.md'), /row-3802/);
  } finally {
    repo.cleanup();
  }
});

test('coordWrite: an out-of-cone relPath is refused before any git work happens', () => {
  const repo = makeConeRepo();
  try {
    const cdir = resolveCoordCheckout(repo.main, {});
    const before = repo.g(cdir, 'rev-parse', 'HEAD').trim();
    assert.throws(
      () =>
        coordWrite(cdir, {
          relPaths: ['backend/data/f1.json'],
          mutate: () => assert.fail('mutate must never run for an out-of-cone path'),
          message: 'should never happen',
          tool: 'cone-test',
        }),
      /sparse cone/,
    );
    assert.equal(repo.g(cdir, 'rev-parse', 'HEAD').trim(), before);
  } finally {
    repo.cleanup();
  }
});

// ── plan 3802 review round 1 (/gpt-review, 24 findings over 7 root causes) ───────────────────
// Each test below pins one of those root causes. They are the reason the cone is recomputed per
// call rather than trusted from a marker, and the reason a failed apply forces the tree dense.

test('assertCoordPathInCone: every REAL coord-write target passes the cone', () => {
  // The guard is only as good as the path inventory behind it. These are the concrete targets a
  // survey of every withCoordCheckout/coordWrite caller turned up -- board/queue/sessions under
  // docs/handoff, plan files, docs/INDEX.md, fb-log's docs/research third subtree, wiki-commit's
  // wiki/, wiki-coverage-sweep's output/reports, and the root coord.config.json three tools read
  // from inside the checkout. A cone built by enumerating "the dirs we remember" drops
  // docs/research (/gpt-review key 99d8c5: the old tests only proved synthetic paths are refused,
  // never that the real ones are admitted).
  for (const real of [
    'docs/handoff/board.md',
    'docs/handoff/landing-queue.md',
    'docs/handoff/sessions/2026-09-08-session-3820.md',
    'docs/handoff/sessions/2026-09-08-session-3820.findings.json',
    'docs/handoff/infra-debt.md',
    'docs/INDEX.md',
    'docs/superpowers/plans/in-progress/3802-FABLE-Coord-coord-write-hold-regression.md',
    'docs/superpowers/batches/some-slug/manifest.json',
    'docs/research/fb-watch-log.md',
    'docs/research/fb-mention-log.md',
    'wiki/index.md',
    'wiki/entities/inspectors/price-inspector.md',
    'output/reports/wiki-coverage-sweep.md',
    'coord.config.json',
  ])
    assert.doesNotThrow(
      () => assertCoordPathInCone(real, { excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL }),
      `real coord target refused: ${real}`,
    );
});

test('topLevelSegment: repeated ./ and leading / cannot smuggle an excluded tree past the guard', () => {
  for (const sneaky of [
    './backend/data/x.json',
    '././backend/data/x.json',
    '/backend/data/x.json',
    '//backend/data/x.json',
    './/./backend/data/x.json',
    '.\\\\backend\\\\data\\\\x.json',
  ]) {
    assert.equal(topLevelSegment(sneaky), 'backend', `not normalised: ${sneaky}`);
    assert.throws(
      () => assertCoordPathInCone(sneaky, { excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL }),
      /sparse cone/,
    );
  }
});

test('ensureCoordSparseCheckout: a NEW top-level directory is picked up, not frozen by the marker', () => {
  // The whole point of keying the cone off an EXCLUDE list is that a new coordination directory is
  // materialised automatically. A marker trusted by existence alone would freeze the first
  // computed list and silently leave the new directory out of the checkout.
  const repo = makeConeRepo();
  try {
    const cdir = resolveCoordCheckout(repo.main, {});
    assert.equal(
      ensureCoordSparseCheckout(cdir, { excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL }),
      false,
      'steady state should be a no-op',
    );
    // a sibling lands a brand-new top-level coordination tree
    mkdirSync(join(repo.root, 'seed', 'newcoord'), { recursive: true });
    writeFileSync(join(repo.root, 'seed', 'newcoord', 'thing.md'), '# new\n');
    repo.g(join(repo.root, 'seed'), 'add', '-A');
    repo.g(join(repo.root, 'seed'), 'commit', '-qm', 'add newcoord');
    repo.g(join(repo.root, 'seed'), 'push', '-q', 'origin', 'master');
    const cdir2 = resolveCoordCheckout(repo.main, {});
    assert.ok(
      existsSync(join(cdir2, 'newcoord/thing.md')),
      'a new top-level dir must be materialised, not frozen out by the marker',
    );
    // and the excluded trees are still excluded
    assert.ok(!existsSync(join(cdir2, 'backend/data/f0.json')));
  } finally {
    repo.cleanup();
  }
});

test('ensureCoordSparseCheckout: a failed `set` leaves the checkout DENSE, never half-narrowed', () => {
  // A `sparse-checkout set --cone` that fails partway through could leave a checkout narrowed to
  // some subset of dirs but not the full want-list -- worse than doing nothing, because
  // coordination writes would then fail on a tree that silently lacks docs/ or wiki/.
  const repo = makeConeRepo();
  try {
    const cdir = resolveCoordCheckout(repo.main, {});
    const admin = repo.g(cdir, 'rev-parse', '--absolute-git-dir').trim();
    rmSync(join(admin, COORD_SPARSE_MARKER));
    const failSet = (d, args, opts) => {
      if (args[0] === 'sparse-checkout' && args[1] === 'set') throw new Error('set exploded');
      return execFileSync('git', ['-C', d, ...args], { encoding: 'utf8', ...(opts || {}) });
    };
    assert.equal(
      ensureCoordSparseCheckout(cdir, {
        excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL,
        _git: failSet,
      }),
      false,
    );
    // dense again: the coordination trees are all back
    for (const kept of ['docs/handoff/board.md', 'wiki/index.md', 'output/reports/r.md'])
      assert.ok(existsSync(join(cdir, kept)), `${kept} must survive a failed apply`);
    assert.ok(existsSync(join(cdir, 'backend/data/f0.json')), 'dense means dense');
    // no marker was left behind, so a later healthy call retries
    assert.ok(!existsSync(join(admin, COORD_SPARSE_MARKER)));
  } finally {
    repo.cleanup();
  }
});

test('ensureCoordSparseCheckout: a dense checkout goes straight to the cone, never through a root-only state', () => {
  // plan 3808: the old `init --cone [--sparse-index]` then `set <dirs>` pair transited a dense
  // checkout through cone-mode-with-no-patterns -- which narrows to root-level files only -- for
  // the window between the two calls. A single `set --cone [--sparse-index] <dirs>` initializes
  // cone mode AND applies the patterns atomically, so that intermediate root-only state can no
  // longer exist. Prove both halves on the recorded argv, never on wall-clock timing: (1) exactly
  // one flavor of sparse-checkout invocation reaches git and it is never `init`, and (2) the argv
  // immediately preceding and following the real `set` call already shows/still shows docs/ present,
  // because a dense checkout carries docs/ from the start and the single `set` call is the only
  // state transition -- there is no separate call that could ever observe root-only.
  const repo = makeConeRepo();
  try {
    const cdir = resolveCoordCheckout(repo.main, {});
    const admin = repo.g(cdir, 'rev-parse', '--absolute-git-dir').trim();
    rmSync(join(admin, COORD_SPARSE_MARKER));
    // Force genuinely DENSE at entry -- the real incident's shape is dense -> cone, not
    // cone -> cone.
    repo.g(cdir, 'sparse-checkout', 'disable');
    assert.ok(
      existsSync(join(cdir, 'backend/data/f0.json')),
      'must be dense (app tree present) before the apply under test',
    );

    const calls = [];
    const docsPresenceAroundSet = [];
    const rec = (d, args, opts) => {
      calls.push(args);
      if (args[0] === 'sparse-checkout' && args[1] === 'set')
        docsPresenceAroundSet.push({ when: 'before', docs: existsSync(join(cdir, 'docs')) });
      const out = execFileSync('git', ['-C', d, ...args], { encoding: 'utf8', ...(opts || {}) });
      if (args[0] === 'sparse-checkout' && args[1] === 'set')
        docsPresenceAroundSet.push({ when: 'after', docs: existsSync(join(cdir, 'docs')) });
      return out;
    };

    assert.equal(
      ensureCoordSparseCheckout(cdir, { excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL, _git: rec }),
      true,
    );

    const sparseCalls = calls.filter((a) => a[0] === 'sparse-checkout');
    assert.ok(sparseCalls.length > 0, 'expected at least one sparse-checkout call');
    assert.equal(
      sparseCalls.filter((a) => a[1] === 'init').length,
      0,
      'no sparse-checkout call may be `init` -- the cone is applied by `set` alone',
    );
    // --sparse-index support is host-dependent: a supporting git applies in one `set` call, while
    // a git too old for it fails that call and falls back to a second `set --cone` -- both are
    // legitimate, single-flavor (`set`-only) applies, so assert on the SHAPE, not a hard count.
    assert.ok(
      sparseCalls.every((a) => a[1] === 'set'),
      'every sparse-checkout call must be `set` (init is never a separate step)',
    );

    // docs/ was already present going into the (only) `set` call, since the checkout was dense at
    // entry, and remains present after it -- there is no call boundary where it was ever absent.
    assert.ok(docsPresenceAroundSet.length > 0, 'expected the `set` call to be observed');
    for (const { when, docs } of docsPresenceAroundSet)
      assert.ok(docs, `docs/ must be present ${when} the sparse-checkout set call`);

    // and the end state is the cone: coordination trees materialised, app trees are not.
    for (const kept of ['docs/handoff/board.md', 'wiki/index.md', 'output/reports/r.md'])
      assert.ok(existsSync(join(cdir, kept)), `expected ${kept} to be materialised`);
    for (const dropped of ['backend/data/f0.json', 'frontend/src/c0.tsx'])
      assert.ok(!existsSync(join(cdir, dropped)), `expected ${dropped} NOT to be materialised`);
  } finally {
    repo.cleanup();
  }
});

test('forceCoordDense: a lock-contended `disable` is retried, not swallowed into a narrowed checkout', () => {
  // /gpt-review key 606a54. forceCoordDense runs inside the coord-write lock immediately after two
  // `set` attempts failed, so index-lock contention is the likeliest reason all three would fail
  // together -- and a bare `_git` swallowed that transient error, leaving the checkout narrowed,
  // which is exactly the state this function exists to prevent. Routing the disable through
  // gitWithLockRetry makes the fallback survive contention while keeping the swallow-on-real-
  // failure contract (a non-lock error is rethrown by the helper and caught here as before).
  const repo = makeConeRepo();
  try {
    const cdir = resolveCoordCheckout(repo.main, {});
    const admin = repo.g(cdir, 'rev-parse', '--absolute-git-dir').trim();
    rmSync(join(admin, COORD_SPARSE_MARKER));
    let disables = 0;
    const contended = (d, args, opts) => {
      // both cone attempts fail, driving execution into the dense fallback
      if (args[0] === 'sparse-checkout' && args[1] === 'set') throw new Error('set exploded');
      if (args[0] === 'sparse-checkout' && args[1] === 'disable' && disables++ === 0)
        throw new Error("fatal: Unable to create '.git/index.lock': File exists.");
      return execFileSync('git', ['-C', d, ...args], { encoding: 'utf8', ...(opts || {}) });
    };
    assert.equal(
      ensureCoordSparseCheckout(cdir, {
        excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL,
        _git: contended,
      }),
      false,
    );
    assert.ok(disables > 1, 'the contended disable must be retried, not swallowed after one try');
    // dense means dense: the coordination trees AND the excluded app trees are all back
    for (const kept of ['docs/handoff/board.md', 'wiki/index.md', 'output/reports/r.md'])
      assert.ok(existsSync(join(cdir, kept)), `${kept} must survive a contended dense fallback`);
    assert.ok(
      existsSync(join(cdir, 'backend/data/f0.json')),
      'a lock-contended disable must still reach DENSE, never leave the checkout narrowed',
    );
    assert.ok(!existsSync(join(admin, COORD_SPARSE_MARKER)));
  } finally {
    repo.cleanup();
  }
});

test('coordWrite: a path returned by mutate() is cone-checked too, not just the declared list', () => {
  // plan 2891 T2 lets mutate() return the authoritative path list, and THAT is what gets staged.
  // Checking only the declared list would let a dynamic path route around the cone entirely.
  const repo = makeConeRepo();
  try {
    const cdir = resolveCoordCheckout(repo.main, {});
    assert.throws(
      () =>
        coordWrite(cdir, {
          relPaths: ['docs/handoff/board.md'], // declared list is innocent
          mutate: () => {
            writeFileSync(join(cdir, 'docs/handoff/board.md'), '# board\nx\n');
            return ['backend/data/f1.json']; // ...the returned one is not
          },
          message: 'should never commit',
          tool: 'cone-test',
        }),
      /sparse cone/,
    );
  } finally {
    repo.cleanup();
  }
});

test('resolveCoordCheckout: the recreate path never materialises the dense tree', () => {
  // The recreate branch runs under the lock. Checking out densely and then narrowing costs a
  // full-tree checkout (~10 minutes on the real repo) for an end state identical to creating the
  // worktree empty and narrowing first.
  const repo = makeConeRepo();
  try {
    const cdir = resolveCoordCheckout(repo.main, {});
    // destroy the checkout so the next call takes the recreate branch
    rmSync(cdir, { recursive: true, force: true });
    const seen = [];
    const spy = (d, args, opts) => {
      seen.push(args.join(' '));
      return execFileSync('git', ['-C', d, ...args], { encoding: 'utf8', ...(opts || {}) });
    };
    const again = resolveCoordCheckout(repo.main, { _git: spy });
    const add = seen.find((c) => c.startsWith('worktree add'));
    assert.ok(add, 'expected the recreate branch to run');
    assert.match(add, /--no-checkout/);
    // and it still ends up correct
    assert.ok(existsSync(join(again, 'docs/handoff/board.md')));
    assert.ok(existsSync(join(again, 'wiki/index.md')));
    assert.ok(!existsSync(join(again, 'backend/data/f0.json')));
    assert.equal(repo.g(again, 'status', '--porcelain').trim(), '');
  } finally {
    repo.cleanup();
  }
});

// ── plan 3956: one cone computation for the coord checkout AND plan worktrees ────────────────

// A tree with the real shape the plan-worktree cone has to handle: the excluded path is TWO levels
// down, with files and sibling directories at every ancestor level.
function makeNestedConeRepo() {
  const repo = makeConeRepo();
  const seed = join(repo.root, 'seed');
  const put = (rel, body) => {
    mkdirSync(dirname(join(seed, rel)), { recursive: true });
    writeFileSync(join(seed, rel), body);
  };
  put('backend/package.json', '{"name":"backend"}\n');
  put('backend/src/index.ts', '// src\n');
  put('backend/data/README.md', '# data\n');
  put('backend/data/other-study/rows.json', '[]\n');
  for (let i = 0; i < 30; i++) put(`backend/data/data-pipeline/render-store/r${i}.json`, `{}\n`);
  put('backend/data/data-pipeline/observations/o.jsonl', '{}\n');
  repo.g(seed, 'add', '-A');
  repo.g(seed, 'commit', '-qm', 'nested');
  repo.g(seed, 'push', '-q', 'origin', 'master');
  repo.g(repo.main, 'fetch', '-q', 'origin');
  repo.g(repo.main, 'merge', '-q', '--ff-only', 'origin/master');
  return repo;
}

test('sparseConeDirs: a top-level exclude list is every top-level directory minus the excluded ones (the plan-3802 cone, unchanged)', () => {
  const repo = makeNestedConeRepo();
  try {
    const dirs = sparseConeDirs(repo.main, { excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL });
    const top = repo
      .g(repo.main, 'ls-tree', '--name-only', '-d', 'origin/master')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    assert.deepEqual(
      dirs,
      top.filter((d) => !COORD_CHECKOUT_EXCLUDED_TOP_LEVEL.includes(d)),
    );
    assert.ok(!dirs.some((d) => d.includes('/')), 'a top-level exclude never descends');
  } finally {
    repo.cleanup();
  }
});

test('sparseConeDirs: a NESTED exclude becomes the sibling set at every ancestor level', () => {
  const repo = makeNestedConeRepo();
  try {
    const dirs = sparseConeDirs(repo.main, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS });
    // Every non-ancestor top-level directory whole ...
    for (const whole of ['docs', 'frontend', 'wiki', 'output']) assert.ok(dirs.includes(whole));
    // ... the ancestors themselves NOT as a whole (that would drag the excluded path in) ...
    assert.ok(!dirs.includes('backend'));
    assert.ok(!dirs.includes('backend/data'));
    assert.ok(!dirs.includes('backend/data/data-pipeline'));
    for (const ex of PLAN_WORKTREE_EXCLUDED_PATHS) assert.ok(!dirs.includes(ex), ex);
    // ... and the siblings at each ancestor level instead.
    assert.ok(dirs.includes('backend/src'));
    assert.ok(dirs.includes('backend/data/other-study'));
    assert.ok(dirs.includes('backend/data/data-pipeline/observations'));
    // A trailing slash or a Windows separator on the exclude spells the same path.
    assert.deepEqual(
      sparseConeDirs(repo.main, {
        excludes: PLAN_WORKTREE_EXCLUDED_PATHS.map((p) => `${p.replace(/\//g, '\\')}/`),
      }),
      dirs,
    );
  } finally {
    repo.cleanup();
  }
});

test('sparseConeDirs: an EMPTY exclude list means DENSE (null), never a cone of every current top-level dir (plan 4071 review round 1, finding 31e460)', () => {
  const repo = makeNestedConeRepo();
  try {
    // Direct unit check: nothing to exclude -> no cone, not "every top-level dir happens to
    // be included".
    assert.equal(sparseConeDirs(repo.main, { excludes: [] }), null);
    // And the caller that actually cuts a worktree must never even ATTEMPT a
    // `sparse-checkout set` when handed an empty list -- a config-less repo's plan worktrees
    // stay fully dense, so a later rebase/merge adding a new top-level directory is never
    // silently left off an already-cut tree.
    const wt = join(repo.main, '.claude', 'worktrees', 'p-empty');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(
      repo.main,
      'worktree',
      'add',
      '--no-checkout',
      '-b',
      'worktree-p-empty',
      wt,
      'origin/master',
    );
    const calls = [];
    const spy = (d, args, opts) => {
      calls.push(args);
      return execFileSync('git', ['-C', d, ...args], { encoding: 'utf8', ...(opts || {}) });
    };
    assert.equal(ensurePlanSparseCheckout(wt, { excludes: [], _git: spy }), false);
    assert.ok(
      !calls.some((a) => a[0] === 'sparse-checkout' && a[1] === 'set'),
      'an empty exclude list must never invoke sparse-checkout set',
    );
    assert.deepEqual(readSparseState(wt), { enabled: false, dirs: [] });
    // The worktree still populates fully -- dense, not stuck --no-checkout.
    repo.g(wt, 'checkout');
    assert.ok(existsSync(join(wt, 'backend/data/data-pipeline/render-store/r0.json')));
  } finally {
    repo.cleanup();
  }
});

test('ensurePlanSparseCheckout: an empty exclude list disables an ALREADY-sparse checkout back to dense (plan 4071 review round 2, keys 26b7de, 504c8b, 51f33d)', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'p-shrink');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(
      repo.main,
      'worktree',
      'add',
      '--no-checkout',
      '-b',
      'worktree-p-shrink',
      wt,
      'origin/master',
    );
    // Cut sparse first, as if the worktree config used to carry an exclusion list.
    assert.equal(ensurePlanSparseCheckout(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }), true);
    repo.g(wt, 'checkout');
    assert.equal(planWorktreeIsSparse(wt), true, 'precondition: the checkout starts sparse');
    // The exclusion list is now empty (e.g. coord.config.json's list was cleared) -- the tree
    // must actively become dense, not stay narrowed because sparseConeDirs returned null.
    assert.equal(ensurePlanSparseCheckout(wt, { excludes: [] }), true);
    assert.deepEqual(readSparseState(wt), { enabled: false, dirs: [] }, 'cone disabled');
    assert.equal(planWorktreeIsSparse(wt), false);
    const admin = repo.g(wt, 'rev-parse', '--absolute-git-dir').trim();
    assert.ok(!existsSync(join(admin, PLAN_SPARSE_MARKER)), 'stale marker removed');
    assert.ok(
      existsSync(join(wt, 'backend/data/data-pipeline/render-store/r0.json')),
      'the previously excluded store is materialised',
    );
    assert.equal(repo.g(wt, 'status', '--porcelain').trim(), '');
  } finally {
    repo.cleanup();
  }
});

test('ensurePlanSparseCheckout: an empty exclude list over an ALREADY-dense checkout makes no sparse-checkout git call at all', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'p-stay-dense');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(
      repo.main,
      'worktree',
      'add',
      '--no-checkout',
      '-b',
      'worktree-p-stay-dense',
      wt,
      'origin/master',
    );
    repo.g(wt, 'checkout');
    assert.equal(planWorktreeIsSparse(wt), false, 'precondition: never sparsified');
    const calls = [];
    const spy = (d, args, opts) => {
      calls.push(args);
      return execFileSync('git', ['-C', d, ...args], { encoding: 'utf8', ...(opts || {}) });
    };
    assert.equal(ensurePlanSparseCheckout(wt, { excludes: [], _git: spy }), false);
    assert.ok(
      !calls.some((a) => a[0] === 'sparse-checkout'),
      'an already-dense checkout takes no sparse-checkout call of any kind',
    );
    assert.equal(repo.g(wt, 'status', '--porcelain').trim(), '');
  } finally {
    repo.cleanup();
  }
});

test('ensurePlanSparseCheckout + widenPlanWorktree: the excluded folder stays off disk, ancestor files land, and widening is one call', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'p1');
    mkdirSync(dirname(wt), { recursive: true });
    // The plan-3802 sequence cut-worktree.mjs uses for a sparse plan cut: create empty, narrow,
    // then populate -- the dense tree is never written and then deleted again.
    repo.g(repo.main, 'worktree', 'add', '--no-checkout', '-b', 'worktree-p1', wt, 'origin/master');
    assert.equal(planWorktreeIsSparse(wt), false, 'no marker before the cone is applied');
    assert.equal(ensurePlanSparseCheckout(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }), true);
    repo.g(wt, 'checkout');
    assert.equal(planWorktreeIsSparse(wt), true);
    for (const kept of [
      'package.json',
      'docs/INDEX.md',
      'frontend/src/c0.tsx',
      'backend/package.json',
      'backend/src/index.ts',
      'backend/data/README.md',
      'backend/data/other-study/rows.json',
      // The excluded folder's PARENT stays: its contract files and small siblings are on disk.
      'backend/data/data-pipeline/observations/o.jsonl',
    ])
      assert.ok(existsSync(join(wt, kept)), `expected ${kept} on disk`);
    assert.ok(
      !existsSync(join(wt, 'backend/data/data-pipeline/render-store')),
      'excluded store must be absent',
    );
    // Still fully in the index and the commit -- only which blobs reach disk changes.
    assert.match(
      repo.g(wt, 'ls-files', '-v', '--', 'backend/data/data-pipeline/render-store'),
      /^S backend\/data\/data-pipeline\/render-store\/r0\.json/m,
    );
    assert.equal(repo.g(wt, 'status', '--porcelain').trim(), '');
    // Steady state is a no-op; the marker carries the exact list and git's own list agrees.
    assert.equal(ensurePlanSparseCheckout(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }), false);
    const admin = repo.g(wt, 'rev-parse', '--absolute-git-dir').trim();
    assert.ok(existsSync(join(admin, PLAN_SPARSE_MARKER)));
    assert.deepEqual(readSparseState(wt), {
      enabled: true,
      dirs: sparseConeDirs(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS, ref: 'HEAD' }),
    });
    // The marker is the POSITIVE identity: without it a sparse tree is "not one of ours" and is
    // left alone by the gates; the next apply re-writes it and it is ours again.
    rmSync(join(admin, PLAN_SPARSE_MARKER));
    assert.equal(planWorktreeIsSparse(wt), false, 'sparse but unmarked = not a plan worktree');
    assert.equal(widenPlanWorktree(wt), false, 'and never widened by a gate');
    assert.equal(
      ensurePlanSparseCheckout(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }),
      true,
      'the missing marker is re-written once',
    );
    assert.ok(existsSync(join(admin, PLAN_SPARSE_MARKER)));
    assert.equal(planWorktreeIsSparse(wt), true);
    // Widen: EVERYTHING materialises (a disable, not an add of the six paths -- a directory a
    // later merge brought in under an excluded ancestor comes in too), the config flips, the
    // worktree reads dense from here on.
    assert.equal(widenPlanWorktree(wt), true);
    assert.ok(existsSync(join(wt, 'backend/data/data-pipeline/render-store/r0.json')));
    assert.ok(existsSync(join(wt, 'backend/data/data-pipeline/observations/o.jsonl')));
    assert.deepEqual(readSparseState(wt), { enabled: false, dirs: [] });
    assert.equal(planWorktreeIsSparse(wt), false);
    assert.ok(!existsSync(join(admin, PLAN_SPARSE_MARKER)));
    assert.equal(widenPlanWorktree(wt), false, 'idempotent: a dense worktree is a no-op');
    assert.equal(repo.g(wt, 'status', '--porcelain').trim(), '');
    assert.equal(
      repo.g(wt, 'ls-files', '-v', '--', 'backend/data/data-pipeline/render-store').match(/^S /gm),
      null,
      'nothing is skip-worktree after a widen',
    );
  } finally {
    repo.cleanup();
  }
});

test('planWorktreeIsSparse recognises a marker from an EARLIER generation -- a PLAN_SPARSE_MARKER bump must not orphan worktrees already cut (plan 4110)', () => {
  // gpt-review keys angle-B / angle-C / claude-data-grounding. The marker is written under the
  // admin dir by NAME, and recognition used to test for exactly the CURRENT name -- so bumping
  // the marker (which a planWorktreeExcludedPaths config change requires) made every worktree
  // already on disk read dense, silently no-op its widen, and run the store-reading gates
  // against a tree with no stores. That breaks OTHER sessions' in-flight worktrees, not the one
  // landing the bump, so it is pinned here rather than left for the next bump to rediscover.
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'p-gen');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(
      repo.main,
      'worktree',
      'add',
      '--no-checkout',
      '-b',
      'worktree-p-gen',
      wt,
      'origin/master',
    );
    assert.equal(ensurePlanSparseCheckout(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }), true);
    repo.g(wt, 'checkout');
    const admin = repo.g(wt, 'rev-parse', '--absolute-git-dir').trim();
    assert.ok(existsSync(join(admin, PLAN_SPARSE_MARKER)));

    // Simulate a worktree cut under the PREVIOUS generation: rename the marker back to v1 and
    // leave git's own sparse config exactly as it is. This is the on-disk state of every
    // worktree cut before a bump lands.
    const older = join(admin, 'plan-sparse-v1');
    renameSync(join(admin, PLAN_SPARSE_MARKER), older);
    assert.notEqual(
      PLAN_SPARSE_MARKER,
      'plan-sparse-v1',
      'precondition: the constant has moved past v1',
    );
    assert.ok(!existsSync(join(admin, PLAN_SPARSE_MARKER)));

    assert.equal(
      planWorktreeIsSparse(wt),
      true,
      'an older-generation marker is still OUR sparse worktree',
    );
    assert.equal(
      widenPlanWorktree(wt),
      true,
      'and a gate can still widen it -- the silent no-op is what the bump used to cause',
    );
    assert.deepEqual(readSparseState(wt), { enabled: false, dirs: [] });
    assert.ok(
      existsSync(join(wt, 'backend/data/data-pipeline/render-store/r0.json')),
      'the heavy store actually materialised',
    );
    assert.ok(!existsSync(older), 'the widen clears whichever generation it found');
    assert.equal(widenPlanWorktree(wt), false, 'still idempotent once dense');
  } finally {
    repo.cleanup();
  }
});

test('ensurePlanSparseCheckout: a marker that cannot be written forces the cut DENSE -- no sparse-but-unmarked state exists', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'p-nomarker');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(
      repo.main,
      'worktree',
      'add',
      '--no-checkout',
      '-b',
      'worktree-p-nomarker',
      wt,
      'origin/master',
    );
    const unwritable = () => {
      throw new Error('EACCES: marker');
    };
    assert.equal(
      ensurePlanSparseCheckout(wt, {
        excludes: PLAN_WORKTREE_EXCLUDED_PATHS,
        _writeFileSync: unwritable,
      }),
      false,
    );
    assert.deepEqual(readSparseState(wt), { enabled: false, dirs: [] }, 'forced dense');
    assert.equal(planWorktreeIsSparse(wt), false);
    repo.g(wt, 'checkout');
    assert.ok(existsSync(join(wt, 'backend/data/data-pipeline/render-store/r0.json')));
    // a later healthy call applies the cone and writes the marker
    assert.equal(ensurePlanSparseCheckout(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }), true);
    assert.equal(planWorktreeIsSparse(wt), true);
  } finally {
    repo.cleanup();
  }
});

test('readSparseState: git boolean spellings count, an inherited global setting does not', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'p-bool');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(
      repo.main,
      'worktree',
      'add',
      '--no-checkout',
      '-b',
      'worktree-p-bool',
      wt,
      'origin/master',
    );
    assert.equal(ensurePlanSparseCheckout(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }), true);
    repo.g(wt, 'checkout');
    repo.g(wt, 'config', '--worktree', 'core.sparseCheckout', 'yes');
    assert.equal(readSparseState(wt).enabled, true, '"yes" is true');
    repo.g(wt, 'config', '--worktree', 'core.sparseCheckout', '1');
    assert.equal(readSparseState(wt).enabled, true, '"1" is true');
    assert.equal(planWorktreeIsSparse(wt), true);
    repo.g(wt, 'config', '--worktree', 'core.sparseCheckout', 'true');
    // A DENSE worktree whose repo-level (shared) config says sparse is still dense: the read is
    // worktree-scoped, so the shared-config layer never masquerades as this worktree's state.
    const dense = join(repo.main, '.claude', 'worktrees', 'p-bool-dense');
    repo.g(repo.main, 'worktree', 'add', '-b', 'worktree-p-bool-dense', dense, 'origin/master');
    assert.equal(readSparseState(dense).enabled, false);
    assert.equal(planWorktreeIsSparse(dense), false);
    assert.equal(widenPlanWorktree(dense), false);
  } finally {
    repo.cleanup();
  }
});

test('widenPlanWorktree / planWorktreeIsSparse: a dense plan worktree (no marker) is left alone', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'dense1');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(repo.main, 'worktree', 'add', '-b', 'worktree-dense1', wt, 'origin/master');
    assert.equal(planWorktreeIsSparse(wt), false);
    assert.equal(widenPlanWorktree(wt), false);
    assert.ok(existsSync(join(wt, 'backend/data/data-pipeline/render-store/r0.json')));
    // The coord checkout is NOT a plan worktree either, whatever its own cone says.
    const cdir = resolveCoordCheckout(repo.main, {});
    assert.equal(planWorktreeIsSparse(cdir), false);
  } finally {
    repo.cleanup();
  }
});

test('ensureCoordSparseCheckout through the shared helper: the coord cone is byte-identical to the top-level rule and re-applies once on the v2 marker', () => {
  const repo = makeNestedConeRepo();
  try {
    const cdir = resolveCoordCheckout(repo.main, {});
    const admin = repo.g(cdir, 'rev-parse', '--absolute-git-dir').trim();
    const want = `${sparseConeDirs(cdir, { excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL }).join('\n')}\n`;
    assert.equal(readFileSync(join(admin, COORD_SPARSE_MARKER), 'utf8'), want);
    assert.equal(
      repo.g(cdir, 'sparse-checkout', 'list').trim().split(/\r?\n/).join('\n'),
      want.trim(),
    );
    // The live incident this bump exists for: a hand `sparse-checkout add backend` over a v1
    // marker. The v2 call sees no v2 marker, re-applies the cone once, and backend/ is gone again.
    writeFileSync(join(admin, 'coord-sparse-v1'), want);
    rmSync(join(admin, COORD_SPARSE_MARKER));
    repo.g(cdir, 'sparse-checkout', 'add', 'backend');
    assert.ok(existsSync(join(cdir, 'backend', 'src', 'index.ts')), 'hand-widened first');
    assert.equal(
      ensureCoordSparseCheckout(cdir, { excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL }),
      true,
    );
    assert.equal(
      ensureCoordSparseCheckout(cdir, { excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL }),
      false,
    );
    assert.ok(!existsSync(join(cdir, 'backend')), 'the v2 re-apply narrows a hand-widened tree');
    // And without any marker bump: the same hand widening over a marker that MATCHES is caught
    // by comparing git's own pattern list, so it is undone on the very next coord op.
    repo.g(cdir, 'sparse-checkout', 'add', 'backend');
    assert.ok(existsSync(join(cdir, 'backend', 'src', 'index.ts')), 'hand-widened again');
    assert.equal(readFileSync(join(admin, COORD_SPARSE_MARKER), 'utf8'), want, 'marker matches');
    assert.equal(
      ensureCoordSparseCheckout(cdir, { excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL }),
      true,
      're-applied on the list mismatch',
    );
    assert.ok(!existsSync(join(cdir, 'backend')), 'narrowed again without a marker bump');
    assert.equal(
      ensureCoordSparseCheckout(cdir, { excludes: COORD_CHECKOUT_EXCLUDED_TOP_LEVEL }),
      false,
      'and steady again',
    );
  } finally {
    repo.cleanup();
  }
});

test('sparseConeDirs: a nested ls-tree that fails yields NO cone (null), never a partial one', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'p-partial');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(
      repo.main,
      'worktree',
      'add',
      '--no-checkout',
      '-b',
      'worktree-p-partial',
      wt,
      'origin/master',
    );
    const flaky = (d, args, opts) => {
      // the root listing works; the descent into backend/ (an excluded path's ancestor) fails
      if (args[0] === 'ls-tree' && args.includes('--') && /^backend\//.test(args[args.length - 1]))
        throw new Error('transient: cannot read tree');
      return execFileSync('git', ['-C', d, ...args], { encoding: 'utf8', ...(opts || {}) });
    };
    assert.equal(
      sparseConeDirs(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS, ref: 'HEAD', _git: flaky }),
      null,
    );
    // ...so the plan cut's helper leaves the worktree dense instead of applying a cone that
    // would lack every backend/ sibling.
    assert.equal(
      ensurePlanSparseCheckout(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS, _git: flaky }),
      false,
    );
    assert.deepEqual(readSparseState(wt), { enabled: false, dirs: [] });
    repo.g(wt, 'checkout');
    assert.ok(existsSync(join(wt, 'backend/src/index.ts')));
    assert.ok(existsSync(join(wt, 'backend/data/data-pipeline/render-store/r0.json')));
  } finally {
    repo.cleanup();
  }
});

// ── plan 4020: narrowPlanWorktree / planNarrowBlockers -- the missing half of widenPlanWorktree ──

test('narrowPlanWorktree: a DENSE worktree that never carried a cone is narrowed -- stores leave disk, ancestor files stay, git status is clean', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'narrow-dense1');
    mkdirSync(dirname(wt), { recursive: true });
    // Plain `worktree add`, no `--no-checkout`, no cone applied -- a genuinely dense worktree,
    // the same shape as the existing "dense plan worktree (no marker)" test above.
    repo.g(repo.main, 'worktree', 'add', '-b', 'worktree-narrow-dense1', wt, 'origin/master');
    assert.equal(planWorktreeIsSparse(wt), false, 'dense: no marker, no cone applied yet');
    assert.ok(existsSync(join(wt, 'backend/data/data-pipeline/render-store/r0.json')));

    const result = narrowPlanWorktree(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS });
    assert.deepEqual(result, {
      narrowed: true,
      excluded: [...PLAN_WORKTREE_EXCLUDED_PATHS],
      untracked: [],
    });
    for (const ex of PLAN_WORKTREE_EXCLUDED_PATHS)
      assert.ok(!existsSync(join(wt, ex)), `expected ${ex} off disk after narrowing`);
    // The excluded folder's PARENT -- its contract files and small siblings -- stays on disk.
    for (const kept of [
      'backend/package.json',
      'backend/src/index.ts',
      'backend/data/README.md',
      'backend/data/other-study/rows.json',
      'backend/data/data-pipeline/observations/o.jsonl',
    ])
      assert.ok(existsSync(join(wt, kept)), `expected ${kept} to stay on disk`);
    assert.equal(planWorktreeIsSparse(wt), true);
    assert.equal(repo.g(wt, 'status', '--porcelain').trim(), '');
  } finally {
    repo.cleanup();
  }
});

test('narrowPlanWorktree: an ALREADY-sparse worktree is a no-op, mirroring widenPlanWorktree', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'narrow-sparse1');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(
      repo.main,
      'worktree',
      'add',
      '--no-checkout',
      '-b',
      'worktree-narrow-sparse1',
      wt,
      'origin/master',
    );
    assert.equal(ensurePlanSparseCheckout(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }), true);
    repo.g(wt, 'checkout');
    assert.equal(planWorktreeIsSparse(wt), true);
    assert.equal(
      narrowPlanWorktree(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }),
      false,
      'already sparse: nothing to do',
    );
  } finally {
    repo.cleanup();
  }
});

test('narrowPlanWorktree: REFUSES on an uncommitted modification under an excluded store, and changes nothing', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'narrow-dirty1');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(repo.main, 'worktree', 'add', '-b', 'worktree-narrow-dirty1', wt, 'origin/master');
    const dirty = join(wt, 'backend/data/data-pipeline/render-store/r0.json');
    writeFileSync(dirty, '{"edited":true}\n');
    assert.throws(
      () => narrowPlanWorktree(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }),
      /REFUSED/,
    );
    // Unrecoverable if we get it wrong, so nothing may have moved: the store is still on disk,
    // the edit is still there, and the worktree still reads dense.
    assert.equal(readFileSync(dirty, 'utf8'), '{"edited":true}\n');
    assert.equal(planWorktreeIsSparse(wt), false);
    assert.match(repo.g(wt, 'status', '--porcelain').trim(), /render-store\/r0\.json/);
  } finally {
    repo.cleanup();
  }
});

test('narrowPlanWorktree: REFUSES on STAGED (not yet committed) content under an excluded store, and changes nothing', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'narrow-staged1');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(repo.main, 'worktree', 'add', '-b', 'worktree-narrow-staged1', wt, 'origin/master');
    const staged = join(wt, 'backend/data/data-pipeline/render-store/r1.json');
    writeFileSync(staged, '{"staged":true}\n');
    repo.g(wt, 'add', 'backend/data/data-pipeline/render-store/r1.json');
    assert.throws(
      () => narrowPlanWorktree(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }),
      /REFUSED/,
    );
    assert.equal(readFileSync(staged, 'utf8'), '{"staged":true}\n');
    assert.equal(planWorktreeIsSparse(wt), false);
    assert.match(repo.g(wt, 'status', '--porcelain').trim(), /render-store\/r1\.json/);
  } finally {
    repo.cleanup();
  }
});

test('narrowPlanWorktree: an in-progress MERGE_HEAD blocks the narrow; removing it lets a retry succeed', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'narrow-merge1');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(repo.main, 'worktree', 'add', '-b', 'worktree-narrow-merge1', wt, 'origin/master');
    const admin = repo.g(wt, 'rev-parse', '--absolute-git-dir').trim();
    writeFileSync(join(admin, 'MERGE_HEAD'), `${repo.g(wt, 'rev-parse', 'HEAD').trim()}\n`);
    assert.throws(
      () => narrowPlanWorktree(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }),
      /REFUSED/,
    );
    assert.equal(planWorktreeIsSparse(wt), false, 'nothing changed while MERGE_HEAD stood');
    assert.ok(existsSync(join(wt, 'backend/data/data-pipeline/render-store/r0.json')));
    rmSync(join(admin, 'MERGE_HEAD'));
    assert.deepEqual(narrowPlanWorktree(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }), {
      narrowed: true,
      excluded: [...PLAN_WORKTREE_EXCLUDED_PATHS],
      untracked: [],
    });
  } finally {
    repo.cleanup();
  }
});

test('narrowPlanWorktree: untracked content under an excluded store does NOT block, and is named in the returned untracked array', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'narrow-untracked1');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(repo.main, 'worktree', 'add', '-b', 'worktree-narrow-untracked1', wt, 'origin/master');
    const scratch = join(wt, 'backend/data/data-pipeline/render-store/scratch.json');
    writeFileSync(scratch, '{"scratch":true}\n');
    const result = narrowPlanWorktree(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS });
    assert.equal(result.narrowed, true);
    assert.deepEqual(result.excluded, [...PLAN_WORKTREE_EXCLUDED_PATHS]);
    assert.deepEqual(result.untracked, ['backend/data/data-pipeline/render-store/scratch.json']);
    assert.equal(planWorktreeIsSparse(wt), true);
    // sparse-checkout does not manage untracked content, so nothing forces it off disk.
    assert.ok(existsSync(scratch), 'the untracked file survives the narrow');
  } finally {
    repo.cleanup();
  }
});

test('narrowPlanWorktree round-trips with widenPlanWorktree: narrow, widen, narrow again all succeed', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'narrow-roundtrip1');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(repo.main, 'worktree', 'add', '-b', 'worktree-narrow-roundtrip1', wt, 'origin/master');
    assert.deepEqual(narrowPlanWorktree(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }), {
      narrowed: true,
      excluded: [...PLAN_WORKTREE_EXCLUDED_PATHS],
      untracked: [],
    });
    assert.equal(planWorktreeIsSparse(wt), true);
    assert.equal(widenPlanWorktree(wt), true);
    assert.equal(planWorktreeIsSparse(wt), false);
    assert.ok(
      existsSync(join(wt, 'backend/data/data-pipeline/render-store/r0.json')),
      'the store is back on disk after widening',
    );
    assert.deepEqual(narrowPlanWorktree(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }), {
      narrowed: true,
      excluded: [...PLAN_WORKTREE_EXCLUDED_PATHS],
      untracked: [],
    });
    assert.equal(planWorktreeIsSparse(wt), true);
    assert.equal(repo.g(wt, 'status', '--porcelain').trim(), '');
  } finally {
    repo.cleanup();
  }
});

// gpt-review cluster cba137/98e984/0ce9f3/a3f9ae/415ad8 (five finders, one root cause): the
// "already sparse" no-op must key on the cone git is ACTUALLY holding, not on the marker alone.
// A `sparse-checkout add` over a marked worktree leaves the marker matching and
// core.sparseCheckout enabled while a store sits back on disk -- and a narrow that answers
// "nothing to do" there is the exact silent-miss this plan exists to eliminate: the caller is
// told the stores are gone while 3.7 GB is still eating the allowance.
test('narrowPlanWorktree: a marked sparse worktree whose cone was widened by hand IS re-narrowed, not reported as a no-op', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'narrow-handcone1');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(repo.main, 'worktree', 'add', '-b', 'worktree-narrow-handcone1', wt, 'origin/master');
    assert.equal(narrowPlanWorktree(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }).narrowed, true);
    assert.ok(!existsSync(join(wt, 'backend/data/data-pipeline/render-store')));
    // Hand-widen ONE store back into the cone. The marker still matches the list it was written
    // for and git still reads sparse, so the marker-only predicate says "already narrowed".
    repo.g(wt, 'sparse-checkout', 'add', 'backend/data/data-pipeline/render-store');
    assert.equal(planWorktreeIsSparse(wt), true, 'still marked + still sparse by config');
    assert.ok(
      existsSync(join(wt, 'backend/data/data-pipeline/render-store/r0.json')),
      'but the store is back on disk — the state the no-op must NOT accept',
    );
    assert.equal(
      narrowPlanWorktree(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }).narrowed,
      true,
      're-narrowed, not a phantom no-op',
    );
    assert.ok(!existsSync(join(wt, 'backend/data/data-pipeline/render-store')));
    assert.equal(repo.g(wt, 'status', '--porcelain').trim(), '');
    // And a genuinely-correct cone is still the no-op the contract promises.
    assert.equal(narrowPlanWorktree(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }), false);
  } finally {
    repo.cleanup();
  }
});

// gpt-review round 2, cluster 75fe1f/556aa0/35e7e6/2cfba2/bb379d (five finders): round 1's fix
// still INFERRED the outcome from git's config ("sparse afterwards ⇒ it was already correct"),
// and ensureSparseCheckout has a failure path that touches neither the config nor the marker --
// a cone computation that yields nothing returns false having changed nothing at all. Over a
// hand-widened marked worktree that reads as "already narrowed" again, with the store still on
// disk. The post-condition must therefore be checked against the DISK, not against config.
test('narrowPlanWorktree: a cone that cannot be computed THROWS — it is never reported as an already-narrowed no-op', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'narrow-conefail1');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(repo.main, 'worktree', 'add', '-b', 'worktree-narrow-conefail1', wt, 'origin/master');
    assert.equal(narrowPlanWorktree(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }).narrowed, true);
    // Hand-widen a store back in: marked, sparse by config, store on disk.
    repo.g(wt, 'sparse-checkout', 'add', 'backend/data/data-pipeline/render-store');
    assert.equal(planWorktreeIsSparse(wt), true);
    assert.ok(existsSync(join(wt, 'backend/data/data-pipeline/render-store/r0.json')));
    // Make the cone uncomputable: sparseConeDirs needs `ls-tree` to enumerate the ancestor's
    // children, and a null cone makes ensureSparseCheckout return false WITHOUT forcing dense
    // and WITHOUT clearing the marker -- the exact shape the inference got wrong.
    const failingGit = (dir, args, opts) => {
      if (args[0] === 'ls-tree') throw new Error('simulated ls-tree failure');
      return git(dir, args, opts);
    };
    assert.throws(
      () => narrowPlanWorktree(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS, _git: failingGit }),
      /cone is NOT in place|could not be computed/i,
      'a failed apply must be loud, never a phantom no-op',
    );
    // And the store really is still there — the throw is telling the truth.
    assert.ok(existsSync(join(wt, 'backend/data/data-pipeline/render-store/r0.json')));
  } finally {
    repo.cleanup();
  }
});

// gpt-review round 2, cluster 2197b9/f50ea4/10a5ed/3b1e2d/d4dcb1: the main-checkout refusal
// compared paths with a bare resolve(), so any alias for the same directory -- a symlink is the
// portable example -- walked straight past a guard whose whole job is to keep a destructive
// operation off a checkout every session shares.
test('narrowPlanWorktree: the MAIN-checkout refusal survives an aliased (symlinked) path', (t) => {
  const repo = makeNestedConeRepo();
  try {
    const alias = join(dirname(repo.main), `alias-${basename(repo.main)}`);
    try {
      symlinkSync(repo.main, alias, 'dir');
    } catch (e) {
      // Creating a directory symlink needs privilege on Windows; the guard itself is not
      // platform-specific, only this way of building an alias for it is. ONLY the "this
      // environment will not let me make a symlink" errnos skip (/gpt-review round-3 keys
      // 0c2386, 1f8d3a) -- a catch-all would turn a genuine regression in the setup into a
      // silent pass, which on a guard against a destructive op is the worst outcome available.
      if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(e.code)) throw e;
      t.skip(`cannot create a directory symlink in this environment (${e.code})`);
      return;
    }
    assert.throws(
      () => narrowPlanWorktree(alias, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }),
      /main checkout/i,
    );
    assert.ok(existsSync(join(repo.main, 'backend/data/data-pipeline/render-store/r0.json')));
  } finally {
    repo.cleanup();
  }
});

// gpt-review 3239fa/e489c2: `--narrow --dir <path>` takes a directory from a caller that has no
// slug, and narrowPlanWorktree deliberately does NOT require the plan marker (it must work on a
// worktree cut dense by class). Those two together mean an unguarded call could narrow the MAIN
// checkout -- which plan 4020 names explicitly as OUT OF SCOPE ("the main checkout is shared by
// every session in that sandbox"). A linked worktree's admin dir differs from the common dir;
// the main checkout's does not, which is the whole discriminator.
test('narrowPlanWorktree: REFUSES the MAIN checkout — narrowing a shared checkout is out of scope', () => {
  const repo = makeNestedConeRepo();
  try {
    assert.throws(
      () => narrowPlanWorktree(repo.main, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }),
      /main checkout/i,
    );
    assert.ok(
      existsSync(join(repo.main, 'backend/data/data-pipeline/render-store/r0.json')),
      'the main checkout is untouched by the refusal',
    );
    assert.equal(readSparseState(repo.main).enabled, false);
  } finally {
    repo.cleanup();
  }
});

// plan 4071 review round 3 (findings f2e5cf/b33832): an EMPTY exclude list means DENSE is the
// wanted end state, not a cone -- sparseConeDirs legitimately returns null for it (see its own
// comment), and the postcondition used to assert `wantDirs` truthy unconditionally, so it threw
// on every attempt with an empty list -- including a genuine no-op on an already-dense worktree,
// which every non-vetapp checkout's core default (`planWorktreeExcludedPaths: []`) hits on every
// `--narrow`.
test('narrowPlanWorktree: an empty exclude list on an ALREADY-SPARSE worktree ends dense and reports success', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'narrow-empty-shrink');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(
      repo.main,
      'worktree',
      'add',
      '--no-checkout',
      '-b',
      'worktree-narrow-empty-shrink',
      wt,
      'origin/master',
    );
    assert.equal(ensurePlanSparseCheckout(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }), true);
    repo.g(wt, 'checkout');
    assert.equal(planWorktreeIsSparse(wt), true, 'precondition: starts sparse');
    assert.deepEqual(narrowPlanWorktree(wt, { excludes: [] }), {
      narrowed: true,
      excluded: [],
      untracked: [],
    });
    assert.equal(planWorktreeIsSparse(wt), false, 'now dense');
    assert.equal(readSparseState(wt).enabled, false);
    assert.ok(
      existsSync(join(wt, 'backend/data/data-pipeline/render-store/r0.json')),
      'the store is materialised back',
    );
    assert.equal(repo.g(wt, 'status', '--porcelain').trim(), '');
  } finally {
    repo.cleanup();
  }
});

test('narrowPlanWorktree: an empty exclude list on an ALREADY-DENSE worktree is a no-op, not a throw', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'narrow-empty-dense');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(repo.main, 'worktree', 'add', '-b', 'worktree-narrow-empty-dense', wt, 'origin/master');
    assert.equal(planWorktreeIsSparse(wt), false, 'precondition: never sparsified');
    const calls = [];
    const spy = (d, args, opts) => {
      calls.push(args);
      return execFileSync('git', ['-C', d, ...args], { encoding: 'utf8', ...(opts || {}) });
    };
    assert.equal(narrowPlanWorktree(wt, { excludes: [], _git: spy }), false);
    assert.ok(
      !calls.some((a) => a[0] === 'sparse-checkout'),
      'an already-dense worktree with nothing to exclude takes no sparse-checkout call at all',
    );
    assert.equal(repo.g(wt, 'status', '--porcelain').trim(), '');
  } finally {
    repo.cleanup();
  }
});

// plan 4071 review round 3 (finding 5dbf97): `excludes` may be a one-shot iterable. A generator
// consumed twice on one call path (once by sparseConeDirs, again by ensureSparseCheckout's own
// empty-list check) would make the SECOND read see an exhausted iterable as empty and wrongly
// force an already-sparse checkout dense, even though the caller's real list was non-empty.
test('ensureSparseCheckout: a generator yielding a NON-EMPTY list applies the cone -- never forced dense', () => {
  const repo = makeNestedConeRepo();
  try {
    const wt = join(repo.main, '.claude', 'worktrees', 'ensure-sparse-generator');
    mkdirSync(dirname(wt), { recursive: true });
    repo.g(
      repo.main,
      'worktree',
      'add',
      '--no-checkout',
      '-b',
      'worktree-ensure-sparse-generator',
      wt,
      'origin/master',
    );
    function* excludesGen() {
      yield* PLAN_WORKTREE_EXCLUDED_PATHS;
    }
    assert.equal(
      ensurePlanSparseCheckout(wt, { excludes: excludesGen() }),
      true,
      'the cone was applied, not discarded as an empty list',
    );
    repo.g(wt, 'checkout');
    assert.equal(planWorktreeIsSparse(wt), true, 'sparse, never forced dense');
    assert.deepEqual(readSparseState(wt), {
      enabled: true,
      dirs: sparseConeDirs(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS, ref: 'HEAD' }),
    });
    for (const ex of PLAN_WORKTREE_EXCLUDED_PATHS)
      assert.ok(!existsSync(join(wt, ex)), `expected ${ex} off disk`);
  } finally {
    repo.cleanup();
  }
});

// ── plan 4087 T5: gitRaw drops the repo-selector vars, and the strip is total ─────────────────

// Behavioural proof of the gitRaw fix: before it, spawnEnv(env, GIT_NONINTERACTIVE_ENV) dropped no
// GIT_* names at all (CHILD_ENV_STRIP is empty), so an ambient GIT_DIR/GIT_WORK_TREE overrode the
// `-C mainDir` argument every coord git spawn passes. A git HOOK subprocess (this very suite is
// wired into pre-push) is exactly where that ambient value comes from -- see the top-of-file
// clear(process.env[...]) a few hundred lines up, which exists for the identical reason.
test('git()/gitRaw: an ambient GIT_DIR/GIT_WORK_TREE cannot redirect the -C target (plan 4087 T5)', () => {
  const repo = makeRepo();
  const foreign = makeRepo();
  try {
    withEnvVar({ GIT_DIR: join(foreign.dir, '.git'), GIT_WORK_TREE: foreign.dir }, () => {
      const gitDir = git(repo.dir, ['rev-parse', '--absolute-git-dir']).trim();
      assert.equal(
        gitDir.replaceAll('\\', '/'),
        join(repo.dir, '.git').replaceAll('\\', '/'),
        'an inherited GIT_DIR must not steer a -C <mainDir> git() call onto a different repo',
      );
    });
  } finally {
    repo.cleanup();
    foreign.cleanup();
  }
});

// The mirror image, and the reason gitRaw must not reach for gitIsolatedEnv()'s blanket GIT_*
// strip: drain-status.mjs's whole "never touches the caller's real index" guarantee depends on
// its own EXPLICIT `env: { GIT_INDEX_FILE: <scratch> }` reaching the child through this exact
// seam. A caller's deliberate opts.env must still win, only the AMBIENT copy must not survive.
test('git()/gitRaw: a caller-supplied repo-selector var in opts.env still reaches the child (plan 4087 T5)', () => {
  const repo = makeRepo();
  const foreign = makeRepo();
  try {
    const gitDir = git(repo.dir, ['rev-parse', '--absolute-git-dir'], {
      env: { GIT_DIR: join(foreign.dir, '.git') },
    }).trim();
    assert.equal(
      gitDir.replaceAll('\\', '/'),
      join(foreign.dir, '.git').replaceAll('\\', '/'),
      "a caller's own explicit env.GIT_DIR (drain-status.mjs's GIT_INDEX_FILE shape) must not be stripped",
    );
  } finally {
    repo.cleanup();
    foreign.cleanup();
  }
});

// plan 4087 T5 review fix (keys gheyjr/1qx8goa/y2bcmu): the actual real-world leak — a caller that
// builds its env by SPREADING process.env, exactly the shape move-plan.mjs / stamp-lib.mjs /
// drain-run.mjs / coord-edit.mjs (coord-edit.mjs:166) all use — re-supplies an ambient GIT_DIR on
// top of gitRepoIsolatedEnv's own base-strip. The two tests above alone did not catch this: the
// first passes NO opts.env at all, the second passes a hand-built object whose GIT_DIR value is
// never equal to the ambient one. This one sets the SAME value ambiently (via withEnvVar) AND
// copies it into opts.env via a process.env spread, so it fails on the pre-fix code (which applied
// gitRepoIsolatedEnv's settings unconditionally on top of its own strip) and passes only once the
// caller's env is filtered through stripInheritedRepoSelectors first.
test('git()/gitRaw: an ambient GIT_DIR copied into opts.env via `{ ...process.env, HUSKY: "0" }` cannot redirect the -C target (plan 4087 T5 review fix)', () => {
  const repo = makeRepo();
  const foreign = makeRepo();
  try {
    withEnvVar({ GIT_DIR: join(foreign.dir, '.git') }, () => {
      const callerEnv = { ...process.env, HUSKY: '0' }; // the real shape most callers of this seam use
      const gitDir = git(repo.dir, ['rev-parse', '--absolute-git-dir'], { env: callerEnv }).trim();
      assert.equal(
        gitDir.replaceAll('\\', '/'),
        join(repo.dir, '.git').replaceAll('\\', '/'),
        'a `{ ...process.env, HUSKY }`-shaped caller env must not carry an ambient GIT_DIR through',
      );
    });
  } finally {
    repo.cleanup();
    foreign.cleanup();
  }
});

// ── plan 4087 round-2 review (finding: env scrub misses lowercase/mixed-case keys on Windows) ──
// `stripInheritedRepoSelectors` is unit-tested directly (not just through git()/gitRaw) so the
// platform branch can be exercised as an injected PARAMETER per this repo's platform-as-parameter
// test rule, rather than depending on which OS actually runs the suite.
test('stripInheritedRepoSelectors: on win32, a differently-cased caller key matching the ambient value is still stripped', () => {
  withEnvVar({ GIT_DIR: 'C:/repo/.git' }, () => {
    const out = stripInheritedRepoSelectors(
      { Git_Dir: 'C:/repo/.git', HUSKY: '0' },
      { platform: 'win32' },
    );
    assert.equal(
      'Git_Dir' in out,
      false,
      'a mixed-case key whose value equals the ambient GIT_DIR must be stripped on win32',
    );
    assert.equal(out.HUSKY, '0', 'an unrelated key must survive untouched');
  });
});

test('stripInheritedRepoSelectors: on win32, a lowercase caller key matching the ambient value is still stripped', () => {
  withEnvVar({ GIT_WORK_TREE: 'C:/repo' }, () => {
    const out = stripInheritedRepoSelectors({ git_work_tree: 'C:/repo' }, { platform: 'win32' });
    assert.equal(
      'git_work_tree' in out,
      false,
      'an all-lowercase key whose value equals the ambient GIT_WORK_TREE must be stripped on win32',
    );
  });
});

test('stripInheritedRepoSelectors: on win32, a differently-cased key with a GENUINELY DIFFERENT value is kept (deliberate override, not an ambient copy)', () => {
  withEnvVar({ GIT_INDEX_FILE: 'C:/repo/.git/index' }, () => {
    const out = stripInheritedRepoSelectors(
      { Git_Index_File: 'C:/scratch/fresh-index' },
      { platform: 'win32' },
    );
    assert.equal(
      out.Git_Index_File,
      'C:/scratch/fresh-index',
      "a caller's deliberately different value must survive even when its key's case differs from the canonical name",
    );
  });
});

test('stripInheritedRepoSelectors: on POSIX (platform !== win32), a differently-cased key is NOT stripped — env names are case-sensitive there', () => {
  withEnvVar({ GIT_DIR: '/repo/.git' }, () => {
    const out = stripInheritedRepoSelectors(
      { Git_Dir: '/repo/.git', GIT_DIR: '/repo/.git' },
      { platform: 'linux' },
    );
    assert.equal(
      out.Git_Dir,
      '/repo/.git',
      'POSIX env names are case-sensitive -- a differently-cased key is a DIFFERENT variable and must survive',
    );
    assert.equal(
      'GIT_DIR' in out,
      false,
      'the exact-case match (the pre-existing POSIX behaviour) must still be stripped',
    );
  });
});

test('stripInheritedRepoSelectors: platform defaults to the real process.platform when omitted', () => {
  const out = stripInheritedRepoSelectors({ NOT_A_SELECTOR: '1' });
  assert.equal(out.NOT_A_SELECTOR, '1', 'an unrelated key is always kept regardless of platform');
});

// ── plan 4087 round-2 review (finding: archive naming duplicated) ────────────────────────────
test('coordOpJournalArchiveRegex: matches exactly what coordOpJournalDailyPath produces, for several dates', () => {
  const journalPath = 'C:/repo/.git/coord-op-journal.jsonl';
  const rx = coordOpJournalArchiveRegex(journalPath);
  for (const iso of ['2026-01-01', '2026-09-22', '2099-12-31']) {
    const dailyPath = coordOpJournalDailyPath(journalPath, {
      now: () => new Date(`${iso}T00:00:00.000Z`),
    });
    const dailyName = dailyPath.split(/[\\/]/).pop();
    assert.ok(
      rx.test(dailyName),
      `regex must match the writer's own output for ${iso}: ${dailyName}`,
    );
  }
  assert.equal(rx.test('coord-op-journal.jsonl'), false, 'the live file itself must not match');
  assert.equal(
    rx.test('coord-op-journal-not-a-date.jsonl'),
    false,
    'a malformed date must not match',
  );
});

// plan 4087 round-3 review (finding 3, key c69e0c): before this fix, a custom `--journal` path
// with no `.jsonl` extension round-tripped WRONG — coordOpJournalDailyPath appended the dated
// suffix with no extension (`${p}-${dated}`), but coordOpJournalArchiveRegex's old hand-rolled
// regex still required a trailing `.jsonl` unconditionally, so the writer's own archive name
// never matched the reader's pattern and a custom journal's archives were invisible to
// listArchiveJournalPaths. Both now derive from the SAME extension split, so they cannot
// disagree.
test('coordOpJournalArchiveRegex / coordOpJournalDailyPath: round-trip for a custom journal path with NO .jsonl extension', () => {
  const journalPath = 'C:/repo/.git/custom-journal';
  const rx = coordOpJournalArchiveRegex(journalPath);
  const dailyPath = coordOpJournalDailyPath(journalPath, {
    now: () => new Date('2026-09-22T00:00:00.000Z'),
  });
  const dailyName = dailyPath.split(/[\\/]/).pop();
  assert.equal(
    dailyName,
    'custom-journal-2026-09-22',
    "the writer's own dated suffix, no extension",
  );
  assert.ok(rx.test(dailyName), "the reader's regex must match what the writer actually produces");
  assert.equal(
    rx.test('custom-journal.jsonl'),
    false,
    'must not require an extension that was never there',
  );
});

// ── plan 4135: the sweep of the remaining unguarded coord-git spawns ───────────────────────────
//
// One ambient-GIT_DIR-override test per baseline GROUP (per the plan's Acceptance), against a
// REAL fixed call site rather than the seam function in isolation -- the same "prove it against
// production code, not a reimplementation" standard the plan-4087 gitRaw tests above set.

// Group (a) -- EXPLICIT -C, ambient can override it. git-safe.mjs is a thin CLI passthrough
// (`node scripts/coord/git-safe.mjs <git args>`, resolving its target via $GIT_SAFE_DIR or cwd)
// spawned as a REAL child process here, not imported -- it has no exported function to call
// directly. Before plan 4135 this spawn carried no `env` at all, so an ambient GIT_DIR (git
// exports this into every hook subprocess) silently overrode the explicit `-C <dir>` git-safe.mjs
// itself passes.
test('git-safe.mjs: an ambient GIT_DIR cannot redirect its explicit -C target (plan 4135, group a)', () => {
  const repo = makeRepo();
  const foreign = makeRepo();
  try {
    const scriptPath = join(import.meta.dirname, 'git-safe.mjs');
    const out = execFileSync(process.execPath, [scriptPath, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_SAFE_DIR: repo.dir, GIT_DIR: join(foreign.dir, '.git') },
    }).trim();
    assert.equal(
      out.replaceAll('\\', '/'),
      join(repo.dir, '.git').replaceAll('\\', '/'),
      'an inherited GIT_DIR must not steer git-safe.mjs off its own $GIT_SAFE_DIR target',
    );
  } finally {
    repo.cleanup();
    foreign.cleanup();
  }
});

// Group (a)'s "deliberate selector still wins" half, on the SEAM directly rather than a second
// fixed call site: none of the 17 files plan 4135 fixed exposes a per-call settings parameter a
// TEST can hand a repo-selector override through (git-safe.mjs's caller is a CLI argv, not a JS
// settings object) -- the plan's own fallback for exactly this case ("a test of that group's site
// plus one on the seam is acceptable"). This exercises the literal `gitRepoIsolatedEnv(extraEnv ||
// {})` shape both cloud-checkout-preflight.mjs's runGit and git-safe.mjs's spawn now use.
test('gitRepoIsolatedEnv(extraEnv || {}): the exact composition shape the plan-4135 fix sites use -- a caller-supplied repo-selector setting still wins over cwd, while the AMBIENT copy is stripped (plan 4135, group a seam)', async () => {
  const { gitRepoIsolatedEnv } = await import('./child-env.mjs');
  const repo = makeRepo();
  const foreign = makeRepo();
  const deliberate = makeRepo();
  try {
    withEnvVar({ GIT_DIR: join(foreign.dir, '.git') }, () => {
      const extraEnv = { GIT_DIR: join(deliberate.dir, '.git') }; // the caller's own explicit choice
      const out = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
        encoding: 'utf8',
        cwd: repo.dir,
        env: gitRepoIsolatedEnv(extraEnv),
      }).trim();
      assert.equal(
        out.replaceAll('\\', '/'),
        join(deliberate.dir, '.git').replaceAll('\\', '/'),
        "the caller's own deliberate extraEnv.GIT_DIR must win over both cwd and the ambient copy",
      );
    });
  } finally {
    repo.cleanup();
    foreign.cleanup();
    deliberate.cleanup();
  }
});

// Group (b) -- NO -C, relies on cwd. board-write-gate.mjs's loadCorpusView(dir, planRels) is the
// plan's own named example: a cwd-scoped `git ls-files` with no `-C`, so before plan 4135 an
// ambient GIT_DIR silently substituted a DIFFERENT repository's tracked-plan corpus for `dir`'s
// own. `repo` and `foreign` each carry a plan at a DIFFERENT id and status, so a steered read is
// externally observable (the wrong id present, the right one missing) rather than merely "some
// git call ran against the wrong cwd".
test("board-write-gate.loadCorpusView: an ambient GIT_DIR cannot redirect the cwd-based 'git ls-files' read (plan 4135, group b)", async () => {
  const { loadCorpusView } = await import('./board-write-gate.mjs');
  const repo = makeRepo();
  const foreign = makeRepo();
  try {
    mkdirSync(join(repo.dir, 'docs/superpowers/plans/ready'), { recursive: true });
    writeFileSync(join(repo.dir, 'docs/superpowers/plans/ready/9001-Test-repo.md'), 'x\n');
    repo.g('add', '.');
    repo.g('commit', '-qm', 'repo plan');

    mkdirSync(join(foreign.dir, 'docs/superpowers/plans/in-progress'), { recursive: true });
    writeFileSync(
      join(foreign.dir, 'docs/superpowers/plans/in-progress/9002-Test-foreign.md'),
      'x\n',
    );
    foreign.g('add', '.');
    foreign.g('commit', '-qm', 'foreign plan');

    withEnvVar({ GIT_DIR: join(foreign.dir, '.git') }, () => {
      const view = loadCorpusView(repo.dir, []);
      assert.equal(
        view.statusOf('9001'),
        'ready',
        "loadCorpusView must read repo's OWN tracked plan corpus, not the ambient GIT_DIR's",
      );
      assert.equal(
        view.statusOf('9002'),
        null,
        "the foreign repo's plan must not leak in through an ambient GIT_DIR",
      );
    });
  } finally {
    repo.cleanup();
    foreign.cleanup();
  }
});

// ── plan 4087 T5: the coord-git spawn seam is total ────────────────────────────────────────────
//
// Not a test of gitRaw/isMainCheckout alone: an ENUMERATION over every `execFileSync('git', …)` /
// `spawnSync('git', …)` shape found by SOURCE-SCANNING scripts/coord/**/*.mjs (excluding test
// files), so a NEW unguarded spawn added anywhere under this tree later fails THIS test, not just
// a test of the two functions the plan-4087 ledger named.
//
// A hit is accepted three ways: (1) SAFE — gitRepoIsolatedEnv(...)/gitIsolatedEnv(...) appears in
// the same call's option object, i.e. the repo-selector strip (or the stronger blanket GIT_* strip)
// actually runs; (2) WAIVED — an inline `// coord-git-repo-selector-waiver: <reason>` comment rides
// near the call, for a spawn some future author judges genuinely safe without the seam; (3) BASELINE
// — a closed, explicitly-reasoned list below of spawns that predate this test and share the exact
// defect class this plan's two ledger lines retire, but sit in files OUTSIDE plan 4087 T5's file
// allowlist (`## SCOPE` in the T5 dispatch), so fixing them here would be scope creep on the
// highest-risk file in the whole coordination spine. Anything not in one of the three buckets fails,
// naming its file and line.
//
// BASELINE is a per-FILE COUNT, not a file:line pin. The first version pinned lines, and the first
// land to meet a concurrent sibling proved why that is wrong: another session edited build-index.mjs,
// its baselined spawn moved lines, and this test went red on THEIR change -- in every session that
// touched any of ~15 unrelated files, forever. A count survives line moves and still fails the one
// thing it exists to catch: a file gaining a NEW unguarded spawn (count above baseline). A file that
// sheds one (fixed, or deleted) passes; lower its number when you notice, and plan 4135 drives every
// entry to zero.
const COORD_DIR = import.meta.dirname;
const GIT_SPAWN_RX = /\b(?:execFileSync|spawnSync)\(\s*['"]git['"]/g;
const SEAM_MARKERS = ['gitRepoIsolatedEnv(', 'gitIsolatedEnv('];
const WAIVER_MARKER = 'coord-git-repo-selector-waiver:';

// file -> number of unguarded spawns. Plan 4135 (2026-09-23) drove this to EMPTY: every
// baselined site now routes through gitRepoIsolatedEnv() (board-write-gate.mjs /
// build-index.mjs / cloud-checkout-preflight.mjs / ensure-coord-reroute.mjs / git-safe.mjs /
// land-lib.mjs / lint-filename-execmodel-drift.mjs / lint-index-brevity.mjs /
// lint-plan-index.mjs / lint-stale-blocked.mjs / move-to-coord.mjs / pre-rebase-main-guard.mjs
// / queue-heartbeat-ref.mjs / review-diff-scope.mjs / session-priority.mjs /
// sweep-deferred-worktrees.mjs / check-coordination-branch.mjs, the last with
// gitRepoIsolatedEnv(hookIndexSetting()) -- see that file's comment on hookIndexSetting for why
// its pre-commit-hook sites need the extra re-admission), and the compute-push-diff.mjs false
// positive was retired by rewording its comment so the scan no longer matches prose. The object
// stays `{}`, not deleted: the machinery exists to catch the NEXT unguarded spawn, not to hold a
// permanent exemption list.
const BASELINE_UNGUARDED_SPAWNS = {};

function listCoordModuleFiles(root) {
  const out = [];
  for (const rel of readdirSync(root, { recursive: true })) {
    const relPosix = rel.replaceAll('\\', '/');
    if (!relPosix.endsWith('.mjs')) continue;
    if (relPosix.endsWith('.test.mjs')) continue;
    out.push(relPosix);
  }
  return out.sort();
}

test('every git spawn under scripts/coord/**/*.mjs goes through the repo-isolated seam, is waived, or is a named baseline entry (plan 4087 T5)', () => {
  const files = listCoordModuleFiles(COORD_DIR);
  assert.ok(
    files.length > 20,
    `sanity: expected many .mjs files under scripts/coord/, found ${files.length}`,
  );
  assert.ok(
    files.includes('coord-git.mjs') && files.includes('check-coordination-branch.mjs'),
    'sanity: the enumeration must actually reach the two files this plan fixed',
  );

  const failures = [];
  const unguardedByFile = {};
  const seenSafeOrWaived = []; // for the "the test actually exercises something" sanity check below

  for (const rel of files) {
    const abs = join(COORD_DIR, rel);
    const src = readFileSync(abs, 'utf8');
    let m;
    GIT_SPAWN_RX.lastIndex = 0;
    while ((m = GIT_SPAWN_RX.exec(src))) {
      const idx = m.index;
      const line = src.slice(0, idx).split('\n').length;
      const windowBefore = src.slice(Math.max(0, idx - 400), idx);
      const windowAfter = src.slice(idx, Math.min(src.length, idx + 600));
      const window = windowBefore + windowAfter;
      const isSafe = SEAM_MARKERS.some((mk) => windowAfter.includes(mk));
      const isWaived = window.includes(WAIVER_MARKER);
      const key = `${rel}:${line}`;
      if (isSafe || isWaived) {
        seenSafeOrWaived.push(key);
        continue;
      }
      unguardedByFile[rel] = (unguardedByFile[rel] || []).concat(key);
    }
  }

  for (const [rel, keys] of Object.entries(unguardedByFile)) {
    const allowed = BASELINE_UNGUARDED_SPAWNS[rel] ?? 0;
    if (keys.length <= allowed) continue;
    failures.push(
      `${rel} has ${keys.length} unguarded 'git' spawn(s) (${keys.join(', ')}), baseline allows ${allowed} -- ` +
        `a NEW spawn with no gitRepoIsolatedEnv()/gitIsolatedEnv() in its call and no ${WAIVER_MARKER} ` +
        'waiver. An ambient GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR can redirect it to the wrong repository -- ' +
        'see scripts/coord/child-env.mjs gitRepoIsolatedEnv() and coord-git.mjs gitRaw() for the fix shape.',
    );
  }

  assert.ok(
    seenSafeOrWaived.some((k) => k.startsWith('coord-git.mjs:')),
    'sanity: the scan must find at least one SAFE match in coord-git.mjs (gitRaw/resolveMain) -- ' +
      'a zero-hit scan here would mean the regex or window logic silently stopped matching real code',
  );
  assert.ok(
    seenSafeOrWaived.some((k) => k.startsWith('check-coordination-branch.mjs:')),
    'sanity: the scan must find at least one SAFE match in check-coordination-branch.mjs (isMainCheckout)',
  );

  assert.deepEqual(
    failures,
    [],
    `${failures.length} unguarded coord git spawn(s) found:\n  ${failures.join('\n  ')}`,
  );
});
