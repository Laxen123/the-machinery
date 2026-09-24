// scripts/board-write-gate.test.mjs — plan 2378 step 2/step 5.
//
// Two layers, because the plan's acceptance criterion 5 asks for the strong claim
// ("REFUSED by the write path … and no commit reaches origin/master — demonstrated by a
// test, not by argument"):
//
//   1. the gate itself refuses the violating tree, with an actionable message;
//   2. a REAL coordWrite over a REAL bare origin, whose mutate writes the violation and
//      then calls the gate, leaves origin/master byte-identical — i.e. the refusal
//      genuinely lands BEFORE the add/commit/push, not after.
//
// Layer 3 (the three tools actually call it) is a static wiring assertion at the bottom:
// cheap, and it fails loudly if a future refactor drops a call site.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertBoardInvariants,
  assertBoardInvariantsForPending,
  blockedViewFor,
  dropStaleBlockedBy,
  gateAppliesToFolder,
  loadCorpusView,
  BoardInvariantError,
  planPathsAmong,
  collectTouchedPlans,
  findStageStatusProseViolations,
  findStampProseContradictions,
  isStrictImprovement,
  violationKeys,
} from './board-write-gate.mjs';
import { coordWrite } from './coord-git.mjs';
import { scriptFile } from '../test-helpers/repo-script-path.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const PLANS = 'docs/superpowers/plans';

