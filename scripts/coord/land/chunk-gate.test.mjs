// scripts/coord/land/chunk-gate.test.mjs — name-paired unit tests for chunk-gate.mjs, the PURE
// half of the chunk-gate timing subsystem moved out of scripts/done-worktree.mjs at plan 3961
// T2.0a (see that file's own header for the pure/impure split and why the two halves live apart).
//
// Justification for a NEW test file rather than folding into an existing one (repo convention,
// vetapp/CLAUDE.md "a new scripts/*.test.mjs FILE requires a one-line justification"): these
// cases are the exact name-pair of the new module scripts/coord/land/chunk-gate.mjs, moved intact
// from scripts/done-worktree.test.mjs where their subject used to live. A case that exercises one
// of these pure functions ALONGSIDE an impure name (chunkGateStartDecision, batteryRoundGreen, the
// ledger helpers, …) stayed in done-worktree.test.mjs instead — see that file's own T2.0a comment
// at its `./coord/land/chunk-gate.mjs` import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  chunkGateConfig,
  preQueueFreshenStandDown,
  chunkCapDecision,
  chunkCapMsAfterElapsed,
  chunkCapEnvValue,
  chunkReportDetail,
  nonConvergentReportDetail,
  roundProvedSomethingNew,
  processChunkDeadlineEpoch,
  processStartEpoch,
  processChunkCapMsNow,
  resetProcessChunkDeadlineForTest,
  landPreflightChunkOptions,
  isSpawnTimeout,
} from './chunk-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── plan 3274: cloud-chunked heavy gates (runPrepGates' pytest/battery re-validation) ──────────
// Coverage strategy: the D1/D2/D3 DECISION and MESSAGE logic (chunkGateConfig, chunkCapDecision,
// chunkReportDetail) is pure and exported, so it is unit-tested directly below — no subprocess, no
// battery-lock mutex, no queued-run.mjs ticket. `ledgerRemainderCount` is exercised against the
// REAL scripts/battery-ledger.mjs CLI (unmodified, already its own tested module) via a throwaway
// tmp directory as `cwd` — real merge/remainder behaviour, but no battery-lock or queue-ticket
// contention with any other parallel session on this machine (that mutex/ticket machinery is
// UNCHANGED by this plan; a full spawn-and-kill run through runFullBatteryPreflight/
// runPytestPreflight themselves would need it and is deliberately NOT exercised here — see
// CLAUDE.md "Heavy test runs take a queue ticket").
//
// (c) "with neither env var set, behaviour is unchanged" is additionally proven by every
// PRE-EXISTING pytest/battery preflight test above continuing to pass unmodified — none of them
// sets PREPUSH_GATE_CHUNK_S or CLAUDE_CODE_REMOTE, so they exercise exactly the `chunkCapMs: null`
// default path this plan added.

test('plan 3274 D2: chunkGateConfig precedence — PREPUSH_GATE_CHUNK_S > CLAUDE_CODE_REMOTE > OFF', () => {
  assert.deepEqual(
    chunkGateConfig({}),
    { enabled: false, wallS: 0, minChunkS: 0, wallVar: 'PREPUSH_WALL_S' },
    'neither var set -> OFF',
  );
  assert.deepEqual(
    chunkGateConfig({ PREPUSH_GATE_CHUNK_S: '300' }),
    {
      enabled: true,
      wallS: 300,
      minChunkS: 60,
      wallVar: 'PREPUSH_GATE_CHUNK_S (which is set, and OVERRIDES PREPUSH_WALL_S)',
    },
    'PREPUSH_GATE_CHUNK_S alone -> ON, overrides the wall default',
  );
  assert.deepEqual(
    chunkGateConfig({ CLAUDE_CODE_REMOTE: '1' }),
    { enabled: true, wallS: 480, minChunkS: 60, wallVar: 'PREPUSH_WALL_S' },
    'CLAUDE_CODE_REMOTE alone -> ON at the defaults',
  );
  assert.deepEqual(
    chunkGateConfig({ PREPUSH_GATE_CHUNK_S: '120', CLAUDE_CODE_REMOTE: '1' }),
    {
      enabled: true,
      wallS: 120,
      minChunkS: 60,
      wallVar: 'PREPUSH_GATE_CHUNK_S (which is set, and OVERRIDES PREPUSH_WALL_S)',
    },
    'both set -> PREPUSH_GATE_CHUNK_S wins (higher precedence, D2)',
  );
  // plan 3274 (F3 review fix): a 400-digit run is still "nothing but ASCII digits" (the regex
  // matches it), but `Number()` of it is `Infinity` — a digit-only string this parser must reject
  // exactly like the other "bad" values below, never accept as an unbounded budget.
  for (const bad of ['0', '-5', 'not-a-number', '', '9'.repeat(400)]) {
    assert.deepEqual(
      chunkGateConfig({ PREPUSH_GATE_CHUNK_S: bad }),
      { enabled: false, wallS: 0, minChunkS: 0, wallVar: 'PREPUSH_WALL_S' },
      `PREPUSH_GATE_CHUNK_S=${JSON.stringify(bad).slice(0, 40)} (not numeric > 0) falls through to OFF (no CLAUDE_CODE_REMOTE)`,
    );
    assert.deepEqual(
      chunkGateConfig({ PREPUSH_GATE_CHUNK_S: bad, CLAUDE_CODE_REMOTE: '1' }),
      { enabled: true, wallS: 480, minChunkS: 60, wallVar: 'PREPUSH_WALL_S' },
      `PREPUSH_GATE_CHUNK_S=${JSON.stringify(bad).slice(0, 40)} falls through to the CLAUDE_CODE_REMOTE branch`,
    );
  }
});

