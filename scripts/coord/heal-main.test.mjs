// scripts/heal-main.test.mjs  (plan 1286)
// Fixture tests for the ONE sanctioned main-checkout recovery path — every taxonomy entry
// detected and repaired idempotently — plus the new coord-git primitives it stands on
// (withCoordLock, reattachMainToMaster, sweepWorktreeIndexLocks, the coord-op journal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
  utimesSync,
  closeSync,
  openSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  healTruncatedIndex,
  healStaleIndex,
  healStaleLocks,
  healRebaseResidue,
  classifyAbandonedRebaseShape,
  classifyRebaseWindow,
  pidAlive,
  REBASE_ABANDONED_SHAPE_STALE_MS,
  CLOCK_SKEW_TOLERANCE_MS,
  healDetachedHead,
  healMasterSync,
  healDirt,
  reportInterruptedOps,
  probeHungCoordChildren,
  HUNG_COORD_CHILD_REPORT_AGE_MS,
  reportNeedsOperator,
  blockingSteps,
  runHeal,
  delegateSweeps,
  parseHealMainArgs,
} from './heal-main.mjs';
import { TRUNCATED_INDEX_HEAD_FLOOR } from './index-sanity.mjs';
import { nulBytes } from './corruption-guard.mjs';
import {
  withCoordLock,
  reattachMainToMaster,
  sweepWorktreeIndexLocks,
  journalCoordOp,
  readCoordOpJournal,
  coordOpJournalPath,
  coordLockPath,
  acquireCoordLock,
  releaseCoordLock,
  SWEEP_SURFACED_EXIT,
  coordCheckoutPath,
} from './coord-git.mjs';
import { withEnvVar } from '../test-helpers/with-env-var.mjs';
import { makeLargeRepo as buildLargeRepo, tornIndex } from '../test-helpers/torn-index-repo.mjs';

// plan 338: clear inherited GIT_* so `git -C <tmpdir>` honours the temp repo even when this
// suite runs inside a git hook.
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

// plan 3962 P1: jobOutputPrefixes now comes from THIS repo's coord.config.json (see
// main-checkout-allowlist.mjs's own header — the module is a pure zero-import leaf and no
// longer carries a hardcoded default). Mirrors pre-yield-guard.test.mjs's own makeRepo()
// fixture fix for the same seam.
const TEST_JOB_OUTPUT_PREFIXES = ['backend/data/data-pipeline/'];

// ── harness: bare origin + a work clone (acts as $MAIN on master) ──────────────────────
function makeRepo(seed = {}) {
  const root = mkdtempSync(join(tmpdir(), 'heal-main-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  const dir = join(root, 'work');
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, dir]);
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('config', 'user.email', 'work@t.t');
  g('config', 'user.name', 'work');
  g('config', 'commit.gpgsign', 'false');
  for (const [f, content] of Object.entries(seed)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), content);
  }
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  writeFileSync(join(dir, '.gitignore'), '.claude/\n');
  writeFileSync(
    join(dir, 'coord.config.json'),
    JSON.stringify({ jobOutputPrefixes: TEST_JOB_OUTPUT_PREFIXES }) + '\n',
  );
  g('add', '-A');
  g('commit', '-qm', 'base');
  g('push', '-q', 'origin', 'master');
  g('branch', '--set-upstream-to=origin/master', 'master');
  return { root, dir, origin, g, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const gAt = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });

// Plant a 0-byte lock file with an OLD mtime (a crash leftover).
function plantStaleLock(path, ageMs = 120_000) {
  closeSync(openSync(path, 'w'));
  const old = (Date.now() - ageMs) / 1000;
  utimesSync(path, old, old);
}

// Builds on top of makeRepo() with `fileCount` extra tracked files, so the tree clears the
// TRUNCATED_INDEX_HEAD_FLOOR the truncated-index predicate gates on (plan 3968). Shared with
// pre-yield-guard.test.mjs and index-sanity.test.mjs via test-helpers/torn-index-repo.mjs
// (plan 3968 review, a23554/1a2f55) — `tornIndex` is imported directly from there too.
function makeLargeRepo(fileCount) {
  return buildLargeRepo(makeRepo, fileCount);
}

// ── 0. truncated index (plan 3968) ──────────────────────────────────────────────────────
test('healTruncatedIndex: rebuilds a torn index from HEAD on a large tree', () => {
  const s = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    tornIndex(s.dir);
    const out = healTruncatedIndex(s.dir);
    assert.ok(out.some((x) => x.step === 'truncated-index' && x.status === 'fixed'));
    assert.equal(gAt(s.dir, 'status', '--porcelain').trim(), '', 'reset rebuilt the index');
    // idempotent — a second pass on the now-healthy repo reports clean.
    const out2 = healTruncatedIndex(s.dir);
    assert.ok(out2.every((x) => x.status === 'clean'));
  } finally {
    s.cleanup();
  }
});

test('healTruncatedIndex --dry: reports would-fix without touching anything', () => {
  const s = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    tornIndex(s.dir);
    const out = healTruncatedIndex(s.dir, { dry: true });
    assert.ok(out.some((x) => x.status === 'would-fix'));
    const porcelain = gAt(s.dir, 'status', '--porcelain');
    assert.ok(
      porcelain.split('\n').length > TRUNCATED_INDEX_HEAD_FLOOR,
      'dry run must not have rebuilt the still-torn index',
    );
  } finally {
    s.cleanup();
  }
});

test('healTruncatedIndex: spares a truncated index while a LIVE index.lock is present', () => {
  const s = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  const lock = join(s.dir, '.git', 'index.lock');
  try {
    tornIndex(s.dir);
    closeSync(openSync(lock, 'w'));
    const out = healTruncatedIndex(s.dir);
    assert.ok(
      out.some((x) => x.status === 'clean' && /index\.lock is present/.test(x.detail)),
      'must report spared, not fixed, while a lock is live',
    );
    // plan 3968 review round 2 (f420dd): the runHeal retry keys on this STRUCTURED flag, never
    // on matching the human-readable `detail` string above — pin that the flag is actually set.
    assert.ok(
      out.some((x) => x.sparedForLock === true),
      'must carry the structured sparedForLock flag the runHeal retry keys on',
    );
    assert.ok(existsSync(lock), 'a live lock is never deleted by this step');
  } finally {
    rmSync(lock, { force: true });
    s.cleanup();
  }
});

// plan 3968 review round 2 (6f8265), reporting fixed round 3 (f2095d): a probe-error `unknown`
// verdict must never be read as "index OK" — this pins healTruncatedIndex's own arm for it, via
// the `exec` testability seam (mirrors index-sanity.test.mjs's own injected-exec pattern) rather
// than trying to reproduce a real git-level failure isolated to exactly one subcommand on disk.
// Round 3: the report itself must be 'blocked' (not 'clean' plus a side flag) — the CLI's own
// `main()` only treats a literal 'blocked' status as unsafe, so a `status: 'clean'` result here
// used to let heal-main print "all clean" while the index was never actually verified.
test('healTruncatedIndex: a probe-error unknown verdict is reported blocked, never clean or reset', () => {
  const s = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    tornIndex(s.dir); // low index count vs HEAD — would otherwise resolve truncated:true
    const flaky = (...a) => {
      const args = a[1];
      if (Array.isArray(args) && args.includes('diff') && args.includes('--diff-filter=D')) {
        throw new Error('simulated staged-deletion probe failure');
      }
      return execFileSync(...a);
    };
    const out = healTruncatedIndex(s.dir, { exec: flaky });
    assert.ok(
      out.some((x) => x.status === 'blocked' && /index state could not be verified/.test(x.detail)),
      `expected a 'blocked' report naming the unverifiable index state, got: ${JSON.stringify(out)}`,
    );
    assert.ok(
      !out.some((x) => x.status === 'clean'),
      'must never report clean for an unverified index',
    );
    assert.ok(out.some((x) => x.indexStateUnknown === true));
    assert.notEqual(
      gAt(s.dir, 'status', '--porcelain').trim(),
      '',
      'must NOT have reset the index — the probe failure means this step cannot tell if it should',
    );
  } finally {
    s.cleanup();
  }
});

// plan 3968 review (15a097): a torn index spared for a lock in step 0, where that lock turns
// out to be STALE, must get repaired in the SAME run once healStaleLocks removes it — not
// require a second manual heal-main invocation. This exercises runHeal (the composition), not
// healTruncatedIndex alone, since the retry lives in runHeal's own step ordering.
test('runHeal: a torn index spared for a stale lock in step 0 is repaired once healStaleLocks clears it', () => {
  const s = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  const lock = join(s.dir, '.git', 'index.lock');
  try {
    tornIndex(s.dir);
    plantStaleLock(lock, 120_000); // stale (not live) — healStaleLocks will remove it
    const report = runHeal(s.dir, { log: () => {} });
    const truncatedSteps = report.filter((x) => x.step === 'truncated-index');
    assert.ok(
      truncatedSteps.some((x) => x.status === 'fixed'),
      `expected the retry to repair the index once the stale lock cleared, got: ${JSON.stringify(truncatedSteps)}`,
    );
    assert.ok(!existsSync(lock), 'the stale lock itself was removed');
    assert.equal(gAt(s.dir, 'status', '--porcelain').trim(), '', 'index rebuilt clean');
  } finally {
    rmSync(lock, { force: true });
    s.cleanup();
  }
});

// plan 3968 review round 2 (f420dd): the retry must NOT fire off a mere "spared" verdict when
// healStaleLocks did not actually remove anything (a genuinely LIVE/fresh lock) — the old
// detail-string match retried unconditionally here too (it was, per the module's own former
// comment, "always safe" as a no-op), but the structured-field version should simply never
// attempt the retry in this shape at all.
test('runHeal: a torn index spared for a FRESH (live) lock is NOT retried — the lock was never removed', () => {
  const s = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  const lock = join(s.dir, '.git', 'index.lock');
  try {
    tornIndex(s.dir);
    closeSync(openSync(lock, 'w')); // fresh (live-looking) lock — healStaleLocks must spare it
    const report = runHeal(s.dir, { log: () => {} });
    const truncatedSteps = report.filter((x) => x.step === 'truncated-index');
    assert.ok(
      truncatedSteps.every((x) => x.status !== 'fixed'),
      `a live lock must never be reset over: ${JSON.stringify(truncatedSteps)}`,
    );
    assert.ok(existsSync(lock), 'the fresh lock itself must survive untouched');
  } finally {
    rmSync(lock, { force: true });
    s.cleanup();
  }
});

test('healTruncatedIndex: does nothing on a healthy large repo', () => {
  const s = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    const out = healTruncatedIndex(s.dir);
    assert.deepEqual(out, [{ step: 'truncated-index', status: 'clean', detail: out[0].detail }]);
    assert.match(out[0].detail, /index OK/);
  } finally {
    s.cleanup();
  }
});

test('healTruncatedIndex: does nothing on a small repo (below the path floor)', () => {
  const s = makeRepo(); // well under TRUNCATED_INDEX_HEAD_FLOOR
  try {
    const out = healTruncatedIndex(s.dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'clean');
    assert.match(out[0].detail, /below the \d+-path floor/);
  } finally {
    s.cleanup();
  }
});

// ── 0b. stale index (plan 4026) ─────────────────────────────────────────────────────────
// Reproduces the 2026-09-14 shape exactly: a park killed between `git stash push`'s working-tree
// rewrite and its index write, leaving disk == HEAD while the index still holds a staged rename
// and a staged deletion. `git mv` + `git rm --cached` build the index side; moving the renamed
// file back with plain fs (NOT `git checkout`, which would rewrite the index too) restores the
// disk side without disturbing it.
function stageRenameAndDeleteThenRestoreDisk(s) {
  mkdirSync(join(s.dir, 'a'), { recursive: true });
  writeFileSync(join(s.dir, 'a', 'x.md'), 'x\n');
  writeFileSync(join(s.dir, 'z.md'), 'z\n');
  s.g('add', '-A');
  s.g('commit', '-qm', 'seed stale-index fixture');
  s.g('mv', 'a/x.md', 'c-x.md');
  s.g('rm', '-q', '--cached', 'z.md');
  renameSync(join(s.dir, 'c-x.md'), join(s.dir, 'a', 'x.md'));
}

test('healStaleIndex: resets an index staler than HEAD while every path matches HEAD on disk', () => {
  const s = makeRepo();
  try {
    stageRenameAndDeleteThenRestoreDisk(s);
    const dryOut = healStaleIndex(s.dir, { dry: true });
    assert.equal(dryOut.length, 1);
    assert.equal(dryOut[0].status, 'would-fix');
    assert.match(dryOut[0].detail, /git reset \(mixed\)/);
    // --dry changed nothing: the index is still stale.
    assert.notEqual(gAt(s.dir, 'write-tree').trim(), gAt(s.dir, 'rev-parse', 'HEAD^{tree}').trim());

    const out = healStaleIndex(s.dir);
    assert.equal(out[0].status, 'fixed');
    assert.match(out[0].detail, /rebuilt a stale index from HEAD/);
    assert.equal(gAt(s.dir, 'status', '--porcelain').trim(), '');
    // Idempotent: a second pass has nothing to do.
    assert.equal(healStaleIndex(s.dir)[0].status, 'clean');
  } finally {
    s.cleanup();
  }
});

test('healStaleIndex: a differing path that is REAL dirt on disk is named and nothing is touched', () => {
  const s = makeRepo();
  try {
    stageRenameAndDeleteThenRestoreDisk(s);
    // One of the differing paths now holds content HEAD does not have — a live edit, not the
    // killed-stash residue. A reset here would unstage it silently; refuse instead.
    writeFileSync(join(s.dir, 'z.md'), 'z\nreal live edit\n');
    const before = gAt(s.dir, 'write-tree').trim();
    const out = healStaleIndex(s.dir);
    assert.equal(out[0].status, 'clean');
    assert.match(out[0].detail, /z\.md is real dirt/);
    assert.match(out[0].detail, /not touched/);
    assert.deepEqual(out[0].realDirt, ['z.md']);
    assert.equal(gAt(s.dir, 'write-tree').trim(), before, 'index must be untouched');
  } finally {
    s.cleanup();
  }
});

