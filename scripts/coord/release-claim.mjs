#!/usr/bin/env node
// scripts/release-claim.mjs — free a refs/claims/<id> lock on land or abandon (plan 368).
//
// Deleting the claim ref (`git push origin :refs/claims/<id>`) is the release. Called
// by done-worktree after a successful master merge, and by a session abandoning a
// claim. Owner-checked (the claim commit records the claimant's session uuid) so one
// session can't free another's lock — unless --force. Idempotent and exit-0 on every
// path: a close-out must NEVER be blocked by a release (a leaked ref is healed by
// reconcile-board, the same "best-effort teardown" posture as landing-lock release).

import { pathToFileURL } from 'node:url';
import { hostname } from 'node:os';
import { git, resolveMain, isStaleInfo, isNonFastForward } from './coord-git.mjs';
import { refForPlan, planIdOf, parseClaimMessage } from './claim-plan-lib.mjs';
import { buildTombstoneMessage, releaseStrategyFor } from './coord-refs.mjs';
import { readHolder } from './claim-plan.mjs';
import { coordinationSessionId } from './coord-session-id.mjs';

const HUSKY0 = { ...process.env, HUSKY: '0' };

// Pure: may this release proceed? Owner = our session uuid matches the holder's, or
// --force. An unheld plan is a no-op; a foreign-held one is refused (without --force).
export function releaseDecision({ holder, sessionUuid, force = false }) {
  if (!holder) return { delete: false, reason: 'unheld' };
  if (force) return { delete: true, reason: 'forced' };
  if (sessionUuid && holder.sessionUuid === sessionUuid) return { delete: true, reason: 'owner' };
  return { delete: false, reason: 'foreign' };
}

// plan 3756: the branch-shaped release — append a `claim RELEASED plan=<id>` tombstone whose
// PARENT is the claim commit we just read.
//
// The lease survives the change of shape. A fast-forward push is accepted only while origin
// still points at the sha we read, so a claim re-acquired in the read→release window moves the
// tip, our push is rejected non-fast-forward, and we report 'raced' instead of clobbering the
// new holder — precisely what `--force-with-lease` bought the delete (F-014, plan 1313).
//
// Best-effort like every other path here: a close-out must never be blocked by a release.
function releaseByTombstone(mainDir, { planId, ref, holderSha, holder, reason }) {
  try {
    const tree = git(mainDir, ['mktree'], { input: '' }).trim();
    const msg = buildTombstoneMessage({
      planId: planIdOf(planId),
      sessionUuid: process.env.CLAUDE_CODE_SESSION_ID || 'unknown',
      host: hostname(),
      iso: new Date().toISOString(),
      reason,
    });
    const tomb = git(mainDir, ['commit-tree', tree, '-p', holderSha, '-m', msg]).trim();
    git(mainDir, ['push', 'origin', `${tomb}:${ref}`], { env: HUSKY0 });
    return { released: true, reason, holder };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    if (isNonFastForward(e) || /non-fast-forward|fetch first|\[rejected\]/i.test(out)) {
      // The tip moved under us. Re-read rather than guessing from the rejection text: a
      // sibling that already released it means our goal state holds, while a genuine
      // re-acquire must be reported as RACED and never folded into "released".
      const fresh = readHolder(mainDir, planId);
      if (!fresh) return { released: true, reason: 'already-gone', holder };
      return { released: false, reason: 'raced', holder: parseClaimMessage(fresh.body) };
    }
    throw e;
  }
}

