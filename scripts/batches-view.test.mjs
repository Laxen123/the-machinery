// scripts/batches-view.test.mjs (plan 1373, Task 5; path-move + --html plan 1430)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseBatchesTable,
  parseFableLane,
  parseNotBatched,
  parseDependenciesBlock,
  parseProposedMd,
  findMemberPlan,
  modelIcon,
  depsForBatch,
  renderDepsCell,
  annotateBatch,
  renderFlagCell,
  dispWidth,
  renderTable,
  resolveProposedPath,
  legacyDeprecationMessage,
  escapeHtml,
  renderRosterHtml,
  parsePlanBasename,
  extractCostLine,
  truncateText,
  scanReadyPlans,
  groupReadyPlans,
  batchMembershipMap,
  renderReadyRoster,
  loadBatchFolders,
  hasBatchFolders,
  loadFolderRoster,
  legacyManifestSlugs,
  resolveRoster,
} from './batches-view.mjs';
// plan 3341 delta-review follow-up (key 2740d4): the single source for the (lane, marker,
// test) triple effectiveLane's filename-segment FALLBACK now walks generically — imported
// here so the new coverage test below builds its fixtures from the table itself, never a
// hardcoded 'FABLE-'/'SOL-' literal.
import { LANE_SEGMENTS } from './coord/lint-filename-execmodel-drift.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./batches-view.mjs', import.meta.url));

// A fixture proposed.md carrying: a table with two batches, a Fable-lane
// section, a Not-batched section, and a ## Dependencies block (D4 format) —
// one edge that only touches batch-alpha's members, one batch-vs-batch
// overlap, one edge with a reason, and a comment line to prove it's ignored.
const FIXTURE_WITH_DEPS = `# Proposed execution batches

## Batches (all members ready + specced + sonnet, banners homogeneous per batch)

| Batch slug | Lane | Members | Theme |
|---|---|---|---|
| \`batch-alpha\` | 🟩 | 100, 101 | Alpha theme. |
| \`batch-beta\` | 🟥 | 200, 201 | Beta theme. |

## Fable lane (NOT batch-train — orchestrated-execution, Sonnet conductor can't ride these)

- \`300\` (something) — ready/, \`execModel: fable\`; runs via orchestrated-execution.

## Not batched (ready/ singles), with reasons

- \`400\` — no coherent partner. Run solo.

## Dependencies

\`\`\`dependencies
100 blocked-by 200
batch-alpha overlaps batch-beta : record-034 shard collision
# a comment line, ignored
101 order-after 999
this line is junk and must not crash the parser
\`\`\`
`;

// Same batches/lane/singles content, MINUS the ## Dependencies section —
// the shape of the LIVE proposed.md at authoring time (D4 not emitted yet).
const FIXTURE_NO_DEPS = FIXTURE_WITH_DEPS.slice(0, FIXTURE_WITH_DEPS.indexOf('## Dependencies'));

// findMemberPlan (plan 1373 review fix G) resolves plan ids via the canonical
// lsPlans/resolvePlanRel/statusOf helpers (scripts/move-plan.mjs), which read
// the git index — so the fixture must be a real (if minimal) git repo with the
// plan files actually tracked under docs/superpowers/plans/<status>/, not a
// bare directory tree.
function makePlansFixture() {
  const root = mkdtempSync(join(tmpdir(), 'batches-view-plans-'));
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.autocrlf', 'false');
  const readyDir = join(root, 'docs', 'superpowers', 'plans', 'ready');
  const inProgressDir = join(root, 'docs', 'superpowers', 'plans', 'in-progress');
  mkdirSync(readyDir, { recursive: true });
  mkdirSync(inProgressDir, { recursive: true });
  // 100: ready/, plain sonnet plan (no execModel key at all — default sonnet).
  writeFileSync(
    join(readyDir, '100-DQ-alpha-member-one.md'),
    "---\nsummary: 'alpha one'\n---\n\n# 100 alpha one\n",
  );
  // 101: ready/, FABLE- filename segment + matching frontmatter.
  writeFileSync(
    join(readyDir, '101-FABLE-DQ-alpha-member-two.md'),
    "---\nsummary: 'alpha two'\nexecModel: fable\n---\n\n# 101 alpha two\n",
  );
  // 200: drifted — claimed into in-progress/ since the roster was written.
  writeFileSync(
    join(inProgressDir, '200-Infra-beta-member-one.md'),
    "---\nsummary: 'beta one'\n---\n\n# 200 beta one\n",
  );
  // 201: intentionally absent (simulates a member whose plan can't be found).
  g('add', '-A');
  g('commit', '-qm', 'seed plans');
  return root;
}

// plan 3341: adds a `102` sol member (ready/, SOL- filename segment + matching frontmatter,
// mirroring 101's fable shape) to an EXISTING makePlansFixture() root, as its own commit —
// kept OUT of makePlansFixture itself so the many exact-total-count assertions elsewhere in
// this file (scanReadyPlans/renderReadyRoster CLI tests) don't have to know about a fixture
// member they never asked for.
function addSolMember(root) {
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  const readyDir = join(root, 'docs', 'superpowers', 'plans', 'ready');
  writeFileSync(
    join(readyDir, '102-SOL-DQ-alpha-member-three.md'),
    "---\nsummary: 'alpha three'\nexecModel: sol\n---\n\n# 102 alpha three\n",
  );
  g('add', '-A');
  g('commit', '-qm', 'add sol member');
}

// plan 3341 review (finding D, key c40606): a `103` member whose FILENAME carries a FABLE-
// segment but whose FRONTMATTER explicitly says `execModel: sonnet` — the drifted state
// effectiveLane() must resolve per "frontmatter is truth", never per the filename. This is
// exactly the shape lint-filename-execmodel-drift.mjs would flag on a real push; the fixture
// exists only to pin THIS view's read, not to claim the drift itself is a valid steady state.
function addFilenameFrontmatterDriftMember(root) {
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  const readyDir = join(root, 'docs', 'superpowers', 'plans', 'ready');
  writeFileSync(
    join(readyDir, '103-FABLE-DQ-alpha-member-four.md'),
    "---\nsummary: 'alpha four'\nexecModel: sonnet\n---\n\n# 103 alpha four\n",
  );
  g('add', '-A');
  g('commit', '-qm', 'add drifted member');
}

