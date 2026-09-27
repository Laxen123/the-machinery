#!/usr/bin/env node
// scripts/record-review.mjs  (plan 337)
// Record a code-review verdict marker in the worktree branch's handoff SESSION entry,
// so a later `node scripts/done-worktree.mjs <slug>` land auto-skips the REVIEW_NEEDED
// seam instead of re-running /code-review at land time.
//
// The marker — `Review: <PASS|NITS|BUGS-FOUND> @ <sha> patch-id:<hex>` — is honored by the
// spine while <sha> is the current branch HEAD, and (plan 2743) ALSO across a pure rebase
// that leaves the branch's content-diff vs origin/master byte-equivalent: the recorded
// patch-id is the rebase-stable half of the marker's identity, so a re-sha no longer
// invalidates the review and no longer costs a re-pin commit on master. A real content
// change still invalidates it on both identities. So run this AFTER your final commit; if
// you push more REAL work afterwards, re-run it (the land re-reviews).
//
// plan 3295 — the SEED-ONLY carry. Operator ruling 2026-08-19 ("Review stamp CARRIES across
// seed-data-only commits"): a marker recorded at sha X is ALSO honored at a later tip Y when
// `git diff --name-only X..Y` is non-empty and every path is under backend/src/data/seed/**
// (per-record JSON, per-country order.json manifests, chains.json — never code). No re-record, no re-disposition
// of findings is needed for a pure seed heal on top of an already-reviewed branch — the land's
// REVIEW_NEEDED gate honors the old marker directly (done-worktree.mjs's `recordedReviewMarker`
// / `markerStatusTable`, via `L.parseReviewMarkerFull`'s optional `seedOnlyDelta` predicate and
// `L.isSeedOnlyDelta` in done-worktree-lib.mjs). This is a THIRD, review-only fallback behind
// the sha fast path and the plan-2743 patch-id fallback — checked lazily, only when both of
// those have already failed. Seed heals stay checked by the price trust gate + seed-diff gate;
// a non-seed path anywhere in the delta keeps today's strict sha/patch-id rule. Re-running THIS
// tool after a seed-only commit is harmless (it just writes a fresh marker at the new sha, same
// as always) — it is simply no longer REQUIRED for the land to proceed.
//
// Usage (run from INSIDE the worktree, after a clean /code-review):
//   node scripts/record-review.mjs <PASS|NITS|BUGS-FOUND> [--findings <file.json>] [--carry-dispositions] [--slug <slug>] [--no-push] [--dry]
//   node scripts/record-review.mjs repin [--slug <slug>] [--no-push] [--no-fetch] [--dry]
//
// plan 2162 — review PROVENANCE. The marker now records HOW the review ran, so the land gate
// (and any audit) can distinguish a real /sonnet-review fan-out from the single-agent
// substitute a dispatched subagent falls back to (it has no Workflow tool — the silent
// downgrade this closes). Declare it with:
//   --review-method <sonnet-review|code-review|substitute|self-read>
//   --review-stats <file.json>  the /sonnet-review return (or its `stats` sub-object) —
//                               fills finders/verifiers/refute-adjudicators; implies method
//                               sonnet-review unless --review-method overrides
//   --finders N --verifiers N --adjudicated N   manual counts (override --review-stats)
// A record with NO method WARNS and stamps the marker as provenance-undeclared (visible at
// land as "provenance undeclared") — it never blocks, but it is no longer invisible.
//   <slug> defaults to the current branch with the `worktree-` prefix stripped; if given explicitly
//   it must name THIS worktree's slug (the plan-1105 branch guard) — it cannot record for another checkout.
//
// plan 1205 — findings-as-data land gate. A NITS/BUGS-FOUND review SHOULD carry its findings:
//   --findings <file.json>  an array of {file,line,summary,verdict?,kind?,disposition?} (or the raw
//                           /sonnet-review return object {findings:[…]}). They are written to a
//                           sha-pinned sidecar (docs/handoff/sessions/<base>.findings.json) committed
//                           with the marker, and the done-worktree FINDINGS_OPEN gate then requires
//                           EVERY finding to be dispositioned before the land. A non-PASS verdict
//                           recorded WITHOUT --findings still writes the marker but warns — the land
//                           halts at FINDINGS_OPEN until findings are attached. PASS takes none.
//   disposition subcommand  resolve findings' dispositions. Takes N keys per invocation and
//   performs exactly ONE coord write (plan 2595 — a 9-finding review used to pay 9 full
//   lock+freshen+commit+push cycles; 3,517 of 3,908 measured ops sat in bursts of ≥2 inside 120s,
//   max run 25). Prefer the multi form; the 1-key form is unchanged:
//     node scripts/record-review.mjs disposition <key…> --plan <id>      (filed a plan; machine-verified)
//     node scripts/record-review.mjs disposition <key…> --fixed          (fixed in this diff)
//     node scripts/record-review.mjs disposition <key…> --wontfix "<why>" (consciously waved; reason required)
//     node scripts/record-review.mjs disposition <key…> --reopen          (clear a disposition back to open)
//     node scripts/record-review.mjs disposition --batch <file.json>      (heterogeneous, still ONE write)
//   Keys go BEFORE the first flag, and/or as repeated `--key <k>` anywhere (a bare token after a
//   flag is refused, not guessed — it cannot be told from that flag's value). Exactly ONE of
//   --plan/--fixed/--wontfix/--reopen per invocation; combining two refuses rather than picking.
//   `--batch` takes [{key, kind, value?}, …]
//   with kind ∈ fixed | plan | wontfix | reopen and value = the plan id / wontfix reason — that is
//   the form for a real review round, which is usually mixed. Dispositions are ALL-OR-NOTHING:
//   every key is validated against the sidecar before anything is written, so one bad key in a
//   batch applies none of them. Ordering semantics are unchanged — still one synchronous coord
//   write, still landed before the FINDINGS_OPEN gate reads it.
//   (Re-recording with --findings PRESERVES existing dispositions while the prior sidecar's sha
//   still matches HEAD. At a NEW sha — a rebase or a LAND_BLOCKED_HOLDING conflict-resolution
//   merge → force-push → re-record (plan 1775; the plan-1291/1712 silent-drop) — they carry iff
//   the branch's content-diff is provably unchanged (the plan-1528 rangePatchId proof, automatic)
//   OR you pass --carry-dispositions, asserting this is the SAME review round re-recorded after a
//   content-changing recovery. Equivalent manual route: feed the CURRENT sidecar file as
//   --findings — each finding carries its own `disposition`, and an explicit disposition always
//   wins the merge. --reopen is the way to undo one.)
//
// Since plan 2042 the record-CLI protocol (session-file resolution, plan-1105
// branch-refuse guard, plan-1286 coord-checkout routed write, plan-1528 repin) lives in
// scripts/coord/record-marker-cli.mjs, shared with record-wiki.mjs and record-conclusion.mjs.
// This file keeps the REVIEW-SPECIFIC machinery layered on that core: the findings
// sidecar ingest/merge (plan 1205/1775), the disposition subcommand, and the sidecar
// half of repin.

import { existsSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// plan 3959 T2: the review-marker cluster moved to scripts/coord/review-markers.mjs; clampSubject
// stays in done-worktree-lib.mjs; wikiCheckpointNeeded moved to scripts/coord/wiki-checkpoint.mjs
// (plan 4096 T2) with its subject patterns as coord.config.json data.
import {
  MARKER_FAMILIES,
  upsertReviewMarker,
  parseReviewMarkerAny,
  REVIEW_METHODS,
  REVIEW_FANOUT_METHODS,
  REVIEW_PROVENANCE_UNDECLARED,
  buildReviewProvenance,
  buildFindingsRecord,
  parseFindingsRecord,
  sidecarOwnerConflict,
  dispositionFinding,
  normalizeDisposition,
  isMustFixFinding,
  deferredByTagDisposition,
  findingsSidecarPath,
  planIdInTree,
  findingBlocksLand,
  sameCommitSha,
  markerIdentityMatch,
  normalizeMarkerPatchId,
  markerRegExp,
  normalizeRounds,
  isFsPathAbsentError,
} from './coord/review-markers.mjs';
import { clampSubject } from './coord/done-worktree-lib.mjs';
// Plan 4096 T2: the wiki-subject predicate comes from core, not from done-worktree-lib's
// re-export of scripts/project/land-seams.mjs — that edge is what blocked this command at the
// coord-kit closure gate. Same function; its pattern list is coord.config.json data now.
import { wikiCheckpointNeeded } from './coord/wiki-checkpoint.mjs';

function autoDispositionAdvisoryFindings(record) {
  return {
    ...record,
    findings: record.findings.map((finding) =>
      isMustFixFinding(finding) || finding.disposition
        ? finding
        : { ...finding, disposition: deferredByTagDisposition(finding) },
    ),
  };
}

function printFindingSummary(record) {
  if (!record) return;
  const mustFix = record.findings.filter(isMustFixFinding).length;
  const preExistingCorrectness = record.findings.filter(
    (finding) =>
      finding.preExisting && finding.verdict === 'CONFIRMED' && finding.kind === 'correctness',
  ).length;
  console.log(
    `record-review: findings summary — must-fix: ${mustFix} / advisory: ${record.findings.length - mustFix}`,
  );
  console.log(
    `record-review: pre-existing correctness defects needing evidence-floor routing: ${preExistingCorrectness}`,
  );
}
import {
  git,
  findSessionFile,
  noSessionEntry,
  resolveRecordTarget,
  patchIdenticalDecision,
  makeCommitMarker,
  runRecordFlow,
  runRepinFlow,
  readSessionCandidates,
  pickFreshestMarker,
  openWriteJournal,
  ORIGIN_FIRST_REFS,
  resolveMarkerSource,
  carryMarkerForward,
  markerSourceHaltMessage,
} from './coord/record-marker-cli.mjs';
import { rangePatchIdOnceWithFetch, PATCH_ID_FETCH_REF } from './coord/land-lib.mjs';
import { parseSidecarOrRefuse } from './coord/findings-sidecar-io.mjs';
import {
  AT_CAP_ROUND,
  SANCTIONED_DELTA_ROUNDS,
  fixBriefCandidates,
  lastEscapeExit,
  planIdFromSlug,
  readConsecutiveEscapes,
  readEscapeState,
  sanctionedDeltaRounds,
} from './coord/review-round-cap.mjs';
// plan 3967: the fastlane stamp reader — this warning's own threshold narrows to round 1 for a
// `lane: fast` plan, the same seam scripts/hooks/review-round-cap-guard.mjs reads for its DENIAL.
// Fails open to `null` (the default lane) on any lookup error.
import { LANE_FAST, readLaneById } from './coord/read-plan-stamps.mjs';

/** Best-effort read of a session entry's findings sidecar candidates, ORIGIN-FIRST — mirroring
 * exactly how the marker itself is resolved (readCandidatesFn / ORIGIN_FIRST_REFS below). A plain
 * readFileSync(repoRoot, …) here was the plan-3415 finding-1 bug: gpt-review.mjs calls this with
 * repoRoot = the WORKTREE checkout, whose own working tree never carries
 * docs/handoff/sessions/*.findings.json (those land on master's tree via the routed coord-write
 * straight to origin) — so the fallback silently no-opped for every real caller. Reusing
 * readSessionCandidates (already imported for the marker read) fixes that for free: it tries
 * `git show origin/master:<path>` before falling back to a raw local read, exactly like the
 * marker candidates do. Returns an array (possibly empty) — absent/unreadable entries are simply
 * missing from it, same degrade-to-marker contract as before. */
function defaultReadSidecarRaw(repoRoot, sf) {
  // plan 4021 review round 3: deliberately LENIENT. This advisory's documented contract is that an
  // unreadable sidecar degrades to the marker's own round (callers pass placeholder repo roots), and
  // no gate reads it; the land-side and record-side round reads are the strict ones.
  return readSessionCandidates(repoRoot, findingsSidecarPath(sf));
}

/** Read the current plan's Review marker — the record every verdict writes — and warn before
 * launching a round at or beyond the cap.
 * Output-directory names are deliberately irrelevant: retries normally reuse `--out`, and the
 * default launcher supplies no `--out` at all. Advisory only; absent/unreadable means round 1. */
export function warnIfReviewRoundCapReached(
  repoRoot,
  slug,
  paths,
  {
    warn = console.error,
    findSessionFn = findSessionFile,
    readCandidatesFn = readSessionCandidates,
    readSidecarRawFn = defaultReadSidecarRaw,
    reviewOutDir,
    previousRoundOutDirFn,
    existsFn = existsSync,
    returnContext = false,
    readEscapeStateFn = readEscapeState,
    readConsecutiveEscapesFn,
    lastEscapeExitFn,
    readLaneByIdFn = readLaneById,
  } = {},
) {
  // plan 4078 T1: `markerSha` rides the returned context alongside `rounds`/`markerFound` — the
  // `@ <sha>` of the Review marker that produced the highest round below, i.e. the previous
  // reviewed tip the T1 fix-brief gate diffs the fix delta from. Absent/unreadable (every early
  // return below) means null, same fail-open direction as every other field here.
  const result = (rounds, markerFound, markerSha = null) =>
    returnContext ? { rounds, markerFound, markerSha } : rounds;
  if (!repoRoot || !slug || !paths) return result(1, false);
  const sf = findSessionFn(repoRoot, slug, paths, 'gpt-review-round-warning', {
    refs: ORIGIN_FIRST_REFS,
  });
  if (!sf) return result(1, false);
  // plan 3415 finding 1: the sidecar candidates are read ONCE, origin-first — not re-derived per
  // marker candidate — and sessionReviewRound (finding 2) binds each pairing to the marker's own
  // sha before trusting it, so trying every (marker candidate, sidecar candidate) pair below can
  // only ever find a MATCHING identity, never a false cross-candidate match.
  // plan 4021 review round 3: both reads are strict. A read ERROR is not "round 1": this advisory
  // never gates, so it warns that the round is unknown rather than silently under-reporting.
  let sidecarCandidates;
  let markerCandidates;
  try {
    sidecarCandidates = readSidecarRawFn(repoRoot, sf);
    markerCandidates = readCandidatesFn(repoRoot, sf, { strict: true });
  } catch (e) {
    const why = String(e?.stderr || e?.message || e)
      .trim()
      .split('\n')
      .pop();
    warn(
      `review-round warning: could not read the recorded review round for ${slug} from ${sf} ` +
        `(${why}) — the round count is unknown, so this launch may already be at or past the cap.`,
    );
    return result(1, false);
  }
  let markerFound = false;
  // plan 4078 T1: tracked from the SAME reduce/parse the round count already runs — never a
  // second, independent marker parse. Updated whenever a candidate matches or extends the current
  // highest round, so it ends up holding the sha of whichever marker candidate actually produced
  // `rounds` (ties take the last-seen candidate, which is immaterial here — this field is
  // advisory input to a fail-open predicate, not a second source of truth for the round count).
  let markerSha = null;
  const rounds = markerCandidates.reduce(
    // plan 3395 review r3 (findings 1/5): the sidecar is the durable round copy for a
    // pre-migration marker and for one the shared repin writer rewrote without the token.
    (highest, raw) => {
      return (sidecarCandidates.length ? sidecarCandidates : [null]).reduce((h, sidecarRaw) => {
        const candidateRound = sessionReviewRound(raw, sidecarRaw);
        if (candidateRound === null) return h;
        markerFound = true;
        if (candidateRound >= h) {
          // plan 4078 fix round 1 (keys 99ea44/f0e216): the LINE-ANCHORED reader, so the sha and
          // the round above always come off the same marker line (see its own header).
          const sha = recordedReviewMarkerSha(raw);
          if (sha) markerSha = sha;
        }
        return Math.max(h, candidateRound);
      }, highest);
    },
    1,
  );
  const nextRound = rounds + 1;
  if (nextRound >= 2 && (reviewOutDir || previousRoundOutDirFn)) {
    // plan 3624 (finding m57y8f): gpt-review.mjs writes into ONE flat directory reused across
    // every round of a SINGLE run (its own documented `--out .scratch/gpt-review/<slug>` shape) —
    // there is no `round-<n>` subdirectory to compute in any real run, so the previous round's
    // brief (if the fix dispatched one) lives in that SAME directory.
    //
    // plan 3624 fix round (findings 322f33/d0200a/29b2be): `reviewOutDir` is the ACTUAL per-run
    // output directory the caller was launched with (gpt-review.mjs passes its own `outDir`) —
    // and gpt-review's DEFAULT `--out`, whenever the caller omits one, is timestamp-keyed
    // (`.scratch/gpt-review/<timestamp>`), NOT slug-keyed. Recomputing the location from the slug
    // via reviewFixBriefPath was therefore simply WRONG for a default-launched review — it named
    // a directory the writer never wrote to, and this check fired a spurious warning every time.
    //
    // plan 3624 round 2 (findings 774dfb/94cc1e/a42853/83a2e4): `reviewOutDir` is the CURRENT
    // run's directory — a default (no `--out`) launch gets a FRESH timestamp-keyed directory
    // every round, so round 2's own `reviewOutDir` is never round 1's. Checking `reviewOutDir`
    // ALONE therefore false-warned whenever round 1's brief actually landed at the documented
    // slug-keyed `--out .scratch/gpt-review/<slug>` convention (or any other reused `--out`).
    // Both locations it could legitimately be are now checked, and the warning fires only when
    // the brief is absent from both. `previousRoundOutDirFn` stays the explicit, highest-
    // precedence override — when supplied, it is the ONLY location checked. The genuinely-fresh-
    // timestamp-every-round case (round 1's real directory is neither of these) still cannot be
    // resolved from here — that is a separate, upstream design question in the writer
    // (gpt-review.mjs), not fixed by this reader.
    // plan 4078 T1: the two-candidate list is now the ONE exported resolver (fixBriefCandidates,
    // review-round-cap.mjs) — this advisory warning and the T1 launch gate below both call it, so
    // there is no second, independently-hand-rolled copy to drift from this one.
    const candidates = previousRoundOutDirFn
      ? [
          join(
            previousRoundOutDirFn({ repoRoot, slug, nextRound, reviewOutDir }),
            'review-fix-brief.md',
          ),
        ]
      : fixBriefCandidates({ repoRoot, slug, reviewOutDir });
    if (!candidates.some((candidate) => existsFn(candidate))) {
      warn(
        `review-round warning: round ${nextRound - 1}'s fix ran without a fresh-context brief ` +
          `(checked ${candidates.join(' and ')}; none exist).`,
      );
    }
  }
  // plan 3967: the plan's OWN `lane: fast` stamp narrows the cap this warning fires against —
  // computed ONCE here (planId is reused below for the escape-state read too, replacing what used
  // to be a second, redundant planIdFromSlug(slug) call inside the `if` block). `readLaneByIdFn`
  // fails open to `null` on any error by its own contract, so a lookup failure degrades to the
  // DEFAULT cap — never a false "at cap" warning. `capForLane` equals `AT_CAP_ROUND` numerically
  // for the default (null) lane, so every pre-3967 caller (none of which pass `readLaneByIdFn`)
  // sees byte-identical behaviour.
  let planId = null;
  try {
    planId = planIdFromSlug(slug);
  } catch {
    planId = null;
  }
  const lane = planId ? readLaneByIdFn(repoRoot, planId) : null;
  const capForLane = 1 + sanctionedDeltaRounds(lane);
  if (nextRound >= capForLane) {
    const position = nextRound === capForLane ? 'at' : 'beyond';
    // plan 3618, item 1: surface the ledger's own consecutive-escape count alongside the
    // marker-round warning, so the session sees "this many in a row" BEFORE deciding whether to
    // launch with --past-cap again. Best-effort: repoRoot may be a placeholder in some callers
    // (this function's own contract is "advisory only; absent/unreadable means round 1"), so a
    // read failure here degrades to "nothing to warn about" rather than throwing.
    //
    // finding 77e56c (D4): the actual denial predicate (`pastCapEscapeDecision`) fires ONLY when
    // the trailing streak's newest exit is `run:` — a `simplify:`/`park:` tail means the NEXT
    // `run:` is explicitly allowed (a different exit breaks the streak). Warning off
    // `consecutiveEscapes > 0` alone lied about that case; gate on `lastExit === 'run'` too.
    let consecutiveEscapes = 0;
    let lastExit = null;
    try {
      if (planId) {
        // plan 3618 round 2 (R3, findings 72779b/4ab4b6/90a435): one ledger read serves both
        // signals in production. `readConsecutiveEscapesFn`/`lastEscapeExitFn` stay independently
        // overridable (existing tests vary them separately) — supplying either one opts OUT of
        // the combined read and back into the old two-reader shape for that call.
        if (readConsecutiveEscapesFn || lastEscapeExitFn) {
          consecutiveEscapes = (readConsecutiveEscapesFn ?? readConsecutiveEscapes)(
            repoRoot,
            planId,
          );
          lastExit = (lastEscapeExitFn ?? lastEscapeExit)(repoRoot, planId);
        } else {
          ({ consecutiveEscapes, lastExit } = readEscapeStateFn(repoRoot, planId));
        }
      }
    } catch {
      consecutiveEscapes = 0;
      lastExit = null;
    }
    const escapeNote =
      lastExit === 'run' && consecutiveEscapes > 0
        ? ` ${consecutiveEscapes} consecutive past-cap escape(s) are already recorded for this ` +
          `plan, the last of which named "run:" — a second consecutive "run:" is DENIED, not ` +
          `warned.`
        : '';
    // plan 3967: named only when the lane is genuinely fast — every default-lane warning stays
    // the exact pre-3967 sentence (`${sanctionedDeltaRounds(lane)}` equals SANCTIONED_DELTA_ROUNDS
    // there, so the wording is byte-identical even though it now reads the lane-aware helper).
    const laneNote =
      lane === LANE_FAST
        ? ` This plan is \`lane: fast\` — one review round, then park the rest with ` +
          `\`scripts/park-review-findings.mjs\`.`
        : '';
    warn(
      `review-round warning: session marker records round ${rounds} for ${slug}; launching round ` +
        `${nextRound} is ${position} the ${sanctionedDeltaRounds(lane)}-delta-round cap ` +
        `(docs/coord/review.md § Stopping rule).${escapeNote}${laneNote}`,
    );
  }
  return result(rounds, markerFound, markerSha);
}

// ── plan 3764: nudge the wiki decision at REVIEW-RECORD time, not at the land halt ────────
//
// Census (44 transcripts, 2026-08-17→09-06): 38 of 38 real WIKI_CHECKPOINT land halts fired
// because no session recorded the wiki decision before its first land call, even though ~79%
// of the same sessions DID record the code review first. Sessions have the "record the review,
// then land" habit because record-review.mjs already runs at that moment — so the cheapest fix
// is to have IT say the wiki decision is due too, right there, instead of leaving the session
// to discover it only at the halt.
//
// Given the branch's own diff facts and (if any) the freshest wiki marker for HEAD, return the
// text to print — or null when there is nothing to say. Pure: no git, no fs, no console — the
// caller (printWikiDecisionNudge below) gathers the facts and prints the result. `needed`
// defaults to the shared predicate (`wikiCheckpointNeeded`, done-worktree-lib.mjs) — injectable
// so the drift test can prove this follows the injected predicate rather than a copy of
// `WIKI_SUBJECT_PATTERNS` (module-private there on purpose: one subject list, one owner).
export function wikiDecisionNudge({
  changedFiles,
  chainsChanged = false,
  marker,
  headSha,
  headPatchId = null,
  needed = wikiCheckpointNeeded,
  // The seed chains registry's path — a caller-supplied, REQUIRED param (no default, matching
  // isSeedOnlyDelta's own no-default contract): this function stays pure (no git, no fs, no
  // coord-config load — see the header), so it cannot derive vetapp's seed root itself. The real
  // caller (printWikiDecisionNudge) builds it from `cfg.seedShardDir`, or passes `null` when the
  // repo configures none — every unit-test call passes it explicitly too. plan 3961 T2.7b
  // follow-up: the shared FALLBACK_SEED_SHARD_DIR constant (and the default this param used to
  // read off it) is retired — a silently-defaulted vetapp literal here was dead weight once every
  // production caller threads its own configured (or explicitly null) value.
  chainsPath,
}) {
  if (!needed(changedFiles, chainsChanged)) return null;
  // Same identity rule the marker machinery already uses elsewhere (sha, or — across a pure
  // rebase — the plan-2743 range patch-id): a marker recorded for a DIFFERENT tip is not "wiki
  // decision made for THIS diff", so it must not silence the nudge.
  const recorded = marker && markerIdentityMatch(marker.sha, marker.patchId, headSha, headPatchId);
  if (recorded) {
    return `wiki decision: ${marker.decision} @ ${String(marker.sha).slice(0, 7)} (recorded)`;
  }
  const matched = wikiMatchedNudgePaths(changedFiles, chainsChanged, chainsPath, needed);
  const pathsText = matched.length ? matched.join(', ') : '(chains.json)';
  return (
    `⚠ wiki decision due before landing — this branch touches a wiki-owned subject\n` +
    `  (${pathsText}) and no \`Wiki: WROTE|SKIP @ ${String(headSha).slice(0, 7)}\` marker exists.\n` +
    `  The land will halt at WIKI_CHECKPOINT (exit 26) until one does. Do it now:\n` +
    `    fold durable learning into the subject's wiki/ page, bump \`updated:\`, add a wiki/log.md line, then\n` +
    `    node scripts/wiki-commit.mjs <pages…> -m "chore(wiki): …"     (from inside this worktree)\n` +
    `    node scripts/record-wiki.mjs WROTE "<pages>"\n` +
    `  or, if the plan taught the wiki nothing durable:\n` +
    `    node scripts/record-wiki.mjs SKIP "<why>"`
  );
}

// Which of the changed paths actually trip the checkpoint — for the nudge's own display only.
// Deliberately does NOT read WIKI_SUBJECT_PATTERNS (module-private): it re-asks the same
// injected `needed` predicate ONE FILE AT A TIME, so "which paths matched" is derived from the
// one shared predicate rather than a second, driftable copy of the pattern list. `chainsChanged`
// has no single path of its own (it is a caller-computed flag, not a pattern match) — when it is
// the reason the nudge fired, `chainsPath` (the caller-built display string) is named explicitly
// instead. Capped at 3 (the plan's own display budget) so a huge diff doesn't produce an
// unreadable line.
function wikiMatchedNudgePaths(changedFiles, chainsChanged, chainsPath, needed) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  const matched = [];
  if (chainsChanged) matched.push(chainsPath);
  for (const f of files) {
    if (matched.length >= 3) break;
    if (matched.includes(f)) continue;
    if (needed([f], false)) matched.push(f);
  }
  return matched.slice(0, 3);
}

