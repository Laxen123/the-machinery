// scripts/sweep-deferred-worktrees.test.mjs (plan 2218)
// The sweep's safety invariants are the point of these tests: containment, the
// age-discriminated registered-husk handling (RECREATED=LIVE), the unknown=skip
// fail-safes, the merge-on-rewrite concurrency behavior, and the one-attempt-no-storm
// marker lifecycle. Removal is injected (rmSync) so no test spawns git/pwsh/cmd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  markerPath,
  recordDeferredRemoval,
  readDeferredEntries,
  sweepDeferredWorktrees,
  describePrunableHusk,
  describeBranchLeft,
} from './sweep-deferred-worktrees.mjs';

function freshMain() {
  const main = mkdtempSync(join(tmpdir(), 'sweep-deferred-'));
  mkdirSync(join(main, '.claude', 'worktrees'), { recursive: true });
  return main;
}
const rmMain = (main) => rmSync(main, { recursive: true, force: true });
const injectedRm = (d) => rmSync(d, { recursive: true, force: true });
const noopRm = () => {};
// registered-husk seams
const gitRmReal = (_main, d) => rmSync(d, { recursive: true, force: true });
const gitRmNoop = () => {};

test('recordDeferredRemoval appends a marker entry readDeferredEntries roundtrips', () => {
  const main = freshMain();
  try {
    const e = recordDeferredRemoval(main, {
      dir: join(main, '.claude', 'worktrees', 'wt-a'),
      slug: 'plan-a',
      branch: 'worktree-plan-a',
    });
    assert.equal(e.attempts, 0);
    assert.ok(e.ts);
    assert.ok(existsSync(markerPath(main)));
    const entries = readDeferredEntries(main);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].slug, 'plan-a');
    assert.equal(entries[0].ts, e.ts, 'the written line carries the returned ts');
    assert.equal(entries[0].dir, resolve(join(main, '.claude', 'worktrees', 'wt-a')));
    assert.equal(entries[0].reason, 'locked-tree teardown defer (plan 2218)');
  } finally {
    rmMain(main);
  }
});

test('readDeferredEntries dedupes by dir (max attempts kept) and skips corrupt lines', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-b');
    recordDeferredRemoval(main, { dir, slug: 'plan-b' });
    // a later sweep rewrote the same dir with attempts=2, then a torn append corrupted a line
    const dup = JSON.stringify({ ts: '2026-07-21T00:00:00Z', dir, attempts: 2 });
    writeFileSync(markerPath(main), readFileSync(markerPath(main), 'utf8') + dup + '\n{torn\n', {
      flag: 'w',
    });
    const entries = readDeferredEntries(main);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].attempts, 2);
  } finally {
    rmMain(main);
  }
});

test('sweep with no marker is a pure no-op', () => {
  const main = freshMain();
  try {
    const res = sweepDeferredWorktrees(main, { registeredDirs: [], remove: noopRm });
    assert.deepEqual(res, { swept: [], kept: [], dropped: [], prunable: [], branches: [] });
  } finally {
    rmMain(main);
  }
});

test('sweep removes an existing unregistered dir and unlinks the drained marker', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-c');
    mkdirSync(dir, { recursive: true });
    recordDeferredRemoval(main, { dir, slug: 'plan-c' });
    const res = sweepDeferredWorktrees(main, { registeredDirs: [], remove: injectedRm });
    assert.equal(res.swept.length, 1);
    assert.equal(res.kept.length, 0);
    assert.ok(!existsSync(dir));
    assert.ok(!existsSync(markerPath(main)), 'a fully-drained marker file is removed');
  } finally {
    rmMain(main);
  }
});

test('an already-gone dir is dropped without a removal attempt', () => {
  const main = freshMain();
  try {
    recordDeferredRemoval(main, { dir: join(main, '.claude', 'worktrees', 'wt-gone') });
    let attempts = 0;
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      remove: () => {
        attempts++;
      },
    });
    assert.equal(attempts, 0);
    assert.equal(res.dropped.length, 1);
    assert.equal(res.dropped[0].why, 'already-gone');
  } finally {
    rmMain(main);
  }
});