// plan 3274 (review round, F3/CONFIRMED): parsePrepushPositiveInt's digit-only regex matches an
// overflowing digit string (it IS nothing but ASCII digits), but `Number()` of one beyond
// Number.MAX_SAFE_INTEGER either loses precision or, past ~309 digits, returns Infinity outright —
// which then flows through unchanged as `wallS`/`minChunkS`/the D2 wall override, turning a CAP
// into an UNBOUNDED budget (the exact opposite of what chunking exists to guarantee). The repo's
// own `sh` (Git Bash on Windows, and every measured Linux cloud drain) disagrees with `Number()`
// here: `[ "$raw" -gt 0 ]` on a string past INT64_MAX (9223372036854775807) errors "integer
// expression expected" (exit 2) rather than returning true, and that error — sitting inside an
// `if [ ... ]; then` guard, per set -e semantics — reads as the condition being FALSE, so rule 1
// never fires and the caller falls through to its own default exactly as it would for a
// non-numeric string. This fix matches that: an overflowing digit string is treated as absent,
// never as Infinity.
test('plan 3274 (F3 review fix): an overflowing PREPUSH_GATE_CHUNK_S never enables chunking with an unbounded (Infinity) wall — treated as absent, like a non-numeric value', () => {
  const overflow = '9'.repeat(400); // Number(overflow) === Infinity
  assert.equal(Number(overflow), Infinity, 'sanity: this string really does overflow to Infinity');
  const cfg = chunkGateConfig({ PREPUSH_GATE_CHUNK_S: overflow });
  assert.deepEqual(
    cfg,
    { enabled: false, wallS: 0, minChunkS: 0, wallVar: 'PREPUSH_WALL_S' },
    'an unusable PREPUSH_GATE_CHUNK_S with no CLAUDE_CODE_REMOTE must stay OFF — before this fix ' +
      'it enabled chunking with wallS === Infinity',
  );
});

test('plan 3274 (F3 review fix): an overflowing PREPUSH_WALL_S under CLAUDE_CODE_REMOTE falls back to the 480s default, never Infinity', () => {
  const overflow = '9'.repeat(400);
  const cfg = chunkGateConfig({ CLAUDE_CODE_REMOTE: '1', PREPUSH_WALL_S: overflow });
  assert.deepEqual(
    cfg,
    { enabled: true, wallS: 480, minChunkS: 60, wallVar: 'PREPUSH_WALL_S' },
    'overflow treated as absent -> the ordinary 480s default, never an Infinity wall',
  );
});

test('plan 3274 (F3 review fix): an overflowing PREPUSH_MIN_CHUNK_S falls back to the 60s default, never Infinity (which would refuse every real gate as "not enough budget")', () => {
  const overflow = '9'.repeat(400);
  const cfg = chunkGateConfig({ CLAUDE_CODE_REMOTE: '1', PREPUSH_MIN_CHUNK_S: overflow });
  assert.deepEqual(cfg, { enabled: true, wallS: 480, minChunkS: 60, wallVar: 'PREPUSH_WALL_S' });
});

// ── plan 3274 (review round, F2/CONFIRMED): the land side ignored PREPUSH_WALL_S/
// PREPUSH_MIN_CHUNK_S entirely (hard-coded defaults, no env read at all) and used a LOOSER
// `Number(raw)` parse for PREPUSH_GATE_CHUNK_S than the hook's own digit-only case pattern — so
// the SAME env could enable chunk mode with a DIFFERENT wall/min-chunk on the two surfaces. Both
// gaps closed in chunkGateConfig; this block proves the fix.
test('plan 3274 (F2 review fix): chunkGateConfig honours PREPUSH_WALL_S/PREPUSH_MIN_CHUNK_S under the CLAUDE_CODE_REMOTE branch', () => {
  assert.deepEqual(
    chunkGateConfig({ CLAUDE_CODE_REMOTE: '1', PREPUSH_WALL_S: '600', PREPUSH_MIN_CHUNK_S: '30' }),
    { enabled: true, wallS: 600, minChunkS: 30, wallVar: 'PREPUSH_WALL_S' },
    'both overrides honoured — was hard-coded to {480, 60} before this fix',
  );
  assert.deepEqual(
    chunkGateConfig({ CLAUDE_CODE_REMOTE: '1', PREPUSH_WALL_S: '600' }),
    { enabled: true, wallS: 600, minChunkS: 60, wallVar: 'PREPUSH_WALL_S' },
    'PREPUSH_WALL_S alone -> wall overridden, min-chunk stays at its own default',
  );
  assert.deepEqual(
    chunkGateConfig({ CLAUDE_CODE_REMOTE: '1', PREPUSH_MIN_CHUNK_S: '30' }),
    { enabled: true, wallS: 480, minChunkS: 30, wallVar: 'PREPUSH_WALL_S' },
    'PREPUSH_MIN_CHUNK_S alone -> min-chunk overridden, wall stays at its own default',
  );
});

test('plan 3274 (F2 review fix): PREPUSH_MIN_CHUNK_S is honoured even under the PREPUSH_GATE_CHUNK_S branch (rule 1) — mirrors the hook setting it once, unconditionally, before either rule runs', () => {
  assert.deepEqual(chunkGateConfig({ PREPUSH_GATE_CHUNK_S: '300', PREPUSH_MIN_CHUNK_S: '90' }), {
    enabled: true,
    wallS: 300,
    minChunkS: 90,
    wallVar: 'PREPUSH_GATE_CHUNK_S (which is set, and OVERRIDES PREPUSH_WALL_S)',
  });
});

test('plan 3274 (F2 review fix): PREPUSH_WALL_S is IGNORED under the PREPUSH_GATE_CHUNK_S branch (rule 1) — mirrors the hook\'s own PREPUSH_WALL_S="$PREPUSH_GATE_CHUNK_S" clobber', () => {
  assert.deepEqual(
    chunkGateConfig({ PREPUSH_GATE_CHUNK_S: '50', PREPUSH_WALL_S: '999' }),
    {
      enabled: true,
      wallS: 50,
      minChunkS: 60,
      wallVar: 'PREPUSH_GATE_CHUNK_S (which is set, and OVERRIDES PREPUSH_WALL_S)',
    },
    'rule 1 REPLACES the wall outright — an explicit PREPUSH_WALL_S never wins over it, on either surface',
  );
});

test('plan 3274 (F2 review fix): an invalid PREPUSH_WALL_S/PREPUSH_MIN_CHUNK_S falls back to its own default — the SAME "non-numeric or non-positive" rule PREPUSH_GATE_CHUNK_S already uses, applied identically', () => {
  for (const bad of ['0', '-5', 'not-a-number', '3.5', ' 5 ', '0x10', '']) {
    assert.deepEqual(
      chunkGateConfig({ CLAUDE_CODE_REMOTE: '1', PREPUSH_WALL_S: bad }),
      { enabled: true, wallS: 480, minChunkS: 60, wallVar: 'PREPUSH_WALL_S' },
      `PREPUSH_WALL_S=${JSON.stringify(bad)} falls back to the 480s default`,
    );
    assert.deepEqual(
      chunkGateConfig({ CLAUDE_CODE_REMOTE: '1', PREPUSH_MIN_CHUNK_S: bad }),
      { enabled: true, wallS: 480, minChunkS: 60, wallVar: 'PREPUSH_WALL_S' },
      `PREPUSH_MIN_CHUNK_S=${JSON.stringify(bad)} falls back to the 60s default`,
    );
  }
});

