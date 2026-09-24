// scripts/lint-coord-lockctx.test.mjs  (plan 2435 item 3)
// Acceptance for the lockCtx lint: it must FAIL a deliberately-broken callback that takes the lock
// handle and then mutates, and PASS all four currently-wired call sites.
//
// The evasion cases below are REGRESSION tests for the 2026-07-26 xhigh review, which defeated the
// first cut's textual-forwarding detector in one line each (an alias, a `function` expression) and
// found a denylist entry that could never match. Each is named with the shape it guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findWiredSites,
  findLockCtxViolations,
  trackedScripts,
  main,
  MUTATING_CALLS,
} from './lint-coord-lockctx.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(HERE, f), 'utf8');

const LATE_WRITE = "writeFileSync(join(cdir, 'docs/handoff/board.md'), 'late write');";

const BROKEN = `
import { coordWrite, withCoordCheckout } from './coord-git.mjs';
export function bad(mainDir) {
  return withCoordCheckout(mainDir, (cdir, lockCtx) => {
    const res = coordWrite(cdir, {
      lockCtx,
      relPaths: ['docs/INDEX.md'],
      mutate: () => writeFileSync(join(cdir, 'docs/INDEX.md'), 'x'),
      message: 'msg',
      tool: 'bad',
    });
    ${LATE_WRITE}
    return res;
  });
}
`;

const GOOD = BROKEN.replace(LATE_WRITE, "console.log('good: committed + pushed');");

test('FAILS the deliberately-broken callback', () => {
  const v = findLockCtxViolations(BROKEN);
  assert.equal(v.length, 1);
  assert.equal(v[0].callee, 'writeFileSync');
  assert.match(v[0].snippet, /late write/);
});

test('PASSES when coordWrite is the callback last mutation', () => {
  assert.deepEqual(findLockCtxViolations(GOOD), []);
});

test('a mutation BEFORE coordWrite is not a violation', () => {
  const src = BROKEN.replace(LATE_WRITE, '').replace(
    '    const res = coordWrite(',
    "    writeFileSync(join(cdir, 'early'), 'ok');\n    const res = coordWrite(",
  );
  assert.deepEqual(findLockCtxViolations(src), []);
});

test('a ONE-parameter callback never took the handle — exempt', () => {
  // dropping the second param is the documented way to keep the whole-op lock hold
  const src = BROKEN.replace('(cdir, lockCtx) =>', '(cdir) =>').replace('      lockCtx,\n', '');
  assert.deepEqual(findLockCtxViolations(src), []);
});

// ── review regressions: shapes that defeated the first, textual-forwarding detector ────────────
test('regression: an ALIASED handle is still caught (review finding 2)', () => {
  const src = BROKEN.replace(
    '    const res = coordWrite(cdir, {\n      lockCtx,',
    '    const ctx = lockCtx;\n    const res = coordWrite(cdir, {\n      lockCtx: ctx,',
  );
  const v = findLockCtxViolations(src);
  assert.equal(v.length, 1, 'aliasing the handle must not defeat the lint');
  assert.equal(v[0].callee, 'writeFileSync');
});

test('regression: a `function` expression callback is still caught (review finding 4)', () => {
  const src = BROKEN.replace('(cdir, lockCtx) => {', 'function (cdir, lockCtx) {');
  const v = findLockCtxViolations(src);
  assert.equal(v.length, 1, 'a non-arrow callback must not defeat the lint');
  assert.equal(v[0].callee, 'writeFileSync');
});

test('regression: a named function expression callback is still caught', () => {
  const src = BROKEN.replace('(cdir, lockCtx) => {', 'function runIt(cdir, lockCtx) {');
  assert.equal(findLockCtxViolations(src).length, 1);
});

test('regression: atomicWriteTextSync / atomicWriteJsonSync match (review finding 3)', () => {
  for (const fn of ['atomicWriteTextSync', 'atomicWriteJsonSync']) {
    const src = BROKEN.replace(LATE_WRITE, `${fn}(join(cdir, 'x'), 'y');`);
    const v = findLockCtxViolations(src);
    assert.equal(v.length, 1, `${fn} must be caught`);
    assert.equal(v[0].callee, `atomicWrite${fn.slice('atomicWrite'.length)}`);
  }
  // and the denylist no longer carries the bare name that could never match
  assert.ok(!MUTATING_CALLS.includes('atomicWrite'), 'the unmatched literal must be gone');
});

test('regression: an unterminated string does not blank the rest of the file (review finding 1)', () => {
  // the shared house tokenizer terminates '…'/"…" at a newline, so a stray quote cannot swallow
  // the following mutation the way the hand-rolled scanner did
  const src = BROKEN.replace(
    '    const res = coordWrite(',
    "    const oops = 'unterminated;\n    const res = coordWrite(",
  );
  const v = findLockCtxViolations(src);
  assert.equal(v.length, 1, 'a stray quote must not hide the later mutation');
});

test('a git call after coordWrite is a violation too', () => {
  const src = BROKEN.replace(LATE_WRITE, "gitWithLockRetry(cdir, ['clean', '-fd']);");
  const v = findLockCtxViolations(src);
  assert.equal(v.length, 1);
  assert.equal(v[0].callee, 'gitWithLockRetry');
});

test('a denylisted name inside a trailing COMMENT or STRING is not a violation', () => {
  for (const tail of [
    "// safe: we deliberately do NOT writeFileSync(cdir) here\n    console.log('ok');",
    "console.log('did not call rmSync(cdir)');",
  ]) {
    assert.deepEqual(findLockCtxViolations(BROKEN.replace(LATE_WRITE, tail)), []);
  }
});

test('one offence is reported once even though two header patterns can match', () => {
  assert.equal(findLockCtxViolations(BROKEN).length, 1);
});

// ── the four real wired call sites ────────────────────────────────────────────────────────────
test('detects the wired sites in the real callers (guards against a vacuous pass)', () => {
  for (const [f, want] of Object.entries({
    'board.mjs': 1,
    'edit-plan.mjs': 1,
    // plan 4096 T3 moved this one under scripts/coord/ — the key is a path relative to
    // scripts/, not a bare basename, precisely so a later move shows up as this ENOENT rather
    // than as a silently vacuous pass.
    'coord/record-marker-cli.mjs': 2, // record + re-pin
  })) {
    const { sites } = findWiredSites(read(f));
    assert.equal(sites.length, want, `${f}: expected ${want} site(s), got ${sites.length}`);
  }
});

test('scans TRACKED scripts only, so a sibling session untracked file cannot gate a push', () => {
  const tracked = trackedScripts();
  assert.ok(tracked.length > 50, 'expected the real scripts/ tree');
  assert.ok(
    tracked.every((e) => !e.path.endsWith('.test.mjs')),
    'test files are excluded',
  );
  assert.ok(tracked.some((e) => e.path === 'scripts/coord/coord-git.mjs'));
});

test('the real scripts/ tree is CLEAN — the standing gate', () => {
  // The ENFORCEMENT path is the explicit `node scripts/lint-coord-lockctx.mjs` step in
  // .husky/pre-push (beside the rest of the lint-*.mjs family) — deliberately NOT this test alone:
  // the scripts/*.test.mjs battery is import-closure SELECTED, so a violation introduced in a
  // caller like board.mjs would not pull this file in. This is the unit-level twin of that gate.
  assert.equal(main([]), 0, 'scripts/ carries a lockCtx violation — see the lint output above');
});
