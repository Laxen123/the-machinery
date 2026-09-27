// scripts/coord/land/queue-probe.mjs — plan 3961 T3.4b: the queue-waiter pre-convergence probe
// and the plan-2463 speculative-stacking no-laundering guards, moved out of
// scripts/done-worktree.mjs behaviour-identical (parity proven by this migration's parity-test
// suite against committed goldens, plus the full legacy test suite, both unchanged by this move).
//
// WHAT THIS MODULE OWNS. Two related but independent concerns that both live on the `--wait`
// queue-residency path:
//   * plan 1805's queue-waiter pre-convergence: a non-mutating conflict probe of the worktree
//     branch vs FRESH origin/master (preconvergeProbe, cached by the (master tip, branch tip)
//     pair in the private module-level `_preconvergeCache`), and the attended real-rebase attempt
//     it arms (attemptPreconverge, bounded to L.PRECONVERGE_MAX_ROUNDS per queue residency).
//   * plan 2463's speculative-stacking no-laundering invariant: the own-position/head-slug read
//     (speculationQueueView), the land-time un-stack that reverts a branch whose speculative base
//     never landed (unstackSpeculativeBase), and the state-free backstop that catches a stack a
//     lost/cleared marker would miss (foreignStackedBranch).
// It is generic — no project-specific vocabulary anywhere in this file.
//
// HOW THIS MODULE REACHES THE REST OF THE WORLD. A non-test module under scripts/coord/ may
// import only scripts/coord/** and node: builtins (Rule 3, docs/coord/scripts-layout.md)
// — so every one of the plain scripts/*.mjs modules this code used to reach directly is instead
// read off the bound dependency container, `landDeps()` (scripts/coord/land/deps.mjs), AT CALL
// TIME, inside each function — never at module top level. `D` (this module's convention:
// `const D = landDeps();` as the first line of every function that needs it) is the same
// one-letter binding every other scripts/coord/land/*.mjs core module uses for the same reason.
// `head-lock.mjs` and `queue.mjs` are SIBLING core modules under scripts/coord/land/ (moved at
// T3.4 and T3.3 respectively), so `takeWorktreeLock`/`dropWorktreeLock` (head-lock.mjs) and
// `readLandAttempt`/`writeLandAttempt`/`queueStatusView`/`queueHeartbeat` (queue.mjs) are imported
// from them directly, no container needed.
//
// THE `spine` GROUP. `restoreOffSpeculativeBase` (the reset-vs-rebase primitive
// `unstackSpeculativeBase` calls, shared with `clearSpeculativeStackForPrep`'s prep-side undo),
// `worktreeMutationInProgress` and `attachmentRefusal` (both called here by `attemptPreconverge`,
// but each has its own OTHER call site in the at-head/prep-gates flow too), and `stepLog` /
// `repinAndReprove` (already `spine` members, added ahead of the T3.3 queue.mjs carve) are reached
// via the container — none of these move to a core module, so they stay reachable at call time
// without importing done-worktree.mjs. `landSpecMarker`, `isAncestor`, `originMasterTip`,
// `worktreeHeadSha`, and `tryRebase` LEFT the `spine` group at plan 3961 T3.6: all five moved to
// scripts/coord/land/rebase-sync.mjs (the same worktree-HEAD-reading cluster), so this module now
// imports them from there directly instead (a sibling-core-module reach, no container needed —
// see the import lines above).
//
// `attemptSpeculativeStack` — D9's own row for this move — does NOT move here. It reads the
// spine-private module-level `let lastHeadRefError` (reassigned by `worktreeHeadRef` and its
// attachment-recovery siblings elsewhere in the file), which an ES module's private binding
// cannot expose to another module — the same class of blocker as `_retainedEntryHeartbeatDisarm`
// at T3.4. It stays in done-worktree.mjs, in the prep-gates zone, for a later step.
//
// `_preconvergeCache` is the one piece of module-level state that DOES move: it is a private `let`,
// but `preconvergeProbe` is its ONLY reader and writer anywhere in the spine (confirmed by a full
// grep before this move), so the binding and its sole accessor move together as a self-contained
// unit — nothing outside this module ever needs to see it move.
//
// EXPORTS. `preconvergeProbe` and `attemptPreconverge` are called only by `queue.mjs`'s
// `queueEnqueueAndGate` (a sibling-to-sibling import there, no container needed — see queue.mjs's
// own import lines). `speculationQueueView`, `unstackSpeculativeBase`, and `foreignStackedBranch`
// are called by done-worktree.mjs itself (imported back below). None of the five has a
// done-worktree.test.mjs direct-import case (checked against its full import block), so this move
// needs no re-export bridge.

