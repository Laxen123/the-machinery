// scripts/board.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  withRetry,
  STATE_ALIASES,
  shouldLintCell,
  assertCellLintClean,
} from './board.mjs';
import { PAUSED_STATE, LANDING_STATE } from './coord/board-lib.mjs';
import { readCoordOpJournal } from './coord/coord-git.mjs';

const BOARD_MJS = fileURLToPath(new URL('./board.mjs', import.meta.url));

// --- write-time Plan/claim cell lint (plan 511) -------------------------------

test('shouldLintCell: claim always; update only with --plan-claim; others never', () => {
  assert.equal(shouldLintCell('claim', {}, {}), true);
  assert.equal(shouldLintCell('claim', { 'plan-claim': 'x' }, {}), true);
  assert.equal(shouldLintCell('update', { 'plan-claim': 'x' }, {}), true);
  assert.equal(shouldLintCell('update', { tip: '`abc`' }, {}), false);
  assert.equal(shouldLintCell('set-state', {}, {}), false);
  assert.equal(shouldLintCell('remove', {}, {}), false);
});

test('shouldLintCell: BOARD_LINT_SKIP=1 disables the lint (emergency bypass)', () => {
  assert.equal(shouldLintCell('claim', {}, { BOARD_LINT_SKIP: '1' }), false);
  assert.equal(shouldLintCell('update', { 'plan-claim': 'x' }, { BOARD_LINT_SKIP: '1' }), false);
  // Any other value does NOT bypass.
  assert.equal(shouldLintCell('claim', {}, { BOARD_LINT_SKIP: '0' }), true);
});

const BOARD_511 = (planCell) =>
  [
    '# Board',
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '|---|---|---|---|---|---|',
    `| my-slug | \`abc\` | 🔄 ACTIVE | ${planCell} | 2026-06-10 | — |`,
    '<!-- BOARD-END -->',
  ].join('\n');

const PLANS_511 = new Map([['100-Other-live.md', ['in-progress/100-Other-live.md']]]);

test('assertCellLintClean: valid cell is a no-op', () => {
  assertCellLintClean(
    BOARD_511('`in-progress/100-Other-live.md` · session 1'),
    'my-slug',
    PLANS_511,
  );
});

test('assertCellLintClean: the plan-479 incident cell throws with NO_PLAN_REF and remediation', () => {
  assert.throws(
    () =>
      assertCellLintClean(
        BOARD_511('479-INTL-norway-frontend-localization (drain worker, host T2020188)'),
        'my-slug',
        PLANS_511,
      ),
    (e) => /NO_PLAN_REF/.test(e.message) && /BOARD_LINT_SKIP=1/.test(e.message),
  );
});

test('assertCellLintClean: cell naming the wrong subfolder throws BOARD_SUBFOLDER_DRIFT', () => {
  assert.throws(
    () => assertCellLintClean(BOARD_511('`ready/100-Other-live.md`'), 'my-slug', PLANS_511),
    /BOARD_SUBFOLDER_DRIFT/,
  );
});

test('parseArgs splits command, positional slug, and --flags', () => {
  const a = parseArgs(['set-state', 'my-slug', '🟢 LANDING']);
  assert.equal(a.cmd, 'set-state');
  assert.deepEqual(a.positionals, ['my-slug', '🟢 LANDING']);
  const b = parseArgs([
    'claim',
    'slug',
    '--state',
    'ACTIVE',
    '--plan-claim',
    'text here',
    '--tip',
    'sha',
  ]);
  assert.equal(b.flags.state, 'ACTIVE');
  assert.equal(b.flags['plan-claim'], 'text here');
  assert.equal(b.flags.tip, 'sha');
});

test('STATE_ALIASES maps short names to emoji forms', () => {
  assert.equal(STATE_ALIASES.LANDING, '🟢 LANDING');
  assert.equal(STATE_ALIASES.ACTIVE, '🔄 ACTIVE');
  assert.equal(STATE_ALIASES['IN-PROGRESS'], '🔄 IN PROGRESS');
  assert.equal(STATE_ALIASES.PAUSED, '⏸ PAUSED');
});

