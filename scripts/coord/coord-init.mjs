#!/usr/bin/env node
// scripts/coord/coord-init.mjs
// Adopt the coord-kit's coordination machinery into an EXISTING repo (plan 3958). Run from a
// kit checkout — it locates the kit root from its own import.meta.url (two directories up from
// scripts/coord/). Rule 3 (docs/runbooks/scripts-module-layout.md): this module imports only
// node: builtins and scripts/coord/** siblings.
//
// Usage: node scripts/coord/coord-init.mjs [--target <repo>] [--no-wiki] [--dry-run] [--json]
// Target defaults to cwd.
//
// What it does, against --target (writes only under the target path as resolved by the caller —
// it does not follow or guard against a symlink/junction inside the target pointing elsewhere):
//   1. refuses if target is not a git repository (exit 2);
//   2. generates the scaffolding a coord-kit-adopting repo needs but a kit checkout's own tree
//      never carries as static content, because it is per-adoption data: the plan lanes (10
//      `.gitkeep`s), docs/handoff/board.md (a BOARD-START/END sentinel skeleton — see
//      board-lib.mjs), docs/handoff/sessions/.gitkeep, docs/INDEX.md (an INDEX:PLANS/INDEX:SPECS
//      sentinel skeleton — see build-index-lib.mjs), and coord.config.json (the kit's default
//      profile — sessions handoff layout only; every other key, mutationBanner included, takes
//      normalizeConfig's own code default, so no vetapp-only value — deployServices, seed lanes,
//      … — is ever inherited);
//   3. copies the kit's static trees verbatim: scripts/coord/**, scripts/test-helpers/**,
//      scripts/hooks/**, the top-level scripts/*.mjs commands (+ name-paired .test.mjs),
//      .husky/**, coord/skills/**, .claude/commands/*.md, .claude/workflows/**, docs/coord/**,
//      and — unless --no-wiki — WIKI.md + wiki/*.md;
//   4. MERGES .claude/settings.json (hook identity = event+matcher+command; an existing entry is
//      untouched, a same-event+matcher entry with a different command is appended as a sibling,
//      an absent event+matcher gets the whole matcher group appended; permissions.allow entries
//      are unioned, existing first) and package.json (devDependencies/dependencies/scripts added
//      only where the key is absent — an existing script or version is never overwritten; the
//      file is created if missing) into the target;
//   5. reports created / unchanged / skipped-differs per copied file (an existing copied file
//      with DIFFERENT content from what this run would write is left alone, never overwritten),
//      plus a separate `merged` list naming .claude/settings.json and/or package.json whenever
//      an EXISTING one of those two would be rewritten by the merge (they are never
//      skipped-differs — the merge only ADDS keys/hooks, so it always applies), and the two
//      settings-merge counts.
//
// Idempotent: a second run against the same target reports zero created, zero merged (see
// coord-init.test.mjs case b). Every write is skipped under --dry-run, but the `merged` list (and
// every other summary field) is computed and reported the same regardless — the dry-run preview
// always names what a real run would actually touch. Does NOT run the smoke test itself (a
// separate command — see scripts/coord/smoke.mjs) — the non-JSON report's last line is the
// ready-to-run smoke command.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BOARD_START, BOARD_END } from './board-lib.mjs';
import { renderPlansBlock, renderSpecsBlock } from './build-index-lib.mjs';
import { normalizeConfig } from './coord-config.mjs';
import { gitIsolatedEnv } from './child-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/coord/coord-init.mjs -> scripts/ -> kit root.
const DEFAULT_KIT_ROOT = join(HERE, '..', '..');

// The kit's own default coord.config.json (plan 3958 "Measured facts"). Every OTHER
// normalizeConfig key takes its code default — this object is deliberately short: only the four
// keys that give an adopted repo vetapp's coordination SHAPE (a per-session handoff tree) are
// set; every vetapp-only VALUE (deployServices, seed lanes, worldClaimFields, …) stays at its
// empty/null generic default, never inherited. mutationBanner is deliberately NOT overridden
// here: normalizeConfig's own code default (SEED-WRITE / --seed-write, coord-config.mjs) is the
// one every shipped module — claim-plan.mjs's flag parser included — actually reads; overriding
// it here without also updating claim-plan.mjs left an adopter following generated docs hitting
// an unknown-flag error (finding 3e5bc8).
export const DEFAULT_COORD_CONFIG = Object.freeze({
  handoffLayout: 'sessions',
  handoffDir: 'docs/handoff',
  operatorSpendCeilingUsd: 5,
  plugins: Object.freeze({}),
});

