// scripts/landing-queue-lib.test.mjs (plan 504)
// Pure queue math: parse/render round-trip, FIFO enqueue/dequeue, heartbeat,
// position, steal-staleness verdict + audit line. No fs, no git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUEUE_START,
  QUEUE_END,
  AUDIT_START,
  AUDIT_END,
  DEFAULT_STEAL_STALE_MIN,
  HOLDING_STATE,
  IN_LAND_STATE,
  UNKNOWN_SESSION,
  OVERTAKE_CAP,
  setEntryState,
  overtakeAuditCount,
  overtakeVerdict,
  applyOvertake,
  initialQueueDoc,
  parseQueue,
  renderQueue,
  enqueueEntry,
  insertPriorityEntry,
  frontBlockEnd,
  dequeueEntry,
  requeueEntry,
  reenterEntry,
  heartbeatEntry,
  pruneLanded,
  pruneLandedBatches,
  positionOf,
  // plan 3450: the ghost sweep caller + its reserved-name guard
  SWEEP_CALLER,
  withGhostWaiter,
  reservedSlugRefusal,
  headOf,
  stealVerdict,
  applySteal,
  batchMemberLandingRows,
  demoteVerdict,
  applyDemote,
  slugHoldsLandingRow,
  demoteAuditCount,
  DEMOTE_CAP,
  mechanicalHolderGoneVerdict,
  stealLocallyEligible,
  reapVerdict,
  armReapEntry,
  applyReap,
  DEFAULT_REAP_STALE_MIN,
  DEFAULT_REAP_GRACE_MIN,
  DEFAULT_DEMOTE_STALE_MIN,
  headHeartbeatLocallyFresh,
  ageIsFresh,
  demoteLocallyEligible,
  overtakeLocallyEligible,
  reapLocallyEligible,
  parseAuditLine,
  parseAuditRegion,
  requeueAuditLine,
  reenterAuditLine,
  // plan 2485: the convergence axis
  DEFAULT_CONVERGE_STALE_MIN,
  IN_LAND_CONVERGE_STALE_MIN,
  IN_LAND_CONVERGE_MULTIPLIER,
  convergenceStaleReason,
  convergenceBoundFor,
  convergenceInfo,
  CONVERGE_AXIS,
  HEARTBEAT_AXIS,
  // plan 2603: the ref-transport read fold
  decorateWithHeartbeatRefs,
} from './landing-queue-lib.mjs';

const T0 = '2026-06-10T08:00:00.000Z';
const T1 = '2026-06-10T08:05:00.000Z';
// plan 2414: session defaults to a PER-SLUG value (not a shared constant) — every
// pre-2414 test here builds queues from distinct slugs (different plans), which in
// production always carry distinct sessions too; a shared default would make every
// existing demoteVerdict fixture accidentally trip the new same-session refusal.
// Same-session cases are opted into explicitly via `over.session`.
const entry = (slug, lane = '🟥', over = {}) => ({
  slug,
  lane,
  session: `sess-${slug}`,
  host: 'T2020188',
  enqueuedIso: T0,
  heartbeatIso: T0,
  pid: null, // plan 2266: the trailing column every entry now carries (absent → null)
  state: null, // plan 2275: trailing state column ('' / absent → null; 'HOLDING' → parked)
  reapArmedIso: null, // plan 2331: trailing arm-then-fire grace-start column (absent → null)
  priority: false, // plan 2328: trailing ⚡ priority column ('' / absent → false)
  progressIso: null, // plan 2485: trailing land-progress column (absent → null → axis abstains)
  ...over,
});

test('initialQueueDoc parses to an empty queue with no audit lines', () => {
  const doc = initialQueueDoc();
  const { entries, auditLines } = parseQueue(doc);
  assert.deepEqual(entries, []);
  assert.deepEqual(auditLines, []);
  assert.ok(doc.includes(QUEUE_START) && doc.includes(QUEUE_END));
  assert.ok(doc.includes(AUDIT_START) && doc.includes(AUDIT_END));
});

test('parseQueue throws on a doc without sentinels', () => {
  assert.throws(() => parseQueue('# not a queue doc\n'), /sentinel/i);
});

// plan 3973 review round 4 (keys c6fdd6 / 91cf4a / 1b2fc7 / 5af1eb / 4915ec / 574172): round 3's
// `sawHeader` answered "was there a table row at all", so a corrupt doc that lost its header
// while KEEPING a live waiter row still reported a header — the waiter was consumed in the
// header's place and the document read as a valid, shorter queue.
test('sawHeader is true only for the REAL header row and its separator, never for a data row', () => {
  const doc = renderQueue(initialQueueDoc(), [entry('alpha'), entry('beta')], []);
  assert.equal(parseQueue(doc).sawHeader, true);
  assert.equal(parseQueue(initialQueueDoc()).sawHeader, true, 'an empty queue has its header');

  const lines = doc.split('\n');
  const headerIdx = lines.findIndex((l) => l.startsWith('| slug |'));
  // (a) the header row is gone; the separator and BOTH waiters remain.
  const headerless = [...lines.slice(0, headerIdx), ...lines.slice(headerIdx + 1)].join('\n');
  const h = parseQueue(headerless);
  assert.equal(h.sawHeader, false, 'a waiter row is never the header');
  assert.deepEqual(
    h.entries.map((e) => e.slug),
    ['beta'],
    'the parse silently loses the first waiter — which is why sawHeader must say so',
  );
  // (b) the separator is gone; the header row itself remains.
  const sepIdx = lines.findIndex((l, i) => i > headerIdx && /^\|[\s|:-]+\|$/.test(l));
  const noSeparator = [...lines.slice(0, sepIdx), ...lines.slice(sepIdx + 1)].join('\n');
  assert.equal(parseQueue(noSeparator).sawHeader, false, 'the header is the row AND its rule');
});

test('render → parse round-trips entries and audit lines, preserving order', () => {
  const entries = [entry('alpha', '🟥'), entry('beta', '🟩', { session: '432', host: 'H2' })];
  const audit = ['- 2026-06-10T08:30:00.000Z — beta stole head slot from alpha (stale 50m)'];
  const doc = renderQueue(initialQueueDoc(), entries, audit);
  const parsed = parseQueue(doc);
  assert.deepEqual(parsed.entries, entries);
  assert.deepEqual(parsed.auditLines, audit);
});

test('enqueueEntry appends at the tail (FIFO) and is idempotent on re-enqueue', () => {
  let q = enqueueEntry([], entry('alpha'));
  q = enqueueEntry(q, entry('beta', '🟩'));
  assert.deepEqual(
    q.map((e) => e.slug),
    ['alpha', 'beta'],
  );
  // re-enqueue of an existing slug keeps its POSITION and original timestamps
  const again = enqueueEntry(q, entry('alpha', '🟥', { enqueuedIso: T1, heartbeatIso: T1 }));
  assert.deepEqual(
    again.map((e) => e.slug),
    ['alpha', 'beta'],
  );
  assert.equal(again[0].enqueuedIso, T0, 're-enqueue must not reset the original enqueue time');
});

test('dequeueEntry removes the named slug and is a no-op when absent', () => {
  const q = [entry('alpha'), entry('beta')];
  assert.deepEqual(
    dequeueEntry(q, 'alpha').map((e) => e.slug),
    ['beta'],
  );
  assert.deepEqual(
    dequeueEntry(q, 'ghost').map((e) => e.slug),
    ['alpha', 'beta'],
  );
});

test('heartbeatEntry refreshes ONLY the named slug; absent slug is a no-op', () => {
  const q = [entry('alpha'), entry('beta')];
  const after = heartbeatEntry(q, 'alpha', T1);
  assert.equal(after[0].heartbeatIso, T1);
  assert.equal(after[1].heartbeatIso, T0, 'other entries untouched');
  assert.deepEqual(heartbeatEntry(q, 'ghost', T1), q);
});

test('positionOf is 1-based; 0 when absent; headOf is the first entry', () => {
  const q = [entry('alpha'), entry('beta')];
  assert.equal(positionOf(q, 'alpha'), 1);
  assert.equal(positionOf(q, 'beta'), 2);
  assert.equal(positionOf(q, 'ghost'), 0);
  assert.equal(headOf(q).slug, 'alpha');
  assert.equal(headOf([]), null);
});

test('stealVerdict refuses an in-date head (heartbeat fresh)', () => {
  const q = [entry('alpha'), entry('beta')];
  const nowMs = Date.parse(T0) + 10 * 60_000; // 10 min later — under the 45-min default
  const v = stealVerdict({ entries: q, stealer: 'beta', nowMs });
  assert.equal(v.ok, false);
  assert.match(v.reason, /fresh/i);
});

test('stealVerdict allows a stale head (> staleMin) and reports its age', () => {
  const q = [entry('alpha'), entry('beta')];
  const nowMs = Date.parse(T0) + 50 * 60_000; // 50 min — over the 45-min default
  const v = stealVerdict({ entries: q, stealer: 'beta', nowMs });
  assert.equal(v.ok, true);
  assert.equal(v.head.slug, 'alpha');
  assert.equal(v.ageMin, 50);
  assert.equal(DEFAULT_STEAL_STALE_MIN, 45);
});

test('stealVerdict treats a corrupt heartbeat timestamp as stale (cannot prove healthy)', () => {
  const q = [entry('alpha', '🟥', { heartbeatIso: 'garbage' }), entry('beta')];
  const v = stealVerdict({ entries: q, stealer: 'beta', nowMs: Date.parse(T0) });
  assert.equal(v.ok, true);
  assert.equal(v.ageMin, null);
});

test('stealVerdict refuses when the stealer IS the head or the queue is empty', () => {
  const q = [entry('alpha')];
  assert.equal(stealVerdict({ entries: q, stealer: 'alpha', nowMs: 0 }).ok, false);
  assert.equal(stealVerdict({ entries: [], stealer: 'x', nowMs: 0 }).ok, false);
});

test('stealVerdict: F-008 — a ghost slug that was never enqueued is refused, even with a stale head', () => {
  const q = [entry('alpha'), entry('real-second')];
  const nowMs = Date.parse(T0) + 50 * 60_000; // stale head — would otherwise be steal-eligible
  const v = stealVerdict({ entries: q, stealer: 'ghost-not-enqueued', nowMs });
  assert.equal(v.ok, false, 'a non-member stealer must never be granted the steal');
  assert.match(v.reason, /not queued/i);
  assert.match(v.reason, /real-second/); // names who WOULD legitimately be promoted
});

test('stealVerdict: F-008 — a stealer that is queued but NOT second-in-line is refused', () => {
  const q = [entry('alpha'), entry('real-second'), entry('third')];
  const nowMs = Date.parse(T0) + 50 * 60_000;
  const v = stealVerdict({ entries: q, stealer: 'third', nowMs });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not queued second-in-line/i);
});

test('stealVerdict: F-008 — a single-entry queue (no second-in-line) refuses any stealer', () => {
  const q = [entry('alpha')];
  const nowMs = Date.parse(T0) + 50 * 60_000;
  const v = stealVerdict({ entries: q, stealer: 'anyone', nowMs });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not queued at all/i);
});

test('stealVerdict: the legitimate second-in-line stealer still succeeds (regression)', () => {
  const q = [entry('alpha'), entry('beta')];
  const nowMs = Date.parse(T0) + 50 * 60_000;
  const v = stealVerdict({ entries: q, stealer: 'beta', nowMs });
  assert.equal(v.ok, true);
});

test('applySteal removes the head and writes an audit line naming stealer, victim, age', () => {
  const q = [entry('alpha'), entry('beta')];
  const r = applySteal(q, 'beta', T1, 50);
  assert.deepEqual(
    r.entries.map((e) => e.slug),
    ['beta'],
  );
  assert.match(r.auditLine, /beta/);
  assert.match(r.auditLine, /alpha/);
  assert.match(r.auditLine, /50m/);
  assert.match(r.auditLine, /^- /, 'audit line is a markdown bullet');
});

test('renderQueue is regenerative (idempotent under re-render) — coordWrite mutate contract', () => {
  const entries = [entry('alpha')];
  const once = renderQueue(initialQueueDoc(), entries, []);
  const twice = renderQueue(once, entries, []);
  assert.equal(once, twice);
});

// ── pruneLanded (plan 574): reap orphans by GROUND TRUTH, not heartbeat age ──
test('pruneLanded drops a landed entry and keeps a live one', () => {
  const q = [entry('561-landed'), entry('566-live')];
  const landed = new Set(['561-landed']); // 561's plan is in archive/
  const out = pruneLanded(q, (s) => landed.has(s));
  assert.deepEqual(
    out.map((e) => e.slug),
    ['566-live'],
  );
});

test('pruneLanded reaps the orphan even when it is the HEAD (the wedge case)', () => {
  // 561 landed but its teardown crashed before self-dequeue → it sits at the head,
  // wedging every waiter. Ground-truth prune removes it regardless of position.
  const q = [entry('561-landed'), entry('566-live'), entry('569-live')];
  const out = pruneLanded(q, (s) => s === '561-landed');
  assert.deepEqual(
    out.map((e) => e.slug),
    ['566-live', '569-live'],
  );
});

test('pruneLanded never touches a live waiter — a frozen heartbeat is NOT a prune signal', () => {
  // Both entries have an ancient (frozen) heartbeat — the normal state of a waiter,
  // since nothing refreshes a non-head heartbeat. Neither plan is archived, so NEITHER
  // is pruned: this is exactly why ground truth replaces heartbeat-staleness here.
  const q = [
    entry('484-waiting', '🟩', { heartbeatIso: T0 }),
    entry('569-waiting', '🟩', { heartbeatIso: T0 }),
  ];
  const out = pruneLanded(q, () => false); // nothing archived
  assert.deepEqual(out, q);
});

test('pruneLanded on an empty queue returns empty', () => {
  assert.deepEqual(
    pruneLanded([], () => true),
    [],
  );
});

test('pruneLanded reaps multiple orphans in a mixed batch, preserving order', () => {
  const q = [entry('a-landed'), entry('b-live'), entry('c-landed'), entry('d-live')];
  const landed = new Set(['a-landed', 'c-landed']);
  const out = pruneLanded(q, (s) => landed.has(s));
  assert.deepEqual(
    out.map((e) => e.slug),
    ['b-live', 'd-live'],
  );
});

