// scripts/disk-headroom.test.mjs (plan 3815)
// Name-paired with scripts/disk-headroom.mjs — genuinely new module, no existing test file to
// fold into (CLAUDE.md's "new *.test.mjs file needs a one-line justification").
//
// Every fixture tree is a REAL temp directory on disk (mkdtempSync), never a mocked fs — same
// convention `test-helpers/no-repo-root.mjs` documents and the rest of this repo's scripts/*
// tests already follow, so these tests exercise the exact readdirSync/rmSync/statfsSync calls
// production runs, not a stand-in for them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  utimesSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkFreeBytes,
  prune,
  pruneNext,
  formatBytes,
  DEFAULT_FLOOR_BYTES,
  main,
} from './disk-headroom.mjs';

function makeTmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// plan 4133 review round 1: prune() also sweeps pytest's basetemp root, and that root DEFAULTS to
// the live `os.tmpdir()` of whatever box the suite happens to run on. Every test that is not itself
// exercising that sweep must therefore aim it somewhere inert, because otherwise a plain unit test
// would (a) assert `deletedCount`/`freedBytes` against whatever stale `pytest-of-*` dirs the machine
// currently holds — ambient state, not a property of the code under test — and (b) actually DELETE
// inside the real `/tmp`, reaping a parallel session's genuinely in-progress pytest basetemp. A
// nonexistent child of the test's own temp root is a silent no-op for that half (see
// pruneBasetempRoots' unreadable-root contract), so it contributes no roots and no bytes.
function noBasetemp(root) {
  return { basetempRoot: join(root, '__no-basetemp-fixture__') };
}

