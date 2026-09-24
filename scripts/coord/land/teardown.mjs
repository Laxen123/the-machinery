// scripts/coord/land/teardown.mjs — plan 3961 T3.2: the land spine's teardown phase, moved out
// of scripts/done-worktree.mjs behaviour-identical (parity proven by
// scripts/coord/land/parity.test.mjs's 12 scenarios against committed goldens, plus the full
// 571-case scripts/done-worktree.test.mjs, both unchanged by this move).
//
// WHAT THIS MODULE OWNS. The teardown phase of the file header's five-phase landing sequence:
// killing processes still running under the just-landed worktree, reclaiming its cwd-keyed
// auto-memory, removing the worktree directory (with a locked-tree defer to the idle sweep),
// and deleting the landed branch (local + remote) — all best-effort, a failure recorded into
// state.teardownErrors rather than thrown, never propagated (the cross-PC mutex is already
// released by the close-out push by the time teardown runs, so nothing here can block another
// session). It also owns the `--finish-close-out` resume path (plan 3375): gathering, from
// origin alone, every fact a DEAD land's resume needs (gatherCloseOutFacts), building the
// minimal spine state that path runs against (finishCloseOutState), a trimmed worktree-dir
// clear for a checkout that never hosted the dead land's dev servers (finishRemoveWorktreeDir),
// and the mode itself (runFinishCloseOut). It is generic — no project-specific vocabulary
// anywhere in this file.
//
// HOW THIS MODULE REACHES THE REST OF THE WORLD. A non-test module under scripts/coord/ may
// import only scripts/coord/** and node: builtins (Rule 3,
// docs/runbooks/scripts-module-layout.md) — so every one of the plain scripts/*.mjs modules
// this code used to reach directly is instead read off the bound dependency container,
// `landDeps()` (scripts/coord/land/deps.mjs), AT CALL TIME, inside each function — never at
// module top level. `D` (this module's convention: `const D = landDeps();` as the first line of
// every function that needs it) is the same one-letter binding every other
// scripts/coord/land/*.mjs core module uses for the same reason.
//
// THE `spine` GROUP. `tryStep` — the shared best-effort step wrapper this module's teardown()
// and runFinishCloseOut both use — is NOT here, deliberately: it also has ~9 call sites outside
// this module, so it stays in done-worktree.mjs and is reached as `D.spine.tryStep`, exactly
// like close-out.mjs's own `spine` members. `runCloseOutIsolated`, `pruneCloudDiskHeadroom`,
// `recoverLandedMergeSha`, and `readCarryForwards` join `spine` with this move — each is called
// from this module (runFinishCloseOut / finishCloseOutState) but stays in done-worktree.mjs for
// its own stated reason (see that file's bindLandDeps() call for each one's rationale).
// `pwshExe` — the local PowerShell-resolution wrapper teardown() and finishRemoveWorktreeDir
// both shell out through — joins `spawn` instead: it is a spawn-target primitive in the same
// category as `run`/`gitMain` (which teardown() already used through `spawn`), not spine-wide
// control-flow policy like `emitSeam`/`tryStep`.
//
// EXPORTS. `teardown` is called by done-worktree.mjs's main() (both on a normal land and on the
// teardown-after-post-land-failure path). `gatherCloseOutFacts` and `runFinishCloseOut` are
// called by done-worktree.mjs's main() (the `--finish-close-out` branch) as well as, directly,
// by done-worktree.test.mjs — a deliberate, temporary re-export from done-worktree.mjs (T4 moves
// those test cases into this module's own teardown.test.mjs and drops it). `finishCloseOutState`
// and `finishRemoveWorktreeDir` are module-private: nothing outside runFinishCloseOut calls them.
//
// A PURE MOVE. Every moved function is byte-identical to its done-worktree.mjs original apart
// from the mechanical container-access rewrites (`L.foo(` → `D.L.foo(`, `DRY` → `D.env.DRY`,
// `run(` → `D.spawn.run(`, and so on) — no renames, no reordering, no incidental fixes, with one
// narrow exception: gatherCloseOutFacts's own comment about the extra landing-queue fetch swaps
// out a single word this module's acceptance grep (scripts/assert-scripts-self-contained.mjs's
// noun list) flags as a project term, even though it only ever meant "worth the cost" here — the
// sentence now reads "one round trip is worth paying for", same meaning, no project vocabulary
// involved. Every comment moved with its function; they carry the plan history that explains the
// code.
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { landDeps } from './deps.mjs';

