// scripts/coord/coord-share-lib.test.mjs — unit tests for the pure coord-sharing logic (plan 893).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  globToRegExp,
  matchesAny,
  selectCanonical,
  listCanonical,
  unadoptedFiles,
  classifySibling,
  isFailure,
  filesToWrite,
  normalizeCoordShare,
  gatherSibling,
  adoptClosureGaps,
} from './coord-share-lib.mjs';

test('globToRegExp: * matches any run, dots are literal', () => {
  assert.ok(globToRegExp('*.mjs').test('board.mjs'));
  assert.ok(globToRegExp('*.mjs').test('board-lib.test.mjs'));
  assert.ok(!globToRegExp('*.mjs').test('board.mjsx'));
  assert.ok(!globToRegExp('*.mjs').test('board.py'));
  // a literal dot must not act as a regex wildcard
  assert.ok(!globToRegExp('board.mjs').test('boardXmjs'));
});

test('globToRegExp: * is segment-scoped — does NOT cross a slash (plan 2062)', () => {
  // top-level *.mjs must not reach into a subdirectory
  assert.ok(!globToRegExp('*.mjs').test('test-helpers/isolated-plan-repo.mjs'));
  // a subdir pattern matches only its own directory, and the literal '/' is anchored
  assert.ok(globToRegExp('test-helpers/*.mjs').test('test-helpers/isolated-plan-repo.mjs'));
  assert.ok(!globToRegExp('test-helpers/*.mjs').test('isolated-plan-repo.mjs'));
  assert.ok(!globToRegExp('test-helpers/*.mjs').test('other/isolated-plan-repo.mjs'));
  // one segment deep only — the star does not swallow a nested subdir
  assert.ok(!globToRegExp('test-helpers/*.mjs').test('test-helpers/sub/deep.mjs'));
});

test('matchesAny: any-of semantics + empty list', () => {
  assert.ok(matchesAny('board.mjs', ['*.mjs', '*.py']));
  assert.ok(!matchesAny('board.mjs', ['*.py']));
  assert.ok(!matchesAny('board.mjs', []));
  assert.ok(!matchesAny('board.mjs', undefined));
});

test('selectCanonical: include *.mjs minus exclude, sorted + deduped', () => {
  const files = [
    'board.mjs',
    'board.test.mjs',
    'fetch-scb-vet-kpi.mjs',
    'redgreen.mjs',
    'notes.py',
    'README.md',
    'board.mjs', // dup
  ];
  const out = selectCanonical(files, {
    include: ['*.mjs'],
    exclude: ['fetch-scb-vet-kpi.mjs', 'redgreen.mjs'],
  });
  assert.deepEqual(out, ['board.mjs', 'board.test.mjs']);
});

test('selectCanonical: defaults to *.mjs include, empty exclude', () => {
  assert.deepEqual(selectCanonical(['a.mjs', 'b.py']), ['a.mjs']);
});

test('selectCanonical: a nested include opts in exactly one subdir (plan 2062)', () => {
  const names = [
    'board.mjs',
    'test-helpers/isolated-plan-repo.mjs',
    'test-helpers/notes.py', // wrong extension, never canonical
    'other/thing.mjs', // undeclared subdir, must stay out
  ];
  // flat include alone must NOT pull the nested helper in (the plan-2062 bug)
  assert.deepEqual(selectCanonical(names, { include: ['*.mjs'] }), ['board.mjs']);
  // the nested include adds exactly the one subdir's .mjs, keyed by relative path
  assert.deepEqual(selectCanonical(names, { include: ['*.mjs', 'test-helpers/*.mjs'] }), [
    'board.mjs',
    'test-helpers/isolated-plan-repo.mjs',
  ]);
});

