#!/usr/bin/env node
// scripts/coord/move-to-coord.mjs — the `coord-core` program's step-4 batch-move codemod
// (plan 3962 § Phase 2). Moves a batch of `scripts/<name>.mjs` modules into
// `scripts/coord/<name>.mjs`, rewrites every importer's relative specifier so it still
// resolves, and optionally leaves a path-compat shim behind for a module a hook/skill/
// allow-list invokes by its old path.
//
// WHY THIS EXISTS AS A TOOL, NOT A HAND EDIT. Step 4 moves ~92 modules in ten
// dependency-ordered batches, touching ~347 files across ~1,041 import edges. A relative
// specifier's correct new text depends on the IMPORTING file's own directory — a file that
// itself moves in this batch, a file staying at `scripts/`, and a file already nested under
// `scripts/coord/land/` each need a different rewritten prefix — which is exactly the kind
// of bookkeeping a hand pass or an LLM edit pass gets subtly wrong at this scale.
//
// REUSES `scripts/coord/module-graph.mjs` for import parsing (`stripJs`, `resolveLocal`,
// `specifiersOf`, `exportsEntry`, `walk`) rather than re-rolling it — see that module's own
// header for why its comment/string-aware scanner is the load-bearing part. This module adds
// only what module-graph.mjs does not provide: SPECIFIER POSITIONS (needed to splice exact
// replacement text without a blind string replace) and the move/shim/refuse orchestration.
//
// RULE 3 (`scripts/assert-scripts-self-contained.mjs`) applies to this file itself: it lives
// under `scripts/coord/`, so it may import only `scripts/coord/**` and `node:` builtins.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitRepoIsolatedEnv } from './child-env.mjs';
import {
  REPO_ROOT,
  SCRIPTS_DIR,
  exportsEntry,
  resolveLocal,
  specifiersOf,
  stripJs,
  walk,
} from './module-graph.mjs';

/**
 * Is `p` `dir` itself, or anything beneath it? Path-segment aware, so scripts/coordX never counts.
 * Exported (round-4 review T5) so `scripts/assert-scripts-self-contained.mjs`'s containment check
 * can import this one implementation instead of keeping its own segment-aware copy of the same
 * '..'/'..'+sep/isAbsolute logic under a different name (escapesScriptsDir).
 */
export function isUnder(p, dir) {
  const rel = relative(dir, p);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

/** Thrown for every refuse-rather-than-guess case; the message is the whole explanation. */
export class RefusalError extends Error {}

// Same four specifier shapes as module-graph.mjs's SPEC_RX, duplicated here (not imported —
// module-graph does not export it) because this pass needs the MATCH POSITION of the
// specifier text, not just its value, so a replacement can be spliced in exactly rather than
// via a global string replace that could touch an unrelated occurrence of the same text
// elsewhere in the file. The `d` flag (match indices) is what supplies that position.
const SPEC_PATTERNS = [
  /(?:^|[\n;])\s*import\s+['"]([^'"]+)['"]/dg,
  /(?:^|[\n;])\s*import\s[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/dg,
  /(?:^|[\n;])\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/dg,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/dg,
];

/**
 * Every specifier in `src` that is really an import/export (not prose or a template), with the
 * exact [start,end) offsets of the specifier text itself (quotes excluded) so a caller can
 * splice a replacement in without disturbing anything else on the line.
 */
function findSpecifierSpans(src) {
  const withStrings = stripJs(src, { blankStrings: false }); // comments gone, strings kept
  const codeOnly = stripJs(src, { blankStrings: true }); // comments AND strings gone
  const spans = [];
  const claimed = new Set();
  for (const rx of SPEC_PATTERNS) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(withStrings)) !== null) {
      const groupSpan = m.indices?.[1];
      if (!groupSpan) continue;
      const [start, end] = groupSpan;
      const key = `${start}:${end}`;
      if (claimed.has(key)) continue; // two patterns matching the same statement shape
      const stmtSpan = codeOnly.slice(m.index, m.index + m[0].length);
      if (!/\b(?:import|export)\b/.test(stmtSpan)) continue; // prose/template, not real code
      claimed.add(key);
      spans.push({ start, end, specifier: m[1] });
    }
  }
  return spans;
}

