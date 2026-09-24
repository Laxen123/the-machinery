#!/usr/bin/env node
// scripts/coord/queue-heartbeat-ref.mjs (plan 2603)
// The landing queue's liveness heartbeat, moved OFF the coord-write spine and onto a git
// ref: refs/coord/queue-heartbeat/<slug>.
//
// WHY a ref and not the queue doc. A heartbeat is the one coord write whose CONTENT
// nobody ever reads back — only the newest stamp is consulted — yet a flagless ping paid
// a full coord lock + freshen + commit + push (measured 2026-07-30: 91 pings/day at an
// 8.6s lock hold = ~13 lock-min/day, ~12% of all coord writes, on a shared mutex every
// other session queues behind). A ref update carries the same stamp with no lock, no
// commit on master, and no history.
//
// WHY a ref and not a local file. The heartbeat's whole purpose is that a DIFFERENT
// session can judge a queue head dead and recover the slot, and queue heads include
// cross-HOST cloud sessions (`host=vm`). Every non-committed cross-session mechanism in
// this repo is same-host BY CONSTRUCTION — lock-path.mjs's resolveCommonDirPath
// rendezvous on one machine's `.git` common dir (landing-lock.mjs's header says so
// outright), and both pid probes (mechanicalHolderGoneVerdict, demoteHolderPidAlive)
// refuse unless head.host === probingHost. A common-dir file, or inferring liveness from
// a holder pid, would silently disable slot recovery for exactly the heads that cannot
// defend themselves. Only an origin-mediated channel keeps the cross-host case working.
//
// WHY refs/coord/. That namespace is already sanctioned coordination surface and needs
// ZERO new gate plumbing: scripts/hooks/pre-push.sh passes it through, compute-push-diff
// skips it (isCoordinationRef), and the cloud PAT rewrite in cloud-routine-prompt-lib.mjs
// already covers it. The object shape is the established claim-ref primitive
// (claim-plan.mjs: `git mktree` empty tree -> `git commit-tree` parentless), so no new git
// idiom enters the repo.
//
// FAIL-SAFE DIRECTIONS — asymmetric, and the reason this file has two distinct failure
// contracts:
//   - WRITE fails  -> the caller must fall back to the doc coordWrite. A silently dropped
//     ping lets a LIVE head be demoted or reaped, which is worse than the cost it saves.
//     writeHeartbeatRef therefore THROWS rather than returning a soft failure.
//   - READ fails   -> fail CLOSED. readHeartbeatRefs returns { ok: false } on a fetch or
//     parse error, and the staleness-keyed verbs (demote/steal/reap) must REFUSE on it,
//     never judge on a doc-only reading: with the pings living in refs, a doc-only view
//     makes every live head look stale. `ok: true` with an empty map (no refs exist yet)
//     is a NORMAL state and must stay distinguishable from that error.

// OBJECT CHURN: each stamp mints a fresh parentless commit, so the ref namespace leaves
// ~one loose object per ping behind (the superseded ones become unreachable immediately).
// That is the same shape the claim refs already produce, and plan 2398's
// git-maintenance-guard already refuses an IMMEDIATE prune while sessions are live — a
// normal `git gc` reaps the unreachable ones on its usual expiry, and the CURRENT stamp is
// always ref-reachable, so it is never a prune candidate.

import { execFileSync } from 'node:child_process';
// plan 2656 (review finding on 2603): readHeartbeatRefs' own fetch had no lock-retry —
// every OTHER origin-touching read in this feature (landing-queue.mjs's readFresh) rides
// gitWithLockRetry, so the one bare fetch turned routine shared-.git lock contention
// (this repo runs ~5-7 parallel sessions) into an operator-visible refusal instead of a
// transparent retry.
import { gitWithLockRetry } from './coord-git.mjs';
// coord-refs.mjs imports nothing, so this adds no new cross-tree edge (plan 3756).
import { coordRef, legacyCoordRef } from './coord-refs.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';

// plan 3756: branch-shaped, because the cloud sandbox's mandatory proxy 403s `refs/coord/*`.
// A drain that cannot write its heartbeat is judged not-live at the landing-queue head and
// becomes steal-eligible while it is in fact mid-land.
export const HEARTBEAT_REF_PREFIX = `${coordRef('queue-heartbeat')}/`;
// The retired prefix. Still READ for the migration window: a session that stamped its
// heartbeat before this landed keeps its liveness rather than reading as a stale head that
// another session may steal.
export const LEGACY_HEARTBEAT_REF_PREFIX = `${legacyCoordRef('queue-heartbeat')}/`;

