// scripts/wiki-commit.test.mjs (plan 1279)
// wiki-commit.mjs is the one sanctioned way to commit wiki/** (+ WIKI.md) on the main
// checkout. The load-bearing property is sweep-proofness: a PATHSPEC commit of the
// named pages must never consume a peer session's staged files from the shared index
// (the plan-1256 incident class). Tests mirror record-wiki.test.mjs: pure fns direct,
// commit fn against a real temp repo, CLI validation via spawnSync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseWikiCommitArgs,
  normalizeWikiPaths,
  prettierWrite,
  commitWikiPages,
  checkSizeOrThrow,
  checkWikiLoaderCoverageOrThrow,
  isWorktreeSessionBranch,
  resolveStalePageContent,
  checkContainment,
  gitShowBlobOrNull,
  gitShowBlobsOrNull,
  CHAIN_REGISTRY_REL,
  wikiPagesOnly,
  describeStaleFetchFailure,
} from './wiki-commit.mjs';
import { collectHookReferencedBasenames } from './coord/wiki-size-lint.mjs';
// plan 3411: the canonical selector, so the derivation test below asserts against the SAME
// source wiki-commit.mjs derives from rather than a second copy of the expected test name.
import { selectDataTriggeredTests } from './coord/select-battery-tests.mjs';

for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'wiki-commit.mjs');

