// scripts/coord/review-round-cap.mjs — the local-only review-launch ledger and shared cap wording.
// Never push or mirror refs/review-rounds/* to origin: the ref exists only to survive local
// worktree teardown and to coordinate sessions that already share one Git common directory.
//
// OPERATOR RULING 2026-08-30: the gate denies the FIFTH launch, not the fourth:
//   launch 1 = initial review  -> ALLOW
//   launch 2 = delta round 1   -> ALLOW
//   launch 3 = delta round 2   -> ALLOW
//   launch 4 = delta round 3   -> ALLOW (at the cap)
//   launch 5                  -> DENY
// In other words, deny only when launchOrdinal > AT_CAP_ROUND.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planIdOfRowSlug } from './board-lib.mjs';
// plan 3967: the ONE stampable lane value + its vocabulary constant — never a second `'fast'`
// literal here that could drift from the stamp reader/writer.
import { LANE_FAST } from './read-plan-stamps.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';
import { slugFromBranch } from './redgreen-lib.mjs';
import {
  COORD_FALLBACK_IDENTITY,
  GIT_NONINTERACTIVE_ENV,
  errText,
  isRefLockRace,
  isRefUpdateRace,
  sleepSync,
} from './coord-git.mjs';
// plan 3618 finding d6a14d: THE ONE range/end-ref parser — never a second copy here.
import { endRefOf } from './git-range.mjs';
// plan 3618 finding f0b34c: THE ONE `git worktree list --porcelain` parser — never a second one.
import { parseWorktreePorcelain } from './worktree-porcelain.mjs';

// plan 2864: the review-round cap, spelled ONCE. `docs/coord/review.md`
// § Stopping rule sanctions three DELTA rounds on top of the initial review, so the record that
// lands AT the cap is round 1 + 3 = 4 and anything past it is beyond the cap. Both warnings are
// PHRASED with this constant rather than with a spelled-out "three"/"third" beside it: a
// spelled-out word is still a second copy of the number, and a re-bench that edits one and not
// the other leaves the message lying to the reader (the cap already moved 2 -> 3 on the
// 2026-08-05 bench that specced this plan).
export const SANCTIONED_DELTA_ROUNDS = 3;
export const AT_CAP_ROUND = 1 + SANCTIONED_DELTA_ROUNDS;
export const PAST_CAP_EXITS = ['run', 'simplify', 'park'];

// plan 4078 T1 — operator-pinned 2026-09-20: the fix brief becomes a gate from round 2 on, above
// this small-delta carve-out. A fix whose delta is at or under this many changed lines (added +
// deleted, `git diff --numstat`) needs no brief — the escape IS producing the brief, so the
// carve-out has to stay small enough that "just write the brief" is still the cheaper move for
// anything bigger. See fixBriefRequired below.
export const FIX_BRIEF_EXEMPT_CHANGED_LINES = 10;

// plan 3967: the `lane: fast` stamp's delta-round count — ZERO, so a fastlane plan's cap is round
// 1 alone (`1 + 0`). SANCTIONED_DELTA_ROUNDS/AT_CAP_ROUND above stay the DEFAULT-lane constants,
// untouched value and untouched semantics for every existing (unstamped) call site — this is an
// ADDITIVE function beside them, never a redefinition. `lane` is whatever `readLaneById`/`readLane`
// hand back: `'fast'` or `null` (any other value is not a real stamp — readLane already collapsed
// it to `null` at the read seam, never re-checked here).
export function sanctionedDeltaRounds(lane) {
  return lane === LANE_FAST ? 0 : SANCTIONED_DELTA_ROUNDS;
}

// plan 3618: the review-level union, moved here from the guard hook so the shared target
// resolver below (which needs to recognize a `<level> <branch>` shaped token pair) and the
// hook's own Workflow-invocation parsing read the SAME set. The hook re-exports this for its
// existing external callers/tests.
export const REVIEW_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function validatePastCapReason(reason) {
  if (typeof reason !== 'string' || !reason.trim()) {
    return { accepted: false, message: '--past-cap requires a non-empty reason' };
  }
  const exit = PAST_CAP_EXITS.find((candidate) => reason.startsWith(`${candidate}:`));
  if (!exit) {
    return {
      accepted: false,
      message: `--past-cap reason must start with one of: ${PAST_CAP_EXITS.join(', ')}`,
    };
  }
  if (!reason.slice(exit.length + 1).trim()) {
    return {
      accepted: false,
      message: '--past-cap reason must include non-empty text after the exit prefix',
    };
  }
  return { accepted: true, reason };
}

// The bare exit prefix of a --past-cap reason ('run' / 'simplify' / 'park'), or null for an
// absent/malformed reason. Shares the same PAST_CAP_EXITS scan validatePastCapReason uses so
// the two can never disagree about what a reason's exit is.
export function exitOfPastCapReason(reason) {
  if (typeof reason !== 'string') return null;
  return PAST_CAP_EXITS.find((candidate) => reason.startsWith(`${candidate}:`)) ?? null;
}

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_CAS_ATTEMPTS = 8;

// `--no-optional-locks` (plan 3974 review round 2, finding 1924f4) is a GLOBAL git option —
// harmless on every verb this runner is asked to make, so it is prepended unconditionally rather
// than threaded per call site. This is the default `runGitFn` for `hasTrackedChanges` /
// `hasDiffOrTrackedChanges` below, whose `git diff --quiet HEAD` reads are exactly the poll shape
// that can take the index lock a concurrent land rebase needs — the mirror fix to
// scripts/hooks/review-round-cap-guard.mjs's own `runGit` (plan 3974 T1, finding f234fa), which
// only covered the hook's wrapper, not this module's.
function runGit(repoRoot, args, { identity = false } = {}) {
  return execFileSync('git', ['--no-optional-locks', '-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitRepoIsolatedEnv({
      ...(identity ? COORD_FALLBACK_IDENTITY : {}),
      ...GIT_NONINTERACTIVE_ENV,
    }),
  });
}

