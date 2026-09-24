// scripts/index-sanity.test.mjs — paired with scripts/coord/index-sanity.mjs (plan 3968): the
// truncated-index predicate is a genuinely new module with its own fixture needs (a
// 1,000+-path tree to clear the floor, plus a hand-corrupted `.git/index`), so it gets its
// own isolated test file rather than folding into heal-main.test.mjs or
// pre-yield-guard.test.mjs — both of which exercise the predicate only through their own
// callers, not its boundary cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkIndexSanity,
  GIT_INDEX_HEADER_BYTES,
  TRUNCATED_INDEX_HEAD_FLOOR,
  TRUNCATED_INDEX_RATIO,
} from './index-sanity.mjs';
import { statSync } from 'node:fs';
import { makeLargeRepo as buildLargeRepo, tornIndex } from '../test-helpers/torn-index-repo.mjs';

// plan 338: clear inherited GIT_* so `git -C <tmpdir>` honours the temp repo even when this
// suite runs inside a git hook.
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'index-sanity-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  g('add', '-A');
  g('commit', '-qm', 'seed');
  return { dir, g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Shared with heal-main.test.mjs and pre-yield-guard.test.mjs via
// test-helpers/torn-index-repo.mjs (plan 3968 review, a23554/1a2f55) — `tornIndex` is
// imported directly from there too.
function makeLargeRepo(fileCount) {
  return buildLargeRepo(makeRepo, fileCount);
}

const indexPath = (dir) => join(dir, '.git', 'index');

test('checkIndexSanity: a healthy full index on a large tree is not truncated', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    const res = checkIndexSanity(r.dir);
    assert.equal(res.truncated, false);
    assert.equal(res.indexCount, res.headCount);
    assert.ok(res.headCount >= TRUNCATED_INDEX_HEAD_FLOOR);
  } finally {
    r.cleanup();
  }
});

test('checkIndexSanity: below the path floor is never truncated, even with a wiped index', () => {
  const r = makeLargeRepo(5);
  try {
    writeFileSync(indexPath(r.dir), ''); // 0 bytes — would trip the raw check above the floor
    const res = checkIndexSanity(r.dir);
    assert.equal(res.truncated, false);
    assert.match(res.why, /below the \d+-path floor/);
  } finally {
    r.cleanup();
  }
});

// plan 3968 review round 4 (findings 96d27f/c7e645): a failed `git rev-parse HEAD` or
// `git ls-tree -r HEAD` probe used to report a bare `truncated: false` — indistinguishable from
// a probe that actually RAN and found the index healthy — so a caller could proceed as though
// the index had been verified when it had not been checked at all. Both must now report
// `unknown: true`, the same third verdict every other failed probe in this module uses.
test('checkIndexSanity: a failed HEAD probe (rev-parse) reports unknown, never a healthy truncated:false', () => {
  const r = makeRepo();
  try {
    const fakeExec = (cmd, args, opts) => {
      if (args.includes('rev-parse')) {
        throw new Error('fatal: ambiguous argument HEAD: unknown revision');
      }
      return execFileSync(cmd, args, opts);
    };
    const res = checkIndexSanity(r.dir, { exec: fakeExec });
    assert.equal(res.truncated, false);
    assert.equal(res.unknown, true);
    assert.match(res.why, /probe-error/);
  } finally {
    r.cleanup();
  }
});

test('checkIndexSanity: a failed HEAD-tree probe (ls-tree) reports unknown, never a healthy truncated:false', () => {
  const r = makeRepo();
  try {
    const fakeExec = (cmd, args, opts) => {
      if (args.includes('ls-tree')) {
        throw new Error('fatal: not a tree object');
      }
      return execFileSync(cmd, args, opts);
    };
    const res = checkIndexSanity(r.dir, { exec: fakeExec });
    assert.equal(res.truncated, false);
    assert.equal(res.unknown, true);
    assert.match(res.why, /probe-error/);
  } finally {
    r.cleanup();
  }
});

