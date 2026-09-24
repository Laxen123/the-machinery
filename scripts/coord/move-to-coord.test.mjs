// scripts/coord/move-to-coord.test.mjs — tests for the step-4 batch-move codemod.
//
// Deliberately never moves a REAL scripts/ module (plan 3962 § Phase 2 build brief): every
// case here drives the codemod against a synthetic fixture tree built fresh in a temp dir,
// with its own throwaway git repo so `git mv` has something real to operate on. Nothing here
// touches the actual `scripts/` tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import {
  applyMove,
  formatPlanReport,
  main,
  parseArgs,
  planMove,
  RefusalError,
} from './move-to-coord.mjs';

// x.mjs's entry point returns 3 (not 0) so the shim test proves the real exit code propagates
// through, rather than merely observing an always-zero happy path.
const X_MJS = `export function main(argv = []) {\n  return 3;\n}\n`;
const X_TEST_MJS = `import { main } from './x.mjs';\nif (main() !== 3) throw new Error('x.mjs regressed');\n`;
const STAY_MJS = `import { main as xMain } from './x.mjs';\nexport function run() {\n  return xMain();\n}\n`;
const SAMEBATCH_MJS = `import { main as xMain } from './x.mjs';\nexport function run2() {\n  return xMain();\n}\n`;
const SAMEBATCH_TEST_MJS =
  `import { run2 } from './samebatch.mjs';\n` +
  `import { run } from './stay.mjs';\n` +
  `if (run2() !== run()) throw new Error('mismatch');\n`;
// The OTHER live entry-point contract: a `main` that sets `process.exitCode` itself and returns
// undefined. A shim that blindly assigns the return value RESETS that to 0 — the shape that
// turned compute-push-diff.mjs's `--drain-status-only` "no" into a "yes" and skipped the
// pre-push gate battery on a push carrying real code (plan 3962 Phase 2).
const EXITCODE_MJS = `export function main(argv = []) {\n` + `  process.exitCode = 4;\n` + `}\n`;

// A module whose CLI guard DISPATCHES between two entry functions. A shim that imports `main`
// alone reproduces only one of the two modes, silently — the shape that disabled
// select-battery-tests.mjs's --data-triggered mode and with it the pre-push data-dependency
// gate. Such a module exports `cliMain`, and the shim must call THAT.
const TWOMODE_MJS =
  `export function main() {\n` +
  `  return 5;\n` +
  `}\n` +
  `export function other() {\n` +
  `  return 6;\n` +
  `}\n` +
  `export function cliMain(argv = process.argv.slice(2)) {\n` +
  `  return argv[0] === '--other' ? other() : main();\n` +
  `}\n`;

