// scripts/coord/reconcile-worktree-branches.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimRef, legacyClaimRef } from './coord-refs.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyHusks,
  planIdFromBranch,
  classifyMergedBranches,
  classifyDivergedArchived,
  classifyStaleClaimRefs,
  buildProtectedPlanIdChecker,
  buildPlanFolderIndex,
  listCheckedOutBranches,
  listWorktreeBranches,
  huskRemediation,
  branchRemediation,
  staleClaimRemediation,
  buildReport,
} from './reconcile-worktree-branches.mjs';

// plan 338 (see coord-git.test.mjs): git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE /
// GIT_OBJECT_DIRECTORY / GIT_COMMON_DIR / GIT_NAMESPACE into hook subprocesses — clear them so
// every git call in this throwaway test process honours `-C <tmpdir>` instead of redirecting
// onto the real repo.
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

// --- pure-function unit tests (no git) -------------------------------------------------------

test('classifyHusks: flags only entries with NEITHER a .git pointer NOR an admin entry', () => {
  const entries = [
    { name: 'husk-1', hasGitPointer: false, hasAdminEntry: false },
    { name: 'live-1', hasGitPointer: true, hasAdminEntry: true },
    { name: 'half-1', hasGitPointer: true, hasAdminEntry: false }, // has SOME signal — not a husk
    { name: 'half-2', hasGitPointer: false, hasAdminEntry: true }, // has SOME signal — not a husk
  ];
  assert.deepEqual(classifyHusks(entries), ['husk-1']);
});

test('planIdFromBranch: extracts the leading plan id from either execution-branch prefix', () => {
  assert.equal(planIdFromBranch('worktree-1473-Infra-reconcile-sweeper'), '1473');
  assert.equal(planIdFromBranch('worktree-365-UI-x'), '365');
  assert.equal(planIdFromBranch('claude/drain-3517-Infra-dead-seeds'), '3517');
  assert.equal(planIdFromBranch('feature-3517-Infra-dead-seeds'), null);
});

test('planIdFromBranch: a batch slug (no leading numeric id) yields null, not a throw', () => {
  assert.equal(planIdFromBranch('worktree-batch-2026-07-05-request-path'), null);
});

test('classifyMergedBranches: merged + unprotected → kill; unmerged → excluded', () => {
  const facts = [
    { name: 'worktree-100-x', local: true, remote: false, merged: true, planId: '100' },
    { name: 'worktree-200-x', local: true, remote: false, merged: false, planId: '200' },
  ];
  const isProtectedPlanId = () => false;
  assert.deepEqual(
    classifyMergedBranches(facts, { isProtectedPlanId }).map((b) => b.name),
    ['worktree-100-x'],
  );
});

test('classifyMergedBranches: never flags origin/staging even if it were merged', () => {
  const facts = [{ name: 'staging', local: true, remote: true, merged: true, planId: null }];
  assert.deepEqual(classifyMergedBranches(facts, { isProtectedPlanId: () => false }), []);
});

test('classifyMergedBranches: a merged branch whose plan is protected is excluded', () => {
  const facts = [
    { name: 'worktree-300-x', local: true, remote: false, merged: true, planId: '300' },
  ];
  assert.deepEqual(classifyMergedBranches(facts, { isProtectedPlanId: (id) => id === '300' }), []);
});

// review finding (plan 1473): a batch branch (`worktree-batch-<slug>`) has no single owning
// plan id — planId is null — so isProtectedPlanId can never protect it. Before this fix, a
// merged batch branch with no plan id slipped straight into the kill list with a real
// `git push origin --delete` remediation, even while it was this session's own live worktree.
test('classifyMergedBranches: a merged batch branch (no planId) with no isCheckedOut is NOT protected — the gap this fix closes', () => {
  const facts = [
    { name: 'worktree-batch-x', local: true, remote: true, merged: true, planId: null },
  ];
  assert.deepEqual(
    classifyMergedBranches(facts, { isProtectedPlanId: () => false }).map((b) => b.name),
    ['worktree-batch-x'],
  );
});

