// Unit tests for the scripts/ self-containment gate (plan 2622).
//
// Growth-valve warrant (vetapp CLAUDE.md § new-test-FILE rule): this is the name-pair of a
// genuinely new module, scripts/assert-scripts-self-contained.mjs.
//
// Two layers: the pure classifier (findViolationsInSource — no fs, no git) against crafted
// sources, and the fs-level pieces (collectScannedFiles / scanTree) against a small synthetic
// scripts tree in a tmpdir. Run by `node --test scripts/*.test.mjs` (pre-push + CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeIsolatedRepo } from './test-helpers/isolated-plan-repo.mjs';
import {
  findViolationsInSource,
  collectScannedFiles,
  scanTree,
  rangesTouchScripts,
  COORD_BARE_IMPORT_ALLOWLIST,
  findDeadScriptsImports,
  collectOutsideTrackedFiles,
  scanOutsideTree,
  OutsideTreeUnavailableError,
  isCopiedFile,
} from './assert-scripts-self-contained.mjs';

// A file living directly in the (fake) scripts dir, so `./x` is a sibling and `../x` escapes.
const SCRIPTS = join('/repo', 'scripts');
const TOOL = join(SCRIPTS, 'tool.mjs');
const classify = (src, file = TOOL) => findViolationsInSource(src, file, SCRIPTS);
// A file living in the (fake) scripts/coord/ dir, for Rule 3.
const COORD_TOOL = join(SCRIPTS, 'coord', 'tool.mjs');
const classifyCoord = (src, file = COORD_TOOL) => findViolationsInSource(src, file, SCRIPTS);

// ── the legal shapes are silent ─────────────────────────────────────────────
test('node: builtins and bare package specifiers are ignored', () => {
  const src = [
    "import { readFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    "import { z } from 'zod';",
    "import assert from 'node:assert/strict';",
  ].join('\n');
  assert.deepEqual(classify(src), []);
});

test('a scripts sibling and a nested ./lib/ import are legal', () => {
  const src = [
    "import { git } from './coord-git.mjs';",
    "import { renderInline } from './lib/decision-dossier/inline.mjs';",
    "export { thing } from './stamp-lib.mjs';",
  ].join('\n');
  assert.deepEqual(classify(src), []);
});

test('a nested module importing back up to a flat scripts sibling is legal', () => {
  const nested = join(SCRIPTS, 'lib', 'decision-dossier', 'inline.mjs');
  assert.deepEqual(classify("import { x } from '../../coord-git.mjs';", nested), []);
});

// ── each escaping specifier form is caught ──────────────────────────────────
test('catches an escaping `from` import (the write-lint-common.mjs shape)', () => {
  const v = classify("import { readStdin } from '../shared/seed-io.mjs';");
  assert.deepEqual(v, [{ specifier: '../shared/seed-io.mjs', kind: 'escapes-scripts' }]);
});

test('catches a bare side-effect import', () => {
  const v = classify("import '../shared/src/register.mjs';");
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'escapes-scripts');
});

test('catches `export … from`', () => {
  const v = classify("export { helper } from '../backend/src/thing.mjs';");
  assert.equal(v.length, 1);
  assert.equal(v[0].specifier, '../backend/src/thing.mjs');
});

test('catches dynamic import(), awaited or not', () => {
  const v = classify(
    ["const a = await import('../shared/one.mjs');", "import('../shared/two.mjs');"].join('\n'),
  );
  assert.deepEqual(
    v.map((x) => x.specifier),
    ['../shared/one.mjs', '../shared/two.mjs'],
  );
});

test('a deep escape that walks back down elsewhere is still an escape', () => {
  const nested = join(SCRIPTS, 'lib', 'thing.mjs');
  const v = classify("import { x } from '../../shared/src/seed-io.ts';", nested);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'escapes-scripts');
});

// ── round-3 review T2: the containment check is a proper prefix test, not a string guess ────
test('a real directory merely BEGINNING with two dots is not an escape', () => {
  // `relative(scriptsDir, abs)` for `./..cache/x.mjs` is the literal string `..cache/x.mjs` —
  // it STARTS WITH the two characters '..' but is not the '..' walk-up token. The old
  // `rel.startsWith('..')` test could not tell those apart and rejected a perfectly legal
  // sibling directory whose name happens to begin with a dot-dot.
  assert.deepEqual(classify("import { x } from './..cache/tool.mjs';"), []);
});

test('a specifier resolving to the BARE parent of scripts/ (rel === "..") is still an escape', () => {
  // escapesScriptsDir has two arms — `rel === '..'` (the exact bare-parent case) and
  // `rel.startsWith('..' + sep)` (the walk-further-up case the test above pins) — and a
  // specifier of exactly '..' only exercises the first. Both must fire.
  const v = classify("import x from '..';");
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'escapes-scripts');
});

// ── round-3 review T3: a template-literal specifier is a specifier too ──────────────────────
test('a template-literal dynamic import() is treated exactly like a quoted one', () => {
  const v = classify('const a = await import(`../shared/one.mjs`);');
  assert.deepEqual(v, [{ specifier: '../shared/one.mjs', kind: 'escapes-scripts' }]);
});

test('a legal template-literal specifier stays silent', () => {
  assert.deepEqual(classify('import(`./coord-git.mjs`);'), []);
});

