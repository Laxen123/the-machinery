// scripts/pre-yield-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  stamp,
  isDirty,
  guard,
  coordDirt,
  dirtyPaths,
  partitionJobOutput,
  dirtAgeMs,
  hasRiskyChange,
  staleArchiveDuplicatePaths,
  commitSafeStageFolderOk,
  hasRealDirt,
  isEmptyStash,
  dropIfEmptyStash,
  budgetShortfall,
  STASH_RESERVE_MS,
} from './pre-yield-guard.mjs';
import { isJobOutput, jobOutputStashExcludesFor } from './main-checkout-allowlist.mjs';

// plan 3962 P1: JOB_OUTPUT_PREFIXES is no longer a module-load constant (the leaf module
// takes the list from a caller resolving coord.config.json) — this suite exercises the
// same vetapp prefix loadCoordConfig(repoRoot).jobOutputPrefixes reads off THIS repo's own
// coord.config.json, mirrored here as a literal so the fixture repos below (which are not
// vetapp checkouts) don't need a config file of their own.
const TEST_JOB_OUTPUT_PREFIXES = ['backend/data/price-pipeline/'];
import { nulBytes as nul } from './corruption-guard.mjs';
import { TRUNCATED_INDEX_HEAD_FLOOR } from './index-sanity.mjs';
import { makeLargeRepo as buildLargeRepo, tornIndex } from '../test-helpers/torn-index-repo.mjs';

// plan 338: clear inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE so the temp-repo
// helpers below honour `git -C <tmpdir>` even when this suite runs inside a git
// hook (which exports those vars and would otherwise redirect git ops onto the
// real repo — shared user.name corruption + junk commits, proven 2026-06-04).
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

test('stamp is filesystem-safe and stable for a fixed date', () => {
  const s = stamp(new Date('2026-05-30T12:34:56.789Z'));
  assert.equal(s, '2026-05-30-1234'); // YYYY-MM-DD-HHMM, no : or .
  assert.doesNotMatch(s, /[:.]/);
});

test('isDirty distinguishes clean from dirty porcelain', () => {
  assert.equal(isDirty(''), false);
  assert.equal(isDirty('\n'), false);
  assert.equal(isDirty(' M file.txt\n'), true);
  assert.equal(isDirty('?? new.txt'), true);
});

test('isJobOutput recognises only the live pipeline data root', () => {
  assert.equal(
    isJobOutput('backend/data/price-pipeline/batches/x/state.json', TEST_JOB_OUTPUT_PREFIXES),
    true,
  );
  assert.equal(
    isJobOutput(
      'backend\\data\\price-pipeline\\render-store\\x\\_meta.json',
      TEST_JOB_OUTPUT_PREFIXES,
    ),
    true,
  );
  assert.equal(isJobOutput('backend/scripts/price-pipeline/x.py', TEST_JOB_OUTPUT_PREFIXES), false);
});

test('job-output matching and stash exclusions derive from every shared prefix', () => {
  assert.deepEqual(
    jobOutputStashExcludesFor(TEST_JOB_OUTPUT_PREFIXES),
    TEST_JOB_OUTPUT_PREFIXES.map((prefix) => `:(exclude)${prefix}`),
  );
  for (const prefix of TEST_JOB_OUTPUT_PREFIXES) {
    assert.equal(isJobOutput(`${prefix}derivation-probe`, TEST_JOB_OUTPUT_PREFIXES), true);
  }
});

// Fixture repos must round-trip file content byte-for-byte: several tests below write LF
// content, let git carry it through a commit or a stash/pop, then assert the exact bytes
// come back. Git for Windows ships `core.autocrlf=true` at SYSTEM level, which a fresh
// `git init` in tmpdir inherits — so `git stash pop` restores `\n` as `\r\n` and every such
// assertion fails on Windows while passing in the Linux cloud container. Pin the fixture to
// LF explicitly (both settings: `core.eol` alone is ignored while autocrlf is on).
function pinLf(g) {
  g('config', 'core.autocrlf', 'false');
  g('config', 'core.eol', 'lf');
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'preyield-test-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  pinLf(g);
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  // plan 3962 P1: jobOutputPrefixes now comes from THIS repo's coord.config.json (the
  // module is a pure zero-import leaf and no longer carries a hardcoded default) — commit
  // it here, tracked and clean, so every test below sees the same job-output partitioning
  // it relied on before without an extra dirty/untracked line contaminating status assertions.
  writeFileSync(
    join(dir, 'coord.config.json'),
    JSON.stringify({ jobOutputPrefixes: TEST_JOB_OUTPUT_PREFIXES }) + '\n',
  );
  g('add', 'f.txt', 'coord.config.json');
  g('commit', '-qm', 'init');
  return { dir, g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('guard is a no-op on a clean tree', () => {
  const r = makeRepo();
  try {
    const res = guard(r.dir, { slug: 'x', log: () => {} });
    assert.deepEqual(res, { protected: false, dirty: false });
  } finally {
    r.cleanup();
  }
});

test('guard parks dirty work in a named wip- stash (default)', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\nchanged\n');
    writeFileSync(join(r.dir, 'untracked.txt'), 'new\n');
    const res = guard(r.dir, {
      slug: 'plan-230',
      now: new Date('2026-05-30T09:15:00Z'),
      log: () => {},
    });
    assert.equal(res.protected, true);
    assert.equal(res.mode, 'stash');
    assert.match(res.label, /^wip-plan-230-2026/);
    // Tree is clean after stashing, and the stash carries the name + untracked file.
    assert.equal(isDirty(r.g('status', '--porcelain')), false);
    const stashes = r.g('stash', 'list', '--format=%gs');
    assert.match(stashes, /wip-plan-230-2026/);
    r.g('stash', 'pop');
    assert.match(r.g('status', '--porcelain'), /untracked\.txt/);
  } finally {
    r.cleanup();
  }
});

test('guard --commit lands a wip commit instead of stashing', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\ncommitted-wip\n');
    const res = guard(r.dir, {
      slug: 'plan-230',
      commit: true,
      now: new Date('2026-05-30T09:15:00Z'),
      log: () => {},
    });
    assert.equal(res.mode, 'commit');
    assert.equal(isDirty(r.g('status', '--porcelain')), false);
    assert.match(r.g('log', '-1', '--format=%s'), /^wip: plan-230 pre-yield 2026/);
  } finally {
    r.cleanup();
  }
});

test('guard --check reports dirt without changing anything (non-coord file)', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\ndirty\n');
    const res = guard(r.dir, { slug: 'x', check: true, log: () => {} });
    assert.deepEqual(res, {
      protected: false,
      dirty: true,
      coordDirty: false,
      coord: [],
      corrupted: [],
    });
    assert.equal(isDirty(r.g('status', '--porcelain')), true); // untouched
    assert.equal(r.g('stash', 'list'), '');
  } finally {
    r.cleanup();
  }
});

test('guard --check flags an uncommitted coordination-doc edit by name (plan 533 T3)', () => {
  const r = makeRepo();
  try {
    // A dirty plan body in $MAIN is the deferred-commit hazard — must be named.
    const rel = 'docs/superpowers/plans/in-progress/533-Infra-foo.md';
    mkdirSync(join(r.dir, 'docs/superpowers/plans/in-progress'), { recursive: true });
    writeFileSync(join(r.dir, rel), 'base\n');
    r.g('add', rel);
    r.g('commit', '-qm', 'add plan');
    writeFileSync(join(r.dir, rel), 'base\nedited\n');
    const lines = [];
    const res = guard(r.dir, { slug: 'x', check: true, log: (m) => lines.push(m) });
    assert.equal(res.coordDirty, true);
    assert.deepEqual(res.coord, [rel]);
    assert.ok(lines.join('\n').includes('edit-plan.mjs'), 'names the remedy tool');
    assert.ok(lines.join('\n').includes(rel), 'names the dirty coord file');
    assert.equal(r.g('stash', 'list'), ''); // --check changes nothing
  } finally {
    r.cleanup();
  }
});

test('coordDirt: classifies coordination vs ordinary paths', () => {
  const porcelain = [
    ' M docs/superpowers/plans/in-progress/533-Infra-foo.md',
    ' M src/app/page.tsx',
    '?? handoff/sessions/2026-06-11-session-9.md',
    ' M docs/INDEX.md',
    ' M handoff-board.md',
    ' M docs/runbooks/plans-workflow.md', // a runbook is NOT coordination state
  ].join('\n');
  assert.deepEqual(coordDirt(porcelain), [
    'docs/INDEX.md',
    'docs/superpowers/plans/in-progress/533-Infra-foo.md',
    'handoff-board.md',
    'handoff/sessions/2026-06-11-session-9.md',
  ]);
});

test('coordDirt: handles a renamed plan (both sides) and empty input', () => {
  assert.deepEqual(coordDirt(''), []);
  const renamed =
    'R  docs/superpowers/plans/ready/533-a.md -> docs/superpowers/plans/in-progress/533-a.md';
  assert.deepEqual(coordDirt(renamed), [
    'docs/superpowers/plans/in-progress/533-a.md',
    'docs/superpowers/plans/ready/533-a.md',
  ]);
});