// The fetch refspecs, forced: our own stamps are last-write-wins and a ref that moved
// backwards on origin (a slug re-enqueued after a delete) must still overwrite locally.
export const HEARTBEAT_FETCH_REFSPEC = `+${HEARTBEAT_REF_PREFIX}*:${HEARTBEAT_REF_PREFIX}*`;
export const LEGACY_HEARTBEAT_FETCH_REFSPEC = `+${LEGACY_HEARTBEAT_REF_PREFIX}*:${LEGACY_HEARTBEAT_REF_PREFIX}*`;

// Slugs come from plan basenames and batch ids, so this is a guard against a malformed
// caller, not against a hostile one — but a slug carrying `..`, a space, or a leading `-`
// would produce an invalid or argument-injecting refname, so reject it loudly instead of
// pushing something unparseable into the shared coordination namespace.
const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// plan 2656 (review finding on 2603): SAFE_SLUG alone is looser than git's own refname
// grammar — `git check-ref-format` unconditionally rejects a component ending in `.` or
// in the literal suffix `.lock`, so a slug like "myplan." or "nightly.lock" passed the
// guard above but made every update-ref/commit-tree/push in writeHeartbeatRef throw for
// that exact slug. Reject both here too, at the same seam, rather than let git's own
// rejection surface three call sites downstream with three different error shapes.
function hasBadRefTail(slug) {
  return slug.endsWith('.') || slug.endsWith('.lock');
}

export function heartbeatRefFor(slug) {
  if (
    typeof slug !== 'string' ||
    !SAFE_SLUG.test(slug) ||
    slug.includes('..') ||
    hasBadRefTail(slug)
  ) {
    throw new Error(`queue-heartbeat-ref: unsafe slug for a refname: ${JSON.stringify(slug)}`);
  }
  return `${HEARTBEAT_REF_PREFIX}${slug}`;
}

function git(mainDir, args, input = undefined) {
  return execFileSync('git', ['-C', mainDir, ...args], {
    encoding: 'utf8',
    // plan 4135: gitRepoIsolatedEnv(), not gitIsolatedEnv() — this helper pushes ref
    // updates over the network (below), so only the repo-selector vars are dropped,
    // never transport/credential vars.
    env: gitRepoIsolatedEnv(),
    ...(input !== undefined ? { input } : {}),
  });
}

// The stamp rides the commit SUBJECT as compact JSON rather than the committer date:
// LQ_FAKE_NOW-driven tests can then set it directly, and progressIso (the convergence
// clock demoteVerdict reads) needs a second field the date alone cannot carry.
export function encodeStamp({ ts, progressIso = null }) {
  return JSON.stringify({ ts, progressIso: progressIso ?? null });
}

export function decodeStamp(subject) {
  try {
    const o = JSON.parse(subject);
    if (!o || typeof o.ts !== 'string') return null;
    return { ts: o.ts, progressIso: typeof o.progressIso === 'string' ? o.progressIso : null };
  } catch {
    return null;
  }
}

// plan 2656 (review finding on 2603): readLocalHeartbeatRef and deleteHeartbeatRef both
// re-derived the ref name with an identical try/catch around heartbeatRefFor, differing
// only in their sentinel on an unsafe slug. One shared resolver, one sentinel per caller.
function tryHeartbeatRefFor(slug) {
  try {
    return heartbeatRefFor(slug);
  } catch {
    return null;
  }
}

// Read THIS slug's stamp from the local ref, without a fetch. Used only to carry
// progressIso forward across a write (see writeHeartbeatRef); a local read is the right
// scope because only the entry's own host ever writes its ref.
export function readLocalHeartbeatRef(mainDir, slug) {
  const ref = tryHeartbeatRefFor(slug);
  if (!ref) return null;
  try {
    const raw = git(mainDir, ['for-each-ref', '--format=%(contents:subject)', ref]).trim();
    return raw ? decodeStamp(raw) : null;
  } catch {
    return null;
  }
}