test('classifyMergedBranches: isCheckedOut protects a merged branch regardless of planId (batch or numeric)', () => {
  const facts = [
    { name: 'worktree-batch-x', local: true, remote: true, merged: true, planId: null },
    { name: 'worktree-400-x', local: true, remote: false, merged: true, planId: '400' },
  ];
  const isCheckedOut = (name) => name === 'worktree-batch-x';
  assert.deepEqual(
    classifyMergedBranches(facts, { isProtectedPlanId: () => false, isCheckedOut }).map(
      (b) => b.name,
    ),
    ['worktree-400-x'],
  );
});

test('listWorktreeBranches: enumerates both shapes and dedupes local+remote drain names', () => {
  const calls = [];
  const _git = (_dir, args) => {
    calls.push(args);
    if (args.includes('refs/heads/worktree-*')) {
      return ['refs/heads/worktree-100-x', 'refs/heads/claude/drain-200-y'].join('\n');
    }
    return ['refs/remotes/origin/worktree-300-z', 'refs/remotes/origin/claude/drain-200-y'].join(
      '\n',
    );
  };
  assert.deepEqual(listWorktreeBranches('/repo', { _git }), [
    { name: 'worktree-100-x', local: true, remote: false, shape: 'worktree' },
    { name: 'claude/drain-200-y', local: true, remote: true, shape: 'drain' },
    { name: 'worktree-300-z', local: false, remote: true, shape: 'worktree' },
  ]);
  assert.ok(calls[0].includes('refs/heads/claude/drain-*'));
  assert.ok(calls[1].includes('refs/remotes/origin/claude/drain-*'));
});

test('classifyMergedBranches: worktree results are unchanged with drain options absent or present', () => {
  const facts = [
    { name: 'worktree-100-x', shape: 'worktree', merged: true, planId: '100' },
    { name: 'worktree-200-x', shape: 'worktree', merged: false, planId: '200' },
  ];
  const base = { isProtectedPlanId: () => false };
  assert.deepEqual(classifyMergedBranches(facts, base), [facts[0]]);
  assert.deepEqual(
    classifyMergedBranches(facts, {
      ...base,
      isArchived: () => {
        throw new Error('worktree must not check archive');
      },
      deadSeed: () => {
        throw new Error('worktree must not check dead seed');
      },
    }),
    [facts[0]],
  );
});

test('classifyMergedBranches: drain branches require archive or a dead verdict and retain guards', () => {
  const drain = (name, planId) => ({ name, shape: 'drain', merged: true, planId });
  const facts = [
    drain('claude/drain-101-archived', '101'),
    drain('claude/drain-102-dead', '102'),
    drain('claude/drain-103-fresh', '103'),
    drain('claude/drain-104-age-unknown', '104'),
    drain('claude/drain-105-throws', '105'),
    drain('claude/drain-batch-unknown', null),
    drain('claude/drain-106-checked-out', '106'),
    drain('claude/drain-107-protected', '107'),
  ];
  const verdicts = new Map([
    ['claude/drain-102-dead', { dead: true, reason: 'dead' }],
    ['claude/drain-103-fresh', { dead: false, reason: 'fresh' }],
    ['claude/drain-104-age-unknown', { dead: false, reason: 'age-unknown' }],
    ['claude/drain-batch-unknown', { dead: false, reason: 'fresh' }],
    ['claude/drain-106-checked-out', { dead: true, reason: 'dead' }],
    ['claude/drain-107-protected', { dead: true, reason: 'dead' }],
  ]);
  const result = classifyMergedBranches(facts, {
    isProtectedPlanId: (id) => id === '107',
    isCheckedOut: (name) => name === 'claude/drain-106-checked-out',
    isArchived: (id) => id === '101',
    deadSeed: (b) => {
      if (b.name === 'claude/drain-105-throws') throw new Error('git failed');
      return verdicts.get(b.name) ?? { dead: false };
    },
  });
  assert.deepEqual(
    result.map((b) => [b.name, b.deletionReason]),
    [
      ['claude/drain-101-archived', 'archived-plan'],
      ['claude/drain-102-dead', 'dead-seed'],
    ],
  );
});