test('listCanonical: scans declared subdirs, returns nested files as relative paths (plan 2062)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'coordshare-list-'));
  writeFileSync(join(tmp, 'board.mjs'), 'B');
  writeFileSync(join(tmp, 'notes.py'), 'P'); // filtered by *.mjs
  mkdirSync(join(tmp, 'test-helpers'));
  writeFileSync(join(tmp, 'test-helpers', 'isolated-plan-repo.mjs'), 'H');
  writeFileSync(join(tmp, 'test-helpers', 'readme.md'), 'R'); // filtered by the glob
  mkdirSync(join(tmp, 'other'));
  writeFileSync(join(tmp, 'other', 'thing.mjs'), 'T'); // undeclared subdir, never scanned

  // flat include: only the top-level file (the pre-2062 behaviour)
  assert.deepEqual(listCanonical(tmp, { include: ['*.mjs'] }), ['board.mjs']);
  // nested include: the declared subdir's .mjs joins, as a posix relative path
  assert.deepEqual(listCanonical(tmp, { include: ['*.mjs', 'test-helpers/*.mjs'] }), [
    'board.mjs',
    'test-helpers/isolated-plan-repo.mjs',
  ]);
  rmSync(tmp, { recursive: true, force: true });
});

test('listCanonical: follows symlinks — symlink-to-FILE is canonical, symlink-to-DIR is not (plan 2062)', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'coordshare-link-'));
  writeFileSync(join(tmp, 'real.mjs'), 'R');
  mkdirSync(join(tmp, 'realdir.mjs')); // a DIRECTORY whose name matches the glob
  try {
    symlinkSync(join(tmp, 'real.mjs'), join(tmp, 'link.mjs'), 'file');
    symlinkSync(join(tmp, 'realdir.mjs'), join(tmp, 'dirlink.mjs'), 'dir');
  } catch {
    // Windows without Developer Mode / admin refuses symlink creation — nothing to assert
    rmSync(tmp, { recursive: true, force: true });
    t.skip('symlink creation not permitted on this host');
    return;
  }
  // real.mjs + link.mjs (symlink→file) in; realdir.mjs (dir) and dirlink.mjs (symlink→dir)
  // out — a symlink-to-dir slipping through would later EISDIR on read
  assert.deepEqual(listCanonical(tmp, { include: ['*.mjs'] }), ['link.mjs', 'real.mjs']);
  rmSync(tmp, { recursive: true, force: true });
});

test('listCanonical: a declared subdir that does not exist is skipped, not an error', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'coordshare-list-'));
  writeFileSync(join(tmp, 'board.mjs'), 'B');
  // test-helpers/ absent on disk — must not throw, just yields the top-level file
  assert.deepEqual(listCanonical(tmp, { include: ['*.mjs', 'test-helpers/*.mjs'] }), ['board.mjs']);
  rmSync(tmp, { recursive: true, force: true });
});

test('unadoptedFiles: set difference, sorted — never a length subtraction (plan 2062)', () => {
  assert.deepEqual(unadoptedFiles(['b.mjs', 'a.mjs', 'c.mjs'], ['a.mjs']), ['b.mjs', 'c.mjs']);
  assert.deepEqual(unadoptedFiles(['a.mjs'], []), ['a.mjs']);
  assert.deepEqual(unadoptedFiles([], ['a.mjs']), []);
  // an adopt entry OUTSIDE the canonical set (badAdopt) must not skew the result —
  // a naive canonicalFiles.length - adopt.length would report -1 here
  assert.deepEqual(unadoptedFiles(['a.mjs'], ['a.mjs', 'ghost.mjs', 'extra.mjs']), []);
  assert.deepEqual(unadoptedFiles(undefined, undefined), []);
});

test('classifySibling: unadopted bucket is exactly unadoptedFiles (one shared definition)', () => {
  const canonicalFiles = ['a.mjs', 'b.mjs', 'c.mjs'];
  const adopt = ['a.mjs'];
  const c = classifySibling({
    canonicalFiles,
    adopt,
    canon: { 'a.mjs': 'A' },
    sib: { 'a.mjs': 'A' },
  });
  assert.deepEqual(c.unadopted, unadoptedFiles(canonicalFiles, adopt));
});