// plan 3341 delta-review follow-up (key 2740d4): a member per LANE_SEGMENTS row whose
// filename carries the marker but whose frontmatter carries NO execModel key at all — the
// only shape that actually exercises effectiveLane's filename-segment FALLBACK. Every
// pre-existing fixture (101, 102, 103 above) sets a matching (or deliberately conflicting)
// execModel in frontmatter too, so `raw !== ''` short-circuits before the fallback code ever
// runs — the fallback branch this finding fixed had ZERO coverage before this. Ids start at
// 110 to stay clear of every other fixture id in this file; built from LANE_SEGMENTS' own
// `marker`/`lane` fields, never a hardcoded 'FABLE-'/'SOL-' pair, so a future third
// segment-bearing lane is covered here with no test-file edit.
function addSegmentOnlyMembers(root) {
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  const readyDir = join(root, 'docs', 'superpowers', 'plans', 'ready');
  const ids = [];
  LANE_SEGMENTS.forEach(({ lane, marker }, i) => {
    const id = String(110 + i);
    ids.push({ id, lane });
    writeFileSync(
      join(readyDir, `${id}-${marker}DQ-segment-only-${lane}.md`),
      `---\nsummary: 'segment-only ${lane}'\n---\n\n# ${id} segment-only ${lane}\n`,
    );
  });
  g('add', '-A');
  g('commit', '-qm', 'add segment-only members (no frontmatter execModel)');
  return ids;
}

// A theme carrying HTML-unsafe characters, to prove --html escapes roster
// text (plan 1430 Task B) rather than injecting it verbatim.
const FIXTURE_WITH_SCRIPT = FIXTURE_WITH_DEPS.replace(
  'Alpha theme.',
  'Alpha theme <script>alert(1)</script> & "quoted".',
);

// Builds on makePlansFixture, additionally writing the roster md at either
// the NEW canonical path, the LEGACY path, or neither (`where: null`), for
// CLI-level (subprocess) tests of path resolution + the --html renderer.
function makeRosterFixture({ where = 'new', content = FIXTURE_WITH_SCRIPT } = {}) {
  const root = makePlansFixture();
  if (where) {
    const dir =
      where === 'new'
        ? join(root, 'docs', 'superpowers', 'batches')
        : join(root, 'docs', 'handoff', 'batches');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'proposed.md'), content);
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'add roster']);
  }
  return root;
}

test('parseBatchesTable extracts slug/lane/members/theme rows', () => {
  const rows = parseBatchesTable(FIXTURE_WITH_DEPS);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    slug: 'batch-alpha',
    lane: '🟩',
    members: ['100', '101'],
    theme: 'Alpha theme.',
  });
  assert.deepEqual(rows[1], {
    slug: 'batch-beta',
    lane: '🟥',
    members: ['200', '201'],
    theme: 'Beta theme.',
  });
});

test('parseFableLane / parseNotBatched read the informational bullet sections', () => {
  assert.equal(parseFableLane(FIXTURE_WITH_DEPS).length, 1);
  assert.match(parseFableLane(FIXTURE_WITH_DEPS)[0], /^`300`/);
  assert.equal(parseNotBatched(FIXTURE_WITH_DEPS).length, 1);
  assert.match(parseNotBatched(FIXTURE_WITH_DEPS)[0], /^`400`/);
});

test('parseDependenciesBlock parses edges, a reason suffix, skips comments and junk', () => {
  const edges = parseDependenciesBlock(FIXTURE_WITH_DEPS);
  assert.deepEqual(edges, [
    { left: '100', relation: 'blocked-by', right: '200', reason: '' },
    {
      left: 'batch-alpha',
      relation: 'overlaps',
      right: 'batch-beta',
      reason: 'record-034 shard collision',
    },
    { left: '101', relation: 'order-after', right: '999', reason: '' },
  ]);
});

test('parseDependenciesBlock degrades gracefully with no ## Dependencies heading', () => {
  assert.deepEqual(parseDependenciesBlock(FIXTURE_NO_DEPS), []);
  assert.deepEqual(parseDependenciesBlock(''), []);
  assert.deepEqual(parseDependenciesBlock('# just a title, no sections at all'), []);
});

// The live fence hazard (plan 2052 R1): docs/superpowers/batches/dependencies.md's real
// ```dependencies fence LEADS with a "# Reconciled …" board-pass comment line before any
// edges — a level-aware scan without fence-awareness would read that comment as an H1
// terminator and truncate the section before the fence (and every edge in it) is ever
// reached. This fixture reproduces that exact shape, plus a trailing section to prove the
// bound still lands correctly on the REAL next heading, not the in-fence one.
test('parseDependenciesBlock: a leading "# Reconciled …" comment inside the fence does not truncate it (dependencies.md fence hazard)', () => {
  const withLeadingComment = `## Dependencies

\`\`\`dependencies
# Reconciled 2026-07-19 board-pass — nine plans swept, verdicts below.
100 blocked-by 200
101 order-after 999
\`\`\`

## Next section

unrelated trailing content
`;
  assert.deepEqual(parseDependenciesBlock(withLeadingComment), [
    { left: '100', relation: 'blocked-by', right: '200', reason: '' },
    { left: '101', relation: 'order-after', right: '999', reason: '' },
  ]);
});

test('parseProposedMd composes all four sections; deps empty when absent', () => {
  const withDeps = parseProposedMd(FIXTURE_WITH_DEPS);
  assert.equal(withDeps.batches.length, 2);
  assert.equal(withDeps.dependencies.length, 3);

  const noDeps = parseProposedMd(FIXTURE_NO_DEPS);
  assert.equal(noDeps.batches.length, 2); // batches table unaffected by the absent section
  assert.deepEqual(noDeps.dependencies, []);
});

test('depsForBatch matches edges touching the slug OR any member id, on either side', () => {
  const deps = parseDependenciesBlock(FIXTURE_WITH_DEPS);
  const alpha = { slug: 'batch-alpha', members: ['100', '101'] };
  const beta = { slug: 'batch-beta', members: ['200', '201'] };
  assert.equal(depsForBatch(deps, alpha).length, 3); // 100-blocked-by-200, overlaps, 101-order-after
  assert.equal(depsForBatch(deps, beta).length, 2); // 100-blocked-by-200 (right side), overlaps
});

