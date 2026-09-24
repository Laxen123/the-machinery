// scripts/doc-lint-cli.test.mjs  (plan 3204)
//
// Name-pair for the new scripts/doc-lint-cli.mjs module — the shared CLI spine both
// doc-freshness lints run on. It gets its own file rather than living inside either lint's
// battery because the whole point of the module is that it belongs to NEITHER: a case written
// here proves the contract for both, where the same case in `assert-doc-pointers.test.mjs`
// would silently stop covering the plan lint the day the two diverged.
//
// Everything is driven through a fake spec — no corpus, no git, no disk beyond one temp
// grandfather file — so these tests pin the command SHAPE and nothing about either question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KNOWN_FLAGS, parseArgs, readGrandfatherFile, runLint } from './doc-lint-cli.mjs';

/** A lint that reports one finding per document whose text is the word `bad`. */
function fakeSpec(over = {}) {
  return {
    name: 'fake-lint',
    repoRoot: '/nowhere',
    grandfatherFile: 'scripts/fake-grandfather.txt',
    isCorpusFile: (p) => p.startsWith('docs/'),
    listCorpus: () => ['docs/a.md', 'docs/b.md'],
    noun: { many: 'problem(s)' },
    parse: (doc, text) => ({ doc, text }),
    lintItem: ({ doc, text }, { grandfather }) =>
      text.includes('bad')
        ? grandfather.has(`${doc} bad`)
          ? { findings: [], grandfathered: 1 }
          : { findings: [{ doc, line: 1, kind: 'fake', message: 'bad' }], grandfathered: 0 }
        : { findings: [], grandfathered: 0 },
    ...over,
  };
}

const opts = (over = {}) => ({
  root: '/nowhere',
  readDoc: (p) => (p === 'docs/a.md' ? 'bad' : 'fine'),
  ...over,
});

// ── flags ────────────────────────────────────────────────────────────────────────

test('parseArgs splits the shared flag set from the positional file list', () => {
  const a = parseArgs(['--check', 'docs/x.md', '--json']);
  assert.equal(a.check, true);
  assert.equal(a.asJson, true);
  assert.equal(a.useGrandfather, true);
  assert.equal(a.scoped, true);
  assert.deepEqual(a.positional, ['docs/x.md']);
  assert.deepEqual(a.unknown, []);
});

test('--no-grandfather is the only way to turn the snapshot off', () => {
  assert.equal(parseArgs([]).useGrandfather, true);
  assert.equal(parseArgs(['--no-grandfather']).useGrandfather, false);
});

test('a bare run is UNSCOPED; --stdin alone is SCOPED', () => {
  assert.equal(parseArgs([]).scoped, false);
  assert.equal(parseArgs(['--check']).scoped, false);
  assert.equal(parseArgs(['--stdin']).scoped, true);
});

test('an unknown flag is reported rather than guessed at', () => {
  assert.deepEqual(parseArgs(['--check', '--all']).unknown, ['--all']);
  assert.equal(KNOWN_FLAGS.includes('--all'), false);
});

test('an unknown flag exits 2 — a caller bug, not a doc finding', () => {
  assert.equal(runLint(fakeSpec(), ['--nope'], opts()), 2);
});

// ── exit codes ───────────────────────────────────────────────────────────────────

test('findings WARN and exit 0 by default, and exit 1 under --check', () => {
  assert.equal(runLint(fakeSpec(), [], opts()), 0);
  assert.equal(runLint(fakeSpec(), ['--check'], opts()), 1);
});

test('a clean corpus exits 0 in both modes', () => {
  const clean = opts({ readDoc: () => 'fine' });
  assert.equal(runLint(fakeSpec(), [], clean), 0);
  assert.equal(runLint(fakeSpec(), ['--check'], clean), 0);
});

