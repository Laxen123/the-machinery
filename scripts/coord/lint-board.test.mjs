// scripts/lint-board.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateRows,
  planBasenameMap,
  validateRowInContent,
  extractPlanRefs,
  BOARD_INPUT_PATHSPECS,
  driftIsInherited,
  checkDriftIsInheritedWithTelemetry,
  checkBoardStale,
} from './lint-board.mjs';
import { ALL_PLAN_FOLDERS } from './build-index-lib.mjs';
import { fakeExec } from '../fake-git-exec.mjs';

// byBasename: Map<filename, relPaths[]> — what plan files exist.
const plans = new Map([
  ['100-Other-live.md', ['in-progress/100-Other-live.md']],
  ['101-Other-archived.md', ['archive/101-Other-archived.md']],
  ['102-Other-frozen.md', ['parked/102-Other-frozen.md']],
]);

function row(state, planCell) {
  return { cells: ['slug', '`tip`', state, planCell, 'd', '—'], lineNumber: 1 };
}

test('DONE-ON-BRANCH row pointing at a missing in-progress path now fails (163 class)', () => {
  const errs = validateRows(
    [row('✅ DONE-ON-BRANCH', '`in-progress/101-Other-archived.md`')],
    plans,
  );
  assert.equal(
    errs.some((e) => e.kind === 'BROKEN_BOARD_POINTER' || e.kind === 'ARCHIVED_PLAN_ACTIVE_ROW'),
    true,
  );
});

test('SUPERSEDED row pointing at a real in-progress plan passes', () => {
  const errs = validateRows([row('🧹 SUPERSEDED', '`in-progress/100-Other-live.md`')], plans);
  assert.equal(errs.length, 0);
});

test('ACTIVE row with a live plan still passes', () => {
  const errs = validateRows([row('🔄 ACTIVE', '`in-progress/100-Other-live.md`')], plans);
  assert.equal(errs.length, 0);
});

test('row with no plan ref is flagged NO_PLAN_REF, regardless of state', () => {
  const errs = validateRows([row('✅ DONE-ON-BRANCH', 'no ref here')], plans);
  assert.equal(
    errs.some((e) => e.kind === 'NO_PLAN_REF'),
    true,
  );
});

// plan 2082: the SUBFOLDER_DRIFT hint must carry the exact ready-to-run heal command
// (board.mjs update <slug> --plan-claim '<healed cell>') so a blocked autonomous session
// can heal-and-retry without operator judgment — this drift blocks EVERY session's push.
test('BOARD_SUBFOLDER_DRIFT hint prints the ready-to-run board.mjs heal command (plan 2082)', () => {
  const cell = '`ready/100-Other-live.md` · session 9 · host=`H`';
  const errs = validateRows([row('🔄 ACTIVE', cell)], plans);
  const drift = errs.find((e) => e.kind === 'BOARD_SUBFOLDER_DRIFT');
  assert.ok(drift, `expected a BOARD_SUBFOLDER_DRIFT error, got: ${JSON.stringify(errs)}`);
  // Slug comes from cell 0 of the row (the shared `row` helper uses 'slug'); the healed
  // cell repoints ONLY the drifted path — session/host prose stays byte-identical —
  // and is single-quoted so the backticks survive a shell.
  assert.ok(
    drift.hint.includes(
      "node scripts/board.mjs update slug --plan-claim '`in-progress/100-Other-live.md` · session 9 · host=`H`'",
    ),
    `hint should carry the runnable heal command, got:\n${drift.hint}`,
  );
});

// plan 2082 (review r1): a basename with MULTIPLE non-frozen copies must NOT get an
// authoritative-looking auto-heal command built from an arbitrary nonFrozen[0] pick —
// the ambiguous case lists the candidates and demands a human pick.
test('BOARD_SUBFOLDER_DRIFT with an ambiguous basename withholds the auto-heal command (plan 2082)', () => {
  const dupPlans = new Map([
    ['100-Other-live.md', ['in-progress/100-Other-live.md', 'waiting-blocked/100-Other-live.md']],
  ]);
  const errs = validateRows([row('🔄 ACTIVE', '`ready/100-Other-live.md`')], dupPlans);
  const drift = errs.find((e) => e.kind === 'BOARD_SUBFOLDER_DRIFT');
  assert.ok(drift, `expected a BOARD_SUBFOLDER_DRIFT error, got: ${JSON.stringify(errs)}`);
  assert.match(drift.hint, /AMBIGUOUS basename \(2 non-frozen copies\)/);
  assert.doesNotMatch(
    drift.hint,
    /--plan-claim '`(?:in-progress|waiting-blocked)\//,
    'no pre-filled command may name an arbitrarily-picked candidate',
  );
});

