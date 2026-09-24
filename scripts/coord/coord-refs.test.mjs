// scripts/coord-refs.test.mjs — plan 3756. Pure name/predicate module: no git, no
// temp origin, no filesystem. Every case here is a string in and a string or boolean
// out, which is exactly why the namespace authority was split out of claim-plan-lib in
// the first place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COORD_PREFIX,
  LEGACY_COORD_PREFIX,
  CLAIM_PREFIX,
  LEGACY_CLAIM_PREFIX,
  CLAIM_GLOBS,
  PROBE_PREFIX,
  PROBE_GLOB,
  isProbeRef,
  claimRef,
  legacyClaimRef,
  claimRefCandidates,
  coordRef,
  legacyCoordRef,
  coordRefCandidates,
  planIdFromClaimRef,
  isCoordRef,
  isLegacyCoordRef,
  isCoordBranch,
  buildTombstoneMessage,
  isTombstoneMessage,
  claimIsHeld,
  releaseStrategyFor,
  parseClaimLsRemote,
} from './coord-refs.mjs';
import { buildClaimMessage, parseClaimMessage } from './claim-plan-lib.mjs';

// --- the namespace choice itself ------------------------------------------------

test('the live claim namespace is branch-shaped — that is the whole point of plan 3756', () => {
  // The proxy passes refs/heads/* and 403s everything else. If this assertion ever
  // fails, the fix this plan shipped has been undone.
  assert.ok(CLAIM_PREFIX.startsWith('refs/heads/'));
  assert.equal(claimRef('3756'), 'refs/heads/coord/claims/3756');
  assert.equal(coordRef('session-counter'), 'refs/heads/coord/session-counter');
});

test('claimRef accepts a bare id or a full plan basename', () => {
  assert.equal(claimRef('365'), `${CLAIM_PREFIX}365`);
  assert.equal(claimRef('365-UI-mobile-nav.md'), `${CLAIM_PREFIX}365`);
  assert.equal(claimRef(1000), `${CLAIM_PREFIX}1000`);
  assert.throws(() => claimRef('UI-no-id'), /cannot derive a plan id/);
});

test('legacy names are still constructible — the dual-read window needs them', () => {
  assert.equal(legacyClaimRef('3756'), 'refs/claims/3756');
  assert.equal(legacyCoordRef('session-counter'), 'refs/coord/session-counter');
  assert.deepEqual(claimRefCandidates('3756'), [
    'refs/heads/coord/claims/3756',
    'refs/claims/3756',
  ]);
  assert.deepEqual(coordRefCandidates('spec-sweep-lock'), [
    'refs/heads/coord/spec-sweep-lock',
    'refs/coord/spec-sweep-lock',
  ]);
});

test('candidate order is new-namespace-first, and the globs match it', () => {
  assert.equal(claimRefCandidates('900')[0], claimRef('900'));
  assert.deepEqual([...CLAIM_GLOBS], [`${CLAIM_PREFIX}*`, `${LEGACY_CLAIM_PREFIX}*`]);
});

test('coordRef rejects an empty name and tolerates stray slashes', () => {
  assert.equal(coordRef('/queue-heartbeat/'), `${COORD_PREFIX}queue-heartbeat`);
  assert.throws(() => coordRef(''), /non-empty name/);
  assert.throws(() => coordRef('///'), /non-empty name/);
});

// --- the probe namespace (plan 3812) ---------------------------------------------

test('the probe namespace lives under COORD_PREFIX, separate from CLAIM_PREFIX', () => {
  // Separate from claims on purpose: a probe ref carries no claim state and no
  // tombstone, so it must never be swept by claim-specific logic (gcReleasedClaimRefs)
  // or misread by anything that asks "is this claim held?".
  assert.equal(PROBE_PREFIX, `${COORD_PREFIX}probes/`);
  assert.equal(PROBE_GLOB, `${COORD_PREFIX}probes/*`);
  assert.ok(!PROBE_PREFIX.startsWith(CLAIM_PREFIX));
  assert.ok(!CLAIM_PREFIX.startsWith(PROBE_PREFIX));
});

test('isProbeRef recognises only the probe namespace', () => {
  assert.ok(isProbeRef('refs/heads/coord/probes/zzz-abc123'));
  assert.equal(isProbeRef('refs/heads/coord/claims/3756'), false);
  assert.equal(isProbeRef('refs/heads/coord/session-counter'), false);
  assert.equal(isProbeRef('refs/heads/master'), false);
  assert.equal(isProbeRef(null), false);
});

test('a probe ref still counts as isCoordRef, so its push skips the gate battery', () => {
  assert.ok(isCoordRef('refs/heads/coord/probes/zzz-abc123'));
});

