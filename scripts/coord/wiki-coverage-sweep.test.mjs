// scripts/coord/wiki-coverage-sweep.test.mjs (plan 1082)
// Unit tests for the wiki coverage sweep. The analysis core is pure (dateOf injected), so
// these run with no git and no clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseFrontmatter,
  normalizeSource,
  classifySource,
  extractWikilinks,
  isExternalPath,
  isIsoDate,
  analyze,
  renderReport,
  loadPages,
  sweepIsDue,
  SEED_STALE_DAYS,
  findStaleStatusClaims,
  findDeadCitedPaths,
  hotCacheAge,
  summaryLine,
  planFolderIndexFromListing,
  PENDING_WORDING_RX,
  repoPathVerdict,
  trackedPrefixSet,
} from './wiki-coverage-sweep.mjs';

// ── sweepIsDue (cadence gate) ─────────────────────────────────────────────────
test('sweepIsDue: bootstrap on first sweep, then every N lands; never on unknown count', () => {
  assert.equal(sweepIsDue(850, null, 10), true); // never swept → bootstrap
  assert.equal(sweepIsDue(859, 850, 10), false); // 9 lands since → not due
  assert.equal(sweepIsDue(860, 850, 10), true); // exactly 10 → due
  assert.equal(sweepIsDue(875, 850, 10), true); // overdue → due
  assert.equal(sweepIsDue(null, 850, 10), false); // couldn't count archive → skip
});

// ── isIsoDate + malformed-frontmatter handling ────────────────────────────────
test('isIsoDate: only a bare YYYY-MM-DD is valid', () => {
  assert.equal(isIsoDate('2026-06-21'), true);
  assert.equal(isIsoDate('2026-06'), false);
  assert.equal(isIsoDate('June 2026'), false);
  assert.equal(isIsoDate(''), false);
  assert.equal(isIsoDate(null), false);
});

test('analyze: a subject page with a non-ISO updated: is flagged malformed, never drift/NaN', () => {
  const pages = [
    { name: 'bad', base: 'bad', updated: 'June 2026', sources: ['backend/src/a.ts'], links: [] },
    { name: 'none', base: 'none', updated: null, sources: ['backend/src/b.ts'], links: [] },
  ];
  const r = analyze(pages, () => '2026-06-25'); // source newer than any plausible parse
  assert.equal(r.drifted.length, 0); // never produces a NaN/garbage drift row
  assert.deepEqual(r.malformed.map((m) => m.page).sort(), ['bad', 'none']);
  assert.equal(r.hasFindings, true); // malformed counts as an actionable finding
});

// ── orphan identity: links resolve by filename slug, not the page `name:` ──────
test('analyze: a page whose name differs from its filename is not a false orphan', () => {
  const pages = [
    // file `hub.md` links the target by filename slug `leaf`
    {
      name: 'hub',
      base: 'hub',
      updated: '2026-06-01',
      sources: ['backend/src/h.ts'],
      links: ['leaf'],
    },
    // file `leaf.md` carries a display name that differs from its filename
    {
      name: 'Leaf Subject',
      base: 'leaf',
      updated: '2026-06-01',
      sources: ['backend/src/l.ts'],
      links: [],
    },
  ];
  const r = analyze(pages, () => '2026-05-01');
  // 'leaf' is linked by hub via its filename slug → NOT an orphan despite name!=filename.
  assert.equal(
    r.orphans.some((o) => o.page === 'Leaf Subject'),
    false,
  );
});

// ── meta detection via type: frontmatter (not just the filename allowlist) ─────
test('analyze: a page with type:meta is excluded as subject AND as an inbound-link source', () => {
  const pages = [
    // a NEW front-door page, type:meta, NOT in the hardcoded META_PAGES filename allowlist
    {
      name: 'glossary',
      base: 'glossary',
      type: 'meta',
      updated: '2026-06-01',
      sources: [],
      links: ['lonely'],
    },
    {
      name: 'lonely',
      base: 'lonely',
      type: 'entity',
      updated: '2026-06-01',
      sources: ['backend/src/c.ts'],
      links: [],
    },
  ];
  const r = analyze(pages, () => '2026-05-01');
  assert.equal(r.subjects, 1); // glossary (type:meta) is not a subject
  assert.equal(
    r.orphans.some((o) => o.page === 'glossary'),
    false,
  ); // glossary itself is never an orphan candidate (excluded by type:meta)
  // glossary links 'lonely' but counts as a META source → 'lonely' is catalog-only (advisory),
  // NOT a non-meta inbound and NOT a hard orphan.
  assert.deepEqual(
    r.catalogOnly.map((o) => o.page),
    ['lonely'],
  );
  assert.equal(r.orphans.length, 0);
});