// The impure gatherer: compute the branch's changed-files/chains facts and the freshest wiki
// marker for HEAD, then print wikiDecisionNudge's text (if any). Called from BOTH report-hook
// branches (noop "already recorded" and freshly-recorded) — never from --dry (runRecordFlow
// returns before hooks.report there) and never from `repin` (see the execution notes: the
// review repin runs inside the spine alongside the wiki repin, so the repin path is not where
// the 0-of-38 problem is; scope stays the record path only).
//
// Advisory only, so it FAILS OPEN everywhere: no origin / no resolvable merge-base (an unpushed
// test fixture, an offline checkout) or an unreadable session entry both degrade to printing
// nothing, never a thrown error and never a changed exit code.
//
// `clinicPageChanged` (the paged-record seed axis `pagedClinicChanged` computes) is deliberately
// NOT computed here: it needs the shard base/head record views the land itself builds, which
// this advisory has no cheap access to from a plain `git diff --name-only`. A nudge that stays
// silent on that one axis is still strictly better than today's zero coverage on the
// review-record path — see plan 3764's execution notes.
// plan 4096, gpt-review rounds 3-4: ONE guard at this function's own boundary, not a try around
// the first predicate call. `wikiCheckpointNeeded` reads coord.config.json on first use and lets
// a malformed one THROW — deliberately, because the land's WIKI_CHECKPOINT seam must never fail
// open — and the body below asks it TWICE: once directly, and again inside `wikiDecisionNudge`'s
// own per-file `wikiMatchedNudgePaths` walk. Round 3 wrapped only the first, which left the
// second uncovered (round 4, four angles).
//
// This whole function is ADVISORY: it prints a reminder, and already fails open twice inside
// (no origin / no merge-base, and an unreadable marker). A broken config in THIS checkout must
// not turn `record-review` into a crash on a path whose entire contract is "print a hint or say
// nothing" — the land is still the thing that refuses. That is the same split deploy.mjs draws
// between its import-time fallback and the entry point that re-reads and refuses.
//
// Note the config this can trip over is the WORKTREE's, not MAIN's: record-marker-cli.mjs
// already loaded MAIN's (`loadCoordConfig(MAIN)`) before handing `cfg` in here, so a malformed
// MAIN config has thrown long before this point, while wiki-checkpoint.mjs reads the root of the
// checkout it is running from.
function printWikiDecisionNudge(args) {
  try {
    printWikiDecisionNudgeOrThrow(args);
  } catch {
    // advisory — say nothing rather than crash the command
  }
}

function printWikiDecisionNudgeOrThrow({ MAIN, slug, cfg, sha, headPatchId }) {
  let changedFiles;
  try {
    const base = git(['merge-base', PATCH_ID_FETCH_REF, sha]).trim();
    if (!base) return;
    changedFiles = git(['diff', '--name-only', `${base}..${sha}`])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return; // no origin / no merge-base — advisory, fails open
  }
  // seedShardDir is the coord-config value (cfg.seedShardDir), never a literal — same posture as
  // done-worktree.mjs's own readShardGateViews. plan 3961 T2.7b follow-up: no fallback literal
  // any more (FALLBACK_SEED_SHARD_DIR is retired) — a repo that configures no seed shard dir has
  // no chains registry to speak of, so the chains-path / seed-only logic is skipped outright
  // (null chainsPath, chainsChanged stays false) instead of silently guessing vetapp's root for
  // it. Built via template literal when seedShardDir IS configured, never a quoted
  // seed-directory string in THIS file's own source, so the seed-io-seam guard reads it as a
  // display string, not an open.
  const chainsPath = cfg.seedShardDir ? `${cfg.seedShardDir}/chains.json` : null;
  const chainsChanged = chainsPath !== null && changedFiles.includes(chainsPath);
  // finding 5d6047 (cleanup): check the predicate BEFORE paying for the session/marker lookup
  // (findSessionFile's `git grep` + `git show`, plus readSessionCandidates' reads) — every
  // ordinary NON-wiki review used to pay that cost only to have wikiDecisionNudge's own `needed`
  // guard discard it a moment later. Pure reorder: wikiDecisionNudge (and its injectable `needed`
  // param, which the drift test depends on) is unchanged, and this mirrors its own default.
  if (!wikiCheckpointNeeded(changedFiles, chainsChanged)) return;
  let marker = null;
  try {
    // plan 3764 review findings 940dcd/5fc26b/504cfc: origin-first, matching how the marker
    // itself is written — record-wiki.mjs lands the wiki marker via the ROUTED coord-checkout
    // straight to origin/master (mirrors record-marker-cli.mjs:610), so a session entry can
    // exist there before this shared MAIN checkout's own HEAD has fast-forwarded onto it. A
    // default `{ refs: ['HEAD'] }` lookup would then find no `sf` at all and never read the
    // marker, nagging "no decision recorded" forever even after record-wiki.mjs genuinely ran.
    const sf = findSessionFile(MAIN, slug, cfg.paths, 'record-review', { refs: ORIGIN_FIRST_REFS });
    if (sf) {
      marker = pickFreshestMarker(
        MARKER_FAMILIES.wiki,
        // plan 4021 review round 3: strict; a read error lands in the catch → the nudge still fires
        readSessionCandidates(MAIN, sf, { strict: true }),
        sha,
        headPatchId,
      );
    }
  } catch {
    marker = null; // best-effort — an unreadable marker reads as "none recorded yet"
  }
  const text = wikiDecisionNudge({
    changedFiles,
    chainsChanged,
    marker,
    headSha: sha,
    headPatchId,
    chainsPath,
  });
  if (text) console.log(text);
}

/** Read the last Review MARKER's persisted round token. A legacy marker without the token is
 * round 1; null means there is no Review marker at all.
 *
 * The line test reuses done-worktree-lib's exported markerRegExp(family) directly (plan 3415
 * finding 4) rather than restating the family's verdict/shape as a second hand-rolled regex here
 * — a verdict added to MARKER_FAMILIES.review.verdicts is picked up on both sides at once. The
 * `@ <sha>` anchor markerRegExp requires is the whole discriminator: without it, ordinary session
 * prose ("Code review: PASS after the rebase") parses as a machine marker and silently decides
 * the round count. A fresh RegExp is built per line (markerRegExp's own contract) so the 'g' flag's
 * lastIndex never leaks between line tests.
 *
 * plan 3415 finding 5 (regression, review round 1): markerRegExp is deliberately UNANCHORED —
 * `parseMarkerAny`'s matchAll contract scans a whole multi-line body for the marker ANYWHERE, so
 * it must not assume line boundaries. Reusing that same object for a PER-LINE test needs its own
 * start-of-line anchor, which this function adds locally rather than asking the shared helper to
 * grow a second mode: `upsertMarker`/`appendMarkerRoundSuffix` always write the marker as a line
 * that STARTS with `${family.label}:` (nothing ever precedes it), so requiring the match at
 * column 0 rejects prose that merely QUOTES marker-shaped text ("Note: quoted marker: Review:
 * PASS @ <sha> review-round:9") while still accepting the real marker line and any trailing
 * token after the sha (no `$` anchor needed — see markerRegExp's own header on that). */
export function recordedReviewRound(content) {
  if (!parseReviewMarkerAny(content)) return null;
  const family = MARKER_FAMILIES.review;
  let last = null;
  for (const line of String(content).split(/\r?\n/)) {
    const lineAnchored = new RegExp(`^${markerRegExp(family).source}`, 'i');
    if (!lineAnchored.test(line)) continue;
    const match = line.match(/\breview-round:(\d+)\b/i);
    // Reuses done-worktree-lib.mjs's normalizeRounds (plan 3415 round-3 review) instead of
    // hand-rolling the same isSafeInteger-and->=1-else-1 check a second time here.
    last = match ? normalizeRounds(Number(match[1])) : 1;
  }
  return last;
}