function currentRefValue(repoRoot, ref) {
  try {
    return runGit(repoRoot, ['rev-parse', '--verify', '--quiet', ref]).trim() || null;
  } catch (error) {
    if (error?.status === 1) return null;
    throw error;
  }
}

function countRevision(repoRoot, revision) {
  return Number.parseInt(runGit(repoRoot, ['rev-list', '--count', revision]).trim(), 10);
}

function isCreateRefRace(message) {
  return /cannot lock ref .*reference already exists/i.test(message);
}

export function reviewRoundsRef(planId) {
  return `refs/review-rounds/${planId}`;
}

export function readLaunchCount(repoRoot, planId) {
  const ref = reviewRoundsRef(planId);
  if (!currentRefValue(repoRoot, ref)) return 0;
  return countRevision(repoRoot, ref);
}

export function effectiveLaunchFloor(ledgerCount, markerRoundFloor = 0) {
  const normalizedLedger = Number.isSafeInteger(ledgerCount) && ledgerCount > 0 ? ledgerCount : 0;
  const normalizedMarker =
    Number.isSafeInteger(markerRoundFloor) && markerRoundFloor > 0 ? markerRoundFloor : 0;
  return Math.max(normalizedLedger, Math.min(normalizedMarker, AT_CAP_ROUND));
}

// plan 3757: `identityKey` (when supplied) is written as its OWN line, BEFORE the
// `past-cap-reason:` block — never after. `ledgerEntryPastCapReason` below parses a
// `past-cap-reason:` marker line and treats EVERYTHING after it (to end of body) as the reason
// text; a `review-identity:` line placed after that marker would be swallowed into the reason
// instead of being read back as an identity.
function launchCommitMessage({ ordinal, branch, timestamp, pastCapReason, identityKey }) {
  let message = `review-launch:${ordinal}\n` + `branch:${branch}\n` + `launched-at:${timestamp}`;
  if (identityKey) {
    message += `\nreview-identity:${identityKey}`;
  }
  if (pastCapReason !== undefined && pastCapReason !== null) {
    message += `\npast-cap-reason:\n${pastCapReason}`;
  }
  return message;
}

// The `review-identity:<key>` line of a ledger entry body, or null when the entry carries none
// (every entry minted before plan 3757, or a caller that never passed an `identityKey`).
// Mirrors `ledgerEntryPastCapReason`'s shape: a single-line value, read back by prefix rather
// than by a fixed line index, so it is unaffected by whichever block (if any) follows it.
//
// plan 3757 fix round 1 (gpt-review keys 74676c / 68a1c0 / 9c0b70): the scan STOPS at the
// `past-cap-reason:` marker. Everything after that marker is free-form operator prose that runs
// to the end of the body (see `ledgerEntryPastCapReason`), so a reason whose own text contains a
// line starting `review-identity:` would otherwise be read back as this entry's identity — which
// would let the wording of an escape reason decide whether a LATER launch counts as a resume of
// this round (and so whether it is charged one). Only a line written above the marker, by
// `launchCommitMessage` itself, is an identity.
export function ledgerEntryIdentityKey(body) {
  const lines = body.split('\n');
  const markerIndex = lines.indexOf('past-cap-reason:');
  const metadataLines = markerIndex === -1 ? lines : lines.slice(0, markerIndex);
  const line = metadataLines.find((l) => l.startsWith('review-identity:'));
  return line ? line.slice('review-identity:'.length) : null;
}

// The ledger's escape state (trailing-escape count + last exit) AS OF a given revision — a ref
// name, a raw sha, or null/falsy for an empty ledger. `git log` accepts a raw sha exactly like a
// ref name, so this same reader serves both the "current ref tip" public API below AND
// recordLaunch's per-CAS-attempt snapshot (finding D2/00f90c: one read, derives both signals).
function ledgerBodiesForRevision(repoRoot, revision) {
  if (!revision) return [];
  // %x00 between entries: a commit body can itself contain blank lines, so a newline-based
  // split cannot tell "end of this entry" from "blank line inside it".
  const raw = runGit(repoRoot, ['log', '--format=%B%x00', revision]);
  return raw
    .split('\0')
    .map((body) => body.replace(/^\n+/, '').replace(/\n+$/, ''))
    .filter((body) => body.length > 0);
}

function ledgerEntryPastCapReason(body) {
  const lines = body.split('\n');
  const markerIndex = lines.indexOf('past-cap-reason:');
  return markerIndex === -1 ? null : lines.slice(markerIndex + 1).join('\n');
}

// Derives BOTH the trailing-escape count and the newest entry's exit from ONE list of ledger
// bodies (newest first) — never two separate walks of the same log.
function escapeStateFromBodies(bodies) {
  let consecutiveEscapes = 0;
  for (const body of bodies) {
    if (ledgerEntryPastCapReason(body) === null) break;
    consecutiveEscapes += 1;
  }
  const lastExit =
    bodies.length === 0 ? null : exitOfPastCapReason(ledgerEntryPastCapReason(bodies[0]));
  return { consecutiveEscapes, lastExit };
}

