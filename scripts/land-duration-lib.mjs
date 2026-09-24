// scripts/land-duration-lib.mjs — pure phase-attribution over pushed history (plan 2443).
//
// WHY THIS EXISTS. Land wall-clock outgrew the spine's timing assumptions twice in one
// afternoon (2026-07-25, both on plan 2391's land): plan 2414's heartbeat-staleness demote and
// plan 2433's freshen→lint precondition expiry. Each fixed its own symptom; nothing owned the
// DURATION itself, so the next assumption to outgrow the real number would fail the same way.
// This module owns it: given `origin/master`'s commit list, it attributes each land's wall-clock
// to phases, so "how long does a land actually hold the head?" is a re-runnable measurement
// instead of an anecdote. `measure-land-duration.mjs` is the CLI over it.
//
// WHAT THE MARKERS ARE. The spine already stamps its own phase boundaries onto master as coord
// commits — no new instrumentation was needed for the queue-side phases:
//
//   coord(queue): enqueue <slug> (🟩)   done-worktree enqueued: every pre-queue gate is green
//   coord(queue): mark-in-land <slug>   reached the FIFO head; the land proper starts here
//   Merge worktree-<slug>: <summary>    the ephemeral merge reached origin/master
//   coord(queue): dequeue <slug>        the land released the head slot
//
// and the merge commit's SECOND parent is the branch tip as merged — whose committer date is
// when the spine's own rebase/freshen finished re-writing it (`syncBranchOntoMaster`).
//
// THE ONE WINDOW HISTORY CANNOT SPLIT. `tip → merge` contains, in order: the post-rebase
// force-push (which runs the full `.husky/pre-push` gate battery), the ephemeral merge
// worktree's checkout, the merge itself, and the final push. Commit timestamps cannot separate
// those four — which is exactly the split plan 2443 needed, and exactly why the spine ALSO
// gained a per-phase `phases[]` block in its `.scratch/done-worktree-<slug>.result.json`
// sidecar. History-mining answers "how long", the sidecar answers "where it went".
//
// CLOCK SKEW. Every marker for a given land is committed by the SAME session on the SAME
// machine, so intra-land deltas are skew-free even though the fleet mixes a Windows host
// (+0200 committer dates) with cloud containers (+0000). Cross-land comparisons only ever use
// per-land durations, never absolute times, so skew never enters the statistics.
//
// …WITH ONE DELIBERATE EXCEPTION, ADDED BY PLAN 2467 (sonnet-review high, CONFIRMED as a real
// relaxation of the paragraph above — read this before adding a third). The waiter-arrival
// statistics (`waiters` / `waiterDelays` / `releasedHead` in joinQueueDepth) ask "did ANOTHER
// session take a slot while THIS land held its own", which is irreducibly a cross-session
// absolute-time comparison: there is no per-land duration that can express it. So the invariant
// is relaxed here on purpose, and the error is BOUNDED BY MEASUREMENT rather than assumed away:
//
//   `git log` over 21d / 26,647 commits on origin/master yields 64 commits whose PARENT carries a
//   LATER committer date than the child — an ordering violation only inter-machine clock skew can
//   produce. Magnitude: p50 38s, max 55s, and NOT ONE above 60s (2026-07-26).
//
// Note what that measurement also settles: `%ct` is epoch seconds, so the `+0200` vs `+0000` in
// the paragraph above is a DISPLAY offset, not an epoch difference — the fleet is not hours apart,
// it is under a minute apart. Consequences, in the two places it lands:
//
//   waiters/waiterDelays  a waiter arriving within ~1 min of a window boundary can be counted on
//                         the wrong side, shifting THAT sample by <60s. Against a measured p50
//                         waiter delay of 3m36s it is real but small, and it cannot move an
//                         aggregate built from hundreds of samples (8.6h vs 522.7h across the
//                         empty/busy split) — which is the only thing the numbers are used for.
//   releasedHead          worse in kind, because skew flips a BOOLEAN that excludes a whole land
//                         from every waiter statistic. Missing a real head release re-admits a
//                         wedge's inflated waiter count — exactly the fake indictment this plan
//                         removed. So that test is padded by SKEW_TOLERANCE_SEC and the padding
//                         is deliberately ASYMMETRIC IN EFFECT: it can only ever exclude more
//                         lands, never admit a wedge, and the count it excludes is reported
//                         (`headReleased`) so over-exclusion stays visible instead of silent.
//
// Re-derive the bound rather than trusting it if the fleet changes shape (a new host, an NTP
// outage): the one-liner is a parent-vs-child `%ct` comparison over `git log --format=%H|%ct|%P`.

