// scripts/check-coordination-branch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyDetachedMain,
  shouldBlock,
  classifyBlock,
  isMainCheckout,
  COORDINATION_RX,
  coordinationRx,
  WIKI_RX,
} from './check-coordination-branch.mjs';
import { derivePaths } from './coord-config.mjs';
import { classifyAllowlist } from './main-checkout-allowlist.mjs';
import { withEnvVar } from '../test-helpers/with-env-var.mjs';

// ── plan 1279: non-worktree branches block HAND coord/wiki commits ────────────────────
// The sanctioned writers all commit with HUSKY=0 (the hook never runs for them), so a
// commit reaching this guard on master IS a hand commit — the plan-1256 sweep class.

test('master staging a coordination file IS blocked (plan 1279 — hand commit)', () => {
  assert.equal(shouldBlock('master', ['handoff.md'], {}), true);
  assert.equal(shouldBlock('master', ['docs/INDEX.md'], {}), true);
  const res = classifyBlock('master', ['docs/INDEX.md', 'backend/src/x.ts'], {});
  assert.equal(res.mode, 'main');
  assert.deepEqual(res.hits, ['docs/INDEX.md']);
});

test('master staging a wiki page or WIKI.md IS blocked (route via wiki-commit.mjs)', () => {
  assert.equal(shouldBlock('master', ['wiki/entities/chains/chaina.md'], {}), true);
  assert.equal(shouldBlock('master', ['WIKI.md'], {}), true);
  assert.equal(WIKI_RX.test('wiki/log.md'), true);
  assert.equal(WIKI_RX.test('backend/src/wiki/x.ts'), false, 'anchored at repo root');
  assert.equal(WIKI_RX.test('WIKI.md.bak'), false, 'WIKI.md is an exact-name match');
});

test('master staging only code/docs outside the guarded set is allowed', () => {
  assert.equal(
    shouldBlock('master', ['backend/src/x.ts', 'README.md', 'docs/runbooks/foo.md'], {}),
    false,
  );
});

test('a sweep-up is surfaced: a peer’s staged coord/wiki file blocks a master commit', () => {
  // The committing session staged only code, but a peer’s session-entry + wiki page sit
  // in the shared index — a pathspec-less commit would sweep them (plan-1256 incident).
  const staged = [
    'backend/src/x.ts',
    'docs/handoff/sessions/2026-07-01-session-9.md',
    'wiki/hot.md',
  ];
  const res = classifyBlock('master', staged, {}, coordinationRx(derivePaths('docs/handoff')));
  assert.equal(res.mode, 'main');
  assert.deepEqual(res.hits, ['docs/handoff/sessions/2026-07-01-session-9.md', 'wiki/hot.md']);
});

test('detached HEAD is treated as non-worktree (coord guarded; wiki follows mainCheckout)', () => {
  assert.equal(shouldBlock('HEAD', ['handoff.md'], {}), true);
  assert.equal(shouldBlock('HEAD', ['wiki/index.md'], {}), true, 'default mainCheckout=true');
  assert.equal(
    shouldBlock('HEAD', ['wiki/index.md'], {}, COORDINATION_RX, { mainCheckout: false }),
    false,
    'a detached LINKED worktree (coord-worktree / finish worktree) has its own index',
  );
});

// plan 1279 review finding: a linked worktree on a non-`worktree-*` branch (the live
// `staging-maptune` worktree) has its OWN index — no sweep risk, and wiki-commit.mjs
// (which operates on $MAIN) is not usable from there. Wiki must stay committable; the
// coord-path block keeps its pre-1279 behavior (blocked on any non-master branch).
test('linked worktree on a non-worktree-named branch: wiki allowed, coord still blocked', () => {
  const opts = { mainCheckout: false };
  assert.equal(
    shouldBlock('staging-maptune', ['wiki/entities/chains/chaina.md'], {}, COORDINATION_RX, opts),
    false,
  );
  assert.equal(shouldBlock('staging-maptune', ['docs/INDEX.md'], {}, COORDINATION_RX, opts), true);
});

// ── plan 205 block (worktree branches) — unchanged semantics ──────────────────────────