// Delete refs/claims/<id> on origin iff we own it (or --force). Never throws on the
// happy / idempotent paths. `_readHolder` is a test seam (real `readHolder` by default) so the
// F-014 read→delete race can be exercised deterministically.
export function releaseClaim(
  mainDir,
  planId,
  // Must match the shared identity that `acquire` STORES (claim-plan.mjs), or self-release
  // reads an undefined sessionUuid, mismatches the stored holder, and refuses as 'foreign'.
  {
    force = false,
    // Resolve even for --force: ambiguity must be explicit before ownership mutation.
    sessionUuid = coordinationSessionId(),
    _readHolder = readHolder,
  } = {},
) {
  const h = _readHolder(mainDir, planId);
  const holder = h ? parseClaimMessage(h.body) : null;
  const d = releaseDecision({ holder, sessionUuid, force });
  if (!d.delete) return { released: false, reason: d.reason, holder };
  // plan 3756: release the ref that ANSWERED, in the way that ref expects — never the
  // namespace this build happens to write to. A session that claimed before the flip holds
  // `refs/claims/<id>` and releases it by delete; a post-flip claim is a branch-shaped ref
  // that must be tombstoned, because the proxy 403s deletes. Getting this backwards would
  // leave a legacy ref standing forever (a tombstone there reads as held to every pre-flip
  // reader) or try a delete the sandbox cannot perform.
  const ref = h.ref ?? refForPlan(planId);
  if (releaseStrategyFor(ref) === 'tombstone') {
    return releaseByTombstone(mainDir, { planId, ref, holderSha: h.sha, holder, reason: d.reason });
  }
  try {
    // F-014 (plan 1313 coord audit): pin the delete to the SHA `_readHolder` just observed via
    // --force-with-lease — the pre-fix bare `push origin :<ref>` deletes WHATEVER is currently on
    // origin with no compare-and-swap, so a claim re-acquired by another session in the
    // read(above)→delete(here) window is silently clobbered. The realistic trigger is
    // reconcile-board's advisory `--force` suggestion: an operator runs it after eyeballing a
    // stale claim, and that observe→operator-runs gap is human-scale — wide enough for a genuine
    // re-acquire to land in it. `h` is guaranteed non-null here: `releaseDecision` only returns
    // `delete:true` when `holder` (and therefore `h`) is truthy.
    git(mainDir, ['push', `--force-with-lease=${ref}:${h.sha}`, 'origin', `:${ref}`], {
      env: HUSKY0,
    });
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    // The ref vanished between our read and our delete (a sibling released it) →
    // the desired end-state (unheld) holds, so treat as released.
    if (/remote ref does not exist|does not exist|deletion of/i.test(out)) {
      return { released: true, reason: 'already-gone', holder };
    }
    if (isStaleInfo(e)) {
      // The lease refused the delete: origin's refs/claims/<id> no longer matches the sha we
      // read — either a sibling already released it (our goal state already holds) or, the case
      // this CAS exists to catch, a NEW claim landed in the read→delete window. Re-read rather
      // than guessing from the rejection text, so a re-acquired live claim is reported as RACED
      // (not released) instead of silently believed gone.
      const fresh = _readHolder(mainDir, planId);
      if (!fresh) return { released: true, reason: 'already-gone', holder };
      return { released: false, reason: 'raced', holder: parseClaimMessage(fresh.body) };
    }
    throw e;
  }
  return { released: true, reason: d.reason, holder };
}

export function main() {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'release') {
    console.error('usage: release-claim.mjs release <id|basename> [--force]');
    return 2;
  }
  const force = argv.includes('--force');
  const idArg = argv.slice(1).find((a) => !a.startsWith('--'));
  if (!idArg) {
    console.error('release-claim: release needs an <id>');
    return 2;
  }
  const mainDir = resolveMain();
  let r;
  try {
    r = releaseClaim(mainDir, planIdOf(idArg), { force });
  } catch (e) {
    // Even a real push failure must not block the caller's close-out — surface + exit 0.
    console.error(`release-claim: ${idArg} release failed (non-blocking): ${e.message}`);
    return 0;
  }
  console.log(JSON.stringify(r));
  if (!r.released && r.reason === 'foreign') {
    console.error(
      `release-claim: NOT releasing ${idArg} — held by session ${r.holder?.sessionUuid} (use --force to override).`,
    );
  } else if (!r.released && r.reason === 'raced') {
    // F-014 CAS refused the delete: a NEW claim landed in the read→delete window, so the ref
    // was NOT deleted and the live claim is intact. Surface this as loudly as 'foreign' — an
    // operator following reconcile-board's `--force` suggestion for a "dead" orphan must not
    // read the exit-0 JSON as a successful release and go run destructive cleanup (re-claim /
    // worktree teardown) against what is now a live plan held by session ${r.holder?.sessionUuid}.
    console.error(
      `release-claim: NOT releasing ${idArg} — a NEW claim was acquired by session ${r.holder?.sessionUuid} ` +
        `in the read→delete window (force-with-lease refused; the live claim is intact). ` +
        `Re-check the holder before any destructive cleanup.`,
    );
  }
  return 0; // close-out must never be blocked by a release
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    console.error('release-claim:', e.message);
    process.exit(0);
  }
}
