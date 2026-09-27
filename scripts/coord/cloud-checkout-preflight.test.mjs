// scripts/cloud-checkout-preflight.test.mjs  (plan 2049)
// Fixture tests for the cloud-only stale-master preflight. The load-bearing case is
// abort-without-reset when the backup push fails: the backup-push-BEFORE-reset ordering
// is the safety property that makes a mis-fired run recoverable, so it gets a test that
// proves a failed push leaves local master byte-identical and still diverged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import {
  main,
  OPT_IN_FLAG,
  CLOUD_SIGNAL_ENV,
  UNSHALLOW_TIMEOUT_ENV,
  DEEPEN_START,
  DEEPEN_FLOOR,
  DEEPEN_TOTAL_BUDGET_MS,
} from './cloud-checkout-preflight.mjs';
import { loadCoordConfig } from './coord-config.mjs';

// plan 4071 D4: LOCAL_HOST_DENYLIST was removed from cloud-checkout-preflight.mjs — the
// historical guard-3 hostname list now lives in coord.config.json's `localHostDenylist[]`
// and `main()` takes it as an injectable `localHostDenylist` param (defaulting to a direct
// read of `dir`'s own coord.config.json) rather than a hardcoded literal. FIXTURE_DENYLIST
// below is a purely synthetic TEST FIXTURE constant (this module ships verbatim into the
// public coord-kit — scripts/coord/ is copied wholesale — so a shipped core test must not pin
// THIS project's own real coord.config.json value; plan 3958) — every test below that needs a
// denylisted host injects this constant directly via the `localHostDenylist` param, so none of
// them depend on this repo's actual coord.config.json content.
const FIXTURE_DENYLIST = ['WORKSTATION-A1']; // personal-data-ok: fixture

// plan 338: clear inherited GIT_* so `git -C <tmpdir>` honours the temp repo even when
// this suite runs inside a git hook.
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

const CLOUD_HOST = 'runsc-container';
const OK_ARGS = [OPT_IN_FLAG];
const CLOUD_ENV = { [CLOUD_SIGNAL_ENV]: 'acct-uuid-test' };

// One call shape for every scenario — override only the axis under test.
const run = (s, over = {}) =>
  main({ argv: OK_ARGS, dir: s.work.dir, host: CLOUD_HOST, env: CLOUD_ENV, ...over });

