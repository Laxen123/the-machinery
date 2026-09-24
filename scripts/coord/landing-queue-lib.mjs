// scripts/coord/landing-queue-lib.mjs (plan 504)
// Pure, git-free FIFO landing-queue math. The queue is a markdown table between
// QUEUE-START/QUEUE-END sentinels in the queue document (head = first data row =
// next to land), plus an audit list between AUDIT-START/AUDIT-END (steal events).
// Since plan 3973 that document is the one file in the tree of the coord ref
// `refs/heads/coord/landing-queue`, read and written ONLY through
// landing-queue-ref.mjs (`readQueueDoc` / `mutateQueueRef`); the master-side
// `docs/handoff/landing-queue.md` is a one-line tombstone (QUEUE_TOMBSTONE below).
// Ordering is race-safe FOR FREE under the CAS write: enqueue-appends commute —
// the non-ff loser re-parses the winner's fresh base and appends AFTER it, so
// push order on origin = queue order (the next-plan-id reserve-by-push idea).
// No fs, no child_process, no git — total functions only (done-worktree-lib model).

import { ageMinutes } from './landing-lock.mjs';
// same pipe-table parsing the board uses — one copy (review fix, plan 504)
import { cellsOf, isSeparator, splitBoard, landingRows } from './board-lib.mjs';
// plan 3450 review round 2 (G4): the repository-wide slug grammar, REUSED rather than
// re-rolled. claim-plan-lib.mjs is the entry-point validator (mint/claim call sites) but the
// grammar itself lives in the LEAF module slug-charset.mjs (plan 3450 round 3), which
// claim-plan-lib.mjs re-exports from — importing it here directly, instead of through
// claim-plan-lib.mjs, keeps this module git-free/fs-free (no coord-config -> coord-git ->
// board-write-gate chain), preserving its "leaf" half of the header contract. `(sweep)`
// already fails this charset — so the reserved-ghost guard at the bottom of this file is a
// NAMING of that one rule, never a second, weaker copy that can drift away from it.
import { assertSlugCharset } from './slug-charset.mjs';

export const QUEUE_START = '<!-- QUEUE-START -->';
export const QUEUE_END = '<!-- QUEUE-END -->';
export const AUDIT_START = '<!-- AUDIT-START -->';
export const AUDIT_END = '<!-- AUDIT-END -->';

// A head whose heartbeat is older than this is steal-eligible (the waiter must
// ALSO confirm the holder is gone — see landing-queue.mjs steal). 45 min clears
// the longest observed legitimate hold (a conflict resolution + rebuild) while
// keeping a crashed head from wedging the fleet for hours.
export const DEFAULT_STEAL_STALE_MIN = 45;

// plan 2266: `pid` is APPENDED as the last column (never inserted mid-row) so a
// pre-2266 reader's positional cells[0..5] reads are untouched — only a NEW trailing
// cell exists for it to ignore. Stamped by markHeadAcquired (done-worktree.mjs) at
// head-acquisition, riding the existing heartbeat command; absent on older entries
// (parses to null) and on any entry a pre-2266 session's renderQueue re-renders.
//
// plan 2275: `state` is the next trailing-append column (same back-compat trick).
// Values: '' (normal) | 'HOLDING' (the head seamed out at LAND_BLOCKED_HOLDING —
// parked on rework, provably NOT inside the merge window) | 'IN_LAND' (plan 2414: the
// head reached position 1 and is inside the merge/gate window — see IN_LAND_STATE
// below). Stamped/cleared only by the done-worktree spine via `landing-queue.mjs
// mark-holding` / `mark-in-land`; HOLDING keys the bounded overtake (overtakeVerdict
// below), IN_LAND keys demote's liveness-backed immunity (demoteVerdict below). The
// two values share one column deliberately — they are mutually exclusive head phases
// (parked-off-spine vs actively-in-the-merge-window), and a stamp of one always
// overwrites the other. A pre-2275/pre-2414 session's renderQueue drops the cell —
// fail-safe: a lost stamp only ever REFUSES an overtake/demote-immunity, never enables
// one.
//
// plan 2331: `reapArmedIso` is the next trailing-append column — the arm-then-fire
// grace start for the auto-reap verb (reapVerdict below). '' / absent → null (not
// armed). Stamped only on the current head by the CLI's reap arm pass; cleared
// (never carried) by heartbeatEntry / requeueEntry / setEntryState below, so a
// fresh residency (or a resumed HOLDING head) never inherits a stale arm.
//
// plan 2328: `priority` is the next trailing-append column (same back-compat trick).
// '⚡' → true (a priority land — enqueue inserted it at the front block, see
// insertPriorityEntry); '' / absent → false (a normal FIFO append, and every
// pre-2328 entry). Fed by done-worktree from the plan's `priority: high`
// frontmatter at enqueue time. A pre-2328 session's renderQueue drops the cell —
// fail-safe: a lost stamp only ever demotes the entry to NORMAL insertion class
// for future inserts around it, never corrupts ordering already in place.
// plan 2485: `progressIso` is the next trailing-append column — the LAND-PROGRESS
// stamp, deliberately a SECOND cell rather than a re-use of `heartbeatIso`. The two
// answer different questions, and the demote gate needs the second one:
//   heartbeatIso — "some process associated with this entry is alive". Refreshed by
//     EVERY heartbeat caller, including the plan-1805 pre-convergence rounds and the
//     plan-2085 near-head self-arm, whose interval (SELF_ARM_HEARTBEAT_SEC =
//     DEFAULT_DEMOTE_STALE_MIN * 60 / 3) is DERIVED FROM the demote threshold — so an
//     alive session's entry is structurally guaranteed to read fresh forever.
//   progressIso — "the land spine completed a step that moves this entry toward merge".
//     Stamped ONLY by done-worktree's per-completed-step and head-acquisition heartbeat
//     calls (`landing-queue.mjs heartbeat --progress`); never by a watcher tick, a
//     near-head self-arm, or a pre-convergence rebase round.
// That split is what makes a head that is ALIVE BUT NOT CONVERGING visible to the
// convergence axis (DEFAULT_CONVERGE_STALE_MIN below) — the failure mode plan 1682's
// liveness-only gate can never fire on. A pre-2485 session's renderQueue drops the cell
// — fail-safe in the established direction: an absent stamp parses to null and the
// convergence axis REFUSES (degrading exactly to pre-2485 behaviour), never fires on a
// head whose progress it cannot read.
// plan 3814 review fix (F4): exported so reconcile-board.mjs can require the parsed queue
// content to actually CONTAIN this row before trusting the parse — parseQueue itself returns
// `entries: []` without throwing when both sentinel pairs survive but the header/data rows are
// gone, which otherwise reads as a verified, genuinely-empty queue.
export const HEADER =
  '| slug | lane | session | host | enqueued | heartbeat | pid | state | reap-armed | priority | progress |';
const SEPARATOR = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';

// plan 3814 review round 4: parseQueue's ROW-ADMISSION FLOOR, as a named export rather than a
// bare `6` inlined in its loop. reconcile-board.mjs's queue-header verifier must agree with this
// parser about what a readable queue row is: if the verifier's threshold is looser, a document
// parseQueue silently drops every row of reads as a VERIFIED, genuinely-empty queue, and the
// reporter then offers `release-claim --force` against a claim whose live queue slot it simply
// could not see — the exact destructive false positive plan 3814 exists to remove. Round 3 kept
// the two in lockstep with a comment; a comment is not a mechanism, so the constant now has ONE
// owner and both readers import it (the same single-definition discipline plan 2818 applied to
// the board-state strings).
export const MIN_QUEUE_ROW_CELLS = 6;

// The header row's FIRST CELL, derived from HEADER itself rather than typed as a literal — the
// one marker that tells the table's header apart from a data row (plan 3973 review round 4).
// Deliberately not a byte-exact HEADER comparison: a doc written by a session predating one of
// the trailing-append columns above carries a NARROWER header, and refusing to read it would
// turn a legible queue into a fault (the same tolerance `reconcile-board.mjs`'s queue-header
// verifier settled on). A data row's first cell is a plan slug (`<id>-<desc>`), never this word.
const HEADER_FIRST_CELL = cellsOf(HEADER)[0];

// plan 3973 T3: the ONLY content the master-side `docs/handoff/landing-queue.md` carries after
// the cut-over — a pointer at the ref. Any reader that finds a NON-tombstone master doc beside a
// live ref fails loudly and names the heal (landing-queue-ref.mjs `migrateNeededMessage`), so an
// old-code session writing the retired transport is caught, never silently merged.
export const QUEUE_TOMBSTONE =
  '<!-- landing-queue: moved to refs/heads/coord/landing-queue (plan 3973); read it with ' +
  '`node scripts/landing-queue.mjs status`, never edit this file -->\n';

/** Is `text` the master-doc tombstone (tolerant of trailing whitespace / CRLF)? */
export function isQueueTombstone(text) {
  const t = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  return t === QUEUE_TOMBSTONE.trim();
}

export function initialQueueDoc() {
  return [
    '# Landing queue — FIFO ordering for done-worktree lands (plan 504)',
    '',
    '> Write ONLY via `node scripts/landing-queue.mjs`. Since plan 3973 this document lives on the',
    '> coord ref `refs/heads/coord/landing-queue` (CAS-written, never a master commit); read it',
    '> with `node scripts/landing-queue.mjs status`. Head of the table = next to land;',
    '> push order on origin = queue order. ALL lands enqueue, 🟩 included — any master advance',
    '> invalidates the head 🟥 rebase, so exempting 🟩 reintroduces the livelock.',
    '',
    QUEUE_START,
    HEADER,
    SEPARATOR,
    QUEUE_END,
    '',
    '## Audit (steals)',
    '',
    AUDIT_START,
    AUDIT_END,
    '',
  ].join('\n');
}

function regionOf(content, start, end, label) {
  const s = content.indexOf(start);
  const e = content.indexOf(end);
  if (s === -1 || e === -1 || e < s) {
    throw new Error(
      `landing-queue-lib: ${label} sentinels not found (is this the landing-queue file?)`,
    );
  }
  return { s: s + start.length, e };
}

/**
 * @returns {{entries: object[], auditLines: string[], sawHeader: boolean}} throws when sentinels
 * are missing. `sawHeader` reports whether the QUEUE region carried the table's ACTUAL header —
 * the `| slug | … |` row plus the `| --- | … |` separator under it, the pair `initialQueueDoc()`
 * and `renderQueue` always emit together (plan 3973 review round 3, keys 79758c / d836ca; round
 * 4, keys c6fdd6 / 91cf4a / 1b2fc7 / 5af1eb / 4915ec / 574172). The sentinels can survive a
 * corrupt write that lost the header, and THAT text parses to `entries: []` — indistinguishable
 * from an empty queue unless the caller asks. Round 3's flag answered the weaker question "was
 * there a table row at all", so a corrupt doc that lost its header while KEEPING a live waiter
 * row read as a valid empty queue (the waiter was consumed as the header), and the next mutation
 * would have rewritten the doc without it. `landing-queue-ref.mjs`'s one validation point is the
 * caller that asks; an empty queue rendered by `initialQueueDoc()` always carries its header.
 */
export function parseQueue(content) {
  const q = regionOf(content, QUEUE_START, QUEUE_END, 'QUEUE');
  const a = regionOf(content, AUDIT_START, AUDIT_END, 'AUDIT');
  const entries = [];
  let seenHeader = false;
  let headerRow = false; // the row in header position really IS the header
  let headerSeparator = false; // …and its `| --- | … |` separator followed it
  for (const line of content.slice(q.s, q.e).split('\n')) {
    if (isSeparator(line)) {
      if (seenHeader) headerSeparator = true;
      continue;
    }
    const cells = cellsOf(line);
    if (!cells || cells.length < MIN_QUEUE_ROW_CELLS) continue;
    if (!seenHeader) {
      seenHeader = true; // first table row = header POSITION …
      headerRow = cells[0] === HEADER_FIRST_CELL; // … and this says it is the header itself
      continue;
    }
    entries.push({
      slug: cells[0],
      lane: cells[1],
      session: cells[2],
      host: cells[3],
      enqueuedIso: cells[4],
      heartbeatIso: cells[5],
      // cells[6] is absent (undefined) on a pre-2266 6-column row OR a blank trailing
      // cell — both collapse to null via `||` (an empty-string pid is never meaningful).
      pid: cells[6] || null,
      // cells[7] (plan 2275): '' / absent → null (not holding); 'HOLDING' → parked head.
      state: cells[7] || null,
      // cells[8] (plan 2331): '' / absent → null (not armed); an ISO timestamp → the
      // arm-then-fire grace start.
      reapArmedIso: cells[8] || null,
      // cells[9] (plan 2328): any non-empty cell → priority (the writer stamps '⚡');
      // '' / absent (every pre-2328 row) → false — a field-less legacy entry is normal.
      priority: Boolean(cells[9]),
      // cells[10] (plan 2485): '' / absent → null (no land-progress stamp in this
      // residency) → the convergence axis abstains. An ISO timestamp → the last
      // spine-step/head-acquisition progress stamp.
      progressIso: cells[10] || null,
    });
  }
  const auditLines = content
    .slice(a.s, a.e)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '));
  return { entries, auditLines, sawHeader: headerRow && headerSeparator };
}

/**
 * One entry's canonical table row — EVERY column, in the document's own spelling. Exported
 * (plan 3973 review) because the master-vs-ref divergence check in landing-queue-ref.mjs must
 * compare whole rows, not slug sets: an old-code writer that changes `heartbeatIso`, `state`,
 * `pid` or `progressIso` on an existing slug is exactly the drift that check exists to catch,
 * and re-deriving a second row serializer there would put two spellings of one row in the repo.
 */
export const renderQueueRow = (e) =>
  `| ${e.slug} | ${e.lane} | ${e.session} | ${e.host} | ${e.enqueuedIso} | ${e.heartbeatIso} | ${e.pid ?? ''} | ${e.state ?? ''} | ${e.reapArmedIso ?? ''} | ${e.priority ? '⚡' : ''} | ${e.progressIso ?? ''} |`;

