#!/usr/bin/env node
// scripts/claim-plan.mjs — atomic ref-CAS plan-claim lock (plan 368).
//
// A claim is a git ref (`refs/heads/coord/claims/<plan-id>` since plan 3756 — branch-shaped,
// because a cloud sandbox's mandatory proxy 403s the old `refs/claims/*`; `coord-refs.mjs` owns
// every coordination refname). It is created by pushing a UNIQUE commit object (`git commit-tree`
// against the empty tree — no index, no HEAD, no working tree touched) to origin with a NON-FORCE
// push, which is create-or-fast-forward only: a second claimant's push to an already-held ref is
// rejected non-fast-forward. THAT rejection is the mutex — atomic, server-side, cross-PC, and
// touching nothing in any working tree. The loser reads the holder and exits clean; it never
// collides with the winner.
//
// Since plan 3756 the ref is an append-only CHAIN rather than a create-once object, because
// RELEASE stopped being a delete (the proxy refuses deletes by verb) and is now a
// `claim RELEASED plan=<id>` tombstone appended to the same ref. So a released ref still exists,
// the first push at it is rejected non-ff, and the acquire fast-forwards over the tombstone
// instead — see `acquireRef` for why that keeps exactly one winner.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  git,
  gitWithLockRetry,
  boundedGitWithLockRetry,
  boundedGit,
  COORD_CHECKOUT_TIMEOUT,
  resolveMain,
  parseFlags,
  isNonFastForward,
  withCoordCheckout,
  masterPushSpec,
  sleepSync,
  backoffMs,
  errText,
  isMvBadSource,
  isNothingToCommit,
  isPathspecNoMatch,
  isTransientIndexWrite,
  isRefLockRace,
  readRemoteRefCommit,
  lsRemoteTimed,
  derivedReadTimeoutMs,
  LOCK_RX,
} from './coord-git.mjs';
import { loadCoordConfig, loadCoordConfigAtOrigin, configDirCandidates } from './coord-config.mjs';
import {
  STATUS_ORDER,
  IN_PROGRESS_FOLDER,
  ARCHIVE_FOLDER,
  readSeedMarker,
  readFrontmatterScalar,
  isHighPriorityTier,
  idClaimPattern,
} from './build-index-lib.mjs';
import {
  upsertRow,
  upsertRowLines,
  updateRowsLines,
  removeRows,
  rowKeysForPlan,
  rowsForPlanIdLines,
  isBatchMemberCell,
  splitBoard,
  withBody,
  LANDING_STATE,
  PAUSED_STATE,
} from './board-lib.mjs';
// The in-process INDEX helpers were promoted to the shared build-index module (plan 926)
// so move-plan can reuse them at the source; claim-plan re-exports the legacy names below
// (regenIndexContent/indexIsCurrent) for its callers + tests, and wraps healIndexDrift.
import { healIndexDrift, regenerateIndex } from './build-index.mjs';
export { regenerateIndex as regenIndexContent, indexIsCurrent } from './build-index.mjs';
import { extractPlanRefs } from './lint-board.mjs';
import {
  refForPlan,
  planIdOf,
  classifyPushResult,
  nextSessionNumber,
  buildClaimMessage,
  parseClaimMessage,
  flipStatusToInProgress,
  sessionEntryCandidates,
  boardPlanClaimCell,
  assertBatchSlug,
  assertSlugCharset,
  checkBatchEligibility,
  boardBatchPlanClaimCell,
  checkStubClaimGate,
  checkBatchSoloClaimGate,
  normalizeExecutorProvenance,
  DISPATCH_MODES,
  assertSessionEntryDate,
  resolveExecLane,
  EXEC_LANE_TABLE,
} from './claim-plan-lib.mjs';
// plan 2426: the write-time board gate, wired into the TWO claim paths plan 2378's own
// review fan-out found unwired. Both project a folder-crossing `git mv` into `in-progress/`
// under the same HUSKY=0 coord-checkout push that runs no git hooks, so without this they
// were the highest-traffic un-gated plan writes in the repo. `ForPending` (not the on-disk
// `assertBoardInvariants`) because a refusal here must leave the tree untouched — see that
// function's header.
import {
  assertBoardInvariantsForPending,
  blockedViewFor,
  loadCorpusView,
  BoardInvariantError,
} from './board-write-gate.mjs';
import { worktreePathFor } from './cut-worktree.mjs';
// plan 3959 T2: imported directly from scripts/coord/plan-id-index.mjs (moved there from
// done-worktree-lib.mjs) rather than through that file's heavy import graph, which this module
// deliberately avoids pulling in.
import { buildPlanIdIndex, rowSlugFromIndex } from './plan-id-index.mjs';
import {
  newManifestRel,
  batchMdRel,
  stampBatchStatus,
  renderBatchMd,
  resolveManifestRel,
  BATCHES_DIR_REL,
  LEGACY_BATCH_MANIFEST_DIR_REL,
  RESERVED_BATCH_DIRS,
  findRunnableBatchForPlan,
  readArchivedPlanIds,
} from './batch-paths.mjs';
// plan 1478: derail releases the member's claim ref through the SAME hardened, F-014-CAS,
// owner-checked release the batch-train + done-worktree already use — not a re-rolled bare
// `push :ref`. release-claim.mjs imports readHolder FROM this module, so this is a module
// cycle; it is safe because neither side CALLS the other at load time (releaseClaim +
// readHolder are only invoked inside functions, by which point both modules have finished
// evaluating — ESM live bindings, no top-level use).
import { releaseClaim } from './release-claim.mjs';
// coord-refs.mjs imports nothing, so importing it here adds no new cross-tree edge.
import {
  claimIsHeld,
  claimRefCandidates,
  legacyClaimRef,
  legacyCoordRef,
  coordRef,
  buildTombstoneMessage,
  releaseStrategyFor,
  planIdFromClaimRef,
  parseClaimLsRemote,
  CLAIM_PREFIX,
  CLAIM_GLOB,
  LEGACY_CLAIM_GLOB,
  PROBE_GLOB,
  isProbeRef,
} from './coord-refs.mjs';
import { coordinationSessionId } from './coord-session-id.mjs';

const COUNTER_REF = coordRef('session-counter');
// The pre-3756 counter. Read-only: `mintSessionNumber` seeds the new ref from it the first
// time, so session numbers stay globally monotonic across the namespace move.
const LEGACY_COUNTER_REF = legacyCoordRef('session-counter');
const PLANS_PREFIX = 'docs/superpowers/plans';
const INDEX_REL = 'docs/INDEX.md';

const HUSKY0 = { ...process.env, HUSKY: '0' }; // ref pushes carry no branch diff → no hook

// plan 4136 E5: measured deadline for the three coord `git push` sites this file runs
// uncapped (4087 review findings 1g1m81 mirror / 1s9uvj1 counter / 149q8uz projection). The
// coord-op journal's own push samples (n=109) read p50 4.2s, p95 10.1s, p99 23.2s, max 26.4s —
// 120s sits well above the observed max with room for a slow network hop, without letting a
// genuinely wedged push hang the claim spine forever.
//
// Deliberately NOT `derivedReadTimeoutMs`'s 90s ceiling (COORD_CHECKOUT_GIT_TIMEOUT_MS), even
// though that cap is also derived from the same journal: that cap bounds a LOCAL read/reset
// against the disposable checkout (fetch/reset/clean — plan 4087 T1), a fundamentally different
// failure surface than a push that must cross the network to origin. And a killed push is
// AMBIGUOUS in a way a killed local git op is not — the object may have landed on origin before
// the kill signal reached this client (the same ambiguity `verifyRemoteRef`'s plan-3554 note
// already documents for the claim-ref push) — so every site below pairs this cap with a
// verification read rather than trusting the exit code alone.
export const COORD_PUSH_TIMEOUT_MS = 120_000;

// The body of a commit object as printed by `git cat-file commit <sha>` — the
// header block is separated from the message by the first blank line.
function commitBody(mainDir, sha, { gitImpl = git } = {}) {
  const raw = gitImpl(mainDir, ['cat-file', 'commit', sha]);
  const i = raw.indexOf('\n\n');
  return i === -1 ? '' : raw.slice(i + 2);
}

// plan 3554: the 2026-08-31 drain proved a ref push can land while its transport reports
// failure. The freshly minted commit is unique, so one read of the exact ref is a total
// answer; do not fetch, retry, or infer ownership from the push exit code on that path.
//
// plan 4087 T2 (S3): this is the ONE read whose failure makes `acquireRef` throw a hard error
// (the "push failed AND verification failed" branch below) rather than degrade to a plain
// `lost` — so a single slow round-trip here is what the ledger's `claim-plan-acquire-reports-
// projected-true-after-rejected-master-push`-adjacent incidents mean by "acquire gives up".
// ONE retry with a DOUBLED cap before that happens: the ledger's measured GitHub baseline is
// ~2s, well under even the floor, so a genuine timeout here is very likely transient load, not
// an unreachable origin (an unreachable origin fails the SAME way on the retry, at 2x the
// cost — acceptable, since the alternative is failing a claim that would have succeeded).
function verifyRemoteRef(mainDir, ref, expectedSha, { gitImpl = git } = {}) {
  let out;
  try {
    out = lsRemoteTimed(mainDir, ref, { _git: gitImpl }).trim();
  } catch (e) {
    if (e?.code !== 'ETIMEDOUT') throw e;
    out = lsRemoteTimed(mainDir, ref, {
      _git: gitImpl,
      timeout: derivedReadTimeoutMs(mainDir) * 2,
    }).trim();
  }
  for (const line of out.split('\n')) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length === 2 && fields[1] === ref) {
      return { verdict: fields[0] === expectedSha ? 'ours' : 'other', sha: fields[0] };
    }
  }
  return { verdict: 'absent', sha: null };
}

// Acquire the claim ref for `planId` by pushing a unique parentless commit object.
// Returns { won:true, ref, sha } on success, { won:false, lost:true, ref } when a
// sibling already holds it. Throws (with the stderr) on a real push failure.
export function acquireRef(mainDir, { planId, message, gitImpl = git, _reclaim = true }) {
  const ref = refForPlan(planId);
  const legacyRef = legacyClaimRef(planId);
  const tree = gitImpl(mainDir, ['mktree'], { input: '' }).trim(); // empty tree object
  const commit = gitImpl(mainDir, ['commit-tree', tree, '-m', message]).trim(); // parentless, unique
  try {
    gitImpl(mainDir, ['push', 'origin', `${commit}:${ref}`], { env: HUSKY0 });
    // plan 3756 — the one legacy race worth closing. A session running PRE-flip code claims
    // `refs/claims/<id>` and cannot see our branch-shaped ref at all, so it can never yield
    // to us; if one took the old ref while we were pushing the new one, both of us would
    // believe we hold the plan. Re-read, and hand ours straight back if so. One extra
    // ls-remote on the winning path, and it disappears with the legacy namespace.
    if (legacyRef !== ref && legacyHolds(mainDir, legacyRef, { gitImpl })) {
      releaseOwnClaimRef(mainDir, planId, commit, { reason: 'yielded to a legacy claim' });
      return { won: false, lost: true, ref: legacyRef };
    }
    return { won: true, ref, sha: commit };
  } catch (e) {
    const stderr = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    const r = classifyPushResult({ ok: false, stderr });
    // plan 3756 — a non-ff rejection no longer means "someone holds this".
    //
    // Release stopped being a delete (the proxy 403s deletes by VERB — probe B6/B7), so a
    // RELEASED claim is a ref pointing at a tombstone, not an absent ref. The parentless
    // push above is rejected non-ff against it exactly as it is against a live claim, which
    // would make every re-claim of a previously-released plan read as lost — the spine would
    // deadlock on its second use of any plan.
    //
    // So on a non-ff we look at what is actually there. A live claim is still a loss. A
    // tombstone is ours to take, by re-pushing a commit PARENTED on that tip: a fast-forward,
    // therefore accepted, unless a rival appended first — in which case the tip moved, the
    // retry is rejected non-ff, and exactly one of us still wins. `_reclaim` stops that
    // retry recursing more than one level.
    if (!r.error && _reclaim) {
      const retry = reclaimOverTombstone(mainDir, { planId, message, gitImpl, ref, legacyRef });
      if (retry) return retry;
    }
    if (!r.error) return { won: false, lost: true, ref };
    let verification;
    try {
      verification = verifyRemoteRef(mainDir, ref, commit, { gitImpl });
    } catch (verifyError) {
      throw new Error(
        `claim-plan: push to ${ref} failed (not a lock contention):\n${stderr}\n` +
          `claim-plan: verification of ${ref} also failed:\n${errText(verifyError)}`,
      );
    }
    if (verification.verdict === 'ours') {
      console.error(`WARNING claim-plan: push to ${ref} reported failure but landed: ${stderr}`);
      return { won: true, ref, sha: commit };
    }
    if (verification.verdict === 'other') {
      console.error(
        `WARNING claim-plan: push to ${ref} failed and verification found another holder: ${stderr}`,
      );
      return { won: false, lost: true, ref };
    }
    // 'absent' — the write genuinely did not land. Unconditional so the catch can never
    // fall through to an implicit `undefined`: a lock acquisition returns a verdict or
    // throws, never a silent third state (plan 3554).
    throw new Error(`claim-plan: push to ${ref} failed (not a lock contention):\n${stderr}`);
  }
}

// plan 2891 review rounds 2+3: release a claim ref THIS process won, as a compare-and-swap.
//
// A bare `push origin :<ref>` deletes whatever origin currently holds. Every rollback path below
// runs after we won the ref, so "it must still be ours" feels safe — but a ref released by some
// other cleanup and RE-ACQUIRED by a rival in our window is then silently clobbered, handing two
// sessions the same plan, which is the one thing the claim ref exists to prevent. Pinning the
// delete to `claimSha` — the exact claim commit OUR acquire pushed — makes a re-acquired ref
// refuse the delete instead.
//
// ONE helper for all four rollback sites (doAcquire's mint-failure and projection-failure paths,
// and doAcquireBatch's releaseAll / releaseIfOurs): review round 3 found the lease implemented in
// the batch closures only, which is exactly the half-fixed state that reads as deliberate.
// Deliberately NOT release-claim.mjs's `releaseClaim`, which draws the same lease: that module
// imports `readHolder` from THIS one, so calling into it would close an import cycle.
//
// Best-effort by contract: every caller is already unwinding a failure, and a refused lease means
// someone else owns the ref now — which is the safe outcome, not one to escalate. reconcile-board
// surfaces a genuine leak.
export function releaseOwnClaimRef(mainDir, planId, claimSha, { reason = null } = {}) {
  const ref = refForPlan(planId);
  try {
    if (releaseStrategyFor(ref) === 'delete') {
      git(mainDir, ['push', `--force-with-lease=${ref}:${claimSha}`, 'origin', `:${ref}`], {
        env: HUSKY0,
      });
      return true;
    }
    // plan 3756: the branch-shaped namespace releases by appending a tombstone, because the
    // proxy 403s deletes outright. The lease is preserved in a different shape — the
    // tombstone's PARENT is the exact claim commit we pushed, so the push is a fast-forward
    // only while origin still points at ours. A rival who re-acquired in our window moved
    // the tip, our push is rejected non-ff, and we correctly report failure instead of
    // clobbering their claim — the same property `--force-with-lease` gave the delete.
    const tree = git(mainDir, ['mktree'], { input: '' }).trim();
    const msg = buildTombstoneMessage({
      planId: planIdOf(planId),
      sessionUuid: process.env.CLAUDE_CODE_SESSION_ID || 'unknown',
      host: hostname(),
      iso: new Date().toISOString(),
      reason,
    });
    const tomb = git(mainDir, ['commit-tree', tree, '-p', claimSha, '-m', msg]).trim();
    git(mainDir, ['push', 'origin', `${tomb}:${ref}`], { env: HUSKY0 });
    return true;
  } catch {
    return false;
  }
}

// plan 3756: the non-ff retry described in `acquireRef`. Returns a verdict when it could
// establish one, or null to let the caller fall back to the ordinary "lost".
//
// Every failure mode here resolves to null, i.e. to LOST. That is the safe direction for a
// mutex — refusing a claim we might have been able to take costs one drain cycle, while
// handing out a second claim on a held plan is the one outcome the ref exists to prevent —
// and it keeps an injected test git that cannot serve the extra reads from turning a
// deliberate loss into an exception.
function reclaimOverTombstone(mainDir, { planId, message, gitImpl, ref, legacyRef }) {
  let tip;
  try {
    tip = readClaimRefTip(mainDir, planId, { gitImpl });
  } catch {
    return null;
  }
  // Not a tombstone on OUR ref → a live holder, or a legacy ref we must not chain onto.
  if (!tip || tip.ref !== ref || claimIsHeld(tip.body)) return null;
  try {
    const tree = gitImpl(mainDir, ['mktree'], { input: '' }).trim();
    const commit = gitImpl(mainDir, ['commit-tree', tree, '-p', tip.sha, '-m', message]).trim();
    gitImpl(mainDir, ['push', 'origin', `${commit}:${ref}`], { env: HUSKY0 });
    if (legacyRef !== ref && legacyHolds(mainDir, legacyRef, { gitImpl })) {
      releaseOwnClaimRef(mainDir, planId, commit, { reason: 'yielded to a legacy claim' });
      return { won: false, lost: true, ref: legacyRef };
    }
    return { won: true, ref, sha: commit };
  } catch {
    return null; // a rival appended first (or the retry failed) — lost, per above
  }
}

