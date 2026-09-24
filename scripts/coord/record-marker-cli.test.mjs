// scripts/coord/record-marker-cli.test.mjs (plan 3586)
// Justification: record-marker-cli.mjs needs an isolated test of its exported git helper's env precedence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitMarkerCommit, git } from './record-marker-cli.mjs';

test('git preserves an explicit caller-supplied env', () => {
  const key = 'plan3586.caller-env';
  const value = 'caller-wins';
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: key,
    GIT_CONFIG_VALUE_0: value,
  };

  assert.equal(git(['config', '--get', key], { env }).trim(), value);
});

// `{ ...process.env, HUSKY: '0' }` used to replace the wrapper's isolation wholesale;
// build this env from gitRepoIsolatedEnv() so ambient repo selectors cannot leak through.
test('commitMarkerCommit does not hand ambient repo selectors to git (plan 3586 review round 3)', () => {
  const priorGitDir = process.env.GIT_DIR;
  const priorGitWorkTree = process.env.GIT_WORK_TREE;
  const hadGitDir = Object.hasOwn(process.env, 'GIT_DIR');
  const hadGitWorkTree = Object.hasOwn(process.env, 'GIT_WORK_TREE');
  const recordedEnvs = [];

  try {
    process.env.GIT_DIR = '/tmp/plan3586-foreign/.git';
    process.env.GIT_WORK_TREE = '/tmp/plan3586-foreign';

    commitMarkerCommit('/tmp/plan3586-main', ['docs/x.md'], {
      commitMsg: 'test: record marker',
      noPush: true,
      _git: (_args, opts) => {
        recordedEnvs.push(opts.env);
        return ' M docs/x.md\n';
      },
      _gitRetry: (_main, _args, opts) => {
        recordedEnvs.push(opts.env);
      },
      _push: () => {},
    });

    assert.equal(recordedEnvs.length, 3);
    for (const env of recordedEnvs) {
      assert.ok(!('GIT_DIR' in env));
      assert.ok(!('GIT_WORK_TREE' in env));
      assert.equal(env.HUSKY, '0');
    }
  } finally {
    if (hadGitDir) process.env.GIT_DIR = priorGitDir;
    else delete process.env.GIT_DIR;
    if (hadGitWorkTree) process.env.GIT_WORK_TREE = priorGitWorkTree;
    else delete process.env.GIT_WORK_TREE;
  }
});
