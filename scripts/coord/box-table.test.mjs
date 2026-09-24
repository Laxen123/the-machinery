// scripts/box-table.test.mjs (plan 2524)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispWidth,
  padCell,
  centerCell,
  renderBox,
  ageLabel,
  assertRenderableGlyphs,
} from './box-table.mjs';
import { originLabel } from './landing-queue-board.mjs';

test('dispWidth: plain ASCII is one cell per char', () => {
  assert.equal(dispWidth('free'), 4);
  assert.equal(dispWidth(''), 0);
});

test('dispWidth: astral-plane emoji count as 2 cells, not their 2 UTF-16 units', () => {
  assert.equal(dispWidth('🟩'), 2);
  assert.equal(dispWidth('🟥'), 2);
  assert.equal(dispWidth('🔵'), 2);
  assert.equal(dispWidth('🟣'), 2);
  assert.equal(dispWidth('🟩 free'), 7); // 2 + 1 space + 4
});

test('dispWidth: the BMP emoji-presentation set counts as 2 despite String.length 1', () => {
  // These are the ones String.length gets WRONG in the other direction — 1 unit, 2 cells.
  // Kept in step with WIDE_BMP: every BMP glyph any of the three boards renders (⚠/❓ folded
  // in from batches-view.mjs by plan 2526), and nothing speculative.
  for (const ch of ['⚡', '✅', '⛔', '⚠', '❓']) {
    assert.equal(ch.length, 1, `${ch} must be BMP — an astral glyph belongs to the range check`);
    assert.equal(dispWidth(ch), 2, `${ch} should measure 2 cells`);
  }
  assert.equal(dispWidth('✅ ELIGIBLE'), 11); // 2 + 1 + 8
  // 🔒 is astral (U+1F512): covered by the range check, so listing it in WIDE_BMP would be dead.
  assert.equal('🔒'.length, 2);
  assert.equal(dispWidth('🔒 CLAIMED'), 10); // 2 + 1 + 7
});

test('padCell / centerCell pad by VISUAL width and add one space either side', () => {
  assert.equal(padCell('ab', 4), ' ab   '); // 1 + 2 + 2 pad + 1
  assert.equal(dispWidth(padCell('🟩', 4)), 6); // emoji-aware: 1 + 2 + 2 pad + 1
  assert.equal(centerCell('ab', 6), '   ab   '); // slack 4 → 2 left, 2 right, + 1 each side
  assert.equal(centerCell('abc', 6), '  abc   '); // odd slack biases right
});

test('renderBox: header + separator + one line per row + two borders, all the same visual width', () => {
  const out = renderBox(
    ['#', 'Plan', 'Mark'],
    [
      ['1', 'a-very-long-slug-here', '🟩 free'],
      ['2', 'short', '⚡'],
    ],
  );
  const lines = out.split('\n');
  assert.equal(lines.length, 6); // top, header, sep, 2 rows, bottom

  const widths = new Set(lines.map((l) => dispWidth(l)));
  assert.equal(widths.size, 1, `box not aligned: widths ${[...widths]}`);
});

test('renderBox: centerCols centres the named columns and left-aligns the rest', () => {
  const out = renderBox(['A', 'B'], [['x', 'y']], { centerCols: [0] });
  const row = out.split('\n')[3];
  // Column A is centred in a width-1 column (no slack), B left-aligned — both render as ' x '/' y '.
  assert.equal(row, '│ x │ y │');
});

test('renderBox: a wide marker widens its own column instead of breaking the border', () => {
  const narrow = renderBox(['M'], [['ok']]).split('\n');
  const wide = renderBox(['M'], [['⚡ok']]).split('\n');
  assert.equal(dispWidth(wide[0]), dispWidth(narrow[0]) + 2, 'column grew by the marker width');
  assert.equal(new Set(wide.map((l) => dispWidth(l))).size, 1);
});

