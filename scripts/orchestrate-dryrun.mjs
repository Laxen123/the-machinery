#!/usr/bin/env node
// scripts/orchestrate-dryrun.mjs — $0 dry-run harness for the /orchestrate brain
// (plan 916, component 1; the orchestrator design spec
// §Testing, docs/coord/orchestrator-loop.md § Validation modes).
//
// WHAT IT IS: a no-spend, no-mutation walk of the orchestrator control loop. It
// drives the REAL pacer (orchestrator-budget.paceDecision over the live
// .usage_cache.json) and a REAL eligible[] (queue-drain.selectEligible over the
// real ready/ plans), then STUBS the two irreversible/expensive steps —
// worker-dispatch and the done-worktree land — with deterministic simulated
// outcomes. It records into the REAL journal lib (orchestrator-journal) and
// writes a SEPARATE scratch journal, so a real /orchestrate resume is never
// polluted. It exercises pace → pick → (stub) dispatch → (stub) verify/land →
// park → journal, plus the window-stop/resume path, then ASSERTS the journal is
// internally consistent.
//
// WHAT IT IS NOT: it runs no Agent worker, no claim-plan, no cut-worktree, no
// done-worktree, no git, no move-plan. It only READS (ready/ + the usage cache)
// and WRITES one gitignored .scratch journal. Concurrency/hold-drain of live
// in-flight workers is modelled synchronously (a hold with nothing in-flight
// winds down) — true async concurrency is what the supervised shadow run
// (component 2) exercises.
//
// The pure core (defaultScenario / fakeMergeSha / simulateLoop /
// assertJournalConsistent) touches no fs/git/clock and carries the unit tests
// (orchestrate-dryrun.test.mjs); main() is the thin live shell.

import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveConfigDir } from './coord/coord-config.mjs';
import { paceDecision } from './orchestrator-budget.mjs';
import { selectEligible, readReadyMetas } from './coord/queue-drain.mjs';
import {
  emptyState,
  recordOutcome,
  parkQuestion,
  recordPendingDeploy,
  readJournal,
  writeJournal,
} from './orchestrator-journal.mjs';
import { resolveMain } from './coord/coord-git.mjs';

// --- pure: deterministic scenario --------------------------------------------

// Math.random is banned in this codebase's workflow scripts and a deterministic
// scenario is reproducible for the test, so the default cycles worker outcomes by
// candidate index: every control-flow branch (completed→land, blocked→park,
// needs_decision-resolved→land, needs_decision-unresolved→park) fires given ≥4
// candidates. The shell can pass a custom scenario for a focused walk.
export function defaultScenario(item, idx) {
  switch (idx % 4) {
    case 0:
      return { worker: 'completed', verdict: 'land' };
    case 1:
      return { worker: 'blocked' };
    case 2:
      return { worker: 'needs_decision', resolvable: true }; // brain resolves → land
    default:
      return { worker: 'needs_decision', resolvable: false }; // brain can't → park
  }
}

// Deterministic stand-in mergeSha (no clock, no random) — derived from the slug
// so a stubbed land is traceable in the journal without inventing a real sha.
export function fakeMergeSha(slug) {
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `dryrun-${h.toString(16).padStart(8, '0')}`;
}

// --- pure: one stubbed completion fold ---------------------------------------