test('CONTAINMENT: an entry outside .claude/worktrees is refused and never removed', () => {
  const main = freshMain();
  try {
    const outside = join(main, 'precious');
    mkdirSync(outside, { recursive: true });
    recordDeferredRemoval(main, { dir: outside });
    let attempts = 0;
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      remove: () => {
        attempts++;
      },
      gitRemove: gitRmNoop,
    });
    assert.equal(attempts, 0, 'the remover must never be called for an out-of-root dir');
    assert.ok(existsSync(outside), 'the dir is untouched');
    assert.equal(res.dropped.length, 1);
    assert.match(res.dropped[0].why, /outside-worktrees-root/);
  } finally {
    rmMain(main);
  }
});

test('RECREATED=LIVE: a registered dir newer than its entry is dropped moot, untouched', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-recut');
    mkdirSync(dir, { recursive: true });
    const e = recordDeferredRemoval(main, { dir });
    let attempts = 0;
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [dir],
      remove: () => {
        attempts++;
      },
      gitRemove: () => {
        attempts++;
      },
      birthtimeOf: () => Date.parse(e.ts) + 60_000, // created a minute AFTER the deferral
    });
    assert.equal(attempts, 0, 'a live (re-created) tree is never touched');
    assert.ok(existsSync(dir));
    assert.equal(res.dropped.length, 1);
    assert.match(res.dropped[0].why, /recreated since deferral/);
  } finally {
    rmMain(main);
  }
});

test('registered HUSK (older than its entry) is removed via the git primitive', () => {
  // The common deferred case: the failed `git worktree remove` left the admin entry, so
  // the dir is still registered — it must be swept via git, not dropped as "live".
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-husk');
    mkdirSync(dir, { recursive: true });
    const e = recordDeferredRemoval(main, { dir });
    let forcedRemoves = 0;
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [dir],
      remove: () => {
        forcedRemoves++; // must NOT be used for a registered dir
      },
      gitRemove: gitRmReal,
      birthtimeOf: () => Date.parse(e.ts) - 60_000, // predates the deferral → same old tree
    });
    assert.equal(forcedRemoves, 0, 'registered husks go through git worktree remove only');
    assert.equal(res.swept.length, 1);
    assert.ok(!existsSync(dir));
    assert.ok(!existsSync(markerPath(main)));
  } finally {
    rmMain(main);
  }
});

test('registered husk still locked: kept with attempts+1, ONE git attempt', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-husk-locked');
    mkdirSync(dir, { recursive: true });
    const e = recordDeferredRemoval(main, { dir });
    let gitAttempts = 0;
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [dir],
      remove: noopRm,
      gitRemove: () => {
        gitAttempts++; // locked: the git remove runs but the dir survives
      },
      birthtimeOf: () => Date.parse(e.ts) - 60_000,
      now: () => '2026-07-21T12:00:00.000Z',
    });
    assert.equal(gitAttempts, 1, 'exactly one attempt per entry per invocation — no storm');
    assert.equal(res.kept.length, 1);
    assert.equal(res.kept[0].attempts, 1);
    assert.equal(res.kept[0].lastAttemptAt, '2026-07-21T12:00:00.000Z');
    const persisted = readDeferredEntries(main);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].attempts, 1);
  } finally {
    rmMain(main);
  }
});

test('UNKNOWN age on a registered dir: kept untouched, no attempt', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-noage');
    mkdirSync(dir, { recursive: true });
    recordDeferredRemoval(main, { dir });
    let attempts = 0;
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [dir],
      remove: () => {
        attempts++;
      },
      gitRemove: () => {
        attempts++;
      },
      birthtimeOf: () => null,
    });
    assert.equal(attempts, 0);
    assert.ok(existsSync(dir));
    assert.equal(res.kept.length, 1);
    assert.equal(res.kept[0].attempts, 0, 'no attempt was made, so none is counted');
  } finally {
    rmMain(main);
  }
});

