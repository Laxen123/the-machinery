// scripts/board-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitBoard,
  findRowLineIndex,
  renderRow,
  setRowState,
  updateRow,
  upsertRow,
  removeRow,
  removeRows,
  landingRows,
  stampLanding,
  landingInfo,
  rowSlugsForPlanIdLines,
  rowKeysForPlan,
  rowsForPlanId,
  rowsForPlanIdLines,
  isBatchMemberCell,
  batchSlugOfCell,
  planIdOfRowSlug,
  updateRows,
  updateRowsLines,
  upsertRowLines,
  PAUSED_STATE,
  landingRowReapVerdict,
  DEFAULT_LANDING_REAP_STALE_MIN,
} from './board-lib.mjs';

const SAMPLE = [
  'preamble line',
  '<!-- BOARD-START -->',
  '',
  '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume condition |',
  '| --- | --- | --- | --- | --- | --- |',
  '| alpha | `aaa1111` | 🔄 ACTIVE | `in-progress/100-Other-x.md` · session 5 · host=`H` | 2026-05-28 | — |',
  '| beta | `bbb2222` | ⏸ PAUSED | `waiting-trip/101-Other-y.md` · session 6 · host=`H` | 2026-05-27 | resume when Z |',
  '',
  '<!-- BOARD-END -->',
  'tail line',
].join('\n');

test('splitBoard returns head/body/tail around sentinels', () => {
  const { head, body, tail } = splitBoard(SAMPLE);
  assert.ok(head.endsWith('<!-- BOARD-START -->'));
  assert.ok(tail.startsWith('<!-- BOARD-END -->'));
  assert.ok(body.includes('| alpha |'));
});

test('splitBoard throws when sentinels missing', () => {
  assert.throws(() => splitBoard('no sentinels here'), /sentinels/);
});

test('landingRows matches only the State column, not "🟢 LANDING" in resume prose', () => {
  const { body } = splitBoard(SAMPLE);
  // No real LANDING row in SAMPLE → empty.
  assert.deepEqual(landingRows(body), []);

  // A row whose RESUME prose mentions the mutex must NOT count as held (the
  // exact false-positive that deadlocked plan 230's auto-recheck).
  const proseOnly = SAMPLE.replace(
    '| beta | `bbb2222` | ⏸ PAUSED | `waiting-trip/101-Other-y.md` · session 6 · host=`H` | 2026-05-27 | resume when Z |',
    '| beta | `bbb2222` | 🔄 ACTIVE | `in-progress/101-Other-y.md` · session 6 · host=`H` | 2026-05-27 | QUEUED behind alpha 🟢 LANDING mutex |',
  );
  assert.deepEqual(
    landingRows(splitBoard(proseOnly).body),
    [],
    'prose mention is not a held mutex',
  );

  // A genuine LANDING state IS detected, and `except` filters the own row out.
  const realLanding = SAMPLE.replace(
    '| alpha | `aaa1111` | 🔄 ACTIVE |',
    '| alpha | `aaa1111` | 🟢 LANDING |',
  );
  const held = landingRows(splitBoard(realLanding).body);
  assert.equal(held.length, 1);
  assert.match(held[0], /\| alpha \|/);
  assert.deepEqual(
    landingRows(splitBoard(realLanding).body, 'alpha'),
    [],
    'except excludes own row',
  );
});

test('findRowLineIndex locates a row by slug (cell 0), ignoring header/separator', () => {
  const { body } = splitBoard(SAMPLE);
  const lines = body.split('\n');
  assert.equal(findRowLineIndex(lines, 'beta') >= 0, true);
  assert.equal(findRowLineIndex(lines, 'nope'), -1);
  // header/separator are never matched
  assert.equal(findRowLineIndex(lines, 'Worktree'), -1);
});

test('setRowState changes only the State cell of the named row', () => {
  const out = setRowState(SAMPLE, 'alpha', '🟢 LANDING');
  assert.ok(out.includes('| alpha | `aaa1111` | 🟢 LANDING |'));
  assert.ok(out.includes('| beta | `bbb2222` | ⏸ PAUSED |')); // untouched
  assert.equal(out.split('\n').length, SAMPLE.split('\n').length); // no row count change
});

test('setRowState throws on unknown slug', () => {
  assert.throws(() => setRowState(SAMPLE, 'ghost', '🟢 LANDING'), /not found/);
});

test('setRowState: F-018 — { tolerateAbsent: true } is an idempotent no-op on an unknown slug', () => {
  const out = setRowState(SAMPLE, 'ghost', '🟢 LANDING', { tolerateAbsent: true });
  assert.equal(out, SAMPLE, 'content is byte-identical when the row does not exist');
});

