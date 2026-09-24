// scripts/sweep-stray-stashes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isStrayStash, isSubsumedByHead, isNoOpStash, sweep } from './sweep-stray-stashes.mjs';
import { parseStashList } from './coord-git.mjs';

// plan 338: clear inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE so the temp-repo
// helpers below honour `git -C <tmpdir>` even when this suite runs inside a git
// hook (which exports those vars and would otherwise redirect git ops onto the
// real repo — shared user.name corruption + junk commits, proven 2026-06-04).
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

test('isStrayStash matches auto-WIP and named wip- stashes, not real work', () => {
  assert.equal(isStrayStash('WIP on master: 1a2b3c init'), true);
  assert.equal(isStrayStash('On master: wip-220-foo-2026-05-30T1200'), true);
  assert.equal(isStrayStash('On master: refactor the parser'), false);
  assert.equal(isStrayStash('On feature/x: WIP on feature/x: deadbee msg'), true);
});

test('parseStashList splits ref<TAB>subject lines', () => {
  const raw = 'stash@{0}\tWIP on master: abc msg\nstash@{1}\tOn master: wip-x-1\n';
  const parsed = parseStashList(raw);
  assert.deepEqual(parsed, [
    { ref: 'stash@{0}', subject: 'WIP on master: abc msg' },
    { ref: 'stash@{1}', subject: 'On master: wip-x-1' },
  ]);
  assert.deepEqual(parseStashList(''), []);
});

// --- real-git integration ----------------------------------------------------
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-stash-test-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  g('add', 'f.txt');
  g('commit', '-qm', 'init');
  return { dir, g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('sweep drops a subsumed stray stash and surfaces a non-subsumed one', () => {
  const r = makeRepo();
  try {
    // (1) subsumed: stash a change, then land that same change on HEAD.
    writeFileSync(join(r.dir, 'f.txt'), 'base\nlanded-change\n');
    r.g('stash', 'push', '-m', 'wip-subsumed-1');
    writeFileSync(join(r.dir, 'f.txt'), 'base\nlanded-change\n');
    r.g('commit', '-aqm', 'land the change');

    // (2) non-subsumed: stash a change that is NOT on HEAD.
    writeFileSync(join(r.dir, 'f.txt'), 'base\nlanded-change\nunique-unlanded\n');
    r.g('stash', 'push', '-m', 'wip-unlanded-2');

    // (3) a real (non-stray) stash that must be left untouched.
    writeFileSync(join(r.dir, 'g.txt'), 'real work\n');
    r.g('add', 'g.txt');
    r.g('stash', 'push', '-m', 'real work in progress');

    const out = sweep(r.dir, { log: () => {} });
    assert.equal(out.dropped.length, 1, 'exactly the subsumed stash dropped');
    assert.match(out.dropped[0].subject, /wip-subsumed-1/);
    assert.equal(out.surfaced.length, 1, 'the non-subsumed stray surfaced');
    assert.match(out.surfaced[0].subject, /wip-unlanded-2/);

    // The real-work stash and the surfaced stash must still exist.
    const remaining = r.g('stash', 'list', '--format=%gs');
    assert.match(remaining, /real work in progress/);
    assert.match(remaining, /wip-unlanded-2/);
    assert.doesNotMatch(remaining, /wip-subsumed-1/);
  } finally {
    r.cleanup();
  }
});

test('sweep --dry-run drops nothing', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\nx\n');
    r.g('stash', 'push', '-m', 'wip-subsumed-1');
    writeFileSync(join(r.dir, 'f.txt'), 'base\nx\n');
    r.g('commit', '-aqm', 'land');

    const out = sweep(r.dir, { dryRun: true, log: () => {} });
    assert.equal(out.dropped.length, 0);
    assert.match(r.g('stash', 'list', '--format=%gs'), /wip-subsumed-1/);
  } finally {
    r.cleanup();
  }
});

