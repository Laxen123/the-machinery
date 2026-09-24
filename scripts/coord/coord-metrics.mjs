// scripts/coord/coord-metrics.mjs
// Plan 1011 Phase 0 — make the plan-972 keep-hot fast-path hit-rate OBSERVABLE.
//
// Today done-worktree's head-of-queue land decides fast-path-vs-full-rebase and only LOGS the
// outcome to stdout (done-worktree.mjs:2334). Nothing records it, so nobody can tell how often
// the fast-path actually fires — i.e. whether plan 972's keep-hot rebasing is buying anything on
// a fast-moving master. The thesis (plan 1011): under churn the live origin tip almost always
// moves between a --prep and reaching head, so the strict baseSha match (landPrepValid) rarely
// holds and the fast-path rarely fires, making the keep-hot work mostly wasted. This records the
// outcome of each head land so the hit-rate is a number, not a guess.
//
// Append-only JSONL beside the land-prep markers (MAIN/.scratch, gitignored, survives the
// worktree teardown the land performs). Telemetry ONLY — recording NEVER throws and NEVER alters
// land behavior; a write failure just means one un-sampled land.

import { appendFileSync, mkdirSync, readFileSync, statSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export function landPrepMetricsPath(main) {
  return `${main}/.scratch/land-prep-metrics.jsonl`;
}

// The ONE append-only JSONL writer (plan 2198 review finding [3]): mkdir the parent, stamp `ts`,
// append one line, swallow EVERY error — telemetry/journaling must never break its caller. This
// shape existed as three hand-rolled copies (here, battery-pass-cache's logTelemetry,
// usage-broadcast's log) before install-main's heal journal would have made a fourth; new
// journal-shaped writers call THIS instead of copying the pattern again. `maxBytes` (optional)
// caps growth — see `rotateIfOver` above, which owns that behaviour and its documentation.
// Returns true iff the line was written.
// Rotate `path` to `<path>.1` (overwriting any previous rotation) when it already exceeds
// `maxBytes`, bounding it at ~2x maxBytes on disk total. Extracted from appendJsonl's own
// `maxBytes` arm (plan 2473 review [8]) so a caller that needs the rotation WITHOUT the JSONL
// append — done-worktree's per-slug land-prep log, which hands a raw fd to `spawn` — reuses this
// instead of hand-rolling a second stat-then-rename. Never throws: a missing file (ENOENT) or a
// losing rotation race just means "append to whatever is there".
export function rotateIfOver(path, maxBytes, { _stat = statSync, _rename = renameSync } = {}) {
  // `== null` (not falsy): review 2473-r2 [9] — a caller passing 0 means "always rotate", and a
  // truthiness test would silently turn the strictest possible ceiling into a permanent no-op.
  if (maxBytes == null) return false;
  try {
    if (_stat(path).size > maxBytes) {
      _rename(path, `${path}.1`);
      return true;
    }
  } catch {
    /* missing file (ENOENT) or a losing rotation race — either way just append */
  }
  return false;
}

export function appendJsonl(
  path,
  record,
  {
    _now = () => new Date().toISOString(),
    _append = appendFileSync,
    _mkdir = mkdirSync,
    _stat = statSync,
    _rename = renameSync,
    maxBytes = null,
  } = {},
) {
  try {
    _mkdir(dirname(path), { recursive: true });
    rotateIfOver(path, maxBytes, { _stat, _rename });
    _append(path, JSON.stringify({ ts: _now(), ...record }) + '\n');
    return true;
  } catch {
    return false; // best-effort — a failed sample never propagates
  }
}

// Append one head-land outcome. `record` carries { slug, fastPath, hadMarker, fetchedOk }.
// Seams (`_now`, `_append`, `_mkdir`) are injectable for the unit test. Swallows EVERY error:
// telemetry must never break a land. Returns true iff a line was written (tests assert on this).
export function recordLandPrepOutcome(
  main,
  record,
  { _now = () => new Date().toISOString(), _append = appendFileSync, _mkdir = mkdirSync } = {},
) {
  return appendJsonl(
    landPrepMetricsPath(main),
    { event: 'head-land', ...record },
    { _now, _append, _mkdir },
  );
}

// Parse the JSONL (tolerating blank / corrupt lines) into outcome records.
export function parseLandPrepMetrics(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a partially-written line */
    }
  }
  return out;
}

