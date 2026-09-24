// scripts/check-coordination-branch.mjs
// Pre-commit guard, two blocks from one staged-set scan:
//
//  1. WORKTREE branches (plan 205): coordination files (board, handoff, INDEX, plans,
//     per-session entries) must be committed on master via $MAIN / the coord tools —
//     NEVER on a worktree branch (that commits to the wrong branch; /state never sees
//     it; and broad adds sweep sibling sessions' work — see plan 205 / 8f91e090).
//
//  2. NON-worktree branches (plan 1279): a HAND commit whose staged set touches a
//     coordination path is rejected on ANY branch — and on the shared MAIN checkout
//     specifically, wiki/** + WIKI.md are guarded too. Every sanctioned writer
//     (coordWrite/gitMoveCommit, board.mjs, index.mjs, move-plan, edit-plan,
//     coord-edit, claim-plan, next-plan-id, record-review, record-wiki, wiki-commit,
//     drain-run, pre-yield-guard's auto-park, the done-worktree close-out) commits
//     with HUSKY=0 and never runs this hook — so a block here is, by construction, a
//     hand commit: either a direct hand-edit of a coord/wiki doc (non-ff loops,
//     drift) or a pathspec-less `git commit` about to sweep a PEER session's staged
//     coord/wiki files into this commit (the plan-1256 incident: a manual wiki commit
//     swept session-1238's staged entry files). The hook can't see "did you use a
//     pathspec"; it CAN see the staged path set, and every dangerous write touches a
//     guarded path.
//
//     The wiki guard is scoped to the MAIN checkout (git-dir == git-common-dir): a
//     LINKED worktree — `worktree-*`, but also `staging-maptune` or a detached finish
//     worktree — has its OWN index, so a wiki hand-commit there has no sweep risk and
//     lands via its branch merge; blocking it would dead-end the session (wiki-commit
//     operates on $MAIN, not their checkout).
//
// Override for the rare deliberate case (both modes): BOARD_GUARD_OVERRIDE=1.

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIT_MAXBUFFER } from './coord-git.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';
import { loadCoordConfig, LEGACY_PATHS } from './coord-config.mjs';
import { escapeRegex } from './build-index-lib.mjs';

const REPO_ROOT = repoRootFrom(dirname(fileURLToPath(import.meta.url)));

// Build the coordination-path matcher from the configured handoff paths (plan 857).
// The guarded set: the rolling handoff file, the board, docs/INDEX.md, the plans
// tree, and the per-session entries dir. Default LEGACY_PATHS reproduces the
// pre-857 root-scattered regex byte-for-byte (config-less repos + direct tests).
export function coordinationRx(paths = LEGACY_PATHS) {
  const alts = [
    escapeRegex(paths.rollingHandoffFile),
    escapeRegex(paths.boardFile),
    'docs/INDEX\\.md',
    'docs/superpowers/plans/',
    `${escapeRegex(paths.sessionsDir)}/`,
  ];
  return new RegExp(`^(${alts.join('|')})`);
}

export const COORDINATION_RX = coordinationRx(LEGACY_PATHS);

// plan 4135: this whole file runs as a git pre-commit hook child, and on a PATHSPEC commit
// (`git commit -m … -- <path>`) git points GIT_INDEX_FILE at a scratch file
// (`<gitdir>/next-index-<pid>.lock`) for the duration of the hook — the temporary index that
// carries ONLY the pathspec's own staged content, distinct from the checkout's own default
// index. `gitRepoIsolatedEnv()` alone strips GIT_INDEX_FILE along with the other ambient
// repo-selector vars. That is harmless for the reads that never touch the index, but wrong
// for the two that read the STAGED SET (`diff --cached`, `rev-parse :0:<path>`): stripped, they fall back to the
// checkout's DEFAULT index, which does not carry the pathspec commit's staged content — so a
// pathspec commit of a guarded coord path, made while the default index holds only an
// unguarded file, reads as carrying nothing guarded and slips the guard entirely. Re-admitting
// git's own hook-provided GIT_INDEX_FILE (never an ambient value the process merely inherited —
// git sets it itself, for THIS hook invocation, on THIS commit) closes that gap. Every spawn in
// this file takes it uniformly (one rule for the whole hook; it is inert for non-index reads).
// Same precedent
// as `scripts/hooks/pathspec-commit-prettier.mjs`'s `listPathspecStagedPaths`: strip everything,
// then re-apply only the one setting a pathspec-aware staged-set read actually needs.
export function hookIndexSetting(env = process.env) {
  return env.GIT_INDEX_FILE ? { GIT_INDEX_FILE: env.GIT_INDEX_FILE } : {};
}