test("plan 3274 (F2 review fix): PREPUSH_GATE_CHUNK_S rejects values the LOOSER pre-fix Number(raw) parse used to accept — matches the hook's digit-only case pattern exactly", () => {
  // Number('3.5')===3.5>0, Number(' 5 ')===5>0, and Number('0x10')===16>0 — all would have
  // enabled chunk mode under the pre-fix `Number.isFinite(parsed) && parsed > 0` check, but every
  // one of them hits the hook's own `*[!0-9]*` case branch (non-digit char present) and falls
  // through to rule 2 instead. Before this fix the JS and the hook could read the SAME env value
  // and disagree on whether rule 1 fired at all.
  for (const looselyNumeric of ['3.5', ' 5 ', '0x10', '+5', '5.0', '5e1']) {
    assert.deepEqual(
      chunkGateConfig({ PREPUSH_GATE_CHUNK_S: looselyNumeric }),
      { enabled: false, wallS: 0, minChunkS: 0, wallVar: 'PREPUSH_WALL_S' },
      `PREPUSH_GATE_CHUNK_S=${JSON.stringify(looselyNumeric)} must NOT enable rule 1 (no CLAUDE_CODE_REMOTE either) — the hook's digit-only case pattern would reject it too`,
    );
  }
});

// plan 3274 (review round, F2/CONFIRMED, sub-note): the two surfaces cannot share runtime code
// (bash vs Node), so the defaults are duplicated by hand — this is the drift pin, the same
// technique scripts/pre-push-battery-cap.test.mjs already uses for the battery cap literals: read
// the REAL hook source and assert the JS constant it was copied from has not silently drifted.
test('plan 3274 (F2 review fix): the JS chunk-mode wall/min-chunk defaults still match scripts/hooks/pre-push-core.sh (drift guard)', () => {
  // scripts/coord/land/ is two levels below scripts/, unlike scripts/done-worktree.test.mjs where this test lived before plan 3961 T2.0a.
  // plan 3963: the cloud-chunked heavy-gate deadline literals this pins live in the GENERIC half
  // of the pre-push.sh/pre-push-core.sh split (this is coordination tiering infra, not a
  // vetapp product concern) — scripts/hooks/pre-push.sh is now a thin dispatcher with no gate
  // text of its own.
  const hookText = readFileSync(join(HERE, '..', '..', 'hooks', 'pre-push-core.sh'), 'utf8');
  const wallMatch = hookText.match(/^PREPUSH_WALL_S="\$\{PREPUSH_WALL_S:-(\d+)\}"$/m);
  const minMatch = hookText.match(/^PREPUSH_MIN_CHUNK_S="\$\{PREPUSH_MIN_CHUNK_S:-(\d+)\}"$/m);
  assert.ok(wallMatch, 'the PREPUSH_WALL_S default literal is gone or changed shape in the hook');
  assert.ok(
    minMatch,
    'the PREPUSH_MIN_CHUNK_S default literal is gone or changed shape in the hook',
  );
  // No overrides -> chunkGateConfig's own {480, 60} literals, straight from the JS constants.
  const jsDefaults = chunkGateConfig({ CLAUDE_CODE_REMOTE: '1' });
  assert.equal(
    jsDefaults.wallS,
    Number(wallMatch[1]),
    "the JS chunk-mode wall default has drifted from the hook's own PREPUSH_WALL_S default",
  );
  assert.equal(
    jsDefaults.minChunkS,
    Number(minMatch[1]),
    "the JS chunk-mode min-chunk-to-start default has drifted from the hook's own PREPUSH_MIN_CHUNK_S default",
  );
});

test('plan 3274 D1: chunkCapDecision — off, not-started, chunked, and "our cap was never binding"', () => {
  assert.deepEqual(
    chunkCapDecision({ chunkCapMs: null, minChunkS: 60, naturalTimeoutMs: 3_000_000 }),
    { shouldRun: true, effectiveTimeoutMs: 3_000_000, usingChunkCap: false },
    "chunking off (null chunkCapMs) -> run at the gate's own natural cap, unaffected",
  );
  assert.deepEqual(
    chunkCapDecision({ chunkCapMs: 59_000, minChunkS: 60, naturalTimeoutMs: 3_000_000 }),
    { shouldRun: false, effectiveTimeoutMs: 0, usingChunkCap: true },
    'under minChunkS -> do not start, zero progress',
  );
  assert.deepEqual(
    chunkCapDecision({ chunkCapMs: -5_000, minChunkS: 60, naturalTimeoutMs: 3_000_000 }),
    { shouldRun: false, effectiveTimeoutMs: 0, usingChunkCap: true },
    'a deadline already past (negative remaining) -> do not start',
  );
  assert.deepEqual(
    chunkCapDecision({ chunkCapMs: 420_000, minChunkS: 60, naturalTimeoutMs: 3_000_000 }),
    { shouldRun: true, effectiveTimeoutMs: 420_000, usingChunkCap: true },
    'a real, binding chunk cap below the natural timeout -> that cap is what runs',
  );
  assert.deepEqual(
    chunkCapDecision({ chunkCapMs: 9_000_000, minChunkS: 60, naturalTimeoutMs: 3_000_000 }),
    { shouldRun: true, effectiveTimeoutMs: 3_000_000, usingChunkCap: false },
    'chunking on but generous enough that the NATURAL cap is still the binding one -> not "using" it',
  );
});

