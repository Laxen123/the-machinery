// scripts/land-lib.test.mjs (plan 355)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  chmodSync,
  rmSync,
  readdirSync,
  utimesSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import {
  landBranchViaEphemeral,
  landBranchViaCheckout,
  mergeBranchToMaster,
  syncBranchOntoMaster,
  classifyAheadRangeDiff,
  inspectRebasedUnpushed,
  recoverRebasedUnpushed,
  attributeConflict,
  formatConflictCulprits,
  unmergedPathsFromPorcelain,
  assertLandable,
  classifyAheadCommit,
  landDirBaseFor,
  worktreeBranchAt,
  worktreeEntryAt,
  reclaimLandDirIfSafe,
  registrationAdminDirFor,
  registrationIdleMs,
  sweepDeadLandRegistrations,
  worktreeAddCollisionFallback,
  rangePatchIdOnce,
  graftedForeignCommits,
  GraftCheckError,
  run,
  fetchOriginBeforePatchId,
  rangePatchIdOnceWithFetch,
  PATCH_ID_FETCH_TIMEOUT_MS,
  PATCH_ID_FETCH_REF,
  PATCH_ID_FETCH_REMOTE,
  PATCH_ID_FETCH_BRANCH,
  classifyPushFailure,
  isRetryablePushFailure,
  assertExpectedBranchTip,
  branchAlreadyLanded,
  spineRebaseMarkerPath,
  readSpineRebaseMarker,
  rebaseStateKnownAbsent,
  mutationKnownAbsent,
} from './land-lib.mjs';
import { indexLockPath } from './coord-git.mjs';
import { classifyAllowlist } from './main-checkout-allowlist.mjs';
import { sandbox } from '../_land-sandbox.mjs';
import { makeNoRepoRoot } from '../test-helpers/no-repo-root.mjs';

// capture the thrown Error (assert.throws returns undefined, not the error)
function caught(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new assert.AssertionError({ message: 'expected fn to throw, but it did not' });
}

// plan 1573: landDirBaseFor caps the ephemeral land checkout's DIRECTORY basename at 40 chars
// (mirrors the plan-909 cut-worktree convention) — a long branch name plus a deep committed
// path (backend/data/data-pipeline/render-store/…) exceeded Windows MAX_PATH (260) on an
// untruncated `_land-<branch>` dir (session 1436 incident). The BRANCH itself is never
// truncated — only the throwaway directory name.
test('landDirBaseFor: short branch names are unchanged', () => {
  assert.equal(landDirBaseFor('worktree-909-Infra-foo'), '_land-worktree-909-Infra-foo');
});

test('landDirBaseFor: the plan-1573 incident branch (session 1436, 2026-07-07) is truncated to 40 chars', () => {
  const longBranch = 'worktree-1559-FABLE-Infra-orchestrated-execution-skill-missing';
  const base = landDirBaseFor(longBranch);
  assert.ok(base.length <= 40, `basename must be ≤40 chars, got ${base.length}: ${base}`);
  assert.equal(base, `_land-${longBranch}`.slice(0, 40).replace(/-+$/, ''));
});

// plan 1573 "Done when": a 63-char SLUG (branch = `worktree-<63-char slug>`, 72 chars total)
// must not overflow MAX_LAND_DIR_SLUG.
test('landDirBaseFor: a 63-char slug (plan 1573 "Done when") is capped at 40 chars', () => {
  const slug63 = '1573-Infra-done-worktree-land-ephemeral-maxpath-extra-padding-x'.slice(0, 63);
  assert.equal(slug63.length, 63);
  const branch = `worktree-${slug63}`;
  const base = landDirBaseFor(branch);
  assert.ok(base.length <= 40, `basename must be ≤40 chars, got ${base.length}: ${base}`);
  assert.ok(base.startsWith('_land-worktree-1573-'), `plan ID preserved: ${base}`);
});

test('landDirBaseFor: a clip ending mid-hyphen carries no trailing dash', () => {
  // `_land-` (6) + this branch's first 34 chars ends on a hyphen boundary.
  const branch = 'worktree-1286-Infra-main-checkout-mutex-heal-and-coord-write-isolation';
  const base = landDirBaseFor(branch);
  assert.ok(!base.endsWith('-'), `no trailing hyphen: ${base}`);
});

test('landDirBaseFor: truncation keeps the plan ID prefix — uniqueness preserved', () => {
  const branch = 'worktree-903-DQ-halsokontroll-lowconf-variant-display-floor-and-misextract-sweep';
  const base = landDirBaseFor(branch);
  assert.ok(base.startsWith('_land-worktree-903-'), `plan ID preserved: ${base}`);
});

test('landDirBaseFor: collided:true appends a short hash and stays within the 40-char budget', () => {
  const branch = 'worktree-1559-FABLE-Infra-orchestrated-execution-skill-missing';
  const plain = landDirBaseFor(branch);
  const collided = landDirBaseFor(branch, true);
  assert.notEqual(collided, plain, 'collision fallback must differ from the plain truncation');
  assert.ok(collided.length <= 40, `hashed basename must be ≤40 chars: ${collided}`);
  assert.match(collided, /-[0-9a-f]{8}$/, 'collision fallback ends with an 8-hex-char hash');
  // deterministic — same branch always yields the same hash suffix
  assert.equal(landDirBaseFor(branch, true), collided);
});

test('lands a branch onto origin/master without touching MAIN working tree', () => {
  const s = sandbox();
  // a feature branch on origin (as pickup-plan would push it)
  s.g(s.main, ['checkout', '-b', 'worktree-x', 'origin/master']);
  writeFileSync(join(s.main, 'b.txt'), 'feature\n');
  s.g(s.main, ['add', 'b.txt']);
  s.g(s.main, ['commit', '-m', 'feat b']);
  s.g(s.main, ['push', 'origin', 'worktree-x']);
  s.g(s.main, ['checkout', 'master']);
  // dirty the MAIN working tree with FOREIGN uncommitted content (the wedge trigger)
  writeFileSync(join(s.main, 'a.txt'), 'LOCAL FOREIGN DIRT\n');

  const sha = landBranchViaEphemeral(s.main, 'worktree-x', 'done x');

  // origin/master advanced and contains the merge of the feature file
  s.g(s.main, ['fetch', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), sha);
  assert.match(s.g(s.main, ['log', 'origin/master', '--oneline']), /Merge worktree-x/);
  // MAIN's foreign dirt is untouched — NO autostash, NO conflict
  assert.equal(readFileSync(join(s.main, 'a.txt'), 'utf8'), 'LOCAL FOREIGN DIRT\n');
  assert.equal(s.g(s.main, ['status', '--porcelain']).includes('UU'), false);
});

// plan 2466: the point of the swap is that the median land checks NOTHING out. A land that
// quietly fell back to the checkout path would still be correct and still return a sha — and
// would still pass every other test in this file — so the absence of a checkout is asserted
// directly, not inferred from wall-clock.
test('plan 2466: a clean land creates NO ephemeral worktree (object-db fast path, not the checkout)', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-fast', 'origin/master']);
  writeFileSync(join(s.main, 'fast.txt'), 'feature\n');
  s.g(s.main, ['add', 'fast.txt']);
  s.g(s.main, ['commit', '-m', 'feat fast']);
  s.g(s.main, ['push', 'origin', 'worktree-fast']);
  s.g(s.main, ['checkout', 'master']);

  const before = s.g(s.main, ['worktree', 'list', '--porcelain']);
  const sha = landBranchViaEphemeral(s.main, 'worktree-fast', 'done fast');
  const after = s.g(s.main, ['worktree', 'list', '--porcelain']);

  assert.equal(after, before, 'no worktree was registered or left behind by a clean land');
  assert.equal(
    existsSync(join(s.main, '.claude', 'worktrees')),
    false,
    'the fast path must not even create the ephemeral worktrees directory',
  );

  // …and it is a REAL land: a genuine two-parent merge commit on origin/master.
  s.g(s.main, ['fetch', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), sha);
  assert.match(s.g(s.main, ['log', 'origin/master', '--oneline']), /Merge worktree-fast/);
  assert.equal(
    s.g(s.main, ['rev-list', '--parents', '-n', '1', sha]).trim().split(/\s+/).length,
    3,
    'the fast-path commit must have exactly two parents (a real merge, not a fast-forward)',
  );
  // parent ORDER is load-bearing for `log --first-parent` and conflict attribution
  assert.equal(
    s.g(s.main, ['rev-parse', `${sha}^1`]),
    s.g(s.main, ['rev-parse', 'origin/master~1']),
  );
  assert.equal(
    s.g(s.main, ['rev-parse', `${sha}^2`]),
    s.g(s.main, ['rev-parse', 'origin/worktree-fast']),
  );
});

// review fix (/sonnet-review xhigh, CONFIRMED TOCTOU): the fast path must PIN the branch tip for
// the whole retry sequence. The push is --no-verify, justified (plan 768) by "the branch's own
// push already ran the FULL hook on identical content" — true only of the tip that was reviewed
// and queued. If a non-ff retry re-resolved origin/<branch>, a commit pushed to the branch mid-land
// would be picked up and landed hook-unverified and unreviewed.
test('plan 2466: a non-ff retry lands the PINNED branch tip, never a newer one pushed mid-land', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-q', '-b', 'worktree-pin', 'origin/master']);
  writeFileSync(join(s.main, 'pinned.txt'), 'reviewed content\n');
  s.g(s.main, ['add', '-A']);
  s.g(s.main, ['commit', '-q', '-m', 'the REVIEWED commit']);
  s.g(s.main, ['push', '-q', 'origin', 'worktree-pin']);
  const pinnedTip = s.g(s.main, ['rev-parse', 'HEAD']);
  s.g(s.main, ['checkout', '-q', 'master']);

  // Lose the first push race AND, in the same moment, push an UNREVIEWED commit to the branch —
  // exactly the interleaving the review described.
  let fired = false;
  const sha = landBranchViaEphemeral(s.main, 'worktree-pin', 'done pin', {
    _injectRaceOnce: (originUrl) => {
      fired = true;
      const sib = mkdtempSync(join(tmpdir(), 'sibling-'));
      execFileSync('git', ['clone', '-q', originUrl, sib]);
      execFileSync('git', ['-C', sib, 'config', 'user.email', 't@t']);
      execFileSync('git', ['-C', sib, 'config', 'user.name', 't']);
      // (a) a sibling advances master → our push is rejected non-ff → we retry
      writeFileSync(join(sib, 'sibling.txt'), 'sibling\n');
      execFileSync('git', ['-C', sib, 'add', '-A']);
      execFileSync('git', ['-C', sib, 'commit', '-q', '-m', 'sibling land']);
      execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
      // (b) the worktree session pushes an UNREVIEWED commit onto the branch mid-land
      execFileSync('git', ['-C', sib, 'checkout', '-q', '-b', 'wp', 'origin/worktree-pin']);
      writeFileSync(join(sib, 'unreviewed.txt'), 'NOT reviewed, NOT hook-verified\n');
      execFileSync('git', ['-C', sib, 'add', '-A']);
      execFileSync('git', ['-C', sib, 'commit', '-q', '-m', 'UNREVIEWED commit']);
      execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'wp:worktree-pin']);
    },
  });

  assert.ok(fired, 'the race seam must have fired, otherwise this proves nothing');
  s.g(s.main, ['fetch', '-q', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), sha, 'the land succeeded after retry');
  // the merge's second parent is the tip we PINNED, not the tip the branch has now
  assert.equal(
    s.g(s.main, ['rev-parse', `${sha}^2`]),
    pinnedTip,
    'second parent is the pinned tip',
  );
  assert.notEqual(
    s.g(s.main, ['rev-parse', 'origin/worktree-pin']),
    pinnedTip,
    'sanity: the branch really did move during the land',
  );
  // the unreviewed content must NOT be on master
  assert.equal(
    s.g(s.main, ['ls-tree', '-r', '--name-only', sha]).includes('unreviewed.txt'),
    false,
    'a commit pushed to the branch mid-land must never reach master',
  );
});

// plan 2466: `git merge --no-ff` refuses to commit when the branch is already an ancestor
// ("Already up to date."), so the old path pushed a no-op and returned the existing tip.
// merge-tree has no such signal — without the short-circuit, commit-tree would seal a merge
// commit whose second parent contributes nothing and ADVANCE master with it. Reachable for real:
// a land re-run after a land whose review/queue marker did not record.
test('plan 2466: a branch already merged into master is a NO-OP — no degenerate merge commit is pushed', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-q', '-b', 'worktree-already', 'origin/master']);
  writeFileSync(join(s.main, 'already.txt'), 'feature\n');
  s.g(s.main, ['add', '-A']);
  s.g(s.main, ['commit', '-q', '-m', 'feat already']);
  s.g(s.main, ['push', '-q', 'origin', 'worktree-already']);
  s.g(s.main, ['checkout', '-q', 'master']);

  // land it once — the normal path
  const first = landBranchViaEphemeral(s.main, 'worktree-already', 'done already');
  s.g(s.main, ['fetch', '-q', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), first);

  // land the SAME branch again: it is now an ancestor of master
  const second = landBranchViaEphemeral(s.main, 'worktree-already', 'done already');
  s.g(s.main, ['fetch', '-q', 'origin']);

  assert.equal(
    second,
    first,
    'the second land returns the existing tip, it does not mint a commit',
  );
  assert.equal(
    s.g(s.main, ['rev-parse', 'origin/master']),
    first,
    'origin/master must NOT advance on a re-land of an already-merged branch',
  );
  assert.equal(
    s
      .g(s.main, ['log', 'origin/master', '--oneline'])
      .split('\n')
      .filter((l) => /Merge worktree-already/.test(l)).length,
    1,
    'exactly one merge commit for this branch — no degenerate second merge',
  );
});

test('plan 1239: an ephemeral-merge CONFLICT throws a TYPED ephemeral-merge-conflict (never a raw crash)', () => {
  const s = sandbox();
  // the branch rewrites a.txt (base line) — a whole-file-style overwrite of a shared file.
  s.g(s.main, ['checkout', '-b', 'worktree-cf', 'origin/master']);
  writeFileSync(join(s.main, 'a.txt'), 'BRANCH rewrite\n');
  s.g(s.main, ['add', 'a.txt']);
  s.g(s.main, ['commit', '-m', 'branch rewrites a.txt']);
  s.g(s.main, ['push', 'origin', 'worktree-cf']);
  // a SIBLING land advances origin/master with a CONFLICTING rewrite of the same line, AFTER
  // the branch's base — so the ephemeral `reset --hard origin/master` + `merge origin/worktree-cf`
  // cannot auto-merge (both sides changed the base line).
  s.g(s.main, ['checkout', 'master']);
  writeFileSync(join(s.main, 'a.txt'), 'MASTER conflicting rewrite\n');
  s.g(s.main, ['add', 'a.txt']);
  s.g(s.main, ['commit', '-m', 'sibling rewrites a.txt']);
  s.g(s.main, ['push', 'origin', 'master']);

  const e = caught(() => landBranchViaEphemeral(s.main, 'worktree-cf', 'done cf'));
  assert.equal(e.reason, 'ephemeral-merge-conflict');
  assert.match(e.message, /CONFLICT/);
  assert.match(e.conflictDetail || '', /a\.txt/); // the raw git detail names the conflicted path
  // plan 1239: the classifier is PORCELAIN-based (unmerged paths), not a stderr regex, and
  // attributes the conflict to the sibling that moved the file.
  assert.ok(e.conflictedPaths.includes('a.txt'), 'conflicted paths parsed from porcelain');
  assert.ok(Array.isArray(e.culprits), 'culprits is an attribution array');
  // the sibling was a direct (non-plan-tagged) commit, so the path is attributed to its commit
  assert.ok(
    e.culprits.some((c) => c.path === 'a.txt' && (c.commits || []).length > 0),
    'the conflicted path is attributed to the sibling commit that moved it',
  );
  // the branch did NOT land on origin/master (safe to recover with the slot held)
  s.g(s.main, ['fetch', 'origin']);
  assert.equal(
    s.g(s.main, ['log', 'origin/master', '--oneline']).includes('Merge worktree-cf'),
    false,
  );
  // the ephemeral worktree was cleaned up by the finally (no _land-* left behind)
  assert.equal(s.g(s.main, ['worktree', 'list']).includes('_land-worktree-cf'), false);
});

// review fix (batch-2026-07-07-coord-spine, /sonnet-review high finding): landBranchViaEphemeral's
// tmp-dir reclaim previously force-removed WHATEVER occupied the path before checking whether it
// was a stale leftover of the SAME branch vs. a LIVE sibling land's in-flight ephemeral checkout
// that merely truncates to the same basename. reclaimLandDirIfSafe + worktreeBranchAt fix this —
// only reclaim when the path is unregistered (orphaned) or registered for THIS SAME branch; never
// touch a path registered for a DIFFERENT branch.
test('worktreeBranchAt: null for a path with nothing there', () => {
  const s = sandbox();
  assert.equal(worktreeBranchAt(s.main, join(s.root, 'nothing-here')), null);
});

test('worktreeBranchAt: returns the branch name for a registered worktree', () => {
  const s = sandbox();
  const dir = join(s.root, 'wt-branch-probe');
  s.g(s.main, ['worktree', 'add', '-b', 'probe-branch', dir, 'origin/master']);
  assert.equal(worktreeBranchAt(s.main, dir), 'probe-branch');
  s.g(s.main, ['worktree', 'remove', '--force', dir]);
});

test('reclaimLandDirIfSafe: nothing at the path — reclaimed trivially, no git calls needed', () => {
  const s = sandbox();
  const dir = join(s.root, 'never-existed');
  assert.equal(reclaimLandDirIfSafe(s.main, dir, 'any-branch'), true);
});

test('reclaimLandDirIfSafe: a path registered for THIS SAME branch (stale crashed-prior-land remnant) is force-removed', () => {
  const s = sandbox();
  const dir = join(s.root, 'wt-self-stale');
  s.g(s.main, ['worktree', 'add', '-b', 'worktree-self-stale', dir, 'origin/master']);
  assert.equal(worktreeBranchAt(s.main, dir), 'worktree-self-stale');

  assert.equal(reclaimLandDirIfSafe(s.main, dir, 'worktree-self-stale'), true);

  assert.equal(existsSync(dir), false, 'the stale self-collision worktree dir is gone');
  assert.equal(
    s.g(s.main, ['worktree', 'list', '--porcelain']).includes('worktree-self-stale'),
    false,
    'no longer registered',
  );
});

test('reclaimLandDirIfSafe: a path registered for a DIFFERENT branch (live sibling) is NOT touched', () => {
  const s = sandbox();
  const dir = join(s.root, 'wt-live-sibling');
  s.g(s.main, ['worktree', 'add', '-b', 'sibling-live-branch', dir, 'origin/master']);

  assert.equal(reclaimLandDirIfSafe(s.main, dir, 'worktree-mine'), false);

  assert.equal(existsSync(dir), true, 'the live sibling worktree dir must still exist');
  assert.equal(
    s.g(s.main, ['worktree', 'list', '--porcelain']).includes('sibling-live-branch'),
    true,
    'still registered — untouched',
  );
  s.g(s.main, ['worktree', 'remove', '--force', dir]); // test cleanup
});

test('reclaimLandDirIfSafe: an orphaned (unregistered) leftover directory is cleared via the rmSync fallback', () => {
  const s = sandbox();
  const dir = join(s.root, 'orphan-leftover');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'debris.txt'), 'leftover\n');
  assert.equal(worktreeBranchAt(s.main, dir), null, 'not a registered worktree');

  assert.equal(reclaimLandDirIfSafe(s.main, dir, 'any-branch'), true);

  assert.equal(existsSync(dir), false, 'the orphaned directory was cleared');
});

// plan 2481: reclaimLandDirIfSafe must evict any memoized indexLockPath(dir) UNCONDITIONALLY at
// entry, so a same-path worktree recreated right after cannot inherit a stale cached admin dir.
// Observable without a spy: prime the cache while `dir` is a resolvable worktree, reclaim it (which
// removes the worktree), then prove indexLockPath(dir) is forced to re-probe — a still-cached entry
// would silently hand back the now-gone path instead of throwing on the missing repo.
test('reclaimLandDirIfSafe: evicts the memoized indexLockPath(dir) even on the accepted (same-branch) reclaim path', () => {
  const s = sandbox();
  const dir = join(s.root, 'wt-cache-evict-accepted');
  s.g(s.main, ['worktree', 'add', '-b', 'worktree-cache-evict-accepted', dir, 'origin/master']);
  indexLockPath(dir); // populate the process-local cache

  assert.equal(reclaimLandDirIfSafe(s.main, dir, 'worktree-cache-evict-accepted'), true);

  assert.equal(existsSync(dir), false, 'reclaimed — the worktree dir is gone');
  assert.throws(
    () => indexLockPath(dir),
    /fatal|not a git repository/i,
    'a stale cache hit would have returned the old path instead of re-probing the gone dir',
  );
});

