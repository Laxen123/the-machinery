#!/usr/bin/env node
// scripts/coord/coord-refs.mjs — the ONE authority for coordination ref NAMES and for the
// held/released predicate over a claim ref's tip message (plan 3756).
//
// WHY THIS MODULE EXISTS
// ---------------------
// A cloud drain sandbox forces every `git` through a proxy that pushes `refs/heads/*`
// fine but hard-403s `refs/claims/*` and `refs/coord/*` — the two namespaces the claim
// CAS and the coord counters were built on. Fifteen incidents in two months and two
// failed credential-side patches (plans 1770, 2863) later, plan 3756 moved the spine
// onto the namespace that has never once failed: branch-shaped refs.
//
// Measured 2026-09-06 from a full-egress sandbox, pushing THROUGH the mandatory proxy
// (`output/reports/2026-09-06-coord-ref-namespace-proxy-probes-plan-3756.md`, probe 1 phase B — the bypass deliberately unset):
//
//     create refs/claims/<id>                 FAIL  HTTP 403
//     create refs/coord/<id>                  FAIL  HTTP 403
//     create refs/heads/coord/claims/<id>     PASS
//     ff-update that ref (tombstone)          PASS
//     create refs/heads/<id>                  PASS
//     DELETE refs/heads/coord/claims/<id>     FAIL  HTTP 403
//     DELETE refs/heads/<id>                  FAIL  HTTP 403
//
// Two facts from that table drive this whole module:
//
//   1. A NESTED branch ref passes exactly as a flat one does. The namespace prefix is
//      free — we can keep the coord refs greppable and swept-by-prefix.
//   2. The proxy refuses DELETE by VERB, not by namespace: it 403s the delete of an
//      ordinary `refs/heads/*` branch too. So moving namespaces could never have fixed
//      claim RELEASE on its own. Release must stop being a delete.
//
// HOW RELEASE WORKS NOW: THE TOMBSTONE
// ------------------------------------
// A claim ref is an append-only chain of parentless-then-child commits against the
// empty tree. Acquiring appends a `claim plan=<id>` commit; releasing appends a
// `claim RELEASED plan=<id>` tombstone. A ref whose tip is a tombstone is NOT held.
// Actual ref removal is a garbage chore (reap-dead-claims.mjs), never on the critical
// path of a claim or a land — so an environment that cannot delete can still claim,
// release, and land.
//
// HOW THE MUTEX SURVIVES THAT (the non-obvious part)
// --------------------------------------------------
// The plan-368 CAS was "push a PARENTLESS commit non-force": create → won, rejected
// non-fast-forward → lost. Under tombstones the ref never disappears, so a parentless
// push at a released ref would be rejected and every RE-claim would read as lost.
//
// So the CAS is now "my parent is the tip I read":
//
//   ref absent               → parentless commit, non-force push   (as before)
//   tip is a TOMBSTONE       → commit whose PARENT is that tip, non-force push.
//                              A fast-forward, so accepted — unless a rival appended
//                              first, moving the tip, in which case ours is rejected
//                              non-fast-forward. Exactly one winner, as before.
//   tip is HELD              → lost, without pushing at all.
//
// The rejection that means "lost" is the same rejection as before, so
// `classifyPushResult` (claim-plan-lib.mjs) is unchanged, and no path needs a force
// push — which matters, because a force push is a shape we have never probed through
// the proxy.
//
// DUAL READ
// ---------
// Live sessions held 14 legacy `refs/claims/*` locks when this landed. Readers honour
// BOTH namespaces (`claimRefCandidates`, `CLAIM_GLOBS`, `planIdFromClaimRef`) for the
// migration window, and `releaseStrategyFor()` releases each ref the way its OWN
// namespace expects — legacy by delete, branch-shaped by tombstone. Retiring the
// legacy half is a follow-up, once no legacy ref has been seen for a full drain cycle.

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/** Branch-shaped coordination namespace — the one the proxy passes. */
export const COORD_PREFIX = 'refs/heads/coord/';
/** Pre-plan-3756 coordination namespace. Read-only after the flip; still released-from. */
export const LEGACY_COORD_PREFIX = 'refs/coord/';

export const CLAIM_PREFIX = `${COORD_PREFIX}claims/`;
export const LEGACY_CLAIM_PREFIX = 'refs/claims/';

export const CLAIM_GLOB = `${CLAIM_PREFIX}*`;
export const LEGACY_CLAIM_GLOB = `${LEGACY_CLAIM_PREFIX}*`;
/** Every glob a claim READER must sweep during the dual-read window, new namespace first. */
export const CLAIM_GLOBS = Object.freeze([CLAIM_GLOB, LEGACY_CLAIM_GLOB]);