// ── plan 3274 (review round, F3/CONFIRMED): the pytest/battery cap was snapshotted BEFORE the
// preparation that precedes the real run (ledger carry-forward for pytest; the battery-lock mutex
// + queued-run.mjs ticket wait for battery) — so a lock wait or a slow carry-forward call silently
// donated its own wall-clock spend to the run's budget instead of being charged against it.
// runFullBatteryPreflight/runPytestPreflight now both re-derive the cap immediately before their
// real run via chunkCapMsAfterElapsed(chunkCapMs, elapsed-since-capture) — this is the exact
// subtraction that makes that possible, proven directly (no real timer, no real
// ledger/mutex/queue wait needed — a real spawn-and-kill run through those two functions is
// deliberately out of scope for this file, see this section's own header comment above).
test('plan 3274 (F3 review fix): chunkCapMsAfterElapsed subtracts elapsed wall-clock exactly — "snapshot immediately before the run" without re-deriving the whole per-process deadline', () => {
  assert.equal(
    chunkCapMsAfterElapsed(null, 999_999),
    null,
    'chunking off (null) stays off regardless of elapsed prep time',
  );
  assert.equal(chunkCapMsAfterElapsed(420_000, 0), 420_000, 'no elapsed time -> unchanged');
  assert.equal(
    chunkCapMsAfterElapsed(420_000, 100_000),
    320_000,
    'elapsed prep time (e.g. a mutex wait, or a carry-forward call) is subtracted from the remaining budget',
  );
  assert.equal(
    chunkCapMsAfterElapsed(60_000, 90_000),
    -30_000,
    'preparation alone can exhaust and overshoot the budget — goes negative, which chunkCapDecision already reads as "no time left" (shouldRun: false)',
  );
  // Feeds directly into chunkCapDecision exactly as the real call sites do: a cap that still had
  // 90s left at capture but paid 45s of mutex-wait leaves only 45s for the run itself.
  assert.deepEqual(
    chunkCapDecision({
      chunkCapMs: chunkCapMsAfterElapsed(90_000, 45_000),
      minChunkS: 60,
      naturalTimeoutMs: 3_000_000,
    }),
    { shouldRun: false, effectiveTimeoutMs: 0, usingChunkCap: true },
    '45s remaining is under a 60s minChunkS -> the run must not even start, exactly as if it had been snapshotted fresh at 45s in the first place',
  );
});

test('plan 3274 D3: chunkReportDetail — three shapes, always CHUNKED-prefixed and never confusable with a real failure', () => {
  const notStarted = chunkReportDetail({
    gate: 'pytest',
    started: false,
    secondsLeft: 12.4,
    minChunkS: 60,
  });
  assert.match(notStarted, /^pytest gate: CHUNKED \(not a test failure\): /);
  assert.match(notStarted, /12s left/);
  assert.match(notStarted, /needs >= 60s/);
  assert.match(notStarted, /pytest did not start this attempt, no new progress/);
  assert.match(notStarted, /Re-invoke done-worktree to continue — no rebase, no --no-verify\.$/);

  const withCounts = chunkReportDetail({
    gate: 'battery',
    key: 'deadbeef00000000000000000000000',
    proven: 1234,
    total: 2073,
    remaining: 839,
  });
  assert.match(withCounts, /^battery gate: CHUNKED \(not a test failure\): /);
  assert.match(
    withCounts,
    /1234 of 2073 files proven green under key deadbeef00000000000000000000000, 839 remaining\./,
  );
  assert.match(withCounts, /Re-invoke done-worktree to continue — no rebase, no --no-verify\.$/);

  const degraded = chunkReportDetail({ gate: 'pytest', key: 'cafefeed00000000000000000000000' });
  assert.match(degraded, /^pytest gate: CHUNKED \(not a test failure\): /);
  assert.match(degraded, /proven\/remaining counts could be determined/);
  assert.match(degraded, /cafefeed00000000000000000000000/);
  assert.match(degraded, /Re-invoke done-worktree to continue — no rebase, no --no-verify\.$/);

  // A partial/negative/non-integer count must NOT be mistaken for "known" — same degraded shape.
  assert.match(
    chunkReportDetail({ gate: 'battery', key: 'k', proven: 3, total: undefined, remaining: 2 }),
    /proven\/remaining counts could be determined/,
  );
});

test("plan 3374 (delta review): PROGRESS is read off the round's OWN events, never off a green-count delta that trusts the merge", () => {
  // Delta-review cluster A (eleven findings, one claim — angle-A/B/C/P, simplification, altitude,
  // guard-fires, writer-trace): `battery-ledger.mjs merge` CATCHES its own fs failures, logs
  // "merge write failed (ignored)" and still exits 0 — it is close-out bookkeeping that must never
  // block a decided verdict. So a zero exit proves nothing about whether the ledger actually
  // changed, and the first cut's "green count before vs after the merge" comparison would read a
  // silently-failed merge as a zero-progress round. Two of those in a row = a false seam against a
  // gate that was proving files the whole time.
  //
  // The fix takes the merge out of the trust path entirely: what a round PROVED is what its own
  // events say it proved, which is exactly the set the merge would have unioned in.
  const before = new Set(['backend/scripts/a.py', 'backend/scripts/b.py']);
  assert.equal(
    roundProvedSomethingNew(new Set(['backend/scripts/c.py']), before),
    true,
    'a file this round proved that was NOT already green is progress — merge outcome irrelevant',
  );
  assert.equal(
    roundProvedSomethingNew(new Set(['backend/scripts/a.py']), before),
    false,
    're-proving an already-green file is NOT new progress',
  );
  assert.equal(roundProvedSomethingNew(new Set(), before), false, 'proved nothing at all');
  // No events parsed (unreadable/absent) — no evidence of progress, and the ranProven gate
  // separately refuses to score such a round at all.
  assert.equal(roundProvedSomethingNew(null, before), false);
  assert.equal(roundProvedSomethingNew(undefined, new Set()), false);
});

test('plan 4133 S3 (the 3529 shape): a proven path under .scratch/ never counts as progress, even when it is genuinely new', () => {
  // Plan 3529 (2026-08-30, docs/handoff/infra-debt.md): battery-ledger.test.mjs's own throwaway
  // `.scratch/test-gate-ledger-tmp/noop-<rand>/test_a.py` fixtures reached the REAL production
  // ledger key and padded the green count every round — six consecutive bare re-invokes, zero real
  // progress, and GATE_NON_CONVERGENT never fired because the ledger genuinely kept "growing".
  const before = new Set(['backend/scripts/a.py']);
  assert.equal(
    roundProvedSomethingNew(
      new Set(['.scratch/test-gate-ledger-tmp/noop-abc123/test_a.py']),
      before,
    ),
    false,
    'a fresh, never-before-seen .scratch/ path must still not read as progress — the 3529 shape is a NEW random dir name every round',
  );
  assert.equal(
    roundProvedSomethingNew(
      new Set(['backend/scripts/b.py', '.scratch/test-gate-ledger-tmp/noop-xyz789/test_b.py']),
      before,
    ),
    true,
    'a REAL new file alongside .scratch/ noise must still count — the filter excludes the noise, not the whole round',
  );
  assert.equal(
    roundProvedSomethingNew(
      new Set(['.scratch\\test-gate-ledger-tmp\\noop-win\\test_a.py']),
      before,
    ),
    false,
    'the backslash separator must be filtered too — a ledger entry can arrive spelled either way',
  );
});

