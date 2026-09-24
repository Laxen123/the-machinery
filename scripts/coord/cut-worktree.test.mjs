// scripts/cut-worktree.test.mjs — plan 871: a worktree must be cut off the FRESH origin tip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cutWorktree,
  branchFor,
  worktreePathFor,
  planWorktreeMode,
  resolvePlanForSlug,
  widenWorktree,
  narrowWorktree,
  DENSE_CATEGORIES,
  denseBodyTermsFor,
} from './cut-worktree.mjs';
import { PLAN_SPARSE_MARKER, ensurePlanSparseCheckout } from './coord-git.mjs';
import { MUTATION_BANNER_LABEL } from './build-index-lib.mjs';
// plan 4071 T2: PLAN_WORKTREE_EXCLUDED_PATHS / DENSE_BODY_TERMS are no longer coord-git.mjs /
// cut-worktree.mjs module constants -- they are coord.config.json's `planWorktreeExcludedPaths`
// key (empty core default) and a function of that list. plan 3958: this module ships as-is into
// the public coord-kit, so a shipped core test must not pin THIS repo's real coord.config.json
// value — PLAN_WORKTREE_EXCLUDED_PATHS below is a fixed, portable fixture (today's real vetapp
// value, kept as a snapshot, same technique as coord-git.test.mjs's
// COORD_CHECKOUT_EXCLUDED_TOP_LEVEL) and `makeSparseOrigin()`'s synthetic fixture writes the SAME
// constant into its own coord.config.json so `cutWorktree`'s self-resolution (from the mainDir it
// already receives) sees the identical list.
const PLAN_WORKTREE_EXCLUDED_PATHS = [
  'backend/data/price-pipeline/render-store',
  'backend/data/price-pipeline/render-archive',
  'backend/data/price-pipeline/render-fingerprints',
  'backend/data/price-pipeline/batches',
  'backend/data/price-pipeline/prompt-bench',
  'backend/data/price-pipeline/llm-runs',
  'backend/data/price-pipeline/page-extractions',
];
const DENSE_BODY_TERMS = denseBodyTermsFor(PLAN_WORKTREE_EXCLUDED_PATHS);
// plan 3958: same rationale as build-index-lib.test.mjs's own `sw()` — MUTATION_BANNER_LABEL is
// the kit's neutral 'DATA-WRITE' default there, not vetapp's real 'SEED-WRITE' row, and is the
// IDENTITY function on vetapp itself (where the label really is 'SEED-WRITE').
const sw = (s) => s.replaceAll('SEED-WRITE', MUTATION_BANNER_LABEL);

// plan 338: git leaks GIT_DIR/GIT_WORK_TREE/… into the test process, overriding `git -C`.
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

test('branchFor / worktreePathFor follow the vetapp naming convention', () => {
  assert.equal(branchFor('871-Infra-foo'), 'worktree-871-Infra-foo');
  assert.equal(worktreePathFor('871-Infra-foo'), '.claude/worktrees/871-Infra-foo');
});

// plan 909: worktreePathFor truncates the directory slug to ≤40 chars when the
// full slug exceeds 40, to avoid Windows MAX_PATH (260) overflows in Turbopack
// build artifacts. The BRANCH stays `worktree-<full-slug>` — the spine resolves
// by branch name first, so a short dir is invisible to done-worktree.
test('worktreePathFor: short slugs (≤40 chars) are unchanged', () => {
  const exactly40 = '903-DQ-halsokontroll-lowconf-variant-dis'; // exactly 40 chars
  assert.equal(exactly40.length, 40);
  assert.equal(worktreePathFor(exactly40), `.claude/worktrees/${exactly40}`);
  assert.equal(worktreePathFor('909-Infra-foo'), '.claude/worktrees/909-Infra-foo');
});

test('worktreePathFor: long slugs (>40 chars) are truncated to 40 chars in the dir', () => {
  const long71 = '903-DQ-halsokontroll-lowconf-variant-display-floor-and-misextract-sweep';
  assert.equal(long71.length, 71);
  // plan 1286: trailing hyphens left by a mid-word clip are trimmed (a `…-heal-and-` dir
  // name broke the 1286 pickup's first cd) — the expectation is slice-then-trim.
  const expected = `.claude/worktrees/${long71.slice(0, 40).replace(/-+$/, '')}`;
  assert.equal(worktreePathFor(long71), expected);
  // The plan-909 own slug (57 chars) is also truncated
  const slug909 = '909-Infra-done-worktree-build-preflight-maxpath-long-slug';
  assert.equal(slug909.length, 57);
  assert.equal(
    worktreePathFor(slug909),
    `.claude/worktrees/${slug909.slice(0, 40).replace(/-+$/, '')}`,
  );
});

test('worktreePathFor: a clip ending mid-hyphen carries no trailing dash (plan 1286)', () => {
  // The 40-char slice of this slug ends in "-"; the dir name must not.
  const slug = '1286-Infra-main-checkout-mutex-heal-and-coord-write-isolation';
  const p = worktreePathFor(slug);
  assert.ok(!p.endsWith('-'), `no trailing hyphen: ${p}`);
  assert.equal(p, '.claude/worktrees/1286-Infra-main-checkout-mutex-heal-and');
});

test('worktreePathFor: truncation keeps plan ID prefix — uniqueness preserved', () => {
  const slug = '903-DQ-halsokontroll-lowconf-variant-display-floor-and-misextract-sweep';
  const dir = worktreePathFor(slug).replace('.claude/worktrees/', '');
  assert.ok(dir.startsWith('903-'), 'plan ID is preserved in truncated dir');
});

test('cutWorktree with a long slug: dir is truncated but branch keeps the full slug', () => {
  const longSlug = '903-DQ-halsokontroll-lowconf-variant-display-floor-and-misextract-sweep';
  const calls = [];
  const r = cutWorktree('/main', longSlug, {
    run: (args) => {
      calls.push(args);
      return '';
    },
    push: false,
    installDeps: false,
  });
  // branch name must be the FULL slug
  assert.equal(r.branch, `worktree-${longSlug}`);
  // worktree PATH must use the TRUNCATED dir (first 40 chars)
  assert.equal(r.worktreePath, `.claude/worktrees/${longSlug.slice(0, 40)}`);
  // git worktree add must use the truncated path but the full branch name
  // call shape: ['worktree', 'add', '-b', <branch>, <path>, 'origin/master']
  const addCall = calls.find((a) => a[0] === 'worktree');
  assert.equal(addCall[3], `worktree-${longSlug}`, 'branch arg is the full slug');
  assert.equal(addCall[4], `.claude/worktrees/${longSlug.slice(0, 40)}`, 'path arg is truncated');
});

test('cutWorktree FETCHES before adding, cuts from origin/master, then pushes (order + args)', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return '';
  };
  const r = cutWorktree('/main', 'abc', { run, installDeps: false });

  // 1. fetch must come first
  assert.deepEqual(calls[0], ['fetch', 'origin', 'master'], 'fetch is the first git op');
  // 2. the add must reference origin/master (the fresh remote-tracking ref), not local master
  assert.deepEqual(calls[1], [
    'worktree',
    'add',
    '-b',
    'worktree-abc',
    '.claude/worktrees/abc',
    'origin/master',
  ]);
  // 3. publish the empty branch
  assert.deepEqual(calls[2], ['push', '-u', 'origin', 'worktree-abc']);
  assert.equal(calls.length, 3);
  assert.deepEqual(r, {
    branch: 'worktree-abc',
    worktreePath: '.claude/worktrees/abc',
    depsInstalled: false,
    // plan 3956: a mocked run with no resolvePlan resolves no plan file → DENSE by rule.
    sparse: false,
    modeRule: 'plan file not resolved (batch slug or non-plan worktree)',
  });
});

test('cutWorktree --no-push omits the publish step but still fetches first', () => {
  const calls = [];
  cutWorktree('/main', 'abc', { run: (a) => calls.push(a), push: false, installDeps: false });
  assert.deepEqual(calls[0], ['fetch', 'origin', 'master']);
  assert.equal(calls.length, 2, 'fetch + add only — no push');
});

test('cutWorktree throws without a slug', () => {
  assert.throws(() => cutWorktree('/main', '', { run: () => {} }), /slug/);
});

test('F-004 (plan 1313): cutWorktree REJECTS a slug outside the ASCII charset BEFORE touching git', () => {
  const calls = [];
  assert.throws(
    () => cutWorktree('/main', "869-UI-clinic's-fix", { run: (a) => calls.push(a) }),
    /--slug/,
  );
  assert.deepEqual(calls, [], 'no git op ran — the guard fired before any exec()');
});

test('F-004 (plan 1313): cutWorktree REJECTS a non-ASCII/space slug too', () => {
  assert.throws(() => cutWorktree('/main', '869-UI-öäå plan', { run: () => {} }), /--slug/);
});