test('classifySibling: inSync / drift / missing / unadopted buckets', () => {
  const canonicalFiles = ['board.mjs', 'claim.mjs', 'done.mjs', 'index.mjs'];
  const adopt = ['board.mjs', 'claim.mjs', 'done.mjs'];
  const canon = { 'board.mjs': 'B', 'claim.mjs': 'C', 'done.mjs': 'D', 'index.mjs': 'I' };
  const sib = { 'board.mjs': 'B', 'claim.mjs': 'C-OLD' }; // board in-sync, claim drifted, done missing
  const c = classifySibling({ canonicalFiles, adopt, canon, sib });
  assert.deepEqual(c.inSync, ['board.mjs']);
  assert.deepEqual(c.drift, ['claim.mjs']);
  assert.deepEqual(c.missing, ['done.mjs']);
  assert.deepEqual(c.unadopted, ['index.mjs']); // canonical but not adopted = backlog
  assert.deepEqual(c.badAdopt, []);
});

test('classifySibling: adopted file not in canonical set ⇒ badAdopt (config error)', () => {
  const c = classifySibling({
    canonicalFiles: ['board.mjs'],
    adopt: ['board.mjs', 'ghost.mjs'],
    canon: { 'board.mjs': 'B' },
    sib: { 'board.mjs': 'B', 'ghost.mjs': 'G' },
  });
  assert.deepEqual(c.badAdopt, ['ghost.mjs']);
  assert.deepEqual(c.inSync, ['board.mjs']);
});

test('isFailure: true on drift / missing / badAdopt, false when all adopted in-sync', () => {
  assert.equal(
    isFailure({ drift: [], missing: [], badAdopt: [], inSync: ['a'], unadopted: [] }),
    false,
  );
  assert.equal(
    isFailure({ drift: ['a'], missing: [], badAdopt: [], inSync: [], unadopted: [] }),
    true,
  );
  assert.equal(
    isFailure({ drift: [], missing: ['a'], badAdopt: [], inSync: [], unadopted: [] }),
    true,
  );
  assert.equal(
    isFailure({ drift: [], missing: [], badAdopt: ['a'], inSync: [], unadopted: [] }),
    true,
  );
  // a non-empty unadopted backlog is NOT a failure (tolerate-subset)
  assert.equal(
    isFailure({ drift: [], missing: [], badAdopt: [], inSync: [], unadopted: ['x', 'y'] }),
    false,
  );
});

test('filesToWrite: drift + missing, never inSync or unadopted', () => {
  const c = classifySibling({
    canonicalFiles: ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs'],
    adopt: ['a.mjs', 'b.mjs', 'c.mjs'],
    canon: { 'a.mjs': '1', 'b.mjs': '2', 'c.mjs': '3', 'd.mjs': '4' },
    sib: { 'a.mjs': '1', 'b.mjs': 'OLD' }, // a in-sync, b drift, c missing, d unadopted
  });
  assert.deepEqual(filesToWrite(c), ['b.mjs', 'c.mjs']);
});

test('normalizeCoordShare: null passes through', () => {
  assert.equal(normalizeCoordShare(null), null);
  assert.equal(normalizeCoordShare(undefined), null);
});

test('normalizeCoordShare: fills defaults, dedupes + sorts adopt, inherits dir', () => {
  const n = normalizeCoordShare({
    siblings: [{ name: 'tandapp', path: '../tandapp', adopt: ['z.mjs', 'a.mjs', 'a.mjs'] }],
  });
  assert.equal(n.role, 'canonical');
  assert.equal(n.dir, 'scripts');
  assert.deepEqual(n.include, ['*.mjs']);
  assert.deepEqual(n.exclude, []);
  assert.equal(n.siblings.length, 1);
  assert.equal(n.siblings[0].dir, 'scripts'); // inherited from top-level dir
  assert.deepEqual(n.siblings[0].adopt, ['a.mjs', 'z.mjs']);
});