test('setRowState: tolerateAbsent does not affect a PRESENT row — still updates it', () => {
  const out = setRowState(SAMPLE, 'alpha', '⏸ PAUSED', { tolerateAbsent: true });
  assert.ok(out.includes('| alpha | `aaa1111` | ⏸ PAUSED |'));
});

test('renderRow produces a 6-cell pipe row', () => {
  const row = renderRow({
    slug: 'gamma',
    tip: '`ccc3333`',
    state: '🔄 ACTIVE',
    planClaim: '`in-progress/102-Other-z.md` · session 7 · host=`H`',
    touched: '2026-05-28',
    resume: '—',
  });
  assert.equal(
    row,
    '| gamma | `ccc3333` | 🔄 ACTIVE | `in-progress/102-Other-z.md` · session 7 · host=`H` | 2026-05-28 | — |',
  );
});

test('upsertRow inserts a new row before BOARD-END and is idempotent on slug', () => {
  const one = upsertRow(SAMPLE, {
    slug: 'gamma',
    tip: '`c`',
    state: '🔄 ACTIVE',
    planClaim: 'p',
    touched: 'd',
    resume: '—',
  });
  assert.ok(one.includes('| gamma |'));
  // upsert again with a new tip → replaces, does not duplicate
  const two = upsertRow(one, {
    slug: 'gamma',
    tip: '`c2`',
    state: '🔄 ACTIVE',
    planClaim: 'p',
    touched: 'd',
    resume: '—',
  });
  assert.equal((two.match(/\| gamma \|/g) || []).length, 1);
  assert.ok(two.includes('`c2`'));
});

test('removeRow deletes the row and nothing else', () => {
  const out = removeRow(SAMPLE, 'alpha');
  assert.equal(out.includes('| alpha |'), false);
  assert.ok(out.includes('| beta |'));
  assert.ok(out.includes('<!-- BOARD-END -->'));
});

test('removeRow throws on unknown slug', () => {
  assert.throws(() => removeRow(SAMPLE, 'ghost'), /not found/);
});

test('removeRow: F-018 — { tolerateAbsent: true } is an idempotent no-op on an unknown slug', () => {
  const out = removeRow(SAMPLE, 'ghost', { tolerateAbsent: true });
  assert.equal(out, SAMPLE, 'content is byte-identical when the row does not exist');
});

test('removeRow: tolerateAbsent does not affect a PRESENT row — still removes it', () => {
  const out = removeRow(SAMPLE, 'alpha', { tolerateAbsent: true });
  assert.equal(out.includes('| alpha |'), false);
});

// ───────────────────── plan 1364 Ship 3: multi-row remove (batch close-out) ─────────────────

test('removeRows: removes every present slug in ONE pass, reports the rest as absent, never throws', () => {
  const { content, removed, absent } = removeRows(SAMPLE, ['alpha', 'ghost', 'beta']);
  assert.deepEqual(removed, ['alpha', 'beta']);
  assert.deepEqual(absent, ['ghost']);
  assert.equal(content.includes('| alpha |'), false);
  assert.equal(content.includes('| beta |'), false);
  assert.ok(content.includes('<!-- BOARD-END -->'));
});

test('removeRows: ALL slugs absent → content unchanged (byte-identical), never throws', () => {
  const { content, removed, absent } = removeRows(SAMPLE, ['ghost1', 'ghost2']);
  assert.deepEqual(removed, []);
  assert.deepEqual(absent, ['ghost1', 'ghost2']);
  assert.equal(content, SAMPLE);
});

test('removeRows: ALL slugs present → both removed, nothing else touched', () => {
  const { content, removed, absent } = removeRows(SAMPLE, ['alpha', 'beta']);
  assert.deepEqual(removed, ['alpha', 'beta']);
  assert.deepEqual(absent, []);
  assert.equal(content.includes('| alpha |'), false);
  assert.equal(content.includes('| beta |'), false);
});

test('removeRows: a duplicate slug in the request is removed once, then reported absent on its repeat', () => {
  const { content, removed, absent } = removeRows(SAMPLE, ['alpha', 'alpha']);
  assert.deepEqual(removed, ['alpha']);
  assert.deepEqual(absent, ['alpha']);
  assert.equal(content.includes('| alpha |'), false);
});

// ── LANDING claim-time stamp (plan 236 Task 1) ──────────────────────────────

test('stampLanding sets state EXACTLY to LANDING and stamps the touched cell', () => {
  const out = stampLanding(SAMPLE, 'alpha', '2026-05-30T10:00:00.000Z');
  const row = out.split('\n').find((l) => l.startsWith('| alpha |'));
  const cells = row
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
  assert.equal(cells[2], '🟢 LANDING'); // state stays column-exact for landingRows
  assert.match(cells[4], /landing@2026-05-30T10:00:00\.000Z/);
  // landingRows still detects it (exact column match, no breakage)
  assert.equal(landingRows(splitBoard(out).body).length, 1);
});