// plan 1640: generalizes plan 1621's coord-git.mjs resolveCoordCheckout rmSync EBUSY/EPERM/
// ENOTEMPTY retry-with-backoff (a killed process leaving an open handle under
// `.git/worktrees/<name>/`, docs/runbooks/branch-hygiene.md) into reclaimLandDirIfSafe's own
// rmSync fallback, which previously swallowed the identical error class and gave up immediately.
// Mirrors coord-git.test.mjs's plan-1621 "transient EBUSY is retried" test.
test('reclaimLandDirIfSafe: a transient rmSync EBUSY on the orphaned-leftover fallback is retried, not swallowed on the first throw (plan 1640)', () => {
  const s = sandbox();
  const dir = join(s.root, 'orphan-flaky-ebusy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'debris.txt'), 'leftover\n');

  // Injected rm seam: mimics a Windows-held file handle — throws EBUSY once, then delegates to
  // the real rmSync.
  let calls = 0;
  const flakyRmSync = (p, opts) => {
    calls++;
    if (calls === 1) {
      const e = new Error(`EBUSY: resource busy or locked, rmdir '${p}'`);
      e.code = 'EBUSY';
      throw e;
    }
    return rmSync(p, opts);
  };

  assert.equal(reclaimLandDirIfSafe(s.main, dir, 'any-branch', { _rmSync: flakyRmSync }), true);

  assert.equal(
    existsSync(dir),
    false,
    'the orphaned directory was cleared after the transient EBUSY',
  );
  assert.ok(calls >= 2, 'the flaky rmSync must have been retried at least once');
});

test('reclaimLandDirIfSafe: an rmSync EBUSY that never clears exhausts to the existing best-effort contract, not an uncaught throw (plan 1640)', () => {
  const s = sandbox();
  const dir = join(s.root, 'orphan-always-busy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'debris.txt'), 'leftover\n');

  const alwaysBusyRmSync = () => {
    const e = new Error("EBUSY: resource busy or locked, rmdir 'x'");
    e.code = 'EBUSY';
    throw e;
  };

  // Must not throw uncaught — reclaimLandDirIfSafe's contract is "leave it, caller re-checks and
  // falls back if still present", never a raw crash.
  assert.equal(
    reclaimLandDirIfSafe(s.main, dir, 'any-branch', { _rmSync: alwaysBusyRmSync }),
    false,
    'still present after exhausting the retry budget — falls back per the existing contract',
  );
  assert.equal(
    existsSync(dir),
    true,
    'the directory was never removed — the always-busy seam never delegates',
  );
});

// ── plan 1663: crash-safe reclaim of a killed land's locked ephemeral registration ──
// A hard kill during `git worktree add` (the 10-min foreground tool cap, session 1492,
// 2026-07-09) leaves git's worst-of-both state: directory MISSING, registration PRESENT,
// locked "initializing". Every subsequent `worktree add` at that path then dies with
// "fatal: '<dir>' is a missing but locked worktree". Dead debris and a LIVE sibling
// mid-add/mid-merge are identical by STATE (branchless + locked/detached) — they are
// discriminated by admin-metadata IDLENESS (registrationIdleMs ≥ LAND_REGISTRATION_STALE_MS).

// Plant the exact incident state: a completed detached add, locked with git's own
// "initializing" reason, directory ripped away — registration survives.
function plantKilledAddDebris(s, dir) {
  s.g(s.main, ['worktree', 'add', '--detach', dir, 'origin/master']);
  s.g(s.main, ['worktree', 'lock', '--reason', 'initializing', dir]);
  rmSync(dir, { recursive: true, force: true });
}

// Backdate every file in the registration's admin dir so the debris is provably idle —
// exercises the REAL mtime path (registrationAdminDirFor + registrationIdleMs), no fake clock.
function backdateRegistration(main, dir, hoursAgo = 2) {
  const admin = registrationAdminDirFor(main, dir);
  assert.ok(admin, 'registration admin dir resolves via its gitdir file');
  const t = Date.now() / 1000 - hoursAgo * 3600;
  for (const e of readdirSync(admin, { withFileTypes: true })) {
    if (e.isFile()) utimesSync(join(admin, e.name), t, t);
  }
}

test('worktreeEntryAt: parses the killed-add debris shape (branchless, detached, locked "initializing")', () => {
  const s = sandbox();
  const dir = join(s.root, 'entry-probe');
  plantKilledAddDebris(s, dir);

  const entry = worktreeEntryAt(s.main, dir);
  assert.ok(entry, 'missing-but-registered entry is FOUND (not conflated with unregistered)');
  assert.equal(entry.branch, null);
  assert.equal(entry.detached, true);
  assert.equal(entry.locked, true);
  assert.equal(entry.lockReason, 'initializing');
  assert.equal(worktreeEntryAt(s.main, join(s.root, 'nowhere')), null);
});

test('registrationIdleMs: fresh registration reads near-zero idle; backdated reads stale', () => {
  const s = sandbox();
  const dir = join(s.root, 'idle-probe');
  plantKilledAddDebris(s, dir);

  const fresh = registrationIdleMs(s.main, dir);
  assert.ok(fresh !== null && fresh < 60_000, `fresh debris idles < 60s (got ${fresh})`);
  backdateRegistration(s.main, dir);
  const stale = registrationIdleMs(s.main, dir);
  assert.ok(stale > 3_600_000, `backdated debris idles > 1h (got ${stale})`);
  assert.equal(registrationIdleMs(s.main, join(s.root, 'nowhere')), null);
});

test('reclaimLandDirIfSafe: missing dir + STALE locked registration (the plan-1663 incident) is reclaimed and worktree add succeeds', () => {
  const s = sandbox();
  const dir = join(s.root, 'incident-1631');
  plantKilledAddDebris(s, dir);
  // pre-fix behaviour check: the debris blocks a fresh add (the incident's crash site)
  assert.throws(() => s.g(s.main, ['worktree', 'add', '--detach', dir, 'origin/master']));
  backdateRegistration(s.main, dir);

  assert.equal(reclaimLandDirIfSafe(s.main, dir, 'worktree-1631-whatever'), true);

  assert.equal(worktreeEntryAt(s.main, dir), null, 'registration is GONE (unlock + prune)');
  // the incident's fatal now succeeds
  s.g(s.main, ['worktree', 'add', '--detach', dir, 'origin/master']);
  s.g(s.main, ['worktree', 'remove', '--force', dir]); // test cleanup
});

test('reclaimLandDirIfSafe: missing dir + FRESH locked registration (a sibling could be mid-add) is refused untouched', () => {
  const s = sandbox();
  const dir = join(s.root, 'fresh-mid-add');
  plantKilledAddDebris(s, dir); // NOT backdated — indistinguishable from a live sibling

  assert.equal(reclaimLandDirIfSafe(s.main, dir, 'worktree-mine'), false);

  const entry = worktreeEntryAt(s.main, dir);
  assert.ok(entry && entry.locked, 'the fresh registration is untouched, still locked');
});

test('reclaimLandDirIfSafe: dir present + LOCKED registration for THIS SAME branch is reclaimed including the unlock', () => {
  const s = sandbox();
  const dir = join(s.root, 'self-locked');
  s.g(s.main, ['worktree', 'add', '-b', 'worktree-self-locked', dir, 'origin/master']);
  s.g(s.main, ['worktree', 'lock', '--reason', 'initializing', dir]);

  // same-branch: reclaimable regardless of age (the landing queue serializes same-branch lands)
  assert.equal(reclaimLandDirIfSafe(s.main, dir, 'worktree-self-locked'), true);

  assert.equal(existsSync(dir), false, 'dir removed despite the lock (unlock step ran)');
  assert.equal(worktreeEntryAt(s.main, dir), null, 'registration gone');
});

test('reclaimLandDirIfSafe: dir present + FRESH branchless (detached) registration is refused — a live sibling ephemeral checkout is never ripped', () => {
  const s = sandbox();
  const dir = join(s.root, 'live-detached-sibling');
  // a sibling land's ephemeral checkout is created --detach: branchless, NO lock after add
  s.g(s.main, ['worktree', 'add', '--detach', dir, 'origin/master']);

  assert.equal(reclaimLandDirIfSafe(s.main, dir, 'worktree-mine'), false);

  assert.ok(existsSync(dir), 'live detached sibling checkout untouched');
  assert.ok(worktreeEntryAt(s.main, dir), 'still registered');
  s.g(s.main, ['worktree', 'remove', '--force', dir]); // test cleanup
});

test('reclaimLandDirIfSafe: dir present + STALE branchless registration (crashed post-add land) is reclaimed', () => {
  const s = sandbox();
  const dir = join(s.root, 'stale-detached-debris');
  s.g(s.main, ['worktree', 'add', '--detach', dir, 'origin/master']);
  backdateRegistration(s.main, dir);

  assert.equal(reclaimLandDirIfSafe(s.main, dir, 'worktree-mine'), true);

  assert.equal(existsSync(dir), false);
  assert.equal(worktreeEntryAt(s.main, dir), null);
});

test('sweepDeadLandRegistrations: clears only dead _land-* debris — fresh, branch-carrying, dir-present, and non-_land entries spared', () => {
  const s = sandbox();
  const wtDir = join(s.main, '.claude', 'worktrees');
  mkdirSync(wtDir, { recursive: true });
  const dead = join(wtDir, '_land-dead-branch');
  const fresh = join(wtDir, '_land-fresh-branch');
  const present = join(wtDir, '_land-present-branch');
  const branchy = join(wtDir, '_land-branchy');
  const plain = join(wtDir, 'worktree-normal-plan');
  plantKilledAddDebris(s, dead);
  backdateRegistration(s.main, dead);
  plantKilledAddDebris(s, fresh); // not backdated
  s.g(s.main, ['worktree', 'add', '--detach', present, 'origin/master']);
  backdateRegistration(s.main, present); // stale but dir EXISTS → per-path reclaim territory
  s.g(s.main, ['worktree', 'add', '-b', 'some-plan-branch', branchy, 'origin/master']);
  s.g(s.main, ['worktree', 'lock', branchy]);
  rmSync(branchy, { recursive: true, force: true });
  backdateRegistration(s.main, branchy); // stale + missing but BRANCH-carrying → not ours to judge
  s.g(s.main, ['worktree', 'add', '-b', 'plan-branch-2', plain, 'origin/master']);

  const swept = sweepDeadLandRegistrations(s.main);

  assert.deepEqual(
    swept.map((x) => x.path.replace(/\\/g, '/')),
    [dead.replace(/\\/g, '/')],
    'exactly the one dead entry swept',
  );
  assert.equal(worktreeEntryAt(s.main, dead), null, 'dead registration pruned');
  assert.ok(worktreeEntryAt(s.main, fresh)?.locked, 'fresh debris spared (possible live sibling)');
  assert.ok(worktreeEntryAt(s.main, present), 'dir-present entry spared');
  assert.ok(worktreeEntryAt(s.main, branchy)?.locked, 'branch-carrying entry spared');
  assert.ok(worktreeEntryAt(s.main, plain), 'non-_land plan worktree spared');
});

// plan 2479 finding 1 (review fix): worktreeAddCollisionFallback is the call-site handler for a
// RETRIED `worktree add --detach` that dies "already exists" because an earlier attempt of the
// SAME command already registered `tmp`. Rather than trying to prove the collision was our OWN
// retry (impossible to distinguish from a live sibling truncating to the identical basename —
// every ephemeral land worktree is detached at origin/master, so a sha check alone cannot tell
// the two apart), it unconditionally switches to the hash-suffixed fallback path — the same one
// `reclaimLandDirIfSafe` already routes to for a live-sibling collision earlier in this function.
test('worktreeAddCollisionFallback: an "already exists" collision returns the reclaimed hash-suffixed fallback path', () => {
  const s = sandbox();
  const branch = 'worktree-collision-fallback-reclaim';
  const wtDir = join(s.main, '.claude', 'worktrees');
  mkdirSync(wtDir, { recursive: true });
  const expectedFallback = join(wtDir, landDirBaseFor(branch, true));
  // stale killed-add debris AT the fallback path — proves reclaimLandDirIfSafe actually ran
  plantKilledAddDebris(s, expectedFallback);
  backdateRegistration(s.main, expectedFallback);

  const fakeErr = new Error(`fatal: '${join(wtDir, landDirBaseFor(branch))}' already exists`);
  fakeErr.stderr = fakeErr.message;
  const fallback = worktreeAddCollisionFallback(s.main, branch, fakeErr);

  assert.equal(fallback, expectedFallback);
  assert.equal(worktreeEntryAt(s.main, expectedFallback), null, 'stale debris reclaimed');
});

test('worktreeAddCollisionFallback: a non-"already exists" error returns null — caller must rethrow', () => {
  const s = sandbox();
  const fakeErr = new Error('fatal: some unrelated worktree add failure');
  fakeErr.stderr = fakeErr.message;
  assert.equal(worktreeAddCollisionFallback(s.main, 'worktree-irrelevant', fakeErr), null);
});

// review fix (/sonnet-review xhigh, CONFIRMED): re-pointing the three tests below at
// landBranchViaCheckout left NOTHING exercising the ENTRY POINT → fallback wiring end-to-end for
// the debris scenarios — a future edit that mis-forwards `branch`/`summary`/`opts` into the
// fallback closure would break production without failing a test. This drives the real entry
// point into the fallback (via a genuine conflict) WITH stale debris parked at the primary tmp
// path, so the sweep/reclaim path and the argument forwarding are both covered through the
// function done-worktree actually calls.
test('plan 2466: the ENTRY POINT falls back through to the checkout path — debris swept, typed error, args forwarded', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-q', '-b', 'worktree-fb-wire', 'origin/master']);
  writeFileSync(join(s.main, 'a.txt'), 'BRANCH rewrite\n');
  s.g(s.main, ['add', '-A']);
  s.g(s.main, ['commit', '-q', '-m', 'branch rewrites a.txt']);
  s.g(s.main, ['push', '-q', 'origin', 'worktree-fb-wire']);
  // a sibling advances master with a CONFLICTING rewrite, forcing the fast path to fall back
  s.g(s.main, ['checkout', '-q', 'master']);
  writeFileSync(join(s.main, 'a.txt'), 'MASTER conflicting rewrite\n');
  s.g(s.main, ['add', '-A']);
  s.g(s.main, ['commit', '-q', '-m', 'sibling rewrites a.txt']);
  s.g(s.main, ['push', '-q', 'origin', 'master']);

  // park STALE killed-add debris exactly where the fallback will want to cut its worktree
  const wtDir = join(s.main, '.claude', 'worktrees');
  mkdirSync(wtDir, { recursive: true });
  const primaryTmp = join(wtDir, landDirBaseFor('worktree-fb-wire'));
  plantKilledAddDebris(s, primaryTmp);
  backdateRegistration(s.main, primaryTmp);

  const e = caught(() => landBranchViaEphemeral(s.main, 'worktree-fb-wire', 'done fb wire'));

  // the fallback ran (only it can produce this typed error + porcelain-derived attribution)
  assert.equal(e.reason, 'ephemeral-merge-conflict');
  assert.ok(e.conflictedPaths.includes('a.txt'), 'conflicted paths parsed from porcelain');
  assert.ok(Array.isArray(e.culprits), 'culprits attribution array present');
  // `summary` reached the fallback: it is what the merge commit subject would have carried, and
  // `branch` reached it too — the error names the branch.
  assert.match(e.message, /worktree-fb-wire/);
  // the fallback's debris reclaim ran through the entry point
  assert.equal(worktreeEntryAt(s.main, primaryTmp), null, 'stale debris registration swept');
  // and the branch did NOT land
  s.g(s.main, ['fetch', '-q', 'origin']);
  assert.equal(
    s.g(s.main, ['log', 'origin/master', '--oneline']).includes('Merge worktree-fb-wire'),
    false,
  );
});

// plan 2466: the three tmp-dir-management tests below drive landBranchViaCheckout DIRECTLY, not
// the landBranchViaEphemeral entry point. They must: the entry point now merges in the object db
// and creates no worktree at all, so routing them through it would leave them passing while
// exercising NONE of the reclaim/collision logic they exist to pin — green tests covering nothing.
// The checkout path is still reached on every conflicting land, so this behaviour is still live.
test('landBranchViaCheckout: STALE killed-add debris at the primary tmp path is swept and the land succeeds at that path', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-1663-dead', 'origin/master']);
  writeFileSync(join(s.main, 'd1.txt'), 'feature\n');
  s.g(s.main, ['add', 'd1.txt']);
  s.g(s.main, ['commit', '-m', 'feat d1']);
  s.g(s.main, ['push', 'origin', 'worktree-1663-dead']);
  s.g(s.main, ['checkout', 'master']);

  const wtDir = join(s.main, '.claude', 'worktrees');
  mkdirSync(wtDir, { recursive: true });
  const primaryTmp = join(wtDir, landDirBaseFor('worktree-1663-dead'));
  plantKilledAddDebris(s, primaryTmp);
  backdateRegistration(s.main, primaryTmp);

  // pre-fix this crashed: "fatal: '<primaryTmp>' is a missing but locked worktree"
  const sha = landBranchViaCheckout(s.main, 'worktree-1663-dead', 'done 1663 dead');

  s.g(s.main, ['fetch', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), sha);
  assert.match(s.g(s.main, ['log', 'origin/master', '--oneline']), /Merge worktree-1663-dead/);
  assert.equal(worktreeEntryAt(s.main, primaryTmp), null, 'debris registration gone');
});

// plan 2481: the land-teardown finally block must evict indexLockPath(tmp) alongside the worktree
// removal — a later land in this process re-adding a worktree at this same slug-truncated path
// must not inherit a cached admin dir from this land's now-torn-down ephemeral checkout.
// landBranchViaCheckout's own `run(tmp, …)` calls populate the cache mid-land (via
// gitWithLockRetry → waitForIndexLock → indexLockPath), so no manual priming is needed here —
// observable without a spy: a still-cached entry after teardown would silently hand back the
// dead admin dir instead of forcing a fresh probe that fails on the now-removed directory.
test('landBranchViaCheckout: teardown evicts the memoized indexLockPath(tmp) for the ephemeral land worktree', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-2481-cache-evict', 'origin/master']);
  writeFileSync(join(s.main, 'e1.txt'), 'feature\n');
  s.g(s.main, ['add', 'e1.txt']);
  s.g(s.main, ['commit', '-m', 'feat e1']);
  s.g(s.main, ['push', 'origin', 'worktree-2481-cache-evict']);
  s.g(s.main, ['checkout', 'master']);

  const wtDir = join(s.main, '.claude', 'worktrees');
  mkdirSync(wtDir, { recursive: true });
  const primaryTmp = join(wtDir, landDirBaseFor('worktree-2481-cache-evict'));

  const sha = landBranchViaCheckout(s.main, 'worktree-2481-cache-evict', 'done 2481 evict');
  s.g(s.main, ['fetch', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), sha);

  assert.equal(existsSync(primaryTmp), false, 'the ephemeral land worktree was torn down');
  assert.throws(
    () => indexLockPath(primaryTmp),
    /fatal|not a git repository/i,
    'a still-cached admin dir from the just-finished land would return silently instead of ' +
      're-probing the now-removed dir',
  );
});

test('landBranchViaCheckout: FRESH killed-add debris at the primary tmp path is spared — the land succeeds via the hash-suffixed fallback', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-1663-fresh', 'origin/master']);
  writeFileSync(join(s.main, 'f1.txt'), 'feature\n');
  s.g(s.main, ['add', 'f1.txt']);
  s.g(s.main, ['commit', '-m', 'feat f1']);
  s.g(s.main, ['push', 'origin', 'worktree-1663-fresh']);
  s.g(s.main, ['checkout', 'master']);

  const wtDir = join(s.main, '.claude', 'worktrees');
  mkdirSync(wtDir, { recursive: true });
  const primaryTmp = join(wtDir, landDirBaseFor('worktree-1663-fresh'));
  plantKilledAddDebris(s, primaryTmp); // NOT backdated — could be a live sibling mid-add

  const sha = landBranchViaCheckout(s.main, 'worktree-1663-fresh', 'done 1663 fresh');

  s.g(s.main, ['fetch', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), sha);
  assert.match(s.g(s.main, ['log', 'origin/master', '--oneline']), /Merge worktree-1663-fresh/);
  // the possibly-live registration was never touched (locked entries survive the finally's prune)
  assert.ok(worktreeEntryAt(s.main, primaryTmp)?.locked, 'fresh debris registration spared');
});

test('landBranchViaCheckout: a LIVE sibling occupying the primary tmp dir (different branch) is never removed — falls back to the hash-suffixed name', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-sib-collide', 'origin/master']);
  writeFileSync(join(s.main, 'c2.txt'), 'feature\n');
  s.g(s.main, ['add', 'c2.txt']);
  s.g(s.main, ['commit', '-m', 'feat c2']);
  s.g(s.main, ['push', 'origin', 'worktree-sib-collide']);
  s.g(s.main, ['checkout', 'master']);

  const wtDir = join(s.main, '.claude', 'worktrees');
  mkdirSync(wtDir, { recursive: true });
  const primaryTmp = join(wtDir, landDirBaseFor('worktree-sib-collide'));
  // occupy the primary tmp dir with a LIVE worktree for a DIFFERENT branch — simulates a sibling
  // land in flight whose branch happens to truncate to the same basename.
  s.g(s.main, ['worktree', 'add', '-b', 'sibling-other-branch', primaryTmp, 'origin/master']);

  const sha = landBranchViaCheckout(s.main, 'worktree-sib-collide', 'done collide');

  // the live sibling worktree is UNTOUCHED — still registered, still on disk
  assert.equal(
    s.g(s.main, ['worktree', 'list', '--porcelain']).includes('sibling-other-branch'),
    true,
  );
  assert.ok(existsSync(primaryTmp), 'primary tmp dir (live sibling) must still exist');

  // our branch still landed — via the hash-suffixed fallback path
  s.g(s.main, ['fetch', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), sha);
  assert.match(s.g(s.main, ['log', 'origin/master', '--oneline']), /Merge worktree-sib-collide/);

  s.g(s.main, ['worktree', 'remove', '--force', primaryTmp]); // test cleanup
});

test('plan 971: mergeBranchToMaster({syncMain:false}) lands on origin but does NOT advance the shared local master', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-sm', 'origin/master']);
  writeFileSync(join(s.main, 'sm.txt'), 'feature\n');
  s.g(s.main, ['add', 'sm.txt']);
  s.g(s.main, ['commit', '-m', 'feat sm']);
  s.g(s.main, ['push', 'origin', 'worktree-sm']);
  s.g(s.main, ['checkout', 'master']);
  const before = s.g(s.main, ['rev-parse', 'master']); // local master tip BEFORE the land

  // plan 971: the done-worktree spine passes syncMain:false — the close-out runs in an
  // ephemeral worktree, so the shared local master is never a push source and is NOT
  // advanced here (the spine fast-forwards it opportunistically afterward instead).
  const sha = mergeBranchToMaster(s.main, 'worktree-sm', 'done sm', { syncMain: false });

  s.g(s.main, ['fetch', 'origin']);
  // the merge DID land on origin/master ...
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), sha);
  assert.match(s.g(s.main, ['log', 'origin/master', '--oneline']), /Merge worktree-sm/);
  // ... but the shared LOCAL master is untouched (no syncLocalMaster, so no
  // master-diverged-post-land throw can ever block the completed land).
  assert.equal(s.g(s.main, ['rev-parse', 'master']), before);
});

test('plan 971: the default (syncMain omitted) STILL advances local master — every other caller is unchanged', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-sd', 'origin/master']);
  writeFileSync(join(s.main, 'sd.txt'), 'feature\n');
  s.g(s.main, ['add', 'sd.txt']);
  s.g(s.main, ['commit', '-m', 'feat sd']);
  s.g(s.main, ['push', 'origin', 'worktree-sd']);
  s.g(s.main, ['checkout', 'master']);

  const sha = mergeBranchToMaster(s.main, 'worktree-sd', 'done sd'); // default syncMain:true

  // local master fast-forwarded up to the landed merge (the pre-971 contract)
  assert.equal(s.g(s.main, ['rev-parse', 'master']), sha);
});