test('renderDepsCell renders "—" for no edges, else joined edge text with reasons', () => {
  assert.equal(renderDepsCell([]), '—');
  assert.equal(
    renderDepsCell([{ left: '1373', relation: 'blocked-by', right: '1371', reason: '' }]),
    '1373 blocked-by 1371',
  );
  assert.equal(
    renderDepsCell([
      { left: 'a', relation: 'overlaps', right: 'b', reason: 'record-034' },
      { left: 'c', relation: 'order-after', right: 'd', reason: '' },
    ]),
    'a overlaps b (record-034); c order-after d',
  );
});

test('findMemberPlan: found in ready/ with default sonnet model', (t) => {
  const root = makePlansFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const m = findMemberPlan(root, '100');
  assert.equal(m.found, true);
  assert.equal(m.folder, 'ready');
  assert.equal(m.execModel, 'sonnet');
  assert.equal(modelIcon(m), '🟢');
});

test('findMemberPlan: fable via frontmatter + FABLE- filename segment', (t) => {
  const root = makePlansFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const m = findMemberPlan(root, '101');
  assert.equal(m.found, true);
  assert.equal(m.folder, 'ready');
  assert.equal(m.execModel, 'fable');
  assert.equal(modelIcon(m), '🟣');
});

// plan 3341: sol via frontmatter + SOL- filename segment, mirroring the fable case above.
test('findMemberPlan: sol via frontmatter + SOL- filename segment', (t) => {
  const root = makePlansFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  addSolMember(root);
  const m = findMemberPlan(root, '102');
  assert.equal(m.found, true);
  assert.equal(m.folder, 'ready');
  assert.equal(m.execModel, 'sol');
  assert.equal(modelIcon(m), '🔶');
});

// plan 3341 review (finding D, key c40606): FRONTMATTER IS TRUTH, even when a FABLE-/SOL-
// filename segment says otherwise. Before the fix, `effectiveLane` checked the filename
// segment REGARDLESS of what the frontmatter said, so this plan (explicit `execModel: sonnet`,
// stale `FABLE-` filename) silently reported as fable.
test('findMemberPlan: an explicit frontmatter execModel wins over a disagreeing FABLE- segment', (t) => {
  const root = makePlansFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  addFilenameFrontmatterDriftMember(root);
  const m = findMemberPlan(root, '103');
  assert.equal(m.found, true);
  assert.equal(
    m.execModel,
    'sonnet',
    'frontmatter is truth — the stale FABLE- segment must not win',
  );
  assert.equal(modelIcon(m), '🟢');
});

// plan 3341 delta-review follow-up (key 2740d4): the filename-segment FALLBACK, table-driven
// over LANE_SEGMENTS rather than a hardcoded two-marker ternary. Honest characterization
// (fix-r3's own instruction): with only 'fable'/'sol' real markers today, the hardcoded
// ternary this replaced (`hasFableSegment(basename) ? 'fable' : hasSolSegment(basename) ?
// 'sol' : raw`) resolves EVERY case here identically to the new generic
// `LANE_SEGMENTS.find(...)` walk — mutual exclusivity + the same fable-then-sol precedence
// order means a revert of just this diff does not flip this test red. What it DOES pin: the
// fallback branch itself had NO test coverage before this (every other segment fixture in
// this file also sets a matching/conflicting frontmatter execModel, so `raw !== ''` always
// short-circuited past the fallback code). A hypothetical third marker was verified
// separately (scratch mutation harness, not committed here, since LANE_SEGMENTS is frozen
// and owned by plan-lane-segments.mjs, out of this fix's scope): the old hardcoded ternary
// resolves an unknown marker to '' (silently sonnet), the new LANE_SEGMENTS.find resolves it
// to the correct lane.
test('findMemberPlan: filename-segment fallback resolves EVERY LANE_SEGMENTS lane when frontmatter carries no execModel at all', (t) => {
  const root = makePlansFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ids = addSegmentOnlyMembers(root);
  assert.ok(ids.length >= 2, 'expected at least fable/sol rows to exercise this');
  for (const { id, lane } of ids) {
    const m = findMemberPlan(root, id);
    assert.equal(m.found, true, `member ${id} not found`);
    assert.equal(
      m.execModel,
      lane,
      `member ${id} (marker-only, no frontmatter execModel) should resolve to "${lane}"`,
    );
  }
});

test('findMemberPlan: drifted into in-progress/ is still found, just not ready/', (t) => {
  const root = makePlansFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const m = findMemberPlan(root, '200');
  assert.equal(m.found, true);
  assert.equal(m.folder, 'in-progress');
});

test('findMemberPlan: not found (no matching file anywhere)', (t) => {
  const root = makePlansFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const m = findMemberPlan(root, '201');
  assert.equal(m.found, false);
  assert.equal(m.folder, null);
  assert.equal(modelIcon(m), '❓');
});

// plan 2556: a fable member is a LANE LABEL, not a warning. It used to set `flagged`, which
// counted the row in the terminal footer's "(N flagged ⚠)" and listed it under the HTML
// "drift flags" — telling the operator a runnable train was broken. Since plan 2556 a fable
// batch has an executor (a heavy local session via /local-drain's Modification 3, or the
// fable-full cloud routine's Fable-batch section), so the two axes are now separate:
// `hasNonSonnetMember` routes, `flagged` warns. (Renamed from `fableLane` by plan 3341 review
// finding A — see annotateBatch's own comment for why the old name was actively misleading.)
test('annotateBatch labels a fable member as a LANE, and flags a drifted member as a warning', (t) => {
  const root = makePlansFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deps = parseDependenciesBlock(FIXTURE_WITH_DEPS);
  const [alphaRow, betaRow] = parseBatchesTable(FIXTURE_WITH_DEPS);

  const alpha = annotateBatch(root, alphaRow, deps);
  assert.deepEqual(alpha.nonSonnetIds, { fable: ['101'] });
  assert.deepEqual(alpha.driftIds, []); // both 100 and 101 sit in ready/
  assert.equal(alpha.hasNonSonnetMember, true);
  assert.equal(alpha.flagged, false, 'a fable-only row is routed, not warned about');
  assert.equal(renderFlagCell(alpha), '🟣 fable(101)');

  const beta = annotateBatch(root, betaRow, deps);
  assert.deepEqual(beta.nonSonnetIds, {});
  assert.deepEqual(beta.driftIds, ['200', '201']); // in-progress/ + not-found
  assert.equal(beta.hasNonSonnetMember, false);
  assert.equal(beta.flagged, true);
  assert.equal(renderFlagCell(beta), '⚠ drift(200,201)');
});

