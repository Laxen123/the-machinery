// scripts/assert-doc-pointers.test.mjs  (plan 3204)
//
// Name-pair for the new scripts/assert-doc-pointers.mjs module (the plan-2530 growth valve: a
// genuinely new scripts/<name>.mjs module gets its name-paired test file).
//
// The pure core (isCorpusFile / isCheckableRef / isNotAPath / placeholdersToGlobs /
// extractRefs / waivedLines / lintDocument) is driven with synthetic documents and an injected
// resolvePath, so no test here depends on the real repo tree — a file move must not turn this
// battery red. main() is driven against a temp FIXTURE tree so the --check exit-code contract
// and the grandfather file are pinned by a test rather than by a comment.
//
// Plan 3204 execution note (b) names the false-positive traps this lint must survive: glob-like
// examples in prose, template placeholders, and code blocks demonstrating OLD paths as history.
// Each has a test below; they were not hypothetical — every one was a real hit on the first
// full-corpus run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORPUS,
  GRANDFATHER_FILE,
  REF_ANCHORS,
  REF_EXTENSIONS,
  extractRefs,
  isCheckableRef,
  isCorpusFile,
  isNotAPath,
  lintDocument,
  listCorpus,
  main,
  normalizeToken,
  placeholdersToGlobs,
  readGrandfather,
  scanFences,
  SCANNED_FENCE_LANGS,
  waivedLines,
} from './assert-doc-pointers.mjs';

const allMissing = () => 'missing';
const allOk = () => 'ok';

// ── the corpus: what counts as a LIVE doc ────────────────────────────────────────

test('includes the live doc trees and the two root handbooks', () => {
  assert.equal(isCorpusFile('docs/runbooks/branch-hygiene.md'), true);
  assert.equal(isCorpusFile('docs/PIPELINE.md'), true);
  assert.equal(isCorpusFile('wiki/entities/chains/anicura.md'), true);
  assert.equal(isCorpusFile('CLAUDE.md'), true);
  assert.equal(isCorpusFile('WIKI.md'), true);
});

test('excludes archives, per-session handoffs, plans, and the generated INDEX', () => {
  assert.equal(isCorpusFile('docs/superpowers/plans/ready/3204-Infra-x.md'), false);
  assert.equal(isCorpusFile('docs/superpowers/specs/2026-01-01-x.md'), false);
  assert.equal(isCorpusFile('docs/superpowers/audits/2026-01-01-x/report.md'), false);
  assert.equal(isCorpusFile('docs/superpowers/batches/archive/x.md'), false);
  assert.equal(isCorpusFile('docs/handoff/sessions/2026-08-15-session-1.md'), false);
  assert.equal(isCorpusFile('docs/handoff/archive/2026-05.md'), false);
  assert.equal(isCorpusFile('docs/archive/x.md'), false);
  assert.equal(isCorpusFile('docs/INDEX.md'), false);
  assert.equal(isCorpusFile('docs/PRE-SEED-HISTORY.md'), false);
  assert.equal(isCorpusFile('wiki/log.md'), false);
  assert.equal(isCorpusFile('wiki/plans-archive.md'), false);
  // Prompt templates: every path in them is an illustrative placeholder by construction.
  assert.equal(
    isCorpusFile('docs/superpowers/audit-harness/templates/verifier-code-prompt.md'),
    false,
  );
  // …but the harness's own documentation is a live doc.
  assert.equal(isCorpusFile('docs/superpowers/AUDIT-RUNBOOK.md'), true);
});

test('only markdown, and only inside the corpus roots', () => {
  assert.equal(isCorpusFile('docs/diagrams/x.svg'), false);
  assert.equal(isCorpusFile('README.md'), false);
  assert.equal(isCorpusFile('backend/src/x.md'), false);
});