// The landing-queue table + audit regions are landing-queue-lib.mjs's format; this module reads
// them through its parser rather than re-deriving the conventions (see parseQueueDepth).
import { parseQueue } from './coord/landing-queue-lib.mjs';

// Padding for the ONE cross-session boundary test that must not produce a false negative (see
// CLOCK SKEW above). 120s is >2x the measured 55s worst case, so a genuine head release cannot
// slip outside a land's window through skew alone.
export const SKEW_TOLERANCE_SEC = 120;

// A land whose branch tip predates its own enqueue was never re-written by the spine's rebase
// (the branch was already on the tip — the plan-972 fast path, or a straight-to-head land), so
// `tip → merge` is NOT a measurement of that land's own work: it is however long the branch sat
// around before landing. Such samples are CLASSIFIED OUT of the tipToMerge statistic and
// counted, never silently dropped and never truncated to a magic ceiling.
export const NO_REBASE = 'no-rebase';

const RX_ENQUEUE = /^coord\(queue\): enqueue (\S+)/;
const RX_DEQUEUE = /^coord\(queue\): dequeue (\S+)$/;
const RX_MARK_IN_LAND = /^coord\(queue\): mark-in-land (\S+)$/;
const RX_MERGE = /^Merge worktree-(\S+?): /;

// A land's slot ACQUISITION — the moment it took the queue entry it ultimately landed on.
// `enqueue` is the normal path; `reenter` (plan 2170's rework re-entry, which re-inserts by the
// preserved enqueue stamp) acquires a slot too, and is what a rework-dequeued land ultimately
// rides. `requeue` / `demote` are deliberately NOT here: they MOVE an entry that already exists,
// so the slug's depth-at-acquisition is still the one its enqueue/reenter recorded. Measured
// 2026-07-26 over 21d: 916 enqueues to 2 reenters, so including reenter changes one land's
// number — but omitting it would silently read a STALE depth from before that land's rework.
const RX_SLOT_ACQUIRE = /^coord\(queue\): (enqueue|reenter) (\S+)/;

// Parse `git log --format=%H|%ct|%P|%s` output into commit records. Order is preserved
// verbatim (git's newest-first); every consumer below indexes rather than assuming order.
export function parseCommitLog(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    // the subject is the LAST field and may itself contain '|' — split off exactly 3 heads.
    const i1 = line.indexOf('|');
    const i2 = line.indexOf('|', i1 + 1);
    const i3 = line.indexOf('|', i2 + 1);
    if (i1 < 0 || i2 < 0 || i3 < 0) continue;
    const sha = line.slice(0, i1);
    const ct = Number(line.slice(i1 + 1, i2));
    const parents = line.slice(i2 + 1, i3).trim();
    const subject = line.slice(i3 + 1);
    if (!sha || !Number.isFinite(ct)) continue;
    out.push({ sha, ct, parents: parents ? parents.split(/\s+/) : [], subject });
  }
  return out;
}

