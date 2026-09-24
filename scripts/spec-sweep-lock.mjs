#!/usr/bin/env node
// scripts/spec-sweep-lock.mjs — first-one-in mutex for the multi-account cloud spec-sweep
// (plan 1915).
//
// Each of the operator's claude.ai accounts carries an identical
// `vetapp pending-approval spec-sweep` trigger. The sweep is board-wide curation over
// shared state (docs/superpowers/plans/pending-approval/) — one sweep serves the whole
// board, so two overlapping sweeps only duplicate heavy-model spend and produce mid-run
// move-plan/stamp errors for the loser. Cron staggering cannot fix this subset-invariantly
// (an N-way rotation only sweeps every N cycles when one account is enabled), so the
// stagger lives HERE, in the sweep itself: at sweep start, atomically claim
// `refs/coord/spec-sweep-lock`; exactly one firing per cycle wins, the losers exit in
// seconds having read nothing.
//
// WHY A GIT REF, NOT THE FILE-LOCK FAMILY: excl-lock.mjs (and its consumers
// landing-lock.mjs / battery-lock.mjs) are O_EXCL FILE locks rendezvousing in the shared
// `.git` common dir — machine-local by design. The sweeps run in four separate cloud
// sandboxes whose ONLY shared surface is origin itself, so the mutex must be origin's
// push atomicity. The mechanics mirror claim-plan.mjs's acquireRef (plan 368): the lock
// is a UNIQUE, parentless commit object (`commit-tree` against the empty tree — no index,
// no HEAD, no working tree touched) pushed NON-FORCE to the lock ref. The push is
// create-or-fast-forward only; a second claimant's parentless commit is unrelated history,
// so its push is rejected non-fast-forward. THAT rejection is the mutex — atomic,
// server-side, cross-sandbox.
//
// CRASH RECOVERY (TTL takeover): a sweep killed mid-run leaves the ref behind. A later
// acquire that finds the holder OLDER than the TTL (default 90 min — comfortably above a
// long sweep, well below the 2 h cron cycle) takes over via a compare-and-swap push
// (`--force-with-lease=<ref>:<staleSha>`): the update lands ONLY if the ref still points
// at the stale sha, so two simultaneous takeover attempts resolve to exactly one winner —
// the loser re-reads and sees a FRESH holder. Release is the same CAS shape on a DELETE
// (`--force-with-lease=<ref>:<ourSha>` + `:<ref>`), so an expired holder returning late
// can never delete its successor's lock.
//
// CLOUD SANDBOX (plan 1770/1728): pushing/deleting refs/coord/* 403s on the in-cloud git
// proxy; coord-git's git() seam auto-installs the configured-PAT pushInsteadOf reroute on
// every push. When the PAT is absent (proxy-only sandbox) the acquire push fails with a
// non-contention error → CLI exit 4 ("locking unavailable"): the sweep prompt then
// proceeds UNLOCKED (today's behavior) and says so in its summary — a missing lock must
// never wedge the sweep.
//
// Usage:
//   node scripts/spec-sweep-lock.mjs acquire [--account <name>] [--ttl-minutes 90]
//     exit 0 = lock held (stdout JSON carries `sha` — pass it to release)
//     exit 3 = busy: a FRESH sibling holds it (holder printed; stop the sweep)
//     exit 4 = locking unavailable (push infra denied — proceed unlocked)
//     --account defaults to $COORD_ACCOUNT, then hostname(). Trigger bodies are
//     byte-identical across accounts, so a nameable holder identity comes from setting
//     COORD_ACCOUNT per cloud environment (optional; diagnostics only, never semantics).
//   node scripts/spec-sweep-lock.mjs release --sha <sha> [--force]
//     exit 0 on every clean outcome (released / already absent / not-holder — idempotent;
//     never deletes a lock it does not hold unless --force); exit 4 only when the delete
//     push itself fails for a non-contention infra reason.
//     plan 4083: --sha may be omitted when the caller's own holder-identity TOKEN (see
//     below) equals the live holder's — the 2026-09-20 incident had no sha to pass
//     because it never saw its own acquire's output. Omitting --sha with no matching
//     token behaves exactly as before (throws / not-holder, per whether a token exists).
//
// HOLDER IDENTITY (plan 4083): the lock message carries an optional per-run `token` —
// the repo's canonical coordination-identity resolver (coord-session-id.mjs's
// coordinationSessionId(), which honors $COORD_SESSION_ID and reconciles the Claude /
// Codex / Grok native identities), falling back to $CLAUDE_SESSION_ID (the one key the
// canonical resolver does not cover) and then to (off the shared main checkout only) a
// value cached in a `.scratch/` file — so a second `acquire` from the SAME run that
// finds its own live lock wins idempotently (`{won:true, reacquired:true}`) instead of
// reporting a sibling and self-deadlocking for the rest of the TTL. See
// resolveOwnToken()'s doc for the full resolution order and the shared-checkout hazard
// it is gated against.
//   node scripts/spec-sweep-lock.mjs status [--ttl-minutes 90]
//     exit 0, prints { held, ... } JSON
//
// Tests: scripts/spec-sweep-lock.test.mjs (temp bare-origin harness, claim-plan.test.mjs
// pattern). Do-not-touch note (plan 1915): this is a SIBLING of the existing lock/write-
// spine scripts, not a refactor of them — landing-lock/battery-lock/excl-lock/coord-edit
// are deliberately untouched.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  git,
  resolveMain,
  parseFlags,
  errText,
  isStaleInfo,
  readRemoteRefCommit,
} from './coord/coord-git.mjs';
import { classifyPushResult } from './coord/claim-plan-lib.mjs';
// coord-refs.mjs imports nothing, so this adds no new cross-tree edge (plan 3756).
import { coordRef, legacyCoordRef, releaseStrategyFor } from './coord/coord-refs.mjs';
// plan 4083: check-coordination-branch.mjs's dependency graph (coord-config.mjs,
// build-index-lib.mjs, coord-git.mjs for GIT_MAXBUFFER, …) never reaches back into this
// module, so importing its isMainCheckout adds no cycle (verified against the graph at
// spec-review time). isMainCheckout itself fails OPEN to `true` on any git error — the
// conservative direction for the file-lane gate below.
import { isMainCheckout } from './coord/check-coordination-branch.mjs';
// plan 4083 fix-round: the repo's ONE canonical coordination-identity resolver — see
// envSessionToken() below for why it must never be allowed to throw out of this module.
import { coordinationSessionId } from './coord/coord-session-id.mjs';
// plan 4083 fix-round: the shared crash-safe JSON writer (fsync+tmp-then-rename), so a
// process killed mid-write of the token file can never leave it torn.
import { atomicWriteJsonSync } from './coord/atomic-write.mjs';

