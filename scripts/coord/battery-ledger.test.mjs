// scripts/battery-ledger.test.mjs — unit + CLI + real-node:test-reporter tests for the per-file
// green ledger (plan 3223).
//
// The invariant every case defends: A FILE IS NEVER READ AS GREEN UNLESS A COMPLETE,
// UNAMBIGUOUS "this file passed" SIGNAL REACHED DISK — a truncated write, a corrupt entry, an
// expired ledger, a malformed key, or any fs/git trouble all degrade to "no ledger, run
// everything" (mirrors pass-cache-kernel.mjs's own documented fail direction). The back half of
// this file (search EMPIRICAL) re-verifies, against the REAL node:test runner on whatever node
// this suite actually runs under, the two facts battery-ledger-reporter.mjs's own header pins:
// that a node:test custom reporter — unlike TAP — carries a genuine per-file pass signal, and how
// to identify that file-level event correctly under this repo's actual (relative-path) invocation
// shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import {
  resolveLedgerDir,
  resolvePytestLedgerDir,
  LEDGER_ARG_SPEC,
  parseTruncationSafeJsonLines,
  parseLedgerEvents,
  parsePytestLedgerEvents,
  combinePytestLedgerEventGroups,
  resolvePytestLedgerEventSources,
  readPytestLedgerEventSources,
  parsePytestLedgerEventSources,
  greenPytestFiles,
  toPosixRelative,
  readGreenSet,
  mergeGreenFiles,
  readDurations,
  remainingSelection,
  // plan 3318 — chunk convergence: the stall signal, its persistence, and the ordering it drives.
  stalledPytestFiles,
  slowDeselectedPytestFiles,
  mergeStalledFiles,
  readStallCounts,
  // plan 3374: the consecutive zero-progress round counter — the non-convergence seam's evidence.
  readZeroRounds,
  recordChunkRound,
  NON_CONVERGENT_ROUNDS,
  orderStalledLast,
  // plan 3620: the push-side port — scored by banked-set fingerprint, not a round-local diff.
  fingerprintGreenSet,
  scoreChunkRoundByGreenMark,
  // plan 3620 fix round: G2/G2b truncation-safe event counting, G3's sentinel constant, G6's
  // read-failure-vs-absence diagnostic.
  countLedgerEvents,
  countPytestLedgerEvents,
  CHUNK_ROUND_NONCONVERGENT_SENTINEL,
  MERGE_PERSISTED_SENTINEL,
  readLedgerEntryDiagnostic,
  // plan 3225 (Fix A) — delta-scoped carry-forward.
  isCommitOid,
  verifiedHead,
  findCarryForwardBaseline,
  changedFilesBetween,
  unmappedClosurePaths,
  parsePytestSelectorOutput,
  computeCarriedGreen,
  planCarryForward,
  BATTERY_UNMAPPED_CLOSURE,
  pytestClosureFor,
  runPytestSelector,
  REPORTER_SPECIFIER,
  // The stand-in reporter runFullBatteryPreflight re-attaches; the EMPIRICAL test at the bottom
  // of this file is what pins it to node's own behaviour, so it is imported rather than
  // re-spelled. Relocated here from done-worktree-lib.mjs by plan 3962 Decision 5.
  defaultNonTtyReporter,
} from './battery-ledger.mjs';
import { DEFAULT_TTL_MIN } from './pass-cache-kernel.mjs';
// plan 3225: the two sources BATTERY_UNMAPPED_CLOSURE / PYTEST_CLOSURE are pinned AGAINST, so a
// future widening of either closure fails a test here instead of silently narrowing a land gate.
import { keyedPaths } from './battery-pass-cache.mjs';
import { EXTERNAL_TREE_PREFIXES } from './select-battery-tests.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';

// plan 4071 T4/D5: PYTEST_CLOSURE is no longer a module-level export — it is derived from a
// `gates` row (the same shape gatesFrom(loadCoordConfig(...)) produces) via `pytestClosureFor`.
// plan 3958: this module ships as-is into the public coord-kit (scripts/coord/ is copied
// wholesale), so — like coord-git.test.mjs's COORD_CHECKOUT_EXCLUDED_TOP_LEVEL fixture — GATES
// and the pytest selector below are a FIXED, portable snapshot of vetapp's real
// coord.config.json row at the time of this change, not read from THIS repo's real config: a
// shipped core test must be true in any repo, including the kit itself, whose coord.config.json
// carries no `gates`/`pytestSelector` rows at all.
const GATES = {
  'pytest-backend-scripts': {
    desc: 'python -m pytest backend/scripts',
    paths: [
      'backend/scripts',
      'backend/src/data',
      'shared/src',
      'backend/scripts/requirements.txt',
    ],
  },
};
const PYTEST_CLOSURE = pytestClosureFor(GATES);

const CLI = resolve(import.meta.dirname, 'battery-ledger.mjs');
// Same fixed-fixture rationale as GATES above.
const VETAPP_PYTEST_SELECTOR = {
  prefix: 'backend/scripts/',
  script: 'backend/scripts/_select_tests.py',
};
// Imported, never rebuilt here: these cases must spawn the SAME reporter specifier the land
// preflight does, or a relocation could leave this file green against a path production no longer
// uses. See REPORTER_SPECIFIER's own comment in battery-ledger.mjs for why it is a file:// URL.
const REPORTER = REPORTER_SPECIFIER;
const ISO = '2026-08-16T10:00:00.000Z';
const at = (min) => Date.parse(ISO) + min * 60000;

// --- pure: parseTruncationSafeJsonLines (plan 3223 review round: finding 10/CONFIRMED) ---------
//
// The shared scaffolding parseLedgerEvents and parsePytestLedgerEvents both build on — pinned
// directly so a future edit to ONE of those two callers cannot silently re-fork the truncation
// contract by inlining its own copy again.

test('parseTruncationSafeJsonLines: a well-formed multi-line stream yields one object per line, in order', () => {
  const text = [JSON.stringify({ a: 1 }), JSON.stringify({ a: 2 }), ''].join('\n');
  assert.deepEqual(parseTruncationSafeJsonLines(text), [{ a: 1 }, { a: 2 }]);
});

test('parseTruncationSafeJsonLines: the LAST segment is unconditionally dropped, even when it is itself valid JSON with no trailing newline', () => {
  // The load-bearing property this whole feature depends on: the function never inspects WHETHER
  // the trailing segment parses before dropping it — a lucky-looking partial write must never
  // sneak through as evidence, in EITHER caller.
  const text = JSON.stringify({ a: 1 }) + '\n' + JSON.stringify({ a: 2 }); // a: 2 has no trailing \n
  assert.deepEqual(parseTruncationSafeJsonLines(text), [{ a: 1 }]);
});

test('parseTruncationSafeJsonLines: a corrupt middle line is skipped without poisoning its siblings', () => {
  const text = [JSON.stringify({ a: 1 }), 'not valid json {{{', JSON.stringify({ a: 3 }), ''].join(
    '\n',
  );
  assert.deepEqual(parseTruncationSafeJsonLines(text), [{ a: 1 }, { a: 3 }]);
});

test('parseTruncationSafeJsonLines: empty/undefined input yields an empty array, never throws', () => {
  assert.deepEqual(parseTruncationSafeJsonLines(''), []);
  assert.deepEqual(parseTruncationSafeJsonLines(undefined), []);
});

// --- pure: parseLedgerEvents (truncation safety) --------------------------------------------

test('parseLedgerEvents: a well-formed two-file stream separates passed from failed', () => {
  const text =
    JSON.stringify({ file: '/repo/scripts/a.test.mjs', passed: true }) +
    '\n' +
    JSON.stringify({ file: '/repo/scripts/b.test.mjs', passed: false }) +
    '\n';
  const { passed, failed } = parseLedgerEvents(text);
  assert.deepEqual([...passed], ['/repo/scripts/a.test.mjs']);
  assert.deepEqual([...failed], ['/repo/scripts/b.test.mjs']);
});

test('parseLedgerEvents: a truncated LAST line (no terminating newline) is dropped, never green — complete siblings still count', () => {
  const complete = JSON.stringify({ file: '/repo/scripts/a.test.mjs', passed: true }) + '\n';
  const truncated = '{"file":"/repo/scripts/b.test.mjs","pas'; // killed mid-write, no trailing \n
  const { passed, failed } = parseLedgerEvents(complete + truncated);
  assert.deepEqual([...passed], ['/repo/scripts/a.test.mjs']);
  assert.equal(failed.size, 0);
  // The critical property: b never appears in EITHER set — dropped is dropped, not miscounted
  // as a failure either.
});

test('parseLedgerEvents: a truncated line that happens to be valid JSON but incomplete-looking text is still the trailing segment and is dropped', () => {
  // Even a technically-parseable trailing fragment with no terminating '\n' is treated as
  // untrustworthy — the module never inspects WHETHER the last segment parses before dropping
  // it, precisely so a lucky-looking partial write can never sneak through.
  const text = JSON.stringify({ file: '/repo/scripts/a.test.mjs', passed: true }); // no trailing \n at all
  const { passed, failed } = parseLedgerEvents(text);
  assert.equal(passed.size, 0);
  assert.equal(failed.size, 0);
});

test('parseLedgerEvents: a corrupt middle line is skipped without poisoning its siblings', () => {
  const text = [
    JSON.stringify({ file: '/repo/scripts/a.test.mjs', passed: true }),
    'not valid json at all {{{',
    JSON.stringify({ file: '/repo/scripts/c.test.mjs', passed: true }),
    '',
  ].join('\n');
  const { passed } = parseLedgerEvents(text);
  assert.deepEqual([...passed].sort(), ['/repo/scripts/a.test.mjs', '/repo/scripts/c.test.mjs']);
});

test('parseLedgerEvents: a line missing required fields is skipped', () => {
  const text = [
    JSON.stringify({ file: '/repo/scripts/a.test.mjs' }), // no `passed`
    JSON.stringify({ passed: true }), // no `file`
    JSON.stringify({ file: 42, passed: true }), // wrong type
    '',
  ].join('\n');
  const { passed, failed } = parseLedgerEvents(text);
  assert.equal(passed.size, 0);
  assert.equal(failed.size, 0);
});

test('parseLedgerEvents: empty input yields empty sets, never throws', () => {
  const { passed, failed } = parseLedgerEvents('');
  assert.equal(passed.size, 0);
  assert.equal(failed.size, 0);
  const undef = parseLedgerEvents(undefined);
  assert.equal(undef.passed.size, 0);
});

// --- pure: countLedgerEvents (plan 3620 fix round G2) -------------------------------------------
// The invariant this module's own truncation-safety rule requires: a truncated final fragment
// counts as ZERO events, a newline-terminated (complete) event counts as one — never the reverse,
// and never merely "non-empty bytes" (the `[ -s file ]` check this counter replaces).

test('countLedgerEvents: a truncated final fragment (no trailing newline, mid-write shape) counts as ZERO events', () => {
  const truncated = '{"file":"/repo/scripts/a.test.mjs","pas'; // killed mid-write
  assert.equal(countLedgerEvents(truncated), 0);
});

test('countLedgerEvents: a single newline-terminated, well-formed event counts as exactly one', () => {
  const text = `${JSON.stringify({ file: '/repo/scripts/a.test.mjs', passed: true })}\n`;
  assert.equal(countLedgerEvents(text), 1);
});

test('countLedgerEvents: a complete event followed by a truncated one counts only the complete one', () => {
  const complete = `${JSON.stringify({ file: '/repo/scripts/a.test.mjs', passed: true })}\n`;
  const truncated = '{"file":"/repo/scripts/b.test.mjs","pas';
  assert.equal(countLedgerEvents(complete + truncated), 1);
});

test('countLedgerEvents: empty/undefined input counts zero, never throws', () => {
  assert.equal(countLedgerEvents(''), 0);
  assert.equal(countLedgerEvents(undefined), 0);
});

test('countLedgerEvents: a corrupt middle line is skipped, not counted, without poisoning its siblings', () => {
  const text = [
    JSON.stringify({ file: '/repo/scripts/a.test.mjs', passed: true }),
    'not valid json {{{',
    JSON.stringify({ file: '/repo/scripts/c.test.mjs', passed: false }),
    '',
  ].join('\n');
  assert.equal(countLedgerEvents(text), 2);
});

// --- pure: countPytestLedgerEvents (plan 3620 fix round G2/G2b) ---------------------------------

test('countPytestLedgerEvents: a truncated final collect/report fragment counts as ZERO events', () => {
  const truncated = '{"type":"collect","file":"backend/scripts/a.py","cou'; // killed mid-write
  assert.equal(countPytestLedgerEvents([{ text: truncated, canonical: true }]), 0);
});

test('countPytestLedgerEvents: one well-formed collect + one well-formed report counts as two', () => {
  const text = [
    JSON.stringify({ type: 'collect', file: 'backend/scripts/a.py', count: 1 }),
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'passed',
      terminal: true,
    }),
    '',
  ].join('\n');
  assert.equal(countPytestLedgerEvents([{ text, canonical: true }]), 2);
});

// plan 3620 fix round G2b (finding f64196): the whole reason this counter takes a SOURCES array
// rather than one string — a cap-killed xdist run's ONLY surviving proof can be a worker's own
// `<events>.gwN` sidecar, disjoint from an empty/absent canonical stream. Summed across sources,
// never read from the canonical file alone.
test('countPytestLedgerEvents: events split across xdist worker streams are ALL counted, not just the canonical file', () => {
  const canonicalText = ''; // the canonical stream saw nothing (a worker-only kill)
  const worker0 = `${JSON.stringify({ type: 'collect', file: 'backend/scripts/a.py', count: 1 })}\n`;
  const worker1 = `${JSON.stringify({ type: 'report', file: 'backend/scripts/b.py', outcome: 'passed', terminal: true })}\n`;
  const sources = [
    { text: canonicalText, canonical: true },
    { text: worker0, canonical: false },
    { text: worker1, canonical: false },
  ];
  assert.equal(countPytestLedgerEvents(sources), 2, 'both worker-sidecar events must be counted');
});

test('countPytestLedgerEvents: empty/no sources counts zero, never throws', () => {
  assert.equal(countPytestLedgerEvents([]), 0);
  assert.equal(countPytestLedgerEvents(undefined), 0);
});

// --- pure: toPosixRelative ---------------------------------------------------------------------

test('toPosixRelative: normalizes a nested path to a forward-slash repo-relative string', () => {
  const root = join(tmpdir(), 'battery-ledger-posix-root');
  const abs = join(root, 'scripts', 'sub', 'a.test.mjs');
  assert.equal(toPosixRelative(root, abs), 'scripts/sub/a.test.mjs');
});

// --- pure: parsePytestLedgerEvents / greenPytestFiles (plan 3223 pytest half, E4) ---------------

function greenOf(text) {
  return greenPytestFiles(parsePytestLedgerEvents(text));
}

test('parsePytestLedgerEvents + greenPytestFiles: a file whose terminal-report count equals its collected count, with no failures, is green', () => {
  const text = [
    JSON.stringify({ type: 'collect', file: 'backend/scripts/a.py', count: 2 }),
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'passed',
      terminal: true,
    }),
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'skipped',
      terminal: true,
    }),
    '',
  ].join('\n');
  assert.deepEqual([...greenOf(text)], ['backend/scripts/a.py']);
});

test('parsePytestLedgerEvents + greenPytestFiles: a killed run — collected 2, only 1 terminal report — is NEVER green (the in-flight test)', () => {
  const text = [
    JSON.stringify({ type: 'collect', file: 'backend/scripts/a.py', count: 2 }),
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'passed',
      terminal: true,
    }),
    '', // the SIGKILL landed before the second test's terminal report was ever written
  ].join('\n');
  assert.deepEqual([...greenOf(text)], []);
});

test('parsePytestLedgerEvents + greenPytestFiles: a failed terminal report poisons the file even though the count matches', () => {
  const text = [
    JSON.stringify({ type: 'collect', file: 'backend/scripts/a.py', count: 2 }),
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'passed',
      terminal: true,
    }),
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'failed',
      terminal: true,
    }),
    '',
  ].join('\n');
  assert.deepEqual([...greenOf(text)], []);
});

test('parsePytestLedgerEvents + greenPytestFiles: a NON-terminal teardown failure poisons the file WITHOUT inflating its reported count', () => {
  // Collected=1, exactly one terminal report (the test's own body passed) — but its fixture
  // teardown crashed. Must be excluded from green (a real signal something went wrong), and the
  // non-terminal line must not itself count toward the collected/reported equality.
  const text = [
    JSON.stringify({ type: 'collect', file: 'backend/scripts/a.py', count: 1 }),
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'passed',
      terminal: true,
    }),
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'failed',
      terminal: false,
    }),
    '',
  ].join('\n');
  const parsed = parsePytestLedgerEvents(text);
  assert.equal(parsed.reported.get('backend/scripts/a.py'), 1); // NOT 2 — the teardown line never counted
  assert.deepEqual([...greenPytestFiles(parsed)], []); // but still poisoned by the failure set
});

test('parsePytestLedgerEvents: a TRUNCATED last line (no trailing newline) is dropped, never counted as evidence', () => {
  const complete =
    JSON.stringify({ type: 'collect', file: 'backend/scripts/a.py', count: 1 }) + '\n';
  const truncated = '{"type":"report","file":"backend/scripts/a.py","outc'; // killed mid-write
  const { collected, reported } = parsePytestLedgerEvents(complete + truncated);
  assert.equal(collected.get('backend/scripts/a.py'), 1);
  assert.equal(reported.get('backend/scripts/a.py'), undefined); // the truncated report never counted
});

test('parsePytestLedgerEvents: a corrupt middle line is skipped without poisoning its siblings', () => {
  const text = [
    JSON.stringify({ type: 'collect', file: 'backend/scripts/a.py', count: 1 }),
    'not valid json {{{',
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'passed',
      terminal: true,
    }),
    '',
  ].join('\n');
  assert.deepEqual([...greenOf(text)], ['backend/scripts/a.py']);
});

test('parsePytestLedgerEvents: a file with no collect event at all is never green, regardless of report lines', () => {
  // A collection-phase kill: the process died before pytest_collection_finish ever ran, so no
  // "collect" line exists for a file even though (hypothetically) some report line references it.
  const text = [
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'passed',
      terminal: true,
    }),
    '',
  ].join('\n');
  assert.deepEqual([...greenOf(text)], []);
});

test('greenPytestFiles: two independent files resolve independently (one green, one not)', () => {
  const text = [
    JSON.stringify({ type: 'collect', file: 'backend/scripts/a.py', count: 1 }),
    JSON.stringify({ type: 'collect', file: 'backend/scripts/b.py', count: 1 }),
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'passed',
      terminal: true,
    }),
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/b.py',
      outcome: 'failed',
      terminal: true,
    }),
    '',
  ].join('\n');
  assert.deepEqual([...greenOf(text)], ['backend/scripts/a.py']);
});

test('parsePytestLedgerEvents: empty input yields empty maps/sets, never throws', () => {
  const { collected, reported, failed } = parsePytestLedgerEvents('');
  assert.equal(collected.size, 0);
  assert.equal(reported.size, 0);
  assert.equal(failed.size, 0);
  assert.deepEqual([...greenPytestFiles(parsePytestLedgerEvents(undefined))], []);
});

// --- fs: cap-killed xdist worker event sources (plan 3555) ----------------------------------

function pytestEventLine(event) {
  return JSON.stringify(event) + '\n';
}

test('pytest event group combiner carries Map, Set, and unknown-shaped canonical evidence', () => {
  const canonical = {
    futureCounts: new Map([
      ['shared.py', 2],
      ['canonical.py', 1],
    ]),
    futureFlags: new Set(['canonical.py']),
    futureScalar: 'canonical evidence',
  };
  const siblings = {
    futureCounts: new Map([
      ['shared.py', 3],
      ['worker.py', 1],
    ]),
    futureFlags: new Set(['worker.py']),
    futureScalar: 'worker evidence',
  };

  const combined = combinePytestLedgerEventGroups(canonical, siblings);
  assert.deepEqual(
    [...combined.futureCounts],
    [
      ['shared.py', 3],
      ['canonical.py', 1],
      ['worker.py', 1],
    ],
  );
  assert.deepEqual([...combined.futureFlags], ['canonical.py', 'worker.py']);
  assert.equal(combined.futureScalar, 'canonical evidence');
});