test('healStaleIndex: a staged ADD whose file is on disk is real work — not touched', () => {
  const s = makeRepo();
  try {
    writeFileSync(join(s.dir, 'new.md'), 'brand new\n');
    s.g('add', 'new.md');
    const before = gAt(s.dir, 'write-tree').trim();
    const out = healStaleIndex(s.dir);
    assert.equal(out[0].status, 'clean');
    assert.match(out[0].detail, /new\.md is real dirt/);
    assert.equal(gAt(s.dir, 'write-tree').trim(), before);
  } finally {
    s.cleanup();
  }
});

// Review round 1 (findings 9f18f8 / de70a0 / 650746 / c8a775): the disk check alone is not
// enough. In all three shapes below disk == HEAD, so the disk half passes — and the ONLY copy of
// real work is in the index, which a reset would destroy.
test('healStaleIndex: a staged EDIT whose worktree copy is back at HEAD is not touched', () => {
  const s = makeRepo();
  try {
    writeFileSync(join(s.dir, 'base.txt'), 'base\nstaged edit\n');
    s.g('add', 'base.txt');
    writeFileSync(join(s.dir, 'base.txt'), 'base\n'); // disk back to HEAD, edit only in the index
    const before = gAt(s.dir, 'write-tree').trim();
    const out = healStaleIndex(s.dir);
    assert.equal(out[0].status, 'clean');
    assert.match(out[0].detail, /base\.txt is real dirt/);
    assert.equal(gAt(s.dir, 'write-tree').trim(), before, 'the staged edit must survive');
  } finally {
    s.cleanup();
  }
});

test('healStaleIndex: a staged ADD whose worktree copy was deleted is not touched', () => {
  const s = makeRepo();
  try {
    writeFileSync(join(s.dir, 'only-in-index.md'), 'the only copy\n');
    s.g('add', 'only-in-index.md');
    rmSync(join(s.dir, 'only-in-index.md')); // index now holds the sole copy
    const before = gAt(s.dir, 'write-tree').trim();
    const out = healStaleIndex(s.dir);
    assert.equal(out[0].status, 'clean');
    assert.match(out[0].detail, /only-in-index\.md is real dirt/);
    assert.equal(gAt(s.dir, 'write-tree').trim(), before, 'the staged file must survive');
  } finally {
    s.cleanup();
  }
});

test('healStaleIndex: a staged MODE change is not reverted even when the bytes match HEAD', () => {
  const s = makeRepo();
  try {
    // A chmod is a real staged change whose blob is unchanged, so only the mode comparison
    // catches it (findings 2089fb / a3f227 / b66f24). git tracks the bit on every platform via
    // `update-index --chmod`, so this does not depend on the filesystem honouring it.
    s.g('update-index', '--chmod=+x', 'base.txt');
    const before = gAt(s.dir, 'write-tree').trim();
    const out = healStaleIndex(s.dir);
    assert.equal(out[0].status, 'clean');
    assert.match(out[0].detail, /base\.txt is real dirt/);
    assert.equal(gAt(s.dir, 'write-tree').trim(), before, 'the staged mode must survive');
  } finally {
    s.cleanup();
  }
});

// Review round 2 (findings at :337, six angles including the Claude arm): "this blob exists
// somewhere in HEAD" is not a rename. A staged file may coincidentally carry a committed file's
// bytes while being genuine new work at its own path.
test('healStaleIndex: a staged file sharing an UNRELATED committed file bytes is not touched', () => {
  const s = makeRepo();
  try {
    writeFileSync(join(s.dir, 'twin.md'), 'shared bytes\n');
    s.g('add', 'twin.md');
    s.g('commit', '-qm', 'seed twin');
    // A brand-new staged path whose content equals twin.md's — no rename, no deletion anywhere.
    writeFileSync(join(s.dir, 'doppelganger.md'), 'shared bytes\n');
    s.g('add', 'doppelganger.md');
    rmSync(join(s.dir, 'doppelganger.md')); // disk == HEAD; index holds the sole copy
    const before = gAt(s.dir, 'write-tree').trim();
    const out = healStaleIndex(s.dir);
    assert.equal(out[0].status, 'clean');
    assert.match(out[0].detail, /doppelganger\.md is real dirt/);
    assert.equal(gAt(s.dir, 'write-tree').trim(), before, 'no rename source ⇒ not a rename');
  } finally {
    s.cleanup();
  }
});

// Review round 2 (findings at :341, four angles): a rename destination is absent from HEAD, so
// the round-1 mode comparison (which needed a HEAD entry AT that path) never ran on it.
test('healStaleIndex: a staged rename that also CHMODs is not touched', () => {
  const s = makeRepo();
  try {
    mkdirSync(join(s.dir, 'a'), { recursive: true });
    writeFileSync(join(s.dir, 'a', 'x.md'), 'x\n');
    s.g('add', '-A');
    s.g('commit', '-qm', 'seed rename-chmod fixture');
    s.g('mv', 'a/x.md', 'c-x.md');
    s.g('update-index', '--chmod=+x', 'c-x.md'); // same bytes, different mode
    renameSync(join(s.dir, 'c-x.md'), join(s.dir, 'a', 'x.md'));
    const before = gAt(s.dir, 'write-tree').trim();
    const out = healStaleIndex(s.dir);
    assert.equal(out[0].status, 'clean');
    assert.match(out[0].detail, /c-x\.md is real dirt/);
    assert.equal(gAt(s.dir, 'write-tree').trim(), before, 'the staged mode must survive');
  } finally {
    s.cleanup();
  }
});

test('healStaleIndex: refuses over the path cap and says so, never as a health verdict', () => {
  const s = makeRepo();
  try {
    stageRenameAndDeleteThenRestoreDisk(s);
    const before = gAt(s.dir, 'write-tree').trim();
    const out = healStaleIndex(s.dir, { maxPaths: 1 });
    // `blocked`, never `clean`: the CLI reads any other status as verified-healthy and prints
    // "all clean" over an index nothing checked (review round 2).
    assert.equal(out[0].status, 'blocked');
    assert.equal(out[0].refusedOverCap, true);
    assert.match(out[0].detail, /verification cap/);
    assert.equal(gAt(s.dir, 'write-tree').trim(), before);
  } finally {
    s.cleanup();
  }
});

// Review round 3 (finding at :286): an index nothing could verify makes `git status` lie, and
// every step below reasons from `git status`. A conflicted merge is the cheapest real fixture for
// an index `write-tree` refuses.
test('healStaleIndex: an unmergeable index is BLOCKED and halts the rest of the run', () => {
  const s = makeRepo();
  try {
    s.g('checkout', '-q', '-b', 'side');
    writeFileSync(join(s.dir, 'base.txt'), 'side\n');
    s.g('commit', '-qam', 'side edit');
    s.g('checkout', '-q', 'master');
    writeFileSync(join(s.dir, 'base.txt'), 'master\n');
    s.g('commit', '-qam', 'master edit');
    try {
      s.g('merge', 'side');
    } catch {
      /* expected: conflict leaves unmerged index entries */
    }
    const out = healStaleIndex(s.dir);
    assert.equal(out[0].status, 'blocked');
    assert.equal(out[0].unmergeableIndex, true);

    const report = runHeal(s.dir, { dry: true });
    assert.ok(
      report.some((x) => x.step === 'stale-index' && x.status === 'blocked'),
      'the blocked stale-index verdict reaches the report',
    );
    assert.ok(
      report.some((x) => x.step === 'index-preflight-halt' && x.status === 'blocked'),
      'the halt is reported, not silent',
    );
    for (const step of ['master-sync', 'dirt', 'sweeps', 'rebase-residue', 'detached-head'])
      assert.ok(
        !report.some((x) => x.step === step),
        `${step} must not run on an index nothing verified`,
      );
  } finally {
    s.cleanup();
  }
});

// Review round 4 (finding at :1421): a spare that SURVIVES the post-lock-cleanup retry means the
// lock was genuinely live, so nothing verified the index — the run must stop rather than let
// master-sync and the dirt park reason from a `git status` it may be making lie. (A STALE lock is
// the other path and is covered by the wedged-repo test: healStaleLocks removes it, the retry
// runs, and the heal completes.)
test('runHeal: a LIVE index.lock leaves the index unverified and halts the run', () => {
  const s = makeRepo();
  try {
    plantStaleLock(join(s.dir, '.git', 'index.lock'), 0); // fresh ⇒ healStaleLocks spares it
    const report = runHeal(s.dir, { dry: true, log: () => {} });
    assert.ok(
      report.some((x) => x.step === 'stale-index' && x.sparedForLock),
      'the spare stands',
    );
    const halt = report.find((x) => x.step === 'index-preflight-halt');
    assert.ok(halt, 'the halt is reported, not silent');
    assert.equal(halt.status, 'blocked');
    assert.match(halt.detail, /stale-index/);
    for (const step of ['master-sync', 'dirt', 'sweeps'])
      assert.ok(!report.some((x) => x.step === step), `${step} must not run`);
  } finally {
    s.cleanup();
  }
});

test('healStaleIndex: an index matching HEAD is reported clean', () => {
  const s = makeRepo();
  try {
    const out = healStaleIndex(s.dir);
    assert.equal(out[0].status, 'clean');
    assert.match(out[0].detail, /matches HEAD/);
  } finally {
    s.cleanup();
  }
});

test('healStaleIndex: spares a stale index while an index.lock is present', () => {
  const s = makeRepo();
  try {
    stageRenameAndDeleteThenRestoreDisk(s);
    // Capture the stale tree BEFORE planting the lock — `git write-tree` itself needs the lock.
    const before = gAt(s.dir, 'write-tree').trim();
    const lock = join(s.dir, '.git', 'index.lock');
    plantStaleLock(lock, 120_000);
    const out = healStaleIndex(s.dir);
    assert.equal(out[0].status, 'clean');
    assert.match(out[0].detail, /index\.lock is present/);
    assert.equal(out[0].sparedForLock, true);
    rmSync(lock);
    assert.equal(gAt(s.dir, 'write-tree').trim(), before, 'index must be untouched');
  } finally {
    s.cleanup();
  }
});

// ── 1. stale locks ───────────────────────────────────────────────────────────────────────
test('healStaleLocks: removes a stale MAIN index.lock, spares a fresh one', () => {
  const s = makeRepo();
  try {
    const lock = join(s.dir, '.git', 'index.lock');
    plantStaleLock(lock, 120_000);
    const out = healStaleLocks(s.dir);
    assert.ok(out.some((x) => x.status === 'fixed' && /main index\.lock/.test(x.detail)));
    // plan 3968 review round 2 (f420dd): the runHeal retry keys on this structured flag.
    assert.ok(
      out.some((x) => x.removedMainLock === true),
      'must carry the structured removedMainLock flag the runHeal retry keys on',
    );
    assert.ok(!existsSync(lock), 'stale lock removed');

    closeSync(openSync(lock, 'w')); // fresh lock (mtime = now)
    const out2 = healStaleLocks(s.dir);
    assert.ok(out2.some((x) => x.status === 'clean' && /fresh/.test(x.detail)));
    assert.ok(
      !out2.some((x) => x.removedMainLock),
      'a fresh (spared) lock must never carry removedMainLock',
    );
    assert.ok(existsSync(lock), 'fresh lock spared');
    rmSync(lock);
  } finally {
    s.cleanup();
  }
});

// ── plan 4087 round-4 review (keys 1be773/108be0/efcdd2): a STALE lock whose delete itself FAILS
// (a live handle denies removal — EPERM/EBUSY on Windows) used to be misreported or dropped
// entirely, never surfaced as the blocker it actually is. Pinned via the injectable
// `_sweepWorktreeIndexLocks`/`_clearStaleIndexLockDetailed` seams rather than a real undeletable
// file, since reproducing that failure mode for real is Windows-handle-dependent and flaky.
test('healStaleLocks: a WORKTREE lock whose delete fails is reported blocked, never "fresh (spared)"', () => {
  const s = makeRepo();
  try {
    const out = healStaleLocks(s.dir, {
      _sweepWorktreeIndexLocks: () => [
        {
          lockPath: join(s.dir, '.git', 'worktrees', 'wt', 'index.lock'),
          ageMs: 999_000,
          removed: false,
          deleteFailed: true,
          outcome: 'delete-failed',
          error: new Error('EBUSY: resource busy or locked'),
        },
      ],
    });
    assert.ok(
      out.some((x) => x.status === 'blocked' && /delete itself failed/.test(x.detail)),
      'a stale-but-undeletable lock must be reported blocked, naming the real failure',
    );
    assert.ok(
      !out.some((x) => x.status === 'clean' && /index\.lock fresh \(spared\)/.test(x.detail)),
      'must never be misreported as the CLEAN "fresh (spared)" case — it is provably stale, the delete failed',
    );
  } finally {
    s.cleanup();
  }
});

test('healStaleLocks: a MAIN index.lock whose delete fails is reported blocked, never silently dropped', () => {
  const s = makeRepo();
  const lock = join(s.dir, '.git', 'index.lock');
  try {
    plantStaleLock(lock, 120_000); // provably stale by mtime
    const out = healStaleLocks(s.dir, {
      _clearStaleIndexLockDetailed: () => ({
        removed: false,
        outcome: 'delete-failed',
        path: lock,
        ageMs: 120_000,
        error: new Error('EBUSY: resource busy or locked'),
      }),
    });
    assert.ok(
      out.some((x) => x.status === 'blocked' && /delete itself failed/.test(x.detail)),
      'the old code pushed NOTHING for this case, which could fall through to "no index.lock anywhere"',
    );
    assert.ok(
      !out.some((x) => x.status === 'clean' && /no index\.lock anywhere/.test(x.detail)),
      'a provably-stale lock that failed to delete must never be reported as no lock at all',
    );
  } finally {
    rmSync(lock, { force: true });
    s.cleanup();
  }
});

test('healStaleLocks: clears a WORKTREE lock from the MAIN checkout (the clear-stale no-op bug)', () => {
  const s = makeRepo();
  try {
    gAt(s.dir, 'worktree', 'add', '-q', join(s.root, 'wt'), '-b', 'worktree-x');
    const wtLock = join(s.dir, '.git', 'worktrees', 'wt', 'index.lock');
    plantStaleLock(wtLock, 60_000);
    // dry first: reports would-fix, does not remove
    const dry = healStaleLocks(s.dir, { dry: true });
    assert.ok(dry.some((x) => x.status === 'would-fix' && x.detail.includes('worktree')));
    assert.ok(existsSync(wtLock), 'dry run must not remove');
    // real run clears it — invoked FROM the main checkout (the exact case that used to no-op)
    const out = healStaleLocks(s.dir);
    assert.ok(out.some((x) => x.status === 'fixed' && /worktree index\.lock/.test(x.detail)));
    assert.ok(!existsSync(wtLock));
  } finally {
    s.cleanup();
  }
});

