// scripts/test-helpers/isolated-plan-repo.mjs — the shared isolated-plan-repo test
// scaffold (plan 1797). move-plan.test.mjs pioneered this harness and edit-plan /
// stamp-exec-model / stamp-cloud-exec each carried a verbatim copy (the 4th one was
// plan-1781 review finding [6]); a scaffold fix had to be applied four times. One
// copy lives here now; each test file keeps only its own DEFAULT body + a thin
// wrapper that fills in its prefix/basename defaults.
//
// What makeIsolatedRepo builds — a FULLY self-contained temp repo:
//   - a bare "origin" + a working clone with one pushed master commit;
//   - the whole scripts/**/*.mjs tool tree (non-test, minus test-helpers/) copied in
//     — nested dirs included since plan 2622 — so a COPIED tool's
//     imports (move-plan.mjs / build-index.mjs / coord-git.mjs / stamp-lib.mjs / …)
//     resolve against THIS repo, not the real one (build-index.mjs resolves
//     REPO_ROOT from its OWN dirname, so end-to-end runs would otherwise touch the
//     REAL repo);
//   - a scaffolded docs/INDEX.md (generator sentinels + archive anchor);
//   - EVERY plan status folder materialised (tracked via .gitkeep) so a `git mv`
//     to any target has a real dest dir;
//   - one seed plan file (`body`) in `startFolder`.
//
// NOT copied: this test-helpers/ dir itself (the copied tools never import it).
//
// ⚠ THE CONSTRAINT THIS IMPOSES ON THE WHOLE scripts/ TREE (stated here because this is the
// mechanism that enforces it, plan 2615): a non-test `scripts/**/*.mjs` module must NOT import
// outside `scripts/`, nor into `test-helpers/`. Only the non-test scripts tool tree is copied,
// so a relative import that escapes it — `../shared/…`, `../backend/…` — resolves to nothing
// inside the temp repo and the copied tool dies with ERR_MODULE_NOT_FOUND. Hook modules live at
// `scripts/hooks/**` (plan 3765 moved them out of `.claude/hooks/`), so importing a `scripts/`
// sibling from a hook — `scripts/hooks/chain-wiki-loader.mjs` importing `../wiki-chain-registry.mjs`
// — is fine and well established (several do), and no longer a special-cased reverse direction:
// hooks are ordinary `scripts/` modules for this rule now.
//
// Detection USED to be accidental, which was the trap: a violation only turned a suite red if
// some copied tool's import chain happened to reach it. scripts/coord/write-lint-common.mjs carried
// exactly this bad import for a long time undetected (no isolated-repo tool imports it), and was
// only found by the tree-wide scan plan 2615 ran after select-battery-tests.mjs — which IS
// reachable — broke stamp-exec-model.test.mjs. Since plan 2622 the rule is mechanical:
// scripts/assert-scripts-self-contained.mjs scans the tree on every scripts-touching push, and
// what it permits is exactly what copyScriptsTree below copies. Full rule + evidence:
// docs/runbooks/scripts-module-layout.md.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_PLAN_FOLDERS } from '../coord/build-index-lib.mjs';
import { UNCOPIED_ROOT_DIRS, isCopiedFile } from '../assert-scripts-self-contained.mjs';

// plan 338 (hoisted here from every scaffold copy): git exports GIT_DIR /
// GIT_WORK_TREE / … into hook + test subprocesses, which OVERRIDE the `git -C
// <tmpdir>` repo selection and redirect these temp-repo ops onto the REAL repo.
// Clear them AT IMPORT so every git call in the importing test file (and any
// spawned tool child, which inherits this process's env) honours -C <tmpdir>.
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

// This helper lives one level below scripts/ — the tool tree it copies is its parent.
const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// The superset every consumer needs (move-plan's tests exercise parked/, plan 1426;
// the extra empty folders are inert for the tools that never target them). Derived from
// the plan-1447 single-source folder list (plan 2034 — this was the last hand-copied
// folder enumeration; a new status folder now reaches the scaffold automatically).
export const ALL_STATUS_FOLDERS = [...ALL_PLAN_FOLDERS];