test('listCorpus filters whatever the file lister hands it', () => {
  const files = listCorpus('/nowhere', () => [
    'docs/runbooks/a.md',
    'docs/INDEX.md',
    'docs/superpowers/plans/ready/1-x.md',
    'wiki/hot.md',
  ]);
  assert.deepEqual(files, ['docs/runbooks/a.md', 'wiki/hot.md']);
});

// ── the token contract: anchor + extension ───────────────────────────────────────

test('a checkable reference is anchored on a doc-bearing dir AND names a file', () => {
  assert.equal(isCheckableRef('docs/runbooks/x.md'), true);
  assert.equal(isCheckableRef('backend/scripts/price-pipeline/run-batch.py'), true);
  assert.equal(isCheckableRef('frontend/src/components/Icons.tsx'), true);
  assert.equal(isCheckableRef('coord/skills/batch-train/SKILL.md'), true);
});

test('directory references are NOT checked — a named file is what moves', () => {
  assert.equal(isCheckableRef('docs/runbooks/'), false);
  assert.equal(isCheckableRef('backend/scripts/price-pipeline/'), false);
});

test('unanchored prose shorthand, URLs and package specifiers are invisible', () => {
  assert.equal(isCheckableRef('consensus/SE/row-001.json'), false); // no anchor dir
  assert.equal(isCheckableRef('output/reports/x.md'), false); // `output` is not an anchor
  assert.equal(isCheckableRef('https://example.com/x.md'), false);
  assert.equal(isCheckableRef('@vetapp/shared/seed-io.ts'), false);
  assert.equal(isCheckableRef('/docs/runbooks/x.md'), false);
  assert.equal(isCheckableRef('./render-freshness.md'), false);
  assert.equal(isCheckableRef('../runbooks/x.md'), false);
  assert.equal(isCheckableRef('schemas.ts'), false); // no slash at all
});

test('an unlisted extension is out of contract', () => {
  assert.equal(isCheckableRef('docs/diagrams/x.svg'), false);
  assert.equal(isCheckableRef('backend/scripts/requirements.txt'), false);
  assert.equal(REF_EXTENSIONS.includes('yml'), false);
  assert.equal(REF_ANCHORS.includes('output'), false);
});

// ── note (b): the three false-positive traps ─────────────────────────────────────

test('trap 1 — interpolation is not a path', () => {
  assert.equal(isNotAPath('docs/runbooks/cloud-routines/${f}.md'), true);
  assert.equal(isNotAPath('docs/sweep-$SCOPE-$DATE/homepage-needs-human.json'), true);
  assert.equal(isCheckableRef('docs/runbooks/cloud-routines/${f}.md'), false);
});

test('trap 2 — elided prose is not a path', () => {
  assert.equal(isNotAPath('backend/scripts/price-pipeline/...url_discovery.py'), true);
  assert.equal(isNotAPath('backend/scripts/…/x.py'), true);
});

test('trap 3 — a torn brace group is not a path, a balanced one still checks', () => {
  // `{se-lan.ts, lan-geo.ts}` written with a space tokenises into two half-tokens.
  assert.equal(isNotAPath('frontend/src/lib/lan/{se-lan.ts'), true);
  assert.equal(isNotAPath('docs/agents/{price,homepage}-inspector.md'), false);
  assert.equal(isCheckableRef('docs/agents/{price,homepage}-inspector.md'), true);
});

test('template placeholders become globs, in all three house forms', () => {
  // The `<CC>` + `clinic-NNN` pair is the sharded seed's house form, spelled here against a
  // stand-in tree: quoting the real seed path in a script would trip the seed-io seam guard,
  // and this test is about the placeholder grammar, not about the seed.
  assert.equal(
    placeholdersToGlobs('backend/scripts/cohorts/<CC>/clinic-NNN.json'),
    'backend/scripts/cohorts/*/clinic-*.json',
  );
  assert.equal(
    placeholdersToGlobs('wiki/meta/lint-report-YYYY-MM-DD.md'),
    'wiki/meta/lint-report-*.md',
  );
  assert.equal(placeholdersToGlobs('docs/runbooks/x.md'), 'docs/runbooks/x.md');
});

