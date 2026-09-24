#!/usr/bin/env node
// scripts/coord/box-table.mjs (plan 2524) — the box-drawing primitives shared by the operator's
// two "what is in flight" boards: `landing-queue-board.mjs` (/landing-queue) and
// `ready-board.mjs` (/ready-plans).
//
// WHY THIS FILE EXISTS: these four functions were born inside landing-queue-board.mjs, where
// only one caller needed them. The subtle one is `dispWidth` — the emoji width accounting that
// keeps the box aligned — and duplicating THAT into a second board is how two views of the same
// coordination state start disagreeing about their own borders. The rest of the plan-2524
// convergence (one tested renderer per view, thin command bodies) is pointless if the two
// renderers carry two copies of the alignment rule.
//
// Nothing here knows about queues, plans, or lanes: it takes headers + rows of ALREADY-FORMATTED
// strings and returns a box. Cell semantics stay in the board that owns them.

// Visual width, not String.length. Two separate reasons they differ:
//   1. astral-plane emoji (🟩 U+1F7E9, 🟥 U+1F7E5, 🔵, 🟣, 🔒, ⛔ …) are 2 terminal cells but
//      2 UTF-16 code units, so String.length double-counts them;
//   2. ⚡ (U+26A1) and ✅ (U+2705) are BMP — String.length counts them as 1 — but render
//      emoji-presentation double-width in every terminal that renders the boards' other markers
//      wide, so they must be counted as 2 anyway.
// Iterating with for..of gives codepoints (surrogate pairs already joined), so case 1 is handled
// by the >= 0x1f000 test and case 2 by the explicit BMP set below.
//
// NOT a general-purpose wcwidth: it covers the marker vocabulary these two boards actually use,
// and nothing speculative — an entry for a glyph no board renders is an untested claim about how
// a terminal draws it. Adding a marker outside this set means adding it here, with a test; an
// unaccounted-for double-width glyph shows up as a box whose borders no longer line up, which is
// exactly the failure `box-table.test.mjs`'s alignment assertions catch.
//
// THIRD COPY FOLDED IN — plan 2526. `scripts/batches-view.mjs` (the /batches board) used to
// carry its own `dispWidth` (glyph set {⚠, ❓, ⛔}) plus its own pad/center helpers; it now
// imports `dispWidth`/`padCell` from here, so this set covers all three boards' BMP markers —
// ⚠ (U+26A0) and ❓ (U+2753) were unioned in from batches-view's set (⛔ was already shared).
// BMP ONLY — an astral glyph here would be dead weight, already covered by the range check
// below (🔒 U+1F512 was listed here and removed for exactly that reason).
const WIDE_BMP = new Set(['⚡', '✅', '⛔', '⚠', '❓']);

export function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += ch.codePointAt(0) >= 0x1f000 || WIDE_BMP.has(ch) ? 2 : 1;
  return w;
}