// plan 1426: a board row pointing at a plan that only exists under parked/ is flagged
// like an archive/-only row — a parked plan is frozen, not active work.
test('ACTIVE row pointing at a parked/-only plan is flagged PARKED_PLAN_ACTIVE_ROW', () => {
  const errs = validateRows([row('🔄 ACTIVE', '`parked/102-Other-frozen.md`')], plans);
  assert.equal(
    errs.some((e) => e.kind === 'PARKED_PLAN_ACTIVE_ROW'),
    true,
  );
});

// plan 2929: a board row stamped 🔄 ACTIVE whose plan resolves ONLY under a
// waiting-*/ folder is stale — the plan is parked pending an external event, not
// actually being worked.
test('ACTIVE row pointing at a waiting-*/-only plan is flagged WAITING_PLAN_ACTIVE_ROW', () => {
  const waitingPlans = new Map([
    ['200-Coord-waiting.md', ['waiting-operator/200-Coord-waiting.md']],
  ]);
  const errs = validateRows(
    [row('🔄 ACTIVE', '`waiting-operator/200-Coord-waiting.md`')],
    waitingPlans,
  );
  assert.equal(
    errs.some((e) => e.kind === 'WAITING_PLAN_ACTIVE_ROW'),
    true,
  );
});

test('PAUSED row pointing at the same waiting-*/-only plan stays CLEAN', () => {
  const waitingPlans = new Map([
    ['200-Coord-waiting.md', ['waiting-operator/200-Coord-waiting.md']],
  ]);
  const errs = validateRows(
    [row('⏸ PAUSED', '`waiting-operator/200-Coord-waiting.md`')],
    waitingPlans,
  );
  assert.equal(
    errs.some((e) => e.kind === 'WAITING_PLAN_ACTIVE_ROW'),
    false,
  );
});

test('ACTIVE row pointing at an in-progress/-only plan stays CLEAN (not a waiting-lane plan)', () => {
  const errs = validateRows([row('🔄 ACTIVE', '`in-progress/100-Other-live.md`')], plans);
  assert.equal(
    errs.some((e) => e.kind === 'WAITING_PLAN_ACTIVE_ROW'),
    false,
  );
});

test('ACTIVE row pointing at a plan present under BOTH waiting-*/ and an active folder stays CLEAN (preserved "only exists under" semantics)', () => {
  const bothPlans = new Map([
    [
      '200-Coord-waiting.md',
      ['waiting-operator/200-Coord-waiting.md', 'in-progress/200-Coord-waiting.md'],
    ],
  ]);
  const errs = validateRows([row('🔄 ACTIVE', '`in-progress/200-Coord-waiting.md`')], bothPlans);
  assert.equal(
    errs.some((e) => e.kind === 'WAITING_PLAN_ACTIVE_ROW'),
    false,
  );
});

// --- extractPlanRefs (PLAN_REF_RX subfolder alternation, plan 1371 taxonomy) --

test('extractPlanRefs: recognizes a pending-approval/ subfolder prefix', () => {
  const refs = extractPlanRefs('`pending-approval/456-Infra-orphan.md`');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].subfolder, 'pending-approval');
  assert.equal(refs[0].filename, '456-Infra-orphan.md');
});

test('extractPlanRefs: a retired drafting/ prefix is no longer captured as a subfolder', () => {
  const refs = extractPlanRefs('`drafting/456-Infra-orphan.md`');
  assert.equal(refs.length, 1);
  assert.notEqual(refs[0].subfolder, 'drafting');
});

test('extractPlanRefs: recognizes a parked/ subfolder prefix (plan 1426)', () => {
  const refs = extractPlanRefs('`parked/457-Infra-frozen.md`');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].subfolder, 'parked');
  assert.equal(refs[0].filename, '457-Infra-frozen.md');
});