test('an INTERPOLATED template-literal specifier is ignored, not guessed at or flagged', () => {
  // `./${name}.mjs` is not statically knowable — this round's decision is to ignore it rather
  // than report a possibly-false violation, the same way a string-concatenated specifier
  // (`'./' + f`) already falls outside this regex's reach today.
  assert.deepEqual(classify('const name = "shared/x"; import(`../${name}.mjs`);'), []);
});

// ── the test-helpers/ shape is caught, and reported as its own kind ─────────
test('catches a ./test-helpers/ import from a non-test tool', () => {
  const v = classify("import { makeIsolatedRepo } from './test-helpers/isolated-plan-repo.mjs';");
  assert.deepEqual(v, [
    { specifier: './test-helpers/isolated-plan-repo.mjs', kind: 'test-helpers' },
  ]);
});

test('catches test-helpers/ reached from a nested module too', () => {
  const nested = join(SCRIPTS, 'lib', 'thing.mjs');
  const v = classify("import { x } from '../test-helpers/tracked-tmpdir.mjs';", nested);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'test-helpers');
});

test('catches a MIS-CASED test-helpers/ import — Windows resolves it, the scaffold does not', () => {
  // On a case-insensitive filesystem `./Test-Helpers/…` loads fine locally, so an exact-case
  // check waves it through; the scaffold then skips the dir by its lowercase name and the
  // copied tool dies with ERR_MODULE_NOT_FOUND in the temp repo (review finding).
  const v = classify("import { x } from './Test-Helpers/tracked-tmpdir.mjs';");
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'test-helpers');
});

// ── the reverse direction (hooks → scripts) is not this guard's business ────
test('a hook importing ../../scripts/x.mjs is not flagged (hooks are never scanned)', () => {
  // The guard only ever scans files under scripts/; classify a hook's own source to
  // confirm the rule is directional — from .claude/hooks/, ../../scripts/x resolves
  // INSIDE scripts/, so even if such a file were handed in it is legal.
  const hook = join('/repo', 'scripts', 'hooks', 'wiki-loader.mjs');
  assert.deepEqual(
    classify("import { readStdin } from '../../scripts/coord/stdin-read.mjs';", hook),
    [],
  );
});

// ── a specifier is reported once, however many times it appears ─────────────
test('a repeated bad specifier is reported once', () => {
  const v = classify(
    ["import { a } from '../shared/x.mjs';", "const { b } = await import('../shared/x.mjs');"].join(
      '\n',
    ),
  );
  assert.equal(v.length, 1);
});

// ── comments are not code (review finding: this guard has no allowlist) ─────
test('an illegal import quoted inside a // comment is not a violation', () => {
  const src = [
    "// never do this: import { x } from '../shared/foo.mjs'",
    "import { git } from './coord-git.mjs';",
  ].join('\n');
  assert.deepEqual(classify(src), []);
});

test('an illegal import quoted inside a /* block */ comment is not a violation', () => {
  const src = "/* bad:\n   import y from '../backend/y.mjs';\n*/\nexport const a = 1;\n";
  assert.deepEqual(classify(src), []);
});

test('a `//` inside a string literal does not start a comment and hide a later import', () => {
  const src = ["const u = 'https://example.test';", "import { x } from '../shared/x.mjs';"].join(
    '\n',
  );
  assert.equal(classify(src).length, 1);
});

// ── a specifier-SHAPED fragment inside a STRING is not an import (plan 3962 Phase 2) ──────

test('a `from "…"` fragment inside a template literal is not a specifier', () => {
  // The live shape that blocked plan 3962's Phase 2 the moment coord-refs.mjs moved under
  // scripts/coord/: an error message reading `cannot derive a plan id from "${idOrName}"`.
  // Comments are blanked but string CONTENTS are kept (so real specifiers stay readable), so
  // without the position cross-check this reads as a bare import of `${idOrName}` and Rule 3
  // rejects it as a non-allow-listed bare package — blocking every scripts-touching push.
  const src = [
    "import { join } from 'node:path';",
    'function idOf(idOrName) {',
    '  throw new Error(`cannot derive a plan id from "${idOrName}"`);',
    '}',
  ].join('\n');
  assert.deepEqual(classify(src, COORD_TOOL), []);
});

test('a single-quoted string quoting an illegal import is not a specifier', () => {
  const src = `const advice = 'never write: import x from "../shared/foo.mjs"';`;
  assert.deepEqual(classify(src, COORD_TOOL), []);
  assert.deepEqual(classify(src, TOOL), []);
});

test('the position cross-check does not hide a REAL specifier on a line that also holds a string', () => {
  // The guard must narrow only what it should: a genuine escaping import still fires even when
  // the same file carries specifier-shaped prose.
  const src = [
    `const advice = 'never: import x from "../shared/foo.mjs"';`,
    "import { y } from '../../shared/real.mjs';",
  ].join('\n');
  const v = classify(src, TOOL);
  assert.equal(v.length, 1);
  assert.equal(v[0].specifier, '../../shared/real.mjs');
  assert.equal(v[0].kind, 'escapes-scripts');
});

// ── Rule 3 (plan 3959): scripts/coord/ may import only scripts/coord/** + node: ─────────────
test('a coord module importing a coord sibling and node: builtins is legal', () => {
  const src = [
    "import { readFileSync } from 'node:fs';",
    "import { x } from './other-coord-module.mjs';",
  ].join('\n');
  assert.deepEqual(classifyCoord(src), []);
});