// --- classification -------------------------------------------------------------

test('planIdFromClaimRef reads BOTH namespaces and canonicalises leading zeros', () => {
  assert.equal(planIdFromClaimRef('refs/heads/coord/claims/3756'), '3756');
  assert.equal(planIdFromClaimRef('refs/claims/3756'), '3756');
  // reconcile-drain-markers.mjs used to strip these itself; the rule lives here now.
  assert.equal(planIdFromClaimRef('refs/claims/0365'), '365');
  assert.equal(planIdFromClaimRef('refs/heads/coord/claims/0365'), '365');
});

test('planIdFromClaimRef returns null for anything that is not a claim ref', () => {
  assert.equal(planIdFromClaimRef('refs/heads/master'), null);
  assert.equal(planIdFromClaimRef('refs/heads/coord/session-counter'), null);
  assert.equal(planIdFromClaimRef('refs/coord/session-counter'), null);
  // A sub-3-digit or non-numeric leaf is not a plan id.
  assert.equal(planIdFromClaimRef('refs/heads/coord/claims/zzz-probe'), null);
  assert.equal(planIdFromClaimRef('refs/claims/12'), null);
  assert.equal(planIdFromClaimRef(null), null);
});

test('isCoordRef covers every namespace whose push must SKIP the gate battery', () => {
  // Miss any of these and a claim acquire runs the full push-gate battery.
  assert.ok(isCoordRef('refs/heads/coord/claims/3756'));
  assert.ok(isCoordRef('refs/heads/coord/session-counter'));
  assert.ok(isCoordRef('refs/claims/3756'));
  assert.ok(isCoordRef('refs/coord/session-counter'));
});

test('isCoordRef does NOT exempt ordinary branches — including a coord-ish prefix', () => {
  assert.equal(isCoordRef('refs/heads/master'), false);
  assert.equal(isCoordRef('refs/heads/worktree-3756-FABLE-Coord-claim-cas'), false);
  // The boundary that matters: "coordination" is not "coord/".
  assert.equal(isCoordRef('refs/heads/coordination-rewrite'), false);
  assert.equal(isCoordRef('refs/heads/coord'), false);
});

test('isLegacyCoordRef separates the pre-3756 namespaces from the new one', () => {
  assert.ok(isLegacyCoordRef('refs/claims/3756'));
  assert.ok(isLegacyCoordRef('refs/coord/session-counter'));
  assert.equal(isLegacyCoordRef('refs/heads/coord/claims/3756'), false);
  assert.equal(isLegacyCoordRef('refs/heads/master'), false);
});

test('isCoordBranch lets branch-hygiene sweeps skip claim refs BY PREFIX', () => {
  // The spec-pass asked this be confirmed rather than left to a hand-kept name list.
  assert.ok(isCoordBranch('coord/claims/3756'));
  assert.ok(isCoordBranch('origin/coord/claims/3756'));
  assert.ok(isCoordBranch('coord'));
  assert.equal(isCoordBranch('master'), false);
  assert.equal(isCoordBranch('worktree-3756-FABLE-Coord-claim-cas'), false);
  assert.equal(isCoordBranch('coordination-rewrite'), false);
});

// --- the held/released predicate -------------------------------------------------

const HOLDER = {
  planId: '3756',
  sessionUuid: 'e3f1c0de-0000-4000-8000-000000000001',
  host: 'cloud-drain',
  iso: '2026-09-06T12:00:00Z',
};

test('a fresh claim commit message reads as HELD', () => {
  assert.ok(claimIsHeld(buildClaimMessage(HOLDER)));
});

test('a tombstone reads as NOT held — the one new rule every reader learns', () => {
  const t = buildTombstoneMessage(HOLDER);
  assert.ok(isTombstoneMessage(t));
  assert.equal(claimIsHeld(t), false);
});

test('the tombstone keeps the holder metadata parseable by parseClaimMessage', () => {
  // A tombstone is a RECORD of who released and when, not an erasure — reconcile-board
  // and reap-dead-claims both report on released claims.
  const parsed = parseClaimMessage(buildTombstoneMessage(HOLDER));
  assert.ok(parsed, 'a tombstone must still parse as a claim record');
  assert.equal(parsed.planId, '3756');
  assert.equal(parsed.sessionUuid, HOLDER.sessionUuid);
  assert.equal(parsed.host, HOLDER.host);
  assert.equal(parsed.iso, HOLDER.iso);
});

test('a tombstone is detected even though its body carries the same holder lines', () => {
  // Regression guard for the ordering bug this predicate is one line away from: a
  // tombstone body contains session=/host=/iso= exactly like a held claim, so a
  // held-check that ran FIRST on a loose pattern would call every release "held" and
  // make the plan permanently unclaimable.
  const t = buildTombstoneMessage(HOLDER);
  assert.match(t, /^session=/m);
  assert.equal(claimIsHeld(t), false);
});