import { landDeps } from './deps.mjs';
import { takeWorktreeLock, dropWorktreeLock } from './head-lock.mjs';
import { readLandAttempt, writeLandAttempt, queueStatusView, queueHeartbeat } from './queue.mjs';
// plan 3961 T3.6: originMasterTip/worktreeHeadSha/tryRebase/landSpecMarker/isAncestor moved to
// rebase-sync.mjs — a sibling-core-module reach, no container needed (they LEFT the `spine`
// deps-container group with that same move; see deps.mjs's own comment).
import {
  originMasterTip,
  worktreeHeadSha,
  tryRebase,
  landSpecMarker,
  isAncestor,
} from './rebase-sync.mjs';

// plan 4066 task 0: the member-level container-read manifest for this module — see
// preflight.mjs's own CONTAINER_READS comment for what asserts it and when, and
// container-manifest.mjs's header for the aggregator itself. Generated, not hand-typed;
// regenerate with the same scanner on a real change to this file's container reads.
export const CONTAINER_READS = Object.freeze({
  L: Object.freeze([
    'PRECONVERGE_MAX_ROUNDS',
    'mergeTreeConflictProbe',
    'rebaseSeam',
    'specUnstackNeeded',
  ]),
  env: Object.freeze(['DRY']),
  spawn: Object.freeze(['node', 'run']),
  spine: Object.freeze([
    'attachmentRefusal',
    'repinAndReprove',
    'restoreOffSpeculativeBase',
    'stepLog',
    'worktreeMutationInProgress',
  ]),
});

// ── plan 1805: queue-waiter pre-convergence (position ≤ L.PRECONVERGE_POS) ──────
// Non-mutating conflict probe of the worktree branch vs FRESH origin/master:
// `git merge-tree --write-tree` three-way dry-run (git ≥2.38; exit 1 = conflicts).
// Advisory TRIGGER only — its conflict report can differ from a real rebase on
// renames / per-commit replay, so a conflicted probe never blocks anything by
// itself; it either arms the attended rebase attempt (attemptPreconverge) or rides
// the QUEUE_WAIT seam reason as a note. Fail-open BY DESIGN: any probe error →
// null → today's behavior (the head slot still handles everything, as before).
// Cached by the (origin/master tip, branch tip) pair — a poll tick where neither
// moved reuses the last verdict instead of re-running merge-tree.
let _preconvergeCache = null;
export function preconvergeProbe(state) {
  const D = landDeps();
  if (D.env.DRY) {
    // one-shot test hook (mirrors DW_FAKE_DIFF): 'clean' → no conflicts; a CSV →
    // those files conflict. Consumed on first read so a --wait converge test can't
    // loop forever on a fake queue position that never advances.
    const fake = process.env.DW_FAKE_PRECONVERGE;
    if (fake === undefined) return null;
    delete process.env.DW_FAKE_PRECONVERGE;
    return fake === 'clean'
      ? { conflicted: false, files: [] }
      : { conflicted: true, files: fake.split(',') };
  }
  if (!state || !state.wtPath || !state.branch) return null;
  try {
    D.spawn.run('git', ['-C', state.wtPath, 'fetch', 'origin', 'master']);
    const masterTip = originMasterTip(state.wtPath);
    const branchTip = worktreeHeadSha(state.wtPath);
    if (
      _preconvergeCache &&
      _preconvergeCache.masterTip === masterTip &&
      _preconvergeCache.branchTip === branchTip
    ) {
      return _preconvergeCache.result;
    }
    // plan 2274 review fix: shared with landing-queue-watch.mjs's staleWhileQueuedProbe via
    // L.mergeTreeConflictProbe — see its header comment for why the two must not independently
    // reimplement this classification.
    const result = D.L.mergeTreeConflictProbe(
      (args) => D.spawn.run('git', ['-C', state.wtPath, ...args]),
      'origin/master',
      branchTip,
    );
    if (result === null) return null; // not a conflict verdict — probe unavailable this tick
    _preconvergeCache = { masterTip, branchTip, result };
    return result;
  } catch {
    return null;
  }
}

