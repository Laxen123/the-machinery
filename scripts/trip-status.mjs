#!/usr/bin/env node
// scripts/trip-status.mjs  (plan 2679)
//
// The waiting-trip/ release valve: waiting-trip/ was the one waiting-* lane with
// no tracked release valve (docs/coord/plan-lanes.md § waiting-trip) — the
// board-pass Phase-1 "evaluate each trip condition as far as it is cheaply
// checkable" line was an eyeball pass that only ran when a board-pass happened
// to run. This script gives it a machine-checkable, read-only status table.
//
// Source of truth is a `tripCheck:` frontmatter marker on each waiting-trip
// plan, two forms:
//   tripCheck: manual — <who would observe it, where>
//   tripCheck: '<shell command>'   — exit 0 = TRIPPED, exit 1 = quiet,
//                                    exit >=2 / timeout = probe error.
// See docs/coord/plan-lanes.md § waiting-trip for the full convention.
//
// Why tripCheck is parsed LOCALLY here rather than via build-index-lib's
// readFrontmatterScalar: that shared reader strips a trailing ` #...` inline
// YAML comment (plan 1292), which is the right behaviour for a stamp like
// `execModel: fable # note` — but a `tripCheck:` shell-command value can
// legitimately CONTAIN a literal `#` inside its quotes (e.g. plan 1955's
// `grep "#usercentrics-root"`), and the shared strip has no way to tell that
// apart from a real trailing comment. Re-deriving a comment-stripping heuristic
// that also has to special-case quoted `#` is worse than just not stripping at
// all: this reader takes the whole rest-of-line after `tripCheck:`, then
// unquotes it (single- or double-quoted YAML scalar) with no comment handling —
// exactly what a single-line YAML scalar reader needs and no more.
//
// Enumeration is depth-transparent (plan 2678's walkPlanStatusDir), so a
// waiting-trip/<category>/ clump (if one is ever created) is still seen.
//
// Usage: node scripts/trip-status.mjs
// Exit code: non-zero iff >=1 plan verdict is TRIPPED (so callers/CI can gate on it).

import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkPlanStatusDir, frontmatterEnd, unquoteYaml } from './coord/build-index-lib.mjs';
import { shExe, shellEnv } from './coord/sh-exec.mjs';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const STATUS_FOLDER = 'waiting-trip';

// Hard timeout for a command-form probe (execution notes: ~90s hard cap; a
// corpus grep may stretch close to it, a timeout is NEVER treated as tripped).
export const PROBE_TIMEOUT_MS = 90_000;

// A plan may override PROBE_TIMEOUT_MS per-probe via `tripCheckTimeoutMs:`
// frontmatter (plan 3540) — bounded on both ends so an unbounded stamp can
// never turn one slow plan into an unbounded board-pass, and so a stamp of
// a few ms (typo, or a copy-paste of an unrelated ms value) can never shrink
// a probe below the point where ordinary disk/scheduler jitter makes ANY
// verdict meaningless.
export const TRIP_CHECK_TIMEOUT_CEILING_MS = 600_000;
export const TRIP_CHECK_TIMEOUT_FLOOR_MS = 1_000;

// Wall-clock ceiling across the WHOLE buildReport table (plan 3540). Probes
// run sequentially (see buildReport's `.map` below), so this is what actually
// bounds one board-pass's run time regardless of how generous any single
// plan's tripCheckTimeoutMs override is. Manual/none/gone rows cost nothing
// and are never counted against it.
export const TOTAL_RUN_BUDGET_MS = 900_000;

// The manual form is `manual — <who would observe it, where>`.
//
// Two failure modes bound this regex from opposite sides, and BOTH were review
// findings on this plan:
//   - too loose (`/^manual\b/i`): a command-form value whose first token merely
//     STARTS with the word — `manual-mode.sh check` — was classified manual, so
//     the probe never ran and its trip could never fire.
//   - too tight (a whitelist of `—`/`–`/` - `/end): a human-observed marker
//     written with any other separator — `manual: <who>`, `manual, <who>` — fell
//     through to the command form and got handed to `sh -c`, rendering a
//     misleading `⚠ probe-error` instead of `manual`.
// So: match `manual` only when it is followed by end-of-value or an actual
// SEPARATOR — a dash (em/en, or an ASCII hyphen delimited by whitespace so a
// `manual-mode.sh` path is not one) or `:`/`,`/`;`. Requiring a separator rather
// than mere whitespace is what keeps `manual sync-check.sh --verify` a COMMAND
// (the silent-skip direction); allowing zero whitespace before the dash is what
// keeps `manual—<who>` MANUAL (the misleading-probe-error direction). Both
// directions are pinned by tests — this regex is the union of the two bounds,
// not another guess at one of them.
const MANUAL_RX = /^manual(?:$|\s*[—–:,;]|\s+-\s)/i;

