#!/usr/bin/env node
// scripts/coord/coord-op-stats.mjs (plan 4087, T0)
//
// READ-ONLY statistics over `.git/coord-op-journal.jsonl`, so plan 4087's timeout caps (T1's
// per-op deadline, T2's derived ls-remote read cap) can be picked from MEASURED start-to-close
// durations instead of guessed constants. Never writes, never mutates the journal — this is a
// pure reader over `readCoordOpJournal` (coord-git.mjs), the same parser heal-main's
// `openCoordOps`/`reportInterruptedOps` already trust.
//
// ── What `release` means (answered here, per T0's brief) ─────────────────────────────────────
// `withCoordLock` (coord-git.mjs:2850-2919) journals a `start` line when the coord-write lock is
// acquired, and a bare `release` line when the inner fn calls `ctx.release()` to hand the lock
// back EARLY (coordWrite drops it after its commit so the push + verify round-trip runs
// unserialized — coord-git.mjs:2894-2908). If the op later needs the lock again (the non-ff
// rollback path), it calls `ctx.reacquire()`, which re-acquires the SAME lockPath under the SAME
// token and journals a FRESH `start` line for that token (coord-git.mjs:2909-2914, comment: "re-
// opens the entry for heal-main's openCoordOps fold"). So one logical op can journal
// `start → release → start → done`, and `release` is NOT a terminal close in the sense `done` /
// `error` / `healed` are — it is a mid-op "lock handed back, more coming" marker. `openCoordOps`
// (heal-main.mjs:628-635) treats it exactly like any other non-start phase: it closes the
// CURRENT open window for that token (deletes it from the open map), and a later `start` with
// the same token reopens a new window. This script mirrors that fold exactly (see
// `computeCoordOpStats` below) so its "unmatched start" count means the same thing heal-main's
// `reportInterruptedOps` means by it. A `release`-closed window is counted as a completed
// interval (the lock genuinely wasn't held for that whole span) but tagged `release` in the
// close-reason breakdown, distinct from `done`/`error`/`healed`, so a reader doesn't mistake a
// mid-op handoff for the op's actual outcome.
//
// ── `healed` is a SEPARATE, tokenless signal, not a token-paired close (measured, not assumed) ──
// `healDirt`/the top-level heal pass (heal-main.mjs:1474-1480) also journals `phase: 'healed'`
// when it actually fixed something — but as a STANDALONE line with no `token` at all, not as a
// closing line for some start's window. Every `healed` line in the 2026-09-22 snapshot lacks a
// token. So it can never be paired to a `start` by this script's fold (or by `openCoordOps`,
// which the same way ignores it — a tokenless line matches no map entry either way) and is
// counted separately as `standaloneHealedCount`, not lumped into the generic "skipped/malformed"
// tally. The per-tool `closedBy.healed` column exists for forward-compatibility (a FUTURE
// token-carrying `healed` close would land there), but reads 0 against every journal seen so far.
//
// ── The `release` column is NOT churn (plan 4136 E2) ──────────────────────────────────────────
// `release` looks alarming read as a raw count (e.g. 125 releases vs 18 `done`s) because every
// lever-1-wired tool (coordWrite's early hand-back — see "What `release` means" above) journals
// AT LEAST one `release` on its way to a `done`, so `release` and `done` are not two competing
// outcomes to compare — they are two DIFFERENT axes: `release` counts mid-op lock handoffs,
// `done` counts ops that finished successfully. Measured against a real journal, ~90% of ops
// release the lock exactly once (one handoff, then done) — the raw ratio just reflects that a
// normal op contributes to BOTH columns, not that the lock is churning. The `ops` view below
// (computeCoordOpStats's `tools[].ops` / `summary.ops`) is the population-corrected read: it
// folds every start/release/start/... cycle for one token into ONE logical op and reports how
// many of those ops needed more than one `start` (an actual reacquire, e.g. the non-ff rollback
// path) — that count, not the raw `release` tally, is what answers "is the lock churning".
//
// ── waitMs: how long an acquire QUEUED before it won the lock (plan 4136 E2) ──────────────────
// `withCoordLock` (coord-git.mjs) now stamps every `start` line with `waitMs` — wall-clock time
// spent inside `acquireCoordLock` before it returned, i.e. time spent BLOCKED behind a sibling's
// held lock, not time spent holding it afterward. A journal line written before this change (or
// a synthetic/legacy one) simply has no `waitMs` field; every wait statistic below treats that
// absence as "no data" (null / "-"), never as a measured zero — only a `start` line that actually
// carries a finite `waitMs` enters the sample.
//
// Usage:
//   node scripts/coord/coord-op-stats.mjs [--journal <path>] [--json]
//
// Default journal path resolves the same way the repo does (`coordOpJournalPath`, anchored at
// CWD) — pass --journal to point at a snapshot file instead (e.g. one copied off the shared
// checkout for offline analysis).

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { coordOpJournalPath, coordOpJournalArchiveRegex } from './coord-git.mjs';