/** The `@ <sha>` of the SAME marker line `recordedReviewRound` above reads the round from — the
 * previous reviewed tip the plan-4078 T1 fix-brief gate diffs the fix delta from.
 *
 * plan 4078 fix round 1 (gpt-review keys 99ea44/f0e216): this deliberately reuses
 * `recordedReviewRound`'s line-anchored walk rather than calling `parseReviewMarkerAny(content)`
 * on the whole entry. The unanchored parser matches marker-shaped text ANYWHERE, including a
 * handoff note that quotes a marker mid-prose — the exact input `recordedReviewRound`'s own header
 * says the column-0 anchor exists to reject. Reading the round line-anchored and the sha
 * unanchored let the two disagree about which line is the real marker, which would hand
 * `fixDeltaChangedLines` a sha nothing ever reviewed and silently mis-size every fix delta.
 * Last match wins, exactly as the round reader does, so both always read the same line. */
export function recordedReviewMarkerSha(content) {
  if (!parseReviewMarkerAny(content)) return null;
  const family = MARKER_FAMILIES.review;
  let last = null;
  for (const line of String(content).split(/\r?\n/)) {
    const lineAnchored = new RegExp(`^${markerRegExp(family).source}`, 'i');
    if (!lineAnchored.test(line)) continue;
    // Parsed from the LINE, not the whole entry: the line is already proven to start with the
    // marker, so the unanchored parser has nothing else to latch onto here.
    const parsed = parseReviewMarkerAny(line);
    if (parsed?.sha) last = parsed.sha;
  }
  return last;
}

/** The round a session entry is at: the marker token, falling back to the findings sidecar's own
 * `rounds` counter.
 *
 * The fallback is what makes the marker migration non-destructive. A pre-migration entry has a
 * marker with no `review-round:` token but a sidecar that already counted to N; reading the
 * marker alone calls that round 1 and hands back N-1 free rounds under the cap. The shared repin
 * writer also rewrites a marker without re-appending the token, so the sidecar is the durable
 * copy there too. Highest wins — both sources only ever undercount, never overcount.
 *
 * Residual, recorded in docs/handoff/infra-debt.md: a PASS review writes NO sidecar, so a PASS
 * whose marker was rewritten by the repin path still resets to round 1.
 *
 * plan 3415 finding 2: the sidecar's `rounds` count is trusted ONLY when the sidecar's own
 * recorded `sha` matches the marker's — otherwise it is a stale sidecar left over from an already-
 * superseded review (a different identity) and must not hand a brand-new review free rounds. */
export function sessionReviewRound(content, sidecarRaw) {
  const fromMarker = recordedReviewRound(content);
  let fromSidecar = null;
  if (sidecarRaw) {
    try {
      const rec = parseFindingsRecord(sidecarRaw);
      const marker = parseReviewMarkerAny(content);
      const belongsToMarker = Boolean(marker && rec && sameCommitSha(rec.sha, marker.sha));
      const n = belongsToMarker ? Number(rec?.rounds) : NaN;
      if (Number.isSafeInteger(n) && n >= 1) fromSidecar = n;
    } catch {
      /* an unparseable sidecar is not a round signal — the marker still decides */
    }
  }
  if (fromMarker === null && fromSidecar === null) return null;
  return Math.max(fromMarker ?? 1, fromSidecar ?? 1);
}

export function appendMarkerRoundSuffix(markerFileText, rounds) {
  // normalizeRounds already clamps to >=1 (plan 3415 round-3 review) — no separate Math.max needed.
  const token = ` review-round:${normalizeRounds(rounds)}`;
  return markerFileText.endsWith('\n')
    ? markerFileText.slice(0, -1) + token + '\n'
    : markerFileText + token;
}

// plan 2891 T2 (promoted to a module-level factory by plan 2942, so `dispositionMain` can get its
// OWN dedupe instance instead of sharing — or reimplementing — the one `main()` uses): a WARNING
// emitted at most once per invocation. Every warning keyed on this dedupe lives inside whatever
// closure coordWrite re-runs on each freshen-and-retry attempt — without it a contended write
// would repeat the same warning once per attempt. Keyed on the message itself, so a retry whose
// freshened view yields a genuinely DIFFERENT outcome still says so (that new line is the
// authoritative one — it is the last printed).
function makeWarnOnce() {
  const warned = new Set();
  return (msg) => {
    if (warned.has(msg)) return;
    warned.add(msg);
    console.error(msg);
  };
}

export function reviewStatsIdentityDecision(identity, recordedSha, statsFile) {
  if (!identity)
    return {
      warning: `record-review: WARNING: --review-stats ${statsFile} has no identity (legacy grace, plan 3507); proceeding.`,
    };
  if (identity.kind === 'copy-bundle') return {};
  if (!identity.endSha)
    return {
      warning: `record-review: WARNING: --review-stats ${statsFile} identity carries no endSha (legacy grace, plan 3507); proceeding.`,
    };
  if (sameCommitSha(identity.endSha, recordedSha)) return {};
  return {
    error: `record-review: --review-stats ${statsFile} identity endSha ${identity.endSha} does not match recorded sha ${recordedSha}.`,
  };
}

// plan 1205: the findings sidecar path is derived by the ONE shared helper in done-worktree-lib
// (so the writer here and the done-worktree reader can never drift). Re-exported for the test.
export { findingsSidecarPath };

// plan 2936: the ONE findings-sidecar read policy (readSidecarOrRefuse) now lives in
// scripts/coord/findings-sidecar-io.mjs, imported above — gpt-review.mjs's plan-2936 T1 reader needed
// the SAME policy, and this module's own fs-touching read had no fs-free home in
// done-worktree-lib.mjs to move to (that module's header contract is explicitly fs-free). See
// that module's header comment for the full plan-2891/2844 decision this policy encodes.
//
// plan 4021 review round 3 (5d1618/33ce2a): that shared reader answers a bare ENOENT as ABSENT, and
// a dangling symlink reads ENOENT too. Every sidecar read in this CLI therefore goes through
// readSidecarStrict below: the same parse + refusal wording (parseSidecarOrRefuse), with absence
// decided by the one strict classifier (coord/review-markers.isFsPathAbsentError: ENOENT AND an
// lstat that finds nothing). The fs calls are injectable so the dangling-link case is testable on
// every platform without coaxing the host filesystem into it.
export function readSidecarRawStrict(
  dir,
  sidecarRel,
  { readFile = readFileSync, lstat = lstatSync } = {},
) {
  const abs = join(dir, sidecarRel);
  try {
    return { raw: readFile(abs, 'utf8') };
  } catch (err) {
    if (isFsPathAbsentError(err, () => lstat(abs))) return { absent: true };
    return {
      refuse:
        `REFUSED — ${sidecarRel} EXISTS but could not be read (${err?.message || err?.code || err}). ` +
        `Treating an unreadable sidecar as an absent one would strand whatever findings, dispositions ` +
        `and review-round count it still holds. Nothing was written. Fix the file's readability ` +
        `(permissions, a dangling link, or something occupying that path) and re-run.`,
    };
  }
}

// { absent: true } | { rec } | { refuse } — readSidecarOrRefuse's contract, strict about absence.
export function readSidecarStrict(dir, sidecarRel, fsOps = {}) {
  const read = readSidecarRawStrict(dir, sidecarRel, fsOps);
  return read.raw === undefined ? read : parseSidecarOrRefuse(read.raw, sidecarRel);
}

// Derived from the family table (review 2042 [3]) so a future verdict addition can't
// split record-review's own gate from the shared repin/record flows.
const VALID = new Set(MARKER_FAMILIES.review.verdicts);

// plan 4021 (review fb94f6): CARRY FORWARD for the findings sidecar. After an adoption the newest
// owned session entry (every write's target) carries no Review marker and no sidecar, while an
// older owned entry holds both. Each review write flow (repin, disposition, a fresh record) first
// copies that marker line and this sidecar into the newest entry, then proceeds as it always has.
// This decides, WITHOUT writing, whether the sidecar half can be carried:
//   { refuse }                         source unreadable/unparseable or owned by another slug, or a
//                                      sidecar already sits beside the newest entry (never replace
//                                      one record with another)
//   { present: false, fromRel, toRel } no sidecar to carry (a PASS marker, or findings never attached)
//   { present: true, fromRel, toRel }  carry fromRel → toRel
export function planFindingsCarry(dir, fromSf, toSf, slug = null) {
  const fromRel = findingsSidecarPath(fromSf);
  const toRel = findingsSidecarPath(toSf);
  // review round 2 (63f2df/b813aa): the TARGET check runs first, so it also fires when the source
  // has no sidecar — an orphan beside a marker-less newest entry must never ride under a carried marker.
  // Review round 3 (5d1618): the probe result is kept, so an unreadable or unparseable target
  // refuses with its own reason instead of being labelled an orphan.
  const target = readSidecarStrict(dir, toRel);
  if (target.refuse) {
    return { refuse: `cannot carry the Review marker forward from ${fromSf}: ${target.refuse}` };
  }
  if (!target.absent) {
    return {
      refuse:
        `cannot carry the Review marker forward from ${fromSf}: ${toRel} already exists beside the newest session entry, ` +
        `which carries no Review marker. Refusing rather than pairing that findings record with another entry's marker.`,
    };
  }
  const src = readSidecarStrict(dir, fromRel);
  if (src.refuse) return { refuse: src.refuse };
  if (src.absent) return { present: false, fromRel, toRel };
  const conflict = sidecarOwnerConflict(src.rec, slug, fromRel);
  if (conflict) return { refuse: conflict };
  return { present: true, fromRel, toRel };
}

// The write half of planFindingsCarry: throws on its refusal, copies the sidecar bytes unaltered,
// and returns the rel paths written ([] when there was nothing to carry).
export function carryFindingsSidecar(dir, fromSf, toSf, slug = null) {
  const plan = planFindingsCarry(dir, fromSf, toSf, slug);
  if (plan.refuse) throw new Error(`record-review: ${plan.refuse}`);
  if (!plan.present) return [];
  writeFileSync(join(dir, plan.toRel), readFileSync(join(dir, plan.fromRel)));
  return [plan.toRel];
}

// The review-family descriptor for the shared repin flow (record-marker-cli.runRepinFlow):
// on top of the generic marker re-pin, review carries the sha-pinned findings sidecar —
// probed at gate time so the routed relPaths can be exact (`git add` on a never-written
// path would fail the coordWrite; the sidecar only exists for NITS/BUGS-FOUND), and
// re-pinned alongside the marker with findings/dispositions carried verbatim.
export const DESC = {
  tool: 'record-review',
  scope: 'review',
  family: MARKER_FAMILIES.review,
  nothingHint: 'review + record first',
  probeExtras: (dir, sf, marker, slug = null) => {
    const sidecarRel = findingsSidecarPath(sf);
    // plan 2844 split the READ (absence → no sidecar, marker-only re-pin is fine) from the
    // PARSE (exists-but-unparseable → refuse loudly, naming the file). plan 2891 T1 closes the
    // remaining half of that split — an EXISTING but unREADABLE sidecar (EACCES/EISDIR/EIO) was
    // still landing in the "absent" arm and silently downgrading to a marker-only re-pin — and
    // T4 moves the whole policy into readSidecarOrRefuse, shared with applyExtras below and the
    // record path's own prepare/mutateIn, so the four sites can no longer diverge.
    const read = readSidecarStrict(dir, sidecarRel);
    if (read.refuse) return { sidecarPinned: false, refuse: read.refuse };
    if (read.absent) return { sidecarPinned: false }; // no sidecar → marker-only re-pin
    const rec = read.rec;
    // plan 2838 re-review [6]/[10]/[13]: the ownership refusal belongs at GATE time. applyExtras
    // still re-asserts it (the routed path re-runs the write against a freshened checkout), but
    // catching it here is what keeps the marker from being rewritten before the refusal lands.
    const conflict = sidecarOwnerConflict(rec, slug, sidecarRel);
    if (conflict) return { sidecarPinned: false, refuse: conflict };
    return { sidecarPinned: sameCommitSha(rec.sha, marker.sha), sidecarPresent: true };
  },
  // plan 4021: a carried-forward sidecar is written into the newest entry whether or not it is
  // pinned to the marker's sha, so it joins the declared paths whenever it exists.
  repinRelPaths: (g) =>
    g.extra?.sidecarPinned || (g.carryFrom && g.extra?.sidecarPresent)
      ? [g.sf, findingsSidecarPath(g.sf)]
      : [g.sf],
  // plan 4021 (review fb94f6): carry the older owned entry's findings sidecar forward into the
  // newest entry (bytes unaltered, dispositions intact) before the re-pin proceeds against it.
  carryExtras: (dir, fromSf, toSf, slug = null) => carryFindingsSidecar(dir, fromSf, toSf, slug),
  // review round 2 (63f2df/b813aa): the same decision at GATE time, so a refusal names its reason
  // and exits before anything is written.
  planCarry: (dir, fromSf, toSf, slug = null) => planFindingsCarry(dir, fromSf, toSf, slug),
  // plan 2891 T6: the paths applyExtras MAY write, declared BEFORE any write happens, so
  // runRepinFlow's rollback can journal them. See its `journalPaths` note — the marker-only
  // rollback plan 2844 installed could not restore an extra file that applyExtras had already
  // rewritten before throwing, nor delete one it had created.
  extraJournalPaths: (sf) => [findingsSidecarPath(sf)],
  applyExtras: (dir, sf, marker, newSha, newPatchId = null, slug = null) => {
    const sidecarRel = findingsSidecarPath(sf);
    // Same shared read policy as probeExtras above — this runs at APPLY time (inside
    // coordWrite's freshen-and-retry window), so a sidecar that raced from absent to
    // exists-but-unparseable (or to unreadable) between probeExtras' gate read and this write
    // must be caught here too, exactly as the record path's mutateIn re-asserts prepare's check.
    const read = readSidecarStrict(dir, sidecarRel);
    if (read.refuse) throw new Error(`record-review repin: ${read.refuse}`);
    if (read.absent) return []; // no sidecar → marker-only re-pin
    const rec = read.rec;
    // plan 2838 (review [6]): the re-pin rewrites a sidecar in place, so it needs the SAME
    // ownership assert as the record path — otherwise a repin that resolved a legacy sibling
    // entry rewrites THAT session's review identity.
    const conflict = sidecarOwnerConflict(rec, slug, sidecarRel);
    if (conflict) throw new Error(`record-review repin: ${conflict}`);
    if (sameCommitSha(rec.sha, marker.sha)) {
      // plan 2743: the re-pin UPGRADES a legacy sidecar too — same forward-only migration as
      // the marker, so this sidecar re-pins at most once and then rides its patch-id.
      // Normalized at WRITE time like every other patchId writer (upsertMarker,
      // buildFindingsRecord) — one invariant, enforced by all three, so a bad token can never
      // reach disk from any path (plan 2743 re-review [2]).
      // plan 2838: the same re-pin also stamps the OWNER onto a legacy record, which is how the
      // 1093 committed unowned sidecars migrate into sidecarOwnerConflict's reach.
      const pid = normalizeMarkerPatchId(newPatchId);
      const next = pid ? { ...rec, sha: newSha, patchId: pid } : { ...rec, sha: newSha };
      if (slug) next.slug = slug;
      writeFileSync(join(dir, sidecarRel), JSON.stringify(next, null, 2) + '\n');
      return [sidecarRel];
    }
    return [];
  },
};

// Advisory plan-existence probe for a `--plan <id>` disposition: does a plan file `<id>-*.md`
// exist under docs/superpowers/plans/ on local master OR the origin/master tracking ref? Lenient
// by design — the AUTHORITATIVE check is the done-worktree findingsGate, which fetches origin
// first; here a miss only WARNS (a just-filed plan may not have reached this checkout yet), so a
// real plan id is never falsely rejected at disposition time. The tree→id match is the shared
// planIdInTree helper (same matcher the land check uses, so they can't drift). Returns true/false.
function planExistsAdvisory(MAIN, id) {
  if (!String(id).trim()) return false;
  for (const ref of ['HEAD', 'origin/master']) {
    try {
      const out = git([
        '-C',
        MAIN,
        'ls-tree',
        '-r',
        '--name-only',
        ref,
        '--',
        'docs/superpowers/plans/',
      ]);
      if (planIdInTree(out, id)) return true;
    } catch {
      /* ref absent / not a plans repo → try the next */
    }
  }
  return false;
}

// plan 2162: resolve the review PROVENANCE detail from the CLI flags. Returns { detail } on
// success (detail is '' when no provenance was declared — a WARNED-but-allowed record, so
// no existing `record-review PASS` invocation breaks), or { code } on a hard refusal (unknown
// method / unreadable --review-stats). The stats file is the /sonnet-review return object (or
// its `stats` sub-object): finders ← stats.finders, verifiers ← stats.verifierAgents,
// refute-adjudicators ← stats.escalated. Explicit --finders/--verifiers/--adjudicated override
// the stats-derived counts. buildReviewProvenance drops any absent/negative count, so a
// substitute or self-read carries the bare method token (their ABSENCE of v=/adj= is itself
// the signal that no verification/adjudication ran).
// plan 2663: 'gpt-review' (the codex-CLI Luna/Sol lane) lives in the shared
// REVIEW_METHODS / REVIEW_FANOUT_METHODS vocabulary in done-worktree-lib.mjs like every
// other method — counts carry through buildReviewProvenance as for any fan-out.

