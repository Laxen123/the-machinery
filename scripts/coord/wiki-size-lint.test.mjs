// scripts/coord/wiki-size-lint.test.mjs — tests for the wiki page-size budget lint
// (plan 1255). Builds throwaway fixture repos under tmpdir: a wiki/ tree with
// pages around each threshold plus a fake scripts/hooks loader source, then
// asserts the classification (injected / pull / exempt) and the warn/fail
// thresholds. No git, no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  KB,
  INJECTED_WARN,
  INJECTED_FAIL,
  PULL_WARN,
  ONE_READ_CEILING,
  UPDATED_MAX,
  LONG_LINE_WARN,
  frontmatterOf,
  hasNonEmptyListKey,
  collectHookReferencedBasenames,
  CHAIN_REGISTRY_REL_FOR_LINT,
  classifyPage,
  classifyAndBucketPage,
  lintWikiSizes,
  checkPages,
  lfNormalizedByteLength,
  updatedValueLength,
  longBodyLines,
  INJECTED_NEAR_CAP,
  formatBudgetWarning,
  formatBudgetFailure,
  FOLD_ABOVE_MAX_LINES,
  APPENDIX_SUFFIX,
  isFoldable,
  aboveFoldBody,
  ADVISORY_KINDS,
} from './wiki-size-lint.mjs';

const REC_PAGE = 'wiki/entities/records/rec-001.md';

// Write `rel` (forward-slash, repo-relative) under `root`, padded to `size` bytes.
// Padding is chunked into 100-char lines (plan 2618) so sheer fixture bulk never trips
// the long-line advisory — a fixture that WANTS a long line writes its body explicitly.
function page(root, rel, { size = 1 * KB, frontmatter = '' } = {}) {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  let body = frontmatter ? `---\n${frontmatter}\n---\n` : '';
  body += '# fixture\n';
  while (body.length < size) {
    const remaining = size - body.length;
    body += remaining <= 101 ? 'x'.repeat(remaining) : 'x'.repeat(100) + '\n';
  }
  writeFileSync(abs, body);
}

// plan 4172: the per-record page dir is config (coord.config.json `wikiRecordDir`), so every
// fixture repo declares one — the lint reads it through the same seam a real checkout does.
const RECORD_DIR = 'wiki/entities/records';

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-size-lint-'));
  writeFileSync(join(root, 'coord.config.json'), JSON.stringify({ wikiRecordDir: RECORD_DIR }));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const byRel = (res, rel) => res.pages.find((p) => p.rel === rel);

// plan 4027: the warns produced by the SIZE buckets, with the advisories that ride beside
// them (`longLine`, `foldHead`) filtered out. `page()` pads to a byte threshold with 100-char
// lines, so any fixture big enough to test a size band is also hundreds of lines long and
// legitimately trips the fold advisory — that is the rule working, not a fixture bug, and it
// cannot be shaped away (fewer lines means longer ones, which trips the long-line advisory
// instead). Filtering keeps each size test asserting the rule it is about; both advisories
// have their own tests below.
const sizeWarns = (warns) => warns.filter((w) => !ADVISORY_KINDS.has(w.kind));

test('frontmatterOf extracts the block; missing block → empty', () => {
  assert.equal(frontmatterOf('---\na: 1\nb: 2\n---\nbody'), 'a: 1\nb: 2');
  assert.equal(frontmatterOf('# no frontmatter\n'), '');
  assert.equal(frontmatterOf('---\r\na: 1\r\n---\r\nbody'), 'a: 1');
});

test('hasNonEmptyListKey: inline, single-quoted, block, waiver, bare', () => {
  assert.equal(hasNonEmptyListKey('aliases: ["acme cloud", "acme"]', 'aliases'), true);
  assert.equal(hasNonEmptyListKey("aliases: ['acme cloud']", 'aliases'), true); // prettier rewrite
  assert.equal(hasNonEmptyListKey('aliases:\n  - acme cloud\n  - acme', 'aliases'), true);
  assert.equal(hasNonEmptyListKey('aliases: []', 'aliases'), false); // explicit waiver
  assert.equal(hasNonEmptyListKey('aliases:\nupdated: 2026-07-02', 'aliases'), false); // bare key
  assert.equal(hasNonEmptyListKey('updated: 2026-07-02', 'aliases'), false); // absent
  assert.equal(hasNonEmptyListKey('triggerPaths: [backend/src/adapters/x]', 'triggerPaths'), true);
});

test('hasNonEmptyListKey: YAML comments are not values (sonnet-review finding 1)', () => {
  assert.equal(hasNonEmptyListKey('aliases: # TBD, fill in later', 'aliases'), false); // comment-only
  assert.equal(hasNonEmptyListKey('aliases: [] # waived on purpose', 'aliases'), false); // waiver + comment
  assert.equal(hasNonEmptyListKey("aliases: ['acme'] # note", 'aliases'), true); // list + comment
  // a comment-only key followed by a block list is still a non-empty block list
  assert.equal(hasNonEmptyListKey('aliases: # see below\n  - acme cloud', 'aliases'), true);
});

test('exempt pages never warn or fail, whatever their size', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/log.md', { size: 200 * KB });
    page(root, 'wiki/hot.md', { size: 30 * KB });
    page(root, 'wiki/index.md', { size: 30 * KB });
    const res = lintWikiSizes(root);
    assert.equal(res.failures.length, 0);
    assert.equal(res.warns.length, 0);
    assert.equal(byRel(res, 'wiki/log.md').cls, 'exempt');
  } finally {
    cleanup();
  }
});

test('per-record pages are injected (file-derived): >16 KB fails, 8–16 KB warns, ≤8 KB clean', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/entities/records/rec-001.md', { size: INJECTED_FAIL + 1 });
    page(root, 'wiki/entities/records/rec-002.md', { size: INJECTED_WARN + 1 });
    page(root, 'wiki/entities/records/rec-003.md', { size: 2 * KB });
    const res = lintWikiSizes(root);
    assert.deepEqual(
      res.failures.map((f) => f.rel),
      ['wiki/entities/records/rec-001.md'],
    );
    assert.deepEqual(
      sizeWarns(res.warns).map((w) => w.rel),
      ['wiki/entities/records/rec-002.md'],
    );
  } finally {
    cleanup();
  }
});

// plan 4035: `hasNonEmptyListKey` knew the inline `key: [a, b]` form and the `- item` block
// form, but not the MULTI-LINE BRACKETED form prettier produces for a long list — `key:` alone,
// then `[` on the next line. 14 entity pages are written that way (rcvs, booking-inspector,
// companies-house, vetstoria, …), and every one of them classified `pull` and drew the loose
// budget despite declaring real aliases/triggerPaths. Found because the registry widening above
// stopped masking it for rcvs, whose basename happened to appear in a registry COMMENT.
// plan 4035 re-review (finding e9347e): prettier emits TWO bracketed shapes depending on
// whether the list fits one line — `[` alone with an item per line, and the whole list
// wrapped onto the single line after `key:`. Five real pages use the second (firecrawl,
// cvr, brreg, companies-house, allabolag), so handling only the first still misclassified them.
test('hasNonEmptyListKey: the wrapped-to-one-line bracketed form counts as non-empty', () => {
  const fm = ['aliases:', "  ['cvr', 'cvr-nummer', 'cvrapi']", 'type: entity'].join('\n');
  assert.equal(hasNonEmptyListKey(fm, 'aliases'), true);

  const empty = ['aliases:', '  []', 'type: entity'].join('\n');
  assert.equal(hasNonEmptyListKey(empty, 'aliases'), false);

  // wrapped across a few lines without the leading `[` on its own line
  const split = ['aliases:', "  ['a',", "   'b']", 'type: entity'].join('\n');
  assert.equal(hasNonEmptyListKey(split, 'aliases'), true);
});