test('a coord module reaching back into plain scripts/ is a Rule 3 violation, not Rule 1', () => {
  // Legal under Rule 1 (never escapes scripts/ at all) — illegal under Rule 3 (escapes
  // scripts/coord/, which is the whole point of the split).
  const v = classifyCoord("import { SEAM } from '../done-worktree-lib.mjs';");
  assert.deepEqual(v, [{ specifier: '../done-worktree-lib.mjs', kind: 'coord-boundary' }]);
});

test('a coord module reaching into scripts/project/ is also a Rule 3 violation', () => {
  const v = classifyCoord("import { PROD_DEPLOY_SERVICES } from '../project/deploy.mjs';");
  assert.deepEqual(v, [{ specifier: '../project/deploy.mjs', kind: 'coord-boundary' }]);
});

test('a coord module escaping scripts/ entirely is still Rule 1, not Rule 3', () => {
  const v = classifyCoord("import { x } from '../../shared/src/schemas.ts';");
  assert.deepEqual(v, [{ specifier: '../../shared/src/schemas.ts', kind: 'escapes-scripts' }]);
});

test('a bare package specifier from a coord module is illegal unless allow-listed', () => {
  const v = classifyCoord("import { z } from 'zod';");
  assert.deepEqual(v, [{ specifier: 'zod', kind: 'coord-bare-import' }]);
});

test('COORD_BARE_IMPORT_ALLOWLIST starts empty — nothing to grandfather', () => {
  assert.deepEqual(Object.keys(COORD_BARE_IMPORT_ALLOWLIST), []);
});

// plan 3959 review (21869e/da442b/c749d4/edf62b/cc0dcc/21c9cb — one root cause, six finders):
// membership in the allow-list was tested with `key in obj`, which walks the PROTOTYPE CHAIN. An
// EMPTY `{}` still "contains" every Object.prototype name, so `import x from 'constructor'` was
// admitted by a gate whose whole contract is "the allow-list starts empty". Own-key membership is
// the only correct test here — the allow-list is a data table, not a namespace to inherit from.
test('an inherited Object.prototype name is NOT on the empty allow-list (own-key membership)', () => {
  for (const inherited of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.deepEqual(
      classifyCoord(`import x from '${inherited}';`),
      [{ specifier: inherited, kind: 'coord-bare-import' }],
      `bare '${inherited}' must be a Rule 3 violation — the allow-list is empty`,
    );
  }
});

// Same review, same line: `spec.startsWith('node:')` admitted ANY `node:`-prefixed string, so a
// typo'd builtin passed the boundary gate and then failed at module load in the extracted coord
// checkout — exactly the failure Rule 3 exists to catch before extraction, not after.
test('a non-existent node: specifier is a Rule 3 violation, not a free pass', () => {
  assert.deepEqual(classifyCoord("import x from 'node:fs/promisesx';"), [
    { specifier: 'node:fs/promisesx', kind: 'coord-bare-import' },
  ]);
  assert.deepEqual(classifyCoord("import x from 'node:nope';"), [
    { specifier: 'node:nope', kind: 'coord-bare-import' },
  ]);
});

// plan 3959 review round 2 (118a2d): `isBuiltin` alone is broader than the rule — `isBuiltin('fs')`
// is true, so swapping the prefix test for a bare builtin check would have started ADMITTING the
// un-prefixed spelling the rule has never allowed. Rule 3 wants the conjunction: `node:`-prefixed
// AND a real builtin. Pinned in both directions so neither half can be dropped again.
test('a BARE builtin spelling (no node: prefix) is still a Rule 3 violation', () => {
  for (const bare of ['fs', 'path', 'assert', 'test']) {
    assert.deepEqual(
      classifyCoord(`import x from '${bare}';`),
      [{ specifier: bare, kind: 'coord-bare-import' }],
      `bare '${bare}' must stay a Rule 3 violation — only the node: spelling is legal`,
    );
  }
});

test('real node: builtins (bare and subpath) stay legal from a coord module', () => {
  const src = [
    "import { readFileSync } from 'node:fs';",
    "import { readFile } from 'node:fs/promises';",
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
  ].join('\n');
  assert.deepEqual(classifyCoord(src), []);
});

test('a non-coord module reaching a coord sibling is unaffected by Rule 3 (Rule 1 still governs)', () => {
  // scripts/project/deploy.mjs importing scripts/coord/x.mjs never escapes scripts/, and Rule 3
  // only binds a module INSIDE scripts/coord/ — the direction is one-way by construction.
  const projectTool = join(SCRIPTS, 'project', 'deploy.mjs');
  assert.deepEqual(classify("import { x } from '../coord/x.mjs';", projectTool), []);
});

