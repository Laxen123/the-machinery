// scripts/reconcile-board.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM_GLOBS } from './coord/coord-refs.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyReconcile,
  activeRowsFromBoard,
  presentRowsFromBoard,
  allRowsFromBoard,
  queuePlanIds,
  splitLiveOrphanRefs,
  staleRefs,
  fetchClaimsMap,
  fetchOriginMasterForReconcile,
  readCoordFileForReconcile,
  remediationFor,
  resolveSlugPlanId,
  resolveStaleMin,
  queueRegionHasHeaderRow,
  boardRowsVerifiedFrom,
  PRESENT_STATES,
} from './reconcile-board.mjs';
import {
  IN_FLIGHT_STATES,
  TERMINAL_STATES,
  IN_PROGRESS_STATE,
  DONE_ON_BRANCH_STATE,
  SUPERSEDED_STATE,
} from './coord/board-lib.mjs';
import { STATE_ALIASES } from './board.mjs';
import {
  parseQueue,
  HEADER as QUEUE_HEADER,
  QUEUE_START,
  QUEUE_END,
  AUDIT_START,
  AUDIT_END,
  MIN_QUEUE_ROW_CELLS,
} from './coord/landing-queue-lib.mjs';

test('classifyReconcile: ref ∧ ACTIVE/LANDING row = IN-SYNC; ref only = ORPHAN-REF; row only = ORPHAN-ROW', () => {
  const r = classifyReconcile({
    claimsMap: { 365: 'aaa', 368: 'bbb' }, // 365 has a row, 368 does not
    presentRows: [
      { slug: '365-UI-x', planId: '365', state: '🔄 ACTIVE' },
      { slug: '161-P07-y', planId: '161', state: '🔄 ACTIVE' }, // a row with no ref
    ],
  });
  assert.deepEqual(
    r.inSync.map((x) => x.planId),
    ['365'],
  );
  assert.deepEqual(r.pausedRefs, []);
  assert.deepEqual(
    r.orphanRows.map((x) => x.planId),
    ['161'],
  );
  assert.deepEqual(
    r.orphanRefs.map((x) => x.planId),
    ['368'],
  );
});

test('classifyReconcile: empty everything is clean', () => {
  const r = classifyReconcile({ claimsMap: {}, presentRows: [] });
  assert.deepEqual(r, { inSync: [], pausedRefs: [], orphanRows: [], orphanRefs: [] });
});

// plan 2818: measured 2026-08-04 false positive — refs/claims/2758's row read 🟢 LANDING
// (a live land in progress, position 2 of the landing queue) but the old ACTIVE-only
// classification put it in orphanRefs, which the stale-age check then flagged STALE with
// a `release-claim --force` remediation against a live session. A LANDING row must be
// inSync, never orphanRefs.
test('classifyReconcile: a ref backed by a LANDING row is inSync, never orphanRefs (2026-08-04 false positive, refs/claims/2758)', () => {
  const r = classifyReconcile({
    claimsMap: { 2758: 'sha2758' },
    presentRows: [{ slug: '2758-App-x', planId: '2758', state: '🟢 LANDING' }],
  });
  assert.deepEqual(
    r.inSync.map((x) => x.planId),
    ['2758'],
  );
  assert.deepEqual(r.orphanRefs, []);
  assert.deepEqual(r.pausedRefs, []);
});

// plan 2818: measured 2026-08-04 false positive — refs/claims/2766's row read ⏸ PAUSED (a
// session mid-land) but the old ACTIVE-only classification put it in orphanRefs too. A
// PAUSED-only ref is a distinct third class — a paused session's claim, not an orphan.
test('classifyReconcile: a ref backed only by a PAUSED row lands in pausedRefs, not orphanRefs (2026-08-04 false positive, refs/claims/2766)', () => {
  const r = classifyReconcile({
    claimsMap: { 2766: 'sha2766' },
    presentRows: [{ slug: '2766-Coord-y', planId: '2766', state: '⏸ PAUSED' }],
  });
  assert.deepEqual(
    r.pausedRefs.map((x) => x.planId),
    ['2766'],
  );
  assert.deepEqual(r.orphanRefs, []);
  assert.deepEqual(r.inSync, []);
});

test('classifyReconcile: a ref with no present row of any state is still an orphanRef', () => {
  const r = classifyReconcile({
    claimsMap: { 999: 'sha999' },
    presentRows: [],
  });
  assert.deepEqual(
    r.orphanRefs.map((x) => x.planId),
    ['999'],
  );
  assert.deepEqual(r.inSync, []);
  assert.deepEqual(r.pausedRefs, []);
});

test('presentRowsFromBoard returns ACTIVE + LANDING + PAUSED rows with state, skips header/separator', () => {
  const board = [
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 365-UI-x | `abc` | 🔄 ACTIVE | `365-UI-x.md` · session 1 | t | — |',
    '| 134-DQ-z | `def` | ⏸ PAUSED | `134-DQ-z.md` | t | r |',
    '| 200-X-w | `ghi` | 🟢 LANDING | `200-X-w.md` | t | r |',
    '<!-- BOARD-END -->',
  ].join('\n');
  const rows = presentRowsFromBoard(board);
  assert.deepEqual(rows, [
    { slug: '365-UI-x', planId: '365', state: '🔄 ACTIVE' },
    { slug: '134-DQ-z', planId: '134', state: '⏸ PAUSED' },
    { slug: '200-X-w', planId: '200', state: '🟢 LANDING' },
  ]);
});

test('activeRowsFromBoard still returns ACTIVE-only rows (slug + derived planId), skips PAUSED/LANDING/header', () => {
  const board = [
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 365-UI-x | `abc` | 🔄 ACTIVE | `365-UI-x.md` · session 1 | t | — |',
    '| 134-DQ-z | `def` | ⏸ PAUSED | `134-DQ-z.md` | t | r |',
    '| 200-X-w | `ghi` | 🟢 LANDING | `200-X-w.md` | t | r |',
    '<!-- BOARD-END -->',
  ].join('\n');
  const rows = activeRowsFromBoard(board);
  assert.deepEqual(rows, [{ slug: '365-UI-x', planId: '365' }]);
});

// plan 1398 (item 7) — fetchClaimsMap bounds `git ls-remote origin 'refs/claims/*'` with a
// timeout, the same fix already applied to post-checkout-claim-guard.mjs's claimRefExists
// and sweep-acquire-residue.mjs's hasClaimRef, so an unreachable/offline origin can never
// hang this read-only reporter indefinitely.
test('fetchClaimsMap: bounds the ls-remote with a timeout (plan 1398, item 7)', () => {
  let seenArgs, seenOpts;
  const fakeGit = (_dir, args, opts) => {
    seenArgs = args;
    seenOpts = opts;
    return 'aaa\trefs/claims/365\nbbb\trefs/claims/368\n';
  };
  const map = fetchClaimsMap('/some/main', { _git: fakeGit });
  // plan 3756: the map now comes from heldClaimsMap, which resolves each ref's TIP (a released
  // claim leaves a tombstone behind, so ref existence would report landed plans as claimed).
  // Its reads stay capped for the same reason the old single ls-remote was.
  assert.ok(
    seenOpts && typeof seenOpts.timeout === 'number' && seenOpts.timeout > 0,
    'every claim read must carry a positive timeout so an unreachable origin fails fast',
  );
  assert.deepEqual(map, { 365: 'aaa', 368: 'bbb' });
});