test('stampLanding is idempotent — re-stamping replaces, never duplicates', () => {
  const once = stampLanding(SAMPLE, 'alpha', '2026-05-30T10:00:00.000Z');
  const twice = stampLanding(once, 'alpha', '2026-05-30T11:30:00.000Z');
  const row = twice.split('\n').find((l) => l.startsWith('| alpha |'));
  assert.equal((row.match(/landing@/g) || []).length, 1);
  assert.match(row, /landing@2026-05-30T11:30:00\.000Z/);
});

test('stampLanding throws on unknown slug', () => {
  assert.throws(() => stampLanding(SAMPLE, 'ghost', '2026-05-30T10:00:00.000Z'), /not found/);
});

test('stampLanding: F-018 — { tolerateAbsent: true } is an idempotent no-op on an unknown slug', () => {
  const out = stampLanding(SAMPLE, 'ghost', '2026-05-30T10:00:00.000Z', { tolerateAbsent: true });
  assert.equal(out, SAMPLE, 'content is byte-identical when the row does not exist');
});

test('landingInfo: non-LANDING (or absent) row → landing:false', () => {
  assert.deepEqual(landingInfo(SAMPLE, 'alpha', 0), { landing: false, iso: null, ageMin: null });
  assert.deepEqual(landingInfo(SAMPLE, 'ghost', 0), { landing: false, iso: null, ageMin: null });
});

test('landingInfo: stamped LANDING row → ageMin computed from injected now', () => {
  const stamped = stampLanding(SAMPLE, 'alpha', '2026-05-30T10:00:00.000Z');
  const now = Date.parse('2026-05-30T10:42:00.000Z'); // 42 min later
  const info = landingInfo(stamped, 'alpha', now);
  assert.equal(info.landing, true);
  assert.equal(info.iso, '2026-05-30T10:00:00.000Z');
  assert.equal(info.ageMin, 42);
});

test('landingInfo: LANDING with no stamp → ageMin null (caller treats as stale)', () => {
  const landing = setRowState(SAMPLE, 'alpha', '🟢 LANDING'); // no landing@ token
  const info = landingInfo(landing, 'alpha', Date.parse('2026-05-30T10:00:00.000Z'));
  assert.deepEqual(info, { landing: true, iso: null, ageMin: null });
});

test('landingInfo: ageMin never negative (clock skew clamps to 0)', () => {
  const stamped = stampLanding(SAMPLE, 'alpha', '2026-05-30T10:00:00.000Z');
  const before = Date.parse('2026-05-30T09:55:00.000Z'); // now < stamp
  assert.equal(landingInfo(stamped, 'alpha', before).ageMin, 0);
});

// plan 3443: landingInfo reads the stamp from cell 4 ONLY (`stampLanding`'s own write target),
// never by scanning the whole row — the same correction review Fix 5 made to this scrape's twin
// in the reaper (queue-drain's landingIsoFromRow).
//
// The shadowing is ORDER-dependent, which is why this test seeds cell 3 and not the resume
// cell: a whole-line `/landing@(\S+)/` takes the FIRST match in the row, and cells 0-4 are laid
// out `slug | tip | state | plan/claim | last-touched`, so the real cell-4 stamp already wins
// against anything in the RESUME cell (cell 5) — a resume-seeded case passes both before and
// after the fix and proves nothing. Only a token in a cell BEFORE cell 4 actually shadows it.
test('landingInfo: a landing@ token in an EARLIER cell never shadows the real cell-4 stamp', () => {
  const stamped = stampLanding(SAMPLE, 'alpha', '2026-05-30T10:00:00.000Z');
  const shadowed = updateRow(stamped, 'alpha', {
    planClaim: 'in-progress/alpha.md · resumed after landing@2026-05-30T08:00:00.000Z',
  });
  const now = Date.parse('2026-05-30T10:42:00.000Z'); // 42 min after the REAL stamp
  const info = landingInfo(shadowed, 'alpha', now);
  assert.equal(info.iso, '2026-05-30T10:00:00.000Z', 'reads cell 4, not the earlier claim cell');
  assert.equal(info.ageMin, 42, 'a shadowed read would report 162m from the cell-3 token');
});