// ── fs layer: which files get scanned, and end-to-end on a synthetic tree ───
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'selfcontained-'));
  const scripts = join(root, 'scripts');
  mkdirSync(join(scripts, 'lib'), { recursive: true });
  mkdirSync(join(scripts, 'test-helpers'), { recursive: true });
  writeFileSync(join(scripts, 'clean-tool.mjs'), "import { git } from './coord-git.mjs';\n");
  writeFileSync(join(scripts, 'coord-git.mjs'), "import { x } from 'node:fs';\n");
  writeFileSync(join(scripts, 'lib', 'nested.mjs'), "import { y } from '../coord-git.mjs';\n");
  // Never scanned: a test file, and everything under test-helpers/ — both import out freely.
  writeFileSync(
    join(scripts, 'clean-tool.test.mjs'),
    "import { h } from '../shared/seed-io.mjs';\n",
  );
  writeFileSync(
    join(scripts, 'test-helpers', 'helper.mjs'),
    "import { h } from '../../shared/seed-io.mjs';\n",
  );
  return { root, scripts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('collectScannedFiles skips *.test.mjs and the whole test-helpers/ dir', () => {
  const t = makeTree();
  try {
    const names = collectScannedFiles(t.scripts).map((p) => p.slice(t.scripts.length + 1));
    assert.deepEqual(
      names.sort(),
      ['clean-tool.mjs', 'coord-git.mjs', join('lib', 'nested.mjs')].sort(),
    );
  } finally {
    t.cleanup();
  }
});

test('a clean synthetic tree scans clean, and one bad import turns it red', () => {
  const t = makeTree();
  try {
    assert.deepEqual(scanTree(t.scripts, t.root), []);
    writeFileSync(
      join(t.scripts, 'lib', 'nested.mjs'),
      "import { h } from '../../shared/seed-io.mjs';\n",
    );
    const v = scanTree(t.scripts, t.root);
    assert.equal(v.length, 1);
    assert.equal(v[0].kind, 'escapes-scripts');
    // Repo-relative, forward slashes, on every platform.
    assert.equal(v[0].file, 'scripts/lib/nested.mjs');
  } finally {
    t.cleanup();
  }
});

test('scanTree: Rule 3 fires end-to-end on a coord module reaching outside scripts/coord/', () => {
  const t = makeTree();
  try {
    mkdirSync(join(t.scripts, 'coord'), { recursive: true });
    writeFileSync(join(t.scripts, 'coord', 'ok.mjs'), "import { x } from './other.mjs';\n");
    writeFileSync(join(t.scripts, 'coord', 'other.mjs'), "import { y } from 'node:fs';\n");
    assert.deepEqual(scanTree(t.scripts, t.root), []);
    writeFileSync(join(t.scripts, 'coord', 'ok.mjs'), "import { x } from '../coord-git.mjs';\n");
    const v = scanTree(t.scripts, t.root);
    assert.equal(v.length, 1);
    assert.equal(v[0].kind, 'coord-boundary');
    assert.equal(v[0].file, 'scripts/coord/ok.mjs');
  } finally {
    t.cleanup();
  }
});

// ── the REAL tree is the acceptance criterion: it must be at zero violations ─
test('the real scripts/ tree is self-contained', () => {
  assert.deepEqual(scanTree(), []);
});

// ── the scaffold half of the invariant (plan 2622 task 2) ───────────────────
// The guard permits `./lib/…` imports; the isolated-repo scaffold must therefore COPY
// nested non-test dirs, or those two existing importers (batches-view.mjs,
// build-unblock-lane-dossier.mjs) break in the temp repo exactly like an escaping import.
// This asserts the two halves agree, by importing a COPIED tool whose chain reaches
// `./lib/decision-dossier/inline.mjs` — the ERR_MODULE_NOT_FOUND this file exists to
// prevent would surface right here.
// plan 3958: the original version of this test named scripts/batches-view.mjs (a copied TOOL)
// importing scripts/lib/decision-dossier/inline.mjs (a nested ./lib/ module with a sibling
// template.html asset and a paired inline.test.mjs) — but batches-view.mjs no longer imports
// that module (escapeHtml moved to scripts/coord/html-escape.mjs; its only real importer today,
// build-unblock-lane-dossier.mjs, is not in the coord-kit manifest and is never shipped), and no
// other shipped scripts/*.mjs command imports a nested scripts/lib/** subdirectory — the
// decision-dossier tree itself is not shipped either. Retargeted at a shipped HOOK
// (coord-write-guard-pretooluse.mjs) importing its own nested scripts/hooks/lib/loader-common.mjs
// (also shipped) for the "nested dir travels with a copied file, test-helpers/ stays excluded"
// half of the invariant; the "a sibling non-test asset is copied, a .test.mjs sibling is not"
// half moves to the two direct isCopiedFile() unit tests below, since loader-common.mjs has no
// real sibling asset or paired test file to probe against — isCopiedFile is the exact (and only)
// predicate copyScriptsTree's recursion consults for that decision, so testing it directly is
// equally faithful to the property and does not depend on which real files happen to exist.
test('a copied tool importing a nested ./lib/… resolves inside the isolated repo', async () => {
  const repo = makeIsolatedRepo({
    prefix: 'selfcontained-scaffold',
    basename: '9999-Other-probe.md',
    body: '# Probe\n',
  });
  try {
    const copied = join(repo.scriptsDir, 'hooks', 'coord-write-guard-pretooluse.mjs');
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(copied).href)});`],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `import of the copied tool failed:\n${r.stderr}`);
    // test-helpers/ stays uncopied — the other half of the same decision.
    assert.equal(existsSync(join(repo.scriptsDir, 'test-helpers')), false);
    assert.equal(existsSync(join(repo.scriptsDir, 'hooks', 'lib', 'loader-common.mjs')), true);
  } finally {
    repo.cleanup();
  }
});

test("isCopiedFile: a nested module's sibling non-test asset is copied (review finding)", () => {
  // A nested module's sibling ASSETS travel with it: a real example (decision-dossier's
  // inline.mjs reading template.html from its own dirname at runtime) motivated this rule, but
  // isCopiedFile is the one, generic predicate copyScriptsTree's recursion consults for every
  // file regardless of extension — an .mjs-only copy would ENOENT a copied tool exactly the way
  // an escaping import kills it, and the guard (which scans import specifiers only) could never
  // see that one.
  assert.equal(isCopiedFile('template.html'), true);
  assert.equal(isCopiedFile('inline.mjs'), true);
});

test('isCopiedFile: a .test.mjs sibling is never copied', () => {
  assert.equal(isCopiedFile('inline.test.mjs'), false);
});

// ── diff-scoping: ranges only ever decide whether to scan at all ────────────
test('rangesTouchScripts: no ranges (manual run) → scan', () => {
  assert.equal(rangesTouchScripts([]), true);
});

test('rangesTouchScripts: a range with no scripts/ paths → skip', () => {
  assert.equal(rangesTouchScripts(['a..b'], '/repo', { _git: () => '\n' }), false);
});

test('rangesTouchScripts: any range touching scripts/ → scan', () => {
  const _git = (_root, args) => (args.includes('b..c') ? 'scripts/tool.mjs\n' : '');
  assert.equal(rangesTouchScripts(['a..b', 'b..c'], '/repo', { _git }), true);
});

test('rangesTouchScripts: a git failure falls through to scanning, never a silent skip', () => {
  const _git = () => {
    throw new Error('fatal: bad revision');
  };
  assert.equal(rangesTouchScripts(['a..b'], '/repo', { _git }), true);
});

// ── Rule 2: the CLI entry guard must compare URL to URL (plan 1555) ─────────
//
// Four modules shipped `import.meta.url === ` + a hand-built file:// URL from
// process.argv[1]. On Windows argv[1] is `C:\…` with backslashes and import.meta.url is
// `file:///C:/…`, so the two never match, main() is never called, and the tool prints
// nothing and exits 0 — indistinguishable from a clean pass. Two of the four were LIVE
// pre-push gates that had consequently never fired on a Windows session. The shape is
// built here from fragments so this test file is not itself a violation of the rule it
// pins (the scanner keeps string contents, so a spelled-out literal would trip it).
const BAD_GUARD = 'if (import.meta.url === `file://' + '${process.argv[1]}`) main();';

test('catches a hand-built file:// CLI entry guard', () => {
  const v = classify(BAD_GUARD);
  assert.deepEqual(
    v.map((x) => x.kind),
    ['hand-built-entry-url'],
  );
});

test('the pathToFileURL form is legal — that is the fix, and 84 scripts already use it', () => {
  assert.deepEqual(
    classify(
      'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();',
    ),
    [],
  );
});

test('the reverse fileURLToPath comparison is legal too (both sides native paths)', () => {
  assert.deepEqual(
    classify('if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();'),
    [],
  );
});

test('the CONCATENATION spelling is caught too — the rule is the shape, not the syntax', () => {
  // The first cut of this rule matched one exact template literal, so this — the same bug,
  // one keystroke apart — walked straight through it (review finding, six independent votes).
  const concat = 'if (import.meta.url === ' + "'file://'" + ' + process.argv[1]) main();';
  assert.deepEqual(
    classify(concat).map((x) => x.kind),
    ['hand-built-entry-url'],
  );
});

test('the comparison is caught in either operand order', () => {
  const reversed = "if ('file://' + process.argv[1] === import.meta.url) main();";
  assert.deepEqual(
    classify(reversed).map((x) => x.kind),
    ['hand-built-entry-url'],
  );
});

test('a URL built into a variable and compared on the next line is caught', () => {
  // The comparison scan stops at `;`, so the two halves of a split guard never land in one
  // match; the construction scan is what covers this, gated on the file mentioning
  // import.meta.url at all.
  const split =
    'const self = `file://' + '${process.argv[1]}`;\nif (import.meta.url === self) main();';
  assert.deepEqual(
    classify(split).map((x) => x.kind),
    ['hand-built-entry-url'],
  );
});

test('the same text in a module that never compares import.meta.url is NOT a violation', () => {
  // This scanner keeps string contents on purpose (Rule 1 needs the specifiers readable), so
  // an unconditional text match makes any file quoting the shape — a help string, a fixture,
  // this rule's own error text — its own violation. It did exactly that on the first run.
  const data = 'export const EXAMPLE = `file://' + '${process.argv[1]}`;';
  assert.deepEqual(classify(data), []);
});

test('a prettier-wrapped multi-line pathToFileURL guard is still legal', () => {
  // Matching runs on a whitespace-collapsed copy, so line breaks inside the guard cannot
  // hide the conversion call and turn the correct form into a false positive.
  const wrapped =
    'if (\n  process.argv[1] &&\n  import.meta.url === pathToFileURL(process.argv[1]).href\n) {\n  main();\n}';
  assert.deepEqual(classify(wrapped), []);
});

test('a COMMENT quoting the banned shape is not a violation', () => {
  // Otherwise the fixed modules could not explain in prose why they were fixed, and this
  // gate would block every scripts-touching push on its own documentation.
  assert.deepEqual(classify('// never write ' + BAD_GUARD), []);
});

test('the whole scripts tree is at zero entry-guard violations', () => {
  const offenders = scanTree()
    .filter((v) => v.kind === 'hand-built-entry-url')
    .map((v) => v.file);
  assert.deepEqual(offenders, []);
});

// ── Rule 4 (plan 3962 Phase 2 fallout): outside → scripts/ imports must resolve to a real file ──
// A synthetic {root}/scripts/coord/kill-tree.mjs (real, on disk) plus an outside consumer at
// {root}/frontend/scripts/tool.mjs — the exact shape of the live break (frontend/scripts/*.mjs
// importing a pre-move flat scripts/ path).
function makeRule4Fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dead-scripts-import-'));
  const scriptsDir = join(root, 'scripts');
  mkdirSync(join(scriptsDir, 'coord'), { recursive: true });
  writeFileSync(join(scriptsDir, 'coord', 'kill-tree.mjs'), 'export const x = 1;\n');
  const outsideDir = join(root, 'frontend', 'scripts');
  mkdirSync(outsideDir, { recursive: true });
  const outsideFile = join(outsideDir, 'tool.mjs');
  return {
    root,
    scriptsDir,
    outsideFile,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('Rule 4: an outside import of an EXISTING scripts/ path passes', () => {
  const t = makeRule4Fixture();
  try {
    const v = findDeadScriptsImports(
      "import { killProcessTree } from '../../scripts/coord/kill-tree.mjs';",
      t.outsideFile,
      { scriptsDir: t.scriptsDir },
    );
    assert.deepEqual(v, []);
  } finally {
    t.cleanup();
  }
});

test('Rule 4: an outside import of a DEAD scripts/ path fires and names the coord/ alternative', () => {
  const t = makeRule4Fixture();
  try {
    // The live plan-3962 shape: the consumer still points at the pre-move flat path.
    const v = findDeadScriptsImports(
      "import { killProcessTree } from '../../scripts/kill-tree.mjs';",
      t.outsideFile,
      { scriptsDir: t.scriptsDir },
    );
    assert.equal(v.length, 1);
    assert.equal(v[0].kind, 'dead-scripts-import');
    assert.equal(v[0].specifier, '../../scripts/kill-tree.mjs');
    assert.equal(v[0].line, 1);
    assert.equal(v[0].suggestedFix, 'scripts/coord/kill-tree.mjs');
  } finally {
    t.cleanup();
  }
});

test('Rule 4: a dead specifier with no same-basename coord/ file still fires, with no suggestion', () => {
  const t = makeRule4Fixture();
  try {
    const v = findDeadScriptsImports(
      "import { x } from '../../scripts/never-existed.mjs';",
      t.outsideFile,
      { scriptsDir: t.scriptsDir },
    );
    assert.equal(v.length, 1);
    assert.equal(v[0].suggestedFix, null);
  } finally {
    t.cleanup();
  }
});

test('Rule 4: catches a bare require() of a dead scripts/ path too (outside/ is not ESM-only)', () => {
  const t = makeRule4Fixture();
  try {
    const v = findDeadScriptsImports(
      "const { killProcessTree } = require('../../scripts/kill-tree.mjs');",
      t.outsideFile,
      { scriptsDir: t.scriptsDir },
    );
    assert.equal(v.length, 1);
    assert.equal(v[0].suggestedFix, 'scripts/coord/kill-tree.mjs');
  } finally {
    t.cleanup();
  }
});

// ── round-3 review T2/T3 for Rule 4 (the same two fixes, the outside-consumer direction) ────
test('Rule 4: a real scripts/ subdirectory merely BEGINNING with two dots is not "outside"', () => {
  const t = makeRule4Fixture();
  try {
    mkdirSync(join(t.scriptsDir, '..cache'), { recursive: true });
    writeFileSync(join(t.scriptsDir, '..cache', 'tool.mjs'), 'export const x = 1;\n');
    const v = findDeadScriptsImports(
      "import { x } from '../../scripts/..cache/tool.mjs';",
      t.outsideFile,
      { scriptsDir: t.scriptsDir },
    );
    assert.deepEqual(v, []);
  } finally {
    t.cleanup();
  }
});

test('Rule 4: a require() of a template-literal specifier is treated exactly like a quoted one', () => {
  const t = makeRule4Fixture();
  try {
    const v = findDeadScriptsImports(
      'const { killProcessTree } = require(`../../scripts/kill-tree.mjs`);',
      t.outsideFile,
      { scriptsDir: t.scriptsDir },
    );
    assert.equal(v.length, 1);
    assert.equal(v[0].specifier, '../../scripts/kill-tree.mjs');
    assert.equal(v[0].suggestedFix, 'scripts/coord/kill-tree.mjs');
  } finally {
    t.cleanup();
  }
});

test('Rule 4: an INTERPOLATED template-literal specifier is ignored, not guessed at or flagged', () => {
  const t = makeRule4Fixture();
  try {
    const v = findDeadScriptsImports(
      'const name = "kill-tree"; require(`../../scripts/${name}.mjs`);',
      t.outsideFile,
      { scriptsDir: t.scriptsDir },
    );
    assert.deepEqual(v, []);
  } finally {
    t.cleanup();
  }
});

// ── round-3 review T4: a stat failure other than ENOENT is a scan failure, not a dead import ──
test('Rule 4: a non-ENOENT stat failure on an import target throws OutsideTreeUnavailableError, never a phantom violation', () => {
  const t = makeRule4Fixture();
  try {
    const eacces = () => {
      const e = new Error('EACCES: permission denied');
      e.code = 'EACCES';
      throw e;
    };
    assert.throws(
      () =>
        findDeadScriptsImports("import { x } from '../../scripts/kill-tree.mjs';", t.outsideFile, {
          scriptsDir: t.scriptsDir,
          _statSync: eacces,
        }),
      OutsideTreeUnavailableError,
    );
  } finally {
    t.cleanup();
  }
});

test('Rule 4: a genuine ENOENT stat failure is still the ordinary dead-import case', () => {
  const t = makeRule4Fixture();
  try {
    const enoent = () => {
      const e = new Error('ENOENT: no such file or directory');
      e.code = 'ENOENT';
      throw e;
    };
    const v = findDeadScriptsImports(
      "import { x } from '../../scripts/kill-tree.mjs';",
      t.outsideFile,
      { scriptsDir: t.scriptsDir, _statSync: enoent },
    );
    assert.equal(v.length, 1);
    assert.equal(v[0].kind, 'dead-scripts-import');
  } finally {
    t.cleanup();
  }
});

// Round-4 finding ff5240: the read of each tracked outside file swallowed EVERY failure as
// "absent from this working tree". ENOENT really is ordinary — plan 3956 cuts plan worktrees
// sparse, so a tracked file under a heavy data-pipeline store is legitimately not on disk — but
// a permissions or IO error means the file was never examined, and calling that absent lets the
// scan report a clean outside tree it never read. Both halves are pinned here, in one test, so
// neither can be tightened into the other by a later edit.
test('scanOutsideTree: an unreadable tracked file fails the scan OPEN, while an ENOENT one is merely skipped', () => {
  const t = makeRule4Fixture();
  try {
    const secondOutside = join(t.root, 'frontend', 'scripts', 'second.mjs');
    writeFileSync(t.outsideFile, "import { x } from '../../scripts/kill-tree.mjs';\n");
    writeFileSync(secondOutside, "import { x } from '../../scripts/kill-tree.mjs';\n");
    const relOutside = relative(t.root, t.outsideFile).split(sep).join('/');
    const relSecond = relative(t.root, secondOutside).split(sep).join('/');
    const _git = () => `${relOutside}\n${relSecond}\n`;

    // ENOENT on the SECOND file: the first file's genuine violation still stands, and the scan
    // completes. This is the sparse-worktree case and must never fail a push.
    const enoent = (p) => {
      if (p === secondOutside) {
        const e = new Error('ENOENT: no such file or directory');
        e.code = 'ENOENT';
        throw e;
      }
      return readFileSync(p, 'utf8');
    };
    const skippedOne = scanOutsideTree(t.root, t.scriptsDir, { _git, _readFile: enoent });
    assert.equal(skippedOne.skipped, false, 'an absent tracked file is not a scan failure');
    assert.equal(skippedOne.violations.length, 1, 'the readable file is still scanned');

    // EACCES on the SECOND file, after the first has already yielded a real violation: the whole
    // scan degrades to skipped and that violation is discarded, because a scan that did not
    // finish must not report a mix of verified and unverified.
    const eacces = (p) => {
      if (p === secondOutside) {
        const e = new Error('EACCES: permission denied');
        e.code = 'EACCES';
        throw e;
      }
      return readFileSync(p, 'utf8');
    };
    const failedOpen = scanOutsideTree(t.root, t.scriptsDir, { _git, _readFile: eacces });
    assert.deepEqual(failedOpen.violations, []);
    assert.equal(failedOpen.skipped, true);
    assert.match(failedOpen.reason, /EACCES/);
  } finally {
    t.cleanup();
  }
});

test('scanOutsideTree: a non-ENOENT stat failure fails the WHOLE scan open, discarding any violations already found', () => {
  const t = makeRule4Fixture();
  try {
    // A second outside file that IS a real, findable dead import — proves the eventual
    // skipped:true result is not merely "found zero files", but a genuine discard of a
    // violation the scan had already collected before the failing file.
    const secondOutside = join(t.root, 'frontend', 'scripts', 'second.mjs');
    writeFileSync(t.outsideFile, "import { x } from '../../scripts/kill-tree.mjs';\n");
    writeFileSync(secondOutside, "import { x } from '../../scripts/kill-tree.mjs';\n");
    const relOutside = relative(t.root, t.outsideFile).split(sep).join('/');
    const relSecond = relative(t.root, secondOutside).split(sep).join('/');
    const _git = () => `${relOutside}\n${relSecond}\n`;
    let calls = 0;
    const _statSync = (p) => {
      calls += 1;
      // The first file's target genuinely does not exist at the flat path (only at coord/kill-
      // tree.mjs — see makeRule4Fixture), so the real statSync throws ENOENT here, which
      // findDeadScriptsImports itself catches and correctly reports as a dead-scripts-import
      // violation — a real, already-collected hit before the failure below ever happens.
      if (calls === 1) return statSync(p);
      const e = new Error('EACCES: permission denied');
      e.code = 'EACCES';
      throw e; // the second file's target stat fails for a reason that is not "absent"
    };
    const r = scanOutsideTree(t.root, t.scriptsDir, { _git, _statSync });
    assert.deepEqual(r.violations, []);
    assert.equal(r.skipped, true);
    assert.match(r.reason, /EACCES/);
  } finally {
    t.cleanup();
  }
});

test('Rule 4: a specifier-shaped fragment inside a // comment does not fire', () => {
  const t = makeRule4Fixture();
  try {
    const src = [
      "// old: import { x } from '../../scripts/kill-tree.mjs'",
      'export const y = 1;',
    ].join('\n');
    assert.deepEqual(findDeadScriptsImports(src, t.outsideFile, { scriptsDir: t.scriptsDir }), []);
  } finally {
    t.cleanup();
  }
});

test('Rule 4: a specifier-shaped fragment inside a template-literal error message does not fire', () => {
  const t = makeRule4Fixture();
  try {
    // The live shape that blocked plan 3962 Phase 2 for Rule 3 (see the test above pinning it for
    // findViolationsInSource): an error message reading `cannot derive a plan id from "${x}"`.
    const src = [
      'function idOf(idOrName) {',
      '  throw new Error(`cannot derive a plan id from "${idOrName}"`);',
      '}',
    ].join('\n');
    assert.deepEqual(findDeadScriptsImports(src, t.outsideFile, { scriptsDir: t.scriptsDir }), []);
  } finally {
    t.cleanup();
  }
});

test('Rule 4: a specifier resolving to a DIRECTORY does not pass — must be a FILE', () => {
  const t = makeRule4Fixture();
  try {
    // The exact round-2 review T2 shape: `scripts/coord/` exists (makeRule4Fixture creates it as a
    // directory), so the old `existsSync(abs)` check passed this — and Node's module loader still
    // dies at runtime, because a bare directory specifier never resolves as a module.
    const v = findDeadScriptsImports("import { x } from '../../scripts/coord';", t.outsideFile, {
      scriptsDir: t.scriptsDir,
    });
    assert.equal(v.length, 1);
    assert.equal(v[0].kind, 'dead-scripts-import');
    assert.equal(v[0].specifier, '../../scripts/coord');
  } finally {
    t.cleanup();
  }
});

test("Rule 4: an import that does not resolve into scripts/ at all is not this rule's business", () => {
  const t = makeRule4Fixture();
  try {
    // '../shared/does-not-exist.mjs' from frontend/scripts/tool.mjs resolves to
    // frontend/shared/does-not-exist.mjs — outside scriptsDir entirely, so its non-existence is
    // Rule 1/escapes-scripts territory (if anything), never Rule 4's.
    const v = findDeadScriptsImports(
      "import { x } from '../shared/does-not-exist.mjs';",
      t.outsideFile,
      { scriptsDir: t.scriptsDir },
    );
    assert.deepEqual(v, []);
  } finally {
    t.cleanup();
  }
});

test('collectOutsideTrackedFiles excludes anything under scripts/ itself', () => {
  const t = makeRule4Fixture();
  try {
    const _git = () => 'scripts/tool.mjs\nfrontend/scripts/tool.mjs\n';
    const files = collectOutsideTrackedFiles(t.root, { _git });
    assert.deepEqual(
      files.map((f) => relative(t.root, f).split(sep).join('/')),
      ['frontend/scripts/tool.mjs'],
    );
  } finally {
    t.cleanup();
  }
});

test('scanOutsideTree: fires on a dead import end-to-end, and clears once the import is fixed', () => {
  const t = makeRule4Fixture();
  try {
    writeFileSync(t.outsideFile, "import { x } from '../../scripts/kill-tree.mjs';\n");
    const relOutside = relative(t.root, t.outsideFile).split(sep).join('/');
    const _git = () => `${relOutside}\n`;
    const r = scanOutsideTree(t.root, t.scriptsDir, { _git });
    assert.equal(r.skipped, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].file, relOutside);
    assert.equal(r.violations[0].line, 1);
    assert.equal(r.violations[0].kind, 'dead-scripts-import');
    assert.equal(r.violations[0].suggestedFix, 'scripts/coord/kill-tree.mjs');
    // Repoint at the real coord/ home (the actual T1 fix shape) — the scan goes clean.
    writeFileSync(t.outsideFile, "import { x } from '../../scripts/coord/kill-tree.mjs';\n");
    assert.deepEqual(scanOutsideTree(t.root, t.scriptsDir, { _git }), {
      violations: [],
      skipped: false,
      reason: null,
    });
  } finally {
    t.cleanup();
  }
});

// ── round-2 review T1: a git failure must fail OPEN (skip, never crash the push) ─────────────────
test('collectOutsideTrackedFiles: a git failure throws OutsideTreeUnavailableError, never a raw crash', () => {
  const _git = () => {
    throw new Error('fatal: unable to read tree (transient shared-.git churn)');
  };
  assert.throws(() => collectOutsideTrackedFiles('/repo', { _git }), OutsideTreeUnavailableError);
});

test('scanOutsideTree: a git failure fails OPEN — skipped:true, zero violations, reason carries the git error', () => {
  const _git = () => {
    throw new Error('fatal: unable to read tree (transient shared-.git churn)');
  };
  const r = scanOutsideTree('/repo', '/repo/scripts', { _git });
  assert.deepEqual(r.violations, []);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /transient shared-\.git churn/);
});

// ── the REAL tree is the acceptance criterion for Rule 4 too, after plan 3962's T1 fixes ────
test('the real outside-of-scripts tree has zero dead scripts/ imports', () => {
  const r = scanOutsideTree();
  assert.equal(r.skipped, false, r.reason ?? '');
  assert.deepEqual(r.violations, []);
});