test('checkIndexSanity: an index rebuilt to a handful of HEAD paths is truncated (ratio)', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    // A well-formed but tiny index against a big HEAD — the incident's actual shape
    // (torn write leaves a "valid" few-KB index where 25MB used to be).
    tornIndex(r.dir);
    const res = checkIndexSanity(r.dir);
    assert.equal(res.truncated, true);
    assert.equal(res.indexCount, 1);
    assert.match(
      res.why,
      new RegExp(`below ${Math.round(TRUNCATED_INDEX_RATIO * 100)}% of HEAD's`),
    );
  } finally {
    r.cleanup();
  }
});

test('checkIndexSanity: a missing index file on a large tree reads as fully truncated', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    rmSync(indexPath(r.dir));
    const res = checkIndexSanity(r.dir);
    assert.equal(res.truncated, true);
    assert.equal(res.indexCount, 0);
  } finally {
    r.cleanup();
  }
});

test('checkIndexSanity: an index file shorter than the 12-byte header is truncated', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    writeFileSync(indexPath(r.dir), Buffer.alloc(GIT_INDEX_HEADER_BYTES - 1));
    const res = checkIndexSanity(r.dir);
    assert.equal(res.truncated, true);
    assert.match(res.why, /below the 12-byte git-index header/);
  } finally {
    r.cleanup();
  }
});

// plan 3968 review (f38c5d): the previous `headFloor`/`ratio` override options are REMOVED —
// no production caller (heal-main.mjs, pre-yield-guard.mjs) ever supplied them, and the
// override was a bypass surface (`{ headFloor: 0, ratio: 0 }` reads any non-empty index as
// healthy regardless of how torn it actually is). The floor and ratio are fixed policy now;
// only `exec` remains injectable, purely for the memoization test below.

// plan 3968 review (6dfcad/4661b5/d12eb5): the predicate used to run its git calls with
// whatever env it inherited, so an AMBIENT `GIT_INDEX_FILE` (set by, say, an enclosing git
// hook, or a stray leftover in this very test process) could redirect `ls-files`/`ls-tree` at
// a completely different index than the one `rawIndexFileCheck` validated. Restored/cleared
// in `finally` so this test cannot leak into any other.
test('checkIndexSanity: ignores an ambient GIT_INDEX_FILE pointing at a bogus path', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  const had = 'GIT_INDEX_FILE' in process.env;
  const prev = process.env.GIT_INDEX_FILE;
  try {
    process.env.GIT_INDEX_FILE = join(tmpdir(), 'pcp-bogus-index-does-not-exist');
    const res = checkIndexSanity(r.dir);
    assert.equal(res.truncated, false, 'must read the REAL default index, not the ambient one');
    assert.equal(res.indexCount, res.headCount);
  } finally {
    if (had) process.env.GIT_INDEX_FILE = prev;
    else delete process.env.GIT_INDEX_FILE;
    r.cleanup();
  }
});

// plan 3968 review (136533/a4160a, signal 1): a sparse checkout's index legitimately carries
// only a slice of HEAD's tree — that must never read as "truncated" (and heal-main must
// never `git reset` over it, which would blow away the sparse selection). The gate fires on
// git's own sparse-checkout CONFIG/pattern state, not on independently re-deriving whether a
// given low count is "real" sparse narrowing — so simulating the on-disk shape (an index
// carrying far fewer paths than HEAD) alongside a sparse-checkout config is the correct unit
// of test here, regardless of whether this git version's `ls-files --cached` count would
// itself shrink for a cone-mode narrow (that mechanism is git's own, not this predicate's).
test('checkIndexSanity: a SPARSE checkout with a partial index is not-applicable, never truncated', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    r.g('sparse-checkout', 'init', '--cone');
    // Cone mode ALWAYS keeps root-level tracked files materialized regardless of pattern, so
    // `many/f0.txt` (the shared `tornIndex` helper's path) is removed from the working tree by
    // this narrowing and a plain `git add` of it would fail "did not match any files" — stage
    // `base.txt` instead, the one root-level file this fixture's cone selection can't drop.
    r.g('sparse-checkout', 'set', 'does-not-exist');
    r.g('read-tree', '--empty');
    r.g('add', 'base.txt');
    const res = checkIndexSanity(r.dir);
    assert.equal(res.truncated, false);
    assert.match(res.why, /SPARSE/);
  } finally {
    r.cleanup();
  }
});