/** Recompute a relative specifier from `fromDir` to `toAbsPath`, always `./`- or `../`-led. */
function relSpecifier(fromDir, toAbsPath) {
  let rel = relative(fromDir, toAbsPath).split(sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

function pairedTestPath(oldAbs) {
  return oldAbs.replace(/\.mjs$/, '.test.mjs');
}

/**
 * Compute the whole batch move WITHOUT touching disk (beyond reading source for inspection).
 * Throws `RefusalError` on any of the refuse-rather-than-guess cases; a caller that catches it
 * gets a message identifying exactly which module/import/shim triggered it.
 *
 * `modules`: repo-relative paths of the modules to move (e.g. `scripts/coord/ansi-colors.mjs`).
 * `shims`: names (no extension) of modules on `modules` that also need a `scripts/<name>.mjs`
 * path-compat shim written behind them.
 */
export function planMove({
  modules,
  shims = [],
  scriptsDir = SCRIPTS_DIR,
  repoRoot = REPO_ROOT,
} = {}) {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new RefusalError('move-to-coord: no modules given');
  }
  const coordDir = join(scriptsDir, 'coord');
  const seenModules = new Set();
  const targetsUsed = new Map(); // absolute new path -> the source that claimed it
  const moves = []; // { oldAbs, newAbs, testMove: { oldAbs, newAbs } | null }
  const oldToNew = new Map(); // absolute old path (module AND its test) -> absolute new path

  const claimTarget = (newAbs, claimant) => {
    if (targetsUsed.has(newAbs)) {
      throw new RefusalError(
        `target already claimed in this batch: ${relative(repoRoot, newAbs)} ` +
          `(wanted by both ${targetsUsed.get(newAbs)} and ${claimant})`,
      );
    }
    if (existsSync(newAbs)) {
      throw new RefusalError(`target path already exists: ${relative(repoRoot, newAbs)}`);
    }
    targetsUsed.set(newAbs, claimant);
  };

  for (const modRel of modules) {
    if (seenModules.has(modRel)) {
      throw new RefusalError(`duplicate module in batch: ${modRel}`);
    }
    seenModules.add(modRel);
    const oldAbs = resolve(repoRoot, modRel);
    if (!existsSync(oldAbs)) {
      throw new RefusalError(`module not found: ${modRel}`);
    }
    const newAbs = join(coordDir, basename(oldAbs));
    claimTarget(newAbs, modRel);

    let testMove = null;
    const oldTestAbs = pairedTestPath(oldAbs);
    if (existsSync(oldTestAbs)) {
      const newTestAbs = join(coordDir, basename(oldTestAbs));
      claimTarget(newTestAbs, `${modRel} (paired test)`);
      testMove = { oldAbs: oldTestAbs, newAbs: newTestAbs };
      oldToNew.set(oldTestAbs, newTestAbs);
    }

    moves.push({ oldAbs, newAbs, testMove });
    oldToNew.set(oldAbs, newAbs);
  }

  // Refuse a batch that would leave a moved module importing outside scripts/coord/** — that
  // is exactly the Rule 3 violation the caller's batch ordering was supposed to prevent, and
  // writing the move anyway would land a module that breaks the very next push's gate.
  for (const mv of moves) {
    const src = readFileSync(mv.oldAbs, 'utf8');
    for (const spec of specifiersOf(mv.oldAbs, src)) {
      const target = resolveLocal(mv.oldAbs, spec, scriptsDir);
      if (!target) continue; // node: builtin or bare package specifier — not this check's concern
      // `isUnder`, not `dirname(target) === coordDir`: Rule 3 admits all of scripts/coord/**,
      // SUBDIRECTORIES INCLUDED. The equality form only recognised a module sitting directly in
      // scripts/coord/, so a batch member importing scripts/coord/land/registry.mjs — already a
      // legal coord import — was refused as a Rule 3 violation (hit on plan 3962 Phase 2 batch 4,
      // coord-config.mjs -> ./coord/land/registry.mjs, and it cascaded into a false refusal of
      // every later batch).
      const landsInCoord = oldToNew.has(target) || isUnder(target, coordDir);
      if (!landsInCoord) {
        throw new RefusalError(
          `${relative(repoRoot, mv.oldAbs)} imports '${spec}' (-> ${relative(repoRoot, target)}), ` +
            'which would remain outside scripts/coord/** after this move — Rule 3 violation; ' +
            'add it to this batch or move it first',
        );
      }
    }
  }

  // Shim validation: every requested name must be one of the modules in THIS batch, and must
  // already export the entry point (`main`) the shim will call — refuse rather than write a
  // shim that imports a name the module never exports.
  const shimPlans = [];
  for (const name of shims) {
    const mv = moves.find((m) => basename(m.newAbs, '.mjs') === name);
    if (!mv) {
      throw new RefusalError(`shim target not in this batch's modules list: ${name}`);
    }
    const src = readFileSync(mv.oldAbs, 'utf8');
    if (!exportsEntry(mv.oldAbs, src)) {
      throw new RefusalError(
        `shim target '${name}' exports no entry point ` +
          '(expected `export function main(...)` or `export { ..., main }`)',
      );
    }
    shimPlans.push({ name, coordAbs: mv.newAbs, shimAbs: join(scriptsDir, `${name}.mjs`) });
  }

  // Rewrite every importer. Every non-test AND test `.mjs` under scriptsDir is a candidate —
  // a test file is explicitly allowed to import across scripts/coord/'s boundary (module-graph
  // excludes tests from Rule 3), but its specifiers to a MOVED module still need rewriting or
  // the test breaks at import time regardless of Rule 3.
  const allFiles = walk(scriptsDir, (p) => p.endsWith('.mjs'));
  const rewrites = [];
  for (const file of allFiles) {
    const src = readFileSync(file, 'utf8');
    const spans = findSpecifierSpans(src);
    if (spans.length === 0) continue;
    // Where this file's content will physically live once the batch's moves are applied — its
    // own new path if it is itself moving, otherwise unchanged. Every rewritten specifier must
    // be computed relative to THIS directory, not the file's old one.
    const destAbs = oldToNew.get(file) ?? file;
    let out = src;
    const changes = [];
    // Descending order so earlier splice offsets stay valid as later ones are applied.
    for (const span of [...spans].sort((a, b) => b.start - a.start)) {
      const target = resolveLocal(file, span.specifier, scriptsDir);
      if (!target) continue; // node: builtin or bare package specifier
      // A specifier needs recomputing whenever EITHER end of it moves — not only when the
      // TARGET is in this batch. An importer that itself moves (e.g. a .test.mjs pair riding
      // along with its module) still needs its import of an untouched sibling rewritten, since
      // its own directory just changed even though that sibling's did not.
      const newTargetAbs = oldToNew.get(target) ?? target;
      const newSpecifier = relSpecifier(dirname(destAbs), newTargetAbs);
      if (newSpecifier === span.specifier) continue; // neither end's relative path changed
      out = out.slice(0, span.start) + newSpecifier + out.slice(span.end);
      changes.unshift({ old: span.specifier, new: newSpecifier });
    }
    if (changes.length > 0) {
      rewrites.push({ oldAbs: file, newAbs: destAbs, changes, newContent: out });
    }
  }

  return { moves, shims: shimPlans, rewrites, scriptsDir, repoRoot, coordDir };
}

function gitMv(repoRoot, oldAbs, newAbs) {
  execFileSync('git', ['mv', relative(repoRoot, oldAbs), relative(repoRoot, newAbs)], {
    cwd: repoRoot,
    stdio: 'pipe',
    env: gitRepoIsolatedEnv(),
  });
}

// A module whose CLI guard does more than call `main` exports `cliMain` instead, so the guard and
// the shim run the SAME function and the two invocation paths cannot diverge (the shape that
// silently disabled select-battery-tests.mjs's --data-triggered mode). Prefer it when present.
function entryExportName(src) {
  return /^export\s+(?:async\s+)?function\s+cliMain\b/m.test(src) ? 'cliMain' : 'main';
}

function shimSource(name, entry = 'main') {
  return (
    `#!/usr/bin/env node\n` +
    `// scripts/${name}.mjs — path-compat shim: the real module moved to\n` +
    `// scripts/coord/${name}.mjs (move-to-coord.mjs, vetapp plan 3962). Re-exports its entry\n` +
    `// point so any hook, skill, runbook or allow-list still invoking this path by name keeps\n` +
    `// working unchanged.\n` +
    `import { ${entry} as main } from './coord/${name}.mjs';\n\n` +
    `try {\n` +
    `  // ASSIGN ONLY A NUMBER. Two entry-point contracts are live in this tree: a \`main\` that\n` +
    `  // RETURNS its exit code, and one that sets \`process.exitCode\` itself and returns undefined.\n` +
    `  // A bare \`process.exitCode = await main(...)\` silently RESETS the second kind to 0 - which\n` +
    `  // turned compute-push-diff.mjs's \`--drain-status-only\` "no" into a "yes" and skipped the\n` +
    `  // pre-push gate battery on a push carrying real code (plan 3962 Phase 2).\n` +
    `  const code = await main(process.argv.slice(2));\n` +
    `  if (typeof code === 'number') process.exitCode = code;\n` +
    `} catch (e) {\n` +
    `  console.error('${name}:', e?.message ?? e);\n` +
    `  process.exitCode = 1;\n` +
    `}\n`
  );
}

function summarize(plan) {
  return {
    modulesMoved: plan.moves.length,
    testsMoved: plan.moves.filter((m) => m.testMove).length,
    importersTouched: plan.rewrites.length,
    specifiersRewritten: plan.rewrites.reduce((n, r) => n + r.changes.length, 0),
    shimsWritten: plan.shims.length,
  };
}

/**
 * Execute a plan from `planMove()`. `dryRun` (default true) writes NOTHING — it only returns
 * the same summary counts a real apply would report, so a caller can print them without risk.
 */
export function applyMove(plan, { dryRun = true } = {}) {
  if (dryRun) return summarize(plan);

  mkdirSync(plan.coordDir, { recursive: true });
  for (const mv of plan.moves) {
    gitMv(plan.repoRoot, mv.oldAbs, mv.newAbs);
    if (mv.testMove) gitMv(plan.repoRoot, mv.testMove.oldAbs, mv.testMove.newAbs);
  }
  // git mv relocates content unchanged; only files with an actual specifier change need a
  // rewrite on top, and only at their (possibly new) location.
  for (const rw of plan.rewrites) {
    writeFileSync(rw.newAbs, rw.newContent, 'utf8');
  }
  for (const sp of plan.shims) {
    writeFileSync(
      sp.shimAbs,
      shimSource(sp.name, entryExportName(readFileSync(sp.coordAbs, 'utf8'))),
      'utf8',
    );
  }
  return summarize(plan);
}

/** Human-readable per-file plan, printed under `--dry-run` so it can be checked by eye. */
export function formatPlanReport(plan) {
  const lines = [];
  const testCount = plan.moves.filter((m) => m.testMove).length;
  lines.push(`move-to-coord: ${plan.moves.length} module(s), ${testCount} paired test(s)`);
  for (const mv of plan.moves) {
    lines.push(
      `  MOVE  ${relative(plan.repoRoot, mv.oldAbs)} -> ${relative(plan.repoRoot, mv.newAbs)}`,
    );
    if (mv.testMove) {
      lines.push(
        `  MOVE  ${relative(plan.repoRoot, mv.testMove.oldAbs)} -> ` +
          `${relative(plan.repoRoot, mv.testMove.newAbs)}`,
      );
    }
  }
  for (const sp of plan.shims) {
    lines.push(`  SHIM  scripts/${sp.name}.mjs -> ${relative(plan.repoRoot, sp.coordAbs)}`);
  }
  lines.push(`move-to-coord: ${plan.rewrites.length} importer(s) touched`);
  for (const rw of plan.rewrites) {
    const n = rw.changes.length;
    lines.push(
      `  REWRITE  ${relative(plan.repoRoot, rw.oldAbs)} (${n} specifier${n === 1 ? '' : 's'})`,
    );
    for (const c of rw.changes) lines.push(`      ${c.old}  ->  ${c.new}`);
  }
  return lines.join('\n');
}

export function parseArgs(argv) {
  const modules = [];
  const shims = [];
  let manifestPath = null;
  let apply = false;
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--manifest') manifestPath = argv[(i += 1)];
    else if (a === '--shim') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) shims.push(argv[(i += 1)]);
    } else if (!a.startsWith('--')) modules.push(a);
    else throw new RefusalError(`unknown flag: ${a}`);
  }
  if (manifestPath) {
    const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));
    if (Array.isArray(manifest.modules)) modules.push(...manifest.modules);
    if (Array.isArray(manifest.shims)) shims.push(...manifest.shims);
  }
  // --dry-run always wins over --apply, so a mistaken combination of both is the safe reading.
  return { modules, shims, apply: apply && !explicitDryRun };
}

export function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error(`move-to-coord: ${e.message}`);
    return 2;
  }
  let plan;
  try {
    plan = planMove({ modules: parsed.modules, shims: parsed.shims });
  } catch (e) {
    if (e instanceof RefusalError) {
      console.error(`move-to-coord: refused — ${e.message}`);
      return 1;
    }
    throw e;
  }
  console.log(formatPlanReport(plan));
  if (!parsed.apply) {
    console.log('move-to-coord: dry-run — nothing written (pass --apply to write)');
    applyMove(plan, { dryRun: true }); // for symmetry with the real path; writes nothing
    return 0;
  }
  const summary = applyMove(plan, { dryRun: false });
  console.log(
    `move-to-coord: applied — ${summary.modulesMoved} modules, ${summary.testsMoved} tests, ` +
      `${summary.importersTouched} importers touched, ${summary.specifiersRewritten} specifiers ` +
      `rewritten, ${summary.shimsWritten} shims written`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error('move-to-coord:', e.message);
    process.exitCode = 2;
  }
}