test('a mixed --include-untracked stash is NEVER dropped even if its tracked diff is subsumed', () => {
  const r = makeRepo();
  try {
    // tracked change + an untracked file, parked together (what pre-yield-guard does)
    writeFileSync(join(r.dir, 'f.txt'), 'base\ntracked-change\n');
    writeFileSync(join(r.dir, 'extra.txt'), 'untracked-only\n');
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-mixed-1');
    // land ONLY the tracked change on HEAD → tracked diff is now subsumed…
    writeFileSync(join(r.dir, 'f.txt'), 'base\ntracked-change\n');
    r.g('commit', '-aqm', 'land tracked part only');

    // …but extra.txt was never committed, so the stash must be surfaced, not dropped.
    assert.equal(isSubsumedByHead(r.dir, 'stash@{0}'), false);
    const out = sweep(r.dir, { log: () => {} });
    assert.equal(out.dropped.length, 0);
    assert.equal(out.surfaced.length, 1);
    assert.match(r.g('stash', 'list', '--format=%gs'), /wip-mixed-1/);
  } finally {
    r.cleanup();
  }
});

test('an --include-untracked stash with an EMPTY ^3 (no untracked files) IS evaluated/dropped when subsumed', () => {
  const r = makeRepo();
  try {
    // pre-yield-guard always parks with --include-untracked; when nothing is untracked
    // the ^3 parent is git's empty tree. Such a stash must still be droppable if subsumed.
    writeFileSync(join(r.dir, 'f.txt'), 'base\ntracked-only-change\n');
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-empty3-1'); // no untracked files present
    writeFileSync(join(r.dir, 'f.txt'), 'base\ntracked-only-change\n');
    r.g('commit', '-aqm', 'land the tracked change'); // now subsumed by HEAD

    assert.equal(isSubsumedByHead(r.dir, 'stash@{0}'), true, 'empty ^3 + subsumed → droppable');
    const out = sweep(r.dir, { log: () => {} });
    assert.equal(out.dropped.length, 1);
    assert.match(out.dropped[0].subject, /wip-empty3-1/);
    assert.doesNotMatch(r.g('stash', 'list', '--format=%gs'), /wip-empty3-1/);
  } finally {
    r.cleanup();
  }
});

test('a subsumed-looking empty-^3 stash is NOT dropped when the change is only DIRTY in the working tree (compare HEAD, not WT) — plan 1108', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\nidle-edit\n');
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-wtdirty-1'); // empty ^3, change parked
    // re-present the SAME change as UNCOMMITTED working-tree dirt (never committed to HEAD)
    writeFileSync(join(r.dir, 'f.txt'), 'base\nidle-edit\n');
    assert.equal(
      isSubsumedByHead(r.dir, 'stash@{0}'),
      false,
      'change is in dirty WT, not HEAD → not subsumed',
    );
    const out = sweep(r.dir, { log: () => {} });
    assert.equal(out.dropped.length, 0);
    assert.match(r.g('stash', 'list', '--format=%gs'), /wip-wtdirty-1/);
  } finally {
    r.cleanup();
  }
});

test('a stash containing a RENAME is NOT dropped when only the destination landed on HEAD (--no-renames) — plan 1108', () => {
  const r = makeRepo();
  try {
    r.g('config', 'diff.renames', 'true'); // force rename detection on (the buggy path)
    // Stage a rename f.txt -> g.txt and park it (stash also DELETES f.txt).
    r.g('mv', 'f.txt', 'g.txt');
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-rename-1'); // empty ^3
    // Land ONLY the destination on HEAD; f.txt is STILL present (rename not fully applied).
    writeFileSync(join(r.dir, 'g.txt'), 'base\n');
    r.g('add', 'g.txt');
    r.g('commit', '-qm', 'add g.txt (destination only; f.txt still present)');
    // The stash's deletion of f.txt is NOT on HEAD → must surface, not drop.
    assert.equal(
      isSubsumedByHead(r.dir, 'stash@{0}'),
      false,
      'rename source deletion not on HEAD → surface',
    );
    const out = sweep(r.dir, { log: () => {} });
    assert.equal(out.dropped.length, 0);
    assert.match(r.g('stash', 'list', '--format=%gs'), /wip-rename-1/);
  } finally {
    r.cleanup();
  }
});