/**
 * Throwaway per-run coordination-probe namespace (plan 3812; the probe CLI is project-side).
 * A probe ref proves a push into the live branch-shaped namespace lands, through `origin`,
 * before a drain trusts the same path for a real claim CAS or coord counter write. Kept
 * SEPARATE from CLAIM_PREFIX rather than reusing it: a probe ref carries no claim state and
 * is never tombstoned (nothing ever asks "is this probe ref held?"), so a claim-specific
 * sweep (`gcReleasedClaimRefs`, which requires a tombstoned tip before it will touch a ref)
 * would never reap it — plan 3812's own review found exactly that: the probe's header
 * advertised the general claims sweeper as its cleanup path, and that was false by
 * construction. `PROBE_GLOB` is what the probe-specific sweep (`gcProbeRefs`, claim-plan.mjs)
 * reads instead.
 */
export const PROBE_PREFIX = `${COORD_PREFIX}probes/`;
export const PROBE_GLOB = `${PROBE_PREFIX}*`;

/** Is `ref` a probe ref? */
export function isProbeRef(ref) {
  return String(ref ?? '').startsWith(PROBE_PREFIX);
}

// Plan ids are ≥3 digits (plan 1000 crossed into 4). Kept local rather than imported
// from claim-plan-lib so this module stays dependency-free: claim-plan-lib imports IT.
const ID_RX = /^(\d{3,})/;

function idOf(idOrName) {
  const m = ID_RX.exec(String(idOrName));
  if (!m) throw new Error(`coord-refs: cannot derive a plan id from "${idOrName}"`);
  return m[1];
}

/** The claim ref a NEW acquire writes to. */
export function claimRef(idOrName) {
  return `${CLAIM_PREFIX}${idOf(idOrName)}`;
}

/** The pre-3756 claim ref for the same plan. Readers and releasers still need it. */
export function legacyClaimRef(idOrName) {
  return `${LEGACY_CLAIM_PREFIX}${idOf(idOrName)}`;
}

/**
 * Every ref name a reader must try for one plan, in precedence order (new first).
 * A reader that finds a HELD tip at either name must treat the plan as claimed.
 */
export function claimRefCandidates(idOrName) {
  return [claimRef(idOrName), legacyClaimRef(idOrName)];
}

/** A named non-claim coordination ref (`session-counter`, `spec-sweep-lock`, …). */
export function coordRef(name) {
  return `${COORD_PREFIX}${stripSlashes(name)}`;
}

export function legacyCoordRef(name) {
  return `${LEGACY_COORD_PREFIX}${stripSlashes(name)}`;
}

export function coordRefCandidates(name) {
  return [coordRef(name), legacyCoordRef(name)];
}