// ── plan 977: dirtyPaths + dirtAgeMs helpers ──────────────────────────────────

test('dirtyPaths: distinct working-tree paths incl. both rename sides', () => {
  const porcelain = [
    ' M backend/src/a.ts',
    '?? .scratch/note.txt',
    'R  docs/superpowers/plans/ready/x.md -> docs/superpowers/plans/in-progress/x.md',
  ].join('\n');
  assert.deepEqual(dirtyPaths(porcelain), [
    '.scratch/note.txt',
    'backend/src/a.ts',
    'docs/superpowers/plans/in-progress/x.md',
    'docs/superpowers/plans/ready/x.md',
  ]);
});

test('dirtAgeMs: fresh file ≈ 0; injected future now ages it; all-deletions = Infinity', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\nchanged\n');
    const porcelain = r.g('status', '--porcelain');
    assert.ok(dirtAgeMs(r.dir, porcelain, new Date()) < 5000, 'just-written file is fresh');
    const future = new Date(Date.now() + 200_000);
    assert.ok(dirtAgeMs(r.dir, porcelain, future) >= 150_000, 'injected future now ages the dirt');
    // A pure deletion has no file on disk → treated as stale (Infinity).
    rmSync(join(r.dir, 'f.txt'));
    assert.equal(dirtAgeMs(r.dir, r.g('status', '--porcelain'), new Date()), Infinity);
  } finally {
    r.cleanup();
  }
});

test('dirtAgeMs: partitioned porcelain ignores a fresh pipeline write', () => {
  const r = makeRepo();
  try {
    const doc = 'docs/runbooks/x.md';
    const output = 'backend/data/price-pipeline/batches/x/state.json';
    mkdirSync(join(r.dir, 'docs/runbooks'), { recursive: true });
    mkdirSync(join(r.dir, 'backend/data/price-pipeline/batches/x'), { recursive: true });
    writeFileSync(join(r.dir, doc), 'base\n');
    writeFileSync(join(r.dir, 'backend/data/price-pipeline/.gitkeep'), 'tracked parent\n');
    r.g('add', doc, 'backend/data/price-pipeline/.gitkeep');
    r.g('commit', '-qm', 'seed paths');
    writeFileSync(join(r.dir, doc), 'old doc\n');
    writeFileSync(join(r.dir, output), 'live\n');
    const now = new Date();
    const tenMinutesAgo = new Date(now.getTime() - 600_000);
    const oneSecondAgo = new Date(now.getTime() - 1_000);
    utimesSync(join(r.dir, doc), tenMinutesAgo, tenMinutesAgo);
    utimesSync(join(r.dir, output), oneSecondAgo, oneSecondAgo);
    const { parkable } = partitionJobOutput(r.g('status', '--porcelain'), TEST_JOB_OUTPUT_PREFIXES);
    assert.ok(dirtAgeMs(r.dir, parkable, now) >= 590_000);
  } finally {
    r.cleanup();
  }
});

// ── plan 977: age gate ────────────────────────────────────────────────────────

test('guard age gate: dirt younger than the threshold is left alone (no stash/commit)', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\nfresh\n');
    const res = guard(r.dir, {
      slug: 'x',
      commitSafe: true,
      ageThresholdMs: 90_000,
      now: new Date(), // file just written → age ≈ 0 < 90s
      log: () => {},
    });
    assert.equal(res.skipped, 'too-fresh');
    assert.equal(isDirty(r.g('status', '--porcelain')), true, 'tree still dirty (untouched)');
    assert.equal(r.g('stash', 'list'), '', 'nothing stashed');
  } finally {
    r.cleanup();
  }
});

test('guard age gate: stale dirt (past threshold) IS acted on', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\nstale\n');
    const res = guard(r.dir, {
      slug: 'x',
      commitSafe: true, // code dirt → stash branch
      ageThresholdMs: 90_000,
      now: new Date(Date.now() + 200_000), // age ≈ 200s > 90s
      log: () => {},
    });
    assert.equal(res.mode, 'stash');
    assert.equal(isDirty(r.g('status', '--porcelain')), false, 'tree clean after stash');
  } finally {
    r.cleanup();
  }
});

test('guard age gate: a future-dated mtime (negative age) is NOT treated as too-fresh', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\nskewed\n');
    // now is 200s in the PAST relative to the just-written file → dirtAgeMs < 0
    const res = guard(r.dir, {
      slug: 'x',
      commitSafe: true, // code dirt → stash branch
      ageThresholdMs: 90_000,
      now: new Date(Date.now() - 200_000),
      log: () => {},
    });
    assert.notEqual(res.skipped, 'too-fresh', 'negative age must not skip parking');
    assert.equal(res.mode, 'stash', 'dirt is acted on, not left loose');
  } finally {
    r.cleanup();
  }
});

// ── plan 977: commitSafe (doc → commit+push; config/code/mixed → stash) ────────

// A repo wired to a bare origin so pushMasterWithRebase has somewhere to push.
function makeRepoWithRemote() {
  const bare = mkdtempSync(join(tmpdir(), 'preyield-origin-'));
  const dir = mkdtempSync(join(tmpdir(), 'preyield-clone-'));
  const gb = (...a) => execFileSync('git', ['-C', bare, ...a], { encoding: 'utf8' });
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  gb('init', '-q', '--bare', '-b', 'master');
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  pinLf(g);
  g('remote', 'add', 'origin', bare);
  mkdirSync(join(dir, 'docs/superpowers/plans/in-progress'), { recursive: true });
  writeFileSync(join(dir, 'docs/superpowers/plans/in-progress/977-x.md'), 'base\n');
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  // plan 3962 P1: see makeRepo()'s matching comment above.
  writeFileSync(
    join(dir, 'coord.config.json'),
    JSON.stringify({ jobOutputPrefixes: TEST_JOB_OUTPUT_PREFIXES }) + '\n',
  );
  g('add', '-A');
  g('commit', '-qm', 'init');
  g('push', '-q', '-u', 'origin', 'master');
  return {
    dir,
    g,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    },
  };
}

test('commitSafe: commits idle doc dirt while leaving untracked pipeline store files in place', () => {
  const r = makeRepoWithRemote();
  try {
    const doc = 'docs/superpowers/plans/in-progress/977-x.md';
    const store = 'backend/data/price-pipeline/render-store/clinic-1/playwright/abc';
    mkdirSync(join(r.dir, 'backend/data/price-pipeline'), { recursive: true });
    writeFileSync(join(r.dir, 'backend/data/price-pipeline/.gitkeep'), 'tracked parent\n');
    r.g('add', 'backend/data/price-pipeline/.gitkeep');
    r.g('commit', '-qm', 'seed pipeline parent');
    r.g('push', '-q', 'origin', 'master');
    mkdirSync(join(r.dir, store), { recursive: true });
    writeFileSync(join(r.dir, doc), 'base\nedited\n');
    writeFileSync(join(r.dir, store, '_meta.json'), '{}\n');
    writeFileSync(join(r.dir, store, 'html.html.gz'), 'compressed\n');

    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      ageThresholdMs: 0,
      now: new Date(),
      log: () => {},
    });

    assert.equal(res.mode, 'commit-safe');
    assert.ok(existsSync(join(r.dir, store, '_meta.json')));
    assert.ok(existsSync(join(r.dir, store, 'html.html.gz')));
    const status = r.g('status', '--porcelain');
    assert.match(status, /\?\? backend\/data\/price-pipeline\//);
    assert.doesNotMatch(status, /977-x\.md/);
    assert.equal(r.g('stash', 'list'), '');
  } finally {
    r.cleanup();
  }
});

test('commitSafe: pipeline-output-only dirt is left in place without a stash', () => {
  const r = makeRepoWithRemote();
  try {
    const store = 'backend/data/price-pipeline/render-store/clinic-1/playwright/abc';
    mkdirSync(join(r.dir, 'backend/data/price-pipeline'), { recursive: true });
    writeFileSync(join(r.dir, 'backend/data/price-pipeline/.gitkeep'), 'tracked parent\n');
    r.g('add', 'backend/data/price-pipeline/.gitkeep');
    r.g('commit', '-qm', 'seed pipeline parent');
    r.g('push', '-q', 'origin', 'master');
    mkdirSync(join(r.dir, store), { recursive: true });
    writeFileSync(join(r.dir, store, '_meta.json'), '{}\n');
    writeFileSync(join(r.dir, store, 'html.html.gz'), 'compressed\n');

    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      ageThresholdMs: 0,
      now: new Date(),
      log: () => {},
    });

    assert.equal(res.skipped, 'job-output-only');
    assert.match(r.g('status', '--porcelain'), /\?\? backend\/data\/price-pipeline\//);
    assert.equal(r.g('stash', 'list'), '');
  } finally {
    r.cleanup();
  }
});

