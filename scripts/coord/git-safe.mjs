#!/usr/bin/env node
// scripts/coord/git-safe.mjs — thin git passthrough that inherits the index.lock
// retry behaviour of coord-git's gitWithLockRetry, for NON-Node callers that
// shell out to git on the shared main `.git` (specifically the data-pipeline
// `run-batch.py` phase-12 commit+push — the unprotected path behind the
// `batch_commit_races_main_git_ops` incident, plan 230 Task 2).
//
// Usage (drop-in for `git`):
//   node scripts/coord/git-safe.mjs add -- backend/src/data/seed/records/SE/record-001.json
//   node scripts/coord/git-safe.mjs commit -m "<msg>"
//   node scripts/coord/git-safe.mjs push
//
// Behaviour: resolve the repo dir from $GIT_SAFE_DIR or cwd, wait for any
// in-flight index.lock to clear, then run `git <args>` (stdio passed through,
// exit code propagated). On a lock-contention failure (the check→exec race),
// back off and retry the whole command. Surfaces a clean non-zero exit if the
// lock never clears. Non-lock failures propagate git's own exit code verbatim.

import { spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { waitForIndexLock, sleepSync, GIT_MAXBUFFER } from './coord-git.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';

// See coord-git.mjs LOCK_RX: deliberately no bare "File exists" alternative —
// git's lock message ("Unable to create '…/index.lock': File exists.") is
// already covered, and a standalone "File exists" could be an unrelated error.
const LOCK_RX =
  /index\.lock|Unable to create '.*\.lock'|another git process|Another git process seems to be running/i;

const ATTEMPTS = Number(process.env.GIT_SAFE_ATTEMPTS) || 10;
const DELAY_MS = Number(process.env.GIT_SAFE_DELAY_MS) || 500;
const dir = process.env.GIT_SAFE_DIR || process.cwd();
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('git-safe: no git args given');
  process.exit(2);
}

let lastStderr = '';
for (let i = 0; i < ATTEMPTS; i++) {
  waitForIndexLock(dir, { attempts: ATTEMPTS, delayMs: DELAY_MS });
  const res = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['inherit', 'inherit', 'pipe'],
    // plan 850: stdout is inherited (never buffered) but the piped stderr still rides spawnSync's
    // 1MB default maxBuffer — a large push/fetch's progress can overflow it. Match the spine's runners.
    maxBuffer: GIT_MAXBUFFER,
    // plan 4135: this is a general git passthrough (push included, per the module header),
    // so gitRepoIsolatedEnv() — repo-selector strip only — not gitIsolatedEnv()'s blanket
    // GIT_* strip, which would also take transport/credential vars a push needs.
    env: gitRepoIsolatedEnv(),
  });
  // Echo git's stderr through to ours so callers' logs are unchanged.
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.error) {
    console.error(`git-safe: failed to spawn git: ${res.error.message}`);
    process.exit(2);
  }
  if (res.status === 0) process.exit(0);
  lastStderr = res.stderr || '';
  // git terminated by a signal has status === null (res.signal names it). Node's
  // process.exit(null) coerces to 0 — a FALSE success that the caller (the
  // run-batch phase-12 commit+push) would read as "git ran fine". Map a signal
  // kill to the conventional 128+signo exit so it surfaces as a failure. (plan 378)
  if (res.status === null) {
    const signo = osConstants.signals[res.signal] || 0;
    console.error(`git-safe: git terminated by signal ${res.signal || 'unknown'}`);
    process.exit(signo ? 128 + signo : 1);
  }
  if (!LOCK_RX.test(lastStderr)) process.exit(res.status); // non-lock failure → propagate
  sleepSync(DELAY_MS); // lock contention → back off and retry
}

console.error(
  `git-safe: \`git ${args.join(' ')}\` blocked by index.lock after ${ATTEMPTS} attempts`,
);
process.exit(1);