// plan 3369 fix round 1 (bf342e): the narrowed-scope note used to be console output ONLY —
// printed once by whoever ran THIS command, then discarded, so a LATER reader of the recorded
// marker (a land gate, an audit, an operator reading the session file weeks later) could not
// tell a narrowed review from a full one. This is the SAME false-record class as a false PASS,
// which is why CLAUDE.md's plan-3369 carve-out explicitly sanctions ADDING the scope record
// here (never touching the verdict vocabulary or the `f=`/`v=`/`adj=` grammar those belong to).
//
// Pure — no fs, no marker write — so it is unit-testable directly. Returns BOTH the existing
// console sentence (`note`, byte-identical wording to before this fix) and a marker-SAFE
// suffix (`suffix`) for the caller to append to the provenance `detail` string. "Marker-safe"
// means it can never contain '@' or a newline: done-worktree-lib.mjs's marker grammar delimits
// the detail group as `[^\n@]*` up to the ` @ <sha>` that follows it (markerRegExp), and
// upsertMarker sanitizes both out defensively anyway — but composing clean text here means the
// sanitizer never has to touch it, and the marker's `Review: <verdict>[:<detail>] @ <sha>`
// shape, `parseReviewMarker`, and `buildReviewProvenance`'s own `<method> [f=N v=N adj=N]`
// token are completely unaware this suffix exists; it only ever adds TRAILING free text.
//
// Gated on `excludedFileCount > 0` (belt-and-suspenders alongside gpt-review.mjs's own
// b65c47/3e458e fix, which now only ever WRITES a `scope` field into stats.json when a file was
// actually dropped) — a scope object present with nothing excluded must never announce a
// narrowing that did not happen.
export function describeReviewScope(scope) {
  if (!scope || typeof scope !== 'object') return { note: '', suffix: '' };
  if (!(Number(scope.excludedFileCount) > 0)) return { note: '', suffix: '' };
  const bits = [];
  if (Array.isArray(scope.userPaths) && scope.userPaths.length)
    bits.push(`--paths ${scope.userPaths.join(',')}`);
  if (Array.isArray(scope.userExcludePaths) && scope.userExcludePaths.length)
    bits.push(`--exclude-paths ${scope.userExcludePaths.join(',')}`);
  if (Array.isArray(scope.autoExcludedGlobs) && scope.autoExcludedGlobs.length)
    bits.push(
      `auto-excluded over the finder context budget: ${scope.autoExcludedGlobs.join(', ')}`,
    );
  if (!bits.length) return { note: '', suffix: '' };
  const note =
    `record-review: review scope was narrowed (${bits.join('; ')}) — this diff did not ` +
    `cover the full changed-file set.`;
  const suffix = ` scope-narrowed[excluded=${scope.excludedFileCount}]`;
  return { note, suffix };
}

// plan 3369 fix round 2 (7d51a1): round 1 folded the scope suffix INTO the marker's `detail`
// group (the text between `<verdict>:` and ` @ <sha>`) — that put it BETWEEN the provenance
// counts and the `@`, which broke mine-sonnet-lane-executor-telemetry.mjs's stricter marker
// regex (its `f=\d+ v=\d+ adj=\d+` group must be followed immediately by `\s*@`, with no
// tolerance for trailing text before it). done-worktree-lib.mjs's own marker line is always the
// LAST line of upsertMarker's return value (its own contract: strip-then-append-at-end), so
// splicing the suffix onto that final line — AFTER the `@ <sha>`/`patch-id:…` upsertMarker
// already writes there — is safe regardless of the surrounding session-file prose. Both
// downstream parsers tolerate trailing text after the sha (done-worktree-lib.mjs's own
// markerRegExp has no end-of-line anchor, and upsertMarker's own patch-id token already proves
// the convention), so this never breaks a re-read of the marker.
export function appendMarkerScopeSuffix(markerFileText, suffix) {
  if (!suffix) return markerFileText;
  return markerFileText.endsWith('\n')
    ? markerFileText.slice(0, -1) + suffix + '\n'
    : markerFileText + suffix;
}

// plan 3527 phase 3: gpt-review writes the verbatim escape reason into stats.json; this turns it
// into a marker-safe, reversible one-line suffix. JSON quoting preserves the exact reason while
// escaping newlines and quotes, and the suffix is appended AFTER review-round:N so even literal
// text such as "review-round:99" inside the reason cannot become the counter's first token.
export function describeReviewPastCap(pastCap) {
  if (!pastCap || typeof pastCap !== 'object' || typeof pastCap.reason !== 'string') return '';
  if (!pastCap.reason.trim()) return '';
  return ` past-cap-reason=${JSON.stringify(pastCap.reason)}`;
}

export function appendMarkerPastCapSuffix(markerFileText, suffix) {
  if (!suffix) return markerFileText;
  return markerFileText.endsWith('\n')
    ? markerFileText.slice(0, -1) + suffix + '\n'
    : markerFileText + suffix;
}

// plan 3369 fix round 3 (990944): identicalReRecord's SAME-sha check compared only the parsed
// provenance `detail` — but the marker parser's detail group ends BEFORE ` @ <sha>` (see
// appendMarkerScopeSuffix's own header above), so it never saw the scope-narrowed[...] suffix
// this file splices onto the line AFTER the sha. A same-sha re-record that flips narrowed->full
// (or the reverse) therefore read as identical to identicalReRecord and short-circuited to the
// re-pin path, leaving the STALE scope annotation standing on the persisted marker forever — the
// marker kept announcing a narrowing (or a full-coverage claim) that no longer describes what was
// actually reviewed.
//
// mine-sonnet-lane-executor-telemetry.mjs and done-worktree-lib.mjs (the two real marker
// parsers) are both out of this fix round's file allowlist, and neither exposes the trailing
// free text after `@ <sha>` as a field anyway — so this reads it directly off the raw marker
// LINE instead of adding a new parser dependency. Pure — no fs — so it is unit-testable directly,
// same as describeReviewScope/appendMarkerScopeSuffix above. Returns:
//   - the exact `scope-narrowed[excluded=N]` token when this sha's marker line carries one,
//   - '' when this sha's marker line exists but carries no suffix (an un-narrowed review),
//   - null when NO marker line for this sha is found in `content` at all (this content does not
//     describe this identity — the caller must not treat that as "no scope").
function markerLineSuffix(content, sha, suffixPattern) {
  if (!content || !sha || !/^[0-9a-f]{7,64}$/i.test(sha)) return null;
  const fam = MARKER_FAMILIES.review;
  // `g` as well as `im`, and the LAST match wins — not the first. done-worktree-lib.mjs's
  // parseMarkerAny resolves a multi-marker entry by looping `matchAll` into `last`, so reading
  // the first here would let this report a scope belonging to a DIFFERENT marker line than the
  // one every other consumer resolves, and identicalReRecord would then compare a scope the
  // record does not actually carry (round-3 delta re-review, 103209/4b0e38). Same content, same
  // sha, same winning line.
  const rx = new RegExp(
    `^.*\\b${fam.label}:\\s*(?:${fam.verdicts.join('|')})(?::[^\\n@]*)?\\s*@\\s*${sha}\\b(.*)$`,
    'gim',
  );
  let m = null;
  for (const hit of content.matchAll(rx)) m = hit;
  if (!m) return null;
  const suffixMatch = m[1].match(suffixPattern);
  return suffixMatch ? suffixMatch[0] : '';
}

export function markerLineScopeSuffix(content, sha) {
  return markerLineSuffix(content, sha, /\bscope-narrowed\[excluded=\d+\]/);
}

// The candidate-scan wrapper identicalReRecord uses: walk the SAME origin-then-MAIN candidate
// list pickFreshestMarker already read (readSessionCandidates(MAIN, sf)), return the first
// candidate that actually carries a marker line for this sha (mirroring pickFreshestMarker's own
// "first candidate wins" contract), or null when none do. A null here means identicalReRecord
// could not determine the prior scope — it must fall through to a fresh record rather than risk
// a false "identical", the same false-positive-is-worse-than-a-commit asymmetry
// identicalReRecord's own header already states for every other field it compares.
export function recordedScopeSuffix(candidates, sha) {
  for (const c of candidates) {
    const found = markerLineScopeSuffix(c, sha);
    if (found !== null) return found;
  }
  return null;
}

export function markerLinePastCapSuffix(content, sha) {
  return markerLineSuffix(content, sha, /\bpast-cap-reason=("(?:\\.|[^"\\])*")/);
}

export function recordedPastCapSuffix(candidates, sha) {
  for (const c of candidates) {
    const found = markerLinePastCapSuffix(c, sha);
    if (found !== null) return found;
  }
  return null;
}

function resolveProvenance(argv, val, has, recordedSha) {
  let method = val('--review-method');
  const statsFile = val('--review-stats');
  const counts = {};
  // plan 3369 fix round 1 (bf342e): carried out of the `if (statsFile)` block below into the
  // final return, so a narrowed scope survives past this function into the marker
  // record-review.mjs actually writes — see describeReviewScope's header for the full
  // additive-only contract. plan 3369 fix round 2 (7d51a1): returned as its OWN field now,
  // never concatenated into `detail` — appendMarkerScopeSuffix (main()'s write site) applies
  // it AFTER `@ <sha>` instead, so `detail` stays exactly the provenance token.
  let scopeSuffix = '';
  let pastCapSuffix = '';
  if (statsFile) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(statsFile, 'utf8'));
    } catch (e) {
      console.error(
        `record-review: --review-stats ${statsFile} is not readable JSON: ${e.message}`,
      );
      return { code: 2 };
    }
    const identityDecision = reviewStatsIdentityDecision(
      parsed && typeof parsed === 'object' ? parsed.identity : null,
      recordedSha,
      statsFile,
    );
    if (identityDecision.warning) console.error(identityDecision.warning);
    if (identityDecision.error) {
      console.error(identityDecision.error);
      return { code: 2 };
    }
    const stats = parsed && typeof parsed === 'object' && parsed.stats ? parsed.stats : parsed;
    if (stats && typeof stats === 'object') {
      counts.finders = stats.finders;
      counts.verifiers = stats.verifierAgents;
      counts.adjudicated = stats.escalated;
    }
    // stats are the return shape of the sonnet-review fan-out; default the method to it unless
    // the caller declared otherwise (e.g. a /code-review run whose counts they hand-supplied).
    if (!method) method = 'sonnet-review';
    // plan 3369, task 3 / fix round 1 (bf342e): gpt-review.mjs's stats.json may carry a `scope`
    // field describing a narrowed review (--paths/--exclude-paths, or the automatic data-tree
    // exclusion applied when the raw diff exceeded the finder context budget) — surfaced both
    // as console output (unchanged wording) AND, since fix round 1, folded additively into the
    // recorded provenance `detail` below, so a LATER reader of the marker itself (not only
    // whoever watched this console) can tell a data tree was out of the reviewed set.
    const scope = parsed && typeof parsed === 'object' ? parsed.scope : null;
    const described = describeReviewScope(scope);
    if (described.note) console.log(described.note);
    scopeSuffix = described.suffix;
    pastCapSuffix = describeReviewPastCap(
      parsed && typeof parsed === 'object' ? parsed.pastCap : null,
    );
  }
  // Explicit numeric overrides win over the stats-derived counts (a flag present but with a
  // missing value stays undefined → ignored, not a crash).
  const countFlags = ['--finders', '--verifiers', '--adjudicated'].filter((f) => has(f));
  if (has('--finders')) counts.finders = val('--finders');
  if (has('--verifiers')) counts.verifiers = val('--verifiers');
  if (has('--adjudicated')) counts.adjudicated = val('--adjudicated');
  const gaveCounts = countFlags.length > 0 || Boolean(statsFile);

  if (method && !REVIEW_METHODS.includes(method)) {
    console.error(
      `record-review: --review-method must be one of ${REVIEW_METHODS.join(' | ')} (got "${method}").`,
    );
    return { code: 2 };
  }

  if (!method) {
    // plan 2162 review [2]: if counts were supplied without a method they'd be silently dropped
    // (buildReviewProvenance is never reached) — say so explicitly, not just the generic warning.
    const droppedNote = countFlags.length
      ? ` The ${countFlags.join('/')} count(s) you passed were DROPPED — counts require a --review-method.`
      : '';
    console.error(
      'record-review: no review provenance declared. Recording as provenance-UNDECLARED — the ' +
        'marker shows "provenance undeclared" at land. Declare HOW the review ran so a substitute ' +
        'pass is not indistinguishable from a full /sonnet-review fan-out (plan 2162): ' +
        '--review-method sonnet-review --review-stats <file>, or --review-method substitute for a ' +
        'hand-rolled pass, or --review-method self-read for a no-new-logic self-read.' +
        droppedNote,
    );
    return { detail: '' };
  }

  // plan 2162 review [1]: counts are only meaningful for a fan-out method; buildReviewProvenance
  // drops them for substitute/self-read, so warn rather than silently ignore a stale --review-stats.
  if (gaveCounts && !REVIEW_FANOUT_METHODS.includes(method)) {
    console.error(
      `record-review: --review-method ${method} takes no counts — the finder/verifier/adjudicator ` +
        `counts you passed are IGNORED (they are meaningful only for a fan-out: ${REVIEW_FANOUT_METHODS.join(' | ')}).`,
    );
  }

  // plan 3369 fix round 1 (bf342e), round 2 (7d51a1): scopeSuffix is '' whenever
  // describeReviewScope found nothing to report (no --review-stats, no `scope` field, or
  // excludedFileCount <= 0), so `detail` alone is byte-identical to before the fix on every
  // review that was not actually narrowed. `scopeSuffix` rides alongside it, no longer folded
  // in — the caller applies it AFTER `@ <sha>` via appendMarkerScopeSuffix.
  return {
    detail: buildReviewProvenance({ method, ...counts }),
    scopeSuffix,
    pastCapSuffix,
  };
}