// ── pruneLandedBatches (plan 1364 Ship 3): the batch-slug analogue of pruneLanded, opposite
// ── ground-truth polarity — a batch entry landed when its MANIFEST is GONE (not when a plan
// ── file appears in archive/, which a batch slug never has).
test('pruneLandedBatches: manifest ABSENT → the batch entry is pruned (landed)', () => {
  const q = [entry('batch-2026-07-03-x'), entry('566-live')];
  const out = pruneLandedBatches(
    q,
    (slug) => slug.startsWith('batch-'),
    () => false, // no manifest exists for ANY slug asked
  );
  assert.deepEqual(
    out.map((e) => e.slug),
    ['566-live'],
  );
});

test('pruneLandedBatches: manifest PRESENT → the batch entry is KEPT (still live/in-flight)', () => {
  const q = [entry('batch-2026-07-03-x'), entry('566-live')];
  const out = pruneLandedBatches(
    q,
    (slug) => slug.startsWith('batch-'),
    () => true, // manifest exists for every slug asked
  );
  assert.deepEqual(
    out.map((e) => e.slug),
    ['batch-2026-07-03-x', '566-live'],
  );
});

test('pruneLandedBatches: never touches a non-batch slug, regardless of manifestExists', () => {
  const q = [entry('561-single-plan')];
  const out = pruneLandedBatches(
    q,
    (slug) => slug.startsWith('batch-'),
    () => false, // would prune if this entry were mistaken for a batch
  );
  assert.deepEqual(out, q);
});

test('pruneLandedBatches: mixed queue — only the manifest-less batch entries are reaped', () => {
  const q = [
    entry('batch-landed-1'),
    entry('561-single-plan'),
    entry('batch-still-live'),
    entry('batch-landed-2'),
  ];
  const manifestPresent = new Set(['batch-still-live']);
  const out = pruneLandedBatches(
    q,
    (slug) => slug.startsWith('batch-'),
    (slug) => manifestPresent.has(slug),
  );
  assert.deepEqual(
    out.map((e) => e.slug),
    ['561-single-plan', 'batch-still-live'],
  );
});

// ── plan 1462: batchMemberLandingRows — the batch-aware steal-verifier's core ──
// A batch's 🟢 LANDING marker lives on a MEMBER row (its slug is the member's plan
// basename `<id>-desc`), so we match a LANDING row to the batch by its leading id.
const boardWith = (rows) =>
  [
    '# board',
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan/claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '<!-- BOARD-END -->',
  ].join('\n');
const row = (slug, state) => `| ${slug} | abc123 | ${state} | plan | 2026-07-06 | — |`;

test('plan 1462: a member row holding 🟢 LANDING is detected by its leading plan id', () => {
  const board = boardWith([row('1395-DQ-synth', '🟢 LANDING'), row('1396-DQ-other', '🔵 ACTIVE')]);
  assert.deepEqual(batchMemberLandingRows(board, ['1395', '1396']), ['1395-DQ-synth']);
});

test('plan 1462: no member row is LANDING → empty (batch not mid-land; the >stale-min gate decides)', () => {
  const board = boardWith([row('1395-DQ-synth', '🔵 ACTIVE'), row('1396-DQ-other', '🔵 ACTIVE')]);
  assert.deepEqual(batchMemberLandingRows(board, ['1395', '1396']), []);
});

test('plan 1462: a LANDING row for a NON-member id is ignored (only THIS batch counts)', () => {
  // 1500 is a foreign single-plan land mid-flight; it must not make us refuse a steal
  // of an unrelated stale batch whose own members are idle.
  const board = boardWith([
    row('1500-Foreign-land', '🟢 LANDING'),
    row('1395-DQ-synth', '🔵 ACTIVE'),
  ]);
  assert.deepEqual(batchMemberLandingRows(board, ['1395', '1396']), []);
});

test('plan 1462: column-exact — "🟢 LANDING" only in another row\'s RESUME prose never false-matches', () => {
  // board-lib.landingRows matches the State cell exactly; a member row whose RESUME cell
  // merely mentions the marker text is NOT a held mutex (the plan-230 deadlock guard).
  const board = boardWith([
    `| 1395-DQ-synth | abc123 | 🔵 ACTIVE | plan | 2026-07-06 | QUEUED behind X's 🟢 LANDING mutex |`,
  ]);
  assert.deepEqual(batchMemberLandingRows(board, ['1395']), []);
});

test('plan 1462: multiple member rows LANDING → all returned (defensive; a batch normally holds one)', () => {
  const board = boardWith([row('1395-DQ-synth', '🟢 LANDING'), row('1396-DQ-other', '🟢 LANDING')]);
  assert.deepEqual(batchMemberLandingRows(board, ['1395', '1396']), [
    '1395-DQ-synth',
    '1396-DQ-other',
  ]);
});

test('plan 1462: unparseable board or no members → [] (fail-open; the heartbeat gate still applies)', () => {
  assert.deepEqual(batchMemberLandingRows('not a board at all', ['1395']), []);
  assert.deepEqual(batchMemberLandingRows(boardWith([row('1395-x', '🟢 LANDING')]), []), []);
  assert.deepEqual(batchMemberLandingRows(boardWith([row('1395-x', '🟢 LANDING')]), null), []);
});

// ── plan 1528: requeueEntry — atomic move-to-tail for the requeue-on-heavy-rework op ──

test('plan 1528: requeueEntry moves the slug to the tail with fresh timestamps, others keep order', () => {
  const entries = [
    { slug: 'a', lane: '🟥', session: '1', host: 'h', enqueuedIso: 'T1', heartbeatIso: 'T1' },
    { slug: 'b', lane: '🟩', session: '2', host: 'h', enqueuedIso: 'T2', heartbeatIso: 'T2' },
    { slug: 'c', lane: '🟩', session: '3', host: 'h', enqueuedIso: 'T3', heartbeatIso: 'T3' },
  ];
  const r = requeueEntry(entries, 'a', 'T9');
  assert.deepEqual(
    r.entries.map((e) => e.slug),
    ['b', 'c', 'a'],
  );
  const moved = r.entries[2];
  assert.equal(moved.enqueuedIso, 'T9', 'fresh tail timestamp — no queue-age credit kept');
  assert.equal(moved.heartbeatIso, 'T9');
  assert.equal(moved.lane, '🟥', 'lane carries over from the existing entry');
  assert.equal(moved.session, '1');
  assert.equal(r.entry.slug, 'a');
  // input untouched (pure)
  assert.equal(entries[0].enqueuedIso, 'T1');
});

test('plan 1528: requeueEntry on an absent slug appends the fallback (stolen/reaped mid-flight)', () => {
  const entries = [
    { slug: 'b', lane: '🟩', session: '2', host: 'h', enqueuedIso: 'T2', heartbeatIso: 'T2' },
  ];
  const fb = { slug: 'gone', lane: '🟥', session: '9', host: 'pc' };
  const r = requeueEntry(entries, 'gone', 'T9', fb);
  assert.deepEqual(
    r.entries.map((e) => e.slug),
    ['b', 'gone'],
  );
  assert.equal(r.entries[1].enqueuedIso, 'T9');
  assert.equal(r.entries[1].lane, '🟥');
  // no fallback → the queue is left as-is (never invents an entry from nothing)
  const none = requeueEntry(entries, 'gone', 'T9');
  assert.deepEqual(
    none.entries.map((e) => e.slug),
    ['b'],
  );
  assert.equal(none.entry, null);
});

// ── plan 2517 (supersedes plan 2170 Ship 2): reenterEntry is now a PLAIN TAIL enqueue ──
// Operator ruling: "a plan carries no priority... it re-enters at the TAIL" — the old
// preserved-position sorted insertion (behind earlier isos, ahead of later ones) is gone;
// reenterEntry is now byte-identical to enqueueEntry's idempotent tail append.

const rentry = (slug, iso, extra = {}) => ({
  slug,
  lane: '🟩',
  session: '1',
  host: 'h',
  enqueuedIso: iso,
  heartbeatIso: iso,
  ...extra,
});

test('plan 2517: reenterEntry appends at the TAIL — ignores the (now-vestigial) enqueuedIso ordering', () => {
  const entries = [rentry('a', 'T1'), rentry('c', 'T3'), rentry('d', 'T4')];
  const r = reenterEntry(entries, rentry('b', 'T2', { heartbeatIso: 'T9' }));
  assert.deepEqual(
    r.map((e) => e.slug),
    ['a', 'c', 'd', 'b'],
    'no back-of-queue starvation exemption — re-entry earns no position (plan 2517)',
  );
  assert.equal(r[3].heartbeatIso, 'T9', 'heartbeat is the caller-supplied FRESH one');
  // input untouched (pure)
  assert.deepEqual(
    entries.map((e) => e.slug),
    ['a', 'c', 'd'],
  );
});

test('plan 2517: reenterEntry NEVER displaces the in-flight head — a tail append trivially cannot', () => {
  const entries = [rentry('head', 'T5'), rentry('w1', 'T6')];
  const r = reenterEntry(entries, rentry('back', 'T1'));
  assert.deepEqual(
    r.map((e) => e.slug),
    ['head', 'w1', 'back'],
    'a re-entrant lands at the tail regardless of how old its enqueuedIso is',
  );
});

test('plan 2517: reenterEntry into an empty queue → position 1 (no head to protect)', () => {
  assert.deepEqual(
    reenterEntry([], rentry('only', 'T1')).map((e) => e.slug),
    ['only'],
  );
});

test('plan 2517: reenterEntry is idempotent — slug already queued → entries unchanged', () => {
  const entries = [rentry('a', 'T1'), rentry('b', 'T2')];
  assert.equal(reenterEntry(entries, rentry('b', 'T0')), entries);
});

// ── plan 2328: priority (⚡) front-block insertion + class-aware re-entry ───────────

test('plan 2328: render → parse round-trips the ⚡ cell; a field-less legacy row parses as normal', () => {
  const doc = renderQueue(
    initialQueueDoc(),
    [entry('p', '🟩', { priority: true }), entry('n')],
    [],
  );
  const parsed = parseQueue(doc).entries;
  assert.equal(parsed[0].priority, true);
  assert.equal(parsed[1].priority, false);
  // A pre-2328 9-column row (no priority cell at all) parses as a NORMAL entry.
  const legacy = initialQueueDoc().replace(
    QUEUE_END,
    `| old | 🟥 | 1 | h | ${T0} | ${T0} | | | |\n${QUEUE_END}`,
  );
  const [old] = parseQueue(legacy).entries;
  assert.equal(old.slug, 'old');
  assert.equal(old.priority, false);
});

test('plan 2328: insertPriorityEntry inserts at position 2 — the head is NEVER displaced', () => {
  const q = [entry('head'), entry('w1'), entry('w2')];
  const r = insertPriorityEntry(q, entry('urgent', '🟩', { priority: true }));
  assert.deepEqual(
    r.map((e) => e.slug),
    ['head', 'urgent', 'w1', 'w2'],
  );
  // input untouched (pure); empty queue → position 1; idempotent on a present slug
  assert.equal(q.length, 3);
  assert.deepEqual(
    insertPriorityEntry([], entry('only', '🟩', { priority: true })).map((e) => e.slug),
    ['only'],
  );
  assert.equal(insertPriorityEntry(r, entry('urgent', '🟩', { priority: true })), r);
});

test('plan 2328: FIFO among priority entries — a new ⚡ inserts after the LAST front-block ⚡', () => {
  const q = [entry('head'), entry('p1', '🟩', { priority: true }), entry('w1')];
  const r = insertPriorityEntry(q, entry('p2', '🟩', { priority: true }));
  assert.deepEqual(
    r.map((e) => e.slug),
    ['head', 'p1', 'p2', 'w1'],
  );
  assert.equal(frontBlockEnd(r), 3); // head + p1 + p2
});

test('plan 2328: a ⚡ entry moved to the tail by requeue is OUTSIDE the front block — not an insertion anchor', () => {
  const q = [entry('head'), entry('w1'), entry('tail-p', '🟩', { priority: true })];
  assert.equal(frontBlockEnd(q), 1); // the block is CONTIGUOUS from the head
  const r = insertPriorityEntry(q, entry('p2', '🟩', { priority: true }));
  assert.deepEqual(
    r.map((e) => e.slug),
    ['head', 'p2', 'w1', 'tail-p'],
  );
});

test('plan 2328: a normal enqueue never enters the front block — plain tail append behind every ⚡', () => {
  const q = [entry('head'), entry('p1', '🟩', { priority: true })];
  assert.deepEqual(
    enqueueEntry(q, entry('n1')).map((e) => e.slug),
    ['head', 'p1', 'n1'],
  );
});

test('plan 2517 (supersedes 2328): reenterEntry ignores the priority flag — a ⚡ re-entrant still lands at the TAIL, outside the front block', () => {
  const q = [rentry('head', 'T5'), rentry('p1', 'T1', { priority: true }), rentry('w1', 'T0')];
  const r = reenterEntry(q, rentry('p2', 'T2', { priority: true, heartbeatIso: 'T9' }));
  assert.deepEqual(
    r.map((e) => e.slug),
    ['head', 'p1', 'w1', 'p2'],
    'priority carries no standing on re-entry (operator ruling, plan 2517)',
  );
  assert.equal(frontBlockEnd(r), 2, 'p2 sits behind the front block despite its ⚡ flag');
});

test('plan 2328 (review fix): requeue/demote to the tail CLEARS the ⚡ flag — a demoted entry cannot wedge overtakes', () => {
  const q = [
    entry('hold', '🟥', { state: HOLDING_STATE }),
    entry('was-prio', '🟥', { priority: true }),
    entry('me', '🟩'),
  ];
  // the ⚡ entry gets demoted/requeued to the tail — standing revoked, flag cleared
  const rq = requeueEntry(q, 'was-prio', T1);
  assert.equal(rq.entry.priority, false, 'requeue clears the ⚡ flag alongside state/reapArmedIso');
  assert.deepEqual(
    rq.entries.map((e) => e.slug),
    ['hold', 'me', 'was-prio'],
  );
  // …and the 🟩 waiter's overtake of the HOLDING head now proceeds (no stale ⚡ block)
  const v = overtakeVerdict({ entries: rq.entries, overtaker: 'me', nowMs: Date.parse(T1) });
  assert.equal(v.ok, true);
  // whereas a ⚡ entry DISPLACED mid-queue through no verb of its own (applyOvertake
  // parks the holder at position 2, pushing the former front block behind it) keeps
  // its precedence claim — the guard scans the raw range on purpose.
  const afterOvertake = [
    entry('overtaker', '🟩', { state: HOLDING_STATE }), // now head, later parks HOLDING
    entry('old-hold', '🟥'),
    entry('p1', '🟩', { priority: true }), // displaced ⚡ — still owed precedence
    entry('me2', '🟩'),
  ];
  const v2 = overtakeVerdict({ entries: afterOvertake, overtaker: 'me2', nowMs: Date.parse(T1) });
  assert.equal(v2.ok, false);
  assert.match(v2.reason, /leapfrog/);
  assert.match(v2.reason, /p1/);
});

