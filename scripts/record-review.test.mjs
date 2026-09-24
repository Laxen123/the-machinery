// scripts/record-review.test.mjs (plan 980 Group A)
// record-review's marker write previously called git RAW, so a transient `.git/index.lock` from a
// parallel session aborted it and the land then mis-seamed REVIEW_NEEDED even though the review
// passed. These tests pin that commitReviewMarker now routes the add/commit through gitWithLockRetry
// (retries an index.lock instead of crashing) AND that the idempotent-re-run no-op short-circuit is
// preserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  commitReviewMarker,
  findingsSidecarPath,
  DESC,
  warnIfReviewRoundCapReached,
  recordedReviewRound,
  recordedReviewMarkerSha,
  sessionReviewRound,
  reviewStatsIdentityDecision,
  describeReviewPastCap,
  appendMarkerPastCapSuffix,
  markerLinePastCapSuffix,
  wikiDecisionNudge,
  planFindingsCarry,
  readSidecarStrict,
} from './record-review.mjs';
import {
  parseFindingsRecord,
  parseReviewMarker,
  parseReviewMarkerFull,
  findingsGate,
  markerIdentityMatch,
  isSeedOnlyDelta,
  MARKER_FAMILIES,
} from './coord/done-worktree-lib.mjs';
// plan 4096 T2: the wiki-subject predicate is core now (its patterns are coord.config.json
// data) — see scripts/coord/wiki-checkpoint.mjs.
import { wikiCheckpointNeeded } from './coord/wiki-checkpoint.mjs';
import { rangePatchId } from './coord/land-lib.mjs';
import { readFileSync } from 'node:fs';
import { indexLockPath, gitWithLockRetry, git as coordGit } from './coord/coord-git.mjs';
import { reviewArtifactsDir, reviewFixBriefPath } from './coord/review-round-cap.mjs';

const SCRIPT = fileURLToPath(new URL('./record-review.mjs', import.meta.url));
// The re-pin CLI, which three tests below import from a generated harness module. It moved to
// scripts/coord/ in plan 4096's T3, so it is NOT `dirname(SCRIPT)` any more — resolved once here
// rather than spelled at each of the three call sites.
const MARKER_CLI = fileURLToPath(new URL('./coord/record-marker-cli.mjs', import.meta.url));

// An ESM specifier for an ABSOLUTE path, for the harness files some tests below generate on disk
// and then `import`. It must go through pathToFileURL: on Windows a bare absolute path is not a
// legal specifier — Node reads the drive letter as a URL scheme and dies with
// ERR_UNSUPPORTED_ESM_URL_SCHEME ("Received protocol 'c:'") — while on POSIX a leading `/` is
// accepted, so a bare path is invisible to a Linux author and reds only the Windows pre-push gate
// on some unrelated session's push. That is exactly plan 2853's class; this shape landed via plan
// 2844 and was caught by 2853's first nightly Windows run.
const specifierFor = (p) => JSON.stringify(pathToFileURL(p).href);

test('review stats identity refuses mismatched sha, warns for legacy, and exempts copy bundles', () => {
  const file = '/tmp/review-stats.json';
  const mismatch = reviewStatsIdentityDecision({ endSha: 'old-sha' }, 'new-sha', file);
  assert.match(mismatch.error, /old-sha/);
  assert.match(mismatch.error, /new-sha/);
  assert.match(mismatch.error, /review-stats\.json/);
  const legacy = reviewStatsIdentityDecision(null, 'new-sha', file);
  assert.match(legacy.warning, /plan 3507/);
  const missingEndSha = reviewStatsIdentityDecision({ fingerprint: 'bundle-id' }, 'new-sha', file);
  assert.match(missingEndSha.warning, /plan 3507/);
  assert.match(missingEndSha.warning, /no endSha/);
  assert.deepEqual(
    reviewStatsIdentityDecision(
      { endSha: 'ABCDEF1' },
      'abcdef1234567890abcdef1234567890abcdef12',
      file,
    ),
    {},
  );
  assert.deepEqual(
    reviewStatsIdentityDecision({ kind: 'copy-bundle', endSha: 'irrelevant' }, 'new-sha', file),
    {},
  );
});

// Drive record-review.mjs as a subprocess from `cwd`. Clean env: no COORD_MAIN_DIR override (would
// redirect resolveMain), GIT_* already cleared at module scope. Returns the spawn result; the caller
// catches the thrown error on a non-zero (refuse) exit. (plan 1105 — shared by the driver tests.)
function runRecordReview(cwd, slug, extra = []) {
  return execFileSync('node', [SCRIPT, 'PASS', '--slug', slug, '--no-push', ...extra], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, COORD_MAIN_DIR: '' },
  });
}

// plan 338: git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE into hook subprocesses, and those
// OVERRIDE the `git -C <tmpdir>` repo selection below, redirecting these temp-repo ops onto the REAL
// repo. Clear them so every git call honours -C <tmpdir>.
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