// --- real-git: the cut sees a commit pushed to origin AFTER our last fetch (the staleness fix) ---
function makeOriginAndClones() {
  const root = mkdtempSync(join(tmpdir(), 'cut-wt-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  const clone = (name) => {
    const dir = join(root, name);
    execFileSync('git', ['clone', '-q', origin, dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.email', `${name}@t.t`]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', name]);
    execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
    return dir;
  };
  const commitPush = (dir, file, msg) => {
    writeFileSync(join(dir, file), `${msg}\n`);
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', msg]);
    execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'master']);
  };
  const A = clone('A'); // our "main" checkout
  commitPush(A, 'base.txt', 'base');
  const B = clone('B'); // a parallel session
  return { root, A, B, commitPush, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('cutWorktree: new worktree includes a sibling commit that landed AFTER our clone went stale', () => {
  const s = makeOriginAndClones();
  try {
    // B (a parallel session) lands a new commit on origin. A's local origin/master is now STALE.
    s.commitPush(s.B, 'sibling.txt', 'sibling-landed');
    // Cut a worktree from A WITHOUT pushing (the bare origin has no extra branch to publish-test).
    cutWorktree(s.A, 'xyz', { push: false, installDeps: false });
    const wt = join(s.A, '.claude', 'worktrees', 'xyz');
    assert.ok(existsSync(wt), 'worktree directory created');
    // The whole point: the cut fetched first, so the sibling's file is present on the new branch.
    assert.ok(
      existsSync(join(wt, 'sibling.txt')),
      "the worktree must include the sibling commit (cut off the FRESH origin tip, not A's stale ref)",
    );
  } finally {
    s.cleanup();
  }
});

// plan 985: the `.owner` marker (plan 958) is written at the worktree root, where the main
// repo's `.claude/worktrees/` gitignore does NOT cover it from inside the linked worktree.
// cut-worktree must add `.owner` to the worktree's effective exclude so done-worktree's
// preflight clean-check (`git -C <wtPath> status --porcelain`) does not trip on `?? .owner`.
test('cutWorktree: .owner exists AND the worktree is git-clean (preflight passes)', () => {
  const s = makeOriginAndClones();
  try {
    cutWorktree(s.A, 'owner-clean', { push: false, installDeps: false });
    const wt = join(s.A, '.claude', 'worktrees', 'owner-clean');
    // the marker is present...
    assert.ok(existsSync(join(wt, '.owner')), '.owner marker is written');
    // ...and yet `git status --porcelain` is empty — the marker is hidden via the exclude.
    const porcelain = execFileSync('git', ['-C', wt, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    assert.equal(porcelain.trim(), '', 'worktree is clean (no `?? .owner`)');
    // git agrees the path is ignored
    let ignored = false;
    try {
      execFileSync('git', ['-C', wt, 'check-ignore', '.owner'], { encoding: 'utf8' });
      ignored = true;
    } catch {
      ignored = false;
    }
    assert.ok(ignored, '.owner is ignored from inside the linked worktree');
    // the exclude is ANCHORED (`/.owner`): a NESTED `.owner` must still be trackable,
    // not shadowed repo-wide. (check-ignore matches the path string; the file need not exist.)
    let nestedIgnored = false;
    try {
      execFileSync('git', ['-C', wt, 'check-ignore', 'sub/.owner'], { encoding: 'utf8' });
      nestedIgnored = true;
    } catch {
      nestedIgnored = false;
    }
    assert.equal(
      nestedIgnored,
      false,
      'a nested `sub/.owner` is NOT shadowed by the anchored exclude',
    );
  } finally {
    s.cleanup();
  }
});

// plan 2465 review fix: a torn prior teardown leaves wtPath's admin dir REGISTERED
// (`.git/worktrees/<name>` present) even after its working directory is gone — `git
// worktree add` at the same path then refuses outright with "already registered
// worktree", regardless of any lock file inside the stale admin dir. The self-heal must
// actually clear the REGISTRATION (reclaimLandDirIfSafe), not just an index.lock, or this
// re-cut still fails exactly as before the heal existed.
test('cutWorktree: self-heals a torn prior teardown (registered-but-missing worktree dir) and re-cuts cleanly', () => {
  const s = makeOriginAndClones();
  try {
    cutWorktree(s.A, 'torn-slug', { push: false, installDeps: false });
    const wt = join(s.A, '.claude', 'worktrees', 'torn-slug');
    assert.ok(existsSync(wt), 'sanity: first cut created the worktree');
    // Simulate the torn teardown: the working directory is gone, but the admin
    // registration under .git/worktrees/ is NOT pruned (a killed teardown mid-removal).
    rmSync(wt, { recursive: true, force: true });
    const before = execFileSync('git', ['-C', s.A, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    });
    assert.match(before, /torn-slug/, 'sanity: the dead registration is still present');
    // Without the plan-2465 heal this throws: "fatal: '<path>' is a missing but already
    // registered worktree; use 'add -f' to override, or 'prune' or 'remove' to clear".
    cutWorktree(s.A, 'torn-slug', { push: false, installDeps: false });
    assert.ok(existsSync(wt), 're-cut succeeds and recreates the worktree directory');
    const porcelain = execFileSync('git', ['-C', wt, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    assert.equal(porcelain.trim(), '', 're-cut worktree is clean');
  } finally {
    s.cleanup();
  }
});

// plan 2465 review fix: reclaimLandDirIfSafe must NEVER touch a registration for a
// DIFFERENT branch — only a torn remnant of the exact branch this cut is about to create
// is safe to reclaim. Two DIFFERENT plan slugs never share a branch name, so this is a
// structural (not merely incidental) safety property of the heal.
test('cutWorktree: never reclaims a registered worktree belonging to a DIFFERENT branch', () => {
  const s = makeOriginAndClones();
  try {
    // A live sibling worktree for an UNRELATED slug/branch.
    cutWorktree(s.A, 'sibling-slug', { push: false, installDeps: false });
    const siblingWt = join(s.A, '.claude', 'worktrees', 'sibling-slug');
    assert.ok(existsSync(siblingWt), 'sanity: the sibling worktree exists');
    // Cutting an UNRELATED slug must not disturb the sibling's live registration at all.
    cutWorktree(s.A, 'other-slug', { push: false, installDeps: false });
    assert.ok(existsSync(siblingWt), 'the sibling worktree is untouched by an unrelated cut');
    const porcelain = execFileSync('git', ['-C', siblingWt, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    assert.equal(porcelain.trim(), '', 'the sibling worktree is still clean and usable');
  } finally {
    s.cleanup();
  }
});

// plan 3233: a leftover `worktree-<slug>` branch with ZERO commits of its own (a heartbeat
// plan's stable slug reusing a tick-after-tick-old base, or a torn teardown that died before
// its `branch -D` step) must NOT be reused as-is when it is behind the freshly-fetched
// origin/master — that silently runs the whole plan against a stale (possibly weeks-old)
// baseline. Lossless-by-construction: `origin/master..branch` is empty by the very condition,
// so re-pointing the ref loses nothing.
test('cutWorktree: re-points a stale ZERO-own-commit leftover branch onto the current origin/master (plan 3233)', () => {
  const s = makeOriginAndClones();
  try {
    const slug = 'stale-heartbeat';
    const branch = branchFor(slug);
    // Simulate the leftover branch sitting at an OLD base — created before the sibling's
    // newer commits land on origin. This is the shape a heartbeat plan's stable branch name
    // produces tick after tick, and the shape a torn teardown (died before `branch -D`) leaves.
    execFileSync('git', ['-C', s.A, 'branch', branch, 'master']);
    // A sibling session lands MULTIPLE new commits on origin AFTER the leftover branch's base.
    s.commitPush(s.B, 'newer.txt', 'newer-tick');
    s.commitPush(s.B, 'newer2.txt', 'newer-tick-2');
    // Sanity: the leftover branch truly has zero commits of its own relative to the fresh tip.
    execFileSync('git', ['-C', s.A, 'fetch', '-q', 'origin', 'master']);
    const ownCount = execFileSync(
      'git',
      ['-C', s.A, 'rev-list', '--count', `origin/master..${branch}`],
      { encoding: 'utf8' },
    ).trim();
    assert.equal(ownCount, '0', 'sanity: the leftover branch has no commits of its own');
    const behindCount = execFileSync(
      'git',
      ['-C', s.A, 'rev-list', '--count', `${branch}..origin/master`],
      { encoding: 'utf8' },
    ).trim();
    assert.notEqual(behindCount, '0', 'sanity: the leftover branch is behind origin/master');

    cutWorktree(s.A, slug, { push: false, installDeps: false });

    const wt = join(s.A, '.claude', 'worktrees', slug);
    assert.ok(existsSync(wt), 'worktree created');
    assert.ok(
      existsSync(join(wt, 'newer.txt')) && existsSync(join(wt, 'newer2.txt')),
      'the cut lands on the CURRENT origin/master, not the stale old base',
    );
    const wtHead = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const originMasterSha = execFileSync('git', ['-C', s.A, 'rev-parse', 'origin/master'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(wtHead, originMasterSha, 'worktree HEAD == the fresh origin/master tip');
  } finally {
    s.cleanup();
  }
});

// plan 3233: the AMBIGUOUS case — a leftover branch that is BOTH behind origin/master AND
// carries its own commit(s) (the authored torn-teardown-with-unpushed-work shape) must never
// be silently reset (that would destroy real work). It must REFUSE with the `--adopt`
// remediation instead.
test('cutWorktree: REFUSES an ambiguous leftover branch (own commits AND behind origin/master) rather than resetting it (plan 3233)', () => {
  const s = makeOriginAndClones();
  try {
    const slug = 'ambiguous-heartbeat';
    const branch = branchFor(slug);
    execFileSync('git', ['-C', s.A, 'branch', branch, 'master']);
    // Give the leftover branch its OWN unpushed commit (torn-teardown-with-work shape).
    execFileSync('git', ['-C', s.A, 'checkout', '-q', branch]);
    writeFileSync(join(s.A, 'own.txt'), 'unpushed work\n');
    execFileSync('git', ['-C', s.A, 'add', '-A']);
    execFileSync('git', ['-C', s.A, 'commit', '-qm', 'own-unpushed-work']);
    execFileSync('git', ['-C', s.A, 'checkout', '-q', 'master']);
    // A sibling session lands a new commit on origin — the leftover branch is now BOTH
    // ahead (its own commit) and behind (the sibling's) — the ambiguous case.
    s.commitPush(s.B, 'newer.txt', 'newer-tick');

    assert.throws(
      () => cutWorktree(s.A, slug, { push: false, installDeps: false }),
      (e) => {
        assert.match(e.message, /--adopt/, 'refusal points at the --adopt remediation');
        return true;
      },
    );
    // Nothing was reset or touched — the branch still carries its own commit.
    const stillHasOwnWork = execFileSync(
      'git',
      ['-C', s.A, 'log', branch, '--oneline', '--grep=own-unpushed-work'],
      { encoding: 'utf8' },
    ).trim();
    assert.notEqual(stillHasOwnWork, '', 'the ambiguous branch was NOT reset — own work is intact');
  } finally {
    s.cleanup();
  }
});

// idempotency: re-running the exclude-append (two cuts touching the same shared exclude)
// must not duplicate the `.owner` line.
test('cutWorktree: exclude-append is idempotent (no duplicate `.owner` lines)', () => {
  const s = makeOriginAndClones();
  try {
    cutWorktree(s.A, 'owner-one', { push: false, installDeps: false });
    cutWorktree(s.A, 'owner-two', { push: false, installDeps: false });
    // both worktrees share the common-dir info/exclude
    const exclude = execFileSync(
      'git',
      [
        '-C',
        join(s.A, '.claude', 'worktrees', 'owner-one'),
        'rev-parse',
        '--git-path',
        'info/exclude',
      ],
      { encoding: 'utf8' },
    ).trim();
    const body = readFileSync(exclude, 'utf8');
    const count = body.split('\n').filter((l) => l.trim() === '/.owner').length;
    assert.equal(count, 1, 'exactly one `/.owner` line after two cuts');
  } finally {
    s.cleanup();
  }
});

// ── plan 1723 E1: cut-worktree installs deps automatically ──────────────────────
test('plan 1723: cutWorktree installs deps by default → depsInstalled:true, install runs in the worktree dir', () => {
  const installCwds = [];
  // A drive-QUALIFIED anchor (plan 2552): `/main` is rooted but drive-LESS, so `join('/main', x)`
  // stays `\main\x` while a `resolve`-shaped implementation yields `C:\main\x` — the fixture would
  // silently track whichever primitive cutWorktree uses today and red on Windows the day it
  // migrates. Feeding the same anchor to BOTH sides makes join and resolve agree everywhere.
  const mainDir = resolve('/main');
  const r = cutWorktree(mainDir, 'e1-slug', {
    run: () => '',
    push: false,
    runInstall: (cwd) => installCwds.push(cwd),
  });
  assert.equal(r.depsInstalled, true, 'a successful install sets depsInstalled:true');
  assert.deepEqual(
    installCwds,
    [join(mainDir, '.claude/worktrees/e1-slug')],
    'install runs once, in the new worktree directory',
  );
});

test('plan 1723: a FAILING install is NON-FATAL — depsInstalled:false, the cut still returns', () => {
  const r = cutWorktree('/main', 'e1-fail', {
    run: () => '',
    push: false,
    runInstall: () => {
      throw new Error('pnpm store unreachable');
    },
  });
  // the cut succeeded (branch + path returned); only depsInstalled flags the failure
  assert.equal(r.branch, 'worktree-e1-fail');
  assert.equal(r.worktreePath, '.claude/worktrees/e1-fail');
  assert.equal(r.depsInstalled, false, 'a failed install is reported, never thrown');
});

test('plan 1723: installDeps:false skips the install entirely (pure-docs/pure-Python escape hatch)', () => {
  let called = false;
  const r = cutWorktree('/main', 'e1-skip', {
    run: () => '',
    push: false,
    installDeps: false,
    runInstall: () => {
      called = true;
    },
  });
  assert.equal(called, false, 'runInstall is never called when installDeps:false');
  assert.equal(r.depsInstalled, false);
});

test('plan 1723: the install happens AFTER the branch publish (deps never block the empty-branch push)', () => {
  const order = [];
  cutWorktree('/main', 'e1-order', {
    run: (args) => {
      if (args[0] === 'push') order.push('push');
      return '';
    },
    runInstall: () => order.push('install'),
  });
  assert.deepEqual(order, ['push', 'install'], 'publish the empty branch first, then install deps');
});

// ── plan 1957: --adopt takes over a dead cloud session's pushed branch ──────────
// Three acceptance branches: (1) released claim + existing origin branch → worktree
// HEAD == origin/worktree-<slug> with `.owner.takenOverFrom`; (2) claim held by
// ANOTHER session → refuse (never steals, at any age) printing the release-claim
// remediation with the holder's provenance PRE-FILLED; (3) no origin branch →
// refuse pointing at the plain fresh-cut path.

const FREE = () => ({ planId: 'x', held: false });

test('adopt (mocked): gates then fetch/add/push run against origin/worktree-<slug>', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    // the branch-existence gate reads ls-remote output; anything non-empty = exists
    return args[0] === 'ls-remote' ? 'abc\trefs/heads/worktree-901-Infra-dead-cloud\n' : '';
  };
  const r = cutWorktree('/main', '901-Infra-dead-cloud', {
    run,
    installDeps: false,
    adopt: true,
    planStatusFn: FREE,
  });
  assert.deepEqual(calls[0], ['ls-remote', 'origin', 'refs/heads/worktree-901-Infra-dead-cloud']);
  assert.deepEqual(calls[1], ['fetch', 'origin', 'worktree-901-Infra-dead-cloud']);
  assert.deepEqual(calls[2], [
    'worktree',
    'add',
    '-b',
    'worktree-901-Infra-dead-cloud',
    '.claude/worktrees/901-Infra-dead-cloud',
    'origin/worktree-901-Infra-dead-cloud',
  ]);
  assert.deepEqual(calls[3], ['push', '-u', 'origin', 'worktree-901-Infra-dead-cloud']);
  assert.equal(r.adopted, true);
  assert.equal(r.adoptedFrom, 'origin/worktree-901-Infra-dead-cloud');
  assert.equal(r.takenOverFrom, 'unknown');
});

test('adopt (mocked): --adopt=<branch> override cuts from the override, local branch stays worktree-<slug>', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return args[0] === 'ls-remote' ? 'abc\trefs/heads/claude/drain-901\n' : '';
  };
  const r = cutWorktree('/main', '901-Infra-dead-cloud', {
    run,
    installDeps: false,
    adopt: true,
    adoptBranch: 'claude/drain-901',
    planStatusFn: FREE,
  });
  assert.deepEqual(calls[0], ['ls-remote', 'origin', 'refs/heads/claude/drain-901']);
  // an override adopt ALSO probes the spine branch for the divergence gate; the mock
  // returns the same sha for both, so equal-tips passes without an ancestry fetch
  assert.deepEqual(calls[1], ['ls-remote', 'origin', 'refs/heads/worktree-901-Infra-dead-cloud']);
  assert.deepEqual(calls[2], ['fetch', 'origin', 'claude/drain-901']);
  const addCall = calls.find((a) => a[0] === 'worktree');
  assert.equal(addCall[3], 'worktree-901-Infra-dead-cloud', 'local branch is the spine name');
  assert.equal(addCall[5], 'origin/claude/drain-901', 'source is the override branch');
  // the publish step NORMALIZES the work onto the canonical worktree-<slug> origin branch
  assert.deepEqual(calls[4], ['push', '-u', 'origin', 'worktree-901-Infra-dead-cloud']);
  assert.equal(r.adoptedFrom, 'origin/claude/drain-901');
});

// ── plan 3767: an override adopt retires its now-normalized source branch ──────────
test('adopt (mocked): override retires the source branch after the spine push, guarded by an ancestor check', () => {
  const calls = [];
  const TIP = 'aaaa1111';
  const run = (args) => {
    calls.push(args);
    // one fixed tip for every ref probed — the source and the spine agree throughout,
    // so the divergence gate's own equal-tip check passes without a fetch/merge-base.
    // Echo one line PER requested ref: the retire probe (plan 3767 r2) reads both refs in
    // ONE ls-remote and matches the tips up by refname.
    if (args[0] === 'ls-remote')
      return args
        .slice(2)
        .map((ref) => `${TIP}\t${ref}`)
        .join('\n');
    return '';
  };
  const r = cutWorktree('/main', '901-Infra-dead-cloud', {
    run,
    installDeps: false,
    adopt: true,
    adoptBranch: 'claude/drain-901',
    planStatusFn: FREE,
  });
  assert.equal(r.sourceRetired, true, 'the retirement succeeded');
  // the normalization push happens FIRST, the retire delete only after.
  // gpt-review fix (plan 3767): the delete carries a --force-with-lease pinned to the tip
  // this call actually VERIFIED. Without it the two tip probes and the delete are a TOCTOU
  // window — a concurrent push to the source lands a commit the spine does not have, and an
  // unconditional delete-by-name then destroys it while reporting sourceRetired: true.
  // round 3 widened the lease to BOTH refs in one --atomic push (its own test below); what
  // this one pins is the ORDER — the normalization push first, the retirement only after.
  const pushCalls = calls.filter((a) => a[0] === 'push');
  assert.equal(pushCalls.length, 2, 'exactly two pushes: normalize, then retire');
  assert.deepEqual(pushCalls[0], ['push', '-u', 'origin', 'worktree-901-Infra-dead-cloud']);
  assert.ok(pushCalls[1].includes(':refs/heads/claude/drain-901'), 'the second push retires');
  assert.ok(
    pushCalls[1].includes(`--force-with-lease=refs/heads/claude/drain-901:${TIP}`),
    'leased to the verified tip',
  );
  // never the spine branch — only the named source is ever a delete candidate
  assert.ok(
    !calls.some((a) => a[0] === 'push' && a.includes(':refs/heads/worktree-901-Infra-dead-cloud')),
    'the spine branch is never a DELETE refspec — only written back to its own verified tip',
  );
  // gpt-review fix (plan 3767): the ancestor guard runs on the SHAS the live ls-remote probes
  // just returned, never on the `origin/<branch>` local tracking refs. Those refs are a
  // SNAPSHOT: adopt mode fetches only the SOURCE ref, so `origin/<spine>` can be absent or
  // stale in this checkout even while the two remote tips genuinely match — and merge-base
  // would then throw, the catch would report sourceRetired: false, and the duplicate branch
  // this plan exists to retire would survive.
  assert.ok(
    calls.some(
      (a) => a[0] === 'merge-base' && a[1] === '--is-ancestor' && a[2] === TIP && a[3] === TIP,
    ),
    'the ancestor-or-equal guard runs on the verified remote SHAs, not local tracking refs',
  );
  assert.ok(
    !calls.some((a) => a[0] === 'merge-base' && String(a[2]).startsWith('origin/')),
    'no merge-base call reads a local origin/* tracking ref',
  );
});

test('adopt (mocked): a refused delete (cloud proxy 403-by-verb, plan 3756) is non-fatal — sourceRetired:false, cut still succeeds, WARN names the manual command', () => {
  const calls = [];
  const TIP = 'aaaa1111';
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'ls-remote')
      return args
        .slice(2)
        .map((ref) => `${TIP}\t${ref}`)
        .join('\n');
    // gpt-review rounds 2-3 (plan 3767): the retirement is an --atomic push carrying two
    // leases and a `:refs/heads/<src>` DELETE REFSPEC — no `--delete` flag at all, and no fixed
    // argv slot. Identify it by the refspec that does the removing.
    if (args[0] === 'push' && args.includes(':refs/heads/claude/drain-901')) {
      throw new Error('403: refs/heads/* delete refused by proxy');
    }
    return '';
  };
  let stderr = '';
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => {
    stderr += String(s);
    return true;
  };
  let r;
  try {
    r = cutWorktree('/main', '901-Infra-dead-cloud', {
      run,
      installDeps: false,
      adopt: true,
      adoptBranch: 'claude/drain-901',
      planStatusFn: FREE,
    });
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(r.sourceRetired, false, 'non-fatal — the outcome is reported, never thrown');
  assert.equal(r.adopted, true, 'the cut itself still succeeded');
  assert.match(stderr, /WARN/);
  // rounds 2-3: the advertised remediation is the SAME atomic two-ref leased push the code
  // issues — a bare delete-by-name would be the one piece of advice capable of destroying work
  // the code's own guards had just refused to destroy.
  assert.match(stderr, /git push origin --atomic/);
  assert.match(stderr, new RegExp(`--force-with-lease=refs/heads/claude/drain-901:${TIP}`));
  assert.match(
    stderr,
    new RegExp(`--force-with-lease=refs/heads/worktree-901-Infra-dead-cloud:${TIP}`),
  );
  assert.ok(!stderr.includes('git push origin --delete'), 'never an unguarded delete-by-name');
  // gpt-review round 4 (plan 3767): the assertion above is the real one — this used to be an
  // `assert.ok(true, …)` left behind by an edit, which can never fail and so guaranteed nothing.
  assert.match(
    stderr,
    new RegExp(`${TIP}:refs/heads/worktree-901-Infra-dead-cloud`),
    'the advertised command writes the spine back to the verified tip, as the code does',
  );
});

test('adopt (mocked): plain --adopt (source IS the spine) issues NO delete — sourceRetired stays absent', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return args[0] === 'ls-remote' ? 'abc\trefs/heads/worktree-901-Infra-dead-cloud\n' : '';
  };
  const r = cutWorktree('/main', '901-Infra-dead-cloud', {
    run,
    installDeps: false,
    adopt: true,
    planStatusFn: FREE,
  });
  assert.ok(!('sourceRetired' in r), 'no retirement is attempted for the plain adopt path');
  assert.ok(!calls.some((a) => a[0] === 'push' && a.includes('--delete')), 'nothing was deleted');
});

test('adopt (mocked): override with a DIVERGENT origin/worktree-<slug> refuses BEFORE the worktree add (review 1957 [0])', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'ls-remote') {
      // different tips for the override branch vs the spine branch
      return args[2] === 'refs/heads/claude/drain-901'
        ? 'aaaa111\trefs/heads/claude/drain-901\n'
        : 'bbbb222\trefs/heads/worktree-901-Infra-dead-cloud\n';
    }
    if (args[0] === 'merge-base') {
      const err = new Error('not an ancestor');
      err.status = 1; // merge-base's REAL not-an-ancestor answer is exit 1
      throw err;
    }
    return '';
  };
  assert.throws(
    () =>
      cutWorktree('/main', '901-Infra-dead-cloud', {
        run,
        installDeps: false,
        adopt: true,
        adoptBranch: 'claude/drain-901',
        planStatusFn: FREE,
      }),
    /NOT an ancestor|non-fast-forward/,
  );
  assert.ok(
    !calls.some((a) => a[0] === 'worktree'),
    'no worktree was created — the divergence gate fired first',
  );
  assert.ok(!calls.some((a) => a[0] === 'push'), 'nothing was pushed');
});