// plan 3756: branch-shaped, because the cloud sandbox's mandatory proxy 403s `refs/coord/*`
// — which is exactly the "locking unavailable" path the PERM_DENIED_RX note below describes,
// hit on every cloud spec-sweep rather than only on a no-PAT box.
export const LOCK_REF = coordRef('spec-sweep-lock');
// The retired ref, still READ while a pre-flip sweep might hold it. A lock we cannot see is
// worse than one we can: two sweeps would run the board at once.
export const LEGACY_LOCK_REF = legacyCoordRef('spec-sweep-lock');
export const DEFAULT_TTL_MINUTES = 90;

// Ref pushes carry no branch diff → no hook.
const HUSKY0 = { ...process.env, HUSKY: '0' };

// --- message format ------------------------------------------------------------

// key=value lines, claim-plan style — greppable in `git cat-file commit` output and
// parseable without a JSON round-trip surviving commit-message normalization.
//
// plan 4083: `token` is ADDITIVE — a per-run holder-identity string. Omitted (falsy) it
// emits no `token=` line at all, so a legacy reader/writer pair sees byte-identical
// messages to before this plan, and `parseLockMessage` gives such a message `token:
// null`, which never matches any caller's token (see the busy-branch guard below).
export function buildLockMessage({ account, startedAt, host, token }) {
  return (
    `spec-sweep-lock account=${account}\n` +
    `started=${startedAt}\n` +
    `host=${host}\n` +
    (token ? `token=${token}\n` : '')
  );
}

export function parseLockMessage(body) {
  const msg = String(body || '');
  if (!/^spec-sweep-lock /m.test(msg)) return null;
  const get = (k) => (msg.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1] ?? null;
  return {
    account: (msg.match(/^spec-sweep-lock account=(.+)$/m) || [])[1] ?? null,
    started: get('started'),
    host: get('host'),
    token: get('token'),
  };
}