test('retries the whole merge on a non-ff race (origin moved mid-land)', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-y', 'origin/master']);
  writeFileSync(join(s.main, 'c.txt'), 'y\n');
  s.g(s.main, ['add', 'c.txt']);
  s.g(s.main, ['commit', '-m', 'feat c']);
  s.g(s.main, ['push', 'origin', 'worktree-y']);
  s.g(s.main, ['checkout', 'master']);
  // simulate a sibling landing onto origin AFTER our fetch but BEFORE our push,
  // by injecting a one-shot sibling push (land-lib calls this with the RESOLVED
  // origin URL — the same bare remote the ephemeral worktree pushes to).
  const sha = landBranchViaEphemeral(s.main, 'worktree-y', 'done y', {
    _injectRaceOnce: (originUrl) => {
      const sib = mkdtempSync(join(s.root, 'sib-'));
      execFileSync('git', ['clone', originUrl, sib]);
      execFileSync('git', ['-C', sib, 'config', 'user.email', 's@s']);
      execFileSync('git', ['-C', sib, 'config', 'user.name', 's']);
      writeFileSync(join(sib, 'sibling.txt'), 'sib\n');
      execFileSync('git', ['-C', sib, 'add', 'sibling.txt']);
      execFileSync('git', ['-C', sib, 'commit', '-m', 'sibling push']);
      execFileSync('git', ['-C', sib, 'push', 'origin', 'master']);
    },
  });
  s.g(s.main, ['fetch', 'origin']);
  // final master contains BOTH the sibling commit and our merge
  const log = s.g(s.main, ['log', 'origin/master', '--oneline']);
  assert.match(log, /sibling push/);
  assert.match(log, /Merge worktree-y/);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), sha);
});

test('classifyPushFailure retries ff-abort wording and preserves failed-to-push breadth', () => {
  assert.equal(
    classifyPushFailure(
      { stdout: 'fatal: Not possible to fast-forward, aborting.' },
      { i: 0, branch: 'worktree-test' },
    ),
    'retry',
  );

  const source = readFileSync(new URL('./land-lib.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export function classifyPushFailure');
  const end = source.indexOf('\nexport function ', start + 1);
  const classifyPushFailureSource = source.slice(start, end === -1 ? source.length : end);
  assert.match(classifyPushFailureSource, /isRetryablePushFailure\(e\)/);
  assert.doesNotMatch(classifyPushFailureSource, /isRetryablePushFailure\(msg\)/);

  for (const message of [
    'fatal: Not possible to fast-forward, aborting.',
    'error: failed to push some refs',
  ]) {
    assert.equal(isRetryablePushFailure(message), true);
    assert.equal(classifyPushFailure({ message }, { i: 0, branch: 'worktree-test' }), 'retry');
  }
});

// plan 2411 D1: push-retry EXHAUSTION (all 6 attempts lose the non-ff race) previously rethrew
// the RAW git error on the final iteration — escaping past this function to done-worktree's crash
// path and releasing the queue slot even though the branch never reached origin/master. Uses the
// `_injectRaceEvery` seam (fires on EVERY iteration, unlike the single-shot `_injectRaceOnce`
// above) to push a fresh sibling commit before each of the 6 push attempts, forcing every one to
// lose the race.
test('plan 2411: push-retry EXHAUSTION after 6 losing races throws a TYPED ephemeral-push-nonff-exhausted (never a raw crash)', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-z', 'origin/master']);
  writeFileSync(join(s.main, 'z.txt'), 'z\n');
  s.g(s.main, ['add', 'z.txt']);
  s.g(s.main, ['commit', '-m', 'feat z']);
  s.g(s.main, ['push', 'origin', 'worktree-z']);
  s.g(s.main, ['checkout', 'master']);

  let raceCount = 0;
  const e = caught(() =>
    landBranchViaEphemeral(s.main, 'worktree-z', 'done z', {
      _injectRaceEvery: (originUrl) => {
        raceCount++;
        const sib = mkdtempSync(join(s.root, `sib-${raceCount}-`));
        execFileSync('git', ['clone', originUrl, sib]);
        execFileSync('git', ['-C', sib, 'config', 'user.email', 's@s']);
        execFileSync('git', ['-C', sib, 'config', 'user.name', 's']);
        writeFileSync(join(sib, `sibling-${raceCount}.txt`), 'sib\n');
        execFileSync('git', ['-C', sib, 'add', `sibling-${raceCount}.txt`]);
        execFileSync('git', ['-C', sib, 'commit', '-m', `sibling push ${raceCount}`]);
        execFileSync('git', ['-C', sib, 'push', 'origin', 'master']);
      },
    }),
  );

  assert.equal(
    raceCount,
    6,
    'all 6 attempts must have raced (proves genuine exhaustion, not an early bail)',
  );
  assert.equal(e.reason, 'ephemeral-push-nonff-exhausted');
  assert.equal(e.attempts, 6);
  assert.match(e.message, /branch/i);
  // review fix (sonnet-review high, CONFIRMED): the last attempt's raw git detail must be
  // carried on the typed error (mirrors ephemeral-merge-conflict's e.conflictDetail) — dropping
  // it left an operator with zero diagnostic signal to tell "6 genuine races" apart from a
  // PERMANENT rejection that also matches the retry regex.
  assert.ok(e.pushDetail && e.pushDetail.length > 0, 'the raw push-failure detail must be carried');
  // the branch did NOT land on origin/master — safe to recover with the slot held
  s.g(s.main, ['fetch', 'origin']);
  assert.equal(
    s.g(s.main, ['log', 'origin/master', '--oneline']).includes('Merge worktree-z'),
    false,
    'the branch must NOT have landed after exhaustion',
  );
  // the ephemeral worktree was cleaned up by the finally (no _land-* left behind)
  assert.equal(s.g(s.main, ['worktree', 'list']).includes('_land-worktree-z'), false);
});

// plan 2411 acceptance 3: a push failure the non-ff regex does NOT match (auth/network/hook-shaped
// — simulated here by the origin remote vanishing mid-land) must keep today's fail-FAST behaviour:
// no retry loop, raw error straight through.
test('plan 2411: a non-retryable push failure (regex non-match) fails FAST on the first attempt — not retried, raw error', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-nf', 'origin/master']);
  writeFileSync(join(s.main, 'nf.txt'), 'nf\n');
  s.g(s.main, ['add', 'nf.txt']);
  s.g(s.main, ['commit', '-m', 'feat nf']);
  s.g(s.main, ['push', 'origin', 'worktree-nf']);
  s.g(s.main, ['checkout', 'master']);

  let hookCalls = 0;
  const e = caught(() =>
    landBranchViaEphemeral(s.main, 'worktree-nf', 'done nf', {
      _injectRaceEvery: () => {
        hookCalls++;
        // the bare origin vanishing mid-land is a non-non-ff, non-retryable push failure
        // ("does not appear to be a git repository" — no "rejected"/"non-fast-forward"/
        // "fetch first"/"failed to push" in the message), the auth/network/hook-shaped class
        // task 1 says must keep failing fast on the first attempt.
        rmSync(s.origin, { recursive: true, force: true });
      },
    }),
  );

  assert.equal(hookCalls, 1, 'must fail on the FIRST attempt — the retry loop must not engage');
  assert.notEqual(e.reason, 'ephemeral-push-nonff-exhausted');
  const msg = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
  assert.ok(
    !isRetryablePushFailure(msg),
    `sanity: this failure must genuinely not match the retry regex, got: ${msg}`,
  );
});

// ── plan 495: mergeBranchToMaster — diverged-local-master guard (no half-land / no raw crash) ──

test('plan 495: a diverged local master halts BEFORE the merge — branch NOT landed, typed error', () => {
  const s = sandbox();
  // a feature branch on origin (as pickup-plan would push it)
  s.g(s.main, ['checkout', '-b', 'worktree-d', 'origin/master']);
  writeFileSync(join(s.main, 'f.txt'), 'feat\n');
  s.g(s.main, ['add', 'f.txt']);
  s.g(s.main, ['commit', '-m', 'feat']);
  s.g(s.main, ['push', 'origin', 'worktree-d']);
  s.g(s.main, ['checkout', 'master']);
  const originBefore = s.g(s.main, ['rev-parse', 'origin/master']);
  // a SIBLING session's commit sits UNPUSHED on the shared local master carrying a SEED/CODE
  // path (plan 1240 Group B: a code/seed remnant STILL blocks; a doc-only remnant no longer does —
  // covered by the plan-1240 allow-case test below). This is the plan-493 half-land setup with a
  // non-exempt payload so the diverged-master guard still fires.
  writeFileSync(join(s.main, 'sibling-code.ts'), 'export const x = 1;\n');
  s.g(s.main, ['add', 'sibling-code.ts']);
  s.g(s.main, ['commit', '-m', 'sibling unpushed code remnant']);

  let landFnCalled = false;
  const landFn = (...a) => {
    landFnCalled = true;
    return landBranchViaEphemeral(...a);
  };
  const e = caught(() => mergeBranchToMaster(s.main, 'worktree-d', 'done d', { run: s.g, landFn }));

  // typed (.reason) → the spine converts to a recoverable LAND_BLOCKED seam, never a raw crash
  assert.equal(e.reason, 'unpushed-master');
  // the branch must NOT have been merged — no half-land
  assert.equal(landFnCalled, false, 'branch must NOT be merged when local master diverged');
  s.g(s.main, ['fetch', 'origin']);
  assert.equal(
    s.g(s.main, ['rev-parse', 'origin/master']),
    originBefore,
    'origin/master must be unchanged — the branch did not land',
  );
});

test('plan 495: a normal (synced) land merges the branch AND fast-forwards local master', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-n', 'origin/master']);
  writeFileSync(join(s.main, 'n.txt'), 'n\n');
  s.g(s.main, ['add', 'n.txt']);
  s.g(s.main, ['commit', '-m', 'feat n']);
  s.g(s.main, ['push', 'origin', 'worktree-n']);
  s.g(s.main, ['checkout', 'master']);

  const sha = mergeBranchToMaster(s.main, 'worktree-n', 'done n', { run: s.g });

  s.g(s.main, ['fetch', 'origin']);
  assert.equal(
    s.g(s.main, ['rev-parse', 'origin/master']),
    sha,
    'origin/master advanced to the merge',
  );
  assert.equal(
    s.g(s.main, ['rev-parse', 'master']),
    sha,
    'local master fast-forwarded to the landed tip',
  );
  assert.match(s.g(s.main, ['log', 'master', '--oneline']), /Merge worktree-n/);
});

test('plan 495: a divergence appearing AFTER the land surfaces a typed seam (branch already on origin), not a raw crash', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-z', 'origin/master']);
  writeFileSync(join(s.main, 'z.txt'), 'z\n');
  s.g(s.main, ['add', 'z.txt']);
  s.g(s.main, ['commit', '-m', 'feat z']);
  s.g(s.main, ['push', 'origin', 'worktree-z']);
  s.g(s.main, ['checkout', 'master']);

  // landFn lands for real, then simulates a sibling committing to the SHARED local master
  // in the micro-window between the pre-merge assertLandable re-check and the ff-only sync.
  const landFn = (MAIN, branch, summary) => {
    const sha = landBranchViaEphemeral(MAIN, branch, summary);
    s.g(MAIN, ['commit', '--allow-empty', '-m', 'sibling commit during land']);
    return sha;
  };
  const e = caught(() => mergeBranchToMaster(s.main, 'worktree-z', 'done z', { run: s.g, landFn }));

  assert.equal(e.reason, 'master-diverged-post-land');
  assert.ok(
    e.landedSha,
    'the seam carries the landed sha — the branch IS on origin (recoverable, not lost)',
  );
  // the branch genuinely landed on origin — recovery is a rebase + finish-bookkeeping, not a re-land
  s.g(s.main, ['fetch', 'origin']);
  assert.match(s.g(s.main, ['log', 'origin/master', '--oneline']), /Merge worktree-z/);
});

// ── plan 502: resume-after-merge — the re-merge is skipped, not re-run ──

test('plan 502: a resume after the branch already landed SKIPS the re-merge and syncs local master', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-r', 'origin/master']);
  writeFileSync(join(s.main, 'r.txt'), 'r\n');
  s.g(s.main, ['add', 'r.txt']);
  s.g(s.main, ['commit', '-m', 'feat r']);
  s.g(s.main, ['push', 'origin', 'worktree-r']);
  s.g(s.main, ['checkout', 'master']);

  // first invocation lands for real
  const sha1 = mergeBranchToMaster(s.main, 'worktree-r', 'done r', { run: s.g });
  s.g(s.main, ['fetch', 'origin']);
  const originAfterFirst = s.g(s.main, ['rev-parse', 'origin/master']);
  assert.equal(originAfterFirst, sha1);

  // resume (e.g. after an index.lock-exhaustion seam mid-close-out): the second
  // invocation must NOT re-merge — landFn throwing proves it is never reached
  const sha2 = mergeBranchToMaster(s.main, 'worktree-r', 'done r', {
    run: s.g,
    landFn: () => {
      throw new Error('must not re-merge an already-landed branch');
    },
  });

  s.g(s.main, ['fetch', 'origin']);
  assert.equal(
    s.g(s.main, ['rev-parse', 'origin/master']),
    originAfterFirst,
    'origin/master unchanged — no second merge commit',
  );
  const merges = s
    .g(s.main, ['log', 'origin/master', '--oneline', '--merges'])
    .split('\n')
    .filter((l) => /Merge worktree-r/.test(l));
  assert.equal(merges.length, 1, 'exactly ONE merge commit for the branch');
  assert.equal(sha2, sha1, 'the skip returns the ORIGINAL merge sha (for the archive note)');
  assert.equal(
    s.g(s.main, ['rev-parse', 'master']),
    originAfterFirst,
    'local master synced to the landed tip',
  );
});

test('plan 502: the already-landed skip still surfaces a typed seam when local master diverged', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-q', 'origin/master']);
  writeFileSync(join(s.main, 'q.txt'), 'q\n');
  s.g(s.main, ['add', 'q.txt']);
  s.g(s.main, ['commit', '-m', 'feat q']);
  s.g(s.main, ['push', 'origin', 'worktree-q']);
  s.g(s.main, ['checkout', 'master']);
  mergeBranchToMaster(s.main, 'worktree-q', 'done q', { run: s.g });

  // a sibling commit lands on the SHARED local master before the resume
  s.g(s.main, ['commit', '--allow-empty', '-m', 'sibling commit before resume']);

  const e = caught(() =>
    mergeBranchToMaster(s.main, 'worktree-q', 'done q', {
      run: s.g,
      landFn: () => {
        throw new Error('must not re-merge an already-landed branch');
      },
    }),
  );
  // typed — the spine converts it to a recoverable LAND_BLOCKED seam with the
  // rebase-then-finish recovery (the branch IS already on origin)
  assert.equal(e.reason, 'master-diverged-post-land');
  assert.ok(e.landedSha, 'carries the landed sha');
});

// ── plan 507: merge-bearing branches sync via freshen-merge, never a re-fighting rebase ──

// Build a branch that freshen-merged origin/master through a conflict the author
// already resolved (the 479 shape), with master advancing again afterwards.
// Returns the sandbox with `worktree-m` checked out in s.main.
function mergeBearingSetup() {
  const s = sandbox();
  // branch edits a.txt
  s.g(s.main, ['checkout', '-b', 'worktree-m', 'origin/master']);
  writeFileSync(join(s.main, 'a.txt'), 'branch edit\n');
  s.g(s.main, ['add', 'a.txt']);
  s.g(s.main, ['commit', '-m', 'branch work']);
  s.g(s.main, ['push', 'origin', 'worktree-m']);
  // a sibling lands a CONFLICTING edit to the same file on master
  s.g(s.main, ['checkout', 'master']);
  writeFileSync(join(s.main, 'a.txt'), 'sibling edit\n');
  s.g(s.main, ['add', 'a.txt']);
  s.g(s.main, ['commit', '-m', 'sibling landing 1']);
  s.g(s.main, ['push', 'origin', 'master']);
  // the author freshen-merges origin/master mid-flight and RESOLVES the conflict
  s.g(s.main, ['checkout', 'worktree-m']);
  s.g(s.main, ['fetch', 'origin']);
  try {
    s.g(s.main, ['merge', 'origin/master', '-m', 'freshen']);
  } catch {
    /* expected conflict */
  }
  writeFileSync(join(s.main, 'a.txt'), 'author resolution\n');
  s.g(s.main, ['add', 'a.txt']);
  s.g(s.main, ['commit', '-m', 'freshen (resolved)']);
  s.g(s.main, ['push', 'origin', 'worktree-m']);
  // master advances AGAIN before the land (fleet contention) — non-conflicting file
  s.g(s.main, ['checkout', 'master']);
  writeFileSync(join(s.main, 'other.txt'), 'sibling 2\n');
  s.g(s.main, ['add', 'other.txt']);
  s.g(s.main, ['commit', '-m', 'sibling landing 2']);
  s.g(s.main, ['push', 'origin', 'master']);
  s.g(s.main, ['checkout', 'worktree-m']);
  return s;
}

test('plan 507: a merge-bearing branch syncs via ONE freshen-merge — prior resolutions never re-fought', () => {
  const s = mergeBearingSetup();
  // the OLD rebase path would stop on a.txt here (replaying "branch work" onto the
  // sibling edit discards the freshen-merge's resolution); the freshen-merge must not.
  const r = syncBranchOntoMaster(s.main, 'worktree-m');

  assert.equal(r.mergeBearing, true, 'merge-bearing history detected');
  assert.equal(r.conflicted, false, 'no conflict — the prior resolution is shared history');
  assert.equal(r.pushBlocked, undefined);
  // branch now contains origin/master and keeps the author resolution
  s.g(s.main, ['merge-base', '--is-ancestor', 'origin/master', 'HEAD']);
  // autocrlf-tolerant: Windows checkouts rewrite the working copy to CRLF
  assert.equal(
    readFileSync(join(s.main, 'a.txt'), 'utf8').replace(/\r/g, ''),
    'author resolution\n',
  );
  // and was pushed (the land merges origin/<branch>)
  assert.equal(s.g(s.main, ['rev-parse', 'origin/worktree-m']), s.g(s.main, ['rev-parse', 'HEAD']));
  // the land itself completes — ONE invocation end-to-end, no manual conflict resolution
  s.g(s.main, ['checkout', 'master']);
  const sha = landBranchViaEphemeral(s.main, 'worktree-m', 'done m');
  s.g(s.main, ['fetch', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), sha);
  assert.match(s.g(s.main, ['log', 'origin/master', '--oneline']), /Merge worktree-m/);
});

test('plan 507: a LINEAR branch keeps the plain rebase — history stays linear', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-l', 'origin/master']);
  writeFileSync(join(s.main, 'lin.txt'), 'feature\n');
  s.g(s.main, ['add', 'lin.txt']);
  s.g(s.main, ['commit', '-m', 'linear feat']);
  s.g(s.main, ['push', 'origin', 'worktree-l']);
  // master advances (non-conflicting)
  s.g(s.main, ['checkout', 'master']);
  writeFileSync(join(s.main, 'other.txt'), 'sibling\n');
  s.g(s.main, ['add', 'other.txt']);
  s.g(s.main, ['commit', '-m', 'sibling landing']);
  s.g(s.main, ['push', 'origin', 'master']);
  s.g(s.main, ['checkout', 'worktree-l']);

  const r = syncBranchOntoMaster(s.main, 'worktree-l');

  assert.equal(r.mergeBearing, false);
  assert.equal(r.conflicted, false);
  // rebased, not merged: no merge commits on the branch, parent IS origin/master
  assert.equal(s.g(s.main, ['rev-list', '--merges', 'origin/master..HEAD']), '');
  assert.equal(s.g(s.main, ['rev-parse', 'HEAD^']), s.g(s.main, ['rev-parse', 'origin/master']));
});

test('plan 2433: syncBranchOntoMaster returns rebasedOntoSha — the origin/master tip resolved right after its own fetch, immune to a LATER sibling push', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-p', 'origin/master']);
  writeFileSync(join(s.main, 'p.txt'), 'feature\n');
  s.g(s.main, ['add', 'p.txt']);
  s.g(s.main, ['commit', '-m', 'feature work']);
  s.g(s.main, ['push', 'origin', 'worktree-p']);
  // master advances (non-conflicting) BEFORE the sync — this is the tip the sync must record
  advanceMaster(s, 'other.txt', 'sibling\n', 'worktree-p');
  const tipAtSync = s.g(s.main, ['rev-parse', 'origin/master']);

  const r = syncBranchOntoMaster(s.main, 'worktree-p');
  assert.equal(r.conflicted, false);
  assert.equal(
    r.rebasedOntoSha,
    tipAtSync,
    'records the tip resolved right after fetch — the sha the rebase actually ran against',
  );

  // a SIBLING land completes AFTER the sync returned (simulating the plan-2391 incident's
  // freshen->lint window) — the already-returned rebasedOntoSha must not retroactively track it.
  advanceMaster(s, 'other2.txt', 'sibling 2\n', 'worktree-p');
  assert.notEqual(
    r.rebasedOntoSha,
    s.g(s.main, ['rev-parse', 'origin/master']),
    'the interleaved sibling land moved the live ref — the captured sha stays pinned to the old tip',
  );
});