// --- real-git harness: bare origin + a work clone (acts as $MAIN on master) ---------
// Same shape as coord-edit.test.mjs's harness; kept local rather than exported from
// there so the two files' fixtures can evolve independently.
function makeOrigin() {
  const root = mkdtempSync(join(tmpdir(), 'board-write-gate-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  const dir = join(root, 'work');
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, dir]);
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('config', 'user.email', 'work@t.t');
  g('config', 'user.name', 'work');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, '.gitignore'), '.claude/\n');
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  g('push', '-q', 'origin', 'master');
  g('branch', '--set-upstream-to=origin/master', 'master');
  return { root, dir, origin, g, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writePlan(dir, folder, basename, content) {
  const rel = `${PLANS}/${folder}/${basename}`;
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
  return rel;
}

const speccedStub = (id) =>
  `---\nsummary: 'x'\nstage: specced\nspecReview: abc1234\n---\n\n# ${id} a specced plan\n`;
const properStub = (id) => `---\nsummary: 'x'\nstage: stub\n---\n\n# ${id} a fresh stub\n`;

// --- layer 1: the gate refuses ------------------------------------------------------

test('2378 A5: a `stage: specced` plan resting in pending-approval/ is REFUSED', () => {
  const s = makeOrigin();
  try {
    const rel = writePlan(s.dir, 'pending-approval', '2373-Coord-x.md', speccedStub(2373));
    assert.throws(
      () => assertBoardInvariants(s.dir, [rel], { tool: 'next-plan-id claim' }),
      (e) => {
        assert.ok(e instanceof BoardInvariantError);
        assert.equal(e.boardInvariantViolations.length, 1);
        assert.equal(e.boardInvariantViolations[0].kind, 'stage-folder');
        // actionable: names the plan, the violation, and the exact fix command
        assert.match(e.message, /2373-Coord-x\.md/);
        assert.match(e.message, /stage: specced in pending-approval\//);
        assert.match(e.message, /move-plan\.mjs <id> ready/);
        return true;
      },
    );
  } finally {
    s.cleanup();
  }
});

test('2378: a `stage: stub` plan in pending-approval/ passes (the sanctioned resting spot)', () => {
  const s = makeOrigin();
  try {
    const rel = writePlan(s.dir, 'pending-approval', '2374-Coord-x.md', properStub(2374));
    assert.deepEqual(assertBoardInvariants(s.dir, [rel], { tool: 'next-plan-id claim' }), []);
  } finally {
    s.cleanup();
  }
});

test('2378: adding a LIVE Blocked-by to a ready/ plan is REFUSED (axis-A authoring moment)', () => {
  const s = makeOrigin();
  try {
    // The blocker must resolve to a real, OPEN plan for the line to be "live".
    const blocker = writePlan(s.dir, 'in-progress', '2357-Pipe-y.md', properStub(2357));
    s.g('add', '-A');
    s.g('commit', '-qm', 'blocker');
    const rel = writePlan(
      s.dir,
      'ready',
      '2358-Pipe-x.md',
      `---\nsummary: 'x'\nstage: specced\n---\n\n# 2358\n\n**Blocked-by:** plan 2357 — lands first\n`,
    );
    assert.throws(
      () => assertBoardInvariants(s.dir, [rel], { tool: 'edit-plan' }),
      (e) => {
        assert.equal(e.boardInvariantViolations[0].kind, 'live-blocked-by');
        assert.match(e.message, /open blockers: 2357/);
        assert.match(e.message, /move-plan\.mjs <id> waiting-blocked/);
        return true;
      },
    );
    assert.ok(blocker);
    // ...and --force (allowLiveBlockedBy) waives exactly that one check.
    assert.deepEqual(
      assertBoardInvariants(s.dir, [rel], { tool: 'edit-plan', allowLiveBlockedBy: true }),
      [],
    );
  } finally {
    s.cleanup();
  }
});

test('2378: --force does NOT waive the stage/folder invariant', () => {
  const s = makeOrigin();
  try {
    const rel = writePlan(s.dir, 'pending-approval', '2373-Coord-x.md', speccedStub(2373));
    assert.throws(
      () => assertBoardInvariants(s.dir, [rel], { tool: 'edit-plan', allowLiveBlockedBy: true }),
      BoardInvariantError,
    );
  } finally {
    s.cleanup();
  }
});

test('2378: the gate is SCOPED to this write — a pre-existing violation elsewhere never blocks it', () => {
  const s = makeOrigin();
  try {
    // Someone else's misfile, already on master.
    writePlan(s.dir, 'pending-approval', '2375-Coord-theirs.md', speccedStub(2375));
    s.g('add', '-A');
    s.g('commit', '-qm', 'a sibling lands a violation');
    // My write touches an entirely different, clean plan.
    const mine = writePlan(s.dir, 'pending-approval', '2400-Coord-mine.md', properStub(2400));
    assert.deepEqual(
      assertBoardInvariants(s.dir, [mine], { tool: 'edit-plan' }),
      [],
      'a corpus-wide check here would just move the innocent-session wedge earlier in time',
    );
  } finally {
    s.cleanup();
  }
});

// --- layer 2: no commit reaches origin/master ---------------------------------------

test('2378 A5: a coordWrite whose mutate trips the gate leaves origin/master UNCHANGED', () => {
  const s = makeOrigin();
  try {
    const before = s.g('rev-parse', 'origin/master').trim();
    const rel = `${PLANS}/pending-approval/2373-Coord-x.md`;
    assert.throws(
      () =>
        coordWrite(s.dir, {
          relPaths: [rel],
          tool: 'next-plan-id claim',
          message: 'docs(plans): add 2373',
          mutate: () => {
            mkdirSync(dirname(join(s.dir, rel)), { recursive: true });
            writeFileSync(join(s.dir, rel), speccedStub(2373));
            // exactly how the real tools call it: last statement of mutate()
            assertBoardInvariants(s.dir, [rel], { tool: 'next-plan-id claim' });
          },
        }),
      BoardInvariantError,
    );
    s.g('fetch', '-q', 'origin');
    assert.equal(
      s.g('rev-parse', 'origin/master').trim(),
      before,
      'the refusal must land before coordWrite`s add/commit/push, not after',
    );
    // and nothing was committed locally either
    assert.equal(s.g('log', '--oneline', 'master').trim().split('\n').length, 1);
  } finally {
    s.cleanup();
  }
});

test('2378: a clean coordWrite over the same path still lands (the gate is not a blanket refusal)', () => {
  const s = makeOrigin();
  try {
    const rel = `${PLANS}/pending-approval/2374-Coord-x.md`;
    const res = coordWrite(s.dir, {
      relPaths: [rel],
      tool: 'next-plan-id claim',
      message: 'docs(plans): add 2374',
      mutate: () => {
        mkdirSync(dirname(join(s.dir, rel)), { recursive: true });
        writeFileSync(join(s.dir, rel), properStub(2374));
        assertBoardInvariants(s.dir, [rel], { tool: 'next-plan-id claim' });
      },
    });
    assert.ok(!res.noop);
    assert.match(
      execFileSync('git', ['-C', s.dir, 'show', `origin/master:${rel}`], { encoding: 'utf8' }),
      /stage: stub/,
    );
  } finally {
    s.cleanup();
  }
});

// --- helpers ------------------------------------------------------------------------

test('2378: planPathsAmong keeps only NNN-Category plan paths', () => {
  assert.deepEqual(
    planPathsAmong([
      `${PLANS}/ready/2358-Pipe-x.md`,
      'docs/INDEX.md',
      'docs/handoff/board.md',
      `${PLANS}/archive/2026-05-17-legacy-dated.md`, // plan-1002 guard: no phantom "2026" id
      `${PLANS}/ready/notes.md`,
    ]),
    [`${PLANS}/ready/2358-Pipe-x.md`],
  );
});

test('2378: collectTouchedPlans skips the moved-away side of a rename instead of crashing', () => {
  const s = makeOrigin();
  try {
    const rel = writePlan(s.dir, 'ready', '2358-Pipe-x.md', properStub(2358));
    const gone = `${PLANS}/waiting-blocked/2358-Pipe-x.md`;
    const got = collectTouchedPlans(s.dir, [gone, rel]);
    assert.equal(got.length, 1);
    assert.equal(got[0].folder, 'ready');
  } finally {
    s.cleanup();
  }
});

// --- plan 2426: the PENDING shape (judge a mutation not yet applied to disk) ---------

test('2426: assertBoardInvariantsForPending refuses a LIVE Blocked-by at the DESTINATION folder', () => {
  const s = makeOrigin();
  try {
    writePlan(s.dir, 'in-progress', '2357-Pipe-y.md', properStub(2357));
    s.g('add', '-A');
    s.g('commit', '-qm', 'an open blocker');
    // Nothing for this plan exists on disk at either path — the whole point of the pending
    // shape: the claim has not written anything yet.
    const content = `---\nsummary: 'x'\nstage: specced\n---\n\n# 2358\n\n**Blocked-by:** plan 2357 — lands first\n`;
    assert.throws(
      () =>
        assertBoardInvariantsForPending(
          s.dir,
          [{ path: `${PLANS}/in-progress/2358-Pipe-x.md`, content }],
          { tool: 'claim-plan acquire' },
        ),
      (e) => {
        assert.equal(e.boardInvariantViolations[0].kind, 'live-blocked-by');
        assert.match(e.message, /open blockers: 2357/);
        assert.match(e.message, /in-progress\//, 'the DESTINATION folder is what is judged');
        return true;
      },
    );
    // allowLiveBlockedBy (the --blocked-ok override) waives exactly that check.
    assert.deepEqual(
      assertBoardInvariantsForPending(
        s.dir,
        [{ path: `${PLANS}/in-progress/2358-Pipe-x.md`, content }],
        { tool: 'claim-plan acquire', allowLiveBlockedBy: true },
      ),
      [],
    );
  } finally {
    s.cleanup();
  }
});

test('2426: a pending move into a waiting-*/ lane is out of scope — the park paths no-op', () => {
  const s = makeOrigin();
  try {
    writePlan(s.dir, 'in-progress', '2357-Pipe-y.md', properStub(2357));
    s.g('add', '-A');
    s.g('commit', '-qm', 'an open blocker');
    // The SAME body that is refused for in-progress/ above is fine here: a Blocked-by line
    // in a waiting lane is the REQUIRED header, not a finding. This is why gating at
    // drain-run's single movePlanOnMaster choke point cannot break its four park callers.
    assert.deepEqual(
      assertBoardInvariantsForPending(
        s.dir,
        [
          {
            path: `${PLANS}/waiting-operator/2358-Pipe-x.md`,
            content: `---\nsummary: 'x'\nstage: specced\n---\n\n# 2358\n\n**Blocked-by:** plan 2357 — lands first\n`,
          },
        ],
        { tool: 'drain-run' },
      ),
      [],
    );
  } finally {
    s.cleanup();
  }
});

// --- plan 2426 (ruling Q2): the claim-side stale drop --------------------------------

test('2426 Q2: a STALE Blocked-by (blocker archived AND shipped) is dropped', () => {
  const s = makeOrigin();
  try {
    writePlan(
      s.dir,
      'archive',
      '2141-Pipe-done.md',
      `---\nsummary: 'x'\n---\n\n# 2141\n\n**Status:** ✅ COMPLETED — landed.\n`,
    );
    s.g('add', '-A');
    s.g('commit', '-qm', 'a shipped blocker');
    const view = loadCorpusView(s.dir, []);
    const body = `---\nsummary: 'x'\n---\n\n# 2408\n\n**Blocked-by:** plan 2141 — lands first\n\n## Task\n`;
    const out = dropStaleBlockedBy(body, {
      basename: '2408-Pipe-x.md',
      statusOf: view.statusOf,
      isShipped: view.isShipped,
    });
    assert.doesNotMatch(out, /Blocked-by/, 'the dead line is gone');
    assert.match(out, /## Task/, 'the rest of the body is untouched');
  } finally {
    s.cleanup();
  }
});

test('2426 Q2: a LIVE Blocked-by is left VERBATIM — claiming is not clearing', () => {
  const s = makeOrigin();
  try {
    writePlan(s.dir, 'ready', '2357-Pipe-y.md', properStub(2357));
    s.g('add', '-A');
    s.g('commit', '-qm', 'an open blocker');
    const view = loadCorpusView(s.dir, []);
    const body = `---\nsummary: 'x'\n---\n\n# 2358\n\n**Blocked-by:** plan 2357 — lands first\n`;
    assert.equal(
      dropStaleBlockedBy(body, {
        basename: '2358-Pipe-x.md',
        statusOf: view.statusOf,
        isShipped: view.isShipped,
      }),
      body,
    );
  } finally {
    s.cleanup();
  }
});

test('2426 Q2: archived-but-NOT-shipped keeps the line live (no ✅ COMPLETED stamp)', () => {
  const s = makeOrigin();
  try {
    writePlan(
      s.dir,
      'archive',
      '2141-Pipe-super.md',
      `---\nsummary: 'x'\n---\n\n# 2141\n\n**Status:** 🗄️ SUPERSEDED — closed without shipping.\n`,
    );
    s.g('add', '-A');
    s.g('commit', '-qm', 'an archived-not-shipped blocker');
    const view = loadCorpusView(s.dir, []);
    const body = `---\nsummary: 'x'\n---\n\n# 2408\n\n**Blocked-by:** plan 2141 — lands first\n`;
    assert.equal(
      dropStaleBlockedBy(body, {
        basename: '2408-Pipe-x.md',
        statusOf: view.statusOf,
        isShipped: view.isShipped,
      }),
      body,
      'archive presence alone never proves the blocking work landed (plan 1836)',
    );
  } finally {
    s.cleanup();
  }
});

test('2426 Q2: an already-CLEARED line is inert — not re-reported, so not dropped', () => {
  const s = makeOrigin();
  try {
    writePlan(
      s.dir,
      'archive',
      '2141-Pipe-done.md',
      `---\nsummary: 'x'\n---\n\n# 2141\n\n**Status:** ✅ COMPLETED — landed.\n`,
    );
    s.g('add', '-A');
    s.g('commit', '-qm', 'a shipped blocker');
    const view = loadCorpusView(s.dir, []);
    // The runbook's own cleared-line template. findBlockedByInActiveFolder deliberately
    // skips it, so the claim leaves it alone rather than silently eating the evidence
    // clause a human wrote about WHY the plan is unblocked.
    const body = `---\nsummary: 'x'\n---\n\n# 2408\n\n**Blocked-by:** none — 2141 landed 2026-07-25 (abc1234).\n`;
    assert.equal(
      dropStaleBlockedBy(body, {
        basename: '2408-Pipe-x.md',
        statusOf: view.statusOf,
        isShipped: view.isShipped,
      }),
      body,
    );
  } finally {
    s.cleanup();
  }
});

// --- layer 3: the write paths are actually wired ------------------------------------

test('2378 + 2426: every plan-mutating write path calls the board gate', () => {
  // plan 2378 wired three tools; its own review fan-out found claim-plan + drain-run doing
  // the same folder-crossing `git mv` un-gated, which plan 2426 closes. This assertion is
  // what stops a future refactor quietly dropping any of the five call sites again.
  for (const f of ['next-plan-id.mjs', 'edit-plan.mjs', 'move-plan.mjs']) {
    const src = readFileSync(scriptFile(f, SCRIPTS), 'utf8');
    assert.match(src, /from '[^']*board-write-gate\.mjs'/, `${f} must import the gate`);
    assert.match(src, /assertBoardInvariants\(/, `${f} must CALL the gate, not just import it`);
  }
  for (const f of ['claim-plan.mjs', 'drain-run.mjs']) {
    const src = readFileSync(scriptFile(f, SCRIPTS), 'utf8');
    assert.match(src, /from '[^']*board-write-gate\.mjs'/, `${f} must import the gate`);
    assert.match(
      src,
      /assertBoardInvariantsForPending\(/,
      `${f} must CALL the pending-shape gate, not just import it`,
    );
  }
});

// --- plan 2426 review round 2: the corpus passthrough + the blockedView factory --------

test('2426 R2: a caller-supplied corpus is USED, not silently rebuilt from disk', () => {
  const s = makeOrigin();
  const pending = (content) => [{ path: `${PLANS}/in-progress/2358-Pipe-x.md`, content }];
  const body = `---\nsummary: 'x'\n---\n\n# 2358\n\n**Blocked-by:** plan 2357 — first\n`;
  try {
    // Nothing on disk says 2357 exists, so a rebuilt corpus would see no blocker and pass.
    // The injected corpus says it is open — if the gate honours it, this REFUSES.
    const corpus = { statusOf: (id) => (id === '2357' ? 'ready' : null), isShipped: () => false };
    assert.throws(
      () =>
        assertBoardInvariantsForPending(s.dir, pending(body), {
          tool: 'claim-plan acquire',
          corpus,
        }),
      BoardInvariantError,
    );
    // …and omitting it falls back to the on-disk rebuild, which finds no such plan.
    assert.deepEqual(
      assertBoardInvariantsForPending(s.dir, pending(body), { tool: 'claim-plan acquire' }),
      [],
    );
  } finally {
    s.cleanup();
  }
});

test('2426 R2: blockedViewFor builds the shape dropStaleBlockedBy consumes', () => {
  const corpus = { statusOf: () => 'archive', isShipped: () => true };
  const view = blockedViewFor(corpus, '2408-Coord-x.md');
  assert.equal(view.basename, '2408-Coord-x.md');
  assert.equal(view.statusOf, corpus.statusOf);
  assert.equal(view.isShipped, corpus.isShipped);
  // The factory's output must be directly consumable — that is the whole contract.
  assert.doesNotMatch(
    dropStaleBlockedBy('# 2408\n\n**Blocked-by:** plan 2141 — first\n', view),
    /Blocked-by/,
  );
});

// --- plan 2587 Check A: stage-status-prose (BLOCKING) --------------------------------

test('2587 Check A: `stage: specced` + `**Status:** stub` is REFUSED', () => {
  const s = makeOrigin();
  try {
    const rel = writePlan(
      s.dir,
      'waiting-blocked',
      '2600-Coord-x.md',
      `---\nsummary: 'x'\nstage: specced\n---\n\n# 2600\n\n**Status:** 📋 stub — filed 2026-07-01.\n`,
    );
    assert.throws(
      () => assertBoardInvariants(s.dir, [rel], { tool: 'edit-plan' }),
      (e) => {
        assert.ok(e instanceof BoardInvariantError);
        assert.equal(e.boardInvariantViolations.length, 1);
        assert.equal(e.boardInvariantViolations[0].kind, 'stage-status-prose');
        assert.match(e.message, /2600-Coord-x\.md/);
        assert.match(e.message, /stage: specced/);
        return true;
      },
    );
  } finally {
    s.cleanup();
  }
});

test('2587 Check A: the reverse direction — `stage: stub` + `**Status:** READY` is REFUSED', () => {
  const s = makeOrigin();
  try {
    const rel = writePlan(
      s.dir,
      'waiting-blocked',
      '2601-Coord-x.md',
      `---\nsummary: 'x'\nstage: stub\n---\n\n# 2601\n\n**Status:** 📋 READY — opened 2026-07-27.\n`,
    );
    assert.throws(
      () => assertBoardInvariants(s.dir, [rel], { tool: 'edit-plan' }),
      (e) => {
        assert.equal(e.boardInvariantViolations[0].kind, 'stage-status-prose');
        assert.match(e.message, /stage: stub/);
        return true;
      },
    );
  } finally {
    s.cleanup();
  }
});

test('2587 Check A: clean combinations never violate', () => {
  assert.deepEqual(
    findStageStatusProseViolations([
      {
        path: 'x/2602.md',
        basename: '2602.md',
        content: `---\nstage: specced\n---\n\n**Status:** 📋 SPECCED — done.\n`,
      },
    ]),
    [],
  );
  assert.deepEqual(
    findStageStatusProseViolations([
      {
        path: 'x/2603.md',
        basename: '2603.md',
        content: `---\nstage: specced\n---\n\n**Status:** 🔄 IN PROGRESS — picked up.\n`,
      },
    ]),
    [],
  );
  assert.deepEqual(
    findStageStatusProseViolations([
      {
        path: 'x/2604.md',
        basename: '2604.md',
        content: `---\nstage: specced\n---\n\n# no status line here\n`,
      },
    ]),
    [],
  );
});

// --- plan 2587 Check B: stamp-value contradiction (WARN-ONLY) -------------------------

const CLOUD_BANNER = (v) => `> ☁️ **cloudExec: ${v}** — already stamped.`;

test('2587 Check B: the 2576-shaped false positive (own banner clean, task bullet about OTHER plans) is CLEAN', () => {
  const content = [
    '---',
    "summary: 'x'",
    'cloudExec: false',
    '---',
    '',
    '# 2576',
    '',
    CLOUD_BANNER('false'),
    '',
    '1. the re-stamp sweep flips at least the ready-lane members of the measured bucket to `cloudExec: true`',
  ].join('\n');
  assert.deepEqual(
    findStampProseContradictions([{ path: 'x/2576.md', basename: '2576.md', content }]),
    [],
  );
  const s = makeOrigin();
  try {
    const rel = writePlan(s.dir, 'ready', '2576-FABLE-Infra-x.md', content);
    assert.deepEqual(assertBoardInvariants(s.dir, [rel], { tool: 'edit-plan' }), []);
  } finally {
    s.cleanup();
  }
});

test('2587 Check B: the 2384-shaped false positive (own banner clean, ordinary prose about OTHER plans) is CLEAN', () => {
  const content = [
    '---',
    "summary: 'x'",
    'cloudExec: false',
    '---',
    '',
    '# 2384',
    '',
    CLOUD_BANNER('false'),
    '',
    'A Places-dependent plan needs to run with `cloudExec: true`.',
  ].join('\n');
  assert.deepEqual(
    findStampProseContradictions([{ path: 'x/2384.md', basename: '2384.md', content }]),
    [],
  );
});

test('2587 Check B: a 2010-shaped verdict-paragraph contradiction is a WARNING, never a throw', () => {
  const content = [
    '---',
    "summary: 'x'",
    'cloudExec: true',
    '---',
    '',
    '# 2010',
    '',
    '**Spec-pass verdict (twenty-eighth board-pass @ eb8a64ef3):** execModel sonnet; cloudExec false (already stamped).',
  ].join('\n');
  const findings = findStampProseContradictions([
    { path: 'x/2010.md', basename: '2010.md', content },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].key, 'cloudExec');
  assert.equal(findings[0].asserted, 'false');
  assert.equal(findings[0].stamped, 'true');

  const s = makeOrigin();
  try {
    const rel = writePlan(s.dir, 'waiting-date', '2010-Infra-x.md', content);
    // WARN-only: the gate must NOT throw for this — it only console.warns.
    assert.deepEqual(assertBoardInvariants(s.dir, [rel], { tool: 'edit-plan' }), []);
  } finally {
    s.cleanup();
  }
});

// plan 3341: before the execModel check's alternation widened to include `sol`, this genuine
// drift (prose says sol, stamp says sonnet) was UNCOMPARABLE — the regex simply never matched
// "execModel sol", so no finding was EVER raised for it. Widening makes the comparison
// possible; it stays warn-only either way.
test('plan 3341: execModel: sol in prose is now recognized and compared, not permanently invisible', () => {
  const drifted = [
    '---',
    "summary: 'x'",
    'execModel: sonnet',
    'cloudExec: true',
    '---',
    '',
    '# 3341',
    '',
    '**Spec-pass verdict (…):** execModel sol; cloudExec true (already stamped).',
  ].join('\n');
  const findings = findStampProseContradictions([
    { path: 'x/3341.md', basename: '3341.md', content: drifted },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].key, 'execModel');
  assert.equal(findings[0].asserted, 'sol');
  assert.equal(findings[0].stamped, 'sonnet');

  // A sol plan's OWN honest verdict prose, matching its own stamp, stays clean.
  const clean = [
    '---',
    "summary: 'x'",
    'execModel: sol',
    'cloudExec: true',
    '---',
    '',
    '# 3341',
    '',
    '**Spec-pass verdict (…):** execModel sol; cloudExec true (already stamped).',
  ].join('\n');
  assert.deepEqual(
    findStampProseContradictions([{ path: 'x/3341.md', basename: '3341.md', content: clean }]),
    [],
  );
});

// plan 3943: the shared SPEC_VERDICT_MARKER_RX (hoisted to build-index-lib.mjs) was
// widened to ALSO recognize the canonical `## Spec-pass verdict` H2 heading — the form a
// `stage: specced` stamp now requires (plan-promotable-lib.mjs's blocker) — alongside the
// pre-3943 bold-paragraph form exercised above. Check B must keep scanning that region
// for a stamp-contradicting assertion regardless of which form the plan uses.
test('3943: an H2 `## Spec-pass verdict` heading is ALSO recognized by Check B (widened marker)', () => {
  const content = [
    '---',
    "summary: 'x'",
    'cloudExec: true',
    '---',
    '',
    '# 3943',
    '',
    '## Spec-pass verdict (fixture)',
    'execModel sonnet; cloudExec false (already stamped).',
  ].join('\n');
  const findings = findStampProseContradictions([
    { path: 'x/3943.md', basename: '3943.md', content },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].key, 'cloudExec');
  assert.equal(findings[0].asserted, 'false');
  assert.equal(findings[0].stamped, 'true');

  // The plan's own honest verdict prose, matching its own stamp, stays clean.
  const clean = content.replace('cloudExec false', 'cloudExec true');
  assert.deepEqual(
    findStampProseContradictions([{ path: 'x/3943.md', basename: '3943.md', content: clean }]),
    [],
  );
});

// plan 3943 review round 1 (CONFIRMED): the test above fused the heading and the
// contradicting sentence into ONE blank-line-delimited paragraph, which is not the
// canonical shape. A real `## Spec-pass verdict` section is a heading, a BLANK LINE, then
// bullets — and stampProseRegions used to collect one PARAGRAPH per marker match, so the
// widened H2 marker matched the heading's paragraph (the heading line alone) and Check B
// scanned nothing at all. The widening would have silently DISABLED the check for exactly
// the form it was widened to recognize. The region for an H2 marker must be the whole
// section, bounded at the next same-or-shallower heading.
test('3943: an H2 verdict section is scanned through its BODY, not just its heading line', () => {
  const content = [
    '---',
    "summary: 'x'",
    'cloudExec: true',
    'execModel: sonnet',
    '---',
    '',
    '# 3943',
    '',
    '## Spec-pass verdict (2026-09-11, fable-5.1/high)',
    '',
    '- **C1 premises: PASS.** Verified against origin/master.',
    '- **execModel litmus.** Every judgment call is made above. **`execModel: fable`**.',
    '',
  ].join('\n');
  const findings = findStampProseContradictions([
    { path: 'x/3943.md', basename: '3943.md', content },
  ]);
  assert.equal(findings.length, 1, 'the contradiction two lines below the heading must be seen');
  assert.equal(findings[0].key, 'execModel');
  assert.equal(findings[0].asserted, 'fable');
  assert.equal(findings[0].stamped, 'sonnet');
});

test('3943: an H2 verdict section stops at the next H2 — later prose is NOT scanned', () => {
  const content = [
    '---',
    "summary: 'x'",
    'cloudExec: true',
    '---',
    '',
    '## Spec-pass verdict (fixture)',
    '',
    '- **C1 premises: PASS.**',
    '',
    '## Not in this plan',
    '',
    '- Anything asserting cloudExec false out here is OUTSIDE the verdict region.',
    '',
  ].join('\n');
  assert.deepEqual(
    findStampProseContradictions([{ path: 'x/3943.md', basename: '3943.md', content }]),
    [],
  );
});

test('3943: a verdict heading inside a FENCED example is not a verdict region', () => {
  const content = [
    '---',
    "summary: 'x'",
    'cloudExec: true',
    '---',
    '',
    '# 3943',
    '',
    'The stamp now requires a section shaped like this:',
    '',
    '```md',
    '## Spec-pass verdict (date, model/effort)',
    '',
    '- **C1 premises: PASS.** cloudExec false in this ILLUSTRATION only.',
    '```',
    '',
  ].join('\n');
  assert.deepEqual(
    findStampProseContradictions([{ path: 'x/3943.md', basename: '3943.md', content }]),
    [],
    'a fenced documentation example must not be read as this plan asserting a stamp',
  );
});

test('3943: the LEGACY bold-paragraph verdict stays PARAGRAPH-scoped, not widened to the next H2', () => {
  // Widening the legacy form's region alongside the heading form would change what Check B
  // warns on for every pre-3943 plan — a behaviour change this plan never asked for.
  const content = [
    '---',
    "summary: 'x'",
    'cloudExec: true',
    '---',
    '',
    '**Spec-pass verdict (legacy form):** C1 PASS.',
    '',
    'A separate later paragraph saying cloudExec false is outside the legacy region.',
    '',
  ].join('\n');
  assert.deepEqual(
    findStampProseContradictions([{ path: 'x/3943.md', basename: '3943.md', content }]),
    [],
  );
});

test('3943 [review-2]: a SECOND verdict block is scanned too — Check B never dropped to one region', () => {
  // The pre-3943 paragraph loop pushed one region per matching paragraph. Collapsing to a
  // single region would stop scanning a re-verdict block appended by a later pass.
  const content = [
    '---',
    "summary: 'x'",
    'cloudExec: true',
    '---',
    '',
    '**Spec-pass verdict (superseded):** C1 PASS.',
    '',
    '## Spec-pass verdict (re-verdict)',
    '',
    '- cloudExec false, says this later block.',
    '',
  ].join('\n');
  const findings = findStampProseContradictions([
    { path: 'x/3943.md', basename: '3943.md', content },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].key, 'cloudExec');
  assert.equal(findings[0].asserted, 'false');
});

test('3943 [review-3]: a fenced illustration INSIDE a real verdict region is not a stamp assertion', () => {
  // Round 2 stripped fences for the two content-judging checks but not for Check B, so a
  // verdict section showing an EXAMPLE of the shape would be read as this plan asserting
  // the stamp values in that example.
  const content = [
    '---',
    "summary: 'x'",
    'cloudExec: true',
    '---',
    '',
    '## Spec-pass verdict (fixture)',
    '',
    '- **C1 premises: PASS.**',
    '',
    'A sibling plan reads:',
    '',
    '```md',
    '- **cloudExec: false** — needs a local credential.',
    '```',
    '',
  ].join('\n');
  assert.deepEqual(
    findStampProseContradictions([{ path: 'x/3943.md', basename: '3943.md', content }]),
    [],
  );
});

test("3943 [review-4]: a FENCED cloud banner is an example, not this plan's own stamp prose", () => {
  const content = [
    '---',
    "summary: 'x'",
    'cloudExec: true',
    '---',
    '',
    '# 3943',
    '',
    'A plan that cannot run in the cloud carries:',
    '',
    '```md',
    '> \u2601\ufe0f **cloudExec: false** \u2014 needs a local credential.',
    '```',
    '',
  ].join('\n');
  assert.deepEqual(
    findStampProseContradictions([{ path: 'x/3943.md', basename: '3943.md', content }]),
    [],
  );
});

test('2587: write-scoping preserved — a stage-status-prose violation in a plan NOT in this write is never reported', () => {
  const s = makeOrigin();
  try {
    // Someone else's pre-existing violation, already on master.
    writePlan(
      s.dir,
      'waiting-blocked',
      '2605-Coord-theirs.md',
      `---\nsummary: 'x'\nstage: specced\n---\n\n# 2605\n\n**Status:** 📋 stub — filed.\n`,
    );
    s.g('add', '-A');
    s.g('commit', '-qm', 'a sibling lands a violation');
    // My write touches an entirely different, clean plan.
    const mine = writePlan(s.dir, 'waiting-blocked', '2606-Coord-mine.md', properStub(2606));
    assert.deepEqual(assertBoardInvariants(s.dir, [mine], { tool: 'edit-plan' }), []);
  } finally {
    s.cleanup();
  }
});

test('2426 R2: gateAppliesToFolder marks exactly the folders an invariant can fire in', () => {
  // in-scope: the live-Blocked-by bucket + the stage/folder bucket.
  for (const f of ['ready', 'in-progress', 'pending-approval']) {
    assert.equal(gateAppliesToFolder(f), true, `${f} must be gated`);
  }
  // out of scope: every waiting lane (a Blocked-by there is the REQUIRED header), archive/,
  // and parked/. This is what keeps drain-run's four park callers out of the blast radius.
  for (const f of [
    'waiting-blocked',
    'waiting-operator',
    'waiting-date',
    'waiting-trip',
    'waiting-grill',
    'archive',
    'parked',
    null,
  ]) {
    assert.equal(gateAppliesToFolder(f), false, `${f} must NOT be gated`);
  }
});

// --- plan 2892: the strict-improvement rule -----------------------------------------
//
// The deadlock these cover: `stamp-exec-model --spec-review` flips `stage: specced` on a
// plan resting in pending-approval/ without touching its body, stacking the stage/folder
// violation on top of whatever body defect was already there. Before this rule, edit-plan
// refused the write that FIXES the body defect (the stage/folder violation outlives it)
// and move-plan refused the route-out (the body defect outlives it) — each tool's fix
// menu prescribing the other. Fired ≥7 times, 2026-07-30..08-04.

// specced + a STUB Status line = TWO violations at once in pending-approval/:
// stage-folder AND stage-status-prose. This is the exact wedged shape.
const wedged = (id) =>
  `---\nsummary: 'x'\nstage: specced\nspecReview: abc1234\n---\n\n# ${id} wedged\n\n` +
  `**Status:** 📋 STUB — filed.\n`;
// The same plan with ONLY the Status prose fixed — still specced-in-pending-approval.
const wedgedProseFixed = (id) =>
  `---\nsummary: 'x'\nstage: specced\nspecReview: abc1234\n---\n\n# ${id} wedged\n\n` +
  `**Status:** 📋 READY — filed.\n`;

test('2892: a write that clears ONE of two stacked violations is ADMITTED (the unwedge)', () => {
  const s = makeOrigin();
  try {
    const rel = writePlan(s.dir, 'pending-approval', '2820-Coord-x.md', wedged(2820));
    s.g('add', '-A');
    s.g('commit', '-qm', 'the wedged pre-state reaches master');
    // pre = {stage-folder, stage-status-prose}; the edit fixes only the prose.
    writeFileSync(join(s.dir, rel), wedgedProseFixed(2820));
    const remaining = assertBoardInvariants(s.dir, [rel], { tool: 'edit-plan' });
    // Admitted, and it REPORTS what still stands rather than swallowing it.
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].kind, 'stage-folder');
  } finally {
    s.cleanup();
  }
});

test('2892: the improvement survives the plan MOVING folder (pre-image is keyed by id)', () => {
  const s = makeOrigin();
  try {
    writePlan(s.dir, 'pending-approval', '2821-Coord-x.md', wedged(2821));
    s.g('add', '-A');
    s.g('commit', '-qm', 'wedged in pending-approval');
    // move-plan's shape: same id, new folder, body still carrying the STUB prose. The
    // stage/folder violation is gone (ready/ is out of its scope) — one violation left,
    // strictly fewer than the two at HEAD, so the route-out is admitted.
    const moved = writePlan(s.dir, 'ready', '2821-Coord-x.md', wedged(2821));
    rmSync(join(s.dir, `${PLANS}/pending-approval/2821-Coord-x.md`));
    const remaining = assertBoardInvariants(s.dir, [moved], { tool: 'move-plan' });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].kind, 'stage-status-prose');
  } finally {
    s.cleanup();
  }
});

test('2892: a write that changes NOTHING the gate sees is still REFUSED (equal set)', () => {
  const s = makeOrigin();
  try {
    const rel = writePlan(s.dir, 'pending-approval', '2822-Coord-x.md', wedged(2822));
    s.g('add', '-A');
    s.g('commit', '-qm', 'wedged');
    // An edit that touches only prose the gate does not judge: pre === post.
    writeFileSync(join(s.dir, rel), wedged(2822).replace('# 2822 wedged', '# 2822 wedged more'));
    assert.throws(
      () => assertBoardInvariants(s.dir, [rel], { tool: 'edit-plan' }),
      (e) => {
        assert.ok(e instanceof BoardInvariantError);
        assert.equal(e.boardInvariantViolations.length, 2);
        // the refusal explains that clearing ONE of them would have been enough
        assert.match(e.message, /Stacked violations are NOT a deadlock/);
        return true;
      },
    );
  } finally {
    s.cleanup();
  }
});

test('2892: a write that ADDS a violation on top of an existing one is REFUSED', () => {
  const s = makeOrigin();
  try {
    const rel = writePlan(
      s.dir,
      'pending-approval',
      '2823-Coord-x.md',
      `---\nsummary: 'x'\nstage: specced\n---\n\n# 2823\n`,
    );
    s.g('add', '-A');
    s.g('commit', '-qm', 'one violation on master');
    // pre = {stage-folder}; post = {stage-folder, stage-status-prose} — strictly worse.
    writeFileSync(join(s.dir, rel), wedged(2823));
    assert.throws(
      () => assertBoardInvariants(s.dir, [rel], { tool: 'edit-plan' }),
      (e) => {
        assert.equal(e.boardInvariantViolations.length, 2);
        return true;
      },
    );
  } finally {
    s.cleanup();
  }
});

test('2892: an equal-COUNT substitution is REFUSED (violation SET, not count)', () => {
  const s = makeOrigin();
  try {
    // A real, OPEN blocker so the post-state's Blocked-by line classifies as LIVE.
    writePlan(s.dir, 'in-progress', '2700-Pipe-y.md', properStub(2700));
    // pre: stage: stub + a READY Status line in ready/ = {stage-status-prose}, count 1.
    const rel = writePlan(
      s.dir,
      'ready',
      '2824-Coord-x.md',
      `---\nsummary: 'x'\nstage: stub\n---\n\n# 2824\n\n**Status:** 📋 READY — filed.\n`,
    );
    s.g('add', '-A');
    s.g('commit', '-qm', 'one violation on master');
    // post: prose fixed, but a live Blocked-by acquired = {live-blocked-by}, also count 1.
    writeFileSync(
      join(s.dir, rel),
      `---\nsummary: 'x'\nstage: stub\n---\n\n# 2824\n\n**Status:** 📋 STUB — filed.\n\n` +
        `**Blocked-by:** plan 2700 — lands first\n`,
    );
    assert.throws(
      () => assertBoardInvariants(s.dir, [rel], { tool: 'edit-plan' }),
      (e) => {
        assert.equal(e.boardInvariantViolations.length, 1);
        assert.equal(e.boardInvariantViolations[0].kind, 'live-blocked-by');
        return true;
      },
    );
  } finally {
    s.cleanup();
  }
});

test('2892: a plan with NO pre-image (a fresh mint) can never claim an improvement', () => {
  const s = makeOrigin();
  try {
    // Never committed — HEAD has no 2825 at all, so its pre-set is empty and the
    // single post-state violation cannot be a strict subset of it.
    const rel = writePlan(s.dir, 'pending-approval', '2825-Coord-x.md', wedged(2825));
    assert.throws(
      () => assertBoardInvariants(s.dir, [rel], { tool: 'next-plan-id claim' }),
      BoardInvariantError,
    );
  } finally {
    s.cleanup();
  }
});

test('2892: isStrictImprovement is a strict-subset test on the gate’s own kinds', () => {
  const K = (...k) => new Set(k);
  // at least one removed, none added
  assert.equal(
    isStrictImprovement(K('stage-folder', 'stage-status-prose'), K('stage-folder')),
    true,
  );
  assert.equal(isStrictImprovement(K('stage-folder'), K()), true);
  // nothing removed
  assert.equal(isStrictImprovement(K('stage-folder'), K('stage-folder')), false);
  // added
  assert.equal(isStrictImprovement(K('stage-folder'), K('stage-folder', 'live-blocked-by')), false);
  // substituted at equal count
  assert.equal(isStrictImprovement(K('stage-folder'), K('live-blocked-by')), false);
  // no pre-image
  assert.equal(isStrictImprovement(K(), K('stage-folder')), false);
});

test('2892: violationKeys reduces the gate’s violation list to its kind vocabulary', () => {
  assert.deepEqual(
    [
      ...violationKeys([
        { kind: 'stage-folder', detail: 'x' },
        { kind: 'live-blocked-by', detail: 'y' },
      ]),
    ],
    ['stage-folder', 'live-blocked-by'],
  );
  assert.deepEqual([...violationKeys([])], []);
  assert.deepEqual([...violationKeys(null)], []);
});