// Attribute every `Merge worktree-<slug>` in `commits` to its phase boundaries.
// Returns one record per merge, newest-first (the order merges appear in `commits`).
export function attributeLands(commits) {
  const byCt = new Map(); // sha → committer epoch, for the second-parent lookup
  for (const c of commits) byCt.set(c.sha, c.ct);

  // slug → sorted ascending epoch list, per marker kind
  const enqueues = new Map();
  const dequeues = new Map();
  const marks = new Map();
  const push = (map, slug, ct) => {
    if (!map.has(slug)) map.set(slug, []);
    map.get(slug).push(ct);
  };
  for (const c of commits) {
    let m;
    if ((m = RX_ENQUEUE.exec(c.subject))) push(enqueues, m[1], c.ct);
    else if ((m = RX_DEQUEUE.exec(c.subject))) push(dequeues, m[1], c.ct);
    else if ((m = RX_MARK_IN_LAND.exec(c.subject))) push(marks, m[1], c.ct);
  }
  for (const map of [enqueues, dequeues, marks])
    for (const a of map.values()) a.sort((x, y) => x - y);

  // latest marker at or before `at` / earliest at or after `at` — a slug can legitimately land
  // more than once in a window (a re-parked plan re-claimed later), so every lookup is anchored
  // to THIS merge's timestamp rather than taking the slug's only/first occurrence.
  const latestAtOrBefore = (map, slug, at) => {
    const a = map.get(slug);
    if (!a) return null;
    let best = null;
    for (const t of a) if (t <= at) best = t;
    return best;
  };
  const earliestAtOrAfter = (map, slug, at) => {
    const a = map.get(slug);
    if (!a) return null;
    for (const t of a) if (t >= at) return t;
    return null;
  };

  const lands = [];
  for (const c of commits) {
    const m = RX_MERGE.exec(c.subject);
    if (!m) continue;
    const slug = m[1].replace(/^worktree-/, '');
    const mergeAt = c.ct;
    // parents[1] is the merged branch tip; null when it falls outside the fetched window
    // (a shallow clone's boundary) — the sample then simply has no tipToMerge.
    const tipAt = c.parents.length > 1 ? (byCt.get(c.parents[1]) ?? null) : null;
    const enqueueAt = latestAtOrBefore(enqueues, slug, mergeAt);
    const markAt = latestAtOrBefore(marks, slug, mergeAt);
    const dequeueAt = earliestAtOrAfter(dequeues, slug, mergeAt);

    // the classification that keeps tipToMerge honest (see NO_REBASE above)
    const rebased = tipAt != null && enqueueAt != null ? tipAt >= enqueueAt : tipAt != null;

    lands.push({
      slug,
      mergeSha: c.sha,
      mergeAt,
      tipAt,
      enqueueAt,
      markAt,
      dequeueAt,
      classification: tipAt == null ? null : rebased ? null : NO_REBASE,
      // tip → merge: post-rebase force-push (FULL .husky/pre-push battery) + ephemeral merge
      // worktree checkout + merge + push. The window plan 2443 exists to split.
      tipToMerge: rebased && tipAt != null ? mergeAt - tipAt : null,
      // merge → dequeue: close-out (plan archive + INDEX regen + board removal + teardown).
      closeOut: dequeueAt != null ? dequeueAt - mergeAt : null,
      // mark-in-land → dequeue: the HEAD-HOLD — what every waiter behind this land pays.
      headHold: markAt != null && dequeueAt != null ? dequeueAt - markAt : null,
      // enqueue → dequeue: total time holding a queue slot, wait included.
      enqueueToDequeue: enqueueAt != null && dequeueAt != null ? dequeueAt - enqueueAt : null,
    });
  }
  return lands;
}

// Nearest-rank percentile over a numeric array (p in [0,1]). Empty → null.
export function percentile(values, p) {
  const a = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
  return a[idx];
}

export const PHASES = ['tipToMerge', 'closeOut', 'headHold', 'enqueueToDequeue'];

// Per-phase {n, p50, p90, max} plus the counts that keep the sample honest.
export function summarize(lands) {
  const stats = {};
  for (const phase of PHASES) stats[phase] = statsFor(lands.map((l) => l[phase]));
  return {
    lands: lands.length,
    noRebase: lands.filter((l) => l.classification === NO_REBASE).length,
    tipUnknown: lands.filter((l) => l.tipAt == null).length,
    phases: stats,
  };
}