// Parse a journal file's raw text into entries, tolerating unparseable lines (skipped, counted)
// and a journal that does not exist yet (empty entries, not an error — a fresh checkout has none).
// Pure — takes raw text, never touches the filesystem itself, so the test can feed a fixture
// string directly instead of building a real file.
export function parseJournalText(text) {
  let badLines = 0;
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      badLines++;
    }
  }
  return { entries, badLines };
}

// plan 4087 T4 (review key 328vcu): nearest-rank, matching scripts/land-duration-lib.mjs's
// `percentile()` — the repo's one other percentile-over-durations helper — rather than the
// floor-based rank this function used before. Not literally IMPORTED: this module's contract
// (see file header — READ-ONLY, node builtins plus coordOpJournalPath only) deliberately keeps
// it from picking up a second cross-file dependency on an unrelated land-timing module for one
// small helper, so the same MATH is reproduced here instead. The two floor/ceil rank choices
// agree everywhere except at certain sample-size/quantile boundaries (e.g. n=20, p=0.5: floor
// picks index 10, ceil-nearest-rank picks index 9) — aligning removes a place where this
// journal's reported p50/p95 and the land-duration tool's would silently mean slightly different
// things for the same input shape. `sortedNums` must already be sorted ascending; every caller
// below sorts before calling, same as before.
function quantile(sortedNums, q) {
  if (sortedNums.length === 0) return null;
  const idx = Math.min(sortedNums.length - 1, Math.max(0, Math.ceil(q * sortedNums.length) - 1));
  return sortedNums[idx];
}

// plan 4087 T4 (review key ezbmqk): rotateCoordOpJournal (coord-git.mjs) archives whatever it
// removes from the live file to a dated sibling, `<base>-YYYY-MM-DD.jsonl`, beside it, rather than
// discarding it — a reader that only ever opens the live file would silently lose whatever history
// the rotation just moved out, exactly the gap plan 4087 T0 was measuring around.
//
// plan 4087 round-2 review (finding: archive naming duplicated) — the naming convention used to be
// REPRODUCED here rather than imported, on the reasoning that this module's contract (READ-ONLY,
// node builtins plus a narrow coord-git.mjs surface) should keep a read-only journal reporter from
// growing a second reason to break when the write side changes shape. That reasoning traded away
// the wrong thing: two copies of the SAME filename pattern is precisely the drift class this
// module's own other cross-references (`computeCoordOpStats`, `coordOpJournalPath`) exist to
// avoid, and coord-git.mjs already owns this convention (`coordOpJournalDailyPath`, immediately
// paired with the new `coordOpJournalArchiveRegex` export). The contract narrows instead to
// "import whatever coord-git.mjs surface this module needs, never re-derive one of its
// conventions by hand" — the import is still scoped to coord-git.mjs alone, so a write-side shape
// change still surfaces as one failing import, not a silently stale regex.
export function listArchiveJournalPaths(journalPath, { _readdirSync = readdirSync } = {}) {
  const dir = dirname(journalPath);
  const rx = coordOpJournalArchiveRegex(journalPath);
  let names;
  try {
    names = _readdirSync(dir);
  } catch {
    return []; // no common dir yet (fresh checkout) — nothing archived either
  }
  return names
    .filter((n) => rx.test(n))
    .sort() // YYYY-MM-DD sorts lexicographically == chronologically
    .map((n) => join(dir, n));
}

