#!/usr/bin/env node
// scripts/post-checkout-claim-guard.mjs  (plan 1022, B)
//
// A git `post-checkout` hook (wired through .husky/post-checkout) that WARNS when a
// worktree is created under .claude/worktrees/<slug> on a `worktree-*` branch but has
// NO claim — no `refs/claims/<id>` ref AND no board ACTIVE row for that slug. That is the
// exact deviation the 2026-06-23 plan-1013 incident hit: a session ran `git worktree add`
// BY HAND instead of pickup-plan, leaving the plan unclaimed (and, pre-plan-1022, auto-
// drainable). plan 1022's option C (mint → drafting/, now pending-approval/ per plan 1371)
// closes the auto-drain at the source;
// this guard (option B) is the catch-the-deviation backstop — it lands a RED warning at
// worktree-creation time so the operator/agent notices the skipped claim immediately.
//
// post-checkout fires on EVERY HEAD-moving checkout (branch switch, `git switch`, clone,
// `git worktree add`). It is ADVISORY only — git ignores a post-checkout hook's exit code,
// and so do we (always exit 0); a hook crash must never break `git worktree add`. The guard
// stays SILENT in every case except the specific unclaimed-worktree one:
//   • not a branch checkout (git's 3rd arg ≠ "1")            → silent
//   • cwd is not under .claude/worktrees/ (main checkout)    → silent
//   • branch is not `worktree-*`                             → silent
//   • slug has no NNN plan id (e.g. a `staging` worktree)    → silent
//   • a refs/claims/<id> ref OR a board ACTIVE row exists    → silent (claimed — the
//                                                              legit pickup-plan/cut-worktree
//                                                              flow always satisfies this)
// The pure core (deriveSlugId / evaluateCheckout / warnMessage) takes plain values, touches
// no fs/git, and carries the unit tests (post-checkout-claim-guard.test.mjs).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { git, lsRemoteTimed } from './coord/coord-git.mjs';
import { RED, BOLD, OFF } from './coord/ansi-colors.mjs';
import { claimRefCandidates } from './coord/coord-refs.mjs';

// --- pure ---------------------------------------------------------------------

// A `worktree-<slug>` branch → { slug, id } where id is the leading NNN (≥3 digits,
// covers 4-digit plan 1000+) or null when the slug carries no plan id (a non-plan
// worktree such as `staging-maptune`). null when the branch is not a worktree-* branch.
export function deriveSlugId(branch) {
  if (typeof branch !== 'string' || !branch.startsWith('worktree-')) return null;
  const slug = branch.slice('worktree-'.length);
  if (!slug) return null;
  const m = slug.match(/^(\d{3,})-/);
  return { slug, id: m ? m[1] : null };
}

// The RED, prominent warning. ANSI colour degrades gracefully to readable text on a
// terminal that strips it. Names the slug + id and the one rule that was broken.
export function warnMessage(slug, id) {
  const bar = '!'.repeat(74);
  return [
    '',
    `${RED}${BOLD}${bar}${OFF}`,
    `${RED}${BOLD} post-checkout: worktree '${slug}' is UNCLAIMED.${OFF}`,
    `${RED} No refs/claims/${id} ref and no board ACTIVE row for this slug — this worktree`,
    ` skipped pickup-plan. Plan ${id} may be picked up by the autonomous orchestrator or`,
    ` double-worked by another session.`,
    `${RED} → Claim it now via pickup-plan, or tear this worktree down.${OFF}`,
    `${RED} NEVER \`git worktree add\` by hand for plan work — that is the 2026-06-23`,
    `   plan-1013 race this guard catches.${OFF}`,
    `${RED}${BOLD}${bar}${OFF}`,
    '',
  ].join('\n');
}

// Decide whether a checkout warrants the unclaimed-worktree warning. Pure.
//   branchCheckout   — git's 3rd post-checkout arg was "1" (a branch checkout, not a file one)
//   branch           — the checked-out branch name
//   inWorktreeDir    — cwd is under .claude/worktrees/
//   claimRefExists   — refs/claims/<id> resolves
//   boardHasActiveRow— the worktree's board.md carries an ACTIVE row for the slug
export function evaluateCheckout({
  branchCheckout,
  branch,
  inWorktreeDir,
  claimRefExists,
  boardHasActiveRow,
}) {
  if (!branchCheckout) return { warn: false };
  if (!inWorktreeDir) return { warn: false };
  const si = deriveSlugId(branch);
  if (!si || !si.id) return { warn: false }; // not a worktree-* branch, or a non-plan worktree
  if (claimRefExists || boardHasActiveRow) return { warn: false };
  return { warn: true, message: warnMessage(si.slug, si.id) };
}

