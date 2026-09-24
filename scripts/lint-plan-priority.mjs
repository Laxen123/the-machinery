#!/usr/bin/env node
// scripts/lint-plan-priority.mjs — pre-push guard: plan 2520 ruling 3 (fail loud at write time).
//
// WHY: the `priority:` frontmatter stamp had FOUR values in the wild (`high`/`medium`/`normal`/
// `low`) while every consumer collapsed all but `high` to "absent" — silently. `priority:
// urgnet` (a typo), `priority: P1`, or `priority: low` all used to resolve to "not high" with no
// warning anywhere: mint, spec-pass, lint, and push gates were all silent, which is exactly what
// let four values accumulate without anyone noticing (plan 2520 grill question 3). The three-tier
// ruling closes the vocabulary to exactly `{high, medium, low}` (case-insensitive); anything else
// must be caught HERE, at push time, rather than discovered months later reading the drain's sort
// code.
//
// READ-TIME consumers (queue-drain, build-index-lib, claim-plan, done-worktree,
// read-plan-stamps) do NOT crash on an escaped bad value — they warn to stderr and fall back to
// `medium` (build-index-lib.mjs's normalizePriorityTier/isValidPriorityValue). This lint is the
// OTHER half of ruling 3: hard-refuse at write time so a bad value never legitimately reaches
// those readers to begin with.
//
// archive/ and parked/ are skipped — closed/frozen, nothing left to route (mirrors
// lint-filename-execmodel-drift.mjs's identical carve-out for the same two folders).
//
// SCOPE (plan 2540): `.husky/pre-push` diff-scopes only WHETHER this gate runs (a push
// touching plans/), not WHAT it scans once running — it used to always scan the whole
// tracked corpus via `git ls-files`, so a stray illegal value on any plan ANYWHERE blocked
// every other session's push that merely touched a different plan file. The hook now pipes
// its already-computed `$CHANGED` list on stdin (one repo-relative path per line, same
// contract as select-battery-tests.mjs); this scopes the scan to those paths. `--all`
// forces the old corpus-wide sweep (board-pass / a manual full check) and takes priority
// over stdin. With no `--all` and no piped stdin (an interactive manual run), this falls
// back to a full sweep too — only the automated hook path is scoped. A push that touches
// TOOLING_PATHS (this lint, or a module it reads its rules from) also forces a full sweep
// regardless of what else is in the diff — see resolveLintChangeScope in
// build-index-lib.mjs, the shared scoping logic this file and its execmodel-drift sibling
// both use.
//
// Exit codes: 0 clean · 1 an illegal priority value found (push blocked) · 2 error.

import { readFileSync, existsSync } from 'node:fs';
// plan 2615: the shared reader (bounded EAGAIN retry + a temp-file diagnostic). Was a local
// `readFileSync(0)` in a bare catch, which made a Windows read failure indistinguishable from
// empty input — the silent-skip class this plan exists to close. Fail-open shape unchanged.
import { readStdin } from './coord/stdin-read.mjs';
import { execFileSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  readFrontmatterScalar,
  isValidPriorityValue,
  PRIORITY_VALUES,
  resolveLintChangeScope,
  priorityStampProblem,
  priorityStampFixHint,
  readPriorityBy,
  readPriorityTier,
  PRIORITY_BY_DIRECTIVES,
} from './coord/build-index-lib.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANS_PREFIX = 'docs/superpowers/plans/';
// A push touching any of these forces a full-corpus sweep (see resolveLintChangeScope) —
// this lint's own source, or a module it derives its validation rules from.
const TOOLING_PATHS = [
  'scripts/lint-plan-priority.mjs',
  'scripts/read-plan-stamps.mjs',
  'scripts/coord/build-index-lib.mjs',
];

// pure: given [{ path, content }] (repo-relative plan path + its text), return one
// { basename, value, message } per illegal `priority:` stamp. `path` must be
// `docs/superpowers/plans/<status>/<basename>.md`.
export function findIllegalPriority(entries) {
  const problems = [];
  for (const { path, content } of entries) {
    const rel = path.slice(PLANS_PREFIX.length);
    const status = rel.split('/')[0];
    if (status === 'archive') continue; // closed — never gated
    if (status === 'parked') continue; // frozen long-term — filename/stamp churn stops here too
    const raw = readFrontmatterScalar(content, 'priority');
    if (!raw) continue; // absent is always legal — defaults to `medium`
    if (isValidPriorityValue(raw)) continue;
    const base = basename(path);
    problems.push({
      basename: base,
      value: raw,
      message:
        `${base} (${status}/): priority: "${raw}" is not a legal value — must be one of ` +
        `${PRIORITY_VALUES.join('|')} (case-insensitive). Fix with: node scripts/edit-plan.mjs ` +
        `${base.replace(/\.md$/, '')} --find "priority: ${raw}" --replace "priority: medium"  ` +
        `(or --replace "" to strip it — absent is byte-equivalent to medium).`,
    });
  }
  return problems;
}