test('a still-locked unregistered dir is kept with attempts+1 — ONE attempt', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-locked');
    mkdirSync(dir, { recursive: true });
    recordDeferredRemoval(main, { dir, slug: 'plan-l' });
    let attempts = 0;
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      remove: () => {
        attempts++; // simulate a locked tree: the remover runs but the dir survives
      },
      now: () => '2026-07-21T12:00:00.000Z',
    });
    assert.equal(attempts, 1, 'exactly one attempt per entry per invocation — no storm');
    assert.equal(res.kept.length, 1);
    assert.equal(res.kept[0].attempts, 1);
    assert.equal(res.kept[0].lastAttemptAt, '2026-07-21T12:00:00.000Z');
  } finally {
    rmMain(main);
  }
});

test('MERGE-ON-REWRITE: a concurrent append recorded mid-sweep survives the rewrite', () => {
  const main = freshMain();
  try {
    const mine = join(main, '.claude', 'worktrees', 'wt-mine');
    const theirs = join(main, '.claude', 'worktrees', 'wt-theirs');
    mkdirSync(mine, { recursive: true });
    recordDeferredRemoval(main, { dir: mine, slug: 'plan-mine' });
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      remove: (d) => {
        // another session's teardown appends ITS deferral while this sweep is mid-removal
        recordDeferredRemoval(main, { dir: theirs, slug: 'plan-theirs' });
        rmSync(d, { recursive: true, force: true });
      },
    });
    assert.equal(res.swept.length, 1);
    const persisted = readDeferredEntries(main);
    assert.equal(persisted.length, 1, "the concurrent session's entry survived the rewrite");
    assert.equal(persisted[0].slug, 'plan-theirs');
  } finally {
    rmMain(main);
  }
});

test('UNKNOWN=SKIP: when the registered listing fails, nothing is removed or rewritten', () => {
  // mainDir is not a git repo, so the default `git worktree list` probe fails → the
  // sweep must keep every entry untouched rather than delete blind.
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-unknown');
    mkdirSync(dir, { recursive: true });
    recordDeferredRemoval(main, { dir });
    const before = readFileSync(markerPath(main), 'utf8');
    const res = sweepDeferredWorktrees(main, { remove: injectedRm });
    assert.equal(res.swept.length, 0);
    assert.equal(res.kept.length, 1);
    assert.ok(existsSync(dir));
    assert.equal(readFileSync(markerPath(main), 'utf8'), before, 'marker untouched');
  } finally {
    rmMain(main);
  }
});

test('--dry reports without removing or rewriting', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-dry');
    mkdirSync(dir, { recursive: true });
    recordDeferredRemoval(main, { dir });
    let attempts = 0;
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      dry: true,
      remove: () => {
        attempts++;
      },
      gitRemove: () => {
        attempts++;
      },
    });
    assert.equal(attempts, 0);
    assert.equal(res.kept.length, 1);
    assert.ok(existsSync(dir));
    assert.ok(existsSync(markerPath(main)));
  } finally {
    rmMain(main);
  }
});

// --- plan 3092: prunable-husk REPORTING (marker-independent, driven by git's own
// `prunable` judgment via parseWorktreePorcelain). porcelainEntries injects the parsed
// shape directly — same architectural layer as registeredDirs — so no test shells out
// to git/pwsh. The contract these lock down: the scan REPORTS a husk and removes
// NEITHER half of it. Never assert a husk dir was deleted, and never assert its
// registration was pruned: `prunable` only means git cannot follow the `.git` link
// right now, which a LIVE worktree (mid-`worktree add`, mid-teardown, racing mount)
// looks identical to — and this scan sees every sibling session's worktrees on the
// shared `.git`, with `git worktree prune` having no per-path form. Auto-removing
// either half is the cross-session data-loss bug both review rounds caught.

// The one guard that catches a re-introduced auto-prune: `pruneRegistration` is NOT a
// supported opt any more, so a call to it can only happen if someone wires the seam
// back in. Passed to every case below.
const NO_PRUNE = () => assert.fail('the husk scan must never prune a registration');