// --- CLI: git/fs wiring (never throws; always exit 0) -------------------------

// F-012 (plan 1313, 2026-07-02 coord audit): claims are pushed to ORIGIN ONLY — no fetch
// refspec maps `refs/claims/*` into a LOCAL ref (the sole fetch anywhere in this codebase is a
// no-colon `git fetch origin refs/claims/<id>`, which populates FETCH_HEAD/objects, never a named
// local ref) — so the prior `git show-ref --verify refs/claims/<id>` LOCAL probe could NEVER fire.
// The guard's silence rested entirely on `boardHasActiveRow`, so a legit claim whose board row
// wasn't yet visible in THIS worktree's copy produced a false RED "UNCLAIMED" warning. Probe the
// REMOTE directly instead, like every other refs/claims consumer (claim-plan.mjs,
// sweep-acquire-residue.mjs, reconcile-board.mjs). Uses coord-git's `git()` (not a bare
// execFileSync) so the network round-trip inherits GIT_NONINTERACTIVE_ENV — an advisory hook must
// never hang on a GCM credential dialog. `_git`/`cwd` are test seams.
export function claimRefExists(id, { cwd = process.cwd(), _git = git } = {}) {
  try {
    // Bound the network round-trip: this runs in a post-checkout hook that git waits on
    // SYNCHRONOUSLY, firing on every `worktree-*` branch checkout. Without a timeout an offline
    // or flaky-VPN origin blocks the checkout on the OS-level TCP/DNS timeout (tens of seconds)
    // before falling through here (review 2026-07-04). coord-git's shared `lsRemoteTimed` caps
    // it at 5s (plan 1475 item 3, folded from the three hand-rolled copies) so an unreachable
    // origin fails fast to the catch → `false` → the guard falls back to boardHasActiveRow,
    // keeping the hook's "advisory, never blocks the checkout" contract.
    // plan 3756: BOTH namespaces, since a pre-flip session's claim still lives at the
    // retired name. Deliberately still an EXISTENCE probe and not a tip read: this runs on
    // every checkout, the 5s cap above is the whole reason it cannot hang the hook, and
    // reading tips would need a fetch. The cost is that a released-but-unreaped ref reads as
    // present, which only ever SUPPRESSES an advisory warning — and this guard already falls
    // back to the board row, so it degrades the way it was designed to.
    return lsRemoteTimed(cwd, claimRefCandidates(id), { _git }).trim().length > 0;
  } catch {
    return false; // can't reach origin (or timed out) — the guard falls back to boardHasActiveRow only
  }
}

function boardHasActiveRow(slug) {
  try {
    const board = readFileSync('docs/handoff/board.md', 'utf8');
    return board.split('\n').some((l) => l.includes(slug) && /ACTIVE|LANDING/.test(l));
  } catch {
    return false; // no board in this worktree → can't confirm a claim from here; the ref is primary
  }
}

export function main(argv) {
  // git passes post-checkout: <prevHEAD> <newHEAD> <branchFlag>. argv here is process.argv,
  // so the flag is argv[4] (node, script, prevHEAD, newHEAD, flag).
  const branchCheckout = argv[4] === '1';
  if (!branchCheckout) return 0;
  let branch = '';
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 0; // can't resolve HEAD → silent
  }
  const cwd = process.cwd().replace(/\\/g, '/');
  const inWorktreeDir = /\/\.claude\/worktrees\//.test(cwd);
  const si = deriveSlugId(branch);
  // Only pay the (network) refs/claims ls-remote round-trip when we're actually in a position to
  // warn — evaluateCheckout's warn branch is gated on inWorktreeDir anyway, so an ordinary branch
  // switch from the shared MAIN checkout (the common case, fired on EVERY checkout repo-wide)
  // never touches the network.
  const needsProbe = inWorktreeDir && si && si.id;
  const result = evaluateCheckout({
    branchCheckout,
    branch,
    inWorktreeDir,
    claimRefExists: needsProbe ? claimRefExists(si.id) : false,
    boardHasActiveRow: si ? boardHasActiveRow(si.slug) : false,
  });
  if (result.warn) console.error(result.message);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv));
  } catch {
    process.exit(0); // advisory hook — never break the checkout
  }
}