// Write one stamp. THROWS on any failure — see the write fail-safe above; the caller
// (cmdHeartbeat) turns a throw into the doc-coordWrite fallback.
//
// progressIso is CARRIED FORWARD when this write does not set it. The convergence clock
// demoteVerdict reads must only ever be reset by an explicit `--progress` heartbeat, so a
// later flagless ping (the common case — every watcher tick) must not blank the last
// progress stamp back to null. On the doc this was free: heartbeatEntry only spread
// progressIso when `progress` was true, leaving the existing cell alone. A ref carries the
// WHOLE payload every time, so the same "leave it alone" has to be done explicitly here.
export function writeHeartbeatRef(mainDir, slug, { ts, progressIso = null }) {
  const ref = heartbeatRefFor(slug);
  if (progressIso == null) progressIso = readLocalHeartbeatRef(mainDir, slug)?.progressIso ?? null;
  const tree = git(mainDir, ['mktree'], '').trim();
  const commit = git(mainDir, ['commit-tree', tree, '-m', encodeStamp({ ts, progressIso })]).trim();
  // Local ref first so an offline session still has its own stamp, then publish. Forced:
  // only this entry's owner writes its ref, so last-write-wins is the correct rule and a
  // non-fast-forward (parentless commits share no history) is expected, not a conflict.
  git(mainDir, ['update-ref', ref, commit]);
  git(mainDir, ['push', '--quiet', '--force', 'origin', `${commit}:${ref}`]);
  return { ref, commit };
}

// Best-effort removal, for the paths that retire an entry (dequeue, and the steal/reap
// removals). A leftover ref is not a correctness problem — readers ignore any stamp older
// than the entry's enqueuedIso, and a ref with no queue entry at all — but left forever it
// would grow the namespace without bound.
export function deleteHeartbeatRef(mainDir, slug) {
  const ref = tryHeartbeatRefFor(slug);
  if (!ref) return false;
  try {
    git(mainDir, ['update-ref', '-d', ref]);
  } catch {
    /* already gone locally */
  }
  try {
    git(mainDir, ['push', '--quiet', 'origin', `:${ref}`]);
    return true;
  } catch {
    return false;
  }
}

// Fetch + read the whole namespace in one shot. Always fetches — plan 2656 split this out
// of landing-queue.mjs's readFresh, which used to fold this refspec into its own
// `git fetch origin master` under ONE try/catch so a single corrupt/dangling ref anywhere
// in the namespace failed the WHOLE combined fetch (poisoning the unrelated master-doc
// read too). Two independent fetches cost one extra round trip on the rare path where
// this one fails, in exchange for a bad ref only ever narrowing THIS function's own
// result, never the doc's.
//
// Returns { ok: true, map } — map is slug -> { ts, progressIso } — or { ok: false, error }
// when the namespace could not be read. Callers MUST distinguish those (fail closed).
export function readHeartbeatRefs(mainDir) {
  try {
    // Both namespaces, in ONE fetch. plan 3756's migration window: writes go to the new
    // prefix, but a heartbeat stamped by a pre-flip session still proves that session live.
    gitWithLockRetry(mainDir, [
      'fetch',
      '--quiet',
      'origin',
      HEARTBEAT_FETCH_REFSPEC,
      LEGACY_HEARTBEAT_FETCH_REFSPEC,
    ]);
  } catch (e) {
    return { ok: false, error: `heartbeat-ref fetch failed: ${e.message}`, map: {} };
  }
  let raw;
  try {
    raw = git(mainDir, [
      'for-each-ref',
      '--format=%(refname)%09%(contents:subject)',
      HEARTBEAT_REF_PREFIX,
      LEGACY_HEARTBEAT_REF_PREFIX,
    ]);
  } catch (e) {
    return { ok: false, error: `heartbeat-ref read failed: ${e.message}`, map: {} };
  }
  const map = {};
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const refname = line.slice(0, tab);
    // The NEW prefix is tried first, so a slug stamped in both namespaces resolves to the
    // live stamp rather than the retired one.
    const prefix = refname.startsWith(HEARTBEAT_REF_PREFIX)
      ? HEARTBEAT_REF_PREFIX
      : LEGACY_HEARTBEAT_REF_PREFIX;
    const slug = refname.slice(prefix.length);
    const stamp = decodeStamp(line.slice(tab + 1));
    // An undecodable stamp is dropped, not treated as an error: one corrupt ref must not
    // fail-closed the verbs for every OTHER slug in the queue.
    if (!slug || !stamp) continue;
    if (prefix === HEARTBEAT_REF_PREFIX || !(slug in map)) map[slug] = stamp;
  }
  return { ok: true, map };
}