test('plan 2328: overtakeVerdict refuses an overtake that would leapfrog a ⚡ entry — loudly, naming it', () => {
  const entries = [
    entry('hold', '🟥', { state: HOLDING_STATE }),
    entry('p1', '🟥', { priority: true }), // 🟥 ⚡ — itself lane-refused from overtaking
    entry('me', '🟩'),
  ];
  const v = overtakeVerdict({ entries, overtaker: 'me', nowMs: Date.parse(T1) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /leapfrog/);
  assert.match(v.reason, /p1/);
  // the entry DIRECTLY behind the head has nothing to leapfrog — still eligible
  const direct = overtakeVerdict({
    entries: [entry('hold', '🟥', { state: HOLDING_STATE }), entry('me', '🟩')],
    overtaker: 'me',
    nowMs: Date.parse(T1),
  });
  assert.equal(direct.ok, true);
  // and a 🟩 ⚡ waiter directly behind the head may overtake as before
  const prioFirst = overtakeVerdict({
    entries: [
      entry('hold', '🟥', { state: HOLDING_STATE }),
      entry('p1', '🟩', { priority: true }),
      entry('me', '🟩'),
    ],
    overtaker: 'p1',
    nowMs: Date.parse(T1),
  });
  assert.equal(prioFirst.ok, true);
});

// ── plan 1682: waiter-side auto-demote of a not-ready head ─────────────────────────
// demoteVerdict is the deterministic core (the CLI layers the fresh 🟢 LANDING board
// gate on top); default threshold 15 min, starvation cap 2 per 24h from the doc's own
// audit trail. Clock injected via nowMs, same as stealVerdict's tests.

const T_FRESH_MS = Date.parse('2026-06-10T08:10:00.000Z'); // 10 min after T0 — under 15
const T_STALE_MS = Date.parse('2026-06-10T08:20:00.000Z'); // 20 min after T0 — over 15

test('plan 1682: demoteVerdict refuses an empty queue, a head demoter, and an unqueued demoter', () => {
  assert.match(demoteVerdict({ entries: [], demoter: 'w', nowMs: T_STALE_MS }).reason, /empty/i);
  const q = [entry('hog'), entry('w', '🟩')];
  assert.match(
    demoteVerdict({ entries: q, demoter: 'hog', nowMs: T_STALE_MS }).reason,
    /already head/i,
  );
  assert.match(
    demoteVerdict({ entries: q, demoter: 'ghost', nowMs: T_STALE_MS }).reason,
    /not queued behind/i,
  );
});

test('plan 1682: fresh head refused; stale head OK from ANY waiter position; unparseable heartbeat = stale', () => {
  const q = [entry('hog'), entry('w', '🟩'), entry('x', '🟩')];
  const fresh = demoteVerdict({ entries: q, demoter: 'x', nowMs: T_FRESH_MS });
  assert.equal(fresh.ok, false);
  assert.match(fresh.reason, /fresh/i);
  const stale = demoteVerdict({ entries: q, demoter: 'x', nowMs: T_STALE_MS });
  assert.equal(
    stale.ok,
    true,
    'position 3 may demote — any harmed waiter, not only second-in-line',
  );
  assert.equal(stale.head.slug, 'hog');
  assert.equal(stale.ageMin, 20);
  const corrupt = [entry('hog', '🟥', { heartbeatIso: 'garbage' }), entry('w', '🟩')];
  assert.equal(
    demoteVerdict({ entries: corrupt, demoter: 'w', nowMs: T_FRESH_MS }).ok,
    true,
    'corrupt heartbeat cannot be proven healthy (stealVerdict semantics)',
  );
});

test('plan 1682: starvation cap — 2 recent auto-demotes refuse a 3rd; stale/foreign audit lines never count', () => {
  const q = [entry('hog'), entry('w', '🟩')];
  const line = (iso, slug) =>
    `- ${iso} — auto-demote: ${slug} → tail (heartbeat age 20m > 15m, not landing) by w`;
  const recent = [line('2026-06-10T07:00:00.000Z', 'hog'), line('2026-06-10T07:30:00.000Z', 'hog')];
  const capped = demoteVerdict({ entries: q, auditLines: recent, demoter: 'w', nowMs: T_STALE_MS });
  assert.equal(capped.ok, false);
  assert.match(capped.reason, /starvation cap/i);
  assert.match(capped.reason, /steal/i, 'the refusal names the remaining recourse');
  // outside the 24h window → not counted
  const old = [line('2026-06-07T07:00:00.000Z', 'hog'), line('2026-06-07T07:30:00.000Z', 'hog')];
  assert.equal(
    demoteVerdict({ entries: q, auditLines: old, demoter: 'w', nowMs: T_STALE_MS }).ok,
    true,
  );
  // a different slug's demotes → not counted; steal/requeue audit lines → not counted
  const foreign = [
    line('2026-06-10T07:00:00.000Z', 'other-slug'),
    '- 2026-06-10T07:10:00.000Z — hog requeued to tail — heavy head rework (plan 1528)',
    '- 2026-06-10T07:20:00.000Z — w stole the head slot from hog (heartbeat stale 50m)',
  ];
  assert.equal(
    demoteVerdict({ entries: q, auditLines: foreign, demoter: 'w', nowMs: T_STALE_MS }).ok,
    true,
  );
  // an unparseable timestamp on a matching line counts (conservative)
  const corrupt = [line('not-a-date', 'hog'), line('also-not-a-date', 'hog')];
  assert.equal(demoteAuditCount(corrupt, 'hog', T_STALE_MS), DEMOTE_CAP);
});

// ── plan 2414: self-demote refusal + the IN_LAND liveness-backed immunity ──────────
// The 2026-07-25 incident: a free-lane land never sets the 🟢 LANDING board row (only
// 🟥 does — the CLI's own gate on top of demoteVerdict), so the ENTIRE free lane was
// demote-eligible on heartbeat age alone once a healthy gate-phase battery outlived the
// 15-min staleMin. IN_LAND is the lane-agnostic liveness token that closes that; the
// demoter/head sharing a `session` is the second, independent fix (a session evicting
// its own other queued land is never useful).

test('plan 2414: same-session demoter refused even though the head is stale (self-demote)', () => {
  const q = [entry('hog', '🟥', { session: 'sess-A' }), entry('w', '🟩', { session: 'sess-A' })];
  const v = demoteVerdict({ entries: q, demoter: 'w', nowMs: T_STALE_MS });
  assert.equal(v.ok, false);
  assert.match(v.reason, /same session/i);
  assert.match(v.reason, /sess-A/);
  assert.match(v.reason, /hog/);
  assert.match(v.reason, /w/);
});

test('plan 2414: DIFFERENT sessions demote normally; the "?" placeholder never counts as a match', () => {
  const distinct = [
    entry('hog', '🟥', { session: 'sess-A' }),
    entry('w', '🟩', { session: 'sess-B' }),
  ];
  assert.equal(demoteVerdict({ entries: distinct, demoter: 'w', nowMs: T_STALE_MS }).ok, true);
  // two entries BOTH carrying the CLI's own '?' placeholder (no --session ever passed)
  // are NOT thereby known to share a session.
  const bothUnknown = [
    entry('hog', '🟥', { session: UNKNOWN_SESSION }),
    entry('w', '🟩', { session: UNKNOWN_SESSION }),
  ];
  assert.equal(demoteVerdict({ entries: bothUnknown, demoter: 'w', nowMs: T_STALE_MS }).ok, true);
});

test('plan 2414: IN_LAND head is immune while a same-host pid is verified ALIVE, past the demote staleMin', () => {
  const q = [entry('hog', '🟩', { state: IN_LAND_STATE }), entry('w', '🟩', { session: 'sess-w' })];
  const v = demoteVerdict({ entries: q, demoter: 'w', nowMs: T_STALE_MS, holderPidAlive: true });
  assert.equal(v.ok, false);
  assert.match(v.reason, /IN_LAND/);
  assert.match(v.reason, /pid is verified alive/i);
});

test('plan 2414: IN_LAND head loses immunity once a same-host pid is verified DEAD (provably gone)', () => {
  const q = [entry('hog', '🟩', { state: IN_LAND_STATE }), entry('w', '🟩', { session: 'sess-w' })];
  const v = demoteVerdict({ entries: q, demoter: 'w', nowMs: T_STALE_MS, holderPidAlive: false });
  assert.equal(v.ok, true, 'a verified-dead pid is never "provably alive" — no immunity');
  assert.equal(v.head.slug, 'hog');
});

test('plan 2414: IN_LAND head with an UNPROBEABLE pid (cross-host) leans on the 45-min steal leash, not the 15-min demote staleMin', () => {
  const q = [entry('hog', '🟩', { state: IN_LAND_STATE }), entry('w', '🟩', { session: 'sess-w' })];
  // 20m: past the 15-min demote staleMin, but under the 45-min steal leash → still immune
  const stillLeashed = demoteVerdict({
    entries: q,
    demoter: 'w',
    nowMs: T_STALE_MS,
    holderPidAlive: null,
  });
  assert.equal(stillLeashed.ok, false);
  assert.match(stillLeashed.reason, /steal threshold/i);
  // past the 45-min leash → the free-standing immunity finally expires
  const T_PAST_STEAL_MS = Date.parse('2026-06-10T08:50:00.000Z'); // 50m after T0
  const expired = demoteVerdict({
    entries: q,
    demoter: 'w',
    nowMs: T_PAST_STEAL_MS,
    holderPidAlive: null,
  });
  assert.equal(expired.ok, true);
  assert.equal(expired.head.slug, 'hog');
});

test('plan 2414 review fix: a VERIFIED-ALIVE pid does NOT grant unconditional immunity — it expires at the same 45-min leash', () => {
  // The first draft let holderPidAlive===true bypass the leash entirely, which meant a
  // genuinely wedged-but-alive (never crashing, never progressing) process could block
  // every waiter's demote forever — a NEW, less-discoverable livelock than the one this
  // plan fixes. Every IN_LAND immunity, alive-pid included, must expire.
  const q = [entry('hog', '🟩', { state: IN_LAND_STATE }), entry('w', '🟩', { session: 'sess-w' })];
  const T_PAST_STEAL_MS = Date.parse('2026-06-10T08:50:00.000Z'); // 50m after T0
  const stillAliveButExpired = demoteVerdict({
    entries: q,
    demoter: 'w',
    nowMs: T_PAST_STEAL_MS,
    holderPidAlive: true,
  });
  assert.equal(
    stillAliveButExpired.ok,
    true,
    'a verified-alive pid no longer blocks demote once the 45-min leash itself has expired',
  );
  assert.equal(stillAliveButExpired.head.slug, 'hog');
});

test('plan 2414: a HOLDING head (not IN_LAND) is untouched by the IN_LAND gate — demote runs its normal course', () => {
  // HOLDING and IN_LAND share one trailing-state column and are mutually exclusive —
  // demote's pre-existing behaviour toward a HOLDING head (unaffected by this plan;
  // the CLI's own board-LANDING gate is what protects a 🟥 hold-through-conflict) must
  // not accidentally start consulting holderPidAlive too.
  const q = [entry('hog', '🟥', { state: HOLDING_STATE }), entry('w', '🟩', { session: 'sess-w' })];
  const v = demoteVerdict({ entries: q, demoter: 'w', nowMs: T_STALE_MS, holderPidAlive: true });
  assert.equal(v.ok, true, 'holderPidAlive is only ever consulted for an IN_LAND head');
});

// ── plan 2485: the CONVERGENCE axis ────────────────────────────────────────────────────
// Clocks for the new axis. The liveness heartbeat stays FRESH throughout every case below
// (that is the whole point — a non-converging head is one whose heartbeat is being kept
// warm by something alive), so each fixture stamps heartbeatIso at the reference NOW and
// varies only progressIso.
const NOW_ISO = '2026-06-10T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const minsAgo = (m) => new Date(NOW_MS - m * 60_000).toISOString();
// A head that is ALIVE (heartbeat stamped seconds ago — the plan-2085 self-arm cadence is
// DEFAULT_DEMOTE_STALE_MIN/3, so a live entry always reads fresh) with a progress stamp
// `progressMinAgo` old.
const liveHead = (slug, progressMinAgo, over = {}) =>
  entry(slug, '🟥', {
    heartbeatIso: minsAgo(1),
    progressIso: progressMinAgo == null ? null : minsAgo(progressMinAgo),
    ...over,
  });

test('plan 2485 invariant 1: a head that heartbeats on cadence but stamps NO land progress past the bound becomes demote-eligible', () => {
  const q = [liveHead('hog', DEFAULT_CONVERGE_STALE_MIN + 15), entry('w', '🟩')];
  // Sanity: the liveness axis alone cannot see this head at all — it is genuinely fresh.
  assert.equal(
    ageIsFresh(1, DEFAULT_DEMOTE_STALE_MIN),
    true,
    'the fixture models a head the plan-1682 gate must consider fresh',
  );
  const v = demoteVerdict({ entries: q, demoter: 'w', nowMs: NOW_MS });
  assert.equal(v.ok, true, 'the convergence axis carries the verdict a fresh heartbeat hides');
  assert.equal(v.staleAxis, 'converge');
  assert.match(v.staleReason, /no land progress for 60m > 45m/);
  assert.equal(v.head.slug, 'hog');
});

test('plan 2485 invariant 2: a genuinely-converging slow head stays demote-immune', () => {
  // Modelled on the measured healthy population: tip→merge max was 23m23s over n=297, so a
  // head that stamped progress 23m ago is the WORST healthy case in the window and must be
  // immune with room to spare.
  const q = [liveHead('hog', 23), entry('w', '🟩')];
  const v = demoteVerdict({ entries: q, demoter: 'w', nowMs: NOW_MS });
  assert.equal(v.ok, false, 'the worst healthy inter-progress gap is still converging');
  assert.match(v.reason, /heartbeat is fresh/);
  // …and it stays immune right up to the boundary minute, inclusive.
  const atBound = [liveHead('hog', DEFAULT_CONVERGE_STALE_MIN), entry('w', '🟩')];
  assert.equal(
    demoteVerdict({ entries: atBound, demoter: 'w', nowMs: NOW_MS }).ok,
    false,
    'the bound is inclusive — exactly at it is still converging (ageIsFresh semantics)',
  );
});

test('plan 2485 invariant 1: a HOLDING head is NEVER convergence-eligible (plan 2275 owns it)', () => {
  const q = [
    liveHead('hog', DEFAULT_CONVERGE_STALE_MIN * 10, { state: HOLDING_STATE }),
    entry('w', '🟩'),
  ];
  const v = demoteVerdict({ entries: q, demoter: 'w', nowMs: NOW_MS });
  assert.equal(v.ok, false, 'a parked-off-spine head is the bounded overtake’s business');
  assert.match(v.reason, /heartbeat is fresh/);
  assert.equal(convergenceStaleReason(q[0], NOW_MS), null, 'the axis abstains on HOLDING');
});

test('plan 2485: an IN_LAND head gets the WIDER merge-window leash, and it still expires', () => {
  // Inside the leash: immune, even though it is well past the non-IN_LAND bound.
  const inside = [
    liveHead('hog', DEFAULT_CONVERGE_STALE_MIN + 15, { state: IN_LAND_STATE }),
    entry('w', '🟩'),
  ];
  assert.equal(
    demoteVerdict({ entries: inside, demoter: 'w', nowMs: NOW_MS }).ok,
    false,
    'the merge window earns the wider bound — 60m < 90m',
  );
  // Past it: eligible. This is the deliberate deviation from a BLANKET IN_LAND exemption —
  // IN_LAND is stamped at head-acquisition and never cleared while the entry stays at head,
  // so a blanket exemption would make the axis a no-op on every long-tenured head.
  const past = [
    liveHead('hog', IN_LAND_CONVERGE_STALE_MIN + 10, { state: IN_LAND_STATE }),
    entry('w', '🟩'),
  ];
  const v = demoteVerdict({ entries: past, demoter: 'w', nowMs: NOW_MS });
  assert.equal(v.ok, true, 'an IN_LAND head that stamps no progress for 100m is not landing');
  assert.equal(v.staleAxis, 'converge');
  assert.match(v.staleReason, /IN_LAND merge-window leash/);
});

test('plan 2485: a fresh-heartbeat IN_LAND head with a VERIFIED-ALIVE pid is still convergence-eligible', () => {
  // The plan-2414 heartbeat leash cannot expire against a self-arm that refreshes the
  // heartbeat every DEFAULT_DEMOTE_STALE_MIN/3 minutes, and a live pid only proves the
  // PROCESS is up — not that the land is moving. Convergence must not be defeated by either.
  const q = [
    liveHead('hog', IN_LAND_CONVERGE_STALE_MIN + 10, { state: IN_LAND_STATE, pid: '4242' }),
    entry('w', '🟩'),
  ];
  const v = demoteVerdict({ entries: q, demoter: 'w', nowMs: NOW_MS, holderPidAlive: true });
  assert.equal(v.ok, true, 'alive ≠ converging — that conflation IS the bug plan 2485 fixes');
  assert.equal(v.staleAxis, 'converge');
});

test('plan 2485: the heartbeat axis and the IN_LAND heartbeat leash are untouched when progress is fresh', () => {
  // A STALE heartbeat + IN_LAND + alive pid must still refuse exactly as plan 2414 wrote it
  // (this is the healthy long-gate-battery case), and the convergence axis must not have
  // quietly become a second way in.
  const q = [
    entry('hog', '🟥', {
      heartbeatIso: minsAgo(DEFAULT_DEMOTE_STALE_MIN + 5),
      progressIso: minsAgo(5),
      state: IN_LAND_STATE,
      pid: '4242',
    }),
    entry('w', '🟩'),
  ];
  const v = demoteVerdict({ entries: q, demoter: 'w', nowMs: NOW_MS, holderPidAlive: true });
  assert.equal(v.ok, false);
  assert.match(v.reason, /stamped IN_LAND/, 'plan 2414’s refusal text, unchanged');
});

test('plan 2485: an ABSENT/unparseable progress stamp makes the axis abstain (fail-safe, pre-2485 rows)', () => {
  // The established trailing-column rule: a pre-2485 session's renderQueue drops the cell, so
  // "cannot read progress" must never read as "not progressing".
  for (const progressIso of [null, undefined, '', 'garbage']) {
    const q = [entry('hog', '🟥', { heartbeatIso: minsAgo(1), progressIso }), entry('w', '🟩')];
    const v = demoteVerdict({ entries: q, demoter: 'w', nowMs: NOW_MS });
    assert.equal(v.ok, false, `progressIso=${JSON.stringify(progressIso)} must abstain, not fire`);
    assert.match(v.reason, /heartbeat is fresh/);
  }
});

test('plan 2485: convergeMin 0/negative disables the axis entirely — for EVERY head phase (review [1])', () => {
  // The operator escape hatch (`demote --converge-min 0`) must take the axis out of the
  // picture on an IN_LAND head too — that is the phase where it is most likely to be reached
  // for during a live incident, and a fixed IN_LAND bound would have silently ignored it.
  for (const state of [null, IN_LAND_STATE, HOLDING_STATE]) {
    const q = [liveHead('hog', 999, { state }), entry('w', '🟩')];
    for (const convergeMin of [0, -1]) {
      assert.equal(
        demoteVerdict({ entries: q, demoter: 'w', nowMs: NOW_MS, convergeMin }).ok,
        false,
        `convergeMin=${convergeMin} must opt out for state=${state}`,
      );
      assert.equal(convergenceBoundFor(q[0], convergeMin), null, 'no bound ⇒ axis abstains');
    }
  }
});

test('plan 2485: the IN_LAND leash SCALES with convergeMin — one bound resolver, no hand-copied ternary', () => {
  // convergenceBoundFor is the single owner (review [4]/[5]); the IN_LAND leash is a MULTIPLE
  // of the caller's bound, so an override applies uniformly instead of being overridden by a
  // fixed constant.
  assert.equal(convergenceBoundFor(entry('h'), DEFAULT_CONVERGE_STALE_MIN), 45);
  assert.equal(
    convergenceBoundFor(entry('h', '🟥', { state: IN_LAND_STATE }), DEFAULT_CONVERGE_STALE_MIN),
    IN_LAND_CONVERGE_STALE_MIN,
    'the documented default pair (45 → 90) is preserved exactly',
  );
  assert.equal(
    IN_LAND_CONVERGE_STALE_MIN,
    DEFAULT_CONVERGE_STALE_MIN * IN_LAND_CONVERGE_MULTIPLIER,
    'the exported constant and the multiplier cannot drift apart',
  );
  assert.equal(
    convergenceBoundFor(entry('h', '🟥', { state: IN_LAND_STATE }), 200),
    400,
    'a raised bound raises the IN_LAND leash with it',
  );
  assert.equal(convergenceBoundFor(entry('h', '🟥', { state: HOLDING_STATE }), 45), null);
  assert.equal(convergenceBoundFor(null, 45), null);
  // A widened override really does spare a head the default would have demoted.
  const q = [liveHead('hog', 60), entry('w', '🟩')];
  assert.equal(demoteVerdict({ entries: q, demoter: 'w', nowMs: NOW_MS }).ok, true);
  assert.equal(
    demoteVerdict({ entries: q, demoter: 'w', nowMs: NOW_MS, convergeMin: 120 }).ok,
    false,
    '--converge-min 120 spares a head 60m without progress',
  );
});

test('plan 2485: the verdict CARRIES its own bound + progress age, and applyDemote reports those (review [6])', () => {
  const q = [liveHead('hog', 100, { state: IN_LAND_STATE }), entry('w', '🟩')];
  const v = demoteVerdict({ entries: q, demoter: 'w', nowMs: NOW_MS });
  assert.equal(v.ok, true);
  assert.equal(v.staleAxis, CONVERGE_AXIS);
  assert.equal(v.convergeBound, IN_LAND_CONVERGE_STALE_MIN, 'the bound the gate judged against');
  assert.equal(v.convergeProgressMin, 100, 'the progress age the gate measured');
  // convergenceInfo is the one computation behind all of it — the verdict simply carries it.
  const info = convergenceInfo(q[0], NOW_MS);
  assert.deepEqual(
    { stale: info.stale, bound: info.bound, progressMin: info.progressMin },
    { stale: true, bound: IN_LAND_CONVERGE_STALE_MIN, progressMin: 100 },
  );
  assert.equal(info.reason, v.staleReason, 'the gate reports convergenceInfo’s own reason');
  // A stale-heartbeat demote is the other axis, and carries no convergence numbers.
  const hb = demoteVerdict({
    entries: [
      entry('hog', '🟥', { heartbeatIso: minsAgo(99), progressIso: minsAgo(1) }),
      entry('w', '🟩'),
    ],
    demoter: 'w',
    nowMs: NOW_MS,
  });
  assert.equal(hb.ok, true);
  assert.equal(hb.staleAxis, HEARTBEAT_AXIS);
  assert.equal(hb.convergeBound, undefined, 'no convergence numbers on a liveness-axis verdict');
  // applyDemote must echo the verdict's numbers rather than re-measuring against a later
  // clock — pass a nowIso 9 minutes after the verdict's nowMs and the line must still say 100m.
  const later = new Date(NOW_MS + 9 * 60_000).toISOString();
  const r = applyDemote(q, 'w', later, v.ageMin, DEFAULT_DEMOTE_STALE_MIN, {
    staleAxis: CONVERGE_AXIS,
    convergeBound: v.convergeBound,
    convergeProgressMin: v.convergeProgressMin,
  });
  assert.match(r.auditLine, /no land progress 100m > 90m/);
  assert.equal(
    /109m/.test(r.auditLine),
    false,
    'the audit line must not drift to a re-measured age',
  );
});

test('plan 2485: the starvation cap and the self-demote refusal still bind a convergence demote', () => {
  const q = [liveHead('hog', 999), entry('w', '🟩')];
  const priorLines = Array.from(
    { length: DEMOTE_CAP },
    (_, i) =>
      `- ${minsAgo(60 + i)} — auto-demote: hog → tail (no land progress 90m > 45m, alive but not converging) by w`,
  );
  const capped = demoteVerdict({
    entries: q,
    auditLines: priorLines,
    demoter: 'w',
    nowMs: NOW_MS,
  });
  assert.equal(capped.ok, false, 'a convergence demote is capped like any other');
  assert.match(capped.reason, /starvation cap/);
  // …which also proves the convergence audit line is COUNTABLE by demoteAuditCount.
  assert.equal(demoteAuditCount(priorLines, 'hog', NOW_MS), DEMOTE_CAP);
  // Self-demote: same session on both entries.
  const same = [liveHead('hog', 999, { session: 'one' }), entry('w', '🟩', { session: 'one' })];
  const self = demoteVerdict({ entries: same, demoter: 'w', nowMs: NOW_MS });
  assert.equal(self.ok, false);
  assert.match(self.reason, /same session/);
});

test('plan 2485: applyDemote writes a paren-free, cap-countable, grammar-parseable convergence line', () => {
  const q = [liveHead('hog', 60), entry('w', '🟩'), entry('x', '🟩')];
  const r = applyDemote(q, 'w', NOW_ISO, 1, DEFAULT_DEMOTE_STALE_MIN, { staleAxis: CONVERGE_AXIS });
  assert.deepEqual(
    r.entries.map((e) => e.slug),
    ['w', 'x', 'hog'],
    'convergence demote MOVES to tail like any demote — never removes',
  );
  assert.match(r.auditLine, /no land progress 60m > 45m, alive but not converging/);
  assert.equal(
    r.auditLine.includes('(plan 2485)'),
    false,
    'the detail must stay paren-free — RX_AUDIT_DEMOTE captures it as [^)]*',
  );
  const parsed = parseAuditLine(r.auditLine);
  assert.equal(parsed.verb, 'demote');
  assert.equal(parsed.slug, 'hog', 'slug binds the DEMOTED head, not the actor');
  assert.equal(parsed.actor, 'w');
  assert.equal(
    demoteAuditCount([r.auditLine], 'hog', NOW_MS),
    1,
    'the starvation cap counts the convergence line',
  );
  // An IN_LAND victim's line names the WIDER bound it was actually judged against.
  const inLand = [liveHead('hog', 100, { state: IN_LAND_STATE }), entry('w', '🟩')];
  const r2 = applyDemote(inLand, 'w', NOW_ISO, 1, DEFAULT_DEMOTE_STALE_MIN, {
    staleAxis: CONVERGE_AXIS,
  });
  assert.match(r2.auditLine, /100m > 90m/);
  // The heartbeat axis keeps its pre-2485 wording byte-for-byte (default staleAxis).
  assert.match(
    applyDemote(q, 'w', NOW_ISO, 20, 15).auditLine,
    /auto-demote: hog → tail \(heartbeat age 20m > 15m, not landing\) by w/,
  );
});

test('plan 2485: heartbeatEntry only stamps progress when asked — a liveness tick never resets the clock', () => {
  const old = minsAgo(90);
  const q = [entry('hog', '🟥', { progressIso: old })];
  const liveness = heartbeatEntry(q, 'hog', NOW_ISO);
  assert.equal(liveness[0].heartbeatIso, NOW_ISO, 'liveness always refreshes');
  assert.equal(
    liveness[0].progressIso,
    old,
    'a watcher tick / self-arm / pre-convergence round must NOT reset the convergence clock',
  );
  const progress = heartbeatEntry(q, 'hog', NOW_ISO, undefined, true);
  assert.equal(progress[0].progressIso, NOW_ISO, 'a completed spine step does reset it');
  // pid and progress compose (the head-acquisition call passes both).
  const both = heartbeatEntry(q, 'hog', NOW_ISO, '77', true);
  assert.equal(both[0].pid, '77');
  assert.equal(both[0].progressIso, NOW_ISO);
});

test('plan 2485: requeueEntry clears progressIso — a fresh residency inherits no progress credit', () => {
  const q = [
    entry('hog', '🟩', { progressIso: minsAgo(5), state: IN_LAND_STATE }),
    entry('w', '🟩'),
  ];
  const rq = requeueEntry(q, 'hog', T1);
  assert.equal(rq.entry.progressIso, null, 'no credit, and no instant-demotability, at the tail');
});

test('plan 2485: the progress column round-trips and a pre-2485 10-column row still parses', () => {
  const doc = renderQueue(
    initialQueueDoc(),
    [entry('a', '🟥', { progressIso: NOW_ISO }), entry('b', '🟩')],
    [],
  );
  const back = parseQueue(doc).entries;
  assert.equal(back[0].progressIso, NOW_ISO);
  assert.equal(back[1].progressIso, null, 'an unstamped entry renders blank and parses to null');
  // A row written by a pre-2485 session: ten cells, no progress column at all.
  const tenCol = [
    QUEUE_START,
    '| slug | lane | session | host | enqueued | heartbeat | pid | state | reap-armed | priority |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    `| old | 🟥 | s | h | ${T0} | ${T0} |  |  |  |  |`,
    QUEUE_END,
    AUDIT_START,
    AUDIT_END,
  ].join('\n');
  const legacyEntries = parseQueue(tenCol).entries;
  assert.equal(legacyEntries.length, 1);
  assert.equal(legacyEntries[0].progressIso, null, 'pre-2485 row → null → axis abstains');
});

test('plan 2485: demoteLocallyEligible agrees with demoteVerdict on the convergence axis', () => {
  // The waiter-side pre-check is what decides whether the CLI is spawned AT ALL, so a
  // liveness-only pre-check would filter out the exact class the gate was just taught to
  // catch. Checked at the boundary, both sides, plus the state abstentions.
  const cases = [
    { progressMinAgo: DEFAULT_CONVERGE_STALE_MIN, headState: null, expect: false },
    { progressMinAgo: DEFAULT_CONVERGE_STALE_MIN + 1, headState: null, expect: true },
    { progressMinAgo: 999, headState: HOLDING_STATE, expect: false },
    { progressMinAgo: IN_LAND_CONVERGE_STALE_MIN, headState: IN_LAND_STATE, expect: false },
    { progressMinAgo: IN_LAND_CONVERGE_STALE_MIN + 1, headState: IN_LAND_STATE, expect: true },
    { progressMinAgo: null, headState: null, expect: false },
  ];
  for (const c of cases) {
    const head = liveHead('hog', c.progressMinAgo, { state: c.headState });
    const local = demoteLocallyEligible({
      headHeartbeatIso: head.heartbeatIso,
      headState: head.state,
      headProgressIso: head.progressIso,
      nowMs: NOW_MS,
    });
    assert.equal(local, c.expect, `local pre-check for ${JSON.stringify(c)}`);
    // HOLDING is the one row where the pre-check and the verdict legitimately differ in
    // OUTCOME but not in spawn-safety: both refuse, so agreement holds on ok-ness.
    const verdict = demoteVerdict({
      entries: [head, entry('w', '🟩')],
      demoter: 'w',
      nowMs: NOW_MS,
    });
    assert.equal(
      verdict.ok,
      c.expect,
      `real verdict must match the pre-check for ${JSON.stringify(c)}`,
    );
  }
  // A pre-2485 payload (neither field present) degrades to the heartbeat answer.
  assert.equal(
    demoteLocallyEligible({ headHeartbeatIso: minsAgo(1), nowMs: NOW_MS }),
    false,
    'fresh heartbeat + no progress field → no spawn, exactly as before this plan',
  );
  assert.equal(
    demoteLocallyEligible({ headHeartbeatIso: minsAgo(999), nowMs: NOW_MS }),
    true,
    'the heartbeat axis still stands on its own',
  );
});

test('plan 2414: requeueEntry clears IN_LAND on a demote/requeue — no stale token survives a move', () => {
  const q = [entry('hog', '🟩', { state: IN_LAND_STATE }), entry('w', '🟩')];
  const rq = requeueEntry(q, 'hog', T1);
  assert.equal(rq.entry.state, null, 'a moved entry is by definition no longer at head');
});

test('plan 1682: applyDemote moves the head to the TAIL (never removes) with a cap-countable audit line', () => {
  const nowIso = '2026-06-10T08:20:00.000Z';
  const q = [entry('hog'), entry('w', '🟩'), entry('x', '🟩')];
  const r = applyDemote(q, 'w', nowIso, 20, 15);
  assert.deepEqual(
    r.entries.map((e) => e.slug),
    ['w', 'x', 'hog'],
    'moved, not removed — total unchanged',
  );
  assert.equal(r.entries[2].enqueuedIso, nowIso, 'fresh tail residency — no queue-age credit kept');
  assert.match(
    r.auditLine,
    /auto-demote: hog → tail \(heartbeat age 20m > 15m, not landing\) by w/,
  );
  assert.equal(
    demoteAuditCount([r.auditLine], 'hog', Date.parse(nowIso)),
    1,
    'the written line is exactly what the starvation cap counts',
  );
  // unparseable heartbeat renders the steal-style age note, still cap-countable
  const r2 = applyDemote(q, 'w', nowIso, null, 15);
  assert.match(r2.auditLine, /unparseable heartbeat/);
  assert.equal(demoteAuditCount([r2.auditLine], 'hog', Date.parse(nowIso)), 1);
});

test('plan 1682: slugHoldsLandingRow — own-row, column-exact; unparseable board is false', () => {
  assert.equal(slugHoldsLandingRow(boardWith([row('1682-x', '🟢 LANDING')]), '1682-x'), true);
  assert.equal(slugHoldsLandingRow(boardWith([row('1682-x', '🔵 ACTIVE')]), '1682-x'), false);
  assert.equal(slugHoldsLandingRow(boardWith([row('1500-other', '🟢 LANDING')]), '1682-x'), false);
  // "🟢 LANDING" in another row's RESUME prose never false-matches (plan-230 guard)
  const prose = boardWith([
    `| 1682-x | abc123 | 🔵 ACTIVE | plan | 2026-07-06 | QUEUED behind Y's 🟢 LANDING mutex |`,
  ]);
  assert.equal(slugHoldsLandingRow(prose, '1682-x'), false);
  assert.equal(slugHoldsLandingRow('not a board at all', '1682-x'), false);
});

test('plan 1682 delta: duplicate-slug board rows — LANDING on ANY row counts (fail-safe), not only the first', () => {
  // crash/hand-edit debris can leave two rows for one slug; if the live 🟢 LANDING row
  // sorts second, a first-row-only lookup (board-lib landingInfo) would read
  // "not landing" and let a demote move a mid-land head. The gate scans every row.
  const dup = boardWith([row('1682-x', '🔵 ACTIVE'), row('1682-x', '🟢 LANDING')]);
  assert.equal(slugHoldsLandingRow(dup, '1682-x'), true);
});

// ── plan 2266: mechanicalHolderGoneVerdict — the mechanical steal's decision core ──
// The heartbeat-staleness gate (stealVerdict) already ran BEFORE this in every real call
// site, so these cases only ever cover a head already proven heartbeat-stale; this
// function's own job is solely the {host, pid} evidence layer on top of that.
const headWith = (over = {}) => ({ slug: 'dead-head', host: 'PC-A', pid: '4242', ...over });

test('plan 2266: stale + same-host + dead pid → mechanically taken', () => {
  const v = mechanicalHolderGoneVerdict({
    head: headWith(),
    probingHost: 'PC-A',
    pidRunning: false,
  });
  assert.equal(v.mechanical, true);
  assert.match(v.reason, /4242/);
  assert.match(v.reason, /not running/);
});

test('plan 2266: stale + same-host + LIVE pid → refused (holder not gone)', () => {
  const v = mechanicalHolderGoneVerdict({
    head: headWith(),
    probingHost: 'PC-A',
    pidRunning: true,
  });
  assert.equal(v.mechanical, false);
  assert.match(v.reason, /still running/);
});

test('plan 2266: stale + CROSS-host → refused regardless of pidRunning (a foreign pid can never be probed)', () => {
  for (const pidRunning of [true, false]) {
    const v = mechanicalHolderGoneVerdict({
      head: headWith({ host: 'PC-B' }),
      probingHost: 'PC-A',
      pidRunning,
    });
    assert.equal(v.mechanical, false, `pidRunning=${pidRunning}`);
    assert.match(v.reason, /differs/);
  }
});

test('plan 2266: no recorded pid (pre-2266 / unstamped entry) → refused, falls back to manual confirm', () => {
  for (const pid of [null, '', undefined]) {
    const v = mechanicalHolderGoneVerdict({
      head: headWith({ pid }),
      probingHost: 'PC-A',
      pidRunning: false,
    });
    assert.equal(v.mechanical, false, `pid=${JSON.stringify(pid)}`);
    assert.match(v.reason, /no recorded pid/);
  }
});

test('plan 2266: a non-numeric / zero pid is treated as no evidence, not a crash', () => {
  for (const pid of ['0', '-5', 'not-a-pid']) {
    const v = mechanicalHolderGoneVerdict({
      head: headWith({ pid }),
      probingHost: 'PC-A',
      pidRunning: false,
    });
    assert.equal(v.mechanical, false, `pid=${pid}`);
  }
});

// ── plan 2280: stealLocallyEligible — the waiter-side spawn precheck ──
// Mirrors mechanicalHolderGoneVerdict's two GUARANTEED-refusal preconditions (cross-host,
// no pid) so a caller holding only a slug-scoped status payload (no head object, no
// pidRunning probe) can decide LOCALLY whether spawning `landing-queue.mjs steal` is worth
// the fetch — never re-derives the third condition (pid liveness), which only the real CLI
// can probe.
test('plan 2280: stealLocallyEligible — same host + recorded pid → eligible (spawn it)', () => {
  assert.equal(
    stealLocallyEligible({ headHost: 'PC-A', headPid: '4242', probingHost: 'PC-A' }),
    true,
  );
});

test('plan 2280: stealLocallyEligible — cross-host head → ineligible regardless of pid', () => {
  assert.equal(
    stealLocallyEligible({ headHost: 'PC-B', headPid: '4242', probingHost: 'PC-A' }),
    false,
  );
});

test('plan 2280: stealLocallyEligible — no recorded pid → ineligible even on the same host', () => {
  for (const headPid of [null, '', undefined]) {
    assert.equal(
      stealLocallyEligible({ headHost: 'PC-A', headPid, probingHost: 'PC-A' }),
      false,
      `headPid=${JSON.stringify(headPid)}`,
    );
  }
});

test('plan 2280: stealLocallyEligible — no head at all (empty queue) → ineligible, never throws', () => {
  assert.equal(stealLocallyEligible({ headHost: null, headPid: null, probingHost: 'PC-A' }), false);
});

test('plan 2280 review fix: stealLocallyEligible — a malformed pid ("0"/"-1"/non-numeric) is ineligible, matching mechanicalHolderGoneVerdict\'s own no-recorded-pid refusal (not a bare Boolean() check)', () => {
  for (const headPid of ['0', '-5', 'not-a-pid']) {
    assert.equal(
      stealLocallyEligible({ headHost: 'PC-A', headPid, probingHost: 'PC-A' }),
      false,
      `headPid=${headPid}`,
    );
  }
});

// ── plan 2266: pid column — schema round-trip + heartbeatEntry's optional stamp ──
test('plan 2266: heartbeatEntry stamps pid only when explicitly passed; other heartbeats never blank it', () => {
  const q = [entry('alpha', '🟥', { pid: '111' })];
  // a plain liveness heartbeat (no pid arg) must leave the previously-stamped pid alone
  const bumped = heartbeatEntry(q, 'alpha', T1);
  assert.equal(bumped[0].pid, '111', 'pid survives an ordinary heartbeat');
  assert.equal(bumped[0].heartbeatIso, T1);
  // an explicit pid arg (head-acquisition) overwrites it
  const restamped = heartbeatEntry(q, 'alpha', T1, '222');
  assert.equal(restamped[0].pid, '222');
});

test('plan 2266: render → parse round-trips a stamped pid (trailing column, backward-positioned)', () => {
  const entries = [entry('alpha', '🟥', { pid: '999' }), entry('beta', '🟩')];
  const doc = renderQueue(initialQueueDoc(), entries, []);
  const parsed = parseQueue(doc);
  assert.deepEqual(parsed.entries, entries);
  assert.equal(parsed.entries[0].pid, '999');
  assert.equal(
    parsed.entries[1].pid,
    null,
    'an entry never heartbeat-stamped with a pid parses back to null',
  );
});

test('plan 2266: a pre-2266 6-column row (no pid cell at all) parses with pid null — old docs stay readable', () => {
  const legacyRow = '| old-slug | 🟥 | 431 | H1 | ' + T0 + ' | ' + T0 + ' |';
  const doc = [
    '<!-- QUEUE-START -->',
    '| slug | lane | session | host | enqueued | heartbeat |',
    '| --- | --- | --- | --- | --- | --- |',
    legacyRow,
    '<!-- QUEUE-END -->',
    '<!-- AUDIT-START -->',
    '<!-- AUDIT-END -->',
  ].join('\n');
  const { entries } = parseQueue(doc);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].slug, 'old-slug');
  assert.equal(entries[0].pid, null);
});

