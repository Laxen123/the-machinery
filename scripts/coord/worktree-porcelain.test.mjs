// scripts/worktree-porcelain.test.mjs (plan 2058)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorktreePorcelain } from './worktree-porcelain.mjs';

test('parses a plain main-checkout block with a branch', () => {
  const out = ['worktree /repo', 'HEAD abc123', 'branch refs/heads/master', ''].join('\n');
  const entries = parseWorktreePorcelain(out);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    path: '/repo',
    branch: 'master',
    head: 'abc123', // plan 2654
    detached: false,
    locked: false,
    lockReason: null,
    prunable: false,
    prunableReason: null,
  });
});

// plan 2654: `head` feeds the detached-worktree diagnostic, which names the sha the tree is
// stranded at. A bare "it is detached" cannot tell the reader whether the detached tip carries
// commits the branch ref lacks, which is the difference between a free re-attach and a refusal.
test('plan 2654: captures the HEAD sha for a detached entry as well as an attached one', () => {
  const out = [
    'worktree /repo',
    'HEAD aaa111',
    'branch refs/heads/master',
    '',
    'worktree /repo/wt',
    'HEAD bbb222',
    'detached',
    '',
  ].join('\n');
  const entries = parseWorktreePorcelain(out);
  assert.deepEqual(
    entries.map((e) => [e.head, e.detached]),
    [
      ['aaa111', false],
      ['bbb222', true],
    ],
  );
});

test('plan 2654: head is null when a block carries no HEAD line', () => {
  const [entry] = parseWorktreePorcelain(
    ['worktree /repo', 'branch refs/heads/master', ''].join('\n'),
  );
  assert.equal(entry.head, null);
});

test('detects a detached (branchless) entry', () => {
  const out = ['worktree /repo/wt', 'HEAD abc123', 'detached', ''].join('\n');
  const [entry] = parseWorktreePorcelain(out);
  assert.equal(entry.branch, null);
  assert.equal(entry.detached, true);
});

test('parses a locked entry with a reason', () => {
  const out = [
    'worktree /repo/wt',
    'HEAD abc123',
    'branch refs/heads/feature',
    'locked mid-operation, do not remove',
    '',
  ].join('\n');
  const [entry] = parseWorktreePorcelain(out);
  assert.equal(entry.locked, true);
  assert.equal(entry.lockReason, 'mid-operation, do not remove');
});

test('parses a locked entry with no reason', () => {
  const out = ['worktree /repo/wt', 'HEAD abc123', 'locked', ''].join('\n');
  const [entry] = parseWorktreePorcelain(out);
  assert.equal(entry.locked, true);
  assert.equal(entry.lockReason, null);
});

test('parses a prunable entry with a reason', () => {
  const out = [
    'worktree /repo/wt-gone',
    'HEAD abc123',
    'branch refs/heads/stale',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');
  const [entry] = parseWorktreePorcelain(out);
  assert.equal(entry.prunable, true);
  assert.equal(entry.prunableReason, 'gitdir file points to non-existent location');
});

test('parses a prunable entry with no reason', () => {
  const out = ['worktree /repo/wt-gone', 'HEAD abc123', 'prunable', ''].join('\n');
  const [entry] = parseWorktreePorcelain(out);
  assert.equal(entry.prunable, true);
  assert.equal(entry.prunableReason, null);
});

test('parses multiple blocks in list order', () => {
  const out = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/master',
    '',
    'worktree /repo/wt1',
    'HEAD def456',
    'branch refs/heads/feature-a',
    '',
    'worktree /repo/wt2',
    'HEAD ghi789',
    'prunable gone',
    '',
  ].join('\n');
  const entries = parseWorktreePorcelain(out);
  assert.deepEqual(
    entries.map((e) => e.path),
    ['/repo', '/repo/wt1', '/repo/wt2'],
  );
  assert.equal(entries[2].prunable, true);
});

test('ignores blocks without a worktree line', () => {
  const out = ['worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '', 'garbage', ''].join(
    '\n',
  );
  const entries = parseWorktreePorcelain(out);
  assert.equal(entries.length, 1);
});

test('empty/undefined input yields no entries', () => {
  assert.deepEqual(parseWorktreePorcelain(''), []);
  assert.deepEqual(parseWorktreePorcelain(undefined), []);
});

test('review [0]: a whitespace-only blank-line separator (e.g. a stray \\r) still splits blocks', () => {
  const out =
    'worktree /repo\nHEAD abc123\nbranch refs/heads/master\n\r\n\nworktree /repo/wt\nHEAD def456\nbranch refs/heads/feature';
  const entries = parseWorktreePorcelain(out);
  assert.deepEqual(
    entries.map((e) => e.path),
    ['/repo', '/repo/wt'],
  );
});