// Recognizes a wiki-loader hook command (path-wiki-loader / subject-wiki-loader /
// wiki-loaders-stop / wiki-markers-compact-reset) — the four settings.json entries --no-wiki
// drops alongside WIKI.md + wiki/*.md. Shape mirrors the kit-layout brief's own enumeration.
const WIKI_HOOK_COMMAND_RX =
  /\bpath-wiki-loader|\bsubject-wiki-loader|\bwiki-loaders-stop|\bwiki-markers-compact-reset/;

const RECURSIVE_DIR_CATEGORIES = [
  'scripts/coord',
  'scripts/test-helpers',
  'scripts/hooks',
  '.husky',
  'coord/skills',
  '.claude/workflows',
  'docs/coord',
];

const SMOKE_COMMAND = 'node scripts/coord/smoke.mjs';

// ── pure helpers ──────────────────────────────────────────────────────────────────────────

function isGitRepo(dir) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
      // A local, network-free read against `dir` — the blanket strip is correct here
      // (scripts/coord/child-env.mjs gitIsolatedEnv()): an ambient GIT_DIR/GIT_WORK_TREE could
      // otherwise redirect this probe away from the target the caller named.
      env: gitIsolatedEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

function toPosix(p) {
  return p.split(sep).join('/');
}

function walkFilesRecursive(absDir, relPrefix = '') {
  const out = [];
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out; // category absent from this kit root — nothing to copy
  }
  for (const e of entries) {
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    const abs = join(absDir, e.name);
    if (e.isDirectory()) out.push(...walkFilesRecursive(abs, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function listShallowFiles(absDir, filterFn) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && filterFn(e.name)).map((e) => e.name);
}

// Classify one prospective write against what's already on disk. Never reads/writes anything
// beyond `destAbs` itself — the caller decides whether to actually apply a `create`.
function classify(targetRoot, destAbs, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const relDest = toPosix(relative(targetRoot, destAbs));
  if (!existsSync(destAbs)) return { status: 'create', destAbs, relDest, content: buf };
  const existing = readFileSync(destAbs);
  if (existing.equals(buf)) return { status: 'unchanged', destAbs, relDest };
  return { status: 'skipped-differs', destAbs, relDest };
}

// The 10 plan-lane folder names, order-then-archive-then-parked, derived from
// normalizeConfig(DEFAULT_COORD_CONFIG) rather than hand-listed — see coord-config.mjs's own
// lanes.order contract (archive/parked are always appended, never inside `order`).
export function laneFolders(cfg = normalizeConfig(DEFAULT_COORD_CONFIG)) {
  return [...cfg.lanes.order.map((k) => cfg.lanes[k]), cfg.lanes.archive, cfg.lanes.parked];
}

function boardSkeleton() {
  return [
    '# Active worktree board',
    '',
    '_Generated scaffold. Rows are written by the coord tooling (`scripts/board.mjs` / the',
    '`scripts/coord/board-lib.mjs` library) — never hand-edited._',
    '',
    BOARD_START,
    '| Worktree(slug) | Branch tip | State | Plan/claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    BOARD_END,
    '',
  ].join('\n');
}

function indexSkeleton() {
  return [
    '# Plan & Spec Index',
    '',
    '_The specs and plans regions below are generated by `node scripts/build-index.mjs` — do',
    'not hand-edit between the sentinels._',
    '',
    renderSpecsBlock([]),
    '',
    '## Plans',
    '',
    renderPlansBlock([]),
    '',
    'Moved to `docs/superpowers/plans/archive/` once a plan lands or is otherwise retired.',
    '',
  ].join('\n');
}

// Hook identity is (event, matcher-or-'', command). Mutates nothing existing: an already-present
// identity is left untouched, a same-event+matcher entry with a new command is appended to that
// matcher group's `hooks` array, and an event+matcher absent from the target gets the kit's whole
// matcher group appended. Returns the merged settings object (structurally independent of the
// input — callers may mutate the result) plus the list of individually merged {event, matcher}.
export function mergeSettingsHooks(targetSettings, kitSettings) {
  const result = structuredClone(targetSettings ?? {});
  if (!result.hooks || typeof result.hooks !== 'object') result.hooks = {};
  const merged = [];
  const kitHooksByEvent = (kitSettings && kitSettings.hooks) || {};
  for (const [event, kitGroups] of Object.entries(kitHooksByEvent)) {
    if (!Array.isArray(kitGroups)) continue;
    if (!Array.isArray(result.hooks[event])) result.hooks[event] = [];
    const targetGroups = result.hooks[event];
    for (const kitGroup of kitGroups) {
      const kitMatcher = kitGroup && kitGroup.matcher != null ? kitGroup.matcher : '';
      const kitHookList = Array.isArray(kitGroup && kitGroup.hooks) ? kitGroup.hooks : [];
      const targetGroup = targetGroups.find(
        (g) => (g && g.matcher != null ? g.matcher : '') === kitMatcher,
      );
      if (!targetGroup) {
        targetGroups.push(structuredClone(kitGroup));
        for (const h of kitHookList)
          merged.push({ event, matcher: kitMatcher, command: h.command });
        continue;
      }
      if (!Array.isArray(targetGroup.hooks)) targetGroup.hooks = [];
      for (const kitHook of kitHookList) {
        const exists = targetGroup.hooks.some((h) => h && h.command === kitHook.command);
        if (exists) continue; // same (event, matcher, command) identity — untouched
        targetGroup.hooks.push(structuredClone(kitHook));
        merged.push({ event, matcher: kitMatcher, command: kitHook.command });
      }
    }
  }
  return { settings: result, merged };
}

// permissions.allow union, set semantics, existing entries first, order preserved. Mutates and
// returns `settings` in place (paired with mergeSettingsHooks' result, same call site).
export function mergeAllowInto(settings, kitSettings) {
  const kitAllow = (kitSettings && kitSettings.permissions && kitSettings.permissions.allow) || [];
  if (!settings.permissions || typeof settings.permissions !== 'object') settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
  const allow = settings.permissions.allow;
  const seen = new Set(allow);
  let addedCount = 0;
  for (const rule of kitAllow) {
    if (seen.has(rule)) continue;
    allow.push(rule);
    seen.add(rule);
    addedCount += 1;
  }
  return addedCount;
}

// Drop wiki-loader hook entries/groups (--no-wiki) before merging. Never mutates its input.
function stripWikiHooks(settings) {
  if (!settings || !settings.hooks || typeof settings.hooks !== 'object') return settings;
  const hooks = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => ({
        ...g,
        hooks: (Array.isArray(g && g.hooks) ? g.hooks : []).filter(
          (h) => !WIKI_HOOK_COMMAND_RX.test((h && h.command) || ''),
        ),
      }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  return { ...settings, hooks };
}

// devDependencies/dependencies/scripts added only where the target key is absent — an existing
// version or script body is never overwritten. Returns the merged package.json object plus the
// count of keys actually added.
export function mergePackageJson(targetPkg, kitPkg) {
  const result = structuredClone(targetPkg ?? {});
  let added = 0;
  for (const section of ['dependencies', 'devDependencies', 'scripts']) {
    const kitSection = kitPkg && kitPkg[section];
    if (!kitSection || typeof kitSection !== 'object') continue;
    if (!result[section] || typeof result[section] !== 'object') result[section] = {};
    for (const [name, value] of Object.entries(kitSection)) {
      if (Object.prototype.hasOwnProperty.call(result[section], name)) continue;
      result[section][name] = value;
      added += 1;
    }
  }
  return { pkg: result, added };
}

function readJsonIfPresent(absPath) {
  if (!existsSync(absPath)) return null;
  return JSON.parse(readFileSync(absPath, 'utf8'));
}

// ── the adoption run (pure planning; writes only when !dryRun) ──────────────────────────────

export function run({
  target = process.cwd(),
  kitRoot = DEFAULT_KIT_ROOT,
  noWiki = false,
  dryRun = false,
} = {}) {
  if (!isGitRepo(target)) {
    return {
      ok: false,
      exitCode: 2,
      reason: `coord-init: --target ${target} is not a git repository (git rev-parse --is-inside-work-tree failed)`,
    };
  }

  const entries = [];
  const cfg = normalizeConfig(DEFAULT_COORD_CONFIG);

  // Generated, per-adoption scaffolding (§2/§3 of the header comment) — content is computed
  // here, never copied from the kit root, so it never depends on whatever happens to already
  // sit in a kit checkout's own docs/ tree.
  for (const folder of laneFolders(cfg)) {
    entries.push(
      classify(target, join(target, 'docs', 'superpowers', 'plans', folder, '.gitkeep'), ''),
    );
  }
  entries.push(classify(target, join(target, cfg.paths.boardFile), boardSkeleton()));
  entries.push(classify(target, join(target, cfg.paths.sessionsDir, '.gitkeep'), ''));
  entries.push(classify(target, join(target, 'docs', 'INDEX.md'), indexSkeleton()));
  entries.push(
    classify(
      target,
      join(target, 'coord.config.json'),
      JSON.stringify(DEFAULT_COORD_CONFIG, null, 2) + '\n',
    ),
  );

  // Static kit trees, copied verbatim.
  for (const cat of RECURSIVE_DIR_CATEGORIES) {
    const srcDir = join(kitRoot, ...cat.split('/'));
    for (const rel of walkFilesRecursive(srcDir)) {
      entries.push(
        classify(
          target,
          join(target, ...cat.split('/'), ...rel.split('/')),
          readFileSync(join(srcDir, rel)),
        ),
      );
    }
  }
  for (const name of listShallowFiles(join(kitRoot, '.claude', 'commands'), (n) =>
    n.endsWith('.md'),
  )) {
    entries.push(
      classify(
        target,
        join(target, '.claude', 'commands', name),
        readFileSync(join(kitRoot, '.claude', 'commands', name)),
      ),
    );
  }
  // `.mjs` is the top-level command shape, but scripts/exec-model-default.json is a required
  // sibling asset: exec-model-default-lib.mjs (imported by mint's next-plan-id path) reads it and
  // refuses to run without it, so an adopt that copied only the .mjs commands would leave the
  // adopted repo unable to mint.
  for (const name of listShallowFiles(
    join(kitRoot, 'scripts'),
    (n) => n.endsWith('.mjs') || n === 'exec-model-default.json',
  )) {
    entries.push(
      classify(target, join(target, 'scripts', name), readFileSync(join(kitRoot, 'scripts', name))),
    );
  }
  // .gitignore / .prettierignore adoption (S3, session 4277, plan 3958): create-if-absent only,
  // same classify() semantics as every other simple entry above — an existing target file is
  // left alone (status skipped-differs when its content differs), never merged or overwritten.
  // Without .gitignore an adopted repo would commit node_modules/, .scratch/ and
  // .claude/worktrees/ on its first coord-init smoke scaffold commit; without .prettierignore the
  // land gate's `pnpm exec prettier --check` would fail on pnpm-lock.yaml itself (S3: the kit is
  // pnpm-only, and pnpm rewrites that lockfile in a shape prettier does not format).
  for (const name of ['.gitignore', '.prettierignore']) {
    const kitFileAbs = join(kitRoot, name);
    if (existsSync(kitFileAbs)) {
      entries.push(classify(target, join(target, name), readFileSync(kitFileAbs)));
    }
  }
  if (!noWiki) {
    const wikiMdAbs = join(kitRoot, 'WIKI.md');
    if (existsSync(wikiMdAbs))
      entries.push(classify(target, join(target, 'WIKI.md'), readFileSync(wikiMdAbs)));
    for (const name of listShallowFiles(join(kitRoot, 'wiki'), (n) => n.endsWith('.md'))) {
      entries.push(
        classify(target, join(target, 'wiki', name), readFileSync(join(kitRoot, 'wiki', name))),
      );
    }
  }

  // .claude/settings.json merge.
  const settingsDestAbs = join(target, '.claude', 'settings.json');
  const settingsExistedBefore = existsSync(settingsDestAbs);
  const targetSettings = readJsonIfPresent(settingsDestAbs) ?? {};
  let kitSettings = readJsonIfPresent(join(kitRoot, '.claude', 'settings.json')) ?? {};
  if (noWiki) kitSettings = stripWikiHooks(kitSettings);
  const { settings: mergedSettings, merged: mergedHooks } = mergeSettingsHooks(
    targetSettings,
    kitSettings,
  );
  const mergedAllowCount = mergeAllowInto(mergedSettings, kitSettings);
  const settingsText = JSON.stringify(mergedSettings, null, 2) + '\n';
  const settingsChanged =
    !settingsExistedBefore || readFileSync(settingsDestAbs, 'utf8') !== settingsText;
  if (!settingsExistedBefore) {
    entries.push({
      status: 'create',
      destAbs: settingsDestAbs,
      relDest: '.claude/settings.json',
      content: Buffer.from(settingsText, 'utf8'),
    });
  } else if (settingsChanged) {
    // Existing file, merge produces different content: a real run overwrites it at line ~402;
    // report that here too (dry-run included) so the plan a dry-run prints matches what a real
    // run would actually write, instead of silently omitting it (finding 159cab).
    entries.push({
      status: 'merged',
      destAbs: settingsDestAbs,
      relDest: '.claude/settings.json',
    });
  }

  // package.json merge.
  const pkgDestAbs = join(target, 'package.json');
  const pkgExistedBefore = existsSync(pkgDestAbs);
  const targetPkg = readJsonIfPresent(pkgDestAbs) ?? {};
  const kitPkg = readJsonIfPresent(join(kitRoot, 'package.json')) ?? {};
  const { pkg: mergedPkg, added: addedPackageKeys } = mergePackageJson(targetPkg, kitPkg);
  const pkgText = JSON.stringify(mergedPkg, null, 2) + '\n';
  const pkgChanged = !pkgExistedBefore || readFileSync(pkgDestAbs, 'utf8') !== pkgText;
  if (!pkgExistedBefore) {
    entries.push({
      status: 'create',
      destAbs: pkgDestAbs,
      relDest: 'package.json',
      content: Buffer.from(pkgText, 'utf8'),
    });
  } else if (pkgChanged) {
    // Same reasoning as the settings.json branch above: report the merge a real run would make.
    entries.push({
      status: 'merged',
      destAbs: pkgDestAbs,
      relDest: 'package.json',
    });
  }

  if (!dryRun) {
    for (const e of entries) {
      if (e.status !== 'create') continue;
      mkdirSync(dirname(e.destAbs), { recursive: true });
      writeFileSync(e.destAbs, e.content);
    }
    if (settingsExistedBefore && settingsChanged) writeFileSync(settingsDestAbs, settingsText);
    if (pkgExistedBefore && pkgChanged) writeFileSync(pkgDestAbs, pkgText);
  }

  const created = entries
    .filter((e) => e.status === 'create')
    .map((e) => e.relDest)
    .sort();
  const unchanged = entries
    .filter((e) => e.status === 'unchanged')
    .map((e) => e.relDest)
    .sort();
  const skippedDiffers = entries
    .filter((e) => e.status === 'skipped-differs')
    .map((e) => e.relDest)
    .sort();
  // settings.json / package.json whose EXISTING content the merge would change (never a
  // straight create-or-skip like the entries above) — reported the same in dry-run and a real
  // run, so the dry-run preview always matches what `!dryRun` actually writes at lines ~402-403.
  const merged = entries
    .filter((e) => e.status === 'merged')
    .map((e) => e.relDest)
    .sort();

  return {
    ok: true,
    exitCode: 0,
    target,
    dryRun,
    wiki: !noWiki,
    summary: {
      created,
      unchanged,
      skippedDiffers,
      merged,
      mergedHooks: mergedHooks.length,
      mergedAllow: mergedAllowCount,
    },
    mergedHooksDetail: mergedHooks,
    addedPackageKeys,
    settingsMergedNoNewKeys: settingsExistedBefore && !settingsChanged,
    packageJsonMergedNoNewKeys: pkgExistedBefore && !pkgChanged,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { target: process.cwd(), noWiki: false, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') out.target = argv[++i];
    else if (a === '--no-wiki') out.noWiki = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const result = run({ target: opts.target, noWiki: opts.noWiki, dryRun: opts.dryRun });

  if (!result.ok) {
    if (opts.json) console.log(JSON.stringify({ ok: false, reason: result.reason }));
    else console.error(result.reason);
    return result.exitCode;
  }

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...result.summary, dryRun: result.dryRun }));
    return 0;
  }

  const prefix = result.dryRun ? '[dry-run] ' : '';
  for (const p of result.summary.created) console.log(`${prefix}created ${p}`);
  for (const p of result.summary.unchanged) console.log(`unchanged ${p}`);
  for (const p of result.summary.skippedDiffers) console.log(`skipped-differs ${p}`);
  for (const p of result.summary.merged) console.log(`${prefix}merged ${p}`);
  for (const h of result.mergedHooksDetail)
    console.log(`${prefix}merged-hook ${h.event}/${h.matcher}`);
  console.log(
    `coord-init: ${result.summary.created.length} created, ${result.summary.unchanged.length} unchanged, ` +
      `${result.summary.skippedDiffers.length} skipped-differs, ${result.summary.merged.length} merged, ` +
      `${result.summary.mergedHooks} hooks merged, ${result.summary.mergedAllow} allow rules merged ` +
      `(target: ${result.target})` +
      (result.dryRun ? ' [dry-run, nothing written]' : ''),
  );
  console.log(SMOKE_COMMAND);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