// The wiki tree + its root doc, guarded ONLY on the shared main checkout (plan 1279).
// main-checkout-allowlist.mjs's DOC_RX carries the same two patterns in its commit-safe
// class; the two sets serve different layers (edit allowlist vs commit guard) so they
// are not merged, but a cross-tie test (check-coordination-branch.test.mjs) asserts
// they stay in agreement. wiki-commit.mjs imports THIS constant for its path scope, so
// what the guard blocks and what the helper accepts cannot drift apart.
// docs/superpowers/specs/** is deliberately NOT guarded: specs are hand-authored on
// master with no sanctioned committer tool, so blocking them would strand authoring
// (accepted residual, recorded in plan 1279).
export const WIKI_RX = /^(wiki\/|WIKI\.md$)/;

// null = commit allowed. Otherwise { mode: 'worktree' | 'main', hits } — 'worktree' is
// the plan-205 wrong-branch block; 'main' the plan-1279 hand-commit block on any other
// branch (master / detached / oddly-named), whose guarded set adds wiki/** + WIKI.md
// when opts.mainCheckout (defaults true — the conservative direction; main() passes
// the real git-dir == git-common-dir answer).
export function classifyBlock(branch, stagedPaths, env, rx = COORDINATION_RX, opts = {}) {
  if (env.BOARD_GUARD_OVERRIDE === '1') return null;
  const { mainCheckout = true } = opts;
  const norm = stagedPaths.map((p) => p.replace(/\\/g, '/'));
  if (branch.startsWith('worktree-')) {
    const hits = norm.filter((p) => rx.test(p));
    return hits.length ? { mode: 'worktree', hits } : null;
  }
  const hits = norm.filter((p) => rx.test(p) || (mainCheckout && WIKI_RX.test(p)));
  return hits.length ? { mode: 'main', hits } : null;
}

export function shouldBlock(branch, stagedPaths, env, rx = COORDINATION_RX, opts = {}) {
  return classifyBlock(branch, stagedPaths, env, rx, opts) !== null;
}

// plan 2391: a commit made on a DETACHED **main** checkout is silently lossy.
// Observed 2026-07-25: a docs(runbooks) commit succeeded normally, then 8
// `pull --rebase` + push retries each read as an ordinary ref-lock race while
// the rebases were picking the commit onto the detached HEAD and `refs/heads/master`
// stayed stranded behind. Once the detached HEAD had no local commits left ahead of
// origin, the next pull logged a bare `Fast-forward` and the work was gone from the
// tip. The commit object survived (recoverable via cherry-pick) but nothing said so.
//
// Scope is deliberately narrow — MAIN checkout only. The land spine's legitimate
// detached-HEAD `HEAD:master` push runs from an EPHEMERAL done-worktree, i.e. a
// LINKED worktree (git-dir != git-common-dir), as `scripts/hooks/pre-push.sh` documents at its
// seed-gate comment: "the seed-bearing land pushes `HEAD:master` from a detached-HEAD
// ephemeral worktree (done-worktree), where `rev-parse --abbrev-ref HEAD` is "HEAD"
// not "master"". Every `worktree add --detach` in the repo (resolveCoordCheckout,
// runCloseOutIsolated, landBranchViaEphemeral) likewise targets a LINKED path, so the
// land path cannot trip this guard.
//
// MAIN itself IS reachably detached, though — transiently, because `git rebase`
// detaches HEAD for its duration, and `pushMasterWithRebase` (coord-git.mjs) rebases
// directly on whatever dir it is handed, including the shared MAIN checkout (callers:
// heal-main, drain-run, and pre-yield-guard via the Stop auto-heal hook, which fires
// every session Stop). That is precisely why the repo already carries a repair
// primitive, `reattachMainToMaster`. So the claim this guard rests on is NOT "MAIN is
// never detached" — it is narrower and survives that fact: a HAND commit while MAIN is
// detached is lossy no matter WHY it is detached. The spine's own replays never trip
// the guard (coord writers commit with HUSKY=0, and `git rebase` does not run
// pre-commit), so what remains blocked is exactly the dangerous case.
//
// `branch` is the `rev-parse --abbrev-ref HEAD` answer, which is the literal string
// "HEAD" exactly when detached (same fact the pre-push comment above relies on).
export function classifyDetachedMain(branch, env, opts = {}) {
  if (env.BOARD_GUARD_OVERRIDE === '1') return null;
  const { mainCheckout = true } = opts;
  if (!mainCheckout) return null; // linked worktree — the land spine detaches on purpose
  if (branch !== 'HEAD') return null; // attached to a real branch
  return { mode: 'detached-main' };
}