const NOENTRY_MJS = `export const value = 1;\n`;
const OUTSIDE_IMPORT_MJS = `import { run } from './stay.mjs';\nexport function callRun() {\n  return run();\n}\n`;
const DEEP_MJS = `import { main as xMain } from '../../x.mjs';\nexport function deep() {\n  return xMain();\n}\n`;
// A module whose only local import already points INTO a coord SUBDIRECTORY — legal under
// Rule 3 (scripts/coord/**), and the shape a coordDir EQUALITY check wrongly refused.
const NESTED_OK_MJS = `import { deep } from './coord/land/deep.mjs';\nexport function callDeep() {\n  return deep();\n}\n`;

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'move-to-coord-'));
  const scriptsDir = join(root, 'scripts');
  const coordDir = join(scriptsDir, 'coord');
  const landDir = join(coordDir, 'land');
  mkdirSync(landDir, { recursive: true });

  writeFileSync(join(scriptsDir, 'x.mjs'), X_MJS);
  writeFileSync(join(scriptsDir, 'x.test.mjs'), X_TEST_MJS);
  writeFileSync(join(scriptsDir, 'stay.mjs'), STAY_MJS);
  writeFileSync(join(scriptsDir, 'samebatch.mjs'), SAMEBATCH_MJS);
  writeFileSync(join(scriptsDir, 'samebatch.test.mjs'), SAMEBATCH_TEST_MJS);
  writeFileSync(join(scriptsDir, 'noentry.mjs'), NOENTRY_MJS);
  writeFileSync(join(scriptsDir, 'twomode.mjs'), TWOMODE_MJS);
  writeFileSync(join(scriptsDir, 'exitcode.mjs'), EXITCODE_MJS);
  writeFileSync(join(scriptsDir, 'outside-import.mjs'), OUTSIDE_IMPORT_MJS);
  writeFileSync(join(scriptsDir, 'existing.mjs'), `export const stub = 1;\n`);
  writeFileSync(join(coordDir, 'existing.mjs'), `export const alreadyThere = 1;\n`);
  writeFileSync(join(landDir, 'deep.mjs'), DEEP_MJS);
  writeFileSync(join(scriptsDir, 'nested-ok.mjs'), NESTED_OK_MJS);

  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  // A commit (identity scoped to THIS invocation only, via -c — never the repo's or the user's
  // global git config) so `git status --porcelain` reads clean before any move, which is what
  // the dry-run test below needs to tell "nothing written" from "still shows the initial add".
  execFileSync(
    'git',
    [
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'user.name=fixture',
      'commit',
      '-q',
      '-m',
      'fixture',
    ],
    { cwd: root },
  );

  return { root, scriptsDir };
}

