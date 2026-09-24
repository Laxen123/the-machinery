// scripts/coord/drift-attribution-lib.mjs (plan 1664 — lifted from lint-plan-index.mjs's
// driftIsInherited, plan 1650 layer 2)
//
// Shared "is this violation inherited master drift, or this branch's own doing" core,
// used by every coord-doc pre-push gate that needs bystander tolerance
// (lint-plan-index.mjs, lint-board.mjs). A worktree branch cut from — or rebased onto
// (done-worktree's land spine) — a master tip whose committed coord doc was already
// drifted carries that drift verbatim, CANNOT heal it (coord docs are never committed
// on a worktree branch), and yet a gate reading that doc blocks its push. One sibling's
// transient drift then stalls EVERY other session's land until someone incidentally
// heals master.
//
// Attribution is exact, not heuristic: if the branch's own commits (merge-base with
// origin/master → HEAD) touched NONE of the caller-supplied input pathspecs, and the
// working tree is clean over them, the branch's state over those inputs is
// byte-identical to the merge-base's — so any violation found there existed at the
// merge-base and is master's to heal, not this push's to block on. The moment the
// branch touches ANY input, strict mode applies unchanged (the safe direction: a
// branch in the coord-doc-editing business owns its consistency in full).
//
// Callers stay strict on master (a master push CAN heal drift in the same motion) —
// this module doesn't special-case that; each caller checks its own branch name via
// `git rev-parse` below.
//
// Fails CLOSED (returns false → strict) on any git error, including an unresolvable
// origin/master. `_exec` is the test seam for the git calls.
//
// `env` (plan 1669) is an optional pre-resolved-value seam, DISTINCT from `_exec`: when
// the caller's `env.COORD_DRIFT_BRANCH` / `env.COORD_DRIFT_BASE` are present, this skips
// its OWN `rev-parse` / `merge-base` subprocess and trusts the caller's value instead —
// added because `.husky/pre-push` runs several drift gates back to back for the same
// push, all calling this function, making the git calls (byte-identical for the same
// push) redundant across the process boundaries. Since plan 1701 `.husky/pre-push`
// exports only COORD_DRIFT_BRANCH (the rev-parse — amortized over ~6 hook consumers);
// COORD_DRIFT_BASE is left unset so the merge-base below runs LAZILY, only on the
// pushes whose gate actually hits drift (measured at ~11% of worktree pushes, dual-gate
// hits 0/806 — see the precompute block comment in `.husky/pre-push`). Direct invocation
// (no exported vars) and every test in this file (default `env = {}`, never
// `process.env`) fall through to the unchanged git-call path below, so behavior there
// is byte-for-byte the pre-1669 logic.
// An env value of the EMPTY STRING is a distinct signal from "absent": it means the
// shell precompute attempted and FAILED (rev-parse errored, or branch was non-master and
// merge-base was unresolvable) — this function trusts that failure and returns false
// (strict) immediately rather than re-running a git call that already failed once.
import { execFileSync } from 'node:child_process';

// Shared three-way resolution for an env-override-or-compute value (plan 1669): an env value of
// `undefined` means "no shell precompute, run computeFn"; `''` means "the shell precompute
// already attempted this and failed" (fails closed, no retry); anything else is trusted verbatim.
// `computeFn` throwing is treated the same as an empty-string env value (its own git call failed).
// One implementation used by BOTH the branch and base resolutions below (plan 1678 batch review
// finding [5]) — a future change to this rule only needs to change one place.
function resolveEnvOrCompute(envVal, computeFn) {
  if (envVal !== undefined) {
    if (envVal === '') return { ok: false };
    return { ok: true, value: envVal };
  }
  try {
    return { ok: true, value: computeFn() };
  } catch {
    return { ok: false };
  }
}

// Non-interactive git-subprocess wrapper shared by computeDriftIsInherited and
// checkWorktreeCoordDocStale below (plan 2099 review [0]) — one place owns the
// timeout/anti-prompt-env settings (plan 810 class) so the two call sites cannot
// silently diverge on them.
function makeGitOut({ repoRoot, _exec }) {
  return (args) =>
    _exec('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
    });
}