test('normalizeCoordShare: sibling-level dir override', () => {
  const n = normalizeCoordShare({
    dir: 'scripts',
    siblings: [{ name: 's', path: '../s', dir: 'tools', adopt: [] }],
  });
  assert.equal(n.siblings[0].dir, 'tools');
});

test('normalizeCoordShare: missing name / path throws loud', () => {
  assert.throws(() => normalizeCoordShare({ siblings: [{ path: '../x' }] }), /missing "name"/);
  assert.throws(() => normalizeCoordShare({ siblings: [{ name: 'x' }] }), /missing "path"/);
  assert.throws(() => normalizeCoordShare(42), /must be an object/);
});

// gatherSibling (IO) — the absent-vs-present skip decision keys on the repo ROOT.
test('gatherSibling: absent sibling repo root ⇒ present:false (skip, never fail)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'coordshare-'));
  const canonicalDir = join(tmp, 'canon');
  mkdirSync(canonicalDir);
  writeFileSync(join(canonicalDir, 'a.mjs'), 'X');
  const g = gatherSibling({
    canonicalDir,
    canonicalFiles: ['a.mjs'],
    mainRoot: tmp,
    sibling: { name: 's', path: 'does-not-exist', dir: 'scripts', adopt: ['a.mjs'] },
  });
  assert.equal(g.present, false);
  assert.equal(g.classification, null);
  rmSync(tmp, { recursive: true, force: true });
});

test('gatherSibling: present root, present dir ⇒ classifies (inSync + drift)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'coordshare-'));
  const canonicalDir = join(tmp, 'canon');
  mkdirSync(canonicalDir);
  writeFileSync(join(canonicalDir, 'a.mjs'), 'X');
  writeFileSync(join(canonicalDir, 'b.mjs'), 'Y');
  const sibScripts = join(tmp, 'sib', 'scripts');
  mkdirSync(sibScripts, { recursive: true });
  writeFileSync(join(sibScripts, 'a.mjs'), 'X'); // in-sync
  writeFileSync(join(sibScripts, 'b.mjs'), 'OLD'); // drift
  const g = gatherSibling({
    canonicalDir,
    canonicalFiles: ['a.mjs', 'b.mjs'],
    mainRoot: tmp,
    sibling: { name: 'sib', path: 'sib', dir: 'scripts', adopt: ['a.mjs', 'b.mjs'] },
  });
  assert.equal(g.present, true);
  assert.deepEqual(g.classification.inSync, ['a.mjs']);
  assert.deepEqual(g.classification.drift, ['b.mjs']);
  rmSync(tmp, { recursive: true, force: true });
});

test('gatherSibling: a nested adopted entry classifies through its subdir (plan 2062)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'coordshare-'));
  const canonicalDir = join(tmp, 'canon');
  mkdirSync(join(canonicalDir, 'test-helpers'), { recursive: true });
  writeFileSync(join(canonicalDir, 'board.mjs'), 'B');
  writeFileSync(join(canonicalDir, 'test-helpers', 'helper.mjs'), 'H');
  const sibScripts = join(tmp, 'sib', 'scripts');
  mkdirSync(join(sibScripts, 'test-helpers'), { recursive: true });
  writeFileSync(join(sibScripts, 'board.mjs'), 'B'); // in-sync
  writeFileSync(join(sibScripts, 'test-helpers', 'helper.mjs'), 'OLD'); // nested drift
  const g = gatherSibling({
    canonicalDir,
    canonicalFiles: ['board.mjs', 'test-helpers/helper.mjs'],
    mainRoot: tmp,
    sibling: {
      name: 'sib',
      path: 'sib',
      dir: 'scripts',
      adopt: ['board.mjs', 'test-helpers/helper.mjs'],
    },
  });
  assert.equal(g.present, true);
  assert.deepEqual(g.classification.inSync, ['board.mjs']);
  assert.deepEqual(g.classification.drift, ['test-helpers/helper.mjs']); // read through the subdir
  rmSync(tmp, { recursive: true, force: true });
});

