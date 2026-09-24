// scripts/pre-rebase-main-guard.test.mjs — name-pair of the genuinely new module
// scripts/pre-rebase-main-guard.mjs (plan 2933, fix A). New test FILE justified under the
// vetapp rule: there is no existing name-paired test file for this module.
//
// The invariant these cases exist to protect is NOT "the warning fires" — it is the pair:
// it fires on the one dangerous shape, and stays silent on every ordinary and every
// sanctioned one. A guard that cries wolf is deleted, and a deleted guard protects nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateRebase,
  warnMessage,
  readInMainCheckout,
  readBranch,
  main,
  sanctionedRebaseEnv,
  SANCTIONED_ENV,
} from './pre-rebase-main-guard.mjs';

test('warns on a raw rebase of master in the MAIN checkout — the measured incident', () => {
  const v = evaluateRebase({ inMainCheckout: true, branch: 'master', sanctioned: false });
  assert.equal(v.warn, true);
  assert.equal(v.reason, 'raw-rebase-on-main-master');
});

test('silent in a linked worktree — rebasing a worktree branch is ordinary work', () => {
  const v = evaluateRebase({ inMainCheckout: false, branch: 'master', sanctioned: false });
  assert.equal(v.warn, false);
  assert.equal(v.reason, 'linked-worktree');
});

test('silent on a non-master branch in MAIN', () => {
  const v = evaluateRebase({
    inMainCheckout: true,
    branch: 'worktree-2933-Coord-something',
    sanctioned: false,
  });
  assert.equal(v.warn, false);
  assert.equal(v.reason, 'not-master');
});

test('silent for the sanctioned rebaser — never fire on the recommended replacement', () => {
  // pushMasterWithRebase() rebases master IN the main checkout on every non-ff retry. Without
  // this exemption the guard would fire on every coord write (edit-plan, index, board,
  // coord-edit all route through it) and be muted within a day.
  const v = evaluateRebase({ inMainCheckout: true, branch: 'master', sanctioned: true });
  assert.equal(v.warn, false);
  assert.equal(v.reason, 'sanctioned-rebaser');
});

test('sanctioned wins even outside MAIN, so the exemption can never be order-dependent', () => {
  assert.equal(
    evaluateRebase({ inMainCheckout: false, branch: 'master', sanctioned: true }).reason,
    'sanctioned-rebaser',
  );
});

test('a null branch (detached HEAD) is treated as NOT-master, not as a guess', () => {
  // A detached-HEAD rebase in MAIN is real, but we cannot tell WHICH branch it belongs to.
  // Guessing "probably master" would fire the warning on unrelated rebases; a false positive
  // costs more than a miss for a warn-only guard.
  const v = evaluateRebase({ inMainCheckout: true, branch: null, sanctioned: false });
  assert.equal(v.warn, false);
  assert.equal(v.reason, 'not-master');
});

test('warnMessage names the sanctioned tool and the recovery tool', () => {
  const m = warnMessage();
  assert.match(m, /pushMasterWithRebase/, 'must name the tool that should have been used');
  assert.match(m, /heal-main\.mjs/, 'must name the recovery path when it does wedge');
  assert.match(m, /WARNING, not a block/, 'must say out loud that it does not block');
});

// One spawn prints BOTH selectors on consecutive lines: `<git-dir>\n<git-common-dir>`.
// Real output captured on git 2.53.0.windows.2 in both a worktree and MAIN.
test('readInMainCheckout: equal git-dir and common-dir is MAIN, differing is a worktree', () => {
  assert.equal(
    readInMainCheckout(() => 'C:/repo/.git\nC:/repo/.git\n'),
    true,
  );
  assert.equal(
    readInMainCheckout(() => 'C:/repo/.git/worktrees/slug\nC:/repo/.git\n'),
    false,
  );
});

test('readInMainCheckout normalizes separators and trailing slashes before comparing', () => {
  // Git Bash on Windows hands back mixed separators; a naive === would call MAIN a worktree
  // and silence the guard exactly where it matters most.
  // platform-assert-ok: the point of this case IS the Windows path shape, supplied as data.
  assert.equal(
    readInMainCheckout(() => 'C:\\repo\\.git\\\nC:/repo/.git\n'),
    true,
  );
});