// ── plan 1801: rowSlugsForPlanIdLines — locate a plan's board row by its STABLE plan id, so a
// plan renamed while claimed (row still carrying the claim-time slug) can be found/removed.
// (plan 2512: the CONTENT-level wrapper `rowSlugsForPlanId` was dead production code — only
// this file exercised it — and was deleted; `rowsForPlanId` below covers the same id-boundary
// + fail-closed contract at content level and stays alive.) ──
const BOARD_1801 = [
  'pre',
  '<!-- BOARD-START -->',
  '',
  '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
  '| --- | --- | --- | --- | --- | --- |',
  '| 1785-Infra-test-queue | `aaa` | 🔄 ACTIVE | `in-progress/1785-FABLE-….md` | 2026 | — |',
  '| 178-DQ-other | `bbb` | 🔄 ACTIVE | `in-progress/178-DQ-other.md` | 2026 | — |',
  '| 2026-05-17-vetpris-legacy | `ccc` | ⏸ PAUSED | legacy date slug | 2026 | — |',
  '| bare-legacy-slug | `ddd` | 🔄 ACTIVE | no id prefix | 2026 | — |',
  '<!-- BOARD-END -->',
  '',
].join('\n');
const BOARD_1801_LINES = splitBoard(BOARD_1801).body.split('\n');

test('rowSlugsForPlanIdLines: finds the row by id even when the slug tag part diverged (rename desync)', () => {
  assert.deepEqual(rowSlugsForPlanIdLines(BOARD_1801_LINES, '1785'), ['1785-Infra-test-queue']);
});

test('rowSlugsForPlanIdLines: id-prefix boundary — id 178 matches only 178-…, never 1785-…', () => {
  assert.deepEqual(rowSlugsForPlanIdLines(BOARD_1801_LINES, '178'), ['178-DQ-other']);
});

test('rowSlugsForPlanIdLines: a digit after `<id>-` never matches — legacy date slug 2026-05-… is not plan 2026', () => {
  assert.deepEqual(rowSlugsForPlanIdLines(BOARD_1801_LINES, '2026'), []);
});

test('rowSlugsForPlanIdLines: bare (id-less) legacy slugs and absent ids yield [] — callers union the basename slug', () => {
  assert.deepEqual(rowSlugsForPlanIdLines(BOARD_1801_LINES, '9999'), []);
});

test('rowSlugsForPlanIdLines: header row is skipped even if it ever matched; multiple id rows all returned', () => {
  const lines = [
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 1785-Infra-old | `a` | 🔄 ACTIVE | x | 2026 | — |',
    '| 1785-FABLE-new | `b` | 🔄 ACTIVE | x | 2026 | — |',
  ];
  assert.deepEqual(rowSlugsForPlanIdLines(lines, '1785'), ['1785-Infra-old', '1785-FABLE-new']);
});

test('rowSlugsForPlanIdLines: a NON-DIGIT "plan id" (hand-corrupted manifest member) yields [] instead of throwing/false-matching (review-fix)', () => {
  // Regex metacharacters must not reach `new RegExp` — pre-guard, `(` threw a SyntaxError that
  // the content-level wrapper silently swallowed into [], reproducing the orphan-row bug.
  assert.deepEqual(
    rowSlugsForPlanIdLines(['| 1785-Infra-x | `a` | 🔄 ACTIVE | x | 2026 | — |'], '17(85'),
    [],
  );
  assert.deepEqual(rowSlugsForPlanIdLines(BOARD_1801_LINES, '1785+'), []);
  assert.deepEqual(rowSlugsForPlanIdLines(BOARD_1801_LINES, ''), []);
});

test('rowKeysForPlan: unions planId-keyed rows with the basename-derived slug, deduplicating when they agree', () => {
  const lines = [
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 1785-Infra-old | `a` | 🔄 ACTIVE | x | 2026 | — |',
  ];
  // Rename desync: basename now differs from the row slug → both keys returned.
  assert.deepEqual(rowKeysForPlan(lines, '1785', '1785-FABLE-new'), [
    '1785-Infra-old',
    '1785-FABLE-new',
  ]);
  // No desync: basename equals the row slug → one key.
  assert.deepEqual(rowKeysForPlan(lines, '1785', '1785-Infra-old'), ['1785-Infra-old']);
  // Legacy bare slug (no id prefix on the board): only the basename key.
  assert.deepEqual(rowKeysForPlan(lines, '9999', 'bare-legacy-slug'), ['bare-legacy-slug']);
  // Nothing resolvable at all.
  assert.deepEqual(rowKeysForPlan(lines, '9999', null), []);
});

// ── plan 2394: rowsForPlanId / isBatchMemberCell / updateRows — the primitives
// `claim-plan acquire --resume` needs to retire a dead holder's row inside its own atomic
// projection commit instead of printing a demote-by-hand hint. ──

const BOARD_2394 = [
  'pre',
  '<!-- BOARD-START -->',
  '',
  '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
  '| --- | --- | --- | --- | --- | --- |',
  '| 2394-Coord-old | `aaa` | 🔄 ACTIVE | `in-progress/2394-Coord-x.md` · session 1 · host=`DEAD` · 🟩 | 2026-07-25 | — |',
  '| 2394-Coord-member | `bbb` | 🔄 ACTIVE | `in-progress/2394-Coord-x.md` · session 2 · host=`H` · 🟩 · batch=`batch-2026-07-25-coord` | 2026-07-25 | — |',
  '| 2394-Coord-landing | `ccc` | 🟢 LANDING | `in-progress/2394-Coord-x.md` · session 3 · host=`H` · 🟩 | 2026-07-25 | — |',
  '<!-- BOARD-END -->',
  '',
].join('\n');