// plan 3756: every plan currently HELD on origin, as { '<id>': { sha, ref, body } }.
//
// The sweep readers (reconcile-board, the boards, wake-stalls) used to answer "who is holding
// what?" from `ls-remote` alone, because a claim ref EXISTING was the same statement as a plan
// being held. Under tombstone release that stopped being true, and `ls-remote` reports only
// names and shas — it cannot tell a live claim from a released one. Every one of those readers
// would report released plans as claimed, which in the boards' case means an operator staring
// at plans nobody is working.
//
// So this resolves the tips, in ONE extra network call for the whole namespace rather than a
// fetch per ref: mirror the claim namespace into a private remote-tracking snapshot, then read
// every subject locally with a single `for-each-ref`. The legacy namespace needs no such work —
// nothing ever tombstones there, so existence is still holding.
//
// `subject` is git's FOLDED one-line rendering of the claim commit, not its body — enough to
// tell held from released, but not to parse the holder's session/host/iso off. A caller that
// needs those reads the one ref it cares about through `readHolder`/`readClaimRefTip`; making
// this sweep return full bodies would cost a cat-file per ref and undo the point of it.
//
// The snapshot refs are `refs/remotes/claim-snapshot/*`, deliberately not under
// `refs/remotes/origin/` — a sweep must never disturb the tracking refs real branch tooling
// reads, and `--prune` here would then be dangerous rather than merely tidy.
const CLAIM_SNAPSHOT_PREFIX = 'refs/remotes/claim-snapshot/';
export function heldClaimsMap(mainDir, { _git = git } = {}) {
  const held = {};
  try {
    _git(
      mainDir,
      ['fetch', '--quiet', '--prune', 'origin', `+${CLAIM_PREFIX}*:${CLAIM_SNAPSHOT_PREFIX}*`],
      // plan 4087 T2: capped like every other claim read, at the ONE derived cap (see
      // derivedReadTimeoutMs's own header) — these callers are reporters and guards, and an
      // unreachable origin must fail fast rather than hang a board render.
      { timeout: derivedReadTimeoutMs(mainDir) },
    );
    const out = _git(mainDir, [
      'for-each-ref',
      '--format=%(refname)%09%(objectname)%09%(contents:subject)',
      `${CLAIM_SNAPSHOT_PREFIX}*`,
    ]);
    for (const line of String(out).split('\n')) {
      const [snapRef, sha, subject = ''] = line.trim().split('\t');
      if (!snapRef || !sha) continue;
      const id = planIdFromClaimRef(
        `${CLAIM_PREFIX}${snapRef.slice(CLAIM_SNAPSHOT_PREFIX.length)}`,
      );
      if (!id) continue;
      if (!claimIsHeld(subject)) continue; // a tombstone: the ref is there, the lock is not
      held[id] = { sha, ref: `${CLAIM_PREFIX}${id}`, subject };
    }
  } catch (e) {
    // plan 3756 review: do NOT swallow this. Falling through would return a map containing only
    // legacy claims, and every caller reads a missing id as "this plan is FREE" — the unsafe
    // direction, which is how you get two sessions on one plan or a claimed branch deleted. An
    // unreadable origin is an ERROR, and each caller decides how to degrade safely.
    throw new Error(`claim-plan: could not read the claim namespace from origin: ${e.message}`);
  }
  try {
    // plan 4087 T2 (S3): this was a hand-rolled `_git(..., ['ls-remote', ...])` that never
    // touched lsRemoteTimed at all — the exact gap the 2026-09-11 ledger line
    // (`claim-plan-5s-read-cap-kills-acquire-under-machine-load`) names: changing
    // lsRemoteTimed's own default alone would not have reached this read. Routed through it
    // now, so this shares the ONE derived cap with every other ls-remote in the spine instead
    // of carrying a second, independent one.
    const ls = lsRemoteTimed(mainDir, LEGACY_CLAIM_GLOB, { _git });
    for (const [id, sha] of Object.entries(parseClaimLsRemote(ls))) {
      if (!(id in held)) held[id] = { sha, ref: legacyClaimRef(id), subject: null };
    }
  } catch (e) {
    throw new Error(`claim-plan: could not read the legacy claim namespace: ${e.message}`);
  }
  return held;
}

// plan 3756: the garbage chore the tombstone design requires.
//
// Releasing stopped deleting the ref, so released claim refs accumulate — visible as remote
// branches under `origin/coord/claims/*`, and growing two commits per claim/release cycle.
// Deleting them is the ONLY part of the lifecycle that still needs an environment whose
// pushes may delete: the sandbox proxy 403s deletes by verb (probe B6/B7), which is the whole
// reason release is a tombstone. That is why this is a CHORE and never sits on the critical
// path of a claim or a land — a cloud drain can claim, release and land perfectly well while
// this has not run for weeks.
//
// Only refs whose tip is a tombstone are eligible. A live claim is never touched, so running
// this while sessions are working is safe; the worst case is that it deletes nothing.
export function gcReleasedClaimRefs(mainDir, { apply = false, _git = git } = {}) {
  const ls = _git(mainDir, ['ls-remote', 'origin', CLAIM_GLOB]);
  const candidates = [];
  for (const line of String(ls).split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/u);
    if (!sha || !ref) continue;
    const id = planIdFromClaimRef(ref);
    if (!id) continue;
    let tip;
    try {
      tip = readRemoteRefCommit(mainDir, ref);
    } catch {
      continue; // unreadable: leave it alone rather than delete something we cannot classify
    }
    if (!tip || claimIsHeld(tip.body)) continue;
    candidates.push({ planId: id, ref, sha: tip.sha });
  }
  if (!apply) return { reaped: [], candidates, applied: false };
  const reaped = [];
  const failed = [];
  for (const c of candidates) {
    try {
      // Leased to the tombstone sha we just read: a plan RE-claimed between the read and this
      // delete has moved the tip, and must not lose its live claim to a stale GC pass.
      _git(mainDir, ['push', `--force-with-lease=${c.ref}:${c.sha}`, 'origin', `:${c.ref}`], {
        env: HUSKY0,
      });
      reaped.push(c);
    } catch (e) {
      failed.push({ ...c, error: `${e.message}`.split('\n')[0] });
    }
  }
  return { reaped, failed, candidates, applied: true };
}

// plan 3812: the sibling garbage chore for the project-side coordination probe's throwaway namespace
// (`refs/heads/coord/probes/zzz-<random>`, coord-refs.mjs's PROBE_GLOB).
//
// A probe ref is NOT a claim ref: it carries no holder state for anything to misread as
// "held", and nothing ever reads one back (coord-probe.mjs's own header, REJECTED
// ALTERNATIVE note). So unlike `gcReleasedClaimRefs`, there is no tombstone requirement —
// ANY ref matching PROBE_GLOB is reap-eligible the moment this sweep sees it. Deleting it
// is still leased to the sha the sweep just observed (`--force-with-lease=<ref>:<sha>`,
// same pattern as the claims sweep above) so a concurrent firing that somehow reused a
// probe name — not expected, since probeRefName() carries a fresh random suffix per call,
// but cheap to guard against anyway — cannot have its fresh ref clobbered out from under
// it. Deliberately a NEW, separate export rather than a change to `gcReleasedClaimRefs`:
// the two namespaces have different eligibility rules (tombstone-gated vs. unconditional),
// and folding them into one function would either weaken the claims sweep's held-claim
// safety check or wrongly impose a tombstone requirement probe refs never carry.
export function gcProbeRefs(mainDir, { apply = false, remote = 'origin', _git = git } = {}) {
  const ls = _git(mainDir, ['ls-remote', remote, PROBE_GLOB]);
  const candidates = [];
  for (const line of String(ls).split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/u);
    if (!sha || !ref || !isProbeRef(ref)) continue;
    candidates.push({ ref, sha });
  }
  if (!apply) return { reaped: [], candidates, applied: false };
  const reaped = [];
  const failed = [];
  for (const c of candidates) {
    try {
      _git(mainDir, ['push', `--force-with-lease=${c.ref}:${c.sha}`, remote, `:${c.ref}`], {
        env: HUSKY0,
      });
      reaped.push(c);
    } catch (e) {
      failed.push({ ...c, error: `${e.message}`.split('\n')[0] });
    }
  }
  return { reaped, failed, candidates, applied: true };
}

// plan 3756: the tip of a plan's claim ref in EITHER namespace, tombstone or not, plus the
// ref it was found on. The unfiltered twin of `readHolder` below — for the readers that
// deliberately want to see a RELEASED claim (the reap chore; reconcile-board's orphan
// report, which would otherwise invite an operator to force-release a ref nobody holds).
export function readClaimRefTip(mainDir, planId, { gitImpl } = {}) {
  const read = gitImpl
    ? (ref) => readRemoteRefCommitWith(mainDir, ref, gitImpl)
    : (ref) => readRemoteRefCommit(mainDir, ref);
  for (const ref of claimRefCandidates(planId)) {
    const h = read(ref);
    if (h) return { ...h, ref };
  }
  return null;
}

// Is a pre-flip `refs/claims/<id>` currently HELD? Legacy refs are released by DELETE, so
// existence is holding — no tombstone can appear there.
function legacyHolds(mainDir, legacyRef, { gitImpl = git } = {}) {
  try {
    return gitImpl(mainDir, ['ls-remote', 'origin', legacyRef]).trim().length > 0;
  } catch {
    // Unreachable origin: assume held. The safe direction is refusing a claim, never
    // handing out a second one.
    return true;
  }
}

// The `readRemoteRefCommit` shape against an injected git (the test seam acquireRef uses).
function readRemoteRefCommitWith(mainDir, ref, gitImpl) {
  const ls = gitImpl(mainDir, ['ls-remote', 'origin', ref]).trim();
  if (!ls) return null;
  const sha = ls.split('\t')[0];
  try {
    gitImpl(mainDir, ['fetch', '--quiet', 'origin', ref], { env: HUSKY0 });
    const raw = gitImpl(mainDir, ['cat-file', 'commit', sha]);
    const i = raw.indexOf('\n\n');
    return { sha, body: i === -1 ? '' : raw.slice(i + 2) };
  } catch (e) {
    if (!gitImpl(mainDir, ['ls-remote', 'origin', ref]).trim()) return null; // released mid-read
    throw e;
  }
}

// Read the current holder of a plan's claim ref (for "taken by…" reporting). null
// if unheld. Delegates to the shared ref-CAS read plumbing (coord-git, plan 1915) —
// which also tolerates the ref vanishing between the ls-remote and the fetch.
// plan 3756: this is the seam that keeps the tombstone from leaking into every reader.
//
// Across the spine, "readHolder returned non-null" IS "the plan is held" — claimStatus,
// releaseClaim, the edit-plan/move-plan claimed-by-another gates, cut-worktree --adopt,
// post-checkout-claim-guard. Under tombstone release the ref still EXISTS after a release,
// so answering from existence alone would report every released plan as claimed and nothing
// would ever be claimable twice. Filtering HERE makes all of those sites correct unchanged,
// and makes it impossible to half-apply the rule across the spine.
//
// It also walks both namespaces, so a pre-flip `refs/claims/<id>` still reads as held for as
// long as any session holds one. The returned `ref` says which namespace answered — release
// needs it, since the two release differently.
export function readHolder(mainDir, planId) {
  for (const ref of claimRefCandidates(planId)) {
    const h = readRemoteRefCommit(mainDir, ref);
    if (!h) continue;
    if (!claimIsHeld(h.body)) continue; // a tombstone means released, i.e. NOT held
    return { ...h, ref };
  }
  return null;
}

// plan 958: read-only `status` reporter for refs/claims/<id>. Does NOT contend for
// the ref (no commit-tree/push) — it only reads the current holder, so a session can
// ask "is this plan held, by whom, for how long, and is it ME?" deterministically.
// `youAreHolder` compares the claim's stored sessionUuid to THIS process's harness
// coordination session id; it is false when the runtime identity is absent (a
// headless run can't prove ownership) — never a guess. Shape:
//   { planId, held:false }                                              — unheld
//   { planId, held:true, holder:{ sessionUuid, host, iso, ageSec }, youAreHolder }
// `now`/`selfId` are injectable for tests; they default to wall-clock + the env id.
export function planStatus(
  mainDir,
  planId,
  { now = new Date(), selfId = coordinationSessionId() } = {},
) {
  const id = planIdOf(planId);
  const h = readHolder(mainDir, id);
  if (!h) return { planId: id, held: false };
  const holder = parseClaimMessage(h.body); // null when the commit body is unparseable
  if (!holder) {
    // The ref EXISTS (so the plan is held), but the claim commit body is malformed or a
    // pre-format object: report held with an unknown holder rather than throw.
    return { planId: id, held: true, holder: null, youAreHolder: false, ref: h.ref };
  }
  const t = holder.iso ? Date.parse(holder.iso) : NaN;
  const ageSec = Number.isNaN(t) ? null : Math.max(0, Math.round((now.getTime() - t) / 1000));
  const youAreHolder = Boolean(selfId) && holder.sessionUuid === selfId;
  return {
    planId: id,
    held: true,
    holder: { sessionUuid: holder.sessionUuid, host: holder.host, iso: holder.iso, ageSec },
    youAreHolder,
    // plan 3973 review round 4: the namespace the claim was actually found in, carried on
    // the SAME read that decided held/youAreHolder so no caller needs a second readHolder.
    ref: h.ref,
  };
}

// Mint the next global session number from the CAS counter ref refs/coord/session-counter.
// The ref points at a commit whose message is `session=<N>`; the next value is minted
// by committing a new object whose PARENT is the current ref tip — a fast-forward when
// uncontended, a non-ff rejection when a sibling advanced the counter between our read
// and our push (re-read + recompute + retry, bounded). This is the same push-rejection
// CAS as the plan-claim ref, applied to a monotonic counter — killing the filesystem
// "highest session file +1" TOCTOU scramble (the 329/330/331 re-guess loop).
// plan 3756 review: while BOTH namespaces are live, a pre-flip session mints from the retired
// counter and a post-flip one from the new counter, so the two can hand out the same session
// number. Nothing makes that atomic across two refs — a cross-namespace CAS does not exist — so
// this closes the practical window instead: after winning the new counter, push the same value
// onto the retired one, best-effort. A pre-flip reader then sees the advanced value and mints
// above it.
//
// Deliberately NOT load-bearing. It is wrapped in try/catch and its failure is ignored, because
// the new counter is already the authority and a mirror failure must never fail a claim. The
// residual race is two sessions minting in the same instant during the migration window; the
// cost is a duplicated session-entry filename, not a lost claim, and it disappears with the
// legacy namespace.
// Exported (plan 4136 E5) so claim-plan.test.mjs can drive the mirror push in isolation instead
// of only through mintSessionNumber's full ls-remote/fetch/cat-file/mktree/commit-tree chain.
export function mirrorLegacyCounter(mainDir, n, { gitImpl = git } = {}) {
  try {
    // plan 4087 T2: routed through lsRemoteTimed (the ONE derived cap) instead of a
    // hand-rolled `_git(..., ['ls-remote', ...])` — see heldClaimsMap's identical fix above.
    const ls = lsRemoteTimed(mainDir, LEGACY_COUNTER_REF, { _git: gitImpl }).trim();
    // ABSENT means the retired ref has already been reaped: do not resurrect a namespace this
    // plan exists to retire. The mirror only ever helps a pre-flip session that is still there.
    if (!ls) return;
    const oldSha = ls.split('\t')[0];
    gitImpl(mainDir, ['fetch', '--quiet', 'origin', LEGACY_COUNTER_REF], {
      timeout: derivedReadTimeoutMs(mainDir),
    });
    // Never LOWER it. The legacy counter can be AHEAD of ours (a pre-flip session minted after
    // our seed), and pushing our smaller value would hand its next session a number already
    // used. Monotonic or nothing.
    if (nextSessionNumber(commitBody(mainDir, oldSha, { gitImpl })) > n) return;
    const tree = gitImpl(mainDir, ['mktree'], { input: '' }).trim();
    const commit = gitImpl(mainDir, [
      'commit-tree',
      tree,
      '-p',
      oldSha,
      '-m',
      `session=${n}\nnonce=${randomUUID()}`,
    ]).trim();
    // plan 4136 E5 (finding 1g1m81): capped at COORD_PUSH_TIMEOUT_MS — this push was
    // previously unbounded, and "best-effort" above is a try/catch, which catches a THROW,
    // not a hang. A timeout here needs no verification of its own: it throws the same
    // COORD_CHECKOUT_TIMEOUT shape any other failure of this push would, and the catch below
    // swallows it exactly as it already swallows every other failure of this mirror.
    boundedGit(mainDir, ['push', 'origin', `${commit}:${LEGACY_COUNTER_REF}`], {
      env: HUSKY0,
      timeoutMs: COORD_PUSH_TIMEOUT_MS,
      _git: gitImpl,
    });
  } catch {
    /* best-effort: the new counter is the authority */
  }
}

export function mintSessionNumber(mainDir, { maxAttempts = 8, gitImpl = git } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    // plan 4087 review follow-up (finding 1ifpgdv): this was a hand-rolled
    // `gitImpl(..., ['ls-remote', ...])` with no timeout, the same gap T2 already closed a few
    // lines below for the legacy-counter read — routed through the ONE bounded seam instead.
    const ls = lsRemoteTimed(mainDir, COUNTER_REF, { _git: gitImpl }).trim();
    const oldSha = ls ? ls.split('\t')[0] : null;
    let oldMsg = null;
    if (oldSha) {
      gitImpl(mainDir, ['fetch', '--quiet', 'origin', COUNTER_REF], {
        timeout: derivedReadTimeoutMs(mainDir),
      });
      oldMsg = commitBody(mainDir, oldSha, { gitImpl });
    }
    // plan 3756 SEED + review round 3: take the MAX of the two counters on EVERY mint, not only
    // when the new ref is absent.
    //
    // Seeding-once was not enough. It stops the new counter restarting at 1 after ~3,755
    // sessions, but a pre-flip session that mints while both namespaces are live pushes the
    // RETIRED counter ahead of ours, and we would then hand out a number it has already used.
    // Reading both and taking the higher makes that impossible in this direction; the mirror
    // below covers the other. Best-effort: an unreadable legacy ref just means no seed.
    let legacyMsg = null;
    // plan 4087 T2: routed through lsRemoteTimed, same fix as mirrorLegacyCounter above.
    const legacyLs = lsRemoteTimed(mainDir, LEGACY_COUNTER_REF, { _git: gitImpl }).trim();
    if (legacyLs) {
      // Present but unreadable is NOT the same as absent, and must not be swallowed: reading it
      // as absent would mint from the lower floor and reissue a number the retired counter has
      // already handed out. Same fail-closed posture as heldClaimsMap.
      gitImpl(mainDir, ['fetch', '--quiet', 'origin', LEGACY_COUNTER_REF], {
        timeout: derivedReadTimeoutMs(mainDir),
      });
      legacyMsg = commitBody(mainDir, legacyLs.split('\t')[0], { gitImpl });
    }
    const n = Math.max(nextSessionNumber(oldMsg), nextSessionNumber(legacyMsg));
    const tree = gitImpl(mainDir, ['mktree'], { input: '' }).trim();
    const args = ['commit-tree', tree, '-m', `session=${n}\nnonce=${randomUUID()}`];
    if (oldSha) args.splice(2, 0, '-p', oldSha); // parent = old tip → FF when uncontended
    const commit = gitImpl(mainDir, args).trim();
    try {
      // plan 4136 E5 (finding 1s9uvj1): capped at COORD_PUSH_TIMEOUT_MS. A timeout raises a
      // COORD_CHECKOUT_TIMEOUT-shaped error whose message never matches isNonFastForward's
      // text patterns, so it falls straight into the existing verifyRemoteRef branch below —
      // exactly the same "did it actually land" check any other non-non-ff push failure
      // already gets here. No new branch needed.
      boundedGit(mainDir, ['push', 'origin', `${commit}:${COUNTER_REF}`], {
        env: HUSKY0,
        timeoutMs: COORD_PUSH_TIMEOUT_MS,
        _git: gitImpl,
      });
      mirrorLegacyCounter(mainDir, n, { gitImpl });
      return n;
    } catch (e) {
      if (!isNonFastForward(e)) {
        let verification;
        try {
          verification = verifyRemoteRef(mainDir, COUNTER_REF, commit, { gitImpl });
        } catch (verifyError) {
          throw new Error(
            `claim-plan: session counter push failed:\n${errText(e)}\n` +
              `claim-plan: verification of ${COUNTER_REF} also failed:\n${errText(verifyError)}`,
          );
        }
        if (verification.verdict === 'ours') return n;
        if (verification.verdict === 'absent') throw e;
        if (verification.sha === oldSha) throw e;
        // A different sha means a sibling advanced the counter; re-read and retry.
      }
    }
  }
  throw new Error(`claim-plan: session counter contended after ${maxAttempts} attempts`);
}

