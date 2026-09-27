#!/usr/bin/env node
// scripts/orchestrator-budget.mjs — read-only 5-hour-window pacer for the
// LLM-orchestrator (procedure: docs/coord/orchestrator-loop.md).
//
// Answers ONE question for the orchestrator brain: given the OAuth usage meter,
// may I dispatch another plan now (`dispatch`), finish in-flight work without
// starting new (`hold`), or wind down and resume next window (`stop`)? It reads
// $CLAUDE_CONFIG_DIR/.usage_cache.json (the cache the statusline maintains) and
// NEVER mutates anything.
//
// The pure paceDecision(cache, opts) takes the parsed cache object + a fixed
// `now`, touches no fs/clock, and carries the unit tests.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveConfigDir } from './coord/coord-config.mjs';
// Leaf parser module — NOT cloud-usage-guard — so this read-only pacer stays free of the
// HTTP/fs/credentials import graph on every spawn (plan 1959 review finding [3]).
import { utilizationFromUsage } from './usage-parse.mjs';

// --- pure --------------------------------------------------------------------

// Thresholds (percent of the 5-hour window, plus the 7-day soft ceiling).
//
// `dispatchCeiling` (75) is DELIBERATELY SEPARATE from cloud-usage-guard's
// DEFAULT_THRESHOLD (also 75), NOT a shared constant (plan 1959 finding [2] decision):
// this is a three-state PACER knob (dispatch / hold / stop, alongside hardStop=95 and
// sevenDayCeiling=90) meaning "stop STARTING new work but finish in-flight", whereas the
// guard's threshold is a binary preflight CLIFF (GO / STOP — skip the whole drain). They
// answer different questions with different actions and coincide at 75 only today;
// collapsing them into one tunable would couple the drain-skip cliff to this reserve line
// so a future tuning of one silently moves the other — the drift risk in reverse. Only the
// five_hour.utilization PARSE is shared (below), because that IS the same payload read.
//
// Both moved 80 → 75 together in plan 2412 (operator raised the reserve from 20% to 25%
// of the window) — moved in TANDEM by an explicit decision, still two knobs, not one.
export const DEFAULTS = { dispatchCeiling: 75, hardStop: 95, sevenDayCeiling: 90 };

// cache: parsed .usage_cache.json (or null / {} when missing/unreadable).
// opts:  { now (epoch ms, required), dispatchCeiling, hardStop, sevenDayCeiling }
// returns { decision, reason, utilization, sevenDay, resetsAt, resumeInSec }
//   decision ∈ 'dispatch' | 'hold' | 'stop'
export function paceDecision(cache, opts = {}) {
  const { now, dispatchCeiling, hardStop, sevenDayCeiling } = { ...DEFAULTS, ...opts };
  const five = cache && cache.five_hour;
  // Share the leaf five_hour.utilization parser (plan 1959 finding [4]) so a payload-shape
  // rename fixes the guard AND this pacer at once. resets_at / seven_day stay local reads:
  // the pacer still reports resets_at in the meter_unavailable branch (where utilization is
  // null), which the utilization-only parser deliberately drops.
  const utilization = utilizationFromUsage(cache);
  const sevenUtil =
    cache && cache.seven_day && typeof cache.seven_day.utilization === 'number'
      ? cache.seven_day.utilization
      : null;
  const resetsAt = (five && five.resets_at) || null;
  const resumeInSec =
    resetsAt && Number.isFinite(Date.parse(resetsAt)) && Number.isFinite(now)
      ? Math.max(0, Math.ceil((Date.parse(resetsAt) - now) / 1000))
      : null;

  const base = { utilization, sevenDay: sevenUtil, resetsAt, resumeInSec };

  // Fail-safe: no readable 5-hour meter → HOLD (finish in-flight, start nothing).
  if (utilization === null) return { decision: 'hold', reason: 'meter_unavailable', ...base };

  if (utilization >= hardStop) return { decision: 'stop', reason: 'five_hour_hardstop', ...base };
  if (utilization >= dispatchCeiling)
    return { decision: 'hold', reason: 'five_hour_reserve', ...base };
  if (sevenUtil !== null && sevenUtil >= sevenDayCeiling)
    return { decision: 'hold', reason: 'seven_day_soft_ceiling', ...base };
  return { decision: 'dispatch', reason: 'within_budget', ...base };
}

// --- CLI ---------------------------------------------------------------------

function resolveCachePath() {
  return join(resolveConfigDir(), '.usage_cache.json');
}

function readCache(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // missing / unparseable → paceDecision fails safe to HOLD
  }
}

function main(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[k] = v;
    }
  }
  const opts = { now: Date.now() };
  if (flags['dispatch-ceiling']) opts.dispatchCeiling = Number(flags['dispatch-ceiling']);
  if (flags['hard-stop']) opts.hardStop = Number(flags['hard-stop']);
  if (flags['seven-day-ceiling']) opts.sevenDayCeiling = Number(flags['seven-day-ceiling']);

  const cache = readCache(typeof flags.cache === 'string' ? flags.cache : resolveCachePath());
  console.log(JSON.stringify(paceDecision(cache, opts), null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error('orchestrator-budget:', e.message);
    process.exit(2);
  }
}
