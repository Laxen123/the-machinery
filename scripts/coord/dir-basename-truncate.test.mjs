// scripts/dir-basename-truncate.test.mjs — plan 1597: the shared MAX_PATH-headroom truncation
// primitive extracted from cut-worktree.mjs's worktreePathFor() and land-lib.mjs's
// landDirBaseFor(). Their own test suites (cut-worktree.test.mjs, land-lib.test.mjs) already
// cover both call sites end-to-end; this file covers the helper's own contract in isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateDirBasename, MAX_PATH_HEADROOM_DIR_SLUG } from './dir-basename-truncate.mjs';

// plan 1616: land-lib.mjs's MAX_LAND_DIR_SLUG and cut-worktree.mjs's MAX_DIR_SLUG both used to
// independently declare `40` locally; both now import this single exported constant instead.
test('MAX_PATH_HEADROOM_DIR_SLUG: the single source of truth for the MAX_PATH-headroom budget is 40', () => {
  assert.equal(MAX_PATH_HEADROOM_DIR_SLUG, 40);
});

test('truncateDirBasename: a name at or under maxLen is unchanged', () => {
  assert.equal(truncateDirBasename('abc', { maxLen: 40 }), 'abc');
});

test('truncateDirBasename: a name over maxLen is clipped to maxLen chars', () => {
  const long = 'a'.repeat(50);
  const out = truncateDirBasename(long, { maxLen: 40 });
  assert.equal(out.length, 40);
  assert.equal(out, 'a'.repeat(40));
});

test('truncateDirBasename: a clip landing mid-hyphen trims the trailing dash', () => {
  const name = '1286-Infra-main-checkout-mutex-heal-and-coord-write-isolation';
  const out = truncateDirBasename(name, { maxLen: 40 });
  assert.ok(!out.endsWith('-'), `no trailing hyphen: ${out}`);
  assert.equal(out, name.slice(0, 40).replace(/-+$/, ''));
});

test('truncateDirBasename: an optional suffix is appended AFTER re-clipping to leave room for it', () => {
  const name = '_land-worktree-1559-FABLE-Infra-orchestrated-execution-skill-missing';
  const suffix = '-deadbeef';
  const out = truncateDirBasename(name, { maxLen: 40, suffix });
  assert.ok(out.length <= 40, `must stay within maxLen: ${out.length}`);
  assert.ok(out.endsWith(suffix), `suffix is appended: ${out}`);
  assert.equal(out, name.slice(0, 40 - suffix.length).replace(/-+$/, '') + suffix);
});

test('truncateDirBasename: throws without a maxLen', () => {
  assert.throws(() => truncateDirBasename('abc'), /maxLen/);
  assert.throws(() => truncateDirBasename('abc', { maxLen: 0 }), /maxLen/);
  assert.throws(() => truncateDirBasename('abc', { maxLen: -1 }), /maxLen/);
});

// /sonnet-review xhigh (2026-07-08, batch-2026-07-08-coord-spine2) CONFIRMED: without this
// guard, a suffix at least as long as maxLen drives clipLen negative, and String.slice(0,
// negative) counts from the END of `name` (JS slice semantics) — producing a nonsensical
// fragment AND a result that can end up LONGER than maxLen, silently defeating the exact
// MAX_PATH-headroom guarantee this helper exists to centralize. Unreached by today's two
// callers (cut-worktree.mjs, land-lib.mjs both pass a short fixed suffix), but latent.
test('truncateDirBasename: throws when suffix is as long as or longer than maxLen (would drive clipLen negative)', () => {
  assert.throws(
    () => truncateDirBasename('abc', { maxLen: 5, suffix: '123456' }),
    /suffix.*must not exceed maxLen/,
  );
  assert.throws(
    () => truncateDirBasename('abc', { maxLen: 5, suffix: '12345' }),
    /suffix.*must not exceed maxLen/,
    'suffix exactly equal to maxLen leaves no room for any of `name` — also rejected',
  );
});