// The ATTENDED (--wait, TTY-gated by plan 665 G4.3) arm: attempt the REAL rebase now,
// bounded to L.PRECONVERGE_MAX_ROUNDS per queue residency (master can keep advancing —
// the bound stops endless churn; a late conflict still gets today's at-head path).
// Returns:
//   'converged' — the branch now replays clean onto origin/master (rerere / clean replay
//                 completed it; tryRebase force-with-lease-pushed; markers re-pinned) —
//                 the caller re-polls immediately.
//   'conflict'  — a genuine judgment conflict: LEFT IN PROGRESS in the worktree (mirrors
//                 the at-head LAND_BLOCKED_HOLDING contract — the session concludes it;
//                 the detached --prep aborts instead because no session is present there).
//   'skip'      — rounds exhausted / worktree busy / publish-only failure / any error —
//                 plain wait; the head path covers everything skipped here.
// An UNATTENDED waiter never reaches this function (plan 1805 pin: probe-only).
// FAIL-OPEN like the probe (review 1805 [1]): the whole body is guarded — a thrown git
// error (transient fetch failure, stale index.lock) must degrade to 'skip', NEVER
// propagate: main()'s finally would dequeue the slot and report a CRASH, losing the FIFO
// position over a purely advisory optimization.
export function attemptPreconverge(state) {
  const D = landDeps();
  // plan 2473: the attended pre-convergence rebase is the THIRD writer into this worktree
  // (prep child, head-time land, this) — it takes the same lock, non-blocking. A refusal means a
  // prep child owns the tree right now, and a prep does a strict SUPERSET of this rebase (it also
  // re-validates the gate battery and stamps the fast-path marker), so yielding to it costs the
  // waiter nothing: 'skip' is a plain wait, and the head path covers everything skipped here.
  let lock = { path: null, token: null };
  try {
    const MAIN = state.main;
    lock = takeWorktreeLock(state.wtPath, state.slug, 'preconverge'); // no-op under --dry-run
    if (lock.path && !lock.token) {
      console.error(
        `done-worktree ${state.slug}: pre-convergence — ${D.worktreeLock.describeWorktreeLockHolder(lock.holder)} ` +
          `holds this worktree; skipping this round.`,
      );
      return 'skip';
    }
    if (D.spine.worktreeMutationInProgress(state.wtPath)) {
      console.error(
        `done-worktree ${state.slug}: pre-convergence — a rebase/merge is already in progress ` +
          `in the worktree (a live --keep-hot --prep watcher, or leftover state needing ` +
          `\`git rebase --abort\`); skipping this round.`,
      );
      return 'skip';
    }
    let prior = {};
    let enqIso = null;
    try {
      prior = readLandAttempt(MAIN, state.slug) || {};
      enqIso = queueStatusView(state)?.mine?.enqueuedIso || null;
    } catch {
      prior = {};
    }
    // Residency identity mirrors markHeadAcquired: a differing enqueuedIso is a NEW
    // residency (counter resets); an unknown one is conservatively the SAME residency
    // (never grant free extra rounds on a transient status failure).
    const sameResidency =
      !enqIso || !prior.preconvergeEnqueuedIso || prior.preconvergeEnqueuedIso === enqIso;
    const rounds = sameResidency ? prior.preconvergeRounds || 0 : 0;
    if (rounds >= D.L.PRECONVERGE_MAX_ROUNDS) {
      console.error(
        `done-worktree ${state.slug}: pre-convergence — ${rounds} round(s) already spent this ` +
          `queue residency (cap ${D.L.PRECONVERGE_MAX_ROUNDS}); leaving the rest to the head slot.`,
      );
      return 'skip';
    }
    queueHeartbeat(state); // liveness BEFORE a potentially multi-minute rebase (plan 1805 pin)
    // plan 2085 review r2 [0]: the caller's self-arm dedupe keys on an ACTUAL write —
    // the early 'skip' returns above never reach this line and must not suppress it.
    state.preconvergeHeartbeated = true;
    // Count the round BEFORE attempting — a crash mid-rebase must not grant free retries.
    writeLandAttempt(MAIN, state.slug, {
      slug: state.slug,
      ...prior,
      preconvergeEnqueuedIso: enqIso || prior.preconvergeEnqueuedIso || null,
      preconvergeRounds: rounds + 1,
    });
    D.spine.stepLog(
      state,
      `pre-convergence: probe found conflicts vs origin/master — attempting the real rebase ` +
        `(round ${rounds + 1}/${D.L.PRECONVERGE_MAX_ROUNDS})`,
    );
    // plan 2654 review [1]: this rebase runs inside the long-lived `--wait` loop, long after the
    // single startup resolveWorktree, and after prep children that can leave the tree detached.
    // Pre-convergence is a pure optimization, so a refusal just skips this round — the head-time
    // gate below is the one that must not be bypassed.
    const preconvergeAttach = D.spine.attachmentRefusal(
      state.wtPath,
      state.branch,
      state.slug,
      'prep',
    );
    if (preconvergeAttach) {
      console.error(preconvergeAttach);
      return 'skip';
    }
    const reb = tryRebase(state.wtPath, state.branch);
    const preconvSeam = D.L.rebaseSeam(reb);
    if (preconvSeam) {
      // plan 3080: a graft refusal is neither a conflict nor a failed publish — nothing was
      // pushed and nothing needs resolving, but the branch is un-landable until the foreign
      // commits come off. The generic arm below would print "branch publish failed (push
      // rejected)" and drop the recovery recipe entirely (gpt-review 18e03b/8f2fa3), sending the
      // session to re-push a branch that must not be published at all. Surface the seam's own
      // reason instead; it re-surfaces at head with the same classification.
      if (reb.graftBlocked) {
        console.error(
          `done-worktree ${state.slug}: pre-convergence — ${preconvSeam.code}: ` +
            `${preconvSeam.reason}`,
        );
        return 'skip';
      }
      // Only a GENUINE conflict earns the resolve-now seam. A pushBlocked result means the
      // rebase concluded CLEAN locally and only the force-with-lease publish was rejected
      // (sibling board/INDEX drift on master, hook failure) — there is nothing "IN
      // PROGRESS" to resolve, so telling the session to `git rebase --continue` would be a
      // lie (review 1805 [2]). Skip: the next probe sees the rebased tip as clean, and the
      // at-head sync re-attempts the push with its own proper LAND_BLOCKED classification.
      if (!reb.conflicted) {
        console.error(
          `done-worktree ${state.slug}: pre-convergence — rebase completed clean but the ` +
            `branch publish failed (${reb.pushDetail || 'push rejected'}); leaving the ` +
            `re-push to the head slot's own sync.`,
        );
        return 'skip';
      }
      return 'conflict';
    }
    // Rebase completed + force-with-lease pushed (tryRebase). Re-pin the sha-pinned
    // markers now so the head slot sees a pure re-sha and its auto-heal clears the gates —
    // and re-prove the preflight tip on that repin (gpt-review 3972 r4 finding 8f8d75: this is
    // a spine-owned re-sha like the others; without the reproof a later sync-skip at the head
    // carried the stale tip into the merge-site drift check).
    D.spine.repinAndReprove(state, state.wtPath);
    queueHeartbeat(state);
    D.spine.stepLog(
      state,
      'pre-convergence: branch rebased onto origin/master during the wait — the head rebase will replay clean',
    );
    return 'converged';
  } catch (e) {
    console.error(
      `done-worktree ${state.slug}: pre-convergence attempt failed (${e?.message || e}) — ` +
        `fail-open, waiting as before (the head slot still handles everything).`,
    );
    return 'skip';
  } finally {
    // plan 2473: always released, INCLUDING on the 'conflict' return that deliberately leaves a
    // rebase in progress. A lock cannot outlive its process anyway (this one is about to seam out
    // and the exit hook would drop it), so leftover rebase state is guarded by
    // `worktreeMutationInProgress` — which is exactly why runLandPrep checks it too.
    dropWorktreeLock(lock.path, lock.token);
  }
}