// plan 4035 re-review (findings 4d8b31/d0ca5f/f6946f/0348a1): the registry is scanned as
// TEXT, so a `file: '<x>.md'` appearing inside a COMMENT would register a page. Line
// comments are stripped before the match.
test('a file: value inside a registry comment does not register a page', () => {
  const { root, cleanup } = makeRepo();
  try {
    mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'hooks', 'fake-loader.mjs'), 'export const X = 1;\n');
    writeFileSync(
      join(root, 'scripts', 'wiki-chain-registry.mjs'),
      "// example entry: { file: 'commented-example.md' }\n" +
        "export const CHAINS = [{ file: 'real.md' }];\n",
    );
    const basenames = collectHookReferencedBasenames(root);
    assert.ok(basenames.has('real.md'));
    assert.ok(
      !basenames.has('commented-example.md'),
      'a commented-out entry is not a registration',
    );
  } finally {
    cleanup();
  }
});

// plan 4035 re-review: the hooks walk pushes only DIRECTORY entries onto its stack, so a
// non-directory sitting in the tree is skipped without a readdir. Pinned because the walk's
// readdir catch is deliberately broad (it treats a missing hooks dir as the fixture case),
// and this test says what the walk actually guarantees rather than implying the catch is
// narrow. The broad catch itself is recorded on docs/handoff/infra-debt.md, not fixed here.
test('a non-directory entry in the hooks tree does not disturb the walk', () => {
  const { root, cleanup } = makeRepo();
  try {
    const hooks = join(root, 'scripts', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'fake-loader.mjs'), "const P = 'x.md';\n");
    writeFileSync(join(hooks, 'not-a-dir'), 'plain file, no .mjs suffix\n');
    mkdirSync(join(hooks, 'nested'), { recursive: true });
    writeFileSync(join(hooks, 'nested', 'deep.mjs'), "const Q = 'y.md';\n");
    const basenames = collectHookReferencedBasenames(root);
    assert.ok(basenames.has('x.md'));
    assert.ok(basenames.has('y.md'), 'the walk still descends into real subdirectories');
  } finally {
    cleanup();
  }
});

test('hasNonEmptyListKey: the multi-line bracketed list form counts as non-empty', () => {
  const fm = ['aliases:', '  [', "    'rcvs',", "    'RCVS',", '  ]', 'type: entity'].join('\n');
  assert.equal(hasNonEmptyListKey(fm, 'aliases'), true);

  const fmTrigger = ['triggerPaths:', '  [', "    'backend/src/adapters/x.ts',", '  ]'].join('\n');
  assert.equal(hasNonEmptyListKey(fmTrigger, 'triggerPaths'), true);

  // An EMPTY multi-line bracket is still empty — the whole point of the key is a non-empty list.
  const fmEmpty = ['aliases:', '  [', '  ]', 'type: entity'].join('\n');
  assert.equal(hasNonEmptyListKey(fmEmpty, 'aliases'), false);

  // A following top-level key still terminates the scan, so an undeclared list stays false.
  const fmNone = ['aliases:', 'type: entity'].join('\n');
  assert.equal(hasNonEmptyListKey(fmNone, 'aliases'), false);
});

test('a page declaring aliases in the multi-line bracketed form is injected', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/entities/services/bracketed.md', {
      size: INJECTED_FAIL + 1,
      frontmatter: ['aliases:', '  [', "    'thing',", '  ]'].join('\n'),
    });
    const res = lintWikiSizes(root);
    assert.equal(byRel(res, 'wiki/entities/services/bracketed.md').cls, 'injected');
  } finally {
    cleanup();
  }
});

// plan 4035 review (finding 2d6119): the registry file is roughly half prose comment, and
// those comments cite OTHER `.md` paths (`docs/countries/gb.md`, `wiki/entities/services/rcvs.md`).
// A bare `.md`-token scan would inject a page because a comment happened to link it, so the
// registry is read through its `file:` VALUES only.
test('a .md named only in a registry COMMENT is not injected', () => {
  const { root, cleanup } = makeRepo();
  try {
    mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'hooks', 'fake-loader.mjs'), 'export const X = 1;\n');
    writeFileSync(
      join(root, 'scripts', 'wiki-chain-registry.mjs'),
      '// see wiki/entities/services/mentioned-in-a-comment.md for the rationale\n' +
        "export const CHAINS = [{ file: 'registered.md' }];\n",
    );
    const basenames = collectHookReferencedBasenames(root);
    assert.ok(basenames.has('registered.md'), 'a file: value is registered');
    assert.ok(
      !basenames.has('mentioned-in-a-comment.md'),
      'a comment citation must not inject the page it links',
    );
  } finally {
    cleanup();
  }
});

// plan 4035 review (finding bd21d6): the path is duplicated rather than imported because
// wiki-commit.mjs (which owns CHAIN_REGISTRY_REL) imports THIS module — reusing it directly
// would close an import cycle. The duplication is pinned here instead.
test('the lint path for the chain registry matches wiki-commit CHAIN_REGISTRY_REL', async () => {
  const { CHAIN_REGISTRY_REL } = await import('../wiki-commit.mjs');
  assert.equal(CHAIN_REGISTRY_REL_FOR_LINT, CHAIN_REGISTRY_REL);
});

// plan 4035 review (finding 0824a2): only a MISSING optional source is swallowed. An
// unreadable one must surface, or the injected set silently shrinks and an over-cap page
// quietly stops failing.
test('an unreadable loader-data module is not silently skipped', () => {
  const { root, cleanup } = makeRepo();
  try {
    mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'hooks', 'fake-loader.mjs'), 'export const X = 1;\n');
    // A DIRECTORY where the registry module is expected: readFileSync throws EISDIR, not ENOENT.
    mkdirSync(join(root, 'scripts', 'wiki-chain-registry.mjs'), { recursive: true });
    assert.throws(() => collectHookReferencedBasenames(root), /EISDIR|EPERM|EACCES/);
  } finally {
    cleanup();
  }
});

// plan 4035: the chain registry is a DATA table deliberately parked OUTSIDE scripts/hooks/
// (plan 2140 moved it there so registering a chain never edits an executable hook). The
// injected-set derivation has to read it too, or the registry-driven chain pages — the
// biggest injected heads in the vault — classify `pull` and get the loose budget.
test('a page named ONLY in the chain registry is injected', () => {
  const { root, cleanup } = makeRepo();
  try {
    mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true });
    // A hook that names nothing, so the registry is the only possible source.
    writeFileSync(join(root, 'scripts', 'hooks', 'fake-loader.mjs'), 'export const X = 1;\n');
    writeFileSync(
      join(root, 'scripts', 'wiki-chain-registry.mjs'),
      "export const CHAINS = [{ rx: /anicura/i, file: 'anicura.md' }];\n",
    );
    page(root, 'wiki/entities/chains/anicura.md', { size: INJECTED_FAIL + 1 });
    page(root, 'wiki/entities/chains/unregistered.md', { size: INJECTED_FAIL + 1 });

    const basenames = collectHookReferencedBasenames(root);
    assert.ok(basenames.has('anicura.md'), 'registry basename must join the injected set');

    const res = lintWikiSizes(root);
    assert.equal(byRel(res, 'wiki/entities/chains/anicura.md').cls, 'injected');
    assert.deepEqual(
      res.failures.map((f) => f.rel),
      ['wiki/entities/chains/anicura.md'],
      'an over-cap registry-driven page FAILS, where before this it only warned',
    );
    // A sibling the registry does not name stays pull — the widening is registry-keyed,
    // not "every chains/** page is injected".
    assert.equal(byRel(res, 'wiki/entities/chains/unregistered.md').cls, 'pull');
  } finally {
    cleanup();
  }
});

// The registry is optional: a checkout without it (the isolated plan-repo scaffold, a
// fixture repo) must not throw — the derivation already fails open on a missing hooks dir.
test('a missing chain registry is not an error', () => {
  const { root, cleanup } = makeRepo();
  try {
    mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'hooks', 'fake-loader.mjs'), "const P = 'x.md';\n");
    const basenames = collectHookReferencedBasenames(root);
    assert.ok(basenames.has('x.md'));
    assert.ok(!basenames.has('anicura.md'));
  } finally {
    cleanup();
  }
});