test('plan 4133 review r1: the .scratch filter matches a path COMPONENT, never a bare substring', () => {
  // A substring test (`path.includes('.scratch/')`) also swallows a real suite path whose own
  // directory merely ENDS in `.scratch` — `vendor/tool.scratch/test_a.py` is a legitimate file,
  // not session scratch, and silently dropping it from the progress comparison would re-open
  // exactly the blindness S3 exists to close (a round that proved only such files would score
  // zero-progress and trip GATE_NON_CONVERGENT against a land that was genuinely progressing).
  const before = new Set(['backend/scripts/a.py']);
  assert.equal(
    roundProvedSomethingNew(new Set(['vendor/tool.scratch/test_a.py']), before),
    true,
    'a component merely ENDING in .scratch is a real path, not session scratch',
  );
  assert.equal(
    roundProvedSomethingNew(new Set(['vendor\\tool.scratch\\test_a.py']), before),
    true,
    'same on the backslash spelling',
  );
  // The real thing still filters, anchored at either end of the component.
  assert.equal(
    roundProvedSomethingNew(new Set(['backend/.scratch/noop/test_a.py']), before),
    false,
    'a genuine .scratch component filters wherever it sits in the path',
  );
});

// plan 3961 T3.5b: the two gate-specific remedy sentences moved OUT of chunk-gate.mjs (which no
// longer knows what "pytest" or "battery" even are — see its own header on nonConvergentReportDetail)
// and into their respective callers (scripts/done-worktree.mjs for battery, ../project/land-gate-
// pytest.mjs for pytest). The builder itself is now exercised with an arbitrary `remedy` string —
// the fixtures below deliberately do NOT reuse either real caller's exact sentence, so a passing
// test here proves the PARAMETER is wired through, not that today's two sentences still exist.
test('plan 3374 (review C4) / plan 3961 T3.5b: the remedy is whatever the CALLER supplies, verbatim, never derived from `gate`', () => {
  const battery = nonConvergentReportDetail({
    gate: 'battery',
    key: 'k',
    rounds: 2,
    headFile: 'scripts/slow.test.mjs',
    remedy: 'fixture battery remedy sentence',
  });
  assert.ok(!/pytest/i.test(battery), `the battery remedy must not mention pytest: ${battery}`);
  assert.match(battery, /fixture battery remedy sentence/);
  // The SAME `gate: 'pytest'` call with a DIFFERENT remedy string proves the text is not keyed off
  // `gate` internally — only the caller's own `remedy` argument decides it.
  const pytest = nonConvergentReportDetail({
    gate: 'pytest',
    key: 'k',
    rounds: 2,
    headFile: 'backend/scripts/x.py',
    remedy: 'fixture pytest remedy sentence',
  });
  assert.match(pytest, /fixture pytest remedy sentence/);
  assert.ok(!/fixture battery remedy sentence/.test(pytest));
});

// plan 3961 T3.5b: chunk-gate.mjs is core (scripts/coord/land/**) and must carry no vetapp-shaped
// literal — the word "pytest" itself is the tripwire registry.test.mjs's T2.10 closing sweep already
// named as a tracked, code-level (not comment-level) coupling pending this exact carve. A grep
// finding the word anywhere in the module again (code OR comment) means the coupling came back.
test('plan 3961 T3.5b: chunk-gate.mjs (core) never spells the word "pytest" again', () => {
  const src = readFileSync(join(HERE, 'chunk-gate.mjs'), 'utf8');
  assert.doesNotMatch(
    src,
    /pytest/i,
    'chunk-gate.mjs must stay gate-agnostic — a project-specific gate name belongs to the caller, ' +
      'supplied as the `remedy` parameter, never spelled out in this core module',
  );
});

test('plan 3374: nonConvergentReportDetail NAMES the head file, states the CALLER-SUPPLIED remedy, and never says "re-invoke to continue"', () => {
  const named = nonConvergentReportDetail({
    gate: 'pytest',
    key: 'cafefeed00000000000000000000000',
    rounds: 2,
    headFile: 'backend/scripts/data-pipeline/__tests__/test_1636_gate_recall_matrix.py',
    remaining: 772,
    remedy: 'mark the file `@pytest.mark.slow` (chunk-capped runs deselect those)',
  });
  assert.match(
    named,
    /^pytest gate: NON-CONVERGENT \(not a test failure, and not ordinary chunking\)/,
  );
  assert.match(named, /test_1636_gate_recall_matrix\.py cannot finish inside one chunk wall/);
  assert.match(named, /last 2 chunk-capped rounds/);
  assert.match(named, /772 file\(s\) still unproven/);
  assert.match(named, /The remedy is a COMMIT, not another round/);
  assert.match(named, /@pytest\.mark\.slow/);
  assert.ok(
    !/Re-invoke done-worktree to continue/.test(named),
    'this builder must never carry the CHUNKED promise — that is the lie it exists to withdraw',
  );
  // Without a nameable head file it degrades HONESTLY rather than inventing a filename; the seam
  // still fires, because the zero-progress evidence is what fires it, not the name.
  const anon = nonConvergentReportDetail({
    gate: 'battery',
    key: 'k',
    rounds: 2,
    remedy: 'fixture remedy',
  });
  assert.match(anon, /could not name which/);
  assert.ok(!/undefined|null/.test(anon), `no placeholder leaked: ${anon}`);
});

test('plan 3318: chunkCapEnvValue is ALWAYS a value — the wall when ours, the empty sentinel otherwise', () => {
  // gpt-review (angle-A/angle-B/angle-P/writer-trace): the first cut spread this key
  // CONDITIONALLY over `process.env`, so an ambient leftover survived into an UNCAPPED run — and
  // the plugin reads the variable as "this run cannot finish a `slow` file, drop it". Always
  // computing a value (empty = uncapped) is what makes an inherited one unreachable.
  assert.equal(chunkCapEnvValue({ usingChunkCap: true, effectiveTimeoutMs: 480_000 }), '480');
  assert.equal(chunkCapEnvValue({ usingChunkCap: true, effectiveTimeoutMs: 461_500 }), '461');
  assert.equal(chunkCapEnvValue({ usingChunkCap: false, effectiveTimeoutMs: 480_000 }), '');
  // A cap we cannot express in seconds is not a cap we may act on — same fail direction.
  assert.equal(chunkCapEnvValue({ usingChunkCap: true, effectiveTimeoutMs: Infinity }), '');
  assert.equal(chunkCapEnvValue({ usingChunkCap: true }), '');
  assert.equal(chunkCapEnvValue(undefined), '');
});

