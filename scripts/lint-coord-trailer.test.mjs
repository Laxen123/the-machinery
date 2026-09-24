// scripts/lint-coord-trailer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitNeedsTrailer, hasTrailer, indexHunkInGenerated } from './lint-coord-trailer.mjs';
import { INDEX_PLANS_START, INDEX_PLANS_END } from './coord/build-index-lib.mjs';
import { derivePaths } from './coord/coord-config.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'lint-coord-trailer.mjs');

// plan 338: clear inherited GIT_* so the temp-repo helpers honour `git -C <tmpdir>`
// even when this suite runs inside a git hook (which would otherwise redirect git
// ops onto the real repo — shared user.name corruption + junk commits).
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

test('hasTrailer detects the Coord-Write trailer', () => {
  assert.equal(hasTrailer('subj\n\nCoord-Write: board\n'), true);
  assert.equal(hasTrailer('subj\n\nno trailer here\n'), false);
});

test('board edit always needs the trailer', () => {
  assert.equal(
    commitNeedsTrailer({ files: ['handoff-board.md'], indexTouchesGenerated: false }),
    true,
  );
});

// plan 3973: the queue doc left master for refs/heads/coord/landing-queue; the master-side
// file is a tombstone the cut-over land / `landing-queue.mjs migrate` writes WITHOUT a trailer,
// so the plan-504 expectation is retired (a stray hand edit is caught by the readers' loud-fail).
test('landing-queue.md edit no longer needs the trailer (plan 3973 retired the plan-504 rule)', () => {
  assert.equal(
    commitNeedsTrailer({ files: ['landing-queue.md'], indexTouchesGenerated: false }),
    false,
  );
});

test('INDEX edit inside the generated region needs the trailer', () => {
  assert.equal(commitNeedsTrailer({ files: ['docs/INDEX.md'], indexTouchesGenerated: true }), true);
});

// plan 857: with the docs/handoff/ paths injected (vetapp production config), the
// relocated board still requires the trailer, and the legacy root names no longer do
// (they are not the configured coordination files). plan 3973: the relocated queue doc
// is the tombstone and is exempt too.
test('board under docs/handoff/ needs the trailer; the queue tombstone and legacy root names do not', () => {
  const paths = derivePaths('docs/handoff');
  assert.equal(
    commitNeedsTrailer({ files: ['docs/handoff/board.md'], indexTouchesGenerated: false, paths }),
    true,
  );
  assert.equal(
    commitNeedsTrailer({
      files: ['docs/handoff/landing-queue.md'],
      indexTouchesGenerated: false,
      paths,
    }),
    false,
  );
  assert.equal(
    commitNeedsTrailer({ files: ['handoff-board.md'], indexTouchesGenerated: false, paths }),
    false,
  );
});

test('INDEX edit only OUTSIDE the generated region (archive prose) is exempt', () => {
  assert.equal(
    commitNeedsTrailer({ files: ['docs/INDEX.md'], indexTouchesGenerated: false }),
    false,
  );
});

test('a commit touching neither guarded doc is exempt', () => {
  assert.equal(
    commitNeedsTrailer({ files: ['scripts/x.mjs'], indexTouchesGenerated: false }),
    false,
  );
});

test('indexHunkInGenerated: a changed line number inside the sentinels returns true', () => {
  const lines = ['# INDEX', INDEX_PLANS_START, '- a', '- b', INDEX_PLANS_END, 'archive prose'];
  assert.equal(indexHunkInGenerated(lines, [3]), true); // line 3 ('- a') is inside
  assert.equal(indexHunkInGenerated(lines, [6]), false); // line 6 (prose) is outside
});

test('indexHunkInGenerated: missing sentinels → strict (true)', () => {
  const lines = ['# INDEX', '- a', '- b', 'archive prose'];
  assert.equal(indexHunkInGenerated(lines, [2]), true);
});

test('indexHunkInGenerated: a change spanning both inside and outside is caught (true)', () => {
  const lines = ['# INDEX', INDEX_PLANS_START, '- a', INDEX_PLANS_END, 'prose'];
  assert.equal(indexHunkInGenerated(lines, [3, 5]), true); // line 3 inside, 5 outside → true
});