test('stash mode: parks code dirt but leaves a tracked pipeline arm modification on disk', () => {
  const r = makeRepo();
  try {
    const arm = 'backend/data/price-pipeline/llm-runs/gpt-sol/clinic-1.json';
    const code = 'scripts/x.mjs';
    mkdirSync(join(r.dir, 'backend/data/price-pipeline/llm-runs/gpt-sol'), { recursive: true });
    mkdirSync(join(r.dir, 'scripts'), { recursive: true });
    writeFileSync(join(r.dir, arm), '{"base":true}\n');
    writeFileSync(join(r.dir, code), 'export const x = 1;\n');
    r.g('add', arm, code);
    r.g('commit', '-qm', 'seed arm and code');
    writeFileSync(join(r.dir, arm), '{"live":true}\n');
    writeFileSync(join(r.dir, code), 'export const x = 2;\n');

    const res = guard(r.dir, { slug: 'x', now: new Date(), log: () => {} });

    assert.equal(res.mode, 'stash');
    assert.equal(readFileSync(join(r.dir, arm), 'utf8'), '{"live":true}\n');
    assert.match(r.g('status', '--porcelain'), /backend\/data\/price-pipeline\/llm-runs/);
    const stashDiff = r.g('stash', 'show', '-p');
    assert.match(stashDiff, /scripts\/x\.mjs/);
    assert.doesNotMatch(stashDiff, /backend\/data\/price-pipeline/);
  } finally {
    r.cleanup();
  }
});

test('commitSafe: idle PURE-DOC dirt is committed + pushed to master', () => {
  const r = makeRepoWithRemote();
  try {
    writeFileSync(join(r.dir, 'docs/superpowers/plans/in-progress/977-x.md'), 'base\nedited\n');
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: () => {},
    });
    assert.equal(res.mode, 'commit-safe');
    assert.equal(isDirty(r.g('status', '--porcelain')), false, 'tree clean after commit');
    assert.equal(r.g('stash', 'list'), '', 'nothing stashed');
    // The commit landed on origin/master (push succeeded → remote-tracking ref moved).
    assert.equal(
      r.g('rev-parse', 'HEAD').trim(),
      r.g('rev-parse', 'origin/master').trim(),
      'HEAD == origin/master (pushed)',
    );
    assert.match(r.g('log', '-1', '--format=%s'), /^auto-heal: commit idle commit-safe dirt/);
  } finally {
    r.cleanup();
  }
});

test('commitSafe: CONFIG dirt (.claude/**) is STASHED, never auto-pushed', () => {
  const r = makeRepoWithRemote();
  try {
    mkdirSync(join(r.dir, '.claude'), { recursive: true });
    writeFileSync(join(r.dir, '.claude/settings.json'), '{"x":1}\n'); // untracked config
    const before = r.g('rev-parse', 'origin/master').trim();
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: () => {},
    });
    assert.equal(res.mode, 'stash');
    assert.equal(isDirty(r.g('status', '--porcelain')), false, 'tree clean after stash');
    assert.match(r.g('stash', 'list', '--format=%gs'), /wip-stop-hook-/);
    assert.equal(r.g('rev-parse', 'origin/master').trim(), before, 'origin/master NOT advanced');
  } finally {
    r.cleanup();
  }
});

test('commitSafe: a MIX of doc + code is STASHED (not all-doc → never auto-push)', () => {
  const r = makeRepoWithRemote();
  try {
    writeFileSync(join(r.dir, 'docs/superpowers/plans/in-progress/977-x.md'), 'base\nedited\n');
    writeFileSync(join(r.dir, 'f.txt'), 'base\ncode-change\n');
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: () => {},
    });
    assert.equal(res.mode, 'stash');
    assert.equal(isDirty(r.g('status', '--porcelain')), false, 'tree clean after stash');
  } finally {
    r.cleanup();
  }
});

test('commitSafe: a doc DELETION is STASHED, not auto-pushed (harder to undo on master)', () => {
  const r = makeRepoWithRemote();
  try {
    const before = r.g('rev-parse', 'origin/master').trim();
    rmSync(join(r.dir, 'docs/superpowers/plans/in-progress/977-x.md')); // delete a tracked doc
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: () => {},
    });
    assert.equal(res.mode, 'stash', 'deletion must stash, not commit-push');
    assert.equal(r.g('rev-parse', 'origin/master').trim(), before, 'origin/master NOT advanced');
    assert.equal(isDirty(r.g('status', '--porcelain')), false, 'tree clean after stash');
  } finally {
    r.cleanup();
  }
});

// settings.local.json is gitignored by default but TRACKED in vetapp, so a
// MODIFICATION shows in `git status` (gitignore never hides a tracked file). An
// untracked copy would be invisible to git on this machine (global excludesfile
// `**/.claude/settings.local.json`) — and that case needs no heal. So these tests
// seed the file TRACKED first via `git add -f`, mirroring the real repo.
test('commitSafe: idle .claude/settings.local.json is committed + pushed (not parked)', () => {
  const r = makeRepoWithRemote();
  try {
    mkdirSync(join(r.dir, '.claude'), { recursive: true });
    writeFileSync(join(r.dir, '.claude/settings.local.json'), '{"permissions":{"allow":[]}}\n');
    r.g('add', '-f', '.claude/settings.local.json'); // force past the global ignore
    r.g('commit', '-qm', 'track local settings');
    r.g('push', '-q', 'origin', 'master');
    writeFileSync(
      join(r.dir, '.claude/settings.local.json'),
      '{"permissions":{"allow":["Bash"]}}\n',
    ); // idle mod
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: () => {},
    });
    assert.equal(res.mode, 'commit-safe');
    assert.equal(isDirty(r.g('status', '--porcelain')), false, 'tree clean after commit');
    assert.equal(r.g('stash', 'list'), '', 'nothing stashed');
    assert.equal(
      r.g('rev-parse', 'HEAD').trim(),
      r.g('rev-parse', 'origin/master').trim(),
      'HEAD == origin/master (pushed)',
    );
  } finally {
    r.cleanup();
  }
});

test('commitSafe: settings.local.json MIXED with settings.json is STASHED (asymmetry)', () => {
  const r = makeRepoWithRemote();
  try {
    mkdirSync(join(r.dir, '.claude'), { recursive: true });
    writeFileSync(join(r.dir, '.claude/settings.local.json'), '{"x":1}\n');
    r.g('add', '-f', '.claude/settings.local.json');
    r.g('commit', '-qm', 'track local settings');
    r.g('push', '-q', 'origin', 'master');
    const before = r.g('rev-parse', 'origin/master').trim();
    writeFileSync(join(r.dir, '.claude/settings.local.json'), '{"x":2}\n'); // commit-safe (tracked mod)
    writeFileSync(join(r.dir, '.claude/settings.json'), '{"y":2}\n'); // NOT commit-safe (untracked)
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: () => {},
    });
    assert.equal(res.mode, 'stash', 'a non-commit-safe path in the mix forces a stash');
    assert.equal(r.g('rev-parse', 'origin/master').trim(), before, 'origin/master NOT advanced');
  } finally {
    r.cleanup();
  }
});

test('commitSafe: a MALFORMED settings.local.json is STASHED, not pushed (plan 1108)', () => {
  const r = makeRepoWithRemote();
  try {
    mkdirSync(join(r.dir, '.claude'), { recursive: true });
    writeFileSync(join(r.dir, '.claude/settings.local.json'), '{"valid":true}\n');
    r.g('add', '-f', '.claude/settings.local.json');
    r.g('commit', '-qm', 'track local settings');
    r.g('push', '-q', 'origin', 'master');
    const before = r.g('rev-parse', 'origin/master').trim();
    writeFileSync(join(r.dir, '.claude/settings.local.json'), '{ broken json not parseable'); // malformed
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: () => {},
    });
    assert.equal(res.mode, 'stash', 'malformed config must stash, not auto-push to shared master');
    assert.equal(r.g('rev-parse', 'origin/master').trim(), before, 'origin/master NOT advanced');
  } finally {
    r.cleanup();
  }
});

test('commitSafe: a doc + settings.local.json together are committed+pushed (all commit-safe)', () => {
  const r = makeRepoWithRemote();
  try {
    mkdirSync(join(r.dir, '.claude'), { recursive: true });
    writeFileSync(join(r.dir, '.claude/settings.local.json'), '{"a":1}\n');
    r.g('add', '-f', '.claude/settings.local.json');
    r.g('commit', '-qm', 'track local settings');
    r.g('push', '-q', 'origin', 'master');
    writeFileSync(join(r.dir, 'docs/superpowers/plans/in-progress/977-x.md'), 'base\nedited\n'); // doc
    writeFileSync(join(r.dir, '.claude/settings.local.json'), '{"a":2}\n'); // config — both commit-safe
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: () => {},
    });
    assert.equal(res.mode, 'commit-safe');
    assert.equal(isDirty(r.g('status', '--porcelain')), false, 'tree clean after commit');
    assert.equal(r.g('stash', 'list'), '', 'nothing stashed');
  } finally {
    r.cleanup();
  }
});

// ── plan 1634: NUL-corruption guard ─────────────────────────────────────────