// Copy the scripts tool tree into the temp repo, RECURSING into nested dirs (plan 2622).
// Nested dirs must come along: two flat tools already import
// `./lib/decision-dossier/inline.mjs` (batches-view.mjs, build-unblock-lane-dossier.mjs),
// and without the recursion those copies die in the temp repo exactly like an escaping
// import does. `test-helpers/` stays excluded — it is this dir, the copied tools never
// import it, and scripts/assert-scripts-self-contained.mjs flags any tool that tries.
// That guard and this function are the two halves of one invariant, so the exclusion
// rules are IMPORTED from the guard (UNCOPIED_ROOT_DIRS / isCopiedFile) rather than
// re-stated here: two hand-maintained copies kept in step by comment is the same
// latent-drift shape plan 2622 exists to close.
//
// Everything except the test files themselves is copied — not just `.mjs`. A module's
// sibling ASSETS travel with it: `scripts/lib/decision-dossier/inline.mjs` reads
// `template.html` from its own dirname at runtime, so an .mjs-only copy would ENOENT a
// copied tool exactly the way an escaping import ERR_MODULE_NOT_FOUNDs it — a break the
// guard cannot see, since it scans import specifiers and not asset reads.
//
// Widening only to `scripts/**` is deliberately NOT the "just copy more of the tree"
// fix the rule rejects — that boundary is about copying FOREIGN trees (`.claude/`,
// `shared/`) into every temp repo. `scripts/lib/` is inside the boundary the rule defends.
function copyScriptsTree(srcDir, destDir, isRoot) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const from = join(srcDir, entry.name);
    const to = join(destDir, entry.name);
    if (entry.isDirectory()) {
      if (isRoot && UNCOPIED_ROOT_DIRS.includes(entry.name)) continue;
      mkdirSync(to, { recursive: true });
      copyScriptsTree(from, to, false);
    } else if (isCopiedFile(entry.name)) {
      copyFileSync(from, to);
    }
  }
}