// plan 1447 drift guard: PLAN_REF_RX is now BUILT from build-index-lib's PLAN_FOLDER_ALT
// instead of a hand-listed literal (its alternation order also changed — see
// build-index-lib.mjs's ALL_PLAN_FOLDERS comment for why that's harmless). BEHAVIORAL
// equivalence, not textual .source equality, is the meaningful guard here: every folder
// in ALL_PLAN_FOLDERS must still be recognized as a subfolder prefix, exactly as the
// original hand-listed regex did.
test('extractPlanRefs: recognizes EVERY ALL_PLAN_FOLDERS entry as a subfolder prefix (plan 1447 drift guard)', () => {
  for (const folder of ALL_PLAN_FOLDERS) {
    const refs = extractPlanRefs(`\`${folder}/458-Infra-x.md\``);
    assert.equal(refs.length, 1, `folder "${folder}" produced ${refs.length} refs, expected 1`);
    assert.equal(refs[0].subfolder, folder);
    assert.equal(refs[0].filename, '458-Infra-x.md');
  }
});

// A behavioral (not textual) parity check against the ORIGINAL hand-listed literal — the
// old alternation order (kept here as a plain string, never re-imported from lint-board.mjs)
// must match the SAME set of test refs as the new PLAN_FOLDER_ALT-derived construction.
test('PLAN_REF_RX behaves identically to the pre-1447 hand-listed literal over representative refs', () => {
  const OLD_RX =
    /(?:(in-progress|ready|pending-approval|waiting-blocked|waiting-date|waiting-trip|waiting-operator|archive|parked)\/)?(\d{3,}-[A-Z][A-Za-z0-9]+-[^\s`)]+?\.md|\d{4}-\d{2}-\d{2}-[^\s`)]+?\.md)/g;
  const cases = [
    '`in-progress/459-Infra-a.md`',
    '`ready/459-Infra-a.md`',
    '`pending-approval/459-Infra-a.md`',
    '`waiting-blocked/459-Infra-a.md`',
    '`waiting-operator/459-Infra-a.md`',
    '`waiting-date/459-Infra-a.md`',
    '`waiting-trip/459-Infra-a.md`',
    '`archive/459-Infra-a.md`',
    '`parked/459-Infra-a.md`',
    '459-Infra-a.md (no subfolder prefix)',
    '`2026-06-10-legacy-date-name.md`',
    'not a plan reference at all',
  ];
  for (const c of cases) {
    OLD_RX.lastIndex = 0;
    const oldMatches = [...c.matchAll(OLD_RX)].map((m) => [m[1] || null, m[2]]);
    const newRefs = extractPlanRefs(c).map((r) => [r.subfolder, r.filename]);
    assert.deepEqual(newRefs, oldMatches, `mismatch for input: ${c}`);
  }
});

// --- plan 2678: category-subfolder board refs ---------------------------------
// extractPlanRefs' subfolder capture must admit an OPTIONAL one-level category
// folder between the status and the file. WITHOUT this widening a categorised ref
// still lints GREEN — it just mis-parses as a bare filename, silently disarming
// BOARD_SUBFOLDER_DRIFT (the exact class plan 2082 added the check for) for every
// categorised board row.

test('extractPlanRefs: a categorised subfolder cell carries the WHOLE status/category prefix', () => {
  const refs = extractPlanRefs('`parked/denmark/459-Coord-x.md`');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].subfolder, 'parked/denmark');
  assert.equal(refs[0].filename, '459-Coord-x.md');
  assert.equal(refs[0].full, 'parked/denmark/459-Coord-x.md');
});

// The backwards-compat pin: every pre-2678 flat shape must still parse identically
// (no accidental category capture off a plain status prefix or a bare/dated filename).
// Table-driven like the OLD_RX equivalence pin above — a new flat shape to guard is one
// row here, not another pasted assert block whose hand-copied `full` can silently drift
// out of step with its `filename` and read as wrong test data rather than a parser bug.
test('extractPlanRefs: pre-2678 flat shapes still parse identically (backwards-compat pin)', () => {
  const cases = [
    ['900-Coord-x.md', null, '900-Coord-x.md'],
    ['`in-progress/900-Coord-x.md`', 'in-progress', '900-Coord-x.md'],
    ['`docs/superpowers/plans/ready/900-Coord-x.md`', 'ready', '900-Coord-x.md'],
    ['`archive/2026-05-17-legacy-x.md`', 'archive', '2026-05-17-legacy-x.md'],
  ];
  for (const [cell, subfolder, filename] of cases) {
    const refs = extractPlanRefs(cell);
    assert.equal(refs.length, 1, `expected exactly one ref for: ${cell}`);
    assert.deepEqual(
      refs[0],
      { subfolder, filename, full: subfolder ? `${subfolder}/${filename}` : filename },
      `mismatch for input: ${cell}`,
    );
  }
});