test('plan 507: a GENUINELY-new conflict on a merge-bearing branch surfaces once, held for the author', () => {
  const s = mergeBearingSetup();
  // master advances a THIRD time, conflicting with the author resolution of a.txt
  s.g(s.main, ['checkout', 'master']);
  s.g(s.main, ['pull', 'origin', 'master']);
  writeFileSync(join(s.main, 'a.txt'), 'sibling edit 3\n');
  s.g(s.main, ['add', 'a.txt']);
  s.g(s.main, ['commit', '-m', 'sibling landing 3']);
  s.g(s.main, ['push', 'origin', 'master']);
  s.g(s.main, ['checkout', 'worktree-m']);

  const r = syncBranchOntoMaster(s.main, 'worktree-m');

  assert.equal(r.conflicted, true, 'a genuinely-new conflict still surfaces');
  assert.equal(r.mergeBearing, true);
  assert.equal(r.conflictCommits, 1, 'a merge is ONE pass — never escalates to REBASE_UGLY');
  // the worktree is mid-merge for the author (MERGE_HEAD present), per the holding seam
  s.g(s.main, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  // author resolves + concludes the merge (what --resume LAND_BLOCKED_HOLDING expects)…
  writeFileSync(join(s.main, 'a.txt'), 'author resolution 2\n');
  s.g(s.main, ['add', 'a.txt']);
  s.g(s.main, ['commit', '-m', 'freshen (resolved 2)']);
  s.g(s.main, ['push', 'origin', 'worktree-m']);
  // …and a RE-RUN of the sync is an idempotent no-op (the rebase path re-fought here)
  const r2 = syncBranchOntoMaster(s.main, 'worktree-m');
  assert.equal(r2.conflicted, false, 're-run after resolution must not re-fight');
  s.g(s.main, ['checkout', 'master']);
  const sha = landBranchViaEphemeral(s.main, 'worktree-m', 'done m');
  s.g(s.main, ['fetch', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), sha);
});

// ── plan 768: the ephemeral land push skips the master-push pre-push hook ──
// The ephemeral worktree is a throwaway detached checkout off origin/master with
// NO node_modules, so the real master-landing hook's pnpm-based gates (`pnpm exec
// prettier --check`, the frontend/backend `tsc`, `pnpm validate-seed`) resolve no
// binary and crash the land (`'prettier' is not recognized`, hit on plan 763).
// landBranchViaEphemeral now pushes with --no-verify; the gates already ran on the
// worktree-branch push of identical content + the spine's worktree preflights.

test('plan 768: an ephemeral land push does NOT run the master-push pre-push hook (binary-less checkout)', () => {
  const s = sandbox();
  // A pre-push hook that FAILS on any push to master — the crash class the real
  // hook hits in the binary-less ephemeral worktree. The ephemeral worktree is a
  // linked worktree of s.main, so it inherits this shared (common-config) hook.
  const hooksDir = join(s.root, 'hooks').replace(/\\/g, '/');
  mkdirSync(hooksDir, { recursive: true });
  const hook = join(hooksDir, 'pre-push');
  writeFileSync(
    hook,
    '#!/bin/sh\n' +
      'while read -r _l _ls rref _rs; do\n' +
      '  case "$rref" in\n' +
      '    refs/heads/master)\n' +
      '      echo "pre-push (test): simulating plan-768 — \'prettier\' is not recognized" 1>&2\n' +
      '      exit 1 ;;\n' +
      '  esac\n' +
      'done\n' +
      'exit 0\n',
  );
  chmodSync(hook, 0o755);
  // core.hooksPath lives in the shared common config, so the ephemeral worktree's
  // `git push origin HEAD:master` (remote ref = refs/heads/master) sees this hook.
  s.g(s.main, ['config', 'core.hooksPath', hooksDir]);

  // a feature branch (remote ref = refs/heads/worktree-h → the hook lets it through)
  s.g(s.main, ['checkout', '-b', 'worktree-h', 'origin/master']);
  writeFileSync(join(s.main, 'feat.ts'), 'export const x = 1;\n'); // a prettier-relevant file
  s.g(s.main, ['add', 'feat.ts']);
  s.g(s.main, ['commit', '-m', 'feat ts']);
  s.g(s.main, ['push', 'origin', 'worktree-h']);
  s.g(s.main, ['checkout', 'master']);

  // WITHOUT --no-verify the ephemeral HEAD:master push trips the hook and the land
  // throws; WITH the plan-768 fix the push skips the hook and the land completes.
  const sha = landBranchViaEphemeral(s.main, 'worktree-h', 'done h');

  s.g(s.main, ['fetch', 'origin']);
  assert.equal(
    s.g(s.main, ['rev-parse', 'origin/master']),
    sha,
    'origin/master advanced to the merge — the hook did not block the land',
  );
  assert.match(s.g(s.main, ['log', 'origin/master', '--oneline']), /Merge worktree-h/);
});

// ── plan 988: preflight self-recovers a rebased-but-unpushed branch ──
// A crashed prior land can rebase the worktree branch onto an advanced origin/master
// and die before pushing — origin/<branch> stays at the pre-crash rebase, so the next
// land's preflight sees `origin/<branch>..<branch>` non-empty and would hard-fail
// "branch has unpushed commits" even though it is the SAME reviewed diff on a newer base.

test('plan 988: classifyAheadRangeDiff — all "=" entries ⇒ rebase-unpushed (pure rebase)', () => {
  const rd =
    '1:  ab01234 = 1:  cd56789 first work commit\n' +
    '2:  ef0abcd = 2:  12def34 second work commit\n';
  assert.equal(classifyAheadRangeDiff(rd), 'rebase-unpushed');
});

test('plan 988: classifyAheadRangeDiff — a ">" (commit only local) ⇒ new-work (block)', () => {
  const rd =
    '1:  ab01234 = 1:  cd56789 work commit\n' + '-:  ------- > 2:  99aa88b NEW unpushed commit\n';
  assert.equal(classifyAheadRangeDiff(rd), 'new-work');
});

test('plan 988: classifyAheadRangeDiff — a "!" (patch changed) ⇒ new-work (block)', () => {
  assert.equal(classifyAheadRangeDiff('1:  ab01234 ! 1:  cd56789 amended commit'), 'new-work');
});

test('plan 988: classifyAheadRangeDiff — a "<" (commit dropped) ⇒ new-work (block)', () => {
  assert.equal(classifyAheadRangeDiff('1:  ab01234 < -:  ------- dropped commit'), 'new-work');
});

test('plan 988: classifyAheadRangeDiff — empty / unparseable ⇒ new-work (conservative)', () => {
  assert.equal(classifyAheadRangeDiff(''), 'new-work');
  assert.equal(classifyAheadRangeDiff('  \n  '), 'new-work');
  assert.equal(classifyAheadRangeDiff('garbage line that is not a range-diff entry'), 'new-work');
});

// ── plan 2471: land-lib's shared run() helper retries the fetch-side ref-CAS race ───────────
// Live crash 2026-07-25: recoverRebasedUnpushed's bare `run(wtPath, ['fetch', 'origin'])` died
// on `error: fetching ref refs/remotes/origin/master failed: incorrect old value provided` — a
// sibling session's concurrent push moved origin/master mid-fetch. `run()` now delegates to
// coord-git's gitWithLockRetry (the one shared seam every land-lib call site goes through), so
// this transient self-heals instead of surfacing a raw stack trace mid-land. `run` is exported
// specifically so a fake `_git` can be injected via its third (opts) argument without needing to
// provoke a real concurrent-push race, which cannot be done on demand.
test('plan 2471: run() retries a "fetching ref … failed: incorrect old value provided" race then succeeds', () => {
  let n = 0;
  const _git = () => {
    if (++n <= 2)
      throw new Error(
        'error: fetching ref refs/remotes/origin/master failed: incorrect old value provided',
      );
    return 'fetched output';
  };
  const out = run('/irrelevant/dir', ['fetch', 'origin'], { attempts: 5, delayMs: 1, _git });
  assert.equal(out, 'fetched output');
  assert.equal(n, 3, 'retried twice (fetch ref-update race) then succeeded');
});

test('plan 2471: run() exhausts a persistent ref-update race with a clean, attributable error (not a raw stack trace)', () => {
  const _git = () => {
    throw new Error(
      'error: fetching ref refs/remotes/origin/master failed: incorrect old value provided',
    );
  };
  assert.throws(
    () => run('/irrelevant/dir', ['fetch', 'origin'], { attempts: 3, delayMs: 1, _git }),
    /coord-git: `git fetch origin` blocked by index\.lock \/ transient index-write \/ ref-lock race \/ ref-update race after 3 attempts/,
  );
});

test('plan 2471: run() still surfaces a genuine non-transient error immediately, unretried', () => {
  let n = 0;
  const _git = () => {
    n++;
    throw new Error('fatal: repository not found');
  };
  assert.throws(
    () => run('/irrelevant/dir', ['fetch', 'origin'], { attempts: 5, delayMs: 1, _git }),
    /repository not found/,
  );
  assert.equal(n, 1, 'a non-lock, non-transient error is never retried');
});

// advance origin/master by one non-conflicting commit (a sibling landing), leaving the
// working tree back on `branch`.
function advanceMaster(s, file, content, branch) {
  s.g(s.main, ['checkout', 'master']);
  writeFileSync(join(s.main, file), content);
  s.g(s.main, ['add', file]);
  s.g(s.main, ['commit', '-m', `master advance ${file}`]);
  s.g(s.main, ['push', 'origin', 'master']);
  s.g(s.main, ['checkout', branch]);
}

test('plan 988: a rebased-but-unpushed branch self-recovers, then syncBranchOntoMaster lands it', () => {
  const s = sandbox();
  // a feature branch with work, pushed (as pickup-plan would push it)
  s.g(s.main, ['checkout', '-b', 'worktree-r', 'origin/master']);
  writeFileSync(join(s.main, 'work.txt'), 'work\n');
  s.g(s.main, ['add', 'work.txt']);
  s.g(s.main, ['commit', '-m', 'feat work']);
  s.g(s.main, ['push', 'origin', 'worktree-r']);
  const originBeforeCrash = s.g(s.main, ['rev-parse', 'origin/worktree-r']);

  // a sibling advances origin/master, then a crashed land rebases the branch onto it
  // but DIES before pushing the rebased tip (origin/worktree-r stays at originBeforeCrash).
  advanceMaster(s, 'sibling.txt', 'sibling\n', 'worktree-r');
  s.g(s.main, ['fetch', 'origin']);
  s.g(s.main, ['rebase', 'origin/master']); // local ahead of origin/worktree-r, NOT pushed
  assert.ok(
    s.g(s.main, ['rev-list', 'origin/worktree-r..worktree-r']),
    'precondition: local is ahead of origin (the crashed rebase)',
  );

  // plan 3503 gpt-review round 2 (84f6f3): prep's no-fetch inspection and recovery's fetched
  // inspection are the SAME read-only classifier. With identical refs they must return the same
  // verdict, and neither may mutate the worktree/branch before recovery deliberately resets it.
  const localRebasedTip = s.g(s.main, ['rev-parse', 'worktree-r']);
  const prepInspection = inspectRebasedUnpushed(s.main, 'worktree-r', { mayFetch: false });
  const recoveryInspection = inspectRebasedUnpushed(s.main, 'worktree-r', { mayFetch: true });
  assert.equal(prepInspection.classification, 'rebase-unpushed');
  assert.equal(recoveryInspection.classification, prepInspection.classification);
  assert.equal(s.g(s.main, ['rev-parse', 'worktree-r']), localRebasedTip);

  const rec = recoverRebasedUnpushed(s.main, 'worktree-r');
  assert.equal(rec.ahead, true);
  assert.equal(rec.recovered, true, 'a pure rebase of the SAME work is auto-recoverable');
  // the branch was reset back to origin/worktree-r (the pre-crash rebase) — no new work lost
  assert.equal(s.g(s.main, ['rev-parse', 'worktree-r']), originBeforeCrash);

  // and a plain re-run now lands: branch-sync redoes the rebase onto the live master + pushes
  const sync = syncBranchOntoMaster(s.main, 'worktree-r');
  assert.equal(sync.conflicted, false);
  assert.equal(sync.pushBlocked, undefined);
  s.g(s.main, ['fetch', 'origin']);
  assert.equal(
    s.g(s.main, ['rev-parse', 'origin/worktree-r']),
    s.g(s.main, ['rev-parse', 'worktree-r']),
    'origin/<branch> == local after the recovered land — no unpushed state remains',
  );
  // the rebased branch sits on top of the advanced origin/master
  s.g(s.main, ['merge-base', '--is-ancestor', 'origin/master', 'worktree-r']);
});

test('plan 988: a genuinely-new unpushed commit is NOT auto-recovered (safety check preserved)', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-n', 'origin/master']);
  writeFileSync(join(s.main, 'w.txt'), 'w\n');
  s.g(s.main, ['add', 'w.txt']);
  s.g(s.main, ['commit', '-m', 'feat w']);
  s.g(s.main, ['push', 'origin', 'worktree-n']);

  // a NEW unpushed commit (real un-reviewed work) — NOT a rebase of origin's work
  writeFileSync(join(s.main, 'new.txt'), 'new unpushed\n');
  s.g(s.main, ['add', 'new.txt']);
  s.g(s.main, ['commit', '-m', 'NEW unpushed work']);
  const tipBefore = s.g(s.main, ['rev-parse', 'worktree-n']);

  const rec = recoverRebasedUnpushed(s.main, 'worktree-n');
  assert.equal(rec.ahead, true);
  assert.equal(rec.recovered, false, 'real unpushed work must still block');
  assert.ok(rec.aheadShas, 'the blocking reason carries the unpushed sha(s)');
  // the branch was NOT reset — the new commit is intact (no silent data loss)
  assert.equal(s.g(s.main, ['rev-parse', 'worktree-n']), tipBefore);
  assert.match(s.g(s.main, ['log', '--oneline']), /NEW unpushed work/);
});

test('plan 988: a branch already in sync (origin == local) is a no-op (ahead:false)', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-s', 'origin/master']);
  writeFileSync(join(s.main, 's.txt'), 's\n');
  s.g(s.main, ['add', 's.txt']);
  s.g(s.main, ['commit', '-m', 'feat s']);
  s.g(s.main, ['push', 'origin', 'worktree-s']);

  const rec = recoverRebasedUnpushed(s.main, 'worktree-s');
  assert.equal(rec.ahead, false);
  assert.equal(rec.recovered, undefined);
});

// ── plan 1000 Task 3: name the real culprit on a seed/builder land conflict ──
const NUL = '\u0000';

test('attributeConflict: a conflicted file landed by one plan names that plan', () => {
  const fakeRun = (_cwd, args) => {
    const path = args[args.length - 1];
    assert.equal(path, 'apply-chainx-prices.py');
    assert.equal(args[1], 'BASE..origin/master'); // <base>..origin/master per the plan
    // --full-history is REQUIRED: default simplification prunes the landing merge commit
    // (TREESAME to the side branch), and only the merge subject carries the plan id.
    assert.ok(args.includes('--full-history'), 'must pass --full-history');
    return `0ad73bf4c0011${NUL}Merge worktree-993-ChainX-pricelist-gaps: done 993-ChainX-pricelist-gaps`;
  };
  const out = attributeConflict('/wt', ['apply-chainx-prices.py'], 'BASE', { run: fakeRun });
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'apply-chainx-prices.py');
  assert.deepEqual(
    out[0].plans.map((p) => p.id),
    ['993'],
  );
  assert.equal(out[0].plans[0].sha, '0ad73bf4c0011');
});

test('attributeConflict: multiple landing plans (incl 4-digit id) are all named, de-duped', () => {
  const fakeRun = () =>
    [
      `aaaaaaaaaaa1${NUL}Merge worktree-1000-Infra-foo: done 1000-Infra-foo`,
      `bbbbbbbbbbb2${NUL}Merge worktree-996-valp-synth: done 996-valp-synth`,
      `ccccccccccc3${NUL}Merge worktree-996-valp-synth: done 996-valp-synth`,
    ].join('\n');
  const out = attributeConflict('/wt', ['seed-records.json'], 'BASE', { run: fakeRun });
  assert.deepEqual(
    out[0].plans.map((p) => p.id),
    ['1000', '996'],
  );
  assert.equal(out[0].commits.length, 3);
});

test('attributeConflict: a file touched only by a non-plan commit yields no plan but surfaces the commit', () => {
  const fakeRun = () => `deadbeef0001${NUL}chore: hand-edit on master`;
  const out = attributeConflict('/wt', ['x.txt'], 'BASE', { run: fakeRun });
  assert.deepEqual(out[0].plans, []);
  assert.equal(out[0].commits.length, 1);
  assert.equal(out[0].commits[0].subject, 'chore: hand-edit on master');
});

test('attributeConflict: a git failure for a path yields empty attribution, never throws', () => {
  const fakeRun = () => {
    throw new Error('git boom');
  };
  const out = attributeConflict('/wt', ['x.txt'], 'BASE', { run: fakeRun });
  assert.deepEqual(out, [{ path: 'x.txt', plans: [], commits: [] }]);
});

test('formatConflictCulprits: renders the landing plan(s) per conflicted path', () => {
  const s = formatConflictCulprits([
    {
      path: 'apply-chainx-prices.py',
      plans: [{ id: '993', sha: '0ad73bf4c0011', subject: 'Merge worktree-993-x: done 993-x' }],
      commits: [],
    },
  ]);
  assert.match(s, /apply-chainx-prices\.py/);
  assert.match(s, /plan 993/);
  assert.match(s, /0ad73bf4c/);
});

test('formatConflictCulprits: an unattributed path reports the raw commit, not a guess', () => {
  const s = formatConflictCulprits([
    { path: 'x.txt', plans: [], commits: [{ sha: 'deadbeef0001', subject: 'chore: hand-edit' }] },
  ]);
  assert.match(s, /x\.txt/);
  assert.match(s, /no plan-tagged/i);
  assert.match(s, /deadbeef0/);
});

test('unmergedPathsFromPorcelain: extracts only the unmerged (UU/AA/…) paths from porcelain status', () => {
  const status = [
    'UU shared.py',
    'AA both-added.txt',
    ' M normal-mod.txt',
    '?? untracked.txt',
    'DU del-mod.txt',
    'M  staged.txt',
  ].join('\n');
  assert.deepEqual(unmergedPathsFromPorcelain(status), [
    'shared.py',
    'both-added.txt',
    'del-mod.txt',
  ]);
});

test('unmergedPathsFromPorcelain: empty / clean status yields no paths', () => {
  assert.deepEqual(unmergedPathsFromPorcelain(''), []);
  assert.deepEqual(unmergedPathsFromPorcelain(' M only-modified.txt\n?? new.txt'), []);
});

test('syncBranchOntoMaster: a real conflict names the sibling plan that landed the file', () => {
  const s = sandbox();
  // a shared file on master both branches will edit
  writeFileSync(join(s.main, 'shared.py'), 'base\n');
  s.g(s.main, ['add', 'shared.py']);
  s.g(s.main, ['commit', '-m', 'add shared.py']);
  s.g(s.main, ['push', 'origin', 'master']);
  // OUR branch (linear) edits shared.py
  s.g(s.main, ['checkout', '-b', 'worktree-mine', 'origin/master']);
  writeFileSync(join(s.main, 'shared.py'), 'MY EDIT\n');
  s.g(s.main, ['add', 'shared.py']);
  s.g(s.main, ['commit', '-m', 'mine edits shared.py']);
  s.g(s.main, ['push', 'origin', 'worktree-mine']);
  // a SIBLING plan lands a CONFLICTING edit via a --no-ff merge with the canonical
  // spine subject — its OWN work-commit subject carries no plan id; only the merge does.
  s.g(s.main, ['checkout', '-b', 'worktree-993-chainx-gaps', 'origin/master']);
  writeFileSync(join(s.main, 'shared.py'), 'SIBLING 993 EDIT\n');
  s.g(s.main, ['add', 'shared.py']);
  s.g(s.main, ['commit', '-m', 'price(chainx): rewrite gaps']); // NO plan id in this subject
  s.g(s.main, ['checkout', 'master']);
  s.g(s.main, [
    'merge',
    '--no-ff',
    'worktree-993-chainx-gaps',
    '-m',
    'Merge worktree-993-chainx-gaps: done 993-chainx-gaps',
  ]);
  s.g(s.main, ['push', 'origin', 'master']);
  // sync OUR branch onto the advanced master → conflict on shared.py
  s.g(s.main, ['checkout', 'worktree-mine']);

  const reb = syncBranchOntoMaster(s.main, 'worktree-mine');

  assert.equal(reb.conflicted, true);
  assert.ok(Array.isArray(reb.culprits), 'culprits must be an array');
  const py = reb.culprits.find((c) => c.path === 'shared.py');
  assert.ok(py, 'shared.py must appear in culprits');
  assert.deepEqual(
    py.plans.map((p) => p.id),
    ['993'],
    'the conflict must be attributed to plan 993 (the landing merge)',
  );
  // plan 3090: a genuine conflict keeps the UNCHANGED shape — it must never also carry
  // the non-conflict syncFailed marker.
  assert.equal(reb.syncFailed, undefined, 'a genuine conflict must not carry syncFailed');
  // plan 3974 T2a: a real conflict is the author's halt — it must never be retried or
  // auto-continued, so it burns zero retries.
  assert.equal(reb.lockRetry, 0, 'a genuine conflict must not be retried');
  // plan 3974 T2b: a genuine conflict must never carry the classifier's own
  // status-unreadable marker — the two halts are distinct and the public result never
  // leaks the internal statusUnknown field either way.
  assert.ok(!reb.statusUnknown, 'a genuine conflict must not read as an unreadable status');
});

// ── plan 3090: a non-conflict rebase/freshen failure must not read as a clean sync ──
// A rebase that fails WITHOUT leaving unmerged paths (index.lock/ref-lock race, rerere
// failure, hook error, killed child) used to return `conflicted: false` with no failure
// marker at all — rebaseSeam then read `!r.conflicted` as "nothing to report" and the
// caller proceeded as though the sync had succeeded, with the branch never actually
// rebased or pushed. Deterministically reproduced here: pre-creating a `rebase-merge`
// directory in the gitdir makes git itself refuse to START the rebase ("It seems that
// there is already a rebase-merge directory") — a clean-tree, non-conflict failure.
test('plan 3090: a non-conflict rebase failure (stale rebase-merge dir) returns syncFailed, not a false-clean read', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-nc', 'origin/master']);
  writeFileSync(join(s.main, 'nc.txt'), 'feature\n');
  s.g(s.main, ['add', 'nc.txt']);
  s.g(s.main, ['commit', '-m', 'feature work']);
  s.g(s.main, ['push', 'origin', 'worktree-nc']);
  // master advances (non-conflicting) so the rebase has something to replay
  advanceMaster(s, 'other.txt', 'sibling\n', 'worktree-nc');

  // Resolve the gitdir via `git rev-parse --git-dir` rather than assuming `.git` is a
  // directory — the worktree consuming this seam may be a LINKED worktree, whose
  // git-dir is an absolute path elsewhere (`.../worktrees/<name>`), not a relative `.git`.
  const gitDir = s.g(s.main, ['rev-parse', '--git-dir']);
  const gitDirAbs = isAbsolute(gitDir) ? gitDir : join(s.main, gitDir);
  mkdirSync(join(gitDirAbs, 'rebase-merge'), { recursive: true });

  const r = syncBranchOntoMaster(s.main, 'worktree-nc');

  assert.equal(r.conflicted, false, 'no unmerged paths — the working tree was never touched');
  assert.equal(
    r.syncFailed,
    true,
    'a non-conflict rebase failure must be flagged, not silently clean',
  );
  assert.ok(
    r.syncDetail && r.syncDetail.length > 0,
    'syncDetail carries the captured git output for diagnosis',
  );
  assert.equal(r.pushBlocked, undefined);
  // plan 3974 T2a: this failure shape ("already a rebase-merge directory") matches neither
  // LOCK_RX nor the rescheduled-pick hint, so it must never burn a retry either.
  assert.equal(r.lockRetry, 0, 'a non-lock, non-reschedule failure must not be retried');
});

// ── plan 3974 T2a: bounded retry around a rebase/merge that lost the shared worktree's
// index.lock to a sibling reader (a poller's `git status`, observed live 2026-09-12 on plan
// 3941's land) — instead of the pre-existing `LAND_BLOCKED` misclassification above.