/** Regenerative render: replaces BOTH sentinel regions, preserving surrounding prose. */
export function renderQueue(content, entries, auditLines) {
  const table = [HEADER, SEPARATOR, ...entries.map(renderQueueRow)].join('\n');
  const audit = (auditLines || []).join('\n');
  const withTable = replaceRegion(content, QUEUE_START, QUEUE_END, table);
  return replaceRegion(withTable, AUDIT_START, AUDIT_END, audit);
}

function replaceRegion(content, start, end, inner) {
  const { s, e } = regionOf(content, start, end, 'render');
  const body = inner ? `\n${inner}\n` : '\n';
  return content.slice(0, s) + body + content.slice(e);
}

// ── plan 2482: single-owner audit-line grammar ─────────────────────────────────────
// The seven append-only audit line templates below are each written from exactly one
// place (four here — applyDemote, which owns BOTH demote templates, plus
// applySteal/applyOvertake/the reap apply further down
// — plus requeueAuditLine/reenterAuditLine, which replace what used to be two inline
// template strings in landing-queue.mjs). Before this, every READER of these lines
// (this file's own demoteAuditCount/overtakeAuditCount, plus
// mine-sonnet-lane-executor-telemetry.mjs's mineQueueContention) derived its own regex
// set independently of the writers and of each other, so a wording change to any
// template could silently zero an un-updated reader's count (plan 2482's motivating
// incident: mineQueueContention had drifted to have no steal case at all). This is now
// the one parser every reader goes through.
//
// `slug` is always the entry the event happened TO (the demoted/reaped/requeued/
// re-entered head, the steal VICTIM, the overtaken HOLDING head) — never the actor
// (demoter/stealer/overtaker/waiter), which the demote/steal/overtake templates also
// name in the line. Binding the wrong party to `slug` is exactly the trap a naive
// regex falls into (the SAME trap land-duration-lib.mjs's still-unmerged private
// parser was written to avoid); the actor is available separately as `actor` for a
// caller that wants it. Unmatched lines return `null` — a line that matches no verb
// template must be distinguishable from a matched one, not silently skipped as if it
// were an empty result.
// Every regex ends `(.*)$` — a captured-but-usually-empty trailing group, matching
// RX_AUDIT_STEAL/RX_AUDIT_REQUEUE's existing convention — rather than a bare `$`, so a
// future template extension (a trailing note, the same shape steal/requeue already
// carry) degrades to "the new suffix is ignored" instead of "the whole line stops
// matching and the reader's count silently drops to zero" (review [1], plan 2482).
const RX_AUDIT_DEMOTE = /^- (\S+) — auto-demote: (\S+) → tail \(([^)]*)\) by (\S+)(.*)$/;
// plan 3000: the OPERATOR-OVERRIDE demote gets its OWN template and verb, deliberately not a
// suffix on the auto-demote line. Execution note 4 requires the two counters to stay
// SEPARABLE (an override must not spend the ≤2/24h automatic starvation budget), and a
// separate verb makes that separation structural: `demoteAuditCount` matches on
// `parseAuditLine`'s exact verb, so an operator line can never be counted as an auto one —
// no marker-substring discipline required, and no future wording tweak can silently merge
// the two counts. `operatorDemoteAuditCount` below is its twin reader.
const RX_AUDIT_OPERATOR_DEMOTE =
  /^- (\S+) — operator-demote: (\S+) → tail \(([^)]*)\) by (\S+)(.*)$/;
const RX_AUDIT_STEAL = /^- (\S+) — (\S+) stole the head slot from (\S+) \(heartbeat ([^)]*)\)(.*)$/;
const RX_AUDIT_OVERTAKE = /^- (\S+) — overtake: (\S+) past HOLDING head (\S+) → position 2(.*)$/;
const RX_AUDIT_REAP = /^- (\S+) — reap: (\S+) removed by (\S+) \(heartbeat ([^)]*)\)(.*)$/;
const RX_AUDIT_REQUEUE = /^- (\S+) — (\S+) requeued to tail(.*)$/;
// plan 2170's preserved-position re-entry (below) is READ-ONLY history since plan 2517
// reversed it — reenterAuditLine no longer WRITES this shape, but historical audit lines
// still carry it and must still parse.
const RX_AUDIT_REENTER =
  /^- (\S+) — (\S+) re-entered at preserved enqueuedIso (\S+) \(post-rework, plan 2170\)(.*)$/;
// plan 2517: rework re-entry is now a plain TAIL append (operator ruling — "a plan carries
// no priority... it re-enters at the TAIL") — this is the shape reenterAuditLine writes now.
const RX_AUDIT_REENTER_TAIL = /^- (\S+) — (\S+) re-entered at TAIL \(post-rework, plan 2517\)(.*)$/;

/**
 * Parse one audit-region line into `{verb, iso, slug, actor, detail}` (fields beyond
 * verb/iso/slug vary by verb — see the per-verb regex above); `null` when the line
 * matches none of the seven verb templates.
 */
export function parseAuditLine(line) {
  const t = String(line ?? '').trim();
  let m;
  if ((m = RX_AUDIT_DEMOTE.exec(t))) {
    return { verb: 'demote', iso: m[1], slug: m[2], detail: m[3], actor: m[4] };
  }
  if ((m = RX_AUDIT_OPERATOR_DEMOTE.exec(t))) {
    return { verb: 'operator-demote', iso: m[1], slug: m[2], detail: m[3], actor: m[4] };
  }
  if ((m = RX_AUDIT_STEAL.exec(t))) {
    return { verb: 'steal', iso: m[1], slug: m[3], actor: m[2], detail: m[4], note: m[5] };
  }
  if ((m = RX_AUDIT_OVERTAKE.exec(t))) {
    return { verb: 'overtake', iso: m[1], slug: m[3], actor: m[2] };
  }
  if ((m = RX_AUDIT_REAP.exec(t))) {
    return { verb: 'reap', iso: m[1], slug: m[2], actor: m[3], detail: m[4] };
  }
  if ((m = RX_AUDIT_REQUEUE.exec(t))) {
    return { verb: 'requeue', iso: m[1], slug: m[2], note: m[3] };
  }
  if ((m = RX_AUDIT_REENTER.exec(t))) {
    return { verb: 'reenter', iso: m[1], slug: m[2], enqueuedIso: m[3] };
  }
  if ((m = RX_AUDIT_REENTER_TAIL.exec(t))) {
    return { verb: 'reenter', iso: m[1], slug: m[2] };
  }
  return null;
}

/**
 * Parse the AUDIT-START/AUDIT-END region of a full `landing-queue.md` snapshot into
 * an array of matched `parseAuditLine` results (unmatched lines dropped). Region
 * extraction is `parseQueue`'s job (review [4]/[5]: this used to re-derive the same
 * slice/split/trim/filter sequence independently, a second copy of the exact "reader
 * silently drifts from the source of truth" risk this plan exists to remove) — reused
 * here rather than re-run, so there is one extraction AND one grammar. Throws when
 * either sentinel pair is missing (parseQueue requires both QUEUE and AUDIT).
 */
export function parseAuditRegion(content) {
  return parseQueue(content).auditLines.map(parseAuditLine).filter(Boolean);
}

/** Writer for the requeue audit line — was an inline template in landing-queue.mjs cmdRequeue. */
export function requeueAuditLine(nowIso, slug, note) {
  return `- ${nowIso} — ${slug} requeued to tail${note ? ` — ${note}` : ''}`;
}

/**
 * Writer for the reenter audit line — was an inline template in landing-queue.mjs
 * cmdReenter. plan 2517: tail wording — there is no preserved position left to name (see
 * RX_AUDIT_REENTER above for the plan-2170 shape this replaces, which parseAuditLine
 * still reads for history).
 */
export function reenterAuditLine(nowIso, slug) {
  return `- ${nowIso} — ${slug} re-entered at TAIL (post-rework, plan 2517)`;
}

/** FIFO append; idempotent — an already-queued slug keeps its position AND timestamps. */
export function enqueueEntry(entries, entry) {
  // plan 3450 review round 2 (G4): the reserved/charset refusal lives HERE, at the seam where
  // entries are created, not only in the CLI's dispatch table — see assertWritableSlug.
  assertWritableSlug(entry?.slug);
  if (entries.some((e) => e.slug === entry.slug)) return entries;
  return [...entries, entry];
}

// ── plan 2328: the priority front block ────────────────────────────────────────────
// Index just past the queue's FRONT BLOCK: the head plus the CONTIGUOUS run of
// priority-flagged entries behind it. Always ≥ 1 on a non-empty queue (the head is in
// the block whatever its own flag says — position 1 is sacred, never displaced). A
// priority entry sitting DEEPER in the queue (e.g. moved to the tail by requeue/demote
// rework) is deliberately outside the block: it lost its front position to an explicit
// verb, and new priority inserts must not resurrect it as an insertion anchor.
export function frontBlockEnd(entries) {
  let i = 1;
  while (i < entries.length && entries[i].priority) i++;
  return i;
}

// Priority insertion (plan 2328): insert at the SMALLEST position where every entry
// ahead is the head or a priority entry — i.e. immediately after the front block, so
// the head is NEVER displaced (whether or not it is mid-land: the queue's
// serialization of the merge-push is untouched) and multiple priority entries stay
// FIFO among themselves. Idempotent like enqueueEntry (a crashed re-invoke keeps the
// existing position and timestamps). Ordering under coordWrite: this insert does not
// commute with a concurrent append the way tail-appends do, but it is deterministic
// given the same entry set, and the rebase-retry replays the mutation on the winner's
// fresh base (plan 2517: reenterEntry no longer has an analogous sorted re-insertion —
// it is now a plain tail append, same as enqueueEntry).
export function insertPriorityEntry(entries, entry) {
  // The SECOND creating seam — same guard, same reason (plan 3450 review round 2, G4).
  assertWritableSlug(entry?.slug);
  if (entries.some((e) => e.slug === entry.slug)) return entries;
  if (!entries.length) return [entry];
  const idx = frontBlockEnd(entries);
  return [...entries.slice(0, idx), entry, ...entries.slice(idx)];
}

export function dequeueEntry(entries, slug) {
  return entries.filter((e) => e.slug !== slug);
}

// Reap orphaned entries by GROUND TRUTH: an entry whose plan has landed (its file
// is in plans/archive/, so isLanded(slug) === true) is an orphan — the land's
// self-dequeue either crashed before it ran (teardown crash) or a racing invoke
// re-enqueued the slug after it ran. Unlike heartbeat-staleness (which a
// legitimate WAITING entry also has — nothing refreshes a non-head heartbeat),
// "plan is archived" can never false-positive on a live waiter (whose plan is in
// in-progress/). Total; pure given the predicate. (plan 574)
export function pruneLanded(entries, isLanded) {
  return entries.filter((e) => !isLanded(e.slug));
}

// plan 1364 Ship 3: the BATCH analogue of pruneLanded's ground-truth check. A single-plan
// entry's ground truth is "its plan file is in plans/archive/"; a batch-slugged entry (see
// claim-plan.mjs batch — the slug always starts with "batch-") has no such plan file at all,
// so that ground truth can never fire for it. Its OWN ground truth is the OPPOSITE polarity:
// done-worktree's batch close-out deletes the manifest docs/handoff/batches/<slug>.json in the
// SAME atomic commit that archives every member (see done-worktree.mjs closeOutBatch) — so a
// batch entry whose manifest is GONE has landed; one whose manifest still EXISTS is still live
// (in flight, or not even claimed yet) and must never be pruned. Mirrors pruneLanded's
// signature (entries + predicate(s)) so the CLI can compose them side by side: pruneLanded for
// single-plan entries, this for batch entries. `isBatchSlug` / `manifestExists` are pure
// predicates the caller supplies (the IO — reading plans/archive/ or the manifest path — lives
// in landing-queue.mjs, not here).
export function pruneLandedBatches(entries, isBatchSlug, manifestExists) {
  return entries.filter((e) => !(isBatchSlug(e.slug) && !manifestExists(e.slug)));
}

// Refresh heartbeatIso for `slug` only; absent slug → unchanged. `pid` (plan 2266) is
// OPTIONAL and additive: passed only at head-acquisition (markHeadAcquired), riding this
// same call so a fresh residency's process identity lands in the queue entry itself, not
// just the local land-attempt sidecar. `undefined` (every OTHER heartbeat call site, e.g.
// the per-spine-step liveness stamps) leaves a previously-stamped pid untouched — a plain
// liveness heartbeat must never blank out the mechanical-steal evidence a HEAD acquisition
// wrote earlier in the same residency.
//
// plan 2331: a heartbeat ALWAYS clears `reapArmedIso` — "the head is alive enough to
// heartbeat" is exactly the signal that disarms a reap-in-progress (the arm-then-fire
// grace's own re-verdict-inside-mutate then sees an unarmed head and re-arms instead of
// firing). Applies to every heartbeat call regardless of the slug's queue position — the
// field is only ever load-bearing on the current head, so clearing it elsewhere is inert.
// plan 2485: `progress` is the LAND-PROGRESS half of the split (see the progressIso
// column note in the header). `false` — the DEFAULT, and what every watcher tick, the
// plan-2085 near-head self-arm and the plan-1805 pre-convergence rounds pass — refreshes
// liveness ONLY and leaves any earlier progress stamp exactly where it was, so the
// convergence clock keeps running while a merely-alive process ticks. `true` (the spine's
// per-completed-step and head-acquisition calls) additionally stamps progressIso, which
// is the only thing that resets that clock. Opting in explicitly, rather than stamping on
// every heartbeat, is the whole mechanism: an overloaded stamp is precisely what made a
// non-converging head invisible to plan 1682's gate.
export function heartbeatEntry(entries, slug, nowIso, pid = undefined, progress = false) {
  return entries.map((e) =>
    e.slug === slug
      ? {
          ...e,
          heartbeatIso: nowIso,
          reapArmedIso: null,
          ...(pid !== undefined ? { pid } : {}),
          ...(progress ? { progressIso: nowIso } : {}),
        }
      : e,
  );
}