test('plan 2266: applySteal — an optional note annotates the audit line (MECHANICAL reap); omitted → unchanged text', () => {
  const q = [entry('dead-head'), entry('waiter', '🟩')];
  const plain = applySteal(q, 'waiter', T1, 60);
  assert.equal(
    plain.auditLine,
    `- ${T1} — waiter stole the head slot from dead-head (heartbeat stale 60m)`,
  );
  const mech = applySteal(q, 'waiter', T1, 60, 'MECHANICAL reap: pid verified not running');
  assert.equal(
    mech.auditLine,
    `- ${T1} — waiter stole the head slot from dead-head (heartbeat stale 60m) — MECHANICAL reap: pid verified not running`,
  );
});

// ── plan 2275: bounded overtake of a LAND_BLOCKED_HOLDING head ──────────────────

test('plan 2275: state column round-trips through render → parse; legacy 7-col row parses with state null', () => {
  const q = [entry('holder', '🟥', { state: HOLDING_STATE }), entry('waiter', '🟩')];
  const doc = renderQueue(initialQueueDoc(), q, []);
  const parsed = parseQueue(doc);
  assert.deepEqual(parsed.entries, q);
  // a plan-2266-era 7-column row (pid, no state) parses with state null
  const legacyRow = `| old-slug | 🟥 | 431 | H1 | ${T0} | ${T0} | 1234 |`;
  const legacyDoc = [
    '<!-- QUEUE-START -->',
    '| slug | lane | session | host | enqueued | heartbeat | pid |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    legacyRow,
    '<!-- QUEUE-END -->',
    '<!-- AUDIT-START -->',
    '<!-- AUDIT-END -->',
  ].join('\n');
  const { entries } = parseQueue(legacyDoc);
  assert.equal(entries[0].pid, '1234');
  assert.equal(entries[0].state, null);
});