// Build the isolated repo. All five options are the caller's to default (each test
// file bakes its own prefix/basename/body in via isolatedRepoFactory below):
//   prefix      — tmpdir name stem (e.g. 'stampexec' → 'stampexec-origin-…').
//   startFolder — plan status folder the seed plan starts in.
//   basename    — the seed plan's filename.
//   body        — the seed plan's full content.
//   coordConfig — OPTIONAL: a plain object written as this fixture's own repo-root
//                 `coord.config.json` (JSON.stringify'd verbatim). Default `undefined` —
//                 NO file is written, preserving the scaffold's long-standing "no config"
//                 contract (coord-config.test.mjs's plan-3960-T3 suite asserts a fresh
//                 fixture carries no coord.config.json at all, and every other consumer's
//                 fail-open-to-DEFAULTS behavior depends on that same absence). A caller
//                 that needs ONE key set (e.g. stamp-cloud-exec.test.mjs's `cloudRepos`
//                 registry for its `--repos` subprocess cases) opts in explicitly with
//                 `{ coordConfig: { cloudRepos: [...] } }` rather than this scaffold ever
//                 defaulting to a non-empty config for everyone.
// Returns { dir, g, origin, basename, srcRel, readyRel, scriptsDir, toolPath, cleanup }
// — toolPath(name) resolves a COPIED tool inside the temp repo (run that copy, never
// the real one, when the test exercises the end-to-end path); readyRel is a pre-1797
// back-compat alias for srcRel (the plan's CURRENT location, whatever the folder).
export function makeIsolatedRepo({ prefix, startFolder = 'ready', basename, body, coordConfig }) {
  const origin = mkdtempSync(join(tmpdir(), `${prefix}-origin-`));
  execFileSync('git', ['init', '--bare', '-q', '-b', 'master', origin]);
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-work-`));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.autocrlf', 'false');
  g('remote', 'add', 'origin', origin);

  const scriptsDir = join(dir, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  copyScriptsTree(SCRIPTS_DIR, scriptsDir, true);

  // plan 3958: caller-supplied coord.config.json (see the option's own comment above) — written
  // ONLY when a caller opts in, so the scaffold's default fixture stays genuinely config-less.
  // A copied scripts/coord/cloud-repos-lib.mjs self-resolving its `cloudRepos` registry from THIS
  // temp repo's root (repoRootFrom anchors on the `scripts/` directory name, so it finds this
  // file whether running from the real repo or from here) picks up whatever `coordConfig` names,
  // or degrades to `[]` when the caller passed none.
  if (coordConfig !== undefined) {
    writeFileSync(join(dir, 'coord.config.json'), `${JSON.stringify(coordConfig, null, 2)}\n`);
  }

  const docsDir = join(dir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(
    join(docsDir, 'INDEX.md'),
    [
      '# Index',
      '',
      '<!-- INDEX:PLANS-START (generated by scripts/build-index.mjs — do not hand-edit between the sentinels) -->',
      '<!-- INDEX:PLANS-END -->',
      '',
      'Moved to `docs/superpowers/plans/archive/` — nothing yet.',
      '',
    ].join('\n'),
  );

  const plansRoot = join(dir, 'docs', 'superpowers', 'plans');
  // `startFolder` is unioned in so the scaffold always materialises the folder the caller
  // actually seeds into, even when ALL_STATUS_FOLDERS does not list it (plan 2034). Since
  // plan 2062 the coord-share canonical set is nested-aware (`test-helpers/*.mjs`) and this
  // file syncs to siblings like any other adopted coord script, so the original driver of
  // this union — siblings carrying a private un-synced copy of the scaffold that drifts
  // from the adopted tests — is gone. It is KEPT as belt-and-suspenders (plan 2062 Q2): two
  // lines that make the scaffold robust against ANY future adoption skew, e.g. a sibling
  // deliberately adopting a subset of the status folders.
  for (const f of new Set([...ALL_STATUS_FOLDERS, startFolder])) {
    const fdir = join(plansRoot, f);
    mkdirSync(fdir, { recursive: true });
    writeFileSync(join(fdir, '.gitkeep'), '');
  }
  const srcRel = `docs/superpowers/plans/${startFolder}/${basename}`;
  writeFileSync(join(dir, srcRel), body);
  g('add', '-A');
  g('commit', '-qm', 'seed plan + tools + index');
  g('push', '-q', 'origin', 'master');
  return {
    dir,
    g,
    origin,
    basename,
    srcRel,
    readyRel: srcRel, // back-compat alias (pre-1797 move-plan scaffold)
    scriptsDir,
    // Resolve the COPIED tool at whichever layer holds it. coord-core step 4 (plan 3962) moved
    // 93 modules from scripts/ to scripts/coord/, and a caller naming a tool by BASENAME means
    // "the tool", not "the tool at the layer it happened to sit on when this test was written".
    // Falls back to the flat path so the failure message still names the layer a caller expects.
    toolPath: (name) => {
      // coord/ FIRST: the flat path may hold a three-line path-compat shim left by the move.
      const nested = join(scriptsDir, 'coord', name);
      if (existsSync(nested)) return nested;
      return join(scriptsDir, name);
    },
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    },
  };
}

// Bake a suite's defaults into a ready-made makeIsolatedRepo (one call per test
// file, replacing the four near-identical hand-rolled wrappers the 1797 review
// flagged): `prefix`/`basename`/`body` are the suite defaults, and each `tools`
// entry ({ key: 'file.mjs' }) is returned as `repo.<key>` = the COPIED tool's path.
// `coordConfig` (plan 3958) is the suite default for makeIsolatedRepo's own optional
// coord.config.json — omitted (as most suites do) it stays undefined, so no file is
// written, same as calling makeIsolatedRepo directly.
// Per-call opts still override startFolder/basename/body/coordConfig exactly as before.
export function isolatedRepoFactory({
  prefix,
  basename: defBasename,
  body: defBody,
  tools = {},
  coordConfig: defCoordConfig,
}) {
  return ({
    startFolder = 'ready',
    basename = defBasename,
    body = defBody,
    coordConfig = defCoordConfig,
  } = {}) => {
    const repo = makeIsolatedRepo({ prefix, startFolder, basename, body, coordConfig });
    for (const [key, file] of Object.entries(tools)) repo[key] = repo.toolPath(file);
    return repo;
  };
}

// Run a coord tool as a subprocess with cwd in the temp repo; capture exit + IO.
// (The runStamp / runMovePlan of the four pre-1797 copies — identical bodies.)
// spawnSync (not execFileSync) so stderr is captured on the SUCCESS path too — a
// tool that writes advisory/warn lines via console.error while still exiting 0
// (e.g. assert-coord-in-sync.mjs) needs its stderr visible to a passing-exit assertion.
export function runTool(dir, args, scriptPath) {
  // process.execPath (not the PATH-resolved 'node') so the subprocess runs under the
  // SAME interpreter as the test harness itself (sonnet-review high finding, plan 2075).
  const r = spawnSync(process.execPath, [scriptPath, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}
