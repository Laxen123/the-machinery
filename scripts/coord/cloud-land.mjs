#!/usr/bin/env node
// scripts/cloud-land.mjs — hand a BUILT, reviewed, pushed plan branch to a cloud drain to land
// (plan 4255; the `/cloud-land` skill, coord/skills/cloud-land/SKILL.md, wraps it).
//
// A local land runs the heaviest per-plan CPU job there is (full pytest, scripts battery,
// `next build`, WebKit mobile, price trust). This command takes it off the box: it checks the
// branch is ready to land, stamps the land-phase axis (`landCloudExec: true` + `landCloudEnv`),
// writes the hand-off note, frees the queue slot, re-files the plan to `ready/` (which stamps
// `adoptBranch`, plan 3111) and only then releases the claim. A cloud drain's oracle
// (`queue-drain.mjs --cloud`) then selects the plan as `landOnly`: adopt the branch, land it,
// never re-execute. Operator ruling R2 (2026-09-26): this is the DEFAULT for a local land; a plain
// `done-worktree` land is the override for an S2 refusal, an urgent land, or an operator ask.
//
// Not to be confused with scripts/hooks/cloud-land-backgrounding-guard.mjs (plan 4218), a hook
// about backgrounding INSIDE a cloud land. Unrelated to this hand-off.
//
// Usage (from the plan's worktree, or anywhere with the slug):
//   node scripts/cloud-land.mjs [<slug>] [--dry-run] [--gates-cloud-safe "<why>"]
//
//   --dry-run            judge only: print the refusals (or the steps it would run), write nothing
//   --gates-cloud-safe   assert that the local-only host/key named in the plan's cloudExec: false
//                        reason is read by the BUILD only, never by the land gates (S2 #2/#3); the
//                        assertion is written into the hand-off note
//
// Exit codes: 0 handed off (or already handed off for this HEAD), 2 refused (nothing written),
// 1 a step failed (the report names it; every step before `release` leaves the claim held, so
// fix the cause and re-run — each step is idempotent).
//
// Pure decisions live in cloud-land-lib.mjs (judgeHandoff / runHandoff); this file only gathers
// facts from git and calls the repo's own coord CLIs for the writes.

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMain } from './coord-git.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';
import { parseWorktreePorcelain } from './worktree-porcelain.mjs';
import { parseStatusPaths } from './gate-pass-cache.mjs';
import { loadCoordConfig } from './coord-config.mjs';
import { readFrontmatterScalar } from './build-index-lib.mjs';
import { planIdFromBasename } from './plan-adopt-branch.mjs';
import { slugFromBranch } from './redgreen-lib.mjs';
import {
  MARKER_FAMILIES,
  findingsSidecarPath,
  parseFindingsRecord,
  planIdInTree,
} from './review-markers.mjs';
import {
  ORIGIN_FIRST_REFS,
  pickFreshestMarker,
  readSessionCandidates,
  resolveMarkerSource,
} from './record-marker-cli.mjs';
import { findingsGate } from './done-worktree-lib.mjs';
import { planStatus } from './claim-plan.mjs';
import { DEFAULT_LAND_CLOUD_ENV, judgeHandoff, runHandoff } from './cloud-land-lib.mjs';

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = 'cloud-land';

function git(cwd, args) {
  // Repo-isolated env: an ambient GIT_DIR/GIT_WORK_TREE must not redirect `-C <cwd>` (plan 4087).
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitRepoIsolatedEnv(),
  });
}