// Message for the detached-main refuse. `masterSha` is advisory (null when the ref
// can't be read) — the recovery recipe still stands without it.
export function formatDetachedMainMessage(headSha, masterSha) {
  return [
    '✋ detached-HEAD guard (plan 2391): refusing to commit on the DETACHED main checkout.',
    '   A commit made here is SILENTLY LOST by the next `git pull --rebase`: the rebase',
    '   replays it onto the detached HEAD while refs/heads/master stays stranded behind,',
    '   and once HEAD has nothing left ahead of origin the next pull fast-forwards the',
    '   work off the tip. The push retries read only as ref-lock races.',
    `   HEAD (detached): ${headSha || 'unknown'}`,
    `   refs/heads/master: ${masterSha || 'unreadable'}`,
    '   Reattach FIRST, then commit:',
    '     git checkout master        # or: git checkout -B master <the sha you want>',
    '   If you already committed here and lost it, recover with:',
    '     git reflog                 # find the lost sha',
    '     git cherry-pick <lost sha>',
    '   Override (rare, deliberate): BOARD_GUARD_OVERRIDE=1 git commit ...',
  ];
}

// Pass 1307: MERGE-CONCLUSION exemption. The plan-507 freshen flow merges
// origin/master INTO a worktree branch; a CONFLICTED freshen is concluded with a
// hand `git commit` (the LAND_BLOCKED_HOLDING seam's own instruction) — which,
// unlike git's auto-merge commit, runs this pre-commit hook. Master's delta
// almost always contains plan/board files, so the conclusion commit used to be
// unguardable-through. A staged path whose blob is IDENTICAL to a merge
// parent's (HEAD or MERGE_HEAD) was not authored in this commit — it is merge
// inheritance, not a hand edit — so it is dropped from the guarded set. A
// guarded path whose staged content differs from BOTH parents (a hand edit
// smuggled into the merge, incl. a conflict "resolution" that rewrites a coord
// doc) still blocks.
export function filterMergeInheritedPaths(stagedPaths, gitDirCwd = process.cwd()) {
  const rev = (args) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      cwd: gitDirCwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      // plan 4135: `:0:<path>` (stagedBlob below) reads the STAGED index, so this needs the
      // hook's own GIT_INDEX_FILE re-admitted (hookIndexSetting) — see that function's header.
      env: gitRepoIsolatedEnv(hookIndexSetting()),
    }).trim();
  let mergeHead;
  try {
    mergeHead = rev(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  } catch {
    return stagedPaths; // no merge in progress — no exemption
  }
  if (!mergeHead) return stagedPaths;
  const blobAt = (ref, p) => {
    try {
      return rev(['rev-parse', `${ref}:${p}`]);
    } catch {
      return null; // path absent at that parent
    }
  };
  const stagedBlob = (p) => {
    try {
      return rev(['rev-parse', `:0:${p}`]);
    } catch {
      return null; // unmerged or absent — keep guarded (conservative)
    }
  };
  // A file BOTH histories touched auto-merges to a blend that differs from both
  // parents yet still involves no hand — compare against git's own pure
  // auto-merge tree (merge-tree writes a tree even when other paths conflict).
  let autoTree = null;
  try {
    autoTree = execFileSync(
      'git',
      ['merge-tree', '--write-tree', '--messages', 'HEAD', mergeHead],
      {
        encoding: 'utf8',
        cwd: gitDirCwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: gitRepoIsolatedEnv(hookIndexSetting()),
      },
    )
      .split('\n')[0]
      .trim();
  } catch (e) {
    // conflicted merges exit non-zero but still print the tree oid first
    const out = (e.stdout || '').toString();
    autoTree = out ? out.split('\n')[0].trim() : null;
  }
  return stagedPaths.filter((p) => {
    const s = stagedBlob(p);
    if (s == null) {
      // Path absent from stage-0: either UNMERGED (stages 1-3 — keep guarded,
      // conservative) or a staged DELETION. A deletion whose path is ALSO
      // absent on the master side (a plan file master moved/archived) is
      // merge inheritance, not a hand delete — exempt it. `ls-files --stage`
      // distinguishes: unmerged paths still list (stages 1-3), deletions don't.
      let unmerged = '';
      try {
        unmerged = rev(['ls-files', '--stage', '--', p]);
      } catch {
        /* treat as deletion probe below */
      }
      if (!unmerged && blobAt('MERGE_HEAD', p) == null) return false;
      return true;
    }
    if (s === blobAt('HEAD', p) || s === blobAt('MERGE_HEAD', p)) return false;
    if (autoTree && s === blobAt(autoTree, p)) return false;
    return true;
  });
}

