// Name-paired test for scripts/coord/module-graph.mjs — justified as the name-pair of a
// genuinely new module (plan 4061's committed T1/T4 measurement asset; no existing test file
// hosts an import-graph or command-census surface).
//
// The load-bearing cases are the DETECTOR ones. `hasCliGuard` false-negatives are what plan 4061
// exists to prevent: a live command whose guard shape the detector misses is left unsplit, and
// its invoked path breaks at coord-core step 4 with nothing red until a hook fails in production.
// Two successive shape-matching regexes each missed one live spelling during this plan's own
// execution, so all four in-tree spellings are pinned here as fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  statSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { seeds: SEEDS } = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'coord-core-move-seeds.json'), 'utf8'),
);

import {
  buildGraph,
  closure,
  fanIn,
  guardKind,
  hasCliGuard,
  exportsEntry,
  commandCensus,
  specifiersOf,
  optionalSpecifiersOf,
  resolveLocal,
  moduleFiles,
  walk,
  SCRIPTS_DIR,
} from './module-graph.mjs';

function scratchTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'module-graph-'));
  for (const [rel, src] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, src);
  }
  return root;
}

test('guardKind detects all four CLI main-guard spellings live in this tree', () => {
  const cases = {
    // the common one
    'a.mjs':
      'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { main(); }',
    // wiki-size-lint / wiki-log-lint
    'b.mjs':
      'if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) { main(); }',
    // nightly-windows-suite, via an isMain() helper several lines from the call
    'c.mjs':
      'function isMain() {\n  return import.meta.url === pathToFileURL(process.argv[1]).href;\n}\nif (isMain()) main();',
    // gate-pass-cache before this plan: NO import.meta.url at all
    'd.mjs': "if (process.argv[1] && process.argv[1].endsWith('d.mjs')) { main(); }",
  };
  const root = scratchTree(cases);
  try {
    assert.equal(guardKind(join(root, 'a.mjs')), 'import-meta');
    assert.equal(guardKind(join(root, 'b.mjs')), 'import-meta');
    assert.equal(guardKind(join(root, 'c.mjs')), 'import-meta');
    assert.equal(
      guardKind(join(root, 'd.mjs')),
      'endsWith',
      'the basename form must be detected AND distinguished',
    );
    for (const f of Object.keys(cases)) assert.equal(hasCliGuard(join(root, f)), true, f);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('guardKind does not fire on a module that merely mentions import.meta.url', () => {
  const root = scratchTree({
    // resolveMain()-style dirname use: import.meta.url with no argv[1] anywhere near it
    'lib.mjs': 'const HERE = dirname(fileURLToPath(import.meta.url));\nexport const X = HERE;\n',
    // argv used, but not as an entry-point identity test
    'reads-argv.mjs': "const flag = process.argv.includes('--json');\nexport default flag;\n",
  });
  try {
    assert.equal(guardKind(join(root, 'lib.mjs')), null);
    assert.equal(guardKind(join(root, 'reads-argv.mjs')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exportsEntry distinguishes an exported entry point from a private one', () => {
  const root = scratchTree({
    'plain.mjs': 'function main() { return 0; }\n',
    'exported.mjs': 'export function main() { return 0; }\n',
    'exported-async.mjs': 'export async function main(argv) { return argv; }\n',
    'listed.mjs': 'function main() {}\nexport { main };\n',
  });
  try {
    assert.equal(exportsEntry(join(root, 'plain.mjs')), false);
    assert.equal(exportsEntry(join(root, 'exported.mjs')), true);
    assert.equal(exportsEntry(join(root, 'exported-async.mjs')), true);
    assert.equal(exportsEntry(join(root, 'listed.mjs')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('specifiersOf picks up static, re-export and dynamic import forms', () => {
  const root = scratchTree({
    'm.mjs': [
      "import a from './a.mjs';",
      "import { b } from './b.mjs';",
      // A side-effect-only import sitting BEFORE a later `… from '…'`: the shape an earlier
      // combined regex here swallowed, losing this edge silently.
      "import './side-effect.mjs';",
      "import 'node:fs';",
      "export { c } from './c.mjs';",
      "export * from './d.mjs';",
      "const e = await import('./e.mjs');",
    ].join('\n'),
  });
  try {
    const specs = specifiersOf(join(root, 'm.mjs'));
    for (const s of [
      './a.mjs',
      './b.mjs',
      './side-effect.mjs',
      './c.mjs',
      './d.mjs',
      './e.mjs',
      'node:fs',
    ]) {
      assert.ok(specs.includes(s), `missing ${s}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('specifiersOf sees a second import that follows a semicolon on the SAME line', () => {
  // gpt-review round 1 (reuse angle): the statement anchor was `(?:^|\n)\s*import`, so only the
  // FIRST import on a line could match. Prettier never emits this, but the graph must not depend
  // on the tree happening to be prettier-clean.
  const root = scratchTree({ 'm.mjs': "import a from './a.mjs'; import b from './b.mjs';\n" });
  try {
    const specs = specifiersOf(join(root, 'm.mjs'));
    assert.ok(specs.includes('./a.mjs'), './a.mjs lost');
    assert.ok(specs.includes('./b.mjs'), 'same-line second import lost');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('specifiersOf survives a multi-line clause carrying an apostrophe or a semicolon', () => {
  // The other silent-miss class: tightening the clause to a negated `[^'";]` class to fix the
  // side-effect case breaks exactly this, and it is live in the real tree (15 edges).
  const root = scratchTree({
    'm.mjs': [
      'import {',
      "  alpha, // don't reorder these",
      '  beta, // needs a semicolon; really',
      "} from './wide.mjs';",
      "import { z } from './z.mjs';",
    ].join('\n'),
  });
  try {
    const specs = specifiersOf(join(root, 'm.mjs'));
    assert.ok(specs.includes('./wide.mjs'), 'multi-line clause edge lost');
    assert.ok(specs.includes('./z.mjs'), './z.mjs lost');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveLocal returns null for builtins, bare specifiers and escapes', () => {
  const root = scratchTree({ 'scripts/m.mjs': '', 'outside.mjs': '' });
  const scriptsDir = join(root, 'scripts');
  const from = join(scriptsDir, 'm.mjs');
  try {
    assert.equal(resolveLocal(from, 'node:fs', scriptsDir), null);
    assert.equal(resolveLocal(from, 'zod', scriptsDir), null);
    assert.equal(
      resolveLocal(from, '../outside.mjs', scriptsDir),
      null,
      'must not resolve outside scriptsDir',
    );
    assert.equal(
      resolveLocal(from, './nope.mjs', scriptsDir),
      null,
      'a specifier naming nothing on disk is not an edge',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildGraph + closure + fanIn agree on a known shape', () => {
  const root = scratchTree({
    'scripts/entry.mjs': "import './mid.mjs';\nimport './leaf.mjs';\n",
    'scripts/mid.mjs': "import './leaf.mjs';\n",
    'scripts/leaf.mjs': 'export const x = 1;\n',
    'scripts/unrelated.mjs': 'export const y = 2;\n',
    // a test file must be excluded from the graph entirely
    'scripts/leaf.test.mjs': "import './leaf.mjs';\n",
  });
  const scriptsDir = join(root, 'scripts');
  try {
    const g = buildGraph(scriptsDir);
    assert.equal(g.nodes.size, 4, '.test.mjs is excluded from the graph');
    assert.equal(g.edges, 3, 'entry->mid, entry->leaf, mid->leaf');

    const c = closure([join(scriptsDir, 'entry.mjs')], g);
    assert.equal(c.size, 3);
    assert.ok(!c.has(join(scriptsDir, 'unrelated.mjs')));

    const back = fanIn(g);
    assert.equal(
      back.get(join(scriptsDir, 'leaf.mjs')).size,
      2,
      'leaf fan-in counts entry and mid, not the test',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('closure terminates on an import cycle', () => {
  const root = scratchTree({
    'scripts/a.mjs': "import './b.mjs';\n",
    'scripts/b.mjs': "import './a.mjs';\n",
  });
  const scriptsDir = join(root, 'scripts');
  try {
    const g = buildGraph(scriptsDir);
    assert.equal(closure([join(scriptsDir, 'a.mjs')], g).size, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── plan 4096: an importOptional(…) edge is optional, not required ───────────────────────────

const OPTIONAL_CALL = [
  "import { importOptional } from './coord/optional-import.mjs';",
  'const P = await importOptional(',
  "  new URL('./plugin.mjs', import.meta.url),",
  "  () => import('./plugin.mjs'),",
  ');',
].join('\n');

test('an importOptional-only edge is an edge by default and skipped under skipOptional', () => {
  const root = scratchTree({
    'scripts/entry.mjs': `${OPTIONAL_CALL}\nimport './core.mjs';\n`,
    'scripts/core.mjs': '',
    'scripts/plugin.mjs': "import './plugin-dep.mjs';\n",
    'scripts/plugin-dep.mjs': '',
    'scripts/coord/optional-import.mjs': 'export async function importOptional(url, load) {}\n',
  });
  const scriptsDir = join(root, 'scripts');
  try {
    const entry = join(scriptsDir, 'entry.mjs');
    assert.deepEqual(optionalSpecifiersOf(entry, readFileSync(entry, 'utf8')), ['./plugin.mjs']);
    const g = buildGraph(scriptsDir);
    assert.equal(g.edges, 4, 'the optional edge still counts as an edge');
    const all = [...closure([entry], g)].map((p) => basename(p)).sort();
    assert.deepEqual(all, [
      'core.mjs',
      'entry.mjs',
      'optional-import.mjs',
      'plugin-dep.mjs',
      'plugin.mjs',
    ]);
    const req = [...closure([entry], g, { skipOptional: true })].map((p) => basename(p)).sort();
    assert.deepEqual(req, ['core.mjs', 'entry.mjs', 'optional-import.mjs']);
    // The seam's own DECLARATION is not a call: nothing in optional-import.mjs is optional.
    assert.equal(g.nodes.get(join(scriptsDir, 'coord', 'optional-import.mjs')).optional.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a specifier imported both optionally and statically stays required', () => {
  const root = scratchTree({
    'scripts/entry.mjs': `${OPTIONAL_CALL}\nimport { x } from './plugin.mjs';\n`,
    // a second SPELLING of the same module, only through the seam, must not make it optional
    'scripts/entry2.mjs': [
      "import { importOptional } from './coord/optional-import.mjs';",
      "import './plugin.mjs';",
      "await importOptional(new URL('../scripts/plugin.mjs', import.meta.url), () => import('../scripts/plugin.mjs'));",
    ].join('\n'),
    'scripts/plugin.mjs': '',
    'scripts/coord/optional-import.mjs': '',
  });
  const scriptsDir = join(root, 'scripts');
  try {
    const entry = join(scriptsDir, 'entry.mjs');
    assert.deepEqual(optionalSpecifiersOf(entry, readFileSync(entry, 'utf8')), []);
    const g = buildGraph(scriptsDir);
    for (const name of ['entry.mjs', 'entry2.mjs']) {
      const req = closure([join(scriptsDir, name)], g, { skipOptional: true });
      assert.ok(req.has(join(scriptsDir, 'plugin.mjs')), `${name}: plugin.mjs is required`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a commented-out importOptional call does not make an edge optional', () => {
  const src = [
    "// importOptional(new URL('./plugin.mjs', import.meta.url), () => import('./plugin.mjs'));",
    "/* importOptional(new URL('./other.mjs', import.meta.url), () => import('./other.mjs')); */",
    "const later = () => import('./plugin.mjs');",
    "const doc = `importOptional(new URL('./third.mjs', import.meta.url), () => import('./third.mjs'))`;",
  ].join('\n');
  assert.deepEqual(optionalSpecifiersOf('m.mjs', src), []);
  assert.deepEqual(specifiersOf('m.mjs', src), ['./plugin.mjs']);
});

test('the real done-worktree.mjs required closure contains no scripts/project/**', (t) => {
  // plan 3958: scripts/project/ is vetapp's own gate/plugin tree and does not ship in the
  // public coord-kit at all (a core-only checkout — the same "importOptional returns null
  // ONLY when the file itself is absent" shape done-worktree.mjs's own header documents for
  // land-plugin.mjs). buildGraph() only creates nodes for files that exist on disk, so with no
  // scripts/project/ tree at all there is no optional edge to follow and the precondition
  // below is unsatisfiable — nothing meaningful to pin either half of this test against.
  if (!existsSync(join(SCRIPTS_DIR, 'project', 'land-plugin.mjs'))) {
    t.skip('scripts/project/land-plugin.mjs is absent — core-only checkout, nothing to scope');
    return;
  }
  const g = buildGraph();
  const entry = join(SCRIPTS_DIR, 'done-worktree.mjs');
  const projectDir = join(SCRIPTS_DIR, 'project') + sep;
  const inProject = (set) => [...set].filter((p) => p.startsWith(projectDir));
  assert.ok(
    inProject(closure([entry], g)).length > 0,
    'default closure still follows the optional land-plugin edge (pass-cache behaviour)',
  );
  const leaked = inProject(closure([entry], g, { skipOptional: true }));
  assert.deepEqual(leaked, [], `required closure reaches project code: ${leaked.join(', ')}`);
});

test('commandCensus counts invocations, not prose, and anchors scripts/ at a path root', () => {
  const root = scratchTree({
    'surface/hook.sh': [
      'node scripts/real-one.mjs --flag',
      '# see scripts/mentioned-only.mjs for details',
      // the false positive that made `verify-mobile-gate` look like a top-level command
      'node frontend/scripts/verify-mobile-gate.mjs --detect-only',
      'node backend/scripts/other.mjs',
    ].join('\n'),
    'plans/plan.md': 'node scripts/plans-corpus-only.mjs',
  });
  try {
    const census = commandCensus([join(root, 'surface'), join(root, 'plans')], {
      excludeDirs: ['plans'],
      repoRoot: root,
    });
    const names = [...census.keys()].sort();
    assert.deepEqual(names, ['real-one'], `unexpected census: ${names.join(', ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── gpt-review round 1 findings ───────────────────────────────────────────────────────────────

test('commandCensus sees a SPAWNED command whose path is constructed, not literal', () => {
  // The highest-consequence miss found in review, and it is live in this tree:
  // scripts/landing-queue-board.mjs (a step-4 SEED) spawns its sibling queue command as
  //   const STATUS_SCRIPT = join(HERE, '<sibling>.mjs');
  //   execFileSync(process.execPath, [STATUS_SCRIPT, 'status', '--json'])
  // A regex that only matches a literal `node scripts/<name>.mjs` cannot see it — so the module
  // reads as "not a command", is left unsplit, AND its `join(HERE, …)` breaks the moment step 4
  // moves the spawning module to scripts/coord/. Under-counting here is the dangerous direction.
  // (The sibling is named by path in the plan body, not by a bare basename here: a bare
  // `'<name>.mjs'` literal in a scripts/coord/ test reads to select-battery-tests.mjs as a
  // self-dir sibling reference, and that module does not live in this directory.)
  const root = scratchTree({
    'surface/spawner.mjs': [
      'const HERE = dirname(fileURLToPath(import.meta.url));',
      "const STATUS_SCRIPT = join(HERE, 'constructed-one.mjs');",
      "execFileSync(process.execPath, [STATUS_SCRIPT, 'status']);",
    ].join('\n'),
  });
  try {
    const census = commandCensus([join(root, 'surface')], { repoRoot: root });
    assert.ok(census.has('constructed-one'), 'a constructed-path spawn is still an invocation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('commandCensus ignores a *.test.mjs fixture', () => {
  // The over-count direction: a command string inside a test fixture is not wiring, and counting
  // it makes a module look invoked on the strength of its own test.
  const root = scratchTree({
    'surface/real.sh': 'node scripts/really-invoked.mjs',
    'surface/thing.test.mjs': "assert.equal(run('node scripts/fixture-only.mjs'), 0);",
  });
  try {
    const census = commandCensus([join(root, 'surface')], { repoRoot: root });
    assert.ok(census.has('really-invoked'));
    assert.ok(!census.has('fixture-only'), 'a test fixture is not command wiring');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exportsEntry is not fooled by the word "export function main" in a comment or string', () => {
  const root = scratchTree({
    'commented.mjs': '// TODO: export function main() — not done yet\nfunction main() {}\n',
    'stringy.mjs': "const help = 'export function main(argv)';\nfunction main() {}\n",
  });
  try {
    assert.equal(exportsEntry(join(root, 'commented.mjs')), false, 'a comment is not an export');
    assert.equal(exportsEntry(join(root, 'stringy.mjs')), false, 'a string is not an export');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('walk surfaces an unreadable ROOT instead of reporting an empty tree', () => {
  // Swallowing every readdir error means a graph built over a path that does not exist reports
  // "0 modules, 0 edges" and every closure comes back empty — a measurement that looks like an
  // answer. A missing root is a caller bug and must say so; an unreadable SUBdirectory stays
  // tolerated (a transient lock under a live worktree must not fail a whole scan).
  //
  // "cannot stat", not "cannot read" (round-4 review T2 fallout): the (dev, ino) identity check
  // now runs BEFORE readdirSync, so a non-existent root fails there first — still a thrown error
  // naming the root, never a silent empty tree, which is the property this test pins.
  assert.throws(
    () => moduleFiles(join(tmpdir(), 'module-graph-does-not-exist-9d2f')),
    /module-graph: cannot stat/,
  );
});

// plan 3962 round-4 self-read: the (dev, ino) cycle identity has a failure mode of its own on a
// filesystem that reports NO usable inode — Node gives `ino: 0` on some Windows volumes and some
// network shares. Keyed naively, every directory would then share the identity `<dev>:0`, the
// visited set would match on the SECOND directory walked, and the walk would return almost
// nothing while still exiting success. That is strictly worse than the mount cycle the guard is
// for: a silent partial census is the exact shape this plan exists to stamp out, and a mount loop
// is not a realistic shape on an inode-less volume anyway. So identity falls back to the PATH
// there, and this test pins that a walk over such a filesystem still sees the WHOLE tree.
test('walk: a filesystem reporting no inode (ino 0) still walks the whole tree, never collapses', () => {
  const root = scratchTree({
    'a.mjs': 'export const a = 1;',
    'sub/b.mjs': 'export const b = 2;',
    'sub/deeper/c.mjs': 'export const c = 3;',
    'other/d.mjs': 'export const d = 4;',
  });
  try {
    const real = walk(root, (p) => p.endsWith('.mjs'));
    assert.equal(real.length, 4, 'the real filesystem walk sees every file');
    // Every directory reports the SAME (dev, ino) — the inode-less shape.
    const inolessStat = () => ({ dev: 7, ino: 0 });
    const inoless = walk(root, (p) => p.endsWith('.mjs'), [], {
      statSync: inolessStat,
    });
    assert.deepEqual(
      inoless,
      real,
      'an inode-less filesystem must walk the same tree, not collapse to the root',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// plan 3962 T3: `census --surface .` (REPO_ROOT as the surface) used to crash — `.claude/worktrees/
// <slug>` holds full nested checkouts of this repo, so walking into one from the main checkout
// multiplies an already large tree by however many plan worktrees are live. Fixed by name+parent
// (never `worktrees` alone, which would also skip an unrelated top-level `worktrees/` dir).
test('walk: does not descend into a nested .claude/worktrees/<slug> checkout (plan 3962)', () => {
  const root = scratchTree({
    'top.mjs': 'export const top = 1;\n',
    '.claude/worktrees/some-slug/backend/src/nested.mjs': 'export const nested = 1;\n',
  });
  try {
    const files = walk(root, (p) => p.endsWith('.mjs')).map((p) => p.slice(root.length + 1));
    assert.deepEqual(files, ['top.mjs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// plan 3962 round-2 review: a MAX_WALK_DEPTH backstop (and a test pinning it against a real
// symlink loop) lived here briefly, on the theory that a directory cycle could recurse `walk`
// forever. It was removed rather than hardened for symlinks/junctions specifically — see the long
// comment on `walk` in module-graph.mjs for the empirical finding: `readdirSync(dir,
// {withFileTypes:true})` classifies a symlink (or a Windows junction) as NOT a directory on every
// platform Node targets, so `walk`'s own recursion guard (`if (e.isDirectory())`) can never even
// consider descending into one — there is no route into a cycle for a depth cap to catch there, so
// that test (and the ambient "can this sandbox create a symlink" skip it carried, itself a
// rule-CLAUDE.md-flagged ambient-environment probe) was deleted along with the dead code it existed
// to exercise, rather than restructured to inject a condition that no longer had any behavior
// hanging off it.
//
// Round 3 found the route that survives: a genuine directory MOUNT (a Windows volume mounted into
// a folder, or a Linux bind mount — cloud drains run Linux) presents as an ORDINARY directory and
// can still cycle. Round 3 tried tracking each directory's REALPATH-resolved identity for the
// duration of one call; round 4 review found that wrong for exactly this case — `realpathSync`
// resolves a path by walking its own components, which never crosses to a bind mount's OTHER
// spelling of the same underlying directory, so a bind-mount loop gets a different canonical string
// at every level and the guard never fires. `walk` now identifies a directory by (dev, ino) FROM A
// STAT instead — two routes into the same underlying directory share that pair regardless of which
// mount got you there. Reproducing an actual mount cycle needs root/admin and is not portable, so
// this injects the `statSync` dependency instead: a mount cycle is, BY DEFINITION, two different
// nominal paths whose stat reports the same (dev, ino), so faking that report is a privilege-free,
// deterministic stand-in for the real thing — not a weaker test, the same property a real mount
// cycle would exhibit, asserted directly.
test('walk: a directory that resolves to an already-visited (dev, ino) identity is not re-descended', () => {
  const root = scratchTree({
    'top.mjs': 'export const top = 1;\n',
    'mnt/nested.mjs': 'export const nested = 1;\n',
  });
  try {
    // Every directory `walk` stats reports the SAME (dev, ino) — precisely what a mount cycle (a
    // directory mounted back onto one of its own ancestors) looks like. Unguarded, a real cycle
    // shaped like this recurses forever; unrolled to a normal three-entry fixture, the same fake
    // proves the guard fires at the very first repeat rather than only by accident of the fixture
    // being small.
    const fakeStat = () => ({ dev: 1, ino: 1 });
    const files = walk(root, (p) => p.endsWith('.mjs'), [], { statSync: fakeStat });
    // The root is visited once (top.mjs collected); `mnt/`, resolving to the identity already
    // visited, is never descended into — nested.mjs is never seen.
    assert.deepEqual(files, [join(root, 'top.mjs')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('walk: a real (non-cyclic) tree is unaffected by (dev, ino)-identity tracking', () => {
  // The default `statSync` reports a distinct `ino` for each of these real directories, so the
  // identity check never fires here — this pins that the cycle guard costs nothing on the ordinary
  // acyclic case every other `walk` test already exercises.
  const root = scratchTree({
    'a/one.mjs': 'export const one = 1;\n',
    'a/b/two.mjs': 'export const two = 1;\n',
    'a/b/c/three.mjs': 'export const three = 1;\n',
  });
  try {
    const files = walk(root, (p) => p.endsWith('.mjs')).map((p) => p.slice(root.length + 1));
    assert.deepEqual(
      files.sort(),
      [join('a', 'one.mjs'), join('a', 'b', 'two.mjs'), join('a', 'b', 'c', 'three.mjs')].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Plan 4114 (mirroring plan 3958): NTFS file ids on this checkout exceed 2^53, so the plain-Number
// `ino` the guard used to key on is ROUNDED, and two sibling directories created together (adjacent
// MFT indices) can round to the SAME number — the second one was then skipped as an
// already-visited cycle, one whole directory silently missing from the graph. `walk` must ask for
// the BigInt form; this fake answers exactly like NTFS does: two distinct 64-bit ids that collide
// once rounded to a double.
test('walk: sibling directories whose 64-bit inodes collide as doubles are both walked', () => {
  const root = scratchTree({
    'a/one.mjs': 'export const one = 1;\n',
    'b/two.mjs': 'export const two = 1;\n',
  });
  try {
    // ONE definition of the two ids, driving both the fake and the two assertions below. Spelling
    // the literals out a second time in the assertions would let a future edit change only the
    // fake: the collision assertion would stay green while the fixture no longer exercised inode
    // rounding at all, and the bug this test exists for could walk back in (gpt-review, plan 4114).
    const idA = 30680772461950726n;
    const idB = 30680772461950727n;
    // The fixture is only meaningful if the ids are DISTINCT as 64-bit values and IDENTICAL once
    // rounded to a double — that pair of properties is the whole bug, so assert both rather than
    // trusting the literals to keep them.
    assert.notEqual(idA, idB, 'the fixture ids are distinct as BigInts');
    assert.equal(Number(idA), Number(idB), 'the fixture ids do collide as doubles');
    const bigIds = new Map([
      [root, 1n],
      [join(root, 'a'), idA],
      [join(root, 'b'), idB],
    ]);
    const fakeStat = (p, opts) => {
      const big = bigIds.get(p) ?? 99n;
      return { dev: 7, ino: opts?.bigint ? big : Number(big) };
    };
    const files = walk(root, (p) => p.endsWith('.mjs'), [], { statSync: fakeStat }).map((p) =>
      p.slice(root.length + 1),
    );
    assert.deepEqual(files.sort(), [join('a', 'one.mjs'), join('b', 'two.mjs')].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Round-4 review: the old `realpathSync`-with-fallback shape silently continued into a directory
// it could not identify (a permissions error, a race with a deletion), which is precisely the
// "walk it anyway, unguarded" behavior a cycle guard must never fall back to. Decided: a failed
// identity read is refused the same way an unreadable directory already is, just below in
// `walkFrom` — the ROOT throws (a walk that cannot identify where it even starts is not a partial
// answer), a non-root directory is skipped without being descended into.
test('walk: a directory whose identity cannot be read is skipped, not walked unguarded', () => {
  const root = scratchTree({
    'top.mjs': 'export const top = 1;\n',
    'unreadable/nested.mjs': 'export const nested = 1;\n',
  });
  try {
    const unreadableAbs = join(root, 'unreadable');
    const fakeStat = (p) => {
      if (p === unreadableAbs) throw Object.assign(new Error('boom'), { code: 'EACCES' });
      return { dev: 1, ino: p === root ? 1 : 2 };
    };
    const files = walk(root, (p) => p.endsWith('.mjs'), [], { statSync: fakeStat });
    // top.mjs collected from the root; unreadable/ is skipped entirely — nested.mjs never seen, and
    // the walk of the REST of the tree still completes rather than aborting.
    assert.deepEqual(files, [join(root, 'top.mjs')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('walk: an unidentifiable ROOT throws instead of reporting an empty tree', () => {
  const root = scratchTree({ 'top.mjs': 'export const top = 1;\n' });
  try {
    const fakeStat = () => {
      throw Object.assign(new Error('boom'), { code: 'EACCES' });
    };
    assert.throws(
      () => walk(root, (p) => p.endsWith('.mjs'), [], { statSync: fakeStat }),
      /module-graph: cannot stat/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── gpt-review round 2 findings ───────────────────────────────────────────────────────────────

test('import-looking text inside a string or comment is not an edge', () => {
  const root = scratchTree({
    'scripts/m.mjs': [
      "import { real } from './real.mjs';",
      "const doc = `; import fake from './fake.mjs';`;",
      "// ; import commented from './commented.mjs';",
      "/* ; import blocked from './blocked.mjs'; */",
    ].join('\n'),
    'scripts/real.mjs': '',
    'scripts/fake.mjs': '',
    'scripts/commented.mjs': '',
    'scripts/blocked.mjs': '',
  });
  const scriptsDir = join(root, 'scripts');
  try {
    const g = buildGraph(scriptsDir);
    const imports = [...g.nodes.get(join(scriptsDir, 'm.mjs')).imports].map((p) => basename(p));
    assert.deepEqual(imports.sort(), ['real.mjs'], `got ${imports.join(', ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exportsEntry accepts an INDENTED top-level export and still rejects comment text', () => {
  const root = scratchTree({
    // Column-0 anchoring fixed the comment false positive but introduced this false negative.
    'indented.mjs': '  export function main() { return 0; }\n',
    'block-comment.mjs': '/**\n * export function main()\n */\nfunction main() {}\n',
    // Indented, which is how a template's content actually appears in this tree. Text at COLUMN 0
    // inside a template is a documented, unchased bound of exportsEntry — see its header for why
    // that trade beats trusting the mask alone (which mis-reports real files).
    'template.mjs': 'const help = `\n  export function main()\n`;\nfunction main() {}\n',
  });
  try {
    assert.equal(exportsEntry(join(root, 'indented.mjs')), true, 'indented export missed');
    assert.equal(exportsEntry(join(root, 'block-comment.mjs')), false, 'block comment counted');
    assert.equal(exportsEntry(join(root, 'template.mjs')), false, 'template literal counted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the constructed-path census arm requires an actual execution site', () => {
  const root = scratchTree({
    // A join() that merely builds a data path is NOT a command invocation.
    'surface/reads-a-file.mjs': "const p = join(HERE, 'not-a-command.mjs');\nreadFileSync(p);\n",
    // A join() feeding a spawn IS — including one nesting another call before the literal,
    // which the first version of this arm could not match because it excluded ')'.
    'surface/spawns.mjs': [
      "const S = join(dirname(fileURLToPath(import.meta.url)), 'really-spawned.mjs');",
      'execFileSync(process.execPath, [S, "status"]);',
    ].join('\n'),
  });
  try {
    const census = commandCensus([join(root, 'surface')], { repoRoot: root });
    assert.ok(census.has('really-spawned'), 'a nested-call join feeding a spawn must be seen');
    assert.ok(!census.has('not-a-command'), 'a join with no spawn in the file is not a command');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('commandCensus skips a MISSING surface but surfaces an unreadable one', () => {
  const root = scratchTree({ 'surface/a.sh': 'node scripts/one.mjs' });
  try {
    // An optional surface (.claude/settings.local.json is not always present) stays skippable…
    const census = commandCensus([join(root, 'surface'), join(root, 'nope')], { repoRoot: root });
    assert.ok(census.has('one'));
    // …but a surface that exists and cannot be walked is a real error, not an empty result.
    //
    // The ERRNO is the environment here, so it is a PARAMETER, not an assumption (plan 4026,
    // fix-now on a red Windows battery that blocked an unrelated land). A path UNDER a regular
    // file is ENOTDIR on POSIX — the branch this case is for — but ENOENT on Windows, where the
    // OS cannot tell it from a path that simply is not there. `commandCensus` treats ENOENT as
    // the optional-surface skip by contract, so hardcoding the throw asserted a property of the
    // developer's operating system: green on every Linux cloud drain, red on every local push.
    // Ask the platform what it actually reports for this shape, then assert the contract for
    // that answer — both arms are the documented behaviour, neither is a waiver.
    const badSurface = join(root, 'surface', 'a.sh', 'inside-a-file');
    let errno;
    try {
      statSync(badSurface);
    } catch (e) {
      errno = e.code;
    }
    assert.ok(errno, 'the fixture must fail to stat, or it is not exercising this branch at all');
    if (errno === 'ENOENT') {
      // Indistinguishable from a missing optional surface (Windows): skipped, census unchanged.
      const after = commandCensus([join(root, 'surface'), badSurface], { repoRoot: root });
      assert.deepEqual([...after].sort(), [...census].sort());
    } else {
      assert.throws(
        () => commandCensus([badSurface], { repoRoot: root }),
        /module-graph: cannot read/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('commandCensus ignores fixture DIRECTORIES, not just *.test.mjs filenames', () => {
  const root = scratchTree({
    'surface/real.sh': 'node scripts/genuine.mjs',
    'surface/fixtures/golden.txt': 'node scripts/fixture-dir-only.mjs',
    'surface/__tests__/case.sh': 'node scripts/tests-dir-only.mjs',
  });
  try {
    const census = commandCensus([join(root, 'surface')], { repoRoot: root });
    assert.ok(census.has('genuine'));
    assert.ok(!census.has('fixture-dir-only'), 'fixtures/ is not wiring');
    assert.ok(!census.has('tests-dir-only'), '__tests__/ is not wiring');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── gpt-review round 3 findings ───────────────────────────────────────────────────────────────

test('stripJs lexes regex literals, so an unbalanced quote inside one cannot corrupt the mask', () => {
  // The highest-consequence round-3 finding, verified before fixing: `/won't/` opened string
  // state at the apostrophe and swallowed everything to the next quote — losing a real import
  // edge and a real export, and (worst) able to hide a CLI main-guard, which leaves a live
  // command unsplit.
  const root = scratchTree({
    'scripts/m.mjs': [
      String.raw`const apostrophe = /won't/;`,
      "import { real } from './real.mjs';",
      'export function main() { return 0; }',
      'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();',
    ].join('\n'),
    'scripts/real.mjs': '',
  });
  const scriptsDir = join(root, 'scripts');
  const f = join(scriptsDir, 'm.mjs');
  try {
    assert.equal(exportsEntry(f), true, 'export hidden by a regex literal');
    assert.equal(guardKind(f), 'import-meta', 'CLI guard hidden by a regex literal');
    assert.deepEqual(
      specifiersOf(f).filter((s) => s.startsWith('.')),
      ['./real.mjs'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stripJs handles a nested template literal and scans its ${…} code', () => {
  const root = scratchTree({
    'nested.mjs': [
      'const inner = `a`;',
      'const outer = `x ${ `y ${inner}` } z`;',
      'export function main() { return 0; }',
    ].join('\n'),
    // A guard that lives INSIDE a template's interpolation is still code.
    'interp.mjs': 'const s = `${process.argv[1] && import.meta.url}`;\n',
  });
  try {
    assert.equal(exportsEntry(join(root, 'nested.mjs')), true, 'nested template desynced the mask');
    assert.equal(guardKind(join(root, 'interp.mjs')), 'import-meta');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a division operator is not mistaken for a regex literal', () => {
  // The other side of regex lexing: `/` after a value is division, and treating it as a regex
  // start would swallow the rest of the file.
  const root = scratchTree({
    'div.mjs': ['const ratio = total / count;', 'export function main() { return 0; }'].join('\n'),
  });
  try {
    assert.equal(exportsEntry(join(root, 'div.mjs')), true, 'division read as a regex literal');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the spawn gate recognises a promisified / aliased child-process call', () => {
  const root = scratchTree({
    'surface/promisified.mjs': [
      'const execFileAsync = promisify(execFile);',
      "const S = join(HERE, 'via-promisify.mjs');",
      'await execFileAsync(process.execPath, [S]);',
    ].join('\n'),
  });
  try {
    const census = commandCensus([join(root, 'surface')], { repoRoot: root });
    assert.ok(census.has('via-promisify'), 'a promisified spawn is still a spawn');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The invariant plan 4061 actually lands, asserted against the real tree rather than a fixture:
// after this plan, no module in `scripts/` carries the basename `endsWith` guard form, because it
// double-fires once coord-core step 4 puts a shim at the same invoked path.
test('no scripts/ module still uses the basename endsWith guard form', () => {
  const offenders = moduleFiles(SCRIPTS_DIR).filter((f) => guardKind(f) === 'endsWith');
  assert.deepEqual(
    offenders.map((f) => f.slice(SCRIPTS_DIR.length + 1)),
    [],
    'use `import.meta.url === pathToFileURL(process.argv[1]).href` — the basename form fires in ' +
      'both the moved module and its shim (plan 4061)',
  );
});

// The other half of plan 4061's acceptance, likewise asserted against the real tree — and scoped
// to exactly what this plan delivers: coord-core STEP 4's move closure, not the whole `scripts/`
// tree. The tree at large still holds ~88 guarded, invoked commands that export no entry point;
// splitting those is not this plan's scope and asserting it here would be a standing red.
test('every guarded, invoked command in step 4 move closure exports an entry point', () => {
  const graph = buildGraph();
  // A seed row names where the module was WHEN THE TABLE WAS WRITTEN, plus the destination the
  // move takes it to. Once plan 3962's Phase 2 has actually moved it, the origin path holds a
  // three-line shim (or nothing at all) and the real module is at the destination — so resolve
  // each row to whichever of the two the graph currently carries, preferring the destination.
  // Pinning the origin path made this test assert the PRE-move tree, which is the one state the
  // program it guards is guaranteed to leave behind.
  const seeds = SEEDS.map((row) => {
    const name = row.module.replace(/^scripts\//, '');
    const moved = join(SCRIPTS_DIR, row.destination.replace(/^scripts\//, ''), name);
    const origin = join(SCRIPTS_DIR, name);
    if (graph.nodes.has(moved)) return moved;
    if (graph.nodes.has(origin)) return origin;
    // plan 3958: a scripts/project/-destined row naming a file at NEITHER path is tolerated
    // only when the destination is project/ — the public coord-kit ships no scripts/project/
    // tree at all (vetapp's own gate/plugin logic), so a genuinely project-only module this
    // migration table tracks (e.g. account-registry.mjs, vetapp's account-fleet registry) is
    // correctly absent there. A scripts/coord/-destined (core) row missing at both paths is
    // still a hard failure — that would be a real gap in the shipped core closure.
    assert.equal(
      row.destination,
      'scripts/project/',
      `coord-core-move-seeds.json names a core module that is at neither ${origin} nor ${moved}`,
    );
    return null;
  }).filter(Boolean);
  const census = commandCensus(
    ['.claude', '.husky', 'coord', 'docs/runbooks', 'CLAUDE.md', 'scripts', '.github'],
    { excludeDirs: ['docs/superpowers/plans', 'docs/handoff'] },
  );
  const missing = [];
  for (const f of closure(seeds, graph)) {
    if (!hasCliGuard(f)) continue;
    // `sep`, not a hardcoded '/': these are absolute OS paths, so on Windows — where the pre-push
    // battery runs — lastIndexOf('/') is -1 and the "name" becomes the whole path, matching
    // nothing in the census and silently asserting over an EMPTY set (gpt-review round 1).
    const name = basename(f, '.mjs');
    if (!census.has(name)) continue;
    if (!exportsEntry(f)) missing.push(name);
  }
  assert.deepEqual(missing.sort(), [], 'add `export` to the entry point (plan 4061 T2)');
});