export { isNonFastForward }; // re-export for downstream CAS callers

// Plan-status folders a plan can be CLAIMED from: ready/ + pending-approval/ (the
// default mint target since plan 1371) + the waiting-* gates, derived from the canonical
// STATUS_ORDER minus in-progress/ (already claimed). archive/ is absent from STATUS_ORDER —
// and so is parked/ (plan 1426): a parked plan is a deliberate long-term freeze, NEVER
// claimable, so it must never be added to STATUS_ORDER (this filter would otherwise pick
// it up automatically). ready/ is first ⇒ it wins precedence if a plan id somehow appears
// in two folders (it should not).
const CLAIMABLE_FOLDERS = STATUS_ORDER.filter((s) => s !== IN_PROGRESS_FOLDER);

// Resolve a plan's current path from `git ls-files`, searching ready/ first then each
// waiting-*/ gate (NOT in-progress/, archive/, or parked/ — plan 1426); returns the
// first hit. This lets the full `acquire` RESUME a plan parked in waiting-*/ (an
// operator override) — not only
// claim a fresh ready/ plan — removing the `--lock-only` no-projection workaround that
// stranded plan 432 in waiting-operator/ while actively worked (plan 446, the
// 2026-06-07 session-376 stranding). The `git ls-files` source is canonical: an
// untracked foreign drop is invisible, same as build-index / lint-plan-index.
//
// plan 2353: `includeInProgress` adds `in-progress/` to the search — the TAKEOVER case.
// It is opt-in (and searched LAST, so a plan somehow present in both folders still
// resolves as a fresh claim) because the default refusal is load-bearing: an
// `in-progress/` plan whose claim ref is FREE means the previous holder died, and only an
// explicit `--resume` should proceed on that. Without this, `acquire` won the ref-CAS and
// then rolled it back on the unresolvable path, so a takeover's ONLY route was
// `--lock-only` + a hand-rolled projection — whose session-entry file has no sanctioned
// writer at all (`coord-edit.mjs` refuses untracked paths, the plan-1279 pre-commit guard
// blocks the hand commit), leaving `BOARD_GUARD_OVERRIDE=1` as the sole escape.
export function activePathFor(mainDir, planId, { includeInProgress = false } = {}) {
  // plan 2678: enumerate the folder RECURSIVELY, then match on the BASENAME — the way
  // resolvePlanAtOrigin below already does. The old pathspec `<folder>/<id>-*.md` looked
  // recursive but is not: a git glob crosses `/` only when a `*` PRECEDES the literal, so
  // a leading `<id>-` anchored right after the folder name matched flat files ONLY.
  // A plan clumped into a category subfolder was therefore unclaimable — `acquire` /
  // `pickup-plan` died on noClaimableFileError while the origin-store resolver (which uses
  // `git ls-tree -r` + a basename match) found it fine. Matching by basename with the
  // shared idClaimPattern also drops the old pathspec's accidental prefix matches.
  const idRx = new RegExp(`^${idClaimPattern(planId)}`, 'u');
  for (const folder of claimableSearchFolders(includeInProgress)) {
    const out = git(mainDir, ['ls-files', `${PLANS_PREFIX}/${folder}/*.md`]).trim();
    const first = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .find((rel) => idRx.test(rel.split('/').pop()));
    if (first) return first;
  }
  throw noClaimableFileError(planId, includeInProgress);
}

// The folder search order shared by activePathFor (mainDir index) and resolvePlanAtOrigin
// (origin/master object store) below — factored out so the two lookup sources can't drift
// on which folders are searched or in what order.
function claimableSearchFolders(includeInProgress) {
  return includeInProgress ? [...CLAIMABLE_FOLDERS, IN_PROGRESS_FOLDER] : CLAIMABLE_FOLDERS;
}
function noClaimableFileError(planId, includeInProgress, { onOrigin = false } = {}) {
  return new Error(
    `claim-plan: no claimable plan file for id ${planId}${onOrigin ? ' on origin/master' : ''} ` +
      `(searched ready/ + waiting-*/${includeInProgress ? ' + in-progress/' : ''})` +
      (includeInProgress
        ? ''
        : ' — if the plan is already in in-progress/ and its claim ref is free (a dead' +
          ' holder), take it over with `acquire --resume`'),
  );
}

// plan 2395: activePathFor's `git ls-files` search reads the MAIN checkout's on-disk index,
// but every coord writer (move-plan.mjs, next-plan-id.mjs, edit-plan.mjs, projectClaim
// itself) commits through the disposable coord-checkout and pushes straight to origin
// WITHOUT ever touching mainDir's working tree — so a plan moved or minted moments earlier
// is invisible here, and doAcquire's Gate-2 frontmatter read silently degrades to
// `frontmatterUnreadable: true` right when the plan-1627 thin-orchestrator doctrine block
// (gated on execModel === 'fable') most needs to fire. Mirrors edit-plan.mjs's
// lsPlansAtRef/readBlobAtRef precedent in spirit (object-store reads, no working-tree state
// needed) — but pins the resolution to ONE `git rev-parse origin/master` sha up front and
// resolves both the folder-search listing AND (via readAtOrigin below) the content read
// against that SAME immutable sha, rather than re-resolving the moving `origin/master`
// branch ref on each of the two git calls: a sibling coord push landing in the gap between
// two independently-resolved reads could otherwise skew the listing and the content read out
// of sync (review r1, plan 2395). No `git fetch` here — the plan's ratified fix (candidate 1
// over candidate 2, spec-pass 2026-07-25) deliberately skips the network round-trip: mainDir
// and every coord writer's coord-checkout are worktrees of this SAME shared .git, so a
// sibling's push updates this local origin/master ref the instant it lands — a fetch would
// only matter for a genuinely separate clone/container, which pays its own `git fetch
// origin` earlier in its own routine. Scoped to doAcquire's two mainDir gate-read call sites
// (the Gate-2 frontmatter read + the slug-hint path) ONLY — NOT a replacement for
// activePathFor itself, whose other callers (projectClaim's `cdir` resolution, the batch
// eligibility gate) are unaffected by this bug and must not change (plan 2353 review finding
// [3]). Listing is scoped PER FOLDER (not the whole plans tree) so a `ready/`-folder hit
// never pays for enumerating the (much larger, ever-growing) `archive/` tree it can never
// match — the same per-folder-early-exit shape activePathFor uses.
// Returns a `(sha, folder) => string[] | null` per-folder `git ls-tree` listing function.
// With `cache` supplied, repeat calls for the same (sha, folder) reuse the first result
// instead of re-spawning `git ls-tree` — doAcquireBatch shares one instance across every
// batch member so the whole train pays for each folder's listing ONCE (plan 2561), instead
// of once per member.
function makeFolderListing(mainDir, { cache } = {}) {
  return function getFolderListing(sha, folder) {
    const key = cache && `${sha}:${folder}`;
    if (cache && cache.has(key)) return cache.get(key);
    let listing;
    try {
      listing = git(mainDir, [
        'ls-tree',
        '-r',
        '--name-only',
        sha,
        '--',
        `${PLANS_PREFIX}/${folder}/`,
      ])
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      listing = null; // folder absent from this tree — OR a transient git I/O hiccup
    }
    // sonnet-review finding (2026-07-27): only memoize a SUCCESSFUL listing. A null here can
    // be a genuine transient failure (I/O hiccup, momentary git-lock contention from a sibling
    // coord push), not certainty the folder is absent at this sha — caching it would poison
    // every remaining batch member's lookup of this folder for the rest of the batch (they'd
    // all skip a folder that may well have resolved on a bare retry), turning one member's
    // transient error into a false "unresolved" verdict for the whole batch. Leaving a miss
    // uncached just means a retry pays for git ls-tree again, exactly like before this cache
    // existed — the caching win is for the (overwhelmingly common) success path.
    if (cache && listing !== null) cache.set(key, listing);
    return listing;
  };
}

// Shared per-folder listing + basename-match lookup, pinned to a caller-supplied sha — the
// core both resolvePlanAtOrigin (throw-on-miss, resolves origin/master itself) and
// resolveMemberPathAtOriginSha (null-on-miss, caller-supplied sha) wrap. Plan 2561: pure
// internal factor, does not change either wrapper's external contract.
function findPlanPathAtSha(mainDir, sha, planId, includeInProgress, getListing) {
  const listFolder = getListing || makeFolderListing(mainDir);
  for (const folder of claimableSearchFolders(includeInProgress)) {
    const listing = listFolder(sha, folder);
    if (!listing) continue; // folder absent from this tree
    const match = listing.find(
      (p) => p.split('/').pop().startsWith(`${planId}-`) && p.endsWith('.md'),
    );
    if (match) return match;
  }
  return null;
}

function resolvePlanAtOrigin(mainDir, planId, { includeInProgress = false } = {}) {
  const sha = git(mainDir, ['rev-parse', 'origin/master']).trim();
  const match = findPlanPathAtSha(mainDir, sha, planId, includeInProgress);
  if (match) return { path: match, sha };
  throw noClaimableFileError(planId, includeInProgress, { onOrigin: true });
}

// The path-only view of resolvePlanAtOrigin, for the slug-hint call site (which never needs
// content).
function activePathAtOrigin(mainDir, planId, opts) {
  return resolvePlanAtOrigin(mainDir, planId, opts).path;
}

// A tracked plan file's content AT the SAME sha resolvePlanAtOrigin resolved its path
// against — deliberately not coord-git.mjs's readTrackedFileFresh, whose `git show
// origin/master:<rel>` re-resolves the moving branch ref on every call (correct for its own
// callers, who already know a fixed path and want the latest tip; wrong here, where pinning
// list and read to one sha is the whole point).
function readAtOrigin(mainDir, sha, relPath) {
  return git(mainDir, ['show', `${sha}:${relPath}`]);
}

// plan 2536: doAcquireBatch's batch-shaped sibling of resolvePlanAtOrigin — resolves ONE
// member's path at a CALLER-SUPPLIED sha, instead of resolving `origin/master` itself the way
// resolvePlanAtOrigin does for the single-plan path. A batch has N members; if each member's
// path were resolved via its own `resolvePlanAtOrigin(mainDir, id)` call, a sibling coord push
// landing between two of those N independent `git rev-parse origin/master` calls could hand
// checkBatchEligibility a set of members straddling two different points in history — the same
// hazard resolvePlanAtOrigin's own comment describes for two independently-resolved reads
// within a single plan, just multiplied across the batch. Resolving one sha up front in
// doAcquireBatch and threading it through here (and into readAtOrigin for the content read)
// keeps all N members, plus the coord.config.json read (loadCoordConfigAtOrigin, reused as-is),
// pinned to that one immutable point. Same per-folder `git ls-tree` + basename-match shape as
// resolvePlanAtOrigin; returns null (never throws) on a genuine miss so the caller can fold it
// into the existing `path: null` "unresolved" shape checkBatchEligibility already reports on —
// resolvePlanAtOrigin's own callers need the thrown-error shape (single plan, no fold-in
// target), batch's loop wants an unresolved MEMBER to keep flowing through so every other
// member's own resolution still runs and the eligibility reason lists every unresolved id, not
// just the first. `getListing` (plan 2561) lets doAcquireBatch pass one shared, cached
// listing function across every member's call, so the whole batch pays for each
// claimableSearchFolders() folder's `git ls-tree` ONCE instead of once per member — every
// member shares the same pinned `originSha`, so the listing is identical across calls.
function resolveMemberPathAtOriginSha(mainDir, sha, planId, getListing) {
  return findPlanPathAtSha(mainDir, sha, planId, false, getListing);
}

// A minimal per-session claim entry — the worker fills in What-shipped on completion.
//
// `realBasename` (the plan's actual on-disk filename, e.g. `811-Price-Surface-….md`) is what
// the **Plan:** pointer must name — NOT `<slug>.md`. The caller's `--slug` is free to differ
// from the basename in casing or wording (the plan-819 class), which is exactly why the board
// cell, the git-mv destination, and the BATCH stub all already resolve `realBasename` instead.
// This single-plan stub was the last pointer still built from the slug, so a mismatched claim
// wrote a session entry whose **Plan:** link pointed at a file that does not exist. Plan 2353
// makes that live rather than theoretical: a `--resume` takeover routinely runs under a slug
// chosen by the NEW session, which is why the same function reports stale board rows for the
// old one. Falls back to `<slug>.md` only for callers/tests that pass no basename.
function sessionEntryStub({
  planId,
  slug,
  realBasename,
  sessionNum,
  host,
  date,
  seedWrite,
  seedLane = true,
  modelId,
  dispatchMode,
}) {
  const marker = seedLane && String(seedWrite).toLowerCase() === 'yes' ? '🟥 YES' : '🟩 NO';
  return [
    `# ${date} (session ${sessionNum} — pick up plan ${planId}: ${slug})`,
    '',
    `**Status:** 🔄 IN PROGRESS — claimed via ref-CAS (\`${refForPlan(planId)}\`), worktree being created.`,
    `**Plan:** \`${PLANS_PREFIX}/${IN_PROGRESS_FOLDER}/${realBasename || `${slug}.md`}\``,
    `**Host:** \`${host}\``,
    // plan 2460 Phase 2: the executor-provenance stamp — same field pair as the board cell's
    // `exec=`/`model=` segment, so a reader that has the session doc but not the board row
    // still learns WHAT executed this claim, not just WHO.
    `**Executor:** \`${dispatchMode}\` · model \`${modelId}\``,
    `**Branch:** \`worktree-${slug}\` · worktree \`${worktreePathFor(slug)}\``,
    `**Seed-write:** ${marker}`,
    '',
    `Claimed atomically through \`scripts/claim-plan.mjs acquire\` — the \`${refForPlan(planId)}\` ref is the lock; this board/INDEX/body/session projection rode behind it.`,
    '',
  ].join('\n');
}

// plan 1364 Ship 1: the batch analogue of sessionEntryStub above — ONE stub for the
// WHOLE batch, listing every member plan. Deliberately a SEPARATE function (not a
// generalisation of sessionEntryStub itself) so the single-plan path's output stays
// byte-for-byte unchanged. `members`: [{ planId, realBasename }].
function batchSessionEntryStub({ members, slug, sessionNum, host, date, modelId, dispatchMode }) {
  const memberLines = members
    .map((m) => `- \`${PLANS_PREFIX}/${IN_PROGRESS_FOLDER}/${m.realBasename}\` (plan ${m.planId})`)
    .join('\n');
  return [
    `# ${date} (session ${sessionNum} — pick up BATCH ${slug}: ${members.length} plans)`,
    '',
    `**Status:** 🔄 IN PROGRESS — batch claimed via ref-CAS (one \`${CLAIM_PREFIX}<id>\` per member), worktree being created.`,
    '',
    `**Members:**`,
    memberLines,
    '',
    `**Host:** \`${host}\``,
    // plan 2460 Phase 2: same executor-provenance stamp as the single-plan stub — one
    // executor claimed every member of the batch, so a single line covers all of them.
    `**Executor:** \`${dispatchMode}\` · model \`${modelId}\``,
    `**Branch:** \`worktree-${slug}\` · worktree \`${worktreePathFor(slug)}\``,
    '',
    `Claimed atomically through \`scripts/claim-plan.mjs batch\` — each member's \`${CLAIM_PREFIX}<id>\` ` +
      `ref is a lock; this board/INDEX/body/session projection rode behind ALL of them winning together.`,
    '',
  ].join('\n');
}

// plan 871: write a session entry to the FIRST FREE candidate path, never clobbering an
// existing file. For the 'sessions' layout the write uses an EXCLUSIVE create (`flag: 'wx'`),
// which is atomic — it closes the TOCTOU window between an `existsSync` probe and the write,
// so even two writers that computed the same `<N>` (one not minting via the CAS counter)
// cannot overwrite each other: the loser's `wx` fails EEXIST and falls through to `…-<N>b.md`.
// Returns the rel path actually written. The 'single' layout (legacy — vetapp uses
// 'sessions') has no per-session file to collide on, so it keeps the pre-871 plain write
// to handoff.md (a non-exclusive overwrite, unchanged from before this fix).
export function writeSessionEntryExclusive(
  mainDir,
  { date, sessionNum, content, handoffLayout, paths },
) {
  const candidates = sessionEntryCandidates(date, sessionNum, handoffLayout, paths);
  if (handoffLayout === 'single') {
    writeFileSync(join(mainDir, candidates[0]), content);
    return candidates[0];
  }
  for (const rel of candidates) {
    try {
      writeFileSync(join(mainDir, rel), content, { flag: 'wx' }); // exclusive create
      return rel;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e; // a real IO error — surface it
      // else: a sibling already owns this name — try the next suffix
    }
  }
  throw new Error(
    `claim-plan: every session-entry candidate for ${date}-session-${sessionNum} (…-${sessionNum}.md … -z.md) ` +
      `is already taken — refusing to clobber. Resolve the pileup manually.`,
  );
}

// Heal an INDEX repath drift a claim's move-plan step can leave under parallel contention
// (plan 924). Thin planId-labelled wrapper over the generalised healIndexDrift (plan 926,
// promoted to build-index.mjs). Now LARGELY REDUNDANT — move-plan itself heals at the source
// for ALL its callers, so by the time projectClaim's step 2.5 runs this the INDEX is already
// consistent — but kept as a cheap, idempotent (no-op when clean) claim-path backstop. The
// `deps` seam (indexIsCurrent/coordWrite) is forwarded for claim-plan.test.
export function healIndexDriftAfterMove(mainDir, { planId, attempts = 5 } = {}, deps = {}) {
  return healIndexDrift(mainDir, { label: `plan ${planId}`, attempts }, deps);
}

// plan 1364 review R1 (F5, CONFIRMED): the reset-hard-and-reapply retry loop below was
// copy-pasted VERBATIM between projectClaim and projectBatchClaim (the projectBatchClaim
// comment even said "Copies its exact shape") — same ATTEMPTS/backoff schedule, same
// recoverable-error classification set. Two copies drift silently: a future fix to the
// recoverable-error set applied to one path and not the other leaves the other with stale
// retry behavior, with no test catching the divergence. Factored into ONE shared helper both
// projectors call with an `applyMutations` callback — behavior is byte-identical to before.
const CLAIM_PROJECTION_ATTEMPTS = 8;

