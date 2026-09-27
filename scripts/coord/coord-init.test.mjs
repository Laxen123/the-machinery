// scripts/coord/coord-init.test.mjs — unit tests for coord-init.mjs (plan 3958), the
// adopt-the-kit-into-an-existing-repo command. The kit root under test is a FIXTURE tree this
// file builds (a handful of files per category, a fake .claude/settings.json with two hook
// events and a pre-existing allow rule) — never the real vetapp tree, so these tests stay fast
// and independent of whatever this checkout's own scripts/coord/** currently contains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedMkdtempSync } from '../test-helpers/tracked-tmpdir.mjs';
import {
  DEFAULT_COORD_CONFIG,
  laneFolders,
  ledgerSkeletons,
  mergeAllowInto,
  mergePackageJson,
  mergeSettingsHooks,
  run,
} from './coord-init.mjs';
import { normalizeConfig } from './coord-config.mjs';

const mkdtempSync = trackedMkdtempSync();
const HERE = dirname(fileURLToPath(import.meta.url));
const COORD_INIT_PATH = join(HERE, 'coord-init.mjs');

function write(dir, rel, content) {
  const abs = join(dir, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// A small fixture kit root: a few files under each category coord-init.mjs copies, a
// package.json with devDependencies/scripts, and a .claude/settings.json with two hook events
// (one wiki-loader, so --no-wiki has something real to strip) and one pre-existing-shaped allow
// rule the target will also carry, to exercise the union.
function buildFixtureKit(baseDir) {
  const kitRoot = mkdtempSync(join(baseDir, 'kit-'));
  write(kitRoot, 'scripts/coord/board-lib.mjs', '// fixture board-lib stub\nexport const X = 1;\n');
  write(kitRoot, 'scripts/coord/board-lib.test.mjs', '// fixture test stub\n');
  write(kitRoot, 'scripts/test-helpers/helper.mjs', '// fixture test helper\n');
  write(kitRoot, 'scripts/hooks/worktree-guard.sh', '#!/bin/sh\nexit 0\n');
  write(kitRoot, 'scripts/claim-plan.mjs', '// fixture top-level command\n');
  write(kitRoot, 'scripts/claim-plan.test.mjs', '// fixture command test\n');
  write(kitRoot, '.husky/pre-commit', '#!/bin/sh\nexit 0\n');
  write(kitRoot, '.husky/pre-push', '#!/bin/sh\nexit 0\n');
  write(kitRoot, 'coord/skills/pickup-plan/SKILL.md', '# pickup-plan\n');
  write(kitRoot, '.claude/commands/landing-queue.md', '# /landing-queue\n');
  write(kitRoot, '.claude/workflows/sonnet-review.js', '// fixture workflow\n');
  write(kitRoot, 'docs/coord/concepts.md', '# Coordination concepts\n');
  write(kitRoot, 'docs/superpowers/AUDIT-RUNBOOK.md', '# Audit runbook\n');
  write(kitRoot, 'docs/superpowers/audit-harness/schemas/finding.schema.json', '{}\n');
  write(kitRoot, 'WIKI.md', '# WIKI\n\nHow the vault works.\n');
  write(kitRoot, '.gitignore', 'node_modules/\n.scratch/\n.claude/worktrees/\n.drain-status/\n');
  write(kitRoot, '.prettierignore', 'node_modules/\n.husky/\npnpm-lock.yaml\n');
  write(kitRoot, 'wiki/index.md', '# Index\n');
  write(kitRoot, 'wiki/hot.md', '# Hot\n');
  write(kitRoot, 'wiki/log.md', '# Log\n');
  write(
    kitRoot,
    'package.json',
    JSON.stringify(
      {
        devDependencies: { prettier: '^3.8.3' },
        scripts: { test: 'node --test "scripts/**/*.test.mjs"', prepare: 'husky' },
      },
      null,
      2,
    ) + '\n',
  );
  write(
    kitRoot,
    '.claude/settings.json',
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: 'node scripts/hooks/worktree-guard.mjs' },
                { type: 'command', command: 'node scripts/hooks/bash-shape-guard.mjs' },
              ],
            },
          ],
          Stop: [
            { hooks: [{ type: 'command', command: 'node scripts/hooks/path-wiki-loader.mjs' }] },
          ],
        },
        permissions: { allow: ['Bash(git *)', 'Bash(node *)'] },
      },
      null,
      2,
    ) + '\n',
  );
  return kitRoot;
}