// Staleness off the holder's self-declared start time. An unparseable/absent timestamp
// counts as STALE: a corrupt lock (hand-pushed ref, truncated message) must be
// recoverable by the next firing, not a permanent wedge — the CAS takeover keeps even a
// mis-judged staleness race down to exactly one winner.
export function isStale(startedIso, ttlMinutes, nowMs) {
  const t = Date.parse(startedIso ?? '');
  if (Number.isNaN(t)) return true;
  return nowMs - t >= ttlMinutes * 60_000;
}

// --- remote read ---------------------------------------------------------------

// Current holder of the lock ref on origin: { sha, account, started, host } | null.
// The plumbing (incl. tolerance for the ref vanishing mid-read) is the shared
// readRemoteRefCommit (coord-git) — the same read half claim-plan's readHolder uses.
// plan 3756: the release marker. Same reason as the claim tombstone — the proxy 403s deletes
// by verb, so a branch-shaped lock cannot be released by deleting its ref.
const LOCK_RELEASED_RX = /^spec-sweep-lock RELEASED(?:\s|$)/m;
export function buildLockReleaseMessage({ host, iso }) {
  return `spec-sweep-lock RELEASED\nhost=${host}\niso=${iso}\n`;
}
export function isLockReleaseMessage(msg) {
  return LOCK_RELEASED_RX.test(String(msg ?? ''));
}

// The raw tip, release marker included — what `acquireLock` needs to tell "someone holds this"
// from "this ref is a spent husk I may fast-forward over".
export function readLockTip(mainDir, ref = LOCK_REF) {
  return readRemoteRefCommit(mainDir, ref);
}

export function readLockHolder(mainDir, ref = LOCK_REF, { fallback = true } = {}) {
  const r = readRemoteRefCommit(mainDir, ref);
  // A released tip is NOT a holder — the ref survives the release now. Note this must fall
  // THROUGH to the legacy probe below rather than returning early: once the new ref carries a
  // tombstone it exists forever, and an early return would hide a still-live pre-flip lock for
  // the rest of the migration window (plan 3756 review).
  if (r && !isLockReleaseMessage(r.body)) {
    return { sha: r.sha, ref, ...(parseLockMessage(r.body) || {}) };
  }
  // plan 3756 migration window: a sweep that took the lock before the namespace flip holds
  // the retired ref, and it is still a live holder. Only consulted for the DEFAULT ref — an
  // explicitly-passed ref means the caller is asking about that exact one — and only when the
  // caller wants the fallback: `acquireLock` must be able to ask about THIS ref alone.
  if (ref !== LOCK_REF || !fallback) return null;
  const legacy = readRemoteRefCommit(mainDir, LEGACY_LOCK_REF);
  if (!legacy) return null;
  return { sha: legacy.sha, ref: LEGACY_LOCK_REF, ...(parseLockMessage(legacy.body) || {}) };
}

// --- core ops ------------------------------------------------------------------

// A remote-side PERMISSION denial can surface as a per-ref `! [remote rejected] …
// (permission denied)` line — a shape classifyPushResult's NONFF_RX would swallow as
// contention. For THIS lock that mistake is fatal to the whole feature: it turns
// "locking unavailable" (exit 4 → proceed unlocked) into "busy" (exit 3 → skip the
// sweep) on every no-PAT proxy sandbox, silently stopping the board work on that
// account (review 1915 F0). So permission markers classify as INFRA before the shared
// contention classifier runs.
const PERM_DENIED_RX = /permission denied|pre-receive hook declined|forbidden|403|protected/i;

// A push refspec attempt classified three ways: won / lost (contention) / error (infra).
function tryPush(mainDir, args) {
  try {
    git(mainDir, ['push', 'origin', ...args], { env: HUSKY0 });
    return { won: true };
  } catch (e) {
    const stderr = errText(e);
    if (PERM_DENIED_RX.test(stderr)) return { won: false, error: true, stderr };
    const r = classifyPushResult({ ok: false, stderr });
    // --force-with-lease CAS rejections ("stale info") are contention, not infra failure.
    if (r.error && !isStaleInfo(e)) return { won: false, error: true, stderr };
    return { won: false, lost: true };
  }
}

// --- holder identity (plan 4083) ------------------------------------------------