// ── parseFrontmatter ──────────────────────────────────────────────────────────
test('parseFrontmatter: scalars + sources block list', () => {
  const text = `---
name: booking-inspector
type: entity
updated: 2026-06-21
sources:
  - docs/runbooks/inspector-agents.md
  - backend/scripts/sweep/lane_b_dispatch.py (code)
  - backend/scripts/booking-repilot/_classifier.py (code)
---

# Body
`;
  const fm = parseFrontmatter(text);
  assert.equal(fm.found, true);
  assert.equal(fm.name, 'booking-inspector');
  assert.equal(fm.updated, '2026-06-21');
  assert.deepEqual(fm.sources, [
    'docs/runbooks/inspector-agents.md',
    'backend/scripts/sweep/lane_b_dispatch.py (code)',
    'backend/scripts/booking-repilot/_classifier.py (code)',
  ]);
});

test('parseFrontmatter: no frontmatter → found:false', () => {
  assert.equal(parseFrontmatter('# Just a body\nno frontmatter').found, false);
});

test('parseFrontmatter: a scalar after the sources block ends the block', () => {
  const text = `---
sources:
  - a.ts
  - b.py
updated: 2026-06-01
---
`;
  const fm = parseFrontmatter(text);
  assert.deepEqual(fm.sources, ['a.ts', 'b.py']);
  assert.equal(fm.updated, '2026-06-01');
});

test('parseFrontmatter: an indented comment inside the sources block does NOT truncate it', () => {
  const text = `---
sources:
  - a.ts
  # a note about the next one
  - b.py
updated: 2026-06-01
---
`;
  const fm = parseFrontmatter(text);
  assert.deepEqual(fm.sources, ['a.ts', 'b.py']); // b.py survives the interleaved comment
  assert.equal(fm.updated, '2026-06-01'); // a top-level key still ends the block
});

// ── normalizeSource ───────────────────────────────────────────────────────────
test('normalizeSource: strips (code), trailing slash, whitespace', () => {
  assert.equal(
    normalizeSource('backend/scripts/data-pipeline/ (code)'),
    'backend/scripts/data-pipeline',
  );
  assert.equal(normalizeSource('  shared/src/schemas.ts  '), 'shared/src/schemas.ts');
  assert.equal(
    normalizeSource('backend/src/adapters/acme-cloud.ts'),
    'backend/src/adapters/acme-cloud.ts',
  );
});

// ── classifySource ────────────────────────────────────────────────────────────
test('classifySource: json→data, ts/py/mjs→code, md→doc', () => {
  assert.equal(classifySource('backend/src/data/seed-records.json'), 'data');
  assert.equal(classifySource('backend/src/adapters/acme-cloud.ts'), 'code');
  assert.equal(classifySource('backend/scripts/_record_gates.py'), 'code');
  assert.equal(classifySource('scripts/done-worktree.mjs'), 'code');
  assert.equal(classifySource('docs/runbooks/data-sources.md'), 'doc');
});

test('classifySource: code-root dir → code; (code) tag forces code; else other', () => {
  assert.equal(classifySource('backend/scripts/data-pipeline/ (code)'), 'code');
  assert.equal(classifySource('backend/scripts/data-pipeline/'), 'code');
  assert.equal(classifySource('frontend/src/lib/record-static'), 'code');
  assert.equal(classifySource('some/weird/path (code)'), 'code');
  assert.equal(classifySource('some/weird/path.txt'), 'other');
});

