#!/usr/bin/env node
// scripts/pre-rebase-main-guard.mjs  (plan 2933, fix A)
//
// A git `pre-rebase` hook (wired through .husky/pre-rebase) that WARNS when a rebase is
// about to run on `master` in the SHARED MAIN checkout by a path that is not the sanctioned
// one. It is the structural half of plan 2933: stop the residue being created, rather than
// only cleaning it up faster afterwards.
//
// THE INCIDENT IT TARGETS (measured 2026-08-06). A session lost a push race and retried with
// a hand-rolled loop:
//
//   for i in 1 2 3; do git pull --rebase -q origin master; git push origin master && exit 0; done
//
// One `git pull --rebase` was interrupted. It left the shared MAIN checkout DETACHED with
// `.git/rebase-merge/` residue and a clean tree. Every parallel session then saw a detached
// MAIN, and `heal-main.mjs` REFUSED to clear it: at the time its signals were (1) an open
// `push-rebase` coord-op journal window, which only `pushMasterWithRebase` writes, and (2) a
// 15-minute mtime gate whose stated premise is "this is an operator HAND rebase, don't destroy
// a live one". An agent's raw rebase satisfied neither — it journals nothing and it is not a
// human — so it was spared for a quarter of an hour while the shared checkout stayed wedged.
// Recovery needed a hand `git rebase --abort`, precisely the ad-hoc recovery the plan-1286
// post-mortem exists to eliminate.
//
// Plan 2939 has since given heal-main a THIRD signal (the abandoned shape) that clears exactly
// this residue after ~3 minutes rather than 15. That shortens the wedge; it does not remove the
// reason for this warning, because the residue still detaches MAIN for every parallel session
// in the meantime, and a rebase that dies at a CONFLICT still carries a marker and waits out
// the full human gate.
//
// WHY A GIT HOOK AND NOT A ROW IN hand-rolled-step-guard.mjs. The plan drafted this as a
// pattern row in that Bash-text guard. A `pre-rebase` hook is strictly more durable: it fires
// on EVERY spelling of a rebase (`git rebase`, `git pull --rebase`, an alias, a wrapper
// script, a rebase from inside another tool) rather than on the shell text a matcher happens
// to recognise, and it cannot be fooled by quoting. Measured on git 2.53.0.windows.2:
// `pre-rebase` fires for `git pull --rebase` and receives the upstream sha as its first arg.
//
// WARN, NEVER DENY — deliberately, and this is the one design point not to "improve" later.
// Unlike post-checkout, git DOES honour a pre-rebase hook's exit code: a non-zero exit aborts
// the rebase. We always exit 0 anyway, and .husky/pre-rebase adds `|| true` as a second
// belt. Two reasons. (1) The repo already settled this exact question for
// scripts/hooks/hand-rolled-step-guard.mjs — "a deny here would get the hook muted within a
// day" — and a hook muted is a hook that protects nothing. (2) This checkout is shared by
// ~5-7 sessions plus the operator; a blocking rebase hook would have to be threaded through
// every sanctioned rebaser and every legitimate hand recovery, and the first time it wrongly
// blocked an operator mid-recovery it would be deleted, not fixed.
//
// SILENT IN EVERY CASE EXCEPT THE ONE. The guard stays quiet when:
//   • the rebase runs in a LINKED WORKTREE (rebasing a worktree-* branch is normal, expected,
//     and carries none of the shared-checkout blast radius)      → silent
//   • the branch being rebased is not `master`                    → silent
//   • VETAPP_SANCTIONED_REBASE=1 is set (pushMasterWithRebase and
//     abortRebase set it around their own rebase calls)           → silent
//   • anything at all goes wrong reading git state                → silent (never break a rebase)
//
// Never firing on the sanctioned tools themselves is not politeness, it is the whole asset:
// a guard that flags its own recommended replacement is self-discrediting, and the warning has
// to still mean something the tenth time it fires.
//
// The pure core (evaluateRebase / warnMessage) takes plain values, touches no fs/git, and
// carries the unit tests in pre-rebase-main-guard.test.mjs.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { YELLOW, BOLD, OFF } from './ansi-colors.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';

/** The env var the sanctioned rebasers set around their own `git rebase` call. */
export const SANCTIONED_ENV = 'VETAPP_SANCTIONED_REBASE';

// --- pure ---------------------------------------------------------------------

/**
 * Decide whether this rebase deserves the warning.
 *
 * `inMainCheckout` — false for a linked worktree. A worktree rebase is ordinary work.
 * `branch`         — the branch being rebased, or null when it could not be read (detached
 *                    HEAD, or a git failure). null is treated as NOT-master: a guard that
 *                    guesses "probably master" would fire on unrelated detached-HEAD rebases,
 *                    and a false positive costs more here than a miss.
 * `sanctioned`     — the SANCTIONED_ENV escape was set by a coord tool.
 */