// plan 4083 fix-round: use the repo's canonical coordination-identity resolver
// (coord-session-id.mjs's coordinationSessionId — the same one claim-plan.mjs,
// edit-plan.mjs, move-plan.mjs, stamp-lib.mjs, done-worktree.mjs, drain-status.mjs,
// land/spine.mjs and land/teardown.mjs all honor) instead of hand-rolling a second scan
// over the session-id env vars. The hand-rolled list silently ignored the repo-wide
// $COORD_SESSION_ID override and the Codex identities ($CODEX_THREAD_ID /
// $CODEX_SESSION_ID); the canonical resolver covers all of that.
//
// coordinationSessionId() THROWS on ambiguity (populated native identity vars that
// disagree) — a deliberate refusal, documented on that function as "a nested host
// cannot silently act as the wrong owner". This module's founding principle (see the
// file header) is that a missing or uncertain lock identity must degrade to "no
// token" — today's busy behaviour — and NEVER wedge the sweep; but round 1 of this
// fix caught that throw and then fell back to $CLAUDE_SESSION_ID anyway, which
// DEFEATS the ambiguity refusal for the exact failure mode this mutex exists to
// prevent (two runs each believing an ambiguous identity is their own, both
// proceeding). So a throw here degrades straight to `null` — no fallback consulted —
// and only a CLEAN `null` return from the resolver (no populated identity var at all)
// falls through to the $CLAUDE_SESSION_ID lane below.
// Returns `{ token, refused }`. `refused: true` means the canonical resolver REFUSED to
// name an owner (ambiguous or malformed native identity) — categorically different from
// `{ token: null, refused: false }`, which merely means no identity is configured. The
// caller must not substitute any other lane for a refusal (plan 4083 review round 3):
// collapsing the two into one `null` let the `.scratch/` file lane mint a token right
// past the refusal, re-opening the "nested host silently acts as the wrong owner" hole
// this module just closed on the env side.
function envSessionToken() {
  let resolved;
  try {
    resolved = coordinationSessionId();
  } catch {
    // Ambiguous or malformed native identity: the refusal IS the answer. Do not
    // consult CLAUDE_SESSION_ID — that would be a side channel around the refusal.
    return { token: null, refused: true };
  }
  if (resolved) return { token: resolved, refused: false };
  // $CLAUDE_SESSION_ID is the one key plan 4083's body names that the canonical
  // resolver does not cover (it only reconciles CLAUDE_CODE_SESSION_ID, the Codex
  // identities, and GROK_SESSION_ID) — kept as an explicit fallback, but ONLY reached
  // when the resolver returned null cleanly, and only after validation matching
  // coord-session-id.mjs's (unexported) `readId()`: non-empty string, no whitespace, no
  // control characters. Skipping that validation would let a malformed value (e.g. one
  // containing a newline) reach buildLockMessage's newline-delimited `token=${token}\n`
  // line and corrupt the message `parseLockMessage` reads back.
  //
  // UNSET is absence; SET-BUT-MALFORMED is a REFUSAL, mirroring readId()'s own split
  // (it returns null for an unset/empty var but THROWS on a malformed one). Treating a
  // malformed value as mere absence would let the file lane mint a token for a run whose
  // configured identity we just rejected — the same hole round 3 closed above.
  const raw = process.env.CLAUDE_SESSION_ID;
  if (raw === undefined || raw === null || raw === '') return { token: null, refused: false };
  if (typeof raw !== 'string') return { token: null, refused: true };
  if (/\s/u.test(raw)) return { token: null, refused: true }; // readId(): no whitespace/newlines
  if (/\p{Cc}/u.test(raw)) return { token: null, refused: true }; // readId(): no control chars
  return { token: raw, refused: false };
}

function tokenFilePath(mainDir) {
  return join(mainDir, '.scratch', 'spec-sweep-lock-token.json');
}

function readTokenFile(mainDir) {
  try {
    const data = JSON.parse(readFileSync(tokenFilePath(mainDir), 'utf8'));
    return typeof data?.token === 'string' && data.token ? data.token : null;
  } catch {
    return null; // absent, unreadable, or corrupt — no persisted identity yet
  }
}

function writeTokenFile(mainDir, token) {
  try {
    // atomicWriteJsonSync (scripts/atomic-write.mjs) is the crash-safe fsync+tmp-then-
    // rename writer, but it does not create parent directories — mkdirSync stays.
    mkdirSync(join(mainDir, '.scratch'), { recursive: true });
    atomicWriteJsonSync(tokenFilePath(mainDir), { token });
  } catch {
    // Best-effort: a failed write just means the NEXT process falls back to "no token"
    // and the mutex behaves exactly as it does today — the conservative degradation.
  }
}