// plan 2493: heal-main's private `commonDir` used to resolve via the UNSCRUBBED coord-git `git()`
// helper instead of the shared resolveCommonDirPath (lock-path.mjs, plan 2478/2489) -- a poisoned
// GIT_DIR could redirect it onto a FOREIGN repo's common dir, so healStaleLocks would silently
// miss `s.dir`'s OWN stale lock (looking at the wrong, lock-free foreign path instead). This pins
// the migration: `s.dir`'s real stale lock must still be found and fixed with GIT_DIR poisoned.
test('healStaleLocks: a poisoned GIT_DIR does not divert resolution away from mainDir', () => {
  const s = makeRepo();
  const foreign = makeRepo(); // has no lock file at all — if resolution were diverted here, nothing would be found
  const lock = join(s.dir, '.git', 'index.lock');
  plantStaleLock(lock, 120_000);
  try {
    withEnvVar({ GIT_DIR: join(foreign.dir, '.git') }, () => {
      const out = healStaleLocks(s.dir);
      assert.ok(
        out.some((x) => x.status === 'fixed' && /main index\.lock/.test(x.detail)),
        "s.dir's own stale lock must still be found and fixed despite the poisoned GIT_DIR",
      );
      assert.ok(!existsSync(lock), 'stale lock removed');
    });
  } finally {
    s.cleanup();
    foreign.cleanup();
  }
});

test('sweepWorktreeIndexLocks: never touches the shared MAIN index.lock', () => {
  const s = makeRepo();
  try {
    const mainLock = join(s.dir, '.git', 'index.lock');
    plantStaleLock(mainLock, 600_000);
    const swept = sweepWorktreeIndexLocks(s.dir, { staleMs: 0 });
    assert.equal(swept.length, 0, 'no worktrees → nothing swept');
    assert.ok(existsSync(mainLock), 'main lock untouched by the worktree sweep');
    rmSync(mainLock);
  } finally {
    s.cleanup();
  }
});

// ── 2. rebase residue ────────────────────────────────────────────────────────────────────
test('healRebaseResidue: aborts a real interrupted rebase (killed pushMasterWithRebase shape)', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    // sibling pushes a conflicting change to origin
    const sib = join(s.root, 'sib');
    execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', s.origin, sib]);
    gAt(sib, 'config', 'user.email', 's@t.t');
    gAt(sib, 'config', 'user.name', 's');
    writeFileSync(join(sib, 'doc.md'), 'SIBLING\n');
    gAt(sib, 'commit', '-aqm', 'sibling');
    gAt(sib, 'push', '-q', 'origin', 'master');
    // our local commit conflicts; a rebase attempt stops mid-flight (= the killed rebase state)
    writeFileSync(join(s.dir, 'doc.md'), 'OURS\n');
    s.g('commit', '-aqm', 'ours');
    s.g('fetch', '-q', 'origin', 'master');
    assert.throws(() => s.g('rebase', 'origin/master')); // conflict → rebase-merge left behind
    const residueDir = join(s.dir, '.git', 'rebase-merge');
    assert.ok(existsSync(residueDir));

    // F-002 (plan 1312): journal-less FRESH residue is what a LIVE unlocked (hand) rebase can
    // look like from the outside — it must be SPARED, never aborted (the untested
    // live-rebase abort race).
    const live = healRebaseResidue(s.dir);
    assert.equal(live[0].status, 'clean');
    assert.match(live[0].detail, /spared/);
    assert.ok(existsSync(residueDir), 'live rebase state must not be aborted');

    // Backdate the residue past the HUMAN-timescale gate (15 min — git does not touch the
    // residue dir's mtime while a human sits mid-conflict, so a lock-style 30s threshold
    // would abort a live hand rebase) → now it is a provably-dead leftover.
    // backdate the WHOLE residue: both gates read the freshest of the dir and the files git
    // rewrites as a rebase advances, so a dir-only backdate still reads as a live rebase.
    backdateResidue(residueDir, 16 * 60_000);
    const dry = healRebaseResidue(s.dir, { dry: true });
    assert.equal(dry[0].status, 'would-fix');
    assert.ok(existsSync(residueDir), 'dry run must not remove');
    const out = healRebaseResidue(s.dir);
    assert.equal(out[0].status, 'fixed');
    assert.ok(!existsSync(residueDir), 'rebase state cleared');
    // idempotent
    assert.equal(healRebaseResidue(s.dir)[0].status, 'clean');
  } finally {
    s.cleanup();
  }
});

test('healRebaseResidue: journal pid-liveness — a dead push-rebase owner aborts IMMEDIATELY, a live one is spared past any age', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    // conflict → rebase-merge left behind (same shape as the killed-pushMasterWithRebase test)
    const sib = join(s.root, 'sib');
    execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', s.origin, sib]);
    gAt(sib, 'config', 'user.email', 's@t.t');
    gAt(sib, 'config', 'user.name', 's');
    writeFileSync(join(sib, 'doc.md'), 'SIBLING\n');
    gAt(sib, 'commit', '-aqm', 'sibling');
    gAt(sib, 'push', '-q', 'origin', 'master');
    writeFileSync(join(s.dir, 'doc.md'), 'OURS\n');
    s.g('commit', '-aqm', 'ours');
    s.g('fetch', '-q', 'origin', 'master');
    assert.throws(() => s.g('rebase', 'origin/master'));
    const residueDir = join(s.dir, '.git', 'rebase-merge');
    assert.ok(existsSync(residueDir));

    // An OPEN push-rebase journal window (as pushMasterWithRebase now writes around every
    // rebase attempt) — pid/host auto-stamped as OUR live process.
    journalCoordOp(s.dir, { tool: 'push-rebase', token: 'w-1312', phase: 'start' });

    // Live owner: spared even when the residue mtime is ancient (mtime is not the signal).
    const old = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(residueDir, old, old);
    const spared = healRebaseResidue(s.dir, { _alive: () => true });
    assert.equal(spared[0].status, 'clean');
    assert.match(spared[0].detail, /LIVE push-rebase/);
    assert.ok(existsSync(residueDir), 'a live owner must never be aborted');

    // Dead owner: aborted immediately even with a FRESH mtime — no 15-min wedge window for
    // the common tool-timeout-SIGKILL case.
    utimesSync(residueDir, Date.now() / 1000, Date.now() / 1000);
    const dry = healRebaseResidue(s.dir, { dry: true, _alive: () => false });
    assert.equal(dry[0].status, 'would-fix');
    // plan 2948: the window's OWN classification is reported, not a generic "owner pid dead" —
    // a dead pid and a RECYCLED one are different findings and now read differently.
    assert.match(dry[0].detail, /pid \d+ is dead/);
    assert.match(dry[0].detail, /open push-rebase journal window/);
    const out = healRebaseResidue(s.dir, { _alive: () => false });
    assert.equal(out[0].status, 'fixed');
    assert.ok(
      !existsSync(residueDir),
      'dead-owner residue cleared without waiting out the age gate',
    );
  } finally {
    s.cleanup();
  }
});

// ── 2b. abandoned-shape signal (plan 2939) ───────────────────────────────────────────────
// Signals (1) journal-liveness and (2) the 15-min human gate both miss a session's OWN raw
// `git rebase` / `git pull --rebase`: it journals nothing and it is not a human. Signal (3)
// reads the residue's SHAPE instead. Every fixture below is REAL git state (git drives every
// stop); the shapes were derived by inspecting actual interrupted rebases, not from prose.
//
// The one reconstruction is `plantAbandonedRebase`, which reaches a genuine `break` stop and
// then drops the trailing `break` line from `done`. That is exactly the on-disk state a
// SIGKILLed rebase leaves — verified against a real one (a merge driver running
// `kill -9 $PPID` mid-pick: rebase exits 137, leaving a clean tracked tree, no `amend` /
// `stopped-sha` / `message` / `patch`, and `done` ending in the `pick`). It is reconstructed
// rather than killed live because killing a process mid-git is neither deterministic nor
// portable, and this suite also runs on Windows at the pre-push gate.
//
// Deliberately NOT asserted anywhere: the todo/done CONSUMPTION state. A real kill leaves the
// entry in `git-rebase-todo` only, in `done` only, or in BOTH depending on where it landed —
// all three were observed. It is a race window, not a signature.

// A `GIT_SEQUENCE_EDITOR` that needs no shell quoting: relative path, no spaces, no
// backslashes (git runs the editor from the top of the working tree).
function armSequenceEditor(dir) {
  writeFileSync(
    join(dir, 'seq-editor.cjs'),
    `const fs = require('fs');
const p = process.argv[2];
const lines = fs.readFileSync(p, 'utf8').split('\\n');
const i = lines.findIndex((l) => /^(pick|p) /.test(l));
if (process.env.SEQ_MODE === 'edit-first') lines[i] = lines[i].replace(/^\\S+/, 'edit');
else lines.splice(i + 1, 0, 'break');
fs.writeFileSync(p, lines.join('\\n'));
`,
  );
  return { GIT_SEQUENCE_EDITOR: 'node seq-editor.cjs' };
}

// A sibling advances origin/master on a DISJOINT file, so our local commits replay cleanly.
function seedReplayableRebase(s, { conflicting = false } = {}) {
  const sib = join(s.root, `sib-${Math.random().toString(36).slice(2)}`);
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', s.origin, sib]);
  gAt(sib, 'config', 'user.email', 's@t.t');
  gAt(sib, 'config', 'user.name', 's');
  writeFileSync(join(sib, conflicting ? 'doc.md' : 'sibling.txt'), 'SIBLING\n');
  gAt(sib, 'add', '-A');
  gAt(sib, 'commit', '-qm', 'sibling');
  gAt(sib, 'push', '-q', 'origin', 'master');
  writeFileSync(join(s.dir, conflicting ? 'doc.md' : 'ours-1.txt'), 'OURS\n');
  s.g('add', '-A');
  s.g('commit', '-qm', 'ours-1');
  writeFileSync(join(s.dir, 'ours-2.txt'), 'OURS2\n');
  s.g('add', '-A');
  s.g('commit', '-qm', 'ours-2');
  s.g('fetch', '-q', 'origin', 'master');
}

// Stop the sequencer for real, then reconstruct the killed-mid-pick `done` (see block above).
function plantAbandonedRebase(s) {
  seedReplayableRebase(s);
  const env = { ...process.env, ...armSequenceEditor(s.dir) };
  execFileSync('git', ['-C', s.dir, 'rebase', '-i', 'origin/master'], { env, encoding: 'utf8' });
  const dir = join(s.dir, '.git', 'rebase-merge');
  const donePath = join(dir, 'done');
  writeFileSync(
    donePath,
    readFileSync(donePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() && l.trim() !== 'break')
      .join('\n') + '\n',
  );
  return dir;
}

// Age the whole residue — the dir AND everything in it. Both gates read the FRESHEST of the
// dir and the files git rewrites as a rebase advances, so backdating the directory alone
// leaves e.g. `msgnum` fresh and the residue correctly reads as live. In the field these age
// together (git stops writing when the rebase stops); only a synthetic backdate can split them.
function backdateResidue(dir, ageMs) {
  const t = (Date.now() - ageMs) / 1000;
  for (const p of [dir, ...readdirSync(dir).map((f) => join(dir, f))])
    if (existsSync(p)) utimesSync(p, t, t);
}

test('healRebaseResidue: a session OWN dead raw rebase is cleared without the 15-min wait', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    const dir = plantAbandonedRebase(s);
    assert.ok(existsSync(dir));

    // The measured incident's own reading — 101s idle, no journal entry at all. It is
    // RECOGNISED as the abandoned shape (no human-stop reason is offered) but is still inside
    // the liveness window, so the verdict names the window rather than a person. The operator
    // re-runs heal-main, as the spare message tells them to, and clears it ~80s later instead
    // of 15 minutes later.
    backdateResidue(dir, 101_000);
    const atIncident = classifyAbandonedRebaseShape(s.dir, join(s.dir, '.git'), ['rebase-merge']);
    assert.equal(atIncident.abandoned, false);
    assert.match(atIncident.why, /abandoned shape, but written/);
    assert.equal(healRebaseResidue(s.dir)[0].status, 'clean');
    assert.ok(existsSync(dir));

    // Past the liveness window — still an order of magnitude inside the human gate, which is
    // the whole point of the signal.
    backdateResidue(dir, REBASE_ABANDONED_SHAPE_STALE_MS + 5_000);
    assert.ok(
      REBASE_ABANDONED_SHAPE_STALE_MS + 5_000 < 15 * 60_000,
      'the fixture must stay well inside the human gate, or it proves nothing',
    );
    const shape = classifyAbandonedRebaseShape(s.dir, join(s.dir, '.git'), ['rebase-merge']);
    assert.equal(shape.abandoned, true, shape.why);

    const dry = healRebaseResidue(s.dir, { dry: true });
    assert.equal(dry[0].status, 'would-fix');
    assert.match(dry[0].detail, /abandoned shape/);
    assert.ok(existsSync(dir), 'dry run must not remove');

    const out = healRebaseResidue(s.dir);
    assert.equal(out[0].status, 'fixed');
    assert.ok(!existsSync(dir), 'the dead raw rebase is cleared');
    // and the abort actually recovered the checkout, not just deleted bookkeeping
    assert.equal(s.g('symbolic-ref', '--short', 'HEAD').trim(), 'master');
    assert.equal(s.g('status', '--porcelain', '--untracked-files=no').trim(), '');
    assert.equal(healRebaseResidue(s.dir)[0].status, 'clean'); // idempotent
  } finally {
    s.cleanup();
  }
});

test('healRebaseResidue: an abandoned SHAPE that is still fresh is spared — a live rebase looks identical between picks', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    const dir = plantAbandonedRebase(s);
    // Freshly written: indistinguishable from a rebase that is mid-pick RIGHT NOW, which
    // re-stamps the residue at every pick boundary.
    backdateResidue(dir, Math.round(REBASE_ABANDONED_SHAPE_STALE_MS / 2));
    const shape = classifyAbandonedRebaseShape(s.dir, join(s.dir, '.git'), ['rebase-merge']);
    assert.equal(shape.abandoned, false);
    assert.match(shape.why, /live rebase re-stamps it every pick/);

    const out = healRebaseResidue(s.dir);
    assert.equal(out[0].status, 'clean');
    assert.ok(existsSync(dir), 'a possibly-live rebase must never be aborted');
  } finally {
    s.cleanup();
  }
});