function makeGitRepo(baseDir) {
  const repo = mkdtempSync(join(baseDir, 'target-'));
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'coord-init-test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'coord-init-test'], { cwd: repo });
  return repo;
}

// Recursive content hash of a directory (excluding .git), for the idempotency check — sorted
// relative paths so it's independent of readdir order.
function hashTree(root) {
  const files = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else files.push(r);
    }
  };
  walk(root, '');
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(join(root, f)));
    h.update('\0');
  }
  return h.digest('hex');
}

// Updated for plan 4071 (core rebase drift, not a coord-init change): the CORE
// normalizeConfig() default moved from vetapp's own SEED-WRITE/--seed-write pair to the
// project-neutral DATA-WRITE/--data-write pair (coord-config.mjs's DEFAULT_MUTATION_BANNER),
// since a fresh coord-kit adopt has no vetapp seed concept to name. claim-plan.mjs's OWN
// `acquire` subcommand still hard-literals `--seed-write` regardless of this config value (noted
// in this plan's hand-back: "unlike next-plan-id.mjs claim it does NOT read
// mutationBanner.flag") — a known, separate gap this test no longer claims to cover.
test('coord-init: DEFAULT_COORD_CONFIG does not override mutationBanner — the neutral code default (DATA-WRITE / --data-write) applies (finding 3e5bc8)', () => {
  assert.ok(!('mutationBanner' in DEFAULT_COORD_CONFIG));
  const cfg = normalizeConfig(DEFAULT_COORD_CONFIG);
  assert.deepEqual(cfg.mutationBanner, { label: 'DATA-WRITE', flag: '--data-write' });
});

test('coord-init: laneFolders derives the 10 lanes from normalizeConfig(DEFAULT_COORD_CONFIG)', () => {
  assert.deepEqual(laneFolders(), [
    'in-progress',
    'ready',
    'pending-approval',
    'waiting-blocked',
    'waiting-operator',
    'waiting-grill',
    'waiting-date',
    'waiting-trip',
    'archive',
    'parked',
  ]);
});

test('coord-init: (a) fresh target — everything created, hooks + allow merged', () => {
  const base = mkdtempSync(join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'coord-init-a-'));
  const kitRoot = buildFixtureKit(base);
  const target = makeGitRepo(base);

  const result = run({ target, kitRoot });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);

  const created = new Set(result.summary.created);
  assert.equal(result.summary.unchanged.length, 0);
  assert.equal(result.summary.skippedDiffers.length, 0);
  // generated scaffolding
  for (const folder of laneFolders()) {
    assert.ok(created.has(`docs/superpowers/plans/${folder}/.gitkeep`), folder);
  }
  assert.ok(created.has('docs/handoff/board.md'));
  assert.ok(created.has('docs/handoff/sessions/.gitkeep'));
  assert.ok(created.has('docs/INDEX.md'));
  assert.ok(created.has('coord.config.json'));
  // plan 4218 T6: the ledger/folder skeletons the shipped skills and tools name by path
  for (const [rel, content] of ledgerSkeletons()) {
    assert.ok(created.has(rel), rel);
    assert.equal(readFileSync(join(target, ...rel.split('/')), 'utf8'), content, rel);
  }
  // copied kit trees
  assert.ok(created.has('scripts/coord/board-lib.mjs'));
  assert.ok(created.has('scripts/coord/board-lib.test.mjs'));
  assert.ok(created.has('scripts/test-helpers/helper.mjs'));
  assert.ok(created.has('scripts/hooks/worktree-guard.sh'));
  assert.ok(created.has('scripts/claim-plan.mjs'));
  assert.ok(created.has('scripts/claim-plan.test.mjs'));
  assert.ok(created.has('.husky/pre-commit'));
  assert.ok(created.has('.husky/pre-push'));
  assert.ok(created.has('coord/skills/pickup-plan/SKILL.md'));
  assert.ok(created.has('.claude/commands/landing-queue.md'));
  assert.ok(created.has('.claude/workflows/sonnet-review.js'));
  assert.ok(created.has('docs/coord/concepts.md'));
  assert.ok(created.has('docs/superpowers/AUDIT-RUNBOOK.md'));
  assert.ok(created.has('docs/superpowers/audit-harness/schemas/finding.schema.json'));
  assert.ok(created.has('WIKI.md'));
  assert.ok(created.has('.gitignore'));
  assert.ok(created.has('.prettierignore'));
  assert.ok(created.has('wiki/index.md'));
  assert.ok(created.has('wiki/hot.md'));
  assert.ok(created.has('wiki/log.md'));
  assert.ok(created.has('.claude/settings.json'));
  assert.ok(created.has('package.json'));

  // 3 hooks in the fixture kit settings (2 under PreToolUse/Bash + 1 under Stop), 2 allow rules
  assert.equal(result.summary.mergedHooks, 3);
  assert.equal(result.summary.mergedAllow, 2);

  // spot-check byte-identical copy + the coord.config.json content is exactly the kit default
  assert.equal(
    readFileSync(join(target, 'scripts/coord/board-lib.mjs'), 'utf8'),
    readFileSync(join(kitRoot, 'scripts/coord/board-lib.mjs'), 'utf8'),
  );
  assert.equal(
    readFileSync(join(target, 'coord.config.json'), 'utf8'),
    JSON.stringify(DEFAULT_COORD_CONFIG, null, 2) + '\n',
  );
  const settings = JSON.parse(readFileSync(join(target, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 2);
  assert.equal(settings.hooks.Stop[0].hooks.length, 1);
  assert.deepEqual(settings.permissions.allow, ['Bash(git *)', 'Bash(node *)']);
});