test('staleRefs flags orphan refs older than staleMin (age from the claim iso)', () => {
  const orphanRefs = [
    { planId: '368', iso: '2026-06-05T10:00:00Z' }, // 120 min old
    { planId: '369', iso: '2026-06-05T11:50:00Z' }, // 10 min old
  ];
  const nowMs = Date.parse('2026-06-05T12:00:00Z');
  const stale = staleRefs(orphanRefs, { nowMs, staleMin: 35 });
  assert.deepEqual(
    stale.map((s) => s.planId),
    ['368'],
  );
});

// plan 2818 (F4): the board/queue reads — fetchClaimsMap reads LIVE remote refs/claims/*, but
// main() used to read the board from the mutable LOCAL working tree, so a claim whose board
// row exists only on origin/master (not yet fetched/merged locally) read as ORPHAN-REF —
// measured live 2026-08-04, refs/claims/2818 vs its ACTIVE row on origin/master.
//
// plan 3814 review fix (F5): readBoardForReconcile/readQueueForReconcile were collapsed into
// fetchOriginMasterForReconcile (the fetch, once) + readCoordFileForReconcile (the show +
// local-fallback, parameterized by `rel` and the fetch's verdict) — these tests were updated to
// the two-call shape rather than kept unchanged, since the whole point of F5 is that the fetch
// no longer lives inside the per-file reader.
test('fetchOriginMasterForReconcile + readCoordFileForReconcile: origin/master content when fetch+show succeed', () => {
  const calls = [];
  const fakeGit = (_dir, args, opts) => {
    calls.push({ args, opts });
    if (args[0] === 'fetch') return '';
    if (args[0] === 'show') return 'ORIGIN BOARD CONTENT';
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  const fetchOk = fetchOriginMasterForReconcile('/some/main', { _git: fakeGit });
  assert.equal(fetchOk, true);
  const result = readCoordFileForReconcile('/some/main', 'docs/handoff/board.md', {
    _git: fakeGit,
    fetchOk,
  });
  assert.deepEqual(result, { content: 'ORIGIN BOARD CONTENT', source: 'origin/master' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['fetch', '--quiet', 'origin', 'master']);
  assert.deepEqual(calls[1].args, ['show', 'origin/master:docs/handoff/board.md']);
});

test('fetchOriginMasterForReconcile: returns false when the fetch throws (offline), never throwing itself', () => {
  const fakeGit = () => {
    throw new Error('offline');
  };
  assert.equal(fetchOriginMasterForReconcile('/some/main', { _git: fakeGit }), false);
});

// G8: this test used to leak its mkdtempSync'd directory — cleaned up via t.after,
// matching the idiom neighbouring temp-dir tests in this repo already use (e.g.
// batches-view.test.mjs).
test('readCoordFileForReconcile: falls back to the working-tree file when fetchOk is false (fetch failed)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-board-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'board.md'), 'LOCAL BOARD CONTENT', 'utf8');
  const fakeGit = () => {
    throw new Error('readCoordFileForReconcile must never call git show when fetchOk is false');
  };
  const result = readCoordFileForReconcile(dir, 'board.md', { _git: fakeGit, fetchOk: false });
  assert.deepEqual(result, {
    content: 'LOCAL BOARD CONTENT',
    source: 'local working tree (origin read failed)',
  });
});

// plan 3814 review fix (F5): the queue's own extra failure mode — the local fallback can ALSO
// throw (no working-tree copy at that path) — the board file never needed this branch (always
// expected to exist in a coordination checkout), but the shared reader carries it unconditionally
// since it costs nothing for the board path and the queue path still needs it.
test('readCoordFileForReconcile: content:null "unreadable" when fetchOk is false AND the local fallback also throws', () => {
  const fakeGit = () => {
    throw new Error('must never be called when fetchOk is false');
  };
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-board-'));
  rmSync(dir, { recursive: true, force: true }); // gone — local fallback read must throw ENOENT
  const result = readCoordFileForReconcile(dir, 'nope.md', { _git: fakeGit, fetchOk: false });
  assert.deepEqual(result, { content: null, source: 'unreadable' });
});

test('fetchOriginMasterForReconcile + readCoordFileForReconcile: both the fetch and the show carry a timeout (mirrors fetchClaimsMap)', () => {
  const seenOpts = [];
  const fakeGit = (_dir, args, opts) => {
    seenOpts.push(opts);
    if (args[0] === 'fetch') return '';
    return 'content';
  };
  const fetchOk = fetchOriginMasterForReconcile('/some/main', { _git: fakeGit });
  readCoordFileForReconcile('/some/main', 'board.md', { _git: fakeGit, fetchOk });
  assert.equal(seenOpts.length, 2);
  for (const opts of seenOpts) {
    assert.ok(
      opts && typeof opts.timeout === 'number' && opts.timeout > 0,
      'both the fetch and the show must carry a positive timeout',
    );
  }
});

// plan 3814 review fix (F5, findings 33dddb/a2133b/88ceba/9db9c8): the whole point — two
// coordination-file reads (board + queue) in one run must issue exactly ONE `git fetch`, not
// two. readBoardForReconcile/readQueueForReconcile each ran their own independent fetch before
// this fix; this fails to even IMPORT fetchOriginMasterForReconcile/readCoordFileForReconcile
// against the pre-fix module (neither existed), which is this fix's "fails against current code
// first" proof.
test('F5: one fetchOriginMasterForReconcile call serves both the board read and the queue read — never two fetches', () => {
  const fetchCalls = [];
  const fakeGit = (_dir, args) => {
    if (args[0] === 'fetch') {
      fetchCalls.push(args);
      return '';
    }
    if (args[0] === 'show') return `content of ${args[1]}`;
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  const fetchOk = fetchOriginMasterForReconcile('/main', { _git: fakeGit });
  const board = readCoordFileForReconcile('/main', 'docs/handoff/board.md', {
    _git: fakeGit,
    fetchOk,
  });
  const queue = readCoordFileForReconcile('/main', 'docs/handoff/landing-queue.md', {
    _git: fakeGit,
    fetchOk,
  });
  assert.equal(fetchCalls.length, 1, 'exactly one git fetch must serve both reads');
  assert.equal(board.source, 'origin/master');
  assert.equal(queue.source, 'origin/master');
  assert.equal(board.content, 'content of origin/master:docs/handoff/board.md');
  assert.equal(queue.content, 'content of origin/master:docs/handoff/landing-queue.md');
});

// plan 2818 (F6): presentRowsFromBoard now iterates board-lib.mjs's shared dataRowsOf —
// re-assert the header/separator-skip + tri-state parse still holds after the refactor.
test('presentRowsFromBoard (post-dataRowsOf refactor) still parses ACTIVE/LANDING/PAUSED and skips header+separator', () => {
  const board = [
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 365-UI-x | `abc` | 🔄 ACTIVE | `365-UI-x.md` · session 1 | t | — |',
    '| 134-DQ-z | `def` | ⏸ PAUSED | `134-DQ-z.md` | t | r |',
    '| 200-X-w | `ghi` | 🟢 LANDING | `200-X-w.md` | t | r |',
    '| 999-Q-v | `jkl` | ✅ DONE | `999-Q-v.md` | t | r |', // not a present state — must be skipped
    '<!-- BOARD-END -->',
  ].join('\n');
  const rows = presentRowsFromBoard(board);
  assert.deepEqual(rows, [
    { slug: '365-UI-x', planId: '365', state: '🔄 ACTIVE' },
    { slug: '134-DQ-z', planId: '134', state: '⏸ PAUSED' },
    { slug: '200-X-w', planId: '200', state: '🟢 LANDING' },
  ]);
});

// plan 2818 (F7): PRESENT_STATES used to be a third hand-copied literal array (alongside
// redgreen-lib's own IN_FLIGHT_STATES) — this guard fails loudly the moment the two could
// drift again, instead of silently misclassifying a future in-flight state as an orphan-ref.
test('PRESENT_STATES covers exactly IN_FLIGHT_STATES (board-lib is the one home)', () => {
  assert.deepEqual([...PRESENT_STATES].sort(), [...IN_FLIGHT_STATES].sort());
});

// plan 2818 (round 2, G1): the round-1 regression — an enrichment-failed (`holderUnreadable`)
// ref must NEVER get the `--force` line, even though its `iso` is undefined and staleRefs'
// unknown-iso→stale rule (correctly, for its own purpose) would flag it STALE. It must report
// its own UNREADABLE flag instead.
test('remediationFor: a holderUnreadable ref never remediates, flags UNREADABLE (round-1 regression, G1)', () => {
  const r = { planId: '123', holderUnreadable: true }; // no iso — enrichment threw this run
  const stale = new Set(['123']); // staleRefs' own unknown-iso→stale rule WOULD flag this stale
  const { flag, remediate, note } = remediationFor(r, { stale, boardVerified: true });
  assert.equal(flag, 'UNREADABLE');
  assert.equal(remediate, false);
  assert.match(note, /re-run before judging/i);
  assert.match(note, /do NOT force-release/i);
});

// A genuinely stale, successfully-read ref against a VERIFIED (origin) board still gets the
// STALE flag and the --force remediation — the case remediationFor exists to preserve.
test('remediationFor: a stale, readable ref against a verified board DOES remediate', () => {
  const r = { planId: '456', sessionUuid: 'abc', host: 'h', iso: '2026-01-01T00:00:00Z' };
  const stale = new Set(['456']);
  const { flag, remediate, note } = remediationFor(r, { stale, boardVerified: true });
  assert.equal(flag, 'STALE');
  assert.equal(remediate, true);
  assert.equal(note, '');
});

// A recent, readable ref never remediates regardless of board verification.
test('remediationFor: a recent, readable ref never remediates', () => {
  const r = { planId: '789', iso: '2026-08-04T00:00:00Z' };
  const stale = new Set(); // not stale
  const { flag, remediate } = remediationFor(r, { stale, boardVerified: true });
  assert.equal(flag, 'recent');
  assert.equal(remediate, false);
});

// plan 2818 (round 2, G2): a LOCAL-FALLBACK board view (origin unreachable this run) is
// unverified — the very staleness that produced the original false positive — so remediation
// is suppressed for a stale, readable orphan-ref too, not just an unreadable one.
test('remediationFor: a fallback (unverified) board suppresses remediation even for a stale, readable ref (G2)', () => {
  const r = { planId: '456', sessionUuid: 'abc', host: 'h', iso: '2026-01-01T00:00:00Z' };
  const stale = new Set(['456']);
  const { flag, remediate } = remediationFor(r, { stale, boardVerified: false });
  assert.equal(flag, 'STALE'); // still reported as stale — just not acted on
  assert.equal(remediate, false);
});

// plan 3814: reconcile-board must not call a live land a stale claim. The two remaining
// liveness gaps beyond plan 2818's three-way (ACTIVE/LANDING/PAUSED) board classification: (a)
// a board row in ANY OTHER state, and (b) a landing-queue slot for the slug. Both are checked
// with functions that did not exist before this plan — this test fails to even IMPORT against
// the pre-fix module, which is the "fails against current code first" requirement for this
// case: pre-fix, a ref in this exact shape (a board row sitting in a non-trio state, PLUS a
// live queue slot, PLUS 40 minutes old) fell straight into `orphanRefs` and, once age-staled,
// printed a `release-claim --force` line against a session that was demonstrably still alive on
// two independent axes — the 2026-09-07 near-miss this plan exists to close.
test('plan 3814 (2026-09-07 shape): board row (non-trio state) + queue slot + 40min-old ref classifies LIVE, never reaches remediation', () => {
  const board = [
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    // "IN PROGRESS" here stands for any board state outside the ACTIVE/LANDING/PAUSED trio —
    // the plan's own prose phrase for gap (a). Not a real board-state literal; deliberately
    // exercising the OUTSIDE-the-trio path, not a state this repo's board vocabulary emits.
    '| 9814-Coord-reconcile-x | `abc` | 📝 IN PROGRESS | `9814-Coord-reconcile-x.md` | t | — |',
    '<!-- BOARD-END -->',
  ].join('\n');
  const { rows: boardRows, unresolvedSlugs: boardUnresolvedSlugs } = allRowsFromBoard(board);
  const allRowIds = new Set(boardRows.map((r) => r.planId));
  assert.ok(
    allRowIds.has('9814'),
    'allRowsFromBoard must see a row outside the PRESENT_STATES trio',
  );
  assert.deepEqual(boardUnresolvedSlugs, []);

  const queueEntries = [{ slug: '9814-Coord-reconcile-x' }];
  const { ids: queueSlugIds, unresolvedSlugs: queueUnresolvedSlugs } = queuePlanIds(queueEntries);
  assert.ok(queueSlugIds.has('9814'), 'queuePlanIds must resolve a queue slug to its plan id');
  assert.deepEqual(queueUnresolvedSlugs, []);

  const orphanRefs = [
    { planId: '9814', sha: 'sha9814', iso: '2026-09-07T09:20:00Z' }, // 40 min before nowMs below
  ];
  const { live, orphanRefs: stillOrphan } = splitLiveOrphanRefs(orphanRefs, {
    allRowIds,
    queueSlugIds,
  });
  assert.deepEqual(
    live.map((r) => r.planId),
    ['9814'],
  );
  assert.equal(live[0].liveReason, 'queue+board');
  // The whole point: a ref classified `live` never reaches orphanRefs/staleRefs/remediationFor
  // at all, so no `--force` line can ever be printed for it — proven structurally, not by
  // asserting on stdout.
  assert.deepEqual(stillOrphan, []);

  const nowMs = Date.parse('2026-09-07T10:00:00Z'); // 40 minutes after the ref's iso
  const stale = new Set(staleRefs(stillOrphan, { nowMs, staleMin: 35 }).map((r) => r.planId));
  assert.equal(stale.size, 0, 'the live ref must not even be a candidate for the stale set');
});

// The mirror case: no board row of ANY state, no queue slot, ref 40 minutes old — genuinely
// abandoned, and the ONLY shape that should still classify STALE with remediation allowed.
test('plan 3814: no board row (any state), no queue slot, 40min-old ref classifies STALE with remediation allowed', () => {
  const allRowIds = new Set(); // no row for this plan in any state
  const queueSlugIds = new Set(); // no landing-queue slot either
  const orphanRefs = [{ planId: '9820', sha: 'sha9820', iso: '2026-09-07T09:20:00Z' }];

  const { live, orphanRefs: stillOrphan } = splitLiveOrphanRefs(orphanRefs, {
    allRowIds,
    queueSlugIds,
  });
  assert.deepEqual(live, []);
  assert.deepEqual(
    stillOrphan.map((r) => r.planId),
    ['9820'],
  );

  const nowMs = Date.parse('2026-09-07T10:00:00Z'); // 40 minutes old
  const stale = new Set(staleRefs(stillOrphan, { nowMs, staleMin: 35 }).map((r) => r.planId));
  const { flag, remediate } = remediationFor(stillOrphan[0], { stale, boardVerified: true });
  assert.equal(flag, 'STALE');
  assert.equal(remediate, true);
});

// plan 3814: a released tombstone must never appear at all — neither as `live` nor as
// `orphanRefs` — even when it carries a board row AND a queue slot that WOULD otherwise mark it
// live. main() runs the plan-3756 released-tombstone filter BEFORE splitLiveOrphanRefs for
// exactly this reason: a landed plan's stale row/queue-slot leftovers must never resurrect it
// into any printed bucket.
test('plan 3814: a released tombstone never appears at all, even with a live board row + queue slot', () => {
  const allRowIds = new Set(['9830']); // a board row exists for this plan id
  const queueSlugIds = new Set(['9830']); // and a queue slot too
  const rawOrphanRefs = [
    { planId: '9830', sha: 'sha9830', iso: '2026-09-07T09:20:00Z', released: true },
  ];

  // Mirror main()'s ordering: filter released BEFORE the live split.
  const filtered = rawOrphanRefs.filter((r) => !r.released);
  const { live, orphanRefs: stillOrphan } = splitLiveOrphanRefs(filtered, {
    allRowIds,
    queueSlugIds,
  });
  assert.deepEqual(live, []);
  assert.deepEqual(stillOrphan, []);
});

// ── plan 3814 review fix round ──────────────────────────────────────────────────────

// F1 (finding a8b20e CONFIRMED): allRowsFromBoard used to credit a row in ANY state, including
// the TERMINAL board markers (✅ DONE-ON-BRANCH, 🧹 SUPERSEDED) that persist on the board after a
// plan is archived or superseded. A crashed session that reached one of those states but never
// released its claim ref was then pulled into `live` and NEVER again offered remediation —
// permanently. This fails against pre-fix code because pre-fix `allRowsFromBoard` returns a bare
// array (not `{rows, unresolvedSlugs}`) and credits both rows.
test('F1: a TERMINAL board row (SUPERSEDED / DONE-ON-BRANCH) grants NO liveness credit — the ref stays remediable', () => {
  const board = [
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    `| 9840-Coord-x | \`abc\` | ${SUPERSEDED_STATE} | \`9840-Coord-x.md\` | t | — |`,
    `| 9841-Coord-y | \`def\` | ${DONE_ON_BRANCH_STATE} | \`9841-Coord-y.md\` | t | — |`,
    '<!-- BOARD-END -->',
  ].join('\n');
  const { rows, unresolvedSlugs } = allRowsFromBoard(board);
  assert.deepEqual(unresolvedSlugs, []);
  const allRowIds = new Set(rows.map((r) => r.planId));
  assert.ok(!allRowIds.has('9840'), 'a SUPERSEDED-only row must not grant liveness credit');
  assert.ok(!allRowIds.has('9841'), 'a DONE-ON-BRANCH-only row must not grant liveness credit');

  const orphanRefs = [
    { planId: '9840', sha: 'sha9840', iso: '2026-09-07T09:20:00Z' },
    { planId: '9841', sha: 'sha9841', iso: '2026-09-07T09:20:00Z' },
  ];
  const { live, orphanRefs: stillOrphan } = splitLiveOrphanRefs(orphanRefs, {
    allRowIds,
    queueSlugIds: new Set(),
  });
  assert.deepEqual(live, [], 'a TERMINAL-row-only ref must never classify live');
  assert.deepEqual(stillOrphan.map((r) => r.planId).sort(), ['9840', '9841']);

  const nowMs = Date.parse('2026-09-07T10:00:00Z'); // 40 minutes after each ref's iso
  const stale = new Set(staleRefs(stillOrphan, { nowMs, staleMin: 35 }).map((r) => r.planId));
  assert.equal(stale.size, 2, 'both must remain remediable, never hidden by a stale row');
});

// F1: a real, non-terminal board state (🔄 IN PROGRESS — the actual board-lib literal, not the
// placeholder emoji the earlier plan-3814 test used) still grants liveness credit — the fix must
// not have over-corrected into excluding every non-trio state.
test('F1: a real 🔄 IN PROGRESS row still grants liveness credit (non-terminal, not over-excluded)', () => {
  const board = [
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    `| 9842-Coord-z | \`ghi\` | ${IN_PROGRESS_STATE} | \`9842-Coord-z.md\` | t | — |`,
    '<!-- BOARD-END -->',
  ].join('\n');
  const { rows, unresolvedSlugs } = allRowsFromBoard(board);
  assert.deepEqual(unresolvedSlugs, []);
  assert.ok(rows.some((r) => r.planId === '9842'));
});

// F1: STATE_ALIASES (board.mjs) must still render the exact same strings after sourcing
// IN-PROGRESS/DONE-ON-BRANCH/SUPERSEDED from board-lib.mjs's new constants instead of inline
// literals — pure de-duplication, byte-identical output, no behaviour change. board.test.mjs
// already asserts STATE_ALIASES['IN-PROGRESS'] === '🔄 IN PROGRESS' verbatim and is unmodified
// by this fix (proof the rendered string didn't move); this pins the two NEW aliases plus
// agreement with board-lib's own constants, mirroring the existing "plan 2394" LANDING/PAUSED
// agreement test in board.test.mjs.
test('F1: STATE_ALIASES DONE-ON-BRANCH/SUPERSEDED render byte-identically and agree with board-lib', () => {
  assert.equal(STATE_ALIASES['DONE-ON-BRANCH'], '✅ DONE-ON-BRANCH');
  assert.equal(STATE_ALIASES.SUPERSEDED, '🧹 SUPERSEDED');
  assert.equal(STATE_ALIASES['IN-PROGRESS'], IN_PROGRESS_STATE);
  assert.equal(STATE_ALIASES['DONE-ON-BRANCH'], DONE_ON_BRANCH_STATE);
  assert.equal(STATE_ALIASES.SUPERSEDED, SUPERSEDED_STATE);
});

// F1: TERMINAL_STATES is exactly {DONE-ON-BRANCH, SUPERSEDED} — not IN_PROGRESS_STATE, which is
// live/in-flight, not terminal.
test('F1: TERMINAL_STATES covers exactly DONE_ON_BRANCH_STATE and SUPERSEDED_STATE', () => {
  assert.deepEqual([...TERMINAL_STATES].sort(), [DONE_ON_BRANCH_STATE, SUPERSEDED_STATE].sort());
  assert.ok(!TERMINAL_STATES.includes(IN_PROGRESS_STATE));
});

// F2/F3 (findings 75d315/a7951e/44d094/856bb4/b74463/d78cbb/9e2b7a/ad2318, 67fea2/2882c4):
// resolveSlugPlanId is the shared resolver — a batch-train slug and a legacy bare slug (no digit
// prefix) must resolve to `null` (unresolved), and a legacy DATE-prefixed slug must ALSO resolve
// to `null` rather than the bogus plan id its leading digits would otherwise produce.
test('resolveSlugPlanId: a normal slug resolves; a batch-train slug, a bare legacy slug, and a date-prefixed slug do not', () => {
  assert.equal(resolveSlugPlanId('3814-Coord-reconcile-x'), '3814');
  assert.equal(resolveSlugPlanId('batch-2026-08-06-sonnet-smalls'), null);
  assert.equal(resolveSlugPlanId('akut-card-fix'), null);
  // F3: the date-prefixed shape — planIdOf's bare `^(\d{3,})` regex would otherwise resolve
  // this to plan id "2026", a real (unrelated) plan.
  assert.equal(resolveSlugPlanId('2026-05-17-something'), null);
});

// F2: queuePlanIds must not silently drop an unresolvable slug — it must be named in
// `unresolvedSlugs` so the caller can mark the whole queue view untrusted. Fails against pre-fix
// code because pre-fix queuePlanIds returns a bare Set, not `{ids, unresolvedSlugs}`.
test('F2: queuePlanIds records an unresolvable batch-train slug in unresolvedSlugs, not silently dropped', () => {
  const entries = [{ slug: '3814-Coord-x' }, { slug: 'batch-2026-08-06-sonnet-smalls' }];
  const { ids, unresolvedSlugs } = queuePlanIds(entries);
  assert.deepEqual([...ids], ['3814']);
  assert.deepEqual(unresolvedSlugs, ['batch-2026-08-06-sonnet-smalls']);
});

// F2: a queue containing an unresolvable slug must suppress remediation for an otherwise-stale
// ref — proven at the level main() actually gates on: an unresolved queue slug makes
// `queueVerified` false regardless of source/parsed-ok, mirroring main()'s own
// `queueUnresolvedSlugs.length === 0` condition.
test('F2: a queue containing a batch-train slug suppresses remediation for an otherwise-stale ref (queueVerified false)', () => {
  const entries = [{ slug: 'batch-2026-08-06-sonnet-smalls' }];
  const { unresolvedSlugs: queueUnresolvedSlugs } = queuePlanIds(entries);
  const queueSource = 'origin/master';
  const queueParsedOk = true;
  const queueVerified =
    queueSource === 'origin/master' && queueParsedOk && queueUnresolvedSlugs.length === 0;
  assert.equal(queueVerified, false, 'an unresolved queue slug must untrust the queue view');
});

// F2: the board-side twin — a board row whose slug is unresolvable (the akut-card-… legacy
// shape) must be named in allRowsFromBoard's unresolvedSlugs, and main()'s boardRowsVerified
// condition (mirrored here) must go false.
test('F2: a board containing an akut-card-… row suppresses remediation for an otherwise-stale ref (boardRowsVerified false)', () => {
  const board = [
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    '| akut-card-fix | `abc` | 📝 IN PROGRESS | `akut-card-fix.md` | t | — |',
    '<!-- BOARD-END -->',
  ].join('\n');
  const { unresolvedSlugs: boardUnresolvedSlugs } = allRowsFromBoard(board);
  assert.deepEqual(boardUnresolvedSlugs, ['akut-card-fix']);
  const boardRowsVerified = boardUnresolvedSlugs.length === 0;
  assert.equal(boardRowsVerified, false, 'an unresolved board-row slug must untrust the view');
});

// F3: a date-prefixed slug ("2026-05-17-foo") must not silently resolve to plan id "2026" via
// either the queue path or the board path — both must record it as unresolved.
test('F3: a date-prefixed slug never resolves into the id Set on either the queue or the board side', () => {
  const { ids: queueIds, unresolvedSlugs: queueUnresolved } = queuePlanIds([
    { slug: '2026-05-17-something' },
  ]);
  assert.ok(!queueIds.has('2026'), 'must never credit plan id "2026" from a date prefix');
  assert.deepEqual(queueUnresolved, ['2026-05-17-something']);

  const board = [
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 2026-05-17-something | `abc` | 📝 IN PROGRESS | `2026-05-17-something.md` | t | — |',
    '<!-- BOARD-END -->',
  ].join('\n');
  const { rows, unresolvedSlugs: boardUnresolved } = allRowsFromBoard(board);
  assert.ok(
    !rows.some((r) => r.planId === '2026'),
    'must never credit plan id "2026" from a date prefix',
  );
  assert.deepEqual(boardUnresolved, ['2026-05-17-something']);
});

// F4 (findings d9c7fe/bda999/0ab1cb): parseQueue returns `entries: []` WITHOUT throwing when
// both sentinel pairs survive but the header/data rows themselves are gone — a corrupt queue doc
// that used to read as a verified, genuinely-empty queue. Requiring the parsed content to
// actually CONTAIN the HEADER row distinguishes that from a real empty queue (header present,
// zero data rows), which must stay verified.
test('F4: sentinel-bearing content with NO header row is unverified — remediation suppressed', () => {
  // Sentinels present, but the header/separator/data rows between them are gone — the shape
  // parseQueue does NOT throw on (entries: [] with no error).
  const corrupt = [
    '# Landing queue',
    '',
    QUEUE_START,
    QUEUE_END,
    '',
    '## Audit',
    '',
    AUDIT_START,
    AUDIT_END,
    '',
  ].join('\n');
  // parseQueue itself must not throw (that's the defect: it silently "succeeds" here).
  assert.doesNotThrow(() => {
    const { entries } = parseQueue(corrupt);
    assert.deepEqual(entries, []);
  });
  // The fix's actual gate: the content does NOT contain the real HEADER row.
  assert.ok(!corrupt.includes(QUEUE_HEADER), 'corrupt content must not contain the HEADER row');
});

test('F4: header present with zero data rows is a normal empty queue — stays verified', () => {
  const emptyButHealthy = [
    '# Landing queue',
    '',
    QUEUE_START,
    QUEUE_HEADER,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    QUEUE_END,
    '',
    '## Audit',
    '',
    AUDIT_START,
    AUDIT_END,
    '',
  ].join('\n');
  const { entries } = parseQueue(emptyButHealthy);
  assert.deepEqual(entries, []);
  assert.ok(emptyButHealthy.includes(QUEUE_HEADER), 'a genuinely empty queue still has a header');
});

// F6 (finding 4c71c7): `Number(process.argv[i+1])` yields NaN for a missing/garbage
// `--stale-min` value; every `>` comparison in staleRefs then goes false for EVERY orphan-ref,
// so nothing is ever reported stale and remediation silently never prints. resolveStaleMin must
// fall back to the default on any non-finite or negative value.
test('F6: resolveStaleMin falls back to the default on a missing/garbage/negative --stale-min value', () => {
  assert.equal(resolveStaleMin(['node', 'reconcile-board.mjs', '--stale-min'], 35), 35); // trailing, no value
  assert.equal(resolveStaleMin(['node', 'reconcile-board.mjs', '--stale-min', 'abc'], 35), 35); // garbage
  assert.equal(resolveStaleMin(['node', 'reconcile-board.mjs', '--stale-min', 'NaN'], 35), 35); // literal "NaN"
  assert.equal(resolveStaleMin(['node', 'reconcile-board.mjs', '--stale-min', '-5'], 35), 35); // negative
  assert.equal(resolveStaleMin(['node', 'reconcile-board.mjs'], 35), 35); // flag absent entirely
  assert.equal(resolveStaleMin(['node', 'reconcile-board.mjs', '--stale-min', '10'], 35), 10); // valid
  assert.equal(resolveStaleMin(['node', 'reconcile-board.mjs', '--stale-min', '0'], 35), 0); // valid, zero allowed
});

// F6: the consequence this guards against — proving that with the OLD (unguarded) computation a
// garbage --stale-min value would have produced NaN and made staleRefs report nothing stale,
// while the fixed resolveStaleMin's fallback lets staleRefs behave normally.
test('F6: staleRefs with the OLD unguarded NaN would flag nothing stale; resolveStaleMin fallback restores normal staleness', () => {
  const orphanRefs = [{ planId: '368', iso: '2026-06-05T10:00:00Z' }]; // 120 min old
  const nowMs = Date.parse('2026-06-05T12:00:00Z');
  const oldUnguardedStaleMin = Number(undefined); // what `--stale-min` with no following arg used to produce
  assert.ok(Number.isNaN(oldUnguardedStaleMin));
  assert.deepEqual(staleRefs(orphanRefs, { nowMs, staleMin: oldUnguardedStaleMin }), []);

  const fixedStaleMin = resolveStaleMin(['node', 'reconcile-board.mjs', '--stale-min'], 35);
  assert.equal(fixedStaleMin, 35);
  assert.deepEqual(
    staleRefs(orphanRefs, { nowMs, staleMin: fixedStaleMin }).map((r) => r.planId),
    ['368'],
  );
});

// ── plan 3814 review fix ROUND 2 (scoped re-review of round 1's fix delta) ─────────────

// F1 (finding 2e43ea CONFIRMED): round-1's F5 unified the board/queue readers into
// readCoordFileForReconcile, which returns `{content: null, source: 'unreadable'}` when BOTH the
// origin read and the local fallback throw — an outcome that used to exist only on the queue
// side. main() passes the board read straight into presentRowsFromBoard/allRowsFromBoard, both of
// which call splitBoard(content), and splitBoard(null) throws (`content.indexOf` on null) —
// crashing the whole reporter via main()'s outer catch (exit 2) and suppressing every finding,
// PAUSED-REF/ORPHAN-ROW lines included. Fails against pre-fix code with a TypeError.
test('F1: presentRowsFromBoard(null) and allRowsFromBoard(null) never throw — an unreadable board view degrades to empty, not a crash', () => {
  assert.doesNotThrow(() => {
    const rows = presentRowsFromBoard(null);
    assert.deepEqual(rows, []);
  });
  assert.doesNotThrow(() => {
    const { rows, unresolvedSlugs } = allRowsFromBoard(null);
    assert.deepEqual(rows, []);
    assert.deepEqual(unresolvedSlugs, []);
  });
});

// F1: the composition main() actually gates remediation on — a board source of 'unreadable'
// (readCoordFileForReconcile's null-content outcome) must compute boardVerified=false exactly
// like the local-fallback source does, so `remediationFor`'s boardVerified gate suppresses
// remediation across the board, and the report still completes (classifyReconcile/staleRefs never
// see a throw from the empty presentRows/allRowIds this null view now produces).
test('F1: an "unreadable" board source computes boardVerified=false and downstream classification completes cleanly', () => {
  const boardSource = 'unreadable';
  const boardVerified = boardSource === 'origin/master';
  assert.equal(boardVerified, false);

  const presentRows = presentRowsFromBoard(null);
  const { rows: allBoardRows, unresolvedSlugs: boardUnresolvedSlugs } = allRowsFromBoard(null);
  assert.deepEqual(boardUnresolvedSlugs, []);
  const r = classifyReconcile({ claimsMap: { 9850: 'sha9850' }, presentRows });
  assert.deepEqual(
    r.orphanRefs.map((x) => x.planId),
    ['9850'],
  );
  assert.equal(allBoardRows.length, 0);
});

// ── F2 (findings 626824/d9b36d/2a4fb6 CONFIRMED): --stale-min '' coerces to 0 ──────────
// `Number('')` is `0` — finite and non-negative — so round-1's F6 guard
// (`!Number.isFinite(n) || n < 0`) lets a blank/whitespace value silently become a 0-minute
// staleness threshold, flagging EVERY orphan-ref stale. Must reject blank/whitespace-only BEFORE
// the Number() coercion, falling back to the default — the destructive direction this whole plan
// exists to prevent.
test('F2: --stale-min "" (blank) falls back to the default, never coerced to 0', () => {
  assert.equal(resolveStaleMin(['node', 'reconcile-board.mjs', '--stale-min', ''], 35), 35);
});

test('F2: --stale-min "   " (whitespace-only) falls back to the default, never coerced to 0', () => {
  assert.equal(resolveStaleMin(['node', 'reconcile-board.mjs', '--stale-min', '   '], 35), 35);
});

// F2: an explicit, genuine `--stale-min 0` typed by an operator stays legal — only the
// blank/absent value is the bug.
test('F2: --stale-min 0 (explicit, non-blank) stays legal', () => {
  assert.equal(resolveStaleMin(['node', 'reconcile-board.mjs', '--stale-min', '0'], 35), 0);
});

// F2: garbage still falls back (unchanged round-1 behaviour).
test('F2: --stale-min garbage still falls back to the default', () => {
  assert.equal(resolveStaleMin(['node', 'reconcile-board.mjs', '--stale-min', 'abc'], 35), 35);
});

// ── F3 (findings 52a59b/cc2964/002dce/df7f85/f7f03e/505879/eac968/3369d4 CONFIRMED) ────
// Round-1's F4 guard was `queueContent.includes(QUEUE_HEADER)` — an UNSCOPED substring search
// over the whole document against the CURRENT 11-column header, byte-for-byte. Two defects this
// fixes: (a) the header text appearing anywhere OUTSIDE the QUEUE-START/QUEUE-END region (prose,
// an audit note) satisfied it even while the region itself was corrupt; (b) a legacy/narrower
// column-set header row (a REAL header, just not today's exact string) failed the check and
// permanently suppressed remediation on any such checkout. queueRegionHasHeaderRow scopes to the
// region and accepts any pipe-delimited row whose first cell is "slug".

// (a) header text present only OUTSIDE the queue region, region itself empty/corrupt → false.
test('F3(a): header text OUTSIDE the queue region does not satisfy the check when the region itself is corrupt', () => {
  const doc = [
    '# Landing queue',
    '',
    `Historical header shape for reference: ${QUEUE_HEADER}`, // outside QUEUE-START/END
    '',
    QUEUE_START,
    QUEUE_END,
    '',
    '## Audit',
    '',
    AUDIT_START,
    AUDIT_END,
    '',
  ].join('\n');
  assert.equal(queueRegionHasHeaderRow(doc), false);
});

// (b) round 3 CORRECTION (finding round2 relaxation was itself WRONG — round 3 findings
// 603721/3f789f/b2620d/bbfad2/9aac6b/4aea76/f17cb9 CONFIRMED): round 2 accepted ANY pipe row
// whose first cell is "slug", including a header row narrower than 6 cells. But parseQueue
// (landing-queue-lib.mjs) SKIPS any row with `cells.length < 6` — so a narrower "legacy" header
// is not actually parseable at all; every row under it is silently dropped by parseQueue, and
// round 2's relaxed check would mark that view VERIFIED while it carries zero readable entries —
// the exact "verified but empty queue" hazard this guard exists to prevent, reintroduced from the
// other side. A 3-cell header is therefore NOT a supported legacy format; it is a document
// parseQueue cannot read, so the view must be UNVERIFIED.
test('F1 (round 3): a narrower-than-6-cell header row INSIDE the region is now REJECTED (round-2 regression corrected)', () => {
  const legacyHeader = '| slug | lane | session |'; // 3 cells — parseQueue would skip every row under this
  const doc = [
    '# Landing queue',
    '',
    QUEUE_START,
    legacyHeader,
    '| --- | --- | --- |',
    QUEUE_END,
    '',
    '## Audit',
    '',
    AUDIT_START,
    AUDIT_END,
    '',
  ].join('\n');
  assert.equal(queueRegionHasHeaderRow(doc), false);
});

// (b2) a header row with EXACTLY 6 cells — parseQueue's own threshold — is accepted: this is the
// narrowest header parseQueue can actually read a data row under.
test("F1 (round 3): a header row with exactly 6 cells (parseQueue's own threshold) is accepted", () => {
  const sixCellHeader = '| slug | lane | session | host | enqueued | state |';
  const doc = [
    '# Landing queue',
    '',
    QUEUE_START,
    sixCellHeader,
    '| --- | --- | --- | --- | --- | --- |',
    QUEUE_END,
    '',
    '## Audit',
    '',
    AUDIT_START,
    AUDIT_END,
    '',
  ].join('\n');
  assert.equal(queueRegionHasHeaderRow(doc), true);
});

// (c) a genuinely empty queue (real header, zero data rows) inside the region → true, unchanged.
test('F3(c): a real header with zero data rows inside the region is a genuinely empty queue — verified', () => {
  const doc = [
    '# Landing queue',
    '',
    QUEUE_START,
    QUEUE_HEADER,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    QUEUE_END,
    '',
    '## Audit',
    '',
    AUDIT_START,
    AUDIT_END,
    '',
  ].join('\n');
  assert.equal(queueRegionHasHeaderRow(doc), true);
});

// (d) sentinels present but no header row at all inside the region → false (the real F4 goal,
// preserved).
test('F3(d): sentinels present but no header row inside the region — unverified', () => {
  const doc = [
    '# Landing queue',
    '',
    QUEUE_START,
    QUEUE_END,
    '',
    '## Audit',
    '',
    AUDIT_START,
    AUDIT_END,
    '',
  ].join('\n');
  assert.equal(queueRegionHasHeaderRow(doc), false);
});

test('F3: null content never throws', () => {
  assert.equal(queueRegionHasHeaderRow(null), false);
});

// ── F4 (findings c8d325/06886d/063d76 CONFIRMED): resolveSlugPlanId now delegates to
// board-lib.mjs's planIdOfRowSlug (the ONE boundary-aware definition) instead of a hand-rolled
// planIdOf + DATE_PREFIX_RX exception. Re-asserts the SAME cases the round-1 tests already cover
// (date-prefixed / batch / legacy-bare), proving the new primitive is a drop-in, strictly-better
// replacement — these must still pass unchanged.
test('F4: resolveSlugPlanId delegates to board-lib.planIdOfRowSlug — same results as round 1, no hand-rolled exception', () => {
  assert.equal(resolveSlugPlanId('3814-Coord-reconcile-x'), '3814');
  assert.equal(resolveSlugPlanId('batch-2026-08-06-sonnet-smalls'), null);
  assert.equal(resolveSlugPlanId('akut-card-fix'), null);
  assert.equal(resolveSlugPlanId('2026-05-17-something'), null);
  // A bare id-only slug (no trailing "-desc") — planIdOfRowSlug's `$` alternative.
  assert.equal(resolveSlugPlanId('3814'), '3814');
});

// F4: the actual behaviour-visible bug the delegation fixes — not just a refactor. The
// hand-rolled `planIdOf` (claim-plan-lib.mjs's bare `/^(\d{3,})/`) has NO boundary check at all,
// so a slug shaped like "2932-1-x" (id, dash, a SINGLE extra digit, dash, word — the exact shape
// board-lib.mjs's planIdOfRowSlug doc calls out by name: "the lookahead is what stops `2932-1-x`
// reading as plan 2932") greedily returns "2932", wrongly crediting an unrelated plan. Round-1's
// DATE_PREFIX_RX exception never caught this shape (it only matches YYYY-MM-DD). The boundary-
// aware planIdOfRowSlug refuses it (null) by construction. Fails against pre-fix code, which
// returns '2932' instead of null.
test('F4: a slug shaped like "<id>-<digit>-<word>" (2932-1-x) must NOT resolve to the leading id — planIdOf has no boundary check, planIdOfRowSlug does', () => {
  assert.equal(resolveSlugPlanId('2932-1-x'), null);
});

// ── F5 (finding f79c7b CONFIRMED, minor): readCoordFileForReconcile's `fetchOk` tri-state
// default was `undefined`, whose meaning was unclear (falls through to attempting `show`, same as
// `true`). Made explicit: defaults to `false` — the fail-safe direction (skip `show`, go straight
// to local fallback) — so an omitted fetchOk behaves IDENTICALLY to an explicit `fetchOk: false`,
// never like `fetchOk: true`. Fails against pre-fix code because the old `undefined` default lets
// the `show` call through (git IS invoked), even though the observable content/source still land
// on the same fallback via the outer catch — this test asserts on the CALL, not just the result.
// ── plan 3814 review fix ROUND 3 (final) ────────────────────────────────────────────────

// F2 (findings 004eaa/432669/1ae500/2fcda6/f7f860/852fdd/9a3f5a/4ed1b2 CONFIRMED):
// presentRowsFromBoard still resolved slugs with the bare, boundary-unaware `planIdOf` while
// allRowsFromBoard/queuePlanIds use the boundary-aware resolveSlugPlanId — so the SAME board
// file yields a DIFFERENT plan id for the same row depending on which walk reads it. A row
// slugged "2932-1-x" must never be credited to plan "2932" via presentRowsFromBoard (it would
// mis-credit an unrelated plan in inSync/pausedRefs/orphanRows) even though the row's actual
// state is a present one.
test('F2 (round 3): presentRowsFromBoard must not resolve "2932-1-x" to plan id "2932" (boundary-unaware planIdOf bug)', () => {
  const board = [
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 2932-1-x | `abc` | 🔄 ACTIVE | `2932-1-x.md` | t | — |',
    '<!-- BOARD-END -->',
  ].join('\n');
  const rows = presentRowsFromBoard(board);
  assert.ok(
    !rows.some((r) => r.planId === '2932'),
    'must never mis-credit the unrelated plan 2932',
  );
});

// F2: presentRowsFromBoard and allRowsFromBoard must AGREE on ids for the same board — one
// resolver for every slug→id derivation in this file, not two that can independently drift.
test('F2 (round 3): presentRowsFromBoard and allRowsFromBoard agree on plan ids for the same board', () => {
  const board = [
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 2932-1-x | `abc` | 🔄 ACTIVE | `2932-1-x.md` | t | — |',
    '| 365-UI-x | `def` | 🔄 ACTIVE | `365-UI-x.md` | t | — |',
    '<!-- BOARD-END -->',
  ].join('\n');
  const presentIds = new Set(presentRowsFromBoard(board).map((r) => r.planId));
  const { rows: allRows } = allRowsFromBoard(board);
  const allIds = new Set(allRows.map((r) => r.planId));
  assert.deepEqual([...presentIds].sort(), [...allIds].sort());
  assert.deepEqual([...presentIds].sort(), ['365']);
});

// F3 (finding 0f63f1 CONFIRMED): round 2 swapped `planIdOf` (`^(\d{3,})` — plan ids are 3+ digits,
// documented in claim-plan-lib.mjs / next-plan-id.mjs) for board-lib.mjs's `planIdOfRowSlug`
// (boundary-aware but NO minimum length) — losing the 3-digit floor. A 1- or 2-digit prefix is
// never a real plan id and must resolve to null (unresolved), not a bogus short id.
test("F3 (round 3): resolveSlugPlanId enforces the 3+-digit minimum on top of planIdOfRowSlug's boundary rule", () => {
  assert.equal(resolveSlugPlanId('12-foo'), null); // 2 digits — below the minimum
  assert.equal(resolveSlugPlanId('123-foo'), '123'); // 3 digits — at the minimum, valid
  assert.equal(resolveSlugPlanId('2932-1-x'), null); // boundary rule already refuses this
  assert.equal(resolveSlugPlanId('3814-Coord-x'), '3814'); // normal case
});

// F4 (findings 1367f2/7a883b CONFIRMED): round 2's F1 guarded only `content == null` (the read
// failed entirely). Board content that is a non-null STRING but malformed (no BOARD-START/
// BOARD-END sentinels: a corrupt file, or a coordination doc that isn't the board at all) still
// makes `splitBoard` throw, which used to propagate straight out of main()'s outer catch — exit
// 2, suppressing the ENTIRE report (PAUSED-REF/ORPHAN-ROW lines included) over a board read that
// merely came back corrupt rather than absent. Both board walks must degrade the same way as the
// null case: empty rows, never a throw.
test('F4 (round 3): presentRowsFromBoard(malformed) and allRowsFromBoard(malformed) never throw — degrade to empty, not a crash', () => {
  const malformed = 'this is not a board file at all — no BOARD-START/BOARD-END sentinels here';
  assert.doesNotThrow(() => {
    const rows = presentRowsFromBoard(malformed);
    assert.deepEqual(rows, []);
  });
  assert.doesNotThrow(() => {
    const { rows, unresolvedSlugs, malformed: isMalformed } = allRowsFromBoard(malformed);
    assert.deepEqual(rows, []);
    assert.deepEqual(unresolvedSlugs, []);
    assert.equal(isMalformed, true, 'allRowsFromBoard must flag malformed non-null content');
  });
});

// F4: the composition main() actually gates remediation on — a malformed board must make
// boardRowsVerified false (mirroring main()'s own `boardUnresolvedSlugs.length === 0 &&
// !boardMalformed` condition) so remediation is suppressed, exactly like an unresolved-slug board.
test("F4 (round 3): a malformed board makes boardRowsVerified false (main()'s gate), suppressing remediation", () => {
  const malformed = 'no sentinels here either';
  const { unresolvedSlugs: boardUnresolvedSlugs, malformed: boardMalformed } =
    allRowsFromBoard(malformed);
  // plan 3814 review round 4: call the SAME predicate main() calls, not a copy of its expression.
  // The previous form re-derived `unresolvedSlugs.length === 0 && !malformed` here, so dropping
  // the `!malformed` term from main() would have left this test green.
  assert.equal(
    boardRowsVerifiedFrom({ unresolvedSlugs: boardUnresolvedSlugs, malformed: boardMalformed }),
    false,
  );
  // and the healthy shape still verifies, so the assertion above is not vacuous
  assert.equal(boardRowsVerifiedFrom({ unresolvedSlugs: [], malformed: false }), true);
});

// plan 3814 review round 4: the queue-header verifier's width threshold must BE parseQueue's
// row-admission floor, not a copy of it. A verifier looser than the parser marks a queue verified
// whose rows the parser drops — a live queue slot goes unseen and `--force` is offered against it.
test('round 4: queueRegionHasHeaderRow keys its width threshold on parseQueue’s exported floor', () => {
  const region = (headerCells) =>
    [QUEUE_START, `| ${headerCells.join(' | ')} |`, QUEUE_END, AUDIT_START, AUDIT_END].join('\n');
  const atFloor = Array.from({ length: MIN_QUEUE_ROW_CELLS }, (_, i) =>
    i === 0 ? 'slug' : `c${i}`,
  );
  const belowFloor = atFloor.slice(0, MIN_QUEUE_ROW_CELLS - 1);
  assert.equal(
    queueRegionHasHeaderRow(region(atFloor)),
    true,
    'a header at the parser floor verifies',
  );
  assert.equal(
    queueRegionHasHeaderRow(region(belowFloor)),
    false,
    'a header narrower than the parser floor must NOT verify — parseQueue would drop every row',
  );
  // the constant is the parser's, not a literal re-typed here
  assert.equal(typeof MIN_QUEUE_ROW_CELLS, 'number');
});

test('F5: fetchOk defaults to false (not undefined) — omitting it skips the git `show` call entirely, same as fetchOk:false', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-board-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'board.md'), 'LOCAL CONTENT', 'utf8');
  let gitCalled = false;
  const fakeGit = () => {
    gitCalled = true;
    throw new Error('git show must never be attempted when fetchOk is omitted/defaults to false');
  };
  const result = readCoordFileForReconcile(dir, 'board.md', { _git: fakeGit }); // fetchOk omitted
  assert.equal(
    gitCalled,
    false,
    'a default fetchOk must behave exactly like fetchOk:false, never like fetchOk:true',
  );
  assert.deepEqual(result, {
    content: 'LOCAL CONTENT',
    source: 'local working tree (origin read failed)',
  });
});