/**
 * Resolve THIS process's holder-identity token. Returns `{ token, persist }`, where
 * `persist` says whether a freshly-minted token (never seen in the `.scratch/` file)
 * still needs writing there once its acquire actually WINS — a losing acquire must not
 * litter a token nobody ends up holding.
 *
 * Order: the canonical coordination-identity resolver (coord-session-id.mjs's
 * `coordinationSessionId()`, which honors `COORD_SESSION_ID` and reconciles
 * `CLAUDE_CODE_SESSION_ID` / the Codex identities / `GROK_SESSION_ID`, degrading a
 * throw — ambiguous or malformed identity — to no token rather than propagating it) →
 * `CLAUDE_SESSION_ID` (the one key the canonical resolver does not cover) → a
 * `.scratch/` token file under `mainDir`, but ONLY when `mainDir` is NOT the shared main
 * checkout (`isMainCheckout`, which fails OPEN to `true` — the conservative direction).
 * ~5–7 parallel local sessions share one `.scratch/` on the shared main checkout, so a
 * file lane there would let session B read session A's token and self-identify as
 * holding A's lock, dissolving the mutex between two local spec-passes (the exact
 * 2026-09-13 duplicated-read shape). Neither lane yielding a token answers `null` —
 * today's busy behaviour, the conservative default when identity cannot be established.
 *
 * PRODUCTION REACHABILITY (plan 4083 fix-round): on the ORDINARY CLI path the file lane
 * above is unreachable — `main()` always passes `mainDir = resolveMain()`, which by
 * construction satisfies `isMainCheckout(mainDir)`, so the `!isMainCheckout(mainDir)`
 * branch never opens there (only this file's own tests open it, by building a real
 * linked worktree). That claim is NOT absolute, though: `resolveMain()` (coord-git.mjs)
 * honors a `COORD_MAIN_DIR` env override and returns it verbatim, skipping the porcelain
 * resolution and the on-master assert entirely — so a caller that sets `COORD_MAIN_DIR`
 * to a non-main checkout (e.g. done-worktree's ephemeral detached finish worktree) before
 * invoking this CLI would hand `main()` a `mainDir` for which `isMainCheckout` returns
 * `false`, opening the file lane there too. That is still safe by the same reasoning —
 * the lane degrades to a per-checkout persisted token, never a wrong-owner match — but
 * it means the CLI path is env-only ONLY in the absence of that override, not
 * unconditionally.
 *
 * Callers that already know their own token (tests; direct API callers) pass it to
 * acquireLock/releaseLock and never reach this function.
 */
export function resolveOwnToken(mainDir) {
  const fromEnv = envSessionToken();
  if (fromEnv.token) return { token: fromEnv.token, persist: false };
  // A REFUSAL is terminal: the canonical resolver declined to name an owner, so no other
  // lane may name one either. Falling through here would let the file lane below mint a
  // token for exactly the ambiguous-identity run the refusal exists to stop (review
  // round 3). Absence — nothing configured — still falls through to the file lane.
  if (fromEnv.refused) return { token: null, persist: false };
  if (isMainCheckout(mainDir)) return { token: null, persist: false };
  const fromFile = readTokenFile(mainDir);
  if (fromFile) return { token: fromFile, persist: false };
  return { token: randomBytes(16).toString('hex'), persist: true };
}

/**
 * Acquire the sweep lock. Returns one of:
 *   { won: true, sha, tookOverFrom? }              — proceed with the sweep
 *   { won: true, reacquired: true, sha }           — our OWN live lock; idempotent re-acquire
 *   { won: false, busy: true, holder }             — a fresh sibling holds it; stop
 *   { won: false, error: true, stderr }            — push infra unavailable; run unlocked
 *
 * `token` overrides holder-identity resolution (tests; a caller that already knows its
 * own token) — omit it to use resolveOwnToken(mainDir)'s env-then-file default.
 */