// ── the glyph-certainty gate (plan 2932) ──────────────────────────────────────
// `dispWidth` above is a MODEL of how a terminal draws a glyph, and a model can be wrong. It
// was wrong about 🖥 (U+1F5A5): counted 2 by the `>= 0x1f000` branch, drawn 1 by the operator's
// terminal, so every `🖥 local` row of /landing-queue's Origin column overflowed its right
// border by one column. ⚪ (U+26AA) is the mirror error — BMP, counted 1, drawn 2.
//
// A board calls this on its own cell vocabulary so a new marker fails a TEST rather than the
// operator's eyes. Certain cases, and only these:
//   • printable ASCII, the box-drawing set, `…`, `·`      — one cell, never in doubt
//   • WIDE_BMP                                            — counted 2, drawn 2 (vetted above)
//   • WIDE_ASTRAL                                         — counted 2, drawn 2 (vetted below)
//   • a BMP codepoint FOLLOWED by U+FE0F                  — counted 1+1=2, drawn 2 (☁️)
//
// Deliberately NOT certain: an ASTRAL codepoint followed by U+FE0F. dispWidth counts the astral
// half 2 and the selector 1, so it totals 3 while the terminal draws 2 — the SAME class of
// off-by-one, in the opposite direction. Adding U+FE0F is therefore not a fix for a bare astral
// glyph; adding the glyph to WIDE_ASTRAL with a test is.
const SAFE_PUNCT = new Set(['…', '·', '│', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼', '─']);
const VS16 = '️';

// Astral glyphs the three boards ACTUALLY render, all Emoji_Presentation by default so every
// terminal draws them double-width — exactly what dispWidth's >= 0x1f000 branch assumes. Same
// discipline as WIDE_BMP: an entry for a glyph no board renders is an untested claim about how
// a terminal draws it. 🖥 was the counterexample and is deliberately absent.
const WIDE_ASTRAL = new Set(['🟩', '🟥', '🟢', '🟣', '🔵', '🚃', '💰']);

export function assertRenderableGlyphs(s) {
  const cps = [...String(s)];
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    const cp = ch.codePointAt(0);
    if (ch === '\n' || ch === VS16) continue;
    if (cp >= 0x20 && cp <= 0x7e) continue;
    if (SAFE_PUNCT.has(ch)) continue;
    if (WIDE_BMP.has(ch) || WIDE_ASTRAL.has(ch)) continue;
    if (cp < 0x1f000 && cps[i + 1] === VS16) continue;
    throw new Error(
      `box-table: glyph U+${cp.toString(16).toUpperCase()} has uncertain width in ${JSON.stringify(s)} — ` +
        'use ASCII, or add it to WIDE_BMP / WIDE_ASTRAL with a test.',
    );
  }
  return s;
}

// One space of padding either side, then left-align within `width` VISUAL cells.
export function padCell(s, width) {
  return ' ' + s + ' '.repeat(Math.max(0, width - dispWidth(s))) + ' ';
}

// As padCell, but centred (odd slack biases right, matching the original board's headers).
export function centerCell(s, width) {
  const slack = Math.max(0, width - dispWidth(s));
  const left = Math.floor(slack / 2);
  return ' ' + ' '.repeat(left) + s + ' '.repeat(slack - left) + ' ';
}

// Render a box. `headers` is an array of column titles; `rows` an array of same-length arrays of
// pre-formatted cell strings. `centerCols` lists the column indices whose CELLS are centred
// (everything else is left-aligned). `headerAlign` picks the header row's OWN alignment,
// independent of `centerCols` — `'center'` (default, what both original boards did) or `'left'`
// (batches-view's `/batches` board, plan 2561: its header row matches its all-left-aligned data
// rows, a real per-column behaviour difference from the other two boards, not an oversight).
//
// Column widths are the max VISUAL width of the header and every cell in that column, so a row
// carrying a double-width marker widens its column instead of shoving the right border out.
export function renderBox(headers, rows, { centerCols = [0], headerAlign = 'center' } = {}) {
  const centred = new Set(centerCols);
  const widths = headers.map((h, c) =>
    Math.max(dispWidth(h), ...rows.map((r) => dispWidth(r[c] ?? ''))),
  );

  const line = (l, mid, r) => l + widths.map((w) => '─'.repeat(w + 2)).join(mid) + r;
  const headerCell = headerAlign === 'left' ? padCell : centerCell;
  const out = [];
  out.push(line('┌', '┬', '┐'));
  out.push('│' + headers.map((h, c) => headerCell(h, widths[c])).join('│') + '│');
  out.push(line('├', '┼', '┤'));
  for (const r of rows) {
    out.push(
      '│' +
        headers
          .map((_, c) =>
            centred.has(c) ? centerCell(r[c] ?? '', widths[c]) : padCell(r[c] ?? '', widths[c]),
          )
          .join('│') +
        '│',
    );
  }
  out.push(line('└', '┴', '┘'));
  return out.join('\n');
}

// ── age formatting ────────────────────────────────────────────────────────────
// Both boards report "how long has this been sitting", so the format lives here too rather than
// being re-invented per board. Compact and fixed-vocabulary: `3d 4h` / `2h20m` / `14m` / `<1m`.
//
// Returns '?' for an unparseable or absent timestamp — NEVER 'NaNhNaNm'. A board cell reading '?'
// is honest about not knowing; a NaN reads as a bug in the board rather than in its input, and a
// silently-zero age reads as "just arrived", which is the actively misleading option.
export function ageLabel(iso, nowMs) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return '?';
  // A future timestamp means clock skew between hosts (the queue is written by several machines).
  // Clamp to 0 rather than rendering a negative age.
  const mins = Math.max(0, Math.floor((nowMs - t) / 60000));
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${String(mins % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