// ── isExternalPath ────────────────────────────────────────────────────────────
test('isExternalPath: absolute, URL, and ..-escape are external; repo-relative is not', () => {
  assert.equal(
    isExternalPath('C:/Users/user/Desktop/Claude/Hobby/tandapp/backend/src/adapters/muntra.ts'),
    true,
  );
  assert.equal(isExternalPath('/etc/hosts'), true);
  assert.equal(isExternalPath('https://example.com/x'), true);
  assert.equal(isExternalPath('../tandapp/backend/src/adapters/muntra.ts'), true);
  assert.equal(isExternalPath('backend/src/adapters/muntra.ts'), false);
  assert.equal(isExternalPath('docs/runbooks/data-sources.md'), false);
});

test('analyze: an external (cross-repo) source is neither drift nor dead-ref', () => {
  const pages = [
    {
      name: 'muntra',
      base: 'muntra',
      updated: '2026-06-01',
      sources: [
        'backend/src/adapters/muntra.ts',
        'C:/Users/user/tandapp/backend/src/adapters/muntra.ts',
      ],
      links: [],
    },
  ];
  // local source is OLD (no drift); external must be skipped entirely (dateOf never sees it as dead)
  const dateOf = (p) => (p === 'backend/src/adapters/muntra.ts' ? '2026-05-01' : null);
  const r = analyze(pages, dateOf);
  assert.equal(r.drifted.length, 0);
  assert.equal(r.deadRefs.length, 0); // the absolute tandapp path is external, not a dead ref
});

// ── extractWikilinks ──────────────────────────────────────────────────────────
test('extractWikilinks: plain, aliased, anchored, deduped', () => {
  const text =
    'See [[acme-cloud]] and [[booking-inspector|the booking inspector]] plus [[layers#guard]] and [[acme-cloud]] again.';
  const links = extractWikilinks(text).sort();
  assert.deepEqual(links, ['acme-cloud', 'booking-inspector', 'layers']);
});

// ── analyze: drift ────────────────────────────────────────────────────────────
test('analyze: flags a page whose code source is newer than updated:, ranked by drift', () => {
  const pages = [
    {
      name: 'alpha',
      base: 'alpha',
      updated: '2026-06-01',
      sources: ['backend/src/a.ts'],
      links: ['beta'],
    },
    {
      name: 'beta',
      base: 'beta',
      updated: '2026-06-20',
      sources: ['backend/src/b.ts'],
      links: ['alpha'],
    },
  ];
  const dateOf = (p) =>
    ({ 'backend/src/a.ts': '2026-06-25', 'backend/src/b.ts': '2026-06-22' })[p] ?? null;
  const r = analyze(pages, dateOf);
  assert.equal(r.drifted.length, 2);
  // alpha drift = 24d, beta drift = 2d → alpha ranks first
  assert.equal(r.drifted[0].page, 'alpha');
  assert.equal(r.drifted[0].driftDays, 24);
  assert.equal(r.drifted[1].page, 'beta');
  assert.equal(r.drifted[1].driftDays, 2);
});

test('analyze: a source committed on/before updated: is NOT drift', () => {
  const pages = [
    {
      name: 'alpha',
      base: 'alpha',
      updated: '2026-06-25',
      sources: ['backend/src/a.ts'],
      links: [],
    },
  ];
  const dateOf = () => '2026-06-25'; // same day → benefit of the doubt
  const r = analyze(pages, dateOf);
  assert.equal(r.drifted.length, 0);
});

// ── analyze: dead refs ────────────────────────────────────────────────────────
test('analyze: a source that no longer resolves is a dead ref, not drift', () => {
  const pages = [
    {
      name: 'alpha',
      base: 'alpha',
      updated: '2026-06-01',
      sources: ['backend/src/gone.ts'],
      links: [],
    },
  ];
  const dateOf = () => null;
  const r = analyze(pages, dateOf);
  assert.equal(r.drifted.length, 0);
  assert.equal(r.deadRefs.length, 1);
  assert.deepEqual(r.deadRefs[0].missing, ['backend/src/gone.ts']);
});