export function acquireLock(
  mainDir,
  { account, ttlMinutes = DEFAULT_TTL_MINUTES, ref = LOCK_REF, nowMs = Date.now(), token } = {},
) {
  const ownTokenInfo = token !== undefined ? { token, persist: false } : resolveOwnToken(mainDir);
  const ownToken = ownTokenInfo.token;
  // Persist a freshly-minted file-lane token only once OUR acquire actually wins — see
  // resolveOwnToken's doc for why a losing acquire must not write one.
  const win = (result) => {
    if (ownTokenInfo.persist && ownToken) writeTokenFile(mainDir, ownToken);
    return result;
  };

  const message = buildLockMessage({
    // COORD_ACCOUNT is the optional per-cloud-environment identity (trigger bodies are
    // byte-identical across accounts, so a nameable holder can only come from the env).
    account: account || process.env.COORD_ACCOUNT || hostname(),
    startedAt: new Date(nowMs).toISOString(),
    host: hostname(),
    token: ownToken,
  });
  const tree = git(mainDir, ['mktree'], { input: '' }).trim();
  const sha = git(mainDir, ['commit-tree', tree, '-m', message]).trim();

  // plan 3756: a sweep running PRE-flip code holds `refs/coord/spec-sweep-lock` and cannot see
  // the branch-shaped ref at all, so it can never yield to us. Winning the new ref while it
  // holds the old one would run two sweeps over the board at once — the exact thing this lock
  // exists to prevent. Only for the DEFAULT ref: an explicit --ref means the caller is driving
  // one specific lock.
  if (ref === LOCK_REF) {
    const legacyHolder = readLockHolder(mainDir, LEGACY_LOCK_REF);
    if (legacyHolder && !isStale(legacyHolder.started, ttlMinutes, nowMs)) {
      return { won: false, busy: true, holder: legacyHolder };
    }
  }

  // Two identical rounds so the released-in-the-window retry flows through the SAME
  // holder/freshness judgment as the first attempt (review 1915 F6) — never a bare
  // re-push with its own divergent semantics.
  for (let attempt = 0; attempt < 2; attempt++) {
    // Unheld fast path: a plain non-force create wins or is rejected non-ff.
    const create = tryPush(mainDir, [`${sha}:${ref}`]);
    if (create.won) return win({ won: true, sha });
    if (create.error) return { won: false, error: true, stderr: create.stderr };

    // plan 3756 review round 4: ask about THIS ref only. The dual-namespace fallback belongs in
    // the legacy pre-check above, not here — round 3 read the fallback holder and skipped the
    // round whenever it came from the retired ref, which meant a STALE legacy lock plus a
    // released husk on the new ref looped until the retry budget ran out and reported "locking
    // unavailable" forever. The husk must stay reclaimable regardless of what the retired ref says.
    const holder = readLockHolder(mainDir, ref, { fallback: false });
    if (!holder) {
      // plan 3756: distinguish "the ref is gone" from "the ref is a RELEASED husk". A released
      // lock keeps its ref, so the create above is rejected non-ff forever and the retry loop
      // would fall through to "locking unavailable" on every single sweep — the lock would
      // work exactly once in the repo's lifetime. Fast-forward over the husk instead, pinned to
      // its sha so a rival that re-took the lock in the window still wins.
      const husk = readLockTip(mainDir, ref);
      if (husk && isLockReleaseMessage(husk.body)) {
        const overHusk = git(mainDir, ['commit-tree', tree, '-p', husk.sha, '-m', message]).trim();
        const took = tryPush(mainDir, [`${overHusk}:${ref}`]);
        if (took.won) return win({ won: true, sha: overHusk });
        if (took.error) return { won: false, error: true, stderr: took.stderr };
        continue; // a rival got there first — re-judge on the next round
      }
      // Rejected create but no ref visible at all: the holder released in the window between
      // our push and this read → loop for one clean retry. If the SECOND round lands here too,
      // fall out of the loop: a create rejected while the ref is absent is by definition
      // NOT contention (see the infra classification below).
      continue;
    }
    if (!isStale(holder.started, ttlMinutes, nowMs)) {
      // plan 4083: a live holder whose token equals OUR OWN is not a sibling — it is a
      // hidden or lost result from an acquire this same identity already won (the
      // 2026-09-20 incident shape). Answer with a win, not busy, so a re-run acquire is
      // idempotent instead of self-deadlocking for the rest of the TTL. The sha handed
      // back is the HELD lock's sha (not our throwaway `sha` above, which never got
      // pushed), so a later `release --sha` targets the ref's real tip. `ownToken &&`
      // guards a legacy (token-less) holder, whose `token` parses to `null` and must
      // never equal a falsy ownToken either.
      if (ownToken && holder.token === ownToken) {
        return win({ won: true, reacquired: true, sha: holder.sha });
      }
      return { won: false, busy: true, holder };
    }

    // Stale (a crashed sweep) → CAS takeover: land ONLY if the ref still points at the
    // stale sha. Two simultaneous takeovers resolve to one winner; the loser sees the
    // rejection ("stale info" → lost) and re-reads the now-fresh holder.
    const takeover = tryPush(mainDir, [`--force-with-lease=${ref}:${holder.sha}`, `${sha}:${ref}`]);
    if (takeover.won) return win({ won: true, sha, tookOverFrom: holder });
    if (takeover.error) return { won: false, error: true, stderr: takeover.stderr };
    return { won: false, busy: true, holder: readLockHolder(mainDir, ref) };
  }

  // Both create pushes were rejected while ls-remote showed the ref ABSENT both times.
  // Genuine contention needs the ref to exist at both push instants yet vanish for both
  // reads — vanishingly unlikely; the real-world cause is a remote that refuses
  // coord-ref creates without a per-ref permission message (a proxy 403 variant). Treat
  // as locking-unavailable (exit 4 → the sweep proceeds unlocked, review 1915 F0), which
  // also degrades gracefully if the unlikely race DID happen.
  return {
    won: false,
    error: true,
    stderr:
      `create push to ${ref} rejected twice while ls-remote shows the ref absent — ` +
      `the remote refuses coord-ref creates (proxy sandbox without the configured PAT?), not lock contention.`,
  };
}