// Run `applyMutations()` (git-mv/write/add/commit against the freshly-reset `cdir`) then push
// master; on a recoverable git race, reset the disposable tree --hard to the fresh origin tip
// and re-apply from scratch (no partial-state cleanup needed — the tree holds only discardable
// work). `onSuccess()` runs once the push lands and its return value becomes this function's
// return (the caller derives its own result from the same successful-attempt closure).
// `buildBlockedError(lastErr)` builds the caller-specific "blocked after N attempts" error once
// the retry budget is exhausted (a NORMAL, expected outcome under real contention, not a bug).
// `gitImpl` defaults to the real `git` (all three production callers use the default — none
// pass it); exported so claim-plan.test.mjs can drive the push-timeout branch directly with a
// fake `_git`-shaped function, since there was previously no injectable git seam reaching this
// loop at all (see the plan-4087-T4-A test's own header note on that gap).
export function runClaimProjectionRetryLoop(
  cdir,
  env,
  { applyMutations, onSuccess, buildBlockedError, gitImpl = git },
) {
  let lastErr;
  for (let attempt = 0; attempt < CLAIM_PROJECTION_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Re-freshen the disposable tree to the new origin tip and re-apply (no scoped rollback
      // needed — the tree holds only our discardable work; reset --hard heals any half-op).
      // plan 4087 T1/S7: bounded — the SAME primitive resolveCoordCheckout's own fetch/reset/clean
      // uses (coord-git.mjs's boundedGitWithLockRetry), not a second inline timeout+reap copy.
      // Wrapping only resolveCoordCheckout would leave THIS loop — up to CLAIM_PROJECTION_ATTEMPTS
      // (8) unbounded resets per acquire, the exact path the 2026-09-01/09-06 ledger incidents are
      // about — with no deadline at all.
      //
      // `_git: gitImpl` (default `git`, same default boundedGitWithLockRetry itself already
      // uses) so a test driving the push-timeout retry path through `gitImpl` also drives this
      // reset-and-reapply step — no separate real-git-repo fixture needed for that case.
      boundedGitWithLockRetry(cdir, ['fetch', '--quiet', 'origin', 'master'], {
        env,
        _git: gitImpl,
      });
      boundedGitWithLockRetry(cdir, ['reset', '--hard', 'origin/master'], { env, _git: gitImpl });
      boundedGitWithLockRetry(cdir, ['clean', '-fd'], { env, _git: gitImpl });
    }
    try {
      applyMutations();
      // plan 4136 E5 (finding 149q8uz): capped at COORD_PUSH_TIMEOUT_MS — this master push was
      // previously the last unbounded coord push in the file. Unlike the mirror/counter sites
      // above, a stuck projection push cannot simply be swallowed: it carries the whole
      // flip+move+board+session commit this attempt built, so a kill needs its own
      // "did it land" answer before the loop can decide whether to retry.
      try {
        boundedGit(cdir, ['push', 'origin', masterPushSpec(cdir, env, { _git: gitImpl })], {
          env,
          timeoutMs: COORD_PUSH_TIMEOUT_MS,
          _git: gitImpl,
        });
      } catch (pushErr) {
        if (pushErr?.code !== COORD_CHECKOUT_TIMEOUT) throw pushErr;
        // A killed push is ambiguous — the object may have landed on origin before the kill
        // reached this client (the same ambiguity verifyRemoteRef's plan-3554 note documents
        // for the claim-ref push). Ask origin what refs/heads/master is now and compare
        // against the commit this attempt tried to push.
        const localCommit = gitImpl(cdir, ['rev-parse', 'HEAD'], { env }).trim();
        let verification;
        try {
          verification = verifyRemoteRef(cdir, 'refs/heads/master', localCommit, { gitImpl });
        } catch {
          // The verification read itself failed too: fail closed by rethrowing the ORIGINAL
          // timeout, never the read failure — this is the one non-recoverable path below, so
          // the caller releases the claim rather than silently retrying into the unknown.
          throw pushErr;
        }
        if (verification.verdict !== 'ours') {
          // master is a SHARED, fast-moving ref: origin's tip not bit-for-bit equalling our
          // commit does NOT by itself mean our push failed to land — a sibling may have pushed
          // ON TOP of it in the gap between the kill and this read (unlike a claim ref, which
          // only this session's own retries ever move). Before concluding "not landed", ask
          // whether our commit is an ANCESTOR of whatever origin/master points at now.
          let landed = false;
          if (verification.sha) {
            try {
              boundedGitWithLockRetry(cdir, ['fetch', '--quiet', 'origin', 'master'], {
                env,
                _git: gitImpl,
              });
              gitImpl(cdir, ['merge-base', '--is-ancestor', localCommit, verification.sha], {
                env,
              });
              landed = true; // exit 0: our commit IS an ancestor of (or equal to) origin's tip
            } catch (ancestryErr) {
              if (ancestryErr?.status !== 1) {
                // Anything other than merge-base's own "not an ancestor" exit code (1) — the
                // fetch failed, or merge-base itself errored (e.g. a genuinely unknown object)
                // — is NOT an answer to "did it land". Fail closed on the ORIGINAL timeout,
                // never this check's own error, exactly like a failed verification read above.
                throw pushErr;
              }
              // exit 1: genuinely not an ancestor — not landed, handled below.
            }
          }
          if (!landed) {
            // Not landed (a foreign, non-descendant sha, or no master ref at all) —
            // recoverable exactly like a non-ff: let the next attempt's reset --hard +
            // re-apply retry it, with the same backoff any other recoverable push failure gets.
            lastErr = pushErr;
            sleepSync(backoffMs(attempt));
            continue;
          }
        }
        // Landed despite the timeout (verified 'ours', or our commit verified an ancestor of a
        // sibling's push on top of it) — treat this attempt as a success, no second push.
      }
      return onSuccess();
    } catch (e) {
      // Recoverable by the next attempt's reset --hard + re-apply: a non-ff (origin advanced), OR a
      // transient git race on this shared-.git Windows host — index.lock contention, the
      // index-write half-{move,land} (`bad source` / `nothing to commit` / `pathspec did not match`
      // that gitWithLockRetry's inner retry can't undo once the disk-rename/commit half-happened),
      // or a ref-lock CAS race. A genuine error (auth, hook, a real bug) is NOT in these classes and
      // surfaces immediately (the caller releases the ref).
      // plan 2426: a board-gate refusal is DETERMINISTIC — re-applying it against a fresher
      // origin tip would refuse identically, so it must never burn the retry budget (and
      // must never be mistaken for contention by the text-matching classification below).
      // Surface it immediately; the caller releases the claim ref.
      if (e instanceof BoardInvariantError) throw e;
      const out = errText(e);
      const recoverable =
        isNonFastForward(e) ||
        isMvBadSource(out) ||
        isNothingToCommit(out) ||
        isPathspecNoMatch(out) ||
        isTransientIndexWrite(out) ||
        isRefLockRace(out) ||
        LOCK_RX.test(out);
      if (!recoverable) throw e;
      lastErr = e;
      sleepSync(backoffMs(attempt));
    }
  }
  throw buildBlockedError(lastErr);
}

// plan 2394: given the board a takeover is about to write into, split the OTHER rows carrying
// this plan's id into the ones the takeover may retire itself and the ones it must leave alone.
//
// Why this exists at all: plan 2353's `--resume` computed the same stale-row set and merely
// PRINTED `board.mjs set-state <slug> PAUSED` for a human to run. The unattended callers
// `--resume` was built for (a cloud drain, an orchestrator worker, any scripted takeover) have
// no code path that reads stderr, so the dead holder's row stayed 🔄 ACTIVE forever — and two
// ACTIVE rows for one plan id is precisely the double-claim signal `/landing-queue`,
// board-pass and reconcile-board scan for.
//
// Why it is not a blanket "demote every same-id row" — a second row for one plan id is NOT
// always stale:
//   - BATCH MEMBER (plan 1364): a batch-claimed plan legitimately owns a row under its member
//     slug while the train runs under the batch slug. Demoting it would pause live work and
//     silently detach the member from a running train. This is the hazard plan 2394's
//     spec-pass ruled on, and the ruling is option 1: key the exemption on the `batch=` marker
//     `boardBatchPlanClaimCell` already stamps into the claim cell, NOT on a claim-ref read
//     (which would drag ref I/O into projectClaim, deliberately a pure content transform).
//   - MID-LAND (🟢 LANDING): that row is the cross-session land mutex `landingRows` probes.
//     Overwriting its state cell would drop the marker a sibling's overlapping-shard preflight
//     checks and let a conflicting 🟥 land start unseen — the same failure board.mjs's
//     set-state guard refuses to risk. A row in the merge window is by definition not a dead
//     holder's leftover.
// Both exemptions keep the pre-2394 behaviour for their rows (reported, demoted by hand), so
// every judgement call here fails toward doing LESS.
//
// plan 2512: the Lines-level core of classifyTakeoverRows below, taking an ALREADY-SPLIT
// board body line array — added so `applyMutations` (below) can classify against the SAME
// line array it then upserts/demotes into, instead of re-parsing board content classifyTakeoverRows
// (content-level) would otherwise re-split via rowsForPlanId's own splitBoard. Decision logic
// is byte-identical to pre-2512 classifyTakeoverRows; only the parsing INPUT changed (lines,
// not content) — see rowsForPlanIdLines vs rowsForPlanId for the sibling this mirrors.
// Pure: takes board body LINES, returns { demote: [slug], kept: [{slug, reason}] }, both sorted.
export function classifyTakeoverRowsLines(lines, { planId, slug }) {
  const demote = [];
  const kept = [];
  for (const row of rowsForPlanIdLines(lines, planId)) {
    if (row.slug === slug) continue; // our own row — upserted, not demoted
    if (isBatchMemberCell(row.planClaim)) {
      kept.push({ slug: row.slug, reason: 'batch-member' });
    } else if (row.state === LANDING_STATE) {
      kept.push({ slug: row.slug, reason: 'landing' });
    } else {
      demote.push(row.slug);
    }
  }
  demote.sort();
  kept.sort((a, b) => a.slug.localeCompare(b.slug));
  return { demote, kept };
}

// Content-level wrapper — thin fail-closed projection over classifyTakeoverRowsLines, mirroring
// board-lib's rowsForPlanId-over-rowsForPlanIdLines convention: an unparseable / sentinel-less
// board (splitBoard throws) yields { demote: [], kept: [] } rather than propagating, since a
// caller can't key a demotion on a board it can't parse anyway. The applyMutations call site
// below does NOT go through this wrapper (it already holds a split line array and calls
// classifyTakeoverRowsLines directly) — this remains the general-purpose content-level API.
export function classifyTakeoverRows(boardContent, { planId, slug }) {
  try {
    return classifyTakeoverRowsLines(splitBoard(boardContent).body.split('\n'), { planId, slug });
  } catch {
    return { demote: [], kept: [] };
  }
}

// The Resume-cell prose stamped onto a row this takeover demotes. Records WHY the row went
// ⏸ PAUSED and who superseded it (plan 2394 spec-pass sub-question: yes, preserve the lineage
// the plan-2353 pin cared about — the demotion must not erase the audit trail the printed
// note used to carry). No `|` can reach here: slugs are charset-validated
// (claim-plan-lib's assertSlugCharset) and `date` is an ISO day.
export function takeoverSupersededResume(slug, date) {
  return `superseded by \`${slug}\` (takeover ${date})`;
}