test('rowsForPlanId: returns state + claim cell alongside the slug (the two cells a takeover must read)', () => {
  assert.deepEqual(rowsForPlanId(BOARD_2394, '2394'), [
    {
      slug: '2394-Coord-old',
      state: '🔄 ACTIVE',
      planClaim: '`in-progress/2394-Coord-x.md` · session 1 · host=`DEAD` · 🟩',
    },
    {
      slug: '2394-Coord-member',
      state: '🔄 ACTIVE',
      planClaim:
        '`in-progress/2394-Coord-x.md` · session 2 · host=`H` · 🟩 · batch=`batch-2026-07-25-coord`',
    },
    {
      slug: '2394-Coord-landing',
      state: '🟢 LANDING',
      planClaim: '`in-progress/2394-Coord-x.md` · session 3 · host=`H` · 🟩',
    },
  ]);
});

test('rowsForPlanId: inherits the id-boundary + fail-closed contract rowSlugsForPlanIdLines documents', () => {
  // Same matcher underneath, so the 1801 boundary rules must hold identically — a second
  // hand-rolled matcher disagreeing about which rows belong to the plan is exactly what
  // extracting planIdRowMatcher prevents.
  assert.deepEqual(
    rowsForPlanId(BOARD_1801, '178').map((r) => r.slug),
    ['178-DQ-other'],
  );
  assert.deepEqual(rowsForPlanId(BOARD_1801, '2026'), []);
  assert.deepEqual(rowsForPlanId(BOARD_1801, '17(85'), []);
  assert.deepEqual(rowsForPlanId('not a board', '1785'), []);
  // …and rowSlugsForPlanIdLines is its Lines-level projection (rowSlugsForPlanId, the
  // content-level equivalent, was dead production code and was deleted — plan 2512).
  assert.deepEqual(
    rowSlugsForPlanIdLines(BOARD_2394.split('\n'), '2394'),
    rowsForPlanIdLines(BOARD_2394.split('\n'), '2394').map((r) => r.slug),
  );
});

test('isBatchMemberCell: detects the `batch=` marker boardBatchPlanClaimCell stamps, and nothing else', () => {
  assert.equal(
    isBatchMemberCell(
      '`in-progress/2394-Coord-x.md` · session 2 · host=`H` · 🟩 · batch=`batch-2026-07-25-coord`',
    ),
    true,
  );
  assert.equal(
    isBatchMemberCell('`in-progress/2394-Coord-x.md` · session 1 · host=`H` · 🟩'),
    false,
  );
  // A plan whose NAME contains "batch" is not a batch member — the marker is `batch=`, and a
  // slug/basename can never carry `=` (SLUG_CHARSET_RX).
  assert.equal(
    isBatchMemberCell('`in-progress/1364-Coord-batch-claim.md` · session 1 · host=`H` · 🟩'),
    false,
  );
  assert.equal(isBatchMemberCell(''), false);
  assert.equal(isBatchMemberCell(undefined), false);
});

test('updateRows: applies the same fields to N rows in ONE pass, tolerating absent slugs', () => {
  const { content, updated, absent } = updateRows(
    BOARD_2394,
    ['2394-Coord-old', '2394-Coord-gone'],
    { state: PAUSED_STATE, resume: 'superseded by `2394-Coord-new` (takeover 2026-07-26)' },
  );
  assert.deepEqual(updated, ['2394-Coord-old']);
  assert.deepEqual(absent, ['2394-Coord-gone'], 'an absent slug is reported, never thrown');
  assert.match(
    content,
    /\| 2394-Coord-old \| `aaa` \| ⏸ PAUSED \|.*\| superseded by `2394-Coord-new` \(takeover 2026-07-26\) \|/,
  );
  // Untouched rows are byte-identical, and non-named cells of the updated row survive.
  assert.match(content, /\| 2394-Coord-member \| `bbb` \| 🔄 ACTIVE \|/);
  assert.match(content, /\| 2394-Coord-old \| `aaa` \|.*session 1 · host=`DEAD`/);
});

test('updateRows: every slug absent returns byte-identical content (coordWrite reports a clean no-op)', () => {
  const { content, updated, absent } = updateRows(BOARD_2394, ['nope-1', 'nope-2'], {
    state: PAUSED_STATE,
  });
  assert.equal(content, BOARD_2394);
  assert.deepEqual(updated, []);
  assert.deepEqual(absent, ['nope-1', 'nope-2']);
});

