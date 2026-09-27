// scripts/orchestrate-dryrun.test.mjs — unit tests for the $0 dry-run harness
// (plan 916, component 1). Pure core only (no fs/git/clock): scenario, fake sha,
// the control loop, resume, the stop path, and the journal-consistency assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultScenario,
  fakeMergeSha,
  simulateLoop,
  assertJournalConsistent,
} from './orchestrate-dryrun.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATE_DRYRUN = join(HERE, 'orchestrate-dryrun.mjs');

// Invoke the real CLI against a throwaway fake "main" checkout (COORD_MAIN_DIR overrides
// resolveMain() unconditionally — coord-git.mjs's plan-971 escape hatch — so this never touches
// the real shared repo, and a nonexistent `<dir>/docs/superpowers/plans/ready` is fine: `source:
// 'tree'` degrades an absent readyDir to an empty metas array rather than throwing).
function runOrchestrateDryrun(extraArgs, { coordMainDir }) {
  try {
    const stdout = execFileSync(process.execPath, [ORCHESTRATE_DRYRUN, ...extraArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, COORD_MAIN_DIR: coordMainDir },
    });
    return { code: 0, stdout, json: JSON.parse(stdout) };
  } catch (e) {
    const stdout = e.stdout?.toString() ?? '';
    let json = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      /* non-JSON error */
    }
    return { code: e.status ?? 1, stdout, json, stderr: e.stderr?.toString() ?? '' };
  }
}

// 4 candidates so the index-cycling default scenario hits every branch.
function candidates(n = 4) {
  return Array.from({ length: n }, (_, i) => ({
    slug: `90${i}-Test-plan-${i}`,
    path: `docs/superpowers/plans/ready/90${i}-Test-plan-${i}.md`,
    seedWrite: i === 0 ? 'yes' : 'no', // first is 🟥 → heavy verify tier
    cost: { usd: 0 },
  }));
}

test('fakeMergeSha is deterministic, slug-derived, and dryrun-prefixed', () => {
  assert.equal(fakeMergeSha('abc'), fakeMergeSha('abc'));
  assert.notEqual(fakeMergeSha('abc'), fakeMergeSha('abd'));
  assert.match(fakeMergeSha('900-x'), /^dryrun-[0-9a-f]{8}$/);
});

test('defaultScenario cycles all four worker branches by index', () => {
  assert.deepEqual(defaultScenario({}, 0), { worker: 'completed', verdict: 'land' });
  assert.deepEqual(defaultScenario({}, 1), { worker: 'blocked' });
  assert.deepEqual(defaultScenario({}, 2), { worker: 'needs_decision', resolvable: true });
  assert.deepEqual(defaultScenario({}, 3), { worker: 'needs_decision', resolvable: false });
});

test('simulateLoop walks the whole queue and records every branch', () => {
  const { journal, dispatched, stoppedForResume } = simulateLoop({ candidates: candidates(4) });
  assert.equal(dispatched, 4);
  assert.equal(stoppedForResume, false);
  // idx0 completed→land, idx2 needs_decision-resolved→land  => 2 landed
  assert.equal(journal.plans_landed.length, 2);
  assert.equal(journal.pending_deploy.length, 2); // each land → pending_deploy, none deployed
  // idx1 blocked, idx3 needs_decision-unresolved → 2 blocked + 2 parked questions
  assert.equal(journal.plans_blocked.length, 2);
  assert.equal(journal.parked_questions.length, 2);
  assert.equal(journal.iterations, 4);
});

test('every landed plan carries a mergeSha and a matching pending_deploy', () => {
  const { journal } = simulateLoop({ candidates: candidates(4) });
  for (const p of journal.plans_landed) {
    assert.ok(p.mergeSha, 'mergeSha present');
    assert.ok(journal.pending_deploy.some((d) => d.slug === p.slug && d.mergeSha === p.mergeSha));
  }
});

test('a clean run passes the journal-consistency assertion', () => {
  const { journal, dispatched } = simulateLoop({ candidates: candidates(4) });
  const check = assertJournalConsistent(journal, { dispatchedThisRun: dispatched });
  assert.equal(check.ok, true, check.errors.join('; '));
});

test('heavy verify tier fires for a 🟥 seed-write candidate', () => {
  const { trace } = simulateLoop({ candidates: candidates(4) });
  const seedVerify = trace.find(
    (t) => t.slug?.startsWith('900-') && t.event?.startsWith('verify:'),
  );
  assert.equal(seedVerify.riskTier, 'heavy');
  const cleanVerify = trace.find(
    (t) => t.slug?.startsWith('902-') && t.event?.startsWith('verify:'),
  );
  assert.equal(cleanVerify.riskTier, 'light');
});

test('window stop path: --stop-after style paceSequence stops and flags resume', () => {
  const { journal, dispatched, stoppedForResume } = simulateLoop({
    candidates: candidates(4),
    paceSequence: ['dispatch', 'dispatch', 'stop'],
  });
  assert.equal(stoppedForResume, true);
  assert.equal(dispatched, 2); // only two dispatched before the stop
  const lastSnap = journal.window_snapshots.at(-1);
  assert.equal(lastSnap.decision, 'stop');
});