function main() {
  const argv = process.argv.slice(2);
  // plan 1205: `disposition` subcommand — disposition one already-recorded finding.
  if ((argv[0] || '') === 'disposition') return dispositionMain(argv.slice(1));
  // plan 1528 A1: `repin` subcommand — mechanically re-pin a stale marker after a pure rebase.
  if ((argv[0] || '') === 'repin') return runRepinFlow(DESC, argv.slice(1));

  // plan 1769: deliberately NOT migrated to coord-git's shared parseFlags. This idiom's
  // semantics differ from the loop-parser family on purpose: unknown flags are tolerated
  // anywhere in argv (a strict parser would flip previously-accepted invocations of this
  // land-gating tool to hard errors), and dispositionMain's flagVal REFUSES a flag-shaped
  // value where parseFlags consumes it unconditionally. Surface frozen as-is.
  const verdict = (argv[0] || '').toUpperCase();
  const has = (name) => argv.includes(name);
  const val = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dry = has('--dry');
  const noPush = has('--no-push');
  const findingsFile = val('--findings');
  const carryFlag = has('--carry-dispositions');

  if (!VALID.has(verdict)) {
    console.error(
      `record-review: first arg must be ${MARKER_FAMILIES.review.verdicts.join(' | ')} (got "${argv[0] ?? ''}")`,
    );
    return 2;
  }

  const t = resolveRecordTarget(argv, 'record-review');
  if (t.code !== undefined) return t.code;
  const { slug, MAIN, cfg, sha } = t;
  // plan 2162/3507: provenance is validated before any lock, but after resolving the exact sha
  // being recorded so a sha-keyed stats identity cannot be adopted by another HEAD.
  const provenance = resolveProvenance(argv, val, has, sha);
  if (provenance.code !== undefined) return provenance.code;
  const provenanceDetail = provenance.detail;
  const provenanceScopeSuffix = provenance.scopeSuffix || '';
  const provenancePastCapSuffix = provenance.pastCapSuffix || '';
  // plan 3447: refresh the LOCAL origin/master ref before the default baseRef reads it —
  // resolveRecordTarget deliberately does NOT fetch (see its own comment), so without this the
  // record path's cached patch-id could be pinned to a stale base. The fetch rides INSIDE the
  // thunk (rangePatchIdOnceWithFetch), never eagerly above it, so the laziness the next comment
  // documents survives: a bad --findings file still refuses without paying for the network.
  const headPatchId = rangePatchIdOnceWithFetch('.', sha);
  // plan 2743: the rebase-stable half of the identity, stamped alongside the sha into BOTH the
  // marker and the findings sidecar, so a later pure rebase neither invalidates this review nor
  // costs a re-pin commit on master. LAZY (a memoized thunk): every refusal below — a bad
  // --findings file above all — still refuses without paying for `git diff | git patch-id` over
  // the whole branch. Memoized because coordWrite re-runs mutateIn on a freshen-and-retry.

  // plan 1205: findings ingest. NITS/BUGS-FOUND should carry the review's findings as JSON
  // (--findings <file>, an array of {file,line,summary,verdict?,kind?,disposition?} — or the
  // raw /sonnet-review return object {findings:[…]}). They are written to a sha-pinned sidecar
  // committed alongside the marker, so the land's findingsGate can require each to be
  // dispositioned. PASS takes none. A non-PASS verdict with no --findings still records the
  // marker but WARNS — the land will halt at FINDINGS_OPEN until findings are attached.
  // Parsed + validated UP FRONT (before any lock) so a malformed file refuses cheaply.
  let findings = null;
  if (verdict === 'PASS') {
    if (findingsFile)
      console.error(
        'record-review: PASS takes no findings (--findings ignored — PASS means none were found).',
      );
  } else if (findingsFile) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(findingsFile, 'utf8'));
    } catch (e) {
      console.error(`record-review: --findings ${findingsFile} is not readable JSON: ${e.message}`);
      return 2;
    }
    findings = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.findings)
        ? parsed.findings
        : null;
    if (!findings) {
      console.error(
        'record-review: --findings must be a JSON array of {file,line,summary,…} (or the /sonnet-review return object {findings:[…]}).',
      );
      return 2;
    }
  } else {
    console.error(
      `record-review: recorded ${verdict} with NO findings attached. The land will HALT at FINDINGS_OPEN until ` +
        `you attach them: record-review ${verdict} --findings <json> (use /sonnet-review's findings output). ` +
        `If the review was genuinely clean, record PASS instead.`,
    );
  }

  // ── plan 2891 T3: an IDENTICAL re-record is a re-pin, not a new round ──────────────────────
  //
  // The marker machinery re-recorded byte-identical reviews as fresh rounds. Plan 2499 stamped
  // 153 `record NITS` commits ~22s apart on the same `f=9 v=1`; plan 2409 stamped 8 extra; the
  // plan-2864 round-yield bench found the SAME 51 finding-keys disposed `fixed` FOUR times on
  // plan 2806 (partial repeats on 2789, 2746, 2755, 2633, 2426, 2233, 2854) and had to
  // hand-filter by patch-id to get a usable number. Every one of those commits advanced master
  // under every land prepping at the time, forcing their rebases, which emitted their own
  // re-pins — the same feedback loop plan 2743 measured at 326 commits in a day.
  //
  // Plan 2864 closed the TELEMETRY half by construction (a content-distinct round counter). This
  // closes the COMMIT-NOISE half: when the incoming record would reproduce, byte for byte, a
  // review that already covers this content, there is nothing to record — so say so and hand off
  // to the plan-1528 re-pin path, which either re-pins the sha or (for a marker already
  // rebase-stable) correctly does nothing at all.
  //
  // "Identical" is deliberately the STRICT conjunction, because the cost of a false positive is
  // a review that silently fails to land while the cost of a false negative is one extra commit:
  //   · the recorded marker still describes HEAD's content (same sha, or rebase-stable patch-id);
  //   · same verdict AND the same provenance detail — that is the reviewer-stats half, so a
  //     re-run with more finders, or a lane switch, is a genuine new record;
  //   · with --findings: the sidecar rebuilt from the incoming file AGAINST ITS OWN prior is
  //     byte-identical to that prior (so dispositions, keys and kinds all match), and the prior
  //     is itself current by the same dual identity.
  // Anything that does not match falls straight through to the normal record path.
  const identicalReRecord = () => {
    let resolved;
    try {
      // READ-ONLY resolution, so origin-first (plan 2891 T5): the marker being re-recorded was
      // itself landed on origin by the routed write path, which never touches MAIN's tree.
      // plan 4021: read at the owned entry that HOLDS the Review marker (an adoption leaves it in
      // an older entry); the repin hand-off below carries it forward if a write is needed.
      resolved = resolveMarkerSource(
        MAIN,
        slug,
        cfg.paths,
        MARKER_FAMILIES.review,
        'record-review',
        { refs: ORIGIN_FIRST_REFS, read: (p) => readSessionCandidates(MAIN, p, { strict: true }) },
      );
    } catch {
      return null; // resolution trouble → record normally; this optimisation never blocks a record
    }
    if (!resolved) return null;
    const sf = resolved.src.fallback ? resolved.src.path : resolved.sf;
    const candidates = resolved.src.contents;
    const marker = pickFreshestMarker(MARKER_FAMILIES.review, candidates, sha, headPatchId);
    if (!marker) return null;
    if (!markerIdentityMatch(marker.sha, marker.patchId, sha, headPatchId)) return null;
    // A LEGACY sha-only marker must still be re-recorded even when its sha pins HEAD (review
    // round 1, CONFIRMED): the re-record is what stamps the plan-2743 range patch-id onto it,
    // and the re-pin path this hands off to would NOT — its own markerPreCheck short-circuits on
    // the sha match before reaching the write. Skipping here would leave the marker with no
    // rebase-stable identity, so the NEXT rebase invalidates a review that should have survived
    // it. Forward-only and at most once per marker, exactly like plan 2743's own migration.
    if (!normalizeMarkerPatchId(marker.patchId)) return null;
    if (marker[MARKER_FAMILIES.review.resultField] !== verdict) return null;
    if (String(marker.detail || '') !== String(provenanceDetail || '')) return null;
    // plan 3369 fix round 3 (990944): scope is part of the identity too — a same-sha re-record
    // that flips narrowed->full (or the reverse) must NOT be treated as identical, or the
    // persisted marker keeps announcing a scope that no longer describes what was reviewed.
    // `detail` above never carries this (it lives AFTER `@ <sha>`, outside the detail group —
    // see markerLineScopeSuffix's header), so it needs its own comparison. Uncertain (null, no
    // candidate carries this sha's marker line at all — should not happen, `marker` itself came
    // from one of these same candidates) falls through to a fresh record rather than risk a false
    // "identical", same as every other field this function checks.
    const priorScopeSuffix = recordedScopeSuffix(candidates, marker.sha);
    if (priorScopeSuffix === null || priorScopeSuffix !== provenanceScopeSuffix.trim()) return null;
    const priorPastCapSuffix = recordedPastCapSuffix(candidates, marker.sha);
    if (priorPastCapSuffix === null || priorPastCapSuffix !== provenancePastCapSuffix.trim())
      return null;
    // No --findings: the record path writes only the marker, and the marker is already identical.
    if (!findings) return { sf, marker };
    const sidecarRel = findingsSidecarPath(sf);
    // review round 3: strict, like the marker read above — a copy that errors (other than being
    // absent) or will not parse ends the optimisation (record normally), never skipped past.
    let sidecarCandidates;
    try {
      sidecarCandidates = readSessionCandidates(MAIN, sidecarRel, { strict: true });
    } catch {
      return null;
    }
    for (const raw of sidecarCandidates) {
      const prior = parseFindingsRecord(raw);
      if (!prior) return null;
      // The prior must be current by the SAME dual identity as the marker — otherwise the land's
      // findingsGate would still halt on a stale sidecar, and skipping the record would strand a
      // fully-dispositioned branch (a legacy sidecar with no patchId beside a patch-id-current
      // marker is exactly that case, and re-recording is what heals it).
      if (!markerIdentityMatch(prior.sha, prior.patchId, sha, headPatchId)) continue;
      // Same forward-migration reasoning as the marker above: a legacy sidecar carrying no
      // patch-id must be re-recorded to acquire one, or the land's findingsGate halts on it
      // after the next rebase even though the marker itself survived.
      if (!normalizeMarkerPatchId(prior.patchId)) continue;
      // Rebuild at the PRIOR's own identity: what differs is then only the review CONTENT, never
      // the sha/patch-id/slug stamping this re-record would refresh anyway. Strip the builder's
      // legacy default round field exactly as the write path does; the marker is the sole counter.
      const rebuilt = buildFindingsRecord(verdict, prior.sha, findings, prior, {
        patchId: prior.patchId ?? null,
        slug: prior.slug ?? null,
      });
      delete rebuilt.rounds;
      const comparablePrior = { ...prior };
      delete comparablePrior.rounds;
      if (JSON.stringify(rebuilt) === JSON.stringify(comparablePrior)) return { sf, marker };
    }
    return null;
  };

  const same = identicalReRecord();
  if (same) {
    console.error(
      `record-review: re-record of the SAME review, not a new round — ${verdict} @ ` +
        `${String(same.marker.sha).slice(0, 9)} in ${same.sf} already covers HEAD ` +
        `${sha.slice(0, 9)}'s content with the same provenance` +
        (findings ? ' and the same findings + dispositions' : '') +
        `. Recording it again would spend a commit ON MASTER to say what is already recorded ` +
        `(the plan-2499 churn: 153 identical records, 22s apart). Handing off to the re-pin ` +
        `path instead — it re-pins the sha if that is needed, and does nothing if it is not.`,
    );
    // finding 7c775d (CONFIRMED correctness): this is the record path's THIRD already-recorded
    // exit — alongside runRecordFlow's report-hook noop and freshly-recorded branches (both of
    // which already call this) — and it runs BEFORE either of those, so without this call a
    // wiki-owned branch re-running record-review with no wiki marker yet got NO nudge here and
    // then hit the WIKI_CHECKPOINT land halt cold, exactly the case plan 3764 exists to close.
    // Deliberately NOT threaded into DESC/runRepinFlow (plan 3764 forbids extending the repin
    // flow itself) — printed here, on the way out, advisory only.
    //
    // findings db4f45/8701ee (CONFIRMED, same defect from two angles): guarded on `!dry` — plan
    // 3764 T1 item 6 requires --dry to stay silent on the nudge ("the nudge does not fire there,
    // which is correct"). The two runRecordFlow report-hook call sites get that for free because
    // runRecordFlow returns before its report hook under --dry; this third call site sits ABOVE
    // that protection, so it needs its own guard to match.
    if (!dry) printWikiDecisionNudge({ MAIN, slug, cfg, sha, headPatchId });
    return runRepinFlow(DESC, [
      '--slug',
      slug,
      ...(noPush ? ['--no-push'] : []),
      ...(dry ? ['--dry'] : []),
    ]);
  }

  // plan 2891 T2: every warning below lives in buildRecordIn, which coordWrite re-runs on each
  // freshen-and-retry attempt — without this dedupe a contended write would repeat the round-cap
  // / carry-refusal block once per attempt.
  const warnOnce = makeWarnOnce();
  const warnForRound = (rounds) => {
    if (rounds === AT_CAP_ROUND) {
      warnOnce(
        `record-review: round ${rounds} recorded for this plan — this is delta round ` +
          `${SANCTIONED_DELTA_ROUNDS} of ${SANCTIONED_DELTA_ROUNDS}, the last sanctioned one ` +
          `(docs/coord/review.md § Stopping rule). Past this, another ` +
          `re-review round needs a grounded defect or a ground-truth exit (run it / simplify / park).`,
      );
    } else if (rounds > AT_CAP_ROUND) {
      warnOnce(
        `record-review: round ${rounds} recorded for this plan — BEYOND the ` +
          `${SANCTIONED_DELTA_ROUNDS}-delta-round cap ` +
          `(docs/coord/review.md § Stopping rule).`,
      );
    }
  };
  // plan 3415 finding 3: reads the prior round through sessionReviewRound (the SAME sidecar-aware
  // reader warnIfReviewRoundCapReached uses), not the marker-only recordedReviewRound — otherwise
  // the advisory warning and the record path's own next-round math can disagree about what round
  // a legacy (pre-migration, sidecar-carried) entry is actually at. `sidecarRaw` is the sidecar
  // file's raw content read from the SAME tree as `sessionContent` (a write-path read, so no
  // origin-first resolution here — see the ORIGIN_FIRST_REFS header note on record-marker-cli.mjs
  // for why write paths resolve against the tree they are about to write).
  const roundForRecord = (sessionContent, sidecarRaw = null) => {
    const priorMarker = parseReviewMarkerAny(sessionContent);
    if (!priorMarker) return 1;
    const priorRounds = sessionReviewRound(sessionContent, sidecarRaw) ?? 1;
    if (sameCommitSha(priorMarker.sha, sha)) return priorRounds;
    const decision = carryFlag
      ? { repin: true }
      : patchIdenticalDecision(priorMarker.sha, sha, headPatchId());
    return decision.rework ? priorRounds + 1 : priorRounds;
  };
  // Raw sidecar read at `dir` for the round count. Review round 3 (33ce2a): only a genuinely absent
  // sidecar degrades to marker-only; one that exists but cannot be read THROWS the shared refusal,
  // because counting the round without it could undercount a legacy round-4 record as round 1.
  // validateIn runs the same check pre-lock so the refusal normally exits 3 before any write.
  const readSidecarRawAt = (dir, sidecarRel) => {
    if (!sidecarRel) return null;
    const read = readSidecarRawStrict(dir, sidecarRel);
    if (read.refuse) throw new Error(`record-review: ${read.refuse}`);
    return read.absent ? null : read.raw;
  };

  // ── plan 2891 T2: prepare() is a PURE VALIDATION pass; the payload is built in mutateIn ──
  //
  // The findings payload used to be built ONCE in prepare(dir). coordWrite FRESHENS the coord
  // checkout and re-runs only `mutate` on a non-fast-forward retry, so every input that build
  // read — the prior sidecar and plan-1775's carry decision — came from the PRE-freshen tree. A
  // sidecar updated by anyone inside the
  // retry window was then overwritten by the stale prepared record (the same-owner half of the
  // stale overwrite; plan 2838 closed only the cross-owner half), and the round counter was
  // computed against a prior that was no longer the prior.
  //
  // So: prepare only RESOLVES and VALIDATES (which is what its refusal codes are for, and those
  // are unchanged), and every read of the prior record — hence every derived field — happens in
  // mutateIn against the tree that is actually about to be written.
  const validateIn = (dir) => {
    const resolved = resolveMarkerSource(
      dir,
      slug,
      cfg.paths,
      MARKER_FAMILIES.review,
      'record-review',
    );
    if (!resolved) return { code: noSessionEntry('record-review', slug, cfg.paths) };
    // review round 2 (2321da/30cbc6): a halted source means an owned entry could not be read or
    // attributed — recording onto it anyway is the clobber the ownership rules exist to stop.
    if (resolved.src.halted) {
      console.error(markerSourceHaltMessage('record-review', resolved.src.halted));
      return { code: 3 };
    }
    const sf = resolved.sf;
    // plan 4021 (review fb94f6): an adoption left the prior Review marker (and its round counter
    // and sidecar) in an OLDER owned entry. mutateIn carries them forward into `sf` before reading
    // the prior, so the round is counted on from it rather than restarting at 1. Pre-lock refusal
    // for a sidecar half that cannot be carried; mutateIn re-asserts it on the freshened tree.
    const carryFrom = resolved.src.fallback ? resolved.src.path : null;
    let carrySidecar = false;
    if (carryFrom) {
      const plan = planFindingsCarry(dir, carryFrom, sf, slug);
      if (plan.refuse) {
        console.error(`record-review: ${plan.refuse}`);
        return { code: 3 };
      }
      carrySidecar = plan.present;
    }
    // plan 3415 finding 5b (57a5c3/b434a0): `roundSidecarRel` is resolved UNCONDITIONALLY —
    // separate from `sidecarRel` below, which stays gated on `findings` because it also drives
    // whether this record WRITES the sidecar (buildRecordIn, relPaths, dryLine, report all read
    // `sidecarRel` truthiness to decide that; making it always-truthy would wrongly commit an
    // untouched sidecar on a PASS or a findings-less NITS/BUGS-FOUND record). Round-reading a
    // sidecar that already exists never risks clobbering it, so it needs none of the write-path's
    // ownership-conflict gate — the best-effort `readSidecarRawAt` below degrades to null on
    // absent/unreadable either way, and `sessionReviewRound` itself only trusts a sidecar whose
    // OWN recorded sha matches the marker's. Without this, a record carrying no --findings (PASS
    // always, or NITS/BUGS-FOUND recorded without one — both explicitly supported flows above)
    // never saw a LEGACY sidecar's `rounds` counter and undercounted a round-4 sidecar's next
    // record as round 2 instead of round 5.
    const roundSidecarRel = findingsSidecarPath(sf);
    const roundRead = readSidecarRawStrict(dir, roundSidecarRel); // review round 3 (33ce2a)
    if (roundRead.refuse) {
      console.error(`record-review: ${roundRead.refuse}`);
      return { code: 3 };
    }
    if (!findings) return { sf, roundSidecarRel, sidecarRel: null, carryFrom, carrySidecar };
    const sidecarRel = roundSidecarRel;
    // plan 2838 (review [9]) + plan 2891 T1, via the ONE shared read policy: a sidecar that
    // exists but will not parse — or exists and will not READ — is not the same as no sidecar.
    // Conflating them silently replaced a record that may still hold recoverable dispositions.
    const read = readSidecarStrict(dir, sidecarRel);
    if (read.refuse) {
      console.error(`record-review: ${read.refuse}`);
      return { code: 3 };
    }
    // plan 2838: the sidecar write is a whole-file replace, so a prior record owned by another
    // plan must stop the flow BEFORE any merge. Re-asserted in mutateIn against the freshened
    // tree — this copy is what keeps the refusal cheap and pre-lock.
    const conflict = read.absent ? null : sidecarOwnerConflict(read.rec, slug, sidecarRel);
    if (conflict) {
      console.error(`record-review: ${conflict}`);
      return { code: 3 };
    }
    return { sf, roundSidecarRel, sidecarRel, carryFrom, carrySidecar };
  };

  // plan 4021 (review fb94f6): write the carry-forward into `dir` under its OWN journal, returning
  // { journal, written } so the caller rolls it back if anything after it throws. No-op (null) when
  // this record carries nothing forward.
  const carryIn = (dir, p) => {
    if (!p.carryFrom) return null;
    // review round 2 (47c8b1/877e1b/755889/7ef812): re-derive the carry from the tree THIS attempt
    // writes. A freshen-and-retry may have changed an entry's owner (the picker halts), or a
    // sibling may already have carried the marker (no fallback any more → nothing to carry).
    const fresh = resolveMarkerSource(
      dir,
      slug,
      cfg.paths,
      MARKER_FAMILIES.review,
      'record-review',
    );
    if (!fresh || fresh.src.halted || fresh.sf !== p.sf) {
      throw new Error(
        fresh?.src.halted
          ? markerSourceHaltMessage('record-review', fresh.src.halted)
          : `record-review: the newest owned session entry is no longer ${p.sf} in ${dir} — nothing written; re-run.`,
      );
    }
    const carryFrom = fresh.src.fallback ? fresh.src.path : null;
    if (!carryFrom) return null;
    const journal = openWriteJournal(dir, [p.sf, findingsSidecarPath(p.sf)]);
    try {
      const before = journal.bytesAt(0);
      if (before == null) {
        throw new Error(
          `record-review: cannot read ${p.sf} in ${dir} to carry the Review marker forward.`,
        );
      }
      writeFileSync(
        join(dir, p.sf),
        carryMarkerForward(
          MARKER_FAMILIES.review,
          'record-review',
          slug,
          p.sf,
          carryFrom,
          before.toString('utf8'),
          fresh.src.contents[0],
        ),
      );
      const written = [p.sf, ...carryFindingsSidecar(dir, carryFrom, p.sf, slug)];
      return { journal, written };
    } catch (e) {
      journal.rollback();
      throw e;
    }
  };

  // Build the findings record against the CURRENT content of `dir`. Every refusal THROWS: this
  // runs at write time (inside coordWrite's retry window), where the contract is the same one
  // mutateIn has always had — a refusal must escape, never degrade to a silent write. Callers
  // that need a pre-lock refusal use validateIn above, which returns a code instead.
  const buildRecordIn = (dir, sidecarRel) => {
    const read = readSidecarStrict(dir, sidecarRel);
    if (read.refuse) throw new Error(`record-review: ${read.refuse}`);
    // plan 1205 review [0]: a re-record with the same --findings (re-export, accidental
    // re-invoke) must NOT wipe disposition work already applied at THIS sha.
    // buildFindingsRecord merges the prior sidecar: an incoming finding that OMITS
    // `disposition` carries the prior one forward; an explicit disposition (incl. an explicit
    // null to reopen) wins. A prior at a DIFFERENT sha merges only when the plan-1775 carry
    // gate below proves/asserts the same review round; otherwise it is ignored.
    const prior = read.absent ? null : read.rec;
    {
      // The plan-2838 ownership assert, re-run against the FRESHENED tree (review [0],
      // re-review [2]/[7]/[8]/[11]/[12]) — a sidecar can change owner inside the retry window.
      const conflict = sidecarOwnerConflict(prior, slug, sidecarRel);
      if (conflict) throw new Error(`record-review: ${conflict}`);
    }
    {
      // plan 1775: what would a cross-sha carry actually change? Build both candidate merges;
      // explicit input dispositions win in BOTH, so the entries that differ are EXACTLY the
      // prior disposition work a plain re-record would drop. A payload that already carries its
      // own dispositions (the feed-the-current-sidecar route) yields an empty diff — no gate,
      // no warning (review 1775 [1]). No prior / same sha short-circuits to ONE build (the two
      // merges are provably identical there — review 1775 round-2).
      // plan 2743: `patchId` rides into the record so the sidecar survives a pure rebase the same
      // way the marker does — without it, findingsGate halts a fully-dispositioned NITS branch.
      // plan 2838: `slug` rides into the record so the sidecar names its owner from now on.
      const crossSha = Boolean(prior?.sha) && !sameCommitSha(prior.sha, sha);
      // The findings sidecar owns dispositions only. The round counter lives exclusively in the
      // Review marker, because PASS writes no sidecar; this decision remains here only for the
      // cross-sha disposition-carry gate below.
      const crossShaDecision = crossSha
        ? carryFlag
          ? { repin: true }
          : patchIdenticalDecision(prior.sha, sha, headPatchId())
        : null;
      const pidOpts = { patchId: headPatchId(), slug };
      const withoutCarry = autoDispositionAdvisoryFindings(
        buildFindingsRecord(verdict, sha, findings, prior, pidOpts),
      );
      const withCarry = crossSha
        ? autoDispositionAdvisoryFindings(
            buildFindingsRecord(verdict, sha, findings, prior, {
              ...pidOpts,
              carryAcrossSha: true,
            }),
          )
        : withoutCarry;
      // buildFindingsRecord still defaults its legacy advisory field to 1 for other callers.
      // Remove it here so record-review persists exactly one counter: the Review marker token.
      delete withoutCarry.rounds;
      delete withCarry.rounds;
      const atRisk = withCarry.findings.filter(
        (f, i) => f.disposition && !withoutCarry.findings[i].disposition,
      );
      let carried = false;
      if (atRisk.length) {
        // The carry must be proven SAME-REVIEW-ROUND: automatically when the branch's
        // content-diff vs origin/master is unchanged between the recorded tip and HEAD (a pure
        // re-sha), or explicitly via --carry-dispositions (the operator asserting it after a
        // content-CHANGING recovery, e.g. a LAND_BLOCKED_HOLDING conflict-resolution merge).
        // Anything else refuses and WARNS — the plan-1291/1712 failure was a SILENT drop.
        const d = crossShaDecision;
        carried = Boolean(d.repin);
        if (carried) {
          warnOnce(
            `record-review: carrying ${atRisk.length} disposition(s) forward from the prior record @ ` +
              `${String(prior.sha).slice(0, 9)} across the sha bump to ${sha.slice(0, 9)} ` +
              `(${carryFlag ? '--carry-dispositions' : 'patch-id-identical re-sha'}; matched by finding key).`,
          );
        } else {
          warnOnce(
            `record-review: WARNING — the prior findings record @ ${String(prior.sha).slice(0, 9)} carries ` +
              `${atRisk.length} disposition(s), but HEAD is ${sha.slice(0, 9)} and the carry gate refused (${d.why}). ` +
              `They will NOT carry — the re-recorded findings start open and the land halts at FINDINGS_OPEN. ` +
              `If this re-record is the SAME review round (e.g. after a conflict-resolution merge), re-run with ` +
              `--carry-dispositions, or feed the CURRENT sidecar file as --findings (explicit dispositions always win).`,
          );
        }
      }
      return carried ? withCarry : withoutCarry;
    }
  };

  return runRecordFlow(
    { tool: 'record-review', MAIN, dry, noPush },
    {
      prepare: validateIn,
      mutateIn: (dir, p) => {
        // plan 2891 T2: the payload is built HERE, against the tree this attempt is about to
        // write — so the prior-sidecar read, the plan-1775 carry decision and the plan-2864
        // disposition carry sees the FRESHENED state on a coordWrite retry, and the ownership
        // re-assert (plan 2838 review [0], re-review [2]/[7]/[8]/[11]/[12]) rides along inside
        // buildRecordIn. Deliberately BEFORE the marker write, not between the two writes: the
        // --no-push path commits by pathspec with no rollback, so a refusal landing after the
        // marker had already been rewritten would leave MAIN's tree half-modified.
        const abs = join(dir, p.sf);
        // plan 4021 (review fb94f6): carry the older entry's Review marker + sidecar forward
        // FIRST, so the prior-marker round read and the prior-sidecar merge below see them in `sf`.
        const carry = carryIn(dir, p);
        try {
          p.rounds = roundForRecord(
            readFileSync(abs, 'utf8'),
            readSidecarRawAt(dir, p.roundSidecarRel),
          );
          warnForRound(p.rounds);
          p.findingsRecord = p.sidecarRel ? buildRecordIn(dir, p.sidecarRel) : null;
          // plan 2891 review round 1 (CONFIRMED), generalized in round 3: the marker and the
          // sidecar are TWO writes, and the second can still fail for a reason no validation
          // predicts (ENOSPC, EIO, a dangling symlink whose target dir is gone). On the routed
          // path coordWrite's freshen resets the checkout, but --no-push writes MAIN's own tree
          // with no commit and no rollback behind it — so a failed sidecar write left the marker
          // advanced over a sidecar that was old, truncated or absent. Same SHARED journal the
          // re-pin uses (openWriteJournal), rather than a second copy of it.
          const journal = openWriteJournal(dir, [p.sf, ...(p.sidecarRel ? [p.sidecarRel] : [])]);
          // The session entry itself must have been snapshotted — validateIn just resolved it from
          // this very tree, so an unreadable one here is a genuine I/O failure, not a case to
          // paper over by re-reading (which is what let two reads disagree in the first place).
          if (journal.bytesAt(0) == null) {
            throw new Error(
              `record-review: cannot read ${p.sf} in ${dir} — the session entry must be readable to record a marker.`,
            );
          }
          try {
            writeFileSync(
              abs,
              // plan 3369 fix round 2 (7d51a1): the scope suffix is spliced onto the marker's
              // OWN final line — AFTER `@ <sha>`/`patch-id:…` — never folded into
              // provenanceDetail (which upsertMarker places BEFORE the `@`). See
              // appendMarkerScopeSuffix's header for why this ordering matters.
              appendMarkerPastCapSuffix(
                appendMarkerRoundSuffix(
                  appendMarkerScopeSuffix(
                    upsertReviewMarker(
                      journal.bytesAt(0).toString('utf8'),
                      verdict,
                      sha,
                      provenanceDetail,
                      headPatchId(),
                    ),
                    provenanceScopeSuffix,
                  ),
                  p.rounds,
                ),
                provenancePastCapSuffix,
              ),
            );
            // The findings record is deterministic for this (verdict, sha, findings) against
            // whatever prior is on disk NOW — and since plan 2891 T2 that read happens on THIS
            // attempt, so a coordWrite retry re-merges against the freshened prior rather than
            // re-writing the one prepare saw before the freshen.
            if (p.findingsRecord && p.sidecarRel) {
              writeFileSync(
                join(dir, p.sidecarRel),
                JSON.stringify(p.findingsRecord, null, 2) + '\n',
              );
            }
          } catch (e) {
            journal.rollback();
            throw e;
          }
        } catch (e) {
          carry?.journal.rollback();
          throw e;
        }
        // A carry wrote a sidecar the declared list may not name; hand coordWrite the exact set.
        return carry
          ? [...new Set([...carry.written, p.sf, ...(p.sidecarRel ? [p.sidecarRel] : [])])]
          : undefined;
      },
      relPaths: (p) =>
        p.sidecarRel || p.carrySidecar ? [p.sf, findingsSidecarPath(p.sf)] : [p.sf],
      commitMessage: () =>
        `chore(review): record ${verdict} @ ${sha.slice(0, 9)} for ${slug}` +
        (provenanceDetail ? ` (${provenanceDetail})` : ''),
      // plan 2891 T2: --dry never runs mutateIn, so the preview builds the record itself — from
      // MAIN, the same checkout its own prepare() validated against. The preview must keep
      // reporting the real finding COUNT (a `[dry]` line that dropped it would hide exactly what
      // the operator ran --dry to see).
      dryLine: (p) => {
        // plan 4021: preview the round as the carried-forward write would count it.
        const sfText = readFileSync(join(MAIN, p.sf), 'utf8');
        const rounds = p.carryFrom
          ? roundForRecord(
              carryMarkerForward(
                MARKER_FAMILIES.review,
                'record-review',
                slug,
                p.sf,
                p.carryFrom,
                sfText,
                readFileSync(join(MAIN, p.carryFrom), 'utf8'),
              ),
              readSidecarRawAt(MAIN, findingsSidecarPath(p.carryFrom)),
            )
          : roundForRecord(sfText, readSidecarRawAt(MAIN, p.roundSidecarRel));
        warnForRound(rounds);
        return (
          `[dry] record-review: would write "Review: ${verdict}${provenanceDetail ? `:${provenanceDetail}` : ''} @ ${sha}` +
          `${headPatchId() ? ` patch-id:${headPatchId()}` : ''}${provenanceScopeSuffix} review-round:${rounds}${provenancePastCapSuffix}" into ${p.sf}` +
          (p.sidecarRel
            ? ` + ${buildRecordIn(MAIN, p.sidecarRel).findings.length} findings into ${p.sidecarRel}`
            : '')
        );
      },
      report: (res, p) => {
        const provNote = provenanceDetail
          ? ` [provenance: ${provenanceDetail}]`
          : ` [${REVIEW_PROVENANCE_UNDECLARED}]`;
        if (res.noop) {
          console.log(
            `record-review: ${verdict} @ ${sha.slice(0, 9)} already recorded in ${p.sf} (no change)${provNote}`,
          );
          printFindingSummary(p.findingsRecord);
          printWikiDecisionNudge({ MAIN, slug, cfg, sha, headPatchId });
          return 0;
        }
        console.log(
          `record-review: recorded ${verdict} @ ${sha.slice(0, 9)} in ${p.sf}` +
            (p.carryFrom ? ` (prior Review marker carried forward from ${p.carryFrom})` : '') +
            (p.sidecarRel
              ? ` (+ ${p.findingsRecord.findings.length} findings → ${p.sidecarRel})`
              : '') +
            `${noPush ? ' (push skipped)' : ' + pushed'}${provNote}`,
        );
        printFindingSummary(p.findingsRecord);
        printWikiDecisionNudge({ MAIN, slug, cfg, sha, headPatchId });
        return 0;
      },
    },
  );
}