/**
 * Release the lock — owner-checked unless `force`. Never throws contention; returns:
 *   { released: true }                — our lock deleted
 *   { released: false, absent: true } — already gone (idempotent success)
 *   { released: false, notHolder: true, holder } — someone else holds it; left intact
 *   { released: false, error: true, stderr }     — push infra failure
 *
 * `token` overrides holder-identity resolution (tests; a caller that already knows its
 * own token) — omit it to use resolveOwnToken(mainDir)'s env-then-file default.
 */
export function releaseLock(mainDir, { sha, ref = LOCK_REF, force = false, token } = {}) {
  const holder = readLockHolder(mainDir, ref);
  if (!holder) return { released: false, absent: true };
  // plan 3756 review: act on the ref that ANSWERED, not the one we asked about. readLockHolder
  // falls back to the retired namespace, so asking about the default ref can return a LEGACY
  // holder — and releasing that with the new ref's name and strategy would append a marker to
  // the wrong ref while the real lock stayed held.
  ref = holder.ref ?? ref;
  if (!force) {
    if (sha) {
      // Unchanged CAS path: the acquire sha in hand is the ground truth, token or not.
      if (holder.sha !== sha) return { released: false, notHolder: true, holder };
    } else {
      // plan 4083: the incident session had no sha to pass (it never saw its own acquire
      // output) — a second identity path lets it release anyway, gated on holder identity
      // instead of the sha it never had. No token resolvable (env unset AND the file lane
      // is closed, e.g. on the shared main checkout) degrades to today's throw; a token
      // that resolves but does not match the holder degrades to today's notHolder refusal.
      const ownToken = token !== undefined ? token : resolveOwnToken(mainDir).token;
      if (!ownToken)
        throw new Error('spec-sweep-lock: release needs --sha <acquire sha> (or --force)');
      if (holder.token !== ownToken) return { released: false, notHolder: true, holder };
      // else: our own token matches the live holder — fall through to the release write.
    }
  }
  // plan 3756: release the ref the way ITS OWN namespace expects. A branch-shaped lock is
  // released by appending a marker, because the sandbox proxy refuses deletes outright — which
  // is the whole reason this lock moved namespaces. A pre-flip `refs/coord/*` lock is still
  // deleted, since a marker there would read as a live holder to any pre-flip sweep.
  //
  // Either way the CAS survives: the delete is lease-pinned, and the marker is PARENTED on the
  // sha we just read, so it fast-forwards only while the ref still points at our lock. An
  // expired holder returning late can never clobber its successor.
  if (releaseStrategyFor(ref) === 'delete') {
    const del = tryPush(mainDir, [`--force-with-lease=${ref}:${holder.sha}`, `:${ref}`]);
    if (del.won) return { released: true };
    if (del.error) return { released: false, error: true, stderr: del.stderr };
    return { released: false, notHolder: true, holder: readLockHolder(mainDir, ref) };
  }
  const tree = git(mainDir, ['mktree'], { input: '' }).trim();
  const marker = buildLockReleaseMessage({ host: hostname(), iso: new Date().toISOString() });
  const tomb = git(mainDir, ['commit-tree', tree, '-p', holder.sha, '-m', marker]).trim();
  const rel = tryPush(mainDir, [`${tomb}:${ref}`]);
  if (rel.won) return { released: true };
  if (rel.error) return { released: false, error: true, stderr: rel.stderr };
  return { released: false, notHolder: true, holder: readLockHolder(mainDir, ref) };
}