test('adopt (mocked): override with a fast-forwardable origin/worktree-<slug> proceeds (spine tip is an ancestor)', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'ls-remote') {
      return args[2] === 'refs/heads/claude/drain-901'
        ? 'aaaa111\trefs/heads/claude/drain-901\n'
        : 'bbbb222\trefs/heads/worktree-901-Infra-dead-cloud\n';
    }
    return ''; // merge-base --is-ancestor succeeds (exit 0) → ff-safe
  };
  const r = cutWorktree('/main', '901-Infra-dead-cloud', {
    run,
    installDeps: false,
    adopt: true,
    adoptBranch: 'claude/drain-901',
    planStatusFn: FREE,
  });
  assert.equal(r.adopted, true, 'an ff-safe spine tip does not block the adopt');
  assert.ok(
    calls.some((a) => a[0] === 'merge-base' && a[1] === '--is-ancestor'),
    'ancestry was actually checked',
  );
  // review r2 [3]: the gate's ancestry fetch covers srcBranch, so the main flow must not
  // fetch it a second time — exactly one fetch call in the whole adopt
  const fetches = calls.filter((a) => a[0] === 'fetch');
  assert.deepEqual(
    fetches,
    [['fetch', 'origin', 'claude/drain-901', 'worktree-901-Infra-dead-cloud']],
    'no duplicate fetch after the gate already fetched both tips',
  );
});

