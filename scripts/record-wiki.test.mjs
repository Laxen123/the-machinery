// scripts/record-wiki.test.mjs (plan 1074)
// record-wiki.mjs writes the WIKI_CHECKPOINT decision marker into the worktree's
// handoff session entry. These tests mirror record-review.test.mjs: commitWikiMarker
// short-circuits an idempotent re-run, routes add+commit through the lock-retry layer
// + pushes on a real change, and the CLI rejects a bad decision / a reasonless SKIP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitWikiMarker } from './record-wiki.mjs';

for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'record-wiki.mjs');
const SF = 'handoff/sessions/2026-06-26-session-1074.md';

function makeRepoWithSession(content) {
  const dir = mkdtempSync(join(tmpdir(), 'record-wiki-test-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  mkdirSync(dirname(join(dir, SF)), { recursive: true });
  writeFileSync(join(dir, SF), content);
  g('add', '-A');
  g('commit', '-qm', 'init session');
  return { dir, g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('commitWikiMarker: routes add+commit through lock-retry and pushes on a real change', () => {
  const r = makeRepoWithSession('session entry\n');
  try {
    writeFileSync(join(r.dir, SF), 'session entry\nWiki: SKIP:infra plan @ deadbeef0\n');
    const calls = [];
    const _gitRetry = (dir, args) => {
      calls.push(args[0]);
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    };
    let pushed = false;
    const res = commitWikiMarker(r.dir, SF, {
      slug: '1074-plan',
      decision: 'SKIP',
      detail: 'infra plan',
      sha: 'deadbeef00000000',
      _gitRetry,
      _push: () => {
        pushed = true;
      },
    });
    assert.deepEqual(calls, ['add', 'commit']);
    assert.equal(pushed, true);
    assert.equal(res.noop, false);
    assert.match(
      r.g('log', '-1', '--format=%s'),
      /chore\(wiki\): record SKIP @ deadbeef0 for 1074-plan \(infra plan\)/,
    );
    assert.equal(r.g('status', '--porcelain').trim(), '');
  } finally {
    r.cleanup();
  }
});

test('commitWikiMarker: idempotent re-run short-circuits to a no-op (unchanged entry)', () => {
  const r = makeRepoWithSession('session entry\nWiki: WROTE:evidensia.md @ abcdef012\n');
  try {
    const before = r.g('rev-parse', 'HEAD').trim();
    const res = commitWikiMarker(r.dir, SF, {
      slug: '1074-plan',
      decision: 'WROTE',
      detail: 'evidensia.md',
      sha: 'abcdef0123456789',
      noPush: true,
    });
    assert.equal(res.noop, true);
    assert.equal(r.g('rev-parse', 'HEAD').trim(), before);
  } finally {
    r.cleanup();
  }
});

test('CLI: a bad decision exits 2 before any git', () => {
  const r = spawnSync(process.execPath, [CLI, 'MAYBE'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /WROTE \| SKIP/);
});

test('CLI: SKIP without a reason exits 2 (the skip must be logged honestly)', () => {
  const r = spawnSync(process.execPath, [CLI, 'SKIP'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /SKIP requires a reason/);
});

// plan 1105 — record-wiki carried the identical --slug-from-MAIN footgun as record-review and now
// shares the same checkRecordBranch guard. A real repo + linked worktree on worktree-<slug> (HEAD
// diverged from master); running record-wiki from the MAIN checkout with --slug must REFUSE (exit 2)
// before writing/committing anything, instead of pinning master's tip.
test('CLI: record-wiki --slug from the MAIN checkout refuses (exit 2) and records nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'record-wiki-wt-'));
  const g = (dir, ...a) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=', ...a],
      { encoding: 'utf8' },
    ).trim();
  try {
    const mainDir = join(root, 'main');
    execFileSync('git', ['init', '-q', '-b', 'master', mainDir], { stdio: 'ignore' });
    writeFileSync(join(mainDir, 'f.txt'), 'a\n');
    // sessions layout so record-wiki reaches the worktree refuse guard (a single-file repo no-ops first)
    writeFileSync(
      join(mainDir, 'coord.config.json'),
      '{"handoffLayout":"sessions","handoffDir":"docs/handoff"}\n',
    );
    g(mainDir, 'add', 'f.txt', 'coord.config.json');
    g(mainDir, 'commit', '-qm', 'init');
    const wtDir = join(root, 'wt');
    g(mainDir, 'worktree', 'add', '-q', wtDir, '-b', 'worktree-plan-w');
    writeFileSync(join(wtDir, 'g.txt'), 'b\n');
    g(wtDir, 'add', 'g.txt');
    g(wtDir, 'commit', '-qm', 'branch work');
    const masterHead = g(mainDir, 'rev-parse', 'master');

    const r = spawnSync(
      process.execPath,
      [CLI, 'WROTE', 'some page', '--slug', 'plan-w', '--no-push'],
      { cwd: mainDir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: '' } },
    );
    assert.equal(r.status, 2, 'refusal is a usage error → exit 2');
    assert.match(r.stderr, /worktree-plan-w/, 'names the worktree branch to record from');
    assert.equal(
      g(mainDir, 'rev-parse', 'HEAD'),
      masterHead,
      'master HEAD unchanged — refused before any commit',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── plan 1312 / F-001 (2026-07-02 coord-scripts audit) ────────────────────────────────────
// record-wiki was the last MAIN-direct pushMasterWithRebase holdout: its default path committed
// the marker into the shared MAIN checkout and rebased it, so a mid-flight kill left MAIN detached
// and froze every other coord tool until heal-main. The fix routes the DEFAULT path through the
// disposable coord-checkout (withCoordCheckout + coordWrite), exactly like record-review (plan 1286).
// These two mirror record-review.test.mjs's plan-1286 tests: origin-backed harness, routed default.

function runRW(cwd, args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, COORD_MAIN_DIR: '' },
  });
}

function makeOriginWikiRepo(slug) {
  const root = mkdtempSync(join(tmpdir(), 'record-wiki-routed-'));
  const g = (dir, ...a) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=', ...a],
      { encoding: 'utf8' },
    ).trim();
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  const mainDir = join(root, 'main');
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, mainDir], {
    stdio: 'ignore',
  });
  writeFileSync(
    join(mainDir, 'coord.config.json'),
    '{"handoffLayout":"sessions","handoffDir":"docs/handoff"}\n',
  );
  writeFileSync(join(mainDir, '.gitignore'), '.claude/\n');
  const sf = `docs/handoff/sessions/2026-07-02-session-1312.md`;
  mkdirSync(dirname(join(mainDir, sf)), { recursive: true });
  writeFileSync(join(mainDir, sf), `# session\n\nclaim: ${slug}\n`);
  g(mainDir, 'add', '-A');
  g(mainDir, 'commit', '-qm', 'init main + session');
  g(mainDir, 'push', '-q', 'origin', 'master');
  const wtDir = join(root, 'wt');
  g(mainDir, 'worktree', 'add', '-q', wtDir, '-b', `worktree-${slug}`);
  writeFileSync(join(wtDir, 'g.txt'), 'b\n');
  g(wtDir, 'add', 'g.txt');
  g(wtDir, 'commit', '-qm', 'branch work');
  return {
    root,
    origin,
    mainDir,
    wtDir,
    sf,
    g,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('plan 1312 / F-001: routed record-wiki lands the marker on ORIGIN via the coord-checkout — MAIN gets no commit and stays attached', () => {
  const r = makeOriginWikiRepo('plan-routed-wiki');
  try {
    const mainTipBefore = r.g(r.mainDir, 'rev-parse', 'master');
    runRW(r.wtDir, ['WROTE', 'evidensia.md']); // NO --no-push → the routed default path
    // marker commit is on origin, carrying the coordWrite trailer
    const msg = r.g(r.mainDir, 'log', '-1', '--format=%B', 'origin/master');
    assert.match(msg, /chore\(wiki\): record WROTE @/);
    assert.match(msg, /Coord-Write: record-wiki/);
    const originSf = r.g(r.mainDir, 'show', `origin/master:${r.sf}`);
    assert.match(originSf, /Wiki: WROTE:evidensia\.md @ /);
    // MAIN: no local commit, working tree untouched, HEAD still attached to master (the whole point)
    assert.equal(r.g(r.mainDir, 'rev-parse', 'master'), mainTipBefore, 'no commit on MAIN');
    assert.equal(r.g(r.mainDir, 'symbolic-ref', 'HEAD'), 'refs/heads/master');
    assert.ok(
      !readFileSync(join(r.mainDir, r.sf), 'utf8').includes('Wiki: WROTE'),
      "MAIN's working copy was not written — origin is the source of truth",
    );
  } finally {
    r.cleanup();
  }
});

test('plan 1312 / F-001: a REJECTED push leaves no committed-but-unpushed wiki marker anywhere (atomic marker+push)', () => {
  const r = makeOriginWikiRepo('plan-atomic-wiki');
  try {
    // Server-side reject: a pre-receive hook that refuses every push.
    mkdirSync(join(r.origin, 'hooks'), { recursive: true });
    writeFileSync(join(r.origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho rejected >&2\nexit 1\n');
    // POSIX git skips a non-executable hook (git-for-Windows ignores the exec bit),
    // so without this the reject never fires on Linux CI and the push spuriously
    // succeeds — masking the atomicity assertion (plan 1456).
    chmodSync(join(r.origin, 'hooks', 'pre-receive'), 0o755);
    const mainTipBefore = r.g(r.mainDir, 'rev-parse', 'master');
    const originTipBefore = r.g(r.mainDir, 'rev-parse', 'origin/master');
    assert.throws(
      () => runRW(r.wtDir, ['WROTE', 'evidensia.md']),
      /./,
      'the failed push must surface (exit != 0)',
    );
    // NOTHING landed and NOTHING is committed-but-unpushed: origin unchanged, MAIN unchanged.
    r.g(r.mainDir, 'fetch', '-q', 'origin', 'master');
    assert.equal(r.g(r.mainDir, 'rev-parse', 'origin/master'), originTipBefore);
    assert.equal(r.g(r.mainDir, 'rev-parse', 'master'), mainTipBefore);
    assert.equal(r.g(r.mainDir, 'symbolic-ref', 'HEAD'), 'refs/heads/master');
    assert.equal(
      r.g(r.mainDir, 'status', '--porcelain', '--untracked-files=no'),
      '',
      'no marker residue in MAIN',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 1528 A1: repin — the record-wiki twin of record-review repin ──────

test('plan 2743: a dual-pinned wiki marker survives a pure rebase with no re-pin; rework refuses exit 4', () => {
  const slug = 'wiki-repin-fixture';
  const root = mkdtempSync(join(tmpdir(), 'record-wiki-repin-'));
  const g = (dir, ...a) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=', ...a],
      { encoding: 'utf8' },
    ).trim();
  try {
    const bare = join(root, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'ignore' });
    const mainDir = join(root, 'main');
    execFileSync('git', ['init', '-q', '-b', 'master', mainDir], { stdio: 'ignore' });
    writeFileSync(
      join(mainDir, 'coord.config.json'),
      '{"handoffLayout":"sessions","handoffDir":"docs/handoff"}\n',
    );
    const sf = 'docs/handoff/sessions/2026-07-09-session-2.md';
    mkdirSync(dirname(join(mainDir, sf)), { recursive: true });
    writeFileSync(join(mainDir, sf), `# Session 2\n\nClaimed ${slug}.\n`);
    writeFileSync(join(mainDir, 'shared.txt'), 'line\n');
    g(mainDir, 'add', '-A');
    g(mainDir, 'commit', '-qm', 'init');
    g(mainDir, 'remote', 'add', 'origin', bare);
    g(mainDir, 'push', '-qu', 'origin', 'master');
    const wtDir = join(root, 'wt');
    g(mainDir, 'worktree', 'add', '-q', wtDir, '-b', `worktree-${slug}`);
    writeFileSync(join(wtDir, 'feature.txt'), 'work\n');
    g(wtDir, 'add', 'feature.txt');
    g(wtDir, 'commit', '-qm', 'branch work');

    const env = { ...process.env, COORD_MAIN_DIR: '' };
    execFileSync('node', [CLI, 'WROTE', 'price-inspector page', '--no-push'], {
      cwd: wtDir,
      encoding: 'utf8',
      env,
    });
    const shaBefore = g(wtDir, 'rev-parse', 'HEAD');
    assert.match(
      readFileSync(join(mainDir, sf), 'utf8'),
      new RegExp(`Wiki: WROTE:price-inspector page @ ${shaBefore}`),
    );

    // master advances disjointly; branch rebases → stale marker, identical patch-id
    writeFileSync(join(mainDir, 'shared.txt'), 'line\nmore\n');
    g(mainDir, 'add', 'shared.txt');
    g(mainDir, 'commit', '-qm', 'sibling');
    g(mainDir, 'push', '-q', 'origin', 'master');
    g(wtDir, 'fetch', '-q', 'origin', 'master');
    g(wtDir, 'rebase', '-q', 'origin/master');
    const shaAfter = g(wtDir, 'rev-parse', 'HEAD');

    const out = execFileSync('node', [CLI, 'repin', '--no-push'], {
      cwd: wtDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    // plan 2743: recorded dual-pinned, and the rebase was patch-id-identical — the marker is
    // still valid at the rebased tip, so no re-pin (and no master commit) is emitted.
    assert.match(out, /no re-pin needed/);
    const doc = readFileSync(join(mainDir, sf), 'utf8');
    assert.match(
      doc,
      new RegExp(`Wiki: WROTE:price-inspector page @ ${shaBefore} patch-id:[0-9a-f]+`),
      'decision AND detail stay put, carried by the rebase-stable identity',
    );
    assert.ok(!doc.includes(shaAfter), 'nothing rewritten');

    // rework refuses exit 4
    writeFileSync(join(wtDir, 'feature.txt'), 'work\nreworked\n');
    g(wtDir, 'add', 'feature.txt');
    g(wtDir, 'commit', '-qm', 'rework');
    let code = 0;
    try {
      execFileSync('node', [CLI, 'repin', '--no-push'], {
        cwd: wtDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (e) {
      code = e.status;
    }
    assert.equal(code, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