test('commitSafe: a zero-filled tracked doc is excluded from the commit and left dirty', () => {
  const r = makeRepoWithRemote();
  try {
    writeFileSync(join(r.dir, 'docs/superpowers/plans/in-progress/other-doc.md'), 'seed\n');
    r.g('add', '-A');
    r.g('commit', '-qm', 'seed second doc');
    r.g('push', '-q', 'origin', 'master');

    writeFileSync(join(r.dir, 'docs/superpowers/plans/in-progress/other-doc.md'), 'seed\nedited\n'); // healthy edit
    writeFileSync(join(r.dir, 'docs/superpowers/plans/in-progress/977-x.md'), nul(4)); // corrupted
    const logs = [];
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: (m) => logs.push(m),
    });
    assert.equal(res.mode, 'commit-safe');
    r.g('fetch', '-q', 'origin', 'master');
    assert.equal(
      r.g('show', 'origin/master:docs/superpowers/plans/in-progress/977-x.md'),
      'base\n',
      'corrupted doc never committed/pushed',
    );
    assert.equal(
      r.g('show', 'origin/master:docs/superpowers/plans/in-progress/other-doc.md'),
      'seed\nedited\n',
      'the healthy edit DID land',
    );
    assert.match(r.g('status', '--porcelain'), /977-x\.md/, 'corrupted file still dirty on disk');
    assert.equal(r.g('stash', 'list'), '', 'nothing stashed');
    assert.ok(
      logs.some((m) => m.includes('corruption-guard') && m.includes('977-x.md')),
      'a corruption warning was logged',
    );
  } finally {
    r.cleanup();
  }
});

test('commitSafe: when the ONLY dirt is a corrupted doc, nothing is committed or stashed', () => {
  const r = makeRepoWithRemote();
  try {
    const before = r.g('rev-parse', 'origin/master').trim();
    writeFileSync(join(r.dir, 'docs/superpowers/plans/in-progress/977-x.md'), nul(4));
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: () => {},
    });
    assert.equal(res.mode, 'corrupted-only');
    assert.equal(r.g('rev-parse', 'origin/master').trim(), before, 'origin unchanged');
    assert.equal(r.g('stash', 'list'), '', 'nothing stashed — corrupted file left alone');
    assert.match(r.g('status', '--porcelain'), /977-x\.md/, 'corrupted file still dirty on disk');
  } finally {
    r.cleanup();
  }
});

test('commitSafe: a corrupted doc mixed with code dirt is excluded from the fallback stash', () => {
  const r = makeRepoWithRemote();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\ncode-change\n'); // non-doc → forces the stash path
    writeFileSync(join(r.dir, 'docs/superpowers/plans/in-progress/977-x.md'), nul(4));
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: () => {},
    });
    assert.equal(res.mode, 'stash');
    assert.match(r.g('status', '--porcelain'), /977-x\.md/, 'corrupted file excluded, still dirty');
    assert.doesNotMatch(r.g('status', '--porcelain'), /f\.txt/, 'f.txt WAS stashed');
    assert.doesNotMatch(
      r.g('stash', 'show', '-p'),
      /977-x/,
      'corrupted file never entered the stash',
    );
  } finally {
    r.cleanup();
  }
});

test('commitSafe: a text-to-binary flip (not fully NUL) is also excluded and warned', () => {
  const r = makeRepoWithRemote();
  try {
    writeFileSync(
      join(r.dir, 'docs/superpowers/plans/in-progress/977-x.md'),
      `base${nul(1)}CORRUPT-MIDDLE`,
    );
    const logs = [];
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: (m) => logs.push(m),
    });
    assert.equal(res.mode, 'corrupted-only');
    assert.ok(
      logs.some((m) => m.includes('binary')),
      'binary-flip reason surfaced in the warning',
    );
  } finally {
    r.cleanup();
  }
});

// plan 1634 review fix: the first cut only wired the corruption guard into the commitSafe
// branch — --commit (a local wip commit) and the bare default stash mutated $MAIN from the
// SAME dirty set with NO corruption check at all. These two tests cover both gaps.
test('--commit: a corrupted file is excluded from the wip commit and left dirty', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'good.txt'), 'base\nedited\n');
    writeFileSync(join(r.dir, 'f.txt'), nul(4)); // f.txt is tracked ('base\n') per makeRepo()
    const logs = [];
    const res = guard(r.dir, {
      slug: 'x',
      commit: true,
      now: new Date(),
      log: (m) => logs.push(m),
    });
    assert.equal(res.mode, 'commit');
    assert.deepEqual(res.corrupted, ['f.txt']);
    assert.match(r.g('log', '-1', '--format=%s'), /^wip: x pre-yield/);
    assert.match(r.g('status', '--porcelain'), /f\.txt/, 'corrupted file excluded, still dirty');
    assert.doesNotMatch(r.g('status', '--porcelain'), /good\.txt/, 'good.txt WAS committed');
    assert.ok(
      logs.some((m) => m.includes('corruption-guard') && m.includes('f.txt')),
      'a corruption warning was logged',
    );
  } finally {
    r.cleanup();
  }
});

test('default (bare) stash: a corrupted file is excluded from the stash and left dirty', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'good.txt'), 'new\n'); // untracked
    writeFileSync(join(r.dir, 'f.txt'), nul(4)); // tracked, corrupted
    const res = guard(r.dir, { slug: 'x', now: new Date(), log: () => {} });
    assert.equal(res.mode, 'stash');
    assert.deepEqual(res.corrupted, ['f.txt']);
    assert.match(r.g('status', '--porcelain'), /f\.txt/, 'corrupted file excluded, still dirty');
    assert.doesNotMatch(r.g('status', '--porcelain'), /good\.txt/, 'good.txt WAS stashed');
    assert.doesNotMatch(
      r.g('stash', 'show', '-p'),
      /f\.txt/,
      'corrupted file never entered the stash',
    );
  } finally {
    r.cleanup();
  }
});

test('--check preview: names a corrupted file so a --dry reader does not over-promise', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), nul(4));
    const logs = [];
    const res = guard(r.dir, { slug: 'x', check: true, log: (m) => logs.push(m) });
    assert.deepEqual(res.corrupted, ['f.txt']);
    const joined = logs.join('\n');
    assert.match(joined, /corrupted/);
    assert.match(joined, /f\.txt \(all-nul\)/);
    // --check changes nothing.
    assert.equal(isDirty(r.g('status', '--porcelain')), true);
    assert.equal(r.g('stash', 'list'), '');
  } finally {
    r.cleanup();
  }
});

test('hasRiskyChange: flags deletions/renames, ignores adds/mods/untracked', () => {
  assert.equal(hasRiskyChange(' M a.ts\n?? b.ts\nA  c.ts'), false);
  assert.equal(hasRiskyChange(' D a.ts'), true);
  assert.equal(hasRiskyChange('R  a.md -> b.md'), true);
  assert.equal(hasRiskyChange(''), false);
});

test('hasRiskyChange: flags unmerged/conflict states (UU, AA, DU, AU)', () => {
  assert.equal(hasRiskyChange('UU a.md'), true);
  assert.equal(hasRiskyChange('AA a.md'), true);
  assert.equal(hasRiskyChange('DU a.md'), true);
  assert.equal(hasRiskyChange('AU a.md'), true);
  // still NOT risky: plain add / modify / untracked
  assert.equal(hasRiskyChange(' M a.md\n?? b.md\nA  c.md'), false);
});

// ── plan 1175: staleArchiveDuplicatePaths + commitSafe guard ─────────────────

test('staleArchiveDuplicatePaths: unit — detects untracked non-archive plan whose basename is in archive/', () => {
  const r = makeRepo();
  try {
    const archDir = join(r.dir, 'docs/superpowers/plans/archive');
    const draftDir = join(r.dir, 'docs/superpowers/plans/drafting');
    mkdirSync(archDir, { recursive: true });
    mkdirSync(draftDir, { recursive: true });
    // Archive copy (tracked)
    writeFileSync(join(archDir, '1167-archived-plan.md'), 'archived\n');
    r.g('add', '-f', 'docs/superpowers/plans/archive/1167-archived-plan.md');
    r.g('commit', '-qm', 'archive plan 1167');
    // Stale untracked copy in drafting/
    writeFileSync(join(draftDir, '1167-archived-plan.md'), 'stale\n');
    const porcelain = r.g('status', '--porcelain');
    const stale = staleArchiveDuplicatePaths(r.dir, porcelain);
    assert.equal(stale.length, 1, 'one stale archive-duplicate detected');
    assert.match(stale[0], /1167-archived-plan\.md/, 'names the stale file');
  } finally {
    r.cleanup();
  }
});

test('staleArchiveDuplicatePaths: unit — a tracked plan in drafting/ is NOT flagged (only untracked)', () => {
  const r = makeRepo();
  try {
    const archDir = join(r.dir, 'docs/superpowers/plans/archive');
    const draftDir = join(r.dir, 'docs/superpowers/plans/drafting');
    mkdirSync(archDir, { recursive: true });
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(join(archDir, '1167-archived-plan.md'), 'archived\n');
    writeFileSync(join(draftDir, '1167-archived-plan.md'), 'draft (TRACKED)\n');
    r.g(
      'add',
      '-f',
      'docs/superpowers/plans/archive/1167-archived-plan.md',
      'docs/superpowers/plans/drafting/1167-archived-plan.md',
    );
    r.g('commit', '-qm', 'both tracked');
    // Modify the tracked drafting copy — it shows as " M" not "??"
    writeFileSync(join(draftDir, '1167-archived-plan.md'), 'draft modified\n');
    const porcelain = r.g('status', '--porcelain');
    const stale = staleArchiveDuplicatePaths(r.dir, porcelain);
    assert.equal(stale.length, 0, 'tracked modified file is NOT a stale archive-duplicate');
  } finally {
    r.cleanup();
  }
});