// Our own queue position + the head slot's slug, in one read. Deliberately separate from
// `queueStatusView`, which projects only our OWN entry — speculation needs to know who is ahead.
// DRY: DW_FAKE_SPEC_QUEUE injects {"position":2,"head":"<slug>"}.
export function speculationQueueView(slug) {
  const D = landDeps();
  if (D.env.DRY) {
    try {
      return process.env.DW_FAKE_SPEC_QUEUE ? JSON.parse(process.env.DW_FAKE_SPEC_QUEUE) : null;
    } catch {
      return null;
    }
  }
  try {
    const st = JSON.parse(D.spawn.node('landing-queue.mjs', 'status', '--json'));
    const entries = st.entries || [];
    const mine = entries.find((e) => e.slug === slug);
    const head = entries.find((e) => e.position === 1);
    return { position: mine ? mine.position : 0, head: head ? head.slug : null };
  } catch {
    return null; // unreadable queue → no speculation this pass (opportunistic by design)
  }
}

export function unstackSpeculativeBase(MAIN, wtPath, branch, slug) {
  const D = landDeps();
  const spec = landSpecMarker.read(MAIN, slug);
  if (!spec) return false;
  // Judge "did the head land?" against a FRESH origin/master. On a stale remote-tracking ref a
  // head that HAS landed reads as un-landed, which is safe but throws the speculation away for
  // nothing — the exact outcome this plan exists to stop. A failed fetch keeps the stale ref and
  // therefore errs toward un-stacking, which is the correct direction to be wrong in.
  if (!D.env.DRY) {
    try {
      D.spawn.run('git', ['-C', wtPath, 'fetch', 'origin', 'master']);
    } catch {
      /* keep the local ref — erring toward the un-stack is the safe arm */
    }
  }
  const branchTip = worktreeHeadSha(wtPath);
  const facts = {
    branchDescendsFromSpecBase: isAncestor(wtPath, spec.specBase, branchTip),
    masterContainsSpecBase: isAncestor(wtPath, spec.specBase, 'origin/master'),
  };
  if (!D.L.specUnstackNeeded(spec, facts)) {
    // Either the head landed (the stack is legitimately on master now) or the branch has moved off
    // the speculative base entirely. Only the second case retires the marker: a landed specBase is
    // exactly what `landSpecPrepValid` is about to be asked to prove.
    if (!facts.branchDescendsFromSpecBase) landSpecMarker.clear(MAIN, slug);
    return false;
  }
  console.log(
    `done-worktree: plan-2463 UN-STACKING ${slug} — it was speculatively stacked on ` +
      `${spec.specBase.slice(0, 9)} (the head slot's branch) and origin/master does NOT contain ` +
      `that base, so the head did not land. Restoring the plain-prepped tip ` +
      `${spec.preSpecBranchSha.slice(0, 9)}; the full gate battery runs from here.`,
  );
  try {
    D.spine.restoreOffSpeculativeBase(wtPath, branch, spec, branchTip);
    D.spawn.run('git', ['-C', wtPath, 'push', '--force-with-lease', 'origin', branch]);
  } catch (e) {
    // Leaving a stacked branch in place is the ONE outcome this function exists to prevent, so a
    // failed un-stack must not degrade into "carry on and merge it".
    throw new Error(
      `done-worktree: plan-2463 could not un-stack ${slug} from the un-landed speculative base ` +
        `${spec.specBase.slice(0, 9)} (${e.message || e}). Landing now would merge another plan's ` +
        `unlanded commits onto master. Resolve in the worktree ` +
        `(\`git reset --hard ${spec.preSpecBranchSha}\` + force-push) and re-invoke.`,
    );
  }
  landSpecMarker.clear(MAIN, slug);
  return true;
}

