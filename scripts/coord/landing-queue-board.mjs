#!/usr/bin/env node
// scripts/landing-queue-board.mjs (plan 650; Waiting column + head-state line, plan 2524)
// Read-only pretty-printer for the plan-504 landing queue. Shells the canonical
// `landing-queue.mjs status --json` (single source of truth — it already does the
// origin/master fresh read + landed-orphan prune) and renders a boxed FIFO table:
//
//   Landing queue: 6 waiting, FIFO order.
//   ┌──────────┬────────────────────┬─────────┬──────────┬─────────┬─────────┐
//   │    #     │ Plan               │ Lane    │ Enqueued │ Waiting │ Origin  │
//   ├──────────┼────────────────────┼─────────┼──────────┼─────────┼─────────┤
//   │ 1 (head) │ 642-Infra-...      │ 🟩 free │ 13:26    │ 2h20m   │ 🖥 local │
//   ...
//   Head: 642-Infra-… — state HOLDING, last land progress 4m ago.
//   (Waiting is time IN QUEUE — an upper bound on time AT HEAD.)
//
// This NEVER mutates the queue — it only spawns the read-only `status --json`.
// Mutations stay in landing-queue.mjs (enqueue/dequeue/heartbeat/steal), the one
// coordWrite-guarded writer. In particular this file must never call `heartbeat`:
// that would reset the staleness clock and mask a dead head, which is exactly what
// the /landing-queue `check` probe exists to detect.
//
// Usage: node scripts/landing-queue-board.mjs
// Exit codes: 0 ok · 5 error (status spawn / parse failed).

import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { loadCoordConfig } from './coord-config.mjs';
import { dispWidth, renderBox, ageLabel } from './box-table.mjs';
import { scriptsFileFrom, repoRootFrom } from './scripts-anchor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// `findScriptsFile` is now ONE implementation, `scripts/coord/scripts-anchor.mjs` — see that module for
// why the anchor is the `scripts/` directory NAME and not a repo-root marker or an existsSync
// probe. It used to be copied into each module because Rule 3 forbids a coord-core-destined
// module importing a NON-coord sibling; the shared version lives under `scripts/coord/`, so
// that objection is gone and the copies are retired (plan 3962 Phase 2).
// Kept as a named export (and as this module's default-`HERE` spelling) because the tests and
// importers already name it.
export const findScriptsFile = (name, startDir = HERE) => scriptsFileFrom(name, startDir);

const STATUS_SCRIPT = findScriptsFile('landing-queue.mjs');

// NOTE: `dispWidth` is deliberately NOT re-exported from here. It briefly was, "for
// compatibility", but nothing outside this module's own test ever imported it — and a re-export
// plus its duplicated test cases is a second place to keep the width rule in sync, which is the
// exact thing extracting box-table.mjs was for. Consumers import it from box-table.mjs.

// HH:MM from an ISO timestamp (UTC, sliced — matches the timestamps the queue stores).
export function hhmm(iso) {
  const m = /T(\d\d:\d\d)/.exec(iso || '');
  return m ? m[1] : '??:??';
}

export function laneLabel(lane) {
  if (lane === '🟥') return '🟥 seed';
  if (lane === '🟩') return '🟩 free';
  return lane || '?';
}

// Cloud-vs-local classification reuses the already-canonical local-machine hostname
// list — coord.config.json's `localHostDenylist[]` (plan 4071 D4; formerly a hardcoded
// LOCAL_HOST_DENYLIST constant in cloud-checkout-preflight.mjs, still that script's own
// naming for the same list) — rather than a second hostname heuristic; `denylist`
// defaults to `[]` (every host reads 'cloud') so a config-less repo degrades to the same
// safe direction as an unlisted host, never to a hardcoded vetapp-specific list a
// consumer forgot to pass.
//
// PLAIN ASCII since plan 2932. This used to return `🖥 local` / `☁️ cloud`, and the `🖥`
// (U+1F5A5) half was a latent alignment bug: box-table's dispWidth counts it 2 (its
// `>= 0x1f000` branch) while the terminal draws it 1, so every local row of a mixed queue
// overflowed its right border by one column. It stayed invisible only because nobody had
// looked closely at a queue holding both origins at once. `box-table.assertRenderableGlyphs`
// now pins the rule in a test, and all three boards share one cell vocabulary
// (`local` / `cloud` / `none`) so the /in-progress Where column reads identically.
export function originLabel(host, denylist = []) {
  if (!host) return '?';
  return denylist.includes(host.toUpperCase()) ? 'local' : 'cloud';
}

