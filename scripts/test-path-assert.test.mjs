// scripts/test-path-assert.test.mjs — unit tests for the shared path-comparison assertion (plan 2490).
//
// Every case here is platform-INDEPENDENT by construction: the fixtures are literal strings, never
// values derived from the host's `path` module, so the suite asserts the same thing on the Linux
// cloud drain and on a Windows checkout. That is the property the helper exists to give its
// callers, so its own tests must not quietly depend on the host either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSamePath, assertDifferentPath, toComparablePath } from './test-path-assert.mjs';

test('toComparablePath: normalizes separators', () => {
  assert.equal(toComparablePath('C:\\Users\\user\\repo\\.git'), 'C:/Users/user/repo/.git');
  assert.equal(toComparablePath('C:/Users/user/repo/.git'), 'C:/Users/user/repo/.git');
});

test('toComparablePath: upper-cases a leading drive letter', () => {
  assert.equal(toComparablePath('c:\\x\\y'), 'C:/x/y');
  // Only a LEADING drive letter — a `c:` deeper in the string is not a drive.
  // path-assert-ok: toComparablePath is a pure string transform; no node:path call and no host
  // filesystem is involved, so input and expectation are the same literals on every platform.
  assert.equal(toComparablePath('/tmp/c:/y'), '/tmp/c:/y');
});

test('toComparablePath: strips one trailing separator but never reduces a root', () => {
  // path-assert-ok: pure string transform, see above.
  assert.equal(toComparablePath('/tmp/x/'), '/tmp/x');
  assert.equal(toComparablePath('C:\\x\\'), 'C:/x');
  assert.equal(toComparablePath('/'), '/');
  assert.equal(toComparablePath('C:\\'), 'C:/');
});

test('toComparablePath: does NOT resolve dot segments or make a path absolute', () => {
  // Deliberate non-goal: normalizing these would let a genuine resolution bug pass.
  assert.notEqual(toComparablePath('a/../b'), toComparablePath('b'));
  assert.notEqual(toComparablePath('b'), toComparablePath('/b'));
});

test('assertSamePath: the git separator-divergence pair (the plan-2478 failure) passes', () => {
  // git spells a main clone's common dir with `/` and a linked worktree's with `\` on Windows.
  assertSamePath('C:/Users/user/repo/.git', 'C:\\Users\\user\\repo\\.git');
});

// `assert.throws` returns undefined, so the message is captured by hand.
function messageOfThrow(fn) {
  try {
    fn();
  } catch (e) {
    return e.message;
  }
  assert.fail('expected the assertion to throw');
}

test('assertSamePath: a genuinely different path still fails, with both forms in the message', () => {
  const message = messageOfThrow(() => assertSamePath('C:\\a\\.git', 'C:\\b\\.git'));
  // Both the RAW input and its normalized form are shown, so a real mismatch stays readable.
  assert.match(message, /C:\\\\a\\\\\.git/);
  assert.match(message, /C:\/a\/\.git/);
  assert.match(message, /C:\/b\/\.git/);
});

test('assertSamePath: a caller-supplied message replaces the default', () => {
  // node:assert/strict appends its own value diff to a custom message, so this asserts the custom
  // text is present and the default wording is not.
  const message = messageOfThrow(() => assertSamePath('/a', '/b', 'locks must rendezvous'));
  assert.match(message, /locks must rendezvous/);
  assert.doesNotMatch(message, /paths differ/);
});

test('assertDifferentPath: passes on distinct paths, fails on spelling-only differences', () => {
  assertDifferentPath('C:\\real\\.git', 'C:\\foreign\\.git');
  assert.throws(() => assertDifferentPath('C:/real/.git', 'c:\\real\\.git'));
});
