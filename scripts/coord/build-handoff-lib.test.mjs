// scripts/build-handoff-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSessionFilename,
  sortSessionsNewestFirst,
  entryHeading,
  entryStatus,
  renderIndexLine,
  renderRecentBlock,
  spliceRecentBlock,
  HANDOFF_RECENT_START,
  HANDOFF_RECENT_END,
  SESSION_ENTRY_DATE_SHAPE,
} from './build-handoff-lib.mjs';
// plan 2891 T4: the two other consumers of the shared shape, so the three cannot drift apart.
import { isSessionEntryPath } from './done-worktree-lib.mjs';
import { assertSessionEntryDate } from './claim-plan-lib.mjs';

test('parseSessionFilename parses date/num/suffix and rejects non-entries', () => {
  assert.deepEqual(parseSessionFilename('2026-05-31-session-186.md'), {
    name: '2026-05-31-session-186.md',
    date: '2026-05-31',
    num: 186,
    suffix: '',
  });
  assert.deepEqual(parseSessionFilename('2026-05-23-session-71b.md'), {
    name: '2026-05-23-session-71b.md',
    date: '2026-05-23',
    num: 71,
    suffix: 'b',
  });
  assert.equal(parseSessionFilename('README.md'), null);
});

test('sortSessionsNewestFirst is numeric (100 before 99) and drops non-entries', () => {
  const sorted = sortSessionsNewestFirst([
    '2026-05-29-session-99.md',
    '2026-05-30-session-100.md',
    'README.md',
    '2026-05-31-session-186.md',
  ]);
  assert.deepEqual(sorted, [
    '2026-05-31-session-186.md',
    '2026-05-30-session-100.md',
    '2026-05-29-session-99.md',
  ]);
});

test('entryHeading + entryStatus extract title and plain-text status', () => {
  const c = [
    '## 2026-05-31 (session 186 — picking up: 249-Foo)',
    '',
    '**Status:** 🔄 **IN PROGRESS** — claimed.',
  ].join('\n');
  assert.equal(entryHeading(c), '2026-05-31 (session 186 — picking up: 249-Foo)');
  assert.equal(entryStatus(c), '🔄 IN PROGRESS — claimed.');
});

test('renderIndexLine links into handoff/sessions/ with status tail', () => {
  const line = renderIndexLine({
    name: '2026-05-31-session-186.md',
    heading: 'session 186 — X',
    status: '🔄 IN PROGRESS',
  });
  assert.equal(
    line,
    '- [session 186 — X](handoff/sessions/2026-05-31-session-186.md) — 🔄 IN PROGRESS',
  );
});

test('spliceRecentBlock replaces between sentinels (idempotent)', () => {
  const handoff = [
    '> pointer header',
    '',
    '---',
    '',
    HANDOFF_RECENT_START,
    'stale',
    HANDOFF_RECENT_END,
    '',
    '## 2026-05-28 (session 137) frozen history',
  ].join('\n');
  const block = renderRecentBlock([
    { name: '2026-05-31-session-186.md', heading: 'session 186', status: 'OK' },
  ]);
  const out1 = spliceRecentBlock(handoff, block);
  assert.ok(out1.includes('session-186.md'));
  assert.ok(!out1.includes('stale'));
  assert.ok(out1.includes('frozen history'));
  assert.equal(spliceRecentBlock(out1, block), out1); // idempotent
});

test('spliceRecentBlock first-run inserts after the pointer-header separator', () => {
  const handoff = ['> pointer header', '', '---', '', '## 2026-05-28 frozen'].join('\n');
  const block = renderRecentBlock([
    { name: '2026-05-31-session-186.md', heading: 'session 186', status: 'OK' },
  ]);
  const out = spliceRecentBlock(handoff, block);
  assert.ok(out.indexOf(HANDOFF_RECENT_START) < out.indexOf('## 2026-05-28 frozen'));
  assert.ok(out.indexOf('> pointer header') < out.indexOf(HANDOFF_RECENT_START));
});

// plan 2891 T4: the session-entry date shape is now spelled ONCE and imported by the three
// consumers that used to hand-copy it — this module's own filename parser, done-worktree-lib's
// "is this basename a session entry?" predicate, and claim-plan-lib's `--date` gate (the writer
// side that decides which dates may ever be concatenated into such a name). The first two were
// two halves of ONE invariant held in sync only by a comment; this pins that they agree.
test('plan 2891 T4: the shared date shape keeps the parser, the entry predicate and the --date gate in agreement', () => {
  const good = ['2026-08-05', '1999-12-31'];
  const bad = ['20260805', '2026-8-5', '26-08-05', '2026-08-05x'];
  for (const d of good) {
    assert.ok(parseSessionFilename(`${d}-session-7.md`), `parser accepts ${d}`);
    assert.ok(
      isSessionEntryPath(`docs/handoff/sessions/${d}-session-7.md`),
      `predicate accepts ${d}`,
    );
    assert.doesNotThrow(() => assertSessionEntryDate(d), `--date gate accepts ${d}`);
  }
  for (const d of bad) {
    assert.equal(parseSessionFilename(`${d}-session-7.md`), null, `parser rejects ${d}`);
    assert.equal(
      isSessionEntryPath(`docs/handoff/sessions/${d}-session-7.md`),
      false,
      `predicate rejects ${d}`,
    );
    assert.throws(() => assertSessionEntryDate(d), `--date gate rejects ${d}`);
  }
  // and the shape itself is a bare source fragment, not a finished anchored RegExp — each
  // consumer anchors it differently, so a stray ^/$ here would silently break two of the three.
  assert.equal(typeof SESSION_ENTRY_DATE_SHAPE, 'string');
  assert.doesNotMatch(SESSION_ENTRY_DATE_SHAPE, /[$^]/);
});