// The `.husky/pre-push` battery is DIFF-SCOPED, so "how long do the gates take" has no single
// answer — a gate-heavy diff pays cross-package tsc + vitest tiers + next build + the WebKit
// mobile gate, a scripts-only diff pays the node:test battery alone, a docs diff pays almost
// nothing. Bucketing tip→merge by diff shape is what turns one misleading median into the four
// numbers a shrink decision actually needs.
//
// THIS IS A DELIBERATE APPROXIMATION, NOT A MIRROR OF THE HOOK (sonnet-review high, CONFIRMED).
// `.husky/pre-push` scopes ~10 gates independently, and some triggers are not path prefixes at
// all (CLAUDE.md scopes the mobile gate to "any landing / composer / mobile diff"). Nothing
// forces this classifier to track that, so **it will drift** — which matters, because plan 2443
// exists to stop stale timing assumptions and a measurement tool can harbour one just as easily
// as the spine can. Two mitigations, both deliberate: the buckets are named for what they are
// (a COST CLASS, not a source-tree region — hence `gateHeavy`, not `appSource`), and any
// consumer needing precision is told here to re-derive the triggers from `.husky/pre-push`
// rather than trust these prefixes. Treat the output as descriptive, never normative.
//
// `gateHeavy` includes `backend/tests/` because the tier-2 FULL backend suite fires on
// `backend/src` OR `backend/tests` (.husky/pre-push, "Tier 2") — a bucket keyed on "app source"
// alone silently filed those lands as cheap. Order matters: gateHeavy is tested first.
export const SHAPES = ['gateHeavy', 'scriptsOnly', 'docsOnly', 'other'];
const GATE_HEAVY_RX = /^(frontend\/src|backend\/src|shared\/src|backend\/tests)\//;
const DOCSY = (f) => f.startsWith('docs/') || f.startsWith('wiki/');

// Classify one land by the paths its branch changed. `files` is the merge's own diff
// (`git diff --name-only <merge>^1...<merge>^2`). An empty diff classifies as 'other'.
export function classifyDiffShape(files) {
  if (!files || !files.length) return 'other';
  if (files.some((f) => GATE_HEAVY_RX.test(f))) return 'gateHeavy';
  if (files.every(DOCSY)) return 'docsOnly';
  if (files.every((f) => f.startsWith('scripts/') || f.startsWith('.husky/') || DOCSY(f))) {
    return 'scriptsOnly';
  }
  return 'other';
}

// The one aggregation both summarize() and summarizeByShape() report, so a field added here
// (or a percentile edge case fixed here) can never reach one caller and miss the other — the
// duplication this replaces had already drifted, with `max` present in one and absent in the
// other (sonnet-review high, CONFIRMED).
export function statsFor(values) {
  const vals = values.filter((v) => Number.isFinite(v));
  return {
    n: vals.length,
    p50: percentile(vals, 0.5),
    p90: percentile(vals, 0.9),
    max: vals.length ? Math.max(...vals) : null,
  };
}

// { <shape>: {n, p50, p90, max} } over whichever phase is asked for (default tipToMerge).
// `shapeOf(land)` supplies the classification — the caller owns the git spawn, so this stays pure.
export function summarizeByShape(lands, shapeOf, phase = 'tipToMerge') {
  const buckets = {};
  for (const shape of SHAPES) buckets[shape] = [];
  for (const l of lands) {
    if (!Number.isFinite(l[phase])) continue;
    const shape = shapeOf(l);
    if (shape && buckets[shape]) buckets[shape].push(l[phase]);
  }
  const out = {};
  for (const shape of SHAPES) out[shape] = statsFor(buckets[shape]);
  return out;
}