// plan 3999 § The corpus: the ten live bare `priority: high` stamps measured in-worktree on
// 2026-09-13, grandfathered so this lint (and its mint-time twin, next-plan-id.mjs) can go
// live WITHOUT first forcing an operator sitting on every one of them — the plan's land order
// is lint + mint refusal FIRST with the corpus temporarily grandfathered, operator sitting
// SECOND. Keyed by PLAN ID (the numeric filename prefix), never by basename or full path — a
// plan moves folders constantly (pickup-plan, move-plan) and can be retitled, and keying by
// either would silently UN-grandfather it the moment that happens. The basename trails each
// row as a plain comment for readability only; nothing reads it.
//
// REMOVAL CONDITION: the operator sitting plan 3999 § The corpus describes rules each row
// (keep it — stamp `priorityBy: operator <date>` — or reset to `priority: medium`) in one
// sitting. This whole array is DELETED in the same change that applies that ruling; it is
// never trimmed row-by-row against a still-live corpus.
//
// The allowlist exempts a plan ONLY from the 'unbacked-high' problem — an illegal
// `priorityBy:` VALUE on a grandfathered plan is still an error: priorityStampProblem
// (build-index-lib.mjs) reports 'bad-priorityBy-value' before 'unbacked-high' ever gets a
// chance to fire, so this list never has to special-case that itself.
export const BARE_HIGH_GRANDFATHERED_2026_09_13 = new Set([
  '1823', // waiting-date/1823-Infra-weekly-price-sweep-tick-loop.md
  '3915', // in-progress/3915-SOL-Pipe-judges-need-a-split-proposal-lane.md
  '3925', // waiting-blocked/3925-App-variant-label-full-wrapping-r6.md
  '3973', // in-progress/3973-FABLE-Coord-landing-queue-and-stamp-chains-off-master-history.md
  '3974', // in-progress/3974-FABLE-Infra-land-rebase-survives-stray-index-lock.md
  '3986', // in-progress/3986-Infra-pathspec-commit-prettier-fails-open-over-1mb-prettierignored-file.md
  '4003', // waiting-operator/4003-FABLE-Infra-land-battery-resumes-from-ledger-and-cap-clock-starts-at-slot-grant.md
  '4004', // waiting-operator/4004-Infra-land-battery-diff-scoped-cloud-daily-routine-is-the-full-battery-backstop.md
  '4005', // waiting-operator/4005-Infra-battery-load-sensitive-test-trio-reads-environment-through-parameters.md
  '4006', // pending-approval/4006-Infra-battery-cap-counts-its-own-test-queue-wait.md
]);