// --- real-git: the guard CLI over a commit range ----------------------------
const INDEX_SEED = [
  '# Plans index',
  '',
  '## Active / open',
  '',
  INDEX_PLANS_START,
  '',
  '**ready/**',
  '',
  '- 🟩 a plan → `ready/001-X-a.md`',
  '',
  INDEX_PLANS_END,
  '',
  '## Archive',
  '',
  'Moved to `docs/superpowers/plans/archive/` on 2026-01-01:',
  '- `000-X-old.md` — shipped',
  '',
].join('\n');

const BOARD_SEED = '# Board\n\n| slug | state |\n| ---- | ----- |\n';
const BOARD_EDITED = '# Board\n\n| slug | state |\n| ---- | ----- |\n| z | x |\n';

// init a repo with handoff-board.md + docs/INDEX.md, make a baseline commit, and
// return the baseline sha so each test can commit a candidate and lint base..HEAD.
function makeRangeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'lint-trailer-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'handoff-board.md'), BOARD_SEED);
  writeFileSync(join(dir, 'docs', 'INDEX.md'), INDEX_SEED);
  g('add', '-A');
  g('commit', '-qm', 'baseline');
  const base = g('rev-parse', 'HEAD').trim();
  return { dir, g, base, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// run the guard CLI over one or more ranges (plan 1289: argv[2..]); returns { code, stderr }
function runGuard(dir, ...ranges) {
  try {
    execFileSync(process.execPath, [CLI, ...ranges], { cwd: dir, encoding: 'utf8' });
    return { code: 0, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stderr: `${e.stderr || ''}` };
  }
}

test('guard CLI: a hand-edited handoff-board.md commit WITHOUT the trailer is rejected', () => {
  const r = makeRangeRepo();
  try {
    writeFileSync(join(r.dir, 'handoff-board.md'), BOARD_EDITED);
    r.g('add', 'handoff-board.md');
    r.g('commit', '-qm', 'chore: hand-edit board (no trailer)');
    const res = runGuard(r.dir, `${r.base}..HEAD`);
    assert.equal(res.code, 1, 'guard must reject the un-trailered board edit');
    assert.match(res.stderr, /Coord-Write trailer/);
  } finally {
    r.cleanup();
  }
});

test('guard CLI: a board commit WITH the Coord-Write trailer passes', () => {
  const r = makeRangeRepo();
  try {
    writeFileSync(join(r.dir, 'handoff-board.md'), BOARD_EDITED);
    r.g('add', 'handoff-board.md');
    r.g('commit', '-qm', 'chore(handoff): claim z on board\n\nCoord-Write: board');
    assert.equal(runGuard(r.dir, `${r.base}..HEAD`).code, 0);
  } finally {
    r.cleanup();
  }
});

test('guard CLI: an INDEX archive-prose edit OUTSIDE the sentinels (no trailer) passes', () => {
  const r = makeRangeRepo();
  try {
    const edited = INDEX_SEED.replace(
      '- `000-X-old.md` — shipped',
      '- `000-X-old.md` — shipped, merged abc',
    );
    writeFileSync(join(r.dir, 'docs', 'INDEX.md'), edited);
    r.g('add', 'docs/INDEX.md');
    r.g('commit', '-qm', 'docs: tidy archive prose');
    assert.equal(runGuard(r.dir, `${r.base}..HEAD`).code, 0, 'prose-only INDEX edit is exempt');
  } finally {
    r.cleanup();
  }
});

test('guard CLI: a landing-queue.md commit WITHOUT the trailer passes (plan 3973: the tombstone is not a coord doc)', () => {
  const r = makeRangeRepo();
  try {
    writeFileSync(join(r.dir, 'landing-queue.md'), '<!-- landing-queue: tombstone -->\n');
    r.g('add', 'landing-queue.md');
    r.g('commit', '-qm', 'chore: tombstone the queue doc (no trailer)');
    const res = runGuard(r.dir, `${r.base}..HEAD`);
    assert.equal(res.code, 0, 'the master-side queue file is no longer trailer-guarded');
  } finally {
    r.cleanup();
  }
});

test('guard CLI: a landing-queue.md commit WITH the trailer passes (plan 504)', () => {
  const r = makeRangeRepo();
  try {
    writeFileSync(join(r.dir, 'landing-queue.md'), '# queue\n\n| slug |\n| --- |\n| tool |\n');
    r.g('add', 'landing-queue.md');
    r.g('commit', '-qm', 'coord(queue): enqueue tool\n\nCoord-Write: landing-queue');
    assert.equal(runGuard(r.dir, `${r.base}..HEAD`).code, 0);
  } finally {
    r.cleanup();
  }
});

// --- plan 1289: multiple ranges (the pre-push hook passes one range per pushed ref) ---

test('guard CLI: multiple ranges union — an offender in the SECOND range is still caught', () => {
  const r = makeRangeRepo();
  try {
    writeFileSync(join(r.dir, 'other.md'), 'benign\n');
    r.g('add', 'other.md');
    r.g('commit', '-qm', 'docs: benign commit');
    const mid = r.g('rev-parse', 'HEAD').trim();
    writeFileSync(join(r.dir, 'handoff-board.md'), BOARD_EDITED);
    r.g('add', 'handoff-board.md');
    r.g('commit', '-qm', 'chore: hand-edit board (no trailer)');
    const res = runGuard(r.dir, `${r.base}..${mid}`, `${mid}..HEAD`);
    assert.equal(res.code, 1, 'the offender in the second range must be caught by the union');
    assert.match(res.stderr, /Coord-Write trailer/);
  } finally {
    r.cleanup();
  }
});

test('guard CLI: an offending commit OUTSIDE the passed ranges is not flagged (pushed-delta scoping)', () => {
  // The plan-1289 fix: an un-trailered commit that is NOT part of this push
  // (here: outside the passed range) must not block — the old self-computed
  // origin/master..HEAD default was exactly how herd drift produced spurious hits.
  const r = makeRangeRepo();
  try {
    writeFileSync(join(r.dir, 'handoff-board.md'), BOARD_EDITED);
    r.g('add', 'handoff-board.md');
    r.g('commit', '-qm', 'chore: hand-edit board (no trailer)');
    const mid = r.g('rev-parse', 'HEAD').trim();
    writeFileSync(join(r.dir, 'other.md'), 'benign\n');
    r.g('add', 'other.md');
    r.g('commit', '-qm', 'docs: benign commit');
    assert.equal(
      runGuard(r.dir, `${mid}..HEAD`).code,
      0,
      'a range excluding the offender must pass',
    );
  } finally {
    r.cleanup();
  }
});

test('guard CLI: a failing range is warn-skipped while an offender in the OTHER range still blocks', () => {
  // plan-1289 delta-review finding: an unresolvable range must neither be dropped
  // silently NOR abort the whole check — the resolvable sibling range's
  // un-trailered commit must still block the push.
  const r = makeRangeRepo();
  try {
    writeFileSync(join(r.dir, 'handoff-board.md'), BOARD_EDITED);
    r.g('add', 'handoff-board.md');
    r.g('commit', '-qm', 'chore: hand-edit board (no trailer)');
    const res = runGuard(r.dir, 'deadbeef..cafebabe', `${r.base}..HEAD`);
    assert.equal(res.code, 1, 'the offender in the resolvable range must still be caught');
    assert.match(res.stderr, /range deadbeef\.\.cafebabe SKIPPED/, 'the bad range warns visibly');
    assert.match(res.stderr, /Coord-Write trailer/);
  } finally {
    r.cleanup();
  }
});

test('guard CLI: an INDEX edit INSIDE the generated region (no trailer) is rejected', () => {
  const r = makeRangeRepo();
  try {
    const edited = INDEX_SEED.replace(
      '- 🟩 a plan → `ready/001-X-a.md`',
      '- 🟩 a plan EDITED → `ready/001-X-a.md`',
    );
    writeFileSync(join(r.dir, 'docs', 'INDEX.md'), edited);
    r.g('add', 'docs/INDEX.md');
    r.g('commit', '-qm', 'docs: hand-edit generated bullet');
    assert.equal(
      runGuard(r.dir, `${r.base}..HEAD`).code,
      1,
      'generated-region edit needs the trailer',
    );
  } finally {
    r.cleanup();
  }
});