// The live journal PLUS every daily archive beside it, concatenated oldest-archive-first with the
// live file last. Order matters: a `start` archived by one rotation can have its closing line land
// in the live file (or a later archive) — computeCoordOpStats's token-keyed fold only re-pairs that
// split correctly when entries arrive in this chronological order (it does not sort by `ts`
// itself). Factored out of `main()` so both the CLI and a test (or another reader, e.g.
// coord-git.mjs's derived-timeout seam) can get the same merged view without duplicating the
// archive-discovery + concatenation logic a second time.
//
// plan 4087 round-4 review (keys c67d42/00ed01/5840c6/4ef78b/3a6139): concatenation here USED to
// need an overlap trim, because `rotateCoordOpJournal` (coord-git.mjs) archived the WHOLE
// pre-rotation file and then truncated the live file to its own last JOURNAL_KEEP_LINES lines —
// so the kept tail existed in BOTH the archive and the live file at once, and every consumer of
// this function would double-count it. Three review rounds patched that trim (a rotation-echo
// detector keyed on the stream rewinding in time, a longest-matching-run search, an ADJACENT-only
// scope) and each round's fix left a new edge case: equal timestamps defeated the rewind gate,
// and a genuinely repeated tokenless event (see the file header's "healed is a SEPARATE, tokenless
// signal" section) could still be mistaken for an echo or vice versa.
//
// The actual bug was in the WRITER, not the reader: rotation should never have put the SAME lines
// in two places. `rotateCoordOpJournal` now archives only the lines it REMOVES from the live file,
// never the kept tail — so "every archive, oldest first, then the live file" is already the exact
// history with each line appearing exactly once, and this function is plain concatenation, no
// trim, no timestamp reasoning, no heuristic at all.
//
// `maxArchives` bounds the read to the N most-recently-dated archive files (plus the live file) —
// see coord-git.mjs's `readCoordOpJournalForStats` for a caller that needs this; omitted (the
// default), every archive is read, which is what the operator-facing CLI (`main()` below) wants.
export function collectJournalEntries(
  journalPath,
  { _readdirSync = readdirSync, _readFileSync = readFileSync, maxArchives } = {},
) {
  const readText = (p) => {
    try {
      return _readFileSync(p, 'utf8');
    } catch {
      return ''; // missing/unreadable file — degrade to empty, never throw into a read
    }
  };
  let archivePaths = listArchiveJournalPaths(journalPath, { _readdirSync });
  if (Number.isInteger(maxArchives) && maxArchives >= 0 && archivePaths.length > maxArchives) {
    // archivePaths is sorted oldest-first (YYYY-MM-DD lexicographic order) — keep the most RECENT
    // maxArchives entries, i.e. drop from the front.
    archivePaths = archivePaths.slice(archivePaths.length - maxArchives);
  }

  const lines = [];
  for (const p of [...archivePaths, journalPath]) {
    for (const raw of readText(p).split('\n')) {
      if (raw.trim()) lines.push(raw);
    }
  }

  const totalEntries = lines.length;
  const { entries, badLines } = parseJournalText(lines.join('\n'));
  return { entries, badLines, totalEntries, archivePaths };
}

const CLOSE_REASONS = ['done', 'error', 'healed', 'release'];

// plan 4136 E2: which close phases end a logical OP (see the "ops" fold in computeCoordOpStats).
// `release` deliberately excluded — it is coordWrite's mid-op lock handoff, not the op's own
// terminal outcome (see the file header's "release is NOT churn" section); a `start` that follows
// a `release` reopens the SAME op rather than starting a new one. `healed` is listed for forward-compat only,
// mirroring CLOSE_REASONS: today heal-main journals it TOKENLESS (heal-main.mjs), so it never
// reaches this per-token fold (plan 4136 review fb847c). A wedged op that heal-main later repaired
// therefore stays in `ops.openCount`; it is the same op the UNMATCHED section lists, so read the
// two together. Only `done`/`error` feed the op WALL-TIME sample.
const OPS_TERMINAL_REASONS = ['done', 'error', 'healed'];
const OPS_WALL_TIME_REASONS = ['done', 'error'];