test('a page named in a hook source is injected; an unnamed sibling is pull', () => {
  const { root, cleanup } = makeRepo();
  try {
    mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true });
    writeFileSync(
      join(root, 'scripts', 'hooks', 'fake-loader.mjs'),
      "const CHAINS = [{ file: 'chaina.md' }];\nconst PAGE = 'price-inspector.md';\n",
    );
    page(root, 'wiki/entities/chains/chaina.md', { size: INJECTED_FAIL + 1 });
    page(root, 'wiki/entities/inspectors/price-inspector.md', { size: INJECTED_FAIL + 1 });
    page(root, 'wiki/entities/chains/unregistered.md', { size: INJECTED_FAIL + 1 });
    const basenames = collectHookReferencedBasenames(root);
    assert.ok(basenames.has('chaina.md'));
    assert.ok(basenames.has('price-inspector.md'));
    const res = lintWikiSizes(root);
    assert.deepEqual(res.failures.map((f) => f.rel).sort(), [
      'wiki/entities/chains/chaina.md',
      'wiki/entities/inspectors/price-inspector.md',
    ]);
    // unregistered chains page → pull class → same size only WARNS (plan 2618: the injected
    // cap now equals the pull warn, so an over-cap fixture crosses both lines — the
    // discrimination is fail-vs-warn, not fail-vs-clean)
    assert.equal(byRel(res, 'wiki/entities/chains/unregistered.md').cls, 'pull');
    assert.deepEqual(
      sizeWarns(res.warns).map((w) => w.rel),
      ['wiki/entities/chains/unregistered.md'],
    );
  } finally {
    cleanup();
  }
});

test('non-empty aliases:/triggerPaths: frontmatter makes an entities page injected; [] waiver does not', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/entities/platforms/acme-cloud.md', {
      size: INJECTED_FAIL + 1,
      frontmatter: "aliases: ['acme cloud', 'acmecloud']",
    });
    page(root, 'wiki/entities/platforms/waived.md', {
      size: INJECTED_FAIL + 1,
      frontmatter: 'aliases: []',
    });
    page(root, 'wiki/entities/inspectors/booking-inspector.md', {
      size: INJECTED_WARN + 1,
      frontmatter: 'triggerPaths:\n  - backend/scripts/booking',
    });
    const res = lintWikiSizes(root);
    assert.deepEqual(
      res.failures.map((f) => f.rel),
      ['wiki/entities/platforms/acme-cloud.md'],
    );
    // waived.md classifies pull, so its over-cap size warns instead of failing (plan 2618:
    // injected cap == pull warn — see the hook-source test's comment)
    assert.equal(byRel(res, 'wiki/entities/platforms/waived.md').cls, 'pull');
    assert.deepEqual(
      sizeWarns(res.warns)
        .map((w) => w.rel)
        .sort(),
      ['wiki/entities/inspectors/booking-inspector.md', 'wiki/entities/platforms/waived.md'],
    );
  } finally {
    cleanup();
  }
});

test('aliases: frontmatter OUTSIDE wiki/entities/ never makes a page injected (concepts stay pull)', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/concepts/pricing-modes.md', {
      size: INJECTED_FAIL + 1, // over-cap: would FAIL if misclassified injected
      frontmatter: "aliases: ['pricing modes']",
    });
    const res = lintWikiSizes(root);
    assert.equal(byRel(res, 'wiki/concepts/pricing-modes.md').cls, 'pull');
    assert.equal(res.failures.length, 0);
    // plan 2618: injected cap == pull warn, so the same size warns as pull (never fails)
    assert.equal(res.warns.length, 1);
    assert.equal(res.warns[0].cls, 'pull');
  } finally {
    cleanup();
  }
});

test('pull pages warn above 24 KB but never fail', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/concepts/bake-offs.md', { size: PULL_WARN + 1 });
    page(root, 'wiki/concepts/passes.md', { size: 5 * KB });
    const res = lintWikiSizes(root);
    assert.equal(res.failures.length, 0);
    assert.deepEqual(
      res.warns.map((w) => w.rel),
      ['wiki/concepts/bake-offs.md'],
    );
  } finally {
    cleanup();
  }
});

test('classifyPage precedence: exempt beats entities rules', () => {
  assert.equal(
    classifyPage('wiki/index.md', { frontmatter: "aliases: ['x y']", hookBasenames: new Set() }),
    'exempt',
  );
});

// plan 1362 (D1) — checkPages scopes the SAME budgets/classification lintWikiSizes uses
// to just the given pages, so wiki-commit.mjs can check exactly what it's about to
// commit without re-walking the whole vault.
test('checkPages: an over-cap injected page fails; an unlisted sibling page is ignored', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/entities/records/rec-001.md', { size: INJECTED_FAIL + 1 });
    page(root, 'wiki/entities/records/rec-002.md', { size: INJECTED_FAIL + 1 }); // not passed
    const { fails, warns } = checkPages(root, ['wiki/entities/records/rec-001.md']);
    assert.deepEqual(
      fails.map((f) => f.rel),
      ['wiki/entities/records/rec-001.md'],
    );
    assert.equal(sizeWarns(warns).length, 0);
  } finally {
    cleanup();
  }
});

test('checkPages: a warn-only pull page passes (warns, not fails)', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/concepts/big.md', { size: PULL_WARN + 1 });
    const { fails, warns } = checkPages(root, ['wiki/concepts/big.md']);
    assert.equal(fails.length, 0);
    assert.deepEqual(
      warns.map((w) => w.rel),
      ['wiki/concepts/big.md'],
    );
  } finally {
    cleanup();
  }
});

test('checkPages: an under-cap page is clean (no fail, no warn); a missing path is skipped', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/entities/records/rec-003.md', { size: 2 * KB });
    const { fails, warns } = checkPages(root, [
      'wiki/entities/records/rec-003.md',
      'wiki/entities/records/never-written.md',
    ]);
    assert.equal(fails.length, 0);
    assert.equal(warns.length, 0);
  } finally {
    cleanup();
  }
});

// plan 1398 (item 2) — classifyAndBucketPage is the single shared classify-bucket core both
// lintWikiSizes and checkPages now call; test it directly so the bucketing rules have one
// exercised source instead of only being verified transitively through both callers.
test('classifyAndBucketPage: buckets fail/warn/clean and returns null for an unreadable page', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/entities/records/rec-fail.md', { size: INJECTED_FAIL + 1 });
    page(root, 'wiki/entities/records/rec-warn.md', { size: INJECTED_WARN + 1 });
    page(root, 'wiki/entities/records/rec-clean.md', { size: 2 * KB });
    const hookBasenames = collectHookReferencedBasenames(root);
    const fail = classifyAndBucketPage(
      root,
      'wiki/entities/records/rec-fail.md',
      hookBasenames,
      RECORD_DIR,
    );
    assert.equal(fail.bucket, 'fail');
    assert.equal(fail.page.limit, INJECTED_FAIL);
    const warn = classifyAndBucketPage(
      root,
      'wiki/entities/records/rec-warn.md',
      hookBasenames,
      RECORD_DIR,
    );
    assert.equal(warn.bucket, 'warn');
    const clean = classifyAndBucketPage(
      root,
      'wiki/entities/records/rec-clean.md',
      hookBasenames,
      RECORD_DIR,
    );
    assert.equal(clean.bucket, null);
    assert.equal(clean.page.cls, 'injected');
    const missing = classifyAndBucketPage(
      root,
      'wiki/entities/records/never-written.md',
      hookBasenames,
      RECORD_DIR,
    );
    assert.equal(missing, null);
  } finally {
    cleanup();
  }
});

test('fold budgets: a small head with a 100 KB tail warns but does not fail', () => {
  const { root, cleanup } = makeRepo();
  try {
    const rel = 'wiki/entities/records/rec-folded.md';
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `# head\n<!-- fold -->\n${'t'.repeat(100 * KB)}`);
    const { fails, warns } = checkPages(root, [rel]);
    assert.equal(fails.length, 0);
    assert.ok(warns.some((w) => w.kind === 'tail' && w.size === 100 * KB));
    assert.ok(warns.some((w) => w.kind === 'total'));
  } finally {
    cleanup();
  }
});

test('fold budgets: a frontmatter-less thematic break does not hide a body fold marker', () => {
  const { root, cleanup } = makeRepo();
  try {
    const rel = 'wiki/entities/records/thematic-break.md';
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      `---\nintro prose\nkey: value\n---\nintro\n<!-- fold -->\n${'t'.repeat(PULL_WARN + 1)}\n`,
    );

    const result = classifyAndBucketPage(root, rel, new Set(), RECORD_DIR);
    assert.ok(result.extras.some((w) => w.kind === 'tail'));
    assert.equal(result.page.size, Buffer.byteLength('---\nintro prose\nkey: value\n---\nintro\n'));
  } finally {
    cleanup();
  }
});