export function recordLaunch(
  repoRoot,
  planId,
  {
    branch,
    launchFloor = 0,
    pastCapReason,
    identityKey,
    // plan 3967 fix round 1 (findings 8/9/10/13/14): defaults to `null` so every pre-existing
    // caller (this file's own tests included) that never passes it keeps its EXACT default-cap
    // behaviour — `isPastCap(ordinal, null) === isPastCap(ordinal)` numerically. Threaded into
    // both the internal past-cap check below AND `pastCapEscapeDecision`, so a `lane: fast`
    // plan's consecutive-`run:` escape rule engages at ITS cap (round 2), not the default cap
    // (round 5) — the gap the six findings above all named the same way: the ledger path
    // (`recordLaunch`) stayed lane-blind even after `isPastCap` itself learned the `lane` arg.
    lane = null,
    _beforeUpdate,
    _sleep = sleepSync,
    _maxAttempts = MAX_CAS_ATTEMPTS,
  } = {},
) {
  const ref = reviewRoundsRef(planId);
  let lastError;

  for (let attempt = 0; attempt < _maxAttempts; attempt++) {
    const oldSha = currentRefValue(repoRoot, ref);
    const oldCount = oldSha ? countRevision(repoRoot, oldSha) : 0;

    // plan 3757: key the round-cap ledger on the REVIEW IDENTITY, not on invocation count.
    // Resuming a review whose (range, end sha) — the SAME identity `gpt-review.mjs` fingerprints
    // the checkpoint on — has not changed is one round, however many foreground calls it takes
    // to finish; only a genuinely NEW identity should mint a new ledger entry. When the newest
    // existing entry already carries this identity, hand back its ordinal untouched: no new
    // commit, no ref update, and (since this returns before the ordinal/isPastCap check below)
    // no risk of a resume alone tripping the cap — the plan-3632 symptom this closes.
    if (identityKey && oldSha) {
      const newestBody = ledgerBodiesForRevision(repoRoot, oldSha)[0];
      if (newestBody && ledgerEntryIdentityKey(newestBody) === identityKey) {
        // plan 3757 fix round 1 (gpt-review keys 624ddf / 5b9a8e): report the FLOOR-ADJUSTED
        // ordinal, not the raw ledger count. `effectiveLaunchFloor` is the same clamp the normal
        // path applies one block below; skipping it here would let a resume silently un-apply a
        // migration marker's floor ("treat the next launch as at least round N") purely by being
        // a resume. No ledger commit and no ref update either way — it is the same round.
        //
        // The RESUME SHAPE is an object, deliberately carrying an explicit `denied: false`
        // (gpt-review key d95e77): a resume of an already-at-cap round must not be denied, since
        // the cap governs LAUNCHES and this is not one — the review it resumes was authorised
        // when its round was minted, and any real code change moves the tip, which changes the
        // identity and mints a fresh round that the cap does govern. Pre-3757 readers that treat
        // "an object" as a denial positionally (`scripts/hooks/review-round-cap-guard.mjs`) can
        // never reach this branch — they pass no `identityKey` at all — but the explicit
        // `denied: false` keeps any reader that checks the field correct regardless.
        return {
          ordinal: effectiveLaunchFloor(oldCount, launchFloor),
          resumed: true,
          denied: false,
        };
      }
    }

    // Reapply the marker floor on every CAS attempt. A competitor can create the previously
    // absent ref between attempts; that race must not erase the migration floor.
    // A marker at round 4 and one at round 999 have identical policy meaning: the next launch is
    // past the cap. The shared helper applies that clamp and treats the marker as a FLOOR even
    // after ledger entries exist.
    const ordinal = effectiveLaunchFloor(oldCount, launchFloor) + 1;

    // plan 3618 finding D2: decide the second-consecutive-`run:` denial from THIS SAME oldSha
    // snapshot, inside the CAS loop — never a separate read before/after the CAS. A denied
    // attempt returns here WITHOUT calling update-ref, so it never pollutes the ledger (the
    // pre-existing "at cap, no --past-cap at all" denial is a DIFFERENT, deliberately-recorded
    // case decided by the caller from the returned ordinal — untouched by this). Only bother
    // reading the ledger at all once this launch is actually past the cap — the common case
    // (ordinals 1..AT_CAP_ROUND) never pays for it.
    if (isPastCap(ordinal, lane)) {
      const { consecutiveEscapes, lastExit } = escapeStateFromBodies(
        ledgerBodiesForRevision(repoRoot, oldSha),
      );
      if (
        pastCapEscapeDecision({
          launchOrdinal: ordinal,
          pastCapReason,
          consecutiveEscapes,
          lastExit,
          lane,
        })
      ) {
        return { denied: true, ordinal, consecutiveEscapes: consecutiveEscapes + 1 };
      }
    }

    let newSha = oldSha;
    for (let currentOrdinal = oldCount + 1; currentOrdinal <= ordinal; currentOrdinal += 1) {
      const message = launchCommitMessage({
        ordinal: currentOrdinal,
        branch,
        timestamp: new Date().toISOString(),
        identityKey: currentOrdinal === ordinal ? identityKey : null,
        pastCapReason: currentOrdinal === ordinal ? pastCapReason : null,
      });
      const commitArgs = ['commit-tree', EMPTY_TREE_SHA];
      if (newSha) commitArgs.push('-p', newSha);
      commitArgs.push('-m', message);
      newSha = runGit(repoRoot, commitArgs, { identity: true }).trim();
    }

    _beforeUpdate?.({ attempt, ref, oldSha, newSha, ordinal });

    try {
      runGit(repoRoot, ['update-ref', ref, newSha, oldSha ?? '']);
      return ordinal;
    } catch (error) {
      const messageText = errText(error);
      if (
        !isRefLockRace(messageText) &&
        !isRefUpdateRace(messageText) &&
        !(oldSha === null && isCreateRefRace(messageText))
      ) {
        throw error;
      }
      lastError = error;
      _sleep(25 * (attempt + 1));
    }
  }

  const error = new Error(
    `review-round-cap: ${ref} remained contended after ${_maxAttempts} attempts`,
  );
  error.cause = lastError;
  throw error;
}

// `lane` defaults to `null` so every pre-existing call site (this file's own `recordLaunch`
// internal check included — plan 3967's Do-not-touch list — and every caller that predates the
// fastlane stamp) keeps its exact behaviour: `sanctionedDeltaRounds(null) === SANCTIONED_DELTA_ROUNDS`,
// so `1 + sanctionedDeltaRounds(null) === AT_CAP_ROUND` numerically, byte-identical to before.
export function isPastCap(launchOrdinal, lane = null) {
  return launchOrdinal > 1 + sanctionedDeltaRounds(lane);
}