// Apply the stubbed verify+land / park mechanics for ONE dispatched plan,
// mirroring orchestrate.md Step 4. Returns the new immutable journal state.
// Terminal buckets are kept disjoint: a plan lands (plans_landed) XOR parks
// (plans_blocked) — parked plans additionally get a parked_question.
function foldOutcome(state, trace, iter, item, sc) {
  const slug = item.slug;
  // null/unknown SEED-WRITE is treated as 🟥 (heavy verify) — conservative, the
  // same rule the oracle uses for the landing mutex.
  const heavy = item.seedWrite !== 'no';
  let worker = sc.worker;

  if (worker === 'needs_decision') {
    if (sc.resolvable) {
      trace.push({ iter, slug, event: 'needs_decision_resolved' });
      worker = 'completed';
    } else {
      trace.push({ iter, slug, event: 'needs_decision_parked' });
      return park(state, slug, sc.question || 'simulated unresolved decision fork');
    }
  }

  if (worker === 'blocked') {
    trace.push({ iter, slug, event: 'blocked_parked' });
    return park(state, slug, sc.question || 'simulated blocked worker');
  }

  // completed → verify (risk-tiered) → land | fix(bounded→park) | park
  const verdict = sc.verdict || 'land';
  trace.push({ iter, slug, event: `verify:${verdict}`, riskTier: heavy ? 'heavy' : 'light' });
  if (verdict === 'land') {
    const mergeSha = fakeMergeSha(slug);
    let s = recordOutcome(state, { kind: 'landed', slug, mergeSha });
    s = recordPendingDeploy(s, { slug, mergeSha }); // landed to master, NOT deployed
    trace.push({ iter, slug, event: 'landed', mergeSha });
    return s;
  }
  if (verdict === 'fix') {
    trace.push({ iter, slug, event: 'fix_loop_exhausted' });
    return park(state, slug, 'fix loop hit the 2-try cap');
  }
  trace.push({ iter, slug, event: 'verify_parked' });
  return park(state, slug, 'verifier verdict: park');
}

// A park records the plan as blocked AND files the operator-facing question.
function park(state, slug, question) {
  return parkQuestion(recordOutcome(state, { kind: 'blocked', slug, reason: question }), {
    slug,
    question,
  });
}

// --- pure: the control loop --------------------------------------------------

// Walk the brain loop deterministically with stubbed dispatch+land.
//   candidates   : oracle eligible[] order — [{slug, path, seedWrite, cost}]
//   paceSequence : per-iteration 'dispatch'|'hold'|'stop'; the LAST entry repeats
//                  once exhausted (so ['dispatch'] runs the whole queue).
//   scenario     : (item, idx) -> {worker, verdict?, resolvable?, question?}
//   startState   : journal to resume from (default emptyState()).
// Returns { journal, trace, stoppedForResume, dispatched }.
export function simulateLoop({
  candidates = [],
  paceSequence = ['dispatch'],
  scenario = defaultScenario,
  startState = null,
} = {}) {
  let state = startState ? { ...startState } : emptyState();
  // resume: skip plans already terminal in the carried journal (no double-pick).
  const done = new Set([
    ...state.plans_landed.map((p) => p.slug),
    ...state.plans_blocked.map((p) => p.slug),
    ...state.lands_parked.map((p) => p.slug),
    ...state.plans_skipped.map((p) => p.slug),
  ]);
  const trace = [];
  const paceAt = (i) => paceSequence[Math.min(i, paceSequence.length - 1)] ?? 'dispatch';
  let stoppedForResume = false;
  let dispatched = 0;
  const HARD_CAP = candidates.length * 2 + 8; // bounded — never spins
  let pickIdx = 0;

  for (let iter = 0; iter < HARD_CAP; iter++) {
    const pace = paceAt(iter);
    state = { ...state, window_snapshots: [...state.window_snapshots, { iter, decision: pace }] };

    if (pace === 'stop') {
      stoppedForResume = true;
      trace.push({ iter, event: 'stop_and_resume' });
      break;
    }
    // advance to the next not-yet-done candidate
    while (pickIdx < candidates.length && done.has(candidates[pickIdx].slug)) pickIdx++;
    if (pickIdx >= candidates.length) {
      trace.push({ iter, event: 'queue_exhausted' });
      break;
    }
    if (pace === 'hold') {
      // No new dispatch; with nothing in-flight in this synchronous sim, a hold
      // winds the window down (real runs drain live in-flight here — see header).
      trace.push({ iter, event: 'hold_winddown' });
      break;
    }

    const item = candidates[pickIdx];
    state = { ...state, iterations: (state.iterations ?? 0) + 1 };
    state = foldOutcome(state, trace, iter, item, scenario(item, pickIdx));
    done.add(item.slug);
    pickIdx++;
    dispatched++;
  }

  return { journal: state, trace, stoppedForResume, dispatched };
}

// --- pure: journal consistency assertion -------------------------------------