test('isSubsumedByHead is false for a stash with no diff or unlanded work', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\nnever-landed\n');
    r.g('stash', 'push', '-m', 'wip-x-1');
    assert.equal(isSubsumedByHead(r.dir, 'stash@{0}'), false);
  } finally {
    r.cleanup();
  }
});

// ── plan 3206: no-op stash classification ─────────────────────────────────────
// A repo where `.gitattributes` normalizes a tracked file's line endings — the shape
// pre-yield-guard's own CRLF-only-rewrite bug (plan 3206) produces: `git status
// --porcelain` flags the file dirty, but the stash git creates from it is byte-identical
// to the commit it was parked on top of (reproduced 2026-08-15, see the plan body).
function makeEolRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-stash-eol-test-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  g('config', 'core.autocrlf', 'true');
  writeFileSync(join(dir, '.gitattributes'), '* text=auto eol=lf\n');
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  g('add', '.gitattributes', 'f.txt');
  g('commit', '-qm', 'init');
  return { dir, g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('isNoOpStash: true for a stash whose only dirt was a CRLF-only rewrite (normalized away)', () => {
  const r = makeEolRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), Buffer.from('base\r\n'));
    assert.match(r.g('status', '--porcelain'), /f\.txt/, 'porcelain flags it dirty');
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-noop-1');
    assert.equal(isNoOpStash(r.dir, 'stash@{0}'), true);
  } finally {
    r.cleanup();
  }
});

test('isNoOpStash: false for a stash holding a real tracked change', () => {
  const r = makeEolRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\nreal-change\n');
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-real-1');
    assert.equal(isNoOpStash(r.dir, 'stash@{0}'), false);
  } finally {
    r.cleanup();
  }
});

test('isNoOpStash: false for a stash holding only an untracked file', () => {
  const r = makeEolRepo();
  try {
    writeFileSync(join(r.dir, 'new.txt'), 'new\n');
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-untracked-1');
    assert.equal(isNoOpStash(r.dir, 'stash@{0}'), false);
  } finally {
    r.cleanup();
  }
});

test('sweep: drops a no-op stash and reports it in its own bucket, distinct from subsumed', () => {
  const r = makeEolRepo();
  try {
    // no-op: CRLF-only rewrite, normalizes away — holds nothing.
    writeFileSync(join(r.dir, 'f.txt'), Buffer.from('base\r\n'));
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-noop-1');

    // subsumed: a real change parked, then landed on HEAD.
    writeFileSync(join(r.dir, 'f.txt'), 'base\nlanded\n');
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-subsumed-1');
    writeFileSync(join(r.dir, 'f.txt'), 'base\nlanded\n');
    r.g('commit', '-aqm', 'land it');

    // un-landed real work: never lands anywhere → must still be surfaced, never dropped.
    writeFileSync(join(r.dir, 'f.txt'), 'base\nlanded\nunique-unlanded\n');
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-unlanded-1');

    const out = sweep(r.dir, { log: () => {} });
    assert.equal(out.droppedNoOp.length, 1, 'exactly the no-op stash dropped as no-op');
    assert.match(out.droppedNoOp[0].subject, /wip-noop-1/);
    assert.equal(out.dropped.length, 1, 'the subsumed stash dropped as subsumed');
    assert.match(out.dropped[0].subject, /wip-subsumed-1/);
    assert.equal(out.surfaced.length, 1, 'un-landed work still surfaced');
    assert.match(out.surfaced[0].subject, /wip-unlanded-1/);

    const remaining = r.g('stash', 'list', '--format=%gs');
    assert.match(remaining, /wip-unlanded-1/);
    assert.doesNotMatch(remaining, /wip-noop-1/);
    assert.doesNotMatch(remaining, /wip-subsumed-1/);
  } finally {
    r.cleanup();
  }
});

test('sweep --dry-run: a no-op stash is offered in the no-op bucket but not dropped', () => {
  const r = makeEolRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), Buffer.from('base\r\n'));
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-noop-1');
    const out = sweep(r.dir, { dryRun: true, log: () => {} });
    assert.equal(out.droppedNoOp.length, 0, 'dry-run drops nothing');
    assert.match(r.g('stash', 'list', '--format=%gs'), /wip-noop-1/, 'stash left untouched');
  } finally {
    r.cleanup();
  }
});