// plan 1205: disposition one finding in the sidecar — file a plan for it, mark it fixed in-diff,
// or consciously wave it (reason required), or reopen one (clear its disposition). Usage:
//   record-review disposition <key> (--plan <id> | --fixed | --wontfix "<reason>" | --reopen) [--slug <slug>]
// Parse the `disposition` argv into a list of {key, norm} items — `norm: null` means reopen.
// TWO input forms (plan 2595), both collapsing to ONE coord write:
//   - N keys sharing ONE disposition: `disposition k1 k2 k3 --fixed`. Bare keys go BEFORE the
//     first flag (after one, a bare token cannot be told from that flag's value, so the parser
//     refuses rather than guessing — see parseDispositionArgv). A key that must sit later takes
//     the explicit `--key <k>`, which is repeatable and accepted anywhere.
//   - `--batch <file>`: a JSON array of {key, kind, value?} for a HETEROGENEOUS set, which is what
//     a real review round is (some fixed, one wontfix, one deferred to a plan).
// Returns { code } on a usage refusal, else { items, batch }.
// `disposition`'s COMPLETE flag surface. Scoped to this subcommand only — the record verb's own
// flags (--findings / --review-stats / --review-method / --carry-dispositions) are NOT accepted
// here, so pasting a record-verb invocation refuses instead of silently doing nothing.
const DISPOSITION_VALUE_FLAGS = new Set([
  '--key',
  '--plan',
  '--wontfix',
  '--batch',
  '--slug',
  '--observed',
]);
// plan 2942 review round 3: what each value flag needs, phrased for the operator. The parser's
// missing-value invariant reads this, so refusing EARLY (a parser invariant covering every value
// flag by construction) costs none of the specific, actionable guidance the per-flag downstream
// guards used to carry — the reason a generic "needs a value" would have been a regression.
const DISPOSITION_VALUE_HINTS = {
  '--key': 'a finding key, e.g. --key F1',
  '--plan': 'a plan id, e.g. --plan 1300',
  '--wontfix': 'a reason, e.g. --wontfix "cosmetic, low value"',
  '--batch': 'a file path, e.g. --batch .scratch/dispositions.json',
  '--slug': 'a worktree slug, e.g. --slug 1234-Coord-thing',
  '--observed': 'an observed-evidence pointer, e.g. --observed "wave-B b2 record-1095"',
};
const DISPOSITION_BOOL_FLAGS = new Set(['--fixed', '--reopen', '--dry', '--no-push']);
// The four that SAY WHAT HAPPENED to a finding — mutually exclusive, and the set --batch refuses
// alongside itself. Named once so the two guards can never disagree about what the four are.
const DISPOSITION_KIND_FLAGS = ['--fixed', '--plan', '--wontfix', '--reopen'];

// A flag's value must never itself be a flag: `--wontfix --no-push` is a MISSING reason, not a
// reason of "--no-push". Both the key-collecting parse and the value readers below route through
// this ONE predicate — maintained in two places, they would drift the day the rule changes.
const isFlagValue = (v) => Boolean(v) && !v.startsWith('--');