// `lane` (plan 3967) defaults to `null`, keeping the message byte-identical to every pre-existing
// caller that never passes it: `laneNote` is `''` unless `lane === LANE_FAST`, so the header below
// is unchanged for the default lane.
export function capDenialMessage({
  planId,
  launchOrdinal,
  pastCapFlagName,
  consecutiveEscapes,
  lane = null,
}) {
  const laneNote =
    lane === LANE_FAST
      ? `plan ${planId} is \`lane: fast\`: one review round, then park the rest with ` +
        `\`scripts/park-review-findings.mjs\`.\n`
      : '';
  const header =
    `review-round cap: denying launch ${launchOrdinal} for plan ${planId}; ` +
    `local launch ledger: ${reviewRoundsRef(planId)}.\n${laneNote}`;
  // plan 3618: a SECOND consecutive `run:` denial gets its own wording — the ordinary at-cap
  // message still offers "escape with --past-cap", which is exactly the escape this denial
  // exists to close. `consecutiveEscapes` here is the INCLUSIVE count (this attempt counted).
  //
  // finding 348c84 (D6): `consecutiveEscapes` counts TRAILING escapes of ANY exit (readConsecu
  // tiveEscapes' own spec, E1) — not "N run: escapes". After `park:` then `run:` then `run:`,
  // this denial fires (two `run:` in a row) but the count is 3. The wording below reports the
  // count as "escape #N in the streak" and separately, always literally, calls out that the
  // last two both named `run:` — never "N run: escapes", which the raw number would misstate.
  if (consecutiveEscapes) {
    return (
      header +
      `This is past-cap escape #${consecutiveEscapes} in the current streak, and the last two ` +
      `in a row both named "run:" — a second consecutive "run:" is a mode-switch failure, not ` +
      `another round (docs/coord/review.md § Stopping rule — the exit from a review loop is a ` +
      `change of mode).\n` +
      `Two real exits remain:\n` +
      `1. Disposition the remainder — wontfix it, or route it to a plan — then land.\n` +
      `2. Park it, if it genuinely cannot be resolved now.\n` +
      `"run:" is bounded to one consecutive use; it does not apply again here.`
    );
  }
  return (
    header +
    `At the cap, STOP reviewing and pick one, in this order:\n` +
    `1. Run it.\n` +
    `2. Simplify or delete the fragile construct\n` +
    `3. Park it\n` +
    `Escape only with ${pastCapFlagName} "<reason>".`
  );
}

// ─── Consecutive-escape counting (plan 3618) ───────────────────────────────
// `recordLaunch` already writes `past-cap-reason:\n<reason>` into the ledger commit body when a
// launch escapes. These are the STANDALONE public readers — used by `record-review.mjs`'s
// advisory warning (D4), which fires BEFORE any launch attempt and so has no CAS snapshot to
// read from — built on the exact same ledgerBodiesForRevision/escapeStateFromBodies pair
// recordLaunch's own in-CAS decision uses (finding 00f90c: one read, both signals, one
// implementation). `recordLaunch` itself never calls these — it reads its OWN oldSha snapshot
// directly, which is what keeps its decision atomic with the CAS (finding D2).
function readLedgerBodies(repoRoot, planId) {
  const ref = reviewRoundsRef(planId);
  return currentRefValue(repoRoot, ref) ? ledgerBodiesForRevision(repoRoot, ref) : [];
}

// plan 3618 round 2 (R3, findings 72779b/4ab4b6/90a435): the ONE combined read — both signals
// from ONE ledger walk. `readConsecutiveEscapes`/`lastEscapeExit` below are now thin wrappers
// over this, kept (and still independently callable/injectable) because existing callers and
// tests already depend on the two names; a caller that wants BOTH signals should call this
// instead of both wrappers, which would otherwise re-walk the ledger once per wrapper.
export function readEscapeState(repoRoot, planId) {
  return escapeStateFromBodies(readLedgerBodies(repoRoot, planId));
}

// The number of TRAILING ledger entries (newest backwards) that carry a past-cap-reason.
export function readConsecutiveEscapes(repoRoot, planId) {
  return readEscapeState(repoRoot, planId).consecutiveEscapes;
}

// The exit prefix ('run' / 'simplify' / 'park') of the ledger's newest entry, or null when the
// ledger is empty or its newest entry did not escape.
export function lastEscapeExit(repoRoot, planId) {
  return readEscapeState(repoRoot, planId).lastExit;
}

// The ONE deny predicate for "a second consecutive run: escape" — both callers
// (`scripts/hooks/review-round-cap-guard.mjs`'s `evaluate()` and `reviewLaunchCapDecision` in
// `scripts/gpt-review.mjs`) call this rather than re-implementing it. Deliberately narrow: a
// FIRST `run:` (lastExit not 'run') and a `simplify:`/`park:` followed by `run:` (different
// exits) both pass — the bound is ONE consecutive `run:`, not a ban on `run:` returning later.
export function pastCapEscapeDecision({
  launchOrdinal,
  pastCapReason,
  consecutiveEscapes,
  lastExit,
  // plan 3967 fix round 1: same `lane = null` default/threading as recordLaunch/isPastCap — a
  // caller that never passes it keeps the exact default-cap decision.
  lane = null,
}) {
  void consecutiveEscapes; // read for callers' own message-formatting use; not a gate input
  return (
    isPastCap(launchOrdinal, lane) &&
    exitOfPastCapReason(pastCapReason) === 'run' &&
    lastExit === 'run'
  );
}

// ─── Shared review-target resolution (plan 3618, addendum item A) ─────────────────────────
// A '..'/'...' range names two refs; the launch is charged to what actually gets reviewed — the
// END ref — never rejected outright (the round-7 fix this replaces dropped every ranged launch
// out of the guard entirely). `endRefOf` is THE ONE range parser (finding d6a14d) — it also
// resolves a malformed trailing range (`abc..`) to `HEAD` rather than leaving the pre-range text
// intact, which is what let a malformed token still parse as a (wrong) plan branch before.