test('staleArchiveDuplicatePaths: unit — an untracked plan not in archive/ is NOT flagged', () => {
  const r = makeRepo();
  try {
    const draftDir = join(r.dir, 'docs/superpowers/plans/drafting');
    mkdirSync(draftDir, { recursive: true });
    // New plan in drafting/, no archive counterpart
    writeFileSync(join(draftDir, '9999-new-plan.md'), 'new\n');
    const porcelain = r.g('status', '--porcelain');
    const stale = staleArchiveDuplicatePaths(r.dir, porcelain);
    assert.equal(stale.length, 0, 'untracked plan with no archive/ copy is not stale');
  } finally {
    r.cleanup();
  }
});

test('commitSafe: only-stale-archive-duplicate batch is a no-op, not committed or stashed (plan 1175)', () => {
  const r = makeRepoWithRemote();
  try {
    const archDir = join(r.dir, 'docs/superpowers/plans/archive');
    const draftDir = join(r.dir, 'docs/superpowers/plans/drafting');
    mkdirSync(archDir, { recursive: true });
    mkdirSync(draftDir, { recursive: true });
    // Archive the plan (tracked in archive/)
    writeFileSync(join(archDir, '1167-archived-plan.md'), 'archived\n');
    r.g('add', '-f', 'docs/superpowers/plans/archive/1167-archived-plan.md');
    r.g('commit', '-qm', 'archive plan 1167');
    r.g('push', '-q', 'origin', 'master');
    const before = r.g('rev-parse', 'origin/master').trim();
    // Leave a stale untracked copy in drafting/ (the bug scenario)
    writeFileSync(join(draftDir, '1167-archived-plan.md'), 'stale drafting copy\n');
    const logs = [];
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: (m) => logs.push(m),
    });
    // The stale duplicate is the only dirty thing; guard returns no-op (protected:false)
    // rather than stashing — stashing would cause sweep-stray-stashes to surface it as
    // real work and an operator pop would re-introduce the stale dup (plan 1175 fix 3).
    assert.equal(res.protected, false, 'guard is a no-op — nothing real to protect');
    assert.equal(
      r.g('rev-parse', 'origin/master').trim(),
      before,
      'origin/master must NOT advance',
    );
    assert.ok(
      logs.some((l) => l.includes('archive-duplicate')),
      'logs a warning about the stale file',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 2553: commitSafe gates on the stage/folder invariant, corpus-wide ────
// The auto-heal commit runs with HUSKY=0 (no pre-push), so it never ran
// lint-plan-index's stage/folder check (plan 1371 D7: pending-approval/ may hold
// only stage: stub) — yet the 2026-07-27 incident showed it CAN commit exactly the
// state that check rejects. These tests pin the fix: commitSafeStageFolderOk (unit)
// plus guard()-level integration tests proving the commitSafe branch now stashes
// instead of pushing a violating tree.

test('commitSafeStageFolderOk: short-circuits true when no dirt path touches docs/superpowers/plans/ (cost gate)', () => {
  // A nonexistent mainDir would make any git call throw — proving the short-circuit
  // fires BEFORE any git/fs access at all (plan 2553 constraint 5).
  const ok = commitSafeStageFolderOk('/nonexistent-dir-2553-cost-gate', [
    'f.txt',
    '.claude/settings.local.json',
  ]);
  assert.equal(ok, true);
});

test('commitSafeStageFolderOk: fails CLOSED (false) when the corpus scan cannot run', () => {
  const ok = commitSafeStageFolderOk('/nonexistent-dir-2553-fail-closed', [
    'docs/superpowers/plans/ready/1-x.md',
  ]);
  assert.equal(
    ok,
    false,
    'a git error while building the corpus-wide entries is treated conservatively as unsafe',
  );
});

test('commitSafeStageFolderOk: pending-approval/ stage: specced is a violation (false)', () => {
  const r = makeRepo();
  try {
    const dir = 'docs/superpowers/plans/pending-approval';
    mkdirSync(join(r.dir, dir), { recursive: true });
    writeFileSync(join(r.dir, dir, '1-x.md'), '---\nstage: specced\n---\n\n# X\n');
    r.g('add', '-A');
    assert.equal(commitSafeStageFolderOk(r.dir, [`${dir}/1-x.md`]), false);
  } finally {
    r.cleanup();
  }
});

test('commitSafeStageFolderOk: pending-approval/ stage: stub is fine (true)', () => {
  const r = makeRepo();
  try {
    const dir = 'docs/superpowers/plans/pending-approval';
    mkdirSync(join(r.dir, dir), { recursive: true });
    writeFileSync(join(r.dir, dir, '1-x.md'), '---\nstage: stub\n---\n\n# X\n');
    r.g('add', '-A');
    assert.equal(commitSafeStageFolderOk(r.dir, [`${dir}/1-x.md`]), true);
  } finally {
    r.cleanup();
  }
});

// Acceptance criterion 1: the exact incident shape — an EXISTING pending-approval/
// plan (minted stub, tracked+pushed) gets stamped stage: specced by a board-pass but
// is never routed out before the Stop-hook fires. Must stash, not commit+push, and
// the stash must be recoverable with the offending content intact.
test('commitSafe: a pending-approval/ plan stamped stage: specced is STASHED, never pushed (plan 2553, acceptance 1)', () => {
  const r = makeRepoWithRemote();
  try {
    const dir = 'docs/superpowers/plans/pending-approval';
    mkdirSync(join(r.dir, dir), { recursive: true });
    const rel = `${dir}/2553-x.md`;
    writeFileSync(join(r.dir, rel), '---\nstage: stub\n---\n\n# X\n');
    r.g('add', '-A');
    r.g('commit', '-qm', 'mint plan 2553 as stub');
    r.g('push', '-q', 'origin', 'master');
    const before = r.g('rev-parse', 'origin/master').trim();
    // Board-pass stamps stage: specced but never routes it out of pending-approval/ —
    // the exact 2026-07-27 incident shape.
    writeFileSync(join(r.dir, rel), '---\nstage: specced\n---\n\n# X\n');
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: () => {},
    });
    assert.equal(res.mode, 'stash', 'a stage/folder violation must stash, never commit+push');
    assert.equal(r.g('rev-parse', 'origin/master').trim(), before, 'origin/master NOT advanced');
    assert.equal(isDirty(r.g('status', '--porcelain')), false, 'tree clean after stash');
    assert.match(
      r.g('stash', 'list', '--format=%gs'),
      /wip-stop-hook-/,
      'named + recoverable stash',
    );
    r.g('stash', 'pop');
    assert.equal(
      readFileSync(join(r.dir, rel), 'utf8'),
      '---\nstage: specced\n---\n\n# X\n',
      'stash pop restores the exact offending content',
    );
  } finally {
    r.cleanup();
  }
});

// Acceptance criterion 2: the SAME shape but with the invariant satisfied — a
// specced plan resting in ready/ (out of the pending-approval-only scope) — still
// commits+pushes exactly as today. The happy path (idle pure-doc commit+push) is
// already covered by 'commitSafe: idle PURE-DOC dirt is committed + pushed to
// master' above; this pins the specific "specced doc, but in the RIGHT folder"
// shape stays unregressed.
test('commitSafe: a specced plan resting in ready/ (invariant satisfied) still commits+pushes (plan 2553, acceptance 2)', () => {
  const r = makeRepoWithRemote();
  try {
    const dir = 'docs/superpowers/plans/ready';
    mkdirSync(join(r.dir, dir), { recursive: true });
    const rel = `${dir}/2553-x.md`;
    writeFileSync(join(r.dir, rel), '---\nstage: specced\n---\n\n# X\n');
    r.g('add', '-A');
    r.g('commit', '-qm', 'route plan 2553 to ready');
    r.g('push', '-q', 'origin', 'master');
    writeFileSync(join(r.dir, rel), '---\nstage: specced\n---\n\n# X edited\n'); // idle doc edit
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: () => {},
    });
    assert.equal(res.mode, 'commit-safe', 'invariant satisfied → unregressed happy path');
    assert.equal(isDirty(r.g('status', '--porcelain')), false, 'tree clean after commit');
    assert.equal(r.g('stash', 'list'), '', 'nothing stashed');
    assert.equal(
      r.g('rev-parse', 'HEAD').trim(),
      r.g('rev-parse', 'origin/master').trim(),
      'HEAD == origin/master (pushed)',
    );
  } finally {
    r.cleanup();
  }
});