// --- depth-at-enqueue: was the queue EMPTY when this land took its slot? (plan 2467) ----------
//
// WHY THIS DIMENSION EXISTS. Plan 2458 moved the pre-push gate battery off the queue head for a
// land that enqueues BEHIND someone, and deliberately did not cover the empty-queue case (its
// acceptance criterion 1) — an empty queue makes you the head by construction, so there is no
// window in which a prep can run without racing the merge. Sizing that gap needs two numbers
// history alone had never been asked for: how often a battery-running land arrives at an empty
// queue, and — the one that actually decides it — whether anybody ever queues up behind it
// during the window. An empty-queue land holds the head against NOBODY unless a waiter arrives.
//
// DEPTH COMES FROM THE QUEUE DOC, NOT FROM THE MARKER TIMELINE. Reconstructing depth by
// overlapping enqueue→dequeue intervals silently misses every demote, steal, requeue and reap
// that reorders or removes an entry without a matching marker pair. The doc as the acquiring
// commit LEFT it is the acquiring session's own observation of the queue, which is exactly the
// quantity wanted. Validated 2026-07-26 over 21d/918 acquisitions: all 369 depth==1 events are
// also position 1 (an empty queue means you are head), and every event's slug is present in the
// table its own commit wrote (no silent parse misses).

// Count the queue rows in a landing-queue doc snapshot (a master-history
// `docs/handoff/landing-queue.md` before plan 3973's cut-over, the queue ref's `landing-queue.md`
// after — the caller reads it, this parses it) and locate `slug` in them.
// Returns `{depth, position}` (position 1-based, 0 when absent) or null when the sentinels are
// missing — a snapshot predating the table, not an empty queue, and the two must never collapse
// into each other (a depth of 0 would read as "the queue was empty", the opposite of "unknown").
//
// The table's COLUMN FORMAT is owned by landing-queue-lib.mjs, so this delegates to its
// `parseQueue` rather than re-deriving the header/separator/cell conventions (sonnet-review high,
// CONFIRMED: a hand-rolled copy here would silently read the old shape after any future column
// change — plans 504/2266/2275/2328 have each added one). `parseQueue` THROWS on missing
// sentinels, which is exactly the null case.
export function parseQueueDepth(text, slug) {
  let entries;
  try {
    entries = parseQueue(String(text || '')).entries;
  } catch {
    return null;
  }
  return { depth: entries.length, position: entries.findIndex((e) => e.slug === slug) + 1 };
}

// A HEAD RELEASE — the land stopped being the head partway through its own slot window, so any
// waiter still queued after that point was waiting on somebody ELSE. Attributing their wait to
// this land is the mistake that makes an "empty-queue land blocked 24 waiters for 4 hours"
// headline out of a land that stepped off the head at minute 34 and spent the next 3.5 hours at
// the tail (`2361-Infra-render-screenshot-tiering-drive-archive`, 2026-07-26 — 90% of the raw
// empty-queue waiter aggregate came from 8 such lands; 83.6h raw -> 8.6h attributable).
//
// These come from the queue doc's APPEND-ONLY audit region, not from commit subjects, for one
// decisive reason: `coord(queue): demote stale not-landing head to tail — waiter <slug>` names
// the DEMOTER, not the demoted head, so a subject-only reader silently mis-attributes all 94
// auto-demotes in the window. The audit line names the displaced entry in every verb.
const RX_AUDIT_DEMOTE = /^-\s*(\S+)\s+—\s+auto-demote:\s+(\S+)\s+→\s+tail/;
// plan 3000: an OPERATOR override moves the head to the tail on operator authority rather
// than on a staleness reading. For this module the authority is irrelevant and the RELEASE
// is everything — an overridden head lost the slot exactly as a demoted one did, so omitting
// it would leave `releasedHead` false and re-admit that land's unattributable waiters into
// the headline aggregate: precisely the mis-attribution this parser exists to prevent.
const RX_AUDIT_OPERATOR_DEMOTE = /^-\s*(\S+)\s+—\s+operator-demote:\s+(\S+)\s+→\s+tail/;
const RX_AUDIT_REQUEUE = /^-\s*(\S+)\s+—\s+(\S+)\s+requeued to tail/;
const RX_AUDIT_STEAL = /^-\s*(\S+)\s+—\s+\S+\s+stole the head slot from\s+(\S+)/;