test('plan 2275: setEntryState stamps ONLY the named slug and clears with null; absent slug no-op', () => {
  const q = [entry('holder'), entry('waiter', '🟩')];
  const on = setEntryState(q, 'holder', HOLDING_STATE);
  assert.equal(on[0].state, HOLDING_STATE);
  assert.equal(on[1].state, null, 'other entries untouched');
  const off = setEntryState(on, 'holder', null);
  assert.equal(off[0].state, null);
  assert.deepEqual(setEntryState(q, 'ghost', HOLDING_STATE), q);
});

test('plan 2275: overtakeVerdict refuses — empty queue, self, unqueued, non-🟩 lane, non-HOLDING head', () => {
  const nowMs = Date.parse(T1);
  assert.match(overtakeVerdict({ entries: [], overtaker: 'w', nowMs }).reason, /queue is empty/);
  const held = [
    entry('holder', '🟥', { state: HOLDING_STATE }),
    entry('w', '🟩'),
    entry('red', '🟥'),
  ];
  assert.match(
    overtakeVerdict({ entries: held, overtaker: 'holder', nowMs }).reason,
    /already head/,
  );
  assert.match(overtakeVerdict({ entries: held, overtaker: 'ghost', nowMs }).reason, /not queued/);
  assert.match(overtakeVerdict({ entries: held, overtaker: 'red', nowMs }).reason, /only a 🟩/);
  const active = [entry('holder', '🟥'), entry('w', '🟩')];
  const v = overtakeVerdict({ entries: active, overtaker: 'w', nowMs });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not parked at LAND_BLOCKED_HOLDING/);
});