// plan 3341: a sol member is neither fable nor sonnet — it must get its OWN bucket in the
// lane-keyed tally, not be folded into "fable" or silently dropped.
test('plan 3341: annotateBatch labels a sol member as its own lane, distinct from fable', (t) => {
  const root = makePlansFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  addSolMember(root);
  const gammaRow = { slug: 'batch-gamma', members: ['100', '102'], theme: 'Gamma theme.' };
  const gamma = annotateBatch(root, gammaRow, []);
  assert.deepEqual(gamma.nonSonnetIds, { sol: ['102'] });
  assert.equal(gamma.hasNonSonnetMember, true, 'a sol-only batch must also flip this flag');
  assert.equal(gamma.flagged, false);
  assert.equal(renderFlagCell(gamma), '🔶 sol(102)');
});

// Both axes at once: a drifted fable batch is still a genuine warning, and the cell carries
// the lane label AND the drift flag, in that order.
test('annotateBatch: a fable batch that has ALSO drifted is both routed and flagged', (t) => {
  const root = makePlansFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const row = { nonSonnetIds: { fable: ['101'] }, driftIds: ['200'] };
  assert.equal(renderFlagCell(row), '🟣 fable(101) ⚠ drift(200)');
});

test('renderFlagCell returns "—" when nothing is flagged', () => {
  const clean = { nonSonnetIds: {}, driftIds: [] };
  assert.equal(renderFlagCell(clean), '—');
});

test('dispWidth counts an emoji/warning glyph as 2 cells, ascii as 1', () => {
  assert.equal(dispWidth('abc'), 3);
  assert.equal(dispWidth('🟢'), 2);
  assert.equal(dispWidth('🟢 🟣'), 5); // 2 + 1 + 2
});

// Review fix D (plan 1373): ⚠ (U+26A0) and ❓ (U+2753) are BMP, not astral —
// codePointAt(0) < 0x1f000 for both, so the old range-only check missed them
// and flagged rows misaligned. They must count as width 2 like the astral
// lane/model markers.
test('dispWidth: ⚠ and ❓ (BMP, not astral) count as width 2, same as astral markers', () => {
  // sanity: both really are BMP codepoints (< 0x1f000) — the range check alone
  // would treat them as width 1 without the explicit WIDE_BMP_GLYPHS set.
  assert.ok('⚠'.codePointAt(0) < 0x1f000 && '❓'.codePointAt(0) < 0x1f000);
  assert.equal(dispWidth('⚠'), 2);
  assert.equal(dispWidth('❓'), 2);
  assert.equal(dispWidth('⚠ drift(101)'), 2 + ' drift(101)'.length);
});

test('renderTable stays box-aligned end to end (full fixture, graceful no-deps path)', (t) => {
  const root = makePlansFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const parsed = parseProposedMd(FIXTURE_NO_DEPS); // the degrade path: no ## Dependencies at all
  const rows = parsed.batches.map((b) => annotateBatch(root, b, parsed.dependencies));
  assert.equal(rows.length, 2);

  const out = renderTable(rows);
  const lines = out.split('\n');
  // top border, header, separator, 2 data rows, bottom border
  assert.equal(lines.length, 6);
  assert.match(lines[1], /Batch slug/);
  assert.match(lines[1], /Model/);
  assert.match(lines[1], /Dependencies/);
  assert.match(lines[1], /Flag/);
  // deps column degrades to "—" everywhere when no Dependencies block exists
  assert.match(lines[3], /—/);
  assert.match(lines[4], /—/);
  // flags still fire off the live plan-folder scan even with no deps block.
  // 🟣 not ⚠ on the fable row since plan 2556 — a lane label, not a warning. Both glyphs
  // are dispWidth 2 (⚠ is BMP-but-wide, 🟣 astral), so the box stays aligned either way.
  assert.match(lines[3], /🟣 fable\(101\)/);
  assert.match(lines[4], /⚠ drift\(200,201\)/);
  // NOTE: box-alignment itself is NOT re-checked here via `dispWidth(line)` —
  // measuring the rendered output with the SAME function that produced it is
  // self-referential (a dispWidth regression that undercounts a glyph would
  // undercount it identically on both the padding side and this check, so
  // the two would still "agree" even though the box visually misaligns in a
  // real terminal). See the dedicated ground-truth test below instead.
});

// Ground-truth box-alignment test (review fix F, plan 1373): the expected
// string below was generated from an INDEPENDENT reference dispWidth
// implementation (not batches-view.mjs's own), then pasted in as a literal —
// it can never silently agree with a regression in the module's dispWidth,
// unlike a check that re-measures the module's own output with itself. The
// 'b' row's Flag cell carries ⚠ (the exact BMP glyph the bug undercounted),
// which is also the column's widest cell — a regression there shows up as
// the Flag column's border shrinking by one dash and the ⚠ row's trailing
// `│` no longer lining up with the row above/below it.
test('renderTable: box alignment matches an independently-computed ground truth (⚠ in Flag)', () => {
  const rowA = {
    slug: 'a',
    lane: 'L',
    members: ['1'],
    memberInfo: [{ found: true, execModel: 'sonnet' }],
    deps: [],
    nonSonnetIds: {},
    driftIds: [],
  };
  const rowB = {
    slug: 'b',
    lane: 'L',
    members: ['2'],
    memberInfo: [{ found: true, execModel: 'sonnet' }],
    deps: [],
    nonSonnetIds: {},
    driftIds: ['2'], // ⇒ renderFlagCell(rowB) === '⚠ drift(2)'
  };
  const expected = [
    '┌────────────┬──────┬─────────┬───────┬──────────────┬─────────────┐',
    '│ Batch slug │ Lane │ Members │ Model │ Dependencies │ Flag        │',
    '├────────────┼──────┼─────────┼───────┼──────────────┼─────────────┤',
    '│ a          │ L    │ 1       │ 🟢    │ —            │ —           │',
    '│ b          │ L    │ 2       │ 🟢    │ —            │ ⚠ drift(2) │',
    '└────────────┴──────┴─────────┴───────┴──────────────┴─────────────┘',
  ].join('\n');
  assert.equal(renderTable([rowA, rowB]), expected);
});

