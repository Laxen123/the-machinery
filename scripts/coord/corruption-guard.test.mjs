// scripts/corruption-guard.test.mjs (plan 1634)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllNul,
  looksBinary,
  detectCorruption,
  corruptionWarning,
  scanForCorruption,
  nulBytes,
  nulBytes as nul,
} from './corruption-guard.mjs';

test('isAllNul: true only for non-empty all-NUL content', () => {
  assert.equal(isAllNul(nul(5)), true);
  assert.equal(isAllNul(''), false, 'empty string is not corruption');
  assert.equal(isAllNul('hello'), false);
  assert.equal(isAllNul('a' + nul(3)), false, 'mixed content is not all-NUL');
});

test('looksBinary: true iff a NUL byte is present anywhere', () => {
  assert.equal(looksBinary('plain text'), false);
  assert.equal(looksBinary('a' + nul(1) + 'b'), true);
  assert.equal(looksBinary(nul(1)), true);
});

test('detectCorruption: all-nul takes priority when the post-image is zero-filled', () => {
  assert.equal(detectCorruption(nul(10), 'the original text\n'), 'all-nul');
});

test('detectCorruption: a legitimate text edit is not corruption', () => {
  assert.equal(detectCorruption('line1\nline2 EDITED\n', 'line1\nline2\n'), null);
});

test('detectCorruption: no baseline (new file) still catches all-NUL', () => {
  assert.equal(detectCorruption(nul(4), null), 'all-nul');
  assert.equal(detectCorruption(nul(4), undefined), 'all-nul');
});

test('detectCorruption: a genuinely new non-NUL file with no baseline is clean', () => {
  assert.equal(detectCorruption('brand new content\n', null), null);
});

test('detectCorruption: text-to-binary flip vs a text baseline is flagged', () => {
  assert.equal(detectCorruption('abc' + nul(2) + 'def', 'abc\ndef\n'), 'binary-flip');
});

test('detectCorruption: an already-binary baseline does not trip binary-flip', () => {
  // e.g. a tracked binary asset legitimately edited — baseline itself contains NUL, so a
  // NUL-containing post-image is not a NEW signature. (all-nul still catches full zero-fill.)
  assert.equal(detectCorruption('new' + nul(1) + 'binary', 'old' + nul(1) + 'binary'), null);
});

test('detectCorruption: an all-NUL baseline (pre-image) is flagged even if the post-image looks fine', () => {
  assert.equal(detectCorruption('some text\n', nul(20)), 'baseline-all-nul');
});

test('corruptionWarning names the path and reason, RED/bold ANSI degrades to readable text', () => {
  const w = corruptionWarning('docs/INDEX.md', 'all-nul');
  assert.match(w, /docs\/INDEX\.md/);
  assert.match(w, /all-NUL/);
  assert.match(w, /corruption-guard/);
});

test('corruptionWarning: unreadable / baseline-unreadable reasons produce a distinct message', () => {
  assert.match(corruptionWarning('f.md', 'unreadable'), /could not be read/);
  assert.match(corruptionWarning('f.md', 'baseline-unreadable'), /baseline could not be read/);
});

test('nulBytes generates a string of exactly n NUL (code point 0) characters', () => {
  assert.equal(nulBytes(0), '');
  assert.equal(nulBytes(3).length, 3);
  assert.ok(isAllNul(nulBytes(3)));
});

// ── scanForCorruption: the shared scan loop + its ENOENT-only / not-in-HEAD-only carve-outs ──

const enoentError = () => Object.assign(new Error('no such file'), { code: 'ENOENT' });
const ebusyError = () => Object.assign(new Error('resource busy'), { code: 'EBUSY' });
const notInHeadError = () => new Error("fatal: path 'f.md' exists on disk, but not in 'HEAD'");
const otherGitError = () => new Error('fatal: unable to read tree object (ref contention)');

test('scanForCorruption: a clean file with a clean baseline is clean', () => {
  const { clean, corrupted } = scanForCorruption(
    ['f.md'],
    () => 'line1\nline2\n',
    () => 'line1\n',
  );
  assert.deepEqual(clean, ['f.md']);
  assert.deepEqual(corrupted, []);
});

test('scanForCorruption: a genuinely deleted file (ENOENT) is clean, not corrupted', () => {
  const { clean, corrupted } = scanForCorruption(
    ['gone.md'],
    () => {
      throw enoentError();
    },
    () => 'irrelevant',
  );
  assert.deepEqual(clean, ['gone.md']);
  assert.deepEqual(corrupted, []);
});

test('scanForCorruption: a collapsed-untracked-directory entry (EISDIR) is clean, not corrupted', () => {
  // git status --porcelain collapses an entirely-untracked directory into one `?? dir/`
  // entry; reading that path throws EISDIR, not ENOENT. That's a normal porcelain shape
  // (expanding it into individual files is the caller's job), never a corruption signal.
  const { clean, corrupted } = scanForCorruption(
    ['.claude/'],
    () => {
      throw Object.assign(new Error('illegal operation on a directory'), { code: 'EISDIR' });
    },
    () => 'irrelevant',
  );
  assert.deepEqual(clean, ['.claude/']);
  assert.deepEqual(corrupted, []);
});

test('scanForCorruption: a non-ENOENT read failure (EBUSY) is reported as corrupted, not clean', () => {
  // plan 1634 review fix: the first cut swallowed ANY readFileSync error as "clean" — a
  // transient EBUSY/EPERM (AV scan, sync tool) on a genuinely corrupted file would then
  // bypass the guard entirely. Only ENOENT (a real deletion) is clean.
  const { clean, corrupted } = scanForCorruption(
    ['locked.md'],
    () => {
      throw ebusyError();
    },
    () => 'irrelevant',
  );
  assert.deepEqual(clean, []);
  assert.deepEqual(corrupted, [{ path: 'locked.md', reason: 'unreadable' }]);
});

test('scanForCorruption: a genuinely-new-file git error (not in HEAD) leaves baseline null', () => {
  const { clean, corrupted } = scanForCorruption(
    ['new.md'],
    () => 'brand new content\n',
    () => {
      throw notInHeadError();
    },
  );
  assert.deepEqual(clean, ['new.md']);
  assert.deepEqual(corrupted, []);
});

test('scanForCorruption: a non-"not-in-HEAD" git failure is reported as baseline-unreadable', () => {
  // plan 1634 review fix: the first cut swallowed ANY git-show error as "no baseline" —
  // a transient ref-contention/git-for-windows-fork() failure on a TRACKED file would then
  // silently disable the baseline-all-nul / binary-flip checks for that file.
  const { clean, corrupted } = scanForCorruption(
    ['tracked.md'],
    () => 'looks fine\n',
    () => {
      throw otherGitError();
    },
  );
  assert.deepEqual(clean, []);
  assert.deepEqual(corrupted, [{ path: 'tracked.md', reason: 'baseline-unreadable' }]);
});

test('scanForCorruption: mixed batch partitions correctly', () => {
  const files = { 'clean.md': 'ok\n', 'zeroed.md': nulBytes(4) };
  const { clean, corrupted } = scanForCorruption(
    Object.keys(files),
    (p) => files[p],
    () => 'ok\n',
  );
  assert.deepEqual(clean, ['clean.md']);
  assert.deepEqual(corrupted, [{ path: 'zeroed.md', reason: 'all-nul' }]);
});