// plan 2603: the READ half of the ref-transport heartbeat. A flagless ping no longer
// writes the queue doc at all — it stamps refs/coord/queue-heartbeat/<slug> (see
// queue-heartbeat-ref.mjs for why that channel, and for the two asymmetric fail-safes) —
// so every verdict that reads heartbeat AGE must first fold the ref stamps over the doc's
// own cells. Folding here, once, is what keeps stealVerdict / demoteVerdict / reapVerdict
// / printStatus reading a single `heartbeatIso` field with none of their staleness math
// changed. Pure by this file's contract: the caller supplies the already-read map (slug ->
// { ts, progressIso }), this does no I/O.
//
// Three rules, each load-bearing:
//   1. max(), never overwrite — the doc still carries the stamps from the heartbeats that
//      DO ride a coordWrite (--pid, --state IN_LAND), and those can be the newer of the two.
//   2. a stamp at or before the entry's enqueuedIso is IGNORED — otherwise a leftover ref
//      from a previous residency of the same slug would make a freshly-enqueued entry look
//      alive. An unparseable enqueuedIso keeps the stamp (that direction only ever refuses
//      a destructive verb).
//   3. reapArmedIso is voided by a newer effective heartbeat — reproducing, reader-side,
//      the unconditional arm-clear that heartbeatEntry did while pings still wrote the doc.
//      Without it a ref-pinged head that LATER went genuinely stale would be reaped with no
//      fresh grace period, because its arm stamp from the previous stale window survived.
export function decorateWithHeartbeatRefs(entries, refMap) {
  if (!refMap || Object.keys(refMap).length === 0) return entries;
  const newer = (a, b) => {
    const ta = Date.parse(a ?? '');
    const tb = Date.parse(b ?? '');
    if (Number.isNaN(tb)) return a ?? null;
    if (Number.isNaN(ta)) return b;
    return tb > ta ? b : a;
  };
  return entries.map((e) => {
    const stamp = refMap[e.slug];
    if (!stamp) return e;
    const enq = Date.parse(e.enqueuedIso ?? '');
    const st = Date.parse(stamp.ts);
    if (Number.isNaN(st)) return e;
    if (!Number.isNaN(enq) && st <= enq) return e;
    const heartbeatIso = newer(e.heartbeatIso, stamp.ts);
    const progressIso = newer(e.progressIso, stamp.progressIso);
    const armVoided =
      e.reapArmedIso != null && newer(e.reapArmedIso, heartbeatIso) === heartbeatIso;
    return {
      ...e,
      heartbeatIso,
      progressIso,
      ...(armVoided ? { reapArmedIso: null } : {}),
    };
  });
}

// plan 1528 Phase B: move `slug` to the TAIL with fresh timestamps (lane/session/host
// carried from the existing entry) — the dequeue+enqueue pair as ONE pure transform, so
// the CLI's single coordWrite commit can never end dequeued-but-not-enqueued (B4(a)).
// An ABSENT slug (stolen/reaped mid-flight) appends `fallback` instead when provided
// (the caller supplies its own lane/session/host) — the requeue's whole point is that
// the plan re-enters the queue, so vanishing entirely is never an acceptable outcome.
export function requeueEntry(entries, slug, nowIso, fallback = null) {
  const existing = entries.find((e) => e.slug === slug) || fallback;
  const rest = entries.filter((e) => e.slug !== slug);
  if (!existing) return { entries: rest, entry: null };
  // The THIRD creating seam (plan 3450 review round 3, H5). Round 2's G4 guarded enqueueEntry
  // and insertPriorityEntry but not this one, and requeue WRITES a row like they do — a caller
  // supplying a `fallback` with `foo|bar`, `(sweep)`, a space, or no slug at all persisted a
  // malformed table row that `cellsOf` then mis-parsed, leaving the entry undequeueable and
  // every later sweep refusing to judge the head. The assert covers the `existing` branch too:
  // that entry came from parseQueue, so a row that trips this guard is a queue ALREADY
  // corrupt, and moving it to the tail would only re-render the corruption.
  assertWritableSlug(existing.slug);
  // review 2275 F2: a moved entry is by definition no longer the parked head, so the
  // plan-2275 `state` cell is CLEARED here, not carried — a HOLDING stamp surviving a
  // requeue/demote would make the entry falsely overtake-eligible when it later cycles
  // back to head as a normal, actively-progressing land. plan 2331: `reapArmedIso` is
  // cleared for the identical reason — a moved entry is "no longer head" by definition,
  // so a stale arm must never survive to its next residency at head.
  // plan 2328 (sonnet-review CONFIRMED finding): `priority` is cleared too — a
  // requeue/demote is an explicit standing-revoking verb (the entry earned the tail),
  // and a ⚡ flag riding to the back would wedge overtakeVerdict's leapfrog guard
  // forever ("would leapfrog X" naming an entry with no front-block standing left).
  // The operator's frontmatter stamp is untouched — the plan's next REAL enqueue
  // (done-worktree re-reads the stamp) re-enters the front block.
  // plan 2485: `progressIso` is cleared for the same "no longer head" reason — a moved
  // entry starts a FRESH residency, and a progress stamp from the residency it just lost
  // would either credit the new one with work it has not done or (once stale) make it
  // convergence-demotable the instant it next reaches the head, before its spine has had
  // any chance to stamp. Cleared → the axis abstains until the new residency's
  // head-acquisition stamp lands, which is the fail-safe direction.
  const entry = {
    ...existing,
    enqueuedIso: nowIso,
    heartbeatIso: nowIso,
    state: null,
    reapArmedIso: null,
    priority: false,
    progressIso: null,
  };
  return { entries: [...rest, entry], entry };
}

// plan 2517 (supersedes plan 2170 Ship 2's POSITION-PRESERVING re-entry): rework
// re-entry after a dequeue-on-rework is now a PLAIN TAIL enqueue — behaviorally
// identical to enqueueEntry's idempotent append. Operator ruling: "a plan carries no
// priority... it shouldn't hog the head if it's not ready" — re-entering at the
// preserved original position (the old behaviour) quietly re-granted the priority the
// 2026-07-10 "any session that isn't ready must leave its space at the head" directive
// removed, and the "no back-of-queue starvation" rationale that justified it is gone
// with it. This also drops the plan-2328 priority-class-aware sorted insertion: a ⚡
// re-entrant lands at the tail like anyone else and sits OUTSIDE the front block (the
// same fate a ⚡ entry moved to the tail by requeue/demote already gets — see
// requeueEntry's front-block-standing comment). The "never displace the in-flight
// head" invariant plan 2170 hand-rolled via a floor/ceil clamp is now trivially true
// of any tail append. Kept as a distinct export (rather than inlining enqueueEntry at
// the one call site) so the CLI's `reenter` verb — which still exists to write a
// distinct plan-2517 audit line, telling a rework re-entry apart from a first-time
// enqueue — has a stable name to import. Pure; idempotent like enqueueEntry (a slug
// already queued → entries unchanged, so a crashed re-invoke can re-run reenter
// without duplicating).
export function reenterEntry(entries, entry) {
  return enqueueEntry(entries, entry);
}

/** 1-based queue position; 0 when absent. */
export function positionOf(entries, slug) {
  return entries.findIndex((e) => e.slug === slug) + 1;
}

export function headOf(entries) {
  return entries.length ? entries[0] : null;
}

// The ONE eligibility skeleton for both head-displacement verbs (steal / demote):
// head-exists, caller-is-head, verb-specific membership, then the heartbeat-staleness
// math (stale > staleMin, or unparseable — corrupt can't be proven healthy, consistent
// with landing-lock's lockVerdict). Factored per review 1682 [3]: twin hand-rolled
// skeletons on a coord-mutex surface are exactly where an F-008-class hole gets fixed
// in one verb and stays live in the other. Verb layers (holder-gone confirmation,
// starvation cap) stay in the callers. `membership(entries, caller)` returns a refusal
// reason or null; it runs BEFORE the staleness math (both verbs' historical order).
function headDisplacementVerdict({
  entries,
  caller,
  nowMs,
  staleMin,
  verb,
  freshSuffix,
  membership,
  // plan 2485: an OPTIONAL second staleness axis, supplied only by demote. Called with the
  // resolved head when the liveness axis reads FRESH (i.e. exactly where this function used
  // to refuse outright); a returned string overrides that refusal and carries the verdict,
  // `null`/absent keeps the pre-2485 behaviour byte-for-byte. Steal and reap pass nothing:
  // both are premised on a head whose HOLDER IS GONE (steal requires
  // --confirm-holder-gone; reap REMOVES the entry), and an alive-but-not-converging head
  // is the opposite of gone — moving it to the tail is the right remedy, removing it is
  // not. Keeping the axis demote-only is also what plan 2485's boundary asks for (steal
  // semantics are plan 2414's surface, explicitly do-not-touch).
  alternateStaleness = null,
  // plan 3000: the operator-authority bypass, supplied only by demote. `true` clears BOTH
  // staleness axes — and only those. Every STRUCTURAL gate above still runs first: the queue
  // must have a head, the caller must not BE that head, and the verb's own membership rule
  // must pass. Those are not judgments about whether the head is busy (which is what an
  // override overrules), they are what makes the resulting move well-formed at all; an
  // override that skipped them would corrupt the queue rather than reorder it.
  operatorOverride = false,
}) {
  const head = headOf(entries);
  if (!head) return { ok: false, reason: `queue is empty — nothing to ${verb}` };
  if (head.slug === caller) {
    return { ok: false, reason: `${caller} is already head of the queue` };
  }
  const memberRefusal = membership(entries, caller);
  if (memberRefusal) return { ok: false, reason: memberRefusal };
  const ageMin = ageMinutes(head.heartbeatIso, nowMs);
  // The age is still MEASURED under an override — it is what the CLI's loud pre-action
  // warning reports (execution note 5: print what is being discarded) — it just no longer
  // decides anything.
  if (operatorOverride) {
    return { ok: true, head, ageMin, staleAxis: OPERATOR_AXIS, staleReason: null };
  }
  // plan 2334 review [2]: the ONE freshness comparison — shared with the waiter-side local
  // pre-checks below (headHeartbeatLocallyFresh) rather than hand-copied there, so the
  // boundary minute cannot drift between this gate and the pre-check that predicts it.
  if (ageIsFresh(ageMin, staleMin)) {
    // `alternateStaleness` returns the FULL reading (see convergenceInfo), not just a
    // predicate, so the numbers the gate judged against travel with the verdict instead of
    // being re-derived downstream against a later clock (review [6]).
    const alt = alternateStaleness ? alternateStaleness(head) : null;
    if (!alt?.stale) {
      return {
        ok: false,
        reason: `head ${head.slug} heartbeat is fresh (age ${ageMin}m ≤ ${staleMin}m) — ${freshSuffix}`,
        head,
        ageMin,
      };
    }
    // Past the liveness gate on the convergence axis alone. `staleAxis` names which axis
    // carried the verdict so every downstream consumer (the audit line, the CLI's operator
    // output) reports the real reason instead of a heartbeat age that was never stale.
    return {
      ok: true,
      head,
      ageMin,
      staleAxis: CONVERGE_AXIS,
      staleReason: alt.reason,
      convergeBound: alt.bound,
      convergeProgressMin: alt.progressMin,
    };
  }
  return { ok: true, head, ageMin, staleAxis: HEARTBEAT_AXIS, staleReason: null };
}

// The single freshness predicate every staleness-keyed verb (and every local pre-check that
// predicts one) compares through. `null` = unparseable/absent heartbeat, which is never
// "fresh" — a corrupt stamp can't prove a head healthy (stealVerdict's founding semantics).
export function ageIsFresh(ageMin, staleMin) {
  return ageMin != null && ageMin <= staleMin;
}

// Steal eligibility — the deterministic age math only; the CLI layers the "holder
// actually gone" confirmation on top.
export function stealVerdict({ entries, stealer, nowMs, staleMin = DEFAULT_STEAL_STALE_MIN }) {
  return headDisplacementVerdict({
    entries,
    caller: stealer,
    nowMs,
    staleMin,
    verb: 'steal',
    freshSuffix: 'not steal-eligible',
    // F-008 (plan 1313 coord audit): a steal may only promote the queue's OWN second-in-line
    // entry — never an arbitrary/unqueued `stealer` argument. Without this membership check, a
    // ghost slug that was never enqueued still gets `ok:true`, and applySteal blindly drops the
    // head, silently promoting the REAL position-2 entry while the caller believes IT now holds
    // the FIFO land slot. Requiring `entries[1]?.slug === stealer` closes that.
    membership: (es, caller) =>
      es[1]?.slug !== caller
        ? es[1]
          ? `${caller} is not queued second-in-line (that's ${es[1].slug}) — a steal may only promote the queue's own next entry`
          : `${caller} is not queued at all — nothing to promote`
        : null,
  });
}

// Remove the head on a verified steal; the audit line is appended to the doc's audit
// region. `note` (plan 2266) is an optional trailing annotation — the CLI passes one to
// mark a MECHANICAL reap (vs the pre-2266 plain/manual steal text, unchanged when omitted).
export function applySteal(entries, stealer, nowIso, ageMin, note) {
  const head = headOf(entries);
  const age = ageMin == null ? 'unparseable heartbeat' : `stale ${ageMin}m`;
  const suffix = note ? ` — ${note}` : '';
  return {
    entries: entries.slice(1),
    auditLine: `- ${nowIso} — ${stealer} stole the head slot from ${head.slug} (heartbeat ${age})${suffix}`,
  };
}