function byTs(a, c) {
  return (a.ts ? Date.parse(a.ts) : 0) - (c.ts ? Date.parse(c.ts) : 0);
}

// plan 4136 E2: percentile summary over a raw wait-ms sample (start.waitMs values). Shared between
// the per-tool rows and the ALL-tools summary so the two never compute this shape two different
// ways. `sampleCount` is 0 (all fields null) when no `start` line in scope carried `waitMs` at
// all — the CLI renders that as "-", never as a measured 0ms wait.
function waitStats(waitMsSamples) {
  const sorted = [...waitMsSamples].sort((a, c) => a - c);
  return {
    p50Ms: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    maxMs: sorted.length ? sorted[sorted.length - 1] : null,
    sampleCount: sorted.length,
  };
}

// plan 4136 E2: the ops-level view — one logical op per TOKEN (see OPS_TERMINAL_REASONS above),
// as opposed to the window-level `completed`/`closedBy` fold above (one entry per start/close
// PAIR). `count` includes every token that ever started, whether or not it ever closed;
// `reacquiredCount` is ops whose token saw MORE THAN ONE `start` line (an actual reacquire, e.g.
// the non-ff rollback path — not merely a mid-op `release`); `openCount` is ops still open at the
// end of this journal window (the ops-view's own wedge signal, distinct from `unmatchedStarts`,
// which counts WINDOWS). `wallP50Ms`/`wallP95Ms`/`wallMaxMs` are the op's whole lifetime — first
// start to its terminal `done`/`error` close — over ops that actually reached one.
function opsStats(opsWallMs, count, reacquiredCount, openCount) {
  const sorted = [...opsWallMs].sort((a, c) => a - c);
  return {
    count,
    reacquiredCount,
    openCount,
    wallP50Ms: quantile(sorted, 0.5),
    wallP95Ms: quantile(sorted, 0.95),
    wallMaxMs: sorted.length ? sorted[sorted.length - 1] : null,
    wallSampleCount: sorted.length,
  };
}

function newToolBucket() {
  return {
    tool: null,
    completed: 0,
    durationsMs: [],
    // plan 4087 T4 (review key 3qw0gd's basis fix): durations of `done`-closed windows ONLY,
    // tracked separately from the all-close-reasons `durationsMs` above. `durationsMs` mixes in
    // `error` (often a FAST fail — an auth rejection, a quick non-ff) and `release` (a MID-op
    // handoff, not the op's own full span) — both deliberately, for the operator-facing report
    // this module already produces (see the file header's "What `release` means" section). That
    // mix is the wrong population for a consumer asking "how long does a HEALTHY op actually
    // take" (derivedReadTimeoutMs, coord-git.mjs) — a fast error-out pulls the number down, a
    // partial release window pulls it in a direction unrelated to read latency. `done`-only is the
    // closest thing this journal offers to that question.
    doneDurationsMs: [],
    closedBy: { done: 0, error: 0, healed: 0, release: 0 },
    unmatchedStarts: [],
    // plan 4136 E2: lock-ACQUIRE wait time, from `start.waitMs` — samples only lines that carry
    // it (see the file header's "waitMs" section for why an absent field is never read as zero).
    waitMsSamples: [],
    // plan 4136 E2: the ops-level view — one entry per TOKEN, not per window (see OPS_TERMINAL_REASONS
    // above). Filled in by the ops fold in computeCoordOpStats, summarized into `ops` below.
    opsCount: 0,
    opsReacquiredCount: 0,
    opsOpenCount: 0, // a token with >=1 start that never saw a terminal close in this journal window
    opsWallMs: [],
  };
}