test('plan 3974 T2a: a transient index.lock that clears mid-retry succeeds (no syncFailed) and tallies lockRetry', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-lockretry', 'origin/master']);
  writeFileSync(join(s.main, 'work.txt'), 'feature\n');
  s.g(s.main, ['add', 'work.txt']);
  s.g(s.main, ['commit', '-m', 'feature work']);
  s.g(s.main, ['push', 'origin', 'worktree-lockretry']);
  // master advances (non-conflicting) so the rebase has something to replay
  advanceMaster(s, 'other.txt', 'sibling\n', 'worktree-lockretry');

  // A real pre-placed lock file races against syncBranchOntoMaster's OWN preliminary git calls
  // (fetch, the plan-3080 graft check, mergeBearing, merge-base) before it ever reaches the
  // rebase — on a loaded box those alone can run past a short clearing delay, making the very
  // first rebase attempt land AFTER the lock is already gone (an accidental zero-retry pass,
  // not a proof of anything). A narrow injectable counter removes that timing dependency
  // entirely: the first two calls throw the REAL captured index.lock wording, and the third
  // performs the REAL rebase (the exact command production's own runRebaseOrMerge would run) —
  // only the FAILURE COUNT is synthetic, the eventual git operation is real.
  const onto = s.g(s.main, ['rev-parse', 'origin/master']);
  let calls = 0;
  const flakyThenReal = () => {
    calls++;
    if (calls <= 2) {
      const e = new Error('rebase failed');
      e.stderr = "error: Unable to create '.git/index.lock': File exists.\n";
      throw e;
    }
    execFileSync('git', ['-C', s.main, 'rebase', onto], { encoding: 'utf8' });
  };

  const r = syncBranchOntoMaster(s.main, 'worktree-lockretry', { _rebaseOrMerge: flakyThenReal });

  assert.equal(calls, 3, 'two failures then the real rebase on the third call');
  assert.equal(r.syncFailed, undefined, 'a transient lock that clears must not read as syncFailed');
  assert.equal(r.conflicted, false);
  assert.equal(r.lockRetry, 2, 'exactly the two retries that preceded the successful attempt');
  assert.equal(r.pushBlocked, undefined, 'the retried rebase must still reach the push');
});

test('plan 3974 T2a: exhausted lock retries still return syncFailed (unchanged message), lockRetry counts every try', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-lockexhaust', 'origin/master']);
  writeFileSync(join(s.main, 'work.txt'), 'feature\n');
  s.g(s.main, ['add', 'work.txt']);
  s.g(s.main, ['commit', '-m', 'feature work']);
  s.g(s.main, ['push', 'origin', 'worktree-lockexhaust']);
  advanceMaster(s, 'other.txt', 'sibling\n', 'worktree-lockexhaust');

  // A lock that NEVER clears — every attempt (the first + every retry) hits the same
  // LOCK_RX-matching failure, so the bounded budget must exhaust to the existing syncFailed
  // classification rather than spin forever.
  let calls = 0;
  const alwaysLocked = () => {
    calls++;
    const e = new Error('rebase failed');
    e.stderr = "error: Unable to create '.git/index.lock': File exists.\n";
    throw e;
  };

  const r = syncBranchOntoMaster(s.main, 'worktree-lockexhaust', { _rebaseOrMerge: alwaysLocked });

  assert.equal(r.conflicted, false);
  assert.equal(
    r.syncFailed,
    true,
    'exhausted retries fall through to the existing syncFailed shape',
  );
  assert.match(r.syncDetail, /index\.lock/i);
  assert.ok(r.lockRetry >= 5, 'the bounded retry budget (≤5 tries) must be fully spent');
  assert.equal(calls, r.lockRetry + 1, 'one initial attempt plus one call per retry');
});

// ── plan 3974 T2b: classifier hardening (gpt-review 6155b4/124aae/6b2dfc/547d0a/71a161) —
// the status read that decides conflicted-vs-not must not itself take the index lock this
// whole loop exists to survive, must not let its own failure escape uncaught, and a
// merge-bearing retry must clear a leftover MERGE_HEAD before restarting. ──

test('plan 3974 T2b: classifyFailure reads status via a lock-free, self-contained probe', () => {
  const source = readFileSync(new URL('./land-lib.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const classifyFailure = (e) => {');
  assert.ok(start !== -1, 'classifyFailure must exist in land-lib.mjs');
  const end = source.indexOf('// plan 3974 T2a: bounded retry loop.', start);
  assert.ok(end !== -1 && end > start, 'the retry loop must follow classifyFailure');
  const body = source.slice(start, end);

  // --no-optional-locks is a GLOBAL option and must precede the subcommand, or git treats
  // it as a `status` pathspec instead of skipping the lock for this read.
  assert.match(
    body,
    /tryRun\(wtPath, \['--no-optional-locks', 'status', '--porcelain'\]\)/,
    'the status read must ask git to skip the index lock, ordered before the subcommand',
  );
  // never the lock-retrying run()/gitWithLockRetry wrapper — its own wait-for-lock pre-poll
  // would otherwise still sit and wait on the very lock this read no longer needs.
  assert.doesNotMatch(
    body,
    /\brun\(wtPath, \['status'/,
    'the status read must not go through the lock-retrying run() wrapper',
  );
  // and it must be wrapped in its OWN try/catch so a failure here cannot escape uncaught
  // and skip the lockish/resumable decision below.
  assert.match(
    body,
    /try\s*\{\s*\n\s*status = tryRun\(wtPath, \['--no-optional-locks'/,
    'the status read sits inside its own try',
  );
  assert.match(body, /catch \(statusErr\)/, 'the status read has a dedicated catch');
  assert.match(body, /statusUnknown = true/, 'a failed read is flagged, not silently swallowed');
});

test('plan 3974 T2b: a lock-shaped failure whose OWN status read fails halts contained — never retried, never misread as a conflict', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-statusfail', 'origin/master']);
  writeFileSync(join(s.main, 'work.txt'), 'feature\n');
  s.g(s.main, ['add', 'work.txt']);
  s.g(s.main, ['commit', '-m', 'feature work']);
  s.g(s.main, ['push', 'origin', 'worktree-statusfail']);
  advanceMaster(s, 'other.txt', 'sibling\n', 'worktree-statusfail');

  const gitDir = s.g(s.main, ['rev-parse', '--git-dir']);
  const gitDirAbs = isAbsolute(gitDir) ? gitDir : join(s.main, gitDir);
  const indexPath = join(gitDirAbs, 'index');
  const indexBackup = join(gitDirAbs, 'index.bak-3974');

  // `_rebaseOrMerge` is the ONLY injectable seam in this module (grep `_git`/`opts.` in
  // land-lib.mjs: the module-local `tryRun` the classifier's status read goes through takes
  // no opts) — there is no way to fake classifyFailure's OWN status call directly. The
  // deterministic route verified by hand (replacing `.git/index` with a directory) is real
  // filesystem state `git status`/`git --no-optional-locks status` refuses to read ("index
  // file smaller than expected") while `rev-parse`/`rev-list`/`merge-base`/`for-each-ref` —
  // every git call this function makes BEFORE the rebase/merge attempt, plus the classifier's
  // own best-effort conflictCommits count — tolerate it untouched. Corrupting the index from
  // INSIDE the override (the exact moment the real attempt would run) means every earlier real
  // call (fetch, the graft check, mergeBearing detection, merge-base) has already succeeded
  // normally, so only the classifier's status read is exercised.
  let calls = 0;
  const failAndBreakStatus = () => {
    calls++;
    renameSync(indexPath, indexBackup);
    mkdirSync(indexPath);
    const e = new Error('rebase failed');
    e.stderr = "error: Unable to create '.git/index.lock': File exists.\n";
    throw e;
  };

  let r;
  try {
    r = syncBranchOntoMaster(s.main, 'worktree-statusfail', {
      _rebaseOrMerge: failAndBreakStatus,
    });
  } finally {
    // restore for hygiene even though this sandbox dir is disposable
    try {
      rmSync(indexPath, { recursive: true, force: true });
      renameSync(indexBackup, indexPath);
    } catch {
      /* best-effort cleanup */
    }
  }

  assert.equal(calls, 1, 'the classifier halts on the first failure — it must never be retried');
  assert.equal(
    r.syncFailed,
    true,
    'an unreadable tree halts as syncFailed, never a false-clean read',
  );
  assert.equal(
    r.conflicted,
    false,
    'never misclassified as a conflict — that would run culprit attribution over garbage',
  );
  assert.equal(r.lockRetry, 0, 'no retry attempted despite the lock-shaped stderr');
  assert.match(
    r.syncDetail,
    /<status unreadable:/,
    'syncDetail names the unreadable-status marker',
  );
});

test('plan 3974 T2b: a lock-shaped failure on a merge-bearing branch aborts a leftover MERGE_HEAD before restarting the merge', () => {
  const s = mergeBearingSetup();
  const gitDir = s.g(s.main, ['rev-parse', '--git-dir']);
  const gitDirAbs = isAbsolute(gitDir) ? gitDir : join(s.main, gitDir);
  const onto = s.g(s.main, ['rev-parse', 'origin/master']);

  // Building a REAL left-behind MERGE_HEAD by racing an actual index.lock against an actual
  // `git merge` is timing-dependent (verified by hand: a lock present from before the merge
  // starts makes git fail before it ever writes MERGE_HEAD — there is no reproducible window
  // to land inside it). Writing MERGE_HEAD directly reproduces the SAME state the comment in
  // land-lib.mjs documents as ambiguous by construction: `mergeHeadExists` is a bare
  // `rev-parse -q --verify MERGE_HEAD`, and `git merge --abort` recovers from it exactly the
  // same way, regardless of whether MERGE_HEAD was left by git itself mid-merge or written by
  // hand — verified by hand: a hand-written MERGE_HEAD aborts cleanly and a following real
  // merge then succeeds.
  let calls = 0;
  const lockThenRealMerge = () => {
    calls++;
    if (calls === 1) {
      writeFileSync(join(gitDirAbs, 'MERGE_HEAD'), `${onto}\n`);
      const e = new Error('merge failed');
      e.stderr = "error: Unable to create '.git/index.lock': File exists.\n";
      throw e;
    }
    // second attempt: the real merge, exactly what production's own runRebaseOrMerge runs
    execFileSync('git', ['-C', s.main, 'merge', '--no-ff', onto, '-m', 'freshen retry'], {
      encoding: 'utf8',
    });
  };

  const r = syncBranchOntoMaster(s.main, 'worktree-m', { _rebaseOrMerge: lockThenRealMerge });

  assert.equal(calls, 2, 'one failed attempt (leaving MERGE_HEAD), one real retry');
  assert.equal(r.syncFailed, undefined, 'the retried merge must complete cleanly');
  assert.equal(r.conflicted, false);
  assert.equal(r.mergeBearing, true);
  assert.equal(r.lockRetry, 1, 'exactly the one retry that preceded the successful attempt');
  assert.equal(r.pushBlocked, undefined, 'the retried merge must still reach the push');
  assert.equal(
    existsSync(join(gitDirAbs, 'MERGE_HEAD')),
    false,
    'the leftover MERGE_HEAD was aborted before the restart, not left dangling',
  );
  assert.match(
    s.g(s.main, ['log', '--oneline', '-3']),
    /freshen retry/,
    'the second (real) merge attempt actually landed',
  );
});

// plan 3974 T0 (2026-09-12, 100% repro rate): the SAME mid-replay index.lock collision surfaces
// as EITHER shape below — git's sequencer sometimes catches it and prints the "It has been
// rescheduled" hint, and sometimes emits a bare `fatal:` with NO hint at all — but leaves the
// IDENTICAL leftover rebase-merge state either way. The resume decision must key off the
// index.lock text + surviving state, never off the hint (T0 finding: requiring the hint would
// silently miss the no-hint shape and misclassify it as a from-scratch restart).
function buildResumableReschedule(branchSuffix) {
  const s = sandbox();
  const branch = `worktree-resched-${branchSuffix}`;
  s.g(s.main, ['checkout', '-b', branch, 'origin/master']);
  writeFileSync(join(s.main, 'w1.txt'), 'one\n');
  s.g(s.main, ['add', 'w1.txt']);
  s.g(s.main, ['commit', '-m', 'pick one']);
  s.g(s.main, ['push', 'origin', branch]);
  advanceMaster(s, 'other.txt', 'sibling\n', branch);

  // Build a REAL, resumable rebase-merge state: `-x "exit 1"` inserts an exec AFTER the (one)
  // pick and that exec fails, pausing the rebase cleanly right after the pick commits — clean
  // tree, no unmerged paths, the exact shape a mid-replay index.lock hit leaves behind. Git never
  // retries a failed exec on `--continue`; with nothing left in the todo after it, one continue
  // concludes the whole rebase (verified empirically: a SECOND commit here would need a SECOND
  // continue, one per trailing exec — kept to one commit so the single continue this plan's own
  // retry issues is enough to finish it for real).
  const onto = s.g(s.main, ['rev-parse', 'origin/master']);
  try {
    s.g(s.main, ['rebase', '-x', 'exit 1', onto]);
    assert.fail('the exec pause is expected to exit non-zero');
  } catch {
    /* expected — the paused rebase reports non-zero from the CLI's perspective */
  }
  const gitDir = s.g(s.main, ['rev-parse', '--git-dir']);
  const gitDirAbs = isAbsolute(gitDir) ? gitDir : join(s.main, gitDir);
  assert.ok(
    existsSync(join(gitDirAbs, 'rebase-merge')),
    'precondition: a real, resumable rebase-merge state exists',
  );
  assert.equal(
    s.g(s.main, ['status', '--porcelain']),
    '',
    'precondition: the tree is clean (pick one already committed, nothing unmerged)',
  );
  return { s, branch, gitDirAbs };
}

test('plan 3974 T2a: a rescheduled pick WITH the "It has been rescheduled" hint is resumed via `rebase --continue`, never restarted', () => {
  const { s, branch, gitDirAbs } = buildResumableReschedule('hint');

  // Only the FAILURE MESSAGE is synthetic (the exact hint text from plan 3974's own captured
  // incident log) — everything downstream of the classification (the `--continue` call, and the
  // rebase state it resumes) is real git against the real state built above.
  let calls = 0;
  const fakeReschedule = () => {
    calls++;
    if (calls === 1) {
      const e = new Error('rebase pick failed');
      e.stderr =
        "error: Unable to create '.git/index.lock': File exists.\n\n" +
        'Another git process seems to be running in this repository...\n' +
        'hint: Could not execute the todo command\n' +
        'hint:\n' +
        'hint:     pick 43864291c58208f02ab42e852031e9c678dd5981 # pick one\n' +
        'hint:\n' +
        'hint: It has been rescheduled; To edit the command before continuing, please\n' +
        'hint: edit the todo list first:\n';
      throw e;
    }
    // Never reached if the resume correctly used `rebase --continue` instead of restarting —
    // a restart would re-invoke this override a second time and this throw makes that loud.
    throw new Error(
      'runRebaseOrMerge called a SECOND time — the retry RESTARTED instead of resuming',
    );
  };

  const r = syncBranchOntoMaster(s.main, branch, { _rebaseOrMerge: fakeReschedule });

  assert.equal(
    calls,
    1,
    'the from-scratch path must be called exactly once — the resume uses --continue',
  );
  assert.equal(r.syncFailed, undefined, 'the resumed rebase must complete cleanly');
  assert.equal(r.conflicted, false);
  assert.equal(r.lockRetry, 1);
  assert.equal(
    existsSync(join(gitDirAbs, 'rebase-merge')),
    false,
    'the rebase genuinely concluded',
  );
});

test("plan 3974 T2a: the SAME collision WITHOUT the hint (bare fatal, T0's other observed shape) is ALSO resumed via `rebase --continue`, never restarted", () => {
  const { s, branch, gitDirAbs } = buildResumableReschedule('nohint');

  // T0's second observed shape: the identical index.lock text, but git's sequencer did NOT print
  // the "It has been rescheduled" hint at all — no "hint:" lines, no mention of "rescheduled".
  // The resume must fire from the index.lock text + surviving state alone.
  let calls = 0;
  const fakeNoHint = () => {
    calls++;
    if (calls === 1) {
      const e = new Error('rebase pick failed');
      e.stderr = "fatal: Unable to create '.git/index.lock': File exists.\n";
      throw e;
    }
    throw new Error(
      'runRebaseOrMerge called a SECOND time — the retry RESTARTED instead of resuming',
    );
  };

  const r = syncBranchOntoMaster(s.main, branch, { _rebaseOrMerge: fakeNoHint });

  assert.equal(
    calls,
    1,
    'the from-scratch path must be called exactly once — the resume uses --continue',
  );
  assert.equal(r.syncFailed, undefined, 'the resumed rebase must complete cleanly');
  assert.equal(r.conflicted, false);
  assert.equal(r.lockRetry, 1);
  assert.equal(
    existsSync(join(gitDirAbs, 'rebase-merge')),
    false,
    'the rebase genuinely concluded',
  );
});

// ── plan 3974 round 2: the spine-rebase provenance marker, MERGE_HEAD ownership (a pre-existing
// MERGE_HEAD is not this sync's own, so it is refused rather than aborted), and abort-failure
// handling (a lock-shaped abort failure is itself a counted retry; any OTHER abort failure is
// reported as the sync failure it is, never masked) — gpt-review round 2 findings
// 69df5c/bb3c7a/a0f071/a400a4/9d27ba/382952/ffe707 (marker) and 4060f6 (MERGE_HEAD ownership)
// and 85b322/581629 (abort failure). ──

test('plan 3974 round 2: a SUCCESSFUL plain rebase leaves no spine-rebase marker behind', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-markerok', 'origin/master']);
  writeFileSync(join(s.main, 'work.txt'), 'feature\n');
  s.g(s.main, ['add', 'work.txt']);
  s.g(s.main, ['commit', '-m', 'feature work']);
  s.g(s.main, ['push', 'origin', 'worktree-markerok']);
  advanceMaster(s, 'other.txt', 'sibling\n', 'worktree-markerok');

  const r = syncBranchOntoMaster(s.main, 'worktree-markerok');

  assert.equal(r.syncFailed, undefined);
  assert.equal(r.conflicted, false);
  assert.equal(
    existsSync(spineRebaseMarkerPath(s.main)),
    false,
    'the marker must not survive a clean sync',
  );
  assert.equal(readSpineRebaseMarker(s.main), null);
});

test('plan 3974 round 2: a CONFLICT halt leaves no spine-rebase marker — the author now owns the rebase state, not the spine', () => {
  const s = sandbox();
  writeFileSync(join(s.main, 'shared.py'), 'base\n');
  s.g(s.main, ['add', 'shared.py']);
  s.g(s.main, ['commit', '-m', 'add shared.py']);
  s.g(s.main, ['push', 'origin', 'master']);
  s.g(s.main, ['checkout', '-b', 'worktree-markerconflict', 'origin/master']);
  writeFileSync(join(s.main, 'shared.py'), 'MY EDIT\n');
  s.g(s.main, ['add', 'shared.py']);
  s.g(s.main, ['commit', '-m', 'mine edits shared.py']);
  s.g(s.main, ['push', 'origin', 'worktree-markerconflict']);
  s.g(s.main, ['checkout', 'master']);
  writeFileSync(join(s.main, 'shared.py'), 'SIBLING EDIT\n');
  s.g(s.main, ['add', 'shared.py']);
  s.g(s.main, ['commit', '-m', 'sibling edits shared.py']);
  s.g(s.main, ['push', 'origin', 'master']);
  s.g(s.main, ['checkout', 'worktree-markerconflict']);

  const r = syncBranchOntoMaster(s.main, 'worktree-markerconflict');

  assert.equal(
    r.conflicted,
    true,
    'precondition: this is a real rebase conflict, marker WAS written',
  );
  assert.equal(
    existsSync(spineRebaseMarkerPath(s.main)),
    false,
    'a conflict halt clears the marker too — it is provenance for a KILLED run only',
  );
});

test('plan 3974 round 2: an EXHAUSTED-lock syncFailed leaves no spine-rebase marker behind', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-markerexhaust', 'origin/master']);
  writeFileSync(join(s.main, 'work.txt'), 'feature\n');
  s.g(s.main, ['add', 'work.txt']);
  s.g(s.main, ['commit', '-m', 'feature work']);
  s.g(s.main, ['push', 'origin', 'worktree-markerexhaust']);
  advanceMaster(s, 'other.txt', 'sibling\n', 'worktree-markerexhaust');

  const alwaysLocked = () => {
    const e = new Error('rebase failed');
    e.stderr = "error: Unable to create '.git/index.lock': File exists.\n";
    throw e;
  };

  const r = syncBranchOntoMaster(s.main, 'worktree-markerexhaust', {
    _rebaseOrMerge: alwaysLocked,
  });

  assert.equal(r.syncFailed, true, 'precondition: the marker WAS written before this exhaustion');
  assert.equal(
    existsSync(spineRebaseMarkerPath(s.main)),
    false,
    'an exhausted-lock syncFailed must not leave the marker behind either',
  );
});

test('plan 3974 round 2: the spine-rebase marker exists WHILE the rebase is attempted, naming the onto sha the retry loop resolved', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-markerduring', 'origin/master']);
  writeFileSync(join(s.main, 'work.txt'), 'feature\n');
  s.g(s.main, ['add', 'work.txt']);
  s.g(s.main, ['commit', '-m', 'feature work']);
  s.g(s.main, ['push', 'origin', 'worktree-markerduring']);
  advanceMaster(s, 'other.txt', 'sibling\n', 'worktree-markerduring');
  const onto = s.g(s.main, ['rev-parse', 'origin/master']);
  // the branch tip BEFORE the sync ever touches it — the marker's `origHead` must name this
  // exact sha, not wherever HEAD ends up mid-retry
  const origHeadBefore = s.g(s.main, ['rev-parse', 'HEAD']);

  let calls = 0;
  const observeMarkerThenReal = () => {
    calls++;
    assert.equal(
      existsSync(spineRebaseMarkerPath(s.main)),
      true,
      'the marker must exist by the time this rebase/merge attempt runs',
    );
    const marker = readSpineRebaseMarker(s.main);
    assert.ok(marker, 'the marker must parse as JSON with onto/origHead/branch all present');
    assert.equal(marker.onto, onto, 'the marker names the SAME onto sha the sync resolved');
    assert.equal(
      marker.origHead,
      origHeadBefore,
      'the marker names the pre-rebase branch tip, captured before the sync moved anything',
    );
    assert.equal(
      marker.branch,
      'worktree-markerduring',
      'the marker names the branch this sync is rebasing',
    );
    if (calls === 1) {
      const e = new Error('rebase failed');
      e.stderr = "error: Unable to create '.git/index.lock': File exists.\n";
      throw e;
    }
    execFileSync('git', ['-C', s.main, 'rebase', onto], { encoding: 'utf8' });
  };

  const r = syncBranchOntoMaster(s.main, 'worktree-markerduring', {
    _rebaseOrMerge: observeMarkerThenReal,
  });

  assert.equal(calls, 2, 'the marker must still exist for the RETRY attempt too');
  assert.equal(r.syncFailed, undefined);
  assert.equal(r.lockRetry, 1);
  assert.equal(
    existsSync(spineRebaseMarkerPath(s.main)),
    false,
    'the marker is cleared once the loop finishes',
  );
});

test('plan 3974 round 2: a MERGE_HEAD that already exists at entry is refused, never aborted — it does not belong to this sync', () => {
  const s = mergeBearingSetup();
  const gitDir = s.g(s.main, ['rev-parse', '--git-dir']);
  const gitDirAbs = isAbsolute(gitDir) ? gitDir : join(s.main, gitDir);
  const onto = s.g(s.main, ['rev-parse', 'origin/master']);
  // simulate a merge already in progress in this worktree BEFORE the sync starts — e.g. the
  // author's own hand-run `git merge` they have not finished yet, unrelated to this sync
  writeFileSync(join(gitDirAbs, 'MERGE_HEAD'), `${onto}\n`);

  const r = syncBranchOntoMaster(s.main, 'worktree-m');

  assert.equal(r.syncFailed, true);
  assert.equal(r.conflicted, false);
  assert.equal(r.lockRetry, 0, 'refused up front — no retry attempted, no abort attempted');
  assert.equal(r.mergeBearing, true);
  assert.match(r.syncDetail, /MERGE_HEAD/, 'syncDetail names the pre-existing merge');
  assert.equal(
    existsSync(join(gitDirAbs, 'MERGE_HEAD')),
    true,
    'the pre-existing MERGE_HEAD must be left completely untouched, never aborted',
  );
});

test('plan 3974 round 3: a LINEAR branch with a pre-existing MERGE_HEAD is refused too — the refusal is not gated on mergeBearing', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'worktree-linearmergehead', 'origin/master']);
  writeFileSync(join(s.main, 'work.txt'), 'feature\n');
  s.g(s.main, ['add', 'work.txt']);
  s.g(s.main, ['commit', '-m', 'feature work']);
  s.g(s.main, ['push', 'origin', 'worktree-linearmergehead']);
  advanceMaster(s, 'other.txt', 'sibling\n', 'worktree-linearmergehead');
  const gitDir = s.g(s.main, ['rev-parse', '--git-dir']);
  const gitDirAbs = isAbsolute(gitDir) ? gitDir : join(s.main, gitDir);
  const onto = s.g(s.main, ['rev-parse', 'origin/master']);
  // this branch carries NO merge commits — a plain `git rebase` shape — yet a merge can still
  // be in flight in the worktree (e.g. the author's own hand-run `git merge` they have not
  // finished), unrelated to this sync
  writeFileSync(join(gitDirAbs, 'MERGE_HEAD'), `${onto}\n`);

  const neverCalled = () => {
    throw new Error('_rebaseOrMerge must never be called — the refusal happens before any attempt');
  };

  const r = syncBranchOntoMaster(s.main, 'worktree-linearmergehead', {
    _rebaseOrMerge: neverCalled,
  });

  assert.equal(r.syncFailed, true);
  assert.equal(r.conflicted, false);
  assert.equal(r.lockRetry, 0, 'refused up front — no retry attempted, no rebase attempted');
  assert.equal(r.mergeBearing, false, 'precondition: this branch carries no merge commits');
  assert.match(r.syncDetail, /MERGE_HEAD/, 'syncDetail names the pre-existing merge');
  assert.equal(
    existsSync(join(gitDirAbs, 'MERGE_HEAD')),
    true,
    'the pre-existing MERGE_HEAD must be left completely untouched, never aborted',
  );
  assert.equal(
    existsSync(spineRebaseMarkerPath(s.main)),
    false,
    'no marker either — the refusal happens before the marker would be written',
  );
});