test('--json prints the payload and keeps the same exit contract', () => {
  const lines = [];
  const log = console.log;
  console.log = (s) => lines.push(s);
  try {
    assert.equal(runLint(fakeSpec(), ['--json'], opts()), 0);
    assert.equal(runLint(fakeSpec(), ['--json', '--check'], opts()), 1);
  } finally {
    console.log = log;
  }
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.docs, 2);
  assert.equal(payload.findings.length, 1);
  assert.equal(payload.findings[0].doc, 'docs/a.md');
});

// ── scoping ──────────────────────────────────────────────────────────────────────

test('named files are filtered to the corpus, so a caller may pass its whole changed list', () => {
  assert.equal(runLint(fakeSpec(), ['--check', 'docs/a.md'], opts()), 1);
  assert.equal(runLint(fakeSpec(), ['--check', 'backend/src/app.ts'], opts()), 0);
});

test('an explicitly scoped run with no corpus file lints NOTHING, not everything', () => {
  // The corpus is dirty (docs/a.md), but this push touched only a non-corpus file. Falling
  // through to listCorpus() here would report a stranger's backlog on somebody's push.
  let listed = 0;
  const spec = fakeSpec({
    listCorpus: () => {
      listed += 1;
      return ['docs/a.md'];
    },
  });
  assert.equal(runLint(spec, ['--check', 'backend/src/app.ts'], opts()), 0);
  assert.equal(listed, 0);
  // …and the unscoped run does sweep.
  assert.equal(runLint(spec, ['--check'], { root: '/nowhere', readDoc: () => 'bad' }), 1);
  assert.equal(listed, 1);
});

test('a document that reads back null is skipped, not counted, not a crash', () => {
  const lines = [];
  const log = console.log;
  console.log = (s) => lines.push(s);
  try {
    runLint(fakeSpec(), ['--json'], opts({ readDoc: (p) => (p === 'docs/a.md' ? 'bad' : null) }));
  } finally {
    console.log = log;
  }
  assert.equal(JSON.parse(lines[0]).docs, 1);
});

// ── prepare / ctx ────────────────────────────────────────────────────────────────

test('prepare runs ONCE for the whole run and its ctx reaches every lintItem', () => {
  let prepared = 0;
  const seen = [];
  const spec = fakeSpec({
    prepare: (items) => {
      prepared += 1;
      return { count: items.length };
    },
    lintItem: (item, { ctx }) => {
      seen.push(ctx.count);
      return { findings: [], grandfathered: 0 };
    },
  });
  runLint(spec, [], opts());
  assert.equal(prepared, 1);
  assert.deepEqual(seen, [2, 2]);
});

// ── grandfathering ───────────────────────────────────────────────────────────────

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'doc-lint-cli-'));
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

test('readGrandfatherFile skips comments and blanks, and is empty when the file is absent', () => {
  withFixture(({ root, write }) => {
    assert.equal(readGrandfatherFile(root, 'scripts/gf.txt').size, 0);
    write('scripts/gf.txt', '# a comment\n\ndocs/a.md docs/b.md\n  \n');
    assert.deepEqual([...readGrandfatherFile(root, 'scripts/gf.txt')], ['docs/a.md docs/b.md']);
  });
});

test('normalizeKey canonicalises the key half of each pair', () => {
  withFixture(({ root, write }) => {
    write('scripts/gf.txt', 'docs/a.md 007\n');
    const gf = readGrandfatherFile(root, 'scripts/gf.txt', (k) => String(Number(k)));
    assert.deepEqual([...gf], ['docs/a.md 7']);
  });
});

test('a grandfathered finding is counted, not reported, and --no-grandfather shows it', () => {
  withFixture(({ root, write }) => {
    write('scripts/fake-grandfather.txt', 'docs/a.md bad\n');
    const o = opts({ root });
    assert.equal(runLint(fakeSpec(), ['--check'], o), 0);
    assert.equal(runLint(fakeSpec(), ['--check', '--no-grandfather'], o), 1);
  });
});