test('an unreadable page THROWS; only a vanished one is skipped as a race', () => {
  // The gate is exhaustive: a page it cannot read must produce a verdict or an error, never
  // a silent gap. Absence and inaccessibility are told apart by a THROWING stat probe, not
  // by an errno allowlist (Windows reports a concurrent delete as EPERM/EACCES/EBUSY as
  // readily as ENOENT) and not by existsSync (which answers false for both). Both branches
  // are exercised here with real filesystem states, no mocking.
  const { root, cleanup } = makeRepo();
  try {
    // (1) VANISHED: never written. The tree walk raced a delete -> skip, no verdict.
    assert.equal(
      classifyAndBucketPage(root, 'wiki/entities/records/gone.md', new Set(), RECORD_DIR),
      null,
    );

    // (2) PRESENT but unreadable: a directory sitting where a page should be. statSync
    // succeeds, so this is NOT a race and must not be swallowed.
    const rel = 'wiki/entities/records/is-a-dir.md';
    mkdirSync(join(root, ...rel.split('/')), { recursive: true });
    assert.throws(() => classifyAndBucketPage(root, rel, new Set(), RECORD_DIR));
  } finally {
    cleanup();
  }
});

test('the long-line advisory is measured RAW; the updated: cap deliberately is not', () => {
  // Two byte-measured rules, two different views, on purpose.
  // LONG-LINE scans the raw head: it only splits on newlines and measures, so a latin1 view
  // is byte-exact and safe. Before the fix a 700-byte line (the rule warns only ABOVE 700)
  // tripped the advisory, because re-encoding turned each invalid byte into a 3-byte U+FFFD.
  // The updated: cap stays on the DECODED value: parsing latin1 would trim a raw 0xA0 as
  // NBSP and UNDER-count, and would diverge from the UTF-8 `updated:` merge driver.
  const { root, cleanup } = makeRepo();
  try {
    const rel = 'wiki/entities/records/raw-longline.md';
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    const bad = Buffer.alloc(200, 0x80); // never a valid UTF-8 lead byte
    const line = Buffer.concat([bad, Buffer.alloc(LONG_LINE_WARN - bad.length, 0x61)]);
    assert.equal(line.length, LONG_LINE_WARN); // exactly AT the threshold, must not warn
    writeFileSync(
      abs,
      Buffer.concat([Buffer.from('---\nname: b\ntype: entity\n---\n'), line, Buffer.from('\n')]),
    );

    const result = classifyAndBucketPage(root, rel, new Set(), RECORD_DIR);
    assert.ok(!result.extras.some((e) => e.kind === 'longLine'));
  } finally {
    cleanup();
  }
});

test('injected head/tail bytes are measured RAW - an invalid UTF-8 byte must not inflate them', () => {
  // plan 2434 hardened total size against a decode-then-re-encode round-trip (each invalid
  // byte becomes a 3-byte U+FFFD). Plan 3531 moved the hard cap onto the HEAD, and the head
  // was briefly re-encoded from decoded text - so a page one byte UNDER the cap reported
  // 10 KB over and was REFUSED. A false FAIL blocks a wiki write, which is exactly the
  // class 2434 exists to stop. Found by the landed-work-reversion reviewer, plan 3531.
  const { root, cleanup } = makeRepo();
  try {
    const rel = 'wiki/entities/records/invalid-utf8.md';
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    const fm = Buffer.from('---\nname: probe\ntype: entity\n---\n', 'utf8');
    const invalid = Buffer.alloc(5000, 0x80); // never a valid UTF-8 lead byte
    const filler = Buffer.alloc(INJECTED_FAIL - 1 - fm.length - invalid.length, 0x61);
    const buf = Buffer.concat([fm, invalid, filler]);
    writeFileSync(abs, buf);

    const result = classifyAndBucketPage(root, rel, new Set(), RECORD_DIR);
    assert.equal(buf.length, INJECTED_FAIL - 1);
    assert.equal(result.page.size, INJECTED_FAIL - 1);
    assert.notEqual(result.bucket, 'fail');
  } finally {
    cleanup();
  }
});

test('frontmatter keys are read from the SAME span the canonical fence parser picked', () => {
  // plan 3531 review round 4. frontmatterSpan used TWO frontmatter regexes: wiki-fold’s strict
  // one for the SPAN, and wiki-coverage-sweep's looser parseFrontmatter for the KEYS. They
  // delimit differently when an inner line begins with `---` followed by other text: the loose
  // regex stops there, the strict one skips it and runs to the real closing fence. So the keys
  // came from a SHORTER span than the one being measured, and any key after the inner line was
  // invisible. Here `updated:` sits after it with an over-cap value: it must be seen, because it
  // really is inside the frontmatter the span parser chose.
  const { root, cleanup } = makeRepo();
  try {
    const rel = 'wiki/entities/records/inner-dash-line.md';
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    const updated = 'x'.repeat(UPDATED_MAX + 1);
    const fm = '---\nname: x\n--- not a fence\nupdated: ' + updated + '\n---\n';
    writeFileSync(abs, fm + 'body\n');

    const result = classifyAndBucketPage(root, rel, new Set(), RECORD_DIR);
    assert.equal(result.bucket, 'fail');
    assert.equal(result.page.kind, 'updated');
    assert.equal(result.page.updatedBytes, Buffer.byteLength(updated));
  } finally {
    cleanup();
  }
});

test('fold budgets: LF/CRLF frontmatter with closing-fence whitespace uses the shared scan span', () => {
  const { root, cleanup } = makeRepo();
  try {
    for (const [label, eol] of [
      ['lf', '\n'],
      ['crlf', '\r\n'],
    ]) {
      const rel = `wiki/entities/records/frontmatter-${label}.md`;
      const abs = join(root, ...rel.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      const head = `---${eol}description: <!-- fold -->${eol}--- \t${eol}# head${eol}`;
      writeFileSync(abs, `${head}<!-- fold -->${eol}${'t'.repeat(PULL_WARN + 1)}`);

      const result = classifyAndBucketPage(root, rel, new Set(), RECORD_DIR);
      assert.equal(result.page.size, lfNormalizedByteLength(Buffer.from(head)));
      assert.ok(result.extras.some((w) => w.kind === 'tail' && w.size === PULL_WARN + 1));
    }
  } finally {
    cleanup();
  }
});

test('fold budgets: a head over 32 KB fails and NEAR-CAP measures the head', () => {
  const { root, cleanup } = makeRepo();
  try {
    const overRel = 'wiki/entities/records/rec-over-head.md';
    const nearRel = 'wiki/entities/records/rec-near-head.md';
    for (const [rel, headBytes] of [
      [overRel, INJECTED_FAIL + 1],
      [nearRel, INJECTED_NEAR_CAP],
    ]) {
      const abs = join(root, ...rel.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `${'h'.repeat(headBytes - 1)}\n<!-- fold -->\ntail`);
    }
    const result = checkPages(root, [overRel, nearRel]);
    assert.equal(result.fails.length, 1);
    assert.equal(result.fails[0].rel, overRel);
    assert.equal(result.fails[0].size, INJECTED_FAIL + 1);
    const near = result.warns.find((w) => w.rel === nearRel && w.nearCap);
    assert.ok(near);
    assert.equal(near.size, INJECTED_NEAR_CAP);
  } finally {
    cleanup();
  }
});

test('fold budgets: tail and total warnings fire only above their respective ceilings', () => {
  const { root, cleanup } = makeRepo();
  try {
    const writeFoldedAtTotal = (rel, totalBytes, tailBytes) => {
      const abs = join(root, ...rel.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      const prefix = '# h\n<!-- fold -->\n';
      const tail = 't'.repeat(tailBytes ?? totalBytes - Buffer.byteLength(prefix));
      writeFileSync(abs, prefix + tail);
    };
    writeFoldedAtTotal('wiki/entities/records/tail-at.md', 0, PULL_WARN);
    writeFoldedAtTotal('wiki/entities/records/tail-over.md', 0, PULL_WARN + 1);
    writeFoldedAtTotal('wiki/entities/records/total-at.md', ONE_READ_CEILING);
    writeFoldedAtTotal('wiki/entities/records/total-over.md', ONE_READ_CEILING + 1);

    const rels = [
      'wiki/entities/records/tail-at.md',
      'wiki/entities/records/tail-over.md',
      'wiki/entities/records/total-at.md',
      'wiki/entities/records/total-over.md',
    ];
    const { warns } = checkPages(root, rels);
    assert.ok(!warns.some((w) => w.rel.endsWith('tail-at.md') && w.kind === 'tail'));
    assert.ok(warns.some((w) => w.rel.endsWith('tail-over.md') && w.kind === 'tail'));
    assert.ok(!warns.some((w) => w.rel.endsWith('total-at.md') && w.kind === 'total'));
    assert.ok(warns.some((w) => w.rel.endsWith('total-over.md') && w.kind === 'total'));
  } finally {
    cleanup();
  }
});

test('the one-Read total warning also applies to pull pages', () => {
  const { root, cleanup } = makeRepo();
  try {
    const rel = 'wiki/concepts/large-pull.md';
    page(root, rel, { size: ONE_READ_CEILING + 1 });
    const { warns } = checkPages(root, [rel]);
    assert.ok(warns.some((w) => w.rel === rel && w.kind === 'total'));
  } finally {
    cleanup();
  }
});

test('classifyAndBucketPage: exempt page → bucket null, page.cls exempt (never fails/warns)', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/log.md', { size: 200 * KB });
    const result = classifyAndBucketPage(root, 'wiki/log.md', new Set(), RECORD_DIR);
    assert.equal(result.bucket, null);
    assert.equal(result.page.cls, 'exempt');
  } finally {
    cleanup();
  }
});

