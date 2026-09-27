// scripts/coord/land/chunk-gate.mjs — plan 3961 T2.0a: the PURE half of the chunk-gate timing
// subsystem (plan 3274/3318/3374/3430/3436), moved out of done-worktree.mjs behaviour-identical.
//
// Every function below is a total function of its own inputs: no fs, no child_process, no git,
// no ambient wtPath-keyed state — only Date.now()/process.uptime()/process.env, taken as
// parameters wherever a caller might want to fake them for a test. That is what makes this half
// Rule-3-clean (scripts/coord/** non-test modules may import only scripts/coord/** and node:
// builtins — assert-scripts-self-contained.mjs:121-128): it needed ZERO injected parameters and
// ZERO non-coord imports.
//
// WHAT IS DELIBERATELY NOT HERE. The IMPURE half of the same subsystem — the no-start sidecar
// read/write, chunkGateStartDecision, activeChunkWallVar, noStartGateResult, batteryRoundGreen,
// scoreChunkRound, the *Safe ledger wrappers, resolveHeadOid, ledgerRemainderCount, LEDGER_CLI —
// stays in done-worktree.mjs. It does real fs/child_process I/O (the no-start tally file, `git
// rev-parse` via worktreeHeadSha, the battery-ledger.mjs CLI via `run`), which conflicts with
// done-worktree-lib.mjs's own "no fs, no child_process" contract just as much as it conflicts
// with Rule 3 here — plan 3961 T3 moves it under scripts/coord/ together with `run`/`DRY`/
// `worktreeHeadSha` once those become injectable parameters rather than spine globals.
//
// done-worktree.mjs imports every export below by name and calls it exactly as before; every
// caller inside the impure half that stayed behind (noStartGateResult → chunkReportDetail,
// activeChunkWallVar → chunkGateConfig, chunkGateStartDecision → chunkCapDecision, both heavy
// gates → roundProvedSomethingNew/BUILD_GATE_TIMEOUT_MS/MOBILE_GATE_TIMEOUT_MS) now reaches these
// core-noun-ok: names the actual exported constants moved by this split, not project prose.
// through that import instead of a same-file reference — same names, same behaviour, addressed
// differently. See the plan body's T2 design / Appendix "Boundary read-off" for the fuller split.

// ── plan 3274: cloud-chunked heavy gates ──────────────────────────────────────────────────────
// Mirrors scripts/hooks/pre-push.sh's own PREPUSH_GATE_CHUNK_S / CLAUDE_CODE_REMOTE precedence —
// the SAME env vocabulary, deliberately, so one knob controls both surfaces. A cloud drain's
// foreground Bash call is capped at 600s and backgrounding a push/land is retired there (plan
// 3248); this land preflight's own heavy gates (a per-file test gate, a second heavy gate) carry
// natural caps of 2400s and up — DERIVED since plan 4034 T3/T4 rather than hard-coded, and derived
// UPWARD from that floor on a contended box — so they exceed that wall by 4x or more. Chunking caps each
// heavy gate BELOW the tool wall, merges whatever the plan-3223 ledger proved before the cap
// fired, and reports a CHUNKED
// (never FAILED) outcome so the SAME cloud invocation can be re-run under the identical content
// key until the ledger is fully green. See runPrepGates for where the ONE per-invocation
// deadline is stamped (D1: never a fresh per-gate wall).
// plan 3430 (D1): 480s is now measured FROM PROCESS START (processStartEpoch below), not from the
// first chunked gate, so it is the budget for EVERYTHING up to and including the chunked gates —
// preflight, build, a project's own second heavy gate, and the two chunked heavy gates. That leaves 120s of head room under
// the 600s Bash tool
// cap for what follows them: `queueEnqueueAndGate`'s enqueue + head-merge bookkeeping (phase 6, the
// only phase after the chunked gates). Kept at 480 deliberately rather than lowered: the anchor is
// what was broken, and re-tuning the number in the same change would confound the two. If 120s later
// proves tight for the post-gate bookkeeping, the fix is THIS default, not the anchor.
const CHUNK_WALL_S_DEFAULT = 480;
const CHUNK_MIN_CHUNK_S_DEFAULT = 60;