/** Read-only status: { held: false } | { held: true, sha, account, started, host, ageMinutes, stale } */
export function lockStatus(
  mainDir,
  { ttlMinutes = DEFAULT_TTL_MINUTES, ref = LOCK_REF, nowMs = Date.now() } = {},
) {
  const holder = readLockHolder(mainDir, ref);
  if (!holder) return { held: false };
  const t = Date.parse(holder.started ?? '');
  return {
    held: true,
    ...holder,
    ageMinutes: Number.isNaN(t) ? null : Math.round((nowMs - t) / 60_000),
    stale: isStale(holder.started, ttlMinutes, nowMs),
  };
}

// --- CLI -------------------------------------------------------------------------

function main() {
  const { cmd, flags } = parseFlags(process.argv.slice(2), {
    label: 'spec-sweep-lock',
    subcommand: true,
    value: ['account', 'ttl-minutes', 'sha', 'ref'],
    boolean: ['force'],
  });
  const mainDir = resolveMain();
  const ref = flags.ref || LOCK_REF;
  const ttlMinutes = flags['ttl-minutes'] ? Number(flags['ttl-minutes']) : DEFAULT_TTL_MINUTES;
  // Floor of 5: a tiny TTL on the REAL ref makes every sibling's fresh lock look stale
  // and defeats the mutex outright (review 1915 F4). Tests that need sub-minute TTLs
  // drive acquireLock() directly — the CLI never legitimately does.
  if (!Number.isFinite(ttlMinutes) || ttlMinutes < 5) {
    console.error(
      `spec-sweep-lock: invalid --ttl-minutes "${flags['ttl-minutes']}" (must be a number ≥ 5)`,
    );
    return 2;
  }

  if (cmd === 'acquire') {
    const r = acquireLock(mainDir, { account: flags.account, ttlMinutes, ref });
    if (r.won) {
      console.error(
        `spec-sweep-lock: ACQUIRED ${ref} (sha ${r.sha.slice(0, 8)})` +
          (r.reacquired
            ? ' — re-acquired our OWN already-held lock (idempotent; not a sibling)'
            : r.tookOverFrom
              ? ` — took over a STALE lock from ${r.tookOverFrom.account ?? 'unknown'} (started ${r.tookOverFrom.started ?? '?'})`
              : ''),
      );
      console.log(JSON.stringify(r));
      return 0;
    }
    if (r.busy) {
      const h = r.holder || {};
      console.error(
        `SPEC-SWEEP: skipped, lock held by ${h.account ?? 'unknown'} since ${h.started ?? '?'} — a sibling sweep is running this cycle.`,
      );
      console.log(JSON.stringify(r));
      return 3;
    }
    console.error(
      `spec-sweep-lock: locking UNAVAILABLE (push to ${ref} failed for a non-contention reason — ` +
        `likely a proxy-only sandbox without the configured PAT). Proceed UNLOCKED and say so in the summary.\n${r.stderr}`,
    );
    console.log(JSON.stringify({ won: false, error: true }));
    return 4;
  }

  if (cmd === 'release') {
    const r = releaseLock(mainDir, { sha: flags.sha, ref, force: flags.force === true });
    if (r.released) console.error(`spec-sweep-lock: released ${ref}`);
    else if (r.absent) console.error(`spec-sweep-lock: ${ref} already absent — nothing to release`);
    else if (r.notHolder)
      console.error(
        `spec-sweep-lock: NOT released — ${ref} is held by ${r.holder?.account ?? 'unknown'} ` +
          `(sha ${r.holder?.sha?.slice(0, 8) ?? '?'}), ` +
          (flags.sha
            ? `not by --sha ${String(flags.sha).slice(0, 8)}`
            : 'not by our own holder-identity token') +
          '; left intact.',
      );
    else console.error(`spec-sweep-lock: release push failed:\n${r.stderr}`);
    console.log(JSON.stringify(r));
    // Idempotent by design: absent/not-holder are clean outcomes for an ending sweep.
    // Only a real push-infra failure is worth a nonzero exit (the prompt just logs it).
    return r.error ? 4 : 0;
  }

  if (cmd === 'status') {
    console.log(JSON.stringify(lockStatus(mainDir, { ttlMinutes, ref })));
    return 0;
  }

  console.error('spec-sweep-lock: unknown command (use acquire | release | status)');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let code;
  try {
    code = main();
  } catch (e) {
    console.error('spec-sweep-lock:', e.message);
    code = 2;
  }
  process.exit(code);
}