// plan 4066 task 0: the member-level container-read manifest for this module — see
// preflight.mjs's own CONTAINER_READS comment for what asserts it and when, and
// container-manifest.mjs's header for the aggregator itself. Generated, not hand-typed;
// regenerate with the same scanner on a real change to this file's container reads.
export const CONTAINER_READS = Object.freeze({
  L: Object.freeze([
    'buildProcessKillCommand',
    'isCloudLand',
    'planFinishCloseOut',
    'readHeartbeatDays',
  ]),
  boardLib: Object.freeze(['findRowLineIndex', 'splitBoard']),
  claimPlanLib: Object.freeze(['isBatchSlug']),
  coordConfig: Object.freeze(['loadCoordConfig']),
  coordSessionId: Object.freeze(['coordinationSessionId']),
  env: Object.freeze(['DRY']),
  landingQueueLib: Object.freeze(['parseQueue']),
  landingQueueRef: Object.freeze(['readQueueDoc']),
  reconcileWorktreeBranches: Object.freeze([
    'buildPlanFolderIndex',
    'listPlanPathsAtOriginMaster',
    'listRemoteClaimIds',
  ]),
  spawn: Object.freeze(['gitMain', 'node', 'pwshExe', 'run']),
  spine: Object.freeze([
    'pruneCloudDiskHeadroom',
    'readCarryForwards',
    'recoverLandedMergeSha',
    'runCloseOutIsolated',
    'tryStep',
  ]),
  sweepDeferredWorktrees: Object.freeze(['recordDeferredRemoval', 'runSweepAndReport']),
  worktreePorcelain: Object.freeze(['parseWorktreePorcelain']),
});