test('resume from a journal continues without re-picking landed/parked plans', () => {
  // window 1: stop after 2
  const w1 = simulateLoop({
    candidates: candidates(4),
    paceSequence: ['dispatch', 'dispatch', 'stop'],
  });
  assert.equal(w1.dispatched, 2);
  // window 2: resume from w1's journal, run the rest
  const w2 = simulateLoop({ candidates: candidates(4), startState: w1.journal });
  assert.equal(w2.dispatched, 2); // only the remaining two
  assert.equal(w2.journal.iterations, 4); // cumulative across windows
  // no double-pick: 2 landed + 2 blocked total, each slug once
  const all = [
    ...w2.journal.plans_landed.map((p) => p.slug),
    ...w2.journal.plans_blocked.map((p) => p.slug),
  ];
  assert.equal(new Set(all).size, all.length);
  assert.equal(new Set(all).size, 4);
});

test('hold winds the window down with nothing dispatched', () => {
  const { dispatched, trace } = simulateLoop({
    candidates: candidates(4),
    paceSequence: ['hold'],
  });
  assert.equal(dispatched, 0);
  assert.ok(trace.some((t) => t.event === 'hold_winddown'));
});

test('empty queue exhausts immediately, passes assertion', () => {
  const { journal, dispatched, trace } = simulateLoop({ candidates: [] });
  assert.equal(dispatched, 0);
  assert.ok(trace.some((t) => t.event === 'queue_exhausted'));
  assert.equal(assertJournalConsistent(journal, { dispatchedThisRun: 0 }).ok, true);
});

test('assertJournalConsistent catches a land with no pending_deploy', () => {
  const bad = {
    plans_landed: [{ slug: 'x', mergeSha: 'abc' }],
    plans_blocked: [],
    lands_parked: [],
    parked_questions: [],
    pending_deploy: [], // missing!
  };
  const check = assertJournalConsistent(bad, {});
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => /missing from pending_deploy/.test(e)));
});

test('assertJournalConsistent catches a blocked plan with no parked_question', () => {
  const bad = {
    plans_landed: [],
    plans_blocked: [{ slug: 'y' }],
    lands_parked: [],
    parked_questions: [], // missing!
    pending_deploy: [],
  };
  const check = assertJournalConsistent(bad, {});
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => /no parked_question/.test(e)));
});

test('assertJournalConsistent catches a plan in both plans_skipped and a terminal bucket', () => {
  const bad = {
    plans_landed: [{ slug: 'w', mergeSha: 'a' }],
    plans_blocked: [],
    lands_parked: [],
    plans_skipped: [{ slug: 'w' }], // same slug landed AND skipped (corrupt resume journal)
    parked_questions: [],
    pending_deploy: [{ slug: 'w', mergeSha: 'a' }],
  };
  const check = assertJournalConsistent(bad, {});
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => /two terminal buckets/.test(e)));
});

test('assertJournalConsistent catches a plan in two terminal buckets', () => {
  const bad = {
    plans_landed: [{ slug: 'z', mergeSha: 'a' }],
    plans_blocked: [{ slug: 'z' }],
    lands_parked: [],
    parked_questions: [{ slug: 'z', question: 'q' }],
    pending_deploy: [{ slug: 'z', mergeSha: 'a' }],
  };
  const check = assertJournalConsistent(bad, {});
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => /two terminal buckets/.test(e)));
});

// ── plan 3816 fix round (review Fix 4): bare `--ready` (no value) pre-existing crash ──────────
// `parseDryrunFlags` renders a valueless `--ready` (nothing follows it, or the next token is
// itself a `--flag`) as boolean `true`. Before this fix, `repoRoot = flags.ready ? null :
// resolveMain()` set `repoRoot` to `null` for THAT shape too (not just an explicit `--ready
// <path>`), so joining that null repoRoot into the real ready-dir path threw
// `ERR_INVALID_ARG_TYPE` before selection ever ran — the documented invocation
// `node scripts/orchestrate-dryrun.mjs --ready` died immediately. Confirmed pre-existing; fixed
// because it is one line, in a file this plan already touches, and rides this land.

test('CLI: a bare `--ready` (no value) crashes on current-behavior fixtures with ERR_INVALID_ARG_TYPE — RED before the fix, GREEN after', () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'orch-dryrun-bare-ready-'));
  const journalPath = join(tmpRepo, 'dryrun-journal.json');
  try {
    const res = runOrchestrateDryrun(
      ['--ready', '--journal', journalPath, '--cache', join(tmpRepo, 'no-such-cache.json')],
      { coordMainDir: tmpRepo },
    );
    // GREEN: exits 0, prints a parseable report, and never touched a real repo (COORD_MAIN_DIR
    // pointed it at an empty throwaway dir, so `source: 'tree'` finds no ready/ and reports 0
    // eligible candidates — the crash-fix acceptance is "it runs at all", not any particular
    // count).
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.ok(res.json, `expected parseable JSON on stdout; stdout=${res.stdout}`);
    assert.equal(res.json.eligibleCount, 0);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('CLI: an explicit `--ready <path>` (a string value) is UNCHANGED — still repo-less fixture/tree mode, no COORD_MAIN_DIR needed', () => {
  const readyDir = mkdtempSync(join(tmpdir(), 'orch-dryrun-explicit-ready-'));
  const journalPath = join(readyDir, 'dryrun-journal.json');
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        ORCHESTRATE_DRYRUN,
        '--ready',
        readyDir,
        '--journal',
        journalPath,
        '--cache',
        join(readyDir, 'no-such-cache.json'),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const report = JSON.parse(stdout);
    assert.equal(report.eligibleCount, 0, 'an empty explicit ready dir still reports cleanly');
  } finally {
    rmSync(readyDir, { recursive: true, force: true });
  }
});