test('classifyDivergedArchived: only diverged branches whose plan is archived survive', () => {
  const facts = [
    { name: 'worktree-1-x', merged: false, planId: '1' }, // archived → surfaces
    { name: 'worktree-2-x', merged: false, planId: '2' }, // not archived → excluded
    { name: 'worktree-3-x', merged: true, planId: '1' }, // merged, same id → different category
    { name: 'worktree-batch-x', merged: false, planId: null }, // no plan id → excluded
  ];
  const isArchived = (id) => id === '1';
  assert.deepEqual(
    classifyDivergedArchived(facts, { isArchived }).map((b) => b.name),
    ['worktree-1-x'],
  );
});

test('classifyStaleClaimRefs: local-only AND archived → stale; either condition failing excludes it', () => {
  const local = ['10', '20', '30'];
  const remote = ['20']; // 20 is still held on origin → never "local-only"
  const isArchived = (id) => id === '10' || id === '20';
  // 10: local-only + archived -> stale. 20: on origin -> excluded. 30: local-only but NOT archived -> excluded.
  assert.deepEqual(classifyStaleClaimRefs(local, remote, { isArchived }), ['10']);
});

test('listCheckedOutBranches: parses only `branch refs/heads/…` lines, stripping the ref prefix', () => {
  const porcelain = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/master',
    '',
    'worktree /repo/.claude/worktrees/batch-x',
    'HEAD def456',
    'branch refs/heads/worktree-batch-x',
    '',
    'worktree /repo/.claude/worktrees/detached-x',
    'HEAD 789abc',
    'detached', // a detached-HEAD worktree has no `branch` line at all — must not throw
  ].join('\n');
  const _git = () => porcelain;
  const names = listCheckedOutBranches('/repo', { _git });
  assert.deepEqual([...names].sort(), ['master', 'worktree-batch-x']);
});

test('listCheckedOutBranches: an unreadable worktree list returns an empty set, not a throw', () => {
  const _git = () => {
    throw new Error('git not available');
  };
  assert.equal(listCheckedOutBranches('/repo', { _git }).size, 0);
});

test('buildPlanFolderIndex: one ls-tree listing resolves every id to its folder in a single pass', () => {
  const lsTree = [
    'docs/superpowers/plans/archive/9002-Test-diverged.md',
    'docs/superpowers/plans/in-progress/9005-Test-parked.md',
    'docs/superpowers/plans/ready/9006-Test-live.md',
    'docs/handoff/board.md', // non-plan path — must be ignored, not mismatched
    'docs/superpowers/plans/README.md', // no leading numeric id — must be ignored
  ].join('\n');
  const index = buildPlanFolderIndex(lsTree);
  assert.equal(index.get('9002'), 'archive');
  assert.equal(index.get('9005'), 'in-progress');
  assert.equal(index.get('9006'), 'ready');
  assert.equal(index.get('9999'), undefined); // never seen → absent, not a false folder
});

test('buildPlanFolderIndex: empty/garbage input yields an empty index, not a throw', () => {
  assert.equal(buildPlanFolderIndex('').size, 0);
  assert.equal(buildPlanFolderIndex(null).size, 0);
  assert.equal(buildPlanFolderIndex('garbage\n\n  \n').size, 0);
});

test('buildProtectedPlanIdChecker: protects a live-origin-claim id OR an in-progress/waiting-operator id', () => {
  const check = buildProtectedPlanIdChecker({
    remoteClaimIds: ['400'],
    planFolderOf: (id) =>
      id === '500'
        ? 'in-progress'
        : id === '501'
          ? 'waiting-operator'
          : id === '502'
            ? 'ready'
            : null,
  });
  assert.equal(check('400'), true); // live claim
  assert.equal(check('500'), true); // parked in-progress
  assert.equal(check('501'), true); // parked waiting-operator
  assert.equal(check('502'), false); // ready/ is not a protected lane
  assert.equal(check('999'), false); // unresolvable
});