// ── extraction: backticks and link targets, never bare prose ─────────────────────

test('extracts from backtick spans and markdown link targets, not from running prose', () => {
  const doc = [
    'Read `docs/runbooks/a.md` before editing.',
    'See [the runbook](docs/runbooks/b.md) for depth.',
    'The file docs/runbooks/c.md is prose, not a pointer.',
  ].join('\n');
  assert.deepEqual(
    extractRefs(doc).map((r) => `${r.line}:${r.path}`),
    ['1:docs/runbooks/a.md', '2:docs/runbooks/b.md'],
  );
});

test('a link anchor or query is stripped before the existence check', () => {
  const refs = extractRefs('[x](docs/runbooks/a.md#section-2)');
  assert.deepEqual(
    refs.map((r) => r.path),
    ['docs/runbooks/a.md'],
  );
});

test('`path::symbol` checks the file, never the symbol', () => {
  const refs = extractRefs('`shared/src/schemas.ts::CountrySchema`');
  assert.deepEqual(
    refs.map((r) => r.path),
    ['shared/src/schemas.ts'],
  );
});

test('one finding per (line, path), however many times the line repeats it', () => {
  const refs = extractRefs('`docs/a.md` and again `docs/a.md` — [and](docs/a.md)');
  assert.equal(refs.length, 1);
});

test('plan paths are skipped — they move between status folders by design', () => {
  const refs = extractRefs('`docs/superpowers/plans/ready/3204-Infra-x.md`');
  assert.deepEqual(refs, []);
});

test('backend/data paths are skipped — a per-run artifact store, not a source tree', () => {
  const refs = extractRefs('`backend/data/price-pipeline/removal-proposals/x.json`');
  assert.deepEqual(refs, []);
});

// ── waivers ──────────────────────────────────────────────────────────────────────

test('an inline waiver exempts its own line and nothing else', () => {
  const doc = [
    '`docs/gone-a.md` <!-- doc-pointer-ok: documenting a gap -->',
    '`docs/gone-b.md`',
  ].join('\n');
  assert.deepEqual(waivedLines(doc), new Set([1]));
  const { findings } = lintDocument('docs/x.md', { text: doc, resolvePath: allMissing });
  assert.deepEqual(
    findings.map((f) => f.path),
    ['docs/gone-b.md'],
  );
});

test('a waiver whose reason wraps across lines still exempts the line it sits on', () => {
  const doc = ['`docs/gone.md` <!-- doc-pointer-ok: a long reason', 'that wrapped -->'].join('\n');
  const { findings } = lintDocument('docs/x.md', { text: doc, resolvePath: allMissing });
  assert.deepEqual(findings, []);
});

test('a section waiver runs to the next heading, and stops there', () => {
  const doc = [
    '<!-- doc-pointer-ok-section: the 2026-05 layout, kept as the record -->',
    'It lived at `docs/old-a.md`,',
    'and `docs/old-b.md`.',
    '',
    '## Today',
    '',
    'It lives at `docs/new.md`.',
  ].join('\n');
  const { findings } = lintDocument('docs/x.md', { text: doc, resolvePath: allMissing });
  assert.deepEqual(
    findings.map((f) => f.path),
    ['docs/new.md'],
  );
});

// ── fenced code blocks ───────────────────────────────────────────────────────────

test('a bare command in a shell fence IS checked — that is where runbook commands live', () => {
  const doc = ['```bash', 'python backend/scripts/sanity-check-seed.py --ids 1', '```'].join('\n');
  assert.deepEqual(
    extractRefs(doc).map((r) => r.path),
    ['backend/scripts/sanity-check-seed.py'],
  );
});

test('an unlabelled fence is treated as a command block', () => {
  assert.equal(extractRefs(['```', 'node scripts/x.mjs', '```'].join('\n')).length, 1);
});