// ── plan 2266: mechanical holder-gone verdict ──────────────────────────────────────
// The steal path (above) has always demanded a HUMAN --confirm-holder-gone assertion —
// correct when nothing else can prove the holder is gone, but the 2208 incident showed
// a genuinely dead head can wedge the FIFO for hours until an operator happens to notice
// and manually steals. This gives a WAITER a mechanical alternative: given the head's
// recorded {host, pid} (stamped at head-acquisition by markHeadAcquired, riding
// heartbeatEntry's optional pid arg above) and a liveness probe the CLI already ran (kept
// out of this pure function — no process.kill here, only the boolean the caller measured,
// consistent with this file's "no fs, no child_process" contract), decide whether the
// holder can be declared gone WITHOUT asking a human. Cross-host heads and heads with no
// recorded pid (pre-2266 entries, or a residency whose stamp write failed/raced) always
// fall back to the existing manual --confirm-holder-gone path — a foreign pid can never be
// probed, and "no evidence" must never read as "verified gone".
export function mechanicalHolderGoneVerdict({ head, probingHost, pidRunning }) {
  if (!head.host || head.host !== probingHost) {
    return {
      mechanical: false,
      reason:
        `head host ${head.host || '?'} differs from this prober's host ${probingHost} — ` +
        `a foreign pid cannot be verified`,
    };
  }
  const pid = Number(head.pid);
  if (!head.pid || !Number.isFinite(pid) || pid <= 0) {
    return {
      mechanical: false,
      reason: 'head carries no recorded pid — mechanical verification unavailable',
    };
  }
  if (pidRunning) {
    return {
      mechanical: false,
      reason: `pid ${pid} on ${head.host} is still running — holder is NOT gone`,
    };
  }
  return { mechanical: true, reason: `pid ${pid} on ${head.host} verified not running` };
}

// plan 2280: the mechanical steal path's two GUARANTEED-refusal preconditions above (cross-host
// head, no recorded pid) need no fresh fetch or subprocess to evaluate — a caller already
// holding a slug-scoped `landing-queue.mjs status --json` payload (which carries headHost/
// headPid, same fields as `head.host`/`head.pid` above) can check them locally and skip
// spawning `landing-queue.mjs steal` (and the git fetch inside it) when it would only be
// refused for a reason already knowable here. A same-host head WITH a recorded pid still
// needs the real CLI — only it can probe pid liveness (mechanicalHolderGoneVerdict's third
// condition) — so this returns true (spawn it) in that case, same as any pre-2266 caller
// would have done. Deliberately duplicated on BOTH waiter call sites (done-worktree.mjs,
// landing-queue-watch.mjs) as a single shared import, not two hand-rolled copies — see the
// review-1682-lesson comment at done-worktree.mjs's demote/steal call site.
//
// review fix (plan 2280): reuses mechanicalHolderGoneVerdict itself (pidRunning:false is a
// fixed placeholder — unknowable locally, and irrelevant to eligibility either way) rather
// than re-deriving the pid-validity check with a bare `Boolean(headPid)` — the earlier draft
// treated a malformed pid ("0", "-1", "abc") as valid evidence, which mechanicalHolderGoneVerdict
// itself refuses as "no recorded pid"; a bare Boolean() check would have reported eligible on
// exactly the input its own docstring says must fall back. Single source of truth for what
// counts as a usable pid.
export function stealLocallyEligible({ headHost, headPid, probingHost }) {
  return mechanicalHolderGoneVerdict({
    head: { host: headHost, pid: headPid },
    probingHost,
    pidRunning: false,
  }).mechanical;
}

// plan 1462: batch-aware holder-liveness for the steal-verifier. A BATCH land's
// 🟢 LANDING mutex marker lives on a representative MEMBER board row (claim-plan.mjs
// batch never creates a batch-slug row; done-worktree resolves the marker onto the
// first present member row via resolveBatchLandingRow → landingBoardSlug, plan 1454).
// So the steal recovery convention — "verify the holder is gone by looking up the
// queue slug's board row" — is BLIND for a batch: the batch slug has no row, so a
// verifier reads "no LANDING" and could steal the head of a batch that is actively
// mid-LANDING (a FIFO double-land). Given the board content and the batch's member
// PLAN IDS (from its claim manifest), this returns the member row slugs currently
// holding 🟢 LANDING. A non-empty result ⇒ the holder is NOT gone; the caller refuses
// the steal even under --confirm-holder-gone.
//
// A member row's slug is its plan basename `<id>-<desc>` (claim-plan.mjs batch's
// rowSlug == the plan file basename; every plan file is `<id>-…​.md`), so a LANDING
// row is matched to this batch by its leading plan id. board-lib.landingRows is
// column-exact (State cell === '🟢 LANDING'), so a resume-prose mention of the marker
// in some other row never false-matches. Pure (git-/fs-free): the CLI reads the fresh
// origin/master board + manifest and passes them in. An unparseable board yields [] —
// consistent with board-lib.landingRows / boardHasRow treating a broken board as "no
// marker"; the steal path still has its own >stale-min heartbeat gate on top.
export function batchMemberLandingRows(boardContent, memberIds) {
  let body;
  try {
    body = splitBoard(boardContent).body;
  } catch {
    return [];
  }
  const ids = new Set((memberIds || []).map(String));
  const out = [];
  for (const line of landingRows(body)) {
    const slug = cellsOf(line)?.[0];
    const id = slug && (slug.match(/^(\d{3,})-/) || [])[1];
    if (id && ids.has(id)) out.push(slug);
  }
  return out;
}

// ── plan 1682: waiter-side auto-demote of a not-ready head ─────────────────────────
// The missing middle ground between plan 1528's in-spine requeue trip (only evaluated
// at halt sites INSIDE an active done-worktree run) and the 45-min steal (which REMOVES
// the entry and so demands proof the holder is GONE). The 1674 incident (2026-07-10):
// a head requeued into an empty queue (tail = head), then triaged + re-reviewed OUTSIDE
// the spine while waiters piled up behind it — live, so unstealable; outside the spine,
// so the 1528 trip never re-evaluated. A demote lets a blocked WAITER move such a head
// to the TAIL: liveness-keyed (heartbeat age + 🟢 LANDING board row), never marker-keyed
// — which is exactly why the plan-1240 Group C objections to auto-release-at-head
// (keep-hot rebase staling the review sha; the legit --resume REVIEW_NEEDED path) do
// not apply here. It MOVES the entry (requeueEntry), never removes it.

// A head silent this long, holding no 🟢 LANDING row, is presumed off-spine (reworking/
// reviewing). Must clear the spine's longest heartbeat gap: the post-rebase stamp →
// merge-step window, where the master push's pre-push battery can run ~7 min (and the
// plan-984 retry-once can double it). 15 min clears that p95 while cutting a hog's
// blocking window to a third of the 45-min steal threshold.
export const DEFAULT_DEMOTE_STALE_MIN = 15;
// Starvation cap (mirrors done-worktree-lib REQUEUE_MAX): past this many auto-demotes
// of one slug inside the window, waiters must hold — the steal path is the remaining
// recourse for a genuinely dead head. Without it, a slow-but-live session could be
// demoted forever and never land.
export const DEMOTE_CAP = 2;
export const DEMOTE_CAP_WINDOW_MIN = 24 * 60;

// plan 2485 — the CONVERGENCE axis threshold. A head that keeps heartbeating but has not
// stamped land PROGRESS (progressIso, see the column note in the header) for this long is
// presumed alive-but-not-converging, and becomes demote-eligible even though the liveness
// gate above reads it as perfectly fresh.
//
// WHY A SECOND AXIS AND NOT A BIGGER staleMin: DEFAULT_DEMOTE_STALE_MIN can never fire on
// this class at ANY size. The plan-2085 near-head self-arm heartbeats every
// DEFAULT_DEMOTE_STALE_MIN*60/3 seconds BY CONSTRUCTION, so raising the threshold raises
// the masking with it. Only a stamp the self-arm does not write can distinguish the two.
//
// SIZING (measured 2026-07-26, `measure-land-duration.mjs --days 21 --by-depth`, 310 lands
// on origin/master; the plan's own baseline re-run). The bound must sit ABOVE the healthy
// population's max inter-progress gap, not at its median:
//   - tip→merge (the whole progress-stamping work phase): p50 6m52s / p90 13m12s /
//     p99 17m54s / MAX 23m23s over n=297. Progress is stamped at each completed spine
//     step, so a single healthy gap is bounded ABOVE by that whole-phase max: 23m23s.
//   - 45 min is therefore ~1.9x the worst gap any healthy land in the window produced,
//     and it matches the leash a genuinely-landing IN_LAND head already gets
//     (DEFAULT_STEAL_STALE_MIN) — one coherent "you get 45 minutes to show progress"
//     story across both immunities. Declared as its OWN constant, not an alias, so
//     re-tuning one axis later cannot silently move the other.
//   - HEAD TENURE was evaluated as the axis and REJECTED: healthy (never-head-released)
//     head tenure runs p50 15.7m / p90 1.34h / p99 2.60h / max 10.43h, overlapping the
//     head-released population (40.9m … 11.40h) almost completely. Any tenure bound above
//     the healthy max would have caught 1 of 23 measured cases. Time-since-progress
//     separates the populations; time-at-head does not.
// A false positive is cheap and bounded by design: a demote MOVES the head to the tail
// (never dequeues), is capped at DEMOTE_CAP per 24h, and IN_LAND / 🟢 LANDING heads are
// immune — so the worst case is one extra requeue of a head that really was working.
export const DEFAULT_CONVERGE_STALE_MIN = 45;

// The IN_LAND head's LONGER convergence leash, and the one deliberate deviation from plan
// 2485's literal acceptance invariant 1 ("the same head inside IN_LAND … never [becomes
// eligible]"). Taken literally, a blanket IN_LAND exemption makes this whole axis a NO-OP,
// and that is provable from the state lifecycle rather than a matter of taste:
// `markHeadAcquired` (done-worktree.mjs) stamps IN_LAND at HEAD-ACQUISITION — the same
// instant the head starts its tenure — and nothing clears it while the entry stays at
// position 1 (only `requeueEntry`, which moves the entry to the tail, and `mark-holding on`,
// which swaps in HOLDING). So essentially EVERY long-tenured head is IN_LAND for its whole
// tenure, exemption included, and the measured failure class would remain invisible.
//
// What invariant 1 is really protecting is a head that is genuinely inside the merge/gate
// window, and a bounded leash protects that better than an unconditional exemption — which
// is exactly the reasoning plan 2414 already applied when it REFUSED to make the IN_LAND
// immunity unconditional ("an unconditional IN_LAND immunity would re-create the exact
// wedge the demote exists to break"). Plan 2414 bounded it by heartbeat age; that bound
// cannot expire here, because the self-arm refreshes the heartbeat every
// DEFAULT_DEMOTE_STALE_MIN/3 minutes. Bounding it by PROGRESS instead restores the leash
// plan 2414 intended.
//
// 90 min = 2x DEFAULT_CONVERGE_STALE_MIN, i.e. ~3.8x the measured max whole-phase tip→merge
// (23m23s, n=297) — the merge window is where the longest legitimate single steps live, so
// it earns the wider bound, and a healthy battery stamps progress at each completed step
// regardless. Still 2.7x tighter than the worst measured non-converging hold (4.09h, 24
// waiters) and 7.6x tighter than the window max (11.40h). The 🟢 LANDING board-row immunity
// stays ABSOLUTE and unbounded (the CLI gate, untouched) — that is the real merge-window
// guard for a 🟥 land, and invariant 1's second clause holds exactly as written.
export const IN_LAND_CONVERGE_STALE_MIN = 90;

// The three `staleAxis` sentinels a head-displacement verdict can carry, named rather than
// spelled as bare string literals at each comparison site (review [8] — the same reason
// IN_LAND_STATE / HOLDING_STATE / UNKNOWN_SESSION are constants in this file: a typo'd
// literal in a `!==` comparison silently inverts a gate instead of failing loudly).
export const HEARTBEAT_AXIS = 'heartbeat';
export const CONVERGE_AXIS = 'converge';
// plan 3000: the operator-override "axis". It is not a staleness measurement at all — it
// names AUTHORITY as the thing that carried the verdict, which is the whole point: the two
// real axes are both liveness readings, and a live head's readings can never authorize a
// move (a 45 s-heartbeat head never leaves age 0m, so no positive --stale-min clears the
// gate — the axis is unreachable by construction, not merely strict). Carrying it in the
// SAME `staleAxis` slot keeps every downstream consumer — the audit line, the CLI's operator
// line, the JSON payload — reporting the real reason a head moved instead of a heartbeat age
// that was never stale, exactly as plan 2485 established for the convergence axis.
export const OPERATOR_AXIS = 'operator';

// plan 3000: the one normalizer for an operator-override reason, shared by the audit line
// and the requeue commit subject so the two records can never disagree. Three jobs:
//   - ONE LINE: the audit region is line-oriented and a commit subject is a single line, so
//     every newline/tab/run of whitespace collapses to a single space.
//   - PAREN-FREE: RX_AUDIT_OPERATOR_DEMOTE captures the detail as `[^)]*` (the same grammar
//     constraint applyDemote's own header calls out), so a reason containing `)` would break
//     the template and silently zero `operatorDemoteAuditCount`. Parens map to square
//     brackets rather than being dropped, so the operator's phrasing survives readably.
//   - BOUNDED: truncated to keep one audit line and one commit subject sane.
// Returns '' for a missing/blank reason — callers treat that as "no reason supplied", which
// is a refusal (the reason is mandatory; an override is never anonymous).
export const OVERRIDE_REASON_MAX = 200;
export function normalizeOverrideReason(reason) {
  const oneLine = String(reason ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\(/g, '[')
    .replace(/\)/g, ']')
    .trim();
  return oneLine.length > OVERRIDE_REASON_MAX
    ? `${oneLine.slice(0, OVERRIDE_REASON_MAX - 1).trimEnd()}…`
    : oneLine;
}