// Parse the `<!-- AUDIT-START -->`…`<!-- AUDIT-END -->` region of a landing-queue doc snapshot
// into head-release events: `[{ct, slug, verb}]`, where `slug` is the entry that LOST the head
// and `ct` is the audit line's own ISO stamp in epoch seconds. Unparseable / unstamped lines are
// skipped rather than guessed at. Read the region at HEAD — it is append-only, so the newest
// snapshot carries every event in the window.
export function parseQueueAudit(text) {
  let auditLines;
  try {
    // Region extraction is landing-queue-lib.mjs's job (same single-owner reason as
    // parseQueueDepth above); only the VERB GRAMMAR below is this module's own reading of it.
    auditLines = parseQueue(String(text || '')).auditLines;
  } catch {
    return [];
  }
  const out = [];
  for (const t of auditLines) {
    let m, verb;
    if ((m = RX_AUDIT_DEMOTE.exec(t))) verb = 'demote';
    else if ((m = RX_AUDIT_OPERATOR_DEMOTE.exec(t))) verb = 'operator-demote';
    else if ((m = RX_AUDIT_STEAL.exec(t))) verb = 'steal';
    else if ((m = RX_AUDIT_REQUEUE.exec(t))) verb = 'requeue';
    else continue;
    const ms = Date.parse(m[1]);
    if (!Number.isFinite(ms)) continue;
    out.push({ ct: Math.floor(ms / 1000), slug: m[2], verb });
  }
  return out.sort((a, b) => a.ct - b.ct);
}

// Every slot-acquisition commit in `commits`, ascending by committer date.
// `[{kind: 'enqueue'|'reenter', slug, ct, sha}]`.
export function slotAcquisitions(commits) {
  const out = [];
  for (const c of commits) {
    const m = RX_SLOT_ACQUIRE.exec(c.subject);
    if (m) out.push({ kind: m[1], slug: m[2], ct: c.ct, sha: c.sha });
  }
  return out.sort((a, b) => a.ct - b.ct);
}

// Attach the depth dimension to each land. `depthAt(sha, slug)` returns
// `{depth, position} | null` — the caller owns the git spawn, so this stays pure (same contract
// as summarizeByShape's `shapeOf`). Fields added per land:
//
//   acquireAt / acquireSha / acquireKind  the slot acquisition this land actually rode
//   depthAtEnqueue                        queue rows right after that acquisition (1 == empty)
//   slotWindow                            acquisition → dequeue: the whole time the slot is held
//   waiters / waiterDelays                acquisitions arriving INSIDE that window, and for each,
//                                         how much of this land's remaining window it sat through
//   releasedHead                          true if this land lost the head mid-window (demote /
//                                         operator-demote / requeue-to-tail / steal), which makes `waiters` NOT
//                                         attributable to it — see RX_AUDIT_* above
//
// A land with no resolvable acquisition or no dequeue keeps null for all of them rather than
// being dropped — the caller decides what an unmeasurable sample means for its own statistic.
export function joinQueueDepth(lands, acquisitions, depthAt, { audit = [] } = {}) {
  const acqs = [...acquisitions].sort((a, b) => a.ct - b.ct);
  return lands.map((l) => {
    // The acquisition this land rode is the LATEST at-or-before its merge — a slug can land more
    // than once in a window, and a rework re-entry supersedes the original enqueue.
    let mine = null;
    for (const a of acqs) if (a.slug === l.slug && a.ct <= l.mergeAt) mine = a;
    const base = {
      ...l,
      acquireAt: null,
      acquireSha: null,
      acquireKind: null,
      depthAtEnqueue: null,
      slotWindow: null,
      waiters: null,
      waiterDelays: null,
      releasedHead: null,
    };
    if (!mine) return base;
    const d = depthAt(mine.sha, mine.slug);
    const out = {
      ...base,
      acquireAt: mine.ct,
      acquireSha: mine.sha,
      acquireKind: mine.kind,
      depthAtEnqueue: d ? d.depth : null,
    };
    if (l.dequeueAt == null) return out;
    // Padded OUTWARD, like releasedHead but for the opposite reason. Skew can put a boundary
    // waiter on either side of the window; widening means the waiter count and every aggregate
    // built from it are a deliberate UPPER BOUND on what an empty-queue head costs. That biases
    // the number AGAINST this plan's own CLOSE recommendation, which is the direction a
    // measurement used to argue "don't build it" has to err in (sonnet-review high, CONFIRMED
    // that the unpadded form was the one unguarded cross-machine comparison left in the module).
    const waiters = acqs.filter(
      (a) =>
        a.slug !== l.slug &&
        a.ct > mine.ct - SKEW_TOLERANCE_SEC &&
        a.ct < l.dequeueAt + SKEW_TOLERANCE_SEC,
    );
    return {
      ...out,
      slotWindow: l.dequeueAt - mine.ct,
      waiters: waiters.length,
      // Clamped at 0: the outward padding above admits arrivals up to SKEW_TOLERANCE_SEC AFTER
      // the dequeue, and `dequeueAt - ct` is NEGATIVE for those — a negative "delay" is not a
      // shorter wait, it is a nonsense sample that SUBTRACTS from the aggregate. (Caught by
      // re-measuring after adding the padding: the waiter count rose while the aggregate fell.)
      waiterDelays: waiters.map((w) => Math.max(0, l.dequeueAt - w.ct)),
      // Padded by SKEW_TOLERANCE_SEC: a false NEGATIVE here re-admits a wedge's unattributable
      // waiters into the headline aggregate, so the window is widened rather than tightened.
      // See § CLOCK SKEW at the top of this file for the measured bound this 120s covers.
      releasedHead: audit.some(
        (e) =>
          e.slug === l.slug &&
          e.ct > mine.ct - SKEW_TOLERANCE_SEC &&
          e.ct < l.dequeueAt + SKEW_TOLERANCE_SEC,
      ),
    };
  });
}