test('plan 3092: the scan runs with the marker file absent — REPORTS the husk, removes nothing', () => {
  const main = freshMain();
  assert.ok(!existsSync(markerPath(main)), 'freshMain never wrote a marker file');
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-prunable');
    mkdirSync(dir, { recursive: true });
    let removeCalls = 0;
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      porcelainEntries: [
        {
          path: dir,
          prunable: true,
          prunableReason: 'gitdir file points to non-existent location',
        },
      ],
      pruneRegistration: NO_PRUNE,
      remove: () => {
        removeCalls++;
      },
    });
    assert.equal(removeCalls, 0, 'the husk DIRECTORY is never auto-deleted');
    assert.ok(existsSync(dir), 'a prunable dir may be a live worktree that lost its .git');
    assert.equal(res.prunable.length, 1);
    assert.equal(res.prunable[0].dir, dir);
    assert.equal(res.prunable[0].reason, 'gitdir file points to non-existent location');
    assert.equal(res.prunable[0].dirLeft, true, 'reported as wanting a human');
    assert.equal(res.prunable[0].inRoot, true);
  } finally {
    rmMain(main);
  }
});

test('plan 3092: a husk whose dir is already gone is still reported, flagged dirLeft:false', () => {
  const main = freshMain();
  try {
    const gone = join(main, '.claude', 'worktrees', 'wt-already-gone');
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      porcelainEntries: [{ path: gone, prunable: true, prunableReason: 'gitdir missing' }],
      pruneRegistration: NO_PRUNE,
      remove: () => assert.fail('nothing to remove'),
    });
    assert.equal(res.prunable.length, 1, 'the commonest prunable shape is still surfaced');
    assert.equal(res.prunable[0].dirLeft, false, 'nothing left on disk for a human');
  } finally {
    rmMain(main);
  }
});

test('plan 3092: every prunable entry is reported individually — a count is not a report', () => {
  const main = freshMain();
  try {
    const a = join(main, '.claude', 'worktrees', 'wt-p1');
    const b = join(main, '.claude', 'worktrees', 'wt-p2');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      porcelainEntries: [
        { path: a, prunable: true, prunableReason: 'x' },
        { path: b, prunable: true, prunableReason: 'y' },
      ],
      pruneRegistration: NO_PRUNE,
      remove: () => assert.fail('never deletes'),
    });
    assert.deepEqual(
      res.prunable.map((e) => e.dir),
      [a, b],
    );
    assert.ok(existsSync(a) && existsSync(b), 'both dirs untouched');
  } finally {
    rmMain(main);
  }
});

test('plan 3092: a prunable entry OUTSIDE the worktrees root is reported as out-of-root and its dir is untouched', () => {
  const main = freshMain();
  try {
    const outside = join(main, 'precious-prunable');
    mkdirSync(outside, { recursive: true });
    let removeCalls = 0;
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      porcelainEntries: [{ path: outside, prunable: true, prunableReason: 'whatever' }],
      remove: () => {
        removeCalls++;
      },
      pruneRegistration: NO_PRUNE,
    });
    assert.equal(removeCalls, 0, 'no directory removal, in-root or not');
    assert.ok(existsSync(outside), 'the dir is untouched');
    assert.equal(res.prunable.length, 1);
    assert.equal(res.prunable[0].inRoot, false, 'flagged as outside the worktrees root');
  } finally {
    rmMain(main);
  }
});

test('plan 3092: a NON-prunable (live) registered worktree is invisible to the husk scan', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-live');
    mkdirSync(dir, { recursive: true });
    let calls = 0;
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [dir],
      porcelainEntries: [{ path: dir, prunable: false, prunableReason: null }],
      remove: () => {
        calls++;
      },
      pruneRegistration: NO_PRUNE,
    });
    assert.equal(calls, 0, 'no removal — git never flagged this one');
    assert.ok(existsSync(dir));
    assert.equal(res.prunable.length, 0);
  } finally {
    rmMain(main);
  }
});

test('plan 3092: after the marker pass removes anything, the husk scan re-reads git rather than reporting the stale snapshot', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-double');
    mkdirSync(dir, { recursive: true });
    recordDeferredRemoval(main, { dir, slug: 'plan-double' });
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      // unregistered per the marker-driven pass → removed by the marker loop's `remove`.
      // The PRE-cleanup snapshot still lists it, which is the trap: reporting off it
      // would tell the operator to go prune a husk this same invocation just took.
      porcelainEntries: [{ path: dir, prunable: true, prunableReason: 'x' }],
      // git's judgment AFTER the removal: gone.
      porcelainEntriesAfter: [],
      remove: (d) => rmSync(d, { recursive: true, force: true }),
      pruneRegistration: NO_PRUNE,
    });
    assert.equal(res.swept.length, 1, 'the marker-driven pass removed the dir');
    assert.equal(res.prunable.length, 0, 'the re-read shows nothing left to report');
  } finally {
    rmMain(main);
  }
});

