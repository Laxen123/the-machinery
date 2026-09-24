// scripts/parse-flags.test.mjs (plan 2514)
// Direct unit coverage for the shared CLI-flag machinery in parse-flags.mjs. parseFlags
// itself is already exercised indirectly through its many callers' own test suites
// (claim-plan.test.mjs, move-plan.test.mjs, etc.) — this file is the home for assertOneOf,
// the shared closed-vocabulary validator plan 2514 extracted from four hand-rolled copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOneOf, parseFlags } from './parse-flags.mjs';

test('assertOneOf: a valid value passes through unchanged', () => {
  assert.equal(assertOneOf('b', ['a', 'b', 'c'], { label: 'letter' }), 'b');
});

test('assertOneOf: an invalid value throws, naming the label, the value, and the full list', () => {
  assert.throws(
    () => assertOneOf('z', ['a', 'b', 'c'], { label: 'letter' }),
    (e) => {
      assert.match(e.message, /invalid letter "z"/);
      assert.match(e.message, /One of: a, b, c/);
      return true;
    },
  );
});

test('assertOneOf: undefined/missing value throws the same shape as any other miss', () => {
  assert.throws(
    () => assertOneOf(undefined, ['a', 'b'], { label: 'mode' }),
    /invalid mode "undefined"\. One of: a, b/,
  );
});

test("assertOneOf: an optional prefix folds a script's own lead-in into the thrown message, so a CLI catch block never re-derives it", () => {
  assert.throws(
    () => assertOneOf('z', ['a', 'b'], { label: 'mode', prefix: 'my-script' }),
    (e) => {
      assert.equal(e.message, 'my-script: invalid mode "z". One of: a, b');
      return true;
    },
  );
});

test('assertOneOf: no prefix ⇒ the raw unified message, unchanged from the no-prefix behavior', () => {
  assert.throws(
    () => assertOneOf('z', ['a', 'b'], { label: 'mode' }),
    (e) => {
      assert.equal(e.message, 'invalid mode "z". One of: a, b');
      return true;
    },
  );
});

test('parseFlags: value/boolean/positional dispatch (sanity — full semantics pinned by callers)', () => {
  const { positionals, flags } = parseFlags(['foo', '--dry', '--slug', 'bar'], {
    label: 'test',
    value: ['slug'],
    boolean: ['dry'],
  });
  assert.deepEqual(positionals, ['foo']);
  assert.deepEqual(flags, { dry: true, slug: 'bar' });
});

test('parseFlags: requireValues makes an end-of-argv value flag throw, opt-in only (plan 2734)', () => {
  const spec = { label: 'battery-lock', value: ['tier'] };
  // DEFAULT (unchanged, and pinned by coord-git.test.mjs): the key is SET with an `undefined`
  // value, which is the only way a caller can tell "absent" from "present but valueless".
  const lax = parseFlags(['path', '--tier'], spec);
  assert.ok('tier' in lax.flags);
  assert.equal(lax.flags.tier, undefined);
  // OPT-IN: for the callers that read flags with `??`/`!= null` — almost all of them — that stored
  // `undefined` reads as absent and the malformed request silently takes the DEFAULT.
  assert.throws(
    () => parseFlags(['path', '--tier'], { ...spec, requireValues: true }),
    (e) => {
      assert.match(
        e.message,
        /battery-lock: flag --tier is missing its value \(end of arguments\)/,
      );
      return true;
    },
  );
  // Strict mode also covers the EMPTY and whitespace-only shapes (review round 5): `''` is falsy
  // but not nullish, so it slips past `??` defaulting exactly like the missing case and lands as a
  // real value — a path, a branch name. The lax default still yields `''`, which stays a legitimate
  // caller-visible empty string for the callers that want one.
  const strict = { ...spec, boolean: ['json'], requireValues: true };
  assert.equal(parseFlags(['--tier', 'overflow'], strict).flags.tier, 'overflow');
  assert.equal(parseFlags(['--tier='], spec).flags.tier, '');
  for (const argv of [['--tier='], ['--tier', ''], ['--tier', '   ']]) {
    assert.throws(
      () => parseFlags(argv, strict),
      /flag --tier is missing its value \(got "/,
      `strict mode must refuse ${JSON.stringify(argv)}`,
    );
  }
  // A flag-shaped value is NOT strict mode's business — the parser cannot know whether a caller
  // legitimately accepts one, so assertFlagValue owns that shape at the call sites that don't.
  assert.equal(parseFlags(['--tier', '--json'], strict).flags.tier, '--json');
  // Boolean/optional flags at the end of argv stay legal under strict mode.
  assert.deepEqual(parseFlags(['--json'], strict).flags, { json: true });
});