test('gatherSibling: present root but MISSING coord dir ⇒ present:true, all adopted = missing (gate fails, not skip)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'coordshare-'));
  const canonicalDir = join(tmp, 'canon');
  mkdirSync(canonicalDir);
  writeFileSync(join(canonicalDir, 'a.mjs'), 'X');
  mkdirSync(join(tmp, 'sib')); // repo root exists, but NO scripts/ dir inside
  const g = gatherSibling({
    canonicalDir,
    canonicalFiles: ['a.mjs'],
    mainRoot: tmp,
    sibling: { name: 'sib', path: 'sib', dir: 'scripts', adopt: ['a.mjs'] },
  });
  assert.equal(g.present, true); // NOT skipped — a mis-pointed dir must fail the gate
  assert.deepEqual(g.classification.missing, ['a.mjs']);
  assert.equal(isFailure(g.classification), true);
  rmSync(tmp, { recursive: true, force: true });
});

// --- adoptClosureGaps (plan 2160) --------------------------------------------

const CLOSURE_SOURCES = {
  'move-plan.mjs': "import { extractPlanRefs } from './lint-board.mjs';\n",
  'lint-board.mjs': "import { splitBoard } from './board-lib.mjs';\n",
  'board-lib.mjs': 'export const splitBoard = () => {};\n',
  'self-contained.mjs': "import fs from 'node:fs';\n",
};
const readClosureSource = (rel) => CLOSURE_SOURCES[rel] ?? null;

test('adoptClosureGaps: an adopted file importing a NON-adopted one is a gap (the plan-2160 lint-board incident shape)', () => {
  assert.deepEqual(adoptClosureGaps(['move-plan.mjs'], readClosureSource), [
    { file: 'move-plan.mjs', target: 'lint-board.mjs' },
  ]);
});

test('adoptClosureGaps: a dependency-closed adopt list has no gaps', () => {
  assert.deepEqual(
    adoptClosureGaps(
      ['move-plan.mjs', 'lint-board.mjs', 'board-lib.mjs', 'self-contained.mjs'],
      readClosureSource,
    ),
    [],
  );
});

test('adoptClosureGaps: closing one edge exposes the next missing link (transitive closure grows file-by-file)', () => {
  assert.deepEqual(adoptClosureGaps(['move-plan.mjs', 'lint-board.mjs'], readClosureSource), [
    { file: 'lint-board.mjs', target: 'board-lib.mjs' },
  ]);
});

test('adoptClosureGaps: absent canonical source is skipped (missing/badAdopt owns that), non-.mjs entries are skipped', () => {
  assert.deepEqual(adoptClosureGaps(['ghost.mjs', 'notes.md'], readClosureSource), []);
});

test('adoptClosureGaps: .test.mjs entries are walked too (a synced test importing an unmanaged file strands the sibling, plan 1323)', () => {
  const read = (rel) =>
    rel === 'foo.test.mjs' ? "import { foo } from './foo.mjs';\nimport './helper.mjs';\n" : null;
  assert.deepEqual(adoptClosureGaps(['foo.test.mjs', 'foo.mjs'], read), [
    { file: 'foo.test.mjs', target: 'helper.mjs' },
  ]);
});

test('adoptClosureGaps: nested importer resolves against its own dir; adopted nested targets close the edge (plan 2062 keying)', () => {
  const read = (rel) =>
    rel === 'test-helpers/repo.mjs'
      ? "import { x } from '../board-lib.mjs';\nimport './peer.mjs';\n"
      : null;
  assert.deepEqual(adoptClosureGaps(['test-helpers/repo.mjs', 'board-lib.mjs'], read), [
    { file: 'test-helpers/repo.mjs', target: 'test-helpers/peer.mjs' },
  ]);
});