// Project a WON claim into the human-readable coordination docs as ONE atomic commit (plan 989):
// body Status flip + git mv ready|waiting → in-progress + INDEX regen + board ACTIVE row +
// session-entry stub, all staged and committed together in the DISPOSABLE coord-checkout, pushed
// once. There is no half-state — on a non-ff (or a transient git race) the disposable tree is reset
// --hard to the fresh tip and the whole set re-applied, so it either lands WHOLE or not at all. This
// replaced the pre-989 three-separate-pushes orchestration (move-plan → board.mjs → session entry),
// whose mid-way failure left an ORPHANED half-claim requiring manual `moved`-flag recovery (the
// dead `rollbackProjection` helper this comment used to point at — removed, plan 1313 F-009, as
// self-documented unreachable dead code). The refs/claims/<id> ref (acquired by doAcquire BEFORE
// this) is the cross-PC mutex; the coord-write lock serializes the disposable checkout.
// Returns the new in-progress rel path.
// plan 2353: `resume` enables the TAKEOVER projection — the plan is already in
// `in-progress/` (a dead holder's claim, released by the operator first), so the folder
// move must NOT happen while everything else must. Note the mv-skip is derived from where
// the file ACTUALLY resolves (`srcFolder === 'in-progress'`), not from the flag: the flag
// only widens RESOLUTION, so `--resume` on a plan that is genuinely still in ready/
// degrades to an ordinary fresh claim rather than silently skipping a move it needed.
// Returns { dstRel, resumed, demotedRowSlugs, keptRows } — the pre-2353 return was the bare
// dstRel string, which had no consumers (doAcquire discards it); plan 2353 added
// `staleRowSlugs` (rows for the caller to demote BY HAND), which plan 2394 replaced with the
// demoted/kept split below now that the demotion happens in the commit itself.
export function projectClaim(
  mainDir,
  {
    planId,
    slug,
    sessionNum,
    host,
    date,
    seedWrite,
    stubOk = null,
    blockedOk = null,
    resume = false,
    overrideBatchSolo = null,
    modelId,
    dispatchMode,
  },
) {
  const cfg = loadCoordConfig(mainDir);
  const env = { ...process.env, HUSKY: '0' };
  let resultRel;
  let resumed = false;
  // plan 2394: reassigned WHOLESALE (never appended to) on every applyMutations attempt — the
  // retry loop resets the disposable tree and replays the mutations against a freshened board,
  // so an accumulating array would report rows the final commit never touched.
  let demotedRowSlugs = [];
  let keptRows = [];
  // Normalized ONCE here so the board cell and the session stub can never read a
  // different modelId/dispatchMode pair for the same claim (plan 2460 Phase 2). Callers
  // that already normalized (doAcquire) pass through unchanged; a caller/test that
  // passes neither field still gets an explicit interactive/unlabeled arm.
  const provenance = normalizeExecutorProvenance({ modelId, dispatchMode });
  // plan 989: project the ENTIRE claim — body Status flip + git mv (ready|waiting → in-progress) +
  // INDEX regen + board ACTIVE row + session-entry stub — as ONE atomic commit in the DISPOSABLE
  // coord-checkout, pushed once. This replaces the old THREE-separate-pushes orchestration
  // (move-plan → board.mjs → session entry), whose mid-way failure left an ORPHANED half-claim — a
  // plan committed at in-progress/ with NO board row / claim ref (the 2026-06-22 pickup crash that
  // motivated this plan, and the entire `moved`-flag manual-recovery dance it forced — the dead
  // `rollbackProjection` helper that dance needed was removed as unreachable, plan 1313 F-009).
  // With a single commit there is no half-state: on a non-ff the disposable tree is reset --hard to
  // the fresh tip and the whole projection re-applied, so it either lands WHOLE or not at all. MAIN
  // is never touched, so a sibling's transient coord dirt — or a session's own uncommitted code
  // edit — can never block a claim (the foreign-dirt refusal class is gone here). The
  // refs/claims/<id> ref the caller acquired BEFORE this remains the cross-PC mutex.
  withCoordCheckout(mainDir, (cdir) => {
    // Resolve the plan's CURRENT path FRESH in the coord-checkout (ready/ or a waiting-*/ gate). The
    // REAL on-disk basename keeps the source casing — the board cell + git mv must use it verbatim
    // (the bare `--slug` can arrive lowercased and render a cell the board lint cannot match — the
    // plan-819 incident).
    const srcRel = activePathFor(cdir, planId, { includeInProgress: resume });
    const realBasename = srcRel.split('/').pop();
    const srcFolder = srcRel.slice(`${PLANS_PREFIX}/`.length).split('/')[0];
    const dstRel = `${PLANS_PREFIX}/${IN_PROGRESS_FOLDER}/${realBasename}`;
    // A takeover: the plan is ALREADY at dstRel, so there is no rename to stage.
    resumed = srcFolder === IN_PROGRESS_FOLDER;

    // Build + pre-validate the board "Plan / claim" cell BEFORE any mutation — a cell with no
    // lint-valid plan ref would poison the board, so reject the whole acquire cleanly here (the
    // caller releases the ref). The destination is in-progress/ by construction, so the cell's
    // subfolder can never drift.
    // plan 2328: surface a `priority: high` stamp on the board row's marker (⚡ prefix,
    // matching the INDEX bullet). Read fresh from the coord-checkout copy — the same
    // provenance the cell's other fields come from. plan 2520: routed through the ONE
    // shared tier reader — stays a `high`-only flag, byte-identical to before; a
    // `medium`/`low` stamp only feeds queue-drain's sort, never this board marker.
    const priority = isHighPriorityTier(readFileSync(join(cdir, srcRel), 'utf8'));
    const planClaimCell = boardPlanClaimCell({
      slug,
      planRef: `${IN_PROGRESS_FOLDER}/${realBasename}`,
      sessionNum,
      host,
      seedWrite,
      seedLane: cfg.seedLane,
      priority,
      modelId: provenance.modelId,
      dispatchMode: provenance.dispatchMode,
    });
    if (extractPlanRefs(planClaimCell).length === 0) {
      throw new Error(
        `claim-plan: refusing to project — the board "Plan / claim" cell carries no lint-valid plan ` +
          `ref (would poison the board). Cell: ${planClaimCell}`,
      );
    }

    // Deterministic session-entry path: a CAS-unique sessionNum means the first FREE candidate is
    // ours. The coord-checkout is freshly reset to origin/master, so a present candidate can only be
    // a sibling's already-landed entry — skip to the next suffix, never clobber.
    const candidates = sessionEntryCandidates(date, sessionNum, cfg.handoffLayout, cfg.paths);
    const entryRel = candidates.find((rel) => !existsSync(join(cdir, rel)));
    if (!entryRel) {
      // Preserve the plan-871 NO-CLOBBER invariant: never overwrite a sibling's landed entry. With a
      // CAS-unique sessionNum this is unreachable; if it ever fires, surface (the caller releases the
      // ref) rather than clobber the first candidate.
      throw new Error(
        `claim-plan: every session-entry candidate for ${date}-session-${sessionNum} is already ` +
          `taken — refusing to clobber. Resolve the pileup manually.`,
      );
    }
    const touched = `${date} ${new Date().toISOString().slice(11, 16)}`;
    const stub = sessionEntryStub({
      planId,
      slug,
      realBasename,
      sessionNum,
      host,
      date,
      seedWrite,
      seedLane: cfg.seedLane,
      modelId: provenance.modelId,
      dispatchMode: provenance.dispatchMode,
    });
    const boardRel = cfg.paths.boardFile;
    // plan 2459 Task 2: an --override-batch-solo claim gets a suffix naming the note in
    // the human-readable coord-doc commit message (the audit trail humans/board-passes
    // read) — the machine-parsed ref-CAS claim message itself (buildClaimMessage) stays
    // untouched, a 4-line lock contract this project() step never widens.
    const batchOverrideSuffix = overrideBatchSolo
      ? ` — OVERRIDE batch-solo: "${overrideBatchSolo}"`
      : '';
    const message =
      `chore(claim): project ${slug} (session ${sessionNum}) — flip+move+board+session` +
      `${batchOverrideSuffix} [ref-CAS ${planId}]`;

    // Apply ALL mutations to the disposable tree, then ONE commit by explicit pathspec. Follows
    // move-plan's rename discipline: NEVER `git add <srcRel>` (gone from disk after the mv → fatal
    // "pathspec did not match"); stage the WRITES and let `git commit -- srcRel dstRel …` re-derive
    // the rename's deletion side from the mv-staged index.
    const applyMutations = () => {
      // 1. flip Status, then git mv (carries the flipped body + stages the rename).
      //
      // plan 2426: the body transform and the board gate BOTH run before the first write,
      // against the freshly-reset coord-checkout. Order matters and is load-bearing:
      //   (a) flipStatusToInProgress drops a STALE Blocked-by line (blockedView),
      //   (b) the gate then judges what (a) produced, at the in-progress/ DESTINATION.
      // So a dead line is silently cleaned and only a genuinely LIVE one can refuse the
      // claim — which is the whole Q1/Q2 ruling in two statements. Running the gate here,
      // before any writeFileSync/git mv, means a refusal leaves the disposable tree exactly
      // as origin/master left it: no half-applied rename to compensate for.
      const corpus = loadCorpusView(cdir, [dstRel]);
      const flipped = flipStatusToInProgress(readFileSync(join(cdir, srcRel), 'utf8'), {
        host,
        slug,
        date,
        srcFolder,
        stubOk,
        blockedOk,
        overrideBatchSolo,
        blockedView: blockedViewFor(corpus, realBasename),
      });
      assertBoardInvariantsForPending(cdir, [{ path: dstRel, content: flipped }], {
        tool: 'claim-plan acquire',
        // The operator's explicit `--blocked-ok "<note>"` is the ONLY thing that waives the
        // live-Blocked-by refusal; the note itself is already recorded as an **Override:**
        // line in `flipped` above, so the claim carries its own audit trail.
        allowLiveBlockedBy: Boolean(blockedOk),
        // Hand the gate the corpus we just built: same `cdir`, same mutation, so rebuilding
        // it inside would re-shell `git ls-files` over the whole plan corpus for nothing —
        // and would open the door to the drop and the refusal judging DIFFERENT views.
        corpus,
      });
      writeFileSync(join(cdir, srcRel), flipped);
      // `git mv` does NOT create missing parent dirs — in-progress/ always exists in the real repo,
      // but a minimal origin (a test, or a never-yet-used in-progress/) may lack it.
      mkdirSync(dirname(join(cdir, dstRel)), { recursive: true });
      // plan 2353: on a resume srcRel IS dstRel — `git mv x x` fails ("can not move directory
      // into itself"/"destination exists"), and there is no rename to stage. The Status flip
      // written above is the whole file mutation; the `git add` below stages it.
      if (!resumed) gitWithLockRetry(cdir, ['mv', srcRel, dstRel], { env });
      // 2. INDEX — regenerated AFTER the mv is staged, so the bullet repaths to in-progress/.
      writeFileSync(join(cdir, INDEX_REL), regenerateIndex(cdir));
      // 3. board ACTIVE row (idempotent upsert against the freshened board).
      //
      // plan 2512: the board is split ONCE here (via withBody, below) and the SAME line array
      // is threaded through the classify + upsert + demote steps — pre-2512 this ran
      // classifyTakeoverRows (its own splitBoard, via rowsForPlanId) then upsertRow (its own
      // withBody split) then updateRows (a THIRD split, of upsertRow's already-reassembled
      // output) — up to CLAIM_PROJECTION_ATTEMPTS re-runs of that per acquire under contention.
      // Deliberately NOT hoisted above the retry loop: `boardPath` is re-read FRESH on every
      // attempt (the loop resets cdir --hard to the new origin tip before re-applying), so the
      // split has to stay inside applyMutations or it would replay stale lines.
      const boardPath = join(cdir, boardRel);
      const boardBefore = readFileSync(boardPath, 'utf8');
      let classified = { demote: [], kept: [] };
      const boardNext = withBody(boardBefore, (lines) => {
        // A takeover whose slug differs from the dead holder's leaves the ORIGINAL row behind:
        // the upsert is keyed on OUR slug, so the old row survives untouched. Plan 2353 stopped
        // there and printed a `board.mjs set-state <slug> PAUSED` hint; plan 2394 RETIRES those
        // rows here instead, inside this same atomic projection commit, because the unattended
        // callers `--resume` exists for never read that hint (see classifyTakeoverRowsLines
        // above for the full rationale and for the two row classes it deliberately spares).
        // Classify BEFORE the upsert mutates `lines` — it reads every OTHER row for this plan
        // id, and skips `slug`'s own row itself, so mutation order between the two is
        // immaterial, but matching the pre-2512 read-then-write order keeps the diff minimal.
        if (resumed) {
          classified = classifyTakeoverRowsLines(lines, { planId, slug });
        }
        upsertRowLines(lines, {
          slug,
          tip: '`PENDING`',
          state: '🔄 ACTIVE',
          planClaim: planClaimCell,
          touched,
          resume: '—',
        });
        if (classified.demote.length) {
          // Tolerant multi-row update (board-lib.updateRowsLines): the slugs come from the very
          // content being written, so absence is unreachable here — but a tolerant call keeps a
          // freshened-base replay from ever aborting a whole claim over one row a sibling
          // removed mid-retry. The claim cell is left ALONE: it still points at the plan, which
          // has not moved, and rewriting it would risk poisoning the row for lint-board.
          updateRowsLines(lines, classified.demote, {
            state: PAUSED_STATE,
            resume: takeoverSupersededResume(slug, date),
          });
        }
      });
      demotedRowSlugs = classified.demote;
      keptRows = classified.kept;
      writeFileSync(boardPath, boardNext);
      // 4. session-entry stub (its dir — docs/handoff/sessions/ — may be absent in a minimal origin).
      mkdirSync(dirname(join(cdir, entryRel)), { recursive: true });
      writeFileSync(join(cdir, entryRel), stub);
      gitWithLockRetry(cdir, ['add', '--', dstRel, INDEX_REL, boardRel, entryRel], { env });
      // plan 2353: on a resume srcRel === dstRel, so the pathspec would repeat it. Harmless to
      // git, but dedupe so the commit's pathspec reads honestly (and a future `--` consumer
      // can't double-count it).
      const commitPaths = [...new Set([srcRel, dstRel, INDEX_REL, boardRel, entryRel])];
      gitWithLockRetry(cdir, ['commit', '-m', message, '--', ...commitPaths], { env });
    };

    runClaimProjectionRetryLoop(cdir, env, {
      applyMutations,
      onSuccess: () => {
        resultRel = dstRel;
      },
      buildBlockedError: (lastErr) => {
        const err = new Error(
          `claim-plan: claim projection for ${planId} blocked after ${CLAIM_PROJECTION_ATTEMPTS} ` +
            `attempts — origin/master kept advancing. NORMAL transient contention; re-run the acquire.`,
        );
        err.cause = lastErr;
        return err;
      },
    });
  });
  return { dstRel: resultRel, resumed, demotedRowSlugs, keptRows };
}

// plan 1364 Ship 1: project a WON BATCH claim as ONE atomic commit — the batch analogue
// of projectClaim above. Shares its exact shape (one withCoordCheckout, build + PRE-
// VALIDATE every mutation BEFORE any mutation runs, one commit, the same 8-attempt
// reset-hard-and-reapply retry loop — factored into runClaimProjectionRetryLoop, plan 1364
// review R1 F5, so the two projectors can no longer drift apart on it) but fans the
// body-flip/git-mv/board-row step out over every member, while the INDEX regen +
// session-entry stub + batch manifest happen ONCE for the whole batch. Returns
// [{ planId, dstRel }] in the same order as `planIds`.
export function projectBatchClaim(
  mainDir,
  { planIds, slug, sessionNum, host, date, stubOk = null, blockedOk = null, modelId, dispatchMode },
) {
  const cfg = loadCoordConfig(mainDir);
  const env = { ...process.env, HUSKY: '0' };
  let resultMembers;
  // Same one-normalization-per-projection discipline as projectClaim above (plan 2460
  // Phase 2) — every member's board cell and the ONE batch session stub share this pair.
  const provenance = normalizeExecutorProvenance({ modelId, dispatchMode });
  withCoordCheckout(mainDir, (cdir) => {
    // Resolve + pre-validate EVERY member BEFORE any mutation — a single invalid board
    // cell aborts the WHOLE batch cleanly here (the caller releases every ref), exactly
    // like projectClaim's single-plan pre-validation.
    const memberInfos = planIds.map((planId) => {
      const srcRel = activePathFor(cdir, planId);
      const realBasename = srcRel.split('/').pop();
      const srcFolder = srcRel.slice(`${PLANS_PREFIX}/`.length).split('/')[0];
      const dstRel = `${PLANS_PREFIX}/${IN_PROGRESS_FOLDER}/${realBasename}`;
      const rowSlug = realBasename.replace(/\.md$/, '');
      const bodyForMarker = readFileSync(join(cdir, srcRel), 'utf8');
      const seedWrite =
        readSeedMarker(bodyForMarker, { seedLane: cfg.seedLane }) === '🟥' ? 'yes' : 'no';
      const planClaimCell = boardBatchPlanClaimCell({
        batchSlug: slug,
        slug: rowSlug,
        planRef: `${IN_PROGRESS_FOLDER}/${realBasename}`,
        sessionNum,
        host,
        seedWrite,
        seedLane: cfg.seedLane,
        // plan 2328: per-member ⚡ marker (a batch LAND is priority if ANY member is —
        // done-worktree's feed-through — but each board ROW shows its own plan's stamp).
        // plan 2520: routed through the ONE shared tier reader — `high`-only, unchanged.
        priority: isHighPriorityTier(bodyForMarker),
        modelId: provenance.modelId,
        dispatchMode: provenance.dispatchMode,
      });
      if (extractPlanRefs(planClaimCell).length === 0) {
        throw new Error(
          `claim-plan batch: refusing to project — the board "Plan / claim" cell for plan ${planId} ` +
            `carries no lint-valid plan ref (would poison the board). Cell: ${planClaimCell}`,
        );
      }
      return { planId, srcRel, realBasename, srcFolder, dstRel, rowSlug, planClaimCell, seedWrite };
    });

    // ONE session-entry stub for the whole batch — same first-FREE-candidate discipline
    // as the single-plan path (plan 871): resolved ONCE, before the retry loop, since a
    // CAS-unique sessionNum means the first free candidate is deterministically ours.
    const candidates = sessionEntryCandidates(date, sessionNum, cfg.handoffLayout, cfg.paths);
    const entryRel = candidates.find((rel) => !existsSync(join(cdir, rel)));
    if (!entryRel) {
      throw new Error(
        `claim-plan batch: every session-entry candidate for ${date}-session-${sessionNum} is ` +
          `already taken — refusing to clobber. Resolve the pileup manually.`,
      );
    }
    const touched = `${date} ${new Date().toISOString().slice(11, 16)}`;
    const stub = batchSessionEntryStub({
      members: memberInfos,
      slug,
      sessionNum,
      host,
      date,
      modelId: provenance.modelId,
      dispatchMode: provenance.dispatchMode,
    });
    const boardRel = cfg.paths.boardFile;
    // plan 1467: the manifest now lands in the batch FOLDER (was docs/handoff/batches/<slug>.json),
    // alongside batch.md. The folder's batch.md is STAMPED status: claimed (a pre-existing roster
    // entry) or CREATED at claim (an ad-hoc batch with no roster row) — replacing the old
    // "claiming session hand-deletes its proposed.md row" maintenance contract.
    const manifestRel = newManifestRel(slug);
    const batchMdRelPath = batchMdRel(slug);
    // Lane = 🟥 iff any member seed-writes (mirrors the per-member seedWrite banner) — only used
    // when synthesizing an ad-hoc batch.md; a pre-existing one already carries its lane.
    const adHocLane = memberInfos.some((m) => m.seedWrite === 'yes') ? '🟥' : '🟩';
    const manifestContent =
      JSON.stringify(
        {
          slug,
          sessionNum,
          host,
          created: new Date().toISOString(),
          members: planIds.map(String),
        },
        null,
        2,
      ) + '\n';
    const message =
      `chore(claim): project batch ${slug} (session ${sessionNum}) — ${planIds.length} members: ` +
      `${planIds.join(', ')} [ref-CAS batch]`;

    const applyMutations = () => {
      // Follows move-plan / projectClaim's rename discipline: NEVER `git add <srcRel>` — it
      // is gone from disk after the mv, so `git add` fatals "pathspec did not match" (the
      // 1364 review finding). `addPaths` only ever names paths that EXIST on disk (the mv
      // destination + plain writes); `commitPaths` additionally names every `srcRel` so the
      // final `git commit -- <pathspec>` re-derives each rename's deletion side from the
      // mv-staged index.
      const addPaths = [];
      const commitPaths = [];
      // plan 2426: flip + gate EVERY member before mutating ANY of them — the same
      // all-or-nothing discipline the pre-validation above already applies to board cells,
      // so one blocked member refuses the whole batch with nothing half-written. (Doing it
      // per-member inside the mutation loop would leave earlier members' renames staged
      // when a later one refused.) The corpus view is built once and shared: every member
      // is judged against the SAME post-mutation picture of the plan corpus.
      const corpus = loadCorpusView(
        cdir,
        memberInfos.map((m) => m.dstRel),
      );
      const flippedByPlan = new Map();
      for (const m of memberInfos) {
        const flipped = flipStatusToInProgress(readFileSync(join(cdir, m.srcRel), 'utf8'), {
          host,
          slug,
          date,
          srcFolder: m.srcFolder,
          stubOk,
          blockedOk,
          blockedView: blockedViewFor(corpus, m.realBasename),
        });
        assertBoardInvariantsForPending(cdir, [{ path: m.dstRel, content: flipped }], {
          tool: `claim-plan batch (member ${m.planId})`,
          allowLiveBlockedBy: Boolean(blockedOk),
          // ONE corpus for the whole batch — without this passthrough an N-member claim
          // would re-shell `git ls-files` over every tracked plan N+1 times.
          corpus,
        });
        flippedByPlan.set(m.planId, flipped);
      }
      for (const m of memberInfos) {
        // 1. flip Status, then git mv (carries the flipped body + stages the rename).
        writeFileSync(join(cdir, m.srcRel), flippedByPlan.get(m.planId));
        mkdirSync(dirname(join(cdir, m.dstRel)), { recursive: true });
        gitWithLockRetry(cdir, ['mv', m.srcRel, m.dstRel], { env });
        addPaths.push(m.dstRel);
        commitPaths.push(m.srcRel, m.dstRel);
      }
      // 2. INDEX — regenerated AFTER every member's mv is staged.
      writeFileSync(join(cdir, INDEX_REL), regenerateIndex(cdir));
      addPaths.push(INDEX_REL);
      commitPaths.push(INDEX_REL);
      // 3. board ACTIVE rows — one per member, each an idempotent upsert.
      const boardPath = join(cdir, boardRel);
      let boardContent = readFileSync(boardPath, 'utf8');
      for (const m of memberInfos) {
        boardContent = upsertRow(boardContent, {
          slug: m.rowSlug,
          tip: '`PENDING`',
          state: '🔄 ACTIVE',
          planClaim: m.planClaimCell,
          touched,
          resume: '—',
        });
      }
      writeFileSync(boardPath, boardContent);
      addPaths.push(boardRel);
      commitPaths.push(boardRel);
      // 4. ONE session-entry stub for the whole batch.
      mkdirSync(dirname(join(cdir, entryRel)), { recursive: true });
      writeFileSync(join(cdir, entryRel), stub);
      addPaths.push(entryRel);
      commitPaths.push(entryRel);
      // 5. the batch manifest (write-once — the manifest basename IS the batch slug, so
      // a re-run of this same batch would collide here rather than silently duplicate).
      mkdirSync(dirname(join(cdir, manifestRel)), { recursive: true });
      writeFileSync(join(cdir, manifestRel), manifestContent);
      addPaths.push(manifestRel);
      commitPaths.push(manifestRel);
      // 6. batch.md status: claimed (plan 1467). A pre-existing roster entry is STAMPED in place
      // (lane/members/theme preserved); an ad-hoc batch with no folder gets one synthesized. Read
      // fresh each retry-loop attempt (the loop reset-hards to origin/master before re-applying).
      const batchMdAbs = join(cdir, batchMdRelPath);
      const batchMd = existsSync(batchMdAbs)
        ? stampBatchStatus(readFileSync(batchMdAbs, 'utf8'), 'claimed')
        : renderBatchMd({
            slug,
            lane: adHocLane,
            members: planIds.map(String),
            gate: null,
            status: 'claimed',
            theme: `Ad-hoc batch (no pre-existing roster entry) — claimed session ${sessionNum}.`,
          });
      mkdirSync(dirname(batchMdAbs), { recursive: true });
      writeFileSync(batchMdAbs, batchMd);
      addPaths.push(batchMdRelPath);
      commitPaths.push(batchMdRelPath);

      gitWithLockRetry(cdir, ['add', '--', ...addPaths], { env });
      gitWithLockRetry(cdir, ['commit', '-m', message, '--', ...commitPaths], { env });
    };

    runClaimProjectionRetryLoop(cdir, env, {
      applyMutations,
      onSuccess: () => {
        resultMembers = memberInfos.map((m) => ({ planId: m.planId, dstRel: m.dstRel }));
      },
      buildBlockedError: (lastErr) => {
        const err = new Error(
          `claim-plan: batch projection for ${slug} blocked after ${CLAIM_PROJECTION_ATTEMPTS} ` +
            `attempts — origin/master kept advancing. NORMAL transient contention; re-run the batch acquire.`,
        );
        err.cause = lastErr;
        return err;
      },
    });
  });
  return resultMembers;
}

// --- CLI: acquire ------------------------------------------------------------

