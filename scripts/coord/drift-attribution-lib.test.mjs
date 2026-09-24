// scripts/drift-attribution-lib.test.mjs (plan 1664)
// Pure-core tests for computeDriftIsInherited — the shared git-attribution plumbing
// lifted out of lint-plan-index.mjs's driftIsInherited (plan 1650, layer 2) so
// lint-board.mjs can reuse it against its own pathspec set. This file pins the ONE
// true attribution matrix; lint-plan-index.test.mjs and lint-board.test.mjs each add
// only a thin pin that their own wrapper delegates here with the right pathspecs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDriftIsInherited,
  checkWorktreeCoordDocStale,
  formatStaleWorktreeCoordDocMessage,
} from './drift-attribution-lib.mjs';
import { fakeExec } from '../fake-git-exec.mjs';

const PATHSPECS = ['docs/some-input.md', 'scripts/some-generator.mjs'];

test('computeDriftIsInherited: worktree branch, inputs untouched + clean tree → inherited (true)', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-1664-x\n',
    'merge-base': 'abc123\n',
    diff: '', // exit 0 ⇔ untouched
    status: '', // clean working tree over the pathspecs
  });
  assert.equal(computeDriftIsInherited({ repoRoot: '/repo', pathspecs: PATHSPECS, _exec }), true);
  assert.ok(
    _exec.calls.some((c) => c.includes('diff --quiet abc123 HEAD --')),
    'attribution must diff merge-base..HEAD over the input pathspecs',
  );
  assert.ok(
    _exec.calls.some((c) => c.includes(PATHSPECS[0]) && c.includes(PATHSPECS[1])),
    'the caller-supplied pathspecs must reach the diff/status calls verbatim',
  );
  assert.ok(
    !_exec.calls.some((c) => c.startsWith('fetch')),
    'no network fetch — a stale local origin/master only moves the answer toward strict',
  );
});

test('computeDriftIsInherited: local working-tree dirt over the inputs → strict (false)', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-1664-x\n',
    'merge-base': 'abc123\n',
    diff: '',
    status: ' M docs/some-input.md\n', // uncommitted local edit
  });
  assert.equal(computeDriftIsInherited({ repoRoot: '/repo', pathspecs: PATHSPECS, _exec }), false);
});

test('computeDriftIsInherited: branch touched an input → strict (false)', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-1664-x\n',
    'merge-base': 'abc123\n',
    diff: () => {
      const e = new Error('exit 1');
      e.status = 1;
      throw e;
    },
  });
  assert.equal(computeDriftIsInherited({ repoRoot: '/repo', pathspecs: PATHSPECS, _exec }), false);
});

test('computeDriftIsInherited: master stays strict — a master push can heal in the same motion', () => {
  const _exec = fakeExec({ 'rev-parse': 'master\n' });
  assert.equal(computeDriftIsInherited({ repoRoot: '/repo', pathspecs: PATHSPECS, _exec }), false);
  assert.equal(_exec.calls.length, 1, 'must short-circuit before any other git call');
});

test('computeDriftIsInherited: detached HEAD stays strict', () => {
  const _exec = fakeExec({ 'rev-parse': 'HEAD\n' });
  assert.equal(computeDriftIsInherited({ repoRoot: '/repo', pathspecs: PATHSPECS, _exec }), false);
});

test('computeDriftIsInherited: unresolvable origin/master (no merge-base) → strict, fail-closed', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-1664-x\n',
    'merge-base': () => {
      throw new Error('fatal: no merge base');
    },
  });
  assert.equal(computeDriftIsInherited({ repoRoot: '/repo', pathspecs: PATHSPECS, _exec }), false);
});

test('computeDriftIsInherited: rev-parse failure → strict', () => {
  const _exec = fakeExec({
    'rev-parse': () => {
      throw new Error('not a git repo');
    },
  });
  assert.equal(computeDriftIsInherited({ repoRoot: '/repo', pathspecs: PATHSPECS, _exec }), false);
});

test('computeDriftIsInherited: throws on an empty/missing pathspecs array — a caller bug, not a git outcome', () => {
  assert.throws(
    () => computeDriftIsInherited({ repoRoot: '/repo', pathspecs: [] }),
    /non-empty array/,
  );
  assert.throws(() => computeDriftIsInherited({ repoRoot: '/repo' }), /non-empty array/);
});