// Fold the journal into per-tool stats. Mirrors `openCoordOps`'s pairing rule EXACTLY
// (heal-main.mjs:628-635 — a `start` opens a window for its token; ANY other phase closes the
// currently-open window for that token, `release` included; a later `start` for the same token
// reopens a fresh window) so "unmatched start" here means the same thing heal-main's
// `reportInterruptedOps` means by an open journal window. Rotation tolerance falls out of the
// same structure for free: a closing line whose `start` was rotated away simply finds no open
// entry for its token and is dropped on the floor — it is never counted as an unmatched start,
// because unmatched starts are read off what's LEFT OPEN at the end of the scan, not off
// orphaned closes.
// `nowMs` is injectable so a test pins the age of an unmatched start instead of racing the real
// clock (plan 4087 review key 1acip78); callers omit it and get the wall clock.
export function computeCoordOpStats(entries, { nowMs = Date.now() } = {}) {
  // token -> { tool, ts, pid, host }  (the currently open start for that token)
  const open = new Map();
  // plan 4136 E2: a SEPARATE per-token fold for the "ops" view — token -> { tool, firstStartMs,
  // startCount, terminalMs, terminalReason }. Distinct from `open` above (which tracks the
  // CURRENT window and is deleted/reopened by every close/start) because an op spans its token's
  // WHOLE life across any number of start/release cycles, not just its latest window.
  const opsOpen = new Map();
  const byTool = new Map();
  let skipped = 0; // genuinely malformed entries — missing phase, or missing token on a non-heal line
  // `heal-main`'s OWN report of what it fixed (heal-main.mjs:1476-1480, `phase: 'healed'`) is
  // journaled WITHOUT a token — measured on the 2026-09-22 snapshot, all 13 `healed` lines in it
  // carry no `token` field. It is not a closing line for a token-paired start/done window at
  // all; it is a standalone "heal-main ran and fixed N things this pass" event. So it can never
  // close an open window and is counted here rather than folded into the generic `skipped`
  // bucket (which would make a real, well-formed signal look like journal corruption).
  const standaloneHealed = [];

  const bucketFor = (tool) => {
    let b = byTool.get(tool);
    if (!b) {
      b = newToolBucket();
      b.tool = tool;
      byTool.set(tool, b);
    }
    return b;
  };

  for (const e of entries) {
    if (!e || typeof e !== 'object' || !e.phase) {
      skipped++;
      continue;
    }
    if (!e.token) {
      if (e.phase === 'healed') standaloneHealed.push(e);
      else skipped++;
      continue;
    }
    const tool = e.tool || 'unknown';
    if (e.phase === 'start') {
      // A second `start` for a token that is already open (no close in between) OVERWRITES the
      // prior one — same behaviour as openCoordOps, which uses a plain Map.set. The earlier
      // start is dropped: no duration is ever attributed to it and it never counts as unmatched
      // (it is gone from the map, not left open). This is existing, accepted journal semantics
      // (see the coord-git.mjs comment at :2913), not a gap this script introduces.
      open.set(e.token, { tool, ts: e.ts, pid: e.pid, host: e.host });
      // plan 4136 E2: wait-time sample — independent of how this window eventually closes (or
      // whether it closes at all in this journal window). Only lines that actually carry a
      // finite `waitMs` enter the sample (see the file header's "waitMs" section).
      if (Number.isFinite(e.waitMs)) bucketFor(tool).waitMsSamples.push(e.waitMs);
      // plan 4136 E2: the ops fold. A token already open here whose op has NOT yet terminally
      // closed is a RE-ACQUIRE (release -> start) reopening the same logical op — bump its start
      // count, keep its original firstStartMs. Anything else (first sighting of this token, or a
      // token whose prior op already terminal-closed — a test-only token reuse) starts a fresh op.
      const existingOp = opsOpen.get(e.token);
      if (existingOp && existingOp.terminalMs == null) {
        existingOp.startCount++;
      } else {
        opsOpen.set(e.token, {
          tool,
          firstStartMs: Date.parse(e.ts),
          startCount: 1,
          terminalMs: null,
          terminalReason: null,
        });
      }
      continue;
    }
    // plan 4136 E2: ops-level terminal close, checked BEFORE the window-fold's rotation-tolerance
    // bail below — an op can terminally close even when its `open` window entry is unavailable for
    // some other reason, and this must run once per closing line regardless of `startEntry`.
    const op = opsOpen.get(e.token);
    if (op && op.terminalMs == null && OPS_TERMINAL_REASONS.includes(e.phase)) {
      op.terminalMs = Date.parse(e.ts);
      op.terminalReason = e.phase;
    }
    const startEntry = open.get(e.token);
    if (!startEntry) continue; // closing line with no open start — rotated away, ignore
    open.delete(e.token);
    const reason = CLOSE_REASONS.includes(e.phase) ? e.phase : null;
    if (!reason) continue; // unknown closing phase — window closed, but not classifiable
    const startMs = Date.parse(startEntry.ts);
    const closeMs = Date.parse(e.ts);
    const b = bucketFor(startEntry.tool);
    b.closedBy[reason]++;
    if (Number.isFinite(startMs) && Number.isFinite(closeMs) && closeMs >= startMs) {
      b.completed++;
      b.durationsMs.push(closeMs - startMs);
      if (reason === 'done') b.doneDurationsMs.push(closeMs - startMs);
    }
    // else: unparseable/inverted timestamps — the close is still counted in closedBy, just not
    // in the duration sample (a bad clock must not silently poison p50/p95/max).
  }

  // plan 4136 E2: fold opsOpen into each tool's ops summary. Every token with >=1 start is a
  // logical op, closed or not; `opsOpenCount` is the ops-view's own wedge signal (distinct from
  // `unmatchedStarts`, which is windows, not ops — a token released mid-op and never reacquired
  // has an EMPTY `open` map entry, i.e. zero unmatchedStarts, yet is a genuinely unclosed op).
  for (const s of opsOpen.values()) {
    const b = bucketFor(s.tool);
    b.opsCount++;
    if (s.startCount > 1) b.opsReacquiredCount++;
    if (s.terminalMs == null) {
      b.opsOpenCount++;
    } else if (
      OPS_WALL_TIME_REASONS.includes(s.terminalReason) &&
      Number.isFinite(s.firstStartMs) &&
      s.terminalMs >= s.firstStartMs
    ) {
      b.opsWallMs.push(s.terminalMs - s.firstStartMs);
    }
  }

  // Whatever is still open at the end of the scan never closed — the wedge evidence.
  for (const [token, s] of open) {
    const b = bucketFor(s.tool);
    const startMs = Date.parse(s.ts);
    b.unmatchedStarts.push({
      token,
      ts: s.ts,
      pid: s.pid,
      host: s.host,
      ageMs: Number.isFinite(startMs) ? nowMs - startMs : null,
    });
  }

  const tools = [...byTool.values()]
    .map((b) => {
      const sorted = [...b.durationsMs].sort((a, c) => a - c);
      const sortedDone = [...b.doneDurationsMs].sort((a, c) => a - c);
      return {
        tool: b.tool,
        completed: b.completed,
        p50Ms: quantile(sorted, 0.5),
        p95Ms: quantile(sorted, 0.95),
        maxMs: sorted.length ? sorted[sorted.length - 1] : null,
        // `done`-closed windows only — see newToolBucket's doneDurationsMs comment. null when
        // this tool has zero `done` closes (e.g. every window here was released/errored/healed).
        p50DoneMs: quantile(sortedDone, 0.5),
        p95DoneMs: quantile(sortedDone, 0.95),
        maxDoneMs: sortedDone.length ? sortedDone[sortedDone.length - 1] : null,
        // plan 4087 round-4 review (keys d54f6a/12e2ce): the SIZE of the doneDurationsMs sample —
        // distinct from closedBy.done, which counts every `done`-reason close including ones whose
        // start/close timestamps didn't parse and so never entered a duration sample at all. A
        // consumer asking "is this p95 based on enough data" needs this count, not closedBy.done.
        doneSampleCount: sortedDone.length,
        closedBy: b.closedBy,
        unmatchedCount: b.unmatchedStarts.length,
        unmatchedStarts: [...b.unmatchedStarts].sort(byTs),
        // plan 4136 E2: lock-acquire wait time (see the file header's "waitMs" section) and the
        // ops-level view (see the file header's "release is NOT churn" section).
        wait: waitStats(b.waitMsSamples),
        ops: opsStats(b.opsWallMs, b.opsCount, b.opsReacquiredCount, b.opsOpenCount),
      };
    })
    .sort((a, c) => c.completed - a.completed || a.tool.localeCompare(c.tool));

  // ALL-TOOLS summary row — same fold, ignoring the tool key.
  const allDurationsMs = [...byTool.values()].flatMap((b) => b.durationsMs).sort((a, c) => a - c);
  const allDoneDurationsMs = [...byTool.values()]
    .flatMap((b) => b.doneDurationsMs)
    .sort((a, c) => a - c);
  const allClosedBy = { done: 0, error: 0, healed: 0, release: 0 };
  let allCompleted = 0;
  const allUnmatched = [];
  const allWaitMs = [];
  const allOpsWallMs = [];
  let allOpsCount = 0;
  let allOpsReacquiredCount = 0;
  let allOpsOpenCount = 0;
  for (const b of byTool.values()) {
    allCompleted += b.completed;
    for (const k of CLOSE_REASONS) allClosedBy[k] += b.closedBy[k];
    allUnmatched.push(...b.unmatchedStarts);
    allWaitMs.push(...b.waitMsSamples);
    allOpsWallMs.push(...b.opsWallMs);
    allOpsCount += b.opsCount;
    allOpsReacquiredCount += b.opsReacquiredCount;
    allOpsOpenCount += b.opsOpenCount;
  }
  allUnmatched.sort(byTs);

  const summary = {
    tool: 'ALL',
    completed: allCompleted,
    p50Ms: quantile(allDurationsMs, 0.5),
    p95Ms: quantile(allDurationsMs, 0.95),
    maxMs: allDurationsMs.length ? allDurationsMs[allDurationsMs.length - 1] : null,
    // See the per-tool p95DoneMs comment above — this is the field derivedReadTimeoutMs
    // (coord-git.mjs) actually reads.
    p50DoneMs: quantile(allDoneDurationsMs, 0.5),
    p95DoneMs: quantile(allDoneDurationsMs, 0.95),
    maxDoneMs: allDoneDurationsMs.length ? allDoneDurationsMs[allDoneDurationsMs.length - 1] : null,
    // See the per-tool doneSampleCount comment above — coord-git.mjs's readCoordOpJournalForStats
    // reads THIS (not closedBy.done) to decide whether its archive window has enough USABLE
    // duration samples yet.
    doneSampleCount: allDoneDurationsMs.length,
    closedBy: allClosedBy,
    unmatchedCount: allUnmatched.length,
    unmatchedStarts: allUnmatched,
    // plan 4136 E2 — see the matching per-tool fields above.
    wait: waitStats(allWaitMs),
    ops: opsStats(allOpsWallMs, allOpsCount, allOpsReacquiredCount, allOpsOpenCount),
  };

  return {
    tools,
    summary,
    skippedEntries: skipped,
    standaloneHealedCount: standaloneHealed.length,
  };
}