// ── analyze: seed-behind bucket ───────────────────────────────────────────────
test('analyze: seed drift under threshold is ignored; over threshold is flagged', () => {
  const near = [
    {
      name: 'a',
      base: 'a',
      updated: '2026-06-20',
      sources: ['backend/src/data/seed-records.json'],
      links: [],
    },
  ];
  const far = [
    {
      name: 'b',
      base: 'b',
      updated: '2026-05-01',
      sources: ['backend/src/data/seed-records.json'],
      links: [],
    },
  ];
  const dateOf = () => '2026-06-25';
  assert.equal(analyze(near, dateOf).seedBehind.length, 0); // 5 days behind < threshold
  const r = analyze(far, dateOf);
  assert.equal(r.seedBehind.length, 1); // 55 days behind > threshold
  assert.ok(r.seedBehind[0].daysBehind > SEED_STALE_DAYS);
  assert.equal(r.drifted.length, 0); // seed is NOT counted as definitional drift
});

// ── analyze: orphans + meta exclusion ─────────────────────────────────────────
test('analyze: orphan tiers — true orphan (0 inbound) vs catalog-only (meta-only inbound)', () => {
  const pages = [
    { name: 'index', base: 'index', updated: '2026-06-01', sources: [], links: ['lonely'] }, // meta: links the catalog page
    {
      name: 'hub',
      base: 'hub',
      updated: '2026-06-01',
      sources: ['backend/src/a.ts'],
      links: ['linked'],
    }, // linked by nobody
    {
      name: 'linked',
      base: 'linked',
      updated: '2026-06-01',
      sources: ['backend/src/b.ts'],
      links: [],
    }, // inbound from hub (non-meta)
    {
      name: 'lonely',
      base: 'lonely',
      updated: '2026-06-01',
      sources: ['backend/src/c.ts'],
      links: [],
    }, // linked ONLY by meta index
    {
      name: 'ghost',
      base: 'ghost',
      updated: '2026-06-01',
      sources: ['backend/src/d.ts'],
      links: [],
    }, // linked by NOBODY
  ];
  const dateOf = () => '2026-05-01'; // all sources old → no drift
  const r = analyze(pages, dateOf);
  // 'hub' has 0 inbound (nobody links it). 'ghost' has 0 inbound. → true orphans.
  assert.deepEqual(r.orphans.map((o) => o.page).sort(), ['ghost', 'hub']);
  // 'lonely' is reachable ONLY via the meta index → catalog-only (advisory).
  assert.deepEqual(r.catalogOnly.map((o) => o.page).sort(), ['lonely']);
  // 'linked' has a non-meta inbound → neither bucket.
  assert.equal(r.hasFindings, true); // true orphans count as findings
});

test('analyze: a page with no sources is not a drift subject', () => {
  const pages = [
    { name: 'doc-graph', base: 'doc-graph', updated: '2026-01-01', sources: [], links: ['x'] },
  ];
  const r = analyze(pages, () => '2026-06-25');
  assert.equal(r.subjects, 0);
  assert.equal(r.drifted.length, 0);
});

// ── noSources bucket ──────────────────────────────────────────────────────────
test('analyze: a non-meta subject page with no sources: is flagged noSources; computed-from and meta pages are exempt', () => {
  // The meta `index` links every subject so nothing lands in the (actionable) orphans bucket —
  // this isolates the noSources bucket and proves it alone never flips hasFindings.
  const pages = [
    { name: 'bare', base: 'bare', type: 'concept', updated: '2026-07-01', sources: [], links: [] },
    {
      name: 'computed',
      base: 'computed',
      type: 'concept',
      updated: '2026-07-01',
      sources: [],
      computedFrom: true,
      links: [],
    },
    {
      name: 'index',
      base: 'index',
      type: 'index',
      updated: '2026-07-01',
      sources: [],
      links: ['bare', 'computed', 'ok'],
    },
    {
      name: 'ok',
      base: 'ok',
      type: 'concept',
      updated: '2026-07-01',
      sources: ['backend/src/a.ts'],
      links: [],
    },
  ];
  const r = analyze(pages, () => '2026-06-01');
  assert.deepEqual(r.noSources, [{ page: 'bare', type: 'concept' }]);
  assert.equal(r.subjects, 1); // only `ok` is a drift subject
  assert.equal(r.orphans.length, 0); // index links every subject → no orphans
  assert.equal(r.hasFindings, false); // advisory — never blocks the manual exit code
});