// validateRows: a categorised ref must still ARM the BOARD_SUBFOLDER_DRIFT check.
// Before plan 2678's classifyPlanRel-based fix, a categorised cell mis-parsed as a
// bare filename (subfolder: null), which made `ref.subfolder && !candidates.includes(...)`
// short-circuit FALSE — so validateRows silently skipped the drift instead of flagging it.
test('plan 2678: validateRows still raises BOARD_SUBFOLDER_DRIFT for a categorised board ref pointing at a stale path', () => {
  const nested = new Map([['900-Coord-x.md', ['in-progress/900-Coord-x.md']]]);
  const errs = validateRows([row('🔄 ACTIVE', '`ready/infra/900-Coord-x.md`')], nested);
  const drift = errs.find((e) => e.kind === 'BOARD_SUBFOLDER_DRIFT');
  assert.ok(drift, `expected a BOARD_SUBFOLDER_DRIFT error, got: ${JSON.stringify(errs)}`);
  assert.equal(drift.path, 'ready/infra/900-Coord-x.md');
  assert.match(drift.hint, /but the file is actually at in-progress\/900-Coord-x\.md/);
});

// --- planBasenameMap (shared sync walker — plan 511) -------------------------

test('planBasenameMap walks nested status dirs and returns relative paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-board-bnm-'));
  try {
    mkdirSync(join(dir, 'in-progress'), { recursive: true });
    mkdirSync(join(dir, 'archive'), { recursive: true });
    writeFileSync(join(dir, 'in-progress', '100-Other-live.md'), '# x');
    writeFileSync(join(dir, 'archive', '100-Other-live.md'), '# x');
    writeFileSync(join(dir, 'archive', '099-Other-old.md'), '# x');
    writeFileSync(join(dir, 'not-a-plan.txt'), 'ignored');
    const map = planBasenameMap(dir);
    assert.deepEqual(map.get('100-Other-live.md')?.sort(), [
      'archive/100-Other-live.md',
      'in-progress/100-Other-live.md',
    ]);
    assert.deepEqual(map.get('099-Other-old.md'), ['archive/099-Other-old.md']);
    assert.equal(map.has('not-a-plan.txt'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planBasenameMap on a missing dir returns an empty map (no throw)', () => {
  const map = planBasenameMap(join(tmpdir(), 'lint-board-bnm-definitely-absent'));
  assert.equal(map.size, 0);
});

// --- validateRowInContent (row-scoped lint on full board text — plan 511) ----

function boardContent(rows) {
  return [
    '# Board',
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '|---|---|---|---|---|---|',
    ...rows,
    '<!-- BOARD-END -->',
  ].join('\n');
}

test('validateRowInContent: valid cell → no errors', () => {
  const content = boardContent([
    '| my-slug | `abc` | 🔄 ACTIVE | `in-progress/100-Other-live.md` · session 1 | 2026-06-10 | — |',
  ]);
  assert.deepEqual(validateRowInContent(content, 'my-slug', plans), []);
});

test('validateRowInContent: the plan-479 incident cell (free-form, no filename) → NO_PLAN_REF', () => {
  const content = boardContent([
    '| my-slug | `abc` | 🔄 ACTIVE | 479-INTL-norway-frontend-localization (drain worker, host T2020188) | 2026-06-10 | — |',
  ]);
  const errs = validateRowInContent(content, 'my-slug', plans);
  assert.equal(
    errs.some((e) => e.kind === 'NO_PLAN_REF'),
    true,
  );
});

test('validateRowInContent: only the named slug is linted — sibling poison does not fail us', () => {
  const content = boardContent([
    '| poisoned-sibling | `abc` | 🔄 ACTIVE | free-form no filename | 2026-06-10 | — |',
    '| my-slug | `abc` | 🔄 ACTIVE | `in-progress/100-Other-live.md` | 2026-06-10 | — |',
  ]);
  assert.deepEqual(validateRowInContent(content, 'my-slug', plans), []);
});

test('validateRowInContent: absent slug → ROW_NOT_FOUND', () => {
  const content = boardContent([]);
  const errs = validateRowInContent(content, 'ghost-slug', plans);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].kind, 'ROW_NOT_FOUND');
});

