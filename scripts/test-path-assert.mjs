// scripts/test-path-assert.mjs — THE path-comparison assertion for `scripts/*.test.mjs` (plan 2490).
//
// WHY THIS EXISTS. Cloud drains author and run tests on Linux; local sessions run them on Windows.
// A test that asserts a path SPELLING therefore passes in one place and fails in the other, and the
// author never sees it — the failure surfaces days later, on an unrelated plan, via the plan-2273
// import-closure test selection, so the session that pays the cost is not the one that introduced
// it (the plan-2478 → plan-2462 incident: `scripts/lock-path.test.mjs` was green in the cloud and
// 2/4 red on every Windows checkout, and it blocked a push that never touched lock-path).
//
// Two spellings of ONE path are routinely different strings:
//   • separators — git reports a main clone's common dir with `/` and a linked worktree's with `\`
//     on Windows, so a raw `assert.equal(a, b)` on two git-reported paths fails on a pair that IS
//     the same rendezvous file;
//   • drive-letter case — `C:\…` vs `c:\…` come back from different Windows APIs for one volume.
//
// `assertSamePath` compares paths by IDENTITY rather than by spelling, so a test says what it means
// ("these two resolve to the same file") instead of encoding one platform's rendering of it. Its
// companion gate `scripts/assert-posix-path-assertions.mjs` points new test authors here.
//
// WHAT IT DOES **NOT** DO: it does not touch the filesystem, resolve symlinks, or make a relative
// path absolute. Two different-but-equivalent *forms* (`a/../b` vs `b`, relative vs absolute) stay
// unequal on purpose — normalizing those would let a genuine resolution bug pass. It normalizes
// exactly the three renderings above, all of which are pure spelling with no semantic content.
import assert from 'node:assert/strict';

// Canonical comparable rendering of a path string. Exported because a few call sites need the
// normalized value itself (building a Set of paths, a `assert.ok(list.includes(…))`), and they must
// use the SAME normalization the assertion does rather than re-rolling a `.replaceAll` locally.
//
// The three normalizations, and why each is spelling-only:
//   1. `\` → `/`  — both are directory separators on Windows and git emits a mix of them for one
//      repo; on POSIX a `\` is a legal filename character, so this is applied unconditionally only
//      because the strings this helper compares are PATHS, never arbitrary user data.
//   2. leading drive letter upper-cased — Windows drive letters are case-insensitive; `c:\x` and
//      `C:\x` are the same file, and which one you get depends on which API produced the string.
//   3. one trailing separator stripped (never from a root like `/` or `C:/`) — `x/y/` and `x/y`
//      name the same directory.
export function toComparablePath(p) {
  let s = String(p).replaceAll('\\', '/');
  s = s.replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`);
  // Strip ONE trailing slash, but never reduce a root to the empty string: `/` stays `/`, `C:/`
  // stays `C:/`, and a UNC root `//server/share` keeps its shape.
  if (s.length > 1 && s.endsWith('/') && !/^(?:[A-Za-z]:)?\/$/.test(s)) s = s.slice(0, -1);
  return s;
}

// Assert that two path strings name the same path. Use this instead of `assert.equal(a, b)` (or a
// hand-rolled `a.replaceAll('\\', '/') === b.replaceAll('\\', '/')`) whenever either side is a
// filesystem path — the failure message shows BOTH the raw and the normalized forms, so a real
// mismatch is still readable and a mismatch that is only about spelling can no longer happen.
export function assertSamePath(actual, expected, message) {
  const a = toComparablePath(actual);
  const b = toComparablePath(expected);
  // Guarded rather than an unconditional `assert.equal(a, b, <template>)`: the default message
  // interpolates four values, and building it on every PASSING assertion would charge the whole
  // battery for a string nobody reads.
  if (a === b) return;
  assert.equal(
    a,
    b,
    message ??
      `paths differ (compared separator- and drive-case-insensitively):\n` +
        `  actual:   ${JSON.stringify(actual)}  →  ${JSON.stringify(a)}\n` +
        `  expected: ${JSON.stringify(expected)}  →  ${JSON.stringify(b)}`,
  );
}

// The negative form, for a test whose point is that two anchors resolve to DIFFERENT files (e.g.
// the poisoned-GIT_DIR case). Without it an author reaches back for `assert.notEqual`, which is
// spelling-sensitive in exactly the same way and would pass for the wrong reason on the platform
// where the two paths merely happen to be spelled differently.
export function assertDifferentPath(actual, expected, message) {
  const a = toComparablePath(actual);
  const b = toComparablePath(expected);
  if (a !== b) return;
  assert.notEqual(
    a,
    b,
    message ?? `expected different paths, both normalized to ${JSON.stringify(a)}`,
  );
}