// Assert the journal reflects a sound run (plan 916 §1: "Assert the journal …
// reflects the simulated run"). dispatchedThisRun = dispatches in THIS pass
// (resume carries prior buckets, so iterations is cumulative — compare deltas).
export function assertJournalConsistent(journal, { dispatchedThisRun } = {}) {
  const errors = [];
  const landed = journal.plans_landed.map((p) => p.slug);
  const blocked = journal.plans_blocked.map((p) => p.slug);
  const landsParked = journal.lands_parked.map((p) => p.slug);

  // 1. no plan in two terminal buckets (incl. plans_skipped, which the resume
  // `done` set also dedups against — keep the assertion as strong as that guard)
  const skipped = (journal.plans_skipped || []).map((p) => p.slug);
  const seen = new Set();
  for (const s of [...landed, ...blocked, ...landsParked, ...skipped]) {
    if (seen.has(s)) errors.push(`plan ${s} appears in two terminal buckets`);
    seen.add(s);
  }
  // 2. every land has a mergeSha AND a matching pending_deploy (landed, not live)
  for (const p of journal.plans_landed) {
    if (!p.mergeSha) errors.push(`landed ${p.slug} has no mergeSha`);
    if (!journal.pending_deploy.some((d) => d.slug === p.slug))
      errors.push(`landed ${p.slug} missing from pending_deploy`);
  }
  // 3. every pending_deploy entry is a real land (nothing deployed out of nowhere)
  for (const d of journal.pending_deploy)
    if (!landed.includes(d.slug)) errors.push(`pending_deploy ${d.slug} was never landed`);
  // 4. every blocked plan carries an operator-facing parked_question
  const pq = new Set(journal.parked_questions.map((q) => q.slug));
  for (const s of blocked) if (!pq.has(s)) errors.push(`blocked ${s} has no parked_question`);

  return { ok: errors.length === 0, errors };
}

// --- live shell --------------------------------------------------------------

const REAL_JOURNAL = 'orchestrator-state.json';
const DEFAULT_DRYRUN_JOURNAL = '.scratch/orchestrator-dryrun-state.json';

// plan 1777: renamed from `parseFlags` to un-shadow the shared coord-git parseFlags (plan
// 1769), and deliberately NOT migrated to it (the record-review.mjs precedent): every flag
// here is OPTIONAL-VALUE — `--ready` alone means "the default ready/ dir", `--ready <path>`
// overrides it, and --journal/--allow/--cache/--resume/--trace all read the same way — a
// dual mode the shared parser refuses by design (a flag is either `value`, always consuming,
// or `boolean`, never). Forcing the split would change this CLI's surface.
function parseDryrunFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[k] = v;
    }
  }
  return flags;
}

function readCache(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // missing/unreadable → paceDecision fails safe to 'hold'
  }
}