// plan 2524: the head's own status line. Two DISTINCT freshness axes, and conflating them is
// precisely what plan 2485's progress stamp exists to prevent:
//   • progressIso  — the land actually MOVED (a merge step completed). The real signal.
//   • heartbeatIso — the session is alive. A long gate-phase battery heartbeats for an hour
//                    without the land advancing a single step.
// So report progress when it exists and SAY SO when falling back to the heartbeat, rather than
// printing one age under an ambiguous label — "last progress 4m ago" and "last heartbeat 4m
// ago" justify very different operator reactions (leave it alone vs look at whether it is stuck).
export function headLine(head, nowMs) {
  if (!head) return null;
  const state = head.state || '—';
  const axis = head.progressIso
    ? `last land progress ${ageLabel(head.progressIso, nowMs)} ago`
    : `no land progress recorded; last heartbeat ${ageLabel(head.heartbeatIso, nowMs)} ago`;
  return `Head: ${head.slug} — state ${state}, ${axis}.`;
}

export function renderTable(entries, head, { nowMs = Date.now(), localHostDenylist = [] } = {}) {
  const headers = ['#', 'Plan', 'Lane', 'Enqueued', 'Waiting', 'Origin'];
  const rows = entries.map((e, i) => {
    const num = e.slug === head ? `${i + 1} (head)` : String(i + 1);
    // plan 2328: surface the ⚡ priority class — the same field landing-queue.mjs's own
    // plain-text status prints; the two human queue views must not silently disagree.
    return [
      num,
      e.slug,
      `${laneLabel(e.lane)}${e.priority ? ' ⚡' : ''}`,
      hhmm(e.enqueuedIso),
      // plan 2524: the queue is NOT sorted by this column — a ⚡ priority land inserts at the
      // front block, so row 2 can legitimately be YOUNGER than row 3. That is the insertion
      // policy working, not a rendering bug; showing the age makes it visible instead of
      // leaving the operator to infer a FIFO ordering that isn't strictly there.
      ageLabel(e.enqueuedIso, nowMs),
      originLabel(e.host, localHostDenylist),
    ];
  });

  return renderBox(headers, rows, { centerCols: [0] });
}

export function main() {
  let json;
  try {
    json = execFileSync(process.execPath, [STATUS_SCRIPT, 'status', '--json'], {
      encoding: 'utf8',
    });
  } catch (e) {
    console.error('landing-queue-board: could not read queue status:', e.message);
    return 5;
  }

  let data;
  try {
    data = JSON.parse(json);
  } catch {
    console.error('landing-queue-board: status did not return JSON:\n' + json);
    return 5;
  }

  const entries = data.entries ?? [];
  if (!entries.length) {
    console.log('Landing queue: empty');
    return 0;
  }

  const nowMs = Date.now();
  const localHostDenylist = loadCoordConfig(repoRootFrom(HERE)).localHostDenylist;
  console.log(`Landing queue: ${entries.length} waiting, FIFO order.`);
  console.log(renderTable(entries, data.head, { nowMs, localHostDenylist }));

  const line = headLine(
    entries.find((e) => e.slug === data.head),
    nowMs,
  );
  if (line) console.log(line);
  // The honest caveat, printed every time rather than documented once and forgotten. The queue
  // records when an entry was ENQUEUED, not when it reached position 1 (that transition is not
  // stamped — operator ruling 2026-07-26 declined the extra queue column), so the head's
  // Waiting age is an UPPER BOUND on how long it has actually held the land mutex.
  console.log('(Waiting is time IN QUEUE — an upper bound on time AT HEAD.)');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