test('plan 3974 round 2: a NON-lock abort failure is reported as its own syncFailed, never masked as a lock exhaustion', () => {
  const s = mergeBearingSetup();
  const gitDir = s.g(s.main, ['rev-parse', '--git-dir']);
  const gitDirAbs = isAbsolute(gitDir) ? gitDir : join(s.main, gitDir);
  const onto = s.g(s.main, ['rev-parse', 'origin/master']);
  const mergeHeadPath = join(gitDirAbs, 'MERGE_HEAD');

  // Both the merge/rebase attempt AND the abort inside the retry loop are driven entirely
  // through injectable seams here (`_rebaseOrMerge` / `_mergeAbort`) — no real filesystem
  // corruption, no background process, no timing of any kind.
  let rebaseOrMergeCalls = 0;
  const writeMergeHeadThenLock = () => {
    rebaseOrMergeCalls++;
    writeFileSync(mergeHeadPath, `${onto}\n`);
    const e = new Error('merge failed');
    e.stderr = "error: Unable to create '.git/index.lock': File exists.\n";
    throw e;
  };

  let abortCalls = 0;
  const nonLockAbortFailure = () => {
    abortCalls++;
    throw new Error('fatal: simulated abort failure (not a lock)');
  };

  const r = syncBranchOntoMaster(s.main, 'worktree-m', {
    _rebaseOrMerge: writeMergeHeadThenLock,
    _mergeAbort: nonLockAbortFailure,
  });

  assert.equal(
    rebaseOrMergeCalls,
    1,
    'never restarted — the abort failure is terminal, not retried as a fresh attempt',
  );
  assert.equal(abortCalls, 1, 'the non-lock abort failure is never retried as an abort either');
  assert.equal(r.syncFailed, true);
  assert.equal(r.conflicted, false);
  assert.equal(r.lockRetry, 1, 'only the ONE outer lock-shaped merge failure was counted');
  assert.match(
    r.syncDetail,
    /simulated abort failure/,
    "syncDetail carries the abort's OWN error text, not a generic message",
  );
  assert.equal(
    existsSync(mergeHeadPath),
    true,
    'the abort never completed — MERGE_HEAD is exactly where the failed abort left it',
  );
});

test('plan 3974 round 2: a LOCK-shaped abort failure is itself retried (counted, backed off) and the merge then lands', () => {
  const s = mergeBearingSetup();
  const gitDir = s.g(s.main, ['rev-parse', '--git-dir']);
  const gitDirAbs = isAbsolute(gitDir) ? gitDir : join(s.main, gitDir);
  const onto = s.g(s.main, ['rev-parse', 'origin/master']);
  const mergeHeadPath = join(gitDirAbs, 'MERGE_HEAD');

  let rebaseOrMergeCalls = 0;
  const writeMergeHeadThenRealMerge = () => {
    rebaseOrMergeCalls++;
    if (rebaseOrMergeCalls === 1) {
      writeFileSync(mergeHeadPath, `${onto}\n`);
      const e = new Error('merge failed');
      e.stderr = "error: Unable to create '.git/index.lock': File exists.\n";
      throw e;
    }
    // second attempt: the real merge, exactly what production's own runRebaseOrMerge runs
    execFileSync('git', ['-C', s.main, 'merge', '--no-ff', onto, '-m', 'freshen retry g'], {
      encoding: 'utf8',
    });
  };

  let abortCalls = 0;
  const lockThenSucceedAbort = () => {
    abortCalls++;
    if (abortCalls === 1) {
      const e = new Error('merge --abort failed');
      e.stderr = "error: Unable to create '.git/index.lock': File exists.\n";
      throw e;
    }
    // second attempt: clear the leftover MERGE_HEAD — the synthetic write above never touched
    // anything else (no real merge ever ran), so unlinking it IS the full, faithful recovery a
    // real `git merge --abort` performs against this exact state (verified by hand earlier: a
    // real abort against a hand-written MERGE_HEAD with no other altered state leaves the
    // identical clean tree this leaves).
    unlinkSync(mergeHeadPath);
  };

  const r = syncBranchOntoMaster(s.main, 'worktree-m', {
    _rebaseOrMerge: writeMergeHeadThenRealMerge,
    _mergeAbort: lockThenSucceedAbort,
  });

  assert.equal(rebaseOrMergeCalls, 2, 'one failed merge attempt, one real retry');
  assert.equal(abortCalls, 2, 'one failed abort attempt, one successful retry');
  assert.equal(r.syncFailed, undefined, 'the retried merge must complete cleanly');
  assert.equal(r.conflicted, false);
  assert.equal(r.lockRetry, 2, 'one retry for the merge lock, one retry for the abort lock');
  assert.equal(
    existsSync(mergeHeadPath),
    false,
    'the abort eventually succeeded — MERGE_HEAD is gone',
  );
  assert.match(
    s.g(s.main, ['log', '--oneline', '-3']),
    /freshen retry g/,
    'the second (real) merge attempt actually landed',
  );
});

test('plan 3974 round 3: readSpineRebaseMarker returns null for a hand-written marker missing origHead (or branch)', () => {
  const s = sandbox();
  const markerPath = spineRebaseMarkerPath(s.main);
  assert.ok(markerPath, 'precondition: a real repo resolves a marker path');

  // onto alone (the round-2 shape) is no longer enough — origHead and branch are both required
  writeFileSync(markerPath, JSON.stringify({ onto: 'deadbeef0001' }));
  assert.equal(
    readSpineRebaseMarker(s.main),
    null,
    'missing origHead AND branch: not a valid marker',
  );

  writeFileSync(markerPath, JSON.stringify({ onto: 'deadbeef0001', origHead: 'cafef00d0002' }));
  assert.equal(readSpineRebaseMarker(s.main), null, 'missing branch: still not a valid marker');

  writeFileSync(
    markerPath,
    JSON.stringify({ onto: 'deadbeef0001', origHead: '', branch: 'worktree-x' }),
  );
  assert.equal(
    readSpineRebaseMarker(s.main),
    null,
    'an EMPTY origHead is treated the same as a missing one',
  );

  // a fully-formed marker DOES parse — confirms the null results above are about the missing
  // fields, not some other malformation
  writeFileSync(
    markerPath,
    JSON.stringify({ onto: 'deadbeef0001', origHead: 'cafef00d0002', branch: 'worktree-x' }),
  );
  const marker = readSpineRebaseMarker(s.main);
  assert.ok(marker, 'a complete onto/origHead/branch marker parses');
  assert.equal(marker.branch, 'worktree-x');
});

test('plan 3974 round 3: rebaseStateKnownAbsent is true on a clean repo with no rebase state', () => {
  const s = sandbox();
  assert.equal(rebaseStateKnownAbsent(s.main), true);
});

test('plan 3974 round 3: rebaseStateKnownAbsent is false while a real rebase-merge state exists on disk', () => {
  const s = sandbox();
  writeFileSync(join(s.main, 'shared.py'), 'base\n');
  s.g(s.main, ['add', 'shared.py']);
  s.g(s.main, ['commit', '-m', 'add shared.py']);
  s.g(s.main, ['push', 'origin', 'master']);
  s.g(s.main, ['checkout', '-b', 'worktree-knownabsent', 'origin/master']);
  writeFileSync(join(s.main, 'shared.py'), 'MY EDIT\n');
  s.g(s.main, ['add', 'shared.py']);
  s.g(s.main, ['commit', '-m', 'mine edits shared.py']);
  s.g(s.main, ['push', 'origin', 'worktree-knownabsent']);
  s.g(s.main, ['checkout', 'master']);
  writeFileSync(join(s.main, 'shared.py'), 'SIBLING EDIT\n');
  s.g(s.main, ['add', 'shared.py']);
  s.g(s.main, ['commit', '-m', 'sibling edits shared.py']);
  s.g(s.main, ['push', 'origin', 'master']);
  s.g(s.main, ['checkout', 'worktree-knownabsent']);

  const r = syncBranchOntoMaster(s.main, 'worktree-knownabsent');

  assert.equal(
    r.conflicted,
    true,
    'precondition: a real conflict halt leaves rebase-merge on disk',
  );
  assert.equal(
    rebaseStateKnownAbsent(s.main),
    false,
    'a real, unresolved rebase-merge state must never read as known-absent',
  );
});

test('plan 3974 round 3: rebaseStateKnownAbsent is false (never a fail-open true) when the probe itself fails — a path that is not a git repo', () => {
  const dir = makeNoRepoRoot('land-lib-3974-knownabsent-notgit-');
  assert.equal(
    rebaseStateKnownAbsent(dir),
    false,
    'a failed probe must read as "not provably absent", never as a clean-repo true',
  );
});

// mutationKnownAbsent is stricter than rebaseStateKnownAbsent alone — it ALSO requires a
// resolved, absent MERGE_HEAD, because a caller that will MUTATE the worktree on "nothing is in
// progress" (done-worktree's pre-queue freshen) must not act over a foreign in-flight merge just
// because no REBASE state happens to exist. Same four states, mirroring the rebaseStateKnownAbsent
// tests above, in one test.
test('plan 3974 round 4: mutationKnownAbsent is true only on a clean repo — false on rebase state, a foreign MERGE_HEAD, or a failed probe', () => {
  // state 1: a clean repo with neither rebase state nor MERGE_HEAD — true
  const clean = sandbox();
  assert.equal(mutationKnownAbsent(clean.main), true, 'a clean repo reads as known-absent');

  // state 2: a real, unresolved rebase-merge leftover (a genuine conflict halt) — false
  const s = sandbox();
  writeFileSync(join(s.main, 'shared.py'), 'base\n');
  s.g(s.main, ['add', 'shared.py']);
  s.g(s.main, ['commit', '-m', 'add shared.py']);
  s.g(s.main, ['push', 'origin', 'master']);
  s.g(s.main, ['checkout', '-b', 'worktree-mutabsent', 'origin/master']);
  writeFileSync(join(s.main, 'shared.py'), 'MY EDIT\n');
  s.g(s.main, ['add', 'shared.py']);
  s.g(s.main, ['commit', '-m', 'mine edits shared.py']);
  s.g(s.main, ['push', 'origin', 'worktree-mutabsent']);
  s.g(s.main, ['checkout', 'master']);
  writeFileSync(join(s.main, 'shared.py'), 'SIBLING EDIT\n');
  s.g(s.main, ['add', 'shared.py']);
  s.g(s.main, ['commit', '-m', 'sibling edits shared.py']);
  s.g(s.main, ['push', 'origin', 'master']);
  s.g(s.main, ['checkout', 'worktree-mutabsent']);
  const r = syncBranchOntoMaster(s.main, 'worktree-mutabsent');
  assert.equal(
    r.conflicted,
    true,
    'precondition: a real conflict halt leaves rebase-merge on disk',
  );
  assert.equal(
    mutationKnownAbsent(s.main),
    false,
    'a real, unresolved rebase-merge state must never read as mutation-known-absent',
  );

  // state 3: no rebase state at all, but a hand-written (foreign) MERGE_HEAD — false
  const merged = sandbox();
  const gitDir = merged.g(merged.main, ['rev-parse', '--git-dir']);
  const gitDirAbs = isAbsolute(gitDir) ? gitDir : join(merged.main, gitDir);
  const onto = merged.g(merged.main, ['rev-parse', 'HEAD']);
  writeFileSync(join(gitDirAbs, 'MERGE_HEAD'), `${onto}\n`);
  assert.equal(
    rebaseStateKnownAbsent(merged.main),
    true,
    'precondition: there is no REBASE state here, only a foreign MERGE_HEAD',
  );
  assert.equal(
    mutationKnownAbsent(merged.main),
    false,
    'a foreign in-flight merge alone must block mutation-known-absent, no rebase state needed',
  );

  // state 4: the probe itself fails — a path that resolves no git repo at all — false, never a
  // fail-open true
  const notGit = makeNoRepoRoot('land-lib-3974-mutabsent-notgit-');
  assert.equal(
    mutationKnownAbsent(notGit),
    false,
    'a failed probe must read as "not provably absent", never as a clean-repo true',
  );
});

// ── plan 1240 Group B: narrow the unpushed-master block to 'other' (or opaque) ahead-commits ──
// Ahead commits touching ONLY sanctioned direct-master surfaces (main-checkout-allowlist 'doc' +
// 'config') ride to origin OUTSIDE the landing queue, so they must never gate a land; an 'other'
// (seed/code) remnant OR an empty/opaque commit still blocks. The queue-exempt SET is the CANONICAL
// classifyAllowlist (one source of truth — reviews [3]/[5] + delta [1]); a COMMITTED
// .claude/config change IS exempt (a done config commit rides to origin — unlike coord-git's
// isCoordDocPath, which governs UNCOMMITTED dirt). Pure classifier tests first, then real-git.

test('plan 1240: the queue-exempt set is main-checkout-allowlist (doc + config exempt, other blocks)', () => {
  // 'doc' + 'config' are exempt (sanctioned direct-master surfaces)
  for (const p of [
    'wiki/index.md',
    'docs/handoff/board.md',
    'docs/superpowers/plans/in-progress/1240-foo.md',
    'docs/superpowers/specs/2026-07-01-x.md',
    'docs/INDEX.md',
    'WIKI.md',
    'docs/runbooks/branch-hygiene.md', // plan 2692 — runbooks joined 'doc', so runbook-only ahead commits ride

    '.claude/settings.json', // 'config' — delta review [1]: a committed config change rides to origin
    '.claude/settings.local.json',
  ]) {
    assert.notEqual(classifyAllowlist(p), 'other', `${p} must be queue-exempt (doc/config)`);
  }
  // 'other' — code/seed/CLAUDE.md/arbitrary docs — must block
  for (const p of [
    'backend/src/data/seed-records.json',
    'scripts/coord/land-lib.mjs',
    'docs/ARCHITECTURE.md',
    'docs/research/x.md',
    'docs/runbooks/cloud-drain-setup-script.sh', // plan 2692: runbook PAGES ride, the executable does not
    'CLAUDE.md',
  ]) {
    assert.equal(classifyAllowlist(p), 'other', `${p} must NOT be queue-exempt`);
  }
});

test('plan 1240: classifyAheadCommit — exempt-only ⇒ exempt, any other path ⇒ block (mixed blocks), EMPTY ⇒ opaque block', () => {
  assert.deepEqual(classifyAheadCommit(['wiki/a.md', 'docs/INDEX.md']), {
    exempt: true,
    empty: false,
    nonExempt: [],
  });
  // delta review [1]: a lone COMMITTED .claude/settings.json ahead-commit is exempt (config rides)
  assert.deepEqual(classifyAheadCommit(['.claude/settings.json']), {
    exempt: true,
    empty: false,
    nonExempt: [],
  });
  // review [0]: an EMPTY path set (empty / no-op commit) is NOT exempt — it is opaque and blocks
  assert.deepEqual(classifyAheadCommit([]), { exempt: false, empty: true, nonExempt: [] });
  assert.deepEqual(classifyAheadCommit(['', null, '  ']), {
    exempt: false,
    empty: true,
    nonExempt: [],
  });
  // a MIXED commit surfaces its code path → blocks (not exempt)
  const mixed = classifyAheadCommit(['.claude/settings.json', 'backend/src/x.ts']);
  assert.equal(mixed.exempt, false);
  assert.equal(mixed.empty, false);
  assert.deepEqual(mixed.nonExempt, ['backend/src/x.ts']);
  // de-dupes + trims
  assert.deepEqual(classifyAheadCommit(['scripts/a.mjs', 'scripts/a.mjs']), {
    exempt: false,
    empty: false,
    nonExempt: ['scripts/a.mjs'],
  });
});

test('plan 1240: assertLandable ALLOWS an ahead commit touching only queue-exempt docs', () => {
  const s = sandbox();
  // a sibling's hand-committed wiki + handoff edit sits UNPUSHED on the shared local master
  mkdirSync(join(s.main, 'wiki'), { recursive: true });
  writeFileSync(join(s.main, 'wiki', 'log.md'), 'note\n');
  mkdirSync(join(s.main, 'docs', 'handoff'), { recursive: true });
  writeFileSync(join(s.main, 'docs', 'handoff', 'board.md'), 'board\n');
  s.g(s.main, ['add', 'wiki/log.md', 'docs/handoff/board.md']);
  s.g(s.main, ['commit', '-m', 'wiki + handoff edit (sibling, unpushed)']);
  const tipBefore = s.g(s.main, ['rev-parse', 'master']);

  // no throw — the land may proceed; the exempt sibling commit is NOT dropped (assertLandable is
  // read-only, and the spine lands the branch off origin/master with syncMain:false)
  assert.deepEqual(assertLandable(s.main, { run: s.g }), { ok: true });
  assert.equal(
    s.g(s.main, ['rev-parse', 'master']),
    tipBefore,
    'sibling commit preserved untouched',
  );
});

test('plan 1240: assertLandable BLOCKS an unpushed seed/code remnant (typed unpushed-master)', () => {
  const s = sandbox();
  mkdirSync(join(s.main, 'backend', 'src', 'data'), { recursive: true });
  writeFileSync(join(s.main, 'backend', 'src', 'data', 'seed-records.json'), '[]\n');
  s.g(s.main, ['add', 'backend/src/data/seed-records.json']);
  s.g(s.main, ['commit', '-m', 'unpushed seed remnant']);

  const e = caught(() => assertLandable(s.main, { run: s.g }));
  assert.equal(e.reason, 'unpushed-master');
  assert.ok(
    e.blockingPaths.includes('backend/src/data/seed-records.json'),
    'the seam names the blocking seed path',
  );
  assert.match(e.message, /SEED\/CODE remnant/);
});

test('plan 1240: assertLandable BLOCKS a MIXED doc+code ahead-commit', () => {
  const s = sandbox();
  mkdirSync(join(s.main, 'wiki'), { recursive: true });
  mkdirSync(join(s.main, 'scripts'), { recursive: true });
  writeFileSync(join(s.main, 'wiki', 'a.md'), 'doc\n');
  writeFileSync(join(s.main, 'scripts', 'helper.mjs'), 'export const y = 2;\n');
  s.g(s.main, ['add', 'wiki/a.md', 'scripts/helper.mjs']);
  s.g(s.main, ['commit', '-m', 'mixed doc + code in one commit']);

  const e = caught(() => assertLandable(s.main, { run: s.g }));
  assert.equal(e.reason, 'unpushed-master');
  assert.deepEqual(e.blockingPaths, ['scripts/helper.mjs'], 'only the code path is blocking');
});

test('plan 1240: assertLandable reads a MERGE commit via first-parent diff — a code-bearing merge blocks', () => {
  const s = sandbox();
  // a feature branch with a code commit, merged --no-ff into the SHARED local master but NOT pushed
  // (the "prior land pushed nothing" shape: a landing merge left on local master). `git diff-tree
  // --name-only` alone would collapse the merge to empty and hide the payload; the first-parent
  // diff surfaces it, so the land blocks.
  s.g(s.main, ['checkout', '-b', 'feat-code', 'master']);
  mkdirSync(join(s.main, 'backend', 'src'), { recursive: true });
  writeFileSync(join(s.main, 'backend', 'src', 'x.ts'), 'export const z = 3;\n');
  s.g(s.main, ['add', 'backend/src/x.ts']);
  s.g(s.main, ['commit', '-m', 'feat code']);
  s.g(s.main, ['checkout', 'master']);
  s.g(s.main, ['merge', '--no-ff', 'feat-code', '-m', 'Merge feat-code: landing merge']);

  const e = caught(() => assertLandable(s.main, { run: s.g }));
  assert.equal(e.reason, 'unpushed-master');
  assert.ok(e.blockingPaths.includes('backend/src/x.ts'), 'the merge-borne code path blocks');
});

