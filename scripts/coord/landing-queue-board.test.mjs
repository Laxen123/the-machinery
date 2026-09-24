// scripts/landing-queue-board.test.mjs (plan 650)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findScriptsFile,
  hhmm,
  laneLabel,
  originLabel,
  renderTable,
  headLine,
} from './landing-queue-board.mjs';
// Plan 2524 moved the width/box primitives to box-table.mjs, which owns their accounting cases
// (box-table.test.mjs). Imported here only as the measuring stick for this board's alignment
// assertions — duplicating those cases in this file is what the extraction was undoing.
import { dispWidth } from './box-table.mjs';

// Fixed clock for every Waiting/head assertion below — the board must not be clock-dependent.
const NOW = Date.parse('2026-07-26T20:00:00Z');

// plan 4071 D4: LOCAL_HOST_DENYLIST was removed from cloud-checkout-preflight.mjs — the
// historical local-host list now lives in coord.config.json's `localHostDenylist[]`, and
// originLabel/renderTable take it as an explicit `denylist`/`localHostDenylist` parameter
// (default `[]`) instead of importing a hardcoded literal. FIXTURE_DENYLIST is a purely
// synthetic TEST FIXTURE constant (this module ships as-is into the public coord-kit —
// scripts/coord/ is copied wholesale — so a shipped core test must not pin THIS project's own
// real coord.config.json value; plan 3958) — every test below injects it directly via the
// `denylist`/`localHostDenylist` parameter, so none of them depend on this repo's actual
// coord.config.json content.
const FIXTURE_DENYLIST = ['WORKSTATION-A1']; // personal-data-ok: fixture

test('hhmm slices UTC HH:MM from the stored ISO; falls back on junk', () => {
  assert.equal(hhmm('2026-06-15T13:26:07.464Z'), '13:26');
  assert.equal(hhmm(''), '??:??');
  assert.equal(hhmm(undefined), '??:??');
});

test('laneLabel maps the seed-write banner emoji', () => {
  assert.equal(laneLabel('🟥'), '🟥 seed');
  assert.equal(laneLabel('🟩'), '🟩 free');
  assert.equal(laneLabel(''), '?');
});

test('originLabel classifies against the canonical local-host list, default-deny to cloud', () => {
  assert.equal(originLabel('WORKSTATION-A1', FIXTURE_DENYLIST), 'local'); // personal-data-ok: fixture
  assert.equal(originLabel('workstation-a1', FIXTURE_DENYLIST), 'local'); // case-insensitive, personal-data-ok: fixture
  assert.equal(originLabel('vm', FIXTURE_DENYLIST), 'cloud');
  assert.equal(originLabel('', FIXTURE_DENYLIST), '?');
  assert.equal(originLabel(undefined, FIXTURE_DENYLIST), '?');
});

test('originLabel with no denylist argument degrades every host to cloud (config-less default)', () => {
  assert.equal(originLabel('WORKSTATION-A1'), 'cloud'); // personal-data-ok: fixture
});

test('renderTable marks the head row and keeps the box aligned under mixed widths + emoji', () => {
  const entries = [
    {
      slug: 'long-slug-aaaaaaaaaaaaaaaaaaaa',
      lane: '🟩',
      enqueuedIso: '2026-06-15T13:26:00Z',
      host: FIXTURE_DENYLIST[0], // must match the configured denylist so this row renders "local"
    },
    { slug: 'short', lane: '🟥', enqueuedIso: '2026-06-15T14:03:00Z', host: 'vm' },
  ];
  const out = renderTable(entries, 'long-slug-aaaaaaaaaaaaaaaaaaaa', {
    nowMs: NOW,
    localHostDenylist: FIXTURE_DENYLIST,
  });
  const lines = out.split('\n');

  // Top border, header, separator, 2 rows, bottom border = 6 lines.
  assert.equal(lines.length, 6);
  // Head row marked, non-head row not.
  assert.match(lines[3], /1 \(head\)/);
  assert.doesNotMatch(lines[4], /head/);
  assert.match(lines[4], /\b2\b/);
  assert.match(lines[3], /🟩 free/);
  assert.match(lines[4], /🟥 seed/);
  // Plain ASCII since plan 2932 — the 🖥 that used to sit here is exactly the
  // uncertain-width glyph that broke this box's alignment for local rows.
  assert.match(lines[3], /\blocal\b/);
  assert.match(lines[4], /\bcloud\b/);

  // Every rendered line is the same visual width (the alignment invariant).
  const widths = new Set(lines.map((l) => dispWidth(l)));
  assert.equal(widths.size, 1, `box not aligned: widths ${[...widths]}`);
});