// --- env seam (plan 1669 — shared rev-parse/merge-base across the two pre-push gates) ---

test('computeDriftIsInherited: env.COORD_DRIFT_BRANCH + COORD_DRIFT_BASE present → skips rev-parse AND merge-base, still runs diff/status', () => {
  const _exec = fakeExec({
    diff: '', // exit 0 ⇔ untouched
    status: '', // clean working tree over the pathspecs
    // deliberately no 'rev-parse' / 'merge-base' handlers — fakeExec throws
    // "unexpected git X" if either is called, proving they were skipped.
  });
  const env = { COORD_DRIFT_BRANCH: 'worktree-1669-x', COORD_DRIFT_BASE: 'abc123' };
  assert.equal(
    computeDriftIsInherited({ repoRoot: '/repo', pathspecs: PATHSPECS, _exec, env }),
    true,
  );
  assert.equal(
    _exec.calls.length,
    2,
    'only diff + status should run — rev-parse/merge-base came from env',
  );
  assert.ok(_exec.calls.some((c) => c.includes('diff --quiet abc123 HEAD --')));
});

test('computeDriftIsInherited: env.COORD_DRIFT_BRANCH === "master" → strict, no git calls at all', () => {
  const _exec = fakeExec({});
  const env = { COORD_DRIFT_BRANCH: 'master' };
  assert.equal(
    computeDriftIsInherited({ repoRoot: '/repo', pathspecs: PATHSPECS, _exec, env }),
    false,
  );
  assert.equal(_exec.calls.length, 0, 'master short-circuits before any git call, env or not');
});

test('computeDriftIsInherited: env.COORD_DRIFT_BRANCH === "" (shell rev-parse already failed) → strict, no git calls', () => {
  const _exec = fakeExec({});
  const env = { COORD_DRIFT_BRANCH: '' };
  assert.equal(
    computeDriftIsInherited({ repoRoot: '/repo', pathspecs: PATHSPECS, _exec, env }),
    false,
  );
  assert.equal(_exec.calls.length, 0);
});

test('computeDriftIsInherited: env.COORD_DRIFT_BASE === "" (shell merge-base already unresolvable) → strict, no git calls', () => {
  const _exec = fakeExec({});
  const env = { COORD_DRIFT_BRANCH: 'worktree-1669-x', COORD_DRIFT_BASE: '' };
  assert.equal(
    computeDriftIsInherited({ repoRoot: '/repo', pathspecs: PATHSPECS, _exec, env }),
    false,
  );
  assert.equal(_exec.calls.length, 0, 'no diff/status attempted once base is a known failure');
});

test('computeDriftIsInherited: env absent (default {}) → unchanged behavior, own rev-parse/merge-base', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-1664-x\n',
    'merge-base': 'abc123\n',
    diff: '',
    status: '',
  });
  assert.equal(computeDriftIsInherited({ repoRoot: '/repo', pathspecs: PATHSPECS, _exec }), true);
  assert.equal(
    _exec.calls.length,
    4,
    'no env → falls back to its own rev-parse + merge-base + diff + status',
  );
});

// --- checkWorktreeCoordDocStale (plan 2099 — stale-worktree-copy self-diagnosis) ---

const RELPATH = 'docs/handoff/board.md';

test('checkWorktreeCoordDocStale: worktree copy differs from origin/master → stale, with best-effort commitsBehind', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-2099-x\n',
    show: 'fresh master content\n',
    'rev-list': '3\n',
  });
  const result = checkWorktreeCoordDocStale({
    repoRoot: '/repo',
    relPath: RELPATH,
    localContent: 'stale local content\n',
    _exec,
  });
  assert.deepEqual(result, { stale: true, commitsBehind: 3 });
  assert.ok(
    _exec.calls.some((c) => c.includes(`show origin/master:${RELPATH}`)),
    'must read the coord doc straight out of origin/master, not a local ref',
  );
});

test('checkWorktreeCoordDocStale: worktree copy byte-identical to origin/master → not stale', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-2099-x\n',
    show: 'same content\n',
    'rev-list': '0\n',
  });
  const result = checkWorktreeCoordDocStale({
    repoRoot: '/repo',
    relPath: RELPATH,
    localContent: 'same content\n',
    _exec,
  });
  assert.deepEqual(result, { stale: false, commitsBehind: null });
});