// --- tripCheck frontmatter parsing -----------------------------------------

// Extract the raw `tripCheck:` scalar from a plan's frontmatter, or null if the
// plan has no frontmatter block / no tripCheck key. Deliberately does NOT use
// build-index-lib's readFrontmatterKey/readFrontmatterScalar — see file header.
export function readTripCheckRaw(content) {
  const lines = content.split(/\r?\n/);
  const end = frontmatterEnd(lines);
  if (end === -1) return null;
  const rx = /^tripCheck:\s*(.*)$/;
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(rx);
    if (m) return m[1].replace(/\s+$/, '');
  }
  return null;
}

// Unquote a single-line YAML scalar — single-quoted ('' → ') or double-quoted
// (\" → ", \\ → \) — with NO comment stripping (see file header). An unquoted
// value (the `manual — ...` form) passes through unchanged.
//
// This is build-index-lib's `unquoteYaml` verbatim, re-exported under the local
// name rather than re-implemented: the file header's argument for parsing
// `tripCheck:` locally is about readFrontmatterScalar's COMMENT-STRIP, not about
// the quote rule, so keeping a second copy of the quote rule would let the two
// drift on a future YAML edge-case fix (plan 2679 review finding).
export const unquoteTripCheckValue = unquoteYaml;

// Parse a plan's tripCheck marker into { kind, command }:
//   kind: 'none'    — no tripCheck: key at all (∅ no-marker)
//   kind: 'manual'  — human-observed trip, never executed
//   kind: 'command' — shell command form, `command` holds the raw string to
//                      run via `sh -c` AS-IS (no re-quoting — execution notes)
export function parseTripCheck(content) {
  const raw = readTripCheckRaw(content);
  if (raw === null || raw.trim() === '') return { kind: 'none', command: null };
  const value = unquoteTripCheckValue(raw.trim());
  if (value === '' || MANUAL_RX.test(value)) return { kind: 'manual', command: null };
  return { kind: 'command', command: value };
}

// --- tripCheckTimeoutMs frontmatter parsing (plan 3540) ---------------------

// Extract the raw `tripCheckTimeoutMs:` scalar, same local-reader style as
// readTripCheckRaw above (see the file header for why this module does not
// use build-index-lib's comment-stripping readFrontmatterScalar) — null if
// the plan has no frontmatter block / no tripCheckTimeoutMs key.
export function readTripCheckTimeoutMsRaw(content) {
  const lines = content.split(/\r?\n/);
  const end = frontmatterEnd(lines);
  if (end === -1) return null;
  const rx = /^tripCheckTimeoutMs:\s*(.*)$/;
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(rx);
    if (m) return m[1].replace(/\s+$/, '');
  }
  return null;
}