// ── teardown ────────────────────────
// The cross-PC mutex is already released by the close-out push, so anything
// failing here cannot block another session — record and move on.
export function teardown(MAIN, wtPath, branch, state) {
  const D = landDeps();
  const isWin = process.platform === 'win32';
  // `git worktree list --porcelain` emits FORWARD slashes on Windows
  // (C:/Users/...), but node/esbuild process CommandLines use BACKSLASHES — so a
  // kill / removal that matches only the forward-slash form under-matches and
  // leaves the live processes (→ a lingering worktree dir + branch, the
  // 2026-06-04 symptom). Compute the backslash form ONCE here and match BOTH in
  // the kill (step 1) and the forced dir removal (step 3b). git itself accepts
  // either, so the git-level steps (3a/3c) keep the original wtPath. (plan 378)
  const wtWin = wtPath.replace(/\//g, '\\');

  // 1. kill processes whose cmdline/exe lives under THIS worktree path
  D.spine.tryStep(state, 'process-kill', () => {
    if (D.env.DRY) {
      D.spawn.run(D.spawn.pwshExe(), ['-NoProfile', '-Command', `<<kill procs under ${wtPath}>>`]);
      return;
    }
    if (isWin) {
      // plan 681: command excludes the searcher's own PID (no self-kill) + forces
      // exit 0. plan 3092: also excludes the ancestry of the spine's own process
      // (process.pid), the invoking shell included — the invoker's worktree-path
      // command line was matching and killing IT, not just legit dev-server
      // targets. Full rationale lives in buildProcessKillCommand's JSDoc.
      const ps = D.L.buildProcessKillCommand(wtPath, process.pid);
      const n = D.spawn.run(D.spawn.pwshExe(), ['-NoProfile', '-Command', ps]);
      state.killed = parseInt(n, 10) || 0;
    } else {
      const pids = D.spawn
        .run('bash', ['-c', `lsof -t +D '${wtPath}' 2>/dev/null | sort -u || true`])
        .split('\n')
        .filter(Boolean);
      pids.forEach((p) =>
        D.spine.tryStep(state, `kill ${p}`, () => D.spawn.run('kill', ['-9', p])),
      );
      state.killed = pids.length;
    }
  });

  // 2. reclaim the worktree's cwd-keyed auto-memory (dry then apply). plan 3961 T2.7b: the
  // script path is `land.worktreeMemoryReclaimScript` — a config-less repo (or one that never
  // sets the key) gets `null`, and this step is skipped outright (no DRY trace line, no
  // best-effort run at all). A leading `~/` is expanded against `USERPROFILE || HOME` the same
  // way the pre-3961 literal always resolved its home segment.
  //
  // plan 3961 T2 review round 3 (fix 1a): land policy is read from MAIN, never from the branch
  // under land (same rule as phasePreflight's `cfg`) — otherwise the branch would choose the
  // SCRIPT the spine then executes. Round 2 tried to satisfy this with a fresh `resolveMain()`
  // call HERE, inside teardown() — but teardown runs AFTER opportunisticFfMain has already
  // fast-forwarded MAIN over the just-merged branch, so a lookup at this point reads the
  // BRANCH's own coord.config.json off the now-updated MAIN tree, not the pre-land one. The
  // fix is to resolve the value ONCE in phasePreflight, before any merge, and carry it on
  // `state.worktreeMemoryReclaimScript` — read it back here instead of re-resolving. A resume
  // path that reaches teardown without state having that field set (never actually happens
  // today: state is rebuilt fresh in phasePreflight on every invocation, `--resume` included,
  // and the cfg read above sits unconditionally ahead of every teardown call site in this same
  // function) is treated as "not configured", the same as an explicit null — never a fallback
  // config read here. Accepted consequence, same direction as round 2's: a branch that CHANGES
  // this key sees it take effect from the next land onward, not its own.
  D.spine.tryStep(state, 'memory-reclaim', () => {
    const configured = state.worktreeMemoryReclaimScript;
    if (!configured) return;
    const script = configured.startsWith('~/')
      ? `${process.env.USERPROFILE || process.env.HOME}/${configured.slice(2)}`
      : configured;
    if (D.env.DRY) {
      D.spawn.run(D.spawn.pwshExe(), [
        '-NoProfile',
        '-File',
        script,
        '-WorktreePath',
        wtPath,
        '-Apply',
      ]);
      return;
    }
    if (isWin) {
      const out = D.spawn.run(D.spawn.pwshExe(), [
        '-NoProfile',
        '-File',
        script,
        '-WorktreePath',
        wtPath,
        '-Apply',
      ]);
      state.memory = {
        moved: (out.match(/NEW/g) || []).length,
        dup: (out.match(/DUP/g) || []).length,
        diverged: (out.match(/DIVERGED/g) || []).length,
      };
    }
  });

  // 3. remove the worktree directory (robust + honest — plan 338 Task 2)
  // The 2026-06-04 dogfood left the dir + local branch behind: a worktree that
  // ran `pnpm install` has locked / >MAX_PATH files under node_modules, and a bare
  // `Remove-Item -ErrorAction SilentlyContinue` swallows the partial failure. Process
  // kill (step 1 above) has already freed any live node/esbuild holding the tree, so:
  //   3a. clear the git registration cleanly (also removes the dir when it works);
  //   3b. if the dir survives, force it — Remove-Item then `cmd /c rmdir /s /q` fallback,
  //       retried a few times (posix: rm -rf);
  //   3c. prune the registration regardless;
  //   3d. record any residual dir in teardownErrors so formatReport tells the truth.
  // soft(): best-effort run that neither throws nor records (only 3d's final check does).
  const soft = (cmd, args) => {
    try {
      D.spawn.run(cmd, args);
    } catch {
      /* best-effort; the existsSync gate / 3d decide the real outcome */
    }
  };
  const survives = () => D.env.DRY || existsSync(wtPath);
  // Both forced-removal commands need the BACKSLASH form (`wtWin`, computed at
  // the top of teardown): the `\\?\` long-path prefix disables normalization (a
  // `/` becomes a literal filename char → path-not-found, silently swallowed by
  // SilentlyContinue), and `rmdir` reads a forward-slash segment like `/Users`
  // as a switch ("Parameter format not correct"). This slash mismatch was THE
  // cause of the 2026-06-04 lingering dir. git itself accepts either, so 3a/3c
  // keep the original wtPath.
  D.spine.tryStep(state, 'worktree-remove', () => {
    // 3a. git-level removal first. plan 1286: a LOCKED worktree (a long-path node_modules
    // handle pinning the tree — observed twice in the 2026-07-02 window, both hand-fixed
    // with `-f -f`) refuses a single --force; git's documented escape is DOUBLE --force,
    // so escalate to it before falling to the raw dir removal below.
    soft('git', ['-C', MAIN, 'worktree', 'remove', '--force', wtPath]);
    if (survives()) soft('git', ['-C', MAIN, 'worktree', 'remove', '--force', '--force', wtPath]);
    // 3b. forced dir removal if anything survived — ONE pass only (plan 2218).
    //     Remove-Item handles >MAX_PATH via `\\?\`; `rmdir /s /q` is the reliable closer
    //     for pnpm's reparse-point junctions that Remove-Item -Recurse chokes on.
    //     A dir that survives BOTH is the locked-tree profile (a long-path node_modules
    //     handle pinning the tree) — plan 2198 correlated the old ×3 retry storm here
    //     (minutes of forced recursive deletes over a junction/hard-link-dense tree
    //     sharing file inodes with the main checkout, on a machine with a documented
    //     Wof.sys filter-driver race under parallel enumeration) with every 2026-07-21
    //     main-checkout `.pnpm`/`.bin` store tear. So: no retries — defer to the idle
    //     sweep in 3d instead.
    if (survives()) {
      if (isWin) {
        soft(D.spawn.pwshExe(), [
          '-NoProfile',
          '-Command',
          `Remove-Item -LiteralPath '\\\\?\\${wtWin}' -Recurse -Force -ErrorAction SilentlyContinue`,
        ]);
        if (survives()) soft('cmd', ['/c', 'rmdir', '/s', '/q', wtWin]);
      } else {
        soft('rm', ['-rf', wtPath]);
      }
    }
    // 3c. prune the registration regardless
    D.spawn.run('git', ['-C', MAIN, 'worktree', 'prune', '-v']);
    // 3d. honest accounting + defer-not-storm (plan 2218): a surviving dir is recorded
    //     in the deferred-removal marker; the next done-worktree/cut-worktree invocation
    //     retries removal ONCE via sweepDeferredWorktrees when the locker is gone.
    if (!D.env.DRY && existsSync(wtPath)) {
      let deferNote;
      try {
        D.sweepDeferredWorktrees.recordDeferredRemoval(MAIN, {
          dir: wtPath,
          slug: state.slug,
          branch,
          reason: 'locked-tree teardown defer (plan 2218)',
        });
        deferNote =
          `deferred to the idle sweep (.scratch/deferred-worktree-removals.jsonl; ` +
          `the next done-worktree/cut-worktree retries once — manual removal is also ` +
          `safe once the locker is gone)`;
      } catch (e) {
        deferNote = `defer-marker write FAILED (${e.message || e}) — remove by hand`;
      }
      (state.teardownErrors ||= []).push(
        `worktree-remove: dir still present after git-remove + one forced pass ` +
          `(locked / long-path node_modules) — ${deferNote}: ${wtPath}`,
      );
    }
  });

  // 4. delete the branch (local + remote)
  // plan 971: with the post-merge bookkeeping moved off the main checkout (syncMain:false),
  // the shared local master may lag origin/master — the opportunistic ff is SKIPPED when the
  // main checkout is dirty (the exact case 971 makes non-blocking). `git branch -d`'s
  // "fully merged" check is against the LOCAL master, so it then refuses ("not fully merged")
  // even though the branch IS on origin/master. By teardown the merge has demonstrably landed
  // (we are past closeOut, state.mergeSha set), so the local branch ref is redundant — fall
  // back to `-D`. Pre-971 `-d` always succeeded because syncLocalMaster had advanced local
  // master; the `-D` fallback restores that cleanup without depending on the main checkout.
  D.spine.tryStep(state, 'branch-delete-local', () => {
    try {
      D.spawn.run('git', ['-C', MAIN, 'branch', '-d', branch]);
    } catch {
      D.spawn.run('git', ['-C', MAIN, 'branch', '-D', branch]); // merge is on origin/master → safe
    }
  });
  D.spine.tryStep(state, 'branch-delete-remote', () =>
    D.spawn.run('git', ['-C', MAIN, 'push', 'origin', '--delete', branch]),
  );
}

// ── plan 3375: --finish-close-out — resume a DEAD land's close-out from a FRESH session ──────
// The spine has always been idempotent on re-invoke: isBranchAlreadyLanded short-circuits every
// pre-merge gate and control falls straight through to closeOut + teardown. What it could NOT
// survive is the death of the SESSION. `resolveWorktree(slug)` (called before any of that) reads
// `git worktree list --porcelain` on THIS checkout's `.git`, so a fresh clone — or a checkout
// whose teardown already removed the worktree — throws `worktree for slug "…" not found` and the
// bare re-invoke has no recovery path at all. That is the whole gap the 2026-08-21/22 cloud
// deaths fell into: the merge landed, the close-out tail did not, and nothing could finish it.
//
// This mode closes it by deriving WHERE the dead land stopped entirely from ORIGIN state — no
// worktree, no `.scratch/` sidecar (both are local-filesystem-only, invisible to a fresh clone),
// no in-memory spine state — and then finishing each remaining step idempotently. The decision
// half is pure (L.planFinishCloseOut); this half is the IO gather + the clears.

// Every fact L.planFinishCloseOut needs, read from origin. Deliberately built on the READ-ONLY
// detectors reconcile-worktree-branches.mjs already owns (buildPlanFolderIndex over
// listPlanPathsAtOriginMaster; listRemoteClaimIds) and on land-lib's own branchAlreadyLanded —
// the same ground truth the spine's isBranchAlreadyLanded uses — rather than a fourth hand-rolled
// notion of "did this land?". `_git` is the test seam (same shape as gitMain).
//
// Every read fails SOFT to `null` (unknown) rather than to a value: planFinishCloseOut treats an
// unknown bookkeeping fact as "attempt the clear anyway" (each clear is itself idempotent), while
// the two facts that PROVE the land — branchMerged and planFolder — fail toward refusing. An
// unreadable origin therefore never converts into a teardown.
export function gatherCloseOutFacts(MAIN, slug, { _git = landDeps().spawn.gitMain } = {}) {
  const D = landDeps();
  const branch = `worktree-${slug}`;
  // The same direct-match id derivation closeOutSingle uses (plan 822) — never a third regex.
  const planId = (String(slug).match(/^(\d{3,})-(?![0-9])/) || [])[1] || null;
  const facts = {
    slug,
    branch,
    isBatch: D.claimPlanLib.isBatchSlug(slug),
    planId,
    planFolder: null,
    planBasename: null,
    planBasenameMatchesSlug: null,
    planHeartbeat: false,
    fetchOk: false,
    // Tri-state: true / false / null-unknown. An unanswered probe is NEVER downgraded to
    // "absent" — planFinishCloseOut refuses on null rather than reporting a false all-clear.
    branchOnOrigin: null,
    branchMerged: null,
    branchTip: null,
    branchLocal: null,
    claimOnOrigin: null,
    queueEntry: null,
    boardRow: null,
    // Tri-state like branchOnOrigin: an unreadable `git worktree list` is UNKNOWN, not "no dir".
    worktreeDirPresent: null,
    worktreePath: null,
  };
  // Fetch before judging (CLAUDE.md) — every judgment below reasons about origin/master, and a
  // fresh clone's remote-tracking refs are exactly as stale as the last fetch left them.
  // A FAILED fetch is recorded, not swallowed: planFinishCloseOut refuses on it rather than
  // judging a teardown off stale remote-tracking refs.
  try {
    _git(MAIN, ['fetch', 'origin', 'master']);
    facts.fetchOk = true;
  } catch {
    facts.fetchOk = false;
  }

  try {
    facts.branchOnOrigin = Boolean(
      String(_git(MAIN, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]) || '').trim(),
    );
  } catch {
    facts.branchOnOrigin = null; // the probe could not answer — NOT "the branch is absent"
  }
  if (facts.branchOnOrigin === true) {
    // The SAME two git steps land-lib's branchAlreadyLanded runs (fetch, then
    // `merge-base --is-ancestor origin/<branch> origin/master`) — but kept TRI-STATE. That helper
    // catches every failure into `false`, which here would report a probe that could not answer as
    // the confident "this branch never merged" refusal, and made the unknown guard unreachable
    // (gpt-review r2). Exit 1 from merge-base IS the real "not an ancestor" answer; anything else
    // is unknown.
    try {
      _git(MAIN, ['fetch', 'origin', 'master', branch]);
      facts.branchTip = String(_git(MAIN, ['rev-parse', `origin/${branch}`]) || '').trim() || null;
      try {
        _git(MAIN, ['merge-base', '--is-ancestor', `origin/${branch}`, 'origin/master']);
        facts.branchMerged = true;
      } catch (e) {
        facts.branchMerged = e && e.status === 1 ? false : null;
      }
    } catch {
      facts.branchMerged = null; // could not even fetch the branch → unknown, never "not merged"
    }
  }
  try {
    _git(MAIN, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    facts.branchLocal = true;
  } catch (e) {
    facts.branchLocal = e && e.status === 1 ? false : null;
  }

  if (planId) {
    try {
      const listing = D.reconcileWorktreeBranches.listPlanPathsAtOriginMaster(MAIN, { _git });
      facts.planFolder =
        D.reconcileWorktreeBranches.buildPlanFolderIndex(listing).get(String(planId)) ?? null;
      // The folder index is keyed by ID alone, which a TRUNCATED or mistyped slug still hits —
      // and this seam would then release that other plan's claim. Recover the full path so the
      // planner can check the file is genuinely this slug's, and so the heartbeat read below has
      // something to read (gpt-review).
      const rel = String(listing || '')
        .split('\n')
        .map((l) => l.trim())
        .find(
          (p) =>
            p.startsWith(`docs/superpowers/plans/${facts.planFolder}/`) &&
            new RegExp(`(^|/)${planId}-(?![0-9])`).test(p),
        );
      if (rel) {
        facts.planBasename = rel.split('/').pop();
        const base = facts.planBasename.replace(/\.md$/i, '');
        facts.planBasenameMatchesSlug = base.toLowerCase() === String(slug).toLowerCase();
        try {
          facts.planHeartbeat =
            D.L.readHeartbeatDays(_git(MAIN, ['show', `origin/master:${rel}`])) != null;
        } catch {
          facts.planHeartbeat = false; // unreadable body → treat as an ordinary (archiving) plan
        }
      }
    } catch {
      facts.planFolder = null;
    }
    try {
      facts.claimOnOrigin = D.reconcileWorktreeBranches
        .listRemoteClaimIds(MAIN, { _git })
        .includes(String(planId));
    } catch {
      facts.claimOnOrigin = null; // unknown → attempt the (idempotent) release anyway
    }
  }

  let paths = null;
  try {
    ({ paths } = D.coordConfig.loadCoordConfig(MAIN));
  } catch {
    /* no coord config readable — board/queue stay unknown, i.e. "attempt the clear" */
  }
  if (paths) {
    try {
      const lines = D.boardLib
        .splitBoard(_git(MAIN, ['show', `origin/master:${paths.boardFile}`]))
        .body.split('\n');
      facts.boardRow = D.boardLib.findRowLineIndex(lines, slug) !== -1;
    } catch {
      facts.boardRow = null;
    }
    try {
      // parseQueue returns { entries, auditLines } — the ENTRIES carry the slugs. A doc the
      // accessor could not trust (its `fault`) is unknown, never "no entry".
      // FETCHING read (plan 3973 review, keys ec4cf1 / e35113): the close-out decides whether to
      // release a live queue slot, and the fetch above names only master, so a stale — or, in a
      // single-branch clone, absent — queue tracking ref would read as "not queued" and orphan
      // the slot. This is the teardown spine, not a hot path; one round trip is worth paying for,
      // and the accessor's tri-state keeps a proven-absent ref apart from an unreachable origin.
      const q = D.landingQueueRef.readQueueDoc(MAIN, { fetch: true, gitImpl: _git });
      if (q.fault) throw q.fault;
      // `fetched: false` is the SAME unknown as a fault here (plan 3973 review round 2, keys
      // 4464e3 / aa1749 / c200f9 / 094932): the accessor degrades a failed fetch to the CACHED
      // tracking ref with no fault, and a cache that predates this land's own enqueue answers
      // "no entry" — which would skip the dequeue and leave the live FIFO slot behind. The
      // close-out decides from a view it refreshed, or it decides nothing.
      if (!q.fetched) {
        throw new Error(
          `the landing-queue ref could not be refreshed from origin (source ${q.source}) — ` +
            `the cached doc may predate this slug's enqueue`,
        );
      }
      facts.queueEntry = D.landingQueueLib.parseQueue(q.doc).entries.some((e) => e.slug === slug);
    } catch {
      facts.queueEntry = null;
    }
  }

  try {
    const hit = D.worktreePorcelain
      .parseWorktreePorcelain(_git(MAIN, ['worktree', 'list', '--porcelain']))
      .find((e) => e.branch === branch);
    facts.worktreeDirPresent = Boolean(hit);
    if (hit) facts.worktreePath = hit.path;
  } catch {
    facts.worktreeDirPresent = null; // could not answer — NOT "there is no dir"
  }
  return facts;
}

// The minimal spine `state` the close-out path needs. wtPath is null BY CONSTRUCTION — this mode
// exists precisely because there is no worktree, and runCloseOutIsolated/closeOutSingle never
// read it (the close-out runs in the plan-971 `_finish-<slug>` ephemeral worktree cut from
// origin/master, and readCarryForwards reads MAIN's session file, not the plan worktree).
function finishCloseOutState(MAIN, facts) {
  const D = landDeps();
  return {
    slug: facts.slug,
    branch: facts.branch,
    main: MAIN,
    wtPath: null,
    landId: randomUUID(),
    worktreeLock: null,
    lane: null,
    landingClaimed: false,
    landingReleased: false,
    // Set from the observed residue below, so closeOut's own dequeueQueueIfHeld does the work.
    queued: false,
    dequeued: false,
    requeuedToTail: false,
    claimReleased: false,
    closedOut: false,
    // Recovered from origin when the branch is still there; null once it is gone (the archive
    // note only ever quotes it, so a null degrades the prose, never the bookkeeping).
    mergeSha: D.spine.recoverLandedMergeSha(MAIN, facts.branch),
    deployStatus: null,
    planArchived: null,
    heartbeatReparked: null,
    promoted: [],
    promotedToPending: [],
    promotedToOperator: [],
    newPlans: [],
    legacyReadyMints: [],
    carryForwardsSkipped: [],
    teardownErrors: [],
    killed: 0,
    memory: { moved: 0, dup: 0, diverged: 0 },
    toreDown: false,
    decision: null,
    wait: false,
    // Unattended by definition: a resume run has no agent to answer a carry-forward seam, so
    // ambiguous bullets become their own pending-approval stubs exactly as the drain's own
    // lands do, rather than halting a close-out that is already past the point of no return.
    carryforwardDefer: true,
    date: D.spawn.run('node', ['-e', 'process.stdout.write(new Date().toISOString().slice(0,10))']),
    host: D.spawn.run('hostname'),
    session: D.coordSessionId.coordinationSessionId() || '?',
    batch: null,
    landGateId: null,
    gatesProven: {},
    landGate: null,
  };
}

// Clear the local worktree registration + dir. A trimmed twin of teardown()'s step 3 — no
// process-kill and no memory-reclaim, because this mode runs from a checkout that never hosted
// the dead land's dev servers. Same escalation (remove --force → --force --force → rm -rf →
// prune), same never-throws contract.
function finishRemoveWorktreeDir(MAIN, wtPath, state) {
  const D = landDeps();
  return D.spine.tryStep(state, 'worktree-remove', () => {
    const soft = (cmd, args) => {
      try {
        D.spawn.run(cmd, args);
      } catch {
        /* best-effort; the existsSync gate below decides the real outcome */
      }
    };
    soft('git', ['-C', MAIN, 'worktree', 'remove', '--force', wtPath]);
    if (existsSync(wtPath))
      soft('git', ['-C', MAIN, 'worktree', 'remove', '--force', '--force', wtPath]);
    if (existsSync(wtPath)) {
      if (process.platform === 'win32') {
        const wtWin = wtPath.replace(/\//g, '\\');
        soft(D.spawn.pwshExe(), [
          '-NoProfile',
          '-Command',
          `Remove-Item -LiteralPath '\\\\?\\${wtWin}' -Recurse -Force -ErrorAction SilentlyContinue`,
        ]);
        if (existsSync(wtPath)) soft('cmd', ['/c', 'rmdir', '/s', '/q', wtWin]);
      } else {
        soft('rm', ['-rf', wtPath]);
      }
    }
    D.spawn.run('git', ['-C', MAIN, 'worktree', 'prune', '-v']);
    if (existsSync(wtPath)) throw new Error(`dir still present after forced removal: ${wtPath}`);
    return true;
  });
}

// The mode itself. Returns a process exit code; NEVER merges, never enqueues, never runs a gate.
export function runFinishCloseOut(MAIN, slug) {
  const D = landDeps();
  const facts = gatherCloseOutFacts(MAIN, slug);
  const plan = D.L.planFinishCloseOut(facts);
  if (!plan.proven) {
    process.stderr.write(`${D.L.formatFinishCloseOutReport(slug, plan)}\n`);
    return 2;
  }
  if (plan.alreadyClosed) {
    process.stdout.write(`${D.L.formatFinishCloseOutReport(slug, plan)}\n`);
    return 0;
  }

  const need = new Set(plan.residues);
  const state = finishCloseOutState(MAIN, facts);
  const outcomes = {};

  // One place that runs a residue clear: never throws (tryStep records into teardownErrors), and
  // returns the step's own outcome STRING so a step that deliberately SKIPS can say so instead of
  // being reported as a success.
  const clear = (label, fn) => {
    const r = D.spine.tryStep(state, label, fn);
    return r || `FAILED: ${(state.teardownErrors || []).slice(-1)[0] || 'unknown'}`;
  };

  // 1. Bookkeeping half — the plan file's archive move, its board row, INDEX, the session entry,
  //    promotions and carry-forwards. This is the spine's OWN close-out, unchanged and already
  //    idempotent across a partial prior run (plan 651), ending in verifyCloseOutOnOrigin — so a
  //    resumed close-out is verified against origin exactly as a live one is. `queued` is set
  //    from the observed residue so closeOut's own dequeueQueueIfHeld frees the FIFO slot in the
  //    same pass rather than needing a second, separately-failing call.
  if (need.has('archive')) {
    state.queued = need.has('queue');
    // gpt-review round 3 (finding aba3d8, CONFIRMED): --finish-close-out returns straight out of
    // main() (see the `if (a.finishCloseOut)` branch far below) and never reaches
    // phasePreflight() — so it never reached the plan-3815 disk-headroom prune wired there,
    // even though this IS the exact failure the plan exists to fix: runCloseOutIsolated's own
    // `git worktree add` for the `_finish-*` worktree, right below, is precisely what ENOSPCs
    // under disk pressure (the plan's own "What is wrong" section: every incident so far was
    // recovered by hand this same way — delete a `.next` directory, then re-invoke with
    // --finish-close-out). Prune here too, same `L.isCloudLand()` gate, PRUNE ONLY — no floor
    // refusal: this path is strictly post-merge (planFinishCloseOut only proves when the branch
    // already merged onto origin/master), so halting on a measured shortfall would strand an
    // already-merged land unfinished, the same reasoning round 2 applied to an alreadyLanded
    // retry. No `keep` either (finding 922202): state.wtPath is null by construction on this
    // path (finishCloseOutState's own comment), so pruneCloudDiskHeadroom reclaims every stray
    // build cache it finds under MAIN and its worktrees, including a merged worktree's own if it
    // still happens to be on disk. Wrapped so a prune throw can never be why close-out fails.
    if (D.L.isCloudLand()) {
      try {
        D.spine.pruneCloudDiskHeadroom(MAIN);
      } catch (err) {
        process.stderr.write(
          `done-worktree --finish-close-out: disk-headroom prune threw (${D.coordGit.errText(err)}) — ` +
            `continuing to close-out without it (plan 3815)\n`,
        );
      }
    }
    try {
      D.spine.runCloseOutIsolated(MAIN, state, D.spine.readCarryForwards(null, state));
      outcomes.archive =
        'archived + board row removed + INDEX/session updated (verified on origin)';
      if (need.has('queue')) outcomes.queue = state.dequeued ? 'dequeued' : 'no slot held';
    } catch (e) {
      // A close-out that cannot be VERIFIED on origin must not be followed by a teardown: the
      // branch is the adopter's only durable pointer at the work, so it stays until the
      // bookkeeping provably landed.
      outcomes.archive = `FAILED: ${e.message || e}`;
      process.stderr.write(`${D.L.formatFinishCloseOutReport(slug, plan, outcomes)}\n`);
      return 1;
    }
  } else if (need.has('queue')) {
    // Archive already done by the dead run — only the FIFO slot is left. A direct, idempotent
    // dequeue (exit 0 on a no-op) is cheaper and safer than re-entering the whole close-out.
    outcomes.queue = clear('queue-dequeue', () => {
      D.spawn.node('landing-queue.mjs', 'dequeue', slug);
      return 'dequeued';
    });
  }

  // 2. Claim ref. Idempotent + owner-checked + exit-0 on every path; --force because the holder
  //    is a session that is DEAD by construction (its land already merged), which reads as
  //    foreign to this one.
  if (need.has('claim')) {
    outcomes.claim = clear('claim-release', () => {
      D.spawn.node('release-claim.mjs', 'release', facts.planId, '--force');
      return 'released';
    });
  }

  // 3. Teardown residues. Each is detected and cleared INDEPENDENTLY of the others — teardown()
  //    removes the worktree dir (step 3) BEFORE deleting the branch (step 4), so a resume that
  //    replayed a fixed sequence would mis-handle a kill between two steps it thought adjacent.
  if (need.has('worktree-dir')) {
    outcomes['worktree-dir'] = facts.worktreePath
      ? clear(
          'worktree-remove',
          () => finishRemoveWorktreeDir(MAIN, facts.worktreePath, state) && 'removed',
        )
      : // The listing could not be read, so we know a dir MAY survive but not where. Say so and
        // let the post-pass report non-convergence — an honest "unknown" beats a false all-clear
        // (gpt-review). A genuinely orphaned dir is reconcile-worktree-branches' husk sweep.
        'UNKNOWN: could not read `git worktree list` — a worktree dir may survive; re-invoke, or ' +
        'run `node scripts/coord/reconcile-worktree-branches.mjs` to locate a husk dir';
  }
  if (need.has('branch-local')) {
    outcomes['branch-local'] = clear('branch-delete-local', () => {
      // The REMOTE proof says nothing about the LOCAL ref: it can carry commits that were never
      // pushed. And `git branch -d` is not that proof either — it checks "merged into its upstream
      // (or HEAD)", which can pass for a branch whose commits are not on origin/master, so a
      // successful `-d` was a way AROUND the ancestry requirement rather than a cheap version of
      // it (gpt-review r3). So: prove ancestry against origin/master, always, then delete.
      let tip;
      try {
        tip = String(D.spawn.gitMain(MAIN, ['rev-parse', facts.branch]) || '').trim();
        D.spawn.gitMain(MAIN, ['merge-base', '--is-ancestor', tip, 'origin/master']);
      } catch {
        return (
          `SKIPPED: local ${facts.branch} is not provably an ancestor of origin/master — it may ` +
          `carry commits that were never pushed. Left in place; inspect it before deleting.`
        );
      }
      // `update-ref -d <ref> <old-value>` is a compare-and-delete: git refuses if the ref moved
      // since we proved it, so this is not check-then-delete either (gpt-review r3).
      D.spawn.run('git', ['-C', MAIN, 'update-ref', '-d', `refs/heads/${facts.branch}`, tip]);
      return 'deleted';
    });
  }
  if (need.has('branch-remote')) {
    // Re-prove the merge IMMEDIATELY before the delete, not just at gather time. The clears above
    // can take a while (the bookkeeping close-out especially), and this is the one irreversible
    // step: a branch that gained a commit in that window is no longer the thing we proved landed,
    // and deleting it would destroy work (gpt-review).
    outcomes['branch-remote'] = clear('branch-delete-remote', () => {
      D.spawn.gitMain(MAIN, ['fetch', 'origin', 'master', facts.branch]);
      const tip = String(
        D.spawn.gitMain(MAIN, ['rev-parse', `origin/${facts.branch}`]) || '',
      ).trim();
      try {
        D.spawn.gitMain(MAIN, ['merge-base', '--is-ancestor', tip, 'origin/master']);
      } catch {
        return (
          `SKIPPED: origin/${facts.branch} is no longer an ancestor of origin/master (tip ` +
          `${tip.slice(0, 12)}) — it moved since this pass began. Left on origin; investigate ` +
          `before deleting it.`
        );
      }
      // A recheck alone is check-then-delete: the branch can still move in the window before the
      // push. `--force-with-lease` on the delete refspec makes the SERVER refuse unless the ref is
      // still at the tip we just proved, which closes the race rather than narrowing it.
      D.spawn.run('git', [
        '-C',
        MAIN,
        'push',
        `--force-with-lease=refs/heads/${facts.branch}:${tip}`,
        'origin',
        `:refs/heads/${facts.branch}`,
      ]);
      return 'deleted';
    });
  }

  process.stdout.write(`${D.L.formatFinishCloseOutReport(slug, plan, outcomes)}\n`);
  // The deferred-worktree idle sweep still runs for this mode — just AFTER the clears rather than
  // before them, so it can never mutate the local state gatherCloseOutFacts reasoned about
  // (gpt-review r1 asked for the move, r2 for it not to be lost). Best-effort; never throws.
  D.sweepDeferredWorktrees.runSweepAndReport(MAIN, 'done-worktree --finish-close-out');
  // Re-derive from origin rather than trusting this run's own outcomes: the point of the mode is
  // that origin, not local state, is the authority on whether a land is closed out.
  const after = D.L.planFinishCloseOut(gatherCloseOutFacts(MAIN, slug));
  if (after.proven && after.alreadyClosed) {
    process.stdout.write(`done-worktree: --finish-close-out "${slug}" — fully closed out.\n`);
    return 0;
  }
  process.stderr.write(
    `done-worktree: --finish-close-out "${slug}" — residue REMAINS after this pass: ` +
      `[${(after.residues || []).join(', ') || after.refusal}]. Re-invoking is safe and ` +
      `idempotent; if it keeps failing, finish by the checklist in ` +
      `docs/runbooks/plans-workflow.md § Landing recovery under contention.\n`,
  );
  return 1;
}