test('remediation builders: husk points at git worktree prune + a manual rm; branch/claim commands are exact', () => {
  assert.match(huskRemediation('/repo', 'orphan-1'), /git worktree prune/);
  assert.match(
    huskRemediation('/repo', 'orphan-1'),
    /rm -rf "[/\\]repo[/\\]\.claude[/\\]worktrees[/\\]orphan-1"/,
  );
  assert.equal(
    branchRemediation({ name: 'worktree-1-x', local: true, remote: false }),
    'git branch -D worktree-1-x',
  );
  assert.equal(
    branchRemediation({ name: 'worktree-1-x', local: false, remote: true }),
    'git push origin --delete worktree-1-x',
  );
  assert.equal(
    branchRemediation({ name: 'worktree-1-x', local: true, remote: true }),
    'git branch -D worktree-1-x && git push origin --delete worktree-1-x',
  );
  assert.equal(
    branchRemediation({ name: 'claude/drain-3517-x', local: false, remote: true }),
    'git push origin --delete claude/drain-3517-x',
  );
  assert.match(
    staleClaimRemediation('123'),
    new RegExp(`git update-ref -d ${claimRef('123').replace(/[/]/g, '\\/')}`),
  );
});

test('buildReport: resolves dead-seed tips lazily for drain branches only', () => {
  const calls = [];
  const _git = (_dir, args) => {
    calls.push(args);
    if (args[0] === 'for-each-ref' && args.includes('refs/heads/worktree-*')) {
      return ['refs/heads/worktree-800-x', 'refs/heads/claude/drain-801-y'].join('\n');
    }
    if (args[0] === 'for-each-ref') return '';
    if (args[0] === 'ls-tree') return '';
    if (args[0] === 'worktree') return '';
    if (args[0] === 'ls-remote') return '';
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'rev-parse') return 'drain-tip-sha\n';
    if (args[0] === 'log') return '1\n';
    return '';
  };

  const report = buildReport('/path-that-does-not-exist', { _git });
  assert.deepEqual(
    report.mergedBranches.map((b) => ({ name: b.name, shape: b.shape })),
    [
      { name: 'worktree-800-x', shape: 'worktree' },
      { name: 'claude/drain-801-y', shape: 'drain' },
    ],
  );
  assert.deepEqual(
    calls.filter((args) => args[0] === 'rev-parse'),
    [['rev-parse', 'refs/heads/claude/drain-801-y']],
  );
  assert.match(report.mergedBranches[1].evidence, /provably old dead seed/);
});

test('buildReport: judges a local+remote drain seed from the remote tip', () => {
  const branch = 'claude/drain-3517-remote-carries-work';
  const calls = [];
  const _git = (_dir, args) => {
    calls.push(args);
    if (args[0] === 'for-each-ref' && args.includes('refs/heads/worktree-*')) {
      return `refs/heads/${branch}\n`;
    }
    if (args[0] === 'for-each-ref' && args.includes('refs/remotes/origin/worktree-*')) {
      return `refs/remotes/origin/${branch}\n`;
    }
    if (args[0] === 'ls-tree' || args[0] === 'worktree' || args[0] === 'ls-remote') return '';
    if (args[0] === 'rev-parse') {
      return args[1] === `refs/remotes/origin/${branch}` ? 'remote-tip\n' : 'local-tip\n';
    }
    if (args[0] === 'merge-base') {
      if (args[2] === 'remote-tip') throw new Error('remote tip carries work');
      return '';
    }
    if (args[0] === 'log') return '1\n';
    return '';
  };

  const report = buildReport('/path-that-does-not-exist', { _git });
  assert.equal(
    report.mergedBranches.some((b) => b.name === branch),
    false,
  );
  assert.ok(
    calls.some((args) => args[0] === 'rev-parse' && args[1] === `refs/remotes/origin/${branch}`),
  );
});