// Resolve argv into { keys } or a usage refusal.
//
// THE PARSE IS CLOSED, NOT BEST-EFFORT. Two rounds of review found the same failure class here
// from opposite directions, and both were silent:
//   - collecting only a CONTIGUOUS LEADING run of positionals silently DROPPED `F2` in
//     `disposition F1 --dry F2 --fixed`, leaving a finding open that the report called resolved;
//   - then treating any non-flag token as a key silently SWEPT one in: `disposition F1
//     --typo'd-flag F2 --fixed` dispositioned F2 as well, because the "unknown flag values fail
//     loudly at the no-such-key check" argument collapses precisely when the stray value IS a
//     real open key from the same round — which is the common case, since the operator is pasting
//     keys from one findings list. Silently RESOLVING an unnamed finding is worse than dropping
//     one: a dropped key still shows as open, a swept key does not.
// Neither is fixable by guessing better. So this parser refuses everything it cannot read
// unambiguously: an unknown flag, or a bare key that trails a flag (use `--key` for those). The
// only shapes that parse are the ones whose meaning is beyond doubt.
function parseDispositionArgv(argv) {
  const keys = [];
  const seenValueFlags = new Set();
  let seenFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      // A bare key BEFORE any flag is unambiguous. After a flag it is not (it could be that
      // flag's value), so require the explicit form rather than guessing either way.
      if (seenFlag)
        return {
          code: usageErr(
            `bare key "${a}" appears after a flag, where it cannot be told from that flag's value. ` +
              `Put every key before the flags, or pass it as \`--key ${a}\`.`,
          ),
        };
      keys.push(a);
      continue;
    }
    seenFlag = true;
    if (DISPOSITION_BOOL_FLAGS.has(a)) continue;
    if (!DISPOSITION_VALUE_FLAGS.has(a))
      return {
        code: usageErr(
          `unrecognized flag "${a}". disposition takes: ` +
            `${[...DISPOSITION_VALUE_FLAGS, ...DISPOSITION_BOOL_FLAGS].sort().join(' ')}.`,
        ),
      };
    // plan 2942 review [fdb698]: a value flag given TWICE used to resolve silently to the FIRST
    // occurrence (`val` is `argv.indexOf(name)`), so `--observed wave-A --observed wave-B` stored
    // wave-A without a word — the same silent-misdisposition class every other guard in this
    // parser exists to close. `--key` is deliberately exempt: it is the documented repeatable
    // flag, and repeated KEYS already have their own duplicate guard in dispositionMain.
    if (a !== '--key') {
      if (seenValueFlags.has(a))
        return {
          code: usageErr(
            `${a} was given more than once; it takes a single value. Re-run with just the one you meant.`,
          ),
        };
      seenValueFlags.add(a);
    }
    const v = argv[i + 1];
    // plan 2942 review round 3: a PARSER INVARIANT, not a per-flag special case. Every flag in
    // DISPOSITION_VALUE_FLAGS takes a value by definition, so one arriving without a readable one
    // is malformed argv — and "skip it and hope a downstream guard notices" was only ever true for
    // some of them: `--key` had no guard at all (`disposition K1 --key --fixed` silently closed
    // ONE finding while the operator believed two were), and `--slug` fell back to auto-resolution
    // as though the flag had never been typed. Refusing here covers every current and future value
    // flag by construction, which is what round 2's `--key`-shaped patch could not do.
    if (!isFlagValue(v)) return { code: usageErr(`${a} needs ${DISPOSITION_VALUE_HINTS[a]}.`) };
    if (a === '--key') keys.push(v);
    i++; // consume the value so it is never mistaken for a key
  }
  return { keys };
}

function parseDispositionItems(argv, { has, flagVal }) {
  const parsedArgv = parseDispositionArgv(argv);
  if (parsedArgv.code !== undefined) return { code: parsedArgv.code };
  const { keys } = parsedArgv;
  // plan 2942 review [6990f3]: `--batch` with a missing/flag-shaped value used to fall THROUGH to
  // the shared-disposition form — `disposition F1 F2 --batch --fixed` quietly applied `--fixed` to
  // both positionals instead of refusing. Round 3 moved that refusal UP into the parser's
  // missing-value invariant (which covers every value flag), so by the time we get here a present
  // `--batch` always has a readable value; no second guard is needed and a dead one would only
  // invite the next reader to wonder which of the two is authoritative.
  const batchFile = flagVal('--batch');
  if (batchFile) {
    for (const f of DISPOSITION_KIND_FLAGS)
      if (has(f))
        return {
          code: usageErr(`--batch carries each finding's own disposition; drop ${f}.`),
        };
    // plan 2942: same reasoning — the observed-evidence pointer is a PER-ENTRY field on the batch
    // form (each entry's own "observed"), so a shared --observed flag would silently apply to
    // nothing rather than to a chosen entry.
    if (has('--observed'))
      return {
        code: usageErr(
          '--batch entries carry their own "observed" field; drop --observed (add it per-entry in the file).',
        ),
      };
    // Same reasoning as the flag check above, and the same failure mode as dropping a positional:
    // a key passed ALONGSIDE --batch is not in the batch file, so silently ignoring it leaves that
    // finding open while the operator believes the round is closed. Refuse instead.
    if (keys.length)
      return {
        code: usageErr(
          `--batch takes every key from the file; remove the extra key(s) ${keys.map((k) => `"${k}"`).join(', ')} (add them to ${batchFile} instead).`,
        ),
      };
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(batchFile, 'utf8'));
    } catch (e) {
      return { code: usageErr(`--batch ${batchFile} is not readable JSON: ${e.message}`) };
    }
    if (!Array.isArray(parsed) || parsed.length === 0)
      return { code: usageErr(`--batch ${batchFile} must be a non-empty JSON array.`) };
    const items = [];
    for (const [i, raw] of parsed.entries()) {
      const at = `--batch entry ${i}`;
      if (!raw || typeof raw !== 'object') return { code: usageErr(`${at} is not an object.`) };
      const key = String(raw.key || '').trim();
      if (!key) return { code: usageErr(`${at} has no "key".`) };
      const kind = String(raw.kind || '').trim();
      // plan 2942: an entry MAY carry its own observed-evidence pointer, but only for kind
      // "plan" — the same restriction the CLI flag form enforces below. Present-but-blank is a
      // refusal too (an operator who typed the field meant to supply a pointer).
      // plan 2942 review round 2 [null-observed]: ONLY an absent key is "omitted". An explicit
      // `"observed": null` is a value the operator wrote, and treating it as omitted is the same
      // guess-instead-of-refuse the type check below exists to kill — it silently downgrades a
      // deferral the author meant to mark observed.
      const hasObserved = raw.observed !== undefined;
      if (hasObserved && kind !== 'plan')
        return {
          code: usageErr(
            `${at} (key ${key}): "observed" applies only to kind "plan" (an observed-evidence pointer for a plan deferral) — drop it or set kind to "plan".`,
          ),
        };
      if (kind === 'reopen') {
        items.push({ key, norm: null });
        continue;
      }
      let observed;
      if (hasObserved) {
        // plan 2942 review [ac2624]/[338436]: VALIDATE the type, never coerce it. `String(false)`
        // is the truthy pointer `"false"` and `String({source:'live'})` is `"[object Object]"` —
        // both non-empty, so both SUPPRESS the evidence-floor warning and record a latent deferral
        // as if it carried observed evidence. That inverts the guard this whole plan exists to be.
        if (typeof raw.observed !== 'string')
          return {
            code: usageErr(
              `${at} (key ${key}): "observed" must be a string evidence pointer (got ${typeof raw.observed}).`,
            ),
          };
        observed = raw.observed.trim();
        if (!observed)
          return {
            code: usageErr(
              `${at} (key ${key}): "observed" is present but blank — supply an evidence pointer or omit the field.`,
            ),
          };
      }
      const norm = normalizeDisposition(dispositionForKind(kind, raw.value, observed));
      if (!norm)
        return {
          code: usageErr(
            `${at} (key ${key}): kind must be fixed | plan | wontfix | reopen, and plan/wontfix need a "value" (plan id / reason).`,
          ),
        };
      items.push({ key, norm });
    }
    return { items };
  }

  // Shared-disposition form — keys collected above, position-independently.
  if (keys.length === 0)
    return {
      code: usageErr(
        'usage: record-review disposition <key…> (--plan <id> | --fixed | --wontfix "<reason>" | --reopen) [--slug <slug>]\n' +
          '   or: record-review disposition --batch <file.json>   # [{key, kind, value?}, …], one coord write',
      ),
    };

  // EXACTLY ONE disposition per invocation. The chain below is first-match-wins, so two flags
  // used to resolve silently to whichever the chain tested first: `disposition F1 --plan 2600
  // --fixed` recorded "deferred to plan 2600" and dropped --fixed without a word. That is the
  // same silent-misdisposition class the argv parse was closed against, and --batch has refused
  // this exact combination since plan 2595 — the plain form simply never got the guard.
  const chosen = DISPOSITION_KIND_FLAGS.filter((f) => has(f));
  if (chosen.length > 1)
    return {
      code: usageErr(
        `${chosen.join(' and ')} were both given; a finding gets ONE disposition. Re-run with just the one you meant.`,
      ),
    };

  // plan 2942: --observed records the OBSERVED evidence for a --plan deferral — it is meaningless
  // (and refused) alongside --fixed/--wontfix/--reopen or with no disposition flag at all. Checked
  // BEFORE the --reopen shortcut below so `--observed --reopen` refuses rather than silently
  // dropping the pointer.
  if (has('--observed') && !has('--plan'))
    return {
      code: usageErr(
        '--observed records the OBSERVED evidence for a --plan deferral and applies only to --plan.',
      ),
    };

  // --reopen clears a finding's disposition (the supported way to undo a fixed/plan/wontfix — plan
  // 1205 review [0]; re-recording --findings PRESERVES dispositions, so it can't reopen).
  if (has('--reopen')) return { items: keys.map((key) => ({ key, norm: null })) };

  let disposition = null;
  if (has('--plan')) {
    // A value missing/empty/flag-shaped ("--observed --fixed" must not silently swallow --fixed,
    // which is exactly what NOT reading it via flagVal — the same predicate every other value
    // flag here uses — would risk).
    // plan 2942 review round 3: `.trim()` before the emptiness test, so a WHITESPACE-ONLY pointer
    // refuses here instead of surviving flagVal (non-empty, not flag-shaped), getting trimmed away
    // by normalizeDisposition, and silently degrading to an unobserved deferral. The --batch path
    // already refused a blank; the two forms now agree.
    const observed = has('--observed') ? flagVal('--observed')?.trim() : undefined;
    if (has('--observed') && !observed)
      return {
        code: usageErr(
          '--observed needs an observed-evidence pointer, e.g. --observed "wave-B b2 record-1095".',
        ),
      };
    disposition = dispositionForKind('plan', flagVal('--plan'), observed);
  } else if (has('--fixed')) disposition = dispositionForKind('fixed');
  else if (has('--wontfix')) disposition = dispositionForKind('wontfix', flagVal('--wontfix'));
  if (!disposition)
    return {
      code: usageErr('choose one of --plan <id> | --fixed | --wontfix "<reason>" | --reopen.'),
    };
  const norm = normalizeDisposition(disposition);
  if (!norm)
    return {
      code: usageErr(
        disposition.type === 'plan'
          ? '--plan needs a plan id, e.g. --plan 1300.'
          : disposition.type === 'wontfix'
            ? '--wontfix needs a reason, e.g. --wontfix "cosmetic, low value".'
            : 'invalid disposition.',
      ),
    };
  return { items: keys.map((key) => ({ key, norm })) };
}

function usageErr(msg) {
  console.error(`record-review disposition: ${msg}`);
  return 2;
}

// One finding's disposition rendered for the log/commit subject. `short` drops the parenthetical
// detail (a wontfix reason can be a paragraph) — a multi-finding subject names N of these, and a
// commit subject is one line. Rendered by a FLAG rather than regex-stripping the long form
// afterwards, so the two forms cannot disagree about what the parenthetical was.
function describeDisposition(norm, { short = false } = {}) {
  if (!norm) return short ? 'reopened' : 'reopened (open)';
  if (norm.type === 'plan')
    // plan 2942: renders the greppable bracket form when an observed-evidence pointer rode along —
    // this is what puts it in the log line, the --dry preview, and the commit subject.
    // plan 2942 review [4d70b6]: the SHORT form carries it too. Dropping it there meant an N-arity
    // round (the shape plan 2595 made the default) reported and committed a bare `plan <id>` for
    // every finding, so the one surface an audit reads back — the commit subject — lost exactly
    // the evidence this plan exists to record. Length is not the reason to drop it: the subject is
    // already clamped by clampSubject, and the authoritative per-key detail is in the sidecar the
    // same write commits.
    return norm.observed
      ? `plan ${norm.planId} [observed: ${norm.observed}]`
      : `plan ${norm.planId}`;
  if (norm.type === 'wontfix') return short ? 'wontfix' : `wontfix (${norm.reason})`;
  return 'fixed';
}

// kind → the disposition shape normalizeDisposition expects. ONE mapping, shared by the --batch
// entry parser and the flag form, so a future 5th kind cannot be added to one and missed in the
// other (the two used to be separate ternaries over different sources). `observed` (plan 2942) is
// used only by the `plan` branch — an optional observed-evidence pointer.
function dispositionForKind(kind, value, observed) {
  if (kind === 'plan') return { type: 'plan', planId: value, ...(observed ? { observed } : {}) };
  if (kind === 'wontfix') return { type: 'wontfix', reason: value };
  return { type: kind };
}

// plan 4078 T3: the highest `review-round:N` any of `contents` carries (the SAME
// `recordedReviewRound` reader the round-cap ledger's own advisory warning uses above — never a
// second, independent marker parse) — or null when none carry a round token at all. `contents` is
// `resolved.src.contents` from `pickMarkerSourceEntry`: exactly the text this disposition write is
// judged against, so "the marker's review-round value" always means the one this call sees.
function markerRoundFromContents(contents) {
  if (!Array.isArray(contents)) return null;
  let highest = null;
  for (const c of contents) {
    const r = recordedReviewRound(c);
    if (r !== null) highest = highest === null ? r : Math.max(highest, r);
  }
  return highest;
}

// plan 4078 T3 (operator-pinned 2026-09-20 — warn, never deny): from review round 2 on, a
// `--fixed` disposition on a finding tagged `preExisting: true` or `blocksLand: false` is the
// split-rule violation `docs/coord/review.md` § Disposition policy Step 0 now calls
// out explicitly. One line per key — never refuses the write, and never dedupes via `warnOnce`:
// this shape is rare enough (round >= 2 AND optional) that naming every key stays readable.
function warnOptionalFixedAtLaterRound(keys, markerRound) {
  for (const key of keys) {
    console.error(
      `record-review disposition: WARNING — ${key} is tagged preExisting/optional and is being ` +
        `marked --fixed at review round ${markerRound} (>= 2). docs/coord/review.md § ` +
        `Disposition policy Step 0: from round 2 on, an optional finding defaults to --plan / a ` +
        `debt-list line / --wontfix, not --fixed (plan 4078 T3; the split rule, ` +
        `docs/coord/review.md § The calibration ladder). Recording anyway (warn-only).`,
    );
  }
}