test('readInMainCheckout is false on a truncated one-line reply, never a coin flip', () => {
  // A partial read must not resolve to "MAIN" by accident — that would fire the warning on
  // every worktree rebase and burn the guard's credibility.
  assert.equal(
    readInMainCheckout(() => 'C:/repo/.git\n'),
    false,
  );
});

test('readInMainCheckout is false when git fails, so a broken probe cannot fire the warning', () => {
  assert.equal(
    readInMainCheckout(() => null),
    false,
  );
});

test('readBranch returns null on a detached HEAD', () => {
  assert.equal(
    readBranch(() => null),
    null,
  );
  assert.equal(
    readBranch(() => 'master\n'),
    'master',
  );
});

test('main() always returns exit code 0, warning or not', () => {
  const lines = [];
  const probes = { probeMainCheckout: () => true, probeBranch: () => 'master' };
  assert.equal(main({ env: {}, argv: [], log: (s) => lines.push(s), ...probes }), 0);
  assert.equal(
    main({ env: { [SANCTIONED_ENV]: '1' }, argv: [], log: (s) => lines.push(s), ...probes }),
    0,
  );
});

// --- review fixes (2026-08-06 /gpt-review round 1) ------------------------------

test('main() honours pre-rebase\u2019s branch ARGUMENT over the current HEAD', () => {
  // `git rebase origin/master master` rebases master while HEAD sits elsewhere. Probing HEAD
  // would read the other branch and stay SILENT on exactly the dangerous case.
  const lines = [];
  main({
    env: {},
    argv: ['origin/master', 'master'],
    probeMainCheckout: () => true,
    probeBranch: () => 'some-other-branch',
    log: (s) => lines.push(s),
  });
  assert.equal(lines.length, 1, 'must warn: the ARGUMENT says master');

  // And the mirror: HEAD is master but the argument names another branch → silent.
  const quiet = [];
  main({
    env: {},
    argv: ['origin/master', 'worktree-999-x'],
    probeMainCheckout: () => true,
    probeBranch: () => 'master',
    log: (s) => quiet.push(s),
  });
  assert.equal(quiet.length, 0, 'must stay silent: the ARGUMENT says a non-master branch');
});

test('main() falls back to HEAD when git omits the branch arg (rebasing the current branch)', () => {
  const lines = [];
  main({
    env: {},
    argv: ['origin/master'],
    probeMainCheckout: () => true,
    probeBranch: () => 'master',
    log: (s) => lines.push(s),
  });
  assert.equal(lines.length, 1);
});

test('main() spawns NO git probe when the sanctioned exemption is set', () => {
  // The sanctioned path is the hot one (every coord write that hits a non-ff retry), and it is
  // decidable from the environment alone.
  let probed = 0;
  const count = () => {
    probed++;
    return true;
  };
  main({
    env: { [SANCTIONED_ENV]: '1' },
    argv: ['origin/master', 'master'],
    probeMainCheckout: count,
    probeBranch: count,
    log: () => assert.fail('must not warn when sanctioned'),
  });
  assert.equal(probed, 0, 'no git probe may run on the sanctioned path');
});

test('sanctionedRebaseEnv carries ONLY the exemption — never HUSKY', () => {
  // The regression three reviewers caught: spreading the caller's `{ HUSKY: '0' }` push env
  // into the rebase call disabled the whole husky chain, which is far broader than this one
  // exemption and a behaviour change from before the guard existed.
  const env = sanctionedRebaseEnv();
  assert.deepEqual(Object.keys(env), [SANCTIONED_ENV]);
  assert.equal(env[SANCTIONED_ENV], '1');
  assert.equal(env.HUSKY, undefined);
});

test('readInMainCheckout uses ONE git spawn, not two', () => {
  let spawns = 0;
  const run = (args) => {
    spawns++;
    assert.ok(args.includes('--git-dir') && args.includes('--git-common-dir'));
    return 'C:/repo/.git\nC:/repo/.git\n';
  };
  assert.equal(readInMainCheckout(run), true);
  assert.equal(spawns, 1);
});