test('plan 3092: a registration that SURVIVES its directory removal is still reported (the re-read, not a path filter, decides)', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-survivor');
    mkdirSync(dir, { recursive: true });
    recordDeferredRemoval(main, { dir, slug: 'plan-survivor' });
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      porcelainEntries: [{ path: dir, prunable: true, prunableReason: 'x' }],
      // The raced/locked-prune case: the DIRECTORY went, the admin registration did not.
      // A swept-PATH exclusion would silently hide exactly this — the one shape whose
      // only remaining surface is this report.
      porcelainEntriesAfter: [{ path: dir, prunable: true, prunableReason: 'gitdir missing' }],
      remove: (d) => rmSync(d, { recursive: true, force: true }),
      pruneRegistration: NO_PRUNE,
    });
    assert.equal(res.swept.length, 1, 'the directory was removed');
    assert.equal(res.prunable.length, 1, 'the surviving registration is still surfaced');
    assert.equal(res.prunable[0].dirLeft, false, 'nothing on disk — a prune-only recovery');
  } finally {
    rmMain(main);
  }
});

test('plan 3092: describePrunableHusk carries path + which half stands + an out-of-root warning', () => {
  const inRootGone = describePrunableHusk({
    dir: '/m/.claude/worktrees/a',
    inRoot: true,
    dirLeft: false,
  });
  assert.match(inRootGone, /\/m\/\.claude\/worktrees\/a/);
  assert.match(
    inRootGone,
    /git worktree prune/,
    'the prune action is named for the dir-gone shape',
  );
  assert.ok(!/OUTSIDE/.test(inRootGone), 'no out-of-root warning on an in-root husk');

  const inRootLeft = describePrunableHusk({
    dir: '/m/.claude/worktrees/b',
    inRoot: true,
    dirLeft: true,
  });
  assert.match(inRootLeft, /still on disk/);
  assert.match(inRootLeft, /git worktree prune/, 'the dir-left shape still ends at a prune');

  assert.match(
    inRootLeft,
    /locked/,
    'a prune that leaves the entry is an expected outcome with its own next step',
  );

  const outside = describePrunableHusk({ dir: '/m/precious', inRoot: false, dirLeft: true });
  assert.match(
    outside,
    /OUTSIDE \.claude\/worktrees\//,
    'an out-of-root path is flagged, not silently rendered as ordinary residue',
  );
  assert.ok(
    outside.indexOf('do NOT delete') < outside.indexOf('remove it'),
    'the caveat precedes the instruction it qualifies — an operator acts on what they read first',
  );

  const unverified = describePrunableHusk({
    dir: '/m/.claude/worktrees/c',
    inRoot: true,
    dirLeft: false,
    stale: true,
  });
  assert.match(
    unverified,
    /UNVERIFIED/,
    'a row from a failed post-cleanup re-read is reported as possibly-already-gone, not asserted as residue',
  );
  assert.ok(
    unverified.indexOf('UNVERIFIED') < unverified.indexOf('clear it with'),
    'the staleness caveat precedes the recovery instruction',
  );
  assert.match(outside, /do NOT delete/);
});

test('plan 3092: a marker entry merely DROPPED (not swept) leaves git’s prunable judgment reportable', () => {
  const main = freshMain();
  try {
    const gone = join(main, '.claude', 'worktrees', 'wt-dropped');
    recordDeferredRemoval(main, { dir: gone, slug: 'plan-dropped' });
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      porcelainEntries: [{ path: gone, prunable: true, prunableReason: 'gitdir missing' }],
      remove: () => assert.fail('the dir is already gone — nothing to remove'),
      pruneRegistration: NO_PRUNE,
    });
    assert.equal(res.dropped.length, 1, 'the marker entry drops as already-gone');
    assert.equal(res.swept.length, 0, 'this sweep removed nothing');
    // The DIRECTORY was already gone, but the registration is still standing and still
    // wants a human — only a dir this sweep actually removed is excluded.
    assert.equal(res.prunable.length, 1);
    assert.equal(res.prunable[0].dirLeft, false);
  } finally {
    rmMain(main);
  }
});