test('renderBox: a short row is padded, never throws on a missing cell', () => {
  const out = renderBox(['A', 'B'], [['x']]);
  assert.equal(new Set(out.split('\n').map((l) => dispWidth(l))).size, 1);
});

// ── ageLabel ──────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-07-26T20:00:00Z');

test('ageLabel formats across the minute / hour / day boundaries', () => {
  assert.equal(ageLabel('2026-07-26T19:59:40Z', NOW), '<1m');
  assert.equal(ageLabel('2026-07-26T19:46:00Z', NOW), '14m');
  assert.equal(ageLabel('2026-07-26T19:00:00Z', NOW), '1h00m');
  assert.equal(ageLabel('2026-07-26T17:40:00Z', NOW), '2h20m');
  assert.equal(ageLabel('2026-07-25T23:00:00Z', NOW), '21h00m');
  assert.equal(ageLabel('2026-07-23T16:00:00Z', NOW), '3d 4h');
});

test('ageLabel returns ? for junk — never NaN, never a silent zero', () => {
  assert.equal(ageLabel('not-a-date', NOW), '?');
  assert.equal(ageLabel('', NOW), '?');
  assert.equal(ageLabel(undefined, NOW), '?');
  assert.equal(ageLabel(null, NOW), '?');
  assert.equal(ageLabel('2026-07-26T19:00:00Z', NaN), '?');
});

test('ageLabel clamps a future timestamp (cross-host clock skew) to <1m, not a negative age', () => {
  assert.equal(ageLabel('2026-07-26T20:05:00Z', NOW), '<1m');
});

// ── plan 2932: the glyph-certainty gate ───────────────────────────────────────

test('originLabel emits no glyph whose drawn width is uncertain', () => {
  assert.doesNotThrow(() => assertRenderableGlyphs(originLabel('vm')));
  assert.doesNotThrow(() => assertRenderableGlyphs(originLabel('BUILD-HOST-01')));
  assert.doesNotThrow(() => assertRenderableGlyphs(originLabel('')));
});

test('assertRenderableGlyphs rejects a variation-selector-less pictograph', () => {
  assert.throws(() => assertRenderableGlyphs('\u{1F5A5} local'), /uncertain width/);
});

test('assertRenderableGlyphs also rejects an ASTRAL glyph carrying U+FE0F', () => {
  // dispWidth counts the astral half 2 and the selector 1 = 3, while the terminal draws 2.
  // Adding U+FE0F is NOT a fix for a bare astral glyph — it is the same bug mirrored.
  assert.equal(dispWidth('\u{1F5A5}️'), 3);
  assert.throws(() => assertRenderableGlyphs('\u{1F5A5}️ local'), /uncertain width/);
});

test('assertRenderableGlyphs accepts the vetted sets and a BMP glyph carrying U+FE0F', () => {
  assert.doesNotThrow(() => assertRenderableGlyphs('🟩 free · 🟥 seed'));
  assert.doesNotThrow(() => assertRenderableGlyphs('⚡ high ⛔ blocked'));
  assert.doesNotThrow(() => assertRenderableGlyphs('🔵 sonnet 🟣 fable 🚃 train 💰 cost 🟢 ok'));
  // ☁️ is BMP + U+FE0F: counted 1+1=2, drawn 2. Certain, and shipping today.
  assert.doesNotThrow(() => assertRenderableGlyphs('☁️ cloud'));
  assert.equal(dispWidth('☁️'), 2);
});

test('a mixed local/cloud queue renders a square box', () => {
  const rows = [
    ['1 (head)', 'a-slug', '🟩 free', '13:26', '2h20m', originLabel('BUILD-HOST-01')],
    ['2', 'b-slug', '🟥 seed', '13:30', '2h16m', originLabel('vm')],
  ];
  const lines = renderBox(['#', 'Plan', 'Lane', 'Enqueued', 'Waiting', 'Origin'], rows)
    .split('\n')
    .filter((l) => l.startsWith('│'));
  assert.equal(new Set(lines.map(dispWidth)).size, 1, 'ragged box');
});