// Acceptance criterion 3: corpus-wide, not dirty-paths-only. A violation lives in a
// plan file the CURRENT dirt never touches (committed earlier, untouched now) — the
// commitSafe attempt must still refuse to push because ANY docs/superpowers/plans/**
// path in the current dirt triggers the full corpus scan (constraint 5's short-
// circuit), and that scan finds the pre-existing violation (constraint 2).
test('commitSafeStageFolderOk: a missing pending-approval/ folder (mainDir otherwise real) is NOT a violation (true)', () => {
  const r = makeRepo();
  try {
    // No docs/superpowers/plans/pending-approval/ directory exists at all in this repo —
    // a legitimate "nothing there to violate" reading, distinct from mainDir itself being
    // missing (which must still fail closed — see the dedicated test above).
    assert.equal(
      commitSafeStageFolderOk(r.dir, ['docs/superpowers/plans/ready/1-x.md']),
      true,
      'a real mainDir with no pending-approval/ subfolder is an empty (not violating) scope',
    );
  } finally {
    r.cleanup();
  }
});

// Review fix: the original 2553 cut enumerated the corpus via `git ls-files`, which only
// lists TRACKED files — `guardMutate`'s `git add` runs AFTER this check, inside the
// `if (allCommitSafe)` block, so a brand-new plan file that was never `git add`-ed was
// invisible to the scan and would ride the auto-heal commit+push straight to master. This
// pins the fix: an untracked pending-approval/ file with stage: specced must now be caught.
test('commitSafe: a brand-new, NEVER-git-add-ed pending-approval/ file with stage: specced is STASHED, not pushed (untracked blind spot fix)', () => {
  const r = makeRepoWithRemote();
  try {
    const dir = 'docs/superpowers/plans/pending-approval';
    mkdirSync(join(r.dir, dir), { recursive: true });
    const rel = `${dir}/2553-fresh-untracked.md`;
    // Freshly authored directly on disk — never `git add`-ed, so `git ls-files` (the old
    // scan) would never see it; `git status --porcelain` reports it as `??`.
    writeFileSync(join(r.dir, rel), '---\nstage: specced\n---\n\n# Fresh\n');
    const before = r.g('rev-parse', 'origin/master').trim();
    // The directory is entirely untracked, so porcelain collapses it to a single `?? dir/`
    // entry (not the individual file) — `dirtyPaths`/`staleArchiveDuplicatePaths` already
    // expand that via `ls-files --others` before this reaches commitSafeStageFolderOk.
    assert.match(r.g('status', '--porcelain'), /\?\? docs\/superpowers\/plans\/pending-approval\//);
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: () => {},
    });
    assert.equal(
      res.mode,
      'stash',
      'an untracked-but-violating pending-approval/ file must stash, never commit+push',
    );
    assert.equal(r.g('rev-parse', 'origin/master').trim(), before, 'origin/master NOT advanced');
    assert.equal(isDirty(r.g('status', '--porcelain')), false, 'tree clean after stash');
    r.g('stash', 'pop');
    assert.equal(
      readFileSync(join(r.dir, rel), 'utf8'),
      '---\nstage: specced\n---\n\n# Fresh\n',
      'stash pop restores the exact untracked content',
    );
  } finally {
    r.cleanup();
  }
});

test('commitSafe: a PRE-EXISTING corpus violation blocks the push even when the dirt itself never touches it (plan 2553, acceptance 3)', () => {
  const r = makeRepoWithRemote();
  try {
    const paDir = 'docs/superpowers/plans/pending-approval';
    mkdirSync(join(r.dir, paDir), { recursive: true });
    writeFileSync(join(r.dir, paDir, 'preexisting.md'), '---\nstage: specced\n---\n\n# Pre\n');
    r.g('add', '-A');
    r.g('commit', '-qm', 'seed a pre-existing pending-approval/ stage: specced violation');
    r.g('push', '-q', 'origin', 'master');
    const before = r.g('rev-parse', 'origin/master').trim();
    // Unrelated NEW plan dirt — a different file, in a different (in-scope) folder —
    // that the auto-heal would otherwise happily commit+push on its own.
    const readyDir = 'docs/superpowers/plans/ready';
    mkdirSync(join(r.dir, readyDir), { recursive: true });
    writeFileSync(join(r.dir, readyDir, 'other.md'), '---\nstage: specced\n---\n\n# Other\n');
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: () => {},
    });
    assert.equal(
      res.mode,
      'stash',
      'the pre-existing corpus-wide violation must block the push even though the dirt never touched it',
    );
    assert.equal(r.g('rev-parse', 'origin/master').trim(), before, 'origin/master NOT advanced');
    assert.equal(isDirty(r.g('status', '--porcelain')), false, 'tree clean after stash');
  } finally {
    r.cleanup();
  }
});

// ── plan 3206: line-ending-only rewrites must not park an empty stash ─────────

// A repo with `.gitattributes` normalizing every tracked file's line endings — the exact
// shape a CRLF-only rewrite produces: `git status --porcelain` flags the file dirty, but
// the content is byte-identical to HEAD once git normalizes it (reproduced 2026-08-15, see
// the plan body's reproduction). Deliberately the OPPOSITE config from `pinLf` above (which
// pins LF to keep OTHER fixtures round-trip-stable) — these tests need autocrlf/eol-driven
// normalization to actually fire.
function makeEolRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'preyield-eol-test-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  g('config', 'core.autocrlf', 'true');
  writeFileSync(join(dir, '.gitattributes'), '* text=auto eol=lf\n');
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  g('add', '.gitattributes', 'f.txt');
  g('commit', '-qm', 'init');
  return { dir, g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('hasRealDirt: false for a CRLF-only rewrite that normalizes away', () => {
  const r = makeEolRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), Buffer.from('base\r\n'));
    const paths = dirtyPaths(r.g('status', '--porcelain'));
    assert.deepEqual(paths, ['f.txt']);
    assert.equal(hasRealDirt(r.dir, paths), false);
  } finally {
    r.cleanup();
  }
});

test('hasRealDirt: true for a real tracked content change', () => {
  const r = makeEolRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\nreal-change\n');
    const paths = dirtyPaths(r.g('status', '--porcelain'));
    assert.equal(hasRealDirt(r.dir, paths), true);
  } finally {
    r.cleanup();
  }
});

test('hasRealDirt: true for an untracked-only file (no tracked diff at all)', () => {
  const r = makeEolRepo();
  try {
    writeFileSync(join(r.dir, 'new.txt'), 'new\n');
    const paths = dirtyPaths(r.g('status', '--porcelain'));
    assert.equal(hasRealDirt(r.dir, paths), true);
  } finally {
    r.cleanup();
  }
});

test('hasRealDirt: false for an empty path list', () => {
  const r = makeEolRepo();
  try {
    assert.equal(hasRealDirt(r.dir, []), false);
  } finally {
    r.cleanup();
  }
});

test('guard: a CRLF-only rewrite creates NO stash and leaves the tree clean (plan 3206)', () => {
  const r = makeEolRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), Buffer.from('base\r\n'));
    assert.match(r.g('status', '--porcelain'), /f\.txt/, 'porcelain flags it dirty first');
    const logs = [];
    const res = guard(r.dir, { slug: 'x', now: new Date(), log: (m) => logs.push(m) });
    assert.equal(res.protected, false);
    assert.equal(res.skipped, 'normalizes-clean');
    assert.equal(r.g('stash', 'list'), '', 'no stash created');
    assert.equal(isDirty(r.g('status', '--porcelain')), false, 'tree renormalized clean');
    assert.equal(
      readFileSync(join(r.dir, 'f.txt'), 'utf8'),
      'base\n',
      'renormalized back to LF on disk',
    );
    assert.ok(
      logs.some((m) => m.includes('normalizes-clean') || m.includes('not parking')),
      'logs the skip reason',
    );
  } finally {
    r.cleanup();
  }
});

// Plan 3206 fix round (review finding): the skip return must carry `mode`, not just
// `skipped`. heal-main.mjs's healDirt() switches on `res.mode` and falls through to a
// catch-all `blocked` verdict for an unrecognised return — so a mode-less skip made
// heal-main exit 1 reporting "blocked" for a tree this branch had just made clean.
test('guard: the normalizes-clean skip carries mode (heal-main reads it) — plan 3206', () => {
  const r = makeEolRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), Buffer.from('base\r\n'));
    const res = guard(r.dir, { slug: 'x', now: new Date(), log: () => {} });
    assert.equal(res.skipped, 'normalizes-clean');
    assert.equal(res.mode, 'normalizes-clean', 'mode is set so healDirt does not read blocked');
  } finally {
    r.cleanup();
  }
});