test('worktree branch staging a coordination file IS blocked', () => {
  assert.equal(shouldBlock('worktree-205-x', ['handoff-board.md'], {}), true);
  assert.equal(shouldBlock('worktree-205-x', ['docs/INDEX.md'], {}), true);
  assert.equal(shouldBlock('worktree-205-x', ['docs/superpowers/plans/ready/9.md'], {}), true);
  assert.equal(
    shouldBlock('worktree-205-x', ['handoff/sessions/2026-05-28-session-1.md'], {}),
    true,
  );
  assert.equal(classifyBlock('worktree-205-x', ['docs/INDEX.md'], {}).mode, 'worktree');
});

test('worktree branch staging only code is allowed', () => {
  assert.equal(shouldBlock('worktree-205-x', ['backend/src/x.ts', 'README.md'], {}), false);
});

test('worktree branch staging a wiki page is ALLOWED (own index — accepted 1279 residual)', () => {
  assert.equal(shouldBlock('worktree-205-x', ['wiki/entities/chains/chaina.md'], {}), false);
});

test('override env bypasses the block in both modes', () => {
  assert.equal(shouldBlock('worktree-205-x', ['handoff.md'], { BOARD_GUARD_OVERRIDE: '1' }), false);
  assert.equal(shouldBlock('master', ['docs/INDEX.md'], { BOARD_GUARD_OVERRIDE: '1' }), false);
  assert.equal(shouldBlock('master', ['wiki/log.md'], { BOARD_GUARD_OVERRIDE: '1' }), false);
});

test('COORDINATION_RX is exported and matches the coordination paths', () => {
  assert.equal(COORDINATION_RX.test('handoff.md'), true);
  assert.equal(COORDINATION_RX.test('backend/src/x.ts'), false);
});

// Cross-tie (plan 1279 review finding): WIKI_RX and main-checkout-allowlist's DOC_RX
// encode the wiki surface in two layers (commit guard vs edit allowlist). They are
// deliberately separate constants — but every WIKI_RX-guarded path must classify as
// 'doc' there, so a wiki-root rename that updates one set loudly breaks this test
// instead of silently splitting the two layers.
test('WIKI_RX agrees with main-checkout-allowlist DOC_RX (both classify wiki as doc)', () => {
  for (const p of ['wiki/log.md', 'wiki/entities/chains/chaina.md', 'WIKI.md']) {
    assert.equal(WIKI_RX.test(p), true, `${p} guarded`);
    assert.equal(classifyAllowlist(p), 'doc', `${p} is allowlist 'doc'`);
  }
});

// plan 857: the config-derived rx for the docs/handoff/ layout must match the
// relocated coordination paths and must NOT leak the legacy root names. This is the
// rx that main() + pre-yield-guard's guard() actually build from loadCoordConfig.
test('coordinationRx(docs/handoff) matches the relocated coordination paths', () => {
  const rx = coordinationRx(derivePaths('docs/handoff'));
  assert.equal(rx.test('docs/handoff/board.md'), true);
  assert.equal(rx.test('docs/handoff/current.md'), true);
  assert.equal(rx.test('docs/handoff/sessions/2026-06-20-session-1.md'), true);
  assert.equal(rx.test('docs/INDEX.md'), true);
  assert.equal(rx.test('docs/superpowers/plans/ready/9.md'), true);
  // legacy root names are NOT the configured layout — must not match
  assert.equal(rx.test('handoff-board.md'), false);
  assert.equal(rx.test('handoff.md'), false);
  assert.equal(rx.test('backend/src/x.ts'), false);
});

test('shouldBlock uses the passed rx (docs/handoff layout) on a worktree branch', () => {
  const rx = coordinationRx(derivePaths('docs/handoff'));
  assert.equal(shouldBlock('worktree-857-x', ['docs/handoff/board.md'], {}, rx), true);
  assert.equal(shouldBlock('worktree-857-x', ['docs/handoff/sessions/x.md'], {}, rx), true);
  assert.equal(shouldBlock('worktree-857-x', ['backend/src/x.ts'], {}, rx), false);
});

test('backslash-normalised staged paths still match (Windows porcelain)', () => {
  assert.equal(shouldBlock('master', ['wiki\\entities\\platforms\\acme-cloud.md'], {}), true);
  assert.equal(shouldBlock('master', ['docs\\INDEX.md'], {}), true);
});