export const DEPTH_BUCKETS = ['empty', 'busy'];

// `{ empty: {...}, busy: {...} }` over whichever phase is asked for, each bucket carrying the
// phase stats PLUS the waiter-arrival numbers that size the empty-queue case:
//   lands            how many lands fell in this bucket at all
//   headReleased     how many lost the head mid-window — EXCLUDED from every waiter statistic
//   withWaiter       how many of the remainder had a waiter arrive inside their slot window
//   waiterDelay      stats over each attributable waiter's delay behind this bucket's heads
//   aggregateWaitSec total attributable waiter-seconds behind this bucket's heads
//
// THE WAITER STATISTICS EXCLUDE HEAD-RELEASED LANDS, and say so via `headReleased` rather than
// dropping them silently (the same discipline `summarize`'s `noRebase` count applies to
// tip→merge). A land that was demoted / requeued / stolen from partway through its window did
// not block the waiters who arrived after that point, and counting them turns one wedged land
// into a fake indictment of battery placement: on 2026-07-26 eight such lands carried 90% of the
// raw empty-queue aggregate. Lands with no resolvable depth are skipped entirely; a land with a
// depth but an unmeasurable phase still counts toward `lands`/`withWaiter` (the phase sample
// shrinks on its own, as elsewhere).
export function summarizeByDepth(lands, phase = 'tipToMerge') {
  const out = {};
  for (const bucket of DEPTH_BUCKETS) {
    const set = lands.filter(
      (l) =>
        Number.isFinite(l.depthAtEnqueue) &&
        (bucket === 'empty' ? l.depthAtEnqueue === 1 : l.depthAtEnqueue > 1),
    );
    const attributable = set.filter((l) => !l.releasedHead);
    const delays = attributable.flatMap((l) => l.waiterDelays || []);
    out[bucket] = {
      ...statsFor(set.map((l) => l[phase])),
      lands: set.length,
      headReleased: set.filter((l) => l.releasedHead).length,
      withWaiter: attributable.filter((l) => l.waiters > 0).length,
      slotWindow: statsFor(set.map((l) => l.slotWindow)),
      waiterDelay: statsFor(delays),
      aggregateWaitSec: delays.reduce((a, b) => a + b, 0),
    };
  }
  return out;
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m${String(s).padStart(2, '0')}s` : `${m}m`;
}