function dispositionMain(argv) {
  const has = (name) => argv.includes(name);
  const val = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // A flag's value, but never another flag — the SAME predicate the key-collecting parse uses.
  const flagVal = (name) => {
    const v = val(name);
    return isFlagValue(v) ? v : undefined;
  };

  const parsed = parseDispositionItems(argv, { has, flagVal });
  if (parsed.code !== undefined) return parsed.code;
  const { items } = parsed;

  // A key named twice in ONE invocation is a mistake, not a last-wins request: the two entries
  // would silently disagree about the same finding. Refuse before touching anything.
  const dupes = items.map((it) => it.key).filter((k, i, a) => a.indexOf(k) !== i);
  if (dupes.length)
    return usageErr(`key(s) repeated in one invocation: ${[...new Set(dupes)].join(', ')}.`);

  // plan 2942: the evidence-floor WARN's dedupe. The warn itself is emitted from applyIn — the one
  // place that knows the EFFECTIVE disposition (a pointer carried forward from the sidecar must
  // not warn), and applyIn runs inside runRecordFlow's coordWrite mutate/retry closure, so a
  // contended write re-runs it once per freshen attempt. warnOnce is what makes that safe: keyed on
  // the message, it prints at most once per invocation — the exact plan-2891 T2 mechanism, used
  // here for the reason it was built. Warn-only: exit code and disposition are unaffected.
  const warnOnce = makeWarnOnce();
  const warnUnobserved = (keys) => {
    if (!keys.length) return;
    // plan 2942 review [87257f]: NAME a bounded sample, count the rest. A --batch round is any
    // non-empty JSON array, so interpolating every key put an unbounded line on stderr — which
    // buries the actionable sentence it is wrapped in rather than surfacing it.
    const WARN_KEY_SAMPLE = 5;
    const shown = keys.slice(0, WARN_KEY_SAMPLE).join(', ');
    const namedKeys =
      keys.length > WARN_KEY_SAMPLE
        ? `${shown} (+${keys.length - WARN_KEY_SAMPLE} more, ${keys.length} total)`
        : shown;
    warnOnce(
      `record-review disposition: WARNING — ${namedKeys} deferred to a plan with no OBSERVED evidence pointer. ` +
        `The evidence floor (docs/coord/plan-lanes.md § The evidence floor) mints a plan only for wrongness that was OBSERVED ` +
        `(wave output, live site, measured corpus run, operator report); latent finding → line, not plan — a domain edge case → a ` +
        `line in the project's domain debt ledger, everything else → a docs/handoff/infra-debt.md line. Recording anyway (warn-only). ` +
        `Supply the pointer with --observed "<wave/live/measured/operator ref>".`,
    );
  };

  const dry = has('--dry');
  const noPush = has('--no-push');

  const t = resolveRecordTarget(argv, 'record-review disposition');
  if (t.code !== undefined) return t.code;
  const { slug, MAIN, cfg } = t;

  // ONE renderer for the log line, the --dry preview and the commit subject, so a preview can
  // never describe something different from what is committed. The key is ALWAYS named.
  // Computed ONCE, from the REQUESTED dispositions, and never reassigned.
  //
  // plan 2942 review round 3 — why this is deliberately NOT rendered from the effective
  // (carry-forward-resolved) dispositions, which round 2 briefly tried: `commitMessage(p)` is
  // evaluated ONCE by record-marker-cli BEFORE coordWrite's retry loop, while `mutate` (→ applyIn)
  // re-runs on every freshen-and-retry. A description derived inside applyIn therefore describes
  // whichever attempt happened to run last, and the already-materialized subject describes the
  // FIRST — so under a contended write the log line and the commit subject can disagree, which is
  // strictly worse than both under-describing. The requested disposition is the one thing that is
  // stable across retries. The cost is small and bounded: when a stored pointer is carried forward
  // (see applyIn below), the subject says `plan <id>` rather than `plan <id> [observed: …]`. The
  // sidecar this same write commits is the authoritative record and does carry it.
  const dispDesc =
    items.length === 1
      ? `${items[0].key} → ${describeDisposition(items[0].norm)}`
      : `${items.length} findings (${items.map((it) => `${it.key}→${describeDisposition(it.norm, { short: true })}`).join(', ')})`;

  // Apply EVERY disposition against ONE checkout dir. Returns { code } on refusal or
  // { sidecarRel, updated } on success. Shared by the routed and --no-push/--dry paths.
  //
  // ALL-OR-NOTHING (plan 2595): every key is validated against the sidecar BEFORE the first
  // mutation, so a typo in the 7th key of a batch cannot leave the first six applied. The
  // helpers are pure (dispositionFinding clones), so the fold below only becomes the written
  // record once every key has been proven present.
  const applyIn = (dir) => {
    const resolved = resolveMarkerSource(
      dir,
      slug,
      cfg.paths,
      MARKER_FAMILIES.review,
      'record-review disposition',
    );
    if (!resolved) return { code: noSessionEntry('record-review disposition', slug, cfg.paths) };
    // review round 2 (58cc37/9d41e4): never disposition findings for an entry whose ownership or
    // contents could not be established. applyIn re-runs on every mutate retry, so this re-checks.
    if (resolved.src.halted) {
      const why = markerSourceHaltMessage('record-review disposition', resolved.src.halted);
      console.error(why);
      return { code: 3, why };
    }
    const sf = resolved.sf;
    // plan 4021 (review fb94f6): after an adoption the findings live beside the OLDER owned entry
    // that holds the Review marker. Dispositions are read from there and written (with the marker
    // line) into the newest entry's own sidecar — writes never move off the newest entry.
    const carryFrom = resolved.src.fallback ? resolved.src.path : null;
    let readRel = findingsSidecarPath(sf);
    if (carryFrom) {
      const plan = planFindingsCarry(dir, carryFrom, sf, slug);
      if (plan.refuse) {
        console.error(`record-review disposition: ${plan.refuse}`);
        return { code: 3, why: plan.refuse };
      }
      readRel = plan.fromRel;
    }
    const sidecarRel = readRel;
    // plan 2891 T1 — the FIFTH errno-blind read, found while applying the rule to the four the
    // plan names. This one is the quietest of the set: a sidecar that exists but cannot be read
    // (EACCES/EISDIR/EIO) reported "no findings recorded for <slug> — record them first", which
    // invites the operator to RE-RECORD over findings that are still there and still
    // dispositioned. It is the same errno-blindness on the same file in the same CLI, so it
    // takes the same shared policy (fix-now, per the repo's disposition rule) rather than an
    // infra-debt line. An unparseable record likewise now REFUSES here instead of masquerading
    // as "none recorded".
    const read = readSidecarStrict(dir, sidecarRel);
    if (read.refuse) {
      console.error(`record-review disposition: ${read.refuse}`);
      return { code: 3, why: `${sidecarRel} exists but could not be read or parsed` };
    }
    if (read.absent) {
      console.error(
        `record-review disposition: no findings recorded for "${slug}" (expected ${sidecarRel}). Record them first: record-review <NITS|BUGS-FOUND> --findings <json>.`,
      );
      return { code: 1, why: `no findings sidecar for "${slug}"` };
    }
    const record = read.rec;
    // plan 2838: the same ownership assert as the record path — dispositioning a stranger's
    // findings is a quieter corruption than clobbering them, but it is the same wrong file.
    const conflict = sidecarOwnerConflict(record, slug, sidecarRel);
    if (conflict) {
      console.error(`record-review disposition: ${conflict}`);
      return { code: 3, why: `sidecar ${sidecarRel} is owned by "${record.slug}"` };
    }
    const recordedKeys = new Set((record.findings || []).map((f) => f.key));
    const missing = items.map((it) => it.key).filter((k) => !recordedKeys.has(k));
    if (missing.length) {
      const missingList = missing.map((k) => `"${k}"`).join(', ');
      console.error(
        `record-review disposition: no finding with key ${missingList}. ` +
          `Recorded keys: ${[...recordedKeys].join(', ') || '(none)'}. Nothing was applied.`,
      );
      return { code: 1, why: `key(s) ${missingList} are not in the sidecar` };
    }
    // The plan-existence probe is advisory and memoized per id — a batch deferring several
    // findings to the same plan must not re-spawn `git ls-tree` per finding (the same reason
    // openCount memoizes below, plan 1205 review [1]).
    const planWarned = new Set();
    for (const { norm } of items) {
      if (norm?.type !== 'plan' || planWarned.has(norm.planId)) continue;
      planWarned.add(norm.planId);
      if (!planExistsAdvisory(dir, norm.planId))
        console.error(
          `record-review disposition: WARNING — plan ${norm.planId} not found under docs/superpowers/plans/ on local/origin master. ` +
            `Recording anyway; the land's findingsGate re-validates against a fresh origin/master and HALTS if it is genuinely missing.`,
        );
    }
    // Fold through the SHARED dispositionFinding primitive, once per item. An inline
    // reimplementation was measurably cheaper (one pass instead of N clones over a <30-element
    // array) and not worth it: dispositionFinding is the one place that knows what applying a
    // disposition means, and a private copy silently keeps the old behavior the day that helper
    // is hardened. Cheap divergence beats cheap cycles here.
    // plan 2942 review [674d53]: re-applying the SAME plan deferral without --observed used to
    // silently ERASE an evidence pointer already on record — dispositionFinding replaces a
    // finding's disposition wholesale, so a routine `disposition <key> --plan <id>` re-run
    // downgraded an observed deferral to a latent-looking one and the next audit read it as
    // unobserved. An OMITTED pointer carries the prior forward; this is the same
    // omitted-carries-forward / explicit-wins convention buildFindingsRecord already applies to
    // the disposition field itself. Scoped deliberately narrow: only when the plan id is
    // UNCHANGED. Re-pointing a finding at a DIFFERENT plan is a new deferral whose old evidence
    // may no longer apply, so it takes a fresh --observed (and warns without one).
    //
    // Built ONLY when some item could actually use it (review round 2, efficiency): a round with
    // no pointer-less plan deferral — the common `--fixed` sweep — no longer normalizes and maps
    // the whole findings record for nothing.
    const carryKeys = new Set(
      items.filter((it) => it.norm?.type === 'plan' && !it.norm.observed).map((it) => it.key),
    );
    // Only the keys that can actually use it (review round 3): a `--fixed` sweep builds nothing,
    // and a one-key round no longer normalizes every finding in the record. `.filter(Boolean)`
    // because parseFindingsRecord guarantees only that `findings` IS an array — a corrupt or
    // hand-edited sidecar can hold a null entry, and dereferencing it here would crash the CLI.
    const priorDisposition = new Map(
      (record.findings || [])
        .filter((f) => f && carryKeys.has(f.key))
        .map((f) => [f.key, normalizeDisposition(f.disposition)]),
    );
    let updated = record;
    const unobservedPlanKeys = [];
    // plan 4078 T3: the marker's `review-round:N` AS OF this same entry (`resolved.src.contents`
    // is exactly the content pickMarkerSourceEntry chose for the marker this disposition writes
    // against) — read once, outside the loop, the same way the round-cap ledger's own reader
    // (recordedReviewRound, above) does. null (no round token at all) is treated as "unknown",
    // never assumed to be round 1.
    const markerRound = markerRoundFromContents(resolved.src.contents);
    const optionalFixedKeys = [];
    for (const { key, norm } of items) {
      let effective = norm;
      if (norm?.type === 'plan' && !norm.observed) {
        const prior = priorDisposition.get(key);
        if (prior?.type === 'plan' && prior.planId === norm.planId && prior.observed)
          effective = { ...norm, observed: prior.observed };
      }
      if (effective?.type === 'plan' && !effective.observed) unobservedPlanKeys.push(key);
      // plan 4078 T3 (operator-pinned 2026-09-20, warn never deny): from round 2 on, a `--fixed`
      // disposition on a finding tagged preExisting or non-must-fix is the split-rule violation
      // docs/coord/review.md § Disposition policy Step 0 now calls out — checked
      // against the ORIGINAL (pre-disposition) finding, never `updated`, whose tags this write
      // does not change.
      if (effective?.type === 'fixed' && markerRound !== null && markerRound >= 2) {
        const finding = (record.findings || []).find((f) => f && f.key === key);
        // `isMustFixFinding` (imported above) is the ONE existing predicate for this axis — never
        // re-rolled as a bare `preExisting`/`blocksLand` tag check, which would also miss a
        // PLAUSIBLE/REFUTED-verdict finding whose tags happen to still read the must-fix default.
        if (finding && !isMustFixFinding(finding)) {
          optionalFixedKeys.push(key);
        }
      }
      updated = dispositionFinding(updated, key, effective).record;
    }
    warnUnobserved(unobservedPlanKeys);
    warnOptionalFixedAtLaterRound(optionalFixedKeys, markerRound);
    const srcText = carryFrom ? resolved.src.contents[0] : null;
    return { sf, sidecarRel: findingsSidecarPath(sf), carryFrom, srcText, updated };
  };

  // "Still open" = findings the LAND gate would still block on. Use the SAME findingBlocksLand
  // predicate findingsGate uses (so a "0 still open" report can't contradict a later
  // FINDINGS_OPEN halt on a MATCHED pair of versions — plan 1205 review [2]/[3]). This is
  // structural, not asserted: findingBlocksLand is one function exported from
  // done-worktree-lib.mjs and both this count and the gate call it, rather than each hand-rolling
  // an "does this finding block" predicate that can drift the way plan 3545 let classifyFinding
  // alone drift (plan 3623 item 5 — the gate's real predicate had become
  // `malformed(f) || (isMustFixFinding(f) && classifyFinding(f) !== 'ok')`, two branches beyond
  // what a bare classifyFinding filter here could ever agree with).
  //
  // What this does NOT cover: version skew. This worktree's done-worktree-lib.mjs may know
  // disposition vocabulary (e.g. deferred-by-tag) that the land gate running from the MAIN
  // checkout on master does not yet have, because that gate reads whatever code is checked out
  // there — not this branch's. "0 still open" here can still be followed by a real FINDINGS_OPEN
  // halt naming findings this predicate silently already excused. That happened for real on
  // 2026-09-01 during plan 3545's own close-out (0 reported vs. 11 named at land time); see
  // docs/coord/review.md § Disposition policy for the bootstrap-hazard fix.
  //
  // plan existence uses the advisory probe, memoized per id so a sidecar with several findings
  // sharing one --plan id doesn't re-spawn `git ls-tree` per finding (review [1]).
  const openCount = (dir, updated) => {
    const planCache = new Map();
    const planExistsCached = (id) => {
      if (!planCache.has(id)) planCache.set(id, planExistsAdvisory(dir, id));
      return planCache.get(id);
    };
    return updated.findings.filter((f) => findingBlocksLand(f, planExistsCached)).length;
  };

  return runRecordFlow(
    { tool: 'record-review', MAIN, dry, noPush },
    {
      prepare: (dir) => applyIn(dir),
      // Re-applies against the FRESHENED sidecar each retry (idempotent: dispositionFinding
      // sets the same disposition); `open` is recomputed from what is actually written.
      mutateIn: (dir, p) => {
        const a = applyIn(dir);
        if (a.code !== undefined)
          // Report the ACTUAL cause. A coordWrite retry re-applies against the FRESHENED sidecar,
          // so a key that resolved at prepare() can legitimately stop matching mid-retry (a sibling
          // re-recorded --findings at a new tip, shifting the derived keys). Calling that "sidecar
          // vanished" sends the caller into a re-run loop on a permanently stale key.
          throw new Error(
            `record-review disposition: ${a.why || 'sidecar vanished'} mid-retry — re-check the recorded keys and re-run.`,
          );
        if (!a.carryFrom) {
          writeFileSync(join(dir, a.sidecarRel), JSON.stringify(a.updated, null, 2) + '\n');
          p.open = openCount(dir, a.updated);
          return undefined;
        }
        // plan 4021 (review fb94f6): carry the Review marker line into the newest entry and write
        // the dispositioned record into ITS sidecar — two writes, one journal.
        const journal = openWriteJournal(dir, [a.sf, a.sidecarRel]);
        try {
          const before = journal.bytesAt(0);
          if (before == null) {
            throw new Error(
              `record-review disposition: cannot read ${a.sf} in ${dir} to carry the Review marker forward.`,
            );
          }
          writeFileSync(
            join(dir, a.sf),
            carryMarkerForward(
              MARKER_FAMILIES.review,
              'record-review disposition',
              slug,
              a.sf,
              a.carryFrom,
              before.toString('utf8'),
              a.srcText,
            ),
          );
          writeFileSync(join(dir, a.sidecarRel), JSON.stringify(a.updated, null, 2) + '\n');
        } catch (e) {
          journal.rollback();
          throw e;
        }
        p.open = openCount(dir, a.updated);
        return [a.sf, a.sidecarRel];
      },
      relPaths: (p) => (p.carryFrom ? [p.sf, p.sidecarRel] : [p.sidecarRel]),
      // The subject keeps the literal word "disposition" for EVERY arity: the coord-write cost
      // measurement (plan 2429/2595) classifies this write class off the commit subject, so an
      // N-arity subject that renamed itself would look like the class vanishing rather than
      // shrinking — the exact metric this plan is judged on.
      // dispDesc ALREADY names the key(s) — re-prepending items[0].key produced
      // "disposition F1 → F1 → fixed". One renderer, used verbatim everywhere.
      //
      // Only the DESCRIPTION is clamped, never the prefix or the trailing slug (same shape as
      // done-worktree's own subject build): the cost classifier keys on the literal word
      // "disposition" and the slug identifies the land, so both must survive. An N-arity list of
      // 9 keys ran ~200 chars — the authoritative per-key detail lives in the sidecar this same
      // write commits, so a clamped subject loses nothing that isn't recorded.
      commitMessage: () => `chore(review): disposition ${clampSubject(dispDesc)} for ${slug}`,
      // The key is NEVER dropped from a preview: --dry exists so an operator can confirm WHICH
      // finding is about to be resolved before a pushed coord write, and the single-key form
      // printed it before plan 2595.
      dryLine: (p) =>
        `[dry] record-review disposition: would set ${dispDesc} in ${p.sidecarRel}` +
        (p.carryFrom
          ? ` (carrying the Review marker + findings forward from ${p.carryFrom})`
          : '') +
        (items.length === 1 ? '' : ` (${items.length} findings, ONE coord write)`),
      report: (res, p) => {
        const what = items.length === 1 ? dispDesc : `${dispDesc} — ONE coord write`;
        if (res.noop) {
          console.log(
            `record-review disposition: ${what} already recorded in ${p.sidecarRel} (no change)`,
          );
          return 0;
        }
        console.log(
          `record-review disposition: ${what} in ${p.sidecarRel}` +
            ` (${p.open} finding${p.open === 1 ? '' : 's'} still open)${noPush ? ' (push skipped)' : ' + pushed'}`,
        );
        return 0;
      },
    },
  );
}

// Commit the review marker for `slug` into the session file `sf` under MAIN — the
// review-family instance of the shared commit engine (record-marker-cli.makeCommitMarker:
// lock-retry add/commit via gitWithLockRetry, plan 980; porcelain no-op short-circuit
// that sees a brand-new UNTRACKED findings sidecar, plan 1205 [1]; half-land tolerance
// gated on commitSubjectAtHead; push via pushMasterWithRebase unless noPush). Since plan
// 1286 this is ONLY the --no-push (local, offline/test) engine — the default
// record/disposition paths route through withCoordCheckout + coordWrite. Signature:
// (MAIN, sf, { slug, verdict, sha, noPush?, extraPaths? (the findings sidecar, plan
// 1205), commitMsg? (the disposition/repin subject override), seams… }).
export const commitReviewMarker = makeCommitMarker('review');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main());
  } catch (e) {
    console.error('record-review:', e.message);
    process.exit(1);
  }
}