// Collapse a land's records to the ONE that describes what actually happened (plan 2473).
//
// A land emits its fast-path verdict TWICE: once before the enqueue (which must stay, so a land
// that seams early — REVIEW_NEEDED / BUILD_FAILED / MOBILE_FAILED / FINDINGS_OPEN — is still
// sampled, and so the series stays comparable with the pre-2473 baseline) and once at head, after
// the plan-2458 re-check, tagged `final: true`. The pre-enqueue verdict is WRONG for exactly the
// two cases that matter — a land prepped during the wait reads `fastPath:false` though it skipped
// the rebase, and one whose marker lapsed reads `true` though it paid the full battery — so where
// both exist, the final one is the truth.
//
// Grouping is by `landId`, which is per-INVOCATION. Records without one — every line written
// before this plan — group as themselves, so the historical sample is re-summarised bit-identically
// rather than silently re-bucketed. Order-independent: the `final` record wins wherever it sits in
// the file, and a duplicate `final` (a resumed invocation reusing an id) keeps the last one, which
// is the later decision.
export function foldLandPrepRecords(records) {
  const out = [];
  const byLand = new Map(); // landId → index into `out`
  for (const r of records || []) {
    if (!r || r.event !== 'head-land') continue;
    const id = r.landId;
    if (!id) {
      out.push(r);
      continue;
    }
    const at = byLand.get(id);
    if (at === undefined) {
      byLand.set(id, out.length);
      out.push(r);
    } else if (r.final === true) {
      out[at] = r; // the at-head verdict supersedes the pre-enqueue one
    }
  }
  return out;
}

// Reduce outcome records to the headline: how often the fast-path fired vs fell back to a full
// head-time rebase, and how often a marker even existed (a low hadMarker rate means --prep barely
// ran; a high hadMarker with low fired rate means the tip kept moving — the plan-1011 prediction).
// Counts LANDS, not lines: see foldLandPrepRecords above.
export function summarizeLandPrepMetrics(records) {
  const list = foldLandPrepRecords(records);
  const total = list.length;
  const fired = list.filter((r) => r.fastPath === true).length;
  const hadMarker = list.filter((r) => r.hadMarker === true).length;
  // plan 2463: of the fires, how many came from the SPECULATIVE marker rather than the plain one.
  // This is the number that says whether Zuul-style stacking is earning its keep: the plain marker
  // is invalidated by construction whenever the head lands, so a healthy busy queue should push
  // this share toward 1.0 while `fired` itself rises. Absent on every pre-2463 line ⇒ 0.
  const speculative = list.filter((r) => r.speculative === true).length;
  return {
    total,
    fired,
    fellBack: total - fired,
    hadMarker,
    speculative,
    speculativeShareOfFiredPct: fired ? Math.round((speculative / fired) * 100) : null,
    // How many of the counted lands reached the at-head decision at all (plan 2473). The rest
    // seamed early or are pre-2473 lines, and are still counted on their pre-enqueue verdict.
    finalVerdicts: list.filter((r) => r.final === true).length,
    firedPct: total ? Math.round((fired / total) * 100) : null,
    // of the lands where a marker existed, how often did it still validate? (isolates "tip moved")
    firedWhenMarkerPresentPct: hadMarker ? Math.round((fired / hadMarker) * 100) : null,
  };
}

function main() {
  // CLI: read the metrics file for a given MAIN (default: cwd) and print the hit-rate.
  const mainDir = process.argv[2] || process.cwd();
  let text = '';
  try {
    text = readFileSync(landPrepMetricsPath(mainDir), 'utf8');
  } catch {
    console.log(
      `no land-prep metrics yet at ${landPrepMetricsPath(mainDir)} (no head lands sampled).`,
    );
    return;
  }
  const s = summarizeLandPrepMetrics(parseLandPrepMetrics(text));
  console.log(`\nplan-972 keep-hot fast-path hit-rate (${s.total} head lands sampled)\n`);
  console.log(`  fast-path fired       ${s.fired}  (${s.firedPct}%)`);
  console.log(`  fell back to rebase   ${s.fellBack}`);
  console.log(`  a marker was present  ${s.hadMarker}`);
  console.log(`  at-head final verdict ${s.finalVerdicts}  (rest: seamed early / pre-2473 lines)`);
  console.log(
    `  of those, SPECULATIVE   ${s.speculative}` +
      (s.speculativeShareOfFiredPct != null
        ? `  (${s.speculativeShareOfFiredPct}% of fires)`
        : '') +
      `  (plan 2463 — stacked on the head's tree)`,
  );
  if (s.firedWhenMarkerPresentPct != null)
    console.log(
      `  fired WHEN marker present  ${s.firedWhenMarkerPresentPct}%  (low ⇒ tip kept moving)`,
    );
  console.log('');
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