test('plan 2394: STATE_ALIASES agrees with board-lib’s LANDING/PAUSED constants', () => {
  // `claim-plan acquire --resume` now writes the PAUSED demote state itself, straight from
  // board-lib's constant — so a row demoted by a takeover and a row demoted by
  // `board.mjs set-state <slug> PAUSED` must render byte-identically. This pins the DRIFT (an
  // edit to either side alone goes red); board.mjs sourcing the constant rather than keeping
  // an equal literal is what makes drift impossible in the first place.
  assert.equal(STATE_ALIASES.PAUSED, PAUSED_STATE);
  assert.equal(STATE_ALIASES.LANDING, LANDING_STATE);
});

test('withRetry retries on a non-ff signal then succeeds, re-running the producer each attempt', async () => {
  let attempts = 0;
  const producer = () => {
    attempts++;
    return `attempt-${attempts}`;
  };
  let pushes = 0;
  const pushFn = (payload) => {
    pushes++;
    if (pushes < 3) {
      const e = new Error('rejected');
      e.nonFastForward = true;
      throw e;
    }
    return payload;
  };
  const result = await withRetry(producer, pushFn, { max: 5 });
  assert.equal(result, 'attempt-3'); // producer re-ran each retry (fresh board each time)
  assert.equal(attempts, 3);
});

test('withRetry gives up after max attempts', async () => {
  const producer = () => 'x';
  const pushFn = () => {
    const e = new Error('rejected');
    e.nonFastForward = true;
    throw e;
  };
  await assert.rejects(() => withRetry(producer, pushFn, { max: 2 }), /after 2 attempts/);
});

// ── F-018 (plan 1313 coord audit): board.mjs single-slug remove/set-state tolerate an
// already-absent row — a REAL `node scripts/board.mjs` subprocess against a real bare
// origin + clone, because the bug is specifically in what the CLI does end-to-end (the
// board-lib.test.mjs unit tests above cover the pure tolerateAbsent logic in isolation).