test('plan 2275: overtakeVerdict passes for a 🟩 waiter behind a HOLDING head (any position, not just #2)', () => {
  const q = [entry('holder', '🟥', { state: HOLDING_STATE }), entry('red', '🟥'), entry('w', '🟩')];
  const v = overtakeVerdict({ entries: q, overtaker: 'w', nowMs: Date.parse(T1) });
  assert.equal(v.ok, true);
  assert.equal(v.head.slug, 'holder');
});

test('plan 2275: starvation cap — 2 audited overtakes inside the window refuse the third; slug-prefix lines never false-count; unparseable timestamp counts', () => {
  const q = [entry('holder', '🟥', { state: HOLDING_STATE }), entry('w', '🟩')];
  const nowMs = Date.parse(T1);
  const line = (iso, head) => `- ${iso} — overtake: x past HOLDING head ${head} → position 2`;
  // prefix slug "holder-2" lines must NOT count toward "holder"
  const audit1 = [line(T0, 'holder-2'), line(T0, 'holder-2')];
  assert.equal(overtakeAuditCount(audit1, 'holder', nowMs), 0);
  assert.equal(overtakeVerdict({ entries: q, auditLines: audit1, overtaker: 'w', nowMs }).ok, true);
  // cap reached
  const audit2 = [line(T0, 'holder'), line(T0, 'holder')];
  assert.equal(overtakeAuditCount(audit2, 'holder', nowMs), OVERTAKE_CAP);
  const v = overtakeVerdict({ entries: q, auditLines: audit2, overtaker: 'w', nowMs });
  assert.equal(v.ok, false);
  assert.match(v.reason, /starvation cap/);
  // outside the 24h window → not counted
  const old = '2026-06-01T00:00:00.000Z';
  assert.equal(overtakeAuditCount([line(old, 'holder'), line(old, 'holder')], 'holder', nowMs), 0);
  // unparseable timestamp is conservative: counts
  assert.equal(
    overtakeAuditCount(
      ['- garbage — overtake: x past HOLDING head holder → position 2'],
      'holder',
      nowMs,
    ),
    1,
  );
});

test('plan 2275: applyOvertake — overtaker → 1, holder → 2 (never tail), others keep relative order; audit line matches the cap matcher', () => {
  const q = [
    entry('holder', '🟥', { state: HOLDING_STATE }),
    entry('a', '🟥'),
    entry('w', '🟩'),
    entry('c', '🟩'),
  ];
  const r = applyOvertake(q, 'w', T1);
  assert.deepEqual(
    r.entries.map((e) => e.slug),
    ['w', 'holder', 'a', 'c'],
  );
  assert.equal(
    r.entries[1].state,
    HOLDING_STATE,
    'holder keeps its HOLDING stamp through the swap',
  );
  // the audit line this writes is exactly what overtakeAuditCount counts
  assert.equal(overtakeAuditCount([r.auditLine], 'holder', Date.parse(T1)), 1);
});

// ── plan 2331: reapVerdict — arm-then-fire auto-reap of a dead, NOT-landing head ───
// A pure twin of demoteVerdict/stealVerdict: the CLI layers the fresh board 🟢
// LANDING gate on top (see landing-queue.test.mjs for the CLI-level coverage).
// Default thresholds: 45m stale, 10m grace.

const RT0 = '2026-07-24T00:00:00.000Z';
const RT_FRESH = '2026-07-24T00:10:00.000Z'; // 10m — under the 45m default
const RT_STALE = '2026-07-24T00:50:00.000Z'; // 50m — over it, eligible to ARM
const RT_ARMED_5M = '2026-07-24T00:55:00.000Z'; // 5m after arming — grace (10m) not yet elapsed
const RT_ARMED_10M = '2026-07-24T01:00:00.000Z'; // exactly 10m after arming — grace elapsed
const RT_ARMED_15M = '2026-07-24T01:05:00.000Z'; // comfortably past grace

test('plan 2331: reapVerdict refuses an empty queue, a head waiter, and an unqueued waiter', () => {
  assert.match(
    reapVerdict({ entries: [], waiter: 'w', nowMs: Date.parse(RT_STALE) }).reason,
    /empty/i,
  );
  const q = [entry('hog', '🟥', { heartbeatIso: RT0 }), entry('w', '🟩')];
  assert.match(
    reapVerdict({ entries: q, waiter: 'hog', nowMs: Date.parse(RT_STALE) }).reason,
    /already head/i,
  );
  assert.match(
    reapVerdict({ entries: q, waiter: 'ghost', nowMs: Date.parse(RT_STALE) }).reason,
    /not queued behind/i,
  );
});

test('plan 2331: a fresh head is refused outright — never even reaches the arm/grace logic', () => {
  const q = [entry('hog', '🟥', { heartbeatIso: RT0 }), entry('w', '🟩')];
  const v = reapVerdict({ entries: q, waiter: 'w', nowMs: Date.parse(RT_FRESH) });
  assert.equal(v.ok, false);
  assert.equal(v.armed, undefined);
  assert.match(v.reason, /fresh/i);
});

test('plan 2331: a HOLDING head is never reap-eligible however stale — overtake is the recourse, not reap', () => {
  const q = [entry('holder', '🟥', { heartbeatIso: RT0, state: HOLDING_STATE }), entry('w', '🟩')];
  const v = reapVerdict({ entries: q, waiter: 'w', nowMs: Date.parse(RT_ARMED_15M) });
  assert.equal(v.ok, false);
  assert.equal(v.armed, undefined, 'HOLDING refuses before ever reaching arm/grace');
  assert.match(v.reason, /LAND_BLOCKED_HOLDING/);
  assert.match(v.reason, /overtake/);
});

// ── plan 2414 review fix: reapVerdict needed the SAME IN_LAND + self-session closes as
// demoteVerdict — reap is a more destructive verb (full removal, not move-to-tail), so
// the free-lane liveness hole and the self-eviction hole were at least as open here.

test('plan 2414: an IN_LAND head is never reap-eligible however stale — demote/steal are the recourse, not reap', () => {
  const q = [
    entry('busy-head', '🟩', { heartbeatIso: RT0, state: IN_LAND_STATE }),
    entry('w', '🟩'),
  ];
  const v = reapVerdict({ entries: q, waiter: 'w', nowMs: Date.parse(RT_ARMED_15M) });
  assert.equal(v.ok, false);
  assert.equal(v.armed, undefined, 'IN_LAND refuses before ever reaching arm/grace');
  assert.match(v.reason, /IN_LAND/);
  assert.match(v.reason, /demote/);
  assert.match(v.reason, /steal/);
  // unlike demote, this refusal is UNCONDITIONAL — no pid-liveness argument can override it
  assert.equal(
    reapLocallyEligible({
      headState: IN_LAND_STATE,
      headHeartbeatIso: RT0,
      nowMs: Date.parse(RT_ARMED_15M),
    }),
    false,
    'the local spawn-avoidance pre-check agrees, so a waiter never even spawns the CLI for an IN_LAND head',
  );
});