test('plan 3092: --dry reports the husk identically — the scan has no mutation to withhold', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-prunable-dry');
    mkdirSync(dir, { recursive: true });
    let calls = 0;
    const opts = {
      registeredDirs: [],
      porcelainEntries: [{ path: dir, prunable: true, prunableReason: 'r' }],
      remove: () => {
        calls++;
      },
      pruneRegistration: NO_PRUNE,
    };
    const wet = sweepDeferredWorktrees(main, opts);
    const dry = sweepDeferredWorktrees(main, { ...opts, dry: true });
    assert.equal(calls, 0);
    assert.ok(existsSync(dir));
    assert.deepEqual(dry.prunable, wet.prunable, '--dry and --wet report the same husk');
    assert.equal(dry.prunable.length, 1, 'still REPORTED under --dry');
    assert.equal(dry.prunable[0].dirLeft, true);
  } finally {
    rmMain(main);
  }
});

// --- plan 3238: the branch-delete retry (fires the instant an entry's DIR problem
// resolves — i.e. it is about to land in `result.swept`). All three git primitives
// (branchExists / branchMergedToOriginMaster / deleteBranch) are injected, so no test
// here ever spawns git — matching the file's existing convention throughout.

test('plan 3238: resolved entry with a merged local branch — the branch is deleted', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-branch-del');
    mkdirSync(dir, { recursive: true });
    recordDeferredRemoval(main, { dir, slug: 'plan-x', branch: 'worktree-plan-x' });
    let stillExists = true;
    let deleteCalls = 0;
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      remove: injectedRm,
      branchExists: () => stillExists,
      branchMergedToOriginMaster: (m, branch) => {
        assert.equal(branch, 'worktree-plan-x');
        return true;
      },
      deleteBranch: (m, branch) => {
        assert.equal(branch, 'worktree-plan-x');
        deleteCalls++;
        stillExists = false; // simulate the delete actually taking
      },
    });
    assert.equal(res.swept.length, 1, 'the dir problem resolved');
    assert.equal(deleteCalls, 1, 'the branch delete was retried exactly once');
    assert.equal(res.branches.length, 1);
    assert.equal(res.branches[0].branch, 'worktree-plan-x');
    assert.equal(res.branches[0].deleted, true);
    assert.equal(res.branches[0].why, undefined, 'no reason recorded on a clean delete');
  } finally {
    rmMain(main);
  }
});

test('plan 3238: the retry also fires on the registered-husk gitRemove success path', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-husk-branch');
    mkdirSync(dir, { recursive: true });
    const e = recordDeferredRemoval(main, { dir, slug: 'plan-h', branch: 'worktree-plan-h' });
    let stillExists = true;
    let deleteCalls = 0;
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [dir],
      remove: () => assert.fail('registered husks go through gitRemove only'),
      gitRemove: gitRmReal,
      birthtimeOf: () => Date.parse(e.ts) - 60_000, // predates the deferral → the same old husk
      branchExists: () => stillExists,
      branchMergedToOriginMaster: () => true,
      deleteBranch: () => {
        deleteCalls++;
        stillExists = false; // simulate the delete actually taking
      },
    });
    assert.equal(res.swept.length, 1);
    assert.equal(deleteCalls, 1);
    assert.equal(res.branches.length, 1);
    assert.equal(res.branches[0].deleted, true);
  } finally {
    rmMain(main);
  }
});