// --- full integration test: a real fixture repo exercising buildReport end-to-end -------------
//
// Builds a bare origin + a "main" checkout (mainDir stays on master throughout — exactly the
// resolveMain() shape) and sets up, in one fixture:
//   KILL-LIST (one of each of the four categories):
//     - a worktree DIR husk (.claude/worktrees/9007-test-husk — no .git, unregistered)
//     - a MERGED branch (worktree-9001-x, tip == master, no protecting plan)
//     - a DIVERGED-ARCHIVED branch (worktree-9002-x, an extra commit + plan 9002 in archive/)
//     - a local-only STALE CLAIM ref (refs/claims/9003, plan 9003 in archive/)
//   DO-NOT-TOUCH (one of each guard mechanism):
//     - a `staging` branch (merged into master) — never even enumerated (not `worktree-*`)
//     - worktree-9004-x: merged, but plan 9004 holds a LIVE claim ref on origin
//     - worktree-9005-x: merged, but plan 9005 is parked in in-progress/ AND has a REGISTERED
//       linked worktree (.claude/worktrees/9005-test-parked) — proves it's excluded from BOTH
//       the husk-dir sweep (has a .git pointer + admin entry) and the merged-branch sweep
//     - worktree-batch-9008-x: merged, NO plan file at all (a batch branch, protected ONLY by
//       being checked out in a live registered worktree — the review-finding fix)
//     - a local-only claim ref for plan 9006, which is NOT archived (still in ready/)
function makeFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-wtb-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  const mainDir = join(root, 'main');
  execFileSync('git', ['clone', '-q', origin, mainDir]);
  const g = (...a) => execFileSync('git', ['-C', mainDir, ...a], { encoding: 'utf8' });
  g('config', 'user.email', 'main@t.t');
  g('config', 'user.name', 'main');

  // Seed master with the plan files every folder-lookup check needs.
  const plan = (folder, id, title) => {
    const dir = join(mainDir, 'docs', 'superpowers', 'plans', folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}-Test-${title}.md`), `# ${id} ${title}\n`);
  };
  plan('archive', '9002', 'diverged');
  plan('archive', '9003', 'stale-claim');
  plan('in-progress', '9005', 'parked');
  plan('ready', '9006', 'live-not-archived');
  g('add', '-A');
  g('commit', '-qm', 'seed plan files');
  g('push', '-q', 'origin', 'master');

  const masterSha = g('rev-parse', 'master').trim();

  // KILL: worktree-9001-x — merged (tip == master), local + remote, no plan file at all.
  g('branch', 'worktree-9001-x', 'master');
  g('push', '-q', 'origin', `${masterSha}:refs/heads/worktree-9001-x`);

  // KILL: worktree-9002-x — diverged (an extra commit on a throwaway clone), remote-only.
  const wt2 = mkdtempSync(join(root, 'wt2-'));
  execFileSync('git', ['clone', '-q', origin, wt2]);
  execFileSync('git', ['-C', wt2, 'config', 'user.email', 'wt2@t.t']);
  execFileSync('git', ['-C', wt2, 'config', 'user.name', 'wt2']);
  execFileSync('git', ['-C', wt2, 'checkout', '-qb', 'worktree-9002-x']);
  writeFileSync(join(wt2, 'diverge.txt'), 'diverge\n');
  execFileSync('git', ['-C', wt2, 'add', '-A']);
  execFileSync('git', ['-C', wt2, 'commit', '-qm', 'diverge']);
  execFileSync('git', ['-C', wt2, 'push', '-q', 'origin', 'worktree-9002-x']);

  // DO-NOT-TOUCH: `staging` — merged, but never `worktree-*` so never even enumerated.
  g('push', '-q', 'origin', `${masterSha}:refs/heads/staging`);

  // DO-NOT-TOUCH: worktree-9004-x — merged, protected by a LIVE origin claim ref (no plan file).
  g('push', '-q', 'origin', `${masterSha}:refs/heads/worktree-9004-x`);
  g('push', '-q', 'origin', `${masterSha}:refs/claims/9004`);

  // DO-NOT-TOUCH: worktree-9005-x — merged, protected by its plan being parked in in-progress/
  // AND by a REGISTERED linked worktree checked out onto it.
  g('branch', 'worktree-9005-x', 'master');
  mkdirSync(join(mainDir, '.claude', 'worktrees'), { recursive: true });
  g('worktree', 'add', '.claude/worktrees/9005-test-parked', 'worktree-9005-x');

  // DO-NOT-TOUCH: worktree-batch-9008-x — merged, NO plan file at all (a batch branch has no
  // single owning plan id, so isProtectedPlanId can never see it — protected ONLY by being
  // checked out in a live registered worktree). This is the exact gap review finding (plan
  // 1473) surfaced: before the fix this branch fell straight into mergedBranches with a real
  // `git push origin --delete` remediation despite being this session's own live worktree.
  g('branch', 'worktree-batch-9008-x', 'master');
  g('worktree', 'add', '.claude/worktrees/batch-9008-test-live', 'worktree-batch-9008-x');

  // Bring every pushed branch back into mainDir's local view (remote-tracking refs).
  g('fetch', '-q', 'origin');

  // KILL: refs/claims/9003 — LOCAL-ONLY (never pushed to origin), plan 9003 is archived.
  g('update-ref', 'refs/claims/9003', masterSha);
  // DO-NOT-TOUCH: refs/claims/9006 — LOCAL-ONLY too, but plan 9006 is NOT archived (ready/).
  g('update-ref', 'refs/claims/9006', masterSha);

  // KILL: a worktree DIR husk — a bare directory with no .git pointer and no admin entry.
  const huskDir = join(mainDir, '.claude', 'worktrees', '9007-test-husk');
  mkdirSync(huskDir, { recursive: true });
  writeFileSync(join(huskDir, 'leftover.txt'), 'orphaned rmdir residue\n');

  return {
    mainDir,
    cleanup: () => {
      // Registered linked worktrees must be removed via git before the tree can be rm'd.
      for (const wt of ['9005-test-parked', 'batch-9008-test-live']) {
        try {
          execFileSync('git', [
            '-C',
            mainDir,
            'worktree',
            'remove',
            '--force',
            `.claude/worktrees/${wt}`,
          ]);
        } catch {
          /* best-effort */
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('staleClaimRemediation names the ref that exists, in EITHER namespace (plan 3756)', () => {
  assert.match(
    staleClaimRemediation('9003', legacyClaimRef('9003')),
    new RegExp(`update-ref -d ${legacyClaimRef('9003').replace(/[/]/g, '\\/')}`),
  );
  assert.match(
    staleClaimRemediation('9003', claimRef('9003')),
    new RegExp(`update-ref -d ${claimRef('9003').replace(/[/]/g, '\\/')}`),
  );
});

test('buildReport: end-to-end fixture — exactly the four kill items, none of the protected ones', () => {
  const { mainDir, cleanup } = makeFixtureRepo();
  try {
    const report = buildReport(mainDir);

    assert.deepEqual(
      report.husks.map((h) => h.name),
      ['9007-test-husk'],
    );
    assert.deepEqual(
      report.mergedBranches.map((b) => b.name),
      ['worktree-9001-x'],
    );
    assert.deepEqual(
      report.divergedArchivedBranches.map((b) => b.name),
      ['worktree-9002-x'],
    );
    assert.deepEqual(
      report.staleClaimRefs.map((s) => s.planId),
      ['9003'],
    );

    // None of the protected items leak into ANY category.
    const allNames = [
      ...report.husks.map((h) => h.name),
      ...report.mergedBranches.map((b) => b.name),
      ...report.divergedArchivedBranches.map((b) => b.name),
    ];
    assert.ok(!allNames.includes('staging'));
    assert.ok(!allNames.includes('worktree-9004-x'));
    assert.ok(!allNames.includes('worktree-9005-x'));
    assert.ok(!allNames.includes('9005-test-parked'));
    // review finding (plan 1473): a merged batch-style branch with NO plan id must be protected
    // by isCheckedOut (its only guard), not silently fall through into the kill list.
    assert.ok(!allNames.includes('worktree-batch-9008-x'));
    assert.ok(!report.staleClaimRefs.map((s) => s.planId).includes('9006'));

    // Each surfaced item carries evidence + a remediation string (except diverged-archived,
    // which is surface-only by design).
    assert.ok(report.husks[0].remediation.includes('git worktree prune'));
    assert.equal(
      report.mergedBranches[0].remediation,
      'git branch -D worktree-9001-x && git push origin --delete worktree-9001-x',
    );
    assert.equal(report.divergedArchivedBranches[0].remediation, null);
    assert.ok(
      // plan 3756: the remediation must name the ref that ACTUALLY exists locally. This
      // fixture's stale ref is in the RETIRED namespace, so deriving the name from the plan id
      // would hand the operator a delete of a ref that is not there — a no-op that leaves the
      // debris behind and reports success.
      report.staleClaimRefs[0].remediation.includes(`git update-ref -d ${legacyClaimRef('9003')}`),
    );

    // The 9005 worktree dir is genuinely registered (has both signals) — sanity-check the
    // husk detector's raw input agrees, not just the final report.
    assert.ok(existsSync(join(mainDir, '.claude', 'worktrees', '9005-test-parked', '.git')));
  } finally {
    cleanup();
  }
});