// plan 2434 (sonnet-review fix) — lfNormalizedByteLength must count on the raw buffer, never
// via a UTF-8 decode/re-encode round-trip: decoding replaces any invalid byte sequence with
// the 3-byte U+FFFD replacement character, which would inflate the measured size instead of
// just stripping CRLF.
test('lfNormalizedByteLength: an invalid UTF-8 byte does not inflate the count (no decode round-trip)', () => {
  const invalidByte = Buffer.from([0x78, 0x92, 0x78]); // 'x', a lone 0x92 (invalid UTF-8 lead byte), 'x'
  assert.equal(lfNormalizedByteLength(invalidByte), 3);
});

test('lfNormalizedByteLength: strips CRLF pairs, leaves a lone CR or LF alone', () => {
  assert.equal(lfNormalizedByteLength(Buffer.from('a\r\nb\r\nc')), 5); // two CRLF pairs removed
  assert.equal(lfNormalizedByteLength(Buffer.from('a\rb\nc')), 5); // lone CR, lone LF: untouched
  assert.equal(lfNormalizedByteLength(Buffer.from('')), 0);
});

// A uniform-line LF body: `numLines` lines of `lineLength` chars each. Its CRLF form (each
// `\n` → `\r\n`) is exactly `numLines` bytes bigger — the plan-2434 shape: many short lines
// push a page's raw on-disk size past the cap while its LF-normalized size stays under it.
function uniformLineBody(numLines, lineLength) {
  return Array.from({ length: numLines }, () => 'x'.repeat(lineLength)).join('\n') + '\n';
}

// plan 2434 — CRLF-written pages must bucket by their LF-normalized (git-stored) size, not
// raw on-disk bytes: `.gitattributes` pins `eol=lf`, so bytes an editor left on disk never
// reach the committed/injected blob. Two shapes share one scaffold: LF-normalized under the
// cap while raw CRLF bytes are over it (the bug this guards — must not FAIL), and
// LF-normalized itself over the cap (a genuine reversion — must still FAIL).
for (const [label, numLines, expectFail] of [
  // cap 32 KB (operator 2026-08-03): 24 × 1365 B/line = 32760 LF-bytes (under) vs 32784 CRLF (over);
  // 25 lines = 34125 LF-bytes (over either way).
  ['LF-normalized size under the cap', 24, false],
  ['LF-normalized size over the cap', 25, true],
]) {
  test(`classifyAndBucketPage: CRLF page buckets by its LF-normalized size (${label})`, () => {
    const { root, cleanup } = makeRepo();
    try {
      const lfBody = uniformLineBody(numLines, 1364);
      const crlfBody = lfBody.replace(/\n/g, '\r\n');
      assert.ok(crlfBody.length > INJECTED_FAIL, 'fixture must be over the cap as raw CRLF bytes');

      const rel = `wiki/entities/records/rec-crlf-${numLines}.md`;
      const abs = join(root, ...rel.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, crlfBody);

      const hookBasenames = collectHookReferencedBasenames(root);
      const result = classifyAndBucketPage(root, rel, hookBasenames, RECORD_DIR);
      assert.equal(result.page.cls, 'injected');
      assert.equal(result.bucket === 'fail', expectFail);
      assert.equal(
        result.page.size,
        lfBody.length,
        'page.size must be the LF-normalized size, not raw bytes',
      );
    } finally {
      cleanup();
    }
  });
}

// The DRY-dedup contract (plan 1398 item 2): lintWikiSizes and checkPages must never diverge
// on the same page's bucketing outcome, since both now route through classifyAndBucketPage.
test('lintWikiSizes and checkPages agree on the same page (the DRY-dedup contract)', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/entities/records/rec-001.md', { size: INJECTED_FAIL + 1 });
    page(root, 'wiki/concepts/big.md', { size: PULL_WARN + 1 });
    // plan 2618: a long-line page pins the extras channel into the contract too — a caller
    // that forgets to drain `extras` (the finding-[5] divergence risk) diverges HERE.
    const longRel = 'wiki/entities/records/rec-longline.md';
    const longAbs = join(root, ...longRel.split('/'));
    mkdirSync(dirname(longAbs), { recursive: true });
    writeFileSync(longAbs, `# fixture\n${'y'.repeat(LONG_LINE_WARN + 1)}\n`);
    const rels = ['wiki/entities/records/rec-001.md', 'wiki/concepts/big.md', longRel];
    const full = lintWikiSizes(root);
    const scoped = checkPages(root, rels);
    assert.deepEqual(full.failures.map((f) => f.rel).sort(), scoped.fails.map((f) => f.rel).sort());
    assert.deepEqual(full.warns.map((w) => w.rel).sort(), scoped.warns.map((w) => w.rel).sort());
    assert.ok(
      scoped.warns.some((w) => w.kind === 'longLine' && w.rel === longRel),
      'the long-line advisory is part of the shared contract',
    );
  } finally {
    cleanup();
  }
});

// plan 1398 (item 3) — checkPages accepts a precomputed hookBasenames set (wiki-commit.mjs
// threads one through across coordWrite's retry loop instead of re-walking .claude/hooks/**
// on every retry). Prove the override is actually HONORED, not silently ignored: an
// entities-page that would classify 'pull' under the repo's real (empty) hook set instead
// classifies 'injected' when the caller passes a set naming its basename.
test('checkPages: an explicit hookBasenames override is honored (not re-derived)', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/entities/chains/unregistered.md', { size: INJECTED_FAIL + 1 });
    // No .claude/hooks/ dir at all → collectHookReferencedBasenames(root) would be empty and
    // this page would classify 'pull' (under the 24 KB pull warn, so 17 KB → clean).
    const auto = checkPages(root, ['wiki/entities/chains/unregistered.md']);
    assert.equal(auto.fails.length, 0);
    // Passing an explicit set naming this basename flips the classification to 'injected'
    // WITHOUT touching .claude/hooks/ at all — proving the override is used, not ignored.
    const overridden = checkPages(root, ['wiki/entities/chains/unregistered.md'], {
      hookBasenames: new Set(['unregistered.md']),
    });
    assert.equal(overridden.fails.length, 1);
    assert.equal(overridden.fails[0].rel, 'wiki/entities/chains/unregistered.md');
  } finally {
    cleanup();
  }
});

test('missing wiki/ dir → empty result, no throw', () => {
  const { root, cleanup } = makeRepo();
  try {
    const res = lintWikiSizes(root);
    assert.deepEqual(res, { pages: [], warns: [], failures: [] });
  } finally {
    cleanup();
  }
});