function makeBoardFixture() {
  const root = mkdtempSync(join(tmpdir(), 'board-cli-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  const clone = join(root, 'clone');
  execFileSync('git', ['clone', '-q', origin, clone]);
  execFileSync('git', ['-C', clone, 'config', 'user.email', 't@t.t']);
  execFileSync('git', ['-C', clone, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', clone, 'config', 'commit.gpgsign', 'false']);
  const doc = [
    '# Handoff board',
    '',
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan/claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    '| present-slug | `abc1234` | 🔄 ACTIVE | plan | 2026-07-04 | — |',
    '<!-- BOARD-END -->',
    '',
  ].join('\n');
  writeFileSync(join(clone, 'handoff-board.md'), doc);
  writeFileSync(join(clone, '.gitignore'), '.claude/\n');
  execFileSync('git', ['-C', clone, 'add', '-A']);
  execFileSync('git', ['-C', clone, 'commit', '-qm', 'init']);
  execFileSync('git', ['-C', clone, 'push', '-q', 'origin', 'master']);
  return { root, clone, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// Runs the REAL board.mjs CLI, redirecting resolveMain() at the fixture clone via
// COORD_MAIN_DIR — the same override done-worktree's own close-out uses for its ephemeral
// finish worktree (plan 971).
function runBoard(clone, args) {
  return execFileSync('node', [BOARD_MJS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, COORD_MAIN_DIR: clone, HUSKY: '0' },
  });
}

test('board.mjs remove: F-018 — an already-absent row is a no-op success (exit 0), not a hard throw', () => {
  const f = makeBoardFixture();
  try {
    const out = runBoard(f.clone, ['remove', 'never-had-a-row']);
    assert.match(out, /no-op/i);
    // sanity: the real, present row is untouched
    const after = execFileSync('git', ['-C', f.clone, 'show', 'origin/master:handoff-board.md'], {
      encoding: 'utf8',
    });
    assert.match(after, /present-slug/);
  } finally {
    f.cleanup();
  }
});

test('board.mjs remove: still ACTUALLY removes a present row (tolerance is not a blanket no-op)', () => {
  const f = makeBoardFixture();
  try {
    const out = runBoard(f.clone, ['remove', 'present-slug']);
    assert.match(out, /committed \+ pushed/);
    const after = execFileSync('git', ['-C', f.clone, 'show', 'origin/master:handoff-board.md'], {
      encoding: 'utf8',
    });
    assert.ok(!/present-slug/.test(after), 'the row was actually removed, not swallowed');
  } finally {
    f.cleanup();
  }
});

test('board.mjs set-state: F-018 — an already-absent row is a no-op success, not exit 2', () => {
  const f = makeBoardFixture();
  try {
    const out = runBoard(f.clone, ['set-state', 'never-had-a-row', 'PAUSED']);
    assert.match(out, /no-op/i);
  } finally {
    f.cleanup();
  }
});

test('board.mjs set-state ... LANDING: an absent row HARD-FAILS exit 2 (review 2026-07-04) — unlike the demote path, the LANDING mutex claim must NOT silently no-op', () => {
  const f = makeBoardFixture();
  try {
    // The LANDING stamp CLAIMS the scoped cross-session land signal. done-worktree stamps it via
    // coordStep right before merging and (default mode) relies on THIS throw propagating to abort
    // the land — a silent no-op would drop the 🟢 LANDING marker a sibling's overlapping-shard
    // preflight checks, letting a conflicting 🟥 land start unseen. Contrast the demote/teardown
    // set-state above, which stays F-018-tolerant.
    let err;
    try {
      runBoard(f.clone, ['set-state', 'never-had-a-row', 'LANDING']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'LANDING on an absent row must throw, not no-op');
    assert.equal(
      err.status,
      2,
      'exits 2 (row not found), so done-worktree coordStep aborts the land',
    );
    assert.match(`${err.stderr}`, /row not found/i);
  } finally {
    f.cleanup();
  }
});

test('board.mjs set-state: still ACTUALLY updates a present row (tolerance is not a blanket no-op)', () => {
  const f = makeBoardFixture();
  try {
    const out = runBoard(f.clone, ['set-state', 'present-slug', 'PAUSED']);
    assert.match(out, /committed \+ pushed/);
    const after = execFileSync('git', ['-C', f.clone, 'show', 'origin/master:handoff-board.md'], {
      encoding: 'utf8',
    });
    assert.match(after, /⏸ PAUSED/);
  } finally {
    f.cleanup();
  }
});

// ── plan 2519: board.mjs journal label hygiene ──────────────────────────────────────────────
// `runBoard`'s COORD_MAIN_DIR override above SKIPS withCoordLock entirely (that's the
// done-worktree ephemeral-finish-worktree short-circuit), so it can never observe the journal.
// This test runs the REAL CLI WITHOUT that override — a plain clone as the resolved main
// worktree (git worktree list's sole entry, on master) — so board.mjs's own withCoordCheckout
// call takes the genuine lock + journal path, and we can assert the entries actually carry
// `tool: 'board'` instead of the diluted default ('coord', shared with 5 other unwired callers).
test('board.mjs write journals under tool "board" with a release phase (not the diluted default)', () => {
  const f = makeBoardFixture();
  try {
    const env = { ...process.env, HUSKY: '0' };
    delete env.COORD_MAIN_DIR;
    execFileSync('node', [BOARD_MJS, 'set-state', 'present-slug', 'PAUSED'], {
      encoding: 'utf8',
      cwd: f.clone,
      env,
    });
    const boardEntries = readCoordOpJournal(f.clone).filter((e) => e.tool === 'board');
    assert.ok(
      boardEntries.length > 0,
      'at least one journal entry labeled tool: board (not the generic "coord" default)',
    );
    assert.ok(
      boardEntries.some((e) => e.phase === 'release'),
      'a release-phase entry exists — board.mjs is lever-1 wired and now measurable per-tool',
    );
    assert.ok(
      boardEntries.some((e) => e.phase === 'done'),
      'the op journals its terminal phase too',
    );
  } finally {
    f.cleanup();
  }
});