test('updateRow: the single-row throw-on-unknown-slug contract is UNCHANGED by updateRows', () => {
  assert.throws(() => updateRow(BOARD_2394, 'nope', { state: PAUSED_STATE }), /row not found/);
});

// ── plan 2512: Lines-level entry points — the primitives `claim-plan.mjs`'s `projectClaim`
// threads a single already-split line array through instead of re-splitting per call. ──

test('updateRowsLines: mutates the line array in place and returns the same {updated,absent} shape content-level updateRows reports', () => {
  const lines = splitBoard(BOARD_2394).body.split('\n');
  const { updated, absent } = updateRowsLines(lines, ['2394-Coord-old', '2394-Coord-gone'], {
    state: PAUSED_STATE,
    resume: 'superseded by `2394-Coord-new` (takeover 2026-07-26)',
  });
  assert.deepEqual(updated, ['2394-Coord-old']);
  assert.deepEqual(absent, ['2394-Coord-gone']);
  const mutatedRow = lines.find((l) => l.startsWith('| 2394-Coord-old |'));
  assert.match(mutatedRow, /⏸ PAUSED/);
  // Byte-identical to what the content-level updateRows produces from the same input.
  const viaContentLevel = updateRows(BOARD_2394, ['2394-Coord-old', '2394-Coord-gone'], {
    state: PAUSED_STATE,
    resume: 'superseded by `2394-Coord-new` (takeover 2026-07-26)',
  }).content;
  const reassembled = (() => {
    const { head, tail } = splitBoard(BOARD_2394);
    return head + lines.join('\n') + tail;
  })();
  assert.equal(reassembled, viaContentLevel);
});

test('updateRowsLines: a duplicate slug in the request is resolved once via the map, applied on each occurrence (matches pre-2512 per-call semantics)', () => {
  const lines = splitBoard(BOARD_2394).body.split('\n');
  const { updated, absent } = updateRowsLines(lines, ['2394-Coord-old', '2394-Coord-old'], {
    state: PAUSED_STATE,
  });
  assert.deepEqual(updated, ['2394-Coord-old', '2394-Coord-old']);
  assert.deepEqual(absent, []);
});

// plan 2542: a board carrying two ROWS sharing a slug is an anomaly the machinery otherwise
// prevents, but if it ever happens both mutation paths must resolve to the SAME physical row.
const BOARD_DUP_SLUG = [
  'pre',
  '<!-- BOARD-START -->',
  '',
  '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
  '| --- | --- | --- | --- | --- | --- |',
  '| 2542-Coord-dup | `first` | 🔄 ACTIVE | `in-progress/2542-Coord-dup.md` · session 1 · host=`H` · 🟩 | 2026-07-27 | — |',
  '| 2542-Coord-dup | `second` | 🔄 ACTIVE | `in-progress/2542-Coord-dup.md` · session 2 · host=`H` · 🟩 | 2026-07-27 | — |',
  '<!-- BOARD-END -->',
  '',
].join('\n');

test('updateRowsLines: a duplicate-slug BOARD resolves to the FIRST occurrence, matching findRowLineIndex/updateRow', () => {
  const lines = splitBoard(BOARD_DUP_SLUG).body.split('\n');
  const findIdx = findRowLineIndex(lines, '2542-Coord-dup');
  updateRowsLines(lines, ['2542-Coord-dup'], { state: PAUSED_STATE });
  const mutatedIdx = lines.findIndex((l) => l.includes(PAUSED_STATE));
  assert.equal(mutatedIdx, findIdx);
  // The first row (branch tip `first`) is the one that mutated; the second (`second`) is untouched.
  assert.match(lines[mutatedIdx], /`first`/);
  assert.ok(lines.some((l) => l.includes('`second`') && l.includes('🔄 ACTIVE')));
});

test('upsertRowLines: replaces an existing row in place without changing line count', () => {
  const lines = splitBoard(BOARD_2394).body.split('\n');
  const before = lines.length;
  upsertRowLines(lines, {
    slug: '2394-Coord-old',
    tip: '`zzz`',
    state: '🔄 ACTIVE',
    planClaim: 'new-claim',
    touched: '2026-07-26',
    resume: '—',
  });
  assert.equal(lines.length, before);
  assert.ok(lines.some((l) => l.startsWith('| 2394-Coord-old | `zzz` |')));
});

test('upsertRowLines: appends a new row before the trailing blank lines, mirroring upsertRow', () => {
  const lines = splitBoard(BOARD_2394).body.split('\n');
  upsertRowLines(lines, {
    slug: '2394-Coord-brandnew',
    tip: '`ppp`',
    state: '🔄 ACTIVE',
    planClaim: 'x',
    touched: '2026-07-26',
    resume: '—',
  });
  const { head, tail } = splitBoard(BOARD_2394);
  const reassembled = head + lines.join('\n') + tail;
  assert.ok(reassembled.includes('| 2394-Coord-brandnew | `ppp` |'));
  const viaContentLevel = upsertRow(BOARD_2394, {
    slug: '2394-Coord-brandnew',
    tip: '`ppp`',
    state: '🔄 ACTIVE',
    planClaim: 'x',
    touched: '2026-07-26',
    resume: '—',
  });
  assert.equal(reassembled, viaContentLevel);
});

