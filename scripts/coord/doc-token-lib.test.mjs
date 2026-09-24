// scripts/coord/doc-token-lib.test.mjs (plan 3958, S2 follow-up)
//
// Name-pair for scripts/coord/doc-token-lib.mjs — the five generic path-token helpers
// extracted out of scripts/lint-pipeline-doc.mjs so scripts/assert-doc-pointers.mjs's own
// import closure does not pull in scripts/pipeline-doc.mjs (vetapp-only). These cases were
// MOVED here from scripts/lint-pipeline-doc.test.mjs (not duplicated) — see that file's own
// header for what stayed behind (the lint-pipeline-doc.mjs-level integration tests, e.g.
// extractPathRefs's use of trimToken/splitSpanWords, and lintDocFromDisk's use of
// gitIgnoredSet, which exercise THIS module transitively and need no copy here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expandBraces,
  gitIgnoredSet,
  globMatches,
  splitSpanWords,
  trimToken,
} from './doc-token-lib.mjs';

function withFixture(body) {
  const root = mkdtempSync(join(tmpdir(), 'doc-token-lib-'));
  try {
    mkdirSync(join(root, 'docs'), { recursive: true });
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── trimToken ─────────────────────────────────────────────────────────────────────

test('trimToken strips leading quoting/bracket punctuation and trailing prose punctuation', () => {
  assert.equal(trimToken("'docs/a.md';"), 'docs/a.md');
  assert.equal(trimToken('(backend/scripts/x.py),'), 'backend/scripts/x.py');
  assert.equal(trimToken('[docs/b.md]'), 'docs/b.md');
  assert.equal(trimToken('docs/plain.md'), 'docs/plain.md', 'an unquoted token is untouched');
});

// ── splitSpanWords ────────────────────────────────────────────────────────────────

test('splitSpanWords splits on whitespace and top-level commas, but not commas inside braces', () => {
  assert.deepEqual(splitSpanWords('docs/a.md,docs/b.md'), ['docs/a.md', 'docs/b.md']);
  assert.deepEqual(splitSpanWords('docs/a.md docs/b.md'), ['docs/a.md', 'docs/b.md']);
  // A comma INSIDE a brace group is brace syntax and must survive the split.
  assert.deepEqual(splitSpanWords('backend/data/expansion/{no,dk}-corpus/'), [
    'backend/data/expansion/{no,dk}-corpus/',
  ]);
});

// ── expandBraces ──────────────────────────────────────────────────────────────────

test('expandBraces enumerates every alternative, including nested groups', () => {
  assert.deepEqual(expandBraces('a/{no,dk}-corpus/'), ['a/no-corpus/', 'a/dk-corpus/']);
  assert.deepEqual(expandBraces('a/{x,y}/{1,2}.json'), [
    'a/x/1.json',
    'a/x/2.json',
    'a/y/1.json',
    'a/y/2.json',
  ]);
  assert.deepEqual(expandBraces('a/plain.json'), ['a/plain.json']);
});

// ── globMatches ───────────────────────────────────────────────────────────────────

test('globMatches resolves a wildcard segment against the real tree', () => {
  assert.equal(globMatches('scripts/coord/doc-token-*.mjs'), true);
  assert.equal(globMatches('scripts/coord/no-such-prefix-*.mjs'), false);
});

test('globMatches honours a trailing slash as "must be a directory"', () => {
  assert.equal(globMatches('scripts/coord/'), true);
  assert.equal(globMatches('scripts/coord/doc-token-lib.mjs/'), false, 'a file is not a directory');
  assert.equal(globMatches('scripts/coord/doc-token-lib.mjs'), true);
});

test('globMatches escapes regex metachars in a wildcard segment (the `?` hole)', () => {
  withFixture((root) => {
    // `?` must be a LITERAL. coord-share-lib's globToRegExp omits it from its escape class,
    // which would let `report*?.md` match `reportx.md` — silently widening a drift check.
    writeFileSync(join(root, 'docs', 'reportx.md'), '');
    assert.equal(globMatches('docs/report*?.md', root), false, '`?` must not act as a quantifier');
  });
});

// The positive half needs a file literally NAMED `reportZ?.md`, and `?` is a reserved
// character in Win32 filenames — writeFileSync ENOENTs there, so this half is POSIX-only
// (the negative case above is the actual regression guard and runs everywhere).
test(
  'globMatches matches a literal `?` in a wildcard segment',
  { skip: process.platform === 'win32' },
  () => {
    withFixture((root) => {
      writeFileSync(join(root, 'docs', 'reportx.md'), '');
      writeFileSync(join(root, 'docs', 'reportZ?.md'), '');
      assert.equal(globMatches('docs/report*?.md', root), true, 'must match a literal `?`');
    });
  },
);

test('globMatches treats a dot as literal, not "any char"', () => {
  withFixture((root) => {
    writeFileSync(join(root, 'docs', 'axmd'), '');
    assert.equal(globMatches('docs/a.md', root), false);
  });
});

// ── gitIgnoredSet ─────────────────────────────────────────────────────────────────

test('gitIgnoredSet reports the ignored subset of the paths it is handed', () => {
  withFixture((root) => {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), 'docs/ignored.md\n');
    const { ignored, gitAvailable } = gitIgnoredSet(['docs/ignored.md', 'docs/tracked.md'], root);
    assert.equal(gitAvailable, true);
    assert.deepEqual([...ignored], ['docs/ignored.md']);
  });
});

test('gitIgnoredSet fails OPEN (empty set, gitAvailable: false) when git cannot answer', () => {
  withFixture((root) => {
    // A fixture tree that is not a git repo at all — `git check-ignore` cannot answer.
    const { ignored, gitAvailable } = gitIgnoredSet(['docs/whatever.md'], root);
    assert.equal(gitAvailable, false, 'the caveat must be reported up, not swallowed');
    assert.deepEqual([...ignored], [], 'an unclassifiable gitignore must not manufacture a hit');
  });
});

test('gitIgnoredSet short-circuits on an empty path list without invoking git', () => {
  const { ignored, gitAvailable } = gitIgnoredSet([], '/nonexistent-root-never-read');
  assert.equal(gitAvailable, true);
  assert.deepEqual([...ignored], []);
});