test('renderTable handles an empty row set without crashing', () => {
  const out = renderTable([]);
  assert.match(out, /Batch slug/);
});

// ── Path resolution (plan 1430: roster moved to docs/superpowers/batches/) ──

test('resolveProposedPath: new path wins when both new and legacy exist', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'batches-view-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const newDir = join(root, 'docs', 'superpowers', 'batches');
  const legacyDir = join(root, 'docs', 'handoff', 'batches');
  mkdirSync(newDir, { recursive: true });
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(newDir, 'proposed.md'), 'new content');
  writeFileSync(join(legacyDir, 'proposed.md'), 'legacy content');

  const resolved = resolveProposedPath(root);
  assert.equal(resolved.legacy, false);
  assert.equal(resolved.path, join(newDir, 'proposed.md'));
});

test('resolveProposedPath: falls back to legacy path when only it exists', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'batches-view-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacyDir = join(root, 'docs', 'handoff', 'batches');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'proposed.md'), 'legacy content');

  const resolved = resolveProposedPath(root);
  assert.equal(resolved.legacy, true);
  assert.equal(resolved.path, join(legacyDir, 'proposed.md'));
});

test('resolveProposedPath: neither path exists', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'batches-view-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resolved = resolveProposedPath(root);
  assert.equal(resolved.path, null);
  assert.equal(resolved.legacy, false);
});

test('legacyDeprecationMessage names both the legacy AND new path', () => {
  const msg = legacyDeprecationMessage();
  assert.match(msg, /docs\/handoff\/batches\/proposed\.md/);
  assert.match(msg, /docs\/superpowers\/batches\/proposed\.md/);
});