test('analyze: a noSources page with no type: reports "(none)"', () => {
  const pages = [{ name: 'bare', base: 'bare', updated: '2026-07-01', sources: [], links: [] }];
  const r = analyze(pages, () => '2026-06-01');
  assert.deepEqual(r.noSources, [{ page: 'bare', type: '(none)' }]);
});

test('renderReport: the NO-SOURCES section lists unsourced pages, else reads None', () => {
  const flagged = analyze(
    [
      {
        name: 'bare',
        base: 'bare',
        type: 'concept',
        updated: '2026-07-01',
        sources: [],
        links: [],
      },
    ],
    () => null,
  );
  const md = renderReport(flagged, { generated: '2026-07-09', landingIndex: 1, trigger: 'manual' });
  assert.match(md, /## 3d\. NO-SOURCES/);
  assert.match(md, /- \*\*bare\*\* \(type: concept\)/);

  const clean = analyze([], () => null);
  const mdClean = renderReport(clean, {
    generated: '2026-07-09',
    landingIndex: 1,
    trigger: 'manual',
  });
  assert.match(mdClean, /_None — every subject page declares provenance\._/);
});

test('loadPages: forwards computedFrom from a computed-from: frontmatter key', () => {
  const root = mkdtempSync(join(tmpdir(), 'wcs-'));
  try {
    mkdirSync(join(root, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(
      join(root, 'wiki', 'concepts', 'doc-graph.md'),
      '---\nname: doc-graph\nupdated: 2026-07-01\ncomputed-from:\n  - grep -rn "docs/" docs/\n---\nbody\n',
    );
    writeFileSync(
      join(root, 'wiki', 'concepts', 'plain.md'),
      '---\nname: plain\nupdated: 2026-07-01\n---\nbody\n',
    );
    const pages = loadPages(root);
    assert.equal(pages.find((p) => p.name === 'doc-graph').computedFrom, true);
    assert.equal(pages.find((p) => p.name === 'plain').computedFrom, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── renderReport ──────────────────────────────────────────────────────────────
test('renderReport: frontmatter + all four sections + clean banner', () => {
  const clean = analyze([], () => null);
  const md = renderReport(clean, {
    generated: '2026-06-26',
    landingIndex: 851,
    trigger: 'on-land',
  });
  assert.match(md, /^---\n/);
  assert.match(md, /landing_index: 851/);
  assert.match(md, /trigger: on-land/);
  assert.match(md, /## 1\. Drifted subjects/);
  assert.match(md, /## 2\. Dead source references/);
  assert.match(md, /## 3\. Orphans/);
  assert.match(md, /## 3b\. Catalog-only/);
  assert.match(md, /## 3c\. Malformed frontmatter/);
  assert.match(md, /## 3d\. NO-SOURCES/);
  assert.match(md, /## 4\. Seed-behind/);
  assert.match(md, /summary: .*, \d+ no-sources/); // advisory bucket must appear in the INDEX-blurb summary line
  assert.match(md, /Clean sweep/);
});

test('renderReport: a drifted row renders the page + source + drift', () => {
  const pages = [
    {
      name: 'alpha',
      base: 'alpha',
      updated: '2026-06-01',
      sources: ['backend/src/a.ts'],
      links: [],
    },
  ];
  const r = analyze(pages, () => '2026-06-25');
  const md = renderReport(r, { generated: '2026-06-26', landingIndex: null, trigger: 'manual' });
  assert.match(md, /\[\[alpha\]\]/);
  assert.match(md, /backend\/src\/a\.ts/);
  assert.doesNotMatch(md, /Clean sweep/);
});

// ── loadPages (filesystem, no git) ────────────────────────────────────────────
test('loadPages: reads wiki/*.md recursively into page objects', () => {
  const root = mkdtempSync(join(tmpdir(), 'wcs-'));
  try {
    mkdirSync(join(root, 'wiki', 'entities'), { recursive: true });
    writeFileSync(
      join(root, 'wiki', 'index.md'),
      '---\nname: index\ntype: index\n---\n[[acme-cloud]]\n',
    );
    writeFileSync(
      join(root, 'wiki', 'entities', 'acme-cloud.md'),
      '---\nname: acme-cloud\nupdated: 2026-06-21\nsources:\n  - backend/src/adapters/acme-cloud.ts\n---\nbody\n',
    );
    const pages = loadPages(root);
    assert.equal(pages.length, 2);
    const pc = pages.find((p) => p.name === 'acme-cloud');
    assert.equal(pc.updated, '2026-06-21');
    assert.deepEqual(pc.sources, ['backend/src/adapters/acme-cloud.ts']);
    assert.equal(pc.file, 'wiki/entities/acme-cloud.md');
    const idx = pages.find((p) => p.name === 'index');
    assert.deepEqual(idx.links, ['acme-cloud']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Stale-status / dead-cited-path / hot-cache-age buckets (plan 4125) ────────
// The three classes the 2026-09-22 wiki stale review found mechanically detectable. All three
// are pure and dependency-injected (plan folder, filesystem existence, today's date) exactly
// like analyze(dateOf), so these run with no git, no clock and no filesystem.
test('findStaleStatusClaims: pending wording beside an ARCHIVED plan id is flagged; beside a live plan it is not', () => {
  const pages = [
    {
      name: 'a',
      base: 'a',
      text: '# A\n\nFixed on the plan-3482 branch (d9e01140, not yet landed): the anchor set.\nStill open under plan 4110, not yet landed.\nRetired by plan 3762 on 2026-09-06.\n',
    },
  ];
  const folder = (id) => ({ 3482: 'archive', 4110: 'in-progress', 3762: 'archive' })[id] ?? null;
  const r = findStaleStatusClaims(pages, folder);
  // line 3: pending wording + an archived plan → flagged. line 4: pending wording but the plan is
  // in-progress → not flagged. line 5: no pending wording → not flagged.
  assert.deepEqual(
    r.map((x) => [x.page, x.line, x.ids]),
    [['a', 3, ['3482']]],
  );
});

test('findDeadCitedPaths: a backticked repo path that does not exist is flagged unless the sentence says it was removed', () => {
  const pages = [
    {
      name: 'b',
      base: 'b',
      text: 'See `backend/scripts/gone.py:12` for the applier.\nThe old `backend/scripts/archive-me.py` was deleted by plan 3732.\nLive: `scripts/wiki-commit.mjs`.\n',
    },
  ];
  const exists = (p) => p === 'scripts/wiki-commit.mjs';
  const r = findDeadCitedPaths(pages, exists);
  assert.deepEqual(r, [{ page: 'b', line: 1, path: 'backend/scripts/gone.py' }]);
});

test('hotCacheAge: hot.md older than 14 days is flagged with its age; fresh is not', () => {
  const stale = [{ name: 'hot', base: 'hot', updated: '2026-09-01 (plan 3836)', text: '' }];
  const fresh = [{ name: 'hot', base: 'hot', updated: '2026-09-20', text: '' }];
  assert.deepEqual(hotCacheAge(stale, '2026-09-22'), { updated: '2026-09-01', days: 21 });
  assert.equal(hotCacheAge(fresh, '2026-09-22'), null);
});

test('the append-only journal (wiki/log.md) is out of scope for both line-level buckets', () => {
  // Every log line is a dated record of what was true when written, and past entries are
  // never edited (WIKI.md rule 3) — so a pending-wording or dead-path hit there is correct
  // history and unfixable. Same text on an ordinary page IS flagged.
  const text =
    'Fixed on the plan-3482 branch, not yet landed.\nSee `backend/scripts/gone.py` for the applier.\n';
  const folder = () => 'archive';
  const exists = () => false;
  const journal = [{ name: 'log', base: 'log', text }];
  const subject = [{ name: 'a', base: 'a', text }];
  assert.deepEqual(findStaleStatusClaims(journal, folder), []);
  assert.deepEqual(findDeadCitedPaths(journal, exists), []);
  assert.equal(findStaleStatusClaims(subject, folder).length, 1);
  assert.equal(findDeadCitedPaths(subject, exists).length, 1);
});

test('findStaleStatusClaims: "still open" / "in flight" / "follow-up plan" are NOT plan-status wording', () => {
  // Measured on the 2026-09-22 corpus (plan 4125): these three phrases produced 21 of 24
  // surviving hits and every one described an open DEFECT or a plan correctly owning later
  // work, not a landed plan written up as pending. Only unambiguous not-landed wording counts.
  const pages = [
    {
      name: 'c',
      base: 'c',
      text: [
        'These are deliberately still open — census them separately (plan 2726).',
        'PAUSED machinery pending the deletion follow-up plan (plan 3214).',
        'Plan 3859 carved CARRY_FLAG out (landed, while plan 3979 was in flight).',
        'The shared completeness fix exists only on plan 3718 unlanded branch.',
      ].join('\n'),
    },
  ];
  const r = findStaleStatusClaims(pages, () => 'archive');
  assert.deepEqual(
    r.map((x) => [x.line, x.ids]),
    [[4, ['3718']]],
  );
});

test('summaryLine: ONE owner for the console summary, and it names the three plan-4125 buckets', () => {
  // The manual run and the --on-land cadence run each used to build this line by hand, which is
  // how the plan-4125 buckets reached the report but not the on-land summary. One owner, so the
  // two paths cannot drift again.
  const result = {
    subjects: 84,
    drifted: [1],
    deadRefs: [1, 2],
    orphans: [],
    malformed: [],
    seedBehind: [1, 2, 3],
    staleStatus: [1, 2, 3, 4],
    deadCited: [1, 2, 3, 4, 5],
    hotStale: { updated: '2026-09-01', days: 21 },
  };
  const line = summaryLine(result);
  assert.match(line, /4 stale-status/);
  assert.match(line, /5 dead-cited/);
  assert.match(line, /hot 21d stale/);
  assert.match(line, /1 drifted/);
  assert.match(line, /2 dead-refs/);
  // Every bucket must be named: the report frontmatter's `summary:` is also the INDEX blurb.
  assert.match(line, /catalog-only/);
  assert.match(line, /no-sources/);
  // A fresh hot cache reads as "fresh", and a result from an older sweep() has no new keys at all.
  assert.match(summaryLine({ ...result, hotStale: null }), /hot fresh/);
  assert.doesNotThrow(() =>
    summaryLine({ drifted: [], deadRefs: [], orphans: [], malformed: [], seedBehind: [] }),
  );
});

// ── Review round 1 fixes (plan 4125) ──────────────────────────────────────────
test('findDeadCitedPaths: the history skip is scoped to the citation clause, not the whole line', () => {
  // Round-1 review finding: a line-wide HISTORY_RX test let ANY past-tense word anywhere in the
  // sentence suppress every citation on it — "This adapter WAS the default; see `x.py`" hid a
  // genuinely dead `x.py`. The skip is about the clause that carries the citation.
  const pages = [
    {
      name: 'd',
      base: 'd',
      text: [
        'This adapter was the default before the newer one; see `backend/scripts/legacy.py` for the old logic.',
        'The old `backend/scripts/archive-me.py` was deleted by plan 3732.',
      ].join('\n'),
    },
  ];
  const r = findDeadCitedPaths(pages, () => false);
  // line 1: "was" belongs to the adapter clause, not the citation's → still checked → flagged.
  // line 2: the citation's own clause says it was deleted → history → skipped.
  assert.deepEqual(
    r.map((x) => [x.line, x.path]),
    [[1, 'backend/scripts/legacy.py']],
  );
});

test('makePlanFolderOf: finds a plan filed under a CATEGORY folder, not just a direct child', () => {
  // Round-1 review finding: the one-level readdirSync walk missed
  // docs/superpowers/plans/<status>/<category>/<id>-*.md, so those plans resolved to null and
  // their pages were silently never checked. buildPlanFolderIndex's regex admits the category.
  const listing = [
    'docs/superpowers/plans/archive/3482-FABLE-Infra-thing.md',
    'docs/superpowers/plans/ready/pipe/4124-Pipe-nested-thing.md',
    'docs/superpowers/plans/in-progress/4110-Pipe-page-scoped-price-reread.md',
    'docs/superpowers/plans/archive/README.md',
  ].join('\n');
  const index = planFolderIndexFromListing(listing);
  assert.equal(index('3482'), 'archive');
  assert.equal(index('4124'), 'ready'); // the categorised one
  assert.equal(index('4110'), 'in-progress');
  assert.equal(index('9999'), null);
});

test('renderReport: the frontmatter summary and the console summary are the SAME string', () => {
  // Round-1 review finding: the frontmatter `summary:` still hand-built the bucket counts that
  // summaryLine() had just been made the sole owner of — a third copy to drift.
  const result = {
    subjects: 1,
    drifted: [1],
    deadRefs: [],
    orphans: [],
    catalogOnly: [],
    malformed: [],
    noSources: [],
    seedBehind: [],
    staleStatus: [
      { page: 'a', line: 3, ids: ['3482'] },
      { page: 'b', line: 9, ids: ['3718'] },
    ],
    deadCited: [],
    hotStale: null,
    hasFindings: true,
  };
  const md = renderReport(result, { generated: '2026-09-22', landingIndex: 1, trigger: 'manual' });
  const fm = md.split('\n').find((l) => l.startsWith('summary: '));
  assert.equal(fm, `summary: ${summaryLine(result)}`);
});

test('renderReport: section 5 describes the wording the regex ACTUALLY matches', () => {
  // Round-1 review finding: the section text still advertised "still open" / "in flight", which
  // the regex no longer matches — the report contradicting its own detector.
  const empty = {
    subjects: 0,
    drifted: [],
    deadRefs: [],
    orphans: [],
    catalogOnly: [],
    malformed: [],
    noSources: [],
    seedBehind: [],
    staleStatus: [],
    deadCited: [],
    hotStale: null,
    hasFindings: false,
  };
  const md = renderReport(empty, { generated: '2026-09-22', landingIndex: 1, trigger: 'manual' });
  const section = md.slice(md.indexOf('## 5.'), md.indexOf('## 6.'));
  for (const phrase of ['not yet landed', 'unlanded'])
    assert.ok(PENDING_WORDING_RX.test(phrase), phrase);
  for (const phrase of ['still open', 'in flight'])
    assert.equal(PENDING_WORDING_RX.test(phrase), false, phrase);
  // Anything the section offers as an example of FLAGGED wording must actually match.
  const advertised = [...section.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const flagged = advertised.filter((p) => PENDING_WORDING_RX.test(p));
  assert.ok(
    flagged.length >= 2,
    'section 5 must give real examples: ' + JSON.stringify(advertised),
  );
  assert.ok(
    section.includes('Deliberately NOT flagged'),
    'section 5 must say which near-miss wording is excluded, so a reader does not assume it is covered',
  );
});

// ── Review round 2 fixes (plan 4125) ──────────────────────────────────────────
test('repoPathVerdict: tracked, on-disk or gitignored all count as present', () => {
  // A round-2 review finding argued the gitignore arm makes a TYPO under a blanket-ignored
  // directory unflaggable. True, and not fixable here: an ignored path is not in the repo by
  // construction, so nothing repo-side distinguishes a correct local-only path from a mistyped
  // one. A parent-directory probe was tried and measured WORSE — it flagged the founding case
  // (`backend/data/stage4-claim-verifier-local/`, whose citing sentence says it is gitignored)
  // while still excusing a typo inside it. The blind spot is recorded, not papered over.
  const P = repoPathVerdict;
  assert.equal(P({ tracked: true, onDisk: false, ignored: false }), true);
  assert.equal(P({ tracked: false, onDisk: true, ignored: false }), true);
  assert.equal(P({ tracked: false, onDisk: false, ignored: true }), true);
  assert.equal(P({ tracked: false, onDisk: false, ignored: false }), false);
});

test('trackedPrefixSet: directory citations resolve by lookup, not a scan of every tracked path', () => {
  // Round-2 review finding: the first cut scanned the whole ~131k-entry tracked set per citation.
  const set = trackedPrefixSet(['a/b/c.ts', 'a/d.ts', 'e/f.ts']);
  assert.equal(set.has('a'), true);
  assert.equal(set.has('a/b'), true);
  assert.equal(set.has('e'), true);
  assert.equal(set.has('a/b/c.ts'), false); // files are not prefixes; the exact set answers those
  assert.equal(set.has('zzz'), false);
});