// isMainCheckout: the git-dir == git-common-dir discriminator against a real repo +
// linked worktree (the property the wiki guard's scoping rests on).
test('isMainCheckout: true in the main checkout, false in a linked worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccb-main-'));
  const g = (dir, ...a) =>
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', ...a], {
      encoding: 'utf8',
    }).trim();
  try {
    const mainDir = join(root, 'main');
    execFileSync('git', ['init', '-q', '-b', 'master', mainDir], { stdio: 'ignore' });
    writeFileSync(join(mainDir, 'f.txt'), 'a\n');
    g(mainDir, 'add', 'f.txt');
    g(mainDir, 'commit', '-qm', 'init');
    const wtDir = join(root, 'wt');
    g(mainDir, 'worktree', 'add', '-q', wtDir, '-b', 'staging-oddname');
    assert.equal(isMainCheckout(mainDir), true);
    assert.equal(isMainCheckout(wtDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// plan 4087 T5: this hook runs as a git-commit subprocess, and git EXPORTS GIT_DIR /
// GIT_COMMON_DIR into every hook child for the commit it is running — before the fix, both
// execFileSync calls inside isMainCheckout inherited process.env with no scrub, so that ambient
// pair silently overrode `cwd` and the function answered about the FOREIGN repo instead of the
// one it was asked about. Pins the fix: a poisoned GIT_DIR/GIT_COMMON_DIR pointing at a wholly
// unrelated repo must not change either verdict.
test('isMainCheckout: a poisoned ambient GIT_DIR/GIT_COMMON_DIR cannot steer the verdict (plan 4087 T5)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccb-main-poison-'));
  const g = (dir, ...a) =>
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', ...a], {
      encoding: 'utf8',
    }).trim();
  try {
    const mainDir = join(root, 'main');
    execFileSync('git', ['init', '-q', '-b', 'master', mainDir], { stdio: 'ignore' });
    writeFileSync(join(mainDir, 'f.txt'), 'a\n');
    g(mainDir, 'add', 'f.txt');
    g(mainDir, 'commit', '-qm', 'init');
    const wtDir = join(root, 'wt');
    g(mainDir, 'worktree', 'add', '-q', wtDir, '-b', 'staging-oddname');

    const foreign = join(root, 'foreign');
    execFileSync('git', ['init', '-q', '-b', 'master', foreign], { stdio: 'ignore' });

    withEnvVar({ GIT_DIR: join(foreign, '.git'), GIT_COMMON_DIR: join(foreign, '.git') }, () => {
      assert.equal(
        isMainCheckout(mainDir),
        true,
        'the ambient GIT_DIR/GIT_COMMON_DIR must not make the MAIN checkout misreport as non-main',
      );
      assert.equal(
        isMainCheckout(wtDir),
        false,
        'the ambient GIT_DIR/GIT_COMMON_DIR must not make a LINKED WORKTREE misreport as main',
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── pass 1307: merge-conclusion exemption ─────────────────────────────────────
// Concluding a conflicted freshen-merge (plan 507) hand-commits the merge; coord
// paths inherited VERBATIM from a merge parent are not hand edits and must not
// block, while a coord path rewritten during the merge (differs from both
// parents) still must.
test('filterMergeInheritedPaths: parent-identical coord paths drop, hand-edits stay', async () => {
  const { filterMergeInheritedPaths } = await import('./check-coordination-branch.mjs');
  const root = mkdtempSync(join(tmpdir(), 'ccb-merge-'));
  const g = (dir, ...a) =>
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', ...a], {
      encoding: 'utf8',
    }).trim();
  try {
    const repo = join(root, 'r');
    execFileSync('git', ['init', '-q', '-b', 'master', repo], { stdio: 'ignore' });
    writeFileSync(join(repo, 'code.txt'), 'base\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-qm', 'base');
    g(repo, 'switch', '-qc', 'worktree-x');
    writeFileSync(join(repo, 'code.txt'), 'branch side\n');
    g(repo, 'commit', '-qam', 'branch work');
    g(repo, 'switch', '-q', 'master');
    execFileSync('node', [
      '-e',
      `require('fs').mkdirSync(process.argv[1],{recursive:true})`,
      join(repo, 'docs/superpowers/plans'),
    ]);
    writeFileSync(join(repo, 'docs/superpowers/plans/900-x.md'), 'master plan\n');
    writeFileSync(join(repo, 'code.txt'), 'master side\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-qm', 'master work');
    g(repo, 'switch', '-q', 'worktree-x');
    // conflicted merge: code.txt conflicts; the plan file is master-inherited
    try {
      g(repo, 'merge', 'master');
    } catch {
      /* expected conflict */
    }
    writeFileSync(join(repo, 'code.txt'), 'resolved\n');
    g(repo, 'add', 'code.txt');
    // inherited coord path (staged blob == MERGE_HEAD's) → filtered out
    let filtered = filterMergeInheritedPaths(['docs/superpowers/plans/900-x.md', 'code.txt'], repo);
    assert.deepEqual(filtered, ['code.txt']);
    // a coord path REWRITTEN during the merge (differs from both parents) → kept
    writeFileSync(join(repo, 'docs/superpowers/plans/900-x.md'), 'hand edit in merge\n');
    g(repo, 'add', 'docs/superpowers/plans/900-x.md');
    filtered = filterMergeInheritedPaths(['docs/superpowers/plans/900-x.md'], repo);
    assert.deepEqual(filtered, ['docs/superpowers/plans/900-x.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('filterMergeInheritedPaths: no merge in progress is a no-op', async () => {
  const { filterMergeInheritedPaths } = await import('./check-coordination-branch.mjs');
  const paths = ['docs/INDEX.md', 'x.ts'];
  // cwd (this repo mid-anything) — when MERGE_HEAD is absent the list passes through
  // untouched; if this WORKING repo happens to be mid-merge the helper still only
  // removes parent-identical paths, so a fabricated docs/INDEX.md stays either way.
  const out = filterMergeInheritedPaths(paths, tmpdir());
  assert.deepEqual(out, paths);
});

// plan 4135 (group c): filterMergeInheritedPaths' shared `rev` helper (its own MERGE_HEAD
// verify, the blobAt/stagedBlob `rev-parse <ref>:<path>` reads, and the merge-tree call) took
// `cwd: gitDirCwd` with NO `env` at all before this plan -- exactly the class T5 fixed at
// isMainCheckout, in the same file. Reproduces the bug end to end: `repo` genuinely has a
// conflicted merge in progress (MERGE_HEAD present, a coord path inherited verbatim from the
// merge parent), `foreign` does not. Before the fix, an ambient GIT_DIR pointed at `foreign`
// overrides the explicit `cwd: repo.dir` these calls pass, `rev-parse --verify MERGE_HEAD`
// answers about `foreign` (no merge there), throws, and the function falls back to "no merge in
// progress" -- silently returning the coord path UNFILTERED, i.e. still guarded, from a repo
// that in fact has an exemptable merge-inherited path. That happens to fail SAFE here (more
// guarding, not a bypass) but is still the wrong repository answering the question, and the same
// unguarded shape is what let a poisoned ambient GIT_DIR redirect isMainCheckout before 4087 T5.
test('filterMergeInheritedPaths: an ambient GIT_DIR cannot redirect the rev/merge-tree reads off the explicit cwd (plan 4135, group c)', async () => {
  const { filterMergeInheritedPaths } = await import('./check-coordination-branch.mjs');
  const root = mkdtempSync(join(tmpdir(), 'ccb-merge-poison-'));
  const g = (dir, ...a) =>
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', ...a], {
      encoding: 'utf8',
    }).trim();
  try {
    const repo = join(root, 'r');
    execFileSync('git', ['init', '-q', '-b', 'master', repo], { stdio: 'ignore' });
    writeFileSync(join(repo, 'code.txt'), 'base\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-qm', 'base');
    g(repo, 'switch', '-qc', 'worktree-x');
    writeFileSync(join(repo, 'code.txt'), 'branch side\n');
    g(repo, 'commit', '-qam', 'branch work');
    g(repo, 'switch', '-q', 'master');
    execFileSync('node', [
      '-e',
      `require('fs').mkdirSync(process.argv[1],{recursive:true})`,
      join(repo, 'docs/superpowers/plans'),
    ]);
    writeFileSync(join(repo, 'docs/superpowers/plans/900-x.md'), 'master plan\n');
    writeFileSync(join(repo, 'code.txt'), 'master side\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-qm', 'master work');
    g(repo, 'switch', '-q', 'worktree-x');
    try {
      g(repo, 'merge', 'master'); // conflicted: code.txt conflicts, the plan file is inherited
    } catch {
      /* expected conflict */
    }
    writeFileSync(join(repo, 'code.txt'), 'resolved\n');
    g(repo, 'add', 'code.txt');

    const foreign = join(root, 'foreign');
    execFileSync('git', ['init', '-q', '-b', 'master', foreign], { stdio: 'ignore' });
    writeFileSync(join(foreign, 'f.txt'), 'a\n');
    g(foreign, 'add', 'f.txt');
    g(foreign, 'commit', '-qm', 'init'); // no merge in progress here

    withEnvVar({ GIT_DIR: join(foreign, '.git') }, () => {
      const filtered = filterMergeInheritedPaths(
        ['docs/superpowers/plans/900-x.md', 'code.txt'],
        repo,
      );
      assert.deepEqual(
        filtered,
        ['code.txt'],
        'an ambient GIT_DIR must not redirect the MERGE_HEAD/blob reads off the explicit cwd -- ' +
          "repo's own merge-inherited coord path must still be recognized and dropped",
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── plan 4135 (group c): the pre-commit hook itself, exercised for real ────────────────────────
// Not a unit test of a function — a REAL `git commit`, through a REAL pre-commit hook, spawning
// THIS module exactly as `.husky/pre-commit`'s first line does. The Acceptance criterion this
// satisfies: "the pre-commit hook path is exercised for real once ... that file runs on every
// commit in the repo".
//
// A PATHSPEC commit (`git commit -m … -- <path>`) is git's own convenience for committing a
// SUBSET of what is staged: for its duration git points GIT_INDEX_FILE at a scratch temporary
// index holding the pathspec's own content, distinct from the checkout's DEFAULT index. Before
// plan 4135 the two staged-set reads inside main() (`diff --cached`, and — via
// filterMergeInheritedPaths — `rev-parse :0:<path>`) carried no `env` at all, so an ambient
// GIT_DIR/GIT_INDEX_FILE from an enclosing invocation could already steer them (the ambient-GIT_DIR
// tests above), AND — the DISTINCT bug hookIndexSetting() fixes — even with no ambient poisoning
// at all, `diff --cached` with GIT_INDEX_FILE stripped falls back to the checkout's OWN default
// index, which does not carry the pathspec commit's staged content. So a pathspec commit of a
// guarded coord path, made while the default index holds only an unguarded file, read as carrying
// nothing guarded and slipped the guard — exactly the scenario reproduced below.
function makeHookRepo(branchName) {
  const dir = mkdtempSync(join(tmpdir(), 'ccb-idx-'));
  const g = (...a) =>
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', ...a], {
      encoding: 'utf8',
    }).trim();
  execFileSync('git', ['init', '-q', '-b', branchName, dir], { stdio: 'ignore' });
  writeFileSync(join(dir, 'unguarded.txt'), 'a\n');
  g('add', 'unguarded.txt');
  g('commit', '-qm', 'init');
  // The hook runs THIS worktree's own check-coordination-branch.mjs — the exact invocation
  // `.husky/pre-commit`'s first line makes (`node scripts/check-coordination-branch.mjs`),
  // just addressed absolutely since the hook's cwd is the TEMP repo, not this checkout.
  const scriptAbsPath = join(import.meta.dirname, 'check-coordination-branch.mjs');
  const hookPath = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(
    hookPath,
    ['#!/usr/bin/env sh', `"${process.execPath}" "${scriptAbsPath}"`, ''].join('\n'),
  );
  chmodSync(hookPath, 0o755);
  return { dir, g };
}

test('pre-commit hook: a PATHSPEC commit of a guarded coord path is BLOCKED even while the default index holds only an unguarded file (plan 4135, group c)', () => {
  const { dir, g } = makeHookRepo('worktree-4135-idx-test');
  try {
    // Stage a change into the DEFAULT index — a mis-read (GIT_INDEX_FILE stripped, no
    // re-admission) would see exactly this and nothing else.
    writeFileSync(join(dir, 'unguarded.txt'), 'b\n');
    g('add', 'unguarded.txt');

    // A NEW guarded coord path. `add -N` (intent-to-add) is the minimum needed for a pathspec
    // commit to pick up a brand-new file at all ("did not match any file(s) known to git"
    // otherwise) — it registers the PATH without staging its content, so the default index's
    // own `diff --cached` still shows only unguarded.txt (verified empirically: an
    // intent-to-add path is invisible to `diff --cached`, exactly the asymmetry this test
    // exploits), which is exactly "the default index holds only an unguarded file".
    mkdirSync(join(dir, 'docs/superpowers/plans/ready'), { recursive: true });
    const guardedRel = 'docs/superpowers/plans/ready/9999-Test-guard.md';
    writeFileSync(join(dir, guardedRel), 'x\n');
    g('add', '-N', guardedRel);

    const res = spawnSync(
      'git',
      [
        '-C',
        dir,
        '-c',
        'user.email=t@t.t',
        '-c',
        'user.name=t',
        'commit',
        '-m',
        'pathspec commit',
        '--',
        guardedRel,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(
      res.status,
      0,
      'a pathspec commit of a guarded coord path must be BLOCKED by the pre-commit hook, even ' +
        `though the default index holds only unguarded.txt (stdout: ${res.stdout}\nstderr: ${res.stderr})`,
    );
    assert.match(
      res.stderr + res.stdout,
      /coordination-branch guard/,
      'the block must actually be the coordination guard firing, not an unrelated failure',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── plan 2391: detached MAIN checkout silently swallows commits ────────────────
// The guard is scoped to the main checkout because the land spine's legitimate
// detached-HEAD `HEAD:master` push runs from an EPHEMERAL done-worktree — a LINKED
// worktree — per .husky/pre-push's seed-gate comment. So `mainCheckout && detached`
// has no legitimate steady state and a plain refuse cannot break the land path.

test('classifyDetachedMain: refuses a commit on the DETACHED main checkout', async () => {
  const { classifyDetachedMain } = await import('./check-coordination-branch.mjs');
  // `rev-parse --abbrev-ref HEAD` is the literal "HEAD" exactly when detached.
  const res = classifyDetachedMain('HEAD', {}, { mainCheckout: true });
  assert.equal(res?.mode, 'detached-main');
});

test('classifyDetachedMain: attached main checkout is allowed', async () => {
  const { classifyDetachedMain } = await import('./check-coordination-branch.mjs');
  assert.equal(classifyDetachedMain('master', {}, { mainCheckout: true }), null);
  assert.equal(classifyDetachedMain('worktree-2391-x', {}, { mainCheckout: true }), null);
});

test('classifyDetachedMain: detached LINKED worktree is allowed (the land push)', async () => {
  const { classifyDetachedMain } = await import('./check-coordination-branch.mjs');
  assert.equal(
    classifyDetachedMain('HEAD', {}, { mainCheckout: false }),
    null,
    'the done-worktree land push detaches on purpose and must not be blocked',
  );
});

test('classifyDetachedMain: override escapes', async () => {
  const { classifyDetachedMain } = await import('./check-coordination-branch.mjs');
  assert.equal(
    classifyDetachedMain('HEAD', { BOARD_GUARD_OVERRIDE: '1' }, { mainCheckout: true }),
    null,
  );
});

test('formatDetachedMainMessage: names the recovery path and tolerates a missing ref', async () => {
  const { formatDetachedMainMessage } = await import('./check-coordination-branch.mjs');
  const out = formatDetachedMainMessage('abc123', null).join('\n');
  assert.match(out, /cherry-pick/, 'must tell the operator how to recover a lost commit');
  assert.match(out, /git checkout master/, 'must tell the operator how to reattach');
  assert.match(out, /unreadable/, 'a missing master ref degrades, it does not throw');
});

// The REPRODUCE the plan asks for: prove the hazard is real against a temp repo
// (never the shared checkout) — a commit made on a detached HEAD leaves the tip
// after a pull --rebase, while refs/heads/master never advanced.
test('reproduce: a commit on a detached HEAD is lost by pull --rebase (temp repo)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccb-detach-'));
  const g = (dir, ...a) =>
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', ...a], {
      encoding: 'utf8',
    }).trim();
  try {
    // An "origin" the clone can pull from.
    const originDir = join(root, 'origin');
    execFileSync('git', ['init', '-q', '-b', 'master', originDir], { stdio: 'ignore' });
    writeFileSync(join(originDir, 'f.txt'), 'a\n');
    g(originDir, 'add', 'f.txt');
    g(originDir, 'commit', '-qm', 'init');

    const cloneDir = join(root, 'clone');
    execFileSync('git', ['clone', '-q', originDir, cloneDir], { stdio: 'ignore' });

    // Detach the clone at its current tip — the accidental state plan 2391 describes.
    const tip = g(cloneDir, 'rev-parse', 'HEAD');
    g(cloneDir, 'checkout', '-q', '--detach', tip);
    assert.equal(
      g(cloneDir, 'rev-parse', '--abbrev-ref', 'HEAD'),
      'HEAD',
      'precondition: detached',
    );

    // Commit real work on the detached HEAD.
    writeFileSync(join(cloneDir, 'precious.txt'), 'work that must not vanish\n');
    g(cloneDir, 'add', 'precious.txt');
    g(cloneDir, 'commit', '-qm', 'docs: precious');
    const lost = g(cloneDir, 'rev-parse', 'HEAD');

    // origin moves on, as a peer session's push would.
    writeFileSync(join(originDir, 'other.txt'), 'peer\n');
    g(originDir, 'add', 'other.txt');
    g(originDir, 'commit', '-qm', 'peer commit');

    g(cloneDir, 'fetch', '-q', 'origin');
    // The retry loop the incident ran. It succeeds, and that is the problem.
    g(cloneDir, 'rebase', '-q', 'origin/master');
    g(cloneDir, 'checkout', '-q', 'master');
    g(cloneDir, 'merge', '-q', '--ff-only', 'origin/master');

    // The commit is NOT in the branch's history, though the object still exists.
    const inMaster = g(cloneDir, 'log', '--format=%s', 'master').split('\n');
    assert.ok(
      !inMaster.includes('docs: precious'),
      'reproduce failed to reproduce: the work should be absent from master',
    );
    assert.equal(g(cloneDir, 'cat-file', '-t', lost), 'commit', 'object survives — recoverable');

    // And the guard would have refused that commit before it was ever made.
    assert.equal(classifyDetachedMain('HEAD', {}, { mainCheckout: true })?.mode, 'detached-main');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── plan 2391 review (finding koku0o): PreToolUse hook ↔ pre-commit guard parity ──────
// The hook's own header promises "the SAME classification ... zero drift". These assert the
// detached-MAIN refuse actually reached it, and that it stayed PATH-independent (the whole
// point: on a detached main checkout every commit is lossy, not only a coord one).

function makeDetachedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ccb-hook-'));
  const g = (...a) =>
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', ...a], {
      encoding: 'utf8',
    }).trim();
  execFileSync('git', ['init', '-q', '-b', 'master', dir], { stdio: 'ignore' });
  writeFileSync(join(dir, 'f.txt'), 'a\n');
  g('add', 'f.txt');
  g('commit', '-qm', 'init');
  return { dir, g };
}

test('PreToolUse hook: refuses a `git commit` on a DETACHED main checkout (no coord path needed)', async () => {
  const hook = await import('../hooks/coord-write-guard-pretooluse.mjs');
  const { dir, g } = makeDetachedRepo();
  try {
    g('checkout', '-q', '--detach', g('rev-parse', 'HEAD'));
    const hit = hook.evaluate(
      `git -C ${dir} commit -m "docs: anything at all"`,
      {},
      {
        repoRoot: dir,
      },
    );
    assert.ok(hit, 'the hook must intercept a commit on a detached main checkout');
    assert.equal(hit.res.mode, 'detached-main');
    const msg = hook.formatHitMessage(hit);
    assert.match(msg, /detached-HEAD guard \(plan 2391\)/);
    assert.match(msg, /SILENTLY LOST/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PreToolUse hook: an ATTACHED main checkout is untouched, and the override escapes', async () => {
  const hook = await import('../hooks/coord-write-guard-pretooluse.mjs');
  const { dir, g } = makeDetachedRepo();
  try {
    assert.equal(hook.evaluate(`git -C ${dir} commit -m "x"`, {}, { repoRoot: dir }), null);
    g('checkout', '-q', '--detach', g('rev-parse', 'HEAD'));
    assert.equal(
      hook.evaluate(`BOARD_GUARD_OVERRIDE=1 git -C ${dir} commit -m "x"`, {}, { repoRoot: dir })
        ?.res?.mode,
      undefined,
      'the documented override must still escape the detached refuse',
    );
    // A bare `git add` is not lossy — only the commit is — so it must NOT be blocked.
    assert.equal(hook.evaluate(`git -C ${dir} add f.txt`, {}, { repoRoot: dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