// The convergence half of demote's staleness question, kept beside ageIsFresh as its twin:
// `null` = the axis ABSTAINS (no verdict), a string = the head is provably not converging
// and that string is the human-readable why.
//
// The bound is PER HEAD PHASE, and `convergenceBoundFor` below is its SINGLE OWNER — every
// consumer (the gate, the audit-line writer, the waiter-side pre-check) resolves the bound
// through it rather than re-deriving the phase ternary. Review [4]/[5]: two hand-copied
// copies that "currently agree by coincidence, not by construction" is exactly how a future
// third phase tier ends up gating on one threshold while the cross-session audit trail
// records another.
//
// Abstains — deliberately, in the fail-safe direction — when:
//   - the effective bound is not a usable positive number (a caller opting out entirely);
//   - the head is stamped HOLDING. That head is parked OFF-spine on rework by design and is
//     demote-immune by design (plan 2275); its recourse is the bounded overtake, and plan
//     2485's boundary lists the 2275 surface as do-not-touch. Not-converging is precisely
//     what HOLDING already declares, so re-deciding it here would only duplicate — and
//     could contradict — an adjudication that already has an owner.
//   - `progressIso` is absent/unparseable — a pre-2485 row, an entry a pre-2485 session's
//     renderQueue re-rendered, or a residency whose spine has not stamped yet. "I cannot
//     read this head's progress" must never read as "this head is not progressing".
//     (Note the deliberate ASYMMETRY with ageIsFresh, where an unparseable heartbeat is
//     never fresh: there, a corrupt stamp cannot prove a head HEALTHY and the conservative
//     answer is to allow displacement; here, a missing stamp cannot prove a head STUCK and
//     the conservative answer is to refuse it. Both directions protect the head that is
//     genuinely landing.)
//
// The IN_LAND leash is a MULTIPLE of the caller's own bound, not a fixed constant that
// overrides it (review [1]): an operator who passes `--converge-min 0` to take the axis out
// of the picture mid-incident must have it disabled for EVERY head phase — and an IN_LAND
// head is the phase where that escape hatch is most likely to be needed. A fixed 90 would
// have silently ignored the override on exactly that head. Scaling instead keeps the
// documented defaults intact (45 → 90) while making every override apply uniformly.
export const IN_LAND_CONVERGE_MULTIPLIER = 2;

/** The effective convergence bound in minutes for this head phase; `null` = axis abstains. */
export function convergenceBoundFor(head, convergeMin = DEFAULT_CONVERGE_STALE_MIN) {
  if (!head) return null;
  if (head.state === HOLDING_STATE) return null;
  if (!Number.isFinite(convergeMin) || convergeMin <= 0) return null;
  return head.state === IN_LAND_STATE ? convergeMin * IN_LAND_CONVERGE_MULTIPLIER : convergeMin;
}

/**
 * The full convergence reading for a head: `{stale, bound, progressMin, reason}`.
 * Computed ONCE per verdict and carried on the verdict object, so the audit line and the
 * operator-facing message report the very numbers the gate judged against instead of
 * re-deriving them against a later clock (review [6]).
 */
export function convergenceInfo(head, nowMs, convergeMin = DEFAULT_CONVERGE_STALE_MIN) {
  const bound = convergenceBoundFor(head, convergeMin);
  const progressMin = bound == null ? null : ageMinutes(head?.progressIso, nowMs);
  const stale = bound != null && progressMin != null && progressMin > bound;
  return {
    stale,
    bound,
    progressMin,
    reason: stale
      ? `head ${head.slug} heartbeat is fresh but it has stamped no land progress for ` +
        `${progressMin}m > ${bound}m` +
        `${head.state === IN_LAND_STATE ? ' [IN_LAND merge-window leash]' : ''} — alive, not converging`
      : null,
  };
}

// The convergence half of demote's staleness question, kept beside ageIsFresh as its twin:
// `null` = the axis ABSTAINS (no verdict), a string = the head is provably not converging
// and that string is the human-readable why. Thin wrapper over convergenceInfo so the
// predicate and the numbers can never disagree.
export function convergenceStaleReason(head, nowMs, convergeMin = DEFAULT_CONVERGE_STALE_MIN) {
  return convergenceInfo(head, nowMs, convergeMin).reason;
}

// Column-exact single-row twin of batchMemberLandingRows: does ANY board row for
// `slug` hold 🟢 LANDING? (A single-plan queue slug IS its board-row slug; only batch
// slugs need the member resolution.) The state-cell match is board-lib's landingRows —
// the single owner of the column-exact check; only the cell-0 composition is local.
// Deliberately NOT board-lib's landingInfo (review 1682 delta): landingInfo resolves
// the FIRST row matching the slug (findRowLineIndex), so a duplicate-row board (crash/
// hand-edit debris) whose live 🟢 LANDING row sorts second would read as not-landing
// and let a demote move a genuinely mid-land head — this gate must fail SAFE across
// every row. Unparseable board → false (fail-open like batchMemberLandingRows; the
// demote path still has its heartbeat gate on top).
export function slugHoldsLandingRow(boardContent, slug) {
  let body;
  try {
    body = splitBoard(boardContent).body;
  } catch {
    return false;
  }
  return landingRows(body).some((line) => cellsOf(line)?.[0] === slug);
}

// The ONE audit-trail window-counter both starvation caps share (review 2275 F5 — the
// headDisplacementVerdict lesson applied to the counting side: twin hand-rolled loops
// are where a parsing fix lands in one verb and stays broken in the other). Counts
// audit lines whose `parseAuditLine` verb+slug match `verb`/`slug` and whose leading
// `- <iso>` timestamp falls inside the rolling window; an unparseable timestamp COUNTS
// (conservative: corrupt can't prove the cap unspent). The audit trail is the only
// cross-session, cross-PC record — the head's local land-attempt sidecar is host-private.
//
// plan 2482 review [3]: repointed onto the shared grammar (was a private
// marker-substring scan) — `slug` matched via `parseAuditLine`'s exact field instead of
// a hand-bounded substring is immune to the prefix-collision class by construction
// (`foo` vs `foo-bar`), not just by careful marker punctuation. `fallbackMarker` is a
// narrow, deliberately-kept safety net: a line whose non-timestamp portion is itself
// corrupted (not just its iso, which `parseAuditLine` already tolerates via `\S+`)
// fails the strict grammar entirely — conservative-counts it anyway if the OLD raw
// substring still appears, matching the exact pre-2482 behaviour on the corrupt-line
// case rather than silently going from "counts" to "doesn't count" on the one bit of
// robustness a stricter parser cannot supply.
function auditCountWithin(auditLines, { verb, slug, fallbackMarker }, nowMs, windowMin) {
  let n = 0;
  for (const l of auditLines || []) {
    const parsed = parseAuditLine(l);
    let iso;
    if (parsed && parsed.verb === verb && parsed.slug === slug) {
      iso = parsed.iso;
    } else if (!parsed && fallbackMarker && l.includes(fallbackMarker)) {
      iso = (l.match(/^- (\S+)/) || [])[1];
    } else {
      continue;
    }
    const age = ageMinutes(iso, nowMs);
    if (age == null || age <= windowMin) n++;
  }
  return n;
}

// Count prior auto-demotes of `headSlug` inside the rolling window.
export function demoteAuditCount(auditLines, headSlug, nowMs, windowMin = DEMOTE_CAP_WINDOW_MIN) {
  return auditCountWithin(
    auditLines,
    { verb: 'demote', slug: headSlug, fallbackMarker: `auto-demote: ${headSlug} → tail` },
    nowMs,
    windowMin,
  );
}

// plan 3000: the twin counter for OPERATOR overrides of `headSlug`. It caps nothing — an
// operator override is deliberately uncapped (execution note 4) — but the second counter is
// what makes "the two stay separable" a checkable property rather than a claim: this counts
// exactly the lines demoteAuditCount does not, over the same window and through the same
// shared grammar, so a reader (or a test) can assert both numbers instead of inferring one
// from the other's absence.
export function operatorDemoteAuditCount(
  auditLines,
  headSlug,
  nowMs,
  windowMin = DEMOTE_CAP_WINDOW_MIN,
) {
  return auditCountWithin(
    auditLines,
    {
      verb: 'operator-demote',
      slug: headSlug,
      fallbackMarker: `operator-demote: ${headSlug} → tail`,
    },
    nowMs,
    windowMin,
  );
}

// plan 2414: the free-lane liveness token. A 🟥 land's ONLY "actively mid-land" demote
// immunity is the 🟢 LANDING board row (`slugHoldsLandingRow`, the CLI's own gate on
// top of this verdict) — but `done-worktree.mjs` never sets that row for a 🟩 land (the
// lanes comment: "free (no seed) → NO landing-lock, NO 🟢 LANDING row"), so the entire
// free lane was demote-eligible on heartbeat age alone the moment a long gate-phase
// battery (tests, prettier, coord-drift, review checks) outlived the last spine
// heartbeat — even though nothing heartbeats DURING that phase by design (the waiting
// session's landing-queue-watch owns the heartbeat only while queued and exits at
// head-arrival, plan 2085). IN_LAND is the lane-agnostic liveness token that closes
// that gap: the spine stamps it at head-acquisition (`markHeadAcquired`, mirroring the
// plan-2275 HOLDING stamp) and it is cleared, structurally, by every seam/exit — a
// dequeue removes the entry outright, a requeue/demote nulls `state` unconditionally
// (`requeueEntry` above), and a LAND_BLOCKED_HOLDING seam overwrites it with
// HOLDING_STATE in the same trailing-state column (`mark-holding on`) — so there is no
// separate "clear" verb to forget. The immunity below is deliberately liveness-BACKED,
// not unconditional (an unconditional IN_LAND immunity would re-create the exact wedge
// the demote exists to break: a killed process leaves the stamp forever) — see
// `holderPidAlive` below.
export const IN_LAND_STATE = 'IN_LAND';

// The CLI's own sentinel for "no --session supplied" (cmdEnqueue/cmdRequeue/cmdReenter,
// landing-queue.mjs: `flags.session ?? UNKNOWN_SESSION`). Exported so the self-eviction
// check below and its tests share one source of truth for "this session value is not
// real evidence."
export const UNKNOWN_SESSION = '?';

// plan 3422 D5 (gpt-review 3e4838): the ONE host-comparison normalizer for the queue's `host`
// cells, so the watchdog's verdict and the watcher's pid probe cannot drift apart on it.
// `landing-queue.mjs` writes `host: flags.host ?? hostname()`, which on Windows can disagree in
// case/form with a reader's own `hostname()` (the drift plan 3226 documents). Comparing the first
// DNS label case-insensitively is the cheapest normalization that survives it. Known and accepted
// tradeoff (gpt-review fb89c5): two genuinely different machines sharing a short first label
// (`a.foo.com` / `a.bar.com`) compare equal — the same tradeoff `session-priority.mjs` already
// made for its own axis-2 host gate, kept identical here rather than diverging one surface.
export function firstHostLabel(h) {
  return String(h ?? '')
    .trim()
    .split('.')[0]
    .toLowerCase();
}

// ── plan 3422 D5: the DEAD-LAND watchdog verdict ─────────────────────────────────────────────
//
// The 2026-08-24 landing audit's class 4: lands that die silently and are noticed only by a human
// eventually wondering "what is the state?". Plan 2347's first land died near a `/rename` +
// `/model` session-boundary event and went undetected for ~9 HOURS; plan 3407's undersized
// `timeout 3400` killed its land mid-pytest and nobody noticed for ~50 min; plan 3399 left a stuck
// IN_LAND slot ~9 min. In every case the queue still read IN_LAND and nothing said otherwise.
//
// This is NOT a displacement verb. demote / steal / reap already displace a stale head
// mechanically; what none of them do is TELL SOMEBODY. A land that dies at 22:00 is displaced
// eventually and noticed the next morning — the 9 hours are the defect, not the queue order. So
// this verdict only ever raises an alarm; it never mutates the queue.
//
// TWO independent signals must agree, and picking the right SECOND one is the whole design:
//   · the queue heartbeat — necessary but not sufficient. It goes stale on a dead land, but it
//     ALSO goes stale on a live land sitting inside one long step (a 47-minute pytest battery
//     stamps nothing while it runs), so alarming on it alone would cry wolf on exactly the lands
//     that take longest.
//   · the landing PROCESS's liveness — `holderPidAlive`, the same tri-state probe demoteVerdict
//     and the mechanical steal already reason with (`process.kill(pid, 0)`, run at the CLI layer
//     and passed in so this function stays spawn-free). A process that is provably GONE while the
//     queue still reads IN_LAND is the audited failure exactly, and it is immune to the long-step
//     problem that rules the heartbeat out as a sole signal.
//
// An earlier cut used the land's own `.scratch/done-worktree-<slug>.result.json` phases mtime as
// that second signal. It was WRONG, and gpt-review caught it across six independent angles: the
// sidecar is written only on process EXIT (`writeResultSidecar`'s four call sites are all terminal
// paths), so its mtime is never refreshed mid-run and can never corroborate "alive but quiet" —
// the one case it was there to cover. The sidecar now serves only its real purpose below: did this
// land already END?
//
// That terminal check handles the plan-2917 stale-sidecar hazard explicitly: a sidecar recording a
// terminal outcome only counts if it belongs to THIS residency. A record written BEFORE the head's
// current heartbeat is a previous attempt's, and reading it as "this land finished" is exactly the
// mistake plan 2917 documents (a stale sidecar reported a land that plainly happened as failed).
//
// Fail-safe throughout: every unknown resolves to NO ALARM — a cross-host head, no recorded pid, an
// unprobeable pid, an unparseable stamp, a headless queue. A watchdog that cries wolf gets turned
// off, and a false alarm on someone else's live land is worse than a late true one.
export function deadLandVerdict({
  headSlug,
  headState,
  headHost,
  thisHost,
  headHeartbeatIso,
  // Tri-state, the SAME contract as demoteVerdict's parameter of this name: `true` = same-host
  // recorded pid verified alive, `false` = verified NOT running (provably gone), `null` =
  // unprobeable (cross-host head, no recorded pid, or a foreign-owner refusal).
  holderPidAlive = null,
  sidecar = null,
  nowMs,
  staleMin = DEFAULT_DEMOTE_STALE_MIN,
}) {
  const no = (reason) => ({ alarm: false, reason });
  if (!headSlug) return no('no head');
  if (headState !== IN_LAND_STATE) return no('head is not IN_LAND — no land is claimed in flight');
  // Cross-host: the pid is unprobeable and the sidecar unreadable from here. Abstain.
  if (!headHost || !thisHost || firstHostLabel(headHost) !== firstHostLabel(thisHost)) {
    return no('head is on another host — its landing process is not probeable from here');
  }
  const hbMs = Date.parse(headHeartbeatIso ?? '');
  if (!Number.isFinite(hbMs)) return no('head has no readable heartbeat — cannot judge');
  const queueAgeMin = (nowMs - hbMs) / 60_000;
  if (ageIsFresh(queueAgeMin, staleMin)) return no('head heartbeat is still fresh');
  // The load-bearing signal. `true` (alive) and `null` (unprobeable) BOTH abstain — only a
  // provably-dead process earns the alarm.
  if (holderPidAlive !== false) {
    return no(
      holderPidAlive === true
        ? 'the landing process is still alive — quiet, not dead (one long gate step stamps nothing while it runs)'
        : 'the landing process is not probeable (no recorded pid) — a death cannot be proven',
    );
  }
  // A terminal record for THIS residency means the land ENDED; that is a stuck slot, not a dead
  // land, and it is the displacement verbs' business, not this alarm's.
  if (sidecar && sidecar.code) {
    const sidecarMs = Date.parse(sidecar.timestamp ?? '');
    const belongsToThisResidency = !Number.isFinite(sidecarMs) || sidecarMs >= hbMs;
    if (belongsToThisResidency) {
      return no(
        `the land recorded a terminal outcome (${sidecar.code}) — a stuck slot, not a death`,
      );
    }
  }
  return {
    alarm: true,
    reason:
      `the landing process is GONE while the queue still reads IN_LAND: its recorded pid is not ` +
      `running and the head heartbeat is ${Math.round(queueAgeMin)} min old (threshold ${staleMin} min), ` +
      `with no terminal seam recorded for this residency`,
    queueAgeMin,
  };
}