test('adopt (mocked): a TRANSIENT merge-base failure rethrows the real error, never a divergence verdict (review r2 [0])', () => {
  const run = (args) => {
    if (args[0] === 'ls-remote') {
      return args[2] === 'refs/heads/claude/drain-901'
        ? 'aaaa111\trefs/heads/claude/drain-901\n'
        : 'bbbb222\trefs/heads/worktree-901-Infra-dead-cloud\n';
    }
    if (args[0] === 'merge-base') {
      const err = new Error('blocked by index.lock after 10 attempts');
      err.status = 128; // NOT the exit-1 not-an-ancestor answer — a genuine failure
      throw err;
    }
    return '';
  };
  assert.throws(
    () =>
      cutWorktree('/main', '901-Infra-dead-cloud', {
        run,
        installDeps: false,
        adopt: true,
        adoptBranch: 'claude/drain-901',
        planStatusFn: FREE,
      }),
    (e) => {
      assert.match(e.message, /index\.lock/, 'the REAL error surfaces');
      assert.doesNotMatch(e.message, /NOT an ancestor/, 'never misreported as divergence');
      return true;
    },
  );
});

test('adopt (mocked): the held-claim re-run line carries the --adopt=<branch> override (review 1957 [1])', () => {
  const heldByOther = () => ({
    planId: '901',
    held: true,
    youAreHolder: false,
    holder: { sessionUuid: 'S-dead', host: 'cloudbox', iso: '2026-07-16T02:00:00Z', ageSec: 93600 },
  });
  assert.throws(
    () =>
      cutWorktree('/main', '901-Infra-dead-cloud', {
        run: () => '',
        installDeps: false,
        adopt: true,
        adoptBranch: 'claude/drain-901',
        planStatusFn: heldByOther,
      }),
    (e) => {
      assert.match(
        e.message,
        /--adopt=claude\/drain-901 --taken-over-from/,
        'the override branch survives into the suggested re-run',
      );
      return true;
    },
  );
});

test('adopt (mocked): a claim held by ANOTHER session REFUSES before any git op, with provenance pre-filled', () => {
  const calls = [];
  const heldByOther = () => ({
    planId: '901',
    held: true,
    youAreHolder: false,
    holder: { sessionUuid: 'S-dead', host: 'cloudbox', iso: '2026-07-16T02:00:00Z', ageSec: 93600 },
  });
  assert.throws(
    () =>
      cutWorktree('/main', '901-Infra-dead-cloud', {
        run: (a) => {
          calls.push(a);
          return '';
        },
        installDeps: false,
        adopt: true,
        planStatusFn: heldByOther,
      }),
    (e) => {
      assert.match(e.message, /REFUSED/);
      assert.match(e.message, /release-claim\.mjs release 901 --force/);
      // spec pin 3: the prior holder is read BEFORE the release remediation is printed,
      // and the re-run line carries it so the operator's release doesn't lose it
      assert.match(
        e.message,
        /--taken-over-from "session=S-dead host=cloudbox iso=2026-07-16T02:00:00Z"/,
      );
      return true;
    },
  );
  assert.deepEqual(calls, [], 'no git op ran — the claim gate fired first');
});

test('adopt (mocked): a claim held by YOURSELF proceeds (the plan-1830 --lock-only takeover flow)', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return args[0] === 'ls-remote' ? 'abc\trefs/heads/worktree-901-Infra-dead-cloud\n' : '';
  };
  const r = cutWorktree('/main', '901-Infra-dead-cloud', {
    run,
    installDeps: false,
    adopt: true,
    planStatusFn: () => ({ planId: '901', held: true, youAreHolder: true, holder: {} }),
  });
  assert.equal(r.adopted, true, 'self-held claim is the sanctioned takeover, not a steal');
});

test('adopt (mocked): an UNPARSEABLE held claim record still refuses (never guesses)', () => {
  assert.throws(
    () =>
      cutWorktree('/main', '901-Infra-dead-cloud', {
        run: () => '',
        installDeps: false,
        adopt: true,
        planStatusFn: () => ({ planId: '901', held: true, youAreHolder: false, holder: null }),
      }),
    /UNPARSEABLE/,
  );
});

test('adopt (mocked): no origin branch → refuse pointing at the plain fresh-cut path', () => {
  const calls = [];
  assert.throws(
    () =>
      cutWorktree('/main', '901-Infra-dead-cloud', {
        run: (args) => {
          calls.push(args);
          return ''; // ls-remote empty = branch absent
        },
        installDeps: false,
        adopt: true,
        planStatusFn: FREE,
      }),
    /nothing to adopt|fresh-cut/,
  );
  assert.equal(calls.length, 1, 'only the ls-remote probe ran — no fetch/add/push');
});

test('adopt (mocked): a slug with no leading plan id refuses (claim gate is keyed on refs/claims/<id>)', () => {
  assert.throws(
    () =>
      cutWorktree('/main', 'no-id-slug', {
        run: () => '',
        installDeps: false,
        adopt: true,
        planStatusFn: FREE,
      }),
    /plan slug with a leading numeric id/,
  );
});