test('an optional release reason rides the tombstone without breaking the parse', () => {
  const t = buildTombstoneMessage({ ...HOLDER, reason: 'landed via done-worktree' });
  assert.match(t, /^reason=landed via done-worktree$/m);
  assert.equal(claimIsHeld(t), false);
  assert.equal(parseClaimMessage(t).planId, '3756');
});

test('a multi-line release reason cannot forge a second message line', () => {
  const t = buildTombstoneMessage({ ...HOLDER, reason: 'oops\nclaim plan=999' });
  assert.equal(claimIsHeld(t), false);
  assert.equal(parseClaimMessage(t).planId, '3756');
});

test('an empty or unparseable tip reads as HELD — only a tombstone frees a ref', () => {
  // The conservative direction, and a deliberate one: before plan 3756 the ref EXISTING was
  // the proof of holding, and claimStatus reports an unparseable body as "held by an unknown
  // holder" on purpose. Reading these as free would hand two sessions the same plan.
  assert.equal(claimIsHeld(''), true);
  assert.equal(claimIsHeld('   \n  '), true);
  assert.equal(claimIsHeld(null), true);
  assert.equal(claimIsHeld('some unrelated commit subject'), true);
  assert.equal(claimIsHeld('claim plan=99'), true); // sub-3-digit id: unparseable, still held
});

test("a tombstone is recognised in git's FOLDED subject rendering too", () => {
  // `%(contents:subject)` collapses the whole commit message onto one line, and that is the
  // form heldClaimsMap's single-round-trip sweep reads. An end-anchored pattern matches the
  // raw body and silently misses this one, reporting every released claim as still held.
  const folded = buildTombstoneMessage(HOLDER).trim().replace(/\n/g, ' ');
  assert.equal(folded.includes('\n'), false, 'this fixture must be the one-line rendering');
  assert.ok(isTombstoneMessage(folded));
  assert.equal(claimIsHeld(folded), false);
  // and the held claim's folded subject is still held
  assert.equal(claimIsHeld(buildClaimMessage(HOLDER).trim().replace(/\n/g, ' ')), true);
});

test('only the exact tombstone subject frees a ref — near-misses stay held', () => {
  // The predicate now subtracts exactly one shape, so that shape must be pinned tightly:
  // anything that merely mentions a release must NOT read as released.
  assert.equal(claimIsHeld('claim RELEASED plan=3756'), false);
  assert.equal(claimIsHeld('claim plan=3756\nnote=RELEASED later'), true);
  assert.equal(claimIsHeld('RELEASED plan=3756'), true);
  assert.equal(claimIsHeld('claim RELEASED plan=abc'), true);
  assert.equal(claimIsHeld('claim RELEASED plan=99'), true);
});

// --- release strategy ------------------------------------------------------------

test('release strategy is chosen by the ref NAMESPACE, not by the environment', () => {
  assert.equal(releaseStrategyFor(claimRef('3756')), 'tombstone');
  assert.equal(releaseStrategyFor(coordRef('session-counter')), 'tombstone');
  // Claims taken before the flip release the way their holders already expect.
  assert.equal(releaseStrategyFor(legacyClaimRef('3756')), 'delete');
  assert.equal(releaseStrategyFor(legacyCoordRef('session-counter')), 'delete');
});

// --- ls-remote parsing -----------------------------------------------------------

test('parseClaimLsRemote reads both namespaces out of one ls-remote sweep', () => {
  const out = [
    `aaaaaaa\t${CLAIM_PREFIX}3756`,
    `bbbbbbb\t${LEGACY_CLAIM_PREFIX}3722`,
    `ccccccc\trefs/heads/master`,
    `ddddddd\t${COORD_PREFIX}session-counter`,
    '',
  ].join('\n');
  assert.deepEqual(parseClaimLsRemote(out), { 3756: 'aaaaaaa', 3722: 'bbbbbbb' });
});

test('when a plan has a ref in BOTH namespaces the new one is the live lock', () => {
  const out = [`legacysha\t${LEGACY_CLAIM_PREFIX}3756`, `newsha\t${CLAIM_PREFIX}3756`].join('\n');
  assert.deepEqual(parseClaimLsRemote(out), { 3756: 'newsha' });
});

test('parseClaimLsRemote tolerates junk, blank lines and empty input', () => {
  assert.deepEqual(parseClaimLsRemote(''), {});
  assert.deepEqual(parseClaimLsRemote(null), {});
  assert.deepEqual(parseClaimLsRemote('garbage\n\n   \nonefield\n'), {});
});