test('checkWorktreeCoordDocStale: master branch is never diagnosed as stale (no git calls beyond rev-parse)', () => {
  const _exec = fakeExec({ 'rev-parse': 'master\n' });
  const result = checkWorktreeCoordDocStale({
    repoRoot: '/repo',
    relPath: RELPATH,
    localContent: 'anything\n',
    _exec,
  });
  assert.deepEqual(result, { stale: false, commitsBehind: null });
  assert.equal(_exec.calls.length, 1);
});

test('checkWorktreeCoordDocStale: detached HEAD is never diagnosed as stale', () => {
  const _exec = fakeExec({ 'rev-parse': 'HEAD\n' });
  const result = checkWorktreeCoordDocStale({
    repoRoot: '/repo',
    relPath: RELPATH,
    localContent: 'anything\n',
    _exec,
  });
  assert.deepEqual(result, { stale: false, commitsBehind: null });
});

test('checkWorktreeCoordDocStale: unresolvable origin/master (git show fails) → not stale, fail-safe', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-2099-x\n',
    show: () => {
      throw new Error('fatal: invalid object name origin/master');
    },
  });
  const result = checkWorktreeCoordDocStale({
    repoRoot: '/repo',
    relPath: RELPATH,
    localContent: 'anything\n',
    _exec,
  });
  assert.deepEqual(result, { stale: false, commitsBehind: null });
});

test('checkWorktreeCoordDocStale: rev-parse failure → not stale, fail-safe', () => {
  const _exec = fakeExec({
    'rev-parse': () => {
      throw new Error('not a git repo');
    },
  });
  const result = checkWorktreeCoordDocStale({
    repoRoot: '/repo',
    relPath: RELPATH,
    localContent: 'anything\n',
    _exec,
  });
  assert.deepEqual(result, { stale: false, commitsBehind: null });
});

test('checkWorktreeCoordDocStale: rev-list (commitsBehind) failure degrades to null without affecting the stale verdict', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-2099-x\n',
    show: 'fresh master content\n',
    'rev-list': () => {
      throw new Error('fatal: some rev-list error');
    },
  });
  const result = checkWorktreeCoordDocStale({
    repoRoot: '/repo',
    relPath: RELPATH,
    localContent: 'stale local content\n',
    _exec,
  });
  assert.deepEqual(result, { stale: true, commitsBehind: null });
});

test('checkWorktreeCoordDocStale: env.COORD_DRIFT_BRANCH present → skips its own rev-parse', () => {
  const _exec = fakeExec({
    show: 'fresh\n',
    'rev-list': '1\n',
    // no rev-parse handler — calling it would throw here
  });
  const result = checkWorktreeCoordDocStale({
    repoRoot: '/repo',
    relPath: RELPATH,
    localContent: 'stale\n',
    _exec,
    env: { COORD_DRIFT_BRANCH: 'worktree-2099-x' },
  });
  assert.deepEqual(result, { stale: true, commitsBehind: 1 });
});

test('checkWorktreeCoordDocStale: env.COORD_DRIFT_BRANCH === "master" → not stale, no git calls at all', () => {
  const _exec = fakeExec({});
  const result = checkWorktreeCoordDocStale({
    repoRoot: '/repo',
    relPath: RELPATH,
    localContent: 'anything\n',
    _exec,
    env: { COORD_DRIFT_BRANCH: 'master' },
  });
  assert.deepEqual(result, { stale: false, commitsBehind: null });
  assert.equal(_exec.calls.length, 0);
});

test('formatStaleWorktreeCoordDocMessage: names the file, the rebase fix, and the commit count when known', () => {
  const msg = formatStaleWorktreeCoordDocMessage('docs/handoff/board.md', { commitsBehind: 3 });
  assert.match(msg, /docs\/handoff\/board\.md/);
  assert.match(msg, /STALE/);
  assert.match(msg, /3 commits behind/);
  assert.match(msg, /git rebase origin\/master/);
});

test('formatStaleWorktreeCoordDocMessage: omits the commit count when unknown (null)', () => {
  const msg = formatStaleWorktreeCoordDocMessage('docs/INDEX.md', { commitsBehind: null });
  assert.match(msg, /docs\/INDEX\.md/);
  assert.match(msg, /git rebase origin\/master/);
  assert.doesNotMatch(msg, /commits? behind/);
});