// ── real-git adopt: the acceptance criteria against a throwaway bare origin ─────
test('adopt (real git): worktree HEAD == origin/worktree-<slug>, pushed work present, .owner carries takenOverFrom', () => {
  const s = makeOriginAndClones();
  try {
    // B is the "dead cloud session": it pushed real work on worktree-<slug>, then died.
    const slug = '901-Infra-dead-cloud';
    execFileSync('git', ['-C', s.B, 'checkout', '-q', '-b', `worktree-${slug}`]);
    writeFileSync(join(s.B, 'cloud-work.txt'), 'pushed by the dead cloud session\n');
    execFileSync('git', ['-C', s.B, 'add', '-A']);
    execFileSync('git', ['-C', s.B, 'commit', '-qm', 'wip(cloud): real pushed work']);
    execFileSync('git', ['-C', s.B, 'push', '-q', 'origin', `worktree-${slug}`]);
    const cloudTip = execFileSync('git', ['-C', s.B, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    // A adopts. The claim gate runs the REAL planStatus — refs/claims/901 is unheld on
    // origin, so this also exercises the released-claim happy path end-to-end.
    const r = cutWorktree(s.A, slug, {
      installDeps: false,
      adopt: true,
      takenOverFrom: 'session=S-dead host=cloudbox iso=2026-07-16T02:00:00Z',
    });
    const wt = join(s.A, '.claude', 'worktrees', slug);
    const wtHead = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(
      wtHead,
      cloudTip,
      'worktree HEAD == the cloud branch tip (NOT an origin/master cut)',
    );
    assert.ok(existsSync(join(wt, 'cloud-work.txt')), 'the pushed work is present');
    const owner = JSON.parse(readFileSync(join(wt, '.owner'), 'utf8'));
    assert.equal(owner.takenOverFrom, 'session=S-dead host=cloudbox iso=2026-07-16T02:00:00Z');
    assert.equal(
      owner.sessionUuid,
      null,
      'TOFU binding is preserved — the hook claims on first write',
    );
    assert.equal(r.adopted, true);
  } finally {
    s.cleanup();
  }
});

test('adopt (real git): a REAL held refs/claims/<id> refuses with the holder in the message', () => {
  const s = makeOriginAndClones();
  try {
    const slug = '902-Infra-dead-cloud';
    // the dead session's branch…
    execFileSync('git', ['-C', s.B, 'checkout', '-q', '-b', `worktree-${slug}`]);
    writeFileSync(join(s.B, 'w.txt'), 'w\n');
    execFileSync('git', ['-C', s.B, 'add', '-A']);
    execFileSync('git', ['-C', s.B, 'commit', '-qm', 'wip']);
    execFileSync('git', ['-C', s.B, 'push', '-q', 'origin', `worktree-${slug}`]);
    // …and its still-held claim ref (a parentless commit on the empty tree, the
    // claim-plan.mjs shape) pushed to refs/claims/902.
    const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const claimSha = execFileSync('git', ['-C', s.B, 'commit-tree', EMPTY_TREE], {
      encoding: 'utf8',
      input: 'claim plan=902\nsession=S-dead\nhost=cloudbox\niso=2026-07-16T02:00:00Z\n',
    }).trim();
    execFileSync('git', ['-C', s.B, 'push', '-q', 'origin', `${claimSha}:refs/claims/902`]);

    assert.throws(
      () => cutWorktree(s.A, slug, { installDeps: false, adopt: true }),
      (e) => {
        assert.match(e.message, /REFUSED/);
        assert.match(e.message, /session=S-dead/);
        assert.match(e.message, /release-claim\.mjs release 902 --force/);
        return true;
      },
    );
    assert.ok(
      !existsSync(join(s.A, '.claude', 'worktrees', slug)),
      'no worktree was created on refusal',
    );
  } finally {
    s.cleanup();
  }
});

test('adopt (real git): --adopt=<override> normalizes the work onto origin/worktree-<slug>', () => {
  const s = makeOriginAndClones();
  try {
    const slug = '903-Infra-drain-branch';
    execFileSync('git', ['-C', s.B, 'checkout', '-q', '-b', `claude/drain-${slug}`]);
    writeFileSync(join(s.B, 'drain.txt'), 'pushed to the fallback branch\n');
    execFileSync('git', ['-C', s.B, 'add', '-A']);
    execFileSync('git', ['-C', s.B, 'commit', '-qm', 'wip(drain): fallback-branch work']);
    execFileSync('git', ['-C', s.B, 'push', '-q', 'origin', `claude/drain-${slug}`]);
    const drainTip = execFileSync('git', ['-C', s.B, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    cutWorktree(s.A, slug, {
      installDeps: false,
      adopt: true,
      adoptBranch: `claude/drain-${slug}`,
    });
    // the adopt's publish step created the canonical spine branch on origin, at the drain tip
    const originRef = execFileSync(
      'git',
      ['-C', s.A, 'ls-remote', 'origin', `refs/heads/worktree-${slug}`],
      { encoding: 'utf8' },
    ).trim();
    assert.ok(originRef.startsWith(drainTip), 'origin/worktree-<slug> now exists at the drain tip');
  } finally {
    s.cleanup();
  }
});

test('adopt (real git): override refuses when a genuinely divergent origin/worktree-<slug> exists', () => {
  const s = makeOriginAndClones();
  try {
    const slug = '904-Infra-divergent';
    // the spine branch diverges: one commit off master…
    execFileSync('git', ['-C', s.B, 'checkout', '-q', '-b', `worktree-${slug}`, 'master']);
    writeFileSync(join(s.B, 'spine.txt'), 'spine-only commit\n');
    execFileSync('git', ['-C', s.B, 'add', '-A']);
    execFileSync('git', ['-C', s.B, 'commit', '-qm', 'spine work']);
    execFileSync('git', ['-C', s.B, 'push', '-q', 'origin', `worktree-${slug}`]);
    // …and the drain branch carries a DIFFERENT commit off master (neither is an ancestor)
    execFileSync('git', ['-C', s.B, 'checkout', '-q', '-b', `claude/drain-${slug}`, 'master']);
    writeFileSync(join(s.B, 'drain.txt'), 'drain-only commit\n');
    execFileSync('git', ['-C', s.B, 'add', '-A']);
    execFileSync('git', ['-C', s.B, 'commit', '-qm', 'drain work']);
    execFileSync('git', ['-C', s.B, 'push', '-q', 'origin', `claude/drain-${slug}`]);

    assert.throws(
      () =>
        cutWorktree(s.A, slug, {
          installDeps: false,
          adopt: true,
          adoptBranch: `claude/drain-${slug}`,
        }),
      /NOT an ancestor/,
    );
    assert.ok(
      !existsSync(join(s.A, '.claude', 'worktrees', slug)),
      'no worktree was created on the divergence refusal',
    );
  } finally {
    s.cleanup();
  }
});

// ── plan 2599: --adopt is batch-aware — adoptGates() reads the batch manifest's
// members[] and runs the SAME held-claim gate once per member instead of once for
// planIdOf(slug). Four acceptance branches: (1) every member unheld → proceeds like a
// solo adopt; (2) ≥1 member held by another session → refuse naming EVERY held member,
// no git mutation; (3) missing manifest → refuse naming the expected path; (4) an
// unparseable manifest → the same refusal class.

// A throwaway mainDir with a real `docs/superpowers/batches/<slug>/manifest.json` on
// disk — adoptGates() reads this file for real (readFileSync/existsSync), even though
// every OTHER IO in these tests is mocked via the injected `run` (mirrors the mocked
// adopt tests above, which likewise leave real fs paths uninvolved except this one).
function makeBatchMainDir(slug, manifestText) {
  const mainDir = mkdtempSync(join(tmpdir(), 'cut-wt-batch-'));
  const batchDir = join(mainDir, 'docs/superpowers/batches', slug);
  mkdirSync(batchDir, { recursive: true });
  if (manifestText !== null) {
    writeFileSync(join(batchDir, 'manifest.json'), manifestText);
  }
  return mainDir;
}

test('adopt (mocked, batch): all member claims unheld ⇒ gates pass, proceeds like a solo adopt', () => {
  const slug = 'batch-2026-07-27-sonnet-smalls-2';
  const mainDir = makeBatchMainDir(slug, JSON.stringify({ members: ['2550', '2553'] }));
  try {
    const calls = [];
    const statusCalls = [];
    const run = (args) => {
      calls.push(args);
      return args[0] === 'ls-remote' ? `abc\trefs/heads/worktree-${slug}\n` : '';
    };
    const r = cutWorktree(mainDir, slug, {
      run,
      installDeps: false,
      adopt: true,
      planStatusFn: (dir, planId) => {
        statusCalls.push(planId);
        return { planId, held: false };
      },
    });
    assert.deepEqual(statusCalls, ['2550', '2553'], 'gated every member, in manifest order');
    assert.equal(r.adopted, true);
    assert.equal(r.adoptedFrom, `origin/worktree-${slug}`);
    assert.deepEqual(calls[0], ['ls-remote', 'origin', `refs/heads/worktree-${slug}`]);
    assert.ok(
      calls.some((a) => a[0] === 'worktree' && a[1] === 'add'),
      'the worktree was actually created',
    );
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
});

test('adopt (mocked, batch): a member held by ANOTHER session refuses, naming EVERY held member, no git mutation', () => {
  const slug = 'batch-2026-07-27-sonnet-smalls-2';
  const mainDir = makeBatchMainDir(slug, JSON.stringify({ members: ['2550', '2553'] }));
  try {
    const calls = [];
    const holders = {
      2550: { held: true, youAreHolder: false, holder: null }, // unparseable
      2553: {
        held: true,
        youAreHolder: false,
        holder: {
          sessionUuid: 'S-dead',
          host: 'cloudbox',
          iso: '2026-07-27T02:00:00Z',
          ageSec: 75600,
        },
      },
    };
    assert.throws(
      () =>
        cutWorktree(mainDir, slug, {
          run: (a) => {
            calls.push(a);
            return '';
          },
          installDeps: false,
          adopt: true,
          planStatusFn: (dir, planId) => ({ planId, ...holders[planId] }),
        }),
      (e) => {
        assert.match(e.message, /REFUSED/);
        // both members named — one UNPARSEABLE, one with full holder provenance
        assert.match(e.message, /refs\/claims\/2550.*UNPARSEABLE/);
        assert.match(
          e.message,
          /refs\/claims\/2553.*session=S-dead host=cloudbox iso=2026-07-27T02:00:00Z/,
        );
        // a release-claim line PER held member
        assert.match(e.message, /release-claim\.mjs release 2550 --force/);
        assert.match(e.message, /release-claim\.mjs release 2553 --force/);
        // ONE combined re-run line carrying --taken-over-from
        assert.match(e.message, new RegExp(`cut-worktree\\.mjs ${slug} --adopt --taken-over-from`));
        // ruling 2: the per-member --lock-only recipe is discoverable in the same message
        assert.match(e.message, /claim-plan\.mjs acquire 2550 --slug .* --lock-only/);
        assert.match(e.message, /claim-plan\.mjs acquire 2553 --slug .* --lock-only/);
        return true;
      },
    );
    assert.deepEqual(calls, [], 'no git op ran — the batch claim gate fired before any exec()');
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
});

test('adopt (mocked, batch): a batch member held by YOURSELF proceeds (no refusal for that member)', () => {
  const slug = 'batch-2026-07-27-sonnet-smalls-2';
  const mainDir = makeBatchMainDir(slug, JSON.stringify({ members: ['2550', '2553'] }));
  try {
    const run = (args) => (args[0] === 'ls-remote' ? `abc\trefs/heads/worktree-${slug}\n` : '');
    const r = cutWorktree(mainDir, slug, {
      run,
      installDeps: false,
      adopt: true,
      planStatusFn: (dir, planId) => ({ planId, held: true, youAreHolder: true, holder: {} }),
    });
    assert.equal(r.adopted, true, 'every member self-held is the sanctioned takeover, not a steal');
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
});

test('adopt (mocked, batch): a missing manifest refuses, naming the expected manifest path, no git mutation', () => {
  const slug = 'batch-2026-07-27-sonnet-smalls-2';
  const mainDir = makeBatchMainDir(slug, null); // no manifest.json written at all
  try {
    const expectedPath = join(mainDir, 'docs/superpowers/batches', slug, 'manifest.json');
    const calls = [];
    assert.throws(
      () =>
        cutWorktree(mainDir, slug, {
          run: (a) => {
            calls.push(a);
            return '';
          },
          installDeps: false,
          adopt: true,
        }),
      (e) => {
        assert.match(e.message, /REFUSED/);
        assert.ok(e.message.includes(expectedPath), 'names the expected manifest path');
        return true;
      },
    );
    // ruling 3: never degrades to a branch-only adopt — no git op ran at all
    assert.deepEqual(calls, [], 'no git op ran — the manifest gate fired before any exec()');
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
});

test('adopt (mocked, batch): an unparseable manifest refuses in the same class as a missing one', () => {
  const slug = 'batch-2026-07-27-sonnet-smalls-2';
  const mainDir = makeBatchMainDir(slug, '{ this is not json');
  try {
    const expectedPath = join(mainDir, 'docs/superpowers/batches', slug, 'manifest.json');
    assert.throws(
      () =>
        cutWorktree(mainDir, slug, {
          run: () => '',
          installDeps: false,
          adopt: true,
        }),
      (e) => {
        assert.match(e.message, /REFUSED/);
        assert.ok(e.message.includes(expectedPath), 'names the expected manifest path');
        return true;
      },
    );
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
});

test("adopt (mocked, batch): a manifest with an empty members[] refuses (parseBatchManifest's null contract)", () => {
  const slug = 'batch-2026-07-27-sonnet-smalls-2';
  const mainDir = makeBatchMainDir(slug, JSON.stringify({ members: [] }));
  try {
    assert.throws(
      () =>
        cutWorktree(mainDir, slug, {
          run: () => '',
          installDeps: false,
          adopt: true,
        }),
      /REFUSED/,
    );
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
});

// ── plan 2599 review fixes: the four confirmed defects the first round's fan-out found.

// A mainDir whose manifest sits at the LEGACY docs/handoff/batches/<slug>.json path — the
// shape a batch claimed before the plan-1467 migration still has on disk.
function makeLegacyBatchMainDir(slug, manifestText) {
  const mainDir = mkdtempSync(join(tmpdir(), 'cut-wt-batch-legacy-'));
  mkdirSync(join(mainDir, 'docs/handoff/batches'), { recursive: true });
  writeFileSync(join(mainDir, 'docs/handoff/batches', `${slug}.json`), manifestText);
  return mainDir;
}

test('adopt (mocked, batch): a LEGACY-path manifest resolves — a grandfathered batch is still adoptable [review 2599 [0]]', () => {
  const slug = 'batch-2026-07-27-sonnet-smalls-2';
  const mainDir = makeLegacyBatchMainDir(slug, JSON.stringify({ members: ['2550', '2553'] }));
  try {
    const statusCalls = [];
    const r = cutWorktree(mainDir, slug, {
      run: (args) => (args[0] === 'ls-remote' ? `abc\trefs/heads/worktree-${slug}\n` : ''),
      installDeps: false,
      adopt: true,
      planStatusFn: (dir, planId) => {
        statusCalls.push(planId);
        return { planId, held: false };
      },
    });
    assert.deepEqual(statusCalls, ['2550', '2553'], 'gated every member off the legacy manifest');
    assert.equal(r.adopted, true, 'a legacy-path batch is NOT refused as "manifest not found"');
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
});

test('adopt (mocked, batch): the not-found refusal names BOTH probed paths [review 2599 [0]]', () => {
  const slug = 'batch-2026-07-27-sonnet-smalls-2';
  const mainDir = makeBatchMainDir(slug, null);
  try {
    assert.throws(
      () => cutWorktree(mainDir, slug, { run: () => '', installDeps: false, adopt: true }),
      (e) => {
        assert.match(e.message, /REFUSED/);
        assert.match(e.message, /docs\/superpowers\/batches\/.*\/manifest\.json/);
        assert.match(e.message, /docs\/handoff\/batches\/.*\.json/);
        return true;
      },
    );
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
});

test('adopt (mocked, batch): an unusable member entry refuses in the torn-manifest class, no git mutation [review 2599 [1]]', () => {
  const slug = 'batch-2026-07-27-sonnet-smalls-2';
  const mainDir = makeBatchMainDir(slug, JSON.stringify({ members: ['2550', 'not-a-plan-id'] }));
  try {
    const calls = [];
    assert.throws(
      () =>
        cutWorktree(mainDir, slug, {
          run: (a) => {
            calls.push(a);
            return '';
          },
          installDeps: false,
          adopt: true,
          planStatusFn: (dir, planId) => {
            if (!/^\d+$/.test(planId)) throw new Error(`cannot derive a plan id from "${planId}"`);
            return { planId, held: false };
          },
        }),
      (e) => {
        assert.match(e.message, /REFUSED/);
        assert.match(e.message, /unusable member entry "not-a-plan-id"/);
        // review 2599 r3 [0]: the regex's own reason travels with the refusal
        assert.match(e.message, /cannot derive a plan id from "not-a-plan-id"/);
        assert.match(e.message, /no branch-only fallback/i);
        return true;
      },
    );
    assert.deepEqual(calls, [], 'refused before any git op ran');
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
});

test('adopt (mocked, batch): --taken-over-from pre-fills from the first READABLE holder, not held[0] [review 2599 [2]]', () => {
  const slug = 'batch-2026-07-27-sonnet-smalls-2';
  const mainDir = makeBatchMainDir(slug, JSON.stringify({ members: ['2550', '2553'] }));
  try {
    const holders = {
      2550: { held: true, youAreHolder: false, holder: null }, // unparseable — first in order
      2553: {
        held: true,
        youAreHolder: false,
        holder: { sessionUuid: 'S-dead', host: 'cloudbox', iso: '2026-07-27T02:00:00Z' },
      },
    };
    assert.throws(
      () =>
        cutWorktree(mainDir, slug, {
          run: () => '',
          installDeps: false,
          adopt: true,
          planStatusFn: (dir, planId) => ({ planId, ...holders[planId] }),
        }),
      (e) => {
        assert.match(
          e.message,
          /--taken-over-from "session=S-dead host=cloudbox iso=2026-07-27T02:00:00Z"/,
          'carried 2553\'s readable provenance rather than degrading to "unknown"',
        );
        assert.doesNotMatch(e.message, /--taken-over-from "unknown"/);
        return true;
      },
    );
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
});

test('adopt (mocked, batch): the --lock-only recipe covers ONLY the held members [review 2599 [3]]', () => {
  const slug = 'batch-2026-07-27-sonnet-smalls-2';
  const mainDir = makeBatchMainDir(slug, JSON.stringify({ members: ['2550', '2553', '2560'] }));
  try {
    assert.throws(
      () =>
        cutWorktree(mainDir, slug, {
          run: () => '',
          installDeps: false,
          adopt: true,
          planStatusFn: (dir, planId) =>
            planId === '2553'
              ? {
                  planId,
                  held: true,
                  youAreHolder: false,
                  holder: { sessionUuid: 'S-dead', host: 'vm', iso: '2026-07-27T02:00:00Z' },
                }
              : { planId, held: false },
        }),
      (e) => {
        assert.match(e.message, /acquire 2553 --slug .* --lock-only/);
        assert.doesNotMatch(e.message, /acquire 2550 --slug/, 'unheld member got no recipe line');
        assert.doesNotMatch(e.message, /acquire 2560 --slug/, 'unheld member got no recipe line');
        return true;
      },
    );
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
});

test('adopt (mocked, batch): a transient claim-probe failure surfaces as ITSELF, not as a torn manifest [review 2599 r2 [0]]', () => {
  const slug = 'batch-2026-07-27-sonnet-smalls-2';
  const mainDir = makeBatchMainDir(slug, JSON.stringify({ members: ['2550', '2553'] }));
  try {
    assert.throws(
      () =>
        cutWorktree(mainDir, slug, {
          run: () => '',
          installDeps: false,
          adopt: true,
          // The member ids are perfectly valid; the ls-remote behind planStatus blipped.
          planStatusFn: () => {
            throw new Error('fatal: unable to access origin: Could not resolve host');
          },
        }),
      (e) => {
        assert.match(e.message, /Could not resolve host/, 'the real cause reached the operator');
        assert.doesNotMatch(e.message, /unusable member entry/);
        assert.doesNotMatch(e.message, /coord state is torn/);
        return true;
      },
    );
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
});

// ── plan 3767, gpt-review round 2: the retirement's remaining sharp edges ──────────
// Round 1 shipped the retire block with three defects five review angles converged on: two
// SEPARATE tip probes (not a coherent snapshot, so a force-push between them can make an
// unequal pair look equal), and a WARN whose manual command dropped the lease the code itself
// had just relied on.

test('adopt (mocked): both tips are read in ONE ls-remote — two reads are not a coherent snapshot', () => {
  const calls = [];
  const TIP = 'aaaa1111';
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'ls-remote')
      return args
        .slice(2)
        .map((ref) => `${TIP}\t${ref}`)
        .join('\n');
    return '';
  };
  const r = cutWorktree('/main', '901-Infra-dead-cloud', {
    run,
    installDeps: false,
    adopt: true,
    adoptBranch: 'claude/drain-901',
    planStatusFn: FREE,
  });
  assert.equal(r.sourceRetired, true);
  const retireProbe = calls.filter(
    (a) =>
      a[0] === 'ls-remote' &&
      a.includes('refs/heads/claude/drain-901') &&
      a.includes('refs/heads/worktree-901-Infra-dead-cloud'),
  );
  assert.equal(retireProbe.length, 1, 'exactly ONE probe carries BOTH refs');
});

test('adopt (mocked): a LEASE-rejected delete prints a manual command that KEEPS the lease', () => {
  // The lease refusing is the case where an unleased manual command is most dangerous: it
  // rejected precisely because the source advanced, so `--delete` by name would destroy the
  // commit the lease just saved.
  const TIP = 'aaaa1111';
  const run = (args) => {
    if (args[0] === 'ls-remote')
      return args
        .slice(2)
        .map((ref) => `${TIP}\t${ref}`)
        .join('\n');
    if (args[0] === 'push' && args.includes(':refs/heads/claude/drain-901'))
      throw new Error('! [rejected] (delete) -> claude/drain-901 (stale info)');
    return '';
  };
  let stderr = '';
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => {
    stderr += String(s);
    return true;
  };
  let r;
  try {
    r = cutWorktree('/main', '901-Infra-dead-cloud', {
      run,
      installDeps: false,
      adopt: true,
      adoptBranch: 'claude/drain-901',
      planStatusFn: FREE,
    });
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(r.sourceRetired, false);
  // rounds 2-3: the advertised remediation is the SAME atomic two-ref leased push the code
  // issues — a bare delete-by-name would be the one piece of advice capable of destroying work
  // the code's own guards had just refused to destroy.
  assert.match(stderr, /git push origin --atomic/);
  assert.match(stderr, new RegExp(`--force-with-lease=refs/heads/claude/drain-901:${TIP}`));
  assert.match(
    stderr,
    new RegExp(`--force-with-lease=refs/heads/worktree-901-Infra-dead-cloud:${TIP}`),
  );
  assert.ok(!stderr.includes('git push origin --delete'), 'never an unguarded delete-by-name');
  assert.match(
    stderr,
    new RegExp(`${TIP}:refs/heads/worktree-901-Infra-dead-cloud`),
    'the remediation the operator is handed is the same shape the code issues',
  );
  assert.doesNotMatch(
    stderr,
    /git push origin --delete claude\/drain-901/,
    'never an unguarded delete-by-name',
  );
});

// ── plan 3767, gpt-review round 3 ─────────────────────────────────────────────────
// Round 2's lease covered the SOURCE ref only, and its WARN printed a runnable command in a
// state where running it would destroy the adopted work.

test('adopt (mocked): the retire push is ONE atomic push leasing BOTH refs, not a delete by name', () => {
  const calls = [];
  const TIP = 'aaaa1111';
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'ls-remote')
      return args
        .slice(2)
        .map((ref) => `${TIP}\t${ref}`)
        .join('\n');
    return '';
  };
  const r = cutWorktree('/main', '901-Infra-dead-cloud', {
    run,
    installDeps: false,
    adopt: true,
    adoptBranch: 'claude/drain-901',
    planStatusFn: FREE,
  });
  assert.equal(r.sourceRetired, true);
  const retire = calls.find((a) => a[0] === 'push' && a.includes(':refs/heads/claude/drain-901'));
  assert.ok(retire, 'the source is removed by a delete REFSPEC, so it can ride a value refspec');
  assert.ok(retire.includes('--atomic'), 'all-or-nothing: either lease going stale rejects both');
  assert.ok(
    retire.includes(`--force-with-lease=refs/heads/claude/drain-901:${TIP}`),
    'the SOURCE is leased to the verified tip',
  );
  assert.ok(
    retire.includes(`--force-with-lease=refs/heads/worktree-901-Infra-dead-cloud:${TIP}`),
    'and so is the SPINE — a spine force-pushed away must not let the source be deleted',
  );
  assert.ok(
    retire.includes(`${TIP}:refs/heads/worktree-901-Infra-dead-cloud`),
    'the spine no-op write is what gives its lease something to guard',
  );
  assert.ok(!retire.includes('--delete'), 'git refuses --delete beside a value refspec');
});

test('adopt (mocked): a FAILED equality proof prints NO runnable retire command', () => {
  // The dangerous shape round 2 shipped: the spine does not carry the source, `srcTip` is
  // nonetheless known, and the advertised lease matches the live remote — so an operator running
  // the printed command would succeed at deleting the only copy of the adopted work.
  const run = (args) => {
    if (args[0] === 'ls-remote')
      return args
        .slice(2)
        .map((ref) => `${ref.includes('claude/drain-901') ? 'aaaa1111' : 'bbbb2222'}\t${ref}`)
        .join('\n');
    return '';
  };
  let stderr = '';
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => {
    stderr += String(s);
    return true;
  };
  let r;
  try {
    r = cutWorktree('/main', '901-Infra-dead-cloud', {
      run,
      installDeps: false,
      adopt: true,
      adoptBranch: 'claude/drain-901',
      planStatusFn: FREE,
    });
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(r.sourceRetired, false);
  assert.equal(r.adopted, true, 'the cut itself still succeeded');
  assert.doesNotMatch(stderr, /git push origin/, 'no shell command is advertised at all');
  assert.match(stderr, /was NOT shown to carry/, 'it says what is wrong instead');
  assert.doesNotMatch(stderr, /</, 'and never a `<placeholder>` — angle brackets are redirections');
});

// ── plan 3956: sparse plan worktrees ─────────────────────────────────────────────────────────

const SPARSE_BODY = sw(
  '# Infra: a plan\n\n> 🟩 **SEED-WRITE: NO** — tooling only.\n\nSome body.\n',
);

test('planWorktreeMode: every dense rule names itself; the sparse default names the excluded folder', () => {
  // --dense wins over everything, including a plan that would otherwise be sparse.
  assert.deepEqual(
    planWorktreeMode({ planText: SPARSE_BODY, basename: '101-Infra-x.md', dense: true }),
    {
      dense: true,
      rule: '--dense',
    },
  );
  // No plan text at all (batch slug, non-plan worktree, unreadable file) → DENSE, never sparse.
  assert.equal(planWorktreeMode({}).dense, true);
  assert.match(planWorktreeMode({ planText: null, basename: 'batch-x' }).rule, /not resolved/);
  // 🟥 and MAYBE keep the worktree dense, and so does NO BANNER AT ALL: a bannerless plan can
  // reach in-progress/ (the mint only warns), and readSeedMarker's 🟩-on-missing default is
  // display-side only -- here, as in queue-drain's mutex, unknown is the seed-write side.
  assert.match(
    planWorktreeMode({ planText: sw('> 🟥 **SEED-WRITE: YES**\n'), basename: '102-Infra-x.md' })
      .rule,
    /SEED-WRITE banner is yes/,
  );
  assert.match(
    planWorktreeMode({ planText: sw('> 🟥 **SEED-WRITE: MAYBE**\n'), basename: '102-Infra-x.md' })
      .rule,
    /SEED-WRITE banner is maybe/,
  );
  assert.deepEqual(
    planWorktreeMode({
      planText: '# Infra: no banner\n\nSome body.\n',
      basename: '102-Infra-x.md',
    }),
    // NOT run through sw(): this is the module's own hardcoded prose (cut-worktree.mjs line
    // ~179), which never varies with the configured label — only the fixture BANNER TEXT the
    // module reads needs to track MUTATION_BANNER_LABEL, not its own output strings.
    { dense: true, rule: 'no SEED-WRITE banner (unknown is dense)' },
  );
  // The store names are DERIVED from the exclude list, so a store added there is a dense term
  // in the same edit.
  for (const p of PLAN_WORKTREE_EXCLUDED_PATHS)
    assert.ok(DENSE_BODY_TERMS.includes(p.split('/').pop()), `${p} must be a dense body term`);
  // Category Pipe / DQ, with or without a lane marker; the retired `Price` is NOT a rule.
  for (const b of ['103-Pipe-extract-se-x.md', '103-FABLE-DQ-x.md', '103-SOL-Pipe-x.md'])
    assert.match(
      planWorktreeMode({ planText: SPARSE_BODY, basename: b }).rule,
      /^category (Pipe|DQ)$/,
    );
  assert.equal(
    planWorktreeMode({
      planText: SPARSE_BODY,
      basename: '103-Price-x.md',
      excludes: PLAN_WORKTREE_EXCLUDED_PATHS,
    }).dense,
    false,
  );
  // Body vocabulary.
  for (const term of DENSE_BODY_TERMS)
    assert.equal(
      planWorktreeMode({
        planText: `${SPARSE_BODY}\nreads ${term} at land time`,
        basename: '104-Infra-x.md',
        excludes: PLAN_WORKTREE_EXCLUDED_PATHS,
      }).rule,
      `body mentions "${term}"`,
    );
  // The sparse default: Infra/Coord/Biz/UI/App/SEO/Other, 🟩, no vocabulary.
  for (const b of [
    '105-Infra-x.md',
    '105-Coord-x.md',
    '105-FABLE-Biz-x.md',
    '105-UI-x.md',
    '105-Other-x.md',
  ])
    assert.deepEqual(
      planWorktreeMode({
        planText: SPARSE_BODY,
        basename: b,
        excludes: PLAN_WORKTREE_EXCLUDED_PATHS,
      }),
      {
        dense: false,
        rule: `sparse cone (${PLAN_WORKTREE_EXCLUDED_PATHS.join(', ')} left off disk)`,
      },
    );
  // A malformed / legacy basename has no category rule but still gets the body + banner rules.
  assert.equal(
    planWorktreeMode({
      planText: SPARSE_BODY,
      basename: '2026-05-17-legacy.md',
      excludes: PLAN_WORKTREE_EXCLUDED_PATHS,
    }).dense,
    false,
  );
  assert.ok(Object.isFrozen(DENSE_CATEGORIES) && Object.isFrozen(DENSE_BODY_TERMS));
});

test('planWorktreeMode: an omitted `excludes` defaults to [] (empty = no exclusions), never a TypeError (plan 4071 review round 1, finding c76ab7)', () => {
  // A sparse-eligible plan with NO excludes argument at all must not throw reaching
  // denseBodyTermsFor([]) / the sparse-default message's `excludes.join`.
  assert.deepEqual(planWorktreeMode({ planText: SPARSE_BODY, basename: '105-Infra-x.md' }), {
    dense: false,
    rule: 'sparse cone ( left off disk)',
  });
  // An explicit empty array is the same as omitting the key.
  assert.deepEqual(
    planWorktreeMode({ planText: SPARSE_BODY, basename: '105-Infra-x.md', excludes: [] }),
    { dense: false, rule: 'sparse cone ( left off disk)' },
  );
});

test('resolvePlanForSlug: a batch slug, a slug with no id, and an untracked plan all resolve to null (→ dense)', () => {
  const s = makeOriginAndClones();
  try {
    assert.equal(resolvePlanForSlug(s.A, 'batch-2026-09-12-abc'), null);
    assert.equal(resolvePlanForSlug(s.A, 'no-numeric-id'), null);
    assert.equal(resolvePlanForSlug(s.A, '9999-Infra-not-filed'), null);
    // A tracked in-progress plan resolves, with its basename and body.
    landNested(s, s.A, 'docs/superpowers/plans/in-progress/1234-Infra-x.md', SPARSE_BODY.trim());
    const r = resolvePlanForSlug(s.A, '1234-Infra-x');
    assert.equal(r.rel, 'docs/superpowers/plans/in-progress/1234-Infra-x.md');
    assert.equal(r.basename, '1234-Infra-x.md');
    assert.match(r.text, new RegExp(`${MUTATION_BANNER_LABEL}: NO`));
  } finally {
    s.cleanup();
  }
});

test('cutWorktree (mocked): a SPARSE cut adds --no-checkout, applies the cone, then populates with one checkout; DENSE argv is byte-identical to before', () => {
  const calls = [];
  const wtCalls = [];
  const applied = [];
  const run = (args) => {
    calls.push(args);
    return '';
  };
  const r = cutWorktree('/main', '1234-Infra-x', {
    run,
    installDeps: false,
    resolvePlan: () => ({
      rel: 'docs/superpowers/plans/in-progress/1234-Infra-x.md',
      basename: '1234-Infra-x.md',
      text: SPARSE_BODY,
    }),
    applySparse: (dir) => {
      applied.push(dir);
      return true;
    },
    runInWorktree: (args) => wtCalls.push(args),
  });
  assert.deepEqual(calls[0], ['fetch', 'origin', 'master']);
  assert.deepEqual(calls[1], [
    'worktree',
    'add',
    '--no-checkout',
    '-b',
    'worktree-1234-Infra-x',
    '.claude/worktrees/1234-Infra-x',
    'origin/master',
  ]);
  assert.deepEqual(calls[2], ['push', '-u', 'origin', 'worktree-1234-Infra-x']);
  assert.equal(applied.length, 1, 'the cone is applied exactly once');
  assert.equal(resolve(applied[0]), resolve('/main/.claude/worktrees/1234-Infra-x'));
  assert.deepEqual(wtCalls, [['checkout']], 'one populating checkout, in the worktree');
  assert.equal(r.sparse, true);
  assert.match(r.modeRule, /^sparse cone/);

  // Same plan, `--dense`: no --no-checkout, no cone, no checkout -- the pre-3956 argv exactly.
  calls.length = 0;
  wtCalls.length = 0;
  applied.length = 0;
  const d = cutWorktree('/main', '1234-Infra-x', {
    run,
    installDeps: false,
    dense: true,
    resolvePlan: () => ({ rel: 'x', basename: '1234-Infra-x.md', text: SPARSE_BODY }),
    applySparse: (dir) => applied.push(dir),
    runInWorktree: (args) => wtCalls.push(args),
  });
  assert.deepEqual(calls[1], [
    'worktree',
    'add',
    '-b',
    'worktree-1234-Infra-x',
    '.claude/worktrees/1234-Infra-x',
    'origin/master',
  ]);
  assert.equal(applied.length, 0);
  assert.equal(wtCalls.length, 0);
  assert.deepEqual([d.sparse, d.modeRule], [false, '--dense']);

  // A Pipe plan is dense by class even without the flag.
  calls.length = 0;
  const p = cutWorktree('/main', '1235-Pipe-extract-se-x', {
    run,
    installDeps: false,
    resolvePlan: () => ({ rel: 'x', basename: '1235-Pipe-extract-se-x.md', text: SPARSE_BODY }),
    applySparse: (dir) => applied.push(dir),
    runInWorktree: (args) => wtCalls.push(args),
  });
  assert.equal(calls[1][2], '-b', 'no --no-checkout on a dense-by-class cut');
  assert.deepEqual([p.sparse, p.modeRule], [false, 'category Pipe']);
});

test('cutWorktree (mocked): a cone that cannot be applied leaves the worktree DENSE and says so -- never a failed cut', () => {
  const calls = [];
  const wtCalls = [];
  const r = cutWorktree('/main', '1234-Infra-x', {
    run: (args) => {
      calls.push(args);
      return '';
    },
    installDeps: false,
    resolvePlan: () => ({ rel: 'x', basename: '1234-Infra-x.md', text: SPARSE_BODY }),
    applySparse: () => false, // the helper already forced the checkout dense
    runInWorktree: (args) => wtCalls.push(args),
  });
  assert.ok(calls[1].includes('--no-checkout'));
  assert.deepEqual(
    wtCalls,
    [['sparse-checkout', 'disable'], ['checkout']],
    '"left DENSE" is enforced by the cut itself (the helper\'s fallback is best-effort), then the populating checkout runs → full tree',
  );
  assert.equal(r.sparse, false);
  assert.match(r.modeRule, /cone could not be applied, checkout left DENSE/);
});

// commitPush with a nested path, from a clone that first syncs to origin (B lands "sibling" work).
function landNested(s, dir, rel, body) {
  execFileSync('git', ['-C', dir, 'pull', '-q', '--rebase', 'origin', 'master']);
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), `${body}\n`);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', rel]);
  execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'master']);
}

// A scratch origin with the shapes the sparse cut must handle: a tracked plan file per class,
// files under the excluded folder, and files in every ancestor of it.
function makeSparseOrigin() {
  const s = makeOriginAndClones();
  const put = (rel, body) => {
    mkdirSync(join(s.A, rel, '..'), { recursive: true });
    writeFileSync(join(s.A, rel), body);
  };
  // plan 4071 T2: cutWorktree/widenWorktree/narrowWorktree resolve their exclude list from
  // <mainDir>/coord.config.json (empty core default) rather than a coord-git.mjs module constant,
  // so this synthetic origin needs its own copy of the real vetapp list for the sparse cone to
  // apply here exactly as it did when the list was a literal.
  put(
    'coord.config.json',
    `${JSON.stringify({ planWorktreeExcludedPaths: PLAN_WORKTREE_EXCLUDED_PATHS }, null, 2)}\n`,
  );
  put('docs/superpowers/plans/in-progress/1234-Infra-x.md', SPARSE_BODY);
  put('docs/superpowers/plans/in-progress/1235-DQ-y.md', SPARSE_BODY);
  put(
    'docs/superpowers/plans/in-progress/1236-Coord-z.md',
    `${SPARSE_BODY}\nreads render-store rows.\n`,
  );
  put('backend/package.json', '{"name":"backend"}\n');
  put('backend/src/data/shards/SE/order.json', '[]\n');
  put('backend/data/README.md', '# data\n');
  put('backend/data/other-study/rows.json', '[]\n');
  for (let i = 0; i < 20; i++) put(`backend/data/price-pipeline/render-store/r${i}.json`, '{}\n');
  put('backend/data/price-pipeline/observations/o.jsonl', '{}\n');
  put('frontend/src/page.tsx', '// page\n');
  execFileSync('git', ['-C', s.A, 'add', '-A']);
  execFileSync('git', ['-C', s.A, 'commit', '-qm', 'shapes']);
  execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);
  execFileSync('git', ['-C', s.A, 'config', 'extensions.worktreeConfig', 'true']);
  return s;
}

test('cutWorktree (real git): an Infra plan is cut SPARSE -- excluded folder absent, ancestors and seed present, clean, .owner stamped; --widen brings the folder back', () => {
  const s = makeSparseOrigin();
  try {
    const r = cutWorktree(s.A, '1234-Infra-x', { push: false, installDeps: false });
    const wt = join(s.A, '.claude', 'worktrees', '1234-Infra-x');
    assert.equal(r.sparse, true, r.modeRule);
    assert.ok(
      !existsSync(join(wt, 'backend', 'data', 'price-pipeline', 'render-store')),
      'excluded store off disk',
    );
    for (const kept of [
      'base.txt',
      'backend/package.json',
      'backend/src/data/shards/SE/order.json',
      'backend/data/README.md',
      'backend/data/other-study/rows.json',
      // the excluded stores' parent keeps its contract files and small siblings on disk
      'backend/data/price-pipeline/observations/o.jsonl',
      'frontend/src/page.tsx',
      'docs/superpowers/plans/in-progress/1234-Infra-x.md',
      '.owner',
    ])
      assert.ok(existsSync(join(wt, kept)), `expected ${kept} on disk`);
    const g = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8' });
    assert.equal(g('status', '--porcelain').trim(), '', 'sparse worktree is clean');
    assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'worktree-1234-Infra-x');
    assert.match(g('config', '--worktree', '--get', 'core.sparseCheckoutCone'), /true/);
    // Index and commit still carry the excluded files (skip-worktree), only the disk differs.
    assert.match(g('ls-files', '-v', '--', 'backend/data/price-pipeline/render-store'), /^S /m);
    assert.equal(
      g('ls-tree', '-r', '--name-only', 'HEAD', '--', 'backend/data/price-pipeline')
        .trim()
        .split('\n').length,
      21,
    );
    // A commit on the sparse branch is an ordinary commit.
    writeFileSync(join(wt, 'docs', 'note.md'), 'note\n');
    g('add', 'docs/note.md');
    g('commit', '-qm', 'note');
    assert.equal(g('status', '--porcelain').trim(), '');
    // Widen: one call, folder back, marker gone, still clean.
    const w = widenWorktree(s.A, '1234-Infra-x');
    assert.deepEqual(w, {
      branch: 'worktree-1234-Infra-x',
      worktreePath: '.claude/worktrees/1234-Infra-x',
      widened: true,
    });
    assert.ok(existsSync(join(wt, 'backend/data/price-pipeline/render-store/r0.json')));
    assert.ok(existsSync(join(wt, 'backend/data/price-pipeline/observations/o.jsonl')));
    assert.equal(g('status', '--porcelain').trim(), '');
    assert.equal(widenWorktree(s.A, '1234-Infra-x').widened, false, 'idempotent');
    assert.throws(() => widenWorktree(s.A, '4321-Infra-never-cut'), /found no worktree/);
  } finally {
    s.cleanup();
  }
});

test('widenWorktree (real git): a MALFORMED coord.config.json in the worktree still widens -- the config read is message-only, not a precondition (plan 4071 review round 1, finding 18eb34)', () => {
  const s = makeSparseOrigin();
  try {
    cutWorktree(s.A, '1234-Infra-x', { push: false, installDeps: false });
    const wt = join(s.A, '.claude', 'worktrees', '1234-Infra-x');
    assert.ok(
      !existsSync(join(wt, 'backend', 'data', 'price-pipeline', 'render-store')),
      'still sparse before the widen',
    );
    // Corrupt the worktree's OWN coord.config.json (widenWorktree resolves it from `absWt`,
    // not mainDir) -- loadCoordConfig's JSON.parse throws on this.
    writeFileSync(join(wt, 'coord.config.json'), '{ not valid json');
    const w = widenWorktree(s.A, '1234-Infra-x');
    // The widen itself must have happened despite the unreadable config.
    assert.equal(w.widened, true);
    assert.ok(
      existsSync(join(wt, 'backend/data/price-pipeline/render-store/r0.json')),
      'the excluded store landed on disk even though the config could not be read for the message',
    );
  } finally {
    s.cleanup();
  }
});

// ── plan 4020: narrowWorktree -- the missing half of widenWorktree ────────────────────────────

test('narrowWorktree (real git): a worktree cut DENSE gets narrowed on demand -- stores leave disk, freedBytes > 0, a second call is a no-op', () => {
  const s = makeSparseOrigin();
  try {
    // '1235-DQ-y' is cut DENSE by class (category DQ) -- no cone at all, not a widened sparse one.
    cutWorktree(s.A, '1235-DQ-y', { push: false, installDeps: false });
    const wt = join(s.A, '.claude', 'worktrees', '1235-DQ-y');
    assert.ok(
      existsSync(join(wt, 'backend/data/price-pipeline/render-store/r0.json')),
      'dense: store on disk before narrowing',
    );
    const n = narrowWorktree(s.A, '1235-DQ-y');
    assert.equal(n.branch, 'worktree-1235-DQ-y');
    assert.equal(n.worktreePath, '.claude/worktrees/1235-DQ-y');
    assert.equal(n.narrowed, true);
    assert.ok(n.freedBytes > 0, 'freed nonzero bytes');
    assert.deepEqual(n.untracked, []);
    assert.ok(
      !existsSync(join(wt, 'backend/data/price-pipeline/render-store')),
      'excluded store off disk',
    );
    const g = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8' });
    assert.equal(g('status', '--porcelain').trim(), '');
    assert.equal(narrowWorktree(s.A, '1235-DQ-y').narrowed, false, 'idempotent');
  } finally {
    s.cleanup();
  }
});

test('narrowWorktree (real git): the slug-less {dir} entry point works with no main checkout, mirroring --narrow --dir', () => {
  const s = makeSparseOrigin();
  try {
    cutWorktree(s.A, '1235-DQ-y', { push: false, installDeps: false });
    const wt = join(s.A, '.claude', 'worktrees', '1235-DQ-y');
    const n = narrowWorktree(null, null, { dir: wt });
    assert.equal(n.branch, null);
    assert.equal(n.worktreePath, wt);
    assert.equal(n.narrowed, true);
    assert.ok(!existsSync(join(wt, 'backend/data/price-pipeline/render-store')));
  } finally {
    s.cleanup();
  }
});

test('narrowWorktree (real git): throws /found no worktree/ for a slug that was never cut', () => {
  const s = makeSparseOrigin();
  try {
    assert.throws(() => narrowWorktree(s.A, '9999-Infra-never-cut'), /found no worktree/);
  } finally {
    s.cleanup();
  }
});

test('narrowWorktree (real git): round-trips with widenWorktree -- narrow then widen restores the folder, clean throughout', () => {
  const s = makeSparseOrigin();
  try {
    // '1234-Infra-x' is cut SPARSE by class; widen it first so this test starts from dense.
    cutWorktree(s.A, '1234-Infra-x', { push: false, installDeps: false });
    const wt = join(s.A, '.claude', 'worktrees', '1234-Infra-x');
    const g = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8' });
    assert.equal(widenWorktree(s.A, '1234-Infra-x').widened, true);
    assert.ok(existsSync(join(wt, 'backend/data/price-pipeline/render-store/r0.json')));
    assert.equal(g('status', '--porcelain').trim(), '');
    assert.equal(narrowWorktree(s.A, '1234-Infra-x').narrowed, true);
    assert.ok(!existsSync(join(wt, 'backend/data/price-pipeline/render-store')));
    assert.equal(g('status', '--porcelain').trim(), '');
    const w = widenWorktree(s.A, '1234-Infra-x');
    assert.equal(w.widened, true);
    assert.ok(existsSync(join(wt, 'backend/data/price-pipeline/render-store/r0.json')));
    assert.equal(g('status', '--porcelain').trim(), '');
  } finally {
    s.cleanup();
  }
});

// The mutual-exclusion guard lives in main()'s flag parsing, which is not exported (it runs only
// under the import.meta.url === argv[1] entry guard), so this one asserts through the CLI -- the
// same `spawnSync` shape batches-view.test.mjs and the other CLI-surface tests in this battery
// use. The guard is checked BEFORE either door runs, so a `--widen --narrow` can never leave a
// worktree half-applied; asserting the exit code is what pins that it refuses rather than picking
// one silently.
test('CLI: --widen and --narrow together is a flag error (exit 2), never a silent pick of one', () => {
  // Resolved from THIS file's own location, never from process.cwd(): which directory the test
  // runner happens to sit in is a property of the machine, not of the code under test.
  const script = join(dirname(fileURLToPath(import.meta.url)), 'cut-worktree.mjs');
  const res = spawnSync('node', [script, '--widen', '--narrow', '--dir', '.'], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--widen and --narrow are opposites/);
  // The usage line advertises both doors and both of their slug-less forms.
  assert.match(res.stderr, /--narrow --dir <worktree-path>/);
});

test('cutWorktree (real git): a DQ plan, a body naming render-store, --dense and a batch slug are all cut DENSE and byte-identical to a plain worktree add', () => {
  const s = makeSparseOrigin();
  try {
    const cases = [
      ['1235-DQ-y', {}, 'category DQ'],
      ['1236-Coord-z', {}, 'body mentions "render-store"'],
      ['1234-Infra-x', { dense: true }, '--dense'],
      ['batch-2026-09-12-abc', {}, /not resolved/],
    ];
    for (const [slug, opts, rule] of cases) {
      const r = cutWorktree(s.A, slug, { push: false, installDeps: false, ...opts });
      const wt = join(s.A, '.claude', 'worktrees', slug);
      assert.equal(r.sparse, false, slug);
      if (rule instanceof RegExp) assert.match(r.modeRule, rule);
      else assert.equal(r.modeRule, rule);
      assert.ok(
        existsSync(join(wt, 'backend/data/price-pipeline/render-store/r0.json')),
        `${slug}: dense tree on disk`,
      );
      const g = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8' });
      assert.equal(g('status', '--porcelain').trim(), '');
      // No cone config at all -- not "a cone that happens to include everything".
      assert.throws(
        () => g('config', '--worktree', '--get', 'core.sparseCheckout'),
        /./,
        `${slug}: no sparse config`,
      );
      assert.equal(widenWorktree(s.A, slug).widened, false);
    }
  } finally {
    s.cleanup();
  }
});

test('cutWorktree (real git): a sparse worktree survives a rebase onto a master that changed the EXCLUDED folder, including a conflict there', () => {
  const s = makeSparseOrigin();
  try {
    cutWorktree(s.A, '1234-Infra-x', { push: false, installDeps: false });
    const wt = join(s.A, '.claude', 'worktrees', '1234-Infra-x');
    const g = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8' });
    // Our branch commits a docs file; a sibling lands a NEW folder plus a change under the
    // excluded path on origin/master.
    writeFileSync(join(wt, 'docs', 'ours.md'), 'ours\n');
    g('add', 'docs/ours.md');
    g('commit', '-qm', 'ours');
    s.B && landNested(s, s.B, 'backend/data/price-pipeline/render-store/r0.json', '{"sibling":1}');
    s.B && landNested(s, s.B, 'backend/data/new-study/x.json', '[]');
    g('fetch', '-q', 'origin');
    g('rebase', '-q', 'origin/master');
    assert.equal(g('status', '--porcelain').trim(), '', 'clean after a non-conflicting rebase');
    assert.ok(
      !existsSync(join(wt, 'backend', 'data', 'price-pipeline', 'render-store')),
      'excluded store still off disk',
    );
    assert.ok(
      !existsSync(join(wt, 'backend', 'data', 'new-study')),
      'a new dir under an ancestor stays skip-worktree',
    );
    assert.match(
      g('ls-files', '-v', '--', 'backend/data/new-study'),
      /^S /m,
      '...but is in the index',
    );
    // Now a CONFLICT inside the EXCLUDED store: our branch edits a store file (hand-widened for
    // the edit, then re-narrowed by re-applying the cone -- the marker still matches, but the
    // helper checks git's own pattern list, so the hand widening is seen and undone), the sibling
    // edits the same file. git materialises the conflicted path outside the cone; the resolution
    // is ordinary; the rest of the store never comes in.
    g('sparse-checkout', 'add', 'backend/data/price-pipeline/render-store');
    writeFileSync(join(wt, 'backend/data/price-pipeline/render-store/r1.json'), '{"ours":1}\n');
    g('add', 'backend/data/price-pipeline/render-store/r1.json');
    g('commit', '-qm', 'ours-r1');
    const admin = g('rev-parse', '--absolute-git-dir').trim();
    assert.ok(existsSync(join(admin, PLAN_SPARSE_MARKER)), 'marker untouched by the hand widen');
    assert.equal(
      ensurePlanSparseCheckout(wt, { excludes: PLAN_WORKTREE_EXCLUDED_PATHS }),
      true,
      're-narrowed after the hand widen',
    );
    assert.ok(
      !existsSync(join(wt, 'backend/data/price-pipeline/render-store')),
      'store off disk again',
    );
    s.B && landNested(s, s.B, 'backend/data/price-pipeline/render-store/r1.json', '{"theirs":1}');
    g('fetch', '-q', 'origin');
    assert.throws(() => g('rebase', 'origin/master'), /CONFLICT|conflict/i);
    // The conflicted file is on disk and resolvable; the rest of the cone holds. The ONE
    // difference from a dense resolution: staging a path outside the cone needs `add --sparse`
    // (a plain `add` refuses it) -- the runbook's resolution recipe carries that flag.
    assert.ok(existsSync(join(wt, 'backend/data/price-pipeline/render-store/r1.json')));
    writeFileSync(join(wt, 'backend/data/price-pipeline/render-store/r1.json'), '{"merged":1}\n');
    assert.throws(
      () => g('add', 'backend/data/price-pipeline/render-store/r1.json'),
      /sparse/i,
      'a plain add refuses an out-of-cone path',
    );
    g('add', '--sparse', 'backend/data/price-pipeline/render-store/r1.json');
    execFileSync('git', ['-C', wt, '-c', 'core.editor=true', 'rebase', '--continue'], {
      encoding: 'utf8',
    });
    g('sparse-checkout', 'reapply');
    assert.equal(g('status', '--porcelain').trim(), '');
    assert.ok(
      !existsSync(join(wt, 'backend/data/price-pipeline/render-store/r0.json')),
      'the rest of the store never came in',
    );
    assert.ok(
      !existsSync(join(wt, 'backend/data/price-pipeline/render-store/r1.json')),
      'reapply drops the resolved file off disk again',
    );
  } finally {
    s.cleanup();
  }
});