test('CLI: reads the NEW path silently (no deprecation warning on stderr)', (t) => {
  const root = makeRosterFixture({ where: 'new' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = execFileSync('node', [SCRIPT_PATH], { cwd: root, encoding: 'utf8' });
  assert.match(out, /batch-alpha/);
  assert.doesNotMatch(out, /reading legacy/);
});

test('CLI: falls back to the LEGACY path and warns on stderr, still renders', (t) => {
  const root = makeRosterFixture({ where: 'legacy' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const res = spawnSync('node', [SCRIPT_PATH], { cwd: root, encoding: 'utf8' });
  assert.match(res.stdout, /batch-alpha/);
  assert.match(res.stderr, /reading legacy docs\/handoff\/batches\/proposed\.md/);
  assert.match(res.stderr, /docs\/superpowers\/batches\/proposed\.md \(plan 1430\)/);
});

test('CLI: both paths missing — message names the NEW path', (t) => {
  const root = makeRosterFixture({ where: null });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = execFileSync('node', [SCRIPT_PATH], { cwd: root, encoding: 'utf8' });
  assert.match(out, /no docs\/superpowers\/batches\/proposed\.md found/);
});

// ── --html mode (plan 1430 Task B) ──────────────────────────────────────────

// F8: escapeHtml is now the canonical scripts/lib/decision-dossier/inline.mjs helper
// (re-exported from batches-view.mjs), whose escape set is `&<>"` only — no single
// quote, since every attribute this module interpolates escaped data into is
// double-quoted (verified above the HTML_STYLE block in batches-view.mjs).
test('escapeHtml escapes the four HTML-significant characters (canonical set: & < > ")', () => {
  assert.equal(
    escapeHtml(`<script>alert('x')</script> & "y"`),
    `&lt;script&gt;alert('x')&lt;/script&gt; &amp; &quot;y&quot;`,
  );
});

test('renderRosterHtml escapes roster-sourced text and includes every batch/member', () => {
  const parsed = parseProposedMd(FIXTURE_WITH_SCRIPT);
  const rows = parsed.batches.map((b) => ({
    ...b,
    memberInfo: b.members.map(() => ({ found: true, execModel: 'sonnet' })),
    nonSonnetIds: {},
    driftIds: [],
    deps: [],
    flagged: false,
  }));
  const html = renderRosterHtml({
    rows,
    parsed,
    sourceRel: 'docs/superpowers/batches/proposed.md',
    generatedAt: new Date('2026-07-05T00:00:00Z'),
  });
  // every batch slug + member id present
  assert.match(html, /batch-alpha/);
  assert.match(html, /batch-beta/);
  for (const id of ['100', '101', '200', '201']) assert.match(html, new RegExp(id));
  // the raw script tag must never appear unescaped
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&amp; &quot;quoted&quot;/);
  // Fable lane / Not batched / Dependencies sections present
  assert.match(html, /300/);
  assert.match(html, /400/);
  assert.match(html, /order-after/);
});

// F4: renderBatchCardHtml's `<h3>${row.lane} ...` interpolated the roster's lane cell
// raw (every other field was escaped). Lane comes straight from the `| Lane |` column
// of the roster table, which a malformed/hand-edited proposed.md could carry HTML in.
test('renderRosterHtml escapes the lane cell (F4 — was interpolated unescaped in the card <h3>)', () => {
  const rows = [
    {
      slug: 'batch-xss',
      lane: '<script>alert(2)</script>',
      members: ['999'],
      theme: 'x',
      memberInfo: [{ found: true, execModel: 'sonnet' }],
      nonSonnetIds: {},
      driftIds: [],
      deps: [],
      flagged: false,
    },
  ];
  const parsed = { fableLane: [], notBatched: [], dependencies: [] };
  const html = renderRosterHtml({
    rows,
    parsed,
    sourceRel: 'docs/superpowers/batches/proposed.md',
    generatedAt: new Date('2026-07-05T00:00:00Z'),
  });
  assert.doesNotMatch(html, /<script>alert\(2\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});

test('CLI --html: writes the default .scratch/batches-view.html with every batch/member', (t) => {
  const root = makeRosterFixture({ where: 'new' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = execFileSync('node', [SCRIPT_PATH, '--html'], { cwd: root, encoding: 'utf8' }).trim();
  const expectedPath = join(root, '.scratch', 'batches-view.html');
  assert.equal(out, expectedPath);
  assert.ok(existsSync(expectedPath));
  const html = readFileSync(expectedPath, 'utf8');
  assert.match(html, /batch-alpha/);
  assert.match(html, /batch-beta/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test('CLI --html <outPath>: an explicit outPath overrides the default', (t) => {
  const root = makeRosterFixture({ where: 'new' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const explicit = join(root, 'custom-dir', 'roster.html');
  const out = execFileSync('node', [SCRIPT_PATH, '--html', explicit], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  assert.equal(out, explicit);
  assert.ok(existsSync(explicit));
  assert.ok(!existsSync(join(root, '.scratch', 'batches-view.html')));
});

test('CLI text mode output is unchanged when --html is not passed', (t) => {
  const root = makeRosterFixture({ where: 'new' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = execFileSync('node', [SCRIPT_PATH], { cwd: root, encoding: 'utf8' });
  assert.match(out, /Proposed batches: 2/);
  assert.match(out, /┌/); // the box-drawn table, not HTML
  assert.doesNotMatch(out, /<html/);
});

// ── Ready-plan roster: category + title + cost (plan 1496) ──────────────────

test('parsePlanBasename: id + category, FABLE- segment skipped, junk degrades to "?"', () => {
  assert.deepEqual(parsePlanBasename('1450-UI-wire-fracture.md'), {
    id: '1450',
    category: 'UI',
    rest: 'wire-fracture',
  });
  // FABLE- is a model segment, not the category
  assert.deepEqual(parsePlanBasename('1015-FABLE-DQ-stockholm-sweep.md'), {
    id: '1015',
    category: 'DQ',
    rest: 'stockholm-sweep',
  });
  // plan 3341: SOL- is also a model segment, not the category — before the fix this parsed as
  // category 'SOL', rest 'DQ-stockholm-sweep' (a bogus category, real one swallowed into rest).
  assert.deepEqual(parsePlanBasename('1015-SOL-DQ-stockholm-sweep.md'), {
    id: '1015',
    category: 'DQ',
    rest: 'stockholm-sweep',
  });
  assert.deepEqual(parsePlanBasename('1386-P07-avmaskning.md'), {
    id: '1386',
    category: 'P07',
    rest: 'avmaskning',
  });
  const junk = parsePlanBasename('README.md');
  assert.equal(junk.id, null);
  assert.equal(junk.category, '?');
});

// (H1 extraction reuses readH1 from build-index-lib.mjs — covered by the
// scanReadyPlans test below and build-index-lib's own tests.)

test('extractCostLine strips blockquote/bold/emoji/label decoration', () => {
  const content = [
    '# Title',
    '',
    '> 🟩 **SEED-WRITE: NO.**',
    '',
    '> 💰 **Cost forecast:** ~$8–12 (dir audit). Spend approved.',
    '',
    'body',
  ].join('\n');
  assert.equal(extractCostLine(content), '~$8–12 (dir audit). Spend approved.');
  // label variant with a parenthetical, matched case-insensitively on the words
  assert.equal(
    extractCostLine('> 💰 **Cost forecast (per pass):** ~$8-10 expected.'),
    '~$8-10 expected.',
  );
  assert.equal(extractCostLine('# no banner here'), null);
});

test('truncateText: pass-through under max, ellipsis at max', () => {
  assert.equal(truncateText('short', 10), 'short');
  assert.equal(truncateText('abcdefghij', 5), 'abcd…');
  // codepoint-aware: an astral emoji at the cut must survive whole, never a
  // lone surrogate (review 1496 finding 3)
  assert.equal(truncateText('🟢🟢🟢', 2), '🟢…');
  assert.doesNotMatch(truncateText('ab🟢cd', 4), /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
});

test('scanReadyPlans: ready/ only, sorted by id, model + title/cost fallbacks', (t) => {
  const root = makePlansFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entries = scanReadyPlans(root);
  // 200 (in-progress/) excluded; 100 + 101 (ready/) in id order
  assert.deepEqual(
    entries.map((e) => e.id),
    ['100', '101'],
  );
  assert.equal(entries[0].category, 'DQ');
  assert.equal(entries[0].execModel, 'sonnet');
  assert.equal(entries[1].execModel, 'fable'); // FABLE- segment + frontmatter
  assert.equal(entries[0].title, '100 alpha one'); // H1 present in the fixture
  assert.equal(entries[0].cost, null); // fixture plans carry no 💰 banner
});

// plan 3341: a sol member's execModel resolves through the same shared table as fable's —
// added via addSolMember (not the shared makePlansFixture) so this stays the only
// scanReadyPlans test that knows about a third ready/ member.
test('plan 3341: scanReadyPlans resolves a sol member via frontmatter + SOL- segment, real category', (t) => {
  const root = makePlansFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  addSolMember(root);
  const entries = scanReadyPlans(root);
  // sorted by id ascending: 100, 101, 102 — asserted positionally now that parsePlanBasename's
  // SOL- fix means the category is no longer swallowed/mislabelled.
  assert.deepEqual(
    entries.map((e) => e.id),
    ['100', '101', '102'],
  );
  assert.equal(entries[2].execModel, 'sol');
  assert.equal(entries[2].category, 'DQ', 'the real category, not the bogus "SOL" bucket');
});

test('groupReadyPlans orders groups biggest-first, ties alphabetical', () => {
  const e = (id, category) => ({ id, category });
  const groups = groupReadyPlans([e('1', 'UI'), e('2', 'DQ'), e('3', 'DQ'), e('4', 'Infra')]);
  assert.deepEqual(
    groups.map((g) => g.category),
    ['DQ', 'Infra', 'UI'],
  );
  assert.equal(groups[0].entries.length, 2);
});

test('batchMembershipMap maps each member id to its first batch slug', () => {
  const map = batchMembershipMap([
    { slug: 'batch-a', members: ['100', '101'] },
    { slug: 'batch-b', members: ['101', '200'] }, // 101 already claimed by batch-a
  ]);
  assert.equal(map.get('100'), 'batch-a');
  assert.equal(map.get('101'), 'batch-a');
  assert.equal(map.get('200'), 'batch-b');
});

test('renderReadyRoster: grouped lines, fable icon, no-💰 fallback, [in batch] annotation', () => {
  const entries = [
    { id: '100', category: 'DQ', execModel: 'sonnet', title: 'Fix the thing', cost: '$0 LLM.' },
    { id: '101', category: 'DQ', execModel: 'fable', title: 'Big sweep', cost: null },
    { id: '300', category: 'UI', execModel: 'sonnet', title: 'Polish', cost: '<$2.' },
  ];
  const out = renderReadyRoster(entries, new Map([['100', 'batch-a']]));
  assert.match(out, /Ready plans by category \(3 total, 1 🟣 fable/);
  assert.match(out, /^ {2}DQ \(2\):$/m);
  assert.match(out, /^ {4}100 🟢 Fix the thing — \$0 LLM\. \[in batch-a\]$/m);
  assert.match(out, /^ {4}101 🟣 Big sweep — no 💰 line$/m);
  assert.match(out, /^ {2}UI \(1\):$/m);
  assert.equal(renderReadyRoster([]), 'Ready plans: none in ready/.');
});

// plan 3341: a `sol` entry must count as its own lane in the header (not silently folded into
// "fable" or dropped from the total), while the fable-only header stays byte-identical when no
// sol entry is present (proven by the test just above, unchanged).
test('plan 3341: renderReadyRoster surfaces a sol entry as its own lane, icon, and header count', () => {
  const entries = [
    { id: '100', category: 'DQ', execModel: 'sonnet', title: 'Fix the thing', cost: '$0 LLM.' },
    { id: '102', category: 'DQ', execModel: 'sol', title: 'Sol job', cost: null },
  ];
  const out = renderReadyRoster(entries);
  assert.match(out, /Ready plans by category \(2 total, 0 🟣 fable; 1 🔶 sol;/);
  assert.match(out, /^ {4}102 🔶 Sol job — no 💰 line$/m);
});

test('CLI text mode appends the ready roster section', (t) => {
  const root = makeRosterFixture({ where: 'new' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = execFileSync('node', [SCRIPT_PATH], { cwd: root, encoding: 'utf8' });
  assert.match(out, /Ready plans by category \(2 total, 1 🟣 fable/);
  assert.match(out, /100 🟢 100 alpha one — no 💰 line \[in batch-alpha\]/);
  assert.match(out, /101 🟣 101 alpha two — no 💰 line \[in batch-alpha\]/);
});

test('CLI: ready roster still prints when proposed.md is missing entirely', (t) => {
  const root = makeRosterFixture({ where: null });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = execFileSync('node', [SCRIPT_PATH], { cwd: root, encoding: 'utf8' });
  assert.match(out, /no docs\/superpowers\/batches\/proposed\.md found/);
  assert.match(out, /Ready plans by category \(2 total/);
});

test('renderRosterHtml: ready roster section present, escaped, defaults empty for old callers', () => {
  const parsed = { fableLane: [], notBatched: [], dependencies: [] };
  const base = {
    rows: [],
    parsed,
    sourceRel: 'docs/superpowers/batches/proposed.md',
    generatedAt: new Date('2026-07-06T00:00:00Z'),
  };
  // old call shape (no readyEntries) keeps working — section degrades to "None"
  assert.match(
    renderRosterHtml(base),
    /Ready plans by category<\/h2><p>None in <code>ready\/<\/code>/,
  );
  const html = renderRosterHtml({
    ...base,
    readyEntries: [
      {
        id: '9',
        category: 'DQ',
        execModel: 'sonnet',
        title: 'Title <script>alert(3)</script>',
        cost: null,
      },
    ],
    memberBatch: new Map([['9', 'batch-x']]),
  });
  assert.match(html, /DQ \(1\)/);
  assert.doesNotMatch(html, /<script>alert\(3\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.match(html, /\[in batch-x\]/);
});

// ── Batch-folder source (plan 1467) ─────────────────────────────────────────

// A minimal batch-folder tree: docs/superpowers/batches/<slug>/batch.md per batch,
// a global dependencies.md, and a README.md carrying the fable/not-batched prose.
function writeBatchFolder(
  root,
  slug,
  { lane, members, gate = 'null', status = 'proposed', theme },
) {
  const dir = join(root, 'docs', 'superpowers', 'batches', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'batch.md'),
    [
      '---',
      `slug: ${slug}`,
      `lane: ${lane}`,
      `members: [${members.join(', ')}]`,
      `gate: ${gate}`,
      `status: ${status}`,
      '---',
      '',
      `# ${slug}`,
      '',
      theme,
      '',
    ].join('\n'),
  );
}

function makeFolderFixture() {
  const root = makePlansFixture();
  writeBatchFolder(root, 'batch-alpha', {
    lane: '🟩',
    members: ['100', '101'],
    theme: 'Alpha theme.',
  });
  writeBatchFolder(root, 'batch-beta', {
    lane: '🟥',
    members: ['200', '201'],
    theme: 'Beta theme.',
  });
  // a GATED batch (a blocker in `gate:`) — must render in the table too (plan 1467 acceptance)
  writeBatchFolder(root, 'batch-gated', {
    lane: '🟥',
    members: ['200'],
    gate: 'plan 999 lands',
    theme: 'Gated theme.',
  });
  // a CLAIMED batch — lifecycle history, NOT part of the claimable roster table
  writeBatchFolder(root, 'batch-claimed', {
    lane: '🟩',
    members: ['100'],
    status: 'claimed',
    theme: 'Claimed theme.',
  });
  const batchesDir = join(root, 'docs', 'superpowers', 'batches');
  writeFileSync(
    join(batchesDir, 'dependencies.md'),
    '## Dependencies\n\n```dependencies\n100 blocked-by 200\nbatch-alpha overlaps batch-beta : record-034\n```\n',
  );
  writeFileSync(
    join(batchesDir, 'README.md'),
    '# Batches\n\n## Fable lane\n\n- `300` runs via orchestrated-execution.\n\n## Not batched\n\n- `400` — run solo.\n',
  );
  return root;
}

test('loadBatchFolders: one row per batch.md, gate/status carried, archive/ skipped', (t) => {
  const root = makeFolderFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // a reserved archive/ dir must never surface as a batch
  mkdirSync(join(root, 'docs', 'superpowers', 'batches', 'archive', 'old'), { recursive: true });
  const rows = loadBatchFolders(root);
  const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));
  assert.deepEqual(Object.keys(bySlug).sort(), [
    'batch-alpha',
    'batch-beta',
    'batch-claimed',
    'batch-gated',
  ]);
  assert.deepEqual(bySlug['batch-alpha'].members, ['100', '101']);
  assert.equal(bySlug['batch-gated'].gate, 'plan 999 lands');
  assert.equal(bySlug['batch-claimed'].status, 'claimed');
  assert.equal(hasBatchFolders(root), true);
});

test('loadFolderRoster: only PROPOSED batches in the table; deps + fable/not-batched from neighbors', (t) => {
  const root = makeFolderFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parsed = loadFolderRoster(root);
  // claimed batch excluded; proposed + gated included
  assert.deepEqual(parsed.batches.map((b) => b.slug).sort(), [
    'batch-alpha',
    'batch-beta',
    'batch-gated',
  ]);
  assert.equal(parsed.dependencies.length, 2);
  assert.equal(parsed.fableLane.length, 1);
  assert.match(parsed.fableLane[0], /^`300`/);
  assert.equal(parsed.notBatched.length, 1);
  assert.match(parsed.notBatched[0], /^`400`/);
});

test('resolveRoster: prefers the folder tree over a proposed.md fallback', (t) => {
  const root = makeFolderFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // also drop a proposed.md — the folder tree must win
  const batchesDir = join(root, 'docs', 'superpowers', 'batches');
  writeFileSync(join(batchesDir, 'proposed.md'), FIXTURE_WITH_DEPS);
  const roster = resolveRoster(root);
  assert.equal(roster.source, 'folders');
  assert.equal(roster.sourceRel, 'docs/superpowers/batches');
  assert.deepEqual(roster.parsed.batches.map((b) => b.slug).sort(), [
    'batch-alpha',
    'batch-beta',
    'batch-gated',
  ]);
});

test('resolveRoster: falls back to proposed.md when no batch folders exist', (t) => {
  const root = makeRosterFixture({ where: 'new', content: FIXTURE_WITH_DEPS });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const roster = resolveRoster(root);
  assert.equal(roster.source, 'proposed');
  assert.equal(roster.parsed.batches.length, 2);
});

test('renderFlagCell surfaces a gate note for a gated batch', () => {
  assert.equal(
    renderFlagCell({ nonSonnetIds: {}, driftIds: [], gate: 'plan 999 lands' }),
    '⛔ gate(plan 999 lands)',
  );
  assert.equal(
    renderFlagCell({ nonSonnetIds: {}, driftIds: ['200'], gate: 'x lands' }),
    '⚠ drift(200) ⛔ gate(x lands)',
  );
});

test('annotateBatch carries the gate through so renderFlagCell can show it', (t) => {
  const root = makeFolderFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gated = loadBatchFolders(root).find((b) => b.slug === 'batch-gated');
  const row = annotateBatch(root, gated, []);
  assert.equal(row.gate, 'plan 999 lands');
  assert.match(renderFlagCell(row), /⛔ gate\(plan 999 lands\)/);
});

test('legacyManifestSlugs lists grandfathered old-path manifests, [] when the dir is absent', (t) => {
  const root = makeFolderFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(legacyManifestSlugs(root), []);
  const legacyDir = join(root, 'docs', 'handoff', 'batches');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'batch-old.json'), '{}');
  assert.deepEqual(legacyManifestSlugs(root), ['batch-old']);
});

test('CLI: renders proposed + gated batches from the folder tree, not proposed.md', (t) => {
  const root = makeFolderFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'add batch folders']);
  const out = execFileSync('node', [SCRIPT_PATH], { cwd: root, encoding: 'utf8' });
  assert.match(out, /Proposed batches: 3/);
  assert.match(out, /batch-alpha/);
  assert.match(out, /batch-gated/);
  assert.match(out, /⛔ gate\(plan 999 lands\)/);
  // claimed batch is lifecycle history, never in the claimable table
  assert.doesNotMatch(out, /batch-claimed/);
  // fable/not-batched prose from README.md
  assert.match(out, /orchestrated-execution/);
  // dependencies.md parsed (batch-alpha's edges resolve, not "no ## Dependencies block")
  assert.doesNotMatch(out, /no ## Dependencies block/);
});

// plan 3341 review (finding A, keys 65921f/19fad0/6ffba7/6d2ef3): an all-sol batch used to
// print as "(N flagged ⚠) (N 🟣 fable-lane)" — the legacy `fableLane`/`fableRows` boolean
// counted ANY non-sonnet member as fable, actively misrouting the operator to the wrong
// executor. The summary line must name the ACTUAL lane present (sol), never fable, and must
// never mention fable at all when no fable member exists on the board.
test('CLI summary line: an all-sol batch reports as sol-lane, never mislabelled fable-lane', (t) => {
  // A minimal fixture with NO fable member anywhere, so the summary's lane tally isolates
  // sol cleanly — makeFolderFixture's batch-alpha already carries a fable member (101), which
  // would legitimately co-occur in the summary and muddy this assertion.
  const root = makePlansFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  addSolMember(root);
  writeBatchFolder(root, 'batch-gamma', {
    lane: '🟩',
    members: ['100', '102'],
    theme: 'Gamma theme (sol-only).',
  });
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'add sol-only batch']);
  const out = execFileSync('node', [SCRIPT_PATH], { cwd: root, encoding: 'utf8' });
  assert.match(out, /Proposed batches: 1 \(1 🔶 sol-lane\)\./);
  assert.doesNotMatch(out, /fable-lane/);
});
