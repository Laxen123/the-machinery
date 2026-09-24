import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugFromBranch,
  queueHasSlug,
  boardStateForSlug,
  computeVerdict,
  queueSnapshotUnverified,
} from './redgreen-lib.mjs';
import { parseQueue } from './landing-queue-lib.mjs';

// --- slugFromBranch ---------------------------------------------------------
test('slugFromBranch strips the worktree- prefix', () => {
  assert.equal(slugFromBranch('worktree-649-Infra-redgreen'), '649-Infra-redgreen');
});
test('slugFromBranch returns null for master / non-worktree branches', () => {
  assert.equal(slugFromBranch('master'), null);
  assert.equal(slugFromBranch('main'), null);
  assert.equal(slugFromBranch(''), null);
  assert.equal(slugFromBranch('HEAD'), null);
});

// --- queueHasSlug -----------------------------------------------------------
const QUEUE = `prose
<!-- QUEUE-START -->
| Slug | Lane | Session | Host | Enqueued | Heartbeat |
| ---- | ---- | ------- | ---- | -------- | --------- |
| 642-Infra-foo | 🟩 | ? | HOSTA | 2026-06-15T13:00:00Z | 2026-06-15T13:00:00Z |
| 644-DQ-bar | 🟥 | ? | HOSTA | 2026-06-15T13:01:00Z | 2026-06-15T13:01:00Z |
<!-- QUEUE-END -->
<!-- AUDIT-START -->
<!-- AUDIT-END -->`;

test('queueHasSlug finds an enqueued slug', () => {
  assert.equal(queueHasSlug(QUEUE, '642-Infra-foo'), true);
  assert.equal(queueHasSlug(QUEUE, '644-DQ-bar'), true);
});
test('queueHasSlug is false for an absent slug, null slug, or empty content', () => {
  assert.equal(queueHasSlug(QUEUE, '999-none'), false);
  assert.equal(queueHasSlug(QUEUE, null), false);
  assert.equal(queueHasSlug('', '642-Infra-foo'), false);
});

// --- boardStateForSlug ------------------------------------------------------
const BOARD = `header prose
<!-- BOARD-START -->

| Worktree | Branch tip | State | Plan / claim | Last touched | Resume condition |
| -------- | ---------- | ----- | ------------ | ------------ | ---------------- |

| 596-INTL-foo | \`abc\` | 🔄 ACTIVE | claim | 2026-06-15 | — |
| 015-P05-bar | \`def\` | ⏸ PAUSED | claim | 2026-06-15 | run #3 ≥ date |
| 600-x-land | \`ghi\` | 🟢 LANDING | claim | 2026-06-15 | mid-merge |
<!-- BOARD-END -->`;

test('boardStateForSlug returns the state cell for each row', () => {
  assert.equal(boardStateForSlug(BOARD, '596-INTL-foo'), '🔄 ACTIVE');
  assert.equal(boardStateForSlug(BOARD, '015-P05-bar'), '⏸ PAUSED');
  assert.equal(boardStateForSlug(BOARD, '600-x-land'), '🟢 LANDING');
});
test('boardStateForSlug returns null for a missing row, null slug, or empty content', () => {
  assert.equal(boardStateForSlug(BOARD, '777-gone'), null);
  assert.equal(boardStateForSlug(BOARD, null), null);
  assert.equal(boardStateForSlug('', '596-INTL-foo'), null);
});

// --- computeVerdict ---------------------------------------------------------
test('GREEN: worktree clean, landed, not queued, no board row', () => {
  const v = computeVerdict({
    slug: '649-x',
    dirty: false,
    landed: true,
    inQueue: false,
    boardState: null,
  });
  assert.equal(v.light, 'green');
  assert.deepEqual(v.reasons, []);
});

test('GREEN: main checkout (slug null) with a clean tree', () => {
  const v = computeVerdict({
    slug: null,
    dirty: false,
    landed: true,
    inQueue: false,
    boardState: null,
  });
  assert.equal(v.light, 'green');
});