// The regression guard for the plan-3238 review finding. Every other case here passes
// `registeredDirs` explicitly, which leaves `porcelainEntries` defaulted to `[]` and so
// DECOUPLES the dir-liveness set from the (dir, branch) pairs the branch guard reads. In
// production they are the SAME pre-loop porcelain snapshot, which means a registered husk's
// own row — carrying its own branch — is still in it when its dir is removed mid-loop. A
// bare branch-name membership test therefore self-blocked the husk on its own stale row and
// reported `checked out in a live registered worktree` for a worktree this very invocation
// had just deleted, silently defeating the locked-tree case the whole plan exists for. This
// test drives the coupled path (porcelainEntries only, no registeredDirs) and asserts the
// branch is actually deleted.
test('plan 3238: a registered husk does NOT self-block on its own pre-removal porcelain row', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-self-block');
    mkdirSync(dir, { recursive: true });
    const e = recordDeferredRemoval(main, { dir, slug: 'plan-s', branch: 'worktree-plan-s' });
    let stillExists = true;
    let deleteCalls = 0;
    const res = sweepDeferredWorktrees(main, {
      // NO registeredDirs — exactly the production shape: one porcelain read drives both the
      // isRegistered judgment AND the branch guard, and it lists this husk on its branch.
      porcelainEntries: [{ path: dir, branch: 'worktree-plan-s', prunable: false }],
      porcelainEntriesAfter: [], // gitRemove cleared dir + registration together
      remove: () => assert.fail('registered husks go through gitRemove only'),
      gitRemove: gitRmReal,
      birthtimeOf: () => Date.parse(e.ts) - 60_000, // predates the deferral → the old husk
      branchExists: () => stillExists,
      branchMergedToOriginMaster: () => true,
      deleteBranch: () => {
        deleteCalls++;
        stillExists = false;
      },
    });
    assert.equal(res.swept.length, 1, 'the husk dir + registration were removed');
    assert.equal(res.branches.length, 1);
    assert.equal(
      res.branches[0].deleted,
      true,
      'the entry’s OWN registration must not count as "checked out elsewhere"',
    );
    assert.equal(deleteCalls, 1);
  } finally {
    rmMain(main);
  }
});

test('plan 3238: a branch checked out in a live REGISTERED worktree is left, no error', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-branch-live');
    mkdirSync(dir, { recursive: true });
    recordDeferredRemoval(main, { dir, slug: 'plan-y', branch: 'worktree-plan-y' });
    let deleteCalls = 0;
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      // a SIBLING session's live worktree, checked out on the very branch this entry
      // recorded — must never be reached for, even though it lives at a different path.
      porcelainEntries: [
        {
          path: join(main, '.claude', 'worktrees', 'wt-sibling-session'),
          branch: 'worktree-plan-y',
          prunable: false,
        },
      ],
      remove: injectedRm,
      branchExists: () => true,
      branchMergedToOriginMaster: () => {
        assert.fail('a checked-out branch must never even reach the merged-ness check');
      },
      deleteBranch: () => {
        deleteCalls++;
      },
    });
    assert.equal(res.swept.length, 1, 'the dir problem still resolves independently');
    assert.equal(deleteCalls, 0, 'never attempt to delete a branch checked out elsewhere');
    assert.equal(res.branches.length, 1);
    assert.equal(res.branches[0].deleted, false);
    assert.match(res.branches[0].why, /checked out in a live registered worktree/);
  } finally {
    rmMain(main);
  }
});

// The other half of the same fix: excluding the entry's OWN row must be by PATH, not a
// blanket "ignore this branch". If a sibling worktree is ALSO on that branch, the guard has
// to keep firing even though the entry's own row is present in the very same snapshot.
test('plan 3238: own-row exclusion is path-scoped — a sibling on the same branch still blocks', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-both');
    const sibling = join(main, '.claude', 'worktrees', 'wt-both-sibling');
    mkdirSync(dir, { recursive: true });
    const e = recordDeferredRemoval(main, { dir, slug: 'plan-b', branch: 'worktree-plan-b' });
    let deleteCalls = 0;
    const res = sweepDeferredWorktrees(main, {
      porcelainEntries: [
        { path: dir, branch: 'worktree-plan-b', prunable: false }, // the entry's own row
        { path: sibling, branch: 'worktree-plan-b', prunable: false }, // a LIVE sibling
      ],
      porcelainEntriesAfter: [{ path: sibling, branch: 'worktree-plan-b', prunable: false }],
      remove: () => assert.fail('registered husks go through gitRemove only'),
      gitRemove: gitRmReal,
      birthtimeOf: () => Date.parse(e.ts) - 60_000,
      branchExists: () => true,
      branchMergedToOriginMaster: () => {
        assert.fail('a branch live in a sibling worktree must not reach the merged-ness check');
      },
      deleteBranch: () => {
        deleteCalls++;
      },
    });
    assert.equal(res.swept.length, 1, 'the dir problem still resolves');
    assert.equal(deleteCalls, 0, 'the sibling’s checkout still protects the branch');
    assert.equal(res.branches[0].deleted, false);
    assert.match(res.branches[0].why, /checked out in a live registered worktree/);
  } finally {
    rmMain(main);
  }
});