// Validate an operator-authorization note flag (`--stub-ok`, `--blocked-ok`). Both gates
// take the same shape — an explicit override is only an authorization if it carries a real
// note — and before plan 2426 the two checks were hand-written per flag per subcommand;
// adding `--blocked-ok` would have made that four copies of the same two `if`s.
//
// The flag-shaped guard is NOT paranoia (original review F3, still true under parseFlags,
// plan 1777 — its `value` flags deliberately consume the NEXT token unconditionally, the
// plan-1769 F1 semantics): `--stub-ok --seed-write yes` silently binds the note to
// "--seed-write" (non-empty, so a bare emptiness check accepts it) while swallowing
// --seed-write's own value. Returns the note unchanged so callers can assign through it.
function assertAuthorizationNote(value, { cmd, flag }) {
  if (value === undefined) return value;
  if (String(value).startsWith('-')) {
    throw new Error(
      `claim-plan ${cmd}: --${flag} requires a non-flag authorization note (got "${value}", ` +
        `which looks like it swallowed the following flag).`,
    );
  }
  if (!String(value).trim()) {
    throw new Error(
      `claim-plan ${cmd}: --${flag} "<authorization note>" must be a non-empty note.`,
    );
  }
  return value;
}

// plan 2891 T5 item (3): freshen `origin/master` ONCE per process, BEFORE the first
// `git rev-parse origin/master` any claim path pins its eligibility reads to.
//
// This RECONCILES with plan 2395's ratified pin-once design rather than reversing it (spec-pass
// ruling 2026-08-05). That design's no-fetch premise is exactly right for its motivating case —
// mainDir and every coord writer's coord-checkout are worktrees of the SAME shared `.git`, so a
// local sibling's push updates this ref the instant it lands — and the residual gap it names is
// pushes from a genuinely separate clone: the cloud drains, which claim from their own container
// against the same origin. Those DO need the round-trip, and a claim judged against a stale ref
// reads a plan's stage/blocked-by/execModel from before a sibling's coord push.
//
// The immutable-sha property is untouched, and that is what the memoization is for: the fetch
// runs strictly BEFORE the single up-front rev-parse and at most ONCE per process, so it can
// never move `origin/master` BETWEEN two of a claim's own reads — a second fetch mid-flow is
// precisely the skew plan 2395 closed. Best-effort by design: offline (and every unit test whose
// temp repo has no reachable remote) falls through to the local ref, which is the pre-2891
// behavior exactly — this only ever makes the pinned view NEWER, never staler.
// Keyed BY CHECKOUT, not a bare module-global flag (review round 1): `doAcquire`/`doAcquireBatch`
// are exported and can run more than once in a process, and a single global latch would let the
// FIRST checkout's fetch suppress the freshen for every other one — silently reinstating exactly
// the stale-ref judgement this closes. Once per (process, mainDir) is what the immutable-sha
// argument below actually requires.
const _originFreshened = new Set();
// Exported for its own unit test — the LATCH is the behaviour under test, and it lives here,
// not in the injectable `deps.freshenOrigin` seam the call sites take.
export function freshenOriginOnce(mainDir) {
  if (_originFreshened.has(mainDir)) return;
  try {
    git(mainDir, ['fetch', '--quiet', 'origin', 'master'], { env: HUSKY0 });
    // Latched only on SUCCESS (review round 2, CONFIRMED). Marking the checkout freshened
    // BEFORE the fetch meant one transient network failure suppressed every later refresh for
    // the life of the process — so a long-lived claimer would go on judging eligibility against
    // a ref that never got refreshed, which is precisely the staleness this exists to remove.
    // A failure simply leaves the latch open: the next claim tries again, and until one
    // succeeds every claim falls back to the local ref (the pre-2891 behaviour).
    _originFreshened.add(mainDir);
  } catch {
    /* offline / no remote — the local ref is the best available view; try again next claim */
  }
}

export function doAcquire(mainDir, idOrName, flags, deps = {}) {
  const mint = deps.mintSessionNumber || mintSessionNumber;
  const readH = deps.readHolder || readHolder;
  const planId = planIdOf(idOrName);
  const slug = flags.slug;
  if (!slug) throw new Error('claim-plan acquire: --slug <slug> is required');
  // plan 2353: takeover mode — resolve (and project) a plan already in `in-progress/`.
  // `--lock-only` is the mutually-exclusive opposite: it projects NOTHING, which is the
  // very footgun --resume exists to retire. Accepting both would silently honour
  // --lock-only and leave the operator believing they got a projection.
  const resume = flags.resume === true;
  if (resume && flags['lock-only'] === true) {
    throw new Error(
      'claim-plan acquire: --resume and --lock-only are mutually exclusive — --resume exists to ' +
        'PROJECT a takeover (board row + Status takeover note + session-entry stub), which is ' +
        'exactly what --lock-only skips.',
    );
  }
  // F-004 (plan 1313 coord audit): reject a slug outside the shared ASCII charset BEFORE it can
  // ever reach the worktree-teardown PowerShell `-like` kill command (an apostrophe breaks out
  // of the single-quoted context) or a filename. See assertSlugCharset's doc comment.
  assertSlugCharset(slug, 'slug');
  // plan 2891 T5 item (3): freshen origin ONCE, here — AFTER the cheap argument validation
  // above (a malformed invocation must not pay a network round-trip to be told so) and BEFORE
  // the first `origin/master` resolution below, which is the slug-prefix hint's own
  // activePathAtOrigin call.
  (deps.freshenOrigin || freshenOriginOnce)(mainDir);
  // plan 872: the slug MUST carry the resolved plan id as its leading `NNN-` prefix.
  // A bare / prefix-less slug (the plan-869 mistake — `akut-card-…` instead of
  // `869-UI-akut-card-…`) keys the board row, branch, and worktree on a string the
  // landing spine cannot derive a plan id from; done-worktree's releaseClaimAfterMerge
  // then crashed POST-merge at `planIdOf(slug)`, stranding the spine (claim ref held,
  // plan un-archived, board row + worktree orphaned). Reject at the SOURCE — before the
  // ref is even acquired — so the bad key is never written; point the caller at the
  // canonical prefixed basename (resolved from the live plan file, best-effort).
  if (!slug.startsWith(`${planId}-`)) {
    let canonical = `${planId}-<PX>-<desc>`;
    try {
      canonical = activePathAtOrigin(mainDir, planId, { includeInProgress: resume })
        .split('/')
        .pop()
        .replace(/\.md$/, '');
    } catch {
      /* plan file unresolved — keep the generic hint */
    }
    throw new Error(
      `claim-plan acquire: --slug "${slug}" must begin with the plan id "${planId}-". ` +
        `A prefix-less slug keys the board row / branch / worktree on a string the landing ` +
        `spine cannot resolve a plan id from (the plan-872 post-merge crash). ` +
        `Use --slug ${canonical}`,
    );
  }
  // plan 1427 Gate 2 (claim-time specReview gate): before acquiring any ref, refuse to
  // claim a stage:stub plan lacking a specReview sha/exempt-mechanical unless the
  // caller supplies --stub-ok "<authorization note>" (an explicit operator override —
  // the note must be non-empty, or it is not really an authorization). Resolution is
  // BEST-EFFORT: an unresolvable plan (a synthetic id in a unit test, or a genuine
  // "not found") falls through and lets the normal downstream resolution
  // (activePathFor inside projectClaim) surface its own error, exactly as before this
  // gate existed — this gate only ever ADDS a refusal, never suppresses one.
  const stubOk = assertAuthorizationNote(flags['stub-ok'], { cmd: 'acquire', flag: 'stub-ok' });
  // plan 2426 (operator ruling Q1): the override for claiming a plan that carries a LIVE
  // **Blocked-by:** line. Same validation as --stub-ok — an override with no note is not
  // really an authorization, and the note IS the audit trail for "I know it's blocked; I'm
  // working the part that isn't". Validated HERE, before any ref is acquired, so a typo'd
  // flag never burns a claim ref.
  const blockedOk = assertAuthorizationNote(flags['blocked-ok'], {
    cmd: 'acquire',
    flag: 'blocked-ok',
  });
  // plan 2459 Task 2: the explicit operator-directed override for the batch-hold guard
  // below. Routed through the SAME assertAuthorizationNote helper master extracted for
  // --stub-ok/--blocked-ok rather than re-hand-rolling the two checks (this branch predated
  // the extraction) — one validation shape for every authorization-note flag.
  const overrideBatchSolo = assertAuthorizationNote(flags['override-batch-solo'], {
    cmd: 'acquire',
    flag: 'override-batch-solo',
  });
  let gateContent = null;
  let gateSha = null;
  try {
    const resolved = resolvePlanAtOrigin(mainDir, planId, { includeInProgress: resume });
    gateContent = readAtOrigin(mainDir, resolved.sha, resolved.path);
    gateSha = resolved.sha;
  } catch {
    /* unresolved — NEITHER eligibility gate below can evaluate (both are `gateContent !== null`
       guarded); downstream resolution surfaces its own, accurate "cannot resolve" error */
  }
  if (gateContent !== null) {
    // plan 2502: pin the seedLane read to the SAME sha the plan body above resolved against —
    // loadCoordConfig(mainDir) alone would read mainDir's own possibly-stale coord.config.json,
    // reintroducing the fresh-plan/stale-config split plan 2395 closed for the plan file itself.
    const cfg = loadCoordConfigAtOrigin(mainDir, gateSha);
    const gate = checkStubClaimGate(gateContent, {
      stubOk: Boolean(stubOk),
      seedLane: cfg.seedLane,
      pipelineFields: cfg.land.specReviewGatedFields,
    });
    if (!gate.ok) throw new Error(`claim-plan acquire: ${gate.reason}`);
  }
  // plan 2459 Task 2 (leak B guard): refuse a solo claim on a member of a RUNNABLE batch
  // (status: proposed, gate: null) unless the operator explicitly overrides. Read at the
  // origin commit `gateSha` (plan 4246 review fix; never a ref-holding checkout — nothing has
  // been claimed yet), mirroring
  // checkStubClaimGate's placement: an eligibility gate BEFORE any ref is acquired.
  //
  // Gated on `gateContent !== null` for the SAME reason checkStubClaimGate above is (plan 2459
  // review): when the id resolves nowhere, the catch above deliberately leaves gateContent null
  // so DOWNSTREAM resolution can raise the accurate "cannot resolve" error. Running the batch
  // check unconditionally broke that: an ARCHIVED id still listed in a stale `proposed`/`gate:
  // null` roster (batch-coord-smalls / batch-coord-decouple-spine are in exactly that drift
  // today) got refused with "take the whole train via `claim-plan.mjs batch`" — an authoritative-
  // looking error naming two remedies that BOTH also fail, instead of "that plan does not exist".
  // Skipping the gate here cannot leak a claim: an unresolvable plan is refused downstream anyway.
  if (gateContent !== null) {
    // plan 2518 item 4: a TARGETED lookup that stops at the first batch holding this plan,
    // instead of building the whole membership map to answer about one id — and handed
    // straight to the gate, which takes the resolved slug (plan 2518 review).
    //
    // plan 4246: the SAME live-membership rule queue-drain applies (batch-paths.mjs's
    // batchLiveness): archived co-members are dropped, and a batch left with fewer than two
    // live members holds nothing — so the survivor of a train whose other car already landed
    // passes here without --override-batch-solo. The archive listing is a lazy NAME-ONLY list of
    // the configured archive lane (ARCHIVE_FOLDER, plan 3960) at `gateSha` — the SAME origin
    // commit resolvePlanAtOrigin just resolved this plan against (non-null whenever gateContent
    // is), so a co-member archived on origin but not yet pulled locally counts (review finding
    // 47956f). Read only if some runnable batch is actually walked. The batch.md ROSTER is read
    // at that same `gateSha` too (`at`, review finding b35525), so a stale local roster can never
    // be combined with the origin archive; a git fault there throws and refuses the claim rather
    // than guessing that the plan is unheld.
    const heldSlug = findRunnableBatchForPlan(join(mainDir, BATCHES_DIR_REL), planId, {
      at: { repoRoot: mainDir, ref: gateSha },
      archivedIds: () =>
        readArchivedPlanIds({
          repoRoot: mainDir,
          ref: gateSha,
          archiveRel: `${PLANS_PREFIX}/${ARCHIVE_FOLDER}`,
        }),
    });
    const batchGate = checkBatchSoloClaimGate(planId, heldSlug, {
      overrideNote: overrideBatchSolo,
    });
    if (!batchGate.ok) throw new Error(`claim-plan acquire: ${batchGate.reason}`);
  }
  // plan 1627: surface the plan's execModel in the result so the CLI can print the
  // thin-orchestrator doctrine block at the exact claim moment (the one deterministic
  // seat every claim passes through, regardless of which skill or session shape drove it).
  // execModel null means "no execModel key" (the normal case for non-fable plans);
  // frontmatterUnreadable distinguishes the rare "gate read itself failed" case so the
  // CLI can warn on THAT alone without crying wolf on every routine claim (review r2).
  // frontmatterUnreadable is ALSO set when the file opens a `---` fence but `stage:`
  // parses empty — a fenced plan always carries stage (plan 1292), so an empty parse
  // there means the fence/keys are malformed and execModel:null can't be trusted
  // (review r3: readable-but-unparseable frontmatter must not silently skip the block).
  const frontmatterUnreadable =
    gateContent === null ||
    (gateContent.startsWith('---') && !readFrontmatterScalar(gateContent, 'stage'));
  const execModel = gateContent
    ? readFrontmatterScalar(gateContent, 'execModel').toLowerCase() || null
    : null;
  const seedWrite = (flags['seed-write'] || 'no').toLowerCase();
  const host = flags.host || hostname();
  // plan 2844 review [6dd84a]/[d69c41]/[0c6427]: `'date' in flags`, never `flags.date || …`.
  // parseFlags SETS the key with an `undefined` value for a value flag that runs off the end of
  // argv, and stores `''` for `--date=` — so a `||` fallback silently swallows BOTH malformed
  // shapes into today's date, and Task 1's whole point (refuse a malformed --date rather than
  // guess) is bypassed by the one shape a typo actually produces. The `in` check is the parser's
  // own documented discriminator for absent-vs-present-but-valueless (see parse-flags.mjs).
  const date = 'date' in flags ? flags.date : new Date().toISOString().slice(0, 10);
  // plan 2844 Task 1: validate BEFORE the ref is even acquired (fail fast, nothing to roll
  // back) — a malformed --date must never reach sessionEntryCandidates.
  assertSessionEntryDate(date, { cmd: 'acquire' });
  // plan 2460 Phase 2: normalize the executor-provenance flags ONCE, before the ref is even
  // acquired — a typo'd --dispatch-mode throws here (fail fast) rather than after winning the
  // ref-CAS, which would otherwise need the same win-then-release-on-error dance as every
  // other post-acquire failure below.
  const { modelId, dispatchMode } = normalizeExecutorProvenance({
    modelId: flags['model-id'],
    dispatchMode: flags['dispatch-mode'],
  });
  // The shared resolver exposes a stable Claude/Codex owner (and refuses conflicting nested
  // hosts). Reading it lets `status` compute deterministic `youAreHolder`. randomUUID
  // stays as the fallback for headless/cron runs
  // where the harness id is absent (a unique-but-anonymous claim is still a valid lock).
  const sessionUuid = coordinationSessionId() || randomUUID();
  const iso = new Date().toISOString();

  const a = acquireRef(mainDir, {
    planId,
    message: buildClaimMessage({ planId, sessionUuid, host, iso }),
  });

  if (!a.won) {
    // A clean LOSS — not an error. Report the holder if we can read it, but a
    // failed holder-lookup (transient git, or the winner already released) must
    // NOT turn a clean loss into an error exit — it's still a loss.
    let holder = null;
    try {
      const h = readH(mainDir, planId);
      holder = h ? parseClaimMessage(h.body) : null;
    } catch {
      /* holder unknown — still a clean loss */
    }
    return { won: false, planId, holder };
  }

  let sessionNum;
  try {
    sessionNum = mint(mainDir);
  } catch (e) {
    // We hold refs/claims/<id> but can't complete the claim (counter unreachable /
    // contended past the retry bound). Release the just-won ref so the plan is not
    // left leaked-locked, then surface the failure (a retry then starts clean).
    try {
      releaseOwnClaimRef(mainDir, planId, a.sha);
    } catch {
      /* best-effort — reconcile-board surfaces a leak if this release also fails */
    }
    throw e;
  }
  // One base object so the lock-only and projected return shapes can never drift
  // (review r3 — this diff itself had to hand-add two fields to both literals).
  const resultBase = {
    won: true,
    planId,
    slug,
    sessionNum,
    claimSha: a.sha,
    execModel,
    frontmatterUnreadable,
    modelId,
    dispatchMode,
  };
  if (flags['lock-only'] === true) {
    // ref + session number won; projection deferred (used by tests / the dogfood).
    return { ...resultBase, projected: false };
  }
  const project = deps.projectClaim || projectClaim;
  let projection;
  try {
    projection = project(mainDir, {
      planId,
      slug,
      sessionNum,
      host,
      date,
      seedWrite,
      stubOk: stubOk || null,
      blockedOk: blockedOk || null,
      resume,
      overrideBatchSolo: overrideBatchSolo || null,
      modelId,
      dispatchMode,
    });
  } catch (e) {
    // We hold refs/claims/<id> but the projection (git mv / INDEX repath / board /
    // session entry) aborted partway, leaving the lock held with no visible claim.
    // Release the just-won ref — symmetry with the session-counter rollback above —
    // so a retry starts clean instead of fighting an orphaned lock.
    try {
      releaseOwnClaimRef(mainDir, planId, a.sha);
    } catch {
      /* best-effort — reconcile-board surfaces a leak if this release also fails */
    }
    throw e;
  }
  // Deliberately NOT defaulted: a `deps.projectClaim` test double that forgets the
  // { dstRel, resumed, demotedRowSlugs, keptRows } contract should blow up loudly here rather
  // than silently report `resumed:false` — a plausible-looking "fresh claim" result that would
  // mask exactly the contract plan 2353 introduced (review finding [4]) and plan 2394 widened.
  const { resumed, demotedRowSlugs, keptRows } = projection;
  return { ...resultBase, projected: true, resumed, demotedRowSlugs, keptRows };
}

// --- CLI: batch (plan 1364 Ship 1) --------------------------------------------