// plan 2929: the ROW-SCOPED write-time lint must NOT enforce WAITING_PLAN_ACTIVE_ROW.
// It is a STATE-column finding, and its write-time callers (board.mjs's plan-511 cell
// gate, drain-run's verifyBoardRowLintClean) only ever set the CELL. drain-run's park
// sequence repaths the cell to waiting-operator/ while the row is still 🔄 ACTIVE and
// only flips it to ⏸ PAUSED afterwards — enforcing here would refuse that repath and
// roll the whole park back. The push-time FULL-board lint still gates the kind — that
// half of the contract is asserted by the validateRows case above ('ACTIVE row pointing
// at a waiting-*/-only plan is flagged WAITING_PLAN_ACTIVE_ROW'), not restated here.
test('validateRowInContent: an ACTIVE row repathed to waiting-*/ is NOT refused (drain park sequence)', () => {
  const waitingPlans = new Map([
    ['200-Coord-waiting.md', ['waiting-operator/200-Coord-waiting.md']],
  ]);
  const content = boardContent([
    '| my-slug | `abc` | 🔄 ACTIVE | `waiting-operator/200-Coord-waiting.md` · session 1 | 2026-08-06 | — |',
  ]);
  assert.deepEqual(validateRowInContent(content, 'my-slug', waitingPlans), []);
});

test('validateRowInContent: a genuine CELL defect on a waiting-*/ row is still refused', () => {
  const waitingPlans = new Map([
    ['200-Coord-waiting.md', ['waiting-operator/200-Coord-waiting.md']],
  ]);
  const content = boardContent([
    '| my-slug | `abc` | 🔄 ACTIVE | free-form no filename | 2026-08-06 | — |',
  ]);
  const errs = validateRowInContent(content, 'my-slug', waitingPlans);
  assert.equal(
    errs.some((e) => e.kind === 'NO_PLAN_REF'),
    true,
  );
});

// --- driftIsInherited wiring (plan 1664 — extends plan-1650's lint-plan-index.mjs
// tolerance to this sibling gate). The full git-attribution matrix is pinned once in
// drift-attribution-lib.test.mjs; these tests confirm THIS gate wires it correctly:
// the right pathspecs (board file + plans tree + this gate's own detection inputs),
// and both directions through the exported wrapper via the same fakeExec seam.

test("BOARD_INPUT_PATHSPECS includes the board file, the plans tree, and this gate's own detection inputs", () => {
  assert.ok(
    BOARD_INPUT_PATHSPECS.some((p) => p.endsWith('board.md') || p.endsWith('handoff-board.md')),
    'must include the coord-config-resolved board file, not a hardcoded path',
  );
  for (const input of [
    'docs/superpowers/plans',
    'scripts/coord/board-lib.mjs',
    'scripts/coord/coord-config.mjs',
    'scripts/coord/build-index-lib.mjs',
    'scripts/lint-board.mjs',
    // plan 1664 review [0]/[1]: the git-attribution engine this gate calls into, extracted
    // out of lint-plan-index.mjs, must stay an input — a branch weakening it must not grade
    // its own change as "inherited" via the very logic it just edited.
    'scripts/coord/drift-attribution-lib.mjs',
  ]) {
    assert.ok(
      BOARD_INPUT_PATHSPECS.includes(input),
      `${input} must be an attribution input — a branch changing detection semantics owns its drift`,
    );
  }
});

test('driftIsInherited: worktree branch, inputs untouched + clean tree → inherited (true)', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-1664-x\n',
    'merge-base': 'abc123\n',
    diff: '',
    status: '',
  });
  assert.equal(driftIsInherited({ _exec }), true);
});

test('driftIsInherited: branch touched a board/plan input → strict (false)', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-1664-x\n',
    'merge-base': 'abc123\n',
    diff: () => {
      const e = new Error('exit 1');
      e.status = 1;
      throw e;
    },
  });
  assert.equal(driftIsInherited({ _exec }), false);
});

test('driftIsInherited: master stays strict', () => {
  const _exec = fakeExec({ 'rev-parse': 'master\n' });
  assert.equal(driftIsInherited({ _exec }), false);
});