// plan 3555 (delta review, guard-fires): a cap-killed run's evidence lives ONLY in the worker
// group — the canonical stream may not exist at all — so a field present on just that side must
// survive the combine. Keying the loop off the canonical group's own names would drop exactly the
// evidence this plan exists to bank.
test('combinePytestLedgerEventGroups: a field only the SIBLING group carries is not dropped', () => {
  const canonical = { shared: new Map([['a.py', 1]]) };
  const siblings = {
    shared: new Map([['a.py', 2]]),
    workerOnlyCounts: new Map([['b.py', 4]]),
    workerOnlyFlags: new Set(['c.py']),
    workerOnlyScalar: 'worker evidence',
  };

  const combined = combinePytestLedgerEventGroups(canonical, siblings);
  assert.deepEqual([...combined.shared], [['a.py', 2]], 'max still wins for a shared Map field');
  assert.deepEqual([...combined.workerOnlyCounts], [['b.py', 4]]);
  assert.deepEqual([...combined.workerOnlyFlags], ['c.py']);
  assert.equal(combined.workerOnlyScalar, 'worker evidence');
});

test('pytest event sources: siblings merge without a canonical file and a fully reported sibling is green', () => {
  const dir = mkdtempSync(join(tmpdir(), 'battery-ledger-pytest-siblings-'));
  const canonical = join(dir, 'events.jsonl');
  writeFileSync(
    `${canonical}.gw0`,
    pytestEventLine({ type: 'collect', file: 'backend/scripts/a.py', count: 1 }) +
      pytestEventLine({
        type: 'report',
        file: 'backend/scripts/a.py',
        outcome: 'passed',
        terminal: true,
      }),
  );
  writeFileSync(
    `${canonical}.gw1`,
    pytestEventLine({ type: 'collect', file: 'backend/scripts/b.py', count: 1 }) +
      pytestEventLine({
        type: 'report',
        file: 'backend/scripts/b.py',
        outcome: 'passed',
        terminal: true,
      }),
  );
  try {
    assert.deepEqual(resolvePytestLedgerEventSources(canonical), [
      `${canonical}.gw0`,
      `${canonical}.gw1`,
    ]);
    const parsed = parsePytestLedgerEventSources(readPytestLedgerEventSources(canonical));
    assert.deepEqual([...greenPytestFiles(parsed)].sort(), [
      'backend/scripts/a.py',
      'backend/scripts/b.py',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pytest event sources: a non-empty canonical folds with sorted siblings and merge temp is excluded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'battery-ledger-pytest-canonical-'));
  const canonical = join(dir, 'events.jsonl');
  writeFileSync(
    canonical,
    pytestEventLine({ type: 'collect', file: 'backend/scripts/a.py', count: 1 }),
  );
  writeFileSync(
    `${canonical}.gw0`,
    pytestEventLine({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'passed',
      terminal: true,
    }),
  );
  writeFileSync(
    `${canonical}.merge-1234.tmp`,
    pytestEventLine({ type: 'collect', file: 'backend/scripts/poison.py', count: 1 }) +
      pytestEventLine({
        type: 'report',
        file: 'backend/scripts/poison.py',
        outcome: 'passed',
        terminal: true,
      }),
  );
  try {
    assert.deepEqual(resolvePytestLedgerEventSources(canonical), [canonical, `${canonical}.gw0`]);
    const parsed = parsePytestLedgerEventSources(readPytestLedgerEventSources(canonical));
    assert.deepEqual([...greenPytestFiles(parsed)], ['backend/scripts/a.py']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pytest event sources: a merged canonical plus undeleted worker siblings is counted once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'battery-ledger-pytest-merge-window-'));
  const canonical = join(dir, 'events.jsonl');
  const workerRecords =
    pytestEventLine({ type: 'collect', file: 'backend/scripts/a.py', count: 2 }) +
    pytestEventLine({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'passed',
      terminal: true,
    }) +
    pytestEventLine({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'passed',
      terminal: true,
    });
  writeFileSync(canonical, workerRecords);
  writeFileSync(`${canonical}.gw0`, workerRecords);
  try {
    const clean = parsePytestLedgerEventSources([
      { path: canonical, text: workerRecords, canonical: true },
    ]);
    const mergeWindow = parsePytestLedgerEventSources(readPytestLedgerEventSources(canonical));
    assert.deepEqual([...greenPytestFiles(mergeWindow)], [...greenPytestFiles(clean)]);
    assert.deepEqual([...greenPytestFiles(mergeWindow)], ['backend/scripts/a.py']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pytest event sources: non-xdist sidecars are neither returned nor banked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'battery-ledger-pytest-sidecars-'));
  const canonical = join(dir, 'events.jsonl');
  const poison =
    pytestEventLine({ type: 'collect', file: 'backend/scripts/poison.py', count: 1 }) +
    pytestEventLine({
      type: 'report',
      file: 'backend/scripts/poison.py',
      outcome: 'passed',
      terminal: true,
    });
  writeFileSync(`${canonical}.backup`, poison);
  writeFileSync(`${canonical}.worker-1`, poison);
  writeFileSync(`${canonical}.gwX`, poison);
  try {
    assert.deepEqual(resolvePytestLedgerEventSources(canonical), []);
    const parsed = parsePytestLedgerEventSources(readPytestLedgerEventSources(canonical));
    assert.deepEqual([...greenPytestFiles(parsed)], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pytest event sources: one sibling's truncated tail cannot corrupt the next sibling's first record", () => {
  const dir = mkdtempSync(join(tmpdir(), 'battery-ledger-pytest-truncated-'));
  const canonical = join(dir, 'events.jsonl');
  writeFileSync(
    `${canonical}.gw0`,
    pytestEventLine({ type: 'collect', file: 'backend/scripts/a.py', count: 1 }) +
      '{"type":"report","file":"backend/scripts/a.py"',
  );
  writeFileSync(
    `${canonical}.gw1`,
    pytestEventLine({ type: 'collect', file: 'backend/scripts/b.py', count: 1 }) +
      pytestEventLine({
        type: 'report',
        file: 'backend/scripts/b.py',
        outcome: 'passed',
        terminal: true,
      }),
  );
  try {
    const parsed = parsePytestLedgerEventSources(readPytestLedgerEventSources(canonical));
    assert.deepEqual([...greenPytestFiles(parsed)], ['backend/scripts/b.py']);
    assert.equal(parsed.reported.has('backend/scripts/a.py'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- pure: remainingSelection -------------------------------------------------------------------

test('remainingSelection: subtracts exactly the green set, preserves order, never adds', () => {
  const selection = ['scripts/a.test.mjs', 'scripts/b.test.mjs', 'scripts/c.test.mjs'];
  const green = new Set(['scripts/b.test.mjs']);
  assert.deepEqual(remainingSelection(selection, green), [
    'scripts/a.test.mjs',
    'scripts/c.test.mjs',
  ]);
});

test('remainingSelection: an empty green set returns the selection unchanged', () => {
  const selection = ['scripts/a.test.mjs', 'scripts/b.test.mjs'];
  assert.deepEqual(remainingSelection(selection, new Set()), selection);
});

test('remainingSelection: a green set covering everything returns an empty array', () => {
  const selection = ['scripts/a.test.mjs', 'scripts/b.test.mjs'];
  assert.deepEqual(
    remainingSelection(selection, new Set(['scripts/a.test.mjs', 'scripts/b.test.mjs'])),
    [],
  );
});

// --- fs: readGreenSet / mergeGreenFiles (TTL fail-direction, union semantics) ------------------

function freshLedgerDir(prefix = 'battery-ledger-fs-') {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'gate-ledgers');
}

const KEY_A = 'a'.repeat(32);
const KEY_B = 'b'.repeat(32);

// plan 4236 T5: per-file wall time round-trips through the ledger, and every other whole-record
// writer carries it rather than erasing it.
test('plan 4236 T5: durations parse from reporter lines, persist via mergeGreenFiles, survive a stall write', () => {
  const text =
    '{"file":"/r/scripts/a.test.mjs","passed":true,"durationMs":1234}\n' +
    '{"file":"/r/scripts/b.test.mjs","passed":false,"durationMs":99}\n' +
    '{"file":"/r/scripts/old.test.mjs","passed":true}\n'; // a pre-4236 line: no duration
  const ev = parseLedgerEvents(text);
  assert.deepEqual(
    [...ev.durations],
    [
      ['/r/scripts/a.test.mjs', 1234],
      ['/r/scripts/b.test.mjs', 99],
    ],
  );
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['scripts/a.test.mjs']), at(0), undefined, {
    durations: { 'scripts/a.test.mjs': 1234, 'scripts/b.test.mjs': 99 },
  });
  assert.deepEqual(readDurations(dir, KEY_A, at(1)), {
    'scripts/a.test.mjs': 1234,
    'scripts/b.test.mjs': 99,
  });
  // last duration wins; untouched files keep theirs
  mergeGreenFiles(dir, KEY_A, new Set(['scripts/c.test.mjs']), at(2), undefined, {
    durations: { 'scripts/a.test.mjs': 50 },
  });
  mergeStalledFiles(dir, KEY_A, new Set(['scripts/d.test.mjs']), at(3));
  assert.deepEqual(readDurations(dir, KEY_A, at(4)), {
    'scripts/a.test.mjs': 50,
    'scripts/b.test.mjs': 99,
  });
  assert.deepEqual(readDurations(dir, KEY_B, at(4)), {}, 'an unwritten key reads as empty');
});

test('readGreenSet: a never-written key reads as empty, never throws', () => {
  const dir = freshLedgerDir();
  assert.deepEqual([...readGreenSet(dir, KEY_A, at(0))], []);
});

test('mergeGreenFiles + readGreenSet: a merge is visible to a subsequent read within the TTL', () => {
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['scripts/a.test.mjs']), at(0));
  assert.deepEqual([...readGreenSet(dir, KEY_A, at(1))], ['scripts/a.test.mjs']);
});

test('mergeGreenFiles: two merges UNION rather than overwrite', () => {
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['scripts/a.test.mjs']), at(0));
  mergeGreenFiles(dir, KEY_A, new Set(['scripts/b.test.mjs']), at(1));
  assert.deepEqual([...readGreenSet(dir, KEY_A, at(2))].sort(), [
    'scripts/a.test.mjs',
    'scripts/b.test.mjs',
  ]);
});

test("mergeGreenFiles: a DIFFERENT key never sees another key's green files", () => {
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['scripts/a.test.mjs']), at(0));
  assert.deepEqual([...readGreenSet(dir, KEY_B, at(1))], []);
});

// plan 3223 design decision 2: "battery keys and pytest keys must not collide in the ledger
// store" — pinned here with the SAME key string written under BOTH namespaces, proving they
// resolve to two different on-disk files and neither read sees the other's write.
test('resolvePytestLedgerDir: the SAME key string writes to a DIFFERENT file than the battery namespace, and neither leaks into the other', () => {
  const root = mkdtempSync(join(tmpdir(), 'battery-ledger-namespace-'));
  const battDir = resolveLedgerDir(root);
  const pyDir = resolvePytestLedgerDir(root);
  assert.notEqual(battDir, pyDir);
  mergeGreenFiles(battDir, KEY_A, new Set(['scripts/a.test.mjs']), at(0));
  mergeGreenFiles(pyDir, KEY_A, new Set(['backend/scripts/b.py']), at(0));
  assert.deepEqual([...readGreenSet(battDir, KEY_A, at(1))], ['scripts/a.test.mjs']);
  assert.deepEqual([...readGreenSet(pyDir, KEY_A, at(1))], ['backend/scripts/b.py']);
  // Reading the BATTERY set through the PYTEST dir (or vice versa) must never see the other's
  // write — the two calls above already prove this by returning disjoint sets under the SAME
  // key, but assert it once more explicitly as the drift guard this test exists for.
  assert.notDeepEqual(
    [...readGreenSet(battDir, KEY_A, at(1))],
    [...readGreenSet(pyDir, KEY_A, at(1))],
  );
});

test('readGreenSet: an EXPIRED entry reads as empty (fail-safe, not resurrected)', () => {
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['scripts/a.test.mjs']), at(0));
  assert.deepEqual([...readGreenSet(dir, KEY_A, at(0))], ['scripts/a.test.mjs']); // sanity: live
  const pastTtl = at(DEFAULT_TTL_MIN + 1);
  assert.deepEqual([...readGreenSet(dir, KEY_A, pastTtl)], []);
});

test('mergeGreenFiles: merging AFTER an entry has expired starts FRESH from just the new files (never resurrects the stale set)', () => {
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['scripts/stale.test.mjs']), at(0));
  const pastTtl = at(DEFAULT_TTL_MIN + 1);
  mergeGreenFiles(dir, KEY_A, new Set(['scripts/fresh.test.mjs']), pastTtl);
  assert.deepEqual([...readGreenSet(dir, KEY_A, pastTtl)], ['scripts/fresh.test.mjs']);
});