// Atomically-enough claim 2-8 plans into ONE batch: an eligibility gate (fail fast,
// before any ref is touched), then an all-or-release loop over the existing
// single-plan acquireRef (each id is an independent ref-CAS on refs/claims/<id>), ONE
// mintSessionNumber call for the whole batch, then ONE projectBatchClaim commit. A loss
// at any step releases every ref already won, so a retry always starts clean — the
// batch analogue of doAcquire's per-step rollback symmetry.
export function doAcquireBatch(mainDir, ids, flags, deps = {}) {
  const mint = deps.mintSessionNumber || mintSessionNumber;
  const acquire = deps.acquireRef || acquireRef;
  const readH = deps.readHolder || readHolder;
  const project = deps.projectBatchClaim || projectBatchClaim;

  const slug = flags.slug;
  if (!slug) throw new Error('claim-plan batch: --slug <batch-slug> is required');
  assertBatchSlug(slug);
  // F-004 (plan 1313 coord audit): the SAME injection surface applies to a batch worktree —
  // worktreePathFor(slug) / buildProcessKillCommand feed off this slug identically to a
  // single-plan claim.
  assertSlugCharset(slug, 'slug');

  const planIds = (ids || []).map((x) => planIdOf(x));
  const force = flags.force === true;
  const host = flags.host || hostname();
  // plan 2844 review: same `'date' in flags` discrimination as doAcquire above — a `||`
  // fallback here would let `--date=` / a trailing `--date` skip the batch path's validation too.
  const date = 'date' in flags ? flags.date : new Date().toISOString().slice(0, 10);
  // plan 2844 Task 1: same fail-fast validation as doAcquire above, at the batch's own
  // --date site — without it the batch path mints the same malformed session-entry names.
  assertSessionEntryDate(date, { cmd: 'batch' });
  // plan 1427 Gate 2: the ONLY thing that bypasses the batch stage:"specced"
  // requirement — --force keeps bypassing execModel/seed-write homogeneity but no
  // longer bypasses stage (see checkBatchEligibility's doc comment).
  const stubOk = assertAuthorizationNote(flags['stub-ok'], { cmd: 'batch', flag: 'stub-ok' });
  // plan 2426 (operator ruling Q1, applied UNIFORMLY to acquire AND batch). ONE note covers
  // the whole batch — a batch is one operator decision, and per-member notes would imply
  // the operator can approve half a train.
  const blockedOk = assertAuthorizationNote(flags['blocked-ok'], {
    cmd: 'batch',
    flag: 'blocked-ok',
  });
  // plan 2460 Phase 2: normalized ONCE, before any ref is touched — same fail-fast reasoning
  // as doAcquire's own normalization above.
  const { modelId, dispatchMode } = normalizeExecutorProvenance({
    modelId: flags['model-id'],
    dispatchMode: flags['dispatch-mode'],
  });

  // Eligibility gate BEFORE acquiring any ref — resolve + read every member's body, AND
  // coord.config.json's seedLane, at ONE shared `origin/master` sha (plan 2536; mirrors
  // doAcquire's single-plan Gate 2 fix, plans 2395 + 2502). Previously both reads came from
  // mainDir's own local working tree (activePathFor + readFileSync, loadCoordConfig(mainDir)),
  // never resolved/pinned against origin/master — a sibling coord-checkout push landing
  // mid-resolution could feed checkBatchEligibility a member's plan body from one moment and
  // coord.config.json's seedLane from another. Fixing only one side would INVERT the mismatch
  // (see the plan body's "Candidate fix" note), so both reads are pinned together, here, to the
  // SAME sha.
  // plan 2891 T5 item (3): same one-shot freshen as doAcquire, BEFORE this single pin — the
  // batch's whole eligibility judgement (every member's body AND coord.config.json) hangs off
  // this one sha, so it must be resolved from a ref this container has actually refreshed.
  (deps.freshenOrigin || freshenOriginOnce)(mainDir);
  const originSha = git(mainDir, ['rev-parse', 'origin/master']).trim();
  // plan 2561: one shared, cached listing function for the whole batch — every member is
  // resolved against the SAME originSha, so each claimableSearchFolders() folder only needs
  // listing once, not once per member.
  const memberListing = makeFolderListing(mainDir, { cache: new Map() });
  const members = planIds.map((id) => {
    const resolvedPath = resolveMemberPathAtOriginSha(mainDir, originSha, id, memberListing);
    // sonnet-review finding (2026-07-27): readAtOrigin (git show) can throw for a reason
    // unrelated to genuine unresolution (a transient git I/O hiccup) even after ls-tree found
    // a matching path — mirror doAcquire's single-plan Gate 2 (line ~1222-1229), which wraps
    // the equivalent resolve+read in try/catch so ONE member's transient failure degrades to
    // the same `{ path: null, content: null }` "unresolved" shape checkBatchEligibility already
    // reports on, instead of crashing doAcquireBatch and every OTHER, unaffected member's
    // resolution with it. Both fields are cleared together (not just `content`) to preserve the
    // function's own invariant (see its header comment): `path`/`content` are null IN LOCKSTEP,
    // never `path` truthy with `content` null — checkBatchEligibility's downstream frontmatter
    // read assumes that pairing and does not itself null-guard `content`.
    let path = null;
    let content = null;
    if (resolvedPath) {
      try {
        content = readAtOrigin(mainDir, originSha, resolvedPath);
        path = resolvedPath;
      } catch {
        /* unresolved — checkBatchEligibility's `path === null` handling reports it */
      }
    }
    return { id, path, content };
  });
  const cfg = loadCoordConfigAtOrigin(mainDir, originSha);
  const elig = checkBatchEligibility(members, {
    force,
    stubOk: Boolean(stubOk),
    seedLane: cfg.seedLane,
    pipelineFields: cfg.land.specReviewGatedFields,
  });
  if (!elig.ok) throw new Error(`claim-plan batch: ${elig.reason}`);

  // plan 2891 review round 2 (CONFIRMED): every release here is COMPARE-AND-SWAP, pinned with
  // --force-with-lease to the exact claim sha we are entitled to delete. A bare
  // `push origin :<ref>` deletes WHATEVER origin currently holds, so a claim released by some
  // other cleanup and RE-ACQUIRED by a rival in our window was silently clobbered — handing two
  // sessions the same plan, which is the one thing the claim ref exists to prevent.
  //
  // Deliberately NOT release-claim.mjs's `releaseClaim` (which draws the same lease): that module
  // imports `readHolder` from THIS one, so calling into it would close an import cycle. The lease
  // is one argument; the cycle would be structural.
  const releaseAll = (won) => {
    for (const w of won) {
      // `w.sha` is the claim commit our own acquire pushed — the only sha we may delete.
      releaseOwnClaimRef(mainDir, w.planId, w.sha);
    }
  };

  const sessionUuid = coordinationSessionId() || randomUUID();

  // plan 2891 T5 item (3), review round 1: the member we are MID-ACQUIRE on is not in `won` —
  // acquireRef reports a win only after its push call RETURNS, so a throw can still leave behind
  // a ref the remote already applied (a connection dropped after the server accepted the update
  // but before git could read the status). releaseAll above cannot know about that one.
  //
  // The ownership guard is what makes this safe: release it ONLY once the claim message on
  // origin proves it is OURS. Deleting a ref we cannot prove we own would silently steal a
  // RIVAL's live claim — far worse than the narrow leak this closes — so an unreadable,
  // unparseable or foreign-owned ref is left exactly where it is.
  const releaseIfOurs = (planId) => {
    try {
      const h = readH(mainDir, planId);
      const holder = h ? parseClaimMessage(h.body) : null;
      if (!holder || holder.sessionUuid !== sessionUuid) return;
      // The ownership READ above is not enough on its own (review round 2): a rival can acquire
      // in the read → delete window, so the delete is leased to the sha we actually inspected.
      releaseOwnClaimRef(mainDir, planId, h.sha);
    } catch {
      /* best-effort — reconcile-board surfaces a leak if this release also fails */
    }
  };

  const iso = new Date().toISOString();
  const won = [];
  for (const planId of planIds) {
    let a;
    // plan 2891 T5 item (3): a THROWN acquire (a transient network/ref-lock failure, not a
    // clean CAS loss) used to escape this loop with every EARLIER member's ref still held.
    // The batch claim is documented all-or-release, and every other failure arm below already
    // honours that — the mint and the projection both releaseAll before rethrowing. Only the
    // acquire loop itself, the one place refs are actually WON, was missing the guard, so the
    // failure that most plausibly interrupts a train mid-acquire (the network) was the one that
    // leaked. A leaked ref reads as 🔒 CLAIMED to every drain and needs a manual force-release.
    try {
      a = acquire(mainDir, {
        planId,
        message: buildClaimMessage({ planId, sessionUuid, host, iso }),
      });
    } catch (e) {
      releaseAll(won);
      releaseIfOurs(planId); // the in-flight member's own ref, if the remote already applied it
      throw e;
    }
    if (!a.won) {
      releaseAll(won);
      let holder = null;
      try {
        const h = readH(mainDir, planId);
        holder = h ? parseClaimMessage(h.body) : null;
      } catch {
        /* holder unknown — still a clean loss */
      }
      return { won: false, batch: true, lostOn: planId, holder };
    }
    won.push({ planId, sha: a.sha });
  }

  let sessionNum;
  try {
    sessionNum = mint(mainDir);
  } catch (e) {
    releaseAll(won);
    throw e;
  }

  if (flags['lock-only'] === true) {
    return {
      won: true,
      batch: true,
      slug,
      sessionNum,
      members: won.map((w) => ({ planId: w.planId, claimSha: w.sha, path: null })),
      projected: false,
      modelId,
      dispatchMode,
    };
  }

  let projected;
  try {
    projected = project(mainDir, {
      planIds,
      slug,
      sessionNum,
      host,
      date,
      stubOk: stubOk || null,
      blockedOk: blockedOk || null,
      modelId,
      dispatchMode,
    });
  } catch (e) {
    releaseAll(won);
    throw e;
  }
  const dstByPlan = new Map((projected || []).map((m) => [m.planId, m.dstRel]));
  return {
    won: true,
    batch: true,
    slug,
    sessionNum,
    members: won.map((w) => ({
      planId: w.planId,
      claimSha: w.sha,
      path: dstByPlan.get(w.planId) ?? null,
    })),
    projected: true,
    modelId,
    dispatchMode,
  };
}

// --- CLI: derail (plan 1478) --------------------------------------------------
//
// A batch member that DERAILS mid-train (its gates stay red past the one allowed fix — the
// batch-train step-6 judgment call) is abandoned: its commits are dropped, its plan file is
// re-parked (move-plan → waiting-*), and it must be REMOVED from the batch's coord state so the
// later `done-worktree <slug>` — which iterates the write-once manifest.members — never tries to
// land it. Before this op that removal was three-plus-a-gap manual steps (release-claim +
// board-row-remove, with NO manifest step) and the manifest kept LYING: done-worktree resolved
// the derailed member's LANDING board row from where its FILE sits, hit `board.mjs set-state
// <slug> LANDING` on a row that was already removed, crashed "row not found", and LOST its
// landing-queue slot (the live 2026-07-05 incident that motivated plan 1478).
//
// `derail <id>` is the single source-of-truth reconcile: it drops the id from its batch manifest's
// members AND removes its board row in ONE atomic projection commit (the manifest is the ground
// truth done-worktree reads — a member absent from it is simply never iterated), then releases the
// claim ref. It deliberately does NOT move the plan file: WHERE a derailed plan is parked
// (waiting-operator/ vs a re-spec) is the conductor's decision, made with `move-plan` as its own
// step — folding a hardcoded destination in here would presume it (and duplicate move-plan's
// git-mv/INDEX machinery this op has no need to touch).

// Every batch slug that currently has a manifest on disk (new folder layout OR the grandfathered
// legacy path). Enumerated from the two batch dirs; resolveManifestRel then picks the live path
// per slug (new-first/legacy-second) so this stays correct across plan 1467's migration.
function candidateBatchSlugs(cdir) {
  const slugs = new Set();
  const newDir = join(cdir, BATCHES_DIR_REL);
  if (existsSync(newDir)) {
    for (const e of readdirSync(newDir, { withFileTypes: true })) {
      // Exclude reserved subdirs (archive/) — same exclusion batches-view's loadBatchFolders uses,
      // so a landed batch archived under batches/archive/<slug>/ is never re-enumerated as live.
      if (e.isDirectory() && !RESERVED_BATCH_DIRS.has(e.name)) slugs.add(e.name);
    }
  }
  const legacyDir = join(cdir, LEGACY_BATCH_MANIFEST_DIR_REL);
  if (existsSync(legacyDir)) {
    for (const f of readdirSync(legacyDir)) {
      if (f.endsWith('.json')) slugs.add(f.replace(/\.json$/, ''));
    }
  }
  return [...slugs];
}

// Every batch manifest currently LISTING `planId` as a member. Normally 0 (already derailed /
// never batched) or exactly 1; >1 is manifest corruption (a plan belongs to at most one batch)
// and the caller refuses rather than guess. Returns [{ slug, rel, manifest }].
function findBatchManifestsForMember(cdir, planId) {
  const id = String(planId);
  const out = [];
  for (const slug of candidateBatchSlugs(cdir)) {
    const { rel } = resolveManifestRel(cdir, slug);
    if (!rel) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(cdir, rel), 'utf8'));
    } catch {
      continue; // a corrupt manifest is not this member's problem to fix — skip it
    }
    if (Array.isArray(manifest.members) && manifest.members.map(String).includes(id)) {
      out.push({ slug, rel, manifest });
    }
  }
  return out;
}

// The board ACTIVE row slug for a batch member = its plan BASENAME (claim-plan.mjs batch's
// `rowSlug`), stable across the git mv a mid-train re-park does. Resolve it from the plan file's
// CURRENT location (live status folder preferred, archive/ as a last resort), NOT from the id.
// null when no plan file resolves (the caller then skips the board step — a manifest-only drop).
function resolveRowSlugForMember(cdir, planId) {
  // Reuse the shared id→path index + basename resolver (done-worktree-lib) instead of a hand-rolled
  // scan — same live-preferred/archive-fallback + `.md`-stripped-basename semantics done-worktree's
  // close-out uses, so a derailed member's board-row slug can never be derived differently here.
  return rowSlugFromIndex(
    buildPlanIdIndex(git(cdir, ['ls-files', PLANS_PREFIX]), [planId]),
    planId,
  );
}

// Project a derail into the coord docs as ONE atomic commit in the disposable coord-checkout:
// drop the id from its batch manifest's members + remove its board row, pushed once (reusing
// projectClaim's exact reset-hard-and-reapply retry loop, so a non-ff / transient git race is
// re-applied from the fresh tip, never a half-write). Idempotent: a re-run after a prior
// successful derail finds the id in NO manifest, applies no mutation, and the loop's push is a
// harmless up-to-date. Returns { slug, manifestRel, rowSlug, removedRowSlugs, changed, dissolved }
// — rowSlug is the first row actually removed (else the basename-derived slug, for reporting);
// removedRowSlugs lists every row dropped (>1 only under a planId-keyed rename desync, plan 1801).
export function projectDerail(mainDir, { planId }) {
  const env = { ...process.env, HUSKY: '0' };
  const result = {
    slug: null,
    manifestRel: null,
    rowSlug: null,
    removedRowSlugs: [],
    changed: false,
    dissolved: false,
  };
  withCoordCheckout(mainDir, (cdir) => {
    const applyMutations = () => {
      // Re-resolve FRESH each attempt — the retry loop reset-hards the disposable tree to the
      // current origin/master before re-applying, so a sibling that advanced master (or even
      // derailed this same member first) is reflected here.
      const matches = findBatchManifestsForMember(cdir, planId);
      if (matches.length > 1) {
        throw new Error(
          `claim-plan derail: plan ${planId} is listed in ${matches.length} batch manifests ` +
            `(${matches.map((m) => m.slug).join(', ')}) — ambiguous. A plan belongs to at most one ` +
            `batch; reconcile the manifests by hand before derailing.`,
        );
      }
      if (matches.length === 0) {
        // Idempotent no-op: the member is absent from every manifest (a re-run after a prior
        // successful derail, or the plan was never batched). No projection; the loop's push is a
        // harmless up-to-date. doDerail still (idempotently) releases the claim ref afterwards.
        result.changed = false;
        return;
      }
      const { slug, rel, manifest } = matches[0];
      result.slug = slug;
      result.manifestRel = rel;
      const nextMembers = manifest.members.map(String).filter((m) => m !== String(planId));
      const addPaths = [];
      const commitPaths = [];
      let message;
      if (nextMembers.length === 0) {
        // Derailing the LAST surviving member DISSOLVES the batch. Writing a `members: []` manifest
        // would leave a permanently-stuck coord artifact with no land/close path anywhere in the
        // tooling. Instead DELETE the manifest (so landing-queue's manifestExists / pruneLandedBatches
        // reaps any queue slot, and no future `done-worktree <slug>` can hard-error on an empty
        // manifest) and, for a new-format batch, its batch.md so the folder drops out of the roster.
        // Unlike Fix 2's archive-on-LAND, a dissolved batch produced no land — nothing is preserved;
        // each derailed member's plan file is re-parked individually by the conductor's move-plan step.
        gitWithLockRetry(cdir, ['rm', '--', rel], { env });
        commitPaths.push(rel);
        const mdRel = batchMdRel(slug);
        if (existsSync(join(cdir, mdRel))) {
          gitWithLockRetry(cdir, ['rm', '--', mdRel], { env });
          commitPaths.push(mdRel);
        }
        result.dissolved = true;
        message =
          `chore(derail): drop ${planId} — DISSOLVES batch ${slug} (last surviving member) — ` +
          `manifest+folder removed [ref-CAS derail]`;
      } else {
        writeFileSync(
          join(cdir, rel),
          JSON.stringify({ ...manifest, members: nextMembers }, null, 2) + '\n',
        );
        addPaths.push(rel);
        commitPaths.push(rel);
        message = `chore(derail): drop ${planId} from batch ${slug} — manifest+board reconcile [ref-CAS derail]`;
      }
      // Remove the member's board ACTIVE row — keyed by the STABLE planId, not only the
      // slug freshly derived from the plan's CURRENT basename (plan 1801): a plan renamed
      // while claimed (the execModel Infra↔FABLE stamp) desyncs the row's claim-time slug
      // from the current basename, so a basename-only removal misses the row and orphans it
      // (the coord-spine9 1785 derail). Union both keys: planId-prefixed rows cover the
      // renamed case; the basename-derived slug covers legacy bare (id-less) row slugs.
      // Tolerant multi-remove: a conductor that already removed the row by hand (the
      // pre-derail batch-train step) makes this an idempotent no-op, not a crash.
      const currentSlug = resolveRowSlugForMember(cdir, planId);
      const boardRel = loadCoordConfig(cdir).paths.boardFile;
      const boardPath = join(cdir, boardRel);
      const boardContent = readFileSync(boardPath, 'utf8');
      // Fail-closed lines split (mirrors board-lib's rowSlugsForPlanId): an unparseable board
      // yields no planId keys, and removeRows below then throws loudly on the real content.
      let boardLines;
      try {
        boardLines = splitBoard(boardContent).body.split('\n');
      } catch {
        boardLines = [];
      }
      const rowKeys = rowKeysForPlan(boardLines, planId, currentSlug);
      result.rowSlug = currentSlug;
      if (rowKeys.length) {
        const { content: nextBoard, removed } = removeRows(boardContent, rowKeys);
        result.removedRowSlugs = removed;
        if (removed.length) {
          result.rowSlug = removed[0];
          writeFileSync(boardPath, nextBoard);
          addPaths.push(boardRel);
          commitPaths.push(boardRel);
        }
      }
      // In the dissolve path the manifest+batch.md deletions are already staged by `git rm`; only a
      // board modification (if any) needs `git add`. Skip an empty add so `git add --` never no-ops noisily.
      if (addPaths.length) gitWithLockRetry(cdir, ['add', '--', ...addPaths], { env });
      gitWithLockRetry(cdir, ['commit', '-m', message, '--', ...commitPaths], { env });
      result.changed = true;
    };
    runClaimProjectionRetryLoop(cdir, env, {
      applyMutations,
      onSuccess: () => {},
      buildBlockedError: (lastErr) => {
        const err = new Error(
          `claim-plan: derail projection for ${planId} blocked after ${CLAIM_PROJECTION_ATTEMPTS} ` +
            `attempts — origin/master kept advancing. NORMAL transient contention; re-run derail.`,
        );
        err.cause = lastErr;
        return err;
      },
    });
  });
  return result;
}