test('plan 2414: same-session waiter is refused from reaping its own other queued land', () => {
  const q = [
    entry('my-other-land', '🟥', { heartbeatIso: RT0, session: 'sess-9' }),
    entry('w', '🟩', { session: 'sess-9' }),
  ];
  const v = reapVerdict({ entries: q, waiter: 'w', nowMs: Date.parse(RT_ARMED_15M) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /same session/i);
  assert.match(v.reason, /sess-9/);
});

test('plan 2331: arm-then-fire — first eligible verdict ARMS (never fires); a re-verdict before grace still refuses; at/after grace it fires', () => {
  const q = [entry('hog', '🟥', { heartbeatIso: RT0 }), entry('w', '🟩')];
  // pass 1: stale, not yet armed → armed:true, ok:false (the CLI stamps the arm on this verdict)
  const armPass = reapVerdict({ entries: q, waiter: 'w', nowMs: Date.parse(RT_STALE) });
  assert.equal(armPass.ok, false);
  assert.equal(armPass.armed, true);
  assert.equal(armPass.head.slug, 'hog');
  assert.match(armPass.reason, /ARMED/);
  const armed = armReapEntry(q, 'hog', RT_STALE);
  assert.equal(armed[0].reapArmedIso, RT_STALE);
  assert.equal(armed[1].reapArmedIso, null, 'armReapEntry only touches the named slug');
  // pass 2: armed 5m ago, grace (10m) not yet elapsed → still refused
  const gracePending = reapVerdict({
    entries: armed,
    waiter: 'w',
    nowMs: Date.parse(RT_ARMED_5M),
  });
  assert.equal(gracePending.ok, false);
  assert.equal(gracePending.armed, true);
  assert.match(gracePending.reason, /grace/i);
  assert.match(gracePending.reason, /not yet elapsed/i);
  // pass 3: armed exactly 10m ago (grace elapsed) → fires
  const fires = reapVerdict({ entries: armed, waiter: 'w', nowMs: Date.parse(RT_ARMED_10M) });
  assert.equal(fires.ok, true);
  assert.equal(fires.head.slug, 'hog');
  assert.equal(fires.armAgeMin, 10);
});

test('plan 2331: any waiter position (not only second-in-line) may reap, mirroring demote', () => {
  const q = [
    entry('hog', '🟥', { heartbeatIso: RT0, reapArmedIso: RT_STALE }),
    entry('w1', '🟩'),
    entry('w2', '🟩'),
  ];
  const v = reapVerdict({ entries: q, waiter: 'w2', nowMs: Date.parse(RT_ARMED_15M) });
  assert.equal(v.ok, true, 'position 3 may reap — any harmed waiter, not only second-in-line');
});

test('plan 2331: heartbeatEntry, requeueEntry, and setEntryState all clear a stale arm', () => {
  const armed = () => entry('hog', '🟥', { heartbeatIso: RT0, reapArmedIso: RT_STALE });
  const beat = heartbeatEntry([armed(), entry('w', '🟩')], 'hog', RT_ARMED_5M);
  assert.equal(beat[0].reapArmedIso, null, 'a heartbeat clears the arm');
  const rq = requeueEntry([armed(), entry('w', '🟩')], 'hog', RT_ARMED_5M);
  assert.equal(rq.entries.find((e) => e.slug === 'hog').reapArmedIso, null, 'a requeue clears it');
  const st = setEntryState([armed(), entry('w', '🟩')], 'hog', HOLDING_STATE);
  assert.equal(
    st.find((e) => e.slug === 'hog').reapArmedIso,
    null,
    'a state transition clears it too (belt-and-suspenders alongside the HOLDING gate)',
  );
});

test('plan 2331: applyReap removes the head (never moves it) and writes an audit line naming waiter, victim, ages', () => {
  const q = [
    entry('hog', '🟥', { heartbeatIso: RT0, reapArmedIso: RT_STALE }),
    entry('w', '🟩'),
    entry('x', '🟩'),
  ];
  const r = applyReap(q, 'w', RT_ARMED_10M, 50, 10);
  assert.deepEqual(
    r.entries.map((e) => e.slug),
    ['w', 'x'],
    'the head is removed, total shrinks by one',
  );
  assert.match(r.auditLine, /reap: hog removed by w/);
  assert.match(r.auditLine, /50m stale/);
  assert.match(r.auditLine, /armed 10m ago/);
});

test('plan 2331: reapArmedIso round-trips through render → parse; a pre-2331 8-column row (no reap-armed cell) parses with reapArmedIso null', () => {
  const q = [entry('alpha', '🟥', { reapArmedIso: RT_STALE }), entry('beta', '🟩')];
  const doc = renderQueue(initialQueueDoc(), q, []);
  const parsed = parseQueue(doc);
  assert.deepEqual(parsed.entries, q);
  // a plan-2275-era 8-column row (state, no reap-armed) parses with reapArmedIso null
  const legacyRow = `| old-slug | 🟥 | 431 | H1 | ${T0} | ${T0} | 1234 | HOLDING |`;
  const legacyDoc = [
    '<!-- QUEUE-START -->',
    '| slug | lane | session | host | enqueued | heartbeat | pid | state |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    legacyRow,
    '<!-- QUEUE-END -->',
    '<!-- AUDIT-START -->',
    '<!-- AUDIT-END -->',
  ].join('\n');
  const { entries } = parseQueue(legacyDoc);
  assert.equal(entries[0].pid, '1234');
  assert.equal(entries[0].state, HOLDING_STATE);
  assert.equal(entries[0].reapArmedIso, null);
});

test('plan 2331: DEFAULT_REAP_STALE_MIN / DEFAULT_REAP_GRACE_MIN match the plan-pinned values (45m / 10m)', () => {
  assert.equal(DEFAULT_REAP_STALE_MIN, 45);
  assert.equal(DEFAULT_REAP_GRACE_MIN, 10);
});

test('plan 2331 review fix: an UNPARSEABLE reapArmedIso fails OPEN (fires) instead of wedging forever', () => {
  const q = [
    entry('hog', '🟥', { heartbeatIso: RT0, reapArmedIso: 'not-a-real-timestamp' }),
    entry('w', '🟩'),
  ];
  // any nowMs, arbitrarily far past the arm — a corrupt stamp must never require waiting
  // out a grace it can't be measured against (mirrors headDisplacementVerdict treating an
  // unparseable HEARTBEAT as stale/eligible, never as "healthy").
  const v = reapVerdict({ entries: q, waiter: 'w', nowMs: Date.parse(RT_ARMED_15M) });
  assert.equal(v.ok, true, 'a corrupt arm timestamp must fail OPEN, not wedge the head forever');
  assert.equal(v.armAgeMin, null);
});

// ── plan 2334: the demote/reap LOCAL pre-checks (heartbeat-age twins of ────────────
// stealLocallyEligible). Contract: they mirror ONLY the payload-knowable refusals of
// demoteVerdict/reapVerdict, and every unknown must fail OPEN (spawn the CLI) so a
// missing input can never silently skip a spawn the waiter must make.

test("plan 2334: headHeartbeatLocallyFresh mirrors headDisplacementVerdict's age gate at the boundary", () => {
  const nowMs = Date.parse(RT_STALE); // 50m after RT0
  // 50m > 45m → not fresh; and the boundary itself (age === staleMin) reads FRESH, exactly
  // as headDisplacementVerdict's `ageMin <= staleMin` refusal does.
  assert.equal(headHeartbeatLocallyFresh({ headHeartbeatIso: RT0, nowMs, staleMin: 45 }), false);
  assert.equal(headHeartbeatLocallyFresh({ headHeartbeatIso: RT0, nowMs, staleMin: 50 }), true);
  assert.equal(headHeartbeatLocallyFresh({ headHeartbeatIso: RT0, nowMs, staleMin: 51 }), true);
});

test('plan 2334: an absent / unparseable heartbeat is never "fresh" — a pre-2334 payload spawns', () => {
  const nowMs = Date.parse(RT_FRESH);
  for (const iso of [undefined, null, '', 'garbage']) {
    assert.equal(
      headHeartbeatLocallyFresh({ headHeartbeatIso: iso, nowMs, staleMin: 45 }),
      false,
      `${JSON.stringify(iso)} must not read as fresh`,
    );
    assert.equal(demoteLocallyEligible({ headHeartbeatIso: iso, nowMs }), true);
    assert.equal(reapLocallyEligible({ headState: null, headHeartbeatIso: iso, nowMs }), true);
  }
});

test('plan 2334: demoteLocallyEligible agrees with demoteVerdict on the fresh/stale split (15m default)', () => {
  const q = (heartbeatIso) => [entry('hog', '🟥', { heartbeatIso }), entry('w', '🟩')];
  // 10m after T0 — under the 15m demote threshold: the CLI would refuse, so skip the spawn
  assert.equal(demoteVerdict({ entries: q(T0), demoter: 'w', nowMs: T_FRESH_MS }).ok, false);
  assert.equal(demoteLocallyEligible({ headHeartbeatIso: T0, nowMs: T_FRESH_MS }), false);
  // 20m after T0 — over it: the CLI may act, so the waiter must spawn
  assert.equal(demoteVerdict({ entries: q(T0), demoter: 'w', nowMs: T_STALE_MS }).ok, true);
  assert.equal(demoteLocallyEligible({ headHeartbeatIso: T0, nowMs: T_STALE_MS }), true);
  // the threshold comes from the shared constant, never a hand-copied 15
  assert.equal(
    demoteLocallyEligible({
      headHeartbeatIso: T0,
      nowMs: T_STALE_MS,
      staleMin: DEFAULT_DEMOTE_STALE_MIN + 10,
    }),
    false,
  );
});

test('plan 2334: reapLocallyEligible skips a HOLDING head and a fresh head, spawns for a stale one', () => {
  const nowStale = Date.parse(RT_STALE);
  // HOLDING — reapVerdict refuses it however stale (overtake is that head's recourse)
  const holding = [
    entry('holder', '🟥', { heartbeatIso: RT0, state: HOLDING_STATE }),
    entry('w', '🟩'),
  ];
  assert.equal(reapVerdict({ entries: holding, waiter: 'w', nowMs: nowStale }).ok, false);
  assert.equal(
    reapLocallyEligible({ headState: HOLDING_STATE, headHeartbeatIso: RT0, nowMs: nowStale }),
    false,
  );
  // fresh heartbeat — refused outright by reapVerdict, so no spawn is worth paying for
  assert.equal(
    reapLocallyEligible({
      headState: null,
      headHeartbeatIso: RT0,
      nowMs: Date.parse(RT_FRESH),
    }),
    false,
  );
  // stale + not HOLDING — the CLI must run (only IT can arm / measure the grace)
  assert.equal(
    reapLocallyEligible({ headState: null, headHeartbeatIso: RT0, nowMs: nowStale }),
    true,
  );
});

test('plan 2334: an ARMED-but-within-grace head still spawns — the grace is not payload-knowable', () => {
  // reapVerdict refuses here (armed 5m ago, 10m grace), but `reapArmedIso` is NOT in the
  // status payload, so the local pre-check must fail OPEN rather than skip the spawn and
  // starve the arm-then-fire ladder.
  const armed = [
    entry('hog', '🟥', { heartbeatIso: RT0, reapArmedIso: RT_STALE }),
    entry('w', '🟩'),
  ];
  const v = reapVerdict({ entries: armed, waiter: 'w', nowMs: Date.parse(RT_ARMED_5M) });
  assert.equal(v.ok, false);
  assert.equal(
    reapLocallyEligible({
      headState: null,
      headHeartbeatIso: RT0,
      nowMs: Date.parse(RT_ARMED_5M),
    }),
    true,
    'the waiter cannot see reapArmedIso — it must spawn and let the CLI refuse',
  );
});

test('plan 2334 review [2]: ageIsFresh is the ONE comparison — headDisplacementVerdict and the local pre-check agree at the boundary', () => {
  // the shared predicate's own contract: null (unparseable/absent) is never fresh
  assert.equal(ageIsFresh(null, 45), false);
  assert.equal(ageIsFresh(45, 45), true, 'the boundary minute reads FRESH (<=)');
  assert.equal(ageIsFresh(46, 45), false);
  // and the real gate routes through it — a head exactly AT the threshold is refused by
  // demoteVerdict and correspondingly reported "not locally eligible" by the pre-check
  const atBoundary = Date.parse(T0) + DEFAULT_DEMOTE_STALE_MIN * 60_000;
  const q = [entry('hog'), entry('w', '🟩')];
  const v = demoteVerdict({ entries: q, demoter: 'w', nowMs: atBoundary });
  assert.equal(v.ok, false);
  assert.match(v.reason, /fresh/i);
  assert.equal(demoteLocallyEligible({ headHeartbeatIso: T0, nowMs: atBoundary }), false);
  // one minute past it, both flip together
  const past = atBoundary + 60_000;
  assert.equal(demoteVerdict({ entries: q, demoter: 'w', nowMs: past }).ok, true);
  assert.equal(demoteLocallyEligible({ headHeartbeatIso: T0, nowMs: past }), true);
});

test('plan 2334 review [1]: overtakeLocallyEligible needs a 🟩 waiter AND a HOLDING head — the inverse of reap', () => {
  assert.equal(overtakeLocallyEligible({ lane: 'free', headState: HOLDING_STATE }), true);
  assert.equal(overtakeLocallyEligible({ lane: 'seed', headState: HOLDING_STATE }), false);
  assert.equal(overtakeLocallyEligible({ lane: 'free', headState: null }), false);
  // the invariant the two predicates jointly guarantee: never both eligible on one head
  const nowMs = Date.parse(RT_STALE);
  for (const headState of [HOLDING_STATE, null]) {
    const both =
      overtakeLocallyEligible({ lane: 'free', headState }) &&
      reapLocallyEligible({ headState, headHeartbeatIso: RT0, nowMs });
    assert.equal(both, false, `overtake and reap must never both fire (headState=${headState})`);
  }
});

// ── plan 2482: single-owner audit-line grammar — round-trip tests ─────────────────
// One test per verb: call the REAL writer (the applyX function, or the new
// requeueAuditLine/reenterAuditLine builders that replaced landing-queue.mjs's two
// former inline templates), feed its audit line through parseAuditLine, assert the
// fields — the guard that makes a future template wording change fail a test instead
// of silently zeroing an un-updated reader (the drift this plan fixes).

test('plan 2482: round-trip — demote', () => {
  const q = [entry('hog'), entry('w', '🟩')];
  const r = applyDemote(q, 'w', T1, 20, DEFAULT_DEMOTE_STALE_MIN);
  const parsed = parseAuditLine(r.auditLine);
  assert.deepEqual(parsed, {
    verb: 'demote',
    iso: T1,
    slug: 'hog', // the demoted head — never the demoter
    detail: 'heartbeat age 20m > 15m, not landing',
    actor: 'w',
  });
});

test('plan 2482: round-trip — steal', () => {
  const q = [entry('alpha'), entry('beta', '🟩')];
  const r = applySteal(q, 'beta', T1, 50);
  const parsed = parseAuditLine(r.auditLine);
  assert.deepEqual(parsed, {
    verb: 'steal',
    iso: T1,
    slug: 'alpha', // the victim — never the stealer
    actor: 'beta',
    detail: 'stale 50m',
    note: '',
  });
});

test('plan 2482: round-trip — overtake', () => {
  const q = [entry('holder', '🟥', { state: HOLDING_STATE }), entry('w', '🟩')];
  const r = applyOvertake(q, 'w', T1);
  const parsed = parseAuditLine(r.auditLine);
  assert.deepEqual(parsed, {
    verb: 'overtake',
    iso: T1,
    slug: 'holder', // the overtaken HOLDING head — never the overtaker
    actor: 'w',
  });
});

test('plan 2482: round-trip — reap', () => {
  const q = [entry('hog'), entry('w', '🟩')];
  const r = applyReap(q, 'w', T1, 50, 10);
  const parsed = parseAuditLine(r.auditLine);
  assert.deepEqual(parsed, {
    verb: 'reap',
    iso: T1,
    slug: 'hog', // the reaped head — never the waiter
    actor: 'w',
    detail: '50m stale, armed 10m ago',
  });
});

test('plan 2482: round-trip — requeue', () => {
  const line = requeueAuditLine(T1, 'my-slug', 'heavy head rework (plan 1528)');
  const parsed = parseAuditLine(line);
  assert.deepEqual(parsed, {
    verb: 'requeue',
    iso: T1,
    slug: 'my-slug',
    note: ' — heavy head rework (plan 1528)',
  });
  // an omitted note produces a line matching the pre-2482 unconditional-suffix behaviour
  const bare = requeueAuditLine(T1, 'my-slug');
  assert.equal(bare, `- ${T1} — my-slug requeued to tail`);
  assert.deepEqual(parseAuditLine(bare), { verb: 'requeue', iso: T1, slug: 'my-slug', note: '' });
});

test('plan 2482 / 2517: round-trip — reenter (now tail wording, no preserved enqueuedIso)', () => {
  const line = reenterAuditLine(T1, 'my-slug');
  assert.equal(line, `- ${T1} — my-slug re-entered at TAIL (post-rework, plan 2517)`);
  const parsed = parseAuditLine(line);
  assert.deepEqual(parsed, {
    verb: 'reenter',
    iso: T1,
    slug: 'my-slug',
  });
});

test('plan 2517: a HISTORICAL plan-2170 preserved-position reenter audit line still parses (read-only — no longer written)', () => {
  const legacy = `- ${T1} — my-slug re-entered at preserved enqueuedIso ${T0} (post-rework, plan 2170)`;
  assert.deepEqual(parseAuditLine(legacy), {
    verb: 'reenter',
    iso: T1,
    slug: 'my-slug',
    enqueuedIso: T0,
  });
});

test('plan 2482: parseAuditLine returns null for an unmatched line, distinguishably from a matched one', () => {
  assert.equal(parseAuditLine('- not a real audit line'), null);
  assert.equal(parseAuditLine(''), null);
});

test('plan 2482: parseAuditRegion parses a real rendered doc end-to-end (all six verbs, order preserved)', () => {
  const audit = [
    applyDemote([entry('hog'), entry('w', '🟩')], 'w', T0, 20, DEFAULT_DEMOTE_STALE_MIN).auditLine,
    applySteal([entry('alpha'), entry('beta', '🟩')], 'beta', T0, 50).auditLine,
    applyOvertake([entry('holder', '🟥', { state: HOLDING_STATE }), entry('w', '🟩')], 'w', T0)
      .auditLine,
    applyReap([entry('hog'), entry('w', '🟩')], 'w', T0, 50, 10).auditLine,
    requeueAuditLine(T0, 'my-slug'),
    reenterAuditLine(T0, 'my-slug'),
  ];
  const doc = renderQueue(initialQueueDoc(), [], audit);
  const parsed = parseAuditRegion(doc);
  assert.deepEqual(
    parsed.map((p) => p.verb),
    ['demote', 'steal', 'overtake', 'reap', 'requeue', 'reenter'],
  );
  assert.deepEqual(
    parsed.map((p) => p.slug),
    ['hog', 'alpha', 'holder', 'hog', 'my-slug', 'my-slug'],
  );
});

test('plan 2482 (execution note E2): demoteAuditCount — a slug that PREFIXES another slug never false-counts', () => {
  const nowMs = Date.parse(T1);
  const line = (slug) =>
    `- ${T0} — auto-demote: ${slug} → tail (heartbeat age 20m > 15m, not landing) by w`;
  // "foo-bar"'s demote lines must NOT count toward "foo"
  const audit = [line('foo-bar'), line('foo-bar')];
  assert.equal(demoteAuditCount(audit, 'foo', nowMs), 0);
  assert.equal(demoteAuditCount(audit, 'foo-bar', nowMs), 2);
  // and the shared parser agrees — this is the exact grammar the count is keyed on
  assert.deepEqual(
    audit.map((l) => parseAuditLine(l).slug),
    ['foo-bar', 'foo-bar'],
  );
});

// ── plan 2603: decorateWithHeartbeatRefs — the pure READ-side fold ─────────────────
// Everything the ref-transport rests on is this function alone: the CLI (readFresh +
// readHeartbeatRefs) supplies the map, this is where the doc's own heartbeatIso/
// progressIso/reapArmedIso cells actually get decorated with it. No fs/git — every
// case below is a table of entries + a plain object map.
const T_ENQ = '2026-06-10T07:00:00.000Z'; // before every T0/T1 below
const T_OLDER_REF = '2026-06-10T07:30:00.000Z'; // after T_ENQ, before T0

test('decorateWithHeartbeatRefs: empty/absent map returns the entries UNCHANGED (identity)', () => {
  const entries = [entry('a'), entry('b', '🟩')];
  // Same array reference back, not just deepEqual — a no-op fold must not even allocate
  // a new array on the common case (no ref for anyone in this queue yet).
  assert.equal(decorateWithHeartbeatRefs(entries, {}), entries);
  assert.equal(decorateWithHeartbeatRefs(entries, null), entries);
  assert.equal(decorateWithHeartbeatRefs(entries, undefined), entries);
});

test('decorateWithHeartbeatRefs: a NEWER ref stamp wins; an OLDER one does not overwrite (max, never overwrite)', () => {
  const base = entry('a', '🟥', { enqueuedIso: T_ENQ, heartbeatIso: T0 });
  // newer ref stamp (T1 > T0) → wins
  const newer = decorateWithHeartbeatRefs([base], { a: { ts: T1, progressIso: null } });
  assert.equal(newer[0].heartbeatIso, T1, 'a ref stamp newer than the doc cell must win');
  // older ref stamp (T_OLDER_REF < T0, but still after enqueuedIso) → doc cell stands
  const older = decorateWithHeartbeatRefs([base], { a: { ts: T_OLDER_REF, progressIso: null } });
  assert.equal(
    older[0].heartbeatIso,
    T0,
    'a ref stamp OLDER than the doc cell must never overwrite it — max, never overwrite',
  );
});

test('decorateWithHeartbeatRefs: a stamp at-or-before enqueuedIso is IGNORED (stale ref from a prior residency)', () => {
  // A slug that was dequeued and re-enqueued gets a fresh enqueuedIso; a leftover ref
  // stamp from its PREVIOUS residency must not resurrect it as "alive" the instant it
  // re-enters the queue.
  const base = entry('a', '🟥', { enqueuedIso: T0, heartbeatIso: T0 });
  // strictly before enqueuedIso
  const before = decorateWithHeartbeatRefs([base], { a: { ts: T_ENQ, progressIso: null } });
  assert.equal(before[0].heartbeatIso, T0, 'a stamp before enqueuedIso is ignored');
  // exactly AT enqueuedIso (the boundary — "at or before", not just "before")
  const atBoundary = decorateWithHeartbeatRefs([base], { a: { ts: T0, progressIso: null } });
  assert.equal(atBoundary[0].heartbeatIso, T0, 'a stamp exactly at enqueuedIso is ignored too');
});

test('decorateWithHeartbeatRefs: an unparseable enqueuedIso keeps the stamp (fail-safe: never refuse displacement on a corrupt cell)', () => {
  const base = entry('a', '🟥', { enqueuedIso: 'not-a-real-date', heartbeatIso: T_ENQ });
  const decorated = decorateWithHeartbeatRefs([base], { a: { ts: T1, progressIso: null } });
  assert.equal(
    decorated[0].heartbeatIso,
    T1,
    'an unparseable enqueuedIso must not block a genuinely newer ref stamp from folding in',
  );
});

test('decorateWithHeartbeatRefs: progressIso folds by the identical max rule as heartbeatIso', () => {
  const base = entry('a', '🟥', {
    enqueuedIso: T_ENQ,
    heartbeatIso: T0,
    progressIso: T_OLDER_REF,
  });
  // newer ref progressIso wins
  const newer = decorateWithHeartbeatRefs([base], { a: { ts: T0, progressIso: T1 } });
  assert.equal(newer[0].progressIso, T1);
  // older ref progressIso does not overwrite the doc's own (newer) progressIso
  const olderBase = entry('a', '🟥', { enqueuedIso: T_ENQ, heartbeatIso: T0, progressIso: T1 });
  const older = decorateWithHeartbeatRefs([olderBase], {
    a: { ts: T0, progressIso: T_OLDER_REF },
  });
  assert.equal(
    older[0].progressIso,
    T1,
    'an older ref progressIso must not overwrite a newer doc one',
  );
});

test('decorateWithHeartbeatRefs: reapArmedIso is VOIDED when the effective heartbeat is newer than the arm', () => {
  const armedAt = T0;
  const base = entry('a', '🟥', {
    enqueuedIso: T_ENQ,
    heartbeatIso: T_ENQ,
    reapArmedIso: armedAt,
  });
  // the ref stamp (T1) lands strictly AFTER the arm → the arm must be cleared, the same
  // way heartbeatEntry unconditionally clears it on a doc-carried heartbeat.
  const decorated = decorateWithHeartbeatRefs([base], { a: { ts: T1, progressIso: null } });
  assert.equal(
    decorated[0].reapArmedIso,
    null,
    'a heartbeat newer than the arm must disarm the reap grace, or a later-genuinely-stale ' +
      'head would be reaped with no fresh grace period',
  );
});

test('decorateWithHeartbeatRefs: reapArmedIso is NOT voided when the arm is newer than the effective heartbeat', () => {
  const base = entry('a', '🟥', {
    enqueuedIso: T_ENQ,
    heartbeatIso: T_ENQ,
    reapArmedIso: T1, // armed AFTER the (about to be folded) ref stamp
  });
  const decorated = decorateWithHeartbeatRefs([base], { a: { ts: T0, progressIso: null } });
  assert.equal(
    decorated[0].reapArmedIso,
    T1,
    'an arm stamped after the effective heartbeat must survive the fold untouched',
  );
});

test('decorateWithHeartbeatRefs: a slug with no stamp in the map is untouched', () => {
  const base = entry('a', '🟥', { heartbeatIso: T0, progressIso: T0, reapArmedIso: T0 });
  const decorated = decorateWithHeartbeatRefs([base], {
    'some-other-slug': { ts: T1, progressIso: T1 },
  });
  assert.deepEqual(
    decorated[0],
    base,
    'an entry absent from the ref map must pass through unchanged',
  );
});

// ── plan 3450: the ghost sweep caller (the pure half) ──────────────────────────────
// The sweep's whole safety argument is that it SATISFIES the membership gate instead of
// weakening it, so these pin the ghost's three load-bearing properties: it passes the gate
// even against a one-entry queue, it carries no session, and it can never collide with a real
// entry — that last one both where the queue is judged and where entries are created.
test('plan 3450: the ghost waiter passes the membership gate on a queue of ONE dead head', () => {
  const entries = [
    { slug: 'dead-head', lane: '🟥', session: '1', host: 'vm', enqueuedIso: T0, heartbeatIso: T0 },
  ];
  const view = withGhostWaiter(entries);
  assert.equal(
    positionOf(view, SWEEP_CALLER),
    2,
    'the ghost sits behind the head — the exact gate',
  );
  const v = demoteVerdict({
    entries: view,
    demoter: SWEEP_CALLER,
    nowMs: Date.parse('2026-06-10T08:20:00.000Z'),
  });
  assert.equal(v.ok, true, 'a dead head with NO live waiter is still demote-eligible to the ghost');
  assert.equal(v.head.slug, 'dead-head');
  assert.equal(entries.length, 1, 'the ghost is verdict-only — the real array is untouched');
});

test('plan 3450: the ghost carries UNKNOWN_SESSION, so it never trips the same-session refusal', () => {
  const entries = [
    {
      slug: 'dead-head',
      lane: '🟥',
      session: UNKNOWN_SESSION,
      host: 'vm',
      enqueuedIso: T0,
      heartbeatIso: T0,
    },
  ];
  const ghost = withGhostWaiter(entries).at(-1);
  assert.equal(ghost.session, UNKNOWN_SESSION);
  assert.equal(
    demoteVerdict({
      entries: withGhostWaiter(entries),
      demoter: SWEEP_CALLER,
      nowMs: Date.parse('2026-06-10T08:20:00.000Z'),
    }).ok,
    true,
    'two UNKNOWN_SESSION entries must not read as "the same session"',
  );
});

test('plan 3450: a real entry named like the ghost is REFUSED, never judged', () => {
  assert.throws(
    () => withGhostWaiter([{ slug: SWEEP_CALLER, lane: '🟩', session: '1', host: 'h' }]),
    /reserved ghost caller/,
  );
});

// review round 1 (F6): the assert above fires where the queue is JUDGED, which is far too
// late — by then a `(sweep)` entry has already wedged every sweep. This is the guard at the
// seam where entries are CREATED, which is what makes the collision impossible in the first
// place.
test('plan 3450 (review F6): the reserved ghost name is refused at the write seam, and ordinary slugs are not', () => {
  assert.match(reservedSlugRefusal(SWEEP_CALLER), /cannot be a queue entry/);
  assert.match(reservedSlugRefusal(SWEEP_CALLER), /\(sweep\)/, 'the message names the ghost');
  assert.equal(
    reservedSlugRefusal('3450-FABLE-Coord-landing-queue-dead-head'),
    null,
    'a real plan-basename slug is writable',
  );
  assert.equal(reservedSlugRefusal('worktree-2731-x'), null);
  for (const shape of ['(sweep', 'sweep)', '(reaper)', 'plan-(1)']) {
    assert.notEqual(
      reservedSlugRefusal(shape),
      null,
      `any parenthesized name is reserved, not just the exact ghost: ${shape}`,
    );
  }
});

// review round 2 (G4). Two defects in the round-1 guard, both closed by deferring to the rule
// this repo already owns. (1) It was a hand-rolled parenthesis test living beside
// claim-plan-lib's `assertSlugCharset`, the validator every plan mint, claim and worktree cut
// already goes through — so a slug carrying a pipe or a space passed here, then rendered as a
// table row whose cells shift under `cellsOf`, leaving the entry undequeueable. (2) It was
// enforced only in the CLI's dispatch table, i.e. for exactly the three verbs listed there;
// anything else calling these exported helpers could still persist a row the sweep can never
// judge. The grammar is now shared, and the refusal is asserted where entries are CREATED.
test('plan 3450 (review round 2, G4): the write seam reuses the shared slug grammar and enforces it at creation', () => {
  for (const bad of ['foo|bar', 'foo bar', "clinic's-fix", 'öppettider', '-leading-hyphen', '']) {
    assert.notEqual(reservedSlugRefusal(bad), null, `the shared grammar must reject "${bad}"`);
  }
  assert.match(
    reservedSlugRefusal('foo|bar'),
    /must match/,
    'the refusal quotes the shared validator, so the two rules cannot drift apart',
  );
  assert.notEqual(
    reservedSlugRefusal(undefined),
    null,
    'a slug that is missing entirely is not writable either — it renders as a literal row cell',
  );
  // The ENFORCEMENT half: both creating seams, not just the CLI verbs that happen to call them.
  for (const create of [enqueueEntry, insertPriorityEntry]) {
    assert.throws(() => create([], entry(SWEEP_CALLER)), /cannot be a queue entry/);
    assert.throws(() => create([], entry('foo|bar')), /cannot be a queue entry/);
  }
  // …and a real slug still passes both seams untouched.
  assert.deepEqual(
    enqueueEntry([], entry('3450-FABLE-Coord-landing-queue-dead-head')).map((e) => e.slug),
    ['3450-FABLE-Coord-landing-queue-dead-head'],
  );
});

test('plan 3450: a FRESH head is untouched by the ghost — the sweep adds no new staleness axis', () => {
  const entries = [
    {
      slug: 'live-head',
      lane: '🟥',
      session: '1',
      host: 'vm',
      enqueuedIso: T0,
      heartbeatIso: '2026-06-10T08:18:00.000Z',
      progressIso: '2026-06-10T08:18:00.000Z',
    },
  ];
  const v = demoteVerdict({
    entries: withGhostWaiter(entries),
    demoter: SWEEP_CALLER,
    nowMs: Date.parse('2026-06-10T08:20:00.000Z'),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /heartbeat is fresh/);
});

// review round 3 (H5). G4 guarded the two APPEND seams and missed the third writer: requeue
// MOVES an entry to the tail, and when the slug has vanished mid-flight it invents the row from
// the caller's `fallback` — writing a slug nothing had validated. applyDemote rides that path,
// so a malformed fallback reached the rendered table, shifted its cells under `cellsOf`, and
// left the entry undequeueable with every later sweep refusing to judge the head.
test('plan 3450 (review round 3, H5): requeueEntry enforces the slug grammar on both the fallback and the existing row', () => {
  // the fallback path: the slug is absent from the queue, so `fallback` becomes the new row
  for (const bad of ['foo|bar', SWEEP_CALLER, 'foo bar']) {
    assert.throws(
      () => requeueEntry([], 'missing', '2026-06-10T00:00:00.000Z', entry(bad)),
      /cannot be a queue entry/,
      `requeue must refuse to write "${bad}", exactly as enqueue does`,
    );
  }
  // the existing path: a row already carrying a malformed slug is a queue that is ALREADY
  // corrupt — moving it to the tail would only re-render the corruption.
  assert.throws(
    () => requeueEntry([entry('foo|bar')], 'foo|bar', '2026-06-10T00:00:00.000Z'),
    /cannot be a queue entry/,
  );
  // a real slug still moves to the tail untouched, through either branch
  assert.deepEqual(
    requeueEntry(
      [entry('head-slug'), entry('tail-slug')],
      'head-slug',
      '2026-06-10T00:00:00.000Z',
    ).entries.map((e) => e.slug),
    ['tail-slug', 'head-slug'],
  );
  assert.equal(
    requeueEntry([], 'absent-slug', '2026-06-10T00:00:00.000Z', entry('absent-slug')).entry.slug,
    'absent-slug',
    'and a legitimate fallback still re-enters the queue rather than vanishing',
  );
});