function stripSlashes(name) {
  const s = String(name).replace(/^\/+|\/+$/g, '');
  if (!s) throw new Error('coord-refs: a coordination ref needs a non-empty name');
  return s;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * The plan id carried by a claim ref in EITHER namespace, or null if `ref` is not a
 * claim ref at all. Leading zeros are normalised away so `refs/claims/0365` and
 * `refs/claims/365` name one plan (reconcile-drain-markers.mjs relied on doing this
 * itself; the canonicalisation belongs here).
 */
export function planIdFromClaimRef(ref) {
  const s = String(ref ?? '');
  for (const prefix of [CLAIM_PREFIX, LEGACY_CLAIM_PREFIX]) {
    if (!s.startsWith(prefix)) continue;
    const rest = s.slice(prefix.length);
    if (!/^\d{3,}$/.test(rest)) return null;
    return rest.replace(/^0+(?=\d)/, '');
  }
  return null;
}

/**
 * Is `ref` a coordination ref — i.e. one whose push carries no branch content and must
 * therefore SKIP the push-gate battery?
 *
 * This predicate is duplicated as a shell `case` pattern in scripts/hooks/pre-push.sh
 * (a shell script and a JS module cannot share one literal). Adding or renaming a
 * coordination namespace must update BOTH or the two layers silently disagree about
 * what counts as a coord-only push — and after plan 3756 that disagreement is expensive
 * in a new way: a claim ref is now a BRANCH ref, so a pre-push hook that fails to
 * recognise it runs the full gate battery on every single claim acquire.
 */
export function isCoordRef(ref) {
  const s = String(ref ?? '');
  return (
    s.startsWith(COORD_PREFIX) ||
    s.startsWith(LEGACY_COORD_PREFIX) ||
    s.startsWith(LEGACY_CLAIM_PREFIX)
  );
}

/** True for a ref still living in a pre-3756 namespace (drives the release strategy). */
export function isLegacyCoordRef(ref) {
  const s = String(ref ?? '');
  return s.startsWith(LEGACY_COORD_PREFIX) || s.startsWith(LEGACY_CLAIM_PREFIX);
}

/**
 * Should a branch-hygiene sweep ignore this origin branch?
 *
 * The claim refs now show up in `git branch -r` alongside real work branches. Every
 * sweep skips them BY PREFIX (never by a hand-maintained name list), which is the
 * property the plan-3756 spec-pass asked to be confirmed.
 */
export function isCoordBranch(branchName) {
  const s = String(branchName ?? '').replace(/^origin\//, '');
  return s === 'coord' || s.startsWith('coord/');
}

// ---------------------------------------------------------------------------
// The held / released predicate
// ---------------------------------------------------------------------------

// Anchored at the start of a line, but NOT at the end of one. A tombstone is read from two
// different renderings of the same commit: the raw body (`git cat-file commit`), where the
// marker is its own line, and git's `%(contents:subject)`, which folds the entire message onto
// ONE line — `claim RELEASED plan=365 session=… host=… iso=…`. The sweep in
// `heldClaimsMap` uses the folded form, so requiring end-of-line here would silently report
// every released claim as still held. The `(?:\s|$)` keeps the id bounded so `plan=abc` and a
// short `plan=99` are still rejected.
const TOMBSTONE_RX = /^claim RELEASED plan=(\d{3,})(?:\s|$)/m;

/**
 * The tombstone commit message. Same key=value shape as `buildClaimMessage`
 * (claim-plan-lib.mjs) so `parseClaimMessage` keeps reading the holder metadata off a
 * released claim — which is what makes a tombstone a RECORD of who released it and
 * when, not just an erasure.
 */
export function buildTombstoneMessage({ planId, sessionUuid, host, iso, reason }) {
  const lines = [
    `claim RELEASED plan=${planId}`,
    `session=${sessionUuid}`,
    `host=${host}`,
    `iso=${iso}`,
  ];
  if (reason) lines.push(`reason=${String(reason).replace(/\n/g, ' ')}`);
  return `${lines.join('\n')}\n`;
}

export function isTombstoneMessage(msg) {
  return TOMBSTONE_RX.test(String(msg ?? ''));
}

/**
 * Is the claim whose tip commit message is `msg` currently HELD?
 *
 * The one new rule every reader learns from plan 3756, and it subtracts exactly one case:
 * **a ref that exists is held UNLESS its tip is a recognised tombstone.**
 *
 * Deliberately not "held iff the body parses as `claim plan=<id>`". Before this plan, the
 * ref EXISTING was the proof of holding, and `claimStatus` (claim-plan.mjs) leans on that
 * on purpose — an unparseable or pre-format claim body reports `held: true, holder: null`
 * rather than throwing or reading as free. Requiring a positive match would quietly reverse
 * that: a malformed body would start reading as claimable, and the ref exists precisely
 * because somebody claimed the plan. Getting this backwards hands two sessions one plan,
 * which is the single failure the ref exists to prevent, so the unknown case stays HELD and
 * only a tombstone — which we write ourselves, in a shape we control — frees it.
 */
export function claimIsHeld(msg) {
  return !isTombstoneMessage(msg);
}

/**
 * How a given claim ref must be RELEASED.
 *
 * 'tombstone' — append a released-commit (branch-shaped namespace; works everywhere,
 *               including behind the proxy that 403s deletes).
 * 'delete'    — push a delete (legacy namespace only). Still correct for the claims
 *               that live sessions took before the flip, and still what a local or
 *               bypassed environment can do. A tombstone appended to a LEGACY ref would
 *               leave it non-empty forever and re-read as held by any pre-3756 reader.
 */
export function releaseStrategyFor(ref) {
  return isLegacyCoordRef(ref) ? 'delete' : 'tombstone';
}

/**
 * Parse `git ls-remote` output covering EITHER claim namespace into { '<id>': '<sha>' }.
 * The new namespace wins when a plan somehow has a ref in both (only possible mid-
 * migration, and the new one is the live lock by construction).
 */
export function parseClaimLsRemote(out) {
  const map = {};
  const legacy = {};
  for (const line of String(out ?? '').split('\n')) {
    const parts = line.trim().split(/\s+/u);
    if (parts.length < 2) continue;
    const [sha, ref] = parts;
    const id = planIdFromClaimRef(ref);
    if (!id) continue;
    if (ref.startsWith(CLAIM_PREFIX)) map[id] = sha;
    else legacy[id] = sha;
  }
  for (const [id, sha] of Object.entries(legacy)) if (!(id in map)) map[id] = sha;
  return map;
}