export function computeDriftIsInherited({ repoRoot, pathspecs, _exec = execFileSync, env = {} }) {
  if (!Array.isArray(pathspecs) || pathspecs.length === 0) {
    throw new Error('computeDriftIsInherited: pathspecs must be a non-empty array');
  }
  // Local git only — deliberately NO `git fetch` (plan 1650 review [6]): a stale local
  // origin/master ref only moves the merge-base EARLIER, which puts MORE commits in
  // base..HEAD and can only flip the answer toward strict — never toward a false
  // "inherited". Skipping the network keeps a failing pre-push fast and offline-safe,
  // and none of the remaining commands can pop a credential dialog; the non-interactive
  // env is belt-and-suspenders on top (plan 810 class, review [4]).
  const gitOut = makeGitOut({ repoRoot, _exec });
  // '' = the shell's own rev-parse already failed; undefined = no precompute, run it here.
  const branchResult = resolveEnvOrCompute(env.COORD_DRIFT_BRANCH, () =>
    gitOut(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
  );
  if (!branchResult.ok) return false;
  const branch = branchResult.value;
  if (branch === 'master' || branch === 'HEAD') return false; // master / detached: strict
  // '' = the shell's own merge-base already failed/unresolvable; undefined = run it here.
  const baseResult = resolveEnvOrCompute(env.COORD_DRIFT_BASE, () =>
    gitOut(['merge-base', 'HEAD', 'origin/master']).trim(),
  );
  if (!baseResult.ok) return false; // no origin/master → cannot attribute → strict
  const base = baseResult.value;
  try {
    // exit 0 ⇔ the branch's own commits touched none of the inputs.
    gitOut(['diff', '--quiet', base, 'HEAD', '--', ...pathspecs]);
  } catch {
    return false; // branch touched an input (or git failed) → strict
  }
  try {
    // The checks read this WORKING TREE, not a commit — so uncommitted local dirt over
    // the same inputs (a dirty plan body flipping the stage gate, a hand-edited board
    // row) is THIS session's doing, never inherited (plan 1650 review [1]/[2] class).
    // Any porcelain output — modified, staged, or untracked — over the pathspecs ⇒ strict.
    const status = gitOut(['status', '--porcelain', '--', ...pathspecs]);
    return status.trim() === '';
  } catch {
    return false;
  }
}

// ── Stale-worktree-copy self-diagnosis (plan 2099) ──────────────────────────
//
// Decision (plan 2099): BOARD_INPUT_PATHSPECS/INDEX_INPUT_PATHSPECS are left covering
// all of docs/superpowers/plans/, NOT narrowed to exclude a branch's own plan-file
// churn — narrowing is the riskier direction (that pathspec exists to catch real
// coord tampering, e.g. a branch editing board-lib.mjs's own detection logic; carving
// out "but not MY plan file" would let a branch that quietly also vandalizes a
// SIBLING's plan file grade its own violation as inherited). The check below carries
// the diagnosis instead: when that quirk fires (own plan-file churn → strict, even
// though board.md/INDEX.md itself is untouched), the staleness message below tells
// the operator to rebase, which is the correct fix either way.
//
// computeDriftIsInherited (above) answers "did THIS branch's own commits cause the
// violation" — it does NOT tell a worktree session whose checkout is simply BEHIND
// origin/master (a sibling fixed the coord doc after this branch's cut/rebase point)
// that the fix is a rebase. Worse: plan 1664/1650's own pathspec set intentionally
// covers the whole docs/superpowers/plans/ tree (BOARD_INPUT_PATHSPECS /
// INDEX_INPUT_PATHSPECS), so a worktree that authored/moved its OWN plan file (a
// routine pickup-plan/move-plan commit) disqualifies the inherited-drift tolerance
// and goes STRICT even when the coord doc itself (board.md / INDEX.md) was never
// touched by this branch at all — the exact plan-2062 incident. That worktree then
// gets a raw drift report for a row that is already correct on origin/master, with no
// hint that a rebase — not a hand-fix of a coord row — is the way out.
//
// This check is a SEPARATE, narrower question than attribution: is the worktree's own
// copy of ONE specific coord doc (board.md, or INDEX.md) byte-identical to
// origin/master's copy of that same file, right now? If not, the doc itself is stale
// — regardless of why the calling lint's own attribution went strict — and rebasing
// is unconditionally the right next step (coord docs are never hand-committed on a
// worktree branch, so there is no "keep my local edit" case to worry about, unlike
// computeDriftIsInherited's pathspecs which DO include worktree-legitimate plan-file
// churn).
//
// Local git only, same as computeDriftIsInherited — no `git fetch` (a stale local
// origin/master ref only makes this UNDER-report staleness, i.e. print nothing extra
// rather than a false positive; never the wrong direction for a diagnostic message).
// Fails safe (`stale: false`) on any git error, including an unresolvable
// origin/master or a master/detached-HEAD checkout (the whole notion of "worktree
// copy vs. origin/master" only applies to a non-master worktree branch).
//
// `commitsBehind` is a best-effort extra (`git rev-list --count HEAD..origin/master
// -- <relPath>`, i.e. how many commits touching this exact file this branch hasn't
// seen) — the plan calls it optional ("not required"); a failure there degrades to
// `commitsBehind: null` without affecting the `stale` verdict itself.
export function checkWorktreeCoordDocStale({
  repoRoot,
  relPath,
  localContent,
  _exec = execFileSync,
  env = {},
}) {
  const notStale = { stale: false, commitsBehind: null };
  const gitOut = makeGitOut({ repoRoot, _exec });

  const branchResult = resolveEnvOrCompute(env.COORD_DRIFT_BRANCH, () =>
    gitOut(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
  );
  if (!branchResult.ok) return notStale;
  const branch = branchResult.value;
  if (branch === 'master' || branch === 'HEAD') return notStale;

  let masterContent;
  try {
    masterContent = gitOut(['show', `origin/master:${relPath}`]);
  } catch {
    return notStale; // no origin/master, or the path doesn't exist there → can't attribute
  }

  if (masterContent === localContent) return notStale;

  let commitsBehind = null;
  try {
    const out = gitOut(['rev-list', '--count', 'HEAD..origin/master', '--', relPath]).trim();
    const n = Number.parseInt(out, 10);
    if (Number.isInteger(n)) commitsBehind = n;
  } catch {
    // best-effort only — the stale verdict above already stands without it.
  }

  return { stale: true, commitsBehind };
}

// Shared wording for the staleness diagnosis both lints print when
// checkWorktreeCoordDocStale reports `stale: true` — one place so the message (and its
// named fix) can't drift between the two call sites. `relPath` is the repo-relative
// coord-doc path (BOARD_REL or 'docs/INDEX.md'); `commitsBehind` may be null (best-effort).
export function formatStaleWorktreeCoordDocMessage(relPath, { commitsBehind } = {}) {
  const behind =
    typeof commitsBehind === 'number'
      ? ` (${commitsBehind} commit${commitsBehind === 1 ? '' : 's'} behind on this file)`
      : '';
  return [
    '',
    `lint: your checkout's ${relPath} is STALE${behind} — it no longer matches origin/master's copy.`,
    `  The drift reported above may already be fixed on origin/master; this checkout just hasn't seen it.`,
    '  Fix: git rebase origin/master   then re-attempt the push.',
    '',
  ].join('\n');
}