// Is this checkout the shared MAIN checkout (the one whose index peers share)?
// A linked worktree's --absolute-git-dir is <main>/.git/worktrees/<name>, distinct
// from --git-common-dir (<main>/.git); on the main checkout the two coincide.
// Conservative on any git failure: treat as main (the guarded direction).
//
// plan 2391 review (finding azlms7) — the fail-open-to-MAIN default was tuned when the
// only consumer was the soft wiki/coord path guard; it now also feeds classifyDetachedMain,
// whose block is UNCONDITIONAL and exits 1. Re-decided deliberately, and KEPT, for three
// reasons: (1) the hard block additionally requires `branch === 'HEAD'`, and that answer
// comes from a rev-parse that main() already ran SUCCESSFULLY — so "git is too broken to
// answer isMainCheckout" and "git just answered a rev-parse" rarely coexist; (2) the two
// error directions are not symmetric — a wrong refuse costs one `BOARD_GUARD_OVERRIDE=1`
// retry, which the message itself prints, while a wrong ALLOW silently eats the commit and
// the loss surfaces (if at all) as unrelated push-race noise; (3) inverting the default here
// would ALSO loosen the wiki guard, its original consumer. Do not flip this to `return false`
// without re-deciding both consumers.
export function isMainCheckout(cwd = process.cwd()) {
  try {
    // plan 4087 T5: this hook runs as a git-commit subprocess, and git EXPORTS GIT_DIR /
    // GIT_COMMON_DIR into every hook child for the commit it is running (see lock-path.mjs /
    // pass-cache-kernel.mjs's identical warning) — inherited here with no `env`, an ambient
    // GIT_DIR overrides `cwd` and both reads answer about THAT repo, not the one at `cwd`, so a
    // linked worktree can misreport as the main checkout (or vice versa) without git ever
    // erroring. gitRepoIsolatedEnv() drops just the repo-selector vars so `cwd` is the only
    // thing selecting the repo, exactly as the two callers below already assume.
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
      cwd,
      env: gitRepoIsolatedEnv(),
    }).trim();
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      cwd,
      env: gitRepoIsolatedEnv(),
    }).trim();
    return resolve(gitDir) === resolve(cwd, common);
  } catch {
    // Unchanged by the env fix above: this default is about a git command FAILING (not found,
    // corrupt repo, permission error), not about which repo it answered for — the read is now
    // trustworthy up to that fail-open, so it stays. See the header comment above this function
    // for the load-bearing reasons (fail-toward-guarded, cheap override, the wiki-guard tie-in).
    return true;
  }
}