test('PAUSED_STATE renders the exact demote state the board already uses', () => {
  // SAMPLE's pre-existing paused row was written long before this constant existed — pinning
  // the constant against it proves the shared literal is the one already on the board (the
  // board.mjs STATE_ALIASES side of the pairing is asserted in board.test.mjs).
  assert.equal(PAUSED_STATE, '⏸ PAUSED');
  assert.ok(SAMPLE.includes(`| ${PAUSED_STATE} |`));
});

test('planIdOfRowSlug is the exact inverse of planIdRowMatcher (plan 2932)', () => {
  assert.equal(planIdOfRowSlug('2932-Coord-in-progress-plan-roster-board'), '2932');
  assert.equal(planIdOfRowSlug('2932'), '2932', 'a bare id row');
  assert.equal(planIdOfRowSlug('batch-2026-08-06-sonnet-smalls'), null);
  assert.equal(planIdOfRowSlug(''), null);
  assert.equal(planIdOfRowSlug(null), null);
  // The id BOUNDARY: `2932-1` is not plan 2932 (the matcher's `(?=\D)` lookahead), and a
  // longer id is never a prefix match of a shorter one.
  assert.equal(planIdOfRowSlug('2932-1-something'), null);
  assert.equal(planIdOfRowSlug('29321-Coord-x'), '29321');
  // Cross-check against the matcher itself, through its public projection.
  const lines = [
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume condition |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 2932-Coord-x | `a` | 🔄 ACTIVE | `in-progress/2932-Coord-x.md` | 2026-08-06 19:01 | — |',
    '| 29321-Coord-y | `b` | 🔄 ACTIVE | `in-progress/29321-Coord-y.md` | 2026-08-06 19:01 | — |',
  ];
  assert.deepEqual(rowSlugsForPlanIdLines(lines, '2932'), ['2932-Coord-x']);
  assert.deepEqual(rowSlugsForPlanIdLines(lines, '29321'), ['29321-Coord-y']);
});

test('batchSlugOfCell: reads the marker VALUE the /in-progress queue join needs (plan 2932)', () => {
  assert.equal(
    batchSlugOfCell(
      '`in-progress/2394-Coord-x.md` · session 2 · host=`H` · 🟩 · batch=`batch-2026-07-25-coord`',
    ),
    'batch-2026-07-25-coord',
  );
  // Unquoted form, and neither trailing whitespace nor the table pipe may be swallowed in.
  assert.equal(batchSlugOfCell('· batch=batch-2026-08-06-smalls '), 'batch-2026-08-06-smalls');
  assert.equal(batchSlugOfCell('· batch=batch-x |'), 'batch-x');
  // Agrees with the predicate in both directions — one grammar, two readers.
  const none = '`in-progress/1364-Coord-batch-claim.md` · session 1 · host=`H` · 🟩';
  assert.equal(batchSlugOfCell(none), null);
  assert.equal(isBatchMemberCell(none), false);
  assert.equal(batchSlugOfCell(null), null);
});

// ── plan 3443: landingRowReapVerdict — the stale-🟢-LANDING-row reaper's pure verdict ──

const REAP_STAMP = '2026-08-25T10:00:00.000Z';
const REAP_NOW_ANCIENT = Date.parse('2026-08-25T20:00:00.000Z'); // 600m later — very stale

test('DEFAULT_LANDING_REAP_STALE_MIN matches landing-queue.mjs steal --confirm-holder-gone default (45)', () => {
  assert.equal(DEFAULT_LANDING_REAP_STALE_MIN, 45);
});

test('landingRowReapVerdict: stale=true when all three conditions hold', () => {
  const v = landingRowReapVerdict({
    landingIso: REAP_STAMP,
    nowMs: REAP_NOW_ANCIENT,
    queueEntryPresent: false,
    queueHeartbeatFresh: null,
    branchProgressed: false,
  });
  assert.equal(v.stale, true);
  assert.match(v.reason, /stale 🟢 LANDING row/);
});

test('landingRowReapVerdict: stale=true when the queue entry is present but its heartbeat is stale', () => {
  const v = landingRowReapVerdict({
    landingIso: REAP_STAMP,
    nowMs: REAP_NOW_ANCIENT,
    queueEntryPresent: true,
    queueHeartbeatFresh: false,
    branchProgressed: false,
  });
  assert.equal(v.stale, true);
});