test('a DATA fence is not scanned — a path there is a format example, not a pointer', () => {
  // WIKI.md § 14's Obsidian-canvas sample: the lint's only two false positives before the
  // info string was consulted.
  const doc = ['```json', '{ "file": "wiki/domains/APIs.md" }', '```'].join('\n');
  assert.deepEqual(extractRefs(doc), []);
  for (const lang of ['json', 'yaml', 'js', 'ts', 'jsonc', 'markdown']) {
    assert.equal(SCANNED_FENCE_LANGS.has(lang), false, lang);
  }
});

test('a backticked path inside a command fence still resolves', () => {
  assert.equal(extractRefs(['```bash', 'node `scripts/x.mjs`', '```'].join('\n')).length, 1);
});

test('normal rules resume after the closing fence', () => {
  const doc = [
    '```json',
    '{ "file": "docs/in-fence.md" }',
    '```',
    'and back to prose docs/bare.md with `docs/ticked.md`',
  ].join('\n');
  assert.deepEqual(
    extractRefs(doc).map((r) => r.path),
    ['docs/ticked.md'],
  );
});

test('a ``` line inside a ~~~ block is content, not a close', () => {
  const doc = ['~~~bash', 'echo "```"', 'node scripts/gone-after-the-inner-fence.mjs', '~~~'].join(
    '\n',
  );
  assert.deepEqual(
    extractRefs(doc).map((r) => r.path),
    ['scripts/gone-after-the-inner-fence.mjs'],
  );
});

test('a delimiter-shaped line WITH an info string is content, never a close', () => {
  // CommonMark: a closing fence carries no info string. `~~~python` inside a `~~~bash` block
  // opens nothing and closes nothing.
  const doc = ['~~~bash', '~~~python', 'node scripts/still-inside.mjs', '~~~'].join('\n');
  assert.deepEqual(
    extractRefs(doc).map((r) => r.path),
    ['scripts/still-inside.mjs'],
  );
});

test('scanFences is the single source both the mask and the extractor read', () => {
  const states = scanFences(['```bash', 'node scripts/a.mjs', '```', 'prose']);
  assert.deepEqual(
    states.map((s) => [s.fence, s.inFence]),
    [
      [true, false],
      [false, true],
      [true, false],
      [false, false],
    ],
  );
  assert.equal(states[0].lang, 'bash');
  assert.equal(states[0].opening, true);
  assert.equal(states[2].opening, false);
});

test('a waiver written on the fence DELIMITER line does not act either', () => {
  const doc = ['```bash <!-- doc-pointer-ok-section: an example -->', '```', '`docs/gone.md`'].join(
    '\n',
  );
  assert.deepEqual(waivedLines(doc), new Set());
});

test('a longer closing run closes a shorter fence; a shorter one does not', () => {
  const short = ['```bash', 'node scripts/a.mjs', '````', 'node scripts/b.mjs'].join('\n');
  // The ```` line closes the ``` block, so `b.mjs` is prose and only `a.mjs` is a reference.
  assert.deepEqual(
    extractRefs(short).map((r) => r.path),
    ['scripts/a.mjs'],
  );
});

test('a backslash means markdown escaping or a Windows path, never a repo reference', () => {
  assert.equal(isNotAPath('wiki/<domain>/\\_index.md'), true);
  assert.equal(
    extractRefs(['```bash', 'cat wiki/domains/\\_index.md', '```'].join('\n')).length,
    0,
  );
});

test('a code block demonstrating an OLD path is a finding unless it is waived', () => {
  // Note (b)'s third trap. The lint deliberately does NOT special-case fenced blocks: a
  // command in a runbook is the single most important thing to keep runnable. History gets
  // the section marker instead.
  const historical = ['```bash', 'node `scripts/gone.mjs`', '```'].join('\n');
  assert.equal(
    lintDocument('docs/x.md', { text: historical, resolvePath: allMissing }).findings.length,
    1,
  );
  const waived = [
    '<!-- doc-pointer-ok-section: the pre-2026-06 command -->',
    ...historical.split('\n'),
  ].join('\n');
  assert.deepEqual(
    lintDocument('docs/x.md', { text: waived, resolvePath: allMissing }).findings,
    [],
  );
});