test('RED: dirty working tree', () => {
  const v = computeVerdict({
    slug: '649-x',
    dirty: true,
    landed: true,
    inQueue: false,
    boardState: null,
  });
  assert.equal(v.light, 'red');
  assert.ok(v.reasons.some((r) => /uncommitted/.test(r)));
});

test('RED: branch not landed', () => {
  const v = computeVerdict({
    slug: '649-x',
    dirty: false,
    landed: false,
    inQueue: false,
    boardState: null,
  });
  assert.equal(v.light, 'red');
  assert.ok(v.reasons.some((r) => /unlanded/.test(r)));
});

test('RED: in the landing queue', () => {
  const v = computeVerdict({
    slug: '649-x',
    dirty: false,
    landed: true,
    inQueue: true,
    boardState: null,
  });
  assert.equal(v.light, 'red');
  assert.ok(v.reasons.some((r) => /landing queue/.test(r)));
});

test('RED: ACTIVE board row', () => {
  const v = computeVerdict({
    slug: '649-x',
    dirty: false,
    landed: true,
    inQueue: false,
    boardState: '🔄 ACTIVE',
  });
  assert.equal(v.light, 'red');
  assert.ok(v.reasons.some((r) => /🔄 ACTIVE/.test(r)));
});

test('RED: PAUSED and LANDING board rows are in-flight too', () => {
  for (const s of ['⏸ PAUSED', '🟢 LANDING']) {
    const v = computeVerdict({
      slug: '649-x',
      dirty: false,
      landed: true,
      inQueue: false,
      boardState: s,
    });
    assert.equal(v.light, 'red', `${s} should be RED`);
  }
});

test('main checkout ignores landed/queue/board axes (only dirty matters)', () => {
  // slug null → unlanded/queue/board reasons must NOT fire even if passed
  const v = computeVerdict({
    slug: null,
    dirty: false,
    landed: false,
    inQueue: true,
    boardState: '🔄 ACTIVE',
  });
  assert.equal(v.light, 'green');
});

test('multiple RED reasons accumulate', () => {
  const v = computeVerdict({
    slug: '649-x',
    dirty: true,
    landed: false,
    inQueue: true,
    boardState: '⏸ PAUSED',
  });
  assert.equal(v.light, 'red');
  assert.equal(v.reasons.length, 4);
});

// --- queueSnapshotUnverified (plan 3973 review round 2, keys 38da97 / c9673a) ----------------
test('queueSnapshotUnverified: a tick that refreshed the queue ref trusts its own read', () => {
  assert.equal(
    queueSnapshotUnverified({
      queueFetched: true,
      masterFetched: true,
      source: 'ref',
      fault: null,
    }),
    false,
  );
});

test('queueSnapshotUnverified: a failed queue fetch leaves a cached tracking ref UNVERIFIED', () => {
  // The combined fetch failed and the master-only fallback succeeded: the board is fresh, the
  // queue view is whatever this checkout last fetched — a remote enqueue can be invisible.
  for (const source of ['ref', 'ref-cached', 'empty', 'none']) {
    assert.equal(
      queueSnapshotUnverified({
        queueFetched: false,
        masterFetched: true,
        source,
        fault: null,
      }),
      true,
      `${source} off an unrefreshed ref must not read as a proven empty queue`,
    );
  }
});

test('queueSnapshotUnverified: a fault is always unverified, and the pre-cut-over master table is verified by its own fetch', () => {
  assert.equal(
    queueSnapshotUnverified({
      queueFetched: true,
      masterFetched: true,
      source: 'ref',
      fault: new Error('unreadable'),
    }),
    true,
  );
  // Before the cut-over the ref legitimately does not exist and the live table is origin/master's
  // — the fallback fetch refreshed exactly that, so the snapshot is as good as the board's.
  assert.equal(
    queueSnapshotUnverified({
      queueFetched: false,
      masterFetched: true,
      source: 'master',
      fault: null,
    }),
    false,
  );
  assert.equal(
    queueSnapshotUnverified({
      queueFetched: false,
      masterFetched: false,
      source: 'master',
      fault: null,
    }),
    true,
    'offline: even the master table is stale',
  );
});