test('landingRowReapVerdict: NEVER stale when queueHeartbeatFresh === true — the live-slow-land pin — even with an ancient stamp and no branch progress', () => {
  const v = landingRowReapVerdict({
    landingIso: REAP_STAMP,
    nowMs: REAP_NOW_ANCIENT,
    queueEntryPresent: true,
    queueHeartbeatFresh: true,
    branchProgressed: false,
  });
  assert.equal(v.stale, false);
  assert.match(v.reason, /FRESH/);
});

test('landingRowReapVerdict: NEVER stale when the landing@ stamp is absent', () => {
  const v = landingRowReapVerdict({
    landingIso: null,
    nowMs: REAP_NOW_ANCIENT,
    queueEntryPresent: false,
    queueHeartbeatFresh: null,
    branchProgressed: false,
  });
  assert.equal(v.stale, false);
  assert.match(v.reason, /cannot prove staleness/);
});

test('landingRowReapVerdict: NEVER stale when the landing@ stamp is unparseable', () => {
  const v = landingRowReapVerdict({
    landingIso: 'not-a-real-timestamp',
    nowMs: REAP_NOW_ANCIENT,
    queueEntryPresent: false,
    queueHeartbeatFresh: null,
    branchProgressed: false,
  });
  assert.equal(v.stale, false);
  assert.match(v.reason, /cannot prove staleness/);
});

test('landingRowReapVerdict: NEVER stale when the stamp is younger than staleMin', () => {
  const v = landingRowReapVerdict({
    landingIso: REAP_STAMP,
    nowMs: Date.parse('2026-08-25T10:10:00.000Z'), // 10m later, well under the 45m default
    queueEntryPresent: false,
    queueHeartbeatFresh: null,
    branchProgressed: false,
  });
  assert.equal(v.stale, false);
});

test('landingRowReapVerdict: NEVER stale when branchProgressed === true', () => {
  const v = landingRowReapVerdict({
    landingIso: REAP_STAMP,
    nowMs: REAP_NOW_ANCIENT,
    queueEntryPresent: false,
    queueHeartbeatFresh: null,
    branchProgressed: true,
  });
  assert.equal(v.stale, false);
  assert.match(v.reason, /new commits/);
});

test('landingRowReapVerdict: NEVER stale on a null queueEntryPresent (queue state unreadable)', () => {
  const v = landingRowReapVerdict({
    landingIso: REAP_STAMP,
    nowMs: REAP_NOW_ANCIENT,
    queueEntryPresent: null,
    queueHeartbeatFresh: null,
    branchProgressed: false,
  });
  assert.equal(v.stale, false);
  assert.match(v.reason, /queue state unreadable/);
});

test('landingRowReapVerdict: NEVER stale on a null queueHeartbeatFresh while an entry is present', () => {
  const v = landingRowReapVerdict({
    landingIso: REAP_STAMP,
    nowMs: REAP_NOW_ANCIENT,
    queueEntryPresent: true,
    queueHeartbeatFresh: null,
    branchProgressed: false,
  });
  assert.equal(v.stale, false);
  assert.match(v.reason, /heartbeat freshness unknown/);
});

test('landingRowReapVerdict: NEVER stale on a null branchProgressed (branch state unreadable)', () => {
  const v = landingRowReapVerdict({
    landingIso: REAP_STAMP,
    nowMs: REAP_NOW_ANCIENT,
    queueEntryPresent: false,
    queueHeartbeatFresh: null,
    branchProgressed: null,
  });
  assert.equal(v.stale, false);
  assert.match(v.reason, /branch state unreadable/);
});

test('landingRowReapVerdict: staleMin boundary — exactly staleMin minutes old is NOT stale, one minute past IS', () => {
  const exactly = landingRowReapVerdict({
    landingIso: REAP_STAMP,
    nowMs: Date.parse(REAP_STAMP) + 45 * 60000, // exactly 45m — the default staleMin
    queueEntryPresent: false,
    queueHeartbeatFresh: null,
    branchProgressed: false,
  });
  assert.equal(exactly.stale, false);

  const onePast = landingRowReapVerdict({
    landingIso: REAP_STAMP,
    nowMs: Date.parse(REAP_STAMP) + 46 * 60000, // 46m — one minute past the default staleMin
    queueEntryPresent: false,
    queueHeartbeatFresh: null,
    branchProgressed: false,
  });
  assert.equal(onePast.stale, true);
});

test('landingRowReapVerdict: staleMin is overridable and the boundary moves with it', () => {
  const custom = landingRowReapVerdict({
    landingIso: REAP_STAMP,
    nowMs: Date.parse(REAP_STAMP) + 10 * 60000,
    queueEntryPresent: false,
    queueHeartbeatFresh: null,
    branchProgressed: false,
    staleMin: 5,
  });
  assert.equal(custom.stale, true, '10m old with staleMin:5 is past threshold');
});