// ── grandfathering ───────────────────────────────────────────────────────────────

test('a grandfathered pair is counted, not reported; the same path elsewhere still reports', () => {
  const doc = '`docs/gone.md`';
  const grandfather = new Set(['docs/known.md docs/gone.md']);
  const known = lintDocument('docs/known.md', { text: doc, resolvePath: allMissing, grandfather });
  assert.deepEqual(known.findings, []);
  assert.equal(known.grandfathered, 1);
  const fresh = lintDocument('docs/fresh.md', { text: doc, resolvePath: allMissing, grandfather });
  assert.equal(fresh.findings.length, 1);
});

test('a live reference is never a finding', () => {
  assert.deepEqual(
    lintDocument('docs/x.md', { text: '`docs/a.md`', resolvePath: allOk }).findings,
    [],
  );
});

// ── main(): exit codes, scoping, grandfather file, against a fixture tree ────────

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'doc-pointers-'));
  const write = (rel, body) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  try {
    return run({ root, write });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('main WARNs and exits 0 by default, and exits 1 under --check', () => {
  withFixture(({ root, write }) => {
    write('docs/runbooks/a.md', 'see `docs/runbooks/gone.md`\n');
    const files = ['docs/runbooks/a.md'];
    assert.equal(main([], { root, files }), 0);
    assert.equal(main(['--check'], { root, files }), 1);
  });
});

test('main exits 0 under --check once the reference resolves', () => {
  withFixture(({ root, write }) => {
    write('docs/runbooks/a.md', 'see `docs/runbooks/b.md`\n');
    write('docs/runbooks/b.md', 'hello\n');
    assert.equal(main(['--check'], { root, files: ['docs/runbooks/a.md'] }), 0);
  });
});

test('main honours the grandfather file on disk, and --no-grandfather ignores it', () => {
  withFixture(({ root, write }) => {
    write('docs/runbooks/a.md', 'see `docs/runbooks/gone.md`\n');
    write(GRANDFATHER_FILE, '# header\ndocs/runbooks/a.md docs/runbooks/gone.md\n');
    const files = ['docs/runbooks/a.md'];
    assert.equal(main(['--check'], { root, files }), 0);
    assert.equal(main(['--check', '--no-grandfather'], { root, files }), 1);
  });
});

test('readGrandfather skips comments and blanks, and is empty when the file is absent', () => {
  withFixture(({ root, write }) => {
    assert.equal(readGrandfather(root).size, 0);
    write(GRANDFATHER_FILE, '# a comment\n\ndocs/a.md docs/b.md\n');
    assert.deepEqual([...readGrandfather(root)], ['docs/a.md docs/b.md']);
  });
});

test('named files are filtered to the corpus, so a caller may pass its whole changed list', () => {
  withFixture(({ root, write }) => {
    write('docs/runbooks/a.md', 'see `docs/runbooks/gone.md`\n');
    write('docs/superpowers/plans/ready/1-x.md', 'see `docs/runbooks/gone.md`\n');
    // The plan file carries the same dead reference and is still not linted.
    assert.equal(main(['--check', 'docs/superpowers/plans/ready/1-x.md'], { root }), 0);
    assert.equal(main(['--check', 'docs/runbooks/a.md'], { root }), 1);
  });
});

test('a file named but deleted from the tree is skipped, not a crash', () => {
  withFixture(({ root }) => {
    assert.equal(main(['--check', 'docs/runbooks/deleted.md'], { root }), 0);
  });
});

test('an explicitly scoped run with no live doc in it lints NOTHING, not everything', () => {
  withFixture(({ root, write }) => {
    write('docs/runbooks/a.md', 'see `docs/runbooks/gone.md`\n');
    // The whole corpus is dirty, but this push touched only a non-corpus file.
    const files = ['docs/runbooks/a.md'];
    assert.equal(main(['--check', 'backend/src/app.ts'], { root, files }), 0);
    // …and the unscoped run still sweeps everything.
    assert.equal(main(['--check'], { root, files }), 1);
  });
});

test('a waiver shown as an EXAMPLE does not act as one', () => {
  // docs/runbooks/standing-operations.md documents this syntax; before the code-region mask,
  // its example silently waived a real line of that runbook.
  const inSpan = ['waive it with `<!-- doc-pointer-ok: reason -->`', '`docs/gone.md`'].join('\n');
  assert.deepEqual(waivedLines(inSpan), new Set());
  assert.equal(
    lintDocument('docs/x.md', { text: inSpan, resolvePath: allMissing }).findings.length,
    1,
  );

  const inFence = [
    '```markdown',
    '<!-- doc-pointer-ok-section: an example -->',
    '```',
    '`docs/gone.md`',
  ].join('\n');
  assert.deepEqual(waivedLines(inFence), new Set());
  assert.equal(
    lintDocument('docs/x.md', { text: inFence, resolvePath: allMissing }).findings.length,
    1,
  );
});

test('a section waiver ends at a SETEXT heading too, not only an ATX one', () => {
  const doc = [
    '<!-- doc-pointer-ok-section: history -->',
    '`docs/old.md`',
    'Today',
    '=====',
    '`docs/new.md`',
  ].join('\n');
  assert.deepEqual(
    lintDocument('docs/x.md', { text: doc, resolvePath: allMissing }).findings.map((f) => f.path),
    ['docs/new.md'],
  );
});

test('a thematic break is not a setext heading, so the waiver keeps running', () => {
  const doc = [
    '<!-- doc-pointer-ok-section: history -->',
    '`docs/old-a.md`',
    '',
    '---',
    '`docs/old-b.md`',
  ].join('\n');
  assert.deepEqual(lintDocument('docs/x.md', { text: doc, resolvePath: allMissing }).findings, []);
});

test('angle-bracket link destinations and file:line citations are normalized', () => {
  assert.equal(normalizeToken('<docs/runbooks/a.md>'), 'docs/runbooks/a.md');
  assert.equal(normalizeToken('docs/runbooks/a.md:42'), 'docs/runbooks/a.md');
  assert.equal(normalizeToken('docs/runbooks/a.md:42:7'), 'docs/runbooks/a.md');
  assert.equal(normalizeToken('docs/runbooks/a.md#section'), 'docs/runbooks/a.md');
  // …and each form reaches the existence check instead of being skipped as "not a file".
  const doc = ['[runbook](<docs/gone-a.md>)', 'see `docs/gone-b.md:120`'].join('\n');
  assert.deepEqual(
    extractRefs(doc).map((r) => r.path),
    ['docs/gone-a.md', 'docs/gone-b.md'],
  );
});

test('two waiver markers out of document order are both numbered correctly', () => {
  // The line-index builder is stateful and monotonic, so the section pass must restart it.
  const doc = [
    '<!-- doc-pointer-ok-section: history -->',
    '`docs/gone-a.md`',
    '## Now',
    '`docs/gone-b.md` <!-- doc-pointer-ok: a gap -->',
  ].join('\n');
  assert.deepEqual(waivedLines(doc), new Set([1, 2, 4]));
  assert.deepEqual(lintDocument('docs/x.md', { text: doc, resolvePath: allMissing }).findings, []);
});

test('an unknown flag is a caller bug (exit 2), never a silent clean pass', () => {
  assert.equal(main(['--all-the-things'], { root: '/nowhere', files: [] }), 2);
});

test('the corpus config is data a future row can extend', () => {
  assert.ok(CORPUS.includePrefixes.includes('docs/'));
  assert.ok(CORPUS.excludePrefixes.includes('docs/superpowers/plans/'));
});
