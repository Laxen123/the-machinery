// scripts/stamp-evidence.test.mjs — plan 2943. Modeled on stamp-cloud-exec.test.mjs (the
// pure-helper + subprocess/isolated-repo pattern) but scoped to this tool's much leaner
// surface: one frontmatter key, no body banner, no rename, no second axis.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedRepoFactory, runTool as runStamp } from './test-helpers/isolated-plan-repo.mjs';
import { setFrontmatterKey, VALID_EVIDENCE } from './stamp-evidence.mjs';

// ─────────────────────────── pure-function tests ───────────────────────────

test('VALID_EVIDENCE carries exactly the five evidence-floor classes, in vocabulary order', () => {
  assert.deepEqual(VALID_EVIDENCE, [
    'observed-wave',
    'observed-live',
    'observed-measured',
    'operator',
    'latent',
  ]);
});

test('setFrontmatterKey: inserts evidence into an existing block, preserving siblings', () => {
  const out = setFrontmatterKey('---\nsummary: x\n---\n\n# T\n', 'evidence', 'latent');
  assert.match(out, /^summary: x$/m);
  assert.match(out, /^evidence: latent$/m);
  assert.equal((out.match(/^---$/gm) || []).length, 2);
});

test('setFrontmatterKey: replaces an existing evidence value in place (no dup key)', () => {
  const out = setFrontmatterKey(
    '---\nsummary: x\nevidence: latent\n---\n\n# T\n',
    'evidence',
    'observed-wave',
  );
  assert.equal((out.match(/^evidence:/gm) || []).length, 1);
  assert.match(out, /^evidence: observed-wave$/m);
});

test('setFrontmatterKey: fabricates a frontmatter block for a body with none', () => {
  const out = setFrontmatterKey('# T\n\nbody\n', 'evidence', 'operator');
  assert.match(out, /^evidence: operator$/m);
});

// ─────────────────────────── subprocess / repo tests ───────────────────────────

const DEFAULT_BODY = [
  '---',
  'summary: Test plan for stamp-evidence',
  'seedWrite: false',
  '---',
  '',
  '> 🟩 **SEED-WRITE: no**',
  '> 💰 **Cost forecast:** $0',
  '',
  '**Status:** 📋 READY — opened 2026-08-06.',
  '',
  '# 1000-Other-foo',
  '',
  'Body.',
  '',
].join('\n');

const makeIsolatedRepo = isolatedRepoFactory({
  prefix: 'stampevidence',
  basename: '1000-Other-foo.md',
  body: DEFAULT_BODY,
  tools: { stampEvidence: 'stamp-evidence.mjs' },
});

for (const value of VALID_EVIDENCE) {
  test(`stamp-evidence: stamping "${value}" writes evidence: ${value} (no body banner)`, () => {
    const repo = makeIsolatedRepo();
    try {
      const res = runStamp(repo.dir, ['1000', value], repo.stampEvidence);
      assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
      repo.g('fetch', '-q', 'origin', 'master');
      const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
      assert.match(body, new RegExp(`^evidence: ${value}$`, 'm'));
      assert.match(body, /^summary: Test plan for stamp-evidence$/m); // siblings preserved
      assert.doesNotMatch(body, /> .*\*\*evidence:/); // no body banner — this axis has none
    } finally {
      repo.cleanup();
    }
  });
}

test('stamp-evidence: re-stamping replaces the prior value, never leaving a duplicate key', () => {
  const repo = makeIsolatedRepo();
  try {
    let res = runStamp(repo.dir, ['1000', 'latent'], repo.stampEvidence);
    assert.equal(res.code, 0, `first stamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    res = runStamp(repo.dir, ['1000', 'observed-live'], repo.stampEvidence);
    assert.equal(res.code, 0, `second stamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.equal((body.match(/^evidence:/gm) || []).length, 1);
    assert.match(body, /^evidence: observed-live$/m);
  } finally {
    repo.cleanup();
  }
});

test('stamp-evidence: invalid evidence value is rejected (exit 2), mutates nothing', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'vibes'], repo.stampEvidence);
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /invalid evidence value/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.doesNotMatch(body, /evidence:/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-evidence: missing value argument prints usage (exit 2)', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000'], repo.stampEvidence);
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /usage: stamp-evidence\.mjs/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-evidence: refuses in-progress/ and leaves a clean, unstamped tree', () => {
  const repo = makeIsolatedRepo({ startFolder: 'in-progress' });
  try {
    const res = runStamp(repo.dir, ['1000', 'latent'], repo.stampEvidence);
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /refusing to stamp .* in-progress\//);
    assert.equal(
      repo.g('status', '--porcelain', '--untracked-files=no').trim(),
      '',
      'MAIN tracked tree should be untouched',
    );
  } finally {
    repo.cleanup();
  }
});

test('stamp-evidence: --dry previews without mutating anything', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'latent', '--dry'], repo.stampEvidence);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stdout, /\[dry\] set evidence: latent/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.doesNotMatch(body, /evidence:/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-evidence: --help prints usage and exits 0 without touching the repo', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['--help'], repo.stampEvidence);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stdout, /usage: stamp-evidence\.mjs/);
    assert.match(res.stdout, /observed-wave/);
    assert.match(res.stdout, /latent/);
  } finally {
    repo.cleanup();
  }
});