// Plan 3206 re-review finding: a corrupted file can be dirty ALONGSIDE a line-ending-only
// one — the corrupted-only early return fires only when EVERY still-dirty path is corrupted.
// The skip must still surface `corrupted` so heal-main reports 'blocked', not a false clean.
test('guard: normalizes-clean beside a corrupted file still reports it (plan 3206)', () => {
  const r = makeEolRepo();
  try {
    r.g('config', 'core.autocrlf', 'true');
    writeFileSync(join(r.dir, 'c.txt'), 'base\n');
    r.g('add', 'c.txt');
    r.g('commit', '-qm', 'add c');
    writeFileSync(join(r.dir, 'f.txt'), Buffer.from('base\r\n')); // CRLF-only, normalizes away
    writeFileSync(join(r.dir, 'c.txt'), nul(4)); // corrupted — must be left alone
    const res = guard(r.dir, { slug: 'x', now: new Date(), log: () => {} });
    assert.equal(res.skipped, 'normalizes-clean');
    assert.deepEqual(res.corrupted, ['c.txt'], 'the corrupted path is surfaced to heal-main');
    assert.equal(r.g('stash', 'list'), '', 'still no stash created');
    assert.match(
      r.g('status', '--porcelain'),
      /c\.txt/,
      'the corrupted file is left dirty for a human/heal',
    );
  } finally {
    r.cleanup();
  }
});

// Plan 3206 fix round (review finding): the pre-check originally sat BELOW the `commit`
// branch, so `--commit` still ran `git add` + `git commit` on a path set that normalized to
// nothing. git exits 1 with "nothing to commit, working tree clean"; gitWithLockRetry does
// not treat that as retryable, so it propagated out of withCoordLock and crashed the
// process (exit 2). The check now sits above BOTH branches.
test('guard --commit: a CRLF-only rewrite does not throw and commits nothing (plan 3206)', () => {
  const r = makeEolRepo();
  try {
    const head = r.g('rev-parse', 'HEAD').trim();
    writeFileSync(join(r.dir, 'f.txt'), Buffer.from('base\r\n'));
    let res;
    assert.doesNotThrow(() => {
      res = guard(r.dir, { slug: 'x', commit: true, now: new Date(), log: () => {} });
    }, 'commit mode must not die on git\'s "nothing to commit" exit 1');
    assert.equal(res.protected, false);
    assert.equal(res.skipped, 'normalizes-clean');
    assert.equal(r.g('rev-parse', 'HEAD').trim(), head, 'no empty commit was created');
    assert.equal(isDirty(r.g('status', '--porcelain')), false, 'tree renormalized clean');
  } finally {
    r.cleanup();
  }
});

test('guard --commit: a real content change on an eol-normalized repo still commits', () => {
  const r = makeEolRepo();
  try {
    const head = r.g('rev-parse', 'HEAD').trim();
    writeFileSync(join(r.dir, 'f.txt'), 'base\nreal-change\n');
    const res = guard(r.dir, { slug: 'x', commit: true, now: new Date(), log: () => {} });
    assert.equal(res.protected, true);
    assert.equal(res.mode, 'commit');
    assert.notEqual(r.g('rev-parse', 'HEAD').trim(), head, 'a real change still commits');
  } finally {
    r.cleanup();
  }
});

test('guard: a real content change on an eol-normalized repo still parks a stash', () => {
  const r = makeEolRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\nreal-change\n');
    const res = guard(r.dir, { slug: 'x', now: new Date(), log: () => {} });
    assert.equal(res.protected, true);
    assert.equal(res.mode, 'stash');
    assert.match(r.g('stash', 'list', '--format=%gs'), /wip-x-/);
    assert.equal(isDirty(r.g('status', '--porcelain')), false);
  } finally {
    r.cleanup();
  }
});

test('guard: an untracked-only file on an eol-normalized repo still parks a stash', () => {
  const r = makeEolRepo();
  try {
    writeFileSync(join(r.dir, 'new.txt'), 'new\n');
    const res = guard(r.dir, { slug: 'x', now: new Date(), log: () => {} });
    assert.equal(res.protected, true);
    assert.equal(res.mode, 'stash');
    assert.equal(isDirty(r.g('status', '--porcelain')), false);
    r.g('stash', 'pop');
    assert.match(r.g('status', '--porcelain'), /new\.txt/);
  } finally {
    r.cleanup();
  }
});

test('guard: a MIXED repo (CRLF-only + real change) parks a stash containing exactly the real change', () => {
  const r = makeEolRepo();
  try {
    writeFileSync(join(r.dir, 'other.txt'), 'base\n');
    r.g('add', 'other.txt');
    r.g('commit', '-qm', 'seed a second file');
    writeFileSync(join(r.dir, 'f.txt'), Buffer.from('base\r\n')); // CRLF-only, normalizes away
    writeFileSync(join(r.dir, 'other.txt'), 'base\nreal-change\n'); // real content change
    const res = guard(r.dir, { slug: 'x', now: new Date(), log: () => {} });
    assert.equal(res.protected, true);
    assert.equal(res.mode, 'stash');
    assert.equal(isDirty(r.g('status', '--porcelain')), false);
    const stashDiff = r.g('stash', 'show', '-p');
    assert.match(stashDiff, /other\.txt/, 'stash carries the real change');
    assert.doesNotMatch(stashDiff, /f\.txt/, 'stash does not carry the CRLF-only file');
  } finally {
    r.cleanup();
  }
});

// ── plan 3206 Task 2: post-push empty-stash drop ────────────────────────────

test('isEmptyStash: true for a hand-built no-op stash, false for a real one', () => {
  const r = makeEolRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), Buffer.from('base\r\n'));
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-noop-1');
    assert.equal(isEmptyStash(r.dir, 'stash@{0}'), true);

    writeFileSync(join(r.dir, 'f.txt'), 'base\nreal\n');
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-real-1');
    assert.equal(isEmptyStash(r.dir, 'stash@{0}'), false);
  } finally {
    r.cleanup();
  }
});

test('dropIfEmptyStash: removes an empty stash it matches by label, leaves a non-empty one alone', () => {
  const r = makeEolRepo();
  try {
    // Hand-build an empty stash bearing the label dropIfEmptyStash is told to look for —
    // simulates SOME OTHER producer creating an empty stash (Task 1's own pre-check already
    // prevents THIS module's own stash push from reaching this shape in normal operation).
    writeFileSync(join(r.dir, 'f.txt'), Buffer.from('base\r\n'));
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-x-noop');
    const logs = [];
    const droppedEmpty = dropIfEmptyStash(r.dir, {
      label: 'wip-x-noop',
      log: (m) => logs.push(m),
    });
    assert.equal(droppedEmpty, true);
    assert.equal(r.g('stash', 'list'), '', 'the empty stash was dropped');
    assert.ok(logs.some((m) => m.includes('turned out to hold nothing')));

    // A real stash matching its own label must be left alone.
    writeFileSync(join(r.dir, 'f.txt'), 'base\nreal\n');
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-x-real');
    const droppedReal = dropIfEmptyStash(r.dir, { label: 'wip-x-real', log: () => {} });
    assert.equal(droppedReal, false);
    assert.match(r.g('stash', 'list', '--format=%gs'), /wip-x-real/, 'real stash left in place');
  } finally {
    r.cleanup();
  }
});

test('dropIfEmptyStash: never drops when the top stash does not carry the expected label (racing sibling)', () => {
  const r = makeEolRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), Buffer.from('base\r\n')); // empty, but a DIFFERENT label
    r.g('stash', 'push', '--include-untracked', '-m', 'wip-someone-else');
    const dropped = dropIfEmptyStash(r.dir, { label: 'wip-x-mine', log: () => {} });
    assert.equal(dropped, false, 'label mismatch → leave it, even though it is empty');
    assert.match(r.g('stash', 'list', '--format=%gs'), /wip-someone-else/);
  } finally {
    r.cleanup();
  }
});

// ── plan 3968: refuse to park a TRUNCATED index ─────────────────────────────────────────
// Builds on makeRepo() with `fileCount` extra tracked files, so the tree clears the
// TRUNCATED_INDEX_HEAD_FLOOR checkIndexSanity gates on. Shared with heal-main.test.mjs and
// index-sanity.test.mjs via test-helpers/torn-index-repo.mjs (plan 3968 review, a23554/1a2f55)
// — `tornIndex` is imported directly from there too.
function makeLargeRepo(fileCount) {
  return buildLargeRepo(makeRepo, fileCount);
}

test('guard --commit-safe refuses to stash/commit a TRUNCATED index', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    tornIndex(r.dir);
    const logs = [];
    const res = guard(r.dir, { slug: 'stop-hook', commitSafe: true, log: (m) => logs.push(m) });
    assert.equal(res.protected, false);
    assert.equal(res.skipped, 'truncated-index');
    assert.ok(res.indexSanity?.truncated, 'carries the predicate result for the caller');
    assert.equal(r.g('stash', 'list').trim(), '', 'nothing was stashed');
    assert.ok(
      logs.some((l) => /TRUNCATED/.test(l) && /heal-main/.test(l)),
      'names heal-main.mjs as the fix',
    );
  } finally {
    r.cleanup();
  }
});