// S3 (2026-09-24, session 4277): coord-init adopts the kit's .gitignore when the target has
// none (test (a) above already covers the fresh-target create), but must never touch an
// EXISTING target .gitignore — classify()'s create-if-absent-only rule, same as every other
// simple entry. Content differs is reported as skipped-differs (never merged/overwritten), and
// content byte-identical is reported unchanged — both leave the target file untouched.
test('coord-init: an existing target .gitignore/.prettierignore is never overwritten (adoption is create-if-absent only)', () => {
  const base = mkdtempSync(
    join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'coord-init-gitignore-'),
  );
  const kitRoot = buildFixtureKit(base);
  const target = makeGitRepo(base);
  write(target, '.gitignore', 'my-own-ignore-rule/\n');
  write(target, '.prettierignore', 'my-own-prettier-ignore/\n');

  const result = run({ target, kitRoot });
  assert.equal(result.ok, true);
  const created = new Set(result.summary.created);
  const skippedDiffers = new Set(result.summary.skippedDiffers);
  assert.ok(!created.has('.gitignore'));
  assert.ok(!created.has('.prettierignore'));
  assert.ok(skippedDiffers.has('.gitignore'));
  assert.ok(skippedDiffers.has('.prettierignore'));
  assert.equal(readFileSync(join(target, '.gitignore'), 'utf8'), 'my-own-ignore-rule/\n');
  assert.equal(readFileSync(join(target, '.prettierignore'), 'utf8'), 'my-own-prettier-ignore/\n');
});

test('coord-init: (b) second run is a total no-op (idempotent)', () => {
  const base = mkdtempSync(join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'coord-init-b-'));
  const kitRoot = buildFixtureKit(base);
  const target = makeGitRepo(base);

  const first = run({ target, kitRoot });
  assert.equal(first.ok, true);
  const hashAfterFirst = hashTree(target);

  const second = run({ target, kitRoot });
  assert.equal(second.ok, true);
  assert.equal(second.summary.created.length, 0);
  assert.equal(second.summary.skippedDiffers.length, 0);
  assert.equal(second.summary.mergedHooks, 0);
  assert.equal(second.summary.mergedAllow, 0);
  assert.ok(second.summary.unchanged.length > 0);
  // plan 4218 T6: the ledger skeletons are part of the no-op — each one reported unchanged.
  const unchanged = new Set(second.summary.unchanged);
  for (const [rel] of ledgerSkeletons()) assert.ok(unchanged.has(rel), rel);
  assert.ok(unchanged.has('docs/superpowers/AUDIT-RUNBOOK.md'));

  assert.equal(hashTree(target), hashAfterFirst);
});