// ── plan 2487: the NEAR-CAP warn band ────────────────────────────────────────
// price-inspector.md sat at 16360/16384 bytes and refused every new burn-list entry
// mid-land, while the only signal it had ever emitted was the same soft 8 KB WARN line it
// had printed since crossing 8 KB. The band is a SEVERITY split inside the warn bucket:
// still advisory (never a fail, never an exit-code change), but self-describing.

test('NEAR-CAP: the threshold is exactly 90% of the hard cap, floored', () => {
  assert.equal(INJECTED_NEAR_CAP, Math.floor(INJECTED_FAIL * 0.9));
  assert.equal(INJECTED_NEAR_CAP, 29491); // operator 2026-08-03: 90% of the 32 KB cap
  assert.ok(INJECTED_NEAR_CAP > INJECTED_WARN && INJECTED_NEAR_CAP < INJECTED_FAIL);
});

test('NEAR-CAP: an injected page at >=90% of the cap warns as near-cap, never fails', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/entities/records/rec-001.md', { size: INJECTED_NEAR_CAP });
    const { fails, warns } = checkPages(root, ['wiki/entities/records/rec-001.md']);
    assert.equal(fails.length, 0, 'near-cap must not block — it is advisory');
    const near = sizeWarns(warns);
    assert.equal(near.length, 1);
    assert.equal(near[0].nearCap, true);
    assert.equal(near[0].limit, INJECTED_NEAR_CAP);
    assert.equal(near[0].cap, INJECTED_FAIL);
  } finally {
    cleanup();
  }
});

test('NEAR-CAP: one byte below the band is an ordinary 8 KB warn, not near-cap', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/entities/records/rec-001.md', { size: INJECTED_NEAR_CAP - 1 });
    const { warns } = checkPages(root, ['wiki/entities/records/rec-001.md']);
    const ordinary = sizeWarns(warns);
    assert.equal(ordinary.length, 1);
    assert.equal(ordinary[0].nearCap, undefined);
    assert.equal(ordinary[0].limit, INJECTED_WARN);
  } finally {
    cleanup();
  }
});

test('NEAR-CAP: over the cap still FAILS — the band never softens the hard refusal', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/entities/records/rec-001.md', { size: INJECTED_FAIL + 1 });
    const { fails, warns } = checkPages(root, ['wiki/entities/records/rec-001.md']);
    assert.equal(fails.length, 1);
    assert.equal(fails[0].limit, INJECTED_FAIL);
    assert.equal(sizeWarns(warns).length, 0, 'a fail is not also reported as a warn');
  } finally {
    cleanup();
  }
});

test('NEAR-CAP: a pull page at the same size is unaffected (band is injected-only)', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/concepts/big.md', { size: INJECTED_NEAR_CAP + 10 });
    const { fails, warns } = checkPages(root, ['wiki/concepts/big.md']);
    assert.equal(fails.length, 0);
    // Since the 32 KB injected cap rose past the (unchanged) 24 KB pull warn, a pull page at
    // the injected near-cap size legitimately carries the plain pull WARN — the contract here
    // is only that the NEAR-CAP band itself never applies to a pull page.
    assert.ok(
      warns.every((w) => !w.nearCap),
      'no pull warn carries the injected-only near-cap band',
    );
  } finally {
    cleanup();
  }
});

test('formatBudgetWarning: near-cap names the headroom in bytes; a plain warn does not', () => {
  const near = formatBudgetWarning({
    rel: 'wiki/entities/inspectors/price-inspector.md',
    size: INJECTED_FAIL - 24, // the historical 24-bytes-of-headroom shape, cap-relative
    cls: 'injected',
    limit: INJECTED_NEAR_CAP,
    cap: INJECTED_FAIL,
    nearCap: true,
  });
  assert.equal(near.severity, 'NEAR-CAP');
  assert.match(near.message, /24 bytes of headroom left/);
  assert.match(near.message, /REFUSED/);

  const plain = formatBudgetWarning({
    rel: 'wiki/entities/chains/x.md',
    size: 9 * KB,
    cls: 'injected',
    limit: INJECTED_WARN,
  });
  assert.equal(plain.severity, 'WARN');
  assert.match(plain.message, /budget warns above 8\.0 KB/);
  assert.ok(!/headroom/.test(plain.message));
});

// ── plan 2618 rules (cap 32 KB since 2026-08-03), updated:-length FAIL, long-line advisory ───
// The cap raise alone would only defer the wall; the two rules that keep pages lean
// (WIKI.md § Page budgets rules 2/3) had decayed unenforced — updated: chains reached
// 8.3 KB and burn-list entries grew to ~1 KB paragraphs. updated:-length is a hard FAIL
// (the trim is always lossless — history lives in wiki/log.md); long lines only warn
// (existing pages carry legit 700–1700 B lines) but surface at write time in wiki-commit.

test('operator 2026-08-03: the injected cap is 32 KB', () => {
  assert.equal(INJECTED_FAIL, 32 * KB);
});

test('updatedValueLength: measures the trimmed value bytes off full page text; absent key → 0', () => {
  assert.equal(updatedValueLength('---\nupdated: 2026-07-29 (plan 2618)\n---\n# t\n'), 22);
  assert.equal(updatedValueLength('---\nname: x\nupdated: abc\nkind: y\n---\nbody'), 3);
  // trailing whitespace is trimmed by the single-owner parser — it never counts (sonnet-review)
  assert.equal(updatedValueLength('---\nupdated: abc   \n---\nbody'), 3);
  assert.equal(updatedValueLength('---\nname: x\n---\nbody'), 0);
  assert.equal(updatedValueLength('# no frontmatter\n'), 0);
});

test('updated: over the cap FAILS an injected page, with the updated kind', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, REC_PAGE, {
      size: 2 * KB,
      frontmatter: `updated: ${'h'.repeat(UPDATED_MAX + 1)}`,
    });
    const { fails, warns } = checkPages(root, ['wiki/entities/records/rec-001.md']);
    assert.equal(fails.length, 1);
    assert.equal(fails[0].kind, 'updated');
    assert.equal(fails[0].updatedBytes, UPDATED_MAX + 1);
    assert.equal(fails[0].limit, UPDATED_MAX);
    assert.equal(warns.length, 0);
  } finally {
    cleanup();
  }
});

test('updated: over the cap FAILS a pull page too (the 8.3 KB appendix-chain shape)', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, 'wiki/concepts/akut-tiers.md', {
      size: 2 * KB,
      frontmatter: `updated: ${'h'.repeat(2 * KB)}`,
    });
    const { fails } = checkPages(root, ['wiki/concepts/akut-tiers.md']);
    assert.equal(fails.length, 1);
    assert.equal(fails[0].kind, 'updated');
  } finally {
    cleanup();
  }
});

test('updated: exactly at the cap passes; exempt pages skip the rule entirely', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, REC_PAGE, {
      size: 2 * KB,
      frontmatter: `updated: ${'h'.repeat(UPDATED_MAX)}`,
    });
    page(root, 'wiki/log.md', {
      size: 2 * KB,
      frontmatter: `updated: ${'h'.repeat(2 * KB)}`,
    });
    const { fails, warns } = checkPages(root, ['wiki/entities/records/rec-001.md', 'wiki/log.md']);
    assert.equal(fails.length, 0);
    assert.equal(warns.length, 0);
  } finally {
    cleanup();
  }
});

test('a size FAIL outranks the updated: fail — one fail per page, biggest problem first', () => {
  const { root, cleanup } = makeRepo();
  try {
    page(root, REC_PAGE, {
      size: INJECTED_FAIL + 1,
      frontmatter: `updated: ${'h'.repeat(UPDATED_MAX + 1)}`,
    });
    const { fails } = checkPages(root, ['wiki/entities/records/rec-001.md']);
    assert.equal(fails.length, 1);
    assert.equal(fails[0].kind, undefined);
    assert.equal(fails[0].limit, INJECTED_FAIL);
  } finally {
    cleanup();
  }
});