test('plan 3238: a branch NOT an ancestor of local origin/master is left, never force-deleted', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-branch-unmerged');
    mkdirSync(dir, { recursive: true });
    recordDeferredRemoval(main, { dir, slug: 'plan-z', branch: 'worktree-plan-z' });
    let deleteCalls = 0;
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      remove: injectedRm,
      branchExists: () => true,
      branchMergedToOriginMaster: () => false,
      deleteBranch: () => {
        deleteCalls++;
      },
    });
    assert.equal(deleteCalls, 0, '-D is never reached for once mergedness is unproven');
    assert.equal(res.branches.length, 1);
    assert.equal(res.branches[0].deleted, false);
    assert.match(res.branches[0].why, /not an ancestor of local origin\/master/);
  } finally {
    rmMain(main);
  }
});

test('plan 3238: an entry with branch: null is a pure no-op for the branch retry', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-branch-null');
    mkdirSync(dir, { recursive: true });
    recordDeferredRemoval(main, { dir, slug: 'plan-n' }); // branch defaults to null
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      remove: injectedRm,
      branchExists: () => assert.fail('must not even probe for a null branch'),
      deleteBranch: () => assert.fail('must not attempt a delete'),
    });
    assert.equal(res.swept.length, 1);
    assert.equal(res.branches.length, 0, 'nothing worth reporting for a true no-op');
  } finally {
    rmMain(main);
  }
});

test('plan 3238: a branch that no longer exists locally is a no-op, not reported', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-branch-gone');
    mkdirSync(dir, { recursive: true });
    recordDeferredRemoval(main, { dir, slug: 'plan-g', branch: 'worktree-plan-g' });
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      remove: injectedRm,
      branchExists: () => false,
      branchMergedToOriginMaster: () => assert.fail('never reached once the branch is gone'),
      deleteBranch: () => assert.fail('never reached once the branch is gone'),
    });
    assert.equal(res.swept.length, 1);
    assert.equal(res.branches.length, 0);
  } finally {
    rmMain(main);
  }
});

test('plan 3238: a delete that throws is SOFT — entry still drops from the marker, reported as left', () => {
  const main = freshMain();
  try {
    const dir = join(main, '.claude', 'worktrees', 'wt-branch-throws');
    mkdirSync(dir, { recursive: true });
    recordDeferredRemoval(main, { dir, slug: 'plan-t', branch: 'worktree-plan-t' });
    const res = sweepDeferredWorktrees(main, {
      registeredDirs: [],
      remove: injectedRm,
      branchExists: () => true, // still there before AND after — the delete never actually took
      branchMergedToOriginMaster: () => true,
      deleteBranch: () => {
        throw new Error('boom');
      },
    });
    assert.equal(res.swept.length, 1, 'the DIR problem is still resolved');
    assert.equal(res.kept.length, 0, 'never re-deferred just because the branch survived');
    assert.ok(
      !existsSync(markerPath(main)),
      'a fully-drained marker file is removed — the branch failure does not re-add the entry',
    );
    assert.equal(res.branches.length, 1);
    assert.equal(res.branches[0].deleted, false);
    assert.match(res.branches[0].why, /delete refused or failed/);
  } finally {
    rmMain(main);
  }
});

test('plan 3238: describeBranchLeft names the branch, the reason, and the audit backstop', () => {
  const s = describeBranchLeft({
    branch: 'worktree-plan-q',
    why: 'not an ancestor of local origin/master',
  });
  assert.match(s, /worktree-plan-q/);
  assert.match(s, /not an ancestor of local origin\/master/);
  assert.match(s, /reconcile-worktree-branches\.mjs/);
});