test('coord-init: (c) settings merge — identical hook untouched, conflicting hook appended, allow unioned', () => {
  const targetSettings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'node scripts/hooks/worktree-guard.mjs' }],
        },
      ],
    },
    permissions: { allow: ['Bash(git *)'] },
  };
  const kitSettings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            // same identity (event=PreToolUse, matcher=Bash, command=worktree-guard.mjs) — untouched
            { type: 'command', command: 'node scripts/hooks/worktree-guard.mjs' },
            // same event+matcher, different command — appended as a sibling
            { type: 'command', command: 'node scripts/hooks/bash-shape-guard.mjs' },
          ],
        },
      ],
    },
    permissions: { allow: ['Bash(git *)', 'Bash(node *)'] },
  };

  const { settings, merged } = mergeSettingsHooks(targetSettings, kitSettings);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].command, 'node scripts/hooks/bash-shape-guard.mjs');
  assert.equal(settings.hooks.PreToolUse.length, 1); // same matcher group, not duplicated
  assert.deepEqual(
    settings.hooks.PreToolUse[0].hooks.map((h) => h.command),
    ['node scripts/hooks/worktree-guard.mjs', 'node scripts/hooks/bash-shape-guard.mjs'],
  );

  const addedAllow = mergeAllowInto(settings, kitSettings);
  assert.equal(addedAllow, 1);
  assert.deepEqual(settings.permissions.allow, ['Bash(git *)', 'Bash(node *)']);

  // Event+matcher entirely absent from the target — the whole matcher group is appended.
  const { settings: s2, merged: merged2 } = mergeSettingsHooks(
    {},
    { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } },
  );
  assert.equal(merged2.length, 1);
  assert.equal(s2.hooks.Stop.length, 1);
  assert.equal(s2.hooks.Stop[0].hooks[0].command, 'x');
});

test('coord-init: package.json merge never overwrites an existing key', () => {
  const targetPkg = { devDependencies: { prettier: '^2.0.0' }, scripts: { test: 'echo mine' } };
  const kitPkg = {
    devDependencies: { prettier: '^3.8.3', husky: '^9.1.7' },
    scripts: { test: 'node --test', lint: 'prettier --check .' },
  };
  const { pkg, added } = mergePackageJson(targetPkg, kitPkg);
  assert.equal(pkg.devDependencies.prettier, '^2.0.0'); // untouched
  assert.equal(pkg.devDependencies.husky, '^9.1.7'); // added
  assert.equal(pkg.scripts.test, 'echo mine'); // untouched
  assert.equal(pkg.scripts.lint, 'prettier --check .'); // added
  assert.equal(added, 2);
});

test('coord-init: an adopter-owned `prepare` keeps its steps and gains the kit steps it lacks', () => {
  const kitPkg = { scripts: { prepare: 'husky && node scripts/ensure-wiki-merge-driver.mjs' } };
  const own = mergePackageJson({ scripts: { prepare: 'patch-package' } }, kitPkg);
  assert.equal(
    own.pkg.scripts.prepare,
    'patch-package && husky && node scripts/ensure-wiki-merge-driver.mjs',
  );
  assert.equal(own.added, 1);
  // A step already present is not repeated, and a complete body is left byte-identical.
  const partial = mergePackageJson({ scripts: { prepare: 'husky' } }, kitPkg);
  assert.equal(partial.pkg.scripts.prepare, 'husky && node scripts/ensure-wiki-merge-driver.mjs');
  const done = mergePackageJson({ scripts: { prepare: kitPkg.scripts.prepare } }, kitPkg);
  assert.equal(done.pkg.scripts.prepare, kitPkg.scripts.prepare);
  assert.equal(done.added, 0);
});