// pure: given [{ path, content }] (repo-relative plan path + its text), return one
// { basename, problem, message } per plan whose `priority:` / `priorityBy:` pairing is broken
// (plan 3999): a bare `priority: high` with no legal authority, a `priorityBy:` stranded on a
// non-high plan, or a `priorityBy:` that does not parse. Sibling to findIllegalPriority above —
// same entry shape, same archive/parked carve-out — wired into main() alongside it so a push
// sees BOTH problem sets. `grandfathered` is injectable (default
// BARE_HIGH_GRANDFATHERED_2026_09_13) so tests drive their own set instead of depending on the
// live corpus, per the plan body's explicit ask.
export function findUnbackedHigh(
  entries,
  { grandfathered = BARE_HIGH_GRANDFATHERED_2026_09_13 } = {},
) {
  const problems = [];
  for (const { path, content } of entries) {
    const rel = path.slice(PLANS_PREFIX.length);
    const status = rel.split('/')[0];
    if (status === 'archive') continue; // closed — never gated
    if (status === 'parked') continue; // frozen long-term — filename/stamp churn stops here too
    const problem = priorityStampProblem(content);
    if (!problem) continue;
    const base = basename(path);
    const idMatch = base.match(/^(\d+)/);
    const id = idMatch ? idMatch[1] : null;
    // The allowlist exempts ONLY 'unbacked-high' — see the array's own comment above for why a
    // bad-value problem is never reachable here for a grandfathered plan in the first place.
    if (problem === 'unbacked-high' && id && grandfathered.has(id)) continue;
    const idForFix = base.replace(/\.md$/, '');
    let message;
    if (problem === 'stale-priorityBy') {
      message =
        `${base} (${status}/): \`priorityBy:\` is present but priority is not high — a stale ` +
        `leftover (probably from a since-demoted plan). Remove the \`priorityBy:\` line, or ` +
        `restore \`priority: high\` if that was intended.`;
    } else {
      // 'unbacked-high' or 'bad-priorityBy-value' — review fix round 1 (key 32672c): the fix
      // sentence is TIER-AWARE via the shared priorityStampFixHint (build-index-lib.mjs), so a
      // bad VALUE on a medium/low plan (its `priority:` stamp is fine, only the payload isn't)
      // never suggests demoting a `priority: high` line that doesn't exist.
      const tier = readPriorityTier(content);
      const hint = priorityStampFixHint(problem, tier);
      const demoteSuffix = hint.demoteApplicable
        ? `, or node scripts/edit-plan.mjs ${idForFix} --find "priority: high" --replace "priority: medium"`
        : '';
      const fix = `Fix with: ${hint.guidance}${demoteSuffix}.`;
      if (problem === 'unbacked-high') {
        message =
          `${base} (${status}/): priority: high with no legal \`priorityBy:\` — the stamp must ` +
          `be operator-set, never the authoring session's own call. ${fix}`;
      } else {
        // 'bad-priorityBy-value'
        const rawBy = readPriorityBy(content);
        const shown = rawBy
          ? `\`priorityBy: ${rawBy}\` does not parse`
          : '`priorityBy:` is present but has no value';
        message =
          `${base} (${status}/): ${shown} — must be \`operator <YYYY-MM-DD>\` (a real, ` +
          `non-future calendar date) or \`directive <name>\` (one of ` +
          `${PRIORITY_BY_DIRECTIVES.join(', ')}). ${fix}`;
      }
    }
    problems.push({ basename: base, problem, message });
  }
  return problems;
}

// `changedPaths == null` ⇒ full corpus sweep via `git ls-files`. Otherwise, read exactly
// the changed plan paths directly off disk (plan 2540 review fix) — NOT an intersection
// against a separate `git ls-files` listing of the CURRENT checkout, which could silently
// drop a path the pushed commit touched but that no longer matches the working tree (e.g.
// a worktree whose HEAD has since moved). A changed path that no longer exists on disk
// (deleted/renamed away later in the same push) has nothing left to lint — skipped, not
// an error.
function trackedPlans(changedPaths) {
  if (changedPaths) {
    return changedPaths
      .filter((rel) => existsSync(join(REPO_ROOT, rel)))
      .map((rel) => ({ path: rel, content: readFileSync(join(REPO_ROOT, rel), 'utf8') }));
  }
  const out = execFileSync('git', ['ls-files', `${PLANS_PREFIX}*.md`], {
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
  const forceAll = process.argv.slice(2).includes('--all');
  let changedPaths = null;
  if (!forceAll && !process.stdin.isTTY) {
    let raw = '';
    try {
      raw = readStdin();
    } catch {
      raw = '';
    }
    changedPaths = resolveLintChangeScope(raw, {
      plansPrefix: PLANS_PREFIX,
      toolingPaths: TOOLING_PATHS,
    });
  }
  let entries;
  try {
    entries = trackedPlans(changedPaths);
  } catch (e) {
    console.error('lint-plan-priority: could not list plan files:', e.message);
    return 2;
  }
  const problems = findIllegalPriority(entries);
  const unbackedProblems = findUnbackedHigh(entries);
  if (problems.length === 0 && unbackedProblems.length === 0) return 0;

  if (problems.length > 0) {
    console.error('');
    console.error('lint-plan-priority: illegal `priority:` frontmatter value(s) (plan 2520):');
    for (const p of problems) console.error(`  - ${p.message}`);
  }
  if (unbackedProblems.length > 0) {
    console.error('');
    console.error('lint-plan-priority: `priority: high` needs a named authority (plan 3999):');
    for (const p of unbackedProblems) console.error(`  - ${p.message}`);
  }
  console.error('');
  console.error('  Emergency escape: git push --no-verify (but fix the value first).');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