// Parse a raw tripCheckTimeoutMs scalar into an effective, clamped budget in
// ms. `raw` is whatever readTripCheckTimeoutMsRaw returned (null/absent, or a
// string that may itself be YAML-quoted). Never throws — matching the
// existing `gone`-row tolerance (buildReport below): a malformed stamp on ONE
// plan must never crash the whole table. A non-integer / negative / NaN /
// non-numeric value falls back to `defaultMs` silently (it is not a value we
// can honour at all, so there is nothing useful to warn about); an
// in-range-but-out-of-bounds INTEGER is clamped to the ceiling/floor and DOES
// warn on stderr, because that value was almost honoured and the operator
// should know their stamp was not taken literally.
export function parseTripCheckTimeoutMs(
  raw,
  {
    defaultMs = PROBE_TIMEOUT_MS,
    ceilingMs = TRIP_CHECK_TIMEOUT_CEILING_MS,
    floorMs = TRIP_CHECK_TIMEOUT_FLOOR_MS,
    warn = (msg) => process.stderr.write(`${msg}\n`),
    label = '?',
  } = {},
) {
  if (raw === null) return defaultMs;
  const trimmed = raw.trim();
  if (trimmed === '') return defaultMs;
  // Strip a trailing YAML inline comment BEFORE unquoting. This is the one
  // place in this module where comment-stripping is correct, and the file
  // header's argument for NOT stripping is exactly what makes it so: that
  // argument is about `tripCheck:`, whose shell-command value can legitimately
  // contain a literal `#` (plan 1955's `grep "#usercentrics-root"`). This
  // value is an INTEGER — a `#` can never be part of one — so there is no
  // ambiguity to preserve, and refusing to strip only means the form the
  // runbook itself documents (`tripCheckTimeoutMs: 300000 # …`) fails the
  // digits test and falls back to the default SILENTLY (review finding,
  // plan 3540).
  //
  // The `\s` (or start-of-scalar) prefix is YAML's actual comment rule, not a
  // nicety: a bare /#.*$/ would also strip the tail of `300000#tight`, which
  // YAML reads as the single scalar "300000#tight" — malformed for an integer
  // field. Stripping it there would silently ACCEPT a typo as 300000 instead
  // of falling back to the default. `[ \t]` rather than `\s` because YAML's
  // whitespace is exactly space and tab — JS's `\s` also matches NBSP and the
  // Unicode spaces, which YAML does NOT treat as a comment separator, so a
  // `\s` here would strip (and thereby silently accept) `300000 #typo`.
  const value = unquoteTripCheckValue(trimmed.replace(/(^|[ \t])#.*$/, '$1').trim()).trim();
  // Non-negative integers only — a leading '-', a decimal point, or any
  // non-digit content (including things like "1e5") is treated as malformed
  // rather than coerced, since Number() would silently accept several shapes
  // no one intends as a millisecond count.
  if (!/^\d+$/.test(value)) return defaultMs;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return defaultMs;
  if (n > ceilingMs) {
    warn(
      `trip-status: ${label} tripCheckTimeoutMs=${n}ms exceeds the ${ceilingMs}ms ceiling — clamped to ${ceilingMs}ms`,
    );
    return ceilingMs;
  }
  if (n < floorMs) {
    warn(
      `trip-status: ${label} tripCheckTimeoutMs=${n}ms is below the ${floorMs}ms floor — clamped to ${floorMs}ms`,
    );
    return floorMs;
  }
  return n;
}

// Read + parse in one call — what buildReport actually uses per command-form
// row. `defaultMs` is the effective run-wide default (PROBE_TIMEOUT_MS, or
// whatever --timeout-ms set it to) so a plan with no override still respects
// a board-pass's ad-hoc re-probe.
export function resolveTripCheckTimeoutMs(content, opts = {}) {
  return parseTripCheckTimeoutMs(readTripCheckTimeoutMsRaw(content), opts);
}

// --- probe execution ---------------------------------------------------------

// Run a command-form tripCheck via `sh -c <command>`, cwd = repo root, hard
// timeout. Returns { verdict, ms }. `exec` is an injected spawnSync-alike seam
// (real default: node:child_process.spawnSync) so tests never run a real
// tripCheck command — and shell RESOLUTION follows the same seam: it is skipped
// entirely when `exec` is injected, since nothing is launched then. Resolving
// anyway would make a deterministic unit test pay real spawns, and would spend
// the resolver's probe budget OUTSIDE the timeout this function advertises.
// exit 0 = TRIPPED, exit 1 = quiet, exit >=2 = probe-error, spawn failure =
// probe-error, killed-by-signal SPLITS into `timeout` (our own budget kill)
// vs `error` (anything else) — see the signal-handling comment below. Never
// TRIPPED on ambiguity.
//
// `now` is an injectable clock seam (real default: Date.now), threaded
// alongside `exec` (plan 3540): it lets a test drive "elapsed vs budget"
// exactly, without paying a real spawn/sleep to manufacture a genuine
// timeout. The real default behaviour (Date.now on both ends) is unchanged.
export function runProbe(
  command,
  { cwd = REPO_ROOT, timeoutMs = PROBE_TIMEOUT_MS, exec = spawnSync, now = Date.now } = {},
) {
  const start = now();
  const real = exec === spawnSync;
  let result;
  try {
    // killSignal: SIGKILL — spawnSync's DEFAULT timeout kill is SIGTERM, which a
    // command that traps/ignores it simply survives; spawnSync then blocks the
    // whole process forever and board-pass hangs well past the ~90s this module
    // and the runbook both advertise as a HARD cap (plan 2679 review finding).
    // SIGKILL is uncatchable, so the cap is real.
    // shExe()/shellEnv() rather than a bare 'sh' (plan 3219): a bare name resolves only
    // under Git Bash, so a board-pass driven from the PowerShell tool spawn-errored on
    // EVERY probe and reported a whole lane of `⚠ probe-error` in ~3ms — indistinguishable
    // from an all-quiet run (infra-debt 2026-08-04).
    result = exec(real ? shExe() : 'sh', ['-c', command], {
      cwd,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      env: real ? shellEnv() : process.env,
    });
  } catch {
    return { verdict: 'error', ms: now() - start };
  }
  const ms = now() - start;
  if (!result) return { verdict: 'error', ms };
  if (result.error) {
    // Node reports spawnSync's OWN timeout kill in TWO fields at once: it sets
    // `error` to an ETIMEDOUT Error *and* `signal` to killSignal. So the
    // generic `result.error → error` branch has to test the ETIMEDOUT code
    // FIRST, or the timeout verdict below is unreachable in production even
    // though a signal-only fake exec makes it look reachable in tests — the
    // bug measured 2026-08-30 during this plan's own acceptance run, where
    // `--timeout-ms 2000` killed plan 3302's probe at 2003ms and still
    // rendered `⚠ probe-error`. The ETIMEDOUT code is Node stating it fired
    // the timeout itself, which is stronger evidence than either the signal
    // name or the clock, so it needs no elapsed corroboration. Any OTHER
    // error code (a spawn failure: ENOENT, EACCES, …) is a genuine
    // probe-error no matter how long the machine took to report it.
    return { verdict: result.error.code === 'ETIMEDOUT' ? 'timeout' : 'error', ms };
  }
  if (result.signal) {
    // spawnSync's OWN timeout kill uses `killSignal: 'SIGKILL'` — the SAME
    // signal an external killer (an operator's `kill -9`, an OOM killer) would
    // use — so the signal name alone can never tell "we timed out" from
    // "something else killed it" (plan 3540). Elapsed-vs-budget is the honest
    // discriminator: OUR timeout kill cannot fire before `timeoutMs` has
    // elapsed, so `ms >= timeoutMs` means we did it; anything killed faster
    // than our own budget was killed by something else and is a genuine
    // probe-error, not a "needed more time".
    return { verdict: ms >= timeoutMs ? 'timeout' : 'error', ms };
  }
  const status = result.status;
  if (status === 0) return { verdict: 'tripped', ms };
  if (status === 1) return { verdict: 'quiet', ms };
  return { verdict: 'error', ms };
}

// --- plan enumeration ---------------------------------------------------------

// readdir seam matching the ENOENT/ENOTDIR-tolerant pattern queue-drain.mjs
// uses for walkPlanStatusDir (docs/superpowers/plans/<status>/[<category>/]):
// a missing category subfolder (a parallel session mid-move-plan) is tolerated
// (empty listing) EXCEPT at the top level, which always throws. `readdirImpl`
// is injectable (defaults to the real fs) so this tolerance itself is
// unit-testable without touching a real filesystem.
// THE one definition of "this fs error is a parallel-session move race, not a
// real fault" for this module. Both race-tolerant seams below (the directory
// walk and buildReport's per-file read) go through it, so a future change to
// the errno set — another platform's code, or narrowing it after an incident —
// can never be applied to one seam and silently missed on the other, which
// would reintroduce the crash-the-whole-report bug on whichever seam was
// forgotten (plan 2679 review finding).
export function isMoveRaceErrno(e) {
  const code = (e && e.code) || 'UNKNOWN';
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function makeStatusReaddir(statusDir, readdirImpl = readdirSync) {
  return (segments) => {
    try {
      return readdirImpl(join(statusDir, ...segments), { withFileTypes: true });
    } catch (e) {
      if (segments.length && isMoveRaceErrno(e)) return [];
      throw e;
    }
  };
}

// List every waiting-trip plan as { id, slug, rel } (rel is repo-root-relative,
// so a caller can readFileSync it directly). `readdir`/`readFile` are injected
// seams (tests pass a fake corpus; the real CLI passes fs-backed defaults).
export function listWaitingTripPlans({
  plansRoot = 'docs/superpowers/plans',
  statusDir = join(REPO_ROOT, plansRoot, STATUS_FOLDER),
  readdir = makeStatusReaddir(statusDir),
} = {}) {
  const entries = walkPlanStatusDir({ statusFolder: STATUS_FOLDER, readdir });
  return entries.map(({ basename, relInStatus }) => {
    const m = basename.match(/^(\d{3,})-(.+)\.md$/);
    const id = m ? m[1] : '???';
    const slug = m ? m[2] : basename.replace(/\.md$/, '');
    // rel is a repo-root-relative POSIX path (walkPlanStatusDir already emits
    // forward-slash relInStatus) — path.join would rewrite it with backslashes
    // on Windows and break every consumer that compares or displays it.
    return { id, slug, rel: [plansRoot, STATUS_FOLDER, relInStatus].join('/') };
  });
}

// --- report building -----------------------------------------------------

const VERDICT_LABEL = {
  tripped: '🔔 TRIPPED',
  quiet: 'quiet',
  manual: 'manual',
  error: '⚠ probe-error',
  // Split out of `error` by plan 3540: this row's probe was killed by OUR OWN
  // timeout budget (the run-wide default, a --timeout-ms override, or the
  // plan's own tripCheckTimeoutMs: stamp) — the command itself is not known
  // to be broken, it just needed more time than the budget allowed.
  timeout: '⏱ probe-timeout',
  none: '∅ no-marker',
  // Moved out of waiting-trip/ by a parallel session while this run was reading
  // the lane — not a trip verdict, just a row whose plan is no longer here.
  gone: '↷ moved (re-read)',
  // The total-run wall-clock budget (plan 3540) was already spent by earlier
  // rows in this table before this row's turn came up — its probe was never
  // run at all, so this is not a verdict about the command, only about the
  // budget. Manual/none/gone rows are never charged against the budget.
  budgetExhausted: '∅ budget-exhausted',
};

// Build the full status report. `readFile(rel)` and `exec` are injected seams
// (see runProbe/listWaitingTripPlans) so this is fully testable without a real
// filesystem or a real shell. Rows are sorted by numeric plan id for a stable,
// reproducible table (parallel-session filesystem ordering is not a contract).
//
// `timeoutMs` is the run-wide DEFAULT per-probe budget (PROBE_TIMEOUT_MS,
// or a --timeout-ms override) — a plan's own tripCheckTimeoutMs: stamp, when
// present, takes priority over it (see resolveTripCheckTimeoutMs above).
// `totalBudgetMs` is the wall-clock ceiling across the WHOLE table (plan
// 3540): probes run sequentially, so once it is spent, remaining
// command-form rows are never run and report `budgetExhausted` instead of a
// fake verdict. `now` is the same injectable clock seam runProbe takes,
// threaded through here so a test can drive both the total-budget check and
// every probe's own elapsed time from one deterministic source.
export function buildReport({
  plans = listWaitingTripPlans(),
  readFile = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8'),
  exec = spawnSync,
  timeoutMs = PROBE_TIMEOUT_MS,
  totalBudgetMs = TOTAL_RUN_BUDGET_MS,
  now = Date.now,
  ceilingMs = TRIP_CHECK_TIMEOUT_CEILING_MS,
  floorMs = TRIP_CHECK_TIMEOUT_FLOOR_MS,
  warn = (msg) => process.stderr.write(`${msg}\n`),
} = {}) {
  const runStart = now();
  const rows = plans
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id) || a.slug.localeCompare(b.slug))
    .map(({ id, slug, rel }) => {
      // A plan can be `git mv`d OUT of waiting-trip/ between the readdir above
      // and this read — a routine race in a 5-7-parallel-session repo (another
      // session's move-plan.mjs promoting exactly this plan). makeStatusReaddir
      // already tolerates that race at the DIRECTORY level; without the same
      // tolerance here an ENOENT escaped uncaught and crashed the whole report,
      // losing every other plan's verdict (plan 2679 review finding). The row
      // stays VISIBLE as `gone` rather than being dropped silently.
      let content;
      try {
        content = readFile(rel);
      } catch (e) {
        if (isMoveRaceErrno(e)) return { id, slug, verdict: 'gone', ms: null };
        throw e;
      }
      const { kind, command } = parseTripCheck(content);
      if (kind === 'none') return { id, slug, verdict: 'none', ms: null };
      if (kind === 'manual') return { id, slug, verdict: 'manual', ms: null };
      // Command-form only from here — this is the one branch that spends
      // wall clock, so it is the one branch the total-run budget gates.
      const remainingBudgetMs = totalBudgetMs - (now() - runStart);
      if (remainingBudgetMs <= 0) {
        return { id, slug, verdict: 'budgetExhausted', ms: null };
      }
      const plannedTimeoutMs = resolveTripCheckTimeoutMs(content, {
        defaultMs: timeoutMs,
        ceilingMs,
        floorMs,
        warn,
        label: `${id}-${slug}`,
      });
      // Cap the probe at what is LEFT of the total budget, never just at its
      // own budget. Checking the budget only between probes made it a soft
      // ceiling: a plan stamped at the 600s per-plan ceiling could start with
      // 1ms of budget left and still run 600s past it, so the runbook's claim
      // that a permissive per-plan override "carries no run-time risk to the
      // rest of the lane" was not actually true (review finding, plan 3540).
      // With the cap it is: the table cannot exceed totalBudgetMs, whatever
      // any single plan stamps. A probe cut short by this cap reports
      // `timeout` — it genuinely ran out of the time it was given, and the
      // budget-exhausted row above is reserved for probes never STARTED.
      const effectiveTimeoutMs = Math.min(plannedTimeoutMs, remainingBudgetMs);
      const { verdict, ms } = runProbe(command, { timeoutMs: effectiveTimeoutMs, exec, now });
      return { id, slug, verdict, ms };
    });
  const trippedCount = rows.filter((r) => r.verdict === 'tripped').length;
  return { rows, trippedCount };
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return '';
  return `${ms}ms`;
}

export function formatReport({ rows, trippedCount }) {
  const idW = Math.max(2, ...rows.map((r) => r.id.length));
  const slugW = Math.max(4, ...rows.map((r) => r.slug.length));
  const verdictW = Math.max(6, ...rows.map((r) => VERDICT_LABEL[r.verdict].length));
  const out = ['', `waiting-trip/ status  (${rows.length} plans)`, ''];
  const header = `${'ID'.padEnd(idW)}  ${'SLUG'.padEnd(slugW)}  ${'VERDICT'.padEnd(verdictW)}  RUNTIME`;
  out.push(header);
  out.push('-'.repeat(header.length));
  for (const r of rows) {
    out.push(
      `${r.id.padEnd(idW)}  ${r.slug.padEnd(slugW)}  ${VERDICT_LABEL[r.verdict].padEnd(verdictW)}  ${fmtMs(r.ms)}`,
    );
  }
  out.push('');
  out.push(
    trippedCount > 0
      ? `${trippedCount} plan(s) TRIPPED — promotion candidate(s), see board-pass Phase 1.`
      : 'No trips fired.',
  );
  out.push('');
  return out.join('\n');
}

// --- CLI ---------------------------------------------------------------------

const USAGE = 'Usage: node scripts/trip-status.mjs [--timeout-ms <n>] [--total-budget-ms <n>]';

function parsePositiveMsFlag(argv, i, flagName) {
  const raw = argv[i + 1];
  const n = raw === undefined ? NaN : Number(raw);
  // Integers only: spawnSync's `timeout` is a millisecond count, and a
  // fractional value would be silently coerced there rather than honoured
  // (review finding, plan 3540). Refuse it here, where we can still say why.
  if (raw === undefined || !Number.isSafeInteger(n) || n <= 0) {
    throw new Error(
      `${flagName} requires a positive number of milliseconds, got: ${raw ?? '(missing)'}\n${USAGE}`,
    );
  }
  return n;
}

// Parse `process.argv.slice(2)` into buildReport-shaped overrides. The
// `timeoutMs`/`totalBudgetMs` seams already existed on runProbe/buildReport
// (plan 2679/3540) — this is the only piece that was missing: a way to reach
// them from the command line without editing the file (plan 3540). A missing
// value or a non-numeric one fails cleanly with a usage message rather than
// silently falling back to the default, since a silent fallback here would
// look exactly like the flag had been honoured.
export function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--timeout-ms') {
      opts.timeoutMs = parsePositiveMsFlag(argv, i, '--timeout-ms');
      i += 1;
    } else if (arg === '--total-budget-ms') {
      opts.totalBudgetMs = parsePositiveMsFlag(argv, i, '--total-budget-ms');
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
    return;
  }
  const report = buildReport(opts);
  console.log(formatReport(report));
  process.exitCode = report.trippedCount > 0 ? 1 : 0;
}

// Only run the CLI when this file is the entry point (not when imported by the
// test file) — the same idiom used across scripts/ (e.g. assert-color-tokens.mjs).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