test('longBodyLines: counts body lines over the threshold, names the first, skips frontmatter', () => {
  const long = 'y'.repeat(LONG_LINE_WARN + 1);
  const fmLong = `---\nupdated: ${'h'.repeat(LONG_LINE_WARN + 50)}\n---\n# t\nshort\n`;
  const bodyStart = fmLong.indexOf('# t');
  assert.deepEqual(longBodyLines(fmLong, { bodyStart }), { count: 0, first: null });
  const twoLong = `# t\n${long}\nshort\n${long}\n`;
  assert.deepEqual(longBodyLines(twoLong), {
    count: 2,
    first: { line: 2, bytes: LONG_LINE_WARN + 1 },
  });
});

test('a long body line on an INJECTED page warns (LONG-LINE) without blocking; pull pages are unaffected', () => {
  const { root, cleanup } = makeRepo();
  try {
    const body = `# fixture\n${'y'.repeat(LONG_LINE_WARN + 100)}\nshort line\n`;
    for (const rel of [REC_PAGE, 'wiki/concepts/notes.md']) {
      const abs = join(root, ...rel.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    const { fails, warns } = checkPages(root, [
      'wiki/entities/records/rec-001.md',
      'wiki/concepts/notes.md',
    ]);
    assert.equal(fails.length, 0, 'advisory only — never blocks');
    assert.equal(warns.length, 1, 'injected page only');
    assert.equal(warns[0].rel, 'wiki/entities/records/rec-001.md');
    assert.equal(warns[0].kind, 'longLine');
    assert.equal(warns[0].longLines, 1);
    assert.equal(warns[0].firstLongLine.line, 2);
    const rendered = formatBudgetWarning(warns[0]);
    assert.equal(rendered.severity, 'LONG-LINE');
    assert.match(rendered.message, /ONE line \+ a pointer/);
  } finally {
    cleanup();
  }
});

test('an injected page long-line advisory scans only the head above the fold', () => {
  const { root, cleanup } = makeRepo();
  try {
    const long = 'y'.repeat(900);
    const aboveRel = 'wiki/entities/records/above-fold.md';
    const belowRel = 'wiki/entities/records/below-fold.md';
    for (const [rel, body] of [
      [aboveRel, `# fixture\n${long}\n<!-- fold -->\ntail\n`],
      [belowRel, `# fixture\n<!-- fold -->\n${long}\n`],
    ]) {
      const abs = join(root, ...rel.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }

    const { warns } = checkPages(root, [aboveRel, belowRel]);
    assert.ok(warns.some((w) => w.rel === aboveRel && w.kind === 'longLine'));
    assert.ok(!warns.some((w) => w.rel === belowRel && w.kind === 'longLine'));
  } finally {
    cleanup();
  }
});

test('the long-line advisory rides BESIDE the size bucket — a near-cap page reports both', () => {
  const { root, cleanup } = makeRepo();
  try {
    const long = 'y'.repeat(LONG_LINE_WARN + 100);
    let body = `# fixture\n${long}\n`;
    while (body.length < INJECTED_NEAR_CAP) {
      body += 'x'.repeat(Math.min(100, INJECTED_NEAR_CAP - body.length - 1) || 1) + '\n';
    }
    const rel = 'wiki/entities/records/rec-001.md';
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    const { fails, warns } = checkPages(root, [rel]);
    assert.equal(fails.length, 0);
    // plan 4027: this fixture is a near-cap page with one over-long line and, at ~300 short
    // padding lines and no marker, an over-bound above-fold body too — so all three ride
    // together. That every advisory reports independently of the size bucket IS this test's
    // point, so the fold advisory is asserted here rather than filtered out.
    assert.equal(warns.length, 3);
    assert.deepEqual(warns.map((w) => w.kind ?? 'size').sort(), ['foldHead', 'longLine', 'size']);
    assert.equal(sizeWarns(warns).length, 1, 'ADVISORY_KINDS leaves exactly the size bucket');
  } finally {
    cleanup();
  }
});

test('formatBudgetFailure: the updated: refusal names the rule; the size refusal names the cap', () => {
  const updated = formatBudgetFailure({
    rel: 'wiki/entities/chains/chainb.md',
    size: 10 * KB,
    cls: 'injected',
    kind: 'updated',
    updatedBytes: 5992,
    limit: UPDATED_MAX,
  });
  assert.match(updated, /`updated:` value is 5992 bytes/);
  assert.match(updated, /accretion chain/);
  assert.match(updated, /wiki\/log\.md/);

  const size = formatBudgetFailure({
    rel: 'wiki/entities/records/rec-001.md',
    size: INJECTED_FAIL + KB,
    cls: 'injected',
    limit: INJECTED_FAIL,
  });
  assert.match(size, /exceeds the 32\.0 KB injected-page cap/);
  assert.ok(!/updated:/.test(size));
});

// ── plan 4027: the fold-structure rule ───────────────────────────────────────
// Folded into this file rather than a new scripts/lint-wiki-fold.test.mjs: the rule lives in
// wiki-size-lint.mjs, and the repo default is to fold new cases into the module's existing
// name-paired test file.

// A page whose body is `lines` non-blank lines, optionally split by a fold marker after
// `foldAfter` of them. Lines are short, so nothing here trips the long-line advisory.
function foldPage(root, rel, { lines, foldAfter = null, frontmatter = '' } = {}) {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  let body = frontmatter ? `---\n${frontmatter}\n---\n` : '';
  for (let i = 0; i < lines; i++) {
    if (foldAfter !== null && i === foldAfter) body += '<!-- fold -->\n';
    body += `line ${i}\n`;
  }
  if (foldAfter !== null && foldAfter >= lines) body += '<!-- fold -->\n';
  writeFileSync(abs, body);
}

test('isFoldable: entities/** is in scope, appendices and non-entities are not', () => {
  assert.equal(isFoldable('wiki/entities/chains/anicura.md'), true);
  assert.equal(isFoldable('wiki/entities/records/rec-004.md'), true);
  // the fold's DESTINATION is never asked to fold itself (WIKI.md § Page budgets rules 5-6)
  assert.equal(isFoldable('wiki/entities/inspectors/price-inspector' + APPENDIX_SUFFIX), false);
  assert.equal(isFoldable('wiki/entities/platforms/acme-cloud-appendix.md'), false);
  // no loader reaches concepts/ or the vault root
  assert.equal(isFoldable('wiki/concepts/pipeline-phases.md'), false);
  assert.equal(isFoldable('wiki/hot.md'), false);
});

test('aboveFoldBody: counts non-blank lines above the marker, reports the split', () => {
  const noMarker = aboveFoldBody('a\n\n\nb\nc\n');
  assert.deepEqual(noMarker, { lines: 3, marked: false, extraMarkers: 0 });

  const marked = aboveFoldBody('a\nb\n<!-- fold -->\nc\nd\ne\n');
  assert.equal(marked.lines, 2, 'only the head counts');
  assert.equal(marked.marked, true);

  // blank lines are typesetting, not claims — two spacings of the same content agree
  assert.equal(aboveFoldBody('a\nb\nc\n').lines, aboveFoldBody('a\n\nb\n\n\nc\n').lines);
});

test('aboveFoldBody: a marker on the LAST line still counts as marked (empty tail)', () => {
  // splitFold returns an empty tail both for "no marker" and for "marker last"; only the
  // head-shortening tells them apart, which is the bug this pins.
  const r = aboveFoldBody('a\nb\n<!-- fold -->\n');
  assert.equal(r.marked, true, 'a trailing marker is a real split, not an absent one');
  assert.equal(r.lines, 2);
});

test('aboveFoldBody: bodyStart skips frontmatter; extra markers are counted, not merged', () => {
  const text = '---\nupdated: 2026-09-14\n---\na\nb\n<!-- fold -->\nc\n<!-- fold -->\nd\n';
  const r = aboveFoldBody(text, { bodyStart: text.indexOf('---\na') + 4 });
  assert.equal(r.lines, 2, 'frontmatter is not body');
  assert.equal(r.marked, true);
  assert.equal(r.extraMarkers, 1, 'the second marker is inert but reported');
});

test('aboveFoldBody: a marker inside a fenced block is not a split (splitFold semantics)', () => {
  const r = aboveFoldBody('a\n```\n<!-- fold -->\n```\nb\n');
  assert.equal(r.marked, false);
  assert.equal(r.lines, 5, 'the fence and its contents stay above the fold');
});

test('fold rule: an unfolded entity page over the bound warns; under it is silent', () => {
  const { root, cleanup } = makeRepo();
  try {
    foldPage(root, 'wiki/entities/chains/long.md', { lines: FOLD_ABOVE_MAX_LINES + 1 });
    foldPage(root, 'wiki/entities/chains/short.md', { lines: FOLD_ABOVE_MAX_LINES });
    const { fails, warns } = checkPages(root, [
      'wiki/entities/chains/long.md',
      'wiki/entities/chains/short.md',
    ]);
    assert.equal(fails.length, 0, 'the fold rule never blocks — warn-only until the sweep lands');
    const fold = warns.filter((w) => w.kind === 'foldHead');
    assert.deepEqual(
      fold.map((w) => w.rel),
      ['wiki/entities/chains/long.md'],
      'exactly at the bound is compliant; one over warns',
    );
    assert.equal(fold[0].marked, false);
    assert.equal(fold[0].aboveFoldLines, FOLD_ABOVE_MAX_LINES + 1);
  } finally {
    cleanup();
  }
});

test('fold rule: a marker rescues a long page; a long HEAD still warns', () => {
  const { root, cleanup } = makeRepo();
  try {
    // 400 lines of history, but only 10 above the fold → compliant
    foldPage(root, 'wiki/entities/platforms/ok.md', { lines: 400, foldAfter: 10 });
    // marker present but the head itself is over the bound → warns, with the marked wording
    foldPage(root, 'wiki/entities/platforms/fat.md', {
      lines: 400,
      foldAfter: FOLD_ABOVE_MAX_LINES + 5,
    });
    const { warns } = checkPages(root, [
      'wiki/entities/platforms/ok.md',
      'wiki/entities/platforms/fat.md',
    ]);
    const fold = warns.filter((w) => w.kind === 'foldHead');
    assert.deepEqual(
      fold.map((w) => w.rel),
      ['wiki/entities/platforms/fat.md'],
      'a page is judged on its HEAD, not its total length',
    );
    assert.equal(fold[0].marked, true);
  } finally {
    cleanup();
  }
});

test('fold rule: appendices and non-entity pages are out of scope however long', () => {
  const { root, cleanup } = makeRepo();
  try {
    const rels = [
      'wiki/entities/inspectors/price-inspector' + APPENDIX_SUFFIX,
      'wiki/concepts/pipeline-phases.md',
    ];
    for (const rel of rels) foldPage(root, rel, { lines: FOLD_ABOVE_MAX_LINES * 10 });
    const { fails, warns } = checkPages(root, rels);
    assert.equal(fails.length, 0);
    assert.equal(
      warns.filter((w) => w.kind === 'foldHead').length,
      0,
      'a fold destination is never asked to fold itself',
    );
  } finally {
    cleanup();
  }
});

test('fold rule: the full-tree walk reports it too, not just the write-time check', () => {
  const { root, cleanup } = makeRepo();
  try {
    foldPage(root, 'wiki/entities/chains/long.md', { lines: FOLD_ABOVE_MAX_LINES + 1 });
    const { failures, warns } = lintWikiSizes(root);
    assert.equal(failures.length, 0);
    assert.deepEqual(
      warns.filter((w) => w.kind === 'foldHead').map((w) => w.rel),
      ['wiki/entities/chains/long.md'],
      'both surfaces read the same shared per-page core',
    );
  } finally {
    cleanup();
  }
});

test('formatBudgetWarning: the fold advisory names the right remedy for each shape', () => {
  const unmarked = formatBudgetWarning({
    rel: 'wiki/entities/chains/anicura.md',
    cls: 'pull',
    kind: 'foldHead',
    aboveFoldLines: 108,
    limit: FOLD_ABOVE_MAX_LINES,
    marked: false,
    extraMarkers: 0,
  });
  assert.equal(unmarked.severity, 'FOLD');
  assert.match(unmarked.message, /108 non-blank body lines and no `<!-- fold -->` marker/);
  assert.match(unmarked.message, /WHOLE page is injected as current truth/);

  const marked = formatBudgetWarning({
    rel: 'wiki/entities/platforms/acme-cloud.md',
    cls: 'injected',
    kind: 'foldHead',
    aboveFoldLines: 142,
    limit: FOLD_ABOVE_MAX_LINES,
    marked: true,
  });
  assert.match(marked.message, /142 non-blank lines above/);
  assert.match(marked.message, /move\s+dated history below it/);
  assert.ok(
    !/WHOLE page/.test(marked.message),
    'a page that already folds must not be told it has no marker',
  );
});

// plan 4027 /gpt-review round 1 — the three confirmed findings, each pinned failing-first.

test('fold rule: line counting is LF/CRLF only, uniformly with its sibling parsers', () => {
  // Round 1 of /gpt-review (8d67e3) asked for lone-CR awareness here; round 2 (978632, df96c5,
  // 3bbfac, 0d49c1, 6907bb, c0c4ba, 91466c) showed that making ONLY this function CR-aware is
  // the worse state, because splitFrontmatter still would not find lone-CR frontmatter and the
  // metadata would then be counted as body. `.gitattributes` pins eol=lf and no tracked page
  // uses lone CR, so this pins the uniform stance rather than a half-migration.
  const crOnly = Array.from({ length: FOLD_ABOVE_MAX_LINES + 5 }, (_, i) => `line ${i}`).join('\r');
  assert.equal(aboveFoldBody(crOnly).lines, 1, 'a CR-only page is one line to every parser here');

  // the contract that actually governs committed pages:
  const lf = Array.from({ length: FOLD_ABOVE_MAX_LINES + 5 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(aboveFoldBody(lf).lines, FOLD_ABOVE_MAX_LINES + 5);
  const crlf = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\r\n');
  assert.equal(aboveFoldBody(crlf).lines, 10);
});

test('fold rule: a stray second marker is reported even when the page is within the bound', () => {
  // gpt-review bb7fa2/c65c78/4522f6: extraMarkers rode only on the over-bound warn, so on a
  // compliant page — which is every committed page that already folds — it could never fire,
  // though WIKI.md asks for exactly one marker.
  const { root, cleanup } = makeRepo();
  try {
    const rel = 'wiki/entities/chains/two-markers.md';
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'current\n\n<!-- fold -->\n\nhistory\n\n<!-- fold -->\n\nmore\n');
    const { fails, warns } = checkPages(root, [rel]);
    assert.equal(fails.length, 0);
    const marker = warns.filter((w) => w.kind === 'foldMarkers');
    assert.equal(marker.length, 1, 'a stray marker must surface on a within-bound page');
    assert.equal(marker[0].extraMarkers, 1);
    assert.equal(
      warns.filter((w) => w.kind === 'foldHead').length,
      0,
      'the page is within the bound, so only the marker advisory fires',
    );
    const { severity, message } = formatBudgetWarning(marker[0]);
    assert.equal(severity, 'FOLD');
    assert.match(message, /1 further/);
  } finally {
    cleanup();
  }
});

test('ADVISORY_KINDS is the single list the size tests filter on', () => {
  // gpt-review 47bf11: the test helper enumerated advisory kinds by hand, so a future advisory
  // would silently leak into assertions that mean to be about the size buckets only.
  assert.ok(ADVISORY_KINDS.has('longLine'));
  assert.ok(ADVISORY_KINDS.has('foldHead'));
  assert.ok(ADVISORY_KINDS.has('foldMarkers'));
  assert.ok(!ADVISORY_KINDS.has('tail'), 'tail is a size warn, not an advisory');
  assert.ok(!ADVISORY_KINDS.has('total'), 'total is a size warn, not an advisory');
});

test('plan 4172 review 498d8a: an UNREADABLE coord.config.json fails the lint loudly instead of dropping the record-page cap', () => {
  const { root, cleanup } = makeRepo();
  try {
    writeFileSync(join(root, 'coord.config.json'), '{ not json');
    page(root, 'wiki/entities/records/rec-001.md', { size: INJECTED_FAIL + 1 });
    assert.throws(() => lintWikiSizes(root));
    assert.throws(() => checkPages(root, ['wiki/entities/records/rec-001.md']));
  } finally {
    cleanup();
  }
});