function makeRepoWithWiki() {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-commit-test-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  mkdirSync(join(dir, 'wiki', 'entities'), { recursive: true });
  writeFileSync(join(dir, 'wiki', 'entities', 'page.md'), '# page\n');
  writeFileSync(join(dir, 'wiki', 'log.md'), '# log\n');
  // plan 4172: the per-record page dir is config (`wikiRecordDir`), read by the size lint.
  writeFileSync(
    join(dir, 'coord.config.json'),
    JSON.stringify({ wikiRecordDir: 'wiki/entities/records' }),
  );
  g('add', '-A');
  g('commit', '-qm', 'init wiki');
  return { dir, g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('parseWikiCommitArgs: pages + -m/--message + booleans; unknown flag throws', () => {
  const r = parseWikiCommitArgs(['wiki/a.md', 'wiki/log.md', '-m', 'chore(wiki): x', '--no-push']);
  assert.deepEqual(r.paths, ['wiki/a.md', 'wiki/log.md']);
  assert.equal(r.flags.message, 'chore(wiki): x');
  assert.equal(r.flags.noPush, true);
  assert.equal(r.flags.dry, false);
  assert.equal(parseWikiCommitArgs(['wiki/a.md', '--message', 'y', '--dry']).flags.dry, true);
  assert.throws(() => parseWikiCommitArgs(['wiki/a.md', '--mesage', 'x']), /unknown flag/);
});

test('normalizeWikiPaths: normalizes separators, accepts WIKI.md, rejects non-wiki and traversal', () => {
  assert.deepEqual(normalizeWikiPaths(['wiki\\entities\\page.md', './wiki/log.md', 'WIKI.md']), [
    'wiki/entities/page.md',
    'wiki/log.md',
    'WIKI.md',
  ]);
  assert.throws(() => normalizeWikiPaths([]), /no pages/);
  assert.throws(() => normalizeWikiPaths(['docs/INDEX.md']), /not under wiki\//);
  assert.throws(() => normalizeWikiPaths(['wiki/../secrets.md']), /"\.\."/);
  assert.throws(() => normalizeWikiPaths(['wiki/']), /not under wiki\//);
});

// plan 3411: the one named exception — scripts/wiki-chain-registry.mjs rides alongside wiki
// pages so a chain page + its CHAINS registry row can land in one atomic commit.
test('normalizeWikiPaths: accepts scripts/wiki-chain-registry.mjs alongside wiki pages (plan 3411 exception)', () => {
  const result = normalizeWikiPaths([
    'wiki/entities/chains/vets4pets.md',
    'wiki/log.md',
    CHAIN_REGISTRY_REL,
  ]);
  assert.deepEqual(result, [
    'wiki/entities/chains/vets4pets.md',
    'wiki/log.md',
    CHAIN_REGISTRY_REL,
  ]);
  assert.equal(CHAIN_REGISTRY_REL, 'scripts/wiki-chain-registry.mjs');
  // Windows-separator / dot-relative spellings normalize the same way wiki paths do.
  assert.deepEqual(normalizeWikiPaths(['scripts\\wiki-chain-registry.mjs']), [CHAIN_REGISTRY_REL]);
  assert.deepEqual(normalizeWikiPaths(['./scripts/wiki-chain-registry.mjs']), [CHAIN_REGISTRY_REL]);
});

// The exception is EXACTLY one file — every other scripts/ path, including a near-miss name,
// still hits the unchanged refusal (the CLI exit-code classifier regex-matches this wording).
test('normalizeWikiPaths: every OTHER scripts/ path is still refused — the exception is exactly one file', () => {
  assert.throws(() => normalizeWikiPaths(['scripts/wiki-commit.mjs']), /not under wiki\//);
  assert.throws(
    () => normalizeWikiPaths(['scripts/wiki-chain-registry.test.mjs']),
    /not under wiki\//,
    "a near-miss name (the registry's own test file) is NOT the exception",
  );
  assert.throws(
    () => normalizeWikiPaths(['scripts/wiki-loader-coverage.test.mjs']),
    /not under wiki\//,
  );
  // Mixed with an otherwise-valid wiki page — one bad path still fails the whole call.
  assert.throws(
    () => normalizeWikiPaths(['wiki/log.md', 'scripts/wiki-commit.mjs']),
    /not under wiki\//,
  );
});

test('wikiPagesOnly: drops the chain registry, keeps every wiki page untouched', () => {
  const input = ['wiki/entities/chains/vets4pets.md', CHAIN_REGISTRY_REL, 'wiki/log.md'];
  assert.deepEqual(wikiPagesOnly(input), ['wiki/entities/chains/vets4pets.md', 'wiki/log.md']);
  assert.deepEqual(wikiPagesOnly(['wiki/log.md']), ['wiki/log.md']);
  assert.deepEqual(wikiPagesOnly([CHAIN_REGISTRY_REL]), []);
  assert.deepEqual(wikiPagesOnly([]), []);
});

test('prettierWrite: formats a page in-process, skips missing + prettier-ignored files', async () => {
  const r = makeRepoWithWiki();
  try {
    // messy markdown prettier will rewrite (setext heading + * bullets → atx + -)
    writeFileSync(join(r.dir, 'wiki', 'entities', 'page.md'), 'Title\n=====\n\n*   item one\n');
    writeFileSync(join(r.dir, 'wiki', 'ignored.md'), 'Ignored\n=======\n');
    writeFileSync(join(r.dir, '.prettierignore'), 'wiki/ignored.md\n');
    const existing = await prettierWrite(r.dir, [
      'wiki/entities/page.md',
      'wiki/ignored.md',
      'wiki/gone.md',
    ]);
    assert.deepEqual(existing, ['wiki/entities/page.md', 'wiki/ignored.md']);
    const formatted = readFileSync(join(r.dir, 'wiki', 'entities', 'page.md'), 'utf8');
    assert.match(formatted, /^# Title/m, 'setext heading reformatted to atx');
    assert.match(formatted, /^- item one/m, '* bullet reformatted to -');
    assert.equal(
      readFileSync(join(r.dir, 'wiki', 'ignored.md'), 'utf8'),
      'Ignored\n=======\n',
      '.prettierignore is honored',
    );
  } finally {
    r.cleanup();
  }
});

test('commitWikiPages: pathspec commit records ONLY the named pages — a peer’s staged file survives unswept', () => {
  const r = makeRepoWithWiki();
  try {
    // Peer session's staged file sitting in the shared index (the plan-1256 shape).
    writeFileSync(join(r.dir, 'peer-session-entry.md'), 'peer work\n');
    r.g('add', 'peer-session-entry.md');
    // Our wiki edit (one tracked page + one NEW page — the add must stage untracked too).
    writeFileSync(join(r.dir, 'wiki', 'entities', 'page.md'), '# page\nupdated\n');
    writeFileSync(join(r.dir, 'wiki', 'entities', 'new-page.md'), '# new\n');

    let pushed = false;
    const res = commitWikiPages(r.dir, ['wiki/entities/page.md', 'wiki/entities/new-page.md'], {
      message: 'chore(wiki): update page + add new-page',
      _push: () => {
        pushed = true;
      },
    });
    assert.equal(res.noop, false);
    assert.equal(pushed, true);
    assert.match(r.g('log', '-1', '--format=%s'), /chore\(wiki\): update page \+ add new-page/);
    const committed = r.g('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort();
    assert.deepEqual(committed, ['wiki/entities/new-page.md', 'wiki/entities/page.md']);
    // The peer's staged file was NOT swept: still staged, still uncommitted.
    assert.match(r.g('status', '--porcelain', '--', 'peer-session-entry.md'), /^A /);
  } finally {
    r.cleanup();
  }
});

// plan 3411 item 5: the registry rides the SAME commit as the page(s), start to finish — the
// missing/tracked check, the add/commit pathspec, and the resulting commit all treat it exactly
// like a wiki page (no special-casing anywhere in commitWikiPages itself).
test('commitWikiPages: a wiki page + scripts/wiki-chain-registry.mjs land in ONE atomic commit', () => {
  const r = makeRepoWithWiki();
  try {
    mkdirSync(join(r.dir, 'scripts'), { recursive: true });
    writeFileSync(join(r.dir, 'scripts', 'wiki-chain-registry.mjs'), 'export const CHAINS = [];\n');
    mkdirSync(join(r.dir, 'wiki', 'entities', 'chains'), { recursive: true });
    writeFileSync(join(r.dir, 'wiki', 'entities', 'chains', 'newchain.md'), '# newchain\n');
    const res = commitWikiPages(r.dir, ['wiki/entities/chains/newchain.md', CHAIN_REGISTRY_REL], {
      message: 'chore(wiki): register newchain',
      noPush: true,
    });
    assert.equal(res.noop, false);
    const committed = r.g('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort();
    assert.deepEqual(committed, [CHAIN_REGISTRY_REL, 'wiki/entities/chains/newchain.md']);
    assert.match(r.g('log', '-1', '--format=%s'), /register newchain/);
  } finally {
    r.cleanup();
  }
});

test('commitWikiPages: no change on the named pages short-circuits to a no-op', () => {
  const r = makeRepoWithWiki();
  try {
    const before = r.g('rev-parse', 'HEAD').trim();
    const res = commitWikiPages(r.dir, ['wiki/log.md'], {
      message: 'chore(wiki): noop',
      noPush: true,
    });
    assert.equal(res.noop, true);
    assert.equal(r.g('rev-parse', 'HEAD').trim(), before);
  } finally {
    r.cleanup();
  }
});

test('commitWikiPages: commits run HUSKY=0 (sanctioned-writer convention — the guard must not fire)', () => {
  const r = makeRepoWithWiki();
  try {
    writeFileSync(join(r.dir, 'wiki', 'log.md'), '# log\nentry\n');
    const envs = [];
    commitWikiPages(r.dir, ['wiki/log.md'], {
      message: 'chore(wiki): log',
      noPush: true,
      _gitRetry: (dir, args, opts) => {
        envs.push(opts.env.HUSKY);
        execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
      },
    });
    assert.deepEqual(envs, ['0', '0'], 'both add and commit carry HUSKY=0');
  } finally {
    r.cleanup();
  }
});

test('CLI: missing message exits 2 before any git', () => {
  const r = spawnSync(process.execPath, [CLI, 'wiki/log.md'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /commit message is required/);
});

test('CLI: a non-wiki path exits 2 before any git', () => {
  const r = spawnSync(process.execPath, [CLI, 'docs/INDEX.md', '-m', 'x'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not under wiki\//);
});

// plan 1279 review finding [0]: a typo'd / never-created page must be a LOUD error, not
// a success-looking "nothing to commit" that masks a lost write-back.
test('CLI: a nonexistent, untracked page exits 2 naming the typo (no silent no-op)', () => {
  const r = makeRepoWithWiki();
  try {
    const res = spawnSync(
      process.execPath,
      [CLI, 'wiki/entities/chians-typo.md', '-m', 'chore(wiki): x', '--no-push'],
      { cwd: r.dir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: '' } },
    );
    assert.equal(res.status, 2);
    assert.match(res.stderr, /no such page/);
    assert.match(res.stderr, /chians-typo/);
  } finally {
    r.cleanup();
  }
});

// plan 1362 (D1) — wiki-commit runs the pre-push wiki-size-lint budget check itself, at
// commit time, so an over-cap injected page never lands with HUSKY=0 and taxes the NEXT
// session's push (the 2026-07-03 price-inspector case). Exercises BOTH directions:
// an over-cap injected page is refused, and a warn-only (or under-cap) page still commits.
test('commitWikiPages: an over-cap INJECTED page is refused (D1, plan 1362) — no commit lands', () => {
  const r = makeRepoWithWiki();
  try {
    mkdirSync(join(r.dir, 'wiki', 'entities', 'records'), { recursive: true });
    const big = '# record\n' + 'x'.repeat(33 * 1024); // > 32 KB injected-page cap (operator 2026-08-03)
    writeFileSync(join(r.dir, 'wiki', 'entities', 'records', 'record-001.md'), big);
    r.g('add', '-A');
    r.g('commit', '-qm', 'seed oversize record page');
    writeFileSync(join(r.dir, 'wiki', 'entities', 'records', 'record-001.md'), big + 'more');
    const before = r.g('rev-parse', 'HEAD').trim();
    assert.throws(
      () =>
        commitWikiPages(r.dir, ['wiki/entities/records/record-001.md'], {
          message: 'chore(wiki): update record',
          noPush: true,
        }),
      /exceeds the .* KB injected-page cap/,
    );
    assert.equal(r.g('rev-parse', 'HEAD').trim(), before, 'refused — no commit landed');
  } finally {
    r.cleanup();
  }
});

test('commitWikiPages: fold budgets refuse a 33 KB head but accept a small head with a 100 KB tail', () => {
  const r = makeRepoWithWiki();
  try {
    const records = join(r.dir, 'wiki', 'entities', 'records');
    mkdirSync(records, { recursive: true });
    const rel = 'wiki/entities/records/record-002.md';
    const abs = join(r.dir, ...rel.split('/'));
    writeFileSync(abs, `# head\n${'h'.repeat(33 * 1024)}`);
    r.g('add', '-A');
    r.g('commit', '-qm', 'seed over-cap head');
    writeFileSync(abs, `# head changed\n${'h'.repeat(33 * 1024)}`);
    assert.throws(
      () =>
        commitWikiPages(r.dir, [rel], {
          message: 'chore(wiki): reject large head',
          noPush: true,
        }),
      /head exceeds the .* KB injected-page cap/,
    );

    writeFileSync(abs, `# small head\n<!-- fold -->\n${'t'.repeat(100 * 1024)}`);
    const accepted = commitWikiPages(r.dir, [rel], {
      message: 'chore(wiki): accept large tail',
      noPush: true,
    });
    assert.equal(accepted.noop, false);
    assert.match(r.g('log', '-1', '--format=%s'), /chore\(wiki\): accept large tail/);
  } finally {
    r.cleanup();
  }
});

test('commitWikiPages: a warn-only PULL page still commits (D1 — warns never block)', () => {
  const r = makeRepoWithWiki();
  try {
    const big = '# concept\n' + 'x'.repeat(25 * 1024); // > 24 KB pull warn, no fail tier
    writeFileSync(join(r.dir, 'wiki', 'concepts.md'), big);
    r.g('add', '-A');
    r.g('commit', '-qm', 'seed concept page');
    writeFileSync(join(r.dir, 'wiki', 'concepts.md'), big + 'more');
    const res = commitWikiPages(r.dir, ['wiki/concepts.md'], {
      message: 'chore(wiki): update concept',
      noPush: true,
    });
    assert.equal(res.noop, false);
    assert.match(r.g('log', '-1', '--format=%s'), /chore\(wiki\): update concept/);
  } finally {
    r.cleanup();
  }
});

// plan 3411 item 2: the wiki-page size/budget lint must never see the registry file. Without
// wikiPagesOnly filtering it out first, checkSizeOrThrow would classify
// scripts/wiki-chain-registry.mjs as a 'pull' page (classifyPage's default for any path outside
// wiki/entities/**) and budget it against a wiki-page cap that has nothing to do with a script
// module. A generously-oversized registry file must pass through untouched once filtered.
test('checkSizeOrThrow: wikiPagesOnly drops the chain registry before it reaches the wiki-page budget check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-commit-registry-size-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    const big = 'export const CHAINS = [\n' + '// x'.repeat(20 * 1024) + '\n];\n'; // > 24 KB pull cap
    writeFileSync(join(dir, ...CHAIN_REGISTRY_REL.split('/')), big);
    mkdirSync(join(dir, 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'wiki', 'log.md'), '# log\n');
    const relPaths = [CHAIN_REGISTRY_REL, 'wiki/log.md'];
    assert.doesNotThrow(() => checkSizeOrThrow(dir, wikiPagesOnly(relPaths)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commitWikiPages: an under-cap page commits cleanly, no warn/fail at all', () => {
  const r = makeRepoWithWiki();
  try {
    writeFileSync(join(r.dir, 'wiki', 'log.md'), '# log\nsmall entry\n');
    const res = commitWikiPages(r.dir, ['wiki/log.md'], {
      message: 'chore(wiki): log entry',
      noPush: true,
    });
    assert.equal(res.noop, false);
  } finally {
    r.cleanup();
  }
});

// plan 1475 (item 1) — the write-time size guard must classify each page against the
// `.claude/hooks/**` state ON THAT coordWrite retry, not a snapshot taken once before the retry
// loop (the reverted plan-1398 item-3 memo). coordWrite ff-merges origin/master before each retry,
// so a sibling can newly wire a page into a hook loader mid-window; the snapshot then classified it
// against the stale (looser `pull`) budget — the write-time-catch gap plan 1362 D1 closed. The fix
// recomputes collectHookReferencedBasenames per retry inside mutate(); this drives the exported
// guard across a mid-flight hooks change (no git needed — checkSizeOrThrow reads pages off disk).
test('checkSizeOrThrow: a mid-retry hooks-dir change re-classifies a page from pull → injected (plan 1475 item 1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-commit-hooks-'));
  const rel = 'wiki/entities/chains/newly-wired.md';
  try {
    // Sized above the injected FAIL cap: harmless as a pull page (pull pages never fail —
    // at this size one only warns), over-cap the moment it counts as injected.
    mkdirSync(join(dir, 'wiki', 'entities', 'chains'), { recursive: true });
    writeFileSync(join(dir, ...rel.split('/')), '# chain\n' + 'x'.repeat(33 * 1024));

    // Retry 1 — no hook references the page yet. Fresh recompute → empty set → pull budget → passes.
    const set1 = collectHookReferencedBasenames(dir);
    assert.equal(set1.has('newly-wired.md'), false);
    assert.doesNotThrow(() => checkSizeOrThrow(dir, [rel], { hookBasenames: set1 }));

    // A sibling lands a hook wiring the page into a loader MID-WINDOW (coordWrite ff-merged it in
    // before this retry). collectHookReferencedBasenames matches the quoted basename in the hook src.
    mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true });
    writeFileSync(
      join(dir, 'scripts', 'hooks', 'new-loader.mjs'),
      "const PAGE = 'newly-wired.md';\n",
    );

    // Retry 2 — the plan-1475 per-retry recompute sees the new hook → injected budget → now FAILS.
    const set2 = collectHookReferencedBasenames(dir);
    assert.equal(set2.has('newly-wired.md'), true);
    assert.throws(
      () => checkSizeOrThrow(dir, [rel], { hookBasenames: set2 }),
      /injected-page cap/,
      'the freshly recomputed hook set catches the over-cap injected page at write time',
    );

    // Regression contract: had the set been MEMOIZED at retry 1 (plan-1398 item 3, reverted here),
    // retry 2 would reuse set1 and MISS the over-cap — the defense-in-depth gap this closes.
    assert.doesNotThrow(() => checkSizeOrThrow(dir, [rel], { hookBasenames: set1 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- checkWikiLoaderCoverageOrThrow (plan 2070 Group B) ----------------------
// Pure fs + subprocess, no git — mirrors the checkSizeOrThrow tests above. A tiny fixture
// `scripts/wiki-loader-coverage.test.mjs` (never the REAL one, which needs the full repo) proves
// the WIRING: the map selects it, it actually runs, and its exit status decides commit/refuse.
//
// plan 3958: DATA_DEPENDENCY_MAP is self-resolved from coord.config.json's dataDependencyMap
// row (vetapp's real row maps 'wiki/entities/**' to wiki-loader-coverage.test.mjs); the public
// coord-kit's own neutral config carries no such row. Every call below injects this fixture map
// so the gate's actual wiring is exercised portably — without it, `mapped` degrades to `[]` in
// the kit, nothing is ever spawned, and every doesNotThrow/throws assertion "passes" for the
// wrong reason (a silent false positive the earlier, unparameterized form of this test suite
// could not catch).
const FIXTURE_DATA_DEPENDENCY_MAP = { 'wiki-loader-coverage.test.mjs': ['wiki/entities/**'] };

test('checkWikiLoaderCoverageOrThrow: a wiki/entities/** page runs the mapped test — GREEN passes through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-commit-loadercov-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(
      join(dir, 'scripts', 'wiki-loader-coverage.test.mjs'),
      "import { test } from 'node:test';\ntest('ok', () => {});\n",
    );
    mkdirSync(join(dir, 'wiki', 'entities'), { recursive: true });
    writeFileSync(join(dir, 'wiki', 'entities', 'page.md'), '# page\n');
    assert.doesNotThrow(() =>
      checkWikiLoaderCoverageOrThrow(dir, ['wiki/entities/page.md'], {
        dataDependencyMap: FIXTURE_DATA_DEPENDENCY_MAP,
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkWikiLoaderCoverageOrThrow: a RED mapped test refuses the commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-commit-loadercov-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(
      join(dir, 'scripts', 'wiki-loader-coverage.test.mjs'),
      "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('unmapped chainId', () => { assert.fail('unmapped chainId'); });\n",
    );
    mkdirSync(join(dir, 'wiki', 'entities'), { recursive: true });
    writeFileSync(join(dir, 'wiki', 'entities', 'page.md'), '# page\n');
    assert.throws(
      () =>
        checkWikiLoaderCoverageOrThrow(dir, ['wiki/entities/page.md'], {
          dataDependencyMap: FIXTURE_DATA_DEPENDENCY_MAP,
        }),
      /wiki-loader-coverage\.test\.mjs FAILED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkWikiLoaderCoverageOrThrow: a page outside the map (wiki/log.md) is a no-op — no spawn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-commit-loadercov-'));
  try {
    writeFileSync(join(dir, 'wiki-log-only-marker'), ''); // no scripts/ tree at all
    let called = false;
    assert.doesNotThrow(() =>
      checkWikiLoaderCoverageOrThrow(dir, ['wiki/log.md'], {
        _execFileSync: () => {
          called = true;
        },
        dataDependencyMap: FIXTURE_DATA_DEPENDENCY_MAP,
      }),
    );
    assert.equal(called, false, 'wiki/log.md is not in DATA_DEPENDENCY_MAP — must never spawn');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkWikiLoaderCoverageOrThrow: mapped-but-ABSENT test file at dir is skipped, not failed (fixture-repo safety valve)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-commit-loadercov-'));
  try {
    // No scripts/ dir at all — mirrors the throwaway "origin" fixture repos elsewhere in this
    // suite, which carry only a couple of wiki pages, never the full scripts/ tree.
    mkdirSync(join(dir, 'wiki', 'entities'), { recursive: true });
    writeFileSync(join(dir, 'wiki', 'entities', 'page.md'), '# page\n');
    let called = false;
    assert.doesNotThrow(() =>
      checkWikiLoaderCoverageOrThrow(dir, ['wiki/entities/page.md'], {
        _execFileSync: () => {
          called = true;
        },
        dataDependencyMap: FIXTURE_DATA_DEPENDENCY_MAP,
      }),
    );
    assert.equal(called, false, 'a missing mapped test file must never be spawned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 3411: the exception that lets scripts/wiki-chain-registry.mjs ride alongside wiki pages
// must NOT weaken the loader-coverage bijection. A page-only commit (no registry file at all,
// exactly the "page-first" ordering the plan's deadlock table calls out) that adds an
// UNREGISTERED chain page still FAILS: checkWikiLoaderCoverageOrThrow selects the mapped test on
// the page alone (wiki/entities/** is in DATA_DEPENDENCY_MAP), and a red test still refuses.
test('checkWikiLoaderCoverageOrThrow: a page-only commit adding an UNREGISTERED page still fails — the plan-3411 exception does not weaken the bijection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-commit-loadercov-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    // Stands in for the real wiki-loader-coverage.test.mjs's bijection assertion: it fails
    // because the newly-added page has no CHAINS registry entry (an orphan page).
    writeFileSync(
      join(dir, 'scripts', 'wiki-loader-coverage.test.mjs'),
      "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n" +
        "test('orphan page', () => { assert.fail('orphan page(s): newchain.md'); });\n",
    );
    mkdirSync(join(dir, 'wiki', 'entities', 'chains'), { recursive: true });
    writeFileSync(join(dir, 'wiki', 'entities', 'chains', 'newchain.md'), '# newchain\n');
    // relPaths carries ONLY the page — no scripts/wiki-chain-registry.mjs in this commit.
    assert.throws(
      () =>
        checkWikiLoaderCoverageOrThrow(dir, ['wiki/entities/chains/newchain.md'], {
          dataDependencyMap: FIXTURE_DATA_DEPENDENCY_MAP,
        }),
      /orphan page/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 3411 (review finding, the door the exception itself opened): a REGISTRY-ONLY commit —
// no wiki/entities/** page beside it — must still run the bijection gate. scripts/ is not in
// DATA_DEPENDENCY_MAP (the scripts battery covers it at push time), but the coord-checkout push
// runs NO git hooks, so without the force-select this call selected NOTHING and a dangling
// CHAINS entry went straight to master.
test('checkWikiLoaderCoverageOrThrow: a REGISTRY-ONLY commit force-selects the bijection gate — a dangling entry is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-commit-loadercov-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(
      join(dir, 'scripts', 'wiki-loader-coverage.test.mjs'),
      "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n" +
        "test('dangling entry', () => { assert.fail('dangling CHAINS entry: newchain.md'); });\n",
    );
    writeFileSync(join(dir, 'scripts', 'wiki-chain-registry.mjs'), 'export const CHAINS = [];\n');
    assert.throws(
      () =>
        checkWikiLoaderCoverageOrThrow(dir, ['scripts/wiki-chain-registry.mjs'], {
          dataDependencyMap: FIXTURE_DATA_DEPENDENCY_MAP,
        }),
      /dangling CHAINS entry/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkWikiLoaderCoverageOrThrow: a registry-only commit whose bijection is GREEN passes through, and selects the gate exactly once alongside a page', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-commit-loadercov-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(
      join(dir, 'scripts', 'wiki-loader-coverage.test.mjs'),
      "import { test } from 'node:test';\ntest('ok', () => {});\n",
    );
    writeFileSync(join(dir, 'scripts', 'wiki-chain-registry.mjs'), 'export const CHAINS = [];\n');
    mkdirSync(join(dir, 'wiki', 'entities', 'chains'), { recursive: true });
    writeFileSync(join(dir, 'wiki', 'entities', 'chains', 'newchain.md'), '# newchain\n');
    assert.doesNotThrow(() =>
      checkWikiLoaderCoverageOrThrow(dir, ['scripts/wiki-chain-registry.mjs'], {
        dataDependencyMap: FIXTURE_DATA_DEPENDENCY_MAP,
      }),
    );
    // The page ALSO maps to the same test — the mapped and forced sources must dedupe, never
    // spawn `node --test` with the file named twice.
    let argv = null;
    checkWikiLoaderCoverageOrThrow(
      dir,
      ['wiki/entities/chains/newchain.md', 'scripts/wiki-chain-registry.mjs'],
      {
        _execFileSync: (_cmd, args) => {
          argv = args;
        },
        dataDependencyMap: FIXTURE_DATA_DEPENDENCY_MAP,
      },
    );
    assert.deepEqual(argv, ['--test', 'scripts/wiki-loader-coverage.test.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 3411 (round-2 review finding): the registry's forced selection must be DERIVED from
// DATA_DEPENDENCY_MAP, not a second literal naming the coverage test — a rename that updated the
// canonical map would leave a literal stale, existsSync would filter it out, and the gate would
// silently select nothing again. Pin the derivation at its source: whatever a chain PAGE selects
// is exactly what the registry selects.
test('plan 3411: the registry-forced selection is derived from DATA_DEPENDENCY_MAP — identical to what a chain page selects', () => {
  const viaPage = selectDataTriggeredTests(
    ['wiki/entities/chains/anychain.md'],
    FIXTURE_DATA_DEPENDENCY_MAP,
  );
  assert.ok(viaPage.length > 0, 'a chain page must select at least one mapped test');
  const dir = mkdtempSync(join(tmpdir(), 'wiki-commit-loadercov-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    for (const rel of viaPage) {
      writeFileSync(join(dir, rel), "import { test } from 'node:test';\ntest('ok', () => {});\n");
    }
    let argv = null;
    checkWikiLoaderCoverageOrThrow(dir, ['scripts/wiki-chain-registry.mjs'], {
      _execFileSync: (_cmd, args) => {
        argv = args;
      },
      dataDependencyMap: FIXTURE_DATA_DEPENDENCY_MAP,
    });
    assert.deepEqual(argv, ['--test', ...viaPage.slice().sort()]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A tracked page deleted from the working tree stays committable (records the deletion).
test('CLI: a tracked-but-deleted page is NOT treated as a typo', () => {
  const r = makeRepoWithWiki();
  try {
    rmSync(join(r.dir, 'wiki', 'entities', 'page.md'));
    const res = spawnSync(
      process.execPath,
      [CLI, 'wiki/entities/page.md', '-m', 'chore(wiki): drop page', '--no-push'],
      { cwd: r.dir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: '' } },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /committed 1 page/);
    assert.equal(r.g('status', '--porcelain', '--', 'wiki/entities/page.md').trim(), '');
  } finally {
    r.cleanup();
  }
});

// plan 1604: worktree-session mode — the fix for the plan-1536 landing-queue incident
// (a worktree branch's wiki commits colliding with sibling straight-to-master edits on
// the same hot page). wiki-commit.mjs must auto-detect a worktree-* calling branch and
// read/capture the page content from THAT checkout, never from MAIN's disk.
test('isWorktreeSessionBranch: worktree-<slug> branches match, everything else does not', () => {
  assert.equal(isWorktreeSessionBranch('worktree-1604-foo'), true);
  assert.equal(isWorktreeSessionBranch('master'), false);
  assert.equal(isWorktreeSessionBranch('staging'), false);
  assert.equal(isWorktreeSessionBranch('HEAD'), false); // detached (done-worktree's finish worktree)
  assert.equal(isWorktreeSessionBranch(''), false);
  assert.equal(isWorktreeSessionBranch(undefined), false);
});

test('isWorktreeSessionBranch: review fix — a bare "worktree-" (no slug) still classifies as a worktree session', () => {
  // slugFromBranch's `(.+)` capture requires a non-empty slug, so this branch alone would
  // resolve to null and (pre-fix) fall through to MAIN-checkout routing — the exact
  // plan-1536 hazard this function exists to prevent. Not reachable via a real claimed
  // worktree (SLUG_CHARSET_RX rejects an empty slug at branch-creation time), but the
  // routing decision must not depend on that OTHER file's invariant to stay safe.
  assert.equal(isWorktreeSessionBranch('worktree-'), true);
});

function withLinkedWorktree(mainRepo, branch, fn) {
  const wtDir = join(
    tmpdir(),
    `wiki-commit-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mainRepo.g('worktree', 'add', wtDir, '-b', branch);
  try {
    return fn(wtDir);
  } finally {
    try {
      mainRepo.g('worktree', 'remove', '--force', wtDir);
    } catch {
      rmSync(wtDir, { recursive: true, force: true });
    }
  }
}

test('CLI --dry: a worktree-* caller reads the page from ITS OWN checkout, not MAIN (plan 1604)', () => {
  const r = makeRepoWithWiki();
  try {
    withLinkedWorktree(r, 'worktree-1604-testslug', (wtDir) => {
      // Edit the page ONLY on the worktree checkout's disk — MAIN (r.dir) keeps the
      // original content untouched, so a MAIN-sourced read would see nothing dirty.
      writeFileSync(join(wtDir, 'wiki', 'entities', 'page.md'), '# page\nworktree edit\n');
      const res = spawnSync(
        process.execPath,
        [CLI, 'wiki/entities/page.md', '-m', 'chore(wiki): x', '--dry'],
        { cwd: wtDir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: r.dir } },
      );
      assert.equal(res.status, 0, res.stderr);
      // Would-commit (not the no-op branch) proves the dirty-check read the WORKTREE's
      // edited copy, not MAIN's untouched one.
      assert.match(res.stdout, /would prettier --write, then pathspec-commit \+ push/);
      assert.match(res.stdout, /\(source: /, 'reports the resolved source checkout');
      assert.doesNotMatch(res.stdout, /would be a no-op/);
    });
  } finally {
    r.cleanup();
  }
});

test('CLI --dry: a main-checkout caller (non worktree-* branch) still sources from MAIN unchanged', () => {
  const r = makeRepoWithWiki();
  try {
    // No edit anywhere — MAIN's own page.md matches HEAD, so this is the pre-1604 no-op path.
    const res = spawnSync(process.execPath, [CLI, 'wiki/log.md', '-m', 'chore(wiki): x', '--dry'], {
      cwd: r.dir,
      encoding: 'utf8',
      env: { ...process.env, COORD_MAIN_DIR: '' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /would be a no-op/);
  } finally {
    r.cleanup();
  }
});

// /sonnet-review xhigh (2026-07-08, same batch) CONFIRMED that `git rev-parse --abbrev-ref HEAD`
// returns the literal string "HEAD" for a detached checkout (isWorktreeSessionBranch('HEAD') is
// already asserted false above) — before this fix, main() silently fell through to the
// fromWorktree=false / sourceDir=MAIN branch instead of refusing, so a detached-HEAD worktree
// checkout (a real, documented state — e.g. done-worktree's post-merge "finish worktree" step)
// would read/capture wiki content from MAIN's disk instead of the checkout that actually holds
// the edit, silently masking or misattributing the write-back.
test('CLI: a DETACHED HEAD checkout is refused loudly, not silently treated as a main-checkout session (plan 1604 xhigh fix)', () => {
  const r = makeRepoWithWiki();
  try {
    withLinkedWorktree(r, 'worktree-1604-detached-test', (wtDir) => {
      // Detach HEAD on the worktree checkout — its own git dir, no state shared with MAIN.
      const headSha = execFileSync('git', ['-C', wtDir, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      execFileSync('git', ['-C', wtDir, 'checkout', '-q', headSha]);
      const res = spawnSync(
        process.execPath,
        [CLI, 'wiki/log.md', '-m', 'chore(wiki): x', '--dry'],
        { cwd: wtDir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: r.dir } },
      );
      assert.equal(res.status, 2);
      assert.match(res.stderr, /DETACHED HEAD/);
    });
  } finally {
    r.cleanup();
  }
});

test('CLI: --no-push is refused from a worktree-* branch — must always land straight to master (plan 1604)', () => {
  const r = makeRepoWithWiki();
  try {
    withLinkedWorktree(r, 'worktree-1604-testslug2', (wtDir) => {
      const res = spawnSync(
        process.execPath,
        [CLI, 'wiki/log.md', '-m', 'chore(wiki): x', '--no-push'],
        { cwd: wtDir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: r.dir } },
      );
      assert.equal(res.status, 2);
      assert.match(res.stderr, /worktree session/);
      assert.match(res.stderr, /never commit on its own branch/);
    });
  } finally {
    r.cleanup();
  }
});

test('CLI: a page missing from MAIN but present on the worktree checkout is NOT a typo (plan 1604)', () => {
  const r = makeRepoWithWiki();
  try {
    withLinkedWorktree(r, 'worktree-1604-testslug3', (wtDir) => {
      // A brand-new page that exists ONLY on the worktree's disk — MAIN (r.dir) never had it.
      writeFileSync(join(wtDir, 'wiki', 'entities', 'new-from-worktree.md'), '# new\n');
      const res = spawnSync(
        process.execPath,
        [CLI, 'wiki/entities/new-from-worktree.md', '-m', 'chore(wiki): x', '--dry'],
        { cwd: wtDir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: r.dir } },
      );
      assert.equal(res.status, 0, res.stderr);
      assert.doesNotMatch(res.stderr, /no such page/);
    });
  } finally {
    r.cleanup();
  }
});

// ── plan 1616 item 5: real non-dry worktree-session write-back integration test ────────────
// Every worktree-session case above drives the CLI with `--dry` or `--no-push`, or with
// COORD_MAIN_DIR pointed straight at MAIN (skipping withCoordCheckout's disposable-checkout
// branch entirely — see withCoordCheckout's own COORD_MAIN_DIR short-circuit). None of them
// exercises the actual capture → coordWrite → push → revert path a real operator invocation
// takes (auto-detected MAIN via `git worktree list`, page content landing through the
// disposable `.claude/coord-worktree` checkout, a real push to origin). That gap is exactly
// the plan-1536 incident surface (a worktree branch's wiki commits colliding with sibling
// edits) — this test proves the write-back actually reaches origin/master's history and never
// touches the worktree branch, using a real bare origin + clone + linked worktree, mirroring
// done-worktree.test.mjs's makeWikiSessionRepo() fixture pattern.
function makeWikiWorktreeOriginRepo(branch) {
  const root = mkdtempSync(join(tmpdir(), 'wiki-commit-wt-origin-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  const main = join(root, 'main');
  execFileSync('git', ['clone', '-q', origin, main]);
  const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g(main, 'config', 'user.email', 't@t.t');
  g(main, 'config', 'user.name', 'T');
  g(main, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(main, 'wiki', 'entities'), { recursive: true });
  writeFileSync(join(main, 'wiki', 'entities', 'page.md'), '# page\n');
  writeFileSync(join(main, 'wiki', 'log.md'), '# log\n');
  g(main, 'add', '-A');
  g(main, 'commit', '-qm', 'init wiki');
  g(main, 'push', '-q', 'origin', 'master');
  const wtDir = join(root, 'wt');
  g(main, 'worktree', 'add', '-q', wtDir, '-b', branch);
  return {
    root,
    origin,
    main,
    wtDir,
    g,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('plan 1616 item 5: a real non-dry worktree-session wiki-commit.mjs write-back lands the page on origin/master, never the worktree branch', () => {
  const branch = 'worktree-1616-item5-test';
  const f = makeWikiWorktreeOriginRepo(branch);
  try {
    const branchHeadBefore = f.g(f.wtDir, 'rev-parse', 'HEAD').trim();
    // Edit the page ONLY on the worktree checkout's disk (uncommitted) — mirrors a real
    // session's in-flight wiki edit before running wiki-commit.mjs.
    writeFileSync(join(f.wtDir, 'wiki', 'entities', 'page.md'), '# page\nworktree-session edit\n');

    // No COORD_MAIN_DIR override: MAIN is auto-detected via `git worktree list --porcelain`
    // run from the worktree cwd (the real operator invocation path), and the push goes
    // through withCoordCheckout's disposable `.claude/coord-worktree` checkout, not MAIN's
    // own working tree and not this worktree branch.
    const res = spawnSync(
      process.execPath,
      [CLI, 'wiki/entities/page.md', '-m', 'chore(wiki): plan 1616 item 5 integration test'],
      { cwd: f.wtDir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: '' } },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /committed 1 page\(s\) \+ pushed/);

    // The page landed on origin/master's real history — read straight from the bare repo,
    // not through any local working tree that could be stale.
    const onOrigin = execFileSync('git', ['-C', f.origin, 'show', 'master:wiki/entities/page.md'], {
      encoding: 'utf8',
    });
    assert.match(onOrigin, /worktree-session edit/, 'the edit reached origin/master');

    // The worktree branch itself carries NO new commit — same tip sha as before the write-
    // back (the load-bearing assertion: the page never rode this branch).
    const branchHeadAfter = f.g(f.wtDir, 'rev-parse', 'HEAD').trim();
    assert.equal(
      branchHeadAfter,
      branchHeadBefore,
      'the worktree branch must gain zero commits from the wiki write-back',
    );

    // The worktree's own working tree is clean — the local edit was reverted after landing
    // elsewhere (revertPathsToHead), so it can never accidentally ride this branch's next commit.
    assert.equal(f.g(f.wtDir, 'status', '--porcelain').trim(), '', 'sourceDir reverted to HEAD');
    const onBranch = readFileSync(join(f.wtDir, 'wiki', 'entities', 'page.md'), 'utf8');
    assert.doesNotMatch(
      onBranch,
      /worktree-session edit/,
      'the branch checkout never kept the edit',
    );
  } finally {
    f.cleanup();
  }
});

// ── plan 1622: stale-base guard ─────────────────────────────────────────────────────────────
// wiki-commit.mjs's worktree-session routing captures the caller's WHOLE page file and, pre-
// 1622, wrote it verbatim over master with no staleness check — a caller whose checkout base
// predates a parallel session's wiki commit silently REVERTED that commit (proven:
// cad20b0c19f92e7a39d6572b6999a699cc6975de, 2026-07-08). resolveStalePageContent is the pure
// decision table; gitShowBlobOrNull is its git input; the CLI tests below exercise the guard
// end-to-end against a real origin.

test('resolveStalePageContent: master unchanged since base → fast-forward the caller copy verbatim', () => {
  const base = Buffer.from('line1\nline2\n');
  const caller = Buffer.from('line1\nline2\nmine\n');
  const r = resolveStalePageContent({ baseBlob: base, masterBlob: base, callerContent: caller });
  assert.deepEqual(r, { action: 'write', content: caller });
});

test('resolveStalePageContent: master already matches the caller copy → skip, nothing to commit', () => {
  const base = Buffer.from('line1\n');
  const caller = Buffer.from('line1\nmine\n');
  const r = resolveStalePageContent({ baseBlob: base, masterBlob: caller, callerContent: caller });
  assert.deepEqual(r, { action: 'skip' });
});

test('resolveStalePageContent: disjoint changes 3-way-merge cleanly', () => {
  const base = Buffer.from('line1\nline2\nline3\n');
  const caller = Buffer.from('line1-mine\nline2\nline3\n');
  const master = Buffer.from('line1\nline2\nline3-theirs\n');
  const r = resolveStalePageContent({ baseBlob: base, masterBlob: master, callerContent: caller });
  assert.equal(r.action, 'write');
  assert.equal(r.content.toString(), 'line1-mine\nline2\nline3-theirs\n');
});

test('resolveStalePageContent: overlapping changes to the same line → conflict, never a silent pick', () => {
  const base = Buffer.from('line1\nline2\n');
  const caller = Buffer.from('line1-mine\nline2\n');
  const master = Buffer.from('line1-theirs\nline2\n');
  const r = resolveStalePageContent({ baseBlob: base, masterBlob: master, callerContent: caller });
  assert.deepEqual(r, { action: 'conflict' });
});

test('resolveStalePageContent: a brand-new page absent from both base and master → plain add', () => {
  const caller = Buffer.from('# new page\n');
  const r = resolveStalePageContent({ baseBlob: null, masterBlob: null, callerContent: caller });
  assert.deepEqual(r, { action: 'write', content: caller });
});

test('resolveStalePageContent: a new page independently created by both sides → base-empty 3-way merge (conflict on same content)', () => {
  const caller = Buffer.from('mine only\n');
  const master = Buffer.from('theirs only\n');
  const r = resolveStalePageContent({ baseBlob: null, masterBlob: master, callerContent: caller });
  assert.deepEqual(r, { action: 'conflict' });
});

test('resolveStalePageContent: caller deletes a page master left untouched since base → delete applied', () => {
  const base = Buffer.from('# page\n');
  const r = resolveStalePageContent({ baseBlob: base, masterBlob: base, callerContent: null });
  assert.deepEqual(r, { action: 'delete' });
});

test('resolveStalePageContent: caller deletes a page master since changed → conflict, refuse (never drop master content)', () => {
  const base = Buffer.from('# page\n');
  const master = Buffer.from('# page\nmaster added this\n');
  const r = resolveStalePageContent({ baseBlob: base, masterBlob: master, callerContent: null });
  assert.deepEqual(r, { action: 'conflict' });
});

test('resolveStalePageContent: caller deletes a page already absent from master → skip', () => {
  const r = resolveStalePageContent({ baseBlob: null, masterBlob: null, callerContent: null });
  assert.deepEqual(r, { action: 'skip' });
});

// plan 3415 Item C: the ledger symptom — "a page whose `updated:` moved upstream conflicts
// every time" (MASTER's date newer than the caller's). Before fix 3, tryThreeWayMerge's conflict
// branch never attempted ANY updated:-line resolution (a bare `return null` on any conflict
// marker) — so this collision surfaced as a bare `{ action: 'conflict' }`, no different from a
// genuine prose conflict. After fix 3 alone (resolver wired in, containment NOT yet exempted),
// the resolver correctly picks master's newer line, but the containment guard then sees the
// caller's OWN updated: line vanish from the merged result and refuses it — reproducing the
// plan's quoted `wiki-commit: refusing to commit ... the 3-way merge dropped your own added
// line(s) (updated: ...); a clean merge must never lose the caller's contribution ... (plan 1697
// containment guard.)` message via its `containment-caller-adds` reason. Fix 1 (the updated:
// exemption in checkContainment) is what lets this resolve to a clean 'write'.
const UPDATED_PAGE = (updatedLine) =>
  Buffer.from(`---\nname: page\n${updatedLine}\n---\n\nBody text.\n`);

test('resolveStalePageContent: an annotated updated: conflict where MASTER is newer resolves clean (Item C fix 1 — the reported ledger symptom)', () => {
  const base = UPDATED_PAGE('updated: 2026-08-01');
  const caller = UPDATED_PAGE('updated: 2026-08-10 (plan 3395: caller bump)');
  const master = UPDATED_PAGE('updated: 2026-08-15 (plan 9999: master bump)');
  const r = resolveStalePageContent({ baseBlob: base, masterBlob: master, callerContent: caller });
  assert.equal(r.action, 'write');
  assert.match(r.content.toString(), /updated: 2026-08-15 \(plan 9999: master bump\)/);
});

test('resolveStalePageContent: an annotated updated: conflict where CALLER is newer resolves clean (the direction that already worked)', () => {
  const base = UPDATED_PAGE('updated: 2026-08-01');
  const caller = UPDATED_PAGE('updated: 2026-08-20 (plan 3395: caller bump)');
  const master = UPDATED_PAGE('updated: 2026-08-10 (plan 9999: master bump)');
  const r = resolveStalePageContent({ baseBlob: base, masterBlob: master, callerContent: caller });
  assert.equal(r.action, 'write');
  assert.match(r.content.toString(), /updated: 2026-08-20 \(plan 3395: caller bump\)/);
});

// plan 3415 Item C fix 2: an EXACT date tie (the NORMAL case on a hot page many sessions touch
// the same day) must not silently discard one side's provenance annotation.
test('resolveStalePageContent: an annotated updated: EXACT-DATE TIE keeps BOTH sides provenance, never drops one silently (Item C fix 2)', () => {
  const base = UPDATED_PAGE('updated: 2026-08-01');
  const caller = UPDATED_PAGE('updated: 2026-08-10 (plan 3395: caller bump)');
  const master = UPDATED_PAGE('updated: 2026-08-10 (plan 9999: master bump)');
  const r = resolveStalePageContent({ baseBlob: base, masterBlob: master, callerContent: caller });
  assert.equal(r.action, 'write');
  assert.match(r.content.toString(), /plan 3395: caller bump/, "caller's provenance survives");
  assert.match(r.content.toString(), /plan 9999: master bump/, "master's provenance survives");
});

test('gitShowBlobOrNull: returns the blob content at a ref, or null when the path is absent there', () => {
  const r = makeRepoWithWiki();
  try {
    const content = gitShowBlobOrNull(r.dir, 'HEAD', 'wiki/entities/page.md');
    assert.equal(content.toString(), '# page\n');
    assert.equal(gitShowBlobOrNull(r.dir, 'HEAD', 'wiki/nope.md'), null);
  } finally {
    r.cleanup();
  }
});

// plan 1641: the load-bearing property — a multi-page read must issue a CONSTANT number of
// subprocesses for the whole ref, not one `git show` per page (the prior shape spawned
// relPaths.length git.exe processes per call, re-run on every coordWrite retry under
// contention — /sonnet-review xhigh finding on batch-2026-07-08-coord-spine3). plan 1642
// review fix [C] added ONE more constant-cost subprocess (a `git rev-parse --verify` ref-check,
// ahead of the batch read) so an unresolvable ref throws instead of silently reporting every
// page absent — bumping the per-call count from 1 to 2, but keeping it independent of
// relPaths.length (never one-per-page). The `_execFileSync` seam counts real subprocess spawns
// (delegating to the real execFileSync so the assertions on returned content stay honest, not
// stubbed).
test('gitShowBlobsOrNull: batches ALL pages into a CONSTANT number of subprocesses per ref (ref-verify + one cat-file batch), never one per page', () => {
  const r = makeRepoWithWiki();
  try {
    writeFileSync(join(r.dir, 'wiki', 'entities', 'second.md'), '# second\n');
    r.g('add', '-A');
    r.g('commit', '-qm', 'add second page');

    let calls = 0;
    const spy = (...args) => {
      calls++;
      return execFileSync(...args);
    };
    const blobs = gitShowBlobsOrNull(
      r.dir,
      'HEAD',
      ['wiki/entities/page.md', 'wiki/entities/second.md', 'wiki/nope.md'],
      { _execFileSync: spy },
    );
    assert.equal(
      calls,
      2,
      'THREE pages resolved via ref-verify + one batch subprocess (2), not three (one per page)',
    );
    assert.equal(blobs.get('wiki/entities/page.md').toString(), '# page\n');
    assert.equal(blobs.get('wiki/entities/second.md').toString(), '# second\n');
    assert.equal(blobs.get('wiki/nope.md'), null, 'an absent path resolves to null, not a throw');
  } finally {
    r.cleanup();
  }
});

test('gitShowBlobsOrNull: an UNRESOLVABLE ref throws instead of silently reporting every page absent (plan 1642 review fix [C])', () => {
  const r = makeRepoWithWiki();
  try {
    assert.throws(
      () => gitShowBlobsOrNull(r.dir, 'not-a-real-ref-at-all', ['wiki/entities/page.md']),
      /does not resolve to a commit/,
    );
  } finally {
    r.cleanup();
  }
});

test('gitShowBlobsOrNull: a RESOLVABLE ref still reports an absent PATH as null, not a throw (guard does not over-fire)', () => {
  const r = makeRepoWithWiki();
  try {
    const blobs = gitShowBlobsOrNull(r.dir, 'HEAD', ['wiki/entities/page.md', 'wiki/nope.md']);
    assert.equal(blobs.get('wiki/entities/page.md').toString(), '# page\n');
    assert.equal(blobs.get('wiki/nope.md'), null);
  } finally {
    r.cleanup();
  }
});

test('gitShowBlobsOrNull: an empty relPaths list is a no-op — zero subprocess spawns (ref-verify skipped too)', () => {
  const r = makeRepoWithWiki();
  try {
    let calls = 0;
    const blobs = gitShowBlobsOrNull(r.dir, 'HEAD', [], {
      _execFileSync: (...args) => {
        calls++;
        return execFileSync(...args);
      },
    });
    assert.equal(calls, 0);
    assert.equal(blobs.size, 0);
  } finally {
    r.cleanup();
  }
});

// Push an independent commit straight onto the bare origin (bypassing `main`/`wtDir` entirely —
// a THIRD clone, mirroring a genuinely separate parallel session) that changes `rel` in `dir`.
function landParallelSessionCommit(f, rel, content, message) {
  const other = join(f.root, 'other-session');
  execFileSync('git', ['clone', '-q', f.origin, other]);
  f.g(other, 'config', 'user.email', 'other@t.t');
  f.g(other, 'config', 'user.name', 'Other');
  f.g(other, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(other, rel), content);
  f.g(other, 'add', '--', rel);
  f.g(other, 'commit', '-qm', message);
  f.g(other, 'push', '-q', 'origin', 'master');
  rmSync(other, { recursive: true, force: true });
}

test('plan 1622: a stale-base worktree session merges cleanly with a parallel landed edit (disjoint lines) — both survive', () => {
  const branch = 'worktree-1622-disjoint-test';
  const f = makeWikiWorktreeOriginRepo(branch);
  try {
    // Seed a multi-line page so the worktree and the parallel session can touch DIFFERENT lines.
    writeFileSync(join(f.main, 'wiki', 'entities', 'page.md'), 'line1\nline2\nline3\n');
    f.g(f.main, 'add', '-A');
    f.g(f.main, 'commit', '-qm', 'seed multi-line page');
    f.g(f.main, 'push', '-q', 'origin', 'master');
    // The worktree branch (already created by the fixture) is behind this commit — bring it up
    // to the same base as origin/master before diverging, mirroring a worktree cut AFTER seeding.
    f.g(f.wtDir, 'fetch', '-q', 'origin', 'master');
    f.g(f.wtDir, 'reset', '-q', '--hard', 'origin/master');

    // A PARALLEL session lands a commit on origin/master, touching line3 only — AFTER the
    // worktree's merge-base, so the worktree's checkout is now stale relative to origin.
    landParallelSessionCommit(
      f,
      'wiki/entities/page.md',
      'line1\nline2\nline3-parallel\n',
      'chore(wiki): parallel session edits line3',
    );

    // The worktree session edits line1 only (disjoint) — never fetched the parallel commit.
    writeFileSync(join(f.wtDir, 'wiki', 'entities', 'page.md'), 'line1-worktree\nline2\nline3\n');

    const res = spawnSync(
      process.execPath,
      [CLI, 'wiki/entities/page.md', '-m', 'chore(wiki): plan 1622 disjoint merge test'],
      { cwd: f.wtDir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: '' } },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /committed 1 page\(s\) \+ pushed/);

    const onOrigin = execFileSync('git', ['-C', f.origin, 'show', 'master:wiki/entities/page.md'], {
      encoding: 'utf8',
    });
    assert.match(onOrigin, /line1-worktree/, "the worktree session's edit survived the merge");
    assert.match(
      onOrigin,
      /line3-parallel/,
      "the parallel session's landed edit was NOT clobbered",
    );
  } finally {
    f.cleanup();
  }
});

test('plan 1622: a stale-base worktree session with an OVERLAPPING edit refuses — master content is never clobbered', () => {
  const branch = 'worktree-1622-conflict-test';
  const f = makeWikiWorktreeOriginRepo(branch);
  try {
    f.g(f.wtDir, 'fetch', '-q', 'origin', 'master');
    f.g(f.wtDir, 'reset', '-q', '--hard', 'origin/master');

    // A PARALLEL session lands a commit rewriting the SAME line the worktree is about to edit.
    landParallelSessionCommit(
      f,
      'wiki/entities/page.md',
      '# page\nparallel session content\n',
      'chore(wiki): parallel session rewrites page',
    );

    // The worktree session edits the SAME line, from its now-stale base — a genuine conflict.
    writeFileSync(
      join(f.wtDir, 'wiki', 'entities', 'page.md'),
      '# page\nworktree session content\n',
    );

    const res = spawnSync(
      process.execPath,
      [CLI, 'wiki/entities/page.md', '-m', 'chore(wiki): plan 1622 conflict test'],
      { cwd: f.wtDir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: '' } },
    );
    assert.notEqual(res.status, 0, 'the CLI must refuse, not silently clobber');
    assert.match(res.stderr, /refusing to commit/);
    assert.match(res.stderr, /re-read/i);

    // Master's landed content is UNTOUCHED — the load-bearing assertion this whole plan exists
    // to prove: a stale-base session can no longer silently revert a parallel session's commit.
    const onOrigin = execFileSync('git', ['-C', f.origin, 'show', 'master:wiki/entities/page.md'], {
      encoding: 'utf8',
    });
    assert.match(onOrigin, /parallel session content/, "master's content survives the refusal");
    assert.doesNotMatch(onOrigin, /worktree session content/);
  } finally {
    f.cleanup();
  }
});

// plan 3415 Item C review (cluster 11, pre-existing plan-1622 code — fixed here, not filed
// separately, per the hobby-level "pre-existing is not an excuse" rule): the stale-base guard's
// `mergeBase` is resolved from sourceDir's LOCAL `origin/master` ref (line ~830) without first
// refreshing it. If the caller's checkout was rebased onto a newly landed master commit but this
// checkout has not fetched since, sourceDir's local `origin/master` ref still points at the OLDER
// ancestor — mergeBase and baseBlobs are then read at that stale point, and an unrelated,
// genuinely disjoint hunk can spuriously 3-way-conflict (three different versions of one line:
// the stale base's, master's later edit, and the value the caller's rebase already carries),
// falsely refusing a legitimate edit. `masterBlobs`, by contrast, is always read fresh via
// coordWrite's own fetch — only sourceDir's view was stale.
test('plan 3415 item C review (cluster 11): a stale local origin/master ref in sourceDir must not falsely refuse a legitimate disjoint edit', () => {
  const branch = 'worktree-cluster11-stale-origin-test';
  const f = makeWikiWorktreeOriginRepo(branch);
  try {
    writeFileSync(join(f.main, 'wiki', 'entities', 'page.md'), 'L1\nL2\nL3\n');
    f.g(f.main, 'add', '-A');
    f.g(f.main, 'commit', '-qm', 'commit1: seed 3-line page');
    f.g(f.main, 'push', '-q', 'origin', 'master');
    f.g(f.wtDir, 'fetch', '-q', 'origin', 'master');
    f.g(f.wtDir, 'reset', '-q', '--hard', 'origin/master');
    const commit1Sha = f.g(f.wtDir, 'rev-parse', 'origin/master').trim();

    // commit2 lands on true origin/master, changing L1.
    landParallelSessionCommit(f, 'wiki/entities/page.md', 'L1-v2\nL2\nL3\n', 'commit2: change L1');

    // Simulate "the caller branch was rebased onto commit2" WITHOUT wtDir ever running
    // `git fetch origin master` — mirror commit2 onto a SEPARATE remote ref name and fetch
    // THAT, so wtDir's own `refs/remotes/origin/master` is left pinned at commit1.
    const mirror = join(f.root, 'ref-mirror');
    execFileSync('git', ['clone', '-q', f.origin, mirror]);
    execFileSync('git', ['-C', mirror, 'push', '-q', 'origin', 'master:refs/heads/wt-view']);
    rmSync(mirror, { recursive: true, force: true });
    f.g(f.wtDir, 'fetch', '-q', 'origin', 'wt-view');
    f.g(f.wtDir, 'reset', '-q', '--hard', 'FETCH_HEAD');
    assert.equal(
      f.g(f.wtDir, 'rev-parse', 'origin/master').trim(),
      commit1Sha,
      "setup check: sourceDir's local origin/master ref is STALE (still commit1)",
    );

    // commit3 lands further on true origin/master, changing L1 AGAIN (from commit2's value).
    landParallelSessionCommit(
      f,
      'wiki/entities/page.md',
      'L1-v3\nL2\nL3\n',
      'commit3: change L1 again',
    );

    // The caller's own edit is DISJOINT from every L1 change — it only touches L3.
    writeFileSync(join(f.wtDir, 'wiki', 'entities', 'page.md'), 'L1-v2\nL2\nL3-mine\n');

    const res = spawnSync(
      process.execPath,
      [CLI, 'wiki/entities/page.md', '-m', 'chore(wiki): cluster 11 stale-origin disjoint edit'],
      { cwd: f.wtDir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: '' } },
    );
    assert.equal(
      res.status,
      0,
      `a disjoint edit must land even when sourceDir's local origin/master ref is stale: ${res.stderr}`,
    );
    const onOrigin = execFileSync('git', ['-C', f.origin, 'show', 'master:wiki/entities/page.md'], {
      encoding: 'utf8',
    });
    assert.match(onOrigin, /L1-v3/, "master's later L1 change survives");
    assert.match(onOrigin, /L3-mine/, "the caller's disjoint L3 edit survives");
  } finally {
    f.cleanup();
  }
});

// plan 3415 Item C review round 3 (finding 13nxuip): a failed pre-guard `git fetch origin
// master` was swallowed SILENTLY — the guard still ran (correctly non-fatal: offline is
// legitimate), but a session had no signal its verdict might be judged against a stale local
// origin/master ref. Unit-tested on the pure describeStaleFetchFailure rather than a real
// broken-origin E2E: a linked worktree shares its repo's remote config with every OTHER
// worktree of that repo (main + wtDir in makeWikiWorktreeOriginRepo both read one `.git/config`),
// so breaking `origin` for wtDir also breaks the coord-checkout's own REQUIRED fetch
// (resolveCoordCheckout, unconditional, no try/catch) — an unrelated, unrecoverable failure
// that would mask whether THIS specific warning fired for the right reason.
test('plan 3415 item C review round 3 (finding 13nxuip): describeStaleFetchFailure names the checkout, the underlying error, and that the guard proceeds on a possibly-stale ref', () => {
  const msg = describeStaleFetchFailure('/some/checkout', new Error('Could not resolve host'));
  assert.match(msg, /wiki-commit:/);
  assert.match(msg, /\/some\/checkout/, 'names the checkout that failed to fetch');
  assert.match(msg, /Could not resolve host/, 'surfaces the underlying git error');
  assert.match(msg, /may itself be stale/i, 'makes the degraded verdict visible, not silent');
});

// ── plan 1697: containment guard + log.md union-merge + refuse-preserves-caller-copy ──────────
// Two live incidents (sessions 1548/1549) landed commits whose net effect was DELETING a
// sibling's just-landed line while wiki-commit reported success — a stale-base snapshot written
// over master. Defect 2: every refuse then reset the caller's working copies, destroying the
// edits it just refused. These tests pin the fixes: (a) log.md union-merges, (b) a net reversion
// is refused by the containment guard, (c) a refuse leaves the caller's working copy intact.

// plan 3415 Item C review (cluster 9): the exemption that lets checkContainment ignore
// `updated:` lines is meant for exactly ONE line — the frontmatter metadata key at the top of
// the page — never a lookalike anywhere else. Pre-fix, `stripUpdatedLines` deleted EVERY line
// matching the `updated: YYYY-MM-DD (...)` SHAPE from every multiset, so a BODY line with that
// shape (a quoted example, a changelog bullet) silently lost the protection of guard (A): a
// stale merge dropping it went undetected because the line had already been stripped from the
// caller's own multiset before the diff ran.
test('checkContainment (cluster 9): a BODY line shaped like an `updated:` line is still protected — the exemption is frontmatter-ONLY, not shape-based', () => {
  const effectiveBase = Buffer.from('---\nname: page\nupdated: 2026-08-01\n---\n\nBody text.\n');
  const effectiveMaster = effectiveBase;
  const callerContent = Buffer.from(
    '---\nname: page\nupdated: 2026-08-10\n---\n\nBody text.\nupdated: 2026-08-01 (plan 1234: example)\n',
  );
  // The merge result DROPPED the caller's own body addition (the class this guard exists to
  // catch) — the frontmatter `updated:` line was also legitimately bumped, which is what the
  // exemption must still allow.
  const content = Buffer.from('---\nname: page\nupdated: 2026-08-10\n---\n\nBody text.\n');
  const r = checkContainment({ effectiveBase, effectiveMaster, callerContent, content });
  assert.equal(r?.action, 'conflict', 'a dropped body addition must still refuse');
  assert.equal(r?.reason, 'containment-caller-adds');
  assert.deepEqual(r?.detail, ['updated: 2026-08-01 (plan 1234: example)']);
});

// plan 3415 Item C review round 3 (finding 1ju4sdn): stripFrontmatterUpdatedLine used
// `Map.delete(line)`, which removes a multiset KEY entirely rather than one occurrence — so
// when the caller's own copy carries a BODY line that happens to be byte-identical to that
// same copy's frontmatter `updated:` line, deleting the frontmatter occurrence also erased the
// body occurrence's count, hiding the caller's real addition from guard (A)'s diff before it
// ever ran. This is the DANGEROUS case: the caller's added line survives on disk but the
// containment guard never sees it dropped.
test('checkContainment (round 3, finding 1ju4sdn): a BODY line byte-identical to the frontmatter updated: line still counts as a caller addition when the merge drops it', () => {
  const effectiveBase = Buffer.from('---\nname: page\nupdated: 2026-08-01\n---\n\nBody text.\n');
  const effectiveMaster = effectiveBase;
  // caller bumps the frontmatter date AND adds a body line that happens to be byte-identical
  // to the NEW frontmatter updated: line (an operator pasting the date into a changelog note).
  const callerContent = Buffer.from(
    '---\nname: page\nupdated: 2026-08-10\n---\n\nBody text.\nupdated: 2026-08-10\n',
  );
  // the buggy merge kept the frontmatter bump but silently dropped the caller's body line
  const content = Buffer.from('---\nname: page\nupdated: 2026-08-10\n---\n\nBody text.\n');
  const r = checkContainment({ effectiveBase, effectiveMaster, callerContent, content });
  assert.equal(
    r?.action,
    'conflict',
    'the dropped body line must still be caught — deleting the frontmatter exemption must never ' +
      "erase an identical BODY line's count too",
  );
  assert.equal(r?.reason, 'containment-caller-adds');
  assert.deepEqual(r?.detail, ['updated: 2026-08-10']);
});

// plan 3415 Item C review round 3 (finding vqbtpw): extractUpdatedDate scanned the WHOLE
// buffer top-to-bottom and returned the FIRST matching line — which happened to mask the bug
// in the common case, since the real frontmatter key normally sits before any body line. But
// when the merge result's frontmatter loses its `updated:` key entirely (the exact case
// checkUpdatedLineMonotonic exists to catch) and a body line elsewhere coincidentally matches
// the shape, the whole-buffer scan silently recovers a "date" from that body line instead of
// reporting the key missing.
test('checkContainment (round 3, finding vqbtpw): a body line matching updated:-shape must never stand in for a MISSING frontmatter updated: line', () => {
  const effectiveBase = Buffer.from(
    '---\nname: page\nupdated: 2026-08-01\n---\n\nupdated: 2026-08-10\n',
  );
  const effectiveMaster = effectiveBase;
  const callerContent = Buffer.from(
    '---\nname: page\nupdated: 2026-08-10\n---\n\nupdated: 2026-08-10\n',
  );
  // buggy merge: the frontmatter `updated:` key itself vanished; the coincidental body line survives
  const content = Buffer.from('---\nname: page\n---\n\nupdated: 2026-08-10\n');
  const r = checkContainment({ effectiveBase, effectiveMaster, callerContent, content });
  assert.equal(
    r?.action,
    'conflict',
    'a missing frontmatter updated: line must be caught, never masked by a coincidental body line',
  );
  assert.equal(r?.reason, 'containment-updated-missing');
});

test('checkContainment: a net reversion (drops a master line, adds nothing to master) is refused', () => {
  // Merge-branch shape (master diverged): master appended D; the caller, from a stale base, deleted
  // B and added nothing, so the merged result drops B while adding nothing to master.
  const r = checkContainment({
    effectiveBase: Buffer.from('A\nB\nC\n'),
    effectiveMaster: Buffer.from('A\nB\nC\nD\n'),
    callerContent: Buffer.from('A\nC\n'),
    content: Buffer.from('A\nC\nD\n'),
  });
  assert.equal(r.action, 'conflict');
  assert.equal(r.reason, 'containment-reversion');
  assert.deepEqual(r.detail, ['B']);
});

test('checkContainment: a concurrent edit that ALSO adds to master is allowed (the 1622 disjoint contract — indistinguishable from a legitimate edit)', () => {
  // Caller replaced line1 (SL→MY) from a stale base; master kept SL and appended NEW. The result
  // drops SL but also adds MY to master → NOT a net reversion. This shape is provably
  // indistinguishable from a legitimate concurrent line-edit (the disjoint-lines-both-survive
  // test requires it to commit), so the guard must NOT fire here.
  const r = checkContainment({
    effectiveBase: Buffer.from('SL\nL1\nL2\n'),
    effectiveMaster: Buffer.from('SL\nL1\nL2\nNEW\n'),
    callerContent: Buffer.from('MY\nL1\nL2\n'),
    content: Buffer.from('MY\nL1\nL2\nNEW\n'),
  });
  assert.equal(r, null);
});

test("checkContainment: a merge that drops the caller's own added line is refused", () => {
  const r = checkContainment({
    effectiveBase: Buffer.from('a\nb\n'),
    effectiveMaster: Buffer.from('a\nb\n'),
    callerContent: Buffer.from('a\nb\nMINE\n'),
    content: Buffer.from('a\nb\n'), // MINE silently dropped
  });
  assert.equal(r.action, 'conflict');
  assert.equal(r.reason, 'containment-caller-adds');
  assert.deepEqual(r.detail, ['MINE']);
});

test('checkContainment: blank / whitespace-only line churn alone never trips the guard', () => {
  const r = checkContainment({
    effectiveBase: Buffer.from('a\n\nb\n'),
    effectiveMaster: Buffer.from('a\n\nb\n'),
    callerContent: Buffer.from('a\nb\n'), // dropped a blank line only
    content: Buffer.from('a\nb\n'),
  });
  assert.equal(r, null);
});

test('checkContainment: CRLF vs LF is normalized — an identical page across line endings is not a loss', () => {
  const r = checkContainment({
    effectiveBase: Buffer.from('a\nb\n'),
    effectiveMaster: Buffer.from('a\nb\n'),
    callerContent: Buffer.from('a\r\nb\r\nc\r\n'), // CRLF on disk, adds c
    content: Buffer.from('a\r\nb\r\nc\r\n'),
  });
  assert.equal(r, null);
});

test('resolveStalePageContent: a solo fast-forward deletion COMMITS - the guard is NOT applied when master has not diverged (correcting a stale claim in place; review fix, plan 1697)', () => {
  // master === base (no concurrency): a deliberate in-place deletion must be trusted, not refused.
  const base = Buffer.from('# page\nkeep\nstale-claim\n');
  const caller = Buffer.from('# page\nkeep\n');
  const r = resolveStalePageContent({ baseBlob: base, masterBlob: base, callerContent: caller });
  assert.equal(r.action, 'write');
  assert.equal(r.content.toString(), caller.toString());
});

test('resolveStalePageContent: a merge-branch net reversion (caller deletes a line while master advanced) IS refused (plan 1697)', () => {
  // master diverged (appended D); the caller, from a stale base, deleted B, so the 3-way merge
  // drops B while adding nothing to master - the silent-reversion signature the incidents hit.
  const r = resolveStalePageContent({
    baseBlob: Buffer.from('A\nB\nC\n'),
    masterBlob: Buffer.from('A\nB\nC\nD\n'),
    callerContent: Buffer.from('A\nC\n'),
  });
  assert.equal(r.action, 'conflict');
  assert.equal(r.reason, 'containment-reversion');
});

test("resolveStalePageContent: wiki/log.md union-merge keeps BOTH sides' appended lines where a plain 3-way would conflict (plan 1697 a)", () => {
  const base = Buffer.from('# log\n- old\n');
  const caller = Buffer.from('# log\n- CALLER\n- old\n');
  const master = Buffer.from('# log\n- SIBLING\n- old\n');
  const plain = resolveStalePageContent({
    baseBlob: base,
    masterBlob: master,
    callerContent: caller,
  });
  assert.equal(plain.action, 'conflict', 'a plain (non-union) 3-way conflicts on the both-prepend');
  const union = resolveStalePageContent(
    { baseBlob: base, masterBlob: master, callerContent: caller },
    { unionMerge: true },
  );
  assert.equal(union.action, 'write');
  assert.match(union.content.toString(), /CALLER/, "the caller's appended line survives");
  assert.match(union.content.toString(), /SIBLING/, "the sibling's landed line survives");
});

// The dogfood: a stale-base NET REVERSION end-to-end (the "master advanced" 3-way-merge branch).
// A sibling appends a line (master diverges); the caller, from its now-stale base, deletes a
// DIFFERENT existing line and adds nothing, so the clean merge would drop that line. pre-1697
// wiki-commit silently committed the deletion (repro'd live). Now the containment guard REFUSES,
// master's content survives, and (defect 2) the caller's working copy is left intact for a
// re-read + re-apply. The fast-forward / solo-deletion case is deliberately NOT refused — see the
// resolveStalePageContent unit tests above (the guard runs only when master has diverged).
test('plan 1697: a stale-base NET REVERSION (caller drops a line while a sibling advanced master) is REFUSED, master survives, caller copy intact (defect 1 + defect 2)', () => {
  const branch = 'worktree-1697-reversion-test';
  const f = makeWikiWorktreeOriginRepo(branch);
  try {
    // Seed a multi-line page as the worktree BASE (keepC sits in the MIDDLE, well separated from
    // the EOF where the sibling appends, so the 3-way merge is CLEAN, not a conflict).
    writeFileSync(
      join(f.main, 'wiki', 'entities', 'page.md'),
      '# page\n\n- keep1\n- keepC\n- keep2\n- keep3\n- keep4\n',
    );
    f.g(f.main, 'add', '-A');
    f.g(f.main, 'commit', '-qm', 'seed multi-line page');
    f.g(f.main, 'push', '-q', 'origin', 'master');
    f.g(f.wtDir, 'fetch', '-q', 'origin', 'master');
    f.g(f.wtDir, 'reset', '-q', '--hard', 'origin/master');

    // A PARALLEL session ADVANCES master by appending a NEW line at EOF (master now diverges).
    landParallelSessionCommit(
      f,
      'wiki/entities/page.md',
      '# page\n\n- keep1\n- keepC\n- keep2\n- keep3\n- keep4\n- SIBLING-appended\n',
      'chore(wiki): sibling appends a line',
    );

    // The caller, from its now-stale base, DELETES keepC and adds nothing, so the clean 3-way
    // merge would drop keepC (net reversion) while keeping the sibling line.
    const staleDeletion = '# page\n\n- keep1\n- keep2\n- keep3\n- keep4\n';
    writeFileSync(join(f.wtDir, 'wiki', 'entities', 'page.md'), staleDeletion);

    const res = spawnSync(
      process.execPath,
      [CLI, 'wiki/entities/page.md', '-m', 'chore(wiki): 1697 reversion dogfood'],
      { cwd: f.wtDir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: '' } },
    );
    assert.notEqual(res.status, 0, 'a net reversion must be refused, never silently committed');
    assert.match(res.stderr, /DELETE lines that exist on current origin\/master/);
    assert.match(res.stderr, /left intact/);

    // Master content survives untouched - no silent deletion committed.
    const onOrigin = execFileSync('git', ['-C', f.origin, 'show', 'master:wiki/entities/page.md'], {
      encoding: 'utf8',
    });
    assert.match(onOrigin, /keepC/, "master's content survives the refusal");
    assert.match(onOrigin, /SIBLING-appended/, "the sibling's landed line survives");

    // defect 2: the refuse left the caller's working copy untouched (its deletion is preserved).
    const afterCopy = readFileSync(join(f.wtDir, 'wiki', 'entities', 'page.md'), 'utf8');
    assert.doesNotMatch(afterCopy, /keepC/, 'the caller copy was NOT reset to master');
    assert.match(afterCopy, /keep1/, "the caller's own content is preserved for a re-apply");
  } finally {
    f.cleanup();
  }
});

// defect 2, also on the plan-1622 stale-base CONFLICT refuse path: an overlapping-edit refusal
// must likewise leave the caller's working copy intact (pre-1697 the unconditional finally reset
// it, forcing a from-scratch re-apply each round — sessions 1548/1549).
test('plan 1697 (defect 2): a stale-base 3-way CONFLICT refuse also leaves the caller working copy intact', () => {
  const branch = 'worktree-1697-conflict-preserve-test';
  const f = makeWikiWorktreeOriginRepo(branch);
  try {
    f.g(f.wtDir, 'fetch', '-q', 'origin', 'master');
    f.g(f.wtDir, 'reset', '-q', '--hard', 'origin/master');
    landParallelSessionCommit(
      f,
      'wiki/entities/page.md',
      '# page\nparallel content\n',
      'chore(wiki): parallel rewrites the page',
    );
    const mine = '# page\nmy conflicting content\n';
    writeFileSync(join(f.wtDir, 'wiki', 'entities', 'page.md'), mine);
    const res = spawnSync(
      process.execPath,
      [CLI, 'wiki/entities/page.md', '-m', 'chore(wiki): 1697 conflict preserve'],
      { cwd: f.wtDir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: '' } },
    );
    assert.notEqual(res.status, 0, 'the overlapping edit must refuse');
    assert.match(res.stderr, /refusing to commit/);
    // The caller's working copy is untouched — the edit it refused survives for a re-apply.
    const afterCopy = readFileSync(join(f.wtDir, 'wiki', 'entities', 'page.md'), 'utf8');
    assert.match(afterCopy, /my conflicting content/, 'the refuse left the caller edit intact');
    assert.doesNotMatch(afterCopy, /parallel content/, 'the caller copy was NOT reset to master');
  } finally {
    f.cleanup();
  }
});

// plan 1697 (a) end-to-end: wiki/log.md union-merges a stale-base append against a parallel
// landed append — both survive, no conflict, no silent drop. Pre-1697 a plain 3-way conflicted
// (both prepend at the same point) and the refuse then reset the caller copy — the journal class
// both live incidents hit.
test('plan 1697 (a): wiki/log.md union-merges — a stale-base append and a parallel landed append BOTH survive', () => {
  const branch = 'worktree-1697-log-union-test';
  const f = makeWikiWorktreeOriginRepo(branch);
  try {
    f.g(f.wtDir, 'fetch', '-q', 'origin', 'master');
    f.g(f.wtDir, 'reset', '-q', '--hard', 'origin/master');
    landParallelSessionCommit(
      f,
      'wiki/log.md',
      '# log\n\n- SIBLING line\n',
      'chore(wiki): sibling log line',
    );
    writeFileSync(join(f.wtDir, 'wiki', 'log.md'), '# log\n\n- CALLER line\n');
    const res = spawnSync(
      process.execPath,
      [CLI, 'wiki/log.md', '-m', 'chore(wiki): 1697 log union'],
      { cwd: f.wtDir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: '' } },
    );
    assert.equal(res.status, 0, res.stderr);
    const onOrigin = execFileSync('git', ['-C', f.origin, 'show', 'master:wiki/log.md'], {
      encoding: 'utf8',
    });
    assert.match(onOrigin, /CALLER line/, "the caller's log line survived the union merge");
    assert.match(onOrigin, /SIBLING line/, "the sibling's landed log line was NOT dropped");
  } finally {
    f.cleanup();
  }
});

// review fix (plan 1697): the mirror of the reversion dogfood — a SOLO fast-forward deletion of a
// stale line (base === master, NO sibling landed) must COMMIT, proving the containment guard does
// NOT fire without divergence (the 'correcting stale claims in place' wiki convention).
test('plan 1697 (review fix): a SOLO fast-forward deletion of a stale line (base==master, no sibling) COMMITS', () => {
  const branch = 'worktree-1697-ff-deletion-test';
  const f = makeWikiWorktreeOriginRepo(branch);
  try {
    // Seed a page carrying a stale claim and bring the worktree up to it. No sibling lands, so the
    // caller's base === current master (the fast-forward branch).
    writeFileSync(
      join(f.main, 'wiki', 'entities', 'page.md'),
      '# page\n\n- keep1\n- stale-claim\n',
    );
    f.g(f.main, 'add', '-A');
    f.g(f.main, 'commit', '-qm', 'seed page with a stale claim');
    f.g(f.main, 'push', '-q', 'origin', 'master');
    f.g(f.wtDir, 'fetch', '-q', 'origin', 'master');
    f.g(f.wtDir, 'reset', '-q', '--hard', 'origin/master');

    // The caller deliberately deletes the stale claim (adds nothing) — must be trusted, not refused.
    writeFileSync(join(f.wtDir, 'wiki', 'entities', 'page.md'), '# page\n\n- keep1\n');
    const res = spawnSync(
      process.execPath,
      [CLI, 'wiki/entities/page.md', '-m', 'chore(wiki): drop stale claim'],
      { cwd: f.wtDir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: '' } },
    );
    assert.equal(res.status, 0, res.stderr);
    const onOrigin = execFileSync('git', ['-C', f.origin, 'show', 'master:wiki/entities/page.md'], {
      encoding: 'utf8',
    });
    assert.match(onOrigin, /keep1/);
    assert.doesNotMatch(onOrigin, /stale-claim/, 'the deliberate deletion committed, not refused');
  } finally {
    f.cleanup();
  }
});

// review coverage (plan 1697): multi-page atomicity — when ONE page in the same invocation refuses,
// the WHOLE commit must abort (coordWrite's mutate throws) and ALL caller working copies are left
// intact (defect 2). Page A conflicts (a parallel session rewrote the same line); page B is a clean
// edit that would commit on its own — it must NOT be partially committed.
test('plan 1697 (defect 2, multi-page): one page refusing aborts the whole commit; no partial land, all caller copies intact', () => {
  const branch = 'worktree-1697-multipage-atomic-test';
  const f = makeWikiWorktreeOriginRepo(branch);
  try {
    writeFileSync(join(f.main, 'wiki', 'entities', 'page-b.md'), '# page B\noriginal B\n');
    f.g(f.main, 'add', '-A');
    f.g(f.main, 'commit', '-qm', 'add page-b');
    f.g(f.main, 'push', '-q', 'origin', 'master');
    f.g(f.wtDir, 'fetch', '-q', 'origin', 'master');
    f.g(f.wtDir, 'reset', '-q', '--hard', 'origin/master');

    // Page A: a PARALLEL session rewrites the same line the caller will edit → a genuine conflict.
    landParallelSessionCommit(
      f,
      'wiki/entities/page.md',
      '# page\nparallel A content\n',
      'chore(wiki): sibling rewrites A',
    );

    // The caller edits BOTH: A conflictingly, B cleanly (B alone would fast-forward-commit).
    writeFileSync(join(f.wtDir, 'wiki', 'entities', 'page.md'), '# page\nmy A content\n');
    writeFileSync(
      join(f.wtDir, 'wiki', 'entities', 'page-b.md'),
      '# page B\noriginal B\nmy clean B addition\n',
    );
    const res = spawnSync(
      process.execPath,
      [
        CLI,
        'wiki/entities/page.md',
        'wiki/entities/page-b.md',
        '-m',
        'chore(wiki): two pages, A conflicts',
      ],
      { cwd: f.wtDir, encoding: 'utf8', env: { ...process.env, COORD_MAIN_DIR: '' } },
    );
    assert.notEqual(res.status, 0, 'a refuse on ONE page must abort the whole commit');
    assert.match(res.stderr, /refusing to commit/);

    // NEITHER page landed — the clean page B must not be partially committed.
    const bOnOrigin = execFileSync(
      'git',
      ['-C', f.origin, 'show', 'master:wiki/entities/page-b.md'],
      { encoding: 'utf8' },
    );
    assert.doesNotMatch(bOnOrigin, /my clean B addition/, 'page B was NOT partially committed');
    const aOnOrigin = execFileSync(
      'git',
      ['-C', f.origin, 'show', 'master:wiki/entities/page.md'],
      {
        encoding: 'utf8',
      },
    );
    assert.match(aOnOrigin, /parallel A content/, "the sibling's A content survives");

    // BOTH caller working copies are intact (defect 2 — the refuse reverted nothing).
    assert.match(
      readFileSync(join(f.wtDir, 'wiki', 'entities', 'page.md'), 'utf8'),
      /my A content/,
    );
    assert.match(
      readFileSync(join(f.wtDir, 'wiki', 'entities', 'page-b.md'), 'utf8'),
      /my clean B addition/,
    );
  } finally {
    f.cleanup();
  }
});