// plan 1669: env defaults to `{}`, never `process.env` — pins that this wrapper's tests
// stay immune to whatever `.husky/pre-push` exported ambiently for the shared
// rev-parse/merge-base optimization; only main()'s real call site opts in explicitly.
test('driftIsInherited: env threads through to the shared core, skipping its rev-parse/merge-base', () => {
  const _exec = fakeExec({
    diff: '',
    status: '',
    // no rev-parse/merge-base handlers — calling either would throw here
  });
  assert.equal(
    driftIsInherited({
      _exec,
      env: { COORD_DRIFT_BRANCH: 'worktree-1669-x', COORD_DRIFT_BASE: 'abc123' },
    }),
    true,
  );
  assert.equal(_exec.calls.length, 2, 'only diff + status — rev-parse/merge-base came from env');
});

// --- push telemetry (plan 1731) -----------------------------------------------
// checkDriftIsInheritedWithTelemetry marks the "board" hit THEN consults
// driftIsInherited — main() calls this instead of inlining both, so the "mark at the
// consult point, regardless of outcome" contract is pinned here without needing a
// real repo / full hook drive (that end-to-end wiring is covered in
// pre-push-hook.test.mjs).

test('plan 1731: checkDriftIsInheritedWithTelemetry marks the "board" hit before consulting driftIsInherited (inherited outcome)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-board-telem-'));
  const hitsFile = join(dir, 'hits.txt');
  try {
    const _exec = fakeExec({
      'rev-parse': 'worktree-1731-x\n',
      'merge-base': 'abc123\n',
      diff: '',
      status: '',
    });
    const result = checkDriftIsInheritedWithTelemetry({
      _exec,
      env: { COORD_PUSH_TELEMETRY_HITS_FILE: hitsFile },
    });
    assert.equal(result, true);
    assert.equal(readFileSync(hitsFile, 'utf8'), 'board\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan 1731: checkDriftIsInheritedWithTelemetry still marks the hit when the outcome resolves STRICT (false)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-board-telem-'));
  const hitsFile = join(dir, 'hits.txt');
  try {
    const _exec = fakeExec({ 'rev-parse': 'master\n' });
    const result = checkDriftIsInheritedWithTelemetry({
      _exec,
      env: { COORD_PUSH_TELEMETRY_HITS_FILE: hitsFile },
    });
    assert.equal(result, false);
    assert.equal(
      readFileSync(hitsFile, 'utf8'),
      'board\n',
      'a strict (non-inherited) outcome is still a "hit" — attribution was consulted',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan 1731: checkDriftIsInheritedWithTelemetry is a complete no-op on telemetry when the env var is absent', () => {
  const _exec = fakeExec({ 'rev-parse': 'master\n' });
  assert.doesNotThrow(() => checkDriftIsInheritedWithTelemetry({ _exec, env: {} }));
});

// --- checkBoardStale wiring (plan 2099 — self-diagnosing a stale worktree checkout) ---
// The full attribution matrix (master/HEAD/rev-parse-fail/etc.) is pinned once in
// drift-attribution-lib.test.mjs's checkWorktreeCoordDocStale suite; these tests confirm
// THIS gate's wrapper points it at the right file (BOARD_REL, via the coord-config-
// resolved board path) and reads it through the same fakeExec seam as driftIsInherited.

test('checkBoardStale: worktree board.md differs from origin/master → stale', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-2099-x\n',
    show: 'fresh master board.md\n',
    'rev-list': '2\n',
  });
  const result = checkBoardStale({ localContent: 'stale local board.md\n', _exec });
  assert.deepEqual(result, { stale: true, commitsBehind: 2 });
  assert.ok(
    _exec.calls.some((c) => c.includes('show origin/master:') && c.includes('board.md')),
    "must diff against origin/master's copy of the coord-config-resolved board file",
  );
});

test('checkBoardStale: worktree board.md matches origin/master → not stale', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-2099-x\n',
    show: 'same content\n',
    'rev-list': '0\n',
  });
  const result = checkBoardStale({ localContent: 'same content\n', _exec });
  assert.deepEqual(result, { stale: false, commitsBehind: null });
});

test('checkBoardStale: master branch never diagnosed as stale', () => {
  const _exec = fakeExec({ 'rev-parse': 'master\n' });
  const result = checkBoardStale({ localContent: 'anything\n', _exec });
  assert.deepEqual(result, { stale: false, commitsBehind: null });
});