// Single source of truth for the block message — shared by this hook's own
// console.error output AND `scripts/hooks/coord-write-guard-pretooluse.mjs`
// (the plan-1655 proactive PreToolUse hook that intercepts a `git add`/`git
// commit` touching a guarded path BEFORE the Bash tool call even runs, so the
// same sanctioned-tools text reaches the model earlier instead of only after
// husky's pre-commit rejects it). Returns an array of lines, no trailing
// blank-line framing — callers add their own leading/trailing spacing.
export function formatBlockMessage(res, branch) {
  const lines = [];
  const header =
    res.mode === 'worktree'
      ? '✋ coordination-branch guard: refusing to commit coordination files on a worktree branch.'
      : '✋ coord-doc/wiki write guard (plan 1279): refusing a HAND commit of coordination/wiki files here.';
  lines.push(header);
  lines.push(`   Branch: ${branch}`);
  lines.push(`   Blocked paths:\n     ${res.hits.join('\n     ')}`);
  if (res.mode === 'worktree') {
    lines.push(
      '   These belong on master via $MAIN / scripts/board.mjs (see done-worktree step 9 / the $MAIN pattern).',
    );
  } else {
    lines.push(
      '   These commit ONLY via the sanctioned tools (pathspec commit + rebase-retry, HUSKY=0):',
    );
    lines.push('     board / queue rows      → scripts/board.mjs');
    lines.push('     docs/INDEX.md           → scripts/index.mjs (repath: scripts/move-plan.mjs)');
    lines.push(
      '     plan bodies             → scripts/edit-plan.mjs (new plans: scripts/next-plan-id.mjs claim)',
    );
    lines.push(
      '     session / handoff docs  → scripts/coord-edit.mjs --paths <file> --message "…"',
    );
    lines.push('     wiki/** + WIKI.md       → node scripts/wiki-commit.mjs <pages…> -m "…"');
    lines.push(
      '   If a blocked path is NOT yours, a PEER session staged it — a pathspec-less commit would',
    );
    lines.push('   sweep it under your message (the plan-1256 incident). Do not commit it.');
  }
  lines.push('   Override (rare, deliberate): BOARD_GUARD_OVERRIDE=1 git commit ...');
  return lines;
}

export function main() {
  const rx = coordinationRx(loadCoordConfig(REPO_ROOT).paths);
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
    env: gitRepoIsolatedEnv(hookIndexSetting()),
  }).trim();
  // plan 2391: the detached-main refuse comes FIRST — it is independent of the staged
  // set (any commit here is lossy, not just a coord one), so it must not be reachable
  // only when a guarded path happens to be staged.
  const isMain = isMainCheckout();
  const detached = classifyDetachedMain(branch, process.env, { mainCheckout: isMain });
  if (detached) {
    const readRef = (ref) => {
      try {
        return execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
          encoding: 'utf8',
          env: gitRepoIsolatedEnv(hookIndexSetting()),
        }).trim();
      } catch {
        return null;
      }
    };
    console.error(
      '\n' +
        formatDetachedMainMessage(readRef('HEAD'), readRef('refs/heads/master')).join('\n') +
        '\n',
    );
    process.exit(1);
  }
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
    encoding: 'utf8',
    maxBuffer: GIT_MAXBUFFER, // plan 850: a large-data commit's staged name-only list overflows the 1MB default
    // plan 4135: reads the STAGED set — on a pathspec commit this must be the hook's own
    // temporary GIT_INDEX_FILE, never the checkout's default index (hookIndexSetting).
    env: gitRepoIsolatedEnv(hookIndexSetting()),
  })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  // pass 1307: concluding a conflicted freshen-merge (plan 507) hand-commits the
  // merge, whose staged set inherits master's coord/plan commits verbatim — drop
  // paths identical to a merge parent before classifying (see the helper's doc).
  const guardable = filterMergeInheritedPaths(staged);
  const res = classifyBlock(branch, guardable, process.env, rx, {
    mainCheckout: isMain,
  });
  if (res) {
    console.error('\n' + formatBlockMessage(res, branch).join('\n') + '\n');
    process.exit(1);
  }
  process.exit(0);
}

import { pathToFileURL } from 'node:url';
import { repoRootFrom } from './scripts-anchor.mjs';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