// plan 2414 item 4: shared by BOTH staleness-keyed head-displacement verbs — demote
// (moves the head) AND reap (REMOVES it, plan 2331 — reap review fix: the self-demote
// refusal was originally added to demoteVerdict only, which left the identical
// same-session-evicts-itself failure open via reap, an even more destructive verb).
// `caller` and `head` both carry a `session` cell (plan 504) — when they match on a
// REAL (non-placeholder) value, the SAME session owns both queue entries, and a
// session evicting its own other land is never useful (the 2026-07-25 incident: two
// plans owned by one session evicted each other). Checked with the caller's OWN entry
// (present because both callers only reach here after their own membership check
// already proved the caller is queued), never an external argument — the queue doc
// itself is the only source of truth for both sessions.
//
// UNKNOWN_SESSION guard: `session` defaults to the CLI's own placeholder whenever an
// enqueue/reenter/requeue omits `--session` — two entries BOTH carrying the
// placeholder are NOT thereby known to share a session (they might, they might not),
// so treating it as a match would wrongly refuse between two genuinely different
// session-less legacy entries. Only a genuine, non-placeholder match counts.
function selfSessionRefusal(entries, callerSlug, head) {
  const callerEntry = entries.find((e) => e.slug === callerSlug);
  if (
    callerEntry?.session &&
    callerEntry.session !== UNKNOWN_SESSION &&
    callerEntry.session === head.session
  ) {
    return (
      `${callerSlug} and head ${head.slug} belong to the same session ` +
      `(${head.session}) — a session never evicts its own other land; release or finish ` +
      `the head first`
    );
  }
  return null;
}

// Demote eligibility — deterministic math only; the CLI layers the fresh 🟢 LANDING
// board gate on top (IO). The shared skeleton (head-exists / self / membership /
// staleness) lives in headDisplacementVerdict; demote's own layers are the membership
// rule (queued anywhere BEHIND the head — a demote may only be asked for by a harmed
// waiter, but unlike a steal it never removes anything, so any waiter position
// qualifies), the self-demote refusal, the IN_LAND liveness immunity, and the
// starvation cap.
export function demoteVerdict({
  entries,
  auditLines = [],
  demoter,
  nowMs,
  staleMin = DEFAULT_DEMOTE_STALE_MIN,
  cap = DEMOTE_CAP,
  // plan 2414 item 2: the pid-liveness probe is IO (process.kill(pid, 0)), run by the
  // CLI layer and passed in as a plain tri-state so this function stays spawn-free —
  // `true` = same-host recorded pid verified alive, `false` = same-host recorded pid
  // verified NOT running (holder provably gone — demote proceeds), `null` = unprobeable
  // (cross-host head, or no recorded pid — pre-2266 entry) and the caller must fall
  // back to the heartbeat-age leash below.
  holderPidAlive = null,
  // plan 2414 item 1 option (a): a cross-host IN_LAND head (unprobeable pid) keeps its
  // immunity only while its heartbeat is younger than the STEAL threshold — a longer
  // leash than the demote staleMin while stamped in-land, never a forever-immunity.
  inLandStaleMin = DEFAULT_STEAL_STALE_MIN,
  // plan 2485: the convergence axis bound. Pass 0/null to disable the axis entirely and
  // get pre-2485 (liveness-only) semantics back.
  convergeMin = DEFAULT_CONVERGE_STALE_MIN,
  // plan 3000: the operator override (the 2026-08-08 ruling — "even on my demand, we should
  // be able to move around our demote plans in the planning queue"). `operatorOverride` is
  // the authority assertion, `operatorReason` the mandatory justification that rides into
  // the audit trail. Skipped under it: heartbeat staleness, the convergence axis, the
  // IN_LAND immunity (plan 2414) and the ≤2/24h starvation cap. KEPT under it: every
  // structural gate in headDisplacementVerdict, the same-session refusal below, the
  // MOVE-not-remove requeue, and — at the CLI layer, deliberately outside this function —
  // the absolute 🟢 LANDING merge-window refusal. Demote only: `steal`/`reap` REMOVE an
  // entry and are a different risk class (execution note 1).
  operatorOverride = false,
  operatorReason = '',
}) {
  // The reason is mandatory at the VERDICT, not merely at the CLI's arg parsing — an
  // override is never anonymous (execution note 2), and a programmatic caller must not be
  // able to route around that by skipping the flag layer.
  if (operatorOverride && !normalizeOverrideReason(operatorReason)) {
    return {
      ok: false,
      reason:
        'an operator override requires a reason — it is stamped into the audit trail and the ' +
        'requeue commit, so it can never be anonymous',
    };
  }
  const core = headDisplacementVerdict({
    entries,
    caller: demoter,
    nowMs,
    staleMin,
    verb: 'demote',
    freshSuffix: 'it may be actively landing',
    membership: (es, caller) =>
      positionOf(es, caller) < 2
        ? `${caller} is not queued behind the head — only a blocked waiter may demote`
        : null,
    // plan 2485: the second axis. A head whose heartbeat is fresh only because something
    // alive keeps ticking it — a watcher, the near-head self-arm, a pre-convergence rebase
    // round — but which has stamped no land progress for convergeMin, is off-spine in
    // exactly the sense this verb exists to break, and the liveness gate above can never
    // say so.
    alternateStaleness: (head) => convergenceInfo(head, nowMs, convergeMin),
    operatorOverride,
  });
  if (!core.ok) return core;
  // plan 2414 item 4: refuse a self-demote (shared with reapVerdict — see
  // selfSessionRefusal's header comment for the UNKNOWN_SESSION rationale).
  const selfRefusal = selfSessionRefusal(entries, demoter, core.head);
  if (selfRefusal) {
    return { ok: false, reason: selfRefusal, head: core.head, ageMin: core.ageMin };
  }
  // plan 2414 items 1+2: the IN_LAND liveness-backed immunity. A merely-stale heartbeat
  // is exactly what a long, healthy gate-phase battery produces by design — only refuse
  // when the holder is ALSO provably still alive (never on state alone, which would be
  // the unconditional immunity the plan explicitly rejects) AND within the leash
  // (review fix: a same-host VERIFIED-ALIVE pid must NOT grant unconditional immunity —
  // a genuinely wedged-but-alive process would otherwise block every waiter's demote
  // forever, a new livelock worse than the one this plan closes. Every IN_LAND immunity
  // — alive-pid included — expires once the heartbeat outlives `inLandStaleMin`; a
  // verified-DEAD pid loses immunity immediately regardless of the leash).
  // plan 2485: the heartbeat-age leash below is SKIPPED when the CONVERGENCE axis carried
  // the verdict, and skipping it is the point rather than a hole. This leash's own premise
  // is "a merely-stale heartbeat is what a healthy gate battery produces, so bound the
  // immunity by heartbeat age instead" — but heartbeat age cannot bound anything against a
  // self-arm that refreshes it every DEFAULT_DEMOTE_STALE_MIN/3 minutes, which is why an
  // IN_LAND head could hold the slot indefinitely. `convergenceStaleReason` has already
  // applied the IN_LAND-SPECIFIC, WIDER bound (IN_LAND_CONVERGE_STALE_MIN) to this very
  // head, so re-refusing on the un-expirable heartbeat leash here would simply restore the
  // forever-immunity plan 2414 explicitly set out to prevent. The verified-DEAD-pid path is
  // untouched, and 🟢 LANDING remains an absolute refusal at the CLI layer above.
  // plan 3000: the override skips this immunity outright (execution note 3). It is the
  // second gate a fresh-heartbeat head passes, so leaving it in would make the override
  // reachable in name only — the exact "no authenticated way past it" defect this plan
  // closes. The cost is not hidden: the CLI prints the discarded gate battery before acting.
  if (!operatorOverride && core.head.state === IN_LAND_STATE && core.staleAxis !== CONVERGE_AXIS) {
    const withinLeash = ageIsFresh(core.ageMin, inLandStaleMin);
    const holderLive = withinLeash && holderPidAlive !== false;
    if (holderLive) {
      return {
        ok: false,
        reason:
          `head ${core.head.slug} is stamped IN_LAND (heartbeat age ${core.ageMin}m > ${staleMin}m) and ` +
          (holderPidAlive === true
            ? 'its recorded pid is verified alive'
            : `its heartbeat is still within the ${inLandStaleMin}-min steal threshold (pid unprobeable — cross-host or unrecorded)`) +
          ` — a gate-phase heartbeat gap alone is not demote-eligible while actively landing; the ` +
          `${inLandStaleMin}-min steal (with --confirm-holder-gone) is the remaining recourse once it is genuinely dead ` +
          `or the leash expires`,
        head: core.head,
        ageMin: core.ageMin,
      };
    }
  }
  // plan 3000 (execution note 4): an operator override does NOT spend the automatic
  // starvation budget. The cap exists to stop automated ping-pong between sessions; the
  // operator is who it protects, so counting a deliberate operator reorder against it would
  // let two unrelated auto-demotes silently disarm the override. The two counts stay
  // separable structurally — an override writes the `operator-demote` template, which
  // `demoteAuditCount` (verb `demote`) never matches and `operatorDemoteAuditCount` does.
  if (operatorOverride) return core;
  const prior = demoteAuditCount(auditLines, core.head.slug, nowMs);
  if (prior >= cap) {
    return {
      ok: false,
      reason:
        `head ${core.head.slug} already auto-demoted ${prior}× in ${DEMOTE_CAP_WINDOW_MIN / 60}h — starvation cap; ` +
        `the ${DEFAULT_STEAL_STALE_MIN}-min steal (with --confirm-holder-gone) is the remaining recourse`,
      head: core.head,
      ageMin: core.ageMin,
    };
  }
  return core;
}

/**
 * Move the head to the tail on a verified demote; the audit line matches demoteAuditCount's
 * matcher — or, on an OPERATOR_AXIS move (plan 3000), operatorDemoteAuditCount's.
 *
 * plan 2485: `opts.staleAxis` (HEARTBEAT_AXIS | CONVERGE_AXIS | OPERATOR_AXIS — pass the verdict's own value)
 * picks which axis the audit detail reports. A convergence demote whose line claimed a stale
 * heartbeat would be a false record of WHY the head was moved, on the one cross-session,
 * cross-PC trail the starvation cap and the telemetry miner both read. The detail text stays
 * PAREN-FREE on purpose: RX_AUDIT_DEMOTE captures it as `[^)]*`, so a nested paren (the kind
 * convergenceInfo's own human-readable message carries) would break the grammar and silently
 * zero demoteAuditCount — i.e. void the starvation cap.
 *
 * `opts.convergeBound` / `opts.convergeProgressMin` are the VERDICT's own numbers (carried on
 * the verdict object). Passing them is strongly preferred over letting this function
 * re-derive them: a re-derivation runs against a fresh `nowIso` a few seconds later than the
 * `nowMs` the gate actually judged against, and duplicates the phase-bound rule
 * `convergenceBoundFor` owns (review [4]/[5]/[6]). The fallback exists only so a standalone
 * caller (and the pre-2485 5-argument call shape) still gets a sane line.
 */