function main(argv) {
  const flags = parseDryrunFlags(argv);

  // 0. journal path — refuse to clobber a REAL /orchestrate run's journal.
  const journalPath = typeof flags.journal === 'string' ? flags.journal : DEFAULT_DRYRUN_JOURNAL;
  if (basename(journalPath) === REAL_JOURNAL && !flags['force-real-journal']) {
    console.error(
      `orchestrate-dryrun: refusing to write the REAL journal (${REAL_JOURNAL}) — a dry-run ` +
        `would pollute a live resume. Use the default (${DEFAULT_DRYRUN_JOURNAL}) or pass ` +
        `--force-real-journal if you really mean to.`,
    );
    return 2;
  }

  // 1. real ready/ metas → real eligible[] via the oracle's own selector.
  //
  // plan 3816 fix round (review Fix 4): a BARE `--ready` (no value following it, or the next
  // token is itself a flag) parses as boolean `true` (parseDryrunFlags above), not a string —
  // the pre-fix `flags.ready ? null : resolveMain()` then set `repoRoot` to `null` for that
  // shape too, so `join(repoRoot, …)` below threw `ERR_INVALID_ARG_TYPE` before selection ever
  // ran. That is a genuine, pre-existing crash on the documented invocation
  // `node scripts/orchestrate-dryrun.mjs --ready` — confirmed pre-existing and fixed here
  // because it is one line, in a file this plan already touches, and rides this land.
  //
  // Bare `--ready` (`flags.ready === true`) is "fixture mode with no explicit dir": there is no
  // explicit fixture PATH to honour, so the ready dir resolves off `resolveMain()` exactly like
  // the flagless default does — but `source` stays `'tree'` (never `'origin'`), because `--ready`
  // in ANY form (bare or with an explicit path) is this CLI's documented fixture/test escape
  // hatch, not a request for the live origin-mode read. Only the truly flagless invocation
  // (`flags.ready === undefined`) gets the default `'origin'` source.
  const readyIsExplicitPath = typeof flags.ready === 'string';
  const readyIsBareFlag = flags.ready === true;
  const repoRoot = readyIsExplicitPath ? null : resolveMain();
  const readyDir = readyIsExplicitPath
    ? flags.ready
    : join(repoRoot, 'docs', 'superpowers', 'plans', 'ready');
  const metas = readReadyMetas(readyDir, {
    repoRoot,
    source: readyIsExplicitPath || readyIsBareFlag ? 'tree' : undefined,
  });
  const sel = selectEligible(metas, { landingHeld: false, seedLane: true });
  let eligible = sel.eligible || [];

  // optional allowlist (space/comma plan-ids), mirroring /orchestrate $ARGUMENTS.
  if (typeof flags.allow === 'string') {
    const allow = new Set(flags.allow.split(/[\s,]+/).filter(Boolean));
    eligible = eligible.filter((it) => allow.has((it.slug.match(/^(\d{3,})/) || [])[1]));
  }

  // 2. real pacer over the live (or fixture) usage cache.
  const cachePath =
    typeof flags.cache === 'string' ? flags.cache : join(resolveConfigDir(), '.usage_cache.json');
  const cache = readCache(cachePath);
  const pace = paceDecision(cache, { now: Date.now() });

  // 3. build the pace sequence. --stop-after N forces a stop after N dispatches
  // (demos the window-stop → resume path on demand); otherwise the live decision
  // drives (dispatch → run the queue; hold → winddown; stop → immediate stop).
  let paceSequence;
  if (flags['stop-after'] !== undefined) {
    const raw = flags['stop-after'];
    const n = Number(raw);
    // raw === true means `--stop-after` was passed with no value; Number(true) is
    // 1, which would silently run one dispatch — reject it like any non-integer.
    if (raw === true || !Number.isInteger(n) || n < 0) {
      console.error('orchestrate-dryrun: --stop-after needs a non-negative integer');
      return 2;
    }
    paceSequence = [...Array(n).fill('dispatch'), 'stop'];
  } else {
    paceSequence = [pace.decision];
  }

  // 4. resume?  read the carried journal as the start state.
  const startState = flags.resume ? readJournal(journalPath) : null;
  const priorLanded = startState ? startState.plans_landed.length : 0;

  // 5. walk the loop (stubbed dispatch + land), persist the dry-run journal.
  const { journal, trace, stoppedForResume, dispatched } = simulateLoop({
    candidates: eligible,
    paceSequence,
    startState,
  });
  mkdirSync(dirname(journalPath), { recursive: true }); // .scratch may not exist yet
  writeJournal(journalPath, journal);

  // 6. assert + report.
  const check = assertJournalConsistent(journal, { dispatchedThisRun: dispatched });

  const report = {
    journalPath,
    cache: cachePath,
    pace: { decision: pace.decision, reason: pace.reason, utilization: pace.utilization },
    eligibleCount: eligible.length,
    oracleReason: sel.reason || null,
    dispatchedThisRun: dispatched,
    stoppedForResume,
    resumeInSec: stoppedForResume ? pace.resumeInSec : null,
    counts: {
      landed: journal.plans_landed.length,
      landedThisRun: journal.plans_landed.length - priorLanded,
      blocked: journal.plans_blocked.length,
      lands_parked: journal.lands_parked.length,
      parked_questions: journal.parked_questions.length,
      pending_deploy: journal.pending_deploy.length,
      iterations: journal.iterations,
    },
    assertion: check,
  };
  console.log(JSON.stringify(report, null, 2));
  if (flags.trace) console.error(JSON.stringify(trace, null, 2));

  return check.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error('orchestrate-dryrun:', e.message);
    process.exit(2);
  }
}
