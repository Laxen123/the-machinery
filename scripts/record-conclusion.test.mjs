// scripts/record-conclusion.test.mjs (plan 2033)
// record-conclusion.mjs writes the CONCLUSION_REVIEW verdict marker into the
// worktree's handoff session entry. Mirrors record-wiki.test.mjs for the surface
// that is NOT shared machinery: commitConclusionMarker's lock-retry commit + no-op
// short-circuit, and the CLI's verdict/detail validation. The branch-refuse guard
// (checkRecordBranch), repin gate (repinDecision), and marker parse/upsert are
// shared helpers already covered by record-wiki.test.mjs + done-worktree-lib.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitConclusionMarker } from './record-conclusion.mjs';

for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'record-conclusion.mjs');
const SF = 'handoff/sessions/2026-07-18-session-2033.md';

function makeRepoWithSession(content) {
  const dir = mkdtempSync(join(tmpdir(), 'record-conclusion-test-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  mkdirSync(dirname(join(dir, SF)), { recursive: true });
  writeFileSync(join(dir, SF), content);
  g('add', '-A');
  g('commit', '-qm', 'init session');
  return { dir, g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('commitConclusionMarker: routes add+commit through lock-retry and pushes on a real change', () => {
  const r = makeRepoWithSession('session entry\n');
  try {
    writeFileSync(
      join(r.dir, SF),
      'session entry\nConclusion: UPHELD:no contradicting source found @ deadbeef0\n',
    );
    const calls = [];
    const _gitRetry = (dir, args) => {
      calls.push(args[0]);
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    };
    let pushed = false;
    const res = commitConclusionMarker(r.dir, SF, {
      slug: '2033-plan',
      verdict: 'UPHELD',
      detail: 'no contradicting source found',
      sha: 'deadbeef00000000',
      _gitRetry,
      _push: () => {
        pushed = true;
      },
    });
    assert.deepEqual(calls, ['add', 'commit']);
    assert.equal(pushed, true);
    assert.equal(res.noop, false);
    assert.match(
      r.g('log', '-1', '--format=%s'),
      /chore\(conclusion\): record UPHELD @ deadbeef0 for 2033-plan \(no contradicting source found\)/,
    );
    assert.equal(r.g('status', '--porcelain').trim(), '');
  } finally {
    r.cleanup();
  }
});

test('commitConclusionMarker: idempotent re-run short-circuits to a no-op (unchanged entry)', () => {
  const r = makeRepoWithSession(
    'session entry\nConclusion: UNDERDETERMINED:premises tenant unchecked @ abcdef012\n',
  );
  try {
    const before = r.g('rev-parse', 'HEAD').trim();
    const res = commitConclusionMarker(r.dir, SF, {
      slug: '2033-plan',
      verdict: 'UNDERDETERMINED',
      detail: 'premises tenant unchecked',
      sha: 'abcdef0123456789',
      noPush: true,
    });
    assert.equal(res.noop, true);
    assert.equal(r.g('rev-parse', 'HEAD').trim(), before);
  } finally {
    r.cleanup();
  }
});

test('CLI: a bad verdict exits 2 before any git', () => {
  const r = spawnSync(process.execPath, [CLI, 'MAYBE'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /UPHELD \| REFUTED \| UNDERDETERMINED/);
});

test('CLI: a verdict without a detail line exits 2 (every verdict carries the audit artifact)', () => {
  for (const verdict of ['UPHELD', 'REFUTED', 'UNDERDETERMINED']) {
    const r = spawnSync(process.execPath, [CLI, verdict], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${verdict} without detail must refuse`);
    assert.match(r.stderr, /detail line is required/);
  }
});