// State-free backstop for the same invariant. `unstackSpeculativeBase` is marker-driven, so it is
// blind to a stack whose marker was cleared, lost with MAIN/.scratch, or written by a re-cut
// worktree. This asks the question directly of git: is any OTHER live `origin/worktree-*` tip an
// ancestor of our branch while NOT being an ancestor of origin/master? A sibling that LANDED has
// its commits on master (so it never matches) and its branch deleted at teardown; a sibling that
// failed out still has a live branch — exactly the case that must never merge. Returns the
// offending ref name, or null.
export function foreignStackedBranch(wtPath, branch, { speculated = false, refresh = false } = {}) {
  const D = landDeps();
  if (D.env.DRY) return process.env.DW_FAKE_FOREIGN_STACK || null;
  // review [0]: the local `refs/remotes/origin/worktree-*` namespace can be stale or missing a
  // sibling entirely, and this is the LAST guard before the merge. Refresh it — but only when this
  // land actually speculated, because review [4] is right that an unconditional network round-trip
  // on the hot pre-merge path taxes every land for a hazard only a speculating one can create. A
  // land that never stacked still gets the (free, local) scan below.
  //
  // gpt-review 3394 (findings 4/7/8, CONFIRMED): `refresh` is the second door, for a caller that
  // is NOT on that hot path. The prep-time caller is the motivating one — a keep-hot loop can sit
  // for an hour between fetches, so its `refs/remotes/origin/worktree-*` view is the STALEST in
  // the spine, and a sibling branch it has never seen scans as absent (a false negative, i.e. the
  // graft sails through). review [4]'s cost argument does not reach it: the prep is about to spend
  // 15-27 minutes on a full gate battery, against which one fetch is free, and it holds no FIFO
  // head while doing it.
  if (speculated || refresh) {
    try {
      D.spawn.run('git', [
        '-C',
        wtPath,
        'fetch',
        '--prune',
        'origin',
        '+refs/heads/worktree-*:refs/remotes/origin/worktree-*',
      ]);
    } catch (e) {
      // keep whatever refs we have — a degraded scan still beats no scan. But SAY SO (gpt-review
      // 3394 round 2, findings 9/14/16): fail-open is the right posture (refusing a land or a prep
      // because a fetch blipped would be worse than a scan that might miss a sibling), yet a
      // silent fail-open makes a false negative indistinguishable from a clean result. The one
      // thing this guard must never do is look like it proved something it did not.
      console.error(
        `done-worktree: could not refresh sibling worktree refs (${e.message || e}) — the ` +
          `foreign-stack scan below runs on the LOCAL refs/remotes/origin/worktree-* view, which ` +
          `may be stale or missing a sibling entirely. A graft onto a branch this checkout has ` +
          `never fetched would not be detected.`,
      );
    }
  }
  // review [4]: ONE `rev-list` instead of up to 2N `merge-base --is-ancestor` subprocesses. The
  // question "is ref R an ancestor of HEAD but not of origin/master" is exactly "is R's sha one of
  // the commits in `origin/master..HEAD`", so the whole scan is a set-membership test over a single
  // command's output — cost independent of how many worktree branches are live (measured ~40 on
  // this repo), which matters because this runs while HOLDING the FIFO head.
  let ours;
  try {
    ours = new Set(
      D.spawn
        .run('git', ['-C', wtPath, 'rev-list', 'origin/master..HEAD'])
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
  } catch (e) {
    // cannot enumerate our own commits → the marker-driven check is the only guard. Fail-open is
    // pre-existing and deliberate (this runs at the FIFO head; refusing every land on a git hiccup
    // would be worse), but SAY SO — gpt-review 3394 round 3, findings 11/16: a silent null here is
    // indistinguishable from a clean scan, so an unprovable result looked like a proof.
    console.error(
      `done-worktree: foreign-stack scan could not enumerate origin/master..HEAD ` +
        `(${e.message || e}) — the no-laundering backstop did NOT run this time.`,
    );
    return null;
  }
  if (ours.size === 0) return null;
  let refs;
  try {
    refs = D.spawn
      .run('git', [
        '-C',
        wtPath,
        'for-each-ref',
        '--format=%(refname:short) %(objectname)',
        'refs/remotes/origin/worktree-*',
      ])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    // Same fail-open, same duty to say so (findings 12/16).
    console.error(
      `done-worktree: foreign-stack scan could not enumerate sibling worktree refs ` +
        `(${e.message || e}) — the no-laundering backstop did NOT run this time.`,
    );
    return null;
  }
  for (const line of refs) {
    const [ref, sha] = line.split(/\s+/);
    if (!ref || !sha) continue;
    if (ref === `origin/${branch}`) continue;
    if (ours.has(sha)) return ref; // a live sibling tip sitting in our unlanded history
  }
  return null;
}