test('healRebaseResidue: a LIVE sanctioned rebase is spared even in the abandoned shape', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    const dir = plantAbandonedRebase(s);
    backdateResidue(dir, 60 * 60_000); // ancient — mtime is not the signal for signal (1)
    journalCoordOp(s.dir, { tool: 'push-rebase', token: 'w-2939', phase: 'start' });
    const out = healRebaseResidue(s.dir, { _alive: () => true });
    assert.equal(out[0].status, 'clean');
    assert.match(out[0].detail, /LIVE push-rebase/);
    assert.ok(existsSync(dir), 'signal (1) still outranks the shape signal');
  } finally {
    s.cleanup();
  }
});

test('classifyAbandonedRebaseShape: every human stop is spared — dirty conflict, edit-stop, break-stop, identical resolution', () => {
  const common = (s) => join(s.dir, '.git');
  const shapeOf = (s) => classifyAbandonedRebaseShape(s.dir, common(s), ['rebase-merge']);

  // (a) mid-conflict with a dirty tree — unmerged paths
  {
    const s = makeRepo({ 'doc.md': 'L1\n' });
    try {
      seedReplayableRebase(s, { conflicting: true });
      assert.throws(() => s.g('rebase', 'origin/master'));
      const dir = join(s.dir, '.git', 'rebase-merge');
      backdateResidue(dir, 60 * 60_000);
      const shape = shapeOf(s);
      assert.equal(shape.abandoned, false);
      // stopped-sha is written at the stop, so it is the first thing that spares it
      assert.match(shape.why, /human-stop marker|unmerged path/);
      // staleMs raised past the fixture's age so the HUMAN gate cannot decide — the shape
      // signal is the only thing left, and it must still spare a mid-conflict tree.
      assert.equal(healRebaseResidue(s.dir, { staleMs: 24 * 60 * 60_000 })[0].status, 'clean');
      assert.ok(existsSync(dir));
    } finally {
      s.cleanup();
    }
  }

  // (b) an `edit` stop — CLEAN tree, spared only by the marker files
  {
    const s = makeRepo({ 'doc.md': 'L1\n' });
    try {
      seedReplayableRebase(s);
      const env = { ...process.env, ...armSequenceEditor(s.dir), SEQ_MODE: 'edit-first' };
      execFileSync('git', ['-C', s.dir, 'rebase', '-i', 'origin/master'], { env });
      const dir = join(s.dir, '.git', 'rebase-merge');
      assert.equal(
        s.g('status', '--porcelain', '--untracked-files=no').trim(),
        '',
        'an edit-stop tree really is clean — tree state alone cannot spare it',
      );
      backdateResidue(dir, 60 * 60_000);
      const shape = shapeOf(s);
      assert.equal(shape.abandoned, false);
      assert.match(shape.why, /human-stop marker rebase-merge\/(amend|stopped-sha)/);
      assert.ok(existsSync(dir));
    } finally {
      s.cleanup();
    }
  }

  // (c) a `break` stop — CLEAN tree AND no marker file; only the `done` tail spares it
  {
    const s = makeRepo({ 'doc.md': 'L1\n' });
    try {
      seedReplayableRebase(s);
      const env = { ...process.env, ...armSequenceEditor(s.dir) };
      execFileSync('git', ['-C', s.dir, 'rebase', '-i', 'origin/master'], { env });
      const dir = join(s.dir, '.git', 'rebase-merge');
      for (const f of ['amend', 'stopped-sha', 'message', 'patch'])
        assert.ok(!existsSync(join(dir, f)), `a break stop writes no ${f} marker`);
      backdateResidue(dir, 60 * 60_000);
      const shape = shapeOf(s);
      assert.equal(shape.abandoned, false);
      assert.match(shape.why, /stopped on purpose \(done ends "break"\)/);
      assert.ok(existsSync(dir));
    } finally {
      s.cleanup();
    }
  }

  // (d) a conflict a human resolved to content IDENTICAL to HEAD — the tree goes CLEAN again
  //     while they are still sitting in the rebase. `stopped-sha` is the only thing left.
  {
    const s = makeRepo({ 'doc.md': 'L1\n' });
    try {
      seedReplayableRebase(s, { conflicting: true });
      assert.throws(() => s.g('rebase', 'origin/master'));
      const dir = join(s.dir, '.git', 'rebase-merge');
      writeFileSync(join(s.dir, 'doc.md'), s.g('show', 'HEAD:doc.md'));
      s.g('add', 'doc.md');
      assert.equal(
        s.g('status', '--porcelain', '--untracked-files=no').trim(),
        '',
        'the identical-resolution tree is clean — this is the case tree-cleanliness alone gets wrong',
      );
      backdateResidue(dir, 60 * 60_000);
      const shape = shapeOf(s);
      assert.equal(shape.abandoned, false);
      assert.match(shape.why, /human-stop marker/);
      assert.ok(existsSync(dir));
    } finally {
      s.cleanup();
    }
  }
});

// Review round 1 (gpt-review @ 6480ce925, plan 2939) — four defects the fixture table above
// did not reach. Each is pinned here so the fix cannot silently regress.
test('classifyAbandonedRebaseShape: an interactive rebase paused in the SEQUENCE EDITOR is spared', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    seedReplayableRebase(s);
    const env = { ...process.env, ...armSequenceEditor(s.dir) };
    execFileSync('git', ['-C', s.dir, 'rebase', '-i', 'origin/master'], { env });
    const dir = join(s.dir, '.git', 'rebase-merge');
    // A human sitting in $EDITOR over the todo has applied NOTHING yet: clean tree, no marker,
    // no `done`. By shape that is indistinguishable from an abandoned rebase, and a human
    // legitimately sits there for minutes — so it must defer to the human gate.
    rmSync(join(dir, 'done'), { force: true });
    backdateResidue(dir, 60 * 60_000);
    const shape = classifyAbandonedRebaseShape(s.dir, join(s.dir, '.git'), ['rebase-merge']);
    assert.equal(shape.abandoned, false);
    assert.match(shape.why, /sequencer has not started/);
  } finally {
    s.cleanup();
  }
});

test('classifyAbandonedRebaseShape: an UNREADABLE done spares — it is never read as "nothing stopped it"', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    const dir = plantAbandonedRebase(s);
    backdateResidue(dir, 60 * 60_000);
    // sanity: readable → abandoned
    assert.equal(
      classifyAbandonedRebaseShape(s.dir, join(s.dir, '.git'), ['rebase-merge']).abandoned,
      true,
    );
    // A transient read failure on `done` (permissions / sharing) must not be mistaken for
    // "no deliberate stop" — that would abort a human's break/exec stop.
    const donePath = join(dir, 'done');
    rmSync(donePath, { force: true });
    mkdirSync(donePath); // a directory where a file is expected → readFileSync throws EISDIR
    const shape = classifyAbandonedRebaseShape(s.dir, join(s.dir, '.git'), ['rebase-merge']);
    assert.equal(shape.abandoned, false);
    assert.match(shape.why, /could not read done/);
  } finally {
    s.cleanup();
  }
});

test('healRebaseResidue: the human gate reads the FRESHEST residue entry, not the directory alone', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    const dir = plantAbandonedRebase(s);
    // A live journal-less rebase advancing picks appends to `done` — which does NOT touch the
    // directory mtime. If the age gate read the dir alone, this reads as 16 minutes idle and
    // the abort fires on a rebase that moved a second ago.
    backdateResidue(dir, 16 * 60_000);
    const t = Date.now() / 1000;
    utimesSync(join(dir, 'done'), t, t);
    const out = healRebaseResidue(s.dir);
    assert.equal(out[0].status, 'clean', out[0].detail);
    assert.ok(existsSync(dir), 'a rebase that just advanced must not be aborted');
  } finally {
    s.cleanup();
  }
});

// ── plan 2948: clock-skew honesty in both liveness signals ───────────────────────────────
// Rewrite a named open window's fields in place — the only way to plant a `ts` or an identity
// token the writer would never produce (a future date, a recycled process).
function rewriteWindow(mainDir, token, patch) {
  const jp = coordOpJournalPath(mainDir);
  writeFileSync(
    jp,
    readFileSync(jp, 'utf8')
      .split('\n')
      .map((l) => (l.includes(token) ? JSON.stringify({ ...JSON.parse(l), ...patch }) : l))
      .join('\n'),
  );
}
const futureIso = (ms) => new Date(Date.now() + ms).toISOString();

test('classifyRebaseWindow: identity answers first, the clock only when it cannot', () => {
  const alwaysAlive = () => true;
  const w = (patch) => ({ pid: 4242, ts: new Date().toISOString(), ...patch });

  // Tier 1 — identity, and it never consults the clock or the liveness probe.
  const boom = () => assert.fail('the identity path must not fall through');
  assert.deepEqual(
    classifyRebaseWindow(
      w({ processStartTime: 'tok', ts: futureIso(6 * 60 * 60_000) }),
      boom,
      () => 'tok',
    ),
    { live: true, why: 'open journal window, pid 4242 identity unchanged', skewed: false },
  );
  assert.equal(
    classifyRebaseWindow(w({ processStartTime: 'tok' }), boom, () => 'other').live,
    false,
    'a changed token is a recycled pid',
  );

  // Tier 2 — the clock rules, reached by an absent OR unreadable token (ruling 6). Both the
  // future-skew and the unparseable case report `skewed`, which is what makes the eventual
  // abort say "clock", and both refuse to spare even on a live pid (ruling 2).
  for (const entry of [w({}), w({ processStartTime: 'tok' })]) {
    const unreadable = () => null;
    assert.equal(classifyRebaseWindow(entry, alwaysAlive, unreadable).live, true, 'fresh + alive');
    const skewed = classifyRebaseWindow(
      { ...entry, ts: futureIso(CLOCK_SKEW_TOLERANCE_MS + 60_000) },
      alwaysAlive,
      unreadable,
    );
    assert.deepEqual([skewed.live, skewed.skewed], [false, true]);
    assert.match(skewed.why, /FUTURE/);
    // Just inside tolerance is jitter, not skew — the clock-ahead host stays live.
    assert.equal(
      classifyRebaseWindow(
        { ...entry, ts: futureIso(CLOCK_SKEW_TOLERANCE_MS - 30_000) },
        alwaysAlive,
        unreadable,
      ).live,
      true,
    );
    // The recycled-pid backstop for entries with no identity token: past the recency window a
    // live-looking pid is disbelieved — but as AGE, not as skew, so it never claims a bad clock.
    const old = classifyRebaseWindow(
      { ...entry, ts: new Date(Date.now() - 31 * 60_000).toISOString() },
      alwaysAlive,
      unreadable,
    );
    assert.deepEqual([old.live, old.skewed], [false, false]);
    assert.match(old.why, /recency window/);
    // An unparseable ts is no usable age at all: no spare, and reported as a clock problem.
    const junk = classifyRebaseWindow({ ...entry, ts: 'not-a-date' }, alwaysAlive, unreadable);
    assert.deepEqual([junk.live, junk.skewed], [false, true]);
  }
});

test('healRebaseResidue: a FUTURE-dated journal window cannot spare residue — even on a live pid', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    const dir = plantAbandonedRebase(s);
    backdateResidue(dir, 60 * 60_000);
    // A clock rollback (or a corrupt line) dates an ancient window in the future. Passed
    // through, `Date.now() - ts` goes NEGATIVE and reads as arbitrarily recent, so a recycled
    // pid spares the residue for good — the stale-window-spares-forever defect.
    journalCoordOp(s.dir, { tool: 'push-rebase', token: 'w-future', phase: 'start' });
    rewriteWindow(s.dir, 'w-future', { ts: futureIso(6 * 60 * 60_000) });

    // Grill ruling 2 (2026-08-07): with no identity token to appeal to, the BROKEN CLOCK wins
    // over a live pid. This inverts the pre-2948 assertion on purpose — that reading spared
    // forever, and a wedged MAIN blocks every parallel session while an abort costs one retry.
    const out = healRebaseResidue(s.dir, { _alive: () => true, _startTime: () => null });
    assert.equal(out[0].status, 'fixed', out[0].detail);
    assert.ok(!existsSync(dir), 'a future-dated window must not spare dead residue forever');
    // Ruling 1's other half: the abort must NAME the clock, not just happen.
    assert.match(out[0].detail, /FUTURE/);
    assert.match(out[0].detail, /clock is unusable/);
  } finally {
    s.cleanup();
  }
});

test('healRebaseResidue: a journal window within the skew tolerance still spares a live rebase', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    const dir = plantAbandonedRebase(s);
    backdateResidue(dir, 60 * 60_000);
    // Ordinary jitter — a host a minute ahead of this process. Under tolerance it is not skew,
    // and the skew machinery must stay entirely out of the way of a live sanctioned rebase.
    journalCoordOp(s.dir, { tool: 'push-rebase', token: 'w-jitter', phase: 'start' });
    rewriteWindow(s.dir, 'w-jitter', { ts: futureIso(CLOCK_SKEW_TOLERANCE_MS / 2) });
    const out = healRebaseResidue(s.dir, { _alive: () => true, _startTime: () => null });
    assert.equal(out[0].status, 'clean', out[0].detail);
    assert.ok(existsSync(dir), 'a live rebase within tolerance is never aborted by skew');
  } finally {
    s.cleanup();
  }
});

test('healRebaseResidue: a matching process identity spares regardless of the clock', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    const dir = plantAbandonedRebase(s);
    backdateResidue(dir, 60 * 60_000);
    // Rulings 4–5: the identity token answers on its own, so this window is spared on evidence
    // that a wrong clock cannot touch — the SAME 6h-future `ts` that aborts above.
    journalCoordOp(s.dir, { tool: 'push-rebase', token: 'w-ident', phase: 'start' });
    rewriteWindow(s.dir, 'w-ident', {
      ts: futureIso(6 * 60 * 60_000),
      processStartTime: 'linux:boot-a:66583',
    });
    const out = healRebaseResidue(s.dir, {
      _alive: () => assert.fail('the identity path must not need a liveness probe'),
      _startTime: () => 'linux:boot-a:66583',
    });
    assert.equal(out[0].status, 'clean', out[0].detail);
    assert.ok(existsSync(dir), 'an identity match is liveness, at any age, under any clock');
    assert.match(out[0].detail, /identity unchanged/);
  } finally {
    s.cleanup();
  }
});