test('plan 1240: assertLandable ALLOWS a doc-only MERGE commit (merge content classified, not naively blocked)', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-b', 'feat-doc', 'master']);
  mkdirSync(join(s.main, 'wiki'), { recursive: true });
  writeFileSync(join(s.main, 'wiki', 'note.md'), 'doc\n');
  s.g(s.main, ['add', 'wiki/note.md']);
  s.g(s.main, ['commit', '-m', 'feat doc']);
  s.g(s.main, ['checkout', 'master']);
  s.g(s.main, ['merge', '--no-ff', 'feat-doc', '-m', 'Merge feat-doc: doc-only']);

  assert.deepEqual(assertLandable(s.main, { run: s.g }), { ok: true });
});

test('plan 1240 review [0]: assertLandable BLOCKS an EMPTY/no-op ahead commit (unexplained divergence, no path-diff)', () => {
  const s = sandbox();
  // an empty bookkeeping/merge commit (no file diff) unpushed on the shared local master — the
  // half-reconciled-master hazard the guard exists to catch. Its payload is invisible to a
  // path-diff, so it must BLOCK, not slip through the all-exempt door.
  s.g(s.main, ['commit', '--allow-empty', '-m', 'empty bookkeeping commit (sibling, unpushed)']);

  const e = caught(() => assertLandable(s.main, { run: s.g }));
  assert.equal(e.reason, 'unpushed-master');
  assert.match(e.message, /empty\/no-op ahead commit/);
  assert.deepEqual(e.blockingPaths, [], 'an empty commit has no blocking path but still blocks');
});

test('plan 1240 delta [1]: assertLandable ALLOWS a lone committed .claude/settings.json ahead commit (sanctioned direct-master config rides to origin)', () => {
  const s = sandbox();
  // CLAUDE.md sanctions editing .claude/settings.json directly on master; a COMMITTED such change
  // sitting briefly unpushed must NOT hard-block an unrelated sibling's land (the delta-[1]
  // false-block). main-checkout-allowlist classifies it 'config' → exempt.
  mkdirSync(join(s.main, '.claude'), { recursive: true });
  writeFileSync(join(s.main, '.claude', 'settings.json'), '{}\n');
  s.g(s.main, ['add', '.claude/settings.json']);
  s.g(s.main, ['commit', '-m', 'settings change (unpushed, sibling)']);

  assert.deepEqual(assertLandable(s.main, { run: s.g }), { ok: true });
});

test('plan 1240: assertLandable BLOCKS a non-allowlisted ("other") ahead commit — e.g. CLAUDE.md', () => {
  const s = sandbox();
  // CLAUDE.md is allowlist class 'other' (Tier-1 DENIES direct-master edits; it lands via worktree),
  // so a committed CLAUDE.md ahead commit is a genuine unpushed remnant that must still block.
  writeFileSync(join(s.main, 'CLAUDE.md'), '# edited\n');
  s.g(s.main, ['add', 'CLAUDE.md']);
  s.g(s.main, ['commit', '-m', 'CLAUDE.md edit (unpushed)']);

  const e = caught(() => assertLandable(s.main, { run: s.g }));
  assert.equal(e.reason, 'unpushed-master');
  assert.ok(e.blockingPaths.includes('CLAUDE.md'), 'an "other" path still blocks');
});

// ── plan 2743 grill Q1: rangePatchIdOnce memoizes PER THUNK, never process-wide ──────────────
// The round-2 form of this helper cached on a module-level Map keyed on (dir, tip, baseRef). It
// was reverted by operator ruling 2026-08-03 because `rangePatchId` returns null on ANY failure,
// so one transient git failure would be stored and re-served as "no computable identity" — i.e.
// every marker stale — to every later caller in the process. These two assertions pin the
// reverted shape: an uncomputable read must NOT poison a later thunk, and one thunk must still
// compute at most once.
test('plan 2743: rangePatchIdOnce memoizes per thunk — an uncomputable read never poisons a later one', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-q', '-b', 'feat']);
  writeFileSync(join(s.main, 'b.txt'), 'b\n');
  s.g(s.main, ['add', 'b.txt']);
  s.g(s.main, ['commit', '-m', 'work']);

  // The 2-ARG form first: every production caller (record-review, record-marker, the repin CLI,
  // done-worktree) invokes this with (dir, tip) only and rides the `baseRef = 'origin/master'`
  // default, so that default gets its own assertion here rather than being covered only through
  // the CLI integration suites. sandbox() already pushed master, so origin/master resolves.
  const viaDefaultBase = rangePatchIdOnce(s.main, 'feat')();
  assert.ok(viaDefaultBase && viaDefaultBase !== 'empty', 'the default baseRef is origin/master');

  // A sibling publishes the base branch this thunk is keyed on, but THIS clone has not fetched
  // it yet — merge-base fails ⇒ null. That is the transient-failure shape: with a process-wide
  // cache the null is what every later caller for the same key reads for the rest of the process.
  // (set on the BARE origin, not pushed from this clone — a push would update this clone's
  // remote-tracking ref in the same breath, and the point is that it does not have it yet.)
  s.g(s.origin, ['update-ref', 'refs/heads/release', s.g(s.main, ['rev-parse', 'master'])]);
  const BASE_REF = 'origin/release';
  const uncomputable = rangePatchIdOnce(s.main, 'feat', BASE_REF);
  assert.equal(uncomputable(), null, 'base ref not fetched yet ⇒ uncomputable');

  s.g(s.main, ['fetch', '-q', 'origin']);
  const afterFetch = rangePatchIdOnce(s.main, 'feat', BASE_REF);
  const pid = afterFetch();
  assert.ok(
    pid && pid !== 'empty',
    'a FRESH thunk recomputes — the earlier null did not poison it',
  );
  assert.equal(uncomputable(), null, 'and the old thunk keeps its OWN memoized value');

  // Memoized: one thunk computes at most once, even when the repo state moves under it.
  assert.equal(afterFetch(), pid, 'second call is served from the thunk memo');
  // A plain push here — the inverse of the step above, and deliberately so: pushing updates this
  // clone's own `origin/release` in the same breath, which is exactly what that step had to avoid
  // and exactly what this step wants. One subprocess, no follow-up fetch.
  s.g(s.main, ['push', '-q', 'origin', 'feat:release']);
  assert.equal(afterFetch(), pid, 'still memoized after the base moved');
  assert.equal(
    rangePatchIdOnce(s.main, 'feat', BASE_REF)(),
    'empty',
    'a fresh thunk sees it moved',
  );
});

// ── plan 3447: fetchOriginBeforePatchId — ONE shared fetch-before-patch-id policy ────────────
// Mirrors gpt-review.mjs's fetchOriginForLandedGuard: fetch origin/master before any
// rangePatchIdOnce read of it, non-fatal, `--no-fetch`-skippable, DI'd runGit for tests.
test('plan 3447: a stale local origin/master yields a STALE patch-id before the fetch and the REFRESHED one after', () => {
  const s = sandbox();
  // A sibling clone advances the REAL origin/master to C1 (touching a file `tip` never
  // touches), while s.main's own origin/master remote-tracking ref is never told — it stays
  // pinned at the sandbox's original `base` commit (C0) until fetchOriginBeforePatchId runs.
  const sibling = join(s.root, 'sibling');
  execFileSync('git', ['clone', s.origin, sibling], { encoding: 'utf8' });
  s.g(sibling, ['config', 'user.email', 't@t']);
  s.g(sibling, ['config', 'user.name', 't']);
  writeFileSync(join(sibling, 'other.txt'), 'advanced\n');
  s.g(sibling, ['add', 'other.txt']);
  s.g(sibling, ['commit', '-m', 'C1: advance master (unrelated file)']);
  s.g(sibling, ['push', 'origin', 'master']);

  // The tip branches off the ADVANCED master (C1) and adds its own file — built in the same
  // sibling clone (which has C1 locally from the commit above), then pushed as `feat`.
  s.g(sibling, ['checkout', '-q', '-b', 'feat']);
  writeFileSync(join(sibling, 'b.txt'), 'feature\n');
  s.g(sibling, ['add', 'b.txt']);
  s.g(sibling, ['commit', '-m', 'feat: tip']);
  s.g(sibling, ['push', 'origin', 'feat']);

  // s.main learns about `feat` (and, incidentally, C1's objects) WITHOUT touching its
  // origin/master remote-tracking ref — exactly the "resolveRecordTarget deliberately does
  // NOT fetch" shape the record path lived with pre-fix.
  s.g(s.main, ['fetch', '-q', 'origin', 'feat:refs/remotes/origin/feat']);
  const tip = s.g(s.main, ['rev-parse', 'origin/feat']);

  // PRE-FIX behavior: rangePatchIdOnce's default baseRef ('origin/master') reads the STALE
  // C0 ref — merge-base(C0, tip) is C0, so the diff swallows C1's "other.txt" change too.
  const stalePatchId = rangePatchIdOnce(s.main, tip)();
  assert.ok(stalePatchId && stalePatchId !== 'empty', 'stale-base patch-id is computable');

  // The fix: refresh origin/master via the shared policy, using an INJECTED runGit (real git,
  // routed through the sandbox's own runner) — same DI shape fetchOriginForLandedGuard uses.
  const fetchResult = fetchOriginBeforePatchId(s.main, { runGit: (args) => s.g(s.main, args) });
  assert.deepEqual(fetchResult, { ok: true });

  // POST-FIX behavior: a FRESH thunk (rangePatchIdOnce memoizes per-thunk, plan 2743) now
  // reads the REFRESHED origin/master (C1) — merge-base(C1, tip) is C1, so the diff excludes
  // C1's change and covers only `feat`'s own commit. Provably different from the stale read.
  const freshPatchId = rangePatchIdOnce(s.main, tip)();
  assert.ok(freshPatchId && freshPatchId !== 'empty', 'refreshed-base patch-id is computable');
  assert.notEqual(
    freshPatchId,
    stalePatchId,
    'fetching origin/master first changes the computed patch-id — the marker identity bug',
  );
});

test('plan 3447: fetchOriginBeforePatchId --no-fetch (repin path) skips the fetch entirely', () => {
  const s = sandbox();
  let calls = 0;
  const result = fetchOriginBeforePatchId(s.main, {
    noFetch: true,
    runGit: () => {
      calls += 1;
      throw new Error('runGit must never be called under noFetch');
    },
  });
  assert.deepEqual(result, { ok: true, skipped: true });
  assert.equal(calls, 0, 'runGit was never invoked');
});

// ── plan 3447 fix round 1: the LAZY composed thunk ──────────────────────────────────────────
// Review finding 98ab0c (CONFIRMED): calling fetchOriginBeforePatchId EAGERLY above
// rangePatchIdOnce defeats the laziness both record paths document — record-review.mjs's own
// comment says the patch-id is a memoized thunk precisely so "every refusal below — a bad
// --findings file above all — still refuses without paying", and an eager fetch makes a
// malformed --findings file pay a network round-trip before it can refuse. Findings d52c68 /
// 11ea1e (CONFIRMED): the wiki/conclusion record flow (record-marker-cli runRecordMain) built
// its patch-id with no fetch at all. rangePatchIdOnceWithFetch fixes both at once — ONE policy
// that fetches exactly when the patch-id is actually computed, and never before.
test('plan 3447 fix: rangePatchIdOnceWithFetch does NOT fetch at construction — only on first evaluation', () => {
  const s = sandbox();
  const tip = s.g(s.main, ['rev-parse', 'HEAD']);
  let fetches = 0;
  const thunk = rangePatchIdOnceWithFetch(s.main, tip, {
    runGit: (args) => {
      fetches += 1;
      return s.g(s.main, args);
    },
  });
  assert.equal(fetches, 0, 'constructing the thunk must cost nothing — this is the whole point');
  thunk();
  assert.equal(fetches, 1, 'the first evaluation fetches');
});

test('plan 3447 fix: rangePatchIdOnceWithFetch fetches at most ONCE across repeated evaluations', () => {
  const s = sandbox();
  const tip = s.g(s.main, ['rev-parse', 'HEAD']);
  let fetches = 0;
  const thunk = rangePatchIdOnceWithFetch(s.main, tip, {
    runGit: (args) => {
      fetches += 1;
      return s.g(s.main, args);
    },
  });
  const a = thunk();
  const b = thunk();
  const c = thunk();
  assert.equal(fetches, 1, 'coordWrite re-runs mutateIn on freshen-and-retry — never re-fetch');
  assert.equal(a, b);
  assert.equal(b, c);
});

test('plan 3447 fix: rangePatchIdOnceWithFetch honors noFetch and still computes the patch-id', () => {
  const s = sandbox();
  const tip = s.g(s.main, ['rev-parse', 'HEAD']);
  let fetches = 0;
  const thunk = rangePatchIdOnceWithFetch(s.main, tip, {
    noFetch: true,
    runGit: () => {
      fetches += 1;
      throw new Error('runGit must never be called under noFetch');
    },
  });
  const value = thunk();
  assert.equal(fetches, 0, 'noFetch skips the fetch entirely');
  assert.equal(value, rangePatchIdOnce(s.main, tip)(), 'the patch-id is still computed');
});

test('plan 3447 fix: rangePatchIdOnceWithFetch is non-fatal — a throwing fetch still yields a patch-id', () => {
  const s = sandbox();
  const tip = s.g(s.main, ['rev-parse', 'HEAD']);
  const thunk = rangePatchIdOnceWithFetch(s.main, tip, {
    runGit: () => {
      throw new Error('offline: could not resolve host');
    },
  });
  // Degrades to the local ref rather than crashing a record that was otherwise fine to run.
  assert.equal(thunk(), rangePatchIdOnce(s.main, tip)());
});

test('plan 3447 fix: the composed thunk refreshes a STALE origin/master before computing', () => {
  const s = sandbox();
  // Same shape as the policy test above: a sibling advances the real origin/master while
  // s.main's remote-tracking ref stays pinned, so the composed thunk must fetch to be correct.
  const sibling = join(s.root, 'sibling');
  execFileSync('git', ['clone', s.origin, sibling], { encoding: 'utf8' });
  s.g(sibling, ['config', 'user.email', 't@t']);
  s.g(sibling, ['config', 'user.name', 't']);
  writeFileSync(join(sibling, 'other.txt'), 'advanced\n');
  s.g(sibling, ['add', 'other.txt']);
  s.g(sibling, ['commit', '-m', 'C1: advance master (unrelated file)']);
  s.g(sibling, ['push', 'origin', 'master']);
  s.g(sibling, ['checkout', '-q', '-b', 'feat']);
  writeFileSync(join(sibling, 'b.txt'), 'feature\n');
  s.g(sibling, ['add', 'b.txt']);
  s.g(sibling, ['commit', '-m', 'feat: tip']);
  s.g(sibling, ['push', 'origin', 'feat']);
  s.g(s.main, ['fetch', '-q', 'origin', 'feat:refs/remotes/origin/feat']);
  const tip = s.g(s.main, ['rev-parse', 'origin/feat']);

  const stale = rangePatchIdOnce(s.main, tip)();
  const fresh = rangePatchIdOnceWithFetch(s.main, tip, { runGit: (args) => s.g(s.main, args) })();
  assert.notEqual(fresh, stale, 'the composed thunk fetches before computing — not after');
});

test('plan 3447 fix round 2: the ref the policy FETCHES is the ref the thunk COMPARES against', () => {
  // Review finding 5e31ef/176415: the wrapper briefly took a `baseRef` option while the fetch
  // was hardwired to origin/master, so a caller passing another base would have been compared
  // against a ref nothing refreshed. The two are now one constant — pin both halves of that.
  const s = sandbox();
  const tip = s.g(s.main, ['rev-parse', 'HEAD']);
  let fetchedArgs = null;
  const value = rangePatchIdOnceWithFetch(s.main, tip, {
    runGit: (args) => {
      fetchedArgs = args;
      return s.g(s.main, args);
    },
  })();
  assert.deepEqual(
    fetchedArgs,
    ['fetch', '--no-tags', PATCH_ID_FETCH_REMOTE, PATCH_ID_FETCH_BRANCH],
    'fetches the PATCH_ID_FETCH_REF components verbatim — no re-parse of the joined name',
  );
  assert.equal(PATCH_ID_FETCH_REF, `${PATCH_ID_FETCH_REMOTE}/${PATCH_ID_FETCH_BRANCH}`);
  assert.equal(
    value,
    rangePatchIdOnce(s.main, tip, PATCH_ID_FETCH_REF)(),
    'and computes against that same ref',
  );
  // The knob is gone: an unknown option must not silently redirect the comparison base.
  assert.equal(
    rangePatchIdOnceWithFetch(s.main, tip, { baseRef: 'origin/nonexistent', noFetch: true })(),
    rangePatchIdOnce(s.main, tip, PATCH_ID_FETCH_REF)(),
  );
});

test('plan 3447: the fetch timeout mirrors gpt-review.mjs LANDED_GUARD_FETCH_TIMEOUT_MS (30s)', () => {
  // The two policies are deliberate MIRRORS, not a shared import (importing from gpt-review.mjs
  // would cycle — it already imports rangePatchIdOnce from this module). Pin the constant so a
  // silent drift between the two copies fails here rather than only under a wedged remote.
  assert.equal(PATCH_ID_FETCH_TIMEOUT_MS, 30_000);
});

test('plan 3447: fetchOriginBeforePatchId is non-fatal — a throwing runGit never escapes', () => {
  const s = sandbox();
  const result = fetchOriginBeforePatchId(s.main, {
    runGit: () => {
      throw new Error('offline: could not resolve host');
    },
  });
  assert.deepEqual(result, { ok: false, error: 'offline: could not resolve host' });
});

// ── plan 3080: the foreign-commit graft guard ────────────────────────────────────
// Reproduces the 2026-08-05 incident shape (ledger
// `keep-hot-prep-grafted-another-plans-unlanded-commits-onto-my-branch`): a sibling land merged
// into the SHARED LOCAL master and never completed its push, and this branch then came out of a
// prep carrying those unlanded commits. The land would have merged another plan's unreviewed
// work under this plan's merge.
//
// The scaffold makes the foreign-commit COUNT a parameter rather than hard-coding the incident's
// 15 — the invariant is "none of them", not "not fifteen of them".
function graftSetup({ foreign = 2 } = {}) {
  const s = sandbox();
  // A sibling land merges into the shared LOCAL master and dies before pushing: these commits
  // exist on refs/heads/master and have NEVER reached origin/master.
  s.g(s.main, ['checkout', '-q', 'master']);
  for (let i = 1; i <= foreign; i++) {
    writeFileSync(join(s.main, `sibling-${i}.txt`), `sibling unlanded ${i}\n`);
    s.g(s.main, ['add', `sibling-${i}.txt`]);
    s.g(s.main, ['commit', '-m', `2721: sibling unlanded work ${i}`]);
  }
  // Our branch is cut off origin/master (correctly) and published.
  s.g(s.main, ['checkout', '-q', '-b', 'worktree-m', 'origin/master']);
  writeFileSync(join(s.main, 'mine.txt'), 'my own work\n');
  s.g(s.main, ['add', 'mine.txt']);
  s.g(s.main, ['commit', '-m', '2883: my own work']);
  s.g(s.main, ['push', '-q', 'origin', 'worktree-m']);
  const publishedTip = s.g(s.main, ['rev-parse', 'origin/worktree-m']);
  return { ...s, publishedTip };
}

test('plan 3080: graftedForeignCommits is a NO-OP in the healthy state (local master == origin/master)', () => {
  const s = sandbox();
  s.g(s.main, ['checkout', '-q', '-b', 'worktree-m', 'origin/master']);
  writeFileSync(join(s.main, 'mine.txt'), 'my own work\n');
  s.g(s.main, ['add', 'mine.txt']);
  s.g(s.main, ['commit', '-m', 'my own work']);
  const onto = s.g(s.main, ['rev-parse', 'origin/master']);
  assert.deepEqual(graftedForeignCommits(s.main, onto).commits, []);
});

test('plan 3080: a local master merely AHEAD of origin/master does not fire — the graft is what is refused, not the hazard state', () => {
  const s = graftSetup();
  // The branch is still clean: cut off origin/master, never grafted. Local master carries the
  // sibling's unlanded commits, which is exactly the ledger's literal "refuse when the candidate
  // base is a local master ahead of origin/master" condition — and it must NOT refuse here.
  const onto = s.g(s.main, ['rev-parse', 'origin/master']);
  assert.ok(
    s
      .g(s.main, ['rev-list', 'refs/heads/master', `^${onto}`])
      .split('\n')
      .filter(Boolean).length,
    'scaffold sanity: local master really is ahead of origin/master',
  );
  assert.deepEqual(graftedForeignCommits(s.main, onto).commits, []);
});

test('plan 3080: graftedForeignCommits names every foreign commit once the branch IS grafted', () => {
  const s = graftSetup({ foreign: 3 });
  // The graft: the branch gets rebased onto the shared LOCAL master instead of origin/master.
  s.g(s.main, ['rebase', '-q', 'master']);
  const onto = s.g(s.main, ['rev-parse', 'origin/master']);
  const found = graftedForeignCommits(s.main, onto);
  assert.equal(found.commits.length, 3, 'all three foreign commits are reported');
  for (const c of found.commits) assert.match(c.subject, /^2721: sibling unlanded work \d$/);
  assert.ok(
    !found.commits.some((c) => /2883: my own work/.test(c.subject)),
    'our own commit is never reported as foreign',
  );
  assert.equal(found.cleanCutoff, true, 'foreign commits sit below all of ours');
});

test('plan 3080: syncBranchOntoMaster REFUSES a grafted branch and does not publish it (the 2026-08-05 incident)', () => {
  const s = graftSetup({ foreign: 2 });
  s.g(s.main, ['rebase', '-q', 'master']);
  const graftedTip = s.g(s.main, ['rev-parse', 'HEAD']);

  const r = syncBranchOntoMaster(s.main, 'worktree-m');

  assert.equal(r.graftBlocked, true, 'the graft is refused');
  assert.equal(r.conflicted, false, 'a graft is not a conflict');
  assert.equal(r.pushBlocked, undefined, 'and not a blocked push either');
  assert.equal(r.graftCommits.length, 2);
  for (const c of r.graftCommits) assert.match(c.subject, /2721: sibling unlanded work/);
  // THE point of the guard: the force-push never happened, so origin still carries the branch's
  // own reviewed work and nothing of the sibling's.
  assert.equal(
    s.g(s.main, ['rev-parse', 'origin/worktree-m']),
    s.publishedTip,
    'origin/worktree-m is untouched — the graft was never published',
  );
  assert.equal(
    s.g(s.main, ['rev-list', '--count', `origin/master..origin/worktree-m`]),
    '1',
    "origin's branch still contains ONLY this plan's own commit",
  );
  // The local branch is left exactly as found — the guard refuses, it never rewrites history
  // behind the session's back.
  assert.equal(s.g(s.main, ['rev-parse', 'HEAD']), graftedTip);
});

