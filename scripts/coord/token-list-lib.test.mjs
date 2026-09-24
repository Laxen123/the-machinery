// scripts/token-list-lib.test.mjs — unit tests for the generic token-list
// parse/validate helper extracted from cloud-repos-lib.mjs (plan 3962 P1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTokenList, validateTokenList, parseAndValidateTokenList } from './token-list-lib.mjs';

test('parseTokenList: absent/blank is an empty list', () => {
  assert.deepEqual(parseTokenList(undefined), []);
  assert.deepEqual(parseTokenList(null), []);
  assert.deepEqual(parseTokenList(''), []);
  assert.deepEqual(parseTokenList('   '), []);
});

test('parseTokenList: comma and/or whitespace separated, lowercased, untrimmed input trimmed', () => {
  assert.deepEqual(parseTokenList('a, B c'), ['a', 'b', 'c']);
  assert.deepEqual(parseTokenList('  A ,, b  '), ['a', 'b']);
});

test('validateTokenList: non-strict drops unknown tokens and dedups, order-preserving', () => {
  assert.deepEqual(validateTokenList(['a', 'x', 'b', 'a'], ['a', 'b']), ['a', 'b']);
});

test('validateTokenList: strict throws on the first unknown token with a generic message by default', () => {
  assert.throws(() => validateTokenList(['a', 'x'], ['a'], { strict: true }), /unknown key `x`/);
});

test('validateTokenList: strict uses a caller-supplied formatUnknownError', () => {
  assert.throws(
    () =>
      validateTokenList(['x'], ['a'], {
        strict: true,
        formatUnknownError: (t) => `custom: ${t}`,
      }),
    /custom: x$/,
  );
});

test('parseAndValidateTokenList: parses then validates in one call', () => {
  assert.deepEqual(parseAndValidateTokenList('HOBBY-MAIN, bogus', ['hobby-main']), ['hobby-main']);
  assert.deepEqual(parseAndValidateTokenList(undefined, ['hobby-main']), []);
});