test('plan 2328: renderTable surfaces the ⚡ priority class in the Lane cell, box still aligned', () => {
  const entries = [
    { slug: 'head-plan', lane: '🟥', enqueuedIso: '2026-07-24T10:00:00Z' },
    { slug: 'urgent', lane: '🟩', priority: true, enqueuedIso: '2026-07-24T10:05:00Z' },
    { slug: 'normal', lane: '🟩', enqueuedIso: '2026-07-24T10:06:00Z' },
  ];
  const out = renderTable(entries, 'head-plan', { nowMs: NOW });
  const lines = out.split('\n');
  assert.match(lines[4], /🟩 free ⚡/);
  assert.doesNotMatch(lines[5], /⚡/);
  const widths = new Set(lines.map((l) => dispWidth(l)));
  assert.equal(widths.size, 1, `box not aligned: widths ${[...widths]}`);
});

// ── plan 2524: Waiting column + head-state line ───────────────────────────────

test('plan 2524: the Waiting column reports age since enqueue, box still aligned', () => {
  const entries = [
    { slug: 'head-plan', lane: '🟩', enqueuedIso: '2026-07-26T17:40:00Z', host: 'WORKSTATION-001' },
    { slug: 'fresh', lane: '🟩', enqueuedIso: '2026-07-26T19:46:00Z', host: 'WORKSTATION-001' },
  ];
  const lines = renderTable(entries, 'head-plan', { nowMs: NOW }).split('\n');
  assert.match(lines[1], /Waiting/); // header present
  assert.match(lines[3], /2h20m/);
  assert.match(lines[4], /\b14m\b/);
  assert.equal(new Set(lines.map((l) => dispWidth(l))).size, 1);
});

test('plan 2524: a ⚡ priority row may sit ABOVE an older row — Waiting makes that visible', () => {
  // The real 2026-07-26 queue: 2459 (⚡, enqueued 19:50) inserted at the front block, ahead of
  // 2490 (enqueued 17:40). The column must show the younger row higher up, not "fix" the order.
  const entries = [
    { slug: 'head', lane: '🟩', enqueuedIso: '2026-07-26T17:34:00Z' },
    { slug: 'priority-jumper', lane: '🟩', priority: true, enqueuedIso: '2026-07-26T19:50:00Z' },
    { slug: 'older-waiter', lane: '🟩', enqueuedIso: '2026-07-26T17:40:00Z' },
  ];
  const lines = renderTable(entries, 'head', { nowMs: NOW }).split('\n');
  assert.match(lines[4], /10m/); // the ⚡ jumper, younger
  assert.match(lines[5], /2h20m/); // the row it jumped, older
});

test('plan 2524: an unparseable enqueue timestamp renders ? — never NaN', () => {
  const lines = renderTable([{ slug: 's', lane: '🟩', enqueuedIso: 'garbage' }], 's', {
    nowMs: NOW,
  }).split('\n');
  assert.doesNotMatch(lines[3], /NaN/);
  assert.match(lines[3], /\?/);
  assert.equal(new Set(lines.map((l) => dispWidth(l))).size, 1);
});

test('plan 2524: headLine reports land PROGRESS when stamped', () => {
  const line = headLine(
    {
      slug: '2493-Infra-x',
      state: 'HOLDING',
      progressIso: '2026-07-26T19:50:00Z',
      heartbeatIso: '2026-07-26T19:59:00Z',
    },
    NOW,
  );
  assert.match(line, /2493-Infra-x/);
  assert.match(line, /state HOLDING/);
  assert.match(line, /last land progress 10m ago/);
  assert.doesNotMatch(line, /heartbeat/); // progress wins; no ambiguity
});

test('plan 2524: headLine falls back to the heartbeat and SAYS it is a heartbeat', () => {
  // A heartbeat means "the session is alive"; progress means "the land moved". Reporting the
  // former under the latter's label is the plan-2485 conflation this line must not commit.
  const line = headLine(
    { slug: 's', state: null, progressIso: null, heartbeatIso: '2026-07-26T19:00:00Z' },
    NOW,
  );
  assert.match(line, /no land progress recorded/);
  assert.match(line, /last heartbeat 1h00m ago/);
  assert.match(line, /state —/); // absent state renders a dash, not "null"
});