// A real temp repo with a committed session file at `sf`.
function makeRepoWithSession(sf, content) {
  const dir = mkdtempSync(join(tmpdir(), 'record-review-test-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  mkdirSync(dirname(join(dir, sf)), { recursive: true });
  writeFileSync(join(dir, sf), content);
  g('add', '-A');
  g('commit', '-qm', 'init session');
  return { dir, g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const SF = 'handoff/sessions/2026-06-22-session-980.md';

test('warnIfReviewRoundCapReached: reads record-review marker rounds, never directory names', () => {
  const slug = '3395-SOL-review-round-cap';
  const warnings = [];
  const session = `Review: PASS @ ${'a'.repeat(40)} patch-id:${'b'.repeat(40)} review-round:3\n`;
  assert.equal(
    warnIfReviewRoundCapReached(
      '/repo',
      slug,
      { sessionsDir: 'docs/handoff/sessions' },
      {
        warn: (message) => warnings.push(message),
        findSessionFn: () => 'docs/handoff/sessions/session.md',
        readCandidatesFn: () => [session],
      },
    ),
    3,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /session marker records round 3/);
  assert.match(warnings[0], /launching round 4 is at the 3-delta-round cap/);
});

test('warnIfReviewRoundCapReached: round 2 warns when round 1 has no fresh-context brief', () => {
  const warnings = [];
  const session = `Review: PASS @ ${'a'.repeat(40)} review-round:1\n`;
  assert.equal(
    warnIfReviewRoundCapReached(
      '/repo',
      '3545-SOL-review-fix-brief',
      { sessionsDir: 'docs/handoff/sessions' },
      {
        warn: (message) => warnings.push(message),
        findSessionFn: () => 'docs/handoff/sessions/session.md',
        readCandidatesFn: () => [session],
        previousRoundOutDirFn: () => '/repo/.scratch/gpt-review/slug/round-1',
        existsFn: () => false,
      },
    ),
    1,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /round 1's fix ran without a fresh-context brief/);
});

test("warnIfReviewRoundCapReached: the default previous-round check resolves gpt-review's real flat, slug-keyed directory — not a round-<n> one (finding m57y8f)", () => {
  const repoRoot = '/repo';
  const slug = '3624-SOL-flat-check';
  const flatOutDir = reviewArtifactsDir(repoRoot, slug);
  const flatBriefPath = reviewFixBriefPath(repoRoot, slug);
  const session = `Review: PASS @ ${'a'.repeat(40)} review-round:1\n`;

  // The brief for round 1 was written into gpt-review's real (flat) --out directory — the
  // SAME one every round reuses, per its own documented `--out .scratch/gpt-review/<slug>`
  // shape — so no warning is owed here.
  const seenPresent = [];
  const warningsPresent = [];
  assert.equal(
    warnIfReviewRoundCapReached(
      repoRoot,
      slug,
      { sessionsDir: 'docs/handoff/sessions' },
      {
        warn: (message) => warningsPresent.push(message),
        findSessionFn: () => 'docs/handoff/sessions/session.md',
        readCandidatesFn: () => [session],
        reviewOutDir: flatOutDir,
        existsFn: (p) => {
          seenPresent.push(p);
          return p === flatBriefPath;
        },
      },
    ),
    1,
  );
  assert.equal(warningsPresent.length, 0, warningsPresent.join('\n'));
  assert.ok(
    seenPresent.includes(flatBriefPath),
    `expected a check against the flat path ${flatBriefPath}, saw: ${seenPresent.join(', ')}`,
  );

  // Same inputs, but the brief was never written — the flat path is genuinely absent, so this
  // time the warning DOES fire (and must still name the real flat path, not a phantom round-0
  // sibling).
  const warningsAbsent = [];
  warnIfReviewRoundCapReached(
    repoRoot,
    slug,
    { sessionsDir: 'docs/handoff/sessions' },
    {
      warn: (message) => warningsAbsent.push(message),
      findSessionFn: () => 'docs/handoff/sessions/session.md',
      readCandidatesFn: () => [session],
      reviewOutDir: flatOutDir,
      existsFn: () => false,
    },
  );
  assert.equal(warningsAbsent.length, 1);
  assert.match(warningsAbsent[0], /round 1's fix ran without a fresh-context brief/);
  assert.ok(warningsAbsent[0].includes(flatBriefPath), warningsAbsent[0]);
});

test("warnIfReviewRoundCapReached: uses the CALLER-SUPPLIED reviewOutDir, not a path recomputed from the slug — gpt-review.mjs's default --out is timestamp-keyed, not slug-keyed (findings 322f33/d0200a/29b2be)", () => {
  const repoRoot = '/repo';
  const slug = '3624-SOL-flat-check';
  // A DEFAULT-launched review's real --out dir: gpt-review.mjs's own default (no --out given) is
  // timestamp-keyed, never slug-keyed — deliberately NOT equal to reviewFixBriefPath(repoRoot,
  // slug)'s directory, so a reader that ignores reviewOutDir and recomputes from the slug proves
  // itself broken here (the earlier finding-m57y8f test above used a reviewOutDir that happened to
  // COINCIDE with the slug path, which cannot catch this).
  const timestampOutDir = reviewArtifactsDir(repoRoot, '2026-09-02T12-00-00-000Z');
  const timestampBriefPath = join(timestampOutDir, 'review-fix-brief.md');
  const session = `Review: PASS @ ${'a'.repeat(40)} review-round:1\n`;

  const seen = [];
  const warnings = [];
  assert.equal(
    warnIfReviewRoundCapReached(
      repoRoot,
      slug,
      { sessionsDir: 'docs/handoff/sessions' },
      {
        warn: (message) => warnings.push(message),
        findSessionFn: () => 'docs/handoff/sessions/session.md',
        readCandidatesFn: () => [session],
        reviewOutDir: timestampOutDir,
        existsFn: (p) => {
          seen.push(p);
          return p === timestampBriefPath;
        },
      },
    ),
    1,
  );
  assert.equal(warnings.length, 0, warnings.join('\n'));
  assert.ok(
    seen.includes(timestampBriefPath),
    `expected a check against the real reviewOutDir-derived path ${timestampBriefPath}, saw: ${seen.join(', ')}`,
  );
});

test('warnIfReviewRoundCapReached: falls back to the slug-keyed reviewFixBriefPath when a fresh reviewOutDir (a new default-launched timestamp dir) does not have it, instead of false-warning (findings 774dfb/94cc1e/a42853/83a2e4)', () => {
  const repoRoot = '/repo';
  const slug = '3624-SOL-round2-fallback';
  // Round 2's OWN fresh default --out directory (a new timestamp, distinct from round 1's) —
  // the brief actually lives at the slug-keyed default location instead, e.g. because round 1
  // was launched with the documented `--out .scratch/gpt-review/<slug>` convention.
  const freshOutDir = reviewArtifactsDir(repoRoot, '2026-09-02T13-00-00-000Z');
  const slugBriefPath = reviewFixBriefPath(repoRoot, slug);
  const session = `Review: PASS @ ${'a'.repeat(40)} review-round:1\n`;
  const seen = [];
  const warnings = [];
  assert.equal(
    warnIfReviewRoundCapReached(
      repoRoot,
      slug,
      { sessionsDir: 'docs/handoff/sessions' },
      {
        warn: (message) => warnings.push(message),
        findSessionFn: () => 'docs/handoff/sessions/session.md',
        readCandidatesFn: () => [session],
        reviewOutDir: freshOutDir,
        existsFn: (p) => {
          seen.push(p);
          return p === slugBriefPath;
        },
      },
    ),
    1,
  );
  assert.equal(warnings.length, 0, warnings.join('\n'));
  assert.ok(
    seen.includes(slugBriefPath),
    `expected a fallback check against the slug-keyed path ${slugBriefPath}, saw: ${seen.join(', ')}`,
  );
});

test('warnIfReviewRoundCapReached: names both checked locations when the brief is absent from both', () => {
  const repoRoot = '/repo';
  const slug = '3624-SOL-round2-both-absent';
  const freshOutDir = reviewArtifactsDir(repoRoot, '2026-09-02T14-00-00-000Z');
  const freshBriefPath = join(freshOutDir, 'review-fix-brief.md');
  const slugBriefPath = reviewFixBriefPath(repoRoot, slug);
  const session = `Review: PASS @ ${'a'.repeat(40)} review-round:1\n`;
  const warnings = [];
  warnIfReviewRoundCapReached(
    repoRoot,
    slug,
    { sessionsDir: 'docs/handoff/sessions' },
    {
      warn: (message) => warnings.push(message),
      findSessionFn: () => 'docs/handoff/sessions/session.md',
      readCandidatesFn: () => [session],
      reviewOutDir: freshOutDir,
      existsFn: () => false,
    },
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /round 1's fix ran without a fresh-context brief/);
  assert.ok(warnings[0].includes(freshBriefPath), warnings[0]);
  assert.ok(warnings[0].includes(slugBriefPath), warnings[0]);
});

// plan 3618 finding 77e56c (D4): the warning used to fire off ANY prior escape, regardless of
// its exit — but the actual denial predicate (pastCapEscapeDecision) only fires when the
// trailing streak's newest exit is `run:`. A `simplify:`/`park:` tail means the NEXT `run:` is
// explicitly allowed (a different exit breaks the streak), so warning about an imminent denial
// there is simply false.
test('warnIfReviewRoundCapReached: the escape note fires only when the last exit was run: (finding 77e56c)', () => {
  const slug = '3527-SOL-review-round-cap';
  const session = `Review: PASS @ ${'a'.repeat(40)} review-round:3\n`;
  function warnWith(readConsecutiveEscapesFn, lastEscapeExitFn) {
    const warnings = [];
    warnIfReviewRoundCapReached(
      '/repo',
      slug,
      { sessionsDir: 'docs/handoff/sessions' },
      {
        warn: (message) => warnings.push(message),
        findSessionFn: () => 'docs/handoff/sessions/session.md',
        readCandidatesFn: () => [session],
        readConsecutiveEscapesFn,
        lastEscapeExitFn,
      },
    );
    return warnings;
  }

  const simplifyTail = warnWith(
    () => 1,
    () => 'simplify',
  );
  assert.equal(simplifyTail.length, 1);
  assert.doesNotMatch(simplifyTail[0], /consecutive past-cap escape/);
  assert.doesNotMatch(simplifyTail[0], /is DENIED/);

  const parkTail = warnWith(
    () => 2,
    () => 'park',
  );
  assert.equal(parkTail.length, 1);
  assert.doesNotMatch(parkTail[0], /is DENIED/);

  const runTail = warnWith(
    () => 1,
    () => 'run',
  );
  assert.equal(runTail.length, 1);
  assert.match(runTail[0], /1 consecutive past-cap escape\(s\) are already recorded/);
  assert.match(runTail[0], /the last of which named "run:"/);
  assert.match(runTail[0], /is DENIED, not warned/);

  const noEscapes = warnWith(
    () => 0,
    () => null,
  );
  assert.equal(noEscapes.length, 1);
  assert.doesNotMatch(noEscapes[0], /is DENIED/);
});

// plan 3618 round 2 (R3, findings 72779b/4ab4b6/90a435): production reads the ledger's escape
// state ONCE per past-cap warning, not twice. Neither override function is supplied here, so the
// implementation must fall through to `readEscapeStateFn` — a single call — rather than the old
// two-separate-reader shape.
test('warnIfReviewRoundCapReached: reads the ledger escape state ONCE via readEscapeStateFn when no per-signal override is supplied', () => {
  const slug = '3527-SOL-review-round-cap';
  const session = `Review: PASS @ ${'a'.repeat(40)} review-round:3\n`;
  let calls = 0;
  const warnings = [];
  warnIfReviewRoundCapReached(
    '/repo',
    slug,
    { sessionsDir: 'docs/handoff/sessions' },
    {
      warn: (message) => warnings.push(message),
      findSessionFn: () => 'docs/handoff/sessions/session.md',
      readCandidatesFn: () => [session],
      readEscapeStateFn: (repoRoot, planId) => {
        calls += 1;
        // path-assert-ok: repoRoot here is an opaque mock-fixture TOKEN echoed back through the
        // injected callback, never joined/resolved as a real filesystem path — byte-identity is
        // the actual point of this assertion (proving the caller forwarded its own repoRoot
        // unchanged), not path semantics.
        assert.equal(repoRoot, '/repo');
        assert.equal(planId, '3527');
        return { consecutiveEscapes: 2, lastExit: 'run' };
      },
    },
  );
  assert.equal(calls, 1, 'exactly one ledger read for both signals');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2 consecutive past-cap escape\(s\) are already recorded/);
  assert.match(warnings[0], /is DENIED, not warned/);
});

// The per-signal override path stays available for tests that want to vary the two independently
// (as the test above this one does) — supplying EITHER override opts out of the combined read.
test('warnIfReviewRoundCapReached: supplying either per-signal override opts out of the combined read', () => {
  const slug = '3527-SOL-review-round-cap';
  const session = `Review: PASS @ ${'a'.repeat(40)} review-round:3\n`;
  let combinedReadCalls = 0;
  const warnings = [];
  warnIfReviewRoundCapReached(
    '/repo',
    slug,
    { sessionsDir: 'docs/handoff/sessions' },
    {
      warn: (message) => warnings.push(message),
      findSessionFn: () => 'docs/handoff/sessions/session.md',
      readCandidatesFn: () => [session],
      readEscapeStateFn: () => {
        combinedReadCalls += 1;
        return { consecutiveEscapes: 9, lastExit: 'run' };
      },
      readConsecutiveEscapesFn: () => 1,
      lastEscapeExitFn: () => 'simplify',
    },
  );
  assert.equal(combinedReadCalls, 0, 'the override path never touches readEscapeStateFn');
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /is DENIED/);
});

// plan 1105 — the pure branch-guard decision (checkRecordBranch) is unit-tested in
// redgreen-lib.test.mjs (its home). Here we drive the real script end-to-end.

// plan 1105 — end-to-end: a real repo + linked worktree on worktree-<slug> whose HEAD differs from
// master's. Driving record-review.mjs as a subprocess from the MAIN checkout (HEAD=master) with
// --slug must REFUSE (exit 2) BEFORE writing/committing anything — instead of pinning master's tip
// (the original bug). Mirrors the real-git-worktree harness in clear-stale-worktree-lock.test.mjs.
function makeRepoWithWorktree(slug) {
  const root = mkdtempSync(join(tmpdir(), 'record-review-wt-'));
  const g = (dir, ...a) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=', ...a],
      { encoding: 'utf8' },
    ).trim();
  const mainDir = join(root, 'main');
  execFileSync('git', ['init', '-q', '-b', 'master', mainDir], { stdio: 'ignore' });
  writeFileSync(join(mainDir, 'f.txt'), 'a\n');
  // sessions layout so record-review reaches the worktree refuse guard (a single-file repo would
  // no-op-return-0 before it); resolveMain() lists worktrees and requires the main on `master`.
  writeFileSync(
    join(mainDir, 'coord.config.json'),
    '{"handoffLayout":"sessions","handoffDir":"docs/handoff"}\n',
  );
  g(mainDir, 'add', 'f.txt', 'coord.config.json');
  g(mainDir, 'commit', '-qm', 'init');
  const wtDir = join(root, 'wt');
  g(mainDir, 'worktree', 'add', '-q', wtDir, '-b', `worktree-${slug}`);
  // advance the worktree branch so its HEAD diverges from master's HEAD
  writeFileSync(join(wtDir, 'g.txt'), 'b\n');
  g(wtDir, 'add', 'g.txt');
  g(wtDir, 'commit', '-qm', 'branch work');
  return {
    mainDir,
    wtDir,
    masterHead: g(mainDir, 'rev-parse', 'master'),
    branchHead: g(mainDir, 'rev-parse', `worktree-${slug}`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('record-review on a single-file-layout repo is a clean no-op (exit 0), not a hard error', () => {
  // plan 1105 review finding [0]: the worktree-refuse guard must sit AFTER the layout check, so a
  // sibling repo on the single-file layout still exits 0 cleanly (it used to) instead of exit 2.
  const root = mkdtempSync(join(tmpdir(), 'record-review-single-'));
  const g = (...a) =>
    execFileSync(
      'git',
      ['-C', root, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=', ...a],
      { encoding: 'utf8' },
    );
  try {
    execFileSync('git', ['init', '-q', '-b', 'master', root], { stdio: 'ignore' });
    writeFileSync(join(root, 'f.txt'), 'a\n'); // NO coord.config.json → single-file layout
    g('add', 'f.txt');
    g('commit', '-qm', 'init');
    // exit 0 (no throw) even invoked from master with --slug — the layout no-op precedes the refuse
    const out = runRecordReview(root, 'whatever');
    assert.match(out + '', /^$/, 'no stdout payload — it just no-ops');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('record-review --slug from the MAIN checkout refuses (exit 2) and records nothing', () => {
  const r = makeRepoWithWorktree('plan-x');
  try {
    assert.notEqual(
      r.branchHead,
      r.masterHead,
      'precondition: branch HEAD differs from master HEAD',
    );
    let err;
    try {
      runRecordReview(r.mainDir, 'plan-x');
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must exit non-zero (refuse), not succeed');
    assert.equal(err.status, 2, 'refusal is a usage error → exit 2');
    assert.match(
      err.stderr,
      /worktree-plan-x/,
      'names the worktree branch the operator must record from',
    );
    // nothing was committed on master (no stray review-marker commit)
    const head = execFileSync('git', ['-C', r.mainDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(head, r.masterHead, 'master HEAD unchanged — refused before any commit');
  } finally {
    r.cleanup();
  }
});

test('commitReviewMarker: retries past a present-then-cleared index.lock and commits (no throw)', () => {
  const r = makeRepoWithSession(SF, 'session entry\n');
  try {
    // a marker was upserted into the entry (main() does this before calling commitReviewMarker)
    writeFileSync(join(r.dir, SF), 'session entry\nReview: PASS @ abcdef012\n');
    // a fresh index.lock simulating a parallel session mid-commit; a real OS process clears it ~150ms
    // in, proving the lock-retry (not a stale auto-clear) lets the marker write through.
    const lock = indexLockPath(r.dir);
    writeFileSync(lock, '');
    const child = spawn(process.execPath, [
      '-e',
      `setTimeout(() => require('fs').rmSync(${JSON.stringify(lock)}, { force: true }), 150)`,
    ]);
    const res = commitReviewMarker(r.dir, SF, {
      slug: 'foo-plan',
      verdict: 'PASS',
      sha: 'abcdef0123456789',
      noPush: true,
      retryOpts: { attempts: 40, delayMs: 50 },
    });
    child.kill();
    assert.equal(res.noop, false, 'a changed entry must commit, not no-op');
    assert.equal(existsSync(lock), false, 'the lock was cleared and the commit went through');
    assert.match(
      r.g('log', '-1', '--format=%s'),
      /chore\(review\): record PASS @ abcdef012 for foo-plan/,
      'the review marker commit landed',
    );
    assert.equal(r.g('status', '--porcelain').trim(), '', 'nothing left uncommitted');
  } finally {
    r.cleanup();
  }
});

test('commitReviewMarker: short-circuits to a no-op when the working tree already matches HEAD', () => {
  const r = makeRepoWithSession(SF, 'session entry\nReview: PASS @ abcdef012\n');
  try {
    const before = r.g('rev-parse', 'HEAD').trim();
    // the entry is UNCHANGED (an idempotent re-run) → nothing to commit
    const res = commitReviewMarker(r.dir, SF, {
      slug: 'foo-plan',
      verdict: 'PASS',
      sha: 'abcdef0123456789',
      noPush: true,
    });
    assert.equal(res.noop, true, 'an unchanged entry must short-circuit to a no-op');
    assert.equal(r.g('rev-parse', 'HEAD').trim(), before, 'no new commit was created');
  } finally {
    r.cleanup();
  }
});

test('commitReviewMarker: routes BOTH the add and commit through the lock-retry layer (not raw git)', () => {
  const r = makeRepoWithSession(SF, 'session entry\n');
  try {
    writeFileSync(join(r.dir, SF), 'session entry\nReview: NITS @ deadbeef0\n');
    const calls = [];
    const _gitRetry = (dir, args) => {
      calls.push(args[0]);
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    };
    let pushed = false;
    const res = commitReviewMarker(r.dir, SF, {
      slug: 'bar-plan',
      verdict: 'NITS',
      sha: 'deadbeef00000000',
      _gitRetry,
      _push: () => {
        pushed = true;
      },
    });
    assert.deepEqual(calls, ['add', 'commit'], 'add + commit both go through gitWithLockRetry');
    assert.equal(pushed, true, 'a non-noop commit pushes via pushMasterWithRebase');
    assert.equal(res.noop, false);
  } finally {
    r.cleanup();
  }
});

test('commitReviewMarker: a genuine non-transient git failure surfaces (not swallowed as retry)', () => {
  const r = makeRepoWithSession(SF, 'session entry\n');
  try {
    writeFileSync(join(r.dir, SF), 'session entry\nReview: PASS @ abcdef012\n');
    const _gitRetry = (_dir, args) => {
      if (args[0] === 'commit') throw new Error('fatal: a real non-lock commit failure');
      // add succeeds
    };
    assert.throws(
      () =>
        commitReviewMarker(r.dir, SF, {
          slug: 'baz-plan',
          verdict: 'PASS',
          sha: 'abcdef0123456789',
          noPush: true,
          _gitRetry,
        }),
      /a real non-lock commit failure/,
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 1205: findings sidecar (--findings ingest) + disposition subcommand ──────────────
// A main checkout (sessions layout) with a committed session entry referencing the slug, plus a
// worktree on worktree-<slug> from which record-review runs (the plan-1105 branch guard requires
// it). resolveMain() walks worktrees from the wt and finds the main checkout.
function makeFindingsRepo(slug, sessionBody = `# session\n\nclaim: ${'${slug}'}\n`) {
  const root = mkdtempSync(join(tmpdir(), 'record-review-findings-'));
  const g = (dir, ...a) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=', ...a],
      { encoding: 'utf8' },
    ).trim();
  const mainDir = join(root, 'main');
  execFileSync('git', ['init', '-q', '-b', 'master', mainDir], { stdio: 'ignore' });
  writeFileSync(
    join(mainDir, 'coord.config.json'),
    '{"handoffLayout":"sessions","handoffDir":"docs/handoff"}\n',
  );
  const sf = `docs/handoff/sessions/2026-06-30-session-1205.md`;
  mkdirSync(dirname(join(mainDir, sf)), { recursive: true });
  writeFileSync(join(mainDir, sf), sessionBody.replace('${slug}', slug));
  g(mainDir, 'add', '-A');
  g(mainDir, 'commit', '-qm', 'init main + session');
  const wtDir = join(root, 'wt');
  g(mainDir, 'worktree', 'add', '-q', wtDir, '-b', `worktree-${slug}`);
  writeFileSync(join(wtDir, 'g.txt'), 'b\n');
  g(wtDir, 'add', 'g.txt');
  g(wtDir, 'commit', '-qm', 'branch work');
  return {
    root,
    mainDir,
    wtDir,
    sf,
    g,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runRR(cwd, args) {
  return execFileSync('node', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, COORD_MAIN_DIR: '' },
  });
}

// plan 1286: origin-backed variant of makeFindingsRepo — the ROUTED default path lands via
// the coord-checkout + push, so it needs a real origin (the sessions layout is pushed there).
function makeOriginFindingsRepo(slug) {
  const root = mkdtempSync(join(tmpdir(), 'record-review-routed-'));
  const g = (dir, ...a) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=', ...a],
      { encoding: 'utf8' },
    ).trim();
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  const mainDir = join(root, 'main');
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, mainDir], {
    stdio: 'ignore',
  });
  writeFileSync(
    join(mainDir, 'coord.config.json'),
    '{"handoffLayout":"sessions","handoffDir":"docs/handoff"}\n',
  );
  writeFileSync(join(mainDir, '.gitignore'), '.claude/\n');
  const sf = `docs/handoff/sessions/2026-07-02-session-1286.md`;
  mkdirSync(dirname(join(mainDir, sf)), { recursive: true });
  writeFileSync(join(mainDir, sf), `# session\n\nclaim: ${slug}\n`);
  g(mainDir, 'add', '-A');
  g(mainDir, 'commit', '-qm', 'init main + session');
  g(mainDir, 'push', '-q', 'origin', 'master');
  const wtDir = join(root, 'wt');
  g(mainDir, 'worktree', 'add', '-q', wtDir, '-b', `worktree-${slug}`);
  writeFileSync(join(wtDir, 'g.txt'), 'b\n');
  g(wtDir, 'add', 'g.txt');
  g(wtDir, 'commit', '-qm', 'branch work');
  return {
    root,
    origin,
    mainDir,
    wtDir,
    sf,
    g,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('plan 1286: routed record-review lands the marker on ORIGIN via the coord-checkout — MAIN gets no commit and stays attached', () => {
  const r = makeOriginFindingsRepo('plan-routed');
  try {
    const mainTipBefore = r.g(r.mainDir, 'rev-parse', 'master');
    runRR(r.wtDir, ['PASS']); // NO --no-push → the routed default path
    // marker commit is on origin, with the coordWrite trailer
    const msg = r.g(r.mainDir, 'log', '-1', '--format=%B', 'origin/master');
    assert.match(msg, /chore\(review\): record PASS @/);
    assert.match(msg, /Coord-Write: record-review/);
    const originSf = r.g(r.mainDir, 'show', `origin/master:${r.sf}`);
    assert.match(originSf, /Review: PASS @ /);
    // MAIN: no local commit, working tree untouched, HEAD still attached to master
    assert.equal(r.g(r.mainDir, 'rev-parse', 'master'), mainTipBefore, 'no commit on MAIN');
    assert.equal(r.g(r.mainDir, 'symbolic-ref', 'HEAD'), 'refs/heads/master');
    assert.ok(
      !readFileSync(join(r.mainDir, r.sf), 'utf8').includes('Review: PASS'),
      "MAIN's working copy was not written — origin is the source of truth",
    );
  } finally {
    r.cleanup();
  }
});

test('plan 1286: a REJECTED push leaves no committed-but-unpushed marker anywhere (atomic marker+push)', () => {
  const r = makeOriginFindingsRepo('plan-atomic');
  try {
    // Server-side reject: a pre-receive hook that refuses every push.
    mkdirSync(join(r.origin, 'hooks'), { recursive: true });
    writeFileSync(join(r.origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho rejected >&2\nexit 1\n');
    // POSIX git skips a non-executable hook (git-for-Windows ignores the exec bit),
    // so without this the reject never fires on Linux CI and the push spuriously
    // succeeds — masking the atomicity assertion (plan 1456).
    chmodSync(join(r.origin, 'hooks', 'pre-receive'), 0o755);
    const mainTipBefore = r.g(r.mainDir, 'rev-parse', 'master');
    const originTipBefore = r.g(r.mainDir, 'rev-parse', 'origin/master');
    assert.throws(() => runRR(r.wtDir, ['PASS']), /./, 'the failed push must surface (exit != 0)');
    // NOTHING landed and NOTHING is committed-but-unpushed: origin unchanged, MAIN unchanged.
    r.g(r.mainDir, 'fetch', '-q', 'origin', 'master');
    assert.equal(r.g(r.mainDir, 'rev-parse', 'origin/master'), originTipBefore);
    assert.equal(r.g(r.mainDir, 'rev-parse', 'master'), mainTipBefore);
    assert.equal(r.g(r.mainDir, 'symbolic-ref', 'HEAD'), 'refs/heads/master');
    assert.equal(
      r.g(r.mainDir, 'status', '--porcelain', '--untracked-files=no'),
      '',
      'no marker residue in MAIN',
    );
  } finally {
    r.cleanup();
  }
});

test('record-review NITS --findings: writes tagged dispositions + commits the sidecar with the marker', () => {
  const r = makeFindingsRepo('plan-fa');
  try {
    const findings = [
      {
        file: 'backend/src/a.ts',
        line: 10,
        summary: 'null deref',
        verdict: 'CONFIRMED',
        kind: 'correctness',
      },
      {
        file: 'backend/src/b.ts',
        line: 20,
        summary: 'reuse helper',
        verdict: 'PLAUSIBLE',
        kind: 'cleanup',
      },
    ];
    const fjson = join(r.root, 'findings.json');
    writeFileSync(fjson, JSON.stringify(findings));
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    const sidecar = join(r.mainDir, findingsSidecarPath(r.sf));
    assert.ok(existsSync(sidecar), 'sidecar JSON was written next to the session entry');
    const rec = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    assert.equal(rec.verdict, 'NITS');
    assert.equal(rec.findings.length, 2);
    assert.equal(rec.findings[0].disposition, null, 'must-fix findings start undispositioned');
    assert.equal(
      rec.findings[1].disposition.type,
      'deferred-by-tag',
      'plausible findings are advisory',
    );
    // both the marker (session .md) and the sidecar landed in ONE commit
    assert.match(r.g(r.mainDir, 'log', '-1', '--format=%s'), /chore\(review\): record NITS @/);
    const filesInCommit = r.g(r.mainDir, 'show', '--name-only', '--format=', 'HEAD');
    assert.match(filesInCommit, /\.findings\.json/);
    assert.match(filesInCommit, /session-1205\.md/);
  } finally {
    r.cleanup();
  }
});

test('record-review partitions must-fix/advisory findings and auto-defers the advisory remainder', () => {
  const r = makeFindingsRepo('plan-tags');
  try {
    const findings = [
      {
        file: 'backend/src/a.ts',
        line: 10,
        summary: 'new wrong value',
        verdict: 'CONFIRMED',
        kind: 'correctness',
        preExisting: false,
        preExistingWhy: 'the flagged line is on the plus side',
        blocksLand: true,
        blocksLandWhy: 'wrong user-facing value',
      },
      {
        file: 'backend/src/b.ts',
        line: 20,
        summary: 'warning wording',
        verdict: 'CONFIRMED',
        kind: 'correctness',
        preExisting: false,
        preExistingWhy: 'the flagged line is on the plus side',
        blocksLand: false,
        blocksLandWhy: 'a wrong warning line is advisory',
      },
    ];
    const fjson = join(r.root, 'findings.json');
    writeFileSync(fjson, JSON.stringify(findings));
    const stdout = runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    const rec = parseFindingsRecord(
      readFileSync(join(r.mainDir, findingsSidecarPath(r.sf)), 'utf8'),
    );
    assert.equal(rec.findings[0].disposition, null);
    assert.deepEqual(rec.findings[1].disposition, {
      type: 'deferred-by-tag',
      preExisting: false,
      blocksLand: false,
      reason:
        'preExisting=false: the flagged line is on the plus side; blocksLand=false: a wrong warning line is advisory',
    });
    assert.match(stdout, /must-fix: 1 \/ advisory: 1/);
  } finally {
    r.cleanup();
  }
});

test('record-review defaults untagged confirmed findings to blocking and non-pre-existing', () => {
  const r = makeFindingsRepo('plan-tag-defaults');
  try {
    const fjson = join(r.root, 'findings.json');
    writeFileSync(
      fjson,
      JSON.stringify([
        {
          file: 'backend/src/a.ts',
          line: 10,
          summary: 'legacy confirmed defect',
          verdict: 'CONFIRMED',
          kind: 'correctness',
        },
      ]),
    );
    const stdout = runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    const rec = parseFindingsRecord(
      readFileSync(join(r.mainDir, findingsSidecarPath(r.sf)), 'utf8'),
    );
    assert.equal(rec.findings[0].preExisting, false);
    assert.equal(rec.findings[0].blocksLand, true);
    assert.equal(rec.findings[0].disposition, null);
    assert.match(stdout, /must-fix: 1 \/ advisory: 0/);
  } finally {
    r.cleanup();
  }
});

test('record-review reports pre-existing confirmed correctness defects needing evidence-floor routing', () => {
  const r = makeFindingsRepo('plan-tag-preexisting');
  try {
    const fjson = join(r.root, 'findings.json');
    writeFileSync(
      fjson,
      JSON.stringify([
        {
          file: 'backend/src/a.ts',
          line: 10,
          summary: 'old correctness defect',
          verdict: 'CONFIRMED',
          kind: 'correctness',
          preExisting: true,
          preExistingWhy: 'the flagged line is outside the plus side',
          blocksLand: true,
          blocksLandWhy: 'wrong data value',
        },
      ]),
    );
    const stdout = runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    const rec = parseFindingsRecord(
      readFileSync(join(r.mainDir, findingsSidecarPath(r.sf)), 'utf8'),
    );
    assert.match(rec.findings[0].disposition.reason, /infra-debt or --plan --observed/);
    assert.match(stdout, /pre-existing correctness defects needing evidence-floor routing: 1/);
  } finally {
    r.cleanup();
  }
});

test('record-review NITS with NO --findings: still records the marker but warns about FINDINGS_OPEN', () => {
  const r = makeFindingsRepo('plan-fb');
  try {
    let stderr = '';
    try {
      execFileSync('node', [SCRIPT, 'NITS', '--no-push'], {
        cwd: r.wtDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, COORD_MAIN_DIR: '' },
      });
    } catch (e) {
      stderr = e.stderr || '';
      throw e; // a warn must NOT be a non-zero exit
    }
    assert.equal(
      existsSync(join(r.mainDir, findingsSidecarPath(r.sf))),
      false,
      'no sidecar without --findings',
    );
  } finally {
    r.cleanup();
  }
});

test('record-review disposition <key> --fixed: updates the sidecar disposition', () => {
  const r = makeFindingsRepo('plan-fc');
  try {
    const findings = [
      { file: 'backend/src/a.ts', line: 10, summary: 'null deref', kind: 'correctness' },
    ];
    const fjson = join(r.root, 'findings.json');
    writeFileSync(fjson, JSON.stringify(findings));
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    const sidecar = join(r.mainDir, findingsSidecarPath(r.sf));
    const key = parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings[0].key;
    runRR(r.wtDir, ['disposition', key, '--fixed', '--no-push']);
    const rec = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    assert.deepEqual(rec.findings[0].disposition, { type: 'fixed' });
    assert.match(r.g(r.mainDir, 'log', '-1', '--format=%s'), /disposition .* → fixed/);
  } finally {
    r.cleanup();
  }
});

// plan 4078 T3 (operator-pinned 2026-09-20 — warn, never deny): from review round 2 on, a
// `--fixed` disposition on a finding tagged `preExisting: true` / `blocksLand: false` prints one
// WARNING naming docs/runbooks/plans-workflow.md § Disposition policy Step 0. Silent at round 1
// (any tag) and on a must-fix finding at any round.
test('record-review disposition --fixed on a preExisting/optional finding at round >= 2 WARNS; silent at round 1 and on must-fix findings', () => {
  // makeRepoForRepin (not makeFindingsRepo): the round only advances past 1 when
  // patchIdenticalDecision can actually compute a patch-id, which needs a real `origin` — a
  // rework in a repo with none (makeFindingsRepo) never mints round 2 at all.
  const r = makeRepoForRepin('plan-4078-t3');
  try {
    const findings = [
      {
        file: 'backend/src/a.ts',
        line: 10,
        summary: 'must-fix defect',
        verdict: 'CONFIRMED',
        kind: 'correctness',
        preExisting: false,
        blocksLand: true,
      },
      {
        file: 'backend/src/b.ts',
        line: 20,
        summary: 'pre-existing cleanup',
        verdict: 'CONFIRMED',
        kind: 'cleanup',
        preExisting: true,
        blocksLand: false,
      },
    ];
    const fjson = join(r.root, 'findings.json');
    writeFileSync(fjson, JSON.stringify(findings));
    const sidecar = join(r.mainDir, findingsSidecarPath(r.sf));

    // Round 1.
    const round1Record = runRRCapture(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    assert.equal(round1Record.status, 0, round1Record.stderr);
    const before = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    const mustFixKey = before.findings.find((f) => f.summary === 'must-fix defect').key;
    const optionalKey = before.findings.find((f) => f.summary === 'pre-existing cleanup').key;

    // Round 1, optional finding, --fixed: silent (round < 2).
    const round1Fix = runRRCapture(r.wtDir, ['disposition', optionalKey, '--fixed', '--no-push']);
    assert.equal(round1Fix.status, 0, round1Fix.stderr);
    assert.doesNotMatch(round1Fix.stderr, /preExisting\/optional/);

    // Genuine rework (new content, new sha) → round 2.
    writeFileSync(join(r.wtDir, 'feature.txt'), 'work\nreworked\n');
    r.g(r.wtDir, 'commit', '-qam', 'rework');
    const round2Record = runRRCapture(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    assert.equal(round2Record.status, 0, round2Record.stderr);
    assert.match(
      reviewLines(readFileSync(join(r.mainDir, r.sf), 'utf8'))[0],
      /review-round:2/,
      'sanity: the rework genuinely advanced the round',
    );

    // Round 2, must-fix finding, --fixed: silent (must-fix, any round).
    const round2MustFix = runRRCapture(r.wtDir, [
      'disposition',
      mustFixKey,
      '--fixed',
      '--no-push',
    ]);
    assert.equal(round2MustFix.status, 0, round2MustFix.stderr);
    assert.doesNotMatch(round2MustFix.stderr, /preExisting\/optional/);

    // Round 2, optional finding, --fixed: WARNS, naming the round and the runbook paragraph.
    const round2Optional = runRRCapture(r.wtDir, [
      'disposition',
      optionalKey,
      '--fixed',
      '--no-push',
    ]);
    assert.equal(round2Optional.status, 0, round2Optional.stderr);
    assert.match(round2Optional.stderr, new RegExp(`WARNING — ${optionalKey}`));
    assert.match(round2Optional.stderr, /preExisting\/optional.*review round 2/);
    assert.match(round2Optional.stderr, /Disposition policy Step 0/);
    assert.match(round2Optional.stderr, /warn-only/);
    // The disposition itself is still applied — a warn is never a refusal.
    const after = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    assert.deepEqual(after.findings.find((f) => f.key === optionalKey).disposition, {
      type: 'fixed',
    });
  } finally {
    r.cleanup();
  }
});

test('record-review disposition: plan 3623 item 5 — "still open" only counts findings findingBlocksLand agrees on', () => {
  // An advisory (PLAUSIBLE) finding auto-dispositions to deferred-by-tag on ingest, but --reopen
  // can put it back to undispositioned — the 'advisory-undispositioned' matrix case. classifyFinding
  // alone says 'open' for it (which is what the pre-3623 openCount counted, over-reporting), but it
  // does not block a land (isMustFixFinding is false), so the shared findingBlocksLand predicate
  // must NOT count it — proving openCount is actually wired to findingBlocksLand, not just that the
  // exported function itself is correct (done-worktree-lib.test.mjs covers that in isolation).
  const r = makeFindingsRepo('plan-openct');
  try {
    const findings = [
      {
        file: 'backend/src/a.ts',
        line: 10,
        summary: 'must-fix defect',
        verdict: 'CONFIRMED',
        kind: 'correctness',
      },
      {
        file: 'backend/src/b.ts',
        line: 20,
        summary: 'advisory cleanup',
        verdict: 'PLAUSIBLE',
        kind: 'cleanup',
      },
    ];
    const fjson = join(r.root, 'findings.json');
    writeFileSync(fjson, JSON.stringify(findings));
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    const sidecar = join(r.mainDir, findingsSidecarPath(r.sf));
    const before = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    const mustFixKey = before.findings[0].key;
    const advisoryKey = before.findings[1].key;
    assert.equal(before.findings[0].disposition, null, 'must-fix finding starts undispositioned');
    assert.equal(
      before.findings[1].disposition.type,
      'deferred-by-tag',
      'advisory finding auto-dispositioned on ingest',
    );

    runRR(r.wtDir, ['disposition', mustFixKey, '--fixed', '--no-push']);
    const out = runRR(r.wtDir, ['disposition', advisoryKey, '--reopen', '--no-push']);
    const rec = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    assert.equal(
      rec.findings[1].disposition,
      null,
      'the advisory finding really is undispositioned again',
    );
    assert.match(
      out,
      /\(0 findings still open\)/,
      'an undispositioned ADVISORY finding does not block the land, so it must not count toward "still open"',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 2595: N-arity dispositions — N findings, ONE coord write ────────────────────────────
//
// The measured cost this closes: `disposition` took one key per invocation, so a 9-finding review
// paid 9 full lock+freshen+commit+push cycles (3,517 of 3,908 ops sat in bursts of ≥2 within 120s,
// max run 25 — 20.6% of ALL coord writes). These pin the collapse AND the semantics that must not
// change with it: all-or-nothing application, and a subject the cost measurement can still classify.

// Record N findings and return { sidecar, keys, commitsBefore }.
function seedFindings(r, n) {
  const findings = Array.from({ length: n }, (_, i) => ({
    file: `backend/src/f${i}.ts`,
    line: i + 1,
    summary: `finding ${i}`,
    kind: 'correctness',
  }));
  const fjson = join(r.root, 'findings.json');
  writeFileSync(fjson, JSON.stringify(findings));
  runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
  const sidecar = join(r.mainDir, findingsSidecarPath(r.sf));
  const keys = parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings.map((f) => f.key);
  return { sidecar, keys };
}

const commitCount = (r) => r.g(r.mainDir, 'rev-list', '--count', 'HEAD').trim();

test('record-review disposition: 9 findings in ONE invocation → ONE coord commit, not 9 (plan 2595)', () => {
  const r = makeFindingsRepo('plan-narity');
  try {
    const { sidecar, keys } = seedFindings(r, 9);
    assert.equal(keys.length, 9);
    const before = Number(commitCount(r));
    runRR(r.wtDir, ['disposition', ...keys, '--fixed', '--no-push']);
    assert.equal(
      Number(commitCount(r)) - before,
      1,
      'nine dispositions must cost exactly one coord write',
    );
    const rec = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    for (const f of rec.findings) assert.deepEqual(f.disposition, { type: 'fixed' }, f.key);
    // The cost measurement classifies this write class off the commit SUBJECT — it must still say
    // "disposition", or the class reads as vanished rather than shrunk.
    assert.match(r.g(r.mainDir, 'log', '-1', '--format=%s'), /disposition .*9 findings/);
  } finally {
    r.cleanup();
  }
});

test('record-review disposition --batch: a MIXED round (fixed + plan + wontfix) is still ONE write', () => {
  const r = makeFindingsRepo('plan-batch');
  try {
    const { sidecar, keys } = seedFindings(r, 3);
    const bjson = join(r.root, 'batch.json');
    writeFileSync(
      bjson,
      JSON.stringify([
        { key: keys[0], kind: 'fixed' },
        { key: keys[1], kind: 'wontfix', value: 'cosmetic' },
        { key: keys[2], kind: 'plan', value: '1300' },
      ]),
    );
    const before = Number(commitCount(r));
    runRR(r.wtDir, ['disposition', '--batch', bjson, '--no-push']);
    assert.equal(Number(commitCount(r)) - before, 1);
    const f = parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings;
    assert.deepEqual(f[0].disposition, { type: 'fixed' });
    assert.deepEqual(f[1].disposition, { type: 'wontfix', reason: 'cosmetic' });
    assert.deepEqual(f[2].disposition, { type: 'plan', planId: '1300' });
  } finally {
    r.cleanup();
  }
});

// ── plan 2942: --observed evidence-floor guard on a --plan disposition ──────────────────────
// A --plan deferral without an --observed pointer WARNS (warn-only, exit 0 — the same shape as
// the plan-2864 round-cap warning); with the pointer, no warn, and the pointer rides inside the
// stored disposition object (never a sibling field — buildFindingsRecord would drop it).

test('record-review disposition <key> --plan <id> with NO --observed: warns, still records a bare planId', () => {
  const r = makeFindingsRepo('plan-observed-missing');
  try {
    const { sidecar, keys } = seedFindings(r, 1);
    const res = runRRCapture(r.wtDir, ['disposition', keys[0], '--plan', '9999', '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /latent finding → line, not plan/, 'names the failed default');
    assert.match(res.stderr, /Evidence floor/, 'points at the runbook section');
    assert.match(res.stderr, new RegExp(keys[0]), 'names the affected finding key');
    const rec = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    assert.deepEqual(rec.findings[0].disposition, { type: 'plan', planId: '9999' });
  } finally {
    r.cleanup();
  }
});

test('record-review disposition <key> --plan <id> --observed "…": no warn, pointer stored in the disposition', () => {
  const r = makeFindingsRepo('plan-observed-present');
  try {
    const { sidecar, keys } = seedFindings(r, 1);
    const res = runRRCapture(r.wtDir, [
      'disposition',
      keys[0],
      '--plan',
      '9999',
      '--observed',
      'wave-B b2 clinic-1095',
      '--no-push',
    ]);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(
      res.stderr,
      /latent finding → line, not plan/,
      'a supplied pointer must not warn',
    );
    const rec = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    assert.deepEqual(rec.findings[0].disposition, {
      type: 'plan',
      planId: '9999',
      observed: 'wave-B b2 clinic-1095',
    });
  } finally {
    r.cleanup();
  }
});

test('record-review disposition: several findings deferred to one plan with no pointer → the warn appears AT MOST ONCE', () => {
  const r = makeFindingsRepo('plan-observed-multi');
  try {
    const { keys } = seedFindings(r, 3);
    const res = runRRCapture(r.wtDir, ['disposition', ...keys, '--plan', '9999', '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    const count = (res.stderr.match(/latent finding → line, not plan/g) || []).length;
    assert.equal(count, 1, `warn must appear exactly once — stderr: ${res.stderr}`);
  } finally {
    r.cleanup();
  }
});

test('record-review disposition --batch: a plan entry\'s "observed" is stored; one without still warns but records', () => {
  const r = makeFindingsRepo('plan-observed-batch');
  try {
    const { sidecar, keys } = seedFindings(r, 2);
    const bjson = join(r.root, 'batch.json');
    writeFileSync(
      bjson,
      JSON.stringify([
        { key: keys[0], kind: 'plan', value: '9999', observed: 'live site 2026-08-06' },
        { key: keys[1], kind: 'plan', value: '9998' },
      ]),
    );
    const res = runRRCapture(r.wtDir, ['disposition', '--batch', bjson, '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /latent finding → line, not plan/);
    const f = parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings;
    assert.deepEqual(f[0].disposition, {
      type: 'plan',
      planId: '9999',
      observed: 'live site 2026-08-06',
    });
    assert.deepEqual(f[1].disposition, { type: 'plan', planId: '9998' });
  } finally {
    r.cleanup();
  }
});

test('record-review disposition: --observed alongside --fixed refuses (exit 2), nothing written', () => {
  const r = makeFindingsRepo('plan-observed-badflag');
  try {
    const { sidecar, keys } = seedFindings(r, 1);
    let err;
    try {
      runRR(r.wtDir, [
        'disposition',
        keys[0],
        '--fixed',
        '--observed',
        'wave-B b2 clinic-1095',
        '--no-push',
      ]);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must refuse');
    assert.equal(err.status, 2);
    assert.match(err.stderr, /--observed .* applies only to --plan/);
    for (const f of parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings)
      assert.equal(f.disposition, null, 'nothing was applied on a refusal');
  } finally {
    r.cleanup();
  }
});

test('record-review disposition --batch: "observed" on a non-plan entry refuses (exit 2), nothing written', () => {
  const r = makeFindingsRepo('plan-observed-batchbad');
  try {
    const { sidecar, keys } = seedFindings(r, 1);
    const bjson = join(r.root, 'batch.json');
    writeFileSync(bjson, JSON.stringify([{ key: keys[0], kind: 'fixed', observed: 'wave-B' }]));
    let err;
    try {
      runRR(r.wtDir, ['disposition', '--batch', bjson, '--no-push']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must refuse');
    assert.equal(err.status, 2);
    assert.match(err.stderr, /"observed" applies only to kind "plan"/);
    for (const f of parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings)
      assert.equal(f.disposition, null, 'nothing was applied on a refusal');
  } finally {
    r.cleanup();
  }
});

test("record-review disposition: --observed's VALUE is never mistaken for a finding key", () => {
  // Mirrors "a known flag's VALUE is never mistaken for a finding key" — collide keys[1] (an
  // open finding key) with --observed's value, where a leaky parser would collect it as a key too.
  const r = makeFindingsRepo('plan-observed-flagval');
  try {
    const { sidecar, keys } = seedFindings(r, 2);
    runRR(r.wtDir, ['disposition', keys[0], '--observed', keys[1], '--plan', '1300', '--no-push']);
    const f = parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings;
    assert.deepEqual(f[0].disposition, { type: 'plan', planId: '1300', observed: keys[1] });
    assert.equal(f[1].disposition, null, 'the --observed value must not also be read as a key');
  } finally {
    r.cleanup();
  }
});

// ── plan 2942 review round 1: the six confirmed defects in the --observed seam ────────────

test('plan 2942 review [ac2624]: a NON-STRING batch "observed" REFUSES instead of being coerced', () => {
  // `String(false)` is the truthy pointer "false", which would SUPPRESS the evidence-floor warning
  // and record a latent deferral as observed — inverting the guard this whole plan exists to be.
  for (const bad of [false, true, 0, 1, { source: 'live' }, ['wave-B']]) {
    const r = makeFindingsRepo('plan-observed-nonstring');
    try {
      const { sidecar, keys } = seedFindings(r, 1);
      const bjson = join(r.root, 'batch.json');
      writeFileSync(
        bjson,
        JSON.stringify([{ key: keys[0], kind: 'plan', value: '9999', observed: bad }]),
      );
      let err;
      try {
        runRR(r.wtDir, ['disposition', '--batch', bjson, '--no-push']);
      } catch (e) {
        err = e;
      }
      assert.ok(err, `must refuse observed:${JSON.stringify(bad)}`);
      assert.equal(err.status, 2);
      assert.match(err.stderr, /"observed" must be a string evidence pointer/);
      assert.equal(
        parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings[0].disposition,
        null,
        'nothing applied on a refusal',
      );
    } finally {
      r.cleanup();
    }
  }
});

test('plan 2942 review [4d70b6]: an N-arity round keeps the [observed: …] bracket in the subject/report', () => {
  const r = makeFindingsRepo('plan-observed-narity');
  try {
    const { keys } = seedFindings(r, 2);
    const res = runRRCapture(r.wtDir, [
      'disposition',
      ...keys,
      '--plan',
      '9999',
      '--observed',
      'wave-B b2 clinic-1095',
      '--no-push',
    ]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(
      res.stdout,
      /\[observed: wave-B b2 clinic-1095\]/,
      'the multi-finding report must not drop the pointer to the short form',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 2942 review round 2 ─────────────────────────────────────────────────────────────

test('plan 2942 review round 2: an explicit batch "observed": null REFUSES (only an absent key is omitted)', () => {
  const r = makeFindingsRepo('plan-observed-null');
  try {
    const { sidecar, keys } = seedFindings(r, 1);
    const bjson = join(r.root, 'batch.json');
    writeFileSync(
      bjson,
      JSON.stringify([{ key: keys[0], kind: 'plan', value: '9999', observed: null }]),
    );
    let err;
    try {
      runRR(r.wtDir, ['disposition', '--batch', bjson, '--no-push']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must refuse');
    assert.equal(err.status, 2);
    assert.match(err.stderr, /"observed" must be a string evidence pointer \(got object\)/);
    assert.equal(
      parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings[0].disposition,
      null,
      'nothing applied on a refusal',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2942 review round 2: --key with a MISSING value refuses instead of being silently dropped', () => {
  const r = makeFindingsRepo('plan-key-noval');
  try {
    const { sidecar, keys } = seedFindings(r, 2);
    let err;
    try {
      runRR(r.wtDir, ['disposition', keys[0], '--key', '--fixed', '--no-push']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must refuse');
    assert.equal(err.status, 2);
    assert.match(err.stderr, /--key needs a finding key/);
    for (const f of parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings)
      assert.equal(f.disposition, null, 'a partial round must not be applied');
  } finally {
    r.cleanup();
  }
});

test('plan 2942 review round 3: --slug with a MISSING value refuses instead of falling back to auto-resolve', () => {
  const r = makeFindingsRepo('plan-slug-noval');
  try {
    const { sidecar, keys } = seedFindings(r, 1);
    let err;
    try {
      runRR(r.wtDir, ['disposition', keys[0], '--fixed', '--slug', '--no-push']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must refuse');
    assert.equal(err.status, 2);
    assert.match(err.stderr, /--slug needs a worktree slug/);
    assert.equal(
      parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings[0].disposition,
      null,
      'nothing applied on a refusal',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2942 review round 3: a WHITESPACE-ONLY --observed refuses (parity with the --batch path)', () => {
  const r = makeFindingsRepo('plan-observed-blank');
  try {
    const { sidecar, keys } = seedFindings(r, 1);
    let err;
    try {
      runRR(r.wtDir, ['disposition', keys[0], '--plan', '9999', '--observed', '   ', '--no-push']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must refuse');
    assert.equal(err.status, 2);
    assert.match(err.stderr, /--observed needs an observed-evidence pointer/);
    assert.equal(
      parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings[0].disposition,
      null,
      'a blank pointer must not degrade silently to an unobserved deferral',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2942 review round 3: the rendered description is RETRY-STABLE — requested, not carry-forward-resolved', () => {
  // The deliberate trade-off (round-3 review): record-marker-cli materializes commitMessage(p)
  // ONCE before coordWrite's retry loop while applyIn re-runs per retry, so a description derived
  // from the applied result can leave the log line and the commit subject disagreeing under a
  // contended write. The requested disposition is the retry-stable one, so all three surfaces
  // render from it; the SIDECAR remains the authoritative record and does keep the pointer.
  const r = makeFindingsRepo('plan-observed-retrystable');
  try {
    const { sidecar, keys } = seedFindings(r, 1);
    runRR(r.wtDir, [
      'disposition',
      keys[0],
      '--plan',
      '9999',
      '--observed',
      'wave-B b2 clinic-1095',
      '--no-push',
    ]);
    const res = runRRCapture(r.wtDir, ['disposition', keys[0], '--plan', '9999', '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(
      parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings[0].disposition,
      { type: 'plan', planId: '9999', observed: 'wave-B b2 clinic-1095' },
      'the authoritative record keeps the carried-forward pointer',
    );
    assert.doesNotMatch(
      res.stdout,
      /\[observed:/,
      'the retry-stable description names the REQUESTED disposition, which carried no pointer',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2942 review [674d53]: re-applying the SAME plan without --observed KEEPS the stored pointer', () => {
  const r = makeFindingsRepo('plan-observed-carry');
  try {
    const { sidecar, keys } = seedFindings(r, 1);
    runRR(r.wtDir, [
      'disposition',
      keys[0],
      '--plan',
      '9999',
      '--observed',
      'wave-B b2 clinic-1095',
      '--no-push',
    ]);
    // The ordinary re-run: same plan id, no pointer. The evidence must survive, and it must not warn.
    const res = runRRCapture(r.wtDir, ['disposition', keys[0], '--plan', '9999', '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings[0].disposition, {
      type: 'plan',
      planId: '9999',
      observed: 'wave-B b2 clinic-1095',
    });
    assert.doesNotMatch(
      res.stderr,
      /latent finding → line, not plan/,
      'a carried-forward pointer must not warn',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2942 review [674d53]: re-pointing at a DIFFERENT plan drops the old pointer and warns', () => {
  // The narrow scope of the carry-forward: a new deferral target is a new claim about evidence.
  const r = makeFindingsRepo('plan-observed-repoint');
  try {
    const { sidecar, keys } = seedFindings(r, 1);
    runRR(r.wtDir, ['disposition', keys[0], '--plan', '9999', '--observed', 'wave-B', '--no-push']);
    const res = runRRCapture(r.wtDir, ['disposition', keys[0], '--plan', '8888', '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings[0].disposition, {
      type: 'plan',
      planId: '8888',
    });
    assert.match(res.stderr, /latent finding → line, not plan/);
  } finally {
    r.cleanup();
  }
});

test('plan 2942 review [6990f3]: --batch with a MISSING file value refuses, never falls through to --fixed', () => {
  const r = makeFindingsRepo('plan-batch-noval');
  try {
    const { sidecar, keys } = seedFindings(r, 2);
    let err;
    try {
      runRR(r.wtDir, ['disposition', keys[0], keys[1], '--batch', '--fixed', '--no-push']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must refuse');
    assert.equal(err.status, 2);
    assert.match(err.stderr, /--batch needs a file path/);
    for (const f of parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings)
      assert.equal(f.disposition, null, 'the shared form must not have applied --fixed');
  } finally {
    r.cleanup();
  }
});

test('plan 2942 review [fdb698]: a value flag given TWICE refuses instead of silently taking the first', () => {
  const r = makeFindingsRepo('plan-observed-dupflag');
  try {
    const { sidecar, keys } = seedFindings(r, 1);
    let err;
    try {
      runRR(r.wtDir, [
        'disposition',
        keys[0],
        '--plan',
        '9999',
        '--observed',
        'wave-A',
        '--observed',
        'wave-B',
        '--no-push',
      ]);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must refuse');
    assert.equal(err.status, 2);
    assert.match(err.stderr, /--observed was given more than once/);
    assert.equal(
      parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings[0].disposition,
      null,
      'nothing applied on a refusal',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2942 review [fdb698]: --key stays REPEATABLE (the documented exemption)', () => {
  const r = makeFindingsRepo('plan-key-repeatable');
  try {
    const { sidecar, keys } = seedFindings(r, 2);
    runRR(r.wtDir, ['disposition', '--key', keys[0], '--key', keys[1], '--fixed', '--no-push']);
    for (const f of parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings)
      assert.deepEqual(f.disposition, { type: 'fixed' }, `${f.key} must be applied`);
  } finally {
    r.cleanup();
  }
});

test('plan 2942 review [87257f]: a large unobserved round names a BOUNDED key sample plus a count', () => {
  const r = makeFindingsRepo('plan-observed-bounded');
  try {
    const { keys } = seedFindings(r, 9);
    const bjson = join(r.root, 'batch.json');
    writeFileSync(bjson, JSON.stringify(keys.map((key) => ({ key, kind: 'plan', value: '9999' }))));
    const res = runRRCapture(r.wtDir, ['disposition', '--batch', bjson, '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /\(\+4 more, 9 total\)/, 'the key list must be capped, not unbounded');
    const count = (res.stderr.match(/latent finding → line, not plan/g) || []).length;
    assert.equal(count, 1, 'still at most once per invocation');
  } finally {
    r.cleanup();
  }
});

test('record-review disposition: ONE bad key applies NOTHING and writes nothing (all-or-nothing)', () => {
  const r = makeFindingsRepo('plan-aon');
  try {
    const { sidecar, keys } = seedFindings(r, 3);
    const before = Number(commitCount(r));
    let err;
    try {
      runRR(r.wtDir, ['disposition', keys[0], keys[1], 'bogus', '--fixed', '--no-push']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must refuse');
    assert.equal(err.status, 1);
    assert.match(err.stderr, /no finding with key "bogus"/);
    assert.match(err.stderr, /Nothing was applied/);
    assert.equal(Number(commitCount(r)), before, 'no coord write on a refused batch');
    for (const f of parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings)
      assert.equal(f.disposition, null, `${f.key} must stay open — not half-applied`);
  } finally {
    r.cleanup();
  }
});

test('record-review disposition: the same key twice in one invocation → refuse (exit 2)', () => {
  const r = makeFindingsRepo('plan-dupe');
  try {
    const { keys } = seedFindings(r, 2);
    let err;
    try {
      runRR(r.wtDir, ['disposition', keys[0], keys[1], keys[0], '--fixed', '--no-push']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must refuse a repeated key rather than silently last-wins');
    assert.equal(err.status, 2);
    assert.match(err.stderr, /repeated in one invocation/);
  } finally {
    r.cleanup();
  }
});

test('record-review disposition --batch: a malformed entry refuses before any write', () => {
  const r = makeFindingsRepo('plan-badbatch');
  try {
    const { keys } = seedFindings(r, 2);
    const bjson = join(r.root, 'batch.json');
    // kind=wontfix with no value — the same "reason is mandatory" rule the single form enforces.
    writeFileSync(bjson, JSON.stringify([{ key: keys[0], kind: 'wontfix' }]));
    const before = Number(commitCount(r));
    let err;
    try {
      runRR(r.wtDir, ['disposition', '--batch', bjson, '--no-push']);
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.status, 2);
    assert.equal(Number(commitCount(r)), before);
  } finally {
    r.cleanup();
  }
});

test('record-review disposition: --batch and a bare disposition flag are mutually exclusive', () => {
  const r = makeFindingsRepo('plan-bothforms');
  try {
    const { keys } = seedFindings(r, 1);
    const bjson = join(r.root, 'batch.json');
    writeFileSync(bjson, JSON.stringify([{ key: keys[0], kind: 'fixed' }]));
    let err;
    try {
      runRR(r.wtDir, ['disposition', '--batch', bjson, '--fixed', '--no-push']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'a batch carries its own dispositions — a shared flag is ambiguous');
    assert.equal(err.status, 2);
  } finally {
    r.cleanup();
  }
});

test('record-review disposition: leading keys plus explicit --key all apply, in ONE write', () => {
  const r = makeFindingsRepo('plan-scatter');
  try {
    const { sidecar, keys } = seedFindings(r, 3);
    const before = Number(commitCount(r));
    runRR(r.wtDir, ['disposition', keys[0], keys[1], '--fixed', '--no-push', '--key', keys[2]]);
    assert.equal(Number(commitCount(r)) - before, 1);
    for (const f of parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings)
      assert.deepEqual(f.disposition, { type: 'fixed' }, `${f.key} must be dispositioned`);
  } finally {
    r.cleanup();
  }
});

test('record-review disposition: a bare key AFTER a flag REFUSES instead of being dropped or swept', () => {
  // Round 1 silently DROPPED this key; round 2's "treat it as a key" fix silently SWEPT an
  // unrelated one in (below). Neither is guessable, so the shape is refused outright.
  const r = makeFindingsRepo('plan-trailing');
  try {
    const { sidecar, keys } = seedFindings(r, 2);
    let err;
    try {
      runRR(r.wtDir, ['disposition', keys[0], '--dry', keys[1], '--fixed', '--no-push']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'ambiguous position must refuse, never silently pick one reading');
    assert.equal(err.status, 2);
    assert.match(err.stderr, /appears after a flag/);
    assert.match(err.stderr, /--key/, 'the refusal must name the unambiguous form');
    for (const f of parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings)
      assert.equal(f.disposition, null, 'nothing applied on a refusal');
  } finally {
    r.cleanup();
  }
});

test("record-review disposition: an UNKNOWN flag refuses — its value can't sweep in a real key (review [0])", () => {
  // The round-2 regression, reproduced by the reviewer: `disposition K1 --typo K2 --fixed`
  // dispositioned BOTH, because "an unknown flag's value fails loudly at the no-such-key check"
  // collapses exactly when that value IS a real open key from the same round. Silently RESOLVING
  // a finding nobody named is worse than dropping one — a dropped key still reads as open.
  const r = makeFindingsRepo('plan-sweep');
  try {
    const { sidecar, keys } = seedFindings(r, 2);
    let err;
    try {
      runRR(r.wtDir, ['disposition', keys[0], '--typod-flag', keys[1], '--fixed', '--no-push']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'an unrecognized flag must refuse');
    assert.equal(err.status, 2);
    assert.match(err.stderr, /unrecognized flag "--typod-flag"/);
    const f = parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings;
    assert.equal(f[0].disposition, null, 'the named key must NOT be applied on a refusal');
    assert.equal(f[1].disposition, null, 'and the swept key must certainly not be');
  } finally {
    r.cleanup();
  }
});

test("record-review disposition: a known flag's VALUE is never mistaken for a finding key", () => {
  // --slug's value must not become a key. Made non-vacuous by making that value COLLIDE with a
  // real open finding key: a parser that mis-read it would disposition a finding never named.
  const r = makeFindingsRepo('plan-flagval');
  try {
    const { sidecar, keys } = seedFindings(r, 2);
    // --slug must still name THIS worktree (the plan-1105 branch guard), so collide the other way:
    // pass keys[1] as --plan's value, where a leaky parser would collect it as a key too.
    runRR(r.wtDir, ['disposition', keys[0], '--plan', keys[1], '--no-push']);
    const f = parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings;
    assert.deepEqual(f[0].disposition, { type: 'plan', planId: keys[1] });
    assert.equal(f[1].disposition, null, 'the plan id must not also be read as a key');
  } finally {
    r.cleanup();
  }
});

test('record-review disposition: the single-key commit subject names the key exactly ONCE (review [1])', () => {
  const r = makeFindingsRepo('plan-subject');
  try {
    const { keys } = seedFindings(r, 1);
    runRR(r.wtDir, ['disposition', keys[0], '--fixed', '--no-push']);
    const subject = r.g(r.mainDir, 'log', '-1', '--format=%s');
    assert.match(subject, /disposition .* → fixed/);
    assert.equal(
      subject.split(keys[0]).length - 1,
      1,
      `key must appear once, not twice — got: ${subject.trim()}`,
    );
  } finally {
    r.cleanup();
  }
});

test('record-review disposition: two conflicting disposition flags REFUSE instead of first-match-wins (round-3 review [1])', () => {
  // `--plan 2600 --fixed` used to silently record "deferred to plan 2600" and drop --fixed,
  // because the resolution chain is first-match-wins. Same silent-misdisposition class the argv
  // parse was closed against. Both orders must refuse, and NOTHING may be written.
  const r = makeFindingsRepo('plan-conflict');
  try {
    const { sidecar, keys } = seedFindings(r, 2);
    for (const args of [
      ['disposition', keys[0], '--plan', '2600', '--fixed', '--no-push'],
      ['disposition', keys[0], '--fixed', '--plan', '2600', '--no-push'],
      ['disposition', keys[0], '--reopen', '--fixed', '--no-push'],
    ]) {
      let err;
      try {
        runRR(r.wtDir, args);
      } catch (e) {
        err = e;
      }
      assert.ok(err, `must refuse, not pick one: ${args.join(' ')}`);
      assert.equal(err.status, 2, 'a usage refusal is exit 2');
    }
    const f = parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings;
    assert.equal(f[0].disposition, null, 'a refused invocation must write nothing');
  } finally {
    r.cleanup();
  }
});

test('record-review disposition: an N-arity commit subject is clamped, keeping the class word AND the slug (review [7])', () => {
  // The unclamped 9-key list ran ~200 chars. Both ends of the subject are load-bearing: the cost
  // measurement (plan 2429/2595) classifies this write class off the literal word "disposition",
  // and the slug identifies which land the write belongs to. Only the middle may be cut.
  const r = makeFindingsRepo('plan-clamp');
  try {
    const { keys } = seedFindings(r, 9);
    runRR(r.wtDir, ['disposition', ...keys, '--fixed', '--no-push']);
    const subject = r.g(r.mainDir, 'log', '-1', '--format=%s').trim();
    assert.match(subject, /^chore\(review\): disposition 9 findings/);
    assert.ok(subject.endsWith('for plan-clamp'), `slug must survive the clamp — got: ${subject}`);
    assert.ok(
      subject.length < 160,
      `subject must be clamped, not ~200 chars — got ${subject.length}: ${subject}`,
    );
  } finally {
    r.cleanup();
  }
});

test('record-review disposition: a stray key alongside --batch REFUSES rather than being ignored (review [1])', () => {
  const r = makeFindingsRepo('plan-straykey');
  try {
    const { sidecar, keys } = seedFindings(r, 2);
    const bjson = join(r.root, 'batch.json');
    writeFileSync(bjson, JSON.stringify([{ key: keys[0], kind: 'fixed' }]));
    let err;
    // The stray key goes in the LEADING position, where the argv parser accepts it as an
    // unambiguous key — so this exercises --batch's own mutual-exclusion guard rather than the
    // generic "bare key after a flag" refusal (which the trailing-key test above covers).
    try {
      runRR(r.wtDir, ['disposition', keys[1], '--batch', bjson, '--no-push']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'a key not in the batch file must not be silently dropped');
    assert.equal(err.status, 2);
    assert.match(err.stderr, /remove the extra key/);
    // and nothing was written
    for (const f of parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings)
      assert.equal(f.disposition, null);
  } finally {
    r.cleanup();
  }
});

test('record-review disposition --dry: the preview NAMES the key for the single-key form (review [3])', () => {
  const r = makeFindingsRepo('plan-dry');
  try {
    const { sidecar, keys } = seedFindings(r, 2);
    const out = runRR(r.wtDir, ['disposition', keys[0], '--fixed', '--dry', '--no-push']);
    assert.match(out, new RegExp(keys[0]), 'a --dry preview must say WHICH finding it would set');
    assert.match(out, /fixed/);
    // --dry writes nothing
    for (const f of parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings)
      assert.equal(f.disposition, null);
  } finally {
    r.cleanup();
  }
});

test('record-review disposition --wontfix with no reason → refuse (exit 2)', () => {
  const r = makeFindingsRepo('plan-fd');
  try {
    let err;
    try {
      runRR(r.wtDir, ['disposition', 'abc123', '--wontfix', '--no-push']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must refuse');
    assert.equal(err.status, 2);
    assert.match(err.stderr, /--wontfix needs a reason/);
  } finally {
    r.cleanup();
  }
});

test('record-review disposition <unknown key> → exit 1, lists the recorded keys', () => {
  const r = makeFindingsRepo('plan-fe');
  try {
    const fjson = join(r.root, 'findings.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'x.ts', line: 1, summary: 's' }]));
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    let err;
    try {
      runRR(r.wtDir, ['disposition', 'nope', '--fixed', '--no-push']);
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.status, 1);
    assert.match(err.stderr, /no finding with key "nope"/);
  } finally {
    r.cleanup();
  }
});

test('record-review NITS --findings re-run at same sha PRESERVES prior dispositions (plan 1205 [0])', () => {
  const r = makeFindingsRepo('plan-merge');
  try {
    const findings = [
      { file: 'a.ts', line: 1, summary: 'one' },
      { file: 'b.ts', line: 2, summary: 'two' },
    ];
    const fjson = join(r.root, 'f.json');
    writeFileSync(fjson, JSON.stringify(findings));
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    const sidecar = join(r.mainDir, findingsSidecarPath(r.sf));
    const k0 = parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings[0].key;
    runRR(r.wtDir, ['disposition', k0, '--fixed', '--no-push']);
    // re-record the SAME findings at the SAME sha — must MERGE, not wipe the disposition
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    const rec = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    assert.deepEqual(
      rec.findings[0].disposition,
      { type: 'fixed' },
      'prior disposition preserved on re-record',
    );
    assert.equal(rec.findings[1].disposition, null, 'the other finding stays open');
  } finally {
    r.cleanup();
  }
});

test('record-review disposition --reopen: clears a finding back to open (plan 1205 review [0])', () => {
  const r = makeFindingsRepo('plan-reopen');
  try {
    const fjson = join(r.root, 'f.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'a.ts', line: 1, summary: 'one' }]));
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    const sidecar = join(r.mainDir, findingsSidecarPath(r.sf));
    const key = parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings[0].key;
    runRR(r.wtDir, ['disposition', key, '--wontfix', 'low value', '--no-push']);
    assert.deepEqual(parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings[0].disposition, {
      type: 'wontfix',
      reason: 'low value',
    });
    runRR(r.wtDir, ['disposition', key, '--reopen', '--no-push']);
    assert.equal(
      parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings[0].disposition,
      null,
      '--reopen clears the disposition back to open',
    );
  } finally {
    r.cleanup();
  }
});

test('commitReviewMarker: commits a NEW untracked extraPath even when the marker file is byte-identical to HEAD (plan 1205 [1])', () => {
  // The marker .md is unchanged vs HEAD; the only change is a brand-new UNTRACKED findings sidecar.
  // `git diff --quiet` is blind to untracked files, so the old noop check silently dropped it.
  const r = makeRepoWithSession(SF, 'session entry\nReview: NITS @ deadbeef0\n');
  try {
    const sidecar = SF.replace(/\.md$/, '.findings.json');
    writeFileSync(join(r.dir, sidecar), '{"sha":"deadbeef0","verdict":"NITS","findings":[]}\n');
    const res = commitReviewMarker(r.dir, SF, {
      slug: 'foo',
      verdict: 'NITS',
      sha: 'deadbeef00000000',
      noPush: true,
      extraPaths: [sidecar],
    });
    assert.equal(res.noop, false, 'a new untracked sidecar must NOT be treated as no-op');
    assert.equal(r.g('status', '--porcelain').trim(), '', 'the sidecar was committed — tree clean');
    assert.match(r.g('show', '--name-only', '--format=', 'HEAD'), /\.findings\.json/);
  } finally {
    r.cleanup();
  }
});

test('commitReviewMarker: tolerates a half-land commit (transient index-write) — marker lands + pushes, no throw', () => {
  const r = makeRepoWithSession(SF, 'session entry\n');
  try {
    writeFileSync(join(r.dir, SF), 'session entry\nReview: PASS @ abcdef012\n');
    // inject the transient on the FIRST real commit (git made the commit + moved HEAD, then the index
    // write failed); gitWithLockRetry's retry then hits git's real "nothing to commit" and rethrows —
    // commitReviewMarker must tolerate it (the marker IS at HEAD) and fall through to push.
    let fired = false;
    const _git = (d, a, o) => {
      const out = coordGit(d, a, o); // real git — does the commit
      if (a[0] === 'commit' && !fired) {
        fired = true;
        throw new Error('fatal: repository has been updated, but unable to write new index file.');
      }
      return out;
    };
    const _gitRetry = (dir, args, opts) =>
      gitWithLockRetry(dir, args, { ...opts, _git, delayMs: 1 });
    let pushed = false;
    const res = commitReviewMarker(r.dir, SF, {
      slug: 'foo-plan',
      verdict: 'PASS',
      sha: 'abcdef0123456789',
      _gitRetry,
      _push: () => {
        pushed = true;
      },
    });
    assert.equal(res.noop, false);
    assert.equal(pushed, true, 'after tolerating the half-land, it falls through to push');
    assert.match(
      r.g('log', '-1', '--format=%s'),
      /chore\(review\): record PASS @ abcdef012 for foo-plan/,
      'the marker commit is genuinely at HEAD',
    );
    assert.equal(r.g('status', '--porcelain').trim(), '', 'nothing left uncommitted');
  } finally {
    r.cleanup();
  }
});

// ── plan 1528 A1: repin — mechanical re-pin after a patch-id-identical rebase ──────

// A real main+origin+worktree fixture: sessions layout, a claim session entry naming the
// slug (committed AND pushed so the repin pre-gate's origin/master read sees it), and a
// worktree branch one commit ahead. Mirrors makeRepoWithWorktree but with a bare origin —
// repin's patch-id gate computes both ranges against merge-base(origin/master, tip).
// plan 4021: `sessions` ({ rel: content }) replaces the default single legacy entry; `sf` is the
// first one named.
function makeRepoForRepin(slug, { sessions = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'record-review-repin-'));
  const g = (dir, ...a) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=', ...a],
      { encoding: 'utf8' },
    ).trim();
  const bare = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'ignore' });
  const mainDir = join(root, 'main');
  execFileSync('git', ['init', '-q', '-b', 'master', mainDir], { stdio: 'ignore' });
  writeFileSync(
    join(mainDir, 'coord.config.json'),
    '{"handoffLayout":"sessions","handoffDir":"docs/handoff"}\n',
  );
  const entries = sessions || {
    'docs/handoff/sessions/2026-07-09-session-1.md': `# Session 1\n\nClaimed ${slug}.\n`,
  };
  const sf = Object.keys(entries)[0];
  for (const [rel, content] of Object.entries(entries)) {
    mkdirSync(dirname(join(mainDir, rel)), { recursive: true });
    writeFileSync(join(mainDir, rel), content);
  }
  writeFileSync(join(mainDir, 'shared.txt'), 'line\n');
  g(mainDir, 'add', '-A');
  g(mainDir, 'commit', '-qm', 'init');
  g(mainDir, 'remote', 'add', 'origin', bare);
  g(mainDir, 'push', '-qu', 'origin', 'master');
  const wtDir = join(root, 'wt');
  g(mainDir, 'worktree', 'add', '-q', wtDir, '-b', `worktree-${slug}`);
  writeFileSync(join(wtDir, 'feature.txt'), 'work\n');
  g(wtDir, 'add', 'feature.txt');
  g(wtDir, 'commit', '-qm', 'branch work');
  return {
    root,
    mainDir,
    wtDir,
    sf,
    g,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const runRepin = (cwd, extra = []) =>
  execFileSync('node', [SCRIPT, 'repin', '--no-push', ...extra], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, COORD_MAIN_DIR: '' },
  });

// ── plan 4021 (review fb94f6): write flows CARRY an adopted branch's marker FORWARD ──────────
// The adoption shape: session 4085 recorded this branch's review (marker + findings sidecar);
// an adopting session's claim then minted 4095 for the SAME branch with no markers. Every write
// still targets 4095 (the newest owned entry); before touching it, the flow copies 4085's marker
// line (and sidecar) into it.
const ADOPT_OLD_RR = 'docs/handoff/sessions/2026-09-14-session-4085.md';
const ADOPT_NEW_RR = 'docs/handoff/sessions/2026-09-14-session-4095.md';
const ownedEntry = (n, slug) =>
  `# 2026-09-14 (session ${n} — pick up ${slug})\n\n**Status:** 🔄 IN PROGRESS\n` +
  `**Branch:** \`worktree-${slug}\` · worktree \`.claude/worktrees/${slug}\`\n`;
const rr4021 = (cwd, args) =>
  spawnSync('node', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, COORD_MAIN_DIR: '' },
  });
const rr4021Ok = (cwd, args) => {
  const res = rr4021(cwd, args);
  assert.equal(res.status, 0, `${args.join(' ')} → ${res.status}\n${res.stdout}\n${res.stderr}`);
  return res;
};
const reviewLines = (text) => text.split('\n').filter((l) => l.startsWith('Review:'));
function makeAdoptionRepo(slug) {
  const r = makeRepoForRepin(slug, { sessions: { [ADOPT_OLD_RR]: ownedEntry(4085, slug) } });
  const readMain = (rel) => readFileSync(join(r.mainDir, rel), 'utf8');
  // the adopting claim: a newer owned entry, committed and pushed (so origin-first reads see it)
  const adopt = () => {
    writeFileSync(join(r.mainDir, ADOPT_NEW_RR), ownedEntry(4095, slug));
    r.g(r.mainDir, 'add', '-A');
    r.g(r.mainDir, 'commit', '-qm', 'adopting claim entry');
    r.g(r.mainDir, 'push', '-q', 'origin', 'master');
  };
  const writeFindings = (n) => {
    const fjson = join(r.root, 'findings.json');
    const rows = Array.from({ length: n }, (_, i) => ({
      file: `scripts/f${i}.mjs`,
      line: i + 1,
      summary: `finding ${i}`,
      kind: 'correctness',
    }));
    writeFileSync(fjson, JSON.stringify(rows));
    return fjson;
  };
  return { ...r, readMain, adopt, writeFindings };
}

test('plan 4021 review fb94f6: disposition after an adoption carries the Review marker + findings (dispositions intact) into the newest entry', () => {
  const slug = 'adopt-disposition-4021';
  const r = makeAdoptionRepo(slug);
  try {
    rr4021Ok(r.wtDir, ['BUGS-FOUND', '--findings', r.writeFindings(2), '--no-push']);
    const oldSidecar = findingsSidecarPath(ADOPT_OLD_RR);
    const keys = parseFindingsRecord(r.readMain(oldSidecar)).findings.map((f) => f.key);
    rr4021Ok(r.wtDir, ['disposition', keys[0], '--fixed', '--no-push']);
    const [oldLine] = reviewLines(r.readMain(ADOPT_OLD_RR));
    assert.match(oldLine, /review-round:1/);
    const oldSidecarBefore = r.readMain(oldSidecar);
    r.adopt();

    rr4021Ok(r.wtDir, ['disposition', keys[1], '--wontfix', 'known', '--no-push']);

    assert.deepEqual(
      reviewLines(r.readMain(ADOPT_NEW_RR)),
      [oldLine],
      'the marker line (review-round token included) is carried unaltered into the newest entry',
    );
    const rec = parseFindingsRecord(r.readMain(findingsSidecarPath(ADOPT_NEW_RR)));
    assert.deepEqual(rec.findings.find((f) => f.key === keys[0]).disposition, { type: 'fixed' });
    assert.ok(
      rec.findings.find((f) => f.key === keys[1]).disposition,
      'the new disposition landed',
    );
    assert.equal(r.readMain(oldSidecar), oldSidecarBefore, 'the older entry is never written');
    assert.equal(
      r.g(r.mainDir, 'status', '--porcelain', '--', 'docs/handoff'),
      '',
      'the carried marker + sidecar are committed together',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 4021 review fb94f6: repin after an adoption carries a stale-but-patch-identical marker + sidecar forward and re-pins them in the newest entry', () => {
  const slug = 'adopt-repin-4021';
  const r = makeAdoptionRepo(slug);
  try {
    rr4021Ok(r.wtDir, ['BUGS-FOUND', '--findings', r.writeFindings(1), '--no-push']);
    const oldSidecar = findingsSidecarPath(ADOPT_OLD_RR);
    const [key] = parseFindingsRecord(r.readMain(oldSidecar)).findings.map((f) => f.key);
    rr4021Ok(r.wtDir, ['disposition', key, '--fixed', '--no-push']);
    // make it a LEGACY sha-only marker, the shape repin must actually rewrite across a rebase
    const legacy = r.readMain(ADOPT_OLD_RR).replace(/ patch-id:[0-9a-f]+|patch-id:empty/g, '');
    writeFileSync(join(r.mainDir, ADOPT_OLD_RR), legacy);
    r.g(r.mainDir, 'commit', '-qam', 'legacy marker');
    r.adopt();
    // a pure re-sha of the branch: same content diff, new tip
    r.g(r.wtDir, 'commit', '--amend', '-qm', 'branch work (re-sha)');
    const newSha = r.g(r.wtDir, 'rev-parse', 'HEAD');

    rr4021Ok(r.wtDir, ['repin', '--no-push']);

    const [line] = reviewLines(r.readMain(ADOPT_NEW_RR));
    assert.match(line, new RegExp(`^Review: BUGS-FOUND.* @ ${newSha} patch-id:`));
    // review round 2 (998229/59ba2e): the re-pin moves only sha + patch-id; the round token stays
    assert.match(line, / review-round:1$/);
    const rec = parseFindingsRecord(r.readMain(findingsSidecarPath(ADOPT_NEW_RR)));
    assert.equal(rec.sha, newSha, 'the carried sidecar is re-pinned with its marker');
    assert.deepEqual(rec.findings[0].disposition, { type: 'fixed' });
    assert.equal(r.readMain(ADOPT_OLD_RR), legacy, 'the older entry is never written');
  } finally {
    r.cleanup();
  }
});

test('plan 4021 review fb94f6: a fresh record after an adoption counts its round on from the carried marker instead of restarting at 1', () => {
  const slug = 'adopt-record-4021';
  const r = makeAdoptionRepo(slug);
  try {
    rr4021Ok(r.wtDir, ['NITS', '--no-push']);
    // genuine rework, then a second review round recorded in the SAME (pre-adoption) entry
    writeFileSync(join(r.wtDir, 'feature.txt'), 'work, reworked\n');
    r.g(r.wtDir, 'commit', '-qam', 'rework');
    rr4021Ok(r.wtDir, ['NITS', '--no-push']);
    assert.match(reviewLines(r.readMain(ADOPT_OLD_RR))[0], /review-round:2/);
    r.adopt();

    rr4021Ok(r.wtDir, ['PASS', '--no-push']);

    const lines = reviewLines(r.readMain(ADOPT_NEW_RR));
    assert.equal(lines.length, 1);
    assert.match(
      lines[0],
      /^Review: PASS .*review-round:2/,
      'same tip → the carried round 2 stands',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 4021 review round 2 ─────────────────────────────────────────────────────────────────
test('plan 4021 r2 2321da/30cbc6/58cc37/9d41e4: record and disposition REFUSE, writing nothing, when the marker source halts on a contested entry', () => {
  const slug = 'halt-4021';
  const r = makeAdoptionRepo(slug);
  try {
    rr4021Ok(r.wtDir, ['BUGS-FOUND', '--findings', r.writeFindings(1), '--no-push']);
    const sidecar = findingsSidecarPath(ADOPT_OLD_RR);
    const [key] = parseFindingsRecord(r.readMain(sidecar)).findings.map((f) => f.key);
    // the committed entry is ours, but the working-tree copy --no-push writes names another owner
    const foreign =
      ownedEntry(4085, 'someone-else-4021') +
      reviewLines(r.readMain(ADOPT_OLD_RR)).join('\n') +
      '\n';
    writeFileSync(join(r.mainDir, ADOPT_OLD_RR), foreign);
    const sidecarBefore = r.readMain(sidecar);
    for (const args of [
      ['PASS', '--no-push'],
      ['disposition', key, '--fixed', '--no-push'],
    ]) {
      const res = rr4021(r.wtDir, args);
      assert.notEqual(res.status, 0, `${args.join(' ')} must refuse\n${res.stdout}`);
      assert.match(res.stderr, /could not judge session entry .*session-4085\.md/);
    }
    assert.equal(r.readMain(ADOPT_OLD_RR), foreign, 'the contested entry is not written');
    assert.equal(r.readMain(sidecar), sidecarBefore, 'its sidecar is not dispositioned');
  } finally {
    r.cleanup();
  }
});

test('plan 4021 r2 63f2df/b813aa: a carry refuses when an orphan sidecar already sits beside the newest entry, even if the source has none', () => {
  const slug = 'orphan-4021';
  const r = makeAdoptionRepo(slug);
  try {
    rr4021Ok(r.wtDir, ['PASS', '--no-push']);
    const legacy = r.readMain(ADOPT_OLD_RR).replace(/ patch-id:[0-9a-f]+|patch-id:empty/g, '');
    writeFileSync(join(r.mainDir, ADOPT_OLD_RR), legacy);
    r.g(r.mainDir, 'commit', '-qam', 'legacy marker');
    r.adopt();
    const orphan = findingsSidecarPath(ADOPT_NEW_RR);
    writeFileSync(join(r.mainDir, orphan), JSON.stringify({ sha: 'f'.repeat(40), findings: [] }));
    r.g(r.wtDir, 'commit', '--amend', '-qm', 'branch work (re-sha)');
    const newBefore = r.readMain(ADOPT_NEW_RR);

    const res = rr4021(r.wtDir, ['repin', '--no-push']);

    assert.notEqual(res.status, 0, res.stdout);
    assert.match(res.stderr, /already exists beside the newest session entry/);
    assert.equal(r.readMain(ADOPT_NEW_RR), newBefore, 'no marker was carried');
  } finally {
    r.cleanup();
  }
});

// ── plan 4021 review round 3: an unreadable sidecar is never an absent one ───────────────────
test('plan 4021 r3 5d1618: the carry target probe keeps the shared refusal and its real reason; a dangling link is never absence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rr-4021-r3-'));
  try {
    const toSf = ADOPT_NEW_RR;
    mkdirSync(join(dir, findingsSidecarPath(toSf)), { recursive: true }); // exists, cannot be read
    const plan = planFindingsCarry(dir, ADOPT_OLD_RR, toSf, 'p');
    assert.match(plan.refuse, /could not be read/);
    assert.doesNotMatch(plan.refuse, /already exists beside/);
    // injected errnos: a dangling symlink reads ENOENT while lstat still sees the link
    const enoent = () => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    };
    const dangling = readSidecarStrict(dir, 'x.findings.json', {
      readFile: enoent,
      lstat: () => ({}),
    });
    assert.match(dangling.refuse, /could not be read/);
    assert.deepEqual(
      readSidecarStrict(dir, 'x.findings.json', { readFile: enoent, lstat: enoent }),
      {
        absent: true,
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan 4021 r3 33ce2a: a record REFUSES, writing nothing, when the existing sidecar it counts the round from cannot be read', () => {
  const slug = 'round-unreadable-4021';
  const r = makeRepoForRepin(slug);
  try {
    rr4021Ok(r.wtDir, ['NITS', '--no-push']);
    mkdirSync(join(r.mainDir, findingsSidecarPath(r.sf)), { recursive: true });
    const before = readFileSync(join(r.mainDir, r.sf), 'utf8');
    const res = rr4021(r.wtDir, ['PASS', '--no-push']);
    assert.notEqual(res.status, 0, res.stdout);
    assert.match(res.stderr, /could not be read/);
    assert.equal(
      readFileSync(join(r.mainDir, r.sf), 'utf8'),
      before,
      'the marker is not rewritten',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2743: a dual-pinned marker survives a pure rebase with NO re-pin commit; rework still refuses exit 4', () => {
  const slug = 'repin-fixture';
  const r = makeRepoForRepin(slug);
  try {
    // record PASS at the current branch tip — plan 2743: the marker now carries the
    // rebase-stable range patch-id alongside the sha.
    execFileSync('node', [SCRIPT, 'PASS', '--no-push'], {
      cwd: r.wtDir,
      encoding: 'utf8',
      env: { ...process.env, COORD_MAIN_DIR: '' },
    });
    const shaBefore = r.g(r.wtDir, 'rev-parse', 'HEAD');
    assert.match(
      readFileSync(join(r.mainDir, r.sf), 'utf8'),
      new RegExp(`Review: PASS @ ${shaBefore} patch-id:[0-9a-f]+`),
      'the recorded marker is dual-pinned (sha + patch-id)',
    );

    // master advances on a DISJOINT file (the queue-bypassing sibling commit)…
    writeFileSync(join(r.mainDir, 'shared.txt'), 'line\nmore\n');
    r.g(r.mainDir, 'add', 'shared.txt');
    r.g(r.mainDir, 'commit', '-qm', 'sibling');
    r.g(r.mainDir, 'push', '-q', 'origin', 'master');
    // …and the branch rebases onto it: same content-diff, new sha (the plan-1450 class)
    r.g(r.wtDir, 'fetch', '-q', 'origin', 'master');
    r.g(r.wtDir, 'rebase', '-q', 'origin/master');
    const shaAfter = r.g(r.wtDir, 'rev-parse', 'HEAD');
    assert.notEqual(shaAfter, shaBefore);

    // plan 2743 — the whole point: the rebase does NOT invalidate the marker, so repin is a
    // no-op. Before this, each lap here pushed a commit to master, which advanced master
    // under every other prepping land and forced ITS rebase (326 such commits in one day).
    const commitsBefore = r.g(r.mainDir, 'rev-list', '--count', 'HEAD');
    const out = runRepin(r.wtDir);
    assert.match(out, /no re-pin needed/);
    assert.equal(
      r.g(r.mainDir, 'rev-list', '--count', 'HEAD'),
      commitsBefore,
      'a patch-id-identical rebase emits NO master commit',
    );
    const doc = readFileSync(join(r.mainDir, r.sf), 'utf8');
    assert.match(doc, new RegExp(`Review: PASS @ ${shaBefore}`), 'marker left exactly as recorded');
    assert.ok(!doc.includes(shaAfter), 'no new sha written — nothing to write');

    // and the land's READ side honors it at the rebased tip: the marker is CURRENT by content
    // identity, so the REVIEW_NEEDED seam does not fire (this is what makes the no-op safe).
    const headPatchId = rangePatchId(r.wtDir, shaAfter);
    assert.ok(headPatchId, 'HEAD range patch-id is computable in the fixture');
    assert.equal(parseReviewMarker(doc, shaAfter, headPatchId), 'PASS');
    assert.equal(
      parseReviewMarkerFull(doc, shaAfter, headPatchId)?.rebasePinned,
      true,
      'honored via the rebase-stable fallback, not the sha fast path',
    );

    // re-running is still a clean no-op (idempotent, and still commit-free)
    assert.match(runRepin(r.wtDir), /no re-pin needed/);

    // REWORK: a genuinely-new commit changes the content-diff → refuse exit 4, marker untouched
    writeFileSync(join(r.wtDir, 'feature.txt'), 'work\nreworked\n');
    r.g(r.wtDir, 'add', 'feature.txt');
    r.g(r.wtDir, 'commit', '-qm', 'rework');
    let code = 0;
    try {
      runRepin(r.wtDir);
    } catch (e) {
      code = e.status;
      assert.match(String(e.stderr), /patch-ids differ/);
    }
    assert.equal(code, 4, 'rework refuses with the dedicated exit code (Phase B arm-b signal)');
    const reworkedDoc = readFileSync(join(r.mainDir, r.sf), 'utf8');
    assert.match(
      reworkedDoc,
      new RegExp(`Review: PASS @ ${shaBefore}`),
      'refusal leaves the (now-stale) marker as-is — the land halts honestly',
    );
    // plan 2743: real content change ⇒ the patch-id differs too, so the read-side fallback
    // must NOT rescue it. A changed diff still invalidates the review, exactly as before.
    const reworkHead = r.g(r.wtDir, 'rev-parse', 'HEAD');
    assert.equal(
      parseReviewMarker(reworkedDoc, reworkHead, rangePatchId(r.wtDir, reworkHead)),
      null,
      'content change invalidates the marker on BOTH identities',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 3295: the seed-only carry (operator ruling 2026-08-19, "Review stamp CARRIES across
// seed-data-only commits") — fixture-repo test over a REAL `git diff --name-only`, mirroring
// done-worktree.mjs's makeSeedOnlyDelta wiring (recordedReviewMarker / markerStatusTable) rather
// than faking the path list.
// plan 3961 T2.7b follow-up: a LOCAL constant — isSeedOnlyDelta's seedShardDir has no default any
// more (every caller threads its own configured value explicitly), so this fixture repo's own
// root is named here rather than read off a retired shared constant. Bare literal, no trailing
// slash, same posture as _land-sandbox.mjs's SANDBOX_SEED_SHARD_DIR (never trips
// assert-seed-io-seam.mjs's seed/ + trailing-slash pattern).
const SEED_SHARD_DIR = 'backend/src/data/seed';

test('plan 3295: a review recorded at X is honored at Y for a seed-only X..Y delta (real git diff --name-only); stale once the delta also touches a non-seed path', () => {
  const slug = 'seed-only-carry';
  const r = makeRepoForRepin(slug);
  try {
    execFileSync('node', [SCRIPT, 'PASS', '--no-push'], {
      cwd: r.wtDir,
      encoding: 'utf8',
      env: { ...process.env, COORD_MAIN_DIR: '' },
    });
    const shaX = r.g(r.wtDir, 'rev-parse', 'HEAD');
    const doc = readFileSync(join(r.mainDir, r.sf), 'utf8');
    assert.match(doc, new RegExp(`Review: PASS @ ${shaX}`));

    const diffNameOnly = (from, to) =>
      execFileSync('git', ['-C', r.wtDir, 'diff', '--name-only', `${from}..${to}`], {
        encoding: 'utf8',
      })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    const seedOnlyDelta = (recordedSha, currentSha) =>
      isSeedOnlyDelta(diffNameOnly(recordedSha, currentSha), SEED_SHARD_DIR);

    // Y = X + ONE seed-only commit (a per-clinic shard file under backend/src/data/seed/)
    mkdirSync(join(r.wtDir, 'backend', 'src', 'data', 'seed', 'clinics', 'SE'), {
      recursive: true,
    });
    writeFileSync(
      join(r.wtDir, 'backend', 'src', 'data', 'seed', 'clinics', 'SE', 'clinic-001.json'),
      '{"id":"clinic-001"}\n',
    );
    r.g(r.wtDir, 'add', 'backend/src/data/seed/clinics/SE/clinic-001.json');
    r.g(r.wtDir, 'commit', '-qm', 'seed heal: clinic-001 price fix');
    const shaY = r.g(r.wtDir, 'rev-parse', 'HEAD');

    assert.equal(
      isSeedOnlyDelta(diffNameOnly(shaX, shaY), SEED_SHARD_DIR),
      true,
      'a single seed-file commit is a seed-only delta',
    );
    // headPatchId=null (uncomputable on purpose) so the assertion exercises the seed-only
    // fallback specifically, not the plan-2743 patch-id path.
    const honored = parseReviewMarkerFull(doc, shaY, null, seedOnlyDelta);
    assert.equal(
      honored?.verdict,
      'PASS',
      'the review recorded at X is VALID at the seed-only tip Y',
    );
    assert.equal(honored?.seedOnlyCarried, true);
    assert.equal(
      honored?.rebasePinned,
      undefined,
      'this is the seed-only path, not the rebase path',
    );
    assert.equal(honored?.sha, shaX, 'still reports the sha it was recorded at — honest');
    assert.equal(parseReviewMarker(doc, shaY, null, seedOnlyDelta), 'PASS');

    // Z = Y + ONE non-seed commit (a .py file) — the X..Z delta now carries a non-seed path, so
    // the whole carry is vetoed: today's strict sha/patch-id rule applies, i.e. STALE.
    mkdirSync(join(r.wtDir, 'backend', 'scripts'), { recursive: true });
    writeFileSync(join(r.wtDir, 'backend', 'scripts', 'heal.py'), '# heal script\n');
    r.g(r.wtDir, 'add', 'backend/scripts/heal.py');
    r.g(r.wtDir, 'commit', '-qm', 'add a heal script');
    const shaZ = r.g(r.wtDir, 'rev-parse', 'HEAD');

    assert.equal(
      isSeedOnlyDelta(diffNameOnly(shaX, shaZ), SEED_SHARD_DIR),
      false,
      'a seed commit PLUS a .py commit is no longer seed-only',
    );
    assert.equal(
      parseReviewMarkerFull(doc, shaZ, null, seedOnlyDelta),
      null,
      'a non-seed path anywhere in the delta vetoes the carry — the marker is STALE',
    );
    assert.equal(parseReviewMarker(doc, shaZ, null, seedOnlyDelta), null);

    // and an EMPTY delta (X to X) is today's exact-match sha path, not the carry — the fast path
    // returns 'sha' before seedOnlyDelta is ever consulted, so a predicate that would throw on an
    // empty diff never gets the chance to.
    const boom = () => {
      throw new Error('must not be called for an exact-match sha');
    };
    assert.equal(parseReviewMarker(doc, shaX, null, boom), 'PASS');
    assert.equal(
      markerIdentityMatch(shaX, null, shaX, null, boom),
      'sha',
      'sha-identical ⇒ the fast path, seedOnlyDelta never invoked',
    );
  } finally {
    r.cleanup();
  }
});

// plan 3961 T2.7b: isSeedOnlyDelta's seedShardDir has no default any more — a repo with no
// configured seed root (null) is simply "no path can be seed-only", never a silently-guessed
// vetapp vocabulary.
test('plan 3961 T2.7b: isSeedOnlyDelta with no configured seed shard dir (null) is false even for seed-shaped paths', () => {
  assert.equal(
    isSeedOnlyDelta(['backend/src/data/seed/clinics/SE/clinic-001.json'], null),
    false,
    'no configured seed root ⇒ no carry — the strict sha/patch-id rule stands',
  );
});

test('plan 2743 review-finding [0]: a dispositioned NITS findings sidecar ALSO survives a pure rebase — no FINDINGS_OPEN halt', () => {
  // The sidecar carries its OWN sha-pin, advanced only by the repin's applyExtras. The first cut
  // of this plan short-circuited the repin without giving the sidecar a rebase-stable identity,
  // so the marker survived the rebase and the sidecar did not — the land then halted at
  // FINDINGS_OPEN demanding a fresh review for a branch whose findings were all dispositioned.
  const slug = 'repin-findings';
  const r = makeRepoForRepin(slug);
  try {
    const findingsFile = join(r.root, 'findings.json');
    writeFileSync(
      findingsFile,
      JSON.stringify([{ file: 'scripts/x.mjs', line: 4, summary: 'a nit worth recording' }]),
    );
    execFileSync('node', [SCRIPT, 'NITS', '--findings', findingsFile, '--no-push'], {
      cwd: r.wtDir,
      encoding: 'utf8',
      env: { ...process.env, COORD_MAIN_DIR: '' },
    });
    const sidecarRel = findingsSidecarPath(r.sf);
    const recorded = JSON.parse(readFileSync(join(r.mainDir, sidecarRel), 'utf8'));
    assert.ok(recorded.patchId, 'the sidecar is dual-pinned at record time');
    assert.equal(recorded.findings.length, 1);
    // disposition it, so the ONLY thing that could halt the land later is the sha-pin
    execFileSync(
      'node',
      [SCRIPT, 'disposition', recorded.findings[0].key, '--fixed', '--no-push'],
      { cwd: r.wtDir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: '' } },
    );
    const before = JSON.parse(readFileSync(join(r.mainDir, sidecarRel), 'utf8'));
    assert.ok(before.findings[0].disposition, 'precondition: the finding is dispositioned');

    // pure rebase over a disjoint sibling commit
    writeFileSync(join(r.mainDir, 'shared.txt'), 'line\nmore\n');
    r.g(r.mainDir, 'add', 'shared.txt');
    r.g(r.mainDir, 'commit', '-qm', 'sibling');
    r.g(r.mainDir, 'push', '-q', 'origin', 'master');
    r.g(r.wtDir, 'fetch', '-q', 'origin', 'master');
    r.g(r.wtDir, 'rebase', '-q', 'origin/master');
    const shaAfter = r.g(r.wtDir, 'rev-parse', 'HEAD');
    assert.notEqual(shaAfter, before.sha);

    // repin stays a no-op (that is the point) — and the sidecar must STILL read as current,
    // via its own patch-id, so findingsGate does not halt the land.
    assert.match(runRepin(r.wtDir), /no re-pin needed/);
    const after = parseFindingsRecord(readFileSync(join(r.mainDir, sidecarRel), 'utf8'));
    assert.equal(after.sha, before.sha, 'sidecar untouched — no commit spent on it either');
    const headPatchId = rangePatchId(r.wtDir, shaAfter);
    assert.equal(after.patchId, headPatchId, 'its recorded patch-id still matches HEAD');
    // the gate itself: NITS + this record at the rebased tip must NOT seam
    assert.equal(
      findingsGate('NITS', after, shaAfter, () => true, headPatchId),
      null,
      'no FINDINGS_OPEN halt across a patch-id-identical rebase',
    );
    // and a real content change still halts it, on both identities
    writeFileSync(join(r.wtDir, 'feature.txt'), 'work\nreworked\n');
    r.g(r.wtDir, 'add', 'feature.txt');
    r.g(r.wtDir, 'commit', '-qm', 'rework');
    const reworkHead = r.g(r.wtDir, 'rev-parse', 'HEAD');
    const g = findingsGate(
      'NITS',
      after,
      reworkHead,
      () => true,
      rangePatchId(r.wtDir, reworkHead),
    );
    assert.ok(g, 'a content change still invalidates the findings record');
  } finally {
    r.cleanup();
  }
});

test('plan 2743: a LEGACY sha-only marker still takes the plan-1528 repin path, and that re-pin stamps the patch-id (forward-only migration)', () => {
  const slug = 'repin-legacy';
  const r = makeRepoForRepin(slug);
  try {
    // A marker recorded BEFORE plan 2743: sha only, no patch-id token. Hand-written into the
    // session entry exactly as the pre-2743 writer would have left it — there is no backfill,
    // so this is the shape every already-recorded marker in the repo has.
    const shaBefore = r.g(r.wtDir, 'rev-parse', 'HEAD');
    writeFileSync(
      join(r.mainDir, r.sf),
      `# Session 1\n\nClaimed ${slug}.\nReview: PASS @ ${shaBefore}\n`,
    );
    r.g(r.mainDir, 'add', r.sf);
    r.g(r.mainDir, 'commit', '-qm', 'legacy marker');

    // master advances, branch rebases: same content-diff, new sha
    writeFileSync(join(r.mainDir, 'shared.txt'), 'line\nmore\n');
    r.g(r.mainDir, 'add', 'shared.txt');
    r.g(r.mainDir, 'commit', '-qm', 'sibling');
    r.g(r.mainDir, 'push', '-q', 'origin', 'master');
    r.g(r.wtDir, 'fetch', '-q', 'origin', 'master');
    r.g(r.wtDir, 'rebase', '-q', 'origin/master');
    const shaAfter = r.g(r.wtDir, 'rev-parse', 'HEAD');
    assert.notEqual(shaAfter, shaBefore);

    // A legacy marker has no rebase-stable identity to honor, so the plan-1528 path runs
    // UNCHANGED — it really does re-pin, and really does emit the commit.
    assert.match(runRepin(r.wtDir), /re-pinned PASS/);
    const doc = readFileSync(join(r.mainDir, r.sf), 'utf8');
    assert.match(doc, new RegExp(`Review: PASS @ ${shaAfter}`), 'marker pins the rebased tip');
    assert.ok(!doc.includes(shaBefore), 'old marker replaced, not accumulated');
    // …and the re-pin UPGRADES it: the rewritten marker now carries the patch-id.
    assert.match(
      doc,
      new RegExp(`Review: PASS @ ${shaAfter} patch-id:[0-9a-f]+`),
      'the re-pin stamps the rebase-stable identity — this is the whole migration',
    );

    // so the NEXT rebase costs nothing: dual-pinned now, the short-circuit takes over.
    writeFileSync(join(r.mainDir, 'shared.txt'), 'line\nmore\nagain\n');
    r.g(r.mainDir, 'add', 'shared.txt');
    r.g(r.mainDir, 'commit', '-qm', 'sibling 2');
    r.g(r.mainDir, 'push', '-q', 'origin', 'master');
    r.g(r.wtDir, 'fetch', '-q', 'origin', 'master');
    r.g(r.wtDir, 'rebase', '-q', 'origin/master');
    const commitsBefore = r.g(r.mainDir, 'rev-list', '--count', 'HEAD');
    assert.match(runRepin(r.wtDir), /no re-pin needed/);
    assert.equal(
      r.g(r.mainDir, 'rev-list', '--count', 'HEAD'),
      commitsBefore,
      'a marker re-pins at most ONCE — after that every rebase is commit-free',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 1528: repin with no marker recorded exits 3 cheaply (the spine calls it speculatively)', () => {
  const r = makeRepoForRepin('repin-nomarker');
  try {
    let code = 0;
    try {
      runRepin(r.wtDir);
    } catch (e) {
      code = e.status;
      assert.match(String(e.stderr), /no Review: marker/);
    }
    assert.equal(code, 3);
  } finally {
    r.cleanup();
  }
});

// ── plan 1775: disposition carry across a sha bump on a RE-RECORD (repin's sibling:
// the 1712 incident re-recorded --findings at the post-recovery sha, which silently
// dropped every disposition because the plan-1205 merge was same-sha-gated) ─────────

// spawnSync variant of runRR: the carry/refuse messages go to stderr on a ZERO exit,
// which execFileSync does not surface — spawnSync returns both streams either way.
const runRRCapture = (cwd, args) =>
  spawnSync('node', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, COORD_MAIN_DIR: '' },
  });

// plan 2891 T3 SUPERSEDES the pre-2891 shape of this case. Re-recording a byte-identical review
// across a pure rebase used to spend a fresh record commit whose only effect was to re-stamp the
// sha — the plan-2499 churn (153 identical records, 22s apart). It is now recognised as the same
// review and handed to the re-pin path, which for a marker+sidecar already carrying HEAD's range
// patch-id correctly writes NOTHING. The plan-1775 GUARANTEE is unchanged and asserted below in
// its stronger form: the dispositions survive the sha bump. What changed is the cost.
test('plan 2891 T3 (was plan 1775): a byte-identical re-record after a PURE rebase is a re-pin, not a new record — dispositions still survive', () => {
  const r = makeRepoForRepin('carry-auto');
  try {
    const fjson = join(r.root, 'f.json');
    writeFileSync(
      fjson,
      JSON.stringify([
        { file: 'a.ts', line: 1, summary: 'one' },
        { file: 'b.ts', line: 2, summary: 'two' },
      ]),
    );
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    const sidecar = join(r.mainDir, findingsSidecarPath(r.sf));
    const before = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    const k0 = before.findings[0].key;
    runRR(r.wtDir, ['disposition', k0, '--fixed', '--no-push']);
    const oldSha = parseFindingsRecord(readFileSync(sidecar, 'utf8')).sha;

    // master advances on a disjoint file; the branch rebases → same content-diff, new sha
    writeFileSync(join(r.mainDir, 'shared.txt'), 'line\nmore\n');
    r.g(r.mainDir, 'add', 'shared.txt');
    r.g(r.mainDir, 'commit', '-qm', 'sibling');
    r.g(r.mainDir, 'push', '-q', 'origin', 'master');
    r.g(r.wtDir, 'fetch', '-q', 'origin', 'master');
    r.g(r.wtDir, 'rebase', '-q', 'origin/master');
    const newSha = r.g(r.wtDir, 'rev-parse', 'HEAD');
    assert.notEqual(newSha, oldSha, 'the rebase really did re-sha the branch');

    // re-record the same raw findings export (no disposition fields) at the NEW sha
    const res = runRRCapture(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /re-record of the SAME review, not a new round/);
    const rec = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    assert.equal(rec.sha, oldSha, 'no fresh record was written — the sidecar is untouched');
    assert.deepEqual(
      rec.findings[0].disposition,
      { type: 'fixed' },
      'disposition survived the sha bump — no manual re-disposition pass',
    );
    assert.equal(rec.findings[1].disposition, null, 'the still-open finding stays open');
    // …and it survives because the record is still CURRENT at the rebased tip by its patch-id,
    // which is the whole reason skipping the write is safe rather than merely cheap.
    assert.equal(
      markerIdentityMatch(rec.sha, rec.patchId, newSha, rangePatchId(r.wtDir, newSha)),
      'patch-id',
      'the untouched record still gates as current at the rebased tip (findingsRecordIsCurrent wraps exactly this)',
    );
  } finally {
    r.cleanup();
  }
});

// The plan-1775 AUTO-CARRY itself stays live for every re-record T3 does NOT swallow: a
// patch-identical re-sha whose finding set genuinely CHANGED is still a real record, and the
// surviving keys still carry their dispositions across the sha bump.
test('plan 1775: auto-carry still fires on a patch-identical re-sha whose finding SET changed', () => {
  const r = makeRepoForRepin('carry-auto-changed');
  try {
    const fjson = join(r.root, 'f.json');
    writeFileSync(
      fjson,
      JSON.stringify([
        { file: 'a.ts', line: 1, summary: 'one' },
        { file: 'b.ts', line: 2, summary: 'two' },
      ]),
    );
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    const sidecar = join(r.mainDir, findingsSidecarPath(r.sf));
    const k0 = parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings[0].key;
    runRR(r.wtDir, ['disposition', k0, '--fixed', '--no-push']);

    writeFileSync(join(r.mainDir, 'shared.txt'), 'line\nmore\n');
    r.g(r.mainDir, 'add', 'shared.txt');
    r.g(r.mainDir, 'commit', '-qm', 'sibling');
    r.g(r.mainDir, 'push', '-q', 'origin', 'master');
    r.g(r.wtDir, 'fetch', '-q', 'origin', 'master');
    r.g(r.wtDir, 'rebase', '-q', 'origin/master');
    const newSha = r.g(r.wtDir, 'rev-parse', 'HEAD');

    // a THIRD finding appears — same content, different review payload ⇒ a genuine re-record
    writeFileSync(
      fjson,
      JSON.stringify([
        { file: 'a.ts', line: 1, summary: 'one' },
        { file: 'b.ts', line: 2, summary: 'two' },
        { file: 'c.ts', line: 3, summary: 'three' },
      ]),
    );
    const res = runRRCapture(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /re-record of the SAME review/);
    assert.match(res.stderr, /carrying 1 disposition\(s\) forward .* \(patch-id-identical re-sha/);
    const rec = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    assert.equal(rec.sha, newSha, 'record re-pinned to the new sha');
    assert.equal(rec.findings.length, 3);
    assert.deepEqual(rec.findings[0].disposition, { type: 'fixed' }, 'disposition carried');
  } finally {
    r.cleanup();
  }
});

test('plan 1775: re-record after REWORK warns + drops by default; --carry-dispositions carries', () => {
  const r = makeRepoForRepin('carry-flag');
  try {
    const fjson = join(r.root, 'f.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'a.ts', line: 1, summary: 'one' }]));
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    const sidecar = join(r.mainDir, findingsSidecarPath(r.sf));
    const key = parseFindingsRecord(readFileSync(sidecar, 'utf8')).findings[0].key;
    runRR(r.wtDir, ['disposition', key, '--wontfix', 'known', '--no-push']);

    // content-CHANGING recovery (the LAND_BLOCKED_HOLDING shape): patch-ids now differ
    writeFileSync(join(r.wtDir, 'feature.txt'), 'work\nconflict resolved\n');
    r.g(r.wtDir, 'add', 'feature.txt');
    r.g(r.wtDir, 'commit', '-qm', 'conflict resolution');

    // default: the refused carry is LOUD (--dry so the sidecar keeps its disposition for the
    // flag leg below — the warning fires from the same prepare() the real write uses)
    const dry = runRRCapture(r.wtDir, ['NITS', '--findings', fjson, '--dry']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stderr, /WARNING — the prior findings record/);
    assert.match(dry.stderr, /will NOT carry/);
    assert.match(dry.stderr, /--carry-dispositions/);

    // explicit --carry-dispositions: same review round asserted → carries despite the rework
    const res = runRRCapture(r.wtDir, [
      'NITS',
      '--findings',
      fjson,
      '--carry-dispositions',
      '--no-push',
    ]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /carrying 1 disposition\(s\) forward .* \(--carry-dispositions/);
    const rec = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    assert.equal(rec.sha, r.g(r.wtDir, 'rev-parse', 'HEAD'), 'record pinned to the rework sha');
    assert.deepEqual(rec.findings[0].disposition, { type: 'wontfix', reason: 'known' });

    // feed-the-current-sidecar route (review 1775 [1]): the payload's EXPLICIT dispositions win
    // the merge regardless of the carry gate, so nothing is at risk — no flag needed, no warning.
    writeFileSync(join(r.wtDir, 'feature.txt'), 'work\nconflict resolved\nmore rework\n');
    r.g(r.wtDir, 'add', 'feature.txt');
    r.g(r.wtDir, 'commit', '-qm', 'second rework');
    const res2 = runRRCapture(r.wtDir, ['NITS', '--findings', sidecar, '--no-push']);
    assert.equal(res2.status, 0, res2.stderr);
    assert.ok(
      !/will NOT carry/.test(res2.stderr),
      'no false will-NOT-carry warning when the payload already carries explicit dispositions',
    );
    const rec2 = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    assert.equal(rec2.sha, r.g(r.wtDir, 'rev-parse', 'HEAD'));
    assert.deepEqual(rec2.findings[0].disposition, { type: 'wontfix', reason: 'known' });
  } finally {
    r.cleanup();
  }
});

// ── plan 2864: the content-distinct review-round counter + cap warning ────────────
//
// The round lives in the Review marker every verdict writes. These tests reuse the
// makeRepoForRepin harness and the rework/rebase shapes plans 1528/1775 already established: a
// genuine content change (a new commit whose diff isn't patch-id-identical to what came before)
// is "content-distinct" and increments; a pure rebase or a same-sha re-record does not.

test('review rounds: clean PASS records reach the cap without a findings sidecar', () => {
  const slug = 'rounds-pass-only';
  const r = makeRepoForRepin(slug);
  try {
    let last;
    for (let round = 1; round <= 4; round++) {
      if (round > 1) {
        writeFileSync(join(r.wtDir, 'feature.txt'), `work\npass-round-${round}\n`);
        r.g(r.wtDir, 'add', 'feature.txt');
        r.g(r.wtDir, 'commit', '-qm', `pass rework ${round}`);
      }
      last = runRRCapture(r.wtDir, ['PASS', '--no-push']);
      assert.equal(last.status, 0, last.stderr);
    }

    const session = readFileSync(join(r.mainDir, r.sf), 'utf8');
    assert.match(session, /Review: PASS .* review-round:4$/m);
    assert.equal(
      existsSync(join(r.mainDir, findingsSidecarPath(r.sf))),
      false,
      'PASS writes no findings sidecar, so the marker must be the counter source',
    );
    assert.match(last.stderr, /delta round 3 of 3, the last sanctioned one/);

    const warnings = [];
    assert.equal(
      warnIfReviewRoundCapReached(
        r.mainDir,
        slug,
        { sessionsDir: 'docs/handoff/sessions' },
        {
          warn: (message) => warnings.push(message),
          findSessionFn: () => r.sf,
          readCandidatesFn: () => [session],
        },
      ),
      4,
    );
    assert.match(warnings[0], /launching round 5 is beyond the 3-delta-round cap/);
  } finally {
    r.cleanup();
  }
});

// A single content-distinct re-record: append unique content to feature.txt in wtDir and commit,
// so the branch's content-diff vs origin/master changes (patch-ids differ from the prior record —
// genuine rework, never a rebase). Then re-record NITS with the same findings file. No
// dispositions are set anywhere in this suite, so atRisk.length stays 0 throughout and the
// disposition-carry gate never fires — these tests isolate the round counter from that machinery.
// A monotonic counter, not Math.random(): the only property the fixture needs is that each
// rework writes content DIFFERENT from the last (so the patch-ids differ and the record reads
// as genuine rework). A counter gives that deterministically, so a failure here reproduces
// byte-for-byte instead of depending on the draw.
let reworkSeq = 0;

function reworkAndReRecord(r, fjson, extra = []) {
  reworkSeq += 1;
  writeFileSync(join(r.wtDir, 'feature.txt'), `work\nrework-${reworkSeq}\n`);
  r.g(r.wtDir, 'add', 'feature.txt');
  r.g(r.wtDir, 'commit', '-qm', 'rework');
  return runRRCapture(r.wtDir, ['NITS', '--findings', fjson, '--no-push', ...extra]);
}

// plan 4078 fix round 1 (gpt-review keys 99ea44/f0e216): the T1 fix-brief gate diffs the fix delta
// FROM the marker's sha, so that sha must come from the same LINE-ANCHORED read `recordedReviewRound`
// uses — not from the unanchored `parseReviewMarkerAny`, which happily matches marker-shaped text
// quoted mid-prose. `recordedReviewRound`'s own header already warns about exactly this input
// ("rejects prose that merely QUOTES marker-shaped text"), so the round and the sha have to agree on
// which line is the real marker or the gate measures a delta from a sha nothing ever reviewed.
test('plan 4078: the marker sha is read line-anchored, so quoted marker-shaped prose cannot supply it', () => {
  const realSha = 'b451012c6492cd3bbb32227fe736a15d6960e4c4';
  const quotedSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  // The quoted line comes SECOND: a last-match-wins reader that is not line-anchored returns the
  // decoy, so this ordering is what makes the assertion load-bearing rather than incidental.
  const content = [
    `Review: NITS @ ${realSha} patch-id:abc123 review-round:2`,
    `Note: an earlier handoff quoted a marker: Review: PASS @ ${quotedSha} review-round:9`,
  ].join('\n');
  assert.equal(recordedReviewMarkerSha(content), realSha);
  // The round reader and the sha reader must agree on which line is the marker — 2 from the real
  // line, never 9 from the quoted one.
  assert.equal(recordedReviewRound(content), 2);
  assert.equal(recordedReviewMarkerSha('no marker here at all'), null);
});

test('plan 2864: first record stamps review-round:1 only in the marker', () => {
  const r = makeRepoForRepin('rounds-first');
  try {
    const fjson = join(r.root, 'f.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'a.ts', line: 1, summary: 'one' }]));
    const res = runRRCapture(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    const sidecar = join(r.mainDir, findingsSidecarPath(r.sf));
    assert.equal(recordedReviewRound(readFileSync(join(r.mainDir, r.sf), 'utf8')), 1);
    assert.equal(
      'rounds' in JSON.parse(readFileSync(sidecar, 'utf8')),
      false,
      'the findings sidecar is not a second counter',
    );
    assert.doesNotMatch(res.stderr, /Stopping rule/);
  } finally {
    r.cleanup();
  }
});

test('plan 2864: a content-distinct re-record increments rounds', () => {
  const r = makeRepoForRepin('rounds-increment');
  try {
    const fjson = join(r.root, 'f.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'a.ts', line: 1, summary: 'one' }]));
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    assert.equal(recordedReviewRound(readFileSync(join(r.mainDir, r.sf), 'utf8')), 1);

    const res = reworkAndReRecord(r, fjson);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(recordedReviewRound(readFileSync(join(r.mainDir, r.sf), 'utf8')), 2);
  } finally {
    r.cleanup();
  }
});

test('plan 2864: a same-sha re-record does NOT increment rounds', () => {
  const r = makeRepoForRepin('rounds-samesha');
  try {
    const fjson = join(r.root, 'f.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'a.ts', line: 1, summary: 'one' }]));
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    assert.equal(recordedReviewRound(readFileSync(join(r.mainDir, r.sf), 'utf8')), 1);

    // no new commit — re-record at the SAME HEAD
    const res = runRRCapture(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(recordedReviewRound(readFileSync(join(r.mainDir, r.sf), 'utf8')), 1);
  } finally {
    r.cleanup();
  }
});

// plan 2891 T3 narrows how this case is reached: a pure rebase that re-records the SAME payload
// no longer writes at all, so "does not increment rounds" is now enforced one step earlier — by
// there being no record. The counter invariant is unchanged and still asserted.
test('plan 2864 + 2891 T3: a patch-identical cross-sha re-record (pure rebase) writes nothing and leaves rounds at 1', () => {
  const r = makeRepoForRepin('rounds-rebase');
  try {
    const fjson = join(r.root, 'f.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'a.ts', line: 1, summary: 'one' }]));
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    const sidecar = join(r.mainDir, findingsSidecarPath(r.sf));
    const first = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    assert.equal(recordedReviewRound(readFileSync(join(r.mainDir, r.sf), 'utf8')), 1);

    // master advances on a disjoint file; the branch rebases → same content-diff, new sha
    writeFileSync(join(r.mainDir, 'shared.txt'), 'line\nmore\n');
    r.g(r.mainDir, 'add', 'shared.txt');
    r.g(r.mainDir, 'commit', '-qm', 'sibling');
    r.g(r.mainDir, 'push', '-q', 'origin', 'master');
    r.g(r.wtDir, 'fetch', '-q', 'origin', 'master');
    r.g(r.wtDir, 'rebase', '-q', 'origin/master');

    const res = runRRCapture(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /re-record of the SAME review, not a new round/);
    const rec = parseFindingsRecord(readFileSync(sidecar, 'utf8'));
    assert.equal(
      rec.sha,
      first.sha,
      'no record written — the sidecar still pins the pre-rebase tip',
    );
    assert.equal(
      recordedReviewRound(readFileSync(join(r.mainDir, r.sf), 'utf8')),
      1,
      'pure rebase ⇒ not content-distinct, no increment',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2864: rounds==4 prints the at-cap warning on stderr; exit code and blocking are unchanged', () => {
  const r = makeRepoForRepin('rounds-atcap');
  try {
    const fjson = join(r.root, 'f.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'a.ts', line: 1, summary: 'one' }]));
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']); // round 1
    reworkAndReRecord(r, fjson); // round 2
    reworkAndReRecord(r, fjson); // round 3
    const res = reworkAndReRecord(r, fjson); // round 4 — at the cap
    assert.equal(res.status, 0, res.stderr);
    assert.equal(recordedReviewRound(readFileSync(join(r.mainDir, r.sf), 'utf8')), 4);
    assert.match(res.stderr, /delta round 3 of 3, the last sanctioned one/);
    assert.match(res.stderr, /docs\/runbooks\/review-calibration\.md § Stopping rule/);
    assert.doesNotMatch(res.stderr, /BEYOND/);
  } finally {
    r.cleanup();
  }
});

test('plan 2864: rounds>=5 prints the BEYOND warning on stderr; exit code and blocking are unchanged', () => {
  const r = makeRepoForRepin('rounds-beyond');
  try {
    const fjson = join(r.root, 'f.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'a.ts', line: 1, summary: 'one' }]));
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']); // round 1
    reworkAndReRecord(r, fjson); // round 2
    reworkAndReRecord(r, fjson); // round 3
    reworkAndReRecord(r, fjson); // round 4 — at the cap
    const res = reworkAndReRecord(r, fjson); // round 5 — beyond the cap
    assert.equal(res.status, 0, res.stderr);
    assert.equal(recordedReviewRound(readFileSync(join(r.mainDir, r.sf), 'utf8')), 5);
    assert.match(res.stderr, /BEYOND the 3-delta-round/);
    assert.match(res.stderr, /docs\/runbooks\/review-calibration\.md § Stopping rule/);
  } finally {
    r.cleanup();
  }
});

test('plan 2864: a legacy marker with no round token is round 1, then increments normally', () => {
  const r = makeRepoForRepin('rounds-legacy');
  try {
    const fjson = join(r.root, 'f.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'a.ts', line: 1, summary: 'one' }]));
    runRR(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    const sidecar = join(r.mainDir, findingsSidecarPath(r.sf));
    const session = join(r.mainDir, r.sf);

    // Hand-strip the token to simulate a pre-counter marker. The findings sidecar remains
    // untouched and counter-free: there is only one source to migrate.
    writeFileSync(session, readFileSync(session, 'utf8').replace(/ review-round:\d+\b/, ''));
    r.g(r.mainDir, 'add', r.sf);
    r.g(r.mainDir, 'commit', '-qm', 'strip review round token (legacy fixture)');
    r.g(r.mainDir, 'push', '-q', 'origin', 'master');
    r.g(r.wtDir, 'fetch', '-q', 'origin', 'master');

    assert.equal(recordedReviewRound(readFileSync(session, 'utf8')), 1);
    assert.equal('rounds' in JSON.parse(readFileSync(sidecar, 'utf8')), false);

    const res = reworkAndReRecord(r, fjson);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      recordedReviewRound(readFileSync(session, 'utf8')),
      2,
      'legacy token absent ⇒ treated as round 1, then incremented for content-distinct re-record',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 2838: the resolver can no longer hijack (or overwrite) a sibling's findings sidecar ──
//
// Observed 2026-08-04: session 2697 ran record-review for plan 2808 from its own worktree and the
// tool reported "recorded BUGS-FOUND … in docs/handoff/sessions/2026-08-04-session-2698.findings.json"
// — a DIFFERENT session's sidecar. The grep's pathspec was the whole sessions dir, 2698's sidecar
// merely QUOTED 2808's slug (2816 is a plan about worktree-lock behaviour, so naming a live sibling
// branch is its normal subject matter), and the higher session number won the most-recent tiebreak.
// The write is a whole-file replace: 2816's 19 dispositioned findings became 2808's 39 open ones,
// while 2808's own entry got no `Review:` marker at all and would have halted REVIEW_NEEDED.
//
// Two sessions, the newer one's sidecar quoting the older one's slug — end-to-end through the real
// CLI, since the bug lived in the seam between the grep, the ranker and the sidecar write.
function makeTwoSessionRepo(mySlug, siblingSlug) {
  const root = mkdtempSync(join(tmpdir(), 'record-review-2838-'));
  const g = (dir, ...a) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=', ...a],
      { encoding: 'utf8' },
    ).trim();
  const mainDir = join(root, 'main');
  execFileSync('git', ['init', '-q', '-b', 'master', mainDir], { stdio: 'ignore' });
  writeFileSync(
    join(mainDir, 'coord.config.json'),
    '{"handoffLayout":"sessions","handoffDir":"docs/handoff"}\n',
  );
  const dir = 'docs/handoff/sessions';
  const mine = `${dir}/2026-08-04-session-2697.md`;
  const sibling = `${dir}/2026-08-04-session-2698.md`;
  const siblingSidecar = `${dir}/2026-08-04-session-2698.findings.json`;
  mkdirSync(join(mainDir, dir), { recursive: true });
  const entry = (n, slug) =>
    `# 2026-08-04 (session ${n} — pick up ${slug})\n\n` +
    `**Status:** 🔄 IN PROGRESS\n` +
    `**Branch:** \`worktree-${slug}\` · worktree \`.claude/worktrees/${slug.slice(0, 20)}\`\n`;
  writeFileSync(join(mainDir, mine), entry(2697, mySlug));
  // The sibling is NEWER (2698 > 2697) — under the old resolver its sidecar out-ranked my entry.
  writeFileSync(join(mainDir, sibling), entry(2698, siblingSlug));
  // …and its sidecar QUOTES my slug in a finding summary, exactly as review findings do.
  writeFileSync(
    join(mainDir, siblingSidecar),
    JSON.stringify(
      {
        sha: 'f73227f3af18f73227f3af18f73227f3af18f732',
        slug: siblingSlug,
        verdict: 'NITS',
        findings: [
          {
            key: 'sibkey1',
            file: 'scripts/x.mjs',
            line: 4,
            summary: `held the lock while ${mySlug} was live`,
            verdict: null,
            kind: null,
            disposition: { type: 'fixed' },
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(mainDir, 'shared.txt'), 'line\n');
  g(mainDir, 'add', '-A');
  g(mainDir, 'commit', '-qm', 'init: two sessions + the sibling sidecar');
  const wtDir = join(root, 'wt');
  g(mainDir, 'worktree', 'add', '-q', wtDir, '-b', `worktree-${mySlug}`);
  writeFileSync(join(wtDir, 'feature.txt'), 'work\n');
  g(wtDir, 'add', 'feature.txt');
  g(wtDir, 'commit', '-qm', 'branch work');
  return {
    root,
    mainDir,
    wtDir,
    mine,
    sibling,
    siblingSidecar,
    g,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('plan 2838: a sibling sidecar quoting my slug does NOT capture my record — marker lands on my own entry, their sidecar is untouched', () => {
  const mySlug = '2808-Pipe-stage7-consensus-machinery-integrity';
  const r = makeTwoSessionRepo(mySlug, '2816-Coord-worktree-lock-keep-hot');
  try {
    const before = readFileSync(join(r.mainDir, r.siblingSidecar), 'utf8');
    const fjson = join(r.root, 'f.json');
    writeFileSync(
      fjson,
      JSON.stringify([{ file: 'backend/src/a.ts', line: 7, summary: 'my own finding' }]),
    );
    const res = runRRCapture(r.wtDir, ['BUGS-FOUND', '--findings', fjson, '--no-push']);
    assert.equal(res.status, 0, res.stderr);

    // 1. the marker landed on MY entry (the pre-fix run left this file with no Review: line)
    const mineTxt = readFileSync(join(r.mainDir, r.mine), 'utf8');
    assert.match(mineTxt, /Review: BUGS-FOUND @ /, 'my own entry carries the marker');
    assert.doesNotMatch(
      readFileSync(join(r.mainDir, r.sibling), 'utf8'),
      /Review: BUGS-FOUND/,
      "the sibling's entry was not written",
    );
    // 2. …and the report names MY sidecar, not theirs
    assert.match(res.stdout + res.stderr, /2026-08-04-session-2697/);
    assert.doesNotMatch(res.stdout, /session-2698\.findings\.json/);

    // 3. the sibling's dispositioned findings survive BYTE-IDENTICAL (the clobber, pinned)
    assert.equal(
      readFileSync(join(r.mainDir, r.siblingSidecar), 'utf8'),
      before,
      "the sibling's sidecar is untouched",
    );

    // 4. my findings went to my OWN sidecar, stamped with my slug
    const rec = parseFindingsRecord(
      readFileSync(join(r.mainDir, findingsSidecarPath(r.mine)), 'utf8'),
    );
    assert.equal(rec.slug, mySlug, 'the sidecar now names its owner');
    assert.equal(rec.findings.length, 1);
    assert.equal(rec.findings[0].summary, 'my own finding');
  } finally {
    r.cleanup();
  }
});

test('plan 2838: recording onto a sidecar owned by a DIFFERENT plan is REFUSED, however the entry resolved', () => {
  // Defence in depth: even with the resolver right, a whole-file replace of someone else's
  // dispositioned findings must not be reachable — here the operator hands record-review a --slug
  // whose own entry does not exist, and the resolver's ONE legacy-mention fallback lands on the
  // sibling's entry, so the sidecar's own ownership stamp is the last line of defence.
  const r = makeTwoSessionRepo('2808-Pipe-stage7', '2816-Coord-lock');
  try {
    // Make the sibling entry the only resolvable one for a third slug: a legacy-shaped entry that
    // mentions it, with the sibling's sidecar already in place and owned by 2816.
    const legacy = 'docs/handoff/sessions/2026-08-04-session-2698.md';
    writeFileSync(
      join(r.mainDir, legacy),
      `# 2026-08-04 (session 2698)\n\nclaim: 2816-Coord-lock\nalso ran beside 2816-Coord-lock\n`,
    );
    r.g(r.mainDir, 'add', '-A');
    r.g(r.mainDir, 'commit', '-qm', 'legacy-shape the sibling entry');
    const before = readFileSync(join(r.mainDir, r.siblingSidecar), 'utf8');
    // A worktree for a slug whose sidecar is owned by someone else.
    const wt2 = join(r.root, 'wt2');
    r.g(r.mainDir, 'worktree', 'add', '-q', wt2, '-b', 'worktree-2816-Coord-lock');
    writeFileSync(join(wt2, 'h.txt'), 'x\n');
    r.g(wt2, 'add', 'h.txt');
    r.g(wt2, 'commit', '-qm', 'work');
    const fjson = join(r.root, 'g.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'a.ts', line: 1, summary: 'unrelated' }]));

    // sanity: this resolves to the sibling entry, whose sidecar is owned by 2816 — same owner,
    // so it is ALLOWED. Now flip the sidecar's owner to a third plan and it must refuse.
    writeFileSync(
      join(r.mainDir, r.siblingSidecar),
      before.replace('"slug": "2816-Coord-lock"', '"slug": "9999-Someone-else"'),
    );
    r.g(r.mainDir, 'add', '-A');
    r.g(r.mainDir, 'commit', '-qm', 'sidecar owned by a third plan');
    const owned = readFileSync(join(r.mainDir, r.siblingSidecar), 'utf8');

    const res = runRRCapture(wt2, ['NITS', '--findings', fjson, '--no-push']);
    assert.notEqual(res.status, 0, 'must refuse, not write');
    assert.match(res.stderr, /REFUSED/);
    assert.match(res.stderr, /9999-Someone-else/, 'names the sidecar owner');
    assert.match(res.stderr, /2816-Coord-lock/, 'names who tried to write');
    assert.equal(
      readFileSync(join(r.mainDir, r.siblingSidecar), 'utf8'),
      owned,
      'nothing was written',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2838: an AMBIGUOUS legacy match refuses non-zero and NAMES every candidate', () => {
  const r = makeTwoSessionRepo('300-Old-plan', '301-Other-plan');
  try {
    // Strip both Branch lines so nothing anchors, and have BOTH mention my slug — the exact
    // shape where the old resolver silently picked the most-recent one.
    const dir = 'docs/handoff/sessions';
    writeFileSync(
      join(r.mainDir, `${dir}/2026-08-04-session-2697.md`),
      '# s2697\n\n300-Old-plan\n',
    );
    writeFileSync(
      join(r.mainDir, `${dir}/2026-08-04-session-2698.md`),
      '# s2698\n\n300-Old-plan\n',
    );
    r.g(r.mainDir, 'add', '-A');
    r.g(r.mainDir, 'commit', '-qm', 'two un-anchored mentions');
    const head = r.g(r.mainDir, 'rev-parse', 'HEAD');

    const res = runRRCapture(r.wtDir, ['PASS', '--no-push']);
    assert.notEqual(res.status, 0, 'refuses rather than writing to the most-recent entry');
    assert.match(res.stderr, /AMBIGUOUS session entry/);
    assert.match(res.stderr, /2026-08-04-session-2697\.md/, 'names candidate 1');
    assert.match(res.stderr, /2026-08-04-session-2698\.md/, 'names candidate 2');
    assert.equal(r.g(r.mainDir, 'rev-parse', 'HEAD'), head, 'nothing committed');
  } finally {
    r.cleanup();
  }
});

test('plan 2838: a lone mention inside a session entry that declares ANOTHER owner is REFUSED', () => {
  // review 2838 [5]/[15]/[17]/[18]: after the anchored pass finds nothing, a single fallback
  // mention used to be trusted outright. If that one file is another session's entry, the
  // marker — and a wholesale sidecar replace — landed there. The entry's own `**Branch:**`
  // line is the last line of defence, and unlike the sidecar's `slug` stamp it bites the
  // ENTIRE legacy population (all 1093 committed sidecars are unowned; their entries are not).
  const r = makeTwoSessionRepo('2808-Pipe-stage7', '2816-Coord-lock');
  try {
    const dir = 'docs/handoff/sessions';
    // my own entry disappears; the ONLY file mentioning my slug is the sibling's entry, which
    // declares `**Branch:** none — …` (a real committed form, so not the worktree- prefix).
    rmSync(join(r.mainDir, `${dir}/2026-08-04-session-2697.md`));
    writeFileSync(
      join(r.mainDir, `${dir}/2026-08-04-session-2698.md`),
      '# 2026-08-04 (session 2698)\n\n**Branch:** `worktree-2816-Coord-lock`\nran beside 2808-Pipe-stage7\n',
    );
    r.g(r.mainDir, 'add', '-A');
    r.g(r.mainDir, 'commit', '-qm', 'only the sibling entry mentions my slug');
    const head = r.g(r.mainDir, 'rev-parse', 'HEAD');
    const before = readFileSync(join(r.mainDir, r.siblingSidecar), 'utf8');

    const res = runRRCapture(r.wtDir, ['PASS', '--no-push']);
    assert.notEqual(res.status, 0, 'must refuse, not write into the sibling entry');
    // The resolver drops it at the fallback (the entry declares a branch, so it is not legacy),
    // so the refusal surfaces as the untouched noSessionEntry contract — exit non-zero, nothing
    // written. assertSessionEntryOwner is the belt behind this and is unit-tested directly.
    assert.match(res.stderr, /no handoff session entry references slug "2808-Pipe-stage7"/);
    assert.doesNotMatch(
      readFileSync(join(r.mainDir, `${dir}/2026-08-04-session-2698.md`), 'utf8'),
      /Review: PASS/,
      "the sibling's entry got no marker",
    );
    assert.equal(r.g(r.mainDir, 'rev-parse', 'HEAD'), head, 'nothing committed');
    assert.equal(
      readFileSync(join(r.mainDir, r.siblingSidecar), 'utf8'),
      before,
      'the sibling sidecar is untouched',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2838: an existing but UNPARSEABLE sidecar refuses instead of being replaced wholesale', () => {
  // review 2838 [9]: the old catch-all read "corrupt" as "absent" and overwrote it — discarding
  // whatever findings and dispositions were still recoverable. That call belongs to the operator.
  const r = makeTwoSessionRepo('2808-Pipe-stage7', '2816-Coord-lock');
  try {
    const mySidecar = findingsSidecarPath(r.mine);
    writeFileSync(join(r.mainDir, mySidecar), '{"sha":"abc","findings":[{"key":"k1",');
    r.g(r.mainDir, 'add', '-A');
    r.g(r.mainDir, 'commit', '-qm', 'truncated sidecar');
    const before = readFileSync(join(r.mainDir, mySidecar), 'utf8');
    const fjson = join(r.root, 'f.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'a.ts', line: 1, summary: 'new' }]));

    const res = runRRCapture(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    assert.notEqual(res.status, 0, 'must refuse');
    assert.match(res.stderr, /not a parseable findings record/);
    assert.equal(readFileSync(join(r.mainDir, mySidecar), 'utf8'), before, 'left as-is');
  } finally {
    r.cleanup();
  }
});

// ── plan 2844 Task 3: the DESC repin path's probeExtras/applyExtras refuse an
// existing-but-unparseable sidecar, mirroring the record path's prepare/mutateIn split above.
// Driven directly against DESC (not through the full repin CLI/rebase machinery) — probeExtras
// runs at GATE time and applyExtras is the defense-in-depth re-assert for the freshen-and-retry
// window, so isolating each function is the direct way to pin BOTH sites independently.

function makeMalformedSidecarFixture() {
  const root = mkdtempSync(join(tmpdir(), 'record-review-desc-'));
  const sf = 'docs/handoff/sessions/2026-08-04-session-1.md';
  const sidecarRel = findingsSidecarPath(sf);
  mkdirSync(dirname(join(root, sidecarRel)), { recursive: true });
  writeFileSync(join(root, sidecarRel), '{"sha":"abc","findings":[{"key":"k1",'); // truncated JSON
  return { root, sf, sidecarRel, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('plan 2844: DESC.probeExtras refuses an existing-but-unparseable sidecar (naming the file), not a marker-only re-pin', () => {
  const f = makeMalformedSidecarFixture();
  try {
    const before = readFileSync(join(f.root, f.sidecarRel), 'utf8');
    const extra = DESC.probeExtras(f.root, f.sf, { sha: 'deadbeef' }, 'some-slug');
    assert.equal(extra.sidecarPinned, false);
    assert.ok(extra.refuse, 'must carry a refuse message, not silently downgrade to marker-only');
    assert.match(extra.refuse, new RegExp(f.sidecarRel.replace(/[.]/g, '\\.')));
    assert.match(extra.refuse, /not a parseable findings record/);
    assert.equal(readFileSync(join(f.root, f.sidecarRel), 'utf8'), before, 'left as-is');
  } finally {
    f.cleanup();
  }
});

test('plan 2844: DESC.probeExtras still reports {sidecarPinned:false} with NO refuse when the sidecar is simply ABSENT', () => {
  // The absence case must stay exactly as before this plan — only exists-but-unparseable is new.
  const root = mkdtempSync(join(tmpdir(), 'record-review-desc-absent-'));
  try {
    const sf = 'docs/handoff/sessions/2026-08-04-session-2.md';
    const extra = DESC.probeExtras(root, sf, { sha: 'deadbeef' }, 'some-slug');
    assert.deepEqual(extra, { sidecarPinned: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plan 2844: DESC.applyExtras THROWS naming the file on an existing-but-unparseable sidecar, instead of silently returning a marker-only re-pin', () => {
  const f = makeMalformedSidecarFixture();
  try {
    const before = readFileSync(join(f.root, f.sidecarRel), 'utf8');
    assert.throws(
      () => DESC.applyExtras(f.root, f.sf, { sha: 'deadbeef' }, 'cafebabe', null, 'some-slug'),
      new RegExp(`${f.sidecarRel.replace(/[.]/g, '\\.')}.*not a parseable findings record`),
    );
    assert.equal(
      readFileSync(join(f.root, f.sidecarRel), 'utf8'),
      before,
      'left as-is — no write happened',
    );
  } finally {
    f.cleanup();
  }
});

test('plan 2844: DESC.applyExtras still returns [] (marker-only) with no throw when the sidecar is simply ABSENT', () => {
  const root = mkdtempSync(join(tmpdir(), 'record-review-desc-absent-apply-'));
  try {
    const sf = 'docs/handoff/sessions/2026-08-04-session-3.md';
    assert.deepEqual(
      DESC.applyExtras(root, sf, { sha: 'deadbeef' }, 'cafebabe', null, 'some-slug'),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// plan 2844 review [b797d0]/[0de93e]/[bca8b5]/[fa12e7]: the two tests above give applyExtras a
// THROW it never had before, and runRepinFlow's applyTo writes the MARKER first. Without a
// rollback the refusal leaves a half-applied re-pin — on --no-push that lands in MAIN's working
// tree with no commit behind it, so the marker reads re-pinned while its sidecar is untouched.
// Staged through the real flow with a desc whose applyExtras throws (probeExtras gates the
// reachable case, so the apply-time throw is only reachable as a gate→apply race): the marker
// file must come back byte-identical.
test('plan 2844: a THROWING applyExtras rolls the marker back — a refused re-pin writes NOTHING', () => {
  const slug = 'repin-throwing-extras';
  const r = makeRepoForRepin(slug);
  try {
    // A legacy sha-only marker, so the re-pin genuinely runs (a dual-pinned one short-circuits).
    const shaBefore = r.g(r.wtDir, 'rev-parse', 'HEAD');
    writeFileSync(
      join(r.mainDir, r.sf),
      `# Session 1\n\nClaimed ${slug}.\nReview: PASS @ ${shaBefore}\n`,
    );
    r.g(r.mainDir, 'add', r.sf);
    r.g(r.mainDir, 'commit', '-qm', 'legacy marker');

    // master advances, branch rebases: same content-diff, new sha ⇒ a real re-pin is due.
    writeFileSync(join(r.mainDir, 'shared.txt'), 'line\nmore\n');
    r.g(r.mainDir, 'add', 'shared.txt');
    r.g(r.mainDir, 'commit', '-qm', 'sibling');
    r.g(r.mainDir, 'push', '-q', 'origin', 'master');
    r.g(r.wtDir, 'fetch', '-q', 'origin', 'master');
    r.g(r.wtDir, 'rebase', '-q', 'origin/master');
    assert.notEqual(r.g(r.wtDir, 'rev-parse', 'HEAD'), shaBefore);

    const markerBefore = readFileSync(join(r.mainDir, r.sf), 'utf8');
    const commitsBefore = r.g(r.mainDir, 'rev-list', '--count', 'HEAD');

    // Drive the REAL runRepinFlow with DESC's applyExtras swapped for a throwing one.
    const harness = join(r.root, 'throwing-repin.mjs');
    writeFileSync(
      harness,
      [
        `import { DESC } from ${specifierFor(SCRIPT)};`,
        `import { runRepinFlow } from ${specifierFor(MARKER_CLI)};`,
        `const desc = { ...DESC, applyExtras: () => { throw new Error('staged gate→apply race'); } };`,
        `try { runRepinFlow(desc, ['repin', '--no-push']); } catch (e) {`,
        `  console.error('THREW: ' + e.message); process.exit(9);`,
        `}`,
      ].join('\n'),
    );
    const res = spawnSync('node', [harness], {
      cwd: r.wtDir,
      encoding: 'utf8',
      env: { ...process.env, COORD_MAIN_DIR: '' },
    });
    assert.equal(res.status, 9, `the throw propagates (stderr: ${res.stderr})`);
    assert.match(res.stderr, /staged gate→apply race/);

    assert.equal(
      readFileSync(join(r.mainDir, r.sf), 'utf8'),
      markerBefore,
      'the marker was rolled back — no half-applied re-pin left in the working tree',
    );
    assert.equal(
      r.g(r.mainDir, 'rev-list', '--count', 'HEAD'),
      commitsBefore,
      'and no commit was spent',
    );

    // re-review [angle-A]: the same rollback must cover OUR OWN use of the return value —
    // `[sf, ...extras]` on a non-iterable throws too, and that throw used to sit outside the
    // guard, so a family returning garbage skipped the rollback entirely.
    const harness2 = join(r.root, 'noniterable-repin.mjs');
    writeFileSync(
      harness2,
      [
        `import { DESC } from ${specifierFor(SCRIPT)};`,
        `import { runRepinFlow } from ${specifierFor(MARKER_CLI)};`,
        `const desc = { ...DESC, applyExtras: () => 42 };`,
        `try { runRepinFlow(desc, ['repin', '--no-push']); } catch (e) {`,
        `  console.error('THREW: ' + e.message); process.exit(9);`,
        `}`,
      ].join('\n'),
    );
    const res2 = spawnSync('node', [harness2], {
      cwd: r.wtDir,
      encoding: 'utf8',
      env: { ...process.env, COORD_MAIN_DIR: '' },
    });
    assert.equal(res2.status, 9, `the TypeError propagates (stderr: ${res2.stderr})`);
    assert.equal(
      readFileSync(join(r.mainDir, r.sf), 'utf8'),
      markerBefore,
      'a non-iterable applyExtras result rolls the marker back too',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 2891 T1: errno-discriminating sidecar reads ───────────────────────────────────────
//
// Every sidecar read used to be a bare `catch {}`, so an EXISTING but unreadable sidecar read as
// ABSENT — the most destructive possible misreading: a re-pin advances marker-only and strands
// the findings, a re-record starts every finding open, a
// disposition says "record them first". The fixture makes the sidecar path a DIRECTORY, so the
// read fails with EISDIR (not ENOENT) on every platform Node runs on, without depending on file
// permissions — which prove nothing when the test runs as root, as the cloud drains do.
function sidecarAsDirectory(r) {
  const rel = findingsSidecarPath(r.sf);
  mkdirSync(join(r.mainDir, rel), { recursive: true });
  return rel;
}

test('plan 2891 T1: DESC.probeExtras REFUSES an existing-but-unreadable sidecar (not a silent marker-only re-pin)', () => {
  const r = makeRepoForRepin('t1-probe-unreadable');
  try {
    const rel = sidecarAsDirectory(r);
    const out = DESC.probeExtras(r.mainDir, r.sf, { sha: 'a'.repeat(40) }, 't1-probe-unreadable');
    assert.equal(out.sidecarPinned, false);
    assert.match(out.refuse, /REFUSED/);
    assert.match(out.refuse, new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(out.refuse, /EISDIR/, 'the refusal names the errno, not just the file');
  } finally {
    r.cleanup();
  }
});

test('plan 2891 T1: DESC.applyExtras THROWS on an existing-but-unreadable sidecar instead of returning marker-only', () => {
  const r = makeRepoForRepin('t1-apply-unreadable');
  try {
    sidecarAsDirectory(r);
    assert.throws(
      () =>
        DESC.applyExtras(
          r.mainDir,
          r.sf,
          { sha: 'a'.repeat(40) },
          'b'.repeat(40),
          null,
          't1-apply-unreadable',
        ),
      /REFUSED.*EISDIR/s,
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2891 T1: ENOENT is still the ONLY "absent" — a genuinely missing sidecar keeps the marker-only path', () => {
  const r = makeRepoForRepin('t1-absent');
  try {
    const probe = DESC.probeExtras(r.mainDir, r.sf, { sha: 'a'.repeat(40) }, 't1-absent');
    assert.equal(probe.sidecarPinned, false);
    assert.equal(probe.refuse, undefined, 'absent is not a refusal');
    assert.deepEqual(
      DESC.applyExtras(r.mainDir, r.sf, { sha: 'a'.repeat(40) }, 'b'.repeat(40), null, 't1-absent'),
      [],
      'absent still yields a marker-only re-pin',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2891 T1: the RECORD path refuses an unreadable sidecar rather than replacing it wholesale', () => {
  const r = makeRepoForRepin('t1-record-unreadable');
  try {
    const rel = sidecarAsDirectory(r);
    const fjson = join(r.root, 'f.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'a.ts', line: 1, summary: 'one' }]));
    const res = runRRCapture(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    assert.equal(res.status, 3, `expected the sidecar refusal exit (stderr: ${res.stderr})`);
    assert.match(res.stderr, /REFUSED/);
    assert.match(res.stderr, /EISDIR/);
    assert.ok(
      existsSync(join(r.mainDir, rel)),
      'the unreadable path is untouched — nothing was written over it',
    );
    assert.doesNotMatch(
      readFileSync(join(r.mainDir, r.sf), 'utf8'),
      /Review:/,
      'and no marker was written either — the refusal precedes every write',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2891 T1: `disposition` refuses an unreadable sidecar instead of reporting "no findings recorded"', () => {
  const r = makeRepoForRepin('t1-disposition-unreadable');
  try {
    sidecarAsDirectory(r);
    const res = runRRCapture(r.wtDir, ['disposition', 'somekey', '--fixed', '--no-push']);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /REFUSED/);
    assert.match(res.stderr, /EISDIR/);
    assert.doesNotMatch(
      res.stderr,
      /Record them first/,
      'the old message INVITED a re-record over findings that are still there',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 2891 T3: what the identical-re-record detector must NOT swallow ───────────────────
test('plan 2891 T3: a re-record with DIFFERENT provenance is a real record, not a re-pin', () => {
  const r = makeRepoForRepin('t3-provenance');
  try {
    runRR(r.wtDir, ['PASS', '--no-push', '--review-method', 'self-read']);
    const first = readFileSync(join(r.mainDir, r.sf), 'utf8');
    assert.match(first, /Review: PASS/);
    // same sha, same verdict — but the review was re-run through a different lane
    const res = runRRCapture(r.wtDir, ['PASS', '--no-push', '--review-method', 'gpt-review']);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /re-record of the SAME review/);
    assert.match(readFileSync(join(r.mainDir, r.sf), 'utf8'), /gpt-review/);
  } finally {
    r.cleanup();
  }
});

test('plan 2891 T3: a re-record at the SAME sha with the same provenance is a re-pin (the plan-2499 churn)', () => {
  const r = makeRepoForRepin('t3-same-sha');
  try {
    runRR(r.wtDir, ['PASS', '--no-push', '--review-method', 'self-read']);
    const commitsBefore = r.g(r.mainDir, 'rev-list', '--count', 'HEAD');
    const res = runRRCapture(r.wtDir, ['PASS', '--no-push', '--review-method', 'self-read']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /re-record of the SAME review, not a new round/);
    assert.equal(
      r.g(r.mainDir, 'rev-list', '--count', 'HEAD'),
      commitsBefore,
      'no commit was spent re-saying what is already recorded',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 2891 T6: the re-pin write JOURNAL covers the family's EXTRA paths, not just the marker
test('plan 2891 T6: a throwing applyExtras restores an extra file it modified AND deletes one it created', () => {
  const slug = 't6-journal';
  const r = makeRepoForRepin(slug);
  try {
    const shaBefore = r.g(r.wtDir, 'rev-parse', 'HEAD');
    writeFileSync(
      join(r.mainDir, r.sf),
      `# Session 1\n\nClaimed ${slug}.\nReview: PASS @ ${shaBefore}\n`,
    );
    // one extra that EXISTS before the re-pin, one the family will CREATE then fail after
    const keptRel = 'docs/handoff/sessions/2026-07-09-session-1.extra-a.json';
    const newRel = 'docs/handoff/sessions/2026-07-09-session-1.extra-b.json';
    writeFileSync(join(r.mainDir, keptRel), '{"original":true}\n');
    r.g(r.mainDir, 'add', r.sf, keptRel);
    r.g(r.mainDir, 'commit', '-qm', 'legacy marker + extra');

    writeFileSync(join(r.mainDir, 'shared.txt'), 'line\nmore\n');
    r.g(r.mainDir, 'add', 'shared.txt');
    r.g(r.mainDir, 'commit', '-qm', 'sibling');
    r.g(r.mainDir, 'push', '-q', 'origin', 'master');
    r.g(r.wtDir, 'fetch', '-q', 'origin', 'master');
    r.g(r.wtDir, 'rebase', '-q', 'origin/master');

    const markerBefore = readFileSync(join(r.mainDir, r.sf), 'utf8');
    const keptBefore = readFileSync(join(r.mainDir, keptRel), 'utf8');

    const harness = join(r.root, 'journal-repin.mjs');
    writeFileSync(
      harness,
      [
        `import { writeFileSync } from 'node:fs';`,
        `import { join } from 'node:path';`,
        `import { DESC } from ${specifierFor(SCRIPT)};`,
        `import { runRepinFlow } from ${specifierFor(MARKER_CLI)};`,
        `const desc = { ...DESC,`,
        `  extraJournalPaths: () => [${JSON.stringify(keptRel)}, ${JSON.stringify(newRel)}],`,
        `  applyExtras: (dir) => {`,
        `    writeFileSync(join(dir, ${JSON.stringify(keptRel)}), '{"clobbered":true}\\n');`,
        `    writeFileSync(join(dir, ${JSON.stringify(newRel)}), '{"leaked":true}\\n');`,
        `    throw new Error('staged gate→apply race');`,
        `  } };`,
        `try { runRepinFlow(desc, ['repin', '--no-push']); } catch (e) {`,
        `  console.error('THREW: ' + e.message); process.exit(9);`,
        `}`,
      ].join('\n'),
    );
    const res = spawnSync('node', [harness], {
      cwd: r.wtDir,
      encoding: 'utf8',
      env: { ...process.env, COORD_MAIN_DIR: '' },
    });
    assert.equal(res.status, 9, `the throw propagates (stderr: ${res.stderr})`);

    assert.equal(
      readFileSync(join(r.mainDir, r.sf), 'utf8'),
      markerBefore,
      'the marker is still rolled back (the plan-2844 guarantee)',
    );
    assert.equal(
      readFileSync(join(r.mainDir, keptRel), 'utf8'),
      keptBefore,
      'an EXTRA file the family had already rewritten is restored — the plan-2844 rollback missed this',
    );
    assert.equal(
      existsSync(join(r.mainDir, newRel)),
      false,
      'and an extra file it CREATED before failing is removed, not left behind',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 2891 review round 1 (CONFIRMED findings) ──────────────────────────────────────────

test('plan 2891 T3 review-fix: a LEGACY sha-only marker is still re-recorded, so it acquires its patch-id', () => {
  const slug = 't3-legacy-upgrade';
  const r = makeRepoForRepin(slug);
  try {
    // A legacy marker pinning HEAD by sha with NO patch-id — the pre-2743 shape.
    const sha = r.g(r.wtDir, 'rev-parse', 'HEAD');
    writeFileSync(
      join(r.mainDir, r.sf),
      `# Session 1\n\nClaimed ${slug}.\nReview: PASS @ ${sha}\n`,
    );
    r.g(r.mainDir, 'add', r.sf);
    r.g(r.mainDir, 'commit', '-qm', 'legacy marker');

    const res = runRRCapture(r.wtDir, ['PASS', '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(
      res.stderr,
      /re-record of the SAME review/,
      'skipping here would leave the marker with no rebase-stable identity — the re-pin path ' +
        'short-circuits on the sha match and never stamps one',
    );
    assert.match(
      readFileSync(join(r.mainDir, r.sf), 'utf8'),
      /Review: PASS.* patch-id:[0-9a-f]+/,
      'the re-record performed the plan-2743 forward migration',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2891 review-fix: a failing SIDECAR write rolls the marker back — no half-applied record', (t) => {
  const slug = 'record-journal';
  const r = makeRepoForRepin(slug);
  try {
    // A DANGLING SYMLINK is the one shape that reads as genuinely absent (ENOENT, so the T1
    // policy correctly takes the marker-only path) while its WRITE still fails (ENOENT again —
    // the link's target directory does not exist). That is precisely the residual the round-1
    // review named: validation cannot predict it, so only a rollback can keep MAIN's tree whole.
    const sidecarAbs = join(r.mainDir, findingsSidecarPath(r.sf));
    try {
      symlinkSync(join(r.root, 'no-such-dir', 'target.json'), sidecarAbs);
    } catch (e) {
      // Creating a symlink needs elevation on Windows. SKIP LOUDLY rather than returning
      // silently: a test that quietly passes on the platform it cannot exercise is the
      // half-injection shape this repo's platform rule exists to catch.
      t.skip(`symlink creation unavailable on this platform (${e.code || e.message})`);
      return;
    }
    const fjson = join(r.root, 'f.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'a.ts', line: 1, summary: 'one' }]));
    const markerBefore = readFileSync(join(r.mainDir, r.sf), 'utf8');

    const res = runRRCapture(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    assert.notEqual(res.status, 0, `the failed sidecar write must surface (stdout: ${res.stdout})`);
    assert.equal(
      readFileSync(join(r.mainDir, r.sf), 'utf8'),
      markerBefore,
      'the marker was rolled back — MAIN never keeps a marker whose sidecar failed to write',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2891 review round 2: rollback must NOT delete a dangling symlink it merely could not read', (t) => {
  const slug = 'journal-symlink-preserved';
  const r = makeRepoForRepin(slug);
  try {
    const sidecarAbs = join(r.mainDir, findingsSidecarPath(r.sf));
    try {
      symlinkSync(join(r.root, 'no-such-dir', 'target.json'), sidecarAbs);
    } catch (e) {
      t.skip(`symlink creation unavailable on this platform (${e.code || e.message})`);
      return;
    }
    const fjson = join(r.root, 'f.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'a.ts', line: 1, summary: 'one' }]));

    // The sidecar write fails (the link's target dir does not exist) → rollback runs. A journal
    // that read ENOENT as "we created this" would rmSync the operator's symlink outright.
    const res = runRRCapture(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    assert.notEqual(res.status, 0);
    assert.ok(
      lstatSync(sidecarAbs).isSymbolicLink(),
      'the dangling symlink survived the rollback — an unreadable path is never ours to delete',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 3395 review round 3 (findings 2/3/4 and 1/5) ────────────────────────────────────────
// Two ways the round counter mis-read a session entry, both of which HANDED BACK free rounds
// under the cap the counter exists to enforce.

test('recordedReviewRound: prose mentioning a verdict is not a machine marker', () => {
  const entry = [
    '# 2026-08-24 (session 1 — plan 9999)',
    '',
    'Code review: PASS after the rebase, so I moved on.',
    'The reviewer said Review: BUGS-FOUND but I fixed them all.',
    '',
    'Review: NITS:gpt-review f=11 @ 0123456789abcdef0123456789abcdef01234567 review-round:3',
  ].join('\n');
  // Only the last line is a real marker (verdict + `@ <sha>`), so the round is ITS token.
  // Before the `@ <sha>` anchor the two prose lines matched too; the final prose match had no
  // token, so it reset the count to 1 and silently granted two extra rounds.
  assert.equal(recordedReviewRound(entry), 3);
});

test('past-cap marker suffix: JSON quoting preserves a hostile reason after the canonical round token', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const reason = 'round 12 says "review-round:99"\nsecond line';
  const suffix = describeReviewPastCap({ reason });
  const marker = appendMarkerPastCapSuffix(
    `Review: PASS:gpt-review f=11 v=2 adj=1 @ ${sha} review-round:4\n`,
    suffix,
  );
  assert.equal(recordedReviewRound(marker), 4, 'hostile suffix text cannot replace round 4');
  assert.ok(marker.indexOf('review-round:4') < marker.indexOf('past-cap-reason='));
  assert.equal(marker.split(/\r?\n/).length, 2, 'the embedded newline is JSON-escaped');
  const token = markerLinePastCapSuffix(marker, sha);
  assert.ok(token);
  assert.equal(JSON.parse(token.slice('past-cap-reason='.length)), reason);
});

test('past-cap marker suffix: absent stats field is byte-identical to the pre-3527 marker', () => {
  const current = `Review: PASS:gpt-review f=11 v=2 adj=1 @ ${'a'.repeat(40)} review-round:2\n`;
  assert.equal(describeReviewPastCap(null), '');
  assert.equal(appendMarkerPastCapSuffix(current, describeReviewPastCap(null)), current);
});

test('record-review consumes stats.json pastCap automatically and writes the reversible reason after review-round:N', () => {
  const slug = 'past-cap-stats-channel';
  const r = makeRepoForRepin(slug);
  try {
    const reason = 'digits 123, "quotes", and literal review-round:99';
    const statsFile = join(r.root, 'stats.json');
    writeFileSync(
      statsFile,
      JSON.stringify({
        identity: { endSha: r.g(r.wtDir, 'rev-parse', 'HEAD') },
        stats: { finders: 11, verifierAgents: 2, escalated: 1 },
        pastCap: { reason },
      }),
    );
    const res = runRRCapture(r.wtDir, [
      'PASS',
      '--review-method',
      'gpt-review',
      '--review-stats',
      statsFile,
      '--no-push',
    ]);
    assert.equal(res.status, 0, res.stderr);
    const marker = readFileSync(join(r.mainDir, r.sf), 'utf8');
    assert.equal(recordedReviewRound(marker), 1);
    assert.ok(marker.indexOf('review-round:1') < marker.indexOf('past-cap-reason='));
    const token = markerLinePastCapSuffix(marker, r.g(r.wtDir, 'rev-parse', 'HEAD'));
    assert.equal(JSON.parse(token.slice('past-cap-reason='.length)), reason);
  } finally {
    r.cleanup();
  }
});

test('recordedReviewRound: prose alone yields no round at all', () => {
  const entry = '# entry\n\nCode review: PASS — nothing machine-readable here.\n';
  assert.equal(recordedReviewRound(entry), null);
});

test('sessionReviewRound: a legacy marker with no token inherits the sidecar round count', () => {
  // The pre-migration shape: marker written before `review-round:` existed, sidecar already at 4.
  const entry = 'Review: NITS:gpt-review @ 0123456789abcdef0123456789abcdef01234567\n';
  const sidecar = JSON.stringify({
    sha: '0123456789abcdef0123456789abcdef01234567',
    rounds: 4,
    findings: [],
  });
  assert.equal(recordedReviewRound(entry), 1, 'marker alone still reads as round 1');
  assert.equal(sessionReviewRound(entry, sidecar), 4, 'sidecar carries the real count');
});

test('sessionReviewRound: the marker wins when it is ahead of the sidecar', () => {
  const entry =
    'Review: NITS:gpt-review @ 0123456789abcdef0123456789abcdef01234567 review-round:6\n';
  const sidecar = JSON.stringify({
    sha: '0123456789abcdef0123456789abcdef01234567',
    rounds: 2,
    findings: [],
  });
  assert.equal(sessionReviewRound(entry, sidecar), 6);
});

test('sessionReviewRound: an unreadable or absent sidecar degrades to the marker', () => {
  const entry =
    'Review: PASS:gpt-review @ 0123456789abcdef0123456789abcdef01234567 review-round:2\n';
  assert.equal(sessionReviewRound(entry, null), 2);
  assert.equal(sessionReviewRound(entry, '{not json'), 2);
  assert.equal(sessionReviewRound('# no marker here\n', null), null);
});

// ── plan 3415 — Item B standing findings ──────────────────────────────────────────────────────

test('recordedReviewRound: tracks the shared marker family verdict list without restating it', () => {
  // Finding 4: record-review.mjs used to hand-roll its own PASS|NITS|BUGS-FOUND line regex
  // instead of reusing done-worktree-lib's markerRegExp(family) — so a verdict added to
  // MARKER_FAMILIES.review.verdicts would silently go unrecognized here until someone
  // remembered to edit BOTH copies. Add a throwaway verdict straight to the shared family (never
  // to a second hardcoded list in this file) and confirm recordedReviewRound picks it up with
  // zero changes on this side.
  const family = MARKER_FAMILIES.review;
  const original = family.verdicts;
  family.verdicts = [...original, 'THROWAWAY-VERDICT'];
  try {
    const entry = `Review: THROWAWAY-VERDICT @ ${'a'.repeat(40)} review-round:5\n`;
    assert.equal(recordedReviewRound(entry), 5);
  } finally {
    family.verdicts = original;
  }
});

test('sessionReviewRound: a sidecar for a DIFFERENT marker identity must not inflate the count', () => {
  // Finding 2: the sidecar fallback never checked that the sidecar it read actually belongs to
  // the marker being evaluated. A stale sidecar left over from an earlier, already-superseded
  // review (different sha) must not hand a brand-new review free rounds.
  const entry = 'Review: NITS:gpt-review @ 0123456789abcdef0123456789abcdef01234567\n';
  const staleSidecar = JSON.stringify({
    sha: 'fedcba9876543210fedcba9876543210fedcba98', // a DIFFERENT sha than the marker's
    rounds: 9,
    findings: [],
  });
  assert.equal(recordedReviewRound(entry), 1, 'marker alone reads as round 1 (no token)');
  assert.equal(
    sessionReviewRound(entry, staleSidecar),
    1,
    'a sidecar for a different marker identity must be ignored, not trusted for 9 free rounds',
  );
});

test('warnIfReviewRoundCapReached: the sidecar fallback resolves origin-first, like the marker does', () => {
  // Finding 1: defaultReadSidecarRaw did a plain readFileSync(repoRoot, ...) — which only ever
  // succeeds when the CALLER's own working tree happens to have the sidecar file materialized.
  // gpt-review.mjs calls this with repoRoot = the WORKTREE checkout, whose own working tree never
  // carries docs/handoff/sessions/*.findings.json (those live on master's tree, landed via the
  // routed coord-write straight to origin) — so the fallback was silently a no-op for every real
  // caller. Reproduce that shape with a real repo + linked worktree + real origin remote: the
  // sidecar is committed and pushed on MAIN/master, the worktree checkout's own tree never gets
  // it, and the round warning is asked to resolve it from the worktree's repoRoot.
  const slug = 'origin-first-sidecar';
  const r = makeRepoForRepin(slug);
  try {
    const sidecarRel = findingsSidecarPath(r.sf);
    mkdirSync(dirname(join(r.mainDir, sidecarRel)), { recursive: true });
    writeFileSync(
      join(r.mainDir, sidecarRel),
      JSON.stringify({
        sha: '0123456789abcdef0123456789abcdef01234567',
        rounds: 4,
        findings: [],
      }),
    );
    r.g(r.mainDir, 'add', '-A');
    r.g(r.mainDir, 'commit', '-qm', 'landed sidecar');
    r.g(r.mainDir, 'push', '-q', 'origin', 'master');
    // the worktree's OWN tree never gets this file — it lives only on origin/master, exactly the
    // routed coord-write shape (a real caller's worktree branch never carries session docs at all)
    assert.equal(
      existsSync(join(r.wtDir, sidecarRel)),
      false,
      'precondition: the sidecar is not materialized in the worktree checkout',
    );
    r.g(r.wtDir, 'fetch', '-q', 'origin', 'master');

    // a legacy marker (no review-round: token) whose sha matches the sidecar's — the exact
    // pre-migration shape sessionReviewRound's fallback exists for.
    const legacyMarker = 'Review: NITS:gpt-review @ 0123456789abcdef0123456789abcdef01234567\n';
    const warnings = [];
    const rounds = warnIfReviewRoundCapReached(
      r.wtDir,
      slug,
      { sessionsDir: 'docs/handoff/sessions' },
      {
        warn: (m) => warnings.push(m),
        findSessionFn: () => r.sf,
        readCandidatesFn: () => [legacyMarker],
        // readSidecarRawFn intentionally NOT overridden — this exercises the real default.
      },
    );
    assert.equal(
      rounds,
      4,
      'the sidecar recorded on origin/master must be found from the worktree repoRoot, ' +
        'the same origin-first way the marker itself resolves',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 3415 finding 3: the RECORD path reads rounds through the same sidecar-aware reader as the warning', () => {
  // A legacy marker (no review-round: token) with a matching-sha sidecar already at round 4:
  // the pre-launch warning (sessionReviewRound) would read this as round 4, but record-review's
  // own next-round math used recordedReviewRound (marker-only) and would silently recompute round
  // 1 -> 2 instead of 4 -> 5, so the two could disagree about what round is being recorded.
  const slug = 'record-path-shared-reader';
  const r = makeRepoForRepin(slug);
  try {
    const shaBefore = r.g(r.wtDir, 'rev-parse', 'HEAD');
    writeFileSync(
      join(r.mainDir, r.sf),
      `# Session 1\n\nClaimed ${slug}.\n\nReview: NITS:gpt-review @ ${shaBefore}\n`,
    );
    const sidecarRel = findingsSidecarPath(r.sf);
    mkdirSync(dirname(join(r.mainDir, sidecarRel)), { recursive: true });
    writeFileSync(
      join(r.mainDir, sidecarRel),
      JSON.stringify({ sha: shaBefore, rounds: 4, findings: [] }),
    );
    r.g(r.mainDir, 'add', '-A');
    r.g(r.mainDir, 'commit', '-qm', 'legacy round-4 sidecar');

    // genuine content change (rework), then re-record — a real new round
    writeFileSync(join(r.wtDir, 'feature.txt'), 'work\nmore rework\n');
    r.g(r.wtDir, 'add', 'feature.txt');
    r.g(r.wtDir, 'commit', '-qm', 'rework');
    const fjson = join(r.root, 'f.json');
    writeFileSync(fjson, JSON.stringify([{ file: 'a.ts', line: 1, summary: 'one' }]));
    const res = runRRCapture(r.wtDir, ['NITS', '--findings', fjson, '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(
      readFileSync(join(r.mainDir, r.sf), 'utf8'),
      /review-round:5$/m,
      'the record path must carry the sidecar-informed round (4 -> 5), not silently restart at 2',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 3415 — Item C standing findings (round-cap regressions surfaced by the review) ───────

test('recordedReviewRound: a marker-shaped construct embedded mid-line is not a real marker', () => {
  // Findings 25ace7/8efe16/f65a40/168ac0: markerRegExp (done-worktree-lib.mjs) is deliberately
  // UNANCHORED — matchAll scans a whole multi-line body for parseMarkerAny's "find the marker
  // anywhere" contract. Reusing it for a PER-LINE test without adding an anchor here let ordinary
  // prose that merely QUOTES marker-shaped text ("Note: quoted marker: Review: PASS @ <sha>
  // review-round:9") parse as a real machine marker and overwrite the round read from the actual
  // marker line above it.
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const entry = [
    `Review: NITS:gpt-review @ ${sha} review-round:3`,
    `Note: quoted marker: Review: PASS @ ${sha} review-round:9`,
  ].join('\n');
  assert.equal(
    recordedReviewRound(entry),
    3,
    "the quoted prose line must not override the real marker line's round",
  );
});

test('plan 3415 finding 5b: PASS without --findings still inherits a legacy sidecar round count', () => {
  // 57a5c3: PASS never carries --findings, so validateIn hard-coded { sidecarRel: null } for it
  // — the round math at mutateIn never saw the legacy sidecar and undercounted 4 -> 2 instead of
  // 4 -> 5, handing back free rounds under the cap.
  const slug = 'pass-legacy-sidecar-round';
  const r = makeRepoForRepin(slug);
  try {
    const shaBefore = r.g(r.wtDir, 'rev-parse', 'HEAD');
    writeFileSync(
      join(r.mainDir, r.sf),
      `# Session 1\n\nClaimed ${slug}.\n\nReview: NITS:gpt-review @ ${shaBefore}\n`,
    );
    const sidecarRel = findingsSidecarPath(r.sf);
    mkdirSync(dirname(join(r.mainDir, sidecarRel)), { recursive: true });
    writeFileSync(
      join(r.mainDir, sidecarRel),
      JSON.stringify({ sha: shaBefore, rounds: 4, findings: [] }),
    );
    r.g(r.mainDir, 'add', '-A');
    r.g(r.mainDir, 'commit', '-qm', 'legacy round-4 sidecar');

    // genuine content change (rework), then record PASS — no --findings, since PASS never takes one
    writeFileSync(join(r.wtDir, 'feature.txt'), 'work\nmore rework\n');
    r.g(r.wtDir, 'add', 'feature.txt');
    r.g(r.wtDir, 'commit', '-qm', 'rework');
    const res = runRRCapture(r.wtDir, ['PASS', '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(
      readFileSync(join(r.mainDir, r.sf), 'utf8'),
      /review-round:5$/m,
      'PASS must read the legacy sidecar round (4 -> 5), not undercount to 2',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 3415 finding 5b: NITS without --findings still inherits a legacy sidecar round count', () => {
  // b434a0: the no-findings path is explicitly supported for NITS/BUGS-FOUND (a console warning,
  // the land later halts at FINDINGS_OPEN) — but it hit the same sidecarRel:null short-circuit,
  // so a legacy round-4 sidecar was invisible to the round math here too.
  const slug = 'nits-no-findings-legacy-sidecar';
  const r = makeRepoForRepin(slug);
  try {
    const shaBefore = r.g(r.wtDir, 'rev-parse', 'HEAD');
    writeFileSync(
      join(r.mainDir, r.sf),
      `# Session 1\n\nClaimed ${slug}.\n\nReview: NITS:gpt-review @ ${shaBefore}\n`,
    );
    const sidecarRel = findingsSidecarPath(r.sf);
    mkdirSync(dirname(join(r.mainDir, sidecarRel)), { recursive: true });
    writeFileSync(
      join(r.mainDir, sidecarRel),
      JSON.stringify({ sha: shaBefore, rounds: 4, findings: [] }),
    );
    r.g(r.mainDir, 'add', '-A');
    r.g(r.mainDir, 'commit', '-qm', 'legacy round-4 sidecar');

    writeFileSync(join(r.wtDir, 'feature.txt'), 'work\nmore rework\n');
    r.g(r.wtDir, 'add', 'feature.txt');
    r.g(r.wtDir, 'commit', '-qm', 'rework');
    const res = runRRCapture(r.wtDir, ['NITS', '--no-push']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(
      readFileSync(join(r.mainDir, r.sf), 'utf8'),
      /review-round:5$/m,
      'NITS with no --findings must still read the legacy sidecar round (4 -> 5)',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 3764: wikiDecisionNudge — the review-record-time nudge for the WIKI_CHECKPOINT
// halt, so a session learns the wiki decision is due at the SAME moment it records the
// review, not only when the land later halts on it (0-of-38 real halts recorded the wiki
// decision first, per the 2026-09-06 census) ────────────────────────────────────────────

// plan 3958: this module ships as-is into the public coord-kit, whose own coord.config.json
// carries no wikiSubjectPatterns at all — wikiCheckpointNeeded's self-resolved default
// therefore never fires there, so the three tests below (which used to rely on that default
// matching 'backend/scripts/price-pipeline/x.py') inject a portable, fixed pattern via
// wikiCheckpointNeeded's own injectable 4th parameter instead — the SAME technique
// wiki-checkpoint.test.mjs now uses, threaded through here via wikiDecisionNudge's existing
// `needed` override (added for exactly this kind of test injection, per its own doc comment).
const WIKI_TEST_PATTERNS = [/^backend\/scripts\/price-pipeline\//];
const neededForTest = (changedFiles, chainsChanged) =>
  wikiCheckpointNeeded(changedFiles, chainsChanged, false, WIKI_TEST_PATTERNS);

test('wikiDecisionNudge: fires the full advisory block when a wiki-owned subject changed and no marker is recorded', () => {
  // Sanity: pin the fixture path against the injected portable predicate, so this test rots
  // loudly if WIKI_TEST_PATTERNS ever stops matching it, instead of silently testing nothing.
  assert.equal(neededForTest(['backend/scripts/price-pipeline/x.py']), true);

  const headSha = 'a'.repeat(40);
  const text = wikiDecisionNudge({
    changedFiles: ['backend/scripts/price-pipeline/x.py'],
    chainsChanged: false,
    marker: null,
    headSha,
    headPatchId: null,
    chainsPath: null, // chainsChanged is false — never read; explicit per chainsPath's no-default contract
    needed: neededForTest,
  });
  assert.match(text, /record-wiki\.mjs WROTE/);
  assert.match(text, /record-wiki\.mjs SKIP/);
  assert.match(text, /WIKI_CHECKPOINT/);
  assert.match(text, /exit 26/);
  assert.match(text, /backend\/scripts\/price-pipeline\/x\.py/);
});

test('wikiDecisionNudge: a marker recorded for the SAME sha prints the one-line recorded state, no warning block', () => {
  const headSha = 'b'.repeat(40);
  const text = wikiDecisionNudge({
    changedFiles: ['backend/scripts/price-pipeline/x.py'],
    chainsChanged: false,
    marker: { decision: 'WROTE', sha: headSha, patchId: null },
    headSha,
    headPatchId: null,
    chainsPath: null,
    needed: neededForTest,
  });
  assert.equal(text, `wiki decision: WROTE @ ${headSha.slice(0, 7)} (recorded)`);
  assert.doesNotMatch(text, /⚠/);
});

test('wikiDecisionNudge: a STALE-sha marker still counts as recorded when its range patch-id matches HEAD (plan 2743 identity)', () => {
  const headSha = 'c'.repeat(40);
  const text = wikiDecisionNudge({
    changedFiles: ['backend/scripts/price-pipeline/x.py'],
    chainsChanged: false,
    marker: { decision: 'SKIP', sha: 'd'.repeat(40), patchId: 'deadbeef' },
    headSha,
    headPatchId: () => 'deadbeef', // the memoized thunk shape every real caller passes
    chainsPath: null,
    needed: neededForTest,
  });
  assert.equal(text, `wiki decision: SKIP @ ${'d'.repeat(7)} (recorded)`);
});

test('wikiDecisionNudge: returns null when the diff touches no wiki-owned subject', () => {
  const text = wikiDecisionNudge({
    changedFiles: ['frontend/src/x.ts'],
    chainsChanged: false,
    marker: null,
    headSha: 'e'.repeat(40),
    headPatchId: null,
    chainsPath: null,
  });
  assert.equal(text, null);
});

test('wikiDecisionNudge: chainsChanged alone (the path-presence proxy) fires the checkpoint off an otherwise non-wiki diff', () => {
  // chainsPath built from the local SEED_SHARD_DIR const (declared above, plan 3961 T2.7b
  // follow-up) — chainsPath has no default any more, and this is the one case where
  // chainsChanged is true, so the real caller-built path is actually read.
  const chainsPath = `${SEED_SHARD_DIR}/chains.json`;
  const text = wikiDecisionNudge({
    changedFiles: [chainsPath],
    chainsChanged: true,
    marker: null,
    headSha: 'f'.repeat(40),
    headPatchId: null,
    chainsPath,
  });
  assert.match(text, /backend\/src\/data\/seed\/chains\.json/);
});

// plan 4096, gpt-review round 4 (four angles): the advisory path asks the wiki predicate TWICE —
// once at printWikiDecisionNudge's own gate, and again HERE, inside wikiMatchedNudgePaths' per-file
// walk. Since plan 4096 that predicate reads coord.config.json on first use and lets a malformed
// one throw (deliberately: the land's WIKI_CHECKPOINT seam must never fail open), so a guard
// wrapped around only the FIRST call leaves this one uncovered. That is precisely the shape round
// 3 shipped and round 4 caught, which is why the guard now sits at printWikiDecisionNudge's own
// boundary. This pins the fact that makes the boundary necessary.
test('wikiDecisionNudge asks `needed` more than once, so an advisory guard must wrap the WHOLE path (plan 4096 round 4)', () => {
  let calls = 0;
  const needed = () => {
    calls += 1;
    return true;
  };
  wikiDecisionNudge({
    changedFiles: ['backend/src/adapters/a.ts'],
    chainsChanged: false,
    marker: null,
    headSha: 'abc1234',
    chainsPath: null,
    needed,
  });
  assert.ok(calls > 1, `expected more than one predicate call, got ${calls}`);

  // …and a predicate that throws on that SECOND call really does escape this function — the
  // exact leak a first-call-only try/catch could not hold.
  let n = 0;
  const throwsLate = () => {
    n += 1;
    if (n > 1) throw new Error('config read failed on the per-file walk');
    return true;
  };
  assert.throws(
    () =>
      wikiDecisionNudge({
        changedFiles: ['backend/src/adapters/a.ts'],
        chainsChanged: false,
        marker: null,
        headSha: 'abc1234',
        chainsPath: null,
        needed: throwsLate,
      }),
    /per-file walk/,
  );
});

test('wikiDecisionNudge: follows the injected `needed` predicate (defaulting to wikiCheckpointNeeded) — proves it carries no copied pattern list', () => {
  const fired = wikiDecisionNudge({
    changedFiles: ['frontend/src/x.ts'], // NOT a real wiki-owned path
    chainsChanged: false,
    marker: null,
    headSha: 'a1'.repeat(20),
    headPatchId: null,
    needed: () => true,
    chainsPath: null,
  });
  assert.ok(fired, 'an injected needed:true predicate fires the nudge even off a non-wiki path');

  const silent = wikiDecisionNudge({
    changedFiles: ['backend/scripts/price-pipeline/x.py'], // a REAL wiki-owned path
    chainsChanged: false,
    marker: null,
    headSha: 'b2'.repeat(20),
    headPatchId: null,
    needed: () => false,
    chainsPath: null,
  });
  assert.equal(
    silent,
    null,
    'an injected needed:false predicate stays silent even off a real wiki-owned path',
  );
});

test('record-review.mjs does not copy WIKI_SUBJECT_PATTERNS (no backend/src/adapters regex literal)', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.ok(
    !src.includes('backend\\/src\\/adapters'),
    'WIKI_SUBJECT_PATTERNS is module-private in done-worktree-lib.mjs — inject wikiCheckpointNeeded, never re-spell the pattern here',
  );
});

test('record-review.mjs PASS: the report hook prints the wiki-decision nudge when due, and stays silent (same exit code) when the diff is not wiki-owned', () => {
  const wikiRepo = makeRepoForRepin('wiki-nudge-e2e-fires');
  const plainRepo = makeRepoForRepin('wiki-nudge-e2e-quiet');
  try {
    // plan 3958: the trigger is the seed shard's chains.json (the chainsChanged signal
    // wikiCheckpointNeeded's FIRST, pattern-independent check fires on unconditionally) rather
    // than a backend/scripts/price-pipeline/ path — this module ships as-is into the public
    // coord-kit, whose own coord.config.json carries no wikiSubjectPatterns at all, so the
    // pattern-matching half of the checkpoint can never fire there; chainsChanged only needs
    // THIS fixture's own configured seedShardDir, which is fully portable.
    writeFileSync(
      join(wikiRepo.mainDir, 'coord.config.json'),
      JSON.stringify({
        handoffLayout: 'sessions',
        handoffDir: 'docs/handoff',
        seedShardDir: 'backend/src/data/seed',
      }),
    );
    mkdirSync(join(wikiRepo.wtDir, 'backend/src/data/seed'), { recursive: true });
    writeFileSync(join(wikiRepo.wtDir, 'backend/src/data/seed/chains.json'), '{}\n');
    wikiRepo.g(wikiRepo.wtDir, 'add', '-A');
    wikiRepo.g(wikiRepo.wtDir, 'commit', '-qm', 'add chains registry entry');
    const wikiRes = runRRCapture(wikiRepo.wtDir, [
      'PASS',
      '--slug',
      'wiki-nudge-e2e-fires',
      '--no-push',
    ]);

    mkdirSync(join(plainRepo.wtDir, 'frontend/src'), { recursive: true });
    writeFileSync(join(plainRepo.wtDir, 'frontend/src/x.ts'), 'export const x = 1;\n');
    plainRepo.g(plainRepo.wtDir, 'add', '-A');
    plainRepo.g(plainRepo.wtDir, 'commit', '-qm', 'add frontend file');
    const plainRes = runRRCapture(plainRepo.wtDir, [
      'PASS',
      '--slug',
      'wiki-nudge-e2e-quiet',
      '--no-push',
    ]);

    assert.equal(wikiRes.status, 0, wikiRes.stderr);
    assert.equal(plainRes.status, 0, plainRes.stderr);
    assert.equal(
      wikiRes.status,
      plainRes.status,
      'the nudge is advisory only — exit code is identical whether or not it fires',
    );
    assert.match(wikiRes.stdout, /record-wiki\.mjs WROTE/);
    assert.doesNotMatch(plainRes.stdout, /record-wiki\.mjs/);
  } finally {
    wikiRepo.cleanup();
    plainRepo.cleanup();
  }
});

// plan 3764 review findings 940dcd / 5fc26b / 504cfc (CONFIRMED correctness): printWikiDecisionNudge
// resolved the session file with findSessionFile's DEFAULT `{ refs: ['HEAD'] }` instead of the
// established origin-first refs — record-wiki.mjs writes the wiki marker via the ROUTED
// coord-checkout straight to origin/master, so a session entry that exists ONLY there (the shared
// MAIN checkout has fetched origin/master by the time this runs — headPatchId() fetches it earlier
// in main() — but has not fast-forwarded its own HEAD onto it) is invisible to a 'HEAD'-only grep:
// `sf` comes back null and the marker is never read, so the nudge falsely nags "no decision
// recorded" forever even after record-wiki.mjs genuinely ran.
test('printWikiDecisionNudge: an origin-only session entry (MAIN checkout not fast-forwarded) is still read — fix for findings 940dcd/5fc26b/504cfc', () => {
  const g = (dir, ...a) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=', ...a],
      { encoding: 'utf8' },
    ).trim();
  const slug = 'wiki-origin-first-fix1';
  const root = mkdtempSync(join(tmpdir(), 'record-review-originfirst-'));
  try {
    const bare = join(root, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'ignore' });
    const mainDir = join(root, 'main');
    execFileSync('git', ['init', '-q', '-b', 'master', mainDir], { stdio: 'ignore' });
    // plan 3958: seedShardDir configured, and the "wiki-owned change" below is that shard's
    // chains.json — chainsChanged is wikiCheckpointNeeded's FIRST, pattern-independent check, so
    // this fixture doesn't need this checkout's real wikiSubjectPatterns (empty in the public
    // coord-kit) to fire the checkpoint.
    writeFileSync(
      join(mainDir, 'coord.config.json'),
      JSON.stringify({
        handoffLayout: 'sessions',
        handoffDir: 'docs/handoff',
        seedShardDir: 'backend/src/data/seed',
      }),
    );
    // Deliberately NO session entry for this slug in mainDir's init commit — the claim + wiki
    // marker below land ONLY via the routed coord checkout, straight to origin, exactly like
    // record-wiki.mjs's real write path.
    writeFileSync(join(mainDir, 'shared.txt'), 'line\n');
    g(mainDir, 'add', '-A');
    g(mainDir, 'commit', '-qm', 'init');
    g(mainDir, 'remote', 'add', 'origin', bare);
    g(mainDir, 'push', '-qu', 'origin', 'master');

    const wtDir = join(root, 'wt');
    g(mainDir, 'worktree', 'add', '-q', wtDir, '-b', `worktree-${slug}`);
    mkdirSync(join(wtDir, 'backend/src/data/seed'), { recursive: true });
    writeFileSync(join(wtDir, 'backend/src/data/seed/chains.json'), '{}\n');
    g(wtDir, 'add', '-A');
    g(wtDir, 'commit', '-qm', 'wiki-owned change');
    const headSha = g(wtDir, 'rev-parse', 'HEAD');

    // The routed coord checkout: a THIRD clone that never touches mainDir's working tree or
    // HEAD, adding the claim entry AND the wiki marker in one commit, straight to origin/master.
    const coordDir = join(root, 'coord');
    execFileSync('git', ['clone', '-q', bare, coordDir], { stdio: 'ignore' });
    const sf = 'docs/handoff/sessions/2026-07-09-session-1.md';
    mkdirSync(dirname(join(coordDir, sf)), { recursive: true });
    writeFileSync(
      join(coordDir, sf),
      `# Session 1\n\nClaimed ${slug}.\n\nWiki: WROTE:wiki/pricing.md @ ${headSha}\n`,
    );
    g(coordDir, 'add', '-A');
    g(coordDir, 'commit', '-qm', 'record wiki decision');
    g(coordDir, 'push', '-q', 'origin', 'master');

    // Fixture invariant: mainDir's own checked-out HEAD genuinely lacks any mention of the slug
    // (the race this test guards against) — it has never fetched, let alone fast-forwarded, past
    // the coord checkout's push above. `git grep` exits 1 (throws) on no match, which IS the
    // invariant holding.
    let headMention = '';
    try {
      headMention = g(mainDir, 'grep', '-l', '-F', slug, 'HEAD');
    } catch {
      /* exit 1 = no match, exactly the invariant this asserts */
    }
    assert.equal(
      headMention,
      '',
      "fixture invariant: mainDir's checked-out HEAD must not reference the slug at all",
    );

    // NOT --no-push: that local-only escape hatch runs validateIn/prepare straight against
    // MAIN's own (stale) tree, which would refuse with "no handoff session entry" before ever
    // reaching printWikiDecisionNudge. The DEFAULT path validates against the disposable
    // coord-checkout (freshly reset onto origin/master), exactly the real record-review.mjs
    // invocation this bug hits — MAIN itself is used ONLY by printWikiDecisionNudge's own lookup.
    const res = runRRCapture(wtDir, ['PASS', '--slug', slug]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(
      res.stdout,
      new RegExp(`wiki decision: WROTE @ ${headSha.slice(0, 7)} \\(recorded\\)`),
      `expected the one-line recorded state; got:\n${res.stdout}\n---stderr---\n${res.stderr}`,
    );
    assert.doesNotMatch(res.stdout, /⚠ wiki decision due before landing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// plan 3764 review finding 7c775d (CONFIRMED correctness): identicalReRecord() short-circuits a
// byte-identical re-run of `record-review.mjs <verdict>` to the plan-1528 re-pin path — an exit
// that runs BEFORE the runRecordFlow report hook where the wiki nudge lives (the two call sites
// asserted by test 8 above). So a session that re-runs record-review on a wiki-owned branch with
// no wiki marker yet got NO nudge on this exit and then hit the WIKI_CHECKPOINT land halt cold —
// precisely the case plan 3764 exists to remove.
test('record-review.mjs identicalReRecord (re-record of the SAME review) also prints the wiki-decision nudge — fix for finding 7c775d', () => {
  const slug = 'wiki-nudge-identical-rerecord';
  const r = makeRepoForRepin(slug);
  try {
    // plan 3958: seedShardDir configured, and the "wiki-owned change" is that shard's
    // chains.json — chainsChanged is wikiCheckpointNeeded's FIRST, pattern-independent check, so
    // this fixture doesn't need this checkout's real wikiSubjectPatterns (empty in the public
    // coord-kit) to fire the checkpoint.
    writeFileSync(
      join(r.mainDir, 'coord.config.json'),
      JSON.stringify({
        handoffLayout: 'sessions',
        handoffDir: 'docs/handoff',
        seedShardDir: 'backend/src/data/seed',
      }),
    );
    mkdirSync(join(r.wtDir, 'backend/src/data/seed'), { recursive: true });
    writeFileSync(join(r.wtDir, 'backend/src/data/seed/chains.json'), '{}\n');
    r.g(r.wtDir, 'add', '-A');
    r.g(r.wtDir, 'commit', '-qm', 'add chains registry entry');

    const first = runRRCapture(r.wtDir, ['PASS', '--slug', slug, '--no-push']);
    assert.equal(first.status, 0, first.stderr);

    // Re-record at the SAME HEAD with the SAME verdict/provenance: identicalReRecord() takes the
    // repin exit, not the normal record path.
    const second = runRRCapture(r.wtDir, ['PASS', '--slug', slug, '--no-push']);
    assert.equal(second.status, 0, second.stderr);
    assert.match(
      second.stderr,
      /re-record of the SAME review, not a new round/,
      'fixture invariant: the second call must actually take the identicalReRecord exit',
    );
    assert.match(
      second.stdout,
      /record-wiki\.mjs WROTE/,
      `expected the wiki-decision nudge on the identical-re-record exit; got:\n${second.stdout}\n---stderr---\n${second.stderr}`,
    );
  } finally {
    r.cleanup();
  }
});

// plan 3764 T1 item 6 review findings db4f45 + 8701ee (CONFIRMED, same defect from two angles):
// `--dry` must stay silent on the nudge — "The `--dry` path prints its `[dry] would write …` line
// and returns before the report hook; the nudge does not fire there, which is correct." The two
// runRecordFlow report-hook call sites get that for free (the hook never runs under --dry), but
// the identicalReRecord call site added for finding 7c775d sits ABOVE that protection, so
// `record-review PASS --dry` on a wiki-owned branch with an already-recorded identical review
// wrongly printed the actionable WROTE/SKIP block and claimed "the land will halt", despite the
// dry run making no changes at all.
test('record-review.mjs identicalReRecord under --dry stays silent on the wiki-decision nudge — fix for findings db4f45/8701ee', () => {
  const slug = 'wiki-nudge-identical-rerecord-dry';
  const r = makeRepoForRepin(slug);
  try {
    mkdirSync(join(r.wtDir, 'backend/scripts/price-pipeline'), { recursive: true });
    writeFileSync(join(r.wtDir, 'backend/scripts/price-pipeline/x.py'), 'x = 1\n');
    r.g(r.wtDir, 'add', '-A');
    r.g(r.wtDir, 'commit', '-qm', 'add price pipeline file');

    const first = runRRCapture(r.wtDir, ['PASS', '--slug', slug, '--no-push']);
    assert.equal(first.status, 0, first.stderr);

    // Re-record at the SAME HEAD, --dry this time: identicalReRecord() still takes the repin
    // exit (the identity check runs before --dry is even consulted), but nothing should print
    // about the wiki decision — --dry makes no changes, so there is nothing "due before landing".
    const second = runRRCapture(r.wtDir, ['PASS', '--slug', slug, '--no-push', '--dry']);
    // Exit code is unchanged from today's behavior — this fix only silences the nudge, it must
    // not alter what runRepinFlow itself decides or returns.
    assert.equal(second.status, 0, second.stderr);
    assert.match(
      second.stderr,
      /re-record of the SAME review, not a new round/,
      'fixture invariant: the second call must actually take the identicalReRecord exit',
    );
    assert.doesNotMatch(
      second.stdout,
      /record-wiki\.mjs/,
      `--dry must not print the wiki-decision nudge; got:\n${second.stdout}\n---stderr---\n${second.stderr}`,
    );
    assert.doesNotMatch(
      second.stdout,
      /⚠ wiki decision due/,
      `--dry must not print the wiki-decision nudge; got:\n${second.stdout}\n---stderr---\n${second.stderr}`,
    );
  } finally {
    r.cleanup();
  }
});
