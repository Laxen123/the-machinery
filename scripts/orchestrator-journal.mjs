#!/usr/bin/env node
// scripts/orchestrator-journal.mjs — the LLM-orchestrator's run journal
// (procedure: docs/coord/orchestrator-loop.md; plan 913).
//
// Records one summary per plan + window snapshots + parked questions to
// .scratch/orchestrator-state.json so a window-bounded run can RESUME fresh
// (read journal → rebuild state) and a crash leaves forensics. The pure state
// functions (emptyState / recordOutcome / parkQuestion / recordPendingDeploy)
// carry the unit tests; readJournal/writeJournal + the `summary` CLI are the
// thin fs layer. Immutable by design — every mutator returns a NEW state so the
// brain can keep the prior snapshot.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// --- pure --------------------------------------------------------------------

export function emptyState() {
  return {
    plans_completed: [],
    plans_quarantined: [],
    plans_blocked: [],
    plans_skipped: [],
    plans_landed: [], // { slug, mergeSha }
    lands_parked: [], // { slug, seam, reason }
    parked_questions: [], // { plan, ask } — legacy records may carry { slug, question }
    carry_forwards: [],
    carry_forwards_filed: [],
    pending_deploy: [], // { slug, mergeSha } — landed to master, NOT deployed
    in_flight: [],
    window_snapshots: [], // { at, utilization, decision }
    iterations: 0,
  };
}

const OUTCOME_BUCKET = {
  completed: 'plans_completed',
  quarantined: 'plans_quarantined',
  blocked: 'plans_blocked',
  skipped: 'plans_skipped',
  landed: 'plans_landed',
  land_parked: 'lands_parked',
};

// Append a plan outcome to its bucket. `outcome` = { kind, ...entry }; `kind`
// selects the bucket and is stripped from the stored entry. Immutable.
export function recordOutcome(state, outcome) {
  const bucket = OUTCOME_BUCKET[outcome.kind];
  if (!bucket) {
    throw new Error(`orchestrator-journal: unknown outcome kind "${outcome.kind}"`);
  }
  const entry = { ...outcome };
  delete entry.kind;
  return { ...state, [bucket]: [...state[bucket], entry] };
}

export function parkQuestion(state, question) {
  return { ...state, parked_questions: [...state.parked_questions, question] };
}

export function recordPendingDeploy(state, entry) {
  return { ...state, pending_deploy: [...state.pending_deploy, entry] };
}

// --- fs ----------------------------------------------------------------------

export function readJournal(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return emptyState(); // missing / unparseable → fresh state (first window)
  }
}

export function writeJournal(path, state) {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// --- CLI: `summary <path>` ---------------------------------------------------

export function summarize(state) {
  const n = (b) => state[b]?.length ?? 0;
  const lines = [
    `landed:           ${n('plans_landed')}`,
    `completed:        ${n('plans_completed')}`,
    `quarantined:      ${n('plans_quarantined')}`,
    `blocked:          ${n('plans_blocked')}`,
    `skipped:          ${n('plans_skipped')}`,
    `lands parked:     ${n('lands_parked')}`,
    `pending deploy:   ${n('pending_deploy')}`,
    `parked questions: ${n('parked_questions')}`,
    `iterations:       ${state.iterations ?? 0}`,
  ];
  if (n('pending_deploy')) {
    lines.push('', 'PENDING DEPLOY (landed to master, NOT live — review then deploy):');
    for (const d of state.pending_deploy) lines.push(`  - ${d.slug} @ ${d.mergeSha ?? '?'}`);
  }
  if (n('parked_questions')) {
    lines.push('', 'PARKED QUESTIONS (need your decision):');
    // Canonical shape is { plan, ask }; fall back to the legacy { slug, question }
    // keys so an older journal on disk never renders "undefined" either.
    for (const q of state.parked_questions) {
      lines.push(`  - [${q.plan ?? q.slug}] ${q.ask ?? q.question}`);
    }
  }
  return lines.join('\n');
}

function main(argv) {
  const [cmd, path] = argv;
  if (cmd !== 'summary' || !path) {
    console.error('usage: orchestrator-journal.mjs summary <path-to-orchestrator-state.json>');
    return 2;
  }
  console.log(summarize(readJournal(path)));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