export function applyDemote(entries, demoter, nowIso, ageMin, staleMin, opts = {}) {
  const {
    staleAxis = HEARTBEAT_AXIS,
    convergeMin = DEFAULT_CONVERGE_STALE_MIN,
    convergeBound,
    convergeProgressMin,
    // plan 3000: the operator's mandatory reason, carried into the audit detail.
    operatorReason = '',
  } = opts;
  const head = headOf(entries);
  // plan 3000: an operator override writes the SEPARATE `operator-demote` template — see
  // RX_AUDIT_OPERATOR_DEMOTE's header for why a distinct verb rather than a suffix. The
  // detail is the normalized reason and nothing else: the heartbeat age and the convergence
  // reading are both true of this move but neither is why it happened, and this line is the
  // one cross-session record of WHY.
  if (staleAxis === OPERATOR_AXIS) {
    const reason = normalizeOverrideReason(operatorReason);
    // THROW rather than fall back to a placeholder. "An override is never anonymous" is the
    // contract (execution note 2), and a writer that quietly records `no reason recorded`
    // would satisfy the audit template while defeating the rule the template exists to
    // enforce — the one shape that produces an unattributable override in the permanent
    // trail. demoteVerdict already refuses a reasonless override, so reaching here empty
    // means a caller bypassed the verdict; failing loudly is the only honest answer.
    if (!reason) {
      throw new Error(
        'applyDemote: an OPERATOR_AXIS demote requires opts.operatorReason — an operator ' +
          'override is never anonymous in the audit trail',
      );
    }
    const rq = requeueEntry(entries, head.slug, nowIso);
    return {
      entries: rq.entries,
      auditLine: `- ${nowIso} — operator-demote: ${head.slug} → tail (operator override: ${reason}) by ${demoter}`,
    };
  }
  let detail;
  if (staleAxis === CONVERGE_AXIS) {
    // Prefer the verdict's numbers; fall back to the single-owner bound resolver rather than
    // a second copy of the phase ternary.
    const bound = convergeBound ?? convergenceBoundFor(head, convergeMin);
    const progressMin = convergeProgressMin ?? ageMinutes(head?.progressIso, Date.parse(nowIso));
    detail =
      progressMin == null || bound == null
        ? `no land progress stamp, alive but not converging`
        : `no land progress ${progressMin}m > ${bound}m, alive but not converging`;
  } else {
    detail =
      (ageMin == null ? 'unparseable heartbeat' : `heartbeat age ${ageMin}m > ${staleMin}m`) +
      ', not landing';
  }
  const rq = requeueEntry(entries, head.slug, nowIso);
  return {
    entries: rq.entries,
    auditLine: `- ${nowIso} — auto-demote: ${head.slug} → tail (${detail}) by ${demoter}`,
  };
}

// ── plan 2275: bounded overtake of a LAND_BLOCKED_HOLDING head ─────────────────────
// The fourth head-state in the recovery taxonomy, and the gap the first three leave
// open: steal = head GONE (removes it), demote = head live but OFF-SPINE (moves it to
// tail; a 🟢 LANDING row makes it demote-immune), and a LAND_BLOCKED_HOLDING head is
// live, ON-SPINE, holding queue slot + landing-lock + LANDING row while its session
// reworks a conflict OUT of the spine — demote-immune BY DESIGN, so every waiter
// wedges behind it (~1h11m / 40% of the 2233 land, recurring on busy 🟥 days).
//
// Overtake lets ONE qualified 🟩 waiter past such a head via an atomic REORDER —
// overtaker → position 1, holder → position 2 (NEVER the tail: it resumes the moment
// the overtaker dequeues). The single-lander invariant is untouched: at all times
// exactly one entry occupies position 1, and only position 1 enters the merge window.
// `state === HOLDING` ⇒ the head is provably NOT in the merge window (the stamp is
// written only by the seam emit, after the merge attempt aborted; the resume path
// clears it — via a position-1-verdicted mark-holding off — before re-entering the
// merge, so an overtake/resume race settles on coordWrite CAS ordering: whichever
// commits first wins, the loser's in-mutate re-verdict refuses cleanly).
//
// v1 admits 🟩 free-lane overtakers only: a 🟩 land never acquires the landing-lock
// and holds no 🟢 LANDING row, so the holder's retained lock + row stay uncontended.
// (A scope-disjoint 🟥 overtaker needs concurrent LANDING-row semantics — explicitly
// deferred, see the plan's Non-goals.) The CLI layers the path-disjointness probe
// (overtaker diff ∩ holder diff = ∅) on top — IO, not here.
export const HOLDING_STATE = 'HOLDING';
// Starvation cap (the 2233 failure loop this plan's own spec names): past this many
// overtakes of one holder inside the window, waiters hold until it resumes — every
// overtake advances master and stales the holder's replay target, so unbounded
// overtaking recreates exactly the staleness spiral plan 2274 hardened against.
export const OVERTAKE_CAP = 2;
export const OVERTAKE_CAP_WINDOW_MIN = 24 * 60;

// Set/clear the trailing `state` cell for `slug` only; absent slug → unchanged.
// `state` is HOLDING_STATE or null (clear). Pure twin of heartbeatEntry. plan 2331:
// either direction ALSO clears `reapArmedIso` — a state transition (parking at
// LAND_BLOCKED_HOLDING, or resuming from it) is exactly a "this entry's head-relevant
// status just changed" event, so a stale arm from before the transition must never
// carry through it (belt-and-suspenders alongside reapVerdict's own HOLDING gate below).
export function setEntryState(entries, slug, state) {
  return entries.map((e) =>
    e.slug === slug ? { ...e, state: state ?? null, reapArmedIso: null } : e,
  );
}

// Count prior overtakes past `headSlug` inside the rolling window (auditCountWithin
// above). Matched via parseAuditLine's exact `slug` field, so a slug that prefixes
// another slug can never false-count (the fallbackMarker net stays bounded on both
// sides — `… ${headSlug} →` — for the same reason, on the rare corrupted-line path).
export function overtakeAuditCount(
  auditLines,
  headSlug,
  nowMs,
  windowMin = OVERTAKE_CAP_WINDOW_MIN,
) {
  return auditCountWithin(
    auditLines,
    { verb: 'overtake', slug: headSlug, fallbackMarker: `past HOLDING head ${headSlug} →` },
    nowMs,
    windowMin,
  );
}

// Overtake eligibility — deterministic queue math only. Deliberately NOT built on
// headDisplacementVerdict: overtake is STATE-keyed (head parked at HOLDING), never
// staleness-keyed — a holding head's heartbeat age is irrelevant (holds legitimately
// run an hour+), and wiring in the staleness skeleton would invite exactly the wrong
// eligibility. The CLI layers the path-disjointness probe (IO) on top, pre-verdict
// AND re-verdict inside the mutate (the steal/demote pattern).
export function overtakeVerdict({
  entries,
  auditLines = [],
  overtaker,
  nowMs,
  cap = OVERTAKE_CAP,
}) {
  const head = headOf(entries);
  if (!head) return { ok: false, reason: 'queue is empty — nothing to overtake' };
  if (head.slug === overtaker) {
    return { ok: false, reason: `${overtaker} is already head of the queue` };
  }
  const pos = positionOf(entries, overtaker);
  if (pos < 2) {
    return {
      ok: false,
      reason: `${overtaker} is not queued — only a queued waiter may overtake`,
    };
  }
  const me = entries[pos - 1];
  if (me.lane !== '🟩') {
    return {
      ok: false,
      reason:
        `${overtaker} is ${me.lane} — only a 🟩 free-lane land may overtake (v1: a 🟥 overtaker ` +
        `would need a concurrent 🟢 LANDING row + scoped-lock coexistence the design defers)`,
    };
  }
  if (head.state !== HOLDING_STATE) {
    return {
      ok: false,
      reason:
        `head ${head.slug} is not parked at LAND_BLOCKED_HOLDING (state: ${head.state ?? '—'}) — ` +
        `an active head is never overtakable (two lands would race the master ref)`,
      head,
    };
  }
  // plan 2328: an overtake must never SILENTLY leapfrog a priority entry — the front
  // block (entries between the head and this overtaker carrying the ⚡ stamp) was put
  // ahead of every normal waiter on purpose, and an overtake that jumps it would undo
  // exactly the ordering the priority insert bought. Refuse LOUDLY, naming the entry:
  // the priority waiter (if 🟩) is the one that may overtake; otherwise everyone holds
  // behind the parked head, the pre-2275 behaviour. An overtaker with no priority
  // entry ahead of it (typically itself the first entry behind the head) is untouched.
  // Deliberately the RAW range, not frontBlockEnd (review 2328): a ⚡ flag can only
  // sit mid-queue by being DISPLACED through no verb of its own — applyOvertake's
  // reorder parks the holder at position 2, pushing former front-block ⚡ entries
  // behind it — and such an entry keeps its precedence claim. The one path that
  // genuinely revokes standing (requeue/demote to the tail) CLEARS the flag in
  // requeueEntry, so a stale ⚡ cannot wedge this guard.
  const leapfrogged = entries.slice(1, pos - 1).find((e) => e.priority);
  if (leapfrogged) {
    return {
      ok: false,
      reason:
        `${overtaker} would leapfrog the priority (⚡) entry ${leapfrogged.slug} queued ahead of it — ` +
        `priority waiters keep their front-block ordering (plan 2328); only the frontmost eligible ` +
        `waiter may overtake`,
      head,
    };
  }
  const prior = overtakeAuditCount(auditLines, head.slug, nowMs);
  if (prior >= cap) {
    return {
      ok: false,
      reason:
        `holding head ${head.slug} already overtaken ${prior}× in ${OVERTAKE_CAP_WINDOW_MIN / 60}h — ` +
        `starvation cap (every overtake stales its replay target; the 2233 loop); waiters hold`,
      head,
    };
  }
  return { ok: true, head };
}

// Reorder on a verified overtake: overtaker → index 0, holder → index 1, everyone
// else keeps relative order behind them. Intermediate waiters lose no progress —
// they were wedged behind the HOLDING head regardless, and regain their exact
// relative order behind it once the overtaker dequeues. Audit line format is the
// contract overtakeAuditCount matches on — change them together.
export function applyOvertake(entries, overtaker, nowIso) {
  const head = headOf(entries);
  const me = entries.find((e) => e.slug === overtaker);
  const rest = entries.filter((e) => e !== head && e !== me);
  return {
    entries: [me, head, ...rest],
    auditLine: `- ${nowIso} — overtake: ${overtaker} past HOLDING head ${head.slug} → position 2`,
  };
}

// ── plan 2331: auto-reap a dead head (mechanical dequeue, no human confirm) ────────
// The complementary corpse class to plan 2266's mechanical steal: a head whose queue
// heartbeat is stale AND whose board row is NOT 🟢 LANDING (never acquired the mutex,
// or a crash left it as a plain not-landing residency) — cross-host/pid-less heads
// (cloud sessions) that 2266's same-host pid probe can never verify, and past plan
// 1682's demote starvation cap (the 2306 incident, runbook § the FIFO's dead-head
// class). The remedy is a plain DEQUEUE: non-destructive (no branch/work/tenure
// touched, unlike steal/2266's tenure release), idempotent, and self-healing — a head
// that was merely alive-but-wedged just re-enqueues at the tail when its session next
// runs done-worktree.
//
// Naming note: landing-queue.mjs already uses "reap" for TWO other, unrelated
// mechanisms — pruneLanded/pruneLandedBatches above (plan 574, landed-orphan cleanup
// by archive-file ground truth) and the plan-2266 "mechanical reap" (a dead 🟢
// LANDING head, same-host pid probe, steal + tenure release). This is a THIRD,
// distinct verb: a dead, NOT-landing head, keyed on heartbeat staleness + the queue
// doc's own `state` cell — no pid/host evidence needed at all.
//
// Arm-then-fire grace (2026-07-24 amendment, the second/orphan-class incident): the
// queue has no explicit "became head at" event — a just-promoted entry can carry an
// hours-old heartbeat from before it ever reached the head (the watcher's poll
// cadence, a dead watcher, wake + preflight latency) — so grace is measured by the
// REAPER, not the head. The first otherwise-eligible verdict does not fire: it
// reports `armed:true, ok:false` so the CLI can stamp `reapArmedIso` (a plain
// entry-field update, mirroring heartbeatEntry/setEntryState) and exit refused. A
// LATER verdict fires only once `reapArmedIso` is old enough (>= graceMin) AND the
// verdict still otherwise holds. heartbeatEntry/requeueEntry/setEntryState above all
// clear `reapArmedIso` on any event that means "this entry's head-relevant status
// just changed" — a fresh residency (or a resumed HOLDING head) never inherits a
// stale arm from a previous one.
export const DEFAULT_REAP_STALE_MIN = 45;
export const DEFAULT_REAP_GRACE_MIN = 10;

// Deliberately built on headDisplacementVerdict (unlike overtakeVerdict, which is
// state-keyed and explicitly opts out) — reap IS staleness-keyed, exactly like
// steal/demote, just with a non-destructive remedy and an added grace layer on top.
export function reapVerdict({
  entries,
  waiter,
  nowMs,
  staleMin = DEFAULT_REAP_STALE_MIN,
  graceMin = DEFAULT_REAP_GRACE_MIN,
}) {
  const core = headDisplacementVerdict({
    entries,
    caller: waiter,
    nowMs,
    staleMin,
    verb: 'reap',
    freshSuffix: 'not reap-eligible',
    membership: (es, caller) =>
      positionOf(es, caller) < 2
        ? `${caller} is not queued behind the head — only a blocked waiter may reap`
        : null,
  });
  if (!core.ok) return core; // hard refusal: empty / self / not-queued-behind / fresh-heartbeat
  const { head, ageMin } = core;
  // plan 2414 item 4 (review fix): the self-eviction refusal, shared with demoteVerdict
  // — reap REMOVES the head outright (more destructive than demote's move-to-tail), so
  // the same-session-evicts-its-own-other-land hole is at least as important to close
  // here as it is for demote.
  const selfRefusal = selfSessionRefusal(entries, waiter, head);
  if (selfRefusal) {
    return { ok: false, reason: selfRefusal, head, ageMin };
  }
  // A HOLDING head is provably off the merge critical path but STILL a live, on-spine
  // residency (plan 2275) — never reap-eligible regardless of heartbeat age; `overtake`
  // is the recourse for a waiter wedged behind it, never reap (belt-and-suspenders
  // alongside the CLI's own board 🟢 LANDING gate — a LAND_BLOCKED_HOLDING head keeps
  // its board row, but this checks the queue doc's OWN state cell too).
  if (head.state === HOLDING_STATE) {
    return {
      ok: false,
      reason:
        `head ${head.slug} is parked at LAND_BLOCKED_HOLDING (state: HOLDING) — not reap-eligible; ` +
        `\`overtake\` (a 🟩 waiter) or waiting for it to resume is the recourse, never reap`,
      head,
      ageMin,
    };
  }
  // plan 2414 (review fix): an IN_LAND head is never reap-eligible either, and
  // deliberately unconditionally (unlike demoteVerdict's liveness-bounded immunity) —
  // reap only ever REMOVES the head (never moves it like demote), so the destructive
  // action needs the SAFER recourse. `demote` (liveness-bounded, reversible) is correct
  // for a merely-stale-but-possibly-alive in-land head; a genuinely dead same-host head
  // remains reachable via the mechanical `steal` path (plan 2266), which independently
  // proves pid death before removing anything.
  if (head.state === IN_LAND_STATE) {
    return {
      ok: false,
      reason:
        `head ${head.slug} is stamped IN_LAND (heartbeat age ${ageMin}m > ${staleMin}m) — not ` +
        `reap-eligible; reap only ever REMOVES the head, and IN_LAND means it may still be actively ` +
        `landing. \`demote\` (liveness-bounded) is the recourse for a merely-stale head; the ` +
        `mechanical \`steal\` path is the recourse once a same-host pid is verified dead`,
      head,
      ageMin,
    };
  }
  if (!head.reapArmedIso) {
    return {
      ok: false,
      armed: true,
      head,
      ageMin,
      reason: `head ${head.slug} reap ARMED (heartbeat age ${ageMin}m > ${staleMin}m) — fires after a ${graceMin}m grace`,
    };
  }
  // review fix: an UNPARSEABLE reapArmedIso must fail OPEN (proceed to fire), consistent
  // with the heartbeat-staleness check above (headDisplacementVerdict treats an unparseable
  // heartbeat as stale/eligible, never as "healthy"). A corrupt arm stamp can never arise
  // from this codebase's own writers (armReapEntry always stamps nowIso()), but a stray
  // hand-edit or a future bug must not be able to wedge a genuinely dead head at the FIFO
  // head FOREVER — only a KNOWN, still-too-young arm age refuses.
  const armAgeMin = ageMinutes(head.reapArmedIso, nowMs);
  if (armAgeMin != null && armAgeMin < graceMin) {
    return {
      ok: false,
      armed: true,
      head,
      ageMin,
      armAgeMin,
      reason: `head ${head.slug} reap armed ${armAgeMin}m ago — grace ${graceMin}m not yet elapsed`,
    };
  }
  return { ok: true, head, ageMin, armAgeMin };
}