test('readGreenSet: a corrupt on-disk entry reads as empty, never crashes', () => {
  const dir = freshLedgerDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${KEY_A}.json`), 'not { valid json');
  assert.deepEqual([...readGreenSet(dir, KEY_A, at(0))], []);
});

test('mergeGreenFiles: a no-op merge (nothing newly passed) never touches the fs — the dir is not even created', () => {
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(), at(0));
  assert.equal(existsSync(dir), false);
});

// --- CLI: key / remainder / merge, against a real throwaway git repo ---------------------------
// Mirrors battery-pass-cache.test.mjs's tmpRepo() fixture — deriveKey (reused, not reimplemented
// here) refuses any repo without a `scripts/` tree at HEAD.

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
}

function commitAll(dir, msg) {
  execFileSync('git', ['add', '-A'], { cwd: dir, env: cleanEnv() });
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@test.invalid', 'commit', '-q', '-m', msg],
    { cwd: dir, env: cleanEnv() },
  );
}

function tmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'battery-ledger-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: cleanEnv() });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'dummy.test.mjs'), "import 'node:test';\n");
  commitAll(dir, 'init');
  return dir;
}

const runCli = (repo, args, { input = '', env = {} } = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    env: { ...cleanEnv(), ...env },
    input,
    encoding: 'utf8',
  });

const SEL = 'scripts/dummy.test.mjs\n';

test('CLI key: derives a real 32-lowercase-hex key for a real repo selection', () => {
  const repo = tmpRepo();
  try {
    const r = runCli(repo, ['key'], { input: SEL });
    assert.equal(r.status, 0, r.stderr);
    const key = r.stdout.trim();
    assert.match(key, /^[0-9a-f]{32}$/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI key: an empty selection is refused (matches deriveKey's own contract)", () => {
  const repo = tmpRepo();
  try {
    const r = runCli(repo, ['key'], { input: '' });
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI remainder: with no ledger yet, returns the full selection unchanged', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const r = runCli(repo, ['remainder', '--key', key], { input: SEL });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'scripts/dummy.test.mjs');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI remainder: a missing/malformed --key degrades to the full selection, never a crash', () => {
  const repo = tmpRepo();
  try {
    const bogus = runCli(repo, ['remainder', '--key', 'not-a-real-key'], { input: SEL });
    assert.equal(bogus.status, 0);
    assert.equal(bogus.stdout.trim(), 'scripts/dummy.test.mjs');
    const missing = runCli(repo, ['remainder'], { input: SEL });
    assert.equal(missing.status, 0);
    assert.equal(missing.stdout.trim(), 'scripts/dummy.test.mjs');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI merge then remainder: a file the events-file proved green is subtracted from the next remainder', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'events.jsonl');
    const absFile = join(repo, 'scripts', 'dummy.test.mjs');
    writeFileSync(eventsFile, JSON.stringify({ file: absFile, passed: true }) + '\n');
    const merge = runCli(repo, ['merge', '--key', key, '--file', eventsFile]);
    assert.equal(merge.status, 0, merge.stderr);
    const r = runCli(repo, ['remainder', '--key', key], { input: SEL });
    assert.equal(r.stdout.trim(), ''); // fully covered — nothing left to run
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI merge: a truncated events line never greens its file — the next remainder still names it', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'events.jsonl');
    const absFile = join(repo, 'scripts', 'dummy.test.mjs');
    // No trailing newline — exactly a SIGKILL-mid-write shape.
    writeFileSync(eventsFile, JSON.stringify({ file: absFile, passed: true }));
    runCli(repo, ['merge', '--key', key, '--file', eventsFile]);
    const r = runCli(repo, ['remainder', '--key', key], { input: SEL });
    assert.equal(r.stdout.trim(), 'scripts/dummy.test.mjs'); // never subtracted
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI merge: a nonexistent --file is a silent no-op (exit 0, never blocks close-out) and reports MERGE_PERSISTED=0 — an unreadable destination, unchanged by I1', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const r = runCli(repo, ['merge', '--key', key, '--file', join(repo, 'does-not-exist.jsonl')]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), `${MERGE_PERSISTED_SENTINEL}=0`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- CLI: merge/pytest-merge PERSISTENCE sentinel (plan 3620 fix round H1/I1) --------------------
//
// Round 2's whole point was "ranProven is true only if this round's proven files actually reached
// the persistent green set" — implemented by checking `merge`'s own exit STATUS. But `merge` and
// `pytest-merge` deliberately CATCH their own fs write failures and still exit 0 (their documented
// "never blocks" contract), so that check proved nothing: a merge whose ledger write failed still
// read as "succeeded". These cases pin the CLI's own MERGE_PERSISTED_SENTINEL — the last stdout
// line — which is the only thing that can actually answer "did this write reach disk".
//
// I1 NARROWS what `=0` means: only a write that never had a chance (missing --key/--file, an
// unreadable/missing destination) or one that genuinely THREW counts as `=0`. A destination that
// read fine but named ZERO new files to bank is a VACUOUS success (`=1`) — see the cases below
// tagged "(I1 vacuous)".

test('CLI merge (H1): a successful write reports MERGE_PERSISTED=1 as the LAST stdout line', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'events.jsonl');
    const absFile = join(repo, 'scripts', 'dummy.test.mjs');
    writeFileSync(eventsFile, `${JSON.stringify({ file: absFile, passed: true })}\n`);
    const merge = runCli(repo, ['merge', '--key', key, '--file', eventsFile]);
    assert.equal(merge.status, 0, merge.stderr);
    const lastLine = merge.stdout.trim().split('\n').pop();
    assert.equal(lastLine, `${MERGE_PERSISTED_SENTINEL}=1`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI merge (H1): a ledger write that THROWS still exits 0 but reports MERGE_PERSISTED=0 — exit status alone proves nothing', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'events.jsonl');
    const absFile = join(repo, 'scripts', 'dummy.test.mjs');
    writeFileSync(eventsFile, `${JSON.stringify({ file: absFile, passed: true })}\n`);
    // Sabotage the ledger dir: a PLAIN FILE sits where writeCacheEntry's own
    // mkdirSync(cacheDir, {recursive:true}) needs a directory, so the write throws instead of
    // persisting — a real fs failure, not a simulated one.
    mkdirSync(join(repo, '.scratch'), { recursive: true });
    writeFileSync(join(repo, '.scratch', 'gate-ledgers'), 'not a directory');
    const merge = runCli(repo, ['merge', '--key', key, '--file', eventsFile]);
    assert.equal(merge.status, 0, merge.stderr);
    const lastLine = merge.stdout.trim().split('\n').pop();
    assert.equal(
      lastLine,
      `${MERGE_PERSISTED_SENTINEL}=0`,
      `a THROWN write must report MERGE_PERSISTED=0, not merely exit 0; got stdout:\n${merge.stdout}\nstderr:\n${merge.stderr}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI merge (H1): a missing --key or --file reports MERGE_PERSISTED=0 — no write was ever attempted, unchanged by I1', () => {
  const repo = tmpRepo();
  try {
    const eventsFile = join(repo, 'events.jsonl');
    writeFileSync(
      eventsFile,
      `${JSON.stringify({ file: join(repo, 'scripts', 'dummy.test.mjs'), passed: true })}\n`,
    );
    const noKey = runCli(repo, ['merge', '--file', eventsFile]);
    assert.equal(noKey.status, 0);
    assert.equal(noKey.stdout.trim(), `${MERGE_PERSISTED_SENTINEL}=0`);
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const noFile = runCli(repo, ['merge', '--key', key]);
    assert.equal(noFile.status, 0);
    assert.equal(noFile.stdout.trim(), `${MERGE_PERSISTED_SENTINEL}=0`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI pytest-merge (H1): a missing --key or --file reports MERGE_PERSISTED=0 — no write was ever attempted, unchanged by I1', () => {
  const repo = tmpRepo();
  try {
    const eventsFile = join(repo, 'py-events.jsonl');
    writeFileSync(
      eventsFile,
      `${JSON.stringify({ type: 'collect', file: 'backend/scripts/dummy_test.py', count: 1 })}\n`,
    );
    const noKey = runCli(repo, ['pytest-merge', '--file', eventsFile]);
    assert.equal(noKey.status, 0);
    assert.equal(noKey.stdout.trim(), `${MERGE_PERSISTED_SENTINEL}=0`);
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const noFile = runCli(repo, ['pytest-merge', '--key', key]);
    assert.equal(noFile.status, 0);
    assert.equal(noFile.stdout.trim(), `${MERGE_PERSISTED_SENTINEL}=0`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI merge (H1): a missing --file reports MERGE_PERSISTED=0 (no destination ever existed — no evidence at all)', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const missing = runCli(repo, [
      'merge',
      '--key',
      key,
      '--file',
      join(repo, 'does-not-exist.jsonl'),
    ]);
    assert.equal(missing.status, 0);
    assert.equal(missing.stdout.trim(), `${MERGE_PERSISTED_SENTINEL}=0`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// plan 3620 fix round (I1): the defect this plan exists to fix. A destination file that DID exist
// and WAS read, but that this attempt's own truncation/no-passed-events shape names ZERO files to
// bank, is NOT the same fact as "no write ever had a chance" — it is a VACUOUS success (a round
// that ran and genuinely proved nothing new). Before I1 this printed `=0`, indistinguishable from a
// THROWN write or a missing destination, so the hook's `ranProven` gate could never be true for the
// canonical non-convergent-round shape (a chunk-capped gate stuck on one over-wall file). This case
// PINS THE OLD `=0` ASSERTION IT REPLACES: before the I1 fix this test fails with
// `AssertionError [ERR_ASSERTION]: MERGE_PERSISTED=0 !== MERGE_PERSISTED=1` (pasted into the plan
// report as the red-state evidence).
test('CLI merge (I1 vacuous): a readable destination file naming ZERO passed events reports MERGE_PERSISTED=1, not 0', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'events.jsonl');
    // No trailing newline — a truncated (SIGKILL-mid-write) line, never a complete PASSED event —
    // so parseLedgerEvents' own truncation-safe reader yields an EMPTY passed set from a file that
    // DID exist and WAS read successfully.
    writeFileSync(eventsFile, JSON.stringify({ file: 'scripts/dummy.test.mjs', passed: true }));
    const truncated = runCli(repo, ['merge', '--key', key, '--file', eventsFile]);
    assert.equal(truncated.status, 0);
    assert.equal(
      truncated.stdout.trim(),
      `${MERGE_PERSISTED_SENTINEL}=1`,
      `a readable-but-empty-green round is a VACUOUS success, not a failure; got:\n${truncated.stdout}\nstderr:\n${truncated.stderr}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI pytest-merge (H1): a successful write reports MERGE_PERSISTED=1', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'py-events.jsonl');
    writeFileSync(
      eventsFile,
      [
        JSON.stringify({ type: 'collect', file: 'backend/scripts/dummy_test.py', count: 1 }),
        JSON.stringify({
          type: 'report',
          file: 'backend/scripts/dummy_test.py',
          outcome: 'passed',
          terminal: true,
        }),
        '',
      ].join('\n'),
    );
    const merge = runCli(repo, ['pytest-merge', '--key', key, '--file', eventsFile]);
    assert.equal(merge.status, 0, merge.stderr);
    const lastLine = merge.stdout.trim().split('\n').pop();
    assert.equal(lastLine, `${MERGE_PERSISTED_SENTINEL}=1`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI pytest-merge (H1): a ledger write that THROWS still exits 0 but reports MERGE_PERSISTED=0', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'py-events.jsonl');
    writeFileSync(
      eventsFile,
      [
        JSON.stringify({ type: 'collect', file: 'backend/scripts/dummy_test.py', count: 1 }),
        JSON.stringify({
          type: 'report',
          file: 'backend/scripts/dummy_test.py',
          outcome: 'passed',
          terminal: true,
        }),
        '',
      ].join('\n'),
    );
    mkdirSync(join(repo, '.scratch'), { recursive: true });
    writeFileSync(join(repo, '.scratch', 'gate-ledgers'), 'not a directory');
    const merge = runCli(repo, ['pytest-merge', '--key', key, '--file', eventsFile]);
    assert.equal(merge.status, 0, merge.stderr);
    const lastLine = merge.stdout.trim().split('\n').pop();
    assert.equal(
      lastLine,
      `${MERGE_PERSISTED_SENTINEL}=0`,
      `a THROWN write must report MERGE_PERSISTED=0, not merely exit 0; got stdout:\n${merge.stdout}\nstderr:\n${merge.stderr}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// plan 3620 fix round (I1): the pytest twin of the vacuous-success case above — real event sources
// (a genuinely readable, well-formed events file) whose own E4 green-file definition names ZERO
// files this attempt (a file collected but short of its own collected count — a kill mid-file, the
// SAME fixture shape 'CLI pytest-merge: a file short of its collected count' below already reads,
// just now also asserting the sentinel). PINS THE OLD `=0` ASSERTION: before the I1 fix this fails
// with `AssertionError [ERR_ASSERTION]: MERGE_PERSISTED=0 !== MERGE_PERSISTED=1`.
test('CLI pytest-merge (I1 vacuous): real event sources with a ZERO-file green set reports MERGE_PERSISTED=1, not 0', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'py-events.jsonl');
    writeFileSync(
      eventsFile,
      [
        JSON.stringify({ type: 'collect', file: 'backend/scripts/dummy_test.py', count: 2 }),
        JSON.stringify({
          type: 'report',
          file: 'backend/scripts/dummy_test.py',
          outcome: 'passed',
          terminal: true,
        }),
        '', // the SECOND collected test's report never arrived — killed mid-run, green.size === 0
      ].join('\n'),
    );
    const merge = runCli(repo, ['pytest-merge', '--key', key, '--file', eventsFile]);
    assert.equal(merge.status, 0, merge.stderr);
    const lastLine = merge.stdout.trim().split('\n').pop();
    assert.equal(
      lastLine,
      `${MERGE_PERSISTED_SENTINEL}=1`,
      `real sources naming zero green files is a VACUOUS success, not a failure; got:\n${merge.stdout}\nstderr:\n${merge.stderr}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The two cases below pin what MERGE_PERSISTED deliberately does NOT vouch for (plan 3620 fix
// round I2, delta review — six findings across angle-A/B/P, writer-trace, simplification and
// altitude all asked for one of these two to flip the sentinel to =0). Both refusals are load-
// bearing: I1 widened `persisted` from "a green write succeeded" to "no write FAILED", and that
// phrase is scoped to the GREEN-SET write alone — the one write whose result
// scoreChunkRoundByGreenMark actually fingerprints. Folding either of these in would flip rounds
// whose green proof genuinely reached disk back to =0, re-suppressing `ranProven` at the hook's
// seats for exactly the zero-progress rounds GATE_NON_CONVERGENT exists to catch — this plan's own
// bug, re-entered through a different door. They live here so that reasoning is pinned by a test
// rather than by a comment a later reader can talk themselves out of.

// Scope note (I2 re-review, findings on this test's own strength). What this case proves is
// exactly "a stall write that THREW leaves the sentinel at 1", in the reachable shape: green empty,
// so no green write is attempted and the stall write is the only one that can throw. The stronger
// ordering the plan-3318 comment describes — a green write that SUCCEEDED followed by a stall write
// that throws — is NOT constructible here, and not by any harness: mergeGreenFiles and
// mergeStalledFiles both write the SAME entry path (pass-cache-kernel.mjs's `entryPath`), so a
// successful green write is itself proof the path is writable and the stall write that follows it
// in the same process cannot then fail on an fs condition. That ordering is a torn-mid-run race, not
// a state a test can set up. The OTHER direction of the scoping rule — a green write that throws
// MUST report =0 — is covered, for both subcommands, by the two H1 cases above (search
// "a ledger write that THROWS").
test('CLI pytest-merge (I2): a THROWN stall-ledger write leaves MERGE_PERSISTED at 1 — plan 3318 orthogonality survives I1', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    // Make the entry path a DIRECTORY, so writeCacheEntry throws (EISDIR on POSIX, EPERM/EISDIR on
    // Windows — a directory is never openable as a file on either, which is why this reproduces the
    // fs failure without a chmod that Windows would silently no-op).
    mkdirSync(join(resolvePytestLedgerDir(repo), `${key}.json`), { recursive: true });
    const eventsFile = join(repo, 'py-events.jsonl');
    writeFileSync(
      eventsFile,
      [
        // `start` is what puts the file in stalledPytestFiles' candidate set; reported (1) <
        // collected (2) is what keeps it there — and that same shortfall is what makes the file
        // NOT green, so no green write is attempted and only the stall write can throw here.
        JSON.stringify({ type: 'start', file: 'backend/scripts/dummy_test.py' }),
        JSON.stringify({ type: 'collect', file: 'backend/scripts/dummy_test.py', count: 2 }),
        JSON.stringify({
          type: 'report',
          file: 'backend/scripts/dummy_test.py',
          outcome: 'passed',
          terminal: true,
        }),
        '',
      ].join('\n'),
    );
    const merge = runCli(repo, ['pytest-merge', '--key', key, '--file', eventsFile]);
    assert.equal(merge.status, 0, merge.stderr);
    assert.match(
      merge.stderr,
      /stall write failed/,
      `the stall write must actually have thrown for this case to prove anything; stderr:\n${merge.stderr}`,
    );
    assert.equal(
      merge.stdout.trim().split('\n').pop(),
      `${MERGE_PERSISTED_SENTINEL}=1`,
      `stall bookkeeping claims nothing GREEN, so its failure must not flip the sentinel — doing so would re-suppress the bound on the very rounds it exists to catch; got:\n${merge.stdout}\nstderr:\n${merge.stderr}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI pytest-merge (I2): an unreadable worker sidecar alongside a readable canonical source still reports MERGE_PERSISTED=1 — plan 3555 tolerance survives I1', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'py-events.jsonl');
    writeFileSync(
      eventsFile,
      [
        JSON.stringify({ type: 'collect', file: 'backend/scripts/dummy_test.py', count: 1 }),
        JSON.stringify({
          type: 'report',
          file: 'backend/scripts/dummy_test.py',
          outcome: 'passed',
          terminal: true,
        }),
        '',
      ].join('\n'),
    );
    // A `.gw0` sidecar that is a DIRECTORY: resolvePytestLedgerEventSources still discovers it, and
    // readPytestLedgerEventSources' own try/catch drops it (plan 3555 — one unreadable worker must
    // not discard proof its readable siblings already flushed). Same cross-platform reasoning as
    // the case above.
    mkdirSync(`${eventsFile}.gw0`, { recursive: true });
    assert.equal(
      resolvePytestLedgerEventSources(eventsFile).length,
      2,
      'the sidecar must be DISCOVERED for this case to exercise the partial-read path',
    );
    assert.equal(
      readPytestLedgerEventSources(eventsFile).length,
      1,
      'the unreadable sidecar must be DROPPED, leaving the canonical source',
    );
    const merge = runCli(repo, ['pytest-merge', '--key', key, '--file', eventsFile]);
    assert.equal(merge.status, 0, merge.stderr);
    assert.equal(
      merge.stdout.trim().split('\n').pop(),
      `${MERGE_PERSISTED_SENTINEL}=1`,
      `a partial source read still banked what it could, so the sentinel vouches for THAT; a smaller green set than a later round is PROGRESS, which resets the counter rather than tripping it; got:\n${merge.stdout}\nstderr:\n${merge.stderr}`,
    );
    assert.deepEqual(
      [...readGreenSet(resolvePytestLedgerDir(repo), key, Date.now())].sort(),
      ['backend/scripts/dummy_test.py'],
      'the readable source"s proof must have reached the ledger',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- CLI: events-count / pytest-events-count (plan 3620 fix round G2/G2b) -----------------------

test('CLI events-count: a truncated (no trailing newline) events file prints 0', () => {
  const repo = tmpRepo();
  try {
    const eventsFile = join(repo, 'events.jsonl');
    writeFileSync(eventsFile, '{"file":"scripts/x.test.mjs","pas'); // mid-write shape
    const r = runCli(repo, ['events-count', '--file', eventsFile]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '0');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI events-count: a well-formed, newline-terminated event prints 1', () => {
  const repo = tmpRepo();
  try {
    const eventsFile = join(repo, 'events.jsonl');
    writeFileSync(eventsFile, `${JSON.stringify({ file: 'scripts/x.test.mjs', passed: true })}\n`);
    const r = runCli(repo, ['events-count', '--file', eventsFile]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '1');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI events-count: a missing --file/file prints 0, exit 0, never a crash', () => {
  const repo = tmpRepo();
  try {
    const r = runCli(repo, ['events-count', '--file', join(repo, 'does-not-exist.jsonl')]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '0');
    const noFlag = runCli(repo, ['events-count']);
    assert.equal(noFlag.status, 0);
    assert.equal(noFlag.stdout.trim(), '0');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI pytest-events-count: a truncated collect line prints 0; a well-formed collect+report prints 2', () => {
  const repo = tmpRepo();
  try {
    const truncFile = join(repo, 'py-trunc.jsonl');
    writeFileSync(truncFile, '{"type":"collect","file":"backend/scripts/a.py","cou');
    const truncR = runCli(repo, ['pytest-events-count', '--file', truncFile]);
    assert.equal(truncR.status, 0, truncR.stderr);
    assert.equal(truncR.stdout.trim(), '0');

    const wellFile = join(repo, 'py-well.jsonl');
    writeFileSync(
      wellFile,
      [
        JSON.stringify({ type: 'collect', file: 'backend/scripts/a.py', count: 1 }),
        JSON.stringify({
          type: 'report',
          file: 'backend/scripts/a.py',
          outcome: 'passed',
          terminal: true,
        }),
        '',
      ].join('\n'),
    );
    const wellR = runCli(repo, ['pytest-events-count', '--file', wellFile]);
    assert.equal(wellR.status, 0, wellR.stderr);
    assert.equal(wellR.stdout.trim(), '2');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// plan 3620 fix round G2b: the CLI form of the xdist-worker-sidecar test above — a `.gwN` sibling
// next to an EMPTY canonical file must still be counted, proving the CLI actually threads through
// readPytestLedgerEventSources rather than reading only the canonical path handed to --file.
test('CLI pytest-events-count: an xdist worker sidecar (<file>.gw0) is counted even when the canonical file is empty', () => {
  const repo = tmpRepo();
  try {
    const canonical = join(repo, 'py-events.jsonl');
    writeFileSync(canonical, ''); // canonical stream saw nothing — worker-only kill
    writeFileSync(
      `${canonical}.gw0`,
      `${JSON.stringify({ type: 'collect', file: 'backend/scripts/a.py', count: 1 })}\n`,
    );
    const r = runCli(repo, ['pytest-events-count', '--file', canonical]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '1', 'the worker sidecar event must be counted');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// plan 3620 fix round H2 (findings b5a2f0/249e29/4d6fc9/a166e8/512b62/281bb3): `start` means a file
// BEGAN executing, and `slow_deselect` means precisely that NO test from that file ran — neither is
// COMPLETION evidence, and counting them pushes ranProven true on a round that banked nothing (the
// unsafe direction, toward a false GATE_NON_CONVERGENT accusation).
test('CLI pytest-events-count (H2): an events file with ONLY start/slow_deselect records counts as ZERO evidence', () => {
  const repo = tmpRepo();
  try {
    const file = join(repo, 'py-started-only.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'start', file: 'backend/scripts/a.py' }),
        JSON.stringify({ type: 'slow_deselect', file: 'backend/scripts/b.py' }),
        '',
      ].join('\n'),
    );
    const r = runCli(repo, ['pytest-events-count', '--file', file]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout.trim(),
      '0',
      'start/slow_deselect-only must never count as ran-proven evidence',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI pytest-events-count (H2): a genuine completion event still counts alongside start/slow_deselect noise', () => {
  const repo = tmpRepo();
  try {
    const file = join(repo, 'py-mixed.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'start', file: 'backend/scripts/a.py' }),
        JSON.stringify({ type: 'slow_deselect', file: 'backend/scripts/b.py' }),
        JSON.stringify({ type: 'collect', file: 'backend/scripts/c.py', count: 1 }),
        '',
      ].join('\n'),
    );
    const r = runCli(repo, ['pytest-events-count', '--file', file]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '1', 'the one real collect line must still be counted');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI pytest-events-count (H2): a non-terminal report (teardown-failure signal) does not count — only a TERMINAL report is completion evidence', () => {
  const repo = tmpRepo();
  try {
    const file = join(repo, 'py-nonterminal.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'report',
          file: 'backend/scripts/d.py',
          outcome: 'failed',
          terminal: false,
        }),
        '',
      ].join('\n'),
    );
    const r = runCli(repo, ['pytest-events-count', '--file', file]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '0');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- CLI: chunk-round / pytest-chunk-round (plan 3620 push-side non-convergence bound) ----------
//
// plan 3620 fix round G3: the CLI now prints TWO lines — the compact-JSON diagnostic record, then
// the machine-readable sentinel (CHUNK_ROUND_NONCONVERGENT_SENTINEL=1|0). This helper parses both
// and asserts the shape every case below shares, so each test only states what differs.
function parseChunkRoundOutput(stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 2, `expected exactly two lines (JSON + sentinel), got:\n${stdout}`);
  assert.doesNotMatch(
    lines[0],
    / /,
    'the JSON line must be compact — no spaces — so the hook can grep it',
  );
  assert.match(
    lines[1],
    new RegExp(`^${CHUNK_ROUND_NONCONVERGENT_SENTINEL}=[01]$`),
    `the LAST line must be the exact sentinel, got:\n${lines[1]}`,
  );
  const json = JSON.parse(lines[0]);
  const sentinel = lines[1] === `${CHUNK_ROUND_NONCONVERGENT_SENTINEL}=1` ? 1 : 0;
  return { json, sentinel };
}

test('CLI chunk-round: a valid key WITH --ran-proven prints JSON then the sentinel, exit 0', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'events.jsonl');
    const absFile = join(repo, 'scripts', 'dummy.test.mjs');
    writeFileSync(eventsFile, `${JSON.stringify({ file: absFile, passed: true })}\n`);
    runCli(repo, ['merge', '--key', key, '--file', eventsFile]);
    const r = runCli(repo, ['chunk-round', '--key', key, '--ran-proven']);
    assert.equal(r.status, 0, r.stderr);
    const { json: parsed, sentinel } = parseChunkRoundOutput(r.stdout);
    assert.deepEqual(Object.keys(parsed).sort(), [
      'green',
      'nonConvergent',
      'progressed',
      'ranProven',
      'rounds',
    ]);
    assert.equal(parsed.ranProven, true);
    assert.equal(
      parsed.progressed,
      true,
      'the first-ever round scored under a fresh key with a real green set is not stalling evidence',
    );
    assert.equal(parsed.rounds, 0);
    assert.equal(parsed.nonConvergent, false);
    assert.equal(parsed.green, 1);
    assert.equal(sentinel, 0, 'a progressing (non-non-convergent) round must sentinel =0');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// plan 3620 fix round (F1, findings 3ac118 et al.): WITHOUT --ran-proven, the exact same merged
// state must NEVER reach nonConvergent — and must write NOTHING to the ledger, proven here by
// diffing the on-disk record byte-for-byte across the call.
test('CLI chunk-round: WITHOUT --ran-proven a round is unscoreable — never reaches nonConvergent, sentinel=0, and writes NOTHING to the ledger', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'events.jsonl');
    const absFile = join(repo, 'scripts', 'dummy.test.mjs');
    writeFileSync(eventsFile, `${JSON.stringify({ file: absFile, passed: true })}\n`);
    runCli(repo, ['merge', '--key', key, '--file', eventsFile]);
    // Read the ledger record as it stands right after the merge, BEFORE the unscoreable call.
    const ledgerPath = join(resolveLedgerDir(repo), `${key}.json`);
    const before = readFileSync(ledgerPath, 'utf8');
    const r = runCli(repo, ['chunk-round', '--key', key]); // no --ran-proven
    assert.equal(r.status, 0, r.stderr);
    const { json: parsed, sentinel } = parseChunkRoundOutput(r.stdout);
    assert.deepEqual(parsed, {
      rounds: 0,
      progressed: true,
      nonConvergent: false,
      ranProven: false,
      green: 1,
    });
    assert.equal(sentinel, 0, 'an unscoreable round must never sentinel =1');
    const after = readFileSync(ledgerPath, 'utf8');
    assert.equal(after, before, 'an unscoreable round must not touch the ledger record at all');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI chunk-round: a missing/malformed --key degrades to the fail-safe answer, sentinel=0, exit 0, never a crash', () => {
  const repo = tmpRepo();
  const SAFE = { rounds: 0, progressed: true, nonConvergent: false, ranProven: false, green: 0 };
  try {
    const bogus = runCli(repo, ['chunk-round', '--key', 'not-a-real-key', '--ran-proven']);
    assert.equal(bogus.status, 0);
    const { json: bogusJson, sentinel: bogusSentinel } = parseChunkRoundOutput(bogus.stdout);
    assert.deepEqual(bogusJson, SAFE);
    assert.equal(bogusSentinel, 0);
    const missing = runCli(repo, ['chunk-round']);
    assert.equal(missing.status, 0);
    const { json: missingJson, sentinel: missingSentinel } = parseChunkRoundOutput(missing.stdout);
    assert.deepEqual(missingJson, SAFE);
    assert.equal(missingSentinel, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI pytest-chunk-round: same contract, over the pytest namespace — and independent of the battery namespace under the same key', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'py-events.jsonl');
    writeFileSync(
      eventsFile,
      [
        JSON.stringify({ type: 'collect', file: 'backend/scripts/dummy_test.py', count: 1 }),
        JSON.stringify({
          type: 'report',
          file: 'backend/scripts/dummy_test.py',
          outcome: 'passed',
          terminal: true,
        }),
        '',
      ].join('\n'),
    );
    runCli(repo, ['pytest-merge', '--key', key, '--file', eventsFile]);
    const r1 = runCli(repo, ['pytest-chunk-round', '--key', key, '--ran-proven']);
    assert.equal(r1.status, 0, r1.stderr);
    const { json: p1, sentinel: s1 } = parseChunkRoundOutput(r1.stdout);
    assert.equal(p1.green, 1);
    assert.equal(p1.progressed, true);
    assert.equal(p1.rounds, 0);
    assert.equal(p1.ranProven, true);
    assert.equal(s1, 0);
    // A SECOND round under the SAME key with NOTHING newly proven — a genuine zero-progress round
    // — must be visible here too (no re-merge between the two calls, matching a same-content
    // re-push that bakes nothing new). Still --ran-proven: this pins the acceptance criterion that
    // a REAL zero-progress round (evidenced) still counts. NON_CONVERGENT_ROUNDS is 2, so a single
    // zero round (rounds=1) is still short of the bound — sentinel stays 0.
    const r2 = runCli(repo, ['pytest-chunk-round', '--key', key, '--ran-proven']);
    const { json: p2, sentinel: s2 } = parseChunkRoundOutput(r2.stdout);
    assert.equal(p2.progressed, false);
    assert.equal(p2.rounds, 1);
    assert.equal(s2, 0, 'one zero-progress round is short of NON_CONVERGENT_ROUNDS');
    // And the BATTERY namespace under the identical key string must show no tally at all — the
    // two CLIs write to disjoint directories (resolvePytestLedgerDir vs resolveLedgerDir).
    const battery = runCli(repo, ['chunk-round', '--key', key, '--ran-proven']);
    const { json: pBattery } = parseChunkRoundOutput(battery.stdout);
    assert.equal(pBattery.green, 0, 'the battery namespace must not see the pytest merge');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// plan 3620 fix round G3: a THIRD round with STILL nothing new must trip NON_CONVERGENT_ROUNDS and
// the sentinel must flip to =1 exactly then — never earlier, never merely on `nonConvergent` alone
// without `ranProven`.
test('CLI pytest-chunk-round: the sentinel flips to =1 exactly when nonConvergent AND ranProven are both true', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'py-events.jsonl');
    writeFileSync(
      eventsFile,
      [
        JSON.stringify({ type: 'collect', file: 'backend/scripts/dummy_test.py', count: 1 }),
        JSON.stringify({
          type: 'report',
          file: 'backend/scripts/dummy_test.py',
          outcome: 'passed',
          terminal: true,
        }),
        '',
      ].join('\n'),
    );
    runCli(repo, ['pytest-merge', '--key', key, '--file', eventsFile]);
    runCli(repo, ['pytest-chunk-round', '--key', key, '--ran-proven']); // round 1: first-ever, progressed
    runCli(repo, ['pytest-chunk-round', '--key', key, '--ran-proven']); // round 2: zero-progress, rounds=1
    const r3 = runCli(repo, ['pytest-chunk-round', '--key', key, '--ran-proven']); // round 3: rounds=2
    const { json: p3, sentinel: s3 } = parseChunkRoundOutput(r3.stdout);
    assert.equal(p3.rounds, 2);
    assert.equal(p3.nonConvergent, true);
    assert.equal(s3, 1, 'two consecutive zero-progress rounds must sentinel =1');

    // Without --ran-proven, the SAME on-disk state (still two banked zero rounds) must sentinel
    // =0 — nonConvergent alone, without ranProven, must never trip the sentinel.
    const r4 = runCli(repo, ['pytest-chunk-round', '--key', key]); // no --ran-proven
    const { json: p4, sentinel: s4 } = parseChunkRoundOutput(r4.stdout);
    assert.equal(p4.ranProven, false);
    assert.equal(p4.nonConvergent, false, 'unscoreable rounds never report nonConvergent:true');
    assert.equal(s4, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// plan 3620 fix round (I1) — THE ACCEPTANCE CRITERION THIS PLAN EXISTS TO MEET: two ran-proven,
// merge-persisted, ZERO-PROGRESS rounds on the SAME commit (key) must trip the bound — the
// canonical "a chunk-capped gate stuck on one over-wall file banks nothing every round" case. Each
// round here drives the REAL `merge` CLI with a vacuous (nothing-passed) events file and asserts
// its own MERGE_PERSISTED=1 sentinel BEFORE feeding `--ran-proven` to `chunk-round` — mirroring
// exactly what scripts/hooks/pre-push.sh's two live seats do once I1 makes that sentinel true for
// this shape (their own `MERGE_PERSISTED=1` AND positive-events-count seat logic is untouched by
// this plan — see pre-push-hook.test.mjs's own I1-labelled cases for that half). Also pins the two
// escapes: a round that banks >=1 NEW file resets the counter, and a NEW commit (a different key)
// starts its own tally from zero even immediately after a non-convergent round on another key.
test('CLI merge + chunk-round (I1 acceptance): two ran-proven, merge-persisted, ZERO-progress rounds on the SAME commit trip the bound; progress resets it; a new key starts fresh', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();

    // A vacuous round: the reporter's destination exists and is well-formed, but the one file it
    // covers FAILED — nothing PASSED this attempt. Before the I1 fix `merge` printed
    // MERGE_PERSISTED=0 for this exact shape and the hook could never even reach `chunk-round
    // --ran-proven` for it (see the (I1 vacuous) merge test above for the isolated red-state proof).
    const vacuousEvents = join(repo, 'vacuous-events.jsonl');
    const absStuck = join(repo, 'scripts', 'stuck.test.mjs');
    writeFileSync(vacuousEvents, `${JSON.stringify({ file: absStuck, passed: false })}\n`);

    // Round 1.
    const merge1 = runCli(repo, ['merge', '--key', key, '--file', vacuousEvents]);
    assert.equal(
      merge1.stdout.trim(),
      `${MERGE_PERSISTED_SENTINEL}=1`,
      'a vacuous but non-throwing merge must persist=1 for the hook to ever call chunk-round --ran-proven',
    );
    const r1 = runCli(repo, ['chunk-round', '--key', key, '--ran-proven']);
    const { json: p1, sentinel: s1 } = parseChunkRoundOutput(r1.stdout);
    assert.equal(p1.ranProven, true);
    assert.equal(p1.green, 0);
    assert.equal(
      p1.progressed,
      false,
      'the first-ever round with an empty green set is not progress',
    );
    assert.equal(p1.rounds, 1);
    assert.equal(s1, 0, 'one zero-progress round is short of NON_CONVERGENT_ROUNDS');

    // Round 2 — same vacuous shape, same key/commit: the second consecutive zero-progress round.
    const merge2 = runCli(repo, ['merge', '--key', key, '--file', vacuousEvents]);
    assert.equal(merge2.stdout.trim(), `${MERGE_PERSISTED_SENTINEL}=1`);
    const r2 = runCli(repo, ['chunk-round', '--key', key, '--ran-proven']);
    const { json: p2, sentinel: s2 } = parseChunkRoundOutput(r2.stdout);
    assert.equal(p2.rounds, 2);
    assert.equal(
      p2.nonConvergent,
      true,
      'ACCEPTANCE: two ran-proven, merge-persisted, zero-progress rounds on the same commit must trip the bound',
    );
    assert.equal(s2, 1);

    // A round that DOES bank >=1 new file resets the counter — non-convergence is about
    // CONSECUTIVE zero rounds, not a permanent verdict on the key.
    const progressEvents = join(repo, 'progress-events.jsonl');
    const absPass = join(repo, 'scripts', 'dummy.test.mjs');
    writeFileSync(progressEvents, `${JSON.stringify({ file: absPass, passed: true })}\n`);
    const merge3 = runCli(repo, ['merge', '--key', key, '--file', progressEvents]);
    assert.equal(merge3.stdout.trim(), `${MERGE_PERSISTED_SENTINEL}=1`);
    const r3 = runCli(repo, ['chunk-round', '--key', key, '--ran-proven']);
    const { json: p3, sentinel: s3 } = parseChunkRoundOutput(r3.stdout);
    assert.equal(
      p3.progressed,
      true,
      'a round that banks a new file is progress, not a zero round',
    );
    assert.equal(p3.rounds, 0, 'progress clears the consecutive zero-round tally');
    assert.equal(s3, 0);

    // A NEW commit (a genuinely different content key) starts its own tally from zero, unaffected
    // by the non-convergent round already banked on the FIRST key above. A second repo stands in
    // for "a new commit" here, but its selected file must actually carry DIFFERENT content — two
    // tmpRepo()s built from byte-identical fixtures derive the IDENTICAL key (this module keys off
    // content, never repo path/identity), so the divergence has to be a real content change.
    const repo2 = tmpRepo();
    try {
      writeFileSync(join(repo2, 'scripts', 'dummy.test.mjs'), "import 'node:test'; // repo2\n");
      commitAll(repo2, 'diverge');
      const key2 = runCli(repo2, ['key'], { input: SEL }).stdout.trim();
      assert.notEqual(key2, key, 'a different commit/repo must derive a different content key');
      const vacuousEvents2 = join(repo2, 'vacuous-events.jsonl');
      writeFileSync(
        vacuousEvents2,
        `${JSON.stringify({ file: join(repo2, 'scripts', 'stuck.test.mjs'), passed: false })}\n`,
      );
      const merge4 = runCli(repo2, ['merge', '--key', key2, '--file', vacuousEvents2]);
      assert.equal(merge4.stdout.trim(), `${MERGE_PERSISTED_SENTINEL}=1`);
      const r4 = runCli(repo2, ['chunk-round', '--key', key2, '--ran-proven']);
      const { json: p4, sentinel: s4 } = parseChunkRoundOutput(r4.stdout);
      assert.equal(
        p4.rounds,
        1,
        'a new key/commit starts its own tally from zero, unaffected by any other key',
      );
      assert.equal(s4, 0);
    } finally {
      rmSync(repo2, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- CLI: pytest-remainder / pytest-merge (plan 3223 pytest half) -------------------------------
// Same tmpRepo()/runCli fixtures as the battery `remainder`/`merge` tests above — the pytest-side
// commands validate a key's SHAPE only (never its provenance), so a throwaway repo's ordinary
// battery key is a perfectly real 32-hex-char key to exercise them under.

const PY_SEL = 'backend/scripts/dummy_test.py\n';

test('CLI pytest-remainder: with no ledger yet, returns the full selection unchanged', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const r = runCli(repo, ['pytest-remainder', '--key', key], { input: PY_SEL });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'backend/scripts/dummy_test.py');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI pytest-remainder: a missing/malformed --key degrades to the full selection, never a crash', () => {
  const repo = tmpRepo();
  try {
    const bogus = runCli(repo, ['pytest-remainder', '--key', 'not-a-real-key'], { input: PY_SEL });
    assert.equal(bogus.status, 0);
    assert.equal(bogus.stdout.trim(), 'backend/scripts/dummy_test.py');
    const missing = runCli(repo, ['pytest-remainder'], { input: PY_SEL });
    assert.equal(missing.status, 0);
    assert.equal(missing.stdout.trim(), 'backend/scripts/dummy_test.py');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI pytest-merge then pytest-remainder: a file the events prove green (collected==reported, no failure) is subtracted next time', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'py-events.jsonl');
    writeFileSync(
      eventsFile,
      [
        JSON.stringify({ type: 'collect', file: 'backend/scripts/dummy_test.py', count: 1 }),
        JSON.stringify({
          type: 'report',
          file: 'backend/scripts/dummy_test.py',
          outcome: 'passed',
          terminal: true,
        }),
        '',
      ].join('\n'),
    );
    const merge = runCli(repo, ['pytest-merge', '--key', key, '--file', eventsFile]);
    assert.equal(merge.status, 0, merge.stderr);
    const r = runCli(repo, ['pytest-remainder', '--key', key], { input: PY_SEL });
    assert.equal(r.stdout.trim(), ''); // fully covered — nothing left to run
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('plan 3766: an entry pytest-merge writes WITHOUT --head is never returned by findCarryForwardBaseline — the carry-forward invariant a selection-scoped subset key depends on', () => {
  // pre-push.sh's SUBSET arm calls `battery-ledger.mjs pytest-merge --key "$PYTEST_LEDGER_KEY"
  // --file <events>` with NO --head (see that call site's own comment, plan 3223/3766) — this is
  // the REAL CLI path a plan-3766 selection-scoped key rides end-to-end, not a hand-seeded
  // fixture (the generic "an entry with NO head is never a baseline" case above already covers a
  // fixture written directly; this proves the WRITE PATH ITSELF never attaches a head when the
  // caller omits one). Without this holding, a selection-scoped entry could accidentally seed the
  // land tier's carry-forward baseline — a narrow SUBSET green would then shrink a LATER,
  // unrelated push's FULL-suite selection, exactly the stale-green class this plan's whole
  // soundness argument rules out (see gate-pass-cache.mjs's deriveSelectionKey header and
  // pre-push.sh's own key-derivation arm).
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'py-events-no-head.jsonl');
    writeFileSync(
      eventsFile,
      [
        JSON.stringify({ type: 'collect', file: 'backend/scripts/dummy_test.py', count: 1 }),
        JSON.stringify({
          type: 'report',
          file: 'backend/scripts/dummy_test.py',
          outcome: 'passed',
          terminal: true,
        }),
        '',
      ].join('\n'),
    );
    // No --head — exactly pre-push.sh's own SUBSET-arm call shape.
    const merge = runCli(repo, ['pytest-merge', '--key', key, '--file', eventsFile]);
    assert.equal(merge.status, 0, merge.stderr);
    const pytestDir = resolvePytestLedgerDir(repo);
    const entry = JSON.parse(readFileSync(join(pytestDir, `${key}.json`), 'utf8'));
    assert.equal(
      entry.head,
      undefined,
      'pytest-merge must never invent a head the caller did not vouch for',
    );
    assert.ok(
      entry.green.includes('backend/scripts/dummy_test.py'),
      `the merge must have really banked a green file; entry:\n${JSON.stringify(entry)}`,
    );
    // Real proof landed on disk — yet findCarryForwardBaseline, scanning the SAME directory the
    // CLI just wrote to, must still refuse it as a baseline for a different (later push's) key.
    const baseline = findCarryForwardBaseline(pytestDir, '9'.repeat(32), Date.now());
    assert.equal(
      baseline,
      null,
      'a headless entry — however much real green proof it carries — must never seed a ' +
        "later push's carry-forward baseline",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI pytest-merge: a file short of its collected count (a kill mid-file) is never subtracted — the next remainder still names it', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const eventsFile = join(repo, 'py-events.jsonl');
    writeFileSync(
      eventsFile,
      [
        JSON.stringify({ type: 'collect', file: 'backend/scripts/dummy_test.py', count: 2 }),
        JSON.stringify({
          type: 'report',
          file: 'backend/scripts/dummy_test.py',
          outcome: 'passed',
          terminal: true,
        }),
        '', // the SECOND collected test's report never arrived — killed mid-run
      ].join('\n'),
    );
    runCli(repo, ['pytest-merge', '--key', key, '--file', eventsFile]);
    const r = runCli(repo, ['pytest-remainder', '--key', key], { input: PY_SEL });
    assert.equal(r.stdout.trim(), 'backend/scripts/dummy_test.py'); // never subtracted
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI pytest-merge: a nonexistent --file is a silent no-op (exit 0, never blocks close-out) and reports MERGE_PERSISTED=0 — zero event sources, unchanged by I1', () => {
  const repo = tmpRepo();
  try {
    const key = runCli(repo, ['key'], { input: SEL }).stdout.trim();
    const r = runCli(repo, [
      'pytest-merge',
      '--key',
      key,
      '--file',
      join(repo, 'does-not-exist.jsonl'),
    ]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), `${MERGE_PERSISTED_SENTINEL}=0`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('resolveLedgerDir + LEDGER_ARG_SPEC: exported shape sanity (drift guard for the CLI surface)', () => {
  // Drive-qualified anchor (plan-2490 [join-rooted-literal] shape): join() and resolve() agree
  // on a drive-qualified root on every platform, so this survives a future join->resolve
  // migration inside resolveLedgerDir instead of merely tracking today's primitive.
  const anchor = resolve('/x');
  assert.equal(resolveLedgerDir(anchor), join(anchor, '.scratch', 'gate-ledgers'));
  assert.equal(resolvePytestLedgerDir(anchor), join(anchor, '.scratch', 'gate-ledgers', 'pytest'));
  // `head` joined the surface with plan 3225's delta baseline (see mergeGreenFiles' header).
  assert.deepEqual([...LEDGER_ARG_SPEC.value].sort(), ['file', 'head', 'key']);
});

// =================================================================================================
// EMPIRICAL — re-verifies, against the REAL node:test runner, the two facts
// battery-ledger-reporter.mjs's header pins. Run these with `node --test` directly (never faked).
// =================================================================================================

function fixtureDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// This whole file runs under `node --test` itself, which sets NODE_TEST_CONTEXT=child-v8 in ITS
// OWN env — inherited by default into any child spawnSync/spawn call. A NESTED `node --test`
// that inherits it mistakes itself for an IPC child of the OUTER runner and silently reports
// success without running anything at all (verified live: dest-file-exists but zero events —
// exactly the pre-push hook's own documented reason for defensively unsetting this same var
// before its real battery invocation). Every real `node --test` child spawned below strips it.
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function writePassFile(dir, name) {
  writeFileSync(
    join(dir, name),
    "import test from 'node:test';\nimport assert from 'node:assert';\n" +
      `test('${name} passes', () => { assert.equal(1, 1); });\n`,
  );
}

function writeFailFile(dir, name) {
  writeFileSync(
    join(dir, name),
    "import test from 'node:test';\nimport assert from 'node:assert';\n" +
      `test('${name} fails', () => { assert.equal(1, 2); });\n`,
  );
}

function writeCrashFile(dir, name) {
  writeFileSync(join(dir, name), "throw new Error('boom at import time');\n");
}

function writeSlowFile(dir, name, ms) {
  writeFileSync(
    join(dir, name),
    "import test from 'node:test';\nimport assert from 'node:assert';\n" +
      `test('${name} slow', async () => { await new Promise((r) => setTimeout(r, ${ms})); assert.equal(1, 1); });\n`,
  );
}

// Runs `node --test` with ONLY the ledger reporter attached (no spec/tap), against `files`
// (relative names), from cwd=dir — the exact invocation shape the pre-push hook and
// done-worktree's preflight both use (repo-relative test paths). Returns the reporter's raw
// destination-file text.
function runReporterOnly(dir, files, { absolute = false } = {}) {
  const dest = join(dir, 'ledger-events.jsonl');
  const targets = absolute ? files.map((f) => join(dir, f)) : files;
  const r = spawnSync(
    process.execPath,
    ['--test', `--test-reporter=${REPORTER}`, `--test-reporter-destination=${dest}`, ...targets],
    { cwd: dir, encoding: 'utf8', env: childEnv() },
  );
  // node --test exits 0 (all passed) or 1 (a test failed) — both are real runs this helper's
  // callers assert against. ANY other exit is the harness itself failing to start (a reporter that
  // will not load, a bad flag), which produces an empty destination file and would otherwise
  // surface as an unreadable "expected 1, got 0" on the caller's line with the actual cause
  // discarded on the child's stderr. Fail here instead, quoting it.
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(
      `nested \`node --test\` failed to start (status ${r.status}, signal ${r.signal}). ` +
        `stderr:\n${r.stderr || '(empty)'}`,
    );
  }
  return { out: existsSync(dest) ? readFileSync(dest, 'utf8') : '', status: r.status };
}

test('EMPIRICAL: relative invocation — the reporter emits exactly one green line per file (nested describe + top-level tests aggregate correctly)', () => {
  const dir = fixtureDir('battery-ledger-empirical-rel-');
  try {
    writePassFile(dir, 'ok.test.mjs');
    writeFailFile(dir, 'bad.test.mjs');
    const { out } = runReporterOnly(dir, ['ok.test.mjs', 'bad.test.mjs']);
    const { passed, failed, durations } = parseLedgerEvents(out);
    assert.equal(passed.size, 1);
    assert.equal(failed.size, 1);
    assert.ok([...passed][0].endsWith('ok.test.mjs'));
    assert.ok([...failed][0].endsWith('bad.test.mjs'));
    // plan 4236 T5: every file line carries its own wall time (a finite, non-negative ms figure)
    assert.equal(durations.size, 2);
    for (const ms of durations.values()) assert.ok(Number.isInteger(ms) && ms >= 0, String(ms));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('EMPIRICAL: absolute invocation — the same one-line-per-file contract holds (name===file coincidentally true, must not be RELIED on)', () => {
  const dir = fixtureDir('battery-ledger-empirical-abs-');
  try {
    writePassFile(dir, 'ok.test.mjs');
    const { out } = runReporterOnly(dir, ['ok.test.mjs'], { absolute: true });
    const { passed } = parseLedgerEvents(out);
    assert.equal(passed.size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('EMPIRICAL: a file that crashes at import time (registers zero tests) still gets a false-passed wrapper line, not silence', () => {
  const dir = fixtureDir('battery-ledger-empirical-crash-');
  try {
    writeCrashFile(dir, 'crash.test.mjs');
    writePassFile(dir, 'ok.test.mjs');
    const { out } = runReporterOnly(dir, ['crash.test.mjs', 'ok.test.mjs']);
    const { passed, failed } = parseLedgerEvents(out);
    assert.equal(passed.size, 1);
    assert.equal(failed.size, 1);
    assert.ok([...failed][0].endsWith('crash.test.mjs'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('EMPIRICAL: a SIGKILLed run leaves ALREADY-COMPLETED files intact and writes nothing for the file still in flight', async () => {
  const dir = fixtureDir('battery-ledger-empirical-kill-');
  let child = null;
  try {
    writePassFile(dir, 'fast.test.mjs');
    writeSlowFile(dir, 'slow.test.mjs', 8000);
    const dest = join(dir, 'ledger-events.jsonl');
    child = spawn(
      process.execPath,
      [
        '--test',
        `--test-reporter=${REPORTER}`,
        `--test-reporter-destination=${dest}`,
        'fast.test.mjs',
        'slow.test.mjs',
      ],
      // stderr is PIPED, never 'ignore': this case deliberately kills the child, so the child's own
      // exit reason is the only evidence distinguishing "killed mid-flight, as designed" from "died
      // at startup and the kill hit a corpse". Discarding it cost ~90 minutes of a wedged battery.
      { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], env: childEnv() },
    );
    let childErr = '';
    child.stderr.on('data', (c) => {
      childErr += c;
    });
    // Subscribe BEFORE the wait, never after the kill, and settle on 'error' as well as 'exit'.
    // 'exit' fires once and is not replayed to a late subscriber, so
    // `await new Promise((r) => child.on('exit', r))` written after a delay is an unbounded hang
    // whenever the child is already gone — and `node --test` runs with no per-test timeout, so that
    // hang never resolves, never fails, and stalls the whole battery (and therefore every land
    // gated on it) instead of reporting anything. That is the shape that actually fired here: the
    // reporter specifier was unloadable on Windows, the child died in milliseconds, and its 'exit'
    // was emitted into a fixed sleep with nobody listening.
    //
    // 'error' is the OTHER way this waits forever: a spawn that fails outright (ENOENT, EPERM) may
    // emit 'error' and never 'exit' at all, and a ChildProcess 'error' with no listener is an
    // uncaught exception besides. Settling on either event makes both paths terminate.
    let spawnError = null;
    const exited = new Promise((r) => {
      child.once('exit', (code, signal) => r({ code, signal }));
      child.once('error', (err) => {
        spawnError = err;
        r({ code: null, signal: null });
      });
    });
    // Wait on the EVIDENCE, not on a fixed delay: poll until fast.test.mjs's green line has actually
    // reached the ledger. A hard-coded sleep has to be simultaneously long enough for the fast file
    // under Windows process-start contention and short enough to stay inside slow.test.mjs's 8s
    // window; under parallel-session load that is not a safe margin, and getting it wrong makes an
    // unrelated land go red with a confusing "expected exactly fast.test.mjs to be green". Polling
    // needs no margin at all — it proceeds the moment the premise is true.
    const deadline = 6000; // still well inside slow.test.mjs's 8s, so it is guaranteed in flight
    const startedAt = process.hrtime.bigint();
    const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;
    while (
      elapsedMs() < deadline &&
      !spawnError &&
      child.exitCode === null &&
      child.signalCode === null &&
      parseLedgerEvents(existsSync(dest) ? readFileSync(dest, 'utf8') : '').passed.size === 0
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(
      spawnError,
      null,
      `the child failed to spawn: ${spawnError && spawnError.message}`,
    );
    // The premise of the case, asserted rather than assumed: a child that already exited makes the
    // kill a no-op and every assertion below it vacuous.
    assert.equal(
      child.exitCode === null && child.signalCode === null,
      true,
      `the child must still be running when killed (it is what makes slow.test.mjs "in flight"), ` +
        `but it had already exited after ${Math.round(elapsedMs())}ms: ` +
        `code=${child.exitCode} signal=${child.signalCode}. child stderr:\n${childErr || '(empty)'}`,
    );
    child.kill('SIGKILL');
    await exited;
    const out = existsSync(dest) ? readFileSync(dest, 'utf8') : '';
    const { passed, failed } = parseLedgerEvents(out);
    assert.equal(passed.size, 1, `expected exactly fast.test.mjs to be green, got: ${out}`);
    assert.ok([...passed][0].endsWith('fast.test.mjs'));
    assert.equal(
      failed.size,
      0,
      'the killed slow file must never read as a failure either — just absent',
    );
  } finally {
    // The child outlives a THROWN assertion: every assertion above runs while it is deliberately
    // still alive, so an early failure would otherwise leak a live `node --test` (plus its own
    // workers) into the rest of the battery, competing for the same CPU the load-flake triage in
    // CLAUDE.md already warns about. Unconditional and idempotent — killing an exited child is a
    // no-op, and this is the only exit path the test has.
    if (child) child.kill('SIGKILL');
    // Cleanup must never decide this case's verdict. Windows refuses to remove a directory any live
    // process still holds open, SIGKILL is asynchronous, and `node --test` runs each target file in
    // its OWN worker process — killing the parent does not reap those workers, which keep `dir` as
    // their cwd for a few more milliseconds. So a plain rmSync races them and throws EPERM AFTER
    // every assertion above has already passed, turning a green case red (and, in a full battery,
    // blocking a land) over nothing. The retries normally win; a fixture dir that outlives them is
    // inert in the OS temp dir — and is in fact what made the original hang diagnosable, since the
    // surviving battery-ledger-empirical-kill-* dirs are what pinpointed the wedged case.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (err) {
      console.error(
        `battery-ledger.test: fixture dir left behind (harmless) — ${dir}: ${err.code || err.message}`,
      );
    }
  }
});

test('EMPIRICAL: three simultaneous --test-reporter pairs (spec+tap+ledger) never trip MaxListenersExceededWarning, and spec output is unaffected', () => {
  const dir = fixtureDir('battery-ledger-empirical-listeners-');
  try {
    writePassFile(dir, 'ok.test.mjs');
    const tapDest = join(dir, 'tap.out');
    const ledgerDest = join(dir, 'ledger.out');
    const r = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-reporter=spec',
        '--test-reporter-destination=stdout',
        '--test-reporter=tap',
        `--test-reporter-destination=${tapDest}`,
        `--test-reporter=${REPORTER}`,
        `--test-reporter-destination=${ledgerDest}`,
        'ok.test.mjs',
      ],
      { cwd: dir, encoding: 'utf8', env: childEnv() },
    );
    assert.doesNotMatch(r.stdout + r.stderr, /MaxListenersExceededWarning/);
    assert.match(r.stdout, /ok\.test\.mjs passes/);
    assert.ok(existsSync(ledgerDest));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── defaultNonTtyReporter: the version→reporter mapping ───────────────────────────────────────
// Relocated here from done-worktree-lib.test.mjs by plan 3962 Decision 5, alongside
// defaultNonTtyReporter() itself. The AGREEMENT with node's real behaviour is pinned
// empirically just below, against whichever node actually runs. What is unit-testable here —
// and what that empirical test cannot reach, since one process runs one node — is the mapping
// ACROSS versions: this repo runs node 22 on the Linux cloud drains and node 24 locally, and a
// stand-in that is right on only one of them is the exact defect this function replaced (a
// hard-coded 'tap', proven on 22, failing every local battery on 24 and therefore blocking
// every local land).
test('defaultNonTtyReporter: tap through node 22, spec from node 23 on — both of this repo runtimes', () => {
  assert.equal(defaultNonTtyReporter('v22.22.2'), 'tap', 'the cloud-drain node');
  assert.equal(defaultNonTtyReporter('v24.14.1'), 'spec', 'the local Windows node');
  // The boundary itself, from both sides — node 23.0.0 is the release that made spec the default
  // for every stdout shape, so an off-by-one here silently garbles a diagnostic on one runtime.
  assert.equal(defaultNonTtyReporter('v22.0.0'), 'tap');
  assert.equal(defaultNonTtyReporter('v23.0.0'), 'spec');
  // Forward-compatible, and never throws on junk: an unreadable version degrades to the answer that
  // is correct for every node from 23 on, rather than to the one that is now historical.
  assert.equal(defaultNonTtyReporter('v99.1.0'), 'spec');
  assert.equal(defaultNonTtyReporter('not-a-version'), 'spec');
  // No argument at all reads the running node, which is how the caller uses it.
  assert.equal(defaultNonTtyReporter(), defaultNonTtyReporter(process.version));
});

// plan 3223 (re-review finding B/CONFIRMED): done-worktree.mjs's ledger-active reporter pair
// (runFullBatteryPreflight, `--test-reporter=tap --test-reporter-destination=stdout` alongside the
// ledger reporter — see that function's own header comment) hard-codes 'tap' as "what node's
// IMPLICIT default reporter renders on a non-TTY piped stdout", so the preflight's diagnostic
// out/tail capture keeps reading today's byte-identical shape once the ledger reporter also has to
// be attached (attaching ANY explicit --test-reporter suppresses node's own implicit default). That
// literal was ALREADY wrong once in this very review round (an earlier fix pinned 'spec', corrected
// only by hand re-verification against the real runtime) and nothing automated pins it — a future
// node upgrade that changes the non-TTY default reporter would silently change the captured
// diagnostic tail's format and only ever surface as a garbled failure excerpt in a hard-to-reproduce
// pre-push/deploy run. This test empirically re-derives node's ACTUAL non-TTY default reporter —
// piped, non-TTY stdout, zero --test-reporter flags — and asserts done-worktree's stand-in AGREES
// with it, so a node upgrade that changes the default fails THIS test loudly instead of degrading a
// diagnostic silently.
//
// It no longer asserts a FIXED shape. Doing so was itself the bug: the answer is node-version
// dependent (`tap` ≤ node 22, `spec` from node 23), so pinning TAP unconditionally passed on the
// node 22 cloud drains that proved it and failed on every node 24 local run — and a failure in the
// full battery blocks every local land. The subject under test is the AGREEMENT between the
// stand-in and the runtime, which is version-independent; the literal never was.
test("EMPIRICAL: done-worktree's stand-in reporter matches node's OWN implicit default on piped (non-TTY) stdout", () => {
  const dir = fixtureDir('battery-ledger-empirical-default-reporter-');
  try {
    writePassFile(dir, 'ok.test.mjs');
    // No --test-reporter flag at all: this is node's OWN implicit-default selection, the exact
    // thing runFullBatteryPreflight's comment claims and this test re-verifies. `spawnSync`'s
    // `stdio: 'pipe'` (the default when `encoding` is set) is itself the non-TTY shape — a real
    // pipe, never a pty — matching runViaTestQueue's own `stdio: ['ignore', 'pipe', 'pipe']`.
    const r = spawnSync(process.execPath, ['--test', 'ok.test.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      env: childEnv(),
    });
    // Classify by the ONE marker that is part of a specification rather than of a rendering style:
    // TAP output must open with its version line. Everything else is 'spec' — the stand-in has
    // exactly two possible values, so a binary test is all the agreement check needs.
    //
    // Deliberately NOT a positive fingerprint of spec (its checkmark glyph, its indentation, its
    // summary lines): those are cosmetic, node changes them between releases, and a classifier that
    // can return "unrecognised" turns a cosmetic upstream tweak into a hard block on every land.
    // The vacuity guard below is what keeps this honest — empty or truncated stdout cannot pass as
    // "not TAP, therefore spec".
    const observed = /^TAP version \d+$/m.test(r.stdout) ? 'tap' : 'spec';
    const FAIL_MESSAGE =
      `node ${process.version}'s non-TTY implicit default reporter renders as '${observed}', but ` +
      `battery-ledger's defaultNonTtyReporter() says '${defaultNonTtyReporter()}'. ` +
      "runFullBatteryPreflight re-attaches that value explicitly to preserve the preflight's " +
      'captured diagnostic shape once the ledger reporter is also attached (see its header comment ' +
      'beside LEDGER_REPORTER), so the two must agree. Fix the mapping in defaultNonTtyReporter, ' +
      'not this test. Got stdout:\n' +
      r.stdout;
    // The vacuity guard runs FIRST: whichever reporter ran, it reported the passing test. Without
    // this, empty stdout would classify as 'spec' and could agree with the stand-in by accident.
    assert.match(r.stdout, /ok\.test\.mjs passes/, FAIL_MESSAGE);
    assert.equal(observed, defaultNonTtyReporter(), FAIL_MESSAGE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// plan 3225 Fix A — DELTA-SCOPED CARRY-FORWARD
//
// The invariant every case below defends is the one the whole feature rests on: A FILE IS ONLY
// EVER CARRIED WHEN A PREVIOUS LIVE GREEN PROVED IT *AND* THE GATE'S OWN SELECTOR SAYS THE DELTA
// SINCE THAT GREEN CANNOT REACH IT. Every other outcome — no baseline, a baseline with no verified
// `head`, an expired baseline, a git failure, a selector that says FULL, a delta path the selector
// does not map — carries nothing, which is byte-for-byte today's full run.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// --- pure: the record-shape extension (`head`) --------------------------------------------------

test('isCommitOid: only a full 40-char lowercase hex oid qualifies as a delta baseline', () => {
  assert.equal(isCommitOid('a'.repeat(40)), true);
  // An ABBREVIATION is rejected on purpose (unlike battery-pass-cache's looksLikeOid, which
  // validates an operator-pinned short merge-base): a truncated/garbled baseline could resolve to
  // a DIFFERENT commit than the one actually proven.
  assert.equal(isCommitOid('a'.repeat(7)), false);
  assert.equal(isCommitOid('A'.repeat(40)), false);
  assert.equal(isCommitOid('z'.repeat(40)), false);
  assert.equal(isCommitOid(undefined), false);
  assert.equal(isCommitOid(null), false);
});

test('mergeGreenFiles: a vouched-for head is recorded on the entry', () => {
  const dir = fixtureDir('ledger-head-write-');
  try {
    const head = 'b'.repeat(40);
    mergeGreenFiles(dir, 'a'.repeat(32), new Set(['scripts/x.test.mjs']), at(0), DEFAULT_TTL_MIN, {
      head,
    });
    const entry = JSON.parse(readFileSync(join(dir, `${'a'.repeat(32)}.json`), 'utf8'));
    assert.equal(entry.head, head);
    assert.deepEqual(entry.green, ['scripts/x.test.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeGreenFiles: a merge with NO head DROPS a pre-existing one — the green set now spans two commits, so no single commit describes it', () => {
  const dir = fixtureDir('ledger-head-drop-');
  const key = 'a'.repeat(32);
  try {
    mergeGreenFiles(dir, key, new Set(['scripts/x.test.mjs']), at(0), DEFAULT_TTL_MIN, {
      head: 'b'.repeat(40),
    });
    mergeGreenFiles(dir, key, new Set(['scripts/y.test.mjs']), at(1));
    const entry = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8'));
    assert.equal(entry.head, undefined, 'a head nobody re-vouched for must not survive');
    assert.deepEqual(entry.green, ['scripts/x.test.mjs', 'scripts/y.test.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeGreenFiles: a malformed head is treated exactly like an absent one', () => {
  const dir = fixtureDir('ledger-head-malformed-');
  try {
    mergeGreenFiles(dir, 'a'.repeat(32), new Set(['scripts/x.test.mjs']), at(0), DEFAULT_TTL_MIN, {
      head: 'not-an-oid',
    });
    const entry = JSON.parse(readFileSync(join(dir, `${'a'.repeat(32)}.json`), 'utf8'));
    assert.equal(entry.head, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- pure: verifiedHead, the stale-green pin on the baseline ------------------------------------

test('verifiedHead: accepts the claimed oid only while HEAD still points at it', () => {
  const head = 'c'.repeat(40);
  assert.equal(verifiedHead(head, { git: () => `${head}\n` }), head);
});

test('verifiedHead: HEAD moving across the run (a commit landing mid-gate) refuses the baseline', () => {
  assert.equal(
    verifiedHead('c'.repeat(40), { git: () => `${'d'.repeat(40)}\n` }),
    undefined,
    'greens proven at two different commits must not be attributed to one',
  );
});

test('verifiedHead: git trouble, and a non-oid claim, both refuse without throwing', () => {
  assert.equal(
    verifiedHead('c'.repeat(40), {
      git: () => {
        throw new Error('not a git repository');
      },
    }),
    undefined,
  );
  assert.equal(verifiedHead('', { git: () => 'c'.repeat(40) }), undefined);
});

// --- pure: baseline selection (TTL is the plan's own explicit acceptance case) -------------------

function seedEntry(dir, key, { iso, green, head }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${key}.json`),
    JSON.stringify({ iso, green, ...(head ? { head } : {}) }),
  );
}

test('findCarryForwardBaseline: picks the NEWEST live entry carrying a head and a non-empty green set', () => {
  const dir = fixtureDir('ledger-baseline-newest-');
  try {
    seedEntry(dir, '1'.repeat(32), {
      iso: new Date(at(-60)).toISOString(),
      green: ['scripts/old.test.mjs'],
      head: 'a'.repeat(40),
    });
    seedEntry(dir, '2'.repeat(32), {
      iso: new Date(at(-10)).toISOString(),
      green: ['scripts/new.test.mjs'],
      head: 'b'.repeat(40),
    });
    const b = findCarryForwardBaseline(dir, '9'.repeat(32), at(0));
    // Newest wins because the closest baseline yields the SMALLEST delta, hence the tightest
    // selection — not because it is somehow more trustworthy.
    assert.equal(b.key, '2'.repeat(32));
    assert.equal(b.head, 'b'.repeat(40));
    assert.deepEqual([...b.green], ['scripts/new.test.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findCarryForwardBaseline: the key being carried INTO is excluded — an entry can never be its own baseline', () => {
  const dir = fixtureDir('ledger-baseline-exclude-');
  const key = '1'.repeat(32);
  try {
    seedEntry(dir, key, {
      iso: new Date(at(0)).toISOString(),
      green: ['scripts/x.test.mjs'],
      head: 'a'.repeat(40),
    });
    assert.equal(findCarryForwardBaseline(dir, key, at(0)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findCarryForwardBaseline: an entry with NO head is never a baseline (no run ever vouched for its commit)', () => {
  const dir = fixtureDir('ledger-baseline-nohead-');
  try {
    seedEntry(dir, '1'.repeat(32), {
      iso: new Date(at(0)).toISOString(),
      green: ['scripts/x.test.mjs'],
    });
    assert.equal(findCarryForwardBaseline(dir, '9'.repeat(32), at(0)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findCarryForwardBaseline: an EXPIRED previous green is never a baseline — the TTL is honored (plan 3225 acceptance)', () => {
  const dir = fixtureDir('ledger-baseline-expired-');
  try {
    seedEntry(dir, '1'.repeat(32), {
      iso: new Date(at(0)).toISOString(),
      green: ['scripts/x.test.mjs'],
      head: 'a'.repeat(40),
    });
    assert.ok(findCarryForwardBaseline(dir, '9'.repeat(32), at(DEFAULT_TTL_MIN - 1)));
    assert.equal(
      findCarryForwardBaseline(dir, '9'.repeat(32), at(DEFAULT_TTL_MIN + 1)),
      null,
      'the lockfile-vs-node_modules drift bound applies to a delta record exactly as it does to a cache entry',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findCarryForwardBaseline: an absent ledger dir is not an error — it is simply "nothing to carry"', () => {
  assert.equal(
    findCarryForwardBaseline(
      join(tmpdir(), `ledger-does-not-exist-${process.pid}`),
      'a'.repeat(32),
      at(0),
    ),
    null,
  );
});

// --- pure: the delta itself ----------------------------------------------------------------------

test('changedFilesBetween: parses git output into repo-relative paths, CR-tolerant', () => {
  const git = () => 'scripts/a.mjs\r\nbackend/scripts/b.py\n\n';
  assert.deepEqual(changedFilesBetween(git, 'a'.repeat(40)), [
    'scripts/a.mjs',
    'backend/scripts/b.py',
  ]);
});

test('changedFilesBetween: an unreachable baseline commit (pruned object, re-clone) yields null, never a guess', () => {
  const git = () => {
    throw new Error('fatal: bad object');
  };
  assert.equal(changedFilesBetween(git, 'a'.repeat(40)), null);
});

// --- pure: D4, closure paths the selectors do not map --------------------------------------------

test('BATTERY_UNMAPPED_CLOSURE is exactly the battery key closure MINUS what select-battery-tests.mjs bails on by itself', () => {
  // Pins the derivation instead of trusting a hand-written constant: a future widening of
  // keyedPaths() that adds a path neither the selector nor this list covers fails HERE, not
  // silently at a land.
  const selectorHandles = new Set([
    'scripts',
    ...EXTERNAL_TREE_PREFIXES.map((p) => p.replace(/\/$/, '')),
  ]);
  const remainder = keyedPaths().filter((p) => !selectorHandles.has(p));
  assert.deepEqual(remainder, [...BATTERY_UNMAPPED_CLOSURE]);
});

test('PYTEST_CLOSURE is read off the gate registry, never re-typed', () => {
  assert.deepEqual([...PYTEST_CLOSURE], [...GATES['pytest-backend-scripts'].paths]);
});

test('runPytestSelector: a null script (the core default) degrades to "run everything" without spawning', () => {
  let spawned = false;
  const result = runPytestSelector(['backend/scripts/a.py'], {
    _spawn: () => {
      spawned = true;
      return { status: 0, stdout: 'SUBSET 0 test files\n' };
    },
  });
  assert.equal(result, null);
  assert.equal(spawned, false, 'a config-less repo must never spawn a selector it was not given');
});

test('unmappedClosurePaths: a pytest closure path the selector does not map forces a full run', () => {
  // `backend/src/data` is in the pytest gate's key closure (it holds the sharded seed the suite
  // reads through _seed_io) but nothing under it is on _select_tests.py's stdin. Spelled with a
  // NON-seed path on purpose: assert-seed-io-seam reads a quoted path into the sharded seed tree
  // as a direct open, and this is a delta-list string, not a file this test ever touches.
  const delta = ['backend/scripts/a.py', 'backend/src/data/record-index.json'];
  assert.deepEqual(unmappedClosurePaths(delta, PYTEST_CLOSURE, VETAPP_PYTEST_SELECTOR.prefix), [
    'backend/src/data/record-index.json',
  ]);
});

test('unmappedClosurePaths: shared/src is unmapped for pytest — the land tier is deliberately stricter than the push tier', () => {
  // The hook pre-greps its changed list to ^backend/scripts/, so at the push tier a shared/src
  // change is scoped on the backend/scripts half alone. The land tier must not be MORE trusting.
  assert.deepEqual(
    unmappedClosurePaths(['shared/src/schemas.ts'], PYTEST_CLOSURE, VETAPP_PYTEST_SELECTOR.prefix),
    ['shared/src/schemas.ts'],
  );
});

test('unmappedClosurePaths: a pure backend/scripts delta is fully mapped, and paths outside the closure entirely are irrelevant', () => {
  const delta = ['backend/scripts/a.py', 'backend/scripts/test_a.py', 'frontend/src/app/page.tsx'];
  assert.deepEqual(unmappedClosurePaths(delta, PYTEST_CLOSURE, VETAPP_PYTEST_SELECTOR.prefix), []);
});

test('unmappedClosurePaths: a null mappedPrefix (no config) cannot scope anything — every in-closure delta path forces a full run', () => {
  const delta = ['backend/scripts/a.py'];
  assert.deepEqual(unmappedClosurePaths(delta, PYTEST_CLOSURE, null), delta);
});

test('unmappedClosurePaths: pnpm-lock.yaml is the battery half of the same rule', () => {
  assert.deepEqual(unmappedClosurePaths(['scripts/a.mjs'], BATTERY_UNMAPPED_CLOSURE, ''), []);
  assert.deepEqual(
    unmappedClosurePaths(['scripts/a.mjs', 'pnpm-lock.yaml'], BATTERY_UNMAPPED_CLOSURE, ''),
    ['pnpm-lock.yaml'],
  );
});

// --- pure: the pytest selector's output contract -------------------------------------------------

test('parsePytestSelectorOutput: SUBSET yields the named test files', () => {
  const out = 'SUBSET 2 test files\nbackend/scripts/test_a.py\nbackend/scripts/test_b.py\n';
  assert.deepEqual([...parsePytestSelectorOutput(out)].sort(), [
    'backend/scripts/test_a.py',
    'backend/scripts/test_b.py',
  ]);
});

test('parsePytestSelectorOutput: FULL — and anything unrecognised — is null, never an optimistic empty subset', () => {
  assert.equal(parsePytestSelectorOutput('FULL conftest changed (conftest.py)\n'), null);
  assert.equal(parsePytestSelectorOutput(''), null);
  assert.equal(parsePytestSelectorOutput('Traceback (most recent call last):\n'), null);
  assert.equal(parsePytestSelectorOutput(undefined), null);
});

// --- pure: the carry arithmetic ------------------------------------------------------------------

test('computeCarriedGreen: carries exactly selection INTERSECT baseline MINUS affected', () => {
  const carried = computeCarriedGreen({
    selection: ['scripts/a.test.mjs', 'scripts/b.test.mjs', 'scripts/brand-new.test.mjs'],
    baselineGreen: new Set(['scripts/a.test.mjs', 'scripts/b.test.mjs', 'scripts/gone.test.mjs']),
    affected: new Set(['scripts/a.test.mjs']),
  });
  // a: affected. brand-new: never proven. gone: not in the current selection.
  assert.deepEqual([...carried], ['scripts/b.test.mjs']);
});

test('computeCarriedGreen: a selector that could not scope (null) carries NOTHING', () => {
  assert.equal(
    computeCarriedGreen({
      selection: ['scripts/a.test.mjs'],
      baselineGreen: new Set(['scripts/a.test.mjs']),
      affected: null,
    }),
    null,
  );
});

test("computeCarriedGreen: an empty selection means the baseline's own green set (the pytest caller's shape)", () => {
  const carried = computeCarriedGreen({
    selection: [],
    baselineGreen: new Set(['backend/scripts/test_a.py', 'backend/scripts/test_b.py']),
    affected: new Set(['backend/scripts/test_a.py']),
  });
  assert.deepEqual([...carried], ['backend/scripts/test_b.py']);
});

test('computeCarriedGreen: when the delta reaches everything the baseline proved, nothing is carried', () => {
  assert.equal(
    computeCarriedGreen({
      selection: ['scripts/a.test.mjs'],
      baselineGreen: new Set(['scripts/a.test.mjs']),
      affected: new Set(['scripts/a.test.mjs']),
    }),
    null,
  );
});

// --- planCarryForward: every refusal route names itself -------------------------------------------

const CF_OID_A = 'a'.repeat(40);

function planWith(overrides = {}) {
  return planCarryForward({
    key: '9'.repeat(32),
    selection: ['scripts/a.test.mjs', 'scripts/b.test.mjs'],
    git: () => 'scripts/a.mjs\n',
    nowMs: at(0),
    closure: BATTERY_UNMAPPED_CLOSURE,
    mappedPrefix: '',
    selector: () => new Set(['scripts/a.test.mjs']),
    ...overrides,
  });
}

test('planCarryForward: the happy path carries the untouched half of the baseline', () => {
  const dir = fixtureDir('plan-cf-happy-');
  try {
    seedEntry(dir, '1'.repeat(32), {
      iso: new Date(at(0)).toISOString(),
      green: ['scripts/a.test.mjs', 'scripts/b.test.mjs'],
      head: CF_OID_A,
    });
    const r = planWith({ ledgerDir: dir });
    assert.deepEqual([...r.carried], ['scripts/b.test.mjs']);
    assert.equal(r.baselineKey, '1'.repeat(32));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planCarryForward: every doubt route carries nothing and says which one it was', () => {
  const dir = fixtureDir('plan-cf-refusals-');
  try {
    // No baseline at all.
    assert.equal(planWith({ ledgerDir: dir }).reason, 'no-live-baseline');
    seedEntry(dir, '1'.repeat(32), {
      iso: new Date(at(0)).toISOString(),
      green: ['scripts/a.test.mjs', 'scripts/b.test.mjs'],
      head: CF_OID_A,
    });
    // git cannot derive the delta.
    assert.equal(
      planWith({
        ledgerDir: dir,
        git: () => {
          throw new Error('bad object');
        },
      }).reason,
      'delta-underivable',
    );
    // A closure path the selector does not map.
    assert.match(
      planWith({ ledgerDir: dir, git: () => 'scripts/a.mjs\npnpm-lock.yaml\n' }).reason,
      /^closure-path-outside-selector-mapping:pnpm-lock\.yaml$/,
    );
    // The selector itself says "run everything".
    assert.equal(planWith({ ledgerDir: dir, selector: () => null }).reason, 'selector-says-full');
    // The delta reaches every file the baseline proved.
    assert.equal(
      planWith({
        ledgerDir: dir,
        selector: () => new Set(['scripts/a.test.mjs', 'scripts/b.test.mjs']),
      }).reason,
      'nothing-to-carry',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- END-TO-END against the REAL selectors and a REAL git repo -------------------------------------
//
// The plan's own headline acceptance criteria, exercised through the CLI with nothing stubbed: the
// real `git diff`, the real selector, the real ledger store.

function cfGitInit(dir) {
  const g = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: childEnv() }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  g('config', 'commit.gpgsign', 'false');
  return g;
}

test('END-TO-END battery: one changed scripts/*.mjs carries every test the real selector does not name (plan 3225 acceptance)', () => {
  const dir = fixtureDir('cf-e2e-battery-');
  try {
    const g = cfGitInit(dir);
    mkdirSync(join(dir, 'scripts'));
    // 6 test files so the fixture is a realistic shape rather than a degenerate one.
    writeFileSync(join(dir, 'scripts', 'alpha.mjs'), 'export const x = 1;\n');
    for (const n of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'])
      writePassFile(join(dir, 'scripts'), `${n}.test.mjs`);
    g('add', '-A');
    g('commit', '-qm', 'c0');
    const c0 = g('rev-parse', 'HEAD');

    const ledgerDir = join(dir, '.scratch', 'gate-ledgers');
    const selection = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map(
      (n) => `scripts/${n}.test.mjs`,
    );
    seedEntry(ledgerDir, '1'.repeat(32), {
      iso: new Date().toISOString(),
      green: selection,
      head: c0,
    });

    // The delta: ONE scripts/*.mjs module. select-battery-tests' name-pairing rule maps it to
    // scripts/alpha.test.mjs, and nothing else in this fixture references it.
    writeFileSync(join(dir, 'scripts', 'alpha.mjs'), 'export const x = 2;\n');
    g('add', '-A');
    g('commit', '-qm', 'c1');

    const newKey = '2'.repeat(32);
    const r = spawnSync(process.execPath, [CLI, 'carry-forward', '--key', newKey], {
      cwd: dir,
      input: `${selection.join('\n')}\n`,
      encoding: 'utf8',
      env: childEnv(),
    });
    assert.equal(r.status, 0, r.stderr);
    const entry = JSON.parse(readFileSync(join(ledgerDir, `${newKey}.json`), 'utf8'));
    assert.deepEqual(
      entry.green,
      selection.filter((f) => f !== 'scripts/alpha.test.mjs').sort(),
      `the paired test must be the ONLY one left to run; stderr:\n${r.stderr}`,
    );
    // And the carried entry is NOT itself delta-eligible — an inferred green must never become a
    // baseline without a run at that commit (plan 3225 decision D3).
    assert.equal(entry.head, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('END-TO-END battery: a delta the real selector cannot scope (an external-tree path) carries nothing (plan 3225 acceptance)', () => {
  const dir = fixtureDir('cf-e2e-battery-full-');
  try {
    const g = cfGitInit(dir);
    mkdirSync(join(dir, 'scripts'));
    // plan 3958: `.claude/` (not `backend/`) — a DEFAULT_EXTERNAL_TREE_PREFIXES entry every
    // checkout carries (generic core convention), unlike `backend/` which is only an
    // EXTERNAL_TREE_PREFIXES member via vetapp's own coord.config.json `externalTreePrefixes`
    // addition and so is empty in the kit's own config. A shipped core test must trigger the
    // bail through the prefix every repo has, not one only vetapp's config adds.
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'alpha.mjs'), 'export const x = 1;\n');
    for (const n of ['alpha', 'beta', 'gamma'])
      writePassFile(join(dir, 'scripts'), `${n}.test.mjs`);
    writeFileSync(join(dir, '.claude', 'thing.json'), '{"y":1}\n');
    g('add', '-A');
    g('commit', '-qm', 'c0');
    const c0 = g('rev-parse', 'HEAD');
    const selection = ['alpha', 'beta', 'gamma'].map((n) => `scripts/${n}.test.mjs`);
    const ledgerDir = join(dir, '.scratch', 'gate-ledgers');
    seedEntry(ledgerDir, '1'.repeat(32), {
      iso: new Date().toISOString(),
      green: selection,
      head: c0,
    });
    // `.claude/` is a DEFAULT_EXTERNAL_TREE_PREFIXES entry: battery tests read it from the real
    // tree, so the selector's own touchesExternalTree bail fires and there is nothing sound to
    // scope.
    writeFileSync(join(dir, '.claude', 'thing.json'), '{"y":2}\n');
    writeFileSync(join(dir, 'scripts', 'alpha.mjs'), 'export const x = 2;\n');
    g('add', '-A');
    g('commit', '-qm', 'c1');
    const newKey = '2'.repeat(32);
    const r = spawnSync(process.execPath, [CLI, 'carry-forward', '--key', newKey], {
      cwd: dir,
      input: `${selection.join('\n')}\n`,
      encoding: 'utf8',
      env: childEnv(),
    });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /no carry-forward \(selector-says-full\)/);
    assert.equal(existsSync(join(ledgerDir, `${newKey}.json`)), false, 'nothing may be seeded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 3958: the two "END-TO-END pytest" acceptance tests that used to live here (one changed
// backend/scripts module; a backend/src/data seed change) required a REAL copy of vetapp's
// backend/scripts/_select_tests.py content (a substantial, product-specific Python module never
// shipped by the kit — `backend/` is excluded from every coord-kit build). They stay vetapp
// product coverage (run via the vetapp checkout's own full test suite), not core-portable
// coverage — the "END-TO-END battery" test just above already exercises the SAME
// unmappedClosurePaths/carry-forward machinery with a synthetic, in-repo selector fixture.

test('carry-forward CLI: a malformed key does nothing and still exits 0 (an optimization never blocks a land)', () => {
  const r = spawnSync(process.execPath, [CLI, 'carry-forward', '--key', 'nope'], {
    cwd: import.meta.dirname,
    input: 'scripts/a.test.mjs\n',
    encoding: 'utf8',
    env: childEnv(),
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /needs --key/);
});

// --- plan 3318: CHUNK CONVERGENCE — the `start` event, stall bookkeeping, stalled-last order ----
//
// The defect these pin: the ledger's unit is the FILE, so an attempt killed mid-file records
// nothing for that file. A file whose own wall exceeds the chunk wall therefore re-enters at the
// same position every chunk, burns the whole budget, and the green set never advances — measured
// three times independently on three unrelated diffs, frozen at 152-153 of 925 files across four
// consecutive chunks each time.

test('parsePytestLedgerEvents: `start` lines are collected into `started`, and never affect green', () => {
  const text =
    JSON.stringify({ type: 'collect', file: 'backend/scripts/a.py', count: 1 }) +
    '\n' +
    JSON.stringify({ type: 'start', file: 'backend/scripts/a.py' }) +
    '\n' +
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'passed',
      terminal: true,
    }) +
    '\n';
  const parsed = parsePytestLedgerEvents(text);
  assert.deepEqual([...parsed.started], ['backend/scripts/a.py']);
  assert.deepEqual([...greenPytestFiles(parsed)], ['backend/scripts/a.py']);
});

test('parsePytestLedgerEvents: an events file with NO start lines (a pre-3318 plugin) parses exactly as before', () => {
  const text =
    JSON.stringify({ type: 'collect', file: 'backend/scripts/a.py', count: 1 }) +
    '\n' +
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/a.py',
      outcome: 'passed',
      terminal: true,
    }) +
    '\n';
  const parsed = parsePytestLedgerEvents(text);
  assert.deepEqual([...parsed.started], []);
  assert.deepEqual([...greenPytestFiles(parsed)], ['backend/scripts/a.py']);
  assert.deepEqual([...stalledPytestFiles(parsed)], []);
});

test('stalledPytestFiles: the file started with ZERO terminal reports is the in-flight one at kill time', () => {
  // The measured shape: `fast.py` finished, `heavy.py` was still running when the cap killed the
  // run — and `heavy.py` has no `collect`-vs-`report` shortfall to detect it by, because a file
  // killed before its first test reports produces no report line at all.
  const text =
    JSON.stringify({ type: 'collect', file: 'backend/scripts/fast.py', count: 1 }) +
    '\n' +
    JSON.stringify({ type: 'collect', file: 'backend/scripts/heavy.py', count: 1 }) +
    '\n' +
    JSON.stringify({ type: 'start', file: 'backend/scripts/fast.py' }) +
    '\n' +
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/fast.py',
      outcome: 'passed',
      terminal: true,
    }) +
    '\n' +
    JSON.stringify({ type: 'start', file: 'backend/scripts/heavy.py' }) +
    '\n';
  const parsed = parsePytestLedgerEvents(text);
  assert.deepEqual([...stalledPytestFiles(parsed)], ['backend/scripts/heavy.py']);
  assert.deepEqual([...greenPytestFiles(parsed)], ['backend/scripts/fast.py']);
});

test('stalledPytestFiles: a cleanly-finished run stalls nothing, even for a RED file', () => {
  const text =
    JSON.stringify({ type: 'collect', file: 'backend/scripts/red.py', count: 1 }) +
    '\n' +
    JSON.stringify({ type: 'start', file: 'backend/scripts/red.py' }) +
    '\n' +
    JSON.stringify({
      type: 'report',
      file: 'backend/scripts/red.py',
      outcome: 'failed',
      terminal: true,
    }) +
    '\n';
  const parsed = parsePytestLedgerEvents(text);
  // A red file must NOT be deprioritized — it reported, so it is not in flight. Deprioritizing it
  // would push a genuine failure out of the chunk and report CHUNKED where the truth is FAILED.
  assert.deepEqual([...stalledPytestFiles(parsed)], []);
});

test('stalledPytestFiles: a `start` line lost to truncation only costs a stall record, never a false green', () => {
  const complete =
    JSON.stringify({ type: 'collect', file: 'backend/scripts/heavy.py', count: 1 }) + '\n';
  const truncated = '{"type":"start","file":"backend/scr';
  const parsed = parsePytestLedgerEvents(complete + truncated);
  assert.deepEqual([...parsed.started], []);
  assert.deepEqual([...stalledPytestFiles(parsed)], []);
  assert.deepEqual([...greenPytestFiles(parsed)], []); // still not green — collected 1, reported 0
});

// --- fs: stall persistence -------------------------------------------------------------------

test('mergeStalledFiles + readStallCounts: a stall is recorded and INCREMENTS across attempts', () => {
  const dir = freshLedgerDir();
  mergeStalledFiles(dir, KEY_A, new Set(['backend/scripts/heavy.py']), at(0));
  assert.deepEqual(readStallCounts(dir, KEY_A, at(1)), { 'backend/scripts/heavy.py': 1 });
  mergeStalledFiles(dir, KEY_A, new Set(['backend/scripts/heavy.py']), at(1));
  assert.deepEqual(readStallCounts(dir, KEY_A, at(2)), { 'backend/scripts/heavy.py': 2 });
});

test('mergeStalledFiles: an empty stall set writes nothing at all', () => {
  const dir = freshLedgerDir();
  mergeStalledFiles(dir, KEY_A, new Set(), at(0));
  assert.deepEqual(readStallCounts(dir, KEY_A, at(1)), {});
  assert.deepEqual([...readGreenSet(dir, KEY_A, at(1))], []);
});

test('mergeStalledFiles: recording a stall NEVER extends the green set or its TTL', () => {
  // The hazard mergeGreenFiles' own no-op-on-empty rule names: a stall proves nothing green, so
  // bumping `iso` would extend the life of greens this attempt never re-proved. Pinned by
  // reading the entry back at a moment past the ORIGINAL write's TTL — the stall write must not
  // have moved that horizon.
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  mergeStalledFiles(dir, KEY_A, new Set(['backend/scripts/heavy.py']), at(DEFAULT_TTL_MIN - 1));
  assert.deepEqual(
    [...readGreenSet(dir, KEY_A, at(DEFAULT_TTL_MIN - 1))],
    ['backend/scripts/a.py'],
  );
  assert.deepEqual([...readGreenSet(dir, KEY_A, at(DEFAULT_TTL_MIN + 1))], [], 'TTL was extended');
});

test('mergeGreenFiles: a later green merge PRESERVES the stall counts a previous attempt recorded', () => {
  // writeCacheEntry replaces the whole record, so without an explicit carry the very next green
  // merge would erase the ordering data — and with it the convergence this plan is about.
  const dir = freshLedgerDir();
  mergeStalledFiles(dir, KEY_A, new Set(['backend/scripts/heavy.py']), at(0));
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(1));
  assert.deepEqual(readStallCounts(dir, KEY_A, at(2)), { 'backend/scripts/heavy.py': 1 });
  assert.deepEqual([...readGreenSet(dir, KEY_A, at(2))], ['backend/scripts/a.py']);
});

// --- plan 3374: fs: consecutive zero-progress round persistence ---------------------------------

test('plan 3374: recordChunkRound + readZeroRounds — consecutive zero-progress rounds ACCUMULATE, and reaching NON_CONVERGENT_ROUNDS is what the seam keys off', () => {
  const dir = freshLedgerDir();
  // A live entry is the precondition: a round can only have "made no progress" against a green set
  // that exists. Seed one, exactly as a first chunk round's own merge would.
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  assert.equal(readZeroRounds(dir, KEY_A, at(1)), 0, 'nothing counted before any round is scored');
  assert.equal(recordChunkRound(dir, KEY_A, false, at(1)), 1, 'first zero-progress round');
  assert.equal(recordChunkRound(dir, KEY_A, false, at(2)), 2, 'second — the threshold');
  assert.equal(readZeroRounds(dir, KEY_A, at(3)), 2);
  assert.ok(
    2 >= NON_CONVERGENT_ROUNDS,
    'the threshold this test drives to is the one the seam actually uses',
  );
});

test('plan 3374: a round that PROVED something clears the count — the counter is CONSECUTIVE, not cumulative', () => {
  // Decision D1: a single zero round is not proof of non-convergence (several healthy shapes
  // produce one). Only an unbroken run of them is, so any progress at all resets the tally.
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  assert.equal(recordChunkRound(dir, KEY_A, false, at(1)), 1);
  assert.equal(recordChunkRound(dir, KEY_A, true, at(2)), 0, 'progress clears it');
  assert.equal(recordChunkRound(dir, KEY_A, false, at(3)), 1, 'and the next zero starts over at 1');
});

test('plan 3374: a cleared count is ABSENT from the record, not a stored 0 — cleared and never-counted are the same state on disk', () => {
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  recordChunkRound(dir, KEY_A, false, at(1));
  recordChunkRound(dir, KEY_A, true, at(2));
  const raw = JSON.parse(readFileSync(join(dir, `${KEY_A}.json`), 'utf8'));
  assert.ok(!('zeroRounds' in raw), `cleared count must not persist a 0: ${JSON.stringify(raw)}`);
});

test('plan 3374: recording a zero-progress round NEVER extends the green set or its TTL', () => {
  // Same hazard mergeStalledFiles' own TTL rule names: a zero round proves nothing green, so
  // bumping `iso` would extend the life of greens the round never re-proved.
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  recordChunkRound(dir, KEY_A, false, at(DEFAULT_TTL_MIN - 1));
  assert.deepEqual(
    [...readGreenSet(dir, KEY_A, at(DEFAULT_TTL_MIN - 1))],
    ['backend/scripts/a.py'],
  );
  assert.deepEqual([...readGreenSet(dir, KEY_A, at(DEFAULT_TTL_MIN + 1))], [], 'TTL was extended');
});

test('plan 3374: a green merge PRESERVES the zero-round count — the carry that lets the threshold ever be reached', () => {
  // The exact twin of the stall-carry test above, and the same defect class: writeCacheEntry
  // replaces the whole record, so without the explicit carry a merge landing between two zero
  // rounds would silently reset the tally and the seam could never fire.
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  recordChunkRound(dir, KEY_A, false, at(1));
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/b.py']), at(2));
  assert.equal(readZeroRounds(dir, KEY_A, at(3)), 1, 'the green merge erased the count');
});

test('plan 3374: a stall write PRESERVES the zero-round count too (mergeStalledFiles carries it)', () => {
  // The over-wall file that drives non-convergence records a stall on the SAME rounds it proves
  // nothing — so if the stall write dropped the tally, the one shape this seam exists to catch
  // would be precisely the shape it could never reach.
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  recordChunkRound(dir, KEY_A, false, at(1));
  mergeStalledFiles(dir, KEY_A, new Set(['backend/scripts/heavy.py']), at(2));
  assert.equal(readZeroRounds(dir, KEY_A, at(3)), 1, 'the stall write erased the count');
  assert.deepEqual(readStallCounts(dir, KEY_A, at(3)), { 'backend/scripts/heavy.py': 1 });
});

test('plan 3374: readZeroRounds/recordChunkRound fail SAFE — absent, expired, and malformed all read 0 and fire no seam', () => {
  const dir = freshLedgerDir();
  assert.equal(readZeroRounds(dir, KEY_B, at(0)), 0, 'absent entry');
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  recordChunkRound(dir, KEY_A, false, at(1));
  assert.equal(readZeroRounds(dir, KEY_A, at(DEFAULT_TTL_MIN + 1)), 0, 'expired entry');
  // READING is where the fail-safe lives: absent/expired/malformed all answer 0, so no seam fires.
  // WRITING deliberately does not refuse — gpt-review 304375/2da600 (this plan's own review round)
  // overturned the first cut, which skipped a non-live entry and thereby made the purest
  // non-convergent case of all — a gate that has never proved anything under this key — the one
  // case the seam could never reach. The created record is safe precisely because it claims
  // NOTHING: an empty green set, and no `head`, so it can never become a carry-forward baseline.
  assert.equal(recordChunkRound(dir, KEY_B, false, at(0)), 1, 'a fresh key can hold a tally');
  assert.deepEqual([...readGreenSet(dir, KEY_B, at(1))], [], 'and it claims nothing green');
  const created = JSON.parse(readFileSync(join(dir, `${KEY_B}.json`), 'utf8'));
  assert.ok(!('head' in created), 'no head ⇒ never a carry-forward baseline');
});

test('plan 3374: a non-integer / non-positive zeroRounds on disk is dropped rather than trusted', () => {
  const dir = freshLedgerDir();
  mkdirSync(dir, { recursive: true });
  for (const bad of [0, -1, 2.5, '2', null, {}]) {
    writeFileSync(
      join(dir, `${KEY_A}.json`),
      JSON.stringify({ iso: new Date(at(0)).toISOString(), green: [], zeroRounds: bad }),
    );
    assert.equal(readZeroRounds(dir, KEY_A, at(1)), 0, `zeroRounds ${JSON.stringify(bad)}`);
  }
});

// --- plan 3620: push-side non-convergence bound, scored by BANKED-SET FINGERPRINT --------------
//
// The push hook is a NEW shell process per push, so — unlike the land side's scoreChunkRound,
// which is handed `roundGreen`/`greenBefore` by the single process that observed both ends of a
// round — nothing here can diff "this round's own contribution" directly. scoreChunkRoundByGreenMark
// instead compares consecutive SNAPSHOTS of the ledger's own persisted green set, fingerprinted
// deterministically. Every case below drives that comparison directly against a real ledger dir on
// disk, mirroring the plan-3374 fs-level tests immediately above rather than inventing a new style.

test('fingerprintGreenSet: order-independent — the SAME set, built in a different insertion order, fingerprints identically', () => {
  const a = new Set(['b.py', 'a.py', 'c.py']);
  const b = new Set(['c.py', 'a.py', 'b.py']);
  assert.equal(fingerprintGreenSet(a), fingerprintGreenSet(b));
});

test('fingerprintGreenSet: a set that differs by even one file fingerprints differently', () => {
  const a = new Set(['a.py', 'b.py']);
  const b = new Set(['a.py', 'b.py', 'c.py']);
  assert.notEqual(fingerprintGreenSet(a), fingerprintGreenSet(b));
});

test('fingerprintGreenSet: an EMPTY set is well-defined — never throws, and differs from a non-empty one', () => {
  const empty = fingerprintGreenSet(new Set());
  assert.match(empty, /^[0-9a-f]{64}$/);
  assert.notEqual(empty, fingerprintGreenSet(new Set(['a.py'])));
});

test('plan 3620: scoreChunkRoundByGreenMark — a round that banks a NEW file resets the counter to 0', () => {
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  const r1 = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(1),
    ranProven: true,
  });
  assert.equal(
    r1.progressed,
    true,
    'first-ever round with something banked has no history to stall against',
  );
  assert.equal(r1.rounds, 0);
  // Round 2: the SAME set, nothing new — a genuine zero-progress round.
  const r2 = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(2),
    ranProven: true,
  });
  assert.equal(r2.progressed, false);
  assert.equal(r2.rounds, 1);
  // Round 3: a NEW file banks — the counter resets to 0.
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/b.py']), at(3));
  const r3 = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(4),
    ranProven: true,
  });
  assert.equal(r3.progressed, true, 'a newly banked file must reset the counter');
  assert.equal(r3.rounds, 0);
});

test('plan 3620: scoreChunkRoundByGreenMark — two consecutive rounds with an IDENTICAL banked set reach nonConvergent at exactly NON_CONVERGENT_ROUNDS', () => {
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  const r1 = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(1),
    ranProven: true,
  }); // establishes the mark
  assert.equal(r1.nonConvergent, false);
  const r2 = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(2),
    ranProven: true,
  }); // 1st zero round
  assert.equal(r2.rounds, 1);
  assert.equal(r2.nonConvergent, false);
  const r3 = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(3),
    ranProven: true,
  }); // 2nd — the threshold
  assert.equal(r3.rounds, 2);
  assert.ok(
    2 >= NON_CONVERGENT_ROUNDS,
    'the threshold this test drives to is the one the seam actually uses',
  );
  assert.equal(r3.nonConvergent, true);
});

// --- plan 3620 fix round F1: `ranProven` gates everything -----------------------------------

test('plan 3620 fix round F1: ranProven false/absent NEVER reaches nonConvergent, and writes NOTHING to the ledger', () => {
  const dir = freshLedgerDir();
  // Set up a state that WOULD be the purest non-convergent case (empty green, no mark) if scored —
  // the exact shape case 2 above reads as `progressed: false`. Establish it via a real scored round
  // first so there is a genuine on-disk record to prove untouched.
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  scoreChunkRoundByGreenMark({ ledgerDir: dir, key: KEY_A, nowMs: at(1), ranProven: true });
  const entryPath = join(dir, `${KEY_A}.json`);
  const before = readFileSync(entryPath, 'utf8');
  for (const ranProven of [undefined, false, 0, 'true', 1]) {
    const r = scoreChunkRoundByGreenMark({ ledgerDir: dir, key: KEY_A, nowMs: at(2), ranProven });
    assert.equal(r.ranProven, false, `ranProven=${JSON.stringify(ranProven)} must be unscoreable`);
    assert.equal(r.rounds, 0);
    assert.equal(r.progressed, true);
    assert.equal(r.nonConvergent, false, 'an unscoreable round must never report nonConvergent');
    assert.equal(r.green, 1, 'green is still reported for information — the real current count');
    assert.equal(
      readFileSync(entryPath, 'utf8'),
      before,
      `ranProven=${JSON.stringify(ranProven)} must not write to the ledger at all`,
    );
  }
});

// --- plan 3620 fix round F4 (finding 3a9a30): malformed green/greenMark are unscoreable -----

test('plan 3620 fix round F4: a CORRUPT (non-array) green field never reads as the purest non-convergent case', () => {
  const dir = freshLedgerDir();
  mkdirSync(dir, { recursive: true });
  const entryPath = join(dir, `${KEY_A}.json`);
  // Present but WRONG TYPE — not the ordinary "never recorded" absent-field case cases 1/2 handle.
  // Without the F4 fix, readGreenSet's own fail-safe silently collapses this to an empty Set,
  // indistinguishable from a genuine empty green set, and case 2 would then score it
  // `progressed: false` — manufacturing a false non-convergent signal out of pure corruption.
  const raw = { iso: new Date(at(0)).toISOString(), green: 'not-an-array' };
  writeFileSync(entryPath, JSON.stringify(raw));
  const before = readFileSync(entryPath, 'utf8');
  const r = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(1),
    ranProven: true,
  });
  assert.equal(r.ranProven, false, 'a corrupt green field must be unscoreable');
  assert.equal(r.nonConvergent, false);
  assert.equal(r.rounds, 0);
  assert.equal(readFileSync(entryPath, 'utf8'), before, 'a corrupt entry must not be rewritten');
});

test('plan 3620 fix round F4: a CORRUPT (non-string) greenMark never reads as "no mark, first round"', () => {
  const dir = freshLedgerDir();
  mkdirSync(dir, { recursive: true });
  const entryPath = join(dir, `${KEY_A}.json`);
  // A well-formed, genuinely EMPTY green array — case 2's own legitimate shape — but a `greenMark`
  // that is present and the WRONG TYPE (a number, here) rather than absent. Without the F4 fix this
  // masks as "no mark recorded yet" (the undefined-coalescing `typeof … === 'string' ? … :
  // undefined` guard already in the ordinary path), which case 2 would then score
  // `progressed: false` on an entry whose corruption, not its history, is the real story.
  const raw = { iso: new Date(at(0)).toISOString(), green: [], greenMark: 12345 };
  writeFileSync(entryPath, JSON.stringify(raw));
  const before = readFileSync(entryPath, 'utf8');
  const r = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(1),
    ranProven: true,
  });
  assert.equal(r.ranProven, false, 'a corrupt greenMark field must be unscoreable');
  assert.equal(r.nonConvergent, false);
  assert.equal(r.rounds, 0);
  assert.equal(readFileSync(entryPath, 'utf8'), before, 'a corrupt entry must not be rewritten');
});

test('plan 3620 fix round F4: an ABSENT green/greenMark field is NOT malformed — the ordinary first-round cases still work', () => {
  // Sanity guard against an over-eager F4 check: a field that was simply never written yet (every
  // pre-3620 entry, and this module's own first-ever-round record) must still reach cases 1/2, not
  // get swept into "malformed" merely for being absent.
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  const raw = JSON.parse(readFileSync(join(dir, `${KEY_A}.json`), 'utf8'));
  assert.ok(
    !('greenMark' in raw),
    'sanity: a fresh mergeGreenFiles entry carries no greenMark yet',
  );
  const r = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(1),
    ranProven: true,
  });
  assert.equal(r.ranProven, true);
  assert.equal(r.progressed, true, 'case 1 (first round, non-empty green) must still fire');
});

// --- plan 3620 fix round G4 (findings 99f5d3/d75bef/8cd8fd/2758e7/65f5da/0d2b3c): malformed
// green ARRAY MEMBERS, not just a non-array `green`, must be unscoreable -----------------------

test('plan 3620 fix round G4: a green array carrying a non-string MEMBER is malformed — unscoreable, ledger byte-identical after', () => {
  const dir = freshLedgerDir();
  mkdirSync(dir, { recursive: true });
  const entryFile = join(dir, `${KEY_A}.json`);
  // Array.isArray(green) is true — the pre-G4 check alone would wave this through — but member
  // index 1 (a number, not a string) is exactly the corruption this fix closes: left unflagged,
  // it would reach fingerprintGreenSet unfiltered, and — worse — recordChunkRound's own write
  // (writeZeroRounds carries `green` through byte-for-byte) would REWRITE this corrupt array
  // right back to disk, perpetuating it.
  const raw = { iso: new Date(at(0)).toISOString(), green: ['scripts/a.test.mjs', 42] };
  writeFileSync(entryFile, JSON.stringify(raw));
  const before = readFileSync(entryFile, 'utf8');
  const r = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(1),
    ranProven: true,
  });
  assert.equal(r.ranProven, false, 'a non-string member must make the whole array malformed');
  assert.equal(r.nonConvergent, false);
  assert.equal(readFileSync(entryFile, 'utf8'), before, 'a malformed entry must not be rewritten');
});

test('plan 3620 fix round G4: a green array carrying an EMPTY-STRING member is malformed too', () => {
  const dir = freshLedgerDir();
  mkdirSync(dir, { recursive: true });
  const entryFile = join(dir, `${KEY_A}.json`);
  const raw = { iso: new Date(at(0)).toISOString(), green: ['scripts/a.test.mjs', ''] };
  writeFileSync(entryFile, JSON.stringify(raw));
  const before = readFileSync(entryFile, 'utf8');
  const r = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(1),
    ranProven: true,
  });
  assert.equal(r.ranProven, false);
  assert.equal(readFileSync(entryFile, 'utf8'), before);
});

test('plan 3620 fix round G4 (finding 0d2b3c): a stale/malformed entry cannot bypass the guard and then be REWRITTEN by a LATER call once conditions change', () => {
  const dir = freshLedgerDir();
  mkdirSync(dir, { recursive: true });
  const entryFile = join(dir, `${KEY_A}.json`);
  const raw = { iso: new Date(at(0)).toISOString(), green: ['scripts/a.test.mjs', null] };
  writeFileSync(entryFile, JSON.stringify(raw));
  const before = readFileSync(entryFile, 'utf8');
  // Two consecutive scoring attempts against the SAME malformed entry — neither may ever write.
  scoreChunkRoundByGreenMark({ ledgerDir: dir, key: KEY_A, nowMs: at(1), ranProven: true });
  scoreChunkRoundByGreenMark({ ledgerDir: dir, key: KEY_A, nowMs: at(2), ranProven: true });
  assert.equal(
    readFileSync(entryFile, 'utf8'),
    before,
    'a malformed entry must stay byte-identical across repeated scoring attempts, never rewritten',
  );
});

test('plan 3620 fix round G4: a well-formed green array — every member a non-empty string, INCLUDING the genuinely-empty array — is still scoreable (sanity control)', () => {
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['scripts/a.test.mjs', 'scripts/b.test.mjs']), at(0));
  const r = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(1),
    ranProven: true,
  });
  assert.equal(r.ranProven, true, 'a well-formed non-empty green array must remain scoreable');
});

// --- plan 3620 fix round G5 (finding eb0645): `greenMark` validated AS A FINGERPRINT ------------

test('plan 3620 fix round G5: a greenMark that is a STRING but not a 64-hex-char sha256 digest is malformed — unscoreable', () => {
  const dir = freshLedgerDir();
  mkdirSync(dir, { recursive: true });
  const entryFile = join(dir, `${KEY_A}.json`);
  const raw = { iso: new Date(at(0)).toISOString(), green: [], greenMark: 'not-a-fingerprint' };
  writeFileSync(entryFile, JSON.stringify(raw));
  const before = readFileSync(entryFile, 'utf8');
  const r = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(1),
    ranProven: true,
  });
  assert.equal(r.ranProven, false, 'a wrong-shaped greenMark string must be malformed');
  assert.equal(readFileSync(entryFile, 'utf8'), before);
});

test("plan 3620 fix round G5: a genuinely well-formed 64-hex-char greenMark (fingerprintGreenSet's own output shape) is accepted", () => {
  const dir = freshLedgerDir();
  // The first call writes a REAL mark via recordChunkRound (case 2: no prior mark, empty green).
  const r1 = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(1),
    ranProven: true,
  });
  assert.equal(r1.ranProven, true);
  const raw = JSON.parse(readFileSync(join(dir, `${KEY_A}.json`), 'utf8'));
  assert.match(raw.greenMark, /^[0-9a-f]{64}$/, 'sanity: the real mark is a 64-hex-char digest');
  const r2 = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(2),
    ranProven: true,
  });
  assert.equal(r2.ranProven, true, 'a genuinely well-formed greenMark must remain scoreable');
});

// --- plan 3620 fix round H3 (findings 07d2b1/f0bbd3): `.test()` COERCES a non-string argument to
// its string form first — a one-element ARRAY whose sole member is already a well-formed 64-hex
// string coerces to exactly that string (`String(['a'.repeat(64)]) === 'a'.repeat(64)`), so the
// bare regex check passed it through as though it were a real fingerprint. `typeof === 'string'`
// must gate the regex, not merely follow it in a comment claiming coercion already covers this.

test('plan 3620 fix round H3: a greenMark that is a ONE-ELEMENT ARRAY of 64 hex chars is REJECTED as malformed, never coerced into a valid fingerprint', () => {
  const dir = freshLedgerDir();
  mkdirSync(dir, { recursive: true });
  const entryFile = join(dir, `${KEY_A}.json`);
  const fakeMark = 'a'.repeat(64); // looks exactly like fingerprintGreenSet's own output shape
  const raw = {
    iso: new Date(at(0)).toISOString(),
    green: ['scripts/x.test.mjs'],
    greenMark: [fakeMark], // MALFORMED SHAPE: an array, not a string — the H3 regression
  };
  writeFileSync(entryFile, JSON.stringify(raw));
  const before = readFileSync(entryFile, 'utf8');
  const r = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(1),
    ranProven: true,
  });
  assert.equal(
    r.ranProven,
    false,
    `an array greenMark must never be coerced into a valid fingerprint; got: ${JSON.stringify(r)}`,
  );
  assert.equal(r.nonConvergent, false);
  assert.equal(r.rounds, 0);
  assert.equal(
    readFileSync(entryFile, 'utf8'),
    before,
    'an unscoreable (corrupt) round must never rewrite the malformed record',
  );
});

// --- plan 3620 fix round G6 (finding 7ccf82): a raw ledger READ FAILURE is distinct from ---------
// "no entry has ever been written", and must be unscoreable rather than scored as a live empty
// record. Pinned two ways: DIRECTLY against readLedgerEntryDiagnostic (isolates the diagnostic's
// own logic from scoreChunkRoundByGreenMark's outer try/catch, which can independently mask some
// error shapes at the WRITE step — see that function's own header) and via a full round-trip that
// demonstrates the actual DATA-LOSS this closes.

test('readLedgerEntryDiagnostic: genuine ABSENCE (ENOENT) is NOT a read failure', () => {
  const dir = freshLedgerDir();
  const { entry, readFailed } = readLedgerEntryDiagnostic(dir, KEY_A);
  assert.equal(entry, null);
  assert.equal(readFailed, false);
});

test('readLedgerEntryDiagnostic: a directory at the entry path (EISDIR) IS a read failure', () => {
  const dir = freshLedgerDir();
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, `${KEY_A}.json`));
  const { entry, readFailed } = readLedgerEntryDiagnostic(dir, KEY_A);
  assert.equal(entry, null);
  assert.equal(readFailed, true);
});

test('readLedgerEntryDiagnostic: corrupt JSON content IS a read failure, not merely "no entry"', () => {
  const dir = freshLedgerDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${KEY_A}.json`), 'not { valid json');
  const { entry, readFailed } = readLedgerEntryDiagnostic(dir, KEY_A);
  assert.equal(entry, null);
  assert.equal(readFailed, true);
});

test('readLedgerEntryDiagnostic: a well-formed entry reads through with readFailed=false', () => {
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['scripts/a.test.mjs']), at(0));
  const { entry, readFailed } = readLedgerEntryDiagnostic(dir, KEY_A);
  assert.equal(readFailed, false);
  assert.deepEqual(entry.green, ['scripts/a.test.mjs']);
});

test('plan 3620 fix round G6: a raw read failure via scoreChunkRoundByGreenMark is unscoreable and NEVER overwrites the real record it could not read — the data-loss scenario this closes', () => {
  const dir = freshLedgerDir();
  // Establish a REAL, live record with real content: a genuine prior round's green set + mark.
  const r0 = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(0),
    ranProven: true,
  });
  assert.equal(r0.ranProven, true); // sanity: this really did write a live record
  const entryFile = join(dir, `${KEY_A}.json`);
  const liveRecord = readFileSync(entryFile, 'utf8');
  assert.match(JSON.parse(liveRecord).greenMark, /^[0-9a-f]{64}$/, 'sanity: a real mark is banked');
  // Now simulate a TORN write on a LATER attempt — the file exists but its content no longer
  // parses (a mid-write crash, unrelated to this round). This is a genuine read FAILURE, distinct
  // from the file never having existed. Without the G6 fix, parseEntry's own null collapse makes
  // this indistinguishable from "no entry yet" — case 2 fires, scoring `progressed: false` AND
  // WRITING a fresh record (empty green, a brand-new mark) that OVERWRITES the real one above,
  // permanently losing the banked green set and fingerprint history to one bad read.
  writeFileSync(entryFile, liveRecord.slice(0, 20)); // truncated — no longer valid JSON
  const corrupted = readFileSync(entryFile, 'utf8');
  const r1 = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(1),
    ranProven: true,
  });
  assert.equal(r1.ranProven, false, 'a read failure on a torn write must be unscoreable');
  assert.equal(r1.nonConvergent, false);
  assert.equal(r1.rounds, 0);
  assert.equal(
    readFileSync(entryFile, 'utf8'),
    corrupted,
    'the torn record must be left exactly as found — never "healed" into a fresh, data-losing record',
  );
});

test('plan 3620 fix round G6: genuine ABSENCE (no entry at all — ENOENT) is NOT a read failure — the ordinary first-round case still fires', () => {
  // Sanity control against an over-eager G6 check: a key that has simply never been written
  // (every fresh ledger dir) must still reach cases 1/2, not get swept into "read failed".
  const dir = freshLedgerDir();
  const r = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(1),
    ranProven: true,
  });
  assert.equal(r.ranProven, true, 'genuine absence must not be misread as a read failure');
  assert.equal(r.progressed, false, 'case 2: first round, empty green — the ordinary answer');
  assert.equal(r.rounds, 1);
});

test('plan 3620: scoreChunkRoundByGreenMark — the FIRST round ever scored under a key, with an EMPTY green set, already counts as a zero-progress round', () => {
  // The purest non-convergent case of all: a gate that has never proven anything under this key.
  // No mergeGreenFiles call at all — writeZeroRounds' own header is why CREATING a fresh record
  // here (rather than skipping for "no baseline") is what makes this case reachable.
  const dir = freshLedgerDir();
  const r = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(0),
    ranProven: true,
  });
  assert.equal(r.progressed, false);
  assert.equal(r.rounds, 1);
  assert.equal(r.green, 0);
});

test("plan 3620: a DIFFERENT key (a new commit) starts from 0 — it never inherits another key's tally", () => {
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  scoreChunkRoundByGreenMark({ ledgerDir: dir, key: KEY_A, nowMs: at(1), ranProven: true });
  const kaRound2 = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(2),
    ranProven: true,
  });
  assert.equal(kaRound2.rounds, 1, 'sanity: KEY_A is mid-tally');
  // A NEW content key — even under the SAME ledger dir — has never been scored before.
  mergeGreenFiles(dir, KEY_B, new Set(['backend/scripts/b.py']), at(3));
  const rB = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_B,
    nowMs: at(4),
    ranProven: true,
  });
  assert.equal(rB.progressed, true, 'a fresh key has no history to compare against');
  assert.equal(rB.rounds, 0);
});

test('plan 3620: scoring a zero-progress round via scoreChunkRoundByGreenMark NEVER extends the ledger TTL', () => {
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  scoreChunkRoundByGreenMark({ ledgerDir: dir, key: KEY_A, nowMs: at(1), ranProven: true });
  scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(DEFAULT_TTL_MIN - 1),
    ranProven: true,
  }); // still live, zero-progress
  assert.deepEqual(
    [...readGreenSet(dir, KEY_A, at(DEFAULT_TTL_MIN - 1))],
    ['backend/scripts/a.py'],
  );
  assert.deepEqual(
    [...readGreenSet(dir, KEY_A, at(DEFAULT_TTL_MIN + 1))],
    [],
    'a zero-progress chunk-round score must not have extended the TTL',
  );
});

test('plan 3620: greenMark SURVIVES an intervening mergeGreenFiles write — the carry this bound depends on', () => {
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  scoreChunkRoundByGreenMark({ ledgerDir: dir, key: KEY_A, nowMs: at(1), ranProven: true }); // marks fingerprint({a.py})
  // The realistic shape: another attempt re-proves the SAME file (mergeGreenFiles' own no-op-on-
  // empty rule means an attempt that adds nothing new never even reaches this write) — the write
  // still replaces the whole record, so this is exactly the hazard the carry exists to close.
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(2));
  const raw = JSON.parse(readFileSync(join(dir, `${KEY_A}.json`), 'utf8'));
  assert.ok(
    'greenMark' in raw,
    `mergeGreenFiles must carry greenMark through: ${JSON.stringify(raw)}`,
  );
  const r = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(3),
    ranProven: true,
  });
  assert.equal(
    r.progressed,
    false,
    'the mark must have survived the intervening merge, or this reads as a fresh first round',
  );
  assert.equal(r.rounds, 1);
});

test('plan 3620: greenMark SURVIVES a mergeStalledFiles write too', () => {
  const dir = freshLedgerDir();
  mergeGreenFiles(dir, KEY_A, new Set(['backend/scripts/a.py']), at(0));
  scoreChunkRoundByGreenMark({ ledgerDir: dir, key: KEY_A, nowMs: at(1), ranProven: true });
  mergeStalledFiles(dir, KEY_A, new Set(['backend/scripts/heavy.py']), at(2));
  const raw = JSON.parse(readFileSync(join(dir, `${KEY_A}.json`), 'utf8'));
  assert.ok(
    'greenMark' in raw,
    `mergeStalledFiles must carry greenMark through: ${JSON.stringify(raw)}`,
  );
  const r = scoreChunkRoundByGreenMark({
    ledgerDir: dir,
    key: KEY_A,
    nowMs: at(3),
    ranProven: true,
  });
  assert.equal(r.progressed, false, 'the mark must have survived the intervening stall write');
});

test('plan 3620: scoreChunkRoundByGreenMark is fail-safe — an fs error persisting the record degrades to the ordinary CHUNKED answer, never throws', () => {
  // A file sitting where the ledger DIRECTORY needs to be makes the internal write's own
  // mkdirSync(dir, {recursive:true}) throw — the one path this function's try/catch exists for
  // (every read primitive it calls already fails safe on its own, without throwing).
  const parent = mkdtempSync(join(tmpdir(), 'battery-ledger-fail-'));
  const blocker = join(parent, 'gate-ledgers');
  writeFileSync(blocker, 'not a directory');
  const r = scoreChunkRoundByGreenMark({
    ledgerDir: blocker,
    key: KEY_A,
    nowMs: at(0),
    ranProven: true,
  });
  assert.deepEqual(r, {
    rounds: 0,
    progressed: true,
    nonConvergent: false,
    ranProven: false,
    green: 0,
  });
});

test('readStallCounts: an expired or malformed entry reads as {} (no ordering change), never throws', () => {
  const dir = freshLedgerDir();
  mergeStalledFiles(dir, KEY_A, new Set(['backend/scripts/heavy.py']), at(0));
  assert.deepEqual(readStallCounts(dir, KEY_A, at(DEFAULT_TTL_MIN + 1)), {});
  assert.deepEqual(readStallCounts(dir, KEY_B, at(0)), {});
});

test('readStallCounts: non-integer / non-positive counts are dropped rather than trusted', () => {
  const dir = freshLedgerDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${KEY_A}.json`),
    JSON.stringify({
      iso: ISO,
      green: [],
      stalls: { 'ok.py': 2, 'zero.py': 0, 'neg.py': -1, 'frac.py': 1.5, 'str.py': 'x' },
    }),
  );
  assert.deepEqual(readStallCounts(dir, KEY_A, at(1)), { 'ok.py': 2 });
});

// --- pure: the ordering itself ----------------------------------------------------------------

test('orderStalledLast: stalled files move to the END, un-stalled keep their selection order', () => {
  const remainder = ['a.py', 'heavy.py', 'b.py'];
  assert.deepEqual(orderStalledLast(remainder, { 'heavy.py': 1 }), ['a.py', 'b.py', 'heavy.py']);
});

test('orderStalledLast: among stalled files the LEAST-stalled goes first, ties broken by path', () => {
  const remainder = ['x.py', 'y.py', 'z.py'];
  assert.deepEqual(orderStalledLast(remainder, { 'x.py': 3, 'y.py': 1, 'z.py': 1 }), [
    'y.py',
    'z.py',
    'x.py',
  ]);
});

test('orderStalledLast: with no stalls (or none passed) the remainder is returned unchanged', () => {
  const remainder = ['a.py', 'b.py'];
  assert.deepEqual(orderStalledLast(remainder, {}), remainder);
  assert.deepEqual(orderStalledLast(remainder, undefined), remainder);
});

test('orderStalledLast: never adds or drops a file — it is a permutation of its input', () => {
  const remainder = ['a.py', 'heavy.py', 'b.py', 'other.py'];
  const out = orderStalledLast(remainder, { 'heavy.py': 2, 'other.py': 1 });
  assert.deepEqual([...out].sort(), [...remainder].sort());
  assert.equal(out.length, remainder.length);
});

// --- CLI: the two subcommands, end to end ------------------------------------------------------

test('CLI pytest-merge then pytest-remainder: a killed attempt greens the finished file and sorts the stalled one LAST', () => {
  // The whole convergence fix in one pass: chunk 1 proves `fast.py` and dies inside `heavy.py`;
  // chunk 2's remainder must still contain `heavy.py` (nothing proved it) but return it AFTER
  // `slower.py`, so the next chunk retires a file it can actually finish.
  const repo = mkdtempSync(join(tmpdir(), 'battery-ledger-3318-cli-'));
  const events = join(repo, 'events.jsonl');
  writeFileSync(
    events,
    [
      { type: 'collect', file: 'backend/scripts/fast.py', count: 1 },
      { type: 'collect', file: 'backend/scripts/heavy.py', count: 1 },
      { type: 'collect', file: 'backend/scripts/slower.py', count: 1 },
      { type: 'start', file: 'backend/scripts/fast.py' },
      { type: 'report', file: 'backend/scripts/fast.py', outcome: 'passed', terminal: true },
      { type: 'start', file: 'backend/scripts/heavy.py' },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n',
  );
  execFileSync(process.execPath, [CLI, 'pytest-merge', '--key', KEY_A, '--file', events], {
    cwd: repo,
    encoding: 'utf8',
  });
  const out = execFileSync(process.execPath, [CLI, 'pytest-remainder', '--key', KEY_A], {
    cwd: repo,
    input: 'backend/scripts/fast.py\nbackend/scripts/heavy.py\nbackend/scripts/slower.py\n',
    encoding: 'utf8',
  });
  assert.deepEqual(out.split('\n').filter(Boolean), [
    'backend/scripts/slower.py',
    'backend/scripts/heavy.py',
  ]);
  rmSync(repo, { recursive: true, force: true });
});

// --- plan 3318 review round: the four defects six finders converged on ------------------------

test('stalledPytestFiles: a file killed PARTWAY through — some tests reported, not all — is a stall', () => {
  // The first cut required ZERO reports, which only catches a file killed before its first test
  // finished. A big file that gets a few tests further into each chunk and dies partway records no
  // file-level green either, so it is the same absorbing state — just slower and invisible.
  const text =
    [
      { type: 'collect', file: 'backend/scripts/big.py', count: 40 },
      { type: 'start', file: 'backend/scripts/big.py' },
      { type: 'report', file: 'backend/scripts/big.py', outcome: 'passed', terminal: true },
      { type: 'report', file: 'backend/scripts/big.py', outcome: 'passed', terminal: true },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n';
  const parsed = parsePytestLedgerEvents(text);
  assert.deepEqual([...stalledPytestFiles(parsed)], ['backend/scripts/big.py']);
  assert.deepEqual([...greenPytestFiles(parsed)], [], '2 of 40 reported is not green');
});

test('stalledPytestFiles: a fully-reported RED file is NEVER a stall — a failure must not be deprioritized', () => {
  // Pushing a genuine failure to the back of the run would report CHUNKED where the truth is
  // FAILED. A red file reports a terminal outcome for every collected item, so it never qualifies.
  const text =
    [
      { type: 'collect', file: 'backend/scripts/red.py', count: 2 },
      { type: 'start', file: 'backend/scripts/red.py' },
      { type: 'report', file: 'backend/scripts/red.py', outcome: 'failed', terminal: true },
      { type: 'report', file: 'backend/scripts/red.py', outcome: 'passed', terminal: true },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n';
  const parsed = parsePytestLedgerEvents(text);
  assert.deepEqual([...stalledPytestFiles(parsed)], []);
  assert.deepEqual([...greenPytestFiles(parsed)], [], 'and it is not green either');
});

test('parsePytestLedgerEvents: `slow_deselect` lines are their own channel — never green, never a stall', () => {
  const text =
    [
      { type: 'collect', file: 'backend/scripts/fast.py', count: 1 },
      { type: 'start', file: 'backend/scripts/fast.py' },
      { type: 'report', file: 'backend/scripts/fast.py', outcome: 'passed', terminal: true },
      { type: 'slow_deselect', file: 'backend/scripts/heavy.py' },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n';
  const parsed = parsePytestLedgerEvents(text);
  assert.deepEqual([...slowDeselectedPytestFiles(parsed)], ['backend/scripts/heavy.py']);
  assert.deepEqual([...greenPytestFiles(parsed)], ['backend/scripts/fast.py']);
  assert.deepEqual([...stalledPytestFiles(parsed)], []);
});

test('slowDeselectedPytestFiles: an events file with no such line (every ordinary run) is empty, never throws', () => {
  assert.deepEqual([...slowDeselectedPytestFiles(parsePytestLedgerEvents(''))], []);
  assert.deepEqual([...slowDeselectedPytestFiles({})], []);
});

test('CLI pytest-remainder --with-stalls: emits `<file>\\t<count>`, and the bare form is unchanged', () => {
  // The bare shape has a SECOND caller that counts plain path lines (done-worktree.mjs's
  // ledgerRemainderCount), so the stall column is opt-in rather than a shape change.
  const repo = mkdtempSync(join(tmpdir(), 'battery-ledger-3318-withstalls-'));
  const events = join(repo, 'events.jsonl');
  writeFileSync(
    events,
    [
      { type: 'collect', file: 'backend/scripts/a.py', count: 1 },
      { type: 'collect', file: 'backend/scripts/heavy.py', count: 1 },
      { type: 'start', file: 'backend/scripts/heavy.py' },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n',
  );
  execFileSync(process.execPath, [CLI, 'pytest-merge', '--key', KEY_A, '--file', events], {
    cwd: repo,
    encoding: 'utf8',
  });
  const stdin = 'backend/scripts/a.py\nbackend/scripts/heavy.py\n';
  const withStalls = execFileSync(
    process.execPath,
    [CLI, 'pytest-remainder', '--key', KEY_A, '--with-stalls'],
    { cwd: repo, input: stdin, encoding: 'utf8' },
  );
  assert.deepEqual(withStalls.split('\n').filter(Boolean), [
    'backend/scripts/a.py\t0',
    'backend/scripts/heavy.py\t1',
  ]);
  const bare = execFileSync(process.execPath, [CLI, 'pytest-remainder', '--key', KEY_A], {
    cwd: repo,
    input: stdin,
    encoding: 'utf8',
  });
  assert.deepEqual(bare.split('\n').filter(Boolean), [
    'backend/scripts/a.py',
    'backend/scripts/heavy.py',
  ]);
  rmSync(repo, { recursive: true, force: true });
});