// plan 3968 review (73114a): the truncated-index refusal used to be gated on `commitSafe`
// alone, so heal-main's own `--dry` preview — which calls guard(mainDir, { check: true })
// WITHOUT commitSafe — never took it, and instead printed a misleading "MAIN has uncommitted
// work" report off the still-torn index's raw `git status`. This pins the `check` path.
test('guard --check also refuses to read status off a TRUNCATED index (heal-main --dry preview)', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    tornIndex(r.dir);
    const logs = [];
    const res = guard(r.dir, { slug: 'heal-main', check: true, log: (m) => logs.push(m) });
    assert.equal(res.protected, false);
    assert.equal(res.skipped, 'truncated-index');
    assert.ok(res.indexSanity?.truncated, 'carries the predicate result for the caller');
    assert.ok(
      logs.some((l) => /TRUNCATED/.test(l) && /heal-main/.test(l)),
      'names heal-main.mjs as the fix',
    );
  } finally {
    r.cleanup();
  }
});

// plan 3968 review round 2 (6f8265): an `unknown` verdict (the staged-deletion probe itself
// failed) must be refused exactly like a `truncated` one — this guard has no way to tell the
// index is safe in that state. Injected via the `exec` testability seam (mirrors
// index-sanity.test.mjs's own pattern) rather than a real on-disk corruption isolated to one
// git subcommand.
test('guard --commit-safe refuses to stash/commit when the index state is UNKNOWN (probe error)', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    tornIndex(r.dir);
    const flaky = (...a) => {
      const args = a[1];
      if (Array.isArray(args) && args.includes('diff') && args.includes('--diff-filter=D')) {
        throw new Error('simulated staged-deletion probe failure');
      }
      return execFileSync(...a);
    };
    const logs = [];
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      exec: flaky,
      log: (m) => logs.push(m),
    });
    assert.equal(res.protected, false);
    assert.equal(res.skipped, 'index-state-unknown');
    assert.ok(res.indexSanity?.unknown, 'carries the predicate result for the caller');
    assert.equal(r.g('stash', 'list').trim(), '', 'nothing was stashed');
    assert.ok(
      logs.some((l) => /could not be verified/.test(l) && /heal-main/.test(l)),
      'names heal-main.mjs as the fix',
    );
  } finally {
    r.cleanup();
  }
});

test('guard --commit-safe still parks ordinary dirt on a large-but-healthy tree', () => {
  const r = makeLargeRepo(TRUNCATED_INDEX_HEAD_FLOOR + 10);
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\nchanged\n'); // f.txt is not commit-safe → stash
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date('2026-05-30T09:15:00Z'),
      log: () => {},
    });
    assert.equal(res.mode, 'stash');
    assert.notEqual(res.skipped, 'truncated-index');
  } finally {
    r.cleanup();
  }
});

test('commitSafe: real doc + stale archive-duplicate → real doc committed, duplicate skipped (plan 1175)', () => {
  const r = makeRepoWithRemote();
  try {
    const archDir = join(r.dir, 'docs/superpowers/plans/archive');
    const draftDir = join(r.dir, 'docs/superpowers/plans/drafting');
    mkdirSync(archDir, { recursive: true });
    mkdirSync(draftDir, { recursive: true });
    // Archive a plan
    writeFileSync(join(archDir, '1167-archived-plan.md'), 'archived\n');
    r.g('add', '-f', 'docs/superpowers/plans/archive/1167-archived-plan.md');
    r.g('commit', '-qm', 'archive plan 1167');
    r.g('push', '-q', 'origin', 'master');
    // Real commit-safe doc dirt (tracked plan edit)
    writeFileSync(join(r.dir, 'docs/superpowers/plans/in-progress/977-x.md'), 'base\nedited\n');
    // Stale untracked archive-duplicate in drafting/
    writeFileSync(join(draftDir, '1167-archived-plan.md'), 'stale copy\n');
    const logs = [];
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      now: new Date(),
      log: (m) => logs.push(m),
    });
    // Real doc edit is committed; stale duplicate is filtered out
    assert.equal(res.mode, 'commit-safe', 'real doc dirt is committed');
    assert.equal(
      isDirty(r.g('status', '--porcelain', '--', 'docs/superpowers/plans/in-progress/')),
      false,
      'real doc committed',
    );
    // Stale duplicate still on disk (untracked, filtered out of the commit).
    // git --porcelain collapses an entirely-untracked dir to `?? dir/`; check on disk.
    assert.ok(
      existsSync(join(draftDir, '1167-archived-plan.md')),
      'stale duplicate file still on disk',
    );
    assert.ok(
      logs.some((l) => l.includes('archive-duplicate')),
      'logs a warning about the stale file',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 4026: the budget gate (kill-safety for the Stop-hook park) ─────────────────────
// A harness kill landing inside `git stash push` leaves disk rewritten to HEAD and the index
// at its pre-stash state — the stale MAIN index of 2026-09-14. The fix is not a bigger
// timeout (the step is non-atomic at any budget) but refusing to START a step the caller's
// deadline cannot finish.
test('budgetShortfall: no budget is unlimited; an ample budget fits; a tight one reports elapsed', () => {
  // Every case pins `startMs` and `nowMs`, so the boundary is a property of the arithmetic,
  // not of how long this process happened to have been running.
  assert.equal(budgetShortfall({ budgetMs: 0, startMs: 0, nowMs: 999_999 }), null, 'no budget');
  assert.equal(budgetShortfall({ startMs: 0, nowMs: 999_999 }), null, 'budget omitted');
  assert.equal(
    budgetShortfall({ budgetMs: 50_000, startMs: 1_000, nowMs: 6_000 }),
    null,
    '5s elapsed + 10s reserve fits a 50s budget',
  );
  assert.equal(
    budgetShortfall({ budgetMs: 50_000, startMs: 1_000, nowMs: 42_000 }),
    41_000,
    '41s elapsed + 10s reserve exceeds a 50s budget → the elapsed ms',
  );
  // Exactly at the line: elapsed + reserve === budget still fits (the reserve IS the margin).
  assert.equal(
    budgetShortfall({ budgetMs: 50_000, startMs: 0, nowMs: 50_000 - STASH_RESERVE_MS }),
    null,
    'elapsed + reserve == budget fits',
  );
  assert.equal(
    budgetShortfall({ budgetMs: 50_000, startMs: 0, nowMs: 50_000 - STASH_RESERVE_MS + 1 }),
    50_000 - STASH_RESERVE_MS + 1,
    'one ms past the line yields',
  );
});

test('guard --budget-ms: an exhausted budget parks NOTHING and leaves the dirt in place', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\nchanged\n');
    writeFileSync(join(r.dir, 'untracked.txt'), 'new\n');
    const logs = [];
    // startMs 0 (the epoch) against a 1 ms budget: `elapsed + reserve > budget` holds for ANY
    // non-negative clock reading, so the skip is a property of the arithmetic, not of how fast
    // this machine ran or which way the wall clock drifted (review finding b64310).
    const res = guard(r.dir, {
      slug: 'stop-hook',
      budgetMs: 1,
      startMs: 0,
      log: (l) => logs.push(l),
    });
    assert.equal(res.protected, false);
    assert.equal(res.dirty, true);
    assert.equal(res.skipped, 'budget');
    assert.equal(res.budgetMs, 1);
    assert.ok(
      logs.some((l) => l.includes('park skipped: budget')),
      'prints the line park-master-dirt-on-stop.sh greps for',
    );
    assert.equal(r.g('stash', 'list').trim(), '', 'no stash created');
    assert.match(r.g('status', '--porcelain'), /f\.txt/, 'the dirt is still there');
    assert.match(r.g('status', '--porcelain'), /untracked\.txt/);
  } finally {
    r.cleanup();
  }
});

test('guard --budget-ms: a budget that cannot be exhausted stashes exactly as before', () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.dir, 'f.txt'), 'base\nchanged\n');
    const res = guard(r.dir, {
      slug: 'stop-hook',
      // Unreachable by construction: no clock reading + reserve can exceed it, whatever the
      // wall clock does — the mirror of the exhausted case above.
      budgetMs: Number.MAX_SAFE_INTEGER,
      startMs: 0,
      now: new Date('2026-09-20T07:00:00Z'),
      log: () => {},
    });
    assert.equal(res.protected, true);
    assert.equal(res.mode, 'stash');
    assert.match(r.g('stash', 'list', '--format=%gs'), /wip-stop-hook-2026/);
  } finally {
    r.cleanup();
  }
});

test('guard --budget-ms: an exhausted budget also blocks the commitSafe commit+push', () => {
  const r = makeRepoWithRemote();
  try {
    const doc = 'docs/superpowers/plans/in-progress/977-x.md';
    writeFileSync(join(r.dir, doc), 'base\nidle doc edit\n');
    const headBefore = r.g('rev-parse', 'HEAD').trim();
    const logs = [];
    const res = guard(r.dir, {
      slug: 'stop-hook',
      commitSafe: true,
      budgetMs: 1,
      startMs: 0,
      log: (l) => logs.push(l),
    });
    assert.equal(res.skipped, 'budget');
    assert.equal(r.g('rev-parse', 'HEAD').trim(), headBefore, 'nothing committed');
    assert.equal(r.g('stash', 'list').trim(), '', 'nothing stashed either');
    assert.match(r.g('status', '--porcelain'), /977-x\.md/, 'the doc dirt is still there');
    assert.ok(logs.some((l) => l.includes('park skipped: budget')));
  } finally {
    r.cleanup();
  }
});