// ── harness: bare origin + two clones (work = the checkout under test, other = a writer
// that advances origin/master so `work` can be made behind/diverged without touching a
// real remote — the drain-run.test.mjs twin-clone pattern) ─────────────────────────────
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-preflight-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  const mk = (name) => {
    const dir = join(root, name);
    execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, dir]);
    const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    g('config', 'user.email', 't@t.t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    return { dir, g };
  };
  const work = mk('work');
  writeFileSync(join(work.dir, 'base.txt'), 'base\n');
  work.g('add', '-A');
  work.g('commit', '-qm', 'base');
  work.g('push', '-q', 'origin', 'master');
  const other = mk('other');
  return {
    root,
    origin,
    work,
    other,
    lsOrigin: () => execFileSync('git', ['ls-remote', origin], { encoding: 'utf8' }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// Advance origin/master by one commit from the `other` clone (work does NOT fetch).
function advanceOrigin(s, name = 'upstream.txt') {
  s.other.g('pull', '-q', 'origin', 'master');
  writeFileSync(join(s.other.dir, name), `${name}\n`);
  s.other.g('add', '-A');
  s.other.g('commit', '-qm', `upstream ${name}`);
  s.other.g('push', '-q', 'origin', 'master');
}

// Add a local-only commit on work's master (stale snapshot residue stand-in).
function addLocalCommit(s, name = 'stale.txt') {
  writeFileSync(join(s.work.dir, name), `${name}\n`);
  s.work.g('add', '-A');
  s.work.g('commit', '-qm', `stale ${name}`);
}

const sha = (s, ref = 'master') => s.work.g('rev-parse', ref).trim();

// Swap console.error for the duration of `fn`, returning [result, capturedLines] — the
// next-plan-id.test.mjs pattern (buildClaimOps's --blurb-mismatch WARN test).
function captureErr(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (m) => lines.push(String(m));
  try {
    return [fn(), lines];
  } finally {
    console.error = orig;
  }
}

// Same pattern, for console.log — the `fixed [head-branch]` / CLEAN lines this script
// prints via its `log` helper, not `err`.
function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (m) => lines.push(String(m));
  try {
    return [fn(), lines];
  } finally {
    console.log = orig;
  }
}

// Create and check out a new branch at master's current tip (0 unique commits by
// construction) — the harness-branch shape this suite's new cases exercise.
function checkoutNewBranch(s, name) {
  s.work.g('checkout', '-q', '-b', name, 'master');
}

// ── shallow-clone fixture: a deep origin history (c0..c4, with `old-branch` pinned at
// c0, the pre-window base) plus a GENUINELY shallow `work` clone. Git silently ignores
// --depth on a bare local-filesystem clone URL ("--depth is ignored in local clones");
// pathToFileURL forces the file:// transport that actually respects it (confirmed
// experimentally, plan 3274). Fetching `old-branch` into the shallow `work` clone
// afterwards reproduces the exact reported bug shape: two grafted roots (c4 and c0) with
// no common ancestor visible until unshallowed, so `git merge-base old-branch
// origin/master` returns empty with rc=1 — precisely the plan-3239 symptom.
function makeShallowRepo(depth = 1) {
  const root = mkdtempSync(join(tmpdir(), 'cloud-preflight-shallow-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  // plan 4221: the repair fetches with --filter=blob:none; a local upload-pack ignores the
  // filter (with a warning) unless it is allowed, as GitHub allows it.
  execFileSync('git', ['-C', origin, 'config', 'uploadpack.allowFilter', 'true']);
  const mk = (name, url) => {
    const dir = join(root, name);
    execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', url, dir]);
    const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    g('config', 'user.email', 't@t.t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    return { dir, g };
  };
  const seed = mk('seed', origin);
  for (const name of ['c0', 'c1', 'c2', 'c3', 'c4']) {
    writeFileSync(join(seed.dir, `${name}.txt`), `${name}\n`);
    // One file rewritten every commit, so older commits carry blobs the tip does not — the
    // blobs a blob:none repair leaves behind (plan 4221).
    writeFileSync(join(seed.dir, 'rolling.txt'), `rolling ${name}\n`);
    seed.g('add', '-A');
    seed.g('commit', '-qm', name);
    if (name === 'c0') seed.g('branch', 'old-branch');
  }
  seed.g('push', '-q', 'origin', 'master');
  seed.g('push', '-q', 'origin', 'old-branch');

  const workDir = join(root, 'work');
  execFileSync('git', [
    'clone',
    '-q',
    `--depth=${depth}`,
    '-c',
    'core.autocrlf=false',
    pathToFileURL(origin).href,
    workDir,
  ]);
  const workG = (...a) => execFileSync('git', ['-C', workDir, ...a], { encoding: 'utf8' });
  workG('config', 'user.email', 't@t.t');
  workG('config', 'user.name', 't');
  workG('config', 'commit.gpgsign', 'false');
  // Bring the pre-window branch in at the SAME shallow boundary.
  workG('fetch', '-q', 'origin', 'old-branch:old-branch');

  return {
    root,
    origin,
    seed,
    work: { dir: workDir, g: workG },
    lsOrigin: () => execFileSync('git', ['ls-remote', origin], { encoding: 'utf8' }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const isShallow = (s) => s.work.g('rev-parse', '--is-shallow-repository').trim() === 'true';

// plan 4221: push an ORPHAN branch (three commits, its own root) to the shallow fixture's
// origin — a tip that is NOT in master's history, the shape of the ~371 non-master heads
// a real cloud origin carries. Returns the branch tip sha.
function pushOrphanBranch(s, name) {
  s.seed.g('checkout', '-q', '--orphan', name);
  for (const n of ['s0', 's1', 's2']) {
    writeFileSync(join(s.seed.dir, `${name}-${n}.txt`), `${n}\n`);
    s.seed.g('add', '-A');
    s.seed.g('commit', '-qm', `${name} ${n}`);
  }
  s.seed.g('push', '-q', 'origin', name);
  const tip = s.seed.g('rev-parse', 'HEAD').trim();
  s.seed.g('checkout', '-q', 'master');
  return tip;
}

const hasRef = (s, ref) => {
  try {
    s.work.g('rev-parse', '-q', '--verify', ref);
    return true;
  } catch {
    return false;
  }
};

// ── refusal gates (neither the flag nor a clean host alone authorizes anything) ────────
test('refuses without the opt-in flag, even on a diverged checkout', () => {
  const s = makeRepo();
  try {
    addLocalCommit(s);
    advanceOrigin(s);
    const before = sha(s);
    const code = run(s, { argv: [] });
    assert.equal(code, 2);
    assert.equal(sha(s), before, 'refusal must not mutate master');
    assert.ok(!s.lsOrigin().includes('backup/'), 'refusal must not push a backup');
  } finally {
    s.cleanup();
  }
});

test('refuses on a denylisted local host, flag or no flag (case-insensitive)', () => {
  const s = makeRepo();
  try {
    addLocalCommit(s);
    advanceOrigin(s);
    const before = sha(s);
    for (const host of [FIXTURE_DENYLIST[0], FIXTURE_DENYLIST[0].toLowerCase()]) {
      const code = run(s, { host, localHostDenylist: FIXTURE_DENYLIST });
      assert.equal(code, 2, `host ${host} must be refused`);
    }
    assert.equal(sha(s), before);
  } finally {
    s.cleanup();
  }
});

test('refuses without the positive cloud signal (default-deny on an unlisted machine)', () => {
  const s = makeRepo();
  try {
    addLocalCommit(s);
    advanceOrigin(s);
    const before = sha(s);
    for (const env of [{}, { [CLOUD_SIGNAL_ENV]: '' }, { [CLOUD_SIGNAL_ENV]: '  ' }]) {
      const code = run(s, { env });
      assert.equal(code, 2, `env ${JSON.stringify(env)} must be refused`);
    }
    assert.equal(sha(s), before, 'refusal must not mutate master');
    assert.ok(!s.lsOrigin().includes('backup/'));
  } finally {
    s.cleanup();
  }
});

test('refuses when a LIVE linked worktree exists (not a disposable-checkout shape)', () => {
  const s = makeRepo();
  try {
    s.work.g('worktree', 'add', '-q', join(s.root, 'wt'), '-b', 'wt-branch');
    const code = run(s);
    assert.equal(code, 2);
  } finally {
    s.cleanup();
  }
});

test('a PRUNABLE worktree entry (orphaned metadata, dir gone) does not block the repair', () => {
  const s = makeRepo();
  try {
    s.work.g('worktree', 'add', '-q', join(s.root, 'wt'), '-b', 'wt-branch');
    rmSync(join(s.root, 'wt'), { recursive: true, force: true });
    addLocalCommit(s);
    advanceOrigin(s);
    const code = run(s);
    assert.equal(code, 0, 'orphaned worktree metadata must not trip guard 4');
    assert.ok(s.lsOrigin().includes('backup/stale-local-master-'), 'repair must proceed');
    assert.equal(sha(s), sha(s, 'origin/master'));
  } finally {
    s.cleanup();
  }
});

// ── clean no-ops ───────────────────────────────────────────────────────────────────────
test('clean checkout at origin/master: exit 0, nothing mutated, no backup pushed', () => {
  const s = makeRepo();
  try {
    const before = sha(s);
    const code = run(s);
    assert.equal(code, 0);
    assert.equal(sha(s), before);
    assert.ok(!s.lsOrigin().includes('backup/'));
  } finally {
    s.cleanup();
  }
});

test('behind-only master is CLEAN for this preflight (exit 0, no reset, no backup)', () => {
  const s = makeRepo();
  try {
    advanceOrigin(s);
    const before = sha(s);
    const code = run(s);
    assert.equal(code, 0);
    assert.equal(sha(s), before, 'behind-only must not be touched (heal-main territory)');
    assert.ok(!s.lsOrigin().includes('backup/'));
  } finally {
    s.cleanup();
  }
});

// ── the load-bearing test: abort WITHOUT reset when the backup push fails ──────────────
test('failed backup push aborts WITHOUT resetting — master keeps its stale commits', () => {
  const s = makeRepo();
  try {
    addLocalCommit(s);
    advanceOrigin(s);
    const before = sha(s);
    // Fetch works (url), push dies (pushurl) — simulates a proxy/credential push failure.
    s.work.g('config', 'remote.origin.pushurl', join(s.root, 'nonexistent.git'));
    const code = run(s);
    assert.notEqual(code, 0, 'failed backup push must be a non-zero exit');
    assert.equal(sha(s), before, 'master must be untouched after a failed backup push');
    assert.ok(!s.lsOrigin().includes('backup/'), 'no backup ref may exist on origin');
    // Still diverged — a rerun after the push problem is fixed still has work to do.
    const counts = s.work.g('rev-list', '--left-right', '--count', 'origin/master...master');
    assert.match(counts.trim(), /^\d+\s+[1-9]\d*$/, 'ahead count must still be non-zero');
  } finally {
    s.cleanup();
  }
});

test('the backup push skips git hooks (HUSKY=0) — a gate-style pre-push cannot block the repair', () => {
  const s = makeRepo();
  try {
    addLocalCommit(s);
    advanceOrigin(s);
    const staleTip = sha(s);
    const hook = join(s.work.dir, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, '#!/bin/sh\n[ "$HUSKY" = "0" ] || exit 1\nexit 0\n', { mode: 0o755 });
    const code = run(s);
    assert.equal(code, 0, 'the repair must survive a gate-style pre-push hook');
    assert.ok(
      s.lsOrigin().includes('refs/heads/backup/stale-local-master-'),
      'the backup ref must still reach origin with hooks installed',
    );
    assert.equal(sha(s), sha(s, 'origin/master'), 'local master must equal origin/master');
    assert.notEqual(staleTip, sha(s), 'the stale tip must actually have been discarded');
  } finally {
    s.cleanup();
  }
});

// ── the repair paths ───────────────────────────────────────────────────────────────────
test('diverged master: backup branch pushed with pre-reset tip, then master == origin/master', () => {
  const s = makeRepo();
  try {
    addLocalCommit(s);
    advanceOrigin(s);
    const staleTip = sha(s);
    const code = run(s);
    assert.equal(code, 0);
    const backupLine = s
      .lsOrigin()
      .split('\n')
      .find((l) => l.includes('refs/heads/backup/stale-local-master-'));
    assert.ok(backupLine, 'a backup/stale-local-master-* ref must exist on origin');
    assert.equal(backupLine.split('\t')[0], staleTip, 'backup must hold the pre-reset tip');
    assert.equal(sha(s), sha(s, 'origin/master'), 'local master must equal origin/master');
    assert.equal(s.work.g('status', '--porcelain').trim(), '', 'tree must be clean');
  } finally {
    s.cleanup();
  }
});

test('ahead-only master (no upstream advance) is also backed up then reset', () => {
  const s = makeRepo();
  try {
    addLocalCommit(s);
    const staleTip = sha(s);
    const code = run(s);
    assert.equal(code, 0);
    assert.ok(s.lsOrigin().includes('backup/stale-local-master-'));
    assert.notEqual(sha(s), staleTip);
    assert.equal(sha(s), sha(s, 'origin/master'));
  } finally {
    s.cleanup();
  }
});

test('detached HEAD + diverged master: repaired to attached master at origin/master', () => {
  const s = makeRepo();
  try {
    addLocalCommit(s);
    advanceOrigin(s);
    s.work.g('checkout', '-q', '--detach', 'HEAD');
    const code = run(s);
    assert.equal(code, 0);
    assert.equal(s.work.g('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'master');
    assert.equal(sha(s), sha(s, 'origin/master'));
  } finally {
    s.cleanup();
  }
});

// ── the third state (plan 3813): HEAD attached to a NAMED non-master branch ────────────
test('harness branch, 0 unique commits, clean tree: reattaches to master and prints fixed', () => {
  const s = makeRepo();
  try {
    checkoutNewBranch(s, 'claude/x');
    const before = sha(s, 'master');
    const [code, logLines] = captureLog(() => run(s));
    assert.equal(code, 0, 'a clean harness branch with no unique commits must not be refused');
    assert.equal(
      s.work.g('rev-parse', '--abbrev-ref', 'HEAD').trim(),
      'master',
      'HEAD must end reattached to master',
    );
    assert.equal(sha(s, 'master'), before, 'master itself must be untouched (already clean)');
    assert.ok(
      logLines.some((l) => l.includes('fixed [claude/x]')),
      `must name the branch left behind; got: ${logLines.join('\n')}`,
    );
  } finally {
    s.cleanup();
  }
});

test('harness branch with a UNIQUE commit refuses (non-zero) and leaves the branch untouched', () => {
  const s = makeRepo();
  try {
    checkoutNewBranch(s, 'claude/y');
    writeFileSync(join(s.work.dir, 'unique.txt'), 'unique\n');
    s.work.g('add', '-A');
    s.work.g('commit', '-qm', 'unique to claude/y');
    const before = sha(s, 'claude/y');
    const [code, errLines] = captureErr(() => run(s));
    assert.notEqual(code, 0, 'a unique commit on the branch must never be silently discarded');
    assert.equal(
      s.work.g('rev-parse', '--abbrev-ref', 'HEAD').trim(),
      'claude/y',
      'HEAD must stay on the branch — never silently switched away from real commits',
    );
    assert.equal(sha(s, 'claude/y'), before, 'the branch tip must be untouched');
    const joined = errLines.join('\n');
    assert.match(
      joined,
      /claude\/y/,
      `the branch name must be named in the refusal; got: ${joined}`,
    );
    assert.match(
      joined,
      /1\b/,
      `the unique-commit count must appear in the refusal; got: ${joined}`,
    );
  } finally {
    s.cleanup();
  }
});

test('a dirty tree on a non-master branch refuses, even with 0 unique commits', () => {
  const s = makeRepo();
  try {
    checkoutNewBranch(s, 'claude/z');
    writeFileSync(join(s.work.dir, 'base.txt'), 'dirtied\n');
    const [code, errLines] = captureErr(() => run(s));
    assert.notEqual(code, 0, 'a dirty tree on a non-master branch must refuse');
    assert.equal(
      s.work.g('rev-parse', '--abbrev-ref', 'HEAD').trim(),
      'claude/z',
      'HEAD must stay on the dirty branch',
    );
    const joined = errLines.join('\n');
    assert.match(
      joined,
      /claude\/z/,
      `the branch name must be named in the refusal; got: ${joined}`,
    );
    assert.match(joined, /DIRTY/, `the dirt must be named in the refusal; got: ${joined}`);
  } finally {
    s.cleanup();
  }
});

// ── review regressions (plan 3813, /gpt-review round 1) ───────────────────────────────
// The motivating boot shape is NOT "local master == origin/master". A cloud container boots
// with local master far BEHIND origin/master (1719 commits, measured 2026-09-08) while the
// harness branch sits exactly AT origin/master. Judged against the stale local master ref,
// those are 1719 commits "unique" to the branch and the preflight REFUSES — the opposite of
// the repair. The baseline must be the fetched origin/master.
test('harness branch at origin/master while LOCAL master trails: reattaches, does not refuse', () => {
  const s = makeRepo();
  try {
    advanceOrigin(s); // origin/master moves; work's local master stays behind
    s.work.g('fetch', '-q', 'origin');
    s.work.g('checkout', '-q', '-b', 'claude/behind', 'origin/master');
    assert.ok(
      Number(s.work.g('rev-list', '--count', 'master..claude/behind').trim()) > 0,
      'fixture precondition: the branch must look "ahead" of the STALE local master',
    );
    assert.equal(
      s.work.g('rev-list', '--count', 'origin/master..claude/behind').trim(),
      '0',
      'fixture precondition: the branch adds nothing over the real baseline',
    );
    const [code, logLines] = captureLog(() => run(s));
    assert.equal(code, 0, 'a clean harness branch at origin/master must not be refused');
    assert.equal(
      s.work.g('rev-parse', '--abbrev-ref', 'HEAD').trim(),
      'master',
      'HEAD must end reattached to master',
    );
    assert.ok(
      logLines.some((l) => l.includes('fixed [claude/behind]')),
      `must name the branch left behind; got: ${logLines.join('\n')}`,
    );
  } finally {
    s.cleanup();
  }
});

// The no-local-master early return used to sit ABOVE the HEAD check, so a checkout with no
// local master at all reported success while still wedged off master for every coord tool.
test('no local master + HEAD on a harness branch: still reattaches instead of exiting 0 off master', () => {
  const s = makeRepo();
  try {
    s.work.g('checkout', '-q', '-b', 'claude/nomaster', 'master');
    s.work.g('branch', '-q', '-D', 'master');
    assert.throws(
      () => s.work.g('rev-parse', '-q', '--verify', 'refs/heads/master^{commit}'),
      'fixture precondition: local master must be absent',
    );
    const [code, logLines] = captureLog(() => run(s));
    assert.equal(code, 0, 'the repair is available here — nothing on the branch to lose');
    assert.equal(
      s.work.g('rev-parse', '--abbrev-ref', 'HEAD').trim(),
      'master',
      'HEAD must end on master, not merely report success',
    );
    assert.equal(
      sha(s, 'master'),
      sha(s, 'origin/master'),
      'the recreated master must sit at the fetched baseline',
    );
    assert.ok(
      logLines.some((l) => l.includes('fixed [claude/nomaster]')),
      `must name the branch left behind; got: ${logLines.join('\n')}`,
    );
  } finally {
    s.cleanup();
  }
});

// `git status --porcelain` alone inherits status.showUntrackedFiles; a checkout configured
// with `no` would report an untracked-carrying tree as clean and get switched away from it.
test('untracked dirt is seen even under status.showUntrackedFiles=no', () => {
  const s = makeRepo();
  try {
    s.work.g('checkout', '-q', '-b', 'claude/hidden', 'master');
    s.work.g('config', 'status.showUntrackedFiles', 'no');
    writeFileSync(join(s.work.dir, 'untracked.txt'), 'untracked\n');
    assert.equal(
      s.work.g('status', '--porcelain').trim(),
      '',
      'fixture precondition: the config must hide the dirt from a bare porcelain call',
    );
    const [code, errLines] = captureErr(() => run(s));
    assert.notEqual(code, 0, 'hidden untracked dirt must still refuse');
    assert.equal(
      s.work.g('rev-parse', '--abbrev-ref', 'HEAD').trim(),
      'claude/hidden',
      'HEAD must stay put — the untracked file belongs to this branch checkout',
    );
    assert.match(errLines.join('\n'), /DIRTY/, 'the refusal must name the dirt');
  } finally {
    s.cleanup();
  }
});

// ── review regressions (plan 3813, /gpt-review round 2) ───────────────────────────────
// Reattaching is only half the repair: handing the drain back the same stale master the
// container booted with leaves every following command reading an old checkout.
test('reattaching also fast-forwards a behind local master up to origin/master', () => {
  const s = makeRepo();
  try {
    advanceOrigin(s);
    s.work.g('fetch', '-q', 'origin');
    s.work.g('checkout', '-q', '-b', 'claude/ff', 'origin/master');
    const staleMaster = sha(s, 'master');
    const baseline = sha(s, 'origin/master');
    assert.notEqual(staleMaster, baseline, 'fixture precondition: local master must trail');
    assert.equal(run(s), 0);
    assert.equal(s.work.g('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'master');
    assert.equal(
      sha(s, 'master'),
      baseline,
      'local master must end AT the fetched baseline, not at the stale tip it booted with',
    );
  } finally {
    s.cleanup();
  }
});

// --ff-only is the safety property: a master carrying its own commits must NOT be
// fast-forwarded away here — that belongs to the backup-then-reset path alone.
test('reattach never ff-discards a local master carrying its own commits', () => {
  const s = makeRepo();
  try {
    advanceOrigin(s);
    s.work.g('fetch', '-q', 'origin');
    addLocalCommit(s); // master is now diverged: its own commit + behind origin
    const localTip = sha(s, 'master');
    s.work.g('checkout', '-q', '-b', 'claude/diverged', 'origin/master');
    run(s);
    assert.ok(
      s.work.g('log', '--format=%H', 'master').includes(localTip.slice(0, 40)) ||
        s.lsOrigin().includes(localTip),
      'the local-only commit must be preserved — on master, or backed up to origin',
    );
  } finally {
    s.cleanup();
  }
});

// A refusal is only useful if the command it prints actually runs.
test('the refusal remedy names a runnable command when there is no local master', () => {
  const s = makeRepo();
  try {
    s.work.g('checkout', '-q', '-b', 'claude/nomaster-dirty', 'master');
    s.work.g('branch', '-q', '-D', 'master');
    writeFileSync(join(s.work.dir, 'dirt.txt'), 'dirt\n');
    s.work.g('add', '-A');
    const [code, errLines] = captureErr(() => run(s));
    assert.notEqual(code, 0, 'a dirty tree must still refuse');
    const joined = errLines.join('\n');
    assert.match(
      joined,
      /checkout -B master origin\/master/,
      `remedy must be runnable without a local master; got: ${joined}`,
    );
  } finally {
    s.cleanup();
  }
});

// ── review regressions (plan 3813, /gpt-review round 3) ───────────────────────────────
// A ff that COULD have happened but failed operationally (a stale index.lock from a
// crashed container is the motivating shape) must abort — swallowed, it leaves master
// stale and the ahead===0 path then reports CLEAN over an old checkout.
test('an operational fast-forward failure aborts loudly instead of reporting CLEAN', () => {
  const s = makeRepo();
  try {
    advanceOrigin(s);
    s.work.g('fetch', '-q', 'origin');
    s.work.g('checkout', '-q', '-b', 'claude/locked', 'origin/master');
    const staleMaster = sha(s, 'master');
    // A stale `refs/heads/master.lock` — git's own crashed-process residue, and the one
    // injection that isolates THIS step: the reattaching checkout does not write that ref
    // (it succeeds), master stays a strict ancestor of origin/master (the ff is genuinely
    // possible), and only the ff itself fails. An index.lock would abort the earlier
    // checkout instead and never reach the branch under test.
    const refLock = join(s.work.dir, '.git', 'refs', 'heads', 'master.lock');
    mkdirSync(dirname(refLock), { recursive: true });
    writeFileSync(refLock, '');
    const [code, errLines] = captureErr(() => run(s));
    assert.notEqual(code, 0, 'a swallowed ff failure would report success over a stale master');
    assert.equal(sha(s, 'master'), staleMaster, 'master must be left exactly as it was');
    assert.match(errLines.join('\n'), /fast-forward/i, 'the abort must name what failed');
  } finally {
    s.cleanup();
  }
});

// The printed remedy is copied by hand into a shell; this project's own checkouts sit
// under `98 Hobby/`, so an unquoted path is re-tokenized and the command fails.
test('the refusal quotes the checkout path so a path with spaces stays one argument', () => {
  const s = makeRepo();
  try {
    s.work.g('checkout', '-q', '-b', 'claude/spaced', 'master');
    writeFileSync(join(s.work.dir, 'dirt.txt'), 'dirt\n');
    s.work.g('add', '-A');
    // Move the checkout to a path that ACTUALLY contains a space (asserting the quoting
    // against a space-free path would prove nothing). The clone's origin URL is an
    // absolute path under `root`, which the rename does not touch, so the repo keeps
    // working from its new location.
    const spaced = join(s.root, 'work with space');
    renameSync(s.work.dir, spaced);
    const esc = spaced.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const [code, errLines] = captureErr(() => run(s, { dir: spaced }));
    assert.notEqual(code, 0);
    const joined = errLines.join('\n');
    assert.ok(joined.includes(' '), 'fixture precondition: the path under test has a space');
    assert.match(
      joined,
      new RegExp(`git -C "${esc}"`),
      `every emitted git -C must quote the path; got: ${joined}`,
    );
    assert.doesNotMatch(
      joined,
      new RegExp(`git -C ${esc}[^"]`),
      `no unquoted git -C may remain; got: ${joined}`,
    );
  } finally {
    s.cleanup();
  }
});

test('idempotent: a second run on a repaired checkout is a clean no-op', () => {
  const s = makeRepo();
  try {
    addLocalCommit(s);
    advanceOrigin(s);
    assert.equal(run(s), 0);
    const backupCount = (s.lsOrigin().match(/backup\/stale-local-master-/g) || []).length;
    assert.equal(run(s), 0);
    const backupCount2 = (s.lsOrigin().match(/backup\/stale-local-master-/g) || []).length;
    assert.equal(backupCount2, backupCount, 'second run must not push another backup');
  } finally {
    s.cleanup();
  }
});

// ── shallow-clone guard (plan 3274; cumulative-deepen repair, plan 4189) — a separate
// axis from the stale-master path above
test('shallow clone is detected and unshallowed via the default --deepen seam; an old-base merge-base then resolves', () => {
  const s = makeShallowRepo();
  try {
    assert.equal(isShallow(s), true, 'fixture must actually be shallow before the run');
    assert.throws(
      () => s.work.g('merge-base', 'old-branch', 'origin/master'),
      'merge-base must fail pre-repair — reproduces the plan-3239 symptom exactly',
    );
    // Real git, DEFAULT seam (no injected `deepenFetch`) — proves the actual default
    // seam repairs a genuinely shallow clone, not just an injected fake standing in for it.
    const [code, logLines] = captureLog(() => run(s));
    assert.equal(code, 0, `expected repair success, got log: ${logLines.join('\n')}`);
    assert.equal(isShallow(s), false, '.git/shallow must be cleared after the repair');
    const mb = s.work.g('merge-base', 'old-branch', 'origin/master').trim();
    assert.match(mb, /^[0-9a-f]{40}$/, 'merge-base must resolve to a real sha post-repair');
    // The loop must issue at least one `--deepen` round, and — if a closer round ever ran
    // — it must run AFTER every `--deepen` round, never before (S1's ordering).
    const joined = logLines.join('\n');
    assert.match(joined, /--deepen=/, 'the loop must issue at least one --deepen round');
    const lastDeepenIdx = logLines.map((l) => /--deepen=/.test(l)).lastIndexOf(true);
    const firstUnshallowIdx = logLines.findIndex((l) => /the closer/.test(l));
    if (firstUnshallowIdx !== -1) {
      assert.ok(
        lastDeepenIdx < firstUnshallowIdx,
        `every --deepen round must run before the closer; got: ${joined}`,
      );
    }
  } finally {
    s.cleanup();
  }
});

test('an already-complete (non-shallow) clone is an untouched no-op for this guard', () => {
  const s = makeRepo();
  try {
    assert.equal(isShallow(s), false, 'control fixture must not be shallow');
    const before = sha(s);
    // A regression that calls `git fetch --unshallow` unconditionally would throw here
    // ("--unshallow on a complete repository does not make sense") — this asserts the
    // shallow branch is gated strictly behind the is-shallow-repository check.
    const code = run(s);
    assert.equal(code, 0);
    assert.equal(sha(s), before, 'must not mutate master');
    assert.equal(isShallow(s), false, 'must still not be shallow');
    assert.ok(!s.lsOrigin().includes('backup/'));
  } finally {
    s.cleanup();
  }
});

test('a failed shallow-clone repair exits non-zero with the cause named in its output', () => {
  const s = makeShallowRepo();
  try {
    // Break the FETCH path (not push) — `git fetch --unshallow` reads remote.origin.url.
    s.work.g('config', 'remote.origin.url', join(s.root, 'nonexistent-origin.git'));
    const [code, errLines] = captureErr(() => run(s));
    assert.notEqual(code, 0, 'a failed unshallow repair must be a non-zero exit');
    const joined = errLines.join('\n');
    assert.match(
      joined,
      /shallow-clone repair failed/,
      `cause must be named in the output; got: ${joined}`,
    );
    assert.match(joined, /git fetch --deepen origin/, 'the exact repair command must be named');
  } finally {
    s.cleanup();
  }
});

// ── master-only fetches (plan 4221) ────────────────────────────────────────────────────
// Real cloud clones carry the wildcard `+refs/heads/*:refs/remotes/origin/*` refspec, and
// a refspec-less fetch then pulls every origin head into every deepen round. The repair
// rounds, the closer and the orient fetch must all name master explicitly.
test('plan 4221: default seam + orient fetch stay master-only under a wildcard refspec (a non-master origin head is never fetched)', () => {
  const s = makeShallowRepo();
  try {
    pushOrphanBranch(s, 'side');
    s.work.g('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    assert.equal(isShallow(s), true, 'fixture must actually be shallow before the run');
    assert.equal(hasRef(s, 'refs/remotes/origin/side'), false, 'fixture precondition');
    const [code, logLines] = captureLog(() => run(s));
    assert.equal(code, 0, `expected repair success, got log: ${logLines.join('\n')}`);
    assert.equal(isShallow(s), false, '.git/shallow must be cleared after the repair');
    assert.equal(
      hasRef(s, 'refs/remotes/origin/side'),
      false,
      'the preflight must not fetch a non-master origin head',
    );
    assert.equal(
      hasRef(s, 'refs/remotes/origin/old-branch'),
      false,
      'the preflight must not fetch origin/old-branch either',
    );
    assert.equal(sha(s, 'refs/remotes/origin/master'), s.seed.g('rev-parse', 'master').trim());
  } finally {
    s.cleanup();
  }
});

// plan 4221: the default seam passes --filter=blob:none, so the repair ends as a
// non-shallow PARTIAL clone — git records the promisor config, old blobs stay on origin
// until something reads them, and a read fetches them lazily.
test('plan 4221: the default-seam repair leaves a non-shallow blob:none partial clone', () => {
  const s = makeShallowRepo();
  try {
    const [code, logLines] = captureLog(() => run(s));
    assert.equal(code, 0, `expected repair success, got log: ${logLines.join('\n')}`);
    assert.equal(isShallow(s), false, 'a partial clone is not shallow');
    assert.equal(s.work.g('config', 'remote.origin.promisor').trim(), 'true');
    assert.equal(s.work.g('config', 'remote.origin.partialclonefilter').trim(), 'blob:none');
    // --missing=print never lazy-fetches, so this counts what the repair did NOT download.
    const missing = () =>
      s.work
        .g('rev-list', '--objects', '--missing=print', 'origin/master')
        .split(/\r?\n/)
        .filter((l) => l.startsWith('?')).length;
    assert.ok(missing() > 0, 'old blobs must be left on origin, proving the filter was used');
    assert.match(s.work.g('merge-base', 'old-branch', 'origin/master').trim(), /^[0-9a-f]{40}$/);
    assert.match(s.work.g('log', '--format=%s', '--', 'c1.txt'), /c1/);
    assert.equal(
      s.work.g('show', 'origin/master~3:rolling.txt'),
      'rolling c1\n',
      'a missing blob must be fetched lazily on read',
    );
  } finally {
    s.cleanup();
  }
});

// A master-only fetch cannot clear a boundary that origin itself can no longer deepen —
// here a branch fetched shallow, then deleted on origin and pruned there (the shape a
// reaped coord/probes/* ref leaves behind). origin/master's history is still whole, so
// that leftover line must be accepted and logged, not reported as a wedged repair.
test('plan 4221: a leftover boundary unreachable from origin/master is accepted as a repair of origin/master', () => {
  const s = makeShallowRepo();
  try {
    const goneTip = pushOrphanBranch(s, 'gone');
    s.work.g('fetch', '-q', '--depth=1', 'origin', 'gone:refs/heads/gone');
    execFileSync('git', ['-C', s.origin, 'branch', '-q', '-D', 'gone']);
    execFileSync('git', ['-C', s.origin, 'gc', '-q', '--prune=now']);
    const shallowLines = () =>
      readFileSync(join(s.work.dir, '.git', 'shallow'), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean);
    assert.equal(shallowLines().length, 2, 'fixture precondition: master + gone boundaries');
    assert.ok(shallowLines().includes(goneTip), 'fixture precondition: gone tip is a boundary');
    const [code, logLines] = captureLog(() => run(s));
    const joined = logLines.join('\n');
    assert.equal(code, 0, `expected repair success, got log: ${joined}`);
    assert.deepEqual(shallowLines(), [goneTip], "only the other ref's boundary may remain");
    assert.match(
      joined,
      /shallow-clone REPAIRED for origin\/master \(1 boundary line\(s\) remain on other refs, none reachable from origin\/master\)/,
      `the partial-shallow acceptance must be logged; got: ${joined}`,
    );
    const mb = s.work.g('merge-base', 'old-branch', 'origin/master').trim();
    assert.match(mb, /^[0-9a-f]{40}$/, "origin/master's history must be whole");
  } finally {
    s.cleanup();
  }
});

// The completion check must tell `--is-ancestor`'s clean "no" (exit 1) apart from a git
// error: a boundary sha git cannot resolve is an error, never "not reachable".
test('plan 4221: a git error in the origin/master completeness check aborts instead of reading as "not ancestor"', () => {
  const s = makeShallowRepo();
  const shallowPath = join(s.work.dir, '.git', 'shallow');
  try {
    // Every call leaves `.git/shallow` naming only a sha that does not exist: round 1 moves
    // the boundary, round 2 changes nothing, the closer changes nothing.
    const fakeDeepenFetch = () => writeFileSync(shallowPath, `${'ab'.repeat(20)}\n`);
    const [code, errLines] = captureErr(() =>
      run(s, { deepenFetch: fakeDeepenFetch, now: () => 0 }),
    );
    const joined = errLines.join('\n');
    assert.equal(code, 1, `a git error must abort; got: ${joined}`);
    assert.match(joined, /cannot re-verify shallow-clone state/, `got: ${joined}`);
  } finally {
    s.cleanup();
  }
});

// ── cumulative-deepen repair (plan 4189) — injected `deepenFetch` seam ─────────────────
// This is the case that killed the pre-4189 code: a single all-or-nothing
// `git fetch --unshallow` that times out keeps nothing, so every retry restarted from
// zero and never converged. A round that COMPLETES must keep its progress and let the
// next (halved) round finish the repair.
test('injected fake: a round TIMES OUT then the halved retry completes and repairs the clone', () => {
  const s = makeShallowRepo();
  const shallowPath = join(s.work.dir, '.git', 'shallow');
  try {
    const calls = [];
    const fakeDeepenFetch = (depthOrUnshallow) => {
      calls.push(depthOrUnshallow);
      if (calls.length === 1) {
        const e = new Error('simulated round timeout');
        e.code = 'ETIMEDOUT';
        throw e;
      }
      // The halved retry "completes" — simulate a full unshallow by removing the shallow
      // marker file, exactly what a real `git fetch --deepen`/`--unshallow` that reaches
      // the roots does.
      rmSync(shallowPath, { force: true });
    };
    const [code, logLines] = captureLog(() => run(s, { deepenFetch: fakeDeepenFetch }));
    assert.equal(code, 0, 'a halved retry that completes must repair the clone');
    assert.deepEqual(
      calls,
      [DEEPEN_START, Math.floor(DEEPEN_START / 2)],
      'exactly one halved retry after the timeout',
    );
    assert.equal(isShallow(s), false, '.git/shallow must be cleared after the repair');
    assert.ok(
      logLines.some((l) => l.includes('TIMED OUT') && l.includes('halving')),
      `the retry must be logged as a halve-on-timeout; got: ${logLines.join('\n')}`,
    );
  } finally {
    s.cleanup();
  }
});

// S4 (the closer) + the "still shallow after a reported success" abort: a round that
// reports success without ever moving `.git/shallow`'s boundary must not spin on another
// identical round — the closer runs once, and if IT also leaves the repo shallow, the
// whole repair aborts as wedged, never silently retried forever.
test('injected fake: rounds report success but never move the boundary; the closer also leaves it shallow → wedged abort', () => {
  const s = makeShallowRepo();
  try {
    const fakeDeepenFetch = () => {
      // Reports success (no throw) but never touches `.git/shallow` — neither a
      // `--deepen` round nor the closer's `--unshallow` call ever makes progress.
    };
    const [code, errLines] = captureErr(() => run(s, { deepenFetch: fakeDeepenFetch }));
    assert.notEqual(code, 0, 'a repair that never moves the boundary must abort non-zero');
    assert.equal(isShallow(s), true, 'the repo must remain genuinely shallow');
    const joined = errLines.join('\n');
    assert.match(joined, /wedged/i, `the abort must name itself as wedged; got: ${joined}`);
    assert.doesNotMatch(
      joined,
      /raise the bound/i,
      `the retired "raise the bound" remediation must not reappear; got: ${joined}`,
    );
  } finally {
    s.cleanup();
  }
});

// S5: a budget exhaustion after REAL progress is a rerun, not a dead end. The clock is
// injected (a fake counter, never a real timer) so the test does not wait out the real
// 540s default budget.
test('injected fake: rounds make progress until the injected clock passes the total budget → PARTIAL, exit 1', () => {
  const s = makeShallowRepo();
  const shallowPath = join(s.work.dir, '.git', 'shallow');
  try {
    let call = 0;
    const fakeDeepenFetch = () => {
      call++;
      // Every round "completes" and moves the boundary (distinct content each time), so
      // rounds keep counting as progress right up until the budget runs out.
      writeFileSync(shallowPath, `deadbeef${call.toString().padStart(32, '0')}\n`);
    };
    // Advances by 200_000ms on every call — three calls exceed the 540_000ms default
    // total budget after two rounds have completed.
    let t = 0;
    const fakeNow = () => {
      const v = t;
      t += 200_000;
      return v;
    };
    const [code, errLines] = captureErr(() =>
      run(s, { deepenFetch: fakeDeepenFetch, now: fakeNow }),
    );
    assert.equal(code, 1, 'a budget exhaustion must still be a non-zero exit');
    const joined = errLines.join('\n');
    assert.match(joined, /PARTIAL/, `must print the PARTIAL line; got: ${joined}`);
    assert.match(
      joined,
      new RegExp(String(DEEPEN_TOTAL_BUDGET_MS)),
      `the exhausted budget (ms) must appear in the message; got: ${joined}`,
    );
    assert.match(joined, /rerun/i, `must tell the drain to rerun; got: ${joined}`);
    assert.equal(isShallow(s), true, 'a PARTIAL repair must leave the clone genuinely shallow');
    assert.equal(call, 2, 'exactly two rounds must have run before the budget ran out');
  } finally {
    s.cleanup();
  }
});

// plan 4189 review round 1: the S4 closer path must not throw away banked progress. When
// earlier rounds MOVED the boundary and the closer then cannot finish (no budget left, or
// the closer itself times out), the output is the rerun-safe `PARTIAL —` line the drain
// prompt reruns on — never a terminal ABORT that stops a firing a rerun would have saved.
test('closer path: progress banked, then a no-progress round leaves no budget → PARTIAL, not a wedged abort', () => {
  const s = makeShallowRepo();
  const shallowPath = join(s.work.dir, '.git', 'shallow');
  try {
    let call = 0;
    const fakeDeepenFetch = () => {
      call++;
      // Round 1 moves the boundary; round 2 completes without moving it.
      if (call === 1) writeFileSync(shallowPath, `deadbeef${'1'.padStart(32, '0')}\n`);
    };
    // 0 (start), 0 (round 1 budget), 300_000 (round 2 budget), 600_000 (closer budget).
    const ticks = [0, 0, 300_000, 600_000];
    const fakeNow = () => ticks.shift() ?? 600_000;
    const [code, errLines] = captureErr(() =>
      run(s, { deepenFetch: fakeDeepenFetch, now: fakeNow }),
    );
    assert.equal(code, 1);
    const joined = errLines.join('\n');
    assert.match(
      joined,
      /^cloud-checkout-preflight: PARTIAL —/m,
      `must print PARTIAL; got: ${joined}`,
    );
    assert.doesNotMatch(joined, /ABORT/, `must not print a terminal ABORT; got: ${joined}`);
    assert.equal(call, 2, 'the closer must not run with no budget left');
  } finally {
    s.cleanup();
  }
});

test('closer path: progress banked, then the closing --unshallow TIMES OUT → PARTIAL', () => {
  const s = makeShallowRepo();
  const shallowPath = join(s.work.dir, '.git', 'shallow');
  try {
    const calls = [];
    const fakeDeepenFetch = (depthOrUnshallow) => {
      calls.push(depthOrUnshallow);
      if (depthOrUnshallow === 'unshallow') {
        const e = new Error('simulated closer timeout');
        e.code = 'ETIMEDOUT';
        throw e;
      }
      if (calls.length === 1) writeFileSync(shallowPath, `deadbeef${'1'.padStart(32, '0')}\n`);
    };
    const [code, errLines] = captureErr(() =>
      run(s, { deepenFetch: fakeDeepenFetch, now: () => 0 }),
    );
    assert.equal(code, 1);
    assert.deepEqual(calls, [DEEPEN_START, DEEPEN_START * 2, 'unshallow']);
    const joined = errLines.join('\n');
    assert.match(
      joined,
      /^cloud-checkout-preflight: PARTIAL —/m,
      `must print PARTIAL; got: ${joined}`,
    );
    assert.doesNotMatch(joined, /ABORT/, `must not print a terminal ABORT; got: ${joined}`);
  } finally {
    s.cleanup();
  }
});

test('closer path: NO progress, the closing --unshallow TIMES OUT → a timeout-named abort, not the generic rejected-fetch line', () => {
  const s = makeShallowRepo();
  try {
    const fakeDeepenFetch = (depthOrUnshallow) => {
      if (depthOrUnshallow === 'unshallow') {
        const e = new Error('simulated closer timeout');
        e.code = 'ETIMEDOUT';
        throw e;
      }
    };
    const [code, errLines] = captureErr(() =>
      run(s, { deepenFetch: fakeDeepenFetch, now: () => 0 }),
    );
    assert.equal(code, 1);
    const joined = errLines.join('\n');
    assert.match(
      joined,
      /ABORT — shallow-clone repair TIMED OUT/,
      `timeout must be named; got: ${joined}`,
    );
    assert.doesNotMatch(joined, /PARTIAL/, 'no progress was banked, so this is not a rerun case');
    assert.doesNotMatch(joined, /repair failed \(cause/, 'must not read as a rejected fetch');
  } finally {
    s.cleanup();
  }
});

// plan 4189: a genuinely wedged network must still cascade through the halve-on-timeout
// retries (S2) down to the floor depth and abort there with its OWN "TIMED OUT ... floor"
// cause line — never the generic rejected-fetch message, and never silently retried
// forever. A FAKE clock that never advances is the deliberate seam here: it keeps the
// loop's BUDGET bookkeeping reading "plenty left" every round (so each round's REAL
// execFileSync timeout bound stays at the injected total budget instead of shrinking to
// ~0 after the first real wait), while every fetch attempt is still a genuine,
// un-injected `git fetch --deepen`/`--unshallow` against the wedged server below — this
// is what proves execFileSync's own ETIMEDOUT still propagates correctly through the
// default seam after plan 4189's rewrite, the same platform-specific behaviour plan 3274
// verified empirically.
test('a WEDGED shallow-clone repair cascades to the floor depth and TIMES OUT loudly there (not a generic fetch failure)', async () => {
  const s = makeShallowRepo();
  // A raw TCP server that accepts the connection but never speaks the git protocol back —
  // this makes `git fetch` hang exactly like a wedged cloud-sandbox proxy would, without
  // an actual multi-minute wait. Verified empirically (plan 3274): Node's execFileSync
  // `timeout` option reliably kills a hung child and reports `error.code === 'ETIMEDOUT'`
  // cross-platform.
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    s.work.g('config', 'remote.origin.url', `git://127.0.0.1:${port}/x`);
    const roundBudgetMs = 600; // real per-round wait; ~7 rounds to cascade to the floor
    const fakeNow = () => 0; // never advances — see comment above
    const start = Date.now();
    const [code, errLines] = captureErr(() =>
      run(s, {
        env: { ...CLOUD_ENV, [UNSHALLOW_TIMEOUT_ENV]: String(roundBudgetMs) },
        now: fakeNow,
      }),
    );
    const elapsed = Date.now() - start;
    assert.equal(code, 1, 'a wedged fetch must abort non-zero, same as any other repair failure');
    assert.ok(
      // ambient-load-ok: hang backstop, not a tuned figure — the exit code above and the
      // /TIMED OUT/ cause match below already prove the timeout path ran; 15s sits well
      // above the ~7 real rounds this cascade needs, so it can only catch a regression
      // that stops bounding the fetch at all (the fixture's server never closes, so an
      // unbounded fetch hangs forever).
      elapsed < 15_000,
      `must abort after a few real ${roundBudgetMs}ms rounds, not hang until the fixture's server closes; took ${elapsed}ms`,
    );
    const joined = errLines.join('\n');
    assert.match(joined, /TIMED OUT/i, `cause must name the timeout; got: ${joined}`);
    assert.match(
      joined,
      new RegExp(`floor depth \\(${DEEPEN_FLOOR} commits\\)`),
      `the abort must be at the floor depth; got: ${joined}`,
    );
    assert.ok(
      !joined.includes('ABORT — shallow-clone repair failed (cause: git fetch --deepen origin).'),
      `a timeout must NOT be reported via the generic rejected-fetch message; got: ${joined}`,
    );
    assert.equal(
      isShallow(s),
      true,
      'a timed-out repair must leave the clone shallow, not corrupt it',
    );
  } finally {
    server.close();
    s.cleanup();
  }
});

test('the four disposability guards still refuse a shallow checkout — shallow bypasses none of them', () => {
  const s = makeShallowRepo();
  try {
    // Guard 1: missing opt-in flag.
    let [code] = captureErr(() => run(s, { argv: [] }));
    assert.equal(code, 2, 'guard 1 (opt-in flag) must still refuse when shallow');
    // Guard 3: denylisted local host.
    [code] = captureErr(() =>
      run(s, { host: FIXTURE_DENYLIST[0], localHostDenylist: FIXTURE_DENYLIST }),
    );
    assert.equal(code, 2, 'guard 3 (host denylist) must still refuse when shallow');
    // Neither refusal may have touched the shallow state or pushed anything.
    assert.equal(isShallow(s), true, 'a guard refusal must not repair the shallow clone');
    assert.ok(!s.lsOrigin().includes('backup/'));
  } finally {
    s.cleanup();
  }
});

test("readLocalHostDenylist (main default) reads localHostDenylist straight off dir's own coord.config.json", () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-preflight-denylist-'));
  try {
    writeFileSync(
      join(dir, 'coord.config.json'),
      JSON.stringify({ localHostDenylist: ['SOME-HOST'] }),
    );
    execFileSync('git', ['init', '-q', '-b', 'master', dir]);
    const code = main({ argv: OK_ARGS, dir, host: 'SOME-HOST', env: CLOUD_ENV });
    assert.equal(code, 2, "a host named in dir's own coord.config.json must be refused by default");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 4071 review round 1: readLocalHostDenylist used to return config entries UNCHANGED
// while the guard compared against `String(host).toUpperCase()`, so a lowercase config entry
// (a perfectly valid way to spell a hostname) never matched and the local-machine refusal was
// silently skipped. This exercises the real `dir`-read path (not the injectable param), since
// that is the shape a real operator machine hits.
test("readLocalHostDenylist (main default) matches regardless of the CONFIG entry's case", () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-preflight-denylist-case-'));
  try {
    writeFileSync(
      join(dir, 'coord.config.json'),
      JSON.stringify({ localHostDenylist: ['some-host'] }),
    );
    execFileSync('git', ['init', '-q', '-b', 'master', dir]);
    const code = main({ argv: OK_ARGS, dir, host: 'SOME-HOST', env: CLOUD_ENV });
    assert.equal(
      code,
      2,
      'a lowercase config entry must still refuse an uppercase host, not just the reverse',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The guard's own dir-read (readLocalHostDenylist) and coord-config.mjs's normalizeConfig are
// two INDEPENDENT parses of the same coord.config.json key (this file cannot import
// coord-config.mjs — see the no-coord-config-import rule in its header). Both must now
// uppercase a mixed-case config entry the same way, so a host this guard refuses is also the
// host coord-config.mjs's other consumers (landing-queue-board.mjs's originLabel) would
// classify as local — never one classifying local while the other reads cloud.
test("the dir-read guard and coord-config.mjs's normalizer agree on a mixed-case entry (plan 4071 review round 1)", () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-preflight-denylist-agree-'));
  try {
    writeFileSync(
      join(dir, 'coord.config.json'),
      JSON.stringify({ localHostDenylist: ['Mixed-Case-Host'] }),
    );
    execFileSync('git', ['init', '-q', '-b', 'master', dir]);
    assert.deepEqual(
      loadCoordConfig(dir).localHostDenylist,
      ['MIXED-CASE-HOST'],
      "coord-config.mjs's normalizer must uppercase the entry",
    );
    const code = main({ argv: OK_ARGS, dir, host: 'Mixed-Case-Host', env: CLOUD_ENV });
    assert.equal(
      code,
      2,
      "the guard's own dir-read must refuse the same host coord-config.mjs classifies as local",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 4071 review round 2 (key 94827c): readLocalHostDenylist used to uppercase a config
// entry but never trim it, so a padded entry (a paste artifact, e.g. `" BUILD-HOST-01"`)
// silently never matched and the local-machine refusal was skipped.
test('readLocalHostDenylist (main default) matches a config entry padded with whitespace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-preflight-denylist-padded-'));
  try {
    writeFileSync(
      join(dir, 'coord.config.json'),
      JSON.stringify({ localHostDenylist: [' SOME-HOST ', '\tOTHER-HOST\n'] }),
    );
    execFileSync('git', ['init', '-q', '-b', 'master', dir]);
    const code = main({ argv: OK_ARGS, dir, host: 'SOME-HOST', env: CLOUD_ENV });
    assert.equal(code, 2, 'a padded config entry must still refuse the bare hostname it names');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 4071 review round 3 (key 30957d): a non-string entry (e.g. `[123]`) used to be
// silently FILTERED OUT by a `.filter((h) => typeof h === 'string')` step rather than
// rejected, so a malformed config like `{"localHostDenylist":[123]}` collapsed to `[]` -- an
// empty denylist that, combined with guard 2's cloud signal and the destructive opt-in, let
// the local-master discard guard's guard 3 skip its refusal entirely on the operator's own
// machine. readLocalHostDenylist is invoked as `main`'s default-parameter expression, so the
// throw surfaces from the `main()` call itself before any other guard runs.
test('readLocalHostDenylist (main default) throws on a non-string config entry instead of silently dropping it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-preflight-denylist-nonstring-'));
  try {
    writeFileSync(join(dir, 'coord.config.json'), JSON.stringify({ localHostDenylist: [123] }));
    execFileSync('git', ['init', '-q', '-b', 'master', dir]);
    assert.throws(
      () => main({ argv: OK_ARGS, dir, host: 'ANY-HOST-AT-ALL', env: CLOUD_ENV }),
      /localHostDenylist has a non-string entry/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A whitespace-only entry must be DROPPED, not kept as `''` -- an empty string entry would
// never literal-match a real host anyway (the comparison is `String(host).toUpperCase() ===
// entry`), but the drop is the belt-and-suspenders: nothing about this list may ever be
// mistaken for "matches everything". Uses the full makeRepo()/advanceOrigin() fixture (like
// the empty-list test below) rather than a bare git-init'd dir, because a pass through guard
// 3 must reach the real repair (code 0) — which needs an origin to fetch from — to prove the
// entry was truly dropped rather than merely not yet exercised.
test('readLocalHostDenylist (main default) drops a whitespace-only config entry rather than treating it as matching every host', () => {
  const s = makeRepo();
  try {
    addLocalCommit(s);
    advanceOrigin(s);
    writeFileSync(
      join(s.work.dir, 'coord.config.json'),
      JSON.stringify({ localHostDenylist: ['   '] }),
    );
    const before = sha(s);
    const code = main({ argv: OK_ARGS, dir: s.work.dir, host: 'ANY-HOST-AT-ALL', env: CLOUD_ENV });
    assert.equal(
      code,
      0,
      'a whitespace-only denylist entry must not refuse guard 3 for an unrelated host',
    );
    assert.notEqual(sha(s), before, 'guard 3 passing must let the repair actually run');
  } finally {
    s.cleanup();
  }
});

test('the empty-list default-deny survives case normalization (an empty localHostDenylist still classifies every host as cloud)', () => {
  const s = makeRepo();
  try {
    addLocalCommit(s);
    advanceOrigin(s);
    const before = sha(s);
    const code = run(s, { host: 'ANY-HOST-AT-ALL', localHostDenylist: [] });
    assert.equal(code, 0, 'an empty denylist must never refuse guard 3 for any host');
    assert.notEqual(sha(s), before, 'guard 3 passing must let the repair actually run');
  } finally {
    s.cleanup();
  }
});
