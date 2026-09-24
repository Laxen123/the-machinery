#!/usr/bin/env node
// scripts/lint-plan-cost-forecast.mjs — pre-push guard: every ready/ plan must
// declare a parseable "Cost forecast:" banner.
//
// WHY: the autonomous ready/-queue drain (plan 231, docs/runbooks/autonomous-
// drain.md) PAUSES on any ready/ plan whose cost section is missing or
// unparseable (parseCost → { unknown: true }). A forgotten banner therefore
// silently stalls an unattended drain on the very first plan it hits — exactly
// the failure the 2026-05-31 dry-run reproduced (cost_pause on 208 at iter 0).
// This guard blocks the push instead, so the banner is supplied at authoring
// time rather than discovered mid-drain.
//
// It reuses queue-drain.mjs's parsePlanMeta (via the shared plan-cost-banner.mjs
// predicate), so "passes this lint" means EXACTLY "the drain won't pause this plan
// for cost.unknown." One parser, one source of truth — the lint can never drift from
// what the driver enforces, nor from the movers (move-plan → ready/, next-plan-id
// --ready) that now validate the SAME predicate at promotion time (plan 1260).
//
// SCOPE: ready/ only — that is the queue the drain consumes and the default
// landing folder for new plans (vetapp CLAUDE.md "Plan folder layout"). A plan
// promoted from waiting-*/ is checked the moment it enters ready/. Paths come
// from `git ls-files` (TRACKED only), so an untracked/foreign plan another
// parallel session dropped in ready/ is invisible and never gates your push —
// the same orphan-immunity philosophy as lint-plan-index.mjs.
//
// Exit codes:  0 clean · 1 missing/unparseable banner (push blocked) · 2 error.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasParseableCostBanner, costBannerHelp } from './coord/plan-cost-banner.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const READY_DIR = 'docs/superpowers/plans/ready';

// pure: given [{ path, content }], return the basenames whose Cost forecast is
// missing or unparseable (cost.unknown) — i.e. the ones the drain would pause.
// Uses the shared plan-cost-banner predicate, the same one the movers enforce.
export function findPlansMissingCost(entries) {
  return entries
    .filter((e) => !hasParseableCostBanner(basename(e.path), e.content))
    .map((e) => basename(e.path));
}

function trackedReadyPlans() {
  const out = execFileSync('git', ['ls-files', `${READY_DIR}/*.md`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((rel) => ({ path: rel, content: readFileSync(join(REPO_ROOT, rel), 'utf8') }));
}

function main() {
  let entries;
  try {
    entries = trackedReadyPlans();
  } catch (e) {
    console.error('lint-plan-cost-forecast: could not list ready/ plans:', e.message);
    return 2;
  }
  const missing = findPlansMissingCost(entries);
  if (missing.length === 0) return 0;

  console.error('');
  console.error(
    'lint-plan-cost-forecast: ready/ plan(s) missing a parseable Cost forecast banner:',
  );
  for (const slug of missing) console.error(`  - ${slug}`);
  console.error('');
  console.error(costBannerHelp());
  console.error('  Emergency escape: git push --no-verify (but supply the banner first).');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