// Stamp the arm-then-fire grace start on `slug`'s entry (the head only, in practice —
// the CLI never calls this on any other slug). Pure twin of heartbeatEntry/setEntryState.
export function armReapEntry(entries, slug, armIso) {
  return entries.map((e) => (e.slug === slug ? { ...e, reapArmedIso: armIso } : e));
}

// Remove the head on a verified reap — a non-destructive dequeue (never a steal: no
// branch/work/tenure touched, no board row flipped). Mirrors applySteal's shape.
export function applyReap(entries, waiter, nowIso, ageMin, armAgeMin) {
  const head = headOf(entries);
  const age = ageMin == null ? 'unparseable heartbeat' : `${ageMin}m stale`;
  const armed = armAgeMin == null ? 'an unparseable arm timestamp' : `armed ${armAgeMin}m ago`;
  return {
    entries: entries.slice(1),
    auditLine: `- ${nowIso} — reap: ${head.slug} removed by ${waiter} (heartbeat ${age}, ${armed})`,
  };
}

// ── plan 2334: the HEARTBEAT-AGE twin of stealLocallyEligible (plan 2280) ──────────
// Both staleness-keyed waiter verbs — demote (plan 1682) and reap (plan 2331) — refuse a
// head whose heartbeat is still FRESH; that is headDisplacementVerdict's very first age
// gate, and since this plan taught `landing-queue.mjs status <slug> --json` to expose
// `headHeartbeatIso`, it is knowable from the payload a waiter's poll tick ALREADY paid
// for. So a waiter can skip spawning `landing-queue.mjs demote|reap` — and the `git fetch
// origin master` inside it — on a head it can already see is fresh, exactly the
// spawn-avoidance plan 2280 gave the mechanical steal and plan 2275 gave overtake.
//
// Deliberately NOT implemented by calling demoteVerdict/reapVerdict with a synthetic
// two-entry array: each layers gates whose inputs are NOT in the payload (demote's
// starvation cap needs the audit trail; reap's arm-then-fire grace needs `reapArmedIso`),
// so a synthetic call would refuse for a MISSING-INPUT reason and the caller would skip a
// spawn it must make — a silent hole in exactly the verb the pre-check was added for.
// Mirroring only the payload-knowable age gate keeps every unknown failing OPEN (spawn,
// let the CLI decide), which is the safe direction: an unnecessary spawn costs one
// subprocess, a skipped one costs a wedged FIFO head.
//
// Drift protection is `ageIsFresh` — the SAME comparison headDisplacementVerdict's own age
// gate calls, not a copy of it (review [2] caught the earlier draft claiming a shared
// comparison while hand-rolling a second `ageMin <= staleMin`) — plus the constants
// themselves (DEFAULT_DEMOTE_STALE_MIN / DEFAULT_REAP_STALE_MIN, never a hand-copied 15/45).
// So neither the boundary minute nor the threshold can diverge from the real gate.
export function headHeartbeatLocallyFresh({ headHeartbeatIso, nowMs, staleMin }) {
  // An UNPARSEABLE/absent heartbeat is never "fresh" (a pre-2334 status payload has no field
  // at all → undefined → not fresh → spawn) — ageIsFresh owns that rule for both callers.
  return ageIsFresh(ageMinutes(headHeartbeatIso, nowMs), staleMin);
}

// plan 2485: the pre-check has to mirror BOTH of demote's staleness axes now, or the very
// class this plan exists to break would be filtered out one layer ABOVE the fixed gate — a
// non-converging head's heartbeat is fresh by definition, so a liveness-only pre-check
// returns false and the waiter never spawns the CLI that would have demoted it. The
// convergence half reuses `convergenceStaleReason` itself (not a hand-rolled second
// comparison), so the boundary minute and the IN_LAND/HOLDING/absent-stamp abstentions
// cannot drift from the real verdict — the same drift-protection rule the heartbeat half
// follows via `ageIsFresh`. `headState`/`headProgressIso` come from the status payload;
// absent (a pre-2485 payload) → the axis abstains → falls back to the pre-2485 answer.
export function demoteLocallyEligible({
  headHeartbeatIso,
  nowMs,
  staleMin = DEFAULT_DEMOTE_STALE_MIN,
  headState = null,
  headProgressIso = null,
  convergeMin = DEFAULT_CONVERGE_STALE_MIN,
}) {
  if (!headHeartbeatLocallyFresh({ headHeartbeatIso, nowMs, staleMin })) return true;
  return (
    convergenceStaleReason(
      { slug: '(head)', state: headState, progressIso: headProgressIso },
      nowMs,
      convergeMin,
    ) != null
  );
}

// plan 2334 review [1]: overtake's local pre-check gets the same EXPORTED, unit-tested home
// as its three siblings instead of staying inline in done-worktree's verb table — otherwise
// the one row without a lib predicate is the row a future payload-knowable gate has nowhere
// to land in, which is the very asymmetry the ladder unification exists to remove.
// Its two payload-knowable preconditions (overtakeVerdict + the CLI's own gates hold the
// real ones — the verdict re-run inside the mutate, the path-disjointness probe, the
// 2-per-holder/24h cap): a 🟥 waiter is never overtake-eligible, and the head must actually
// be parked (state cell HOLDING) — the exact inverse of reapLocallyEligible's state gate,
// which is what keeps the two verbs from ever both firing on one head.
export function overtakeLocallyEligible({ lane, headState }) {
  return lane === 'free' && headState === HOLDING_STATE;
}

// reap's three payload-knowable refusals: the HOLDING state cell (overtake is that
// head's recourse, never reap — reapVerdict's own belt-and-suspenders gate), the
// IN_LAND state cell (plan 2414 — demote/steal are that head's recourse instead), and
// the age gate.
export function reapLocallyEligible({
  headState,
  headHeartbeatIso,
  nowMs,
  staleMin = DEFAULT_REAP_STALE_MIN,
}) {
  // plan 2414: mirrors reapVerdict's own unconditional IN_LAND refusal (spawn-avoidance
  // only — reapVerdict is the authoritative gate either way).
  if (headState === HOLDING_STATE || headState === IN_LAND_STATE) return false;
  return !headHeartbeatLocallyFresh({ headHeartbeatIso, nowMs, staleMin });
}

// ── plan 3450: the GHOST sweep caller ───────────────────────────────────────────────
// Every eviction verdict above is asked BY a queued waiter — headDisplacementVerdict's
// membership gate requires `positionOf(caller) >= 2`, because a demote/reap has always been
// a remedy for a session the dead head is actually blocking. The 2026-08-25 incident is the
// hole that leaves: head 3435 and its sole waiter 3424 were BOTH dead cloud sessions, so all
// three staleness thresholds were crossed with nobody alive left to ASK, and the verdicts —
// correct, cheap, already written — simply never ran (they live only inside a live waiter's
// landing-queue-watch poll loop).
//
// The sweep's answer is NOT to weaken that gate: a real caller must still be queued behind
// the head, byte-for-byte as before. Instead the sweep names itself an explicit, non-slug
// GHOST WAITER and appends it to the verdict's VIEW of the queue only — the verdicts then
// judge the head exactly as if a hypothetical tail waiter had asked. Everything else runs
// verbatim on the real entries: heartbeat staleness, the convergence axis, the IN_LAND
// immunity, the same-session refusal, the DEMOTE_CAP starvation cap, and (at the CLI layer)
// the 🟢 LANDING board refusal and the fail-closed heartbeat-ref read.
//
// Three properties make the ghost safe to hand a membership pass:
//   1. It is never written. The CLI applies every mutation to the UNDECORATED, ghost-free
//      entries (the same rule decorateWithHeartbeatRefs already follows), so the ghost can
//      never reach the doc or a position payload.
//   2. It can never collide with a real entry. `(sweep)` is parenthesized, and a queue slug
//      is a plan basename / branch name, which cannot be. `withGhostWaiter` still refuses
//      outright if one ever appears — a collision would let the sweep judge itself.
//   3. It carries UNKNOWN_SESSION, so `selfSessionRefusal` abstains rather than matching a
//      real session. The ghost belongs to no session; it must neither protect nor evict one.
export const SWEEP_CALLER = '(sweep)';

/**
 * The write-seam half of property 2 above (review round 1, F6). "It can never collide with a
 * real entry" was an ASSUMPTION about what a queue slug looks like, asserted only where the
 * queue is JUDGED (`withGhostWaiter` below) and enforced nowhere entries are CREATED — so a
 * caller could enqueue `(sweep)` and every later sweep would throw while adding its ghost,
 * report nothing to evict, and exit 0 with the dead head still in place.
 *
 * Review round 2 (G4) replaced the first cut's hand-rolled parenthesis test with the
 * repository-wide slug grammar `assertSlugCharset` already owns (claim-plan-lib.mjs). It
 * rejects `(sweep)` on its own — parentheses are not in `[A-Za-z0-9._-]` — AND it closes the
 * hole the narrower test left open: a slug like `foo|bar` or `foo bar` passed, then rendered as
 * a malformed table row whose cells shift under `cellsOf`, leaving the entry undequeueable. A
 * queue slug is a plan basename / branch name, which is exactly what that grammar describes, so
 * reusing it costs a real caller nothing and cannot drift away from the mint-side rule.
 *
 * Returns the refusal text, or null when the slug is writable.
 */
export function reservedSlugRefusal(slug) {
  try {
    assertSlugCharset(slug, 'slug');
    return null;
  } catch (e) {
    return (
      `"${slug}" cannot be a queue entry — ${e.message} Parenthesized names in particular are ` +
      `the sweep's reserved ghost caller (${SWEEP_CALLER}), which every eviction verdict appends ` +
      `to its VIEW of the queue: a real entry named like it would make every sweep refuse to ` +
      `judge the queue at all, leaving a dead head wedged.`
    );
  }
}

/**
 * The WRITE-SEAM enforcement of the rule above (review round 2, G4). The CLI's dispatch table
 * refuses a reserved name early, with a friendly exit 5 — but it covers only the verbs listed
 * there, so an older CLI, a sibling tool, or any future caller of these exported helpers could
 * still persist a row every later sweep refuses to judge. Asserted here instead, inside the
 * functions that actually CREATE or REWRITE an entry's slug cell, so every writer inherits it.
 * Throws; the CLI's own pre-check means a human typing a queue verb sees the friendly refusal
 * first.
 *
 * The covered seams (review round 3, H5 — the class, not just the named case). There are
 * exactly THREE places a slug cell is written, and all three assert:
 *   • enqueueEntry        — the FIFO append
 *   • insertPriorityEntry — the ⚡ front-block insert
 *   • requeueEntry        — the move-to-tail, whose `fallback` path invents a row for an
 *                           entry that vanished mid-flight (and which applyDemote rides)
 * Every other writer (heartbeatEntry, setEntryState, armReapEntry, decorateWithHeartbeatRefs,
 * applySteal / applyOvertake / applyReap) only ever matches an EXISTING entry by slug and
 * rewrites other cells, or removes/reorders rows — none can introduce a new slug string, so
 * none needs the guard. withGhostWaiter is verdict-only: its row is never persisted, and it
 * carries its own collision refusal instead.
 */
export function assertWritableSlug(slug) {
  const refusal = reservedSlugRefusal(slug);
  if (refusal) throw new Error(`landing-queue: ${refusal}`);
}

/**
 * The verdict-only view: `entries` plus a hypothetical tail waiter. Pure — returns a new
 * array; the caller keeps the original for the mutation itself.
 */
export function withGhostWaiter(entries, ghost = SWEEP_CALLER) {
  if (entries.some((e) => e.slug === ghost)) {
    throw new Error(
      `landing-queue: "${ghost}" is the sweep's reserved ghost caller and must never be a ` +
        `real queue entry — refusing to judge a queue that contains it`,
    );
  }
  return [
    ...entries,
    {
      slug: ghost,
      lane: '🟩',
      session: UNKNOWN_SESSION,
      host: ghost,
      enqueuedIso: null,
      heartbeatIso: null,
      pid: null,
      state: null,
      reapArmedIso: null,
      priority: false,
      progressIso: null,
    },
  ];
}