test('coord-init: (d) --no-wiki skips WIKI.md/wiki/*.md and the wiki-loader hook', () => {
  const base = mkdtempSync(join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'coord-init-d-'));
  const kitRoot = buildFixtureKit(base);
  const target = makeGitRepo(base);

  const result = run({ target, kitRoot, noWiki: true });
  assert.equal(result.ok, true);
  const created = new Set(result.summary.created);
  assert.ok(!created.has('WIKI.md'));
  assert.ok(!created.has('wiki/index.md'));
  assert.ok(!created.has('wiki/hot.md'));
  assert.ok(!created.has('wiki/log.md'));
  // Only the 2 PreToolUse/Bash hooks merge; the Stop/path-wiki-loader hook is stripped.
  assert.equal(result.summary.mergedHooks, 2);
  const settings = JSON.parse(readFileSync(join(target, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.hooks.Stop, undefined);
});

test('coord-init: (e) --dry-run computes the plan but writes nothing', () => {
  const base = mkdtempSync(join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'coord-init-e-'));
  const kitRoot = buildFixtureKit(base);
  const target = makeGitRepo(base);
  const hashBefore = hashTree(target);

  const result = run({ target, kitRoot, dryRun: true });
  assert.equal(result.ok, true);
  assert.ok(result.summary.created.length > 0); // the plan is still computed
  assert.equal(hashTree(target), hashBefore); // nothing was actually written
});

test('coord-init: (g) --dry-run against a target with a CONFLICTING existing .claude/settings.json reports the merge it would make, and writes nothing (finding 159cab)', () => {
  const base = mkdtempSync(join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'coord-init-g-'));
  const kitRoot = buildFixtureKit(base);
  const target = makeGitRepo(base);

  // An existing settings.json missing the fixture kit's Stop/path-wiki-loader hook and one allow
  // rule — merging the kit's settings into it changes its content (settingsChanged === true).
  const existingSettings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'node scripts/hooks/worktree-guard.mjs' },
            { type: 'command', command: 'node scripts/hooks/bash-shape-guard.mjs' },
          ],
        },
      ],
    },
    permissions: { allow: ['Bash(git *)'] },
  };
  const existingSettingsText = JSON.stringify(existingSettings, null, 2) + '\n';
  write(target, '.claude/settings.json', existingSettingsText);

  const result = run({ target, kitRoot, dryRun: true });
  assert.equal(result.ok, true);
  // Reported as the merge it WOULD make, not silently omitted from every list.
  assert.deepEqual(result.summary.merged, ['.claude/settings.json']);
  assert.ok(!result.summary.created.includes('.claude/settings.json'));
  assert.ok(!result.summary.unchanged.includes('.claude/settings.json'));
  assert.ok(!result.summary.skippedDiffers.includes('.claude/settings.json'));
  // Still a real preview: the merged-hook count reflects the Stop hook this run WOULD append.
  assert.equal(result.summary.mergedHooks, 1);
  assert.equal(result.summary.mergedAllow, 1);

  // --dry-run writes NOTHING: the existing file on disk is untouched.
  assert.equal(readFileSync(join(target, '.claude/settings.json'), 'utf8'), existingSettingsText);

  // A REAL run (dryRun: false) against the same conflicting target actually performs that merge.
  const real = run({ target, kitRoot, dryRun: false });
  assert.deepEqual(real.summary.merged, ['.claude/settings.json']);
  const mergedOnDisk = JSON.parse(readFileSync(join(target, '.claude/settings.json'), 'utf8'));
  assert.equal(mergedOnDisk.hooks.Stop.length, 1);
  assert.deepEqual(mergedOnDisk.permissions.allow, ['Bash(git *)', 'Bash(node *)']);
});

test('coord-init: (f) CLI on a non-git target exits 2 with a named reason', () => {
  const base = mkdtempSync(join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'coord-init-f-'));
  const nonGit = mkdtempSync(join(base, 'not-a-repo-'));
  const proc = spawnSync(process.execPath, [COORD_INIT_PATH, '--target', nonGit], {
    encoding: 'utf8',
  });
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /not a git repository/);
});

test('coord-init: CLI dry-run against the real (auto-detected) kit root exits 0', () => {
  const base = mkdtempSync(
    join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'coord-init-real-'),
  );
  const target = makeGitRepo(base);
  const proc = spawnSync(
    process.execPath,
    [COORD_INIT_PATH, '--target', target, '--dry-run', '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(proc.status, 0);
  const parsed = JSON.parse(proc.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
});