function gitOrNull(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

// Run one of the repo's own coord CLIs; throw on a non-zero exit so runHandoff names the step.
function runScript(cwd, script, args) {
  const r = spawnSync(process.execPath, [join(SCRIPTS_DIR, script), ...args], {
    cwd,
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(`${script} ${args.join(' ')} exited ${r.status ?? r.signal}`);
}

// The claim read, through claim-plan's own planStatus (review r4 855614) — never a parse of its CLI
// output, which degraded to "not held" on any format change and misreported a held claim.
function claimStatus(MAIN, planId) {
  return planStatus(MAIN, planId);
}

function worktreeFor(MAIN, branch) {
  const out = git(MAIN, ['worktree', 'list', '--porcelain']);
  return parseWorktreePorcelain(out).find((e) => e.branch === branch)?.path ?? null;
}

// The plan file for `planId` on origin/master: { path, folder, content } or null.
function planOnOrigin(MAIN, planId) {
  const listing = git(MAIN, [
    'ls-tree',
    '-r',
    '--name-only',
    'origin/master',
    '--',
    'docs/superpowers/plans/',
  ]);
  const path = listing
    .split('\n')
    .filter((p) => p.endsWith('.md') && !p.includes('/archive/'))
    .find((p) => planIdFromBasename(basename(p)) === planId);
  if (!path) return null;
  const folder = path.slice('docs/superpowers/plans/'.length).split('/')[0];
  return { path, folder, content: git(MAIN, ['show', `origin/master:${path}`]), listing };
}

// The review marker + findings verdict for HEAD, read the way record-review's own pre-gate does
// (origin-first). Exact-sha only: the hand-off must describe the tip it hands over.
function reviewFacts(MAIN, cfg, slug, headSha, plansListing) {
  const fam = MARKER_FAMILIES.review;
  let src;
  try {
    src = resolveMarkerSource(MAIN, slug, cfg.paths, fam, TOOL, {
      refs: ORIGIN_FIRST_REFS,
      read: (p) => readSessionCandidates(MAIN, p, { strict: true }),
    });
  } catch (e) {
    return { review: null, findingsOpen: `could not read the session entry: ${e.message}` };
  }
  if (!src || !src.src || src.src.halted) return { review: null, findingsOpen: null };
  const marker = pickFreshestMarker(fam, src.src.contents || [], headSha);
  const review = marker ? { verdict: marker.verdict, sha: marker.sha } : null;
  if (!review || review.sha !== headSha) return { review, findingsOpen: null };
  let record = null;
  try {
    const rel = findingsSidecarPath(src.src.path);
    const parsed = readSessionCandidates(MAIN, rel).map((c) => parseFindingsRecord(c));
    record = parsed.find((r) => r && r.sha === headSha) || parsed.find(Boolean) || null;
  } catch {
    record = null;
  }
  const seam = findingsGate(review.verdict, record, headSha, (id) =>
    planIdInTree(plansListing, id),
  );
  return { review, findingsOpen: seam ? seam.reason : null };
}

function parseArgs(argv) {
  const out = { slug: null, dryRun: false, gatesCloudSafe: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--gates-cloud-safe') out.gatesCloudSafe = argv[++i] || null;
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else out.slug = a;
  }
  return out;
}

export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`${TOOL}: ${e.message}`);
    return 2;
  }
  const MAIN = resolveMain({ assertMaster: false });
  const slug =
    args.slug ||
    slugFromBranch(gitOrNull(process.cwd(), ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() || '');
  if (!slug) {
    console.error(`${TOOL}: name the plan slug, or run from its worktree-<slug> branch`);
    return 2;
  }
  const branch = `worktree-${slug}`;
  const planId = planIdFromBasename(`${slug}.md`);
  const wtPath = worktreeFor(MAIN, branch);
  if (!planId || !wtPath) {
    console.error(`${TOOL}: no plan id in "${slug}" or no worktree on ${branch}`);
    return 2;
  }

  gitOrNull(MAIN, ['fetch', '-q', 'origin', 'master']);
  const plan = planOnOrigin(MAIN, planId);
  if (!plan) {
    console.error(`${TOOL}: no live plan file for ${planId} on origin/master`);
    return 2;
  }
  const headSha = git(wtPath, ['rev-parse', 'HEAD']).trim();
  const originSha =
    (gitOrNull(wtPath, ['ls-remote', 'origin', `refs/heads/${branch}`]) || '').split(/\s/)[0] ||
    null;
  const mergeBase = gitOrNull(wtPath, ['merge-base', 'origin/master', 'HEAD'])?.trim();
  const changedPaths = mergeBase
    ? git(wtPath, ['diff', '--name-only', mergeBase, 'HEAD']).split('\n').filter(Boolean)
    : [];
  // Untracked (non-ignored) files count too: a source file left out of the commit would ship a
  // land without it (review fix, gpt-review r1 202918). `.scratch/` is gitignored, so it never shows.
  const dirtyPaths = parseStatusPaths(git(wtPath, ['status', '--porcelain']));
  const claim = claimStatus(MAIN, planId);
  const cfg = loadCoordConfig(MAIN);
  const { review, findingsOpen } = reviewFacts(MAIN, cfg, slug, headSha, plan.listing);

  const facts = {
    planId,
    slug,
    branch,
    headSha,
    originSha,
    dirtyPaths,
    changedPaths,
    planContent: plan.content,
    planFolder: plan.folder,
    adoptBranch: readFrontmatterScalar(plan.content, 'adoptBranch') || null,
    claim,
    review,
    findingsOpen,
    gatesCloudSafe: args.gatesCloudSafe,
    env: DEFAULT_LAND_CLOUD_ENV,
    sessionId: claim.holder?.sessionUuid ?? null,
  };

  const judged = judgeHandoff(facts);
  if (judged.done) {
    console.log(
      `${TOOL}: ${slug} is already handed off for ${headSha.slice(0, 10)} — nothing to do.`,
    );
    return 0;
  }
  if (judged.refusals.length) {
    console.error(`${TOOL}: REFUSED — ${slug} stays local. Nothing was written.`);
    for (const r of judged.refusals) console.error(`  [${r.rubric ?? r.code}] ${r.reason}`);
    return 2;
  }
  if (args.dryRun) {
    console.log(
      `${TOOL}: --dry-run — ${slug} @ ${headSha.slice(0, 10)} may be handed off ` +
        `(hand-off ${judged.handoffNumber}, ${facts.env} env). Would run: note → dequeue → move ready → verify adoptBranch → release.`,
    );
    return 0;
  }

  const ops = {
    writePlan: (content) => {
      const scratch = join(wtPath, '.scratch');
      mkdirSync(scratch, { recursive: true });
      const file = join(scratch, `cloud-land-${planId}.md`);
      writeFileSync(file, content);
      const baseSha = git(MAIN, ['rev-parse', `origin/master:${plan.path}`]).trim();
      runScript(wtPath, 'edit-plan.mjs', [
        planId,
        '--body',
        file,
        '--base-sha',
        baseSha,
        '--message',
        `${planId}: cloud-land hand-off of ${branch} @ ${headSha.slice(0, 10)}`,
      ]);
    },
    dequeue: () => runScript(wtPath, 'landing-queue.mjs', ['dequeue', slug]),
    moveReady: () => runScript(wtPath, 'move-plan.mjs', [planId, 'ready']),
    readAdoptBranch: () => {
      git(MAIN, ['fetch', '-q', 'origin', 'master']);
      const now = planOnOrigin(MAIN, planId);
      return now ? readFrontmatterScalar(now.content, 'adoptBranch') || null : null;
    },
    release: () => {
      runScript(wtPath, 'release-claim.mjs', ['release', planId]);
      if (claimStatus(MAIN, planId).held)
        throw new Error(`release-claim exited 0 but plan ${planId} still reads held`);
    },
  };

  const r = runHandoff(facts, ops);
  if (!r.ok) {
    console.error(
      `${TOOL}: step "${r.failedStep}" FAILED — ${r.error}\n` +
        `  done so far: ${r.ran.join(' → ') || '(nothing)'}; the claim is ${r.claimHeld ? 'STILL HELD' : 'released'}. ` +
        'Fix the cause and re-run the same command (every step is idempotent).',
    );
    return 1;
  }
  const lane = (readFrontmatterScalar(plan.content, 'execModel') || 'sonnet').toLowerCase();
  console.log(
    `${TOOL}: HANDED OFF — ${slug} @ ${headSha.slice(0, 10)} is in ready/ with landCloudExec: true ` +
      `(${facts.env}), adoptBranch ${branch}, claim released, queue slot freed.\n` +
      `  Next (S5/R1): fire ONE run of THIS account's ${lane === 'fable' ? 'fable' : 'sonnet'}-full drain ` +
      'routine via the in-session RemoteTrigger action `run` (it fires even when the routine is paused); ' +
      "otherwise the account's next scheduled full-env drain picks it up. Never another account's routine.",
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