test('plan 3318: chunkReportDetail NAMES the file the cap fired inside, and is unchanged without one', () => {
  // The plan's own diagnosis was that "nothing measures a single file's wall time": three cloud
  // lands each burned four chunks inside ONE 21-minute file and the seam could only say
  // "before proven/remaining counts could be determined". Both count shapes must carry the name.
  const degraded = chunkReportDetail({
    gate: 'pytest',
    key: 'cafefeed00000000000000000000000',
    stalledFile: 'backend/scripts/data-pipeline/__tests__/test_1636_gate_recall_matrix.py',
  });
  assert.match(degraded, /^pytest gate: CHUNKED \(not a test failure\): /);
  assert.match(degraded, /cap fired while running backend\/scripts\/data-pipeline\/__tests__\//);
  assert.match(degraded, /no test in it finished, so it proved nothing/);
  assert.match(degraded, /sorts LAST in the remainder/);
  assert.match(degraded, /mark it `slow`/);
  assert.match(degraded, /Re-invoke done-worktree to continue — no rebase, no --no-verify\.$/);

  const withCounts = chunkReportDetail({
    gate: 'pytest',
    key: 'k',
    proven: 152,
    total: 925,
    remaining: 773,
    stalledFile: 'backend/scripts/heavy.py',
  });
  assert.match(withCounts, /152 of 925 files proven green under key k, 773 remaining\./);
  assert.match(withCounts, /cap fired while running backend\/scripts\/heavy\.py/);

  // Absent / empty / non-string: byte-identical to the pre-3318 text, so every existing caller
  // and the "did not start" shape (which can never have an in-flight file) are untouched.
  const bare = chunkReportDetail({ gate: 'pytest', key: 'k' });
  for (const v of [undefined, null, '', 0, {}]) {
    assert.equal(chunkReportDetail({ gate: 'pytest', key: 'k', stalledFile: v }), bare);
  }
  assert.doesNotMatch(bare, /cap fired while running/);
});

// ── plan 3274 (follow-up): the chunk deadline is per-PROCESS, and the land path is capped too ──
// `_processChunkDeadlineEpoch` is a module-level singleton, so every test below resets it in a
// `finally` — this test FILE runs every `test()` in one process/module instance (unlike the
// dryRunEnv-based tests elsewhere in this suite, which spawn done-worktree.mjs as a fresh
// subprocess and so never touch this singleton at all), and a leaked stamp would silently poison
// whichever test happens to run next.
test('plan 3274 gap 2: the process chunk deadline is stamped ONCE and reused — a later read ignores a DIFFERENT chunkCfg', () => {
  resetProcessChunkDeadlineForTest();
  try {
    const first = processChunkDeadlineEpoch(chunkGateConfig({ PREPUSH_GATE_CHUNK_S: '500' }));
    assert.ok(
      typeof first === 'number' && first > Date.now(),
      'first consumer stamps a real future epoch',
    );
    const second = processChunkDeadlineEpoch(chunkGateConfig({ PREPUSH_GATE_CHUNK_S: '9999' }));
    assert.equal(
      second,
      first,
      'a second consumer within the SAME process reuses the first-stamped deadline, never ' +
        're-stamping from a later chunkCfg — this is what keeps two runPrepGates passes (or a ' +
        'runPrepGates pass plus a land-path call) inside one shared wall instead of summing',
    );
    // chunking OFF is memoized too (as `null`), not re-derived every call.
    resetProcessChunkDeadlineForTest();
    const off1 = processChunkDeadlineEpoch(chunkGateConfig({}));
    const off2 = processChunkDeadlineEpoch(chunkGateConfig({ PREPUSH_GATE_CHUNK_S: '300' }));
    assert.equal(off1, null, 'chunking off on first read -> null');
    assert.equal(
      off2,
      null,
      'stays null for a later consumer even if ITS OWN chunkCfg would enable it',
    );
  } finally {
    resetProcessChunkDeadlineForTest();
  }
});

test('plan 3274 gap 2: resetProcessChunkDeadlineForTest(undefined) clears the stamp so the NEXT consumer re-derives a fresh one', () => {
  resetProcessChunkDeadlineForTest();
  try {
    // An arbitrary sentinel epoch — deterministic, unlike two back-to-back Date.now() reads (which
    // can tie on a coarse clock tick and make a notEqual-on-timestamps assertion flaky). If the
    // stamp were NOT cleared, the next read would still be this exact sentinel.
    const sentinel = 12_345;
    resetProcessChunkDeadlineForTest(sentinel);
    const cfg = chunkGateConfig({ PREPUSH_GATE_CHUNK_S: '200' });
    assert.equal(
      processChunkDeadlineEpoch(cfg),
      sentinel,
      'reads back the injected value without re-stamping',
    );
    resetProcessChunkDeadlineForTest(); // the clear under test
    const fresh = processChunkDeadlineEpoch(cfg);
    assert.notEqual(
      fresh,
      sentinel,
      'a fresh consumer after reset must NOT still see the stale sentinel',
    );
    // plan 3430 (gpt-review 785397/CONFIRMED): this used to assert `fresh > Date.now()`, which the
    // process-start anchor makes LOAD-DEPENDENT — the re-derived stamp is `processStartEpoch() +
    // 200s`, and this shared test process routinely lives longer than 200s (the whole file runs
    // ~160s alone and considerably longer under parallel-session load), so a green suite would have
    // started failing spuriously and blocking unrelated pushes. Assert what the re-derive actually
    // promises instead: the process-start anchor plus this case's wall, to the millisecond.
    assert.ok(
      Math.abs(fresh - (processStartEpoch() + 200_000)) <= 2,
      `the re-derived stamp is anchored at process start plus the 200s wall, got ${fresh} vs ` +
        `${processStartEpoch() + 200_000}`,
    );
  } finally {
    resetProcessChunkDeadlineForTest();
  }
});

test('plan 3274 gap 2: resetProcessChunkDeadlineForTest(epoch) injects an exact value — simulates "most of the wall already spent"', () => {
  resetProcessChunkDeadlineForTest();
  try {
    const nearPast = Date.now() + 3_000; // 3s of "process budget" left, injected directly
    resetProcessChunkDeadlineForTest(nearPast);
    const cfg = chunkGateConfig({ CLAUDE_CODE_REMOTE: '1' }); // wallS=480 — irrelevant, already stamped
    assert.equal(
      processChunkDeadlineEpoch(cfg),
      nearPast,
      'the injected epoch wins over what this chunkCfg would have stamped',
    );
    const capMs = processChunkCapMsNow(cfg);
    assert.ok(
      capMs > 0 && capMs <= 3_000,
      `a later consumer sees the REDUCED budget (~3s), not a fresh 480s wall: got ${capMs}`,
    );
  } finally {
    resetProcessChunkDeadlineForTest();
  }
});

test('plan 3274 gap 1+2: landPreflightChunkOptions (what both land-path call sites pass into their *Cached wrapper) reflects a near-spent shared deadline and refuses to start under chunkCapDecision/chunkReportDetail', () => {
  resetProcessChunkDeadlineForTest();
  try {
    // Simulate: an earlier consumer in this SAME process (e.g. a runPrepGates pass, or another
    // land-path gate) already burned the wall down to less than minChunkS (60s default).
    resetProcessChunkDeadlineForTest(Date.now() + 10_000);
    const opts = landPreflightChunkOptions({ CLAUDE_CODE_REMOTE: '1' });
    assert.equal(opts.minChunkS, 60, 'minChunkS comes through from chunkGateConfig unchanged');
    assert.ok(
      opts.chunkCapMs > 0 && opts.chunkCapMs <= 10_000,
      `chunkCapMs reflects the shared (near-spent) deadline, not a fresh 480s: got ${opts.chunkCapMs}`,
    );
    // Feed it through the SAME decision function every heavy gate runner consults (chunkCapDecision)
    // — this is the exact composition runFullBatteryPreflight/runPytestPreflight apply to whatever
    // chunkCapMs their *Cached wrapper (called by the land-path call sites) hands them.
    const decision = chunkCapDecision({
      chunkCapMs: opts.chunkCapMs,
      minChunkS: opts.minChunkS,
      naturalTimeoutMs: 3_000_000,
    });
    assert.equal(decision.shouldRun, false, 'under minChunkS -> the gate must not even start');
    const detail = chunkReportDetail({
      gate: 'pytest',
      started: false,
      secondsLeft: opts.chunkCapMs / 1000,
      minChunkS: opts.minChunkS,
    });
    assert.match(detail, /^pytest gate: CHUNKED \(not a test failure\): /);
    assert.match(detail, /did not start this attempt, no new progress/);
  } finally {
    resetProcessChunkDeadlineForTest();
  }
});

test('plan 3274 gap 1: landPreflightChunkOptions is OFF by default — neither env var set -> {chunkCapMs: null, minChunkS: 0}, byte-identical to before this plan', () => {
  resetProcessChunkDeadlineForTest();
  try {
    assert.deepEqual(landPreflightChunkOptions({}), { chunkCapMs: null, minChunkS: 0 });
    // And chunkCapDecision reads that as "run at the gate's own natural cap, unaffected" — the
    // exact byte-identical-behaviour guarantee this whole plan rests on (see chunkCapDecision's own
    // header). The large pre-existing pytest/battery preflight test suite above (none of which sets
    // PREPUSH_GATE_CHUNK_S or CLAUDE_CODE_REMOTE) is the corroborating end-to-end evidence: every
    // one of those DRY runs now ALSO evaluates landPreflightChunkOptions() at the land-path call
    // sites (this plan's gap-1 fix) and still passes unmodified, because {chunkCapMs: null,
    // minChunkS: 0} is exactly the pre-existing default the *Cached wrappers already special-case.
    assert.deepEqual(
      chunkCapDecision({ chunkCapMs: null, minChunkS: 0, naturalTimeoutMs: 3_000_000 }),
      { shouldRun: true, effectiveTimeoutMs: 3_000_000, usingChunkCap: false },
    );
  } finally {
    resetProcessChunkDeadlineForTest();
  }
});

// ── plan 3430 D1: the chunk wall is anchored at PROCESS START, not at first chunked-gate use ──
// The defect this closes (measured on plan 3393's cloud land): the land spends real wall-clock on
// preflight + the pre-queue build gate + the pre-queue WebKit mobile gate BEFORE it reaches a
// chunkable gate, and under plan 3274 none of it counted — a 480s wall stamped 163s into the
// process fires at 643s, i.e. 43s AFTER the 600s Bash tool cap has already killed the call, so the
// *_CHUNKED seam that exists to say "re-invoke, this is progress" never got to speak.
//
// `startEpoch` is the injection point (no real sleeps): passing a start epoch N ms in the past is
// exactly what "N ms of pre-gate spend already happened" means to this arithmetic.
test('plan 3430 D1: wall-clock burned BEFORE the first chunked gate reduces that gate’s cap — 200s of pre-gate spend leaves ~280s of a 480s wall, not a fresh 480s', () => {
  resetProcessChunkDeadlineForTest();
  try {
    const cfg = chunkGateConfig({ CLAUDE_CODE_REMOTE: '1' }); // 480s default wall
    assert.equal(cfg.wallS, 480, 'the cloud default wall this case is written against');
    const capMs = processChunkCapMsNow(cfg, Date.now() - 200_000);
    assert.ok(
      capMs > 270_000 && capMs <= 280_000,
      `200s of pre-gate spend must leave ~280s of the 480s wall, got ${capMs}ms — a fresh 480s ` +
        'here is the pre-3430 bug: the gate would run past the 600s tool cap and be killed ' +
        'mid-run instead of reporting CHUNKED',
    );
    // The whole point of the anchor: gate cap + pre-gate spend stays strictly inside the 600s tool
    // cap, with head room left over for the post-gate enqueue/head-merge bookkeeping (phase 6).
    assert.ok(
      200_000 + capMs < 600_000,
      'pre-gate spend plus the remaining chunk budget must fire the seam strictly inside the ' +
        '600000ms foreground Bash cap',
    );
  } finally {
    resetProcessChunkDeadlineForTest();
  }
});

test('plan 3430 D1: pre-gate spend that exceeds the whole wall leaves a sub-minChunkS budget, and chunkCapDecision refuses to START — reported as CHUNKED (re-invoke), never as a gate failure', () => {
  resetProcessChunkDeadlineForTest();
  try {
    const cfg = chunkGateConfig({ CLAUDE_CODE_REMOTE: '1' });
    const capMs = processChunkCapMsNow(cfg, Date.now() - 500_000); // 500s spent of a 480s wall
    assert.ok(capMs < 0, 'the budget is exhausted (negative), not silently refreshed');
    const decision = chunkCapDecision({
      chunkCapMs: capMs,
      minChunkS: cfg.minChunkS,
      naturalTimeoutMs: 3_000_000,
    });
    assert.equal(decision.shouldRun, false, 'below minChunkS -> do not even start the gate');
    assert.equal(
      decision.usingChunkCap,
      true,
      'usingChunkCap is what routes the refusal to the *_CHUNKED seam (partial progress, ' +
        're-invoke) instead of the *_FAILED one',
    );
    // On the ORDINARY LAND path this self-heals after one round: the pre-gate build and mobile
    // gates are content-cache hits on the next invocation (plan 2462 / gate-pass-cache, both
    // cloud-active — unlike the LOCAL-only gatesProven skip), so the pre-gate spend collapses and
    // the chunked gate gets essentially the whole wall.
    //
    // It does NOT self-heal on the `--prep` path (gpt-review 529c90/bfdb9a, both CONFIRMED):
    // `runPrepGates` runs the mobile gate through the UNCACHED `runMobilePreflight`, so a slow
    // mobile gate re-burns the same wall every invocation, and plan 3374's non-convergence counter
    // deliberately ignores a round that never STARTED (it observed nothing about convergence), so
    // GATE_NON_CONVERGENT never fires. That loop is bounded in the DOCTRINE instead of the code —
    // the routine prompt tells a drain that a CHUNKED report saying the gate did not start, seen
    // twice on the same commit, is a stop to report rather than a round to repeat (see
    // cloud-routine-prompt-lib.mjs and its own test). Bounding it in code would mean persisting a
    // no-start tally, and the pytest half has no resolved ledger key to persist one against.
  } finally {
    resetProcessChunkDeadlineForTest();
  }
});

test('plan 3430: the remaining budget is measured by MONOTONIC delta, so a backward wall-clock step cannot hand a gate back budget it already spent', () => {
  resetProcessChunkDeadlineForTest();
  const realNow = Date.now;
  try {
    const cfg = chunkGateConfig({ CLAUDE_CODE_REMOTE: '1' });
    const stampNow = realNow();
    // Stamp with 200s already spent -> ~280s left.
    const before = processChunkCapMsNow(cfg, stampNow - 200_000);
    assert.ok(before > 270_000 && before <= 280_000, `stamped budget, got ${before}`);
    // Now step the WALL clock 240s backwards, as an NTP correction or a VM resume would. Nothing
    // about the process's real elapsed time changed, so the budget must not move. Before this fix
    // the read was `deadline - Date.now()`, which would report ~520s left — past the 600s tool cap,
    // so the gate would run to a kill instead of a *_CHUNKED seam.
    Date.now = () => realNow() - 240_000;
    const after = processChunkCapMsNow(cfg);
    assert.ok(
      Math.abs(after - before) <= 2_000,
      `a backward clock step must not change the remaining budget: ${before} -> ${after}`,
    );
  } finally {
    Date.now = realNow;
    resetProcessChunkDeadlineForTest();
  }
});

test('plan 3430 D1: processStartEpoch is invariant of WHEN it is asked — so stamping lazily at the first chunked gate yields the same anchor an eager module-load stamp would have', () => {
  const t0 = 1_700_000_000_000;
  // Same process, asked 250s apart: Date.now() and process.uptime() advance together, so the
  // derived start epoch does not move. This is why plan 3274's "a process that never reaches a
  // chunked gate pays nothing" laziness survives the 3430 anchor unchanged.
  assert.equal(processStartEpoch(t0, 10), processStartEpoch(t0 + 250_000, 260));
  assert.equal(processStartEpoch(t0, 10), t0 - 10_000);
});

// ── plan 3795: chunk mode preserves its wall for the authoritative at-head path ─────────
//
test('plan 3795: preQueueFreshenStandDown yields only when chunk mode is enabled', () => {
  assert.deepEqual(preQueueFreshenStandDown({ enabled: true, wallS: 510, minChunkS: 60 }), {
    standDown: true,
    reason:
      'chunk mode is enabled; the optional freshen yields its shared wall to the authoritative at-head sync',
  });
  assert.deepEqual(preQueueFreshenStandDown({ enabled: false, wallS: 0, minChunkS: 0 }), {
    standDown: false,
    reason: null,
  });
});

test('plan 3436 D1: isSpawnTimeout tells OUR OWN cap firing apart from a real gate failure — pinned against a real spawn, not from memory', () => {
  // The whole of D1's safety rests on this one predicate. Too permissive and a genuine `next build`
  // break is re-read as "partial progress, re-invoke" and never blocks a land — so the shape is
  // measured on the node actually running, the same way the batteryLockAcquireOutcome test above
  // pins spawnSync's timeout shape rather than asserting it from memory.
  let timeoutErr;
  try {
    execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      timeout: 500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.fail('the spawn should have been killed by its own timeout');
  } catch (e) {
    timeoutErr = e;
  }
  assert.equal(timeoutErr.code, 'ETIMEDOUT', "node's own timeout kill must report ETIMEDOUT");
  assert.equal(isSpawnTimeout(timeoutErr), true);

  let failErr;
  try {
    execFileSync(process.execPath, ['-e', 'process.exit(3)'], {
      timeout: 600_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.fail('exit 3 should have thrown');
  } catch (e) {
    failErr = e;
  }
  assert.equal(failErr.status, 3, 'a genuine gate failure carries a status, not a timeout code');
  assert.equal(
    isSpawnTimeout(failErr),
    false,
    'a real non-zero exit must NEVER be re-read as a chunk boundary — that would let a broken build land',
  );

  // Defensive arms: nothing else may pass.
  for (const notATimeout of [undefined, null, {}, { code: 'ENOENT' }, { status: 1 }]) {
    assert.equal(isSpawnTimeout(notATimeout), false);
  }
});