// Builds a minimal fake checkout/worktree tree under `root`:
//   root/.next/BUILD_ID              (build output — a prune target)
//   root/.turbo/cache/x              (turbo cache — a prune target)
//   root/node_modules/.cache/y       (node_modules' own cache — a prune target, node_modules itself is not)
//   root/node_modules/some-pkg/index.js  (an ordinary dependency file — NEVER touched)
//   root/.git/HEAD                   (never entered, never touched)
//   root/src/keep.txt                (ordinary source file — never touched)
function seedFakeCheckout(root, { withGit = true } = {}) {
  mkdirSync(join(root, '.next'), { recursive: true });
  writeFileSync(join(root, '.next', 'BUILD_ID'), 'x'.repeat(1000));
  mkdirSync(join(root, '.turbo', 'cache'), { recursive: true });
  writeFileSync(join(root, '.turbo', 'cache', 'entry'), 'y'.repeat(500));
  mkdirSync(join(root, 'node_modules', '.cache'), { recursive: true });
  writeFileSync(join(root, 'node_modules', '.cache', 'babel'), 'z'.repeat(2000));
  mkdirSync(join(root, 'node_modules', 'some-pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'keep.txt'), 'keep me\n');
  if (withGit) {
    // A directory NAMED .git is enough to prove the walker never enters it — this is not
    // trying to be a real repository, just a directory the walker must skip untouched, even
    // though it happens to contain something that LOOKS like build litter.
    mkdirSync(join(root, '.git', '.next'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/master\n');
  }
}

test('prune: deletes .next, .turbo, and node_modules/.cache and nothing else', () => {
  const root = makeTmpRoot('disk-headroom-basic-');
  try {
    seedFakeCheckout(root);
    const result = prune({ mainCheckoutPath: root, ...noBasetemp(root) });

    assert.equal(existsSync(join(root, '.next')), false, '.next deleted');
    assert.equal(existsSync(join(root, '.turbo')), false, '.turbo deleted');
    assert.equal(
      existsSync(join(root, 'node_modules', '.cache')),
      false,
      'node_modules/.cache deleted',
    );

    // node_modules itself, and everything else inside it, survives untouched.
    assert.equal(existsSync(join(root, 'node_modules')), true, 'node_modules itself untouched');
    assert.equal(
      existsSync(join(root, 'node_modules', 'some-pkg', 'index.js')),
      true,
      'a real dependency file untouched',
    );
    // .git, and the .next-shaped directory planted INSIDE it, both survive — the walker never
    // enters .git at all.
    assert.equal(existsSync(join(root, '.git', 'HEAD')), true, '.git untouched');
    assert.equal(
      existsSync(join(root, '.git', '.next')),
      true,
      '.git contents never walked, even litter-shaped ones',
    );
    // an ordinary source file is untouched.
    assert.equal(existsSync(join(root, 'src', 'keep.txt')), true, 'ordinary source file untouched');

    assert.equal(result.roots.length, 1);
    assert.equal(result.roots[0].label, 'main');
    assert.equal(result.deletedCount, 3); // .next, .turbo, node_modules/.cache
    assert.ok(result.freedBytes > 0, 'reports a nonzero freed total');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prune: a root with nothing to prune is a clean no-op', () => {
  const root = makeTmpRoot('disk-headroom-empty-');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'keep.txt'), 'keep me\n');
    const result = prune({ mainCheckoutPath: root, ...noBasetemp(root) });
    assert.equal(result.deletedCount, 0);
    assert.equal(result.freedBytes, 0);
    assert.equal(existsSync(join(root, 'src', 'keep.txt')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prune: a nonexistent root is a silent no-op, never a throw', () => {
  const root = makeTmpRoot('disk-headroom-parent-');
  try {
    const missing = join(root, 'does-not-exist');
    assert.doesNotThrow(() => prune({ mainCheckoutPath: missing, ...noBasetemp(root) }));
    const result = prune({ mainCheckoutPath: missing, ...noBasetemp(root) });
    assert.equal(result.deletedCount, 0);
    assert.equal(result.freedBytes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prune: worktreesRoot fans out to every immediate child EXCEPT `keep`', () => {
  const root = makeTmpRoot('disk-headroom-worktrees-');
  try {
    const worktreesRoot = join(root, 'worktrees');
    const landed = join(worktreesRoot, 'landed-slug');
    const sibling = join(worktreesRoot, 'sibling-slug');
    mkdirSync(landed, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    seedFakeCheckout(landed, { withGit: false });
    seedFakeCheckout(sibling, { withGit: false });

    const result = prune({ worktreesRoot, keep: landed, ...noBasetemp(root) });

    // The landed worktree (the one being landed right now) is skipped entirely.
    assert.equal(existsSync(join(landed, '.next')), true, 'landed worktree .next untouched (kept)');
    assert.equal(
      existsSync(join(landed, '.turbo')),
      true,
      'landed worktree .turbo untouched (kept)',
    );
    // The sibling worktree is pruned exactly like the main checkout would be.
    assert.equal(existsSync(join(sibling, '.next')), false, 'sibling worktree .next pruned');
    assert.equal(existsSync(join(sibling, '.turbo')), false, 'sibling worktree .turbo pruned');
    assert.equal(
      existsSync(join(sibling, 'node_modules', '.cache')),
      false,
      'sibling worktree node_modules/.cache pruned',
    );
    assert.equal(
      existsSync(join(sibling, 'node_modules', 'some-pkg', 'index.js')),
      true,
      'sibling worktree node_modules contents otherwise untouched',
    );

    const sortedLabels = result.roots.map((r) => r.label).sort();
    assert.deepEqual(sortedLabels, ['worktree:sibling-slug']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prune: `keep` matches by RESOLVED path, not string equality (a trailing slash or ../ still excludes it)', () => {
  const root = makeTmpRoot('disk-headroom-resolve-');
  try {
    const worktreesRoot = join(root, 'worktrees');
    const landed = join(worktreesRoot, 'landed-slug');
    mkdirSync(landed, { recursive: true });
    seedFakeCheckout(landed, { withGit: false });

    // Pass a differently-spelled but equivalent path (trailing separator + a redundant "./").
    const keepSpelledDifferently = join(worktreesRoot, '.', 'landed-slug') + '/';
    const result = prune({ worktreesRoot, keep: keepSpelledDifferently, ...noBasetemp(root) });

    assert.equal(
      existsSync(join(landed, '.next')),
      true,
      'still kept despite differently-spelled path',
    );
    assert.equal(result.roots.length, 0, 'the only worktree present was excluded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prune: a missing worktreesRoot (no worktrees claimed yet) is a silent no-op for that half', () => {
  const root = makeTmpRoot('disk-headroom-no-worktrees-');
  try {
    seedFakeCheckout(root);
    const result = prune({
      mainCheckoutPath: root,
      worktreesRoot: join(root, '.claude', 'worktrees'), // never created
      ...noBasetemp(root),
    });
    // The main checkout half still ran.
    assert.equal(existsSync(join(root, '.next')), false);
    assert.equal(
      result.roots.every((r) => r.label === 'main'),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prune: main-checkout walk never descends into worktreesRoot when it is nested inside mainCheckoutPath (the real repo layout) — `keep` must survive the main-root pass too', () => {
  // Regression for a bug caught by manually exercising the CLI (plan 3815 executor notes): a
  // naive recursive walk of `mainCheckoutPath` happily continues straight into
  // `.claude/worktrees/*` (an ordinary subdirectory from the walker's point of view), deleting
  // the landed worktree's `.next` as collateral — silently defeating `keep`, which only the
  // separate worktrees fan-out loop was checking.
  const root = makeTmpRoot('disk-headroom-nested-worktrees-');
  try {
    seedFakeCheckout(root, { withGit: false }); // main checkout's OWN .next/.turbo/cache
    const worktreesRoot = join(root, '.claude', 'worktrees'); // nested INSIDE the main checkout
    const landed = join(worktreesRoot, 'landed-slug');
    const sibling = join(worktreesRoot, 'sibling-slug');
    mkdirSync(landed, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    seedFakeCheckout(landed, { withGit: false });
    seedFakeCheckout(sibling, { withGit: false });

    prune({ mainCheckoutPath: root, worktreesRoot, keep: landed, ...noBasetemp(root) });

    // Main checkout's own litter is still pruned.
    assert.equal(existsSync(join(root, '.next')), false, 'main checkout .next pruned');
    // The landed worktree — nested inside the main checkout — survives the MAIN pass too, not
    // just the worktrees fan-out pass.
    assert.equal(existsSync(join(landed, '.next')), true, 'landed worktree .next survives (kept)');
    assert.equal(
      existsSync(join(landed, '.turbo')),
      true,
      'landed worktree .turbo survives (kept)',
    );
    // The sibling worktree is pruned via the fan-out loop.
    assert.equal(existsSync(join(sibling, '.next')), false, 'sibling worktree .next pruned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pruneNext: deletes ONLY .next under the given worktree, leaves .turbo and node_modules/.cache', () => {
  const root = makeTmpRoot('disk-headroom-prunenext-');
  try {
    seedFakeCheckout(root, { withGit: false });
    const result = pruneNext(root);
    assert.equal(existsSync(join(root, '.next')), false, '.next deleted');
    assert.equal(
      existsSync(join(root, '.turbo')),
      true,
      '.turbo left for the next land-wide prune',
    );
    assert.equal(
      existsSync(join(root, 'node_modules', '.cache')),
      true,
      'node_modules/.cache left for the next land-wide prune',
    );
    assert.ok(result.freedBytes > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pruneNext: idempotent — a second call finds nothing left and reports 0 bytes freed', () => {
  const root = makeTmpRoot('disk-headroom-prunenext-idempotent-');
  try {
    seedFakeCheckout(root, { withGit: false });
    const first = pruneNext(root);
    assert.ok(first.freedBytes > 0);
    const second = pruneNext(root);
    assert.equal(second.freedBytes, 0);
    assert.equal(second.deleted.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkFreeBytes: returns a positive finite number for a real path (floor-logic smoke test)', () => {
  const root = makeTmpRoot('disk-headroom-check-');
  try {
    const free = checkFreeBytes(root);
    assert.equal(typeof free, 'number');
    assert.ok(Number.isFinite(free));
    assert.ok(free > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEFAULT_FLOOR_BYTES is exactly 3 GB', () => {
  assert.equal(DEFAULT_FLOOR_BYTES, 3 * 1024 * 1024 * 1024);
});

test('formatBytes: renders human-readable units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3 GB');
  assert.equal(formatBytes(-2048), '-2 KB');
});

// ── CLI surface (main()) ─────────────────────────────────────────────────────────────────
test('CLI: `check` prints free bytes and exits 0', () => {
  const root = makeTmpRoot('disk-headroom-cli-check-');
  try {
    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    let code;
    try {
      code = main(['check', root]);
    } finally {
      console.log = orig;
    }
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes('disk-headroom check:')));
    assert.ok(logs.some((l) => l.includes(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: `prune --root <path> --worktrees-root <path>` deletes and reports what it freed', () => {
  const root = makeTmpRoot('disk-headroom-cli-prune-');
  try {
    seedFakeCheckout(root, { withGit: false });
    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    let code;
    try {
      code = main([
        'prune',
        '--root',
        root,
        '--worktrees-root',
        join(root, 'no-such-worktrees-dir'),
        // Aim the basetemp sweep at an inert path — see noBasetemp() above for why a unit test must
        // never let it reach the live `os.tmpdir()`.
        '--basetemp-root',
        join(root, '__no-basetemp-fixture__'),
      ]);
    } finally {
      console.log = orig;
    }
    assert.equal(code, 0);
    assert.equal(existsSync(join(root, '.next')), false);
    assert.ok(logs.some((l) => l.includes('disk-headroom prune: freed')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI (plan 4133 review r1): --basetemp-root aims the basetemp sweep, and the CLI sweeps the one it is given', () => {
  const root = makeTmpRoot('disk-headroom-cli-basetemp-');
  try {
    // A basetemp fixture OUTSIDE the checkout root — the sweep's whole point is that it reaches a
    // root no other prune half walks.
    const basetempRoot = join(root, 'fake-tmp');
    const pytestOf = join(basetempRoot, 'pytest-of-someuser');
    const p0 = makeBasetempSession(pytestOf, 'pytest-0', 1);
    const p1 = makeBasetempSession(pytestOf, 'pytest-1', 2);
    const p2 = makeBasetempSession(pytestOf, 'pytest-2', 3);
    const checkout = join(root, 'checkout');
    mkdirSync(checkout, { recursive: true });
    seedFakeCheckout(checkout, { withGit: false });

    const orig = console.log;
    console.log = () => {};
    let code;
    try {
      code = main([
        'prune',
        '--root',
        checkout,
        '--worktrees-root',
        join(root, 'no-such-worktrees-dir'),
        '--basetemp-root',
        basetempRoot,
      ]);
    } finally {
      console.log = orig;
    }

    assert.equal(code, 0);
    // review round 2: the CLI has no platform-injection seam — it is the PRODUCTION entry point, so
    // it necessarily reads the real `process.platform`, and the sweep is POSIX-only by design (S4).
    // The expected OUTCOME therefore differs per platform and both branches are asserted here
    // rather than one being assumed: asserting the POSIX deletion unconditionally would land green
    // on this Linux box and go red on the Windows checkout that runs this same battery at every
    // local push. The sweep's own keep/reap RULES are covered platform-independently by the
    // `basetempPlatform`-injected tests above; what this test adds is only that the FLAG is wired
    // through `main()` into prune().
    // platform-assert-ok: the CLI is the production entry point and has no platform seam by design;
    // both real branches are asserted, neither is faked.
    if (process.platform === 'win32') {
      assert.equal(existsSync(p0), true, 'win32: the basetemp sweep is skipped entirely');
      assert.equal(existsSync(p1), true);
      assert.equal(existsSync(p2), true);
    } else {
      assert.equal(existsSync(p0), false, 'the stale basetemp under the NAMED root is reaped');
      assert.equal(existsSync(p1), true, 'one of the two newest survives');
      assert.equal(existsSync(p2), true, 'the newest survives');
    }
    // The checkout half still ran on EITHER platform, so the flag adds a root rather than
    // replacing the others.
    assert.equal(existsSync(join(checkout, '.next')), false, 'main checkout half still pruned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: an unknown command exits 2 with a usage message on stderr', () => {
  const errs = [];
  const orig = console.error;
  console.error = (...args) => errs.push(args.join(' '));
  let code;
  try {
    code = main(['bogus']);
  } finally {
    console.error = orig;
  }
  assert.equal(code, 2);
  assert.ok(errs.some((l) => l.includes('unknown or missing command')));
});

// ── plan 4133 S4: pytest's OWN basetemp (`pytest-of-*` under the OS tmp root) ───────────────
//
// `basetempRoot`/`basetempPlatform` are prune()'s injection seam for this sweep specifically so
// these tests never have to scan — or delete inside — the REAL OS tmp dir, which on a live box can
// carry another session's genuinely in-progress basetemp (see disk-headroom.mjs's own header on
// pruneBasetempRoots for why that matters). `basetempPlatform` is likewise a PARAMETER rather than
// a `process.platform` fake — the repo's own platform-branch rule — and no other platform-only
// symbol is reached by this sweep (readdirSync/statSync/readlinkSync all exist on every platform
// Node runs on), so the parameter alone is the whole fix for this axis.

// Fixed, deterministic timestamps — never the real ambient clock — so "newest" is decided by
// construction, not by how fast this test happens to run.
const BASETEMP_DAY = (n) => new Date(Date.UTC(2024, 0, n, 0, 0, 0));

/** One `pytest-<name>` session dir under `pytestOfDir`, with an explicit mtime and some real
 * on-disk content (so a freed-bytes assertion has something to be positive ABOUT). */
function makeBasetempSession(pytestOfDir, name, day) {
  const dir = join(pytestOfDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'marker.txt'), 'x'.repeat(1000));
  const t = BASETEMP_DAY(day);
  utimesSync(dir, t, t);
  return dir;
}

// plan 4133 review round 1: creating a DIRECTORY symlink is not a given on every box this suite
// runs on — Windows refuses it with EPERM unless the process is elevated or Developer Mode is on,
// and the `scripts/*.test.mjs` battery runs on the operator's Windows checkout at every local push.
// An unconditional `symlinkSync` here would therefore land green on Linux and then block an
// UNRELATED session's push, which is precisely the half-injected-platform-branch failure the repo's
// own test rule names. The capability is a PARAMETER of the environment, so it is probed and the
// one assertion that needs it is skipped where it is unavailable — the POSIX boxes that actually
// run this sweep in production (cloud drains) still get full coverage.
// platform-assert-ok: the symlink capability is probed at runtime, never assumed from the platform.
// Narrowed (review round 2): only a genuine "this host cannot make a directory symlink" error is
// answered with `false`. Anything else — an ENOENT from a fixture whose parent was never created,
// say — is a REAL bug in this test and is re-thrown rather than quietly downgraded into a skip,
// which would hide the failure on every platform at once.
const SYMLINK_UNSUPPORTED_CODES = new Set(['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'UNKNOWN']);
function trySymlinkDir(target, linkPath) {
  try {
    symlinkSync(target, linkPath, 'dir');
    return true;
  } catch (err) {
    if (SYMLINK_UNSUPPORTED_CODES.has(err?.code)) return false;
    throw err;
  }
}

test('prune (basetempRoot): keeps the two newest pytest-<n> dirs AND the pytest-current target, deletes every other stale one', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'disk-headroom-basetemp-'));
  try {
    const pytestOf = join(root, 'pytest-of-someuser');
    // Ascending mtime: pytest-0 oldest .. pytest-3 newest. `pytest-current` deliberately points at
    // the OLDEST one — a live session can still be writing into an old-numbered dir that simply
    // has not been touched in a while, and THAT is exactly the case this rule protects, distinct
    // from "it happens to be one of the two newest".
    const p0 = makeBasetempSession(pytestOf, 'pytest-0', 1);
    const p1 = makeBasetempSession(pytestOf, 'pytest-1', 2);
    const p2 = makeBasetempSession(pytestOf, 'pytest-2', 3);
    const p3 = makeBasetempSession(pytestOf, 'pytest-3', 4);
    if (!trySymlinkDir(p0, join(pytestOf, 'pytest-current'))) {
      t.skip('directory symlinks unavailable on this host (see trySymlinkDir)');
      return;
    }

    const result = prune({ basetempRoot: root, basetempPlatform: 'linux' });

    assert.equal(
      existsSync(p0),
      true,
      'pytest-current target survives even though it is the oldest',
    );
    assert.equal(existsSync(p1), false, 'neither newest-2 nor the current target — reaped');
    assert.equal(existsSync(p2), true, 'one of the two newest');
    assert.equal(existsSync(p3), true, 'the newest');

    const basetempRoots = result.roots.filter((r) => r.label.startsWith('basetemp:'));
    assert.equal(basetempRoots.length, 1);
    assert.equal(basetempRoots[0].label, `basetemp:pytest-of-someuser`);
    assert.equal(basetempRoots[0].deleted.length, 1);
    assert.ok(basetempRoots[0].freedBytes > 0);
    assert.ok(result.freedBytes >= basetempRoots[0].freedBytes);
    assert.ok(result.deletedCount >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prune (basetempRoot): skips ENTIRELY on win32 — nothing read, nothing deleted', () => {
  const root = mkdtempSync(join(tmpdir(), 'disk-headroom-basetemp-win32-'));
  try {
    const pytestOf = join(root, 'pytest-of-someuser');
    const p0 = makeBasetempSession(pytestOf, 'pytest-0', 1);
    const p1 = makeBasetempSession(pytestOf, 'pytest-1', 2);
    const p2 = makeBasetempSession(pytestOf, 'pytest-2', 3);

    const result = prune({ basetempRoot: root, basetempPlatform: 'win32' });

    assert.equal(existsSync(p0), true);
    assert.equal(existsSync(p1), true);
    assert.equal(existsSync(p2), true);
    assert.equal(
      result.roots.some((r) => r.label.startsWith('basetemp:')),
      false,
      'no basetemp root is even reported on win32',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prune (basetempRoot): a missing/nonexistent basetemp root is a silent no-op, never a throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'disk-headroom-basetemp-missing-'));
  try {
    const missing = join(root, 'does-not-exist');
    assert.doesNotThrow(() => prune({ basetempRoot: missing, basetempPlatform: 'linux' }));
    const result = prune({ basetempRoot: missing, basetempPlatform: 'linux' });
    assert.equal(
      result.roots.some((r) => r.label.startsWith('basetemp:')),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prune (basetempRoot): a `pytest-of-*` root with no `pytest-current` symlink still keeps the newest two and reaps the rest', () => {
  const root = mkdtempSync(join(tmpdir(), 'disk-headroom-basetemp-nocurrent-'));
  try {
    const pytestOf = join(root, 'pytest-of-someuser');
    const p0 = makeBasetempSession(pytestOf, 'pytest-0', 1);
    const p1 = makeBasetempSession(pytestOf, 'pytest-1', 2);
    const p2 = makeBasetempSession(pytestOf, 'pytest-2', 3);

    assert.doesNotThrow(() => prune({ basetempRoot: root, basetempPlatform: 'linux' }));
    const result = prune({ basetempRoot: root, basetempPlatform: 'linux' });
    assert.equal(existsSync(p0), false);
    assert.equal(existsSync(p1), true, 'one of the two newest — kept even with no pytest-current');
    assert.equal(existsSync(p2), true, 'the newest — kept');
    assert.ok(result.deletedCount >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prune (basetempRoot): a non-pytest-<n> entry under pytest-of-* (a stray file, an unrelated dir) is left alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'disk-headroom-basetemp-stray-'));
  try {
    const pytestOf = join(root, 'pytest-of-someuser');
    makeBasetempSession(pytestOf, 'pytest-0', 1);
    makeBasetempSession(pytestOf, 'pytest-1', 2);
    makeBasetempSession(pytestOf, 'pytest-2', 3);
    const strayFile = join(pytestOf, 'not-a-session.txt');
    writeFileSync(strayFile, 'unrelated\n');
    const strayDir = join(pytestOf, 'some-other-tool-dir');
    mkdirSync(strayDir, { recursive: true });
    writeFileSync(join(strayDir, 'x.txt'), 'x\n');

    prune({ basetempRoot: root, basetempPlatform: 'linux' });

    assert.equal(existsSync(strayFile), true, "a stray file is never this sweep's to delete");
    assert.equal(
      existsSync(strayDir),
      true,
      "a non-pytest-<n> directory is never this sweep's to delete",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune (basetempRoot + mainCheckoutPath together): the two sweeps are independent — neither touches the other's tree, and results aggregate", () => {
  const mainRoot = mkdtempSync(join(tmpdir(), 'disk-headroom-basetemp-and-main-'));
  const basetempRoot = mkdtempSync(join(tmpdir(), 'disk-headroom-basetemp-and-main-tmp-'));
  try {
    mkdirSync(join(mainRoot, '.next'), { recursive: true });
    writeFileSync(join(mainRoot, '.next', 'BUILD_ID'), 'x'.repeat(1000));
    const pytestOf = join(basetempRoot, 'pytest-of-someuser');
    const p0 = makeBasetempSession(pytestOf, 'pytest-0', 1);
    makeBasetempSession(pytestOf, 'pytest-1', 2);
    makeBasetempSession(pytestOf, 'pytest-2', 3);

    const result = prune({
      mainCheckoutPath: mainRoot,
      basetempRoot,
      basetempPlatform: 'linux',
    });

    assert.equal(existsSync(join(mainRoot, '.next')), false, 'main checkout still pruned as usual');
    assert.equal(existsSync(p0), false, 'basetemp sweep still ran alongside it');
    const labels = result.roots.map((r) => r.label).sort();
    assert.deepEqual(labels, ['basetemp:pytest-of-someuser', 'main']);
  } finally {
    rmSync(mainRoot, { recursive: true, force: true });
    rmSync(basetempRoot, { recursive: true, force: true });
  }
});