test('plan 3080: the documented recovery un-grafts the branch and the sync then proceeds', () => {
  const s = graftSetup({ foreign: 2 });
  s.g(s.main, ['rebase', '-q', 'master']);
  const blocked = syncBranchOntoMaster(s.main, 'worktree-m');
  assert.equal(blocked.graftBlocked, true);

  // The recipe the seam prints: rebase --onto origin/master <NEWEST foreign commit> — everything
  // above it (our own work) is replayed onto origin/master and every foreign commit is dropped.
  // graftCommits is rev-list order, so the newest is [0]; using the last element instead strands
  // the foreign commits above it, which is exactly the bug this assertion caught on the first cut.
  const newest = blocked.graftCommits[0].sha;
  s.g(s.main, ['rebase', '-q', '--onto', 'origin/master', newest]);

  const r = syncBranchOntoMaster(s.main, 'worktree-m');
  assert.equal(r.graftBlocked, undefined, 'un-grafted branch syncs normally');
  assert.equal(r.conflicted, false);
  assert.equal(
    s.g(s.main, ['rev-list', '--count', 'origin/master..HEAD']),
    '1',
    "the branch carries ONLY the plan's own commit vs origin/master (plan 3080 task-4 criterion)",
  );
  assert.equal(
    s.g(s.main, ['rev-parse', 'origin/worktree-m']),
    s.g(s.main, ['rev-parse', 'HEAD']),
    'and it published cleanly this time',
  );
});

// gpt-review d03b97: the FIRST cut of this guard checked AFTER the rebase. When origin/master has
// advanced past the graft point the rebase rewrites the foreign commits onto the new tip, so their
// SHAs stop matching the ones local master carries and the intersection comes out empty — the
// guard missed exactly the busy-fleet case it exists for. The check now runs BEFORE the rebase.
test('plan 3080: the graft is caught even when origin/master ADVANCED past it (post-rebase SHAs would be rewritten)', () => {
  const s = graftSetup({ foreign: 2 });
  s.g(s.main, ['rebase', '-q', 'master']);
  // a sibling lands on origin/master AFTER the graft, so the sync's rebase must genuinely replay
  // (and would re-sha the foreign commits) rather than fast-forward
  const side = mkdtempSync(join(tmpdir(), 'sib-'));
  execFileSync('git', ['clone', '-q', s.origin, side]);
  s.g(side, ['config', 'user.email', 't@t']);
  s.g(side, ['config', 'user.name', 't']);
  writeFileSync(join(side, 'sibling-landed.txt'), 'landed elsewhere\n');
  s.g(side, ['add', 'sibling-landed.txt']);
  s.g(side, ['commit', '-m', 'a different plan lands']);
  s.g(side, ['push', '-q', 'origin', 'master']);

  const r = syncBranchOntoMaster(s.main, 'worktree-m');

  assert.equal(r.graftBlocked, true, 'still refused after origin/master moved');
  assert.equal(r.graftCommits.length, 2);
  assert.equal(
    s.g(s.main, ['rev-parse', 'origin/worktree-m']),
    s.publishedTip,
    'and it was never published',
  );
});

// gpt-review 762884/182288: a graft whose rebase CONFLICTS used to return on the conflict arm
// without ever reaching the guard. Checking before the rebase closes that by construction.
test('plan 3080: a graft is refused as a GRAFT even when the rebase would conflict', () => {
  const s = graftSetup({ foreign: 1 });
  // make the foreign commit touch the same file a later origin/master commit touches, so a
  // replay would conflict
  s.g(s.main, ['checkout', '-q', 'master']);
  writeFileSync(join(s.main, 'contested.txt'), 'local master version\n');
  s.g(s.main, ['add', 'contested.txt']);
  s.g(s.main, ['commit', '-m', '2721: contested edit']);
  s.g(s.main, ['checkout', '-q', 'worktree-m']);
  s.g(s.main, ['rebase', '-q', 'master']);
  const side = mkdtempSync(join(tmpdir(), 'sib-'));
  execFileSync('git', ['clone', '-q', s.origin, side]);
  s.g(side, ['config', 'user.email', 't@t']);
  s.g(side, ['config', 'user.name', 't']);
  writeFileSync(join(side, 'contested.txt'), 'origin version\n');
  s.g(side, ['add', 'contested.txt']);
  s.g(side, ['commit', '-m', 'sibling touches the same file']);
  s.g(side, ['push', '-q', 'origin', 'master']);

  const r = syncBranchOntoMaster(s.main, 'worktree-m');
  assert.equal(r.graftBlocked, true, 'reported as a graft, not as a conflict');
  assert.equal(r.conflicted, false);
});

// gpt-review 14f336 asked what happens when our own work sits BELOW a foreign commit, because the
// one-line `rebase --onto origin/master <newest-foreign>` recovery would drop it. Working the case
// through shows it cannot arise on a LINEAR branch: foreignness here is "reachable from local
// master", which is ancestor-closed, so if a commit is foreign every commit below it in our range
// is foreign too — the foreign set is always the bottom stretch. That is what this pins. The
// `cleanCutoff` flag still exists for the merge-bearing case, where topo order CAN interleave two
// parent paths; rendering of the non-clean branch is covered in done-worktree-lib.test.mjs.
test('plan 3080: on a linear branch the foreign set is ancestor-closed, so the cutoff is always clean', () => {
  const s = graftSetup({ foreign: 3 });
  s.g(s.main, ['rebase', '-q', 'master']);
  const onto = s.g(s.main, ['rev-parse', 'origin/master']);
  const found = graftedForeignCommits(s.main, onto);
  assert.equal(found.commits.length, 3);
  assert.equal(found.cleanCutoff, true);
  assert.deepEqual(found.ownAbove, [s.g(s.main, ['rev-parse', 'HEAD']).slice(0, 9)]);
  // the cutoff really is safe: rebasing off the newest foreign commit keeps all of our work
  s.g(s.main, ['rebase', '-q', '--onto', 'origin/master', found.commits[0].sha]);
  assert.equal(s.g(s.main, ['rev-list', '--count', 'origin/master..HEAD']), '1');
  assert.match(s.g(s.main, ['log', '-1', '--format=%s']), /2883: my own work/);
});

// gpt-review 91a6c1/e0f561/272b33/d2be47: fail CLOSED. "I could not evaluate the guard" must never
// read as "no graft" — but a genuinely ABSENT local master is a real no-foreign state.
test('plan 3080: an ABSENT local master passes cleanly; an unevaluable check throws GraftCheckError', () => {
  const absent = graftSetup({ foreign: 1 });
  absent.g(absent.main, ['branch', '-D', 'master']);
  assert.deepEqual(
    graftedForeignCommits(absent.main, absent.g(absent.main, ['rev-parse', 'origin/master']))
      .commits,
    [],
    'an absent local master is a real no-foreign state, not an error',
  );

  const broken = graftSetup({ foreign: 1 });
  assert.throws(
    () => graftedForeignCommits(broken.main, 'not-a-sha-at-all'),
    (e) => e instanceof GraftCheckError,
    'an unevaluable check throws rather than returning "no graft"',
  );
});

// gpt-review round 2 (5ef0ea/b63ebb/012a1c/969ced/d02ad1/c6a754): round 1 made the range
// ENUMERATION fail closed but left the local-master existence probe swallowing every error, which
// reintroduced the same fail-open one line up. Absent must stay clean; broken must refuse.
test('plan 3080: a BROKEN repo refuses at the local-master probe rather than reading as "no graft"', () => {
  const s = graftSetup({ foreign: 1 });
  assert.throws(
    () => graftedForeignCommits(join(s.root, 'not-a-repo-at-all'), 'HEAD'),
    (e) => e instanceof GraftCheckError && /refs\/heads\/master/.test(e.message),
    'an unreadable repo throws instead of returning a clean result',
  );
});

// gpt-review round 2 (67ada6/485424): on a merge-bearing range, topo-list adjacency proves nothing
// about ancestry, so a clean cutoff must not be inferred from list positions.
test('plan 3080: a MERGE-bearing graft never claims a clean cutoff', () => {
  const s = graftSetup({ foreign: 1 });
  s.g(s.main, ['rebase', '-q', 'master']);
  // give the branch a merge commit in the origin/master..HEAD range
  s.g(s.main, ['checkout', '-q', '-b', 'side']);
  writeFileSync(join(s.main, 'side.txt'), 'side work\n');
  s.g(s.main, ['add', 'side.txt']);
  s.g(s.main, ['commit', '-m', 'side work']);
  s.g(s.main, ['checkout', '-q', 'worktree-m']);
  s.g(s.main, ['merge', '--no-ff', '-m', 'merge side', 'side']);

  const found = graftedForeignCommits(s.main, s.g(s.main, ['rev-parse', 'origin/master']));
  assert.ok(found.commits.length, 'the graft is still found');
  assert.equal(found.cleanCutoff, false, 'no clean-cutoff claim on a merge-bearing range');
});

// gpt-review round 3 (a73095): `ownAbove` reads the same topo-list positions that `cleanCutoff`
// refuses to trust across a merge. Populate it only where it can be proved.
test('plan 3080: ownAbove is omitted (not guessed) on a merge-bearing range', () => {
  const s = graftSetup({ foreign: 1 });
  s.g(s.main, ['rebase', '-q', 'master']);
  s.g(s.main, ['checkout', '-q', '-b', 'side']);
  writeFileSync(join(s.main, 'side.txt'), 'side work\n');
  s.g(s.main, ['add', 'side.txt']);
  s.g(s.main, ['commit', '-m', 'side work']);
  s.g(s.main, ['checkout', '-q', 'worktree-m']);
  s.g(s.main, ['merge', '--no-ff', '-m', 'merge side', 'side']);

  const found = graftedForeignCommits(s.main, s.g(s.main, ['rev-parse', 'origin/master']));
  assert.equal(found.mergeBearing, true);
  assert.equal(found.cleanCutoff, false);
  assert.deepEqual(found.ownAbove, [], 'no position-derived claim across a merge');
});

// ── plan 3972: the merge refuses any branch tip but the one the spine reviewed ────────────────
//
// `expectedHead` rides from mergeBranchToMaster into both land paths; a mismatch throws the typed
// `branch-tip-moved` BEFORE any merge-tree / checkout / push, so a force-push to the branch after
// review can never reach master through the `--no-verify` merge push.
function pushFeatureBranch(s, branch, file) {
  s.g(s.main, ['checkout', '-b', branch, 'origin/master']);
  writeFileSync(join(s.main, file), 'feature\n');
  s.g(s.main, ['add', file]);
  s.g(s.main, ['commit', '-m', `feat ${file}`]);
  s.g(s.main, ['push', 'origin', branch]);
  const tip = s.g(s.main, ['rev-parse', 'HEAD']);
  s.g(s.main, ['checkout', 'master']);
  return tip;
}

test('plan 3972 assertExpectedBranchTip: pure — unset expectation passes, mismatch throws typed branch-tip-moved', () => {
  assert.doesNotThrow(() => assertExpectedBranchTip('worktree-a', 'abc', null));
  assert.doesNotThrow(() => assertExpectedBranchTip('worktree-a', 'abc', undefined));
  assert.doesNotThrow(() => assertExpectedBranchTip('worktree-a', 'abc\n', ' abc '));
  const e = caught(() => assertExpectedBranchTip('worktree-a', 'abc', 'def'));
  assert.equal(e.reason, 'branch-tip-moved');
  assert.equal(e.branch, 'worktree-a');
  assert.equal(e.expectedHead, 'def');
  assert.equal(e.actualHead, 'abc');
  assert.match(e.message, /pushed by someone else after review/);
  const absent = caught(() => assertExpectedBranchTip('worktree-a', '', 'def'));
  assert.equal(absent.actualHead, null);
});

test('plan 3972: landBranchViaEphemeral with a mismatched expectedHead throws branch-tip-moved before any merge (master untouched)', () => {
  const s = sandbox();
  const reviewedTip = pushFeatureBranch(s, 'worktree-moved', 'moved.txt');
  const masterBefore = s.g(s.main, ['rev-parse', 'origin/master']);
  // Someone force-pushes a NEW commit onto the branch after review.
  s.g(s.main, ['checkout', 'worktree-moved']);
  writeFileSync(join(s.main, 'unreviewed.txt'), 'sneaked in\n');
  s.g(s.main, ['add', 'unreviewed.txt']);
  s.g(s.main, ['commit', '-m', 'unreviewed']);
  s.g(s.main, ['push', '--force', 'origin', 'worktree-moved']);
  const movedTip = s.g(s.main, ['rev-parse', 'HEAD']);
  s.g(s.main, ['checkout', 'master']);

  const e = caught(() =>
    landBranchViaEphemeral(s.main, 'worktree-moved', 'done moved', { expectedHead: reviewedTip }),
  );
  assert.equal(e.reason, 'branch-tip-moved');
  assert.equal(e.expectedHead, reviewedTip);
  assert.equal(e.actualHead, movedTip);
  s.g(s.main, ['fetch', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), masterBefore, 'NOT merged');
  assert.equal(
    existsSync(join(s.main, '.claude', 'worktrees')),
    false,
    'the refusal is not routed into the checkout fallback either (no ephemeral worktree)',
  );
});

test('plan 3972: a matching expectedHead proceeds and lands exactly that tip', () => {
  const s = sandbox();
  const reviewedTip = pushFeatureBranch(s, 'worktree-pinned', 'pinned.txt');
  const sha = landBranchViaEphemeral(s.main, 'worktree-pinned', 'done pinned', {
    expectedHead: reviewedTip,
  });
  s.g(s.main, ['fetch', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), sha);
  assert.equal(
    s.g(s.main, ['rev-parse', `${sha}^2`]),
    reviewedTip,
    'second parent is the pinned tip',
  );
});

test('plan 3972: the checkout fallback carries the same refusal (a moved tip cannot bypass it there)', () => {
  const s = sandbox();
  const reviewedTip = pushFeatureBranch(s, 'worktree-fb-moved', 'fb-moved.txt');
  s.g(s.main, ['checkout', 'worktree-fb-moved']);
  writeFileSync(join(s.main, 'fb-unreviewed.txt'), 'sneaked in\n');
  s.g(s.main, ['add', 'fb-unreviewed.txt']);
  s.g(s.main, ['commit', '-m', 'unreviewed']);
  s.g(s.main, ['push', '--force', 'origin', 'worktree-fb-moved']);
  s.g(s.main, ['checkout', 'master']);
  const e = caught(() =>
    landBranchViaCheckout(s.main, 'worktree-fb-moved', 'done fb moved', {
      expectedHead: reviewedTip,
    }),
  );
  assert.equal(e.reason, 'branch-tip-moved');
  assert.equal(
    existsSync(join(s.main, '.claude', 'worktrees')),
    false,
    'refused before the ephemeral worktree is even added',
  );
});

test('plan 3972: mergeBranchToMaster threads expectedHead into the lander', () => {
  const s = sandbox();
  const reviewedTip = pushFeatureBranch(s, 'worktree-thread', 'thread.txt');
  let seen;
  const landFn = (MAIN, branch, summary, opts) => {
    seen = opts;
    return 'fake-sha';
  };
  mergeBranchToMaster(s.main, 'worktree-thread', 'done thread', {
    run: s.g,
    landFn,
    syncMain: false,
    expectedHead: reviewedTip,
  });
  assert.deepEqual(seen, { expectedHead: reviewedTip });
  // and the real lander refuses through the same door when the tip moved
  const e = caught(() =>
    mergeBranchToMaster(s.main, 'worktree-thread', 'done thread', {
      run: s.g,
      syncMain: false,
      expectedHead: '0000000000000000000000000000000000000000',
    }),
  );
  assert.equal(e.reason, 'branch-tip-moved');
});

// ── plan 3972 round 2 ─────────────────────────────────────────────────────────────────────────
//
// Cluster 2 (gpt-review 3972 r2 findings 070dc9 / 35d2ce / 8013b4 / 043a43): the checkout fallback merges the sha it CHECKED,
// never `origin/<branch>` by name — the plan-2466 pin test, replayed on the fallback path.
test('plan 3972: the checkout fallback lands the PINNED tip on a non-ff retry, never a tip pushed mid-land', () => {
  const s = sandbox();
  const pinnedTip = pushFeatureBranch(s, 'worktree-fb-pin', 'fb-pin.txt');
  let fired = false;
  const sha = landBranchViaCheckout(s.main, 'worktree-fb-pin', 'done fb pin', {
    expectedHead: pinnedTip,
    _injectRaceOnce: (originUrl) => {
      fired = true;
      const sib = mkdtempSync(join(tmpdir(), 'sibling-'));
      execFileSync('git', ['clone', '-q', originUrl, sib]);
      execFileSync('git', ['-C', sib, 'config', 'user.email', 't@t']);
      execFileSync('git', ['-C', sib, 'config', 'user.name', 't']);
      writeFileSync(join(sib, 'sibling.txt'), 'sibling\n');
      execFileSync('git', ['-C', sib, 'add', '-A']);
      execFileSync('git', ['-C', sib, 'commit', '-q', '-m', 'sibling land']);
      execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
      execFileSync('git', ['-C', sib, 'checkout', '-q', '-b', 'wp', 'origin/worktree-fb-pin']);
      writeFileSync(join(sib, 'unreviewed.txt'), 'NOT reviewed\n');
      execFileSync('git', ['-C', sib, 'add', '-A']);
      execFileSync('git', ['-C', sib, 'commit', '-q', '-m', 'UNREVIEWED commit']);
      execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'wp:worktree-fb-pin']);
      // make the tracking ref in MAIN see the moved tip too, so a by-name merge WOULD pick it up
      execFileSync('git', ['-C', s.main, 'fetch', '-q', 'origin', 'worktree-fb-pin']);
    },
  });
  assert.ok(fired, 'the race seam must have fired');
  s.g(s.main, ['fetch', '-q', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), sha, 'landed after the retry');
  assert.equal(
    s.g(s.main, ['rev-parse', `${sha}^2`]),
    pinnedTip,
    'second parent is the CHECKED sha',
  );
  assert.equal(
    s.g(s.main, ['cat-file', '-p', sha]).includes('Merge worktree-fb-pin:'),
    true,
    'the merge subject still names the branch, only the merged object is the sha',
  );
});

// Cluster 3 (gpt-review 3972 r2 findings 0c0a29 / ee86ea / e204d3): the already-landed shortcut asks about the reviewed TIP,
// so a branch rewound on origin to an already-landed commit cannot skip the merge and its pin.
test('plan 3972: branchAlreadyLanded with `tip` judges that sha, not origin/<branch>', () => {
  const s = sandbox();
  const tipA = pushFeatureBranch(s, 'worktree-rewind', 'rewind.txt'); // reviewed, NOT on master
  const masterTip = s.g(s.main, ['rev-parse', 'origin/master']); // already on master
  // rewind origin/<branch> to a commit that IS on master
  s.g(s.main, ['push', '-q', '--force', 'origin', `${masterTip}:refs/heads/worktree-rewind`]);
  assert.equal(
    branchAlreadyLanded(s.main, 'worktree-rewind', { run: s.g }),
    true,
    'by ref: the rewound branch reads as landed (the hole)',
  );
  assert.equal(
    branchAlreadyLanded(s.main, 'worktree-rewind', { run: s.g, tip: tipA }),
    false,
    'by tip: the reviewed content is NOT on master',
  );
  // and through mergeBranchToMaster the reviewed tip is neither "already landed" nor merged:
  // the lander refuses because origin/<branch> no longer carries it.
  const e = caught(() =>
    mergeBranchToMaster(s.main, 'worktree-rewind', 'done rewind', {
      run: s.g,
      syncMain: false,
      expectedHead: tipA,
    }),
  );
  assert.equal(e.reason, 'branch-tip-moved');
  assert.equal(e.expectedHead, tipA);
  assert.equal(e.actualHead, masterTip);
  s.g(s.main, ['fetch', '-q', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), masterTip, 'master untouched');
});

// ── plan 3972 round 3 ─────────────────────────────────────────────────────────────────────────
//
// Cluster Z (gpt-review 3972 r3 findings 623dee / 7e5442 / 674b1c / bd650b): with `tip`, "already landed" also requires
// origin/<branch> to still BE that tip. Reviewed tip A on master + remote force-pushed to an
// unreviewed B is NOT landed — the shortcut must not return before the lander's branch-tip-moved
// refusal and close out with B silently discarded.
test('plan 3972 round 3: branchAlreadyLanded with `tip` is false when origin/<branch> moved past the landed tip, and the merge then refuses branch-tip-moved', () => {
  const s = sandbox();
  const tipA = pushFeatureBranch(s, 'worktree-moved-on', 'moved-on.txt');
  // land A for real, so it IS an ancestor of origin/master
  const landed = landBranchViaEphemeral(s.main, 'worktree-moved-on', 'done moved-on', {
    expectedHead: tipA,
  });
  s.g(s.main, ['fetch', '-q', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), landed);
  assert.equal(
    branchAlreadyLanded(s.main, 'worktree-moved-on', { run: s.g, tip: tipA }),
    true,
    'tip A on master AND origin/<branch> at A: landed (the resume-after-merge case)',
  );
  // someone force-pushes an unreviewed B onto the branch after the land
  s.g(s.main, ['checkout', 'worktree-moved-on']);
  writeFileSync(join(s.main, 'unreviewed-b.txt'), 'sneaked in\n');
  s.g(s.main, ['add', 'unreviewed-b.txt']);
  s.g(s.main, ['commit', '-m', 'unreviewed B']);
  s.g(s.main, ['push', '-q', '--force', 'origin', 'worktree-moved-on']);
  const tipB = s.g(s.main, ['rev-parse', 'HEAD']);
  s.g(s.main, ['checkout', 'master']);
  assert.equal(
    branchAlreadyLanded(s.main, 'worktree-moved-on', { run: s.g, tip: tipA }),
    false,
    'tip A on master but origin/<branch> at B: NOT landed',
  );
  assert.equal(
    branchAlreadyLanded(s.main, 'worktree-moved-on', { run: s.g }),
    false,
    'by ref: B itself is not on master either',
  );
  const e = caught(() =>
    mergeBranchToMaster(s.main, 'worktree-moved-on', 'done moved-on', {
      run: s.g,
      syncMain: false,
      expectedHead: tipA,
    }),
  );
  assert.equal(e.reason, 'branch-tip-moved', 'the normal path reaches assertExpectedBranchTip');
  assert.equal(e.expectedHead, tipA);
  assert.equal(e.actualHead, tipB);
  s.g(s.main, ['fetch', '-q', 'origin']);
  assert.equal(s.g(s.main, ['rev-parse', 'origin/master']), landed, 'master untouched');
});