test('plan 2524: headLine returns null when the head entry is missing', () => {
  assert.equal(headLine(undefined, NOW), null);
});

test('findScriptsFile: survives this module moving to scripts/coord/ (plan 3962 P1)', () => {
  // landing-queue.mjs is NOT moving with landing-queue-board.mjs. Simulate this module living
  // one level deeper (its post-move location) and confirm the sibling still resolves to the
  // real scripts/ directory, not scripts/coord/. No coord.config.json anywhere — there is none
  // in the real scripts/test-helpers/isolated-plan-repo.mjs fixture either (see
  // findScriptsFile's doc comment), so this deliberately does not create one.
  const root = mkdtempSync(join(tmpdir(), 'vetapp-scripts-file-'));
  try {
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir);
    writeFileSync(join(scriptsDir, 'landing-queue.mjs'), '// stub');
    const simulatedCoordDir = join(scriptsDir, 'coord');
    mkdirSync(simulatedCoordDir);
    assert.equal(
      findScriptsFile('landing-queue.mjs', scriptsDir),
      join(scriptsDir, 'landing-queue.mjs'),
    );
    assert.equal(
      findScriptsFile('landing-queue.mjs', simulatedCoordDir),
      join(scriptsDir, 'landing-queue.mjs'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findScriptsFile: post-move resolution does NOT depend on the sibling existing on disk', () => {
  // The regression class an earlier (existsSync-based) version of this walk was still exposed
  // to: if the sibling has not been WRITTEN yet, an existence probe finds nothing at any
  // ancestor and falls back to `join(startDir, name)` — scripts/coord/landing-queue.mjs, the
  // wrong directory, exactly the class of bug this whole fix exists to close. Anchoring on the
  // `scripts` directory NAME (not on whether landing-queue.mjs is present) must still resolve
  // correctly here, with landing-queue.mjs never created at all.
  const root = mkdtempSync(join(tmpdir(), 'vetapp-scripts-file-nofile-'));
  try {
    const scriptsDir = join(root, 'scripts');
    const simulatedCoordDir = join(scriptsDir, 'coord');
    mkdirSync(simulatedCoordDir, { recursive: true }); // landing-queue.mjs is never written
    assert.equal(
      findScriptsFile('landing-queue.mjs', simulatedCoordDir),
      join(scriptsDir, 'landing-queue.mjs'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findScriptsFile: pre-move (module directly IN scripts/) resolves with zero ancestor walk', () => {
  // The other direction of the same invariant: called from a directory whose own basename is
  // already `scripts` (today's real location, before plan 3962's move), no walk is needed.
  const root = mkdtempSync(join(tmpdir(), 'vetapp-scripts-file-premove-'));
  try {
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir);
    assert.equal(
      findScriptsFile('landing-queue.mjs', scriptsDir),
      join(scriptsDir, 'landing-queue.mjs'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findScriptsFile: falls back to alongside startDir when no ancestor is named scripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'vetapp-scripts-file-no-anchor-'));
  try {
    assert.equal(findScriptsFile('landing-queue.mjs', root), join(root, 'landing-queue.mjs'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findScriptsFile: resolves against the REAL isolated-plan-repo.mjs fixture, from a simulated scripts/coord/ location', async () => {
  // The exact mechanism a sister worker's module broke against (a repo-root-marker walk found
  // no marker in this fixture and silently resolved wrong): makeIsolatedRepo copies the WHOLE
  // scripts/ tool tree, nested dirs included, into <tmp>/scripts/ — no coord.config.json, no
  // other repo-root file, ever. scripts/coord/ is part of that copy, so simulating this
  // module's post-move location is just pointing startDir at the fixture's own copied
  // scripts/coord/ — no synthetic tree needed.
  const { makeIsolatedRepo } = await import('../test-helpers/isolated-plan-repo.mjs');
  const repo = makeIsolatedRepo({
    prefix: 'landing-queue-board-fixture',
    basename: '9999-Test-fixture-only.md',
    body: '# fixture plan\n',
  });
  try {
    const simulatedCoordDir = join(repo.scriptsDir, 'coord');
    assert.ok(existsSync(simulatedCoordDir), 'fixture must have copied scripts/coord/');
    assert.equal(
      findScriptsFile('landing-queue.mjs', simulatedCoordDir),
      join(repo.scriptsDir, 'landing-queue.mjs'),
    );
  } finally {
    repo.cleanup();
  }
});