export function evaluateRebase({ inMainCheckout, branch, sanctioned }) {
  if (sanctioned) return { warn: false, reason: 'sanctioned-rebaser' };
  if (!inMainCheckout) return { warn: false, reason: 'linked-worktree' };
  if (branch !== 'master') return { warn: false, reason: 'not-master' };
  return { warn: true, reason: 'raw-rebase-on-main-master' };
}

/** The warning. Names what is about to happen, what it costs when it dies, and the tool. */
export function warnMessage() {
  const bar = '!'.repeat(74);
  return [
    '',
    `${YELLOW}${BOLD}${bar}${OFF}`,
    `${YELLOW}${BOLD} pre-rebase: raw rebase of 'master' in the SHARED MAIN checkout.${OFF}`,
    `${YELLOW} If this rebase dies mid-flight it leaves MAIN detached with rebase residue that`,
    `${YELLOW} every parallel session sees. heal-main.mjs clears a CLEAN abandoned one after ~3`,
    `${YELLOW} min (plan 2939), but one that dies at a conflict waits out the full 15-min gate,`,
    `${YELLOW} because a raw rebase journals nothing and so looks like a live hand rebase.`,
    `${YELLOW}`,
    `${YELLOW} vetapp owns a tool for this:  pushMasterWithRebase() in scripts/coord/coord-git.mjs`,
    `${YELLOW}   (the coord tools — edit-plan / index / board / coord-edit — all go through it)`,
    `${YELLOW}   Recovery, if this one does wedge:  node scripts/heal-main.mjs`,
    `${YELLOW}`,
    `${YELLOW} Proceed anyway if this is genuinely a one-off — this is a WARNING, not a block.`,
    `${YELLOW}${BOLD}${bar}${OFF}`,
    '',
  ].join('\n');
}

// --- IO -----------------------------------------------------------------------

/** True when cwd is the MAIN checkout: a linked worktree's git-dir differs from the common one.
 *
 *  ONE spawn, not two (review finding): `rev-parse` accepts both selectors in a single call and
 *  prints them on consecutive lines, and `--path-format=absolute` makes the comparison
 *  meaningful (without it `--git-dir` can come back relative while `--git-common-dir` is
 *  absolute, so two spawns ALSO had to normalize two different path shapes). Verified in both a
 *  worktree and MAIN on git 2.53.0.windows.2. */
export function readInMainCheckout(run = gitOut) {
  const out = run(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
  if (!out) return false;
  const [dir, common] = out.trim().split(/\r?\n/);
  if (!dir || !common) return false;
  return normalize(dir) === normalize(common);
}

const normalize = (p) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function gitOut(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitRepoIsolatedEnv(),
    });
  } catch {
    return null;
  }
}

export function readBranch(run = gitOut) {
  const out = run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return out ? out.trim() || null : null;
}

/**
 * The env overrides a sanctioned MAIN rebaser passes to its own `git rebase` so this guard
 * stays silent. ONE definition, imported by all three sanctioned rebase-retry loops
 * (coord-git's pushMasterWithRebase, drain-run's INDEX push loop, done-worktree's pushMaster)
 * rather than the literal repeated at each — a fourth loop that copies the string instead of
 * importing this is exactly how the exemption silently drifts.
 *
 * Callers MERGE this over their own env; it deliberately carries nothing else. An earlier
 * revision spread the caller's `{ HUSKY: '0' }` push-env into the rebase call, which disabled
 * the ENTIRE husky chain on the sanctioned rebase — broader than the one exemption needed, and
 * a behaviour change from before this guard existed (that rebase previously ran with hooks
 * live). Three reviewers caught it independently.
 */
export function sanctionedRebaseEnv() {
  return { [SANCTIONED_ENV]: '1' };
}

export function main({
  env = process.env,
  argv = process.argv.slice(2),
  log = (s) => console.error(s),
  probeMainCheckout = readInMainCheckout,
  probeBranch = readBranch,
} = {}) {
  // Check the exemption BEFORE spawning anything (review finding). The sanctioned path is the
  // HOT one — every coord write that hits a non-ff retry lands here — and it can be decided
  // from the environment alone, so paying for git probes first is pure waste.
  if (env[SANCTIONED_ENV] === '1') return 0;
  let verdict;
  try {
    verdict = evaluateRebase({
      inMainCheckout: probeMainCheckout(),
      // git passes pre-rebase `<upstream> [<branch>]`, and the second arg is AUTHORITATIVE:
      // `git rebase origin/master master` rebases master while HEAD sits on another branch, so
      // probing HEAD would read the wrong branch and stay silent on exactly the dangerous case.
      // git omits it when rebasing the current branch — then, and only then, HEAD is right.
      branch: argv[1] || probeBranch(),
      sanctioned: false,
    });
  } catch {
    // A guard crash must never abort someone's rebase. Silence is the safe direction.
    return 0;
  }
  if (verdict.warn) log(warnMessage());
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