test('healRebaseResidue: a RECYCLED pid is caught by identity even while it reads as alive', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    const dir = plantAbandonedRebase(s);
    backdateResidue(dir, 60 * 60_000);
    // The hazard REBASE_WINDOW_RECENT_MS was a 30-minute guess at, now answered exactly: a
    // FRESH window whose pid the OS reissued to an unrelated process. `alive()` says yes and
    // the clock says recent — only the identity token knows it is a different process.
    journalCoordOp(s.dir, { tool: 'push-rebase', token: 'w-recycled', phase: 'start' });
    rewriteWindow(s.dir, 'w-recycled', { processStartTime: 'linux:boot-a:66583' });
    const out = healRebaseResidue(s.dir, {
      _alive: () => true,
      _startTime: () => 'linux:boot-a:99999',
    });
    assert.equal(out[0].status, 'fixed', out[0].detail);
    assert.ok(!existsSync(dir), 'a recycled pid must not spare residue');
    // And it says WHICH finding it was: the identity signal's whole point is that it can tell
    // a recycled pid from a dead one, which the pre-2948 wording flattened away.
    assert.match(out[0].detail, /recycled \(process identity changed\)/);
    assert.doesNotMatch(out[0].detail, /clock is unusable/);
  } finally {
    s.cleanup();
  }
});

test('healRebaseResidue: an unreadable identity degrades to the clock path, never to a verdict', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    const dir = plantAbandonedRebase(s);
    backdateResidue(dir, 60 * 60_000);
    // Ruling 6: a stamped window whose start time the OS will not hand back (and, identically,
    // a pre-2948 window carrying no token at all) falls through to today's recency + liveness
    // rules — the switchover must not abort live rebases.
    journalCoordOp(s.dir, { tool: 'push-rebase', token: 'w-unreadable', phase: 'start' });
    rewriteWindow(s.dir, 'w-unreadable', { processStartTime: 'linux:boot-a:66583' });
    const spared = healRebaseResidue(s.dir, { _alive: () => true, _startTime: () => null });
    assert.equal(spared[0].status, 'clean', spared[0].detail);
    assert.match(spared[0].detail, /pid \d+ alive/);
    assert.ok(existsSync(dir), 'the fallback still spares a recent window on a live pid');

    const out = healRebaseResidue(s.dir, { _alive: () => false, _startTime: () => null });
    assert.equal(out[0].status, 'fixed', out[0].detail);
    assert.ok(!existsSync(dir), 'and still aborts on a dead one');
  } finally {
    s.cleanup();
  }
});

test('healRebaseResidue: a FUTURE-dated residue mtime cannot pin the residue as fresh forever', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    const dir = plantAbandonedRebase(s);
    backdateResidue(dir, 60 * 60_000);
    // A clock rollback (or copied .git metadata) dates one progress file in the future.
    // `Date.now() - mtime` goes NEGATIVE there and would win the Math.min outright, pinning
    // the residue as "just written" and wedging MAIN until wall-clock caught up. Beyond
    // tolerance it is dropped instead, and the remaining hour-old entries decide.
    const future = (Date.now() + 6 * 60 * 60_000) / 1000;
    utimesSync(join(dir, 'done'), future, future);
    const out = healRebaseResidue(s.dir);
    assert.equal(out[0].status, 'fixed', out[0].detail);
    assert.ok(!existsSync(dir), 'a future-dated mtime must not spare dead residue forever');
  } finally {
    s.cleanup();
  }
});

test('healRebaseResidue: an ALL-future residue is a loud abort, never a silent "vanished"', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    const dir = plantAbandonedRebase(s);
    // Every entry beyond tolerance — a clock rollback, a copied `.git`, a sandbox before its
    // first NTP sync. Discarding them all (plan 2939's reverted attempt) left NO datable entry,
    // which read as "vanished" and wedged MAIN for as long as the clock stayed wrong. Ruling 1:
    // reach a decided outcome, and make it the abort.
    const future = (Date.now() + 6 * 60 * 60_000) / 1000;
    for (const p of [dir, ...readdirSync(dir).map((f) => join(dir, f))])
      utimesSync(p, future, future);
    const out = healRebaseResidue(s.dir);
    assert.equal(out[0].status, 'fixed', out[0].detail);
    assert.ok(!existsSync(dir), 'an unusable clock must not leave MAIN detached indefinitely');
    assert.match(out[0].detail, /FUTURE/);
    assert.doesNotMatch(out[0].detail, /vanished/);
  } finally {
    s.cleanup();
  }
});

test('healRebaseResidue: a clock-AHEAD filesystem within tolerance still counts as liveness', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    const dir = plantAbandonedRebase(s);
    // The mirror regression: a networked filesystem running a little ahead stamps a live
    // rebase's genuine progress writes in the future. Discarding those threw away exactly the
    // liveness the gate exists to detect, so within tolerance they are clamped to "just now".
    const ahead = (Date.now() + CLOCK_SKEW_TOLERANCE_MS / 2) / 1000;
    for (const p of [dir, ...readdirSync(dir).map((f) => join(dir, f))])
      utimesSync(p, ahead, ahead);
    const out = healRebaseResidue(s.dir);
    assert.equal(out[0].status, 'clean', out[0].detail);
    assert.ok(existsSync(dir), "a live rebase's progress writes are liveness, not skew");
  } finally {
    s.cleanup();
  }
});

test('healRebaseResidue: a stop that appears between classification and the abort is spared', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    const dir = plantAbandonedRebase(s);
    // Inside the human gate but past the shape gate, so the abort is reached via the SHAPE
    // path — the only path the re-check guards. (Past the human gate the age path decides and
    // the re-check is never consulted.)
    backdateResidue(dir, REBASE_ABANDONED_SHAPE_STALE_MS + 60_000);
    // A raw rebase does not hold heal-main's coord lock, so a human can reach a stop in the
    // window between the shape verdict and `git rebase --abort`. Simulate the race by planting
    // the marker a real stop would write, after the first classification would have run.
    assert.equal(
      classifyAbandonedRebaseShape(s.dir, join(s.dir, '.git'), ['rebase-merge']).abandoned,
      true,
    );
    // _beforeAbort fires between heal-main's OWN classification and the abort — the real
    // window. (Planting the marker up front would not exercise it: the first classification
    // would already see the marker, and writing into the dir refreshes its mtime anyway.)
    const out = healRebaseResidue(s.dir, {
      _beforeAbort: () => writeFileSync(join(dir, 'stopped-sha'), 'deadbeef\n'),
    });
    assert.equal(out[0].status, 'clean', out[0].detail);
    assert.match(out[0].detail, /changed under us between check and abort/);
    assert.ok(existsSync(dir), 'the human stop that appeared mid-flight must survive');
  } finally {
    s.cleanup();
  }
});

test('classifyAbandonedRebaseShape: a failed `exec` stop and non-merge-backend residue are spared', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    seedReplayableRebase(s);
    assert.throws(() => s.g('rebase', 'origin/master', '--exec', 'false'));
    const dir = join(s.dir, '.git', 'rebase-merge');
    backdateResidue(dir, 60 * 60_000);
    const shape = classifyAbandonedRebaseShape(s.dir, join(s.dir, '.git'), ['rebase-merge']);
    assert.equal(shape.abandoned, false);
    assert.match(shape.why, /stopped on purpose \(done ends "exec false"\)/);

    // the `am` backend keeps patch/msg present for the whole run, so it has no marker set to
    // read — it is never shape-eligible and falls through to the 15-min human gate unchanged
    const amShape = classifyAbandonedRebaseShape(s.dir, join(s.dir, '.git'), ['rebase-apply']);
    assert.equal(amShape.abandoned, false);
    assert.match(amShape.why, /not merge-backend-only residue/);
  } finally {
    s.cleanup();
  }
});