// plan 3968 review round 2 (188436/c24117/6e0c97): `index.sparse=true` ALONE — with no
// `core.sparseCheckout` and no populated `sparse-checkout list` — must NOT exempt a low-ratio
// index. `index.sparse` is a sparse-INDEX-representation performance flag a perfectly ordinary
// DENSE checkout can carry (set globally, or inherited), so treating it alone as proof of
// narrowing let a genuinely torn index on a dense tree read as `not-applicable` and skip
// heal-main's reset.
test('checkIndexSanity: index.sparse=true alone (no core.sparseCheckout, no pattern list) does NOT exempt a torn index', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    r.g('config', '--bool', 'index.sparse', 'true'); // the flag alone — sparse-checkout never initialized
    tornIndex(r.dir);
    const res = checkIndexSanity(r.dir);
    assert.equal(
      res.truncated,
      true,
      'index.sparse=true alone must not read as a sparse exemption',
    );
    assert.doesNotMatch(res.why, /SPARSE/);
  } finally {
    r.cleanup();
  }
});

// The real signals (core.sparseCheckout=true, or a populated sparse-checkout pattern list) must
// still exempt — already pinned by the existing 'SPARSE checkout with a partial index' test
// above (git's own `sparse-checkout list` itself refuses ("not sparse") whenever
// core.sparseCheckout is false, so the two signals are not independently constructible in a
// real repo; both are still checked, belt-and-suspenders, for any git version/shape where they
// diverge).

// plan 3968 review round 2 (6f8265): when the staged-deletion probe (the two-signal ratio
// branch's own second signal) itself errors, this must report `unknown: true` — never fall
// back to a plain healthy `truncated: false` the way the old catch-to-`0` behaviour did.
test('checkIndexSanity: a staged-deletion probe failure reports unknown, never a plain healthy verdict', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    tornIndex(r.dir); // low index-count ratio; not sparse — reaches the staged-deletion probe
    const flaky = (...a) => {
      const args = a[1];
      if (Array.isArray(args) && args.includes('diff') && args.includes('--diff-filter=D')) {
        throw new Error('simulated staged-deletion probe failure');
      }
      return execFileSync(...a);
    };
    const res = checkIndexSanity(r.dir, { exec: flaky });
    assert.equal(res.truncated, false, 'unknown is always paired with truncated:false');
    assert.equal(res.unknown, true);
    assert.match(res.why, /probe-error/);
  } finally {
    r.cleanup();
  }
});

// plan 3968 review round 3 (259857): a FAILED stat is not evidence of truncation — only a
// SUCCESSFUL read that shows the index missing/too-small is. Pins this via the `statFn`
// testability seam (mirrors the `exec` seam's own probe-failure tests above) rather than
// trying to provoke a real EPERM/EIO on disk.
test('checkIndexSanity: a stat FAILURE (not ENOENT) reports unknown, never truncated', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    const flakyStat = (p) => {
      if (p === indexPath(r.dir)) {
        const e = new Error('simulated EPERM');
        e.code = 'EPERM';
        throw e;
      }
      return statSync(p);
    };
    const res = checkIndexSanity(r.dir, { statFn: flakyStat });
    assert.equal(res.truncated, false, 'a failed stat must never read as confirmed truncation');
    assert.equal(res.unknown, true);
    assert.match(res.why, /probe-error/);
  } finally {
    r.cleanup();
  }
});

// A genuinely ABSENT index file (ENOENT) is a different, decisive signal — still handled by
// the existing 'a missing index file ... reads as fully truncated' test above; this only pins
// that a non-ENOENT stat failure is NOT folded into the same bucket.