test('RED: an unverified queue snapshot blocks the green close light (never a proven "not queued")', () => {
  const v = computeVerdict({
    slug: '649-x',
    dirty: false,
    landed: true,
    inQueue: false,
    queueUnverified: true,
    boardState: null,
  });
  assert.equal(v.light, 'red');
  assert.ok(v.reasons.some((r) => /may be stale/.test(r)));
  // …and it adds no SECOND reason when the slug is already known to be queued.
  const q = computeVerdict({
    slug: '649-x',
    dirty: false,
    landed: true,
    inQueue: true,
    queueUnverified: true,
    boardState: null,
  });
  assert.equal(q.reasons.length, 1);
  assert.ok(/landing queue \(waiting/.test(q.reasons[0]));
  // A main checkout has no queue slot to hold, so the marking cannot make it red.
  assert.equal(
    computeVerdict({
      slug: null,
      dirty: false,
      landed: true,
      inQueue: false,
      queueUnverified: true,
      boardState: null,
    }).light,
    'green',
  );
});

test('queueHasSlug accepts the accessor\u2019s own parse, so a caller never parses the doc twice', () => {
  // plan 3973 review round 3, key 603f09: redgreen hands `readQueueDoc`'s validated parse
  // straight through instead of re-parsing `q.doc` on every statusline tick.
  const parsed = parseQueue(QUEUE);
  assert.equal(queueHasSlug(parsed, '642-Infra-foo'), true);
  assert.equal(queueHasSlug(parsed, '999-none'), false);
  assert.equal(queueHasSlug(parsed, null), false);
  assert.equal(queueHasSlug({ entries: [] }, '642-Infra-foo'), false);
});

test('RED: a board read that fell back to HEAD is unverified, never a proven "no in-flight row"', () => {
  // plan 3973 review round 3, key 16f9d9: `git show origin/master:<board>` failed and the tick
  // showed the worktree's own HEAD copy, which predates every row a sibling added since.
  const v = computeVerdict({
    slug: '649-x',
    dirty: false,
    landed: true,
    inQueue: false,
    queueUnverified: false,
    boardState: null,
    boardUnverified: true,
  });
  assert.equal(v.light, 'red');
  assert.ok(v.reasons.some((r) => /board could not be read from origin\/master/.test(r)));
  // A board row that WAS read stands on its own — no second, contradictory reason.
  const known = computeVerdict({
    slug: '649-x',
    dirty: false,
    landed: true,
    inQueue: false,
    queueUnverified: false,
    boardState: '\u{1F504} ACTIVE',
    boardUnverified: true,
  });
  assert.equal(known.reasons.length, 1);
  assert.ok(/board row is/.test(known.reasons[0]));
  // A verified board with no row is still the green case.
  assert.equal(
    computeVerdict({
      slug: '649-x',
      dirty: false,
      landed: true,
      inQueue: false,
      queueUnverified: false,
      boardState: null,
      boardUnverified: false,
    }).light,
    'green',
  );
  // …and a main checkout has no board row to hold, so the marking cannot make it red.
  assert.equal(
    computeVerdict({
      slug: null,
      dirty: false,
      landed: true,
      inQueue: false,
      queueUnverified: true,
      boardState: null,
      boardUnverified: true,
    }).light,
    'green',
  );
});

// plan 3973 review round 4 (key 693dc8): round 3 gated the warning on `!boardState`, so a stale
// copy carrying a TERMINAL row for a slug the current board has flipped back to in-flight printed
// a green close light. An unverified board is unproven whatever it says.
test('RED: an unverified board is reported even when a (stale) terminal row WAS found', () => {
  const stale = {
    slug: '649-x',
    dirty: false,
    landed: true,
    inQueue: false,
    queueUnverified: false,
    boardState: '✅ DONE',
    boardUnverified: true,
  };
  const v = computeVerdict(stale);
  assert.equal(v.light, 'red');
  assert.ok(v.reasons.some((r) => /board could not be read from origin\/master/.test(r)));
  // the same terminal row read off a VERIFIED board is still the green case
  assert.equal(computeVerdict({ ...stale, boardUnverified: false }).light, 'green');
});