// plan 3274 (review round, F2/CONFIRMED): the hook's OWN numeric-validity rule for
// PREPUSH_GATE_CHUNK_S is a digit-only shell case pattern (`'' | *[!0-9]*)` — the whole string
// must be nothing but ASCII digits, then `-gt 0`) — which is BOTH stricter and looser than the
// pre-fix `Number(raw)` this file used: `Number('3.5')`, `Number('0x10')`, and `Number(' 5 ')` are
// all finite and >0 in JS but every one of them hits the hook's `[!0-9]` branch and falls through
// to rule 2, so the same env value could enable chunk mode with a DIFFERENT wall on one surface
// than the other. One parser, reused for PREPUSH_GATE_CHUNK_S / PREPUSH_WALL_S /
// PREPUSH_MIN_CHUNK_S alike, so "non-numeric or non-positive" reads identically everywhere it is
// asked. Returns `null` (never NaN/0/negative) on anything that is not a plain positive integer
// string, so every call site can use `?? <default>` uniformly.
export function parsePrepushPositiveInt(raw) {
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  // plan 3274 (review round, F3/CONFIRMED): the digit-only regex above matches the shell's OWN
  // character class, but not its arithmetic — a long enough run of digits is still "nothing but
  // ASCII digits" while `Number()` of it overflows to `Infinity` (or, below that, silently loses
  // precision). Unchecked, that Infinity flows straight through as `wallS`/`minChunkS`/the D2 wall
  // override — a CAP becoming an UNBOUNDED budget, the opposite of what chunking exists to
  // guarantee. The hook's own `[ "$raw" -gt 0 ]` disagrees with `Number()` here too: past
  // INT64_MAX (9223372036854775807) it errors "integer expression expected" (exit 2) rather than
  // returning true, and that error — inside an `if [ ... ]; then` guard, under `set -e` — reads as
  // the condition being FALSE (measured on this repo's own `sh`: Git Bash on Windows, and every
  // Linux cloud drain), so rule 1 never fires and the caller falls through to its own default
  // exactly as it would for a non-numeric string. Number.isSafeInteger rejects the same direction
  // (too big -> treat as absent) without hand-copying the shell's own INT64 boundary.
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// D2 precedence, highest first: (1) PREPUSH_GATE_CHUNK_S set and numeric > 0 -> ON, and it
// OVERRIDES the wall default outright (mirroring the hook's own `PREPUSH_WALL_S="$PREPUSH_GATE_CHUNK_S"`
// clobber — an explicit PREPUSH_WALL_S is ignored in this branch on BOTH surfaces); (2)
// CLAUDE_CODE_REMOTE non-empty -> ON, with PREPUSH_WALL_S honoured (falling back to the 480s
// default on anything invalid) as the wall; (3) otherwise -> OFF. Every downstream consumer
// treats `enabled: false` (equivalently, a `null` chunkCapMs) as "behave exactly as before this
// plan" — the local byte-identical-behaviour guarantee lives in that default, not in a separate
// code path. PREPUSH_MIN_CHUNK_S is honoured identically regardless of which rule turned chunking
// on — mirroring the hook, which sets it once, unconditionally, before either rule runs (falling
// back to the 60s default on anything invalid). `env` is a parameter (not a bare `process.env`
// read) so this is unit-testable without mutating real process state — the same shape
// batteryLedger.defaultNonTtyReporter's own `version` parameter already uses in this codebase.
// plan 3436 (gpt-review r3 556f27 / a573cf): `wallVar` rides along — WHICH env variable produced
// `wallS`. It is decided here, at the one place that already made the decision, so no caller has to
// re-read the environment to describe it. The r2 round had already established that a second parse
// is the defect (eight finders); this closes the remaining second READ.
export function chunkGateConfig(env = process.env) {
  const minChunkS = parsePrepushPositiveInt(env.PREPUSH_MIN_CHUNK_S) ?? CHUNK_MIN_CHUNK_S_DEFAULT;
  const chunkS = parsePrepushPositiveInt(env.PREPUSH_GATE_CHUNK_S);
  if (chunkS !== null) {
    return {
      enabled: true,
      wallS: chunkS,
      minChunkS,
      wallVar: 'PREPUSH_GATE_CHUNK_S (which is set, and OVERRIDES PREPUSH_WALL_S)',
    };
  }
  if (env.CLAUDE_CODE_REMOTE) {
    const wallS = parsePrepushPositiveInt(env.PREPUSH_WALL_S) ?? CHUNK_WALL_S_DEFAULT;
    return { enabled: true, wallS, minChunkS, wallVar: 'PREPUSH_WALL_S' };
  }
  return { enabled: false, wallS: 0, minChunkS: 0, wallVar: 'PREPUSH_WALL_S' };
}

// plan 3795: decide whether the OPTIONAL pre-queue freshen yields to chunk mode. The freshen is
// opportunistic and the authoritative at-head path redoes its work, so standing down loses only
// the optimisation while preserving the shared chunk wall for the step that can bank progress.
// Plan 3754 measured the failure mode at ~504s of a ~510s wall across four land invocations in two
// cloud drain sessions. The already-computed config is a parameter so this decision stays pure.
export function preQueueFreshenStandDown(chunkCfg) {
  if (chunkCfg.enabled) {
    return {
      standDown: true,
      reason:
        'chunk mode is enabled; the optional freshen yields its shared wall to the authoritative at-head sync',
    };
  }
  return { standDown: false, reason: null };
}

// plan 3274 (follow-up, gap 2): ONE chunk deadline per PROCESS — not per `runPrepGates` call, and
// not per land-path preflight call site. `runPrepGates` runs TWICE inside a single `--prep`
// invocation (the plain pass via `runLandPrepLocked`, then the speculative pass via
// `attemptSpeculativeStack`), and the ordinary (non-`--prep`) land path spends this same wall again
// at its own heavy-gate preflight call sites in `main()` (~:11180 for one, ~:11223 for the other) — a
// fresh `Date.now() + wallS*1000` stamped at each of those independently would let one process spend
// a MULTIPLE of `wallS`, exactly the sum-of-per-gate-walls problem this plan exists to avoid.
// Stamped LAZILY at first use (never eagerly at module load — a process that never reaches a chunked
// gate pays nothing) and cached for the rest of the process. `undefined` = not yet stamped this
// process; `null` = chunking OFF (the same "off" sentinel every other `chunkCapMs`/`deadlineEpoch`
// in this file already uses).
//
// plan 3430 (D1): the stamp is still computed lazily, but it is ANCHORED AT PROCESS START rather
// than at the moment of first use — see processStartEpoch below for why. Lazy-when vs anchored-to
// are independent axes; 3274's "pays nothing" property is about the former and survives untouched.
let _processChunkDeadlineEpoch;

// plan 3430 (gpt-review c63928 / 4f9a15 / fddb47 — three independent angles, one defect): the
// deadline is an EPOCH (that is the exported shape, and what `resetProcessChunkDeadlineForTest`
// injects), but `deadline - Date.now()` measures the remaining budget against an ADJUSTABLE clock.
// A backward wall-clock step mid-land — an NTP correction, a VM resume — inflates the remaining
// budget by exactly the size of the step, so the gate can outlive the 600s tool cap and be killed
// before any `*_CHUNKED` seam speaks: precisely the failure this plan exists to close, arriving by
// another door. `process.uptime()` is monotonic and immune, so the remaining budget is carried
// forward from the stamp instant by MONOTONIC delta instead of re-derived from wall time.
// `undefined` = no stamp-time bookkeeping (the deadline was INJECTED by the test hook rather than
// stamped), in which case `deadline - Date.now()` is the only meaning the injected value can have
// and is used unchanged.
let _processChunkStampUptimeMs;
let _processChunkStampRemainingMs;

// plan 3430 (D1): the wall must cover the WHOLE process, not just the part of it that happens to
// start at the first chunked gate. The land path spends real wall-clock BEFORE it ever reaches a
// chunkable gate — preflight, then the pre-queue build gate, then a project's own pre-queue UI-verification gate
// (done-worktree.mjs sections 2.6 / 2.66, both strictly before the 2.661 and 2.662 heavy gates
// that chunk) — and under 3274 none of it counted. Measured on plan 3393's cloud land (an account,
// session cse_01U1f6FPinkA92XEif9GmJYb): process start 2026-08-23T19:54:20Z, build gate proved
// 19:57:03Z = 163s of uncounted pre-chunk spend. A 480s wall stamped at 19:57:03Z fires 20:05:03Z,
// but the 600s Bash tool cap fires at 20:04:20Z — so the call was KILLED 43s before the mechanism
// designed to save it would have spoken, and the drain took the plan-3248 hand-back instead of the
// re-invoke a *_CHUNKED seam would have told it to take.
//
// `Date.now() - process.uptime()*1000` is the process's own start epoch and is INVARIANT of when it
// is asked (uptime grows exactly as fast as Date.now()), so computing it lazily at the first chunked
// gate yields the same anchor an eager module-load stamp would have — no module-level mutable state,
// and node's own startup + every import is counted too. Both readings are parameters so a test can
// simulate arbitrary pre-gate spend with no real sleep (plan 3430 D4).
export function processStartEpoch(nowMs = Date.now(), uptimeS = process.uptime()) {
  return nowMs - Math.round(uptimeS * 1000);
}

// plan 3430 (gpt-review r2, a8a145 / 7b83da / 7e7bf0 / 844fe2 — four angles, one defect): the ONE
// monotonic "now" every chunk-budget subtraction in this file uses. Making `processChunkCapMsNow`
// monotonic while the two land-path heavy-gate preflight runners still recomputed their own
// elapsed time as `Date.now() - capturedAtMs` left the fix HALF done — a backward clock step there
// re-inflates exactly the budget the deadline just refused to inflate, and a half-monotonic clock
// is worse than an honest wall-clock one because it reads as fixed. Milliseconds since process
// start; only ever meaningful as a DIFFERENCE between two readings, never as an epoch.
export function monotonicNowMs() {
  return Math.round(process.uptime() * 1000);
}

// `chunkCfg` is a parameter (not a bare `chunkGateConfig()` call inside) so a caller that already
// computed it once this tick does not pay for a second `process.env` read — mirrors
// `chunkGateConfig`'s own injectable-`env` shape. Exported (like chunkGateConfig/chunkCapDecision)
// so the memoization itself is directly unit-testable without spawning a subprocess per "process".
// `startEpoch` (plan 3430) is optional and test-only: omitted, the real process start is used, and
// it is read ONLY on the stamping call, so a cached deadline still costs nothing.
export function processChunkDeadlineEpoch(chunkCfg, startEpoch) {
  if (_processChunkDeadlineEpoch === undefined) {
    if (chunkCfg.enabled) {
      // gpt-review r3 73ff25/CONFIRMED: read each clock EXACTLY ONCE and derive all three values
      // from that one pair. The first cut called `Date.now()` twice (once inside processStartEpoch,
      // once for the remaining-budget starting value) and `process.uptime()` twice, leaving a
      // window — however small — in which a clock correction lands between them and the initial
      // budget disagrees with
      // the monotonic origin it is measured from ever after. One read each closes the window by
      // construction rather than by arguing the window is too small to matter.
      const nowMs = Date.now();
      const uptimeMs = monotonicNowMs();
      _processChunkDeadlineEpoch =
        (startEpoch ?? processStartEpoch(nowMs, uptimeMs / 1000)) + chunkCfg.wallS * 1000;
      // The pair defines "how much budget was left at a known monotonic moment" — see the two
      // declarations above.
      _processChunkStampUptimeMs = uptimeMs;
      _processChunkStampRemainingMs = _processChunkDeadlineEpoch - nowMs;
    } else {
      _processChunkDeadlineEpoch = null;
    }
  }
  return _processChunkDeadlineEpoch;
}

// The remaining-budget snapshot every consumer (both `runPrepGates` passes, both land-path preflight
// call sites) takes FRESH immediately before its own gate starts — never once up front — so an
// earlier gate's real wall-clock spend, anywhere in the process, is reflected in a later gate's cap.
// plan 3430: measured by MONOTONIC delta from the stamp instant, never `deadline - Date.now()` — a
// backward clock step would otherwise hand the gate back budget it has already spent.
export function processChunkCapMsNow(chunkCfg, startEpoch) {
  const deadline = processChunkDeadlineEpoch(chunkCfg, startEpoch);
  if (deadline === null) return null;
  if (_processChunkStampRemainingMs === undefined) return deadline - Date.now();
  const elapsedMs = Math.round(process.uptime() * 1000) - _processChunkStampUptimeMs;
  return _processChunkStampRemainingMs - elapsedMs;
}

// Test-only hook. `undefined` (the default) clears the stamp so the NEXT consumer re-derives it —
// simulating a fresh process; an explicit epoch (or `null`) injects that exact value so a test can
// assert a LATER consumer sees a reduced (or zero) budget without a real sleep. Never called outside
// this module's own test suite. The plan-3430 monotonic bookkeeping is cleared either way: an
// INJECTED deadline has no stamp instant to measure from, so `processChunkCapMsNow` falls back to
// `deadline - Date.now()` — which is exactly what an injected epoch is asserting about.
export function resetProcessChunkDeadlineForTest(epoch = undefined) {
  _processChunkDeadlineEpoch = epoch;
  _processChunkStampUptimeMs = undefined;
  _processChunkStampRemainingMs = undefined;
}

// plan 3274 (gap 1): the ONE {chunkCapMs, minChunkS} pair BOTH ordinary land-preflight call sites
// (the two land-path preflight gates, in main() below) pass into their respective *Cached wrapper — an immediate
// snapshot (not a deferred closure like runPrepGates' own `chunkCapMsNow`, which must re-read at
// each gate's own start time because it runs a LOOP of gates; these two call sites each invoke
// exactly one gate, so one snapshot suffices) sourced from the SAME shared per-process deadline
// (gap 2: processChunkDeadlineEpoch). One function, one place this composition is written, so the
// two call sites cannot drift from each other or from runPrepGates' own shape — and so this exact
// composition is directly unit-testable as the one thing that makes the cloud land path "honour the
// cap".
export function landPreflightChunkOptions(env = process.env) {
  const chunkCfg = chunkGateConfig(env);
  return { chunkCapMs: processChunkCapMsNow(chunkCfg), minChunkS: chunkCfg.minChunkS };
}

// plan 3436 D1: OUR OWN `execFileSync` `timeout` firing, told apart from every other way a gate can
// throw. `e.code === 'ETIMEDOUT'` is this repo's established idiom for exactly this question
// (cloud-checkout-preflight.mjs's unshallow bound, done-worktree-lib.mjs's batteryLockAcquireOutcome)
// — a real timeout kill reports it, while a non-zero exit from the gate itself reports `status`.
// This distinction is the whole of D1's safety: only a timeout under a STRICTLY reduced cap may be
// re-read as partial progress, and everything else stays the gate failure it always was.
// Exported (like chunkCapDecision / chunkGateStartDecision / noStartGateResult) because the whole of
// D1's safety rests on this ONE predicate: get it wrong in the permissive direction and a genuine
// build break is re-read as "partial progress, re-invoke" and never blocks a land. The shape is
// pinned empirically in done-worktree.test.mjs against a real spawn on the running node, not
// asserted from memory.
export function isSpawnTimeout(e) {
  return Boolean(e) && e.code === 'ETIMEDOUT';
}

// plan 3436 D1: the two pre-gate phases' natural caps, named rather than inlined so the number the
// chunk cap is compared against (`usingChunkCap` is "strictly smaller than the natural cap") is one
// value per gate rather than a literal repeated at the spawn and at the decision.
export const BUILD_GATE_TIMEOUT_MS = 600_000;
export const MOBILE_GATE_TIMEOUT_MS = 600_000;

// D1: `chunkCapMs` is a snapshot of `deadlineEpoch - now`, taken FRESH by the caller (runPrepGates'
// own runner closures) immediately before invoking a heavy gate — never re-derived inside this
// function. `null`/`undefined` means chunking is off for THIS call: either D2 decided OFF, or the
// caller deliberately never opts in (e.g. the --deploy pre-deploy wall's direct, un-cached call —
// plan 3223's own hard-wall carve-out, "must physically re-run every time", preserved verbatim by
// simply never threading chunkCapMs into that call site). A remaining budget under `minChunkS`
// refuses to even start the gate (zero progress, cheap) rather than spawn something with no
// realistic chance of finishing before the deadline anyway.
export function chunkCapDecision({ chunkCapMs, minChunkS, naturalTimeoutMs }) {
  if (chunkCapMs === null || chunkCapMs === undefined) {
    return { shouldRun: true, effectiveTimeoutMs: naturalTimeoutMs, usingChunkCap: false };
  }
  if (chunkCapMs / 1000 < minChunkS) {
    return { shouldRun: false, effectiveTimeoutMs: 0, usingChunkCap: true };
  }
  const effectiveTimeoutMs = Math.min(naturalTimeoutMs, Math.max(0, chunkCapMs));
  // Only a STRICTLY smaller effective cap means OUR cap is what would fire on a timeout — if the
  // remaining budget still exceeds the gate's own natural cap, a timeout there is the gate's
  // ordinary (real) cap firing, not a chunk boundary, and must keep reading as a genuine failure.
  return {
    shouldRun: true,
    effectiveTimeoutMs,
    usingChunkCap: effectiveTimeoutMs < naturalTimeoutMs,
  };
}

// plan 3274 (review round, F3/CONFIRMED): "how much of a chunk-cap snapshot is left after some
// elapsed real wall-clock time" — the two land-path preflight gate runners each snapshot
// `chunkCapMs` at function entry, then spend real time on preparation before their actual run
// starts (ledger carry-forward, the battery-lock mutex wait, the queued-run.mjs ticket wait) — time
// that must come OUT of the run's own budget, never be silently donated to it. Pulled out as its
// own pure function (rather than inlined identically in both call sites) so the exact-subtraction
// arithmetic is directly unit-testable without a real timer or a real ledger/mutex/queue wait.
// Exact, because `chunkCapMs` IS `deadlineEpoch - captureTime` (see processChunkCapMsNow), so
// `deadlineEpoch - now` — the true remaining budget right now — equals
// `chunkCapMs - (now - captureTime)`, i.e. `chunkCapMs - elapsedMs`. `null` (chunking off) stays
// `null` regardless of elapsed time, mirroring every other chunkCapMs consumer's off-sentinel.
export function chunkCapMsAfterElapsed(chunkCapMs, elapsedMs) {
  return chunkCapMs === null ? null : chunkCapMs - elapsedMs;
}

// D3: the ONE chunk-report string builder, three shapes:
//   - not started at all (`started: false`) — zero progress; names the gate and the budget
//     shortfall rather than a fabricated count.
//   - started and the counts are known (proven/total/remaining all integers) — the exact
//     "N of M ... R remaining" shape the plan's own D3 mandates, verbatim.
//   - started but the counts could not be determined this attempt (e.g. a test runner killed before its
//     own collection phase flushed a single `collect` event) — degrades honestly instead of
//     printing a fabricated number; the on-disk ledger still carries whatever WAS proven,
//     unaffected by this branch.
// Always distinguishable from a real gate failure by the leading "CHUNKED (not a test failure)".
// plan 3318 (gpt-review, angle-A/angle-B/angle-P/writer-trace — four finders, one defect): the
// value for `GATE_LEDGER_CHUNK_CAP_S`, ALWAYS computed and ALWAYS set, never conditionally
// spread. A conditional spread over `process.env` leaves an AMBIENT value standing on an uncapped
// run — and the plugin reads that variable as "this run cannot finish a `slow` file, drop it", so
// an inherited leftover would silently narrow a gate nobody capped. `''` reads as uncapped
// (`_chunk_cap_seconds` parses non-positive/unparseable as 0.0), so pinning the empty sentinel is
// the same "pin it after the spread so a caller cannot hand it back in" discipline
// `dryRunEnvNoDeployCredentials` uses in the tests.
export function chunkCapEnvValue(runCap) {
  return runCap?.usingChunkCap && Number.isFinite(runCap.effectiveTimeoutMs)
    ? String(Math.floor(runCap.effectiveTimeoutMs / 1000))
    : '';
}

export function chunkReportDetail({
  gate,
  key,
  started = true,
  proven,
  total,
  remaining,
  secondsLeft = 0,
  minChunkS = 0,
  stalledFile = null,
}) {
  const prefix = `${gate} gate: CHUNKED (not a test failure): `;
  // plan 3318: name the file the cap killed this attempt INSIDE, when the events say which. The
  // ledger's unit is the FILE, so an attempt killed mid-file records nothing for it — which is
  // what an over-wall file looks like from the outside, and what three measured lands mistook for
  // "the ledger does not resume". Ordering now moves such a file last, so the NEXT chunk still
  // makes progress; if the same name keeps coming back with no count movement, that file's own
  // wall exceeds the chunk wall and the remedy is marking it as a slow test (whichever mechanism
  // this gate's own test runner supports) on it, not another chunk.
  const stalled =
    typeof stalledFile === 'string' && stalledFile
      ? ` The cap fired while running ${stalledFile} (no test in it finished, so it proved nothing` +
        ` — it now sorts LAST in the remainder; if it keeps stalling, mark it \`slow\`).`
      : '';
  const suffix = stalled + ' Re-invoke done-worktree to continue — no rebase, no --no-verify.';
  if (!started) {
    return (
      prefix +
      `only ${Math.max(0, Math.round(secondsLeft))}s left in this invocation's chunk budget ` +
      `(needs >= ${minChunkS}s) — ${gate} did not start this attempt, no new progress.` +
      suffix
    );
  }
  if (Number.isInteger(proven) && Number.isInteger(total) && Number.isInteger(remaining)) {
    return (
      prefix +
      `${proven} of ${total} files proven green under key ${key}, ${remaining} remaining.` +
      suffix
    );
  }
  return (
    prefix +
    `hit its chunk cap under key ${key} before proven/remaining counts could be determined — ` +
    `the on-disk ledger already carries whatever this attempt proved.` +
    suffix
  );
}

// ── plan 3374: the non-convergent chunk round ──────────────────────────────────────────────────
//
// `chunkReportDetail` above says "Re-invoke done-worktree to continue", which is true for a round
// that made progress and a lie for one that cannot. This is the same builder for the case where the
// promise has provably run out: NON_CONVERGENT_ROUNDS consecutive chunk-capped rounds that each ran
// and each proved ZERO new files. It never says "re-invoke to continue" — the whole defect plan 3374
// closes is that an infinite loop was indistinguishable from healthy chunking — and it NAMES the
// head file, because that file is the entire remedy.
//
// `headFile` is the gate's own best answer for "what is absorbing every round": one gate's stalled
// file (from its ledger events), or the other gate's single remaining file. Null when the gate could
// not determine one — the seam still fires (the zero-progress evidence is what fires it, not the
// name) and says so honestly rather than inventing a filename.
//
// gpt-review 1d9162/db3ee6/5fc6a4/42be85/eaeff3/806a19 — SIX finders, one defect: the remedy used to
// be a single hardcoded slow-test-marker sentence for both gates. A `node --test` file cannot carry
// the other gate's own slow-test marker, so that half was being handed an instruction that does not
// exist, on the one surface whose whole job is telling an operator what to do next.
//
// plan 3961 T3.5b: that fix first shipped as an internal branch keyed on one gate's own literal
// name, which put a host-specific test-marker string inside this otherwise-generic core module —
// the same coupling registry.test.mjs's T2.10 closing sweep already tracked as a known finding
// pending this carve. `remedy` is now the caller's OWN sentence, supplied as a plain string: this
// builder stays gate-AGNOSTIC (decision D4 — one exit code, one classification) and no longer
// knows what either gate even is — only `gate` (used for the report's opening label) still carries
// the caller's own name for itself.
export function nonConvergentReportDetail({
  gate,
  key,
  rounds,
  headFile = null,
  remaining,
  remedy,
}) {
  const named =
    typeof headFile === 'string' && headFile
      ? `${headFile} cannot finish inside one chunk wall`
      : `a file in the remainder cannot finish inside one chunk wall (this gate could not name ` +
        `which — its events carried no in-flight file)`;
  const left = Number.isInteger(remaining) ? ` ${remaining} file(s) still unproven.` : '';
  return (
    `${gate} gate: NON-CONVERGENT (not a test failure, and not ordinary chunking): ` +
    `${named}. The last ${rounds} chunk-capped rounds under key ${key} each ran and each proved ` +
    `ZERO new files, so re-invoking cannot make progress — every further round would re-enter the ` +
    `same file and report CHUNKED again.${left} The remedy is a COMMIT, not another round: ` +
    `${remedy}. Re-invoke only AFTER that commit — a bare re-invoke against this same tip ` +
    `reproduces this exact result.`
  );
}

// plan 4133 S3: no legitimate suite file this module's own ledger tracks lives under a `.scratch/`
// tree — it is session scratch (see the repo's output-layout contract), never a real suite path.
// Plan 3529 (2026-08-30, docs/handoff/infra-debt.md) found this module's own test suite's transient
// noop fixtures (`.scratch/<a self-test's own tmp dir>/noop-*/test_a.py`) reaching a REAL production
// ledger and padding the green count every round, which masked a genuine zero-progress stall as
// "growing" for six consecutive re-invokes and kept `GATE_NON_CONVERGENT` from ever firing. Gate-
// agnostic by construction (this module carries no project- or gate-specific literal — see the test
// below pinning that): filtering here makes the scorer robust to the whole CLASS of fixture-noise
// leak, not just that one instance — whatever else ever writes a `.scratch/**` path into a real
// ledger, under ANY caller, it can never again read as progress. Checked on both separators since a
// path can arrive of either shape (a Windows-authored ledger entry, a literal backslash inside an
// otherwise-POSIX string, …), so both separators split the path here rather than a path-object
// parse (which would resolve only the HOST's separator and miss the other spelling entirely).
//
// Matched as a whole path COMPONENT, never as a bare substring (review round 1): `includes('.scratch/')`
// also swallows a legitimate suite path whose own directory merely ENDS in `.scratch`
// (`vendor/tool.scratch/test_a.py`), and silently dropping a real file from the progress comparison
// would re-open exactly the blindness this filter exists to close — a round that proved only such
// files would score zero-progress and trip GATE_NON_CONVERGENT against a land that was in fact
// progressing. Filtering must stay strictly narrower than "looks scratch-ish".
function isScratchPath(path) {
  if (typeof path !== 'string') return false;
  return path.split(/[/\\]/).includes('.scratch');
}

export function roundProvedSomethingNew(roundGreen, greenBefore) {
  if (!roundGreen) return false;
  for (const f of roundGreen) if (!isScratchPath(f) && !greenBefore.has(f)) return true;
  return false;
}