// plan 3618 finding D3: ONE base-ref chain, matching the Workflow scope phase's own step-a
// verbatim (`.claude/workflows/sonnet-review.js`: "'git merge-base origin/master HEAD' (fall
// back to the upstream branch, then 'main', then 'HEAD~1' if origin/master is unavailable)") —
// never local `master` bare (branch-hygiene.md: "never local master — it carries other
// sessions' unpushed commits"; `origin/master` here IS the remote-tracking ref, not the local
// branch). Each candidate must ALSO have a usable merge base with HEAD (finding 3b89eb) — a
// ref that merely exists but shares no history with this checkout must not win.
const BASE_REF_CANDIDATES = ['origin/master', '@{upstream}', 'main', 'HEAD~1'];

// plan 3618 round 2 finding 6ea3ab: resolve the winning candidate to the raw SHA it names, once,
// here in the main checkout — never the bare candidate NAME. `@{upstream}` (and, in principle,
// any of these names) is relative to whichever checkout evaluates it; the Workflow's own step f
// reuses this value verbatim in a `git -C <sibling worktree>` call, where `@{upstream}` would
// resolve against the SIBLING's own branch config instead of the one this function just checked.
// A resolved sha means the same thing regardless of which worktree's cwd later evaluates it,
// because every worktree under this repo shares one object database.
function resolveBaseRef(repoRoot, runGitFn) {
  for (const candidate of BASE_REF_CANDIDATES) {
    try {
      const sha = String(
        runGitFn(repoRoot, ['rev-parse', '--verify', '--quiet', candidate]),
      ).trim();
      if (!sha) continue;
      runGitFn(repoRoot, ['merge-base', sha, 'HEAD']);
      return sha;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// True when `entry` (a scripts/coord/worktree-porcelain.mjs entry) is a live, checked-out, non-current
// sibling — never the detached, locked/prunable-flagged, or "IS the branch we're already on"
// shapes (findings f0b34c/2eb1f3/1703c4). A locked worktree is excluded because `git worktree
// remove`/prune treat it as off-limits for automated action, and this hunt already treats a
// worktree it picks as one whose diff it is safe to materialize and act on.
function isLiveSiblingCandidate(entry, currentBranch) {
  return (
    Boolean(entry.branch) &&
    !entry.detached &&
    !entry.locked &&
    !entry.prunable &&
    entry.branch !== currentBranch
  );
}

// True when `cwd` carries uncommitted TRACKED changes — `git diff --quiet HEAD` exits 1 when
// there IS a difference between the index/worktree and HEAD for tracked files, 0 when there is
// none. Deliberately NOT `git status --porcelain` (finding e446c6): porcelain's `??` lines also
// count untracked files, but the Workflow's own diff materialization (`git diff`, with or
// without `--include-worktree`) never includes untracked content — a sibling whose only change
// is an untracked file would be charged a launch for a diff that, when actually materialized, is
// empty. Any OTHER failure (no HEAD, a git error) is treated as "not a candidate" rather than a
// false positive. Exported so `gpt-review.mjs`'s `collectAheadWorktrees` (the empty-range
// diagnostic) can share this EXACT predicate rather than a second hand-rolled one (finding
// f146f0) — its own `runGitFn` binds cwd differently, so it adapts the call rather than
// re-deriving the exit-code interpretation.
export function hasTrackedChanges(cwd, runGitFn) {
  try {
    runGitFn(cwd, ['diff', '--quiet', 'HEAD']);
    return false;
  } catch (error) {
    return error?.status === 1;
  }
}

// True when the TREE DIFF `baseRef..revSpec` is non-empty (`git diff --quiet <baseRef>
// <revSpec>`, evaluated at `repoRoot` — `baseRef` is already a resolved sha, so this means the
// same thing regardless of which worktree's cwd would otherwise run it), OR `diffCwd` carries
// uncommitted TRACKED changes. Shared by the sibling-candidate test below AND the "does the
// CURRENT checkout already have its own diff" precondition (finding 5475c1) — both are the same
// question against a different (revSpec, diffCwd) pair. Mirrors the Workflow scope phase's own
// recovery, which materializes BOTH the committed range AND the worktree's uncommitted diff
// (`--include-worktree`); committed-only counting (the pre-3618 behavior) left an all-uncommitted
// plan worktree permanently uncharged (finding 24ccca).
//
// plan 3618 round 3 (findings bdd0d9/77ecb9/0f5b7f/703cd5): a COMMIT COUNT
// (`rev-list --count base..revSpec`, this function's PRIOR shape) is not a valid stand-in for
// "has a real diff" — an empty commit, or a change immediately followed by its own revert, is a
// NONZERO commit count with an EMPTY tree diff. The Workflow's own condition for hunting is "the
// MATERIALIZED diff is empty" (`bytes == 0 && excludedFiles == 0`), so this asks that exact
// question instead: is `git diff base revSpec` itself non-empty, never merely "are there commits
// between them."
//
// The `HEAD~1` base-ref fallback (`BASE_REF_CANDIDATES`' last resort) still mostly suppresses the
// hunt when HEAD's last commit is a genuine, non-empty change: `HEAD~1..HEAD`'s tree diff is then
// non-empty too, exactly mirroring what the Workflow's own scope-phase diff materialization would
// ALSO find non-empty under that same fallback (so it likewise never hunts) — that is PARITY with
// the scope phase, not a bug. What this fix closes is the narrower case of an EMPTY commit or a
// commit-plus-revert at HEAD: the commit count was still positive there (wrongly suppressing the
// hunt), while the tree diff is correctly empty (so the hunt now correctly fires).
//
// plan 3618 round 4 (findings c34b42/6479af): a raw TWO-DOT `diff baseRef revSpec` compares full
// TREE CONTENTS, not ancestry — if `baseRef` (origin/master's own tip) has since advanced past
// this checkout's own history (routine in an actively-landing shared repo: local `master` lags a
// freshly fetched `origin/master`), the diff is non-empty purely from origin's LATER, unrelated
// commits, even though `revSpec` carries none of its own work. The Workflow's own reviewed diff
// is always `merge-base(origin/master, HEAD)..HEAD` (`.claude/workflows/sonnet-review.js` step
// a), never a raw two-dot compare — so this must diff from that SAME merge-base, not from
// `baseRef`'s tip. A `merge-base` failure (no common ancestry at all) degrades to "no committed
// diff" here rather than throwing — same fail-open spirit as every other seam in this resolver.
function hasDiffOrTrackedChanges({ repoRoot, diffCwd, baseRef, revSpec, runGitFn }) {
  let hasCommittedDiff = false;
  try {
    const mergeBase = String(runGitFn(repoRoot, ['merge-base', baseRef, revSpec])).trim();
    if (mergeBase) {
      try {
        runGitFn(repoRoot, ['diff', '--quiet', mergeBase, revSpec]);
      } catch (error) {
        hasCommittedDiff = error?.status === 1;
      }
    }
  } catch {
    // no common ancestor (or a transient failure) — nothing to charge via the committed range
  }
  if (hasCommittedDiff) return true;
  return hasTrackedChanges(diffCwd, runGitFn);
}

function siblingIsCandidate(entry, baseRef, runGitFn, repoRoot) {
  return hasDiffOrTrackedChanges({
    repoRoot,
    diffCwd: entry.path,
    baseRef,
    revSpec: entry.branch,
    runGitFn,
  });
}

// plan 3618 round 2 finding 5475c1: mirrors the Workflow scope phase's OWN precondition for
// hunting at all — it only hunts when its own scoped diff came back genuinely empty (`bytes == 0
// && excludedFiles == 0`). The guard has no access to that materialized result (it fires before
// the Workflow ever runs), so it asks the equivalent question directly: does the CURRENT
// checkout already have commits ahead of `baseRef`, or uncommitted tracked changes? If so, the
// current branch IS the target and no hunt runs — the pre-fix guard hunted unconditionally on
// every default Workflow launch from master, charging a sibling even when master's own diff
// was the thing actually under review.
function currentCheckoutHasOwnDiff(repoRoot, baseRef, runGitFn) {
  return hasDiffOrTrackedChanges({
    repoRoot,
    diffCwd: repoRoot,
    baseRef,
    revSpec: 'HEAD',
    runGitFn,
  });
}

// The ONE resolver for "which branch is actually under review" (plan 3618, addendum item A):
// shared by the guard hook and, via the `resolve-target-branch` CLI below, the Workflow scope
// phase's own worktree hunt — so the two can never resolve a different branch for the same call.
//
// `tokens` is the review invocation's positional argv AFTER any --flag has been stripped: []
// (no explicit target), [branchOrRange], or [level, branchOrRange] — a leading token that names
// a REVIEW_LEVELS member is always stripped before the explicit-target check, so `<level>
// <anything else>` and bare `<anything else>` are judged identically. Anything left over that is
// NOT a lone recognized branch/range is an UNRESOLVED target (prose, a PR number, a path) — never
// an invitation to hunt: the real Workflow routes non-empty leftover text through its own
// explicit-TARGET prompt branch (free-form instructions), which never reaches its step-f hunt
// either (finding 7abd8c).
//
// `allowSiblingHunt` (finding D1 — a REGRESSION this plan's own first pass introduced) gates the
// master-checkout sibling-worktree hunt below. It exists for exactly ONE caller: the Workflow
// scope phase's own recovery step, reached only via the `resolve-target-branch` CLI. The guard
// hook must NEVER set it for the Bash lane — `gpt-review.mjs`'s own runner always resolves the
// CURRENT checkout branch (see `warnBeforeReviewLaunch`), so a Bash launch charged to an
// auto-detected sibling would disagree with what the runner itself just reviewed, which is
// precisely the "guard and runner cannot disagree" bug class this whole plan exists to close.
// plan 3618 round 3 finding fb87ce (pre-existing, fixed anyway) / d49ff6 (declined — see the
// round-3 fix brief's "Declined" section, not implemented): `baseRefOverride`, when supplied,
// is used VERBATIM and never re-resolved via `resolveBaseRef` below. Its one caller is the
// `resolve-target-branch` CLI's `--base <sha>` (added this round): the Workflow's recovery step
// already resolved BASE_REF once in its own step a, and re-resolving it here could legitimately
// land on a DIFFERENT ref if availability moved between the two calls (a concurrent fetch, an
// upstream reconfigured) — recovery must materialize the SAME range the empty-scope check judged,
// not a fresh one.
export function resolveReviewTargetBranch({
  tokens = [],
  cwd,
  runGitFn = runGit,
  allowSiblingHunt = false,
  baseRefOverride = null,
} = {}) {
  if (!cwd) return null;
  // .trim() is redundant for an already-trimmed injected mock, but the default runGitFn (this
  // module's own execFileSync wrapper) deliberately does NOT trim — its other callers trim only
  // where they need to — so this resolver must not assume its output arrives pre-trimmed.
  const repoRoot = String(runGitFn(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const currentBranch = String(runGitFn(repoRoot, ['branch', '--show-current'])).trim();

  const isPlanBranchTarget = (token) =>
    typeof token === 'string' && Boolean(planSlugFromBranch(endRefOf(token) ?? token));

  const remaining = tokens.length > 0 && REVIEW_LEVELS.has(tokens[0]) ? tokens.slice(1) : tokens;
  if (remaining.length === 1 && isPlanBranchTarget(remaining[0])) {
    return {
      status: 'explicit',
      branch: endRefOf(remaining[0]) ?? remaining[0],
      path: null,
      repoRoot,
    };
  }
  const hasUnresolvedTarget = remaining.length > 0;

  if (currentBranch !== 'master' || !allowSiblingHunt || hasUnresolvedTarget) {
    return { status: 'current', branch: currentBranch, path: repoRoot, repoRoot };
  }

  // The main checkout, sitting on master with no explicit or unresolved target, is the shape
  // the Workflow's own scope phase falls back on when the default diff resolves empty (plan
  // 3245): hunt for the ONE worktree whose branch carries commits ahead of the base ref, OR
  // uncommitted changes.
  const baseRef = baseRefOverride ?? resolveBaseRef(repoRoot, runGitFn);
  if (!baseRef) {
    return { status: 'current', branch: currentBranch, path: repoRoot, repoRoot };
  }
  // plan 3618 round 2 finding 5475c1: only an EMPTY own diff triggers the hunt — see
  // currentCheckoutHasOwnDiff's header. `baseRef` rides along on this branch (and every branch
  // below that reaches it) because it is a resolved sha, cwd-invariant, and the `resolve-target-
  // branch` CLI's one caller — the Workflow's own step f — reuses it verbatim in a `git -C
  // <sibling>` call instead of re-resolving `@{upstream}` relative to that sibling (finding
  // 6ea3ab).
  if (currentCheckoutHasOwnDiff(repoRoot, baseRef, runGitFn)) {
    return { status: 'current', branch: currentBranch, path: repoRoot, repoRoot, baseRef };
  }
  let entries;
  try {
    entries = parseWorktreePorcelain(runGitFn(repoRoot, ['worktree', 'list', '--porcelain']));
  } catch {
    return { status: 'current', branch: currentBranch, path: repoRoot, repoRoot, baseRef };
  }
  const candidates = entries
    .filter((entry) => isLiveSiblingCandidate(entry, currentBranch))
    .filter((entry) => siblingIsCandidate(entry, baseRef, runGitFn, repoRoot))
    .map((entry) => ({ branch: entry.branch, path: entry.path }));
  if (candidates.length === 1) {
    return {
      status: 'resolved',
      branch: candidates[0].branch,
      path: candidates[0].path,
      repoRoot,
      baseRef,
    };
  }
  return {
    status: candidates.length === 0 ? 'none' : 'ambiguous',
    branch: currentBranch,
    path: repoRoot,
    repoRoot,
    candidates,
    baseRef,
  };
}

export function planIdFromSlug(slug) {
  const planId = planIdOfRowSlug(slug);
  return planId && planId.length >= 3 ? planId : null;
}

export function planSlugFromBranch(branch) {
  const value = String(branch ?? '').trim();
  const worktreeSlug = slugFromBranch(value);
  if (worktreeSlug) return worktreeSlug;
  if (value.startsWith('claude/drain-')) return value.slice('claude/drain-'.length) || null;
  return null;
}

// plan 3624 (findings 1yw98m2 + m57y8f): scripts/gpt-review.mjs is the WRITER of review
// artifacts, and its own documented shape (its header comment at :3553) is `--out
// .scratch/gpt-review/<slug>` — flat and slug-keyed. `findings.json` lands directly inside it;
// there is no `round-<n>` level in any real run. Two READERS — review-fix-brief.mjs's default
// artifact lookup and record-review.mjs's "did the previous round get a fresh-context brief"
// check — used to each hand-roll their OWN `round-${n}` path independently, and both were wrong
// the same way. This is the one place that path is computed; every reader calls it instead of
// re-deriving it, so a future change to the writer's layout only has one join() to update.
export function reviewArtifactsDir(repoRoot, slug) {
  return join(repoRoot, '.scratch', 'gpt-review', slug);
}

export function reviewFindingsPath(repoRoot, slug) {
  return join(reviewArtifactsDir(repoRoot, slug), 'findings.json');
}

export function reviewFixBriefPath(repoRoot, slug) {
  return join(reviewArtifactsDir(repoRoot, slug), 'review-fix-brief.md');
}

// plan 4078 T1: the ONE resolver for "where could the previous round's fix brief be" — the same
// two candidate locations record-review.mjs's pre-launch advisory warning already checks
// (`reviewOutDir` when the caller supplied one, then the slug-keyed default). Extracted here so
// there is exactly one resolver: record-review.mjs's warning and both cap callers below all call
// this instead of hand-rolling a second (or third) copy of the same two-candidate list.
export function fixBriefCandidates({ repoRoot, slug, reviewOutDir } = {}) {
  // plan 4078 fix round 1 (gpt-review key b81c28): deduped, because the documented convention is
  // `--out .scratch/gpt-review/<slug>` — which IS the slug-keyed default, so the two candidates
  // routinely collapse to the same file. Observed live on this plan: the pre-launch warning
  // printed "checked <path> and <path>". Deduping here rather than at each consumer keeps this the
  // ONE resolver, so the denial message, both cap callers and record-review's warning all agree.
  return [
    ...(reviewOutDir ? [join(reviewOutDir, 'review-fix-brief.md')] : []),
    reviewFixBriefPath(repoRoot, slug),
  ].filter((candidate, i, all) => all.indexOf(candidate) === i);
}

// plan 4078 T1: the FIX DELTA's added+deleted line count — previous reviewed tip (`fromSha`) to
// current tip (`toSha`) — via ONE `git diff --numstat`. This is deliberately NOT the range under
// review (`resolveDiffTargetShas`'s pair, the whole branch on the default path): that range would
// make every round-2+ launch on a big branch demand a brief even for a one-line fix, killing the
// carve-out. Binary rows report `-` for both columns; `Number('-')` is NaN, which the `|| 0` below
// turns into 0, exactly matching the "binary rows count 0" rule.
//
// Returns null on a missing endpoint or ANY git failure — never throws. Both callers treat null as
// "undeterminable" and fail OPEN (fixBriefRequired never denies on a null changedLines), the same
// fail-open direction every other seam in this module and in the guard hook takes.
export function fixDeltaChangedLines(repoRoot, fromSha, toSha, { runGitFn = runGit } = {}) {
  if (!fromSha || !toSha) return null;
  try {
    const raw = String(runGitFn(repoRoot, ['diff', '--numstat', fromSha, toSha]));
    let total = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const [added, deleted] = line.split('\t');
      total += (Number(added) || 0) + (Number(deleted) || 0);
    }
    return total;
  } catch {
    return null;
  }
}

// plan 4078 T1: true when a round-2+ launch must be denied absent a fresh-context fix brief for
// the PREVIOUS round. `changedLines: null`/`undefined` (an unresolvable marker/sha, or a git
// failure upstream) fails OPEN — reported as not-required, never as a denial reason to guess at.
export function fixBriefRequired({ launchOrdinal, changedLines, briefExists }) {
  if (!(launchOrdinal >= 2)) return false;
  if (changedLines === null || changedLines === undefined) return false;
  if (changedLines <= FIX_BRIEF_EXEMPT_CHANGED_LINES) return false;
  return !briefExists;
}

// plan 4078 T1: the ONE fix-brief denial message — both callers (gpt-review.mjs's console.error
// and review-round-cap-guard.mjs's formatDeny) print this rather than hand-rolling their own
// wording, mirroring capDenialMessage's own "one shared wording" precedent above. Names the exact
// command to produce the brief, the candidate location(s) checked, and the carve-out size — so a
// denied launch never has to go read this module to know what to do next.
export function fixBriefDenialMessage({ planId, slug, launchOrdinal, candidates = [] }) {
  const previousRound = launchOrdinal - 1;
  // plan 4078 fix round 1 (gpt-review keys 5d5949/c4f482/fcab0e/ceae60/d5e623): the remedy must
  // name `--out <a checked candidate>`, not the bare generator. `review-fix-brief.mjs` prints the
  // brief to STDOUT unless `--out` is passed (its own usage header: "`--out` overrides stdout"),
  // so the bare command produced no file anywhere this predicate looks — following the denial's
  // own instruction left the launch denied again, with nothing to show why. The FIRST candidate is
  // used deliberately: `fixBriefCandidates` orders the caller's own `--out` dir ahead of the
  // slug-keyed default, so candidates[0] is always a path this same gate will then find.
  // fix round 2 (gpt-review key 9f2d74): the LAST candidate, not the first. `fixBriefCandidates`
  // orders the caller's own `--out` first and the slug-keyed default LAST, and only the latter is
  // stable across launches — a caller whose `--out` is timestamp-keyed (gpt-review.mjs's own
  // default when no `--out` is passed) would otherwise be told to write the brief into a directory
  // the NEXT launch never looks in, so the denial would survive its own remedy a second time.
  const writeTarget = candidates[candidates.length - 1] ?? reviewFixBriefPath('.', slug);
  return (
    `review-round cap: denying launch ${launchOrdinal} for plan ${planId} — round ${previousRound}'s ` +
    `fix landed with no fresh-context brief (checked ${candidates.join(' and ')}; none exist).\n` +
    `Produce it: node scripts/review-fix-brief.mjs ${slug} --round ${previousRound} --out ${shellQuote(writeTarget)}\n` +
    `(without --out the brief goes to stdout and this gate still finds no file.)\n` +
    `A fix under ${FIX_BRIEF_EXEMPT_CHANGED_LINES} changed lines needs no brief.`
  );
}

// plan 4078 fix round 2 (gpt-review keys ff5efb/bb47f0/2b7c77/4de57a): POSIX single-quoting for a
// path that goes into a command string a human pastes. This repo's own local checkout lives under
// `98 Hobby/`, so an unquoted path with a space is the NORMAL case, not an exotic one: pasted bare
// it writes the brief somewhere else entirely and leaves the denial standing with no clue why.
// Single quotes take everything literally; the one character they cannot contain is `'` itself,
// which is closed, backslash-escaped, and reopened in the standard way.
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

// ─── CLI: resolve-target-branch (plan 3618, addendum item A) ──────────────────────────────
// `.claude/workflows/sonnet-review.js` is prompt text, not code that runs in this process, so
// it cannot import resolveReviewTargetBranch directly — this is its one sanctioned way to call
// the SAME resolver the guard hook uses instead of hand-rolling its own worktree hunt in prose.
// Only the no-explicit-token shape is exposed here: the Workflow's explicit-TARGET path builds
// its diff command straight from the caller's free-form instruction, which this resolver has no
// part in, so the CLI always resolves with an empty token list.
//   node scripts/coord/review-round-cap.mjs resolve-target-branch --cwd <path> [--base <sha>]
// Prints one line of JSON: the resolveReviewTargetBranch() return value (or {status:'none'} if
// cwd is missing/unresolvable).
function runResolveTargetBranchCli(argv) {
  const cwdIndex = argv.indexOf('--cwd');
  const cwd = cwdIndex === -1 ? process.cwd() : (argv[cwdIndex + 1] ?? process.cwd());
  // plan 3618 round 3 finding fb87ce: an optional --base <sha>, passed by the Workflow's
  // recovery step (via `.claude/workflows/sonnet-review.js`, step f) as step a's ALREADY-
  // resolved BASE_REF sha — reused verbatim (see `resolveReviewTargetBranch`'s `baseRefOverride`
  // header) rather than re-resolved here, which the declined finding d49ff6 also happens to make
  // cheaper on the recovery path (no fresh `rev-parse`/`merge-base` chain).
  const baseIndex = argv.indexOf('--base');
  const baseRefOverride = baseIndex === -1 ? null : (argv[baseIndex + 1] ?? null);
  // The CLI's one caller IS the Workflow scope phase's own sibling-hunt recovery step — the
  // hunt is exactly what it exists to run (finding D1's allowSiblingHunt gate defaults OFF
  // everywhere else, most importantly the Bash lane).
  const result = resolveReviewTargetBranch({
    tokens: [],
    cwd,
    allowSiblingHunt: true,
    baseRefOverride,
  });
  process.stdout.write(JSON.stringify(result ?? { status: 'none' }));
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1] &&
  process.argv[2] === 'resolve-target-branch'
) {
  try {
    runResolveTargetBranchCli(process.argv.slice(3));
  } catch (error) {
    process.stderr.write(
      `review-round-cap: resolve-target-branch failed: ${error?.message || error}\n`,
    );
    process.exitCode = 1;
  }
}