function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function printTable(stats, { badLines, totalEntries }) {
  console.log(
    `coord-op journal stats — ${totalEntries} lines parsed, ${badLines} unparseable, ${stats.skippedEntries} skipped (malformed), ` +
      `${stats.standaloneHealedCount} standalone heal-main "healed" events (tokenless, not pairable — see header comment)\n`,
  );
  const rows = [...stats.tools, stats.summary];
  const cols = [
    'tool',
    'completed',
    'p50',
    'p95',
    'max',
    'done',
    'error',
    'healed',
    'release',
    'unmatched',
  ];
  const widths = cols.map((c) => c.length);
  const rendered = rows.map((r) => [
    r.tool,
    String(r.completed),
    fmtMs(r.p50Ms),
    fmtMs(r.p95Ms),
    fmtMs(r.maxMs),
    String(r.closedBy.done),
    String(r.closedBy.error),
    String(r.closedBy.healed),
    String(r.closedBy.release),
    String(r.unmatchedCount),
  ]);
  for (const row of rendered)
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i], cell.length)));
  const pad = (s, w) => s + ' '.repeat(w - s.length);
  console.log(cols.map((c, i) => pad(c, widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rendered) console.log(row.map((c, i) => pad(c, widths[i])).join('  '));

  if (stats.summary.unmatchedCount > 0) {
    console.log(
      `\n⚠ ${stats.summary.unmatchedCount} UNMATCHED start(s) across all tools — this is the wedge evidence (a coord op that opened and never closed). Oldest first:`,
    );
    for (const u of stats.summary.unmatchedStarts.slice(0, 10)) {
      const ageS = u.ageMs == null ? 'unknown age' : `${Math.round(u.ageMs / 1000)}s old`;
      console.log(`  ts=${u.ts} pid=${u.pid} host=${u.host} token=${u.token} (${ageS})`);
    }
  } else {
    console.log('\nNo unmatched starts — every observed op closed in this journal window.');
  }

  printWaitAndOpsTables(stats);
}

// plan 4136 E2: lock-acquire wait time (start.waitMs) and the ops-level view (one row per TOKEN,
// not per start/close window — see the file header's "release is NOT churn" section for why the
// hold-window table's raw `release` count above is the wrong number to read as lock churn).
function printWaitAndOpsTables(stats) {
  const rows = [...stats.tools, stats.summary];

  console.log(
    '\nlock-acquire wait (start.waitMs — time QUEUED behind a sibling before winning the lock):',
  );
  const waitCols = ['tool', 'samples', 'p50', 'p95', 'max'];
  const waitWidths = waitCols.map((c) => c.length);
  const waitRendered = rows.map((r) => [
    r.tool,
    String(r.wait.sampleCount),
    fmtMs(r.wait.p50Ms),
    fmtMs(r.wait.p95Ms),
    fmtMs(r.wait.maxMs),
  ]);
  for (const row of waitRendered)
    row.forEach((cell, i) => (waitWidths[i] = Math.max(waitWidths[i], cell.length)));
  const pad = (s, w) => s + ' '.repeat(w - s.length);
  console.log(waitCols.map((c, i) => pad(c, waitWidths[i])).join('  '));
  console.log(waitWidths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of waitRendered) console.log(row.map((c, i) => pad(c, waitWidths[i])).join('  '));
  if (rows.every((r) => r.wait.sampleCount === 0)) {
    console.log('(no start line in this journal window carries waitMs yet — pre-plan-4136 lines)');
  }

  console.log(
    '\nops (one row per TOKEN — reacquired = needed MORE THAN ONE start; NOT the same as the release count above):',
  );
  const opsCols = ['tool', 'ops', 'reacquired', 'open', 'wallP50', 'wallP95', 'wallMax'];
  const opsWidths = opsCols.map((c) => c.length);
  const opsRendered = rows.map((r) => [
    r.tool,
    String(r.ops.count),
    String(r.ops.reacquiredCount),
    String(r.ops.openCount),
    fmtMs(r.ops.wallP50Ms),
    fmtMs(r.ops.wallP95Ms),
    fmtMs(r.ops.wallMaxMs),
  ]);
  for (const row of opsRendered)
    row.forEach((cell, i) => (opsWidths[i] = Math.max(opsWidths[i], cell.length)));
  console.log(opsCols.map((c, i) => pad(c, opsWidths[i])).join('  '));
  console.log(opsWidths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of opsRendered) console.log(row.map((c, i) => pad(c, opsWidths[i])).join('  '));
}

function main() {
  const args = process.argv.slice(2);
  const journalIdx = args.indexOf('--journal');
  const journalPath =
    journalIdx !== -1 && args[journalIdx + 1]
      ? resolve(args[journalIdx + 1])
      : coordOpJournalPath(process.cwd());
  const asJson = args.includes('--json');

  // plan 4087 T4 (review key ezbmqk): merged with the daily archives beside the live file, not
  // just the live file — see collectJournalEntries's own header.
  const { entries, badLines, totalEntries, archivePaths } = collectJournalEntries(journalPath);
  const stats = computeCoordOpStats(entries);

  if (asJson) {
    console.log(
      JSON.stringify({ journalPath, archivePaths, totalEntries, badLines, ...stats }, null, 2),
    );
    return;
  }
  console.log(
    `journal: ${journalPath}` +
      (archivePaths.length ? ` (+${archivePaths.length} daily archive file(s))` : '') +
      '\n',
  );
  printTable(stats, { badLines, totalEntries });
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