/** Recursive map of every file under `root` (git metadata excluded) -> its raw content. */
function snapshotTree(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.set(relative(root, p).split(sep).join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(root);
  return out;
}

test('importer staying at scripts/ gets its specifier rewritten to ./coord/<name>.mjs', () => {
  const { root, scriptsDir } = buildFixture();
  try {
    const plan = planMove({ modules: ['scripts/x.mjs'], scriptsDir, repoRoot: root });
    applyMove(plan, { dryRun: false });
    const content = readFileSync(join(scriptsDir, 'stay.mjs'), 'utf8');
    assert.match(content, /from '\.\/coord\/x\.mjs'/);
    assert.equal(statSyncSafe(join(scriptsDir, 'coord', 'x.mjs')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an importer moving in the SAME batch keeps its specifier exactly unchanged', () => {
  const { root, scriptsDir } = buildFixture();
  try {
    const plan = planMove({
      modules: ['scripts/x.mjs', 'scripts/samebatch.mjs'],
      scriptsDir,
      repoRoot: root,
    });
    // samebatch.mjs's only import (./x.mjs) resolves to a same-batch mover landing in the same
    // new directory, so no rewrite is needed for that file at all.
    const rewroteSamebatch = plan.rewrites.some((r) =>
      r.oldAbs.endsWith(join('scripts', 'samebatch.mjs')),
    );
    assert.equal(rewroteSamebatch, false);
    applyMove(plan, { dryRun: false });
    const moved = readFileSync(join(scriptsDir, 'coord', 'samebatch.mjs'), 'utf8');
    assert.equal(moved, SAMEBATCH_MJS); // byte-identical: git mv only, no rewrite touched it
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an importer already nested under scripts/coord/land/ shortens ../../x.mjs to ../x.mjs', () => {
  const { root, scriptsDir } = buildFixture();
  try {
    const plan = planMove({ modules: ['scripts/x.mjs'], scriptsDir, repoRoot: root });
    applyMove(plan, { dryRun: false });
    const content = readFileSync(join(scriptsDir, 'coord', 'land', 'deep.mjs'), 'utf8');
    assert.match(content, /from '\.\.\/x\.mjs'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a .test.mjs pair moves with its module, and its own cross-batch import is rewritten', () => {
  const { root, scriptsDir } = buildFixture();
  try {
    // x.mjs must ride along in the batch too — samebatch.mjs imports it, and moving samebatch
    // alone would trip the Rule 3 refusal (correctly: it would otherwise import out of
    // scripts/coord/**). That import is covered by its own "same batch, unchanged" test above;
    // this test is about samebatch.test.mjs's OWN import of the sibling that stays behind.
    const plan = planMove({
      modules: ['scripts/samebatch.mjs', 'scripts/x.mjs'],
      scriptsDir,
      repoRoot: root,
    });
    applyMove(plan, { dryRun: false });
    // x.test.mjs was never asked to move, but samebatch.test.mjs pairs with samebatch.mjs and
    // must have moved alongside it, with its OWN import of the sibling that stayed put
    // (./stay.mjs) rewritten to reach one directory up.
    const movedTestPath = join(scriptsDir, 'coord', 'samebatch.test.mjs');
    assert.equal(statSyncSafe(movedTestPath), true);
    assert.equal(statSyncSafe(join(scriptsDir, 'samebatch.test.mjs')), false);
    const content = readFileSync(movedTestPath, 'utf8');
    assert.match(content, /from '\.\/samebatch\.mjs'/); // same-dir sibling: unchanged
    assert.match(content, /from '\.\.\/stay\.mjs'/); // stayed-behind sibling: rewritten
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a shim is written for a requested command and propagates the real exit code', () => {
  const { root, scriptsDir } = buildFixture();
  try {
    const plan = planMove({ modules: ['scripts/x.mjs'], shims: ['x'], scriptsDir, repoRoot: root });
    applyMove(plan, { dryRun: false });
    const shimPath = join(scriptsDir, 'x.mjs');
    assert.equal(statSyncSafe(shimPath), true);
    let status = null;
    try {
      execFileSync(process.execPath, [shimPath], { cwd: scriptsDir, stdio: 'pipe' });
      status = 0;
    } catch (e) {
      status = e.status;
    }
    assert.equal(status, 3); // x.mjs's main() returns 3
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the shim preserves an exit code a main() sets on process.exitCode itself', () => {
  // Regression, and the more dangerous of the two contracts: the shim used to do a bare
  // `process.exitCode = await main(...)`, so a main() returning undefined RESET a nonzero
  // exitCode to 0. For compute-push-diff.mjs that inverted a pre-push gate verdict — a push
  // carrying real code was announced "drain-status-only" and the battery was skipped.
  const { root, scriptsDir } = buildFixture();
  try {
    const plan = planMove({
      modules: ['scripts/exitcode.mjs'],
      shims: ['exitcode'],
      scriptsDir,
      repoRoot: root,
    });
    applyMove(plan, { dryRun: false });
    let status = null;
    try {
      execFileSync(process.execPath, [join(scriptsDir, 'exitcode.mjs')], {
        cwd: scriptsDir,
        stdio: 'pipe',
      });
      status = 0;
    } catch (e) {
      status = e.status;
    }
    assert.equal(status, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the shim calls cliMain when the module exports one, so BOTH CLI modes survive', () => {
  const { root, scriptsDir } = buildFixture();
  try {
    const plan = planMove({
      modules: ['scripts/twomode.mjs'],
      shims: ['twomode'],
      scriptsDir,
      repoRoot: root,
    });
    applyMove(plan, { dryRun: false });
    const shimPath = join(scriptsDir, 'twomode.mjs');
    const run = (args) => {
      try {
        execFileSync(process.execPath, [shimPath, ...args], { cwd: scriptsDir, stdio: 'pipe' });
        return 0;
      } catch (e) {
        return e.status;
      }
    };
    assert.equal(run([]), 5, 'the default mode');
    assert.equal(run(['--other']), 6, 'the SECOND mode a `main`-only shim would have dropped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses when the target path already exists', () => {
  const { root, scriptsDir } = buildFixture();
  try {
    assert.throws(
      () => planMove({ modules: ['scripts/existing.mjs'], scriptsDir, repoRoot: root }),
      (e) => e instanceof RefusalError && /already exists/.test(e.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses when a listed module does not exist', () => {
  const { root, scriptsDir } = buildFixture();
  try {
    assert.throws(
      () => planMove({ modules: ['scripts/missing.mjs'], scriptsDir, repoRoot: root }),
      (e) => e instanceof RefusalError && /not found/.test(e.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a batch that would leave a moved module importing outside scripts/coord/**', () => {
  const { root, scriptsDir } = buildFixture();
  try {
    assert.throws(
      () => planMove({ modules: ['scripts/outside-import.mjs'], scriptsDir, repoRoot: root }),
      (e) => e instanceof RefusalError && /Rule 3 violation/.test(e.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an import into a coord SUBDIRECTORY is legal — Rule 3 admits all of scripts/coord/**', () => {
  // Regression: the refusal used `dirname(target) === coordDir`, which recognised only a module
  // sitting DIRECTLY in scripts/coord/. A batch member importing scripts/coord/land/<x>.mjs was
  // therefore refused as a Rule 3 violation even though that import is exactly what the rule
  // allows. Live instance: plan 3962 Phase 2 batch 4, coord-config.mjs -> ./coord/land/registry.mjs.
  const { root, scriptsDir } = buildFixture();
  try {
    const plan = planMove({ modules: ['scripts/nested-ok.mjs'], scriptsDir, repoRoot: root });
    assert.equal(plan.moves.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a shim request for a module with no exported entry point', () => {
  const { root, scriptsDir } = buildFixture();
  try {
    assert.throws(
      () =>
        planMove({
          modules: ['scripts/noentry.mjs'],
          shims: ['noentry'],
          scriptsDir,
          repoRoot: root,
        }),
      (e) => e instanceof RefusalError && /exports no entry point/.test(e.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--dry-run (the default) writes nothing at all', () => {
  const { root, scriptsDir } = buildFixture();
  try {
    const before = snapshotTree(root);
    const plan = planMove({
      modules: ['scripts/x.mjs', 'scripts/samebatch.mjs'],
      shims: ['x'],
      scriptsDir,
      repoRoot: root,
    });
    const report = formatPlanReport(plan);
    assert.match(report, /MOVE\s+scripts[\\/]x\.mjs/);
    const summary = applyMove(plan, { dryRun: true });
    assert.equal(summary.modulesMoved, 2);
    const after = snapshotTree(root);
    assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
    // git's own view of the tree (staged adds aside) must show no working-tree changes either.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    assert.equal(status.trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI defaults to dry-run and only writes with --apply', () => {
  // main() with no scriptsDir/repoRoot override resolves against the REAL repo (no fixture
  // parameter to hand it), so this points at a small real module purely to exercise the CLI's
  // own default-to-dry-run wiring — it must never be able to touch the real tree either way.
  //
  // The target is deliberately a module OUTSIDE this program's move set (test-path-assert.mjs is
  // a generic, node:-only leaf lib every checkout ships at the top level): it used to be
  // ansi-colors.mjs, which this plan's own Phase 2 then moved to scripts/coord/, breaking the
  // test on the very change it is meant to survive; then hobby-env.mjs (plan 3958: a vetapp-only
  // env loader the public coord-kit never ships). A CLI-wiring test must not name a module the
  // program is about to relocate, or one that only exists in one checkout.
  const TARGET = join('scripts', 'test-path-assert.mjs');
  const before = readFileSync(TARGET, 'utf8');
  const exitCode = main(['scripts/test-path-assert.mjs']);
  assert.equal(exitCode, 0);
  const after = readFileSync(TARGET, 'utf8');
  assert.equal(after, before);
});

test('parseArgs collects modules, --shim names, and --apply', () => {
  const parsed = parseArgs(['scripts/a.mjs', 'scripts/b.mjs', '--shim', 'a', 'b', '--apply']);
  assert.deepEqual(parsed.modules, ['scripts/a.mjs', 'scripts/b.mjs']);
  assert.deepEqual(parsed.shims, ['a', 'b']);
  assert.equal(parsed.apply, true);
});

test('parseArgs: an explicit --dry-run always wins over --apply', () => {
  const parsed = parseArgs(['scripts/a.mjs', '--apply', '--dry-run']);
  assert.equal(parsed.apply, false);
});

function statSyncSafe(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