// Orchestrate a full derail: project the manifest+board reconcile (atomic), THEN release the
// claim ref — the manifest+board projection first (the durable doc-state change), then the
// cross-PC lock, mirroring done-worktree's releaseClaimAfterMerge ordering. The release is
// idempotent + best-effort (a leaked ref is healed by reconcile-board and must never fail the
// derail); non-force by default so a session that is NOT the claim owner can't clobber a re-
// acquired lock (the conductor that claimed the batch IS the owner, so its non-force release
// succeeds) — `--force` is the operator override. Deps are injectable for the unit tests.
export function doDerail(mainDir, idOrName, flags = {}, deps = {}) {
  // Resolve before projecting durable board/manifest changes, even for --force.
  const sessionUuid = coordinationSessionId();
  const planId = planIdOf(idOrName);
  const project = deps.projectDerail || projectDerail;
  const release = deps.releaseClaim || releaseClaim;
  const projection = project(mainDir, { planId });
  let released;
  try {
    released = release(mainDir, planId, { force: Boolean(flags.force), sessionUuid });
  } catch (e) {
    // A release failure must never fail the derail — the manifest+board reconcile already
    // landed (the crash-preventing part); a leaked ref is a reconcile-board concern.
    released = { released: false, reason: 'error', error: e.message };
  }
  return { planId, ...projection, released };
}

export async function main() {
  // plan 1777: the shared spec'd parser (coord-git parseFlags, plan 1769) replaces the
  // value-only parseArgs + its --lock-only/--force argv pre-strip. Both are real booleans
  // now, and an unknown flag throws loudly — a real safety property on THIS surface: a
  // typo'd `--seed-wrte yes` used to be silently swallowed, the claim defaulted to
  // seed-write no, and the LANDING mutex was mis-scoped. `--category` stays accepted
  // (advertised in the usage string) even though nothing reads it today.
  // `subcommand: true` semantics live in parse-flags.mjs's header; here it keeps
  // --lock-only/--force position-independent (`--force derail <id>` → cmd='derail').
  const { cmd, positionals, flags } = parseFlags(process.argv.slice(2), {
    label: 'claim-plan',
    subcommand: true,
    value: [
      'slug',
      'seed-write',
      'host',
      'date',
      'stub-ok',
      'blocked-ok',
      'category',
      'override-batch-solo',
      'model-id',
      'dispatch-mode',
    ],
    boolean: ['lock-only', 'force', 'resume'],
  });
  // `mint-session`: hand back the next race-safe global session number from the CAS counter,
  // so a non-pickup writer (an ad-hoc `handoff`) names its entry file without the
  // filesystem-max+1 TOCTOU that caused the 775b/777b collisions (plan 871).
  if (cmd === 'mint-session') {
    const n = mintSessionNumber(resolveMain());
    console.log(JSON.stringify({ sessionNum: n }));
    return 0;
  }
  // plan 958: read-only holder report. `youAreHolder` is the deterministic "am I the
  // session that holds this plan?" — no contention, never mutates the ref.
  if (cmd === 'status') {
    const id = positionals[0];
    if (!id) {
      console.error('claim-plan: status needs a plan id (use: status <id|basename>)');
      return 2;
    }
    const s = planStatus(resolveMain(), id);
    console.log(JSON.stringify(s));
    if (s.held && s.holder) {
      const age = s.holder.ageSec == null ? 'age unknown' : `${s.holder.ageSec}s ago`;
      console.error(
        `claim-plan: ${s.planId} is HELD by session ${s.holder.sessionUuid} (host ${s.holder.host}, ${age})${s.youAreHolder ? ' (that is YOU)' : ' (NOT you)'}`,
      );
    } else if (s.held) {
      console.error(
        `claim-plan: ${s.planId} is HELD, but the claim body is unparseable (holder unknown)`,
      );
    } else {
      console.error(`claim-plan: ${s.planId} is not held (ref free)`);
    }
    return 0;
  }
  // plan 1364 Ship 1: claim 2-8 plans into ONE batch (one worktree, one land).
  if (cmd === 'batch') {
    const mainDir = resolveMain();
    const result = doAcquireBatch(mainDir, positionals, flags);
    console.log(JSON.stringify(result));
    if (!result.won) {
      console.error(
        `claim-plan: batch LOST on ${result.lostOn}${result.holder ? ` (held by session ${result.holder.sessionUuid}, host ${result.holder.host}, ${result.holder.iso})` : ''} — every other member's ref was released.`,
      );
    } else {
      console.error(
        `claim-plan: WON batch ${result.slug} as session ${result.sessionNum} (${result.members.length} members: ${result.members.map((m) => m.planId).join(', ')})`,
      );
    }
    return 0;
  }
  // plan 1478: reconcile a mid-train derailed batch member — drop it from its batch manifest +
  // remove its board row (one atomic projection), then release its claim ref.
  if (cmd === 'derail') {
    const id = positionals[0];
    if (!id) {
      console.error('claim-plan: derail needs a plan id (use: derail <id|basename> [--force])');
      return 2;
    }
    const mainDir = resolveMain();
    const r = doDerail(mainDir, id, flags);
    console.log(JSON.stringify(r));
    if (r.changed) {
      console.error(
        `claim-plan: derailed ${r.planId} from batch ${r.slug} — ` +
          `${r.dissolved ? `DISSOLVED the batch (last member; manifest + folder removed)` : `dropped from manifest ${r.manifestRel}`}` +
          `${r.removedRowSlugs?.length ? ` + removed board row(s) ${r.removedRowSlugs.join(', ')}` : ''}; claim ref ${r.released?.released ? 'released' : `NOT released (${r.released?.reason})`}.`,
      );
    } else {
      console.error(
        `claim-plan: derail ${r.planId} — no batch manifest listed this member (already derailed, or never batched); ` +
          `claim ref ${r.released?.released ? 'released' : `left as-is (${r.released?.reason})`}.`,
      );
    }
    return 0;
  }
  if (cmd !== 'acquire') {
    console.error(
      `claim-plan: unknown command "${cmd}" (use: acquire <id|basename> --slug <slug> [--category C] [--seed-write yes|no] [--host H] [--lock-only] [--resume] [--stub-ok "<note>"] [--blocked-ok "<note>"] [--override-batch-solo "<note>"] [--model-id <id>] [--dispatch-mode ${DISPATCH_MODES.join('|')}] | batch <id1> <id2> [...] --slug <batch-slug> [--host H] [--force] [--stub-ok "<note>"] [--blocked-ok "<note>"] [--model-id <id>] [--dispatch-mode ${DISPATCH_MODES.join('|')}] | derail <id> [--force] | status <id> | mint-session)`,
    );
    return 2;
  }
  const mainDir = resolveMain();
  const result = doAcquire(mainDir, positionals[0], flags);
  console.log(JSON.stringify(result));
  if (!result.won) {
    console.error(
      `claim-plan: ${result.planId} is TAKEN${result.holder ? ` by session ${result.holder.sessionUuid} (host ${result.holder.host}, ${result.holder.iso})` : ''} — pick another plan.`,
    );
  } else {
    console.error(
      `claim-plan: WON ${result.planId} as session ${result.sessionNum} (claim ${result.claimSha.slice(0, 8)})${result.resumed ? ' — RESUMED an in-progress plan (takeover)' : ''}`,
    );
    // plan 2394: a takeover under a NEW slug retires the dead holder's row IN the projection
    // commit (two 🔄 ACTIVE rows for one plan reads as a double-claim to the next session
    // scanning the board, and the pre-2394 "demote it by hand" hint was unreadable to the
    // unattended callers --resume exists for). Report it as done — the row's own Resume cell
    // carries the same lineage. The plan file is NOT moved, so the old worktree still survives
    // its own teardown, exactly as the plan-2353 pin required.
    if (result.resumed && result.demotedRowSlugs?.length) {
      console.error(
        [
          '',
          `claim-plan: demoted ${result.demotedRowSlugs.length} superseded board row(s) for plan ` +
            `${result.planId} to ⏸ PAUSED in this claim commit:`,
          ...result.demotedRowSlugs.map((s) => `    ${s}`),
        ].join('\n'),
      );
    }
    // Rows a takeover must NOT retire blind: a live batch member (plan 1364 — demoting it
    // detaches it from a running train) and a row inside the merge window (🟢 LANDING is the
    // cross-session land mutex). These keep the pre-2394 behaviour: named, with the exact
    // command, for a human who can judge whether they are genuinely stale.
    if (result.resumed && result.keptRows?.length) {
      const why = {
        'batch-member':
          'live batch member (plan 1364) — demoting it would detach it from a running batch train',
        landing: '🟢 LANDING — that row IS the land mutex a sibling shard preflight reads',
      };
      console.error(
        [
          '',
          `claim-plan: NOTE - ${result.keptRows.length} other board row(s) for plan ${result.planId} ` +
            `were LEFT AS-IS (not safe to demote automatically):`,
          ...result.keptRows.map((r) => `    ${r.slug} — ${why[r.reason] || r.reason}`),
          '  If one is genuinely stale, confirm it is dead and demote it by hand:',
          ...result.keptRows.map((r) => `    node scripts/board.mjs set-state ${r.slug} PAUSED`),
        ].join('\n'),
      );
    }
    // plan 1627: an execModel:fable plan runs under the thin-orchestrator doctrine, and
    // nothing else in the execution path surfaces it (it lives in a batch-train reference
    // a plan-executing session never loads). The claim is the one deterministic moment
    // every pickup passes through — print the doctrine here, binding for what follows.
    // The block below is a CONDENSED COPY of thin-orchestrator.md § "Inline vs orchestrated"
    // + § Rules + § "Bug-fix burndown" + § "Self-yield contract" (plan 2694)
    // + § Common mistakes (model inheritance) — that file (see doctrinePath) is
    // the canonical source and carries a matching keep-in-sync note; edit BOTH together.
    //
    // plan 3341: gated on the resolver's `thinOrchestrator` flag rather than a bespoke
    // `=== 'fable'` check, because `sol` sets it too and needs its OWN short notice printed
    // alongside the doctrine (never a duplicate of the whole doctrine text — see the sol
    // branch below). resolveExecLane THROWS on an unrecognized execModel — deliberately,
    // elsewhere, to fail loud at a gate — but this print runs AFTER the claim already
    // succeeded, so a bad value here must degrade to "no notice" (same as the
    // frontmatterUnreadable branch below already treats "unknown" as legitimate), never
    // crash the claim's own success path.
    let execLane = null;
    try {
      execLane = resolveExecLane(result.execModel);
    } catch {
      // Unrecognized execModel: fall through — queue-drain.mjs's oracle is where a bad
      // value is REFUSED (site 1 of this same plan); claim-plan only ever prints about it.
    }
    if (execLane && execLane.thinOrchestrator) {
      // Resolve the doctrine pointer through the skills junction layer rather than a
      // hardcoded repo location — this script is synced byte-identical to sibling repos
      // and must print a pointer that resolves wherever it runs. Try the active config
      // dir first (CLAUDE_CONFIG_DIR — the operator runs several accounts, each
      // chaining its own skills/ junction), then ~/.claude, and VALIDATE with existsSync
      // so a missing/stale junction prints an honest fallback, never a dead path (review r2).
      const doctrineRel = ['skills', 'batch-train', 'references', 'thin-orchestrator.md'];
      const doctrinePath =
        configDirCandidates()
          .map((base) => join(base, ...doctrineRel))
          .find((p) => existsSync(p)) ||
        // Last resort when no junction resolves: the repo-relative form, which resolves
        // on any checkout of this repo (plan 4071 T1 — a hardcoded operator-machine
        // absolute path here could never resolve anywhere else this script is synced).
        // Canonical master moved INTO vetapp by plan 2468 (the sibling
        // Hobby\coord\skills\ tree no longer exists) — plan 2694 corrected this
        // pointer, which had gone stale and named a dead directory.
        'coord/skills/batch-train/references/thin-orchestrator.md';
      if (execLane.lane === 'fable') {
        console.error(
          [
            '',
            'claim-plan: execModel FABLE - the thin-orchestrator doctrine applies to this execution',
            '(heavy model decides, cheap subagents touch files):',
            '  Mode test: small judgment-dense plan (~1 day, one surface) -> work INLINE; real bulk',
            '  (multi-file sweeps, corpus passes, many independent workers) -> Sonnet workers do the bulk.',
            '  1. Never bulk-read or bulk-edit yourself - workers read/search/edit; you consume conclusions and decide.',
            '  2. Verify through gates (tests / build / review fan-out), never by reading worker diffs.',
            '  3. Write each decision into the plan body AS IT IS MADE (scripts/edit-plan.mjs) - the refined plan',
            '     is the durable artifact; the orchestrator context is disposable.',
            '  4. Three consecutive delegations needing no judgment call -> mis-routed: set execModel sonnet,',
            '     hand it back to the drain.',
            '  Bug-fix burndown: TRIAGE the failures into root-cause clusters FIRST (N failures are often 1',
            '  bug), then one scoped worker per cluster over DISJOINT write-sets - targeted test runs per',
            '  worker, exactly ONE queued full-suite verify at the end. Never fan out on a raw failure list.',
            '  Self-yield: every fix-loop dispatch declares a budget (default 20 min or 5 root-cause fixes,',
            '  whichever first) INSIDE the prompt text; on breach the worker commits WIP + leaves the tree',
            '  clean, returns a compact handoff, and STOPS - you verify its push reached origin (per the repo',
            '  push-retry rule, never an invented push shape), then dispatch a FRESH worker with that handoff.',
            '  A yield is a success, but cap the chain at 3 in a row, then park.',
            '  Pin `model` EXPLICITLY on every Task/Agent/Workflow dispatch (sonnet/haiku unless the task',
            '  genuinely needs more) - an unpinned dispatch inherits the session model, i.e. a Fable worker.',
            `  Full doctrine: ${doctrinePath}`,
          ].join('\n'),
        );
      } else if (execLane.lane === 'sol') {
        // plan 3341: the sol lane's OWN short notice — never a second copy of the fable
        // doctrine text above. It is the substitution note plus the two things unique to
        // sol (the operator ruling on WHO orchestrates, and the repeated-finding rework rule); everything
        // else in the doctrine (never bulk-read/edit, verify via gates, write decisions
        // into the plan body) is unchanged and not repeated here.
        console.error(
          [
            '',
            'claim-plan: execModel SOL - Sol (gpt-6-sol, via `codex exec`) writes the code; the',
            'Claude-side orchestrator is OPUS - this is an operator ruling, not a preference.',
            '  The thin-orchestrator doctrine above DOES apply, with ONE substitution: the cheap',
            '  workers that touch files are `codex exec` dispatches, not Sonnet subagents - the',
            '  orchestrator still never bulk-reads or bulk-edits itself, and still verifies through',
            '  gates rather than by reading diffs.',
            '  Proven dispatch shape: `codex exec -m gpt-6-sol -s workspace-write`, cwd = the',
            '  worktree, prompt = the plan body + the standard SCOPE - DO NOT EXCEED block. Scope-',
            '  check the returned diff yourself and revert anything out-of-bounds.',
            '  Review lane: /gpt-review (an explicit operator ruling - cross-vendor review diversity',
            '  is NOT required here).',
            '  Rework rule (operator ruling 2026-08-29, replacing the fixed 2-round cap): keep Sol',
            '  while a rework round shrinks or changes the finding set - no round limit. Only when',
            '  the SAME gate/review finding (same file, location, defect class) comes back unfixed',
            '  after two consecutive Sol rework rounds, finish THAT finding on the normal Claude',
            '  lane and RECORD the switch in the plan body naming the finding - the lane must',
            '  never block real work.',
            '  Unlike fable rule 4 above, "three consecutive delegations needing no judgment call" is',
            '  NOT a mis-route signal here - sol is opt-in by operator choice, not by judgment',
            "  density; the repeated-finding rework rule above is this lane's escape valve instead.",
            `  Full doctrine: ${doctrinePath}`,
          ].join('\n'),
        );
      }
    } else if (result.frontmatterUnreadable && result.projected) {
      // Fail VISIBLY, not open: the Gate-2 frontmatter read is best-effort (gateContent can
      // still come back null while the claim itself succeeds), so an unreadable frontmatter
      // must not silently skip the doctrine block above. This fires ONLY on a failed read —
      // a readable plan that simply has no execModel key (the normal non-fable case) prints
      // nothing (review r2: no crying wolf). Since plan 2395 resolves this read against
      // origin/master (not the main checkout's index), a "just moved/minted" plan no longer
      // hits this path — a genuine hit now means the read against origin/master itself
      // failed (a real git error, or a plan id that resolves nowhere).
      // plan 3341 review (finding d35b75): named the lanes off EXEC_LANE_TABLE's own
      // `thinOrchestrator` flag rather than hardcoding "fable" — this sentence must name
      // every lane the doctrine applies to, and a hardcoded list silently goes stale the
      // moment a lane's flag changes (exactly this message going stale is what happened
      // when `sol` was added but this wording wasn't updated to mention it).
      const thinOrchestratorLanes = Object.values(EXEC_LANE_TABLE)
        .filter((entry) => entry.thinOrchestrator)
        .map((entry) => entry.lane);
      console.error(
        'claim-plan: NOTE - the plan frontmatter could not be read from origin/master at gate ' +
          'time, so execModel is unknown. If the plan file says ' +
          `${thinOrchestratorLanes.map((l) => `\`execModel: ${l}\``).join(' or ')}, the ` +
          'thin-orchestrator doctrine applies - check the claimed plan body before starting work.',
      );
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error('claim-plan:', e.message);
      process.exit(2);
    },
  );
}