// plan 3968 review round 3 (9881c6): a FAILED `git ls-files --cached` proves nothing about the
// index's actual entry count — only that the probe itself could not run.
test('checkIndexSanity: a FAILED git ls-files --cached reports unknown, never truncated', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    const flaky = (...a) => {
      const args = a[1];
      if (Array.isArray(args) && args.includes('ls-files') && args.includes('--cached')) {
        throw new Error('simulated ls-files --cached failure');
      }
      return execFileSync(...a);
    };
    const res = checkIndexSanity(r.dir, { exec: flaky });
    assert.equal(res.truncated, false, 'a failed ls-files --cached must never read as truncated');
    assert.equal(res.unknown, true);
    assert.match(res.why, /probe-error/);
  } finally {
    r.cleanup();
  }
});

// plan 3968 review round 3 (8e0d39): a probe FAILURE on BOTH sparse-checkout signals must not
// be silently read as "not sparse" — a real sparse checkout's legitimately low-entry index
// could otherwise fall through to the deletion-ratio branch and get reset, destroying the
// sparse selection. Simulated via `exec` (never a real corrupt-config repro) since the whole
// point is that this is an UNEXPECTED failure shape, not the ordinary "not configured" one.
test('checkIndexSanity: a probe failure on BOTH sparse-checkout signals reports unknown, never falls through as non-sparse', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    tornIndex(r.dir); // low index-count ratio — would otherwise reach the sparse check
    const flaky = (...a) => {
      const args = a[1];
      if (Array.isArray(args) && args.includes('config') && args.includes('core.sparseCheckout')) {
        const e = new Error('simulated config probe failure');
        e.status = 129; // NOT the ordinary "unset" exit code (1)
        e.stderr = 'fatal: bad config'; // NOT the ordinary silent-unset shape either
        throw e;
      }
      if (args.includes('sparse-checkout') && args.includes('list')) {
        const e = new Error('simulated sparse-checkout list probe failure');
        e.stderr = 'fatal: something unexpected broke'; // does NOT match /not sparse/i
        throw e;
      }
      return execFileSync(...a);
    };
    const res = checkIndexSanity(r.dir, { exec: flaky });
    assert.equal(
      res.truncated,
      false,
      'must never resolve to a plain truncated:true OR a plain healthy truncated:false',
    );
    assert.equal(res.unknown, true);
    assert.match(res.why, /sparse-checkout probe itself failed/);
  } finally {
    r.cleanup();
  }
});

// The ORDINARY "not configured" shape (exit 1 + no stderr for `config`, or a "not sparse"
// stderr for `sparse-checkout list`) must still resolve decisively to "not sparse" — already
// covered by the real-repo tests above (they never set any sparse signal and still reach a
// definite `truncated: true`/`false`, never `unknown`), so no separate pin is needed here.

// plan 3968 review (c4ee3d): heal-main's own step 0 and its later healDirt arm both call this
// predicate on the SAME mainDir within one process — the memo must skip the expensive
// ls-tree/ls-files listing entirely on the second call. `exec` is injected as a spy so the
// test can assert on invocation COUNT rather than timing.
test('checkIndexSanity: memoizes per (mainDir, HEAD, index state) — a second call in the same process never re-shells out', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    let calls1 = 0;
    const spy1 = (...a) => {
      calls1++;
      return execFileSync(...a);
    };
    const first = checkIndexSanity(r.dir, { exec: spy1 });
    assert.equal(first.truncated, false);
    assert.ok(calls1 > 0, 'the first (cache-miss) call must actually shell out');

    let calls2 = 0;
    const spy2 = (...a) => {
      calls2++;
      return execFileSync(...a);
    };
    const second = checkIndexSanity(r.dir, { exec: spy2 });
    assert.deepEqual(second, first);
    // A memo HIT still makes the one cheap call needed to derive the cache key itself
    // (`rev-parse HEAD`) but must skip the two EXPENSIVE listings (`ls-tree`, `ls-files`) the
    // first (miss) call needed — that's the whole point of memoizing on mainDir+HEAD+index
    // state instead of on mainDir alone.
    assert.equal(calls2, 1, 'a memo hit makes only the cheap rev-parse HEAD call');
    assert.ok(calls1 > calls2, 'the miss must have made strictly more calls than the hit');
  } finally {
    r.cleanup();
  }
});