// ── 3. detached HEAD ─────────────────────────────────────────────────────────────────────
test('healDetachedHead: reattaches a detached-at-ancestor MAIN; refuses a unique-commit detach', () => {
  const s = makeRepo({ 'doc.md': 'a\n' });
  try {
    // detach at the current tip (an ancestor of origin/master) → safe reattach
    s.g('checkout', '-q', '--detach', 'HEAD');
    assert.equal(s.g('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD');
    const out = healDetachedHead(s.dir);
    assert.equal(out[0].status, 'fixed');
    assert.equal(s.g('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'master');
    // idempotent
    assert.equal(healDetachedHead(s.dir)[0].status, 'clean');

    // detach + a UNIQUE commit (origin lacks it) → refuse loudly, stay detached
    s.g('checkout', '-q', '--detach', 'HEAD');
    writeFileSync(join(s.dir, 'unique.txt'), 'u\n');
    s.g('add', 'unique.txt');
    s.g('commit', '-qm', 'unique work');
    const blocked = healDetachedHead(s.dir);
    assert.equal(blocked[0].status, 'blocked');
    assert.match(blocked[0].detail, /NOT an ancestor/);
    assert.equal(s.g('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD', 'left detached');
  } finally {
    s.cleanup();
  }
});

test('reattachMainToMaster: no-op when attached; moves only the ref when detached at master tip', () => {
  const s = makeRepo();
  try {
    assert.equal(reattachMainToMaster(s.dir).reattached, false);
    const tip = s.g('rev-parse', 'master').trim();
    s.g('checkout', '-q', '--detach', 'HEAD');
    const res = reattachMainToMaster(s.dir);
    assert.equal(res.reattached, true);
    assert.equal(res.from, tip);
    assert.equal(s.g('rev-parse', 'master').trim(), tip, 'master pointer unmoved');
  } finally {
    s.cleanup();
  }
});

// ── 4. master sync ───────────────────────────────────────────────────────────────────────
test('healMasterSync: fast-forwards a behind master; pushes an ahead master when clean', () => {
  const s = makeRepo({ 'doc.md': 'x\n' });
  try {
    // BEHIND: sibling advances origin
    const sib = join(s.root, 'sib2');
    execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', s.origin, sib]);
    gAt(sib, 'config', 'user.email', 's@t.t');
    gAt(sib, 'config', 'user.name', 's');
    writeFileSync(join(sib, 'new.txt'), 'n\n');
    gAt(sib, 'add', 'new.txt');
    gAt(sib, 'commit', '-qm', 'sib advance');
    gAt(sib, 'push', '-q', 'origin', 'master');
    const behind = healMasterSync(s.dir);
    assert.equal(behind[0].status, 'fixed');
    assert.match(behind[0].detail, /fast-forwarded/);
    assert.equal(s.g('rev-parse', 'master').trim(), s.g('rev-parse', 'origin/master').trim());

    // AHEAD + clean: an unpushed local commit (the --no-push / killed-push shape)
    writeFileSync(join(s.dir, 'local.txt'), 'l\n');
    s.g('add', 'local.txt');
    s.g('commit', '-qm', 'local unpushed');
    const ahead = healMasterSync(s.dir);
    assert.equal(ahead[0].status, 'fixed');
    assert.match(ahead[0].detail, /pushed/);
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(s.g('rev-parse', 'master').trim(), s.g('rev-parse', 'origin/master').trim());

    // AHEAD + dirty tracked tree → blocked (never rebase over dirt)
    writeFileSync(join(s.dir, 'local2.txt'), 'l2\n');
    s.g('add', 'local2.txt');
    s.g('commit', '-qm', 'local unpushed 2');
    writeFileSync(join(s.dir, 'doc.md'), 'dirty\n'); // tracked dirt
    const blocked = healMasterSync(s.dir);
    assert.equal(blocked[0].status, 'blocked');
    s.g('checkout', '--', 'doc.md');
  } finally {
    s.cleanup();
  }
});

// ── 4b. dirt / corruption guard (plan 1634) ──────────────────────────────────────────────
// healDirt's real (non-dry) path passes ageThresholdMs: 90_000 to guard() — a just-written
// file reads as "too fresh" and the age gate skips it entirely, so these tests must
// backdate the mtime past that threshold (mirrors plantStaleLock's approach above).
function ageFile(path, ageMs = 120_000) {
  const old = (Date.now() - ageMs) / 1000;
  utimesSync(path, old, old);
}

function plantJobOutputOnlyDirt(s) {
  const tracked = join(s.dir, 'backend/data/data-pipeline/render-store/tracked.json');
  const untracked = join(s.dir, 'backend/data/data-pipeline/batches/new.json');
  mkdirSync(join(untracked, '..'), { recursive: true });
  writeFileSync(tracked, 'tracked\nmodified\n');
  writeFileSync(untracked, 'new\n');
  ageFile(tracked);
  ageFile(untracked);
  return { tracked, untracked };
}

test('healDirt: live job-output-only dirt stays dirty and reports clean', () => {
  const s = makeRepo({
    'backend/data/data-pipeline/render-store/tracked.json': 'tracked\n',
  });
  try {
    const { tracked, untracked } = plantJobOutputOnlyDirt(s);
    const report = healDirt(s.dir, { log: () => {} });
    assert.equal(report[0].status, 'clean');
    assert.match(report[0].detail, /live job-owned pipeline output.*never parked/i);
    assert.equal(readFileSync(tracked, 'utf8'), 'tracked\nmodified\n');
    assert.equal(readFileSync(untracked, 'utf8'), 'new\n');
    const dirt = s.g('status', '--porcelain');
    assert.match(dirt, /tracked\.json/);
    assert.match(dirt, /backend\/data\/data-pipeline\/batches\//);
  } finally {
    s.cleanup();
  }
});

test('healDirt: dry preview calls live job-output-only dirt clean without parking promise', () => {
  const s = makeRepo({
    'backend/data/data-pipeline/render-store/tracked.json': 'tracked\n',
  });
  try {
    plantJobOutputOnlyDirt(s);
    const report = healDirt(s.dir, { dry: true, log: () => {} });
    assert.equal(report[0].status, 'clean');
    assert.match(report[0].detail, /job-owned pipeline output.*leaves? in place/i);
    assert.doesNotMatch(report[0].detail, /commit|stash/i);
  } finally {
    s.cleanup();
  }
});

test('healDirt: job-output-only sentinel never falls through to blocked mode=none', () => {
  const s = makeRepo({
    'backend/data/data-pipeline/render-store/tracked.json': 'tracked\n',
  });
  try {
    plantJobOutputOnlyDirt(s);
    const report = healDirt(s.dir, { log: () => {} });
    assert.notEqual(report[0].status, 'blocked');
    assert.doesNotMatch(report[0].detail, /mode=none/);
  } finally {
    s.cleanup();
  }
});

// plan 3968 review round 3 (72c7a2/3eaf8f/709c19/ceb952): the sibling of the 'truncated-index'
// arm — guard()'s own index-sanity check (unconditional, runs before any mode branch) can
// return `skipped: 'index-state-unknown'` when a probe itself fails, and healDirt used to have
// no arm for it: the REAL path fell through to the generic `pre-yield-guard mode=none`
// catch-all (losing `indexSanity.why` and the re-run guidance), and the --dry preview promised
// a commit/stash a real run would never perform. Both pinned via the `exec` seam threaded
// through healDirt (mirrors index-sanity.test.mjs's own injected-exec pattern).
function flakyStagedDeletionExec(...a) {
  const args = a[1];
  if (Array.isArray(args) && args.includes('diff') && args.includes('--diff-filter=D')) {
    throw new Error('simulated staged-deletion probe failure');
  }
  return execFileSync(...a);
}

test('healDirt: reports blocked (not the generic mode=none) when the index state is UNKNOWN', () => {
  const s = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    tornIndex(s.dir); // low index-count ratio — reaches the staged-deletion probe
    const report = healDirt(s.dir, { log: () => {}, exec: flakyStagedDeletionExec });
    assert.equal(report.length, 1);
    assert.equal(report[0].status, 'blocked');
    assert.match(report[0].detail, /index state could not be verified/);
    assert.doesNotMatch(report[0].detail, /mode=none/);
  } finally {
    s.cleanup();
  }
});

test('healDirt --dry: previews a REFUSAL, never "would commit/stash", when the index state is UNKNOWN', () => {
  const s = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    tornIndex(s.dir);
    const report = healDirt(s.dir, { dry: true, log: () => {}, exec: flakyStagedDeletionExec });
    assert.equal(report.length, 1);
    assert.match(report[0].detail, /index state could not be verified/);
    assert.match(report[0].detail, /REFUSE to commit\/stash/);
    assert.doesNotMatch(report[0].detail, /would commit\/stash/i);
  } finally {
    s.cleanup();
  }
});

test('healDirt: reports blocked (not fixed) when commit-safe excludes a corrupted doc', () => {
  const s = makeRepo({
    'docs/superpowers/plans/in-progress/x.md': 'base\n',
    'docs/superpowers/plans/in-progress/good.md': 'base\n',
  });
  try {
    const corruptPath = join(s.dir, 'docs/superpowers/plans/in-progress/x.md');
    const goodPath = join(s.dir, 'docs/superpowers/plans/in-progress/good.md');
    writeFileSync(corruptPath, nulBytes(4)); // corrupted
    writeFileSync(goodPath, 'base\nedited\n'); // otherwise-commit-safe doc dirt
    ageFile(corruptPath);
    ageFile(goodPath);
    const report = healDirt(s.dir, { log: () => {} });
    assert.equal(report[0].status, 'blocked');
    assert.match(report[0].detail, /EXCLUDED corrupted/);
    assert.match(report[0].detail, /x\.md/);
    s.g('fetch', '-q', 'origin', 'master');
    // The corrupted doc never reached origin...
    assert.equal(s.g('show', 'origin/master:docs/superpowers/plans/in-progress/x.md'), 'base\n');
    // ...but the healthy doc DID land (committed alongside, corrupted one excluded).
    assert.equal(
      s.g('show', 'origin/master:docs/superpowers/plans/in-progress/good.md'),
      'base\nedited\n',
    );
  } finally {
    s.cleanup();
  }
});

// Plan 3206 fix round (review finding): pre-yield-guard now resolves line-ending-only dirt
// by renormalizing it on disk instead of parking a stash that would store nothing, and
// returns `{skipped:'normalizes-clean', mode:'normalizes-clean'}`. healDirt must report that
// as a FIX — before this arm existed the return fell through the `res.mode` switch to its
// catch-all `blocked`, so heal-main exited 1 claiming a now-clean tree was still broken.
test('healDirt: a CRLF-only rewrite reports fixed, not blocked (plan 3206)', () => {
  const s = makeRepo();
  try {
    // makeRepo clones with core.autocrlf=false to keep other fixtures round-trip-stable;
    // this case needs the autocrlf/eol pair that produces the status-vs-diff disagreement.
    s.g('config', 'core.autocrlf', 'true');
    writeFileSync(join(s.dir, '.gitattributes'), '* text=auto eol=lf\n');
    s.g('add', '.gitattributes');
    s.g('commit', '-qm', 'attrs');
    const target = join(s.dir, 'base.txt');
    writeFileSync(target, Buffer.from('base\r\n')); // CRLF-only — normalizes away
    ageFile(target);
    assert.match(s.g('status', '--porcelain'), /base\.txt/, 'porcelain flags it dirty first');

    const report = healDirt(s.dir, { log: () => {} });
    assert.equal(report[0].status, 'fixed', 'a renormalized tree is fixed, never blocked');
    assert.doesNotMatch(report[0].detail, /mode=none/);
    assert.equal(s.g('stash', 'list'), '', 'nothing was parked');
    assert.equal(s.g('status', '--porcelain'), '', 'tree is genuinely clean afterwards');
  } finally {
    s.cleanup();
  }
});

// Plan 3206 re-review finding: the arm above must not report 'fixed' when the guard left a
// corrupted file dirty beside the line-ending-only one — that is exactly the false-clean
// report the plan-1634 rule exists to prevent, and the pre-fix accidental 'blocked'
// fallthrough had it right by luck.
test('healDirt: CRLF-only + a corrupted file reports blocked, not fixed (plan 3206)', () => {
  const s = makeRepo({ 'docs/superpowers/plans/in-progress/x.md': 'base\n' });
  try {
    s.g('config', 'core.autocrlf', 'true');
    writeFileSync(join(s.dir, '.gitattributes'), '* text=auto eol=lf\n');
    s.g('add', '.gitattributes');
    s.g('commit', '-qm', 'attrs');
    const crlf = join(s.dir, 'base.txt');
    const corrupt = join(s.dir, 'docs/superpowers/plans/in-progress/x.md');
    writeFileSync(crlf, Buffer.from('base\r\n')); // normalizes away
    writeFileSync(corrupt, nulBytes(4)); // must be left dirty
    ageFile(crlf);
    ageFile(corrupt);

    const report = healDirt(s.dir, { log: () => {} });
    assert.equal(report[0].status, 'blocked', 'a still-corrupted file is never a clean report');
    assert.match(report[0].detail, /EXCLUDED corrupted/);
    assert.match(report[0].detail, /x\.md/);
    assert.match(s.g('status', '--porcelain'), /x\.md/, 'corrupted file left for a human/heal');
  } finally {
    s.cleanup();
  }
});

test('healDirt: mode=corrupted-only reports blocked and names the file', () => {
  const s = makeRepo({ 'docs/superpowers/plans/in-progress/x.md': 'base\n' });
  try {
    const p = join(s.dir, 'docs/superpowers/plans/in-progress/x.md');
    writeFileSync(p, nulBytes(4)); // ONLY dirt
    ageFile(p);
    const report = healDirt(s.dir, { log: () => {} });
    assert.equal(report[0].status, 'blocked');
    assert.match(report[0].detail, /corrupted file\(s\) left as-is/);
    assert.match(report[0].detail, /x\.md/);
  } finally {
    s.cleanup();
  }
});

test('healDirt --dry: preview names a corrupted file instead of promising a fix', () => {
  const s = makeRepo({ 'docs/superpowers/plans/in-progress/x.md': 'base\n' });
  try {
    writeFileSync(join(s.dir, 'docs/superpowers/plans/in-progress/x.md'), nulBytes(4));
    const report = healDirt(s.dir, { dry: true, log: () => {} });
    assert.equal(report[0].status, 'would-fix');
    assert.match(report[0].detail, /EXCLUDE corrupted file/);
    assert.match(report[0].detail, /x\.md/);
  } finally {
    s.cleanup();
  }
});

// ── 5. journal / interrupted ops ─────────────────────────────────────────────────────────
test('coord-op journal: withCoordLock writes start/done; an error writes start/error', () => {
  const s = makeRepo();
  try {
    withCoordLock(s.dir, () => 42, { tool: 't-ok' });
    assert.throws(() =>
      withCoordLock(
        s.dir,
        () => {
          throw new Error('boom');
        },
        { tool: 't-err' },
      ),
    );
    const entries = readCoordOpJournal(s.dir);
    const seq = entries.map((e) => `${e.tool}:${e.phase}`);
    assert.deepEqual(seq, ['t-ok:start', 't-ok:done', 't-err:start', 't-err:error']);
    assert.ok(!existsSync(coordLockPath(s.dir)), 'lock released on both paths');
  } finally {
    s.cleanup();
  }
});

test('reportInterruptedOps: a dead-pid start with no close is reported; a live op is not', () => {
  const s = makeRepo();
  try {
    journalCoordOp(s.dir, { tool: 'killed-op', token: 'k1', phase: 'start' });
    journalCoordOp(s.dir, { tool: 'live-op', token: 'l1', phase: 'start' });
    const out = reportInterruptedOps(s.dir, { _alive: (pid) => false });
    // both entries carry OUR pid; with _alive=false both read as killed
    assert.equal(out.filter((x) => /KILLED mid-flight/.test(x.detail)).length, 2);
    const live = reportInterruptedOps(s.dir, { _alive: () => true });
    assert.equal(live[0].detail, 'no interrupted coord ops in the journal');
  } finally {
    s.cleanup();
  }
});

test('journal rotation: an oversized journal is trimmed, newest entries kept', () => {
  const s = makeRepo();
  try {
    const p = coordOpJournalPath(s.dir);
    // one line ≈ 29 bytes → 10k lines ≈ 290 KB, past the 256 KB rotate threshold
    writeFileSync(p, `${JSON.stringify({ tool: 'old', phase: 'done' })}\n`.repeat(10_000));
    journalCoordOp(s.dir, { tool: 'fresh', token: 'f', phase: 'start' });
    const entries = readCoordOpJournal(s.dir);
    assert.ok(entries.length <= 201, `rotated (got ${entries.length})`);
    assert.equal(entries.at(-1).tool, 'fresh');
  } finally {
    s.cleanup();
  }
});

// ── 6/7 + composition ────────────────────────────────────────────────────────────────────
test('runHeal: healthy repo reports all clean and is idempotent; --dry never mutates', () => {
  const s = makeRepo();
  try {
    const quiet = () => {};
    const first = runHeal(s.dir, { log: quiet });
    // sweeps are skipped (fixture has no sweep scripts) → every present step must be clean
    assert.ok(
      first.every((x) => x.status === 'clean'),
      `expected all clean, got: ${JSON.stringify(first.filter((x) => x.status !== 'clean'))}`,
    );
    const second = runHeal(s.dir, { dry: true, log: quiet });
    assert.ok(second.every((x) => x.status === 'clean'));
  } finally {
    s.cleanup();
  }
});

test('runHeal: a wedged repo (stale lock + detached HEAD + behind master) heals in ONE pass', () => {
  const s = makeRepo({ 'doc.md': 'v1\n' });
  try {
    // wedge 1: sibling advances origin while we sit behind
    const sib = join(s.root, 'sib3');
    execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', s.origin, sib]);
    gAt(sib, 'config', 'user.email', 's@t.t');
    gAt(sib, 'config', 'user.name', 's');
    writeFileSync(join(sib, 'doc.md'), 'v2\n');
    gAt(sib, 'commit', '-aqm', 'sib');
    gAt(sib, 'push', '-q', 'origin', 'master');
    // wedge 2: detached HEAD (at an ancestor)
    s.g('checkout', '-q', '--detach', 'HEAD');
    // wedge 3: stale main lock — planted LAST (the fixture's own git calls need the index)
    plantStaleLock(join(s.dir, '.git', 'index.lock'), 90_000);

    const report = runHeal(s.dir, { log: () => {} });
    const fixed = report.filter((x) => x.status === 'fixed').map((x) => x.step);
    assert.ok(fixed.includes('stale-locks'), 'lock cleared');
    assert.ok(fixed.includes('detached-head'), 'reattached');
    assert.ok(fixed.includes('master-sync'), 'caught up to origin');
    assert.equal(s.g('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'master');
    assert.equal(s.g('rev-parse', 'master').trim(), s.g('rev-parse', 'origin/master').trim());
    // second pass: all clean (idempotent)
    const again = runHeal(s.dir, { log: () => {} });
    assert.ok(again.every((x) => x.status === 'clean'));
  } finally {
    s.cleanup();
  }
});

test('concurrent healer queues on the coord-write lock instead of racing (stale-steal untouched)', () => {
  const s = makeRepo();
  try {
    // A "healer" holds the lock; a second withCoordLock acquire must WAIT (then get it),
    // not steal a fresh lock. Short timeout → we observe the queue as a coordContention
    // throw rather than blocking the suite.
    const lockPath = coordLockPath(s.dir);
    acquireCoordLock(lockPath, 'healer-1');
    let contended = false;
    try {
      withCoordLock(s.dir, () => 'won', { timeoutMs: 400, staleMs: 60_000 });
    } catch (e) {
      contended = e.coordContention === true;
    }
    assert.ok(contended, 'second healer queued (timed out) instead of stealing a live lock');
    releaseCoordLock(lockPath, 'healer-1');
    // lock free → the same call now wins immediately
    assert.equal(
      withCoordLock(s.dir, () => 'won', { timeoutMs: 400 }),
      'won',
    );
  } finally {
    s.cleanup();
  }
});

test('pidAlive: a ZOMBIE is dead, however alive `kill(pid, 0)` says it is', () => {
  // The bug the plan-2948 delta review caught. `rebaseOwnerToken` refuses to mint an identity
  // for a zombie — but "no identity" degrades to this probe, and `kill(pid, 0)` SUCCEEDS on an
  // unreaped process. Without the state check here the refusal accomplished nothing: the corpse
  // still read as a live rebase owner and spared the residue forever.
  const zombie = { _procStatFields: () => ['Z', '1', '1'] };
  assert.equal(pidAlive(process.pid, zombie), false, 'a zombie is not a live owner');
  // Everything else keeps the pre-2948 behaviour verbatim, including the hosts where
  // procStatFields cannot answer at all (non-Linux, or /proc unreadable → null).
  for (const deps of [{ _procStatFields: () => ['R', '1', '1'] }, { _procStatFields: () => null }])
    assert.equal(pidAlive(process.pid, deps), true, 'a live pid is still alive');
  assert.equal(pidAlive(2147483647, { _procStatFields: () => null }), false, 'a gone pid is dead');
});

test('healRebaseResidue: a ZOMBIE owner does not spare the residue', () => {
  const s = makeRepo({ 'doc.md': 'L1\n' });
  try {
    const dir = plantAbandonedRebase(s);
    backdateResidue(dir, 60 * 60_000);
    // A FRESH window whose owner has exited but not been reaped: no identity token can be minted
    // for it, and the clock says recent — so only the zombie-aware liveness probe stops it from
    // sparing dead residue for good.
    journalCoordOp(s.dir, { tool: 'push-rebase', token: 'w-zombie', phase: 'start' });
    const out = healRebaseResidue(s.dir, {
      _startTime: () => null, // identity refuses to mint for a corpse
      _alive: (pid) => pidAlive(pid, { _procStatFields: () => ['Z', '1', '1'] }),
    });
    assert.equal(out[0].status, 'fixed', out[0].detail);
    assert.ok(!existsSync(dir), 'an unreaped owner is not a live rebase');
  } finally {
    s.cleanup();
  }
});

// ── delegateSweeps (step 7): the sweeps' exit contract ────────────────────────────────────
// Both residue sweeps exit SWEEP_SURFACED_EXIT when they surface residue instead of dropping it,
// and both write their report to STDOUT starting with a BLANK line. Before this was handled,
// execFileSync's throw-on-nonzero sent that advisory down the failure path and the detail was
// built from the report's first line — which was the blank one, so heal-main printed
// "BLOCKED [sweeps] sweep-stray-stashes.mjs failed:" with nothing after the colon and exited 1.
function makeSweepHost(bodies) {
  const dir = mkdtempSync(join(tmpdir(), 'heal-sweeps-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const [name, body] of Object.entries(bodies)) {
    writeFileSync(join(dir, 'scripts', name), body);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('delegateSweeps: a SURFACED exit is evidence, not a heal failure, and names what it found', () => {
  const s = makeSweepHost({
    // Mimics the real report shape: blank first line, verdict last, non-zero exit.
    'sweep-stray-stashes.mjs': [
      `console.log('');`,
      `console.log('WARN NON-SUBSUMED stray stashes:');`,
      `console.log('   stash@{0} - wip-stop-hook-2026-09-08-0842');`,
      `process.exit(${SWEEP_SURFACED_EXIT});`,
    ].join('\n'),
  });
  try {
    const out = delegateSweeps(s.dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'clean', 'surfaced residue must not block the heal');
    assert.match(out[0].detail, /wip-stop-hook-2026-09-08-0842/);
    assert.match(out[0].detail, /run it directly/);
  } finally {
    s.cleanup();
  }
});

test('delegateSweeps: a genuinely broken sweep blocks, and never with an empty reason', () => {
  const s = makeSweepHost({
    // A tool that dies for a real reason, reporting on stdout only — the channel the old
    // first-line formatting read past.
    'sweep-acquire-residue.mjs': [
      `console.log('');`,
      `console.log('sweep-acquire-residue: cannot reach origin');`,
      `process.exit(1);`,
    ].join('\n'),
  });
  try {
    const out = delegateSweeps(s.dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'blocked');
    assert.match(out[0].detail, /cannot reach origin/);
    assert.doesNotMatch(out[0].detail, /failed:\s*$/, 'a blocked sweep must name its reason');
  } finally {
    s.cleanup();
  }
});

test('delegateSweeps: a clean sweep reports its verdict line, not a blank one', () => {
  const s = makeSweepHost({
    'sweep-stray-stashes.mjs': [
      `console.log('');`,
      `console.log('no stray stashes - clean.');`,
    ].join('\n'),
  });
  try {
    const out = delegateSweeps(s.dir);
    assert.equal(out[0].status, 'clean');
    assert.match(out[0].detail, /no stray stashes - clean\./);
  } finally {
    s.cleanup();
  }
});

test('delegateSweeps: a sibling without the tools reports, never crashes', () => {
  const s = makeSweepHost({});
  try {
    const out = delegateSweeps(s.dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'clean');
    assert.match(out[0].detail, /no sweep tools present/);
  } finally {
    s.cleanup();
  }
});

// ── live hang probe (plan 4087 T3) ──────────────────────────────────────────────────────
// Platform symbols (vetapp CLAUDE.md): these tests never touch process.platform — they inject
// `listRows` directly, the seam coord-child-probe.mjs's own header documents as the one that
// bypasses BOTH the Windows PowerShell reader and the POSIX `ps` reader entirely. The readers'
// own platform-specific parsing (CIM JSON vs `ps -eo pid,lstart,args`) is exercised in
// coord-child-probe.test.mjs, which is where that half of the rule is proven.
test('probeHungCoordChildren: no live process targeting the coord checkout emits NOTHING (not even a clean line)', () => {
  const s = makeRepo();
  try {
    const out = probeHungCoordChildren(s.dir, { listRows: () => [] });
    assert.deepEqual(out, [], 'a healthy probe must contribute zero report lines');
  } finally {
    s.cleanup();
  }
});

test('probeHungCoordChildren: a live process targeting the coord checkout PAST the report floor is reported blocked, named by pid and age', () => {
  const s = makeRepo();
  try {
    const coordDir = coordCheckoutPath(s.dir);
    const out = probeHungCoordChildren(s.dir, {
      listRows: () => [
        {
          pid: 777,
          commandLine: `git -C ${coordDir} fetch --quiet origin master`,
          creationDateMs: 0,
        },
      ],
      now: HUNG_COORD_CHILD_REPORT_AGE_MS + 5 * 60_000, // past the floor — genuinely suspicious
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].step, 'hung-coord-children');
    assert.equal(out[0].status, 'blocked');
    assert.equal(out[0].pid, 777);
    assert.equal(out[0].ageMs, HUNG_COORD_CHILD_REPORT_AGE_MS + 5 * 60_000);
    assert.match(out[0].detail, /pid 777/);
    // plan 4087 review round 2 (finding heal-main.mjs:1193): the floor is now DERIVED
    // (2 * COORD_CHECKOUT_GIT_TIMEOUT_MS = 3min), not a chosen 30min constant — the expected
    // formatted age scales with it: floor (3min) + 5min = 8min.
    assert.match(out[0].detail, /8min/);
    assert.match(
      out[0].detail,
      /possibly/i,
      'the coord push paths are uncapped — "possibly hung", never a flat claim',
    );
  } finally {
    s.cleanup();
  }
});

// plan 4087 review fix (ykwr4h): the finding this closes — EVERY match used to be reported
// regardless of age, so a legitimately still-running push (measured p95 ~162s, up to ~30min
// under contention) was indistinguishable from a genuine wedge.
test('probeHungCoordChildren: a live process well WITHIN the legitimate-push window is not reported at all', () => {
  const s = makeRepo();
  try {
    const coordDir = coordCheckoutPath(s.dir);
    const out = probeHungCoordChildren(s.dir, {
      listRows: () => [
        { pid: 777, commandLine: `git -C ${coordDir} push origin master`, creationDateMs: 0 },
      ],
      now: 2 * 60_000, // 2 minutes — an ordinary, actively-working push
    });
    assert.deepEqual(out, [], 'a young match must never be reported as hung');
  } finally {
    s.cleanup();
  }
});

test('probeHungCoordChildren: a caller-supplied reportAgeMs overrides the default floor', () => {
  const s = makeRepo();
  try {
    const coordDir = coordCheckoutPath(s.dir);
    const out = probeHungCoordChildren(s.dir, {
      listRows: () => [{ pid: 777, commandLine: `git -C ${coordDir} fetch`, creationDateMs: 0 }],
      now: 2 * 60_000,
      reportAgeMs: 60_000, // a caller who wants a tighter floor than the derived default
    });
    assert.equal(out.length, 1, 'a lowered floor makes a 2min match reportable');
  } finally {
    s.cleanup();
  }
});

test('probeHungCoordChildren: an unparseable creation date (unknown age) is reported regardless of the floor', () => {
  const s = makeRepo();
  try {
    const coordDir = coordCheckoutPath(s.dir);
    const out = probeHungCoordChildren(s.dir, {
      listRows: () => [{ pid: 777, commandLine: `git -C ${coordDir} fetch`, creationDateMs: NaN }],
      now: 2 * 60_000,
    });
    assert.equal(out.length, 1, 'an unknown age cannot be ruled safe, so it stays visible');
    assert.equal(out[0].ageMs, null);
    assert.match(out[0].detail, /an unknown age/);
  } finally {
    s.cleanup();
  }
});

test('probeHungCoordChildren: a process NOT targeting the coord checkout is invisible to the probe', () => {
  const s = makeRepo();
  try {
    const out = probeHungCoordChildren(s.dir, {
      listRows: () => [{ pid: 1, commandLine: 'notepad.exe', creationDateMs: 0 }],
      now: 60_000,
    });
    assert.deepEqual(out, []);
  } finally {
    s.cleanup();
  }
});

// plan 4087 review fix (1lch7tj/cz4610): process enumeration is a raw subprocess call that can
// itself fail — that must degrade the probe, never the whole heal-main run.
test('probeHungCoordChildren: an enumeration failure reports blocked with enumerationUnavailable, never throws', () => {
  const s = makeRepo();
  try {
    const out = probeHungCoordChildren(s.dir, {
      listRows: () => {
        throw new Error('powershell.exe: ENOENT');
      },
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].step, 'hung-coord-children');
    assert.equal(out[0].status, 'blocked');
    assert.equal(out[0].enumerationUnavailable, true);
    assert.match(out[0].detail, /could not enumerate/);
    assert.match(out[0].detail, /powershell.exe: ENOENT/);
  } finally {
    s.cleanup();
  }
});

// plan 4087 review round 3 (finding heal-main.mjs:1719, angle-C): the live hang probe now runs
// on EVERY heal-main invocation unconditionally (T3's own acceptance clause) — a box that simply
// cannot spawn `ps`/`powershell.exe` (missing binary, a hardened sandbox) must not fail every
// single heal-main run from then on for a reason that has nothing to do with MAIN's actual git
// state. reportNeedsOperator is the SAME predicate main() uses for its exit code and its "N
// step(s) need the operator" line — proven here at the report level, since main() itself is not
// unit-testable (resolveMain/console/process.exit).
test('reportNeedsOperator: a process-enumeration failure never makes the verdict "needs operator" — same as if the probe had never run at all', () => {
  const s = makeRepo();
  try {
    const baseline = runHeal(s.dir, { log: () => {}, hungProbe: {} });
    const withFailingProbe = runHeal(s.dir, {
      log: () => {},
      hungProbe: {
        check: true,
        listRows: () => {
          throw new Error('powershell.exe: ENOENT');
        },
      },
    });
    assert.equal(
      reportNeedsOperator(baseline),
      false,
      'sanity: the healthy fixture needs no operator',
    );
    assert.equal(
      reportNeedsOperator(withFailingProbe),
      reportNeedsOperator(baseline),
      'a best-effort enumeration failure must not flip the verdict main() uses for its exit code',
    );
    // The failure is still visible in the report (advisory) — this is NOT the same as the probe
    // contributing nothing; it just must not be able to gate the verdict by itself.
    assert.ok(
      withFailingProbe.some((x) => x.step === 'hung-coord-children' && x.enumerationUnavailable),
    );
  } finally {
    s.cleanup();
  }
});

// plan 4087 review round 4 (finding heal-main.mjs:1775 reuse/simplification): reportNeedsOperator
// and main()'s "N step(s) need the operator" summary line used to each re-derive their own copy
// of the same filter — this pins blockingSteps as the ONE shared definition both build on.
test('blockingSteps: a literal blocked status is counted; a best-effort enumeration failure is excluded — the same set reportNeedsOperator treats as needing the operator', () => {
  const report = [
    { step: 'a', status: 'blocked', detail: 'real problem' },
    { step: 'b', status: 'blocked', detail: 'could not enumerate', enumerationUnavailable: true },
    { step: 'c', status: 'clean', detail: 'fine' },
    { step: 'd', status: 'fixed', detail: 'repaired' },
  ];
  assert.deepEqual(
    blockingSteps(report).map((x) => x.step),
    ['a'],
  );
  assert.equal(reportNeedsOperator(report), blockingSteps(report).length > 0);
});

test('probeHungCoordChildren: --kill-hung-coord-children kills only children at/above the age ceiling', () => {
  const s = makeRepo();
  try {
    const coordDir = coordCheckoutPath(s.dir);
    const killed = [];
    const out = probeHungCoordChildren(s.dir, {
      listRows: () => [
        { pid: 1, commandLine: `git -C ${coordDir} fetch`, creationDateMs: 0 }, // old — killed
        { pid: 2, commandLine: `git -C ${coordDir} clean -fd`, creationDateMs: 55_000 }, // young — spared
      ],
      now: 60_000,
      kill: true,
      killAgeMs: 30_000,
      // exercises the SELECTION contract killHungCoordChildren promises (>= ageMs, never a
      // real process signal) without depending on coord-child-probe.test.mjs's own spy shape.
      // plan 4087 review round 2 (finding coord-child-probe.mjs:250/251): the real
      // killHungCoordChildren annotates each eligible child with `reason` — this stub mirrors
      // that shape (a genuine, successful kill) so probeHungCoordChildren's own outcome-reading
      // logic is exercised honestly, not bypassed. Plan 4087 review round 3 (finding
      // coord-child-probe.mjs:298, simplification): `killed` is gone — `reason` alone is read.
      _killHungChildren: (children, ageMs) => {
        const sel = children.filter((c) => c.ageMs != null && c.ageMs >= ageMs);
        killed.push(...sel.map((c) => c.pid));
        return sel.map((c) => ({ ...c, reason: 'killed' }));
      },
    });
    assert.deepEqual(killed, [1]);
    const p1 = out.find((x) => x.pid === 1);
    const p2 = out.find((x) => x.pid === 2);
    assert.equal(p1.status, 'fixed');
    assert.match(p1.detail, /killed pid 1/);
    assert.equal(p2.status, 'blocked');
    assert.match(p2.detail, /below the .* kill threshold/);
  } finally {
    s.cleanup();
  }
});

// plan 4087 review round 2 (finding coord-child-probe.mjs:250/251, surfaced through heal-main's
// own report line): a kill that was ATTEMPTED but FAILED must never render as 'fixed' — and it
// must be distinguishable from "never attempted" (below the age ceiling).
test('probeHungCoordChildren: --kill-hung-coord-children — an attempted-but-FAILED kill is reported blocked, never fixed', () => {
  const s = makeRepo();
  try {
    const coordDir = coordCheckoutPath(s.dir);
    const out = probeHungCoordChildren(s.dir, {
      listRows: () => [{ pid: 9, commandLine: `git -C ${coordDir} fetch`, creationDateMs: 0 }],
      now: 60_000,
      kill: true,
      killAgeMs: 30_000,
      _killHungChildren: (children) => children.map((c) => ({ ...c, reason: 'kill-failed' })),
    });
    const p9 = out.find((x) => x.pid === 9);
    assert.equal(p9.status, 'blocked', 'a failed kill attempt must never report status fixed');
    assert.match(p9.detail, /kill itself failed/);
  } finally {
    s.cleanup();
  }
});

// plan 4087 review round 2 (finding coord-child-probe.mjs:194/228 — identity re-check): the
// identity-changed refusal is a DIFFERENT reported reason from a plain kill failure.
test('probeHungCoordChildren: --kill-hung-coord-children — an identity-changed refusal is reported distinctly from a kill failure', () => {
  const s = makeRepo();
  try {
    const coordDir = coordCheckoutPath(s.dir);
    const out = probeHungCoordChildren(s.dir, {
      listRows: () => [{ pid: 10, commandLine: `git -C ${coordDir} fetch`, creationDateMs: 0 }],
      now: 60_000,
      kill: true,
      killAgeMs: 30_000,
      _killHungChildren: (children) => children.map((c) => ({ ...c, reason: 'identity-changed' })),
    });
    const p10 = out.find((x) => x.pid === 10);
    assert.equal(p10.status, 'blocked');
    assert.match(p10.detail, /no longer matches/);
    assert.equal(p10.killOutcome, 'identity-changed');
  } finally {
    s.cleanup();
  }
});

// plan 4087 review round 3 (finding kill-tree.mjs:427/428, surfaced through this report line): a
// PARTIAL kill — the target pid itself died, but a descendant could not be confirmed killed —
// must be reported distinctly from both a plain kill failure and an identity refusal, never
// silently rendered as 'fixed'.
test('probeHungCoordChildren: --kill-hung-coord-children — a partial kill (target died, a descendant survived) is reported blocked, distinct from a plain kill failure', () => {
  const s = makeRepo();
  try {
    const coordDir = coordCheckoutPath(s.dir);
    const out = probeHungCoordChildren(s.dir, {
      listRows: () => [{ pid: 11, commandLine: `git -C ${coordDir} fetch`, creationDateMs: 0 }],
      now: 60_000,
      kill: true,
      killAgeMs: 30_000,
      _killHungChildren: (children) =>
        children.map((c) => ({
          ...c,
          reason: 'descendants-survived',
          descendantsFailed: [222, 223],
        })),
    });
    const p11 = out.find((x) => x.pid === 11);
    assert.equal(p11.status, 'blocked');
    assert.match(p11.detail, /descendant/i);
    assert.match(p11.detail, /222, 223/);
    assert.equal(p11.killOutcome, 'descendants-survived');
  } finally {
    s.cleanup();
  }
});

// ── runHeal wiring + the byte-identical acceptance clause ──────────────────────────────
// Acceptance (plan 4087): "with no hung child present its output must be byte-identical to
// today." The proof: the probe step contributes ZERO report entries in the healthy case —
// output is generated purely by iterating `report`, so zero entries added is structurally
// byte-identical to the pre-T3 report, not merely coincidentally so.
test('runHeal: with no hung coord-checkout child, the report carries no hung-coord-children step at all (byte-identical to pre-T3 output)', () => {
  const s = makeRepo();
  try {
    const logLines = [];
    const report = runHeal(s.dir, {
      log: (msg) => logLines.push(msg),
      hungProbe: { check: true, listRows: () => [] },
    });
    assert.ok(
      report.every((x) => x.step !== 'hung-coord-children'),
      'the probe must contribute ZERO lines when nothing is hung — any line here would change ' +
        "heal-main's output on every healthy run, which the acceptance clause forbids",
    );
    // A healthy repo still reports all-clean overall — confirms the probe did not fabricate a
    // block, and matches the pre-existing "runHeal: healthy repo reports all clean" contract.
    assert.ok(
      report.every((x) => x.status === 'clean'),
      JSON.stringify(report),
    );
    // plan 4087 review round 2 (finding heal-main.mjs:1522): the new immediate-surfacing log
    // line must stay silent too, on a healthy run — only a genuine finding should ever log.
    // `log` also carries OTHER steps' unrelated diagnostics (e.g. pre-yield-guard's own status
    // line), so this checks specifically for the hung-probe's own `[heal-main] ...` prefix,
    // not "log was never called at all".
    assert.ok(
      logLines.every((l) => !l.startsWith('[heal-main]')),
      `the hung-probe's own log line must never fire on a healthy run: ${JSON.stringify(logLines)}`,
    );
  } finally {
    s.cleanup();
  }
});

// plan 4087 review round 2 (finding heal-main.mjs:1522 — surface the hang BEFORE the blocking
// repair): the probe already ran before core() (finding 1jcp4d9/17bmr57), but its finding was
// only PRINTED with the final report — so an operator watching a hung `core()` never saw why.
// The fix makes the finding reach `log` (stderr, immediate, synchronous) from the SAME block
// that runs the probe — textually and structurally before `core()` is ever invoked (see
// runHeal's own source: the log loop sits inside `if (hungProbe.check) { ... }`, above the
// `const core = () => {...}` definition and every call to it). This test proves the CONTENT and
// unconditional nature of that log call; `withCoordLock`/`core()` are not mockable seams, so the
// "runs first" half of the claim is structural (verified by reading runHeal's source, right
// above this test's own citation) rather than independently provable by a black-box unit test.
test('runHeal: a hung coord-checkout child is logged IMMEDIATELY via `log`, naming the pid, distinct from the final report', () => {
  const s = makeRepo();
  try {
    const coordDir = coordCheckoutPath(s.dir);
    const logLines = [];
    const report = runHeal(s.dir, {
      log: (msg) => logLines.push(msg),
      hungProbe: {
        check: true,
        listRows: () => [
          {
            pid: 4343,
            commandLine: `git -C ${coordDir} fetch --quiet origin master`,
            creationDateMs: 0,
          },
        ],
        now: HUNG_COORD_CHILD_REPORT_AGE_MS + 5 * 60_000,
      },
    });
    assert.ok(
      logLines.some((l) => l.includes('4343')),
      'the immediate log line must name the pid',
    );
    assert.ok(
      logLines.some((l) => /BLOCKED/.test(l)),
      'a report-only (never-killed) hung finding logs as BLOCKED, not fixed',
    );
    // The finding still lands in the final report too — this is IN ADDITION to, never instead
    // of, the existing report-array contract.
    assert.ok(report.some((x) => x.step === 'hung-coord-children'));
  } finally {
    s.cleanup();
  }
});

// plan 4087 review fix (17bmr57): the probe must not spend a real process enumeration
// (powershell.exe/ps) on a run that never asked for hang detection at all — the default
// `hungProbe: {}` (no `check`) must never even CALL `listRows`.
test('runHeal: with hungProbe.check not set, the probe is skipped entirely — listRows is never called', () => {
  const s = makeRepo();
  try {
    let calls = 0;
    const report = runHeal(s.dir, {
      log: () => {},
      hungProbe: {
        listRows: () => {
          calls++;
          return [];
        },
      },
    });
    assert.equal(calls, 0, 'the probe must not run at all when hungProbe.check is falsy');
    assert.ok(report.every((x) => x.step !== 'hung-coord-children'));
  } finally {
    s.cleanup();
  }
});

test('runHeal: a live hung coord-checkout child makes the run report blocked, never healthy', () => {
  const s = makeRepo();
  try {
    const coordDir = coordCheckoutPath(s.dir);
    const report = runHeal(s.dir, {
      log: () => {},
      hungProbe: {
        check: true,
        listRows: () => [
          {
            pid: 4242,
            commandLine: `git -C ${coordDir} fetch --quiet origin master`,
            creationDateMs: 0,
          },
        ],
        now: HUNG_COORD_CHILD_REPORT_AGE_MS + 5 * 60_000, // past the floor — genuinely suspicious
      },
    });
    const hungSteps = report.filter((x) => x.step === 'hung-coord-children');
    assert.equal(hungSteps.length, 1);
    assert.equal(hungSteps[0].status, 'blocked');
    assert.ok(
      report.some((x) => x.status === 'blocked'),
      "a live hung child must make the OVERALL report non-healthy, matching main()'s exit-1 branch",
    );
    // plan 4087 review fix (1jcp4d9): the probe now runs BEFORE core()'s own steps — report
    // order directly encodes call order (every step is `report.push`-ed as it runs), so the
    // hung-coord-children entry must be the FIRST thing in the report, ahead of every step
    // core() contributes (truncated-index, stale-index, stale-locks, …).
    assert.equal(
      report[0].step,
      'hung-coord-children',
      'the live-hang probe must run before core() ever tries to acquire the coord lock',
    );
  } finally {
    s.cleanup();
  }
});

test('runHeal: --dry never kills a hung child, whatever hungProbe.kill says', () => {
  const s = makeRepo();
  try {
    const coordDir = coordCheckoutPath(s.dir);
    let killCalls = 0;
    const report = runHeal(s.dir, {
      dry: true,
      hungProbe: {
        check: true,
        listRows: () => [
          { pid: 9, commandLine: `git -C ${coordDir} reset --hard`, creationDateMs: 0 },
        ],
        now: 60_000,
        kill: true,
        killAgeMs: 1000,
        _killHungChildren: () => {
          killCalls++;
          return [];
        },
      },
    });
    assert.equal(killCalls, 0, 'a --dry run must never invoke the kill path');
    const hungStep = report.find((x) => x.step === 'hung-coord-children');
    assert.equal(hungStep.status, 'blocked', 'dry mode reports it, but never as fixed');
  } finally {
    s.cleanup();
  }
});

// ── parseHealMainArgs — the CLI boundary (plan 4087 review fixes 11fec5/5n7bqo/h3eh4e) ─────
// Pure function, argv in / options-or-error out — no process.argv, console.error, or
// process.exit mocking needed.
test('parseHealMainArgs: no flags — everything off, no error', () => {
  const parsed = parseHealMainArgs([]);
  assert.equal(parsed.error, undefined);
  // plan 4087 review round 2 (finding heal-main.mjs:1521): no `checkHung` field any more — the
  // report-only probe is unconditional now (main() always passes `hungProbe.check: true`), so
  // there is nothing left for a CLI flag to gate.
  assert.deepEqual(parsed, {
    dry: false,
    json: false,
    killHung: false,
    killAgeMs: null, // HUNG_COORD_CHILD_KILL_AGE_MS — still unset
  });
});

test('parseHealMainArgs: an unknown argument is refused', () => {
  const parsed = parseHealMainArgs(['--bogus']);
  assert.match(parsed.error, /unknown argument "--bogus"/);
});

// plan 4087 review fix (11fec5): --kill-age-ms on its own is inert — refuse it outright.
test('parseHealMainArgs: --kill-age-ms without --kill-hung-coord-children is refused', () => {
  const parsed = parseHealMainArgs(['--kill-age-ms=5000']);
  assert.match(parsed.error, /inert without --kill-hung-coord-children/);
});

test('parseHealMainArgs: --kill-hung-coord-children without --kill-age-ms is refused (no baked-in ceiling)', () => {
  const parsed = parseHealMainArgs(['--kill-hung-coord-children']);
  assert.match(parsed.error, /needs --kill-age-ms/);
});

// plan 4087 review fix (5n7bqo/h3eh4e): a negative ceiling means "kill everything".
test('parseHealMainArgs: a negative --kill-age-ms is refused', () => {
  const parsed = parseHealMainArgs(['--kill-hung-coord-children', '--kill-age-ms=-5000']);
  assert.match(parsed.error, /non-negative number, got -5000/);
});

test('parseHealMainArgs: a negative --kill-age-ms WITHOUT the kill switch gets the clearer "inert" message, not the negative one', () => {
  const parsed = parseHealMainArgs(['--kill-age-ms=-5000']);
  assert.match(parsed.error, /inert without --kill-hung-coord-children/);
});

test('parseHealMainArgs: zero is a valid (if extreme) --kill-age-ms', () => {
  const parsed = parseHealMainArgs(['--kill-hung-coord-children', '--kill-age-ms=0']);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.killAgeMs, 0);
});

test('parseHealMainArgs: --kill-hung-coord-children + --kill-age-ms is valid', () => {
  const parsed = parseHealMainArgs(['--kill-hung-coord-children', '--kill-age-ms=45000']);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.killHung, true);
  assert.equal(parsed.killAgeMs, 45000);
});

// plan 4087 review round 2 (finding heal-main.mjs:1521): `--check-hung-coord-children` is
// REMOVED — the report-only probe runs unconditionally now, so a flag that used to turn it on
// is unknown, exactly like any other retired argument.
test('parseHealMainArgs: --check-hung-coord-children is REMOVED — now an unknown argument', () => {
  const parsed = parseHealMainArgs(['--check-hung-coord-children']);
  assert.match(parsed.error, /unknown argument "--check-hung-coord-children"/);
});

test('parseHealMainArgs: --dry and --json pass through untouched alongside the hang flags', () => {
  const parsed = parseHealMainArgs([
    '--dry',
    '--json',
    '--kill-hung-coord-children',
    '--kill-age-ms=9000',
  ]);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.dry, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.killAgeMs, 9000);
});
